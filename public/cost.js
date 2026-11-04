// Same fallback as the live page, used only when the proxy has no billed/token cost.
import { promptVariant } from './shared.js';
export const EST_TOKENS = { decision: 1235, compact: 314, chat: 1200, chatOut: 20 };
export const estCost = (r) => r.kind === 'chat'
  ? EST_TOKENS.chat * r.price.in + EST_TOKENS.chatOut * r.price.out
  : EST_TOKENS[promptVariant(r) === 'compact' ? 'compact' : 'decision'] * r.price.in;
