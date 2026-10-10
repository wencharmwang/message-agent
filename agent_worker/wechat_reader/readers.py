"""知识库查询层：把解密后的微信库读成"联系人 / 会话 / 消息 / 检索"。

微信 4.x 的实际结构（本机 4.1.x 实测确认，不是猜的）：

* ``contact/contact.db`` → ``contact`` 表（username, nick_name, remark, alias, …）；
* ``session/session.db`` → ``SessionTable``（username, unread_count, summary,
  last_timestamp, sort_timestamp, is_hidden, …）；
* ``message/message_N.db`` → 每个会话一张 ``Msg_<md5(username)>`` 表；
* ``message/message_N.db`` → ``name2id``（rowid 即 id，``is_session`` 标记会话/发送者）；
* ``message/message_resource.db`` → ``SenderName2Id``（rowid 即 sender id）；
* ``message/message_fts.db`` → FTS5 虚拟表 ``message_fts_v4_*``，列
  ``acontent``(**明文正文**) / session_id / sender_id / create_time / local_type
  ——这是全库检索最快的来源，不需要解码二进制容器。

所有连接都以 ``mode=ro`` 打开，且 ``PRAGMA query_only``，只读不可写。
"""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from . import locate
from .messages import decode_content, preview, strip_sender_prefix, type_name

MAX_LIMIT = 500
IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


class QueryError(ValueError):
    pass


def quote_ident(value: str) -> str:
    if "\x00" in value:
        raise QueryError("identifier must not contain NUL")
    return '"' + value.replace('"', '""') + '"'


def message_table(username: str) -> str:
    """会话消息表名：``Msg_`` + md5(username) 的十六进制。"""
    return "Msg_" + hashlib.md5(username.encode("utf-8")).hexdigest()


def _blob_value(value: bytes) -> dict:
    return {
        "$blob": True,
        "bytes": len(value),
        "hex": value[:48].hex(),
        "truncated": len(value) > 48,
    }


def json_value(value: Any) -> Any:
    if isinstance(value, (bytes, bytearray, memoryview)):
        return _blob_value(bytes(value))
    if isinstance(value, float) and value != value:  # NaN
        return None
    return value


@dataclass
class Sender:
    username: str
    display: str
    mine: bool


