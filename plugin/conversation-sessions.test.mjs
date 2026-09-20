import { test } from 'node:test';
import assert from 'node:assert/strict';
import { automaticRequestConfig } from './conversation-sessions.mjs';

test('automaticRequestConfig pins the selected automatic model on resumed sessions', () => {
  assert.deepEqual(automaticRequestConfig(
    {provider:'deepseek-official', model:'old-model', maxTokens:999, reasoningEffort:'high'},
    {model:'new-model', max_tokens:4096, auto_reasoning_effort:'low'}
  ), {
    provider:'deepseek-official', model:'new-model', maxTokens:4096, reasoningEffort:'low'
  });
});

test('选了本地模型时，请求要连提供方一起换掉', () => {
  // 本地模型（Ollama 等）挂在别的 provider 下，只换 model 会打到官方端点。
  assert.deepEqual(automaticRequestConfig(
    {provider:'deepseek-official', model:'old-model', maxTokens:999, reasoningEffort:'high'},
    {provider:'ollama-local', model:'qwen-dsh-16k:latest', max_tokens:2048, auto_reasoning_effort:'low'}
  ), {
    provider:'ollama-local', model:'qwen-dsh-16k:latest', maxTokens:2048, reasoningEffort:'low'
  });
  // 没有 provider 的旧配置保持原样，不会被写成 undefined。
  assert.deepEqual(automaticRequestConfig(
    {provider:'deepseek-official', model:'old-model', maxTokens:999, reasoningEffort:'high'},
    {model:'new-model', max_tokens:4096, auto_reasoning_effort:'low'}
  ).provider, 'deepseek-official');
});
