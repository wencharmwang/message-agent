import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Drafts, readBindings, validateDraftText } from './storage.mjs';
import { RuntimeAdapter } from './runtime.mjs';
import { createCrm } from './crm.mjs';
import { classifyIntent, detectRiskTags, maxRiskGrade, DEFAULT_DECISION_POLICY } from './reply-context/risk-gate.mjs';

/**
 * Conversation identity key. Automatic sessions keep the historical key
 * sha256([provider, conversation]) from conversation-sessions.mjs; interactive
 * sessions add a purpose dimension so they never overwrite automatic bindings.
 */
export function identityKey(provider, conversation, purpose = 'automatic') {
  const parts = purpose === 'automatic' ? [provider, conversation] : [provider, conversation, purpose];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

const JOB_ACTIVE = new Set(['queued', 'generating', 'ready', 'sending']);
export const INBOX_FILTERS = ['all', 'pending', 'processing', 'error'];

/**
 * The stack reports failures as runtime error codes. A non-technical user cannot act
 * on "provider_unavailable", and the old wording told people to look at a WeChat
 * window that was usually not the problem, so every code gets one plain sentence
 * plus a concrete next step.
 */
export const RUNTIME_MESSAGES = {
  provider_unavailable: '暂时读不到微信，助手每 5 秒会自动重试。如果一直这样，请确认微信已登录、且没有缩到托盘（最小化）。',
  provider_busy: '助手正在用微信的搜索定位联系人，几秒后会自动恢复。',
  conversation_not_found: '微信当前显示的聊天列表里没有这个联系人。',
  contact_not_found: '微信里没有找到这个联系人，请核对名字是否和微信里显示的一致。',
  conversation_unverified: '打开微信会话时没有核对成功，助手没有读取也没有发送。',
  foreground_unavailable: '没能在微信里完成这一步，本次操作没有执行。',
  send_button_disabled: '发送按钮变灰说明消息已经发出，不需要再确认。',
  not_sent: '这条消息没有发出去，助手不会自动重发。',
  uncertain: '发送结果暂时无法确认，请不要重复发送。'
};
const CODE_RE = /\b(provider_unavailable|provider_busy|conversation_not_found|contact_not_found|conversation_unverified|foreground_unavailable|send_button_disabled|not_sent|uncertain)\b/;

/** Drop runtime identifiers, enums and class names left over from a wire error. */
function stripRuntimeNoise(text) {
  return text
    .replace(/(?:Runtime|runtime|code|错误代码)\s*[:：]\s*[A-Za-z_][A-Za-z0-9_]{2,40}/g, '')
    .replace(/[A-Za-z_][A-Za-z0-9_]{2,40}(?:Error|Exception)\s*[:：][^。；]*/g, '')
    .replace(/^[；;。、\s]+|[；;、\s]+$/g, '')
    .trim();
}

/** Only the mapped sentence when a known runtime code is present, otherwise ''. */
function codeMessage(detail) {
  if (typeof detail !== 'string') return '';
  const code = detail.match(CODE_RE)?.[1];
  return code ? RUNTIME_MESSAGES[code] : '';
}

/**
 * The WeChat driver reports its own send receipts in English. They are shown on the
 * automation page and in "助手最近做了什么", so a Chinese product cannot pass them
 * through verbatim.
 */
const RECEIPT_PHRASES = [
  [/UI submission verified[^;]*;\s*recipient delivery not verified/i, '已在微信里发出；对方是否读到无法确认（微信没有已读回执）'],
  [/UI submission verified/i, '已在微信里发出'],
  [/recipient delivery not verified/i, '对方是否读到无法确认（微信没有已读回执）'],
  [/Sending stopped;?\s*inspect Runtime receipt before retrying/i, '这次没有发出去，也不会自动重发；请先核对发送结果'],
  [/inspect Runtime receipt/i, '请先核对发送结果，再决定是否重试'],
  [/User confirmed no outgoing bubble and no composer draft;?\s*old reply will not be replayed/i, '已确认微信里没有发出这条消息，也不会自动重发'],
  [/no outgoing bubble/i, '微信里没有这条消息'],
  [/old reply will not be replayed/i, '这条旧回复不会再发送'],
  [/send_button_disabled/i, '发送按钮变灰说明已经发出，不需要再确认'],
  // Crash recovery and cancellation reasons. Rows written before this map existed are still
  // in the database, so translating here covers the history as well as new work.
  [/Worker restarted during submission/i, '助手重启时这条正在发送，无法确认是否已经发出；不会自动重发'],
  [/Worker restarted before submission/i, '助手重启时这条还没发出去'],
  [/Conversation changed while Agent was responding/i, '对方又发了新消息，这条回复作废'],
  [/Rule changed or task expired before submission/i, '规则被改动或任务超时，这条没有发送'],
  [/Rule changed during generation/i, '生成回复期间规则被改动，这条作废'],
  [/Rule disabled or changed/i, '规则被关闭或改动，这条作废'],
  [/Rule (changed|edited|deleted)/i, '规则被改动，这条作废'],
  [/Reply task expired/i, '这条回复等太久，已经作废']
];

/** Replace any raw runtime code with one actionable Chinese sentence. */
export function humanizeDetail(detail) {
  if (typeof detail !== 'string' || !detail) return '';
  const coded = codeMessage(detail);
  if (coded) return coded;
  for (const [pattern, text] of RECEIPT_PHRASES) if (pattern.test(detail)) return text;
  return stripRuntimeNoise(detail);
}

/**
 * Pure Inbox projection (architecture §6): rules + jobs + session bindings + drafts →
 * per-conversation items. processingState, deliveryState and attentionReason stay
 * separate; a finished generation is never reported as a delivery.
 */
export function projectInbox({rules, jobs, bindings, drafts, reviewed = {}}) {
  const jobsByRule = new Map();
  for (const job of jobs) {
    const list = jobsByRule.get(job.rule_id) ?? [];
    list.push(job);
    jobsByRule.set(job.rule_id, list);
  }
  const items = rules.map(rule => {
    const key = identityKey(rule.provider, rule.conversation);
    const ruleJobs = (jobsByRule.get(rule.id) ?? []).sort((a, b) => b.created_at - a.created_at);
    const latest = ruleJobs[0] ?? null;
    const acknowledged = job => !!reviewed[job.id];
    // A problem the user has already looked at stops being an alert. Keeping it forever
    // would train people to ignore the one that matters.
    const openProblem = ruleJobs.find(j => (j.state === 'failed' || j.state === 'uncertain') && !acknowledged(j)) ?? null;
    const active = ruleJobs.find(j => JOB_ACTIVE.has(j.state)) ?? null;
    const processingState = active ? active.state : rule.status;
    const lastReceipt = ruleJobs.find(j => j.state === 'sent' || j.state === 'uncertain') ?? null;
    const deliveryState = lastReceipt ? lastReceipt.state : null;
    const pendingDrafts = drafts.filter(d =>
      d.target.provider === rule.provider && d.target.conversation === rule.conversation
      && d.state === 'awaiting_confirmation');
    let bucket = 'ok';
    let attentionReason = null;
    let attentionKind = null;
    if (rule.status === 'blocked' || rule.status === 'waiting_connection' || openProblem) {
      bucket = 'error';
      attentionKind = rule.status === 'waiting_connection' ? 'connection'
        : openProblem?.state === 'uncertain' || rule.status === 'blocked' ? 'send' : 'failed';
      attentionReason = codeMessage(rule.detail) || codeMessage(openProblem?.detail)
        || (attentionKind === 'connection' ? RUNTIME_MESSAGES.provider_unavailable
          : attentionKind === 'send' ? '上一条回复的结果没有确认（不会自动重发），你可以去微信里看一眼' : '上次处理没有完成，请打开详情查看');
    } else if (pendingDrafts.length) {
      bucket = 'pending';
      attentionKind = 'draft';
      attentionReason = '有一条回复等你确认后才会发出';
    } else if (rule.status === 'needs_user') {
      bucket = 'pending';
      attentionKind = 'manual';
      attentionReason = humanizeDetail(rule.detail) || '需要你处理';
    } else if (active || ['starting', 'settling', 'queued'].includes(rule.status)) {
      bucket = 'processing';
    } else if (latest?.decision) {
      try {
        const decision = JSON.parse(latest.decision);
        if (decision.action === 'needs_user') {
          bucket = 'pending';
          attentionKind = 'manual';
          attentionReason = decision.reason || '需要你处理';
        }
      } catch { /* an unparsable decision stays a raw fact on the job, not an inbox signal */ }
    }
    const updatedAt = Math.max(
      rule.observed_at ?? 0, latest?.finished_at ?? 0, latest?.created_at ?? 0,
      ...pendingDrafts.map(d => d.updatedAt)) || null;
    return {
      key,
      identity: {provider: rule.provider, conversation: rule.conversation, title: rule.title, kind: rule.kind},
      rule: {id: rule.id, enabled: !!rule.enabled, revision: rule.revision, status: rule.status, detail: humanizeDetail(rule.detail)},
      processingState,
      deliveryState,
      bucket,
      attentionReason,
      attentionKind,
      summary: latest?.text || humanizeDetail(latest?.detail) || humanizeDetail(rule.detail) || '',
      pendingDrafts: pendingDrafts.length,
      sessions: {
        automatic: bindings[key] ?? null,
        interactive: bindings[identityKey(rule.provider, rule.conversation, 'interactive')] ?? null
      },
      coverage: rule.enabled ? rule.status : 'paused',
      updatedAt
    };
  });
  items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.key.localeCompare(b.key));
  return items;
}

