import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Reply Context System storage (spec §11). A single SQLite file owned exclusively by the
 * Host, WAL enabled. The Worker's reply.db and the CRM's crm.db keep owning their own data;
 * this file holds the context plane: communication profiles, static knowledge, relationship
 * memories, reply examples, learning candidates, item revisions and per-run audit.
 *
 * Every table carries workspace_id so a future multi-tenant deployment does not need a
 * schema rewrite. Today it is always 'local' (spec §3.7). The database layer never touches
 * a Harness Agent object (spec §12).
 */

// State whitelists (spec §11.2). Anything outside these is rejected at write time.
export const PROFILE_STATES = ['draft', 'active', 'retired'];
export const KNOWLEDGE_STATES = ['draft', 'published', 'retired'];
export const MEMORY_STATES = ['candidate', 'confirmed', 'resolved', 'expired'];
export const EXAMPLE_STATES = ['candidate', 'approved', 'rejected'];
export const CANDIDATE_STATES = ['pending', 'accepted', 'rejected'];

export const RISK_LEVELS = ['low', 'medium', 'high'];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS communication_profiles (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  rules_json      TEXT NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1,
  created_at      REAL NOT NULL,
  updated_at      REAL NOT NULL,
  UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS profile_bindings (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  profile_id      TEXT NOT NULL,
  scope_type      TEXT NOT NULL,
  scope_key       TEXT NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  created_at      REAL NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES communication_profiles(id)
);

CREATE TABLE IF NOT EXISTS knowledge_items (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  metadata_json   TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  source_ref      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL,
  risk_level      TEXT NOT NULL,
  verbatim_ok     INTEGER NOT NULL DEFAULT 0,
  valid_from      REAL,
  valid_until     REAL,
  revision        INTEGER NOT NULL DEFAULT 1,
  content_hash    TEXT NOT NULL,
  created_at      REAL NOT NULL,
  updated_at      REAL NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  title, content, kind,
  content='knowledge_items',
  content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS memory_items (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  conversation_key  TEXT NOT NULL,
  kind              TEXT NOT NULL,
  content           TEXT NOT NULL,
  source_type       TEXT NOT NULL,
  source_ref        TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL,
  valid_until       REAL,
  created_at        REAL NOT NULL,
  updated_at        REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS reply_examples (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  profile_id        TEXT,
  conversation_key  TEXT,
  intent            TEXT NOT NULL DEFAULT '',
  incoming_text     TEXT NOT NULL,
  outgoing_text     TEXT NOT NULL,
  source_ref        TEXT NOT NULL,
  quality           INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  created_at        REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_candidates (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  target_kind       TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  origin            TEXT NOT NULL,
  source_refs_json  TEXT NOT NULL,
  status            TEXT NOT NULL,
  created_at        REAL NOT NULL,
  decided_at        REAL
);

CREATE TABLE IF NOT EXISTS item_revisions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  item_type       TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  snapshot_json   TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  created_at      REAL NOT NULL,
  UNIQUE(item_type, item_id, revision)
);

CREATE TABLE IF NOT EXISTS reply_context_runs (
  job_id               TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL,
  conversation_key     TEXT NOT NULL,
  context_hash         TEXT NOT NULL,
  profile_id           TEXT,
  profile_revision     INTEGER,
  evidence_json        TEXT NOT NULL,
  retrieval_trace_json TEXT NOT NULL,
  model_audit_json     TEXT NOT NULL,
  gate_outcome         TEXT NOT NULL,
  gate_reason_code     TEXT NOT NULL DEFAULT '',
  created_at           REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_profiles_workspace ON communication_profiles(workspace_id);
CREATE INDEX IF NOT EXISTS idx_bindings_scope ON profile_bindings(workspace_id, scope_type, scope_key);
CREATE INDEX IF NOT EXISTS idx_knowledge_workspace ON knowledge_items(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_conversation ON memory_items(workspace_id, conversation_key, status);
CREATE INDEX IF NOT EXISTS idx_examples_profile ON reply_examples(workspace_id, profile_id, status);
CREATE INDEX IF NOT EXISTS idx_candidates_workspace ON knowledge_candidates(workspace_id, status);

-- Keep the FTS index in lockstep with knowledge_items (external-content FTS5 needs manual sync).
CREATE TRIGGER IF NOT EXISTS knowledge_items_ai AFTER INSERT ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(rowid, title, content, kind) VALUES (new.rowid, new.title, new.content, new.kind);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_items_ad AFTER DELETE ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, kind) VALUES('delete', old.rowid, old.title, old.content, old.kind);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_items_au AFTER UPDATE ON knowledge_items BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, kind) VALUES('delete', old.rowid, old.title, old.content, old.kind);
  INSERT INTO knowledge_fts(rowid, title, content, kind) VALUES (new.rowid, new.title, new.content, new.kind);
END;
`;

export function now() {
  return Date.now() / 1000;
}

/** ASCII-ish id: no punctuation surprises in URIs or logs. */
export function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

/** Enforce the length ceilings used across the spec; throws a typed error on overflow. */
export function text(value, max, {required = false, name = '内容'} = {}) {
  if (value === undefined || value === null) {
    if (required) throw Object.assign(new Error(`缺少${name}`), {code: 'CONTEXT_INVALID'});
    return '';
  }
  if (typeof value !== 'string') throw Object.assign(new Error(`${name}格式不正确`), {code: 'CONTEXT_INVALID'});
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (required && !cleaned) throw Object.assign(new Error(`缺少${name}`), {code: 'CONTEXT_INVALID'});
  if ([...cleaned].length > max) throw Object.assign(new Error(`${name}太长了，请精简到 ${max} 字以内`), {code: 'CONTEXT_INVALID'});
  return cleaned;
}

function optionalTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value) / 1000;
  if (!Number.isFinite(parsed)) throw Object.assign(new Error('时间格式不正确'), {code: 'CONTEXT_INVALID'});
  return parsed;
}

export class ReplyContextDatabase {
  constructor(path) {
    if (typeof path !== 'string' || !path) throw new Error('reply-context db path required');
    this.path = path;
    mkdirSync(dirname(path), {recursive: true});
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.#assertFts5();
  }

  /**
   * FTS5 must never degrade silently: an empty search must not look like "no knowledge"
   * (spec §11.1). The virtual table already fails to create if FTS5 is missing, but a
   * round-trip insert proves the index is live, not just declared.
   */
  #assertFts5() {
    try {
      this.db.exec("INSERT INTO knowledge_fts(rowid, title, content, kind) VALUES(-1, '', '', '')");
      this.db.exec('DELETE FROM knowledge_fts WHERE rowid = -1');
    } catch (error) {
      throw new Error('运行环境不支持 FTS5，无法建立知识检索索引: ' + error.message);
    }
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const result = fn(this.db);
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

// --- low-level helpers shared by the domain modules -------------------------

export function jsonField(value, fallback = {}) {
  if (value === undefined || value === null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

export { optionalTime };
