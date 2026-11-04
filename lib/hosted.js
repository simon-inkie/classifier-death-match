// The hosted API: what server.js does for the browser, as stateless handlers for Vercel Functions
// (one thin file per route under api/). State lives in a durable store (lib/storage.js), never on disk.
// It fails closed: no durable store, or no key, means no paid calls.
//
// Money and abuse controls, in the order a request meets them:
//  - a per-instance, in-memory throttle per client network (IPv6 /64) on every route, before any store read;
//  - match tokens signed with an HMAC, checked locally before any store read;
//  - per-network and site-wide limits on starting live matches;
//  - the spend model in lib/spend.js: a match reserves its worst-case budget against the day ceiling
//    atomically before it starts, each call reserves its worst case against the match before it runs,
//    unused budget goes back when the match ends or its play window closes;
//  - a strict, size-capped scene (lib/scene.js) and a capped prompt, so the worst case is a real bound;
//  - one call in flight per fighter per match, at least MIN_GAP_MS between call starts.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ROSTER, rosterById, MAX_FIGHTERS } from '../public/shared.js';
import { normaliseWeapons, DEFAULT_WEAPON_CONFIG } from '../public/weapons.js';
import { MAX_RECORDS } from '../public/leaderboard.js';
import { createStore, restConfig } from './storage.js';
import { spendConfig, worstCallUsd, matchReserveUsd, reserveMatch, releaseMatch, addExcess, dayStatus,
  CEILING_MESSAGE, BUSY_MESSAGE, PROMPT_CHAR_CAP } from './spend.js';
import { pickerEnabled, resolveFighter, createCatalogue, maxUsdPerCall } from './models.js';
import { callGateway } from './gateway.js';
import { cleanScene, isSceneError, promptChars } from './scene.js';
import { recordFromPlay } from './verify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLAY_S = 240; // a live match must finish within 4 minutes of starting, pauses included
const MATCH_TTL_S = 900;
const MIN_GAP_MS = 90; // between call starts for one fighter (the page asks at most every 100 ms)
const LB_KEY = 'leaderboard';
const LB_READ_MAX = 500;
const OPEN_KEY = 'open-matches';
const RECORDS_PER_NETWORK_PER_DAY = 20;
const LIMITS = { // per client network, per serverless instance: [requests, window ms]
  decide: [80, 1000], matchStart: [20, 60e3], matchEnd: [30, 60e3], record: [10, 60e3],
  leaderboard: [20, 60e3], status: [60, 60e3], models: [30, 60e3], logs: [60, 60e3], logFile: [60, 60e3], reset: [5, 60e3],
};
const BODY_LIMITS = { decide: 16e3, matchStart: 8e3, matchEnd: 1e3, record: 6e5, reset: 1e3 };
const known = (id) => typeof id === 'string' && Object.hasOwn(rosterById, id);
const isModel = (id) => known(id) && rosterById[id].kind !== 'bot';

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, code, body, extra = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const header = (req, name) => { const v = req.headers?.[name]; return Array.isArray(v) ? v[0] : v; };

// The size limit holds whether or not the platform has parsed the body already (Vercel sets req.body).
export async function readJson(req, limit) {
  const declared = Number(header(req, 'content-length'));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'request too large');
  if (req.body !== undefined && req.body !== null) {
    const s = typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? JSON.stringify(req.body) : String(req.body);
    if (s.length > limit) throw new HttpError(413, 'request too large');
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    try { return s ? JSON.parse(s) : {}; } catch { throw new HttpError(400, 'bad JSON'); }
  }
  const txt = await new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new HttpError(413, 'request too large')); req.destroy?.(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  try { return txt ? JSON.parse(txt) : {}; } catch { throw new HttpError(400, 'bad JSON'); }
}

// The client address as the platform reports it (Vercel overwrites x-forwarded-for and sets x-real-ip),
// reduced to the network one client controls: an IPv4 address, or an IPv6 /64.
export function clientNetwork(req) {
  let ip = String(header(req, 'x-real-ip') || String(header(req, 'x-forwarded-for') || '').split(',')[0] || req.socket?.remoteAddress || '').trim();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return 'unknown';
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${full.slice(0, 4).map((x) => parseInt(x || '0', 16).toString(16)).join(':')}::/64`;
}

function intEnv(env, name, dflt) {
  const n = env[name] == null || env[name] === '' ? dflt : Number(env[name]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid ${name}`);
  return n;
}

