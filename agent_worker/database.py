"""Local control-plane rules and crash-visible reply jobs; no model can write these tables."""
SCHEMA_VERSION = 3
from contextlib import contextmanager
import json
from pathlib import Path
import sqlite3
import time
import uuid

SCHEMA = f"""
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS reply_rules (
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, conversation TEXT NOT NULL, title TEXT NOT NULL,
 kind TEXT NOT NULL, prompt TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'paused', detail TEXT NOT NULL DEFAULT '',
 baseline TEXT, candidate TEXT, candidate_since REAL, observed_at REAL, last_sent REAL NOT NULL DEFAULT 0,
 archived INTEGER NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS runtime_settings (
 key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at REAL NOT NULL
);
PRAGMA user_version={SCHEMA_VERSION};
"""


class Store:
    def __init__(self, path):
        self.path = str(path)
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            version = db.execute('PRAGMA user_version').fetchone()[0]
            if version not in range(SCHEMA_VERSION + 1):
                raise ValueError('Unsupported automatic reply database version')
            if version == 1:
                db.execute('ALTER TABLE reply_rules ADD COLUMN archived INTEGER NOT NULL DEFAULT 0')
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
            return [dict(r) for r in db.execute('SELECT * FROM reply_rules WHERE archived=0 ORDER BY title')]

    def rule(self, rule_id):
        with self.connect() as db:
            row = db.execute('SELECT * FROM reply_rules WHERE id=?', (rule_id,)).fetchone()
            if row is None:
                raise ValueError('Rule not found')
            return dict(row)

    def add(self, provider, conversation, title, kind, prompt):
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError('请先写清楚希望助手怎么回复')
        if not all(isinstance(x, str) and x.strip() for x in (provider, conversation, title)):
            raise ValueError('会话信息不完整，请点「重新读取微信」后再添加')
        if kind not in ('direct', 'group'):
            raise ValueError('会话类型不正确')
        if len(prompt) > 4000:
            raise ValueError('回复说明太长了，请精简到 4000 字以内')
        if len(title) > 200 or len(conversation) > 300:
            raise ValueError('会话名称过长，无法建立规则')
        with self.connect() as db:
            existing = db.execute('SELECT id,archived FROM reply_rules WHERE provider=? AND conversation=?',
                                  (provider, conversation)).fetchone()
            if existing and not existing['archived']:
                raise ValueError('这个会话已经在列表里了，不用重复添加')
            if existing:
                # Re-adding a deleted contact revives the old row: the delivery audit and
                # job history under it stay meaningful, and the UNIQUE identity is reused.
                # 重新加回来也直接开着（同上：加了就是要开）。
                db.execute("""UPDATE reply_rules SET archived=0,enabled=1,revision=revision+1,status='starting',
                              detail='',prompt=?,title=?,kind=?,baseline=NULL,candidate=NULL,candidate_since=NULL
                              WHERE id=?""", (prompt, title, kind, existing['id']))
                return existing['id']
            rule_id = str(uuid.uuid4())
            # **加了就是要开**（用户明确要求）：默认 enabled=1 + starting，
            # 不用再点一次"开启"。不想让它回就删掉或手动暂停。
            db.execute('INSERT INTO reply_rules(id,provider,conversation,title,kind,prompt,enabled,status) '
                       'VALUES(?,?,?,?,?,?,1,?)',
                       (rule_id, provider, conversation, title, kind, prompt, 'starting'))
        return rule_id

    def enable(self, rule_id, enabled):
        with self.connect() as db:
            db.execute("UPDATE reply_rules SET enabled=?,revision=revision+1,status=?,detail='',baseline=NULL,candidate=NULL WHERE id=?",
                       (int(enabled), 'starting' if enabled else 'paused', rule_id))
            db.execute("UPDATE reply_jobs SET state='cancelled',detail='Rule changed',finished_at=? WHERE rule_id=? AND state IN ('queued','generating','ready')",
                       (time.time(), rule_id))
            db.execute('DELETE FROM reply_activity WHERE rule_id=?', (rule_id,))

    def edit(self, rule_id, prompt):
        """改回复说明。

        **改完继续按新规则监听** —— 以前这里顺手把 enabled 置 0、状态改成 paused，
        于是用户每改一次规则就要手动再开一次（实测被指出来："修改了规则怎么就停止监听了"）。
        用户的期待是：改的是「怎么回」，不是「要不要回」。
        """
        if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 4000:
            raise ValueError('Invalid reply instructions')
        with self.connect() as db:
            row = db.execute('SELECT enabled FROM reply_rules WHERE id=?', (rule_id,)).fetchone()
            if row is None:
                raise ValueError('没有这条规则')
            # 状态跟着"开没开"走：开着就重新起一次基线（starting），没开就还是暂停。
            status = 'starting' if row['enabled'] else 'paused'
            db.execute("UPDATE reply_rules SET prompt=?,revision=revision+1,status=?,detail='',baseline=NULL,candidate=NULL WHERE id=?",
                       (prompt, status, rule_id))
            db.execute("UPDATE reply_jobs SET state='cancelled',detail='Rule edited',finished_at=? WHERE rule_id=? AND state IN ('queued','generating','ready')", (time.time(), rule_id))
            db.execute('DELETE FROM reply_activity WHERE rule_id=?', (rule_id,))

    def archive(self, rule_id):
        """Remove a rule from the product UI without erasing its delivery audit."""
        with self.connect() as db:
            rule = db.execute('SELECT * FROM reply_rules WHERE id=? AND archived=0', (rule_id,)).fetchone()
            if rule is None:
                raise ValueError('Rule not found')
            if db.execute("SELECT 1 FROM reply_jobs WHERE rule_id=? AND state='sending'", (rule_id,)).fetchone():
                raise ValueError('Rule has a message being sent')
            db.execute("UPDATE reply_rules SET archived=1,enabled=0,revision=revision+1,status='archived',detail='',baseline=NULL,candidate=NULL WHERE id=?", (rule_id,))
            db.execute("UPDATE reply_jobs SET state='cancelled',detail='Rule deleted',finished_at=? WHERE rule_id=? AND state IN ('queued','generating','ready')", (time.time(), rule_id))
            db.execute('DELETE FROM reply_activity WHERE rule_id=?', (rule_id,))

    def rebind(self, rule, conversation, title):
        """Point a rule at the id this read produced, and adopt the fuller name.

        A conversation id is a hash of the display name, so a rule stored from a partial
        read would never match again. Rebinding keeps its history and job audit, and the
        baseline is cleared so the next scan establishes a fresh one.
        """
        with self.connect() as db:
            taken = db.execute('SELECT id FROM reply_rules WHERE provider=? AND conversation=?',
                               (rule['provider'], conversation)).fetchone()
            if taken is not None and taken['id'] != rule['id']:
                return False
            db.execute("""UPDATE reply_rules SET conversation=?,title=?,status='starting',detail='',
                          baseline=NULL,candidate=NULL,candidate_since=NULL WHERE id=?""",
                       (conversation, title, rule['id']))
        return True

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

    def enqueue(self, rule, messages, incoming, ttl, fingerprint=''):
        now = time.time()
        job_id, event_id, request_id = (str(uuid.uuid4()) for _ in range(3))
        # The list fingerprint travels with the job so the pre-send check can be answered by
        # re-reading the list instead of opening the chat again (see Worker.process).
        context = json.dumps({'messages': messages, 'incoming': incoming, 'fingerprint': fingerprint},
                             ensure_ascii=False)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            r = db.execute('SELECT * FROM reply_rules WHERE id=?', (rule['id'],)).fetchone()
            if not r['enabled'] or r['revision'] != rule['revision'] or r['status'] == 'blocked':
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
                  AND r.revision=reply_jobs.rule_revision AND r.status != 'blocked')""", (job['id'], time.time()))
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
                    # Keep listening. The unconfirmed reply is marked uncertain and never
                    # retried, so stopping the rule only adds silence on top of a lost reply.
                    db.execute("UPDATE reply_rules SET status='listening',detail='助手重启时这条正在发送，无法确认是否已发出；不会自动重发，已继续监听' WHERE id=? AND revision=? AND enabled=1",
                               (row['rule_id'], row['rule_revision']))
                else:
                    db.execute("UPDATE reply_jobs SET state='failed',detail='Worker restarted before submission' WHERE id=?", (row['id'],))
                    db.execute("UPDATE reply_rules SET status='listening',detail='上条消息处理被重启中断；已继续监听' WHERE id=? AND revision=? AND enabled=1",
                               (row['rule_id'], row['rule_revision']))

    def setting(self, key, default=None):
        """User-facing toggles live here, not in config.json, so the UI can change them live."""
        with self.connect() as db:
            row = db.execute('SELECT value FROM runtime_settings WHERE key=?', (key,)).fetchone()
        return row['value'] if row else default

    def set_setting(self, key, value):
        if not isinstance(key, str) or not 0 < len(key) <= 60:
            raise ValueError('Invalid setting name')
        text = '1' if value in (True, 1, '1', 'true', 'on') else '0' if value in (False, 0, '0', 'false', 'off') else str(value)[:200]
        with self.connect() as db:
            db.execute('INSERT INTO runtime_settings(key,value,updated_at) VALUES(?,?,?) '
                       'ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
                       (key, text, time.time()))
        return text

    def recent(self):
        with self.connect() as db:
            return [dict(r) for r in db.execute('''SELECT j.id,j.rule_id,j.event_id,j.request_id,j.state,j.text,j.detail,j.created_at,j.finished_at
                FROM reply_jobs j JOIN reply_rules r ON r.id=j.rule_id WHERE r.archived=0 ORDER BY j.created_at DESC LIMIT 50''')]
