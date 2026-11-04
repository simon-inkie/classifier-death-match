// Hosted API (lib/hosted.js) and the model picker flag. Core money and danger only: the daily spend
// ceiling (atomic, held reservations, under concurrency), the worst-case call bound (scene schema, body
// and prompt caps, timeouts), token-bound server-built leaderboard records and markup stripping, the
// per-network (/64) and site-wide start limits, throttles before any store read, the storage fallback
// (fail closed without a durable store), and the picker flag enforced on the server in both the hosted
// API and the local proxy. No real gateway or KV calls: a fake fetch stands in for both, and the proxy
// test points server.js at a local fake gateway.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHosted, clientNetwork, PLAY_S } from '../lib/hosted.js';
import { createStore, MemoryStore, RestStore, FileStore } from '../lib/storage.js';
import { spendConfig, worstCallUsd, matchReserveUsd, PROMPT_CHAR_CAP } from '../lib/spend.js';
import { cleanScene, promptChars } from '../lib/scene.js';
import { resolveFighter, parseCatalogue, validModelId } from '../lib/models.js';
import { rosterById } from '../public/shared.js';
import { createMatch, sceneFor, applyAction, step } from '../public/sim.js';
import { botDecide, runHeadlessMock } from '../public/brain.js';
import { cleanRecord } from '../public/leaderboard.js';
import { DEFAULT_WEAPON_CONFIG, LEGACY_WEAPON_CONFIG } from '../public/weapons.js';

const KEY = 'dummy-test-key';
const sceneIn = (roster, fid, weapons) => sceneFor(createMatch({ seed: 1, roster, weapons }), fid);
const scene = sceneIn(['jev', 'laya'], 'jev');
const DAY = '2026-11-04';

function durableMemory(now) { const s = new MemoryStore({ now }); s.durable = true; return s; }

// A fake gateway as a fetch function. cost: what each call reports (null = no cost and no usage),
// 'worst' = exactly the fighter's worst case. The action is the bot's choice for the request's own state.
function fakeGateway({ cost = 0.00001, fail = null, delayMs = 0 } = {}) {
  const calls = [];
  const fetcher = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body, auth: opts.headers?.Authorization });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (fail === 'garbage') return { ok: true, status: 200, text: async () => JSON.stringify({ answers: {}, provider_metadata: { gateway: { cost: 0.0001 } } }) };
    const action = 'hold';
    const c = cost === 'worst' ? worstCallUsd(Object.values(rosterById).find((r) => r.model === body.model)) : cost;
    const j = url.endsWith('/chat/completions')
      ? { choices: [{ message: { content: JSON.stringify({ action, confidence: 0.9 }) } }], ...(c == null ? {} : { usage: { cost: c } }) }
      : { answers: { action: { choice: action, probabilities: { [action]: 1 } } }, ...(c == null ? {} : { provider_metadata: { gateway: { cost: c } } }) };
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

function setup({ env = {}, gateway = fakeGateway(), clock = { t: Date.UTC(2026, 10, 4, 12) }, store } = {}) {
  const now = () => clock.t;
  const db = store || durableMemory(now);
  const api = createHosted({ env: { AI_GATEWAY_API_KEY: KEY, ...env }, store: db, fetch: gateway.fetcher, now, log: () => {} });
  return { api, store: db, gateway, clock };
}
let ipN = 0;
const freshIp = () => `198.51.${(++ipN >> 8) & 255}.${ipN & 255}`;
const start = (api, fighters = ['jev', 'laya'], extra = {}) => call(api, 'matchStart', { body: { fighters, ...extra.body }, ip: extra.ip ?? freshIp() });
const decide = (api, matchToken, fighter = 'jev', extra = {}) => call(api, 'decide', { body: { matchToken, fighter, scene, ...extra }, ip: extra.ip });
const committed = async (store) => Number(await store.get(`spend:usd:${DAY}`)) || 0;

