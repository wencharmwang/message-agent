import { createHash } from 'node:crypto';
import { ReplyContextDatabase } from './database.mjs';
import { Profiles } from './profiles.mjs';
import { Knowledge } from './knowledge.mjs';
import { Memory } from './memory.mjs';
import { createResolverRegistry, detectLiveIntents, extractIdentifiers } from './resolvers.mjs';
import { retrieveKnowledge, selectExamples, CONTEXT_BUDGET } from './retriever.mjs';
import { classifyIntent, detectRiskTags, DEFAULT_DECISION_POLICY } from './risk-gate.mjs';

/**
 * Context Orchestrator (spec §7). Builds the Canonical Context Pack for one automatic-reply
 * turn: the authoritative, bounded, explainable context the model works from — a real message
 * snapshot, CRM projection, open loops, the selected communication profile, the decision
 * policy, retrieved knowledge, live facts, and approved examples — plus an evidence catalog
 * and a deterministic context hash. No prompt string is assembled by the UI or scattered in
 * plugins; this module is the single place (spec §12).
 */

const RECENT_MESSAGE_LIMIT = 12;

function stableStringify(value) {
  const seen = new Set();
  const walk = v => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) {
      const out = v.map(walk);
      seen.delete(v);
      return out;
    }
    const out = {};
    for (const key of Object.keys(v).sort()) out[key] = walk(v[key]);
    seen.delete(v);
    return out;
  };
  return JSON.stringify(walk(value));
}

/** Keep the highest-ranked items until the char budget is exhausted, always keeping one. */
function trimArray(items, budget, toChars) {
  if (budget <= 0) return [];
  const kept = [];
  let total = 0;
  for (const item of items) {
    const chars = toChars(item).length;
    if (kept.length > 0 && total + chars > budget) break;
    kept.push(item);
    total += chars;
    if (total >= budget) break;
  }
  return kept;
}

/** Keep the latest messages within budget by dropping the oldest (never the current question). */
function trimRecent(messages, budget) {
  const sliced = messages.slice(-RECENT_MESSAGE_LIMIT);
  if (budget <= 0) return sliced.slice(-1);
  const out = [];
  let total = 0;
  for (let i = sliced.length - 1; i >= 0; i--) {
    const chars = (sliced[i].role + sliced[i].text).length;
    if (out.length > 0 && total + chars > budget) break;
    out.unshift(sliced[i]);
    total += chars;
    if (total >= budget) break;
  }
  return out;
}

