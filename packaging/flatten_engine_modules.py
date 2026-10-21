"""把 pnpm deploy 的产物拍平 + 补齐引擎运行时闭包（Windows 专用）。

## 为什么需要

`pnpm deploy --legacy` 产出的 node_modules 是 pnpm 布局：顶层是符号链接，
实体在 `.pnpm/` 容器里，每个容器包的依赖以兄弟链接存在。引擎启动时
`healProfilesModuleFallback` 会从安装锚点 BFS 依赖图（deps + peers），
往 `$DSH_HOME/profiles/node_modules` 写 fallback 链接 —— loader 行是从
临时 profile 目录 import 的，靠这棵 fallback 树解析包名。

问题：BFS 用 `createRequire(anchor).resolve.paths()`，而 anchor 是**符号链接
的文本路径** —— Node 从链接位置向上找 node_modules，永远走不进 `.pnpm`
容器，于是 BFS 建不全闭包，fallback 树缺包，loader 报
"Cannot find package '@deepseek-ai/dsh-xxx'"，还会顺着开发机上的源码仓
node_modules 解析到 TS 源码（然后死在 Node strip 模式不支持的语法上）。

另外 pnpm deploy 的闭包本身也不全：上游若干包把运行时 import 的包写成
peer+dev 依赖（如 app-boot 的 cordis-plugin-group），deploy 不装它们。

## 这个脚本怎么做

1. **拍平**：把 `.pnpm` 里的实体 + 顶层链接全部解引用复制成
   `node_modules/<name>` 真实目录，删掉 `.pnpm`。之后任何路径的 walk-up
   都能命中顶层，BFS 闭包自动完整。
2. **补齐**：解析 web profile 的 bundle patch
   （packages/bundle/{base,web-app}/cordis.patch.yml）里所有 `name:` 插件包，
   缺的从源码仓（pnpm 隐藏 hoist / workspace）复制 package.json + lib/；
   再沿 deps+peers 迭代到不动点。源码仓的 src/ 一律不带（构建产物模式下
   只应该加载 lib）。

用法:
    python flatten_engine_modules.py <deploy目录> <引擎源码仓目录>
    python flatten_engine_modules.py --prune <deploy目录> <引擎源码仓目录>
      （--prune 对已拍平的部署目录就地裁剪：删黑名单包 + 孤儿包，不动其它内容）
"""
from __future__ import annotations

import json
import os
import re
import shutil
import sys

# ── 运行时永不需要的包（按完整名或 "<scope>/" 前缀匹配）─────────────────────
#
# 为什么会有这些包：pnpm deploy 的隐藏 hoist 层（node_modules/.pnpm/node_modules）
# 把**整个 workspace** 的 dev 依赖也提升上来了；_flatten 又照单全收。实测 545MB /
# 45,714 个文件里约一半是它们：mermaid 80MB、@rolldown 30MB、typescript 23MB、
# @oxlint+@oxlint-tsgolint 36MB、lefthook 14MB、vitest+happy-dom+jsdom（6600+ 文件）、
# eslint 全家、@aws-sdk 全家 40MB…… 引擎运行时代码对它们**零引用**（逐包验证过：
# 现存运行时包的 dependencies/peerDependencies 没有任何一个以这些包为运行时入口；
# pi-ai 的 lib 里连 aws-sdk 字符串都没有；mermaid/cytoscape 等前端图表已 bundle 进
# dsh-web-frontend 的 dist，服务端不加载）。
#
# 黑名单只放"机制上不可能被运行时加载"的：
#   * 构建/lint/测试/git-hook 工具链 —— 编译期才用；
#   * *.d.ts-only 纯类型包 —— Node require 永不加载 .d.ts；
#   * 文档图表前端库 —— 已 bundle 进前端 dist；
#   * @aws-sdk —— pi-ai 运行时零引用，且本产品不走 Bedrock。
# 运行时可能用到的（koffi/sharp/@opentelemetry/@lexical/@xterm/@vscode-ripgrep/
# octokit/anthropic/openai/genai/typebox/hono …）一个都不在名单里。
RUNTIME_EXCLUDE = [
    # 构建 / 打包工具链
    'typescript', 'ts-api-utils', 'tsconfck', 'tsdown', 'tsx',
    'rolldown', '@rolldown', 'rolldown-plugin-dts', 'ast-kit', 'magicast',
    'esbuild', '@esbuild',
    'lightningcss', 'lightningcss-win32-x64', 'lightningcss-win32-x64-msvc',
    'vite', '@vitejs', 'vite-tsconfig-paths', 'unconfig-core', '@quansync',
    'oxc-parser', '@oxc-parser', '@oxc-project',
    # lint / 静态检查
    'eslint', '@eslint', '@eslint-community', '@typescript-eslint',
    '@stylistic', 'eslint-plugin-sonarjs', '@antfu',
    'oxlint', '@oxlint', '@oxlint-tsgolint',
    '@humanfs', '@humanwhocodes', 'knip', 'publint', '@publint',
    'jscpd', 'jscpd-windows-x64', 'jscpd-windows-x64-msvc',
    # git hooks
    'lefthook', 'lefthook-windows-x64',
    # 测试框架（及其 DOM 模拟器，文件数的大头）
    'vitest', '@vitest', 'happy-dom', 'jsdom', '@testing-library',
    # 纯类型包
    '@types', '@octokit/openapi-types', '@octokit/openapi-webhooks-types',
    # 文档图表前端库（已 bundle 进 dsh-web-frontend/dist）
    'mermaid', '@mermaid-js', 'cytoscape', 'cytoscape-fcose', 'cytoscape-cose-bilkent',
    'katex', '@upsetjs', '@iconify', '@braintree', '@chevrotain', 'es-toolkit',
    # AWS Bedrock：pi-ai 运行时代码零引用，产品模型也不走 Bedrock
    '@aws-sdk', '@smithy', '@aws-crypto', '@aws',
    # 其它构建期工具（pnpm hoist 混入）
    '@yarnpkg',
]