test('ceiling: concurrent starts reserve atomically, never past the ceiling; ending a match frees its budget', async () => {
  const { api, store } = setup({ env: { DAILY_SPEND_CEILING_GBP: '1', USD_PER_GBP: '1.30', GLOBAL_MATCH_RATE_LIMIT: '100' } }); // $1.30
  assert.equal(spendConfig({ DAILY_SPEND_CEILING_GBP: '1', USD_PER_GBP: '1.30' }).usd, 1.3);
  const four = ['jev', 'luna', 'laya', 'scaledown'];
  const reserve = matchReserveUsd(four.map((id) => rosterById[id]));
  assert.ok(2 * reserve <= 1.3 && 3 * reserve > 1.3, `reserve ${reserve}`);
  const rs = await Promise.all(Array.from({ length: 30 }, () => start(api, four)));
  const ok = rs.filter((r) => r.status === 200);
  assert.equal(ok.length, 2, 'exactly the matches that fit');
  assert.ok(rs.filter((r) => r.status === 429).every((r) => r.body.busy), 'held by open matches: busy, not spent');
  assert.ok(await committed(store) <= 1.3 + 1e-9);
  assert.equal((await call(api, 'matchEnd', { body: { matchToken: ok[0].body.matchToken } })).body.closed, true);
  assert.equal((await start(api, four)).status, 200, 'released budget is usable again');
  assert.equal((await call(api, 'matchEnd', { body: { matchToken: ok[0].body.matchToken } })).body.closed, false, 'refund happens once');
  assert.ok(await committed(store) <= 1.3 + 1e-9);
});

test('ceiling: concurrent calls at the worst-case cost never take the day past the ceiling', async () => {
  const gw = fakeGateway({ cost: 'worst' });
  const { api, store, clock, gateway } = setup({ env: { DAILY_SPEND_CEILING_GBP: '0.5', USD_PER_GBP: '1.30' }, gateway: gw }); // $0.65
  const roster = ['jev', 'luna'];
  const toks = [];
  for (let i = 0; i < 5; i++) { const r = await start(api, roster); if (r.status === 200) toks.push(r.body.matchToken); }
  assert.equal(toks.length, 1, 'only one match fits $0.65');
  const sc = { jev: sceneIn(roster, 'jev'), luna: sceneIn(roster, 'luna') };
  let wave = 0, okCalls = 0;
  for (;;) {
    const rs = await Promise.all(toks.flatMap((t) => Array.from({ length: 50 }, (_, i) => {
      const f = roster[i % 2];
      return call(api, 'decide', { body: { matchToken: t, fighter: f, scene: sc[f] }, ip: `203.0.113.${(i % 200) + 1}` });
    })));
    const n = rs.filter((r) => r.status === 200).length;
    okCalls += n;
    assert.ok(n <= 2 * toks.length, 'one call in flight per fighter');
    clock.t += 100; wave++;
    if (!n || wave > 2000) break;
  }
  assert.equal(gateway.calls.length, okCalls);
  const reserve = matchReserveUsd(roster.map((id) => rosterById[id]));
  assert.ok(Math.abs(await committed(store) - reserve) < 1e-9, 'day holds exactly the reserve');
  assert.ok(await committed(store) <= 0.65);
  assert.ok(okCalls >= 1190 && okCalls <= 1200, `calls ${okCalls}: 600 worst-case calls per fighter, pooled`);
});

test('worst case: timeouts and unusable answers are charged at the capped worst case, not refunded', async () => {
  for (const [g, want] of [[fakeGateway({ fail: 'timeout' }), worstCallUsd(rosterById.jev)], [fakeGateway({ fail: 'garbage' }), 0.0001], [fakeGateway({ cost: null }), worstCallUsd(rosterById.jev)]]) {
    const { api, store } = setup({ gateway: g });
    const s = await start(api);
    await decide(api, s.body.matchToken);
    const id = s.body.matchToken.split('.')[0];
    assert.ok(Math.abs(Number(await store.get(`match:${id}:spent`)) - want) < 1e-12);
  }
  assert.ok(worstCallUsd(rosterById.luna) >= (PROMPT_CHAR_CAP + 200) * rosterById.luna.price.in);
});

