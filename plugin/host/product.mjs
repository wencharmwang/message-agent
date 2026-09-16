import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Drafts, readBindings, validateDraftText } from './storage.mjs';
import { RuntimeAdapter } from './runtime.mjs';
import { createCrm } from './crm.mjs';
import { CLASSIFICATIONS, ORDERS, SCOPES, createMessageCenter } from './message-center.mjs';
import { classifyIntent, detectRiskTags, maxRiskGrade, DEFAULT_DECISION_POLICY } from './reply-context/risk-gate.mjs';
import { fetchPageText, splitKnowledge } from './reply-context/import.mjs';

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
  // 读一个会话必须先打开它，会挤走用户正在看的那个。用户在用微信时助手主动退让，
  // 这属于正常礼让而不是故障——旧文案让人以为系统坏了。
  wechat_in_use: '你正在微信里操作，助手为了让开不打扰你，先暂停了这次读取；等你离开微信（或停手几秒）它会自动继续。',
  conversation_not_found: '微信当前显示的聊天列表里没有这个联系人。',
  contact_not_found: '微信里没有找到这个联系人，请核对名字是否和微信里显示的一致。',
  conversation_unverified: '没能在微信里确认打开的就是这个会话，所以这次没有读取（这是助手的安全检查，避免读到别人的聊天）。把微信窗口拉宽一点、让左边列表里的名字完整显示，再点一次「读取这条会话」；名字太长被省略号截断时容易发生。',
  foreground_unavailable: '没能在微信里完成这一步，本次操作没有执行。',
  // The window itself could not be read: minimized, fully covered, or a capture surface
  // that came back blank. The driver reports this as a missing conversation-list divider,
  // which says nothing to a user, so it is spelled out here.
  layout_unverified: '现在读不到微信窗口（可能被最小化、被其他窗口完全挡住，或者窗口被拖得太窄看不到聊天列表）。把微信主窗口恢复成正常大小、显示出来，助手会自动重试，不用一直点。',
  layout_changed: '微信窗口在读取时变了大小，这一次跳过，助手会自动重试。',
  window_unavailable: '找不到微信主窗口，请确认微信没有退出、也没有收进托盘。',
  capture_failed: '截取微信窗口失败，请确认微信窗口正常显示，助手会自动重试。',
  // Codes the runtime uses when a read was refused for a reason that is not a window
  // problem. They were missing from this map, so `Runtime: conversation_not_visible`
  // lost its code in stripRuntimeNoise and collapsed into "操作没有完成，请稍后重试。" —
  // a sentence that tells nobody anything. Every code that can reach the browser needs
  // its own plain sentence here.
  conversation_not_visible: '这个会话现在不在微信可见的聊天列表里（多半被滚到下面了）。把它滑回可见位置，助手就能读到。',
  tool_failed: '助手调用读取接口没有成功，这次没有读到内容，会自动重试。',
  provider_error: '微信驱动这次返回了错误，没有读到内容，助手会自动重试。',
  protocol_error: '助手和消息服务的连接出了问题，会自动重试。',
  // OCR. `ocr_failed` reaching the browser means BOTH recognizers gave up: the primary local
  // RapidOCR service failed and the Windows OCR fallback was not usable either. Reading the
  // conversation list and the chat body are both OCR, so this is the code behind most
  // 「读不到消息」 reports — it needs to say what it is instead of the generic sentence.
  ocr_failed: '这次没能读出微信窗口里的文字（本机 OCR 出错，备用的系统识别也没成功）。助手会自动重试，不用一直点；如果一直这样，请检查本地 OCR 服务。',
  ocr_unavailable: '本机没有可用的文字识别（OCR），助手读不了微信里的字。请检查本地 OCR 组件是否装好。',
  send_button_disabled: '发送按钮变灰说明消息已经发出，不需要再确认。',
  // 剩下这一批是核对 runtime 源码里所有 WindowAutomationException 码之后补上的：它们都能
  // 到达浏览器，却都没有句子，于是 `Runtime: xxx` 被剥成空串后统一掉进兜底句。**漏一个码
  // = 一句「操作没有完成」**，所以 CODE_RE 改成由这张表的键自动生成，不再手工维护。
  window_occluded: '微信窗口被别的窗口盖住了，助手没有做任何点击。把微信露出来再试一次。',
  window_changed: '读取过程中窗口位置或大小变了，这一次跳过，助手会自动重试。',
  invalid_target: '要点的位置已经不在微信窗口里（窗口大小变了之后常会这样），这一次没有点。助手会自动重试。',
  input_failed: '助手没能把输入送进微信，这一次没有执行。助手会自动重试。',
  foreground_lost: '微信窗口不在最前面，助手没有发送任何按键。让微信保持在前台再试一次。',
  conversation_changed: '读取期间对方又发了消息，会话内容变了，这一次跳过。助手会自动重试。',
  search_unavailable: '助手用微信搜索定位联系人时没有成功，这一次跳过，会自动重试。',
  ambiguous_contact: '微信里有多个同名联系人，助手分不清是哪一个。请给其中一个改名或加备注。',
  ambiguous_conversation: '微信可见列表里有多个同名会话，助手分不清是哪一个。请给其中一个改名或加备注。',
  background_unavailable: '这个微信窗口不接受后台输入，助手需要把它切到前台才能操作，这一次没有执行。',
  background_key_unsupported: '当前微信版本不支持后台按键，助手需要把微信切到前台才能操作。',
  background_text_unsupported: '当前微信版本不支持后台逐字输入，助手需要把微信切到前台才能打字。',
  not_sent: '这条消息没有发出去，助手不会自动重发。',
  uncertain: '发送结果暂时无法确认，请不要重复发送。'
};
/**
 * Derived from the table above, never hand-written.
 *
 * The hand-maintained list this replaces had already drifted: 13 codes the runtime really
 * throws were missing from it, and each one silently collapsed into the generic sentence.
 * Now every entry in RUNTIME_MESSAGES is matchable the moment it is added — a new code can
 * be forgotten in exactly one place instead of two, and the one place is the table that
 * gives it its sentence.
 */
