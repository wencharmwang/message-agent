import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Drafts, readBindings, validateDraftText } from './storage.mjs';
import { RuntimeAdapter } from './runtime.mjs';
import { createCrm } from './crm.mjs';
import { CLASSIFICATIONS, ORDERS, SCOPES, createMessageCenter, isSystemEntry } from './message-center.mjs';
import { classifyIntent, detectRiskTags, maxRiskGrade, DEFAULT_DECISION_POLICY } from './reply-context/risk-gate.mjs';
import { fetchPageText, splitKnowledge } from './reply-context/import.mjs';
import { buildBundle, homeOverview, parseOrganizeAnswer, renderChatContext, renderOrganizePrompt,
         stamp, CHAT_SYSTEM, ORGANIZE_SYSTEM } from './home.mjs';

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
  // Not "check that the window is displayed": the window is usually fine, and the read had
  // already passed the window-health check by the time this is thrown. What actually happens
  // is that a Qt window (WeChat's search popup, or a re-created main window) was replaced
  // between being located and being captured, so the handle was already dead. Telling the
  // user to go fix a healthy window sends them after the wrong thing.
  capture_failed: '读取微信窗口画面时窗口正好被重建，这次没读到内容，助手会重新定位窗口后重试。',
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
    // 这条提醒能不能被"我知道了"消掉。只有来自**某条未确认的失败/不确定记录**的提醒才
    // 消得掉；规则本身被拦住（blocked / waiting_connection）是状态问题，标一句"看过了"
    // 也解决不了，所以那里不给按钮 —— 否则按钮点了没反应，比没有按钮更糟。
    let acknowledgeable = false;
    if (rule.status === 'blocked' || rule.status === 'waiting_connection' || openProblem) {
      bucket = 'error';
      acknowledgeable = !!openProblem;
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
      acknowledgeable,
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
 * 「待办」projection (architecture §8) —— 界面上这一页就叫「待办」。
 *
 * 这一页现在只回答一个问题：**我要做什么**。所以只有三块内容 —— 待办（要做/在做）、
 * 等你确认发送的回复、以及做完之后的回执。原来还有一块「需要你决定」，是拿模型给消息
 * 打的分类（需要回复 / 只需了解…）当任务列出来：那既不是用户记下的事，模型判断错的时候
 * 还会把一条跟自己无关的群聊塞进今天要做的事里（用户实测报的就是这个，原话「我都不知道
 * 是什么」「为什么会提示我今天要做」）。分类不再面向用户，这一块也就没有存在的理由。
 *
 * 自动回复真正卡住、需要人处理的那种情况不属于"分类"，它仍然要能看见 —— 但不再占一块
 * 分类区，只由界面用一行指路（counts.automation）。
 */
/**
 * 按用户拖出来的顺序排规则。纯函数，方便单独测。
 *
 * 清单里没有的规则（新加的）排到**后面**，而不是被丢掉或跑到最前 —— 新加的监听默认是
 * 暂停状态，不该抢走用户刻意排定的位置。
 */
export function orderRules(rules, order) {
  if (!Array.isArray(order) || !order.length) return rules;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...rules].sort((a, b) => (rank.get(a.id) ?? order.length) - (rank.get(b.id) ?? order.length));
}

