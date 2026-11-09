import { answerTimeoutMs } from './answer-timeout.js';
// Scripted control bot, mock "models", and a headless virtual-time match runner.
import { ACTIONS, rosterById, DEFAULT_ROSTER, promptVariant } from './shared.js';
import { createMatch, applyAction, step, sceneFor, hashState, makeRng, TICK_HZ } from './sim.js';
import { DEFAULT_WEAPON_CONFIG, normaliseWeapons, configId, configSummary } from './weapons.js';

// Heuristic score per intention, from the same bucketed scene the models see.
export function botScores(scene) {
  const s = Object.fromEntries(ACTIONS.map((a) => [a, 0]));
  s.hold = 0.1;
  const e = scene.enemies[0];
  const losEnemy = scene.enemies.find((x) => x.los);
  const med = scene.pickups.find((p) => p.type === 'medpack');
  const gun = scene.pickups.find((p) => p.type !== 'medpack');
  if (scene.incoming && scene.incoming.eta_ticks < 8) {
    const free = ['spin_left', 'spin_right'];
    s[free[(scene.incoming.eta_ticks + scene.hp) % 2]] += 2.5;
  }
  if (scene.hp < 45 && med && med.dist !== 'far') s.grab_pickup += 3;
  if (scene.weapon === 'pistol' && gun && (gun.dist === 'close' || gun.dist === 'near')) s.grab_pickup += 2;
  if (losEnemy) {
    const rank = { close: 0, near: 1, mid: 2, far: 3 };
    const inRange = rank[losEnemy.dist] <= rank[scene.range ?? 'mid'];
    const tooClose = scene.weapon === 'missile' && losEnemy.dist === 'close'; // the blast would hit us too
    if (tooClose) s.retreat += 2.5;
    else if (inRange) s.shoot += scene.gun_ready ? 3 : 1.5;
    else s.advance += 2;
    if (scene.hp < 30 && losEnemy.hp > scene.hp) s.take_cover += 3.2;
  } else if (e) {
    s.advance += 2;
  }
  if (scene.ring.outside) s.advance += 3;
  return s;
}

function aimedAnswer(scene, ans) {
  if (!scene.model_aims) return ans;
  const target = scene.enemies.find((e) => e.los) || scene.enemies[0];
  const action = ans.action === 'shoot' ? (target ? `shoot_${target.name}` : 'hold') : ans.action;
  const probs = ans.probs && Object.fromEntries(Object.entries(ans.probs).filter(([a]) => a !== 'shoot'));
  if (probs) for (const e of scene.enemies) probs[`shoot_${e.name}`] = e === target ? (ans.probs.shoot || 0) : 0;
  return { ...ans, action, probs };
}
export function botDecide(scene) {
  const s = botScores(scene);
  let best = ACTIONS[0];
  for (const a of ACTIONS) if (s[a] > s[best]) best = a;
  const probs = Object.fromEntries(ACTIONS.map((a) => [a, a === best ? 1 : 0]));
  return aimedAnswer(scene, { action: best, probs });
}

// A mock model: softmax over the bot heuristic plus noise. Skill sharpens it.
export function mockDecide(fid, scene, rnd) {
  const cfg = rosterById[fid].mock;
  if (fid === 'bot') return botDecide(scene);
  const s = botScores(scene);
  const logits = ACTIONS.map((a) => s[a] * cfg.skill + (rnd() - 0.5) * 3);
  const mx = Math.max(...logits);
  const ex = logits.map((l) => Math.exp(l - mx));
  const sum = ex.reduce((a, b) => a + b, 0);
  const p = ex.map((x) => x / sum);
  let r = rnd(), idx = 0;
  while (idx < p.length - 1 && r > p[idx]) { r -= p[idx]; idx++; }
  const action = ACTIONS[idx];
  if (rosterById[fid].kind === 'chat') {
    // the chat baseline only self-reports a confidence for its pick
    const conf = Math.min(0.99, Math.round((0.7 + rnd() * 0.29) * 100) / 100);
    return aimedAnswer(scene, { action, probs: null, confidence: conf });
  }
  return aimedAnswer(scene, { action, probs: Object.fromEntries(ACTIONS.map((a, i) => [a, p[i]])) });
}

