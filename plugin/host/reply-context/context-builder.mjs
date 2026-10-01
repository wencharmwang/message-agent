import { createHash } from 'node:crypto';
import { ReplyContextDatabase } from './database.mjs';
import { Profiles } from './profiles.mjs';
import { Knowledge } from './knowledge.mjs';
import { Memory } from './memory.mjs';
import { createResolverRegistry, detectLiveIntents, extractIdentifiers } from './resolvers.mjs';
import { retrieveKnowledge, widenKnowledge, selectExamples, CONTEXT_BUDGET } from './retriever.mjs';
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

// 非文本消息的正文是一整段可打印 XML 卡片（图片 / 视频 / 文件）。直接喂给模型没有意义：
// 它只能从 hdlength、videomsg 这类字段反推"这是照片"，还白白吃掉 context 预算
// （实测一条图片 ≈ 400 字符，一次快照能占掉 2 KB 以上）。所以按消息 type 换成占位符。
//
// type 的词汇表有三套，这里都认：
//   - watcher 事件（自动回复走这条）：中文名 图片 / 视频 / 语音 / …
//   - DB 行（首页、整理、会话详情）：local_type 的数字字符串 '3' / '43' / '49'
//   - runtime 的 MessageType 枚举：image / video / file / audio / link / …
// 认不出的类型原样放行 —— 宁可给一段怪文本，也不要把可能是真话的正文吃掉。
const TEXT_TYPES = new Set(['', 'text', '文本']);

const MEDIA_PLACEHOLDERS = new Map(Object.entries({
  '图片': '[图片]', '3': '[图片]', image: '[图片]',
  '视频': '[视频]', '43': '[视频]', video: '[视频]',
  '语音': '[语音]', '34': '[语音]', audio: '[语音]',
  '动画表情': '[表情]', '表情': '[表情]', '47': '[表情]', '11000': '[表情]',
  '位置': '[位置]', '48': '[位置]', location: '[位置]',
  '音视频通话': '[通话]', '50': '[通话]',
  '系统消息': '[系统消息]', '10000': '[系统消息]', system: '[系统消息]',
  '红包': '[红包]', '8594229559345': '[红包]'
}));

// 49 是把「文件 / 链接 / 卡片」混在一起的一类，所以要再从 XML 里认一下具体是哪种。
const CARD_TYPES = new Set(['文件/链接/卡片', '链接或文件', '49', 'file', 'link']);

/** 正文是不是一段 XML/blob，而不是人话。 */
function looksLikeMarkup(text) {
  const head = text.trimStart().slice(0, 200);
  return head.startsWith('<') && /<\w+[\s/>]/.test(head);
}

/** 卡片是链接还是文件。认不出就退回笼统的「文件/链接」，不猜。 */
function cardLabel(raw) {
  if (/<url>/i.test(raw)) return '[链接]';
  if (/<fileext>/i.test(raw) || /<totallen>/i.test(raw)) return '[文件]';
  return '[文件/链接]';
}

/** 卡片标题：有标题比光一个占位符有用得多 —— 模型能说"看到你发的《XX》了"。 */
function cardTitle(raw) {
  const match = /<title>\s*(?:<!\[CDATA\[)?([\s\S]{1,80}?)(?:\]\]>)?\s*<\/title>/i.exec(raw);
  if (!match) return '';
  const title = match[1].trim();
  return looksLikeMarkup(title) ? '' : title;
}

/**
 * 一条消息给模型看的正文。文本原样；非文本按 type 换成占位符，不把 XML 卡片当正文。
 * 导出是为了能单独测这条约定。
 */
export function messageText(message) {
  const raw = typeof message?.content === 'string' ? message.content : '';
  const type = typeof message?.type === 'string' ? message.type.trim() : '';
  if (TEXT_TYPES.has(type)) return raw;
  if (CARD_TYPES.has(type)) {
    // 卡片正文有时已经是可读文本（标题、文件名、URL），那就留着。
    if (raw && !looksLikeMarkup(raw)) return raw;
    const title = cardTitle(raw);
    return title ? cardLabel(raw) + ' ' + title : cardLabel(raw);
  }
  return MEDIA_PLACEHOLDERS.get(type) ?? mediaLabelByBase(type) ?? raw;
}

/**
 * app 消息的 local_type 是复合的：``(子类型 << 32) | 49``。中文名和枚举名都查不到时，
 * 再按低 32 位查一次，别让 ``244813135921`` 这种数字直接漏给模型。
 */
