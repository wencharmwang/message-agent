import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplyContextSystem, renderContextPrompt } from './reply-context/index.mjs';
import { messageText } from './reply-context/context-builder.mjs';
import { evaluateGate, detectRiskTags, classifyIntent } from './reply-context/risk-gate.mjs';
import { createCrm } from './crm.mjs';

// Development fixtures only: no real WeChat data, no real contact names.

function makeSystem({workspaceId = 'local'} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'reply-context-'));
  return createReplyContextSystem({databasePath: join(dir, 'reply-context.db'), workspaceId});
}

const KEY_A = 'a'.repeat(64);
const KEY_B = 'b'.repeat(64);
const identity = provider => ({provider: 'wechat-main', conversation: 'conv-' + provider});

function buildArgs(over = {}) {
  return {
    jobId: 'job-1',
    identity: {provider: 'wechat-main', conversation: 'conv-1'},
    conversationKey: KEY_A,
    rule: {provider: 'wechat-main', conversation: 'conv-1', title: '小璐璐', kind: 'direct', prompt: '自然回复'},
    contextData: {messages: [{direction: 'incoming', content: '营业时间是什么', sender: null, type: 'text'}]},
    recentDeliveries: [],
    ...over
  };
}

// ---- Canonical Context (spec §17.1) ----------------------------------------

test('context: the real message snapshot is preserved even when the session is reused', async () => {
  const sys = makeSystem();
  const messages = [
    {direction: 'incoming', content: '你好', sender: null, type: 'text'},
    {direction: 'outgoing', content: '你好呀', sender: null, type: 'text'},
    {direction: 'incoming', content: '在吗', sender: null, type: 'text'}
  ];
  const run = await sys.build(buildArgs({contextData: {messages}}));
  const roles = run.contextPack.conversation.recent.map(m => m.role);
  assert.deepEqual(roles, ['contact', 'sent', 'contact']);
  assert.equal(run.contextPack.conversation.currentQuestion, '在吗');
  assert.equal(run.contextPack.conversation.recent.length, 3);
});

// ---- 非文本消息只给占位符（spec §5.5）----------------------------------------
//
// 线上真实事故：对方连发三条「为什么不回复」，而模型其实每轮都写了像样的回复 —— 只是
// 发送被遮挡闸拦下。翻上下文时才发现，图片/视频消息的正文是一整段 XML，被原样喂给了模型。

const IMAGE_XML = '<?xml version="1.0"?><msg><img hdlength="274437" length="0" '
  + 'cdnthumbwidth="0" md5=""/><commenturl/></msg>';
const VIDEO_XML = '<?xml version="1.0"?><msg><videomsg length="666709927" playlength="1667" '
  + 'cameratype="2" cdnthumburl="" rawmd5=""/></msg>';
const LINK_XML = '<?xml version="1.0"?><msg><appmsg><title>十一出行计划</title>'
  + '<url>https://example.invalid/plan</url></appmsg></msg>';
const FILE_XML = '<?xml version="1.0"?><msg><appmsg><title>报价单.pdf</title>'
  + '<fileext>pdf</fileext><totallen>20480</totallen></appmsg></msg>';

test('media: 图片/视频/语音按 type 换成占位符，三套词汇表都认', () => {
  const cases = [
    // watcher 事件用的中文类型名（自动回复走这条）
    [{content: IMAGE_XML, type: '图片'}, '[图片]'],
    [{content: VIDEO_XML, type: '视频'}, '[视频]'],
    [{content: '<?xml version="1.0"?><msg><voicemsg length="3"/></msg>', type: '语音'}, '[语音]'],
    [{content: '<?xml version="1.0"?><msg><emoji/></msg>', type: '动画表情'}, '[表情]'],
    [{content: '<?xml version="1.0"?><msg><location/></msg>', type: '位置'}, '[位置]'],
    [{content: '<?xml version="1.0"?><msg><voip/></msg>', type: '音视频通话'}, '[通话]'],
    [{content: '<?xml version="1.0"?><msg><sysmsg/></msg>', type: '系统消息'}, '[系统消息]'],
    // DB 行用的 local_type 数字字符串
    [{content: IMAGE_XML, type: '3'}, '[图片]'],
    [{content: VIDEO_XML, type: '43'}, '[视频]'],
    // runtime 的 MessageType 枚举
    [{content: IMAGE_XML, type: 'image'}, '[图片]'],
    [{content: VIDEO_XML, type: 'video'}, '[视频]'],
    // 正文本来就已是占位符 / 为空，别搞成 "[图片] [图片]"
    [{content: '[图片]', type: '图片'}, '[图片]'],
    [{content: '', type: '图片'}, '[图片]']
  ];
  for (const [message, expected] of cases) {
    assert.equal(messageText(message), expected, JSON.stringify(message.type));
  }
});

