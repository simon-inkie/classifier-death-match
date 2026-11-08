// Shared between browser and proxy: the roster, the intentions, and the exact prompt text.
// One source: every fighter gets the identical full text, except Laya, who gets a compact
// variant of the same facts because of her 512-token per-question limit (see compactStateText).
import { WEAPONS, weaponRange, distBucket, TICK_HZ, MEDPACK_HP, RING_START, RING_MIN, RING_DPS, MATCH_TICKS,
  ARENA_R, respawnTicks } from './sim.js';
import { weaponTable, enabledWeapons, normaliseWeapons, LEGACY_WEAPON_CONFIG } from './weapons.js';

export const ACTIONS = [
  'advance',
  'retreat',
  'spin_left',
  'spin_right',
  'shoot',
  'take_cover',
  'grab_pickup',
  'hold',
];

export function actionsFor(scene) {
  return scene?.model_aims ? ACTIONS.flatMap((a) => a === 'shoot' ? (scene.enemies || []).map((e) => `shoot_${e.name}`) : [a]) : ACTIONS;
}
const AIM_RULE = 'You choose your target: shoot_<name> fires at that enemy; pick who to shoot.';
export const ACTION_CRITERIA = {
  advance: 'move towards the nearest enemy',
  retreat: 'move directly away from the nearest enemy',
  spin_left: 'circle anticlockwise around the nearest enemy, dodging',
  spin_right: 'circle clockwise around the nearest enemy, dodging',
  shoot: 'stand still and fire the current weapon at the nearest enemy in line of sight; weapon range matters',
  take_cover: 'move behind the nearest pillar so it blocks the nearest enemy',
  grab_pickup: 'move to the nearest pickup you can use (weapon, or medpack when hurt)',
  hold: 'stand still and do nothing',
};

export const ACTION_INSTRUCTIONS =
  'You control one fighter in a top-down arena shooter. Last fighter standing wins; ' +
  `at ${MATCH_TICKS / TICK_HZ} seconds the highest health wins. Pick the single best intention for the next moment.`;

// Laya's compact variant. Laya (via /v1/evaluate) rejects any question whose total input (state text,
// instructions and criteria) passes 512 tokens with HTTP 422, so she gets the same facts, tersely.
// Every other fighter gets the full text above. This is a limitation of the model, shown on her panel.
export const COMPACT_ACTION_CRITERIA = {
  advance: 'go to nearest enemy',
  retreat: 'go away from nearest enemy',
  spin_left: 'circle anticlockwise, dodging',
  spin_right: 'circle clockwise, dodging',
  shoot: 'fire at nearest visible enemy',
  take_cover: 'hide behind nearest pillar',
  grab_pickup: 'go to nearest useful pickup',
  hold: 'stand still',
};
export const COMPACT_ACTION_INSTRUCTIONS = 'You are one fighter. Last alive wins. Pick the best action now.';
export const PROMPT_TOKEN_LIMIT = 512; // Laya's per-question input limit
export const COMPACT_TOKEN_BUDGET = 400; // what the compact worst case must stay under (headroom)
export const CHARS_PER_TOKEN = 3.2; // conservative estimate for JSON-ish English
export const estimateTokens = (s) => Math.ceil(String(s).length / CHARS_PER_TOKEN);

