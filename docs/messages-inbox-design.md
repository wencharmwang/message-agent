# 消息收件箱 与 自动回复 的拆分设计

日期：2026-09-15。状态：设计完成，尚未实施。文中「新增」「拟议」均不代表现有能力；现有能力均标注了代码位置。

## 1. 问题陈述

### 1.1 现状：没有「没有自动回复的会话」这个概念

当前扫描是**规则的附属动作**，不是独立能力：

- `agent_worker/service.py` 的 `tick()` 第一行就是
  `rules = [rule for rule in self.store.rules() if rule['enabled'] and rule['status'] != 'blocked']`，
  后面的 `for provider in dict.fromkeys(rule['provider'] for rule in rules)` 只扫**规则里出现过的 provider**。
- 于是推论是硬的：**一条规则都没有 → 一次列表扫描都不会发生**。
- `plugin/host/product.mjs` 的 `projectInbox()` 是 `rules.map(...)`；`plugin/client.js` 的 `InboxList` 把这个投影渲染成标题为「消息」的页面。

所以「消息」页的语义实际是**「已接入自动回复的会话，及其自动任务状态」**。它回答的是"助手替我做得怎么样"，而不是"发生了什么、要不要我管"。

### 1.2 用户真实需要

三种场景现在都没有落点：

| 场景 | 用户想要 | 现在 |
| --- | --- | --- |
| 不想自动回复，但要知道有新消息 | 知道有谁找过我、需不需要处理；**不需要回** | 完全不知道（没规则就不扫描） |
| 离开一段时间后回来 | 快速知道"发生了啥"：谁发了、几条、要不要回 | 只能自己去翻微信 |
| 需要回，但要自己把关 | AI 先拟一版，**我确认了才发** | 没有入口（confirm 恒 409） |

其中第一条是最反直觉也最要紧的：**"记下来处理"和"回复"是两件事**。当前系统只认后者。

### 1.3 结论：拆成两个视角，而不是改一个页面

```text
消息（全部消息）        发生了什么 → 我要不要管（人 → 消息）
自动回复（自动化）      规则在不在跑 → 助手替我做得怎么样（规则 → 机器）
```

两者条目会重叠（一个会话可能既开了自动回复、又有新消息），但**视角不同，状态不互抄**。同一个联系人出现在两个页面不是重复，是两种问法。

## 2. 底层能力边界（决定设计形态，必须如实写清）

设计前先核对了 `messaging-runtime` 的实际能力，结论直接约束了可行方案：

| # | 事实 | 代码位置 | 设计后果 |
| --- | --- | --- | --- |
| B1 | 只能读微信**当前可见**的会话列表；不翻页、不搜索历史 | `README.md`「读取与验证边界」；`Mcp.scan()` 注释 | 「消息」= 可见会话的消息动态，**不是全量历史**。UI 文案不得承诺"所有消息"的全量性 |
| B2 | `list_conversations` 已返回每个会话的 `activity_fingerprint`（= hash(预览文本 + 显示时间)）和 `preview_hash` | `WeChatProvider.ListConversations()` 第 33-39 行 | 能低成本判断**"这个会话变了没有"**，不需要打开会话 |
| B3 | **只有 hash，没有明文预览**——`preview` 不进 DTO | 同上 | "最后一句说了什么"**必须打开会话**才能拿到；列表页不能凭空显示摘要 |
| B4 | **打开会话会清掉微信的未读红点**，且会挤走用户正在看的聊天 | `OcrInputBackend.EnumerateConversations()` 内注释：*"Opening a conversation clears its red unread badge."*；`YieldToUserIfBusy()` | **这是本设计最核心的权衡**：绝不能"为了知道说了啥"把可见会话逐个打开。否则助手会替用户把所有未读抹掉 |
| B5 | `EnumerateConversations()` 对 `UnreadCount` **传的是 `null`**；红点被有意排除出活动指纹 | 同 B4 代码；`MessagingService.GetUnreadConversations()` 会据此把会话归入 `unknown_conversation_ids` | 现成的"未读数"拿不到，也不要假装有。**但见 B7** |
| B6 | `get_unread_conversations` 的语义是"已知未读 + 未知集合"，空的部分结果 ≠ 没有未读 | MCP 工具描述原文 | 不能用它做"没有新消息"的断言，只能做补充信号 |
| B7 | 红点**存在与否**是可检测的——`ConversationListLocator.HasRedBadge(bitmap,...)` 已在用 | `ConversationListLocator.cs` 第 60、116 行 | 有一条低成本的升级路径：暴露 `unread_hint: true/false`，不用开会话、不清红点 |
| B8 | `observe_latest` 是**唯一**会打开会话的操作 | `Mcp.scan()` 注释 | 读取必须收敛到用户显式触发的少数会话上 |
| B9 | `Conversation.type` 对微信恒为 `unknown`；同名会话 `UnreadCount` 返回 null 并标记 `ambiguous` | `WeChatProvider` 第 31-36 行 | 群聊/单聊仍需人工勾选；同名会话必须在 UI 上标注"分不清" |

