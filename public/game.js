// Browser front end: decision loops, rendering, panels, record and replay.
import { actionsFor, ACTIONS, ROSTER, rosterById, median, DEFAULT_ROSTER, MAX_FIGHTERS, promptVariant } from './shared.js';
import { createMatch, applyAction, step, sceneFor, hashState, ReplayCursor, effectiveAction, normaliseLog,
  TICK_HZ, MATCH_TICKS, RING_START, CENTRE, ARENA_R, PILLAR_R, FIGHTER_R, MAX_HP, makeRng } from './sim.js';
import { spaceAction } from './controls.js';
import { createCountdown, drawCountdownHeadline } from './countdown.js';
import { botDecide, mockDecide, mockLatency, rosterEntry } from './brain.js';
import { spriteCanvases, spriteElement, spriteDataUrl } from './sprites.js';
import { fighterIdentity, recordFighterIdentity } from './model-icons.js';
import * as audio from './audio.js';
import { SKIP_KEY, showSetupOnLoad, initialMode, liveAvailability, settleMode } from './setup.js';
import { initSettings, fighterRows, addableOptions, applyAdd, applyRemove, MIN_FIGHTERS } from './settings.js';
import { WEAPON_NAMES, WEAPON_PARAMS, WEAPONS as WEAPON_DEFAULTS, DEFAULT_WEAPON_CONFIG, paramBounds, normaliseWeapons,
  configId, configSummary, PICKUP_PARAMS, DEFAULT_PICKUPS } from './weapons.js';
import { buildRecord, aggregate, filterRecords, sortStandings, mostKillsIds, celebrationText } from './leaderboard.js';
import { estCost } from './cost.js';
import { DecisionHistory, Seeker, statsAt, DOM_ROW_CAP } from './history.js';

const TICK_MS = 1000 / TICK_HZ;
const MIN_GAP_MS = 100;   // 10 Hz cap per fighter
const TIMEOUT_MS = 2000;  // slower than this = stunned until the next good answer

const $ = (id) => document.getElementById(id);
const world = $('world').getContext('2d');
const ov = $('overlay').getContext('2d');

const params = new URLSearchParams(location.search);
// Live by default; if Live turns out to be unavailable (no key, budget spent, server down), a defaulted
// Live falls back to Mock once the status is known (see refreshStatus).
const firstMode = initialMode(params);
let mode = firstMode.mode;
// Default four: Jev, Luna, Laya, ScaleDown. Gemini and the scripted bot are addable,
// off by default (or ?gemini=1, ?bot=1).
let enabled = new Set(DEFAULT_ROSTER);
if (params.get('bot') === '1') enabled.add('bot');
if (params.get('gemini') === '1') enabled.add('gemini');
let match = null, roster = [], ctl = {}, stats = {}, queue = [], log = null, matchId = 0;
let running = false, paused = false, acc = 0, lastFrame = performance.now();
// Game clock for call scheduling and pending rings: wall time minus time spent paused.
let pausedTotal = 0, pausedAt = null, deferred = new Set();
const gameNow = () => (pausedAt ?? performance.now()) - pausedTotal;
const WLABEL = { pistol: 'PISTOL', shotgun: 'SHOTGUN', rifle: 'RIFLE', uzi: 'UZI', missile: 'MISSILE', flamethrower: 'FLAMER', medpack: 'MEDPACK' };
let replay = null, replayLog = null, lastLog = null, effects = [];
let serverStatus = null;
// Hosted site and model picker. matchToken: issued by /api/match/start for a live match (null on the
// local proxy, which needs none). pickedModels: slot id -> gateway model id, only used when the server
// says the picker is on (and the server checks every id again).
let matchToken = null, liveStarting = false, modelList = [];
let pickedModels = readStoredObject('arenaPicked', {});
function readStoredObject(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? v : d; } catch { return d; } }
const slotModel = (id) => (mode !== 'replay' && serverStatus?.modelPicker && pickedModels[id]) || null; // mock uses the picked identity with this slot's simulated behaviour
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
// The model a panel names: from the log in replay, else the picked model, else the roster's.
function shownModel(id) {
  if (mode === 'replay' && replayLog) return replayLog.roster.find((r) => r.id === id)?.model ?? rosterById[id].model;
  return log?.roster.find((r) => r.id === id)?.model || slotModel(id) || rosterById[id].model;
}
const shownIdentity = (id) => fighterIdentity(rosterById[id], shownModel(id));
const shownName = (id) => shownIdentity(id).name;
const shownIcon = (id) => shownIdentity(id).iconId;
// History scrub. hist holds every decision of the match per fighter. While a row is selected, view is
// {tick, id, idx} and viewMatch is a separate, re-simulated state for that tick: the live match is never touched.
const hist = new DecisionHistory();
let seeker = null, view = null, viewMatch = null, viewStats = null;
const shownMatch = () => viewMatch || match;
// End-of-match winner celebration (presentation only): null, or what is showing and the results it leads to.
let celebrate = null;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

// The celebration's dark scrim, pixel headline and glow, across the whole viewport.
const countdownOverlay = document.createElement('div');
countdownOverlay.id = 'countdown';
countdownOverlay.setAttribute('role', 'status');
countdownOverlay.setAttribute('aria-live', 'assertive');
countdownOverlay.style.cssText = 'position:fixed;inset:0;z-index:60;display:none;align-items:center;justify-content:center;flex-direction:column;background:rgba(4,4,10,.86);text-align:center;cursor:pointer';
const countdownHeadline = document.createElement('canvas');
countdownHeadline.width = 360; countdownHeadline.height = 100;
countdownHeadline.setAttribute('aria-hidden', 'true');
const countdownCaption = document.createElement('span');
countdownCaption.className = 'sr-only';
let fightSoundPlayed = false;
const countdownHint = document.createElement('div');
countdownHint.textContent = 'click or press any key to fight';
countdownHint.style.cssText = 'font:13px var(--font);color:#8c8ca8;margin-top:30px';
countdownOverlay.append(countdownCaption, countdownHeadline, countdownHint);
document.body.appendChild(countdownOverlay);
const countdown = createCountdown({
  show(label) {
    countdownOverlay.style.display = label === null ? 'none' : 'flex';
    countdownCaption.textContent = label || '';
    drawCountdownHeadline(countdownHeadline.getContext('2d'), label);
    if (label === '3') fightSoundPlayed = false;
    if (label !== null && !reducedMotion()) countdownHeadline.animate?.([
      { transform: 'scale(0)', opacity: 0.6 }, { transform: 'scale(1)', opacity: 1 },
    ], { duration: label === 'FIGHT!' ? 300 : 520, easing: 'cubic-bezier(.34,1.56,.64,1)' });
  },
  sound: (fight) => { audio.sfx.countdown(fight); if (fight) fightSoundPlayed = true; },
  onStart: launch,
});
const canPreview = () => !running && !countdown.active && !liveStarting && !match?.over && mode !== 'replay';
// Capture consumes the skip gesture before controls, dialogs or keyboard shortcuts see it.
// The gesture that starts a countdown has already passed capture, so it cannot skip itself.
for (const event of ['keydown', 'click']) document.addEventListener(event, (e) => {
  if (!countdown.active) return;
  e.preventDefault(); e.stopImmediatePropagation();
  if (!e.repeat) countdown.skip();
}, true);


// ---------- small utils
const safeStore = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
function toast(msg, ms = 3500) {
  const t = $('toast'); t.textContent = msg; t.style.display = 'block';
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.style.display = 'none'), ms);
}
const fmtMs = (v) => (v == null ? '-' : `${Math.round(v)}ms`);

// ---------- character style: 'classic' (discs) or 'logos' (pixel sprites). Default to 'logos'.
const STYLES = ['classic', 'logos'];
let charStyle = STYLES.includes(params.get('style')) ? params.get('style')
  : STYLES.includes(safeStore.get('arenaStyle', 'logos')) ? safeStore.get('arenaStyle', 'logos') : 'logos';
function setStyle(st) {
  charStyle = st;
  safeStore.set('arenaStyle', st);
  document.body.classList.toggle('style-logos', st === 'logos');
  for (const b of document.querySelectorAll('#styleGrp button')) b.classList.toggle('on', b.dataset.style === st);
}
const hitFlash = {}; // fighter id -> tick of last hit, for the white flash

// ---------- weapon config: which weapons spawn and their numbers. Remembered per browser, clamped on load.
// It is fixed for a match at Start (and saved in its log), so edits apply from the next match.
// A saved config from before the pickup knobs existed gets today's pickup defaults (a log without them
// still means the original 1 and 1; that is handled in normaliseWeapons).
const storedWeapons = safeStore.get('arenaWeapons', null);
let weaponCfg = normaliseWeapons(storedWeapons && typeof storedWeapons === 'object' && storedWeapons.pickups
  ? storedWeapons : { ...(storedWeapons || DEFAULT_WEAPON_CONFIG), pickups: DEFAULT_PICKUPS });
if (safeStore.get('arenaModelAims', false) === true) weaponCfg.modelAims = true;
else delete weaponCfg.modelAims;
function setWeaponCfg(c) {
  weaponCfg = normaliseWeapons(c);
  safeStore.set('arenaWeapons', weaponCfg);
  $('wpnSummary').textContent = `Active: ${configSummary(weaponCfg)}  (config ${configId(weaponCfg)})`;
  if (canPreview()) preview();
}
// Leaderboard: mock matches are neither shown nor recorded unless this is ticked (off on every load;
// &lbmock=1 ticks it, for tests).
let lbIncludeMock = params.get('lbmock') === '1';
let lbCurrentOnly = false;
const anyModal = () => document.querySelector('.modal.show');

// ---------- header and settings controls (the settings live in the Settings modal, same ids and wiring)
function buildHeader() {
  $('modelAims').checked = Boolean(weaponCfg.modelAims);
  $('modelAims').onchange = (e) => {
    safeStore.set('arenaModelAims', e.target.checked);
    setWeaponCfg({ ...weaponCfg, modelAims: e.target.checked });
  };
  for (const b of document.querySelectorAll('#modes button, #setupModes button')) b.onclick = () => setMode(b.dataset.mode);
  renderFighters();
  for (const b of document.querySelectorAll('#styleGrp button')) b.onclick = () => setStyle(b.dataset.style);
  setStyle(charStyle);
  buildSoundControls();
  $('start').onclick = onSpace;
  $('restart').onclick = restart;
  $('warm').onclick = warmUp;
  $('seed').onchange = () => { if (canPreview()) preview(); };
  $('logList').onchange = () => loadServerLog($('logList').value);
  $('logFile').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    try { setReplayLog(JSON.parse(await f.text())); } catch (err) { toast(`Bad log file: ${err.message}`); }
  };
  $('resAgain').onclick = () => { hideResults(); if (mode === 'replay') setMode('mock'); $('seed').value = Number($('seed').value) + 1; start(); };
  $('resReplay').onclick = () => { hideResults(); if (lastLog) { setMode('replay'); setReplayLog(lastLog); start(); } };
  $('resDownload').onclick = () => downloadLog(lastLog);
  $('resClose').onclick = hideResults;
  $('resResetWins').onclick = () => { safeStore.set('arenaWins', {}); toast('Session wins reset'); };
  const settingsUi = initSettings({ onStart: () => { if (!running) start(); }, onOpen: () => {
    if (running) toast('Fighter and gameplay changes apply from the next match');
    renderWeapons(); renderFighters();
    // which server this page talks to: the older local servers serve the same files with other settings
    $('serverInfo').textContent = `${location.host}, model picker ${serverStatus?.modelPicker ? 'on' : 'off'}`;
  } });
  $('wpnReset').onclick = () => { setWeaponCfg({ ...DEFAULT_WEAPON_CONFIG, modelAims: weaponCfg.modelAims }); renderWeapons(); };
  $('lbBtn').onclick = openLeaderboard;
  $('lbClose').onclick = () => $('lbModal').classList.remove('show');
  $('lbMock').checked = lbIncludeMock;
  $('lbMock').onchange = (e) => { lbIncludeMock = e.target.checked; renderLeaderboard(); };
  $('lbScope').onchange = (e) => { lbCurrentOnly = e.target.value === 'current'; renderLeaderboard(); };
  $('lbReset').onclick = resetLeaderboard;
  $('noticeClose').onclick = () => notice(null);
  $('setupSkip').checked = Boolean(safeStore.get(SKIP_KEY, false));
  $('setupSkip').onchange = (e) => safeStore.set(SKIP_KEY, e.target.checked);
  setWeaponCfg(weaponCfg);
  document.addEventListener('keydown', (e) => {
    if (anyModal()) { // a dialog is open: Escape closes it; Space on the setup modal starts the match
      if (e.key === 'Escape') anyModal().classList.remove('show');
      return;
    }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    // any key during the winner celebration skips to the results, and does nothing else
    if (celebrate) {
      if (e.code === 'Space' || e.key === 'Enter') { e.preventDefault(); e.target.blur?.(); }
      if (!e.repeat) skipCelebration();
      return;
    }
    // Space only ever starts, pauses or resumes. It never restarts (that is the Restart button).
    if (e.code === 'Space') { e.preventDefault(); e.target.blur?.(); onSpace(); }
    // r replays the last match, only from the results screen so it can never kill a running match
    if ((e.key === 'r' || e.key === 'R') && lastLog && $('results').classList.contains('show')) $('resReplay').click();
    if (view && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) { e.preventDefault(); stepView(e.key === 'ArrowLeft' ? -1 : 1); }
    if (e.key === 'l' || e.key === 'L') setStyle(charStyle === 'logos' ? 'classic' : 'logos');
    if (e.key === 'm' || e.key === 'M') audio.setEnabled(!audio.getPrefs().enabled);
    if (e.key === 'n' || e.key === 'N') audio.setMusic(!audio.getPrefs().music);
  });
  // a click anywhere skips the celebration (buttons run their own handler first: Start skips, Restart restarts)
  document.addEventListener('click', () => { if (celebrate) skipCelebration(); });
  setMode(mode);
  if (showSetupOnLoad(params, safeStore)) settingsUi.open('fighters', true);
}

