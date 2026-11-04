// First-run setup modal decisions (public/setup.js): when it shows, the first mode, and when Live is
// offered. The DOM wiring is checked by hand; this covers the logic that decides what a new player sees.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SKIP_KEY, showSetupOnLoad, initialMode, liveAvailability, settleMode } from '../public/setup.js';

const P = (q = '') => new URLSearchParams(q);
const store = (v = {}) => ({ get: (k, d) => (k in v ? v[k] : d), set: (k, x) => { v[k] = x; } });

test('setup modal: shows until "do not show again", and the URL can force or hide it', () => {
  assert.equal(showSetupOnLoad(P(), store()), true);
  assert.equal(showSetupOnLoad(P(), store({ [SKIP_KEY]: true })), false);
  assert.equal(showSetupOnLoad(P('splash=1'), store({ [SKIP_KEY]: true })), true);
  assert.equal(showSetupOnLoad(P('nosplash=1'), store()), false);
  const broken = { get: (k, d) => d, set: () => {} }; // storage unavailable: the store falls back to defaults
  assert.equal(showSetupOnLoad(P(), broken), true);
});

test('setup modal: Live by default, falling back to Mock only when Live cannot run and was not asked for', () => {
  assert.deepEqual(initialMode(P()), { mode: 'live', explicit: false });
  assert.deepEqual(initialMode(P('mode=mock')), { mode: 'mock', explicit: true });
  assert.deepEqual(initialMode(P('mode=nonsense')), { mode: 'live', explicit: false });
  const ok = { keyLoaded: true, spend: { exhausted: false } };
  assert.equal(settleMode(initialMode(P()), ok), 'live');
  assert.equal(settleMode(initialMode(P()), { keyLoaded: false }), 'mock', 'no key: Mock, which needs none');
  assert.equal(settleMode(initialMode(P()), null), 'mock', 'server down');
  assert.equal(settleMode(initialMode(P()), { hosted: true, keyLoaded: true, spend: { exhausted: true } }), 'mock', 'day spent');
  assert.equal(settleMode(initialMode(P('mode=live')), { keyLoaded: false }), 'live', 'an explicit ?mode=live is kept');
});

test('setup modal: Live is offered with a friendly note when it is unavailable or busy', () => {
  assert.deepEqual(liveAvailability({ keyLoaded: true }), { ok: true, note: '' });
  assert.equal(liveAvailability({ keyLoaded: false }).ok, false);
  assert.match(liveAvailability({ keyLoaded: false }).note, /AI_GATEWAY_API_KEY/);
  assert.doesNotMatch(liveAvailability({ hosted: true, keyLoaded: false }).note, /AI_GATEWAY_API_KEY/, 'no setup hints on the hosted site');
  assert.match(liveAvailability({ hosted: true, keyLoaded: true, spend: { exhausted: true } }).note, /tomorrow/);
  const busy = liveAvailability({ hosted: true, keyLoaded: true, spend: { busy: true } });
  assert.equal(busy.ok, true); assert.match(busy.note, /busy/);
});
