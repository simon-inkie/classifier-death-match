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

import { buildRequest } from '../adapters.js';
import { resolveFighter, parseCatalogue } from '../lib/models.js';
import { worstCallUsd, callBound, PICKED_MAX_TOKENS } from '../lib/spend.js';
import { hasSlowModel } from '../public/settings.js';

test('empty content with finish_reason length is reported as an output-limit failure, not a bare unusable', async () => {
  const body = JSON.stringify({ choices: [{ message: { content: '' }, finish_reason: 'length' }], usage: { completion_tokens: 60 } });
  const out = await callGateway(fighter, scene, undefined, { key: 'stub', fetch: async () => ({ ok: true, status: 200, text: async () => body }) });
  assert.equal(out.ok, false);
  assert.match(out.error, /empty answer.*output limit/);
  assert.match(out.error, /finish_reason length/);
  assert.doesNotMatch(out.error, /unusable/);
});

test('picked chat models get 400 max_tokens and the bound follows it; roster Gemini stays at 60', () => {
  const cat = parseCatalogue({ data: [{ id: 'acme/think', name: 'Think', type: 'language', pricing: { input: '0.0000001', output: '0.0000004' } }] });
  const r = resolveFighter('gw1', 'acme/think', { enabled: true, models: cat });
  assert.equal(r.ok, true);
  assert.equal(buildRequest(r.fighter, scene).body.max_tokens, PICKED_MAX_TOKENS);
  assert.equal(PICKED_MAX_TOKENS, 400);
  const p = r.fighter.price;
  assert.ok(Math.abs(worstCallUsd(r.fighter) - (5200 * p.in + 400 * p.out)) < 1e-15);
  assert.ok(Math.abs(callBound(r.fighter, true) - 3 * worstCallUsd(r.fighter)) < 1e-15);
  assert.equal(buildRequest(rosterById.gemini, scene).body.max_tokens, 60);
  assert.equal(worstCallUsd(rosterById.gemini), 5200 * rosterById.gemini.price.in + 60 * rosterById.gemini.price.out);
});

test('timeout hint applies to full LLMs only', () => {
  const row = (slot, o = {}) => ({ slot, gateway: false, bot: false, ...o });
  assert.equal(hasSlowModel([row('jev'), row('luna'), row('laya'), row('scaledown'), row('bot', { bot: true })]), false);
  assert.equal(hasSlowModel([row('jev'), row('gw1', { gateway: true })]), true);
  assert.equal(hasSlowModel([row('jev'), row('gemini')]), true);
});