// ---------- Fighters tab: the line-up with Remove, and Add (roster fighters out of play, plus gateway
// models when the picker is on). Same state as before: the enabled slots and the per-slot picked model.
function setLineup(next) {
  if (!next) return;
  enabled.clear(); for (const id of next.enabled) enabled.add(id);
  pickedModels = next.picked; safeStore.set('arenaPicked', pickedModels);
  syncSettings(); // re-renders this tab too
  if (canPreview()) preview();
}
function renderFighters() {
  const rg = $('rosterGrp'); if (!rg) return;
  const pickerOn = Boolean(serverStatus?.modelPicker);
  const rows = fighterRows({ roster: ROSTER, enabled, picked: pickedModels, pickerOn });
  const add = addableOptions({ roster: ROSTER, enabled, picked: pickedModels, models: modelList, pickerOn, max: MAX_FIGHTERS });
  // Status polls must not replace a focused control or close an open Add chooser.
  const signature = JSON.stringify({ rows, add, mode });
  if (rg.dataset.lineup === signature) return;
  rg.dataset.lineup = signature;
  const canRemove = enabled.size > MIN_FIGHTERS, canAdd = add.fighters.length + add.models.length > 0;
  const mockNote = pickerOn && mode === 'mock' ? '<span class="dim">mock simulates this model; no model calls</span>' : '';
  rg.innerHTML = `<ul class="flist" aria-label="Fighters in play">${rows.map((f) => `<li class="setup-row" style="--c:${esc(f.colour)}" data-slot="${esc(f.slot)}">
      <span class="setup-spr"></span>
      <span class="setup-info"><span class="setup-top">
        <span class="setup-name">${esc(f.bot ? 'Scripted bot' : f.name)}</span>
        <span class="setup-kind">${esc(f.gateway ? 'Gateway model' : kindLabel(rosterById[f.slot]))}</span>
      </span><span class="setup-model">${esc(f.bot ? 'if/else control' : f.model)}</span>${f.gateway ? mockNote : ''}</span>
      <button type="button" data-remove="${esc(f.slot)}" ${canRemove ? '' : 'disabled'} aria-label="Remove ${esc(f.gateway ? f.model : f.name)}">Remove</button></li>`).join('')}</ul>
    <div class="fadd">
      <button type="button" id="addBtn" ${canAdd ? '' : 'disabled'} aria-expanded="false" aria-controls="addChooser">Add fighter</button>
      <div id="addChooser" class="fchooser" hidden>
        <input id="modelSearch" type="search" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="addSel" aria-describedby="addCount" placeholder="Search models or companies..." aria-label="Search fighters and models" autocomplete="off">
        <span id="addCount" class="dim" role="status" aria-live="polite"></span>
        <div id="addSel" class="fresults" role="listbox" aria-label="Fighter or model to add"></div>
        <span id="addEmpty" class="dim" hidden>No matching fighters or models</span>
      </div>
      <span class="dim">${enabled.size} of ${MAX_FIGHTERS} fighters, at least ${MIN_FIGHTERS}.</span>
    </div>`;
  for (const row of rg.querySelectorAll('[data-slot]')) {
    const r = rosterById[row.dataset.slot];
    row.querySelector('.setup-spr').appendChild(spriteElement(rows.find((f) => f.slot === r.id).iconId, 34, r.colour));
  }
  for (const b of rg.querySelectorAll('[data-remove]')) {
    b.onclick = () => {
      setLineup(applyRemove(b.dataset.remove, { enabled, picked: pickedModels }));
      ($('rosterGrp').querySelector('[data-remove]:not([disabled])') || $('addBtn'))?.focus();
    };
  }
  const list = $('addSel'), chooser = $('addChooser'), search = $('modelSearch');
  let results = [], active = -1;
  const highlight = (index) => {
    active = index;
    for (const [i, row] of [...list.children].entries()) row.setAttribute('aria-selected', String(i === active));
    if (active < 0) search.removeAttribute('aria-activedescendant');
    else {
      search.setAttribute('aria-activedescendant', list.children[active].id);
      list.children[active].scrollIntoView({ block: 'nearest' });
    }
  };
  const choose = (index) => {
    if (!results[index]) return;
    setLineup(applyAdd(results[index].value, { roster: ROSTER, enabled, picked: pickedModels, max: MAX_FIGHTERS }));
    ($('addBtn')?.disabled ? rg.querySelector('[data-remove]:not([disabled])') : $('addBtn'))?.focus();
  };
  const filterOptions = () => {
    const options = addableOptions({ roster: ROSTER, enabled, picked: pickedModels, models: modelList, pickerOn, max: MAX_FIGHTERS, query: search.value });
    results = [...options.fighters, ...options.models];
    list.innerHTML = results.map((o, i) => `<div id="addOption-${i}" class="fresult" role="option" aria-selected="false" title="${esc(o.model)}">
      <span class="fresult-icon" aria-hidden="true"></span>
      <span class="fresult-info"><span class="fresult-name">${esc(o.name)}</span><span class="dim">${esc(o.company)}</span></span>
      <span class="fresult-tag">${i < options.fighters.length ? 'arena' : 'gateway (live only)'}</span>
    </div>`).join('');
    [...list.children].forEach((row, i) => {
      row.querySelector('.fresult-icon').appendChild(spriteElement(results[i].iconId, 24));
      row.onmousedown = (e) => e.preventDefault(); // keep typing focus on the combobox
      row.onclick = () => choose(i);
    });
    $('addCount').textContent = `${results.length} matches`;
    $('addEmpty').hidden = results.length > 0;
    list.scrollTop = 0;
    highlight(-1);
  };
  filterOptions();
  search.oninput = filterOptions;
  const closeChooser = () => {
    chooser.hidden = true;
    $('addBtn').setAttribute('aria-expanded', 'false');
    search.setAttribute('aria-expanded', 'false');
    highlight(-1);
    $('addBtn').focus();
  };
  $('addBtn').onclick = () => {
    if (!chooser.hidden) { closeChooser(); return; }
    chooser.hidden = false;
    $('addBtn').setAttribute('aria-expanded', 'true');
    search.setAttribute('aria-expanded', 'true');
    search.focus();
  };
  chooser.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation(); closeChooser();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); e.stopPropagation();
      if (results.length) highlight(active < 0 ? (e.key === 'ArrowDown' ? 0 : results.length - 1)
        : (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length);
    } else if (e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation(); choose(active < 0 ? 0 : active);
    }
  };
}

function kindLabel(r) {
  if (r.kind === 'chat') return 'Chat LLM (JSON)';
  if (r.kind === 'bot') return 'If/Else Bot';
  return 'Decision Classifier';
}

function syncSettings() {
  renderFighters();
  updateSetupLive();
}

// The modal's Live button and its note follow the server's status (no key, budget spent, server down).
function updateSetupLive() {
  const live = document.querySelector('#setupModes button[data-mode="live"]');
  $('serverInfo').textContent = `${location.host}, model picker ${serverStatus?.modelPicker ? 'on' : 'off'}`;
  if (!live || !statusKnown) return;
  const a = liveAvailability(serverStatus);
  live.disabled = !a.ok;
  live.title = a.note;
  $('setupLiveNote').textContent = a.note;
  $('setupLiveNote').style.display = a.note ? '' : 'none';
}

// ---------- sound controls (presentation only; see audio.js)
function buildSoundControls() {
  const sync = () => {
    const p = audio.getPrefs();
    $('sndBtn').textContent = `Sound ${p.enabled ? 'on' : 'off'} [M]`;
    $('sndBtn').classList.toggle('on', p.enabled);
    $('musBtn').textContent = `Music ${p.music ? 'on' : 'off'} [N]`;
    $('musBtn').classList.toggle('on', p.music && p.enabled);
    $('vol').value = Math.round(p.volume * 100);
    $('vol').disabled = !p.enabled;
    $('sndHint').classList.toggle('show', audio.needsGesture());
  };
  audio.onChange(sync);
  $('sndBtn').onclick = () => audio.setEnabled(!audio.getPrefs().enabled);
  $('musBtn').onclick = () => audio.setMusic(!audio.getPrefs().music);
  $('vol').oninput = (e) => audio.setVolume(Number(e.target.value) / 100);
  $('vol').onchange = (e) => e.target.blur(); // hand keys (space, M, N) back to the game
  $('sndHint').onclick = () => audio.unlock();
  sync();
}

function setMode(m) {
  if (running || countdown.active || liveStarting) stop();
  mode = m;
  document.body.dataset.mode = m; // the settings tabs say a replay uses its log's fighters and settings
  for (const b of document.querySelectorAll('#modes button, #setupModes button')) b.classList.toggle('on', b.dataset.mode === m);
  $('replayGrp').style.display = m === 'replay' ? 'flex' : 'none';
  $('liveGrp').style.display = m === 'replay' ? 'none' : 'flex';
  $('rosterGrp').style.display = m === 'replay' ? 'none' : 'flex';
  $('warm').style.display = m === 'live' && !serverStatus?.hosted ? '' : 'none';
  if (m !== 'live') notice(null); else if (serverStatus?.spendMessage) notice(serverStatus.spendMessage);
  history.replaceState(null, '', `?mode=${m}`);
  if (m === 'replay') refreshLogList(); else preview();
}

let statusKnown = false;
async function refreshStatus() {
  try {
    serverStatus = await (await fetch('/api/status')).json();
    statusKnown = true;
    settleFirstMode();
    const k = $('keyChip');
    k.textContent = serverStatus.keyLoaded ? 'KEY LOADED' : 'NO KEY';
    k.className = `chip ${serverStatus.keyLoaded ? 'ok' : 'bad'}`;
    updateBudget(serverStatus.budget);
    applyHostedUi();
    if (serverStatus.modelPicker) loadModelList(); else { modelList = []; syncSettings(); }
  } catch {
    $('keyChip').textContent = 'PROXY DOWN'; $('keyChip').className = 'chip bad';
    serverStatus = null; statusKnown = true; settleFirstMode();
  }
  updateSetupLive();
}
// once, on the first status: a defaulted Live that cannot run becomes Mock
function settleFirstMode() {
  if (settleFirstMode.done) return;
  settleFirstMode.done = true;
  const m = settleMode(firstMode, serverStatus);
  if (m !== mode && !running && !countdown.active && !liveStarting) setMode(m);
}

