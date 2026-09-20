"""本机密钥保管：Windows DPAPI（`crypt32.dll`）加密/解密。

为什么不用 `win32crypt`/`keyring`：实测本机这两个包都没装，而 `ctypes` 是标准库。
少一个依赖就少一处"用户装不上"的可能。

**能挡住什么，挡不住什么（必须说清楚，别给人虚假的安全感）**：

* 挡住 —— 别的 Windows 用户读这份文件；文件被拷到别的机器或云盘（没有对应用户的
  主密钥解不开）；
* **挡不住** —— 同一个 Windows 用户下运行的其他程序。DPAPI 绑定的是"用户"，不是"进程"。
  要做到同用户下也读不到，得用需要用户在场的保护（Windows Hello / DPAPI-NG），那是另一个量级。

所以这里的定位是：**消除明文落盘**（备份、误发、别的账号都拿不到），而不是"同机绝对保密"。
"""

from __future__ import annotations

import base64
import ctypes
import json
import os
from ctypes import wintypes
from datetime import datetime, timezone
from pathlib import Path


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')

# UI 交互禁止：服务是后台进程，弹不出也不该弹任何窗口。
CRYPTPROTECT_UI_FORBIDDEN = 0x1


class _DataBlob(ctypes.Structure):
    _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> _DataBlob:
    buffer = ctypes.create_string_buffer(data, len(data))
    return _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char)))


def _crypt32():
    return ctypes.WinDLL('crypt32', use_last_error=True)


def _kernel32():
    return ctypes.WinDLL('kernel32', use_last_error=True)


def _take(blob: _DataBlob) -> bytes:
    try:
        return ctypes.string_at(blob.pbData, blob.cbData)
    finally:
        _kernel32().LocalFree(blob.pbData)


def protect(data: bytes, entropy: bytes | None = None) -> bytes:
    """加密。`entropy` 是可选第二因子：加了之后光有本机用户还不够，还得有这段字节。"""
    out = _DataBlob()
    ok = _crypt32().CryptProtectData(
        ctypes.byref(_blob(data)), None,
        ctypes.byref(_blob(entropy)) if entropy else None, None, None,
        CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out))
    if not ok:
        raise OSError(ctypes.get_last_error(), 'CryptProtectData 失败')
    return _take(out)


def unprotect(data: bytes, entropy: bytes | None = None) -> bytes:
    """解密。换用户、换机器、entropy 不对都会失败 —— 这正是我们要的。"""
    out = _DataBlob()
    ok = _crypt32().CryptUnprotectData(
        ctypes.byref(_blob(data)), None,
        ctypes.byref(_blob(entropy)) if entropy else None, None, None,
        CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(out))
    if not ok:
        raise OSError(ctypes.get_last_error(), 'CryptUnprotectData 失败（可能换了用户/机器，或文件被改过）')
    return _take(out)


# `.dat` 文件格式：一行 base64 的 DPAPI 密文。用文件而不是注册表，便于连同数据一起备份。
def write_secret(path: str | Path, payload: dict, entropy: bytes | None = None) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    sealed = base64.b64encode(protect(raw, entropy)).decode('ascii')
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(sealed, encoding='ascii')
    os.replace(temp, path)


def read_secret(path: str | Path, entropy: bytes | None = None) -> dict | None:
    """读不到就返回 None（不存在 / 解不开都算"没有"，由调用方决定是否重新获取）。"""
    path = Path(path)
    try:
        # validate=True：默认的宽松模式会**悄悄丢掉**不属于 base64 的字符，
        # 于是一个被改过的文件可能"看起来还能解"（实测踩到）。宁可拒绝，不要猜。
        sealed = base64.b64decode(path.read_text(encoding='ascii').strip(), validate=True)
    except (OSError, ValueError):
        return None
    try:
        return json.loads(unprotect(sealed, entropy).decode('utf-8'))
    except (OSError, ValueError):
        return None


def has_secret(path: str | Path) -> bool:
    return Path(path).exists()


# --------------------------------------------------------------------------
# 微信数据库密钥
#
# 明文形态是 `{「库相对路径」: 「64 位十六进制密钥」}`（wechat-db-lab 的 KeyVault 格式）。
# 这里不改变它的内容，只是整份加密保存 —— 上游组件（wechat-db-lab）照旧按"目录"读，
# 由启动器在运行时解密到一个**本次运行专用的目录**里。
# --------------------------------------------------------------------------
WECHAT_KEYS_FILE = 'wechat-keys.dat'


def store_wechat_keys(path: str | Path, keys: dict, *, account: str, source: str = '') -> None:
    """保存微信数据库密钥。

    只多存一个**账号名**（wechat-db-lab 的密钥缓存是按账号分文件的，运行时要把文件写成
    `<账号>.json`）和一个**保存时间**（界面要显示"上次读取：几号几点"）。
    密钥内容原样保存，不改上游组件的格式。
    """
    write_secret(path, {'version': 1, 'account': account, 'source': source,
                        'saved_at': _now(), 'keys': keys})


def load_wechat_keys(path: str | Path) -> tuple[str, dict, str] | None:
    """返回 (账号名, 密钥表, 保存时间)。读不到或格式不对返回 None。"""
    payload = read_secret(path)
    if not payload or not isinstance(payload.get('keys'), dict) or not payload['keys']:
        return None
    return (str(payload.get('account') or 'account'), payload['keys'],
            str(payload.get('saved_at') or ''))

