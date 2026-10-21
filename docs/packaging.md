# 打包与交付

**一句话**：`build-package.ps1` 一条命令把产品、引擎、自带运行时、消息运行时组装成一个 zip；
客户双击 `MessageAgent-Setup.cmd` 免解压一键安装；日常发版用 `-AppOnly` 小包（几 MB）。

体积基线（2026-10 实测，引擎裁剪后）：完整包 **845 MB** → zip **316 MB**；
客户机解压 **23 秒**、干净安装 **20 秒**、启动到 health READY **约 20 秒**。

---

## 一、流程总览

```
deepseek-harness 源码仓                message-agent 仓                    客户机
─────────────────────                ────────────────────               ───────────────
build-engine-deploy.ps1    ─┐
  pnpm build + deploy        │   build-package.ps1 -MakeZip
  flatten + prune（自动）    ├─▶  自动再 prune（幂等）      ─▶  zip + Setup.cmd  ─▶  双击 Setup.cmd
（仅引擎更新时跑）           ┘   产出 packaging\out\*.zip                          install.ps1 自动跑
messaging-runtime                （+ 527MB 消息运行时）
tools\package.ps1
-SelfContained（仅更新时跑）
```

| 环节 | 命令 | 什么时候跑 |
| --- | --- | --- |
| 构建引擎部署目录 | `packaging\build-engine-deploy.ps1` | **仅引擎上游变化时** |
| 构建消息运行时 | `messaging-runtime` 仓里 `tools\package.ps1 -SelfContained` | **仅 messaging-runtime 变化时** |
| 完整打包 | `packaging\build-package.ps1 -MakeZip -SkipHashes -EngineRoot <web-deploy目录>` | 对外发版 |
| 升级小包 | `build-package.ps1 -AppOnly -MakeZip` | **日常产品代码发版**（客户已有完整包） |

---

## 二、一次性 / 偶发准备

完整包**自带一切**：引擎（202 MB，已裁剪）、Node v22.23.0、Python 3.13.12 embeddable、
消息运行时（527 MB，自包含 .NET）、语音解码器。前三样打包脚本自己会备齐：
Node/Python 缺了会自动下载并缓存在 `%TEMP%`；消息运行时自动找
`..\messaging-runtime\artifacts\packages\` 下**最新**一份；silk 解码器已入库
（`packaging\components\silk\`，install.ps1 硬要求，缺了打包直接中止）。

**引擎部署目录**（`-EngineRoot`）是唯一需要先准备的东西：

```powershell
# 在 message-agent 仓里跑；引擎仓默认取 ..\deepseek-harness
powershell -ExecutionPolicy Bypass -File packaging\build-engine-deploy.ps1
# 产物：deepseek-harness\artifacts\web-deploy\（lib\bin.js 在根部，自包含、无符号链接）
# 引擎代码没变、只是想重新拍平时加 -SkipBuild 跳过 pnpm build
```

它会 `pnpm build` → `pnpm deploy --prod`（依赖闭包）→ `flatten_engine_modules.py`
拍平符号链接 + 补齐运行时闭包 + **裁掉 dev 工具链**（见 §五）。上游引擎更新后必须重跑，
否则打包用的是旧引擎（打包只认目录内容，不检查新鲜度）。

---

## 三、完整打包

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build-package.ps1 -MakeZip -SkipHashes `
  -EngineRoot C:\Users\<你>\Documents\projects\deepseek-harness\artifacts\web-deploy `
  -LogTo packaging\out\build-log.txt
```

