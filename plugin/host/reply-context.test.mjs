import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createReplyContextSystem, renderContextPrompt } from './reply-context/index.mjs';
import { evaluateGate } from './reply-context/risk-gate.mjs';
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
