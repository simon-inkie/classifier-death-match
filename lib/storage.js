// Pluggable key-value storage for the hosted (serverless) API: the daily spend counter, rate limits,
// match tokens and the leaderboard. Three back ends with one small async interface:
//   - RestStore: Upstash Redis / Vercel KV over their REST API (durable, shared between instances)
//   - FileStore: one JSON file under data/ (durable on one machine; local development)
//   - MemoryStore: in-process only (tests; and the fail-closed fallback on Vercel without a store)
// Interface: get, set, incr, incrFloat, listPush, listRange, del. Values are JSON. ttlSec is optional.
import fs from 'node:fs';
import path from 'node:path';

export class MemoryStore {
  kind = 'memory';
  durable = false;
  constructor({ now = () => Date.now() } = {}) { this.now = now; this.map = new Map(); }
  #live(key) {
    const e = this.map.get(key);
    if (e && e.exp != null && e.exp <= this.now()) { this.map.delete(key); return undefined; }
    return e;
  }
  #put(key, v, ttlSec, keepTtl = false) {
    const old = this.#live(key);
    const exp = ttlSec ? this.now() + ttlSec * 1000 : keepTtl ? old?.exp ?? null : null;
    this.map.set(key, { v, exp });
    this.changed();
  }
  changed() {}
  async get(key) { const e = this.#live(key); return e === undefined ? null : structuredClone(e.v); }
  async set(key, value, ttlSec) { this.#put(key, structuredClone(value), ttlSec); }
  async del(key) { this.map.delete(key); this.changed(); }
  async incr(key, ttlSec) { return this.incrFloat(key, 1, ttlSec); }
  async incrFloat(key, by, ttlSec) {
    const n = (Number(this.#live(key)?.v) || 0) + Number(by);
    this.#put(key, n, ttlSec, true);
    return n;
  }
  async listPush(key, value, max) {
    const list = Array.isArray(this.#live(key)?.v) ? this.#live(key).v : [];
    list.push(structuredClone(value));
    if (max && list.length > max) list.splice(0, list.length - max);
    this.#put(key, list, null, true);
    return list.length;
  }
  async listRange(key) { const v = this.#live(key)?.v; return Array.isArray(v) ? structuredClone(v) : []; }
}

// Same semantics as MemoryStore, written atomically (temp file + rename) to one JSON file on each change.
export class FileStore extends MemoryStore {
  kind = 'file';
  durable = true;
  constructor({ file, now } = {}) {
    super({ now });
    this.file = file;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      try { this.map = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))); }
      catch { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); }
    }
  }
  changed() {
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
    fs.renameSync(tmp, this.file);
  }
}

// Upstash Redis REST (also what Vercel KV exposes). Every call is one POST of a command array, or of an
// array of them to /pipeline. The token never leaves the server and is never logged.
export class RestStore {
  kind = 'rest';
  durable = true;
  constructor({ url, token, fetch: fetcher = fetch, timeoutMs = 3000 }) {
    if (!/^https:\/\//.test(url)) throw new Error('KV REST URL must be https');
    this.url = url.replace(/\/+$/, ''); this.token = token; this.fetch = fetcher; this.timeoutMs = timeoutMs;
  }
  async #post(pathname, body) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const r = await this.fetch(`${this.url}${pathname}`, { method: 'POST', signal: ctl.signal,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`store HTTP ${r.status}`);
      return j;
    } finally { clearTimeout(timer); }
  }
  async cmd(...args) {
    const j = await this.#post('', args.map(String));
    if (j.error) throw new Error(`store: ${j.error}`);
    return j.result;
  }
  async pipeline(cmds) {
    const out = await this.#post('/pipeline', cmds.map((c) => c.map(String)));
    if (!Array.isArray(out)) throw new Error('store: bad pipeline reply');
    const err = out.find((x) => x?.error);
    if (err) throw new Error(`store: ${err.error}`);
    return out.map((x) => x.result);
  }
  async get(key) { const v = await this.cmd('GET', key); return v == null ? null : JSON.parse(v); }
  async set(key, value, ttlSec) {
    await (ttlSec ? this.cmd('SET', key, JSON.stringify(value), 'EX', Math.ceil(ttlSec)) : this.cmd('SET', key, JSON.stringify(value)));
  }
  async del(key) { await this.cmd('DEL', key); }
  async incr(key, ttlSec) {
    const [n] = await this.pipeline(ttlSec ? [['INCR', key], ['EXPIRE', key, Math.ceil(ttlSec)]] : [['INCR', key]]);
    return Number(n);
  }
  async incrFloat(key, by, ttlSec) {
    const cmds = [['INCRBYFLOAT', key, Number(by)]];
    if (ttlSec) cmds.push(['EXPIRE', key, Math.ceil(ttlSec)]);
    const [n] = await this.pipeline(cmds);
    return Number(n);
  }
  async listPush(key, value, max) {
    const cmds = [['RPUSH', key, JSON.stringify(value)]];
    if (max) cmds.push(['LTRIM', key, -max, -1]);
    const [n] = await this.pipeline(cmds);
    return Math.min(Number(n), max || Infinity);
  }
  async listRange(key) {
    const v = await this.cmd('LRANGE', key, 0, -1);
    return (v || []).flatMap((s) => { try { return [JSON.parse(s)]; } catch { return []; } });
  }
}

// Pick a store from the environment. REST when its URL and token are both set (Vercel KV names first,
// then Upstash's). Otherwise a file under data/, except on Vercel, where the disk is not kept: there it
// falls back to memory and reports durable: false, and the hosted API refuses paid calls (fail closed).
export function restConfig(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}
export function createStore(env = process.env, { root = process.cwd(), fetch: fetcher = fetch, now } = {}) {
  const rest = restConfig(env);
  if (rest) return new RestStore({ ...rest, fetch: fetcher });
  if (env.VERCEL) return new MemoryStore({ now });
  return new FileStore({ file: path.resolve(root, env.ARENA_STORE_FILE || 'data/hosted-store.json'), now });
}
