// Hosted API (lib/hosted.js) and the model picker flag. Core money and danger only: the daily spend
// ceiling, the storage fallback (fail closed without a durable store), the per-IP start limit, and the
// picker flag enforced on the server, in both the hosted API and the local proxy. No real gateway or KV
// calls: a fake fetch stands in for both, and the proxy test points server.js at a local fake gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHosted } from '../lib/hosted.js';
import { createStore, MemoryStore, RestStore, FileStore } from '../lib/storage.js';
import { spendConfig, conservativeCallUsd, matchReserveUsd } from '../lib/spend.js';
import { resolveFighter, parseCatalogue, validModelId } from '../lib/models.js';
import { rosterById } from '../public/shared.js';
import { createMatch, sceneFor } from '../public/sim.js';
import { botDecide } from '../public/brain.js';

const KEY = 'dummy-test-key';
const scene = sceneFor(createMatch({ seed: 1, roster: ['jev', 'laya'] }), 'jev');

function durableMemory(now) { const s = new MemoryStore({ now }); s.durable = true; return s; }

// A fake gateway as a fetch function. cost: what each call reports (null = no cost and no usage).
function fakeGateway({ cost = 0.5, fail = null } = {}) {
  const calls = [];
  const fetcher = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body, auth: opts.headers?.Authorization });
    if (fail === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    const { action } = botDecide(scene);
    const meta = cost == null ? {} : { provider_metadata: { gateway: { cost } } };
    const j = url.endsWith('/chat/completions')
      ? { choices: [{ message: { content: JSON.stringify({ action, confidence: 0.9 }) } }], ...(cost == null ? {} : { usage: { cost } }) }
      : { answers: { action: { choice: action, probabilities: { [action]: 1 } } }, ...meta };
    return { ok: true, status: 200, text: async () => JSON.stringify(j), json: async () => j };
  };
  return { calls, fetcher };
}

async function call(api, route, { method = 'POST', body, headers = {}, ip = '203.0.113.7', url = '/' } = {}) {
  const req = { method, url, body, headers: { 'x-real-ip': ip, ...headers } };
  let status, out;
  const res = { writeHead(c) { status = c; }, end(b) { out = b; } };
  await api.handle(route, req, res);
  return { status, body: JSON.parse(Buffer.isBuffer(out) ? out.toString() : out) };
}

function setup({ env = {}, gateway = fakeGateway(), clock = { t: Date.UTC(2026, 10, 4, 12) } } = {}) {
  const now = () => clock.t;
  const store = durableMemory(now);
  const api = createHosted({ env: { AI_GATEWAY_API_KEY: KEY, ...env }, store, fetch: gateway.fetcher, now });
  return { api, store, gateway, clock };
}
const start = (api, fighters = ['jev', 'laya'], extra = {}) => call(api, 'matchStart', { body: { fighters, ...extra.body }, ip: extra.ip });
const decide = (api, matchToken, fighter = 'jev', extra = {}) => call(api, 'decide', { body: { matchToken, fighter, scene, ...extra } });

test('daily ceiling: refuses decisions and new matches once spent, reopens the next UTC day', async () => {
  // £1 at $1.30 = $1.30; each call reports $0.50
  const { api, gateway, clock } = setup({ env: { DAILY_SPEND_CEILING_GBP: '1', USD_PER_GBP: '1.30' } });
  assert.equal(spendConfig({ DAILY_SPEND_CEILING_GBP: '1', USD_PER_GBP: '1.30' }).usd, 1.3);
  const s = await start(api);
  assert.equal(s.status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await decide(api, s.body.matchToken)).status, 200); // 0, 0.5, 1.0 spent before each
  const n = gateway.calls.length;
  const over = await decide(api, s.body.matchToken);
  assert.equal(over.status, 429); assert.equal(over.body.ceilingReached, true); assert.equal(over.body.stop, true);
  assert.match(over.body.error, /budget spent/); // the page's existing stop pattern
  assert.equal(gateway.calls.length, n, 'no gateway call once the ceiling is reached');
  const again = await start(api);
  assert.equal(again.status, 429); assert.equal(again.body.ceilingReached, true);
  assert.match(again.body.message, /reopen tomorrow/);
  const st = await call(api, 'status', { method: 'GET' });
  assert.equal(st.body.spend.exhausted, true); assert.ok(st.body.spendMessage);
  clock.t += 86400e3;
  assert.equal((await start(api)).status, 200);
});

