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

test('模型不支持推理档位时，请求里不能带 reasoningEffort', () => {
  // 本地模型（Ollama 的 qwen-*）没有推理元数据，传了会在发请求之前就被拒绝，
  // 那条链路会次次失败。显式 undefined 表示"别传"。
  const stripped = automaticRequestConfig(
    {provider:'deepseek-official', model:'old', maxTokens:1, reasoningEffort:'high'},
    {provider:'ollama-local', model:'qwen-dsh-16k:latest', max_tokens:2048, auto_reasoning_effort:undefined}
  );
  assert.equal('reasoningEffort' in stripped, false, '不该出现 reasoningEffort 字段');
  assert.equal(stripped.provider, 'ollama-local');
  assert.equal(stripped.model, 'qwen-dsh-16k:latest');
});
