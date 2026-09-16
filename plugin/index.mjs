import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { REPLY_POLICY, modelContext, validateSubmission } from './reply-policy.mjs';
import { ConversationSessions, automaticRequestConfig, conversationKey, completedDecision } from './conversation-sessions.mjs';
import { createProductApi, identityKey } from './host/product.mjs';
import { createCrm } from './host/crm.mjs';
import { createMessageCenter } from './host/message-center.mjs';
import { TRIAGE_SYSTEM, buildTriagePrompt, parseTriageAnswer } from './host/triage.mjs';
import { STYLE_SYSTEM, buildStylePrompt, parseStyleAnswer } from './host/style-analysis.mjs';
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
const brandSymbol = readFileSync(new URL('./assets/brand/message-agent-symbol.png', import.meta.url));
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
  // Interactive sessions are the "ask the assistant about this contact" surface. They
  // are created on demand, resumed after a restart, and always keep the same preset so
  // a workbench question can never fall into the automatic-reply flow.
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
      agentOptions: {provider: 'deepseek-official', model: config.model, maxTokens: config.max_tokens},
      setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset.id); }
    };
    const handle = persisted
      ? await ctx.agents.resume({resumeSessionId: SessionId(sessionId), ...composition})
      : await ctx.agents.create({sessionId: SessionId(sessionId), meta: {cwd: workspace.path, agentPreset: preset.id}, ...composition});
    active.set(SessionId(sessionId), handle);
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
    '6) 微信窗口大小与读取能力无关：拉高窗口是为了多看几行会话，属于正确用法。读不到内容的真实原因只有两类——'
      + '对方正在用微信操作（助手主动让开，等一会儿即可），或那个会话不在当前可见列表里。'
      + '绝不要建议用户调整窗口大小、恢复默认尺寸或改动任何设置。',
    '7) 正文读不到时，可以退一步把会话列表里"看起来需要留意"的摘要条目列出来给他参考，'
      + '但必须标明这是列表摘要、没读正文，不能当作已确认的事实，也不要写成待办（不要用「- [ ] 」）。'
  ].join('\n');
  const askAssistant = async ({sessionId, identity, text}) => {
    const question = typeof text === 'string' ? text.trim() : '';
    if (!question || question.length > 2000) throw Object.assign(new Error('请先写清楚要问助手什么'), {code: 'PRODUCT_API_ERROR'});
    const handle = await ensureInteractiveSession({sessionId, identity});
    const agent = handle.agent;
    if (agent.status !== 'idle') throw Object.assign(new Error('助手正在回答上一个问题，请等几秒再试'), {code: 'ASSISTANT_BUSY'});
    const message = createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: ASK_POLICY + '\n\n用户的问题：' + question}]});
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
  const oneShot = async ({system, prompt, maxTokens, model, reasoningEffort = 'low'}) => {
    const assembler = new BlockAssembler();
    const options = {
      provider: 'deepseek-official',
      model: model || config.model,
      reasoningEffort,
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
  const draftReply = async ({identity, conversationKey: draftKey, rule, contextData, recentDeliveries}) => {
    const run = await contextSystem.build({jobId: 'draft-' + draftKey.slice(0, 12), identity, conversationKey: draftKey, rule, contextData, recentDeliveries});
    const {text} = await oneShot({
      system: DRAFT_SYSTEM,
      prompt: renderContextPrompt({contextPack: run.contextPack, evidenceCatalog: run.evidenceCatalog, rule}),
      maxTokens: 1200,
      reasoningEffort: 'low'
    });
    return {
      text: String(text || '').replace(/^["'「『“]/, '').replace(/["'」』”]$/, '').trim().slice(0, config.max_reply_chars),
      evidence: run.evidenceCatalog.length
    };
  };

  const crm = createCrm(join(dirname(config.database), 'crm.db'));
  const contextSystem = createReplyContextSystem({databasePath: join(dirname(config.database), 'reply-context.db'), workspaceId: 'local', crm});
  const messageCenter = createMessageCenter({databasePath: join(dirname(config.database), 'inbox.db'), identityKey});
  const productApi = createProductApi({config, token, conversations, bindingsPath, respond, readBody: body, ensureInteractiveSession, askAssistant, crm, context: contextSystem, messageCenter, classifyMessages, draftReply, analyzeStyle});
  ctx.effect(() => () => {
    for (const handle of active.values()) handle.agent.cancel({kind:'user'});
  });
  ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/message-agent', handler: async (req, res) => {
    const authority = `127.0.0.1:${config.harness_port}`;
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== `http://${authority}`)) {
      respond(res, 403, {error:'Origin rejected'}); return;
    }
    const path = new URL(req.url, `http://${authority}`).pathname;
    if (path === '/message-agent/assets/brand/message-agent-symbol.png') {
      if (req.method !== 'GET') { respond(res, 405, {error:'Method not allowed'}); return; }
      res.writeHead(200, {'Content-Type':'image/png', 'Content-Length':brandSymbol.length, 'Cache-Control':'public, max-age=86400'});
      res.end(brandSymbol);
      return;
    }
    if (path === '/message-agent/api/models' && req.method === 'GET') {
      try {
        const models = await ctx.llm.listModels('deepseek-official');
        respond(res, 200, {models: models.map(model => ({id:model.id, name:model.name ?? model.id}))});
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
        const autoSettings = {...config, model:autoModel};
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
        if (live && live.status !== 'idle') throw new Error('Conversation is busy in Harness');
        const composition = {
          agentOptions:{provider:'deepseek-official',model:autoModel,maxTokens:config.max_tokens},
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
          content:[{type:'text',text:modelContext(REPLY_POLICY+'\n'+renderContextPrompt({contextPack:contextRun.contextPack,evidenceCatalog:contextRun.evidenceCatalog,rule}))}]});
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
        });
      } catch (error) {
        ctx.logger.warn('Messaging task failed: ' + (error instanceof Error ? error.message : 'unknown'));
        console.error('Messaging task failure:', error instanceof Error ? error.stack : 'unknown');
        respond(res,503,{error:'消息任务未完成，请查看 Harness 任务记录',session_id:sessionId});
      } finally {
        clearTimeout(timer);
        for (const dispose of cleanup.reverse()) dispose();
        if (sessionId) active.delete(sessionId);
        // The Workspace owns successful sessions, so they remain visible and continuable.
      }
      return;
    }
    if (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') { respond(res,403,{error:'Same origin required'});return; }
    if (!['GET','POST','PATCH'].includes(req.method)) { respond(res,405,{error:'Method not allowed'}); return; }
    if (req.method !== 'GET' && req.headers.origin !== `http://${authority}`) {respond(res,403,{error:'Origin required'});return;}
    if (!['/message-agent/api/conversations','/message-agent/api/settings','/message-agent/api/rules','/message-agent/api/enable','/message-agent/api/pause','/message-agent/api/edit','/message-agent/api/delete'].includes(path)) {
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
