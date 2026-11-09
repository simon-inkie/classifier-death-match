import { answerTimeoutMs } from '../public/answer-timeout.js';
// Real-time, browser-free live matches. Importing this module makes no requests.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROSTER, rosterById, actionsFor, median, MAX_FIGHTERS } from '../public/shared.js';
import { createMatch, applyAction, step, sceneFor, hashState, runLog, TICK_HZ } from '../public/sim.js';
import { rosterEntry } from '../public/brain.js';
import { DEFAULT_WEAPON_CONFIG, normaliseWeapons, configId, configSummary } from '../public/weapons.js';
import { buildRecord, aggregate } from '../public/leaderboard.js';
import { estCost } from '../public/cost.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const realClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timer: (fn, ms) => setTimeout(fn, ms),
  clear: (timer) => clearTimeout(timer),
};
const TICK_MS = 1000 / TICK_HZ;
const MIN_GAP_MS = 100;

// The sim already offsets physical spawns by seed % n. A simple left rotation
// cancels it, and a simple right rotation visits only half the slots for even n.
// Change phase each n matches: both roster indices and physical slots balance
// over n*n matches, while the order changes on every match.
export function rotateRoster(roster, index) {
  const n = roster.length, shift = (index + Math.floor(index / n)) % n;
  return roster.map((_, i) => roster[(i - shift + n) % n]);
}
export const spawnSlots = (roster, seed) => Object.fromEntries(roster.map((id, i) =>
  [id, (i + ((seed % roster.length) + roster.length) % roster.length) % roster.length]));

export function parseArgs(args) {
  const o = { matches: 50, parallel: 4, fighters: [...DEFAULT_ROSTER], aim: 'off',
    seedStart: Date.now() % 1e9, budgetGbp: 5, usdPerGbp: 1.30, server: 'http://127.0.0.1:8787', label: '', weapons: 'default' };
  const keys = { matches: 'matches', parallel: 'parallel', fighters: 'fighters', aim: 'aim', 'seed-start': 'seedStart',
    'budget-gbp': 'budgetGbp', 'usd-per-gbp': 'usdPerGbp', server: 'server', label: 'label', weapons: 'weapons', config: 'config' };
  for (let i = 0; i < args.length; i++) {
    const key = keys[args[i].slice(2)];
    if (!args[i].startsWith('--') || !key || args[i + 1] == null) throw new Error(`unknown or incomplete option: ${args[i]}`);
    o[key] = args[++i];
  }
  for (const key of ['matches', 'parallel', 'seedStart', 'budgetGbp', 'usdPerGbp']) {
    o[key] = Number(o[key]);
    if (!Number.isFinite(o[key]) || o[key] < (key === 'seedStart' ? 0 : Number.MIN_VALUE)) throw new Error(`invalid ${key}`);
  }
  for (const key of ['matches', 'parallel', 'seedStart']) if (!Number.isSafeInteger(o[key])) throw new Error(`${key} must be an integer`);
  if (o.seedStart + o.matches > 1e9) throw new Error('seeds must stay below 1e9 (leaderboard range)');
  if (typeof o.fighters === 'string') o.fighters = o.fighters.split(',');
  if (o.fighters.length < 2 || o.fighters.length > MAX_FIGHTERS || new Set(o.fighters).size !== o.fighters.length ||
    o.fighters.some((id) => !rosterById[id] || id === 'bot')) throw new Error(`choose 2 to ${MAX_FIGHTERS} distinct model fighters`);
  if (!['on', 'off'].includes(o.aim) || o.weapons !== 'default') throw new Error('use --aim on|off and --weapons default (or --config file)');
  const url = new URL(o.server);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('server must be HTTP(S)');
  o.server = o.server.replace(/\/$/, '');
  const input = o.config ? JSON.parse(fs.readFileSync(o.config, 'utf8')) : DEFAULT_WEAPON_CONFIG;
  // Config fragments inherit current pickup defaults; legacy replay normalisation remains unchanged.
  o.weaponConfig = normaliseWeapons({ ...DEFAULT_WEAPON_CONFIG, ...input,
    pickups: { ...DEFAULT_WEAPON_CONFIG.pickups, ...input.pickups }, modelAims: o.aim === 'on' });
  o.label = String(o.label).slice(0, 200);
  return o;
}

