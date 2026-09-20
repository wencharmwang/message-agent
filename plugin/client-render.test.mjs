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
  const sites = [...renderSites('CrmSections'), ...renderSites('ConversationView')];
  assert.ok(sites.length >= 2, '渲染点数量不对，检查这个测试是否跟得上代码');
  const unkeyed = sites.filter(props => !/(^|[,{])\s*key:/.test(props));
  assert.deepEqual(unkeyed, [],
    '这些渲染点没有给 key：选择另一个联系人时，组件里的「输入框 / 错误」会留在界面上');
});

test('会话视图的本地状态按会话隔离', () => {
  // 这条注释是给下一个改这段代码的人的：去掉调用处的 key 就会重现「上一个人的状态跟着走」。
  assert.match(source, /This state belongs to ONE conversation/);
  // 刻意**不**断言 `key={item.key}` 出现：列表里的 map 到处都是这个写法，那种断言会在缺 key
  // 的情况下照样通过（已经踩到过）。真正管用的判定在上面那条渲染点检查里。
});

test('首屏是消息页：关键信息 + 关键操作 + 对话', () => {
  assert.match(source, /const NAV=\[\['home','消息'\],\['todos','待办'\],\['automation','自动回复'\],\['context','回复配置'\]\]/);
  assert.match(source, /allowedTabs\.includes\(saved\.tab\)\?saved\.tab:'home'/);
  assert.match(source, /function HomePage\(\{store,narrow\}\)/);
  assert.match(source, /function HomeChat\(\{narrow\}\)/);
  assert.match(source, /function ConversationView\(\{store,username,title,kind,narrow\}\)/);
  // 主操作只有一条：整理消息。
  assert.match(source, /'正在整理…':'整理消息'/);
  // 对话区明确告诉用户"不会打扰微信"，但**不**提任何数据来源的实现细节。
  assert.match(source, /不打开微信窗口，不会打扰你/);
});

test('会话页不做 CRM，完成的条目不划删除线', () => {
  // 只看**代码**，注释里保留"为什么拿掉"的说明是有意为之。
  const code = source.split('\n').filter(line => {
    const trimmed = line.trim();
    return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
  }).join('\n');
  const view = code.slice(code.indexOf('function ConversationView('), code.indexOf('function CrmSections('));
  assert.match(view, /ConversationTodos/);
  // CRM 暂时不做：会话页里不许挂跟进记录 / 联系人资料 / CrmSections（等真要做时统一做）。
  assert.doesNotMatch(view, /CrmSections/, '会话页不该挂 CRM 那套组件');
  assert.doesNotMatch(view, /联系人资料|＋ 跟进|followups/);
  // 待办来源只用图标（星 = 助手记的，人形 = 自己记的），不写文字。
  assert.match(code, /name:fromAssistant\?'spark':'person'/);
  // 全程不用删除线：表达"已完成 / 已加入"一律用状态标签或图标。
  assert.doesNotMatch(code, /line-through/, '删除线是"作废"的语义，别拿它表示完成');
});

