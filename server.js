// Tiny local proxy + static server. Holds the AI Gateway key (from AI_GATEWAY_API_KEY),
// never prints or writes it. Hard call budget per process (CALL_BUDGET, default 3000).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROSTER, rosterById } from './public/shared.js';
import { buildRequest, parseResponse } from './adapters.js';
import { normaliseWeapons } from './public/weapons.js';
import { cleanRecord, MAX_RECORDS } from './public/leaderboard.js';
import { pickerEnabled, resolveFighter, createCatalogue, maxUsdPerCall } from './lib/models.js';
import { conservativeCallUsd } from './lib/spend.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const LOGS = path.join(ROOT, 'logs');
const EXAMPLES = path.join(ROOT, 'examples'); // bundled replay logs, listed after your own (read-only)
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1'; // loopback by default: the proxy holds your gateway key; set HOST deliberately to expose it
const GATEWAY = process.env.AI_GATEWAY_BASE || 'https://ai-gateway.vercel.sh';
const KEY = process.env.AI_GATEWAY_API_KEY || '';
const BUDGET = Number(process.env.CALL_BUDGET || 3000);
const COST_MAX = process.env.CALL_BUDGET_USD == null || process.env.CALL_BUDGET_USD === ''
  ? null : Number(process.env.CALL_BUDGET_USD);
if (COST_MAX !== null && (!Number.isFinite(COST_MAX) || COST_MAX < 0)) throw new Error('invalid CALL_BUDGET_USD');
const TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS || 2000);
const LB_FILE = path.resolve(ROOT, process.env.LEADERBOARD_FILE || 'data/leaderboard.json');
// Model picker (off unless ENABLE_MODEL_PICKER=1): with it off, a fighter only ever runs its roster model.
const PICKER = pickerEnabled();
const MAX_CALL_USD = maxUsdPerCall();
const catalogue = createCatalogue();
async function resolveSlot(fid, model) {
  const models = PICKER && model ? (await catalogue()).models : undefined;
  return resolveFighter(fid, model, { enabled: PICKER, models, maxCallUsd: MAX_CALL_USD });
}

fs.mkdirSync(LOGS, { recursive: true });

