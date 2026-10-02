"""跨平台护栏。

目标是把 message-agent 的 Python 层搬到 macOS 上跑。下面这几处原来会让程序
**连启动都启动不了**（不是"功能不对"，是"import 就炸"），已经修掉，用测试钉住。

真正的平台差异（发消息走 macOS 版微信自动化、密钥走 Keychain、语音解码器是 exe）
不在这里，见各自的模块说明。
"""
from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

import launch


class PortabilityTests(unittest.TestCase):
    def test_launch_imports_on_any_platform(self):
        """`launch.py` 在模块层 import `process_owner`，所以后者必须到处都能导入。

        原来 `process_owner` 顶部有 `import msvcrt`（而且根本没用到）—— macOS 上没有
        这个模块，于是 `launch.py` 连 import 都过不去，整个启动路径被挡在门外。
        """
        from agent_worker import process_owner
        self.assertTrue(hasattr(process_owner, 'IS_WINDOWS'))
        self.assertNotIn('msvcrt', dir(process_owner), 'msvcrt 是 Windows 独有的')

    def test_launch_resolves_creation_flags_portably(self):
        """`subprocess.CREATE_NO_WINDOW` 只存在于 Windows。

        直接写会在 macOS 上 AttributeError，而它出现在启动路径第一行 Popen 上 ——
        用了 `getattr` 兜底之后，非 Windows 上取 0（也就是不加任何 flag）。
        """
        self.assertEqual(launch.NO_WINDOW, getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        source = Path(launch.__file__).read_text(encoding='utf-8')
        self.assertNotIn('creationflags=subprocess.CREATE_NO_WINDOW', source)

    def test_process_owner_degrades_off_windows(self):
        """非 Windows 上没有 Job Object（对应物是进程组 / launchd），整体降级为空操作。"""
        from agent_worker import process_owner
        from unittest import mock
        with mock.patch.object(process_owner, 'IS_WINDOWS', False):
            self.assertIsNone(process_owner.create_supervisor_job())
            self.assertIsNone(process_owner.SUPERVISOR_JOB)
            process_owner.supervise_child(object())      # 不该抛，也不该碰 ctypes.WinDLL


if __name__ == '__main__':
    unittest.main()
