"""微信数据库密钥的保管与授权扫描（给安装程序/用户脚本调用）。

设计要点（对应「读取到的 KEY 一定要妥善保管」这条要求）：

* 明文缓存 `%LOCALAPPDATA%\\wechat-db-lab\\keys\\*.json` **不再长期存在**：
  安装时迁进 DPAPI（`credentials\\wechat-keys.dat`），然后删掉明文和它的 `.bak`；
* 运行时由 `launch.py` 解密到本次运行的目录，用 `WECHAT_DB_LAB_KEYS_DIR` 喂给 watcher；
* **读进程内存只发生在用户点了授权那一次**（本文件的 `scan` 子命令）。日常启动
  `launch.py` 会给 watcher 带上 `WECHAT_DB_LAB_NO_SCAN=1`，缓存不够就如实报告缺哪些密钥。

子命令：
    status   看现在有什么（DPAPI 密钥 / 明文缓存 / 缺哪些）
    migrate  明文缓存 -> DPAPI，并删除明文与 .bak（安装时调用）
    scan     读取一次微信密钥：跑一次解锁（**允许扫内存**）-> 存进 DPAPI -> 删明文
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# 让本脚本能 import 产品自己的保管模块（安装目录下的 app/agent_worker，或开发仓库根目录）
HERE = Path(__file__).resolve().parent
for candidate in (HERE / 'app', HERE.parent / 'app', HERE.parent, HERE):
    if (candidate / 'agent_worker' / 'secrets_store.py').exists():
        sys.path.insert(0, str(candidate))
        break
from agent_worker import secrets_store  # noqa: E402


def db_lab_src() -> Path | None:
    """wechat-db-lab 的源码目录（包内 components\\wechat-db-lab\\src）。"""
    for candidate in (HERE / 'components' / 'wechat-db-lab' / 'src',
                      HERE.parent / 'components' / 'wechat-db-lab' / 'src'):
        if (candidate / 'wechat_db_lab' / '__init__.py').exists():
            return candidate
    return None


def credentials_dir() -> Path:
    override = os.environ.get('MESSAGE_AGENT_CREDENTIALS')
    if override:
        return Path(override)
    return HERE.parent / 'data' / 'credentials'


def plain_cache_files() -> list[Path]:
    """当前还存在的明文密钥缓存（含 .bak）。"""
    base = os.environ.get('WECHAT_DB_LAB_KEYS_DIR')
    dirs = [Path(base)] if base else []
    local = os.environ.get('LOCALAPPDATA') or os.environ.get('USERPROFILE')
    if local:
        dirs.append(Path(local) / 'wechat-db-lab' / 'keys')
    seen, found = set(), []
    for directory in dirs:
        if not directory or not directory.exists():
            continue
        for item in sorted(directory.glob('*.json*')):
            if item in seen:
                continue
            seen.add(item)
            found.append(item)
    return found


def read_plain_cache() -> tuple[str, dict] | None:
    """从明文缓存里读出 (账号, 密钥表)。跳过 .bak（它是上一次次优副本）。"""
    for path in plain_cache_files():
        if path.name.endswith('.bak'):
            continue
        try:
            data = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        keys = {k: v for k, v in data.items() if isinstance(v, str) and len(v) >= 32}
        if keys:
            return path.stem, keys
    return None


def delete_plain_cache() -> list[str]:
    removed = []
    for path in plain_cache_files():
        try:
            path.unlink()
            removed.append(path.name)
        except OSError:
            pass
    return removed


def cmd_status(_args) -> int:
    store = credentials_dir() / secrets_store.WECHAT_KEYS_FILE
    stored = secrets_store.load_wechat_keys(store)
    plain = read_plain_cache()
    report = {
        'dpapi_store': str(store),
        'dpapi_keys': (len(stored[1]) if stored else 0),
        'dpapi_account': (stored[0] if stored else None),
        'plain_cache': [str(p) for p in plain_cache_files()],
        'plain_keys': (len(plain[1]) if plain else 0),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


def cmd_migrate(_args) -> int:
    """把明文缓存的密钥搬进 DPAPI 存储，然后删掉明文。"""
    store = credentials_dir() / secrets_store.WECHAT_KEYS_FILE
    existing = secrets_store.load_wechat_keys(store)
    plain = read_plain_cache()
    if not plain:
        if existing:
            print(f'明文缓存没有可迁移的密钥；DPAPI 里已有 {len(existing[1])} 条（账号 {existing[0]}）。')
            remaining = delete_plain_cache()
            if remaining:
                print('顺手清掉了这些残留明文：' + '、'.join(remaining))
            return 0
        print('没有找到任何微信密钥（明文缓存为空，DPAPI 里也没有）。')
        return 0
    account, keys = plain
    if existing and existing[1] == keys:
        print(f'明文与 DPAPI 内容一致（{len(keys)} 条），只清理明文。')
    else:
        secrets_store.store_wechat_keys(store, keys, account=account, source='migrated-from-plain')
        print(f'已把 {len(keys)} 条密钥（账号 {account}）加密写入 {store}')
    removed = delete_plain_cache()
    print('已删除明文缓存：' + ('、'.join(removed) if removed else '（无）'))
    return 0


def cmd_scan(args) -> int:
    """【需要用户授权】跑一次解锁，允许读微信进程内存，然后把密钥收进 DPAPI。"""
    src = db_lab_src()
    if src is None:
        print('找不到取密钥组件（components/wechat-db-lab/src），无法读取。', file=sys.stderr)
        return 2
    sys.path.insert(0, str(src))
    os.environ.pop('WECHAT_DB_LAB_NO_SCAN', None)   # 这一次是用户点过授权的
    from wechat_db_lab import vault as db_vault

    workspace = Path(args.workspace) if args.workspace else (
        Path(os.environ.get('LOCALAPPDATA', '.')) / 'wechat-db-lab' / 'vault')
    print(f'正在读取微信密钥（会读一次微信进程内存）…工作目录：{workspace}')
    result = db_vault.unlock(workspace_root=workspace, force=args.force)
    resolved = getattr(result, 'resolved', None)
    total = getattr(result, 'total', None)
    print(f'解锁结果：{resolved}/{total} 个数据库' if resolved is not None else '解锁完成')

    plain = read_plain_cache()
    if not plain:
        print('这次没有拿到可用密钥。常见原因：微信没登录，或密钥缓存与当前数据库不匹配。', file=sys.stderr)
        return 3
    account, keys = plain
    store = credentials_dir() / secrets_store.WECHAT_KEYS_FILE
    secrets_store.store_wechat_keys(store, keys, account=account, source='user-authorized-scan')
    removed = delete_plain_cache()
    print(f'已把 {len(keys)} 条密钥加密保存到 {store}')
    print('已删除明文缓存：' + ('、'.join(removed) if removed else '（无）'))
    return 0


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='微信数据库密钥的保管与授权扫描')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status', help='看现在有什么密钥')
    sub.add_parser('migrate', help='明文缓存 -> DPAPI 并删除明文')
    scan = sub.add_parser('scan', help='【用户授权】读取一次微信密钥')
    scan.add_argument('--workspace', default=None, help='解锁工作目录（默认 wechat-db-lab 的 vault）')
    scan.add_argument('--force', action='store_true', help='强制重新解锁（忽略 source 未变）')
    args = parser.parse_args(argv)
    return {'status': cmd_status, 'migrate': cmd_migrate, 'scan': cmd_scan}[args.command](args)


if __name__ == '__main__':
    raise SystemExit(main())