// ---------- hosted site: live-budget notice and status chips; nothing here runs on the local proxy
function notice(msg) {
  const n = $('notice');
  if (!msg) { n.classList.remove('show'); return; }
  $('noticeText').textContent = msg; n.classList.add('show');
}
function applyHostedUi() {
  const hosted = Boolean(serverStatus?.hosted);
  document.body.classList.toggle('hosted', hosted);
  $('budgetChip').style.display = serverStatus?.budget ? '' : 'none';
  $('warm').style.display = mode === 'live' && !hosted ? '' : 'none';
  if (hosted) {
    $('keyChip').textContent = serverStatus.spend?.exhausted ? 'LIVE PAUSED' : serverStatus.keyLoaded ? 'LIVE OPEN' : 'MOCK ONLY';
    $('keyChip').className = `chip ${serverStatus.spend?.exhausted || !serverStatus.keyLoaded ? 'bad' : 'ok'}`;
  }
  if (serverStatus?.spendMessage && mode === 'live') notice(serverStatus.spendMessage);
}

// ---------- model picker (only when the server has ENABLE_MODEL_PICKER on): the gateway models the
// Fighters tab can add. A picked model that the server no longer offers is dropped.
async function loadModelList() {
  try {
    const j = await (await fetch('/api/models')).json();
    modelList = j.enabled && Array.isArray(j.models) ? j.models : [];
  } catch { return; }
  for (const id of Object.keys(pickedModels)) if (!modelList.some((m) => m.id === pickedModels[id])) {
    delete pickedModels[id];
    if (rosterById[id]?.gatewaySlot) enabled.delete(id);
  }
  safeStore.set('arenaPicked', pickedModels);
  syncSettings();
  if (canPreview()) preview();
}
function updateBudget(b) {
  if (!b) return;
  const c = $('budgetChip');
  c.textContent = `CALLS ${b.used}/${b.max}`;
  c.className = `chip ${b.used >= b.max ? 'bad' : b.used > b.max * 0.8 ? 'bad' : ''}`;
}

async function refreshLogList() {
  try {
    const files = await (await fetch('/api/logs')).json();
    const sel = $('logList');
    sel.innerHTML = '<option value="">saved logs...</option>' + files.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    // Preserve the filename value/API contract; enrich a bounded set of recent labels.
    await Promise.allSettled(files.slice(-20).map(async (name) => {
      const resp = await fetch(`/logs/${encodeURIComponent(name)}`);
      if (!resp.ok) return;
      const saved = await resp.json();
      const names = (saved.roster || []).map((r) => recordFighterIdentity(r).name);
      const option = [...sel.options].find((o) => o.value === name);
      if (option && names.length) option.textContent = `${name}: ${names.join(' vs ')}`;
    }));
    if (lastLog && !replayLog) setReplayLog(lastLog);
  } catch { toast('Could not list logs (is the proxy running?)'); }
}
async function loadServerLog(name) {
  if (!name) return;
  try { setReplayLog(await (await fetch(`/logs/${encodeURIComponent(name)}`)).json()); } catch (e) { toast(`Load failed: ${e.message}`); }
}
// The replay roster always comes from the log, never from the tick-boxes, so a match recorded
// with or without the bot replays with exactly the fighters it had.
function logHasBot(l) { return l.roster.some((r) => r.id === 'bot'); }
function setReplayLog(l) {
  if (running || countdown.active || liveStarting) stop();
  const unknown = (l.roster || []).filter((r) => !rosterById[r.id]).map((r) => r.id);
  if (!Array.isArray(l.roster) || unknown.length) { toast(`Bad log: unknown fighters ${unknown.join(', ')}`); return; }
  l = normaliseLog(l);
  replayLog = l;
  celebrate = null;
  roster = l.roster.map((r) => r.id);
  match = new ReplayCursor(l).state;
  buildPanels();
  let summary = $('replayModels');
  if (!summary) {
    summary = document.createElement('div'); summary.id = 'replayModels';
    summary.style.cssText = 'display:flex;gap:12px;flex-wrap:wrap;font-size:11px';
    $('replayGrp').appendChild(summary);
  }
  summary.innerHTML = l.roster.map((r) => fighterCell(r)).join(' vs ');
  toast(`Loaded replay: seed ${l.seed}, ${roster.length} fighters (${logHasBot(l) ? 'with' : 'without'} bot), ${l.decisions.length} decisions, mode ${l.mode}.\nWeapons: ${l.weapons ? configSummary(normaliseWeapons(l.weapons)) : 'all (older log)'}. Press Start.`);
}

// ---------- panels
function buildPanels() {
  const L = $('left'), R = $('right');
  L.innerHTML = ''; R.innerHTML = '';
  stats = {};
  hist.reset(roster); seeker = null; view = null; viewMatch = null; viewStats = null; updateViewUi();
  roster.forEach((id, idx) => {
    const r = rosterById[id];
    const el = document.createElement('div');
    el.className = 'panel'; el.style.setProperty('--c', r.colour);
    const note = r.kind === 'chat' ? 'Prompted for JSON: self-reported confidence, not a distribution'
      : r.kind === 'bot' ? 'Scripted if/else control: one-hot, no model'
      : `Typed decision: probability per option${promptVariant(r) === 'compact' ? '. Compact prompt (512-token limit)' : ''}`;
    el.innerHTML = `
      <div class="ph"><span class="spr"></span><span class="name">${esc(shownName(id))}</span><span class="model">${esc(shownModel(id))}</span><span class="st"></span></div>
      <div class="viewtag"><span class="vt"></span><button type="button" class="vlive">Back to live</button></div>
      <div class="hp"><div class="fill"></div><span>100</span></div>
      <div class="stats">LAST <b class="last">-</b> MED <b class="med">-</b> <b class="dps">0.0</b>/S ERR <b class="err">0</b> COST <b class="cost">$0</b></div>
      <div class="bars">${actionsFor(sceneFor(match, id)).map((a) => `<div class="bar" data-a="${a}" ${a.startsWith('shoot_') ? `style="--c:${rosterById[a.slice(6)].colour}"` : ''}><span class="lbl">${a.startsWith('shoot_') ? esc(shownName(a.slice(6))) : a.replace('_', ' ').toUpperCase()}</span><span class="segs">${'<i></i>'.repeat(20)}</span><span class="pct"></span></div>`).join('')}</div>
      <div class="note">${note}</div>
      <ol class="log"></ol>`;
    el.querySelector('.spr').appendChild(spriteElement(shownIcon(id), 36, r.colour));
    (idx % 2 === 0 ? L : R).appendChild(el);
    const ol = el.querySelector('.log');
    const pick = (e) => { const li = e.target.closest?.('li[data-idx]'); return li ? Number(li.dataset.idx) : null; };
    ol.addEventListener('click', (e) => {
      const i = pick(e); if (i == null) return;
      e.target.closest('li').blur(); // keep Space for resume after a mouse click
      selectRow(id, i);
    });
    ol.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.code !== 'Space') return;
      const i = pick(e); if (i == null) return;
      if (e.code === 'Space' && e.target.classList.contains('sel')) return; // already selected: Space resumes
      e.preventDefault(); e.stopPropagation(); // Space here selects the row; it must not also resume
      selectRow(id, i);
    });
    el.querySelector('.vlive').onclick = backToLive;
    stats[id] = { el, lat: [], ticks: [], errors: 0, timeouts: 0, calls: 0, cost: 0, costEst: false, lastMs: null, pendingSince: null, decisions: 0, targetsChosen: {} };
  });
}

function setBars(id, d) {
  const s = stats[id]; if (!s) return;
  const m = shownMatch();
  if (m.weapons.modelAims) {
    const options = d.probs ? Object.keys(d.probs) : actionsFor(sceneFor(m, id));
    if (d.a?.startsWith('shoot_') && !options.includes(d.a)) options.push(d.a);
    s.el.querySelector('.bars').innerHTML = options.map((a) => `<div class="bar" data-a="${a}" ${a.startsWith('shoot_') ? `style="--c:${rosterById[a.slice(6)].colour}"` : ''}><span class="lbl">${a.startsWith('shoot_') ? esc(shownName(a.slice(6))) : a.replace('_', ' ').toUpperCase()}</span><span class="segs">${'<i></i>'.repeat(20)}</span><span class="pct"></span></div>`).join('');
  }
  for (const bar of s.el.querySelectorAll('.bar[data-a]')) {
    const a = bar.dataset.a;
    let p = null;
    if (d.probs) p = d.probs[a] ?? 0;
    else if (d.a === a && d.conf != null) p = d.conf;
    else if (d.a === a) p = 1;
    const n = p == null ? 0 : Math.round(Math.max(0, Math.min(1, p)) * 20);
    bar.querySelectorAll('i').forEach((seg, i) => seg.classList.toggle('f', i < n));
    bar.querySelector('.pct').textContent = p == null ? '' : p.toFixed(2);
    bar.classList.toggle('lit', !d.err && d.a === a);
  }
}

function recordDecision(d) {
  const s = stats[d.f]; if (!s) return;
  s.calls++;
  s.decisions++;
  if (match.weapons.modelAims && !d.err && d.a?.startsWith('shoot_')) {
    const target = d.a.slice(6);
    s.targetsChosen[target] = (s.targetsChosen[target] || 0) + 1;
  }
  s.ticks.push(d.t);
  if (d.err) { s.errors++; if (/timeout/i.test(d.err)) s.timeouts++; }
  else if (d.ms != null) s.lat.push(d.ms);
  if (d.cost) s.cost += d.cost;
  if (d.costEst) s.costEst = true;
  s.lastMs = d.ms;
  if (d.err) audio.sfx.buzz(d.f); else audio.sfx.blip(d.f);
  const idx = hist.add(d);
  if (!view) setBars(d.f, d);
  const li = document.createElement('li');
  li.dataset.idx = idx; li.tabIndex = 0; li.setAttribute('role', 'button');
  const time = (d.t / TICK_HZ).toFixed(1).padStart(4, ' ');
  if (d.err) { li.className = 'e'; li.textContent = `${time}s STUNNED ${String(d.err).slice(0, 60)}`; }
  else {
    const p = d.probs ? d.probs[d.a] : d.conf;
    li.textContent = `${time}s ${(match.weapons.modelAims && d.a.startsWith('shoot_') ? `shoot -> ${shownName(d.a.slice(6))}` : d.a.replace('_', ' ').toUpperCase()).padEnd(12, ' ')} ${p == null ? '' : p.toFixed(2)} ${fmtMs(d.ms)}`;
  }
  li.title = 'Click to rewind to this decision';
  const ol = s.el.querySelector('.log');
  // newest on top. At the top the list stays at the top; scrolled down, hold the reader's place.
  const away = ol.scrollTop > 2;
  ol.prepend(li);
  if (away) ol.scrollTop += li.offsetHeight;
  while (ol.children.length > DOM_ROW_CAP) ol.lastChild.remove();
  if (view) markRows();
}

// ---------- history scrub: click a log row to rewind the arena and the panels to that decision
function seekLog() { return mode === 'replay' ? replayLog : log; }
function getSeeker() {
  const l = seekLog();
  if (!seeker || seeker.log !== l) seeker = new Seeker(l);
  return seeker;
}
const NO_DECISION = { a: null, probs: null, conf: null, err: null };

function selectRow(id, idx) {
  if (celebrate || !match) return;
  const d = hist.get(id, idx); if (!d || !seekLog()) return;
  if (running && !paused) pause(); // pause first, then rewind
  view = { tick: d.t, id, idx };
  applyView();
}

function applyView() {
  viewMatch = getSeeker().stateAt(view.tick, match.tick);
  viewStats = {};
  for (const id of roster) {
    viewStats[id] = statsAt(hist.list(id), view.tick);
    const i = id === view.id ? view.idx : hist.indexAt(id, view.tick);
    setBars(id, hist.get(id, i) || NO_DECISION);
  }
  updateViewUi();
  markRows();
}

function backToLive() {
  if (!view) return;
  view = null; viewMatch = null; viewStats = null;
  for (const id of roster) { const l = hist.list(id); setBars(id, l[l.length - 1] || NO_DECISION); }
  updateViewUi();
  markRows();
  if (running && paused) resume();
}

// Highlight the selected row, and the row each other fighter was on at that tick.
function markRows() {
  for (const id of roster) {
    const ol = stats[id]?.el.querySelector('.log'); if (!ol) continue;
    for (const li of ol.querySelectorAll('li.sel, li.at')) li.classList.remove('sel', 'at');
    if (!view) continue;
    const i = id === view.id ? view.idx : hist.indexAt(id, view.tick);
    const li = i < 0 ? null : ol.querySelector(`li[data-idx="${i}"]`);
    if (!li) continue;
    li.classList.add(id === view.id ? 'sel' : 'at');
    if (li.offsetTop < ol.scrollTop) ol.scrollTop = li.offsetTop;
    else if (li.offsetTop + li.offsetHeight > ol.scrollTop + ol.clientHeight) ol.scrollTop = li.offsetTop + li.offsetHeight - ol.clientHeight;
  }
}

