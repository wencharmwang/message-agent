import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/**
 * Local follow-up CRM (architecture §8). Small on purpose: a contact record, the
 * follow-up notes you actually wrote down, and the to-dos you promised to do.
 * Stored in its own SQLite file so the Worker's reply.db keeps owning automatic
 * reply state; nothing here is written by the Worker.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS customers (
  conversation_key TEXT PRIMARY KEY,
  provider         TEXT NOT NULL,
  conversation     TEXT NOT NULL,
  display_name     TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT 'direct',
  stage            TEXT NOT NULL DEFAULT '',
  next_step        TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT '',
  created_at       REAL NOT NULL,
  updated_at       REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS todos (
  id               TEXT PRIMARY KEY,
  conversation_key TEXT,
  title            TEXT NOT NULL,
  detail           TEXT NOT NULL DEFAULT '',
  evidence         TEXT NOT NULL DEFAULT '',
  source           TEXT NOT NULL DEFAULT 'manual',
  due_at           REAL,
  state            TEXT NOT NULL DEFAULT 'open',
  created_at       REAL NOT NULL,
  updated_at       REAL NOT NULL,
  done_at          REAL
);
CREATE TABLE IF NOT EXISTS followups (
  id               TEXT PRIMARY KEY,
  conversation_key TEXT NOT NULL,
  kind             TEXT NOT NULL DEFAULT '记录',
  note             TEXT NOT NULL,
  evidence         TEXT NOT NULL DEFAULT '',
  created_at       REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_todos_state ON todos(state, due_at);
CREATE INDEX IF NOT EXISTS idx_todos_conversation ON todos(conversation_key, state);
CREATE INDEX IF NOT EXISTS idx_followups_conversation ON followups(conversation_key, created_at);
`;

export const TODO_STATES = ['open', 'done'];

function now() {
  return Date.now() / 1000;
}
function text(value, max, {required = false} = {}) {
  if (value === undefined || value === null) {
    if (required) throw Object.assign(new Error('缺少必填内容'), {code: 'CRM_INVALID'});
    return '';
  }
  if (typeof value !== 'string') throw Object.assign(new Error('内容格式不正确'), {code: 'CRM_INVALID'});
  const cleaned = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  if (required && !cleaned) throw Object.assign(new Error('缺少必填内容'), {code: 'CRM_INVALID'});
  if ([...cleaned].length > max) throw Object.assign(new Error('内容太长了，请精简到 ' + max + ' 字以内'), {code: 'CRM_INVALID'});
  return cleaned;
}
function optionalTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Date.parse(value) / 1000;
  if (!Number.isFinite(parsed)) throw Object.assign(new Error('时间格式不正确'), {code: 'CRM_INVALID'});
  return parsed;
}

export class Crm {
  constructor(path) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  // ---- customers -----------------------------------------------------------

  /** Upsert the contact record; user-written fields are never overwritten by a rename. */
  ensureCustomer({key, provider, conversation, displayName, kind}) {
    const at = now();
    const existing = this.db.prepare('SELECT * FROM customers WHERE conversation_key = ?').get(key);
    if (!existing) {
      this.db.prepare(`INSERT INTO customers
        (conversation_key, provider, conversation, display_name, kind, stage, next_step, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, '', '', '', ?, ?)`)
        .run(key, text(provider, 60, {required: true}), text(conversation, 200, {required: true}),
          text(displayName, 200, {required: true}), text(kind, 20) || 'direct', at, at);
    } else if (displayName && existing.display_name !== displayName) {
      // Display names change in WeChat (remarks, group renames). Keep the record, follow the name.
      this.db.prepare('UPDATE customers SET display_name = ?, updated_at = ? WHERE conversation_key = ?')
        .run(text(displayName, 200), at, key);
    }
    return this.getCustomer(key);
  }

  #customerRow(key) {
    return this.db.prepare('SELECT * FROM customers WHERE conversation_key = ?').get(key) ?? null;
  }

  #decorate(row) {
    if (!row) return null;
    const stats = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM todos WHERE conversation_key = ? AND state = 'open') AS open_todos,
        (SELECT COUNT(*) FROM followups WHERE conversation_key = ?) AS followup_count,
        (SELECT MAX(created_at) FROM followups WHERE conversation_key = ?) AS last_followup_at`)
      .get(row.conversation_key, row.conversation_key, row.conversation_key);
    return {
      key: row.conversation_key,
      identity: {provider: row.provider, conversation: row.conversation, title: row.display_name, kind: row.kind},
      stage: row.stage,
      nextStep: row.next_step,
      note: row.note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      openTodos: stats.open_todos,
      followupCount: stats.followup_count,
      lastFollowupAt: stats.last_followup_at
    };
  }

  getCustomer(key) {
    return this.#decorate(this.#customerRow(key));
  }

  /**
   * Re-point the contact at a new conversation id when OCR read its name differently and
   * the id (a hash of the name) changed. Keeps todos/follow-ups attached to the person
   * instead of orphaning them under the stale id. No-op when there is no such customer.
   */
  rekey(oldKey, newKey, {provider, conversation, displayName, kind} = {}) {
    const existing = this.#customerRow(oldKey);
    if (!existing) return false;
    this.db.prepare('UPDATE todos SET conversation_key = ? WHERE conversation_key = ?').run(newKey, oldKey);
    this.db.prepare('UPDATE followups SET conversation_key = ? WHERE conversation_key = ?').run(newKey, oldKey);
    this.db.prepare(`UPDATE customers SET conversation_key = ?, provider = ?, conversation = ?, display_name = ?, kind = ?, updated_at = ?
      WHERE conversation_key = ?`)
      .run(newKey,
        provider ? text(provider, 60) : existing.provider,
        conversation ? text(conversation, 200) : existing.conversation,
        displayName ? text(displayName, 200) : existing.display_name,
        kind ? text(kind, 20) : existing.kind,
        now(), oldKey);
    return true;
  }

  listCustomers() {
    const rows = this.db.prepare(`SELECT * FROM customers ORDER BY
      (SELECT MAX(created_at) FROM followups WHERE conversation_key = customers.conversation_key) IS NULL,
      (SELECT MAX(created_at) FROM followups WHERE conversation_key = customers.conversation_key) DESC,
      updated_at DESC`).all();
    return rows.map(row => this.#decorate(row));
  }

  updateCustomer(key, patch = {}) {
    const row = this.#customerRow(key);
    if (!row) throw Object.assign(new Error('还没有这个联系人的资料'), {code: 'CRM_NOT_FOUND'});
    this.db.prepare('UPDATE customers SET stage = ?, next_step = ?, note = ?, updated_at = ? WHERE conversation_key = ?')
      .run(patch.stage === undefined ? row.stage : text(patch.stage, 60),
        patch.nextStep === undefined ? row.next_step : text(patch.nextStep, 200),
        patch.note === undefined ? row.note : text(patch.note, 2000),
        now(), key);
    return this.getCustomer(key);
  }

  /**
   * Remove the contact together with everything recorded under it. The follow-ups and
   * to-dos only exist because of this contact, so leaving them behind would be an orphan
   * list nobody can act on. Automatic-reply rules live in the Worker's database and are
   * deliberately untouched.
   */
  deleteCustomer(key) {
    if (!this.#customerRow(key)) throw Object.assign(new Error('还没有这个联系人的资料'), {code: 'CRM_NOT_FOUND'});
    this.db.prepare('DELETE FROM todos WHERE conversation_key = ?').run(key);
    this.db.prepare('DELETE FROM followups WHERE conversation_key = ?').run(key);
    this.db.prepare('DELETE FROM customers WHERE conversation_key = ?').run(key);
    return true;
  }

  // ---- follow-ups ----------------------------------------------------------

  addFollowup(key, {kind, note, evidence} = {}) {
    if (!this.#customerRow(key)) throw Object.assign(new Error('还没有这个联系人的资料'), {code: 'CRM_NOT_FOUND'});
    const row = {
      id: randomUUID(), conversation_key: key, kind: text(kind, 20) || '记录',
      note: text(note, 2000, {required: true}), evidence: text(evidence, 500), created_at: now()
    };
    this.db.prepare('INSERT INTO followups (id, conversation_key, kind, note, evidence, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.conversation_key, row.kind, row.note, row.evidence, row.created_at);
    this.db.prepare('UPDATE customers SET updated_at = ? WHERE conversation_key = ?').run(row.created_at, key);
    return {id: row.id, kind: row.kind, note: row.note, evidence: row.evidence, createdAt: row.created_at};
  }

  listFollowups(key, limit = 50) {
    return this.db.prepare('SELECT * FROM followups WHERE conversation_key = ? ORDER BY created_at DESC LIMIT ?')
      .all(key, Math.min(Math.max(limit, 1), 200))
      .map(row => ({id: row.id, kind: row.kind, note: row.note, evidence: row.evidence, createdAt: row.created_at}));
  }

  deleteFollowup(key, id) {
    this.db.prepare('DELETE FROM followups WHERE id = ? AND conversation_key = ?').run(id, key);
    return {deleted: true};
  }

  // ---- to-dos --------------------------------------------------------------

  createTodo({conversationKey, title, detail, evidence, source, dueAt} = {}) {
    const key = conversationKey ? String(conversationKey) : null;
    if (key && !this.#customerRow(key)) throw Object.assign(new Error('还没有这个联系人的资料'), {code: 'CRM_NOT_FOUND'});
    const at = now();
    const row = {
      id: randomUUID(), conversation_key: key,
      title: text(title, 200, {required: true}), detail: text(detail, 1000), evidence: text(evidence, 500),
      source: text(source, 20) || 'manual', due_at: optionalTime(dueAt), state: 'open',
      created_at: at, updated_at: at, done_at: null
    };
    this.db.prepare(`INSERT INTO todos
        (id, conversation_key, title, detail, evidence, source, due_at, state, created_at, updated_at, done_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(row.id, row.conversation_key, row.title, row.detail, row.evidence, row.source, row.due_at, row.state,
        row.created_at, row.updated_at, row.done_at);
    return this.#todo(row.id);
  }

  #todo(id) {
    const row = this.db.prepare('SELECT * FROM todos WHERE id = ?').get(id);
    if (!row) return null;
    const customer = row.conversation_key ? this.#customerRow(row.conversation_key) : null;
    return {
      id: row.id,
      conversationKey: row.conversation_key,
      title: row.title,
      detail: row.detail,
      evidence: row.evidence,
      source: row.source,
      dueAt: row.due_at,
      state: row.state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      doneAt: row.done_at,
      identity: customer
        ? {provider: customer.provider, conversation: customer.conversation, title: customer.display_name, kind: customer.kind}
        : null
    };
  }

  getTodo(id) {
    const row = this.#todo(id);
    if (!row) throw Object.assign(new Error('这条待办不存在'), {code: 'CRM_NOT_FOUND'});
    return row;
  }

  listTodos({state, conversationKey, limit = 200} = {}) {
    const clauses = [];
    const params = [];
    if (state) { clauses.push('state = ?'); params.push(state); }
    if (conversationKey) { clauses.push('conversation_key = ?'); params.push(conversationKey); }
    const where = clauses.length ? ' WHERE ' + clauses.join(' AND ') : '';
    params.push(Math.min(Math.max(limit, 1), 500));
    return this.db.prepare('SELECT id FROM todos' + where + ' ORDER BY (due_at IS NULL), due_at, created_at DESC LIMIT ?')
      .all(...params).map(row => this.#todo(row.id)).filter(Boolean);
  }

  updateTodo(id, patch = {}) {
    const row = this.getTodo(id);
    const at = now();
    this.db.prepare('UPDATE todos SET title = ?, detail = ?, due_at = ?, updated_at = ? WHERE id = ?')
      .run(patch.title === undefined ? row.title : text(patch.title, 200, {required: true}),
        patch.detail === undefined ? row.detail : text(patch.detail, 1000),
        patch.dueAt === undefined ? row.dueAt : optionalTime(patch.dueAt),
        at, id);
    return this.getTodo(id);
  }

  setTodoState(id, state, dueAt) {
    const row = this.getTodo(id);
    const at = now();
    if (state === 'open') {
      this.db.prepare('UPDATE todos SET state = ?, done_at = NULL, due_at = ?, updated_at = ? WHERE id = ?')
        .run('open', dueAt === undefined ? row.dueAt : optionalTime(dueAt), at, id);
    } else {
      this.db.prepare('UPDATE todos SET state = ?, done_at = ?, updated_at = ? WHERE id = ?').run('done', at, at, id);
    }
    return this.getTodo(id);
  }

  deleteTodo(id) {
    this.db.prepare('DELETE FROM todos WHERE id = ?').run(id);
    return {deleted: true};
  }

  /** Open to-dos bucketed for the "今天要做的" page: overdue first, then dated, then undated. */
  todoBuckets(at = now()) {
    const dayEnd = new Date(at * 1000);
    dayEnd.setHours(23, 59, 59, 999);
    const open = this.listTodos({state: 'open'});
    const buckets = {overdue: [], today: [], later: [], someday: []};
    for (const todo of open) {
      if (todo.dueAt === null) buckets.someday.push(todo);
      else if (todo.dueAt < at) buckets.overdue.push(todo);
      else if (todo.dueAt <= dayEnd.getTime() / 1000) buckets.today.push(todo);
      else buckets.later.push(todo);
    }
    return buckets;
  }

  counts(at = now()) {
    const buckets = this.todoBuckets(at);
    return {open: buckets.overdue.length + buckets.today.length + buckets.later.length + buckets.someday.length,
      overdue: buckets.overdue.length, dueToday: buckets.today.length};
  }
}

export function createCrm(path) {
  if (typeof path !== 'string' || !path) throw new Error('crm path required');
  return new Crm(path);
}
