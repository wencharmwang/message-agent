# Message Agent 自动回复上下文与知识系统

> 面向实现 Agent 的权威规格  
> 日期：2026-09-11  
> 状态：待实施  
> 设计方法：仅依据原始产品需求与当前代码行为独立推导

## 1. 需求复核与结论

原始需求不是简单的“给模型建一个知识库”，而是让自动回复在客服、销售跟进和日常沟通中同时做到：

1. 像用户本人说话。
2. 理解正在和谁沟通，以及事情进行到哪里。
3. 对产品、政策、订单等问题提供可靠答案。
4. 不编造金额、状态、承诺或公司政策。
5. 知道什么时候可以自动回复，什么时候必须让用户决定。
6. 能从用户的改稿和真实发送记录中持续变好。
7. 面向不同最终用户交付时，数据、权限和风格互不串用。

因此，正确的产品边界不是一个单体“知识库”，而是一套 **Reply Context System（回复上下文系统）**。它包含五个职责不同的子系统：

```text
静态知识        产品说明、FAQ、已发布政策
实时数据        订单状态、库存、物流、报价有效性
关系记忆        联系人、阶段、约定、未决事项
表达配置        用户在不同场景下的说话方式和真实范例
决策治理        自动回复权限、风险分级、证据校验、审计
```

把这五类内容都放进向量库会产生严重问题：实时状态过期、风格与事实混淆、政策没有发布状态、联系人记忆串用、检索结果被误当作发送授权。

## 2. 当前实现的直接问题

根据当前代码：

- `agent_worker/service.py` 在触发时已经取得消息快照并写入 `reply_jobs.context`。
- `plugin/reply-policy.mjs` 的 `conversationTurnContext()` 在复用会话时只保留最新 incoming，丢弃本轮可用的真实消息快照。
- `plugin/index.mjs` 每轮主要注入 `REPLY_POLICY + rule.prompt + incoming + recent_deliveries`。
- 自动会话是持久 Session，模型会保留历史模型上下文，但该上下文不等于当前消息系统中的权威事实。
- `reply_rules.prompt` 是一个最长 4000 字的自由文本，承担了风格、事实、联系人规则和场景规则等过多职责。
- 当前 `submit_reply_decision` 只返回动作、正文和理由，没有证据引用或风险标签。
- `agent_worker/decision.py` 严格限制返回字段，因此 Host 内部新增审计字段时不能直接透传给 Worker。
- CRM 已经拥有稳定的 conversation key、联系人阶段、下一步、备注、跟进记录和待办，不应再复制一份联系人主数据。

首要修复不是加入 embedding，而是让每轮决策重新获得权威、有限、可解释的上下文。

## 3. 设计原则

### 3.1 知识不等于授权

资料中写着“可以退款”不代表当前自动回复可以替用户批准退款。知识回答“事实是什么”，决策策略回答“AI 能否代表用户采取这个动作”。

### 3.2 实时数据不进入长期知识

订单状态、库存、物流轨迹、当前报价和账户余额必须从业务系统实时查询，并携带查询时间和有效期。它们不能被永久写成普通知识条目。

### 3.3 当前消息快照优先于模型会话记忆

持久 Session 只提供语言连续性，不能成为事实真相源。每轮都应重新注入最近真实消息、最近真实发送结果和明确的未决事项。

### 3.4 一个用户可以有多套口吻

同一个人在朋友聊天、客户服务、销售跟进、群聊和投诉处理中不会使用完全相同的口吻。系统必须支持多个 Communication Profile，而不是全局单一 Voice。

### 3.5 所有可自动发送的事实必须有来源

每个事实、政策、订单状态和承诺都必须能追溯到来源、版本或实时查询结果。无法提供依据时，不自动生成具体断言。

### 3.6 AI 学习结果默认不生效

模型从历史或改稿中抽取的风格、联系人结论和业务规则先进入候选区。用户确认或受信管理员发布后才进入生产上下文。

