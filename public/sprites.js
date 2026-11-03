// Retro pixel-art "logo" sprites for the Logos character style.
// Hand-drawn 16x16 approximations of each provider's public mark, authored here as
// character grids. No official image files are used or embedded.
//   jev    TypeSafe AI: magenta disc with a black isometric hex "S" (two linked hexagon outlines)
//   luna   OpenAI: white hexagonal "blossom" knot on a black disc
//   laya   ConvAI Innovations: half brain (green to blue) with circuit traces and nodes
//   scaledown ScaleDown: violet disc with white bars stepping down left to right ("scale down")
//   gemini Google: four-colour "G" on a white disc
//   bot    no provider: a small grey robot head (the scripted control)

export const SPRITE_SIZE = 16;

export const SPRITES = {
  jev: {
    palette: { P: '#e05bc0', p: '#b8409c', K: '#141414' },
    rows: [
      '.....PPPPPP.....',
      '...PPPKPPPPPP...',
      '..PPKKPKKPPPPP..',
      '.PPKPPPPPKPPPPP.',
      '.PPKPPKPPKPPPPP.',
      'PPPKPPKPPKPPPPPP',
      'PPPKPPKPPKPPPPPP',
      'PPPPKKKKKKPPPPPP',
      'PPPPPPKKKPKKPPPP',
      'PPPPPPKPPKPPKPPP',
      'PPPPPPKPPKPPKPPP',
      '.PPPPPKPPKPPKPP.',
      '.PPPPPKPPKPPKPP.',
      '..PPPPPKKPKKPPp.',
      '...PPPPPPKPPPp..',
      '.....pppppp.....',
    ],
  },
  luna: {
    palette: { B: '#0d0d0d', W: '#ffffff', g: '#9a9a9a' },
    rows: [
      '......BBBB......',
      '....BBBWWBBB....',
      '..BBBWWWWWBBBB..',
      '..BBBWWWWBBWBB..',
      '.BWWWBWWBBWWWWB.',
      '.BWWWBWBBWWWWWB.',
      'BBWWWBWBBBBWWWBB',
      'BBWWWBBBBBWBBBBB',
      'BBBBBWBBBBBWWWBB',
      'BBWWWBBBBWBWWWBB',
      '.BWWWWWBBWBWWWB.',
      '.BWWWWBBWWBWWWB.',
      '..BBWBBWWWWBBB..',
      '..BBBBWWWWWBBB..',
      '....BBBWWBBB....',
      '......BBBB......',
    ],
  },
  laya: {
    palette: { a: '#3cf0a0', b: '#22d0b0', c: '#18a8c8', d: '#1a78e0', e: '#1650c8', o: '#0a2a3a', n: '#e8fff8' },
    rows: [
      '..aaa.aaa.......',
      '.aaaaaaaa.a..nn.',
      'aaaaaaoaa.aaann.',
      'aaaoaaaaa.a.....',
      'bbbbbbbbb.b.....',
      'bbbbbobbb.b..nn.',
      'bbobbbbbb.bbbnn.',
      'ccccccccc.c.....',
      'ccccccccc.c.....',
      '.cccccccc.c..nn.',
      '.dddddddd.dddnn.',
      '..ddddddd.d.....',
      '...dddddd.d.....',
      '...eeeeee.e..nn.',
      '....eeeee.eeenn.',
      '.....eeee.......',
    ],
  },
  scaledown: {
    palette: { V: '#b07cff', v: '#7c4fd0', W: '#ffffff' },
    rows: [
      '.....VVVVVV.....',
      '...VVVVVVVVVV...',
      '..VVVVVVVVVVVV..',
      '.VVWWVVVVVVVVVV.',
      '.VVWWVVVVVVVVVV.',
      'VVVWWVWWVVVVVVVV',
      'VVVWWVWWVVVVVVVV',
      'VVVWWVWWVWWVVVVV',
      'VVVWWVWWVWWVVVVV',
      'VVVWWVWWVWWVWWVV',
      'VVVWWVWWVWWVWWVV',
      '.VVWWVWWVWWVWWV.',
      '.VVVVVVVVVVVVVv.',
      '..VVVVVVVVVVVv..',
      '...VVVVVVVVVv...',
      '.....vvvvvv.....',
    ],
  },
  gemini: {
    palette: { W: '#ffffff', r: '#ea4335', y: '#fbbc05', g: '#34a853', b: '#4285f4', s: '#d0d0d0' },
    rows: [
      '.....WWWWWW.....',
      '...WWWWWWWWWW...',
      '..WWWWrrrrWWWW..',
      '.WWWrrrrrrrrWWW.',
      '.WWrrrWWWWrrWWW.',
      'WWrrrWWWWWWWWWWW',
      'WWyyWWWWWWWWWWWW',
      'WWyyWWWWWbbbbbbW',
      'WWyyWWWWWbbbbbbW',
      'WWyyWWWWWWWWbbbW',
      'WWgggWWWWWWbbbWW',
      '.WWgggWWWWbbbWW.',
      '.WWWggggggggWWW.',
      '..WWWWggggWWWW..',
      '...WWWWWWWWWWs..',
      '.....ssssss.....',
    ],
  },
  bot: {
    palette: { G: '#b8b8c0', g: '#7c7c88', K: '#141418', c: '#3cf0ff', r: '#ff4d4d' },
    rows: [
      '.......rr.......',
      '.......rr.......',
      '.......gg.......',
      '...GGGGGGGGGG...',
      '..GGGGGGGGGGGG..',
      '..GKKKKKKKKKKG..',
      '.gGKccKKKKccKGg.',
      '.gGKccKKKKccKGg.',
      '.gGKKKKKKKKKKGg.',
      '..GKKcKcKcKcKG..',
      '..GKKKKKKKKKKG..',
      '..GGGGGGGGGGGG..',
      '...gggggggggg...',
      '.....GG..GG.....',
      '....gggg.gggg...',
      '................',
    ],
  },
};

