/* ============================================================
   structures.js - landmarks

   The set pieces a run is navigated by. These are built once and
   never streamed out, because "head for the pylon ring" only works
   if the pylon ring is always there.

   Each recipe returns the light sites it wants at night.
   ============================================================ */

import { vrand, lerpHex } from './props.js';
import { TEX } from './textures.js';

export function buildStructure(b, g, kind, x, y, z, variant, lm) {
  switch (kind) {
    case 'beacon': return beacon(b, g, x, y, z);
    case 'cache': return cache(b, g, x, y, z, variant);
    case 'rift': return riftGate(b, g, x, y, z, variant);
    case 'shrine': return shrine(b, g, x, y, z, variant);
    case 'wreck': return wreck(b, g, x, y, z, variant);
    case 'camp': return camp(b, g, x, y, z, variant);
    case 'mine': return mine(b, g, x, y, z, variant);
    case 'cavemouth': return caveMouth(b, g, x, y, z, variant);
    case 'village': return village(b, g, x, y, z, variant, lm);
    default: return null;
  }
}

/* The beacon: three stone steps, a machined collar and four arcane
   posts. The floating core above it is animated, so the game adds
   that separately. */
function beacon(b, g, x, y, z) {
  b.at(x, y, z).rot(0).sc(1);
  b.box(6.4, 0.18, 6.4, 0x8d8497, { topColor: 0xa79db1 });
  b.at(x, y + 0.18, z).box(5.0, 0.20, 5.0, 0x968da0, { topColor: 0xb3a9bd });
  b.at(x, y + 0.38, z).box(3.6, 0.22, 3.6, 0x9f96a9, { topColor: 0xc0b6c9 });

  /* Machined collar with a cyan seam. */
  b.at(x, y + 0.60, z).taper(2.1, 0.42, 2.1, 0.86, 0x5c6470, { topColor: 0x7e8794 });
  g.at(x, y + 0.98, z).box(1.9, 0.05, 1.9, 0x3fe0ff, { centered: true });

  /* Pillar. */
  b.at(x, y + 1.02, z).taper(0.78, 1.5, 0.78, 0.62, 0x6d7583, { topColor: 0x99a2b0, twist: 0.12 });
  g.at(x, y + 1.6, z).box(0.56, 0.9, 0.06, 0x8b5cf0, { centered: true });
  g.at(x, y + 1.6, z).box(0.06, 0.9, 0.56, 0x8b5cf0, { centered: true });

  /* Four posts at the corners of the inner step. */
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    const px = x + Math.cos(a) * 2.1, pz = z + Math.sin(a) * 2.1;
    b.at(px, y + 0.38, pz).rot(a);
    b.taper(0.34, 1.25, 0.34, 0.6, 0x5c6470, { topColor: 0x848d9b });
    b.at(px, y + 1.63, pz).rot(a).box(0.22, 0.20, 0.22, 0x7d8694, { topColor: 0xa3acba });
    g.at(px, y + 1.78, pz).rot(0);
    g.crystal(0.11, 0.34, 0xb07bff, { sides: 5, tipColor: 0xe6d6ff });
    b.rot(0);
  }

  /* Ground glyph ring. */
  for (let i = 0; i < 16; i++) {
    const a = (i / 16) * Math.PI * 2;
    g.at(x + Math.cos(a) * 2.85, y + 0.40, z + Math.sin(a) * 2.85).rot(a);
    g.box(0.30, 0.012, 0.10, i % 4 === 0 ? 0x3fe0ff : 0x8b5cf0, { centered: true });
  }

  return [
    { x, y: y + 2.4, z, color: 0xb07bff, intensity: 3.2, range: 16, key: 'beacon' },
    { x, y: y + 1.0, z, color: 0x3fe0ff, intensity: 1.2, range: 9 },
  ];
}

