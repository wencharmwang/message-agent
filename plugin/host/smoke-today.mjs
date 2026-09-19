/**
 * 「今天要做的 / 待办」这一页的活体检查（只读 Worker，写的是临时数据库）。
 *
 * 这一页的契约改过：它现在只有待办、等你确认发送、已完成三块，会话不再能被挂进来，
 * 待办有「要做 / 在做 / 做完」三态。逻辑有单测守着，但路由是拼字符串拼出来的
 * （`todos/:id/doing` 这种），写错名字在单测里看不出来 —— 这个脚本走一遍真实路由。
 *
 * 用临时目录当数据目录，所以不会碰用户真实的 crm.db / inbox.db；
 * 对 Worker 只发 GET（status / observe），不会读微信、不会发消息。
 *
 * Run: <node> plugin/host/smoke-today.mjs
 */
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductApi } from './product.mjs';

const base = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const token = readFileSync(base.control_token_file, 'utf8').trim();
const dir = mkdtempSync(join(tmpdir(), 'message-agent-today-'));
const config = {...base, database: join(dir, 'reply.db')};
const bindingsPath = join(dir, 'conversation-sessions.json');

let calls = [];
const respond = (res, code, body) => calls.push({code, body});
let payload = {};
const readBody = async () => payload;
const conversations = {entries: {}, bind() { throw new Error('不该在这个检查里绑定会话'); }};
const handle = createProductApi({config, token, conversations, bindingsPath, respond, readBody});

async function call(method, path, body) {
  calls = [];
  payload = body ?? {};
  const handled = await handle({method, headers: {}}, null, new URL(path, 'http://127.0.0.1'));
  return {handled, ...(calls[0] ?? {code: 0, body: {}})};
}

function check(label, ok, extra) {
  console.log((ok ? 'ok  ' : 'FAIL') + ' ' + label + (extra === undefined ? '' : ' → ' + JSON.stringify(extra)));
  if (!ok) process.exitCode = 1;
}

const created = await call('POST', '/message-agent/api/todos', {title: '问一下管家电梯排查进展', source: 'manual'});
check('新建待办', created.code === 201 && created.body.state === 'open', created.body.state);

const doing = await call('POST', '/message-agent/api/todos/' + created.body.id + '/doing', {});
check('标成在做', doing.code === 200 && doing.body.state === 'doing', doing.body.state);

const active = await call('GET', '/message-agent/api/todos');
check('未完成列表包含在做的那条', active.body.items?.some(item => item.state === 'doing'), active.body.items?.map(i => i.state));

// 动作名是拼在路径里的，写错一个字母不能被当成"什么也没发生"悄悄放过去：
// 要么 405，要么整条路径都不匹配交给上层 404。
const bad = await call('POST', '/message-agent/api/todos/' + created.body.id + '/nope', {});
check('未知动作不会被当成正常请求', bad.handled === false || bad.code === 405, {handled: bad.handled, code: bad.code});

const today = await call('GET', '/message-agent/api/today');
const groups = (today.body.groups ?? []).map(group => group.key);
check('今天要做的只有 confirm / todos / handled', JSON.stringify(groups) === JSON.stringify(['confirm', 'todos', 'handled']), groups);
check('没有「需要你决定」这一类', !groups.includes('decide'), groups);
check('红点 = 未完成待办 + 待确认草稿', today.body.counts?.attention === 1, today.body.counts);
const intoDoing = (today.body.groups ?? []).find(group => group.key === 'todos')?.items ?? [];
check('在做的那条排在待办列表最前', intoDoing[0]?.state === 'doing', intoDoing.map(i => i.state));

const done = await call('POST', '/message-agent/api/todos/' + created.body.id + '/done', {});
check('勾完成', done.code === 200 && done.body.state === 'done', done.body.state);
const after = await call('GET', '/message-agent/api/today');
check('做完之后红点归零', after.body.counts?.attention === 0, after.body.counts);
console.log('临时数据目录：' + dir);
