"""密钥保管的单元测试：状态、迁移、以及"绝不留下明文"。

``scan`` 不在单测范围里 —— 它要真的去读微信进程内存，只能人工验证。
这里覆盖的是每一次安装、每一次启动都会走的那条路。
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from . import secrets_store, wechat_keys


class WeChatKeysTest(unittest.TestCase):
    def setUp(self):
        self.temp = Path(tempfile.mkdtemp(prefix='ma-keys-'))
        self.credentials = self.temp / 'credentials'
        self.credentials.mkdir(parents=True, exist_ok=True)
        self.plain = self.temp / 'plain-keys'
        self.plain.mkdir(parents=True, exist_ok=True)
        self._previous = os.environ.get('WECHAT_DB_LAB_KEYS_DIR')
        os.environ['WECHAT_DB_LAB_KEYS_DIR'] = str(self.plain)
        self.context = wechat_keys.Context(credentials_dir=self.credentials)
        self.keys = {'session/session.db': 'a' * 64, 'contact/contact.db': 'b' * 64}

    def tearDown(self):
        if self._previous is None:
            os.environ.pop('WECHAT_DB_LAB_KEYS_DIR', None)
        else:
            os.environ['WECHAT_DB_LAB_KEYS_DIR'] = self._previous

    def write_plain(self, *, with_backup=True):
        target = self.plain / 'wxid_test_f30e.json'
        target.write_text(json.dumps(self.keys), encoding='utf-8')
        if with_backup:
            (self.plain / 'wxid_test_f30e.json.bak').write_text(json.dumps(self.keys), encoding='utf-8')
        return target

    def test_status_reports_nothing_configured_on_a_fresh_machine(self):
        status = wechat_keys.status(self.context)
        self.assertFalse(status['configured'])
        self.assertEqual(status['keyCount'], 0)
        self.assertEqual(status['plainCache'], [])
        # 状态里永远不能出现密钥内容
        self.assertNotIn('a' * 64, json.dumps(status))

    def test_migrate_moves_plain_cache_into_dpapi_and_deletes_plaintext(self):
        plain = self.write_plain()
        result = wechat_keys.migrate(self.context)
        self.assertTrue(result['ok'])
        self.assertEqual(result['keyCount'], len(self.keys))
        self.assertFalse(plain.exists(), '迁移后明文必须删掉')
        self.assertFalse((self.plain / 'wxid_test_f30e.json.bak').exists(), '明文备份也要删掉')
        self.assertFalse(list(self.plain.glob('*.json*')), '明文目录里不该再有东西')

        stored = secrets_store.load_wechat_keys(self.context.store_path)
        self.assertIsNotNone(stored)
        account, keys, saved_at = stored
        self.assertEqual(account, 'wxid_test_f30e')
        self.assertEqual(keys, self.keys)
        self.assertTrue(saved_at, '要记下保存时间，界面得显示"上次读取"')
        # 磁盘上不能有明文密钥
        self.assertNotIn(b'a' * 64, self.context.store_path.read_bytes())

    def test_migrate_is_idempotent(self):
        self.write_plain(with_backup=False)
        first = wechat_keys.migrate(self.context)
        second = wechat_keys.migrate(self.context)
        self.assertEqual(first['keyCount'], len(self.keys))
        self.assertTrue(second['ok'])
        self.assertEqual(second['action'], 'none')
        self.assertEqual(secrets_store.load_wechat_keys(self.context.store_path)[1], self.keys)

    def test_status_after_migrate_shows_configured_without_plain_leftovers(self):
        self.write_plain(with_backup=False)
        wechat_keys.migrate(self.context)
        status = wechat_keys.status(self.context)
        self.assertTrue(status['configured'])
        self.assertEqual(status['keyCount'], len(self.keys))
        self.assertEqual(status['account'], 'wxid_test_f30e')
        self.assertEqual(status['plainCount'], 0)

    def test_scan_without_component_reports_a_readable_reason(self):
        # 组件缺失时不能抛异常出去（界面要点得动、看得懂）
        result = wechat_keys.scan(self.context)
        self.assertFalse(result['ok'])
        self.assertIn('找不到取密钥组件', result['message'])

    def test_migrate_never_touches_the_runtime_copy(self):
        """运行时那份密钥是应用自己在用的，不是历史残留。

        这条是回归测试：迁移一旦把它删掉，正在跑的 watcher 会立刻失去密钥。
        """
        runtime = self.temp / 'run' / 'keys'
        runtime.mkdir(parents=True, exist_ok=True)
        (runtime / 'wxid_test_f30e.json').write_text(json.dumps(self.keys), encoding='utf-8')
        context = wechat_keys.Context(credentials_dir=self.credentials, run_dir=self.temp / 'run')
        self.write_plain(with_backup=False)

        result = wechat_keys.migrate(context)

        self.assertIn('wxid_test_f30e.json', result['removed'], '历史残留要被清掉')
        self.assertTrue((runtime / 'wxid_test_f30e.json').exists(), '运行时副本不能动')
        self.assertNotIn(str(runtime / 'wxid_test_f30e.json'), wechat_keys.status(context)['plainCache'])


if __name__ == '__main__':
    unittest.main()
