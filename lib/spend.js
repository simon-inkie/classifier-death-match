// Daily spend ceiling for the hosted API, kept in the durable store so it survives cold starts and is
// shared by every serverless instance. Costs are summed in USD, as reported by the gateway (the same
// unit the local CALL_BUDGET_USD guard uses); the ceiling is set in GBP and converted with a fixed,
// configurable rate (the same 1.30 assumption the autoplay runner uses), not an exchange-rate lookup.
import { promptVariant } from '../public/shared.js';

export const DEFAULT_CEILING_GBP = 3;
export const DEFAULT_USD_PER_GBP = 1.3;
export const CALLS_PER_FIGHTER = 600; // 10 calls/s for a 60 s match: the most one fighter can ask
export const CALL_CAP_PER_FIGHTER = 700; // hard per-match cap on calls per fighter (a little headroom)
const DAY_TTL_S = 3 * 86400;

function numEnv(env, name, dflt) {
  const raw = env[name];
  if (raw == null || raw === '') return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`invalid ${name}`);
  return n;
}

export function spendConfig(env = process.env) {
  const gbp = numEnv(env, 'DAILY_SPEND_CEILING_GBP', DEFAULT_CEILING_GBP);
  const usdPerGbp = numEnv(env, 'USD_PER_GBP', DEFAULT_USD_PER_GBP);
  return { gbp, usdPerGbp, usd: Math.round(gbp * usdPerGbp * 1e6) / 1e6 };
}

export const dayKey = (now = Date.now()) => `spend:usd:${new Date(now).toISOString().slice(0, 10)}`;
export async function spentToday(store, now = Date.now()) { return Number(await store.get(dayKey(now))) || 0; }
export async function addSpend(store, usd, now = Date.now()) {
  const n = Math.max(0, Number(usd) || 0);
  if (!n) return spentToday(store, now);
  return store.incrFloat(dayKey(now), n, DAY_TTL_S);
}

// A deliberately high per-call estimate, used to reserve a match's cost before it starts, and to
// charge a call whose real cost is unknown (no billed cost and no token usage, or a timeout that may
// still have been billed). Above the page's typical estimate on purpose.
export const CONSERVATIVE_TOKENS = { full: 1600, compact: 512, chatIn: 1600, chatOut: 60 };
export function conservativeCallUsd(fighter) {
  if (!fighter || fighter.kind === 'bot') return 0;
  const p = fighter.price || {};
  if (!Number.isFinite(p.in) || !Number.isFinite(p.out)) return Infinity; // unknown price: never cheap
  if (fighter.kind === 'chat' || fighter.transport === 'chat') return CONSERVATIVE_TOKENS.chatIn * p.in + CONSERVATIVE_TOKENS.chatOut * p.out;
  return CONSERVATIVE_TOKENS[promptVariant(fighter) === 'compact' ? 'compact' : 'full'] * p.in;
}
export const matchReserveUsd = (fighters) => fighters.reduce((s, f) => s + CALLS_PER_FIGHTER * conservativeCallUsd(f), 0);

// Can a new paid match start? It must fit whole: spent so far plus its reserved cost within the ceiling.
export function ceilingCheck({ spent, ceilingUsd, reserve = 0 }) {
  if (spent >= ceilingUsd) return { ok: false, reason: 'spent' };
  if (spent + reserve > ceilingUsd) return { ok: false, reason: 'would_exceed' };
  return { ok: true };
}

export const CEILING_MESSAGE = "Today's live-match budget has been used up. Live matches reopen tomorrow (UTC); Mock and Replay still work.";
