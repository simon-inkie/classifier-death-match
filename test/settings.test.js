// Settings modal (public/settings.js): the tab and focus-trap key logic, and the markup contract that
// the header holds no settings and every control the page wires up still exists, now in the modal.
// The DOM behaviour itself is checked by hand in a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tabKeyIndex, trapIndex } from '../public/settings.js';

const html = fs.readFileSync(path.resolve(import.meta.dirname, '../public/index.html'), 'utf8');
const section = (open, close) => html.slice(html.indexOf(open), html.indexOf(close, html.indexOf(open)));

test('settings tabs: arrows wrap, Home and End jump, other keys do nothing', () => {
  assert.equal(tabKeyIndex('ArrowRight', 0, 3), 1);
  assert.equal(tabKeyIndex('ArrowRight', 2, 3), 0);
  assert.equal(tabKeyIndex('ArrowLeft', 0, 3), 2);
  assert.equal(tabKeyIndex('Home', 2, 3), 0);
  assert.equal(tabKeyIndex('End', 0, 3), 2);
  assert.equal(tabKeyIndex('Enter', 1, 3), null);
  assert.equal(tabKeyIndex('ArrowRight', 0, 0), null);
});

test('settings dialog: Tab wraps at the edges and pulls stray focus back in', () => {
  assert.equal(trapIndex(4, 5, false), 0, 'Tab on the last control goes to the first');
  assert.equal(trapIndex(0, 5, true), 4, 'Shift+Tab on the first goes to the last');
  assert.equal(trapIndex(2, 5, false), -1, 'in the middle the browser moves focus');
  assert.equal(trapIndex(-1, 5, false), 0);
  assert.equal(trapIndex(-1, 5, true), 4);
  assert.equal(trapIndex(-1, 0, false), -1);
});

test('settings markup: the header keeps play controls only; the settings sit in the modal with tab roles', () => {
  const header = section('<header>', '</header>');
  const modal = section('<div id="splash"', '<div id="lbModal"');
  const settingIds = ['seed', 'modelAims', 'rosterGrp', 'styleGrp', 'wpnTable', 'wpnPickups', 'wpnReset', 'sndBtn', 'vol', 'musBtn', 'setupModes', 'setupSkip', 'splashStart', 'splashGo', 'settingsClose', 'serverInfo'];
  for (const id of settingIds) {
    assert.doesNotMatch(header, new RegExp(`id="${id}"`), `${id} is not in the header`);
    assert.match(modal, new RegExp(`id="${id}"`), `${id} is in the settings modal`);
  }
  for (const id of ['settingsBtn', 'start', 'restart', 'pauseChip', 'warm', 'sndHint', 'lbBtn', 'clock', 'logList', 'speed']) {
    assert.match(header, new RegExp(`id="${id}"`), `${id} stays in the header`);
  }
  assert.match(modal, /role="dialog"/); assert.match(modal, /aria-modal="true"/); assert.match(modal, /role="tablist"/);
  const tabs = [...modal.matchAll(/role="tab" id="(tab-[a-z]+)"[^>]*aria-controls="(panel-[a-z]+)"/g)];
  assert.equal(tabs.length, 3);
  for (const [, tab, panel] of tabs) {
    assert.match(modal, new RegExp(`role="tabpanel" id="${panel}" aria-labelledby="${tab}"`), `${panel} is labelled by ${tab}`);
  }
  assert.doesNotMatch(html, /id="(?:wpnModal|wpnBtn|settingsModal|setupBtn|splashSettings|setupRoster|setupModelAims|setupStyles)"/, 'duplicate editing paths are gone');
  assert.equal((html.match(/id="splash"/g) || []).length, 1);
  const gameplay = section('id="panel-gameplay"', 'id="panel-sound"');
  for (const id of ['setupModes', 'modelAims', 'styleGrp', 'seed']) assert.match(gameplay, new RegExp(`id="${id}"`));
});

import { fighterRows, addableOptions, applyAdd, applyRemove, MIN_FIGHTERS } from '../public/settings.js';
import { ROSTER, DEFAULT_ROSTER, MAX_FIGHTERS } from '../public/shared.js';

test('fighters tab: the four classifiers by default; Gemini and the bot are offered, not in', () => {
  const enabled = new Set(DEFAULT_ROSTER);
  assert.deepEqual(fighterRows({ roster: ROSTER, enabled }).map((f) => f.slot), ['jev', 'luna', 'laya', 'scaledown']);
  const add = addableOptions({ roster: ROSTER, enabled, max: MAX_FIGHTERS });
  assert.deepEqual(add.fighters.map((o) => o.value), ['slot:gemini', 'slot:bot']);
  assert.deepEqual(add.models, [], 'no gateway models with the picker off');
});

test('fighters tab: a gateway model plays in a free slot as that slot\'s picked model (same wire shape as the old picker)', () => {
  const models = [{ id: 'anthropic/claude-sonnet-5.5' }, { id: 'anthropic/claude-opus-5.5' }, { id: 'google/gemini-2.5-flash-lite' }];
  const st = { roster: ROSTER, enabled: new Set(DEFAULT_ROSTER), picked: {}, models, pickerOn: true, max: MAX_FIGHTERS };
  assert.deepEqual(addableOptions(st).models.map((o) => o.value), ['model:anthropic/claude-sonnet-5.5', 'model:anthropic/claude-opus-5.5'], 'roster models are offered as fighters, not twice');
  const next = applyAdd('model:anthropic/claude-sonnet-5.5', st);
  assert.ok(next.enabled.has('gw1')); assert.deepEqual(next.picked, { gw1: 'anthropic/claude-sonnet-5.5' }, 'the spare gateway slot first');
  const row = fighterRows({ ...st, ...next }).find((f) => f.slot === 'gw1');
  assert.equal(row.model, 'anthropic/claude-sonnet-5.5'); assert.equal(row.gateway, true);
  assert.equal(addableOptions({ ...st, ...next }).models.length, 1, 'another gateway slot remains free');
  const back = applyRemove('gw1', { ...next });
  assert.ok(!back.enabled.has('gw1')); assert.deepEqual(back.picked, {}, 'removing forgets the picked model');
  assert.deepEqual(applyAdd('slot:gemini', { ...st, picked: { gemini: 'x/y' } }).picked, {}, 'a roster fighter plays its own model');
});