export function createContextBuilder({db, workspaceId = 'local', crm = null, resolverRegistry = null, decisionPolicy = null, maxContextChars = 0}) {
  const database = db instanceof ReplyContextDatabase ? db : new ReplyContextDatabase(db);
  const profiles = new Profiles(database);
  const knowledge = new Knowledge(database);
  const memory = new Memory(database, crm);
  const resolvers = resolverRegistry ?? createResolverRegistry();
  const policy = decisionPolicy ?? DEFAULT_DECISION_POLICY;

  async function build({jobId, identity, conversationKey, rule, contextData, recentDeliveries = []}) {
    // 1. Identity consistency (spec §7 step 1): server-side binding only.
    if (!identity || !identity.provider || !identity.conversation) {
      throw Object.assign(new Error('会话身份不完整'), {code: 'CONTEXT_INVALID'});
    }
    if (rule && (rule.provider !== identity.provider || rule.conversation !== identity.conversation)) {
      throw Object.assign(new Error('会话身份与规则不一致'), {code: 'CONTEXT_INVALID'});
    }
    if (!/^[0-9a-f]{64}$/.test(conversationKey)) {
      throw Object.assign(new Error('会话 key 不正确'), {code: 'CONTEXT_INVALID'});
    }

    // 2. Current conversation snapshot (spec §5.5). The real observed messages win over the
    //    persistent Session's model memory; recent deliveries carry the send receipts.
    const messages = Array.isArray(contextData?.messages) ? contextData.messages : [];
    const recent = messages.slice(-RECENT_MESSAGE_LIMIT).map(m => ({
      role: m.direction === 'incoming' ? 'contact' : 'sent',
      text: typeof m.content === 'string' ? m.content : ''
    }));
    const lastIncoming = [...messages].reverse().find(m => m.direction === 'incoming');
    const currentQuestion = lastIncoming && typeof lastIncoming.content === 'string' ? lastIncoming.content : '';
    const deliveries = (recentDeliveries ?? []).slice(0, 3).map(d => ({state: d.state ?? 'unknown', text: d.text ?? ''}));

    // 3. CRM projection + open loops (spec §5.3).
    const contact = memory.contactContext(conversationKey);
    const openLoops = memory.openLoops(workspaceId, conversationKey);
    contact.openLoops = openLoops.map(m => ({kind: m.kind, content: m.content, sourceRef: m.sourceRef}));

    // 4. Profile and (implicitly) decision policy (spec §5.1, §5.6).
    const scene = rule?.kind === 'group' ? 'group_chat' : null;
    const selected = profiles.select(workspaceId, {conversationKey, contactKey: conversationKey, tags: [], scene});
    const profile = selected.profile;

    // 5. Entities / scene / intent (spec §7 step 5, §8 step 4).
    const detectedIntent = classifyIntent(currentQuestion);
    const detectedRiskTags = detectRiskTags(currentQuestion);
    const liveIntents = detectLiveIntents(currentQuestion);
    const identifiers = extractIdentifiers(currentQuestion);

    // 6. Static knowledge (published + valid only).
    const knowledgeHits = retrieveKnowledge(knowledge, workspaceId, currentQuestion, {limit: 8});

    // 7. Live resolvers (spec §5.4) — only when a trigger fires, scoped to server identity.
    const liveFacts = [];
    const unresolvedLiveIntents = [];
    for (const kind of liveIntents) {
      if (!resolvers.has(kind)) { unresolvedLiveIntents.push(kind); continue; }
      const result = await resolvers.resolve({workspaceId, kind, identifiers, conversationKey, requestedFields: null});
      if (result.status === 'resolved') {
        for (const f of result.facts) liveFacts.push({kind, ...f});
      } else {
        unresolvedLiveIntents.push(kind);
      }
    }

    // 8. Approved examples (spec §8 step 5).
    const examples = selectExamples(database, workspaceId, {
      profileId: profile?.id ?? null, conversationKey, intent: detectedIntent, limit: 4
    });

    // 9. Evidence catalog + deterministic hash (spec §7 step 9).
    const evidenceCatalog = [];
    for (const item of knowledgeHits) {
      evidenceCatalog.push({
        id: `ev_kb_${item.id}`, kind: 'published_knowledge', risk: item.riskLevel,
        expiresAt: item.validUntil ?? null, sourceRef: item.sourceRef || `knowledge:${item.id}`
      });
    }
    liveFacts.forEach((f, i) => evidenceCatalog.push({
      id: `ev_live_${i}`, kind: 'live_fact', risk: 'medium',
      expiresAt: f.expiresAt ?? null, sourceRef: f.sourceRef || `live:${f.kind}:${f.field}`
    }));
    for (const m of openLoops) {
      evidenceCatalog.push({
        id: `ev_mem_${m.id}`, kind: 'confirmed_memory', risk: 'low',
        expiresAt: m.validUntil ?? null, sourceRef: m.sourceRef || `memory:${m.id}`
      });
    }
    evidenceCatalog.push({ id: 'ev_conv', kind: 'conversation', risk: 'low', expiresAt: null, sourceRef: `conversation:${conversationKey}` });

    // 10. Trim to budget (spec §8), keeping risk-relevant content, the current question and
    //     open commitments. Live facts (with their timestamps) are never dropped.
    const contextPack = {
      version: 1,
      workspaceId,
      profile: profile ? {
        id: profile.id, name: profile.name, revision: profile.revision,
        rules: profile.rules, addressRule: profile.rules.addressRule ?? '',
        hard: profile.rules.hard ?? [], bannedExpressions: profile.rules.bannedExpressions ?? [],
        preference: profile.rules.preference ?? [], styleNotes: profile.rules.styleNotes ?? ''
      } : {},
      decisionPolicy: policy,
      contact,
      conversation: {
        recent: trimRecent(recent, CONTEXT_BUDGET.conversation),
        currentQuestion,
        recentDeliveries: deliveries
      },
      knowledge: trimArray(knowledgeHits.map(k => ({id: k.id, kind: k.kind, title: k.title, content: k.content, riskLevel: k.riskLevel})),
        CONTEXT_BUDGET.knowledge, k => k.title + k.content),
      liveFacts: liveFacts.map(f => ({kind: f.kind, field: f.field, value: f.value, observedAt: f.observedAt, expiresAt: f.expiresAt, sourceRef: f.sourceRef})),
      examples: trimArray(examples, CONTEXT_BUDGET.examples, e => e.incomingText + e.outgoingText)
    };

    const retrievalTrace = {
      detectedIntent, detectedRiskTags, liveIntents, unresolvedLiveIntents,
      knowledgeCount: knowledgeHits.length, exampleCount: examples.length,
      profileId: profile?.id ?? null, profileStatus: profile?.status ?? null,
      conversationMessages: messages.length
    };

    const contextHash = createHash('sha256').update(stableStringify(contextPack)).digest('hex');

    return {
      contextPack,
      evidenceCatalog,
      retrievalTrace,
      contextHash,
      // gate inputs
      liveFacts,
      detectedIntent,
      detectedRiskTags,
      unresolvedLiveIntents,
      currentQuestion,
      profile
    };
  }

  return { build, profiles, knowledge, memory, resolvers, database };
}
