# macOS 移植方案

日期：2026-10-02。状态：**方案，尚未实施**。本文里"可移植""已验证"是实测结论，
"新增""拟议"是待做的事，两者严格区分。

---

## 0. 结论

**这不是"移植"，是"重写下半身"。** 三个仓库里真正与 Windows 绑死的只有两块：
**拿微信数据库的密钥**、**通过微信界面把消息发出去**。其余部分的可移植性比预想好得多 ——
`WeChatDriver.Core` 和 runtime 核心本来就是 `net8.0`，Windows 实现全部隔离在
`providers/wechat/windows/` 下，Mac 侧是"新增一个 provider 实现"，不是推倒重来。

**最大的风险不在代码，在权限**：macOS 上读取微信进程内存拿 WCDB 密钥要跟
System Integrity Protection 和 TCC 打交道。**先把这条验掉，再决定投多少** ——
如果拿不到密钥，后面所有工作都没有意义。

建议顺序：**M0（不碰微信的骨架）→ 验密钥 → 再谈后面**。

---

## 1. 现状分层

| 部分 | 现状 | 依据 | macOS 要做什么 |
| --- | --- | --- | --- |
| harness / host 插件 / 前端（Node + TS） | 可移植 | 纯 JS/TS | 基本不动 |
| `agent_worker`（Python） | **本次已修，可在 macOS 导入** | 见 §1.1 | ✓ 无 |
| `WeChatDriver.Core` | `net8.0`，**零 Windows API** | csproj + grep | 复用 |
| `MessagingRuntime`（runtime 核心）、`MessagingRuntime.Mcp` | `net8.0`，零 Windows API | csproj + grep | 复用 |
| `MessagingRuntime.Host` | `net8.0-windows10.0.19041.0`，WPF | `DesktopApprovalNotifier.cs` | 重写（SwiftUI / Avalonia / 纯 HTTP） |
| `providers/wechat/MessagingRuntime.Providers.WeChat` + `windows/` | `net8.0-windows`，41 个文件 | UIA / 窗口抓屏 / GDI | **新增 macOS provider** |
| `wechat-db-lab` 读出与解密（`decrypt.py` / `sqlcipher4.py` / `readers.py` / `messages.py`） | 纯 Python | 无平台调用 | 复用（密钥来源要换） |
| `wechat-db-lab` 密钥提取（`winmem.py` / `keyextract.py`） | 读 Windows 进程内存 | ctypes / ReadProcessMemory | **重写（最高风险）** |
| 语音 SILK 解码 | `silk-decoder-x64.exe` | 二进制组件 | 换 macOS 版或纯 Python 解码 |
| `secrets_store.py` 凭据存储 | Windows DPAPI（`crypt32`） | 调用期才用，不挡启动 | 换 Keychain |
| `*.ps1`（安装/启动/重启） | Windows 脚本 | — | 换 bash + launchd |

### 1.1 本次已修的启动阻塞（`a305d06`）

macOS 上原来是**连 import 都过不去**，不是"功能不对"：

1. `agent_worker/process_owner.py` 顶部 `import msvcrt`（而且**根本没用到**）——
   而 `launch.py` 是无条件 `from agent_worker import process_owner` 的，一句挡住整条启动路径。
2. 同文件 `create_supervisor_job()` 里的 `ctypes.WinDLL`（macOS 上不存在）→ 现返回 `None`，
   `supervise_child()` 空操作。macOS 没有 Job Object，对应物是进程组 / launchd。
3. `launch.py` 两处 `creationflags=subprocess.CREATE_NO_WINDOW` → 改
   `getattr(subprocess, 'CREATE_NO_WINDOW', 0)`。

**验证方法**（可复现）：屏蔽 `msvcrt` 模块、`del subprocess.CREATE_NO_WINDOW` 模拟 macOS，
再 `import launch`。护栏在 `agent_worker/test_portability.py`。

注意：`__main__.py` 的单实例锁**早就是双平台**的（`os.name == 'nt'` → `msvcrt.locking`，
否则 `fcntl.flock`），不用改。别被 grep 到的 `import msvcrt` 误导。

---

## 2. 要重写的四块

### 2.1 拿密钥 + 解开数据库（最高风险，先做）

Windows 侧的做法是读微信进程内存找密钥（`winmem.py`）。
macOS 侧的已知事实（来自开源实现，实施前需自己复核）：

