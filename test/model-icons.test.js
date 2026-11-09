import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPRITES } from '../public/sprites.js';
import { iconIdForModel, fighterIdentity, recordFighterIdentity, companyForModel } from '../public/model-icons.js';
import { rosterById } from '../public/shared.js';

test('model icons use company sprites and the existing Google and OpenAI marks', () => {
  SPRITES['test-company'] = SPRITES.bot;
  try {
    assert.equal(iconIdForModel('test-company/model-one'), 'test-company');
    assert.equal(iconIdForModel('test-company/model-two'), 'test-company');
    assert.equal(iconIdForModel('google/gemini-test'), 'google');
    assert.equal(SPRITES.google, SPRITES.gemini);
    assert.equal(iconIdForModel('openai/gpt-test'), 'openai');
    assert.equal(SPRITES.openai, SPRITES.luna);
  } finally { delete SPRITES['test-company']; }
});

test('unknown companies get a reusable, deterministic 16px initial disc', () => {
  const id = iconIdForModel('acme-unlisted/model-one');
  const sprite = SPRITES[id];
  assert.equal(id, 'initial:acme-unlisted');
  assert.equal(iconIdForModel('acme-unlisted/model-two'), id);
  assert.equal(SPRITES[id], sprite);
  assert.equal(sprite.rows.length, 16);
  assert.ok(sprite.rows.every((r) => r.length === 16));
  assert.equal(sprite.rows[0][0], '.');
  assert.equal(sprite.rows[7].slice(5, 11), 'WWWWWW', 'the crossbar of the A');
  assert.equal(sprite.rows[3].slice(5, 11), 'BBWWBB', 'the top of the A');
  delete SPRITES[id];
  iconIdForModel('acme-unlisted/another-model');
  assert.deepEqual(SPRITES[id], sprite);
});

test('an override names the actual model with its company icon; default fighters keep their identities', () => {
  const identity = fighterIdentity(rosterById.gemini, 'anthropic/claude-sonnet-5.5');
  assert.equal(identity.name, 'claude-sonnet-5.5');
  assert.equal(identity.iconId, iconIdForModel('anthropic/claude-sonnet-5.5'));
  assert.notEqual(identity.iconId, 'gemini');
  assert.deepEqual(fighterIdentity(rosterById.gemini), { name: 'gemini-2.5-flash-lite', iconId: iconIdForModel('google/gemini-2.5-flash-lite') }, 'Gemini is named from its model id like any other model');
});


test('malformed replay model IDs fall back to the slot identity without throwing', () => {
  for (const model of [null, '', 42, {}, [], true, 'bad', 'google/', '/model', 'a/b/c']) {
    for (const id of ['gemini', 'gw1']) {
      const expected = id === 'gemini' ? fighterIdentity(rosterById.gemini) : { name: rosterById[id].name, iconId: id };
      assert.deepEqual(fighterIdentity(rosterById[id], model), expected);
      assert.deepEqual(recordFighterIdentity({ id, model }), expected);
    }
    assert.deepEqual(recordFighterIdentity({ id: 'old-slot', model }), { name: 'old-slot', iconId: 'bot' });
    assert.equal(companyForModel(model), 'unknown');
    assert.ok(SPRITES[iconIdForModel(model)]);
  }
});

test('prototype-named providers use initial sprites and plain company names', () => {
  for (const provider of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
    const model = `${provider}/model`;
    const slug = provider.toLowerCase();
    const valid = provider !== '__proto__';
    assert.equal(companyForModel(model), valid ? slug : 'unknown');
    const icon = iconIdForModel(model);
    assert.equal(icon, `initial:${valid ? slug : 'unknown'}`);
    assert.ok(SPRITES[icon].rows);
    assert.equal(Object.hasOwn(SPRITES, provider), false);
  }
});
