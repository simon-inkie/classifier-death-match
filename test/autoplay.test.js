import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { rotateRoster, spawnSlots, SpendGuard, parseArgs, runLiveMatch, runBatch, unhealthy } from '../scripts/autoplay.js';
import { DEFAULT_ROSTER, actionsFor } from '../public/shared.js';
import { DEFAULT_WEAPON_CONFIG } from '../public/weapons.js';
import { botDecide } from '../public/brain.js';
import { runLog, hashState, effectiveAction, ReplayCursor } from '../public/sim.js';
import { cleanRecord } from '../public/leaderboard.js';

class FakeClock {
  time = 0; timers = new Set();
  now = () => this.time;
  timer = (fn, ms) => { const t = { at: this.time + ms, fn }; this.timers.add(t); return t; };
  clear = (t) => this.timers.delete(t);
  sleep = async (ms) => {
    this.time += ms;
    for (const t of [...this.timers].sort((a, b) => a.at - b.at)) if (t.at <= this.time && this.timers.delete(t)) t.fn();
    // Let response.json() and the per-fighter finally handlers settle.
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
}
function fakeProxy(clock, { latency = 120, fail = () => false, budgetAt = Infinity, hang = () => false } = {}) {
  const asks = [];
  return { asks, fetcher: async (url, options) => {
    assert.equal(new URL(url).port, '8795');
    const { fighter, scene, weapons } = JSON.parse(options.body);
    asks.push({ fighter, at: clock.now(), scene, weapons });
    return new Promise((resolve, reject) => {
      const aborted = () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); };
      options.signal.addEventListener('abort', aborted, { once: true });
      if (hang(fighter)) return;
      clock.timer(() => {
        options.signal.removeEventListener('abort', aborted);
        const exhausted = clock.now() >= budgetAt, error = exhausted || fail(fighter);
        const data = error ? { error: exhausted ? 'cost budget spent' : 'HTTP 422: invalid question' }
          : { ...botDecide(scene), cost: 0.00005, costSource: 'gateway' };
        resolve({ ok: !error, status: exhausted ? 429 : error ? 502 : 200, json: async () => data });
      }, latency);
    });
  } };
}

test('rotation balances roster indices AND physical slots despite the seed offset', () => {
  for (const n of [2, 3, 4, 5]) for (const seedStart of [0, 1, 7, 42]) {
    const fighters = [...DEFAULT_ROSTER, 'gemini'].slice(0, n);
    const indexCounts = Object.fromEntries(fighters.map((id) => [id, Array(n).fill(0)]));
    const slotCounts = structuredClone(indexCounts);
    for (let i = 0; i < n * n; i++) {
      const roster = rotateRoster(fighters, i), slots = spawnSlots(roster, seedStart + i);
      for (const id of fighters) { indexCounts[id][roster.indexOf(id)]++; slotCounts[id][slots[id]]++; }
    }
    for (const id of fighters) { assert.deepEqual(indexCounts[id], Array(n).fill(n)); assert.deepEqual(slotCounts[id], Array(n).fill(n)); }
  }
});

