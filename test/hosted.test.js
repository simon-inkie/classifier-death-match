// Hosted API (lib/hosted.js) and the model picker flag. Core money and danger only: the daily spend
// ceiling (atomic, held reservations, under concurrency), the worst-case call bound (scene schema, body
// and prompt caps, timeouts), token-bound server-built leaderboard records and markup stripping, the
// per-network start limits (IPv6 by /48) and the site-wide open-match cap, throttles before any store read, the storage fallback
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
import { createHosted, clientNetwork, PLAY_S, IDLE_S, MIN_LIFE_S } from '../lib/hosted.js';
import { createStore, MemoryStore, RestStore, FileStore } from '../lib/storage.js';
import { spendConfig, worstCallUsd, matchReserveUsd, trancheUsd, callBound, PROMPT_CHAR_CAP, PICKER_SAFETY } from '../lib/spend.js';
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
// A durable memory store that runs hook(key, by) before each incrFloat, to land a close inside a window.
class HookStore extends MemoryStore {
  durable = true;
  hook = null;
  async incrFloat(key, by, ttl) { if (this.hook) await this.hook(key, by); return super.incrFloat(key, by, ttl); }
}

// A fake gateway as a fetch function. cost: what each call reports (null = no cost and no usage),
// 'worst' = exactly the fighter's worst case. The action is the bot's choice for the request's own state.
function fakeGateway({ cost = 0.00001, fail = null, delayMs = 0 } = {}) {
  const calls = [];
  const fetcher = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body, auth: opts.headers?.Authorization });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    if (fail === 'timeout') { const e = new Error('aborted'); e.name = 'AbortError'; throw e; }
    if (fail === 503) return { ok: false, status: 503, text: async () => 'unavailable' };
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
  let status, out, hdrs;
  const res = { writeHead(c, h) { status = c; hdrs = h; }, end(b) { out = b; } };
  await api.handle(route, req, res);
  return { status, headers: hdrs || {}, body: JSON.parse(Buffer.isBuffer(out) ? out.toString() : out) };
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
  const { api, store } = setup({ env: { DAILY_SPEND_CEILING_GBP: '1', USD_PER_GBP: '1.30', MAX_OPEN_MATCHES: '100', MAX_MATCH_SHARE: '1' } }); // $1.30
  assert.equal(spendConfig({ DAILY_SPEND_CEILING_GBP: '1', USD_PER_GBP: '1.30' }).usd, 1.3);
  const four = ['jev', 'luna', 'laya', 'scaledown'];
  const tranche = trancheUsd(matchReserveUsd(four.map((id) => rosterById[id])));
  const fit = Math.floor(1.3 / tranche);
  const rs = await Promise.all(Array.from({ length: 40 }, () => start(api, four)));
  const ok = rs.filter((r) => r.status === 200);
  assert.equal(ok.length, fit, 'exactly the first tranches that fit');
  assert.ok(rs.filter((r) => r.status === 429).every((r) => r.body.busy), 'held by open matches: busy, not spent');
  assert.ok(await committed(store) <= 1.3 + 1e-9);
  assert.equal((await call(api, 'matchEnd', { body: { matchToken: ok[0].body.matchToken } })).body.closed, true);
  assert.equal((await start(api, four)).status, 200, 'released budget is usable again');
  assert.equal((await call(api, 'matchEnd', { body: { matchToken: ok[0].body.matchToken } })).body.closed, false, 'refund happens once');
  assert.ok(await committed(store) <= 1.3 + 1e-9);
});

