# Message Agent 产品架构与界面改造设计

日期：2026-09-09。状态：设计完成，尚未实施。本文以本机三个项目的代码和《Deepseek Harness本地Agent原理》讨论为依据；“目标”“新增”“拟议”均不代表现有能力。

## 1. 本轮范围与产品目标

按“当前只需要做好架构设计，分步实现”的要求，本轮交付设计和实施顺序。下一阶段优先实现消息工作台；安装包、桌面外壳和自动升级后置。轻量 CRM 是后续业务模块，不在第一阶段用演示数据伪装成已完成能力。

用户最终安装、启动和更新一个 Message Agent 产品。DeepSeek Harness 是内置的版本化引擎；Messaging Runtime 保持独立公共项目和 MCP 能力，也可以作为产品安装包内的配套组件。用户不需要下载三个源码目录或配置开发机绝对路径。

主要使用者按非技术用户设计：他们更熟悉手机和基础办公软件，不需要理解 Agent、Session、MCP、工作区或工具调用。日常界面只呈现“消息、和助手聊聊、自动回复、设置”等任务语言；引擎、模型与诊断收进高级设置。所有重要操作使用明确动词、即时结果和可恢复错误，避免要求用户复制命令、识别内部状态或理解开发者术语。

默认体验围绕“查看消息 → 理解上下文 → 准备回复 → 按授权发送 → 查看结果”。Agent 对话是操作业务数据的入口，保留原生 Harness 会话、流式输出和恢复能力。

## 2. 现状核验

| 本机文件 | 已有实现 | 对改造的影响 |
| --- | --- | --- |
| `plugin/client.js` | 设置页插件、规则管理、每 3 秒查询状态、最近 15 条任务展示 | 可迁移为自动化页面；尚无 Inbox、客户、待办页面 |
| `plugin/index.mjs` | 私有任务入口、同源 worker 代理、自动任务挂载、三个跨目录源码 import | 保留适配行为；拆分业务 API 与 Harness 适配；源码 import 阻碍打包 |
| `plugin/conversation-sessions.mjs` | 持久化会话绑定和同会话调度互斥 | Inbox 必须复用绑定，不按标题创建新会话 |
| `agent_worker/database.py` | `reply_rules`、`reply_jobs`、`reply_activity`，数据库版本 1 | 规则和任务是真实状态来源；尚无 CRM/Todo 数据模型 |
| `agent_worker/__main__.py` | status/conversations/rules/enable/pause/edit 控制 API | 未提供发送确认、草稿编辑或 Inbox 聚合接口 |
| `agent_worker/service.py` | 扫描可见会话、生成决定、规则复核、发送状态查询 | UI 不能将生成完成解释为发送成功 |
| `presets/message-agent/agent.cordis.yml` | 交互提示词默认只读；挂载消息 MCP，无编码工具组合 | README 中“完整工具集”描述已与该预设不一致；实现时同步文案 |
| `launch.py` | 外部 Node + tsx 启动 Harness 源码，管理 Harness/worker | 生产需要已构建入口及内置运行依赖 |
| `prepare.py`、`install.ps1` | 固定开发机目录；Python 来自 Runtime 目录 | 需要路径解析和部署清单，不能原样用于交付 |
| Runtime `docs/send-authorization.md`、Host `Program.cs` | Runtime 桌面/CLI 审批；批准后还需原请求继续发送 | Harness 审批卡片不能自动替代 Runtime 审批 |

第一版消息可见性沿用现有边界：只监听微信当前可见会话列表，不承诺全量历史、准确未读数量或原生消息时间。列表外规则呈现“等待会话出现在微信列表”，不显示“没有新消息”。

## 3. 职责与进程

```text
浏览器：Message Agent 工作台
  ├─ 消息 / 自动化 / 设置（第一阶段）
  ├─ 待办 / 客户（后续）
  └─ Harness 原生对话、流式输出、会话恢复
             │ 同源、已认证的业务 API
Message Agent Host（运行于 Harness 插件宿主）
  ├─ 界面插件、业务投影、人工发送控制
  ├─ HarnessAdapter：会话选择、创建、恢复、事件关联
  └─ RuntimeAdapter：消息读取、授权衔接、回执查询
             │ 私有控制接口
Message Worker（现有 Python 进程）
  └─ 监听、规则、自动任务、持久化任务状态
             │ MCP / 经授权的本地管理操作
Messaging Runtime（独立服务，公共能力）
  └─ Provider、消息快照、发送策略、幂等、审计、微信驱动
```