const CODE_RE = new RegExp('\\b(' + Object.keys(RUNTIME_MESSAGES).join('|') + ')\\b');

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
  // The Worker collapses every Host HTTPError into one sentence (agent_worker/harness.py).
  // It is an internal failure with no user action behind it, so it must not reach the UI as
  // English — nor should the user be told to "go check" something they cannot check.
  [/Harness generation failed/i, '助手内部出错，这条消息没有处理，也没有发出任何回复'],
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
 * Developer diagnostics — the launch switch for it.
 *
 * "读不到消息" is undiagnosable from the product side while every layer replaces the real
 * failure with a friendlier sentence: the runtime's own explanation is dropped, the stack
 * is swallowed by a bare `catch {}`, and all that reaches the browser is "操作没有完成".
 * With this on, the raw code, the runtime's wording and the call stack travel alongside
 * the friendly message and get written to a log file. `dev_diagnostics: false` in
 * config.json (or the toggle in the UI) turns all of it off at launch — nothing else has
 * to change, and the friendly sentences stay exactly as they are.
 */
export function devDiagnosticsEnabled(config) {
  return config?.dev_diagnostics !== false;
}

export const DEV_LOG_FILE = 'dev-errors.log';

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
 * 批量导入知识（spec §5.2 录入方式的补充）。用户的产品与政策通常早就存在——脑子里的经验、
 * 写好的文档、在线文档、网站条款，逼他一条条手敲效率太低。这里把一段文本或一个网址切成条目，
 * 统一以 draft 落库（发布仍需人工确认），风险等级取导入时选定的统一值。
 * dryRun 只返回切分预览，不落库。
 */
async function importKnowledge(context, workspaceId, payload = {}) {
  const { text, url, kind = 'faq', riskLevel = 'low', dryRun = false, mode = 'auto' } = payload ?? {};
  let body = typeof text === 'string' ? text : '';
  let sourceType = 'paste';
  let sourceRef = '';
  if (!body.trim() && typeof url === 'string' && url.trim()) {
    const page = await fetchPageText(url);
    body = page.text;
    sourceType = 'url';
    sourceRef = url.trim().slice(0, 200);
  }
  if (!body.trim()) throw Object.assign(new Error('请粘贴要导入的内容，或填一个网址'), { code: 'IMPORT_EMPTY' });
  const items = splitKnowledge(body, { mode });
  if (!items.length) throw Object.assign(new Error('没切出可用内容，请检查粘贴的内容'), { code: 'IMPORT_EMPTY' });
  if (dryRun) return { items, total: items.length, sourceType, sourceRef };
  const created = items.map(item => context.knowledge.create(workspaceId, {
    kind, title: item.title, content: item.content, riskLevel, sourceType, sourceRef
  }));
  return { created: created.length, total: items.length, items: created, sourceType, sourceRef };
}

/**
 * "今天要做的" projection (architecture §8): what the assistant could not decide on its
 * own, what is waiting for your send confirmation, and everything you wrote down
 * yourself. Finished work stays folded at the bottom as a receipt, not a task.
 */
