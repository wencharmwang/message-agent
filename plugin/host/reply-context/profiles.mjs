import { createHash } from 'node:crypto';
import {
  ReplyContextDatabase, PROFILE_STATES, jsonField, now, newId, text,
} from './database.mjs';

/**
 * Communication Profiles (spec §5.1). A profile is a set of verifiable speaking rules and
 * approved examples, not a "专业、热情" one-liner. Every workspace may define several, bound
 * by conversation, contact/tag, scene, or as the workspace default (§5.1 binding order).
 *
 * rules_json shape:
 *   {
 *     addressRule: string,          // 称呼规则
 *     hard: string[],               // hard 禁用表达/强制规则
 *     preference: string[],         // soft 风格偏好
 *     bannedExpressions: string[],  // 禁用表达（会被 Gate 检查）
 *     styleNotes: string            // 句长/句数/标点/emoji 习惯
 *   }
 */

export const PROFILE_SCOPES = ['conversation', 'contact', 'tag', 'scene', 'default'];

function validateRules(rules) {
  const value = typeof rules === 'string' ? (() => { try { return JSON.parse(rules); } catch { throw Object.assign(new Error('说话规则不是合法的 JSON'), {code: 'CONTEXT_INVALID'}); } })() : rules;
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('说话规则必须是对象'), {code: 'CONTEXT_INVALID'});
  const out = {};
  for (const key of ['hard', 'preference', 'bannedExpressions']) {
    if (value[key] === undefined) continue;
    if (!Array.isArray(value[key]) || value[key].some(v => typeof v !== 'string')) {
      throw Object.assign(new Error(`说话规则里的 ${key} 必须是字符串数组`), {code: 'CONTEXT_INVALID'});
    }
    out[key] = value[key].map(v => text(v, 200, {name: '规则'})).filter(Boolean);
  }
  for (const key of ['addressRule', 'styleNotes']) {
    if (value[key] !== undefined) out[key] = text(value[key], 500);
  }
  return out;
}

export class Profiles {
  constructor(db) {
    this.db = db instanceof ReplyContextDatabase ? db : new ReplyContextDatabase(db);
  }

  #row(id, workspaceId) {
    const row = this.db.db.prepare('SELECT * FROM communication_profiles WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    return row ? this.#decorate(row) : null;
  }

