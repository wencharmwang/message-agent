import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const product = readFileSync(join(here, 'product.mjs'), 'utf8');
const homeModule = readFileSync(join(here, 'home.mjs'), 'utf8');
const worker = readFileSync(join(here, '..', '..', 'agent_worker', 'service.py'), 'utf8');

test('message-center GET never schedules a background body read', () => {
  assert.doesNotMatch(product, /background\('pump:body-read'/);
  assert.doesNotMatch(product, /background\('pump:triage'/);
});

test('only explicit organiser actions request a fresh visible-list scan', () => {
  assert.match(product, /parts\[0\] === 'refresh'[\s\S]*syncCenter\(\{refresh: true\}\)/);
  assert.match(product, /parts\[0\] === 'organize'[\s\S]*syncCenter\(\{refresh: true\}\)/);
  assert.match(product, /refresh \? runtime\.refreshObservation\(\) : runtime\.observe\(\)/);
});

test('worker tick 只消费本地数据库的事件，不再做 OCR 扫描', () => {
  const tick = worker.slice(worker.indexOf('    def tick(self):'), worker.indexOf('    def run(self):'));
  // 暂停时整轮跳过：既不读新消息、也不生成/发送回复。
  assert.match(tick, /if self\.auto_reply_paused\(\):[\s\S]*?return/);
  // 事件来自常驻的 DB watcher 子进程（读明文副本，不打开微信窗口）。
  assert.match(tick, /events = self\._watcher\(\)\.poll\(\)/);
  assert.match(tick, /self\._handle_event\(event, rules_by_username\)/);
  // OCR 时代的「按 provider 扫描可见列表」必须彻底消失：那一步要逐帧截图识别。
  assert.doesNotMatch(tick, /self\.discover\(/);
  assert.doesNotMatch(tick, /scans = \{\}/);
  assert.doesNotMatch(tick, /list_conversations/);
});

test('首页与整理只读本地数据库，不出现任何 OCR 扫描调用', () => {
  // 首页数据底座：一次 db_recent，纯 sqlite 读。
  assert.match(product, /runtime\.dbRecent\(\{sessions, perSession\}\)/);
  assert.match(product, /path === '\/message-agent\/api\/home' && req\.method === 'GET'/);
  assert.match(product, /path === '\/message-agent\/api\/home\/organize' && req\.method === 'POST'/);
  // 首页/整理这条链路上不允许出现 refreshObservation（那才是 OCR 全窗截图）。
  const home = product.slice(product.indexOf('async function homePayload()'),
    product.indexOf("if (path === '/message-agent/api/home/organize'"));
  assert.doesNotMatch(home, /refreshObservation/);
  // 「需要你回复」用确定性规则算，不交给模型。
  assert.match(homeModule, /export function waitingForMe\(session\)/);
  assert.match(homeModule, /if \(session\.kind === 'group'\) return false;/);
});
