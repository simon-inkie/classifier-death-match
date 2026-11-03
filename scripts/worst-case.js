// A worst-case scene for prompt size: six fighters (five enemies, all hidden at full HP), every weapon
// enabled, incoming missile, a recent out-of-range shot, a long weapon name, three pickups, ring closing
// and us outside it. Every field takes its longest plausible value, so the text is an upper bound.
import { LEGACY_WEAPON_CONFIG } from '../public/weapons.js';

export const WORST_WEAPONS = LEGACY_WEAPON_CONFIG; // all six weapons on

export function worstCaseScene() {
  const enemy = (name) => ({ name, bearing: 'NW', dist: 'close', los: false, hp: 100 });
  return {
    hp: 100,
    weapon: 'flamethrower',
    ammo: 200,
    range: 'close',
    gun_ready: false,
    last_shot: { result: 'out_of_range', ticks_ago: 2699 },
    enemies: ['scaledown', 'gemini', 'luna', 'laya', 'bot'].map(enemy),
    incoming: { kind: 'missile', bearing: 'NW', eta_ticks: 44 },
    blocked: ['SW', 'W', 'NW', 'N', 'NE'],
    pickups: ['flamethrower', 'flamethrower', 'flamethrower'].map((type) => ({ type, bearing: 'NW', dist: 'close' })),
    ring: { closing: true, outside: true, edge: 'close', centre: 'SE' },
    time_left_s: 90,
  };
}