/* A salvage cache: a sealed machine crate on a small pad. */
function cache(b, g, x, y, z, variant) {
  const spin = vrand(variant, 1) * Math.PI * 2;
  b.at(x, y, z).rot(0).sc(1);
  b.box(2.6, 0.14, 2.6, 0x7d7488, { topColor: 0x968da0 });
  b.at(x, y + 0.14, z).rot(spin);
  b.box(1.35, 0.85, 1.05, 0x5f6470, { topColor: 0x848d9b });
  b.at(x, y + 0.99, z).rot(spin).box(1.45, 0.12, 1.15, 0x4b515c, { topColor: 0x6d7583 });
  b.at(x, y + 0.14, z).rot(spin).box(1.40, 0.14, 1.10, 0xb8593a, { topColor: 0xd4784f });
  g.at(x, y + 0.62, z).rot(spin);
  g.box(0.30, 0.16, 1.08, 0xffb03a, { centered: true });
  b.rot(0); g.rot(0);
  return [{ x, y: y + 0.8, z, color: 0xffb03a, intensity: 1.4, range: 6 }];
}

/* A rift gate: a torn arch of dark stone with the rift showing
   through it. These are where the night comes from. */
function riftGate(b, g, x, y, z, variant) {
  const spin = vrand(variant, 1) * Math.PI * 2;
  b.at(x, y, z).rot(spin).sc(1);
  b.box(3.4, 0.16, 3.4, 0x3c3348, { topColor: 0x4e4459 });

  for (const side of [-1, 1]) {
    b.at(x + Math.cos(spin) * 1.25 * side, y + 0.16, z + Math.sin(spin) * 1.25 * side).rot(spin);
    b.taper(0.52, 2.5, 0.46, 0.5, 0x2a1436, { topColor: 0x4a2a55, twist: 0.2 * side });
  }
  /* Lintel. */
  b.at(x, y + 2.5, z).rot(spin).box(2.9, 0.34, 0.5, 0x2a1436, { topColor: 0x4a2a55 });

  /* The tear itself. */
  g.at(x, y + 1.35, z).rot(spin);
  g.box(1.75, 2.25, 0.05, 0xff4fd8, { centered: true });
  g.at(x, y + 1.35, z).rot(spin);
  g.box(1.35, 2.0, 0.09, 0x7a1f6b, { centered: true });

  for (let i = 0; i < 5; i++) {
    const a = vrand(variant, 10 + i) * Math.PI * 2;
    const r = 1.6 + vrand(variant, 20 + i) * 1.0;
    b.at(x + Math.cos(a) * r, y + 0.16, z + Math.sin(a) * r).rot(a);
    b.crystal(0.13, 0.5 + vrand(variant, 30 + i) * 0.5, 0x2a1436, { sides: 4, tilt: 0.3, tipColor: 0x6b2a63 });
  }
  b.rot(0); g.rot(0);
  return [{ x, y: y + 1.6, z, color: 0xff4fd8, intensity: 2.6, range: 12, key: 'rift' }];
}

/* A shrine: an arcane pedestal that grants a temporary boon. */
function shrine(b, g, x, y, z, variant) {
  b.at(x, y, z).rot(0).sc(1);
  b.box(2.2, 0.16, 2.2, 0x8d8497, { topColor: 0xa79db1 });
  b.at(x, y + 0.16, z).taper(0.95, 0.72, 0.95, 0.72, 0x6a4a7d, { topColor: 0x8b64a3 });
  b.at(x, y + 0.88, z).box(0.74, 0.12, 0.74, 0x7d5a92, { topColor: 0xa77fbe });
  g.at(x, y + 1.15, z).rot(vrand(variant, 1) * 3);
  g.crystal(0.19, 0.55, 0x7ee8ff, { sides: 6, tipColor: 0xffffff });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    g.at(x + Math.cos(a) * 1.35, y + 0.17, z + Math.sin(a) * 1.35).rot(a);
    g.box(0.22, 0.012, 0.08, 0x7ee8ff, { centered: true });
  }
  g.rot(0);
  return [{ x, y: y + 1.3, z, color: 0x7ee8ff, intensity: 2.0, range: 8 }];
}

/* An abandoned camp: someone else tried this, and their firepit
   and lean-to are still here. Good early salvage. */
