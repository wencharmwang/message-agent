r"""解开引擎归档，并把符号链接补回来（Windows 专用）。

## 为什么需要这个

引擎用 pnpm 装依赖，`node_modules` 里塞满了**符号链接**（实测 18,697 个）。
归档是 `tar` 打的，链接原样存着；到了 Windows 上：

* 系统 `tar.exe` 解不动 —— 路径 300+ 字符，在 `\\?\` 上报 `Invalid argument`
* Python `tarfile` 也解不动 —— 建到某个深层文件时 `FileNotFoundError`
  （链接指向的目录没建出来，下面的文件自然没地方落）

## 这个脚本怎么做

1. **先解普通成员**（目录 + 文件，不带链接）—— 这样不会因为链接卡住
2. **再建链接**：
   * 目标是**目录** → 建 **junction**（DeviceIoControl，不需要管理员权限，
     实测 331 字符的路径也能建；而且只是"指过去"，不复制内容）
   * 目标是**文件** → 直接复制（文件链接很少，复制最稳）
   * 目标不存在（悬空链接）→ 记下来跳过，不算失败
3. 有问题就打印清单并以非 0 退出，让安装脚本能中止

用法：
    python extract_engine.py <归档路径> <解到哪>
"""
from __future__ import annotations

import ctypes
import os
import shutil
import struct
import sys
import tarfile
from ctypes import wintypes

# ---- Win32：直接建 junction（reparse point） -------------------------------
# 以前的实现是每个链接 spawn 一次 `cmd /c mklink /J`：18,697 个链接就是 1.8 万次
# 子进程，安装要多花好几分钟；而且 cmd 按 ANSI 代码页解释参数，客户路径带中文
# （C:\Users\璐璐\...）时 mklink 直接报 Invalid switch（实测 2,786 个全灭，每个
# 还要退回整目录复制）。改成 DeviceIoControl 纯调用后：没有子进程、没有代码页
# 问题；长路径用 \\?\ 前缀，300+ 字符也没事。
_FSCTL_SET_REPARSE_POINT = 0x000900A4
_IO_REPARSE_TAG_MOUNT_POINT = 0xA0000003
_GENERIC_WRITE = 0x40000000
_FILE_SHARE_READ = 0x00000001
_FILE_SHARE_WRITE = 0x00000002
_OPEN_EXISTING = 3
_FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
_FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000

_kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
_CreateFileW = _kernel32.CreateFileW
_CreateFileW.restype = wintypes.HANDLE
_CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                         ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
_DeviceIoControl = _kernel32.DeviceIoControl
_DeviceIoControl.restype = wintypes.BOOL
_DeviceIoControl.argtypes = [wintypes.HANDLE, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD,
                             ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
_CloseHandle = _kernel32.CloseHandle
_CloseHandle.argtypes = [wintypes.HANDLE]


def _make_junction(link_path: str, target: str) -> None:
    """把 link_path 建成指向 target 的 junction。失败抛 OSError（调用方退回复制）。"""
    target = os.path.abspath(target)
    os.mkdir(link_path)                      # junction 的载体必须先是一个空目录
    # 布局对照过 mklink 建的真实 junction（fsutil reparsepoint query）：
    #   SubstituteNameLength/PrintNameLength 都是**不含**结尾 \0 的字节数，
    #   \0 只作为分隔落在 PathBuffer 里，PrintNameOffset = SubstituteNameLength + 2。
    subst = ('\\??\\' + target).encode('utf-16-le')    # NT 命名空间目标（\??\ 前缀）
    printable = target.encode('utf-16-le')            # 资源管理器显示名
    path_buffer = subst + b'\x00\x00' + printable + b'\x00\x00'
    blob = struct.pack('<IHHHHHH',
                       _IO_REPARSE_TAG_MOUNT_POINT,
                       8 + len(path_buffer),     # ReparseDataLength：4 个 WORD + 名字区
                       0,                        # Reserved
                       0,                        # SubstituteNameOffset
                       len(subst),               # SubstituteNameLength（不含 \0）
                       len(subst) + 2,           # PrintNameOffset（跳过 \0）
                       len(printable)) + path_buffer
    handle = _CreateFileW('\\\\?\\' + os.path.abspath(link_path), _GENERIC_WRITE,
                          _FILE_SHARE_READ | _FILE_SHARE_WRITE, None, _OPEN_EXISTING,
                          _FILE_FLAG_BACKUP_SEMANTICS | _FILE_FLAG_OPEN_REPARSE_POINT, None)
    if not handle or handle == -1:
        raise OSError(ctypes.get_last_error(), f'CreateFileW({link_path}) 失败')
    try:
        returned = wintypes.DWORD(0)
        ok = _DeviceIoControl(handle, _FSCTL_SET_REPARSE_POINT, blob, len(blob),
                              None, 0, ctypes.byref(returned), None)
        if not ok:
            raise OSError(ctypes.get_last_error(),
                           f'DeviceIoControl(FSCTL_SET_REPARSE_POINT) 失败：{link_path}')
    except OSError:
        try:
            os.rmdir(link_path)                # 别留下空目录，调用方会退回复制
        except OSError:
            pass
        raise
    finally:
        _CloseHandle(handle)


def _link_or_copy(link_path: str, target: str) -> str:
    """目录链接：优先 junction，失败就退回复制（Python 自己的文件 API 中文、长路径都没问题）。"""
    try:
        _make_junction(link_path, target)
        return 'junction'
    except OSError:
        shutil.copytree(target, link_path, symlinks=False, dirs_exist_ok=False)
        return '复制'


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print('用法: extract_engine.py <归档> <目标目录>')
        return 2
    source, dest = argv[1], argv[2]
    os.makedirs(dest, exist_ok=True)

    with tarfile.open(source) as tf:
        members = tf.getmembers()
        # tar 里有两种"链接"，语义完全不同，别混：
        #   islnk() = **硬链接**：linkname 是**相对归档根**的路径（同一个文件的另一份名字）
        #   issym() = 符号链接：linkname 可能是相对**链接所在目录**的路径
        # 上一版把硬链接当符号链接解析，链接目标全成了
        #   ...\zod\python\sdk-runtime\src\... 这种垃圾路径 —— 18,697 个全没建出来。
        hard = [m for m in members if m.islnk()]
        syms = [m for m in members if m.issym()]
        plain = [m for m in members if not m.islnk() and not m.issym()]
        print(f'    归档 {len(members):,} 个成员：普通 {len(plain):,}，硬链接 {len(hard):,}，符号链接 {len(syms):,}')

        # ① 先解普通成员。不带链接，tarfile 就不会卡在"链接目录下的文件"上。
        print('    正在解开普通文件…', flush=True)
        tf.extractall(path=dest, members=plain)

        # ② 再补链接
        print('    正在重建链接…', flush=True)
        failed: list[tuple[str, str]] = []
        stats = {'目录链接→junction': 0, '目录链接→复制': 0, '文件硬链接': 0,
                 '符号链接(junction)': 0, '符号链接(复制)': 0, '已存在': 0}

        def _fix_path(name: str, base_dir: str) -> str:
            return name if os.path.isabs(name) else os.path.normpath(os.path.join(base_dir, name))

        for index, member in enumerate(hard + syms, 1):
            link_path = os.path.join(dest, member.name)
            try:
                os.makedirs(os.path.dirname(link_path), exist_ok=True)
                if os.path.exists(link_path):
                    stats['已存在'] += 1
                    continue
                if member.islnk():
                    # 注意：tar 里的"硬链接"**可能是目录**（pnpm 的 node_modules 里那些
                    # 包目录就是）。NTFS 不允许给目录建硬链接 —— 必须用 junction。
                    # 第一次没区分，18,697 个里普遍失败，连带 tsx/package.json 缺失，
                    # 引擎直接跑不起来（实测：退出码 1，tsx 缺）。
                    target = os.path.join(dest, member.linkname)
                    if os.path.isdir(target):
                        stats['目录链接→' + _link_or_copy(link_path, target)] += 1
                    elif os.path.isfile(target):
                        os.link(target, link_path)                # 文件硬链接：不占空间、不需要权限
                        stats['文件硬链接'] += 1
                    else:
                        failed.append((member.name, f'硬链接目标不存在: {target}'))
                else:
                    target = _fix_path(member.linkname, os.path.dirname(link_path))
                    if os.path.isdir(target):
                        stats['符号链接(' + _link_or_copy(link_path, target) + ')'] += 1
                    elif os.path.isfile(target):
                        shutil.copy2(target, link_path)
                        stats['符号链接(复制)'] += 1
                    else:
                        failed.append((member.name, f'符号链接目标不存在: {target}'))
            except Exception as error:                            # noqa: BLE001 - 逐条容错
                failed.append((member.name, str(error)))
            if index % 4000 == 0:
                print(f'      …{index:,}/{len(hard) + len(syms):,}', flush=True)

    print('    ' + '，'.join(f'{k} {v:,}' for k, v in stats.items()))
    if failed:
        print(f'    ✗ {len(failed)} 个链接没建成功：', file=sys.stderr)
        for name, reason in failed[:10]:
            print(f'      {name}\n        {reason}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