export function projectToday({items = [], drafts = [], todoBuckets = {overdue: [], today: [], later: [], someday: []}, jobs = [], deferred = [], now = Date.now() / 1000} = {}) {  const decide = [];
  // Deferred conversations are the user's own "not now" — they belong to today's list,
  // not to the queue, but they must stay reachable from where they came from.
  for (const entry of deferred) {
    decide.push({
      id: 'deferred:' + entry.key, kind: 'conversation', conversationKey: entry.key,
      identity: entry.identity, title: '稍后再处理：' + entry.identity.title,
      detail: (entry.summary ?? []).join('　') || '你把它放进了稍后处理。',
      attentionKind: 'deferred', updatedAt: entry.updatedAt
    });
  }
  for (const item of items) {
    if (item.bucket !== 'pending' || item.attentionKind === 'draft') continue;
    decide.push({
      id: 'conversation:' + item.key, kind: 'conversation', conversationKey: item.key,
      identity: item.identity,
      // The contact name belongs in the title. The client used to print it again in front of
      // the row's buttons, which pushed each row's buttons to a different x depending on how
      // long the name was — and the row is easier to scan when every title names the contact.
      title: [item.identity?.title, item.attentionReason || '需要你处理'].filter(Boolean).join('：'),
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
export function createProductApi({config, token, conversations, bindingsPath, respond, readBody, ensureInteractiveSession, askAssistant, crm: crmInjected, context: contextSystem, messageCenter: messageCenterInjected, classifyMessages, draftReply, analyzeStyle}) {
  const runtime = new RuntimeAdapter({controlPort: config.control_port, token});
  const drafts = new Drafts(join(dirname(config.database), 'drafts.json'));
  const crm = crmInjected ?? createCrm(join(dirname(config.database), 'crm.db'));
  const context = contextSystem ?? null;
  const center = messageCenterInjected
    ?? createMessageCenter({databasePath: join(dirname(config.database), 'inbox.db'), identityKey});
  // Bounded background work for the message centre. Both budgets exist because every
  // read opens a WeChat chat: doing them all at once would take the screen over.
  const TRIAGE_BUDGET = 2;
  // One conversation per poll when the user opted into background body reads. Opening a chat
  // is visible and clears its unread badge, so it never happens in bulk.
  const BODY_READ_BUDGET = 1;
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

  // ---- developer diagnostics -------------------------------------------------
  const devEnabled = devDiagnosticsEnabled(config);
  const devLogPath = join(dirname(config.database), DEV_LOG_FILE);
  /**
   * Append one JSONL line per failure. A file is the point: the UI shows one error at a
   * time and the interesting ones (a read that failed three polls ago, why a batch came
   * back "无法判断") scroll away, so the log is what makes them addressable afterwards.
   * Logging must never be able to break a request, hence the bare catch.
   */
  function devLog(where, error, extra = {}) {
    if (!devEnabled) return;
    const entry = {
      at: new Date().toISOString(),
      where,
      code: error?.code ?? error?.dev?.code ?? null,
      message: String(error?.message ?? error ?? ''),
      detail: error?.detail || error?.dev?.detail || '',
      trace: error?.dev?.trace || '',
      ...extra
    };
    try { appendFileSync(devLogPath, JSON.stringify(entry) + '\n'); } catch { /* never break a request for a log line */ }
    try { console.error('[dev]', where, entry.code, entry.message); } catch { /* console may be gone */ }
  }
  /** The raw fragment attached to an API response, or undefined when the switch is off. */
  function devPayload(error, where, extra = {}) {
    if (!devEnabled) return undefined;
    return {
      code: error?.code ?? error?.dev?.code ?? 'PRODUCT_API_ERROR',
      message: String(error?.message ?? ''),
      detail: error?.detail || error?.dev?.detail || '',
      trace: error?.dev?.trace || '',
      where,
      at: new Date().toISOString(),
      ...extra
    };
  }

  /**
   * Fire-and-forget that can never take the process down.
   *
   * `void someAsync()` looks harmless, but nothing handles its rejection: Node 22 treats an
   * unhandled rejection as fatal and exits, and this Node process is the user's entire
   * application — they see the page die and fall back to the DSH developer UI, having only
   * clicked 「读取这条会话」. Every background task goes through here instead, so a failed
   * catch-up is a log line and the page keeps working.
   */
  function background(label, promise) {
    Promise.resolve(promise).catch(error => devLog(label, error));
  }

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

  // ---- message centre plumbing -------------------------------------------
  function openTodoCounts() {
    const map = new Map();
    for (const todo of crm.listTodos({state: 'open'})) {
      if (!todo.conversationKey) continue;
      map.set(todo.conversationKey, (map.get(todo.conversationKey) ?? 0) + 1);
    }
    return map;
  }
  function pendingDraftCounts() {
    const map = new Map();
    for (const draft of drafts.list()) {
      if (draft.state !== 'awaiting_confirmation') continue;
      const key = identityKey(draft.target.provider, draft.target.conversation);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }
  let lastCenterScanAt = 0;
  /** Fold each worker discovery pass into the centre exactly once. No extra WeChat read. */
  async function syncCenter() {
    const [status, observation] = await Promise.all([runtime.status(), runtime.observe()]);
    const scannedAt = Number(observation.scanned_at ?? 0);
    // Both the queue and the selected detail poll this cached result. Counting those HTTP
    // reads as separate observations let one noisy OCR frame satisfy the settling quorum
    // without WeChat ever changing.
    const result = scannedAt > lastCenterScanAt
      ? center.sync({providers: observation.providers ?? {}, at: scannedAt})
      : {changed: 0, opened: 0, rekeyed: []};
    if (scannedAt > lastCenterScanAt) lastCenterScanAt = scannedAt;
    // OCR re-read a contact under a new name → the centre re-keyed it; keep the CRM on the
    // same identity so a customer's to-dos and follow-ups never orphan under the stale id.
    for (const entry of result.rekeyed ?? []) {
      crm.rekey(entry.oldKey, entry.newKey, {provider: entry.provider, conversation: entry.conversation, displayName: entry.name});
    }
    return {status, observation};
  }
  function centerExtra(status) {
    return {rules: status?.rules ?? [], openTodos: openTodoCounts(), pendingDrafts: pendingDraftCounts()};
  }
  function requireActivity(key) {
    const detail = center.detail(key);
    return detail.activity;
  }
  /**
   * The message centre can hold conversations that have no automatic-reply rule, so the
   * CRM lookup cannot go through projectInbox (which only knows ruled conversations).
   * Identity here comes from the centre's own observation, which is the single source
   * of truth for "who is this conversation".
   */
  function ensureCustomerFor(identity, key) {
    const existing = crm.getCustomer(key);
    if (existing) return existing;
    crm.ensureCustomer({key, provider: identity.provider, conversation: identity.conversation,
      displayName: identity.title, kind: identity.kind});
    return crm.getCustomer(key);
  }

  // ---- manual send (architecture §7) --------------------------------------
  /** Map a Runtime send status to a draft state and one honest sentence. */
  const SEND_OUTCOMES = {
    sent: {state: 'sent', message: '已经发出去了。'},
    uncertain: {state: 'uncertain', message: RUNTIME_MESSAGES.uncertain},
    approval_required: {state: 'approval_required', message: '这条需要你在消息服务里批准后才会发出。'},
    not_sent: {state: 'not_sent', message: RUNTIME_MESSAGES.not_sent},
    rejected: {state: 'not_sent', message: '这条没有发出。'},
    sending: {state: 'sending', message: '正在发送。'}
  };
  function sendOutcome(status) {
    return SEND_OUTCOMES[status] ?? SEND_OUTCOMES.uncertain;
  }
  /** Resolve a display identity without requiring an automatic-reply rule. */
  async function resolveIdentity(provider, conversation) {
    const key = identityKey(provider, conversation);
    try {
      const activity = center.detail(key).activity;
      return {provider, conversation, title: activity.display_name, kind: activity.kind};
    } catch { /* not in the centre yet */ }
    const observation = await runtime.observe().catch(() => ({}));
    const row = observation.providers?.[provider]?.[conversation];
    return {provider, conversation, title: row?.name || conversation, kind: 'direct'};
  }
  async function classifyOne(key) {
    if (!classifyMessages) return null;
    const detail = center.detail(key);
    const row = detail.activity;
    const identity = {provider: row.provider, conversation: row.conversation, title: row.display_name, kind: row.kind};
    try {
      const result = await classifyMessages({
        identity,
        messages: detail.messages,
        contact: crm.getCustomer(key),
        openLoops: crm.listTodos({state: 'open', conversationKey: key}),
        now: new Date()
      });
      center.applyClassification(key, result);
      // "无法判断" has two very different causes: the model abstained on thin content, or
      // it never received any content at all. Only the second is a reading bug, so the
      // number of readable messages is recorded next to the reason.
      if (result?.classification === 'unknown') {
        devLog('triage:unknown', {code: 'TRIAGE_UNKNOWN', message: result.reason ?? ''},
          {key, title: row.display_name, readableMessages: detail.messages.length});
      }
      return result;
    } catch (error) {
      // Without this the batch simply stays unclassified and the row reads 待判断 forever,
      // with the reason discarded by the caller's bare catch.
      center.markClassificationFailed(key, {
        code: error?.code ?? 'TRIAGE_FAILED',
        detail: error?.dev?.detail || error?.detail || '',
        message: String(error?.message ?? error)
      });
      devLog('triage', error, {key, title: row.display_name});
      return null;
    }
  }
  let pumping = false;
  /**
   * Bounded, sequential catch-up work for whatever the queue just showed.
   *
   * It only classifies snapshots that already exist. Opening a WeChat chat is never a
   * background side effect of polling the page; body reads happen only after explicit
   * read, draft, or ask actions initiated by the user.
   */
  async function pumpTriage() {
    if (pumping) return;
    pumping = true;
    try {
      for (const key of center.pendingClassification(TRIAGE_BUDGET)) {
        // classifyOne already records its own failure; this guard exists so one bad batch
        // cannot stop the rest of the queue from being classified.
        try { await classifyOne(key); } catch (error) { devLog('triage:unexpected', error, {key}); }
      }
    } finally {
      pumping = false;
    }
  }
  let bodyPumping = false;
  /**
   * Opt-in background body reading — the switch the settings page shows as
   * 「消息正文按需读取」. With it on, the assistant opens one unread conversation per poll so
   * the summary and the four-way classification are ready by the time the user looks, instead
   * of waiting for them to click.
   *
   * It is a real, visible cost that the user opted into: opening a chat clears its unread
   * badge in WeChat and moves what they are looking at. So it is one conversation per cycle,
   * never a conversation they stopped following, and `wechat_in_use` / unreadable-window
   * failures simply leave the candidate pending for the next poll rather than fighting the
   * user for the foreground.
   */
  async function pumpBodyReads() {
    if (bodyPumping || !center.readBodiesEnabled()) return;
    bodyPumping = true;
    try {
      for (const row of center.pendingBackgroundRead(BODY_READ_BUDGET)) {
        try {
          const page = await runtime.readConversation({provider: row.provider, conversation: row.conversation});
          const attached = center.attachSnapshot(row.conversation_key, page.messages);
          if (!attached.messages.length) {
            devLog('body-read:empty', {code: 'READ_EMPTY_RESPONSE', message: 'runtime 返回了 0 条可读消息'},
              {key: row.conversation_key});
          }
          await classifyOne(row.conversation_key);
        } catch (error) {
          // Expected and benign: the user is working in WeChat right now, or the window is
          // not readable. Record the failure so the next poll backs off instead of clicking
          // this conversation's row again five seconds later.
          center.markReadFailed(row.conversation_key);
          devLog('body-read', error, {key: row.conversation_key});
        }
      }
    } finally {
      bodyPumping = false;
    }
  }
  /**
   * The message centre API (product design §14). Every route works on the conversation
   * key, which is the same identity the CRM, drafts and automatic rules already use, so
   * one contact means one record everywhere.
   */
  async function handleMessageCenter(req, res, url) {
    const rest = url.pathname.replace('/message-agent/api/message-center', '');
    const parts = rest.split('/').filter(Boolean);
    const key = parts[0] && /^[0-9a-f]{64}$/.test(parts[0]) ? parts[0] : null;
    const action = key ? (parts[1] ?? null) : null;

    if (!key && req.method === 'GET' && parts.length === 0) {
      const {status, observation} = await syncCenter();
      const scope = url.searchParams.get('scope') ?? 'attention';
      if (!SCOPES.includes(scope)) throw Object.assign(new Error('未知的范围：' + scope), {code: 'INBOX_BAD_FILTER'});
      const order = url.searchParams.get('order') ?? (scope === 'attention' ? 'priority' : 'recent');
      if (!ORDERS.includes(order)) throw Object.assign(new Error('未知的排序：' + order), {code: 'INBOX_BAD_FILTER'});
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '30', 10) || 30, 1), 50);
      const page = center.list({scope, order, limit, cursor: url.searchParams.get('cursor') ?? undefined, extra: centerExtra(status)});
      respond(res, 200, {
        ...page, scope, order, generatedAt: Date.now() / 1000,
        observing: observation.level !== 'off',
        readBodies: center.readBodiesEnabled(),
        observationError: observation.error || '',
        // Plain sentence for the banner, so a stalled list is explained instead of
        // silently showing stale rows. `error_detail` is the runtime's own wording.
        observationMessage: observation.error
          ? (humanizeDetail(observation.error) || RUNTIME_MESSAGES[observation.error] || '暂时读不到微信，助手会自动重试。') : '',
        observationDetail: observation.error_detail || '',
        // Developer view only: the runtime's own wording and the stack behind it. Gated
        // here rather than in the browser so a launched build never ships them at all.
        observationTrace: devEnabled ? (observation.error_trace || '') : '',
        devDiagnostics: devEnabled,
        scannedAt: observation.scanned_at ?? 0,
        counts: {...page.counts, openTodos: crm.counts().open ?? 0}
      });
      // Progressive catch-up: at most a couple of reads and classifications per poll, so
      // the queue fills in without ever occupying WeChat for long. Body reading is a
      // separate, opt-in budget — it is the only background work that opens a chat.
      // Both go through `background`: a failed catch-up must never take the app down.
      background('pump:triage', pumpTriage());
      background('pump:body-read', pumpBodyReads());
      return true;
    }
    if (!key && req.method === 'GET' && parts[0] === 'preferences') {
      respond(res, 200, {read_bodies: center.readBodiesEnabled()});
      return true;
    }
    if (!key && req.method === 'POST' && parts[0] === 'preferences') {
      const payload = await readBody(req);
      if (typeof payload.read_bodies === 'boolean') center.setPreference('read_bodies', payload.read_bodies ? '1' : '0');
      if (typeof payload.observe_enabled === 'boolean') await runtime.setObserving(payload.observe_enabled);
      respond(res, 200, {read_bodies: center.readBodiesEnabled()});
      return true;
    }
    if (!key) { respond(res, 404, {error: 'Not found'}); return true; }

    const row = requireActivity(key);
    const identity = {provider: row.provider, conversation: row.conversation, title: row.display_name, kind: row.kind};

    if (!action && req.method === 'GET') {
      const detail = center.detail(key);
      const {status} = await syncCenter();
      const item = center.list({scope: 'all', order: 'recent', limit: 50, extra: centerExtra(status)})
        .items.find(entry => entry.key === key) ?? null;
      const customer = ensureCustomerFor(identity, key);
      respond(res, 200, {
        ...detail, item, identity, customer,
        followups: crm.listFollowups(key),
        todos: crm.listTodos({conversationKey: key}),
        drafts: drafts.list(identity),
        counts: crm.counts(),
        devDiagnostics: devEnabled
      });
      return true;
    }
    if (action === 'read' && req.method === 'POST') {
      // The one place a chat is opened on demand. WeChat clears that chat's unread badge
      // as a side effect, which is why this is a user action and not a background habit.
      const page = await runtime.readConversation({provider: row.provider, conversation: row.conversation});
      const attached = center.attachSnapshot(key, page.messages);
      // A read that succeeds but returns nothing readable is the confusing case: nothing
      // raises, yet the conversation sits there with no content and classifies as 无法判断.
      if (!attached.messages.length) {
        devLog('read:empty', {code: 'READ_EMPTY_RESPONSE', message: 'runtime 返回了 0 条可读消息'},
          {key, title: row.display_name,
           rawMessages: Array.isArray(page.messages) ? page.messages.length : String(page.messages)});
      }
      background('classify:after-read', classifyOne(key));
      respond(res, 200, {
        messages: attached.messages, newCount: attached.count,
        devDiagnostics: devEnabled,
        ...(devEnabled ? {dev: {where: 'message-center/read',
          rawMessages: Array.isArray(page.messages) ? page.messages.length : 0,
          readableMessages: attached.messages.length, at: new Date().toISOString()}} : {})
      });
      return true;
    }
    if (action === 'ask' && req.method === 'POST') {
      const payload = await readBody(req);
      if (!askAssistant) throw Object.assign(new Error('助手暂时不可用'), {code: 'WORKER_UNAVAILABLE'});
      // Bind the interactive assistant to the message-centre key, which remains stable
      // even when OCR re-reads the same WeChat display name under a different runtime id.
      const iKey = 'message-center:' + key;
      const existing = conversations.entries[iKey];
      const sessionId = existing ?? 'messaging-center-' + key;
      const answer = await askAssistant({sessionId, identity, text: payload.text});
      if (!existing) conversations.bind(iKey, sessionId);
      respond(res, 200, {...answer, sessionId});
      return true;
    }
    if (action === 'seen' && req.method === 'POST') {
      await readBody(req).catch(() => ({}));
      center.markSeen(key);
      respond(res, 200, {ok: true, state: 'seen'});
      return true;
    }
    if (action === 'defer' && req.method === 'POST') {
      const payload = await readBody(req).catch(() => ({}));
      center.defer(key, {note: payload.note ?? ''});
      respond(res, 200, {ok: true, state: 'deferred'});
      return true;
    }
    if (action === 'complete' && req.method === 'POST') {
      const payload = await readBody(req).catch(() => ({}));
      center.complete(key, {note: payload.note ?? ''});
      respond(res, 200, {ok: true, state: 'done'});
      return true;
    }
    if (action === 'reclassify' && req.method === 'POST') {
      const payload = await readBody(req);
      if (!CLASSIFICATIONS.includes(payload.classification)) throw Object.assign(new Error('未知的分类'), {code: 'CONTEXT_INVALID'});
      const batch = center.reclassify(key, {classification: payload.classification, reason: payload.reason ?? ''});
      respond(res, 200, {ok: true, classification: batch.classification});
      return true;
    }
    if (action === 'todos' && req.method === 'POST') {
      const payload = await readBody(req);
      const customer = ensureCustomerFor(identity, key);
      const todo = crm.createTodo({
        conversationKey: customer.key, title: payload.title, detail: payload.detail,
        evidence: payload.evidence, source: payload.source === 'assistant' ? 'assistant' : 'message',
        dueAt: payload.dueAt
      });
      center.linkAction(key, 'todo', {linkedObjectId: todo.id, note: payload.title});
      respond(res, 201, todo);
      return true;
    }
    if (action === 'followup' && req.method === 'POST') {
      const payload = await readBody(req);
      const customer = ensureCustomerFor(identity, key);
      const followup = crm.addFollowup(customer.key, {kind: '记录', note: payload.note, evidence: payload.evidence});
      center.linkAction(key, 'followup', {linkedObjectId: followup.id, note: payload.note});
      respond(res, 201, followup);
      return true;
    }
    if (action === 'drafts' && req.method === 'POST') {
      if (!draftReply) throw Object.assign(new Error('助手暂时不能拟稿'), {code: 'WORKER_UNAVAILABLE'});
      const detail = center.detail(key);
      // Drafting from an empty window would invite the model to invent the conversation,
      // so read it first — the user asked for a reply, which makes opening it expected.
      let messages = detail.messages;
      if (!messages.length) {
        const page = await runtime.readConversation({provider: row.provider, conversation: row.conversation});
        messages = center.attachSnapshot(key, page.messages).messages;
      }
      const rule = (await runtime.status()).rules?.find(entry => entry.provider === row.provider && entry.conversation === row.conversation) ?? null;
      const generated = await draftReply({
        identity, conversationKey: key,
        rule: rule ?? {provider: row.provider, conversation: row.conversation, title: row.display_name, kind: row.kind, prompt: ''},
        contextData: {messages},
        recentDeliveries: drafts.list(identity).filter(draft => draft.state === 'sent').slice(0, 3)
      });
      const created = drafts.create({
        target: identity, text: validateDraftText(generated.text, config.max_reply_chars), source: 'message-center'
      });
      center.linkAction(key, 'draft', {linkedObjectId: created.id});
      respond(res, 201, {...created, evidence: generated.evidence ?? null});
      return true;
    }
    if (action === 'follow' && req.method === 'POST') {
      const payload = await readBody(req).catch(() => ({}));
      center.setFollowing(key, payload.following !== false);
      respond(res, 200, {ok: true, following: payload.following !== false});
      return true;
    }
    respond(res, 405, {error: 'Method not allowed'});
    return true;
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
        await syncCenter().catch(() => {});
        respond(res, 200, projectToday({
          items, drafts: drafts.list(), jobs: status.jobs ?? [],
          todoBuckets: crm.todoBuckets(), deferred: center.deferred(), now: Date.now() / 1000
        }));
        return true;
      }
      // ---- message centre (product design §14) ------------------------------
      if (path === '/message-agent/api/message-center' || path.startsWith('/message-agent/api/message-center/')) {
        await handleMessageCenter(req, res, url);
        return true;
      }
      // ---- reply-context system (spec §13) ---------------------------------
      if (path === '/message-agent/api/context' || path.startsWith('/message-agent/api/context/')) {
        if (!context) { respond(res, 503, {error: '回复上下文系统未启用'}); return true; }
        const ws = context.workspaceId;
        const parts = path.replace('/message-agent/api/context', '').split('/').filter(Boolean);
        const [resource, id, action] = parts;

        if (resource === 'profiles') {
          // 从聊天分析生成说话方式（spec §5.1 的录入补充）。读取真实会话、归纳用户自己的
          // 说话习惯，落成一份 draft 说话方式并默认绑定到该会话——不 active 就不生效。
          if (id === 'analyze' && !action && req.method === 'POST') {
            if (!analyzeStyle) throw Object.assign(new Error('分析能力暂不可用'), {code: 'WORKER_UNAVAILABLE'});
            const payload = await readBody(req);
            const provider = typeof payload.provider === 'string' ? payload.provider : 'wechat-main';
            if (typeof payload.conversation !== 'string' || !payload.conversation) {
              throw Object.assign(new Error('请先选一个要分析的会话'), {code: 'CONTEXT_INVALID'});
            }
            const identity = await resolveIdentity(provider, payload.conversation);
            const page = await runtime.readConversation({provider, conversation: payload.conversation});
            const result = await analyzeStyle({identity, messages: page.messages});
            const profile = context.profiles.create(ws, {name: result.name, rules: result.rules});
            let binding = null;
            if (payload.bind !== false) {
              binding = context.profiles.bind(ws, {profileId: profile.id, scopeType: 'conversation', scopeKey: identityKey(provider, payload.conversation)});
            }
            respond(res, 201, {profile, binding, summary: result.summary, outgoingCount: result.outgoingCount});
            return true;
          }
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
          // 批量导入要抢在 create 之前判断：路径里的 'import' 会被解析成 id。
          if (id === 'import' && !action && req.method === 'POST') {
            respond(res, 200, await importKnowledge(context, ws, await readBody(req)));
            return true;
          }
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
      const customer = path.match(/^\/message-agent\/api\/customers(?:\/([0-9a-f]{64})(?:\/(followups|delete)(?:\/([0-9a-f-]{36}))?)?)?$/);
      if (customer) {
        const [, key, section, followupId] = customer;
        const followups = section === 'followups';
        if (!key && req.method === 'GET') {
          respond(res, 200, {items: crm.listCustomers(), counts: crm.counts()});
          return true;
        }
        // Deleting the contact also removes the follow-ups and to-dos recorded under it.
        if (key && section === 'delete' && req.method === 'POST') {
          respond(res, 200, {ok: true, deleted: crm.deleteCustomer(key)});
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
          if (action === 'confirm') {
            // The real send loop (architecture §7). origin=user_request tells Runtime the
            // user just confirmed this exact draft, so no second review is invented.
            const payload = await readBody(req).catch(() => ({}));
            const before = drafts.get(id);
            // Idempotency by state: a settled draft just reports its true state, never resends.
            if (before.state === 'sent' || before.state === 'uncertain' || before.state === 'sending'
                || before.state === 'approval_required' || before.state === 'not_sent') {
              respond(res, 200, {...before, alreadySettled: true});
              return true;
            }
            let claimed;
            try {
              claimed = drafts.submit(id, payload.expectedRevision);
            } catch (error) {
              if (error.code === 'DRAFT_CLOSED' || error.code === 'DRAFT_REVISION_CONFLICT') {
                respond(res, 409, {error: error.message, code: error.code, state: drafts.get(id).state});
                return true;
              }
              throw error;
            }
            let receipt;
            try {
              receipt = await runtime.sendMessage({
                provider: claimed.target.provider, conversation: claimed.target.conversation,
                text: claimed.text, requestId: claimed.requestId
              });
            } catch {
              receipt = {status: 'uncertain'};
            }
            const outcome = sendOutcome(receipt?.status);
            // A refused send carries the runtime's own code (e.g. conversation_not_found);
            // turn it into one plain sentence instead of the generic "not sent".
            const codedDetail = receipt?.status === 'not_sent' || receipt?.code || receipt?.detail
              ? humanizeDetail(receipt?.code || receipt?.detail || '') : '';
            const settled = drafts.settle(id, outcome.state, {receipt: receipt ?? null, detail: codedDetail || outcome.message});
            respond(res, 200, {...settled, status: receipt?.status ?? 'uncertain'});
            return true;
          }
          respond(res, 405, {error: 'Method not allowed'});
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
      // Every message that reaches the user goes through the same humanizer, so a raw runtime
      // code (conversation_unverified, layout_unverified, …) never shows up verbatim. When the
      // message was nothing BUT runtime noise, fall back to the code's own sentence, then to a
      // plain sentence — never to the raw text.
      const friendly = humanizeDetail(error.message) || RUNTIME_MESSAGES[error.code] || '操作没有完成，请稍后重试。';
      // Record first, answer second: the log line is the only artefact that survives the
      // next refresh, and it names the route so a failure can be reproduced.
      devLog('api:' + path, error, {method: req.method, status});
      const dev = devPayload(error, 'api:' + path, {method: req.method, status, friendly: friendly !== error.message ? friendly : ''});
      respond(res, status, {error: friendly, code: error.code ?? 'PRODUCT_API_ERROR', ...(dev ? {dev} : {})});
      return true;
    }
  };
}
