import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatch, applyAction, step, sceneFor, hashState, runLog, ReplayCursor, normaliseLog, bearing, distBucket,
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

test('overlapping fighters separate within a few ticks and do not oscillate, even from the same spot', () => {
  const X = CENTRE + 70, Y = CENTRE + 70; // open ground: no pillar, pickup or wall nearby
  for (const gap of [0, 1e-12, 3, 9]) {
    for (const [actA, actB] of [['hold', 'hold'], ['advance', 'advance'], ['spin_left', 'spin_left'], ['spin_right', 'advance'], ['retreat', 'hold']]) {
      const s = createMatch({ seed: 1, roster: ['jev', 'luna'] });
      const [A, B] = s.fighters;
      A.x = X; A.y = Y; B.x = X + gap; B.y = Y;
      const dist = () => Math.hypot(B.x - A.x, B.y - A.y);
      const steps = [];
      for (let t = 0; t < 12; t++) {
        applyAction(s, 'jev', actA); applyAction(s, 'luna', actB);
        step(s);
        steps.push(dist());
      }
      const label = `gap ${gap}, ${actA}/${actB}`;
      assert.ok(steps[2] >= FIGHTER_R * 2 - 1e-6, `${label}: separated by tick 3 (${steps[2]})`);
      for (const d of steps.slice(2)) assert.ok(d >= FIGHTER_R * 2 - 1e-6, `${label}: stays apart (${d})`);
      assert.ok(A.alive && B.alive && A.hp === MAX_HP && B.hp === MAX_HP, `${label}: no damage from contact`);
    }
    // standing still once apart: positions settle, no back-and-forth
    const s = createMatch({ seed: 1, roster: ['jev', 'luna'] });
    const [A, B] = s.fighters;
    A.x = X; A.y = Y; B.x = X + gap; B.y = Y;
    step(s);
    const settled = [A.x, A.y, B.x, B.y];
    for (let t = 0; t < 10; t++) step(s);
    assert.deepEqual([A.x, A.y, B.x, B.y], settled, `gap ${gap}: settled, no jitter`);
    if (gap === 0) assert.ok(A.x < B.x, 'coincident: earlier roster slot goes west, deterministically');
  }
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
  const probs = { advance: 0.1, retreat: 0, spin_left: 0, spin_right: 0, shoot: 0.8, take_cover: 0.1, grab_pickup: 0, hold: 0 };
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
  const probs = { advance: 0.05, retreat: 0, spin_left: 0, spin_right: 0, shoot: 0.9, take_cover: 0.05, grab_pickup: 0, hold: 0 };
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
    for (const w of ['uzi', 'missile', 'flamethrower', 'shotgun', 'medpack', 'rifle']) assert.equal(k.filter((x) => x === w).length, n, `${w} x${n}`);
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
  assert.match(c, /hurts you too/); assert.match(c, /in cone/); assert.match(c, /vanish at range/); assert.match(c, /Ring shrinks from 30s/);
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
  assert.equal(spaceAction({ running: false, paused: false, results: false, celebrating: true }), 'skip', 'space during the celebration only skips to the stats');
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
import { DEFAULT_WEAPON_CONFIG, normaliseWeapons, configId, configSummary } from '../public/weapons.js';
import { rulesText } from '../public/shared.js';
import { sortStandings, mostKillsIds, buildRecord, cleanRecord, aggregate, placesFor, celebrationText } from '../public/leaderboard.js';

const noMissile = () => { const c = clone(DEFAULT_WEAPON_CONFIG); c.missile.on = false; c.rifle.dmg = 22; return c; };

test('weapon config: validated and clamped; disabled weapons never spawn or appear in the rules text', () => {
  assert.equal(DEFAULT_WEAPON_CONFIG.flamethrower.on, false, 'flamethrower off by default');
  const n = normaliseWeapons({ pistol: { on: false, dmg: 9999 }, rifle: { cd: -5, ammo: 'x' }, junk: {} });
  assert.equal(n.pistol.on, true, 'pistol cannot be disabled');
  assert.equal(n.pistol.dmg, 100);
  assert.equal(n.rifle.cd, 2);
  assert.equal(n.rifle.ammo, WEAPONS.rifle.ammo);
  assert.equal(n.junk, undefined);
  const cfg = { ...noMissile(), pickups: { density: 1, respawn: 1 } }; // every spot filled, to compare places
  const s = createMatch({ seed: 3, roster: DEFAULT_ROSTER, weapons: cfg });
  const kinds = s.pickups.map((p) => p.type);
  assert.ok(!kinds.includes('missile') && !kinds.includes('flamethrower'));
  assert.ok(kinds.includes('uzi') && kinds.includes('medpack') && kinds.includes('rifle'));
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

// ---------- pickup density and respawn rate
// Which spawn slot a pickup belongs to: spots sit on a slot angle, half a slot past it, or a quarter slot either side.
function slotCounts(s, n) {
  const counts = new Array(n).fill(0), step = (2 * Math.PI) / n;
  for (const p of s.pickups) {
    const rel = (((Math.atan2(p.y - CENTRE, p.x - CENTRE) + Math.PI / 2) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    counts[Math.floor(rel / step + 0.375) % n]++; // the rifle sits a quarter slot either side of the axis
  }
  return counts;
}
const withPickups = (density, respawn = 1) => ({ ...clone(DEFAULT_WEAPON_CONFIG), pickups: { density, respawn } });

test('pickups: density 0 starts empty, density scales symmetrically per slot, respawn 0 never respawns', () => {
  assert.equal(createMatch({ seed: 5, roster: DEFAULT_ROSTER, weapons: withPickups(0) }).pickups.length, 0, 'density 0: no start pickups');
  const full = createMatch({ seed: 5, roster: DEFAULT_ROSTER, weapons: withPickups(1) }).pickups.length;
  for (const seed of [1, 2, 3, 4, 5, 6]) for (const d of [0.25, 0.5, 0.75, 1.5, 2]) {
    const s = createMatch({ seed, roster: DEFAULT_ROSTER, weapons: withPickups(d) });
    const slotKinds = s.pickups.map((p) => p.type);
    // above 1 the same kinds fill every slot; below 1 every slot gets the same number of spots
    if (d > 1) for (const t of new Set(slotKinds)) assert.equal(slotKinds.filter((x) => x === t).length % DEFAULT_ROSTER.length, 0, `${t} same in every slot (seed ${seed}, density ${d})`);
    else assert.equal(new Set(slotCounts(s, DEFAULT_ROSTER.length)).size, 1, `equal count per slot (seed ${seed}, density ${d})`);
    if (d < 1) assert.ok(s.pickups.length < full); else assert.ok(s.pickups.length > full);
  }
  assert.equal(createMatch({ seed: 5, roster: DEFAULT_ROSTER, weapons: withPickups(2) }).pickups.length, 2 * full, 'density 2 doubles the slot spots');
  // clamped and snapped to the step; a config without the fields means the original behaviour
  assert.deepEqual(normaliseWeapons(withPickups(9, -1)).pickups, { density: 2, respawn: 0 });
  assert.deepEqual(normaliseWeapons({ pickups: { density: 0.6 } }).pickups, { density: 0.5, respawn: 1 });
  assert.deepEqual(normaliseWeapons({}).pickups, { density: 1, respawn: 1 });
  // respawn 0: a taken pickup never comes back, and the rules text says so
  const s = createMatch({ seed: 1, roster: ['jev', 'luna'], weapons: withPickups(1, 0) });
  const me = s.fighters[0], p = s.pickups.find((x) => x.type === 'shotgun');
  me.x = p.x; me.y = p.y;
  step(s);
  assert.equal(p.active, false, 'taken');
  me.x = CENTRE - 150; me.y = CENTRE; // walk away
  for (let i = 0; i < 2000 && !s.over; i++) step(s);
  assert.equal(p.active, false, 'never respawned');
  assert.match(rulesText(withPickups(1, 0)), /Pickups do not respawn\./);
  assert.match(rulesText(withPickups(1, 0.5)), /Pickups respawn after 30 s\./);
  assert.match(rulesText(), /Pickups respawn after 15 s\./);
});

test('pickup settings are part of the config: id, summary, deterministic replay; older logs still verify', () => {
  const cfg = withPickups(0.5, 2);
  assert.notEqual(configId(normaliseWeapons(cfg)), configId(normaliseWeapons(withPickups(1, 2))));
  assert.match(configSummary(normaliseWeapons(cfg)), /pickups x0\.5, respawn x2/);
  // the original 1 and 1 keep the id a config had before these settings existed
  const old = clone(DEFAULT_WEAPON_CONFIG); delete old.pickups;
  assert.equal(configId(normaliseWeapons(old)), configId(normaliseWeapons(withPickups(1, 1))));
  const a = runHeadlessMock({ seed: 9, weapons: cfg }), b = runHeadlessMock({ seed: 9, weapons: cfg });
  assert.equal(a.log.result.hash, b.log.result.hash, 'same config + seed, same match');
  assert.deepEqual(a.log.weapons.pickups, { density: 0.5, respawn: 2 });
  assert.equal(hashState(runLog(clone(a.log))), a.log.result.hash, 'replay verifies');
  const tampered = clone(a.log); tampered.weapons.pickups.respawn = 1;
  assert.notEqual(hashState(runLog(tampered)), a.log.result.hash, 'pickup settings are a hash input');
  // a log recorded without the fields replays as the original (density 1, respawn 1)
  const orig = runHeadlessMock({ seed: 9, weapons: withPickups(1, 1) }).log;
  const legacy = clone(orig); delete legacy.weapons.pickups;
  assert.equal(hashState(runLog(legacy)), orig.result.hash);
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
    const original = clone(log);
    const normalised = normaliseLog(log);
    assert.deepEqual(log, original, 'loading leaves the recorded log intact');
    assert.deepEqual(normaliseLog(normalised), normalised, 'normalisation is idempotent');
    for (let i = 0; i < log.decisions.length; i++) {
      const before = log.decisions[i], after = normalised.decisions[i];
      for (const [old, action] of [['strafe_left', 'spin_left'], ['strafe_right', 'spin_right']]) {
        if (before.a === old) assert.equal(after.a, action);
        if (before.probs && old in before.probs) {
          assert.equal(after.probs[action], before.probs[old]);
          assert.ok(!(old in after.probs));
        }
      }
    }
    assert.equal(hashState(runLog(log)), log.result.hash, f);
    const legacy = new ReplayCursor(log), current = new ReplayCursor(normalised);
    while (!legacy.state.over) {
      assert.deepEqual(legacy.tick(), current.tick(), 'replayed decision lists use current names');
      assert.equal(hashState(legacy.state), hashState(current.state), `${f}: tick ${legacy.state.tick}`);
    }
    assert.equal(hashState(current.state), log.result.hash, f);
  }
});

test('leaderboard: standings sort by any column, nulls sink, most-kills ids', () => {
  const rows = [{ id: 'a', wins: 3, kills: 2, meanMs: 300 }, { id: 'b', wins: 1, kills: 9, meanMs: null }, { id: 'c', wins: 2, kills: 9, meanMs: 100 }];
  assert.deepEqual(sortStandings(rows, 'kills', 1).map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(sortStandings(rows, 'wins', -1).map((r) => r.id), ['b', 'c', 'a']);
  assert.deepEqual(sortStandings(rows, 'meanMs', -1).map((r) => r.id), ['c', 'a', 'b']);
  assert.equal(sortStandings(rows, null), rows);
  assert.deepEqual(mostKillsIds(rows), ['b', 'c']);
  assert.deepEqual(mostKillsIds([{ id: 'x', kills: 0 }]), []);
});

test('pickups below density 1 thin per slot: no weapon kind vanishes, equal count per slot', () => {
  const n = DEFAULT_ROSTER.length;
  const kinds = ['shotgun', 'rifle', 'uzi', 'missile', 'medpack'];
  const fullCount = createMatch({ seed: 1, roster: DEFAULT_ROSTER, weapons: withPickups(1) }).pickups.length;
  for (let seed = 1; seed <= 40; seed++) {
    const s = createMatch({ seed, roster: DEFAULT_ROSTER, weapons: clone(DEFAULT_WEAPON_CONFIG) });
    const have = new Set(s.pickups.map((p) => p.type));
    for (const k of kinds) assert.ok(have.has(k), `seed ${seed}: ${k} present at start`);
    assert.ok(!have.has('flamethrower'), 'a disabled weapon never spawns');
    const counts = slotCounts(s, n);
    assert.equal(new Set(counts).size, 1, `seed ${seed}: equal count per slot ${counts}`);
    // close to density x the full count (slot spots rounded per slot)
    assert.ok(Math.abs(s.pickups.length - 0.75 * fullCount) <= n / 2 + 1, `seed ${seed}: ${s.pickups.length} vs ${fullCount}`);
    // deterministic
    const again = createMatch({ seed, roster: DEFAULT_ROSTER, weapons: clone(DEFAULT_WEAPON_CONFIG) });
    assert.deepEqual(again.pickups, s.pickups);
  }
  // the guarantee holds even at the lowest density and with few fighters
  for (let seed = 1; seed <= 40; seed++) for (const roster of [DEFAULT_ROSTER, DEFAULT_ROSTER.slice(0, 2)]) {
    const s = createMatch({ seed, roster, weapons: withPickups(0.25) });
    const have = new Set(s.pickups.map((p) => p.type));
    for (const k of kinds) assert.ok(have.has(k), `seed ${seed}, ${roster.length} fighters, density 0.25: ${k} present`);
    assert.equal(new Set(slotCounts(s, roster.length)).size, 1);
  }
  // kinds vary between slots (the old bug filled the same templates everywhere)
  const varied = [1, 2, 3, 4, 5].some((seed) => {
    const s = createMatch({ seed, roster: DEFAULT_ROSTER, weapons: clone(DEFAULT_WEAPON_CONFIG) });
    return s.pickups.filter((p) => p.type === 'shotgun').length % n !== 0;
  });
  assert.ok(varied, 'thinning differs between slots');
  assert.equal(createMatch({ seed: 3, roster: DEFAULT_ROSTER, weapons: withPickups(0) }).pickups.length, 0, 'density 0: none');
  // replay verifies with the default (thinned) config
  const a = runHeadlessMock({ seed: 4, weapons: clone(DEFAULT_WEAPON_CONFIG) });
  assert.equal(hashState(runLog(clone(a.log))), a.log.result.hash, 'replay verifies');
  assert.equal(runHeadlessMock({ seed: 4, weapons: clone(DEFAULT_WEAPON_CONFIG) }).log.result.hash, a.log.result.hash);
});

test('leaderboard cost: the record carries cost and calls, averages exclude old records, the bot has none', () => {
  const s = createMatch({ seed: 2, roster: ['jev', 'gemini', 'bot'] });
  s.tick = 2700; s.over = true; s.ranking = ['jev', 'gemini', 'bot']; s.winner = 'jev';
  const stats = { jev: { calls: 100, decisions: 100, cost: 0.005 }, gemini: { calls: 50, decisions: 50, cost: 0.03, costEst: true },
    bot: { calls: 200, decisions: 200, cost: 0 } };
  const rec = cleanRecord(buildRecord({ state: s, mode: 'live', weapons: DEFAULT_WEAPON_CONFIG, stats }));
  const by = Object.fromEntries(rec.fighters.map((f) => [f.id, f]));
  assert.equal(by.jev.cost, 0.005); assert.equal(by.jev.calls, 100); assert.equal(by.gemini.costEst, true);
  assert.equal(by.bot.cost, null, 'the bot is free and shows -');
  assert.equal(cleanRecord({ ...rec, fighters: rec.fighters.map((f) => ({ ...f, cost: -5 })) }).fighters[0].cost, 0, 'clamped');
  const old = { ...rec, fighters: rec.fighters.map(({ cost, calls, costEst, ...f }) => f) }; // stored before cost tracking
  const rec2 = cleanRecord(buildRecord({ state: s, mode: 'live', weapons: DEFAULT_WEAPON_CONFIG,
    stats: { ...stats, jev: { calls: 300, decisions: 300, cost: 0.015 } } }));
  const rows = Object.fromEntries(aggregate([old, rec, rec2]).map((a) => [a.id, a]));
  assert.equal(rows.jev.played, 3);
  assert.ok(Math.abs(rows.jev.totalCost - 0.02) < 1e-12);
  assert.ok(Math.abs(rows.jev.avgCostGame - 0.01) < 1e-12, 'old record left out of the average');
  assert.ok(Math.abs(rows.jev.costPerCall - 0.02 / 400) < 1e-12);
  assert.equal(rows.jev.costEst, false); assert.equal(rows.gemini.costEst, true);
  assert.equal(rows.bot.totalCost, null); assert.equal(rows.bot.costPerCall, null);
  assert.equal(aggregate([old]).find((a) => a.id === 'jev').avgCostGame, null, 'old-only shows -');
  assert.deepEqual(sortStandings(Object.values(rows), 'costPerCall', -1).map((r) => r.id), ['jev', 'gemini', 'bot']);
  // the proxy reports where the cost came from
  const probs = { advance: 1, retreat: 0, spin_left: 0, spin_right: 0, shoot: 0, take_cover: 0, grab_pickup: 0, hold: 0 };
  const ans = { answers: { action: { choice: 'advance', probabilities: probs } } };
  const tok = parseResponse(rosterById.jev, { ...ans, usage: { inputTokens: 1235 } });
  assert.equal(tok.costSource, 'tokens'); assert.ok(Math.abs(tok.cost - 1235 * rosterById.jev.price.in) < 1e-15);
  assert.equal(parseResponse(rosterById.jev, ans).costSource, 'none');
  assert.equal(parseResponse(rosterById.jev, { ...ans, providerMetadata: { gateway: { cost: '0.00001' } } }).costSource, 'gateway');
});

test('celebration text: last standing, most HP, tie-break, all down', () => {
  const end = (setup) => { const s = createMatch({ seed: 1, roster: ['jev', 'luna', 'laya'] }); setup(s.fighters); s.tick = 2700; finishFor(s); return s; };
  const finishFor = (s) => { // the sim's own order: alive, HP, time of death, kills, roster order
    const r = [...s.fighters].sort((a, b) => (b.alive - a.alive) || (b.hp - a.hp) || ((b.deathTick ?? 1e9) - (a.deathTick ?? 1e9)) || (b.kills - a.kills) || (a.i - b.i));
    s.over = true; s.ranking = r.map((f) => f.id); s.winner = s.ranking[0];
  };
  const down = (f, t) => { f.alive = false; f.hp = 0; f.deathTick = t; };
  assert.deepEqual(celebrationText(end((f) => { down(f[1], 50); down(f[2], 60); })), { allDown: false, line: 'Last one standing', tieBreak: null });
  assert.equal(celebrationText(end((f) => { f[0].hp = 40; f[1].hp = 70; down(f[2], 60); })).line, 'Most health when time ran out');
  const tie = celebrationText(end((f) => { f[0].hp = 50; f[1].hp = 50; f[1].kills = 1; down(f[2], 60); }));
  assert.equal(tie.allDown, false); assert.match(tie.tieBreak, /tie-break/);
  const all = celebrationText(end((f) => { down(f[0], 10); down(f[1], 20); down(f[2], 30); }));
  assert.equal(all.allDown, true);
});

// Model aims changes the action vocabulary only for explicitly enabled matches.
import { actionsFor, decisionQuestions } from '../public/shared.js';
test('model aims: OFF keeps hashes and prompts; ON records targets and replays exactly', () => {
  for (const [seed, hash] of [[1, '7ac48c57'], [42, 'e0c8807c']]) {
    const { log } = runHeadlessMock({ seed });
    assert.equal(log.result.hash, hash);
    assert.equal(hashState(runLog(log)), hash);
    assert.ok(!log.weapons.modelAims);
  }
  for (const seed of [1, 42]) {
    const { log } = runHeadlessMock({ seed, modelAims: true, roster: ROSTER.map((r) => r.id) });
    assert.equal(log.modelAims, true);
    assert.ok(log.decisions.some((d) => d.a?.startsWith('shoot_')));
    assert.ok(!log.decisions.some((d) => d.a === 'shoot'));
    assert.equal(hashState(runLog(log)), log.result.hash);
    const off = clone(log); delete off.modelAims;
    assert.ok(!new ReplayCursor(off).state.weapons.modelAims, 'missing log flag means OFF');
    assert.notEqual(hashState(runLog(off)), log.result.hash);
    assert.notEqual(configId(normaliseWeapons({ ...log.weapons, modelAims: false })), log.weaponsId);
  }
});

test('model aims: one dynamic choice per living enemy, same scene and full text across models', () => {
  const s = createMatch({ seed: 1, roster: DEFAULT_ROSTER, weapons: { ...DEFAULT_WEAPON_CONFIG, modelAims: true } });
  s.fighters.find((f) => f.id === 'laya').alive = false;
  const scene = sceneFor(s, 'jev');
  const options = actionsFor(scene);
  assert.ok(options.includes('shoot_luna'));
  assert.ok(!options.includes('shoot_laya') && !options.includes('shoot_jev') && !options.includes('shoot'));
  const a = buildRequest(rosterById.jev, scene), b = buildRequest(rosterById.luna, scene);
  const c = buildRequest(rosterById.scaledown, scene), gem = buildRequest(rosterById.gemini, scene);
  assert.deepEqual(Object.keys(a.body.questions), ['action']);
  assert.deepEqual(Object.keys(decisionQuestions('compact', scene).action.criteria), options);
  assert.deepEqual(a.body.questions, b.body.questions);
  assert.deepEqual(a.body.questions, c.body.questions);
  assert.equal(a.body.state, b.body.state);
  assert.equal(a.body.state, c.body.state.text);
  assert.equal(a.body.state, gem.body.messages[1].content);
  assert.deepEqual(gem.body.response_format.json_schema.schema.properties.action.enum, options);
  for (const id of ['jev', 'luna', 'scaledown']) {
    assert.equal(parseResponse(rosterById[id], { answers: { action: { choice: 'shoot_luna', probabilities: { shoot_luna: 1 } } } }, scene).action, 'shoot_luna');
    assert.throws(() => parseResponse(rosterById[id], { answers: { action: { choice: 'shoot_laya' } } }, scene));
    assert.throws(() => parseResponse(rosterById[id], { answers: { action: { choice: 'shoot' } } }, scene));
  }
  assert.equal(parseResponse(rosterById.gemini, { choices: [{ message: { content: '{"action":"shoot_luna","confidence":1}' } }] }, scene).action, 'shoot_luna');
});

test('model aims: chosen enemy is faced and fired at; blocked and dead targets never fall back', () => {
  const s = createMatch({ seed: 1, roster: ['jev', 'luna', 'laya'], weapons: { ...DEFAULT_WEAPON_CONFIG, modelAims: true } });
  s.pillars = []; s.pickups = [];
  const [me, near, target] = s.fighters;
  me.x = CENTRE; me.y = CENTRE; near.x = CENTRE + 40; near.y = CENTRE;
  target.x = CENTRE; target.y = CENTRE - 100;
  applyAction(s, 'jev', 'shoot_laya'); step(s);
  assert.equal(me.shots, 1); assert.equal(me.face, -Math.PI / 2);
  assert.ok(s.bullets[0].vy < -6 && Math.abs(s.bullets[0].vx) < 1, 'north, not nearer east enemy');
  me.cd = 0; s.pillars = [{ x: CENTRE, y: CENTRE - 50 }];
  const shots = me.shots;
  me.weapon = 'rifle'; me.ammo = 5;
  const rng = s.rng;
  step(s);
  assert.equal(me.ammo, 5, 'blocked attempt spends no ammo');
  assert.equal(me.cd, 0, 'blocked attempt starts no cooldown');
  assert.equal(s.rng, rng, 'blocked attempt draws no spread randomness');
  assert.equal(me.shots, shots); assert.equal(me.lastShot, 'blocked');
  assert.equal(sceneFor(s, 'jev').last_shot.result, 'blocked');
  // The older airborne volley cannot replace this newer blocked attempt's feedback.
  for (let i = 0; i < 10; i++) step(s);
  assert.equal(me.lastShot, 'blocked');
  target.alive = false; me.cd = 0;
  applyAction(s, 'jev', 'shoot_laya'); step(s);
  assert.equal(me.shots, shots, 'dead target does not shoot nearer enemy');
});

test('model aims: Laya worst case remains under the compact budget with weapon mechanics', () => {
  const scene = { ...worstCaseScene(), model_aims: true };
  const text = compactStateText(scene, WORST_WEAPONS);
  const tokens = questionTokens(text, 'compact', scene);
  assert.ok(tokens <= COMPACT_TOKEN_BUDGET, `${tokens} > ${COMPACT_TOKEN_BUDGET}`);
  assert.equal(checkBudget(rosterById.laya, text, 0, scene).over, false);
  assert.match(text, /shotgun:near spread/);
  assert.match(text, /missile:mid blast close, hurts you too/);
  assert.match(text, /flamethrower:close burns while in cone/);
});

test('model aims: leaderboard retains per-shooter target-choice counts only when ON', () => {
  const s = createMatch({ seed: 1, roster: ['jev', 'luna'], weapons: { ...DEFAULT_WEAPON_CONFIG, modelAims: true } });
  s.ranking = ['jev', 'luna']; s.winner = 'jev';
  const rec = cleanRecord(buildRecord({ state: s, mode: 'mock', weapons: s.weapons,
    stats: { jev: { targetsChosen: { luna: 3 } } } }));
  assert.equal(rec.modelAims, true);
  assert.deepEqual(rec.fighters[0].targetsChosen, { luna: 3 });
  assert.deepEqual(rec.fighters[1].targetsChosen, {});
  assert.match(rec.cfgSummary, /model aims ON/);
});
