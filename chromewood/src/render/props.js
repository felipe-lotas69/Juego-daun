/* ============================================================
   props.js - what grows, rusts and outcrops

   Every recipe appends into two builders: `b` for lit geometry and
   `g` for self-lit geometry whose vertex colours run past 1.0 so
   the bloom pass picks them up. Recipes are deterministic in the
   tile's variant byte, so a tile looks the same on every machine.
   ============================================================ */

import { PROP, BIOME } from '../world/worldgen.js';
import { TEX } from './textures.js';

/* Ground: [topA, topB, cliffFace, cliffDark] and [topTex, sideTex].
   The two tops alternate on a checker, which at this resolution
   reads as the tile grid rather than as stripes. */
export const GROUND_COLORS = {
  [BIOME.OCEAN]:    [0x4a6a78, 0x44626f, 0x6a6352, 0x4c4839],
  [BIOME.BEACH]:    [0xd9c48c, 0xcfb981, 0xb09a68, 0x8a7750],
  [BIOME.MEADOW]:   [0x74c85a, 0x6bbd54, 0x8a6a45, 0x644c32],
  [BIOME.FOREST]:   [0x4fae52, 0x489f4b, 0x7a4f37, 0x5c3928],
  [BIOME.PINE]:     [0x3f8f63, 0x39835a, 0x6b5744, 0x4e3f31],
  [BIOME.HIGHLAND]: [0x8e8a80, 0x847f76, 0x6d6960, 0x4f4c45],
  [BIOME.SNOW]:     [0xe4edf5, 0xd7e2ec, 0x93a0ad, 0x6e7a86],
  [BIOME.MARSH]:    [0x6a7a48, 0x5f6e41, 0x584a34, 0x3f3626],
  [BIOME.BLOOM]:    [0x52bd96, 0x49ae89, 0x6a4a7d, 0x4c3359],
  [BIOME.SCRAP]:    [0x8fa963, 0x849d5b, 0x646b78, 0x474d58],
  [BIOME.ASH]:      [0x5a5068, 0x52485f, 0x3c3348, 0x2a2434],
  [BIOME.PLAZA]:    [0xb3a9bd, 0xa89db3, 0x7d7488, 0x5d5566],
};

export const GROUND_TEX = {
  [BIOME.OCEAN]:    [TEX.SAND, TEX.ROCK],
  [BIOME.BEACH]:    [TEX.SAND, TEX.SAND],
  [BIOME.MEADOW]:   [TEX.GRASS, TEX.DIRT],
  [BIOME.FOREST]:   [TEX.GRASS, TEX.DIRT],
  [BIOME.PINE]:     [TEX.GRASS, TEX.ROCK],
  [BIOME.HIGHLAND]: [TEX.GRAVEL, TEX.ROCK],
  [BIOME.SNOW]:     [TEX.SNOW, TEX.ICE],
  [BIOME.MARSH]:    [TEX.MUD, TEX.MUD],
  [BIOME.BLOOM]:    [TEX.MOSS, TEX.STONE],
  [BIOME.SCRAP]:    [TEX.GRASS_DRY, TEX.GRAVEL],
  [BIOME.ASH]:      [TEX.ASH, TEX.ROCK],
  [BIOME.PLAZA]:    [TEX.TILE, TEX.STONE],
};

export const WATER_COLOR = 0x2f9ec9;
export const DEEP_COLOR = 0x1c5a80;
const GLOW_SCALE = 2.6;

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

export function propRadius(prop) {
  switch (prop) {
    case PROP.TREE_PINE: case PROP.TREE_OAK: case PROP.TREE_BLOOM: case PROP.TREE_SNOW: return 0.34;
    case PROP.TREE_BIRCH: return 0.28;
    case PROP.TREE_DEAD: return 0.24;
    case PROP.BOULDER: return 0.42;
    case PROP.ROCK_TALL: return 0.38;
    case PROP.CRYSTAL: case PROP.RIFT_SHARD: return 0.36;
    case PROP.ORE_COPPER: case PROP.ORE_IRON: case PROP.ORE_GOLD: case PROP.ORE_ESSENCE: return 0.40;
    case PROP.RUIN_WALL: return 0.46;
    case PROP.RUIN_PILLAR: return 0.30;
    case PROP.PYLON: return 0.30;
    case PROP.ANTENNA: return 0.22;
    case PROP.CRATE: return 0.34;
    case PROP.ICE_SPIKE: return 0.30;
    default: return 0;
  }
}

