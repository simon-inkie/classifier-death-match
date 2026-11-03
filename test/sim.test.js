import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, applyAction, step, sceneFor, hashState, runLog, ReplayCursor, bearing, distBucket,
  effectiveAction, ACTION_HOLD_TICKS, CENTRE, MAX_HP, WEAPONS, weaponRange, FIGHTER_R, PICKUP_R } from '../public/sim.js';
import { runHeadlessMock } from '../public/brain.js';
import { ROSTER, rosterById, stateText, DEFAULT_ROSTER, MAX_FIGHTERS, RULES_TEXT } from '../public/shared.js';
import { buildRequest, parseResponse, checkBudget } from '../adapters.js';
import { compactStateText, compactRulesText, promptVariant, questionTokens, COMPACT_TOKEN_BUDGET, PROMPT_TOKEN_LIMIT } from '../public/shared.js';
import { worstCaseScene, WORST_WEAPONS } from '../scripts/worst-case.js';
import { spaceAction } from '../public/controls.js';

const clone = (x) => JSON.parse(JSON.stringify(x));

test('same seed + same log gives an identical match, tick by tick', () => {
  const { log } = runHeadlessMock({ seed: 42 });
  const a = new ReplayCursor(clone(log));
  const b = new ReplayCursor(clone(log));
  while (!a.state.over) {
    a.tick(); b.tick();
    assert.equal(hashState(a.state), hashState(b.state), `diverged at tick ${a.state.tick}`);
  }
  assert.ok(b.state.over);
  assert.equal(hashState(a.state), log.result.hash, 'replay matches the recorded final hash');
  assert.equal(a.state.winner, log.result.winner);
});

test('replay is exact across several seeds, and a changed log changes the result', () => {
  for (const seed of [1, 2, 3, 99]) {
    const { log } = runHeadlessMock({ seed });
    assert.equal(hashState(runLog(clone(log))), log.result.hash, `seed ${seed}`);
  }
  const { log } = runHeadlessMock({ seed: 5 });
  const tampered = clone(log);
  const d = tampered.decisions.find((x) => x.a === 'shoot');
  d.a = 'retreat';
  assert.notEqual(hashState(runLog(tampered)), log.result.hash);
});

test('the bot is off by default; with or without it, the log records the roster and replays exactly', () => {
  const without = runHeadlessMock({ seed: 7 }).log;
  const withBot = runHeadlessMock({ seed: 7, bot: true }).log;
  assert.deepEqual(without.roster.map((r) => r.id), ['jev', 'luna', 'laya', 'scaledown']);
  assert.equal(without.bot, false);
  assert.ok(!without.decisions.some((d) => d.f === 'bot'));
  assert.deepEqual(withBot.roster.map((r) => r.id), ['jev', 'luna', 'laya', 'scaledown', 'bot']);
  assert.equal(withBot.bot, true);
  assert.ok(withBot.decisions.some((d) => d.f === 'bot'));
  for (const log of [without, withBot]) {
    const a = new ReplayCursor(clone(log)), b = new ReplayCursor(clone(log));
    while (!a.state.over) { a.tick(); b.tick(); assert.equal(hashState(a.state), hashState(b.state)); }
    assert.equal(hashState(a.state), log.result.hash, `bot=${log.bot}`);
    // a second run with the same seed and roster is identical too
    assert.equal(runHeadlessMock({ seed: 7, bot: log.bot }).log.result.hash, log.result.hash);
  }
  // the roster is load-bearing: dropping the bot from a with-bot log changes the replay
  const stripped = clone(withBot);
  stripped.roster = stripped.roster.filter((r) => r.id !== 'bot');
  assert.notEqual(hashState(runLog(stripped)), withBot.result.hash);
});

test('different seeds rotate spawns', () => {
  const ids = ROSTER.map((r) => r.id);
  const a = createMatch({ seed: 1, roster: ids }), b = createMatch({ seed: 2, roster: ids });
  assert.notDeepEqual([a.fighters[0].x, a.fighters[0].y], [b.fighters[0].x, b.fighters[0].y]);
});

