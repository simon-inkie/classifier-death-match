import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayCursor, hashState } from '../public/sim.js';
import { runHeadlessMock } from '../public/brain.js';
import { DecisionHistory, Seeker, statsAt } from '../public/history.js';

const { log } = runHeadlessMock({ seed: 25 }); // a match that outlasts tick 1000

// The hash of a plain full run, stopped as soon as it reaches `tick`.
function fullRunHash(tick) {
  const c = new ReplayCursor(log);
  while (c.state.tick < tick && !c.state.over) c.tick();
  return hashState(c.state);
}

test('history keeps every decision per fighter, finds the one at a tick, and resets', () => {
  const h = new DecisionHistory(log.roster.map((r) => r.id));
  for (const d of log.decisions) h.add(d);
  assert.equal(h.size(), log.decisions.length);
  const id = log.roster[0].id, list = h.list(id);
  assert.ok(list.length > 10);
  assert.ok(list.every((d, i) => d.f === id && (i === 0 || list[i - 1].t <= d.t)));
  const mid = list[5];
  assert.equal(h.indexAt(id, mid.t), list.lastIndexOf(list.filter((d) => d.t <= mid.t).at(-1)));
  assert.equal(h.indexAt(id, -1), -1);
  assert.equal(h.step(id, 0, -1), 0);
  assert.equal(h.step(id, list.length - 1, 1), list.length - 1);
  assert.equal(h.step(id, 3, 1), 4);
  h.reset([id]);
  assert.equal(h.size(), 0);
});

test('seeking to a tick gives the same state as a full run to that tick (with and without snapshots)', () => {
  const seeker = new Seeker(log, { every: 100 });
  for (const tick of [0, 1, 99, 100, 101, 640, 1500, 300, 2000]) {
    assert.equal(hashState(seeker.stateAt(tick)), fullRunHash(tick), `tick ${tick}`);
  }
  assert.ok(seeker.snaps.size > 3, 'snapshots were cached');
  // a fresh seeker with no cache agrees with the cached one
  assert.equal(hashState(new Seeker(log).stateAt(1234)), hashState(seeker.stateAt(1234)));
});

test('viewing never mutates the live state or the log, and snapshots stay below the live tick', () => {
  const live = new ReplayCursor(log);
  while (live.state.tick < 900) live.tick();
  const before = hashState(live.state), logBefore = JSON.stringify(log.decisions);
  const seeker = new Seeker(log, { every: 100 });
  const past = seeker.stateAt(500, live.state.tick);
  past.fighters[0].hp = -999; // scribbling on the returned copy must not leak anywhere
  assert.equal(hashState(live.state), before);
  assert.equal(JSON.stringify(log.decisions), logBefore);
  assert.equal(hashState(seeker.stateAt(500, live.state.tick)), fullRunHash(500), 'cache not poisoned');
  seeker.stateAt(900, 900);
  assert.ok([...seeker.snaps.keys()].every((t) => t < 900));
  // the live match carries on exactly as a never-viewed one
  const control = new ReplayCursor(log);
  while (control.state.tick < 900) control.tick();
  for (let i = 0; i < 100; i++) { live.tick(); control.tick(); }
  assert.equal(hashState(live.state), hashState(control.state));
});

test('statsAt reads latency, errors and cost as of a tick', () => {
  const list = [{ t: 0, ms: 100, cost: 0.1 }, { t: 30, ms: 300, cost: 0.2, costEst: true }, { t: 60, err: 'x', ms: 2000 }, { t: 90, ms: 500, cost: 1 }];
  const s = statsAt(list, 60);
  assert.equal(s.decisions, 3);
  assert.equal(s.errors, 1);
  assert.equal(s.medianMs, 200);
  assert.equal(s.lastMs, 2000);
  assert.ok(s.costEst && Math.abs(s.cost - 0.3) < 1e-9);
  assert.equal(statsAt(list, 10).decisions, 1);
});
