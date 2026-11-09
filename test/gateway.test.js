import { test } from 'node:test';
import assert from 'node:assert/strict';
import { callGateway } from '../lib/gateway.js';
import { rosterById } from '../public/shared.js';
import { createMatch, sceneFor } from '../public/sim.js';

const fighter = { ...rosterById.gw1, model: 'meta/muse-spark' };
const scene = sceneFor(createMatch({ seed: 1, roster: ['gw1', 'jev'] }), 'gw1');
for (const [body, shape] of [['', 'empty response'], ['   ', 'empty response'], ['<html>bad gateway</html>', 'non-JSON response'], [JSON.stringify({ choices: [{ message: { content: '' } }] }), 'unusable answer']]) {
  test(`gateway ${shape} returns a contextual error without throwing`, async () => {
    const logs = [];
    const out = await callGateway(fighter, scene, undefined, { key: 'stub', log: (s) => logs.push(s),
      fetch: async () => ({ ok: true, status: 200, text: async () => body }) });
    assert.equal(out.ok, false);
    assert.equal(out.status, 502);
    assert.equal(out.billed, 'unknown');
    assert.match(out.error, new RegExp(shape));
    assert.match(out.error, /HTTP 200/);
    assert.match(out.error, /meta\/muse-spark/);
    assert.ok(logs[0].includes('meta/muse-spark'));
  });
}

import fs from 'node:fs';
import vm from 'node:vm';
import { applyAction } from '../public/sim.js';

test('gateway errors pass through the browser queue as stunned decisions with no answer object', () => {
  const game = fs.readFileSync(new URL('../public/game.js', import.meta.url), 'utf8');
  const drain = game.slice(game.indexOf('function drainQueue()'), game.indexOf('function replayPendingFrac'));
  const match = createMatch({ seed: 1, roster: ['gw1', 'jev'] });
  const log = { decisions: [] }, recorded = [];
  const err = 'gateway empty response (HTTP 200, model meta/muse-spark)';
  const queue = [{ id: 'gw1', ans: null, err, ms: 600 }];
  vm.runInNewContext(`${drain}; drainQueue();`, { match, log, queue, applyAction, recordDecision: (d) => recorded.push(d) });
  assert.equal(queue.length, 0);
  assert.ok(match.fighters.find((f) => f.id === 'gw1').stunned);
  assert.equal(log.decisions[0].a, null);
  assert.equal(log.decisions[0].err, err);
  assert.equal(recorded.length, 1);
});
