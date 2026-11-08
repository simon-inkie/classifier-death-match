// Retro sound, fully synthesised with the Web Audio API. No audio files.
// Presentation only: nothing here reads or writes simulation state, so replays,
// logs and state hashes are unaffected. game.js calls these from sim events
// and render-loop state changes.
//
// Autoplay rules: the AudioContext is created (or resumed) on the first click or
// key press. Before that every call is counted but silent.

const STORE_KEY = 'arenaSound';
// Voice counts are sounding source nodes (a shot is 2 or 3). Gunfire, hits, pings and blips
// are refused once the mix is busy; big moments (death, pickups, ring, jingle, fanfare) are
// rare and always get through, up to a safety ceiling.
const MAX_VOICES = 16;
const HARD_VOICES = 48;
const BLIP_VOICES = 6;        // blips are dropped first when the mix is busy

// Minimum real-time gap per sound key (ms). Keys include the fighter where it matters,
// so 8x replay thins out to a readable rhythm instead of a wall of noise.
const GAP = { shot: 70, hit: 55, ping: 60, pickup: 90, death: 120, blip: 70, buzz: 160, ring: 100, start: 500, win: 800, boom: 90 };

// One voice per decider, so you can hear who answered.
const BLIP = {
  jev: { type: 'sine', f: 1568, vol: 0.05 },
  luna: { type: 'triangle', f: 1175, vol: 0.05 },
  laya: { type: 'square', f: 880, vol: 0.022 },
  scaledown: { type: 'sine', f: 784, vol: 0.05 },
  gemini: { type: 'sawtooth', f: 587, vol: 0.026 },
  bot: { type: 'square', f: 330, vol: 0.02 },
};

const load = () => { try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; } };
const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(prefs)); } catch {} };
const saved = load();
const prefs = {
  enabled: saved.enabled !== false,
  volume: typeof saved.volume === 'number' ? Math.max(0, Math.min(1, saved.volume)) : 0.6,
  music: saved.music === true, // music is off by default
};

let ctx = null, master = null, sfxBus = null, musicBus = null, noiseBuf = null;
let voices = 0, blipVoices = 0, musicVoices = 0;
const lastAt = new Map();
const listeners = new Set();

// Counters for headless checks and debugging: requested, actually voiced, rate-limited, silent (no context).
export const stats = { requested: {}, played: {}, limited: {}, silent: {}, byKind: {}, peakVoices: 0, started: 0, ended: 0 };
const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };

export function getPrefs() { return { ...prefs }; }
export function contextState() { return ctx ? ctx.state : 'none'; }
export function needsGesture() { return prefs.enabled && (!ctx || ctx.state !== 'running'); }
export function onChange(fn) { listeners.add(fn); }
const notify = () => { for (const fn of listeners) { try { fn(); } catch {} } };

function gainValue() { return prefs.enabled ? prefs.volume * prefs.volume * 0.9 : 0; } // squared feels linear to the ear

function build() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return false;
  ctx = new AC();
  master = ctx.createGain(); master.gain.value = gainValue();
  // gentle limiter so stacked gunfire never clips
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14; comp.knee.value = 8; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.12;
  master.connect(comp); comp.connect(ctx.destination);
  sfxBus = ctx.createGain(); sfxBus.gain.value = 1; sfxBus.connect(master);
  musicBus = ctx.createGain(); musicBus.gain.value = 0.32; musicBus.connect(master);
  // one shared second of white noise, reused by every noisy sound
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  ctx.onstatechange = () => { notify(); if (ctx.state === 'running' && prefs.music && prefs.enabled) startMusic(); };
  return true;
}

// Call from any user gesture. Safe to call often.
export function unlock() {
  if (!prefs.enabled) return;
  if (!ctx && !build()) return;
  if (ctx.state === 'suspended') ctx.resume().catch(() => {}).finally(notify);
  else if (prefs.music) startMusic();
  notify();
}

export function setEnabled(on) {
  prefs.enabled = on; save();
  if (on) unlock();
  if (master) master.gain.setTargetAtTime(gainValue(), ctx.currentTime, 0.02);
  if (!on) stopMusic(); else if (prefs.music) startMusic();
  notify();
}
export function setVolume(v) {
  prefs.volume = Math.max(0, Math.min(1, v)); save();
  if (master) master.gain.setTargetAtTime(gainValue(), ctx.currentTime, 0.02);
  notify();
}
export function setMusic(on) {
  prefs.music = on; save();
  if (on) { unlock(); startMusic(); } else stopMusic();
  notify();
}

