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
    + 'HomeChat,HomePage,ConversationView,ConversationExtras,RailFoot,Cover,TodayPage,AutomationPage,'
    + 'ContextPage,SettingsPage};\n' + marker);

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
    'ConversationExtras 空': h(C.ConversationExtras, {conversationKey: 'k', data: {customer: null, todos: [], followups: []},
      loading: false, onChanged() {}}),
    'ConversationExtras 有内容': h(C.ConversationExtras, {conversationKey: 'k', loading: false, onChanged() {},
      data: {
        customer: {stage: '已报价', nextStep: '周五回电', updatedAt: now},
        todos: [{id: 't1', title: '回他电话', state: 'open', source: 'manual', detail: '周五前'},
                {id: 't2', title: '已经问过了', state: 'done', source: 'manual'}],
        followups: [{id: 'f1', kind: '记录', note: '电话确认了报价，等他周五回复', createdAt: now - 3600}]
      }}),
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

test('会话页底部在没内容时不摆空壳', {skip: available ? false : '找不到宿主的 react，跳过渲染体检'}, () => {
  const {React, ReactDOMServer, C} = ctx;
  const h = React.createElement;
  const empty = ReactDOMServer.renderToStaticMarkup(h(C.ConversationExtras,
    {conversationKey: 'k', data: {customer: null, todos: [], followups: []}, loading: false, onChanged() {}}));
  // 用户点一条最近动态进来，看到的应该是聊天记录 + 一排按钮，而不是三个"还没有…"。
  assert.doesNotMatch(empty, /没有未完成的待办|还没有记录|还没有填写/);
  assert.match(empty, /＋ 待办/);
  assert.match(empty, /＋ 跟进/);

  const filled = ReactDOMServer.renderToStaticMarkup(h(C.ConversationExtras, {conversationKey: 'k', loading: false, onChanged() {},
    data: {
      customer: {stage: '已报价', nextStep: '周五回电', updatedAt: 1},
      todos: [{id: 't1', title: '回他电话', state: 'open', source: 'manual'},
              {id: 't2', title: '已经问过了', state: 'done', source: 'manual'}],
      followups: [{id: 'f1', kind: '记录', note: '电话确认了报价', createdAt: 1}]
    }}));
  assert.match(filled, /回他电话/);
  // 做完的收进折叠的「已完成」，并且**不划删除线**：横线是"取消"的语义。
  assert.match(filled, /已完成 1 件/);
  assert.doesNotMatch(filled, /line-through/);
});
