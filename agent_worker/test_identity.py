"""A rule must find itself again when OCR reads its conversation name in pieces.

The conversation id is a hash of the display name, so a name that is read only in part (a
long name rendered with a gap inside it is sometimes read as just its second half) hashes
differently — and a rule stored from the full name would never match again. These checks
pin the recovery, and pin that recovery stays conservative.

Run: <messaging-runtime>/runtime/python/python.exe -m unittest agent_worker.test_identity -v
"""
import os
import tempfile
import unittest

from agent_worker.service import Worker, name_key, names_match


class NameMatchingTests(unittest.TestCase):
    def test_punctuation_and_width_do_not_matter(self):
        self.assertEqual(name_key('新爱书（小规模）&灏天来财税'), '新爱书小规模灏天来财税')
        self.assertTrue(names_match('新爱书（小规模）&灏天来财税', '新爱书(小规模...'))

    def test_a_fragment_finds_its_full_name(self):
        # The measured failure: the row came back as only "(小规模".
        self.assertTrue(names_match('新爱书（小规模）&灏天来财税', '(小规模'))
        self.assertTrue(names_match('大三班(柠檬班)', '(柠檬班'))

    def test_short_or_unrelated_names_do_not_match(self):
        self.assertFalse(names_match('张三', '张三丰'))          # two characters is too weak
        self.assertFalse(names_match('新疆羊肉串', '弘阳17栋网格群'))
        self.assertFalse(names_match('', '任何名字'))
        self.assertTrue(names_match('Wencharm', 'wencharm'))     # case is not identity


class StubHarness:
    def close(self):
        pass


class StubMcp:
    """One conversation in the list, under whatever name the test wants OCR to report."""

    def __init__(self, conversation, name, fingerprint='fp-1'):
        self.conversation = conversation
        self.name = name
        self.fingerprint = fingerprint

    def call(self, name, arguments):
        raise AssertionError('unexpected tool ' + name)

    def scan(self, provider):
        return {self.conversation: {'fingerprint': self.fingerprint, 'name': self.name}}

    def observe(self, rule):
        return [{'direction': 'incoming', 'content': '你好', 'sender': None, 'type': 'text'}]


def make_worker(tmp, conversation, title):
    config = {'database': os.path.join(tmp, 'reply.db'), 'poll_interval_seconds': 5,
              'settle_seconds': 0, 'response_timeout_seconds': 30, 'job_ttl_seconds': 300,
              'min_reply_interval_seconds': 10, 'max_reply_chars': 500, 'control_port': 8767,
              'harness_port': 3080, 'harness_root': tmp, 'harness_home': tmp,
              'node_executable': os.path.join(tmp, 'node.exe'), 'agent_workspace': tmp,
              'model': 'test', 'runtime_settings_file': os.path.join(tmp, 's.json'),
              'worker_token_file': os.path.join(tmp, 'w.token'), 'control_token_file': os.path.join(tmp, 'c.token')}
    mcp = StubMcp(conversation, title)
    worker = Worker(config, mcp=mcp, harness=StubHarness())
    rule_id = worker.store.add('wechat-main', 'wechat:stored-partial', title, 'direct', '简短回复')
    worker.store.enable(rule_id, True)
    return worker, mcp, rule_id


class IdentityRecoveryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        # Stored from a partial read; the list now reports the full name.
        self.worker, self.mcp, self.rule_id = make_worker(self.tmp, 'wechat:full', '新爱书（小规模）&灏天来财税')
        self.worker.store.rebind(self.worker.store.rule(self.rule_id), 'wechat:full', '新爱书（小规模）&灏天来财税')
        self.worker.store.rebind(self.worker.store.rule(self.rule_id), 'wechat:stored-partial', '(小规模')

    def test_rule_heals_onto_the_name_the_list_reports(self):
        rule = self.worker.store.rule(self.rule_id)
        self.assertEqual(rule['conversation'], 'wechat:stored-partial')
        self.worker.tick()
        healed = self.worker.store.rule(self.rule_id)
        self.assertEqual(healed['conversation'], 'wechat:full')      # rebound, permanently
        self.assertEqual(healed['title'], '新爱书（小规模）&灏天来财税')
        self.assertNotEqual(healed['status'], 'waiting_visible')     # not reported as missing

    def test_no_heal_when_nothing_matches(self):
        self.mcp.conversation = 'wechat:other'
        self.mcp.name = '弘阳17栋网格群'
        self.worker.tick()
        self.assertEqual(self.worker.store.rule(self.rule_id)['conversation'], 'wechat:stored-partial')
        self.assertEqual(self.worker.store.rule(self.rule_id)['status'], 'waiting_visible')


if __name__ == '__main__':
    unittest.main()