@dataclass
class KnowledgeBase:
    """一个已解密 workspace 的只读视图。"""

    root: Path
    _conns: dict[str, sqlite3.Connection] = field(default_factory=dict, repr=False)
    _sender_index: dict[int, str] = field(default_factory=dict, repr=False)
    _session_index: dict[int, str] = field(default_factory=dict, repr=False)
    _self_names: set[str] = field(default_factory=set, repr=False)
    _contacts: dict[str, dict] = field(default_factory=dict, repr=False)

    # ------------------------------------------------------------------
    # 基础
    # ------------------------------------------------------------------
    @property
    def plain(self) -> Path:
        return self.root / "plain"

    def manifest(self) -> dict:
        try:
            data = json.loads((self.root / "manifest.json").read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    @property
    def account(self) -> str:
        return self.manifest().get("account", self.root.name)

    def paths(self) -> list[tuple[str, Path]]:
        return [
            (path.relative_to(self.plain).as_posix(), path)
            for path in sorted(self.plain.rglob("*.db"))
        ]

    def path_of(self, rel: str) -> Path:
        target = (self.plain / rel.replace("\\", "/")).resolve()
        plain = self.plain.resolve()
        if plain not in target.parents and target != plain:
            raise QueryError("database path escapes the workspace")
        if not target.is_file():
            raise QueryError(f"database not found in workspace: {rel}")
        return target

    def find_path(self, *needles: str) -> Path | None:
        """按文件名片段找库，例如 ``find_path("contact", "contact.db")``。"""
        wanted = [n.lower() for n in needles]
        for rel, path in self.paths():
            low = rel.lower()
            if all(n in low for n in wanted):
                return path
        return None

    def connect(self, rel_or_path: str | Path) -> sqlite3.Connection:
        path = self.path_of(rel_or_path) if isinstance(rel_or_path, str) else Path(rel_or_path)
        key = str(path)
        existing = self._conns.get(key)
        if existing is not None:
            return existing
        # check_same_thread=False：网页服务是多线程的，连接会被不同请求线程复用。
        # 只读 + query_only 的前提下这是安全的（Python 3.11+ 的 SQLite 为 serialized 模式）；
        # 若换成可写连接，这里必须改成每线程一个连接。
        connection = sqlite3.connect(
            f"file:{path.as_posix()}?mode=ro&immutable=1", uri=True, check_same_thread=False
        )
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only = ON")
        self._conns[key] = connection
        return connection

    def close(self) -> None:
        for connection in self._conns.values():
            try:
                connection.close()
            except sqlite3.Error:
                pass
        self._conns.clear()

    def __enter__(self) -> "KnowledgeBase":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    # ------------------------------------------------------------------
    # 表枚举
    # ------------------------------------------------------------------
    @staticmethod
    def _tables(connection: sqlite3.Connection) -> list[str]:
        return [
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','view') "
                "AND name NOT LIKE 'sqlite_%' ORDER BY name"
            )
        ]

    @staticmethod
    def _row_count(connection: sqlite3.Connection, table: str) -> int | None:
        try:
            return connection.execute(
                f"SELECT count(*) FROM {quote_ident(table)}"
            ).fetchone()[0]
        except sqlite3.Error:
            return None

    def databases(self) -> list[dict]:
        """所有已解密库的元信息 + 表数量 + 行数合计。"""
        manifest = self.manifest()
        entries = {
            entry.get("rel"): entry
            for entry in manifest.get("databases", [])
            if isinstance(entry, dict)
        }
        output: list[dict] = []
        for rel, path in self.paths():
            record = entries.get(rel, {})
            connection = self.connect(path)
            tables = self._tables(connection)
            rows = sum(self._row_count(connection, table) or 0 for table in tables)
            output.append(
                {
                    "rel": rel,
                    "kind": record.get("kind") or locate.classify(rel),
                    "bytes": path.stat().st_size,
                    "pages": record.get("pages", 0),
                    "wal_frames": record.get("wal_frames", 0),
                    "tables": len(tables),
                    "rows": rows,
                    "table_names": tables,
                }
            )
        return output

    def tables(self, rel: str) -> list[dict]:
        connection = self.connect(rel)
        output = []
        for table in self._tables(connection):
            columns = [
                {"name": row[1], "type": row[2], "pk": bool(row[5])}
                for row in connection.execute(f"PRAGMA table_info({quote_ident(table)})")
            ]
            output.append(
                {"table": table, "columns": columns, "rows": self._row_count(connection, table)}
            )
        return output

    def table_rows(
        self, rel: str, table: str, *, limit: int = 100, offset: int = 0, decode: bool = True
    ) -> dict:
        limit = max(1, min(int(limit), MAX_LIMIT))
        offset = max(0, int(offset))
        connection = self.connect(rel)
        if table not in self._tables(connection):
            raise QueryError(f"table does not exist: {table}")
        quoted = quote_ident(table)
        columns = [row[1] for row in connection.execute(f"PRAGMA table_info({quoted})")]
        total = self._row_count(connection, table) or 0
        rows = []
        for row in connection.execute(
            f"SELECT * FROM {quoted} LIMIT ? OFFSET ?", (limit, offset)
        ):
            record = dict(row)
            if decode and "message_content" in record and "local_type" in record:
                record["message_content_text"] = decode_content(
                    record.get("message_content"), record.get("local_type")
                )
            rows.append({key: json_value(value) for key, value in record.items()})
        return {
            "database": rel,
            "table": table,
            "columns": columns,
            "total": total,
            "limit": limit,
            "offset": offset,
            "rows": rows,
        }

    # ------------------------------------------------------------------
    # 索引：id → 名字
    # ------------------------------------------------------------------
    def _message_shard_paths(self) -> list[tuple[str, Path]]:
        """``message/message_N.db`` 分片（排除 fts / resource / biz_message / chatbot）。"""
        output = []
        for rel, path in self.paths():
            name = rel.rsplit("/", 1)[-1]
            if not rel.startswith("message/"):
                continue
            if not re.fullmatch(r"message_\d+\.db", name):
                continue
            output.append((rel, path))
        return output

    def _load_indexes(self) -> None:
        """建立 ``sender id → username`` 映射。

        **id 空间是分片内的**：``message_0.db`` 与 ``message_1.db`` 各有自己的
        ``name2id``。所以只能合并"消息分片"里的 name2id；一旦把 ``bizchat`` /
        ``chatbot`` 的 name2id 也混进来，id 1 就会被解析成"服务通知"之类的错名字
        （实测踩过）。
        """
        if self._sender_index:
            return
        for rel, path in self._message_shard_paths():
            try:
                connection = self.connect(path)
                tables = self._tables(connection)
            except sqlite3.Error:
                continue  # 坏分片不该让整个索引建不起来
            for real in tables:
                if real.lower() != "name2id":
                    continue
                columns = [
                    row[1]
                    for row in connection.execute(f"PRAGMA table_info({quote_ident(real)})")
                ]
                column = "user_name" if "user_name" in columns else "username"
                for row in connection.execute(
                    f"SELECT rowid, {quote_ident(column)} FROM {quote_ident(real)}"
                ):
                    if not isinstance(row[1], str) or not row[1]:
                        continue
                    self._sender_index.setdefault(int(row[0]), row[1])
                    self._session_index.setdefault(int(row[0]), row[1])
        # message_resource.db 的 SenderName2Id 覆盖群成员，但**它的 rowid 空间与分片内的
        # name2id 不是同一个**。直接覆盖会把成员对错人：实测群里 31 个 rowid 里有 7 个被
        # 解析成另一个成员，界面上就是别人的名字。用 setdefault 只补缺口，分片内的
        # name2id 保持权威 —— 这一点与 message-agent 侧的 `Worker._sender_index` 一致。
        resource = self.find_path("message", "message_resource.db")
        if resource is not None:
            try:
                connection = self.connect(resource)
                tables = self._tables(connection)
            except sqlite3.Error:
                tables = []
            for real in tables:
                if real.lower() != "sendername2id":
                    continue
                columns = [
                    row[1]
                    for row in connection.execute(f"PRAGMA table_info({quote_ident(real)})")
                ]
                column = "user_name" if "user_name" in columns else columns[0]
                for row in connection.execute(
                    f"SELECT rowid, {quote_ident(column)} FROM {quote_ident(real)}"
                ):
                    if isinstance(row[1], str) and row[1]:
                        self._sender_index.setdefault(int(row[0]), row[1])
        # 自己的身份：账号目录名去掉末尾的 4 位十六进制后缀（如 xxx_f30e）
        self._self_names = {self.account.rsplit("_", 1)[0], self.account}

    def sender_index(self) -> dict[int, str]:
        self._load_indexes()
        return self._sender_index

    def session_index(self) -> dict[int, str]:
        self._load_indexes()
        return self._session_index

    def _table_to_username(self) -> dict[str, str]:
        """``Msg_<md5>`` 表名 → username。md5 不可逆，所以拿候选用户名正推。"""
        names = set(self.contact_map())
        names.update(item["username"] for item in self.sessions(limit=MAX_LIMIT)["sessions"])
        names.update(self.session_index().values())
        return {message_table(name): name for name in names if name}

    def resolve_sessions(self, sort_seqs: Iterable[int]) -> dict[int, str]:
        """把 ``sort_seq`` 反查到所属会话 username。

        ``sort_seq`` 在 ``Msg_*`` 与 FTS 索引里是同一个值，所以命中项能精确落回会话，
        不依赖任何 id 猜测——这是把检索结果归到正确聊天窗口的唯一可靠办法。
        """
        wanted = {int(value) for value in sort_seqs if value is not None}
        if not wanted:
            return {}
        mapping = self._table_to_username()
        resolved: dict[int, str] = {}
        chunk = list(wanted)
        for _, connection, table in self.message_tables():
            username = mapping.get(table)
            if not username:
                continue
            pending = [value for value in chunk if value not in resolved]
            if not pending:
                break
            placeholders = ",".join("?" * len(pending))
            try:
                rows = connection.execute(
                    f"SELECT sort_seq FROM {quote_ident(table)} WHERE sort_seq IN ({placeholders})",
                    pending,
                ).fetchall()
            except sqlite3.Error:
                continue
            for row in rows:
                resolved.setdefault(int(row[0]), username)
        return resolved

    # ------------------------------------------------------------------
    # 联系人
    # ------------------------------------------------------------------
    def contact_map(self) -> dict[str, dict]:
        if self._contacts:
            return self._contacts
        path = self.find_path("contact", "contact.db")
        if path is None:
            return {}
        connection = self.connect(path)
        for row in connection.execute(
            "SELECT username, nick_name, remark, alias, local_type, delete_flag, "
            "description, big_head_url FROM contact"
        ):
            record = dict(row)
            username = record.get("username")
            if not username:
                continue
            display = record.get("remark") or record.get("nick_name") or username
            self._contacts[username] = {
                "username": username,
                "nick_name": record.get("nick_name") or "",
                "remark": record.get("remark") or "",
                "alias": record.get("alias") or "",
                "display": display,
                "local_type": record.get("local_type"),
                "deleted": bool(record.get("delete_flag")),
                "description": record.get("description") or "",
                "avatar": record.get("big_head_url") or "",
            }
        return self._contacts

    def display_name(self, username: str) -> str:
        if not username:
            return ""
        record = self.contact_map().get(username)
        return record["display"] if record else username

    def sender_of(self, sender_id: Any) -> Sender:
        self._load_indexes()
        try:
            numeric = int(sender_id)
        except (TypeError, ValueError):
            return Sender("", "未知", False)
        username = self._sender_index.get(numeric, "")
        mine = bool(username) and username in self._self_names
        if mine:
            return Sender(username, "我", True)
        display = self.display_name(username) if username else f"未知(id={numeric})"
        return Sender(username=username, display=display, mine=False)

    def contacts(self, *, query: str = "", limit: int = 200, offset: int = 0) -> dict:
        limit = max(1, min(int(limit), MAX_LIMIT))
        records = list(self.contact_map().values())
        if query:
            needle = query.strip().lower()
            records = [
                item
                for item in records
                if needle in item["username"].lower()
                or needle in item["display"].lower()
                or needle in item["nick_name"].lower()
                or needle in item["alias"].lower()
            ]
        # 微信内置的伪联系人（通知/团队/推荐）排到后面
        pseudo = {"weixin", "notifymessage", "fmessage", "floatbottle", "medianote", "newsapp"}
        records.sort(
            key=lambda item: (
                item["username"].lower() in pseudo,
                item["deleted"],
                item["display"].lower(),
            )
        )
        window = records[offset: offset + limit]
        return {"total": len(records), "limit": limit, "offset": offset, "contacts": window}

    # ------------------------------------------------------------------
    # 会话
    # ------------------------------------------------------------------
    def sessions(self, *, query: str = "", limit: int = 200, offset: int = 0,
                 include_hidden: bool = False) -> dict:
        limit = max(1, min(int(limit), MAX_LIMIT))
        path = self.find_path("session", "session.db")
        if path is None:
            return {"total": 0, "limit": limit, "offset": offset, "sessions": []}
        connection = self.connect(path)
        where = "" if include_hidden else "WHERE is_hidden = 0"
        rows = list(
            connection.execute(
                "SELECT username, type, unread_count, summary, draft, is_hidden, "
                "last_timestamp, sort_timestamp, last_msg_type, last_msg_sender, "
                "last_sender_display_name FROM SessionTable "
                f"{where} ORDER BY sort_timestamp DESC"
            )
        )
        contacts = self.contact_map()
        items = []
        for row in rows:
            record = dict(row)
            username = record.get("username") or ""
            contact = contacts.get(username, {})
            display = (
                record.get("last_sender_display_name")
                or contact.get("display")
                or username
            )
            items.append(
                {
                    "username": username,
                    "display": display,
                    "type": record.get("type"),
                    "unread": record.get("unread_count") or 0,
                    "summary": record.get("summary") or "",
                    "draft": record.get("draft") or "",
                    "hidden": bool(record.get("is_hidden")),
                    "last_time": record.get("last_timestamp") or 0,
                    "sort_time": record.get("sort_timestamp") or 0,
                    "last_type": type_name(record.get("last_msg_type")),
                    "is_group": "@chatroom" in username,
                    "known": username in contacts,
                }
            )
        if query:
            needle = query.strip().lower()
            items = [
                item
                for item in items
                if needle in item["username"].lower()
                or needle in item["display"].lower()
                or needle in item["summary"].lower()
            ]
        window = items[offset: offset + limit]
        return {"total": len(items), "limit": limit, "offset": offset, "sessions": window}

    # ------------------------------------------------------------------
    # 消息
    # ------------------------------------------------------------------
    def message_tables(self) -> list[tuple[str, sqlite3.Connection, str]]:
        """所有 ``Msg_*`` 表：``(rel, 连接, 表名)``。

        读不了的分片会被跳过而不是抛出来——单个分片损坏（正在被微信写、或者解出来
        不完整）不该让整个知识库或监听循环挂掉。
        """
        found: list[tuple[str, sqlite3.Connection, str]] = []
        for rel, path in self.paths():
            if not rel.startswith("message/"):
                continue
            if not rel.rsplit("/", 1)[-1].startswith("message_"):
                continue
            if rel.endswith("_fts.db") or rel.endswith("_resource.db"):
                continue
            try:
                connection = self.connect(path)
                tables = self._tables(connection)
            except sqlite3.Error:
                continue
            for table in tables:
                if table.startswith("Msg_"):
                    found.append((rel, connection, table))
        return found

    def conversation(self, username: str, *, limit: int = 200, before: int | None = None) -> dict:
        """某会话的消息，按时间正序返回。``before`` 是向上翻页用的 sort_seq 游标。"""
        limit = max(1, min(int(limit), MAX_LIMIT))
        table = message_table(username)
        collected: list[dict] = []
        for rel, connection, name in self.message_tables():
            if name != table:
                continue
            sql = (
                "SELECT local_id, local_type, sort_seq, real_sender_id, create_time, "
                "status, message_content, compress_content FROM "
                f"{quote_ident(name)}"
            )
            params: tuple = ()
            if before is not None:
                sql += " WHERE sort_seq < ?"
                params = (int(before),)
            sql += " ORDER BY sort_seq DESC, local_id ASC LIMIT ?"
            try:
                rows = list(connection.execute(sql, params + (limit,)))
            except sqlite3.Error as exc:
                raise QueryError(f"could not read {name} in {rel}: {exc}") from exc
            for row in rows:
                collected.append({"rel": rel, **dict(row)})
        collected.sort(key=lambda item: (item["sort_seq"], item["local_id"]), reverse=True)
        window = collected[:limit]
        window.reverse()

        contact = self.contact_map().get(username, {})
        messages = []
        for row in window:
            sender = self.sender_of(row.get("real_sender_id"))
            text = decode_content(row.get("message_content"), row.get("local_type"))
            if text.startswith("[") and row.get("compress_content"):
                alternative = decode_content(row["compress_content"], row.get("local_type"))
                if not alternative.startswith("["):
                    text = alternative
            # 群消息正文自己带着「发送者: 」前缀；发送者已经单独给了，切掉它。
            text = strip_sender_prefix(text, sender.username)
            messages.append(
                {
                    "local_id": row.get("local_id"),
                    "sort_seq": row.get("sort_seq"),
                    "time": row.get("create_time"),
                    "type": type_name(row.get("local_type")),
                    "local_type": row.get("local_type"),
                    "sender_id": row.get("real_sender_id"),
                    "sender": sender.display,
                    "mine": sender.mine,
                    "text": text,
                }
            )
        next_cursor = window[0]["sort_seq"] if window else None
        return {
            "username": username,
            "display": contact.get("display") or username,
            "is_group": "@chatroom" in username,
            "count": len(messages),
            "messages": messages,
            "next_cursor": next_cursor if len(collected) > limit else None,
        }

    # ------------------------------------------------------------------
    # 检索
    # ------------------------------------------------------------------
    def _fts_sources(self) -> list[tuple[str, sqlite3.Connection, str]]:
        path = self.find_path("message", "message_fts.db")
        if path is None:
            return []
        connection = self.connect(path)
        sources = []
        for table in self._tables(connection):
            if not re.fullmatch(r"message_fts_v\d+_\d+", table):
                continue
            if self._row_count(connection, table):
                sources.append((path.name, connection, table))
        return sources

    def _fts_columns(self, connection: sqlite3.Connection, table: str) -> list[str]:
        return [
            row[1] for row in connection.execute(f"PRAGMA table_info({quote_ident(table)})")
        ]

    def search(self, query: str, *, limit: int = 100) -> dict:
        """按正文全文检索。

        数据来源是 WCDB 自己维护的 FTS5 索引 ``message_fts_v4_*``——里面存的是
        **明文**正文和 create_time，比逐行解码 ``Msg_*`` 里的二进制容器快得多。

        命中的 ``sort_seq`` 会被反查回具体会话（见 :meth:`resolve_sessions`），
        因此结果能直接跳转到对应聊天窗口。查询串先做 FTS 语法消毒，避免用户输入
        ``-`` / ``"`` 把 MATCH 打成语法错误。
        """
        limit = max(1, min(int(limit), MAX_LIMIT))
        needle = " ".join((query or "").split())
        match = _fts_match_expression(needle)
        if match is None:
            # 全是 FTS 语法符号（"-"、"**" 之类）：安静返回空，别把 UI 弹成报错
            return {"query": query, "total": 0, "limit": limit, "results": [],
                    "note": "查询里没有可检索的词"}
        contacts = self.contact_map()
        raw: list[dict] = []
        seen: set[tuple] = set()
        for _, connection, table in self._fts_sources():
            available = self._fts_columns(connection, table)
            text_col = "acontent" if "acontent" in available else ("c0" if "c0" in available else None)
            if text_col is None:
                continue
            select = [text_col]
            for name in ("message_local_id", "sort_seq", "local_type", "sender_id", "create_time"):
                select.append(name if name in available else f"NULL AS {name}")
            projection = ", ".join(select)
            quoted = quote_ident(table)
            rows: list[sqlite3.Row] = []
            if "acontent" in available:
                for predicate, parameter in (("MATCH ?", match), ("LIKE ?", f"%{needle}%")):
                    try:
                        rows = list(
                            connection.execute(
                                f"SELECT {projection} FROM {quoted} WHERE acontent {predicate} "
                                "ORDER BY sort_seq DESC LIMIT ?",
                                (parameter, limit),
                            )
                        )
                        if rows:
                            break
                    except sqlite3.Error:
                        continue
            else:
                try:
                    rows = list(
                        connection.execute(
                            f"SELECT {projection} FROM {quoted} WHERE {text_col} LIKE ? "
                            "ORDER BY sort_seq DESC LIMIT ?",
                            (f"%{needle}%", limit),
                        )
                    )
                except sqlite3.Error:
                    continue
            for row in rows:
                record = dict(row)
                key = (record.get("sort_seq"), record.get(text_col))
                if key in seen:
                    continue
                seen.add(key)
                raw.append({"text": record.get(text_col) or "", **record})

        raw.sort(key=lambda item: item.get("sort_seq") or 0, reverse=True)
        raw = raw[:limit]
        owners = self.resolve_sessions(item.get("sort_seq") for item in raw)
        results = []
        for item in raw:
            sort_seq = item.get("sort_seq")
            username = owners.get(int(sort_seq)) if sort_seq is not None else None
            contact = contacts.get(username or "", {})
            results.append(
                {
                    "text": item.get("text") or "",
                    "time": item.get("create_time"),
                    "sort_seq": sort_seq,
                    "local_id": item.get("message_local_id"),
                    "type": type_name(item.get("local_type")),
                    "username": username,
                    "display": contact.get("display") or username or "未归属",
                    "sender": self.sender_of(item.get("sender_id")).display,
                }
            )
        return {"query": query, "total": len(results), "limit": limit, "results": results}

    # ------------------------------------------------------------------
    # 概览
    # ------------------------------------------------------------------
    def overview(self) -> dict:
        manifest = self.manifest()
        databases = self.databases()
        contacts = self.contact_map()
        session_summary = self.sessions(limit=1)
        message_total = 0
        earliest = None
        latest = None
        per_kind: dict[str, int] = {}
        for rel, connection, table in self.message_tables():
            count = self._row_count(connection, table) or 0
            message_total += count
        for _, connection, table in self._fts_sources():
            row = connection.execute(
                f"SELECT min(create_time), max(create_time) FROM {quote_ident(table)}"
            ).fetchone()
            if row and row[0]:
                earliest = row[0] if earliest is None else min(earliest, row[0])
                latest = row[1] if latest is None else max(latest, row[1])
        for item in databases:
            per_kind[item["kind"]] = per_kind.get(item["kind"], 0) + 1
        searchable = 0
        for _, connection, table in self._fts_sources():
            searchable += self._row_count(connection, table) or 0
        keys = manifest.get("keys") or {}
        return {
            "account": self.account,
            "data_root": manifest.get("data_root", ""),
            "workspace": str(self.root),
            "created_at": manifest.get("created_at", ""),
            "kdf_iterations": manifest.get("kdf_iterations"),
            "databases": databases,
            "totals": {
                "databases": len(databases),
                "contacts": len(contacts),
                "sessions": session_summary["total"],
                "messages": message_total,
                "searchable": searchable,
                "bytes": sum(item["bytes"] for item in databases),
            },
            "per_kind": per_kind,
            "key_source": {
                "from_cache": keys.get("from_cache", 0),
                "from_memory": keys.get("from_memory", 0),
                "from_master": keys.get("from_master", 0),
                "missing": keys.get("missing", []),
            },
            "time_range": {"earliest": earliest, "latest": latest},
        }

    def timeline(self, *, days: int = 30) -> dict:
        """全库消息量按天聚合，用于概览页画柱状图。"""
        buckets: dict[str, int] = {}
        for _, connection, table in self._fts_sources():
            try:
                rows = connection.execute(
                    "SELECT date(create_time, 'unixepoch', 'localtime') AS day, count(*) "
                    f"FROM {quote_ident(table)} GROUP BY day"
                )
            except sqlite3.Error:
                continue
            for day, count in rows:
                if day:
                    buckets[day] = buckets.get(day, 0) + int(count)
        ordered = sorted(buckets.items())[-max(1, int(days)):]
        return {"days": days, "buckets": [{"day": day, "count": count} for day, count in ordered]}

    def chat_activity(self, limit: int = 12) -> list[dict]:
        """按会话统计消息条数与最后活跃时间。

        直接从 ``Msg_*`` 数行——比 FTS 索引准（索引可能不全），且表名能反推 username。
        """
        mapping = self._table_to_username()
        contacts = self.contact_map()
        # 同一会话可能被拆到多个分片，按 username 累加
        totals: dict[str, dict] = {}
        for _, connection, table in self.message_tables():
            username = mapping.get(table)
            if not username:
                continue
            try:
                row = connection.execute(
                    f"SELECT count(*), max(create_time) FROM {quote_ident(table)}"
                ).fetchone()
            except sqlite3.Error:
                continue
            if not row or not row[0]:
                continue
            record = totals.setdefault(
                username,
                {
                    "username": username,
                    "display": contacts.get(username, {}).get("display") or username,
                    "messages": 0,
                    "last_time": 0,
                },
            )
            record["messages"] += int(row[0])
            record["last_time"] = max(record["last_time"], int(row[1] or 0))
        items = list(totals.values())
        items.sort(key=lambda item: item["last_time"], reverse=True)
        return items[: max(1, int(limit))]


_FTS_SPECIAL = re.compile(r'["*():^\-]')


def _fts_match_expression(needle: str) -> str | None:
    """把用户输入变成一个安全的 FTS5 MATCH 表达式（短语查询）。

    FTS5 的 ``MATCH`` 认得 ``-``、``"``、``*``、``(``、``:``、``^`` 等符号，用户随手
    输入就可能把查询打成语法错误。做法是先把这些符号换成空格，再把剩下的词各自加
    双引号变成短语，最后用 ``AND`` 连接。没有剩余词时返回 None，由调用方返回空结果。
    """
    tokens = [token for token in _FTS_SPECIAL.sub(" ", needle).split() if token]
    if not tokens:
        return None
    quoted = ['"%s"' % token.replace('"', "") for token in tokens]
    return quoted[0] if len(quoted) == 1 else " AND ".join(quoted)


__all__ = [
    "KnowledgeBase",
    "QueryError",
    "decode_content",
    "message_table",
    "preview",
    "quote_ident",
    "strip_sender_prefix",
    "type_name",
]