function updateViewUi() {
  const secs = view ? (view.tick / TICK_HZ).toFixed(1) : '';
  $('viewBar').classList.toggle('show', Boolean(view));
  $('viewMsg').textContent = view ? `Viewing ${secs}s, paused. Space or Back to live to resume` : '';
  $('viewLive').onclick = backToLive;
  for (const id of roster) {
    const tag = stats[id]?.el.querySelector('.viewtag'); if (!tag) continue;
    tag.classList.toggle('show', Boolean(view));
    if (!view) continue;
    const d = hist.get(id, id === view.id ? view.idx : hist.indexAt(id, view.tick));
    tag.querySelector('.vt').textContent = `viewing ${secs}s` + (d ? `  ${fmtMs(d.ms)}  ${d.cost ? `${d.costEst ? '~' : ''}$${d.cost.toFixed(5)}` : '$0'}${d.err ? `  ERR ${String(d.err).slice(0, 30)}` : ''}` : '  no decision yet');
  }
}

function stepView(dir) {
  if (!view) return;
  const idx = hist.step(view.id, view.idx, dir);
  if (idx < 0 || idx === view.idx) return;
  selectRow(view.id, idx);
}

function refreshPanels() {
  const match = shownMatch();
  if (!match) return;
  for (const f of match.fighters) {
    const s = stats[f.id]; if (!s) continue;
    const vs = viewStats?.[f.id]; // while viewing: the readout as it was at that tick
    const fill = s.el.querySelector('.hp .fill');
    fill.style.width = `${Math.max(0, f.hp)}%`;
    fill.classList.toggle('low', f.hp < 35);
    s.el.querySelector('.hp span').textContent = `${Math.max(0, f.hp)} HP  ${WLABEL[f.weapon] || f.weapon.toUpperCase()}${f.weapon !== 'pistol' ? ' x' + f.ammo : ''}  K${f.kills}`;
    if (vs) {
      s.el.querySelector('.last').textContent = fmtMs(vs.lastMs);
      s.el.querySelector('.med').textContent = fmtMs(vs.medianMs);
      s.el.querySelector('.dps').textContent = vs.dps.toFixed(1);
      s.el.querySelector('.err').textContent = vs.errors;
      s.el.querySelector('.cost').textContent = `${vs.costEst ? '~' : ''}$${vs.cost.toFixed(5)}`;
    } else {
    s.el.querySelector('.last').textContent = fmtMs(s.lastMs);
    s.el.querySelector('.med').textContent = fmtMs(median(s.lat));
    const recent = s.ticks.filter((t) => t > match.tick - 3 * TICK_HZ).length;
    s.el.querySelector('.dps').textContent = (recent / Math.min(3, Math.max(match.tick, 1) / TICK_HZ)).toFixed(1);
    s.el.querySelector('.err').textContent = s.errors;
    s.el.querySelector('.cost').textContent = `${s.costEst ? '~' : ''}$${s.cost.toFixed(5)}`;
    }
    const st = s.el.querySelector('.st');
    s.el.classList.toggle('dead', !f.alive);
    s.el.classList.toggle('winner', match.over && match.winner === f.id);
    if (match.over && match.winner === f.id) { st.className = 'st win'; st.textContent = 'WINNER'; }
    else if (!f.alive) { st.className = 'st dead'; st.textContent = 'DEAD'; }
    else if (f.stunned) { st.className = 'st stun'; st.textContent = 'STUNNED'; }
    else if (!view && isPending(f.id)) { st.className = 'st think'; st.textContent = 'THINKING'; }
    else { st.className = 'st'; st.textContent = ''; }
  }
}

// ---------- match lifecycle
function selectedRoster() { return ROSTER.map((r) => r.id).filter((id) => enabled.has(id)); }

function preview() {
  roster = selectedRoster();
  if (roster.length < 2) { toast('Pick at least two fighters'); return; }
  celebrate = null;
  log = null;
  match = createMatch({ seed: Number($('seed').value) | 0, roster, weapons: weaponCfg });
  buildPanels();
  refreshPanels();
}

function onSpace() {
  if (countdown.active) { countdown.skip(); return; }
  if (view) { backToLive(); return; } // viewing history: Space returns to the live match (and resumes it)
  const act = spaceAction({ running, paused, results: $('results').classList.contains('show'), celebrating: Boolean(celebrate) });
  if (act === 'skip') skipCelebration();
  else if (act === 'start') start();
  else if (act === 'pause') pause();
  else if (act === 'resume') resume();
}

// Restart the current match from scratch: same seed and roster (or the same replay log).
function restart() {
  if (countdown.active) { countdown.skip(); return; }
  if (mode === 'replay' && !replayLog) { toast('Pick a saved log or load a file first'); return; }
  start();
}

function pause() {
  if (!running || paused) return;
  paused = true; pausedAt = performance.now();
  updateControls();
}

function resume() {
  if (!paused) return;
  pausedTotal += performance.now() - pausedAt;
  pausedAt = null; paused = false;
  acc = 0; lastFrame = performance.now();
  // calls that were due while paused go out now; answers that landed while paused are applied
  // on the next tick (drainQueue), keyed by that tick in the log, so replay still verifies
  const mid = matchId, ids = [...deferred];
  deferred.clear();
  for (const id of ids) ask(id, mid);
  updateControls();
}

function clearPause() {
  if (paused) pausedTotal += performance.now() - pausedAt;
  paused = false; pausedAt = null; deferred.clear();
}

function updateControls() {
  const b = $('start');
  b.textContent = countdown.active ? 'Fight [space]' : !running ? 'Start [space]' : paused ? 'Resume [space]' : 'Pause [space]';
  b.classList.toggle('go', !running || paused);
  $('pauseChip').classList.toggle('show', paused);
  document.body.classList.toggle('paused', paused);
}

function start() {
  if (countdown.active) { countdown.skip(); return; }
  if (liveStarting) return;
  if (warmupActive) { toast('Warm-up is still running. Start when it finishes.'); return; }
  cancelWarmup();
  view = null; viewMatch = null; viewStats = null;
  hideResults();
  celebrate = null;
  if (running) stop();
  clearPause();
  effects = [];
  for (const k of Object.keys(hitFlash)) delete hitFlash[k];
  if (mode === 'replay') {
    if (!replayLog) { toast('Pick a saved log or load a file first'); return; }
    roster = replayLog.roster.map((r) => r.id);
    replay = new ReplayCursor(replayLog);
    replay.byFighter = Object.fromEntries(roster.map((id) => [id, replay.decisions.filter((d) => d.f === id)]));
    replay.ptr = Object.fromEntries(roster.map((id) => [id, 0]));
    match = replay.state;
    buildPanels();
  } else if (mode === 'live') {
    if (!serverStatus?.keyLoaded) { toast('No AI_GATEWAY_API_KEY in the proxy: live mode cannot call models. Use Mock.'); return; }
    startLive();
    return;
  } else if (!beginMatch()) return;
  if (mode === 'replay') launch();
  else { countdown.start(); updateControls(); }
}

// A live match asks the server first: it checks the fighters and models, the rate limit and the spend
// ceiling, and (on the hosted site) issues the match token every call must carry.
async function startLive() {
  if (liveStarting) return;
  liveStarting = true;
  const requestId = ++matchId;
  try {
    preview();
    if (roster.length < 2) return;
    const models = Object.fromEntries(roster.filter((id) => slotModel(id)).map((id) => [id, slotModel(id)]));
    const prepared = { roster: [...roster], models, seed: match.seed, weapons: match.weapons };
    await endingMatch;
    if (requestId !== matchId || mode !== 'live') return;
    const resp = await fetch('/api/match/start', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fighters: prepared.roster, models: prepared.models, seed: prepared.seed, weapons: prepared.weapons }) });
    if (requestId !== matchId || mode !== 'live' || running || countdown.active) {
      const stale = await resp.json().catch(() => ({}));
      if (stale.matchToken) endLiveMatch(stale.matchToken);
      return;
    }
    if (resp.status === 404) matchToken = null; // an older proxy without match start
    else {
      const j = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const msg = j.message || j.error || `HTTP ${resp.status}`;
        if (j.ceilingReached) { notice(msg); refreshStatus(); } else toast(msg, 6000);
        return;
      }
      matchToken = j.matchToken || null;
    }
    notice(null);
    if (beginMatch(prepared)) { countdown.start(); updateControls(); }
  } catch (e) {
    toast(`Could not start a live match: ${e.message}`);
  } finally { liveStarting = false; }
}

function beginMatch(prepared = null) {
  if (prepared) {
    roster = prepared.roster;
    log = null;
    match = createMatch(prepared);
  } else preview();
  if (roster.length < 2) return false;
  matchId++;
  queue = [];
  log = { version: 1, modelAims: Boolean(match.weapons.modelAims), mode, seed: match.seed, createdAt: new Date().toISOString(), bot: roster.includes('bot'),
    roster: roster.map((id) => ({ ...rosterEntry(id), kind: rosterById[id].kind, ...pickedEntry(id, prepared ? prepared.models[id] : slotModel(id)) })),
    weapons: match.weapons, weaponsId: match.cfgId, weaponsSummary: configSummary(match.weapons),
    decisions: [] };
  buildPanels(); // now uses the frozen log identities
  ctl = Object.fromEntries(roster.map((id) => [id, { lastAsk: -1e9, pending: false, since: 0 }]));
  return true;
}
// A picked model is recorded in the log (and its prompt variant), so a replay names what really played.
function pickedEntry(id, m) {
  if (!m) return {};
  const same = ROSTER.find((r) => r.model === m && r.kind !== 'bot');
  return { model: m, picked: true, prompt: same ? promptVariant(same) : 'full', kind: same ? same.kind : 'chat' };
}

function launch() {
  running = true; acc = 0; lastFrame = performance.now();
  if (mode === 'replay' || !fightSoundPlayed) {
    effects.push({ type: 'banner', text: 'FIGHT!', life: 45 });
    audio.sfx.start();
  }
  updateControls();
  if (mode !== 'replay') for (const id of roster) ask(id, matchId);
}

// Hand an unfinished hosted match back, so its unused budget is released straight away.
// The site allows one open live match per network, so a new start waits for the old match's end.
let endingMatch = Promise.resolve();
function endLiveMatch(tok = matchToken, { beacon = false } = {}) {
  if (!tok) return;
  const body = JSON.stringify({ matchToken: tok });
  if (matchToken === tok) matchToken = null;
  let sent = false;
  if (beacon) try { sent = Boolean(navigator.sendBeacon?.('/api/match/end', new Blob([body], { type: 'text/plain' }))); } catch {}
  if (!sent) endingMatch = fetch('/api/match/end', { method: 'POST', body, keepalive: true }).catch(() => {});
}
addEventListener('pagehide', () => { if ((running || countdown.active) && mode === 'live') endLiveMatch(matchToken, { beacon: true }); });

function stop() {
  cancelWarmup();
  if (mode === 'live' && (running || countdown.active)) endLiveMatch();
  countdown.cancel();
  view = null; viewMatch = null; viewStats = null; updateViewUi();
  running = false;
  clearPause();
  matchId++; // late answers from this match are ignored
  updateControls();
}

// ---------- decision loops (mock / live / bot)
function isPending(id) {
  if (mode === 'replay') return replayPendingFrac(id) != null;
  return Boolean(ctl[id]?.pending);
}

function scheduleNext(id, mid) {
  const c = ctl[id];
  const wait = Math.max(0, c.lastAsk + MIN_GAP_MS - gameNow());
  setTimeout(() => ask(id, mid), wait);
}