function mediaLabelByBase(type) {
  if (!/^\d+$/.test(type)) return null;
  const value = Number(type);
  const base = value % 4294967296;
  if (base === value) return null;
  const key = String(base);
  if (CARD_TYPES.has(key)) return '[文件/链接]';
  return MEDIA_PLACEHOLDERS.get(key) ?? null;
}

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

  async function build({jobId, identity, conversationKey, rule, contextData, recentDeliveries = [], now = Math.floor(Date.now() / 1000)}) {
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
    // 群聊里「对方」是谁必须写出来：一整屏都是不同人的话，不写名字模型只能瞎猜该回谁。
    // 单聊不给这个字段（写不写都不影响判断），这样既有的上下文哈希保持不变。
    const isGroup = rule?.kind === 'group';
    const recent = messages.slice(-RECENT_MESSAGE_LIMIT).map(m => ({
      role: m.direction === 'incoming' ? 'contact' : 'sent',
      // 图片/视频/文件给占位符，不给 XML 卡片 —— 见 messageText。
      text: messageText(m),
      // 时间跟着消息一起给模型 —— 否则"什么时候说的"全靠猜（实测把几天前的话当成现在）。
      at: Number(m.at) || 0,
      // 只有群聊**对方**的消息才写发送者：单聊写不写都不影响判断，自己的消息"我方"
      // 已经说清了。这样既有的上下文哈希（去重/缓存都靠它）也保持不变。
      speaker: isGroup && m.direction === 'incoming' ? String(m.sender ?? '').trim() : undefined
    }));
    const lastIncoming = [...messages].reverse().find(m => m.direction === 'incoming');
    // 最后一条是图片时，currentQuestion 是 "[图片]" 而不是一段 XML —— 它也参与意图判定。
    const currentQuestion = messageText(lastIncoming);
    const deliveries = (recentDeliveries ?? []).slice(0, 3).map(d => ({state: d.state ?? 'unknown', text: d.text ?? ''}));

    // 3. CRM projection + open loops (spec §5.3).
    // "现在"也要给模型：有了消息时间 + 当前时刻，它才能算"这是几天前说的"。
    const at = now;
    const contact = memory.contactContext(conversationKey);
    // 3.5 这个人的长期记忆。**只取 confirmed**：candidate 是模型猜的、还没被确认，
    //     当成事实喂回去比不喂更糟（聊天稳不稳，很大程度取决于"喂进去的是不是真的"）。
    try {
      contact.memories = memory.list(workspaceId, {conversationKey, status: 'confirmed'})
        .slice(0, 15).map(item => ({kind: item.kind, content: item.content, recordedAt: item.createdAt}));
    } catch {
      contact.memories = [];
    }
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
    //    hits 只用于「这次有没有可引用的依据」；knowledgeForModel 才是喂给模型的知识段。
    //    条目总量在预算内时全量给——这个量级下关键词检索只会丢信息；超预算才退回 top-N。
    // Social turns do not need the workspace's product manuals or sales playbooks.
    const needsKnowledge = !policy.autoIntents.includes(detectedIntent);
    const knowledgeHits = needsKnowledge ? retrieveKnowledge(knowledge, workspaceId, currentQuestion, {limit: 8}) : [];
    const knowledgeForModel = needsKnowledge ? widenKnowledge(knowledge, workspaceId, knowledgeHits) : [];

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
        recentDeliveries: deliveries,
        // 当前时刻：渲染时要拿它算这是几天前说的。
        at
      },
      knowledge: trimArray(knowledgeForModel.map(k => ({id: k.id, kind: k.kind, title: k.title, content: k.content, riskLevel: k.riskLevel})),
        CONTEXT_BUDGET.knowledge, k => k.title + k.content),
      liveFacts: liveFacts.map(f => ({kind: f.kind, field: f.field, value: f.value, observedAt: f.observedAt, expiresAt: f.expiresAt, sourceRef: f.sourceRef})),
      examples: trimArray(examples, CONTEXT_BUDGET.examples, e => e.incomingText + e.outgoingText)
    };

    const retrievalTrace = {
      detectedIntent, detectedRiskTags, liveIntents, unresolvedLiveIntents,
      knowledgeCount: knowledgeHits.length, knowledgeInjected: knowledgeForModel.length, exampleCount: examples.length,
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
