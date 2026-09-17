"""The developer view: a failed read must not lose the reason on the way out.

The product bug this guards: every layer replaced the real failure with a friendlier
sentence — the runtime's own wording was dropped, the traceback was swallowed, and all
that reached the browser was "操作没有完成，请稍后重试。". "读取不到消息" was undiagnosable
from the product side. These checks pin both halves of the fix: with the switch on the raw
code, the runtime's wording and the call stack travel with the response; with the switch
off none of it is attached, so a launched build cannot leak them.

Run: <messaging-runtime>/runtime/python/python.exe -m unittest agent_worker.test_dev_diagnostics -v
"""
import json
import os
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

from agent_worker.__main__ import handler
from agent_worker.service import RuntimeToolError, Worker


class FailingReadMcp:
    """A runtime that refuses to open the chat, exactly as the WeChat driver does."""

    def __init__(self):
        self.observed = []

    def call(self, name, arguments):
        if name == 'list_conversations':
            return {'conversations': [{'id': 'wechat:target', 'title': '树袋熊', 'metadata': {}}]}
        raise AssertionError('unexpected tool ' + name)

    def observe(self, rule, limit=30):
        self.observed.append(rule)
        raise RuntimeToolError('layout_unverified', 'Runtime: layout_unverified',
                               'The conversation-list boundary could not be identified.')

    def scan(self, provider):
        return {}


class NoHarness:
    def close(self):
        pass


def make_worker():
    tmp = tempfile.mkdtemp()
    config = {'database': os.path.join(tmp, 'reply.db'), 'poll_interval_seconds': 5,
              'settle_seconds': 0, 'response_timeout_seconds': 30, 'job_ttl_seconds': 300,
              'min_reply_interval_seconds': 10, 'max_reply_chars': 500, 'control_port': 8767,
              'harness_port': 3080, 'harness_root': tmp, 'harness_home': tmp,
              'node_executable': os.path.join(tmp, 'node.exe'), 'agent_workspace': tmp,
              'model': 'test', 'runtime_settings_file': os.path.join(tmp, 's.json'),
              'worker_token_file': os.path.join(tmp, 'w.token'), 'control_token_file': os.path.join(tmp, 'c.token')}
    return Worker(config, mcp=FailingReadMcp(), harness=NoHarness())


class DevDiagnosticsTest(unittest.TestCase):
    def setUp(self):
        self.worker = make_worker()
        self.token = 'test-token'
        # Port 0 lets the OS pick; the origin check reads control_port per request, so the
        # real port is written back before anything is sent.
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), handler(self.worker, self.token))
        self.port = self.server.server_address[1]
        self.worker.config['control_port'] = self.port
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        # Cleanups run last-registered-first: close the socket only after serve_forever
        # has been asked to stop, otherwise the accept loop dies with WinError 10038.
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.thread.start()

    def read(self):
        request = urllib.request.Request(
            'http://127.0.0.1:%d/api/read' % self.port,
            json.dumps({'provider': 'wechat-main', 'conversation_id': 'wechat:target'}).encode('utf-8'),
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json'})
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open(request, timeout=10) as response:
                return response.status, json.load(response)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)

    def test_a_refused_read_keeps_the_runtime_wording_and_the_stack(self):
        self.worker.store.set_setting('dev_diagnostics', True)
        status, body = self.read()
        self.assertEqual(status, 409)
        self.assertEqual(body['code'], 'layout_unverified')
        self.assertEqual(body['detail'], 'The conversation-list boundary could not be identified.')
        self.assertEqual(body['dev']['code'], 'layout_unverified')
        self.assertEqual(body['dev']['detail'], 'The conversation-list boundary could not be identified.')
        self.assertIn('where', body['dev'])
        self.assertIn('at', body['dev'])

    def test_the_stack_names_the_frame_that_failed(self):
        self.worker.store.set_setting('dev_diagnostics', True)
        _, body = self.read()
        # Without the frames there is no way to tell which sub-check refused the read.
        self.assertIn('RuntimeToolError', body['dev']['trace'])
        self.assertIn('observe', body['dev']['trace'])

    def test_manual_read_resolves_the_row_id_to_a_user_commanded_title(self):
        self.worker.store.set_setting('dev_diagnostics', True)
        self.read()
        self.assertEqual(self.worker.mcp.observed[-1],
                         {'provider': 'wechat-main', 'conversation': '树袋熊'})

    def test_switching_the_developer_view_off_attaches_nothing(self):
        self.worker.store.set_setting('dev_diagnostics', False)
        _, body = self.read()
        self.assertEqual(body.get('dev'), {})
        self.assertNotIn('trace', json.dumps(body))

    def test_the_switch_defaults_to_on_while_the_product_is_being_built(self):
        # No stored setting yet: the developer view is on, because the failures it explains
        # are exactly the ones a developer is looking at.
        self.assertEqual(self.worker.store.setting('dev_diagnostics', '1'), '1')
        _, body = self.read()
        self.assertTrue(body['dev'])


if __name__ == '__main__':
    unittest.main()
