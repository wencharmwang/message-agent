"""微信数据库密钥的命令行入口（安装程序与用户脚本用）。

真正的逻辑在 ``agent_worker/wechat_keys.py`` —— 界面上的"读取微信密钥"按钮走的是
Worker 里那份，**同一份代码**。这里只负责解析参数、准备好运行环境、打印结果。

用法：
    python wechat_keys.py status    看现在有什么密钥
    python wechat_keys.py migrate   明文缓存 -> DPAPI 并删除明文（安装时调用）
    python wechat_keys.py scan      【用户授权】读取一次（允许读微信进程内存）
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
# 找到产品代码：安装目录（脚本与 app/ 同级）或开发仓库根目录。
for candidate in (HERE, HERE / 'app', HERE.parent / 'app', HERE.parent):
    if (candidate / 'agent_worker' / 'wechat_keys.py').exists():
        sys.path.insert(0, str(candidate))
        break
else:  # pragma: no cover - 只在安装不完整时
    print('找不到 agent_worker/wechat_keys.py，安装可能不完整。', file=sys.stderr)
    raise SystemExit(2)

from agent_worker import wechat_keys as keys  # noqa: E402


def db_lab_src() -> Path | None:
    """取密钥组件（wechat-db-lab）的源码目录。"""
    for candidate in (HERE / 'components' / 'wechat-db-lab' / 'src',
                      HERE.parent / 'components' / 'wechat-db-lab' / 'src'):
        if (candidate / 'wechat_db_lab' / '__init__.py').exists():
            return candidate
    env = os.environ.get('MESSAGE_AGENT_DBLAB_SRC')
    if env and (Path(env) / 'wechat_db_lab' / '__init__.py').exists():
        return Path(env)
    return None


def build_context(args) -> keys.Context:
    data_dir = HERE.parent / 'data'
    credentials = Path(os.environ.get('MESSAGE_AGENT_CREDENTIALS') or (data_dir / 'credentials'))
    run_dir = Path(os.environ.get('MESSAGE_AGENT_RUN_DIR') or (data_dir / 'run'))
    if getattr(args, 'workspace', None):
        workspace = Path(args.workspace)
    else:
        base = os.environ.get('LOCALAPPDATA') or os.environ.get('USERPROFILE') or '.'
        workspace = Path(base) / 'wechat-db-lab' / 'vault'
    return keys.Context(credentials_dir=credentials, db_lab_src=db_lab_src(),
                        workspace=workspace, run_dir=run_dir)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='微信数据库密钥的保管与授权读取')
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('status', help='看现在有什么密钥')
    sub.add_parser('migrate', help='明文缓存 -> DPAPI 并删除明文')
    scan = sub.add_parser('scan', help='【用户授权】读取一次微信密钥')
    scan.add_argument('--workspace', default=None, help='解锁工作目录（默认 wechat-db-lab 的 vault）')
    scan.add_argument('--force', action='store_true', help='强制重新解锁（忽略源库未变）')
    args = parser.parse_args(argv)
    ctx = build_context(args)

    if args.command == 'status':
        print(json.dumps(keys.status(ctx), ensure_ascii=False, indent=2))
        return 0
    if args.command == 'migrate':
        result = keys.migrate(ctx)
        print(result.get('message') or '完成')
        if result.get('removed'):
            print('已删除明文缓存：' + '、'.join(result['removed']))
        return 0
    result = keys.scan(ctx, force=args.force)
    print(result.get('message') or '完成')
    if result.get('resolved') is not None:
        print(f"解锁结果：{result.get('resolved')}/{result.get('total')} 个数据库")
    if result.get('removed'):
        print('已删除明文缓存：' + '、'.join(result['removed']))
    return 0 if result.get('ok') else 3


if __name__ == '__main__':
    raise SystemExit(main())
