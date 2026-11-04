// All-time leaderboard: build one record per finished match, clean records the server receives,
// and aggregate records into per-fighter standings. Pure, shared by the page, the proxy and the tests.
import { TICK_HZ, MATCH_TICKS } from './sim.js';
import { ROSTER } from './shared.js';
import { configId, configSummary, normaliseWeapons } from './weapons.js';

const r1 = (x) => Math.round(x * 10) / 10;
const KNOWN = new Set(ROSTER.map((r) => r.id));
const BOTS = new Set(ROSTER.filter((r) => r.kind === 'bot').map((r) => r.id)); // local, no cost
export const MAX_RECORDS = 5000;

// Places with ties: fighters level on (alive, hp, time of death) share a place (1, 1, 3).
// The sim's ranking still breaks the tie (kills, then roster order), so there is always one winner.
export function placesFor(state) {
  const key = (f) => `${f.alive}|${Math.max(0, f.hp)}|${f.deathTick ?? 'x'}`;
  const places = {};
  let prev = null;
  state.ranking.forEach((id, i) => {
    const f = state.fighters.find((x) => x.id === id);
    places[id] = prev && key(prev.f) === key(f) ? prev.place : i + 1;
    prev = { f, place: places[id] };
  });
  return places;
}

export function winNote(state, places) {
  const alive = state.fighters.filter((f) => f.alive).length;
  const tie = state.ranking.length > 1 && places[state.ranking[1]] === 1;
  if (alive === 1) return 'last standing';
  if (alive === 0) return tie ? 'all down, draw (tie-break)' : 'all down, last to fall';
  return tie ? 'time up, level on HP (tie-break)' : 'time up, most HP';
}

// What the end-of-match celebration says. allDown: nobody survived, so there is no celebration,
// just "ALL DOWN" over the stats. A time-up tie between survivors (level on HP) is decided by the
// sim's ranking: more kills, then roster order.
export function celebrationText(state) {
  const places = placesFor(state);
  const alive = state.fighters.filter((f) => f.alive).length;
  const tie = state.ranking.length > 1 && places[state.ranking[1]] === 1;
  if (alive === 0) return { allDown: true, line: winNote(state, places), tieBreak: null };
  if (alive === 1) return { allDown: false, line: 'Last one standing', tieBreak: null };
  return tie ? { allDown: false, line: 'Level on health when time ran out', tieBreak: 'Won on tie-break: more kills, then roster order' }
    : { allDown: false, line: 'Most health when time ran out', tieBreak: null };
}

// stats: per fighter id { lat: [ms...], errors (all, timeouts included), timeouts, decisions, calls, cost, costEst }.
// cost is USD for the match (null for the bot, or when the page gave none); costEst: any of it estimated.
// The record keeps errors and timeouts apart: errors there excludes timeouts.
export function buildRecord({ state, mode, weapons, stats, ts = new Date().toISOString() }) {
  const cfg = normaliseWeapons(weapons);
  const places = placesFor(state);
  const fighters = state.ranking.map((id) => {
    const f = state.fighters.find((x) => x.id === id), s = stats[id] || {};
    const lat = s.lat || [];
    return { id, place: places[id], alive: f.alive, hp: Math.max(0, f.hp),
      survivalS: r1((f.deathTick ?? state.tick) / TICK_HZ), kills: f.kills, damage: f.dealt || 0,
      meanMs: lat.length ? Math.round(lat.reduce((a, b) => a + b, 0) / lat.length) : null, latN: lat.length,
      decisions: s.decisions || 0, errors: Math.max(0, (s.errors || 0) - (s.timeouts || 0)), timeouts: s.timeouts || 0,
      cost: BOTS.has(id) || s.cost == null ? null : s.cost, calls: s.calls ?? s.decisions ?? 0, costEst: Boolean(s.costEst), ...(cfg.modelAims ? { targetsChosen: { ...(s.targetsChosen || {}) } } : {}) };
  });
  return { ts, mode, modelAims: Boolean(cfg.modelAims), seed: state.seed, ticks: state.tick, timeUp: state.tick >= MATCH_TICKS,
    winner: state.winner, note: winNote(state, places), tie: state.ranking.length > 1 && places[state.ranking[1]] === 1,
    cfgId: configId(cfg), cfgSummary: configSummary(cfg), fighters };
}