async function ask(id, mid) {
  if (mid !== matchId || !running || countdown.active) return;
  if (paused) { deferred.add(id); return; } // no new calls while paused; sent on resume
  const f = match.fighters.find((x) => x.id === id);
  if (!f || !f.alive || match.over) return;
  const c = ctl[id];
  c.lastAsk = gameNow(); c.pending = true; c.since = c.lastAsk;
  const scene = sceneFor(match, id);
  const r = rosterById[id];
  let ans = null, err = null, ms = 0, cost = 0, costEst = false, halt = false;
  if (r.kind === 'bot') {
    const t0 = performance.now();
    ans = botDecide(scene);
    ms = performance.now() - t0;
  } else if (mode === 'mock') {
    const rnd = Math.random;
    const lat = mockLatency(id, rnd);
    const timeout = lat > TIMEOUT_MS;
    await new Promise((res) => setTimeout(res, timeout ? TIMEOUT_MS : lat));
    ms = timeout ? TIMEOUT_MS : lat;
    if (timeout) err = 'timeout (mock)';
    else if (rnd() < r.mock.err) err = 'mock error';
    else {
      ans = mockDecide(id, scene, rnd);
      cost = estCost(r); costEst = true;
    }
  } else {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const t0 = performance.now();
    try {
      const resp = await fetch('/api/decide', { method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fighter: id, scene, weapons: match.weapons, matchToken: matchToken || undefined, model: log?.roster.find((r) => r.id === id && r.picked)?.model || undefined }) });
      const j = await resp.json();
      ms = performance.now() - t0;
      if (j.budget) updateBudget(j.budget);
      if (!resp.ok) {
        err = j.error || `HTTP ${resp.status}`;
        halt = j.stop === true;
        if (j.ceilingReached && mid === matchId) { notice(j.message || err); refreshStatus(); }
      }
      else {
        ans = j;
        // real when the proxy had the billed cost or token usage; an older proxy sends no costSource
        const real = j.costSource ? j.costSource !== 'none' : Number(j.cost) > 0;
        if (real) cost = Number(j.cost) || 0; else { cost = estCost(r); costEst = true; }
      }
    } catch (e) {
      ms = performance.now() - t0;
      err = e.name === 'AbortError' ? `timeout ${TIMEOUT_MS}ms` : e.message;
    } finally { clearTimeout(timer); }
  }
  if (mid !== matchId) return;
  queue.push({ id, ans, err, ms: Math.round(ms), cost, costEst });
  c.pending = false;
  if (err && (halt || /budget spent|not set/.test(err))) { toast(err); return; } // no runaway retries
  scheduleNext(id, mid);
}

// Apply queued answers on the current tick and record them, keyed by tick.
function drainQueue() {
  while (queue.length) {
    const q = queue.shift();
    const f = match.fighters.find((x) => x.id === q.id);
    if (!f || !f.alive) continue;
    const d = { t: match.tick, f: q.id, a: q.err ? null : q.ans.action, probs: q.ans?.probs ?? null,
      conf: q.ans?.confidence ?? null, ms: q.ms, err: q.err || null,
      cost: q.cost || 0, ...(q.costEst ? { costEst: true } : {}) };
    applyAction(match, q.id, q.err ? 'stunned' : q.ans.action);
    log.decisions.push(d);
    recordDecision(d);
  }
}

function replayPendingFrac(id) {
  if (!replay) return null;
  const list = replay.byFighter[id];
  let p = replay.ptr[id];
  while (p < list.length && list[p].t < match.tick) p++;
  replay.ptr[id] = p;
  const d = list[p];
  if (!d || d.ms == null) return null;
  const startTick = d.t - (d.ms / 1000) * TICK_HZ;
  if (match.tick < startTick) return null;
  return Math.min(1, ((match.tick - startTick) / TICK_HZ) * 1000 / TIMEOUT_MS);
}

// ---------- main loop
function frame(now) {
  const dt = Math.min(250, now - lastFrame);
  lastFrame = now;
  if (running && !paused && match && !match.over) {
    acc += dt * (mode === 'replay' ? Number($('speed').value) : 1);
    while (acc >= TICK_MS && !match.over) {
      // the weapon each fighter holds going into the tick is the one any shot this tick is fired with
      // (the sim may swap an empty gun back to the pistol inside the same step)
      const heldWeapon = {};
      for (const f of match.fighters) heldWeapon[f.id] = f.weapon;
      if (mode === 'replay') {
        for (const d of replay.tick()) recordDecision(d);
      } else {
        drainQueue();
        step(match);
      }
      collectEffects();
      soundEffects(heldWeapon);
      acc -= TICK_MS;
    }
    if (match.over) finishMatch();
  }
  render();
  refreshPanels();
  updateClock();
  requestAnimationFrame(frame);
}

function updateClock() {
  const match = shownMatch();
  if (!match) return;
  const left = Math.max(0, (MATCH_TICKS - match.tick) / TICK_HZ);
  $('clock').textContent = left.toFixed(1);
  $('ringmsg').textContent = match.tick >= RING_START ? 'RING CLOSING' : '';
}

function finishMatch() {
  running = false;
  clearPause();
  updateControls();
  const allDown = match.fighters.every((f) => !f.alive);
  if (mode === 'replay') {
    const h = hashState(match);
    const ok = replayLog.result && h === replayLog.result.hash;
    celebrateThenResults(`${allDown ? 'ALL DOWN: ' : ''}REPLAY ${ok ? 'VERIFIED' : 'MISMATCH'}`, `hash ${h} vs recorded ${replayLog.result?.hash ?? 'none'}; seed ${replayLog.seed}; ${roster.length} fighters, ${logHasBot(replayLog) ? 'with' : 'without'} bot; recorded in ${replayLog.mode} mode`, false);
    lastLog = replayLog;
    return;
  }
  matchId++;
  log.result = { winner: match.winner, ranking: match.ranking, ticks: match.tick, hash: hashState(match),
    stats: Object.fromEntries(roster.map((id) => {
      const s = stats[id], f = match.fighters.find((x) => x.id === id);
      return [id, { hp: f.hp, kills: f.kills, decisions: s.decisions, errors: s.errors,
        medianMs: median(s.lat), cost: s.cost }];
    })) };
  lastLog = log;
  const wins = safeStore.get('arenaWins', {});
  wins[match.winner] = (wins[match.winner] || 0) + 1;
  safeStore.set('arenaWins', wins);
  fetch('/api/logs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(log) })
    .then((r) => r.json()).then((j) => toast(j.name ? `Saved logs/${j.name}` : 'Match log not kept on this server; use Download on the results screen'))
    .catch(() => toast('Could not save log to server; use Download'));
  // Records retain the actual models, so gateway picks have their own leaderboard identity.
  const rec = buildRecord({ state: match, mode, weapons: match.weapons, stats,
    models: Object.fromEntries(log.roster.map((r) => [r.id, r.model])) });
  const recordable = mode === 'live' || (mode === 'mock' && lbIncludeMock && !serverStatus?.hosted);
  // The hosted site builds the record itself from the decisions (re-run and checked on the server).
  const recBody = serverStatus?.hosted && mode === 'live'
    ? { decisions: log.decisions.map(({ t, f, a, err }) => ({ t, f, a, err })) } : rec; // stats come from the server's own record
  if (mode === 'live' && serverStatus?.hosted && (!recordable || roster.includes('bot'))) endLiveMatch();
  if (recordable && !(serverStatus?.hosted && roster.includes('bot'))) {
    const tok = matchToken;
    const saved = fetch('/api/leaderboard/record', { method: 'POST', body: JSON.stringify(recBody),
      headers: { 'Content-Type': 'application/json', ...(mode === 'live' && tok ? { 'X-Match-Token': tok } : {}) } })
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); if (matchToken === tok) matchToken = null; })
      .catch((e) => { toast(`Leaderboard not saved (${e.message})${serverStatus?.hosted ? '' : '; restart the server?'}`); if (serverStatus?.hosted) { endLiveMatch(tok); return endingMatch; } });
    if (mode === 'live' && serverStatus?.hosted) endingMatch = saved; // recording closes the match
  }
  celebrateThenResults(allDown ? 'ALL DOWN' : `${shownName(match.winner)} WINS`,
    `${allDown ? `${shownName(match.winner)} ranked first, ` : ''}${rec.note}; seed ${match.seed}, ${mode} mode, ${roster.length} fighters ${roster.includes('bot') ? 'with' : 'without'} bot, ${(match.tick / TICK_HZ).toFixed(1)} s; weapons: ${configSummary(match.weapons)}`, true);
}

// Winner celebration, then the results table. Everyone down: straight to the stats, no fanfare.
// The fanfare starts with the celebration (audio.js rate-limits it as before).
function celebrateThenResults(title, sub, countWins) {
  const ct = celebrationText(match);
  effects = effects.filter((e) => e.type !== 'banner'); // the last "X DOWN" banner would sit over the headline
  if (ct.allDown) { showResults(title, sub, countWins); return; }
  audio.sfx.win();
  const reduced = reducedMotion(), now = performance.now();
  celebrate = { id: match.winner, ct, reduced, t0: now, last: now, dur: reduced ? 3000 : 4000, parts: [], results: [title, sub, countWins] };
  if (!reduced) { confetti(70, 60, 800, -1.25, 700); confetti(70, 740, 800, -1.9, 700); }
}
function skipCelebration() {
  if (!celebrate) return;
  const [title, sub, countWins] = celebrate.results;
  celebrate = null;
  showResults(title, sub, countWins);
}

const CONFETTI = ['#ffe14d', '#ffffff', '#3cff8a', '#ff4dd2', '#66ccff', '#ff8a00'];
// n pieces from (x, y) in overlay pixels, fanned around angle a (radians) at up to v px/s.
function confetti(n, x, y, a, v) {
  const c = rosterById[celebrate.id].colour;
  for (let k = 0; k < n && celebrate.parts.length < 400; k++) {
    const ang = a + (Math.random() - 0.5) * 0.7, sp = v * (0.45 + Math.random() * 0.55);
    celebrate.parts.push({ x, y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, r: Math.random() * 6, vr: (Math.random() - 0.5) * 12,
      w: 5 + Math.random() * 6, h: 3 + Math.random() * 4, c: Math.random() < 0.4 ? c : CONFETTI[(Math.random() * CONFETTI.length) | 0],
      spark: Math.random() < 0.18 });
  }
}

function drawCelebration(now) {
  const C = celebrate, el = now - C.t0;
  if (el >= C.dur) { skipCelebration(); return; }
  const dt = Math.min(0.05, (now - C.last) / 1000); C.last = now;
  const r = rosterById[C.id], still = C.reduced;
  const fade = still ? 1 : Math.min(1, (C.dur - el) / 450); // fade out into the results
  ov.save();
  ov.globalAlpha = fade;
  ov.fillStyle = `rgba(4,4,10,${still ? 0.7 : Math.min(0.7, el / 300 * 0.7)})`; ov.fillRect(0, 0, 800, 800);
  if (!still && el < 380) { ov.fillStyle = `rgba(255,255,255,${0.4 * (1 - el / 380)})`; ov.fillRect(0, 0, 800, 800); } // gentle flash
  // confetti: a trickle from the top for most of the show, plus the opening bursts
  if (!still) {
    if (el < C.dur - 1200) for (let k = 0; k < 2; k++) confetti(1, Math.random() * 800, -10, Math.PI / 2, 120);
    for (const p of C.parts) {
      p.vy += 520 * dt; p.vx *= 1 - 0.9 * dt; p.vy *= 1 - 0.6 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
      if (p.spark) { // twinkling square sparkle
        if ((now / 90 + p.w) % 2 < 1.2) { ov.fillStyle = '#fff'; ov.fillRect(p.x - 2, p.y - 2, 4, 4); ov.fillStyle = p.c; ov.fillRect(p.x - 5, p.y - 1, 10, 2); ov.fillRect(p.x - 1, p.y - 5, 2, 10); }
        continue;
      }
      ov.save(); ov.translate(p.x, p.y); ov.rotate(p.r); ov.fillStyle = p.c;
      ov.fillRect(-p.w / 2, -p.h / 2 * Math.abs(Math.cos(p.r * 1.7)), p.w, p.h * Math.abs(Math.cos(p.r * 1.7)) + 1); ov.restore();
    }
    C.parts = C.parts.filter((p) => p.y < 820);
  }
  // pop-in for the logo and the headline
  const k = still ? 1 : Math.min(1, el / 520);
  const pop = still ? 1 : 1 + 2.70158 * Math.pow(k - 1, 3) + 1.70158 * Math.pow(k - 1, 2); // ease-out-back
  const bob = still ? 0 : Math.sin(el / 260) * 6;
  const spr = spriteCanvases(shownIcon(C.id));
  const size = 18 * 8 * pop, cx = 400, cy = 250 + bob;
  ov.fillStyle = '#0b0b12'; ov.strokeStyle = r.colour; ov.lineWidth = 6;
  ov.shadowColor = r.colour; ov.shadowBlur = still ? 18 : 18 + 10 * Math.sin(el / 200);
  ov.beginPath(); ov.arc(cx, cy, 92 * pop, 0, Math.PI * 2); ov.fill(); ov.stroke();
  ov.shadowBlur = 0;
  if (spr) { ov.imageSmoothingEnabled = false; ov.drawImage(spr.normal, cx - size / 2, cy - size / 2, size, size); }
  // headline in the winner's colour, shrunk to fit
  const text = `${shownName(C.id).toUpperCase()} WINS!`;
  ov.textAlign = 'center'; ov.textBaseline = 'alphabetic';
  let fs = 64; ov.font = `bold ${fs}px monospace`;
  while (ov.measureText(text).width > 740 && fs > 28) { fs -= 2; ov.font = `bold ${fs}px monospace`; }
  ov.save(); ov.translate(400, 440); ov.scale(pop, pop);
  ov.fillStyle = '#000'; ov.fillText(text, 4, 4);
  ov.fillStyle = r.colour; ov.fillText(text, 0, 0);
  ov.restore();
  ov.font = 'bold 22px monospace'; ov.fillStyle = '#e8e8f0';
  ov.fillText(C.ct.line, 400, 490);
  if (C.ct.tieBreak) { ov.font = '16px monospace'; ov.fillStyle = '#ffe14d'; ov.fillText(C.ct.tieBreak, 400, 522); }
  ov.font = '13px monospace'; ov.fillStyle = '#8c8ca8';
  ov.fillText('click or press any key for the stats', 400, 770);
  ov.restore();
}

