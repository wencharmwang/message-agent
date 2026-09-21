/**
 * 首页 / 消息整理 / 对话 —— 数据底座全部是**本地解密数据库**（wechat-db-lab 的
 * `plain/`），不打开微信窗口、不抢前台、不清未读。
 *
 * 这一层刻意只做三件纯事，方便单独测：
 *   1. 把 worker 的 `db_recent` 结果整理成页面要的 bundle；
 *   2. 用**确定性规则**算出「谁在等我回复」（不靠模型）；
 *   3. 把 bundle 渲染成提示词，并把模型的回答解析成结构化结果。
 *
 * 模型只负责"理解内容"（发生了什么、要做什么），不负责判断谁在等我 —— 那种判断一旦
 * 交给模型，就会出现"把一条跟我无关的群聊列成今天要做的事"这类错。
 */

const DAY = 86400;
/** 早于 2000 年的时间戳是微信里的占位值，不是真实活动。 */
const EPOCH_FLOOR = 946684800;

export function preview(text, limit = 60) {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim();
  return line.length > limit ? line.slice(0, limit) + '…' : line;
}

/**
 * 会话是否需要我回复：**最后一条是对方发的**。
 *
 * 这是唯一口径 —— 不用未读数（读过了但没回也算欠着），也不用模型分类。
 * 群聊里"最后一条是别人发的"从来都成立，所以群聊一律不算"等你回复"，
 * 否则每个活跃群都会常驻在待回复列表里。
 */
export function waitingForMe(session) {
  if (session.kind === 'group') return false;
  const incoming = session.lastIncomingAt || 0;
  if (incoming < EPOCH_FLOOR) return false;
  return incoming > (session.lastOutgoingAt || 0);
}

/** worker `db_recent` 的一条会话 -> 界面/提示词共用的 bundle。 */
export function buildBundle(db) {
  return (db?.sessions ?? []).map(raw => {
    const messages = (raw.messages ?? []).filter(message => message && message.content);
    const session = {
      username: raw.username,
      title: raw.title || raw.username,
      kind: raw.kind === 'group' ? 'group' : 'direct',
      unread: raw.unread || 0,
      summary: raw.summary || '',
      lastAt: raw.last_at || 0,
      lastIncomingAt: raw.last_incoming_at || 0,
      lastOutgoingAt: raw.last_outgoing_at || 0,
      messages
    };
    session.waitingReply = waitingForMe(session);
    return session;
  }).filter(session => session.lastAt >= EPOCH_FLOOR);
}

/** 稳定地把 秒 转成本地可读时间，交给模型时避免它自己算错。 */
export function stamp(seconds) {
  if (!seconds || seconds < EPOCH_FLOOR) return '';
  const date = new Date(seconds * 1000);
  return `${date.getMonth() + 1}月${date.getDate()}日 `
    + `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** 一段会话渲染成提示词里的一节。 */
function renderSession(session, perSession) {
  const head = `### ${session.title}（${session.kind === 'group' ? '群聊' : '单聊'}`
    + `，最近 ${stamp(session.lastAt)}${session.waitingReply ? '，最后一条是对方发的' : ''}）`;
  const lines = session.messages.slice(-perSession).map(message =>
    `- ${stamp(message.at)} ${message.direction === 'outgoing' ? '我' : '对方'}：${preview(message.content, 200)}`);
  return [head, ...(lines.length ? lines : ['- （这段时间没有可读的文本消息）'])].join('\n');
}

/** 会话清单渲染成提示词里的一段（不带正文，用于"谁在等我"这类问题）。 */
export function renderRoster(bundle, now = Date.now() / 1000) {
  if (!bundle.length) return '（本地数据库里没有可读的会话）';
  const lines = bundle.slice(0, 12).map(session =>
    `- ${session.title}｜${session.kind === 'group' ? '群聊' : '单聊'}｜最近 ${stamp(session.lastAt)}`
    + `｜${session.waitingReply ? '在等你回复' : '无需回复'}`
    + (session.lastAt > now - DAY ? '｜近一天有动静' : ''));
  return lines.join('\n');
}

/**
 * 一次整理最多塞多少个会话、每个会话多少条不重复的正文。
 *
 * 全部走 DB，条数上限只是为了让提示词可控，不是为了省微信操作 —— 上限之外的历史
 * 由模型自己用 read_local_messages 补。
 */
