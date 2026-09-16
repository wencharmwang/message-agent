import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const product = readFileSync(join(here, 'product.mjs'), 'utf8');
const worker = readFileSync(join(here, '..', '..', 'agent_worker', 'service.py'), 'utf8');

test('message-center GET never schedules a background body read', () => {
  assert.doesNotMatch(product, /background\('pump:body-read'/);
  assert.doesNotMatch(product, /background\('pump:triage'/);
});

test('only explicit organiser actions request a fresh visible-list scan', () => {
  assert.match(product, /parts\[0\] === 'refresh'[\s\S]*syncCenter\(\{refresh: true\}\)/);
  assert.match(product, /parts\[0\] === 'organize'[\s\S]*syncCenter\(\{refresh: true\}\)/);
  assert.match(product, /refresh \? runtime\.refreshObservation\(\) : runtime\.observe\(\)/);
});

test('worker tick scans only automatic-reply providers', () => {
  const tick = worker.slice(worker.indexOf('    def tick(self):'));
  assert.match(tick, /scans = \{\}/);
  assert.doesNotMatch(tick, /self\.discover\(/);
  assert.match(tick, /for provider in dict\.fromkeys\(rule\['provider'\] for rule in rules\)/);
});
