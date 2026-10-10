"""隔离边界的测试：本项目**只读已解锁产物**，不接触密钥与解密。

这个文件钉住两件事：

1. **协议校验**（`UnlockedSource.validate`）—— 产物不合格时要给出可执行的错误消息，
   而不是含糊的"读不到消息"；
2. **隔离本身**（源码级守卫）—— 仓库里不许再出现解密相关的 import，
   安装包也不许再打包解密组件。这条是"风险隔离"能否成立的硬证据，
   而且它能防止以后有人（或 AI）不小心加回去。

合成产物用标准 `sqlite3` 现造，**不需要 wechat-db-lab、不需要真微信** ——
这正是隔离后的测试形态。
"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from agent_worker.unlocked_source import UnlockedRootError, UnlockedSource

REPO_ROOT = Path(__file__).resolve().parent.parent
DECRYPT_MODULES = ('keyextract', 'winmem', 'sqlcipher4', 'vault', 'decrypt')


def _make_plain_db(path: Path, *, kind: str = 'other') -> None:
    """造一个合法的最小明文 SQLite。

    注意两件事：
    * **必须建至少一张表**：sqlite3 只在写入第一页时才写文件头，只 connect 不建表会留下
      0 字节文件 —— 文件头校验当然过不去（第一版就是这么写的，测试反而证明了校验有效）。
    * `contact` 与 `session` 要给出真实列名，否则 `poll()` 里的查询会报 no such table。
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    if kind == 'session':
        connection.execute(
            'CREATE TABLE SessionTable (username TEXT, type INTEGER, unread_count INTEGER, '
            'summary TEXT, draft TEXT, is_hidden INTEGER, last_timestamp INTEGER, '
            'sort_timestamp INTEGER, last_msg_locald_id INTEGER, last_msg_type INTEGER, '
            'last_msg_sender INTEGER, last_sender_display_name TEXT)')
    elif kind == 'contact':
        connection.execute(
            'CREATE TABLE contact (username TEXT, nick_name TEXT, remark TEXT, alias TEXT, '
            'local_type INTEGER, delete_flag INTEGER, description TEXT, big_head_url TEXT)')
    else:
        connection.execute('CREATE TABLE placeholder (id INTEGER PRIMARY KEY)')
    connection.commit()
    connection.close()


def build_unlocked_root(root: Path, *, manifest_extra: dict | None = None,
                        skip: str | None = None, corrupt: str | None = None) -> Path:
    """按 docs/unlocked-db-protocol.md 造一个产物目录。"""
    rels = {
        'contact': 'contact/contact.db',
        'session': 'session/session.db',
        'message': 'message/message_0.db',
    }
    databases = []
    for kind, rel in rels.items():
        if kind == skip:
            continue
        output = root / 'plain' / rel
        if kind == corrupt:
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_bytes(b'not a sqlite file at all' * 4)
        else:
            _make_plain_db(output, kind=kind)
        databases.append({'rel': rel, 'output': str(output), 'status': 'decrypted',
                          'source': {'size': output.stat().st_size, 'mtime_ns': 1}})
    manifest = {'manifest_version': 1, 'account': 'wxid_a', 'created_at': '2026-10-10T00:00:00Z',
                'databases': databases}
    manifest.update(manifest_extra or {})
    (root / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False), encoding='utf-8')
    return root


class ProtocolValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def _validate(self, root: Path) -> dict:
        source = UnlockedSource(root)
        manifest = source.validate()
        self.assertTrue(source.ready())
        return manifest

    def test_valid_product_passes(self):
        build_unlocked_root(self.root)
        source = UnlockedSource(self.root)
        manifest = source.validate()
        self.assertEqual(manifest['account'], 'wxid_a')
        self.assertEqual(len(manifest['databases']), 3)
        # created_at 是校验通过后才记下来的，所以要在同一个实例上读
        self.assertEqual(source.created_at(), '2026-10-10T00:00:00Z')
        self.assertTrue(source.ready())

    def test_missing_root_is_reported_clearly(self):
        source = UnlockedSource(None)
        self.assertFalse(source.ready())
        self.assertIn('还没有配置', source.last_error())

    def test_missing_manifest_is_reported_clearly(self):
        source = UnlockedSource(self.root)
        self.assertFalse(source.ready())
        self.assertIn('manifest.json', source.last_error())

    def test_wrong_version_is_rejected(self):
        build_unlocked_root(self.root, manifest_extra={'manifest_version': 99})
        source = UnlockedSource(self.root)
        self.assertFalse(source.ready())
        self.assertIn('manifest_version', source.last_error())

    def test_missing_required_kind_lists_what_is_missing(self):
        build_unlocked_root(self.root, skip='session')
        source = UnlockedSource(self.root)
        self.assertFalse(source.ready())
        self.assertIn('session', source.last_error())

    def test_non_plaintext_database_is_rejected(self):
        """产物没解开 / 被截断时，要明确说"不是明文库"，别让用户去猜。"""
        build_unlocked_root(self.root, corrupt='contact')
        source = UnlockedSource(self.root)
        self.assertFalse(source.ready())
        self.assertIn('不是', source.last_error())

    def test_poll_returns_baseline_first_then_events(self):
        """首次只建基线（历史消息不当新消息），之后才产出 —— 与旧 watcher 语义一致。"""
        build_unlocked_root(self.root)
        source = UnlockedSource(self.root)
        self.addCleanup(source.close)      # 不关会锁住产物文件，临时目录删不掉（Windows）
        self.assertEqual(source.poll(), [], '首次 poll 必须只建基线')
        # 第二轮：没有新消息，仍为空（且不抛异常）
        self.assertEqual(source.poll(), [])

    def test_poll_without_product_does_not_raise(self):
        """产物不可用只记错误、不抛异常 —— tick 不能被它打断。"""
        source = UnlockedSource(None)
        self.assertEqual(source.poll(), [])
        self.assertIn('还没有配置', source.last_error())


class IsolationGuardTests(unittest.TestCase):
    """源码级守卫：把"不碰解密"这条边界钉死，防止以后回退。"""

    def test_no_decrypt_imports_in_runtime_code(self):
        offenders = []
        for path in sorted((REPO_ROOT / 'agent_worker').rglob('*.py')):
            text = path.read_text(encoding='utf-8')
            for lineno, line in enumerate(text.splitlines(), start=1):
                stripped = line.strip()
                if not (stripped.startswith('import ') or stripped.startswith('from ')):
                    continue
                if any(module in stripped for module in DECRYPT_MODULES):
                    offenders.append(f'{path.relative_to(REPO_ROOT)}:{lineno}: {stripped}')
        self.assertEqual(offenders, [], '运行时代码里不该再出现解密相关的 import：\n' + '\n'.join(offenders))

    def test_no_decrypt_imports_at_entrypoints(self):
        for name in ('launch.py',):
            text = (REPO_ROOT / name).read_text(encoding='utf-8')
            for module in DECRYPT_MODULES:
                self.assertNotIn(f'import {module}', text)

    def test_installer_does_not_package_decrypt_component(self):
        """安装包不许再携带解密组件 —— 包里带着，就等于你仍在分发手段。"""
        for name in ('build-package.ps1', 'install.ps1'):
            text = (REPO_ROOT / 'packaging' / name).read_text(encoding='utf-8')
            self.assertNotIn('wechat-db-lab', text,
                             f'{name} 里仍引用私有解密库')
            self.assertNotIn('wechat_keys', text, f'{name} 里仍引用取密钥脚本')

    def test_reader_package_is_self_contained(self):
        """vendored 读库包必须能独立存在：不能 import 任何解密模块。"""
        reader = REPO_ROOT / 'agent_worker' / 'wechat_reader'
        offenders = []
        for path in sorted(reader.rglob('*.py')):
            for lineno, line in enumerate(path.read_text(encoding='utf-8').splitlines(), start=1):
                stripped = line.strip()
                if not (stripped.startswith('import ') or stripped.startswith('from ')):
                    continue
                if any(module in stripped for module in DECRYPT_MODULES):
                    offenders.append(f'{path.name}:{lineno}')
        self.assertEqual(offenders, [], '读库包不该依赖解密模块：' + ', '.join(offenders))


if __name__ == '__main__':
    unittest.main()
