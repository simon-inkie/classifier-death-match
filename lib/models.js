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
export const BUILTIN_MODELS = ROSTER.filter((r) => r.kind !== 'bot' && !r.gatewaySlot)
  .map((r) => ({ id: r.model, name: r.name, price: { ...r.price } }));

const TOKEN_KEYS = ['input', 'output', 'input_cache_read', 'input_cache_write'];
// Opt-in extras the arena's chat request never asks for (no tools, no speed or service-tier option),
// so a listed price for them is ignored. Anything else that is not a per-token rate still refuses the model.
const IGNORED_KEYS = ['web_search', 'fast', 'maps_search', 'service_tiers', 'google_search'];
// Batch variants (id ending in -batch) are hidden from the list and refused if sent.
export const isBatchModel = (id) => typeof id === 'string' && /-batch$/i.test(id);
// One set of per-token prices: input and output present, every listed rate a finite non-negative number,
// nothing else in it but the ignored opt-in extras.
function validTokenSet(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s) || s.input == null || s.output == null) return false;
  return Object.keys(s).every((k) => (TOKEN_KEYS.includes(k) ? Number.isFinite(Number(s[k])) && Number(s[k]) >= 0 : IGNORED_KEYS.includes(k)));
}
// regional: { us: {input, output, ...}, eu: {...} }. Anything not shaped like that yields an invalid set,
// so the model is refused rather than under-priced.
function regionalSets(regional) {
  if (regional == null) return [];
  if (typeof regional !== 'object' || Array.isArray(regional)) return [null];
  const sets = Object.values(regional);
  return sets.length ? sets : [null];
}

// The gateway's model list (/v1/models): language models only, prices per token as strings. A model
// with no usable price is kept with price null and refused when picked.
export function parseCatalogue(j) {
  const rows = Array.isArray(j?.data) ? j.data : [];
  const out = [];
  for (const m of rows) {
    if (!validModelId(m?.id) || isBatchModel(m.id) || (m.type && m.type !== 'language')) continue;
    // only per-token input/output pricing (plus prompt-cache rates) can be bounded; any other charge
    // (per request, images, input tiers, ...) means the model is refused. Listed opt-in extras the
    // arena's chat request never asks for are ignored (see IGNORED_KEYS). Regional rates are per-token prices too: the bound takes the highest.
    const pr = m.pricing && typeof m.pricing === 'object' ? m.pricing : null;
    const top = pr ? Object.fromEntries(Object.entries(pr).filter(([k]) => k !== 'regional')) : null;
    const sets = pr ? [top, ...regionalSets(pr.regional)] : [];
    const price = pr && sets.every(validTokenSet) ? {
      in: Math.max(...sets.map((s) => Math.max(Number(s.input), Number(s.input_cache_write ?? 0)))),
      out: Math.max(...sets.map((s) => Number(s.output))),
    } : null;
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

// The models a slot could be given: on the list, priced, and under the per-call cap at their bound. The
// page's Add list shows only these, so it never offers a model the server would refuse.
export function pickableModels(models, maxCallUsd = DEFAULT_MAX_USD_PER_CALL) {
  return models.filter((m) => m.price && resolveFighter('gemini', m.id, { enabled: true, models, maxCallUsd }).ok)
    .map(({ id, name, price }) => ({ id, name, price }));
}

// The fighter a slot runs. Original slots with no override keep their roster entry. Generic gateway
// slots always need the picker enabled and an explicit model. Overrides need a valid id, a model
// on the list, a known price and a per-call worst case
// under the cap. A picked model that is another roster model keeps that model's API and prompt; any other
// picked model is asked through chat completions, like the Gemini baseline.
export function resolveFighter(slotId, model, { enabled = false, models = BUILTIN_MODELS, maxCallUsd = DEFAULT_MAX_USD_PER_CALL } = {}) {
  const base = typeof slotId === 'string' && Object.hasOwn(rosterById, slotId) ? rosterById[slotId] : null;
  if (!base || base.kind === 'bot') return { ok: false, status: 400, error: 'unknown fighter' };
  if (base.gatewaySlot) {
    if (!enabled) return { ok: false, status: 403, error: 'model picker is disabled on this server' };
    if (model == null || model === '') return { ok: false, status: 400, error: 'gateway slot requires a picked model' };
  }
  if (!base.gatewaySlot && (model == null || model === '' || model === base.model)) return { ok: true, fighter: base, picked: false };
  if (!validModelId(model)) return { ok: false, status: 400, error: 'invalid model id' };
  if (isBatchModel(model)) return { ok: false, status: 400, error: 'batch models are not available' };
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
