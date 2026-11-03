// Headless mock matches (no browser, no keys): runs N matches in virtual time,
// writes each log to logs/, replays each from its log and checks the hash.
// Usage: node scripts/headless.js [matches=5] [startSeed=1] [--bot]
// The scripted bot is off by default; --bot adds it as a control fighter.
import fs from 'node:fs';
import { runHeadlessMock } from '../public/brain.js';
import { runLog, hashState } from '../public/sim.js';

const args = process.argv.slice(2);
const bot = args.includes('--bot');
const pos = args.filter((a) => !a.startsWith('--'));
const n = Number(pos[0] || 5), seed0 = Number(pos[1] || 1);
const wins = {};
let allOk = true;
fs.mkdirSync('logs', { recursive: true });
for (let s = seed0; s < seed0 + n; s++) {
  const { state, log } = runHeadlessMock({ seed: s, bot });
  const file = `logs/headless-mock-seed${s}${bot ? '-bot' : ''}.json`;
  fs.writeFileSync(file, JSON.stringify(log));
  const replayed = runLog(JSON.parse(fs.readFileSync(file, 'utf8')));
  const ok = hashState(replayed) === log.result.hash;
  allOk &&= ok;
  wins[state.winner] = (wins[state.winner] || 0) + 1;
  console.log(`seed ${s}: winner ${state.winner} at ${(state.tick / 30).toFixed(1)}s, ${log.roster.length} fighters (${bot ? 'with' : 'without'} bot), ${log.decisions.length} decisions, hash ${log.result.hash}, replay ${ok ? 'identical' : 'MISMATCH'} -> ${file}`);
}
console.log('wins', wins);
process.exit(allOk ? 0 : 1);
