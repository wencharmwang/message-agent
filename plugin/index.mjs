import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { DEFAULT_REPLY_STYLE, REPLY_POLICY_FIXED, modelContext, validateSubmission } from './reply-policy.mjs';
import { MEMORY_UPDATE_SYSTEM, buildMemoryPrompt, parseMemoryAnswer, applyMemories } from './host/reply-context/memory-update.mjs';
import { ConversationSessions, automaticRequestConfig, conversationKey, completedDecision } from './conversation-sessions.mjs';
import { createProductApi, identityKey } from './host/product.mjs';
import { RuntimeAdapter } from './host/runtime.mjs';
import { createCrm } from './host/crm.mjs';
import { createMessageCenter } from './host/message-center.mjs';
import { TRIAGE_SYSTEM, buildTriagePrompt, parseTriageAnswer } from './host/triage.mjs';
import { STYLE_SYSTEM, buildStylePrompt, parseStyleAnswer } from './host/style-analysis.mjs';
import { ORGANIZE_SYSTEM, parseOrganizeAnswer, preview, stamp } from './host/home.mjs';
import { createReplyContextSystem, renderContextPrompt } from './host/reply-context/index.mjs';

/**
 * 后台任务出错不能带走整个进程。
 *
 * Node 22 把「未处理的 Promise 拒绝」当致命错误**直接退出进程**，而这个 Node 进程就是用户的
 * 整个应用：进程一死，页面就崩掉、退回 DSH 自己的开发者界面 —— 而用户只是点了一下「读取这条
 * 会话」。后台任务已经在 product.mjs 里统一走 `background()`（自带 catch），这里是最后一道
 * 兜底：记下来，继续跑。
 *
 * 刻意**不**兜 `uncaughtException`：同步抛出的 bug 说明进程状态真的坏了，而这个产品会真的往
 * 外发消息，带着坏状态静默跑下去比崩掉更危险。
 */
process.on('unhandledRejection', reason => {
  try {
    console.error('[message-agent] 未处理的异步错误（已记录，进程继续）:', reason);
  } catch {
    // 连日志都写不出去时也不能再抛：那才是真正的崩。
  }
});

