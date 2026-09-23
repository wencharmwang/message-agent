import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageStamp, renderContextPrompt } from './reply-context/index.mjs';

/**
 * 消息要带时间。
 *
 * 用户实测：周一发了"准备回家"，周三还在按"他还在路上"回复（"路上注意安全"）——
 * 因为**时间在两层投影里都被丢掉了**，模型看到的一串话没有先后。
 * 提示词里"不要把历史状态当作现在的状态"那条规矩因此执行不了。
 */

const DAY = 86400;
const NOW = 1789973708;

test('相对时间：几天前的话要看得出来是几天前', () => {
  assert.match(messageStamp(NOW, NOW), /^\[\d\d-\d\d \d\d:\d\d，今天\]$/);
  assert.match(messageStamp(NOW - DAY, NOW), /昨天\]$/);
  assert.match(messageStamp(NOW - 3 * DAY, NOW), /3 天前\]$/);
  // 没有时间就不硬编一个 —— 宁可空着，也不要给模型假时间
  assert.equal(messageStamp(0, NOW), '');
  assert.equal(messageStamp(undefined, NOW), '');
});

test('快照里每条消息前面都带时间，并且给出"当前时刻"', () => {
  const at = NOW;
  const contextPack = {
    rule: {},
    policy: {},
    profile: {},
    contact: {},
    knowledge: [],
    examples: [],
    conversation: {
      at,
      currentQuestion: '在干嘛呢',
      recent: [
        {role: 'contact', text: '今天晚上做牛肉', at: at - 3 * DAY},
        {role: 'sent', text: '好，我看看几点回来', at: at - 3 * DAY + 600},
        {role: 'contact', text: '在干嘛呢', at}
      ]
    }
  };
  const prompt = renderContextPrompt({contextPack});
  assert.match(prompt, /当前时刻：\[\d\d-\d\d \d\d:\d\d\]/, '要给出当前时刻');
  assert.match(prompt, /3 天前\] 对方：今天晚上做牛肉/, '旧消息要标出是几天前');
  assert.match(prompt, /今天\] 对方：在干嘛呢/, '刚说的标今天');
  // 顺序不能乱：模型是按顺序读的
  const old = prompt.indexOf('今天晚上做牛肉');
  const latest = prompt.indexOf('在干嘛呢');
  assert.ok(old > -1 && latest > old, '旧消息排在前面');
});
