/* ============================================================
   textures.js - the pixel detail

   Flat-shaded boxes read as plastic. What sells the style is a
   little hand-placed noise on every surface: blades in the grass,
   grain in the wood, cracks in the stone, rivets in the plating.

   Everything here is generated at load into one atlas of 16x16
   cells. The cells store a *multiplier*, not a colour: the world
   keeps choosing its own palette through vertex colours and this
   only decides which texels are lighter and darker. Ore and a few
   others tint as well, which is why the atlas is RGB.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { makeRng } from '../core/rng.js';

export const CELL = 16;          /* texels on a side              */
/* Multipliers run past 1.0 - a highlight on a blade of grass is
   brighter than the base colour - so the byte texture stores
   value/RANGE and the shader scales it back up. Without this every
   highlight clips at 1.0 and the atlas can only ever darken. */
export const RANGE = 2.0;
export const GRID = 8;           /* cells across the atlas        */
export const ATLAS = CELL * GRID;

/* Cell indices. Anything that draws geometry names one of these. */
export const TEX = {
  FLAT: 0,
  GRASS: 1,
  GRASS_DRY: 2,
  MOSS: 3,
  DIRT: 4,
  STONE: 5,
  ROCK: 6,
  GRAVEL: 7,
  SAND: 8,
  SNOW: 9,
  ASH: 10,
  BARK: 11,
  PLANK: 12,
  LEAF: 13,
  METAL: 14,
  RUST: 15,
  CRYSTAL: 16,
  ORE_IRON: 17,
  ORE_GOLD: 18,
  ORE_ESSENCE: 19,
  WATER: 20,
  BRICK: 21,
  THATCH: 22,
  CLOTH: 23,
  HIDE: 24,
  BONE: 25,
  TILE: 26,
  PANEL: 27,
  CIRCUIT: 28,
  ICE: 29,
  MUD: 30,
  FUR: 31,
};

/* ---------------------------------------------------- painting */
/* A tiny canvas-free painter: every generator writes into one
   16x16 block of the atlas through these helpers. */
class Cellf {
  constructor(data, index) {
    this.data = data;
    this.ox = (index % GRID) * CELL;
    this.oy = Math.floor(index / GRID) * CELL;
  }
  set(x, y, r, g, b) {
    /* Wrap, so every pattern tiles seamlessly by construction. */
    const px = this.ox + ((x % CELL) + CELL) % CELL;
    const py = this.oy + ((y % CELL) + CELL) % CELL;
    const i = (py * ATLAS + px) * 4;
    const k = 255 / RANGE;
    this.data[i] = Math.max(0, Math.min(255, Math.round(r * k)));
    this.data[i + 1] = Math.max(0, Math.min(255, Math.round(g * k)));
    this.data[i + 2] = Math.max(0, Math.min(255, Math.round(b * k)));
    this.data[i + 3] = 255;
  }
  fill(v) {
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) this.set(x, y, v, v, v);
  }
  /* value-only write, keeping the cell monochrome */
  v(x, y, value) { this.set(x, y, value, value, value); }
  get(x, y) {
    const px = this.ox + ((x % CELL) + CELL) % CELL;
    const py = this.oy + ((y % CELL) + CELL) % CELL;
    return (this.data[(py * ATLAS + px) * 4] / 255) * RANGE;
  }
  mul(x, y, k) {
    const px = this.ox + ((x % CELL) + CELL) % CELL;
    const py = this.oy + ((y % CELL) + CELL) % CELL;
    const i = (py * ATLAS + px) * 4;
    for (let c = 0; c < 3; c++) {
      this.data[i + c] = Math.max(0, Math.min(255, Math.round(this.data[i + c] * k)));
    }
  }
}

/* Cheap seamless value noise on a 16x16 torus. */
function cellNoise(rng, scale) {
  const n = scale;
  const grid = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) grid[i] = rng();
  return (x, y) => {
    const fx = (x / CELL) * n, fy = (y / CELL) * n;
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const tx = fx - x0, ty = fy - y0;
    const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const g = (ix, iy) => grid[(((iy % n) + n) % n) * n + (((ix % n) + n) % n)];
    const a = g(x0, y0) + (g(x0 + 1, y0) - g(x0, y0)) * sx;
    const b = g(x0, y0 + 1) + (g(x0 + 1, y0 + 1) - g(x0, y0 + 1)) * sx;
    return a + (b - a) * sy;
  };
}

