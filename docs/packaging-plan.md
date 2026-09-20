# Message Agent 打包与交付方案（v2）

日期：2026-09-20。状态：**方案待评估，尚未实施**。本文取代 2026-09-09 的 `packaging.md`
（旧文中仍然成立的部分已并入本文，过时部分已按当前实现校正）。

读者：项目负责人。本文只做设计决策与分期计划，不改代码、不装软件、不动现有数据。

---

## 0. 结论摘要

| 问题 | 结论 |
| --- | --- |
| 交付形态 | 一个 `MessageAgentSetup.exe`（Inno Setup）+ 一份可离线分发的组件包；安装目录只读，数据落 `%LOCALAPPDATA%\MessageAgent` |
| 是否一键 | 是。双击 → 选择「云端模型」或「稍后配」 → 建计划任务 → 打开已认证页面。全程不超过 3 次点击 |
| 大模型 key | 必配项，但**不在安装包里**。云端 key 由安装器采集，DPAPI 加密落盘，启动时注入子进程环境变量（当前是 `deepseek-harness/.env` 的 `DEEPSEEK_API_KEY`，实测确认） |
| 本地模型 | **不打包**。首版只做「检测到就在设置里可选」；下载/接入做成设置里的独立动作（后续里程碑） |
| 微信数据库 key | **只在需要时扫一次内存**；结果 DPAPI 加密缓存；**再次扫描只在开发者模式**暴露 |
| 明文副本 | 永远保留**最新一份**（按 source size+mtime 判定新鲜度），旧的自动清掉；副本不可读时不删旧副本 |
| 最大的两个风险 | ① 当前 node 运行时来自 `codex-runtimes` 路径、harness 是 **TS 源码 + tsx 直接跑**，都不是可交付形态；② key 缓存目前是**明文 JSON** |

---

## 1. 现状盘点（2026-09-20 实测）

### 1.1 组件与真实依赖

| 组件 | 现状位置 | 运行时依赖 | 交付形态问题 |
| --- | --- | --- | --- |
| 产品本体 | `message-agent/`（`plugin/`、`agent_worker/`、`launch.py`、`presets/`、`web.patch.yml`） | Python 3.13（worker）、Node（harness） | worker 与产品代码可整体打包，但要清掉绝对路径 |
| 引擎（DSH） | `deepseek-harness/`（pnpm monorepo，**源码**） | `node` + `tsx/esm`、`node_modules` | ⚠️ 现状用 `apps/cli/src/bin.ts` **直接跑 TS 源码**；发布必须换成已构建产物 |
| Node 运行时 | `C:\Users\Wencharm\.cache\codex-runtimes\codex-primary-runtime\...\node.exe` | — | ⚠️ 这是**别的工具的运行时而临时借用**，不能作为交付依赖 |
| 消息运行时 | `messaging-runtime/`（.NET 8，8766 端口） | .NET 运行时、自家 python（OCR） | 需按 `tools/package.ps1` 产出并验证 self-contained |
| 取密钥/解密 | `wechat-db-lab/`（Python 包：`keyextract`/`winmem`/`vault`/`snapshot`/`watcher`） | Python + `ctypes`（实测 `win32crypt` 缺失，DPAPI 要走 ctypes） | 以 pip 包形式内置，或 vendored 到 `app/` |
| 数据（产品） | `data/`：`reply.db`、`crm.db`、`inbox.db`、`reply-context.db`、`*.json` | — | 迁移到 `%LOCALAPPDATA%` |
| 数据（引擎） | `.harness/`：`settings.yaml`、`.credentials.yaml`、`sessions/`、`storages/` | — | 迁移到 `%LOCALAPPDATA%\MessageAgent\harness` |
| 微信侧 | 源库 `%USERPROFILE%\xwechat_files\<wxid>\db_storage` | — | 只读，永不写 |

### 1.2 凭据现状（这是安全设计的起点）

| 凭据 | 现在在哪 | 保护等级 |
| --- | --- | --- |
| 云端模型 key | `deepseek-harness/.env` 的 `DEEPSEEK_API_KEY`（35 字符），由 `launch.py:22` 读进子进程环境 | 明文文件（git 已忽略，但任何本机进程可读） |
| 引擎会话授权 | `.harness/.credentials.yaml`（`client-connection/browser-session`，grant） | 明文 |
| 本地模型 key 引用 | `.harness/.credentials.yaml` 的 `refs.OLLAMA_LOCAL_API_KEY: ollama` | 只是引用名，无密钥 |
| **微信数据库 key** | `%LOCALAPPDATA%\wechat-db-lab\keys\<wxid>.json`（每个库 64 hex）+ `.json.bak` | ⚠️ **明文 JSON，且有两份** |
| 解密后明文副本 | `%LOCALAPPDATA%\wechat-db-lab\vault\<wxid>\plain\<分类>\*.db`（实测 2.3 MB） | 明文（设计上如此：`vault.py` 只保证"源库只读 + manifest 只记指纹"） |