export const inject = ['webServer', 'agents', 'sessions', 'sessionQuery', 'sessionPersistence', 'agentPresets', 'workspaceRegistry', 'permissionPresets', 'sessionTitle', 'llm'];
const config = JSON.parse(readFileSync(process.env.MESSAGE_AGENT_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const token = readFileSync(config.control_token_file, 'utf8').trim();
const brandSymbol = readFileSync(new URL('./assets/brand/message-agent-symbol.svg', import.meta.url));
const { SessionId } = await import(pathToFileURL(join(config.harness_root, 'packages/core/session/src/index.ts')));
const { createUserMessage, BlockAssembler } = await import(pathToFileURL(join(config.harness_root, 'packages/llm/llm/src/index.ts')));
const { defineTool } = await import(pathToFileURL(join(config.harness_root, 'packages/core/tools/src/index.ts')));

function respond(res, code, body) {
  res.writeHead(code, {'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store'});
  res.end(JSON.stringify(body));
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Error('JSON required');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 100000) throw new Error('Request too large');
  }
  return JSON.parse(text);
}
function privateRequest(req) {
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

/** Upper-layer adapter: ordinary Harness Sessions plus a same-origin settings proxy. */
export function apply(ctx) {
  const active = new Map();
  const bindingsPath = join(dirname(config.database), 'conversation-sessions.json');
  const conversations = new ConversationSessions(bindingsPath);
  // 唯一一份 Worker 适配器：产品 API 与交互会话的 DB 工具共用它（两处各建一个也能跑，
  // 但那样 loopback 地址与超时就有两份，改一处忘一处）。
  const worker = new RuntimeAdapter({controlPort: config.control_port, token});
  /**
   * 交互会话专用的「从本机数据库读消息」工具。
   *
   * 预设自带的 messaging MCP 工具是 OCR 路线：要打开会话、会抢前台、只看得到列表里
   * 可见的十来行，识别不准时还会认错人。而这些会话的正文本来就在本地解密数据库里 ——
   * 补上这个工具，模型才有一条准确、快速、不打扰用户的路。
   *
   * 按 sessionId 去重：会话 resume 后 ctx 仍在，重复注册会撞工具名。
   */
  const DB_TOOL_SESSIONS = new Set();
  function attachDbTool(agentCtx, sessionId) {
    if (DB_TOOL_SESSIONS.has(sessionId)) return;
    DB_TOOL_SESSIONS.add(sessionId);
    try {
      agentCtx.tools.register(defineTool({
        name: 'read_local_messages',
        description: '从本机微信数据库直接读取某个联系人或群聊的最近消息：不打开微信窗口、不切前台、不比截图识别。'
          + '需要核对或补读某段聊天时优先用它；只有在数据库里确实找不到这个会话时才用消息运行时的工具。',
        parameters: {
          conversation: {type: 'string', required: true,
            description: '联系人或群聊的显示名（如「张三」「轮滑班群」），也可以直接给 wxid'},
          limit: {type: 'integer', description: '读取条数，默认 40，最多 200'}
        },
        output: {
          schema: {type: 'object', additionalProperties: false, properties: {text: {type: 'string', required: true}}},
          // **签名是 (args, value)**，不是 (result) —— 写成单参数时第二个参数永远取不到，
          // value.text 是 undefined，DSH 直接判"output.render returned non-lossless JSON"。
          render: (_args, value) => [{type: 'text', text: value.text}]
        },
        async execute(args) {
          const keyword = String(args?.conversation ?? '').trim();
          if (!keyword) throw new Error('请说明要读哪个联系人或群聊');
          const limit = Math.max(5, Math.min(Number.isInteger(args?.limit) ? args.limit : 40, 200));
          let username = keyword;
          let title = keyword;
          const found = await worker.searchContacts(keyword).catch(() => null);
          const list = found?.conversations ?? [];
          const hit = list.find(item => item.title === keyword) ?? list.find(item => item.id === keyword) ?? list[0];
          if (hit) {
            username = hit.id;
            title = hit.title;
          } else if (/[\u4e00-\u9fff]/.test(keyword)) {
            return {text: '本地数据库里没有找到「' + keyword + '」，请确认名字和微信里显示的一致。'};
          }
          const page = await worker.readConversationFromDb({username, limit});
          const messages = (page?.messages ?? []).filter(message => message.content);
          title = page?.display || title;
          if (!messages.length) return {text: '「' + title + '」在本地数据库里没有可读的文本消息。'};
          const lines = messages.map(message =>
            `${stamp(message.at)} ${message.direction === 'outgoing' ? '我' : '对方'}：${preview(message.content, 200)}`);
          return {text: `「${title}」最近 ${messages.length} 条消息（来自本机数据库，从早到晚）：\n` + lines.join('\n')};
        }
      }));
    } catch (error) {
      // 注册失败要留痕：defineTool 的 schema 写错会在调用点同步抛出，整个会话会静默瘫痪。
      DB_TOOL_SESSIONS.delete(sessionId);
      ctx.logger.warn('read_local_messages 注册失败：' + (error instanceof Error ? error.message : String(error)));
    }
  }
  // Interactive sessions are the "ask the assistant about this contact" surface. They
  // are created on demand, resumed after a restart, and always keep the same preset so
  // a workbench question can never fall into the automatic-reply flow.
  /** 问助手用哪个模型：设置里配了就照它，没配就用默认。 */
  const assistantAgentOptions = async () => {
    const settings = await worker.settings().then(result => result?.settings ?? {}).catch(() => ({}));
    const provider = typeof settings.assistant_provider === 'string' && settings.assistant_provider
      ? settings.assistant_provider : 'deepseek-official';
    const model = typeof settings.assistant_model === 'string' && settings.assistant_model
      ? settings.assistant_model : config.model;
    return {provider, model, maxTokens: config.max_tokens};
  };
  const ensureInteractiveSession = async ({sessionId, identity}) => {
    const preset = await ctx.agentPresets.resolve('message-agent');
    const workspace = await ctx.workspaceRegistry.create(config.agent_workspace);
    const live = ctx.agents.get(SessionId(sessionId));
    if (live) return {agent: live};
    let persisted = false;
    let observation;
    try {
      observation = await ctx.sessionQuery.observeSession(SessionId(sessionId));
      if (resolve(observation.header.cwd).toLowerCase() !== resolve(workspace.path).toLowerCase()
          || observation.header.agentPreset !== preset.id) throw new Error('Interactive session identity conflict');
      persisted = true;
    } catch (error) {
      if (error.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error;
    } finally {
      observation?.[Symbol.dispose]();
    }
    const composition = {
      // 问助手会读到微信消息内容，所以它的模型**必须能单独设**（用户要求：
      // 要能把这条链路整个放到本地模型上）。设置里没配就退回默认。
      agentOptions: await assistantAgentOptions(),
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset.id); }
    };
    const handle = persisted
      ? await ctx.agents.resume({resumeSessionId: SessionId(sessionId), ...composition})
      : await ctx.agents.create({sessionId: SessionId(sessionId), meta: {cwd: workspace.path, agentPreset: preset.id}, ...composition});
    active.set(SessionId(sessionId), handle);
    attachDbTool(handle.agent.ctx, sessionId);
    await workspace.attachSession(SessionId(sessionId));
    ctx.sessionTitle.rename(handle.agent.session, identity.title);
    await ctx.sessions.flush(handle.agent.session);
    return handle;
  };
  /**
   * One-shot question against a contact's interactive session, answered inside the
   * workbench. Tool calls are summarised as a count so the user sees the assistant
   * actually read WeChat instead of being dropped into the native developer view.
   */
  // 「问助手」是给用户本人看的。它跑在消息语境里，若不加约束就会把整份排障过程
  // （会话 id、wechat_in_use、窗口尺寸）当作答案倒给用户，还会用普通「- 」列表冒充待办。
  // 产品级规矩钉在提问上；客户端只认「- [ ]」为待办。
  const ASK_POLICY = [
    '现在用户本人在向你提问，请直接回答他本人，不要用"回复联系人"的口吻。',
    '必须遵守：',
    '1) 用中文，先给结论，不要叙述你的排查过程、工具调用、报错码或内部状态。',
    '2) 不出现会话 id、错误码（如 wechat_in_use）、工具名、窗口尺寸或坐标这类技术细节，用户看不懂也用不上。',
    '3) 读不到内容时，直说没读到什么，再给一句可执行的建议；不要逐条罗列尝试过什么。',
    '4) 需要用户本人做的事放在最后，每条以「- [ ] 」开头，最多 5 条。说明性的列表不要加中括号。',
    '5) 结论部分控制在 200 字以内，简短直白。',
    '6) 微信窗口大小与读取能力无关：拉高窗口是为了多看几行会话，属于正确用法。'
      + '绝不要建议用户调整窗口大小、恢复默认尺寸或改动任何设置。',
    // 原来这一条把"读不到"硬性归成两个原因（"对方正在用微信，助手让开"或"不在可见列表"），
    // 于是工具报别的错（比如核不过会话标题）时，模型会照着这条编出一个"你正在微信里操作，
    // 过一会儿再看就行"。实测用户被这么误导过两次，其中一次他根本没在用微信。
    // 实测被抱怨过：把"哪几条没读成"写成一张清单、再附一句"你可以再点一次"，等于把活推回给用户；
    // 而"另有两条摘要…仅供参考"这种凑数段落也只会让人更迷惑。
    '7) 没读到的条目用一句话带过就够（哪几条、这次没读成），不要逐条重复、不要教用户点哪个按钮、'
      + '不要承诺"过一会儿就好"、也不要把它们写成待办。'
      + '只有工具确实返回"用户正在微信里操作"时才可以说"助手让开了"；其余情况不要编造原因。',
    '8) 不要用列表摘要凑内容：没读正文的东西不要写进结论，也不要单独列一段"仅供参考"。'
      + '读不到就直说读不到，然后把已读到的部分讲清楚。'
  ].join('\n');
  /**
   * 这次提问针对哪个会话。
   *
   * 以前只有会话 id 进了 session 本身（绑定 + 标题），提示词里一个字都没带：用户在一个
   * 联系人的页面里问「最近有什么事要处理？」，模型得先自己猜"他"是谁，猜不出来只能靠该
   * session 的历史兜底。现在明确写进去 —— 名字给模型理解对象，id 给它直接读消息用。
   */
  const askScope = identity => {
    if (!identity || identity.kind === 'workspace') return '';
    const title = typeof identity.title === 'string' ? identity.title.trim() : '';
    const conversation = typeof identity.conversation === 'string' ? identity.conversation.trim() : '';
    if (!title || !conversation) return '';
    const kind = identity.kind === 'group' ? '微信群聊' : '微信联系人';
    // 读的时候给**名字**而不是 id：微信只渲染当前可见的那十来行，被滚到下面的会话在
    // list_conversations 里不存在，而 id 不含名字 —— 运行时既定位不到也没东西可搜索。
    // 显示名能走微信自己的全局搜索，不受滚动位置影响。
    return `这次提问的对象是${kind}「${title}」（内部标识 ${conversation}）。`
      + '用户说的「他／这个人／这段聊天／这个群」默认都指它；需要读消息时直接用「'
      + title + '」这个名字作为 conversation_id 去读（运行时会用微信搜索定位），'
      + '不要先去确认他是谁，也不要换成别的会话。回答里不要出现那个内部标识。';
  };
  const askAssistant = async ({sessionId, identity, text, system, context}) => {
    const question = typeof text === 'string' ? text.trim() : '';
    if (!question || question.length > 2000) throw Object.assign(new Error('请先写清楚要问助手什么'), {code: 'PRODUCT_API_ERROR'});
    const handle = await ensureInteractiveSession({sessionId, identity});
    const agent = handle.agent;
    if (agent.status !== 'idle') throw Object.assign(new Error('助手正在回答上一个问题，请等几秒再试'), {code: 'ASSISTANT_BUSY'});
    // 调用方可以补一段自己的规矩（如首页对话的"数据来自数据库，不要去开微信"）和一整块
    // 事实上下文（DB 快照）。顺序固定：产品规矩 → 本次任务规矩 → 对象 → 事实 → 问题。
    const prompt = [ASK_POLICY, system, askScope(identity), context, '用户的问题：' + question]
      .filter(Boolean).join('\n\n');
    const message = createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: prompt}]});
    const start = agent.session.events.length;
    let timer;
    agent.followup(message);
    try {
      await Promise.race([
        agent.whenIdle(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            agent.cancel({kind: 'user'});
            reject(Object.assign(new Error('助手这次没有在时间内回答，请重试'), {code: 'ASSISTANT_TIMEOUT'}));
          }, config.response_timeout_seconds * 1000);
        })
      ]);
    } finally {
      clearTimeout(timer);
    }
    const events = agent.session.events.slice(start);
    await ctx.sessions.flush(agent.session);
    const final = events.filter(e => e.type === 'assistant/message' && !e.data.interrupted).at(-1);
    const blocks = final?.data?.message?.content ?? [];
    const answer = blocks.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n').trim();
    if (!answer) throw Object.assign(new Error('助手这次没有给出文字回答，换个说法再试一次'), {code: 'PRODUCT_API_ERROR'});
    const tools = [...new Set(events.filter(e => e.type === 'tool/call').map(e => e.data?.name).filter(Boolean))];
    const failed = events.some(e => e.type === 'turn/end' && e.data?.reason?.kind && e.data.reason.kind !== 'completed');
    return {answer, tools, interrupted: failed, sessionId};
  };
  /**
   * One-shot model call: no tools, no session history.
   *
   * The message centre asks a model exactly two things — "what needs me" and "draft a
   * reply" — and neither belongs in an agent session. A session would carry the previous
   * contact's material into the next contact's classification, which is the exact
   * contamination the reply-context design forbids. `purpose` is a closed union in the
   * harness (compaction | session-title), so it is omitted rather than forced.
   *
   * Returns the text AND the finish reason. A call that failed or was truncated must not
   * be reported as "the model returned nothing parseable" — that masked the real cause.
   */
  /**
   * 这个 provider/model 认不认"推理档位"。
   *
   * 推理能力是模型**声明**出来的元数据，不是通用参数：harness 里手写的本地模型
   * （Ollama 的 qwen-*）不带这份声明，传 reasoningEffort 会直接抛
   * UNSUPPORTED_REASONING_EFFORT —— 而且校验发生在发请求之前，所以那条链路会**次次**
   * 失败（实测把「整理消息」切到本地模型时报的就是这个）。
   *
   * 问一次记一次：切模型是低频动作，缓存不会过期到需要失效策略。
   */
  const REASONING_CAPABLE = new Map();
  async function supportsReasoning(provider, model) {
    const key = provider + '::' + model;
    if (REASONING_CAPABLE.has(key)) return REASONING_CAPABLE.get(key);
    let capable = true;
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model);
      capable = !!info?.reasoning;
      if (!capable) ctx.logger.warn('模型不支持推理档位，调用时不传：' + key);
    } catch {
      // 问不出来（模型不存在、适配器出错）就按"支持"处理，让真正的调用去报它自己的错。
      capable = true;
    }
    REASONING_CAPABLE.set(key, capable);
    return capable;
  }

  const oneShot = async ({system, prompt, maxTokens, model, provider, reasoningEffort = 'low'}) => {
    const routeProvider = provider || 'deepseek-official';
    const routeModel = model || config.model;
    const assembler = new BlockAssembler();
    const options = {
      // provider 缺省是官方：单次调用大多是判断类任务，默认模型就够；需要换的调用方显式传。
      provider: routeProvider,
      model: routeModel,
      // 模型不支持就不传 —— 传了连请求都发不出去。
      ...(reasoningEffort && await supportsReasoning(routeProvider, routeModel) ? {reasoningEffort} : {}),
      ...(system ? {system} : {}),
      messages: [createUserMessage({source: {kind: 'plugin', plugin: 'message-agent'}, content: [{type: 'text', text: prompt}]})],
      maxTokens,
      temperature: 0
    };
    for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
    const finish = assembler.finish;
    if (finish?.kind === 'error' || finish?.kind === 'aborted') {
      const failure = finish.failure ?? {};
      throw Object.assign(new Error(failure.message || '模型调用失败'), {code: failure.code || 'LLM_FAILED'});
    }
    const text = assembler.blocks()
      .filter(block => block?.type === 'text' && typeof block.text === 'string')
      .map(block => block.text).join('\n').trim();
    return {text, finish};
  };

  /** Four-way triage. A broken classifier returns "unknown", never a guessed urgency. */
  const classifyMessages = async ({identity, messages, contact, openLoops, now}) => {
    const {text} = await oneShot({system: TRIAGE_SYSTEM, prompt: buildTriagePrompt({identity, messages, contact, openLoops, now}), maxTokens: 1200, reasoningEffort: 'off'});
    return parseTriageAnswer(text);
  };

  /**
   * "分析我的说话方式" — read my own messages and propose a Communication Profile. The
   * result is a draft, never active: the user edits and activates it, so a wrong guess
   * here costs a review, never a customer-facing tone change.
   *
   * The answer is a fairly long JSON object, so it needs real headroom: at a small token
   * cap the object came back truncated and the failure surfaced as "could not analyse",
   * which hid the actual cause. It is also retried once, and the reason is reported.
   */
  const analyzeStyle = async ({identity, messages}) => {
    const outgoingCount = (messages ?? []).filter(message => message?.direction === 'outgoing').length;
    if (outgoingCount < 3) {
      throw Object.assign(new Error('我这边发过的消息太少，分析不出说话方式。先和对方聊几句再来。'), {code: 'CONTEXT_INVALID'});
    }
    const prompt = buildStylePrompt({identity, messages});
    let failure = '';
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const {text, finish} = await oneShot({system: STYLE_SYSTEM, prompt, maxTokens: 2400, reasoningEffort: 'off'});
      const result = parseStyleAnswer(text, {outgoingCount});
      if (result.ok) return result;
      failure = finish?.kind === 'max-tokens' ? '模型这次输出被截断' : result.reason;
      ctx.logger.warn('style analysis attempt ' + (attempt + 1) + ' failed: '
        + JSON.stringify({finish: finish?.kind ?? null, reason: result.reason, chars: text.length, sample: text.slice(0, 240)}));
    }
    throw Object.assign(new Error('没有分析出可用的说话方式（' + (failure || '模型没有返回可解析的内容') + '），请稍后重试'), {code: 'PRODUCT_API_ERROR'});
  };

  const DRAFT_SYSTEM = [
    '你在替用户起草一条微信回复。用户会自己检查、自己决定是否发送，所以你的任务只是把话写好。',
    '只输出回复正文本身：不要引号、不要解释、不要「回复：」这类前缀，不要输出 JSON 或列表。',
    '只能用给定的资料和真实聊天内容。资料里没有的金额、时间、发货承诺、政策一律不要写。',
    '拿不准的时候，写一句得体的、请对方补充信息的话，不要编造事实。',
    '一两句话，口语化，像用户本人在说话。'
  ].join('\n');

  /**
   * Draft a reply through the same context pack the automatic path uses, so a manual
   * draft is grounded in the same evidence and can use the same knowledge and voice.
   * Output is always a draft: nothing here sends anything.
   */
  /**
   * 这一轮自动回复用什么"规矩"。
   *
   * 顺序：规则自己带的 → 设置里的全局一份 → 内置默认。
   * 后面永远拼上 REPLY_POLICY_FIXED（工具契约与安全），那部分**不给用户改** ——
   * 它是"程序怎么运转"，改掉会直接坏（模型不交决定、或自己乱发、或被聊天里的指令牵着走）。
   */
  const replyStyleEnabled = rule => {
    const own = typeof rule?.prompt === 'string' ? rule.prompt.trim() : '';
    if (own) return own;
    return DEFAULT_REPLY_STYLE;
  };

  /**
   * 记住这个人：从最近的对话里提炼值得长期记住的事，写进记忆库。
   *
   * 聊天稳不稳，很大程度取决于"这个人是谁、在意什么、答应过什么"能不能跨轮次留住。
   * 会话自带的记忆很脆（换会话、重启、上下文变长都会丢），所以另存一份、每轮后台更新。
   * 三条硬要求：**不阻塞回复**（调用点在 respond 之后，异常全吞）、
   * **不猜就记**（模型说 low 的先存 candidate，不进提示词）、**不重复记**（写前比对已有条目）。
   */
  async function updateContactMemory({conversationKey, contextData}) {
    const messages = Array.isArray(contextData?.messages) ? contextData.messages : [];
    if (messages.length < 2) return;
    const existing = contextSystem.memory.list(contextSystem.workspaceId, {conversationKey})
      .map(item => ({kind: item.kind, content: item.content}));
    const runtimeSettings = await worker.settings()
      .then(result => result?.settings ?? {}).catch(() => ({}));
    const {text: answer} = await oneShot({
      system: MEMORY_UPDATE_SYSTEM,
      prompt: buildMemoryPrompt({existing, messages}),
      maxTokens: 600, reasoningEffort: 'off',
      provider: runtimeSettings.organize_provider, model: runtimeSettings.organize_model
    });
    const candidates = parseMemoryAnswer(answer);
    if (!candidates.length) return;
    applyMemories(contextSystem.memory, contextSystem.workspaceId, conversationKey, candidates, existing);
  }

  const draftReply = async ({identity, conversationKey: draftKey, rule, contextData, recentDeliveries}) => {
    const run = await contextSystem.build({jobId: 'draft-' + draftKey.slice(0, 12), identity, conversationKey: draftKey, rule, contextData, recentDeliveries});
    // 起草回复属于自动回复链路（就是那条链路上的「拟回复」），所以模型跟着它走：
    // 用户在设置里把自动回复切到本地模型，起草也不该再偷偷发去云端。
    const draftSettings = await worker.settings()
      .then(result => result?.settings ?? {}).catch(() => ({}));
    const {text} = await oneShot({
      system: DRAFT_SYSTEM,
      prompt: renderContextPrompt({contextPack: run.contextPack, evidenceCatalog: run.evidenceCatalog, rule}),
      maxTokens: 1200,
      reasoningEffort: 'low',
      provider: draftSettings.auto_provider,
      model: draftSettings.auto_model
    });
    return {
      text: String(text || '').replace(/^["'「『“]/, '').replace(/["'」』”]$/, '').trim().slice(0, config.max_reply_chars),
      evidence: run.evidenceCatalog.length
    };
  };

  const crm = createCrm(join(dirname(config.database), 'crm.db'));
  const contextSystem = createReplyContextSystem({databasePath: join(dirname(config.database), 'reply-context.db'), workspaceId: 'local', crm});
  const messageCenter = createMessageCenter({databasePath: join(dirname(config.database), 'inbox.db'), identityKey});
  /**
   * 消息整理（DB 版）：正文已经在提示词里了，模型只做"理解"—— 归纳发生了什么、谁需要
   * 用户关注、用户本人要做什么。返回结构化 JSON；解析不出来就抛错，绝不把半截文本
   * 当成结论交出去（旧版把最终聊天文本当结果解析时就吃过这个亏）。
   *
   * **模型单独配**：整理要归纳和判断轻重，和"像人一样回一句话"是两种能力，用户可能给它们
   * 用不同的模型（设置里两行，各配各的）。缺省跟自动回复一致。
   */
  const organizeMessages = async ({prompt}) => {
    const runtimeSettings = await worker.settings()
      .then(result => result?.settings ?? {}).catch(() => ({}));
    const {text, finish} = await oneShot({

      system: ORGANIZE_SYSTEM, prompt, maxTokens: 2000, reasoningEffort: 'off',
      provider: runtimeSettings.organize_provider, model: runtimeSettings.organize_model
    });
    try {
      return parseOrganizeAnswer(text);
    } catch (error) {
      ctx.logger.warn('organize failed: ' + JSON.stringify({
        finish: finish?.kind ?? null, chars: text.length, sample: text.slice(0, 240),
        provider: runtimeSettings.organize_provider ?? null, model: runtimeSettings.organize_model ?? null
      }));
      throw error;
    }
  };
  const productApi = createProductApi({config, token, runtime: worker, conversations, bindingsPath, respond, readBody: body, ensureInteractiveSession, askAssistant, crm, context: contextSystem, messageCenter, classifyMessages, draftReply, analyzeStyle, organizeMessages});
  ctx.effect(() => () => {
    for (const handle of active.values()) handle.agent.cancel({kind:'user'});
  });
  ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/message-agent', handler: async (req, res) => {
    const authority = `127.0.0.1:${config.harness_port}`;
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== `http://${authority}`)) {
      respond(res, 403, {error:'Origin rejected'}); return;
    }
    const path = new URL(req.url, `http://${authority}`).pathname;
    if (path === '/message-agent/assets/brand/message-agent-symbol.svg') {
      if (req.method !== 'GET') { respond(res, 405, {error:'Method not allowed'}); return; }
      res.writeHead(200, {'Content-Type':'image/svg+xml; charset=utf-8', 'Content-Length':brandSymbol.length, 'Cache-Control':'public, max-age=86400'});
      res.end(brandSymbol);
      return;
    }
    if (path === '/message-agent/api/models' && req.method === 'GET') {
      try {
        // 列出**所有**配好的提供方，不只是官方的。
        //
        // 本地模型在 harness 里是挂在自己命名空间下的独立 provider（settings.yaml 的
        // `llm-pi-ai.providers.ollama-local` 这类），只查 deepseek-official 的话，设置里
        // 就永远看不到「本地 Qwen」（用户实测报的就是这个）。目录直接问 harness 要，
        // 不在这里维护一份清单 —— 用户加一个本地 provider，这里自动就能选。
        const directory = (() => {
          try { return ctx.llm.listConfigurableProviders(); }
          catch { return []; }
        })();
        const routes = directory.map(entry => ({provider: entry.provider, name: entry.displayName || entry.provider}));
        if (!routes.some(route => route.provider === 'deepseek-official')) {
          routes.unshift({provider: 'deepseek-official', name: 'DeepSeek'});
        }
        const models = [];
        for (const route of routes) {
          const listed = await ctx.llm.listModels(route.provider).catch(() => []);
          for (const model of listed ?? []) {
            models.push({provider: route.provider, providerName: route.name,
              id: model.id, name: model.name ?? model.id});
          }
        }
        if (!models.length) throw new Error('没有可用的模型');
        respond(res, 200, {models});
      } catch {
        respond(res, 503, {error:'暂时无法读取模型列表'});
      }
      return;
    }
    if (path === '/message-agent/health') {
      if (!privateRequest(req) || req.method !== 'GET') { respond(res,403,{error:'Worker authentication required'}); return; }
      respond(res,200,{ready:true}); return;
    }
    if (path === '/message-agent/job') {
      if (!privateRequest(req) || req.method !== 'POST') { respond(res, 403, {error:'Worker authentication required'}); return; }
      let handle;
      let timer;
      let sessionId;
      let decision;
      const cleanup = [];
      try {
        const payload = await body(req);
        const {rule, job} = payload;
        if (!rule || !job || !/^[a-zA-Z0-9-]{1,80}$/.test(job.id)) throw new Error('Invalid job');
        const autoModel = typeof payload.auto_model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(payload.auto_model)
          ? payload.auto_model : config.model;
        // 提供方也是可选的一部分：本地模型挂在别的 provider 下（如 Ollama），只带 model
        // 会让请求仍打到官方端点。白名单直接用 harness 的 provider 目录，不自己维护清单。
        const knownProviders = (() => {
          try { return ctx.llm.listConfigurableProviders().map(entry => entry.provider); }
          catch { return []; }
        })();
        const autoProvider = typeof payload.auto_provider === 'string'
          && (payload.auto_provider === 'deepseek-official' || knownProviders.includes(payload.auto_provider))
          ? payload.auto_provider : 'deepseek-official';
        const autoSettings = {...config, provider: autoProvider, model: autoModel};
        // 自动回复这条链路同样要按模型能力决定传不传推理档位（本地模型不认，传了就次次失败）。
        // 设成 undefined 由 automaticRequestConfig 省略掉这个字段。
        if (!await supportsReasoning(autoProvider, autoModel)) autoSettings.auto_reasoning_effort = undefined;
        const key = conversationKey(rule, job);
        await conversations.run(key, async () => {
        if (job.expires_at && job.expires_at * 1000 <= Date.now()) throw new Error('Reply job expired');
        const preset = await ctx.agentPresets.resolve('message-auto');
        await ctx.agentPresets.standingKeyFor(preset.id);
        const workspace = await ctx.workspaceRegistry.create(config.agent_workspace);
        const exists = async id => {
          let observation;
          try {
            observation = await ctx.sessionQuery.observeSession(SessionId(id));
            if (resolve(observation.header.cwd).toLowerCase() !== resolve(workspace.path).toLowerCase()
                || observation.header.agentPreset !== preset.id) throw new Error('Conversation session identity conflict');
            return true;
          } catch (error) { if (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return false; throw error; }
          finally { observation?.[Symbol.dispose](); }
        };
        sessionId = SessionId(await conversations.select(key, payload.legacy_session_ids, exists));
        const persisted = await exists(sessionId);
        const live = ctx.agents.get(sessionId);
        if (live && live.status !== 'idle') throw new Error('这个会话正在处理上一条消息');
        const composition = {
          agentOptions:{provider:autoProvider,model:autoModel,maxTokens:config.max_tokens},
          setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx,preset.id); }
        };
        handle = live ? {agent:live} : persisted
          ? await ctx.agents.resume({resumeSessionId:sessionId,...composition})
          : await ctx.agents.create({sessionId,meta:{cwd:workspace.path,agentPreset:preset.id},...composition});
        active.set(sessionId,handle);
        await workspace.attachSession(sessionId);
        // Keep the native task easy to identify and let the WeChat participant's
        // name follow remark-name changes without an extra product prefix.
        ctx.sessionTitle.rename(handle.agent.session, rule.title);
        ctx.permissionPresets.set(handle.agent.session,'message-auto');
        await ctx.sessions.flush(handle.agent.session);
        conversations.bind(key, sessionId);
        const agentCtx = handle.agent.ctx;
        // 让自动回复也能**自己去翻这个人的历史**：原来只有问助手挂了 read_local_messages，
        // 于是「和一个人聊了很久」时它只能看快照，拿不准也没得查。
        attachDbTool(agentCtx, sessionId);
        // A resumed Session can carry an adapter-derived maxTokens marker. Always
        // re-apply our explicit cap, otherwise DeepSeek's advertised 1M default is
        // sent to an endpoint whose accepted maximum is currently 393216.
        cleanup.push(agentCtx.on('agent/request',async (_payload,next)=>automaticRequestConfig(await next(),autoSettings)));
        cleanup.push(agentCtx.tools.register(defineTool({
              name:'submit_reply_decision',description:'提交本条消息的处理决定，不执行发送。日常聊天优先自然回复；只有确实需要本人决定才转人工。',
              parameters:{action:{type:'string',required:true,enum:['reply','skip','needs_user']},text:{type:'string',required:true,description:'只放发给联系人的正文；非 reply 必须为空'},reason:{type:'string',required:true,description:'供用户查看的简短理由，可为空；不发送给联系人'},intent:{type:'string',description:'可选：本条意图，如 faq/quote/refund/social 等'},evidence_ids:{type:'array',items:{type:'string'},description:'可选：引用本轮上下文中给出的 evidence id'},risk_tags:{type:'array',items:{type:'string'},description:'可选：如 price/commitment/refund，声明本条涉及的风险'}},
              output:{schema:{type:'object',additionalProperties:false,properties:{accepted:{type:'boolean',required:true}}},render:()=>[{type:'text',text:'回复决定已记录。'}]},
              execute(args,exec){
                if(exec.agent?.session.id!==sessionId) throw new Error('Decision belongs to another session');
                const next={job_id:job.id,event_id:job.event_id,...validateSubmission(args,config.max_reply_chars)};
                if(decision && JSON.stringify(decision)!==JSON.stringify(next)) throw new Error('A decision has already been submitted');
                decision=next;
                exec.concludeTurn();
                return {accepted:true};
              }
            })));
        const contextData = JSON.parse(job.context);
        const recentDeliveries = (payload.recent_deliveries ?? []).slice(0,3).map(({state,text})=>({state,text}));
        // Build the canonical context pack once, then hand the model the real message snapshot
        // plus CRM, open loops, profile, knowledge and live facts (spec §7). The persistent
        // Session only provides language continuity; this pack is the authoritative facts.
        const contextRun = await contextSystem.build({jobId: job.id, identity: {provider: rule.provider, conversation: rule.conversation}, conversationKey: key, rule, contextData, recentDeliveries});
        // A received WeChat message is user-authored input. Marking it as a
        // webhook kept it out of DSH's durable lastPromptAt projection, so a
        // visibly updated conversation remained buried at its creation time.
        const message = createUserMessage({source:{kind:'user'},
          content:[{type:'text',text:modelContext(REPLY_POLICY_FIXED+'\n'+renderContextPrompt({contextPack:contextRun.contextPack,evidenceCatalog:contextRun.evidenceCatalog,rule:{...rule,prompt:replyStyleEnabled(rule)}}))}]});
        const start = handle.agent.session.events.length;
        handle.agent.followup(message);
        await Promise.race([handle.agent.whenIdle(),new Promise((_,reject)=>{timer=setTimeout(()=>{handle.agent.cancel({kind:'user'});reject(new Error('Task timed out'));},config.response_timeout_seconds*1000);})]);
        const events = handle.agent.session.events.slice(start);
        if (!completedDecision(events, message.id)) {
          await ctx.sessions.flush(handle.agent.session);
          throw new Error('Current conversation turn did not complete: ' + JSON.stringify({
            events:[...new Set(events.map(e=>e.type))], reason:events.filter(e=>e.type==='turn/end').at(-1)?.data.reason
          }));
        }
        if(!decision) throw new Error('Agent did not submit a reply decision');
        // Evidence & Risk Gate (spec §10): validate evidence ids, live-fact expiry, risk grade
        // and commitment/banned-word rules before the decision can leave the Host. The audit
        // row records the context hash, evidence and gate outcome (§9).
        const gate = contextSystem.gate({decision, run: contextRun});
        const modelAudit = {intent: decision.intent ?? null, evidence_ids: decision.evidence_ids ?? [], risk_tags: decision.risk_tags ?? []};
        contextSystem.audit.write({jobId: job.id, workspaceId: contextSystem.workspaceId, conversationKey: key,
          contextHash: contextRun.contextHash, profileId: contextRun.profile?.id ?? null, profileRevision: contextRun.profile?.revision ?? null,
          evidence: contextRun.evidenceCatalog, retrievalTrace: contextRun.retrievalTrace, modelAudit,
          gateOutcome: gate.outcome, gateReasonCode: gate.reasonCode});
        if (gate.outcome === 'reject') {
          await ctx.sessions.flush(handle.agent.session);
          throw new Error('回复未通过风险校验：' + gate.reasonCode);
        }
        let finalDecision = gate.finalDecision;
        if (gate.outcome === 'needs_user') finalDecision = {...finalDecision, reason: gate.userMessage};
        await ctx.sessions.flush(handle.agent.session);
        // Strip audit-only fields before returning: the Worker's wire contract stays
        // job_id / event_id / action / text / reason (spec §9, agent_worker/decision.py).
        respond(res,200,{session_id:sessionId,session_reused:persisted || !!live,
          response:JSON.stringify({job_id:finalDecision.job_id,event_id:finalDecision.event_id,action:finalDecision.action,text:finalDecision.text,reason:finalDecision.reason})});

        // 决定已经交出去了，接下来顺手记住这个人 —— 放后台，失败也不影响这次回复。
        updateContactMemory({conversationKey: key, contextData}).catch(error => {
          ctx.logger.warn('记忆更新失败：' + (error instanceof Error ? error.message : 'unknown'));
        });
        });
      } catch (error) {
        ctx.logger.warn('Messaging task failed: ' + (error instanceof Error ? error.message : 'unknown'));
        console.error('Messaging task failure:', error instanceof Error ? error.stack : 'unknown');
        respond(res,503,{error:'这条消息没处理完，可以稍后再试',session_id:sessionId});
      } finally {
        clearTimeout(timer);
        for (const dispose of cleanup.reverse()) dispose();
        if (sessionId) active.delete(sessionId);
        // The Workspace owns successful sessions, so they remain visible and continuable.
      }
      return;
    }
    if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') { respond(res,403,{error:'Same origin required'});return; }
    // 允许 DELETE：知识库的「真删除」要用它（原来只放行 GET/POST/PATCH，删除一律 405）。
    if (!['GET','POST','PATCH','DELETE'].includes(req.method)) { respond(res,405,{error:'Method not allowed'}); return; }
    if (req.method !== 'GET' && req.headers.origin !== `http://${authority}`) {respond(res,403,{error:'Origin required'});return;}
    if (!['/message-agent/api/conversations','/message-agent/api/search_contacts','/message-agent/api/settings','/message-agent/api/rules','/message-agent/api/enable','/message-agent/api/pause','/message-agent/api/edit','/message-agent/api/delete'].includes(path)) {
      // Stage-1 product business API (inbox, conversation detail, interactive session, drafts).
      if (path.startsWith('/message-agent/api/') && await productApi(req, res, new URL(req.url, `http://${authority}`))) return;
      respond(res,404,{error:'Not found'});return;
    }
    try {
      const data = req.method==='POST' ? JSON.stringify(await body(req)) : undefined;
      const upstream = await fetch(`http://127.0.0.1:${config.control_port}${path.replace('/message-agent','')}`,{method:req.method,headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:data,signal:AbortSignal.timeout(95000)});
      respond(res,upstream.status,await upstream.json());
    } catch {respond(res,503,{error:'消息监听服务不可用'});}
  }}));
}