- **数据位置**
  - V4：`~/Library/Containers/com.tencent.xWeChat/Data/Documents/xwechat_files/<account>/db_storage/…`
  - V3：`~/Library/Containers/com.tencent.xinWeChat/Data/Library/Application Support/com.tencent.xinWeChat/<版本>/<hash>/Message/msg_0.db`
- **解密可以借用微信自己的库**：加载 `libWCDB.dylib`，用 `sqlite3_key_v2` 打开加密库 ——
  也就是说**不一定需要自己实现 SQLCipher**（我们的 `sqlcipher4.py` 在 macOS 上可能可以直接不用）。
- **取密钥的三条路线**（各有代价）：

  | 路线 | 机制 | 代价 | 参考实现 |
  | --- | --- | --- | --- |
  | A. 内存扫描 | `task_for_pid` + `mach_vm_read` 后按特征搜索 | SIP 开启时内核直接拒绝，**即使 root 也不行** | `sjzar/chatlog`（要求 `csrutil disable`） |
  | B. 重签 + sudo 扫内存 | 退出微信 → ad-hoc 重签一份影子 WeChat → `sudo` + `task_for_pid` 扫内存 | 要一次管理员密码；声称**不用关 SIP** | `r266-tech/wx-mcp` |
  | C. LLDB hook | 在 `sqlite3_key` 处断点取参数 | 会重启微信；多数情况仍要关 SIP | `yuping913/wx-cli` |

- **额外两件必做**：给可执行文件授予**完全磁盘访问权限**（否则读微信容器会被 TCC 拦，
  macOS 15+ 尤其明显）、以及 `csrutil status` 先确认 SIP 状态。

- **一个流传很广但需要验证的说法**：有人说"微信的库密钥是账号级的，Windows 上取的能用在
  macOS 上"。**我不信这个说法** —— SQLCipher 的库密钥通常是每台设备本地生成的。
  但值得花半小时验一下：**如果能用，整个 macOS 版本的成本会塌掉一大截。**
  这是全局性价比最高的一次实验。

### 2.2 发消息（UI 自动化）

`WeChatDriver.Core/Interfaces.cs` 已经把边界划好了，macOS provider 要实现的就这几个：

```
IWindowAutomationBackend   窗口/控件定位与输入
IConversationIndex         会话定位
IActionExecutor            动作执行（含重试/幂等）
IAgentBridge               与上层 worker 的通道
IApprovalUi                需要人确认的界面
ILocalStore                本地持久化
```

macOS 侧对应物：**AXUIElement**（辅助功能 API，读控件树）+ **CGEvent**（合成键鼠）。
代价：
- 需要用户在「系统设置 → 隐私与安全性 → 辅助功能」里授权，否则一律失败；
- 微信 macOS 版是自绘界面，控件树可能远不如 Windows 版给得全 —— **这一条要先探一次**，
  用 Accessibility Inspector 看一眼微信窗口的 AX 树就知道可行性。

建议目录结构（与 Windows 平行）：
```
src/providers/wechat/
  macos/
    WeChatDriver.AX/          # AXUIElement 封装
    WeChatDriver.Macos/       # 平台胶水
  windows/                    # 原样保留
```

### 2.3 语音 SILK 解码

`silk-decoder-x64.exe` 换成：
- 编译一份 macOS 版 SILK 解码器（Skype 的 SILK SDK 是 C，能编）；或
- 纯 Python 实现（如 `pilk`），省掉二进制分发。
解码后的 wav → whisper 那一段**本来就是 Python**，`faster-whisper` 在 macOS 上装得上
（含 Apple Silicon 的 arm64 wheel）。注意 `av<19` 那个钉版本要一并带过去。

### 2.4 凭据存储与启动

- `secrets_store.py`：DPAPI → **Keychain**（Security.framework，可用 `ctypes` 调，
  或用 `keyring` 库）。接口形状（存/取/删）不用变。
- 启动链：`install.ps1` / `open.ps1` / `restart.ps1` → `bash` 脚本 + **launchd plist**
  （`KeepAlive` 承担现在 `launch.py` 里那套 supervisor 循环）。
  `launch.py` 本身是 Python，逻辑可留，只把平台分支补上。

---

## 3. 阶段与验收