test('media: 文本正文一律原样，认不出的类型不误伤', () => {
  assert.equal(messageText({content: '在吗', type: 'text'}), '在吗');
  assert.equal(messageText({content: '在吗', type: '文本'}), '在吗');
  // 有些路径不带 type
  assert.equal(messageText({content: '在吗'}), '在吗');
  assert.equal(messageText({content: '在吗', type: ''}), '在吗');
  // 认不出的类型宁可放行，也不要把可能是真话的正文吃掉
  assert.equal(messageText({content: '不认识的正文', type: '类型99999'}), '不认识的正文');
  assert.equal(messageText({content: undefined, type: 'text'}), '');
});

test('media: 语音已转成文字时不会被占位符盖掉', () => {
  // service.py 转写成功会把 type 改成 text、content 换成文字，这一条必须留住。
  assert.equal(messageText({content: '晚上一起吃饭吗', type: 'text'}), '晚上一起吃饭吗');
});

test('media: app 消息的复合 local_type 按低 32 位兜底', () => {
  // local_type = (子类型 << 32) | 49；实测群里那四个值解压后 XML 的 <type> 是 5/47/57/63。
  // 低 32 位是 49，属卡片类，所以给 [文件/链接] 而不是把 XML 原样漏出去。
  for (const value of ['21474836529', '201863462961', '244813135921', '270582939697']) {
    assert.equal(messageText({content: IMAGE_XML, type: value}), '[文件/链接]', value);
  }
  // 低 32 位是普通媒体类型时也认
  assert.equal(messageText({content: IMAGE_XML, type: String((7 * 4294967296) + 3)}), '[图片]');
  // 真正的简单类型字符串原本就认
  assert.equal(messageText({content: VIDEO_XML, type: '43'}), '[视频]');
  // 不是数字的怪类型仍然原样放行
  assert.equal(messageText({content: '真话', type: '类型99999'}), '真话');
});

test('cards: 链接/文件分辨得出来，标题带得走', () => {
  assert.equal(messageText({content: LINK_XML, type: '文件/链接/卡片'}), '[链接] 十一出行计划');
  assert.equal(messageText({content: FILE_XML, type: '文件/链接/卡片'}), '[文件] 报价单.pdf');
  assert.equal(messageText({content: FILE_XML, type: '49'}), '[文件] 报价单.pdf');
  // 认不出是链接还是文件：笼统标签，不猜
  assert.equal(messageText({content: '<?xml version="1.0"?><msg><appmsg/></msg>', type: '文件/链接/卡片'}),
    '[文件/链接]');
  // 卡片正文已经是可读文本（decode 出来的标题/文件名）就不动它
  assert.equal(messageText({content: '十一出行计划.pdf', type: '文件/链接/卡片'}), '十一出行计划.pdf');
});

test('media: 原始 XML 一个字节都不进 prompt，currentQuestion 也不是 XML', async () => {
  const sys = makeSystem();
  const messages = [
    {direction: 'outgoing', content: IMAGE_XML, sender: null, type: '图片', at: 1790762400},
    {direction: 'outgoing', content: VIDEO_XML, sender: null, type: '视频', at: 1790770680},
    {direction: 'incoming', content: '发的什么东西', sender: null, type: 'text', at: 1790763963},
    {direction: 'incoming', content: '为什么不回复', sender: null, type: 'text', at: 1790764239}
  ];
  const run = await sys.build(buildArgs({contextData: {messages}}));
  assert.deepEqual(run.contextPack.conversation.recent.map(m => m.text),
    ['[图片]', '[视频]', '发的什么东西', '为什么不回复']);
  assert.equal(run.contextPack.conversation.currentQuestion, '为什么不回复');

  const prompt = renderContextPrompt({contextPack: run.contextPack});
  assert.doesNotMatch(prompt, /hdlength|videomsg|<\?xml|appmsg/, 'XML 不该出现在 prompt 里');
  assert.match(prompt, /\[图片\]/);
  assert.match(prompt, /\[视频\]/);
});

