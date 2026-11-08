# feat/settings-modal-tabs

## TL;DR
Two jobs from Simon (8 Nov). 1: get the model picker running locally so a Claude Sonnet or Opus can
play a fighter slot. 2: move every setting off the top bar into one Settings button and a tabbed modal
(Fighters, Gameplay, Sound). No change to the simulation, its wiring, defaults or replay hashes.

## Scope
1. Model picker: find how the server starts and where the key comes from, which Anthropic ids pass the
   catalogue and their per-call bounds, the cap that lets Sonnet and Opus through; run it on loopback.
2. Settings modal: header keeps title, mode, replay controls, Settings, Start/Restart/pause, Warm up,
   Leaderboard, status chips, clock. Everything else moves into the modal, same element ids so the
   existing wiring in game.js is untouched. Tabs with roles/aria, arrow keys, Esc closes, focus trapped
   and restored, phone width.

## Tests
- `npm test` must stay green (HEAD baseline recorded below).
- Pure tab/focus-trap key logic in `public/settings.js`, tested like `public/setup.js`.
- Markup check: the header holds no settings controls; the modal has a tablist with one panel per tab.

## Follow-ups
(appended as work happens)

## Amendments
- HEAD baseline (29689b3): `npm test` 87/87 pass.

### 2026-11-08 model picker (commit 9929a2f)
- Real blocker was not the cap: the gateway lists every Anthropic model with `web_search`, `fast` and
  `regional` pricing keys, and `parseCatalogue` refused any extra key, so no Sonnet or Opus was pickable.
  Now `web_search` and `fast` are ignored (opt-in; the chat request sends no tools and no speed option),
  regional rates are validated and the bound takes the highest; every other extra is still refused.
- Bounds at 3x worst case (gateway list, 8 Nov): Sonnet 5.5 and 5 $0.0449, Sonnet 4.6 $0.0673,
  Opus 5.5 $0.0898, Opus 4.5 to 5 $0.1122. Sonnet 4.5 and Haiku 5.5 still refused (tiered pricing).
- Cap 0.09: the smallest round value over Opus 5.5. Older Opus stays refused.
- Local run on 127.0.0.1:8797, key from `pass inkie/agent-keys/vercel-ai-gateway`, CALL_BUDGET_USD=3.
  One real call each: Sonnet 5.5 3.2 s $0.0034, Opus 5.5 1.7 s $0.0069.
- CALL_TIMEOUT_MS=6000 on the server only so late answers are still costed; the page stuns any answer
  over 2 s (game rule, unchanged), so Sonnet at ~3 s will mostly be stunned in a live match.

### 2026-11-08 settings modal
- Header keeps: mode, replay picker/file/speed, Settings, Start, Restart, pause chip, Warm up, sound
  unlock hint, Leaderboard, key/budget chips, ring message, clock.
- Modal tabs: Fighters (roster tick-boxes, per-slot model picker, character style), Gameplay (seed, model
  aims, weapons table, pickups, reset), Sound (sound, volume, music). No fourth tab needed.
- Same element ids moved into the modal, so game.js wiring and every sim input are untouched. The
  separate Weapons dialog is folded into Gameplay; its summary now updates `#wpnSummary`.
- Setup (intro walkthrough) button moved into the modal footer as Intro. Backdrop click closes.
- Replay mode: the hidden roster/gameplay controls are replaced by a note in each tab.
- Pure key logic in `public/settings.js` tested in `test/settings.test.js`, plus a markup contract test.
  Tests 90/90. Headless Chromium check at 1366 and 390 wide: arrows, Tab wrap, Escape restores focus to
  Settings, no horizontal scroll, mock match runs, no console errors.

### 2026-11-08 Simon feedback round
- Fighters tab: per-slot model drop-downs gone (header modal and intro). The line-up is a list with
  Remove (disabled at 2) and Add fighter (disabled at 6), whose list is the roster fighters not playing
  plus, picker on, gateway models. A gateway model takes a free model slot (chat slot first) as that
  slot's `pickedModels` entry, so `/api/match/start` and `/api/decide` see exactly what the old picker sent.
  With 4 classifiers in, one gateway model fits; adding Sonnet and Opus means removing a classifier.
- `/api/models` (local and hosted) now lists only models the cap allows (`pickableModels`), so Add never
  offers a model the server refuses. Over-cap models still refused on start/decide as before.
- Tabs and sound "missing": reproduced. The tabs and sound render fine at both widths, picker on and
  off; no caching (all routes `no-store`, and 8792/8793 serve the same checkout files). What Simon saw is
  the first-run intro, which shows on every load, covers the whole page including Settings, and has
  fighters and match settings but no tabs or sound. Fix: an All settings button at the top of the intro
  opens Settings; Settings footer shows the host and picker state, to tell the three servers apart.
- Follow-up: arena panels still show the slot name (GEMINI) for a gateway model in that slot.
