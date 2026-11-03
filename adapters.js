// Per-model call shapes through Vercel AI Gateway. Every fighter gets the same full state text and
// options, except Laya, who gets the compact variant (512-token per-question limit, see shared.js).
import { ACTIONS, stateTextFor, promptVariant, decisionQuestions, questionTokens, chatSystemPrompt, CHAT_SCHEMA,
  COMPACT_TOKEN_BUDGET } from './public/shared.js';

// Runtime guard: a compact prompt over budget is logged here, by name, instead of surfacing later as a
// gateway 422. It is never truncated (that would change what the model sees). Throttled to one line per 5 s.
let lastWarn = 0;
export function checkBudget(fighter, text, now = Date.now()) {
  const variant = promptVariant(fighter);
  const tokens = questionTokens(text, variant);
  const over = variant === 'compact' && tokens > COMPACT_TOKEN_BUDGET;
  if (over && now - lastWarn > 5000) {
    lastWarn = now;
    console.warn(`[prompt] ${fighter.id} over budget: ~${tokens} est tokens (${text.length} chars) > ${COMPACT_TOKEN_BUDGET}`);
  }
  return { variant, tokens, over };
}

// ---- per-transport request builders and response parsers
// weapons: the match's weapon config (the rules text lists only the enabled weapons, with their numbers).
// Every fighter in a match gets the same config, so the state text stays identical across models.
export function buildRequest(fighter, scene, GATEWAY = 'https://ai-gateway.vercel.sh', weapons) {
  const text = stateTextFor(fighter, scene, weapons);
  const { variant } = checkBudget(fighter, text);
  if (fighter.transport === 'typesafe') {
    // ScaleDown Classify-1 rides the same TypeSafe-compatible route. The shape below is the one that
    // returned HTTP 200 on 14 Oct 2026:
    // state as {text}, one Choice question, provider pinned to scaledown. Same text as everyone else.
    if (fighter.stateObject) {
      return { url: `${GATEWAY}/typesafe/v1/systemone`,
        body: { model: fighter.model, state: { text }, questions: decisionQuestions(variant),
          providerOptions: { gateway: { only: [fighter.model.split('/')[0]] } } } };
    }
    return { url: `${GATEWAY}/typesafe/v1/systemone`,
      body: { model: fighter.model, state: text, questions: decisionQuestions(variant) } };
  }
  if (fighter.transport === 'evaluate') {
    return { url: `${GATEWAY}/v1/evaluate`,
      body: { model: fighter.model, state: text, questions: decisionQuestions(variant) } };
  }
  if (fighter.transport === 'chat') {
    return { url: `${GATEWAY}/v1/chat/completions`,
      body: { model: fighter.model, temperature: 0, max_tokens: 60,
        messages: [{ role: 'system', content: chatSystemPrompt() }, { role: 'user', content: text }],
        response_format: { type: 'json_schema', json_schema: { name: 'decision', strict: true, schema: CHAT_SCHEMA } } } };
  }
  throw new Error('no transport');
}

export function parseResponse(fighter, j) {
  if (fighter.transport === 'chat') {
    const content = j?.choices?.[0]?.message?.content ?? '';
    const m = String(content).match(/\{[\s\S]*\}/);
    const o = JSON.parse(m ? m[0] : content);
    if (!ACTIONS.includes(o.action)) throw new Error(`bad action ${String(o.action).slice(0, 40)}`);
    const u = j.usage || {};
    const inTok = u.prompt_tokens ?? 0, outTok = u.completion_tokens ?? 0;
    const cost = Number(j?.providerMetadata?.gateway?.cost ?? j?.provider_metadata?.gateway?.cost ?? u.cost ??
      inTok * fighter.price.in + outTok * fighter.price.out);
    return { action: o.action, probs: null, confidence: Number(o.confidence),
      usage: { in: inTok, out: outTok }, cost };
  }
  const a = j?.answers?.action;
  if (!a || !ACTIONS.includes(a.choice)) throw new Error(`no choice in answer: ${JSON.stringify(j).slice(0, 160)}`);
  const probs = Object.fromEntries(ACTIONS.map((k) => [k, Number(a.probabilities?.[k] ?? 0)]));
  const u = j.usage || {};
  const inTok = u.input_tokens ?? u.inputTokens ?? 0, outTok = u.output_tokens ?? u.outputTokens ?? 0;
  const meta = j.provider_metadata?.gateway ?? j.providerMetadata?.gateway ?? {};
  const cost = meta.cost != null ? Number(meta.cost) : inTok * fighter.price.in + outTok * fighter.price.out;
  return { action: a.choice, probs, confidence: a.confidence ?? null,
    usage: { in: inTok, out: outTok }, cost };
}

