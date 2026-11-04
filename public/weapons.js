// Weapon numbers and the per-match weapon config (which weapons spawn, and their tuned values).
// Shared by the sim, the rules text, the proxy and the Weapons dialog. Pure, no DOM.

// Bullet range = speed * life (bullets vanish at their range). The flamethrower has no bullets:
// a shot starts a burst that hurts everyone in a short cone in front for `burst` ticks.
// Its ammo counts bursts (fuel). The missile explodes on impact or at its range, within `blast`.
export const WEAPONS = {
  pistol: { dmg: 4, cd: 15, pellets: 1, spread: 0.12, speed: 7, life: 35, ammo: Infinity },
  shotgun: { dmg: 5, cd: 21, pellets: 3, spread: 0.2, speed: 7, life: 12, ammo: 6 },
  rifle: { dmg: 15, cd: 30, pellets: 1, spread: 0.02, speed: 11, life: 40, ammo: 5 },
  uzi: { dmg: 2, cd: 4, pellets: 1, spread: 0.3, speed: 8, life: 18, ammo: 30 },
  missile: { dmg: 32, cd: 60, pellets: 1, spread: 0.03, speed: 3.5, life: 44, ammo: 2, blast: 28 },
  flamethrower: { dmg: 1, cd: 18, burst: 12, range: 36, cone: 0.45, ammo: 4 },
};
export const WEAPON_NAMES = Object.keys(WEAPONS);

// What the dialog lets you tune, with sane bounds. Integers only. Label is the column heading.
export const TUNABLE = {
  dmg: { label: 'Damage', min: 1, max: 100 },
  cd: { label: 'Cooldown (ticks)', min: 2, max: 300 },
  life: { label: 'Bullet life (ticks)', min: 2, max: 120 },
  range: { label: 'Range', min: 10, max: 120 },
  ammo: { label: 'Ammo', min: 1, max: 200 },
  pellets: { label: 'Pellets', min: 1, max: 12 },
  blast: { label: 'Blast radius', min: 5, max: 80 },
  burst: { label: 'Burst (ticks)', min: 1, max: 60 },
};
export const WEAPON_PARAMS = {
  pistol: ['dmg', 'cd', 'life'], // unlimited ammo, always on (the fallback weapon)
  shotgun: ['dmg', 'cd', 'life', 'ammo', 'pellets'],
  rifle: ['dmg', 'cd', 'life', 'ammo'],
  uzi: ['dmg', 'cd', 'life', 'ammo'],
  missile: ['dmg', 'cd', 'life', 'ammo', 'blast'],
  flamethrower: ['dmg', 'cd', 'range', 'ammo', 'burst'], // dmg is per tick
};
const BOUNDS_OVERRIDE = { flamethrower: { dmg: { min: 1, max: 10 } } };
export function paramBounds(w, k) { return { ...TUNABLE[k], ...(BOUNDS_OVERRIDE[w]?.[k] || {}) }; }

function base(on) {
  const c = {};
  for (const w of WEAPON_NAMES) {
    c[w] = { on };
    for (const k of WEAPON_PARAMS[w]) c[w][k] = WEAPONS[w][k];
  }
  return c;
}
// Pickup knobs, stored in the same config. density scales how many pickup spots are filled at the
// start (0 = none, 2 = double); respawn scales how fast a taken pickup comes back (0 = never).
// The original behaviour is 1 and 1: a config or log without these fields means exactly that.
export const PICKUP_PARAMS = {
  density: { label: 'Starting pickup density', min: 0, max: 2, step: 0.25 },
  respawn: { label: 'Respawn rate', min: 0, max: 3, step: 0.25 },
};
export const ORIGINAL_PICKUPS = { density: 1, respawn: 1 };
export const DEFAULT_PICKUPS = { density: 0.75, respawn: 1 };
const isOriginalPickups = (p) => p.density === 1 && p.respawn === 1;

