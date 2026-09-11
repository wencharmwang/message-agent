import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';
import { REPLY_POLICY, conversationTurnContext, modelContext, validateSubmission } from './reply-policy.mjs';
import { ConversationSessions, automaticRequestConfig, conversationKey, completedDecision } from './conversation-sessions.mjs';
import { createProductApi } from './host/product.mjs';

export const inject = ['webServer', 'agents', 'sessions', 'sessionQuery', 'sessionPersistence', 'agentPresets', 'workspaceRegistry', 'permissionPresets', 'sessionTitle'];
const config = JSON.parse(readFileSync(process.env.MESSAGE_AGENT_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const token = readFileSync(config.control_token_file, 'utf8').trim();
const { SessionId } = await import(pathToFileURL(join(config.harness_root, 'packages/core/session/src/index.ts')));
const { createUserMessage } = await import(pathToFileURL(join(config.harness_root, 'packages/llm/llm/src/index.ts')));
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
  const askAssistant = async ({sessionId, identity, text}) => {
    const question = typeof text === 'string' ? text.trim() : '';
    if (!question || question.length > 2000) throw Object.assign(new Error('请先写清楚要问助手什么'), {code: 'PRODUCT_API_ERROR'});
    const handle = await ensureInteractiveSession({sessionId, identity});
    const agent = handle.agent;
    if (agent.status !== 'idle') throw Object.assign(new Error('助手正在回答上一个问题，请等几秒再试'), {code: 'ASSISTANT_BUSY'});
    const message = createUserMessage({source: {kind: 'user'}, content: [{type: 'text', text: question}]});
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
  const productApi = createProductApi({config, token, conversations, bindingsPath, respond, readBody: body, ensureInteractiveSession, askAssistant});
  ctx.effect(() => () => {
    for (const handle of active.values()) handle.agent.cancel({kind:'user'});
  });
  ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/message-agent', handler: async (req, res) => {
    const authority = `127.0.0.1:${config.harness_port}`;
    if (req.headers.host !== authority || (req.headers.origin && req.headers.origin !== `http://${authority}`)) {
      respond(res, 403, {error:'Origin rejected'}); return;
    }
    const path = new URL(req.url, `http://${authority}`).pathname;
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
          agentOptions:{provider:'deepseek-official',model:config.model,maxTokens:config.max_tokens},
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
        cleanup.push(agentCtx.on('agent/request',async (_payload,next)=>automaticRequestConfig(await next(),config)));
        cleanup.push(agentCtx.tools.register(defineTool({
              name:'submit_reply_decision',description:'提交本条消息的处理决定，不执行发送。日常聊天优先自然回复；只有确实需要本人决定才转人工。',
              parameters:{action:{type:'string',required:true,enum:['reply','skip','needs_user']},text:{type:'string',required:true,description:'只放发给联系人的正文；非 reply 必须为空'},reason:{type:'string',required:true,description:'供用户查看的简短理由，可为空；不发送给联系人'}},
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
        const turnData = conversationTurnContext(JSON.parse(job.context), persisted || !!live);
        const recentDeliveries = (payload.recent_deliveries ?? []).slice(0,3).map(({state,text})=>({state,text}));
        // A received WeChat message is user-authored input. Marking it as a
        // webhook kept it out of DSH's durable lastPromptAt projection, so a
        // visibly updated conversation remained buried at its creation time.
        const message = createUserMessage({source:{kind:'user'},
          content:[{type:'text',text:REPLY_POLICY+'\n'+JSON.stringify(modelContext({rule:rule.prompt,conversation:{title:rule.title,kind:rule.kind},data:turnData,recent_deliveries:recentDeliveries}))}]});
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
        await ctx.sessions.flush(handle.agent.session);
        respond(res,200,{session_id:sessionId,session_reused:persisted || !!live,response:JSON.stringify(decision)});
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
    if (req.method !== 'GET' && (req.method !== 'POST' || req.headers.origin !== `http://${authority}`)) {respond(res,403,{error:'Origin required'});return;}
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
