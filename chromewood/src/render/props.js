/* ============================================================
   props.js - what grows and rusts in the Chromewood

   Every recipe appends into two builders: `b` for lit geometry
   and `g` for self-lit geometry whose vertex colours run past 1.0
   so the bloom pass picks them up. Recipes are deterministic in
   the tile's variant byte, so the same tile looks the same on
   every machine in a session.
   ============================================================ */

import { PROP, BIOME } from '../world/worldgen.js';

/* Ground colours per biome: [topA, topB, side, sideDark]. The two
   tops alternate on a checker to give the tile grid its shimmer. */
export const GROUND_COLORS = {
  [BIOME.VERDANT]: [0x5cc154, 0x53b34c, 0x7a4f37, 0x5c3928],
  [BIOME.BLOOM]:   [0x52bd96, 0x49ae89, 0x6a4a7d, 0x4c3359],
  [BIOME.SCRAP]:   [0x8fa963, 0x849d5b, 0x646b78, 0x474d58],
  [BIOME.ASH]:     [0x5a5068, 0x52485f, 0x3c3348, 0x2a2434],
  [BIOME.PLAZA]:   [0xb3a9bd, 0xa89db3, 0x7d7488, 0x5d5566],
};

export const WATER_COLOR = 0x2fb8c9;
export const WATER_GLOW = 0x1d6f80;

/* Deterministic per-prop noise from the tile's variant byte. */
function vrand(variant, salt) {
  let h = (variant * 2654435761 + salt * 40503) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const lerpHex = (a, b, t) => {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16)
       | (Math.round(ag + (bg - ag) * t) << 8)
       | Math.round(ab + (bb - ab) * t);
};

/* Colours pushed past 1.0 bloom; the builder takes a hex, so the
   glow builder gets a bright hex and an intensity scale applied to
   its vertex colours afterwards. */
const GLOW_SCALE = 2.6;

export function propRadius(prop) {
  switch (prop) {
    case PROP.TREE_PINE: case PROP.TREE_BLOOM: return 0.34;
    case PROP.DEAD_TREE: return 0.26;
    case PROP.BOULDER: return 0.42;
    case PROP.CRYSTAL: case PROP.RIFT_SHARD: return 0.36;
    case PROP.RUIN_WALL: return 0.46;
    case PROP.RUIN_PILLAR: return 0.30;
    case PROP.PYLON: return 0.30;
    case PROP.ANTENNA: return 0.22;
    case PROP.CRATE: return 0.34;
    default: return 0;
  }
}

/* Props that deserve a light source of their own at night.
   Returns {color, intensity, range, y} or null. */
export function propLight(prop, variant) {
  switch (prop) {
    case PROP.CRYSTAL: return { color: 0xb07bff, intensity: 1.5, range: 5.5, y: 0.8 };
    case PROP.RIFT_SHARD: return { color: 0xff4fd8, intensity: 1.7, range: 5.0, y: 0.7 };
    case PROP.PYLON: return { color: 0x3fe0ff, intensity: 2.0, range: 7.0, y: 2.1 };
    case PROP.LAMP: return { color: 0xffb03a, intensity: 2.2, range: 8.0, y: 1.6 };
    case PROP.CONDUIT: return { color: 0x3fe0ff, intensity: 0.8, range: 3.4, y: 0.25 };
    case PROP.TREE_BLOOM: return { color: 0x8effc9, intensity: 0.9, range: 4.2, y: 1.5 };
    default: return null;
  }
}

