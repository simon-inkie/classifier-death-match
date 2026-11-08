// Settings modal: one button in the header opens a dialog with tabs (Fighters, Gameplay, Sound).
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

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export function initSettings({ onOpen = () => {} } = {}) {
  const $ = (id) => document.getElementById(id);
  const modal = $('settingsModal'), btn = $('settingsBtn');
  const tabs = [...modal.querySelectorAll('[role="tab"]')];
  let opener = null;

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
    .filter((el) => !el.disabled && el.offsetParent !== null && !el.closest('[hidden]'));
  const open = (tab) => {
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
    (opener && document.contains(opener) ? opener : btn).focus();
  };

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
    if (e.key !== 'Tab') return;
    const els = focusables();
    const j = trapIndex(els.indexOf(document.activeElement), els.length, e.shiftKey);
    if (j >= 0) { e.preventDefault(); els[j].focus(); }
  });
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); }); // the backdrop
  btn.onclick = () => open();
  $('settingsClose').onclick = close;
  $('setupBtn').addEventListener('click', close); // the intro opens in its own dialog
  select(0);
  return { open, close };
}
