import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Drafts } from './storage.mjs';
import { parseStyleAnswer, buildStylePrompt } from './style-analysis.mjs';

// Development fixtures only: no real WeChat data, no real contact names.

function draftsPath() {
  return join(mkdtempSync(join(tmpdir(), 'message-agent-drafts-')), 'drafts.json');
}

const target = {provider: 'wechat-main', conversation: 'wechat:target', title: '小璐璐', kind: 'direct'};

test('draft submit claims the send exactly once', () => {
  const drafts = new Drafts(draftsPath());
  const draft = drafts.create({target, text: '好的，明天见'}, 1000);
  const claimed = drafts.submit(draft.id, 1, 1001);
  assert.equal(claimed.state, 'sending');
  assert.ok(claimed.requestId);
  // A second submit on the same revision is refused: the draft is no longer awaiting_confirmation.
  assert.throws(() => drafts.submit(draft.id, 1, 1002), /草稿已/);
});

test('draft settle mirrors the runtime outcome, not an invented "sent"', () => {
  const drafts = new Drafts(draftsPath());
  const draft = drafts.create({target, text: '好的'}, 1000);
  drafts.submit(draft.id, 1, 1001);
  const sent = drafts.settle(draft.id, 'sent', {receipt: {status: 'sent'}, detail: '已经发出去了。'}, 1002);
  assert.equal(sent.state, 'sent');
  assert.equal(sent.receipt.status, 'sent');

  const other = drafts.create({target, text: '在吗'}, 1003);
  drafts.submit(other.id, 1, 1004);
  const uncertain = drafts.settle(other.id, 'uncertain', {detail: '发送结果待确认，请不要重复发送。'}, 1005);
  assert.equal(uncertain.state, 'uncertain');
});

test('a settled draft cannot be revised', () => {
  const drafts = new Drafts(draftsPath());
  const draft = drafts.create({target, text: '好的'}, 1000);
  drafts.submit(draft.id, 1, 1001);
  drafts.settle(draft.id, 'sent', {}, 1002);
  assert.throws(() => drafts.revise(draft.id, 1, '改一下', 1003), /不能修改/);
});

test('parseStyleAnswer returns an editable rules object', () => {
  const good = parseStyleAnswer(JSON.stringify({
    name: '小璐璐的日常', rules: {addressRule: '叫名字', hard: ['不用网络语'], preference: ['简短', '口语化'], bannedExpressions: ['亲'], styleNotes: '句短，常用句号'}
  }), {outgoingCount: 12});
  assert.equal(good.ok, true);
  assert.equal(good.name, '小璐璐的日常');
  assert.deepEqual(good.rules.preference, ['简短', '口语化']);
  assert.equal(good.outgoingCount, 12);

  const bad = parseStyleAnswer('这不是 JSON', {outgoingCount: 0});
  assert.equal(bad.ok, false);
});

test('buildStylePrompt only feeds the model my own messages', () => {
  const prompt = buildStylePrompt({identity: {title: '张伟', kind: 'direct'}, messages: [
    {direction: 'incoming', content: '在吗'},
    {direction: 'outgoing', content: '在的，你说'},
    {direction: 'outgoing', content: '那明天见'}
  ]});
  assert.match(prompt, /在的，你说/);
  assert.doesNotMatch(prompt, /在吗/);  // 对方的话不作为"我的说话方式"喂进去
});