// Pre-render each sprite three ways: normal, a white hit-flash silhouette, and both with a
// 1px dark outline so they read on the floor. Cached per id. Browser only.
const cache = new Map();

function paint(def, colourFor) {
  const c = document.createElement('canvas');
  c.width = c.height = SPRITE_SIZE + 2; // +2 for the outline
  const g = c.getContext('2d');
  const solid = (x, y) => x >= 0 && y >= 0 && x < SPRITE_SIZE && y < SPRITE_SIZE && def.rows[y][x] !== '.';
  // outline: any empty pixel touching a filled one
  g.fillStyle = '#05050a';
  for (let y = -1; y <= SPRITE_SIZE; y++) for (let x = -1; x <= SPRITE_SIZE; x++) {
    if (solid(x, y)) continue;
    if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) g.fillRect(x + 1, y + 1, 1, 1);
  }
  for (let y = 0; y < SPRITE_SIZE; y++) for (let x = 0; x < SPRITE_SIZE; x++) {
    const ch = def.rows[y][x];
    if (ch === '.') continue;
    g.fillStyle = colourFor(ch, def);
    g.fillRect(x + 1, y + 1, 1, 1);
  }
  return c;
}

export function spriteCanvases(id) {
  if (!cache.has(id)) {
    const def = SPRITES[id];
    if (!def) return null;
    cache.set(id, {
      normal: paint(def, (ch, d) => d.palette[ch] || '#f0f'),
      flash: paint(def, () => '#ffffff'),
    });
  }
  return cache.get(id);
}

// A crisp, scaled-up copy for the HTML panels and results table.
export function spriteElement(id, px = 36, ring = null) {
  const base = spriteCanvases(id);
  const el = document.createElement('canvas');
  const size = SPRITE_SIZE + 2;
  const scale = Math.max(1, Math.round(px / size));
  el.width = el.height = size * scale;
  el.className = 'sprite';
  const g = el.getContext('2d');
  g.imageSmoothingEnabled = false;
  if (base) g.drawImage(base.normal, 0, 0, el.width, el.height);
  if (ring) el.style.boxShadow = `0 0 0 2px ${ring}`;
  return el;
}

export function spriteDataUrl(id, px = 24, ring = null) {
  return spriteElement(id, px, ring).toDataURL('image/png');
}
