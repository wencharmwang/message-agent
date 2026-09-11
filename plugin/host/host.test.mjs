import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Drafts, DRAFT_TTL_SECONDS, validateDraftText } from './storage.mjs';
import { identityKey, projectInbox, pageInbox, RUNTIME_MESSAGES } from './product.mjs';

// Development fixtures only: no real WeChat data, no real contact names.

function draftsPath() {
  return join(mkdtempSync(join(tmpdir(), 'message-agent-drafts-')), 'drafts.json');
}

test('identityKey keeps the legacy automatic key and adds a purpose dimension', () => {
  const legacy = identityKey('wechat-main', 'conv-1');
  assert.equal(legacy.length, 64);
  assert.notEqual(identityKey('wechat-main', 'conv-1', 'interactive'), legacy);
  assert.equal(identityKey('wechat-main', 'conv-1'), identityKey('wechat-main', 'conv-1'));
});

test('drafts: create, revise with revision guard, cancel, expiry', () => {
  const drafts = new Drafts(draftsPath());
  const target = {provider: 'wechat-main', conversation: 'conv-1', title: 'Fixture Contact', kind: 'direct'};
  const created = drafts.create({target, text: '你好，这是测试草稿'}, 1000);
  assert.equal(created.state, 'awaiting_confirmation');
  assert.equal(created.revision, 1);
  assert.equal(created.expiresAt, 1000 + DRAFT_TTL_SECONDS);

  assert.throws(() => drafts.revise(created.id, 99, '改', 1001), /版本已变化/);
  const revised = drafts.revise(created.id, 1, '修改后的正文', 1001);
  assert.equal(revised.revision, 2);
  assert.equal(revised.text, '修改后的正文');
  assert.equal(revised.expiresAt, 1001 + DRAFT_TTL_SECONDS);

  const cancelled = drafts.cancel(created.id, 1002);
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(drafts.cancel(created.id, 1003).state, 'cancelled'); // idempotent
  assert.throws(() => drafts.revise(created.id, 2, '再改', 1004), /不能修改/);
});

test('drafts: awaiting drafts expire lazily and closed drafts stay untouched', () => {
  const drafts = new Drafts(draftsPath());
  const target = {provider: 'wechat-main', conversation: 'conv-1', title: 'Fixture Contact', kind: 'direct'};
  const a = drafts.create({target, text: '会过期'}, 1000);
  const b = drafts.create({target, text: '已取消'}, 1000);
  drafts.cancel(b.id, 1001);
  const listed = drafts.list({}, 1000 + DRAFT_TTL_SECONDS + 1);
  assert.equal(listed.find(d => d.id === a.id).state, 'expired');
  assert.equal(listed.find(d => d.id === b.id).state, 'cancelled');
  assert.throws(() => drafts.revise(a.id, 1, '改', 1000 + DRAFT_TTL_SECONDS + 2), /不能修改/);
});

test('validateDraftText enforces bounded single-line text without credentials', () => {
  assert.equal(validateDraftText('正常回复', 500), '正常回复');
  assert.throws(() => validateDraftText('', 500));
  assert.throws(() => validateDraftText('两行\n文本', 500));
  assert.throws(() => validateDraftText('x'.repeat(501), 500));
  assert.throws(() => validateDraftText('sk-abcdefghijklmnop1234', 500), /凭据/);
});

const rule = (id, over = {}) => ({
  id, provider: 'wechat-main', conversation: 'conv-' + id, title: 'Fixture ' + id, kind: 'direct',
  prompt: 'p', enabled: 1, revision: 1, status: 'listening', detail: '', observed_at: 100, ...over
});
const job = (ruleId, over = {}) => ({
  id: 'job-' + ruleId + '-' + (over.state ?? 'x'), rule_id: ruleId, state: 'sent', text: '', detail: '',
  decision: null, created_at: 90, finished_at: 95, ...over
});