产物在 `packaging\out\`：

| 文件 | 说明 |
| --- | --- |
| `MessageAgent-0.1.0-win64.zip`（316 MB） | **发给客户的单文件** |
| `MessageAgent-Setup.cmd` | 一键安装器，与 zip **放同一文件夹**交付 |
| `package\`（845 MB） | 解开的完整包（zip 的内容源），本地装测试可直接用它的 install.ps1 |

常用参数：

| 参数 | 作用 |
| --- | --- |
| `-EngineRoot <目录>` | 引擎部署目录；不传则自动找 `..\deepseek-harness\artifacts\web-deploy` |
| `-MakeZip` | 产出单文件 zip（对外发版必加） |
| `-SkipHashes` | 跳过 manifest 全量 SHA256。有按（路径+大小+mtime）的缓存，重复打包大多命中，但引擎/运行时首算仍要数分钟；**要给客户做完整性校验时去掉它** |
| `-AppOnly` | 升级小包，见 §四 |
| `-ForceEngine` | 旧流程（源码仓打 tar）里强制重打引擎归档用 |
| `-RuntimePackage` | 显式指定 messaging-runtime 产物目录（默认自动找最新） |
| `-LogTo` | transcript 落文件；构建常放计划任务里跑，务必带上 |

耗时构成（同机实测）：引擎复制 ~1 分钟、zip 压缩 **~4.5 分钟**（Windows 自带 bsdtar 单线程
deflate，845 MB → 316 MB，这是目前最大的一块；后台跑时**别在同一终端并发起其它长命令**，
实测会误杀 tar 并留下半成品 zip，脚本会自愈但最好一次跑完）。

### 打包脚本做了什么（按顺序）

1. 清空旧包（长路径安全：robocopy 空目录镜像，`Remove-Item` 对超长路径不可靠）；
2. 复制产品本体（`plugin/ agent_worker/ presets/ launch.py` 等，剔 `__pycache__`/`*.pyc`）；
3. 备齐 Node/Python 运行时，改 embeddable 的 `._pth`（否则 worker 找不到 `agent_worker`）；
4. 拷贝 silk 解码器与消息运行时；
5. **裁剪引擎**（自动 `--prune`，幂等）+ robocopy 引擎 + 计算引擎指纹（lib 文件哈希）；
6. 复制安装脚本并统一 UTF-8 BOM（PowerShell 5.1 无 BOM 会把中文 .ps1 读成 GBK 直接语法错误）；
7. 生成 `manifest.json`（版本、引擎指纹、Node/Python 版本、文件哈希清单）；
8. `-MakeZip`：把 `package\` 临时改名压成 zip 再改回（zip 内路径是产品名）。

---

## 四、发版给客户

### 完整包（新客户 / 引擎或运行时更新）

把 **`MessageAgent-Setup.cmd` + `MessageAgent-0.1.0-win64.zip`** 放进同一个文件夹，
整个文件夹发给客户。客户只需：

> 双击 `MessageAgent-Setup.cmd` → 自动解压（约 23 秒）→ 自动进安装向导。

（客户手动解压 zip 后双击 `install.cmd` 也等效；详见 `packaging\README-install.md`，
那是给客户的操作说明，可随包交付。）

install.ps1 全自动完成：环境/端口检查 → 装消息运行时 → 展开
`%LOCALAPPDATA%\Programs\MessageAgent` → 生成运行配置 → 问一次模型 key（DPAPI 落盘）→
注册登录自启（计划任务 `Message Agent`）+ 桌面「消息助手」→ 启动并 health check → 开页面。
支持静默参数（企业分发）：`-Silent -CloudKey -ModelKey "sk-..."` 或 `-Silent -ModelLater`。

### 带解锁的整合包（试用客户）

按客户类型二选一发：

| 客户 | 发什么 |
| --- | --- |
| 已有已解锁目录 / 自助解锁（用 `docs/self-unlock-prompt.md` 让客户自己的 Agent 产出） | `MessageAgent-<版本>-win64.zip`（本仓产物，**不含**任何解锁代码） |
| 需要你提供解锁能力的新客户 | `消息助手-试用版-<版本>.zip`（见下，**一个包全含**） |

整合包在**私库 `wechat-db-lab`** 那边组装（授权与私钥不能进本仓的公开打包流程）：

```powershell
# 1. 解锁工具母包（自带 Python + 依赖 + 授权体系；-Trial 是字节码试用形态）
cd <wechat-db-lab>
powershell -ExecutionPolicy Bypass -File build-package.ps1 -Trial -MakeZip

# 2. 合成：MessageAgent zip + 解锁包 → 一个压缩包 + 客户唯一入口 开始使用.cmd
powershell -ExecutionPolicy Bypass -File assemble-trial.ps1 `
  -AgentPackage <message-agent>\packaging\out\MessageAgent-0.1.0-win64.zip `
  -UnlockPackage out\<...>\wechat-db-lab-unlock -MakeZip