/** Stable cursor pagination: updatedAt desc, key asc; cursor = "<updatedAt>:<key>" of the last item. */
export function pageInbox(items, {filter = 'all', cursor, limit = 20} = {}) {
  const filtered = filter === 'all' ? items : items.filter(i => i.bucket === filter);
  let start = 0;
  if (cursor) {
    const index = filtered.findIndex(i => `${i.updatedAt ?? 0}:${i.key}` === cursor);
    if (index === -1) throw Object.assign(new Error('分页位置已失效，请刷新列表'), {code: 'INBOX_CURSOR_STALE'});
    start = index + 1;
  }
  const page = filtered.slice(start, start + limit);
  const last = page.at(-1);
  return {
    items: page,
    nextCursor: start + limit < filtered.length && last ? `${last.updatedAt ?? 0}:${last.key}` : null
  };
}

/**
 * "今天要做的" projection (architecture §8): what the assistant could not decide on its
 * own, what is waiting for your send confirmation, and everything you wrote down
 * yourself. Finished work stays folded at the bottom as a receipt, not a task.
 */
export function projectToday({items = [], drafts = [], todoBuckets = {overdue: [], today: [], later: [], someday: []}, jobs = [], now = Date.now() / 1000} = {}) {  const decide = [];
  for (const item of items) {
    if (item.bucket !== 'pending' || item.attentionKind === 'draft') continue;
    decide.push({
      id: 'conversation:' + item.key, kind: 'conversation', conversationKey: item.key,
      identity: item.identity, title: item.attentionReason || '需要你处理',
      detail: item.summary || '', attentionKind: item.attentionKind,
      updatedAt: item.updatedAt
    });
  }
  const confirm = drafts.filter(d => d.state === 'awaiting_confirmation').map(d => ({
    id: 'draft:' + d.id, kind: 'draft', draftId: d.id, revision: d.revision,
    conversationKey: identityKey(d.target.provider, d.target.conversation),
    identity: d.target, title: '发给「' + d.target.title + '」的回复', detail: d.text,
    expiresAt: d.expiresAt, updatedAt: d.updatedAt
  }));
  const dueState = {overdue: 'overdue', today: 'today', later: 'later', someday: 'someday'};
  const todos = [];
  for (const [bucketName, list] of Object.entries(todoBuckets)) {
    for (const todo of list ?? []) {
      todos.push({...todo, kind: 'todo', id: 'todo:' + todo.id, todoId: todo.id, dueState: dueState[bucketName] ?? 'someday'});
    }
  }
  // "助手已处理" is a receipt: one line per conversation, most recent work only.
  const identityByRule = new Map(items.map(item => [item.rule.id, item]));
  const handled = [];
  const seen = new Set();
  for (const job of [...jobs].sort((a, b) => (b.finished_at ?? b.created_at ?? 0) - (a.finished_at ?? a.created_at ?? 0))) {
    const item = identityByRule.get(job.rule_id);
    if (!item || seen.has(item.key)) continue;
    if ((job.finished_at ?? 0) < now - 48 * 3600) continue;
    seen.add(item.key);
    handled.push({
      id: 'job:' + job.id, kind: 'handled', conversationKey: item.key, identity: item.identity,
      title: item.identity.title, detail: job.text || humanizeDetail(job.detail) || '',
      state: job.state, updatedAt: job.finished_at || job.created_at
    });
    if (handled.length >= 8) break;
  }
  return {
    groups: [
      {key: 'decide', title: '需要你决定', hint: '助手拿不准，等你拍板', items: decide},
      {key: 'confirm', title: '等你确认发送', hint: '正文已经拟好，确认后才会发出', items: confirm},
      {key: 'todos', title: '我记的待办', hint: '', items: todos},
      {key: 'handled', title: '助手已处理', hint: '', items: handled}
    ],
    counts: {
      decide: decide.length, confirm: confirm.length, todos: todos.length,
      overdue: (todoBuckets.overdue ?? []).length,
      attention: decide.length + confirm.length + (todoBuckets.overdue ?? []).length
    },
    generatedAt: now
  };
}

