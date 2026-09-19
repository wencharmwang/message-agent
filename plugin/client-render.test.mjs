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

test('产品首屏只呈现自动回复，主动查询回到原生对话框', () => {
  assert.match(source, /const NAV=\[\['automation','自动回复'\],\['context','回复配置'\]\]/);
  assert.match(source, /tab:allowedTabs\.includes\(saved\.tab\)\?saved\.tab:'automation'/);
  assert.match(source, /回到对话框/);
  assert.match(source, /主动查消息继续走原生对话框里的 MCP/);
  // 这条锁的是「首屏英雄区还在」这件事（产品不是一堆裸组件）。
  // 英雄区从品牌渐变板改成了玻璃板，所以断言从渐变字面量换成材质类 + 主标题 ——
  // 断言的是「它在」，不是「它必须是某个色值」。
  assert.match(source, /className:'lg-hero'/);
  assert.match(source, /把重复消息交给助手/);
});

test('品牌图标使用单色绿色聊天气泡', () => {
  assert.match(source, /message-agent-symbol\.svg/);
  assert.doesNotMatch(source, /message-agent-symbol\.png/);
});

test('自动回复开关兼容 Worker 返回的 0/1，并等待刷新后的真实状态', () => {
  assert.match(source, /const active=!!rule\.enabled/);
  assert.doesNotMatch(source, /rule\.enabled===true/);
  assert.match(source, /await api\(path,data\);await status\.refresh\(\)/);
  assert.match(source, /label:active\?'正在监听':'监听已关闭'/);
});

test('自动回复布局给导航和规则卡片稳定边界', () => {
  assert.match(source, /boxSizing:'border-box',position:'relative',zIndex:2/);
  assert.match(source, /className:'ma-rule-grid'/);
  assert.match(source, /gridTemplateColumns:'repeat\(2,minmax\(0,1fr\)\)'/);
  assert.match(source, /WebkitLineClamp:5/);
});

test('从聊天分析使用后台会话 ID 读取，并说明只读不发送', () => {
  assert.doesNotMatch(source, /for\(let seconds=3;seconds>0;seconds--\)/);
  assert.match(source, /后台只读 · 不发消息/);
  assert.match(source, /不依赖 OCR 识别出的人名/);
  assert.match(source, /不需要把微信切到前台/);
  assert.match(source, /后台已经定位到这条会话/);
  assert.doesNotMatch(source, /phase==='idle'/);
  assert.match(source, /context\\\/profiles\\\/analyze\$/);
});

test('身份不确定时界面会明确提示并提供人工确认', () => {
  assert.match(source, /item\.identityStatus==='ambiguous'/);
  assert.match(source, /confirm-identity/);
  assert.match(source, /确认当前联系人/);
});

// 用户逐条提过的界面约定，钉在源码上，避免下一次改动又漂回去：
//   1) 勾选框只有一种；回执/提示后面不挂对勾符号
//   2) 不再给消息下"分类"判断，界面上没有「只需了解」「分类不对？改一下」这类文案
//   3) 会话不能被单独推进「今天要做的」—— 要做的事只有"记成待办"这一条路
//   4) 输入框和结果块要有自己的一层底色，看得见哪里能输入、哪句是结果
//   5) 待办三态（要做/在做/做完）
test('界面约定：单一勾选框、无对勾符号、没有分类、没有「放到今天要做的」', () => {
  assert.doesNotMatch(source, /✓/, '不要再用 ✓ 当回执前缀：统一用勾选框和一个有底色的结果块');
  // 只查**渲染出来的文案**：注释里保留「为什么拿掉」的说明是有意为之。
  assert.doesNotMatch(source, /'只需了解'|分类不对|CLASS_LABEL|CLASS_PILL|ACTION_CLASSES/, '分类这个概念不该再出现在界面上');
  assert.doesNotMatch(source, /放到今天要做的|已在今天要做的|稍后再处理/, '会话不再能进「今天要做的」');
  assert.doesNotMatch(source, /data-todo-toggle/, '自绘的方块勾不要了，统一走 Checkbox');
  // 手写的方块勾（一个 22×22 的 button 里塞 ✓）已经删掉；剩下的 checkbox 只有组件本身
  // 和「这是一个群聊」那个纯表单开关。
  assert.ok((source.match(/type:'checkbox'/g) || []).length <= 2, '勾选框不要再各写各的');
  assert.ok((source.match(/h\(Checkbox,/g) || []).length >= 3, '待办相关的几处都要用同一个勾选框');
  assert.match(source, /--ma-field-bg/, '输入框要有自己的底色');
  assert.match(source, /function Result\(\{text,tone\}\)/, '结果要有一个统一样式的回执块');
  assert.match(source, /'\/doing'/);
  assert.doesNotMatch(source, /const NAV=.*\['messages','消息'\]/, '首版导航不再暴露消息整理页');
});