test('daily ceiling: a match that would cross it is refused up front (whole-match reservation)', async () => {
  const { api } = setup({ env: { DAILY_SPEND_CEILING_GBP: '0.05' } }); // $0.065
  const cheap = matchReserveUsd([rosterById.jev, rosterById.laya]);
  const dear = matchReserveUsd(['jev', 'luna', 'laya', 'scaledown', 'gemini'].map((id) => rosterById[id]));
  assert.ok(cheap < 0.065 && dear > 0.065, `reserve ${cheap} / ${dear}`);
  assert.equal((await start(api, ['jev', 'luna', 'laya', 'scaledown', 'gemini'])).status, 429);
  assert.equal((await start(api, ['jev', 'laya'])).status, 200);
});

test('unknown cost and timeouts are charged conservatively, never as free', async () => {
  for (const g of [fakeGateway({ cost: null }), fakeGateway({ fail: 'timeout' })]) {
    const { api, store, clock } = setup({ gateway: g });
    const s = await start(api);
    await decide(api, s.body.matchToken, 'jev');
    const spent = Number(await store.get(`spend:usd:${new Date(clock.t).toISOString().slice(0, 10)}`));
    assert.ok(spent > 0 && Math.abs(spent - conservativeCallUsd(rosterById.jev)) < 1e-12, `spent ${spent}`);
  }
});

test('the match token gates paid calls, and the per-match call cap holds', async () => {
  const { api, gateway, store } = setup();
  assert.equal((await decide(api, undefined)).status, 403);
  assert.equal((await decide(api, '00000000-0000-4000-8000-000000000000')).status, 403);
  assert.equal(gateway.calls.length, 0);
  const s = await start(api);
  assert.equal((await decide(api, s.body.matchToken, 'luna')).status, 400, 'fighter not in this match');
  const m = await store.get(`match:${s.body.matchToken}`);
  await store.set(`match:${s.body.matchToken}`, { ...m, maxCalls: 2 }, 900);
  assert.equal((await decide(api, s.body.matchToken)).status, 200);
  assert.equal((await decide(api, s.body.matchToken)).status, 200);
  const capped = await decide(api, s.body.matchToken);
  assert.equal(capped.status, 429); assert.equal(capped.body.stop, true);
  assert.equal(gateway.calls.length, 2);
  assert.ok(gateway.calls.every((c) => c.auth === `Bearer ${KEY}`));
  const st = await call(api, 'status', { method: 'GET' });
  assert.ok(!JSON.stringify(st.body).includes(KEY), 'key never in a response');
});

test('per-IP rate limit on starting matches', async () => {
  const { api, clock } = setup({ env: { MATCH_RATE_LIMIT: '2', MATCH_RATE_WINDOW_S: '600' } });
  assert.equal((await start(api)).status, 200);
  assert.equal((await start(api)).status, 200);
  const third = await start(api);
  assert.equal(third.status, 429); assert.equal(third.body.rateLimited, true);
  assert.equal((await start(api, ['jev', 'laya'], { ip: '198.51.100.9' })).status, 200, 'another address is not limited');
  clock.t += 600e3;
  assert.equal((await start(api)).status, 200, 'next window');
});

