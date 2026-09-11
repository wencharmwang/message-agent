import sqlite3
import tempfile
import unittest
from pathlib import Path

from agent_worker.database import SCHEMA_VERSION, Store


class StoreRuleLifecycleTests(unittest.TestCase):
    def test_archive_hides_rule_and_preserves_finished_jobs(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'reply.db')
            rule_id = store.add('wechat-main', 'conversation-1', '测试联系人', 'direct', '简短回复')
            with store.connect() as db:
                db.execute('''INSERT INTO reply_jobs(
                    id,rule_id,rule_revision,provider,conversation,event_id,request_id,state,context,
                    text,created_at,expires_at,finished_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)''', (
                    'job-1', rule_id, 1, 'wechat-main', 'conversation-1', 'event-1', 'request-1',
                    'sent', '{}', '已发送内容', 1, 2, 2,
                ))
            store.archive(rule_id)
            self.assertEqual(store.rules(), [])
            self.assertEqual(store.recent(), [])
            with store.connect() as db:
                self.assertEqual(db.execute('SELECT state FROM reply_jobs WHERE id=?', ('job-1',)).fetchone()[0], 'sent')

    def test_version_one_database_is_migrated(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'reply.db'
            db = sqlite3.connect(path)
            try:
                db.executescript('''
                    CREATE TABLE reply_rules (
                      id TEXT PRIMARY KEY, provider TEXT NOT NULL, conversation TEXT NOT NULL,
                      title TEXT NOT NULL, kind TEXT NOT NULL, prompt TEXT NOT NULL,
                      enabled INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1,
                      status TEXT NOT NULL DEFAULT 'paused', detail TEXT NOT NULL DEFAULT '',
                      baseline TEXT, candidate TEXT, candidate_since REAL, observed_at REAL,
                      last_sent REAL NOT NULL DEFAULT 0, UNIQUE(provider,conversation));
                    PRAGMA user_version=1;
                ''')
                db.commit()
            finally:
                db.close()
            store = Store(path)
            with store.connect() as db:
                columns = {row[1] for row in db.execute('PRAGMA table_info(reply_rules)')}
                self.assertIn('archived', columns)
                self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0], SCHEMA_VERSION)


class StoreAddTests(unittest.TestCase):
    """Adding a rule is a user-facing action: every rejection must say what to do next."""

    def test_duplicate_add_explains_itself(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'reply.db')
            store.add('wechat-main', 'conversation-1', 'Bros', 'direct', '简短回复')
            with self.assertRaises(ValueError) as caught:
                store.add('wechat-main', 'conversation-1', 'Bros', 'direct', '简短回复')
            self.assertIn('已经在列表里', str(caught.exception))

    def test_readding_an_archived_rule_revives_it(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'reply.db')
            first = store.add('wechat-main', 'conversation-1', 'Bros', 'direct', '旧说明')
            store.archive(first)
            self.assertEqual(store.rules(), [])
            again = store.add('wechat-main', 'conversation-1', 'Bros', 'direct', '新说明')
            self.assertEqual(again, first)                # same identity: history stays meaningful
            rule = store.rule(again)
            self.assertEqual(rule['archived'], 0)
            self.assertEqual(rule['enabled'], 0)          # re-added rules start paused
            self.assertEqual(rule['prompt'], '新说明')

    def test_missing_fields_are_reported_in_plain_language(self):
        with tempfile.TemporaryDirectory() as directory:
            store = Store(Path(directory) / 'reply.db')
            with self.assertRaises(ValueError) as caught:
                store.add('wechat-main', 'conversation-1', 'Bros', 'direct', '   ')
            self.assertIn('怎么回复', str(caught.exception))
            with self.assertRaises(ValueError) as caught:
                store.add('wechat-main', 'conversation-1', 'Bros', 'unknown', '简短回复')
            self.assertIn('会话类型', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