const ready = () => ctx && ctx.state === 'running' && prefs.enabled && prefs.volume > 0 && !document.hidden;

// Rate limit + voice cap. Returns true if this sound may play now.
function admit(name, key, prio = 1) {
  bump(stats.requested, name);
  const now = performance.now();
  const k = key || name;
  if (now - (lastAt.get(k) ?? -1e9) < (GAP[name] ?? 60)) { bump(stats.limited, name); return false; }
  if (!ready()) { bump(stats.silent, name); return false; }
  const cap = prio >= 2 ? HARD_VOICES : MAX_VOICES;
  if (voices >= cap || (name === 'blip' && (blipVoices >= BLIP_VOICES || voices >= MAX_VOICES - 4))) {
    bump(stats.limited, name); return false;
  }
  lastAt.set(k, now);
  bump(stats.played, name);
  return true;
}

// Count a voice until its source ends, then disconnect its whole chain. The guard makes a
// repeated 'ended' event harmless (seen once in headless Chromium), so the count never drifts.
// Music notes are counted separately and never take a slot from the effects.
function track(src, chain, kind) {
  if (kind === 'music') musicVoices++; else { voices++; if (kind === 'blip') blipVoices++; }
  stats.started++;
  if (voices > stats.peakVoices) stats.peakVoices = voices;
  let done = false;
  src.onended = () => {
    if (done) return;
    done = true;
    if (kind === 'music') musicVoices--; else { voices--; if (kind === 'blip') blipVoices--; }
    stats.ended++;
    for (const n of chain) n.disconnect();
  };
}

// ---------- primitives (oscillators are one-shot by spec; each is disconnected when it ends)
function tone({ type = 'square', f0, f1 = f0, dur = 0.1, vol = 0.1, at = 0, attack = 0.003, bus = sfxBus, blip = false, steps = 0 }) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type;
  if (steps > 0) { // stepped pitch, for a crunchy 8-bit slide
    for (let i = 0; i <= steps; i++) o.frequency.setValueAtTime(f0 * Math.pow(f1 / f0, i / steps), t + (dur * i) / steps);
  } else {
    o.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  }
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(bus);
  track(o, [o, g], bus === musicBus ? 'music' : blip ? 'blip' : 'sfx');
  o.start(t); o.stop(t + dur + 0.02);
}

function noise({ dur = 0.1, vol = 0.1, at = 0, filter = 'lowpass', f0 = 2000, f1 = f0, q = 0.8, bus = sfxBus }) {
  const t = ctx.currentTime + at;
  const s = ctx.createBufferSource(), fl = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf;
  s.loop = true; // stop() ends it; a random offset keeps repeats from sounding identical
  fl.type = filter; fl.Q.value = q;
  fl.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) fl.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(fl); fl.connect(g); g.connect(bus);
  track(s, [s, fl, g], bus === musicBus ? 'music' : 'sfx');
  s.start(t, Math.random() * 0.5); s.stop(t + dur + 0.02);
}

const C4 = 261.63, note = (n) => C4 * Math.pow(2, n / 12); // n semitones from middle C