function showResults(title, sub, countWins) {
  const wins = safeStore.get('arenaWins', {});
  $('resTitle').textContent = title;
  $('resSub').textContent = sub;
  const rows = match.ranking.map((id, i) => {
    const f = match.fighters.find((x) => x.id === id), s = stats[id], r = rosterById[id];
    const secs = Math.max(1, ((f.deathTick ?? match.tick)) / TICK_HZ);
    return `<tr><td>${i + 1}</td><td style="color:${r.colour}"><img class="sprite rs" alt="" style="box-shadow:0 0 0 2px ${r.colour}" src="${spriteDataUrl(shownIcon(id), 24)}">${esc(shownName(id))} <span style="color:var(--dim);font-size:10px">${esc(shownModel(id))}</span></td>
      <td>${Math.max(0, f.hp)}</td><td>${f.kills}</td><td>${wins[id] || 0}</td><td>${s.decisions}</td>
      <td>${(s.decisions / secs).toFixed(1)}</td><td>${fmtMs(median(s.lat))}</td><td>${s.errors}</td>
      <td>${f.shots ? Math.round((f.hits / f.shots) * 100) + '%' : '-'}</td><td>${r.kind === 'bot' ? '-' : `${s.costEst ? '~' : ''}$${s.cost.toFixed(5)}`}</td></tr>`;
  }).join('');
  $('resTable').innerHTML = `<tr><th>#</th><th>Fighter</th><th title="Health points remaining at the end of the match (0 = knocked out)">HP left</th><th>Kills</th><th>Session wins</th><th>Decisions</th><th>Dec/s</th><th>Median latency</th><th>Errors</th><th>Hit rate</th><th title="~ = includes estimated cost">Cost</th></tr>${rows}`;
  $('results').classList.add('show');
}
function hideResults() { $('results').classList.remove('show'); }

function downloadLog(l) {
  if (!l) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(l)], { type: 'application/json' }));
  a.download = `arena-${l.mode}-seed${l.seed}.json`;
  a.click();
}

let warmupAbort = null, warmupRun = 0, warmupActive = false;
function cancelWarmup() { warmupRun++; warmupAbort?.abort(); warmupAbort = null; }
async function warmUp() {
  if (countdown.active) { countdown.skip(); return; }
  if (!serverStatus?.keyLoaded) { toast('No key loaded in the proxy'); return; }
  if (warmupActive) { toast('Warm-up is already running'); return; }
  cancelWarmup();
  warmupActive = true;
  try {
  const run = warmupRun;
  const ids = selectedRoster();
  const m = createMatch({ seed: 1, roster: ids, weapons: weaponCfg });
  const entries = ids.filter((id) => rosterById[id].kind !== 'bot').map((id) => ({
    ...rosterById[id], model: slotModel(id) || rosterById[id].model,
  }));
  const lines = [];
  for (const r of entries) {
    const times = [];
    for (let i = 0; i < 3; i++) {
      if (run !== warmupRun || countdown.active) return;
      const t0 = performance.now();
      warmupAbort = new AbortController();
      try {
        const resp = await fetch('/api/decide', { method: 'POST', signal: warmupAbort.signal,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fighter: r.id, model: r.model, scene: sceneFor(m, r.id), weapons: m.weapons }) });
        const j = await resp.json();
        if (run !== warmupRun) return;
        if (j.budget) updateBudget(j.budget);
        times.push(resp.ok ? `${Math.round(performance.now() - t0)}ms` : `ERR ${String(j.error).slice(0, 50)}`);
      } catch (e) {
        if (run !== warmupRun) return;
        times.push(`ERR ${e.message}`);
      }
    }
    lines.push(`${fighterIdentity(rosterById[r.id], r.model).name}: ${times.join(', ')}`);
    toast(`Warm up\n${lines.join('\n')}`, 8000);
  }
  } finally { warmupActive = false; warmupAbort = null; }
}

// ---------- rendering
const W = 400;
const floor = document.createElement('canvas');
floor.width = W; floor.height = W;
(function paintFloor() {
  const g = floor.getContext('2d');
  const rnd = makeRng(99);
  g.fillStyle = '#0d0d14'; g.fillRect(0, 0, W, W);
  for (let y = 0; y < W; y += 8) for (let x = 0; x < W; x += 8) {
    const d = Math.hypot(x + 4 - CENTRE, y + 4 - CENTRE);
    if (d > ARENA_R + 4) {
      g.fillStyle = rnd() < 0.5 ? '#12121b' : '#101018'; g.fillRect(x, y, 8, 8); continue;
    }
    const v = ((x >> 3) + (y >> 3)) % 2 ? 38 : 34;
    g.fillStyle = `rgb(${v},${v + 2},${v + 8})`; g.fillRect(x, y, 8, 8);
    for (let k = 0; k < 2; k++) { g.fillStyle = rnd() < 0.5 ? '#2b2d3a' : '#20212c'; g.fillRect(x + ((rnd() * 8) | 0), y + ((rnd() * 8) | 0), 1, 1); }
  }
  // brick wall ring
  for (let a = 0; a < Math.PI * 2; a += 0.035) {
    for (let r = ARENA_R; r < ARENA_R + 6; r += 2) {
      const x = CENTRE + Math.cos(a) * r, y = CENTRE + Math.sin(a) * r;
      g.fillStyle = ((a * 40) | 0) % 2 ? '#7a4a32' : '#5e3624';
      g.fillRect(x | 0, y | 0, 2, 2);
    }
  }
})();

// Inkie splat decal at the arena centre, baked into the cached floor (under everything, so the seek view gets it too).
// Purely visual: the sim never sees it. Drawn only once loaded; a load failure leaves the plain floor.
(function loadFloorDecal() {
  const img = new Image();
  img.onload = () => {
    const w = 80, h = w * img.naturalHeight / img.naturalWidth;
    const g = floor.getContext('2d');
    g.save(); g.globalAlpha = 0.38; g.imageSmoothingQuality = 'high';
    g.drawImage(img, CENTRE - w / 2, CENTRE - h / 2, w, h);
    g.restore();
  };
  img.onerror = () => {};
  img.src = 'assets/inkie-splat-logo.png';
})();

function collectEffects() {
  for (const e of match.events) {
    if (e.type === 'shot' && e.w !== 'flamethrower') effects.push({ type: 'flash', x: e.x + Math.cos(e.a) * 9, y: e.y + Math.sin(e.a) * 9, life: 3 });
    if (e.type === 'explode') {
      effects.push({ type: 'boom', x: e.x, y: e.y, r: e.r, life: 18, max: 18 });
      for (let k = 0; k < 24; k++) effects.push({ type: 'p', x: e.x, y: e.y, vx: (Math.random() - 0.5) * 6, vy: (Math.random() - 0.5) * 6, life: 18, c: Math.random() < 0.5 ? '#ff8a00' : '#ffe14d' });
    }
    if (e.type === 'hit') hitFlash[e.id] = match.tick;
    if (e.type === 'hit' && !e.flame) for (let k = 0; k < 5; k++) effects.push({ type: 'p', x: e.x, y: e.y, vx: (Math.random() - 0.5) * 3, vy: (Math.random() - 0.5) * 3, life: 10, c: '#ff3b3b' });
    if (e.type === 'spark') for (let k = 0; k < 3; k++) effects.push({ type: 'p', x: e.x, y: e.y, vx: (Math.random() - 0.5) * 2, vy: (Math.random() - 0.5) * 2, life: 6, c: '#ffd' });
    if (e.type === 'death') {
      for (let k = 0; k < 30; k++) effects.push({ type: 'p', x: e.x, y: e.y, vx: (Math.random() - 0.5) * 5, vy: (Math.random() - 0.5) * 5, life: 25, c: Math.random() < 0.5 ? '#ff8a00' : '#ffe14d' });
      const by = e.by === e.id ? 'OWN MISSILE' : e.by ? shownName(e.by) : 'THE RING';
      effects.push({ type: 'banner', text: `${shownName(e.id)} DOWN (${by})`, life: 60 });
    }
    if (e.type === 'pickup') effects.push({ type: 'text', x: e.x, y: e.y, text: `+${WLABEL[e.kind] || e.kind.toUpperCase()}`, life: 30 });
  }
}

// Sound from sim events and tick crossings. Read-only: never touches match state.
const RING_BEEPS = [RING_START - 3 * TICK_HZ, RING_START - 2 * TICK_HZ, RING_START - TICK_HZ];
function soundEffects(heldWeapon) {
  for (const e of match.events) {
    if (e.type === 'shot') audio.sfx.shot(e.w || heldWeapon[e.id], e.id);
    else if (e.type === 'explode') audio.sfx.boom();
    else if (e.type === 'hit') audio.sfx.hit(e.id);
    else if (e.type === 'spark' || e.type === 'wall') audio.sfx.ping(e.type);
    else if (e.type === 'pickup') audio.sfx.pickup(e.kind, e.id);
    else if (e.type === 'death') audio.sfx.death(e.id);
  }
  if (RING_BEEPS.includes(match.tick)) audio.sfx.ringBeep();
  if (match.tick === RING_START) audio.sfx.ringWarn();
}

// Logos style: team-coloured ring, facing pointer and gun outside it, then the crisp sprite.
const SPR_HALF = 9; // sprite is 16px + 1px outline each side
function drawLogoFighter(f, colour, flashing) {
  const x = Math.round(f.x), y = Math.round(f.y);
  const cos = Math.cos(f.face), sin = Math.sin(f.face);
  world.fillStyle = '#0009'; world.beginPath(); world.arc(x + 2, y + 3, 11, 0, Math.PI * 2); world.fill();
  // gun barrel and facing chevron sit outside the ring so the sprite never hides them
  world.strokeStyle = '#111'; world.lineWidth = 5;
  world.beginPath(); world.moveTo(x + cos * 10, y + sin * 10); world.lineTo(x + cos * 20, y + sin * 20); world.stroke();
  world.strokeStyle = '#eee'; world.lineWidth = 3;
  world.beginPath(); world.moveTo(x + cos * 10, y + sin * 10); world.lineTo(x + cos * 20, y + sin * 20); world.stroke();
  const px = -sin, py = cos;
  world.fillStyle = colour; world.strokeStyle = '#000'; world.lineWidth = 1.5;
  world.beginPath();
  world.moveTo(x + cos * 19, y + sin * 19);
  world.lineTo(x + cos * 11 + px * 6, y + sin * 11 + py * 6);
  world.lineTo(x + cos * 11 - px * 6, y + sin * 11 - py * 6);
  world.closePath(); world.fill(); world.stroke();
  // team ring
  world.strokeStyle = '#000'; world.lineWidth = 4; world.beginPath(); world.arc(x, y, 10.5, 0, Math.PI * 2); world.stroke();
  world.strokeStyle = flashing ? '#fff' : colour; world.lineWidth = 2; world.beginPath(); world.arc(x, y, 10.5, 0, Math.PI * 2); world.stroke();
  const spr = spriteCanvases(shownIcon(f.id));
  world.imageSmoothingEnabled = false;
  if (spr) world.drawImage(flashing ? spr.flash : spr.normal, x - SPR_HALF, y - SPR_HALF);
}

