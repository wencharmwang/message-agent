import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/**
 * 工具输出契约：`output.render` 必须是 **(args, value) 两个参数**。
 *
 * 踩过的坑：写成了 `render: result => [{type:'text', text: result.text}]` ——
 * 第一个参数拿到的是 **args**（{conversation, limit}），`result.text` 恒为 undefined，
 * DSH 的 JSON 快照判定"非无损"（undefined 不是合法 JSON 值），
 * 于是工具一调用就报 `output.render returned non-lossless JSON`。
 * 这个工具从加上去那天就是坏的，直到真的被调用才暴露。
 *
 * 宿主里的写法（`packages/core/tools/src/ptc.ts` / `testing.ts`）都是 `(_args, value) => …`。
 */
const source = readFileSync(new URL('./index.mjs', import.meta.url), 'utf8');

test('output.render 的参数个数只能是 0 或 2 —— 不能只写一个', () => {
  const renders = [...source.matchAll(/render:\s*(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g)];
  assert.ok(renders.length > 0, '至少应该有一个 output.render');
  for (const [, params] of renders) {
    if (!params.startsWith('(')) {
      assert.fail(`render 只写了一个参数名（${params}）—— 那会把 args 当成 value 用`);
    }
    const count = params === '()' ? 0 : params.split(',').length;
    // 0 个参数是允许的（返回固定文案，如 submit_reply_decision）；
    // **1 个参数才是 bug** —— 会以为拿到的是 value，其实是 args。
    assert.ok(count === 0 || count === 2, `render 参数个数应为 0 或 2（看到 ${params}）`);
  }
});

test('render 里取的是第二个参数的字段（value.text），不是第一个', () => {
  assert.doesNotMatch(source, /render:\s*result\s*=>/, '不许再出现单参数 render');
  assert.match(source, /render:\s*\(_args,\s*value\)\s*=>\s*\[\{type:\s*'text',\s*text:\s*value\.text\}\]/);
});