### 3.7 从一开始保留租户边界

当前部署是本地单用户，也应在所有新表中加入 `workspace_id`，默认值可为 `local`。未来交付给不同客户时，不需要重写数据模型才能实现隔离。

## 4. 总体架构

```text
                       ┌────────────────────┐
收到消息 ─────────────>│ Context Orchestrator│
                       └─────────┬──────────┘
                                 │
          ┌──────────────────────┼──────────────────────┐
          │                      │                      │
          v                      v                      v
  Static Knowledge       Relationship Memory     Live Resolvers
  产品/FAQ/政策           CRM/约定/待办            订单/库存/物流
          │                      │                      │
          └──────────────────────┼──────────────────────┘
                                 v
                         Canonical Context Pack
                                 │
                                 v
                         Reply Decision Model
                                 │
                                 v
                     Evidence & Risk Gate
                      │                    │
                      v                    v
                  可自动回复            needs_user
                      │
                      v
             现有 Worker/Runtime 发送链路
```

新增系统只参与 Host 侧“生成什么回复”和“该回复是否满足自动发送条件”。最终发送仍由现有 Worker 和 Runtime 控制。

## 5. 六类上下文

### 5.1 Communication Profile：表达配置

表达配置不是一段“专业、热情”的说明，而是一组可验证规则和真实样本。

每个 profile 包含：

- 名称：默认、朋友、客户服务、销售、群聊等。
- 适用条件：会话、联系人阶段、联系人标签、群聊/私聊。
- 称呼规则。
- 常用词、自称、句长、句数、标点和 emoji 习惯。
- 禁用表达。
- `hard` 规则与 `preference` 偏好。
- 已审核真实问答范例。
- profile 优先级和默认回退关系。

绑定优先级：

```text
会话明确绑定 > 联系人/标签绑定 > 场景绑定 > workspace 默认 profile
```

### 5.2 Static Knowledge：静态业务知识

适合保存：

- 产品使用方法。
- 产品规格和稳定属性。
- FAQ。
- 已发布的售后、退换、保修、营业时间等政策。
- 标准流程和合规声明。

每个条目必须具有：

- workspace。
- 类型和主题。
- 正文或结构化字段。
- 来源。
- 状态：`draft | published | retired`。
- 版本。
- 生效和失效时间。
- 适用产品、渠道、地区、客户类型等 metadata。
- 风险级别。
- 可否逐字发送。

只有 `published` 且当前有效的条目才能进入自动回复上下文。

### 5.3 Relationship Memory：关系记忆

现有 CRM 是联系人主数据。新系统只补充可审核的记忆条目，不复制联系人身份。

关系上下文包括：

- CRM 的联系人、阶段、下一步和备注。
- 开放待办。
- 明确约定，例如“周五发报价”。
- 对方关注点和禁忌。
- 最近一次真实互动摘要。
- 有效期或是否仍待解决。

记忆类型：

- `fact`：稳定事实。
- `commitment`：用户已经作出的承诺。
- `open_loop`：未决问题。
- `preference`：联系人偏好。
- `event`：已经发生的业务事件。

模型推断出的记忆必须为 `candidate`；聊天中有直接证据也不应静默覆盖用户已确认资料。

### 5.4 Live Data：实时业务数据

订单状态不能以普通知识条目实现。定义统一 resolver 接口：

```js
resolveLiveData({
  workspaceId,
  kind,              // order | shipment | inventory | quote | account
  identifiers,       // orderNo, phone, sku 等
  conversationKey,
  requestedFields
})
```

返回：

```js
{
  status: "resolved | not_found | ambiguous | unavailable",
  facts: [
    {
      field: "order.status",
      value: "已发货",
      observedAt: 1789123456,
      expiresAt: 1789123516,
      sourceRef: "oms:order:123"
    }
  ],
  safeSummary: "订单 123 已发货",
  errorCode: null
}
```

规则：