function camp(b, g, x, y, z, variant) {
  const spin = vrand(variant, 1) * Math.PI * 2;
  /* Firepit. */
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.at(x + Math.cos(a) * 0.62, y, z + Math.sin(a) * 0.62).rot(a);
    b.taper(0.24, 0.16, 0.22, 0.8, 0x8d95a4, { topColor: 0xb0b8c4, tex: TEX.ROCK });
  }
  b.at(x, y, z).rot(0);
  b.ground(1.0, 1.0, 0x2a2420, { yOff: 0.02, tex: TEX.ASH });
  for (let i = 0; i < 3; i++) {
    b.at(x + (vrand(variant, 10 + i) - 0.5) * 0.5, y + 0.05, z + (vrand(variant, 20 + i) - 0.5) * 0.5)
      .rot(vrand(variant, 30 + i) * 3.1);
    b.box(0.44, 0.09, 0.09, 0x4a3a2e, { centered: true, tex: TEX.BARK });
  }
  /* Lean-to. */
  b.at(x + Math.cos(spin) * 1.8, y, z + Math.sin(spin) * 1.8).rot(spin);
  b.box(1.5, 0.12, 1.2, 0x7a5a3c, { topColor: 0x9a7550, tex: TEX.THATCH, yOff: 0.85 });
  for (const side of [-1, 1]) {
    b.at(x + Math.cos(spin) * 1.8 + Math.cos(spin + Math.PI / 2) * 0.55 * side,
         y, z + Math.sin(spin) * 1.8 + Math.sin(spin + Math.PI / 2) * 0.55 * side).rot(spin);
    b.taper(0.13, 0.9, 0.13, 0.8, 0x5c452f, { topColor: 0x7a5c3e, tex: TEX.BARK });
  }
  b.rot(0);
  return [{ x, y: y + 0.3, z, color: 0xffb03a, intensity: 0.6, range: 4 }];
}

/* A mine mouth cut into a cliff: timbered frame, spoil heap,
   and the good ore is all around it. */
function mine(b, g, x, y, z, variant) {
  const spin = vrand(variant, 1) * Math.PI * 2;
  b.at(x, y, z).rot(spin).sc(1);
  b.box(3.0, 0.14, 3.0, 0x6d6960, { topColor: 0x8a857b, tex: TEX.GRAVEL });
  /* Frame. */
  for (const side of [-1, 1]) {
    b.at(x + Math.cos(spin + Math.PI / 2) * 0.95 * side, y + 0.14,
         z + Math.sin(spin + Math.PI / 2) * 0.95 * side).rot(spin);
    b.box(0.26, 1.7, 0.30, 0x6b4f33, { topColor: 0x8a6742, tex: TEX.PLANK });
  }
  b.at(x, y + 1.84, z).rot(spin);
  b.box(2.3, 0.28, 0.40, 0x6b4f33, { topColor: 0x8a6742, tex: TEX.PLANK });
  /* The dark of the shaft. */
  b.at(x, y + 0.14, z).rot(spin);
  b.box(1.7, 1.7, 0.22, 0x14100f, { topColor: 0x1c1816, tex: TEX.FLAT });
  /* Spoil heap and a minecart's worth of rock. */
  for (let i = 0; i < 5; i++) {
    const a = spin + 2.2 + i * 0.5;
    const r = 1.6 + vrand(variant, 40 + i) * 0.8;
    b.at(x + Math.cos(a) * r, y, z + Math.sin(a) * r).rot(a);
    b.taper(0.5, 0.26, 0.45, 0.7, 0x7d7669, { topColor: 0x9a938a, tex: TEX.GRAVEL, twist: 0.4 });
  }
  g.at(x, y + 1.0, z).rot(spin);
  g.box(0.20, 0.20, 0.06, 0xffb03a, { centered: true });
  b.rot(0); g.rot(0);
  return [{ x, y: y + 1.1, z, color: 0xffb03a, intensity: 1.2, range: 6 }];
}

/* ------------------------------------------------------- villages

   A square with a well in it, a ring of cottages facing inward, a
   trading stall under an awning, and a fence with a gate. Everything
   is laid out from the variant, so two villages are never the same
   shape, and everything is axis-aligned, because a cottage turned
   thirteen degrees off the grid in a game built out of blocks looks
   like a mistake rather than like character.

   The colour of the awning and the sign is the trade, which is how
   you know from across the valley whether it is worth the walk. */
