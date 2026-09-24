import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newSendRequestId } from './product.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 手工发送的 request_id 必须是 UUID。
 *
 * 运行时校验格式，不合格直接以 invalid_arguments 拒绝 ——
 * 曾经写成 `manual-xxx`，于是"点发送"报「没有发出去（invalid_arguments）」。
 */
test('手工发送的 request_id 是 UUID 且不重复', () => {
  const ids = Array.from({length: 50}, () => newSendRequestId());
  for (const id of ids) assert.match(id, UUID, `不是 UUID：${id}`);
  assert.equal(new Set(ids).size, ids.length, '不能重复');
});