export async function jsonRequest(fetcher, server, route, body, signal) {
  const response = await fetcher(`${server}${route}`, { ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: signal || AbortSignal.timeout(10000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

// One live match: independent asynchronous fighter loops; fixed physics ticks.
// Clock/fetch injection is solely for offline deterministic tests, never a CLI speed switch.
export async function runLiveMatch({ seed, roster, weapons = DEFAULT_WEAPON_CONFIG, label = '', server,
  fetcher = fetch, clock = realClock, shouldAbort = () => null, onCall = () => {}, warn = console.warn }) {
  const state = createMatch({ seed, roster, weapons });
  const timeoutMs = answerTimeoutMs(state.weapons);
  const stats = Object.fromEntries(roster.map((id) => [id, { lat: [], errors: 0, timeouts: 0,
    decisions: 0, calls: 0, cost: 0, costEst: false, targetsChosen: {} }]));
  const log = { version: 1, mode: 'live', modelAims: Boolean(state.weapons.modelAims), seed,
    createdAt: new Date().toISOString(), bot: false, label, roster: roster.map((id) => ({ ...rosterEntry(id), kind: rosterById[id].kind })),
    spawnSlots: spawnSlots(roster, seed), weapons: state.weapons, weaponsId: configId(state.weapons),
    weaponsSummary: configSummary(state.weapons), decisions: [], calls: [] };
  const queue = [], pending = new Set(), controllers = new Set();
  const control = Object.fromEntries(roster.map((id) => [id, { lastAsk: -Infinity, busy: false, streak: 0, stopped: false }]));
  let stopped = false, abortReason = null;
  function ask(id) {
    const c = control[id], f = state.fighters.find((f) => f.id === id);
    if (stopped || state.over || !f.alive || c.busy || c.stopped) return;
    abortReason ||= shouldAbort();
    if (abortReason) return;
    const remaining = c.lastAsk + MIN_GAP_MS - clock.now();
    if (remaining > 0) { c.nextTimer = clock.timer(() => ask(id), Math.ceil(remaining)); return; }
    c.busy = true; c.lastAsk = clock.now();
    const scene = sceneFor(state, id), askedTick = state.tick, ac = new AbortController();
    controllers.add(ac);
    const timer = clock.timer(() => ac.abort(), timeoutMs);
    const task = (async () => {
      let ans = null, err = null, cost = 0, costEst = false, status = null, data;
      try {
        const response = await fetcher(`${server}/api/decide`, { method: 'POST', signal: ac.signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fighter: id, scene, weapons: state.weapons }) });
        status = response.status; data = await response.json();
        if (!response.ok) err = data.error || `HTTP ${status}`;
        else {
          if (!actionsFor(scene).includes(data.action)) throw new Error('invalid action from proxy');
          ans = data;
          const real = data.costSource ? data.costSource !== 'none' : Number(data.cost) > 0;
          cost = real ? Math.max(0, Number(data.cost) || 0) : estCost(rosterById[id]); costEst = !real;
        }
      } catch (e) { err = e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message; }
      finally { clock.clear(timer); controllers.delete(ac); }
      const ms = Math.round(clock.now() - c.lastAsk), s = stats[id];
      // Account even for answers arriving after death or the final physics tick.
      s.calls++; s.cost += cost; s.costEst ||= costEst;
      if (err) { s.errors++; if (/timeout/i.test(err)) s.timeouts++; c.streak++; }
      else { s.lat.push(ms); c.streak = 0; }
      if (c.streak === 3) warn(`${id}: repeated errors (${err}); remains stunned until a good answer`);
      log.calls.push({ f: id, askedTick, returnedTick: state.tick, ms, status, err, cost, costEst });
      if (err && (status === 429 || /budget spent|not set/.test(err))) {
        abortReason ||= err; c.stopped = true;
      }
      onCall({ id, cost, costEst, data, err, status });
      if (!stopped && !state.over) queue.push({ id, ans, err, ms, cost, costEst });
      c.busy = false;
      if (!stopped && !state.over && !c.stopped) {
        c.nextTimer = clock.timer(() => ask(id), Math.max(0, Math.ceil(c.lastAsk + MIN_GAP_MS - clock.now())));
      }
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  }
  function drain() {
    while (queue.length) {
      const q = queue.shift(), f = state.fighters.find((f) => f.id === q.id);
      if (!f.alive) continue;
      const d = { t: state.tick, f: q.id, a: q.err ? null : q.ans.action, probs: q.ans?.probs ?? null,
        conf: q.ans?.confidence ?? null, ms: q.ms, err: q.err || null, cost: q.cost, ...(q.costEst ? { costEst: true } : {}) };
      applyAction(state, q.id, q.err ? 'stunned' : q.ans.action);
      log.decisions.push(d); stats[q.id].decisions++;
      if (state.weapons.modelAims && !d.err && d.a.startsWith('shoot_')) {
        const counts = stats[q.id].targetsChosen, target = d.a.slice(6); counts[target] = (counts[target] || 0) + 1;
      }
    }
  }
  // Timers schedule calls at wall time, independent of physics (as in game.js).
  for (const id of roster) ask(id);
  let last = clock.now(), acc = 0;
  while (!state.over) {
    await clock.sleep(5);
    const now = clock.now(); acc += Math.min(250, now - last); last = now;
    abortReason ||= shouldAbort();
    if (abortReason) break;
    while (acc + 1e-8 >= TICK_MS && !state.over) { drain(); step(state); acc -= TICK_MS; }
  }
  stopped = true;
  for (const c of Object.values(control)) clock.clear(c.nextTimer);
  // On a budget abort, stop outstanding requests. On normal finish, settle them
  // (at most the configured answer timeout) for honest accounting, without applying late actions.
  if (abortReason) for (const ac of controllers) ac.abort();
  while (pending.size) await clock.sleep(5);
  log.status = abortReason ? 'aborted' : 'completed';
  log.abortReason = abortReason;
  log.result = { winner: state.winner, ranking: state.ranking, ticks: state.tick, hash: hashState(state),
    stats: Object.fromEntries(roster.map((id) => [id, { ...stats[id], medianMs: median(stats[id].lat) }])) };
  let record = null;
  if (!abortReason) {
    if (hashState(runLog(log)) !== log.result.hash) throw new Error(`replay mismatch for seed ${seed}`);
    record = buildRecord({ state, mode: 'live', weapons: state.weapons, stats });
    if (label) record.note += `; ${label}`;
  }
  return { state, log, record, stats };
}

export class SpendGuard {
  constructor({ limit, status, forecast }) {
    this.limit = Math.min(limit, status.costBudget?.max ?? Infinity);
    this.initial = status.costBudget?.used || 0;
    this.serverUsed = this.initial; this.localCost = 0; this.forecast = forecast;
    this.completed = []; this.active = new Map();
  }
  get spent() { return Math.max(this.serverUsed, this.initial + this.localCost); }
  observe(status) { this.serverUsed = Math.max(this.serverUsed, status.costBudget?.used || 0); }
  charge(index, cost, data) {
    this.localCost += cost;
    this.active.set(index, (this.active.get(index) || 0) + cost);
    if (data) this.observe(data);
  }
  get average() { return this.completed.length ? this.completed.reduce((a, b) => a + b, 0) / this.completed.length : this.forecast; }
  canLaunch() {
    const reserved = [...this.active.values()].reduce((sum, paid) => sum + Math.max(0, this.average - paid), 0);
    return this.spent + reserved + this.average <= this.limit;
  }
  start(index) { this.active.set(index, 0); }
  finish(index, completed) { if (completed) this.completed.push(this.active.get(index) || 0); this.active.delete(index); }
  get exhausted() { return this.spent >= this.limit; }
}

export function unhealthy(results, fighters) {
  if (results.length < 10) return null;
  for (const id of fighters) {
    const last = results.slice(-10).map((r) => r.stats[id]);
    const calls = last.reduce((n, s) => n + s.calls, 0), errors = last.reduce((n, s) => n + s.errors, 0);
    if (calls && errors / calls > 0.5) return `${id}: ${errors}/${calls} errors (>50%) over the last 10 matches`;
  }
  return null;
}

export function historicalForecast(dir, fighters) {
  const costs = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    try {
      const l = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (l.mode !== 'live' || !l.result?.winner || l.status === 'aborted' || l.roster.length !== fighters.length ||
        !fighters.every((id) => l.roster.some((r) => r.id === id))) continue;
      if (l.decisions.some((d) => /budget spent|not set/.test(d.err || ''))) continue;
      const calls = l.calls || l.decisions;
      const cost = calls.reduce((n, d) => n + (d.cost || 0), 0);
      if (cost > 0) costs.push(cost);
    } catch { /* Ignore unrelated or partial JSON files. */ }
  }
  // Conservative bootstrap if there is no usable local history: 60 s at 10 Hz.
  return costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length
    : fighters.reduce((n, id) => n + 600 * estCost(rosterById[id]), 0);
}

export function summary(results, o, guard, reason) {
  const records = results.filter((r) => r.record).map((r) => r.record), rows = aggregate(records);
  const usd = (n) => `$${(n || 0).toFixed(6)}`;
  const lines = ['# AUTO-PLAY', '', `Completed ${records.length}; aborted ${results.length - records.length}. ${reason || 'Requested matches finished.'}`,
    `Assumption: £1 = $${o.usdPerGbp.toFixed(2)}; £${o.budgetGbp} = $${(o.budgetGbp * o.usdPerGbp).toFixed(2)}. Server/process spend ${usd(guard.spent)} / ${usd(guard.limit)}; batch cost ${usd(guard.localCost)} (includes aborted and late calls).`,
    'Costs with ~ include token fallbacks; unknown timeout/error charges may be absent.', '',
    '| Fighter | Wins | Win rate | Avg place | Kills | Damage | Mean latency | Total cost | Cost/match |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const id of o.fighters) {
    const a = rows.find((a) => a.id === id);
    const cost = results.reduce((n, r) => n + r.stats[id].cost, 0), estimated = results.some((r) => r.stats[id].costEst);
    const lat = results.flatMap((r) => r.stats[id].lat);
    lines.push(`| ${id} | ${a?.wins || 0} | ${((a?.winRate || 0) * 100).toFixed(1)}% | ${a?.avgPlace.toFixed(2) ?? '-'} | ${a?.kills || 0} | ${a?.damage || 0} | ${lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) + ' ms' : '-'} | ${estimated ? '~' : ''}${usd(cost)} | ${usd(results.length ? cost / results.length : 0)} |`);
  }
  lines.push('', 'Combat stats cover completed matches; latency/cost cover every attempted match. Cost/match divides by attempts.', '', '| Physical spawn slot (0 = north) | Wins |', '|---|---:|');
  for (let slot = 0; slot < o.fighters.length; slot++) lines.push(`| ${slot} | ${results.filter((r) => r.record && r.log.spawnSlots[r.record.winner] === slot).length} |`);
  if (o.aim === 'on') {
    lines.push('', '| Shooter → target | Choices |', '|---|---:|');
    for (const shooter of o.fighters) for (const target of o.fighters.filter((id) => id !== shooter)) {
      lines.push(`| ${shooter} → ${target} | ${results.reduce((n, r) => n + (r.stats[shooter].targetsChosen[target] || 0), 0)} |`);
    }
  }
  for (const r of results.filter((r) => r.log.status === 'aborted' || r.log.recordError))
    lines.push('', `Seed ${r.log.seed}: ${r.log.abortReason || r.log.recordError}. Log retained${r.log.status === 'aborted' ? '; excluded from leaderboard' : '; leaderboard POST failed'}.`);
  return lines.join('\n') + '\n';
}

export async function runBatch(o, { fetcher = fetch, clock = realClock, runMatch = runLiveMatch,
  logsDir = path.join(ROOT, 'logs'), output = console.log, warn = console.warn, signals = process } = {}) {
  fs.mkdirSync(logsDir, { recursive: true });
  const request = (route, body) => jsonRequest(fetcher, o.server, route, body);
  const status = await request('/api/status');
  if (!status.keyLoaded) throw new Error('proxy has no gateway key');
  if (!status.costBudget) throw new Error('proxy lacks cost budget status: restart it with the updated server.js');
  const guard = new SpendGuard({ limit: o.budgetGbp * o.usdPerGbp, status, forecast: historicalForecast(logsDir, o.fighters) });
  output(`£1 = $${o.usdPerGbp.toFixed(2)} assumed; forecast $${guard.average.toFixed(5)}/match; process spend $${guard.spent.toFixed(5)} / $${guard.limit.toFixed(2)}.`);
  if (status.costBudget.max == null) warn('CALL_BUDGET_USD is unlimited on the proxy; runner uses estimates. Set the server cap for a shared spend guard.');
  output(`Call budget ${status.budget?.used}/${status.budget?.max}; it may stop this batch before the money cap. No warm-up calls.`);
  const results = [], active = new Map();
  let next = 0, reason = status.budget?.used >= status.budget?.max ? 'Proxy call budget already spent.' : null;
  let budgetAbort = null, posts = Promise.resolve(), lastStatus = clock.now(), lastPrint = -Infinity;
  const stop = () => { reason ||= 'Interrupted: no new matches; finishing in-flight matches and logs.'; output(reason); };
  signals.on('SIGINT', stop); signals.on('SIGTERM', stop);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  function launch(index) {
    guard.start(index);
    const roster = rotateRoster(o.fighters, index), seed = o.seedStart + index;
    const task = (async () => {
      const result = await runMatch({ seed, roster, weapons: o.weaponConfig, label: o.label, server: o.server, fetcher, clock,
        shouldAbort: () => budgetAbort || (guard.exhausted ? 'USD budget spent' : null), warn,
        onCall: ({ cost, data, status, err }) => {
          guard.charge(index, cost, data);
          if (status === 429 || /budget spent|not set/.test(err || '')) budgetAbort ||= err || 'HTTP 429 budget/rate limit';
          if (guard.exhausted) budgetAbort ||= 'USD budget spent';
        } });
      guard.finish(index, Boolean(result.record));
      results.push(result);
      const file = path.join(logsDir, `autoplay-match-${stamp}-seed${seed}.json`);
      const save = () => fs.writeFileSync(file, JSON.stringify(result.log));
      save(); // Persist before the leaderboard write, including failed/aborted attempts.
      if (result.record) {
        // Chain POSTs; server writes are synchronous temp-file + rename too.
        const post = posts.then(() => request('/api/leaderboard/record', result.record));
        posts = post.catch(() => {});
        try { await post; result.log.leaderboardRecorded = true; }
        catch (e) { result.log.recordError = e.message; reason ||= 'Leaderboard write failed; stopping new matches.'; warn(`${seed}: leaderboard NOT recorded: ${e.message}`); }
        save();
      } else warn(`seed ${seed} ABORTED: ${result.log.abortReason}; log ${file}`);
      const health = unhealthy(results, o.fighters);
      if (health) { reason ||= health; warn(`STOP: ${health}`); }
      output(`seed ${seed}: ${result.log.status}, winner ${result.record?.winner || '-'}; ${results.length} done; $${guard.spent.toFixed(5)} spent; wins ${JSON.stringify(Object.fromEntries(aggregate(results.filter((r) => r.record).map((r) => r.record)).map((a) => [a.id, a.wins])))}`);
    })().catch((e) => { reason ||= `Batch failure: ${e.message}`; warn(reason); throw e; });
    // Keep rejected tasks handled until the scheduler collects them.
    active.set(index, task.then(() => null, (error) => error));
  }
  let failure = null;
  try {
    while (next < o.matches || active.size) {
      if (clock.now() - lastStatus >= 1000) {
        try {
          const status = await request('/api/status'); guard.observe(status);
          if (guard.exhausted || status.budget?.used >= status.budget?.max) budgetAbort ||= 'proxy budget spent';
        } catch (e) { reason ||= `Status unavailable: ${e.message}; finishing existing matches.`; }
        lastStatus = clock.now();
      }
      if (budgetAbort) reason ||= budgetAbort;
      while (!reason && next < o.matches && active.size < o.parallel && guard.canLaunch()) launch(next++);
      if (!active.size) {
        if (!reason && next < o.matches) reason = 'Spend plus in-flight/next-match forecast would exceed the USD budget.';
        break;
      }
      // Race a short clock interval with completion so status/spend remain visible.
      const done = await Promise.race([...active].map(([i, task]) => task.then((error) => ({ i, error }))).concat(clock.sleep(50).then(() => null)));
      if (done) { active.delete(done.i); if (done.error) failure ||= done.error; }
      if (clock.now() - lastPrint >= 5000) {
        output(`${results.length} done, ${active.size} in flight; $${guard.spent.toFixed(5)} / $${guard.limit.toFixed(2)}`); lastPrint = clock.now();
      }
    }
  } finally { signals.off('SIGINT', stop); signals.off('SIGTERM', stop); }
  const md = summary(results, o, guard, reason);
  const file = path.join(logsDir, `autoplay-${stamp}.md`);
  fs.writeFileSync(file, md); output(md); output(`Summary: ${file}`);
  return { results, guard, reason, file, failed: Boolean(failure || results.some((r) => r.log.recordError)) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await runBatch(parseArgs(process.argv.slice(2))); if (result.failed) process.exitCode = 1; }
  catch (e) { console.error(`autoplay: ${e.message}`); process.exitCode = 1; }
}
