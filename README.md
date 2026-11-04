# Classifier Death Match

Classifier Death Match is a small browser game where AI models fight each other. Four typed-decision classifiers (Jev, Luna, Laya and ScaleDown), plus an optional chat-model baseline (Gemini Flash) and an optional scripted bot, each steer a fighter in a top-down arena shooter. Every turn a model gets a bucketed description of the scene and picks one of eight intentions (advance, retreat, spin left or right, shoot, take cover, grab a pickup, hold). The game does the geometry. The simulation is deterministic, so every match can be replayed bit for bit from its log.

Matches take place in the **Inkie Arena**, a round arena with pillars for cover and the Inkie logo at its centre. Each round lasts 60 seconds: from 30 s the ring closes in toward the centre and hurts anyone left outside it, and when one fighter is left, or time runs out, the highest HP wins. Fighters start evenly spaced round the edge. Nothing spawns in the centre; the rifle, the strongest pickup, sits at symmetric off-centre spots, one per fighter, so no starting position is favoured.

It was built for a live talk on typed-decision models, as a fun way to show what a classifier that returns a probability per option feels like next to a chat model asked for JSON, and how much latency matters when the world keeps moving.

![Classifier Death Match in the Inkie Arena, logos style](screenshots/arena-logos.png)

No dependencies. Node 20 or later.

## Quick start (mock mode, no key)

```bash
git clone https://github.com/simon-inkie/classifier-death-match.git
cd classifier-death-match
npm start
# open http://127.0.0.1:8787/?mode=mock and press Space
```

The server listens on `127.0.0.1` only. Mock mode needs no network and costs nothing: each fighter is a noisy softmax over a simple heuristic with a fake latency profile. It is also the Wi-Fi fallback for a live demo. Replay mode works without a key too, and three example matches are bundled in `examples/`.

## Live mode (real models)