const VILLAGE_COLORS = {
  grange: 0x9bd05a, smithy: 0xffb03a, trapline: 0xc08a5e, apothecary: 0xb07bff,
};

function cottage(b, g, x, y, z, spin, seed, accent) {
  const w = 2.2 + vrand(seed, 3) * 0.7;
  const d = 1.9 + vrand(seed, 4) * 0.5;
  const wallH = 1.5;
  const wall = lerpHex(0xcfc0a4, 0xb8a98c, vrand(seed, 5));
  const beam = 0x6b4f33;
  const thatch = lerpHex(0x8a6a3c, 0x9d7c48, vrand(seed, 6));

  b.at(x, y, z).rot(spin).sc(1);
  /* Sill, walls, and the dark beams that make it half-timbered. */
  b.box(w + 0.24, 0.16, d + 0.24, 0x6d6960, { topColor: 0x8a857b, tex: TEX.GRAVEL });
  b.at(x, y + 0.16, z).rot(spin);
  b.box(w, wallH, d, wall, { topColor: lerpHex(wall, 0xffffff, 0.25), tex: TEX.PLANK });
  for (const side of [-1, 1]) {
    b.at(x + Math.cos(spin) * (w / 2) * side, y + 0.16, z + Math.sin(spin) * (w / 2) * side).rot(spin);
    b.box(0.16, wallH, d + 0.06, beam, { topColor: 0x8a6742, tex: TEX.PLANK });
  }
  b.at(x, y + 0.16 + wallH - 0.12, z).rot(spin);
  b.box(w + 0.1, 0.16, d + 0.1, beam, { topColor: 0x8a6742, tex: TEX.PLANK });

  /* A stepped roof: three courses narrowing to a ridge, which is how
     a pitched roof is built out of blocks without looking like a
     wedge stuck on top. */
  let ry = y + 0.16 + wallH;
  let rw = w + 0.5, rd = d + 0.5;
  for (let k = 0; k < 3; k++) {
    b.at(x, ry, z).rot(spin);
    b.box(rw, 0.30, rd, thatch, { topColor: lerpHex(thatch, 0xd8c9a0, 0.4), tex: TEX.PLANK });
    ry += 0.30; rw -= 0.62; rd -= 0.42;
    if (rw < 0.4 || rd < 0.3) break;
  }

  /* Door, window, and a lit window at that. */
  const fx = Math.cos(spin + Math.PI / 2), fz = Math.sin(spin + Math.PI / 2);
  b.at(x + fx * (d / 2 + 0.02), y + 0.16, z + fz * (d / 2 + 0.02)).rot(spin);
  b.box(0.10, 0.95, 0.62, beam, { topColor: 0x8a6742, tex: TEX.PLANK });
  g.at(x + fx * (d / 2 + 0.04), y + 0.95, z + fz * (d / 2 + 0.04)).rot(spin);
  g.box(0.06, 0.34, 0.40, accent, { centered: true });
  b.rot(0); g.rot(0);
}