test('media: 最后一条是图片时 currentQuestion 是占位符，不是 XML', async () => {
  const sys = makeSystem();
  const run = await sys.build(buildArgs({contextData: {messages: [
    {direction: 'incoming', content: '在吗', sender: null, type: 'text'},
    {direction: 'incoming', content: IMAGE_XML, sender: null, type: '图片'}
  ]}}));
  assert.equal(run.contextPack.conversation.currentQuestion, '[图片]');
  const prompt = renderContextPrompt({contextPack: run.contextPack});
  assert.doesNotMatch(prompt, /hdlength|<\?xml/);
});

test('media: 占位符省下的预算让更多真实消息进得来', async () => {
  const sys = makeSystem();
  const messages = [
    ...Array.from({length: 6}, () => ({direction: 'outgoing', content: IMAGE_XML, type: '图片'})),
    ...Array.from({length: 6}, (_, i) => ({direction: 'incoming', content: '第' + (i + 1) + '句', type: 'text'}))
  ];
  const run = await sys.build(buildArgs({contextData: {messages}}));
  // 12 条全在（RECENT_MESSAGE_LIMIT 内），且每条都短到不会把预算吃空
  assert.equal(run.contextPack.conversation.recent.length, 12);
  assert.deepEqual(run.contextPack.conversation.recent.slice(0, 6).map(m => m.text),
    Array(6).fill('[图片]'));
});

test('context: identical input produces an identical context hash', async () => {
  const sys = makeSystem();
  const a = await sys.build(buildArgs());
  const b = await sys.build(buildArgs());
  assert.equal(a.contextHash, b.contextHash);
  assert.equal(a.contextHash.length, 64);
});

test('context: different conversations do not share memory or profile bindings', async () => {
  const sys = makeSystem();
  sys.memory.add('local', {conversationKey: KEY_A, kind: 'open_loop', content: '周五发报价', status: 'confirmed'});
  const profile = sys.profiles.create('local', {name: '销售'});
  sys.profiles.activate('local', profile.id);
  sys.profiles.bind('local', {profileId: profile.id, scopeType: 'conversation', scopeKey: KEY_A});

  const runA = await sys.build(buildArgs());
  assert.equal(runA.contextPack.contact.openLoops.length, 1);
  assert.equal(runA.contextPack.profile.name, '销售');

  const runB = await sys.build(buildArgs({conversationKey: KEY_B, identity: {provider: 'wechat-main', conversation: 'conv-2'}, rule: {provider: 'wechat-main', conversation: 'conv-2', title: '另一个人', kind: 'direct', prompt: ''}}));
  assert.equal(runB.contextPack.contact.openLoops.length, 0);
  assert.equal(runB.contextPack.profile.name, undefined); // no binding for B
});

test('context: profile binding order is conversation > scene > default', () => {
  const sys = makeSystem();
  const def = sys.profiles.create('local', {name: '默认'});
  const scene = sys.profiles.create('local', {name: '群聊'});
  const conv = sys.profiles.create('local', {name: '会话专属'});
  for (const p of [def, scene, conv]) sys.profiles.activate('local', p.id);
  sys.profiles.bind('local', {profileId: def.id, scopeType: 'default', scopeKey: 'default'});
  sys.profiles.bind('local', {profileId: scene.id, scopeType: 'scene', scopeKey: 'group_chat'});
  sys.profiles.bind('local', {profileId: conv.id, scopeType: 'conversation', scopeKey: KEY_A});

  assert.equal(sys.profiles.select('local', {conversationKey: KEY_A, scene: 'group_chat'}).profile.name, '会话专属');
  assert.equal(sys.profiles.select('local', {conversationKey: KEY_B, scene: 'group_chat'}).profile.name, '群聊');
  assert.equal(sys.profiles.select('local', {conversationKey: KEY_B}).profile.name, '默认');
});

