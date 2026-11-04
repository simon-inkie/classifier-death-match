// First-run setup modal: the decisions with no DOM in them, so they can be tested.
// Shown on every load until the player ticks "do not show again" (kept in localStorage, which may be
// unavailable: callers pass a store whose get/set never throw). ?nosplash=1 hides it, ?splash=1 forces it.
export const SKIP_KEY = 'arenaSetupSkip';

export function showSetupOnLoad(params, store) {
  if (params.get('splash') === '1') return true;
  if (params.get('nosplash') === '1') return false;
  return !store.get(SKIP_KEY, false);
}

// The mode on first load: the URL's, else Live. explicit says whether the player asked for it.
export function initialMode(params) {
  const m = params.get('mode');
  return ['live', 'mock', 'replay'].includes(m) ? { mode: m, explicit: true } : { mode: 'live', explicit: false };
}

// Can Live be played right now, and if not, a friendly line saying why. status: /api/status, or null when
// the server could not be reached.
export function liveAvailability(status) {
  if (!status) return { ok: false, note: 'Live needs the local server running. Mock works offline.' };
  if (!status.keyLoaded) {
    return { ok: false, note: status.hosted ? 'Live is switched off on this site today. Mock is free and works the same way.'
      : 'Live needs AI_GATEWAY_API_KEY in .env. Mock works with no key.' };
  }
  if (status.spend?.exhausted) return { ok: false, note: "Today's live budget is spent; Live reopens tomorrow (midnight UTC). Mock is free." };
  if (status.spend?.busy) return { ok: true, note: 'The arena is busy: live matches may not start for a few minutes.' };
  return { ok: true, note: '' };
}

// The mode to use once the server's status is known: a defaulted Live falls back to Mock when Live is
// unavailable; a mode the player asked for in the URL is kept (the page explains why Live will not start).
export function settleMode({ mode, explicit }, status) {
  if (mode === 'live' && !explicit && !liveAvailability(status).ok) return 'mock';
  return mode;
}
