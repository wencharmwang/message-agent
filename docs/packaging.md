# Message Agent 单产品交付设计

日期：2026-09-09。状态：架构决策；尚未构建安装包。界面工作先按 [实施计划](implementation-plan.md) 推进。

## 1. 交付决策

Message Agent 拥有一个安装入口、一个启动入口和一套版本清单。Harness 纳入 Message Agent 的固定版本依赖，用户无需另外获取或更新它。Messaging Runtime 保持独立源码、版本、协议与 MCP 使用方式；产品默认附带兼容 Runtime 发行物，也支持连接已安装的兼容公共实例。

开发可暂用目前的三个目录，但必须显式区分开发依赖路径与生产发行物路径。新增代码不可继续引入 `C:\Users\Wencharm\...`、跨目录 `packages/**/src` import 或依赖兄弟目录的脚本。正式包不使用外部 `deepseek-harness` 文件夹、pnpm 工作区链接或用户 PATH 中的 tsx。

## 2. Harness 如何包含进来

推荐在 Message Agent 中维护 `vendor/deepseek-harness` 的固定源码快照，附 upstream revision、来源、补丁清单和更新说明。这里是后续源代码组织决策，当前尚未复制目录。使用普通受版本控制的快照，使单个仓库归档即可取得源码；不要求用户初始化 Git submodule。源代码中内置引擎并不意味着安装包复制整个源码树。

更新流程为：取得指定上游版本 → 应用有限 UI 扩展补丁 → 验证适配接口、会话格式和客户端协议 → 构建 → 固定清单。源码导入前先检查是否有未提交修改，并保留现有修复，不用整目录覆盖开发中的 Harness。

生产使用 Harness 已构建的 `dsh` profile 入口与其必需 npm 依赖、客户端资产、插件清单、配置和资源。具体产物收集范围以固定版本构建输出验证为准；不能假设一个 Node bundle 就包含动态 Cordis 插件、原生模块与所有 Web 文件。

`plugin/index.mjs` 中 SessionId、createUserMessage、defineTool 的三处源码 import 改为已声明的包导出，通过构建依赖解析；源码与生产均遵守相同包边界。开发期可指向固定版本已构建包，但只在 dev 配置里声明。验收必须在不含外部源码路径的目录中启动并恢复会话。

## 3. 建议安装与数据结构

```text
Message Agent 安装目录/
  MessageAgent.exe                 # 后续统一启动器，当前不是已有文件
  app/                            # 产品 Host、Worker、预设、界面资产
  engine/harness/                 # 已构建引擎和所需插件依赖
  runtimes/node/                  # 与引擎兼容的运行时
  runtimes/python/                # Worker 所需运行时
  components/messaging-runtime/   # 默认配套的 Runtime 发行物
  licenses/                      # 第三方许可与声明
  manifest.json                  # 组件版本、协议版本、哈希、平台

%LOCALAPPDATA%/MessageAgent/
  config/                        # 产品设置、解析后的本机配置
  credentials/                   # 本机生成凭据，不进入发行物
  data/                          # reply.db、drafts.db、后续 business.db
  harness/                       # 原 .harness 会话状态
  workspace/                     # 产品管理的默认工作区
  logs/
  backups/

Messaging Runtime 自有数据目录/
  消息快照、策略、发送回执、授权、审计
```

安装目录可只读，升级不覆盖用户数据。Runtime 数据继续由该实例管理，不复制到产品库。Worker 和 OCR 的 Python 可在兼容性验证后共用发行物；在依赖冲突尚未查明前保留各自运行环境，不能为减少文件数量破坏 OCR。单个产品允许内部有组件目录，用户无需管理它们。

## 4. 公共 Runtime 的两种模式

| 模式 | 启动与停止 | 配置与数据 | 适用场景 |
| --- | --- | --- | --- |
| managed | 产品启动自己安装和拥有的实例；只停止自己拥有的进程 | 为实例独立配置、生成本产品凭据 | 首次安装、没有既有 Runtime |
| external | 连接已有实例；不代替其他客户端关闭或升级 | 通过显式接入配置/凭据引用连接 | 已有公共 Runtime，其他 Agent 同时使用 |

启动先探测实例身份、版本和能力；若现有 Runtime 尚无完整版本/能力握手，列为打包阶段新增项，不靠“端口能连通”认领实例。已有实例兼容且获授权时复用；不兼容或目标 provider 已被占用时清晰提示，不并行启动第二个驱动争抢同一微信窗口。

产品停止不能结束 external Runtime。managed 实例若允许其他 Agent 共享，其所有权应升级为独立服务管理，不能继续按普通子进程退出策略关闭；第一版 managed 默认仅供本产品，跨 Agent 共享选择 external 模式。公共 MCP 继续只提供消息能力，审批管理凭据与 MCP 客户端凭据分离。

