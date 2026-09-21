/* ============================================================
   structures.js - landmarks

   The set pieces a run is navigated by. These are built once and
   never streamed out, because "head for the pylon ring" only works
   if the pylon ring is always there.

   Each recipe returns the light sites it wants at night.
   ============================================================ */

import { vrand } from './props.js';

export function buildStructure(b, g, kind, x, y, z, variant) {
  switch (kind) {
    case 'beacon': return beacon(b, g, x, y, z);
    case 'cache': return cache(b, g, x, y, z, variant);
    case 'rift': return riftGate(b, g, x, y, z, variant);
    case 'shrine': return shrine(b, g, x, y, z, variant);
    case 'wreck': return wreck(b, g, x, y, z, variant);
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