- 仅 Host 侧 resolver 持有业务系统凭据。
- 模型不能提供任意 URL、SQL 或联系人标识来扩大查询范围。
- 查询身份必须来自服务端已绑定会话和经过验证的消息实体。
- 数据超过 `expiresAt` 后不得使用。
- `ambiguous`、`unavailable` 和关键字段缺失时转人工或要求对方补充必要信息。
- 实时查询结果可写审计快照，但不能重新发布成长期事实。

P0 可以不接外部业务系统，但必须预留接口。没有 resolver 时，对订单状态等问题明确转人工，不能从历史消息猜测。

### 5.5 Conversation State：当前会话状态

每轮使用 Worker 已提供的真实消息快照，建议最近 8 到 12 条，而不是复用会话时只发最新一条。

上下文必须区分：

- 对方真实发送的消息。
- 用户真实发送且 Runtime 确认的消息。
- 模型草稿或历史工具提交。
- 发送失败或不确定的消息。
- 当前仍开放的问题。

当前快照与持久 Session 冲突时，以当前快照和发送回执为准。

### 5.6 Decision Policy：自动化决策策略

每个 workspace 和会话都可以配置自动化范围：

- 哪些意图允许自动回答。
- 哪些意图只生成草稿。
- 哪些意图必须转人工。
- 允许使用哪些数据源。
- 是否允许报价、约时间、承诺回电或提供售后政策。
- 风险等级和渠道限制。

推荐风险分级：

| 等级 | 示例 | 默认处理 |
| --- | --- | --- |
| L0 | 寒暄、确认收到 | 自动回复 |
| L1 | 已发布 FAQ、产品使用说明 | 有证据时自动回复 |
| L2 | 报价、折扣、时间承诺、售后判断 | 默认草稿或转人工 |
| L3 | 退款批准、合同、付款账户、法律责任、敏感数据 | 必须人工 |

知识命中不会自动降低风险等级。

## 6. 冲突裁决：按维度处理

不要使用一条全局优先级处理所有冲突。不同维度有不同真相源：

### 6.1 发送权限

```text
Runtime/系统安全边界 > workspace 决策策略 > 会话自动化规则
```

知识、联系人备注和消息内容不能授权发送。

### 6.2 业务事实

```text
未过期实时 resolver 结果
> 当前有效且已发布的结构化事实
> 当前真实会话中的明确证据
> 已确认联系人记忆
> 无依据，不作具体断言
```

### 6.3 流程与政策

```text
法律/合规与 workspace 已发布政策
> 产品或地区专属政策
> 会话操作规则
> playbook 建议
```

### 6.4 表达方式

```text
会话专属 profile > 联系人/标签 profile > 场景 profile > workspace 默认 profile
```

这种分维度裁决可避免“联系人提示词覆盖公司退款政策”或“全局口吻覆盖客户专属称呼”等错误。

## 7. Context Orchestrator

新增 Host 模块负责构建 Canonical Context Pack。它是本方案的核心，不把拼接逻辑散落在 UI 或 prompt 中。

建议接口：

```js
createReplyContextSystem({
  databasePath,
  workspaceId,
  crm,
  resolverRegistry,
  maxContextChars
})

contextSystem.build({
  jobId,
  identity,
  conversationKey,
  rule,
  turnData,
  recentDeliveries
})
```

返回：

```js
{
  contextPack: {
    version: 1,
    workspaceId: "local",
    profile: {},
    decisionPolicy: {},
    contact: {},
    conversation: {},
    knowledge: [],
    liveFacts: [],
    examples: []
  },
  evidenceCatalog: [
    {
      id: "ev_...",
      kind: "published_knowledge | live_fact | conversation | confirmed_memory",
      risk: "low | medium | high",
      expiresAt: null,
      sourceRef: "..."
    }
  ],
  retrievalTrace: {},
  contextHash: "sha256"
}
```

构建步骤：

