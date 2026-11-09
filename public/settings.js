import { ROSTER, DEFAULT_ROSTER, MAX_FIGHTERS } from './shared.js';
import { companyForModel, fighterIdentity, iconIdForModel } from './model-icons.js';

// Shared first-run and Settings dialog, with Fighters, Gameplay and Sound tabs.
// The controls inside keep the ids and wiring they had in the header (game.js), so moving them here
// changes nothing about what they set. This file only adds the dialog behaviour: tabs with arrow keys,
// Escape to close, focus kept inside while open and handed back to the button on close.
// The key decisions are pure functions so they can be tested in Node.

// Which tab a key moves to in a tablist of count tabs, or null for a key that does not move.
export function tabKeyIndex(key, index, count) {
  if (count < 1) return null;
  if (key === 'ArrowRight') return (index + 1) % count;
  if (key === 'ArrowLeft') return (index - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

// Tab at the edge of the dialog wraps round; index -1 means focus is outside it. Returns the index to
// focus instead, or -1 to let the browser move focus as usual.
export function trapIndex(index, count, shift) {
  if (count < 1) return -1;
  if (index < 0) return shift ? count - 1 : 0;
  if (shift && index === 0) return count - 1;
  if (!shift && index === count - 1) return 0;
  return -1;
}

// ---------- Fighters tab: a list with Remove, and an Add list. A fighter is a roster slot (its id is what
// the sim, the logs and the server see); a gateway model plays in a free slot, as that slot's picked
// model, exactly as the per-slot picker did. These functions only decide the list; game.js applies them.
export const MIN_FIGHTERS = 2; // the page will not start a match with fewer

// The slots in play, in roster order, with the model each runs.
export function fighterRows({ roster, enabled, picked = {}, pickerOn = false }) {
  return roster.filter((r) => enabled.has(r.id)).map((r) => {
    const gw = pickerOn && r.kind !== 'bot' && picked[r.id] ? picked[r.id] : null;
    return { slot: r.id, ...fighterIdentity(r, gw || r.model), colour: r.colour, model: gw || r.model, gateway: Boolean(gw), bot: r.kind === 'bot' };
  });
}

// True when the line-up has a full LLM (a picked gateway model, or the built-in Gemini chat slot): the
// Fighters tab then hints that the answer timeout may need raising. Classifier-only line-ups and the bot: false.
export function hasSlowModel(rows) {
  return rows.some((f) => !f.bot && (f.gateway || ROSTER.find((r) => r.id === f.slot)?.kind === 'chat'));
}

// Fill spare gateway slots first, preserving the built-in Gemini choice for mixed line-ups.
function freeSlot(roster, enabled) {
  const free = roster.filter((r) => r.kind !== 'bot' && !enabled.has(r.id));
  return (free.find((r) => r.gatewaySlot) || free.find((r) => r.kind === 'chat') || free[0])?.id ?? null;
}

// What the Add list offers: roster fighters not in play, and (picker on, a model slot free) the gateway
// models not already playing. Empty at the maximum.
export function addableOptions({ roster, enabled, picked = {}, models = [], pickerOn = false, max, query = '' }) {
  if (enabled.size >= max) return { fighters: [], models: [] };
  const matches = (...values) => values.join(' ').toLowerCase().includes(query.trim().toLowerCase());
  const optionFor = (r) => r.kind === 'bot'
    ? { value: `slot:${r.id}`, label: 'Scripted bot (control)', name: 'Scripted bot', model: r.model, company: 'Local', iconId: r.id }
    : { value: `slot:${r.id}`, label: `${r.model.split('/').pop()} (${companyForModel(r.model)}) - ${r.model}`,
      name: r.model.split('/').pop(), model: r.model, company: companyForModel(r.model), iconId: iconIdForModel(r.model) };
  const available = roster.filter((r) => !r.gatewaySlot && !enabled.has(r.id) && matches(r.name, r.id, r.model, companyForModel(r.model)));
  // A built-in chat slot (Gemini) is an ordinary model: listed by its model id, with its provider's group.
  const fighters = available.filter((r) => r.kind !== 'chat').map(optionFor);
  const chat = available.filter((r) => r.kind === 'chat').map(optionFor);
  const withChat = (list) => {
    const out = [...list];
    for (const o of chat) {
      let at = -1;
      out.forEach((x, i) => { if (x.company === o.company) at = i; });
      out.splice(at < 0 ? out.length : at + 1, 0, o);
    }
    return out;
  };
  if (!pickerOn || !freeSlot(roster, enabled)) return { fighters, models: withChat([]) };
  const playing = new Set(roster.filter((r) => enabled.has(r.id)).map((r) => picked[r.id] || r.model));
  const rosterModels = new Set(roster.map((r) => r.model));
  return { fighters, models: withChat(models.filter((m) => !rosterModels.has(m.id) && !playing.has(m.id) && matches(m.name || '', m.id, companyForModel(m.id)))
    .map((m) => ({ value: `model:${m.id}`, label: `${m.name || m.id.split('/').pop()} (${companyForModel(m.id)}) - ${m.id}`,
      name: m.name || m.id.split('/').pop(), model: m.id, company: companyForModel(m.id), iconId: iconIdForModel(m.id), liveOnly: true }))) };
}

// Apply an Add choice. Returns the new { enabled, picked }, or null if it cannot be added.
export function applyAdd(value, { roster, enabled, picked = {}, max }) {
  if (enabled.size >= max || typeof value !== 'string') return null;
  const en = new Set(enabled), pk = { ...picked };
  if (value.startsWith('slot:')) {
    const id = value.slice(5);
    if (!roster.some((r) => r.id === id && !r.gatewaySlot) || en.has(id)) return null;
    en.add(id); delete pk[id]; // a roster fighter plays its own model
    return { enabled: en, picked: pk };
  }
  if (value.startsWith('model:')) {
    const slot = freeSlot(roster, en);
    if (!slot) return null;
    en.add(slot); pk[slot] = value.slice(6);
    return { enabled: en, picked: pk };
  }
  return null;
}

// Remove a slot from play (and forget its picked model). null at the minimum.
export function applyRemove(slot, { enabled, picked = {}, min = MIN_FIGHTERS }) {
  if (!enabled.has(slot) || enabled.size <= min) return null;
  const en = new Set(enabled), pk = { ...picked };
  en.delete(slot); delete pk[slot];
  return { enabled: en, picked: pk };
}

const FOCUSABLE ='button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function initSettings({ onOpen = () => {}, onStart = () => {} } = {}) {
  const $ = (id) => document.getElementById(id);
  const modal = $('splash'), btn = $('settingsBtn');
  const tabs = [...modal.querySelectorAll('[role="tab"]')];
  let opener = null, firstRun = false;

  const select = (i, focus = false) => {
    tabs.forEach((t, j) => {
      const on = i === j;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      t.classList.toggle('on', on);
      $(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tabs[i].focus();
  };
  const focusables = () => [...modal.querySelectorAll(FOCUSABLE)]
    .filter((el) => !el.disabled && el.tabIndex >= 0 && el.offsetParent !== null && !el.closest('[hidden]'));
  const open = (tab, intro = false) => {
    firstRun = intro;
    $('splashStart').hidden = !intro;
    $('splashGo').hidden = !intro;
    $('settingsClose').hidden = intro;
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : btn;
    const i = tabs.findIndex((t) => t.dataset.tab === tab);
    if (i >= 0) select(i);
    onOpen();
    modal.classList.add('show');
    tabs.find((t) => t.getAttribute('aria-selected') === 'true')?.focus();
  };
  const close = () => {
    if (!modal.classList.contains('show')) return;
    modal.classList.remove('show');
    (opener && opener !== document.body && opener.isConnected && opener.offsetParent !== null ? opener : btn).focus();
  };

  const start = () => { close(); onStart(); };

  tabs.forEach((t, i) => {
    t.onclick = () => select(i);
    t.onkeydown = (e) => {
      const j = tabKeyIndex(e.key, i, tabs.length);
      if (j == null) return;
      e.preventDefault();
      select(j, true);
    };
  });
  // on the dialog itself, ahead of the page's own key handler on document
  modal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (firstRun && e.code === 'Space' && (e.target.getAttribute('role') === 'tab' || !['INPUT', 'BUTTON', 'SELECT', 'A'].includes(e.target.tagName))) {
      e.preventDefault(); e.stopPropagation(); start(); return;
    }
    if (e.key !== 'Tab') return;
    const els = focusables();
    const j = trapIndex(els.indexOf(document.activeElement), els.length, e.shiftKey);
    if (j >= 0) { e.preventDefault(); els[j].focus(); }
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); }); // the backdrop
  btn.onclick = () => open();
  $('settingsClose').onclick = close;
  $('splashGo').onclick = close;
  $('splashStart').onclick = start;
  select(0);
  return { open, close };
}

// Validate saved slots before use; validate picked models again when the catalogue arrives.
export function normaliseLineup(ids, picked, models = null) {
  const enabled = new Set(), clean = {}, used = new Set();
  for (const id of Array.isArray(ids) ? ids : DEFAULT_ROSTER) {
    const fighter = ROSTER.find((r) => r.id === id);
    if (!fighter || enabled.has(id) || enabled.size >= MAX_FIGHTERS) continue;
    const model = picked && typeof picked[id] === 'string' ? picked[id] : null;
    const allowed = model && fighter.kind === 'chat'
      && (fighter.gatewaySlot || id === 'gemini')
      && /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_./:-]+$/.test(model)
      && (models === null || models.some((m) => m.id === model));
    if (fighter.gatewaySlot && !allowed) continue;
    // A stale custom Gemini model is dropped too, rather than silently replaced.
    if (model && !allowed) continue;
    const identity = allowed ? model : fighter.model || id;
    if (used.has(identity)) continue;
    enabled.add(id); used.add(identity);
    if (allowed) clean[id] = model;
  }
  if (!enabled.size) return normaliseLineup(DEFAULT_ROSTER, {});
  for (const id of DEFAULT_ROSTER) {
    if (enabled.size >= MIN_FIGHTERS) break;
    const model = ROSTER.find((r) => r.id === id).model;
    if (!used.has(model)) { enabled.add(id); used.add(model); }
  }
  return { enabled, picked: clean };
}

export function normaliseSeed(value) {
  const n = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(2147483647, Math.max(-2147483648, Math.trunc(n))) : 1;
}
