// The hosted API: what server.js does for the browser, as stateless handlers for Vercel Functions
// (one thin file per route under api/). State lives in a durable store (lib/storage.js), never on disk.
// It fails closed: no durable store, or no key, means no paid calls.
//
// Money and abuse controls, in the order a request meets them:
//  - a per-instance, in-memory throttle per client network (IPv6 /64) on every route, before any store read;
//  - match tokens signed with an HMAC, checked locally before any store read;
//  - per-network and site-wide limits on starting live matches, one open live match per network, and a
//    cap on any one match's full budget (MAX_MATCH_SHARE of the day);
//  - the spend model in lib/spend.js: a match reserves its budget against the day ceiling in tranches,
//    atomically; each call reserves its bound against the match before it runs, re-checks that the
//    match is still open and the day is not over the ceiling, and is charged any cost above its bound;
//    unused budget goes back when the match ends, idles or its play window closes;
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
import { spendConfig, callBound, matchReserveUsd, trancheUsd, reserveMatch, releaseMatch, addExcess, dayStatus, daySpendKey,
  CEILING_MESSAGE, BUSY_MESSAGE, PROMPT_CHAR_CAP } from './spend.js';
import { pickerEnabled, resolveFighter, createCatalogue, maxUsdPerCall, pickableModels } from './models.js';
import { callGateway } from './gateway.js';
import { cleanScene, isSceneError, promptChars } from './scene.js';
import { recordFromPlay } from './verify.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLAY_S = 150; // a live match must finish within 2.5 minutes of starting, pauses included
export const IDLE_S = 20; // an open match with no call attempt for this long is closed at the next sweep
export const MIN_LIFE_S = 20; // a match holds its site-wide slot at least this long, even if ended at once
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
// IPv4 address, or an IPv6 prefix: /64 by default, /48 for limits on starting and holding matches
export function clientNetwork(req, v6bits = 64) {
  let ip = String(header(req, 'x-real-ip') || String(header(req, 'x-forwarded-for') || '').split(',')[0] || req.socket?.remoteAddress || '').trim();
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) return ip;
  if (!net.isIPv6(ip)) return 'unknown';
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const full = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${full.slice(0, v6bits === 48 ? 3 : 4).map((x) => parseInt(x || '0', 16).toString(16)).join(':')}::/${v6bits === 48 ? 48 : 64}`;
}

function intEnv(env, name, dflt) {
  const n = env[name] == null || env[name] === '' ? dflt : Number(env[name]);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid ${name}`);
  return n;
}

// Work that may finish after the response: Vercel's waitUntil when the runtime provides it (the same
// request-context lookup @vercel/functions uses), else it is awaited, so nothing is ever dropped.
function vercelWaitUntil() {
  try { return globalThis[Symbol.for('@vercel/request-context')]?.get?.()?.waitUntil ?? null; } catch { return null; }
}

