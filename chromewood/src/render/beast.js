/* ============================================================
   beast.js - the animals, drawn flat like the people

   The player is a pixel sprite because a head made of cubes is a
   cube. The same is true of a fox. Everything that walks on four
   legs is drawn here instead, from the creature's own definition,
   so adding a species is a row in a table rather than a modelling
   job.

   One body plan, parameterised: barrel, neck, head, four legs, ears,
   a tail, and optional horns or a mane. What separates a hare from a
   boar at twenty pixels across is proportion and silhouette - leg
   length, body depth, ear size, how the head is carried - and those
   are all numbers.

   Four directions are drawn (toward the camera, three quarters,
   side on, away) and the other four are mirrors, and there are four
   frames of trot.
   ============================================================ */

export const B_DIRS = 4;
export const B_FRAMES = 4;
export const B_W = 26;
export const B_H = 22;

/* Which drawn column each of the eight compass directions uses, in
   the same screen order the player's sheet is in. */
export const B_DIR_MAP = [
  { col: 0, flip: false },   /* toward camera      */
  { col: 1, flip: false },   /* three quarters     */
  { col: 2, flip: false },   /* side on            */
  { col: 3, flip: false },   /* away               */
  { col: 3, flip: true },
  { col: 2, flip: true },
  { col: 1, flip: true },
  { col: 1, flip: true },
];

function hex(n) { return '#' + (n >>> 0).toString(16).padStart(6, '0'); }

function shade(n, t) {
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => Math.max(0, Math.min(255, Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t)));
  return (f(r) << 16) | (f(g) << 8) | f(b);
}

/* How each species is built. Everything not given falls back to a
   middling four-legged animal. */
export const SHAPES = {
  critter: { len: 8, depth: 5, leg: 2, head: 4, ear: 2, tail: 'tuft', lift: 1 },
  hare:    { len: 8, depth: 5, leg: 3, head: 4, ear: 5, tail: 'tuft', lift: 2 },
  fowl:    { len: 7, depth: 6, leg: 3, head: 3, ear: 0, tail: 'fan', lift: 1, beak: true, biped: true },
  fox:     { len: 11, depth: 5, leg: 3, head: 5, ear: 3, tail: 'brush', lift: 2, snout: 2 },
  deer:    { len: 12, depth: 6, leg: 6, head: 5, ear: 3, tail: 'tuft', lift: 4, horns: 'antler' },
  boar:    { len: 12, depth: 8, leg: 3, head: 6, ear: 2, tail: 'tuft', lift: 2, snout: 2, tusks: true },
  ram:     { len: 12, depth: 8, leg: 4, head: 5, ear: 2, tail: 'tuft', lift: 3, horns: 'curl', wool: true },
  wolf:    { len: 13, depth: 6, leg: 4, head: 6, ear: 3, tail: 'brush', lift: 3, snout: 2, mane: true },
  lumen:   { len: 7, depth: 7, leg: 0, head: 0, ear: 0, tail: 'none', lift: 7, float: true },
};

const DEFAULT_SHAPE = { len: 10, depth: 6, leg: 3, head: 5, ear: 2, tail: 'tuft', lift: 2 };

const sheets = new Map();

export function beastSheet(type, color, accent) {
  const key = `${type}:${color}:${accent}`;
  if (sheets.has(key)) return sheets.get(key);

  const cv = document.createElement('canvas');
  cv.width = B_W * B_DIRS;
  cv.height = B_H * B_FRAMES;
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;

  const shape = SHAPES[type] || DEFAULT_SHAPE;
  const P = {
    COAT: color,
    COAT_D: shade(color, -0.36),
    COAT_L: shade(color, 0.26),
    BELLY: shade(color, 0.42),
    ACCENT: accent,
    HOOF: shade(color, -0.62),
    EYE: 0x191320,
    LINE: 0x140f1c,
  };

  for (let d = 0; d < B_DIRS; d++) {
    for (let f = 0; f < B_FRAMES; f++) {
      drawBeast(c, d * B_W, f * B_H, d, f, shape, P);
    }
  }

  sheets.set(key, cv);
  return cv;
}

