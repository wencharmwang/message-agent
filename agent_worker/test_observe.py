"""The message organiser is manual; automatic reply keeps its own scan loop.

These checks pin the boundary that matters to the product: an idle worker with no enabled
automatic rule does not touch WeChat, while an explicit organiser refresh may read the
visible list but never opens a chat.

Run: <messaging-runtime>/runtime/python/python.exe -m unittest agent_worker.test_observe -v
"""
import os
import tempfile
import unittest

from agent_worker.service import RuntimeToolError, Worker, is_system_entry


class StubHarness:
    def close(self):
        pass


class StubMcp:
    def __init__(self):
        self.scans = 0
        self.opens = 0

    def call(self, name, arguments):
        raise AssertionError('unexpected tool ' + name)

    def scan(self, provider):
        self.scans += 1
        return {'wechat:alice': {'fingerprint': 'fp-A', 'name': '小璐璐'},
                'wechat:bob': {'fingerprint': 'fp-B', 'name': '供应商群'}}

    def observe(self, rule, limit=30):
        self.opens += 1
        return [{'direction': 'incoming', 'content': '你好', 'sender': None, 'type': 'text'}]


def make_worker(tmp):
    config = {'database': os.path.join(tmp, 'reply.db'), 'poll_interval_seconds': 5,
              'settle_seconds': 0, 'response_timeout_seconds': 30, 'job_ttl_seconds': 300,
              'min_reply_interval_seconds': 10, 'max_reply_chars': 500, 'control_port': 8767,
              'harness_port': 3080, 'harness_root': tmp, 'harness_home': tmp,
              'node_executable': os.path.join(tmp, 'node.exe'), 'agent_workspace': tmp,
              'model': 'test', 'runtime_settings_file': os.path.join(tmp, 's.json'),
              'worker_token_file': os.path.join(tmp, 'w.token'), 'control_token_file': os.path.join(tmp, 'c.token')}
    mcp = StubMcp()
    return Worker(config, mcp=mcp, harness=StubHarness()), mcp


class ObserveTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.worker, self.mcp = make_worker(self.tmp)

    def test_idle_worker_does_not_scan_without_an_automatic_rule(self):
        self.assertEqual(self.worker.store.rules(), [])
        self.worker.tick()
        snapshot = self.worker.observation_snapshot()
        self.assertEqual(snapshot['level'], 'manual')
        self.assertEqual(snapshot['providers'], {})
        self.assertEqual(self.mcp.scans, 0)

    def test_user_refresh_discovers_visible_conversations(self):
        self.worker.discover(force=True)
        snapshot = self.worker.observation_snapshot()
        self.assertEqual(sorted(snapshot['providers']['wechat-main']), ['wechat:alice', 'wechat:bob'])
        self.assertEqual(snapshot['providers']['wechat-main']['wechat:alice']['name'], '小璐璐')
        self.assertTrue(snapshot['scanned_at'] > 0)

    def test_discovery_never_opens_a_chat(self):
        self.worker.discover(force=True)
        self.assertEqual(self.mcp.opens, 0)

    def test_old_observation_setting_cannot_restart_continuous_scanning(self):
        self.worker.store.set_setting('observe_enabled', True)
        self.worker.tick()
        self.assertEqual(self.mcp.scans, 0)
        self.assertEqual(self.worker.observation_snapshot()['level'], 'manual')
        self.assertEqual(self.worker.observation.get('providers'), {})

    def test_a_provider_with_a_rule_is_still_read_once_per_tick(self):
        self.worker.store.add('wechat-main', 'wechat:alice', '小璐璐', 'direct', '回复日常聊天')
        rule_id = self.worker.store.rules()[0]['id']
        self.worker.store.enable(rule_id, True)
        self.worker.tick()
        # Automatic reply owns exactly one provider scan per tick.
        self.assertEqual(self.mcp.scans, 1)


