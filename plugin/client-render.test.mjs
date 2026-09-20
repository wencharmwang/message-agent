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
  assert.match(source, /const NAV_ICON=\{home:'messages',todos:'today',automation:'automation',context:'settings'\}/);
  // 消息 = 一个消息气泡；待办 = 方框里一个勾。
  assert.match(source, /messages:'M4 5\.5h12a1\.5 1\.5 0 0 1 1\.5 1\.5v6/);
  assert.match(source, /today:'M4\.2 4\.5h11\.6[^']*Zm2\.5 5\.7 1\.5 1\.5 2\.9-2\.9'/);
  // 设置 = 通用齿轮。
  assert.match(source, /gear:'M10 3\.2/);
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

test('消息页打开就停在最新一条，往上翻看历史', () => {
  const view = source.slice(source.indexOf('function ConversationView('), source.indexOf('function MessageBubble('));
  // 首次拿到正文后把滚动条钉到底：和聊天软件一样，进来先看最新的。
  assert.match(view, /node\.scrollTop=node\.scrollHeight/);
  assert.match(view, /pinnedRef/);
  assert.match(view, /ref:boxRef/);
  // 一次读满一窗（服务端上限 300），窗口用满时在顶部说明一句。
  assert.match(source, /const CHAT_LIMIT=300/);
  assert.match(view, /'&limit='\+CHAT_LIMIT/);
  assert.match(view, /只显示了最近 '\+CHAT_LIMIT\+' 条/);
});

test('往上翻历史时浮出「回到最新」的圆按钮', () => {
  const view = source.slice(source.indexOf('function ConversationView('), source.indexOf('function MessageBubble('));
  assert.match(view, /onScroll/);
  // 只在跨越阈值时才 setState —— 每次滚动都 setState 会把 300 条消息重渲一遍。
  assert.match(view, /if\(near!==nearBottomRef\.current\)/);
  assert.match(view, /className:'ma-jump'/);
  assert.match(view, /name:'down'/);
  // 圆底：它悬在气泡上是浮层，方形按钮在流动内容里读不出来。
  assert.match(source, /\[data-ma\] \.ma-jump\{position:absolute;[\s\S]{0,200}?border-radius:50%/);
  assert.match(view, /scrollTo\(\{top:node\.scrollHeight,behavior:'smooth'\}\)/);
});

test('消息时间精确到分钟，跨天有日期分隔', () => {
  assert.match(source, /function messageTime\(value\)/);
  assert.match(source, /if\(sameDay\(date,now\)\)return clock;/);
  assert.match(source, /'昨天 '\+clock/);
  assert.match(source, /date\.getFullYear\(\)!==now\.getFullYear\(\)/, '跨年要带年份');
  // 气泡用绝对时间（分钟级），不是"3小时前"。
  const bubble = source.slice(source.indexOf('function MessageBubble('), source.indexOf('function ConversationTodos('));
  assert.match(bubble, /messageTime\(message\.at\)/);
  assert.doesNotMatch(bubble, /relativeTime/);
  // 有了日期分隔，气泡上才能只写时分。
  assert.match(source, /function MessageDay\(\{message,previous\}\)/);
  assert.match(source, /h\(MessageDay,\{message,previous:messages\[index-1\]\}\)/);
});

test('未完成的待办可以双击改文案、改到期时间', () => {
  const row = source.slice(source.indexOf('function TodoRow('), source.indexOf('function TodayPage('));
  // 双击标题进入编辑；做完的不开放（已经是记录，改它没意义）。
  assert.match(row, /onDoubleClick:done\?undefined:startEdit/);
  // 编辑态：文案 + 到期时间（**要能定到几点**）+ 回车保存 / Esc 取消。
  assert.match(row, /type:'datetime-local'/);
  assert.match(row, /'aria-label':'到期时间'/);
  assert.match(row, /toDateTimeInput\(new Date\(todo\.dueAt\*1000\)\)/);
  assert.match(row, /fromDateTimeInput\(dueDraft\)\.toISOString\(\)/);
  // Esc / 回车都要**拦住冒泡**：全局那个 Esc 监听会顺手收起整个面板
  // （实测："修改时按 Esc 直接退出了消息助手"）。
  assert.match(row, /if\(event\.key==='Escape'\)\{event\.stopPropagation\(\);setEditing\(false\);\}/);
  assert.match(row, /if\(event\.key==='Enter'\)\{event\.stopPropagation\(\);save\(\);\}/);
  // 空标题不提交（服务端也会拒）。
  assert.match(row, /if\(!title\|\|busy\)return;/);
  // 还有一个不依赖双击的入口：鼠标党不一定想得到要双击。
  assert.match(row, /h\('button',\{onClick:startEdit/);
  // 落库走 POST /api/todos/<id>（服务端按字段合并，只传这两个字段）。
  const page = source.slice(source.indexOf('function TodayPage('), source.indexOf('function CustomersPage('));
  assert.match(page, /action==='edit'\)await api\('todos\/'\+id,\{title:patch\.title,dueAt:patch\.dueAt\}\)/);
  const todos = source.slice(source.indexOf('function ConversationTodos('), source.indexOf('function CrmSections('));
  assert.match(todos, /action==='edit'\)return run\(\(\)=>api\('todos\/'\+todo\.id,\{title:patch\.title,dueAt:patch\.dueAt\}\)\)/);
});

test('到期时间能定到几点', () => {
  // 只有日期的话服务端只能按"当天 9 点"兜底，而"几点做/几点提醒"正是这类任务的关键信息。
  assert.match(source, /function toDateTimeInput\(date\)\{return toDateInput\(date\)\+'T'\+pad2\(date\.getHours\(\)\)\+':'\+pad2\(date\.getMinutes\(\)\);\}/);
  // 解析不能自己拼 Z：不带时区的"日期+时间"串，规范规定按本地时间解释（纯日期串才是 UTC）。
  assert.match(source, /function fromDateTimeInput\(value\)\{return value\?new Date\(value\):null;\}/);
  // 两处到期控件都换成能选小时的（新建表单与待办编辑）。
  const composer = source.slice(source.indexOf('function Composer('), source.indexOf('function ContextRow('));
  assert.match(composer, /type:'datetime-local'/);
  assert.match(composer, /toDateTimeInput\(dayStart\(0\)\)/, '「今天」要连带时间一起填');
  assert.match(composer, /fromDateTimeInput\(due\)\.toISOString\(\)/);
  const row = source.slice(source.indexOf('function TodoRow('), source.indexOf('function TodayPage('));
  assert.match(row, /type:'datetime-local'/);
  // 列表上的到期提示也要带几点，否则刚填的小时等于白填。
  const due = source.slice(source.indexOf('function dueInfo('), source.indexOf('function firstLine('));
  assert.match(due, /pad2\(due\.getHours\(\)\)\+':'\+pad2\(due\.getMinutes\(\)\)/);
  assert.match(due, /'今天 '\+clock/);
  // 原生控件要留够宽度，不然时间部分被压成省略号。
  assert.match(source, /const dateField=\{\.\.\.field,minHeight:44,minWidth:18\d/);
});

test('自动回复页可以拖动重排、也能一键置顶', () => {
  const page = source.slice(source.indexOf('function AutomationPage('), source.indexOf('function ProfileForm('));
  // 拖动中只记状态，松手才落库（列表每 5 秒轮询，中途落库会写成中间态）。
  assert.match(page, /draggable:true/);
  assert.match(page, /onDragStart:/);
  assert.match(page, /onDrop:event=>\{event\.preventDefault\(\);/);
  assert.match(page, /function dropOn\(index\)/);
  assert.match(page, /api\('rules\/order',\{ids:list\.map\(rule=>rule\.id\)\}\)/);
  // 置顶：监听一多，拖到第一位要精准，一键置顶只要一下。
  assert.match(page, /function moveToTop\(id\)/);
  assert.match(page, /onTop:\(\)=>moveToTop\(rule\.id\)/);
  assert.match(source, /onTop&&h\('button',\{disabled:busy,onClick:onTop/);
  // 卡片外那层 wrapper 要能被 grid 拉满，否则同排卡片高矮不齐。
  assert.match(page, /alignItems:'stretch'/);
});

test('拖动时卡片要有实底，不能靠淡化表示"正在拖"', () => {
  const page = source.slice(source.indexOf('function AutomationPage('), source.indexOf('function ProfileForm('));
  // 卡片是玻璃底（半透明），一淡化文字就糊在页面上 —— 用户实测「拖动时卡片没有背景，
  // 看不清文字」。所以被拖的那张垫实底、不淡化。
  assert.doesNotMatch(page, /opacity:\.4/, '不要用淡化表示被拖动');
  assert.match(page, /dragIndex===index\?\{backgroundColor:'var\(--ma-surface\)'/);
  // 落点用实线 + 品牌色，和被拖的虚线分开。
  assert.match(page, /outline:'2px dashed '\+C\.brand/);
  assert.match(page, /outline:'2px solid '\+C\.brand/);
  // 跟着光标走的影像：只给最外层涂色不够（卡片自己的半透明底在它上面，照样透光），
  // 要靠 .ma-drag-ghost 那两条规则**连子元素一起**压成不透明。
  assert.match(page, /function dragGhost\(event\)/);
  assert.match(page, /ghost\.className='ma-drag-ghost'/);
  assert.match(page, /setDragImage\(ghost,24,20\)/);
  assert.match(source, /\.ma-drag-ghost\{background-color:var\(--ma-surface\)!important/);
  assert.match(source, /\.ma-drag-ghost \*\{background-color:transparent!important/);
  // 影像元素要活到松手：Chrome 要等这一帧才真的取影像，提前移除就退回默认快照。
  assert.match(page, /ghostRef\.current=ghost/);
  assert.match(page, /function clearGhost\(\)/);
  assert.match(page, /onDragEnd:\(\)=>\{clearGhost\(\)/);
  assert.doesNotMatch(page, /setTimeout\(\(\)=>ghost\.remove\(\),0\)/);
});

test('在输入框里按 Esc 不会把整个消息助手关掉', () => {
  // 全局 Esc 监听在 document 上，输入框里的 Esc 会冒泡上去把面板收起来
  // （实测："修改时按 Esc 直接退出了消息助手"）。
  const key = source.slice(source.indexOf("const key=event=>{"), source.indexOf("document.addEventListener('keydown',key)"));
  assert.match(key, /event\.key!=='Escape'/);
  assert.match(key, /target\.tagName==='INPUT'\|\|target\.tagName==='TEXTAREA'\|\|target\.tagName==='SELECT'\|\|target\.isContentEditable/);
});

test('两个任务各配各的模型（自动回复 / 整理消息），都支持本地模型', () => {
  const picker = source.slice(source.indexOf('function TaskModelPicker('), source.indexOf('function SettingsPage('));
  const settings = source.slice(source.indexOf('function SettingsPage('), source.indexOf('function parseBlock('));
  // 下拉：按提供方分组，选中值用 provider::model 编码（不同提供方可能有同名模型）。
  assert.match(picker, /entry\.provider\+'::'\+entry\.id/);
  assert.match(picker, /h\('optgroup',\{key:group\.provider,label:group\.name\}/);
  // 当前组合不在目录里时也要显示，不然下拉会跳回第一项，用户以为设置被改了。
  assert.match(picker, /（当前）/);
  // 两个任务两行，各存各的字段 —— 只存一个总开关等于逼用户二选一。
  assert.match(settings, /title:'自动回复模型'/);
  assert.match(settings, /title:'整理消息模型'/);
  assert.match(settings, /api\('settings',task==='auto'\?\{auto_provider:provider,auto_model:model\}/);
  assert.match(settings, /:\{organize_provider:provider,organize_model:model\}\)/);
  assert.match(settings, /organize_provider/);
  assert.match(settings, /organize_model/);
});

test('已完成里每一行都有删除入口，两类回执也不例外', () => {
  const page = source.slice(source.indexOf('function TodayPage('), source.indexOf('function CustomersPage('));
  // 待办那条（真删）与回执那条（从清单移除）都要挂在第二行右侧。
  const buttons = [...page.matchAll(/className:'ma-iconbtn'/g)].length;
  assert.ok(buttons >= 2, '已完成里的待办和回执都该有删除按钮，现在只有 ' + buttons + ' 个');
  assert.match(page, /api\('receipts\/dismiss',\{id:entry\.id\}\)/, '回执的删除要落库');
  assert.match(page, /function dismissReceipt\(entry\)/);
  assert.match(page, /function deleteDoneTodo\(entry\)/);
  // 回执行的第二行同样要拆成两栏，否则长文案会把删除挤掉。
  assert.match(page, /justifyContent:'space-between',gap:12[\s\S]{0,400}?ma-iconbtn/);
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
