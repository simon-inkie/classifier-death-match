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
