// Start the proxy with the gateway key, without printing it. Uses AI_GATEWAY_API_KEY from the environment,
// or, if ARENA_PASS_ENTRY is set, reads the key from that `pass` entry (https://www.passwordstore.org/).
// Equivalent to: AI_GATEWAY_API_KEY=... node server.js
import { execFileSync, spawn } from 'node:child_process';

let key = process.env.AI_GATEWAY_API_KEY;
if (!key && process.env.ARENA_PASS_ENTRY) {
  try {
    key = execFileSync('pass', ['show', process.env.ARENA_PASS_ENTRY], { encoding: 'utf8' }).split('\n')[0].trim();
  } catch {
    key = '';
  }
}
if (!key) {
  console.error('No key: export AI_GATEWAY_API_KEY (or set ARENA_PASS_ENTRY to a pass entry), or run `npm start` for mock and replay.');
  process.exit(1);
}
const child = spawn(process.execPath, ['server.js'], { stdio: 'inherit', env: { ...process.env, AI_GATEWAY_API_KEY: key } });
child.on('exit', (code) => process.exit(code ?? 0));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig));