export function createHosted({ env = process.env, store, fetch: fetcher = fetch, now = () => Date.now(), root = ROOT, log = (m) => console.log(m) } = {}) {
  const KEY = env.AI_GATEWAY_API_KEY || '';
  const GATEWAY = env.AI_GATEWAY_BASE || 'https://ai-gateway.vercel.sh';
  const TIMEOUT_MS = Number(env.CALL_TIMEOUT_MS || 2000);
  const ceiling = spendConfig(env); // throws on a bad value: better a failed deploy than an unguarded one
  const picker = pickerEnabled(env);
  const maxCallUsd = maxUsdPerCall(env);
  const rate = { limit: intEnv(env, 'MATCH_RATE_LIMIT', 5), windowS: intEnv(env, 'MATCH_RATE_WINDOW_S', 600) || 600,
    global: intEnv(env, 'GLOBAL_MATCH_RATE_LIMIT', 30) };
  const db = store || createStore(env, { root, fetch: fetcher, now });
  // Shared by every instance: an explicit secret, else one derived from the store's own token. With
  // neither (local file or memory store, one process) a random per-process secret is enough.
  const rest = restConfig(env);
  const secret = env.ARENA_TOKEN_SECRET || (rest ? crypto.createHash('sha256').update(`arena-token-secret:${rest.token}`).digest('hex') : crypto.randomBytes(32).toString('hex'));
  const hmac = (s) => crypto.createHmac('sha256', secret).update(s).digest('hex');
  const salt = env.RATE_LIMIT_SALT || hmac('rate-limit-salt');
  const catalogue = createCatalogue({ env, fetch: fetcher, now });
  const examplesDir = path.join(root, 'examples');
  const cheapestMatch = matchReserveUsd([rosterById.jev, rosterById.laya]);

  // ---- per-instance throttle, no store involved
  const windows = new Map();
  function throttled(route, req) {
    const [limit, ms] = LIMITS[route] || [60, 60e3];
    const k = `${route}|${clientNetwork(req)}`, t = now();
    let w = windows.get(k);
    if (!w || t - w.start >= ms) { w = { start: t, n: 0 }; windows.set(k, w); }
    if (windows.size > 20000) for (const [key, v] of windows) if (t - v.start >= 60e3) windows.delete(key);
    return ++w.n > limit;
  }

  // ---- signed match tokens: id.signature, verified before touching the store
  const signToken = (id) => `${id}.${hmac(`match:${id}`).slice(0, 32)}`;
  function tokenId(token) {
    if (typeof token !== 'string') return null;
    const m = token.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-f]{32})$/);
    if (!m) return null;
    const want = Buffer.from(hmac(`match:${m[1]}`).slice(0, 32)), got = Buffer.from(m[2]);
    return crypto.timingSafeEqual(want, got) ? m[1] : null;
  }
  const netHash = (req) => crypto.createHash('sha256').update(`${salt}:${clientNetwork(req)}`).digest('hex').slice(0, 24);

  const paidBlocked = () => !KEY ? { status: 503, error: 'AI_GATEWAY_API_KEY not set', stop: true }
    : !db.durable ? { status: 503, error: 'live matches are off: no durable store is configured (KV_REST_API_URL / KV_REST_API_TOKEN)', stop: true }
    : null;
  const ceilingBody = () => ({ error: `daily budget spent: ${CEILING_MESSAGE}`, message: CEILING_MESSAGE, ceilingReached: true, stop: true });

  // Close a match once: give back its unused budget and forget it. info: {reserve, day, entry}.
  async function closeMatch(id, info) {
    const m = info || await db.get(`match:${id}`);
    if (!m) return false;
    if (await db.incr(`match:${id}:closed`, 86400) !== 1) return false;
    const spent = await db.get(`match:${id}:spent`);
    await releaseMatch(db, { reserve: m.reserve, day: m.day, spent });
    await Promise.all([db.del(`match:${id}`), db.listRemove(OPEN_KEY, m.entry || info)]);
    return true;
  }
  // Matches whose play window has closed give their unused budget back (the page usually ends them first).
  async function sweep() {
    const t = now();
    for (const e of await db.listRange(OPEN_KEY)) if (e && e.exp < t) await closeMatch(e.id, { ...e, entry: e });
  }

  const routes = {
    async status(req, res) {
      let spend;
      if (!db.durable) spend = { exhausted: true, durable: false };
      else {
        try { const s = await dayStatus(db, ceiling.usd, cheapestMatch, now()); spend = { exhausted: s.exhausted, busy: s.busy, durable: true }; }
        catch { spend = { exhausted: true, durable: true, error: 'store unavailable' }; }
      }
      return send(res, 200, { hosted: true, keyLoaded: Boolean(KEY), modelPicker: picker, spend,
        spendMessage: !spend.durable ? 'Live matches are not available on this deployment.' : spend.exhausted ? CEILING_MESSAGE : null,
        roster: ROSTER.map(({ id, name, model, kind, transport }) => ({ id, name, model, kind, transport })) });
    },

    async models(req, res) {
      if (!picker) return send(res, 200, { enabled: false, models: [] });
      const { source, models } = await catalogue();
      return send(res, 200, { enabled: true, source, models: models.filter((m) => m.price).map(({ id, name, price }) => ({ id, name, price })) });
    },

    // POST {fighters, models?, seed, weapons} -> {matchToken}. Fighters, models, seed and weapons are fixed
    // here for the whole match; then the rate limits; then the match's budget is reserved, or refused.
    async matchStart(req, res) {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const blocked = paidBlocked();
      if (blocked) return send(res, blocked.status, blocked);
      const body = await readJson(req, BODY_LIMITS.matchStart);
      const ids = body?.fighters;
      if (!Array.isArray(ids) || ids.length < 2 || ids.length > MAX_FIGHTERS || new Set(ids).size !== ids.length || !ids.every(known))
        return send(res, 400, { error: `pick 2 to ${MAX_FIGHTERS} different known fighters` });
      const seed = Number.isInteger(body.seed) && Math.abs(body.seed) <= 1e9 ? body.seed : 1;
      let weapons;
      try { weapons = normaliseWeapons(body.weapons && typeof body.weapons === 'object' ? body.weapons : DEFAULT_WEAPON_CONFIG); }
      catch { return send(res, 400, { error: 'bad weapon config' }); }
      if (body.weapons?.modelAims === true) weapons.modelAims = true; else delete weapons.modelAims;
      const want = body.models && typeof body.models === 'object' ? body.models : {};
      const models = picker ? (await catalogue()).models : undefined;
      const fighters = {};
      for (const id of ids.filter(isModel)) {
        const r = resolveFighter(id, Object.hasOwn(want, id) ? want[id] : undefined, { enabled: picker, models, maxCallUsd });
        if (!r.ok) return send(res, r.status, { error: `${id}: ${r.error}` });
        const f = r.fighter;
        fighters[id] = { model: f.model, kind: f.kind, transport: f.transport, prompt: f.prompt, stateObject: f.stateObject, price: f.price, picked: r.picked };
      }
      if (!Object.keys(fighters).length) return send(res, 400, { error: 'a live match needs at least one model fighter' });
      const t = now(), win = Math.floor(t / 1000 / rate.windowS);
      const [mine, all] = await Promise.all([db.incr(`rl:start:${netHash(req)}:${win}`, rate.windowS + 5),
        db.incr(`rl:start:all:${Math.floor(t / 60e3)}`, 65)]);
      if (mine > rate.limit) {
        const retryAfter = rate.windowS - Math.floor(t / 1000) % rate.windowS;
        return send(res, 429, { error: `too many matches started from your network; try again in ${Math.ceil(retryAfter / 60)} min`, rateLimited: true, retryAfter },
          { 'Retry-After': String(retryAfter) });
      }
      if (all > rate.global) return send(res, 429, { error: 'the arena is very busy; try again in a minute', rateLimited: true, retryAfter: 60 }, { 'Retry-After': '60' });
      await sweep();
      const reserve = matchReserveUsd(Object.values(fighters));
      const held = await reserveMatch(db, reserve, ceiling.usd, t);
      if (!held.ok) return send(res, 429, held.reason === 'spent' ? ceilingBody()
        : { error: BUSY_MESSAGE, message: BUSY_MESSAGE, busy: true, stop: true });
      const id = crypto.randomUUID();
      const entry = { id, exp: t + (PLAY_S + 30) * 1000, reserve, day: held.day };
      await db.set(`match:${id}`, { roster: ids, fighters, seed, weapons, created: t, playUntil: t + PLAY_S * 1000, reserve, day: held.day, entry }, MATCH_TTL_S);
      await db.listPush(OPEN_KEY, entry, 1000);
      return send(res, 200, { matchToken: signToken(id), playS: PLAY_S });
    },

    // POST {matchToken, fighter, scene}. Model and weapons come from the match record, never the body.
    async decide(req, res) {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const blocked = paidBlocked();
      if (blocked) return send(res, blocked.status, blocked);
      const body = await readJson(req, BODY_LIMITS.decide);
      const { fighter: fid, scene, model } = body || {};
      const id = tokenId(body?.matchToken);
      if (!id) return send(res, 403, { error: 'no valid match token: press Start again', stop: true });
      if (!isModel(fid)) return send(res, 400, { error: 'unknown fighter' });
      const lock = `lock:${id}:${fid}`, t0 = now();
      const [m, got] = await Promise.all([db.get(`match:${id}`), db.setNx(lock, 1, TIMEOUT_MS + 1500)]);
      const release = async () => { const el = now() - t0; await (el >= MIN_GAP_MS ? db.del(lock) : db.setPx(lock, 1, MIN_GAP_MS - el)); };
      // refused before any paid call: free the lock at once; after a call, keep MIN_GAP_MS between starts
      const refuse = async (code, b) => { if (got) await db.del(lock); return send(res, code, b); };
      if (!m) return refuse(403, { error: 'match over or unknown: press Start again', stop: true });
      if (!got) return send(res, 429, { error: 'one call at a time per fighter' });
      if (!Object.hasOwn(m.fighters, fid)) return refuse(400, { error: 'fighter not in this match' });
      if (model != null && model !== m.fighters[fid].model) return refuse(400, { error: 'model differs from the one fixed at match start' });
      if (t0 > m.playUntil) return refuse(403, { error: 'match time is up: press Start again', stop: true });
      const fighter = { ...rosterById[fid], ...m.fighters[fid] };
      let sc;
      try { sc = cleanScene(scene, { self: fid, others: m.roster, modelAims: Boolean(m.weapons.modelAims) }); }
      catch (e) { if (isSceneError(e)) return refuse(400, { error: e.message }); throw e; }
      if (promptChars(fighter, sc, m.weapons) > PROMPT_CHAR_CAP) return refuse(400, { error: 'prompt too long' });
      const worst = worstCallUsd(fighter), spentKey = `match:${id}:spent`;
      if (await db.incrFloat(spentKey, worst, 86400) > m.reserve + 1e-9) {
        await db.incrFloat(spentKey, -worst, 86400);
        return refuse(429, { error: 'call budget spent for this match', stop: true });
      }
      const out = await callGateway(fighter, sc, m.weapons, { key: KEY, gateway: GATEWAY, timeoutMs: TIMEOUT_MS, fetch: fetcher, log });
      const p = out.ok ? out.parsed : null;
      const actual = out.ok ? (p.costSource === 'none' ? worst : Math.max(0, Number(p.cost) || 0))
        : out.billed === 'none' ? 0 : out.billed === 'unknown' ? worst : out.billed;
      // below the worst case: hand the difference back to the match; above it (the bound was wrong):
      // the match keeps its worst case and the excess goes straight onto the day
      const delta = actual - worst;
      await Promise.all([
        delta < 0 ? db.incrFloat(spentKey, delta, 86400) : null,
        delta > 0 ? addExcess(db, delta, m.day) : null,
        out.ok ? db.listPush(`match:${id}:acts:${fid}`, p.action, 5000, MATCH_TTL_S) : null,
        release(),
      ]);
      if (!out.ok) return send(res, out.status, { error: out.error, ms: out.ms });
      return send(res, 200, { ...p, upstreamMs: out.ms });
    },

    // POST {matchToken}: the page is done with the match (stopped, restarted or left); the unused budget
    // goes back now rather than when the play window closes.
    async matchEnd(req, res) {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const id = tokenId((await readJson(req, BODY_LIMITS.matchEnd))?.matchToken);
      if (!id) return send(res, 403, { error: 'no valid match token' });
      return send(res, 200, { ok: true, closed: await closeMatch(id) });
    },

    leaderboard(req, res) {
      return db.listTail(LB_KEY, LB_READ_MAX).then((matches) =>
        send(res, 200, { version: 1, matches }, { 'Cache-Control': 'public, max-age=0, s-maxage=30' }));
    },

    // POST {decisions} with X-Match-Token. The record is built on the server from a re-run of the match,
    // checked against the answers the server gave (lib/verify.js). One record per match.
    async record(req, res) {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const id = tokenId(header(req, 'x-match-token'));
      if (!id) return send(res, 403, { error: 'only live matches started on this site are recorded' });
      const body = await readJson(req, BODY_LIMITS.record);
      const m = await db.get(`match:${id}`);
      if (!m) return send(res, 403, { error: 'match over or unknown' });
      if (Object.values(m.fighters).some((f) => f.picked)) return send(res, 403, { error: 'matches with picked models are not recorded' });
      if (m.roster.some((rid) => !isModel(rid))) return send(res, 403, { error: 'matches with the scripted bot are not recorded here' });
      const day = new Date(now()).toISOString().slice(0, 10);
      if (await db.incr(`rl:rec:${netHash(req)}:${day}`, 86400 + 60) > RECORDS_PER_NETWORK_PER_DAY) return send(res, 429, { error: 'record limit reached for today' });
      const serverActions = Object.fromEntries(await Promise.all(m.roster.map(async (f) => [f, await db.listRange(`match:${id}:acts:${f}`)])));
      let out;
      try { out = recordFromPlay({ m, decisions: body?.decisions, serverActions, ts: new Date(now()).toISOString() }); }
      catch (e) { return send(res, 400, { error: String(e.message).slice(0, 120) }); }
      if (now() - m.created < (out.state.tick / 30) * 1000 * 0.8) return send(res, 400, { error: 'match finished faster than real time' });
      if (await db.incr(`match:${id}:recorded`, 86400) > 1) return send(res, 409, { error: 'already recorded' });
      const count = await db.listPush(LB_KEY, out.record, MAX_RECORDS);
      await closeMatch(id);
      return send(res, 200, { ok: true, count, record: out.record });
    },

    // Off unless ARENA_ADMIN_TOKEN is set, and then only with it as a bearer token.
    async reset(req, res) {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
      const admin = env.ARENA_ADMIN_TOKEN || '';
      const given = String(header(req, 'authorization') || '').replace(/^Bearer\s+/i, '');
      const digest = (s) => crypto.createHash('sha256').update(s).digest();
      if (admin.length < 16 || !crypto.timingSafeEqual(digest(given), digest(admin))) return send(res, 403, { error: 'leaderboard reset is disabled on the hosted site' });
      const body = await readJson(req, BODY_LIMITS.reset);
      if (body?.confirm !== 'RESET') return send(res, 400, { error: 'send {"confirm":"RESET"}' });
      await db.del(LB_KEY);
      return send(res, 200, { ok: true, count: 0 });
    },

    // Bundled example logs only; a finished match's log is not stored here (Download keeps it).
    logs(req, res) {
      if (req.method === 'POST') return send(res, 200, { name: null, stored: false });
      const files = fs.existsSync(examplesDir) ? fs.readdirSync(examplesDir).filter((f) => /^example-[\w.-]+\.json$/.test(f)).sort() : [];
      return send(res, 200, files);
    },

    logFile(req, res) {
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
        if (!Object.hasOwn(routes, route)) return send(res, 404, { error: 'not found' });
        if (throttled(route, req)) return send(res, 429, { error: 'too many requests; slow down', retryAfter: 1 }, { 'Retry-After': '1' });
        return await routes[route](req, res);
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.message });
        // store or other failure: fail closed, without echoing anything that might hold configuration
        log(`hosted ${route} error: ${String(e?.message).slice(0, 200)}`);
        return send(res, 500, { error: 'server error', stop: true });
      }
    },
  };
}

// One instance per serverless instance, created on first use so a cold start reads the env once.
let shared = null;
export const handler = (route) => (req, res) => (shared ||= createHosted()).handle(route, req, res);
