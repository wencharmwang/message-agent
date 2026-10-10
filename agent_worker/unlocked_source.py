"""增量消息来源：直接轮询**已解锁的数据库目录**。

这是 `watcher_source.py` 的替代品。旧方案是起一个 python 子进程跑 wechat-db-lab 的
``watch`` 命令 —— 而那个命令**每轮自己解锁**（读进程内存、取密钥、页解密、合并 WAL）。
本项目不碰解锁，所以这一层改成"就地读产物"：

    旧：子进程 → vault.unlock() → KnowledgeBase → ndjson → 反序列化 → 事件
    新：               UnlockedSource → KnowledgeBase → 事件

**事件字段与旧协议逐字一致**（见 `MessageEvent`），所以 worker 侧的解析一行都不用改。

产物要求见 `docs/unlocked-db-protocol.md`。几条与旧实现一致的语义，改动会破坏功能：

* 首次 ``poll()`` **只建基线、不产出事件** —— 否则上线瞬间会把历史消息当新消息回一遍；
* 游标是"时间窗口 + ``(username, local_id)`` 去重"，窗口 ``overlap_seconds`` 默认 10s；
* 每轮 poll 都会**关掉上一轮的只读连接再重开** —— 外部解锁方会覆盖 ``plain/*.db``，
  Windows 下持着句柄会挡住它写入（旧实现踩过这个坑，注释还在 watcher.py 里）；
* 只读连接（``mode=ro``），不改动产物。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .wechat_reader import KnowledgeBase

# 会话列表单次读取上限。一般微信会话远小于此；超过则只监听最近活跃的一部分。
SESSION_LIMIT = 500
# 每次 poll 取某个会话最近消息的条数上限。
CONVERSATION_LIMIT = 200
# 协议里的"必需库"：缺了它们产品无法工作。
REQUIRED_KINDS = ("contact", "session", "message")
SQLITE_MAGIC = b"SQLite format 3\x00"


class UnlockedRootError(RuntimeError):
    """产物不可用。消息会直接显示给用户，所以要写清"缺什么、怎么办"。"""


@dataclass
class MessageEvent:
    """一条新消息。字段含义与 :meth:`KnowledgeBase.conversation` 对齐。"""

    username: str          # 会话 username（wxid / 群 chatroom id）
    display: str           # 会话显示名（remark > nick_name > username）
    direction: str         # "incoming" | "outgoing"
    sender: str            # 发送者显示名（群消息里是成员，非群等于会话名）
    text: str              # 已解码正文；非文本消息为 "[类型]" 占位
    local_type: Any        # 原始消息类型 id
    type_name: str         # 类型中文名
    create_time: int       # unix 秒
    sort_seq: Any          # 全局排序号（可能为 None）
    local_id: Any          # 会话内消息 id（可能为 None）

    def as_dict(self) -> dict:
        # **字段名不要改**：worker 的 _ingest/_canonical 按这些键取值。
        return {
            "username": self.username,
            "display": self.display,
            "direction": self.direction,
            "sender": self.sender,
            "text": self.text,
            "local_type": self.local_type,
            "type": self.type_name,
            "create_time": self.create_time,
            "sort_seq": self.sort_seq,
            "local_id": self.local_id,
        }


class UnlockedSource:
    """把"已解锁目录"当成消息来源。接口与旧的 WatcherSource 对齐（drop-in）。"""

    def __init__(
        self,
        unlocked_root: str | Path | None,
        *,
        interval: float = 3.0,
        overlap: int = 10,
    ) -> None:
        # interval 保留只为签名兼容：现在由 worker 的 tick 驱动 poll，这一层不再自己计时。
        self.interval = interval
        self.unlocked_root = Path(unlocked_root) if unlocked_root else None
        self.overlap_seconds = max(1, int(overlap))

        self._kb: KnowledgeBase | None = None
        self._workspace_path: Path | None = None
        self._last_poll_time: int = 0
        # 去重键 (username, local_id) -> create_time，用于滑动窗口清理。
        self._seen: dict[tuple[str, Any], int] = {}
        self._validated: bool = False
        self._manifest_created_at: str | None = None
        self._error: str = ''
        self._closed: bool = False

    # ------------------------------------------------------------------
    # 产物校验（协议里承诺的检查项）
    # ------------------------------------------------------------------
    def validate(self) -> dict:
        """校验 `unlocked_root` 是否符合协议。不通过抛 UnlockedRootError，消息可直接给用户看。"""
        if self.unlocked_root is None:
            raise UnlockedRootError(
                '还没有配置「已解锁的数据库目录」。请先自行解锁微信数据库，'
                '再把 unlocked_root 指向那个目录（协议见 docs/unlocked-db-protocol.md）。')

        root = self.unlocked_root
        if not root.is_dir():
            raise UnlockedRootError(f'已解锁目录不存在：{root}')

        manifest_path = root / 'manifest.json'
        if not manifest_path.is_file():
            raise UnlockedRootError(
                f'目录里没有 manifest.json：{root}\n'
                '它应该由解锁方产出（含库清单与解锁时间）。协议见 docs/unlocked-db-protocol.md。')
        try:
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        except (OSError, ValueError) as error:
            raise UnlockedRootError(f'manifest.json 读不出来：{error}') from error

        version = manifest.get('manifest_version')
        if version != 1:
            raise UnlockedRootError(f'不支持的产物版本 manifest_version={version!r}（本程序支持 1）')

        databases = manifest.get('databases') or []
        rels = [str(item.get('rel') or '') for item in databases if isinstance(item, dict)]
        missing = [kind for kind in REQUIRED_KINDS
                   if not any(rel.replace('\\', '/').startswith(kind + '/') for rel in rels)]
        if missing:
            raise UnlockedRootError(
                '产物里缺少必需库：' + '、'.join(missing) + f'（目录 {root}）\n'
                '解锁时要包含 contact / session / message 这三类库。')

        # 抽查：必须是明文 SQLite。文件头不对通常意味着"没解开"或"被截断"。
        bad: list[str] = []
        for item in databases:
            if not isinstance(item, dict):
                continue
            rel = str(item.get('rel') or '')
            if not rel.replace('\\', '/').startswith(REQUIRED_KINDS):
                continue
            output = Path(str(item.get('output') or (root / 'plain' / rel)))
            try:
                with output.open('rb') as handle:
                    head = handle.read(16)
            except OSError:
                bad.append(f'{rel}（文件不存在）')
                continue
            if head != SQLITE_MAGIC:
                bad.append(f'{rel}（不是明文库）')
        if bad:
            raise UnlockedRootError(
                '这些产物不是可用的明文库：' + '、'.join(bad[:5]) +
                '\n多半是没解开、没合并 WAL，或者产物被截断。')

        self._manifest_created_at = str(manifest.get('created_at') or '')
        self._validated = True
        return manifest

    def created_at(self) -> str | None:
        """产物的解锁时间（ISO 8601）。界面用它提示"产物有多旧"。"""
        return self._manifest_created_at

    # ------------------------------------------------------------------
    # 刷新（旧实现这里是 vault.unlock —— 已移除）
    # ------------------------------------------------------------------
    def _refresh(self) -> KnowledgeBase:
        # 关掉上一轮的只读连接：外部解锁方会覆盖 plain/*.db，Windows 下持着句柄会挡住它写入。
        self.close()
        if not self._validated or not self.unlocked_root.is_dir():
            self.validate()
        self._workspace_path = self.unlocked_root
        self._kb = KnowledgeBase(self._workspace_path)
        return self._kb

    def close(self) -> None:
        """释放只读连接。幂等。"""
        if self._kb is not None:
            self._kb.close()
            self._kb = None

    def workspace(self) -> str | None:
        """产物根目录（未成功打开过为 None）。"""
        return str(self._workspace_path) if self._workspace_path else None

    # ------------------------------------------------------------------
    # 与旧 WatcherSource 对齐的其它接口
    # ------------------------------------------------------------------
    def ready(self, timeout: float = 60.0) -> bool:
        """校验产物是否可用。同步完成（不再需要等子进程）。"""
        try:
            self.validate()
            self._error = ''
            return True
        except UnlockedRootError as error:
            self._error = str(error)
            return False

    def alive(self) -> bool:
        """这一层是就地读目录，没有"进程会死"这回事；只要产物还在就算活着。"""
        return not self._closed and self._validated

    def last_error(self) -> str:
        return self._error

    # ------------------------------------------------------------------
    # 轮询（逻辑与旧 watcher.poll 逐字一致）
    # ------------------------------------------------------------------
    def poll(self) -> list[dict]:
        """读一轮增量。首次调用只建基线，返回空列表。"""
        try:
            kb = self._refresh()
            self._error = ''
        except UnlockedRootError as error:
            self._error = str(error)
            return []
        now = int(time.time())

        if self._last_poll_time == 0:
            # 首次：只记时间基线，不产出。历史消息不作为新消息处理。
            self._last_poll_time = now
            return []

        window_start = self._last_poll_time - self.overlap_seconds
        events: list[MessageEvent] = []

        for session in kb.sessions(limit=SESSION_LIMIT).get("sessions", []):
            username = session.get("username") or ""
            if not username:
                continue
            # session.last_time 是最后一条消息的时间；落在窗口内才值得读正文。
            last_time = int(session.get("last_time") or 0)
            if last_time < window_start:
                continue
            conv = kb.conversation(username, limit=CONVERSATION_LIMIT)
            for message in conv.get("messages", []):
                create_time = int(message.get("time") or 0)
                if create_time < window_start:
                    continue
                local_id = message.get("local_id")
                key = (username, local_id)
                if key in self._seen:
                    continue
                self._seen[key] = create_time
                events.append(
                    MessageEvent(
                        username=username,
                        display=conv.get("display") or username,
                        direction="outgoing" if message.get("mine") else "incoming",
                        sender=message.get("sender") or "",
                        text=message.get("text") or "",
                        local_type=message.get("local_type"),
                        type_name=message.get("type") or "",
                        create_time=create_time,
                        sort_seq=message.get("sort_seq"),
                        local_id=local_id,
                    )
                )

        self._last_poll_time = now
        self._prune_seen(now)
        events.sort(key=lambda event: (event.create_time, event.username))
        return [event.as_dict() for event in events]

    def _prune_seen(self, now: int) -> None:
        """清理去重窗口外的记录，避免随消息累积无限增长。"""
        cutoff = now - 2 * self.overlap_seconds
        stale = [key for key, ts in self._seen.items() if ts < cutoff]
        for key in stale:
            self._seen.pop(key, None)


__all__ = ["MessageEvent", "UnlockedSource", "UnlockedRootError"]