test('an action lapses to hold ~300 ms after it was applied (pending call)', () => {
  const s = createMatch({ seed: 1, roster: ['jev', 'bot'] });
  applyAction(s, 'jev', 'advance');
  const f = s.fighters[0];
  for (let i = 0; i < ACTION_HOLD_TICKS; i++) step(s);
  assert.equal(effectiveAction(s, f), 'advance');
  step(s);
  assert.equal(effectiveAction(s, f), 'hold');
  applyAction(s, 'jev', 'stunned');
  assert.equal(effectiveAction(s, f), 'hold');
  assert.equal(f.stunned, true);
});

test('bucketing helpers', () => {
  assert.equal(bearing(1, 0), 'E');
  assert.equal(bearing(0, -1), 'N');
  assert.equal(bearing(0, 1), 'S');
  assert.equal(bearing(-1, -1), 'NW');
  assert.equal(distBucket(10), 'close');
  assert.equal(distBucket(60), 'near');
  assert.equal(distBucket(120), 'mid');
  assert.equal(distBucket(300), 'far');
});

test('scene: enemy bearing, distance, line of sight, incoming fire, walls, pickups', () => {
  const s = createMatch({ seed: 0, roster: ['jev', 'luna'] });
  s.pillars = [{ x: CENTRE, y: CENTRE }];
  const [me, foe] = s.fighters;
  me.x = CENTRE - 60; me.y = CENTRE; foe.x = CENTRE + 60; foe.y = CENTRE;
  let sc = sceneFor(s, 'jev');
  assert.equal(sc.enemies[0].bearing, 'E');
  assert.equal(sc.enemies[0].dist, 'mid');
  assert.equal(sc.enemies[0].los, false, 'pillar in the middle blocks the view');
  assert.equal(sc.hp, 100);
  assert.equal(sc.weapon, 'pistol');
  assert.equal(sc.incoming, null);

  foe.y = CENTRE - 80; // move out from behind the pillar
  sc = sceneFor(s, 'jev');
  assert.equal(sc.enemies[0].los, true);
  assert.equal(sc.enemies[0].bearing, 'NE');

  s.bullets.push({ x: me.x + 30, y: me.y, vx: -7, vy: 0, dmg: 4, owner: 'luna', life: 30 });
  sc = sceneFor(s, 'jev');
  assert.deepEqual(sc.incoming, { kind: 'bullet', bearing: 'E', eta_ticks: 5 });

  me.x = CENTRE - 182; me.y = CENTRE; // against the west wall
  sc = sceneFor(s, 'jev');
  assert.ok(sc.blocked.includes('W'));
  assert.ok(!sc.blocked.includes('E'));
  assert.ok(sc.pickups.length > 0 && sc.pickups.length <= 3);
});

test('incoming: a missile counts by its blast, an enemy flamethrower pointing at us counts as flame', () => {
  const s = createMatch({ seed: 0, roster: ['jev', 'luna'] });
  s.pillars = [];
  const [me, foe] = s.fighters;
  me.x = CENTRE; me.y = CENTRE; foe.x = CENTRE + 150; foe.y = CENTRE + 150; foe.face = 0;
  const blast = WEAPONS.missile.blast;
  // passes 20 to the side: a bullet would miss, the blast would not
  s.bullets.push({ x: me.x + 35, y: me.y - 20, vx: -3.5, vy: 0, dmg: 32, owner: 'luna', life: 40, w: 'missile' });
  assert.deepEqual(sceneFor(s, 'jev').incoming, { kind: 'missile', bearing: 'NE', eta_ticks: 10 });
  s.bullets[0].y = me.y - (blast + FIGHTER_R + 2); // clear of the blast
  assert.equal(sceneFor(s, 'jev').incoming, null);
  s.bullets[0].y = me.y - 20; s.bullets[0].owner = 'jev'; // our own missile is not hostile fire
  assert.equal(sceneFor(s, 'jev').incoming, null);
  s.bullets = [];
  // flamethrower: in range and facing us = flame; facing away = nothing
  foe.x = me.x + 30; foe.y = me.y; foe.weapon = 'flamethrower'; foe.ammo = 4; foe.cd = 3; foe.face = Math.PI;
  assert.deepEqual(sceneFor(s, 'jev').incoming, { kind: 'flame', bearing: 'E', eta_ticks: 3 });
  foe.flame = 5;
  assert.equal(sceneFor(s, 'jev').incoming.eta_ticks, 0, 'burning now');
  foe.flame = 0; foe.face = 0;
  assert.equal(sceneFor(s, 'jev').incoming, null);
});