Harness 的 Agent Loop、模型适配、上下文、Session 和 sandbox 不做业务改写。业务代码归 Message Agent；消息协议与设备操作归 Runtime。不能由 UI、Worker 或 Harness 插件直接操作微信窗口，也不能从上层直接改 Runtime 数据库。

不在本阶段把 Python Worker 重写为 Node 服务。Host 对浏览器提供统一入口，Worker 继续独占自动回复状态写入。新增人工草稿由 Host 的独立草稿存储管理，避免两个进程共同写同一套业务状态机。

现有自动会话和交互会话能力不同。Inbox 关联并可查看原自动任务历史；“询问助手/拟回复”使用同一联系人下独立、持久化的交互会话绑定。禁止把普通用户输入直接送进依赖每轮 `submit_reply_decision` 注册的 `message-auto` 会话。自动会话沿用旧 key；交互会话增加 purpose 维度，不覆盖旧绑定。人工发送时还需协调该联系人的在途自动任务。

## 4. 界面结构

```text
┌────────────┬──────────────────┬───────────────────────────┐
│ Message    │ 消息             │ 当前联系人 / 群组         │
│ Agent      │ 搜索、筛选       │ 连接状态 · 监听状态        │
│            │                  │                           │
│ 消息       │ 联系人 A         │ 消息上下文 / 最近处理记录  │
│ 自动化     │ 等待你处理       │                           │
│            │ 联系人 B         │ Agent 对话                │
│            │ 已回复           │ 业务动作卡片              │
│            │                  │ 回复草稿                  │
│ 设置       │ 最近更新时间     │ [发送] [修改] [取消]       │
│ 连接状态   │                  │ 输入你的要求…             │
└────────────┴──────────────────┴───────────────────────────┘
```

以上为结构示意，联系人是说明文字，不是初始化数据。无已接入会话时展示空状态和“读取微信会话”；读取失败、尚未配置、尚未同步分别显示，不能统一为空列表。

第一阶段主导航为消息、自动化、设置；待办、客户在各自数据与操作可用时加入。最终导航为消息、客户、待办、自动化，底部设置。窄窗口依次展示列表与详情，可返回列表；保留键盘导航、可见焦点、带文字的状态标签、中文完整草稿及长文本换行。

### 消息工作台

列表按照最近业务活动排序，支持全部、待处理、处理中、异常筛选。“待处理”来自真实待确认草稿或 `needs_user` 任务，不能把工具等待态直接当作客户待办。列表条目至少包括身份、标题、摘要、业务状态、更新时间和覆盖范围；状态时间与微信消息时间分开。

选中条目后读取会话绑定，展示来源消息、自动处理记录和交互对话。切换、刷新与重启后能回到相同联系人，不按联系人名称匹配身份。未有会话绑定时显示上下文，只有用户开始交互才创建交互会话。

### 业务动作卡片

使用已存在的 `tool.call.toolview` keyed slot，不另建一套通用工具注册基础设施。注册键以实际 MCP wire toolName 为准，在适配测试中固定名称映射，不能假设讨论中的 `message.read_messages` 就是现有工具名。

| 工具/结果语义 | 用户呈现 | 判定依据 |
| --- | --- | --- |
| 列举会话 | 正在读取微信会话 / 已读取 N 个会话 | 实际结果和覆盖信息 |
| 同步、读取、搜索 | 正在读取某会话 / 找到 N 条相关消息 | 请求参数和真实结果；无可靠时间不补时间 |
| `submit_reply_decision` | 回复已拟好 / 本次无需回复 / 需要你处理 | 结构化决定；不显示“已发送” |
| 发送调用成功但仍待审批 | 等待确认 | Runtime 状态，不使用工具成功布尔值 |
| `get_send_status` | 已发送 / 发送结果待核实 | Runtime 回执 |
| 未识别工具或解析失败 | 动作名称与状态，详情可展开 | 保留错误和原始事实，不编造业务摘要 |

卡片是已记录事件与结果的投影，不额外调用模型生成状态。默认收起参数、JSON 和调试堆栈；异常保留可理解说明，开发模式提供详情。历史回放和实时流采用同一呈现函数。

### 自动化与设置

自动化迁移已有规则列表、添加、启停、提示词编辑和任务历史。编辑规则后保持现有暂停及 revision 变更行为；启用后建立基线。设置保留模型、消息连接及诊断；workspace、通用预设、工具调试等放入高级开发模式。隐藏 UI 不等于撤销工具权限，能力限制仍在服务端预设和 Runtime 执行处落实。

