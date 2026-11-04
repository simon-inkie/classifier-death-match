// Hosted leaderboard records are built on the server, never taken from the browser. The browser sends
// only its decisions (which answer it applied on which tick, and its own latency and errors); the server
// checks each fighter's applied answers against the answers it actually returned for that match token,
// in order, then re-runs the deterministic simulation from the seed and weapon config fixed at match
// start, and builds the record (winner, places, kills, note, config summary) from that result.
// What the browser still chooses: the tick each answer landed on, and which answers it dropped as
// timeouts. Removing that last bit of trust would need the simulation to run on the server.
import { ACTIONS } from '../public/shared.js';
import { runLog, MATCH_TICKS } from '../public/sim.js';
import { buildRecord, cleanRecord } from '../public/leaderboard.js';

export const MAX_DECISIONS = 20000;
export const MIN_ANSWERS_PER_FIGHTER = 20;

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);

// Is a a subsequence of b?
function subsequence(a, b) {
  let j = 0;
  for (const x of a) { while (j < b.length && b[j] !== x) j++; if (j++ >= b.length) return false; }
  return true;
}

// m: the match record ({seed, roster, weapons}); serverActions: {fighterId: [action, ...]} as returned.
export function recordFromPlay({ m, decisions, serverActions, ts = new Date().toISOString() }) {
  if (!Array.isArray(decisions) || decisions.length > MAX_DECISIONS) throw new Error('bad decisions');
  const roster = m.roster, inMatch = new Set(roster);
  const aims = Boolean(m.weapons?.modelAims);
  const valid = (f, a) => typeof a === 'string' && (aims
    ? (a !== 'shoot' && ACTIONS.includes(a)) || (a.startsWith('shoot_') && inMatch.has(a.slice(6)) && a.slice(6) !== f)
    : ACTIONS.includes(a));
  const clean = decisions.map((d) => {
    if (!d || typeof d !== 'object' || !Number.isInteger(d.t) || d.t < 0 || d.t > MATCH_TICKS || typeof d.f !== 'string' || !inMatch.has(d.f)) throw new Error('bad decision');
    const err = d.err == null || d.err === false ? null : String(d.err).slice(0, 40).replace(/[^\w .:-]/g, '');
    if (!err && !valid(d.f, d.a)) throw new Error('bad action');
    return { t: d.t, f: d.f, a: err ? null : d.a, ms: num(d.ms, 0, 1e5), err: err || null, cost: num(d.cost, 0, 1) || 0, ...(d.costEst === true ? { costEst: true } : {}) };
  });
  for (const f of roster) {
    const answers = serverActions[f] || [];
    if (answers.length < MIN_ANSWERS_PER_FIGHTER) throw new Error(`not enough play recorded for ${f}`);
    const applied = clean.filter((d) => d.f === f && !d.err).map((d) => d.a);
    if (!subsequence(applied, answers)) throw new Error(`decisions for ${f} differ from the answers the server returned`);
  }
  const state = runLog({ version: 1, seed: m.seed, modelAims: aims, roster: roster.map((id) => ({ id })), weapons: m.weapons, decisions: clean });
  const stats = Object.fromEntries(roster.map((id) => [id, { lat: [], errors: 0, timeouts: 0, decisions: 0, calls: 0, cost: 0, costEst: false, targetsChosen: {} }]));
  for (const d of clean) {
    const s = stats[d.f];
    s.calls++; s.decisions++;
    if (aims && !d.err && d.a.startsWith('shoot_')) s.targetsChosen[d.a.slice(6)] = (s.targetsChosen[d.a.slice(6)] || 0) + 1;
    if (d.err) { s.errors++; if (/timeout/i.test(d.err)) s.timeouts++; } else if (d.ms != null) s.lat.push(d.ms);
    s.cost += d.cost; if (d.costEst) s.costEst = true;
  }
  return { state, record: cleanRecord(buildRecord({ state, mode: 'live', weapons: m.weapons, stats, ts })) };
}
