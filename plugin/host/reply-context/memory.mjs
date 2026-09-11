import {
  ReplyContextDatabase, MEMORY_STATES, now, newId, text, optionalTime,
} from './database.mjs';

/**
 * Relationship memory (spec §5.3). The CRM remains the contact master data; this module only
 * adds auditable memory items — facts, commitments, open loops, preferences and events — and
 * projects the CRM's stage / next step / note / open to-dos / recent follow-ups into context.
 *
 * A model-inferred memory is stored as `candidate` and never silently overwrites a confirmed
 * contact record (spec §5.3). Only `confirmed` items that are not resolved/expired enter the
 * automatic-reply context.
 */

export const MEMORY_KINDS = ['fact', 'commitment', 'open_loop', 'preference', 'event'];

export class Memory {
  constructor(db, crm) {
    this.db = db instanceof ReplyContextDatabase ? db : new ReplyContextDatabase(db);
    this.crm = crm;
  }

  #decorate(row) {
    return {
      id: row.id, workspaceId: row.workspace_id, conversationKey: row.conversation_key,
      kind: row.kind, content: row.content, sourceType: row.source_type, sourceRef: row.source_ref,
      status: row.status, validUntil: row.valid_until, createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  list(workspaceId, {conversationKey, kind, status} = {}) {
    const clauses = ['workspace_id = ?'];
    const params = [workspaceId];
    if (conversationKey) { clauses.push('conversation_key = ?'); params.push(conversationKey); }
    if (kind) { clauses.push('kind = ?'); params.push(kind); }
    if (status) { clauses.push('status = ?'); params.push(status); }
    return this.db.db.prepare(`SELECT * FROM memory_items WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC`)
      .all(...params).map(r => this.#decorate(r));
  }

  get(id, workspaceId) {
    const row = this.db.db.prepare('SELECT * FROM memory_items WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    return row ? this.#decorate(row) : null;
  }

  /** New memory. AI-inferred memories default to candidate; a human may confirm explicitly. */
  add(workspaceId, {conversationKey, kind, content, sourceType = 'manual', sourceRef = '', validUntil, status = 'candidate'}) {
    if (!MEMORY_KINDS.includes(kind)) throw Object.assign(new Error('记忆类型不正确'), {code: 'CONTEXT_INVALID'});
    if (!MEMORY_STATES.includes(status)) throw Object.assign(new Error('记忆状态不正确'), {code: 'CONTEXT_INVALID'});
    const at = now();
    const id = newId('mem');
    this.db.db.prepare(`INSERT INTO memory_items
      (id, workspace_id, conversation_key, kind, content, source_type, source_ref, status, valid_until, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, workspaceId, text(conversationKey, 120, {required: true, name: '会话'}),
        kind, text(content, 2000, {required: true, name: '内容'}),
        text(sourceType, 40) || 'manual', text(sourceRef, 200), status, optionalTime(validUntil), at, at);
    return this.get(id, workspaceId);
  }

  #setStatus(workspaceId, id, status) {
    const row = this.get(id, workspaceId);
    if (!row) throw Object.assign(new Error('没有这条记忆'), {code: 'CONTEXT_NOT_FOUND'});
    const at = now();
    this.db.db.prepare('UPDATE memory_items SET status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?').run(status, at, id, workspaceId);
    return this.get(id, workspaceId);
  }

  confirm(workspaceId, id) { return this.#setStatus(workspaceId, id, 'confirmed'); }
  resolve(workspaceId, id) { return this.#setStatus(workspaceId, id, 'resolved'); }

  /** Open loops + commitments that are confirmed and still live (not resolved/expired). */
  openLoops(workspaceId, conversationKey, at = now()) {
    return this.db.db.prepare(`SELECT * FROM memory_items WHERE workspace_id = ? AND conversation_key = ? AND status = 'confirmed'
      AND kind IN ('open_loop', 'commitment') AND (valid_until IS NULL OR valid_until > ?) ORDER BY created_at`)
      .all(workspaceId, conversationKey, at).map(r => this.#decorate(r));
  }

  /**
   * CRM projection for the context pack (spec §5.3): the contact's stage / next step / note,
   * open to-dos, and recent follow-ups. Read-only with respect to the CRM; memory items live
   * in the reply-context database, never duplicated into the contact master.
   */
  contactContext(conversationKey) {
    if (!this.crm) return {};
    const customer = this.crm.getCustomer(conversationKey) ?? null;
    if (!customer) return {};
    const todos = (this.crm.listTodos({conversationKey, state: 'open'}) ?? []).slice(0, 10).map(t => ({
      title: t.title, dueAt: t.dueAt, source: t.source
    }));
    const followups = (this.crm.listFollowups(conversationKey, 3) ?? []).map(f => ({kind: f.kind, note: f.note, createdAt: f.createdAt}));
    return {
      displayName: customer.identity?.title ?? '',
      stage: customer.stage ?? '',
      nextStep: customer.nextStep ?? '',
      note: customer.note ?? '',
      openTodos: todos,
      recentFollowups: followups
    };
  }
}
