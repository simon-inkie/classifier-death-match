// Live smoke test through a running local proxy: N calls per model fighter with a real scene.
// Usage: start the proxy with a key, then `node scripts/smoke.js [callsPerFighter] [fighter ...] [--worst]`
// --worst sends the worst-case scene (six fighters, every weapon on, incoming fire) to check prompt size.
import { createMatch, sceneFor } from '../public/sim.js';
import { ROSTER } from '../public/shared.js';
import { worstCaseScene, WORST_WEAPONS } from './worst-case.js';

const base = process.env.ARENA_URL || 'http://127.0.0.1:8787';
const args = process.argv.slice(2);
const worst = args.includes('--worst');
const pos = args.filter((a) => !a.startsWith('--'));
const n = Number(pos[0] || 2);
const only = pos.slice(1);
const fighters = ROSTER.filter((r) => r.kind !== 'bot' && !r.gatewaySlot && (!only.length || only.includes(r.id)));
const state = createMatch({ seed: 7, roster: ROSTER.filter((r) => !r.gatewaySlot).map((r) => r.id) });

for (const f of fighters) {
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    const body = worst ? { fighter: f.id, scene: worstCaseScene(), weapons: WORST_WEAPONS } : { fighter: f.id, scene: sceneFor(state, f.id) };
    const r = await fetch(`${base}/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body) });
    const j = await r.json();
    const ms = Math.round(performance.now() - t0);
    if (r.ok) {
      const top = j.probs ? Object.entries(j.probs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' ') : `conf=${j.confidence}`;
      console.log(`${f.id.padEnd(9)} ${f.model.padEnd(30)} OK  ${ms}ms (upstream ${j.upstreamMs}ms) ${j.action}  [${top}] in=${j.usage?.in} cost=$${j.cost}`);
    } else {
      console.log(`${f.id.padEnd(9)} ${f.model.padEnd(30)} ERR ${r.status} ${ms}ms ${j.error}`);
    }
  }
}
const s = await (await fetch(`${base}/api/status`)).json();
console.log('budget', s.budget);