1. 验证 workspace、provider、conversation 和 conversationKey 一致。
2. 读取当前 conversation snapshot。
3. 从 CRM 获取联系人资料、待办和未决事项。
4. 选择 Communication Profile 和 Decision Policy。
5. 识别消息中的场景、产品、订单号等实体。
6. 查询静态知识。
7. 需要且获准时调用 Live Resolver。
8. 选择少量已审核范例。
9. 生成 evidence ID 和规范化 context hash。
10. 按预算裁剪并记录裁剪原因。

## 8. 检索策略

P0 不使用向量数据库，也不把全部资料无条件注入。

采用混合确定性检索：

1. **固定加载**：Decision Policy、当前 profile 的 hard rules、适用的高风险政策。
2. **作用域过滤**：workspace、产品、地区、联系人、渠道、有效期、发布状态。
3. **SQLite FTS5**：针对 FAQ、使用说明和 playbook 正文进行关键词检索。
4. **结构化触发**：订单号、SKU、价格、退款、发票等使用规则识别。
5. **范例选择**：按 profile、场景、联系人和审核质量排序。

只有在真实数据证明关键词检索召回不足、知识规模达到数百或数千条后，才加入 embedding。即使加入 embedding，发布状态、作用域、有效期和风险过滤仍必须先执行。

上下文预算建议：

| 内容 | 建议预算 |
| --- | ---: |
| 安全与决策策略 | 1200 字符 |
| profile | 1000 字符 |
| 联系人与未决事项 | 1200 字符 |
| 当前消息快照 | 3000 字符 |
| 静态知识与实时事实 | 3500 字符 |
| 范例 | 1500 字符 |

超限时先删除低质量范例，再删除低相关 FAQ；不得删除风险规则、实时事实时间戳、当前问题和开放承诺。

## 9. 生成协议与证据

模型仍只允许通过 `submit_reply_decision` 完成本轮，但 Host 内部工具 schema 应增加可选审计字段：

```js
{
  action: "reply | skip | needs_user",
  text: "发给联系人的正文",
  reason: "仅供用户查看",
  intent: "faq | order_status | quote | complaint | social | ...",
  evidence_ids: ["ev_..."],
  risk_tags: ["price", "commitment"]
}
```

兼容要求：

- Host 校验新增字段，并将其写入独立审计表。
- 返回 `agent_worker` 前剥离新增字段，保持 `agent_worker/decision.py` 当前允许的 wire contract：`job_id`、`event_id`、`action`、`text`、`reason`。
- `evidence_ids` 只能引用本轮 evidence catalog 中的 ID。
- 模型声明了证据不代表证据有效，Gate 必须再次验证来源、范围和有效期。

模型输入应包含清晰分区：

```text
[SYSTEM BOUNDARY]
[DECISION POLICY]
[CURRENT RULE]
[COMMUNICATION PROFILE]
[CONTACT AND OPEN LOOPS]
[VERIFIED KNOWLEDGE WITH EVIDENCE IDS]
[LIVE FACTS WITH OBSERVED/EXPIRES TIME]
[REAL CONVERSATION SNAPSHOT]
[APPROVED EXAMPLES]
[OUTPUT CONTRACT]
```

所有知识、联系人资料和消息都标记为数据，不能作为修改系统规则或扩大工具权限的指令。

## 10. Evidence & Risk Gate

Gate 位于模型提交决定之后、Host 返回 Worker 之前。它不能调用发送工具，也不能静默改变回复含义。

检查内容：

1. action/text/reason 的现有格式校验。
2. evidence ID 是否属于本轮 context。
3. 实时事实是否仍在有效期内。
4. 金额、折扣、库存、订单状态、日期和政策断言是否有匹配证据。
5. 是否出现未经授权的承诺，例如“一定”“保证”“今天发出”“马上到账”。
6. 是否命中 L2/L3 风险或强制转人工策略。
7. 是否泄露凭据、内部备注或其他联系人信息。
8. 是否违反 profile 的 hard 禁用词。
9. 是否把草稿或 uncertain 发送记录当成已发送事实。