/* ---------------------------------------------------- generators */
const PAINTERS = {
  [TEX.FLAT]: (c) => c.fill(1.0),

  /* Grass: a base wobble with individual blades picked out. The
     blades are what you actually read at four-times upscale. */
  [TEX.GRASS]: (c, rng) => {
    const n = cellNoise(rng, 4), n2 = cellNoise(rng, 8);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      c.v(x, y, 0.80 + n(x, y) * 0.26 + n2(x, y) * 0.14);
    }
    for (let i = 0; i < 26; i++) {
      const x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      const h = 1 + Math.floor(rng() * 3);
      const dark = rng() < 0.55;
      for (let k = 0; k < h; k++) c.mul(x, y - k, dark ? 0.70 : 1.28);
    }
  },

  [TEX.GRASS_DRY]: (c, rng) => {
    const n = cellNoise(rng, 5);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      c.set(x, y, 0.94 + n(x, y) * 0.26, 0.91 + n(x, y) * 0.22, 0.80 + n(x, y) * 0.18);
    }
    for (let i = 0; i < 20; i++) {
      const x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      for (let k = 0; k < 2 + Math.floor(rng() * 2); k++) c.mul(x, y - k, rng() < 0.5 ? 0.74 : 1.26);
    }
  },

  [TEX.MOSS]: (c, rng) => {
    const n = cellNoise(rng, 3), n2 = cellNoise(rng, 8);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const v = 0.66 + n(x, y) * 0.46 + n2(x, y) * 0.26;
      c.set(x, y, v * 0.92, v * 1.08, v * 0.88);
    }
  },

  [TEX.DIRT]: (c, rng) => {
    const n = cellNoise(rng, 4), n2 = cellNoise(rng, 8);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      c.set(x, y, 0.82 + n(x, y) * 0.36, 0.79 + n(x, y) * 0.30 + n2(x, y) * 0.10, 0.74 + n(x, y) * 0.24);
    }
    /* pebbles */
    for (let i = 0; i < 9; i++) {
      const x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      c.mul(x, y, 1.38); c.mul(x + 1, y, 1.20); c.mul(x, y + 1, 0.70);
    }
  },

  [TEX.MUD]: (c, rng) => {
    const n = cellNoise(rng, 3);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const v = 0.74 + n(x, y) * 0.44;
      c.set(x, y, v, v * 0.95, v * 0.88);
    }
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      for (let k = -1; k <= 1; k++) c.mul(x + k, y, 1.18);
    }
  },

  /* Stone: flat with a few hairline cracks. */
  [TEX.STONE]: (c, rng) => {
    const n = cellNoise(rng, 4);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) c.v(x, y, 0.86 + n(x, y) * 0.26);
    for (let i = 0; i < 3; i++) {
      let x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      const len = 5 + Math.floor(rng() * 7);
      for (let k = 0; k < len; k++) {
        c.mul(x, y, 0.62);
        if (rng() < 0.6) x += rng() < 0.5 ? 1 : -1; else y += 1;
      }
    }
  },

  [TEX.ROCK]: (c, rng) => {
    const n = cellNoise(rng, 3), n2 = cellNoise(rng, 6);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      c.v(x, y, 0.74 + n(x, y) * 0.38 + n2(x, y) * 0.18);
    }
    /* facet lines give the blocky, chiselled read */
    for (let i = 0; i < 4; i++) {
      let x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      const dx = rng() < 0.5 ? 1 : -1;
      for (let k = 0; k < 10; k++) { c.mul(x, y, 0.60); c.mul(x, y - 1, 1.30); x += dx; y += rng() < 0.4 ? 1 : 0; }
    }
  },

  [TEX.GRAVEL]: (c, rng) => {
    c.fill(0.95);
    for (let i = 0; i < 40; i++) {
      const x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      const light = rng() < 0.5;
      c.mul(x, y, light ? 1.34 : 0.66);
      if (rng() < 0.4) c.mul(x + 1, y, light ? 1.14 : 0.85);
    }
  },

  [TEX.SAND]: (c, rng) => {
    const n = cellNoise(rng, 8);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      /* shallow ripples running one way */
      const ripple = Math.sin((x + n(x, y) * 4) * 0.9) * 0.05;
      c.set(x, y, 0.92 + ripple * 3.2 + n(x, y) * 0.22, 0.90 + ripple * 3.0 + n(x, y) * 0.20, 0.80 + ripple * 2.6);
    }
    for (let i = 0; i < 14; i++) c.mul(Math.floor(rng() * CELL), Math.floor(rng() * CELL), 1.14);
  },

  [TEX.SNOW]: (c, rng) => {
    const n = cellNoise(rng, 4);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const v = 0.88 + n(x, y) * 0.24;
      c.set(x, y, v * 0.98, v, v * 1.05);
    }
    for (let i = 0; i < 14; i++) c.mul(Math.floor(rng() * CELL), Math.floor(rng() * CELL), 1.40);
  },

  [TEX.ICE]: (c, rng) => {
    const n = cellNoise(rng, 3);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const v = 0.92 + n(x, y) * 0.14;
      c.set(x, y, v * 0.93, v * 1.0, v * 1.08);
    }
    for (let i = 0; i < 4; i++) {
      let x = Math.floor(rng() * CELL), y = 0;
      for (let k = 0; k < CELL; k++) { c.mul(x, y, 1.22); y++; if (rng() < 0.4) x += rng() < 0.5 ? 1 : -1; }
    }
  },

  [TEX.ASH]: (c, rng) => {
    const n = cellNoise(rng, 4), n2 = cellNoise(rng, 8);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const v = 0.78 + n(x, y) * 0.30 + n2(x, y) * 0.14;
      c.set(x, y, v * 1.02, v * 0.97, v * 1.05);
    }
    /* embers */
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      c.set(x, y, 1.5, 0.9, 1.1);
    }
  },

  /* Bark: vertical grooves. */
  [TEX.BARK]: (c, rng) => {
    const n = cellNoise(rng, 8);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const groove = Math.sin(x * 1.6 + n(x, y) * 3.0) * 0.5 + 0.5;
      const v = 0.68 + groove * 0.50 + n(x, y) * 0.14;
      c.set(x, y, v * 1.03, v * 0.98, v * 0.93);
    }
    for (let i = 0; i < 6; i++) {
      const x = Math.floor(rng() * CELL);
      const y = Math.floor(rng() * CELL);
      for (let k = 0; k < 3 + Math.floor(rng() * 4); k++) c.mul(x, y + k, 0.64);
    }
  },

  /* Plank: horizontal boards with a dark seam and nail heads. */
  [TEX.PLANK]: (c, rng) => {
    const n = cellNoise(rng, 8);
    for (let y = 0; y < CELL; y++) {
      const board = Math.floor(y / 4);
      const tone = 0.93 + (board % 2) * 0.09;
      for (let x = 0; x < CELL; x++) {
        const grain = Math.sin(x * 0.7 + board * 2.1 + n(x, y) * 2) * 0.05;
        const v = tone + grain * 2.0 + n(x, y) * 0.12;
        c.set(x, y, v * 1.04, v * 0.98, v * 0.9);
      }
      if (y % 4 === 0) for (let x = 0; x < CELL; x++) c.mul(x, y, 0.58);
    }
    for (let b = 0; b < 4; b++) {
      c.mul(1, b * 4 + 2, 0.70);
      c.mul(CELL - 2, b * 4 + 2, 0.70);
    }
  },

  /* Leaf clumps: blobs, not noise, so canopies read as foliage. */
  [TEX.LEAF]: (c, rng) => {
    c.fill(0.94);
    for (let i = 0; i < 22; i++) {
      const cx = Math.floor(rng() * CELL), cy = Math.floor(rng() * CELL);
      const r = 1 + Math.floor(rng() * 2);
      const k = rng() < 0.5 ? 0.80 : 1.22;
      for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
        if (x * x + y * y > r * r) continue;
        c.mul(cx + x, cy + y, k);
      }
    }
  },

  [TEX.FUR]: (c, rng) => {
    const n = cellNoise(rng, 6);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) c.v(x, y, 0.92 + n(x, y) * 0.14);
    for (let i = 0; i < 30; i++) {
      const x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      for (let k = 0; k < 2; k++) c.mul(x + k, y + k, rng() < 0.5 ? 0.86 : 1.12);
    }
  },

  [TEX.HIDE]: (c, rng) => {
    const n = cellNoise(rng, 4);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const v = 0.84 + n(x, y) * 0.30;
      c.set(x, y, v * 1.05, v * 0.96, v * 0.89);
    }
    for (let i = 0; i < 5; i++) {
      const cx = Math.floor(rng() * CELL), cy = Math.floor(rng() * CELL);
      for (let y = -1; y <= 1; y++) for (let x = -2; x <= 2; x++) c.mul(cx + x, cy + y, 1.26);
    }
  },

  [TEX.CLOTH]: (c, rng) => {
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const weave = ((x + y) % 2) ? 1.05 : 0.95;
      c.v(x, y, weave);
    }
    for (let i = 0; i < 6; i++) c.mul(Math.floor(rng() * CELL), Math.floor(rng() * CELL), 0.85);
  },

  [TEX.BONE]: (c, rng) => {
    const n = cellNoise(rng, 5);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const v = 0.97 + n(x, y) * 0.08;
      c.set(x, y, v * 1.02, v, v * 0.94);
    }
    for (let i = 0; i < 4; i++) {
      let x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      for (let k = 0; k < 5; k++) { c.mul(x, y, 0.84); y++; }
    }
  },

  /* Metal plating: panel seams and rivets. */
  [TEX.METAL]: (c, rng) => {
    const n = cellNoise(rng, 8);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      c.v(x, y, 0.92 + n(x, y) * 0.16);
    }
    for (let x = 0; x < CELL; x++) { c.mul(x, 0, 0.62); c.mul(x, CELL - 1, 1.24); }
    for (let y = 0; y < CELL; y++) { c.mul(0, y, 0.62); c.mul(CELL - 1, y, 1.18); }
    for (const [rx, ry] of [[3, 3], [12, 3], [3, 12], [12, 12]]) {
      c.mul(rx, ry, 1.30); c.mul(rx + 1, ry, 1.12); c.mul(rx, ry + 1, 0.82);
    }
  },

  [TEX.PANEL]: (c, rng) => {
    const n = cellNoise(rng, 8);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) c.v(x, y, 0.96 + n(x, y) * 0.07);
    for (let y = 0; y < CELL; y++) { c.mul(7, y, 0.78); c.mul(8, y, 1.10); }
    for (let x = 0; x < CELL; x++) { c.mul(x, 5, 0.80); c.mul(x, 11, 0.80); }
  },

  [TEX.CIRCUIT]: (c, rng) => {
    c.fill(0.88);
    for (let i = 0; i < 6; i++) {
      let x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      let horiz = rng() < 0.5;
      for (let k = 0; k < 10; k++) {
        c.set(x, y, 0.75, 1.35, 1.55);
        if (horiz) x++; else y++;
        if (rng() < 0.25) horiz = !horiz;
      }
      c.set(x, y, 1.2, 1.8, 2.0);
    }
  },

  [TEX.RUST]: (c, rng) => {
    const n = cellNoise(rng, 4), n2 = cellNoise(rng, 8);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const r = n(x, y) * 0.8 + n2(x, y) * 0.2;
      c.set(x, y, 0.74 + r * 0.72, 0.72 + r * 0.42, 0.68 + r * 0.18);
    }
    for (let i = 0; i < 12; i++) {
      const x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      c.mul(x, y, 0.80);
    }
  },

  [TEX.BRICK]: (c, rng) => {
    for (let y = 0; y < CELL; y++) {
      const row = Math.floor(y / 4);
      const offset = (row % 2) * 4;
      for (let x = 0; x < CELL; x++) {
        const mortar = (y % 4 === 0) || ((x + offset) % 8 === 0);
        const v = mortar ? 0.58 : 0.94 + ((x * 7 + y * 13) % 5) * 0.045;
        c.v(x, y, v);
      }
    }
  },

  [TEX.TILE]: (c, rng) => {
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const edge = (x % 8 === 0) || (y % 8 === 0);
      const inner = (x % 8 === 7) || (y % 8 === 7);
      c.v(x, y, edge ? 0.64 : inner ? 1.16 : 0.96 + (((x >> 3) + (y >> 3)) % 2) * 0.07);
    }
    for (let i = 0; i < 8; i++) c.mul(Math.floor(rng() * CELL), Math.floor(rng() * CELL), 0.9);
  },

  [TEX.THATCH]: (c, rng) => {
    const n = cellNoise(rng, 8);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const straw = Math.sin((x * 0.8 + y * 2.4) + n(x, y) * 3) * 0.5 + 0.5;
      const v = 0.70 + straw * 0.50;
      c.set(x, y, v * 1.05, v * 0.99, v * 0.86);
    }
  },

  [TEX.CRYSTAL]: (c, rng) => {
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const band = Math.sin((x + y) * 0.8) * 0.5 + 0.5;
      const v = 0.72 + band * 0.56;
      c.set(x, y, v * 0.97, v * 0.94, v * 1.08);
    }
    for (let i = 0; i < 6; i++) {
      let x = Math.floor(rng() * CELL), y = Math.floor(rng() * CELL);
      for (let k = 0; k < 6; k++) { c.mul(x, y, 1.25); x++; y++; }
    }
  },

  [TEX.WATER]: (c, rng) => {
    const n = cellNoise(rng, 4);
    for (let y = 0; y < CELL; y++) for (let x = 0; x < CELL; x++) {
      const wave = Math.sin(x * 0.7 + n(x, y) * 4) * 0.5 + 0.5;
      const v = 0.82 + wave * 0.30;
      c.set(x, y, v * 0.92, v * 1.0, v * 1.08);
    }
    for (let i = 0; i < 6; i++) {
      const y = Math.floor(rng() * CELL);
      for (let x = 0; x < 4 + Math.floor(rng() * 5); x++) c.mul(Math.floor(rng() * CELL) + x, y, 1.20);
    }
  },
};

