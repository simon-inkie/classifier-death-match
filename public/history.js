// Decision history and rewind for the history scrub. Pure (no DOM), so Node can test it.
//   DecisionHistory: every decision of the match, per fighter, in the order they were recorded.
//   Seeker: rebuilds the arena as it was at any past tick from the seed and the recorded actions.
//   statsAt: the per-fighter readout (latency, errors, cost) as it stood at a given tick.
import { ReplayCursor } from './sim.js';
import { median } from './shared.js';

export const DOM_ROW_CAP = 2000; // rows kept in a fighter's log list; the full history array is never trimmed

export class DecisionHistory {
  constructor(ids = []) { this.reset(ids); }
  reset(ids = []) { this.by = Object.fromEntries(ids.map((id) => [id, []])); }
  // Returns the index of the new entry in that fighter's list.
  add(d) { const l = (this.by[d.f] ||= []); l.push(d); return l.length - 1; }
  list(id) { return this.by[id] || []; }
  get(id, idx) { return this.list(id)[idx] ?? null; }
  size() { return Object.values(this.by).reduce((n, l) => n + l.length, 0); }
  // Index of the newest decision made at or before `tick`, or -1.
  indexAt(id, tick) {
    const l = this.list(id);
    let lo = 0, hi = l.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (l[m].t <= tick) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  // Previous (dir -1) or next (dir +1) entry index, clamped to the list; -1 when the list is empty.
  step(id, idx, dir) {
    const n = this.list(id).length;
    if (!n) return -1;
    return Math.max(0, Math.min(n - 1, idx + dir));
  }
}

// Readout as of `tick`, from the decisions made up to and including it.
export function statsAt(list, tick) {
  let errors = 0, cost = 0, costEst = false, lastMs = null, decisions = 0, recent = 0;
  const lat = [];
  for (const d of list) {
    if (d.t > tick) break;
    decisions++;
    if (d.err) errors++; else if (d.ms != null) lat.push(d.ms);
    if (d.cost) cost += d.cost;
    if (d.costEst) costEst = true;
    lastMs = d.ms;
    if (d.t > tick - 90) recent++;
  }
  return { decisions, errors, cost, costEst, lastMs, medianMs: median(lat), dps: recent / Math.min(3, Math.max(tick, 1) / 30) };
}

// Re-simulates a match from its log (seed, roster, weapon config, decisions) up to a tick. The log is
// only read: every call builds its own fresh state, so the live match is never touched. A snapshot is
// kept every `every` ticks so a scrub does not replay from tick 0 each time. Snapshots are only taken
// strictly before `liveTick`, because a decision can still be added at the live tick itself.
export class Seeker {
  constructor(log, { every = 150 } = {}) { this.log = log; this.every = every; this.snaps = new Map(); }
  stateAt(tick, liveTick = Infinity) {
    const c = new ReplayCursor(this.log);
    let best = 0;
    for (const t of this.snaps.keys()) if (t <= tick && t > best) best = t;
    if (best > 0) { const s = this.snaps.get(best); c.state = structuredClone(s.state); c.next = s.next; }
    while (c.state.tick < tick && !c.state.over) {
      c.tick();
      const t = c.state.tick;
      if (t % this.every === 0 && t < liveTick && !this.snaps.has(t)) this.snaps.set(t, { state: structuredClone(c.state), next: c.next });
    }
    return c.state;
  }
}
