// One decision call through Vercel AI Gateway, for the hosted API. Same request shapes, timeout and
// parsing as server.js (via adapters.js); the key is passed in, used for the Authorization header only,
// and never returned, logged or sent to the browser.
import { buildRequest, parseResponse } from '../adapters.js';

export async function callGateway(fighter, scene, weapons, { key, gateway = 'https://ai-gateway.vercel.sh', timeoutMs = 2000, fetch: fetcher = fetch }) {
  const { url, body } = buildRequest(fighter, scene, gateway, weapons);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const r = await fetcher(url, { method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const txt = await r.text();
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) {
      let msg = txt.slice(0, 300);
      try { const e = JSON.parse(txt); msg = e.error?.message || e.message || msg; if (e.error?.type || e.error_type) msg = `${e.error?.type || e.error_type}: ${msg}`; } catch {}
      return { ok: false, status: 502, error: `HTTP ${r.status}: ${msg}`, ms, billedMaybe: false };
    }
    return { ok: true, ms, parsed: parseResponse(fighter, JSON.parse(txt), scene) };
  } catch (e) {
    const ms = Math.round(performance.now() - t0);
    const timeout = e.name === 'AbortError';
    // a timed-out request may still have run (and been billed) upstream
    return { ok: false, status: 504, error: timeout ? `timeout after ${timeoutMs}ms` : e.message, ms, billedMaybe: true };
  } finally {
    clearTimeout(timer);
  }
}