B4 + B3 合起来给出本设计的**第一原则**：

> **列表只给"变了没有"，正文按需、可控地读。** 能用指纹回答的问题，绝不打开会话。

## 3. 新概念：观察层与规则解耦

### 3.1 观察（Watch）

把"扫描可见会话列表"从规则里**拎出来**，变成独立开关：

| 级别 | 行为 | 是否开会话 | 是否清红点 | 用途 |
| --- | --- | --- | --- | --- |
| `off` | 不扫描 | 否 | 否 | 完全不管 |
| `list`（默认） | 扫描可见列表，记录每个会话的指纹变化与红点提示 | 否 | 否 | **"有新消息"的全部来源** |
| `list+read` | 在上面的基础上，对用户标了「要跟进」的会话后台读正文 | 是（受控/受限） | 是（不可避免） | 主动盯着少数几个会话 |

`list` 级别是纯增量：它做的事就是 `tick()` 里已有的 `self.mcp.scan(provider)`，只是**不再要求"必须有规则"**，并且把结果落库而不是用完即弃。零打扰、零风险、不清红点。

`list+read` 的预读仍然走既有让步机制：微信在前台且目标不是当前打开会话 → 抛 `wechat_in_use` 让路，读完 `RestoreChatAfterRead()` 还原。并且**必须逐个、串行、限额**（如每轮最多 3 个），不能一次扫全场。

### 3.2 会话动态（ConversationActivity）

Host 侧为每个可见会话维护一条观察记录，用来算"新"：

```text
provider, conversation, name_key
watch_level            off | list | list_read
last_seen_fingerprint  上一次已看过时的 activity_fingerprint
last_change_at         指纹最近一次变化的时间
unread_hint            红点提示（B7 落地前为 null）
last_read_at           最近一次真的读过正文的时间
last_observed_at       最近一次出现在可见列表里的时间
```

"有新消息" = `当前指纹 != last_seen_fingerprint`。这与现有规则触发**用的是同一个信号**，已经被证明可用、可用得准（`README.md`：列表发生稳定变化后才进入聊天）。

注意区分三件事，不要把"变了"当成"对方说了话"：
- 指纹变化可能是**我方发出的消息**把预览刷新了（现状 `poll()` 里就专门处理这种情况）。
- 有红点通常意味着**对方**发来未读（B7 之后可用）。
- 两条同时成立时，才比较有把握地说"有新消息"。

### 3.3 三态分离（沿用 architecture §6）

条目上不要把状态揉成一个字符串：

```text
activityState    new | seen | quiet        ← 消息视角（观察层给）
attentionState   none | todo | followup | draft | auto_waiting   ← 待我处理
automationState  off | listening | problem  ← 自动回复视角（规则给，只作参考）
```

`automationState` 在「消息」页只显示成一个小中性标签，**不参与排序、不决定待办**。这是拆分的具体落点：以前"规则状态"冒充了"消息状态"。

## 4. 数据模型

