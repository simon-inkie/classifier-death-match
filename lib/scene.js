// The scene a hosted /api/decide call may send, rebuilt from a strict schema. The browser computes the
// scene (the simulation runs there), so it is untrusted input that goes straight into a paid prompt:
// every field is whitelisted, enums are checked, arrays and numbers are bounded, and the rebuilt
// object keeps sceneFor's key order so the prompt text is byte-identical to the local proxy's.
// Everything is ASCII, so a prompt's token count can never exceed its character count; that is what
// makes the per-call worst case in lib/spend.js an honest upper bound.
import { WEAPON_NAMES } from '../public/weapons.js';
import { stateTextFor, decisionQuestions, chatSystemPrompt, chatSchema, promptVariant } from '../public/shared.js';

const BEARINGS = new Set(['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']);
const DISTS = new Set(['close', 'near', 'mid', 'far']);
const SHOTS = new Set(['none', 'hit', 'miss', 'out_of_range', 'blocked']);
const INCOMING = new Set(['bullet', 'missile', 'flame']);
const PICKUPS = new Set([...WEAPON_NAMES, 'medpack']);
const WEAPONS = new Set(WEAPON_NAMES);

class SceneError extends Error {}
const fail = (what) => { throw new SceneError(`bad scene: ${what}`); };
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneOf = (set, v, what) => (typeof v === 'string' && set.has(v) ? v : fail(what));
const bool = (v, what) => (typeof v === 'boolean' ? v : fail(what));
const int = (v, lo, hi, what) => (Number.isInteger(v) && v >= lo && v <= hi ? v : fail(what));
const list = (v, max, what) => (Array.isArray(v) && v.length <= max ? v : fail(what));

// self: the asking fighter's id; others: the other fighter ids in the match; modelAims: from the match.
export function cleanScene(sc, { self, others, modelAims = false }) {
  if (!isObj(sc)) fail('not an object');
  const enemyIds = new Set(others.filter((id) => id !== self));
  const seen = new Set();
  const enemies = list(sc.enemies, enemyIds.size, 'enemies').map((e) => {
    if (!isObj(e)) fail('enemy');
    const name = oneOf(enemyIds, e.name, 'enemy name');
    if (seen.has(name)) fail('duplicate enemy'); seen.add(name);
    return { name, bearing: oneOf(BEARINGS, e.bearing, 'enemy bearing'), dist: oneOf(DISTS, e.dist, 'enemy dist'),
      los: bool(e.los, 'enemy los'), hp: int(e.hp, -1000, 100, 'enemy hp') };
  });
  const ls = isObj(sc.last_shot) ? sc.last_shot : fail('last_shot');
  const result = oneOf(SHOTS, ls.result, 'last_shot result');
  const inc = sc.incoming == null ? null : isObj(sc.incoming) ? sc.incoming : fail('incoming');
  const blocked = list(sc.blocked, 8, 'blocked').map((b) => oneOf(BEARINGS, b, 'blocked'));
  if (new Set(blocked).size !== blocked.length) fail('blocked repeats');
  const ring = isObj(sc.ring) ? sc.ring : fail('ring');
  const weapon = oneOf(WEAPONS, sc.weapon, 'weapon');
  return {
    ...(modelAims ? { model_aims: true } : {}),
    hp: int(sc.hp, -1000, 100, 'hp'),
    weapon,
    ammo: sc.ammo === 'unlimited' ? 'unlimited' : int(sc.ammo, 0, 999, 'ammo'),
    range: oneOf(DISTS, sc.range, 'range'),
    gun_ready: bool(sc.gun_ready, 'gun_ready'),
    last_shot: result === 'none' ? { result } : { result, ticks_ago: int(ls.ticks_ago, 0, 100000, 'ticks_ago') },
    enemies,
    incoming: inc && { kind: oneOf(INCOMING, inc.kind, 'incoming kind'), bearing: oneOf(BEARINGS, inc.bearing, 'incoming bearing'),
      eta_ticks: int(inc.eta_ticks, 0, 10000, 'eta') },
    blocked,
    pickups: list(sc.pickups, 3, 'pickups').map((p) => {
      if (!isObj(p)) fail('pickup');
      return { type: oneOf(PICKUPS, p.type, 'pickup type'), bearing: oneOf(BEARINGS, p.bearing, 'pickup bearing'), dist: oneOf(DISTS, p.dist, 'pickup dist') };
    }),
    ring: { closing: bool(ring.closing, 'ring'), outside: bool(ring.outside, 'ring'), edge: oneOf(DISTS, ring.edge, 'ring edge'),
      centre: oneOf(BEARINGS, ring.centre, 'ring centre') },
    time_left_s: int(sc.time_left_s, 0, 60, 'time_left_s'),
  };
}
export const isSceneError = (e) => e instanceof SceneError;

// Every character of input the model is sent for one call: the state text plus the question (decision
// models), or the system prompt, the user text and the JSON schema (chat). An upper bound on its tokens.
export function promptChars(fighter, scene, weapons) {
  const text = stateTextFor(fighter, scene, weapons);
  if (fighter.transport === 'chat') return text.length + chatSystemPrompt(scene).length + JSON.stringify(chatSchema(scene)).length;
  return text.length + JSON.stringify(decisionQuestions(promptVariant(fighter), scene)).length;
}