test('context: draft, retired and expired knowledge are never retrieved', async () => {
  const sys = makeSystem();
  sys.knowledge.create('local', {kind: 'faq', title: '草稿', content: '不可见'}); // draft
  const retired = sys.knowledge.create('local', {kind: 'faq', title: '已停用', content: '不可见'});
  sys.knowledge.publish('local', retired.id); sys.knowledge.retire('local', retired.id);
  const expired = sys.knowledge.create('local', {kind: 'faq', title: '已过期', content: '不可见', validUntil: 1});
  sys.knowledge.publish('local', expired.id);
  const live = sys.knowledge.create('local', {kind: 'faq', title: '营业时间', content: '9-18 点'});
  sys.knowledge.publish('local', live.id);

  const run = await sys.build(buildArgs());
  const titles = run.contextPack.knowledge.map(k => k.title);
  assert.deepEqual(titles, ['营业时间']);
});

// ---- Live data (spec §17.2) ------------------------------------------------

test('live data: no resolver leaves the intent unresolved', async () => {
  const sys = makeSystem();
  const run = await sys.build(buildArgs({contextData: {messages: [{direction: 'incoming', content: '我的订单 123456 发货了吗', type: 'text'}]}}));
  assert.ok(run.unresolvedLiveIntents.includes('shipment'));
  assert.equal(run.contextPack.liveFacts.length, 0);
});

test('live data: a resolver contributes facts and evidence with a validity window', async () => {
  const sys = makeSystem();
  sys.resolvers.register('shipment', async () => ({
    status: 'resolved',
    facts: [{field: 'order.status', value: '已发货', observedAt: 100, expiresAt: 200, sourceRef: 'oms:order:123'}],
    safeSummary: '订单 123 已发货'
  }));
  const run = await sys.build(buildArgs({contextData: {messages: [{direction: 'incoming', content: '我的订单 123456 发货了吗', type: 'text'}]}}));
  assert.deepEqual(run.unresolvedLiveIntents, []);
  assert.equal(run.contextPack.liveFacts[0].value, '已发货');
  assert.ok(run.evidenceCatalog.some(e => e.kind === 'live_fact' && e.expiresAt === 200));
});

// ---- Risk gate (spec §17.3) ------------------------------------------------

test('birthday greeting passes the full context and gate without unrelated knowledge', async () => {
  const sys = makeSystem();
  const kb = sys.knowledge.create('local', {kind: 'product_usage', title: '消息系统', content: '今天介绍客户消息索引'});
  sys.knowledge.publish('local', kb.id);
  const run = await sys.build(buildArgs({contextData: {messages: [
    {direction: 'incoming', content: '今天我生日', at: 1790462800}
  ]}}));
  assert.equal(run.detectedIntent, 'social');
  assert.deepEqual(run.detectedRiskTags, []);
  assert.deepEqual(run.contextPack.knowledge, []);
  assert.equal(evaluateGate({decision: {action: 'reply', text: '生日快乐呀，今天想怎么过？',
    intent: 'social', evidence_ids: [], risk_tags: []}, run}).outcome, 'pass');
  const prompt = renderContextPrompt({contextPack: run.contextPack});
  assert.match(prompt, /09-27/);
  assert.doesNotMatch(prompt, /今天介绍客户消息索引/);
});

test('calendar words alone are not scheduling promises', () => {
  for (const text of ['今天我生日', '明天是我生日', '今天天气不错', '新年快乐', '月亮好圆']) {
    assert.equal(classifyIntent(text), 'social', text);
    assert.ok(!detectRiskTags(text).includes('time'), text);
  }
});

test('a birthday reply still cannot invent a concrete arrangement or payment', () => {
  for (const text of ['我明天去接你', '明天我来陪你过生日', '我给你转账500元']) {
    const out = evaluateGate({decision: {action: 'reply', text, intent: 'social', risk_tags: []},
      run: {currentQuestion: '今天我生日', detectedRiskTags: [], evidenceCatalog: []}});
    assert.equal(out.outcome, 'needs_user', text);
  }
});

test('gate: a reply citing an unknown evidence id is rejected', () => {
  const out = evaluateGate({decision: {action: 'reply', text: '你好', evidence_ids: ['ev_nope']}, run: {evidenceCatalog: []}});
  assert.equal(out.outcome, 'reject');
  assert.equal(out.reasonCode, 'EVIDENCE_UNKNOWN');
});