test('storage: REST when KV env is set, file locally, and fail closed on Vercel with no store', async () => {
  const sent = [];
  const fakeKv = async (url, o) => { sent.push({ url, body: JSON.parse(o.body), auth: o.headers.Authorization });
    return { ok: true, json: async () => (url.endsWith('/pipeline') ? [{ result: '0.25' }, { result: 1 }] : { result: null }) }; };
  const kv = createStore({ KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 't1' }, { fetch: fakeKv });
  assert.ok(kv instanceof RestStore && kv.durable);
  assert.equal(await kv.incrFloat('spend:usd:x', 0.25, 60), 0.25);
  assert.deepEqual(sent[0], { url: 'https://kv.example/pipeline', auth: 'Bearer t1', body: [['INCRBYFLOAT', 'spend:usd:x', '0.25'], ['EXPIRE', 'spend:usd:x', '60']] });
  assert.ok(createStore({ UPSTASH_REDIS_REST_URL: 'https://u.example', UPSTASH_REDIS_REST_TOKEN: 't' }) instanceof RestStore);
  assert.throws(() => createStore({ KV_REST_API_URL: 'http://plain.example', KV_REST_API_TOKEN: 't' }), /https/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-store-'));
  try {
    const file = createStore({}, { root: dir });
    assert.ok(file instanceof FileStore && file.durable);
    await file.incrFloat('k', 1.5); await file.listPush('lb', { a: 1 }, 2); await file.listPush('lb', { a: 2 }, 2); await file.listPush('lb', { a: 3 }, 2);
    const reopened = createStore({}, { root: dir });
    assert.equal(await reopened.get('k'), 1.5, 'survives a restart');
    assert.deepEqual(await reopened.listRange('lb'), [{ a: 2 }, { a: 3 }], 'trimmed to max');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  const mem = createStore({ VERCEL: '1' });
  assert.ok(mem instanceof MemoryStore && !mem.durable);
  const g = fakeGateway();
  const api = createHosted({ env: { VERCEL: '1', AI_GATEWAY_API_KEY: KEY }, fetch: g.fetcher });
  const s = await call(api, 'matchStart', { body: { fighters: ['jev', 'laya'] } });
  assert.equal(s.status, 503); assert.match(s.body.error, /durable store/);
  assert.equal((await call(api, 'decide', { body: { matchToken: crypto.randomUUID(), fighter: 'jev', scene } })).status, 503);
  assert.equal((await call(api, 'status', { method: 'GET' })).body.spend.exhausted, true);
  assert.equal(g.calls.length, 0);
});

test('leaderboard: only a started live match, once, with roster models; reset needs the admin token', async () => {
  const { api } = setup();
  const rec = { mode: 'live', winner: 'jev', seed: 1, fighters: [{ id: 'jev', place: 1 }, { id: 'laya', place: 2 }] };
  assert.equal((await call(api, 'record', { body: rec })).status, 403);
  const s = await start(api);
  const h = { 'x-match-token': s.body.matchToken };
  assert.equal((await call(api, 'record', { body: { ...rec, mode: 'mock' }, headers: h })).status, 403);
  assert.equal((await call(api, 'record', { body: rec, headers: h })).status, 200);
  assert.equal((await call(api, 'record', { body: rec, headers: h })).status, 409);
  assert.equal((await call(api, 'leaderboard', { method: 'GET' })).body.matches.length, 1);
  assert.equal((await call(api, 'reset', { body: { confirm: 'RESET' } })).status, 403);
  const admin = setup({ env: { ARENA_ADMIN_TOKEN: 'a-long-admin-token-123' } }).api;
  assert.equal((await call(admin, 'reset', { body: { confirm: 'RESET' }, headers: { authorization: 'Bearer wrong-but-same-length!' } })).status, 403);
  assert.equal((await call(admin, 'reset', { body: { confirm: 'RESET' }, headers: { authorization: 'Bearer a-long-admin-token-123' } })).status, 200);
});

// ---------- model picker flag
const CATALOGUE = { data: [
  { id: 'acme/cheap-chat', name: 'Cheap', type: 'language', pricing: { input: '0.0000001', output: '0.0000004' } },
  { id: 'acme/no-price', type: 'language' },
  { id: 'acme/dear-chat', type: 'language', pricing: { input: '0.00002', output: '0.00008' } },
  { id: 'acme/embed', type: 'embedding', pricing: { input: '0.0000001', output: '0' } },
  { id: 'https://evil.example/x', type: 'language', pricing: { input: '0', output: '0' } },
] };

test('picker: model ids are validated and the catalogue keeps priced language models only', () => {
  for (const bad of ['https://evil.example/x', 'acme', 'acme/../x', 'acme/x y', '/x', 'acme//x', 'acme/x?y=1', 42, null]) assert.equal(validModelId(bad), false, String(bad));
  assert.equal(validModelId('google/gemini-2.5-flash-lite'), true);
  const list = parseCatalogue(CATALOGUE);
  assert.deepEqual(list.map((m) => m.id), ['acme/cheap-chat', 'acme/no-price', 'acme/dear-chat']);
  assert.equal(list.find((m) => m.id === 'acme/no-price').price, null);
});

test('picker OFF (default): the server rejects any model but the slot\'s own, whatever the page sends', async () => {
  assert.equal(resolveFighter('jev', 'acme/cheap-chat', { models: parseCatalogue(CATALOGUE) }).status, 403);
  assert.equal(resolveFighter('jev', 'google/gemini-2.5-flash-lite').status, 403, 'even another roster model');
  assert.equal(resolveFighter('jev', 'typesafe-ai/jev').ok, true);
  const { api, gateway } = setup();
  assert.equal((await call(api, 'models', { method: 'GET' })).body.enabled, false);
  assert.equal((await start(api, ['jev', 'laya'], { body: { models: { jev: 'acme/cheap-chat' } } })).status, 403);
  const s = await start(api);
  assert.equal((await decide(api, s.body.matchToken, 'jev', { model: 'acme/cheap-chat' })).status, 400);
  assert.equal(gateway.calls.length, 0);
});

test('picker ON: valid priced models play; bad ids, unknown, unpriced and too-dear models are refused', async () => {
  const gw = fakeGateway({ cost: 0.0001 });
  const fetcher = async (url, o) => url.endsWith('/v1/models') ? { ok: true, json: async () => CATALOGUE } : gw.fetcher(url, o);
  const { api } = setup({ env: { ENABLE_MODEL_PICKER: '1' }, gateway: { ...gw, fetcher } });
  const models = (await call(api, 'models', { method: 'GET' })).body;
  assert.equal(models.enabled, true); assert.equal(models.source, 'gateway');
  assert.deepEqual(models.models.map((m) => m.id), ['acme/cheap-chat', 'acme/dear-chat']);
  for (const [model, re] of [['https://evil.example/x', /invalid/], ['acme/missing', /unknown/], ['acme/no-price', /no listed price/], ['acme/dear-chat', /too expensive/]]) {
    const r = await start(api, ['jev', 'laya'], { body: { models: { jev: model } } });
    assert.equal(r.status, 400, model); assert.match(r.body.error, re);
  }
  const s = await start(api, ['jev', 'laya'], { body: { models: { jev: 'acme/cheap-chat' } } });
  assert.equal(s.status, 200);
  assert.equal((await decide(api, s.body.matchToken, 'jev')).status, 200);
  const last = gw.calls.at(-1);
  assert.match(last.url, /\/v1\/chat\/completions$/); assert.equal(last.body.model, 'acme/cheap-chat');
  const rec = { mode: 'live', winner: 'jev', fighters: [{ id: 'jev' }, { id: 'laya' }] };
  assert.equal((await call(api, 'record', { body: rec, headers: { 'x-match-token': s.body.matchToken } })).status, 403, 'picked matches are not recorded');
});

test('picker ON in mock mode (no key): the built-in list, roster models only', async () => {
  const api = createHosted({ env: { ENABLE_MODEL_PICKER: '1' }, store: durableMemory(), fetch: () => { throw new Error('no network in mock mode'); } });
  const r = await call(api, 'models', { method: 'GET' });
  assert.equal(r.body.source, 'builtin');
  assert.ok(r.body.models.some((m) => m.id === 'typesafe-ai/jev'));
});

// The local proxy enforces the same flag. server.js runs on 8796 against a local fake gateway.
async function withProxy(env, fn) {
  const seen = [];
  const gw = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      if (req.url === '/v1/models') { res.end(JSON.stringify(CATALOGUE)); return; }
      const body = JSON.parse(b); seen.push({ url: req.url, model: body.model });
      const { action } = botDecide(scene);
      res.end(JSON.stringify(req.url.endsWith('/chat/completions')
        ? { choices: [{ message: { content: JSON.stringify({ action, confidence: 0.5 }) } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }
        : { answers: { action: { choice: action, probabilities: {} } } }));
    });
  });
  gw.listen(0, '127.0.0.1'); await once(gw, 'listening');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-proxy-'));
  const child = spawn(process.execPath, ['server.js'], { cwd: path.resolve(import.meta.dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, PORT: '8796', AI_GATEWAY_API_KEY: KEY, AI_GATEWAY_BASE: `http://127.0.0.1:${gw.address().port}`,
      LEADERBOARD_FILE: path.join(dir, 'lb.json'), ...env } });
  try {
    await new Promise((resolve, reject) => { child.stdout.on('data', (d) => /on http/.test(d) && resolve()); child.on('exit', reject); });
    const post = async (route, body) => { const r = await fetch(`http://127.0.0.1:8796${route}`, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
    await fn({ post, seen, get: async (route) => (await fetch(`http://127.0.0.1:8796${route}`)).json() });
  } finally {
    child.kill(); gw.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('local proxy, picker OFF: unchanged without a model, rejects a picked model before any gateway call', async () => {
  await withProxy({}, async ({ post, seen, get }) => {
    assert.equal((await get('/api/status')).modelPicker, false);
    assert.equal((await post('/api/decide', { fighter: 'jev', scene })).status, 200);
    assert.equal(seen.length, 1); assert.equal(seen[0].model, 'typesafe-ai/jev');
    const r = await post('/api/decide', { fighter: 'jev', scene, model: 'acme/cheap-chat' });
    assert.equal(r.status, 403); assert.equal(seen.length, 1);
    assert.equal((await post('/api/match/start', { fighters: ['jev', 'laya'], models: { jev: 'acme/cheap-chat' } })).status, 403);
    assert.equal((await post('/api/match/start', { fighters: ['jev', 'laya'] })).status, 200);
  });
});

test('local proxy, picker ON: a listed model plays through chat; an unpriced one is refused', async () => {
  await withProxy({ ENABLE_MODEL_PICKER: '1' }, async ({ post, seen }) => {
    const ok = await post('/api/decide', { fighter: 'jev', scene, model: 'acme/cheap-chat' });
    assert.equal(ok.status, 200);
    assert.deepEqual(seen.at(-1), { url: '/v1/chat/completions', model: 'acme/cheap-chat' });
    assert.equal((await post('/api/decide', { fighter: 'jev', scene, model: 'acme/no-price' })).status, 400);
    assert.equal(seen.length, 1);
  });
});