// ---------- sound effects
export const sfx = {
  countdown(fight = false) {
    if (!admit('countdown', 'countdown', 2)) return;
    tone({ type: 'square', f0: fight ? 1480 : 740, dur: fight ? 0.2 : 0.1, vol: 0.08 });
  },
  shot(weapon, fid) {
    bump(stats.byKind, `shot:${weapon}`);
    if (!admit('shot', `shot:${fid}`)) return;
    if (weapon === 'uzi') { // tight, high rattle; fires fast so each shot is tiny
      noise({ dur: 0.025, vol: 0.12, filter: 'highpass', f0: 3500 });
      tone({ type: 'square', f0: 1300, f1: 500, dur: 0.035, vol: 0.05 });
    } else if (weapon === 'missile') { // launch thump then a rising whoosh
      tone({ type: 'square', f0: 110, f1: 55, dur: 0.12, vol: 0.12 });
      noise({ dur: 0.45, vol: 0.16, filter: 'bandpass', f0: 500, f1: 2600, q: 2 });
      tone({ type: 'sawtooth', f0: 220, f1: 660, dur: 0.4, vol: 0.04 });
    } else if (weapon === 'flamethrower') { // low roaring burst for the length of the burst
      noise({ dur: 0.42, vol: 0.26, filter: 'lowpass', f0: 900, f1: 400, q: 0.5 });
      noise({ dur: 0.38, vol: 0.08, filter: 'bandpass', f0: 2200, q: 0.8 });
    } else if (weapon === 'shotgun') {
      noise({ dur: 0.2, vol: 0.32, filter: 'lowpass', f0: 2600, f1: 260 });
      tone({ type: 'square', f0: 150, f1: 50, dur: 0.14, vol: 0.12 });
    } else if (weapon === 'rifle') {
      noise({ dur: 0.05, vol: 0.22, filter: 'highpass', f0: 3000 });
      tone({ type: 'sawtooth', f0: 1500, f1: 80, dur: 0.26, vol: 0.13 });
      tone({ type: 'square', f0: 95, f1: 45, dur: 0.18, vol: 0.09 });
    } else {
      tone({ type: 'square', f0: 900, f1: 240, dur: 0.07, vol: 0.09 });
      noise({ dur: 0.03, vol: 0.06, filter: 'bandpass', f0: 2500, q: 1.2 });
    }
  },
  hit(fid) {
    if (!admit('hit', `hit:${fid}`)) return;
    tone({ type: 'square', f0: 240, f1: 90, dur: 0.08, vol: 0.1 });
    noise({ dur: 0.05, vol: 0.12, filter: 'bandpass', f0: 900, q: 1.5 });
  },
  boom() { // missile explosion: deep drop plus a long rumble
    if (!admit('boom', 'boom', 2)) return;
    tone({ type: 'square', f0: 180, f1: 30, dur: 0.5, vol: 0.16, steps: 10 });
    noise({ dur: 0.8, vol: 0.4, filter: 'lowpass', f0: 2400, f1: 80 });
    noise({ dur: 0.12, vol: 0.18, filter: 'highpass', f0: 2500 });
  },
  ping(kind) { // bullet hits a pillar ('spark') or the outer wall ('wall')
    if (!admit('ping', `ping:${kind}`)) return;
    const f = kind === 'wall' ? 1250 : 1900;
    tone({ type: 'triangle', f0: f, f1: f * 0.85, dur: 0.09, vol: kind === 'wall' ? 0.035 : 0.05 });
  },
  pickup(kind, fid) {
    if (!admit('pickup', `pickup:${fid}`, 2)) return;
    if (kind === 'medpack') { // rising arpeggio
      [0, 4, 7, 12, 16].forEach((n, i) => tone({ type: 'triangle', f0: note(12 + n), dur: 0.09, vol: 0.12, at: i * 0.055 }));
    } else { // weapon: mechanical clack then a bright double note
      noise({ dur: 0.04, vol: 0.12, filter: 'highpass', f0: 1800 });
      tone({ type: 'square', f0: note(7), dur: 0.06, vol: 0.07, at: 0.04 });
      tone({ type: 'square', f0: note(19), dur: 0.1, vol: 0.07, at: 0.1 });
    }
  },
  death(fid) { // descending crunch
    if (!admit('death', `death:${fid}`, 2)) return;
    tone({ type: 'square', f0: 520, f1: 40, dur: 0.6, vol: 0.13, steps: 14 });
    tone({ type: 'sawtooth', f0: 260, f1: 30, dur: 0.55, vol: 0.08, steps: 9 });
    noise({ dur: 0.7, vol: 0.28, filter: 'lowpass', f0: 3000, f1: 120 });
  },
  ringBeep() { // countdown before the ring closes
    if (!admit('ring', 'ring:beep', 2)) return;
    tone({ type: 'square', f0: 988, dur: 0.12, vol: 0.07 });
  },
  ringWarn() { // two-tone siren when the ring starts to shrink
    if (!admit('ring', 'ring:warn', 2)) return;
    for (let i = 0; i < 6; i++) tone({ type: 'square', f0: i % 2 ? 494 : 740, dur: 0.15, vol: 0.08, at: i * 0.16 });
  },
  start() { // match start jingle
    if (!admit('start', 'start', 2)) return;
    const seq = [[7, 0.08], [12, 0.08], [16, 0.08], [19, 0.08], [24, 0.32]];
    let at = 0;
    for (const [n, d] of seq) { tone({ type: 'square', f0: note(n), dur: d + 0.03, vol: 0.09, at }); at += d; }
    tone({ type: 'triangle', f0: note(-12), dur: 0.6, vol: 0.12, at: 0.32 });
    noise({ dur: 0.12, vol: 0.08, filter: 'highpass', f0: 5000, at: 0.32 });
  },
  win() { // victory fanfare
    if (!admit('win', 'win', 2)) return;
    const lead = [[12, 0.11], [12, 0.11], [12, 0.11], [12, 0.38], [8, 0.38], [10, 0.38], [12, 0.2], [10, 0.1], [12, 0.7]];
    let at = 0.3; // let the final death crunch land first
    for (const [n, d] of lead) {
      tone({ type: 'square', f0: note(n), dur: d * 0.95, vol: 0.09, at });
      tone({ type: 'square', f0: note(n - 5), dur: d * 0.95, vol: 0.04, at });
      at += d;
    }
    for (const [n, t0, d] of [[-12, 0.3, 0.71], [-16, 1.01, 0.38], [-14, 1.39, 0.38], [-12, 1.77, 1.0]]) {
      tone({ type: 'triangle', f0: note(n), dur: d, vol: 0.13, at: t0 });
    }
  },
  blip(fid) { // quiet: a fighter's answer arrived
    const b = BLIP[fid]; if (!b) return;
    bump(stats.byKind, `blip:${fid}`);
    if (!admit('blip', `blip:${fid}`)) return;
    tone({ type: b.type, f0: b.f, f1: b.f * 1.02, dur: 0.035, vol: b.vol, blip: true });
  },
  buzz(fid) { // timeout or error: low stun buzz
    if (!admit('buzz', `buzz:${fid}`)) return;
    tone({ type: 'sawtooth', f0: 72, f1: 60, dur: 0.2, vol: 0.07 });
    tone({ type: 'square', f0: 76, f1: 62, dur: 0.2, vol: 0.045 });
  },
};

