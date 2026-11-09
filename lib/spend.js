// Spend accounting for the hosted API. Costs are in USD, as the gateway reports them (the unit the local
// CALL_BUDGET_USD guard uses). The daily ceiling is set in GBP and converted at a fixed, configurable
// rate (the same 1.30 assumption as the autoplay runner), not an exchange-rate lookup.
//
// The ceiling holds by construction rather than by checking:
//  - every call's prompt is capped at PROMPT_CHAR_CAP characters of ASCII (lib/scene.js), so its input
//    tokens cannot exceed WORST_TOKENS.in, and chat output is capped by max_tokens; worstCallUsd() is an
//    upper bound on what one call can cost;
//  - a match reserves its budget against the day in tranches (TRANCHE_CALLS worst-case calls per fighter,
//    up to CALLS_PER_FIGHTER), each one atomically, refused if it would cross the ceiling;
//  - each call reserves its worst case against its match before it runs, and is refused if the match
//    budget is gone and no tranche can be added; afterwards the reservation is lowered to the reported
//    cost (never on a timeout); a reported cost above the bound is charged to the match and to the day
//    at once, and once the day total is over the ceiling every further call is refused;
//  - when a match ends, idles, or its play window expires, the unused part of its budget goes back.

export const DEFAULT_CEILING_GBP = 3;
export const DEFAULT_USD_PER_GBP = 1.3;
export const CALLS_PER_FIGHTER = 600; // 10 calls/s for a 60 s match: the most one fighter normally asks
export const TRANCHE_CALLS = 100; // reserved at a time, topped up as the match uses it
export const PICKER_SAFETY = 3; // a picked (non-roster) model's bound is multiplied by this: its price is the gateway's word
export const PROMPT_CHAR_CAP = 5000; // the worst real prompt is ~3,900 characters (scripts/worst-case.js)
export const WORST_TOKENS = { in: PROMPT_CHAR_CAP + 200, out: 60 }; // + message framing; out = roster chat max_tokens
// A picked (non-roster) chat model gets room for hidden reasoning tokens; the same figure is the request's
// max_tokens (fighter.maxTokens) and its output term in the bound, so the cap and reservations follow it.
export const PICKED_MAX_TOKENS = 400;
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
// spend of closed matches only, which tells "budget gone" apart from "budget held, try later".
const keyFor = (prefix, d) => `${prefix}:usd:${d}`;
export const dayKey = (now = Date.now()) => keyFor('spend', dayOf(now));
export const usedKey = (now = Date.now()) => keyFor('used', dayOf(now));

// The most one call can cost: the capped prompt at the input price, plus max_tokens of output for chat.
export function worstCallUsd(fighter) {
  if (!fighter || fighter.kind === 'bot') return 0;
  const p = fighter.price || {};
  if (!Number.isFinite(p.in) || !Number.isFinite(p.out)) return Infinity; // unknown price: never cheap
  const chat = fighter.kind === 'chat' || fighter.transport === 'chat';
  return WORST_TOKENS.in * p.in + (chat ? (fighter.maxTokens ?? WORST_TOKENS.out) * p.out : 0);
}
// The local proxy's picked-model fallback uses the same bound.
export const conservativeCallUsd = worstCallUsd;
// The bound the hosted API charges a call at: the worst case, times PICKER_SAFETY for a picked model.
export const callBound = (fighter, picked = false) => worstCallUsd(fighter) * (picked ? PICKER_SAFETY : 1);
export const matchReserveUsd = (fighters) => fighters.reduce((s, f) => s + CALLS_PER_FIGHTER * (f.bound ?? worstCallUsd(f)), 0);
export const trancheUsd = (fullReserve) => fullReserve * TRANCHE_CALLS / CALLS_PER_FIGHTER;

// Atomically reserve a match budget against the day: INCRBYFLOAT first, then compare, and give it back
// if it crossed the ceiling, so concurrent starts can never all "fit".
// ownUsd: what the calling match already holds, so the only match on the day is told the day is spent,
// not that other matches are holding it.
export async function reserveMatch(store, reserve, ceilingUsd, now = Date.now(), ownUsd = 0) {
  if (!Number.isFinite(reserve) || reserve <= 0) return { ok: false, reason: 'spent' };
  const committed = await store.incrFloat(dayKey(now), reserve, DAY_TTL_S);
  if (committed > ceilingUsd + 1e-9) {
    await store.incrFloat(dayKey(now), -reserve, DAY_TTL_S);
    const used = Number(await store.get(usedKey(now))) || 0;
    return { ok: false, reason: used + (Number(ownUsd) || 0) + reserve > ceilingUsd + 1e-9 ? 'spent' : 'busy' };
  }
  return { ok: true, day: dayOf(now) };
}

// Settle a closed match. reserve: what it reserved from the day; excess: what was added to the day above
// call bounds; spent: everything its calls cost (excess included). The day keeps exactly what was spent:
// the difference is refunded, or added if the match spent more than the day was holding for it.
export async function releaseMatch(store, { reserve, excess = 0, spent, day }) {
  const r = Math.max(0, Number(reserve) || 0), x = Math.max(0, Number(excess) || 0), s = Math.max(0, Number(spent) || 0);
  const refund = r + x - s;
  await Promise.all([
    Math.abs(refund) > 1e-12 ? store.incrFloat(keyFor('spend', day), -refund, DAY_TTL_S) : null,
    s ? store.incrFloat(keyFor('used', day), s, DAY_TTL_S) : null,
  ]);
  return refund;
}

// Spend above a call's bound (the gateway billed more than the price table says) goes straight onto the
// day, so the day total never runs below what was reported.
export async function addExcess(store, usd, day) {
  if (usd > 0) await store.incrFloat(keyFor('spend', day), usd, DAY_TTL_S);
}
export const daySpendKey = (day) => keyFor('spend', day);

export async function dayStatus(store, ceilingUsd, cheapestMatch, now = Date.now()) {
  const [committed, spent] = await Promise.all([store.get(dayKey(now)), store.get(usedKey(now))]);
  const c = Number(committed) || 0, used = Number(spent) || 0;
  return { exhausted: used + cheapestMatch > ceilingUsd, busy: c + cheapestMatch > ceilingUsd, committed: c };
}

export const CEILING_MESSAGE = "Today's live-match budget has been used up. Live matches reopen tomorrow (UTC); Mock and Replay still work.";
export const BUSY_MESSAGE = "The arena is busy: other live matches are holding the rest of today's budget. Try again in a few minutes, or play Mock.";