输出：

```js
{
  outcome: "pass | needs_user | reject",
  finalDecision: {},
  reasonCode: "UNSUPPORTED_PRICE | LIVE_DATA_EXPIRED | ...",
  userMessage: "这条回复包含没有依据的价格，需要你确认"
}
```

处理原则：

- 高风险或事实不足：转 `needs_user`。
- 格式、凭据泄露、跨联系人引用：`reject` 并让 job 失败。
- 口吻 soft 偏好不作为发送阻断条件。
- hard 禁用词可转人工；不得用字符串替换偷偷改变语义。
- Gate 不进行第二次模型“自我审核”，第一版使用可解释规则。

## 11. 数据模型

新增 `data/reply-context.db`，由 Host 独占写入，使用 `node:sqlite` `DatabaseSync` 和 WAL。现有 `reply.db` 继续由 Worker 拥有，`crm.db` 继续拥有联系人主数据。

### 11.1 表设计

```sql
CREATE TABLE communication_profiles (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  rules_json      TEXT NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  revision        INTEGER NOT NULL DEFAULT 1,
  created_at      REAL NOT NULL,
  updated_at      REAL NOT NULL,
  UNIQUE(workspace_id, name)
);

CREATE TABLE profile_bindings (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  profile_id      TEXT NOT NULL,
  scope_type      TEXT NOT NULL,
  scope_key       TEXT NOT NULL,
  priority        INTEGER NOT NULL DEFAULT 0,
  created_at      REAL NOT NULL,
  FOREIGN KEY(profile_id) REFERENCES communication_profiles(id)
);

CREATE TABLE knowledge_items (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  content         TEXT NOT NULL,
  metadata_json   TEXT NOT NULL,
  source_type     TEXT NOT NULL,
  source_ref      TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL,
  risk_level      TEXT NOT NULL,
  verbatim_ok     INTEGER NOT NULL DEFAULT 0,
  valid_from      REAL,
  valid_until     REAL,
  revision        INTEGER NOT NULL DEFAULT 1,
  content_hash    TEXT NOT NULL,
  created_at      REAL NOT NULL,
  updated_at      REAL NOT NULL
);

CREATE TABLE memory_items (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  conversation_key  TEXT NOT NULL,
  kind              TEXT NOT NULL,
  content           TEXT NOT NULL,
  source_type       TEXT NOT NULL,
  source_ref        TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL,
  valid_until       REAL,
  created_at        REAL NOT NULL,
  updated_at        REAL NOT NULL
);

CREATE TABLE reply_examples (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  profile_id        TEXT,
  conversation_key  TEXT,
  intent            TEXT NOT NULL DEFAULT '',
  incoming_text     TEXT NOT NULL,
  outgoing_text     TEXT NOT NULL,
  source_ref        TEXT NOT NULL,
  quality           INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL,
  created_at        REAL NOT NULL
);

CREATE TABLE knowledge_candidates (
  id                TEXT PRIMARY KEY,
  workspace_id      TEXT NOT NULL,
  target_kind       TEXT NOT NULL,
  payload_json      TEXT NOT NULL,
  origin            TEXT NOT NULL,
  source_refs_json  TEXT NOT NULL,
  status            TEXT NOT NULL,
  created_at        REAL NOT NULL,
  decided_at        REAL
);

CREATE TABLE item_revisions (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL,
  item_type       TEXT NOT NULL,
  item_id         TEXT NOT NULL,
  revision        INTEGER NOT NULL,
  snapshot_json   TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  created_at      REAL NOT NULL,
  UNIQUE(item_type, item_id, revision)
);

CREATE TABLE reply_context_runs (
  job_id               TEXT PRIMARY KEY,
  workspace_id         TEXT NOT NULL,
  conversation_key     TEXT NOT NULL,
  context_hash         TEXT NOT NULL,
  profile_id           TEXT,
  profile_revision     INTEGER,
  evidence_json        TEXT NOT NULL,
  retrieval_trace_json TEXT NOT NULL,
  model_audit_json     TEXT NOT NULL,
  gate_outcome         TEXT NOT NULL,
  gate_reason_code     TEXT NOT NULL DEFAULT '',
  created_at           REAL NOT NULL
);
```

