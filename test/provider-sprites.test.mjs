import test from 'node:test';
import assert from 'node:assert/strict';
import { SPRITES } from '../public/sprites.js';

const providers = [
  'anthropic', 'meta', 'mistral', 'alibaba', 'deepseek',
  'zai', 'moonshotai', 'minimax', 'nvidia', 'amazon',
];

for (const provider of providers) {
  test(`${provider} sprite has a valid 16x16 grid and palette`, () => {
    const sprite = SPRITES[provider];
    assert.ok(sprite, `Missing sprite: ${provider}`);
    assert.equal(sprite.rows.length, 16);
    for (const [y, row] of sprite.rows.entries()) {
      assert.equal(row.length, 16, `${provider} row ${y}`);
      for (const pixel of row) {
        assert.ok(pixel === '.' || Object.hasOwn(sprite.palette, pixel),
          `${provider} row ${y}: missing palette colour ${pixel}`);
      }
    }
  });
}
