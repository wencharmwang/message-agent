import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCrm } from './crm.mjs';

// Development fixtures only: no real WeChat data, no real contact names.

function makeCrm() {
  return createCrm(join(mkdtempSync(join(tmpdir(), 'message-agent-crm-')), 'crm.db'));
}

test('deleting a contact removes its to-dos and follow-ups', () => {
  const crm = makeCrm();
  crm.ensureCustomer({key: 'k1', provider: 'wechat-main', conversation: 'c1', displayName: '张三', kind: 'direct'});
  crm.createTodo({conversationKey: 'k1', title: '回他电话', source: 'manual'});
  crm.addFollowup('k1', {kind: '记录', note: '聊了报价'});
  assert.equal(crm.listTodos({conversationKey: 'k1'}).length, 1);

  crm.deleteCustomer('k1');
  assert.equal(crm.getCustomer('k1'), null);
  assert.equal(crm.listTodos({conversationKey: 'k1'}).length, 0);
  assert.equal(crm.listFollowups('k1').length, 0);
  assert.throws(() => crm.deleteCustomer('k1'), /还没有这个联系人/);
});

test('rekey moves a contact and its records to the new conversation key', () => {
  const crm = makeCrm();
  crm.ensureCustomer({key: 'old', provider: 'wechat-main', conversation: 'c1', displayName: '张伟', kind: 'direct'});
  crm.createTodo({conversationKey: 'old', title: '回他电话', source: 'manual'});

  assert.equal(crm.rekey('old', 'new', {provider: 'wechat-main', conversation: 'c2', displayName: '张伟（备注）'}), true);
  assert.equal(crm.getCustomer('old'), null);
  assert.equal(crm.getCustomer('new').identity.title, '张伟（备注）');
  assert.equal(crm.listTodos({conversationKey: 'new'}).length, 1);
});

test('rekey on a contact that does not exist is a no-op', () => {
  const crm = makeCrm();
  assert.equal(crm.rekey('missing', 'new', {}), false);
});