新增 Host 独占的 `data/inbox.db`（`node:sqlite` + WAL，与 `reply-context.db`、`crm.db` 同级同风格）。`reply.db` 仍归 Worker 独占，不动。

```sql
CREATE TABLE conversation_watch (
  provider              TEXT NOT NULL,
  conversation          TEXT NOT NULL,
  workspace_id          TEXT NOT NULL DEFAULT 'local',
  display_name          TEXT NOT NULL,
  name_key              TEXT NOT NULL,
  watch_level           TEXT NOT NULL DEFAULT 'list',
  last_seen_fingerprint TEXT,
  last_change_at        REAL,
  unread_hint           INTEGER,
  last_read_at          REAL,
  last_observed_at      REAL,
  PRIMARY KEY (provider, conversation)
);

-- 受控预读的正文快照。来源永远是 Runtime 的真实快照，不是模型记忆。
CREATE TABLE message_snapshots (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  provider        TEXT NOT NULL,
  conversation    TEXT NOT NULL,
  observed_at     REAL NOT NULL,
  source          TEXT NOT NULL,      -- observe_latest | get_messages
  messages_json   TEXT NOT NULL,
  truncated       INTEGER NOT NULL DEFAULT 0
);

-- 「记下来处理」：不回消息也是正经产出。
CREATE TABLE triage_items (
  id              TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,
  conversation    TEXT NOT NULL,
  kind            TEXT NOT NULL,      -- todo | followup | note
  title           TEXT NOT NULL,
  detail          TEXT,
  evidence        TEXT,               -- 引用哪次快照/哪几条消息
  triage_state    TEXT NOT NULL,      -- open | done
  due_at          REAL,
  created_at      REAL NOT NULL
);
```

写入约束（沿用 reply-context 的既有约定）：事务、字段长度上限、`workspace_id` 从服务端 session 取，不接受浏览器传入。

**不新增草稿表**：AI 拟稿仍走既有的 `Drafts`（`plugin/host/storage.mjs`，`data/drafts.json`），状态机 `awaiting_confirmation → …` 不动。本设计只是给它补上入口（见 §6.3）。

## 5. 后台循环改造

`Worker.tick()` 从"一段"拆成"两段"，**顺序和优先级明确**：

```text
tick()
├─ 1) 观察段（新增，无规则也执行）
│     若 watch_level != off：
│       scan(provider) → 对每个可见会话 upsert conversation_watch
│       指纹变化 → last_change_at = now
│       红点（B7 落地后）→ unread_hint = 1
│     ★ 不调用 observe_latest，不开会话，不清红点
│
├─ 2) 自动回复段（现状，保持不变）
│     仅对有 enabled 规则的会话：activity → poll → enqueue → process
│
└─ 3) 受控预读段（仅 watch_level = list_read 或用户显式点击）
      逐个、串行、每轮上限 N，尊重 YieldToUserIfBusy
      ★ 这是唯一会打开会话的地方
```

关键点是**没有任何一步把"打开会话"当成默认行为**。`list` 级别下，整个系统对微信是纯只读的旁观者，用户的红点、正在看的聊天都不受影响。

Worker 控制 API（`agent_worker/__main__.py`）新增两个只读接口：

```text
GET  /api/observe            → 可见会话观察结果（不触发开会话）
POST /api/observe/read       → 对指定会话显式读取正文（服务端校验会话在可见列表内）
```

两者都沿用现有的 `allowed()` 同源 + Bearer 校验。

## 6. 页面设计

导航不变（`plugin/client.js` 的 `NAV` 保留 5 项），**改的是「消息」的数据来源**：从 `projectInbox(rules)` 改为"观察层 ∪ 规则绑定的会话"。

### 6.1 消息页（改写）