test('ceiling: concurrent calls at the worst-case cost never take the day past the ceiling (tranches top up)', async () => {
  const gw = fakeGateway({ cost: 'worst' });
  const { api, store, clock, gateway } = setup({ env: { DAILY_SPEND_CEILING_GBP: '0.5', USD_PER_GBP: '1.30', MAX_MATCH_SHARE: '1' }, gateway: gw }); // $0.65
  const roster = ['jev', 'luna'];
  const tok = (await start(api, roster)).body.matchToken;
  const sc = { jev: sceneIn(roster, 'jev'), luna: sceneIn(roster, 'luna') };
  let wave = 0, okCalls = 0;
  for (;;) {
    const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => {
      const f = roster[i % 2];
      return call(api, 'decide', { body: { matchToken: tok, fighter: f, scene: sc[f] }, ip: `203.0.113.${(i % 200) + 1}` });
    }));
    const n = rs.filter((r) => r.status === 200).length;
    okCalls += n;
    assert.ok(n <= 2, 'one call in flight per fighter');
    clock.t += 100; wave++;
    if (!n || wave > 2000) break;
  }
  assert.equal(gateway.calls.length, okCalls);
  const full = matchReserveUsd(roster.map((id) => rosterById[id]));
  assert.ok(Math.abs(await committed(store) - full) < 1e-9, 'day holds exactly the full budget, reached tranche by tranche');
  assert.ok(await committed(store) <= 0.65);
  assert.ok(okCalls >= 1190 && okCalls <= 1200, `calls ${okCalls}: 600 worst-case calls per fighter, pooled`);
});

test('ceiling: cost above the bound is charged to the match at once, the day never runs below what was billed, and calls stop', async () => {
  const over = (url, o) => { const body = JSON.parse(o.body); const f = Object.values(rosterById).find((r) => r.model === body.model); return 2 * worstCallUsd(f); };
  let billed = 0;
  const gw = fakeGateway();
  const fetcher = async (url, o) => { const c = over(url, o); billed += c; const r = await fakeGateway({ cost: c }).fetcher(url, o); gw.calls.push(1); return r; };
  const { api, store, clock } = setup({ env: { DAILY_SPEND_CEILING_GBP: '0.5', USD_PER_GBP: '1.30', MAX_MATCH_SHARE: '1', MAX_OPEN_MATCHES: '100' }, gateway: { ...gw, fetcher } }); // $0.65
  const roster = ['jev', 'luna'];
  const sc = { jev: sceneIn(roster, 'jev'), luna: sceneIn(roster, 'luna') };
  const toks = [];
  for (let i = 0; i < 3; i++) { const r = await start(api, roster); if (r.status === 200) toks.push(r.body.matchToken); }
  let refusedForDay = false;
  for (let wave = 0; wave < 3000; wave++) {
    const rs = await Promise.all(toks.flatMap((t) => roster.map((f) => call(api, 'decide', { body: { matchToken: t, fighter: f, scene: sc[f] }, ip: freshIp() }))));
    if (rs.some((r) => r.body.ceilingReached || r.body.busy)) refusedForDay = true;
    if (!rs.some((r) => r.status === 200)) break;
    clock.t += 100;
  }
  assert.ok(refusedForDay, 'calls refused once the day is committed');
  const maxOne = 2 * worstCallUsd(rosterById.luna);
  assert.equal(toks.length, 3);
  assert.ok(billed <= 0.65 + toks.length * 2 * maxOne, `billed ${billed} against $0.65`);
  assert.ok(await committed(store) >= billed - 1e-9, 'the day counter never runs below what was billed');
  for (const t of toks) await call(api, 'matchEnd', { body: { matchToken: t } });
  assert.ok(Math.abs(await committed(store) - billed) < 1e-9, 'after settling, the day holds exactly what was billed');
});