test('gate: an L3 intent needs a human even when knowledge is hit', () => {
  const out = evaluateGate({
    decision: {action: 'reply', text: '我批准你的退款', intent: 'refund', evidence_ids: ['ev_kb_1'], risk_tags: ['refund']},
    run: {evidenceCatalog: [{id: 'ev_kb_1', kind: 'published_knowledge'}], detectedRiskTags: [], contextPack: {profile: {}}}
  });
  assert.equal(out.outcome, 'needs_user');
  assert.equal(out.reasonCode, 'MUST_HUMAN');
});

test('gate: an L2 intent without evidence needs a human', () => {
  const out = evaluateGate({
    decision: {action: 'reply', text: '这个价格 500 元', intent: 'quote', risk_tags: ['price']},
    run: {evidenceCatalog: [], detectedRiskTags: [], contextPack: {profile: {}}}
  });
  assert.equal(out.outcome, 'needs_user');
  assert.equal(out.reasonCode, 'EVIDENCE_REQUIRED');
});

test('gate: a hard banned expression routes to a human, not a silent rewrite', () => {
  const out = evaluateGate({
    decision: {action: 'reply', text: '保证到账', risk_tags: []},
    run: {evidenceCatalog: [], detectedRiskTags: [], contextPack: {profile: {bannedExpressions: ['保证到账']}}}
  });
  assert.equal(out.outcome, 'needs_user');
  assert.equal(out.reasonCode, 'HARD_BANNED_WORD');
});

test('gate: a soft preference never blocks a reply', () => {
  const out = evaluateGate({
    decision: {action: 'reply', text: '你好呀', risk_tags: []},
    run: {evidenceCatalog: [], detectedRiskTags: [], contextPack: {profile: {preference: ['简短']}}}
  });
  assert.equal(out.outcome, 'pass');
});

test('gate: a credential in the reply is rejected', () => {
  const out = evaluateGate({
    decision: {action: 'reply', text: 'key 是 sk-abcdefghijklmnop1234', risk_tags: []},
    run: {evidenceCatalog: [], detectedRiskTags: [], contextPack: {profile: {}}}
  });
  assert.equal(out.outcome, 'reject');
  assert.equal(out.reasonCode, 'CREDENTIAL_LEAK');
});

test('gate: an unresolved live-data question needs a human', () => {
  const out = evaluateGate({
    decision: {action: 'reply', text: '已经发货了', intent: 'order_status', risk_tags: []},
    run: {evidenceCatalog: [], detectedRiskTags: [], unresolvedLiveIntents: ['shipment'], contextPack: {profile: {}}}
  });
  assert.equal(out.outcome, 'needs_user');
  assert.equal(out.reasonCode, 'UNSUPPORTED_LIVE');
});

test('gate: a grounded FAQ reply with its evidence id passes', () => {
  const out = evaluateGate({
    decision: {action: 'reply', text: '周一到周五 9 点到 18 点', intent: 'faq', evidence_ids: ['ev_kb_1'], risk_tags: []},
    run: {evidenceCatalog: [{id: 'ev_kb_1', kind: 'published_knowledge', risk: 'low'}], detectedRiskTags: [], contextPack: {profile: {}}}
  });
  assert.equal(out.outcome, 'pass');
});

// ---- Knowledge lifecycle (spec §17.1) --------------------------------------

test('knowledge: publish/retire/rollback with revision snapshots', () => {
  const sys = makeSystem();
  const item = sys.knowledge.create('local', {kind: 'faq', title: '营业时间', content: '9-18 点'});
  assert.equal(item.status, 'draft');
  const published = sys.knowledge.publish('local', item.id);
  assert.equal(published.status, 'published');
  assert.equal(published.revision, item.revision + 1);

  const updated = sys.knowledge.update('local', item.id, {content: '9-19 点'}, {expectedRevision: published.revision});
  assert.equal(updated.content, '9-19 点');
  assert.equal(updated.status, 'published'); // update does not un-publish
  assert.throws(() => sys.knowledge.update('local', item.id, {content: 'x'}, {expectedRevision: published.revision}), /已被修改/);

  const rolled = sys.knowledge.rollback('local', item.id, {toRevision: published.revision});
  assert.equal(rolled.content, '9-18 点');
  assert.equal(rolled.status, 'draft'); // rollback re-opens for review

  const retired = sys.knowledge.publish('local', item.id);
  const retired2 = sys.knowledge.retire('local', item.id);
  assert.equal(retired2.status, 'retired');
});

