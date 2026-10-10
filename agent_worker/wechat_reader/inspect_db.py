from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any


def _identifier(value: str) -> str:
    if "\x00" in value:
        raise ValueError("SQLite identifiers cannot contain NUL")
    return '"' + value.replace('"', '""') + '"'


def _connect_readonly(database: Path) -> sqlite3.Connection:
    resolved = database.expanduser().resolve(strict=True)
    if not resolved.is_file():
        raise ValueError(f"database is not a regular file: {resolved}")
    connection = sqlite3.connect(f"file:{resolved.as_posix()}?mode=ro&immutable=1", uri=True)
    connection.execute("PRAGMA query_only = ON")
    return connection


def _tables(connection: sqlite3.Connection) -> set[str]:
    return {
        row[0]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
        )
    }


def _existing_table(connection: sqlite3.Connection, table: str) -> str:
    if table not in _tables(connection):
        raise ValueError(f"table does not exist: {table!r}")
    return _identifier(table)


def _json_value(value: Any) -> Any:
    if isinstance(value, bytes):
        return {
            "$type": "blob",
            "bytes": len(value),
            "hex_preview": value[:32].hex(),
            "truncated": len(value) > 32,
        }
    return value


def inventory(database: Path) -> list[dict[str, object]]:
    connection = _connect_readonly(database)
    try:
        rows = connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        result = []
        for (name,) in rows:
            columns = [row[1] for row in connection.execute(f"PRAGMA table_info({_identifier(name)})")]
            count = connection.execute(f"SELECT count(*) FROM {_identifier(name)}").fetchone()[0]
            result.append({"table": name, "columns": columns, "rows": count})
        return result
    finally:
        connection.close()


def read_rows(database: Path, table: str, *, limit: int = 100, offset: int = 0) -> dict[str, object]:
    if not 1 <= limit <= 500:
        raise ValueError("limit must be between 1 and 500")
    if offset < 0:
        raise ValueError("offset must be non-negative")
    connection = _connect_readonly(database)
    connection.row_factory = sqlite3.Row
    try:
        quoted = _existing_table(connection, table)
        columns = [row[1] for row in connection.execute(f"PRAGMA table_info({quoted})")]
        total = connection.execute(f"SELECT count(*) FROM {quoted}").fetchone()[0]
        rows = [
            {key: _json_value(value) for key, value in dict(row).items()}
            for row in connection.execute(f"SELECT * FROM {quoted} LIMIT ? OFFSET ?", (limit, offset))
        ]
        return {"table": table, "columns": columns, "total": total, "limit": limit, "offset": offset, "rows": rows}
    finally:
        connection.close()


def export_jsonl(database: Path, table: str, output: Path) -> tuple[Path, int]:
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f"{table}.jsonl"
    if destination.exists():
        raise FileExistsError(f"refusing to overwrite {destination}")
    connection = _connect_readonly(database)
    connection.row_factory = sqlite3.Row
    count = 0
    try:
        quoted = _existing_table(connection, table)
        with destination.open("x", encoding="utf-8", newline="\n") as stream:
            for row in connection.execute(f"SELECT * FROM {quoted}"):
                stream.write(json.dumps({key: _json_value(value) for key, value in dict(row).items()}, ensure_ascii=False, default=str) + "\n")
                count += 1
    finally:
        connection.close()
    return destination, count
