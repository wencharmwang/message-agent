"""把本地模型（Ollama）作为一个 provider 接进引擎的 settings.yaml。

为什么是"行级合并"而不是 yaml.load/dump：**这台机器上任何 python 都没有 PyYAML**
（自带的 embeddable python 更不会有），所以不能指望解析器。好在要写的东西结构固定、缩进固定，
按行插入是可控的；写完之后由引擎自己告诉我们成不成（页面的模型列表会多出"本地模型"）。

安全规则：
* 一个顶层键只能出现一次（引擎的解析器开了 uniqueKeys），所以**不能**在文件末尾再追加一个
  `llm-pi-ai:`；必须并到已有的那一段里。
* 已经存在 `ollama-local` 就只更新 models 段，不重复插入。
* 改之前先备份 settings.yaml。
"""

from __future__ import annotations

import argparse
import io
import shutil
import sys
from pathlib import Path

PROVIDER_KEY = 'ollama-local'
HEADER = 'llm-pi-ai:'

# 缩进层级（YAML 两个空格一层）
L_TOP = 0
L_PROVIDERS = 2        # 在 llm-pi-ai 下
L_PROVIDER = 4         # 在 providers 下
L_FIELD = 6            # 在 ollama-local 下
L_LIST = 8             # models 列表项
L_ITEM_FIELD = 10      # 列表项的字段


def indent(level: int) -> str:
    return ' ' * level


def provider_block(model: str, display_name: str, context_window: int, max_tokens: int) -> list[str]:
    return [
        indent(L_PROVIDER) + PROVIDER_KEY + ':',
        indent(L_FIELD) + 'displayName: ' + display_name,
        indent(L_FIELD) + 'apiKeyEnv: OLLAMA_LOCAL_API_KEY',
        indent(L_FIELD) + 'api: openai-completions',
        indent(L_FIELD) + 'baseURL: http://127.0.0.1:11434/v1',
        indent(L_FIELD) + 'models:',
        indent(L_LIST) + '- name: ' + model,
        indent(L_ITEM_FIELD) + 'contextWindow: ' + str(context_window),
        indent(L_ITEM_FIELD) + 'maxTokens: ' + str(max_tokens),
        indent(L_ITEM_FIELD) + 'id: ' + model,
    ]


def block_indent(line: str) -> int:
    return len(line) - len(line.lstrip(' '))


def find_top_block(lines: list[str], key: str) -> tuple[int, int] | None:
    """返回顶层键 key 的 [起始行, 结束行) —— 结束行指下一个同级键或文件末尾。"""
    start = None
    for index, line in enumerate(lines):
        if line.startswith(key):
            start = index
            break
    if start is None:
        return None
    end = len(lines)
    for index in range(start + 1, len(lines)):
        line = lines[index]
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        if block_indent(line) <= L_TOP:
            end = index
            break
    return start, end


def model_item(model: str, context_window: int, max_tokens: int) -> list[str]:
    return [
        indent(L_LIST) + '- name: ' + model,
        indent(L_ITEM_FIELD) + 'contextWindow: ' + str(context_window),
        indent(L_ITEM_FIELD) + 'maxTokens: ' + str(max_tokens),
        indent(L_ITEM_FIELD) + 'id: ' + model,
    ]