## 5. 扩展接入点与代码组织

已核验 Harness `packages/client` 下的以下接口：

| 接入点 | 用途 | 实施约束 |
| --- | --- | --- |
| `ui-layout` 的 root、sidebar、conversation、details、shell.overlay | 保留布局、原生会话与侧面详情 | 原生 SessionProvider 必须保留 |
| `ui-sidebar` 的 `sidebar.workspaces`、品牌、设置 slot | 产品导航与消息列表 | 若需接管整个 sidebar，应通过 profile 替换其展示插件，不用 CSS 隐藏 DOM |
| `ui-tool` 的 `tool.call.toolview` | 消息工具卡片 | 根据持久化 ToolCallBlock 渲染 |
| `ui-approval` 的 `conversation.approval.detail` | 工具权限申请的业务详情 | 仅有 callId；不能据此认定支持修改待执行参数 |
| `settings.section` | 保留设置扩展入口 | 自动化主入口和设置复用组件 |

产品页面切换与原生 conversation 的包裹方式须在第一步做真实 profile 装配验证。现有 slot 不足时，只增加一个通用页面承载扩展点，并保存小补丁及回归测试；不在多个 Harness 页面中散落消息业务判断。

建议逐步整理为以下目录，不在设计阶段机械搬迁现有代码：

```text
message-agent/
  plugin/
    index.mjs                  # 薄注册入口
    host/                      # 业务 API、Inbox 投影、人工草稿服务
    adapters/                  # HarnessAdapter、RuntimeAdapter
    client/                    # React/TypeScript 源码、样式、文案
      inbox/ automation/ messages/ settings/
    dist/                      # 客户端构建产物；清单指向产物
  agent_worker/                # 保留监听和自动回复实现
  presets/                    # 交互、自动任务的独立能力组合
  profiles/                   # 产品 Web profile / patch
  vendor/deepseek-harness/     # 固定版本引擎源代码，后续内置
  build/                      # 构建与交付目录装配脚本
  docs/                       # 本设计、分步计划、打包方案
```

前端从单个 `React.createElement` 文件转为可构建模块；产物仍遵循现有客户端 ModuleLoader 协议。复用 Harness React/客户端服务，避免打入第二份 React。接入点、注入依赖、locale、热卸载 disposer 与真实 profile 一并验证。

## 6. 拟议业务 API 与数据来源

以下是待实现接口，不是现有 endpoint。保留 `/message-agent/api/` 同源前缀，浏览器不直接访问 Worker 或 Runtime，也不接触其 bearer token。

| 接口 | 职责 |
| --- | --- |
| `GET inbox?cursor=&limit=&filter=` | 对规则、任务、已有消息快照和会话绑定作分页投影 |
| `GET conversations/{key}` | 返回身份、来源上下文、覆盖信息、自动/交互 sessionId |
| `POST conversations/{key}/session` | 幂等选择或创建交互会话，不发送微信消息 |
| `GET drafts/{id}` | 读取权威草稿版本与发送状态 |
| `POST drafts` | 新建仅拟稿的记录，固定目标和来源 |
| `POST drafts/{id}/revise` | 带 expectedRevision 修改草稿，撤销旧确认资格 |
| `POST drafts/{id}/confirm` | 真实用户确认完整草稿；校验版本后进入发送流程 |
| `POST drafts/{id}/cancel` | 取消未发送草稿；发送中不能宣称撤回 |

现有规则 API 先继续复用。Inbox 第一版按可用的本地数据聚合，不让每次 3 秒刷新都触发微信历史同步；显式读取才调用 Runtime。查询加 limit、稳定 cursor、updatedAt 和 stale 状态；轮询只对可见页面执行，切换/卸载时取消，错误退避，避免慢响应覆盖新选中会话。后续需要时再补 SSE。

会话身份为 Runtime 实例 + provider + conversation ID；provider 是否已编码账号身份需在多账号实现时核验，不按显示名合并。旧绑定保留，不臆造缺失的账号 ID。视图分别输出 processingState、deliveryState、attentionReason，不用一个字符串混合生成、发送和连接状态。

Host 新增人工草稿库（例如 `drafts.db`）：draftId、revision、目标身份、正文、来源引用、requestId、状态、创建/到期时间、Runtime 回执。采用事务式版本比较；确认只处理当前版本。自动任务继续留在 `reply.db`，两者通过 requestId 对照 Runtime 回执，不复制一份“已发送事实”。

