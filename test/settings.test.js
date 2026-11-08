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
  const modal = section('<div id="settingsModal"', '<div id="lbModal"');
  const settingIds = ['seed', 'modelAims', 'rosterGrp', 'styleGrp', 'wpnTable', 'wpnPickups', 'wpnReset', 'sndBtn', 'vol', 'musBtn', 'setupBtn'];
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
  assert.doesNotMatch(html, /id="wpnModal"|id="wpnBtn"/, 'the separate weapons dialog is gone');
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
  assert.ok(next.enabled.has('gemini')); assert.deepEqual(next.picked, { gemini: 'anthropic/claude-sonnet-5.5' }, 'the chat slot first');
  const row = fighterRows({ ...st, ...next }).find((f) => f.slot === 'gemini');
  assert.equal(row.model, 'anthropic/claude-sonnet-5.5'); assert.equal(row.gateway, true);
  assert.equal(addableOptions({ ...st, ...next }).models.length, 0, 'no model slot left free');
  const back = applyRemove('gemini', { ...next });
  assert.ok(!back.enabled.has('gemini')); assert.deepEqual(back.picked, {}, 'removing forgets the picked model');
  assert.deepEqual(applyAdd('slot:gemini', { ...st, picked: { gemini: 'x/y' } }).picked, {}, 'a roster fighter plays its own model');
});

test('fighters tab: Remove stops at the minimum, Add at the six-fighter maximum', () => {
  assert.equal(applyRemove('jev', { enabled: new Set(['jev', 'luna']) }), null);
  assert.equal(MIN_FIGHTERS, 2);
  const full = new Set(ROSTER.map((r) => r.id));
  assert.equal(full.size, MAX_FIGHTERS);
  assert.deepEqual(addableOptions({ roster: ROSTER, enabled: full, pickerOn: true, models: [{ id: 'a/b' }], max: MAX_FIGHTERS }), { fighters: [], models: [] });
  assert.equal(applyAdd('slot:bot', { roster: ROSTER, enabled: full, max: MAX_FIGHTERS }), null);
  assert.equal(applyAdd('nonsense', { roster: ROSTER, enabled: new Set(['jev']), max: MAX_FIGHTERS }), null);
});
