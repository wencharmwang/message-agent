"""由模板生成运行配置。

为什么不让 PowerShell 直接拼 JSON：Windows 路径里的反斜杠在 JSON 里必须写成 `\\`，
字符串替换出来的 `"C:\\Users\\..."` 是**非法 JSON**（实测：装完直接启动失败，且是必现）。

也不能"先替换文本再整体解析" —— 替换进去的值本身带反斜杠，照样会把 JSON 弄坏
（第二版就是这么挂的）。正确做法是**先解析模板，再在已解析的字符串里替换占位符**，
最后由 json.dump 负责转义。

用法：
    python make_config.py <模板> <输出路径> <替换值 JSON>
"""

from __future__ import annotations

import io
import json
import sys

PLACEHOLDER_KEYS = ('ENGINE_ROOT', 'RUNTIME_DATA', 'DATA_DIR', 'CREDENTIALS_DIR', 'LOGS_DIR',
                    'HARNESS_HOME', 'WORKSPACE', 'NODE_EXE', 'PYTHON_EXE', 'DBLAB_SRC')


def substitute(node, values, used):
    """在已解析的结构里替换 {KEY}，用到的键记进 used。"""
    if isinstance(node, dict):
        return {key: substitute(value, values, used) for key, value in node.items()}
    if isinstance(node, list):
        return [substitute(item, values, used) for item in node]
    if isinstance(node, str):
        text = node
        for key in PLACEHOLDER_KEYS:
            token = '{' + key + '}'
            if token in text:
                text = text.replace(token, str(values[key]))
                used.add(key)
        return text
    return node


def main() -> int:
    if len(sys.argv) != 4:
        print('用法: make_config.py <模板> <输出> <替换值 JSON>', file=sys.stderr)
        return 2
    template_path, out_path, values_path = sys.argv[1:4]

    with io.open(template_path, encoding='utf-8-sig') as handle:
        try:
            config = json.load(handle)
        except json.JSONDecodeError as error:
            print(f'配置模板本身不是合法 JSON：{error}', file=sys.stderr)
            return 1
    with io.open(values_path, encoding='utf-8-sig') as handle:
        values = json.load(handle)

    missing = [key for key in PLACEHOLDER_KEYS if key not in values]
    if missing:
        print('替换值里缺少这些键：' + '、'.join(missing), file=sys.stderr)
        return 1

    used = set()
    filled = substitute(config, values, used)
    leftover = sorted(set(PLACEHOLDER_KEYS) - used)
    if leftover:
        print('模板里没有用到这些占位符（模板和脚本可能不匹配）：' + '、'.join(leftover), file=sys.stderr)

    # 路径统一成正斜杠形式交给 Windows API 也是可以的，但为了配置可读、可人工核对，
    # 这里保持反斜杠；转义由 json.dump 负责。
    with io.open(out_path, 'w', encoding='utf-8') as handle:
        json.dump(filled, handle, ensure_ascii=False, indent=2)
        handle.write('\n')

    # 自检：写出来的东西必须能读回来，且关键字段非空。
    with io.open(out_path, encoding='utf-8') as handle:
        written = json.load(handle)
    for key in ('harness_root', 'node_executable', 'watcher_python', 'database', 'control_token_file'):
        if not written.get(key):
            print(f'生成的配置里 {key} 是空的。', file=sys.stderr)
            return 1
    print(f'配置已生成：{out_path}')
    print(f'  引擎：{written["harness_root"]}')
    print(f'  数据库：{written["database"]}')
    print(f'  端口：control={written["control_port"]} harness={written["harness_port"]}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