test('knowledge: workspace isolation — A cannot list or get B items', () => {
  const sysA = makeSystem({workspaceId: 'A'});
  const sysB = makeSystem({workspaceId: 'B'});
  const kA = sysA.knowledge.create('A', {kind: 'faq', title: 'A 的知识', content: 'x'});
  assert.equal(sysB.knowledge.get(kA.id, 'B'), null);
  assert.equal(sysB.knowledge.list('B').length, 0);
  assert.equal(sysA.knowledge.get(kA.id, 'A').title, 'A 的知识');
});

// ---- Memory (spec §5.3) ----------------------------------------------------

test('memory: open loops are surfaced only when confirmed and not resolved', async () => {
  const sys = makeSystem();
  sys.memory.add('local', {conversationKey: KEY_A, kind: 'open_loop', content: '周五发报价', status: 'confirmed'});
  const candidate = sys.memory.add('local', {conversationKey: KEY_A, kind: 'fact', content: '喜欢早睡', status: 'candidate'});
  const resolved = sys.memory.add('local', {conversationKey: KEY_A, kind: 'open_loop', content: '已处理', status: 'confirmed'});
  sys.memory.resolve('local', resolved.id);

  const run = await sys.build(buildArgs());
  const loops = run.contextPack.contact.openLoops.map(l => l.content);
  assert.deepEqual(loops, ['周五发报价']);
  assert.ok(!loops.includes('喜欢早睡'));
});

test('memory: CRM projection carries stage, next step, note and open to-dos', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rc-crm-'));
  const crm = createCrm(join(dir, 'crm.db'));
  crm.ensureCustomer({key: KEY_A, provider: 'wechat-main', conversation: 'conv-1', displayName: '小璐璐', kind: 'direct'});
  crm.updateCustomer(KEY_A, {stage: '跟进中', nextStep: '周五报价', note: '预算 5 万'});
  crm.createTodo({conversationKey: KEY_A, title: '发报价单'});
  const sys = createReplyContextSystem({databasePath: join(dir, 'reply-context.db'), workspaceId: 'local', crm});

  const run = await sys.build(buildArgs());
  assert.equal(run.contextPack.contact.stage, '跟进中');
  assert.equal(run.contextPack.contact.nextStep, '周五报价');
  assert.equal(run.contextPack.contact.openTodos.length, 1);
});

// ---- Prompt render (spec §9) -----------------------------------------------

test('group: 群聊快照带上是谁说的，单聊不带（既有哈希不变）', async () => {
  const sys = makeSystem();
  const messages = [
    {direction: 'incoming', content: '为什么不回复', sender: '同事甲', type: 'text', at: 1790764239},
    {direction: 'outgoing', content: '在的', sender: '我自己', type: 'text', at: 1790764300}
  ];

  const direct = await sys.build(buildArgs({contextData: {messages}}));
  const directPrompt = renderContextPrompt({contextPack: direct.contextPack});
  assert.match(directPrompt, /对方：为什么不回复/);
  assert.doesNotMatch(directPrompt, /同事甲/, '单聊不用写名字');
  // 单聊不给 speaker 字段，既有的上下文哈希（去重/缓存都靠它）保持不变
  assert.equal(direct.contextPack.conversation.recent[0].speaker, undefined);

  const group = await sys.build(buildArgs({
    rule: {provider: 'wechat-main', conversation: 'conv-1', title: '某某群', kind: 'group', prompt: ''},
    contextData: {messages}
  }));
  const groupPrompt = renderContextPrompt({contextPack: group.contextPack});
  assert.match(groupPrompt, /对方（同事甲）：为什么不回复/);
  assert.match(groupPrompt, /我方：在的/, '自己的消息不用挂名字');
  assert.notEqual(group.contextHash, direct.contextHash);
});