为 `knowledge_items` 建立 FTS5 索引。若运行环境不支持 FTS5，启动时明确报错或降级到受限的关键词匹配，不得静默返回空知识。

### 11.2 状态白名单

- profile：`draft | active | retired`
- knowledge：`draft | published | retired`
- memory：`candidate | confirmed | resolved | expired`
- example：`candidate | approved | rejected`
- candidate：`pending | accepted | rejected`

所有写入使用事务、expected revision 和字段长度限制。接受/拒绝候选应幂等。

## 12. 模块边界

建议新增：

```text
plugin/host/reply-context/
  database.mjs          schema、事务、revision
  profiles.mjs          profile 与绑定选择
  knowledge.mjs         发布、有效期、FTS 查询
  memory.mjs            CRM 投影和记忆条目
  resolvers.mjs         实时数据统一接口和注册表
  retriever.mjs         混合检索
  context-builder.mjs   Canonical Context Pack
  risk-gate.mjs         证据和风险校验
  audit.mjs             reply_context_runs
  index.mjs             对外聚合接口
```

要求：

- 检索、裁剪、hash 和 Gate 尽量为纯函数。
- 数据库层不引用 Harness Agent 对象。
- Resolver 不读取浏览器提交的任意身份；身份必须由服务端上下文提供。
- UI 不自行拼接模型 prompt。
- Worker 不直接连接 `reply-context.db`。

## 13. Host API

在现有同源认证边界下增加：

```text
GET/POST/PATCH  /message-agent/api/context/profiles
POST            /message-agent/api/context/profiles/:id/activate
GET/POST        /message-agent/api/context/profile-bindings

GET/POST/PATCH  /message-agent/api/context/knowledge
POST            /message-agent/api/context/knowledge/:id/publish
POST            /message-agent/api/context/knowledge/:id/retire
POST            /message-agent/api/context/knowledge/:id/rollback

GET/POST/PATCH  /message-agent/api/context/memories
POST            /message-agent/api/context/memories/:id/resolve

GET              /message-agent/api/context/candidates
POST             /message-agent/api/context/candidates/:id/accept
POST             /message-agent/api/context/candidates/:id/reject

GET              /message-agent/api/context/runs/:jobId
POST             /message-agent/api/context/preview
```

`preview` 只返回将使用的 profile、知识、实时数据状态、风险等级和模拟决策，不触发发送。

所有查询都必须从服务端 session 获得 `workspace_id`，不得接受客户端传入另一个 workspace ID。

## 14. 产品界面

不要做成一个“大知识库”页面。建议分为：

### 14.1 说话方式

- 创建不同 profile。
- 绑定客户、朋友、群聊或销售场景。
- 管理 hard rules、偏好和已审核范例。
- 提供几条真实输入进行回复预览。

### 14.2 产品与政策

- 草稿、已发布、已停用状态。
- 来源、版本、生效时间、失效时间。
- 产品/地区/渠道等适用范围。
- 发布前预览可能回答的问题。

### 14.3 联系人与记忆

- 继续使用现有 CRM 页面。
- 增加约定、未决事项和候选记忆。
- 清晰区分用户确认、消息证据和 AI 推断。

### 14.4 数据连接

- 显示订单、物流等 resolver 是否已配置和最近健康状态。
- 不在前端显示凭据。
- 未连接时明确提示此类问题将转人工。

### 14.5 自动化边界

- 按风险等级选择自动回复、只生成草稿或转人工。
- 高风险类别默认不可自动发送。
- 显示“知识不会扩大发送权限”。