function drawBeast(c, ox, oy, dir, frame, S, P) {
  const R = (x, y, w, h, col) => {
    if (w <= 0 || h <= 0) return;
    c.fillStyle = hex(col); c.fillRect(ox + x, oy + y, w, h);
  };

  const step = [1, 0, -1, 0][frame];
  const bob = frame % 2 === 1 ? 1 : 0;

  const side = dir === 2;
  const away = dir === 3;
  const front = dir === 0;

  /* Everything hangs off the floor line, so a tall animal and a low
     one both stand on the ground rather than both being centred. */
  const FLOOR = B_H - 2;
  const legTop = FLOOR - S.leg;
  const bodyBottom = legTop + 1;
  const bodyTop = bodyBottom - S.depth - bob;

  if (S.float) {
    /* A floater has no legs and no ground contact: a bob and a glow. */
    const cy = 6 + (frame % 2) - Math.floor(step * 0.5);
    R(B_W / 2 - S.len / 2, cy, S.len, S.depth, P.COAT);
    R(B_W / 2 - S.len / 2 + 1, cy - 1, S.len - 2, 1, P.COAT_L);
    R(B_W / 2 - 2, cy + 2, 4, 2, P.ACCENT);
    for (let i = 0; i < 3; i++) {
      R(B_W / 2 - 3 + i * 3, cy + S.depth + 1 + (i % 2), 1, 2 + (i % 2), P.COAT_D);
    }
    outline(c, ox, oy, P);
    return;
  }

  /* ---- body ------------------------------------------------------ */
  /* Seen head on an animal is as deep as it is wide; from the side
     it is as long as it is. That one substitution is most of what
     makes four directions read as four directions. */
  /* Head on, an animal is about two thirds as wide as it is long -
     narrower than that and a deer reads as a totem pole. */
  const len = side ? S.len : Math.round(S.len * (dir === 1 ? 0.82 : 0.66));
  const bx = Math.round(B_W / 2 - len / 2);

  R(bx, bodyTop, len, S.depth, P.COAT);
  R(bx, bodyTop, len, 1, P.COAT_L);                    /* back, catching light */
  R(bx, bodyBottom - 2, len, 2, P.COAT_D);             /* belly, in shadow     */
  if (S.wool) {
    for (let i = 0; i < len; i += 3) R(bx + i, bodyTop - 1, 2, 2, P.COAT_L);
  }

  /* ---- legs ------------------------------------------------------ */
  const legW = Math.max(2, Math.round(S.depth / 3));
  const pairs = side
    ? [[bx + 1, step], [bx + len - legW - 1, -step], [bx + 3, -step], [bx + len - legW - 3, step]]
    : [[bx, step], [bx + len - legW, -step]];
  for (const [lx, sw] of pairs) {
    const h = S.leg - Math.max(0, sw);
    R(lx, legTop, legW, h, P.COAT_D);
    R(lx, legTop + h, legW, 1, P.HOOF);
  }
  if (S.biped) {
    /* Two legs, under the middle. */
    R(Math.round(B_W / 2) - 2, legTop, 1, S.leg, P.ACCENT);
    R(Math.round(B_W / 2) + 1, legTop, 1, S.leg, P.ACCENT);
  }

  /* ---- head ------------------------------------------------------ */
  const hw = S.head;
  const hh = Math.max(3, S.head - 1);
  /* Where the head sits: forward and up on a side view, dead centre
     and forward when it is coming at you. */
  const hx = side ? bx + len - Math.round(hw * 0.4)
    : Math.round(B_W / 2 - hw / 2) + (dir === 1 ? 2 : 0);
  /* The neck only reads from the side. Coming at you the head sits
     down on the shoulders, or the animal is a head on a stick. */
  const hy = bodyTop - Math.round(S.lift * (side ? 1 : 0.45)) - bob;

  if (!away) {
    R(hx, hy, hw, hh, P.COAT);
    R(hx, hy, hw, 1, P.COAT_L);
    /* Neck, joining head to body so it is one animal. */
    R(hx + (side ? 0 : 1), hy + hh - 1, side ? 2 : hw - 2, bodyTop - hy - hh + 3, P.COAT_D);

    if (S.snout) {
      const sx = side ? hx + hw : hx + Math.round(hw / 2) - 1;
      R(sx, hy + Math.floor(hh / 2), side ? S.snout : 2, 2, P.COAT_D);
      if (S.tusks) {
        R(sx + (side ? S.snout : 0), hy + Math.floor(hh / 2) - 1, 1, 1, 0xefe6cf);
        if (!side) R(sx + 1, hy + Math.floor(hh / 2) - 1, 1, 1, 0xefe6cf);
      }
    }
    if (S.beak) {
      const sx = side ? hx + hw : hx + Math.round(hw / 2) - 1;
      R(sx, hy + 1, 2, 2, P.ACCENT);
    }
    /* Eyes: one from the side, two head on. */
    if (side) R(hx + hw - 2, hy + 1, 1, 1, P.EYE);
    else { R(hx + 1, hy + 1, 1, 1, P.EYE); R(hx + hw - 2, hy + 1, 1, 1, P.EYE); }

    /* Ears. */
    if (S.ear > 0) {
      if (side) R(hx + 1, hy - S.ear, 1, S.ear, P.COAT_D);
      else { R(hx, hy - S.ear, 1, S.ear, P.COAT_D); R(hx + hw - 1, hy - S.ear, 1, S.ear, P.COAT_D); }
    }
    /* Horns: two shapes, both cheap and both unmistakable. */
    if (S.horns === 'antler') {
      const ax = side ? hx + 1 : hx;
      R(ax, hy - S.ear - 3, 1, 3, 0xd8c8a8);
      R(ax - 1, hy - S.ear - 4, 1, 2, 0xd8c8a8);
      if (!side) {
        R(hx + hw - 1, hy - S.ear - 3, 1, 3, 0xd8c8a8);
        R(hx + hw, hy - S.ear - 4, 1, 2, 0xd8c8a8);
      }
    } else if (S.horns === 'curl') {
      const ax = side ? hx : hx - 1;
      R(ax, hy - 1, 2, 1, 0xcdbb92);
      R(ax - 1, hy, 1, 2, 0xcdbb92);
      R(ax, hy + 2, 2, 1, 0xcdbb92);
      if (!side) {
        R(hx + hw - 1, hy - 1, 2, 1, 0xcdbb92);
        R(hx + hw + 1, hy, 1, 2, 0xcdbb92);
        R(hx + hw - 1, hy + 2, 2, 1, 0xcdbb92);
      }
    }
    if (S.mane) R(hx - (side ? 1 : 0), hy + 1, side ? 2 : hw, 3, P.COAT_D);
  } else {
    /* From behind: haunches, ears over the top, and the tail. */
    R(hx, hy + 1, hw, hh - 1, P.COAT_D);
    if (S.ear > 0) {
      R(hx, hy - S.ear + 1, 1, S.ear, P.COAT_D);
      R(hx + hw - 1, hy - S.ear + 1, 1, S.ear, P.COAT_D);
    }
  }

  /* ---- tail ------------------------------------------------------ */
  const tx = side ? bx - 1 : Math.round(B_W / 2) - 1;
  const ty = bodyTop + 1;
  if (S.tail === 'brush') {
    R(tx - 1, ty - 1 + Math.max(0, step), 3, 4, P.COAT_D);
    R(tx - 1, ty - 1 + Math.max(0, step), 3, 1, P.COAT_L);
  } else if (S.tail === 'fan') {
    R(tx - 2, ty - 2, 3, 5, P.ACCENT);
  } else if (S.tail === 'tuft') {
    R(tx, ty + Math.max(0, -step), 1, 2, P.COAT_D);
  }

  outline(c, ox, oy, P);
}

/* The same trick the character uses: a dark edge found from what has
   been drawn rather than hand-placed, so it is right whatever shape
   the table asked for. */
function outline(c, ox, oy, P) {
  const img = c.getImageData(ox, oy, B_W, B_H);
  const px = img.data;
  const at = (x, y) => (y * B_W + x) * 4;
  const solid = (x, y) => x >= 0 && y >= 0 && x < B_W && y < B_H && px[at(x, y) + 3] > 0;
  const edge = [];
  for (let y = 0; y < B_H; y++) {
    for (let x = 0; x < B_W; x++) {
      if (solid(x, y)) continue;
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) edge.push([x, y]);
    }
  }
  c.fillStyle = hex(P.LINE);
  for (const [x, y] of edge) c.fillRect(ox + x, oy + y, 1, 1);
}

/* Screen-space direction, same convention as the character's. */
export function beastDir(facing, cameraYaw) {
  const TAU = Math.PI * 2;
  let a = Math.PI - facing - cameraYaw;
  a = ((a % TAU) + TAU) % TAU;
  return Math.round(a / (TAU / 8)) % 8;
}