// kind: decision models answer typed questions; chat is prompted for JSON; bot is local.
// transport: which gateway API the proxy uses. on: ticked by default (Gemini and the bot are opt-in).
// stateObject: request-envelope detail for ScaleDown, see adapters.js.
// prompt: 'full' (default) or 'compact'. Only Laya gets the compact prompt, because of her 512-token
// per-question limit; every other fighter gets the identical full text.
// price: USD per token, from https://ai-gateway.vercel.sh/v1/models on 3 Nov 2026 (estimate only).
export const ROSTER = [
  { id: 'jev', name: 'JEV', model: 'typesafe-ai/jev', kind: 'decision', transport: 'typesafe',
    colour: '#3ce0a0', price: { in: 0.042e-6, out: 0 },
    mock: { base: 260, jitter: 160, err: 0.02, skill: 3.4 } },
  { id: 'luna', name: 'LUNA', model: 'openai/gpt-6-luna-decisions', kind: 'decision', transport: 'evaluate',
    colour: '#ff6ad5', price: { in: 0.10e-6, out: 0 },
    mock: { base: 420, jitter: 260, err: 0.02, skill: 3.6 } },
  { id: 'laya', name: 'LAYA', model: 'convaiinnovations/laya', kind: 'decision', transport: 'evaluate', prompt: 'compact',
    colour: '#ffd23c', price: { in: 0.0105e-6, out: 0 },
    mock: { base: 330, jitter: 220, err: 0.03, skill: 3.0 } },
  { id: 'scaledown', name: 'SCALEDOWN', model: 'scaledown/scaledown-classify-1', kind: 'decision', transport: 'typesafe',
    stateObject: true, colour: '#b07cff', price: { in: 0.05e-6, out: 0 },
    mock: { base: 300, jitter: 180, err: 0.02, skill: 3.2 } },
  { id: 'gemini', name: 'GEMINI', model: 'google/gemini-2.5-flash-lite', kind: 'chat', transport: 'chat', on: false,
    colour: '#5aa0ff', price: { in: 0.10e-6, out: 0.40e-6 },
    mock: { base: 900, jitter: 600, err: 0.04, skill: 3.4 } },
  { id: 'bot', name: 'BOT', model: 'scripted if/else', kind: 'bot', transport: 'local', on: false,
    colour: '#c8c8c8', price: { in: 0, out: 0 },
    mock: { base: 2, jitter: 2, err: 0, skill: 0 } },
  // Spare chat slots let any line-up contain up to six picked gateway models.
  ...['#ef8855', '#51c7da', '#a8d65c', '#db7799', '#e0bb80'].map((colour, i) => ({
    id: `gw${i + 1}`, name: `GATEWAY ${i + 1}`, model: 'google/gemini-2.5-flash-lite',
    gatewaySlot: true, kind: 'chat', transport: 'chat', on: false, colour,
    price: { in: 0.10e-6, out: 0.40e-6 }, mock: { base: 900, jitter: 600, err: 0.04, skill: 3.4 },
  })),
];

export const rosterById = Object.fromEntries(ROSTER.map((r) => [r.id, r]));
export const DEFAULT_ROSTER = ROSTER.filter((r) => r.on !== false).map((r) => r.id);
export const MAX_FIGHTERS = 6;

// Factual rules, generated from the sim's own numbers so the text cannot drift from the game.
// They follow the match's weapon config: a disabled weapon is not mentioned at all.
const WEAPON_NOTES = {
  shotgun: () => 'spread', rifle: () => 'accurate', uzi: () => 'wide spread',
  missile: (w) => `slow rocket, explodes on impact or at its range, blast radius ${w.blast} (close) hurts you too`,
  flamethrower: () => 'cone in front of you, hurts every tick an enemy is in it',
};
const r1 = (x) => Math.round(x * 10) / 10;
export function weaponLine(name, W = WEAPONS) {
  const w = W[name];
  const range = distBucket(weaponRange(name, W));
  let dmg, rate, ammo;
  if (name === 'flamethrower') {
    dmg = `${w.dmg * TICK_HZ} dmg/s`;
    rate = `${r1(w.burst / TICK_HZ)} s bursts every ${r1(w.cd / TICK_HZ)} s`;
    ammo = `${w.ammo} bursts`;
  } else {
    dmg = name === 'missile' ? `up to ${w.dmg} dmg` : w.pellets > 1 ? `${w.pellets}x${w.dmg} dmg` : `${w.dmg} dmg`;
    rate = `${r1(TICK_HZ / w.cd)} shot${TICK_HZ === w.cd ? '' : 's'}/s`;
    ammo = w.ammo === Infinity ? 'unlimited' : `${w.ammo} shots`;
  }
  const note = WEAPON_NOTES[name]?.(w);
  return `- ${name}: range ${range}, ${dmg}, ${rate}, ammo ${ammo}${note ? ', ' + note : ''}`;
}

