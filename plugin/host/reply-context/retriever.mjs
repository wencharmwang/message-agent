import { ReplyContextDatabase } from './database.mjs';

/**
 * Hybrid deterministic retrieval (spec §8). No embedding at P0: fixed load of the decision
 * policy and profile hard rules, scope filtering, FTS5 keyword search over FAQ/how-to/playbook
 * bodies, structured triggers for live data, and example selection ranked by profile, scene,
 * contact and review quality. Every lookup is workspace-scoped.
 */

// Words too common to drive a useful FTS lookup on their own.
const STOP_WORDS = new Set(['什么', '怎么', '如何', '请问', '你好', '在吗', '一下', '可以', '吗', '呢', '的', '了', '我', '你', '他', '她', '它']);

/** Split incoming text into searchable terms, dropping stop words and short noise. */
export function buildQueryTerms(text) {
  const cleaned = (text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
  const terms = cleaned.split(/\s+/).filter(t => {
    if (t.length < 2) return false;
    if (STOP_WORDS.has(t)) return false;
    // Skip pure digits below a plausible order number length.
    return !(/^\d+$/.test(t) && t.length < 4);
  });
  // Keep at most the first few distinctive terms: short queries hit FTS better.
  return [...new Set(terms)].slice(0, 8);
}

/** Retrieve active knowledge by the message's own words (workspace-scoped, valid-only). */
export function retrieveKnowledge(knowledge, workspaceId, text, {limit = 8} = {}) {
  const terms = buildQueryTerms(text);
  if (!terms.length) return [];
  // Whole query first; if it over-constrains, individual terms widen the recall.
  const hits = knowledge.search(workspaceId, terms.join(' '), {limit});
  if (hits.length) return hits;
  for (const term of terms) {
    const more = knowledge.search(workspaceId, term, {limit});
    for (const item of more) {
      if (!hits.some(h => h.id === item.id)) hits.push(item);
      if (hits.length >= limit) break;
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

/** 全量注入的上限：条目再多也不让上下文碎成几百行。 */
const FULL_INJECT_MAX_ITEMS = 60;

/**
 * 决定「给模型看哪些知识」——只影响上下文，不影响判定。
 *
 * 已发布条目总量在预算内时**全部注入**：这个量级下关键词检索只是在丢信息
 * （"怎么退钱"召不回"退款政策"，而条目其实全都在预算里装得下）。
 * 超出预算（条目多、或单条很长）才退回关键词检索取 top-N。
 *
 * 注意 evidenceCatalog / retrievalTrace 仍按**检索命中**构造：门控拿它判断
 * "这次有没有可引用的依据"，放宽了会让没有答案的问题也被当成有依据而自动回复。
 */
export function widenKnowledge(knowledge, workspaceId, hits, {budget = CONTEXT_BUDGET.knowledge, maxItems = FULL_INJECT_MAX_ITEMS} = {}) {
  const active = knowledge.active(workspaceId);
  if (!active.length) return hits;
  const total = active.reduce((sum, item) => sum + (item.title?.length ?? 0) + (item.content?.length ?? 0), 0);
  if (active.length <= maxItems && total <= budget) return active;
  return hits;
}

/** Approved examples ranked for the current profile, scene, contact, then by review quality. */
export function selectExamples(db, workspaceId, {profileId = null, conversationKey = null, intent = '', limit = 4} = {}) {
  if (!(db instanceof ReplyContextDatabase)) throw new Error('reply-context db required');
  const rows = db.db.prepare(`SELECT * FROM reply_examples WHERE workspace_id = ? AND status = 'approved' ORDER BY quality DESC, created_at DESC LIMIT 200`)
    .all(workspaceId);
  const scored = rows.map(r => {
    let score = 0;
    if (r.profile_id && r.profile_id === profileId) score += 100;
    if (r.conversation_key && r.conversation_key === conversationKey) score += 50;
    if (r.intent && intent && r.intent === intent) score += 30;
    score += Math.min(20, r.quality ?? 0);
    return {score, example: {
      id: r.id, profileId: r.profile_id, conversationKey: r.conversation_key, intent: r.intent,
      incomingText: r.incoming_text, outgoingText: r.outgoing_text, quality: r.quality
    }};
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(s => s.example);
}

/**
 * Context budget (spec §8). Each section has a char ceiling; when the total must shrink,
 * low-quality examples drop first, then low-relevance knowledge — never risk rules, live-fact
 * timestamps, the current question, or open commitments.
 */
export const CONTEXT_BUDGET = {
  policy: 1200,
  profile: 1000,
  contact: 1200,
  conversation: 3000,
  knowledge: 3500,
  examples: 1500
};

/** Chop a string to a char budget on a rune boundary, adding a marker only when truly cut. */
export function clamp(text, budget) {
  const chars = [...(text ?? '')];
  if (chars.length <= budget) return text ?? '';
  return chars.slice(0, budget).join('') + '…';
}
