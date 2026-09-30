import unittest
from .send_outcome import normalize_send_outcome


class SendOutcomeTests(unittest.TestCase):
    def test_nested_preflight_reason_survives(self):
        result = normalize_send_outcome({'status': 'not_sent', 'receipt': {
            'verification': 'not_submitted:window_blank'}})
        self.assertEqual(result['code'], 'window_blank')
        self.assertEqual(result['detail'], 'not_submitted:window_blank')

    def test_missing_receipt_is_never_success(self):
        self.assertEqual(normalize_send_outcome({})['status'], 'uncertain')
        self.assertEqual(normalize_send_outcome({'status': 'not_sent'})['code'], 'not_sent')

    def test_sent_receipt_stays_sent(self):
        self.assertEqual(normalize_send_outcome({'status': 'sent'})['status'], 'sent')

    def test_explicit_error_is_preserved(self):
        result = normalize_send_outcome({'status': 'not_sent', 'code': 'input_failed',
                                        'detail': 'input rejected'})
        self.assertEqual(result['detail'], 'input rejected')
        self.assertEqual(result['code'], 'input_failed')