Live mode calls the models through [Vercel AI Gateway](https://vercel.com/ai-gateway) using your own key and your own credits.

```bash
export AI_GATEWAY_API_KEY=...        # from your Vercel AI Gateway dashboard
npm start                            # or: npm run live
```

`npm run live` does the same, and can also read the key from a [pass](https://www.passwordstore.org/) entry if you set `ARENA_PASS_ENTRY=<entry>`. The key stays in the local proxy process (`server.js`). It is never sent to the browser, printed or written to disk. In the page, pick **Live**, press **Warm up** (three throwaway calls per model to get TLS and cold starts out of the way) and then **Start**.

A match makes up to 10 calls per second per fighter for up to 60 seconds. The proxy has a hard call budget per process (`CALL_BUDGET`, default 3000) shown as `CALLS used/max` in the header; once it is spent, fighters are stunned and stop asking. There are no retries. Per-call costs are shown on each panel, using the gateway's reported cost where it returns one.

`node scripts/smoke.js 2 jev laya` makes two live calls per named fighter through a running proxy (`ARENA_URL` overrides the address). Add `--worst` to send the worst-case scene (six fighters, every weapon on, incoming fire), which is how the prompt sizes below were checked.

Other environment variables: `PORT` (8787), `CALL_TIMEOUT_MS` (2000), `AI_GATEWAY_BASE`, `LEADERBOARD_FILE` (`data/leaderboard.json`).

## Unattended live matches (AUTO-PLAY)

`scripts/autoplay.js` plays live matches without a browser, against a running proxy:

```bash
npm run autoplay -- --matches 50 --fighters jev,luna,laya,scaledown
```

This runs four concurrent matches against `http://127.0.0.1:8787`, with the same 30 Hz simulation, asynchronous per-fighter live calls (at most 10 Hz), 2 s timeout/stun, prompts, tick-keyed actions and leaderboard record builder as the page. Network latency is real: it never advances a live match in virtual time. Completed logs are replay-verified before recording to the all-time leaderboard. Logs and a printed Markdown summary are saved under `logs/autoplay-*`; the Replay picker can load the JSON logs. Each log also keeps every request's cost, including answers arriving after death or the final tick.

The default budget is **£5**, assuming **£1 = $1.30**, hence **$6.50**. This is a configurable assumption, not an exchange-rate lookup. The runner reads `/api/status` and compares total proxy process spend (including spend before this batch) with the smaller of the CLI limit and the server's cap. It reserves the forecast remaining cost of all in-flight matches plus the next match before launching. Forecasts use mean costs from existing local live logs for the same roster (excluding budget-stopped logs), then completed batch matches; without history the bootstrap assumes 600 calls per fighter at the page's estimated per-call price. Costs fall back to the page's token estimate when usage is absent. It prints spend, completed matches and wins as it runs.

For a fresh 50-match batch, configure the proxy separately with a generous **call** allowance and a **USD** cap. The old default of 3,000 calls is too low for 50 matches:

```bash
CALL_BUDGET=200000 CALL_BUDGET_USD=6.50 npm run live
```

`CALL_BUDGET_USD` defaults to unlimited. `/api/status` exposes `costBudget: {used, max}` in USD (`max: null` means unlimited). The proxy sums the billed or token-priced cost it receives, and refuses new calls with HTTP 429 once spent. Already admitted concurrent calls can finish above the cap; unknown costs and timeouts can also undercount billing. This is a spend guard based on reported costs, not a prepaid gateway limit. Both server budgets reset when its process restarts. The runner never restarts the server and sends no warm-up calls.

```bash
npm run autoplay -- --matches 50 --parallel 4 --fighters jev,luna,laya,scaledown,gemini --aim on --seed-start 100 --budget-gbp 5 --usd-per-gbp 1.30 --server http://127.0.0.1:8787 --label "aim comparison" --weapons default
npm run autoplay -- --matches 16 --config ./my-weapons.json
```

All options take a value: `--matches` (50), `--parallel` (4), `--fighters` (four classifiers, Gemini optional), `--aim on|off` (off), `--seed-start` (time-based), `--budget-gbp` (5), `--usd-per-gbp` (1.30), `--server` (8787), `--label` (empty), `--weapons default`, and `--config` (optional JSON weapon config). Config fragments inherit current defaults, including pickup density 0.75 and respawn rate 1; `--aim` sets the aiming mode. Seeds increment for every launched match; labels are retained in logs and leaderboard notes.

Roster order rotates, with an extra phase change every roster-length matches to account for the sim's existing seed-based spawn offset. Both roster positions and physical spawn slots balance exactly over `fighters²` matches (16 for four fighters, 25 for five). A 50-match four-fighter run is nearly balanced. The exact roster and physical slots are logged; the summary shows wins per physical slot, per-fighter wins/rate/place/kills/damage/latency/cost, and target-choice counts when aiming is on.

Model errors keep fighters stunned while other fighters continue. Three consecutive errors produce a warning; more than 50% failed requests for any fighter over the last ten finished matches stops new launches. Ctrl-C stops launching and lets in-flight matches finish and save. If either budget runs out mid-match, affected logs are explicitly marked `aborted` and excluded from the leaderboard. Failed leaderboard POSTs are reported and retained in the log; POSTs are serialised and are not automatically retried (avoiding duplicate records). Logs are written locally to this checkout, so use the same checkout as the proxy for its Replay list.

Tests use fake clocks and a proxy on **8795** with a local fake gateway and dummy key. They make no real gateway calls; no live batch is run by the tests.

## The fighters

| Fighter | Model | API | Prompt |
|---|---|---|---|
| Jev | `typesafe-ai/jev` | `POST /typesafe/v1/systemone`, one `choice` question | full |
| Luna | `openai/gpt-6-luna-decisions` | `POST /v1/evaluate`, one `choice` question | full |
| Laya | `convaiinnovations/laya` | `POST /v1/evaluate`, one `choice` question | **compact** |
| ScaleDown | `scaledown/scaledown-classify-1` | `POST /typesafe/v1/systemone`, state sent as `{text}`, provider pinned to `scaledown` | full |
| Gemini Flash (opt-in) | `google/gemini-2.5-flash-lite` | `POST /v1/chat/completions` with a `json_schema` response: `{action, confidence}` | full |
| Bot (opt-in) | scripted if/else | runs locally, a control | none |

Every model is asked exactly one question: which action to take. The typed-decision models return a probability for each of the eight options, shown as bars on their panel. Gemini returns a self-reported confidence for its pick, which is not a distribution. The bot is one-hot.

Model ids, prices and mock latency profiles live in `ROSTER` in `public/shared.js`. Prices are estimates taken from the gateway's public model list.

### Laya's compact prompt

Jev, Luna, ScaleDown and Gemini all receive byte-identical text: a rules preamble generated from the match's weapon config, then the scene as JSON. Laya receives a compact variant of the same facts. Through `/v1/evaluate` she rejects any single question whose total input (state text plus instructions plus option criteria) is over 512 tokens, with HTTP 422. The full text is about 950 tokens in the worst case, so it cannot fit.

Her variant keeps the same information (her own HP, weapon, ammo, range and readiness, last shot, every enemy's bearing, distance, line of sight and HP, incoming fire, blocked directions, the two nearest pickups, the ring and the time left, and a one-line note per enabled weapon) in terser form, with shorter option criteria. The worst case (six fighters, all six weapons on, incoming fire, a recent shot) is about 740 characters of state and an estimated 340 tokens for the whole question by a conservative 3.2 characters per token; the gateway reported 314 input tokens on a live call. A test keeps it under a 400-token budget, and the proxy logs `over budget` if a compact prompt ever exceeds it, instead of the call failing later with a 422.

This is a limitation of the model, not a tuning choice, and it is shown openly: Laya's panel says "Compact prompt (512-token limit)", and every match log records which prompt variant each fighter got (`roster[].prompt`, `full` or `compact`). It also makes a good talking point: a small, fast, cheap model with a tight input limit, playing with less detail than the others.

## Playing

In the page, pick **Mock**, **Live** or **Replay**, tick the fighters you want, and press **Start** or the space bar. The default line-up is the four classifiers. **Gemini** and the **Scripted bot (control)** are tick-boxes, off by default (or `&gemini=1`, `&bot=1` in the URL). Up to six fighters.

- Each fighter asks again as soon as its last answer lands, at most 10 times a second. While a call is pending it keeps its last action for 300 ms, then stands still. A ring fills under it while it waits. After 2 s with no answer, or on an error, it is stunned (red `!`) until its next good answer. Latency is the only handicap.
- **Character style**: **Classic** (coloured discs) or **Logos** (a 16x16 pixel sprite per fighter inside a team-coloured ring). Toggle with the STYLE buttons or `L`; `&style=logos` forces it for one load.
- **Sound**: retro effects and optional chiptune music, synthesised with the Web Audio API in `public/audio.js` (no audio files). Sound is presentation only and never changes the simulation.

### Model aims (optional)

Tick **Model aims** in setup to let each model choose its enemy. It is off by default and remembered in this browser. Off keeps the original nearest-visible-enemy aiming, options, prompts and replay hashes. On replaces `shoot` with `shoot_<fighterId>` for each living enemy, in the same single action question. Movement options stay the same. The fighter faces its chosen target; a blocked line of sight fires nothing and reports `blocked` in `last_shot`. Weapon range, spread and damage still apply.

The setting is fixed at Start, included in the match config/id and saved as `modelAims` in the log; logs without that field mean off. Tick-keyed actions such as `shoot_jev` replay the precise choice. Target probability bars use the enemy's name and colour, and the decision log shows `shoot -> JEV`. The leaderboard identifies the mode in recent matches and shows a **Who targets whom** choice-count table for enabled matches. These are target choices, not hits or kills. Mock fighters choose the nearest visible enemy deterministically, without an extra seeded random draw. Laya retains a compact prompt to fit her question budget.

### Controls

- **Space**: start, pause, resume. It never restarts a match, and does nothing on the results screen.
- **Restart** (top bar): the same match again from the beginning.
- While **paused** everything freezes in place and the bars, health, latency and decision log stay on screen to talk through. No new model calls are sent; answers already in flight are held and applied on the first tick after resume (logged at that tick, so replay still verifies).
- **History scrub**: each fighter's decision log keeps the whole match and scrolls (newest on top; it stays put if you have scrolled down). Click a row, or Tab to it and press Enter or Space, and the match pauses and rewinds: the arena is re-simulated from the seed and the recorded actions to that tick, and every panel shows its bars, latency, error and cost as they stood then. Left and Right arrows step through the selected fighter's decisions. Space or **Back to live** returns to the live match, exactly as it was (viewing works on a separate copy). Works in mock, live and replay, and on a finished match once the results are closed. Up to 2,000 rows per fighter are shown.
- `r` replays the last match (results screen), `l` switches character style, `m` sound, `n` music.
- `&autostart=1` starts a mock or replay match on load (kiosk demos, headless screenshots).

### Weapons dialog

**Weapons** (next to the seed) opens a dialog with a tick-box per weapon, then damage, cooldown (ticks), bullet life (or range for the flamethrower), ammo, and one extra where it makes sense (shotgun pellets, missile blast radius, flamethrower burst length). Defaults are shown in brackets and **Reset to defaults** restores them. The pistol is always on, as the fallback. The flamethrower is off by default. Values are clamped to sane limits and the choice is remembered in this browser.

Below the table are two pickup settings, saved with the weapons:

- **Starting pickup density** (0 to 2, step 0.25, default 0.75): the share of pickup spots filled when the match starts. Each slot round the arena has the same set of spots (shotgun, rifle, medpack and the newer weapons). The centre of the arena has no pickup (the Inkie logo sits there); the rifle spawns at off-centre spots, one per slot, a quarter slot to the side of each spawn axis. Below 1, the seed picks which spots are filled, with the same number in every slot, so the layout stays fair. Unfilled spots stay empty for the whole match. 0 means no pickups at all. Above 1, a second set of spots per slot is filled in the same way (2 fills all of them). Medpacks are scaled with everything else, so a sparse match can have no medpacks.
- **Respawn rate** (0 to 3, step 0.25, default 1): how fast a taken pickup comes back. 1 is 15 s, 0.5 is 30 s, 2 is 7.5 s, and 0 means a pickup never comes back.

The default density is 0.75 rather than the original 1, because a full map felt too busy. A setting of 1 and 1 is exactly the original layout and timing.

The config is fixed at Start and is part of the match: a disabled weapon never spawns (cover and the other pickups stay where they were), and the rules text every model gets is generated from the active config, so a disabled weapon is not mentioned and tuned numbers are shown. The full rules text states the respawn time; Laya's compact text does not mention pickup timing, so it is unchanged.

| Weapon | Range | Damage | Rate | Ammo |
|---|---|---|---|---|
| pistol | far | 4 | 2/s | unlimited |
| shotgun | near | 3 pellets x 5 | 1.4/s | 6 |
| rifle | far | 15, accurate | 1/s | 5 |
| uzi | mid | 2, wide spread | 7.5/s | 30 |
| missile | mid | up to 32 in a 28 radius blast (half at the edge); slow rocket; hurts the shooter too | 0.5/s | 2 |
| flamethrower (off by default) | close | 1 per tick (30/s) to anyone in a short cone, 0.4 s bursts | a burst every 0.6 s | 4 bursts |

Range buckets: close under 40, near under 90, mid under 160, far beyond. Bullets vanish at their range, and an empty weapon reverts to the pistol. Medpacks give +35 HP and are ignored at full HP. Pickups respawn after 15 s (scaled by the respawn rate). From 30 s the ring shrinks toward the centre and anyone outside it loses 10 HP/s. When one fighter is left, or at 60 s, the highest HP wins.

### What a model sees

An egocentric, bucketed scene: its HP, weapon, ammo, weapon range bucket, whether the gun is ready, the result of its last shot (`hit`, `miss`, `out_of_range` or `none`), each enemy's compass bearing, distance bucket, line of sight and HP, directions blocked by a wall or pillar, the nearest pickups, the ring (shrinking, inside or outside, distance to the edge, bearing to the centre), the time left, and `incoming`: the soonest hostile fire that will reach it. That is a bullet on a collision course, a missile whose path passes within its blast radius, or an enemy flamethrower in range and pointing its way, each with a bearing and an ETA in ticks.

## Leaderboard

**Leaderboard** (top bar) shows the all-time standings, stored by the server in `data/leaderboard.json` (written atomically). Per fighter: matches, wins, win rate, average place, average survival, kills, damage dealt, mean latency, errors and timeouts, sorted by wins then average place. Below that, recent matches with winner, mode, seed and weapon config.

- Only **live** matches are recorded and shown by default. Ticking **Include mock** shows mock matches too, and records new mock matches while it stays ticked. Replays are never recorded.
- **All configs / Current config** filters to matches played with the weapons in the dialog right now.
- Fighters level on alive, HP and time of death share a place. There is always a recorded winner (tie-break: kills, then roster order), and the match notes how it was won.
- Autoplay batches record to the same board, but only completed matches whose logs replay-verify; matches stopped by a budget are marked `aborted` and left out.
- **Reset leaderboard** asks to confirm, and the server keeps a backup copy (`data/leaderboard-<time>.bak.json`). Everything under `data/` is local and ignored by git.
- Endpoints: `GET /api/leaderboard`, `POST /api/leaderboard/record`, `POST /api/leaderboard/reset` with `{"confirm":"RESET"}`.

## Replay and determinism

The simulation runs at a fixed 30 Hz with a seeded PRNG and no wall-clock input. Every finished mock or live match is saved to `logs/` (and can be downloaded from the results screen). A log holds the seed, the roster (with each fighter's prompt variant), the weapon config (including the pickup settings), and every decision keyed by the physics tick it was applied on, with its probabilities, latency, error and cost. Replay re-runs the simulation from the log and checks the final state hash against the recorded one, showing `REPLAY VERIFIED` or `MISMATCH`. The replay roster and weapon config always come from the log, never from the page.

`examples/` holds three bundled mock matches (four classifiers; with the bot; six fighters with every weapon). They appear at the end of the Replay list.

Replay loading maps legacy `strafe_left` / `strafe_right` actions and probability keys to `spin_left` / `spin_right`. The movement and state hash are unchanged. The bundled examples use the current names.

`npm run headless -- 5 1` plays five mock matches in virtual time with no browser, writes `logs/headless-mock-seed<N>.json` and replays each to check the hash. Add `--bot` to include the scripted bot.

Logs recorded before the rifle was moved to its off-centre spots, or before the weapon update in November 2026, no longer verify (the bundled `examples/` were regenerated), because the simulation changed. Logs from before the pickup settings existed have no `pickups` field and replay with density 1 and respawn rate 1, and their config id is unchanged (they verify only if recorded after the rifle moved to its off-centre spots). Older logs that contain a `threat` field (from an earlier two-question version) still replay; the field is ignored.

## Running in production (Vercel)

This repo is the local game and proxy. The hosted lead-magnet deployment of the game is not part of this repo yet; if you deploy it yourself, keep these points in mind:

- The AI Gateway key is read only on the server, from the `AI_GATEWAY_API_KEY` environment variable. On Vercel, set it as an encrypted project environment variable. Never expose it as a public or `NEXT_PUBLIC_` variable, and never send it to the browser: the page only ever talks to the proxy.
- Locally, `npm run live` can read the key from a [pass](https://www.passwordstore.org/) entry named by `ARENA_PASS_ENTRY` instead of the environment.
- Use a dedicated gateway key for the game, with a spend cap set on the gateway itself. That cap is the real limit.
- `CALL_BUDGET` and `CALL_BUDGET_USD` are in-memory counters in the proxy process and reset whenever it restarts. On a serverless platform every cold start is a restart, so a public deployment needs a durable, shared counter (a database or key-value store) before these guards mean anything.
- The leaderboard and match logs are written to local files, which a serverless function cannot keep; they need durable storage too.

## What it measures, and what it does not

- It is a toy, not a benchmark. Each match is one seed, a few hundred decisions per fighter, and noisy. Treat a single match as a demo and the leaderboard as entertainment.
- It mixes decision quality with latency. A model that answers in 250 ms gets more turns than one that takes 900 ms, and that is deliberate: in a live system, a slow good answer can be a wrong answer.
- The scene is coarse (eight compass bearings, four distance buckets). The game does the aiming and pathing, so this tests choosing an intention, not spatial reasoning.
- Laya sees a compact version of the same facts, because of her 512-token question limit (see above). Everyone else sees identical text.
- Gemini is prompted for JSON and self-reports a confidence; it is a baseline for "just ask a chat model", not a like-for-like classifier.
- Latency depends on your network, the gateway and the provider on the day. Prices are estimates.
- No per-model prompt tuning was done beyond the one compact variant.

## Tests

```bash
npm test
```

The tests cover determinism (same seed and log give an identical state on every tick; a tampered log diverges; with and without the bot), scene bucketing and incoming fire (bullets, missile blasts, flame), the action lapse, request shapes and response parsing for each API, identical text for the full-prompt fighters, Laya's worst-case prompt staying under budget, the weapons and the weapon config, pickup density and respawn rate (none at density 0, never back at rate 0, symmetric per slot, deterministic replay, older logs without the fields), roster defaults and six-fighter matches, the space bar rules, the history scrub (rewind equals a full run, live state untouched), the leaderboard, the autoplay runner (roster rotation, spend forecasting and budget stops, replay verification before recording) and that the bundled example logs still verify. The autoplay tests run a proxy on port 8795 against a local fake gateway with a dummy key; no test calls a real model.

## Files

- `server.js`: static server, gateway proxy, call budget, log and leaderboard storage.
- `adapters.js`: request and response handling for each API, and the prompt budget guard.
- `public/shared.js`: roster, options, the full and compact prompt text.
- `public/sim.js`: deterministic simulation, scene bucketing, hash, replay cursor.
- `public/weapons.js`: weapon numbers and the weapon config, including the pickup settings (defaults, clamping, id, summary).
- `public/brain.js`: scripted bot, mock models, headless runner.
- `public/leaderboard.js`: leaderboard records, validation and aggregation.
- `public/game.js`, `public/index.html`: canvas, panels, decision loops, record and replay.
- `public/history.js` (decision history, rewind to a tick), `public/controls.js`, `public/sprites.js`, `public/audio.js`: space bar rules, pixel sprites, synthesised sound.
- `public/cost.js`: per-call cost estimate used when the gateway reports no cost. `public/assets/`: the Inkie logo drawn in the arena.
- `scripts/live.js` (start with a key), `scripts/autoplay.js` (unattended live matches with a spend guard), `scripts/headless.js` (mock matches without a browser), `scripts/smoke.js` (live calls through a running proxy), `scripts/worst-case.js` (the worst-case scene used by the tests and `smoke.js --worst`).
- `examples/`: bundled replay logs. `screenshots/`: images for this README.

## Credits and trademarks

Model names belong to their respective owners: Jev (TypeSafe AI), Luna (OpenAI), Laya (ConvAI Innovations), ScaleDown Classify-1 (ScaleDown) and Gemini (Google), all reached through Vercel AI Gateway. This project is not affiliated with or endorsed by any of them, and makes no claim to their names or marks.

The pixel sprites in `public/sprites.js` are original 16x16 pixel art, loosely inspired by the providers' marks. They are not official logo files. If you represent one of these organisations and would like a sprite changed or removed, please open an issue and it will be done.

The Inkie name and the logo in `public/assets/` belong to Inkie. The MIT licence covers the code, not those marks.

Made by [Inkie](https://inkie.ink).

## Licence

MIT, see [LICENSE](LICENSE).
