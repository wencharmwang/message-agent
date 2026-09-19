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

from agent_worker.service import Worker, name_key, names_match, strip_ocr_noise


class OcrNoiseTests(unittest.TestCase):
    """A name is also the query given to WeChat's global search, so OCR noise must be stripped.

    Measured on one real contact whose name ends with an emoji no OCR engine can render: the
    same row read as 树袋熊, 树袋熊…, 树袋熊。 and 树袋熊? on different frames, and every read
    that carried the noise failed with contact_not_found. The id is hashed from the same name,
    so this also stops the contact's identity from churning.
    """

    def test_a_short_name_loses_the_fabricated_trailing_character(self):
        for noisy in ('树袋熊…', '树袋熊。', '树袋熊?', '树袋熊？', '树袋熊..', '树袋熊···'):
            self.assertEqual(strip_ocr_noise(noisy), '树袋熊', noisy)

    def test_a_clean_name_is_returned_unchanged(self):
        for clean in ('树袋熊', 'Bros', 'Wencharm', '小璐璐', '大三班(柠檬班)'):
            self.assertEqual(strip_ocr_noise(clean), clean)

    def test_a_long_name_keeps_the_ellipsis_wechat_itself_used(self):
        # On a long row the same glyphs are WeChat's truncation marker, not noise. Dropping
        # them would search for a name no row reports and detach the conversation.
        long_name = '新爱书（小规模）&灏天来财税...'
        self.assertEqual(strip_ocr_noise(long_name), long_name)

    def test_nothing_but_noise_falls_back_to_the_raw_name(self):
        self.assertEqual(strip_ocr_noise('…'), '…')
        self.assertEqual(strip_ocr_noise(''), '')
        self.assertEqual(strip_ocr_noise(None), '')


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


class NameMatchingToleranceTests(unittest.TestCase):
    """One character of OCR noise must not detach a conversation from its rule."""

    def test_a_misread_character_still_matches(self):
        # Measured: the same row reads as 小璐璐 on one frame and 小璐路璐 on the next.
        self.assertTrue(names_match('小璐璐', '小璐路璐'))
        self.assertTrue(names_match('小璐路璐', '小璐璐'))

    def test_other_differences_do_not_match(self):
        self.assertFalse(names_match('小璐璐', '小璐路路'))     # two extra characters
        self.assertFalse(names_match('新疆羊肉串', '新疆羊肉粉'))  # a substitution: a different name
        self.assertFalse(names_match('张三', '李四'))


class StubHarness:
    def close(self):
        pass


class StubMcp:
    """One conversation in the list, under whatever name the test wants OCR to report."""

    def __init__(self, conversation, name, fingerprint='fp-1'):
        self.conversation = conversation
        self.name = name
        self.fingerprint = fingerprint
        # A test sets one of these to model a conversation sitting above the viewport: the
        # visible-list read cannot see it, and only a scroll-back brings it into view.
        self.hidden_until_scroll = False
        self.hidden_forever = False
        self.scrolls = 0

    def call(self, name, arguments):
        if name == 'scroll_conversation_list_to_top':
            self.scrolls += 1
            return {'scrolled': True}
        raise AssertionError('unexpected tool ' + name)

    def scan(self, provider, scroll_to_top=False):
        if scroll_to_top:
            self.call('scroll_conversation_list_to_top', {'provider': provider})
        if self.hidden_forever or (self.hidden_until_scroll and not scroll_to_top):
            return {}
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

    def test_a_rule_heals_across_a_misread_character(self):
        self.mcp.conversation = 'wechat:misread'
        self.mcp.name = '小璐路璐'
        self.worker.store.rebind(self.worker.store.rule(self.rule_id), 'wechat:stored-partial', '小璐璐')
        self.worker.tick()
        self.assertEqual(self.worker.store.rule(self.rule_id)['conversation'], 'wechat:misread')


class ListVisibilityRecoveryTests(unittest.TestCase):
    """WeChat moves a conversation that received a message to the first row but does not bring
    the viewport with it, so a list that has been scrolled down hides exactly the rows the poller
    needs.

    Measured symptom: a rule watching one contact reported 当前微信可见会话列表中未找到 while the
    conversation sat right above the viewport, and the person found that opening that chat once by
    hand made the assistant start working again.
    """

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.worker, self.mcp, self.rule_id = make_worker(self.tmp, 'wechat:x', '小璐璐')
        self.worker.store.rebind(self.worker.store.rule(self.rule_id), 'wechat:x', '小璐璐')

    def status(self):
        return self.worker.store.rule(self.rule_id)['status']

    def test_a_row_above_the_viewport_is_found_after_scrolling_back(self):
        self.mcp.hidden_until_scroll = True
        self.worker.tick()
        self.assertEqual(self.mcp.scrolls, 1)
        self.assertNotEqual(self.status(), 'waiting_visible')

    def test_nothing_is_scrolled_while_the_row_is_visible(self):
        self.worker.tick()
        self.assertEqual(self.mcp.scrolls, 0)

    def test_scrolling_is_throttled_so_the_person_keeps_their_list(self):
        self.mcp.hidden_forever = True
        for _ in range(3):
            self.worker.tick()
        self.assertEqual(self.mcp.scrolls, 1)
        self.assertEqual(self.status(), 'waiting_visible')

    def test_a_reply_in_flight_is_not_relabelled_as_missing(self):
        # The reported contradiction: the answer went out and the status still said 找不到联系人.
        self.mcp.hidden_forever = True
        rule = self.worker.store.rule(self.rule_id)
        self.worker.store.status(rule['id'], rule['revision'], 'sending', '正在发送')
        self.worker.tick()
        self.assertEqual(self.status(), 'sending')


if __name__ == '__main__':
    unittest.main()
