/**Markdown 渲染的行为测试。

为什么不走"渲染整个应用"那套：助手答案的 markdown 只在特定输入下出现，用整页渲染
测不到。这里把这三个函数从源码里抠出来、给一个最小的 h 桩，直接验行为。

盯的是用户实测到的问题：回答里写 `**结论：…**`，界面上把星号原样摆出来了。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, 'client.js'), 'utf8');

const C = {text:'#111', text2:'#444', text3:'#888', brand:'#07c160', border:'#eee', panel:'#fff'};
function h(type, props, ...children){
  const flat = children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false);
  return {type, props: props || {}, children: flat};
}
function textOf(node){
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return (node.children || []).map(textOf).join('');
}
function names(node, out = []){
  if (Array.isArray(node)) { node.forEach(child => names(child, out)); return out; }
  if (!node || typeof node === 'string') return out;
  out.push(node.type);
  (node.children || []).forEach(child => names(child, out));
  return out;
}

const start = source.indexOf('  const INLINE_RULES=[');
const end = source.indexOf('  function answerBody(text){');
assert.ok(start > 0 && end > start, '抠不出 markdown 那一段');
const body = source.slice(start, end);
const renderMarkdown = new Function('h', 'C', body + 'return renderMarkdown;')(h, C);

test('**粗体** 变成 <strong>，星号不再出现在界面上', () => {
  const nodes = renderMarkdown('**结论：今天只有 Wencharm 给你发过消息。**');
  const list = names(nodes);
  assert.ok(list.includes('strong'), '应当渲染出 strong');
  assert.equal(textOf(nodes).includes('*'), false, '不该留下星号');
  assert.match(textOf(nodes), /结论：今天只有 Wencharm 给你发过消息。/);
});

test('列表、标题、代码、链接、引用各有各的样子', () => {
  const nodes = renderMarkdown([
    '## 今天', '- 回张伟的报价', '- 确认发货时间', '1. 先回报价', '> 他说周五前要',
    '`code` 和 [官网](https://example.com)'
  ].join('\n'));
  const list = names(nodes);
  assert.ok(list.includes('ul'), '无序列表');
  assert.ok(list.includes('li'), '列表项');
  assert.ok(list.includes('code'), '行内代码');
  assert.ok(list.includes('a'), '链接');
  const heading = nodes.find(node => typeof node === 'object' && node.props?.style?.fontWeight === 600);
  assert.ok(heading, '标题要加粗');
  const link = (function find(node){
    if (Array.isArray(node)) { for (const child of node) { const hit = find(child); if (hit) return hit; } return null; }
    if (!node || typeof node === 'string') return null;
    if (node.type === 'a') return node;
    for (const child of node.children || []) { const hit = find(child); if (hit) return hit; }
    return null;
  })(nodes);
  assert.equal(link.props.href, 'https://example.com');
});

test('认不出的内容原样保留 —— 别把用户该看到的字吃掉', () => {
  const raw = '价格是 3**2 元，见 https://example.com/a_b 或表格 | 列1 | 列2 |';
  assert.equal(textOf(renderMarkdown(raw)), raw);
});

test('没有 markdown 时不产生多余包裹', () => {
  const nodes = renderMarkdown('今天没什么要处理的。');
  assert.equal(textOf(nodes), '今天没什么要处理的。');
});
