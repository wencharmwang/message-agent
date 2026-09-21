import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const product = readFileSync(join(here, 'product.mjs'), 'utf8');
const homeModule = readFileSync(join(here, 'home.mjs'), 'utf8');
const worker = readFileSync(join(here, '..', '..', 'agent_worker', 'service.py'), 'utf8');
const client = readFileSync(join(here, '..', 'client.js'), 'utf8');

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


test('整理是有状态的：已经处理过的建议不再重复出现', () => {
  // 用户实测：明明已经把某条建议记成待办、甚至做完了，下次整理又冒出来 ——
  // 因为整理是无状态的，每次都从同一批消息重新得出结论。
  // 两头都要做：提示词里明确"别再提"，结果落库前再过滤一遍。
  assert.match(homeModule, /renderOrganizePrompt\(bundle, \{now = Date\.now\(\) \/ 1000, handled = \[\]\} = \{\}\)/);
  assert.match(homeModule, /用户已有的待办（编号用于 duplicateOf，不要重复提出同一件事）/);
  assert.match(homeModule, /和清单里是同一件事的不要再写进 todos/);
  assert.match(product, /const handled = crm\.listTodos\(\{limit: 200\}\)\.map\(todo => todo\.title\)/);
  assert.match(product, /renderOrganizePrompt\(bundle, \{handled\}\)/);
  assert.match(product, /writeJsonFile\(organizePath, reconcileSuggestions\(located, crm\.listTodos/);
  // "处理过"包含已完成 —— 做完了的更不该再提醒一次
  assert.match(product, /function reconcileSuggestions\(result, todos\)/);
  assert.match(product, /hiddenCount: hidden/);
  // 换个说法重写同一条也要能匹配上
  assert.match(product, /function sameSuggestion\(left, right\)/);
  assert.match(product, /longer\.includes\(shorter\)/);
  // 界面要说明"省掉了几条"，否则用户以为漏了
  assert.match(client, /另有 '\+hidden\+' 条已经记进待办/);
});

test('读消息不轮询：进页面读一次，靠用户按需整理', () => {
  // 每 8 秒重扫一次微信库没有意义，而且会顺手让模型重复分析、烧 token。
  assert.match(client, /const home=usePoller\(true,\(\)=>api\('home'\),0\)/);
  assert.match(client, /const today=usePoller\(true,\(\)=>api\('today'\),0\)/);
  // 0 表示只读一次；不允许任何**正数**间隔（那才是轮询）
  assert.doesNotMatch(client, /api\('home'\),[1-9]\d*/);
  assert.doesNotMatch(client, /api\('today'\),[1-9]\d*/);
  // delay<=0 表示只读一次。别写成 setTimeout(run,0) —— 那是死循环。
  assert.match(client, /const once=delay<=0;/);
  assert.match(client, /if\(!stopped&&!once\)timer=setTimeout\(run,wait\);/);
  // 整理要花 token，所以有冷却，不给连点
  assert.match(client, /if\(organizing\|\|cooldown>0\)return;/);
  assert.match(client, /setCooldown\(20\)/);
});


test('判重并进整理那一次调用：不再单独调模型比对', () => {
  // 用户的原始反例：
  //   已有：「回复 Wencharm，说明看不到链接内容并请其文字说明」
  //   建议：「回复 Wencharm，说明能否处理语音并回应链接」
  // 没有一个词能对上，但要做的是同一件事。
  //
  // 第一版做法是"出完结果再调一次模型比对"——用户指出那样效率低。
  // 现在改成：**同一次调用里**把已有待办编号（A1/A2…）交给模型，并要求每条建议
  // 都填 duplicateOf，落库时按它摘掉。一次调用，一次答案。
  const index = readFileSync(join(here, '..', 'index.mjs'), 'utf8');

  // 输出格式里必须有 duplicateOf 这个字段
  assert.match(homeModule, /"detail":"依据：引一句最短的原文，40 字以内","duplicateOf":null/);
  // 硬性要求里写清了怎么填（看要做的事，不看措辞；拿不准填 null）
  assert.match(homeModule, /每一条 todos 都必须填 duplicateOf/);
  assert.match(homeModule, /判断看的是「要做的事」，不是措辞/);
  assert.match(homeModule, /拿不准时填 null/);
  // 已有待办要编号成清单给模型
  assert.match(homeModule, /用户已有的待办（编号用于 duplicateOf，不要重复提出同一件事）/);
  assert.match(homeModule, /'A' \+ \(index \+ 1\) \+ '\. ' \+ item/);
  // 解析要留下这个字段
  assert.match(homeModule, /duplicateOf: typeof item\?\.duplicateOf === 'string'/);
  // 落库时按它摘掉；模型漏填时字面兜底
  assert.match(product, /if \(item\.duplicateOf\) \{ hidden\+\+; continue; \}/);
  assert.match(product, /existing\.some\(title => sameSuggestion\(title, item\.title\)\)/);
  // **不许**再有第二次调用
  assert.doesNotMatch(product, /judgeDuplicateTodos|semanticReconcile/);
  assert.doesNotMatch(index, /DEDUPE_SYSTEM|judgeDuplicateTodos/);
});
