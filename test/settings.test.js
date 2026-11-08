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