def _excluded(name: str) -> bool:
    """包名是否命中运行时黑名单（完整名或 '<scope>/' 前缀）。"""
    for b in RUNTIME_EXCLUDE:
        if name == b or name.startswith(b + '/'):
            return True
    return False


# 引擎自家生态包：一律不做"孤儿"判定。它们只有几十 MB，但 cordis 的 loader
# 会按 profile 清单 + 运行时动态加载（package.json 之外的引用关系无从静态穷举），
# 删错的代价是起不来。dev 工具链的体积大头全在第三方包上，这里保守不亏。
ENGINE_HOME_PREFIXES = ('@deepseek-ai/', '@earendil-works/')


def _engine_home(name: str) -> bool:
    return any(name.startswith(p) for p in ENGINE_HOME_PREFIXES)


def _rmtree(path: str) -> bool:
    r"""长路径安全的目录删除。

    shutil.rmtree 对超长路径（node_modules 深层随手超过 260 字符）会失败，
    而之前 ignore_errors=True 把错误吞了 —— 报告"删除 166 个包"实际一个没删
    （实测踩到）。用 \\?\ 前缀声明长路径后再删，失败如实返回 False。
    """
    p = os.path.abspath(path)
    if os.name == 'nt' and not p.startswith('\\\\?\\'):
        p = '\\\\?\\' + p
    try:
        shutil.rmtree(p)
        return True
    except OSError:
        return False


# 运行时代码就在 src/ 里的注册表包（main/exports 指向 src，或 index.js require ./src）。
# koffi 的 JS 包装器在 src/koffi/（package.json 里看不出来，实测踩过）；debug/node-pty/sharp 同类。
# 除此之外一律不带 src —— workspace 包的 src 是 TS 源码，运行时只走 lib。
NATIVE_SRC_ALLOWLIST = {'koffi', 'debug', 'node-pty', 'sharp'}

_SKIP_DIRS = ('node_modules', 'tests', 'docs', '.git', 'artifacts', 'website',
              'dist-exe', 'snapshots', 'coverage', '.dsh-build', 'src')
_SKIP_SUFFIX = ('.tsbuildinfo', '.spec.ts', '.map')


