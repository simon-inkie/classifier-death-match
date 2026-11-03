// Deterministic arena simulation. Fixed 30 Hz, seeded PRNG, no wall clock.
// Same seed + same tick-keyed action log => identical match, in browser or Node.

export const TICK_HZ = 30;
export const MATCH_TICKS = 90 * TICK_HZ;
export const RING_START = 60 * TICK_HZ;
export const CENTRE = 200;
export const ARENA_R = 190;
export const RING_MIN = 36;
export const PILLAR_R = 15;
export const FIGHTER_R = 6;
export const SPEED = 1.8;
export const ACTION_HOLD_TICKS = 9; // keep last action ~300 ms while a call is pending, then stand still
export const PICKUP_R = 7;
export const PICKUP_RESPAWN = 15 * TICK_HZ;
export const MEDPACK_HP = 35;
export const MAX_HP = 100;

export const RING_DPS = 10; // 1 HP every 3 ticks outside the ring

// Weapon numbers and the per-match config live in weapons.js. A match carries its own resolved
// table (state.W), so every function below reads the match's numbers, never the global defaults.
import { WEAPONS, normaliseWeapons, weaponTable, configId, enabledWeapons, LEGACY_WEAPON_CONFIG } from './weapons.js';
export { WEAPONS };
export function weaponRange(name, W = WEAPONS) {
  const w = W[name];
  return w.range ?? w.speed * w.life;
}
// The three newer weapons share three spots per slot; the seed picks which goes where.
const NEW_WEAPONS = ['uzi', 'flamethrower', 'missile'];
const PERMS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];