```text
┌──────────┬────────────────────────────────┬────────────────────────────────┐
│ 消息 ●3   │  你离开期间                     │  张伟                           │
│ 今天要做的│  4 个会话有新消息 · 2 个标了跟进 │  单聊 · 最近 12:04 · 有新消息   │
│ 联系人    │  [ 逐个看 ]                     │ ───────────────────────────────│
│ 自动回复  │ ───────────────────────────────│  对方  12:02  报价单发你了，看下 │
│ 回复配置  │  张伟          新 ·1小时前       │  我方  11:58  好的            │
│          │  报价单发你了，看下             │  对方  12:04  今天能定吗？      │
│          │  [未读][自动回复:开]           │ ───────────────────────────────│
│          │ ───────────────────────────────│  这条你要怎么处理？             │
│          │  供应商群      新 ·3小时前       │  ○ 只是看看                     │
│          │  有新消息 · 还没读              │  ● 记下来处理  [记待办][记跟进]  │
│          │  [未读][已记待办]              │  ○ 让 AI 拟一条回复             │
│          │ ───────────────────────────────│     → 生成草稿，你再确认才发送   │
│          │  李静          已看 ·昨天        │ ───────────────────────────────│
│          │  好的，明天见                   │  [查看这条历史 / 问助手]         │
└──────────┴────────────────────────────────┴────────────────────────────────┘
```

**a) 「你离开期间」摘要条（本次设计的主角之一）**

解决"回来时快速知道发生了啥"。只由**客户端已有数据**合成，不额外调模型：

- `4 个会话有新消息` ← 观察层里 `last_change_at > 上次打开这个页面的时间`
- `2 个标了跟进` ← `triage_items.state = open`
- `2 条待办今天到期` ← 复用 `projectToday` 已有的 `todoBuckets.overdue/today`
- `1 条草稿等你确认` ← 复用 `Drafts` 的 `awaiting_confirmation`

一句话 + 一个「逐个看」，点开按"新 → 标了跟进 → 只是变了"排序逐条过。**不做花哨的 AI 日报**——需要总结时用户手上就有「问助手」。

**b) 列表行**

行内文案必须诚实区分两种情况（这是 B3 的直接后果）：

| 情况 | 摘要位显示 |
| --- | --- |
| 有正文快照（读过） | 最后一条消息的明文 |
| 只有指纹（没读过） | `有新消息 · 还没读` —— **不猜、不编、不复用自动回复生成的文案** |

同时给一下一眼可辨的标记：`新`（圆点）、`未读`（红点提示，B7 后可用）、`已看`。右下的状态标签只放**待我处理**类（未读 / 已记待办 / 有草稿待确认）；自动回复只出一个中性小标签 `自动回复：开`。

**c) 详情：三选一，而不是默认"回复"**

这是对用户那句"这些时候是不需要回复消息的"的正面回答。承接一条消息时，强制先选**处理意图**：

| 选项 | 行为 | 是否发送 |
| --- | --- | --- |
| 只是看看 | 标记已看（`last_seen_fingerprint` 推进），不产生任何记录 | 否 |
| 记下来处理 | 走 `triage_items`（记待办 / 记跟进），可关联到期日 | 否 |
| 让 AI 拟一条回复 | 生成**草稿**，落到 `Drafts`，进入「今天要做的 → 等你确认发送」 | **否，必须人工确认** |

"不需要回复"是**一等选项**，不是"什么都不做"。这样"我知道这事、我记下来了、我还没回"是一种稳定状态，而不是一个待办悬空。

**d) 消息正文必须来自 Runtime 快照**

详情里的消息列表只能渲染 `message_snapshots`（`observe_latest` 的真实返回）。**不得**用自动会话的模型上下文、历史拟稿或 `reply_jobs.text` 充当"对方说了什么"——这是 reply-context 规格 §3.3 已经定下的原则，这里沿用：持久 Session 只提供语言连续性，不是事实来源。

### 6.2 自动回复页（基本不动）

保留规则列表、添加、启停、提示词编辑、任务回执（`AutomationPage`）。只做一处语义修正：页面里的"最近处理记录"明确写成**助手替你做的事**，避免与「消息」页混淆。

### 6.3 AI 拟稿 + 人工确认发送

这条链路复用已设计好的部分，只是补入口：