export function projectToday({items = [], drafts = [], todoBuckets = {overdue: [], today: [], later: [], someday: []}, jobs = [], completed = [], doneTodos = [], dismissed = [], now = Date.now() / 1000} = {}) {
  const confirm = drafts.filter(d => d.state === 'awaiting_confirmation').map(d => ({
    id: 'draft:' + d.id, kind: 'draft', draftId: d.id, revision: d.revision,
    conversationKey: identityKey(d.target.provider, d.target.conversation),
    identity: d.target, title: '发给「' + d.target.title + '」的回复', detail: d.text,
    expiresAt: d.expiresAt, updatedAt: d.updatedAt
  }));
  const dueState = {overdue: 'overdue', today: 'today', later: 'later', someday: 'someday'};
  const openTodos = [];
  for (const [bucketName, list] of Object.entries(todoBuckets)) {
    for (const todo of list ?? []) {
      openTodos.push({...todo, kind: 'todo', id: 'todo:' + todo.id, todoId: todo.id, dueState: dueState[bucketName] ?? 'someday'});
    }
  }
  // 「在做」排到最前：正在推进的那件比还没开始的更该在视线里。sort 在现代 V8 里是稳定的，
  // 所以同一组内部原来的排序（逾期 → 今天 → 以后 → 没有日期）不会被这次重排打乱。
  openTodos.sort((a, b) => (a.state === 'doing' ? 0 : 1) - (b.state === 'doing' ? 0 : 1));
  // **做完的待办不再留在「待办」这一组**：它已经完成，混在"要做/在做"里只会让人一眼数不清
  // 还剩几件（用户原话「已完成的放在已完成就行了，不要再展示在上面」）。它们统一进下面的
  // 「已完成」，用状态标签表达结果，不划删除线 —— 横线是"取消"的语义，不是"做完了"。
  const todos = openTodos;
  // 「已完成」原来只列助手的作业。用户自己点掉的那些（标为已看 / 处理完了）一条都不出现，
  // 于是"已完成"这件事在两处都查不到。现在合并成一张回执，每行写清**谁**把它处理成了什么样。
  const identityByRule = new Map(items.map(item => [item.rule.id, item]));
  const handled = [];
  const seen = new Set();
  for (const job of [...jobs].sort((a, b) => (b.finished_at ?? b.created_at ?? 0) - (a.finished_at ?? a.created_at ?? 0))) {
    const item = identityByRule.get(job.rule_id);
    if (!item || seen.has(item.key)) continue;
    if ((job.finished_at ?? 0) < now - 48 * 3600) continue;
    seen.add(item.key);
    handled.push({
      id: 'job:' + job.id, kind: 'handled', actor: 'assistant', conversationKey: item.key, identity: item.identity,
      title: item.identity.title, detail: job.text || humanizeDetail(job.detail) || '处理完了',
      state: job.state, updatedAt: job.finished_at || job.created_at
    });
  }
  for (const entry of completed ?? []) {
    if (!entry?.identity) continue;
    handled.push({
      id: 'done:' + entry.key, kind: 'handled', actor: 'you', conversationKey: entry.key,
      identity: entry.identity, title: entry.identity.title,
      detail: entry.action === 'complete' ? '处理完了' : '标为已看',
      state: 'done', updatedAt: entry.updatedAt
    });
  }
  // 做完的待办也收在这里。identity 可能为空（自己手记的待办没挂联系人），所以渲染侧要
  // 允许只有标题；也就是说这条回执说的是"哪件事做完了"，不一定是"跟谁的事"。
  // todoId 与 source 一起带上：前者是删除按钮要用的真 id，后者决定来源图标（星 = 助手记的）。
  for (const todo of doneTodos ?? []) {
    handled.push({
      id: 'todo:' + todo.id, kind: 'handled', actor: 'you', todo: true, todoId: todo.id,
      source: todo.source === 'assistant' ? 'assistant' : 'manual',
      conversationKey: todo.conversationKey ?? null,
      identity: todo.identity ?? null,
      title: todo.title, detail: '已完成',
      state: 'done', updatedAt: todo.doneAt ?? todo.updatedAt
    });
  }
  // 「已完成」里每一行都要能删掉。待办是真删（crm），其余两类是**处理回执**：它们记录的是
  // 客观发生过的事（助手处理过哪条消息、你把哪条标成已看），删不掉历史，所以是"从已完成里
  // 移除"—— 记在 dismissed.json 里，只影响这一份清单。
  const hidden = new Set(dismissed);
  // 做完的待办现在也在这张单子上，所以上限放宽一点：它是"回看"，不是"待办"。
  const receipts = handled.filter(entry => !hidden.has(entry.id))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 12);
  // 自动回复自己卡住了（规则被拦住、读不到微信）不属于"分类"，是故障，界面用一行指路。
  // 待确认的草稿不重复计：它在上面那块里有自己的位置。
  const automation = items.filter(item => item.bucket === 'pending' && item.attentionKind !== 'draft').length;
  return {
    groups: [
      {key: 'confirm', title: '等你确认发送', hint: '正文已经拟好，确认后才会发出', items: confirm},
      {key: 'todos', title: '待办', hint: '要做和在做；做完的收在下面的「已完成」', items: todos},
      {key: 'handled', title: '已完成', hint: '做完的待办，以及你和助手处理掉的消息', items: receipts}
    ],
    counts: {
      todos: openTodos.length, doing: openTodos.filter(todo => todo.state === 'doing').length,
      done: (doneTodos ?? []).length, confirm: confirm.length,
      overdue: (todoBuckets.overdue ?? []).length,
      automation,
      // 侧边栏红点数的就是这一项：还没做完的待办 + 等你确认的回复。
      attention: openTodos.length + confirm.length
    },
    generatedAt: now
  };
}

/**
 * Product business API under the existing same-origin /message-agent/api/ prefix
 * (architecture §6). Returns true when the request was handled. index.mjs applies
 * the same-origin guards before delegating here.
 */