// ---------- PRNG (mulberry32, state is a plain integer so match state stays serialisable)
export function rngNext(state) {
  let t = (state.rng = (state.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function makeRng(seed) {
  const s = { rng: seed | 0 };
  return () => rngNext(s);
}

// ---------- geometry helpers
const hyp = (x, y) => Math.sqrt(x * x + y * y);
function norm(x, y) {
  const d = hyp(x, y);
  return d > 1e-9 ? [x / d, y / d] : [0, 0];
}
const COMPASS = ['E', 'SE', 'S', 'SW', 'W', 'NW', 'N', 'NE']; // screen y points down
export function bearing(dx, dy) {
  const a = Math.atan2(dy, dx);
  const i = ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8;
  return COMPASS[i];
}
export function distBucket(d) {
  if (d < 40) return 'close';
  if (d < 90) return 'near';
  if (d < 160) return 'mid';
  return 'far';
}
const DIRS8 = { N: [0, -1], NE: [Math.SQRT1_2, -Math.SQRT1_2], E: [1, 0], SE: [Math.SQRT1_2, Math.SQRT1_2],
  S: [0, 1], SW: [-Math.SQRT1_2, Math.SQRT1_2], W: [-1, 0], NW: [-Math.SQRT1_2, -Math.SQRT1_2] };

function segBlocked(state, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1e-9;
  for (const p of state.pillars) {
    let t = ((p.x - ax) * dx + (p.y - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + dx * t - p.x, cy = ay + dy * t - p.y;
    if (cx * cx + cy * cy < PILLAR_R * PILLAR_R) return true;
  }
  return false;
}
export function hasLos(state, a, b) {
  return !segBlocked(state, a.x, a.y, b.x, b.y);
}

// ---------- match creation
// weapons: a weapon config (see weapons.js). Omitted = the legacy all-on config, and the state hash
// is then the same as before configs existed, so older logs still verify.
export function createMatch({ seed = 1, roster, weapons }) {
  const cfg = weapons ? normaliseWeapons(weapons) : LEGACY_WEAPON_CONFIG;
  const on = new Set(enabledWeapons(cfg));
  const n = roster.length;
  const offset = ((seed % n) + n) % n; // rotate spawn order between matches
  const slotAngle = (k) => -Math.PI / 2 + (2 * Math.PI * k) / n;
  const pillars = [], pickups = [];
  const perm = PERMS[((seed % 6) + 6) % 6].map((i) => NEW_WEAPONS[i]);
  // A disabled weapon simply never spawns; the pillars and every other pickup keep their places.
  const pick = (type, ang, r) => (type === 'medpack' || on.has(type)) && pickups.push({ type, x: CENTRE + Math.cos(ang) * r, y: CENTRE + Math.sin(ang) * r, active: true, respawn: 0 });
  // Every slot gets the same set, so the layout stays rotationally symmetric (fair) for any n.
  for (let k = 0; k < n; k++) {
    const a = slotAngle(k), pa = a + Math.PI / n;
    pillars.push({ x: CENTRE + Math.cos(pa) * 88, y: CENTRE + Math.sin(pa) * 88 });
    pick('shotgun', a, 112);
    pick('medpack', pa, 150);
    pick(perm[0], a, 62);
    pick(perm[1], pa, 122);
    pick(perm[2], pa, 50);
  }
  pick('rifle', 0, 0);
  const fighters = roster.map((id, i) => {
    const a = slotAngle((i + offset) % n);
    const x = CENTRE + Math.cos(a) * 160, y = CENTRE + Math.sin(a) * 160;
    return { id, i, x, y, face: Math.atan2(CENTRE - y, CENTRE - x), hp: MAX_HP, alive: true,
      weapon: 'pistol', ammo: Infinity, cd: 0, action: 'hold', actionTick: -1000, stunned: false,
      kills: 0, deathTick: null, killedBy: null, shots: 0, hits: 0,
      vol: 0, lastShot: 'none', lastShotTick: -1, lastShotV: 0, // volley counter and last resolved shot
      flame: 0, flameV: 0, flameHit: false, flameOor: false, // active flamethrower burst
      dealt: 0 }; // damage dealt to others (stats only, not hashed)
  });
  return { seed, tick: 0, rng: (seed * 2654435761) | 0, fighters, pillars, pickups, bullets: [],
    weapons: cfg, W: weaponTable(cfg), cfgId: weapons ? configId(cfg) : null,
    ringR: ARENA_R, over: false, winner: null, ranking: null, events: [] };
}

export function applyAction(state, fid, action) {
  const f = state.fighters.find((x) => x.id === fid);
  if (!f || !f.alive) return;
  f.stunned = action === 'stunned';
  f.action = f.stunned ? 'hold' : action;
  f.actionTick = state.tick;
}

export function effectiveAction(state, f) {
  if (f.stunned) return 'hold';
  if (state.tick - f.actionTick > ACTION_HOLD_TICKS) return 'hold';
  return f.action;
}

function nearestEnemy(state, f, needLos) {
  let best = null, bd = Infinity;
  for (const e of state.fighters) {
    if (e === f || !e.alive) continue;
    const d = hyp(e.x - f.x, e.y - f.y);
    if (d < bd && (!needLos || hasLos(state, f, e))) { bd = d; best = e; }
  }
  return best;
}

// A pickup worth heading for: active, collectable (no medpack at full HP), and not one we are
// already standing on (that would only happen if we cannot collect it).
export function pickupWanted(f, p) {
  if (!p.active) return false;
  if (p.type === 'medpack' && f.hp >= MAX_HP) return false;
  return hyp(p.x - f.x, p.y - f.y) > FIGHTER_R + PICKUP_R;
}

function nearestPickup(state, f) {
  let best = null, bd = Infinity;
  for (const p of state.pickups) {
    if (!pickupWanted(f, p)) continue;
    const d = hyp(p.x - f.x, p.y - f.y);
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

// Bend a move around pillars that sit between us and the goal.
function steer(state, f, dx, dy, goalDist) {
  for (const p of state.pillars) {
    const rx = p.x - f.x, ry = p.y - f.y;
    const along = rx * dx + ry * dy;
    if (along <= 0 || along > 36 || along > goalDist) continue;
    const px = rx - dx * along, py = ry - dy * along;
    if (hyp(px, py) < PILLAR_R + FIGHTER_R + 1) {
      const side = dx * ry - dy * rx >= 0 ? -1 : 1; // go round the side we are already on
      const [tx, ty] = norm(-ry * side, rx * side);
      return norm(dx * 0.3 + tx, dy * 0.3 + ty);
    }
  }
  return [dx, dy];
}

function moveDir(state, f, act) {
  const enemy = nearestEnemy(state, f, false);
  if (act === 'hold' || act === 'shoot') return [0, 0];
  if (act === 'grab_pickup') {
    const p = nearestPickup(state, f);
    if (!p) return [0, 0];
    const d = hyp(p.x - f.x, p.y - f.y);
    const [x, y] = norm(p.x - f.x, p.y - f.y);
    return steer(state, f, x, y, d);
  }
  if (!enemy) return [0, 0];
  const ex = enemy.x - f.x, ey = enemy.y - f.y, ed = hyp(ex, ey);
  const [ux, uy] = norm(ex, ey);
  switch (act) {
    case 'advance':
      return ed < 18 ? [0, 0] : steer(state, f, ux, uy, ed);
    case 'retreat':
      return [-ux, -uy];
    case 'strafe_left':
      return [-uy, ux];
    case 'strafe_right':
      return [uy, -ux];
    case 'take_cover': {
      let best = null, bd = Infinity;
      for (const p of state.pillars) {
        const [ox, oy] = norm(p.x - enemy.x, p.y - enemy.y);
        const cx = p.x + ox * (PILLAR_R + FIGHTER_R + 2), cy = p.y + oy * (PILLAR_R + FIGHTER_R + 2);
        const d = hyp(cx - f.x, cy - f.y);
        if (d < bd) { bd = d; best = [cx, cy]; }
      }
      if (!best || bd < 2) return [0, 0];
      const [x, y] = norm(best[0] - f.x, best[1] - f.y);
      return steer(state, f, x, y, bd);
    }
  }
  return [0, 0];
}

// Record a shot's outcome. Volleys resolve roughly in order; an older volley never overwrites a newer one.
function resolveShot(state, f, v, result) {
  if (v > f.lastShotV || (v === f.lastShotV && result === 'hit' && f.lastShot !== 'hit')) {
    f.lastShotV = v; f.lastShot = result; f.lastShotTick = state.tick;
  }
}

function fire(state, f, target) {
  const wname = f.weapon, w = state.W[wname];
  const base = Math.atan2(target.y - f.y, target.x - f.x);
  const dist = hyp(target.x - f.x, target.y - f.y);
  const v = ++f.vol;
  if (wname === 'flamethrower') {
    f.flame = w.burst; f.flameV = v; f.flameHit = false; f.flameOor = dist > w.range + FIGHTER_R;
    f.shots += 1;
  } else {
    const oor = dist > weaponRange(wname, state.W);
    for (let k = 0; k < w.pellets; k++) {
      const a = base + (rngNext(state) - 0.5) * 2 * w.spread;
      state.bullets.push({ x: f.x + Math.cos(a) * (FIGHTER_R + 2), y: f.y + Math.sin(a) * (FIGHTER_R + 2),
        vx: Math.cos(a) * w.speed, vy: Math.sin(a) * w.speed, dmg: w.dmg, owner: f.id, life: w.life, w: wname, v, oor });
    }
    f.shots += w.pellets;
  }
  f.cd = w.cd;
  if (wname !== 'pistol') {
    f.ammo -= 1;
    if (f.ammo <= 0) { f.weapon = 'pistol'; f.ammo = Infinity; }
  }
  state.events.push({ type: 'shot', id: f.id, x: f.x, y: f.y, a: base, w: wname });
}

// Missile blast: everyone within `blast` (the shooter too) takes up to dmg, half at the edge.
function explode(state, b) {
  const R = state.W.missile.blast;
  const owner = state.fighters.find((x) => x.id === b.owner);
  let hitEnemy = false;
  state.events.push({ type: 'explode', x: b.x, y: b.y, r: R, by: b.owner });
  for (const f of state.fighters) {
    if (!f.alive) continue;
    const d = hyp(f.x - b.x, f.y - b.y);
    if (d >= R) continue;
    const dmg = Math.max(1, Math.round(b.dmg * (1 - 0.5 * d / R)));
    f.hp -= dmg;
    if (f.id !== b.owner) { hitEnemy = true; if (owner) owner.dealt += dmg; }
    state.events.push({ type: 'hit', id: f.id, by: b.owner, x: f.x, y: f.y, dmg });
    if (f.hp <= 0) kill(state, f, b.owner);
  }
  if (owner) {
    if (hitEnemy) owner.hits++;
    resolveShot(state, owner, b.v, hitEnemy ? 'hit' : b.oor ? 'out_of_range' : 'miss');
  }
}

// Flamethrower bursts: damage every tick to anyone alive in the cone with line of sight.
function burn(state) {
  const W = state.W.flamethrower;
  for (const f of state.fighters) {
    if (!f.alive || f.flame <= 0) continue;
    for (const e of state.fighters) {
      if (e === f || !e.alive) continue;
      const dx = e.x - f.x, dy = e.y - f.y, d = hyp(dx, dy);
      if (d > W.range + FIGHTER_R) continue;
      let da = Math.atan2(dy, dx) - f.face;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      if (Math.abs(da) > W.cone || !hasLos(state, f, e)) continue;
      e.hp -= W.dmg; f.dealt += W.dmg;
      if (!f.flameHit) { f.flameHit = true; f.hits++; resolveShot(state, f, f.flameV, 'hit'); }
      state.events.push({ type: 'hit', id: e.id, by: f.id, x: e.x, y: e.y, dmg: W.dmg, flame: true });
      if (e.hp <= 0) kill(state, e, f.id);
    }
    f.flame--;
    if (f.flame === 0 && !f.flameHit) resolveShot(state, f, f.flameV, f.flameOor ? 'out_of_range' : 'miss');
  }
}

function resolve(state, f) {
  for (const p of state.pillars) {
    const dx = f.x - p.x, dy = f.y - p.y, d = hyp(dx, dy), min = PILLAR_R + FIGHTER_R;
    if (d < min) {
      const [ux, uy] = d > 1e-9 ? [dx / d, dy / d] : [1, 0];
      f.x = p.x + ux * min; f.y = p.y + uy * min;
    }
  }
  const dx = f.x - CENTRE, dy = f.y - CENTRE, d = hyp(dx, dy), max = ARENA_R - FIGHTER_R;
  if (d > max) { f.x = CENTRE + (dx / d) * max; f.y = CENTRE + (dy / d) * max; }
}

function kill(state, victim, killerId) {
  victim.alive = false;
  victim.hp = 0;
  victim.deathTick = state.tick;
  victim.killedBy = killerId;
  const k = state.fighters.find((x) => x.id === killerId);
  if (k && k !== victim) k.kills++;
  state.events.push({ type: 'death', id: victim.id, x: victim.x, y: victim.y, by: killerId });
}

export function step(state) {
  if (state.over) return state;
  state.events = [];
  const t = state.tick;
  if (t >= RING_START) {
    const k = Math.min(1, (t - RING_START) / (MATCH_TICKS - RING_START));
    state.ringR = ARENA_R - (ARENA_R - RING_MIN) * k;
  }

  for (const f of state.fighters) {
    if (!f.alive) continue;
    if (f.cd > 0) f.cd--;
    const act = effectiveAction(state, f);
    const losTarget = nearestEnemy(state, f, true);
    const anyTarget = losTarget || nearestEnemy(state, f, false);
    let [dx, dy] = moveDir(state, f, act);
    if (anyTarget) f.face = Math.atan2(anyTarget.y - f.y, anyTarget.x - f.x);
    else if (dx || dy) f.face = Math.atan2(dy, dx);
    if (act === 'shoot' && losTarget && f.cd <= 0) fire(state, f, losTarget);
    f.x += dx * SPEED; f.y += dy * SPEED;
    resolve(state, f);
    for (const p of state.pickups) {
      if (!p.active || hyp(p.x - f.x, p.y - f.y) > FIGHTER_R + PICKUP_R) continue;
      if (p.type === 'medpack') {
        if (f.hp >= MAX_HP) continue;
        f.hp = Math.min(MAX_HP, f.hp + MEDPACK_HP);
      } else {
        f.weapon = p.type; f.ammo = state.W[p.type].ammo;
      }
      p.active = false; p.respawn = t + PICKUP_RESPAWN;
      state.events.push({ type: 'pickup', id: f.id, kind: p.type, x: p.x, y: p.y });
    }
    if (hyp(f.x - CENTRE, f.y - CENTRE) > state.ringR && t % 3 === 0) {
      f.hp -= 1;
      if (f.hp <= 0) kill(state, f, null);
    }
  }

  burn(state);

  // fighter separation, fixed order
  const fs = state.fighters;
  for (let a = 0; a < fs.length; a++) for (let b = a + 1; b < fs.length; b++) {
    const A = fs[a], B = fs[b];
    if (!A.alive || !B.alive) continue;
    const dx = B.x - A.x, dy = B.y - A.y, d = hyp(dx, dy), min = FIGHTER_R * 2;
    if (d < min && d > 1e-9) {
      const push = (min - d) / 2, ux = dx / d, uy = dy / d;
      A.x -= ux * push; A.y -= uy * push; B.x += ux * push; B.y += uy * push;
      resolve(state, A); resolve(state, B);
    }
  }

  // bullets, two substeps each tick. Missiles explode on whatever stops them, or at their range.
  const keep = [], missed = [];
  for (const b of state.bullets) {
    let alive = true, hit = false;
    const missile = b.w === 'missile';
    for (let s = 0; s < 2 && alive; s++) {
      b.x += b.vx / 2; b.y += b.vy / 2;
      // 'wall' and 'spark' are presentation-only events (sound); events are not part of hashState
      if (hyp(b.x - CENTRE, b.y - CENTRE) > ARENA_R) { alive = false; if (!missile) state.events.push({ type: 'wall', x: b.x, y: b.y }); break; }
      for (const p of state.pillars) {
        if (hyp(b.x - p.x, b.y - p.y) < PILLAR_R) { alive = false; if (!missile) state.events.push({ type: 'spark', x: b.x, y: b.y }); break; }
      }
      if (!alive) break;
      for (const f of fs) {
        if (!f.alive || f.id === b.owner) continue;
        if (hyp(b.x - f.x, b.y - f.y) < FIGHTER_R + (missile ? 2 : 1)) {
          alive = false;
          if (missile) break;
          hit = true;
          f.hp -= b.dmg;
          const o = fs.find((x) => x.id === b.owner);
          if (o) { o.hits++; o.dealt += b.dmg; resolveShot(state, o, b.v, 'hit'); }
          state.events.push({ type: 'hit', id: f.id, by: b.owner, x: b.x, y: b.y, dmg: b.dmg });
          if (f.hp <= 0) kill(state, f, b.owner);
          break;
        }
      }
    }
    if (alive && --b.life > 0) { keep.push(b); continue; }
    if (missile) explode(state, b);
    else if (!hit) missed.push(b);
  }
  state.bullets = keep;
  // a volley that has no pellets left in flight and never hit anything is a miss (or out of range)
  for (const b of missed) {
    if (keep.some((k) => k.owner === b.owner && k.v === b.v)) continue;
    const o = fs.find((x) => x.id === b.owner);
    if (o) resolveShot(state, o, b.v, b.oor ? 'out_of_range' : 'miss');
  }

  for (const p of state.pickups) if (!p.active && t >= p.respawn) p.active = true;

  state.tick++;
  const alive = fs.filter((f) => f.alive);
  if (alive.length <= 1 || state.tick >= MATCH_TICKS) finish(state);
  return state;
}

function finish(state) {
  state.over = true;
  const ranked = [...state.fighters].sort((a, b) =>
    (b.alive - a.alive) || (b.hp - a.hp) || ((b.deathTick ?? 1e9) - (a.deathTick ?? 1e9)) || (b.kills - a.kills) || (a.i - b.i));
  state.ranking = ranked.map((f) => f.id);
  state.winner = ranked[0].id;
}

// ---------- scene bucketing: what each model sees, egocentric and coarse
export function sceneFor(state, fid) {
  const f = state.fighters.find((x) => x.id === fid);
  const enemies = state.fighters
    .filter((e) => e !== f && e.alive)
    .map((e) => ({ e, d: hyp(e.x - f.x, e.y - f.y) }))
    .sort((a, b) => a.d - b.d)
    .map(({ e, d }) => ({ name: e.id, bearing: bearing(e.x - f.x, e.y - f.y), dist: distBucket(d),
      los: hasLos(state, f, e), hp: e.hp }));

  // incoming: the soonest hostile fire that will reach us. Bullets on a collision course; a missile whose
  // path passes within its blast radius of us; an enemy flamethrower in range and pointing our way.
  let incoming = null;
  const flag = (kind, x, y, eta) => {
    if (!incoming || eta < incoming.eta_ticks) incoming = { kind, bearing: bearing(x - f.x, y - f.y), eta_ticks: eta };
  };
  for (const b of state.bullets) {
    if (b.owner === f.id) continue;
    const rx = f.x - b.x, ry = f.y - b.y, v2 = b.vx * b.vx + b.vy * b.vy;
    const ts = (rx * b.vx + ry * b.vy) / v2;
    if (b.w === 'missile') {
      if (ts < 0) continue; // flying away
      const tc = Math.min(ts, b.life); // it explodes at the end of its life
      if (hyp(rx - b.vx * tc, ry - b.vy * tc) >= state.W.missile.blast + FIGHTER_R) continue;
      flag('missile', b.x, b.y, Math.ceil(tc));
      continue;
    }
    if (ts < 0 || ts > 20 || ts > b.life) continue;
    const miss = hyp(rx - b.vx * ts, ry - b.vy * ts);
    if (miss >= FIGHTER_R + 4) continue;
    flag('bullet', b.x, b.y, Math.ceil(ts));
  }
  const FL = state.W.flamethrower;
  for (const e of state.fighters) {
    if (e === f || !e.alive || (e.weapon !== 'flamethrower' && e.flame <= 0)) continue;
    const dx = f.x - e.x, dy = f.y - e.y;
    if (hyp(dx, dy) > FL.range + FIGHTER_R) continue;
    let da = Math.atan2(dy, dx) - e.face;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    if (Math.abs(da) > FL.cone || !hasLos(state, e, f)) continue;
    flag('flame', e.x, e.y, e.flame > 0 ? 0 : Math.max(0, e.cd));
  }

  const blocked = [];
  for (const [name, [dx, dy]] of Object.entries(DIRS8)) {
    const px = f.x + dx * 14, py = f.y + dy * 14;
    const wall = hyp(px - CENTRE, py - CENTRE) > ARENA_R - FIGHTER_R;
    const pillar = state.pillars.some((p) => hyp(px - p.x, py - p.y) < PILLAR_R + FIGHTER_R);
    if (wall || pillar) blocked.push(name);
  }

  const pickups = state.pickups
    .filter((p) => pickupWanted(f, p))
    .map((p) => ({ p, d: hyp(p.x - f.x, p.y - f.y) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map(({ p, d }) => ({ type: p.type, bearing: bearing(p.x - f.x, p.y - f.y), dist: distBucket(d) }));

  const r = hyp(f.x - CENTRE, f.y - CENTRE);
  return {
    hp: f.hp,
    weapon: f.weapon,
    ammo: f.weapon === 'pistol' ? 'unlimited' : f.ammo,
    range: distBucket(weaponRange(f.weapon, state.W)),
    gun_ready: f.cd <= 0,
    last_shot: f.lastShot === 'none' ? { result: 'none' } : { result: f.lastShot, ticks_ago: state.tick - f.lastShotTick },
    enemies,
    incoming,
    blocked,
    pickups,
    ring: { closing: state.tick >= RING_START, outside: r > state.ringR, edge: distBucket(Math.abs(state.ringR - r)),
      centre: bearing(CENTRE - f.x, CENTRE - f.y) },
    time_left_s: Math.max(0, Math.ceil((MATCH_TICKS - state.tick) / TICK_HZ)),
  };
}

// ---------- hashing and replay
export function hashState(state) {
  let h = 0x811c9dc5;
  const parts = [state.tick, state.rng, state.fighters.map((f) =>
    [f.id, f.x, f.y, f.hp, f.alive, f.kills, f.weapon, f.ammo === Infinity ? -1 : f.ammo, f.cd,
      f.vol, f.lastShot, f.lastShotTick, f.lastShotV, f.flame, f.flameV, f.flameHit, f.flameOor, f.shots, f.hits]),
    state.bullets.map((b) => [b.x, b.y, b.life, b.w, b.v, b.oor]), state.pickups.map((p) => [p.type, p.active])];
  if (state.cfgId) parts.push(state.cfgId); // the weapon config is a hash input (legacy all-on logs: none)
  const s = JSON.stringify(parts);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// Applies log decisions in order, keyed by the tick they were applied on.
export class ReplayCursor {
  constructor(log) {
    this.log = log;
    // the log's own weapon config, never the one in the dialog; none = a legacy all-on log
    this.state = createMatch({ seed: log.seed, roster: log.roster.map((r) => r.id), weapons: log.weapons });
    this.decisions = [...log.decisions].map((d, i) => ({ d, i })).sort((a, b) => a.d.t - b.d.t || a.i - b.i).map((x) => x.d);
    this.next = 0;
  }
  // Advance one tick. Returns the decisions applied on this tick.
  tick() {
    const applied = [];
    while (this.next < this.decisions.length && this.decisions[this.next].t === this.state.tick) {
      const d = this.decisions[this.next++];
      applyAction(this.state, d.f, d.err ? 'stunned' : d.a);
      applied.push(d);
    }
    // skip any stale entries (should not happen in a well-formed log)
    while (this.next < this.decisions.length && this.decisions[this.next].t < this.state.tick) this.next++;
    step(this.state);
    return applied;
  }
}

export function runLog(log) {
  const c = new ReplayCursor(log);
  while (!c.state.over) c.tick();
  return c.state;
}
