// Smoke check for the local CRM + "今天要做的" projection.
// Reads the real Worker through the in-process handler; all writes go to a
// throwaway data directory so the real crm.db is never seeded with test rows.
// Run: node plugin/host/smoke-crm.mjs
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductApi, humanizeDetail, projectToday } from './product.mjs';

const config = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const token = readFileSync(config.control_token_file, 'utf8').trim();
const bindingsPath = config.database.replace(/[^\\/]+$/, 'conversation-sessions.json');
const scratch = mkdtempSync(join(tmpdir(), 'ma-crm-smoke-'));
const testConfig = {...config, database: join(scratch, 'reply.db')};

let last = null;
const respond = (res, code, body) => { last = {code, body}; };
const conversations = {entries: {}, bind() { throw new Error('bind must not run here'); }};
const handle = createProductApi({config: testConfig, token, conversations, bindingsPath, respond, readBody: async () => currentBody});

let currentBody = {};
const req = method => ({method, headers: {'content-type': 'application/json'}});
const call = async (method, path, body) => {
  currentBody = body ?? {};
  last = null;
  const handled = await handle(req(method), null, new URL(path, 'http://127.0.0.1'));
  return {handled, ...last};
};

let failures = 0;
const check = (label, ok, extra = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!ok) failures++; };

check('humanize raw runtime code', humanizeDetail('微信窗口暂不可捕获。Runtime: provider_unavailable') === '暂时读不到微信，助手每 5 秒会自动重试。如果一直这样，请确认微信已登录、且没有缩到托盘（最小化）。');
check('humanize keeps unknown text', humanizeDetail('会话不存在') === '会话不存在');
check('projectToday is total', (() => { try { projectToday({}); return true; } catch { return false; } })());

const today = await call('GET', '/message-agent/api/today');
check('GET /today', today.code === 200 && Array.isArray(today.body.groups), 'groups=' + today.body?.groups?.map(g => g.key + ':' + g.items.length).join(' '));
check('today has the four groups', today.body?.groups?.map(g => g.key).join(',') === 'decide,confirm,todos,handled');
check('today counts present', typeof today.body?.counts?.attention === 'number');

const inbox = await call('GET', '/message-agent/api/inbox?limit=5');
const item = inbox.body?.items?.[0];
check('inbox reachable', !!item, item ? item.identity.title : 'no items');
if (!item) { console.log('no onboarded conversation; stopping write checks'); rmSync(scratch, {recursive: true, force: true}); process.exit(failures ? 1 : 0); }

check('rule detail is humanized', !/Runtime:|provider_unavailable/.test(item.rule.detail || item.summary || ''), item.rule.detail || item.summary || '(empty)');

const todos = await call('POST', '/message-agent/api/todos', {conversationKey: item.key, title: '冒烟测试待办', dueAt: new Date(Date.now() - 86400000).toISOString(), source: 'manual'});
check('POST /todos', todos.code === 201 && !!todos.body.id, todos.body?.title);
const todoId = todos.body.id;
check('overdue todo lands in overdue bucket', (await call('GET', '/message-agent/api/today')).body?.counts?.overdue === 1);

const followup = await call('POST', `/message-agent/api/customers/${item.key}/followups`, {kind: '记录', note: '冒烟测试跟进'});
check('POST followups', followup.code === 201 && !!followup.body.id);
const customer = await call('POST', `/message-agent/api/customers/${item.key}`, {stage: '冒烟阶段', nextStep: '冒烟下一步'});
check('POST customer update', customer.code === 200 && customer.body.stage === '冒烟阶段');

const detail = await call('GET', `/message-agent/api/customers/${item.key}`);
check('GET customer detail', detail.code === 200 && detail.body.followups.length === 1 && detail.body.todos.length === 1);

const done = await call('POST', `/message-agent/api/todos/${todoId}/done`, {});
check('todo done', done.code === 200 && done.body.state === 'done');
const removed = await call('POST', `/message-agent/api/todos/${todoId}/delete`, {});
check('todo delete', removed.code === 200);
const dropFollowup = await call('POST', `/message-agent/api/customers/${item.key}/followups/${followup.body.id}`, {delete: true});
check('followup delete', dropFollowup.code === 200);

const customers = await call('GET', '/message-agent/api/customers');
check('GET /customers', customers.code === 200 && Array.isArray(customers.body.items), 'customers=' + customers.body?.items?.length);

// The automation page reads this route, so it must never carry a raw runtime code.
const status = await call('GET', '/message-agent/api/status');
const statusDetails = [...(status.body?.rules ?? []), ...(status.body?.jobs ?? [])].map(r => r.detail || '').join(' ');
check('GET /status humanizes details', status.code === 200 && !/Runtime:|provider_unavailable|not_sent|uncertain\b/.test(statusDetails), statusDetails.slice(0, 80));
check('GET /status drops English receipts', !/[A-Za-z]{2,}(?:\s+[a-z]{2,}){2,}/.test(statusDetails), statusDetails.slice(0, 80));

const missing = await call('GET', '/message-agent/api/customers/' + '0'.repeat(64));
check('unknown customer is a clean 404', missing.code === 404, missing.body?.error);

try { rmSync(scratch, {recursive: true, force: true, maxRetries: 5, retryDelay: 200}); }
catch { console.log('note: scratch dir kept (sqlite handle still open): ' + scratch); }
console.log(failures ? failures + ' check(s) failed' : 'all checks passed');
process.exit(failures ? 1 : 0);
