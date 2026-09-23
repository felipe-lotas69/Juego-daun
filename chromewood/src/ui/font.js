/* ============================================================
   font.js - a bitmap font, drawn by hand

   The interface was using the browser's monospace at whatever size
   fitted, which is the one thing that makes a pixel-art game look
   like a web page with a canvas in it. This is a 5x7 font defined
   as ASCII art, baked to an atlas at load, and blitted at integer
   scales - so every letter lands on the same pixel grid as the
   world behind it.

   Tinted copies of the atlas are cached per colour, which keeps
   drawing a screenful of text to a handful of blits.
   ============================================================ */

const W = 5, H = 7, PAD = 1;

/* Each glyph is seven rows of five: '#' is ink. */
const GLYPHS = {
  ' ': '..... ..... ..... ..... ..... ..... .....',
  /* The interface reaches for these two and the font never had them,
     so every "HOLD [G] - BEACON CONSOLE" drew a blank box mid-line. */
  '\u2014': '..... ..... ..... ##### ..... ..... .....',
  '\u00b7': '..... ..... ..... ..#.. ..... ..... .....',
  'A': '.###. #...# #...# ##### #...# #...# #...#',
  'B': '####. #...# #...# ####. #...# #...# ####.',
  'C': '.###. #...# #.... #.... #.... #...# .###.',
  'D': '####. #...# #...# #...# #...# #...# ####.',
  'E': '##### #.... #.... ####. #.... #.... #####',
  'F': '##### #.... #.... ####. #.... #.... #....',
  'G': '.###. #...# #.... #.### #...# #...# .####',
  'H': '#...# #...# #...# ##### #...# #...# #...#',
  'I': '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.',
  'J': '..### ...#. ...#. ...#. ...#. #..#. .##..',
  'K': '#...# #..#. #.#.. ##... #.#.. #..#. #...#',
  'L': '#.... #.... #.... #.... #.... #.... #####',
  'M': '#...# ##.## #.#.# #.#.# #...# #...# #...#',
  'N': '#...# ##..# #.#.# #..## #...# #...# #...#',
  'O': '.###. #...# #...# #...# #...# #...# .###.',
  'P': '####. #...# #...# ####. #.... #.... #....',
  'Q': '.###. #...# #...# #...# #.#.# #..#. .##.#',
  'R': '####. #...# #...# ####. #.#.. #..#. #...#',
  'S': '.#### #.... #.... .###. ....# ....# ####.',
  'T': '##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
  'U': '#...# #...# #...# #...# #...# #...# .###.',
  'V': '#...# #...# #...# #...# #...# .#.#. ..#..',
  'W': '#...# #...# #...# #.#.# #.#.# ##.## #...#',
  'X': '#...# #...# .#.#. ..#.. .#.#. #...# #...#',
  'Y': '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..',
  'Z': '##### ....# ...#. ..#.. .#... #.... #####',
  '0': '.###. #...# #..## #.#.# ##..# #...# .###.',
  '1': '..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.',
  '2': '.###. #...# ....# ...#. ..#.. .#... #####',
  '3': '####. ....# ....# .###. ....# ....# ####.',
  '4': '...#. ..##. .#.#. #..#. ##### ...#. ...#.',
  '5': '##### #.... ####. ....# ....# #...# .###.',
  '6': '..##. .#... #.... ####. #...# #...# .###.',
  '7': '##### ....# ...#. ..#.. .#... .#... .#...',
  '8': '.###. #...# #...# .###. #...# #...# .###.',
  '9': '.###. #...# #...# .#### ....# ...#. .##..',
  '.': '..... ..... ..... ..... ..... .##.. .##..',
  ',': '..... ..... ..... ..... .##.. .##.. .#...',
  ':': '..... .##.. .##.. ..... .##.. .##.. .....',
  ';': '..... .##.. .##.. ..... .##.. .##.. .#...',
  '!': '..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..',
  '?': '.###. #...# ....# ..##. ..#.. ..... ..#..',
  "'": '..#.. ..#.. ..... ..... ..... ..... .....',
  '"': '.#.#. .#.#. ..... ..... ..... ..... .....',
  '-': '..... ..... ..... ##### ..... ..... .....',
  '_': '..... ..... ..... ..... ..... ..... #####',
  '+': '..... ..#.. ..#.. ##### ..#.. ..#.. .....',
  '/': '....# ...#. ...#. ..#.. .#... .#... #....',
  '\\': '#.... .#... .#... ..#.. ...#. ...#. ....#',
  '%': '##..# ##..# ...#. ..#.. .#... #..## #..##',
  '(': '...#. ..#.. .#... .#... .#... ..#.. ...#.',
  ')': '.#... ..#.. ...#. ...#. ...#. ..#.. .#...',
  '[': '.###. .#... .#... .#... .#... .#... .###.',
  ']': '.###. ...#. ...#. ...#. ...#. ...#. .###.',
  '<': '...#. ..#.. .#... #.... .#... ..#.. ...#.',
  '>': '.#... ..#.. ...#. ....# ...#. ..#.. .#...',
  '#': '.#.#. ##### .#.#. .#.#. ##### .#.#. .....',
  '*': '..... #.#.# .###. ##### .###. #.#.# .....',
  '=': '..... ..... ##### ..... ##### ..... .....',
  '@': '.###. #...# #.### #.#.# #.### #.... .###.',
  '&': '.##.. #..#. #.#.. .#... #.#.# #..#. .##.#',
  '|': '..#.. ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
  '^': '..#.. .#.#. #...# ..... ..... ..... .....',
  '~': '..... ..... .##.# #..#. ..... ..... .....',
  '$': '..#.. .#### #.#.. .###. ..#.# ####. ..#..',
};