test('CLI validates options, preserves pickup defaults and supports config fragments', () => {
  const o = parseArgs([]);
  assert.equal(o.matches, 50); assert.equal(o.parallel, 4); assert.equal(o.budgetGbp, 5); assert.equal(o.usdPerGbp, 1.3);
  assert.deepEqual(o.weaponConfig.pickups, { density: 0.75, respawn: 1 });
  assert.throws(() => parseArgs(['--fighters', 'jev,bot']));
  assert.throws(() => parseArgs(['--parallel', '0'])); assert.throws(() => parseArgs(['--budget-gbp', 'NaN']));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-config-'));
  try {
    const file = path.join(dir, 'config.json'); fs.writeFileSync(file, JSON.stringify({ shotgun: { dmg: 7 } }));
    const custom = parseArgs(['--config', file, '--aim', 'on']);
    assert.equal(custom.weaponConfig.shotgun.dmg, 7); assert.equal(custom.weaponConfig.pickups.density, 0.75);
    assert.equal(custom.weaponConfig.modelAims, true);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('spend forecast reserves ALL in-flight matches and honours the shared server cap', () => {
  const g = new SpendGuard({ limit: 1, status: { costBudget: { used: 0.2, max: 0.8 } }, forecast: 0.2 });
  assert.equal(g.canLaunch(), true); g.start(0); g.start(1);
  assert.equal(g.canLaunch(), true); g.start(2); assert.equal(g.canLaunch(), false);
  g.charge(0, 0.1, { costBudget: { used: 0.3 } });
  assert.ok(Math.abs(g.spent - 0.3) < 1e-10); assert.equal(g.canLaunch(), false);
  g.finish(0, true); assert.equal(g.average, 0.1); assert.equal(g.canLaunch(), true);
  g.observe({ costBudget: { used: 0.81 } }); assert.equal(g.exhausted, true); assert.equal(g.canLaunch(), false);
});

test('live headless loop records real arrival ticks, compact roster metadata, targets, costs and exact rotated replay', async () => {
  const clock = new FakeClock(), proxy = fakeProxy(clock, { latency: 140 });
  const roster = rotateRoster(DEFAULT_ROSTER, 5);
  const r = await runLiveMatch({ seed: 13, roster, server: 'http://127.0.0.1:8795',
    weapons: { ...DEFAULT_WEAPON_CONFIG, modelAims: true }, label: 'offline verification', clock, fetcher: proxy.fetcher, warn: () => {} });
  assert.equal(r.log.status, 'completed'); assert.equal(hashState(runLog(r.log)), r.log.result.hash);
  assert.deepEqual(r.log.roster.map((r) => r.id), roster);
  assert.equal(r.log.roster.find((r) => r.id === 'laya').prompt, 'compact');
  assert.ok(r.log.decisions.length > 100); assert.ok(r.log.decisions[0].t >= 4);
  assert.ok(r.log.decisions.some((d) => d.a.startsWith('shoot_')));
  assert.match(cleanRecord(r.record).note, /offline verification/);
  assert.ok(Object.values(r.stats).every((s) => s.cost > 0));
  assert.equal(r.log.decisions.every((d) => d.ms >= 140), true);
  for (const id of roster) {
    const asks = proxy.asks.filter((a) => a.fighter === id);
    for (let i = 1; i < asks.length; i++) assert.ok(asks[i].at - asks[i - 1].at >= 140);
  }
});

test('10 Hz cap, persistent errors and 2 s timeout produce stunned actions; replay stays exact', async () => {
  const clock = new FakeClock(), warnings = [], proxy = fakeProxy(clock, { latency: 10, fail: (id) => id === 'luna', hang: (id) => id === 'laya' });
  const r = await runLiveMatch({ seed: 1, roster: DEFAULT_ROSTER, server: 'http://127.0.0.1:8795', clock,
    fetcher: proxy.fetcher, warn: (w) => warnings.push(w) });
  assert.equal(hashState(runLog(r.log)), r.log.result.hash);
  assert.ok(warnings.some((w) => w.startsWith('luna'))); assert.ok(r.stats.laya.timeouts > 0);
  assert.ok(r.log.decisions.filter((d) => d.f === 'laya').every((d) => d.err.includes('timeout') && d.a === null && d.ms === 2000));
  const replay = new ReplayCursor(r.log);
  const firstError = r.log.decisions.find((d) => d.f === 'luna' && d.err);
  while (replay.state.tick <= firstError.t) replay.tick();
  const stunned = replay.state.fighters.find((f) => f.id === 'luna');
  assert.equal(stunned.stunned, true);
  assert.equal(effectiveAction(replay.state, stunned), 'hold');
  for (const id of DEFAULT_ROSTER) {
    const asks = proxy.asks.filter((a) => a.fighter === id);
    for (let i = 1; i < asks.length; i++) assert.ok(asks[i].at - asks[i - 1].at >= 100);
  }
  const samples = Array(10).fill(r);
  assert.match(unhealthy(samples, DEFAULT_ROSTER), /luna/); assert.equal(unhealthy(samples.slice(0, 9), DEFAULT_ROSTER), null);
});

test('budget stopping mid-match preserves an explicit aborted log with no leaderboard record', async () => {
  const clock = new FakeClock(), proxy = fakeProxy(clock, { budgetAt: 500 });
  const r = await runLiveMatch({ seed: 2, roster: DEFAULT_ROSTER, server: 'http://127.0.0.1:8795', clock, fetcher: proxy.fetcher, warn: () => {} });
  assert.equal(r.log.status, 'aborted'); assert.match(r.log.abortReason, /budget spent/);
  assert.equal(r.record, null); assert.ok(r.log.result.ticks < 100); assert.ok(r.log.calls.length > 0);
});

test('batch uses fake status/spend to stop launches and saves aborted logs/summary', async () => {
  const clock = new FakeClock(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-batch-'));
  const signals = new EventEmitter(); let used = 0, launched = 0, writes = 0;
  const fetcher = async (url) => {
    assert.equal(new URL(url).port, '8795');
    if (url.endsWith('/api/leaderboard/record')) { writes++; return { ok: true, json: async () => ({ ok: true }) }; }
    return { ok: true, json: async () => ({ keyLoaded: true, budget: { used: 0, max: 1e6 }, costBudget: { used, max: 1 } }) };
  };
  const runMatch = async (o) => {
    launched++;
    const proxy = fakeProxy(clock, { budgetAt: 500 });
    return runLiveMatch({ ...o, fetcher: proxy.fetcher, onCall: (call) => { used += call.cost; o.onCall(call); } });
  };
  try {
    const r = await runBatch(parseArgs(['--server', 'http://127.0.0.1:8795', '--matches', '50', '--parallel', '1']),
      { clock, fetcher, runMatch, signals, logsDir: dir, output: () => {}, warn: () => {} });
    assert.equal(launched, 1); assert.equal(writes, 0); assert.equal(r.results[0].log.status, 'aborted');
    assert.match(fs.readFileSync(r.file, 'utf8'), /aborted 1/);
    assert.ok(fs.readdirSync(dir).some((n) => n.endsWith('.json')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('Ctrl-C stops launches, lets active matches finish and serialises record POSTs', async () => {
  const clock = new FakeClock(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-interrupt-'));
  const signals = new EventEmitter(); let launched = 0, posting = 0, maxPosting = 0, writes = 0;
  const fetcher = async (url) => {
    assert.equal(new URL(url).port, '8795');
    if (url.endsWith('/api/status')) return { ok: true, json: async () => ({ keyLoaded: true, budget: { used: 0, max: 1e9 }, costBudget: { used: 0, max: 100 } }) };
    posting++; maxPosting = Math.max(maxPosting, posting); await Promise.resolve(); posting--; writes++;
    return { ok: true, json: async () => ({ ok: true }) };
  };
  const runMatch = async (o) => {
    launched++;
    const proxy = fakeProxy(clock);
    const r = await runLiveMatch({ ...o, fetcher: proxy.fetcher });
    signals.emit('SIGINT'); return r;
  };
  try {
    const r = await runBatch(parseArgs(['--server', 'http://127.0.0.1:8795', '--parallel', '2', '--budget-gbp', '100']),
      { clock, fetcher, runMatch, signals, logsDir: dir, output: () => {}, warn: () => {} });
    assert.equal(launched, 2); assert.equal(writes, 2); assert.equal(maxPosting, 1);
    assert.ok(r.results.every((r) => r.log.status === 'completed' && r.log.leaderboardRecorded));
    assert.match(r.reason, /Interrupted/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The real proxy is started only on 8795, points exclusively at this local fake
// gateway, uses a dummy key and temporary leaderboard, and is stopped by its PID.
test('offline proxy integration on 8795: USD cap, status, and concurrent atomic leaderboard writes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-proxy-'));
  let gatewayCalls = 0;
  const gateway = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* Consume the request. */ }
    gatewayCalls++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ answers: { action: { choice: 'hold', probabilities: { hold: 1 } } }, providerMetadata: { gateway: { cost: '0.01' } } }));
  });
  await new Promise((resolve) => gateway.listen(0, '127.0.0.1', resolve));
  const child = spawn(process.execPath, ['server.js'], { cwd: new URL('../', import.meta.url),
    env: { ...process.env, PORT: '8795', AI_GATEWAY_API_KEY: 'offline-dummy-key',
      AI_GATEWAY_BASE: `http://127.0.0.1:${gateway.address().port}`, CALL_BUDGET: '100', CALL_BUDGET_USD: '0.02',
      LEADERBOARD_FILE: path.join(dir, 'leaderboard.json') }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', (b) => { stderr += b; });
  const exit = once(child, 'exit');
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`proxy startup timeout: ${stderr}`)), 5000);
      child.stdout.on('data', (b) => { if (String(b).includes('Classifier Arena on')) { clearTimeout(timer); resolve(); } });
      child.once('exit', () => { clearTimeout(timer); reject(new Error(`proxy exited: ${stderr}`)); });
    });
    const post = (route, body) => fetch(`http://127.0.0.1:8795${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const scene = { enemies: [] };
    // Use a real scene generated by the runner's fake proxy request capture.
    const clock = new FakeClock(), proxy = fakeProxy(clock, { budgetAt: 150 });
    await runLiveMatch({ seed: 1, roster: DEFAULT_ROSTER, server: 'http://127.0.0.1:8795', clock, fetcher: proxy.fetcher, warn: () => {} });
    Object.assign(scene, proxy.asks[0].scene);
    for (let i = 0; i < 2; i++) assert.equal((await post('/api/decide', { fighter: 'jev', scene, weapons: DEFAULT_WEAPON_CONFIG })).status, 200);
    const denied = await post('/api/decide', { fighter: 'jev', scene, weapons: DEFAULT_WEAPON_CONFIG });
    assert.equal(denied.status, 429); assert.equal(gatewayCalls, 2);
    const status = await (await fetch('http://127.0.0.1:8795/api/status')).json();
    assert.deepEqual(status.costBudget, { used: 0.02, max: 0.02 });
    const c2 = new FakeClock(), p2 = fakeProxy(c2);
    const r = await runLiveMatch({ seed: 2, roster: rotateRoster(DEFAULT_ROSTER, 1), server: 'http://127.0.0.1:8795', clock: c2, fetcher: p2.fetcher, label: 'integration label', warn: () => {} });
    const replies = await Promise.all(Array.from({ length: 8 }, (_, i) => post('/api/leaderboard/record', { ...r.record, seed: i })));
    assert.ok(replies.every((r) => r.status === 200));
    const board = JSON.parse(fs.readFileSync(path.join(dir, 'leaderboard.json'), 'utf8'));
    assert.equal(board.matches.length, 8); assert.match(board.matches[0].note, /integration label/);
  } finally {
    child.kill('SIGTERM'); // Exact child PID only. Never touches 8787.
    await exit;
    await new Promise((resolve) => gateway.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