## 5. 统一路径与启动

引入一次性路径解析对象，至少包含 installRoot、dataRoot、harnessEntry、nodeExecutable、pythonExecutable、runtimeMode、runtimeEndpoint、credentialRefs。优先级为显式启动参数 → 本机配置 → 安装清单默认值；仅 dev 模式接受外部源码根目录覆盖。

发行清单存相对安装路径；启动器把它们解析为绝对路径再交给现有 Worker，兼容其当前绝对路径校验。不要要求所有内部接口都改为相对路径。所有子进程使用明确 cwd、参数数组和隐藏窗口，不依赖启动器从哪个目录运行。

后续启动流程：加载并校验清单 → 初始化数据/凭据 → 连接或启动 Runtime → 检查能力 → 启动 Harness 产品 profile → 等消息插件健康 → 启动 Worker → 打开已认证本地页面。端口冲突需报告或由一个配置源重新分配，不能 profile 仍硬编码 8766 而启动器连接别处。

当前 `launch.py` 已有 Windows 进程树托管和插件健康等待，继续复用；补充启动失败时清理已创建的自有进程、服务退出诊断与显式重启策略。Worker 当前异常日志使用源码父目录推导 Runtime 路径，也需迁入统一 dataRoot。

第一版保持浏览器访问本地 Web。Windows 桌面外壳后续决定；引入外壳不应改变业务 API、会话数据或 Runtime。暂不为外壳同时维护两套前端。

## 6. 构建与发布门槛

拟议流水线：固定依赖与引擎版本 → 构建 Harness Host/Web → 构建产品插件 → 收集运行依赖 → 引入已发布 Runtime/OCR 组件 → 装配 staging → 在隔离目录验证 → 生成安装包与清单。

可复用 Runtime `tools/package.ps1` 作为组件产物起点，但它现在调用 publish 并复制 Python，不据此认定已实现无 .NET 前置依赖的完整安装包。发布前须验证 .NET self-contained 或明确内置所需 runtime，并验证 OCR 模型、资源及路径都齐全。

| 必须通过的检查 | 通过条件 |
| --- | --- |
| 独立启动 | 临时隔离安装位置，无三个开发目录、无 Node/Python/.NET SDK/Pnpm 依赖仍能运行 |
| 路径迁移 | 带空格/中文的目录可用；从任意 cwd 启动；只读安装目录可用 |
| 真实组合 | 产品 UI、动态插件、MCP、会话恢复、工具卡片均使用发行物 |
| 状态保护 | 升级保留规则、历史、凭据引用、发送幂等记录；待确认消息不会自动发送 |
| Runtime 共享 | external 实例不被停止/覆写；同 provider 不出现重复驱动 |
| 包清洁 | 不含 .env、token、用户数据库、聊天记录、日志、工作区和开发机配置 |
| 组件追溯 | 引擎 revision、补丁、运行时版本、组件哈希及许可声明齐全 |

## 7. 迁移、升级与回退

迁移先停止本产品监听并确保没有进行中的发送；按 SQLite 一致性备份方式处理 WAL 数据库，不能只复制正在写入的 `.db`。复制现有 `data/reply.db`、会话绑定、`.harness`、必要工作区和配置到新 dataRoot，重新解析本机路径并验证恢复；保留旧数据直到验证完成。Runtime 数据不搬迁，除非用户单独选择迁移其服务。

Harness 会话 header 和工作区绑定可能含旧绝对路径。首版迁移可保留原工作区路径以恢复旧会话；迁移工作区时必须使用经验证的会话迁移程序，不批量字符串替换日志。现有插件会校验 workspace 与 preset 身份，这一校验应纳入迁移测试。

升级先写入新版本目录，健康检查通过后切换入口；组件或数据格式不兼容则阻止启动。Harness 本机 AGENTS 明确其预发布会话格式没有兼容保证，所以固定引擎版本并在升级前验证旧会话，不承诺任意上游版本可直接恢复。

回退程序版本前检查数据库/会话格式兼容性；必要时从对应一致性备份恢复产品数据。任何回退都不把 Runtime 的 sent/uncertain 记录删除或改成待发送，不重用旧自动任务触发重复发送。卸载默认保留用户数据，清理数据需要独立明确操作。

## 8. 本轮结论

已确定代码归属、组件内置方式、开发/生产路径分离、Runtime 复用语义和发布门槛。尚未实现 vendor 导入、构建装配、安装器、路径迁移或桌面外壳；这些在界面验收之后分步实施。
