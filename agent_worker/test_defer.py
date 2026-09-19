"""Unit checks for the "user is in WeChat" deferral path.

The driver refuses a background read with wechat_in_use when opening the chat would move
the user's screen. The worker must treat that as "read it later", never as an error, and
must keep the pending change so the next tick retries.

Run: <messaging-runtime>/runtime/python/python.exe -m unittest agent_worker.test_defer -v
"""
import os
import tempfile
import unittest

from agent_worker.service import RuntimeToolError, Worker


class StubHarness:
    def close(self):
        pass


class StubMcp:
    """Serves one provider with a fingerprint the test can change, and can refuse reads."""

    def __init__(self):
        self.fingerprint = 'fp-A'
        self.refuse = False
        self.reads = 0

    def call(self, name, arguments):
        raise AssertionError('unexpected tool ' + name)

    def scan(self, provider, scroll_to_top=False):
        return {'wechat:target': {'fingerprint': self.fingerprint, 'name': '新疆羊肉串'}}

    def observe(self, rule):
        self.reads += 1
        if self.refuse:
            raise RuntimeToolError('wechat_in_use', 'Runtime: wechat_in_use')
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
    worker = Worker(config, mcp=mcp, harness=StubHarness())
    worker.store.add('wechat-main', 'wechat:target', '新疆羊肉串', 'group', '回复日常聊天')
    rule_id = worker.store.rules()[0]['id']
    worker.store.enable(rule_id, True)
    return worker, mcp, rule_id


class DeferTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.worker, self.mcp, self.rule_id = make_worker(self.tmp)

    def status(self):
        return self.worker.store.rule(self.rule_id)

    def test_read_defers_without_error_or_lost_change(self):
        self.worker.tick()                                    # baseline
        self.mcp.fingerprint = 'fp-B'                         # the group has something new
        self.mcp.refuse = True
        self.worker.tick()
        rule = self.status()
        self.assertEqual(rule['status'], 'listening')
        self.assertEqual(rule['detail'], '')                  # no alarming message on first defer
        self.assertEqual(self.mcp.reads, 1)
        # The change stays pending, so the next tick tries again instead of dropping it.
        self.worker.tick()
        self.assertEqual(self.mcp.reads, 2)
        # Once the user leaves WeChat the pending read goes through.
        self.mcp.refuse = False
        self.worker.tick()
        self.assertEqual(self.status()['status'], 'listening')

    def test_long_deferral_explains_itself(self):
        self.worker.tick()
        self.mcp.fingerprint = 'fp-B'
        self.mcp.refuse = True
        self.worker.tick()
        self.worker._deferred_since -= 60
        self.worker.tick()
        self.assertIn('你正在使用微信', self.status()['detail'])

    def test_other_tool_errors_still_report_a_connection_problem(self):
        self.worker.tick()
        self.mcp.fingerprint = 'fp-B'

        def broken(rule):
            raise RuntimeToolError('provider_unavailable', 'Runtime: provider_unavailable')

        self.mcp.observe = broken
        self.worker.tick()
        rule = self.status()
        self.assertEqual(rule['status'], 'waiting_connection')
        self.assertIn('暂时读不到微信消息', rule['detail'])


if __name__ == '__main__':
    unittest.main()
