// The hosted API: what server.js does for the browser, as stateless handlers for Vercel Functions
// (one thin file per route under api/). State lives in a durable store (lib/storage.js), never on disk.
// On top of the local proxy it adds: a match token per live match, a per-IP limit on starting matches,
// a per-match call cap and a daily spend ceiling shared by every instance. It fails closed: no durable
// store, or no key, means no paid calls.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROSTER, rosterById, MAX_FIGHTERS } from '../public/shared.js';
import { normaliseWeapons } from '../public/weapons.js';
import { cleanRecord, MAX_RECORDS } from '../public/leaderboard.js';
import { createStore } from './storage.js';
import { spendConfig, spentToday, addSpend, conservativeCallUsd, matchReserveUsd, ceilingCheck, CEILING_MESSAGE,
  CALL_CAP_PER_FIGHTER } from './spend.js';
import { pickerEnabled, resolveFighter, createCatalogue, maxUsdPerCall } from './models.js';
import { callGateway } from './gateway.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATCH_TTL_S = 900; // long enough for a paused match; the call cap bounds what a token can spend
const LB_KEY = 'leaderboard';

function send(res, code, body, extra = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

// Vercel may have parsed the body already (req.body); otherwise read the stream, with a size limit.
async function readJson(req, limit = 1e5) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    const s = String(req.body);
    if (s.length > limit) throw new Error('too large');
    return s ? JSON.parse(s) : {};
  }
  const txt = await new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy?.(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  return txt ? JSON.parse(txt) : {};
}

const header = (req, name) => { const v = req.headers?.[name]; return Array.isArray(v) ? v[0] : v; };
// The client address as the platform reports it (Vercel sets x-real-ip and x-forwarded-for). It is only
// used hashed, inside a rate-limit key that expires with its window; it is never stored or logged as is.
export function clientIp(req) {
  return String(header(req, 'x-real-ip') || String(header(req, 'x-forwarded-for') || '').split(',')[0] || req.socket?.remoteAddress || 'unknown').trim();
}