const ORGANIZE_SESSIONS = 8;
const ORGANIZE_PER_SESSION = 20;
const CHAT_SESSIONS = 8;
const CHAT_PER_SESSION = 10;

export const ORGANIZE_SYSTEM = [
  '你在帮用户整理微信消息。用户已经同意这次读取，数据来自本机微信数据库的真实记录（不是截图识别）。',
  '只输出一个 JSON 对象，不要代码块、不要解释、不要额外文字。格式：',
  '{"summary":"两三句话概括这段时间发生了什么","focus":[{"conversation":"显示名","why":"为什么需要用户关注，20 字以内","action":"建议的动作，20 字以内"}],"todos":[{"title":"用户本人要做的事，25 字以内","conversation":"相关显示名，没有就空字符串","detail":"依据：引一句最短的原文，40 字以内","duplicateOf":null}]}',
  '硬性要求：',
  '1) focus 只放"确实需要用户本人关注或回应"的人和群，最多 5 条；宁可少也不要凑数。',
  '2) todos 只放用户本人要动手做的事（回复谁、确认什么、交什么、什么时候），最多 5 条；'
    + '别人之间的约定、单纯的信息、已经被回复过的内容，一律不要写成待办。',
  '3) 时间、金额、承诺只能来自原文。原文里没有的不要编；拿不准就不写。',
  '4) 没有值得关注的内容时，focus 和 todos 给空数组，summary 直说最近没什么要处理的。',
  '5) conversation 必须用给定的显示名原样填写，不要改写、不要加"微信"前缀。',
  '6) 如果下面给了「用户已有的待办」清单（A1、A2…），每一条 todos 都必须填 duplicateOf：'
    + '这条建议和清单里某一条是**同一件事**就填那个编号（例如 "A2"），否则填 null。'
    + '判断看的是「要做的事」，不是措辞：同一个对话里「回复他，说明看不到链接内容」和'
    + '「回复他，说明能否处理语音并回应链接」是同一件事。一个笼统一个具体，只要指同一件事也算。'
    + '话题相同但要做的事不同（「回复他」和「给他发报价单」）→ 填 null。拿不准时填 null。'
    + '没有给清单时，duplicateOf 一律填 null。',
].join('\n');

/**
 * 整理提示词。
 *
 * `handled` 是**已经处理过的条目**（用户已经把它记成待办、或者已经做完了）。
 * 为什么必须告诉模型：整理是无状态的，每次都从同一批消息里重新得出结论，于是
 * "听 Wencharm 的三条语音" 这种建议会被反复提出来 —— 用户明明已经记了待办、甚至处理完了
 * （用户实测报的就是这个）。只靠事后过滤能挡住显示，但模型还是会花 token 重复生成，
 * 所以两头都做：提示词里说清"别再提"，结果里再把漏网的滤掉。
 */
export function renderOrganizePrompt(bundle, {now = Date.now() / 1000, handled = []} = {}) {
  const head = `现在是 ${stamp(now)}。以下是用户最近有动静的会话（按最近时间排序）：`;
  const body = bundle.slice(0, ORGANIZE_SESSIONS)
    .map(session => renderSession(session, ORGANIZE_PER_SESSION)).join('\n\n');
  const done = (Array.isArray(handled) ? handled : [])
    .map(item => String(item ?? '').trim()).filter(Boolean).slice(0, 20);
  const skip = done.length
    ? ['', '用户已有的待办（编号用于 duplicateOf，不要重复提出同一件事）：',
       ...done.map((item, index) => 'A' + (index + 1) + '. ' + item),
       '和清单里是同一件事的不要再写进 todos。'].join('\n')
    : '';
  return [head, '', body || '（没有可读的会话）', skip].filter(part => part !== '').join('\n');
}

const clamp = (value, limit) => String(value ?? '').trim().slice(0, limit);

/** 模型输出 -> {summary, focus[], todos[]}。解析失败抛错，绝不伪造结论。 */
export function parseOrganizeAnswer(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) throw Object.assign(new Error('整理结果不是可解析的结构'), {code: 'ORGANIZE_UNPARSABLE'});
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw Object.assign(new Error('整理结果解析失败'), {code: 'ORGANIZE_UNPARSABLE'});
  }
  const list = (value, limit) => (Array.isArray(value) ? value : []).slice(0, limit);
  const focus = list(parsed.focus, 5).map(item => ({
    conversation: clamp(item?.conversation, 60),
    why: clamp(item?.why, 60),
    action: clamp(item?.action, 60)
  })).filter(item => item.conversation || item.why);
  const todos = list(parsed.todos, 5).map(item => ({
    title: clamp(item?.title, 80),
    conversation: clamp(item?.conversation, 60),
    detail: clamp(item?.detail, 120),
    // 模型**在同一次调用里**标出"这条对应已有的哪一条待办"（A1/A2…）。
    // 拿它直接摘掉重复项，省掉一次单独的判重调用（用户指出那样效率低）。
    duplicateOf: typeof item?.duplicateOf === 'string' ? clamp(item.duplicateOf, 8) : null
  })).filter(item => item.title);
  return {summary: clamp(parsed.summary, 400), focus, todos};
}