function render() {
  const match = shownMatch(); // the rewound state while viewing history, else the live match
  if (!match) return;
  world.imageSmoothingEnabled = false;
  world.drawImage(floor, 0, 0);
  // ring
  if (match.ringR < ARENA_R) {
    world.save();
    world.beginPath(); world.arc(CENTRE, CENTRE, ARENA_R, 0, Math.PI * 2); world.arc(CENTRE, CENTRE, match.ringR, 0, Math.PI * 2, true);
    world.fillStyle = 'rgba(255,40,40,0.22)'; world.fill();
    world.restore();
    world.strokeStyle = (match.tick >> 3) % 2 ? '#ff3b3b' : '#a01010'; world.lineWidth = 2;
    world.beginPath(); world.arc(CENTRE, CENTRE, match.ringR, 0, Math.PI * 2); world.stroke();
  }
  // pillars
  for (const p of match.pillars) {
    world.fillStyle = '#0006'; world.beginPath(); world.arc(p.x + 3, p.y + 4, PILLAR_R, 0, Math.PI * 2); world.fill();
    world.fillStyle = '#5b5b70'; world.beginPath(); world.arc(p.x, p.y, PILLAR_R, 0, Math.PI * 2); world.fill();
    world.fillStyle = '#8a8aa3'; world.beginPath(); world.arc(p.x - 4, p.y - 4, PILLAR_R * 0.45, 0, Math.PI * 2); world.fill();
    world.strokeStyle = '#2a2a38'; world.lineWidth = 2; world.beginPath(); world.arc(p.x, p.y, PILLAR_R, 0, Math.PI * 2); world.stroke();
  }
  // pickups
  for (const p of match.pickups) {
    if (!p.active) continue;
    const x = Math.round(p.x), y = Math.round(p.y), bob = (match.tick >> 4) % 2;
    if (p.type === 'medpack') {
      world.fillStyle = '#fff'; world.fillRect(x - 4, y - 4 - bob, 9, 9);
      world.fillStyle = '#e22'; world.fillRect(x - 1, y - 3 - bob, 3, 7); world.fillRect(x - 3, y - 1 - bob, 7, 3);
    } else if (p.type === 'uzi') { // compact purple SMG with a long magazine
      world.fillStyle = '#c8ccd8'; world.fillRect(x - 5, y - 2 - bob, 9, 3);
      world.fillStyle = '#222'; world.fillRect(x - 1, y + 1 - bob, 2, 4); world.fillRect(x + 4, y - 1 - bob, 2, 1);
    } else if (p.type === 'missile') { // green tube, red warhead
      world.fillStyle = '#5fbf3f'; world.fillRect(x - 6, y - 2 - bob, 10, 4);
      world.fillStyle = '#ff4040'; world.fillRect(x + 4, y - 2 - bob, 3, 4);
      world.fillStyle = '#222'; world.fillRect(x - 3, y + 2 - bob, 2, 2);
    } else if (p.type === 'flamethrower') { // red fuel tank and nozzle
      world.fillStyle = '#ff5a1f'; world.fillRect(x - 5, y - 4 - bob, 4, 8);
      world.fillStyle = '#aaa'; world.fillRect(x - 1, y - 1 - bob, 7, 2);
      world.fillStyle = '#ffd23c'; world.fillRect(x + 5, y - 2 - bob, 2, 4);
    } else {
      world.fillStyle = p.type === 'rifle' ? '#3cd6ff' : '#ff9a3c';
      world.fillRect(x - 6, y - 2 - bob, 12, 4);
      world.fillStyle = '#222'; world.fillRect(x - 3, y + 1 - bob, 2, 3);
    }
  }
  // bullets
  for (const b of match.bullets) {
    const bx = Math.round(b.x), by = Math.round(b.y);
    if (b.w === 'missile') {
      world.fillStyle = '#8888'; world.fillRect(Math.round(b.x - b.vx * 2) - 1, Math.round(b.y - b.vy * 2) - 1, 3, 3);
      world.fillStyle = '#6664'; world.fillRect(Math.round(b.x - b.vx * 4) - 1, Math.round(b.y - b.vy * 4) - 1, 3, 3);
      world.fillStyle = (match.tick >> 1) % 2 ? '#ffb000' : '#ff5a1f'; world.fillRect(Math.round(b.x - b.vx) - 1, Math.round(b.y - b.vy) - 1, 2, 2);
      world.fillStyle = '#ddd'; world.fillRect(bx - 1, by - 1, 3, 3);
      world.fillStyle = '#ff3030'; world.fillRect(Math.round(b.x + b.vx * 0.4), Math.round(b.y + b.vy * 0.4), 1, 1);
      continue;
    }
    const col = { shotgun: ['#ffb347', '#a0601a'], rifle: ['#aef4ff', '#3cd6ff'], uzi: ['#fff3a0', '#806a20'] }[b.w] || ['#ffe14d', '#a07a10'];
    const sz = b.w === 'uzi' ? 1 : 2;
    world.fillStyle = col[0]; world.fillRect(bx - (sz >> 1), by - (sz >> 1), sz, sz);
    world.fillStyle = col[1]; world.fillRect(Math.round(b.x - b.vx * 0.5), Math.round(b.y - b.vy * 0.5), 1, 1);
    if (b.w === 'rifle') world.fillRect(Math.round(b.x - b.vx), Math.round(b.y - b.vy), 1, 1);
  }
  // fighters
  for (const f of match.fighters) {
    const c = rosterById[f.id].colour, x = f.x, y = f.y;
    if (!f.alive) {
      world.fillStyle = '#5a1010'; world.fillRect(Math.round(x) - 5, Math.round(y) - 1, 11, 3); world.fillRect(Math.round(x) - 1, Math.round(y) - 5, 3, 11);
      continue;
    }
    const flashing = hitFlash[f.id] != null && match.tick - hitFlash[f.id] <= 3 && match.tick >= hitFlash[f.id];
    if (charStyle === 'logos') { drawLogoFighter(f, c, flashing); continue; }
    world.fillStyle = '#0008'; world.beginPath(); world.arc(x + 2, y + 3, FIGHTER_R, 0, Math.PI * 2); world.fill();
    world.strokeStyle = '#ddd'; world.lineWidth = 3;
    world.beginPath(); world.moveTo(x, y); world.lineTo(x + Math.cos(f.face) * 10, y + Math.sin(f.face) * 10); world.stroke();
    world.fillStyle = flashing ? '#fff' : c; world.beginPath(); world.arc(x, y, FIGHTER_R, 0, Math.PI * 2); world.fill();
    world.strokeStyle = '#000'; world.lineWidth = 1.5; world.stroke();
    world.fillStyle = '#000'; world.fillRect(Math.round(x + Math.cos(f.face) * 3) - 1, Math.round(y + Math.sin(f.face) * 3) - 1, 2, 2);
  }
  drawFlames(match); // on top of the fighters, so a close-range burst is never hidden by the sprites
  // effects (pixel layer)
  for (const e of view ? [] : effects) { // live effects belong to the live moment, not a rewound one
    if (e.type === 'flash') { world.fillStyle = '#fff6b0'; world.fillRect(Math.round(e.x) - 2, Math.round(e.y) - 2, 4, 4); }
    if (e.type === 'p') {
      world.fillStyle = e.c; world.fillRect(Math.round(e.x), Math.round(e.y), 2, 2);
      if (!paused) { e.x += e.vx; e.y += e.vy; e.vx *= 0.9; e.vy *= 0.9; }
    }
    if (e.type === 'boom') { // blast: a fireball that grows to the exact damage radius, then the radius ring
      const k = 1 - e.life / e.max;
      world.fillStyle = `rgba(255,${Math.round(200 - 140 * k)},40,${0.55 * (1 - k)})`;
      world.beginPath(); world.arc(e.x, e.y, e.r * Math.min(1, 0.4 + k * 1.5), 0, Math.PI * 2); world.fill();
      world.strokeStyle = `rgba(255,225,77,${1 - k * 0.7})`; world.lineWidth = 1.5;
      world.beginPath(); world.arc(e.x, e.y, e.r, 0, Math.PI * 2); world.stroke();
    }
  }

  // overlay (2x): labels, pending rings, latency
  const S = 2;
  ov.clearRect(0, 0, 800, 800);
  ov.textAlign = 'center';
  const lg = charStyle === 'logos';
  const PR = lg ? 28 : 22, LY = lg ? 8 : 0; // pending ring radius and label lift, clear of the sprite
  for (const f of match.fighters) {
    if (!f.alive) continue;
    const r = rosterById[f.id], x = f.x * S, y = f.y * S, s = stats[f.id];
    // pending ring: fills while waiting for the model, red near timeout
    let frac = null;
    if (view) frac = null;
    else if (mode === 'replay') frac = replayPendingFrac(f.id);
    else if (ctl[f.id]?.pending && r.kind !== 'bot') frac = Math.min(1, (gameNow() - ctl[f.id].since) / TIMEOUT_MS);
    if (frac != null) {
      ov.strokeStyle = '#ffffff30'; ov.lineWidth = 3;
      ov.beginPath(); ov.arc(x, y, PR, 0, Math.PI * 2); ov.stroke();
      ov.strokeStyle = frac > 0.6 ? '#ff4d4d' : '#6cf'; ov.lineWidth = 4;
      ov.beginPath(); ov.arc(x, y, PR, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac); ov.stroke();
    }
    ov.font = 'bold 13px monospace';
    ov.fillStyle = '#000'; ov.fillText(shownName(f.id), x + 1, y - 31 - LY);
    ov.fillStyle = r.colour; ov.fillText(shownName(f.id), x, y - 32 - LY);
    // hp bar
    ov.fillStyle = '#300'; ov.fillRect(x - 18, y - 28 - LY, 36, 4);
    ov.fillStyle = f.hp < 35 ? '#f44' : '#4f4'; ov.fillRect(x - 18, y - 28 - LY, 36 * Math.max(0, f.hp) / MAX_HP, 4);
    ov.font = '11px monospace';
    ov.fillStyle = '#ccc';
    const act = effectiveAction(match, f);
    ov.fillText(`${act.replace('_', ' ')}  ${fmtMs(view ? viewStats?.[f.id]?.lastMs : s?.lastMs)}`, x, y + 36 + LY);
    if (f.stunned && (match.tick >> 2) % 2) { ov.font = 'bold 26px monospace'; ov.fillStyle = '#ff3b3b'; ov.fillText('!', x + 20 + LY, y - 12 - LY); }
  }
  for (const e of view ? [] : effects) {
    if (e.type === 'text') { ov.font = 'bold 12px monospace'; ov.fillStyle = '#ffe14d'; ov.fillText(e.text, e.x * S, e.y * S - (30 - e.life)); }
    if (e.type === 'banner') {
      ov.font = 'bold 34px monospace'; ov.fillStyle = '#000'; ov.fillText(e.text, 403, 83);
      ov.fillStyle = '#ffe14d'; ov.fillText(e.text, 400, 80);
    }
  }
  if (running && !paused) effects = effects.filter((e) => --e.life > 0);
  if (celebrate) drawCelebration(performance.now());
  else if (match.over && !running) {
    ov.font = 'bold 30px monospace'; ov.fillStyle = '#ffe14d';
    ov.fillText(match.fighters.every((f) => !f.alive) ? 'ALL DOWN' : `${shownName(match.winner)} WINS`, 400, 400);
  }
  if (paused && !view) { // while viewing, the bar under the arena says it instead
    ov.fillStyle = 'rgba(0,0,0,0.6)'; ov.fillRect(300, 740, 200, 44); // bottom, clear of the banners at the top
    ov.strokeStyle = '#ffe14d'; ov.lineWidth = 3; ov.strokeRect(300, 740, 200, 44);
    ov.font = 'bold 30px monospace'; ov.fillStyle = (Math.floor(performance.now() / 600) % 2) ? '#ffe14d' : '#fff';
    ov.fillText('PAUSED', 400, 773);
  }
}