const respawnLine = (cfg) => { const t = respawnTicks(cfg); return t === Infinity ? 'Pickups do not respawn.' : `Pickups respawn after ${r1(t / TICK_HZ)} s.`; };
// weapons: a (normalised) weapon config. Omitted = the legacy all-on config.
export function rulesText(weapons) {
  const cfg = weapons ? normaliseWeapons(weapons) : LEGACY_WEAPON_CONFIG;
  const W = weaponTable(cfg);
  return [
    'Weapons (range = furthest dist bucket a shot reaches; shots vanish at their range, so shooting an enemy beyond range is wasted):',
    ...enabledWeapons(cfg).map((n) => weaponLine(n, W)),
    `An empty weapon reverts to the pistol. Walk over a pickup to take it. medpack: +${MEDPACK_HP} HP, only when hurt. ${respawnLine(cfg)}`,
    `Ring: from ${RING_START / TICK_HZ} s it shrinks toward the centre (radius ${ARENA_R} down to ${RING_MIN} at ${MATCH_TICKS / TICK_HZ} s). Outside it you lose ${RING_DPS} HP/s. ` +
      'ring.closing = shrinking now; ring.outside = you are outside it; ring.edge = your dist to the ring edge; ring.centre = bearing to the centre.',
    'range = your current weapon range. gun_ready = can fire now. last_shot = result of your last shot (hit, miss, out_of_range or none) and ticks_ago.',
  ].join('\n');
}
export const RULES_TEXT = rulesText();

// The full state text: identical for every 'full' fighter in a match. Fixed rules for the match's
// weapon config, then JSON of the bucketed scene.
export function stateText(scene, weapons) {
  const cfg = weapons ? normaliseWeapons(weapons) : LEGACY_WEAPON_CONFIG;
  const kinds = ['a bullet', cfg.missile.on && 'a missile blast', cfg.flamethrower.on && 'flame'].filter(Boolean);
  return (
    `Arena shooter, top-down, ${TICK_HZ} ticks/s. Compass bearings are relative to the map (N is up). ` +
    'dist buckets: close <40, near <90, mid <160, far beyond. los = line of sight. ' +
    `incoming = fire about to hit you: kind (${kinds.join(', ')}), bearing, eta_ticks. ` +
    'blocked = directions with a wall or pillar right next to you.\n' +
    (weapons ? rulesText(weapons) : RULES_TEXT) + '\n' +
    (scene.model_aims ? AIM_RULE + '\n' : '') + JSON.stringify(scene)
  );
}

// ---------- Laya's compact prompt: the same facts, terse enough for a 512-token question.
const COMPACT_NOTES = {
  shotgun: () => 'spread', uzi: () => 'rapid', rifle: () => 'strong',
  missile: (w) => `blast ${distBucket(w.blast)}, hurts you too`,
  flamethrower: () => 'burns while in cone',
};
export function compactRulesText(weapons) {
  const cfg = weapons ? normaliseWeapons(weapons) : LEGACY_WEAPON_CONFIG;
  const W = weaponTable(cfg);
  const ws = enabledWeapons(cfg).map((n) => {
    const note = COMPACT_NOTES[n]?.(W[n]);
    return `${n} ${distBucket(weaponRange(n, W))}${note ? ' ' + note : ''}`;
  });
  return `Top-down arena, N up, ${TICK_HZ} ticks/s. dist: close<40 near<90 mid<160 far. ` +
    `Ranges: ${ws.join('; ')}. Shots vanish at range; empty gun becomes pistol. ` +
    `Ring shrinks from ${RING_START / TICK_HZ}s, -${RING_DPS}hp/s outside.`;
}
// Compact scene: same fields as the full JSON, rendered tersely (enemies as short strings, top 2 pickups).
export function compactScene(sc) {
  const ls = sc.last_shot || { result: 'none' };
  const inc = sc.incoming;
  const ring = sc.ring || {};
  return {
    hp: sc.hp, weapon: sc.weapon, ammo: sc.ammo === 'unlimited' ? 'inf' : sc.ammo, range: sc.range,
    ready: sc.gun_ready,
    last_shot: ls.result === 'none' ? 'none' : `${ls.result} ${ls.ticks_ago}t ago`,
    enemies: (sc.enemies || []).map((e) => `${sc.model_aims ? e.name + ' ' : ''}${e.bearing} ${e.dist} ${e.los ? 'visible' : 'hidden'} ${e.hp}hp`),
    incoming: inc ? `${inc.kind || 'bullet'} ${inc.bearing} ${inc.eta_ticks}t` : 'none',
    blocked: (sc.blocked || []).join(' '),
    pickups: (sc.pickups || []).slice(0, 2).map((p) => `${p.type} ${p.bearing} ${p.dist}`),
    ring: `${ring.closing ? 'shrinking, ' : ''}${ring.outside ? 'outside' : 'inside'}, edge ${ring.edge}, centre ${ring.centre}`,
    time_left: sc.time_left_s,
  };
}
export function compactStateText(scene, weapons) {
  if (scene.model_aims) {
    const sc = compactScene(scene);
    // Compact aliases retain identities and every decision fact within Laya's question limit.
    const small = { hp: sc.hp, gun: sc.weapon, ammo: sc.ammo, range: sc.range, ready: sc.ready, last: sc.last_shot,
      enemies: scene.enemies.map((e) => `${e.name} ${e.bearing} ${e.dist} ${e.los ? 'los' : 'hidden'} ${e.hp}hp`),
      incoming: sc.incoming, blocked: sc.blocked, pickups: sc.pickups, ring: sc.ring, time: sc.time_left };
    const cfg = weapons ? normaliseWeapons(weapons) : LEGACY_WEAPON_CONFIG;
    const W = weaponTable(cfg);
    const ranges = enabledWeapons(cfg).map((n) => `${n}:${distBucket(weaponRange(n, W))}${COMPACT_NOTES[n] ? ' ' + COMPACT_NOTES[n](W[n]) : ''}`).join(';');
    return `N up, ${TICK_HZ} ticks/s; los=line of sight; close<40 near<90 mid<160 far. ${ranges}. Empty=pistol; shots end at range. Ring shrinks ${RING_START / TICK_HZ}s; outside -${RING_DPS}hp/s.\n` + AIM_RULE + '\n' + JSON.stringify(small);
  }
  return compactRulesText(weapons) + '\n' + JSON.stringify(compactScene(scene));
}