export const CHAT_SYSTEM = [
  '你是一个专门处理微信消息的助手，只围绕用户的聊天记录工作。',
  '你**不需要**打开微信窗口去读消息：下面那一段快照直接来自本机微信数据库，是最新、完整的事实来源。',
  '只有当用户问的是快照之外的更早历史、或快照里没出现的联系人时，才用 read_local_messages 再读一次；'
    + '不要用需要打开微信窗口的那几个工具去核对快照内容。',
  '回答要求：先给结论，中文，简短直白；不要叙述你的过程、工具调用或内部状态；'
    + '不要出现 wxid、会话 id、错误码这类技术细节。',
  '需要用户本人做的事放在最后，每条以「- [ ] 」开头，最多 5 条；说明性的列表不要加中括号。'
].join('\n');

/** 对话用的 DB 快照。字符串化后按字符上限截断，避免把提示词撑爆。 */
export function renderChatContext(bundle, {now = Date.now() / 1000, budget = 7000} = {}) {
  const head = `【本地消息数据库快照】现在是 ${stamp(now)}。`
    + '下面每个会话都标注了最后一条是谁发的。';
  const roster = '会话清单：\n' + renderRoster(bundle, now);
  const chunks = [];
  let used = head.length + roster.length;
  for (const session of bundle.slice(0, CHAT_SESSIONS)) {
    const block = renderSession(session, CHAT_PER_SESSION);
    if (used + block.length > budget) break;
    used += block.length;
    chunks.push(block);
  }
  return [head, roster, chunks.join('\n\n')].filter(Boolean).join('\n\n');
}

/**
 * 首页概览。全部确定性计算，**不调模型、不读微信**，所以首屏是瞬间出来的。
 * `automation` 来自自动回复那一套（规则状态 + 未确认的失败）。
 */
export function homeOverview({bundle = [], todos = [], automation = [], account = '', scanAt = 0, lastOrganize = null,
                              now = Date.now() / 1000} = {}) {
  const waiting = bundle.filter(session => session.waitingReply);
  const recent = bundle.filter(session => session.messages.length || session.unread);
  const todayMessages = bundle.reduce((total, session) =>
    total + session.messages.filter(message => (message.at || 0) > now - DAY).length, 0);
  return {
    account,
    scanAt,
    generatedAt: now,
    totals: {
      conversations: bundle.length,
      reading: recent.length,
      waiting: waiting.length,
      todayMessages,
      todos: todos.filter(todo => todo.state !== 'done').length,
      doing: todos.filter(todo => todo.state === 'doing').length,
      automation: automation.length
    },
    waiting: waiting.slice(0, 6).map(publicSession),
    recent: recent.slice(0, 8).map(publicSession),
    todos: todos.filter(todo => todo.state !== 'done').slice(0, 5).map(todo => ({
      id: todo.id, title: todo.title, state: todo.state, dueAt: todo.dueAt ?? null,
      conversationKey: todo.conversationKey ?? null,
      who: todo.identity?.title ?? null
    })),
    automation: automation.slice(0, 6).map(item => ({
      key: item.key, ruleId: item.rule?.id ?? null, title: item.identity?.title ?? '',
      reason: item.attentionReason ?? '',
      // 只有"某条记录没确认"这种能靠"我知道了"消掉；规则自己被拦住的不给按钮。
      acknowledgeable: item.acknowledgeable === true
    })),
    lastOrganize
  };
}

function publicSession(session) {
  const last = session.messages.at(-1);
  return {
    username: session.username,
    title: session.title,
    kind: session.kind,
    lastAt: session.lastAt,
    unread: session.unread,
    waitingReply: session.waitingReply,
    preview: preview(last?.content ?? session.summary, 48),
    lastDirection: last?.direction ?? ''
  };
}