// Flamethrower bursts, drawn from sim state so a paused frame keeps its flames.
// The flicker is seeded by the tick, not Math.random, so it freezes with the game.
function drawFlames(match) {
  const W = match.W.flamethrower, reach = W.range + FIGHTER_R;
  for (const f of match.fighters) {
    if (!f.alive || f.flame <= 0) continue;
    world.fillStyle = 'rgba(255,110,20,0.38)';
    world.beginPath(); world.moveTo(f.x, f.y);
    world.arc(f.x, f.y, reach, f.face - W.cone, f.face + W.cone); world.closePath(); world.fill();
    const rnd = makeRng(match.tick * 131 + f.i * 7919);
    for (let k = 0; k < 40; k++) {
      const d = 9 + rnd() * (reach - 9), a = f.face + (rnd() * 2 - 1) * W.cone * (0.4 + 0.6 * d / reach);
      const t = d / reach;
      world.fillStyle = t < 0.35 ? '#fff3a0' : t < 0.7 ? '#ffb000' : '#ff4a1a';
      world.fillRect(Math.round(f.x + Math.cos(a) * d), Math.round(f.y + Math.sin(a) * d), 2, 2);
    }
  }
}

// ---------- Weapons dialog
const PARAM_COLS = [['dmg'], ['cd'], ['life', 'range'], ['ammo'], ['pellets', 'blast', 'burst']];
function renderWeapons() {
  const head = '<tr><th>On</th><th>Weapon</th><th>Damage</th><th>Cooldown (ticks)</th><th>Bullet life / range</th><th>Ammo</th><th>Extra</th></tr>';
  const rows = WEAPON_NAMES.map((w) => {
    const c = weaponCfg[w], P = WEAPON_PARAMS[w];
    const cell = (keys) => {
      const k = keys.find((x) => P.includes(x));
      if (!k) return `<td class="dim">${keys[0] === 'ammo' && w === 'pistol' ? 'unlimited' : ''}</td>`;
      const b = paramBounds(w, k), def = WEAPON_DEFAULTS[w][k];
      const lbl = k === 'dmg' && w === 'flamethrower' ? 'dmg per tick'
        : { life: 'life', range: 'range', pellets: 'pellets', blast: 'blast', burst: 'burst' }[k];
      return `<td><div class="weapon-value"><input type="number" data-w="${w}" data-k="${k}" min="${b.min}" max="${b.max}" step="1" value="${c[k]}" title="${b.label}: ${b.min} to ${b.max}, default ${def}"> <span class="dim${c[k] !== def ? ' changed' : ''}">(${def})</span>${lbl ? ` <span class="dim caption">${lbl}</span>` : ''}</div></td>`;
    };
    const tick = `<input type="checkbox" data-w="${w}" data-k="on" ${c.on ? 'checked' : ''} ${w === 'pistol' ? 'disabled title="The pistol is the fallback weapon and is always on"' : ''}>`;
    return `<tr class="${c.on ? '' : 'off'}"><td>${tick}</td><td>${w}</td>${PARAM_COLS.map(cell).join('')}</tr>`;
  }).join('');
  $('wpnTable').innerHTML = head + rows;
  const help = { density: 'Share of pickup spots filled at the start (0 = none, 1 = every spot, 2 = extra spots). Chosen from the seed, the same in every slot; unfilled spots stay empty.',
    respawn: 'How fast a taken pickup comes back (1 = 15 s, 0.5 = 30 s, 0 = never).' };
  $('wpnPickups').innerHTML = Object.entries(PICKUP_PARAMS).map(([k, b]) => {
    const v = weaponCfg.pickups[k], def = DEFAULT_PICKUPS[k];
    return `<div class="pk"><label><span>${b.label}</span> <input type="number" data-p="${k}" min="${b.min}" max="${b.max}" step="${b.step}" value="${v}" title="${b.min} to ${b.max}, step ${b.step}, default ${def}"> <span class="dim${v !== def ? ' changed' : ''}">(${def})</span></label> <span class="dim">${help[k]}</span></div>`;
  }).join('');
  $('wpnSummary').textContent = `Active: ${configSummary(weaponCfg)}  (config ${configId(weaponCfg)})`;
  for (const el of $('wpnTable').querySelectorAll('input')) el.onchange = readWeapons;
  for (const el of $('wpnPickups').querySelectorAll('input')) el.onchange = readWeapons;
}
function readWeapons() {
  const c = JSON.parse(JSON.stringify(weaponCfg));
  for (const el of $('wpnTable').querySelectorAll('input')) {
    const { w, k } = el.dataset;
    c[w][k] = k === 'on' ? el.checked : el.value;
  }
  for (const el of $('wpnPickups').querySelectorAll('input')) c.pickups[el.dataset.p] = el.value;
  setWeaponCfg(c); // clamps out-of-range values; the redraw shows what was kept
  renderWeapons();
}

// ---------- Leaderboard dialog (all-time, stored by the server in data/leaderboard.json)
let lbData = null;
let lbSort = null; // { key, dir }: dir 1 = descending; null = default order (wins, then average place)
const fmtUsd = (v, est) => (v == null ? '-' : `${est ? '<span class="dim" title="Includes estimated cost">~</span>' : ''}$${v > 0 ? v.toFixed(Math.min(10, Math.max(4, 2 - Math.floor(Math.log10(v))))) : '0'}`); // 3 significant figures below $0.01
// Numeric columns start descending, except avg place and latency/errors/cost where lower is better.
const LB_COLS = [['played', 'Played'], ['wins', 'Wins'], ['winRate', 'Win rate'], ['avgPlace', 'Avg place', -1], ['avgSurvivalS', 'Avg survival'],
  ['kills', 'Kills'], ['damage', 'Damage'], ['meanMs', 'Mean latency', -1], ['errors', 'Errors', -1], ['timeouts', 'Timeouts', -1],
  ['totalCost', 'Total cost', -1], ['avgCostGame', 'Avg cost / game', -1], ['costPerCall', 'Avg cost / request', -1]];
async function openLeaderboard() {
  $('lbModal').classList.add('show');
  $('lbBody').innerHTML = '<p class="dim">Loading...</p>';
  try {
    const r = await fetch('/api/leaderboard');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    lbData = await r.json();
  } catch (e) {
    lbData = null;
    $('lbBody').innerHTML = `<p class="bad">Leaderboard unavailable (${e.message}). Restart the server to enable it.</p>`;
    return;
  }
  renderLeaderboard();
}
const fighterCell = (fighter) => {
  const f = typeof fighter === 'string' ? { id: fighter } : fighter;
  if (!f) return '-';
  const id = f.slotId || f.id;
  const r = Object.hasOwn(rosterById, id) ? rosterById[id] : null;
  if (!r) return esc(f.model || f.id);
  const identity = recordFighterIdentity(f);
  return `<span style="color:${r.colour}"><img class="sprite rs" alt="" src="${spriteDataUrl(identity.iconId, 24)}">${esc(identity.name)}</span>`;
};
function renderLeaderboard() {
  if (!lbData) return;
  const opts = { includeMock: lbIncludeMock, cfgId: lbCurrentOnly ? configId(weaponCfg) : null };
  const recs = filterRecords(lbData.matches, opts);
  const all = aggregate(lbData.matches, opts);
  const topKills = mostKillsIds(all);
  const rows = lbSort ? sortStandings(all, lbSort.key, lbSort.dir) : all;
  if (!recs.length) {
    $('lbBody').innerHTML = `<p class="dim">No ${lbIncludeMock ? '' : 'live '}matches recorded${lbCurrentOnly ? ' with the current weapons' : ''} yet.</p>`;
    return;
  }
  const t = rows.map((a, i) => `<tr><td>${i + 1}</td><td>${fighterCell(a)}${topKills.includes(a.id) ? ' <span class="lbBadge" title="Most total kills">most kills</span>' : ''}</td><td>${esc(a.played)}</td><td>${esc(a.wins)}</td>
    <td>${Math.round(a.winRate * 100)}%</td><td>${a.avgPlace.toFixed(2)}</td><td>${a.avgSurvivalS.toFixed(1)} s</td>
    <td${topKills.includes(a.id) ? ' class="lbTop"' : ''}>${esc(a.kills)}</td><td>${esc(a.damage)}</td><td>${esc(fmtMs(a.meanMs))}</td><td>${esc(a.errors)}</td><td>${esc(a.timeouts)}</td>
    <td>${fmtUsd(a.totalCost, a.costEst)}</td><td>${fmtUsd(a.avgCostGame, a.costEst)}</td><td>${fmtUsd(a.costPerCall, a.costEst)}</td></tr>`).join('');
  const recent = [...recs].reverse().slice(0, 12).map((m) => `<tr><td>${new Date(m.ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</td>
    <td>${fighterCell(m.fighters.find((f) => f.id === m.winner))} <span class="dim">${esc(m.note)}</span></td><td>${esc(m.mode)}</td><td>${Number(m.fighters?.length) || 0}</td><td>${esc(m.seed)}</td>
    <td class="dim" title="${esc(m.cfgSummary)}">${esc(m.cfgId)} (${m.modelAims ? 'aims ON' : 'aims OFF'})</td></tr>`).join('');
  $('lbBody').innerHTML = `<p class="dim">${recs.length} match${recs.length === 1 ? '' : 'es'}${lbIncludeMock ? ', live and mock' : ', live only'}${lbCurrentOnly ? `, weapons ${configId(weaponCfg)}` : ', all weapon configs'}. Cost: ~ includes estimates; per request = total cost / requests sent; matches recorded before cost tracking show -.</p>
    <table id="lbTable"><tr><th>#</th><th>Fighter</th>${LB_COLS.map(([k, n]) => `<th class="lbSort" data-k="${k}" title="Sort by ${n}">${n}${lbSort?.key === k ? (lbSort.dir === 1 ? ' &#9660;' : ' &#9650;') : ''}</th>`).join('')}</tr>${t}</table>
    <h3>Recent matches</h3>
    <table id="lbRecent"><tr><th>When</th><th>Winner</th><th>Mode</th><th>Fighters</th><th>Seed</th><th>Weapons</th></tr>${recent}</table>`;
  const aims = recs.filter((m) => m.modelAims);
  if (aims.length) {
    const key = (f) => f.model && f.model !== rosterById[f.id]?.model ? f.model : f.id;
    const fighters = [...new Map(aims.flatMap((m) => m.fighters.map((f) => [key(f), f]))).values()];
    const choices = (shooter, target) => aims.reduce((n, m) => {
      const sf = m.fighters.find((f) => key(f) === key(shooter));
      const tf = m.fighters.find((f) => key(f) === key(target));
      return n + (sf && tf ? Number(sf.targetsChosen?.[tf.id]) || 0 : 0);
    }, 0);
    $('lbBody').insertAdjacentHTML('beforeend', `<h3>Who targets whom (choices)</h3><table id="lbTargets"><tr><th>Shooter / target</th>${fighters.map((f) => `<th>${fighterCell(f)}</th>`).join('')}</tr>${fighters.map((f) => `<tr><th>${fighterCell(f)}</th>${fighters.map((target) => `<td>${key(f) === key(target) ? '-' : esc(choices(f, target))}</td>`).join('')}</tr>`).join('')}</table>`);
  }
  document.querySelectorAll('#lbTable th.lbSort').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k, first = LB_COLS.find((c) => c[0] === k)[2] ?? 1;
      lbSort = lbSort?.key === k ? { key: k, dir: -lbSort.dir } : { key: k, dir: first };
      renderLeaderboard();
    };
  });
}
async function resetLeaderboard() {
  if (!confirm('Reset the all-time leaderboard? This clears every recorded match (a backup file is kept on the server).')) return;
  try {
    const r = await fetch('/api/leaderboard/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: 'RESET' }) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    toast('Leaderboard reset');
    openLeaderboard();
  } catch (e) { toast(`Reset failed: ${e.message}`); }
}

// ---------- boot
buildHeader();
refreshStatus();
setInterval(refreshStatus, 5000);
requestAnimationFrame(frame);
updateControls();
if (params.get('autostart') === '1' && mode !== 'live') setTimeout(start, 300); // for kiosk demos and headless screenshots
window.__arena = { get weapons() { return weaponCfg; }, get match() { return match; }, get log() { return lastLog; }, get liveLog() { return log; }, get mode() { return mode; },
  get running() { return running; }, get countingDown() { return countdown.active; }, get paused() { return paused; }, get celebrating() { return Boolean(celebrate); }, get roster() { return roster; }, get queued() { return queue.length; },
  get view() { return view; }, get viewMatch() { return viewMatch; }, get history() { return hist; } };