test('every model gets the same state text; requests use the documented shapes', () => {
  const s = createMatch({ seed: 3, roster: ROSTER.map((r) => r.id) });
  const scene = sceneFor(s, 'jev');
  const jev = buildRequest(rosterById.jev, scene), luna = buildRequest(rosterById.luna, scene);
  const gem = buildRequest(rosterById.gemini, scene);
  assert.match(jev.url, /\/typesafe\/v1\/systemone$/);
  assert.match(luna.url, /\/v1\/evaluate$/);
  assert.match(gem.url, /\/v1\/chat\/completions$/);
  assert.equal(jev.body.state, stateText(scene));
  assert.equal(luna.body.state, jev.body.state);
  assert.equal(gem.body.messages[1].content, jev.body.state);
  assert.equal(jev.body.questions.action.type, 'choice');
  // one question for every decision model: the action choice (no threat score)
  assert.deepEqual(Object.keys(jev.body.questions), ['action']);
  assert.deepEqual(luna.body.questions, jev.body.questions);
  assert.ok(!('threat' in gem.body.response_format.json_schema.schema.properties));
  // Laya: same route and shape, compact prompt variant (512-token question limit)
  const laya = buildRequest(rosterById.laya, scene);
  assert.match(laya.url, /\/v1\/evaluate$/);
  assert.equal(laya.body.state, compactStateText(scene));
  assert.deepEqual(Object.keys(laya.body.questions), ['action']);
  assert.deepEqual(Object.keys(laya.body.questions.action.criteria), Object.keys(jev.body.questions.action.criteria));
  // ScaleDown: TypeSafe-compatible route, same text wrapped as {text}, one Choice, provider pinned
  const sd = buildRequest(rosterById.scaledown, scene);
  assert.match(sd.url, /\/typesafe\/v1\/systemone$/);
  assert.equal(sd.body.model, 'scaledown/scaledown-classify-1');
  assert.deepEqual(sd.body.state, { text: jev.body.state });
  assert.deepEqual(Object.keys(sd.body.questions), ['action']);
  assert.deepEqual(sd.body.questions.action, jev.body.questions.action);
  assert.deepEqual(sd.body.providerOptions, { gateway: { only: ['scaledown'] } });
});

test('response parsing: TypeSafe snake_case, evaluate camelCase, chat JSON', () => {
  const probs = { advance: 0.1, retreat: 0, strafe_left: 0, strafe_right: 0, shoot: 0.8, take_cover: 0.1, grab_pickup: 0, hold: 0 };
  const ts = parseResponse(rosterById.jev, { answers: { action: { type: 'choice', choice: 'shoot', probabilities: probs },
    threat: { type: 'score', score: 1 } }, usage: { input_tokens: 700, output_tokens: 0 },
    provider_metadata: { gateway: { cost: '0.0000294' } } });
  assert.equal(ts.action, 'shoot'); assert.equal(ts.probs.shoot, 0.8); assert.equal('threat' in ts, false, 'stray threat ignored');
  assert.equal(ts.usage.in, 700); assert.equal(ts.cost, 0.0000294);
  const ev = parseResponse(rosterById.luna, { answers: { action: { type: 'choice', choice: 'hold', probabilities: probs } },
    usage: { inputTokens: 600, outputTokens: 0 }, providerMetadata: { gateway: { cost: '0.00006' } } });
  assert.equal(ev.action, 'hold'); assert.equal(ev.usage.in, 600);
  const ch = parseResponse(rosterById.gemini, { choices: [{ message: { content: '{"action":"advance","confidence":0.8}' } }],
    usage: { prompt_tokens: 478, completion_tokens: 15 } });
  assert.equal(ch.action, 'advance'); assert.equal(ch.probs, null); assert.equal(ch.confidence, 0.8);
  assert.throws(() => parseResponse(rosterById.gemini, { choices: [{ message: { content: '{"action":"dance","confidence":1}' } }] }));
});