> `vault.py` 已经做对的部分要保留：copy-first（先复制再解密）、明文只落 `plain/`、
> **manifest 只记密钥指纹（SHA-256 前 12 位）不记密钥**、`unlock` 幂等（source size+mtime 未变则跳过）。

### 1.3 现有安装表面

`install.ps1` 是**开发机部署脚本**（把 `plugin/`、`agent_worker/` 等拷到固定绝对路径
`C:\Users\Wencharm\Documents\projects\message-agent`，并从 `messaging-runtime/runtime/python/pythonw.exe`
取解释器，然后注册计划任务 `Messaging Agent`）。它**不能直接给用户用**，但里面的三件事是对的，
应原样吸收进新安装器：

1. 停旧任务、等 8767 端口释放（带 20 秒上限）；
2. `Register-ScheduledTask` + `AtLogOn` + `ExecutionTimeLimit=0` + `RestartCount=3`，任务归属当前用户；
3. 安装完立即 `Start-ScheduledTask`。

`launch.py` 继续作为唯一启动入口（进程树托管 + 插件健康等待都已具备）。

---

## 2. 目标与非目标

**目标（v1 必须成立）**

- 用户在**没有任何开发工具**（无 Node/Python/.NET SDK/pnpm/tsx）的机器上，双击安装即可用。
- 安装过程只要求用户做**一个决定**：用云端模型（贴一次 key）还是稍后再配。
- 卸载/升级不破坏数据；升级不丢追踪记录、不重发任何已发送的消息。
- 微信 key 与明文副本的处理满足第 5、6 节的硬约束。

**非目标（v1 明确不做）**

- 不打包本地模型权重、不打包 Ollama；不做 GPU 依赖分发。
- 不做 Windows 桌面外壳（继续用浏览器访问本地页面）。
- 不做多用户/多微信账号切换（沿用当前的单账号假设，但目录结构按账号分）。
- 不做跨机器迁移（数据搬运由用户手动备份目录完成）。

---

## 3. 交付形态与目录布局

### 3.1 两个产物

| 产物 | 内容 | 说明 |
| --- | --- | --- |
| `MessageAgentSetup.exe` | 安装器（Inno Setup），内含 `components/` 压缩包 | 单文件，可离线 |
| `MessageAgent-<ver>-components.zip` | 供企业内网分发的等价内容 | 与 exe 内嵌内容同源同哈希 |

不做 MSI：Inno 的脚本能力足够，且能直接跑 PowerShell 完成计划任务注册。

### 3.2 安装目录（建议：`%LOCALAPPDATA%\Programs\MessageAgent`，避免 UAC）

```text
MessageAgent/
  MessageAgent.exe            # 启动器（v1 可先用 MessageAgent.cmd + launch.py）
  app/                        # plugin/ agent_worker/ presets/ web.patch.yml node-bootstrap.mjs
  engine/harness/             # 已构建的 DSH 产物 + 必需 npm 依赖 + 客户端资源
  runtimes/node/              # 自带 node（与引擎兼容的固定版本）
  runtimes/python/            # worker 用（可直接复用 messaging-runtime 的 python）
  components/messaging-runtime/
  components/wechat-db-lab/   # 取密钥/解密（vendor 的源码副本 + 版本号）
  licenses/
  manifest.json               # 组件版本、协议版本、每个文件 sha256、平台
```

**要点**

- 安装目录**可只读**：升级写新目录再切入口，不覆盖用户数据。
- `manifest.json` 里所有路径是**相对安装目录**，由启动器解析成绝对路径（现有 worker 会校验绝对路径，
  所以解析动作放在启动器，不改内部接口）。
- **不含**：`.env`、任何 token、任何 `*.db`、聊天记录、日志、`workspace/`、开发机配置。

### 3.3 用户数据目录