def _copy_pkg(src: str, dst: str, allow_src: bool = False) -> None:
    """复制一个包的运行时内容（package.json + lib/ 等，跳过 tests/src/.map）。

    src/ 默认跳过：workspace 包的 src 是 TS 源码，运行时只走 lib。仅白名单包
    （NATIVE_SRC_ALLOWLIST，运行时代码真的在 src 的注册表包）保留。
    *.map 是 sourcemap，纯调试用，一个 113MB/6千个文件，运行时不需要。
    """
    os.makedirs(dst, exist_ok=True)
    root_real = os.path.realpath(src)
    for entry in os.listdir(src):
        if entry == 'src':
            if not allow_src:
                continue
        elif entry in _SKIP_DIRS:
            continue
        elif entry.endswith(_SKIP_SUFFIX):
            continue
        s = os.path.join(src, entry)
        # 越界防护：包目录里可能有指向外面的链接（实测 vendor/schemastery 下混进过
        # 部署垃圾目录）。解引用复制只能发生在包根内部，走到外面就跳过。
        if not (os.path.realpath(s) == root_real
                or os.path.realpath(s).startswith(root_real + os.sep)):
            continue
        if not os.path.exists(s):
            continue  # 悬空链接，跳过
        d = os.path.join(dst, entry)
        if os.path.isdir(s):
            # symlinks=False：全部解引用成真实文件（拍平的意义所在）。
            # 链接要么指进 .pnpm（马上要删），要么指源码仓（绝不能带进部署目录）。
            shutil.copytree(s, d, dirs_exist_ok=True, symlinks=False)
        else:
            shutil.copy2(s, d)


def _repair_src(deploy: str, engine: str) -> list[str]:
    """给拍平后的树补白名单包的 src/（旧版脚本曾把 src 一刀切跳过/一刀切全带）。

    只补 NATIVE_SRC_ALLOWLIST 里的包（koffi 等，运行时代码真的在 src）。
    """
    nm = os.path.join(deploy, 'node_modules')
    repaired: list[str] = []
    for name in _existing_names(nm):
        short = name.rsplit('/', 1)[-1]
        if short not in NATIVE_SRC_ALLOWLIST:
            continue
        target = os.path.join(nm, *name.split('/'))
        if os.path.isdir(os.path.join(target, 'src')):
            continue
        src = _source_pkg_dir(engine, name)
        if src is None or not os.path.isdir(os.path.join(src, 'src')):
            continue
        shutil.copytree(os.path.join(src, 'src'), os.path.join(target, 'src'),
                        dirs_exist_ok=True, symlinks=False)
        repaired.append(name)
    return repaired


def _flatten(deploy: str) -> None:
    nm = os.path.join(deploy, 'node_modules')
    # 已经拍平过（没有 .pnpm、顶层也没有链接）就别再整体复制一遍。
    if not os.path.isdir(os.path.join(nm, '.pnpm')) and not any(
            os.path.islink(os.path.join(nm, e)) or os.path.isjunction(os.path.join(nm, e))
            for e in os.listdir(nm)):
        print('    node_modules 已是扁平布局，跳过拍平')
        return
    staged = os.path.join(deploy, 'node_modules.flat')
    if os.path.isdir(staged):
        if not _rmtree(staged):
            raise OSError(f'清理 {staged} 失败（长路径/占用？），先手动删掉再跑')
    os.makedirs(staged)

    def _place(name: str, src: str) -> None:
        # name 可能带 scope（@deepseek-ai/x）。黑名单里的包连复制都不复制。
        if _excluded(name):
            return
        dst = os.path.join(staged, *name.split('/'))
        if not os.path.exists(dst):
            _copy_pkg(src, dst, allow_src=name.rsplit('/', 1)[-1] in NATIVE_SRC_ALLOWLIST)

    # ① 隐藏 hoist：.pnpm/node_modules/<name>（链接，解引用后是实体）
    hoist = os.path.join(nm, '.pnpm', 'node_modules')
    if os.path.isdir(hoist):
        for scope in os.listdir(hoist):
            sp = os.path.join(hoist, scope)
            if scope.startswith('@') and os.path.isdir(sp):
                for name in os.listdir(sp):
                    if os.path.isdir(os.path.join(sp, name)):
                        _place(f'{scope}/{name}', os.path.join(sp, name))
            elif os.path.isdir(sp):
                _place(scope, sp)
    # ② 顶层：node_modules/<name>（可能是链接指向 .pnpm 容器；.modules.yaml 等元文件跳过）
    for scope in os.listdir(nm):
        if scope == '.pnpm' or scope.startswith('.'):
            continue
        sp = os.path.join(nm, scope)
        if scope.startswith('@') and os.path.isdir(sp):
            for name in os.listdir(sp):
                if os.path.isdir(os.path.join(sp, name)):
                    _place(f'{scope}/{name}', os.path.join(sp, name))
        elif os.path.isdir(sp):
            _place(scope, sp)
    # ③ 换掉
    if not _rmtree(nm):
        raise OSError(f'清理旧 node_modules 失败（长路径/占用？）：{nm}')
    os.rename(staged, nm)


