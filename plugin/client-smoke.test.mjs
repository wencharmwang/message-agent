/**
 * 渲染冒烟测试：把界面组件真的渲染一遍，抓"白屏"这一类 bug。
 *
 * 为什么需要它：`client.js` 是一个模块加载器工厂，组件不导出，源码级断言（见
 * client-render.test.mjs）只能查字符串。但"漏传一个 prop、把一个不存在的常量写进
 * style、用了 undefined 的组件"这类问题字符串断言看不出来，浏览器里却是整页白屏 ——
 * 而且只有在用户打开那一页时才会发现。
 *
 * 做法：在内存里给工厂源码追加一行"把组件挂到 globalThis"，用 react-dom/server 把它们
 * 渲染成静态标记。SSR 下 useEffect 不执行，所以数据类组件会停在初始状态（加载中/空），
 * 正好验证"最差情况下页面也不是白屏"。
 *
 * react 从宿主的 node_modules 里取（这个插件本身不带依赖）。取不到就整组跳过 ——
 * 这只是一个体检，不该让没有那个目录的机器上测试变红。
 *
 * Run: <managed node> --test plugin/client-smoke.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const harness = process.env.HARNESS_ROOT ?? 'C:/Users/Wencharm/Documents/projects/deepseek-harness';
const pnpm = join(harness, 'node_modules', '.pnpm');

/** pnpm 的目录名带 peer 后缀（react-dom@18.3.1_react@18.3.1），所以按前缀找。 */
function resolvePnpmPackage(prefix, entry) {
  if (!existsSync(pnpm)) return null;
  const dir = readdirSync(pnpm).find(name => name.startsWith(prefix));
  return dir ? join(pnpm, dir, 'node_modules', entry) : null;
}
const reactEntry = resolvePnpmPackage('react@', 'react');
const reactDomEntry = resolvePnpmPackage('react-dom@', 'react-dom');
const available = !!reactEntry && !!reactDomEntry;

function build() {
  const require = createRequire(join(reactEntry, 'package.json'));
  const React = require(reactEntry);
  const ReactDOMServer = require(join(reactDomEntry, 'server.js'));

  // 组件在模块作用域就会碰这些浏览器全局，必须在加载源码前补齐。
  globalThis.window = {};
  globalThis.document = {
    head: {appendChild() {}},
    getElementById() { return null; },
    createElement() { return {style: {}, set textContent(_) {}, id: ''}; },
    addEventListener() {}, removeEventListener() {}, hidden: false
  };
  globalThis.localStorage = {getItem() { return null; }, setItem() {}};
  globalThis.sessionStorage = {getItem() { return null; }, setItem() {}};
  globalThis.matchMedia = () => ({matches: false, addEventListener() {}, removeEventListener() {}});
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  try { Object.defineProperty(globalThis, 'navigator', {value: {clipboard: {writeText() {}}}, configurable: true}); } catch {}

  const source = readFileSync(join(here, 'client.js'), 'utf8');
  const marker = "  return{inject:['slots','sessions'],apply(ctx){";
  assert.ok(source.includes(marker), 'client.js 的模块导出点变了，这个冒烟测试需要跟着改');
  const patched = source.replace(marker,
    '  globalThis.__MA_COMPONENTS__={SessionRow,HomeCard,StatStrip,OrganizeResult,ChatBubble,'
    + 'HomeChat,HomePage,ConversationView,ConversationTodos,MessageBubble,MessageDay,TaskModelPicker,'
    + 'RailFoot,Cover,TodayPage,AutomationPage,ContextPage,SettingsPage,TodoRow,Row};\n' + marker);

  let factory = null;
  globalThis.window.__ModuleLoader__ = {load({factory: register}) { factory = register; }};
  new Function('window', 'globalThis', patched)(globalThis.window, globalThis);
  assert.ok(factory, '模块工厂没有注册');
  factory(id => {
    if (id === 'react') return React;
    throw new Error('未预期的 require: ' + id);
  });
  return {React, ReactDOMServer, C: globalThis.__MA_COMPONENTS__};
}

const ctx = available ? build() : null;
const store = {
  get: () => ({open: true, cover: true, tab: 'home', contactKey: null, pending: 0}),
  set() {}, subscribe: () => () => {}
};