/**
 * Product business API under the existing same-origin /message-agent/api/ prefix
 * (architecture §6). Returns true when the request was handled. index.mjs applies
 * the same-origin guards before delegating here.
 */
export function createProductApi({config, token, conversations, bindingsPath, respond, readBody, ensureInteractiveSession, askAssistant, crm: crmInjected, context: contextSystem}) {
  const runtime = new RuntimeAdapter({controlPort: config.control_port, token});
  const drafts = new Drafts(join(dirname(config.database), 'drafts.json'));
  const crm = crmInjected ?? createCrm(join(dirname(config.database), 'crm.db'));
  const context = contextSystem ?? null;
  // "I looked at it" is a host-side bookkeeping detail, not worker state: the delivery
  // record itself must stay untouched.
  const reviewedPath = join(dirname(config.database), 'reviewed.json');
  const reviewed = () => {
    try { return JSON.parse(readFileSync(reviewedPath, 'utf8')); } catch { return {}; }
  };
  const markReviewed = ids => {
    const now = Date.now() / 1000;
    const merged = {...reviewed()};
    for (const id of ids) merged[id] = now;
    const kept = Object.fromEntries(Object.entries(merged).filter(([, at]) => now - at < 30 * 86400).slice(-500));
    writeFileSync(reviewedPath, JSON.stringify(kept));
    return ids.length;
  };

  async function aggregate() {
    const status = await runtime.status();
    const bindings = readBindings(bindingsPath);
    const items = projectInbox({rules: status.rules ?? [], jobs: status.jobs ?? [], bindings, drafts: drafts.list(), reviewed: reviewed()});
    return {status, items};
  }
  function requireItem(items, key) {
    const item = items.find(i => i.key === key);
    if (!item) throw Object.assign(new Error('这个会话还没有接入工作台'), {code: 'CONVERSATION_NOT_FOUND'});
    return item;
  }
  /** Identity always comes from the server-side inbox; the browser never invents it. */
  async function requireCustomer(key) {
    const existing = crm.getCustomer(key);
    if (existing) return existing;
    const {items} = await aggregate();
    const item = requireItem(items, key);
    crm.ensureCustomer({key, provider: item.identity.provider, conversation: item.identity.conversation,
      displayName: item.identity.title, kind: item.identity.kind});
    return crm.getCustomer(key);
  }

  return async function handle(req, res, url) {
    const path = url.pathname;
    try {
      // The automation page reads rules and job receipts straight off the Worker, so it
      // must not be the one place where raw runtime codes still reach the user.
      if (path === '/message-agent/api/status' && req.method === 'GET') {
        const status = await runtime.status();
        respond(res, 200, {
          ...status,
          rules: (status.rules ?? []).map(rule => ({...rule, detail: humanizeDetail(rule.detail)})),
          jobs: (status.jobs ?? []).map(job => ({...job, detail: humanizeDetail(job.detail)}))
        });
        return true;
      }
      if (path === '/message-agent/api/inbox' && req.method === 'GET') {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 1), 50);
        const filter = url.searchParams.get('filter') ?? 'all';
        if (!INBOX_FILTERS.includes(filter)) throw Object.assign(new Error('未知筛选：' + filter), {code: 'INBOX_BAD_FILTER'});
        const {items} = await aggregate();
        const page = pageInbox(items, {filter, cursor: url.searchParams.get('cursor') ?? undefined, limit});
        respond(res, 200, {...page, filter, generatedAt: Date.now() / 1000});
        return true;
      }
      if (path === '/message-agent/api/today' && req.method === 'GET') {
        const {status, items} = await aggregate();
        respond(res, 200, projectToday({
          items, drafts: drafts.list(), jobs: status.jobs ?? [],
          todoBuckets: crm.todoBuckets(), now: Date.now() / 1000
        }));
        return true;
      }
      // ---- reply-context system (spec §13) ---------------------------------
      if (path === '/message-agent/api/context' || path.startsWith('/message-agent/api/context/')) {
        if (!context) { respond(res, 503, {error: '回复上下文系统未启用'}); return true; }
        const ws = context.workspaceId;
        const parts = path.replace('/message-agent/api/context', '').split('/').filter(Boolean);
        const [resource, id, action] = parts;

        if (resource === 'profiles') {
          if (!id && req.method === 'GET') { respond(res, 200, {items: context.profiles.list(ws)}); return true; }
          if (!id && req.method === 'POST') { respond(res, 201, context.profiles.create(ws, await readBody(req))); return true; }
          if (id && req.method === 'PATCH') { respond(res, 200, context.profiles.update(ws, id, await readBody(req))); return true; }
          if (id && (action === 'activate' || action === 'retire') && req.method === 'POST') {
            respond(res, 200, context.profiles[action](ws, id)); return true;
          }
          if (id && !action && req.method === 'GET') {
            const p = context.profiles.get(id, ws);
            if (!p) throw Object.assign(new Error('没有这个说话方式'), {code: 'CONTEXT_NOT_FOUND'});
            respond(res, 200, p); return true;
          }
        }
        if (resource === 'profile-bindings') {
          if (req.method === 'GET') { respond(res, 200, {items: context.profiles.listBindings(ws)}); return true; }
          if (req.method === 'POST') { respond(res, 201, context.profiles.bind(ws, await readBody(req))); return true; }
        }
        if (resource === 'knowledge') {
          if (!id && req.method === 'GET') {
            const status = url.searchParams.get('status') ?? undefined;
            respond(res, 200, {items: context.knowledge.list(ws, {status})}); return true;
          }
          if (!id && req.method === 'POST') { respond(res, 201, context.knowledge.create(ws, await readBody(req))); return true; }
          if (id && req.method === 'PATCH') { respond(res, 200, context.knowledge.update(ws, id, await readBody(req))); return true; }
          if (id && ['publish', 'retire', 'rollback'].includes(action) && req.method === 'POST') {
            const p = await readBody(req).catch(() => ({}));
            respond(res, 200, context.knowledge[action](ws, id, p)); return true;
          }
          if (id && !action && req.method === 'GET') {
            const k = context.knowledge.get(id, ws);
            if (!k) throw Object.assign(new Error('没有这条知识'), {code: 'CONTEXT_NOT_FOUND'});
            respond(res, 200, k); return true;
          }
        }
        if (resource === 'memories') {
          if (!id && req.method === 'GET') {
            const ck = url.searchParams.get('conversation') ?? undefined;
            respond(res, 200, {items: context.memory.list(ws, {conversationKey: ck})}); return true;
          }
          if (!id && req.method === 'POST') { respond(res, 201, context.memory.add(ws, await readBody(req))); return true; }
          if (id && (action === 'resolve' || action === 'confirm') && req.method === 'POST') {
            respond(res, 200, context.memory[action](ws, id)); return true;
          }
        }
        if (resource === 'candidates') {
          if (!id && req.method === 'GET') { respond(res, 200, {items: context.candidates.list('pending')}); return true; }
          if (id && (action === 'accept' || action === 'reject') && req.method === 'POST') {
            respond(res, 200, context.candidates.decide(id, action === 'accept')); return true;
          }
        }
        if (resource === 'runs' && id && req.method === 'GET') {
          const run = context.audit.get(id, ws);
          if (!run) throw Object.assign(new Error('没有这次处理记录'), {code: 'CONTEXT_NOT_FOUND'});
          respond(res, 200, run); return true;
        }
        if (resource === 'preview' && req.method === 'POST') {
          const p = await readBody(req);
          // Server-side identity only: the browser cannot invent a conversation to inspect.
          const {items} = await aggregate();
          const target = items.find(i => i.identity.provider === p.provider && i.identity.conversation === p.conversation);
          if (!target) throw Object.assign(new Error('目标会话未接入，不能预览'), {code: 'CONVERSATION_NOT_FOUND'});
          const text = typeof p.text === 'string' ? p.text.trim().slice(0, 2000) : '';
          const conversationKey = identityKey(target.identity.provider, target.identity.conversation);
          const rule = {provider: target.identity.provider, conversation: target.identity.conversation, title: target.identity.title, kind: target.identity.kind, prompt: ''};
          const run = await context.build({
            jobId: 'preview', identity: target.identity, conversationKey, rule,
            contextData: {messages: text ? [{direction: 'incoming', content: text, sender: null, type: 'text'}] : []},
            recentDeliveries: []
          });
          // A rule-based "simulated decision": the risk grade and whether a human is required.
          const intent = classifyIntent(text);
          const tags = detectRiskTags(text);
          const grade = maxRiskGrade(tags);
          const unresolved = run.unresolvedLiveIntents ?? [];
          const wouldNeedHuman = grade === 'L3' || DEFAULT_DECISION_POLICY.humanIntents.includes(intent)
            || ((grade === 'L2' || DEFAULT_DECISION_POLICY.draftIntents.includes(intent)) && !run.evidenceCatalog.some(e => e.kind === 'published_knowledge'))
            || unresolved.length > 0;
          respond(res, 200, {
            profile: run.contextPack.profile, knowledge: run.contextPack.knowledge,
            liveStatus: unresolved.length ? 'unavailable' : 'ok', unresolvedLiveIntents: unresolved,
            detectedIntent: intent, riskTags: tags, riskGrade: grade,
            simulated: {intent, riskGrade, wouldNeedHuman},
            contextHash: run.contextHash
          });
          return true;
        }
        respond(res, 405, {error: 'Method not allowed'});
        return true;
      }
      // ---- to-dos ----------------------------------------------------------
      const todo = path.match(/^\/message-agent\/api\/todos(?:\/([0-9a-f-]{36})(?:\/(done|reopen|delete))?)?$/);
      if (todo) {
        const [, id, action] = todo;
        if (!id && req.method === 'GET') {
          const state = url.searchParams.get('state') ?? 'open';
          const conversationKey = url.searchParams.get('conversation') ?? undefined;
          respond(res, 200, {items: crm.listTodos({state, conversationKey}), counts: crm.counts()});
          return true;
        }
        if (!id && req.method === 'POST') {
          const payload = await readBody(req);
          let conversationKey = null;
          let identity = null;
          if (payload.conversationKey) {
            const customer = await requireCustomer(String(payload.conversationKey));
            conversationKey = customer.key;
            identity = customer.identity;
          }
          respond(res, 201, crm.createTodo({
            conversationKey, title: payload.title, detail: payload.detail, evidence: payload.evidence,
            source: payload.source === 'assistant' ? 'assistant' : payload.source === 'message' ? 'message' : 'manual',
            dueAt: payload.dueAt
          }));
          return true;
        }
        if (id && action === 'delete' && req.method === 'POST') {
          respond(res, 200, crm.deleteTodo(id)); return true;
        }
        if (id && (action === 'done' || action === 'reopen') && req.method === 'POST') {
          const payload = await readBody(req).catch(() => ({}));
          respond(res, 200, crm.setTodoState(id, action === 'done' ? 'done' : 'open', payload?.dueAt));
          return true;
        }
        if (id && !action && req.method === 'POST') {
          const payload = await readBody(req);
          respond(res, 200, crm.updateTodo(id, {title: payload.title, detail: payload.detail, dueAt: payload.dueAt}));
          return true;
        }
        respond(res, 405, {error: 'Method not allowed'});
        return true;
      }
      // ---- customers / follow-ups -----------------------------------------
      const customer = path.match(/^\/message-agent\/api\/customers(?:\/([0-9a-f]{64})(?:\/(followups)(?:\/([0-9a-f-]{36}))?)?)?$/);
      if (customer) {
        const [, key, section, followupId] = customer;
        const followups = section === 'followups';
        if (!key && req.method === 'GET') {
          respond(res, 200, {items: crm.listCustomers(), counts: crm.counts()});
          return true;
        }
        if (key && !followups && req.method === 'GET') {
          await requireCustomer(key);
          respond(res, 200, {
            customer: crm.getCustomer(key),
            followups: crm.listFollowups(key),
            todos: crm.listTodos({conversationKey: key})
          });
          return true;
        }
        if (key && !followups && req.method === 'POST') {
          await requireCustomer(key);
          const payload = await readBody(req);
          respond(res, 200, crm.updateCustomer(key, {stage: payload.stage, nextStep: payload.nextStep, note: payload.note}));
          return true;
        }
        if (key && followups && req.method === 'POST') {
          await requireCustomer(key);
          const payload = await readBody(req);
          if (followupId === undefined) {
            respond(res, 201, crm.addFollowup(key, {kind: payload.kind, note: payload.note, evidence: payload.evidence}));
          } else if (payload?.delete) {
            respond(res, 200, crm.deleteFollowup(key, followupId));
          } else {
            respond(res, 405, {error: 'Method not allowed'});
          }
          return true;
        }
        respond(res, 405, {error: 'Method not allowed'});
        return true;
      }
      const conversation = path.match(/^\/message-agent\/api\/conversations\/([0-9a-f]{64})(\/session|\/ask|\/customer|\/ack)?$/);
      if (conversation) {
        const [, key, action] = conversation;
        if (!action && req.method === 'GET') {
          const {status, items} = await aggregate();
          const item = requireItem(items, key);
          const reviewedJobs = reviewed();
          const recentJobs = (status.jobs ?? [])
            .filter(j => j.rule_id === item.rule.id)
            .sort((a, b) => b.created_at - a.created_at).slice(0, 10)
            .map(({id, event_id, request_id, state, text, detail, created_at, finished_at}) =>
              ({id, event_id, request_id, state, text, detail: humanizeDetail(detail), created_at, finished_at,
                acknowledged: !!reviewedJobs[id]}));
          const customer = crm.getCustomer(key);
          respond(res, 200, {
            ...item, recentJobs, drafts: drafts.list(item.identity),
            customer, followups: customer ? crm.listFollowups(key) : [],
            todos: crm.listTodos({conversationKey: key}),
            counts: crm.counts()
          });
          return true;
        }
        if (action === '/session' && req.method === 'POST') {
          // Interactive bindings add a purpose dimension; automatic bindings stay untouched.
          const {items} = await aggregate();
          const item = requireItem(items, key);
          const iKey = identityKey(item.identity.provider, item.identity.conversation, 'interactive');
          const existing = conversations.entries[iKey];
          const sessionId = existing ?? 'messaging-interactive-' + iKey;
          if (ensureInteractiveSession) await ensureInteractiveSession({sessionId, identity: item.identity});
          if (!existing) conversations.bind(iKey, sessionId);
          respond(res, existing ? 200 : 201, {key: iKey, purpose: 'interactive', sessionId, reused: !!existing, reserved: false});
          return true;
        }
        if (action === '/ack' && req.method === 'POST') {
          const {status, items} = await aggregate();
          const target = requireItem(items, key);
          const ids = (status.jobs ?? [])
            .filter(job => job.rule_id === target.rule.id && (job.state === 'failed' || job.state === 'uncertain'))
            .map(job => job.id);
          respond(res, 200, {reviewed: markReviewed(ids)});
          return true;
        }
        if (action === '/ask' && req.method === 'POST') {
          const payload = await readBody(req);
          const {items} = await aggregate();
          const item = requireItem(items, key);
          const iKey = identityKey(item.identity.provider, item.identity.conversation, 'interactive');
          const existing = conversations.entries[iKey];
          const sessionId = existing ?? 'messaging-interactive-' + iKey;
          if (!askAssistant) throw Object.assign(new Error('助手暂时不可用'), {code: 'WORKER_UNAVAILABLE'});
          const answer = await askAssistant({sessionId, identity: item.identity, text: payload.text, create: !existing});
          if (!existing) conversations.bind(iKey, sessionId);
          respond(res, 200, {...answer, sessionId});
          return true;
        }
        respond(res, 405, {error: 'Method not allowed'});
        return true;
      }
      const draft = path.match(/^\/message-agent\/api\/drafts(?:\/([0-9a-f-]{36})(\/(revise|confirm|cancel))?)?$/);
      if (draft) {
        const [, id, , action] = draft;
        if (!id && req.method === 'POST') {
          const payload = await readBody(req);
          const {items} = await aggregate();
          // Target is fixed to an onboarded conversation; the browser cannot invent identities.
          const target = items.find(i => i.identity.provider === payload.provider && i.identity.conversation === payload.conversation)?.identity;
          if (!target) throw Object.assign(new Error('目标会话未接入，不能创建草稿'), {code: 'CONVERSATION_NOT_FOUND'});
          const created = drafts.create({
            target, text: validateDraftText(payload.text, config.max_reply_chars),
            source: typeof payload.source === 'string' ? payload.source.slice(0, 200) : null
          });
          respond(res, 201, created);
          return true;
        }
        if (id && !action && req.method === 'GET') {
          respond(res, 200, drafts.get(id));
          return true;
        }
        if (id && action && req.method === 'POST') {
          if (action === 'revise') {
            const payload = await readBody(req);
            respond(res, 200, drafts.revise(id, payload.expectedRevision, validateDraftText(payload.text, config.max_reply_chars)));
            return true;
          }
          if (action === 'cancel') {
            respond(res, 200, drafts.cancel(id));
            return true;
          }
          // Stage 1.4 wires the trusted Runtime approval; until then there is no
          // executable confirmation and never a fake "sent" (architecture §7).
          respond(res, 409, {error: '发送确认还没有接通消息服务，草稿已保留，你可以在微信里手动发送', state: drafts.get(id).state});
          return true;
        }
        respond(res, 405, {error: 'Method not allowed'});
        return true;
      }
      return false;
    } catch (error) {
      const status = {DRAFT_NOT_FOUND: 404, CONVERSATION_NOT_FOUND: 404, CRM_NOT_FOUND: 404, DRAFT_REVISION_CONFLICT: 409,
        DRAFT_CLOSED: 409, DRAFT_INVALID_TEXT: 400, CRM_INVALID: 400, INBOX_BAD_FILTER: 400, INBOX_CURSOR_STALE: 409,
        CONTEXT_NOT_FOUND: 404, CONTEXT_INVALID: 400, CONTEXT_CONFLICT: 409, CONTEXT_REVISION_CONFLICT: 409,
        WORKER_UNAVAILABLE: 503, WORKER_ERROR: 502, ASSISTANT_BUSY: 409, ASSISTANT_TIMEOUT: 504}[error.code] ?? 400;
      respond(res, status, {error: error.message, code: error.code ?? 'PRODUCT_API_ERROR'});
      return true;
    }
  };
}