test('导航图标按用户逐条指认的形状', () => {
  assert.match(source, /const NAV_ICON=\{home:'home',messages:'messages',today:'check',customers:'contacts',automation:'automation',context:'settings'\}/);
  // 待办 = 一个勾（不带框）；设置 = 通用齿轮；回复配置沿用原来那颗圆盘 + 辐条。
  assert.match(source, /check:'M4\.8 10\.7 8\.4 14\.3 15\.4 7\.1'/);
  assert.match(source, /gear:'M10 3\.2/);
  // 消息就是原来「待办」用的那个图标，原样搬过来。
  assert.match(source, /home:'M4\.2 4\.5h11\.6[^']*Zm2\.5 5\.7 1\.5 1\.5 2\.9-2\.9'/);
  assert.match(source, /h\(Icon,\{name:'gear',size:18\}\),narrow\?null:'设置'/);
});

test('图标按钮够大、位置固定，文案不啰嗦', () => {
  // 纯图标按钮外面必须留点击留白，否则"看不清、点不准"。
  assert.match(source, /const iconButton=\{border:'none'[\s\S]*?padding:6/);
  // 悬停要变色才有"这是操作"的感觉 —— 颜色交给 CSS，行内样式会盖掉它。
  assert.match(source, /\.ma-iconbtn:not\(:disabled\):hover\{background:var\(--lg-tint\);color:var\(--ma-danger\)\}/);
  assert.match(source, /h\(Icon,\{name:fromAssistant\?'spark':'person',size:16\}\)/, '来源图标要 16px（原来是 13px）');
  assert.match(source, /h\(Icon,\{name:'trash',size:16\}\)/, '删除图标要 16px');
  // 「返回」本来就是回上一级，不要再写"全部消息"。
  assert.match(source, /title:'返回消息列表'/);
  assert.doesNotMatch(source, /← 全部消息/);
  // 待办页的主按钮叫「＋ 待办」，别写成「＋ 加一条待办」。
  const page = source.slice(source.indexOf('function TodayPage('), source.indexOf('function CustomersPage('));
  assert.match(page, /'＋ 待办'/);
  assert.doesNotMatch(page, /＋ 加一条待办/);
});

test('已完成条目的删除入口固定在第二行右侧，不会被长文案挤掉', () => {
  // 用户实测：有第二行文案时来源图标和删除都看不见了。所以第二行必须拆成
  // 「左信息 / 右操作」两栏，操作列固定在最右，标题多长都挤不掉它。
  const row = source.slice(source.indexOf('function TodoRow('), source.indexOf('function TodayPage('));
  assert.match(row, /justifyContent:'space-between'[\s\S]*?className:'ma-iconbtn'/, '删除按钮必须在第二行的右侧栏里');
  // 待办页的已完成分组同理。
  const page = source.slice(source.indexOf('function TodayPage('), source.indexOf('function CustomersPage('));
  assert.match(page, /className:'ma-iconbtn'/, '待办页的已完成条目也要有删除按钮');
  // 行标题要能收缩，否则超长串会把右边挤出去。
  assert.match(source, /fontWeight:600,minWidth:0,wordBreak:'break-word'/);
});

test('界面不提"数据库"这类实现细节', () => {
  // 用户明确要求：界面上不能出现读取本地数据库的说法。检查所有**字符串字面量**里的
  // 相关词——注释里为开发保留说明是允许的（`//` 与 `*` 开头的行不算）。
  const uiLines = source.split('\n')
    .map((line, index) => ({line, index: index + 1}))
    .filter(({line}) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
    });
  const leaky = uiLines.filter(({line}) => /数据库|数据表|db副本|副本|解锁/.test(line));
  assert.deepEqual(leaky.map(({index, line}) => index + ': ' + line.trim()), []);
});

test('「回到对话框」退化到开发者模式，不再占日常路径', () => {
  // 它还是存在的（开发者要用），但必须挂在开发者开关后面，而不是摆在导航底部。
  assert.match(source, /function RailFoot\(\{store,narrow,tab,closeRef\}\)/);
  assert.match(source, /const dev=useDevMode\(\);/);
  assert.match(source, /dev&&h\('button',\{ref:closeRef/);
  assert.match(source, /回到原生对话框（开发用）/);
  // 收起来的封面上也不再直接给出口。
  assert.match(source, /'打开消息助手'/);
  assert.doesNotMatch(source, /narrow\?'返回':'← 回到对话框'/);
  assert.doesNotMatch(source, /'管理自动回复'/);
  // **默认关闭**才是这条需求的关键：开关默认打开的话，出口照样天天挂着。
  assert.match(source, /const raw=localStorage\.getItem\(DEV_KEY\);return raw==='1';/);
  assert.doesNotMatch(source, /raw===null\?true:/);
});

test('消息整理走本地数据库，不再有 OCR 版整理页', () => {
  // 旧整理页的整套组件必须彻底消失：它们每读一次都要打开微信会话。
  for (const dead of ['OrganizerHome', 'CenterList', 'CenterDetail', 'MessagesPage', 'AskDock', 'OrganizerProgress']) {
    assert.doesNotMatch(source, new RegExp(`function ${dead}\\(`), `${dead} 是 OCR 版整理页的组件，不该再存在`);
  }
  assert.doesNotMatch(source, /message-center\/organize/, '整理接口换成 /api/home/organize');
  assert.match(source, /api\('home\/organize',\{\}\)/);
  // 首页与整理的数据底座是同一次 DB 读取。
  assert.match(source, /api\('home'\)/);
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

test('从聊天分析使用本地数据库读取，并说明只读不发送', () => {
  assert.doesNotMatch(source, /for\(let seconds=3;seconds>0;seconds--\)/);
  assert.match(source, /后台只读 · 不发消息/);
  // 会话选择走本地 DB（conversations/search_contacts），不再依赖 OCR 读出的可见列表。
  assert.match(source, /api\('conversations'\)/);
  assert.match(source, /api\('search_contacts',\{keyword:kw\}\)/);
  assert.doesNotMatch(source, /phase==='idle'/);
  assert.match(source, /context\\\/profiles\\\/analyze\$/);
});

// 身份不确定提示（OCR 时代：同名会话认不出是哪一个）随 OCR 整理页一起去掉了：
// 现在的会话身份是本地数据库里的原生 username，「认错人」这个失败模式不复存在。

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
