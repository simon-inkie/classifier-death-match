// Model picker: lets a player run any Vercel AI Gateway model in a fighter slot. Behind a flag,
// ENABLE_MODEL_PICKER, off by default and enforced here on the server: with it off, a slot only ever
// runs its own roster model, whatever the browser sends.
import { ROSTER, rosterById } from '../public/shared.js';
import { callBound } from './spend.js';

export const pickerEnabled = (env = process.env) => /^(1|true|yes|on)$/i.test(String(env.ENABLE_MODEL_PICKER || '').trim());

// provider/model, letters, digits, dot, dash, underscore. No scheme, no extra slashes, no spaces, so it
// can never become a URL or a path. It only ever travels inside a JSON request body to the gateway.
export const MODEL_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9._-]{0,99}$/i;
export const validModelId = (id) => typeof id === 'string' && MODEL_ID_RE.test(id) && !id.includes('..');

export const DEFAULT_MAX_USD_PER_CALL = 0.01;
export function maxUsdPerCall(env = process.env) {
  const raw = env.MODEL_PICKER_MAX_USD_PER_CALL;
  const n = raw == null || raw === '' ? DEFAULT_MAX_USD_PER_CALL : Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error('invalid MODEL_PICKER_MAX_USD_PER_CALL');
  return n;
}

// The built-in list: the roster's own models with their prices. Used with no gateway key (mock mode),
// or when the gateway model list cannot be fetched.
export const BUILTIN_MODELS = ROSTER.filter((r) => r.kind !== 'bot')
  .map((r) => ({ id: r.model, name: r.name, price: { ...r.price } }));

// The gateway's model list (/v1/models): language models only, prices per token as strings. A model
// with no usable price is kept with price null and refused when picked.
export function parseCatalogue(j) {
  const rows = Array.isArray(j?.data) ? j.data : [];
  const out = [];
  for (const m of rows) {
    if (!validModelId(m?.id) || (m.type && m.type !== 'language')) continue;
    // only per-token input/output pricing (plus prompt-cache rates) can be bounded; any other charge
    // (per request, web search, images, ...) means the model is refused
    const pr = m.pricing && typeof m.pricing === 'object' ? m.pricing : null;
    const extra = pr ? Object.keys(pr).filter((k) => !['input', 'output', 'input_cache_read', 'input_cache_write'].includes(k)) : [];
    const nums = pr ? ['input', 'output', 'input_cache_read', 'input_cache_write'].filter((k) => pr[k] != null).map((k) => Number(pr[k])) : [];
    const pin = Math.max(Number(pr?.input), Number(pr?.input_cache_write ?? 0)), pout = Number(pr?.output);
    const price = pr && pr.input != null && pr.output != null && !extra.length && nums.every((n) => Number.isFinite(n) && n >= 0)
      ? { in: pin, out: pout } : null;
    out.push({ id: m.id, name: String(m.name || m.id).slice(0, 80), price });
  }
  return out;
}

// Fetched server side and cached per process (per serverless instance) for MODEL_LIST_TTL_S.
// The list is public, so no key is sent with it.
export function createCatalogue({ env = process.env, fetch: fetcher = fetch, now = () => Date.now() } = {}) {
  let cache = null;
  const ttlS = env.MODEL_LIST_TTL_S == null || env.MODEL_LIST_TTL_S === '' ? 3600 : Number(env.MODEL_LIST_TTL_S);
  if (!Number.isFinite(ttlS) || ttlS < 0) throw new Error('invalid MODEL_LIST_TTL_S');
  const ttl = ttlS * 1000;
  const gateway = env.AI_GATEWAY_BASE || 'https://ai-gateway.vercel.sh';
  return async function catalogue() {
    if (!env.AI_GATEWAY_API_KEY) return { source: 'builtin', models: BUILTIN_MODELS };
    if (cache && now() - cache.at < cache.ttl) return cache.value;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 5000);
    try {
      const r = await fetcher(`${gateway}/v1/models`, { signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const models = parseCatalogue(await r.json());
      if (!models.length) throw new Error('empty model list');
      cache = { at: now(), ttl, value: { source: 'gateway', models } };
    } catch {
      cache = { at: now(), ttl: 60e3, value: { source: 'builtin', models: BUILTIN_MODELS } }; // retry in a minute
    } finally { clearTimeout(timer); }
    return cache.value;
  };
}

// The fighter a slot runs. No model, or the slot's own model: the roster entry, unchanged. Anything
// else needs the flag on, a valid id, a model on the list, a known price and a per-call worst case
// under the cap. A picked model that is another roster model keeps that model's API and prompt; any other
// picked model is asked through chat completions, like the Gemini baseline.
export function resolveFighter(slotId, model, { enabled = false, models = BUILTIN_MODELS, maxCallUsd = DEFAULT_MAX_USD_PER_CALL } = {}) {
  const base = typeof slotId === 'string' && Object.hasOwn(rosterById, slotId) ? rosterById[slotId] : null;
  if (!base || base.kind === 'bot') return { ok: false, status: 400, error: 'unknown fighter' };
  if (model == null || model === '' || model === base.model) return { ok: true, fighter: base, picked: false };
  if (!validModelId(model)) return { ok: false, status: 400, error: 'invalid model id' };
  if (!enabled) return { ok: false, status: 403, error: 'model picker is disabled on this server: each fighter runs its own model' };
  const slot = { id: base.id, name: base.name, colour: base.colour, mock: base.mock };
  const same = ROSTER.find((r) => r.model === model && r.kind !== 'bot');
  let fighter;
  if (same) fighter = { ...same, ...slot };
  else {
    const m = models.find((x) => x.id === model);
    if (!m) return { ok: false, status: 400, error: 'unknown model (not on the gateway model list)' };
    if (!m.price) return { ok: false, status: 400, error: 'model has no listed per-token price (or has other charges), so it is refused' };
    fighter = { ...slot, model, kind: 'chat', transport: 'chat', price: { ...m.price } };
  }
  const est = callBound(fighter, !same);
  if (!(est <= maxCallUsd)) return { ok: false, status: 400, error: `model too expensive for this arena (about $${est.toFixed(4)} a call, cap $${maxCallUsd})` };
  return { ok: true, fighter, picked: true };
}
