// Live read-only smoke check for the stage-1 product API.
// Only issues GET requests through the in-process handler against the real
// Worker control API; it never writes rules, drafts, or sends messages.
// Run: node plugin/host/smoke-api.mjs
import { readFileSync } from 'node:fs';
import { createProductApi } from './product.mjs';

const config = JSON.parse(readFileSync(new URL('../../config.json', import.meta.url), 'utf8').replace(/^﻿/, ''));
const token = readFileSync(config.control_token_file, 'utf8').trim();
const bindingsPath = config.database.replace(/[^\\/]+$/, 'conversation-sessions.json');

const calls = [];
const respond = (res, code, body) => calls.push({code, body});
const readBody = async () => { throw new Error('not used in read-only smoke'); };
const conversations = {entries: {}, bind() { throw new Error('bind must not run in read-only smoke'); }};

const handle = createProductApi({config, token, conversations, bindingsPath, respond, readBody});
const fakeReq = method => ({method, headers: {}});

async function get(path) {
  calls.length = 0;
  const handled = await handle(fakeReq('GET'), null, new URL(path, 'http://127.0.0.1'));
  return {handled, ...calls[0]};
}

const inbox = await get('/message-agent/api/inbox?limit=5');
console.log('inbox handled:', inbox.handled, 'code:', inbox.code);
console.log('inbox items:', inbox.body.items?.length, 'nextCursor:', inbox.body.nextCursor);
if (inbox.body.items?.length) {
  const first = inbox.body.items[0];
  console.log('first item:', JSON.stringify({
    title: first.identity.title, processingState: first.processingState,
    deliveryState: first.deliveryState, bucket: first.bucket,
    automatic: !!first.sessions.automatic, interactive: !!first.sessions.interactive
  }, null, 2));
  const detail = await get('/message-agent/api/conversations/' + first.key);
  console.log('detail code:', detail.code, 'recentJobs:', detail.body.recentJobs?.length, 'drafts:', detail.body.drafts?.length);
}
const filtered = await get('/message-agent/api/inbox?filter=bogus');
console.log('bad filter code:', filtered.code, 'error:', filtered.body?.error);
const unknown = await get('/message-agent/api/nope');
console.log('unknown path handled (expect false):', unknown.handled);