/* Ore is stone with coloured flecks, so it shares a base. */
function makeOre(c, rng, tint) {
  PAINTERS[TEX.ROCK](c, rng);
  for (let i = 0; i < 16; i++) {
    const cx = Math.floor(rng() * CELL), cy = Math.floor(rng() * CELL);
    const r = rng() < 0.4 ? 1 : 0;
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
      const base = c.get(cx + x, cy + y);
      c.set(cx + x, cy + y, base * tint[0], base * tint[1], base * tint[2]);
    }
  }
}
PAINTERS[TEX.ORE_IRON] = (c, rng) => makeOre(c, rng, [1.30, 1.12, 0.92]);
PAINTERS[TEX.ORE_GOLD] = (c, rng) => makeOre(c, rng, [1.55, 1.25, 0.55]);
PAINTERS[TEX.ORE_ESSENCE] = (c, rng) => makeOre(c, rng, [1.20, 0.85, 1.75]);

let atlasTexture = null;

export function getDetailAtlas() {
  if (atlasTexture) return atlasTexture;
  const data = new Uint8Array(ATLAS * ATLAS * 4);
  data.fill(Math.round(255 / RANGE));       /* a neutral 1.0 everywhere */
  for (const [index, paint] of Object.entries(PAINTERS)) {
    const rng = makeRng(0x5eed + Number(index) * 7919);
    paint(new Cellf(data, Number(index)), rng);
  }
  const tex = new THREE.DataTexture(data, ATLAS, ATLAS, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;      /* these are multipliers */
  tex.needsUpdate = true;
  atlasTexture = tex;
  return tex;
}
