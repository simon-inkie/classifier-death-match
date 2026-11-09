import { answerTimeoutMs } from '../public/answer-timeout.js';
// One decision call through Vercel AI Gateway, for the hosted API. Same request shapes, timeout and
// parsing as server.js (via adapters.js); the key is passed in, used for the Authorization header only,
// and never returned, logged or sent to the browser. Upstream error text stays on the server: the
// browser gets a generic message with the status code.
import { buildRequest, parseResponse } from '../adapters.js';

// billed: 'none' (an HTTP error, assumed not billed), 'unknown' (a timeout or network error, which may
// still have run upstream), or the reported USD cost of a response that could not be used.
function reportedCost(j) {
  const c = j?.providerMetadata?.gateway?.cost ?? j?.provider_metadata?.gateway?.cost ?? j?.usage?.cost;
  const n = Number(c);
  return c != null && Number.isFinite(n) && n >= 0 ? n : null;
}

export async function callGateway(fighter, scene, weapons, { key, gateway = 'https://ai-gateway.vercel.sh', timeoutMs = answerTimeoutMs(weapons), fetch: fetcher = fetch, log = () => {} }) {
  const { url, body } = buildRequest(fighter, scene, gateway, weapons);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = performance.now();
  let j = null;
  try {
    const r = await fetcher(url, { method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const txt = await r.text();
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) {
      log(`${fighter.id} upstream HTTP ${r.status}: ${txt.slice(0, 200)}`);
      return { ok: false, status: 502, error: `model call failed (HTTP ${r.status})`, ms, billed: 'none' };
    }
    j = JSON.parse(txt);
    return { ok: true, ms, parsed: parseResponse(fighter, j, scene) };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    if (e.name === 'AbortError') return { ok: false, status: 504, error: `timeout after ${timeoutMs}ms`, ms, billed: 'unknown' };
    log(`${fighter.id} call failed: ${String(e.message).slice(0, 200)}`);
    // a 200 we could not use was still billed: its reported cost if it had one, else unknown
    return { ok: false, status: 502, error: 'model answer unusable', ms, billed: reportedCost(j) ?? 'unknown' };
  } finally {
    clearTimeout(timer);
  }
}
