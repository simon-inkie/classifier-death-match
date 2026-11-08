# feat/vercel-and-model-picker

## TL;DR
Same repo deploys to Vercel as a hosted site (serverless `api/`, static `public/`), with a durable daily
spend ceiling, per-IP match rate limit, durable leaderboard via a pluggable store. Plus a model picker
behind `ENABLE_MODEL_PICKER`, off by default, enforced server-side. Local `node server.js` unchanged
when the flag is off.

## Scope
1. Hosted: `lib/storage.js` (memory/file/REST), `lib/spend.js`, `lib/hosted.js` router, `api/*.js` thin
   entries, `vercel.json`, splash + footer link, ceiling message in UI.
2. Model picker: `lib/models.js` (flag, id validation, catalogue fetch + cache, built-in fallback,
   pricing), `/api/models`, per-slot override validated in `/api/decide` and `/api/match/start`.

## Test plan
- spend ceiling refuses match start and decide once reached; reservation refuses a match that would cross it
- storage fallback: REST when env present, file otherwise; fail closed on Vercel with no durable store
- flag enforcement: non-allowlisted model rejected with flag off (both servers); bad ids rejected with flag on;
  unknown-price models refused

## Amendments
(appended as work happens)

### 2026-11-04 build
- Hosted API is one router (`lib/hosted.js`) with thin `api/*.js` entries chosen by file, not URL, so
  rewrites cannot misroute. `api/leaderboard/index.js` avoids a file and directory with one name.
- Match token = random UUID stored in KV with 15 min TTL, plus a per-match cap of 700 calls per fighter.
  The model per slot is fixed at start; `/api/decide` ignores body model except to reject a mismatch.
- Ceiling: reserve the whole match up front (600 calls x high per-call estimate) so a match never starts
  that the ceiling cannot cover; refuse further calls once spent; unknown cost and timeouts charged at the
  high estimate. In-flight concurrent calls can overshoot by a few calls.
- Fail closed: on Vercel with no KV env, store is memory with durable=false and paid routes return 503.
- Picker off: only the slot's own roster model (not even another roster model). Picker on: id regex,
  on gateway list, listed price, per-call estimate under MODEL_PICKER_MAX_USD_PER_CALL (0.01).
  Non-roster models use chat transport. Picked matches never recorded on the leaderboard.
- Hosted leaderboard: record needs X-Match-Token of a live match, once; mock not recorded; reset needs
  ARENA_ADMIN_TOKEN. Logs POST not stored; Replay lists bundled examples.
- Local server.js: unchanged when no `model` field is sent; new `/api/models`, `/api/match/start`
  (no token, checks models and CALL_BUDGET_USD), `modelPicker` in status.
- KV cost: about 5 commands per decision (get match, get spend, incr calls, incrbyfloat + expire).
  A 4-fighter match is ~2,400 decisions, so ~12k commands; check the Upstash plan.

## Test plan (done)
test/hosted.test.js, 13 tests; full suite 65/65.

## Follow-ups
- Verify on a real Vercel preview: function routing, `includeFiles` for examples/, x-real-ip, KV wiring.
- Consider a per-IP limit on /api/decide (currently bounded per match token only).

### 2026-11-04 review fixes (research/2026-11-04-arena-vercel-review.md)
- C1/M1: spend model rebuilt. Prompt capped (strict scene schema, 5,000-char prompt cap, body caps also on
  pre-parsed bodies), so worstCallUsd is a real bound. Match reserves 600 x worst per fighter against the
  day atomically (INCRBYFLOAT, compare, refund). Each call reserves worst against the match first.
  Timeouts/no-cost keep worst. Unused budget released on /api/match/end, record, or a sweep after the 4 min
  play window. `used` counter separates "spent" from "busy". One call in flight per fighter, 90 ms gap.
- C2: game.js escapes every leaderboard field; cleanRecord strips markup; CSP header in vercel.json.
- M2: hosted records rebuilt server side: decisions checked as a subsequence of the server's answers per
  fighter (>= 20 answers each), re-simulated, record built from the result. One per token, 20/network/day.
  Bot and picked matches not recorded hosted. Residual: client still chooses apply ticks and dropped answers.
- M3: networks keyed by IPv4 or IPv6 /64; GLOBAL_MATCH_RATE_LIMIT site-wide.
- M4: HMAC-signed tokens checked before KV; per-instance in-memory throttles on every route before KV;
  leaderboard GET reads the last 500, s-maxage=30.
- Minors fixed: Object.hasOwn lookups, digest compare for admin token, generic upstream errors, derived salt,
  MODEL_LIST_TTL_S validation.
- Tests: 70/70.

### 2026-11-04 re-review fixes (research/2026-11-04-arena-vercel-rereview.md)
- 1: excess above bound charged to match spent and day at once (match `excess` key; release keeps exactly
  what was spent). Every call re-reads the day total and refuses once it is over the ceiling. Picked
  non-roster models bound at 3x worst case; catalogue refuses pricing with non per-token charges.
- 2: decide re-reads `closed` after reserving (closeMatch sets it before reading spent): refuse + rollback.
  Residual: the close keeps the rolled-back call's bound (over-count by one call, safe direction).
- 3: one open match per network (open:net key), line-up cap MAX_MATCH_SHARE (0.25), tranches of 100
  calls/fighter topped up on demand (concurrent extra tranche handed back), idle release after 20 s, play
  window 150 s. Record + open entry written before money is reserved.
- 4: per-network check first; site-wide counter read, raised only on success.
- 5: verify uses server-observed {ok, a, ms, c, to} per call; stuns <= failures + drops; drops <= 2 + 5%.
  Best-per-fighter board not done (needs a server aggregate store); documented flood residual.
- 6: documented (gateway spend limit, Vercel WAF rule, KV budget cap, ARENA_TOKEN_SECRET). Also: tokens
  carry an expiry, status cached 5 s, leaderboard with a query string is 404, beacon text/plain fallback.
- Tests 75/75.

## Amendment 2026-11-04 (final review round)
- N1/N4: hand-back re-checks closed after lowering reserve, refunds once behind a guard key; N4 residual (one tranche, safe side) documented.
- N3/N7: GLOBAL_MATCH_RATE_LIMIT replaced by MAX_OPEN_MATCHES (open-list push length, atomic), placeholder entries hold a slot MIN_LIFE_S.
- N2: start limits on IPv6 /48; rest documented as residual. N5: last-attempt timestamp. N6: excess covered by reserve, signed settlement. N8: tick order.
- Commits b7ff96b, 30595c3, c70fb88, 0bd27c9; 80/80 tests.