export function mockLatency(fid, rnd) {
  const m = rosterById[fid].mock;
  // skewed: mostly near base, occasional long tail
  const tail = rnd() < 0.08 ? rnd() * m.base * 2 : 0;
  return Math.max(1, Math.round(m.base + (rnd() - 0.5) * m.jitter + tail));
}

// A log's roster entry. prompt: which prompt variant this fighter got ('full', or 'compact' for Laya);
// the bot gets no prompt. Replay ignores it; it is there so a log says honestly what each model saw.
export function rosterEntry(id) {
  const r = rosterById[id];
  return { id, name: r.name, model: r.model, prompt: r.kind === 'bot' ? null : promptVariant(r) };
}

// Headless match in virtual time, same semantics as the browser loop:
// each fighter asks as soon as its last answer lands, at most 10 Hz; the configured answer timeout = stunned.
// The scripted bot is a control and is off by default: pass bot: true (or an explicit roster) to add it.
export const MODEL_FIGHTERS = DEFAULT_ROSTER; // jev, luna, laya, scaledown (Gemini and the bot are opt-in)
// weapons: a weapon config (default: the game default, flamethrower off). It is saved in the log.
export function runHeadlessMock({ seed = 1, bot = false, roster = bot ? [...MODEL_FIGHTERS, 'bot'] : MODEL_FIGHTERS,
  weapons = DEFAULT_WEAPON_CONFIG, modelAims = false } = {}) {
  const cfg = normaliseWeapons(modelAims ? { ...weapons, modelAims: true } : weapons);
  const timeoutMs = answerTimeoutMs(cfg);
  const state = createMatch({ seed, roster, weapons: cfg });
  const rnd = makeRng(seed ^ 0x5eed);
  const minGap = Math.round(TICK_HZ / 10);
  const ctl = Object.fromEntries(roster.map((id) => [id, { nextAsk: 0, pending: null }]));
  const decisions = [];
  while (!state.over) {
    for (const id of roster) {
      const c = ctl[id];
      if (c.pending && c.pending.arrive <= state.tick) {
        const p = c.pending; c.pending = null;
        const f = state.fighters.find((x) => x.id === id);
        if (f.alive) {
          applyAction(state, id, p.err ? 'stunned' : p.ans.action);
          decisions.push({ t: state.tick, f: id, a: p.err ? null : p.ans.action, probs: p.ans?.probs ?? null,
            conf: p.ans?.confidence ?? null, ms: p.ms, err: p.err });
        }
        c.nextAsk = Math.max(state.tick, p.asked + minGap);
      }
      const f = state.fighters.find((x) => x.id === id);
      if (!c.pending && f.alive && state.tick >= c.nextAsk) {
        const scene = sceneFor(state, id);
        const ms = mockLatency(id, rnd);
        const cfg = rosterById[id].mock;
        const timeout = ms > timeoutMs;
        const err = timeout ? 'timeout' : rnd() < cfg.err ? 'mock error' : null;
        const ans = err ? null : mockDecide(id, scene, rnd);
        const wait = timeout ? timeoutMs : ms;
        c.pending = { asked: state.tick, arrive: state.tick + Math.max(1, Math.ceil((wait / 1000) * TICK_HZ)), ms: wait, err, ans };
      }
    }
    step(state);
  }
  const log = {
    version: 1, modelAims: Boolean(cfg.modelAims), mode: 'headless-mock', seed, createdAt: new Date().toISOString(), bot: roster.includes('bot'),
    roster: roster.map((id) => rosterEntry(id)),
    weapons: cfg, weaponsId: configId(cfg), weaponsSummary: configSummary(cfg),
    decisions,
    result: { winner: state.winner, ranking: state.ranking, ticks: state.tick, hash: hashState(state) },
  };
  return { state, log };
}
