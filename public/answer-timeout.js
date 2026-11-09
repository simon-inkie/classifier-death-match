// Shared match setting. Missing/invalid values retain the original two-second rule.
export const DEFAULT_ANSWER_TIMEOUT_SECONDS = 2;
export const MAX_ANSWER_TIMEOUT_SECONDS = 10;
export function clampAnswerTimeout(value) {
  if ((typeof value !== 'number' && typeof value !== 'string') || value === '' || (typeof value === 'string' && !value.trim())) return DEFAULT_ANSWER_TIMEOUT_SECONDS;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(MAX_ANSWER_TIMEOUT_SECONDS, Math.max(1, n)) : DEFAULT_ANSWER_TIMEOUT_SECONDS;
}
export const answerTimeoutMs = (config) => clampAnswerTimeout(config?.answerTimeoutSeconds) * 1000;