### 14.6 回复依据

每条 job 可以查看：

- 使用的 profile。
- 引用的知识及版本。
- 实时查询时间和有效期。
- 命中的风险规则。
- 为什么允许自动发送或转人工。

## 15. 学习闭环

### 15.1 改稿学习

保存：模型草稿、用户最终版本、差异、场景和证据。模型可以据此提出候选：

- profile 规则调整。
- 新回复范例。
- 联系人偏好。
- 新 playbook 或 FAQ。

候选不得直接生效。

### 15.2 历史学习

- 只把真实 outgoing 当作用户口吻证据。
- 不把自动草稿、失败发送和 uncertain 记录当作范例。
- 读取范围和时间范围必须在 UI 展示。
- 抽取结果进入候选区。
- 跨联系人样本用于 profile 前必须去除姓名、订单号等特定信息。

### 15.3 质量反馈

用户对回复可以标记：

- 口吻不对。
- 事实不对。
- 不该自动回复。
- 应该回复但转人工了。
- 太长或太模板化。

反馈类型决定候选进入 profile、knowledge、memory 还是 decision policy，避免所有问题都被误归因到风格。

## 16. 安全与隐私

- 本地存储不等于数据不外发。调用云模型时，实际 context pack 会发送给模型提供方，UI 必须如实说明。
- 知识导入内容、联系人消息和 resolver 返回值都视为不可信数据，防止 prompt injection。
- 内部备注需要字段级可见性，默认不允许进入对外回复正文。
- 不在日志记录完整消息、完整知识正文或 resolver 凭据。
- workspace 隔离必须覆盖数据库查询、缓存、FTS、审计和 resolver。
- 导出、清除和备份按 workspace 执行。
- 对合同、法律、财务、支付账户、敏感个人数据默认 L3。

## 17. 测试策略

### 17.1 Context 构建

- 复用持久 Session 时仍注入最近真实消息快照。
- 当前快照覆盖旧 Session 中的过时状态。
- 两个 conversation key 不串联系人资料、范例或记忆。
- 显示名变化不改变 conversation identity。
- profile 绑定按会话、标签、场景、默认顺序选择。
- retired、draft、过期、作用域不符的知识不会被检索。
- 相同输入产生相同 context hash。
- 裁剪顺序符合预算规则。

### 17.2 实时数据

- resolved 且未过期的数据可成为证据。
- expired、unavailable、ambiguous 不得生成确定状态。
- 浏览器不能构造任意 workspace、联系人或订单查询。
- resolver 返回其他客户数据时 Gate 必须拒绝。

### 17.3 风险 Gate

- 无证据金额、折扣、日期、订单状态、政策被转人工。
- 引用不存在的 evidence ID 被拒绝。
- L3 意图即使知识命中仍必须人工。
- hard 禁用词被识别。
- soft 风格偏好不会错误阻断普通回复。
- 草稿和 uncertain 消息不会被当成已发送事实。
- `reason` 和内部备注不会进入回复正文。

### 17.4 租户隔离

- workspace A 无法查询、检索、绑定、引用或审计 workspace B 的数据。
- FTS 和缓存结果包含 workspace 过滤。
- API 忽略或拒绝客户端伪造 workspace ID。

### 17.5 现有回归

- 自动回复启停、revision、任务过期、去重和恢复。
- 同一会话忙碌互斥。
- 生成期间新消息导致旧回复作废。
- Runtime 发送幂等和 uncertain 不重试。
- `agent_worker/decision.py` wire contract 保持兼容。
- 所有 E2E 使用 simulation provider，真实微信发送数量为 0。

## 18. 评估方式

先建立匿名化离线评测集：

- 输入：历史 incoming、当时真实上下文。
- 参考：用户真实 outgoing 或人工认可回复。
- 标签：意图、风险、需要的事实来源、是否应转人工。

核心指标：