// ---------- all-time leaderboard: one JSON file, rewritten atomically (temp file + rename) on each change
fs.mkdirSync(path.dirname(LB_FILE), { recursive: true });
function loadBoard() {
  if (!fs.existsSync(LB_FILE)) return { version: 1, matches: [] };
  try {
    const j = JSON.parse(fs.readFileSync(LB_FILE, 'utf8'));
    if (!Array.isArray(j.matches)) throw new Error('no matches array');
    return { version: 1, matches: j.matches };
  } catch (e) {
    const aside = `${LB_FILE}.corrupt-${Date.now()}`;
    fs.renameSync(LB_FILE, aside); // keep the bad file for a look, start a fresh board
    console.log(`leaderboard file unreadable (${e.message}); moved to ${path.basename(aside)}`);
    return { version: 1, matches: [] };
  }
}
function saveBoard() {
  const tmp = `${LB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(board));
  fs.renameSync(tmp, LB_FILE);
}
const board = loadBoard();

let used = 0;
let usedUsd = 0;
const costBudget = () => ({ used: usedUsd, max: COST_MAX });
const perFighter = Object.fromEntries(ROSTER.map((r) => [r.id, { calls: 0, ok: 0, err: 0 }]));

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req, limit = 20e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function decide(fid, scene, weapons, picked) {
  const fighter = picked || rosterById[fid];
  if (!fighter || fighter.kind === 'bot') return { status: 400, body: { error: 'unknown fighter' } };
  if (!KEY) return { status: 503, body: { error: 'AI_GATEWAY_API_KEY not set' } };
  if (COST_MAX !== null && usedUsd >= COST_MAX) return { status: 429,
    body: { error: `cost budget spent ($${usedUsd}/$${COST_MAX})`, costBudget: costBudget() } };
  if (used >= BUDGET) return { status: 429, body: { error: `call budget spent (${used}/${BUDGET})`, budget: { used, max: BUDGET } } };
  used++;
  perFighter[fid].calls++;
  const { url, body } = buildRequest(fighter, scene, GATEWAY, weapons);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const r = await fetch(url, { method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const txt = await r.text();
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) {
      perFighter[fid].err++;
      let msg = txt.slice(0, 300);
      try { const e = JSON.parse(txt); msg = e.error?.message || e.message || msg; if (e.error?.type || e.error_type) msg = `${e.error?.type || e.error_type}: ${msg}`; } catch {}
      console.log(`[call ${used}/${BUDGET}] ${fid} HTTP ${r.status} ${ms}ms ${msg.slice(0, 160)}`);
      return { status: 502, body: { error: `HTTP ${r.status}: ${msg}`, ms, budget: { used, max: BUDGET } } };
    }
    const parsed = parseResponse(fighter, JSON.parse(txt), scene);
    // a picked model with no reported cost counts at a conservative estimate, never as free
    usedUsd += picked && parsed.costSource === 'none' ? conservativeCallUsd(fighter) : Math.max(0, Number(parsed.cost) || 0);
    perFighter[fid].ok++;
    console.log(`[call ${used}/${BUDGET}] ${fid} ok ${ms}ms -> ${parsed.action}`);
    return { status: 200, body: { ...parsed, upstreamMs: ms, budget: { used, max: BUDGET }, costBudget: costBudget() } };
  } catch (e) {
    perFighter[fid].err++;
    const ms = Math.round(performance.now() - t0);
    const msg = e.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : e.message;
    console.log(`[call ${used}/${BUDGET}] ${fid} error ${ms}ms ${msg}`);
    return { status: 504, body: { error: msg, ms, budget: { used, max: BUDGET } } };
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${HOST}`);
    if (u.pathname === '/api/status') {
      return send(res, 200, { keyLoaded: Boolean(KEY), modelPicker: PICKER, budget: { used, max: BUDGET }, costBudget: costBudget(), perFighter,
        roster: ROSTER.map(({ id, name, model, kind, transport }) => ({ id, name, model, kind, transport })) });
    }
    if (u.pathname === '/api/decide' && req.method === 'POST') {
      const { fighter, scene, weapons, model } = JSON.parse(await readBody(req, 1e5));
      let picked;
      if (model != null) { // checked on the server: the page hiding the picker is not the control
        const r = await resolveSlot(fighter, model);
        if (!r.ok) return send(res, r.status, { error: r.error, stop: true });
        if (r.picked) picked = r.fighter;
      }
      // the match's weapon config sets the rules text; validated and clamped here, never trusted
      const out = await decide(fighter, scene, weapons ? normaliseWeapons(weapons) : undefined, picked);
      return send(res, out.status, out.body);
    }
    if (u.pathname === '/api/models' && req.method === 'GET') {
      if (!PICKER) return send(res, 200, { enabled: false, models: [] });
      const { source, models } = await catalogue();
      return send(res, 200, { enabled: true, source, models: models.filter((m) => m.price).map(({ id, name, price }) => ({ id, name, price })) });
    }
    if (u.pathname === '/api/match/start' && req.method === 'POST') {
      // Local: no token, no rate limit (the page asks so it works the same here and on the hosted site).
      // It only checks the fighters' models and that the spend budget is not already gone.
      const { fighters, models } = JSON.parse((await readBody(req, 1e4)) || '{}');
      for (const id of Array.isArray(fighters) ? fighters : []) {
        if (!rosterById[id] || rosterById[id].kind === 'bot') continue;
        const r = await resolveSlot(id, models?.[id]);
        if (!r.ok) return send(res, r.status, { error: `${id}: ${r.error}` });
      }
      if (COST_MAX !== null && usedUsd >= COST_MAX) return send(res, 429, { error: `cost budget spent ($${usedUsd}/$${COST_MAX})`, stop: true });
      return send(res, 200, { matchToken: null, local: true });
    }
    if (u.pathname === '/api/leaderboard' && req.method === 'GET') {
      return send(res, 200, board);
    }
    if (u.pathname === '/api/leaderboard/record' && req.method === 'POST') {
      let rec;
      try { rec = cleanRecord(JSON.parse(await readBody(req, 1e5))); } catch (e) { return send(res, 400, { error: e.message }); }
      board.matches.push(rec);
      if (board.matches.length > MAX_RECORDS) board.matches.splice(0, board.matches.length - MAX_RECORDS);
      saveBoard();
      console.log(`leaderboard: ${rec.mode} match, winner ${rec.winner} (${rec.note}), ${board.matches.length} recorded`);
      return send(res, 200, { ok: true, count: board.matches.length });
    }
    if (u.pathname === '/api/leaderboard/reset' && req.method === 'POST') {
      const { confirm } = JSON.parse((await readBody(req, 1e4)) || '{}');
      if (confirm !== 'RESET') return send(res, 400, { error: 'send {"confirm":"RESET"}' });
      if (board.matches.length) fs.copyFileSync(LB_FILE, `${LB_FILE.replace(/\.json$/, '')}-${Date.now()}.bak.json`); // one undo
      board.matches = [];
      saveBoard();
      console.log('leaderboard reset');
      return send(res, 200, { ok: true, count: 0 });
    }
    if (u.pathname === '/api/logs' && req.method === 'GET') {
      const files = fs.readdirSync(LOGS).filter((f) => f.endsWith('.json')).sort().reverse();
      const examples = fs.existsSync(EXAMPLES) ? fs.readdirSync(EXAMPLES).filter((f) => /^example-.*\.json$/.test(f)).sort() : [];
      return send(res, 200, [...files, ...examples]);
    }
    if (u.pathname === '/api/logs' && req.method === 'POST') {
      const log = JSON.parse(await readBody(req));
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const name = `match-${stamp}-${String(log.mode || 'x').replace(/[^a-z-]/gi, '')}-seed${Number(log.seed) | 0}.json`;
      fs.writeFileSync(path.join(LOGS, name), JSON.stringify(log));
      console.log(`saved logs/${name}`);
      return send(res, 200, { name });
    }
    if (u.pathname.startsWith('/logs/')) {
      const name = path.basename(decodeURIComponent(u.pathname));
      const p = path.join(name.startsWith('example-') && !fs.existsSync(path.join(LOGS, name)) ? EXAMPLES : LOGS, name);
      if (!name.endsWith('.json') || !fs.existsSync(p)) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(p), 'application/json');
    }
    let rel = u.pathname === '/' ? 'index.html' : u.pathname.slice(1);
    const p = path.normalize(path.join(PUBLIC, rel));
    if (!p.startsWith(PUBLIC) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) return send(res, 404, 'not found', 'text/plain');
    return send(res, 200, fs.readFileSync(p), MIME[path.extname(p)] || 'application/octet-stream');
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Classifier Death Match on http://${HOST}:${PORT}  key loaded: ${KEY ? 'yes' : 'no (mock and replay only)'}  call budget: ${BUDGET}`);
});