function intEnv(env, name, dflt) {
  const n = env[name] == null || env[name] === '' ? dflt : Number(env[name]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid ${name}`);
  return n;
}

export function createHosted({ env = process.env, store, fetch: fetcher = fetch, now = () => Date.now(), root = ROOT } = {}) {
  const KEY = env.AI_GATEWAY_API_KEY || '';
  const GATEWAY = env.AI_GATEWAY_BASE || 'https://ai-gateway.vercel.sh';
  const TIMEOUT_MS = Number(env.CALL_TIMEOUT_MS || 2000);
  const ceiling = spendConfig(env); // throws on a bad value: better a failed deploy than an unguarded one
  const picker = pickerEnabled(env);
  const maxCallUsd = maxUsdPerCall(env);
  const rate = { limit: intEnv(env, 'MATCH_RATE_LIMIT', 5), windowS: intEnv(env, 'MATCH_RATE_WINDOW_S', 600) || 600 };
  const salt = env.RATE_LIMIT_SALT || 'classifier-death-match';
  const db = store || createStore(env, { root, fetch: fetcher, now });
  const catalogue = createCatalogue({ env, fetch: fetcher, now });
  const examplesDir = path.join(root, 'examples');

  const paidBlocked = () => !KEY ? { status: 503, error: 'AI_GATEWAY_API_KEY not set', stop: true }
    : !db.durable ? { status: 503, error: 'live matches are off: no durable store is configured (KV_REST_API_URL / KV_REST_API_TOKEN)', stop: true }
    : null;
  const ceilingBody = (spent) => ({ error: `daily budget spent: ${CEILING_MESSAGE}`, message: CEILING_MESSAGE, ceilingReached: true, stop: true,
    spend: { exhausted: true, durable: db.durable } });
  const spendStatus = async () => {
    if (!db.durable) return { exhausted: true, durable: false };
    const spent = await spentToday(db, now());
    return { exhausted: spent >= ceiling.usd, durable: true };
  };

  const routes = {
    async status(req, res) {
      let spend;
      try { spend = await spendStatus(); } catch { spend = { exhausted: true, durable: db.durable, error: 'store unavailable' }; }
      return send(res, 200, { hosted: true, keyLoaded: Boolean(KEY), modelPicker: picker, spend,
        spendMessage: spend.exhausted ? (spend.durable ? CEILING_MESSAGE : 'Live matches are not available on this deployment.') : null,
        roster: ROSTER.map(({ id, name, model, kind, transport }) => ({ id, name, model, kind, transport })) });
    },

    async models(req, res) {
      if (!picker) return send(res, 200, { enabled: false, models: [] });
      const { source, models } = await catalogue();
      return send(res, 200, { enabled: true, source, models: models.filter((m) => m.price).map(({ id, name, price }) => ({ id, name, price })) });
    },

    // POST {fighters: [ids], models?: {slotId: modelId}} -> {matchToken}. Every check happens here, once,
    // before any paid call: fighters, models (flag), rate limit, then the ceiling with this match reserved.
    async matchStart(req, res) {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const blocked = paidBlocked();
      if (blocked) return send(res, blocked.status, blocked);
      let body;
      try { body = await readJson(req, 1e4); } catch (e) { return send(res, 400, { error: e.message }); }
      const ids = body?.fighters;
      if (!Array.isArray(ids) || ids.length < 2 || ids.length > MAX_FIGHTERS || new Set(ids).size !== ids.length || !ids.every((id) => rosterById[id]))
        return send(res, 400, { error: `pick 2 to ${MAX_FIGHTERS} different known fighters` });
      const want = body.models && typeof body.models === 'object' ? body.models : {};
      const models = picker ? (await catalogue()).models : undefined;
      const fighters = {};
      for (const id of ids) {
        if (rosterById[id].kind === 'bot') continue;
        const r = resolveFighter(id, want[id], { enabled: picker, models, maxCallUsd });
        if (!r.ok) return send(res, r.status, { error: `${id}: ${r.error}` });
        const f = r.fighter;
        fighters[id] = { model: f.model, kind: f.kind, transport: f.transport, prompt: f.prompt, stateObject: f.stateObject, price: f.price, picked: r.picked };
      }
      const ipHash = crypto.createHash('sha256').update(`${salt}:${clientIp(req)}`).digest('hex').slice(0, 24);
      const win = Math.floor(now() / 1000 / rate.windowS);
      const starts = await db.incr(`rl:start:${ipHash}:${win}`, rate.windowS + 5);
      if (starts > rate.limit) {
        const retryAfter = rate.windowS - Math.floor(now() / 1000) % rate.windowS;
        return send(res, 429, { error: `too many matches started from your address; try again in ${Math.ceil(retryAfter / 60)} min`, rateLimited: true, retryAfter },
          { 'Retry-After': String(retryAfter) });
      }
      const spent = await spentToday(db, now());
      const chk = ceilingCheck({ spent, ceilingUsd: ceiling.usd, reserve: matchReserveUsd(Object.values(fighters)) });
      if (!chk.ok) return send(res, 429, chk.reason === 'spent' ? ceilingBody(spent)
        : { error: 'not enough of today\'s budget left for this match; try fewer or cheaper fighters, or come back tomorrow', ceilingReached: true, stop: true });
      const matchToken = crypto.randomUUID();
      await db.set(`match:${matchToken}`, { fighters, created: now(), maxCalls: CALL_CAP_PER_FIGHTER * Object.keys(fighters).length }, MATCH_TTL_S);
      return send(res, 200, { matchToken, expiresInS: MATCH_TTL_S });
    },

    // POST {matchToken, fighter, scene, weapons, model?}. The model always comes from the match record,
    // fixed and validated at start; a different one in the body is rejected.
    async decide(req, res) {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const blocked = paidBlocked();
      if (blocked) return send(res, blocked.status, blocked);
      let body;
      try { body = await readJson(req, 1e5); } catch (e) { return send(res, 400, { error: e.message }); }
      const { matchToken, fighter: fid, scene, weapons, model } = body || {};
      if (typeof matchToken !== 'string' || !/^[0-9a-f-]{36}$/.test(matchToken)) return send(res, 403, { error: 'no match token: press Start again', stop: true });
      const [m, spent] = await Promise.all([db.get(`match:${matchToken}`), spentToday(db, now())]);
      if (!m) return send(res, 403, { error: 'match expired or unknown: press Start again', stop: true });
      const slot = m.fighters[fid];
      if (!slot || !rosterById[fid]) return send(res, 400, { error: 'fighter not in this match' });
      if (model != null && model !== slot.model) return send(res, 400, { error: 'model differs from the one fixed at match start' });
      if (await db.incr(`match:${matchToken}:calls`, MATCH_TTL_S) > m.maxCalls) return send(res, 429, { error: 'call budget spent for this match', stop: true });
      if (spent >= ceiling.usd) return send(res, 429, ceilingBody(spent));
      if (!scene || typeof scene !== 'object') return send(res, 400, { error: 'no scene' });
      const fighter = { ...rosterById[fid], ...slot };
      let w;
      try { w = weapons ? normaliseWeapons(weapons) : undefined; } catch (e) { return send(res, 400, { error: e.message }); }
      const out = await callGateway(fighter, scene, w, { key: KEY, gateway: GATEWAY, timeoutMs: TIMEOUT_MS, fetch: fetcher });
      if (!out.ok) {
        if (out.billedMaybe) await addSpend(db, conservativeCallUsd(fighter), now());
        return send(res, out.status, { error: out.error, ms: out.ms });
      }
      const p = out.parsed;
      const charged = p.costSource === 'none' ? conservativeCallUsd(fighter) : Math.max(0, Number(p.cost) || 0);
      await addSpend(db, charged, now());
      return send(res, 200, { ...p, upstreamMs: out.ms });
    },

    async leaderboard(req, res) {
      return send(res, 200, { version: 1, matches: await db.listRange(LB_KEY) });
    },

    // Only a live match started here can be recorded, once, with its own fighters and roster models.
    async record(req, res) {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const token = header(req, 'x-match-token');
      if (typeof token !== 'string' || !/^[0-9a-f-]{36}$/.test(token)) return send(res, 403, { error: 'only live matches started on this site are recorded' });
      const m = await db.get(`match:${token}`);
      if (!m) return send(res, 403, { error: 'match expired or unknown' });
      if (Object.values(m.fighters).some((f) => f.picked)) return send(res, 403, { error: 'matches with picked models are not recorded' });
      let rec;
      try { rec = cleanRecord(await readJson(req, 1e5)); } catch (e) { return send(res, 400, { error: e.message }); }
      if (rec.mode !== 'live') return send(res, 403, { error: 'only live matches are recorded here' });
      const models = rec.fighters.map((f) => f.id).filter((id) => rosterById[id].kind !== 'bot').sort();
      if (models.join() !== Object.keys(m.fighters).sort().join()) return send(res, 400, { error: 'fighters differ from the match' });
      if (await db.incr(`match:${token}:recorded`, MATCH_TTL_S) > 1) return send(res, 409, { error: 'already recorded' });
      const count = await db.listPush(LB_KEY, rec, MAX_RECORDS);
      return send(res, 200, { ok: true, count });
    },

    // Off unless ARENA_ADMIN_TOKEN is set, and then only with it as a bearer token.
    async reset(req, res) {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const admin = env.ARENA_ADMIN_TOKEN || '';
      const given = String(header(req, 'authorization') || '').replace(/^Bearer\s+/i, '');
      const ok = admin.length >= 16 && given.length === admin.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(admin));
      if (!ok) return send(res, 403, { error: 'leaderboard reset is disabled on the hosted site' });
      let body;
      try { body = await readJson(req, 1e4); } catch (e) { return send(res, 400, { error: e.message }); }
      if (body?.confirm !== 'RESET') return send(res, 400, { error: 'send {"confirm":"RESET"}' });
      await db.del(LB_KEY);
      return send(res, 200, { ok: true, count: 0 });
    },

    // Bundled example logs only; a finished match's log is not stored here (Download keeps it).
    async logs(req, res) {
      if (req.method === 'POST') return send(res, 200, { name: null, stored: false });
      const files = fs.existsSync(examplesDir) ? fs.readdirSync(examplesDir).filter((f) => /^example-[\w.-]+\.json$/.test(f)).sort() : [];
      return send(res, 200, files);
    },

    async logFile(req, res) {
      const name = new URL(req.url || '/', 'http://x').searchParams.get('name') || '';
      if (!/^example-[\w-]+(\.[\w-]+)*\.json$/.test(name)) return send(res, 404, { error: 'not found' });
      const p = path.join(examplesDir, name);
      if (!fs.existsSync(p)) return send(res, 404, { error: 'not found' });
      return send(res, 200, fs.readFileSync(p));
    },
  };

  return {
    store: db,
    async handle(route, req, res) {
      try {
        return await routes[route](req, res);
      } catch (e) {
        // store or other failure: fail closed, without echoing anything that might hold configuration
        return send(res, 500, { error: 'server error', stop: true });
      }
    },
  };
}

// One instance per serverless instance, created on first use so a cold start reads the env once.
let shared = null;
export const handler = (route) => (req, res) => (shared ||= createHosted()).handle(route, req, res);
