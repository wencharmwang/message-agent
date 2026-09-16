/**
 * 渲染契约检查：带「当前选中项」状态的组件必须按项 key 渲染。
 *
 * 背景（真实回归）：详情组件里有属于**单个会话**的本地状态（「已标为已看」的即时反馈、
 * 输入框、错误等）。选择另一个联系人时 React 会复用同一个组件实例，于是这些状态跟着
 * 带过去 —— 用户标了一个会话为已看，接着点开每个联系人都显示「已看」。服务端数据一直
 * 是对的，纯粹是少了 `key`。
 *
 * 单测跑不了真实的 React 渲染，但这条契约可以在源码层面钉住：凡是传了 `customerKey` /
 * `item` / `current` 这类「当前项」的渲染点，都必须同时给 `key`。
 *
 * Run: <managed node> --test plugin/client-render.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'client.js'), 'utf8');

/** 取出 `h(Component,{...})` 的属性片段，按组件名过滤。 */
function renderSites(component) {
  const sites = [];
  const marker = `h(${component},{`;
  let index = source.indexOf(marker);
  while (index !== -1) {
    // 属性片段到这一层调用的 `)` 之前；属性里没有嵌套的 `h(`，所以按 depth 数圆括号即可。
    let depth = 0, end = index + marker.length - 1;
    for (let i = end; i < source.length; i++) {
      const ch = source[i];
      if (ch === '{' || ch === '(') depth++;
      else if (ch === '}' || ch === ')') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    sites.push(source.slice(index + marker.length - 1, end));
    index = source.indexOf(marker, end);
  }
  return sites;
}

test('每次渲染选择项组件都按 key 渲染，实例状态不会带到下一个联系人', () => {
  const sites = [...renderSites('CenterDetail'), ...renderSites('CrmSections')];
  assert.ok(sites.length >= 3, '渲染点数量不对，检查这个测试是否跟得上代码');
  const unkeyed = sites.filter(props => !/(^|[,{])\s*key:/.test(props));
  assert.deepEqual(unkeyed, [],
    '这些渲染点没有给 key：选择另一个联系人时，组件里的「已看 / 输入框 / 错误」会留在界面上');
});

test('详情组件把「已读」状态当成本会话的本地状态，而不是全局状态', () => {
  // 这条注释是给下一个改这段代码的人的：去掉调用处的 key 就会重现「所有联系人都变已看」。
  assert.match(source, /This state belongs to ONE conversation/);
  // 刻意**不**断言 `key={item.key}` 出现：列表里的 map 到处都是这个写法，那种断言会在缺 key
  // 的情况下照样通过（已经踩到过）。真正管用的判定在上面那条渲染点检查里。
});

test('消息页以用户主动整理为首屏，不再引导持续监听', () => {
  assert.match(source, /你想整理什么？/);
  assert.match(source, /message-center\/organize/);
  assert.match(source, /不会在后台持续监听/);
  assert.doesNotMatch(source, /开始关注新消息/);
});
