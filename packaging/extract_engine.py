"""解开引擎归档，并把符号链接补回来（Windows 专用）。

## 为什么需要这个

引擎用 pnpm 装依赖，`node_modules` 里塞满了**符号链接**（实测 18,697 个）。
归档是 `tar` 打的，链接原样存着；到了 Windows 上：

* 系统 `tar.exe` 解不动 —— 路径 300+ 字符，在 `\\?\` 上报 `Invalid argument`
* Python `tarfile` 也解不动 —— 建到某个深层文件时 `FileNotFoundError`
  （链接指向的目录没建出来，下面的文件自然没地方落）

## 这个脚本怎么做

1. **先解普通成员**（目录 + 文件，不带链接）—— 这样不会因为链接卡住
2. **再建链接**：
   * 目标是**目录** → 建 **junction**（`mklink /J`）
     —— 关键：junction **不需要管理员权限**，实测 331 字符的路径也能建；
       而且它只是"指过去"，不复制内容，空间和原归档一样
   * 目标是**文件** → 直接复制（文件链接很少，复制最稳）
   * 目标不存在（悬空链接）→ 记下来跳过，不算失败
3. 有问题就打印清单并以非 0 退出，让安装脚本能中止

用法：
    python extract_engine.py <归档路径> <解到哪>
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tarfile


def _decode(raw: bytes) -> str:
    return (raw or b'').decode('gbk', errors='replace').strip()


def _make_junction(link_path: str, target: str) -> None:
    # os.path.abspath：mklink 的目标最好给绝对路径，相对路径的基准是当前目录，容易错。
    result = subprocess.run(['cmd', '/c', 'mklink', '/J', link_path, os.path.abspath(target)],
                            capture_output=True)
    if result.returncode != 0:
        raise OSError(_decode(result.stdout) or _decode(result.stderr) or f'mklink 退出码 {result.returncode}')


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
        stats = {'目录链接→junction': 0, '文件硬链接': 0, '符号链接(junction)': 0, '符号链接(复制)': 0, '已存在': 0}

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
                        _make_junction(link_path, target)
                        stats['目录链接→junction'] += 1
                    elif os.path.isfile(target):
                        os.link(target, link_path)                # 文件硬链接：不占空间、不需要权限
                        stats['文件硬链接'] += 1
                    else:
                        failed.append((member.name, f'硬链接目标不存在: {target}'))
                else:
                    target = _fix_path(member.linkname, os.path.dirname(link_path))
                    if os.path.isdir(target):
                        _make_junction(link_path, target)
                        stats['符号链接(junction)'] += 1
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
