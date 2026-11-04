// Spend accounting for the hosted API. Costs are in USD, as the gateway reports them (the unit the local
// CALL_BUDGET_USD guard uses). The daily ceiling is set in GBP and converted at a fixed, configurable
// rate (the same 1.30 assumption as the autoplay runner), not an exchange-rate lookup.
//
// The ceiling holds by construction rather than by checking:
//  - every call's prompt is capped at PROMPT_CHAR_CAP characters of ASCII (lib/scene.js), so its input
//    tokens cannot exceed WORST_TOKENS.in, and chat output is capped by max_tokens; worstCallUsd() is an
//    upper bound on what one call can cost;
//  - a match reserves its whole budget against the day before it starts (CALLS_PER_FIGHTER x worst case
//    per fighter), atomically, and is refused if that would cross the ceiling;
//  - each call reserves its worst case against its match before it runs, and is refused if the match
//    budget is gone; afterwards the reservation is lowered to the reported cost (never on a timeout);
//  - when a match ends, or its play window expires, the unused part of its budget goes back to the day.

export const DEFAULT_CEILING_GBP = 3;
export const DEFAULT_USD_PER_GBP = 1.3;
export const CALLS_PER_FIGHTER = 600; // 10 calls/s for a 60 s match: the most one fighter normally asks
export const PROMPT_CHAR_CAP = 5000; // the worst real prompt is ~3,900 characters (scripts/worst-case.js)
export const WORST_TOKENS = { in: PROMPT_CHAR_CAP + 200, out: 60 }; // + message framing; out = chat max_tokens
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

export const dayOf = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
// spend: committed today (budgets held by open matches + spend of closed ones + any excess). used: the
// spend of closed matches + excess only, which tells "budget gone" apart from "budget held, try later".
const keyFor = (prefix, d) => `${prefix}:usd:${d}`;
export const dayKey = (now = Date.now()) => keyFor('spend', dayOf(now));
export const usedKey = (now = Date.now()) => keyFor('used', dayOf(now));

// The most one call can cost: the capped prompt at the input price, plus max_tokens of output for chat.
export function worstCallUsd(fighter) {
  if (!fighter || fighter.kind === 'bot') return 0;
  const p = fighter.price || {};
  if (!Number.isFinite(p.in) || !Number.isFinite(p.out)) return Infinity; // unknown price: never cheap
  const chat = fighter.kind === 'chat' || fighter.transport === 'chat';
  return WORST_TOKENS.in * p.in + (chat ? WORST_TOKENS.out * p.out : 0);
}
// The local proxy's picked-model fallback uses the same bound.
export const conservativeCallUsd = worstCallUsd;
export const matchReserveUsd = (fighters) => fighters.reduce((s, f) => s + CALLS_PER_FIGHTER * worstCallUsd(f), 0);

// Atomically reserve a match budget against the day: INCRBYFLOAT first, then compare, and give it back
// if it crossed the ceiling, so concurrent starts can never all "fit".
export async function reserveMatch(store, reserve, ceilingUsd, now = Date.now()) {
  if (!Number.isFinite(reserve) || reserve <= 0) return { ok: false, reason: 'spent' };
  const committed = await store.incrFloat(dayKey(now), reserve, DAY_TTL_S);
  if (committed > ceilingUsd + 1e-9) {
    await store.incrFloat(dayKey(now), -reserve, DAY_TTL_S);
    const used = Number(await store.get(usedKey(now))) || 0;
    return { ok: false, reason: used + reserve > ceilingUsd ? 'spent' : 'busy' };
  }
  return { ok: true, day: dayOf(now) };
}

// Give back what a match did not use. spent: what its calls took from its budget (at most the reserve).
export async function releaseMatch(store, { reserve, day, spent }) {
  const used = Math.min(reserve, Math.max(0, Number(spent) || 0)), refund = reserve - used;
  await Promise.all([
    refund ? store.incrFloat(keyFor('spend', day), -refund, DAY_TTL_S) : null,
    used ? store.incrFloat(keyFor('used', day), used, DAY_TTL_S) : null,
  ]);
  return refund;
}

// Spend above a call's reserved worst case (only if the gateway reports more than the bound) is added
// straight to the day as well, so the counter never runs below what was reported.
export async function addExcess(store, usd, day) {
  if (usd > 0) await Promise.all([store.incrFloat(keyFor('spend', day), usd, DAY_TTL_S), store.incrFloat(keyFor('used', day), usd, DAY_TTL_S)]);
}

export async function dayStatus(store, ceilingUsd, cheapestMatch, now = Date.now()) {
  const [committed, spent] = await Promise.all([store.get(dayKey(now)), store.get(usedKey(now))]);
  const c = Number(committed) || 0, used = Number(spent) || 0;
  return { exhausted: used + cheapestMatch > ceilingUsd, busy: c + cheapestMatch > ceilingUsd, committed: c };
}

export const CEILING_MESSAGE = "Today's live-match budget has been used up. Live matches reopen tomorrow (UTC); Mock and Replay still work.";
export const BUSY_MESSAGE = "The arena is busy: other live matches are holding the rest of today's budget. Try again in a few minutes, or play Mock.";
