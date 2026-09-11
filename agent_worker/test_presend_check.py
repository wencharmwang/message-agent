"""The pre-send re-check reads the list, not the chat.

Opening a chat is a visible switch for the user, so the "did the conversation move on while
the model was thinking" check uses the list row's fingerprint instead: same row, same
conversation, nothing to re-read. Only a row that actually changed is opened again.

Run: <messaging-runtime>/runtime/python/python.exe -m unittest agent_worker.test_presend_check -v
"""
import os
import tempfile
import unittest

from agent_worker.service import Worker


class StubHarness:
    def run(self, rule, job):
        return {'action': 'reply', 'text': '好的，收到'}

    def close(self):
        pass


class StubMcp:
    """One conversation whose list fingerprint the test can change at will."""

    def __init__(self, fingerprint='fp-1', send_status='sent', latest='在吗'):
        self.fingerprint = fingerprint
        self.send_status = send_status
        self.latest = latest
        self.observations = 0

    def call(self, name, arguments):
        if name in ('send_message', 'get_send_status'):
            return {'status': self.send_status}
        raise AssertionError('unexpected tool ' + name)

    def scan(self, provider):
        return {'wechat:target': {'fingerprint': self.fingerprint, 'name': '新疆羊肉串'}}

    def observe(self, rule):
        self.observations += 1
        return [{'direction': 'incoming', 'content': self.latest, 'sender': None, 'type': 'text'}]


def make_worker(tmp, **kwargs):
    config = {'database': os.path.join(tmp, 'reply.db'), 'poll_interval_seconds': 5,
              'settle_seconds': 0, 'response_timeout_seconds': 30, 'job_ttl_seconds': 300,
              'min_reply_interval_seconds': 0, 'max_reply_chars': 500, 'control_port': 8767,
              'harness_port': 3080, 'harness_root': tmp, 'harness_home': tmp,
              'node_executable': os.path.join(tmp, 'node.exe'), 'agent_workspace': tmp,
              'model': 'test', 'runtime_settings_file': os.path.join(tmp, 's.json'),
              'worker_token_file': os.path.join(tmp, 'w.token'), 'control_token_file': os.path.join(tmp, 'c.token')}
    mcp = StubMcp(**kwargs)
    worker = Worker(config, mcp=mcp, harness=StubHarness())
    rule_id = worker.store.add('wechat-main', 'wechat:target', '新疆羊肉串', 'group', '简短回复')
    worker.store.enable(rule_id, True)
    return worker, mcp, rule_id


class PreSendCheckTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def enqueue_job(self, worker, mcp, fingerprint):
        rule = worker.store.rule(self.rule_id)
        messages = mcp.observe(rule)
        worker.store.enqueue(rule, messages, messages[-1], 300, fingerprint)
        return worker.store.pending()[0]

    def setUp_worker(self, **kwargs):
        self.worker, self.mcp, self.rule_id = make_worker(self.tmp, **kwargs)

    def test_unchanged_row_skips_opening_the_chat(self):
        self.setUp_worker(fingerprint='fp-1')
        job = self.enqueue_job(self.worker, self.mcp, 'fp-1')
        reads_before = self.mcp.observations
        self.worker.process(job)
        self.assertEqual(self.mcp.observations, reads_before)      # the chat was not opened again
        self.assertEqual(self.worker.store.job(job['id'])['state'], 'sent')

    def test_changed_row_still_rechecks_the_chat(self):
        self.setUp_worker(fingerprint='fp-1')
        job = self.enqueue_job(self.worker, self.mcp, 'fp-1')
        self.mcp.fingerprint = 'fp-2'          # someone wrote in the meantime
        self.worker.process(job)
        self.assertEqual(self.mcp.observations, 2)                 # the chat was opened and checked

    def test_row_changed_and_message_changed_is_superseded(self):
        self.setUp_worker(fingerprint='fp-1')
        job = self.enqueue_job(self.worker, self.mcp, 'fp-1')
        self.mcp.fingerprint = 'fp-2'
        self.mcp.latest = '那我先走了'
        self.worker.process(job)
        self.assertEqual(self.worker.store.job(job['id'])['state'], 'superseded')

    def test_a_job_without_a_fingerprint_falls_back_to_reading_the_chat(self):
        self.setUp_worker(fingerprint='fp-9')
        job = self.enqueue_job(self.worker, self.mcp, '')          # jobs stored before this change
        self.worker.process(job)
        self.assertEqual(self.mcp.observations, 2)


if __name__ == '__main__':
    unittest.main()
