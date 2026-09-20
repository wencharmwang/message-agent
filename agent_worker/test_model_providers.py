"""模型供应商目录与 settings.yaml 写入的单元测试。

这里覆盖的是每次"用户换一家模型供应商"都会走的路：
写进去之后，引擎必须还认得这份配置 —— 顶层键不能重复、原有的 provider 和模型不能丢。
"""

from __future__ import annotations

import io
import tempfile
import unittest
from pathlib import Path

from . import model_providers as mp

# 一份最小的、结构正确的 settings.yaml（和真实文件的形状一致）
BASE = """ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
llm-pi-ai:
  providers:
    ollama-local:
      displayName: 本地 Qwen
      apiKeyEnv: OLLAMA_LOCAL_API_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:11434/v1
      models:
        - name: qwen-dsh-16k
          contextWindow: 16384
          maxTokens: 2048
          id: qwen-dsh-16k:latest
ui-theme:
  preference: system
"""


class CatalogTest(unittest.TestCase):
    def test_catalog_covers_mainstream_providers(self):
        ids = {p.id for p in mp.CATALOG}
        for expected in ('deepseek', 'openai', 'anthropic', 'gemini', 'qwen', 'zhipu', 'moonshot',
                         'ollama-local', 'custom'):
            self.assertIn(expected, ids, f'目录里少了 {expected}')

    def test_every_api_is_one_the_engine_accepts(self):
        # 引擎只认这三种协议（读源码确认），写错的话配置会直接被拒
        allowed = {'openai-completions', 'openai-responses', 'anthropic-messages', ''}
        for provider in mp.CATALOG:
            self.assertIn(provider.api, allowed, f'{provider.id} 用了引擎不认的协议 {provider.api}')

    def test_describe_never_leaks_keys(self):
        text = repr(mp.describe())
        self.assertNotIn('sk-', text)
        self.assertNotIn('apiKey', text)

    def test_anthropic_ships_its_own_model_list(self):
        # anthropic-messages 不能自动列模型，必须自带清单，否则界面上选完什么都没有
        anthropic = mp.resolve('anthropic')
        self.assertTrue(anthropic.models, 'anthropic 必须自带模型清单')


class SettingsWriteTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp(prefix='ma-providers-'))
        self.path = self.dir / 'settings.yaml'
        self.path.write_text(BASE, encoding='utf-8')

    def written(self) -> str:
        with io.open(self.path, encoding='utf-8') as handle:
            return handle.read()

    def test_new_provider_is_added_without_touching_others(self):
        mp.apply_provider(self.path, mp.resolve('qwen'))
        text = self.written()
        self.assertIn('qwen:', text)
        self.assertIn('dashscope.aliyuncs.com', text)
        self.assertIn('qwen-dsh-16k:latest', text, '用户原有的本地模型必须留着')

    def test_top_level_keys_are_never_duplicated(self):
        # 引擎的解析器开了 uniqueKeys，多一个顶层键就是硬错误
        for provider_id in ('qwen', 'openai', 'anthropic', 'gemini'):
            mp.apply_provider(self.path, mp.resolve(provider_id))
        text = self.written()
        self.assertEqual(text.count('\nllm-pi-ai:'), 1, 'llm-pi-ai 只能出现一次')
        self.assertTrue(text.startswith('ui-onboarding:'), '别把文件开头的东西挪走')

    def test_rewriting_same_provider_keeps_user_models(self):
        mp.apply_provider(self.path, mp.resolve('ollama-local'), model='llama3.2:3b')
        text = self.written()
        self.assertIn('llama3.2:3b', text, '新模型要写进去')
        self.assertIn('qwen-dsh-16k:latest', text, '用户自己建的模型不能被抹掉')

    def test_backup_is_created(self):
        mp.apply_provider(self.path, mp.resolve('openai'))
        self.assertTrue((self.dir / 'settings.yaml.before-provider').exists())

    def test_configured_providers_reports_what_is_declared(self):
        self.assertEqual(mp.configured_providers(self.path), {'ollama-local'})
        mp.apply_provider(self.path, mp.resolve('qwen'))
        self.assertEqual(mp.configured_providers(self.path), {'ollama-local', 'qwen'})

    def test_missing_settings_file_is_reported_not_crashed(self):
        with self.assertRaises(FileNotFoundError):
            mp.apply_provider(self.dir / 'nope.yaml', mp.resolve('qwen'))


if __name__ == '__main__':
    unittest.main()
