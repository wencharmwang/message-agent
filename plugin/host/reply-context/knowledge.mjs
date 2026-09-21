import { createHash } from 'node:crypto';
import {
  ReplyContextDatabase, KNOWLEDGE_STATES, RISK_LEVELS, jsonField, now, newId, text, optionalTime,
} from './database.mjs';

/**
 * Static knowledge (spec §5.2). Product usage, specs, FAQ, published policies, standard
 * flows and compliance statements. Every item has a status (draft/published/retired), a
 * revision, a validity window, scope metadata, a risk level and a verbatim-send flag. Only
 * published-and-currently-valid items enter the automatic-reply context (spec §5.2).
 *
 * Revision snapshots land in item_revisions so a publish/retire/rollback chain is auditable
 * and reversible without trusting the in-place row (spec §11.2).
 */

const KIND_MAX = 40;
const TITLE_MAX = 200;
const CONTENT_MAX = 20000;

function contentHash(content) {
  return createHash('sha256').update(content).digest('hex');
}

function validateMeta(meta) {
  if (meta === undefined || meta === null) return {};
  if (typeof meta !== 'object' || Array.isArray(meta)) throw Object.assign(new Error('适用范围必须是对象'), {code: 'CONTEXT_INVALID'});
  return meta;
}

export class Knowledge {
  constructor(db) {
    this.db = db instanceof ReplyContextDatabase ? db : new ReplyContextDatabase(db);
  }

