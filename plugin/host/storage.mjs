import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Atomic JSON document store: temp-write + rename, the same durability pattern as conversation-sessions. */
export class JsonStore {
  constructor(path, initial) {
    this.path = path;
    try { this.data = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.data = initial; }
  }
  save() {
    mkdirSync(dirname(this.path), {recursive: true});
    const temp = this.path + '.tmp';
    writeFileSync(temp, JSON.stringify(this.data, null, 2), 'utf8');
    renameSync(temp, this.path);
  }
}

export const DRAFT_TTL_SECONDS = 30 * 60;

/**
 * Manual reply drafts owned by the Host (architecture §6); the Worker never writes these.
 * States: awaiting_confirmation → cancelled | expired. submitting/sent/uncertain arrive
 * only with the stage-1.4 send link, and delivery facts always stay in Runtime receipts
 * (matched by requestId) — a draft never becomes its own "sent" fact.
 */
export class Drafts {
  constructor(path) {
    this.store = new JsonStore(path, {drafts: {}});
  }
  #all(now) {
    let changed = false;
    for (const draft of Object.values(this.store.data.drafts)) {
      if (draft.state === 'awaiting_confirmation' && draft.expiresAt <= now) { draft.state = 'expired'; changed = true; }
    }
    if (changed) this.store.save();
    return Object.values(this.store.data.drafts);
  }
  list({provider, conversation} = {}, now = Date.now() / 1000) {
    return this.#all(now)
      .filter(d => !provider || (d.target.provider === provider && d.target.conversation === conversation))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id, now = Date.now() / 1000) {
    const draft = this.#all(now).find(d => d.id === id);
    if (!draft) throw Object.assign(new Error('草稿不存在'), {code: 'DRAFT_NOT_FOUND'});
    return draft;
  }
  create({target, text, source}, now = Date.now() / 1000) {
    const draft = {
      id: randomUUID(), revision: 1, target, text, source: source ?? null,
      state: 'awaiting_confirmation', createdAt: now, updatedAt: now,
      expiresAt: now + DRAFT_TTL_SECONDS, requestId: null, receipt: null, detail: ''
    };
    this.store.data.drafts[draft.id] = draft;
    this.store.save();
    return draft;
  }
  #mutable(id, expectedRevision, now) {
    const draft = this.get(id, now);
    if (draft.state !== 'awaiting_confirmation') {
      throw Object.assign(new Error('草稿已' + (draft.state === 'cancelled' ? '取消' : '过期') + '，不能修改'),
        {code: 'DRAFT_CLOSED', state: draft.state});
    }
    if (draft.revision !== expectedRevision) {
      throw Object.assign(new Error('草稿版本已变化，请刷新后重试'), {code: 'DRAFT_REVISION_CONFLICT', revision: draft.revision});
    }
    return draft;
  }
  revise(id, expectedRevision, text, now = Date.now() / 1000) {
    const draft = this.#mutable(id, expectedRevision, now);
    draft.revision += 1;
    draft.text = text;
    draft.updatedAt = now;
    // A new version withdraws any prior confirmation and restarts the review window.
    draft.expiresAt = now + DRAFT_TTL_SECONDS;
    this.store.save();
    return draft;
  }
  cancel(id, now = Date.now() / 1000) {
    const draft = this.get(id, now);
    // Cancelling an already-closed draft is a no-op so double clicks stay safe.
    if (draft.state !== 'awaiting_confirmation') return draft;
    draft.state = 'cancelled';
    draft.updatedAt = now;
    this.store.save();
    return draft;
  }
  /**
   * Claim the send for this exact version. The draft moves to `sending` and gets a fresh
   * requestId; a second confirm either passes #mutable (only awaiting_confirmation can) or
   * raises, so the same draft can never be submitted twice.
   */
  submit(id, expectedRevision, now = Date.now() / 1000) {
    const draft = this.#mutable(id, expectedRevision, now);
    draft.state = 'sending';
    draft.requestId = randomUUID();
    draft.updatedAt = now;
    this.store.save();
    return draft;
  }
  /**
   * Record the Runtime outcome. `receipt` is the authoritative delivery fact; the draft
   * never becomes its own "sent" claim — it only mirrors what Runtime reported.
   */
  settle(id, state, {receipt = null, detail = ''} = {}, now = Date.now() / 1000) {
    const draft = this.get(id, now);
    draft.state = state;
    draft.receipt = receipt;
    draft.detail = detail;
    draft.updatedAt = now;
    this.store.save();
    return draft;
  }
}

/** Read the session-binding file owned by ConversationSessions without taking over its writes. */
export function readBindings(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return {}; }
}

/** Bounded single-line reply text, aligned with the automatic-reply policy limits. */
export function validateDraftText(text, maxChars) {
  if (typeof text !== 'string' || !text.trim() || [...text].length > maxChars || /[\x00-\x1f\x7f]/.test(text)) {
    throw Object.assign(new Error('回复正文必须是 ' + maxChars + ' 字以内的单行文本'), {code: 'DRAFT_INVALID_TEXT'});
  }
  if (/\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)) {
    throw Object.assign(new Error('不要在回复中包含凭据'), {code: 'DRAFT_INVALID_TEXT'});
  }
  return text;
}