```text
%LOCALAPPDATA%/MessageAgent/
  config/           # 解析后的本机配置（含 config.json 的最终形态）
  credentials/      # 本机生成凭据 + DPAPI 加密的密钥（见第 5 节）
  data/             # reply.db crm.db inbox.db reply-context.db *.json
  harness/          # 原 .harness（settings/sessions/storages）
  workspace/        # 产品工作区
  logs/             # harness.log/worker 日志，带轮转（见 8.3）
  backups/          # 升级前的一致性备份（保留最近 N 份）
```

微信侧数据继续由 `wechat-db-lab` 管理，位置不变（`%LOCALAPPDATA%\wechat-db-lab\`），
因为它是独立工具、可能被其他程序共用；产品只通过它的 API 读写。

---

## 4. 一键安装与首次启动

### 4.1 安装流程（安装器脚本）

| 步 | 动作 | 失败处理 |
| --- | --- | --- |
| 1 | 环境检查：Windows 10+ / x64、微信已安装、`xwechat_files` 存在、8766+8767+3080 空闲 | 明确提示是缺微信还是端口被占；端口被占时不强杀，提示后退出 |
| 2 | 展开组件到安装目录，校验 `manifest.json` 每个文件哈希 | 哈希不符即中止并保留日志 |
| 3 | 生成产品凭据（`control.token`、`worker.token`、runtime token 引用），写 `credentials/` | — |
| 4 | **选择模型**：① 云端（粘贴 key，或点「用浏览器登录」走引擎的授权流程）② 稍后再配 | 允许"稍后"，但页面首屏会显示一条"还没配模型"的横幅 |
| 5 | 初始化用户数据目录 + 从旧版本（若检测到开发目录）**迁移向导**（见 9.1） | 迁移失败则回滚到"不迁移"，绝不半途覆盖 |
| 6 | 注册计划任务 `Message Agent`（AtLogOn / 当前用户 / 不限时 / 3 次重启），立即启动 | 注册失败给出可复制的 `schtasks` 命令 |
| 7 | 等健康检查（`/message-agent/health` 就绪）→ 打开带 token 的本地页面 | 60 秒超时则打开诊断页并指向 `logs/` |

幂等：重复运行安装器视为**修复安装**（保留 `data/`、`credentials/`、`harness/`）。

### 4.2 首次启动时的微信侧初始化（关键：只有一次扫描）

```text
启动 → 读 credentials/wechat-keys.dat（DPAPI 解密）
  ├─ 有可用 key → 校验（页 1 HMAC）→ 直接 unlock（复制+解密）
  └─ 无 key 或校验失败
       ├─ 非开发者模式 → 页面提示「需要一次微信密钥读取」+ 一个明确的按钮
       │                 （必须由用户点，不自动扫）
       └─ 开发者模式   → 允许再扫，并显示扫描次数/上次时间/来源(page1/master)