export function createProductApi({config, token, runtime: runtimeInjected, conversations, bindingsPath, respond, readBody, ensureInteractiveSession, askAssistant, crm: crmInjected, context: contextSystem, messageCenter: messageCenterInjected, classifyMessages, draftReply, analyzeStyle, organizeMessages, judgeDuplicateTodos}) {
  const runtime = runtimeInjected ?? new RuntimeAdapter({controlPort: config.control_port, token});
  const drafts = new Drafts(join(dirname(config.database), 'drafts.json'));
  const crm = crmInjected ?? createCrm(join(dirname(config.database), 'crm.db'));
  const context = contextSystem ?? null;
  const center = messageCenterInjected
    ?? createMessageCenter({databasePath: join(dirname(config.database), 'inbox.db'), identityKey});
  // "I looked at it" is a host-side bookkeeping detail, not worker state: the delivery
  // record itself must stay untouched.
  const reviewedPath = join(dirname(config.database), 'reviewed.json');
  const reviewed = () => {
    try { return JSON.parse(readFileSync(reviewedPath, 'utf8')); } catch { return {}; }
  };
  /**
   * 「从已完成里移除」的记录。
   *
   * 已完成里有两类**回执**（助手处理过的消息、你标成已看的会话），它们记录的是客观发生过
   * 的事，删不掉也不该删 —— 但用户需要一个办法让它们从这份清单上消失（用户实测：
   * 「已完成这 2 条没有显示删除图标」）。所以这里只记 id，不碰任何事实数据。
   */
  const dismissedPath = join(dirname(config.database), 'dismissed.json');
  const dismissed = () => {
    try { const list = JSON.parse(readFileSync(dismissedPath, 'utf8')); return Array.isArray(list) ? list : []; }
    catch { return []; }
  };
  const dismiss = id => {
    const list = dismissed().filter(entry => entry !== id);
    list.push(id);
    writeFileSync(dismissedPath, JSON.stringify(list.slice(-800)));
    return list.length;
  };
  const markReviewed = ids => {
    const now = Date.now() / 1000;
    const merged = {...reviewed()};
    for (const id of ids) merged[id] = now;
    const kept = Object.fromEntries(Object.entries(merged).filter(([, at]) => now - at < 30 * 86400).slice(-500));
    writeFileSync(reviewedPath, JSON.stringify(kept));
    return ids.length;
  };
  /**
   * 「我知道了」：把这条规则上还没确认的失败/不确定记录标成已看过。
   *
   * 这是**唯一**能让提醒消失的动作。首页与自动回复页以前只有「去处理」这个跳转，跳过去
   * 也点不了任何东西，于是提醒一直挂着（用户实测报的就是这个）。
   * 它只是"看过了"，绝不代表重试：发送结果不确定的那条永远不会自动重发。
   */
  async function reviewRule(ruleId) {
    const status = await runtime.status();
    return markReviewed((status.jobs ?? [])
      .filter(job => job.rule_id === ruleId && (job.state === 'failed' || job.state === 'uncertain'))
      .map(job => job.id));
  }

  /**
   * 规则的展示顺序（用户拖出来的）。
   *
   * 放在 Host 侧一份纯 id 清单：Worker 的 rules 表不需要为"展示顺序"多一个字段，规则的
   * 增删也不受影响（不在清单里的规则按原顺序排到后面）。没拖过就是空清单，顺序不变。
   */
  const ruleOrderPath = join(dirname(config.database), 'rule-order.json');
  const readRuleOrder = () => {
    try { const list = JSON.parse(readFileSync(ruleOrderPath, 'utf8')); return Array.isArray(list) ? list : []; }
    catch { return []; }
  };
  const saveRuleOrder = ids => writeFileSync(ruleOrderPath, JSON.stringify(ids));
  const orderedRules = rules => orderRules(rules, readRuleOrder());

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
    for (const todo of crm.listActiveTodos()) {
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
  /**
   * Fold a discovery snapshot into the centre exactly once.
   *
   * The default path is cache-only and is safe for page polling.  ``refresh`` is used
   * exclusively by a user click and performs the one visible-list read for that action.
   */
  async function syncCenter({refresh = false} = {}) {
    const [status, observation] = await Promise.all([
      runtime.status(),
      refresh ? runtime.refreshObservation() : runtime.observe()
    ]);
    return foldObservation({status, observation});
  }

  /**
   * Fold one observation into the centre and keep the CRM on the same identity.
   *
   * Split out of syncCenter so a caller that already has both halves (the today page fetches
   * them in parallel) does not have to fetch them a second time just to reuse this.
   */
  function foldObservation({status, observation}) {
    const scannedAt = Number(observation?.scanned_at ?? 0);
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

  /** 最近完成掉的待办，供「待办」页在下面按打勾的样子回看。 */
  function doneTodosForToday() {
    return crm.listTodos({state: 'done', limit: 50})
      .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0))
      .slice(0, 6);
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
        openLoops: crm.listActiveTodos({conversationKey: key}),
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
        observing: false,
        mode: 'manual',
        readBodies: false,
        observationError: observation.error || '',
        // Plain sentence for the banner, so a stalled list is explained instead of
        // silently showing stale rows. `error_detail` is the runtime's own wording.
        observationMessage: observation.error
          ? '上次刷新没有读到微信会话列表；助手不会后台重试。' : '',
        observationDetail: observation.error_detail || '',
        // Developer view only: the runtime's own wording and the stack behind it. Gated
        // here rather than in the browser so a launched build never ships them at all.
        observationTrace: devEnabled ? (observation.error_trace || '') : '',
        devDiagnostics: devEnabled,
        scannedAt: observation.scanned_at ?? 0,
        counts: {...page.counts, openTodos: crm.counts().open ?? 0}
      });
      return true;
    }
    if (!key && req.method === 'POST' && parts[0] === 'refresh') {
      await readBody(req);
      const {status, observation} = await syncCenter({refresh: true});
      const page = center.list({scope: 'all', order: 'recent', limit: 50, extra: centerExtra(status)});
      respond(res, 200, {
        ok: true,
        scannedAt: observation.scanned_at ?? 0,
        visibleCount: Object.values(observation.providers ?? {})
          .reduce((total, rows) => total + Object.keys(rows ?? {}).length, 0),
        changed: page.counts.unread,
        observationError: observation.error || '',
        observationMessage: observation.error
          ? '这次没有读到微信会话列表，已经停止，不会在后台重试。' : ''
      });
      return true;
    }
    if (!key && req.method === 'POST' && parts[0] === 'organize') {
      const payload = await readBody(req);
      if (!askAssistant) throw Object.assign(new Error('助手暂时不可用'), {code: 'WORKER_UNAVAILABLE'});
      const text = typeof payload.text === 'string' ? payload.text.trim() : '';
      if (!text) throw Object.assign(new Error('写一句你想整理什么'), {code: 'CONTEXT_INVALID'});
      // Refreshing the visible list is cheap and does not open a conversation. Any body
      // read after this point is performed by the interactive agent because the user just
      // asked for this exact organisation task.
      const {status} = await syncCenter({refresh: true});
      // 候选会话用**显示名**给出去，而不是运行时 id。
      //
      // 微信只渲染当前可见的那十来行：被滚到下面的会话在 list_conversations 里根本不存在，而
      // wechat:<id> 本身不含名字 —— 运行时既定位不到它，也没有东西可以拿去搜索，于是直接报
      // conversation_not_found（实测「轮滑班群」就是这么失败的）。显示名是运行时唯一能交给
      // 微信全局搜索的东西，而全局搜索不受滚动位置影响。
      const candidates = center.list({scope: 'all', order: 'recent', limit: 12, extra: centerExtra(status)})
        .items.filter(item => item.identity?.title && !isSystemEntry(item.identity.title))
        .map(item => item.identity.title);
      const policy = [
        '这是用户主动发起的一次微信消息整理，不是后台监听。',
        '只为完成用户这次明确的要求读取必要的会话；优先读取最近、最相关的会话，最多 5 个。',
        candidates.length
          ? '要读哪个会话，用下面给出的**显示名**作为 conversation_id（例如 conversation_id: "张三"）。'
            + '运行时会用微信自己的搜索定位它，不受聊天列表滚动到哪的影响；'
            + '会话 id 只对当前正好显示在列表里的那几条有效，被滚下去的会直接读不到。'
          : '',
        '不要持续等待新消息，不要安排后台重试，不要发送任何微信消息。',
        // 用户主动发起的整理不会再因为"微信在使用中"被让开（交互式读取已不再让开），所以这里
        // 不能把失败归到那个原因上——工具报别的错时，模型照着这句会编出"你正在微信里操作"。
        '某个会话读不到时，跳过它继续整理已取得的信息；结论里用一句话带过"哪几条这次没读成"就够了。'
          + '不要教用户去点哪个按钮、不要把没读成的条目写成待办、不要编造失败原因、不要承诺"过一会儿就好"；'
          + '只有工具明确报了"用户正在微信里操作"时才可以说助手让开了。'
          + '也不要用会话列表的摘要凑内容：没读正文的不要写成事实。',
        '先给简短结论；需要用户做的事情用「- [ ] 」列出，最多 5 条。'
      ].filter(Boolean).join('\n');
      const answer = await askAssistant({
        sessionId: 'messaging-organizer',
        identity: {provider: 'wechat-main', conversation: '__organizer__', title: '消息整理', kind: 'workspace'},
        text: [
          policy,
          candidates.length
            ? '值得看的会话（按最近有动静排序，最多 12 个；名字可以直接当 conversation_id 用）：'
              + candidates.join('、')
            : '',
          '用户这次的要求：' + text
        ].filter(Boolean).join('\n\n')
      });
      respond(res, 200, answer);
      return true;
    }
    if (!key && req.method === 'GET' && parts[0] === 'preferences') {
      respond(res, 200, {read_bodies: false, mode: 'manual'});
      return true;
    }
    if (!key && req.method === 'POST' && parts[0] === 'preferences') {
      const payload = await readBody(req);
      // Older clients may still post these fields. Persist the safe value and never
      // re-enable a background reader.
      if ('read_bodies' in payload) center.setPreference('read_bodies', '0');
      if ('observe_enabled' in payload) await runtime.setObserving(false);
      respond(res, 200, {read_bodies: false, mode: 'manual'});
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
      const page = await runtime.readConversation({provider: row.provider, conversation: row.conversation,
        title: row.display_name});
      const attached = center.attachSnapshot(key, page.messages);
      if (attached.rekeyed) {
        crm.rekey(attached.rekeyed.oldKey, attached.rekeyed.newKey,
          {provider: row.provider, conversation: row.conversation, displayName: row.display_name});
      }
      // A read that succeeds but returns nothing readable is the confusing case: nothing
      // raises, yet the conversation sits there with no content and classifies as 无法判断.
      if (!attached.messages.length) {
        devLog('read:empty', {code: 'READ_EMPTY_RESPONSE', message: 'runtime 返回了 0 条可读消息'},
          {key, title: row.display_name,
           rawMessages: Array.isArray(page.messages) ? page.messages.length : String(page.messages)});
      }
      background('classify:after-read', classifyOne(attached.conversationKey));
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
    if (action === 'confirm-identity' && req.method === 'POST') {
      await readBody(req).catch(() => ({}));
      const confirmed = center.confirmIdentity(key);
      respond(res, 200, {ok: true, localIdentityId: confirmed.identity_id,
        identityStatus: confirmed.identity_status, identityConfidence: confirmed.identity_confidence});
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
      let conversationKey = key;
      if (!messages.length) {
        const page = await runtime.readConversation({provider: row.provider, conversation: row.conversation,
          title: row.display_name});
        const attached = center.attachSnapshot(key, page.messages);
        messages = attached.messages;
        conversationKey = attached.conversationKey;
        if (attached.rekeyed) {
          crm.rekey(attached.rekeyed.oldKey, attached.rekeyed.newKey,
            {provider: row.provider, conversation: row.conversation, displayName: row.display_name});
        }
      }
      const rule = (await runtime.status()).rules?.find(entry => entry.provider === row.provider && entry.conversation === row.conversation) ?? null;
      const generated = await draftReply({
        identity, conversationKey,
        rule: rule ?? {provider: row.provider, conversation: row.conversation, title: row.display_name, kind: row.kind, prompt: ''},
        contextData: {messages},
        recentDeliveries: drafts.list(identity).filter(draft => draft.state === 'sent').slice(0, 3)
      });
      const created = drafts.create({
        target: identity, text: validateDraftText(generated.text, config.max_reply_chars), source: 'message-center'
      });
      center.linkAction(conversationKey, 'draft', {linkedObjectId: created.id});
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

  // ---- 首页（本地数据库驱动）------------------------------------------------
  //
  // 这一组路由**全程不打开微信窗口**：数据来自本地解密数据库 + 本地规则/job 状态。
  // 「整理」是唯一会调模型的一条，而且模型的产物只是"建议"，落库仍由用户勾选决定。
  //
  // 为什么要重建这一层：旧的整理链路（message-center/organize）靠 OCR —— 先刷新可见
  // 列表拿到候选名，再让模型逐个 conversation_id 去读，读一次要开一次会话。识别不准、
  // 抢占前台、只能覆盖滚动的十来行，这正是当初把这块功能撤掉的原因。

  // ---- 语音转文字 -----------------------------------------------------------
  // 解码器（75 KB）随包走，识别模型（~470MB）由用户自己决定装不装 —— 所以状态要分开报：
  // "能不能解出声音"和"能不能听懂内容"是两件事。
  const voicePath = join(dirname(config.database), 'voice.json');
  const voicePrefs = () => {
    const raw = readJsonFile(voicePath, null);
    return {enabled: raw?.enabled === true, model: typeof raw?.model === 'string' ? raw.model : 'small'};
  };
  const voiceState = () => {
    const dataDir = dirname(config.database);
    // 本模块在 <安装目录>pp\plugin\host\ 下，往上三层就是安装目录
    // 本模块的位置有两种可能，往上几层是安装目录/仓库根都不一样：
    //   安装后：<安装目录>/app/plugin/host/product.mjs  -> 往上三层
    //   开发时：<仓库>/plugin/host/product.mjs          -> 往上两层
    // 两边都要认，否则在本机体验时会显示"缺组件"（实测踩到）。
    const here = dirname(fileURLToPath(import.meta.url));
    const roots = [join(here, '..', '..', '..'), join(here, '..', '..')];
    const hasFile = relative => roots.some(root => existsSync(join(root, relative)));
    const decoder = hasFile(join('components', 'silk', 'silk-decoder-x64.exe'))
      || hasFile(join('packaging', 'components', 'silk', 'silk-decoder-x64.exe'));
    const transcriber = existsSync(join(dataDir, 'voice', 'lib'))
      || existsSync(join(dataDir, 'voice', 'venv', 'Scripts', 'python.exe'));
    const prefs = voicePrefs();
    return {
      ...prefs, decoder, transcriber,
      // 开了开关但没装 = 不会生效，界面要直说，别让用户以为开了就行
      active: prefs.enabled && decoder && transcriber,
      hint: !transcriber
        ? '还没有装识别环境。右键运行安装目录里的 install-voice.ps1（约 470 MB，只下一次）。'
        : (!decoder ? '缺少语音解码组件，重新装一次消息助手可以补上。' : '')
    };
  };

  const organizePath = join(dirname(config.database), 'organize.json');
  const chatLogPath = join(dirname(config.database), 'chat-log.json');
  const readJsonFile = (path, fallback) => {
    try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
  };
  const writeJsonFile = (path, value) => {
    try { writeFileSync(path, JSON.stringify(value)); } catch { /* 展示用缓存，写不进去不影响主流程 */ }
  };
  /** DB 快照缓存：首页每 8 秒轮询，没必要每次都重扫分片。 */
  let dbCache = {at: 0, data: null};
  async function dbSnapshot({fresh = false, sessions = 12, perSession = 20, maxAge = 20} = {}) {
    const now = Date.now() / 1000;
    if (!fresh && dbCache.data && now - dbCache.at < maxAge) return dbCache.data;
    const raw = await runtime.dbRecent({sessions, perSession});
    const data = {account: raw?.account ?? '', scanAt: Number(raw?.scanned_at ?? 0),
                  bundle: buildBundle(raw), at: now};
    dbCache = {at: now, data};
    return data;
  }
  /**
   * 用 DB 身份 ensure 联系人记录。和 requireCustomer 的区别：**不需要该联系人先有
   * 自动回复规则** —— 首页面对的是全部会话，不是"已接入工作台"的那几个。
   */
  function ensureDbCustomer({username, title, kind}) {
    const key = identityKey('wechat-main', username);
    const identity = {provider: 'wechat-main', conversation: username,
                      title: title || username, kind: kind === 'group' ? 'group' : 'direct'};
    crm.ensureCustomer({key, ...identity, displayName: identity.title});
    return {key, identity};
  }
  /** 结束一次整理后的产物：只留展示需要的东西，并把显示名对回 username。 */
  function locate(bundle, title) {
    if (!title) return null;
    const exact = bundle.find(session => session.title === title);
    const loose = exact ?? bundle.find(session => session.title.includes(title) || title.includes(session.title));
    return loose ? {username: loose.username, kind: loose.kind} : null;
  }
  /**
   * 建议与待办的对应关系：判断"这条建议是不是已经处理过了"。
   *
   * 整理的痛点是**无状态**：每次都从同一批消息重新得出结论，于是已经记成待办、
   * 甚至已经做完的事，下一次整理又冒出来（用户实测报的就是这个）。这里按标题做匹配，
   * 匹配上就从建议里拿掉 —— 用户要看的是**还没做的事**，不是重复清单。
   *
   * 匹配故意放宽一点（去掉标点空白后相等，或一方包含另一方）：模型换个说法重写同一条
   * 是很常见的，措辞差异不该让去重失效。
   */
  const normalizeSuggestion = value => String(value ?? '')
    .replace(/[\s，。、；：！？,.;:!?~～\-—…"'「」『』（）()【】\[\]]/g, '').trim();

  function sameSuggestion(left, right) {
    const a = normalizeSuggestion(left), b = normalizeSuggestion(right);
    if (!a || !b) return false;
    if (a === b) return true;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    return shorter.length >= 8 && longer.includes(shorter);
  }

  /**
   * 把建议里"已经处理过的"摘掉，并告诉界面摘掉了几条。
   * 摘掉的口径：待办列表里存在同名条目（**不论是未完成还是已完成** —— 前者说明已经记下了，
   * 后者说明已经做完了，两种都不该再提醒一次）。
   */
  function reconcileSuggestions(result, todos) {
    if (!result || !Array.isArray(result.todos) || !result.todos.length) return result;
    const open = (todos ?? crm.listTodos({limit: 500})).map(todo => ({title: todo.title, state: todo.state}));
    const kept = [];
    let hidden = 0;
    for (const item of result.todos) {
      const done = open.some(todo => sameSuggestion(todo.title, item.title));
      if (done) { hidden++; continue; }
      kept.push({...item, alreadyAdded: false});
    }
    return {...result, todos: kept, hiddenCount: hidden};
  }

  /**
   * 让模型判断"这条建议是不是已经记过的同一件事"。
   *
   * 为什么字符串匹配不够：用户实测——
   *   已有待办：「回复 Wencharm，说明看不到链接内容并请其文字说明」
   *   这次建议：「回复 Wencharm，说明能否处理语音并回应链接」
   * 两句话没有一个词能对上（"看不到链接"vs"能否处理语音"），但要做的是同一件事。
   * 于是用户觉得自己被耍：明明记过了，又被提醒一次。
   *
   * 规则：**判重失败就保持原样**。多提一次只是烦，把真正要做的事吞掉是错。
   */
  async function semanticReconcile(result, todos) {
    const items = result?.todos ?? [];
    if (!items.length || !judgeDuplicateTodos) return result;
    const existing = (todos ?? []).map(todo => todo.title).filter(Boolean).slice(0, 40);
    if (!existing.length) return result;
    try {
      const drop = await judgeDuplicateTodos({existing, suggestions: items.map(item => item.title)});
      if (!drop.length) return result;
      return {
        ...result,
        todos: items.filter((_, index) => !drop.includes(index)),
        hiddenCount: (result.hiddenCount || 0) + drop.length
      };
    } catch (error) {
      return result;
    }
  }

  async function homePayload() {
    const {account, scanAt, bundle} = await dbSnapshot();
    const {items} = await aggregate();
    const automation = items.filter(item => item.bucket === 'error'
      || (item.bucket === 'pending' && item.attentionKind !== 'draft'));
    const todos = crm.listTodos({limit: 200});
    return homeOverview({
      bundle, todos, automation, account, scanAt,
      lastOrganize: reconcileSuggestions(readJsonFile(organizePath, null), todos), now: Date.now() / 1000
    });
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
          // 哪些记录已经被「知道了」处理过。首页那张卡片走的是 projectInbox（内部会过滤），
          // 但自动回复页是直接渲染 status.jobs 的 —— 不给这个名单，点了按钮记录也不会消失。
          reviewedJobs: Object.keys(reviewed()),
          // 规则的顺序由用户自己拖出来（监听一多，没法定出"最重要的"就没法用）。
          // 排序在 Host 侧做：Worker 的 rules 表不需要为"展示顺序"多一个字段。
          rules: orderedRules(status.rules ?? []).map(rule => ({...rule, detail: humanizeDetail(rule.detail)})),
          jobs: (status.jobs ?? []).map(job => ({...job, detail: humanizeDetail(job.detail)}))
        });
        return true;
      }
      // 微信数据库密钥：状态查询 + **用户授权后**读一次。
      // 这套密钥只能从微信进程内存里取，所以"读一次"必须由人点按钮触发；这里只做转发，
      // 真正的读取在 Worker 里（同一份实现，安装程序也用它）。
      if (path === '/message-agent/api/wechat-keys' && req.method === 'GET') {
        const {keys} = await runtime.wechatKeys();
        respond(res, 200, {keys: keys ?? null});
        return true;
      }
      if (path === '/message-agent/api/wechat-keys' && req.method === 'POST') {
        const payload = await readBody(req);
        if (payload?.action && payload.action !== 'scan') {
          throw Object.assign(new Error('不支持的操作'), {code: 'CONTEXT_INVALID'});
        }
        const result = await runtime.scanWechatKeys({force: !!payload?.force});
        respond(res, 200, result);
        return true;
      }
      // 模型供应商：目录（GET）+ 配置一家（POST）。
      //
      // 用户的要求：不能只有一个 key 的输入框，得能选供应商、支持主流模型。
      // 目录放在 Worker 那边（那里能读到引擎的 settings.yaml），Host 只负责转发 +
      // 把 key 设进自己的 process.env —— harness 解析凭据时进程环境变量优先、且每次现读，
      // 所以设完立刻生效，不用重启。
      if (path === '/message-agent/api/model-providers' && req.method === 'GET') {
        const {providers, configured} = await runtime.modelProviders();
        respond(res, 200, {providers: providers ?? [], configured: configured ?? []});
        return true;
      }
      if (path === '/message-agent/api/model-provider' && req.method === 'POST') {
        const payload = await readBody(req);
        const result = await runtime.setModelProvider({
          provider: payload?.provider, key: typeof payload?.key === 'string' ? payload.key.trim() : '',
          baseUrl: typeof payload?.baseUrl === 'string' ? payload.baseUrl.trim() : '',
          model: typeof payload?.model === 'string' ? payload.model.trim() : ''
        });
        if (result?.keyEnv && result?.key) process.env[result.keyEnv] = result.key;
        respond(res, 200, {ok: true, provider: result?.provider, name: result?.name, message: result?.message});
        return true;
      }
      // 保存云端模型的 API key。
      //
      // 为什么保存完就能用、不需要重启：harness 解析凭据时**进程环境变量优先**，而且是每次
      // 调用现读（`credentials-local` 的注释就是这么写的）。Host 自己就是那个进程，所以在
      // 这里设一次 process.env 立刻生效 —— 用户不用理解"重启"这件事。
      // 落盘仍旧交给 Worker 走 Windows 密钥保护，磁盘上不留明文。
      if (path === '/message-agent/api/model-key' && req.method === 'POST') {
        const payload = await readBody(req);
        const key = typeof payload?.key === 'string' ? payload.key.trim() : '';
        if (key.length < 12 || /\s/.test(key)) {
          throw Object.assign(new Error('这串 key 看起来不对（太短或含空格）'), {code: 'CONTEXT_INVALID'});
        }
        await runtime.setModelKey({key});
        process.env.DEEPSEEK_API_KEY = key;
        respond(res, 200, {ok: true, provider: 'deepseek-official'});
        return true;
      }
      // 语音转文字：只是用户的偏好 + 本机装没装，读写都很轻，不碰微信。
      if (path === '/message-agent/api/voice' && req.method === 'GET') {
        respond(res, 200, voiceState());
        return true;
      }
      if (path === '/message-agent/api/voice' && req.method === 'POST') {
        const payload = await readBody(req);
        const prefs = voicePrefs();
        if (typeof payload?.enabled === 'boolean') prefs.enabled = payload.enabled;
        if (typeof payload?.model === 'string' && payload.model.trim()) prefs.model = payload.model.trim();
        writeJsonFile(voicePath, prefs);
        respond(res, 200, voiceState());
        return true;
      }
      // 拖拽/置顶之后的顺序。只存 id 顺序，不碰规则本身。
      if (path === '/message-agent/api/rules/order' && req.method === 'POST') {
        const payload = await readBody(req);
        const ids = Array.isArray(payload.ids) ? payload.ids.filter(id => typeof id === 'string' && id) : null;
        if (!ids) throw Object.assign(new Error('缺少规则顺序'), {code: 'CONTEXT_INVALID'});
        saveRuleOrder(ids.slice(0, 500));
        respond(res, 200, {ok: true, order: ids.slice(0, 500)});
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
        // 这两件事互不依赖，串行做等于把两次 loopback 的延迟相加 —— 而这一页每次打开、每 8 秒
        // 轮询都吃这份延迟（实测串行 0.6–0.8s，且会跟着 Worker 的轮询抖动）。并发后只取较大值，
        // 而且顺手省掉了一次重复的 /api/status。
        const [{status, items}, observation] = await Promise.all([
          aggregate(),
          runtime.observe().catch(() => null)
        ]);
        foldObservation({status, observation: observation ?? {}});
        respond(res, 200, projectToday({
          items, drafts: drafts.list(), jobs: status.jobs ?? [],
          todoBuckets: crm.todoBuckets(),
          completed: center.completedRecent(), doneTodos: doneTodosForToday(),
          dismissed: dismissed(), now: Date.now() / 1000
        }));
        return true;
      }
      // 「已完成」里那些处理回执的删除入口（待办走 /api/todos/<id>/delete，是真的删）。
      if (path === '/message-agent/api/receipts/dismiss' && req.method === 'POST') {
        const payload = await readBody(req);
        const id = typeof payload.id === 'string' ? payload.id.trim().slice(0, 160) : '';
        if (!id) throw Object.assign(new Error('缺少要移除的那条记录'), {code: 'CONTEXT_INVALID'});
        respond(res, 200, {ok: true, id, dismissed: dismiss(id)});
        return true;
      }
      // ---- 首页（本地数据库驱动，不打开微信窗口）-----------------------------
      //
      // 顺序有讲究：/api/home 与 /api/home/organize、/api/home/conversation 都是同一
      // 前缀，必须用全等判断，不能只 startsWith。
      if (path === '/message-agent/api/home' && req.method === 'GET') {
        respond(res, 200, await homePayload());
        return true;
      }
      if (path === '/message-agent/api/home/organize' && req.method === 'POST') {
        await readBody(req).catch(() => ({}));
        if (!organizeMessages) throw Object.assign(new Error('整理能力暂不可用'), {code: 'WORKER_UNAVAILABLE'});
        const {account, scanAt, bundle} = await dbSnapshot({fresh: true, sessions: 12, perSession: 30});
        if (!bundle.length) {
          throw Object.assign(new Error('本地数据库里没有读到可整理的会话，先确认微信已登录过、数据库已解锁'),
            {code: 'ORGANIZE_EMPTY'});
        }
        // 已经处理过的条目（用户记成待办、或已经做完的）。提示词用它劝模型别重复，
        // 落库前的过滤用它兜底 —— 整理的"记忆"就是这份待办列表，不需要另存一份状态。
        const handled = crm.listTodos({limit: 200}).map(todo => todo.title);
        const result = await organizeMessages({bundle, prompt: renderOrganizePrompt(bundle, {handled})});
        const located = {
          summary: result.summary,
          focus: result.focus.map(item => ({...item, ...(locate(bundle, item.conversation) ?? {})})),
          todos: result.todos.map(item => ({...item, ...(locate(bundle, item.conversation) ?? {})})),
          account, scannedAt: scanAt, sessionsRead: bundle.length, at: Date.now() / 1000
        };
        // 落库前先把"已经处理过的"摘掉：提示词只能劝，这一步才是保证。
        // 两道：先按标题做便宜的字面过滤，再让模型判"是不是同一件事"（措辞不同也算）。
        const todos = crm.listTodos({limit: 500});
        const byText = reconcileSuggestions(located, todos);
        writeJsonFile(organizePath, await semanticReconcile(byText, todos));
        respond(res, 200, readJsonFile(organizePath, located));
        return true;
      }
      // 会话 key（sha256）-> 本地数据库身份（username）。待办、草稿、跟进记录里存的是 key，
      // 而读消息要的是 username；这一跳只在服务端做，界面不猜。
      if (path === '/message-agent/api/home/lookup' && req.method === 'GET') {
        const key = url.searchParams.get('key') ?? '';
        const customer = key ? crm.getCustomer(key) : null;
        if (!customer) throw Object.assign(new Error('找不到这个联系人，可能它已经被删掉了'), {code: 'CONVERSATION_NOT_FOUND'});
        respond(res, 200, {...customer.identity, username: customer.identity.conversation, conversationKey: key});
        return true;
      }
      // 一个会话的正文与它身上的待办 / 跟进 / 待确认草稿。全部按 DB username 定位。
      if (path === '/message-agent/api/home/conversation' && req.method === 'GET') {
        const username = url.searchParams.get('username') ?? '';
        if (!username) throw Object.assign(new Error('请指定要查看的会话'), {code: 'CONTEXT_INVALID'});
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '60', 10) || 60, 5), 300);
        const page = await runtime.readConversationFromDb({username, limit});
        const {key, identity} = ensureDbCustomer({
          username,
          title: page?.display || url.searchParams.get('title') || username,
          kind: username.endsWith('@chatroom') ? 'group' : 'direct'
        });
        respond(res, 200, {
          username, conversationKey: key, identity,
          messages: (page?.messages ?? []).filter(message => message.content),
          customer: crm.getCustomer(key),
          todos: crm.listTodos({conversationKey: key}),
          followups: crm.listFollowups(key),
          drafts: drafts.list(identity).filter(draft => draft.state === 'awaiting_confirmation')
        });
        return true;
      }
      // ---- 与消息助手对话 --------------------------------------------------
      //
      // 会话复用同一个 harness session（messaging-home），模型侧靠它保持上下文；这里的
      // chat-log.json 只供界面显示，是恢复刷新前那几轮问答用的。
      if (path === '/message-agent/api/chat' && req.method === 'GET') {
        respond(res, 200, readJsonFile(chatLogPath, {items: []}));
        return true;
      }
      if (path === '/message-agent/api/chat' && req.method === 'PATCH') {
        writeJsonFile(chatLogPath, {items: []});
        respond(res, 200, {items: []});
        return true;
      }
      if (path === '/message-agent/api/chat' && req.method === 'POST') {
        const payload = await readBody(req);
        if (!askAssistant) throw Object.assign(new Error('助手暂时不可用'), {code: 'WORKER_UNAVAILABLE'});
        const question = typeof payload.text === 'string' ? payload.text.trim() : '';
        if (!question) throw Object.assign(new Error('先写一句想问的'), {code: 'CONTEXT_INVALID'});
        const {bundle} = await dbSnapshot();
        const answer = await askAssistant({
          sessionId: 'messaging-home',
          identity: {provider: 'wechat-main', conversation: '__home__', title: '消息', kind: 'workspace'},
          text: question, system: CHAT_SYSTEM, context: renderChatContext(bundle)
        });
        const at = Date.now() / 1000;
        const log = readJsonFile(chatLogPath, {items: []});
        const items = [...(log.items ?? []),
          {role: 'user', text: question, at},
          {role: 'assistant', text: answer.answer, at, tools: answer.tools ?? []}].slice(-40);
        writeJsonFile(chatLogPath, {items});
        respond(res, 200, {...answer, items});
        return true;
      }
      // 首页与自动回复页共用的「我知道了」。
      if (path === '/message-agent/api/automation/ack' && req.method === 'POST') {
        const payload = await readBody(req);
        const ruleId = typeof payload.ruleId === 'string' ? payload.ruleId : '';
        if (!ruleId) throw Object.assign(new Error('缺少要处理的规则'), {code: 'CONTEXT_INVALID'});
        respond(res, 200, {reviewed: await reviewRule(ruleId)});
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
            // 从解密后的本地 DB 读联系人消息分析（username 定位），不再 OCR 打开会话。
            const page = await runtime.readConversationFromDb({username: payload.conversation});
            if (page?.display && (!identity.title || identity.title === payload.conversation)) {
              identity.title = page.display;
            }
            const result = await analyzeStyle({identity, messages: page?.messages ?? []});
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
      const todo = path.match(/^\/message-agent\/api\/todos(?:\/([0-9a-f-]{36})(?:\/(done|doing|reopen|delete))?)?$/);
      if (todo) {
        const [, id, action] = todo;
        if (!id && req.method === 'GET') {
          // 默认给"还没做完的"（要做 + 在做）：客户端问的是「还有什么要做」，
          // 只给 open 会把正在做的那条漏掉。
          const state = url.searchParams.get('state');
          const conversationKey = url.searchParams.get('conversation') ?? undefined;
          respond(res, 200, {
            items: state ? crm.listTodos({state, conversationKey}) : crm.listActiveTodos({conversationKey}),
            counts: crm.counts()
          });
          return true;
        }
        if (!id && req.method === 'POST') {
          const payload = await readBody(req);
          let conversationKey = null;
          let identity = null;
          // 首页/整理出来的待办带的是 DB username，不是 message-centre 的 64 位 key：
          // 走 DB 身份 ensure，这样"还没接自动回复规则的联系人"也能挂上待办。
          //
          // 显示名必须单独给（conversationTitle）：这里 payload.title 是**待办标题**，
          // 拿它当联系人名会把档案里的备注改成"回复某某的报价"（踩过）。
          if (payload.username) {
            const scope = ensureDbCustomer({
              username: String(payload.username),
              title: payload.conversationTitle || crm.getCustomer(identityKey('wechat-main', String(payload.username)))?.identity?.title
                || String(payload.username),
              kind: payload.kind
            });
            conversationKey = scope.key;
            identity = scope.identity;
          } else if (payload.conversationKey) {
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
        if (id && (action === 'done' || action === 'doing' || action === 'reopen') && req.method === 'POST') {
          const payload = await readBody(req).catch(() => ({}));
          const next = action === 'reopen' ? 'open' : action;
          respond(res, 200, crm.setTodoState(id, next, payload?.dueAt));
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
          const {items} = await aggregate();
          const target = requireItem(items, key);
          respond(res, 200, {reviewed: await reviewRule(target.rule.id)});
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