function village(b, g, x, y, z, variant, lm) {
  const accent = VILLAGE_COLORS[lm && lm.vkind] || 0xffb03a;
  const lights = [];

  /* Cottages where the generator put them, because that is where the
     walls it made solid are. */
  const FACE_SPIN = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const huts = (lm && lm.huts) || [];
  for (const hut of huts) {
    const cx = x + (hut.tx - lm.tx), cz = z + (hut.ty - lm.ty);
    cottage(b, g, cx, y, cz, FACE_SPIN[hut.face], hut.seed, accent);
    lights.push({ x: cx, y: y + 1.1, z: cz, color: 0xffc46a, intensity: 0.9, range: 6 });
  }

  /* The well: the reason the village is here. */
  b.at(x, y, z).rot(0).sc(1);
  b.box(1.5, 0.14, 1.5, 0x6d6960, { topColor: 0x8a857b, tex: TEX.GRAVEL });
  b.at(x, y + 0.14, z).rot(0);
  b.box(1.1, 0.55, 1.1, 0x7d7669, { topColor: 0x6a6358, tex: TEX.STONE });
  b.at(x, y + 0.42, z).rot(0);
  b.box(0.72, 0.30, 0.72, 0x2e4a58, { topColor: 0x2f9ec9, tex: TEX.WATER });
  for (const side of [-1, 1]) {
    b.at(x + side * 0.45, y + 0.69, z).rot(0);
    b.box(0.14, 0.9, 0.14, 0x6b4f33, { topColor: 0x8a6742, tex: TEX.PLANK });
  }
  b.at(x, y + 1.56, z).rot(0);
  b.box(1.3, 0.22, 0.9, 0x8a6a3c, { topColor: 0xb89a62, tex: TEX.PLANK });

  /* The stall, two tiles off the middle, where the trading happens.
     An awning in the trade's colour and a lantern over the counter. */
  const sx = x + 2, sz = z + 2;
  b.at(sx, y, sz).rot(0);
  b.box(2.4, 0.12, 1.6, 0x6d6960, { topColor: 0x8a857b, tex: TEX.GRAVEL });
  b.at(sx, y + 0.12, sz - 0.5).rot(0);
  b.box(2.2, 0.85, 0.5, 0x8a6a45, { topColor: 0xb08a5e, tex: TEX.PLANK });
  for (const side of [-1, 1]) {
    b.at(sx + side * 1.05, y + 0.12, sz + 0.6).rot(0);
    b.box(0.14, 1.7, 0.14, 0x6b4f33, { topColor: 0x8a6742, tex: TEX.PLANK });
  }
  b.at(sx, y + 1.82, sz + 0.1).rot(0);
  b.box(2.5, 0.16, 1.7, accent, { topColor: lerpHex(accent, 0xffffff, 0.35), tex: TEX.PLANK });
  g.at(sx, y + 1.62, sz + 0.75).rot(0);
  g.box(0.22, 0.22, 0.22, 0xffc46a, { centered: true });
  lights.push({ x: sx, y: y + 1.6, z: sz, color: 0xffc46a, intensity: 1.8, range: 9 });

  /* A sign on a post, in the trade's colour, tall enough to spot. */
  b.at(x - 3.2, y, z - 3.2).rot(0);
  b.box(0.16, 2.1, 0.16, 0x6b4f33, { topColor: 0x8a6742, tex: TEX.PLANK });
  b.at(x - 3.2, y + 1.7, z - 3.2).rot(0);
  b.box(0.9, 0.55, 0.12, 0x8a6a45, { topColor: 0xb08a5e, tex: TEX.PLANK });
  g.at(x - 3.2, y + 1.95, z - 3.26).rot(0);
  g.box(0.5, 0.26, 0.06, accent, { centered: true });

  /* Fence posts around the edge, with a gap for the track. */
  for (let i = 0; i < 20; i++) {
    const a = (i / 20) * Math.PI * 2;
    if (a > 0.45 && a < 1.1) continue;          /* the gate */
    const fx = Math.round(x + Math.cos(a) * 6.4);
    const fz = Math.round(z + Math.sin(a) * 6.4);
    b.at(fx, y, fz).rot(0);
    b.box(0.14, 0.85, 0.14, 0x6b4f33, { topColor: 0x8a6742, tex: TEX.PLANK });
    b.at(fx, y + 0.5, fz).rot(a + Math.PI / 2);
    b.box(0.9, 0.10, 0.08, 0x5c4229, { topColor: 0x7a5a38, tex: TEX.PLANK });
  }

  b.rot(0); g.rot(0);
  return lights;
}

/* The way into a cave: a timber frame with a lintel over it, turned
   to face out of the hill, and a lantern somebody left burning. The
   variant carries the direction rather than a random seed - a portal
   facing into the rock it is set in would be worse than none. */