1. 无依据事实率，目标为 0。
2. 应转人工却自动回复率，目标为 0。
3. 联系人或 workspace 串数据率，目标为 0。
4. 用户修改率。
5. 完全重写率。
6. 过度转人工率。
7. profile hard rule 违反率。
8. 平均延迟和每条回复成本。

上线顺序：离线回放 -> 影子模式 -> 用户确认草稿 -> 低风险小流量自动回复 -> 扩大范围。

## 19. 实施阶段

### Phase 0：基线和回放框架

- 建立匿名化评测 fixture。
- 记录当前版本的修改率、无依据事实和转人工表现。
- 不改发送链路。

### Phase 1：Canonical Context

- 新增 reply-context 数据库和 Context Orchestrator 骨架。
- 每轮注入最近真实消息快照、CRM、open loops 和 profile。
- 保持静态知识和 resolver 为空。
- 增加 context hash 和审计。

这是最快改善“无厘头”和“不像用户”的阶段。

### Phase 2：静态知识与发布流程

- 实现 knowledge 状态、revision、有效期和 FTS5。
- 实现产品/政策 UI 与 preview。
- 引入 evidence catalog。

### Phase 3：Risk Gate

- 扩展 Host 内部 decision schema。
- 保持 Worker wire contract 不变。
- 上线事实、承诺、权限和跨联系人校验。
- 先观察模式，再强制执行。

### Phase 4：Live Resolvers

- 接入订单、物流等第一个实际业务系统。
- 完成标识绑定、TTL、故障降级和健康状态。
- 未配置的实时场景继续转人工。

### Phase 5：学习闭环

- 改稿候选。
- 历史范例候选。
- 联系人记忆候选。
- 用户反馈分类。

### Phase 6：多租户加固

- 即使当前仍是本地部署，也对 workspace 隔离做完整自动化测试。
- 若产品开始提供账号系统，再把 `local` workspace 映射到真实 tenant/user，不迁移表结构。

## 20. Definition of Done

以下条件全部满足才能认为第一版可交付：

- 复用会话时每轮仍使用当前真实消息快照。
- 支持多个 Communication Profile，并能按会话/场景绑定。
- 静态知识具有 draft/published/retired、revision 和有效期。
- 订单状态等动态问题不会从静态知识或旧消息猜测。
- 所有具体业务断言都能追溯 evidence。
- 风险策略与知识检索相互独立，知识不能扩大自动发送权限。
- AI 学习内容未经确认不会生效。
- 每条自动回复可查看 context hash、证据、风险判断和数据有效期。
- workspace 之间不存在数据、检索、缓存或审计串用。
- Worker/Runtime 现有发送授权、revision、去重和 uncertain 行为保持不变。
- 回放和 simulation 测试全部通过，真实微信发送数量为 0。

## 21. 给实现 Agent 的执行约束

1. 编码前阅读 `README.md`、`agent_worker/database.py`、`agent_worker/service.py`、`agent_worker/decision.py`、`plugin/index.mjs`、`plugin/reply-policy.mjs`、`plugin/host/crm.mjs`、`plugin/host/product.mjs` 和现有测试。
2. 不以任何旧知识库设计文档作为实现依据；本文件是当前权威规格。
3. 严格按 Phase 0 到 Phase 3 分批实施，Phase 4 需要明确的业务系统接口后再开始。
4. 首先修复 canonical context，再实现知识检索；不要先引入 embedding。
5. 不修改现有发送授权模型，不新增绕过 Runtime 的发送入口。
6. Host 内部审计字段不得破坏 Worker 的 decision wire contract。
7. 不使用真实联系人测试，不启用真实自动规则，不重启生产监听任务，除非用户另行明确授权。
8. 每个阶段报告修改文件、schema 变化、测试命令、测试结果、评测变化、未完成项和风险。
9. 遇到现有未提交改动时保留用户内容，不执行破坏性 Git 命令。
10. 任何偏离本规格的决定必须说明原因及其对事实可靠性、权限和数据隔离的影响。