test('ceiling: a match closed while a call is reserving refuses that call and refunds everything', async () => {
  const clock = { t: Date.UTC(2026, 10, 4, 12) };
  const inner = durableMemory(() => clock.t);
  let api, armed = null;
  const racing = new Proxy(inner, { get(o, k) {
    const v = o[k];
    if (k === 'incrFloat') return async (key, by, ttl) => { const r = await v.call(o, key, by, ttl);
      if (armed && key.endsWith(':spent') && by > 0) { const t = armed; armed = null; await call(api, 'matchEnd', { body: { matchToken: t } }); } return r; };
    return typeof v === 'function' ? v.bind(k === 'multi' ? racing : o) : v; // multi runs through the hook too
  } });
  const s0 = setup({ store: racing, clock });
  api = s0.api;
  const s = await start(api);
  armed = s.body.matchToken;
  const r = await decide(api, s.body.matchToken);
  assert.equal(r.status, 403); assert.equal(s0.gateway.calls.length, 0, 'no paid call slips past the close');
  // the close saw the call's reservation and kept it (the safe direction: over by one call bound, never under)
  assert.ok(Math.abs(await committed(inner) - worstCallUsd(rosterById.jev)) < 1e-12);
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

test('leaderboard: latency, cost, errors and timeouts come from the server, not the page', async () => {
  const { api, clock } = setup();
  const { token, decisions } = await playMatch(api, clock, ['jev', 'laya'], { ip: '192.0.2.77' });
  const forged = decisions.map((d) => ({ ...d, ms: d.f === 'laya' ? 99999 : 1, cost: d.f === 'laya' ? 1 : 0 }));
  const stunFlood = [...forged, ...Array.from({ length: 50 }, (_, i) => ({ t: 10 + i, f: 'laya', a: null, err: 'timeout' }))].sort((a, b) => a.t - b.t);
  const rec = (body) => call(api, 'record', { body, headers: { 'x-match-token': token }, ip: '192.0.2.77' });
  const flooded = await rec({ decisions: stunFlood });
  assert.equal(flooded.status, 400); assert.match(flooded.body.error, /stuns/);
  const ok = await rec({ decisions: forged });
  assert.equal(ok.status, 200);
  for (const f of ok.body.record.fighters) {
    assert.equal(f.meanMs, 0, 'server-observed latency (the fake gateway answers at once)');
    assert.ok(f.cost < 0.01, 'server-observed cost'); assert.equal(f.timeouts, 0); assert.equal(f.errors, 0);
  }
});

test('picker safety: a picked model is bounded at a multiple of its listed price, and other charges are refused', () => {
  const cat = parseCatalogue({ data: [
    { id: 'acme/per-request', type: 'language', pricing: { input: '0.0000001', output: '0.0000004', request: '0.005' } },
    { id: 'acme/tiers', type: 'language', pricing: { input: '0.0000001', output: '0.0000004', input_tiers: [] } },
    { id: 'acme/plain', type: 'language', pricing: { input: '0.0000001', output: '0.0000004', input_cache_read: '0.00000001' } },
    // the shape the gateway lists Anthropic models in: web search and fast mode are opt-in (never asked for),
    // and the bound takes the dearest regional rate
    { id: 'acme/regional', type: 'language', pricing: { input: '0.000002', output: '0.00001', input_cache_write: '0.0000025', web_search: '10',
      fast: { input: '0.000008', output: '0.00004' }, regional: { eu: { input: '0.0000022', output: '0.000011', input_cache_write: '0.00000275' } } } },
    { id: 'acme/bad-region', type: 'language', pricing: { input: '0.000002', output: '0.00001', regional: { eu: { input: '0.0000022', output: '0.000011', request: '1' } } } },
    { id: 'acme/odd-region', type: 'language', pricing: { input: '0.000002', output: '0.00001', regional: 'eu' } },
  ] });
  for (const id of ['acme/per-request', 'acme/tiers', 'acme/bad-region', 'acme/odd-region']) assert.equal(cat.find((m) => m.id === id).price, null, id);
  assert.deepEqual(cat.find((m) => m.id === 'acme/regional').price, { in: 0.00000275, out: 0.000011 });
  const r = resolveFighter('jev', 'acme/plain', { enabled: true, models: cat });
  assert.ok(r.ok);
  assert.ok(Math.abs(callBound(r.fighter, true) - PICKER_SAFETY * worstCallUsd(r.fighter)) < 1e-15);
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

test('rate limits: starts count per network (IPv6 by /48) even when ended at once; open matches are capped atomically', async () => {
  assert.equal(clientNetwork({ headers: { 'x-real-ip': '2001:db8:0:1::abcd' } }), clientNetwork({ headers: { 'x-real-ip': '2001:0db8:0000:0001:ffff:1:2:3' } }));
  assert.notEqual(clientNetwork({ headers: { 'x-real-ip': '2001:db8:0:1::1' } }), clientNetwork({ headers: { 'x-real-ip': '2001:db8:0:2::1' } }));
  assert.equal(clientNetwork({ headers: { 'x-real-ip': '2001:db8:0:1::1' } }, 48), clientNetwork({ headers: { 'x-real-ip': '2001:db8:0:ff::1' } }, 48));
  assert.equal(clientNetwork({ headers: { 'x-real-ip': '::ffff:192.0.2.1' } }), '192.0.2.1');
  const { api, clock } = setup({ env: { MATCH_RATE_LIMIT: '5' } });
  let ok = 0;
  for (let i = 0; i < 20; i++) {
    clock.t += (MIN_LIFE_S + 1) * 1000;
    const r = await start(api, ['jev', 'laya'], { ip: `2001:db8:0:${i.toString(16)}::1` });
    if (r.status === 200) { ok++; await call(api, 'matchEnd', { body: { matchToken: r.body.matchToken } }); }
  }
  assert.equal(ok, 5, 'five per /48, however many /64s it rotates through, each ended at once');
  assert.equal((await start(api, ['jev', 'laya'], { ip: '2001:db8:1::1' })).status, 200, 'another /48');

  const g = setup({ env: { MAX_OPEN_MATCHES: '3' } });
  const noisy = [];
  for (let i = 0; i < 10; i++) noisy.push((await start(g.api, ['jev', 'laya'], { ip: '192.0.2.50' })).status);
  assert.equal(noisy.filter((c) => c === 200).length, 1, 'one open match for the noisy network');
  const toks = [], codes = [];
  for (let i = 0; i < 4; i++) { const r = await start(g.api); codes.push(r.status); if (r.status === 200) toks.push(r.body.matchToken); }
  assert.deepEqual(codes, [200, 200, 429, 429], 'refused starts hold no slot');
  for (const t of toks) await call(g.api, 'matchEnd', { body: { matchToken: t } });
  assert.equal((await start(g.api)).status, 429, 'a match ended at once keeps its slot for the minimum lifetime');
  g.clock.t += (MIN_LIFE_S + 1) * 1000;
  assert.equal((await start(g.api)).status, 200, 'and frees it after');

  const b = setup({ env: { MAX_OPEN_MATCHES: '5' } });
  const burst = await Promise.all(Array.from({ length: 40 }, () => start(b.api)));
  assert.equal(burst.filter((r) => r.status === 200).length, 5, 'a concurrent burst cannot pass the cap');
  assert.equal((await b.store.listRange('open-matches')).length, 5);
});

test('lock-out: one open match per network, a cap on any one match, and idle matches release at once', async () => {
  const { api, store, clock } = setup({ env: { MAX_OPEN_MATCHES: '100' } });
  const five = ['jev', 'luna', 'laya', 'scaledown', 'gemini'];
  const first = await start(api, five, { ip: '192.0.2.9' });
  assert.equal(first.status, 200);
  const second = await start(api, five, { ip: '192.0.2.9' });
  assert.equal(second.status, 429); assert.equal(second.body.oneAtATime, true);
  const dear = setup({ env: { MAX_MATCH_SHARE: '0.1' } }).api;
  const r = await start(dear, five);
  assert.equal(r.status, 400); assert.match(r.body.error, /too expensive/);
  const held = await committed(store);
  assert.ok(held < trancheUsd(matchReserveUsd(five.map((id) => rosterById[id]))) + 1e-9, 'only a tranche is held up front');
  clock.t += (IDLE_S + 1) * 1000;
  assert.equal((await start(api, ['jev', 'laya'])).status, 200);
  assert.ok(Math.abs(await committed(store) - trancheUsd(matchReserveUsd([rosterById.jev, rosterById.laya]))) < 1e-9, 'the idle match was released');
  assert.equal((await start(api, five, { ip: '192.0.2.9' })).status, 200, 'and its network can play again');
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
  assert.equal((await decide(api, s.body.matchToken)).status, 200);
  clock.t += (PLAY_S + 1) * 1000;
  assert.equal((await decide(api, s.body.matchToken)).status, 403);
  clock.t += 60e3;
  const spentBefore = await committed(store);
  await start(api);
  const tranche = trancheUsd(matchReserveUsd([rosterById.jev, rosterById.laya]));
  assert.ok(spentBefore > 0);
  assert.ok(Math.abs(await committed(store) - tranche - 0.00001) < 1e-9, 'day = new tranche + the one call actually spent');
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
  const { api } = setup({ env: { ENABLE_MODEL_PICKER: '1', MAX_MATCH_SHARE: '0.5' }, gateway: { ...gw, fetcher } });
  const models = (await call(api, 'models', { method: 'GET' })).body;
  assert.equal(models.enabled, true); assert.equal(models.source, 'gateway');
  assert.deepEqual(models.models.map((m) => m.id), ['acme/cheap-chat'], 'the list offers only models under the per-call cap');
  for (const [model, re] of [['https://evil.example/x', /invalid/], ['acme/missing', /unknown/], ['acme/no-price', /no listed per-token price/], ['acme/dear-chat', /too expensive/]]) {
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

test('top-up hand-back: a close inside the hand-back window never refunds the same tranche twice', async () => {
  const clock = { t: Date.UTC(2026, 10, 4, 12) };
  const store = new HookStore({ now: () => clock.t });
  const gw = fakeGateway({ cost: 'worst' });
  let billed = 0;
  const fetcher = async (url, o) => { billed += worstCallUsd(Object.values(rosterById).find((r) => r.model === JSON.parse(o.body).model)); return gw.fetcher(url, o); };
  const { api } = setup({ store, clock, gateway: { ...gw, fetcher } });
  const roster = ['jev', 'laya'], ip = '192.0.2.5';
  const tok = (await start(api, roster, { ip })).body.matchToken, id = tok.split('.')[0];
  const T = trancheUsd(matchReserveUsd(roster.map((f) => rosterById[f])));
  for (let i = 0; i < 500; i++) for (const f of roster) { clock.t += 50; assert.equal((await call(api, 'decide', { body: { matchToken: tok, fighter: f, scene: sceneIn(roster, f) }, ip })).status, 200); }
  let fired = false;
  store.hook = async (key, by) => {
    if (fired || !(key === `match:${id}:reserve` && by < 0)) return;
    fired = true; store.hook = null;
    await call(api, 'matchEnd', { body: { matchToken: tok }, ip });
  };
  clock.t += 100;
  await Promise.all(roster.map((f) => call(api, 'decide', { body: { matchToken: tok, fighter: f, scene: sceneIn(roster, f) }, ip })));
  assert.ok(fired, 'both fighters topped up at once and the close landed between the second top-up and its hand-back');
  const day = await committed(store), used = Number(await store.get(`used:usd:${DAY}`)) || 0;
  assert.ok(day >= billed - 1e-9, `day ${day} never below billed ${billed}`);
  assert.ok(day >= used - 1e-9, 'committed spend never below the spend of closed matches');
  assert.ok(day - billed <= T + 1e-9, 'at most one tranche held, in the safe direction');
});

test('top-up during close: the call is refused and nothing is refunded twice', async () => {
  const clock = { t: Date.UTC(2026, 10, 4, 12) };
  const store = new HookStore({ now: () => clock.t });
  const { api, gateway } = setup({ store, clock, gateway: fakeGateway({ cost: 'worst' }) });
  const roster = ['jev', 'laya'], ip = '192.0.2.6';
  const tok = (await start(api, roster, { ip })).body.matchToken, id = tok.split('.')[0];
  const T = trancheUsd(matchReserveUsd(roster.map((f) => rosterById[f])));
  for (let i = 0; i < 100; i++) for (const f of roster) { clock.t += 50; assert.equal((await call(api, 'decide', { body: { matchToken: tok, fighter: f, scene: sceneIn(roster, f) }, ip })).status, 200); }
  const billed = Number(await store.get(`match:${id}:spent`));
  store.hook = async (key, by) => {
    if (!(key === `match:${id}:reserve` && by > 0)) return;
    store.hook = null;
    await call(api, 'matchEnd', { body: { matchToken: tok }, ip });
  };
  clock.t += 100;
  const r = await call(api, 'decide', { body: { matchToken: tok, fighter: 'jev', scene: sceneIn(roster, 'jev') }, ip });
  assert.equal(r.status, 403); assert.equal(gateway.calls.length, 200, 'no paid call after the close');
  const day = await committed(store);
  // the close read spent with this call's bound in it, so the day may also keep that one bound
  assert.ok(day >= billed - 1e-9 && day - billed <= T + worstCallUsd(rosterById.jev) + 1e-9, `day ${day}: what was billed, plus at most one tranche and one bound (safe direction)`);
});

test('idle sweep: a match whose calls cost 0 or fail is still live; one with no attempts is closed', async () => {
  for (const gateway of [fakeGateway({ cost: 0 }), fakeGateway({ fail: 503 })]) {
    const { api, clock } = setup({ gateway });
    const roster = ['jev', 'laya'], ip = '192.0.2.8';
    const tok = (await start(api, roster, { ip })).body.matchToken;
    for (let s = 0; s < IDLE_S + 10; s++) {
      clock.t += 1000;
      await start(api); // another player's start runs the sweep
      const r = await call(api, 'decide', { body: { matchToken: tok, fighter: 'jev', scene: sceneIn(roster, 'jev') }, ip });
      assert.notEqual(r.status, 403, `still live after ${s + 1} s of attempts`);
    }
    clock.t += (IDLE_S + 1) * 1000;
    await start(api);
    assert.equal((await call(api, 'decide', { body: { matchToken: tok, fighter: 'jev', scene: sceneIn(roster, 'jev') }, ip })).status, 403, 'closed once attempts stop');
  }
});

test('excess: the only match on the day is not cut short as busy when calls cost more than their bound', async () => {
  const roster = ['jev', 'luna'], F = matchReserveUsd(roster.map((f) => rosterById[f]));
  let billed = 0;
  const gw = fakeGateway();
  const fetcher = async (url, o) => { const c = 2 * worstCallUsd(Object.values(rosterById).find((r) => r.model === JSON.parse(o.body).model)); billed += c; return fakeGateway({ cost: c }).fetcher(url, o); };
  const { api, store, clock } = setup({ env: { DAILY_SPEND_CEILING_GBP: String((F * 1.05) / 1.3), USD_PER_GBP: '1.30', MAX_MATCH_SHARE: '1' }, gateway: { ...gw, fetcher } });
  const tok = (await start(api, roster)).body.matchToken;
  let last;
  for (let i = 0; i < 2000; i++) {
    const rs = await Promise.all(roster.map((f) => call(api, 'decide', { body: { matchToken: tok, fighter: f, scene: sceneIn(roster, f) } })));
    last = rs.find((r) => r.status !== 200);
    if (last) break;
    clock.t += 100;
  }
  assert.ok(last, 'calls stop');
  assert.ok(!last.body.busy, `not told other matches hold the day: ${JSON.stringify(last.body)}`);
  assert.ok(billed >= 0.95 * F, `played to its full budget: billed ${billed} of ${F}`);
  assert.ok(await committed(store) >= billed - 1e-9, 'the day never runs below what was billed');
  await call(api, 'matchEnd', { body: { matchToken: tok } });
  assert.ok(Math.abs(await committed(store) - billed) < 1e-9, 'settles to exactly what was billed');
});

test('leaderboard: decisions listed out of tick order are refused', async () => {
  const { api, clock } = setup();
  const { token, decisions } = await playMatch(api, clock, ['jev', 'laya'], { ip: '192.0.2.78' });
  const maxT = Math.max(...decisions.map((d) => d.t));
  const reversed = decisions.map((d) => ({ ...d, t: maxT - d.t }));
  const r = await call(api, 'record', { body: { decisions: reversed }, headers: { 'x-match-token': token }, ip: '192.0.2.78' });
  assert.equal(r.status, 400); assert.match(r.body.error, /tick order/);
});

// A store where every round trip (one method call, or one multi batch) takes L ms, to count the serial
// round trips a decide waits on before and after its gateway call.
const L = 25;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class SlowStore extends MemoryStore {
  durable = true;
  async multi(ops) { await sleep(L); const out = []; for (const [m, ...a] of ops) out.push(await MemoryStore.prototype[m].apply(this, a)); return out; }
}
for (const m of ['get', 'set', 'setNx', 'setPx', 'del', 'incr', 'incrFloat', 'listPush', 'listRange', 'listTail', 'listRemove']) {
  SlowStore.prototype[m] = async function (...a) { await sleep(L); return MemoryStore.prototype[m].apply(this, a); };
}
async function measureDecide(api, gw, token, fighter = 'jev') {
  const t0 = performance.now();
  const r = await call(api, 'decide', { body: { matchToken: token, fighter, scene: sceneIn(['jev', 'laya'], fighter) }, ip: '192.0.2.90' });
  const t3 = performance.now(), [t1, t2] = gw.at;
  return { r, before: Math.round((t1 - t0) / L), after: Math.round((t3 - t2) / L) };
}
function timedGateway(cost) {
  const g = fakeGateway({ cost });
  const out = { calls: g.calls, at: [], fetcher: async (url, o) => { out.at = [performance.now()]; const r = await g.fetcher(url, o); out.at.push(performance.now()); return r; } };
  return out;
}

const SECRET = 'a-test-token-secret-of-enough-length';
test('latency: a decide waits on 1 store round trip before the gateway call when warm, 2 when cold, and 1 after', async (t) => {
  const clock = { t: Date.UTC(2026, 10, 4, 12) };
  const gw = timedGateway(0.00001);
  const { api, store } = setup({ env: { ARENA_TOKEN_SECRET: SECRET }, store: new SlowStore({ now: () => clock.t }), clock, gateway: gw });
  const tok = (await start(api, ['jev', 'laya'], { ip: '192.0.2.90' })).body.matchToken;
  clock.t += 200;
  const warm = await measureDecide(api, gw, tok, 'jev');
  assert.equal(warm.r.status, 200);
  assert.match(warm.r.headers['Server-Timing'], /kv;dur=[\d.]+;desc="store, 1 before \+ 1 after", gateway;dur=[\d.]+, total;dur=[\d.]+/);
  // another instance (no cached match record) serving the same match
  const other = createHosted({ env: { AI_GATEWAY_API_KEY: KEY, ARENA_TOKEN_SECRET: SECRET }, store, fetch: gw.fetcher, now: () => clock.t, log: () => {} });
  const cold = await measureDecide(other, gw, tok, 'laya');
  assert.equal(cold.r.status, 200);
  // a call that cost more than its bound settles its excess in one more trip
  const dear = timedGateway('worst');
  dear.fetcher = ((f) => async (url, o) => { const r = await f(url, o); const j = await r.json(); j.provider_metadata.gateway.cost *= 2; return { ...r, text: async () => JSON.stringify(j) }; })(dear.fetcher);
  const d = createHosted({ env: { AI_GATEWAY_API_KEY: KEY, ARENA_TOKEN_SECRET: SECRET }, store, fetch: dear.fetcher, now: () => clock.t, log: () => {} });
  clock.t += 200;
  const excess = await measureDecide(d, dear, tok, 'jev');
  assert.equal(excess.r.status, 200);
  t.diagnostic(`serial store round trips: warm ${warm.before} before + ${warm.after} after; cold ${cold.before} + ${cold.after}; excess ${excess.before} + ${excess.after}`);
  assert.equal(warm.before, 1, 'warm: lock, reservation and re-reads in one trip');
  assert.equal(cold.before, 2, 'cold: the match record and lock, then the reservation and re-reads');
  assert.equal(warm.after, 1); assert.equal(cold.after, 1, 'settlement, observation and lock release in one trip');
  assert.ok(excess.after <= 2, 'excess: one more trip to put it on the day');
});

test('store batching: multi is one ordered /pipeline POST on the REST store; waitUntil takes only the idle timestamp', async () => {
  const posts = [];
  const fetcher = async (url, o) => {
    const cmds = JSON.parse(o.body); posts.push({ url, cmds });
    const res = cmds.map((c) => ({ result: c[0] === 'SET' ? (c.includes('NX') ? 'OK' : 'OK') : c[0] === 'INCRBYFLOAT' ? '1.5' : c[0] === 'GET' ? null : c[0] === 'RPUSH' ? 3 : 1 }));
    return { ok: true, status: 200, json: async () => res };
  };
  const rs = new RestStore({ url: 'https://kv.example', token: 't', fetch: fetcher });
  const out = await rs.multi([['setNx', 'lock', 1, 500], ['incrFloat', 'spent', 0.5, 60], ['get', 'closed'], ['listPush', 'acts', { a: 1 }, 10, 60]]);
  assert.equal(posts.length, 1); assert.match(posts[0].url, /\/pipeline$/);
  assert.deepEqual(posts[0].cmds.map((c) => c[0]), ['SET', 'INCRBYFLOAT', 'EXPIRE', 'GET', 'RPUSH', 'LTRIM', 'EXPIRE'], 'in the order given: raise first, read after');
  assert.deepEqual(out, [true, 1.5, null, 3]);

  const clock = { t: Date.UTC(2026, 10, 4, 12) };
  const later = [];
  const store = durableMemory(() => clock.t);
  const api = createHosted({ env: { AI_GATEWAY_API_KEY: KEY }, store, fetch: fakeGateway().fetcher, now: () => clock.t, log: () => {}, waitUntil: (p) => later.push(p) });
  const tok = (await call(api, 'matchStart', { body: { fighters: ['jev', 'laya'] }, ip: '192.0.2.91' })).body.matchToken, id = tok.split('.')[0];
  const r = await call(api, 'decide', { body: { matchToken: tok, fighter: 'jev', scene: sceneIn(['jev', 'laya'], 'jev') }, ip: '192.0.2.91' });
  assert.equal(r.status, 200); assert.equal(later.length, 1, 'one background write');
  assert.equal((await store.listRange(`match:${id}:acts:jev`)).length, 1, 'the observation is written before the response');
  assert.ok(Number(await store.get(`match:${id}:spent`)) > 0, 'and the charge');
  await Promise.all(later);
  assert.equal(await store.get(`match:${id}:last`), clock.t, 'the idle timestamp lands after');
});

test('settlement: a failed bookkeeping command cannot stop the excess of a call that ran past a close reaching the day', async () => {
  const clock = { t: Date.UTC(2026, 10, 4, 12) };
  class FailBook extends MemoryStore {
    durable = true;
    async multi(ops) { const out = await super.multi(ops); if (ops.some(([m]) => m === 'listPush')) throw new Error('store: injected RPUSH error'); return out; }
  }
  const store = new FailBook({ now: () => clock.t });
  let api, tok, billed = 0;
  const fetcher = async (url, o) => {
    const c = 5 * worstCallUsd(Object.values(rosterById).find((r) => r.model === JSON.parse(o.body).model)); billed += c;
    await call(api, 'matchEnd', { body: { matchToken: tok } }); // the close lands while the call is out
    return fakeGateway({ cost: c }).fetcher(url, o);
  };
  ({ api } = setup({ store, clock, gateway: { calls: [], fetcher } }));
  tok = (await start(api)).body.matchToken;
  const r = await call(api, 'decide', { body: { matchToken: tok, fighter: 'jev', scene }, ip: '203.0.113.7' }).catch((e) => ({ status: 500, e }));
  assert.notEqual(r.status, 200, 'the store error still fails the request');
  assert.ok(billed > 0);
  assert.ok(await committed(store) >= billed - 1e-12, `day ${await committed(store)} never below billed ${billed}`);
});

test('warm decide: a match whose record is gone is refused even if its closed flag is gone too', async () => {
  const { api, store, gateway } = setup();
  const tok = (await start(api)).body.matchToken, id = tok.split('.')[0];
  assert.equal((await call(api, 'decide', { body: { matchToken: tok, fighter: 'jev', scene } })).status, 200); // cached on this instance
  await store.del(`match:${id}`); await store.del(`match:${id}:closed`); // evicted or flushed
  const before = gateway.calls.length;
  const r = await call(api, 'decide', { body: { matchToken: tok, fighter: 'laya', scene: sceneIn(['jev', 'laya'], 'laya') } });
  assert.equal(r.status, 403); assert.equal(gateway.calls.length, before, 'no paid call');
});
