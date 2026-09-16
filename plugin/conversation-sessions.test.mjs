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