  #decorate(row) {
    return {
      id: row.id, workspaceId: row.workspace_id, kind: row.kind, title: row.title,
      content: row.content, metadata: jsonField(row.metadata_json), sourceType: row.source_type,
      sourceRef: row.source_ref, status: row.status, riskLevel: row.risk_level,
      verbatimOk: !!row.verbatim_ok, validFrom: row.valid_from, validUntil: row.valid_until,
      revision: row.revision, contentHash: row.content_hash, createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  get(id, workspaceId) {
    const row = this.db.db.prepare('SELECT * FROM knowledge_items WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    return row ? this.#decorate(row) : null;
  }

  list(workspaceId, {status} = {}) {
    const base = 'SELECT * FROM knowledge_items WHERE workspace_id = ?';
    const rows = status
      ? this.db.db.prepare(base + ' AND status = ? ORDER BY updated_at DESC').all(workspaceId, status)
      : this.db.db.prepare(base + ' ORDER BY updated_at DESC').all(workspaceId);
    return rows.map(r => this.#decorate(r));
  }

  #snapshot(tx, item) {
    tx.prepare(`INSERT OR REPLACE INTO item_revisions (id, workspace_id, item_type, item_id, revision, snapshot_json, content_hash, created_at)
      VALUES (?, ?, 'knowledge', ?, ?, ?, ?, ?)`)
      .run(newId('rev'), item.workspaceId, item.id, item.revision, JSON.stringify(item), item.contentHash, now());
  }

  create(workspaceId, {kind, title, content, metadata = {}, sourceType = 'manual', sourceRef = '', riskLevel = 'low', verbatimOk = false, validFrom, validUntil}) {
    const cleaned = {
      kind: text(kind, KIND_MAX, {required: true, name: '类型'}),
      title: text(title, TITLE_MAX, {required: true, name: '标题'}),
      content: text(content, CONTENT_MAX, {required: true, name: '正文'}),
      metadata: validateMeta(metadata),
      sourceType: text(sourceType, 40, {name: '来源类型'}) || 'manual',
      sourceRef: text(sourceRef, 200),
      riskLevel: RISK_LEVELS.includes(riskLevel) ? riskLevel : 'low',
      verbatimOk: verbatimOk ? 1 : 0,
      validFrom: optionalTime(validFrom),
      validUntil: optionalTime(validUntil)
    };
    const at = now();
    const id = newId('kb');
    const hash = contentHash(cleaned.content);
    this.db.transaction(tx => {
      tx.prepare(`INSERT INTO knowledge_items
        (id, workspace_id, kind, title, content, metadata_json, source_type, source_ref, status, risk_level, verbatim_ok, valid_from, valid_until, revision, content_hash, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 1, ?, ?, ?)`)
        .run(id, workspaceId, cleaned.kind, cleaned.title, cleaned.content, JSON.stringify(cleaned.metadata),
          cleaned.sourceType, cleaned.sourceRef, cleaned.riskLevel, cleaned.verbatimOk,
          cleaned.validFrom, cleaned.validUntil, hash, at, at);
    });
    return this.get(id, workspaceId);
  }

  update(workspaceId, id, patch, {expectedRevision} = {}) {
    const row = this.get(id, workspaceId);
    if (!row) throw Object.assign(new Error('没有这条知识'), {code: 'CONTEXT_NOT_FOUND'});
    if (expectedRevision !== undefined && expectedRevision !== row.revision) {
      throw Object.assign(new Error('知识已被修改，请刷新后重试'), {code: 'CONTEXT_REVISION_CONFLICT', revision: row.revision});
    }
    const next = {
      kind: patch.kind === undefined ? row.kind : text(patch.kind, KIND_MAX, {required: true, name: '类型'}),
      title: patch.title === undefined ? row.title : text(patch.title, TITLE_MAX, {required: true, name: '标题'}),
      content: patch.content === undefined ? row.content : text(patch.content, CONTENT_MAX, {required: true, name: '正文'}),
      metadata: patch.metadata === undefined ? row.metadata : validateMeta(patch.metadata),
      sourceType: patch.sourceType === undefined ? row.sourceType : (text(patch.sourceType, 40) || 'manual'),
      sourceRef: patch.sourceRef === undefined ? row.sourceRef : text(patch.sourceRef, 200),
      riskLevel: patch.riskLevel === undefined ? row.riskLevel : (RISK_LEVELS.includes(patch.riskLevel) ? patch.riskLevel : 'low'),
      verbatimOk: patch.verbatimOk === undefined ? (row.verbatimOk ? 1 : 0) : (patch.verbatimOk ? 1 : 0),
      validFrom: patch.validFrom === undefined ? row.validFrom : optionalTime(patch.validFrom),
      validUntil: patch.validUntil === undefined ? row.validUntil : optionalTime(patch.validUntil)
    };
    const at = now();
    const hash = contentHash(next.content);
    this.db.transaction(tx => {
      tx.prepare(`UPDATE knowledge_items SET kind=?, title=?, content=?, metadata_json=?, source_type=?, source_ref=?,
        risk_level=?, verbatim_ok=?, valid_from=?, valid_until=?, revision=revision+1, content_hash=?, updated_at=?
        WHERE id=? AND workspace_id=?`)
        .run(next.kind, next.title, next.content, JSON.stringify(next.metadata), next.sourceType, next.sourceRef,
          next.riskLevel, next.verbatimOk, next.validFrom, next.validUntil, hash, at, id, workspaceId);
    });
    const updated = this.get(id, workspaceId);
    this.db.transaction(tx => this.#snapshot(tx, updated));
    return updated;
  }

  #setStatus(workspaceId, id, status) {
    const row = this.get(id, workspaceId);
    if (!row) throw Object.assign(new Error('没有这条知识'), {code: 'CONTEXT_NOT_FOUND'});
    const at = now();
    this.db.db.prepare('UPDATE knowledge_items SET status = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .run(status, at, id, workspaceId);
    return this.get(id, workspaceId);
  }

  publish(workspaceId, id) {
    const before = this.get(id, workspaceId);
    if (!before) throw Object.assign(new Error('没有这条知识'), {code: 'CONTEXT_NOT_FOUND'});
    const after = this.#setStatus(workspaceId, id, 'published');
    this.db.transaction(tx => this.#snapshot(tx, after));
    return after;
  }

  retire(workspaceId, id) {
    const before = this.get(id, workspaceId);
    if (!before) throw Object.assign(new Error('没有这条知识'), {code: 'CONTEXT_NOT_FOUND'});
    const after = this.#setStatus(workspaceId, id, 'retired');
    this.db.transaction(tx => this.#snapshot(tx, after));
    return after;
  }

  /**
   * 真删除（用户要求：不用的可以删掉）。
   *
   * 与 retire 的区别：retire 是"停用但留档"，这条是**从库里去掉**。
   * 连带删掉它的历史修订 —— 否则 revision 表会留下查不到的孤儿行。
   * FTS 由触发器跟着清（database.mjs 里挂了 delete trigger）。
   */
  remove(workspaceId, id) {
    const before = this.get(id, workspaceId);
    if (!before) throw Object.assign(new Error('没有这条知识'), {code: 'CONTEXT_NOT_FOUND'});
    this.db.transaction(tx => {
      tx.prepare('DELETE FROM item_revisions WHERE workspace_id = ? AND item_type = ? AND item_id = ?')
        .run(workspaceId, 'knowledge', id);
      tx.prepare('DELETE FROM knowledge_items WHERE id = ? AND workspace_id = ?').run(id, workspaceId);
    });
    return before;
  }

  /** Restore the previous revision snapshot as the current content (a new revision). */
  rollback(workspaceId, id, {toRevision} = {}) {
    const row = this.get(id, workspaceId);
    if (!row) throw Object.assign(new Error('没有这条知识'), {code: 'CONTEXT_NOT_FOUND'});
    const snapshots = this.db.db.prepare(
      "SELECT * FROM item_revisions WHERE item_type='knowledge' AND item_id = ? AND workspace_id = ? ORDER BY revision DESC").all(id, workspaceId);
    const targetRev = toRevision ?? (snapshots.find(s => s.revision < row.revision)?.revision);
    const snapshot = snapshots.find(s => s.revision === targetRev);
    if (!snapshot) throw Object.assign(new Error('没有可回退的历史版本'), {code: 'CONTEXT_NOT_FOUND'});
    const prev = jsonField(snapshot.snapshot_json);
    const at = now();
    this.db.db.prepare(`UPDATE knowledge_items SET title=?, content=?, metadata_json=?, kind=?, risk_level=?, verbatim_ok=?,
      valid_from=?, valid_until=?, source_type=?, source_ref=?, status='draft', revision=revision+1, content_hash=?, updated_at=?
      WHERE id=? AND workspace_id=?`)
      .run(prev.title, prev.content, JSON.stringify(prev.metadata ?? {}), prev.kind, prev.riskLevel, prev.verbatimOk ? 1 : 0,
        prev.validFrom ?? null, prev.validUntil ?? null, prev.sourceType, prev.sourceRef ?? '', prev.contentHash, at, id, workspaceId);
    return this.get(id, workspaceId);
  }

  /** Currently-published-and-valid items, used as the only knowledge source for context. */
  active(workspaceId, at = now()) {
    return this.db.db.prepare(`SELECT * FROM knowledge_items WHERE workspace_id = ? AND status = 'published'
      AND (valid_from IS NULL OR valid_from <= ?) AND (valid_until IS NULL OR valid_until > ?) ORDER BY updated_at DESC`)
      .all(workspaceId, at, at).map(r => this.#decorate(r));
  }

  /**
   * Keyword retrieval over active items (spec §8). FTS5 MATCH first; for CJK queries the
   * unicode61 tokenizer's per-character tokens make a phrase match too strict, so a token
   * overlap (CJK bigrams + latin words) over the same active set is the deterministic fallback
   * — still scope- and validity-filtered. Never returns an empty result for a supported FTS.
   */
  search(workspaceId, query, {limit = 10, kinds = null} = {}) {
    const cleaned = text(query, 200, {name: '检索词'});
    if (!cleaned) return [];
    const active = this.active(workspaceId);
    if (!active.length) return [];

    const results = [];
    const seen = new Set();
    const collect = items => {
      for (const item of items) {
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        results.push(item);
        if (results.length >= limit) return;
      }
    };

    // 1) FTS5 MATCH over the external-content index.
    const safe = cleaned.replace(/["'*():\^]/g, ' ').trim().split(/\s+/).map(t => `"${t}"`).join(' ');
    if (safe) {
      try {
        const ftsRows = this.db.db.prepare(`SELECT k.* FROM knowledge_fts f JOIN knowledge_items k ON k.rowid = f.rowid
          WHERE knowledge_fts MATCH ? ORDER BY bm25(f) LIMIT 50`).all(safe);
        const filtered = kinds ? ftsRows.filter(r => kinds.includes(r.kind)) : ftsRows;
        collect(filtered.map(r => this.#decorate(r)));
      } catch { /* malformed match — fall through to token overlap */ }
    }

    // 2) Token-overlap fallback over active items: CJK bigrams + latin words, ranked by hits.
    if (results.length < limit) {
      const tokens = tokenize(cleaned);
      const scored = active
        .filter(item => !seen.has(item.id) && (!kinds || kinds.includes(item.kind)))
        .map(item => {
          const hay = `${item.title} ${item.kind} ${item.content}`.toLowerCase();
          let score = 0;
          for (const t of tokens) if (hay.includes(t)) score += 1;
          return {item, score};
        })
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);
      collect(scored.map(s => s.item));
    }
    return results;
  }
}

/** CJK bigrams + latin/digit words, used to match a query against short titles. */
function tokenize(query) {
  const chunks = String(query).replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter(Boolean);
  const tokens = new Set();
  for (const chunk of chunks) {
    if (/[\u4e00-\u9fff]/.test(chunk)) {
      for (let i = 0; i + 1 < chunk.length; i++) tokens.add(chunk.slice(i, i + 2).toLowerCase());
    } else {
      tokens.add(chunk.toLowerCase());
    }
  }
  return [...tokens].slice(0, 24);
}