test('fighters tab: Remove stops at the minimum, Add at the six-fighter maximum', () => {
  assert.equal(applyRemove('jev', { enabled: new Set(['jev', 'luna']) }), null);
  assert.equal(MIN_FIGHTERS, 2);
  const full = new Set(ROSTER.slice(0, MAX_FIGHTERS).map((r) => r.id));
  assert.equal(full.size, MAX_FIGHTERS);
  assert.deepEqual(addableOptions({ roster: ROSTER, enabled: full, pickerOn: true, models: [{ id: 'a/b' }], max: MAX_FIGHTERS }), { fighters: [], models: [] });
  assert.equal(applyAdd('slot:bot', { roster: ROSTER, enabled: full, max: MAX_FIGHTERS }), null);
  assert.equal(applyAdd('nonsense', { roster: ROSTER, enabled: new Set(['jev']), max: MAX_FIGHTERS }), null);
});

test('model chooser searches names, ids and company names without changing available slots', () => {
  const models = [
    { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
    { id: 'moonshotai/kimi-k2', name: 'Kimi K2' },
  ];
  const st = { roster: ROSTER, enabled: new Set(DEFAULT_ROSTER), models, pickerOn: true, max: MAX_FIGHTERS };
  for (const query of [' SONNET ', 'claude-sonnet-5.5', 'ANTHROPIC']) {
    const options = addableOptions({ ...st, query });
    assert.deepEqual(options.models.map((m) => m.value), ['model:anthropic/claude-sonnet-5.5']);
    assert.match(options.models[0].label, /Claude Sonnet 5.5 \(Anthropic\)/);
  }
  assert.equal(addableOptions({ ...st, query: 'Moonshot AI' }).models[0].value, 'model:moonshotai/kimi-k2');
  assert.deepEqual(addableOptions({ ...st, query: 'no matching model' }), { fighters: [], models: [] });
  assert.equal(addableOptions({ ...st, query: '' }).models.length, 2);
  const next = applyAdd('model:anthropic/claude-sonnet-5.5', st);
  const row = fighterRows({ ...st, ...next }).find((f) => f.slot === 'gw1');
  assert.equal(row.name, 'claude-sonnet-5.5');
  assert.notEqual(row.iconId, 'gemini');
});

test('add results keep arena fighters before gateway models and preserve catalogue order when filtered', () => {
  const models = [
    { id: 'google/gemma-3', name: 'Gemma 3' },
    { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
    { id: 'google/gemma-2', name: 'Gemma 2' },
  ];
  const st = { roster: ROSTER, enabled: new Set(DEFAULT_ROSTER), models, pickerOn: true, max: MAX_FIGHTERS };
  const options = addableOptions({ ...st, query: ' GOOGLE ' });
  const results = [...options.fighters, ...options.models];
  assert.deepEqual(results.map((o) => o.value), ['slot:gemini', 'model:google/gemma-3', 'model:google/gemma-2']);
  assert.deepEqual(results.map((o) => o.company), ['Google', 'Google', 'Google']);
  assert.deepEqual(results.map((o) => o.name), ['GEMINI', 'Gemma 3', 'Gemma 2']);
  assert.deepEqual(addableOptions({ ...st, query: ' CLAUDE ' }).models.map((o) => o.value), ['model:anthropic/claude-sonnet-5.5']);
});


test('any six gateway models can fill a line-up without exposing spare slots as built-in fighters', () => {
  let st = { roster: ROSTER, enabled: new Set(), picked: {}, pickerOn: true, max: MAX_FIGHTERS };
  for (let i = 0; i < MAX_FIGHTERS; i++) {
    const next = applyAdd(`model:acme/model-${i}`, st);
    assert.ok(next); st = { ...st, ...next };
  }
  assert.equal(st.enabled.size, MAX_FIGHTERS);
  assert.deepEqual([...st.enabled], ['gw1', 'gw2', 'gw3', 'gw4', 'gw5', 'gemini']);
  assert.equal(applyAdd('model:acme/extra', st), null);
  assert.equal(new Set(fighterRows(st).map((f) => f.name)).size, MAX_FIGHTERS);
  const empty = addableOptions({ ...st, enabled: new Set(), picked: {} });
  assert.ok(empty.fighters.every((f) => !f.value.startsWith('slot:gw')));
});


test('a picked model can be followed by the Gemini baseline in a mixed line-up', () => {
  const st = { roster: ROSTER, enabled: new Set(DEFAULT_ROSTER), picked: {}, max: MAX_FIGHTERS };
  const picked = applyAdd('model:anthropic/claude-sonnet-5.5', st);
  const mixed = applyAdd('slot:gemini', { ...st, ...picked });
  assert.equal(mixed.enabled.size, MAX_FIGHTERS);
  assert.equal(mixed.picked.gw1, 'anthropic/claude-sonnet-5.5');
  assert.equal(mixed.picked.gemini, undefined);
});