test('projectInbox separates processing, delivery and attention states', () => {
  const drafts = [{
    id: 'd1', revision: 1, target: {provider: 'wechat-main', conversation: 'conv-draft'},
    text: 't', state: 'awaiting_confirmation', createdAt: 300, updatedAt: 300, expiresAt: 2100
  }];
  const items = projectInbox({
    rules: [
      rule('ok'),
      rule('busy', {status: 'settling'}),
      rule('blocked', {status: 'blocked', detail: '发送阶段中断'}),
      rule('offline', {status: 'waiting_connection', detail: '微信暂时无法连接'}),
      rule('paused', {enabled: 0, status: 'paused'}),
      rule('active'),
      rule('draft'),
      rule('needsuser', {status: 'needs_user', detail: '需要本人确认报价'})
    ],
    jobs: [
      job('active', {state: 'generating', created_at: 200, finished_at: null}),
      job('ok', {state: 'sent', created_at: 90, finished_at: 95})
    ],
    bindings: {[identityKey('wechat-main', 'conv-ok')]: 'messaging-conversation-' + identityKey('wechat-main', 'conv-ok')},
    drafts
  });
  const byId = Object.fromEntries(items.map(i => [i.rule.id, i]));

  assert.equal(byId['ok'].bucket, 'ok');
  assert.equal(byId['ok'].processingState, 'listening');
  assert.equal(byId['ok'].deliveryState, 'sent'); // receipt state only, never from generation
  assert.ok(byId['ok'].sessions.automatic);
  assert.equal(byId['ok'].sessions.interactive, null);

  assert.equal(byId['busy'].bucket, 'processing');
  assert.equal(byId['active'].bucket, 'processing');
  assert.equal(byId['active'].processingState, 'generating'); // active job wins over rule status

  assert.equal(byId['blocked'].bucket, 'error');
  assert.equal(byId['blocked'].attentionReason, '上一条回复的结果没有确认（不会自动重发），你可以去微信里看一眼');
  assert.equal(byId['offline'].bucket, 'error');
  // The old copy told people to look at WeChat, which is almost never the cause.
  assert.equal(byId['offline'].attentionReason, RUNTIME_MESSAGES.provider_unavailable);

  assert.equal(byId['paused'].bucket, 'ok');
  assert.equal(byId['paused'].coverage, 'paused');

  assert.equal(byId['draft'].bucket, 'pending');
  assert.equal(byId['draft'].pendingDrafts, 1);
  assert.equal(byId['draft'].attentionReason, '有一条回复等你确认后才会发出');
  assert.equal(byId['draft'].updatedAt, 300); // draft activity moves the item up

  assert.equal(byId['needsuser'].bucket, 'pending');
  assert.equal(byId['needsuser'].attentionReason, '需要本人确认报价');
});

test('projectInbox surfaces a needs_user decision on a finished job', () => {
  const items = projectInbox({
    rules: [rule('r')],
    jobs: [job('r', {state: 'done', created_at: 100, finished_at: 110,
      decision: JSON.stringify({action: 'needs_user', text: '', reason: '需要决定是否降价'})})],
    bindings: {}, drafts: []
  });
  assert.equal(items[0].bucket, 'pending');
  assert.equal(items[0].attentionReason, '需要决定是否降价');
});

test('projectInbox: latest finished job failed or uncertain is an error, not a delivery', () => {
  const items = projectInbox({
    rules: [rule('r')],
    jobs: [
      job('r', {state: 'failed', detail: 'Runtime: conversation_unverified', created_at: 100, finished_at: 110}),
      job('r', {id: 'job-r-old', state: 'sent', created_at: 50, finished_at: 60})
    ],
    bindings: {}, drafts: []
  });
  assert.equal(items[0].bucket, 'error');
  // A raw runtime code must never reach the user; it is replaced by one plain sentence.
  assert.equal(items[0].attentionReason, RUNTIME_MESSAGES.conversation_unverified);
  assert.equal(items[0].deliveryState, 'sent'); // older real receipt still shown separately
});

test('projectInbox stops flagging a problem the user has already looked at', () => {
  const jobs = [job('r', {state: 'uncertain', created_at: 100, finished_at: 110})];
  const open = projectInbox({rules: [rule('r')], jobs, bindings: {}, drafts: []});
  assert.equal(open[0].bucket, 'error');
  assert.equal(open[0].attentionKind, 'send');
  // "I looked at it" clears the alert but leaves the delivery record alone.
  const reviewed = projectInbox({rules: [rule('r')], jobs, bindings: {}, drafts: [],
    reviewed: {'job-r-uncertain': 1789000000}});
  assert.equal(reviewed[0].bucket, 'ok');
  assert.equal(reviewed[0].attentionReason, null);
  assert.equal(reviewed[0].deliveryState, 'uncertain');   // the fact is still reported
});

test('pageInbox filters and paginates without overlap or loss', () => {
  const rules = Array.from({length: 5}, (_, i) => rule('r' + i, {observed_at: 100 + i}));
  const items = projectInbox({rules, jobs: [], bindings: {}, drafts: []});
  const first = pageInbox(items, {limit: 2});
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = pageInbox(items, {limit: 2, cursor: first.nextCursor});
  const third = pageInbox(items, {limit: 2, cursor: second.nextCursor});
  const keys = [...first.items, ...second.items, ...third.items].map(i => i.key);
  assert.equal(new Set(keys).size, 5);
  assert.equal(third.nextCursor, null);
  assert.equal(pageInbox(items, {filter: 'pending'}).items.length, 0);
  assert.equal(pageInbox(items, {filter: 'error'}).items.length, 0);
  assert.throws(() => pageInbox(items, {limit: 2, cursor: '0:nonexistent'}), /分页位置已失效/);
});