/* ------------------------------------------------------------ recipes */
export function buildProp(b, g, prop, x, y, z, variant, biome) {
  const r1 = vrand(variant, 1), r2 = vrand(variant, 2), r3 = vrand(variant, 3);
  /* Jitter inside the tile so rows of props never line up. */
  const jx = x + (r1 - 0.5) * 0.44;
  const jz = z + (r2 - 0.5) * 0.44;
  const spin = r3 * Math.PI * 2;

  switch (prop) {
    case PROP.TREE_PINE: {
      const h = 0.82 + r1 * 0.55;
      const trunk = lerpHex(0x6b4630, 0x845939, r2);
      b.at(jx, y, jz).rot(spin).sc(1);
      b.taper(0.2, 0.42 * h, 0.2, 0.72, trunk, { topColor: lerpHex(trunk, 0x9a6b45, 0.4) });
      const dark = lerpHex(0x2f7a3c, 0x3d9147, r1);
      const lit = lerpHex(0x63c95e, 0x86dd6b, r2);
      const rad = 0.58 + r2 * 0.14;
      b.cone(rad, 0.72 * h, 7, dark, { yOff: 0.30 * h, topColor: lerpHex(dark, lit, 0.5) });
      b.cone(rad * 0.82, 0.66 * h, 7, lerpHex(dark, lit, 0.25), { yOff: 0.72 * h, topColor: lit });
      b.cone(rad * 0.58, 0.58 * h, 6, lerpHex(dark, lit, 0.55), { yOff: 1.16 * h, topColor: lerpHex(lit, 0xc6f59a, 0.5) });
      b.sc(1).rot(0);
      break;
    }

    case PROP.TREE_BLOOM: {
      const h = 0.9 + r1 * 0.5;
      b.at(jx, y, jz).rot(spin);
      b.taper(0.18, 0.5 * h, 0.18, 0.7, 0x6a4a7d, { topColor: 0x8b64a3 });
      const leaf = lerpHex(0x4fc99a, 0x76e0b4, r2);
      b.cone(0.62, 0.58 * h, 8, leaf, { yOff: 0.42 * h, topColor: 0x9df0cd, flatten: 1.0 });
      b.cone(0.44, 0.44 * h, 7, lerpHex(leaf, 0xa8f2d4, 0.4), { yOff: 0.86 * h, topColor: 0xc6ffe6 });
      /* Bloom-lights hanging in the canopy. */
      for (let i = 0; i < 3; i++) {
        const a = spin + i * 2.094;
        const rr = 0.30 + vrand(variant, 10 + i) * 0.22;
        g.at(jx + Math.cos(a) * rr, y + 0.62 * h + vrand(variant, 20 + i) * 0.4, jz + Math.sin(a) * rr).rot(0);
        g.box(0.13, 0.13, 0.13, 0xff9ee8, { centered: true });
      }
      b.rot(0);
      break;
    }

    case PROP.DEAD_TREE: {
      const h = 0.9 + r1 * 0.7;
      const bark = lerpHex(0x40374a, 0x55485f, r2);
      b.at(jx, y, jz).rot(spin);
      b.taper(0.19, 1.0 * h, 0.19, 0.42, bark, { topColor: lerpHex(bark, 0x6d5d78, 0.5), twist: 0.4 });
      b.at(jx + 0.20, y + 0.62 * h, jz - 0.10).rot(spin + 0.8);
      b.taper(0.10, 0.36 * h, 0.10, 0.4, bark, { twist: 0.6 });
      b.at(jx - 0.18, y + 0.75 * h, jz + 0.12).rot(spin - 0.7);
      b.taper(0.09, 0.30 * h, 0.09, 0.4, bark, { twist: -0.5 });
      b.rot(0);
      break;
    }

    case PROP.STUMP: {
      b.at(jx, y, jz).rot(spin);
      b.taper(0.34, 0.20, 0.34, 0.88, 0x6b4630, { topColor: 0xa07c52 });
      b.rot(0);
      break;
    }

    case PROP.ROCK: {
      const s = 0.55 + r1 * 0.45;
      const col = biome === BIOME.ASH ? lerpHex(0x4a4356, 0x625a6e, r2) : lerpHex(0x8d95a4, 0xaab2bf, r2);
      b.at(jx, y, jz).rot(spin);
      b.taper(0.34 * s, 0.22 * s, 0.30 * s, 0.7, col, { topColor: lerpHex(col, 0xd6dce6, 0.35), twist: 0.5 });
      b.rot(0);
      break;
    }

    case PROP.BOULDER: {
      const s = 0.9 + r1 * 0.5;
      const col = biome === BIOME.ASH ? 0x554d61 : lerpHex(0x848d9c, 0x9fa7b5, r2);
      b.at(jx, y, jz).rot(spin);
      b.taper(0.72 * s, 0.34 * s, 0.66 * s, 0.82, col, { topColor: lerpHex(col, 0xc8d0dc, 0.3), twist: 0.3 });
      b.at(jx + 0.06, y + 0.34 * s, jz - 0.04).rot(spin + 1.1);
      b.taper(0.54 * s, 0.30 * s, 0.50 * s, 0.6, lerpHex(col, 0xffffff, 0.08),
        { topColor: lerpHex(col, 0xe0e6f0, 0.4), twist: -0.4 });
      /* Moss on top, but only where things still grow. */
      if (biome !== BIOME.ASH && r3 > 0.45) {
        b.at(jx + 0.06, y + 0.60 * s, jz - 0.04).rot(spin);
        b.ground(0.40 * s, 0.36 * s, 0x4fae52, { yOff: 0.005 });
      }
      b.rot(0);
      break;
    }

    case PROP.CRYSTAL: {
      const s = 0.8 + r1 * 0.6;
      const core = lerpHex(0x8b5cf0, 0xb07bff, r2);
      b.at(jx, y, jz).rot(spin);
      b.crystal(0.16 * s, 1.0 * s, core, { sides: 5, tilt: (r3 - 0.5) * 0.22, tipColor: 0xd9c0ff });
      b.at(jx + 0.22, y, jz + 0.12).rot(spin + 1.9);
      b.crystal(0.10 * s, 0.56 * s, core, { sides: 5, tilt: 0.16, tipColor: 0xd9c0ff });
      b.at(jx - 0.18, y, jz + 0.18).rot(spin - 1.2);
      b.crystal(0.08 * s, 0.40 * s, core, { sides: 4, tilt: -0.2, tipColor: 0xd9c0ff });
      /* Inner light: a thin bright shaft inside the big prism. */
      g.at(jx, y + 0.1, jz).rot(spin);
      g.crystal(0.07 * s, 0.82 * s, 0xc9a6ff, { sides: 5, tipColor: 0xffffff });
      b.rot(0); g.rot(0);
      break;
    }

    case PROP.RIFT_SHARD: {
      const s = 0.9 + r1 * 0.7;
      b.at(jx, y - 0.05, jz).rot(spin);
      b.crystal(0.19 * s, 1.15 * s, 0x2a1436, { sides: 4, tilt: (r2 - 0.5) * 0.5, tipColor: 0x6b2a63 });
      g.at(jx, y + 0.05, jz).rot(spin);
      g.crystal(0.09 * s, 0.92 * s, 0xff4fd8, { sides: 4, tilt: (r2 - 0.5) * 0.5, tipColor: 0xffc2f0 });
      b.rot(0); g.rot(0);
      break;
    }

    case PROP.GRASS: {
      const tint = biome === BIOME.ASH ? 0x4a5545 : biome === BIOME.BLOOM ? 0x3fae82 : 0x35893a;
      const tip = biome === BIOME.ASH ? 0x6b7a63 : biome === BIOME.BLOOM ? 0x6fd9ab : 0x63c258;
      b.at(jx, y, jz).rot(spin);
      b.cross(0.46 + r1 * 0.2, 0.30 + r2 * 0.18, tint, { tipColor: tip });
      b.rot(0);
      break;
    }

    case PROP.FLOWER: {
      const petal = biome === BIOME.BLOOM
        ? [0xff8ae0, 0xb07bff, 0x7ee8ff][Math.floor(r1 * 3)]
        : [0xffd75e, 0xff7b7b, 0xf0f0ff, 0xb07bff][Math.floor(r1 * 4)];
      b.at(jx, y, jz).rot(spin);
      b.cross(0.26, 0.20, 0x3d8f45, { tipColor: 0x63c258 });
      b.at(jx, y + 0.20, jz);
      b.box(0.12, 0.09, 0.12, petal, { topColor: lerpHex(petal, 0xffffff, 0.45) });
      if (biome === BIOME.BLOOM) {
        g.at(jx, y + 0.24, jz);
        g.box(0.07, 0.05, 0.07, petal, { centered: true });
      }
      b.rot(0);
      break;
    }

    case PROP.MUSHROOM: {
      const capCol = biome === BIOME.BLOOM ? 0x8be3ff : biome === BIOME.ASH ? 0x8f6f9e : 0xd9503f;
      const n = 1 + Math.floor(r3 * 3);
      for (let i = 0; i < n; i++) {
        const ox = (vrand(variant, 30 + i) - 0.5) * 0.4;
        const oz = (vrand(variant, 40 + i) - 0.5) * 0.4;
        const s = 0.6 + vrand(variant, 50 + i) * 0.6;
        b.at(jx + ox, y, jz + oz).rot(spin + i);
        b.box(0.08 * s, 0.17 * s, 0.08 * s, 0xf0e4d0, { topColor: 0xfff6e8 });
        b.at(jx + ox, y + 0.16 * s, jz + oz);
        b.cone(0.17 * s, 0.14 * s, 6, capCol, { topColor: lerpHex(capCol, 0xffffff, 0.4) });
        if (biome === BIOME.BLOOM) {
          g.at(jx + ox, y + 0.17 * s, jz + oz);
          g.box(0.10 * s, 0.03, 0.10 * s, capCol, { centered: true });
        }
        b.rot(0);
      }
      break;
    }

    case PROP.REED: {
      for (let i = 0; i < 3; i++) {
        const ox = (vrand(variant, 60 + i) - 0.5) * 0.5;
        const oz = (vrand(variant, 70 + i) - 0.5) * 0.5;
        b.at(jx + ox, y, jz + oz).rot(spin + i * 1.3);
        b.cross(0.12, 0.42 + vrand(variant, 80 + i) * 0.3, 0x3f7a5c, { tipColor: 0x7fc9a0 });
        b.rot(0);
      }
      break;
    }

    case PROP.RUIN_WALL: {
      const h = 0.55 + r1 * 0.75;
      const col = lerpHex(0x7f8794, 0x99a1ae, r2);
      b.at(jx, y, jz).rot(Math.round(spin / (Math.PI / 2)) * (Math.PI / 2) + (r3 - 0.5) * 0.12);
      b.box(0.95, h, 0.32, col, { topColor: lerpHex(col, 0xc9d1dc, 0.4) });
      /* A broken shoulder reads better than a clean rectangle. */
      b.at(jx + 0.3, y + h, jz).box(0.34, 0.18 + r3 * 0.2, 0.32, col, { topColor: 0xb6bec9 });
      if (r2 > 0.55) {
        g.at(jx, y + h * 0.55, jz - 0.17);
        g.box(0.5, 0.05, 0.02, 0x3fe0ff, { centered: true });
      }
      b.rot(0);
      break;
    }

    case PROP.RUIN_PILLAR: {
      const h = 0.9 + r1 * 0.9;
      b.at(jx, y, jz).rot(spin * 0.2);
      b.taper(0.30, h, 0.30, 0.86, 0x8d95a4, { topColor: 0xbac2ce });
      b.at(jx, y + h, jz).box(0.42, 0.14, 0.42, 0x9aa2b0, { topColor: 0xc6cdd8 });
      b.rot(0);
      break;
    }

    case PROP.PYLON: {
      const h = 1.8 + r1 * 0.9;
      b.at(jx, y, jz).rot(spin);
      b.taper(0.40, h * 0.78, 0.40, 0.40, 0x59616f, { topColor: 0x7b8493, twist: 0.25 });
      b.at(jx, y + h * 0.78, jz).box(0.26, h * 0.22, 0.26, 0x6d7583, { topColor: 0x99a2b0 });
      g.at(jx, y + h * 0.74, jz).rot(spin);
      g.box(0.46, 0.07, 0.46, 0x3fe0ff, { centered: true });
      g.at(jx, y + h, jz);
      g.box(0.16, 0.16, 0.16, 0x9af2ff, { centered: true });
      b.rot(0); g.rot(0);
      break;
    }

    case PROP.CONDUIT: {
      b.at(jx, y, jz).rot(Math.round(spin / (Math.PI / 2)) * (Math.PI / 2));
      b.box(0.86, 0.14, 0.34, 0x515a68, { topColor: 0x6d7684 });
      g.at(jx, y + 0.145, jz).rot(Math.round(spin / (Math.PI / 2)) * (Math.PI / 2));
      g.box(0.70, 0.03, 0.10, 0x3fe0ff, { centered: true });
      b.rot(0); g.rot(0);
      break;
    }

    case PROP.SCRAP_PILE: {
      const n = 3 + Math.floor(r1 * 3);
      for (let i = 0; i < n; i++) {
        const ox = (vrand(variant, 90 + i) - 0.5) * 0.5;
        const oz = (vrand(variant, 100 + i) - 0.5) * 0.5;
        const s = 0.5 + vrand(variant, 110 + i) * 0.6;
        const col = [0xb8593a, 0x8a5b47, 0x6d7583, 0x94622f][Math.floor(vrand(variant, 120 + i) * 4)];
        b.at(jx + ox, y + i * 0.07, jz + oz).rot(vrand(variant, 130 + i) * 3.1);
        b.box(0.3 * s, 0.16 * s, 0.24 * s, col, { topColor: lerpHex(col, 0xffffff, 0.3) });
        b.rot(0);
      }
      break;
    }

    case PROP.ANTENNA: {
      const h = 2.2 + r1 * 1.2;
      b.at(jx, y, jz).rot(spin);
      b.taper(0.22, h, 0.22, 0.28, 0x656d7b, { topColor: 0x8a93a1, twist: 0.5 });
      for (let i = 1; i <= 2; i++) {
        b.at(jx, y + h * (0.45 + i * 0.2), jz).rot(spin + i * 0.6);
        b.box(0.5, 0.04, 0.05, 0x7a8391, { centered: true });
      }
      g.at(jx, y + h + 0.06, jz);
      g.box(0.1, 0.1, 0.1, 0xff4f4f, { centered: true });
      b.rot(0);
      break;
    }

    case PROP.CRATE: {
      const s = 0.8 + r1 * 0.3;
      b.at(jx, y, jz).rot(spin * 0.3);
      b.box(0.56 * s, 0.5 * s, 0.56 * s, 0x8a6a45, { topColor: 0xb08c5e });
      b.at(jx, y + 0.5 * s * 0.5, jz).rot(spin * 0.3);
      b.box(0.60 * s, 0.07, 0.60 * s, 0x5f4a33, { centered: true });
      b.rot(0);
      break;
    }

    case PROP.LAMP: {
      b.at(jx, y, jz);
      b.taper(0.12, 1.5, 0.12, 0.7, 0x4e5663, { topColor: 0x6d7583 });
      b.at(jx, y + 1.5, jz).box(0.3, 0.2, 0.3, 0x59616f, { topColor: 0x7b8493 });
      g.at(jx, y + 1.52, jz);
      g.box(0.22, 0.12, 0.22, 0xffc45e, { centered: true });
      break;
    }

    default: break;
  }
}

export { GLOW_SCALE, vrand, lerpHex };