test('界面组件都能渲染出内容（白屏体检）', {skip: available ? false : '找不到宿主的 react，跳过渲染体检'}, () => {
  const {React, ReactDOMServer, C} = ctx;
  const h = React.createElement;
  const now = Date.now() / 1000;
  const cases = {
    StatStrip: h(C.StatStrip, {totals: {waiting: 2, todos: 3, todayMessages: 41}}),
    SessionRow: h(C.SessionRow, {session: {username: 'dox', title: 'Wencharm', kind: 'direct', lastAt: now - 600,
      unread: 2, waitingReply: true, preview: '周五的报价我改好了', lastDirection: 'incoming'}, onOpen() {}}),
    'OrganizeResult 无结论': h(C.OrganizeResult, {result: {summary: '最近没什么要处理的。', focus: [], todos: [], at: now, sessionsRead: 6},
      busy: false, picked: {}, added: {}, onCheck() {}, onAdd() {}, onOpen() {}}),
    'OrganizeResult 有待办': h(C.OrganizeResult, {
      result: {
        summary: '张三在等你确认报价，另外业主群里有人问交房时间。',
        focus: [{conversation: '张三', why: '在等你回价格', action: '今天内回复', username: 'zhangsan', kind: 'direct'},
                {conversation: '轮滑班群', why: '问周六上课时间', action: '回一句', username: '123@chatroom', kind: 'group'}],
        todos: [{title: '回复张三的报价', conversation: '张三', detail: '「这个价能做吗」', username: 'zhangsan', kind: 'direct'},
                {title: '确认周六上课时间', conversation: '轮滑班群', detail: '「周六照常吗」', username: '123@chatroom'}],
        at: now, sessionsRead: 8
      },
      busy: false, picked: {}, added: {}, onCheck() {}, onAdd() {}, onOpen() {}}),
    'OrganizeResult 全不选': h(C.OrganizeResult, {
      result: {summary: 'x', focus: [], todos: [{title: 'A', conversation: '张三', detail: 'd'}], at: 0, sessionsRead: 1},
      busy: false, picked: {0: false}, added: {}, onCheck() {}, onAdd() {}, onOpen() {}}),
    'ChatBubble 用户': h(C.ChatBubble, {item: {role: 'user', text: '谁在等我回复？'}, onAddTodos() {}}),
    'ChatBubble 助手': h(C.ChatBubble, {item: {role: 'assistant',
      text: '**结论**：有 1 个人在等你。\n\n- [ ] 回复张三的报价', tools: ['mcp__messaging__read_messages']}, onAddTodos() {}}),
    HomeChat: h(C.HomeChat, {narrow: false}),
    HomePage: h(C.HomePage, {store, narrow: false}),
    'HomePage 窄屏': h(C.HomePage, {store, narrow: true}),
    ConversationView: h(C.ConversationView, {store, username: 'doy1572', title: 'Wencharm', kind: 'direct', narrow: false}),
    MessageBubble: h(C.MessageBubble, {message: {direction: 'incoming', content: '周五的报价我改好了', at: now - 60}}),
    MessageDay: h(C.MessageDay, {message: {at: now}, previous: {at: now - 86400 * 3}}),
    'TaskModelPicker 空目录': h(C.TaskModelPicker, {title: '自动回复模型', description: 'x',
      catalog: {loading: true, data: null}, provider: 'deepseek-official', model: 'deepseek-v4-flash', onPick() {}}),
    'TaskModelPicker 有本地模型': h(C.TaskModelPicker, {title: '整理消息模型', description: 'y', saving: true,
      catalog: {loading: false, data: {models: [
        {provider: 'deepseek-official', providerName: 'DeepSeek', id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash'},
        {provider: 'ollama-local', providerName: '本地 Qwen', id: 'qwen-dsh-16k:latest', name: 'qwen-dsh-16k'}
      ]}}, provider: 'ollama-local', model: 'qwen-dsh-16k:latest', onPick() {}}),
    'ConversationTodos 空': h(C.ConversationTodos, {conversationKey: 'k', todos: [], onChanged() {}}),
    'ConversationTodos 有内容': h(C.ConversationTodos, {conversationKey: 'k', onChanged() {},
      todos: [{id: 't1', title: '回他电话', state: 'open', source: 'manual', detail: '周五前'},
              {id: 't2', title: '已经问过了', state: 'done', source: 'assistant'}]}),
    Cover: h(C.Cover, {store}),
    TodayPage: h(C.TodayPage, {store, ctx: {}}),
    AutomationPage: h(C.AutomationPage),
    ContextPage: h(C.ContextPage),
    SettingsPage: h(C.SettingsPage)
  };
  const broken = [];
  for (const [name, element] of Object.entries(cases)) {
    try {
      const markup = ReactDOMServer.renderToStaticMarkup(element);
      if (!markup || markup.length < 20) broken.push(`${name}: 渲染结果为空`);
    } catch (error) {
      broken.push(`${name}: ${String(error?.message ?? error).split('\n')[0]}`);
    }
  }
  assert.deepEqual(broken, [], '这些组件渲染不出来（浏览器里就是白屏）');
});

test('首页渲染出来的是「消息」三块，不是一个空白壳', {skip: available ? false : '找不到宿主的 react，跳过渲染体检'}, () => {
  const {React, ReactDOMServer, C} = ctx;
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(C.HomePage, {store, narrow: false}));
  // 加载态也要有话说（数据要等一次 loopback），不能只是空白。
  assert.match(html, /正在打开消息/, '首屏加载态没有文案');
  const settled = ReactDOMServer.renderToStaticMarkup(React.createElement(C.Cover, {store}));
  assert.match(settled, /打开消息助手/);
});

