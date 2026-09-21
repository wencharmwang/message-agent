import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homeOverview } from './home.mjs';

/**
 * 「最新消息」这个时间。
 *
 * 原来页面顶部显示的是**扫描时间**（每轮轮询都会刷新），所以永远是"刚刚"——
 * 跟"有没有新消息"毫无关系（用户实测："感觉永远是更新于刚刚，我从来没点过"）。
 * 换成最新一条消息的时间，它才是有信息量的：有新消息才会变。
 */
test('顶部的"最新消息"取的是最新一条消息的时间，不是扫描时间', () => {
  const bundle = [
    {username: 'a', display: '甲', messages: [{at: 100}, {at: 300}]},
    {username: 'b', display: '乙', messages: [{at: 200}]}
  ];
  const overview = homeOverview({bundle, scanAt: 9999, now: 1000});
  assert.equal(overview.latestMessageAt, 300, '跨会话取最大');
  assert.equal(overview.scanAt, 9999, 'scanAt 还留着（别的地方在用），但不给用户看');
});

test('一条消息都没有时是 0（界面据此不显示时间）', () => {
  const overview = homeOverview({bundle: [{username: 'a', display: '甲', messages: []}], now: 1000});
  assert.equal(overview.latestMessageAt, 0);
});