def _plugin_roster(engine: str) -> set[str]:
    """web profile 的插件包名清单：base + web-app 两个 bundle 的 patch 里所有 name:。"""
    names: set[str] = set()
    for bundle in ('base', 'web-app'):
        path = os.path.join(engine, 'packages', 'bundle', bundle, 'cordis.patch.yml')
        if not os.path.isfile(path):
            continue
        text = open(path, encoding='utf-8').read()
        names.update(re.findall(r"name:\s*'([^']+)'", text))
    return {n for n in names if not n.startswith('cordis:') and not n.startswith('.')}


def _source_pkg_dir(engine: str, name: str) -> str | None:
    """在源码仓里找包的真实目录：隐藏 hoist → 根 node_modules → 全仓 package.json 名匹配。"""
    candidates = [
        os.path.join(engine, 'node_modules', '.pnpm', 'node_modules', *name.split('/')),
        os.path.join(engine, 'node_modules', *name.split('/')),
    ]
    for c in candidates:
        if os.path.isfile(os.path.join(c, 'package.json')):
            return os.path.realpath(c)
    # workspace 包兜底：按 package.json 的 name 扫（vendor/*、packages/*/*）
    for root, dirs, files in os.walk(os.path.join(engine, 'packages')):
        dirs[:] = [d for d in dirs if d not in ('node_modules', 'lib', 'src', 'tests', '.git')]
        if 'package.json' in files:
            try:
                if json.load(open(os.path.join(root, 'package.json'), encoding='utf-8')).get('name') == name:
                    return os.path.realpath(root)
            except Exception:  # noqa: BLE001 - 扫描容错
                pass
    for root, dirs, files in os.walk(os.path.join(engine, 'vendor')):
        dirs[:] = [d for d in dirs if d not in ('node_modules', 'lib', 'src', 'tests', '.git')]
        if 'package.json' in files:
            try:
                if json.load(open(os.path.join(root, 'package.json'), encoding='utf-8')).get('name') == name:
                    return os.path.realpath(root)
            except Exception:  # noqa: BLE001
                pass
    return None


def _existing_names(nm: str) -> list[str]:
    """扁平 node_modules 里已有的全部包名。"""
    names: list[str] = []
    for scope in os.listdir(nm):
        sp = os.path.join(nm, scope)
        if scope.startswith('@') and os.path.isdir(sp):
            for name in os.listdir(sp):
                if os.path.isfile(os.path.join(sp, name, 'package.json')):
                    names.append(f'{scope}/{name}')
        elif os.path.isfile(os.path.join(sp, 'package.json')):
            names.append(scope)
    return names


def _complete(deploy: str, engine: str) -> list[str]:
    """按 profile 清单 + **全部**已存在包的 deps/peers 迭代补齐缺包。

    注意必须遍历已存在包的 peer 依赖：Service Definition 类契约包
    （dsh-credentials、dsh-sandbox、dsh-compaction …）是实现包的 peer，
    从来不是谁的 dependencies —— 只遍历"新复制包"会漏掉它们，运行时报
    "Cannot find package '@deepseek-ai/dsh-credentials'"（实测踩到）。
    """
    nm = os.path.join(deploy, 'node_modules')
    copied: list[str] = []
    queue = list(_plugin_roster(engine)) + _existing_names(nm)
    seen = set(queue)
    while queue:
        name = queue.pop()
        if name.startswith('node:') or name == 'dsh-profile-web':
            continue
        if _excluded(name):
            # 黑名单里的包不复制，也不再展开它们的依赖（vitest→happy-dom、
            # @lexical→typescript(peer) 就是这么被拉回来的）。
            continue
        target = os.path.join(nm, *name.split('/'))
        manifest_path = os.path.join(target, 'package.json')
        manifest = None
        if os.path.isfile(manifest_path):
            try:
                manifest = json.load(open(manifest_path, encoding='utf-8'))
            except Exception:  # noqa: BLE001
                manifest = None
        else:
            src = _source_pkg_dir(engine, name)
            if src is None:
                print(f'    [!] 源码仓里找不到 {name}，跳过（若运行时报缺再处理）')
                continue
            short = name.rsplit('/', 1)[-1]
            _copy_pkg(src, target, allow_src=short in NATIVE_SRC_ALLOWLIST)
            copied.append(name)
            try:
                manifest = json.load(open(os.path.join(target, 'package.json'), encoding='utf-8'))
            except Exception:  # noqa: BLE001
                manifest = None
        if manifest is None:
            continue
        deps = list((manifest.get('dependencies') or {}).keys()) \
            + list((manifest.get('peerDependencies') or {}).keys())
        for dep in deps:
            if dep not in seen:
                seen.add(dep)
                queue.append(dep)
    return copied


