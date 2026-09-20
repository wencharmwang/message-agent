"""主流模型供应商：目录 + 写进引擎配置。

**为什么需要这份目录**：引擎自己不带"OpenAI / Anthropic / 通义千问…"这种预设表 ——
它只认三种协议（`openai-completions` / `openai-responses` / `anthropic-messages`），
每个供应商都要在 settings.yaml 里显式声明（名称、协议、baseURL、模型）。
那对用户太抽象了，所以预设放在产品这边：用户从下拉里选一家、贴一串 key，剩下的我们填。

关键事实（读引擎源码确认的，别凭印象改）：

* 协议只有三种，且 **`openai-completions` 覆盖绝大多数家**（OpenAI / 通义 / 智谱 /
  Kimi / Gemini 的兼容端点 / Ollama / vLLM 都是它）。
* 只有 `openai-completions` 与 `openai-responses` 支持**自动列出模型**；
  `anthropic-messages` 不会列，所以它必须带一份模型清单（就是这里的 models）。
* DeepSeek 是引擎**内置**的 provider（`llm-deepseek`），只需要 key，不用写 provider 段。
"""

from __future__ import annotations

import io
from dataclasses import dataclass, field
from pathlib import Path

PROVIDER_KEY_NAMES = ('openai-responses', 'anthropic-messages')


@dataclass(frozen=True)
class Provider:
    """一个可选的供应商。"""

    id: str
    name: str
    api: str
    base_url: str
    key_env: str
    models: tuple[dict, ...] = ()
    builtin: bool = False
    needs_key: bool = True
    note: str = ''
    key_url: str = ''


def _model(model_id: str, name: str = '', context_window: int = 128000, max_tokens: int = 4096) -> dict:
    return {'id': model_id, 'name': name or model_id, 'contextWindow': context_window, 'maxTokens': max_tokens}


# 说明：baseURL 一律用各家**官方文档给的 OpenAI 兼容端点**（最通用、最少坑）。
CATALOG: tuple[Provider, ...] = (
    Provider(id='deepseek', name='DeepSeek（官方）', api='', base_url='', key_env='DEEPSEEK_API_KEY',
             builtin=True, note='引擎内置，只需要一串 key', key_url='https://platform.deepseek.com'),
    Provider(id='openai', name='OpenAI', api='openai-responses', base_url='https://api.openai.com/v1',
             key_env='OPENAI_API_KEY', key_url='https://platform.openai.com/api-keys',
             models=(_model('gpt-5', 'GPT-5', 400000, 16384),
                     _model('gpt-5-mini', 'GPT-5 mini', 400000, 16384),
                     _model('gpt-4.1', 'GPT-4.1', 1000000, 8192))),
    Provider(id='anthropic', name='Anthropic（Claude）', api='anthropic-messages',
             base_url='https://api.anthropic.com', key_env='ANTHROPIC_API_KEY',
             key_url='https://console.anthropic.com/settings/keys',
             note='这一家不能自动列模型，所以自带一份清单',
             models=(_model('claude-sonnet-4-5', 'Claude Sonnet 4.5', 200000, 8192),
                     _model('claude-opus-4-1', 'Claude Opus 4.1', 200000, 8192),
                     _model('claude-haiku-4-5', 'Claude Haiku 4.5', 200000, 8192))),
    Provider(id='gemini', name='Google Gemini', api='openai-completions',
             base_url='https://generativelanguage.googleapis.com/v1beta/openai', key_env='GEMINI_API_KEY',
             key_url='https://aistudio.google.com/apikey',
             models=(_model('gemini-2.5-pro', 'Gemini 2.5 Pro', 1000000, 8192),
                     _model('gemini-2.5-flash', 'Gemini 2.5 Flash', 1000000, 8192))),
    Provider(id='qwen', name='通义千问（阿里云百炼）', api='openai-completions',
             base_url='https://dashscope.aliyuncs.com/compatible-mode/v1', key_env='DASHSCOPE_API_KEY',
             key_url='https://bailian.console.aliyun.com',
             models=(_model('qwen3-max', 'Qwen3-Max', 262144, 8192),
                     _model('qwen-plus', 'Qwen-Plus', 131072, 8192))),
    Provider(id='zhipu', name='智谱 GLM', api='openai-completions',
             base_url='https://open.bigmodel.cn/api/paas/v4', key_env='ZHIPU_API_KEY',
             key_url='https://open.bigmodel.cn/usercenter/apikeys',
             models=(_model('glm-4.6', 'GLM-4.6', 200000, 8192),
                     _model('glm-4-flash', 'GLM-4-Flash', 128000, 4096))),
    Provider(id='moonshot', name='月之暗面 Kimi', api='openai-completions',
             base_url='https://api.moonshot.cn/v1', key_env='MOONSHOT_API_KEY',
             key_url='https://platform.moonshot.cn/console/api-keys',
             models=(_model('kimi-k2-turbo-preview', 'Kimi K2 Turbo', 256000, 8192),
                     _model('moonshot-v1-128k', 'Moonshot v1 128k', 131072, 4096))),
    Provider(id='ollama-local', name='本地模型（Ollama）', api='openai-completions',
             base_url='http://127.0.0.1:11434/v1', key_env='OLLAMA_LOCAL_API_KEY',
             needs_key=False, note='在这台电脑上跑，不联网；用 install-local-model.ps1 安装',
             models=(_model('qwen2.5:7b', 'Qwen2.5 7B', 32768, 2048),)),
    Provider(id='custom', name='其它（自己填地址）', api='openai-completions', base_url='',
             key_env='CUSTOM_PROVIDER_API_KEY', note='任何 OpenAI 兼容的服务都行：填地址 + 模型名'),
)