// Server side: accept only well-formed records, with numbers clamped and strings cut short.
const num = (v, min, max, d = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const str = (v, n) => String(v ?? '').slice(0, n);
// Free text in a record is shown on the leaderboard page: keep it to plain characters (no markup), so a
// hostile record cannot carry HTML even if a renderer forgets to escape.
const plain = (v, n) => str(v, n).replace(/[^\w .,;:()+\-\/=%~]/g, '');
export function cleanRecord(r) {
  if (!r || typeof r !== 'object') throw new Error('no record');
  if (r.mode !== 'live' && r.mode !== 'mock') throw new Error('mode must be live or mock');
  if (!Array.isArray(r.fighters) || r.fighters.length < 2 || r.fighters.length > 6) throw new Error('need 2 to 6 fighters');
  const fighters = r.fighters.map((f) => {
    if (!KNOWN.has(f?.id)) throw new Error(`unknown fighter ${str(f?.id, 20)}`);
    return { id: f.id, place: num(f.place, 1, 6, 6) | 0, alive: Boolean(f.alive), hp: num(f.hp, 0, 100) | 0,
      survivalS: r1(num(f.survivalS, 0, 600)), kills: num(f.kills, 0, 99) | 0, damage: num(f.damage, 0, 1e5) | 0,
      meanMs: f.meanMs == null ? null : Math.round(num(f.meanMs, 0, 1e5)), latN: num(f.latN, 0, 1e5) | 0,
      decisions: num(f.decisions, 0, 1e5) | 0, errors: num(f.errors, 0, 1e5) | 0, timeouts: num(f.timeouts, 0, 1e5) | 0,
      cost: f.cost == null || BOTS.has(f.id) || !Number.isFinite(Number(f.cost)) ? null : num(f.cost, 0, 100),
      calls: num(f.calls, 0, 1e5) | 0, costEst: Boolean(f.costEst),
      ...(r.modelAims === true ? { targetsChosen: Object.fromEntries(Object.entries(f.targetsChosen || {}).filter(([id]) => KNOWN.has(id) && id !== f.id).map(([id, n]) => [id, num(n, 0, 1e5) | 0])) } : {}) };
  });
  if (new Set(fighters.map((f) => f.id)).size !== fighters.length) throw new Error('duplicate fighter');
  if (!fighters.some((f) => f.id === r.winner)) throw new Error('winner not in the match');
  const ts = Number.isFinite(Date.parse(r.ts)) ? new Date(r.ts).toISOString() : new Date().toISOString();
  return { ts, modelAims: r.modelAims === true, mode: r.mode, seed: num(r.seed, -1e9, 1e9) | 0, ticks: num(r.ticks, 0, 1e6) | 0, timeUp: Boolean(r.timeUp),
    winner: r.winner, note: plain(r.note, 300), tie: Boolean(r.tie), cfgId: str(r.cfgId, 16).replace(/[^0-9a-f]/g, ''),
    cfgSummary: plain(r.cfgSummary, 400), fighters };
}

// Records to standings. Live only unless includeMock; optionally one config only.
export function filterRecords(records, { includeMock = false, cfgId = null } = {}) {
  return records.filter((r) => (r.mode === 'live' || (includeMock && r.mode === 'mock')) && (!cfgId || r.cfgId === cfgId));
}
export function aggregate(records, opts = {}) {
  const rows = {};
  for (const m of filterRecords(records, opts)) {
    for (const f of m.fighters) {
      const a = (rows[f.id] ||= { id: f.id, played: 0, wins: 0, placeSum: 0, survSum: 0, kills: 0, damage: 0,
        latSum: 0, latN: 0, errors: 0, timeouts: 0, costSum: 0, costGames: 0, costCalls: 0, costEst: false });
      a.played++;
      if (m.winner === f.id) a.wins++;
      a.placeSum += f.place; a.survSum += f.survivalS; a.kills += f.kills; a.damage += f.damage;
      if (f.meanMs != null && f.latN > 0) { a.latSum += f.meanMs * f.latN; a.latN += f.latN; }
      a.errors += f.errors; a.timeouts += f.timeouts;
      // older records carry no cost: left out of the cost totals and averages
      if (f.cost != null) { a.costSum += f.cost; a.costGames++; a.costCalls += f.calls || 0; if (f.costEst) a.costEst = true; }
    }
  }
  return Object.values(rows).map((a) => ({ id: a.id, played: a.played, wins: a.wins, winRate: a.wins / a.played,
    avgPlace: a.placeSum / a.played, avgSurvivalS: a.survSum / a.played, kills: a.kills, damage: a.damage,
    meanMs: a.latN ? a.latSum / a.latN : null, errors: a.errors, timeouts: a.timeouts,
    totalCost: a.costGames ? a.costSum : null, avgCostGame: a.costGames ? a.costSum / a.costGames : null,
    costPerCall: a.costCalls ? a.costSum / a.costCalls : null, costGames: a.costGames, costCalls: a.costCalls, costEst: a.costEst }))
    .sort((x, y) => (y.wins - x.wins) || (x.avgPlace - y.avgPlace) || (y.played - x.played) || x.id.localeCompare(y.id));
}

// Click-to-sort for the standings table. key is a column key; dir 1 = descending, -1 = ascending.
// Null values (no latency yet) always sink to the bottom. Ties fall back to the default order.
export const SORT_KEYS = ['played', 'wins', 'winRate', 'avgPlace', 'avgSurvivalS', 'kills', 'damage', 'meanMs', 'errors', 'timeouts', 'totalCost', 'avgCostGame', 'costPerCall'];
export function sortStandings(rows, key = null, dir = 1) {
  if (!SORT_KEYS.includes(key)) return rows;
  return rows.map((r, i) => [r, i]).sort(([x, i], [y, j]) => {
    if ((x[key] == null) !== (y[key] == null)) return x[key] == null ? 1 : -1;
    return ((y[key] ?? 0) - (x[key] ?? 0)) * dir || (i - j);
  }).map(([r]) => r);
}
// Ids of the fighter(s) with the highest total kills (none if nobody has a kill).
export function mostKillsIds(rows) {
  const max = Math.max(0, ...rows.map((r) => r.kills));
  return max > 0 ? rows.filter((r) => r.kills === max).map((r) => r.id) : [];
}
