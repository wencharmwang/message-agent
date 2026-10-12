# 自己准备数据：给你的 Agent 的提示词

本项目**只读**一个「已解锁数据库目录」，自己不解锁。
如果你选择自己准备这份数据，可以把下面的提示词整段复制，发给你自己的编码 Agent
（Claude Code / Cursor / WorkBuddy / 任意能在这台机器上执行命令的 Agent）。

> 提醒：这套做法只在 **Windows** 上可行，且只应处理**你自己的数据**（你自己的机器、你自己的账号）。

---

## 提示词 ①：准备数据

```
在这台机器上帮我准备好 message-agent 要读的数据。

【目标】
产出一个「已解锁数据库目录」，让 message-agent 能直接读消息。
产物目录的最终路径告诉我，我会自己去配置里填。

【产物必须满足（缺一不可）】
1. 目录里有 manifest.json，manifest_version = 1；
   databases[] 里每项要有：
     - rel：db_storage 下的相对路径（例如 "message/message_0.db"）
     - output：解出来的明文库的绝对路径
     - source：源库的 size 与 mtime_ns（用于判断产物是否落后）
2. 必需库：contact/contact.db、session/session.db、message/message_*.db、
   message/message_resource.db、message/media_*.db
3. **必须把 WAL 合并进去**：主库只到上一次 checkpoint，不合并就缺最近的消息。
4. 一次解锁产出一批**一致**的库（同一时间点），不要把不同批次混在一起。
5. 每个库都是标准明文 SQLite —— 文件头必须是 "SQLite format 3\0"。
6. 全程**只读**源数据：不要改微信的文件、不要注入进程、不要动微信界面。

【协议全文】
docs/unlocked-db-protocol.md —— 以它为准，有冲突以它为准。

【可以参考】
公开项目 wxauto-replica（第三方项目，不是本项目提供的）。

【做完必须自检，并把输出给我看】
把 <产物目录> 换成你实际产出的路径，运行：

python -c "import sys; sys.path.insert(0,'.'); from agent_worker.unlocked_source import UnlockedSource as S; s=S(r'<产物目录>'); print('ready:', s.ready()); print('detail:', s.last_error())"

ready 必须是 True。
如果是 False，就照着 detail 里那句话去修（它会说缺哪个库、哪个库不是明文），别猜。

【边界】
这件事请你只在这台机器上、针对我自己的账号做。
做完不要自己启动 message-agent —— 把产物目录路径给我，我自己配。
```

---

## 提示词 ②：产物不对劲时排障

（当自检 `ready` 返回 False，或者项目起来后读不到消息时用）

```
message-agent 读不到数据，帮我按下面的顺序排查，每步把结论告诉我，不要跳步。

前提：产物目录 <产物目录>，项目目录 <项目目录>。

第 1 步：跑自检
  python -c "import sys; sys.path.insert(0,'.'); from agent_worker.unlocked_source import UnlockedSource as S; s=S(r'<产物目录>'); print('ready:', s.ready()); print('detail:', s.last_error())"
  - 如果 detail 说"缺少必需库"：按它列的库名去补产出。
  - 如果 detail 说"不是明文库"：那个库没解开，或者被截断。
    常见原因是**没有合并 WAL**，或者只解了主库就停了。

第 2 步：如果 ready 是 True 但项目里看不到消息
  - 确认 config.json 里的 unlocked_root 指向的就是 <产物目录>（要绝对路径）。
  - 确认协议里的 data 目录层级是 plain/ 下按 db_storage 的相对路径摆放。
  - 确认产物不是过期的旧批次（manifest.json 的 created_at）。

第 3 步：如果消息内容显示成 "[文本]" 这类占位
  - 那是压缩内容没解出来的表现，产物本身没问题 —— 告诉我，我来处理。

第 4 步：如果换了账号、或者原来能读现在读不到
  - 说明数据源变了（换了账号 / 重新登录 / 数据被重建），
    旧产物不再对应。需要重新产出一份新的。

每步的原始输出都贴给我看，不要只给结论。
```

---

## 产物合格的判定标准（唯一标准）

不看别的，就看这一条：

```bash
python -c "import sys; sys.path.insert(0,'.'); from agent_worker.unlocked_source import UnlockedSource as S; s=S(r'<产物目录>'); print(s.ready(), s.last_error())"
# 期望输出：True
```

`ready()` 是 True 就说明：manifest 版本对、必需库齐、每个库都是明文 SQLite。
这也是本项目启动时会做的同一套校验 —— **客户自检和程序自检用的是同一段代码**，
所以不会有"自检过了但程序还挑毛病"的情况。