CATALOG_BY_ID = {p.id: p for p in CATALOG}


def resolve(provider_id: str) -> Provider | None:
    return CATALOG_BY_ID.get(provider_id)


def describe() -> list[dict]:
    """给界面用的目录（不含任何密钥）。"""
    return [{'id': p.id, 'name': p.name, 'api': p.api, 'baseUrl': p.base_url, 'keyEnv': p.key_env,
             'keyUrl': p.key_url, 'needsKey': p.needs_key, 'builtin': p.builtin, 'note': p.note,
             'models': [m['id'] for m in p.models]} for p in CATALOG]


# --------------------------------------------------------------------------
# 写 settings.yaml
#
# 为什么是"行级合并"而不是 yaml.load/dump：**这台机器上任何 python 都没有 PyYAML**
# （自带的 embeddable python 更不会有），不能指望解析器。要写的东西结构固定、缩进固定，
# 按行插入是可控的；写完成不成由引擎自己回答（页面的模型列表会多出这一家）。
#
# 铁律：
#  * 顶层键只能出现一次（引擎的解析器开了 uniqueKeys）→ **不能**在文件末尾再追加一个
#    `llm-pi-ai:`，必须并进已有的那一段。
#  * **只增不删**：用户已有的 provider（比如他自己建的 qwen-dsh-16k）必须留着。
#  * 改之前先备份。
# --------------------------------------------------------------------------
L_TOP = 0
L_PROVIDERS = 2
L_PROVIDER = 4
L_FIELD = 6
L_LIST = 8
L_ITEM_FIELD = 10
HEADER = 'llm-pi-ai:'


def indent(level: int) -> str:
    return ' ' * level


def block_indent(line: str) -> int:
    return len(line) - len(line.lstrip(' '))


def _find_top_block(lines: list[str], key: str) -> tuple[int, int] | None:
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


def _item_lines(model: dict, name: str) -> list[str]:
    return [
        indent(L_LIST) + '- name: ' + name,
        indent(L_ITEM_FIELD) + 'contextWindow: ' + str(model.get('contextWindow', 128000)),
        indent(L_ITEM_FIELD) + 'maxTokens: ' + str(model.get('maxTokens', 4096)),
        indent(L_ITEM_FIELD) + 'id: ' + str(model.get('id', name)),
    ]


def _provider_lines(name: str, display_name: str, api: str, base_url: str, key_env: str,
                    models: list[dict]) -> list[str]:
    out = [indent(L_PROVIDER) + name + ':',
           indent(L_FIELD) + 'displayName: ' + display_name,
           indent(L_FIELD) + 'apiKeyEnv: ' + key_env,
           indent(L_FIELD) + 'api: ' + api]
    if base_url:
        out.append(indent(L_FIELD) + 'baseURL: ' + base_url)
    out.append(indent(L_FIELD) + 'models:')
    for model in models or [{'id': name}]:
        out.extend(_item_lines(model, str(model.get('name') or model.get('id') or name)))
    return out


