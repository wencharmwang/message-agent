"""微信数据库密钥：读取、保管、状态查询。

三件事在这里，界面和命令行都调它（不再各写一份）：

* ``status``  —— 现在有没有可用密钥、上次什么时候读的、明文的残留有没有清干净；
* ``migrate`` —— 把 wechat-db-lab 的明文密钥缓存收进 DPAPI，并删掉明文与 .bak；
* ``scan``    —— **需要用户授权**的一次读取：跑一次解锁（允许读微信进程内存），
  成功后存进 DPAPI 并清掉明文。

为什么要单独一个模块：Worker 要在收到界面的"读取密钥"请求时直接调用它（同进程，
不用再起一个 python），安装程序则通过 ``packaging/wechat_keys.py`` 这个薄壳调用。
逻辑只有一份，行为才不会两边漂。
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from . import secrets_store


@dataclass
class Context:
    """一次调用需要的路径。由调用方解析（Worker 用 config，CLI 用环境变量）。"""

    credentials_dir: Path
    db_lab_src: Path | None = None
    workspace: Path | None = None
    # 运行时用的那份密钥副本放在哪（<run_dir>/keys）。
    # 迁移时要**跳过它** —— 那是应用自己正在用的工作副本，不是历史残留；
    # 把它删了会让正在跑的 watcher 立刻失去密钥（虽然它被禁止读内存，不会越界，
    # 但会白等一轮）。
    run_dir: Path | None = None

    @property
    def store_path(self) -> Path:
        return self.credentials_dir / secrets_store.WECHAT_KEYS_FILE

    @property
    def runtime_keys_dir(self) -> Path | None:
        return (self.run_dir / 'keys') if self.run_dir else None


def default_plain_dirs(context: Context | None = None, *, include_runtime: bool = True) -> list[Path]:
    """wechat-db-lab 可能放明文密钥的地方（含历史版本写过的那处）。

    ``include_runtime`` 区分**读**和**删**两种情况：

    * 读（扫描后要把刚取到的密钥收进 DPAPI）**必须包含**运行时目录 ——
      那正是 wechat-db-lab 写入的位置；
    * 删（清理历史残留）**必须排除**它 —— 那是应用自己在用的工作副本，
      删了会让正在跑的 watcher 立刻失去密钥。

    第一版把两者都排除了，结果扫描完读不到密钥、报"这次没有拿到可用密钥"（实测踩到）。
    """
    runtime = context.runtime_keys_dir if context else None
    dirs: list[Path] = []
    override = os.environ.get('WECHAT_DB_LAB_KEYS_DIR')
    if override:
        dirs.append(Path(override))
    base = os.environ.get('LOCALAPPDATA') or os.environ.get('USERPROFILE')
    if base:
        dirs.append(Path(base) / 'wechat-db-lab' / 'keys')
    if include_runtime or runtime is None:
        return dirs
    return [d for d in dirs if d != runtime]


def plain_cache_files(context: Context | None = None, *, include_runtime: bool = True) -> list[Path]:
    seen: set[Path] = set()
    found: list[Path] = []
    for directory in default_plain_dirs(context, include_runtime=include_runtime):
        if not directory.exists():
            continue
        for item in sorted(directory.glob('*.json*')):
            if item not in seen:
                seen.add(item)
                found.append(item)
    return found


def read_plain_cache(context: Context | None = None, *, include_runtime: bool = True) -> tuple[str, dict] | None:
    """从明文缓存里读出 (账号, 密钥表)。跳过 .bak（那是上一次次优副本）。

    ``include_runtime=False`` 只读"历史残留"那一层，用于向用户报告还剩多少明文。
    """
    for path in plain_cache_files(context, include_runtime=include_runtime):
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


def delete_plain_cache(context: Context | None = None) -> list[str]:
    """清掉历史残留。**不动运行时那份**（见 default_plain_dirs 的说明）。"""
    removed: list[str] = []
    for path in plain_cache_files(context, include_runtime=False):
        try:
            path.unlink()
            removed.append(path.name)
        except OSError:
            pass
    return removed


def status(context: Context) -> dict:
    """给界面用的状态。**只报数量和指纹级别的事实，绝不返回密钥内容。**"""
    stored = secrets_store.load_wechat_keys(context.store_path)
    # plainCount 只数历史残留：运行时那份工作副本不算（否则界面会一直挂着一条假警报）
    leftover = read_plain_cache(context, include_runtime=False)
    return {
        'configured': bool(stored),
        'account': stored[0] if stored else None,
        'keyCount': len(stored[1]) if stored else 0,
        'savedAt': (stored[2] or None) if stored else None,
        'plainCache': [str(p) for p in plain_cache_files(context, include_runtime=False)],
        'plainCount': len(leftover[1]) if leftover else 0,
    }


def migrate(context: Context) -> dict:
    """明文缓存 -> DPAPI，并删除明文。幂等。"""
    existing = secrets_store.load_wechat_keys(context.store_path)
    plain = read_plain_cache(context)
    if not plain:
        removed = delete_plain_cache(context)
        return {'ok': True, 'action': 'none', 'message': '没有找到可迁移的明文密钥',
                'keyCount': len(existing[1]) if existing else 0, 'removed': removed}
    account, keys = plain
    if existing and existing[1] == keys:
        message = f'明文与已保存的内容一致（{len(keys)} 条），只清理明文'
    else:
        secrets_store.store_wechat_keys(context.store_path, keys, account=account, source='migrated-from-plain')
        message = f'已把 {len(keys)} 条密钥（账号 {account}）加密写入 {context.store_path}'
    removed = delete_plain_cache(context)
    return {'ok': True, 'action': 'migrate', 'message': message, 'keyCount': len(keys), 'removed': removed}


def scan(context: Context, *, force: bool = False) -> dict:
    """**用户授权**的一次读取：允许扫内存，成功后进 DPAPI。

    这个函数只会被"用户点了按钮 / 跑了脚本"这条路径调用 —— 日常启动走的是
    launch.py 里读 DPAPI 存储那条路，从不碰微信进程内存。
    """
    if context.db_lab_src is None:
        return {'ok': False, 'message': '找不到取密钥组件（wechat-db-lab）'}
    if str(context.db_lab_src) not in sys.path:
        sys.path.insert(0, str(context.db_lab_src))
    os.environ.pop('WECHAT_DB_LAB_NO_SCAN', None)   # 这一次是用户点过授权的
    try:
        from wechat_db_lab import vault as db_vault
    except Exception as error:                      # pragma: no cover - 只在组件缺失时
        return {'ok': False, 'message': f'取密钥组件不可用：{error}'}

    try:
        result = db_vault.unlock(workspace_root=context.workspace, force=force)
    except Exception as error:
        return {'ok': False, 'message': f'读取失败：{error}'}
    report = getattr(result, 'keys', None)
    resolved = getattr(report, 'resolved', None) if report is not None else None
    total = getattr(report, 'total', None) if report is not None else None
    databases = len(getattr(result, 'databases', None) or [])

    plain = read_plain_cache(context)
    if not plain:
        return {'ok': False, 'message': '这次没有拿到可用密钥（微信没登录，或不匹配）',
                'resolved': resolved, 'total': total, 'databases': databases}
    account, keys = plain
    secrets_store.store_wechat_keys(context.store_path, keys, account=account, source='user-authorized-scan')
    removed = delete_plain_cache(context)
    return {'ok': True, 'action': 'scan', 'account': account, 'keyCount': len(keys),
            'resolved': resolved, 'total': total, 'databases': databases, 'removed': removed,
            'message': f'已读取并加密保存 {len(keys)} 条密钥'}