// The game default: every weapon on except the flamethrower, and a sparser start than the original.
export const DEFAULT_WEAPON_CONFIG = (() => { const c = base(true); c.flamethrower.on = false; c.pickups = { ...DEFAULT_PICKUPS }; return c; })();
// Logs recorded before configs existed had every weapon on at the default numbers.
export const LEGACY_WEAPON_CONFIG = (() => { const c = base(true); c.pickups = { ...ORIGINAL_PICKUPS }; return c; })();

// Validate and clamp anything (localStorage, a log file, a request body) into a full config.
// Unknown keys are dropped, missing or junk values fall back to the default, the pistol is always on.
export function normaliseWeapons(input, fallback = DEFAULT_WEAPON_CONFIG) {
  const src = input && typeof input === 'object' ? input : {};
  const out = {};
  for (const w of WEAPON_NAMES) {
    const s = src[w] && typeof src[w] === 'object' ? src[w] : {};
    out[w] = { on: w === 'pistol' ? true : typeof s.on === 'boolean' ? s.on : fallback[w].on };
    for (const k of WEAPON_PARAMS[w]) {
      const { min, max } = paramBounds(w, k);
      const n = Number(s[k]);
      out[w][k] = Number.isFinite(n) && s[k] !== null && s[k] !== '' ? Math.min(max, Math.max(min, Math.round(n))) : fallback[w][k];
    }
  }
  // Pickups: clamped and snapped to the step. Missing means the original behaviour (1), never the
  // current default, so a log or request from before these knobs existed keeps meaning what it meant.
  const sp = src.pickups && typeof src.pickups === 'object' ? src.pickups : {};
  out.pickups = {};
  for (const [k, { min, max, step }] of Object.entries(PICKUP_PARAMS)) {
    const n = Number(sp[k]);
    out.pickups[k] = Number.isFinite(n) && sp[k] !== null && sp[k] !== '' ? Math.min(max, Math.max(min, Math.round(n / step) * step)) : ORIGINAL_PICKUPS[k];
  }
  if (src.modelAims === true) out.modelAims = true;
  return out;
}

// Full per-weapon numbers for the sim: the base table with the config's values on top.
export function weaponTable(cfg) {
  const t = {};
  for (const w of WEAPON_NAMES) {
    t[w] = { ...WEAPONS[w] };
    for (const k of WEAPON_PARAMS[w]) t[w][k] = cfg[w][k];
  }
  return t;
}
export function enabledWeapons(cfg) { return WEAPON_NAMES.filter((w) => cfg[w].on); }

// Short stable id for a config (FNV-1a over its canonical JSON). Same config, same id, any machine.
export function configId(cfg) {
  const parts = WEAPON_NAMES.map((w) => [w, cfg[w].on, ...WEAPON_PARAMS[w].map((k) => cfg[w][k])]);
  // pickups only count when they differ from the original, so ids from before they existed are unchanged
  const p = cfg.pickups || ORIGINAL_PICKUPS;
  if (!isOriginalPickups(p)) parts.push(['pickups', p.density, p.respawn]);
  if (cfg.modelAims) parts.push(['modelAims', true]);
  const s = JSON.stringify(parts);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}
// Human summary: the enabled weapons, then any number that differs from the default.
export function configSummary(cfg) {
  const changed = [];
  for (const w of WEAPON_NAMES) {
    if (!cfg[w].on) continue;
    for (const k of WEAPON_PARAMS[w]) if (cfg[w][k] !== WEAPONS[w][k]) changed.push(`${w} ${k} ${cfg[w][k]}`);
  }
  const on = enabledWeapons(cfg).join(', ');
  const p = cfg.pickups || ORIGINAL_PICKUPS;
  const pk = isOriginalPickups(p) ? '' : `; pickups x${p.density}, ${p.respawn ? `respawn x${p.respawn}` : 'no respawn'}`;
  return (changed.length ? `${on}; tuned: ${changed.join(', ')}` : on) + pk + (cfg.modelAims ? '; model aims ON' : '; model aims OFF');
}