# 3. 按客户签码（不重打包，几秒）：产出 注册码-<客户>.txt，连同母包两个文件发客户
powershell -ExecutionPolicy Bypass -File new-customer.ps1 -Customer "某某公司" -Days 14
```

客户体验：解压 → 开着微信双击 `开始使用.cmd` → 粘一次注册码 →
自动"解锁 → 装助手 → 把产物路径写进 unlocked_root → 启动开页面"。

> 同步纪律：MessageAgent zip 更新后要**重新合成**（assemble-trial 复制的是当时那份 zip）；
> 引擎或脚本没变时不用重打，直接用旧合成包发码即可。

### 升级小包（日常发版，推荐）

```powershell
powershell -ExecutionPolicy Bypass -File packaging\build-package.ps1 -AppOnly -MakeZip -SkipHashes
```

产出 `MessageAgent-app-0.1.0-win64.zip`（几 MB：只有产品本体 + 脚本）。
**前置**：之前跑过一次完整打包（指纹记在 `packaging\.cache\last-full-build.json`）。
客户拿到后照常跑 install.ps1：程序文件更新，引擎/运行时校验版本一致就**沿用不重装**，
数据（`%LOCALAPPDATA%\MessageAgent`）一律保留。`-SkipHashes` 不影响小包校验——
它复用上次完整构建记录的引擎指纹。

> 引擎或 Node/Python 变了**不能用小包**，必须发完整包（install.ps1 检测到版本不一致会拒绝并提示）。

### 升级后引擎要不要重装，怎么判

install.ps1 比对 `manifest.json` 里的引擎指纹与客户机 `.install-info.json` 记录：
一致 → 跳过 202 MB 搬运；不一致 → 清空旧引擎再复制（避免新旧混杂）。全自动，无需人工干预。

---

## 五、体积为什么可控（裁剪机制）

历史教训：曾经引擎 545 MB / 45,700 个文件，打包、解压、安装全线为其中约一半的
**dev 工具链**买单（mermaid 80MB、@rolldown 30MB、typescript 23MB、oxlint、vitest、
jsdom、eslint 全家、@aws-sdk…）。来源是 pnpm deploy 的隐藏 hoist 层把整个 workspace 的
dev 依赖提升进了部署目录，拍平脚本照单全收。

现在的防线（全在 `packaging\flatten_engine_modules.py`）：

- `RUNTIME_EXCLUDE` 黑名单：只收"机制上不可能被运行时加载"的包（构建/lint/测试工具链、
  纯 `.d.ts` 类型包、已 bundle 进前端 dist 的图表库、运行时零引用的 @aws-sdk）。
  koffi、sharp、@opentelemetry、@lexical、@xterm、@vscode-ripgrep、octokit 等
  **运行时引用的一律不在名单**；
- `--prune` 就地裁剪：黑名单 + 保守孤儿清理（"引用者全灭"才删；
  `@deepseek-ai/*` 引擎自家包豁免；根引用 = deploy 根 package.json + 插件清单 +
  `lib/*.js` 静态 import，防止误删动态加载目标）；
- `build-package.ps1` 打包前自动 prune（幂等，第二次起秒级），`build-engine-deploy.ps1`
  构建后也兜一遍 —— 换哪台机器打包都不会退化。

改黑名单的规矩：**先跑反向依赖分析**（谁在运行时方向引用它）再动手；
裁完必须过 §六的启动验收。两处删除实现都用 `\\?\` 长路径前缀 ——
`shutil.rmtree(ignore_errors=True)` 对超长路径**静默失败**，实测报"删了 166 个包"
实际一个没删。

实测收益：引擎 545→202 MB、45,714→22,128 个文件；包 1,189→845 MB；zip 423→316 MB；
客户机解压从分钟级降到 23 秒。

---

## 六、发版前验收（5 分钟，必跑）

在干净目录模拟客户全程，**比检查 zip 大小更可靠**：

```powershell
# 1. 计时解压（等同 Setup.cmd 的 tar -xf，应在半分钟量级）
tar -xf packaging\out\MessageAgent-0.1.0-win64.zip -C <空目录>

# 2. 静默装到临时位置（不动系统注册表和计划任务）
powershell -ExecutionPolicy Bypass -File <解压目录>\install.ps1 `
  -Silent -ModelLater -NoTask -NoStart `
  -InstallDir <临时安装目录> -DataDir <临时数据目录> -RuntimeRoot <临时运行时目录>

# 3. 启动 + health（token 在 <临时数据目录>\data\control.token）
$env:MESSAGE_AGENT_CONFIG = '<临时安装目录>\config.json'
& <临时安装目录>\runtimes\python\python.exe <临时安装目录>\app\launch.py   # 后台跑
# 轮询 http://127.0.0.1:3080/message-agent/health（Bearer <control.token>），
# ready:true 即通过；测完按安装路径杀进程、删临时目录
```

任何一步回归都说明裁剪名单或引擎闭包出了问题，别发版。

---

## 七、速查

| 问题 | 答案 |
| --- | --- |
| 客户安装慢/解压慢？ | 前提是用了裁剪后的引擎（§五）。解压走 Setup.cmd 的 tar，比资源管理器拖 zip 快且不怕长路径 |
| 打包想更快？ | zip 是最后一块耗时（bsdtar 单线程）；-SkipHashes 该开就开；引擎没变时 `-AppOnly` 秒级 |
| 缓存在哪？ | `packaging\.cache\`：`last-full-build.json`（小包前置）、`file-hashes.json`（哈希缓存） |
| 手动清目录删不掉？ | 长路径/链接用空目录 robocopy /MIR 镜像后删（Clear-Dir 同款做法） |
| 版本号在哪改？ | `build-package.ps1` 里 `$version = '0.1.0'`（写 manifest 与 zip 名） |
| 客户排障文档？ | `packaging\README-install.md`（随包交付的说明书） |
