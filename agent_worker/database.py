"""Local control-plane rules and crash-visible reply jobs; no model can write these tables."""
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import time
import uuid

SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS reply_rules (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, conversation TEXT NOT NULL, title TEXT NOT NULL,
 kind TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'paused', detail TEXT NOT NULL DEFAULT '',
 baseline TEXT, candidate TEXT, candidate_since REAL, observed_at REAL, last_sent REAL NOT NULL DEFAULT 0,
 UNIQUE(provider,conversation));
CREATE TABLE IF NOT EXISTS reply_jobs (
 id TEXT PRIMARY KEY, rule_id TEXT NOT NULL REFERENCES reply_rules(id), rule_revision INTEGER NOT NULL,
 provider TEXT NOT NULL, conversation TEXT NOT NULL, event_id TEXT NOT NULL UNIQUE,
 request_id TEXT NOT NULL UNIQUE, state TEXT NOT NULL, context TEXT NOT NULL,
 text TEXT, decision TEXT, detail TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL,
 expires_at REAL NOT NULL, finished_at REAL);
CREATE INDEX IF NOT EXISTS reply_jobs_rule ON reply_jobs(rule_id,created_at);
CREATE TABLE IF NOT EXISTS reply_activity (
 rule_id TEXT PRIMARY KEY REFERENCES reply_rules(id) ON DELETE CASCADE,
 baseline TEXT, candidate TEXT, candidate_since REAL, observed_at REAL NOT NULL
);
PRAGMA user_version=1;
"""


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version not in (0, 1):
                raise ValueError('Unsupported automatic reply database version')
            db.executescript(SCHEMA)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=5)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA foreign_keys=ON')
        try:
            with db:
                yield db
        finally:
            db.close()

    def rules(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute('SELECT * FROM reply_rules ORDER BY title')]

    def rule(self, rule_id):
        with self.connect() as db:
            row = db.execute('SELECT * FROM reply_rules WHERE id=?', (rule_id,)).fetchone()
            if row is None:
                raise ValueError('Rule not found')
            return dict(row)

    def add(self, provider, conversation, title, kind, prompt):
        if kind not in ('direct', 'group') or not all(isinstance(x, str) and x.strip() for x in (provider, conversation, title, prompt)):
            raise ValueError('Invalid rule')
        if len(prompt) > 4000 or len(title) > 200 or len(conversation) > 300:
            raise ValueError('Rule is too long')
        rule_id = str(uuid.uuid4())
        with self.connect() as db:
            db.execute('INSERT INTO reply_rules(id,provider,conversation,title,kind,prompt) VALUES(?,?,?,?,?,?)',
                       (rule_id, provider, conversation, title, kind, prompt))
        return rule_id

    def enable(self, rule_id, enabled):
        with self.connect() as db:
            db.execute("UPDATE reply_rules SET enabled=?,revision=revision+1,status=?,detail='',baseline=NULL,candidate=NULL WHERE id=?",
                       (int(enabled), 'starting' if enabled else 'paused', rule_id))
            db.execute("UPDATE reply_jobs SET state='cancelled',detail='Rule changed',finished_at=? WHERE rule_id=? AND state IN ('queued','generating','ready')",
                       (time.time(), rule_id))
            db.execute('DELETE FROM reply_activity WHERE rule_id=?', (rule_id,))

    def edit(self, rule_id, prompt):
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 4000:
            raise ValueError('Invalid reply instructions')
        with self.connect() as db:
            db.execute("UPDATE reply_rules SET prompt=?,enabled=0,revision=revision+1,status='paused',detail='',baseline=NULL,candidate=NULL WHERE id=?", (prompt, rule_id))
            db.execute("UPDATE reply_jobs SET state='cancelled',detail='Rule edited',finished_at=? WHERE rule_id=? AND state IN ('queued','generating','ready')", (time.time(), rule_id))
            db.execute('DELETE FROM reply_activity WHERE rule_id=?', (rule_id,))

    def activity(self, rule, fingerprint, settle):
        """Return initialize/changed only after a visible-list signal is stable."""
        now = time.time()
        with self.connect() as db:
            row = db.execute('SELECT * FROM reply_activity WHERE rule_id=?', (rule['id'],)).fetchone()
            if row is None:
                # Startup establishes only the visible-list baseline. Opening a
                # conversation is reserved for a later preview/time change.
                db.execute('INSERT INTO reply_activity(rule_id,baseline,observed_at) VALUES(?,?,?)',
                           (rule['id'], fingerprint, now))
                return 'initialized'
            db.execute('UPDATE reply_activity SET observed_at=? WHERE rule_id=?', (now, rule['id']))
            if fingerprint == row['baseline']:
                db.execute('UPDATE reply_activity SET candidate=NULL,candidate_since=NULL WHERE rule_id=?', (rule['id'],))
                return 'unchanged'
            if fingerprint != row['candidate']:
                db.execute('UPDATE reply_activity SET candidate=?,candidate_since=? WHERE rule_id=?',
                           (fingerprint, now, rule['id']))
                return 'changed' if settle <= 0 else 'settling'
            if now - row['candidate_since'] < settle:
                return 'settling'
            return 'initialize' if row['baseline'] is None else 'changed'

    def commit_activity(self, rule, fingerprint):
        with self.connect() as db:
            db.execute('UPDATE reply_activity SET baseline=?,candidate=NULL,candidate_since=NULL WHERE rule_id=? AND candidate=?',
                       (fingerprint, rule['id'], fingerprint))

    def status(self, rule_id, revision, status, detail=''):
        with self.connect() as db:
            db.execute('UPDATE reply_rules SET status=?,detail=? WHERE id=? AND revision=? AND enabled=1',
                       (status, detail[:500], rule_id, revision))

    def observation(self, rule, messages, settle):
        """Return a confirmed changed snapshot; first observation is only the baseline."""
        encoded = json.dumps(messages, ensure_ascii=False, sort_keys=True)
        now = time.time()
        with self.connect() as db:
            current = db.execute('SELECT * FROM reply_rules WHERE id=?', (rule['id'],)).fetchone()
            if not current['enabled'] or current['revision'] != rule['revision']:
                return None
            db.execute('UPDATE reply_rules SET observed_at=? WHERE id=?', (now, rule['id']))
            if current['baseline'] is None:
                db.execute("UPDATE reply_rules SET baseline=?,candidate=NULL,status='listening',detail='' WHERE id=?", (encoded, rule['id']))
                return None
            if encoded == current['baseline']:
                db.execute("UPDATE reply_rules SET candidate=NULL,status='listening',detail='' WHERE id=?", (rule['id'],))
                return None
            if encoded != current['candidate']:
                db.execute("UPDATE reply_rules SET candidate=?,candidate_since=?,status='settling',detail='' WHERE id=?", (encoded, now, rule['id']))
                return None
            return (json.loads(current['baseline']), messages) if now - current['candidate_since'] >= settle else None

    def enqueue(self, rule, messages, incoming, ttl):
        now = time.time()
        job_id, event_id, request_id = (str(uuid.uuid4()) for _ in range(3))
        context = json.dumps({'messages': messages, 'incoming': incoming}, ensure_ascii=False)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            r = db.execute('SELECT * FROM reply_rules WHERE id=?', (rule['id'],)).fetchone()
            if not r['enabled'] or r['revision'] != rule['revision'] or r['status'] in ('blocked', 'needs_user'):
                return None
            if db.execute("SELECT 1 FROM reply_jobs WHERE rule_id=? AND state IN ('queued','generating','ready','sending')", (rule['id'],)).fetchone():
                return None
            db.execute('INSERT INTO reply_jobs(id,rule_id,rule_revision,provider,conversation,event_id,request_id,state,context,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                       (job_id, rule['id'], rule['revision'], rule['provider'], rule['conversation'], event_id, request_id, 'queued', context, now, now + ttl))
            db.execute("UPDATE reply_rules SET baseline=?,candidate=NULL,status='queued',detail='' WHERE id=?",
                       (json.dumps(messages, ensure_ascii=False, sort_keys=True), rule['id']))
        return self.job(job_id)

    def job(self, job_id):
        with self.connect() as db:
            return dict(db.execute('SELECT * FROM reply_jobs WHERE id=?', (job_id,)).fetchone())

    def pending(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute("SELECT * FROM reply_jobs WHERE state='queued' ORDER BY created_at")]

    def transition(self, job_id, previous, state, text=None, decision=None, detail=''):
        with self.connect() as db:
            cursor = db.execute('UPDATE reply_jobs SET state=?,text=COALESCE(?,text),decision=COALESCE(?,decision),detail=? WHERE id=? AND state=?',
                                (state, text, decision, detail[:500], job_id, previous))
            return cursor.rowcount == 1

    def claim_send(self, job):
        with self.connect() as db:
            cursor = db.execute("""UPDATE reply_jobs SET state='sending' WHERE id=? AND state='ready' AND expires_at>?
                AND EXISTS(SELECT 1 FROM reply_rules r WHERE r.id=reply_jobs.rule_id AND r.enabled=1
                  AND r.revision=reply_jobs.rule_revision AND r.status NOT IN ('blocked','needs_user'))""", (job['id'], time.time()))
            return cursor.rowcount == 1

    def finish(self, job, state, detail=''):
        with self.connect() as db:
            db.execute('UPDATE reply_jobs SET state=?,detail=?,finished_at=? WHERE id=?', (state, detail[:500], time.time(), job['id']))
            if state == 'sent':
                db.execute('UPDATE reply_rules SET last_sent=? WHERE id=?', (time.time(), job['rule_id']))

    def replace_baseline(self, rule, messages):
        with self.connect() as db:
            db.execute('UPDATE reply_rules SET baseline=?,candidate=NULL WHERE id=? AND revision=?',
                       (json.dumps(messages, ensure_ascii=False, sort_keys=True), rule['id'], rule['revision']))

    def recover(self):
        with self.connect() as db:
            rows = db.execute("SELECT * FROM reply_jobs WHERE state IN ('generating','ready','sending')").fetchall()
            for row in rows:
                if row['state'] == 'sending':
                    db.execute("UPDATE reply_jobs SET state='uncertain',detail='Worker restarted during submission' WHERE id=?", (row['id'],))
                    db.execute("UPDATE reply_rules SET status='blocked',detail='发送阶段中断，请检查任务后重新启用规则' WHERE id=? AND revision=?",
                               (row['rule_id'], row['rule_revision']))
                else:
                    db.execute("UPDATE reply_jobs SET state='failed',detail='Worker restarted before submission' WHERE id=?", (row['id'],))
                    db.execute("UPDATE reply_rules SET status='listening',detail='上条消息处理被重启中断；已继续监听' WHERE id=? AND revision=? AND enabled=1",
                               (row['rule_id'], row['rule_revision']))

    def recent(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute('SELECT id,rule_id,event_id,request_id,state,text,detail,created_at,finished_at FROM reply_jobs ORDER BY created_at DESC LIMIT 50')]