// Which prompt a fighter gets, and its text. Every 'full' fighter gets byte-identical text.
export const promptVariant = (fighter) => fighter?.prompt === 'compact' ? 'compact' : 'full';
export function stateTextFor(fighter, scene, weapons) {
  return promptVariant(fighter) === 'compact' ? compactStateText(scene, weapons) : stateText(scene, weapons);
}

// One question for every decision model: the action Choice. Same key for the TypeSafe and /v1/evaluate shapes.
export function decisionQuestions(variant = 'full', scene) {
  if (scene?.model_aims) {
    const compact = variant === 'compact';
    const base = compact ? { advance: 'towards nearest enemy', retreat: 'away from nearest enemy', spin_left: 'anticlockwise dodge', spin_right: 'clockwise dodge', take_cover: 'pillar cover', grab_pickup: 'nearest useful pickup', hold: 'do nothing' } : ACTION_CRITERIA;
    return { action: { type: 'choice', instructions: compact ? 'Last alive wins. Choose.' : ACTION_INSTRUCTIONS,
      criteria: Object.fromEntries(actionsFor(scene).map((a) => [a, a.startsWith('shoot_')
        ? (compact ? `fire at ${a.slice(6)}; los; range matters` : `fire the current weapon at ${a.slice(6)}; needs line of sight; weapon range matters`) : base[a]])) } };
  }
  return variant === 'compact'
    ? { action: { type: 'choice', instructions: COMPACT_ACTION_INSTRUCTIONS, criteria: COMPACT_ACTION_CRITERIA } }
    : { action: { type: 'choice', instructions: ACTION_INSTRUCTIONS, criteria: ACTION_CRITERIA } };
}
// Estimated input tokens for one question: state text plus instructions plus every option and criterion.
export function questionTokens(text, variant = 'full', scene) {
  const q = decisionQuestions(variant, scene).action;
  const crit = Object.entries(q.criteria).map(([k, v]) => `${k}: ${v}`).join('\n');
  return estimateTokens(`${text}\n${q.instructions}\n${crit}`);
}

// System prompt for the chat baseline (Gemini Flash, prompted for JSON).
export function chatSystemPrompt(scene) {
  const criteria = decisionQuestions('full', scene).action.criteria;
  const opts = Object.entries(criteria).map(([a, c]) => `- ${a}: ${c}`).join('\n');
  return (
    ACTION_INSTRUCTIONS +
    '\nOptions:\n' + opts +
    '\nReply with JSON only: {"action": one option, "confidence": 0..1}.'
  );
}

export function chatSchema(scene) {
  return { ...CHAT_SCHEMA, properties: { ...CHAT_SCHEMA.properties, action: { type: 'string', enum: actionsFor(scene) } } };
}
export const CHAT_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ACTIONS },
    confidence: { type: 'number' },
  },
  required: ['action', 'confidence'],
  additionalProperties: false,
};

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
