"""An unconfirmed reply is one lost message, not a reason to stop working.

The rule used to be moved to "blocked" whenever a send could not be confirmed, which also
silenced every later message from that contact. Nothing needs that stop: the trigger only
fires while the last bubble is still received text, so a reply that did go out cannot be
sent twice, and one that did not go out gets answered on the next message.

Run: <messaging-runtime>/runtime/python/python.exe -m unittest agent_worker.test_uncertain_send -v
"""
import json
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
    def __init__(self, send_status='not_sent'):
        self.send_status = send_status

    def call(self, name, arguments):
        if name in ('send_message', 'get_send_status'):
            return {'status': self.send_status}
        raise AssertionError('unexpected tool ' + name)

    def scan(self, provider):
        return {}

    def observe(self, rule):
        return [{'direction': 'incoming', 'content': '在吗', 'sender': None, 'type': 'text'}]


def make_worker(tmp, send_status):
    config = {'database': os.path.join(tmp, 'reply.db'), 'poll_interval_seconds': 5,
              'settle_seconds': 0, 'response_timeout_seconds': 30, 'job_ttl_seconds': 300,
              'min_reply_interval_seconds': 0, 'max_reply_chars': 500, 'control_port': 8767,
              'harness_port': 3080, 'harness_root': tmp, 'harness_home': tmp,
              'node_executable': os.path.join(tmp, 'node.exe'), 'agent_workspace': tmp,
              'model': 'test', 'runtime_settings_file': os.path.join(tmp, 's.json'),
              'worker_token_file': os.path.join(tmp, 'w.token'), 'control_token_file': os.path.join(tmp, 'c.token')}
    mcp = StubMcp(send_status)
    worker = Worker(config, mcp=mcp, harness=StubHarness())
    rule_id = worker.store.add('wechat-main', 'wechat:target', '新疆羊肉串', 'group', '简短回复')
    worker.store.enable(rule_id, True)
    return worker, mcp, rule_id


class UnconfirmedSendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def run_one_job(self, worker, mcp, rule_id):
        rule = worker.store.rule(rule_id)
        messages = mcp.observe(rule)
        worker.store.enqueue(rule, messages, messages[-1], 300)
        job = worker.store.pending()[0]
        worker.process(job)
        return job

    def test_unconfirmed_send_keeps_listening(self):
        worker, mcp, rule_id = make_worker(self.tmp, 'not_sent')
        job = self.run_one_job(worker, mcp, rule_id)
        rule = worker.store.rule(rule_id)
        self.assertEqual(worker.store.job(job['id'])['state'], 'not_sent')
        self.assertNotEqual(rule['status'], 'blocked')
        self.assertEqual(rule['status'], 'listening')
        self.assertIn('不会自动重发', rule['detail'])
        # The contact stays live: a later message must still be picked up.
        self.assertTrue(worker.check_rule(rule))

    def test_uncertain_send_keeps_listening(self):
        worker, mcp, rule_id = make_worker(self.tmp, 'uncertain')
        self.run_one_job(worker, mcp, rule_id)
        rule = worker.store.rule(rule_id)
        self.assertNotEqual(rule['status'], 'blocked')
        self.assertEqual(rule['status'], 'listening')

    def test_restart_during_submission_keeps_listening(self):
        worker, mcp, rule_id = make_worker(self.tmp, 'sent')
        rule = worker.store.rule(rule_id)
        messages = mcp.observe(rule)
        worker.store.enqueue(rule, messages, messages[-1], 300)
        job = worker.store.pending()[0]
        with worker.store.connect() as db:                      # simulate a crash mid-send
            db.execute("UPDATE reply_jobs SET state='sending' WHERE id=?", (job['id'],))
        worker.store.recover()                                  # what a restart does
        rule = worker.store.rule(rule_id)
        self.assertEqual(worker.store.job(job['id'])['state'], 'uncertain')
        self.assertNotEqual(rule['status'], 'blocked')
        self.assertEqual(rule['status'], 'listening')
        self.assertIn('已继续监听', rule['detail'])


if __name__ == '__main__':
    unittest.main()