test('render: the prompt carries the partitioned sections and evidence ids', async () => {
  const sys = makeSystem();
  const k = sys.knowledge.create('local', {kind: 'faq', title: '营业时间', content: '9-18 点'});
  sys.knowledge.publish('local', k.id);
  const run = await sys.build(buildArgs());
  const prompt = renderContextPrompt({contextPack: run.contextPack, evidenceCatalog: run.evidenceCatalog, rule: {prompt: '自然'}});
  for (const section of ['[DECISION POLICY]', '[CURRENT RULE]', '[COMMUNICATION PROFILE]', '[CONTACT AND OPEN LOOPS]',
    '[VERIFIED KNOWLEDGE WITH EVIDENCE IDS]', '[LIVE FACTS WITH OBSERVED/EXPIRES TIME]', '[REAL CONVERSATION SNAPSHOT]',
    '[APPROVED EXAMPLES]', '[OUTPUT CONTRACT]']) {
    assert.ok(prompt.includes(section), 'missing section ' + section);
  }
  assert.ok(prompt.includes(`[ev_kb_${k.id}]`));
});

test('问产品/问事实的问题要算 faq，不能掉进 social（闲聊）', async () => {
  const { classifyIntent } = await import('./reply-context/risk-gate.mjs');
  // 用户实测：问「介绍一下最终产品关系里面描述的产品形态」被判成 social，
  // 而只有 faq / product_usage 属于"必须引用证据"的意图 —— 于是模型当成闲聊，
  // 回了句"产品那块的细节我这边说不全，等回去咱当面聊"。
  for (const question of [
    '介绍一下产品文档',
    '介绍一下最终产品关系里面描述的产品形态',
    '你们的产品有哪些功能',
    '有没有相关的资料'
  ]) {
    assert.equal(classifyIntent(question), 'faq', question + ' 应当是 faq');
  }
  // 「怎么用」走 product_usage —— 和 faq 一样属于必须引用证据，同样合格
  assert.equal(classifyIntent('这个功能是怎么用的'), 'product_usage');
  // 真正的闲聊仍然算 social，别把规则放宽到失去区分度
  assert.equal(classifyIntent('牛肉记得多炖一会儿会更软'), 'social');
  assert.equal(classifyIntent('今天天气不错'), 'social');
  // 高风险意图优先级不变（排在前面的先命中）
  assert.equal(classifyIntent('这个报价多少'), 'quote');
  assert.equal(classifyIntent('能不能便宜点'), 'discount');
});

test('记住这个人：解析、去重、把握不够的先存候选', async () => {
  const {parseMemoryAnswer, selectNewMemories, sameMemory, applyMemories} =
    await import('./reply-context/memory-update.mjs');

  // 解析：只要 JSON 在，外面裹了什么话都能认
  const parsed = parseMemoryAnswer('好的，我记一下：{"items":[{"kind":"preference","content":"喜欢吃辣","confidence":"high"},'
    + '{"kind":"乱写","content":"周末要去看展","confidence":"low"}]}');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].kind, 'preference');
  assert.equal(parsed[0].confidence, 'high');
  assert.equal(parsed[1].kind, 'fact', '不认识的类型归成 fact');
  assert.deepEqual(parseMemoryAnswer('完全不是 JSON'), []);
  assert.deepEqual(parseMemoryAnswer('{"items":[]}'), []);

  // 去重：标点不同、一个包含另一个，都算同一件事
  assert.equal(sameMemory('喜欢吃辣', '喜欢吃辣。'), true);
  assert.equal(sameMemory('他在做一个跨境电商的项目', '跨境电商的项目'), true);
  assert.equal(sameMemory('喜欢吃辣', '喜欢喝咖啡'), false);
  // 太短的片段不算包含（否则"辣"会把什么都吃掉）
  assert.equal(sameMemory('辣', '他喜欢吃辣'), false);

  const existing = [{content: '喜欢吃辣'}];
  const kept = selectNewMemories([
    {kind: 'preference', content: '喜欢吃辣！'},
    {kind: 'fact', content: '周末要去看展'}
  ], existing);
  assert.equal(kept.length, 1, '重复的不再记');
  assert.equal(kept[0].content, '周末要去看展');

  // 写入：high 才算确认（会进提示词），low 只存成候选
  const added = [];
  const fakeMemory = {add: (workspaceId, item) => { added.push(item); return item; }};
  applyMemories(fakeMemory, 'w1', 'k1', [
    {kind: 'fact', content: '他是我老公', confidence: 'high'},
    {kind: 'event', content: '可能下周出差', confidence: 'low'}
  ], []);
  assert.equal(added.length, 2);
  assert.equal(added[0].status, 'confirmed');
  assert.equal(added[1].status, 'candidate', '拿不准的先别当事实');
});