def upsert_provider(lines: list[str], *, name: str, display_name: str, api: str, base_url: str,
                    key_env: str, models: list[dict]) -> list[str]:
    """把一个 provider 写进 settings.yaml 的 llm-pi-ai.providers 段（只增不删）。"""
    block = _provider_lines(name, display_name, api, base_url, key_env, models)
    found = _find_top_block(lines, HEADER)

    if found is None:
        out = list(lines)
        if out and out[-1].strip():
            out.append('')
        return out + [HEADER, indent(L_PROVIDERS) + 'providers:'] + block

    start, end = found
    provider_at = None
    for index in range(start, end):
        if lines[index].strip() == name + ':' and block_indent(lines[index]) == L_PROVIDER:
            provider_at = index
            break

    if provider_at is None:
        # providers: 段落存在但还没有这一家 → 插到它末尾
        providers_at = None
        for index in range(start + 1, end):
            if lines[index].strip() == 'providers:' and block_indent(lines[index]) == L_PROVIDERS:
                providers_at = index
                break
        if providers_at is None:
            return lines[:start + 1] + [indent(L_PROVIDERS) + 'providers:'] + block + lines[start + 1:]
        insert_at = end
        for index in range(providers_at + 1, end):
            if lines[index].strip() and block_indent(lines[index]) <= L_PROVIDERS:
                insert_at = index
                break
        return lines[:insert_at] + block + lines[insert_at:]

    # 已存在：整段替换（用户自己加过的模型会保留 —— 见下面的 merge_models 调用方）
    provider_end = end
    for index in range(provider_at + 1, end):
        if lines[index].strip() and block_indent(lines[index]) <= L_PROVIDER:
            provider_end = index
            break

    # 找出用户原有、但预设里没有的模型，一并保留
    existing_models = _models_in_block(lines, provider_at, provider_end)
    keep = [m for m in existing_models if m['id'] not in {x.get('id') for x in models}]
    merged = list(models) + keep
    return lines[:provider_at] + _provider_lines(name, display_name, api, base_url, key_env, merged) + \
        lines[provider_end:]


def _models_in_block(lines: list[str], start: int, end: int) -> list[dict]:
    """从 provider 段里读回已声明的模型（只认结构，不做完整 YAML 解析）。"""
    models: list[dict] = []
    models_at = None
    for index in range(start, end):
        if lines[index].strip() == 'models:' and block_indent(lines[index]) == L_FIELD:
            models_at = index
            break
    if models_at is None:
        return models
    current: dict | None = None
    for index in range(models_at + 1, end):
        line = lines[index]
        if not line.strip():
            continue
        level = block_indent(line)
        if level <= L_FIELD:
            break
        text = line.strip()
        if text.startswith('- '):
            if current and current.get('id'):
                models.append(current)
            current = {}
            text = text[2:]
        if current is None:
            continue
        if ':' not in text:
            continue
        key, _, value = text.partition(':')
        key, value = key.strip(), value.strip()
        if key == 'name':
            current['name'] = value
        elif key == 'id':
            current['id'] = value
        elif key == 'contextWindow':
            current['contextWindow'] = int(value) if value.isdigit() else 128000
        elif key == 'maxTokens':
            current['maxTokens'] = int(value) if value.isdigit() else 4096
    if current and current.get('id'):
        models.append(current)
    return models


def apply_provider(settings_path: str | Path, provider: Provider, *, base_url: str = '',
                   model: str = '', display_name: str = '') -> str:
    """把 provider 写进 settings.yaml。返回一句给用户看的结果说明。"""
    path = Path(settings_path)
    if not path.exists():
        raise FileNotFoundError(f'找不到 {path}（引擎还没初始化过？先启动一次消息助手）')
    with io.open(path, encoding='utf-8-sig') as handle:
        original = handle.read()
    models = [dict(m) for m in provider.models]
    if model:
        models = [m for m in models if m.get('id') != model]
        models.insert(0, {'id': model, 'name': model, 'contextWindow': 128000, 'maxTokens': 4096})
    merged = upsert_provider(original.splitlines(), name=provider.id,
                             display_name=display_name or provider.name, api=provider.api,
                             base_url=base_url or provider.base_url, key_env=provider.key_env,
                             models=models)
    text = '\n'.join(merged) + '\n'
    if text == original:
        return f'{provider.name} 已经是配置好的状态'
    backup = Path(str(path) + '.before-provider')
    with io.open(backup, 'w', encoding='utf-8') as handle:
        handle.write(original)
    with io.open(path, 'w', encoding='utf-8') as handle:
        handle.write(text)
    return f'已把「{provider.name}」写进引擎配置（原文件备份为 {backup.name}）'


def configured_providers(settings_path: str | Path) -> set[str]:
    """settings.yaml 里已经声明过哪些 provider（用于界面上打勾）。"""
    path = Path(settings_path)
    if not path.exists():
        return set()
    with io.open(path, encoding='utf-8-sig') as handle:
        lines = handle.read().splitlines()
    found = _find_top_block(lines, HEADER)
    if found is None:
        return set()
    start, end = found
    names = set()
    for index in range(start + 1, end):
        if block_indent(lines[index]) == L_PROVIDER and lines[index].strip().endswith(':'):
            names.add(lines[index].strip()[:-1])
    return names