def _prune(deploy: str, engine: str) -> int:
    """对已拍平的部署目录就地裁剪：删黑名单包 + "引用者全灭"的孤儿包。

    孤儿判定是保守的：一个包只要被**任何一个**存活包的
    dependencies/peerDependencies/optionalDependencies 引用，或者出现在
    根引用里（deploy 根 package.json 的依赖、web profile 插件清单、
    lib/*.js 静态 import 的裸包名），就不会被删。也就是说：能从"运行时
    入口"沿 package.json 依赖图走到的包一律保留；删掉的只有构建产物闭包
    之外、被 pnpm hoist 混进来的 dev 工具链及其孤儿依赖。
    """
    nm = os.path.join(deploy, 'node_modules')
    if not os.path.isdir(nm):
        print(f'没有 node_modules，不是部署目录？{nm}', file=sys.stderr)
        return 1
    # --prune 只对**拍平后的布局**安全：pnpm 布局里顶层条目是链接，
    # rmtree 一个 junction 在 Windows 上会伤到链接目标的实体，必须拒绝。
    if os.path.isdir(os.path.join(nm, '.pnpm')) or any(
            os.path.islink(os.path.join(nm, e)) or os.path.isjunction(os.path.join(nm, e))
            for e in os.listdir(nm)):
        print('    node_modules 还是 pnpm 布局（有 .pnpm/符号链接），先跑一次不带 --prune 的拍平。', file=sys.stderr)
        return 1

    def package_dirs() -> list[str]:
        out: list[str] = []
        for e in os.listdir(nm):
            p = os.path.join(nm, e)
            if e.startswith('@') and os.path.isdir(p):
                out += [f'{e}/{s}' for s in os.listdir(p) if os.path.isdir(os.path.join(p, s))]
            elif os.path.isdir(p):
                out.append(e)
        return out

    def stats(name: str) -> tuple[int, int]:
        files = bytes_ = 0
        for root, _dirs, fs in os.walk(os.path.join(nm, *name.split('/'))):
            files += len(fs)
            for f in fs:
                try:
                    bytes_ += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return files, bytes_

    before_files, before_bytes = 0, 0
    for name in package_dirs():
        f, b = stats(name)
        before_files += f
        before_bytes += b

    # ── 1. 删黑名单 ──────────────────────────────────────────────────────
    black_killed: list[str] = []
    black_failed: list[str] = []
    black_files = black_bytes = 0
    for name in package_dirs():
        if _excluded(name):
            f, b = stats(name)
            if _rmtree(os.path.join(nm, *name.split('/'))):
                black_killed.append(name)
                black_files += f
                black_bytes += b
            else:
                black_failed.append(name)
    print(f'    黑名单删除 {len(black_killed)} 个包：'
          f'{black_files:,} 个文件 / {black_bytes / 1048576:.0f} MB', flush=True)
    if black_failed:
        print(f'    [!] 删不掉的黑名单包 {len(black_failed)} 个：'
              f'{", ".join(black_failed[:8])}（可能有文件被占用）', flush=True)

    # ── 2. 根引用（虚拟根，永远存活）─────────────────────────────────────
    roots: set[str] = set()
    root_pj = os.path.join(deploy, 'package.json')
    if os.path.isfile(root_pj):
        try:
            m = json.load(open(root_pj, encoding='utf-8'))
            roots |= set((m.get('dependencies') or {}).keys())
            roots |= set((m.get('peerDependencies') or {}).keys())
            # 根 package.json 的 name（CLI 自身会以包名出现在 node_modules 里，
            # inject 布局）绝不能当孤儿删。
            if m.get('name'):
                roots.add(m['name'])
        except Exception:  # noqa: BLE001
            print('    [!] deploy 根 package.json 读不了，根引用只有插件清单 + lib 扫描', flush=True)
    roots |= _plugin_roster(engine)
    # lib/*.js 是构建产物入口：它静态 require/import 的裸包名也算根引用，
    # 防止入口直接 import、但不在根 package.json 依赖表里的包被误删。
    spec_re = re.compile(r"""(?:require\(\s*|import\s*\(?\s*|from\s+)['"]([^'"]+)['"]""")
    lib_dir = os.path.join(deploy, 'lib')
    if os.path.isdir(lib_dir):
        for f in os.listdir(lib_dir):
            if not f.endswith('.js'):
                continue
            text = open(os.path.join(lib_dir, f), encoding='utf-8', errors='replace').read()
            for spec in spec_re.findall(text):
                if spec.startswith(('.', '/', 'node:')):
                    continue
                parts = spec.split('/')
                roots.add('/'.join(parts[:2]) if spec.startswith('@') else parts[0])

    # ── 3. 迭代删孤儿 ────────────────────────────────────────────────────
    # 引擎自家包（@deepseek-ai/@earendil-works）不做孤儿判定（见 ENGINE_HOME_PREFIXES）；
    # 删不掉的包记入 failed，避免"删不掉 → 下轮还是孤儿"的死循环。
    orphan_files = orphan_bytes = 0
    orphan_killed: list[str] = []
    failed: set[str] = set()
    while True:
        alive = set(_existing_names(nm))
        referrers: dict[str, set[str]] = {name: set() for name in alive}
        for name in alive:
            try:
                m = json.load(open(os.path.join(nm, *name.split('/'), 'package.json'), encoding='utf-8'))
            except Exception:  # noqa: BLE001
                continue
            for sec in ('dependencies', 'peerDependencies', 'optionalDependencies'):
                for dep in (m.get(sec) or {}):
                    if dep in referrers:
                        referrers[dep].add(name)
        orphans = [name for name in alive
                   if not referrers[name] and name not in roots
                   and not _engine_home(name) and name not in failed]
        if not orphans:
            break
        for name in sorted(orphans):
            f, b = stats(name)
            if _rmtree(os.path.join(nm, *name.split('/'))):
                orphan_killed.append(name)
                orphan_files += f
                orphan_bytes += b
            else:
                failed.add(name)
        print(f'    本轮孤儿 {len(orphans)} 个：{", ".join(sorted(orphans)[:12])}'
              + (' …' if len(orphans) > 12 else ''), flush=True)
    if failed:
        print(f'    [!] 删不掉的孤儿 {len(failed)} 个：{", ".join(sorted(failed)[:8])}', flush=True)

    after_files, after_bytes = 0, 0
    for name in package_dirs():
        f, b = stats(name)
        after_files += f
        after_bytes += b
    print(f'    裁剪完成：黑名单 {len(black_killed)} 个包（{black_files:,} 文件 / '
          f'{black_bytes / 1048576:.0f} MB）+ 孤儿 {len(orphan_killed)} 个包'
          f'（{orphan_files:,} 文件 / {orphan_bytes / 1048576:.0f} MB）', flush=True)
    print(f'    node_modules：{before_files:,} -> {after_files:,} 个文件，'
          f'{before_bytes / 1048576:.0f} -> {after_bytes / 1048576:.0f} MB', flush=True)
    return 0