test('会话页的滚动区是页面的兄弟节点，没有被塞进页头', {skip: available ? false : '找不到宿主的 react，跳过渲染体检'}, () => {
  const {React, ReactDOMServer, C} = ctx;
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(C.ConversationView,
    {store, username: 'doy1572', title: 'Wencharm', kind: 'direct', narrow: false}));
  // 回归（真实踩到）：页头那个 div 漏掉一个 ')' 时，滚动容器会被当成页头的**子节点**。
  // 页头是 flex-shrink:0 且高度随内容走，于是整段内容溢出被裁掉 —— 页面看着在，滚不动。
  // 页头的孩子里没有 div，所以"页头开始之后第一个 </div>"必然是页头自己的收尾，
  // 它必须出现在滚动容器**之前**。
  const headerStart = html.indexOf('flex-shrink:0');
  assert.ok(headerStart >= 0, '没找到页头');
  const headerClose = html.indexOf('</div>', headerStart);
  const scrollStart = html.indexOf('overflow-y:auto');
  assert.ok(scrollStart > 0, '没找到滚动区');
  assert.ok(scrollStart > headerClose,
    '滚动区被塞进页头里了：页头不收缩，内容会溢出被裁，页面就滚不动');
});

test('会话页底部只剩待办，空的时候不摆空壳', {skip: available ? false : '找不到宿主的 react，跳过渲染体检'}, () => {  const {React, ReactDOMServer, C} = ctx;
  const h = React.createElement;
  const empty = ReactDOMServer.renderToStaticMarkup(h(C.ConversationTodos,
    {conversationKey: 'k', todos: [], onChanged() {}}));
  // CRM 那块暂时不做：跟进记录与联系人资料都不该出现在会话页里。
  assert.doesNotMatch(empty, /跟进|联系人资料|没有未完成的待办|还没有记录|还没有填写/);
  assert.match(empty, /＋ 待办/);

  const filled = ReactDOMServer.renderToStaticMarkup(h(C.ConversationTodos, {conversationKey: 'k', onChanged() {},
    todos: [{id: 't1', title: '回他电话', state: 'open', source: 'manual'},
            {id: 't2', title: '已经问过了', state: 'done', source: 'assistant'}]}));
  assert.match(filled, /回他电话/);
  // 做完的收进折叠的「已完成」，且不划删除线、不再重复标一次状态。
  assert.match(filled, /已完成 1 件/);
  assert.doesNotMatch(filled, /line-through/);
  // 来源只留图标：允许出现在 title/aria-label（悬停提示与无障碍），但不能当可见文字。
  for (const word of ['助手记的', '自己记的']) {
    const total = [...filled.matchAll(new RegExp(word, 'g'))].length;
    const asAttribute = [...filled.matchAll(new RegExp(`(?:title|aria-label)="${word}"`, 'g'))].length;
    assert.equal(total, asAttribute, `${word} 只能出现在 title/aria-label 里，不能是可见文字`);
  }
});

test('已完成条目带长文案时，删除入口仍然渲染出来', {skip: available ? false : '找不到宿主的 react，跳过渲染体检'}, () => {
  const {React, ReactDOMServer, C} = ctx;
  const h = React.createElement;
  const TRASH = 'M4.6 5.8h10.8';   // 垃圾桶路径的前缀
  const SOURCE = ['M10 3.4l1.55', 'M10 9.3a3 3'];  // 星 / 人形
  const worst = {
    id: 't', state: 'done', source: 'assistant',
    title: '问一下管家电梯排查进展，并把结果回一句给群里等消息的邻居',
    detail: '对方再次催转账200元，涉及资金支付与本人授权，属 payment 人工处理范围，需本人决定。'
      + '这条文案故意写得很长，用来模拟"有很多行文案"的情况。'
  };
  const cases = {
    'TodoRow 已完成 + 长详情': h(C.TodoRow, {todo: worst, onAction() {}}),
    'TodoRow 已完成 + 无详情': h(C.TodoRow, {todo: {...worst, detail: ''}, onAction() {}}),
    'Row 已完成 + 长标题': h(C.Row, {title: worst.title, right: '3分钟前',
      meta: h('div', {style: {display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12}},
        h('span', null, h('span', null, 'src')),
        h('button', {className: 'ma-iconbtn', title: '删除这条待办'}, 'x'))})
  };
  for (const [name, element] of Object.entries(cases)) {
    const html = ReactDOMServer.renderToStaticMarkup(element);
    if (name.startsWith('TodoRow')) {
      assert.ok(html.includes(TRASH), `${name}：删除图标没渲染出来`);
      assert.ok(SOURCE.some(path => html.includes(path)), `${name}：来源图标没渲染出来`);
      // 删除入口要在第二行的右侧栏里 —— 结构上不可能被文案挤掉。
      assert.match(html, /justify-content:space-between/, `${name}：第二行没有拆成两栏`);
    }
    assert.ok(html.length > 40, `${name}：渲染结果是空的`);
  }
});