## 7. 发送确认闭环

发送按钮需明确显示平台、收件人/群组、完整正文、草稿状态，支持修改和取消。群组与同名联系人必须区分。第一阶段不增加“今天都允许”等新授权模式，已有自动化授权继续按规则执行。

```text
拟稿 → 待确认 → 用户确认当前版本 → 提交 Runtime → 发送中 → 已发送
            ├─ 修改 → 新版本待确认
            ├─ 取消/过期 → 终止
            └─ 冲突/会话变化 → 重新检查
发送结果无法确认 → 待核实（只查状态，不自动重发）
```

实现分两步：先完成只展示真实状态的草稿卡，再接通可执行确认。未接通时显示“需在消息服务中审批”，不能提供假“发送成功”。原生 Harness 审批只决定工具能否执行，Runtime 决定消息能否发出。

接通方案优先在 Host 的 RuntimeAdapter 中调用现有受信任本地管理入口：使用固定 executable 和参数数组执行 `--review-request`、`--approve-request`/`--reject-request`，限定本产品 agent 与 requestId；批准后由 Host 继续提交相同 requestId 和不可变 payload。实现前验证 CLI 对外部运行实例的状态一致性、返回格式及进程退出行为；命令参数由服务端权威草稿构造，不接受浏览器任意命令或路径。若 CLI 不适合，则 Runtime 新增独立受信任管理通道，保持 MCP 公共工具不提供“自我批准”能力。

受信任确认来自已认证的浏览器用户操作，经 CSRF/Origin 校验、一次性确认标识、draftId/revision/目标/正文核验。管理凭据不进入模型上下文、MCP 工具参数或客户端包。不得用修改 `origin=user_request` 充当完整审批集成，也不得全局放宽公共 Runtime 的发送策略。现有 Web 前缀路由能否继承 Harness 登录认证须实测，Host/Origin 检查本身不代表已登录。

编辑过的 payload 使用新的 Runtime requestId；若旧草稿已经提交 pending，先拒绝/作废旧请求并确认其不可再发送，再建立新请求。若旧请求已进入 sending、sent 或 uncertain，拒绝草稿改发操作并展示实际状态。取消也必须协调 Runtime pending 请求，不能只隐藏 UI 卡片。

人工确认与自动回复共用联系人级发送协调：确认前检查新消息、规则版本及同一会话自动任务。暂停/取消尚未发送的旧自动任务；已经 sending/uncertain 时拒绝并提示核实。最终发送授权、幂等和设备串行由 Runtime 执行，不能只依赖前端按钮置灰。多客户端同时操作同一 provider 的冲突需要 Runtime 层测试。

重启后不自动执行尚未确认的草稿。发送中断只查询 requestId；明确 sent 才显示已发送。双击和 HTTP 重试返回同一请求状态；确认 API 以事务认领执行权。`get_send_status` 是查询，不能当作执行发送。

## 8. 待办与本地 CRM 的后续接入

待办第一步可从需要用户处理的任务和待确认草稿投影；承诺、报价、回访等业务 Todo 后续独立持久化，不复用 Harness 的推理计划 Todo。字段包括标题、关联会话/客户、来源证据、到期时间、状态、创建方式；推断的日期和承诺先标为候选，用户可修正。

CRM 归 Message Agent 的业务模块，不放进通用消息 Runtime。第一版 SQLite 存联系人、客户、跟进、待办和消息来源引用；消息原文仍由 Runtime 管理，必要摘要保留来源与生成时间。联系人不默认都是客户。模型提取不得覆盖用户已确认资料，摘要、需求和预算必须区分已知事实与推断。

本地 CRM 和未来外部 CRM 通过相同业务操作适配（查客户、更新资料、建跟进、列待办）；有真实外部消费者时再实现连接器，当前不建设通用 CRM 平台。界面加入“客户”时提供摘要、阶段、下一步、待办、最近沟通及基于该客户的 Ask Agent，不扩展财务、订单、复杂权限。

“本地”指消息与业务数据的存储位置。调用云模型时相关上下文仍可能发往模型服务，设置和产品说明必须如实表达，不能称数据完全不出本机。

## 9. 验收与后续入口

引擎内置、公共 Runtime 复用、密钥保管、明文副本策略、模型配置与发布迁移见 [打包与交付方案](packaging-plan.md)。本轮没有运行安装器、重启服务、变更规则或向真实联系人发送消息。