// ---------- chiptune loop (lookahead scheduler, A minor, 16 steps per bar)
const BPM = 138, STEP = 60 / BPM / 4;
const BASS = [[-15, -15, -3, -15], [-19, -19, -7, -19], [-14, -14, -2, -14], [-17, -17, -5, -17]]; // Am F Dm G, as 8ths
const ARP = [[9, 12, 16], [5, 9, 12], [2, 5, 9], [7, 11, 14]];
let musicTimer = null, nextTime = 0, stepIdx = 0;

function scheduleStep(i, t) {
  const bar = Math.floor(i / 16) % 4, s = i % 16, at = t - ctx.currentTime;
  if (s % 2 === 0) tone({ type: 'triangle', f0: note(BASS[bar][(s / 2) % 4]), dur: STEP * 1.8, vol: 0.22, at, bus: musicBus, attack: 0.005 });
  const arp = ARP[bar];
  tone({ type: 'square', f0: note(arp[s % 3] + (s >= 8 ? 12 : 0)), dur: STEP * 0.7, vol: 0.05, at, bus: musicBus });
  if (s % 4 === 2) noise({ dur: 0.04, vol: 0.06, filter: 'highpass', f0: 7000, at, bus: musicBus });
  if (s % 8 === 4) noise({ dur: 0.09, vol: 0.09, filter: 'bandpass', f0: 1800, q: 0.7, at, bus: musicBus });
}

function startMusic() {
  if (musicTimer || !ctx || ctx.state !== 'running' || !prefs.enabled || !prefs.music) return;
  nextTime = ctx.currentTime + 0.08; stepIdx = 0;
  musicTimer = setInterval(() => {
    if (!ctx || ctx.state !== 'running') return;
    if (nextTime < ctx.currentTime - 0.2) nextTime = ctx.currentTime + 0.05; // resync after a throttled tab
    while (nextTime < ctx.currentTime + 0.15) {
      scheduleStep(stepIdx++, nextTime);
      nextTime += STEP;
      bump(stats.played, 'musicStep');
    }
  }, 30);
}
function stopMusic() { clearInterval(musicTimer); musicTimer = null; }

// First gesture anywhere unlocks audio (capture phase, so it runs before the game's own handlers).
for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.addEventListener(ev, unlock, { capture: true, passive: true });

window.__arenaAudio = { stats, getPrefs, contextState, get voices() { return voices; }, get musicVoices() { return musicVoices; }, get musicOn() { return Boolean(musicTimer); } };