/* Props worth a light of their own after dark. */
export function propLight(prop) {
  switch (prop) {
    case PROP.CRYSTAL: return { color: 0xb07bff, intensity: 1.5, range: 5.5, y: 0.8 };
    case PROP.RIFT_SHARD: return { color: 0xff4fd8, intensity: 1.7, range: 5.0, y: 0.7 };
    case PROP.ORE_ESSENCE: return { color: 0xb07bff, intensity: 1.1, range: 4.0, y: 0.5 };
    case PROP.PYLON: return { color: 0x3fe0ff, intensity: 2.0, range: 7.0, y: 2.1 };
    case PROP.LAMP: return { color: 0xffb03a, intensity: 2.2, range: 8.0, y: 1.6 };
    case PROP.CONDUIT: return { color: 0x3fe0ff, intensity: 0.8, range: 3.4, y: 0.25 };
    case PROP.TREE_BLOOM: return { color: 0x8effc9, intensity: 0.9, range: 4.2, y: 1.5 };
    case PROP.MUSHROOM: return null;
    default: return null;
  }
}

/* ------------------------------------------------------------ recipes */
export function buildProp(b, g, prop, x, y, z, variant, biome) {
  const r1 = vrand(variant, 1), r2 = vrand(variant, 2), r3 = vrand(variant, 3);
  const jx = x + (r1 - 0.5) * 0.44;
  const jz = z + (r2 - 0.5) * 0.44;
  const spin = r3 * Math.PI * 2;
  const snowy = biome === BIOME.SNOW;

  switch (prop) {
    /* ---------------------------------------------------- trees */
    case PROP.TREE_PINE: {
      const h = 0.85 + r1 * 0.6;
      const trunk = lerpHex(0x6b4630, 0x845939, r2);
      b.at(jx, y, jz).rot(spin);
      b.taper(0.2, 0.44 * h, 0.2, 0.72, trunk, { topColor: lerpHex(trunk, 0x9a6b45, 0.4), tex: TEX.BARK });
      const dark = lerpHex(0x2f7a3c, 0x3d9147, r1);
      const lit = lerpHex(0x63c95e, 0x86dd6b, r2);
      const rad = 0.58 + r2 * 0.14;
      b.cone(rad, 0.72 * h, 7, dark, { yOff: 0.30 * h, topColor: lerpHex(dark, lit, 0.5), tex: TEX.LEAF });
      b.cone(rad * 0.82, 0.66 * h, 7, lerpHex(dark, lit, 0.25), { yOff: 0.72 * h, topColor: lit, tex: TEX.LEAF });
      b.cone(rad * 0.58, 0.58 * h, 6, lerpHex(dark, lit, 0.55), { yOff: 1.16 * h, topColor: lerpHex(lit, 0xc6f59a, 0.5), tex: TEX.LEAF });
      b.rot(0);
      break;
    }

    /* A broad round crown, built from two offset cones so it does
       not read as another conifer. */
    case PROP.TREE_OAK: {
      const h = 0.95 + r1 * 0.55;
      const trunk = lerpHex(0x63432c, 0x7a5437, r2);
      b.at(jx, y, jz).rot(spin);
      b.taper(0.26, 0.62 * h, 0.26, 0.66, trunk, { topColor: lerpHex(trunk, 0x9a6b45, 0.4), tex: TEX.BARK });
      const dark = lerpHex(0x357f33, 0x43913d, r1);
      const lit = lerpHex(0x6cc45c, 0x8fd96d, r2);
      b.taper(1.15, 0.42 * h, 1.05, 0.72, dark, { yOff: 0.52 * h, topColor: lerpHex(dark, lit, 0.35), tex: TEX.LEAF, twist: 0.3 });
      b.cone(0.72, 0.52 * h, 8, lerpHex(dark, lit, 0.3), { yOff: 0.90 * h, topColor: lit, tex: TEX.LEAF });
      b.at(jx - 0.28, y + 0.66 * h, jz + 0.2).rot(spin + 1.1);
      b.taper(0.62, 0.30 * h, 0.58, 0.7, lerpHex(dark, lit, 0.15), { topColor: lit, tex: TEX.LEAF });
      b.rot(0);
      break;
    }

    case PROP.TREE_BIRCH: {
      const h = 1.05 + r1 * 0.55;
      b.at(jx, y, jz).rot(spin);
      b.taper(0.15, 0.80 * h, 0.15, 0.8, 0xdfe3e0, { topColor: 0xf2f5f2, tex: TEX.BARK });
      /* The dark bands are what makes a birch a birch. */
      for (let i = 0; i < 3; i++) {
        b.at(jx, y + (0.2 + i * 0.22) * h, jz).rot(spin + i);
        b.box(0.17, 0.045, 0.17, 0x3a3a38, { centered: true, tex: TEX.FLAT });
      }
      const leaf = lerpHex(0x7ecb52, 0x9bdc6b, r2);
      b.at(jx, y, jz).rot(spin);
      b.cone(0.52, 0.55 * h, 7, leaf, { yOff: 0.72 * h, topColor: lerpHex(leaf, 0xd2f39a, 0.5), tex: TEX.LEAF });
      b.cone(0.38, 0.42 * h, 6, lerpHex(leaf, 0xd2f39a, 0.3), { yOff: 1.05 * h, topColor: 0xdcf7ab, tex: TEX.LEAF });
      b.rot(0);
      break;
    }

    case PROP.TREE_SNOW: {
      const h = 0.9 + r1 * 0.5;
      b.at(jx, y, jz).rot(spin);
      b.taper(0.2, 0.40 * h, 0.2, 0.7, 0x4a3a30, { topColor: 0x63503f, tex: TEX.BARK });
      const dark = 0x2c5c48, lit = 0x437a5e;
      b.cone(0.56, 0.70 * h, 7, dark, { yOff: 0.28 * h, topColor: lit, tex: TEX.LEAF });
      b.cone(0.44, 0.62 * h, 7, lit, { yOff: 0.72 * h, topColor: 0x59907a, tex: TEX.LEAF });
      /* Snow load, sitting on the branches. */
      b.cone(0.46, 0.22, 7, 0xe8f1f8, { yOff: 0.62 * h, topColor: 0xffffff, tex: TEX.SNOW });
      b.cone(0.34, 0.30, 6, 0xf2f8ff, { yOff: 1.10 * h, topColor: 0xffffff, tex: TEX.SNOW });
      b.rot(0);
      break;
    }

    case PROP.TREE_BLOOM: {
      const h = 0.9 + r1 * 0.5;
      b.at(jx, y, jz).rot(spin);
      b.taper(0.18, 0.5 * h, 0.18, 0.7, 0x6a4a7d, { topColor: 0x8b64a3, tex: TEX.BARK });
      const leaf = lerpHex(0x4fc99a, 0x76e0b4, r2);
      b.cone(0.62, 0.58 * h, 8, leaf, { yOff: 0.42 * h, topColor: 0x9df0cd, tex: TEX.LEAF });
      b.cone(0.44, 0.44 * h, 7, lerpHex(leaf, 0xa8f2d4, 0.4), { yOff: 0.86 * h, topColor: 0xc6ffe6, tex: TEX.LEAF });
      for (let i = 0; i < 3; i++) {
        const a = spin + i * 2.094;
        const rr = 0.30 + vrand(variant, 10 + i) * 0.22;
        g.at(jx + Math.cos(a) * rr, y + 0.62 * h + vrand(variant, 20 + i) * 0.4, jz + Math.sin(a) * rr).rot(0);
        g.box(0.13, 0.13, 0.13, 0xff9ee8, { centered: true });
      }
      b.rot(0);
      break;
    }

    case PROP.TREE_DEAD: {
      const h = 0.9 + r1 * 0.7;
      const bark = lerpHex(0x40374a, 0x55485f, r2);
      b.at(jx, y, jz).rot(spin);
      b.taper(0.19, 1.0 * h, 0.19, 0.42, bark, { topColor: lerpHex(bark, 0x6d5d78, 0.5), twist: 0.4, tex: TEX.BARK });
      b.at(jx + 0.20, y + 0.62 * h, jz - 0.10).rot(spin + 0.8);
      b.taper(0.10, 0.36 * h, 0.10, 0.4, bark, { twist: 0.6, tex: TEX.BARK });
      b.at(jx - 0.18, y + 0.75 * h, jz + 0.12).rot(spin - 0.7);
      b.taper(0.09, 0.30 * h, 0.09, 0.4, bark, { twist: -0.5, tex: TEX.BARK });
      b.rot(0);
      break;
    }

    case PROP.STUMP: {
      b.at(jx, y, jz).rot(spin);
      b.taper(0.34, 0.20, 0.34, 0.88, 0x6b4630, { topColor: 0xa07c52, tex: TEX.BARK });
      b.rot(0);
      break;
    }

    /* -------------------------------------------------- foliage */
    case PROP.BUSH: {
      const s = 0.8 + r1 * 0.5;
      const col = snowy ? 0x4a6458 : biome === BIOME.ASH ? 0x4a4557 : lerpHex(0x3c8a3f, 0x4fa64d, r2);
      b.at(jx, y, jz).rot(spin);
      b.taper(0.62 * s, 0.34 * s, 0.56 * s, 0.78, col,
        { topColor: lerpHex(col, 0xa8e08a, 0.45), tex: TEX.LEAF, twist: 0.4 });
      b.at(jx + 0.12, y + 0.26 * s, jz - 0.08).rot(spin + 1.3);
      b.taper(0.38 * s, 0.22 * s, 0.34 * s, 0.7, lerpHex(col, 0xffffff, 0.08),
        { topColor: lerpHex(col, 0xb8ee9a, 0.5), tex: TEX.LEAF });
      b.rot(0);
      break;
    }

    case PROP.BERRY_BUSH: {
      const s = 0.85 + r1 * 0.4;
      const col = 0x35793a;
      b.at(jx, y, jz).rot(spin);
      b.taper(0.60 * s, 0.36 * s, 0.56 * s, 0.76, col, { topColor: 0x59a95c, tex: TEX.LEAF, twist: 0.3 });
      b.rot(0);
      for (let i = 0; i < 5; i++) {
        const a = spin + i * 1.257;
        const rr = 0.20 + vrand(variant, 30 + i) * 0.16;
        b.at(jx + Math.cos(a) * rr, y + 0.24 * s + vrand(variant, 40 + i) * 0.14, jz + Math.sin(a) * rr);
        b.box(0.095, 0.095, 0.095, 0xd8375a, { centered: true, topColor: 0xf05a78, tex: TEX.FLAT });
      }
      break;
    }

    case PROP.FERN: {
      const col = snowy ? 0x63806f : 0x357f44;
      for (let i = 0; i < 3; i++) {
        const a = spin + i * 2.09;
        b.at(jx + Math.cos(a) * 0.14, y, jz + Math.sin(a) * 0.14).rot(a);
        b.cross(0.44 + vrand(variant, 50 + i) * 0.2, 0.34, col, { tipColor: 0x6dc25e });
      }
      b.rot(0);
      break;
    }

    case PROP.GRASS: {
      const tint = biome === BIOME.ASH ? 0x4a5545 : biome === BIOME.SNOW ? 0x8fa79c
        : biome === BIOME.BLOOM ? 0x3fae82 : biome === BIOME.MEADOW ? 0x4aa544 : 0x35893a;
      const tip = biome === BIOME.ASH ? 0x6b7a63 : biome === BIOME.SNOW ? 0xc4d6ce
        : biome === BIOME.BLOOM ? 0x6fd9ab : 0x63c258;
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
      b.box(0.12, 0.09, 0.12, petal, { topColor: lerpHex(petal, 0xffffff, 0.45), tex: TEX.FLAT });
      if (biome === BIOME.BLOOM) {
        g.at(jx, y + 0.24, jz);
        g.box(0.07, 0.05, 0.07, petal, { centered: true });
      }
      b.rot(0);
      break;
    }

    case PROP.MUSHROOM: {
      const capCol = biome === BIOME.BLOOM ? 0x8be3ff : biome === BIOME.ASH ? 0x8f6f9e
        : biome === BIOME.MARSH ? 0xb08a4a : 0xd9503f;
      const n = 1 + Math.floor(r3 * 3);
      for (let i = 0; i < n; i++) {
        const ox = (vrand(variant, 30 + i) - 0.5) * 0.4;
        const oz = (vrand(variant, 40 + i) - 0.5) * 0.4;
        const s = 0.6 + vrand(variant, 50 + i) * 0.6;
        b.at(jx + ox, y, jz + oz).rot(spin + i);
        b.box(0.08 * s, 0.17 * s, 0.08 * s, 0xf0e4d0, { topColor: 0xfff6e8, tex: TEX.FLAT });
        b.at(jx + ox, y + 0.16 * s, jz + oz);
        b.cone(0.17 * s, 0.14 * s, 6, capCol, { topColor: lerpHex(capCol, 0xffffff, 0.4), tex: TEX.FLAT });
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

    /* ----------------------------------------------------- rock */
    case PROP.ROCK: case PROP.SNOW_ROCK: {
      const s = 0.55 + r1 * 0.45;
      const snowRock = prop === PROP.SNOW_ROCK;
      const col = snowRock ? lerpHex(0xb9c6d2, 0xd6e2ec, r2)
        : biome === BIOME.ASH ? lerpHex(0x4a4356, 0x625a6e, r2) : lerpHex(0x8d95a4, 0xaab2bf, r2);
      b.at(jx, y, jz).rot(spin);
      b.taper(0.34 * s, 0.22 * s, 0.30 * s, 0.7, col,
        { topColor: lerpHex(col, 0xd6dce6, 0.35), twist: 0.5, tex: snowRock ? TEX.SNOW : TEX.ROCK });
      b.rot(0);
      break;
    }

    case PROP.BOULDER: {
      const s = 0.9 + r1 * 0.5;
      const col = biome === BIOME.ASH ? 0x554d61 : biome === BIOME.SNOW ? 0xa8b6c4 : lerpHex(0x848d9c, 0x9fa7b5, r2);
      b.at(jx, y, jz).rot(spin);
      b.taper(0.72 * s, 0.34 * s, 0.66 * s, 0.82, col,
        { topColor: lerpHex(col, 0xc8d0dc, 0.3), twist: 0.3, tex: TEX.ROCK });
      b.at(jx + 0.06, y + 0.34 * s, jz - 0.04).rot(spin + 1.1);
      b.taper(0.54 * s, 0.30 * s, 0.50 * s, 0.6, lerpHex(col, 0xffffff, 0.08),
        { topColor: lerpHex(col, 0xe0e6f0, 0.4), twist: -0.4, tex: TEX.ROCK });
      if (biome !== BIOME.ASH && biome !== BIOME.SNOW && r3 > 0.45) {
        b.at(jx + 0.06, y + 0.60 * s, jz - 0.04).rot(spin);
        b.ground(0.40 * s, 0.36 * s, 0x4fae52, { yOff: 0.005, tex: TEX.MOSS });
      }
      b.rot(0);
      break;
    }

    /* A standing slab: the thing that makes crags read as crags. */
    case PROP.ROCK_TALL: {
      const s = 0.9 + r1 * 0.6;
      const col = lerpHex(0x7b8391, 0x949cab, r2);
      b.at(jx, y, jz).rot(spin);
      b.taper(0.56 * s, 1.15 * s, 0.44 * s, 0.62, col,
        { topColor: lerpHex(col, 0xc6cedb, 0.4), twist: 0.22, tex: TEX.ROCK });
      b.at(jx + 0.22, y, jz + 0.16).rot(spin + 2.1);
      b.taper(0.34 * s, 0.55 * s, 0.30 * s, 0.6, lerpHex(col, 0x000000, 0.08),
        { topColor: col, twist: -0.3, tex: TEX.ROCK });
      b.rot(0);
      break;
    }

    case PROP.ICE_SPIKE: {
      const s = 0.9 + r1 * 0.6;
      b.at(jx, y - 0.1, jz).rot(spin);
      b.crystal(0.18 * s, 1.0 * s, 0x9fd8ee, { sides: 5, tilt: (r2 - 0.5) * 0.3, tipColor: 0xeafaff, tex: TEX.ICE });
      b.rot(0);
      break;
    }

    /* ------------------------------------------------------ ore */
    case PROP.ORE_COPPER: case PROP.ORE_IRON: case PROP.ORE_GOLD: case PROP.ORE_ESSENCE: {
      const s = 0.85 + r1 * 0.4;
      const spec = {
        [PROP.ORE_COPPER]: { rock: 0x7d8694, fleck: 0xd98a4a, tex: TEX.ORE_IRON },
        [PROP.ORE_IRON]: { rock: 0x767e8c, fleck: 0xc9d2de, tex: TEX.ORE_IRON },
        [PROP.ORE_GOLD]: { rock: 0x8a8272, fleck: 0xffd24a, tex: TEX.ORE_GOLD },
        [PROP.ORE_ESSENCE]: { rock: 0x6a5c7d, fleck: 0xc9a6ff, tex: TEX.ORE_ESSENCE },
      }[prop];
      b.at(jx, y, jz).rot(spin);
      b.taper(0.78 * s, 0.52 * s, 0.70 * s, 0.68, spec.rock,
        { topColor: lerpHex(spec.rock, 0xd0d8e4, 0.35), twist: 0.3, tex: spec.tex });
      b.at(jx - 0.14, y + 0.44 * s, jz + 0.10).rot(spin + 1.6);
      b.taper(0.42 * s, 0.34 * s, 0.38 * s, 0.6, spec.rock,
        { topColor: lerpHex(spec.rock, 0xe0e6f0, 0.4), twist: -0.4, tex: spec.tex });
      /* Exposed metal, so a vein is spottable from a distance. */
      for (let i = 0; i < 4; i++) {
        const a = spin + i * 1.571 + 0.4;
        const rr = 0.26 * s;
        b.at(jx + Math.cos(a) * rr, y + 0.16 * s + vrand(variant, 60 + i) * 0.3 * s, jz + Math.sin(a) * rr).rot(a);
        b.box(0.14 * s, 0.11 * s, 0.10 * s, spec.fleck,
          { centered: true, topColor: lerpHex(spec.fleck, 0xffffff, 0.45), tex: TEX.FLAT });
      }
      if (prop === PROP.ORE_ESSENCE) {
        g.at(jx, y + 0.5 * s, jz);
        g.box(0.16, 0.16, 0.16, 0xb07bff, { centered: true });
      }
      b.rot(0);
      break;
    }

    case PROP.CRYSTAL: {
      const s = 0.8 + r1 * 0.6;
      const core = lerpHex(0x8b5cf0, 0xb07bff, r2);
      b.at(jx, y, jz).rot(spin);
      b.crystal(0.16 * s, 1.0 * s, core, { sides: 5, tilt: (r3 - 0.5) * 0.22, tipColor: 0xd9c0ff, tex: TEX.CRYSTAL });
      b.at(jx + 0.22, y, jz + 0.12).rot(spin + 1.9);
      b.crystal(0.10 * s, 0.56 * s, core, { sides: 5, tilt: 0.16, tipColor: 0xd9c0ff, tex: TEX.CRYSTAL });
      b.at(jx - 0.18, y, jz + 0.18).rot(spin - 1.2);
      b.crystal(0.08 * s, 0.40 * s, core, { sides: 4, tilt: -0.2, tipColor: 0xd9c0ff, tex: TEX.CRYSTAL });
      g.at(jx, y + 0.1, jz).rot(spin);
      g.crystal(0.07 * s, 0.82 * s, 0xc9a6ff, { sides: 5, tipColor: 0xffffff });
      b.rot(0); g.rot(0);
      break;
    }

    case PROP.RIFT_SHARD: {
      const s = 0.9 + r1 * 0.7;
      b.at(jx, y - 0.05, jz).rot(spin);
      b.crystal(0.19 * s, 1.15 * s, 0x2a1436, { sides: 4, tilt: (r2 - 0.5) * 0.5, tipColor: 0x6b2a63, tex: TEX.CRYSTAL });
      g.at(jx, y + 0.05, jz).rot(spin);
      g.crystal(0.09 * s, 0.92 * s, 0xff4fd8, { sides: 4, tilt: (r2 - 0.5) * 0.5, tipColor: 0xffc2f0 });
      b.rot(0); g.rot(0);
      break;
    }

    /* -------------------------------------------------- machine */
    case PROP.RUIN_WALL: {
      const h = 0.55 + r1 * 0.75;
      const col = lerpHex(0x7f8794, 0x99a1ae, r2);
      b.at(jx, y, jz).rot(Math.round(spin / (Math.PI / 2)) * (Math.PI / 2) + (r3 - 0.5) * 0.12);
      b.box(0.95, h, 0.32, col, { topColor: lerpHex(col, 0xc9d1dc, 0.4), tex: TEX.BRICK });
      b.at(jx + 0.3, y + h, jz).box(0.34, 0.18 + r3 * 0.2, 0.32, col, { topColor: 0xb6bec9, tex: TEX.BRICK });
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
      b.taper(0.30, h, 0.30, 0.86, 0x8d95a4, { topColor: 0xbac2ce, tex: TEX.STONE });
      b.at(jx, y + h, jz).box(0.42, 0.14, 0.42, 0x9aa2b0, { topColor: 0xc6cdd8, tex: TEX.STONE });
      b.rot(0);
      break;
    }

    case PROP.PYLON: {
      const h = 1.8 + r1 * 0.9;
      b.at(jx, y, jz).rot(spin);
      b.taper(0.40, h * 0.78, 0.40, 0.40, 0x59616f, { topColor: 0x7b8493, twist: 0.25, tex: TEX.METAL });
      b.at(jx, y + h * 0.78, jz).box(0.26, h * 0.22, 0.26, 0x6d7583, { topColor: 0x99a2b0, tex: TEX.PANEL });
      g.at(jx, y + h * 0.74, jz).rot(spin);
      g.box(0.46, 0.07, 0.46, 0x3fe0ff, { centered: true });
      g.at(jx, y + h, jz);
      g.box(0.16, 0.16, 0.16, 0x9af2ff, { centered: true });
      b.rot(0); g.rot(0);
      break;
    }

    case PROP.CONDUIT: {
      const a = Math.round(spin / (Math.PI / 2)) * (Math.PI / 2);
      b.at(jx, y, jz).rot(a);
      b.box(0.86, 0.14, 0.34, 0x515a68, { topColor: 0x6d7684, tex: TEX.CIRCUIT });
      g.at(jx, y + 0.145, jz).rot(a);
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
        b.box(0.3 * s, 0.16 * s, 0.24 * s, col, { topColor: lerpHex(col, 0xffffff, 0.3), tex: TEX.RUST });
        b.rot(0);
      }
      break;
    }

    case PROP.ANTENNA: {
      const h = 2.2 + r1 * 1.2;
      b.at(jx, y, jz).rot(spin);
      b.taper(0.22, h, 0.22, 0.28, 0x656d7b, { topColor: 0x8a93a1, twist: 0.5, tex: TEX.METAL });
      for (let i = 1; i <= 2; i++) {
        b.at(jx, y + h * (0.45 + i * 0.2), jz).rot(spin + i * 0.6);
        b.box(0.5, 0.04, 0.05, 0x7a8391, { centered: true, tex: TEX.METAL });
      }
      g.at(jx, y + h + 0.06, jz);
      g.box(0.1, 0.1, 0.1, 0xff4f4f, { centered: true });
      b.rot(0);
      break;
    }

    case PROP.CRATE: {
      const s = 0.8 + r1 * 0.3;
      b.at(jx, y, jz).rot(spin * 0.3);
      b.box(0.56 * s, 0.5 * s, 0.56 * s, 0x8a6a45, { topColor: 0xb08c5e, tex: TEX.PLANK });
      b.at(jx, y + 0.5 * s * 0.5, jz).rot(spin * 0.3);
      b.box(0.60 * s, 0.07, 0.60 * s, 0x5f4a33, { centered: true, tex: TEX.METAL });
      b.rot(0);
      break;
    }

    case PROP.LAMP: {
      b.at(jx, y, jz);
      b.taper(0.12, 1.5, 0.12, 0.7, 0x4e5663, { topColor: 0x6d7583, tex: TEX.METAL });
      b.at(jx, y + 1.5, jz).box(0.3, 0.2, 0.3, 0x59616f, { topColor: 0x7b8493, tex: TEX.PANEL });
      g.at(jx, y + 1.52, jz);
      g.box(0.22, 0.12, 0.22, 0xffc45e, { centered: true });
      break;
    }

    case PROP.BONES: {
      b.at(jx, y, jz).rot(spin);
      b.box(0.52, 0.07, 0.10, 0xe4e0d2, { topColor: 0xf5f2e8, tex: TEX.BONE });
      b.at(jx + 0.1, y, jz + 0.16).rot(spin + 1.0);
      b.box(0.40, 0.06, 0.09, 0xd8d4c6, { topColor: 0xeeeade, tex: TEX.BONE });
      b.at(jx - 0.14, y, jz - 0.1).rot(spin + 0.4);
      b.box(0.19, 0.15, 0.17, 0xe4e0d2, { topColor: 0xf5f2e8, tex: TEX.BONE });
      b.rot(0);
      break;
    }

    default: break;
  }
}

export { GLOW_SCALE, vrand, lerpHex };