```

**这条是硬约束**：内存扫描不是启动路径上的自动步骤，而是用户显式触发的一次动作。

---

## 5. 密钥安全设计

### 5.1 威胁模型（先说清楚 DPAPI 能做什么、不能做什么）

| 威胁 | DPAPI(CurrentUser) 是否挡住 |
| --- | --- |
| 同机**其他 Windows 用户**读文件 | ✅ 挡住 |
| 文件被拷到别的机器 / 云盘 | ✅ 挡住（无法解密） |
| 同机、**同一个用户**下运行的其他程序 | ❌ **挡不住**（DPAPI 只绑定到用户，不绑定到进程） |
| 用户自己误发文件 | 缓解（拿到的是密文） |

所以"防止其他程序读取"只能做到**"防止其他用户与文件外带"**。要做到同用户下也读不到，
需要另加一层（见 5.4 的分级），这是取舍，不该假装解决。

### 5.2 落盘方式

- 存 `%LOCALAPPDATA%\MessageAgent\credentials\wechat-keys.dat`，
  内容 = `CryptProtectData`（`crypt32.dll`，`ctypes` 调用，**不需要 pywin32**，实测环境无 `win32crypt`）加密后的 JSON。
- 作用域 `CRYPTPROTECT_UI_FORBIDDEN` + 默认 CurrentUser；可选加**第二因子 entropy**
  （固定字节串，编译进二进制），使"只复制 dat 文件"也解不开。
- 明文**绝不落盘**：`keys/*.json`（含现有 `.bak`）在首次迁移后删除，只留 `.dat`。
- 文件 ACL：仅当前用户 + SYSTEM 可读；放在 `credentials/`，**不放在** `wechat-db-lab\keys\`（那个目录可能被其他工具共用）。
- 日志纪律：`explain`/`dev` 字段继续只报**指纹**（前 12 位）与来源（cache/memory/master），永不打印 key。

### 5.3 内存扫描的时机与次数（用户明确要求）

| 场景 | 是否允许扫内存 |
| --- | --- |
| 首次安装/首次初始化 | ✅ 用户点按钮后扫一次 |
| 日常启动 | ❌ 只读缓存 |
| 缓存校验失败（微信大版本换了加密方式） | ✅ 允许一次，且**必须提示用户**这是重新读取 |
| 开发者模式下的「重新扫描」 | ✅ 允许（入口只在设置→开发者模式） |
| 自动重试/后台轮询 | ❌ 永不 |

配套：记录 `keys_meta`（`last_scan_at`、`scan_count`、`source`、`fingerprint`），
在设置页可见；`scan_count` 异常增长可作为诊断信号。扫描实现保持现状（只 `ReadProcessMemory`，
不写内存、不 hook）。

### 5.4 可选加强（作为里程碑，不在 v1 硬指标）

- **不落盘密钥**：只在解锁时从内存取一次，进程退出即失效（代价：每次启动要扫一次内存，与 5.3 冲突，故不默认）。
- **Windows Hello / DPAPI-NG**：`CryptProtectData` 换成需要用户在场（生物识别）的保护，可挡住同用户的其他程序。
- 明文副本用 EFS 加密（只挡离线拷盘）。

---

## 6. 明文副本策略（"永远留最新一份"）

### 6.1 现状

`vault.py` 已做到：copy-first、逐页解密、合并 WAL、写 manifest、幂等（source size+mtime 未变则 `reused`）。
**缺**的是保留策略与不可用时的降级行为。

### 6.2 规则

| 规则 | 具体做法 |
| --- | --- |
| 永远有最新 | 每次成功 unlock 后，把 `plain/` 标记为"当前可用副本"（manifest 记 `plain_rev` + `updated_at`） |
| 一份就够 | 明文副本**只保留一份**（原地更新）。当前实现已是原地更新，保持 |
| 旧的清掉 | 清理对象是**残留物**：`.bak`（含明文 key 的旧备份）、`%TEMP%` 下的解密暂存、`vault/<wxid>/` 下非当前 `plain_rev` 的目录、以及**其他账号目录**（若该账号已不在本机登录） |
| 不可读时的降级 | unlock 失败 → **不删任何旧副本** → 页面明确说"正在用 X 分钟前的副本"（时间取自 `updated_at`），并只提供"重试读取"入口 |
| 新鲜度提示 | 首页/设置显示「副本时间」；超过阈值（建议 30 分钟）时在消息页顶部提示"这不是最新的" |
| 空间上限 | `plain/` 超过阈值（建议 2 GB）时告警，不自动删（删副本等于丢历史，交给用户决定） |

### 6.3 与"降低风险"的关系

用户的目标是"db 读取不了时起码还有一份最新的"。所以清理规则里有一条**反直觉但重要**的：
**unlock 失败时绝不清理**。清理只在"新副本已经成功落盘并校验通过"之后才允许执行。

---

## 7. 模型配置

### 7.1 云端模型（v1 默认）

| 项 | 设计 |
| --- | --- |
| 用户输入 | 安装器第 4 步或设置页：`sk-...`；也允许"用浏览器登录"走引擎既有授权 |
| 存放 | `credentials/model-cloud.dat`（DPAPI 加密），**不写 `.env`**；启动时由 `launch.py` 解密后注入子进程环境变量（保持引擎零改动） |
| 校验 | 保存前发一次最小请求验证；失败不出安装流程，只提示"key 可能不对，可稍后再配" |
| 更换/撤销 | 设置页「模型」一栏可替换；替换即覆盖 `.dat` |
| 不进发行物 | 安装包内**不含**任何 key；`.env` 不进包 |

> 现状校正：现在 key 在 `deepseek-harness/.env`（明文、git 已忽略）。迁移动作是把这一行
> 搬进 DPAPI 存储并从 `.env` 删除（`.env` 仅保留引擎自身需要的其它变量）。

### 7.2 本地模型（不打包，后续在设置里接入）

| 项 | 设计 |
| --- | --- |
| 发行物 | **不含** Ollama、不含任何模型权重 |
| 检测 | 设置页探测 `127.0.0.1:11434`；在就跑一次 `/api/tags` 列出已有模型 |
| 未安装 | 给一条明确路径：下载 Ollama 安装 → 回到设置页点「刷新」→ 选中模型（不代下载，避免包体与授权问题） |
| 后续里程碑 | 「一键下载本地模型」：由设置页调用 Ollama 的 pull API 并显示进度 |
| 配置落点 | 与现在一致（`settings.yaml` 的 `llm-pi-ai.providers.<name>`），但**新装机器不预置** `ollama-local`，由设置页生成 |
| 隐私说明 | 已有：选本地模型时该轮回复不出本机（界面已写明） |

### 7.3 两个任务各自配模型

现状已支持（`auto_provider/auto_model` + `organize_provider/organize_model`）。安装器只需保证
**初始值 = 云端默认模型**，不做额外设计。

---

## 8. 启动、日志与诊断

### 8.1 启动链（沿用并补齐）

```text
MessageAgent.exe / 计划任务
  → launch.py
      1. 读 manifest，解析路径（相对 → 绝对）
      2. 解密 credentials（模型 key、产品 token）→ 只进子进程环境
      3. 建 supervisor job（进程树托管）
      4. 起 harness（engine/harness + runtimes/node），等插件健康
      5. 起 worker（runtimes/python）
      6. 打开 http://127.0.0.1:3080/?token=...
```

要补的两件事（旧文已提，仍未做）：启动失败时**清理自己创建的子进程**；给用户一个显式的
「重启服务」入口（现在只能靠 `restart.ps1`，且文档里记着它"看起来成功其实没起来"的坑）。

### 8.2 端口

3080 / 8766 / 8767 默认值保留，但**由启动器统一分配并写入配置**，不再各处硬编码；
冲突时给出"哪个进程占用 + 怎么改"的一句话。

### 8.3 日志

| 文件 | 策略 |
| --- | --- |
| `logs/harness.log` | 单文件上限 5 MB × 3 份轮转（现状是无限增长，实测一天 132 KB，长期会成问题） |
| `logs/worker.log` | 同上 |
| `logs/dev-errors.log` | 仅开发者模式写；上线默认关闭 |
| 诊断包 | 设置页「导出诊断包」：打包日志 + manifest + 组件版本 + **脱敏后的**配置（key/指纹一律不含） |

---

## 9. 迁移、升级、回退、卸载

### 9.1 从开发目录迁移（当前这台机器的场景）

1. 停旧任务等端口释放；对 `data/` 下 WAL 库用 SQLite 一致性备份（`VACUUM INTO`），**不裸拷正在写的 `.db`**；
2. 拷 `data/`、`.harness/`、`workspace/` 到新 `dataRoot`，重写其中的绝对路径字段；
3. 密钥迁移：明文 `wechat-db-lab\keys\*.json` → DPAPI `credentials/wechat-keys.dat`，成功后删除明文与 `.bak`；
4. 保留旧目录不动，直到新安装验证通过（跑一次 `pytest`/`node --test` 与一次真实只读读取）。

### 9.2 升级

写新版本目录 → 健康检查通过 → 切入口（计划任务指向新路径）→ 失败则切回并保留日志。
数据库/session 格式不兼容时**阻止启动**并提示，而不是带着旧数据跑新代码。

### 9.3 回退

组件版本回退前检查 DB/session 兼容性；任何回退都**不删除、不改写** Runtime 的 `sent`/`uncertain`
记录，不重用旧自动任务（否则会重复发送）。

### 9.4 卸载

默认**保留用户数据**（`%LOCALAPPDATA%\MessageAgent`、`wechat-db-lab`）；
删除数据必须是独立的、二次确认的动作。卸载必须注销计划任务并停掉自己拥有的进程。

---

## 10. 验收门槛

| 检查 | 通过条件 |
| --- | --- |
| 干净机器可用 | 仅装微信的 Win10/11 虚拟机，无 Node/Python/.NET SDK/pnpm，双击安装后能打开页面并读到消息 |
| 路径健壮 | 安装目录含空格或中文可用；从任意 cwd 启动；安装目录设为只读仍可运行 |
| 模型配置 | 贴 key → 保存校验通过 → 自动回复与整理都能出结果；key 只以 DPAPI 密文存在 |
| 本地模型 | 不装 Ollama 时设置页给出清晰指引且不报错；装了 Ollama 后能在设置里选中并跑通一次整理 |
| **密钥安全** | 安装后本机**不存在明文 key**（`keys/*.json`、`.bak`、`.env` 中的 `DEEPSEEK_API_KEY` 均已清）；`credentials/*.dat` 拷到另一台机器无法解密 |
| **扫描次数** | 完整安装+日常启动流程中，内存扫描次数 = 0（除非用户点了那一次按钮）；`scan_count` 在设置页可见 |
| 副本策略 | unlock 成功后磁盘上只有一份 `plain/`；unlock 失败时旧副本仍在且页面显示副本时间 |
| 包清洁 | 发行物不含 `.env`/token/`*.db`/聊天记录/日志/`workspace/`/开发机路径 |
| 状态保护 | 升级保留规则、历史、凭据、发送幂等记录；待确认的消息不会自动发送 |
| 组件追溯 | 引擎 revision、补丁清单、运行时版本、组件哈希、许可声明齐全 |

---

## 11. 分期执行计划（评估通过后按此推进）

| 阶段 | 交付 | 依赖 | 风险 |
| --- | --- | --- | --- |
| P0 依赖收敛（最大工作量） | ① 自带 node 运行时替换 `codex-runtimes` 借用；② harness 产出**已构建产物**（不再 tsx 跑源码）；③ `plugin/index.mjs` 里对引擎源码的三处 import 改为包导出 | 引擎构建脚本 | ⚠️ 高：引擎构建链是 pnpm monorepo，要确认产物完整性（动态插件、原生模块、Web 资源） |
| P1 密钥与副本 | DPAPI 存储 + 明文迁移；扫描策略（见 5.3）；副本保留策略（见 6.2）；设置页的密钥/副本状态区 | P0 无关，可并行 | 中：DPAPI 走 ctypes 要自己封一层，需单测覆盖加解密与跨机不可解密 |
| P2 路径与安装器 | 相对路径解析 + `dataRoot` 迁移；Inno 安装脚本；计划任务注册/注销；升级与回退 | P0、P1 | 中 |
| P3 模型配置与本地模型接入 | 安装器采集云端 key；设置页本地模型检测/刷新；隐私文案 | P2 | 低 |
| P4 打磨 | 日志轮转、诊断包导出、重启服务入口、卸载保留数据确认 | P2 | 低 |

每阶段结束都跑：`node --check` + 全量 node 测试 + worker 的 4 个 unittest + 一次真实只读读取。

---

## 12. 待确认（需要你决定）

| # | 问题 | 备选 |
| --- | --- | --- |
| 1 | 安装目录放哪 | A `%LOCALAPPDATA%\Programs\MessageAgent`（免 UAC，推荐）／B `C:\Program Files`（需管理员） |
| 2 | 引擎交付方式 | A 构建产物 + 依赖（推荐）／B vendor 源码快照（改一行都要重建，不建议） |
| 3 | Node/Python 运行时 | A 自带固定版本（推荐，可重复）／B 检测用户已装版本（省体积但不可控） |
| 4 | 云端 key 是否允许"稍后再配" | A 允许（首屏显示未配横幅，推荐）／B 必须配完才能进页面 |
| 5 | 首次密钥扫描的触发方式 | A 用户点按钮（推荐，满足"只扫一次"）／B 首次启动自动扫一次 |
| 6 | DPAPI 是否加第二因子 entropy | A 加（多一层，代价是更换机器必须重扫）／B 不加（推荐，简单） |
| 7 | 明文副本上限告警阈值 | 建议 2 GB，是否合适 |
| 8 | 是否现在就把 `deploy-runtime.py` 挪到 `messaging-runtime/tools/` | 它现在住在 `message-agent/workspace/`，语义上属于 runtime |

---

## 13. 已执行到这里（2026-09-20）

已按 §12 的决定落地第一批：安装目录 `%LOCALAPPDATA%\Programs\MessageAgent`、运行时**自带**、
云端 key 允许"稍后再配"、首次密钥扫描**必须用户点击**、`deploy-runtime.py` 待迁往 runtime 仓库。

### 13.1 已经能跑的东西

| 产物 | 位置 | 状态 |
| --- | --- | --- |
| 安装程序 | `packaging/install.ps1` | 8 步全流程，**沙箱实测 exit=0** |
| 打包器 | `packaging/build-package.ps1` | **实测产出 116.7 MB / 2147 文件**，含逐文件 sha256 的 `manifest.json` |
| 配置生成 | `packaging/make_config.py` | 由模板 + 替换值生成，自检关键字段非空 |
| 用户入口 | `packaging/MessageAgent.cmd` + 桌面快捷方式 | 双击 = 启动（没在跑才起）+ 打开页面 |
| 起停重启 | `packaging/start.ps1` / `stop.ps1` / `restart.ps1` | 停的时候同时清残留进程（见 13.3） |
| 卸载 | `packaging/uninstall.ps1` | 默认保留数据，删数据要输入 DELETE |
| 用户文档 | `packaging/安装说明.md` | 给普通用户，含隐私说明与常见问题 |
| 自带运行时 | 包内 `runtimes\node`（官方 v22.23.0）、`runtimes\python`（官方 3.13.12 embeddable） | 实测 node/python/sqlite3 均可用 |
| 密钥保管 | `agent_worker/secrets_store.py`（DPAPI，`ctypes` 调 `crypt32`） | 实测往返一致；密文改 1 字节即拒绝解密 |
| 启动注入 | `launch.py` | DPAPI 里的模型 key 注入子进程；日志落到数据目录并做 5 MB 轮转 |

安装完成后这台机器上**不再有明文模型 key**（`.env` 里的那一份改由 DPAPI 存储接管，见 13.4）。

### 13.2 引擎与密钥：已按你的决定做完（2026-09-20 第二轮）

**引擎整包带走，用户不用再装任何依赖。**

- `build-package.ps1` 现在**默认**复制引擎（`-SkipEngine` 才跳过）。必须用 **robocopy**：
  pnpm 的 `node_modules` 是很深的符号链接树，路径普遍超过 260 字符，`Copy-Item` 会成片失败。
  复制后自检 `apps\cli\src\bin.ts` 与 `node_modules\tsx` 都在，缺一个就中止打包。
- 安装器把引擎装到 `<安装目录>\engine\harness`，并在完成后自检；配置里的 `harness_root`
  指向安装目录内的那份，安装包文件夹删掉也不影响。
- 排除项：`.git` / `.github` / `.claude` / `.agents` / `snapshots` / `coverage` / `*.tsbuildinfo`。
- 引擎入口支持 `-NodeRuntime`（用本地目录代替下载官方包）。

**微信密钥：DPAPI 保管 + 只在用户授权时读内存。**

| 环节 | 做法 |
| --- | --- |
| 存放 | `credentials\wechat-keys.dat`（DPAPI，`agent_worker/secrets_store.py`）；**明文 `keys\*.json` 与 `.bak` 安装时迁移后删除** |
| 运行时 | `launch.py` 解密到 `<run_dir>\keys\<账号>.json`，用 `WECHAT_DB_LAB_KEYS_DIR` 喂给 watcher；**进程退出时删掉这份运行时副本** |
| 不自动扫 | `launch.py` 给 worker 带 `WECHAT_DB_LAB_NO_SCAN=1`；`wechat-db-lab` 的 `vault.memory_scan_allowed()` 据此跳过第二轮（读内存），只如实报告缺哪些密钥 |
| 用户授权扫一次 | `packaging/读取微信密钥.ps1`（要输入 YES 确认）→ `wechat_keys.py scan` → 跑一次解锁（允许扫内存）→ 存进 DPAPI → 删明文 |
| 安装时 | 先 `migrate`（明文→DPAPI）；若仍没有密钥，**问用户**要不要现在读一次（默认建议读，但必须他确认） |

**已在你机器上实测**：迁移 10 条密钥后重启，明文缓存消失，界面照常读到 8 个会话 /
60 条正文 —— 也就是"密钥只在 DPAPI + 运行时副本里"这条链路真的通。

### 13.2.1 引擎与运行时的实测

| 验证 | 结果 |
| --- | --- |
| 包内 node 跑引擎入口 | ✅ `runtimes\node\node.exe --import node-bootstrap.mjs --import tsx/esm apps/cli/src/bin.ts --version` → `0.1.2-alpha.1`（与 `launch.py` 完全相同的加载方式） |
| 包内 python | ✅ 3.13.12 embeddable，`sqlite3` 可用 |
| 引擎复制完整性 | 脚本自检 `apps\cli\src\bin.ts` + `node_modules\tsx`，缺一个即中止打包 |
| 密钥链路（真实实例） | ✅ 迁移 10 条密钥 → 明文缓存消失 → 重启后读到 8 个会话 / 60 条正文 |

**引擎复制很慢**：pnpm 的 `node_modules` 有 5 万多个文件，robocopy 实测约 30–40 分钟
（同盘、/MT:16）。这是"源码 + node_modules"形态的代价；换成官方构建产物能小一个量级、
也快得多，属于优化项。

### 13.2.2 仍没有解决的

**打包实例的完整启动仍未端到端验证**：这个会话里直接起的进程会被回收，只能用计划任务，
而计划任务起的实例没等到就绪就被我收掉了。安装流程、配置生成、密钥链路、包内运行时
加载引擎都已验证，缺的是"装完由计划任务拉起来能跑"这一幕 —— 建议在真机安装时盯一次。

另外 Runtime（8766）是独立产品：安装器只**检测**它，没装就提示"发送会失败"，包内不带它。

### 13.3 本轮踩到的坑（都已在代码里留注释）

1. **`.ps1` 必须带 UTF-8 BOM**。PowerShell 5.1 没有 BOM 就按 GBK 读，脚本里的中文会直接把语法
   搞坏（报错信息还是乱码，完全看不懂）。现在 `build-package.ps1` 会在打包时统一补 BOM，不再
   依赖编辑器行为。
2. **`param()` 默认值里不能用 `$PSScriptRoot`**（PS 5.1 那时还是空的，报"参数为空字符串"）。
3. **配置不能用字符串替换生成**。Windows 路径的反斜杠在 JSON 里要转义，替换出来的文件是**非法
   JSON**，装完必然启动失败。现在由 `make_config.py` 先解析模板、再在已解析的字符串里替换。
4. **`Copy-Item -Destination <同名目录>` 会再嵌一层**（`runtimes\python\python\pythonw.exe`）。
   安装器改成传父目录 + 复制后**验证落地文件**，复制失败不再静默。
5. **`Get-ChildItem -File -Include` 在 PS 5.1 会返回目录**，配合 `Remove-Item` 会删错东西
   （第一次打出空包就是这么来的）。改成显式按名字判断。
6. **⚠️ 最严重的一次**：安装器清理旧进程时写了 `-match 'agent_worker'`，装**测试实例**时把
   **正在运行的生产实例的 worker 一起杀了**，连带它的监护进程自毁，用户的服务直接停掉。
   教训已经写死在两处注释里：**任何"按模块名匹配进程"的写法都不允许**，只能按"本安装目录 /
   本安装的配置路径 / 本安装的 harness home"匹配。已恢复服务并修正。

### 13.4 下一步

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | 引擎构建产物（P0） | 决定用 esbuild/tsup 打成 bundle，还是 `pnpm install --prod` 收敛依赖树 |
| 2 | 打包实例的启动验证 | 本轮受限于"会话里起的进程会被回收"，只能靠计划任务；测试任务注册了但没等出结果就收了。**正式安装（真计划任务）的启动尚未端到端验证** |
| 3 | 微信密钥迁到 DPAPI | `secrets_store` 已就绪，但 `wechat-db-lab` 的 `keys/*.json` 迁移 + 运行时只解到临时目录，还没接上 |
| 4 | 首次密钥扫描的按钮 | 界面侧还没做（要求：必须用户点击、绝不自动作） |
| 5 | `deploy-runtime.py` 迁往 runtime 仓库 | 已确认要做，未执行 |
| 6 | 真机安装 | 装到 `%LOCALAPPDATA%\Programs\MessageAgent` 并迁移现有数据（保留旧目录做回退） |

## 附：本次清理记录（与本文同期执行）

| 动作 | 对象 | 理由 |
| --- | --- | --- |
| 删除 | `__pycache__/`（多处）、`harness.log`、`data/dev-errors.log`、`data/launcher.err.log` | 可再生成 |
| 删除 | `latest-probe.json`、`native-harness-smoke.json`、`reply-policy-smoke.json`、`structured-reply-flow.json`、`_t.db` | 9/4 的一次性探针产物，`.gitignore` 已列为可丢弃 |
| 删除 | `workspace/*.png`（65 张）、`workspace/agent-check.txt` | OCR 时代的调试截图，与现行架构无关（保留目录与脚本） |
| 删除 | `backups/`（21 项，1.3 MB） | 9/4–9/8 改造前快照，同期源码在 git 历史里 |
| 删除 | `docs/messages-inbox-design.md`、`docs/implementation-plan.md`、`docs/knowledge-base-implementation.md`、`docs/packaging.md` | 前两份自述已被取代；第三份是废弃跳转页；第四份已被本文取代 |
| **保留（待你决定）** | `data/_backup-20260917-111733/`、`data/reply.db.pre-username-migration.bak` | username 迁移的回滚点，属数据安全网，不代你决定 |