| 阶段 | 内容 | 验收标准 |
| --- | --- | --- |
| **M0** 骨架跑起来 | 在 Mac 上跑 harness + agent_worker + 前端，收发与读库留空实现 | 界面能打开、"和助手聊聊"能用；消息页显示"当前平台未接入"而不是崩 |
| **M0.5** 密钥可行性 spike | 只验 §2.1 的路线 A/B/C 与"跨平台 key"那个说法 | **能稳定拿到一把 key 并解开一个库**。拿不到就停下来重新评估 |
| **M1** 读路径 | 密钥 + 解密 + `wechat-db-lab` 只读查询 + 消息页真实数据 | 群里能正确显示发送者、时间、语音转文字（Windows 上这两天修的那些行为都要成立） |
| **M2** 发路径 | AXUIElement + CGEvent + 审批 UI | 能在一对一会话里发出并确认送达；`FailureCode` 在 macOS 上有对应语义 |
| **M3** 语音 | SILK 解码 + faster-whisper | 语音能转成文字，失败时界面说清原因（不要回到"一直正在转写着"） |
| **M4** 安装与守护 | launchd + Keychain + 打包 | 双击安装、开机自启、崩溃自拉 |

**M0 和 M0.5 的顺序是刻意的**：M0 不碰微信，风险为零，而且能顺带验证除微信之外的所有环节；
M0.5 一票否决权最大，越早验越好。

---

## 4. 代码改动清单

```
message-agent/
  launch.py                     改（平台分支：supervisor / 路径 / pythonw）
  agent_worker/process_owner.py 改（已改：非 Windows 降级）
  agent_worker/secrets_store.py 改（DPAPI → Keychain）
  agent_worker/voice.py         改（解码器路径按平台）
  packaging/*.ps1               新增 macOS 对应脚本
  install.ps1 open.ps1 restart.ps1  保留（Windows 继续用）

messaging-runtime/
  src/host/…                    改（WPF 审批 UI → 跨平台）
  src/providers/wechat/macos/   新增（AXUIElement + CGEvent 实现）
  src/providers/wechat/windows/ 不动
  src/runtime/ src/mcp/ WeChatDriver.Core/  不动

wechat-db-lab/
  src/wechat_db_lab/darwin/     新增（进程定位 + 内存扫描 + SIP 判定）
  src/wechat_db_lab/wcdb.py     新增（libWCDB + sqlite3_key_v2 打开加密库）
  decrypt.py sqlcipher4.py      保留（Windows 路径继续用；macOS 可能改用 WCDB）
  readers.py messages.py vault.py  改（数据根探测按平台）
  winmem.py keyextract.py       不动（Windows 专用）
```

---

## 5. 风险（按严重程度）

1. **拿不到密钥**（SIP / TCC / 微信加固）。→ 整个计划作废。**用 M0.5 一票否决。**
2. **微信 macOS 版的 AX 控件树太稀疏**，自绘界面下定位不到输入框/发送键。
   → 退路是 CGEvent 坐标点击 + 截图 OCR（Windows 侧已经有 OCR 那套经验）。
3. **依赖第三方闭源二进制**（`libWCDB.dylib`）有版权与分发问题 —— 只本机用，
   不要进仓库（`wx-mcp` 也是这么处理的）。
4. **TCC 反复弹窗**（macOS 15+ 访问其他 App 容器），需要一次性授予完全磁盘访问。
5. 账号两地同时登录的**策略风险**：同一账号在 Windows 与 macOS 同时在线可能被限制，
   这点在动手前要确认。

---

## 6. 第一步（建议）

**M0.5 的那次实验**，具体到可执行动作：

1. 在 Mac 上 `csrutil status` 看 SIP；把微信升到与 Windows 同一个 4.x 版本，登录同一账号，
   打开至少一个会话（密钥要出现在堆里才可能被扫到）。
2. 用现成工具分别试路线 A（`chatlog`）与 B（`wx-mcp`），记录：**能不能拿到 key、要什么权限**。
3. **单独验一次**："Windows 上取到的 key 能不能解开 macOS 上的库"。
   —— 半小时的实验，可能省掉一半工作量。
4. 拿 Accessibility Inspector 看一眼微信主窗口的 AX 树，判断 §5.2 的风险有多大。

这四步做完，M1 之后的工作量才有意义去估。

---

## 附：这份文档的立场

- 不把"可移植"说成"已经能跑"：M0 之前的代码只在 Windows 上验证过。
- 不假装 macOS 的权限问题是"配置一下就好"：这块确实可能做不成。
- 不引用未验证的说法当结论（§2.1 里那个"跨平台 key"就明确标成待验）。
