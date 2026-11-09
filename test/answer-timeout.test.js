import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampAnswerTimeout, answerTimeoutMs } from '../public/answer-timeout.js';
import { normaliseWeapons, DEFAULT_WEAPON_CONFIG, configId } from '../public/weapons.js';
import { runHeadlessMock } from '../public/brain.js';

test('answer timeout clamps to 1..10 with a two-second fallback', () => {
  for (const value of [undefined, null, '', ' ', 'bad', NaN, Infinity, {}, [], true]) assert.equal(clampAnswerTimeout(value), 2);
  for (const [value, expected] of [[-100, 1], [0, 1], [1, 1], ['5', 5], [10, 10], [999, 10]]) {
    assert.equal(clampAnswerTimeout(value), expected);
    const cfg = normaliseWeapons({ ...DEFAULT_WEAPON_CONFIG, answerTimeoutSeconds: value });
    assert.equal(answerTimeoutMs(cfg), expected * 1000);
  }
  assert.deepEqual(normaliseWeapons({ ...DEFAULT_WEAPON_CONFIG, answerTimeoutSeconds: 2 }), DEFAULT_WEAPON_CONFIG);
  assert.notEqual(configId(normaliseWeapons({ ...DEFAULT_WEAPON_CONFIG, answerTimeoutSeconds: 5 })), configId(DEFAULT_WEAPON_CONFIG));
});

test('the default preserves existing deterministic mock logs byte for byte', () => {
  for (const [seed, hash, decisions, bytes] of [[1, '7ac48c57', 304, 102320], [7, '3eb221a7', 204, 68347], [42, 'e0c8807c', 282, 95832]]) {
    const { log } = runHeadlessMock({ seed, weapons: { ...DEFAULT_WEAPON_CONFIG, answerTimeoutSeconds: 2 } });
    delete log.createdAt;
    assert.equal(log.result.hash, hash); assert.equal(log.decisions.length, decisions);
    assert.equal(JSON.stringify(log).length, bytes);
  }
});