export function createHosted({ env = process.env, store, fetch: fetcher = fetch, now = () => Date.now(), root = ROOT, log = (m) => console.log(m),
  waitUntil = null } = {}) {
  const later = async (p) => {
    const keep = waitUntil || vercelWaitUntil();
    const safe = Promise.resolve(p).catch((e) => log(`background store write failed: ${e.message}`));
    if (keep) keep(safe); else await safe;
  };
  // Match records never change after start, so each instance keeps the ones it has seen and a warm decide
  // skips that read. Whether the match is still open is never taken from here: decide re-reads closed.
  const matchCache = new Map();
  const cacheMatch = (id, m) => {
    matchCache.set(id, m);
    if (matchCache.size > 2000) matchCache.delete(matchCache.keys().next().value);
  };
  const cachedMatch = (id, t) => { const m = matchCache.get(id); if (m && t > m.created + MATCH_TTL_S * 1000) { matchCache.delete(id); return null; } return m || null; };
  const KEY = env.AI_GATEWAY_API_KEY || '';
  const GATEWAY = env.AI_GATEWAY_BASE || 'https://ai-gateway.vercel.sh';
  const TIMEOUT_MS = Number(env.CALL_TIMEOUT_MS || 2000);
  const ceiling = spendConfig(env); // throws on a bad value: better a failed deploy than an unguarded one
  const picker = pickerEnabled(env);
  const maxCallUsd = maxUsdPerCall(env);
  const rate = { limit: intEnv(env, 'MATCH_RATE_LIMIT', 5), windowS: intEnv(env, 'MATCH_RATE_WINDOW_S', 600) || 600,
    maxOpen: intEnv(env, 'MAX_OPEN_MATCHES', 40) };
  if (rate.maxOpen < 1 || rate.maxOpen > 1000) throw new Error('invalid MAX_OPEN_MATCHES');
  const share = env.MAX_MATCH_SHARE == null || env.MAX_MATCH_SHARE === '' ? 0.25 : Number(env.MAX_MATCH_SHARE);
  if (!(share > 0 && share <= 1)) throw new Error('invalid MAX_MATCH_SHARE');
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

  // ---- signed match tokens: id.expiry.signature, verified (and expired) before touching the store
  const signToken = (id, expS) => `${id}.${expS}.${hmac(`match:${id}:${expS}`).slice(0, 32)}`;
  function tokenId(token) {
    if (typeof token !== 'string') return null;
    const m = token.match(/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(\d{1,12})\.([0-9a-f]{32})$/);
    if (!m) return null;
    const want = Buffer.from(hmac(`match:${m[1]}:${m[2]}`).slice(0, 32)), got = Buffer.from(m[3]);
    return crypto.timingSafeEqual(want, got) && Number(m[2]) * 1000 > now() ? m[1] : null;
  }
  const netHash = (req, v6bits) => crypto.createHash('sha256').update(`${salt}:${clientNetwork(req, v6bits)}`).digest('hex').slice(0, 24);

  const paidBlocked = () => !KEY ? { status: 503, error: 'AI_GATEWAY_API_KEY not set', stop: true }
    : !db.durable ? { status: 503, error: 'live matches are off: no durable store is configured (KV_REST_API_URL / KV_REST_API_TOKEN)', stop: true }
    : null;
  const ceilingBody = () => ({ error: `daily budget spent: ${CEILING_MESSAGE}`, message: CEILING_MESSAGE, ceilingReached: true, stop: true });

  const mk = (id, k) => `match:${id}:${k}`;
  // Close a match once: give back its unused budget and forget it. entry: its open-list entry
  // ({id, exp, created, day, net}), from the match record or the sweep. The closed flag is set before
  // the counters are read; decide re-checks it after reserving, so a call is either counted here or refused.
  // Give a top-up tranche back to the day, once. closeMatch sets closed before it reads the reserve, so
  // with closed still unset after the reserve was lowered, close (if it comes) sees the lowered reserve
  // and this refund is the only one. With closed set, close may already have refunded the tranche, so it
  // stays on the day (held until midnight: the safe direction). topUp names the top-up being undone; its
  // guard key means that tranche is given back at most once, whoever calls this.
  async function handBack(id, topUp, day, tranche) {
    if (await db.get(mk(id, 'closed'))) return false;
    if (!await db.setNx(mk(id, `handback:${topUp}`), 1, 86400e3)) return false;
    await db.incrFloat(daySpendKey(day), -tranche, 3 * 86400);
    return true;
  }
  async function budgetSpentBody(id) {
    const priced = Boolean(await db.get(mk(id, 'dear')));
    return { error: priced ? 'call budget spent for this match: calls cost more than their listed price' : 'call budget spent for this match', stop: true };
  }
  async function closeMatch(id, entry) {
    const e = entry || (await db.get(`match:${id}`))?.entry;
    if (!e) return false;
    if (await db.incr(mk(id, 'closed'), 86400) !== 1) return false;
    const [reserve, excess, spent, holder] = await Promise.all([db.get(mk(id, 'reserve')), db.get(mk(id, 'excess')), db.get(mk(id, 'spent')), db.get(`open:net:${e.net}`)]);
    await releaseMatch(db, { reserve, excess, spent, day: e.day });
    // a match ended young keeps its site-wide slot until MIN_LIFE_S as a placeholder entry (pushed before the
    // real entry goes, so the count never dips), so starting and ending at once is not a free way to churn
    const t = now(), young = t - e.created < MIN_LIFE_S * 1000;
    if (young) await db.listPush(OPEN_KEY, { id, ghost: 1, exp: e.created + MIN_LIFE_S * 1000 }, 2000);
    await Promise.all([db.del(`match:${id}`), db.listRemove(OPEN_KEY, e), holder === id ? db.del(`open:net:${e.net}`) : null]);
    return true;
  }
  // Matches past their play window, or idle since they started, give their budget back.
  async function sweep() {
    const t = now();
    for (const e of await db.listRange(OPEN_KEY)) {
      if (!e) continue;
      if (e.ghost) { if (e.exp < t) await db.listRemove(OPEN_KEY, e); continue; }
      // idle: no call attempt (paid, free or failed) for IDLE_S; a match that never called counts from its start
      if (e.exp < t || (t - e.created > IDLE_S * 1000 && t - (Number(await db.get(mk(e.id, 'last'))) || e.created) > IDLE_S * 1000)) await closeMatch(e.id, e);
    }
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
        roster: ROSTER.map(({ id, name, model, kind, transport }) => ({ id, name, model, kind, transport })) },
      { 'Cache-Control': 'public, max-age=0, s-maxage=5' });
    },

    async models(req, res) {
      if (!picker) return send(res, 200, { enabled: false, models: [] });
      const { source, models } = await catalogue();
      return send(res, 200, { enabled: true, source, models: pickableModels(models, maxCallUsd) });
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
        const f = r.fighter, rosterModel = ROSTER.some((x) => x.model === f.model);
        fighters[id] = { model: f.model, kind: f.kind, transport: f.transport, prompt: f.prompt, stateObject: f.stateObject, price: f.price,
          picked: r.picked, bound: callBound(f, !rosterModel) };
      }
      if (!Object.keys(fighters).length) return send(res, 400, { error: 'a live match needs at least one model fighter' });
      const full = matchReserveUsd(Object.values(fighters));
      if (full > share * ceiling.usd) return send(res, 400, { error: 'this line-up is too expensive for this arena: pick fewer or cheaper fighters' });
      // per-network limit first: every start counts against the caller's own network (IPv6 grouped by /48),
      // including one that is ended at once. The site-wide limit is on open matches, below.
      const t = now(), win = Math.floor(t / 1000 / rate.windowS), net = netHash(req, 48);
      const mine = await db.incr(`rl:start:${net}:${win}`, rate.windowS + 5);
      if (mine > rate.limit) {
        const retryAfter = rate.windowS - Math.floor(t / 1000) % rate.windowS;
        return send(res, 429, { error: `too many matches started from your network; try again in ${Math.ceil(retryAfter / 60)} min`, rateLimited: true, retryAfter },
          { 'Retry-After': String(retryAfter) });
      }
      await sweep();
      const id = crypto.randomUUID();
      if (!await db.setNx(`open:net:${net}`, id, (PLAY_S + 60) * 1000))
        return send(res, 429, { error: 'you already have a live match running: finish or stop it first', oneAtATime: true });
      // the record and open entry go in before any money is reserved, so a crash can only leak in the safe direction
      const entry = { id, exp: t + (PLAY_S + 30) * 1000, created: t, day: new Date(t).toISOString().slice(0, 10), net };
      const record = { roster: ids, fighters, seed, weapons, created: t, playUntil: t + PLAY_S * 1000, full, entry };
      await db.set(`match:${id}`, record, MATCH_TTL_S);
      cacheMatch(id, record);
      // site-wide cap on open matches, increment then compare: the push returns the new length atomically,
      // and a start over the cap takes its entry back out (refused starts hold nothing)
      if (await db.listPush(OPEN_KEY, entry, 2000) > rate.maxOpen) {
        await Promise.all([db.del(`match:${id}`), db.listRemove(OPEN_KEY, entry), db.del(`open:net:${net}`), db.incr(mk(id, 'closed'), 86400)]);
        return send(res, 429, { error: 'the arena is very busy; try again in a minute', rateLimited: true, retryAfter: 60 }, { 'Retry-After': '60' });
      }
      const tranche = trancheUsd(full);
      const held = await reserveMatch(db, tranche, ceiling.usd, t);
      if (!held.ok) {
        await Promise.all([db.del(`match:${id}`), db.listRemove(OPEN_KEY, entry), db.del(`open:net:${net}`), db.incr(mk(id, 'closed'), 86400)]);
        return send(res, 429, held.reason === 'spent' ? ceilingBody() : { error: BUSY_MESSAGE, message: BUSY_MESSAGE, busy: true, stop: true });
      }
      await db.incrFloat(mk(id, 'reserve'), tranche, 86400);
      return send(res, 200, { matchToken: signToken(id, Math.floor(t / 1000) + MATCH_TTL_S), playS: PLAY_S });
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
      const lock = `lock:${id}:${fid}`, t0 = now(), p0 = performance.now();
      let kvRounds = 0, kvMs = 0; // serial store round trips on this request's path, and time spent in them
      const timed = async (p) => { const a = performance.now(); try { return await p; } finally { kvMs += performance.now() - a; } };
      const kv = (ops) => { kvRounds++; return timed(db.multi(ops)); };
      // Checks that need only the match record, before any store write. Returns a refusal or the call.
      const vet = (m) => {
        if (!Object.hasOwn(m.fighters, fid)) return { code: 400, b: { error: 'fighter not in this match' } };
        if (model != null && model !== m.fighters[fid].model) return { code: 400, b: { error: 'model differs from the one fixed at match start' } };
        if (t0 > m.playUntil) return { code: 403, b: { error: 'match time is up: press Start again', stop: true } };
        const fighter = { ...rosterById[fid], ...m.fighters[fid] };
        let sc;
        try { sc = cleanScene(scene, { self: fid, others: m.roster, modelAims: Boolean(m.weapons.modelAims) }); }
        catch (e) { if (isSceneError(e)) return { code: 400, b: { error: e.message } }; throw e; }
        if (promptChars(fighter, sc, m.weapons) > PROMPT_CHAR_CAP) return { code: 400, b: { error: 'prompt too long' } };
        return { fighter, sc };
      };
      const lockOp = ['setNx', lock, 1, TIMEOUT_MS + 1500];
      let m = cachedMatch(id, t0), got, v, spent, closed, dayTotal, reserved, bound, spentKey, live;
      // reserve the call's bound against the match, then (in the same ordered round trip) re-read closed
      // (closeMatch sets it before reading spent), the day total, the match's reserve and the match record
      // itself: a record that is gone means the match is over, even if the closed flag was lost too
      const reserveOps = () => [['incrFloat', spentKey, bound, 86400], ['get', mk(id, 'closed')], ['get', daySpendKey(m.entry.day)], ['get', mk(id, 'reserve')], ['get', `match:${id}`]];
      if (m) {
        // warm: one round trip for the lock, the reservation and the re-reads
        v = vet(m);
        if (v.code) return send(res, v.code, v.b);
        bound = m.fighters[fid].bound; spentKey = mk(id, 'spent');
        [got, spent, closed, dayTotal, reserved, live] = await kv([lockOp, ...reserveOps()]);
        if (!got) { await db.incrFloat(spentKey, -bound, 86400); return send(res, 429, { error: 'one call at a time per fighter' }); }
      } else {
        [m, got] = await kv([['get', `match:${id}`], lockOp]);
        const unlock = () => (got ? db.del(lock) : null);
        if (!m) { await unlock(); return send(res, 403, { error: 'match over or unknown: press Start again', stop: true }); }
        if (!got) return send(res, 429, { error: 'one call at a time per fighter' });
        cacheMatch(id, m);
        v = vet(m);
        if (v.code) { await unlock(); return send(res, v.code, v.b); }
        bound = m.fighters[fid].bound; spentKey = mk(id, 'spent');
        [spent, closed, dayTotal, reserved, live] = await kv(reserveOps());
      }
      const { fighter, sc } = v;
      // refused before any paid call: free the lock at once; after a call, keep MIN_GAP_MS between starts
      const refuse = async (code, b) => { await db.del(lock); return send(res, code, b); };
      const rollback = () => db.incrFloat(spentKey, -bound, 86400);
      if (closed || !live) { matchCache.delete(id); await rollback(); return refuse(403, { error: 'match over: press Start again', stop: true }); }
      if ((Number(dayTotal) || 0) > ceiling.usd + 1e-9) { await rollback(); return refuse(429, ceilingBody()); }
      if (spent > (Number(reserved) || 0) + 1e-9) {
        const tranche = trancheUsd(m.full);
        if ((Number(reserved) || 0) + tranche > m.full + 1e-9) { await rollback(); return refuse(429, await budgetSpentBody(id)); }
        const held = await reserveMatch(db, tranche, ceiling.usd, now(), Number(reserved) || 0), topUp = crypto.randomUUID();
        if (!held.ok && held.reason === 'busy') {
          // another fighter of this match may have topped up at the same moment: if that covers this call, go on
          const nowReserved = Number(await db.get(mk(id, 'reserve'))) || 0;
          if (spent <= nowReserved + 1e-9) held.covered = true;
          else if (nowReserved + tranche > m.full + 1e-9) { await rollback(); return refuse(429, await budgetSpentBody(id)); }
        }
        if (!held.covered && (!held.ok || held.day !== m.entry.day)) {
          if (held.ok) await db.incrFloat(daySpendKey(held.day), -tranche, 3 * 86400); // day rolled over: undo, do not mix days
          await rollback();
          return refuse(429, !held.ok && held.reason === 'busy' ? { error: BUSY_MESSAGE, message: BUSY_MESSAGE, busy: true, stop: true } : ceilingBody());
        }
        // covered: no tranche was reserved here, so none to add or hand back
        let total = held.covered ? 0 : await db.incrFloat(mk(id, 'reserve'), tranche, 86400);
        // re-checked after the increment: over the full bound (another fighter topped up at the same moment),
        // or closed (close may have read the reserve before this tranche reached it)
        const closedNow = held.covered || total > m.full + 1e-9 ? false : await db.get(mk(id, 'closed'));
        if (!held.covered && (total > m.full + 1e-9 || closedNow)) {
          total = await db.incrFloat(mk(id, 'reserve'), -tranche, 86400);
          await handBack(id, topUp, held.day, tranche);
          if (closedNow) { await rollback(); return refuse(403, { error: 'match over: press Start again', stop: true }); }
        }
        if (!held.covered && spent > total + 1e-9) { await rollback(); return refuse(429, await budgetSpentBody(id)); }
      }
      const p1 = performance.now();
      const out = await callGateway(fighter, sc, m.weapons, { key: KEY, gateway: GATEWAY, timeoutMs: TIMEOUT_MS, fetch: fetcher, log });
      const p2 = performance.now(), preRounds = kvRounds;
      // the idle sweep counts attempts, whatever they cost; it is not needed by this response
      const lastWrite = later(db.set(mk(id, 'last'), now(), MATCH_TTL_S));
      const p = out.ok ? out.parsed : null;
      const actual = out.ok ? (p.costSource === 'none' ? bound : Math.max(0, Number(p.cost) || 0))
        : out.billed === 'none' ? 0 : out.billed === 'unknown' ? bound : out.billed;
      // the match is charged what the call cost. Excess above the bound is covered by the match's own
      // reserve while it lasts; only the part that takes spent past the reserve goes onto the day now
      // (counting it in both would cut the day short while the match is open). Close settles exactly.
      const delta = actual - bound;
      // Settlement stays on the response path, in one ordered round trip: the charge, the observation the
      // leaderboard check needs (a record can follow the last answer at once), and the lock release. When
      // the call cost more than its bound, spent is raised first and closed read after in the same trip:
      // if close has not begun, it will read this charge and settle it; if it has, it may have missed it,
      // so the whole excess goes onto the day (safe direction).
      // Money and bookkeeping go as two pipelines in parallel (still one round trip), so a failed
      // bookkeeping command can never stop the excess reaching the day.
      const el = now() - t0;
      const money = [
        ...(delta ? [['incrFloat', spentKey, delta, 86400]] : []),
        ...(delta > 0 ? [['set', mk(id, 'dear'), 1, 86400], ['get', mk(id, 'reserve')], ['get', mk(id, 'closed')]] : []),
      ];
      const book = [
        ['listPush', mk(id, `acts:${fid}`), out.ok ? { ok: 1, a: p.action, ms: out.ms, c: actual } : { ok: 0, ms: out.ms, c: actual, to: out.status === 504 ? 1 : 0 }, 5000, MATCH_TTL_S],
        el >= MIN_GAP_MS ? ['del', lock] : ['setPx', lock, 1, MIN_GAP_MS - el],
      ];
      kvRounds++;
      const [mr, br] = await timed(Promise.allSettled([money.length ? db.multi(money) : [], db.multi(book)]));
      if (mr.status === 'rejected') throw mr.reason;
      if (delta > 0) {
        const [total, , resv, closedAfter] = mr.value;
        const over = closedAfter ? delta : Math.min(delta, total - (Number(resv) || 0));
        if (over > 1e-12) { kvRounds++; await timed(Promise.all([addExcess(db, over, m.entry.day), db.incrFloat(mk(id, 'excess'), over, 86400)])); }
      }
      if (br.status === 'rejected') throw br.reason;
      await lastWrite; // a no-op wait under waitUntil; the write itself when there is none
      const p3 = performance.now();
      // kv counts the batched round trips; a tranche top-up (one call in a hundred) adds a few more, not timed here
      const timing = { 'Server-Timing': [`kv;dur=${kvMs.toFixed(1)};desc="store, ${preRounds} before + ${kvRounds - preRounds} after"`,
        `gateway;dur=${(p2 - p1).toFixed(1)}`, `total;dur=${(p3 - p0).toFixed(1)}`].join(', ') };
      if (!out.ok) return send(res, out.status, { error: out.error, ms: out.ms }, timing);
      return send(res, 200, { ...p, upstreamMs: out.ms }, timing);
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
      if (String(req.url || '').includes('?')) return send(res, 404, { error: 'not found' }); // one cache key
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
      const observed = Object.fromEntries(await Promise.all(m.roster.map(async (f) => [f, await db.listRange(`match:${id}:acts:${f}`)])));
      let out;
      try { out = recordFromPlay({ m, decisions: body?.decisions, observed, ts: new Date(now()).toISOString() }); }
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