  #decorate(row) {
    return {
      id: row.id, workspaceId: row.workspace_id, name: row.name,
      rules: jsonField(row.rules_json), priority: row.priority, status: row.status,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at
    };
  }

  list(workspaceId) {
    return this.db.db.prepare('SELECT * FROM communication_profiles WHERE workspace_id = ? ORDER BY priority DESC, name').all(workspaceId).map(r => this.#decorate(r));
  }

  get(id, workspaceId) {
    const row = this.db.db.prepare('SELECT * FROM communication_profiles WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    return row ? this.#decorate(row) : null;
  }

  /** Create or update a profile. Updates bump revision and require expectedRevision (spec §11.2). */
  create(workspaceId, {name, rules = {}, priority = 0}) {
    const cleaned = text(name, 60, {required: true, name: '名称'});
    const at = now();
    const id = newId('profile');
    const existing = this.db.db.prepare('SELECT id FROM communication_profiles WHERE workspace_id = ? AND name = ?').get(workspaceId, cleaned);
    if (existing) throw Object.assign(new Error('已经有同名说话方式'), {code: 'CONTEXT_CONFLICT'});
    this.db.transaction(tx => {
      tx.prepare(`INSERT INTO communication_profiles
        (id, workspace_id, name, rules_json, priority, status, revision, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', 1, ?, ?)`)
        .run(id, workspaceId, cleaned, JSON.stringify(validateRules(rules)),
          Math.max(0, Math.trunc(Number(priority) || 0)), at, at);
    });
    return this.#row(id, workspaceId);
  }

  update(workspaceId, id, {name, rules, priority, expectedRevision}) {
    const row = this.#row(id, workspaceId);
    if (!row) throw Object.assign(new Error('没有这个说话方式'), {code: 'CONTEXT_NOT_FOUND'});
    if (expectedRevision !== undefined && expectedRevision !== row.revision) {
      throw Object.assign(new Error('说话方式已被修改，请刷新后重试'), {code: 'CONTEXT_REVISION_CONFLICT', revision: row.revision});
    }
    const at = now();
    const nextName = name === undefined ? row.name : text(name, 60, {required: true, name: '名称'});
    const nextRules = rules === undefined ? row.rules : validateRules(rules);
    const nextPriority = priority === undefined ? row.priority : Math.max(0, Math.trunc(Number(priority) || 0));
    this.db.db.prepare(`UPDATE communication_profiles SET name = ?, rules_json = ?, priority = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(nextName, JSON.stringify(nextRules), nextPriority, at, id, workspaceId);
    return this.#row(id, workspaceId);
  }

  activate(workspaceId, id) {
    const row = this.#row(id, workspaceId);
    if (!row) throw Object.assign(new Error('没有这个说话方式'), {code: 'CONTEXT_NOT_FOUND'});
    const at = now();
    this.db.db.prepare(`UPDATE communication_profiles SET status = 'active', revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(at, id, workspaceId);
    return this.#row(id, workspaceId);
  }

  retire(workspaceId, id) {
    const row = this.#row(id, workspaceId);
    if (!row) throw Object.assign(new Error('没有这个说话方式'), {code: 'CONTEXT_NOT_FOUND'});
    const at = now();
    this.db.db.prepare(`UPDATE communication_profiles SET status = 'retired', revision = revision + 1, updated_at = ? WHERE id = ? AND workspace_id = ?`)
      .run(at, id, workspaceId);
    return this.#row(id, workspaceId);
  }

  // ---- bindings ------------------------------------------------------------

  bind(workspaceId, {profileId, scopeType, scopeKey, priority = 0}) {
    const profile = this.#row(profileId, workspaceId);
    if (!profile) throw Object.assign(new Error('绑定的说话方式不存在'), {code: 'CONTEXT_NOT_FOUND'});
    if (!PROFILE_SCOPES.includes(scopeType)) throw Object.assign(new Error('绑定范围不正确'), {code: 'CONTEXT_INVALID'});
    const key = text(scopeKey, 120, {required: true, name: '绑定对象'});
    const at = now();
    // One binding per scope+key; re-binding replaces it.
    const existing = this.db.db.prepare('SELECT id FROM profile_bindings WHERE workspace_id = ? AND scope_type = ? AND scope_key = ?').get(workspaceId, scopeType, key);
    if (existing) {
      this.db.db.prepare('UPDATE profile_bindings SET profile_id = ?, priority = ?, created_at = ? WHERE id = ?')
        .run(profileId, Math.max(0, Math.trunc(Number(priority) || 0)), at, existing.id);
      return this.#binding(existing.id, workspaceId);
    }
    const id = newId('binding');
    this.db.db.prepare(`INSERT INTO profile_bindings (id, workspace_id, profile_id, scope_type, scope_key, priority, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, workspaceId, profileId, scopeType, key, Math.max(0, Math.trunc(Number(priority) || 0)), at);
    return this.#binding(id, workspaceId);
  }

  #binding(id, workspaceId) {
    const row = this.db.db.prepare('SELECT * FROM profile_bindings WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
    return row ? {id: row.id, profileId: row.profile_id, scopeType: row.scope_type, scopeKey: row.scope_key, priority: row.priority} : null;
  }

  listBindings(workspaceId) {
    return this.db.db.prepare('SELECT * FROM profile_bindings WHERE workspace_id = ? ORDER BY priority DESC, created_at').all(workspaceId)
      .map(r => this.#binding(r.id, workspaceId));
  }

  /**
   * Select the active profile for this turn (§5.1 binding order):
   *   conversation > contact/tag > scene > workspace default.
   * Returns {profile, binding} or {profile: null}. A draft/retired profile is never selected.
   */
  select(workspaceId, {conversationKey, contactKey, tags = [], scene = null} = {}) {
    const candidates = this.#matchingBindings(workspaceId, {conversationKey, contactKey, tags, scene});
    for (const binding of candidates) {
      const profile = this.#row(binding.profile_id, workspaceId);
      if (profile && profile.status === 'active') return {profile, binding};
    }
    return {profile: null, binding: null};
  }

  #matchingBindings(workspaceId, {conversationKey, contactKey, tags, scene}) {
    const all = this.db.db.prepare('SELECT * FROM profile_bindings WHERE workspace_id = ? ORDER BY priority DESC, created_at').all(workspaceId);
    const tiers = []; // [tierRank, binding]
    for (const b of all) {
      if (b.scope_type === 'conversation' && conversationKey && b.scope_key === conversationKey) tiers.push([0, b]);
      else if (b.scope_type === 'contact' && contactKey && b.scope_key === contactKey) tiers.push([1, b]);
      else if (b.scope_type === 'tag' && tags.includes(b.scope_key)) tiers.push([1, b]);
      else if (b.scope_type === 'scene' && scene && b.scope_key === scene) tiers.push([2, b]);
      else if (b.scope_type === 'default') tiers.push([3, b]);
    }
    tiers.sort((a, b) => a[0] - b[0] || b[1].priority - a[1].priority);
    return tiers.map(([, b]) => b);
  }

  /** Default workspace profile helper: the single 'default'-scoped active profile, if any. */
  defaultProfile(workspaceId) {
    const selected = this.select(workspaceId, {});
    return selected.profile;
  }
}

export function rulesHash(rules) {
  return createHash('sha256').update(JSON.stringify(rules)).digest('hex');
}