test('ScaleDown response (TypeSafe shape) parses', () => {
  const probs = { advance: 0.05, retreat: 0, strafe_left: 0, strafe_right: 0, shoot: 0.9, take_cover: 0.05, grab_pickup: 0, hold: 0 };
  const r = parseResponse(rosterById.scaledown, { model: 'scaledown/scaledown-classify-1',
    answers: { action: { type: 'choice', choice: 'shoot', confidence: 0.9, probabilities: probs } },
    usage: { input_tokens: 700, output_tokens: 1 }, provider_metadata: { gateway: { cost: '0.000035' } } });
  assert.equal(r.action, 'shoot'); assert.equal(r.cost, 0.000035);
});

// ---------- roster
test('roster: four classifiers by default, Gemini and the bot opt-in, up to six fighters', () => {
  assert.deepEqual(DEFAULT_ROSTER, ['jev', 'luna', 'laya', 'scaledown']);
  assert.equal(rosterById.gemini.on, false);
  assert.equal(rosterById.bot.on, false);
  assert.equal(MAX_FIGHTERS, 6);
  assert.equal(ROSTER.length, 6);
  for (const r of ROSTER) assert.match(r.colour, /^#[0-9a-f]{6}$/i);
  assert.equal(new Set(ROSTER.map((r) => r.colour)).size, ROSTER.length, 'distinct colours');
  const all = ROSTER.map((r) => r.id);
  const s = createMatch({ seed: 4, roster: all });
  const spots = new Set(s.fighters.map((f) => `${Math.round(f.x)},${Math.round(f.y)}`));
  assert.equal(spots.size, 6, 'six distinct spawns');
  // a six-fighter match with Gemini plays out and replays exactly
  const { log } = runHeadlessMock({ seed: 3, roster: all });
  assert.equal(hashState(runLog(clone(log))), log.result.hash);
});

// ---------- Jev jitter fix: medpacks at full HP, and pickups underfoot, are not targets
test('grab_pickup and the scene ignore a medpack at full HP and anything already underfoot', () => {
  const s = createMatch({ seed: 1, roster: ['jev', 'luna'] });
  const me = s.fighters[0];
  const med = s.pickups.find((p) => p.type === 'medpack');
  for (const p of s.pickups) if (p !== med) p.active = false;
  me.x = med.x; me.y = med.y; // standing on it at full HP
  assert.equal(me.hp, MAX_HP);
  assert.equal(sceneFor(s, 'jev').pickups.length, 0, 'no usable pickups listed');
  applyAction(s, 'jev', 'grab_pickup');
  const x0 = me.x, y0 = me.y;
  step(s);
  assert.ok(Math.hypot(me.x - x0, me.y - y0) < 1e-6, 'does not wander around the medpack');
  assert.ok(med.active, 'medpack not consumed at full HP');
  // once hurt it becomes a target again (and is collected when we stand on it)
  me.hp = 50;
  step(s);
  assert.equal(med.active, false);
  assert.equal(me.hp, 85);
  // a far medpack at full HP is not listed, a weapon is
  const t = createMatch({ seed: 1, roster: ['jev', 'luna'] });
  const types = sceneFor(t, 'jev').pickups.map((p) => p.type);
  assert.ok(!types.includes('medpack'));
  t.fighters[0].hp = 40;
  const all = t.pickups.filter((p) => p.active).map((p) => p.type);
  assert.ok(all.includes('medpack'));
});

// ---------- new weapons
function duel(weapon, dist, seed = 1) {
  const s = createMatch({ seed, roster: ['jev', 'luna'] });
  s.pillars = []; s.pickups = [];
  const [a, b] = s.fighters;
  a.x = CENTRE - dist / 2; a.y = CENTRE; b.x = CENTRE + dist / 2; b.y = CENTRE;
  a.weapon = weapon; a.ammo = WEAPONS[weapon].ammo;
  return { s, a, b };
}

test('new weapons are spawned as pickups, symmetric per slot and chosen by the seed', () => {
  const kinds = (seed, n) => createMatch({ seed, roster: ROSTER.slice(0, n).map((r) => r.id) }).pickups.map((p) => p.type);
  for (const n of [2, 4, 6]) {
    const k = kinds(1, n);
    for (const w of ['uzi', 'missile', 'flamethrower', 'shotgun', 'medpack']) assert.equal(k.filter((x) => x === w).length, n, `${w} x${n}`);
    assert.equal(k.filter((x) => x === 'rifle').length, 1);
  }
  assert.deepEqual(kinds(7, 4), kinds(7, 4), 'same seed, same layout');
  assert.notDeepEqual(kinds(1, 4), kinds(2, 4), 'seed changes which weapon sits where');
});

test('uzi: very fast, low damage, ~30 rounds, then back to the pistol', () => {
  const { s, a, b } = duel('uzi', 60);
  applyAction(s, 'jev', 'shoot');
  for (let i = 0; i < 40; i++) { s.fighters[0].actionTick = s.tick; step(s); }
  assert.ok(a.shots >= 9, `fired ${a.shots} in 40 ticks`);
  assert.ok(b.hp < MAX_HP && b.hp > MAX_HP - a.shots * WEAPONS.uzi.dmg - 1);
  assert.equal(a.ammo, WEAPONS.uzi.ammo - a.shots);
  for (let i = 0; i < 200 && a.weapon === 'uzi'; i++) { a.actionTick = s.tick; b.hp = MAX_HP; step(s); }
  assert.equal(a.weapon, 'pistol');
  assert.equal(weaponRange('uzi') < 160 && weaponRange('uzi') >= 90, true, 'mid range');
});

test('missile: slow, area damage, and it hurts the shooter at close range', () => {
  const far = duel('missile', 100);
  applyAction(far.s, 'jev', 'shoot');
  step(far.s);
  assert.equal(far.s.bullets.length, 1);
  assert.equal(far.s.bullets[0].w, 'missile');
  let boom = null;
  for (let i = 0; i < 60 && !boom; i++) { far.a.actionTick = far.s.tick - 100; step(far.s); boom = far.s.events.find((e) => e.type === 'explode'); }
  assert.ok(boom, 'exploded');
  assert.equal(boom.r, WEAPONS.missile.blast);
  assert.ok(far.b.hp <= MAX_HP - WEAPONS.missile.dmg / 2, `target took blast damage (hp ${far.b.hp})`);
  assert.equal(far.a.hp, MAX_HP, 'shooter far enough away');
  assert.equal(far.a.lastShot, 'hit');
  assert.equal(far.a.ammo, WEAPONS.missile.ammo - 1);
  // point blank: both take damage
  const near = duel('missile', 20);
  applyAction(near.s, 'jev', 'shoot');
  for (let i = 0; i < 10; i++) step(near.s);
  assert.ok(near.b.hp < MAX_HP);
  assert.ok(near.a.hp < MAX_HP, 'own blast hurts the shooter');
});

test('flamethrower: close cone, damage every tick of the burst, limited fuel, useless at range', () => {
  const { s, a, b } = duel('flamethrower', 24);
  applyAction(s, 'jev', 'shoot');
  step(s);
  assert.equal(a.flame, WEAPONS.flamethrower.burst - 1);
  for (let i = 0; i < WEAPONS.flamethrower.burst; i++) step(s);
  const burstDmg = MAX_HP - b.hp;
  assert.equal(burstDmg, WEAPONS.flamethrower.burst * WEAPONS.flamethrower.dmg);
  assert.equal(a.lastShot, 'hit');
  assert.equal(a.ammo, WEAPONS.flamethrower.ammo - 1);
  assert.equal(s.bullets.length, 0, 'no projectiles');
  // out of range: no damage, last_shot says so
  const far = duel('flamethrower', 120);
  applyAction(far.s, 'jev', 'shoot');
  for (let i = 0; i < WEAPONS.flamethrower.burst + 1; i++) step(far.s);
  assert.equal(far.b.hp, MAX_HP);
  assert.equal(far.a.lastShot, 'out_of_range');
  assert.deepEqual(sceneFor(far.s, 'jev').last_shot.result, 'out_of_range');
});

test('scene: weapon range, last shot, ring edge; rules text covers every weapon', () => {
  const { s, a } = duel('pistol', 300);
  let sc = sceneFor(s, 'jev');
  assert.equal(sc.range, 'far');
  assert.deepEqual(sc.last_shot, { result: 'none' });
  assert.ok(['close', 'near', 'mid', 'far'].includes(sc.ring.edge));
  assert.equal(sc.ring.centre, 'E');
  a.weapon = 'shotgun'; a.ammo = 6;
  sc = sceneFor(s, 'jev');
  assert.equal(sc.range, 'near');
  applyAction(s, 'jev', 'shoot');
  for (let i = 0; i < 20; i++) { a.actionTick = s.tick; step(s); }
  sc = sceneFor(s, 'jev');
  assert.equal(sc.last_shot.result, 'out_of_range');
  assert.ok(sc.last_shot.ticks_ago >= 0);
  for (const w of Object.keys(WEAPONS)) assert.match(RULES_TEXT, new RegExp(`- ${w}: range (close|near|mid|far)`));
  assert.match(RULES_TEXT, /ring\.edge/);
  assert.ok(stateText(sc).includes(RULES_TEXT));
});

// ---------- prompt variants and size
test('Jev, Luna, ScaleDown and Gemini get identical text; Laya gets the compact variant of the same facts', () => {
  const sc = worstCaseScene();
  const texts = ['jev', 'luna', 'scaledown', 'gemini'].map((id) => {
    const b = buildRequest(rosterById[id], sc, undefined, WORST_WEAPONS).body;
    return b.messages ? b.messages[1].content : b.state.text ?? b.state;
  });
  for (const t of texts) assert.equal(t, texts[0]);
  assert.equal(texts[0], stateText(sc, WORST_WEAPONS));
  assert.deepEqual(ROSTER.filter((r) => promptVariant(r) === 'compact').map((r) => r.id), ['laya']);
  const c = compactStateText(sc, WORST_WEAPONS);
  for (const w of Object.keys(WEAPONS)) assert.match(c, new RegExp(`${w} (close|near|mid|far)`));
  assert.match(c, /hurts you too/); assert.match(c, /in cone/); assert.match(c, /vanish at range/); assert.match(c, /Ring shrinks from 60s/);
  assert.match(c, /"incoming":"missile NW 44t"/);
  const off = clone(WORST_WEAPONS); off.missile.on = false; off.flamethrower.on = false;
  assert.ok(!/missile|flamethrower/.test(compactRulesText(off)), 'disabled weapons absent');
});

test('Laya worst-case question (state + instructions + criteria) is under the token budget', () => {
  const text = compactStateText(worstCaseScene(), WORST_WEAPONS);
  const tokens = questionTokens(text, 'compact');
  assert.ok(tokens <= COMPACT_TOKEN_BUDGET, `~${tokens} est tokens > ${COMPACT_TOKEN_BUDGET}`);
  assert.ok(COMPACT_TOKEN_BUDGET < PROMPT_TOKEN_LIMIT);
  assert.equal(checkBudget(rosterById.laya, text).over, false);
  assert.equal(checkBudget(rosterById.laya, text + 'x'.repeat(400), 0).over, true, 'guard flags an oversized prompt');
  // a real six-fighter scene from the sim is smaller than the synthetic worst case
  const s = createMatch({ seed: 2, roster: ROSTER.map((r) => r.id), weapons: WORST_WEAPONS });
  assert.ok(compactStateText(sceneFor(s, 'laya'), WORST_WEAPONS).length <= text.length);
});

test('logs record the prompt variant per fighter', () => {
  const { log } = runHeadlessMock({ seed: 4, roster: ['jev', 'laya', 'bot'] });
  assert.deepEqual(log.roster.map((r) => r.prompt), ['full', 'compact', null]);
  assert.ok(!log.decisions.some((d) => 'threat' in d));
});

// ---------- pause / restart
test('space starts, pauses and resumes; it never restarts', () => {
  assert.equal(spaceAction({ running: false, paused: false, results: false }), 'start');
  assert.equal(spaceAction({ running: true, paused: false, results: false }), 'pause');
  assert.equal(spaceAction({ running: true, paused: true, results: false }), 'resume');
  assert.equal(spaceAction({ running: false, paused: false, results: true }), 'none');
});

test('answers held over a pause and applied on resume still replay exactly', () => {
  // Simulate a pause: from tick 300 every answer that lands is held, then all are applied on one tick.
  const { log } = runHeadlessMock({ seed: 11 });
  const held = clone(log);
  for (const d of held.decisions) if (d.t >= 300 && d.t < 330) d.t = 330;
  const replayed = runLog(held);
  held.result = { hash: hashState(replayed) };
  assert.equal(hashState(runLog(clone(held))), held.result.hash);
  // restart = a fresh match from the same seed: identical starting state
  assert.equal(hashState(createMatch({ seed: 11, roster: DEFAULT_ROSTER })), hashState(createMatch({ seed: 11, roster: DEFAULT_ROSTER })));
});

// ---------- weapon config
import { DEFAULT_WEAPON_CONFIG, normaliseWeapons, configId } from '../public/weapons.js';
import { rulesText } from '../public/shared.js';
import { buildRecord, cleanRecord, aggregate, placesFor } from '../public/leaderboard.js';

const noMissile = () => { const c = clone(DEFAULT_WEAPON_CONFIG); c.missile.on = false; c.rifle.dmg = 22; return c; };

test('weapon config: validated and clamped; disabled weapons never spawn or appear in the rules text', () => {
  assert.equal(DEFAULT_WEAPON_CONFIG.flamethrower.on, false, 'flamethrower off by default');
  const n = normaliseWeapons({ pistol: { on: false, dmg: 9999 }, rifle: { cd: -5, ammo: 'x' }, junk: {} });
  assert.equal(n.pistol.on, true, 'pistol cannot be disabled');
  assert.equal(n.pistol.dmg, 100);
  assert.equal(n.rifle.cd, 2);
  assert.equal(n.rifle.ammo, WEAPONS.rifle.ammo);
  assert.equal(n.junk, undefined);
  const cfg = noMissile();
  const s = createMatch({ seed: 3, roster: DEFAULT_ROSTER, weapons: cfg });
  const kinds = s.pickups.map((p) => p.type);
  assert.ok(!kinds.includes('missile') && !kinds.includes('flamethrower'));
  assert.ok(kinds.includes('uzi') && kinds.includes('rifle') && kinds.includes('medpack'));
  // cover and the other pickups keep their places
  const all = createMatch({ seed: 3, roster: DEFAULT_ROSTER });
  assert.deepEqual(s.pillars, all.pillars);
  const pos = (p) => `${p.type}@${p.x.toFixed(3)},${p.y.toFixed(3)}`;
  assert.deepEqual(s.pickups.map(pos), all.pickups.filter((p) => p.type !== 'missile' && p.type !== 'flamethrower').map(pos));
  // tuned numbers reach the sim and the rules text; every model gets the same text
  assert.equal(s.W.rifle.dmg, 22);
  const rules = rulesText(cfg);
  assert.ok(!/missile|flamethrower/.test(rules), 'disabled weapons not mentioned');
  assert.match(rules, /- rifle: range far, 22 dmg/);
  const scene = sceneFor(s, 'jev');
  const texts = ['jev', 'luna', 'laya', 'gemini'].map((id) => buildRequest(rosterById[id], scene, undefined, cfg));
  assert.equal(texts[0].body.state, stateText(scene, cfg));
  assert.equal(texts[1].body.state, texts[0].body.state);
  assert.equal(texts[3].body.messages[1].content, texts[0].body.state);
  assert.ok(!texts[0].body.state.includes('missile'));
});

test('weapon config is part of the match: saved in the log, replays exactly, and is a hash input', () => {
  const cfg = noMissile();
  const { log } = runHeadlessMock({ seed: 8, weapons: cfg });
  assert.deepEqual(log.weapons, normaliseWeapons(cfg));
  assert.equal(log.weaponsId, configId(normaliseWeapons(cfg)));
  const a = new ReplayCursor(clone(log)), b = new ReplayCursor(clone(log));
  while (!a.state.over) { a.tick(); b.tick(); assert.equal(hashState(a.state), hashState(b.state)); }
  assert.equal(hashState(a.state), log.result.hash);
  assert.ok(!a.state.pickups.some((p) => p.type === 'missile'));
  // replaying with another config does not verify
  const other = clone(log); other.weapons.rifle.dmg = 23;
  assert.notEqual(hashState(runLog(other)), log.result.hash);
  // a log without a config (older logs) replays with every weapon on
  const legacy = clone(log); delete legacy.weapons;
  assert.ok(new ReplayCursor(legacy).state.pickups.some((p) => p.type === 'flamethrower'));
});

// ---------- leaderboard
test('leaderboard: records accumulate per fighter, mock is excluded by default, ties share a place', () => {
  const recs = [];
  for (const seed of [1, 2, 3]) {
    const { state, log } = runHeadlessMock({ seed, weapons: noMissile() });
    const stats = Object.fromEntries(log.roster.map((r) => {
      const ds = log.decisions.filter((d) => d.f === r.id);
      return [r.id, { lat: ds.filter((d) => !d.err).map((d) => d.ms), errors: ds.filter((d) => d.err).length,
        timeouts: ds.filter((d) => /timeout/.test(d.err || '')).length, decisions: ds.length }];
    }));
    recs.push(cleanRecord(buildRecord({ state, mode: seed === 3 ? 'mock' : 'live', weapons: log.weapons, stats })));
  }
  const live = aggregate(recs);
  assert.equal(live.reduce((n, a) => n + a.wins, 0), 2, 'two live matches, two wins');
  for (const a of live) assert.equal(a.played, 2);
  const withMock = aggregate(recs, { includeMock: true });
  assert.equal(withMock.reduce((n, a) => n + a.wins, 0), 3);
  const kills = recs.reduce((n, r) => n + r.fighters.reduce((k, f) => k + f.kills, 0), 0);
  assert.equal(withMock.reduce((n, a) => n + a.kills, 0), kills);
  for (let i = 1; i < withMock.length; i++) {
    const p = withMock[i - 1], q = withMock[i];
    assert.ok(p.wins > q.wins || (p.wins === q.wins && p.avgPlace <= q.avgPlace), 'sorted by wins then average place');
  }
  assert.equal(aggregate(recs, { includeMock: true, cfgId: 'nope' }).length, 0, 'config filter');
  assert.ok(!live.some((a) => a.id === 'gemini' || a.id === 'bot'), 'only fighters that played');
  // a time-up draw on HP still records a winner, shares first place, and says so
  const s = createMatch({ seed: 1, roster: ['jev', 'luna', 'laya'] });
  s.fighters[2].alive = false; s.fighters[2].hp = 0; s.fighters[2].deathTick = 100;
  s.tick = 2700; s.over = true; s.ranking = ['luna', 'jev', 'laya']; s.winner = 'luna';
  const pl = placesFor(s);
  assert.deepEqual([pl.luna, pl.jev, pl.laya], [1, 1, 3]);
  const r = buildRecord({ state: s, mode: 'live', weapons: DEFAULT_WEAPON_CONFIG, stats: {} });
  assert.equal(r.winner, 'luna'); assert.equal(r.tie, true); assert.match(r.note, /time up/);
  assert.throws(() => cleanRecord({ ...r, mode: 'replay' }));
  assert.throws(() => cleanRecord({ ...r, winner: 'nobody' }));
});

// ---------- bundled example logs must keep verifying (they are the open-source demo)
import fs from 'node:fs';
test('bundled example replay logs verify', () => {
  const dir = new URL('../examples/', import.meta.url);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : [];
  for (const f of files) {
    const log = JSON.parse(fs.readFileSync(new URL(f, dir), 'utf8'));
    assert.equal(hashState(runLog(log)), log.result.hash, f);
  }
});