def merge(existing: list[str], model: str, display_name: str, context_window: int, max_tokens: int) -> list[str]:
    """把模型接进 settings.yaml。

    **只增不删**：已经配好的其它本地模型（比如用户自己建的 qwen-dsh-16k）必须留着 ——
    第一版是整段替换 provider，会把它们抹掉，实际会把正在用的本地模型弄丢。
    """
    found = find_top_block(existing, HEADER)
    if found is None:
        out = list(existing)
        if out and out[-1].strip():
            out.append('')
        out.extend([HEADER, indent(L_PROVIDERS) + 'providers:', indent(L_PROVIDER) + PROVIDER_KEY + ':',
                    indent(L_FIELD) + 'displayName: ' + display_name,
                    indent(L_FIELD) + 'apiKeyEnv: OLLAMA_LOCAL_API_KEY',
                    indent(L_FIELD) + 'api: openai-completions',
                    indent(L_FIELD) + 'baseURL: http://127.0.0.1:11434/v1',
                    indent(L_FIELD) + 'models:'])
        out.extend(model_item(model, context_window, max_tokens))
        return out

    start, end = found
    provider_at = None
    for index in range(start, end):
        if existing[index].strip() == PROVIDER_KEY + ':' and block_indent(existing[index]) == L_PROVIDER:
            provider_at = index
            break

    if provider_at is None:
        # llm-pi-ai 存在但没有这个 provider：插到 providers: 段落末尾
        providers_at = None
        for index in range(start + 1, end):
            if existing[index].strip() == 'providers:' and block_indent(existing[index]) == L_PROVIDERS:
                providers_at = index
                break
        block = [indent(L_PROVIDER) + PROVIDER_KEY + ':',
                 indent(L_FIELD) + 'displayName: ' + display_name,
                 indent(L_FIELD) + 'apiKeyEnv: OLLAMA_LOCAL_API_KEY',
                 indent(L_FIELD) + 'api: openai-completions',
                 indent(L_FIELD) + 'baseURL: http://127.0.0.1:11434/v1',
                 indent(L_FIELD) + 'models:'] + model_item(model, context_window, max_tokens)
        if providers_at is None:
            return existing[:start + 1] + [indent(L_PROVIDERS) + 'providers:'] + block + existing[start + 1:]
        insert_at = end
        for index in range(providers_at + 1, end):
            if existing[index].strip() and block_indent(existing[index]) <= L_PROVIDERS:
                insert_at = index
                break
        return existing[:insert_at] + block + existing[insert_at:]

    # provider 已存在：找到它的 models 列表，按 id 合并
    provider_end = end
    for index in range(provider_at + 1, end):
        if existing[index].strip() and block_indent(existing[index]) <= L_PROVIDER:
            provider_end = index
            break
    models_at = None
    for index in range(provider_at + 1, provider_end):
        if existing[index].strip() == 'models:' and block_indent(existing[index]) == L_FIELD:
            models_at = index
            break
    if models_at is None:
        return existing[:provider_end] + [indent(L_FIELD) + 'models:'] + \
            model_item(model, context_window, max_tokens) + existing[provider_end:]

    # 已有同 id 的模型就替换掉它那几行，否则追加到列表末尾
    item_start = None
    for index in range(models_at + 1, provider_end):
        line = existing[index]
        if line.strip().startswith('- ') and block_indent(line) == L_LIST:
            if item_start is not None:
                break
            if ('id: ' + model) in ' '.join(existing[index:min(index + 6, provider_end)]):
                item_start = index
                break
    if item_start is not None:
        item_end = provider_end
        for index in range(item_start + 1, provider_end):
            if existing[index].strip() and block_indent(existing[index]) <= L_LIST - 1 and \
                    not existing[index].strip().startswith('- '):
                item_end = index
                break
        return existing[:item_start] + model_item(model, context_window, max_tokens) + existing[item_end:]
    return existing[:provider_end] + model_item(model, context_window, max_tokens) + existing[provider_end:]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='把本地模型接进引擎的 settings.yaml')
    parser.add_argument('--settings', required=True, help='settings.yaml 的完整路径')
    parser.add_argument('--model', required=True, help='Ollama 里的模型名，如 qwen2.5:7b')
    parser.add_argument('--name', default='本地模型', help='界面上显示的名字')
    parser.add_argument('--context-window', type=int, default=32768)
    parser.add_argument('--max-tokens', type=int, default=2048)
    parser.add_argument('--dry-run', action='store_true', help='只打印结果，不写文件')
    args = parser.parse_args(argv)

    path = Path(args.settings)
    if not path.exists():
        print(f'找不到 {path}（引擎还没初始化过？先启动一次消息助手）', file=sys.stderr)
        return 1
    original = io.open(path, encoding='utf-8-sig').read()
    lines = original.splitlines()
    merged = merge(lines, args.model, args.name, args.context_window, args.max_tokens)
    text = '\n'.join(merged) + '\n'
    if text == original:
        print('已经是配置好的状态，没有改动。')
        return 0
    if args.dry_run:
        print(text)
        return 0
    shutil.copy2(path, str(path) + '.before-local-model')
    io.open(path, 'w', encoding='utf-8').write(text)
    print(f'已写入 {path}（原文件备份为 settings.yaml.before-local-model）')
    print(f'  本地模型：{args.model}（显示名「{args.name}」）')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
