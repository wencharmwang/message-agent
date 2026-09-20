"""把本地模型（Ollama）接进引擎的 settings.yaml —— install-local-model.ps1 用它。

真正的实现在 ``agent_worker/model_providers.py``：**界面上的"模型"卡片走的是同一份**
（那里还有 OpenAI / Claude / 通义 / 智谱 / Kimi 等预设）。界面能选、命令行也能用，
两边不会各写一套规则。

用法：
    python set_local_provider.py --settings <settings.yaml> --model qwen2.5:7b [--name 本地模型]
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
for candidate in (HERE, HERE / 'app', HERE.parent / 'app', HERE.parent):
    if (candidate / 'agent_worker' / 'model_providers.py').exists():
        sys.path.insert(0, str(candidate))
        break
else:  # pragma: no cover - 只在安装不完整时
    print('找不到 agent_worker/model_providers.py，安装可能不完整。', file=sys.stderr)
    raise SystemExit(2)

from agent_worker import model_providers as providers  # noqa: E402


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description='把本地模型接进引擎配置')
    parser.add_argument('--settings', required=True, help='settings.yaml 的完整路径')
    parser.add_argument('--model', required=True, help='Ollama 里的模型名，如 qwen2.5:7b')
    parser.add_argument('--name', default='', help='界面上显示的名字（默认"本地模型（Ollama）"）')
    parser.add_argument('--dry-run', action='store_true', help='只看结果，不写文件')
    args = parser.parse_args(argv)

    provider = providers.resolve('ollama-local')
    if provider is None:
        print('供应商目录里没有 ollama-local，安装可能不完整。', file=sys.stderr)
        return 2
    if args.dry_run:
        import io
        text = io.open(args.settings, encoding='utf-8-sig').read()
        merged = providers.upsert_provider(
            text.splitlines(), name=provider.id, display_name=args.name or provider.name,
            api=provider.api, base_url=provider.base_url, key_env=provider.key_env,
            models=[{'id': args.model, 'name': args.model, 'contextWindow': 32768, 'maxTokens': 2048}])
        print('\n'.join(merged))
        return 0
    try:
        message = providers.apply_provider(args.settings, provider,
                                           model=args.model, display_name=args.name)
    except FileNotFoundError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(message)
    print(f'  本地模型：{args.model}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