function caveMouth(b, g, x, y, z, variant) {
  const spin = (variant & 3) * (Math.PI / 2);
  const fx = Math.cos(spin), fz = Math.sin(spin);   /* into the hill */
  const sx = -fz, sz = fx;                          /* across it     */

  /* Trodden ground at the threshold. */
  b.at(x, y, z).rot(spin).sc(1);
  b.box(2.6, 0.12, 2.6, 0x6d6960, { topColor: 0x8a857b, tex: TEX.GRAVEL });

  /* Two posts and a lintel, straddling the opening. */
  for (const side of [-1, 1]) {
    b.at(x + sx * 1.05 * side, y + 0.12, z + sz * 1.05 * side).rot(spin);
    b.box(0.30, 1.9, 0.34, 0x6b4f33, { topColor: 0x8a6742, tex: TEX.PLANK });
  }
  b.at(x, y + 2.02, z).rot(spin);
  b.box(0.42, 0.30, 2.6, 0x6b4f33, { topColor: 0x8a6742, tex: TEX.PLANK });
  /* A brace across the top, so it reads as built and not as two sticks. */
  b.at(x, y + 1.72, z).rot(spin);
  b.box(0.24, 0.22, 2.0, 0x5c4229, { topColor: 0x7a5a38, tex: TEX.PLANK });

  /* Spoil: what came out of the hole, heaped beside the door. */
  for (let i = 0; i < 5; i++) {
    const a = spin + 1.9 + i * 0.62;
    const r = 1.5 + vrand(variant + i * 37, 40 + i) * 0.7;
    b.at(x + Math.cos(a) * r, y, z + Math.sin(a) * r).rot(a);
    b.taper(0.46, 0.24, 0.42, 0.7, 0x7d7669, { topColor: 0x9a938a, tex: TEX.GRAVEL, twist: 0.4 });
  }

  /* The lantern, which is also the thing you can see from a distance. */
  b.at(x - fx * 1.15 + sx * 1.05, y + 1.5, z - fz * 1.15 + sz * 1.05).rot(spin);
  b.box(0.16, 0.26, 0.16, 0x4a4038, { topColor: 0x655a4e, tex: TEX.FLAT });
  g.at(x - fx * 1.15 + sx * 1.05, y + 1.5, z - fz * 1.15 + sz * 1.05).rot(spin);
  g.box(0.20, 0.20, 0.20, 0xffb03a, { centered: true });

  b.rot(0); g.rot(0);
  return [{ x: x - fx * 1.1, y: y + 1.5, z: z - fz * 1.1, color: 0xffb03a, intensity: 1.6, range: 8 }];
}

/* A crashed hull. Half buried, still leaking power. */
function wreck(b, g, x, y, z, variant) {
  const spin = vrand(variant, 1) * Math.PI * 2;
  const s = 0.9 + vrand(variant, 2) * 0.5;
  b.at(x, y - 0.2, z).rot(spin).sc(1);
  b.taper(3.4 * s, 1.1, 1.7 * s, 0.78, 0x5a5f6b, { topColor: 0x7c828f, twist: 0.1 });
  b.at(x + Math.cos(spin) * 1.5 * s, y + 0.5, z + Math.sin(spin) * 1.5 * s).rot(spin + 0.4);
  b.taper(1.3 * s, 0.7, 1.0 * s, 0.6, 0x6b5148, { topColor: 0x8d6d5f });
  /* Torn plating sticking out of the ground. */
  for (let i = 0; i < 3; i++) {
    const a = spin + 1.2 + i * 1.5;
    const r = 1.9 + vrand(variant, 10 + i) * 1.1;
    b.at(x + Math.cos(a) * r, y, z + Math.sin(a) * r).rot(a + 0.6);
    b.box(1.0 * s, 0.7 + vrand(variant, 20 + i) * 0.5, 0.12, 0xb8593a, { topColor: 0xd07a52 });
  }
  g.at(x, y + 0.75, z).rot(spin);
  g.box(2.2 * s, 0.07, 0.22, 0x3fe0ff, { centered: true });
  g.at(x - Math.cos(spin) * 1.4 * s, y + 0.45, z - Math.sin(spin) * 1.4 * s).rot(spin);
  g.box(0.35, 0.35, 0.35, 0xffb03a, { centered: true });
  b.rot(0); g.rot(0);
  return [{ x, y: y + 0.9, z, color: 0x3fe0ff, intensity: 1.3, range: 7 }];
}
