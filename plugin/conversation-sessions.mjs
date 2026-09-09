import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export function automaticRequestConfig(proposed, settings) {
  return {...proposed,maxTokens:settings.max_tokens,
    reasoningEffort:settings.auto_reasoning_effort ?? 'low'};
}

export function conversationKey(rule, job) {
  const {provider, conversation} = job;
  if (![provider, conversation].every(v => typeof v === 'string' && v.length > 0)
      || (rule.provider && rule.provider !== provider) || (rule.conversation && rule.conversation !== conversation)) {
    throw new Error('Invalid conversation identity');
  }
  return createHash('sha256').update(JSON.stringify([provider, conversation])).digest('hex');
}

/** Persist the selected native session, including migration from event-based sessions. */
export class ConversationSessions {
  constructor(path) {
    this.path = path;
    try { this.entries = JSON.parse(readFileSync(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.entries = {}; }
    this.busy = new Set();
  }
  async run(key, action) {
    // A duplicate delivery must not be queued behind a timed-out task and reply later.
    if (this.busy.has(key)) throw new Error('Conversation task already active');
    this.busy.add(key);
    try { return await action(); } finally { this.busy.delete(key); }
  }
  async select(key, legacyIds, exists) {
    if (this.entries[key]) return this.entries[key];
    const stable = 'messaging-conversation-' + key;
    if (await exists(stable)) return stable;
    for (const id of legacyIds ?? []) {
      if (/^messaging-[a-zA-Z0-9-]{1,80}$/.test(id) && await exists(id)) return id;
    }
    return stable;
  }
  bind(key, id) {
    const next = {...this.entries, [key]: id};
    mkdirSync(dirname(this.path), {recursive:true});
    const temp = this.path + '.tmp';
    writeFileSync(temp, JSON.stringify(next, null, 2), 'utf8');
    renameSync(temp, this.path);
    this.entries = next;
  }
}

export function completedDecision(events, messageId) {
  // Harness injects its sandbox/system policy as plugin-sourced user messages.
  // These are context, while another user/webhook delivery invalidates this job.
  const users = events.filter(e => e.type === 'user/message' && e.data.source?.kind !== 'plugin');
  const tail = events.filter(e => e.type === 'turn/end').at(-1);
  const final = events.filter(e => e.type === 'assistant/message').at(-1);
  return users.length === 1 && users[0].data.id === messageId
    && tail?.data.reason.kind === 'completed' && !!final && !final.data.interrupted;
}