```text
消息详情 → 让 AI 拟一条回复
   → 复用 reply-context 的 Context Orchestrator 构建上下文包
   → 生成草稿 POST /message-agent/api/drafts        （已存在）
   → 进入「今天要做的 → 等你确认发送」               （已存在，projectToday）
   → 人工确认 POST /drafts/{id}/confirm              （★ 现状：恒 409）
   → Runtime 审批 + 幂等发送                         （architecture §7）
```

**必须说清的一处现状**：`plugin/host/product.mjs` 里 confirm 分支当前返回
`409 { error: '发送确认还没有接通消息服务…' }`。也就是说 Phase C 的"生成草稿"今天就能做，但**"确认后真的发出去"要等 architecture §7 的 1.4 接通**。在那之前，草稿只能提示用户去微信手动发——**不允许出现任何"发送成功"的假象**。

## 7. 与现有三条规则的衔接（不要打破的东西）

1. **发送前确认策略**：消息页的拟稿永远不发送；只有用户在「等你确认发送」里点确认才走发送。交互式"直接下令发送"的既有行为不受影响。
2. **让步与还原**：受控预读必须走 `YieldToUserIfBusy()` / `RestoreChatAfterRead()`，不得新增前台占用。发送仍是后台逐字符 `WM_CHAR`。
3. **身份与命名**：`conversation_watch` 存 `name_key`，改名自愈沿用 `recover_identity` 的 NameKey 逻辑；**不按显示名合并会话**（`ambiguous` 要显式标注）。
4. **人话化**：观察层引入的任何新状态码（如 `watch_unavailable`）必须先挂进 `plugin/host/product.mjs` 的 `RUNTIME_MESSAGES` / `humanizeDetail()`，否则会把原始错误码漏给用户。
5. **不写 `needs_user`**：观察层只产生 `activityState`，**不产生"需要你处理"**。待处理只来自用户自己记的待办/跟进和真实草稿——避免系统凭空制造待办。

## 8. 分阶段实施

| 阶段 | 内容 | 是否改 runtime | 依赖 |
| --- | --- | --- | --- |
| **A** | Worker 观察段与规则解耦 + `inbox.db` 的 `conversation_watch` + `/api/observe`；「消息」页改为观察层投影，加「你离开期间」摘要条与 `新/已看` 标记（**只读列表，不开会话**） | 否 | 无 |
| **B** | 受控读取正文：点击/显式触发 `observe_latest` → `message_snapshots`；详情页真实消息流；接上已有的记待办/记跟进 | 否 | A |
| **C** | AI 拟稿入口（复用 reply-context 上下文包）→ 草稿 → 人工确认发送（接通 architecture §7 的 1.4） | 否 | B、§7 的 Runtime 审批通道 |
| **D** | 驱动暴露红点布尔 → `list_conversations` 的 `metadata.unread_hint`，让"未读"从推断升级为实测 | **是** | A（可并行，独立价值） |

A 阶段单独就有完整价值：**"没有自动回复，也能知道谁找过我"** 这件事，只靠列表指纹就能成立，且对微信零打扰。

## 9. 验收

- 关掉所有自动回复规则后，新消息**仍**能被观察到并出现在「消息」页（当前行为是彻底无感知）。
- `watch_level = list` 下，整个观察循环**不打开任何会话**、不清任何未读红点（可用"红点是否保留"直接验证）。
- 同一会话同时出现在「消息」与「自动回复」两页时，状态互不冒充：`automationState` 不参与「消息」页排序与待办判定。
- 未读过正文的会话，UI 显示"有新消息 · 还没读"，**不出现任何编造的最后一句**。
- 一条消息可以被处理成"只是看看 / 记待办 / 记跟进 / 拟草稿"四种结果，其中前三种**不发出任何消息**。
- 草稿未接通发送前，任何路径都返回"需在消息服务中审批"，不出现假"发送成功"。
- 现有回归保持：规则启停/revision、会话互斥、`uncertain` 不重发、`agent_worker/decision.py` wire contract、E2E 全部走 simulation provider（真实微信发送数 = 0）。