test('body and scene: size capped even when pre-parsed, strict schema, prompt capped', async () => {
  const { api, gateway } = setup();
  const s = await start(api);
  const big = await decide(api, s.body.matchToken, 'jev', { scene: { ...scene, junk: 'x'.repeat(2_000_000) } });
  assert.equal(big.status, 413);
  const declared = await call(api, 'decide', { body: undefined, headers: { 'content-length': '5000000' } });
  assert.equal(declared.status, 413);
  for (const bad of [{ ...scene, hp: 1e9 }, { ...scene, weapon: '<b>' }, { ...scene, enemies: [{ ...scene.enemies[0], name: 'luna' }] },
    { ...scene, enemies: Array(5).fill(scene.enemies[0]) }, { ...scene, pickups: Array(4).fill({ type: 'rifle', bearing: 'N', dist: 'far' }) }, 'text']) {
    const r = await decide(api, s.body.matchToken, 'jev', { scene: bad });
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(gateway.calls.length, 0);
  assert.equal((await decide(api, s.body.matchToken, 'jev', { scene: { ...scene, junk: 'not in the prompt' } })).status, 200);
  assert.doesNotMatch(gateway.calls[0].body.state, /junk|not in the prompt/, 'unknown keys are dropped, not sent');
});

test('scene schema accepts every real scene unchanged, and the worst real prompt fits the cap', () => {
  for (const aims of [false, true]) for (const seed of [1, 2, 3]) {
    const roster = ['jev', 'luna', 'laya', 'scaledown', 'gemini', 'bot'];
    const weapons = { ...LEGACY_WEAPON_CONFIG, ...(aims ? { modelAims: true } : {}) };
    const m = createMatch({ seed, roster, weapons });
    for (let t = 0; !m.over && t < 2000; t++) {
      if (t % 7 === 0) for (const f of m.fighters.filter((x) => x.alive)) {
        const sc = sceneFor(m, f.id);
        assert.deepEqual(cleanScene(sc, { self: f.id, others: roster, modelAims: aims }), sc);
        if (f.id !== 'bot') assert.ok(promptChars(rosterById[f.id], sc, weapons) <= PROMPT_CHAR_CAP);
        applyAction(m, f.id, botDecide(sc).action);
      }
      step(m);
    }
  }
});

// Plays a live match through the hosted API as the page would: ask, apply the answer on a tick, log it.
async function playMatch(api, clock, roster, { seed = 7, ip } = {}) {
  const s = await start(api, roster, { body: { seed, weapons: DEFAULT_WEAPON_CONFIG }, ip });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  const m = createMatch({ seed, roster, weapons: DEFAULT_WEAPON_CONFIG });
  const decisions = [];
  while (!m.over) {
    if (m.tick % 3 === 0) for (const f of m.fighters.filter((x) => x.alive)) {
      const r = await call(api, 'decide', { body: { matchToken: s.body.matchToken, fighter: f.id, scene: sceneFor(m, f.id) }, ip });
      const d = r.status === 200 ? { t: m.tick, f: f.id, a: r.body.action, ms: 50, err: null, cost: r.body.cost } : { t: m.tick, f: f.id, a: null, ms: 50, err: 'HTTP', cost: 0 };
      applyAction(m, f.id, d.err ? 'stunned' : d.a); decisions.push(d);
    }
    step(m); clock.t += 100 / 3;
  }
  return { token: s.body.matchToken, decisions, state: m };
}

test('leaderboard: records are rebuilt on the server from verified play, once per token; client text ignored', async () => {
  const { api, clock } = setup();
  const rec = (token, body) => call(api, 'record', { body, headers: { 'x-match-token': token } });
  const fake = await start(api);
  assert.equal((await rec(fake.body.matchToken, { decisions: [{ t: 0, f: 'jev', a: 'shoot', ms: 1, err: null }] })).status, 400, 'no play, no record');
  assert.equal((await rec(fake.body.matchToken.replace(/.$/, (c) => (c === '0' ? '1' : '0')), { decisions: [] })).status, 403, 'forged token');
  const { token, decisions, state } = await playMatch(api, clock, ['jev', 'laya']);
  const tampered = decisions.map((d, i) => (i === 40 && !d.err ? { ...d, a: d.a === 'advance' ? 'retreat' : 'advance' } : d));
  assert.equal((await rec(token, { decisions: tampered, note: '<img src=x onerror=alert(1)>' })).status, 400, 'actions differ from the server\'s answers');
  const ok = await rec(token, { decisions, note: '<img src=x onerror=alert(1)>', winner: 'laya', cfgSummary: '"><svg onload=alert(1)>' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.record.winner, state.winner, 'winner from the server re-run');
  assert.doesNotMatch(ok.body.record.note + ok.body.record.cfgSummary, /[<>"]|onerror|svg|img/);
  assert.notEqual((await rec(token, { decisions })).status, 200, 'one record per token');
  const lb = await call(api, 'leaderboard', { method: 'GET' });
  assert.equal(lb.body.matches.length, 1);
});

test('leaderboard: free text is stripped of markup; reset needs the admin token', async () => {
  const r = cleanRecord({ mode: 'live', winner: 'jev', note: '<img src=x onerror=alert(1)>', cfgSummary: '"><svg onload=alert(1)>', fighters: [{ id: 'jev' }, { id: 'laya' }] });
  assert.doesNotMatch(r.note + r.cfgSummary, /[<>"']/);
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../public/game.js'), 'utf8');
  const lbFn = src.slice(src.indexOf('function renderLeaderboard'), src.indexOf('document.querySelectorAll(\'#lbTable th.lbSort\')'));
  assert.doesNotMatch(lbFn, /\$\{m\.(note|cfgSummary|cfgId|mode|seed)\}/, 'every record string is escaped when rendered');
  assert.match(lbFn, /esc\(m\.note\)/); assert.match(lbFn, /esc\(m\.cfgSummary\)/);
  const { api } = setup();
  assert.equal((await call(api, 'reset', { body: { confirm: 'RESET' } })).status, 403);
  const admin = setup({ env: { ARENA_ADMIN_TOKEN: 'a-long-admin-token-123' } }).api;
  assert.equal((await call(admin, 'reset', { body: { confirm: 'RESET' }, headers: { authorization: 'Bearer wrong-but-same-length!' } })).status, 403);
  assert.equal((await call(admin, 'reset', { body: { confirm: 'RESET' }, headers: { authorization: 'Bearer éé' } })).status, 403, 'non-ASCII bearer is a 403, not a 500');
  assert.equal((await call(admin, 'reset', { body: { confirm: 'RESET' }, headers: { authorization: 'Bearer a-long-admin-token-123' } })).status, 200);
});

test('rate limits: one IPv6 /64 is one network; a site-wide limit backs it up', async () => {
  assert.equal(clientNetwork({ headers: { 'x-real-ip': '2001:db8:0:1::abcd' } }), clientNetwork({ headers: { 'x-real-ip': '2001:0db8:0000:0001:ffff:1:2:3' } }));
  assert.notEqual(clientNetwork({ headers: { 'x-real-ip': '2001:db8:0:1::1' } }), clientNetwork({ headers: { 'x-real-ip': '2001:db8:0:2::1' } }));
  assert.equal(clientNetwork({ headers: { 'x-real-ip': '::ffff:192.0.2.1' } }), '192.0.2.1');
  const { api, clock } = setup({ env: { MATCH_RATE_LIMIT: '5' } });
  let ok = 0;
  for (let i = 0; i < 20; i++) if ((await start(api, ['jev', 'laya'], { ip: `2001:db8::${i.toString(16)}` })).status === 200) ok++;
  assert.equal(ok, 5);
  assert.equal((await start(api, ['jev', 'laya'], { ip: '2001:db8:0:1::1' })).status, 200, 'another /64');
  clock.t += 600e3;
  const g = setup({ env: { GLOBAL_MATCH_RATE_LIMIT: '3' } }).api;
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await start(g)).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
});

test('throttles run before any store read: forged tokens and floods cost no KV commands', async () => {
  const clock = { t: Date.UTC(2026, 10, 4, 12) };
  const inner = durableMemory(() => clock.t);
  let reads = 0;
  const counting = new Proxy(inner, { get(o, k) { const v = o[k]; return typeof v === 'function' ? (...a) => { reads++; return v.apply(o, a); } : v; } });
  const { api } = setup({ store: counting, clock });
  for (let i = 0; i < 100; i++) await decide(api, `${crypto.randomUUID()}.${'0'.repeat(32)}`);
  assert.equal(reads, 0, 'unsigned tokens never reach the store');
  const codes = [];
  for (let i = 0; i < 25; i++) codes.push((await call(api, 'leaderboard', { method: 'GET' })).status);
  assert.equal(codes.filter((c) => c === 429).length, 5);
  assert.equal(reads, 20, 'throttled requests read nothing');
  for (let i = 0; i < 600; i++) await inner.listPush('leaderboard', { i }, 5000);
  clock.t += 61e3;
  const lb = await call(api, 'leaderboard', { method: 'GET', ip: '192.0.2.200' });
  assert.equal(lb.body.matches.length, 500, 'reads capped well below the stored maximum');
  assert.equal(lb.body.matches.at(-1).i, 599);
});

test('expired matches give their unused budget back at the next start; calls stop when play time is up', async () => {
  const { api, store, clock } = setup();
  const s = await start(api);
  assert.ok(await committed(store) > 0);
  clock.t += (PLAY_S + 1) * 1000;
  assert.equal((await decide(api, s.body.matchToken)).status, 403);
  clock.t += 60e3;
  const before = matchReserveUsd([rosterById.jev, rosterById.laya]);
  await start(api);
  assert.ok(Math.abs(await committed(store) - before) < 1e-9, 'only the new match is held');
});

test('storage: REST when KV env is set, file locally, and fail closed on Vercel with no store', async () => {
  const sent = [];
  const fakeKv = async (url, o) => { sent.push({ url, body: JSON.parse(o.body), auth: o.headers.Authorization });
    return { ok: true, json: async () => (url.endsWith('/pipeline') ? [{ result: '0.25' }, { result: 1 }] : { result: 'OK' }) }; };
  const kv = createStore({ KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 't1' }, { fetch: fakeKv });
  assert.ok(kv instanceof RestStore && kv.durable);
  assert.equal(await kv.incrFloat('spend:usd:x', 0.25, 60), 0.25);
  assert.deepEqual(sent[0], { url: 'https://kv.example/pipeline', auth: 'Bearer t1', body: [['INCRBYFLOAT', 'spend:usd:x', '0.25'], ['EXPIRE', 'spend:usd:x', '60']] });
  assert.equal(await kv.setNx('lock', 1, 2500), true);
  assert.deepEqual(sent[1].body, ['SET', 'lock', '1', 'NX', 'PX', '2500']);
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
  const api = createHosted({ env: { VERCEL: '1', AI_GATEWAY_API_KEY: KEY }, fetch: g.fetcher, log: () => {} });
  const s = await call(api, 'matchStart', { body: { fighters: ['jev', 'laya'] } });
  assert.equal(s.status, 503); assert.match(s.body.error, /durable store/);
  assert.equal((await call(api, 'decide', { body: { matchToken: 'x', fighter: 'jev', scene } })).status, 503);
  assert.equal((await call(api, 'status', { method: 'GET' })).body.spend.exhausted, true);
  assert.equal(g.calls.length, 0);
});

test('prototype keys are plain unknown fighters, not crashes', async () => {
  const { api } = setup();
  const s = await start(api);
  for (const f of ['constructor', '__proto__', 'toString']) assert.equal((await decide(api, s.body.matchToken, f)).status, 400);
  assert.equal((await start(api, ['constructor', 'jev'])).status, 400);
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
