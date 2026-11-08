import { rosterById } from './shared.js';
import { SPRITES, SPRITE_SIZE } from './sprites.js';

const COMPANIES = {
  google: 'Google', openai: 'OpenAI', anthropic: 'Anthropic', meta: 'Meta',
  mistral: 'Mistral', alibaba: 'Alibaba', deepseek: 'DeepSeek', zai: 'Z.ai',
  moonshotai: 'Moonshot AI', minimax: 'MiniMax', nvidia: 'NVIDIA', amazon: 'Amazon',
};
const validModelId = (id) => typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,39}\/[a-z0-9][a-z0-9._-]{0,99}$/i.test(id) && !id.includes('..');
const providerFor = (modelId) => validModelId(modelId) ? modelId.split('/')[0].toLowerCase() : 'unknown';
export const companyForModel = (modelId) => {
  const provider = providerFor(modelId);
  return Object.hasOwn(COMPANIES, provider) ? COMPANIES[provider] : provider;
};

// Three by five pixel capitals, enlarged twofold at the centre of a 16px disc.
const FONT = {
  A: '010/101/111/101/101', B: '110/101/110/101/110', C: '011/100/100/100/011',
  D: '110/101/101/101/110', E: '111/100/110/100/111', F: '111/100/110/100/100',
  G: '011/100/101/101/011', H: '101/101/111/101/101', I: '111/010/010/010/111',
  J: '001/001/001/101/010', K: '101/101/110/101/101', L: '100/100/100/100/111',
  M: '101/111/111/101/101', N: '101/111/111/111/101', O: '010/101/101/101/010',
  P: '110/101/110/100/100', Q: '010/101/101/111/011', R: '110/101/110/101/101',
  S: '011/100/010/001/110', T: '111/010/010/010/010', U: '101/101/101/101/111',
  V: '101/101/101/101/010', W: '101/101/111/111/101', X: '101/101/010/101/101',
  Y: '101/101/010/010/010', Z: '111/001/010/100/111',
  '0': '111/101/101/101/111', '1': '010/110/010/010/111', '2': '110/001/010/100/111',
  '3': '110/001/010/001/110', '4': '101/101/111/001/001', '5': '111/100/110/001/110',
  '6': '011/100/111/101/111', '7': '111/001/010/010/010', '8': '111/101/111/101/111',
  '9': '111/101/111/001/110',
};

export function iconIdForModel(modelId) {
  const slug = providerFor(modelId);
  if (Object.hasOwn(SPRITES, slug)) return slug;
  const aliases = { google: 'gemini', openai: 'luna' };
  const alias = Object.hasOwn(aliases, slug) ? aliases[slug] : null;
  if (alias) {
    SPRITES[slug] = SPRITES[alias];
    return slug;
  }
  const id = `initial:${slug}`;
  if (!Object.hasOwn(SPRITES, id)) {
    let hash = 0;
    for (const ch of slug) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) >>> 0;
    const glyph = (FONT[slug[0].toUpperCase()] || FONT.I).split('/');
    const rows = Array.from({ length: SPRITE_SIZE }, (_, y) => Array.from({ length: SPRITE_SIZE }, (_, x) => {
      if ((x - 7.5) ** 2 + (y - 7.5) ** 2 > 64) return '.';
      if (x >= 5 && x < 11 && y >= 3 && y < 13 && glyph[Math.floor((y - 3) / 2)][Math.floor((x - 5) / 2)] === '1') return 'W';
      return 'B';
    }).join(''));
    SPRITES[id] = { palette: { B: `hsl(${hash % 360}, 55%, 32%)`, W: '#ffffff' }, rows };
  }
  return id;
}

// Slot IDs and colours remain stable; only an overridden model changes the displayed identity.
export function fighterIdentity(fighter, modelId = fighter.model) {
  return validModelId(modelId) && (modelId !== fighter.model || fighter.gatewaySlot) && fighter.kind !== 'bot'
    ? { name: modelId.split('/').pop(), iconId: iconIdForModel(modelId) }
    : { name: fighter.name, iconId: fighter.id };
}

// Stored records may predate model metadata; their original roster identity remains readable.
export function recordFighterIdentity(row) {
  const slot = row.slotId || row.id;
  const fighter = Object.hasOwn(rosterById, slot) ? rosterById[slot] : null;
  if (fighter) return fighterIdentity(fighter, row.model === undefined ? fighter.model : row.model);
  if (validModelId(row.model)) return { name: row.model.split('/').pop(), iconId: iconIdForModel(row.model) };
  return { name: row.id, iconId: 'bot' };
}