def main(argv: list[str]) -> int:
    if len(argv) == 4 and argv[1] == '--prune':
        deploy, engine = argv[2], argv[3]
        if not os.path.isfile(os.path.join(deploy, 'lib', 'bin.js')):
            print(f'不是 deploy 目录（缺 lib/bin.js）：{deploy}', file=sys.stderr)
            return 1
        return _prune(deploy, engine)
    if len(argv) != 3:
        print('用法: flatten_engine_modules.py <deploy目录> <引擎源码仓目录>')
        print('      flatten_engine_modules.py --prune <deploy目录> <引擎源码仓目录>')
        return 2
    deploy, engine = argv[1], argv[2]
    if not os.path.isfile(os.path.join(deploy, 'lib', 'bin.js')):
        print(f'不是 deploy 目录（缺 lib/bin.js）：{deploy}', file=sys.stderr)
        return 1
    print('    拍平 node_modules（解引用复制实体）…', flush=True)
    _flatten(deploy)
    print('    按 web profile 清单补齐缺包…', flush=True)
    copied = _complete(deploy, engine)
    print(f'    补齐 {len(copied)} 个包：{", ".join(copied) if copied else "（无）"}')
    repaired = _repair_src(deploy, engine)
    if repaired:
        print(f'    补回 src/ 的包：{", ".join(repaired)}')
    nm = os.path.join(deploy, 'node_modules')
    top = sum(1 for _ in os.scandir(nm))
    print(f'    node_modules 顶层 {top} 项（扁平、无符号链接）')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