class SystemEntryTest(unittest.TestCase):
    def test_system_folders_are_ignored(self):
        for name in ('公众号', '服务号', '微信支付', '订阅号', '文件传输助手',
                     '服务通知', '腾讯新闻', '微信团队', '企业微信', '视频号', '群发助手'):
            self.assertTrue(is_system_entry(name), name)
        # OCR spacing errors still match, but a real contact remark never does.
        self.assertTrue(is_system_entry('公众 号'))
        self.assertFalse(is_system_entry('张伟'))
        self.assertFalse(is_system_entry('公众号运营'))
        self.assertFalse(is_system_entry(''))


class BlankWindowMcp:
    """A window the driver cannot read until it is restored.

    A blank capture has no conversation-list divider, so the driver reports
    layout_unverified — not provider_unavailable. The restore used to be gated on the
    latter only, which made the stall permanent.
    """

    def __init__(self, recoverable=True):
        self.scans = 0
        self.restores = 0
        self.broken = True
        self.recoverable = recoverable

    def call(self, name, arguments):
        if name != 'restore_window':
            raise AssertionError('unexpected tool ' + name)
        self.restores += 1
        if self.recoverable:
            self.broken = False
        return {'restored': self.recoverable}

    def scan(self, provider):
        self.scans += 1
        if self.broken:
            raise RuntimeToolError('layout_unverified', 'Runtime: layout_unverified',
                                   'The conversation-list boundary could not be identified.')
        return {'wechat:alice': {'fingerprint': 'fp', 'preview_hash': 'p', 'name': '小璐璐'}}

    def observe(self, rule, limit=30):
        raise AssertionError('discovery must not open a chat')


def worker_with(mcp):
    import os
    import tempfile
    tmp = tempfile.mkdtemp()
    config = {'database': os.path.join(tmp, 'reply.db'), 'poll_interval_seconds': 5,
              'settle_seconds': 0, 'response_timeout_seconds': 30, 'job_ttl_seconds': 300,
              'min_reply_interval_seconds': 10, 'max_reply_chars': 500, 'control_port': 8767,
              'harness_port': 3080, 'harness_root': tmp, 'harness_home': tmp,
              'node_executable': os.path.join(tmp, 'node.exe'), 'agent_workspace': tmp,
              'model': 'test', 'runtime_settings_file': os.path.join(tmp, 's.json'),
              'worker_token_file': os.path.join(tmp, 'w.token'), 'control_token_file': os.path.join(tmp, 'c.token')}

    class NoHarness:
        def close(self):
            pass

    return Worker(config, mcp=mcp, harness=NoHarness())


class BlankWindowTest(unittest.TestCase):
    def test_a_blank_window_triggers_one_restore_and_recovers(self):
        mcp = BlankWindowMcp()
        worker = worker_with(mcp)
        worker.discover(force=True)
        self.assertEqual(mcp.restores, 1)
        self.assertEqual(mcp.scans, 2)            # the failed scan, then the post-restore one
        snapshot = worker.observation_snapshot()
        self.assertEqual(snapshot['error'], '')
        self.assertIn('wechat:alice', snapshot['providers']['wechat-main'])

    def test_the_runtime_detail_is_kept_for_diagnosis(self):
        mcp = BlankWindowMcp(recoverable=False)
        worker = worker_with(mcp)
        worker.discover(force=True)
        snapshot = worker.observation_snapshot()
        self.assertIn('layout_unverified', snapshot['error'])
        self.assertEqual(snapshot['error_detail'], 'The conversation-list boundary could not be identified.')

    def test_the_failing_frames_are_kept_for_the_developer_view(self):
        # The code alone cannot say which sub-check refused the read, so the frames that
        # raised are kept too. `/api/observe` strips this field when the switch is off.
        mcp = BlankWindowMcp(recoverable=False)
        worker = worker_with(mcp)
        worker.discover(force=True)
        trace = worker.observation_snapshot()['error_trace']
        self.assertIn('layout_unverified', trace)
        self.assertIn('read_list', trace)


if __name__ == '__main__':
    unittest.main()