const ORDER = Object.keys(GLYPHS);
const INDEX = new Map(ORDER.map((c, i) => [c, i]));

let atlas = null;
const tinted = new Map();

function buildAtlas() {
  const cols = 16;
  const rows = Math.ceil(ORDER.length / cols);
  const c = document.createElement('canvas');
  c.width = cols * (W + PAD);
  c.height = rows * (H + PAD);
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.fillStyle = '#ffffff';
  ORDER.forEach((ch, i) => {
    const ox = (i % cols) * (W + PAD);
    const oy = Math.floor(i / cols) * (H + PAD);
    const rowsStr = GLYPHS[ch].split(' ');
    for (let y = 0; y < H; y++) {
      const row = rowsStr[y] || '.....';
      for (let x = 0; x < W; x++) {
        if (row[x] === '#') g.fillRect(ox + x, oy + y, 1, 1);
      }
    }
  });
  atlas = { canvas: c, cols };
  return atlas;
}

/* One pre-tinted copy per colour: filling a colour through
   'source-in' once is far cheaper than per-glyph compositing. */
function tintedAtlas(color) {
  if (!atlas) buildAtlas();
  let t = tinted.get(color);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = atlas.canvas.width;
  c.height = atlas.canvas.height;
  const g = c.getContext('2d');
  g.drawImage(atlas.canvas, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  t = c;
  tinted.set(color, t);
  if (tinted.size > 48) {
    /* A run should not invent hundreds of colours; if it does,
       forget the oldest rather than growing without bound. */
    const first = tinted.keys().next().value;
    tinted.delete(first);
  }
  return t;
}

export const GLYPH_W = W;
export const GLYPH_H = H;

/* Does the font actually have this character? The checks use it,
   because a missing glyph does not throw - it draws a blank, which
   is invisible in code and obvious on screen. */
export function hasGlyph(ch) {
  return Object.prototype.hasOwnProperty.call(GLYPHS, ch)
    || Object.prototype.hasOwnProperty.call(GLYPHS, ch.toUpperCase());
}

export function textWidth(str, scale = 1, tracking = 1) {
  return str.length * (W + tracking) * scale - tracking * scale;
}

/* Draws at integer positions and integer scale: anything else and
   the letters stop lining up with the world's pixels. */
export function drawText(ctx, str, x, y, opts = {}) {
  const {
    scale = 1, color = '#ffffff', align = 'left', baseline = 'top',
    tracking = 1, shadow = '#000000', shadowOffset = 1,
  } = opts;
  if (!atlas) buildAtlas();
  const s = Math.max(1, Math.round(scale));
  const text = String(str).toUpperCase();
  const width = textWidth(text, s, tracking);
  let px = Math.round(align === 'center' ? x - width / 2 : align === 'right' ? x - width : x);
  let py = Math.round(baseline === 'middle' ? y - (H * s) / 2 : baseline === 'bottom' ? y - H * s : y);

  const blit = (src, ox, oy) => {
    let cx = px + ox;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      const idx = INDEX.has(ch) ? INDEX.get(ch) : INDEX.get('?');
      if (ch !== ' ') {
        const sx = (idx % atlas.cols) * (W + PAD);
        const sy = Math.floor(idx / atlas.cols) * (H + PAD);
        ctx.drawImage(src, sx, sy, W, H, cx, py + oy, W * s, H * s);
      }
      cx += (W + tracking) * s;
    }
  };

  if (shadow) blit(tintedAtlas(shadow), shadowOffset * s, shadowOffset * s);
  blit(tintedAtlas(color), 0, 0);
  return width;
}

/* Word-wraps to a pixel width. Split out from drawWrapped because
   panels need to measure a block before they draw the box behind it. */
export function wrapLines(str, maxWidth, scale = 1, tracking = 1) {
  const s = Math.max(1, Math.round(scale));
  const perLine = Math.max(1, Math.floor(maxWidth / ((W + tracking) * s)));
  const words = String(str).toUpperCase().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? line + ' ' + word : word;
    if (next.length > perLine && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

/* Truncates to a pixel width, marking the cut so a clipped name does
   not read as a different, shorter one. */
export function clipText(str, maxWidth, scale = 1, tracking = 1) {
  const s = Math.max(1, Math.round(scale));
  const per = (W + tracking) * s;
  const max = Math.max(1, Math.floor((maxWidth + tracking * s) / per));
  const t = String(str);
  return t.length <= max ? t : t.slice(0, Math.max(1, max - 1)) + '.';
}

/* Wraps on spaces and returns the number of lines drawn. */
export function drawWrapped(ctx, str, x, y, maxWidth, opts = {}) {
  const s = Math.max(1, Math.round(opts.scale || 1));
  const tracking = opts.tracking === undefined ? 1 : opts.tracking;
  const lines = wrapLines(str, maxWidth, s, tracking);
  const lh = (H + 2) * s;
  lines.forEach((l, i) => drawText(ctx, l, x, y + i * lh, opts));
  return lines.length;
}

export function lineHeight(scale = 1) { return (H + 2) * Math.max(1, Math.round(scale)); }
