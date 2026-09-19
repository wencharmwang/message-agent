"""把 reply.db 规则的 conversation 从 ``hash(显示名)`` 迁移为 ``username(wxid)``。

背景：会话身份原来是 OCR 显示名的哈希，名字抖动会让同一联系人产生多条规则
（实测「小璐璐 / 小璐路璐 / 小璐路璐路」就是同一个人）。DB 方案改用原生 username。

匹配规则：只用 **name_key 精确匹配**（remark / nick_name / alias / username），
绝不猜测——匹配不到的规则原样保留并标记 ``waiting_rebind``，避免错绑。

用法（必须用 wechat-db-lab 的 venv 跑，因要 import vault/readers）：

    VENV="C:/Users/Wencharm/.workbuddy/binaries/python/envs/default/Scripts/python.exe"
    cd C:/Users/Wencharm/Documents/projects/message-agent
    PYTHONPATH="C:/Users/Wencharm/Documents/projects/wechat-db-lab/src" "$VENV" -m agent_worker.migrate_to_username --db data/reply.db
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path


def name_key(text: object) -> str:
    return "".join(ch for ch in str(text or "") if ch.isalnum()).lower()


def load_identity_map(kb) -> dict[str, tuple[str, str]]:
    """name_key(显示名) -> (username, display)。display 取 remark > nick_name > username。"""
    mapping: dict[str, tuple[str, str]] = {}
    for username, contact in kb.contact_map().items():
        display = contact.get("remark") or contact.get("nick_name") or username
        for value in (contact.get("remark"), contact.get("nick_name"),
                      contact.get("alias"), username, display):
            if value:
                mapping.setdefault(name_key(value), (username, display))
    for session in kb.sessions(limit=500).get("sessions", []):
        username = session.get("username") or ""
        if username:
            display = session.get("display") or username
            mapping.setdefault(name_key(username), (username, display))
            mapping.setdefault(name_key(display), (username, display))
    return mapping


def migrate(db_path: str, watcher_src: str) -> dict:
    sys.path.insert(0, watcher_src)
    from wechat_db_lab import vault
    from wechat_db_lab.readers import KnowledgeBase

    result = vault.unlock(kinds={"session", "contact", "message"})
    kb = KnowledgeBase(Path(result.workspace))
    try:
        mapping = load_identity_map(kb)
    finally:
        kb.close()

    connection = sqlite3.connect(db_path)
    connection.row_factory = sqlite3.Row
    try:
        rules = [dict(r) for r in connection.execute(
            "SELECT id,conversation,title FROM reply_rules WHERE archived=0")]
        report = {"account": result.account, "mapped": [], "pending": []}
        for rule in rules:
            hit = mapping.get(name_key(rule["title"]))
            if not hit or hit[0] == rule["conversation"]:
                report["pending"].append({"title": rule["title"], "conversation": rule["conversation"]})
                continue
            username, display = hit
            connection.execute(
                "UPDATE reply_rules SET conversation=?, title=?, status='waiting_rebind', "
                "baseline=NULL, candidate=NULL, candidate_since=NULL WHERE id=?",
                (username, display, rule["id"]))
            report["mapped"].append(
                {"title": rule["title"], "display": display,
                 "old": rule["conversation"], "new": username})
        connection.commit()
        return report
    finally:
        connection.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", required=True)
    parser.add_argument("--watcher-src",
                        default="C:/Users/Wencharm/Documents/projects/wechat-db-lab/src")
    args = parser.parse_args()
    report = migrate(args.db, args.watcher_src)
    import json
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
