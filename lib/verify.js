// Hosted leaderboard records are built on the server, never taken from the browser. The browser sends
// only its decisions: which answer it applied on which tick, and where its fighters were stunned. The
// server checks them against what it observed for that match token (every call's answer or failure,
// latency and cost, in order), re-runs the deterministic simulation from the seed and weapon config fixed
// at match start, and builds the record from that result. Latency, cost, error and timeout figures come
// only from the server's own observations.
// What the browser still chooses: the tick each answer landed on, and a few dropped answers (an answer
// that arrived after its fighter died, after the match ended, or after the page's own 2 s timeout).
// Removing that last bit of trust would need the simulation to run on the server.
import { ACTIONS } from '../public/shared.js';
import { runLog, MATCH_TICKS } from '../public/sim.js';
import { buildRecord, cleanRecord } from '../public/leaderboard.js';

export const MAX_DECISIONS = 20000;
export const MIN_ANSWERS_PER_FIGHTER = 20;
export const dropAllowance = (answers) => 2 + Math.floor(answers * 0.05);

// Is a (applied actions, in order) a subsequence of b (server answers)?
function subsequence(a, b) {
  let j = 0;
  for (const x of a) { while (j < b.length && b[j] !== x) j++; if (j++ >= b.length) return false; }
  return true;
}

// m: the match record ({seed, roster, weapons}); observed: {fighterId: [{ok, a, ms, c, to}, ...]} as served.
export function recordFromPlay({ m, decisions, observed, ts = new Date().toISOString() }) {
  if (!Array.isArray(decisions) || decisions.length > MAX_DECISIONS) throw new Error('bad decisions');
  const roster = m.roster, inMatch = new Set(roster);
  const aims = Boolean(m.weapons?.modelAims);
  const valid = (f, a) => typeof a === 'string' && (aims
    ? (a !== 'shoot' && ACTIONS.includes(a)) || (a.startsWith('shoot_') && inMatch.has(a.slice(6)) && a.slice(6) !== f)
    : ACTIONS.includes(a));
  const clean = decisions.map((d) => {
    if (!d || typeof d !== 'object' || !Number.isInteger(d.t) || d.t < 0 || d.t > MATCH_TICKS || typeof d.f !== 'string' || !inMatch.has(d.f)) throw new Error('bad decision');
    const err = d.err != null && d.err !== false && d.err !== '';
    if (!err && !valid(d.f, d.a)) throw new Error('bad action');
    return { t: d.t, f: d.f, a: err ? null : d.a, err: err ? 'stunned' : null };
  });
  const stats = {};
  for (const f of roster) {
    const seen = Array.isArray(observed[f]) ? observed[f] : [];
    const answers = seen.filter((x) => x?.ok);
    if (answers.length < MIN_ANSWERS_PER_FIGHTER) throw new Error(`not enough play recorded for ${f}`);
    const mine = clean.filter((d) => d.f === f), applied = mine.filter((d) => !d.err).map((d) => d.a);
    // the simulation applies decisions in tick order, so the list order checked below must be tick order too
    if (mine.some((d, i) => i && d.t < mine[i - 1].t)) throw new Error(`decisions for ${f} are not in tick order`);
    if (!subsequence(applied, answers.map((x) => x.a))) throw new Error(`decisions for ${f} differ from the answers the server returned`);
    const dropped = answers.length - applied.length, failures = seen.length - answers.length, stuns = mine.length - applied.length;
    if (dropped > dropAllowance(answers.length)) throw new Error(`too many answers dropped for ${f}`);
    if (stuns > failures + dropped) throw new Error(`more stuns for ${f} than failed or dropped calls`);
    stats[f] = { lat: answers.map((x) => Math.min(1e5, Math.max(0, Number(x.ms) || 0))), decisions: mine.length, calls: seen.length,
      errors: failures, timeouts: seen.filter((x) => !x.ok && x.to).length,
      cost: seen.reduce((n, x) => n + Math.max(0, Number(x.c) || 0), 0), costEst: false, targetsChosen: {} };
    if (aims) for (const a of applied) if (a.startsWith('shoot_')) stats[f].targetsChosen[a.slice(6)] = (stats[f].targetsChosen[a.slice(6)] || 0) + 1;
  }
  const state = runLog({ version: 1, seed: m.seed, modelAims: aims, roster: roster.map((id) => ({ id })), weapons: m.weapons, decisions: clean });
  return { state, record: cleanRecord(buildRecord({ state, mode: 'live', weapons: m.weapons, stats, ts })) };
}
