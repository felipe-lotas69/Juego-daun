/* ============================================================
   actors.js - characters on screen

   Every creature is a handful of boxes in a group, animated by
   moving the group's parts rather than by skinning anything. At
   this resolution a bob, a lean and a limb swing carry a walk
   cycle perfectly well, and it costs four draw calls instead of a
   skeleton.

   Geometry is built once per creature type and shared; only the
   transforms differ per instance.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { MeshBuilder } from './geom.js';
import { makeToonMaterial, makeBlobShadowMaterial } from './materials.js';
import { LAYER_WORLD, LAYER_NO_OUTLINE } from './pipeline.js';
import { ENEMIES } from '../game/defs.js';
import { ANIMALS, EXTRA_ENEMIES } from '../game/creatures.js';
import { TEX } from './textures.js';
import { lerpHex } from './props.js';
import { clamp01, TAU } from '../core/util.js';

export const PLAYER_COLORS = [
  { body: 0x3f7fd4, trim: 0x7ec3ff, core: 0x7ee8ff, name: 'AZURE' },
  { body: 0xd4543f, trim: 0xff9f7e, core: 0xffb03a, name: 'EMBER' },
  { body: 0x6fbf47, trim: 0xb4ef86, core: 0x63ff9d, name: 'MOSS' },
  { body: 0xa457d4, trim: 0xd9a6ff, core: 0xff4fd8, name: 'VIOLET' },
];

/* Everything that walks, in one table, so an actor can be built
   from a type name without caring which population it came from. */
export const ALL_CREATURES = { ...ENEMIES, ...EXTRA_ENEMIES, ...ANIMALS };

const QUADRUPEDS = new Set(['critter', 'deer', 'boar', 'ram', 'wolf']);

const geoCache = new Map();
let blobMat = null;
let blobGeo = null;

function cached(key, build) {
  if (!geoCache.has(key)) geoCache.set(key, build());
  return geoCache.get(key);
}

/* ------------------------------------------------------------ player */
function buildPlayerParts(colorIndex) {
  const c = PLAYER_COLORS[colorIndex % PLAYER_COLORS.length];
  const dark = lerpHex(c.body, 0x101020, 0.42);
  const boot = lerpHex(c.body, 0x101020, 0.62);

  const torso = new MeshBuilder();
  torso.at(0, 0, 0).box(0.46, 0.46, 0.34, c.body, { topColor: lerpHex(c.body, 0xffffff, 0.22) });
  /* Shoulder yoke, which is most of what reads at this size. */
  torso.at(0, 0.36, 0).box(0.54, 0.14, 0.38, dark, { topColor: lerpHex(dark, 0xffffff, 0.3) });
  torso.at(0, 0.10, -0.18).box(0.22, 0.24, 0.06, c.trim, { topColor: c.trim });

  const head = new MeshBuilder();
  head.at(0, 0, 0).box(0.36, 0.34, 0.34, lerpHex(c.body, 0x2a2438, 0.55),
    { topColor: lerpHex(c.body, 0x3a3450, 0.4) });
  head.at(0, 0.34, 0).box(0.40, 0.07, 0.38, dark, { topColor: lerpHex(dark, 0xffffff, 0.25) });

  const visor = new MeshBuilder();
  visor.at(0.13, 0.12, 0).box(0.06, 0.10, 0.26, c.core, { centered: true });

  const arm = new MeshBuilder();
  arm.at(0, -0.16, 0).box(0.14, 0.34, 0.15, dark, { topColor: lerpHex(dark, 0xffffff, 0.25) });
  arm.at(0, -0.30, 0).box(0.16, 0.12, 0.17, c.trim, { topColor: lerpHex(c.trim, 0xffffff, 0.3) });

  const legs = new MeshBuilder();
  legs.at(0, 0, 0).box(0.16, 0.30, 0.17, boot, { topColor: lerpHex(boot, 0xffffff, 0.2) });

  const core = new MeshBuilder();
  core.at(0, 0, 0).box(0.16, 0.16, 0.10, c.core, { centered: true });

  const weapon = new MeshBuilder();
  weapon.at(0.20, 0, 0).box(0.42, 0.11, 0.11, 0x5c6470, { centered: true, topColor: 0x8a93a1 });
  weapon.at(0.02, 0, 0).box(0.14, 0.17, 0.13, 0x3e4550, { centered: true, topColor: 0x676f7c });

  const weaponGlow = new MeshBuilder();
  weaponGlow.at(0.42, 0, 0).box(0.09, 0.07, 0.07, c.core, { centered: true });

  return {
    torso: torso.build(), head: head.build(), visor: visor.build(),
    arm: arm.build(), legs: legs.build(), core: core.build(),
    weapon: weapon.build(), weaponGlow: weaponGlow.build(), colors: c,
  };
}

/* ------------------------------------------------------------ enemies */
/* A four-legged body: barrel, neck, head, and legs carried on the
   two limb groups so the existing walk cycle animates them. */
function quadruped(parts, spec) {
  const { body, head, limbL, limbR, glow } = parts;
  const { base, light, dark, len, wide, tall, tex } = spec;
  body.at(0, 0, 0).rot(0);
  body.taper(len, tall, wide, 0.88, base, { topColor: light, tex, twist: 0.05 });
  /* Haunch and shoulder, so it is not a single box. */
  body.at(-len * 0.28, tall * 0.1, 0).taper(wide * 1.05, tall * 0.8, wide * 1.05, 0.8, base,
    { topColor: light, tex });
  if (spec.tail) {
    body.at(-len * 0.52, tall * 0.7, 0).rot(0.4);
    body.box(spec.tail, 0.08, 0.08, dark, { centered: true, tex });
    body.rot(0);
  }
  head.at(0, 0, 0).rot(0);
  head.box(wide * 0.92, tall * 0.62, wide * 0.86, dark, { topColor: base, tex });
  if (spec.snout) head.at(wide * 0.6, -tall * 0.1, 0).box(spec.snout, tall * 0.3, wide * 0.55, base,
    { centered: true, topColor: light, tex });
  if (spec.ears) {
    for (const sgn of [-1, 1]) {
      head.at(-wide * 0.1, tall * 0.38, sgn * wide * 0.3).rot(0);
      head.cone(0.07, spec.ears, 4, dark, { topColor: base, tex });
    }
  }
  const legLen = spec.legs || tall * 0.9;
  for (const [mesh, sgn] of [[limbL, 1], [limbR, -1]]) {
    mesh.at(len * 0.26, -legLen * 0.5, sgn * wide * 0.34).rot(0);
    mesh.box(0.11, legLen, 0.12, dark, { tex });
    mesh.at(-len * 0.26, -legLen * 0.5, sgn * wide * 0.34);
    mesh.box(0.11, legLen, 0.12, dark, { tex });
  }
  if (spec.horns) {
    for (const sgn of [-1, 1]) {
      head.at(-wide * 0.05, tall * 0.34, sgn * wide * 0.26).rot(sgn * 0.5);
      head.taper(0.09, spec.horns, 0.09, 0.4, spec.hornColor || 0xe4dcc8, { twist: sgn * 0.9, tex: TEX.BONE });
    }
  }
  if (spec.antlerGlow && glow) {
    for (const sgn of [-1, 1]) {
      glow.at(-wide * 0.05, tall * 0.62, sgn * wide * 0.26).rot(0);
      glow.box(0.07, 0.24, 0.07, spec.antlerGlow, { centered: true });
      glow.at(-wide * 0.2, tall * 0.76, sgn * wide * 0.38);
      glow.box(0.05, 0.16, 0.05, spec.antlerGlow, { centered: true });
    }
  }
}

function buildEnemyParts(type) {
  const def = ALL_CREATURES[type];
  const base = def.color, accent = def.accent;
  const light = lerpHex(base, 0xffffff, 0.22);
  const body = new MeshBuilder();
  const head = new MeshBuilder();
  const limbL = new MeshBuilder();
  const limbR = new MeshBuilder();
  const glow = new MeshBuilder();

  switch (type) {
    case 'husk': {
      body.at(0, 0, 0).taper(0.42, 0.60, 0.34, 0.82, base, { topColor: light, twist: 0.1 });
      body.at(0, 0.56, 0).box(0.50, 0.12, 0.36, lerpHex(base, 0x000000, 0.25), { topColor: light });
      body.at(-0.06, 0, 0).box(0.14, 0.26, 0.15, lerpHex(base, 0x000000, 0.3));
      head.at(0, 0, 0).box(0.32, 0.28, 0.30, lerpHex(base, 0x000000, 0.2), { topColor: base });
      glow.at(0.13, 0.06, 0.07).box(0.05, 0.07, 0.06, accent, { centered: true });
      glow.at(0.13, 0.06, -0.07).box(0.05, 0.07, 0.06, accent, { centered: true });
      limbL.at(0, -0.14, 0).box(0.12, 0.34, 0.13, lerpHex(base, 0x000000, 0.15));
      limbR.at(0, -0.14, 0).box(0.12, 0.34, 0.13, lerpHex(base, 0x000000, 0.15));
      break;
    }
    case 'spark': {
      body.at(0, 0, 0).taper(0.34, 0.34, 0.30, 0.7, base, { topColor: light, twist: 0.3 });
      head.at(0, 0, 0).box(0.26, 0.20, 0.24, lerpHex(base, 0x000000, 0.2), { topColor: base });
      glow.at(0.11, 0.02, 0).box(0.05, 0.05, 0.14, accent, { centered: true });
      glow.at(0, 0.18, 0).box(0.08, 0.10, 0.08, accent, { centered: true });
      limbL.at(0, -0.10, 0).box(0.08, 0.22, 0.09, lerpHex(base, 0x000000, 0.2));
      limbR.at(0, -0.10, 0).box(0.08, 0.22, 0.09, lerpHex(base, 0x000000, 0.2));
      break;
    }
    case 'caster': {
      /* No legs: it hovers, and the robe hem is the silhouette. */
      body.at(0, 0, 0).cone(0.34, 0.66, 6, base, { topColor: light, flatten: 1 });
      body.at(0, 0.62, 0).box(0.34, 0.20, 0.30, lerpHex(base, 0x000000, 0.2), { topColor: base });
      head.at(0, 0, 0).box(0.28, 0.24, 0.26, lerpHex(base, 0x000000, 0.35), { topColor: base });
      glow.at(0.12, 0.03, 0).box(0.04, 0.09, 0.16, accent, { centered: true });
      limbL.at(0, 0, 0).box(0.16, 0.16, 0.16, accent, { centered: true });
      limbR.at(0, 0, 0).box(0.10, 0.10, 0.10, accent, { centered: true });
      break;
    }
    case 'bomber': {
      body.at(0, 0, 0).taper(0.50, 0.46, 0.50, 1.12, base, { topColor: light });
      body.at(0, 0.46, 0).cone(0.26, 0.22, 6, lerpHex(base, 0x000000, 0.2), { topColor: base });
      head.at(0, 0, 0).box(0.22, 0.18, 0.22, lerpHex(base, 0x000000, 0.3), { topColor: base });
      glow.at(0, 0.02, 0).box(0.34, 0.20, 0.34, accent, { centered: true });
      limbL.at(0, -0.09, 0).box(0.09, 0.20, 0.10, lerpHex(base, 0x000000, 0.25));
      limbR.at(0, -0.09, 0).box(0.09, 0.20, 0.10, lerpHex(base, 0x000000, 0.25));
      break;
    }
    case 'stalker': {
      body.at(0, 0, 0).taper(0.34, 0.66, 0.28, 0.72, base, { topColor: light, twist: 0.2 });
      body.at(0, 0.6, 0).box(0.44, 0.10, 0.28, lerpHex(base, 0x000000, 0.3), { topColor: light });
      head.at(0, 0, 0).box(0.30, 0.20, 0.24, lerpHex(base, 0x000000, 0.2), { topColor: base });
      glow.at(0.13, 0.02, 0).box(0.04, 0.05, 0.18, accent, { centered: true });
      /* Blades rather than hands. */
      limbL.at(0, -0.2, 0).box(0.09, 0.46, 0.10, lerpHex(base, 0xffffff, 0.15));
      limbR.at(0, -0.2, 0).box(0.09, 0.46, 0.10, lerpHex(base, 0xffffff, 0.15));
      break;
    }
    case 'warden': {
      body.at(0, 0, 0).taper(0.72, 0.90, 0.60, 0.88, base, { topColor: light });
      body.at(0, 0.86, 0).box(0.86, 0.18, 0.62, lerpHex(base, 0x000000, 0.25), { topColor: light });
      body.at(0, 0.3, 0.33).box(0.60, 0.50, 0.10, lerpHex(base, 0xffffff, 0.12), { topColor: light });
      head.at(0, 0, 0).box(0.40, 0.32, 0.36, lerpHex(base, 0x000000, 0.2), { topColor: base });
      glow.at(0.17, 0.04, 0).box(0.04, 0.10, 0.22, accent, { centered: true });
      glow.at(0, 0.5, 0.36).box(0.34, 0.06, 0.03, accent, { centered: true });
      limbL.at(0, -0.24, 0).box(0.20, 0.52, 0.20, lerpHex(base, 0x000000, 0.12));
      limbR.at(0, -0.24, 0).box(0.20, 0.52, 0.20, lerpHex(base, 0x000000, 0.12));
      break;
    }
    case 'colossus': {
      body.at(0, 0, 0).taper(1.25, 1.70, 1.00, 0.80, base, { topColor: light, twist: 0.08 });
      body.at(0, 1.62, 0).box(1.55, 0.30, 1.05, lerpHex(base, 0x000000, 0.3), { topColor: light });
      head.at(0, 0, 0).box(0.62, 0.52, 0.56, lerpHex(base, 0x000000, 0.2), { topColor: base });
      glow.at(0.27, 0.06, 0).box(0.05, 0.14, 0.34, accent, { centered: true });
      glow.at(0, 1.0, 0.52).box(0.70, 0.10, 0.05, accent, { centered: true });
      limbL.at(0, -0.5, 0).taper(0.40, 1.05, 0.40, 1.25, lerpHex(base, 0x000000, 0.12), { topColor: light });
      limbR.at(0, -0.5, 0).taper(0.40, 1.05, 0.40, 1.25, lerpHex(base, 0x000000, 0.12), { topColor: light });
      break;
    }
    case 'riftheart': {
      body.at(0, 0, 0).crystal(0.46, 1.5, base, { sides: 6, tipColor: lerpHex(base, accent, 0.5) });
      head.at(0, 0, 0).box(0.44, 0.44, 0.44, lerpHex(base, 0x000000, 0.3), { topColor: base });
      glow.at(0, 0, 0).crystal(0.22, 1.0, accent, { sides: 6, tipColor: 0xffffff });
      /* Two rings that counter-rotate. */
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * TAU;
        limbL.at(Math.cos(a) * 0.85, 0, Math.sin(a) * 0.85).rot(a);
        limbL.box(0.22, 0.07, 0.07, accent, { centered: true });
        limbR.at(Math.cos(a) * 0.62, 0, Math.sin(a) * 0.62).rot(a);
        limbR.box(0.16, 0.05, 0.05, lerpHex(accent, 0xffffff, 0.4), { centered: true });
      }
      limbL.rot(0); limbR.rot(0);
      break;
    }
    /* ------------------------------------------------ extra rift */
    case 'crawler': {
      body.at(0, 0, 0).taper(0.46, 0.30, 0.38, 0.78, base, { topColor: light, tex: TEX.METAL, twist: 0.3 });
      head.at(0, 0, 0).box(0.26, 0.16, 0.30, lerpHex(base, 0x000000, 0.3), { topColor: base, tex: TEX.METAL });
      glow.at(0.11, 0.0, 0).box(0.04, 0.05, 0.18, accent, { centered: true });
      for (const [mesh, sgn] of [[limbL, 1], [limbR, -1]]) {
        for (let i = 0; i < 3; i++) {
          mesh.at(0.14 - i * 0.16, -0.12, sgn * 0.22).rot(sgn * 0.5);
          mesh.box(0.07, 0.30, 0.07, lerpHex(base, 0x000000, 0.2), { tex: TEX.METAL });
        }
        mesh.rot(0);
      }
      break;
    }
    case 'breaker': {
      body.at(0, 0, 0).taper(0.86, 1.05, 0.72, 0.84, base, { topColor: light, tex: TEX.RUST });
      body.at(0, 1.0, 0).box(1.0, 0.2, 0.78, lerpHex(base, 0x000000, 0.25), { topColor: light, tex: TEX.METAL });
      head.at(0, 0, 0).box(0.44, 0.34, 0.40, lerpHex(base, 0x000000, 0.25), { topColor: base, tex: TEX.METAL });
      glow.at(0.19, 0.04, 0).box(0.04, 0.10, 0.26, accent, { centered: true });
      /* Wrecking arms: the reason a siege night is dangerous. */
      limbL.at(0, -0.34, 0).box(0.26, 0.7, 0.26, lerpHex(base, 0x000000, 0.1), { tex: TEX.METAL });
      limbL.at(0, -0.74, 0).box(0.42, 0.34, 0.42, 0x8a8f9a, { topColor: 0xb4bac6, tex: TEX.METAL });
      limbR.at(0, -0.34, 0).box(0.26, 0.7, 0.26, lerpHex(base, 0x000000, 0.1), { tex: TEX.METAL });
      limbR.at(0, -0.74, 0).box(0.42, 0.34, 0.42, 0x8a8f9a, { topColor: 0xb4bac6, tex: TEX.METAL });
      break;
    }
    case 'bloomheart': {
      body.at(0, 0, 0).taper(1.3, 1.5, 1.2, 0.7, base, { topColor: light, tex: TEX.MOSS, twist: 0.15 });
      body.at(0, 1.45, 0).cone(0.95, 0.95, 8, lerpHex(base, 0x76e0b4, 0.4),
        { topColor: 0xb8f5dc, tex: TEX.LEAF });
      head.at(0, 0, 0).box(0.5, 0.42, 0.46, lerpHex(base, 0x000000, 0.3), { topColor: base, tex: TEX.BARK });
      glow.at(0, 0, 0).crystal(0.3, 0.9, accent, { sides: 6, tipColor: 0xffc2f0 });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU;
        limbL.at(Math.cos(a) * 0.95, 0, Math.sin(a) * 0.95).rot(a);
        limbL.taper(0.16, 0.9, 0.16, 0.4, lerpHex(base, 0x000000, 0.2), { twist: 0.6, tex: TEX.BARK });
        limbR.at(Math.cos(a + 0.5) * 0.6, 0, Math.sin(a + 0.5) * 0.6).rot(a);
        limbR.box(0.14, 0.14, 0.14, accent, { centered: true });
      }
      limbL.rot(0); limbR.rot(0);
      break;
    }

    /* --------------------------------------------------- wildlife */
    case 'critter': {
      quadruped({ body, head, limbL, limbR, glow }, {
        base, light, dark: lerpHex(base, 0x000000, 0.3), len: 0.46, wide: 0.28, tall: 0.28,
        tex: TEX.FUR, ears: 0.09, tail: 0.18, legs: 0.14,
      });
      glow.at(0.12, 0.02, 0.06).box(0.03, 0.03, 0.03, accent, { centered: true });
      break;
    }
    case 'deer': {
      quadruped({ body, head, limbL, limbR, glow }, {
        base, light, dark: lerpHex(base, 0x000000, 0.28), len: 1.15, wide: 0.46, tall: 0.55,
        tex: TEX.FUR, ears: 0.18, tail: 0.18, legs: 0.78, snout: 0.28, antlerGlow: accent,
      });
      break;
    }
    case 'boar': {
      quadruped({ body, head, limbL, limbR, glow }, {
        base, light, dark: lerpHex(base, 0x000000, 0.3), len: 1.2, wide: 0.6, tall: 0.56,
        tex: TEX.FUR, ears: 0.13, tail: 0.16, legs: 0.42, snout: 0.36,
        horns: 0.24, hornColor: accent,
      });
      break;
    }
    case 'ram': {
      quadruped({ body, head, limbL, limbR, glow }, {
        base, light, dark: lerpHex(base, 0x000000, 0.25), len: 1.14, wide: 0.56, tall: 0.62,
        tex: TEX.FUR, ears: 0.13, tail: 0.13, legs: 0.62, snout: 0.26,
        horns: 0.42, hornColor: accent,
      });
      break;
    }
    case 'wolf': {
      quadruped({ body, head, limbL, limbR, glow }, {
        base, light, dark: lerpHex(base, 0x000000, 0.3), len: 1.02, wide: 0.38, tall: 0.44,
        tex: TEX.FUR, ears: 0.19, tail: 0.38, legs: 0.54, snout: 0.3,
      });
      glow.at(0.2, 0.02, 0.08).box(0.035, 0.04, 0.04, accent, { centered: true });
      glow.at(0.2, 0.02, -0.08).box(0.035, 0.04, 0.04, accent, { centered: true });
      break;
    }
    case 'lumen': {
      body.at(0, 0, 0).crystal(0.14, 0.34, base, { sides: 5, tipColor: 0xffffff, tex: TEX.CRYSTAL });
      glow.at(0, 0.18, 0).box(0.24, 0.24, 0.24, accent, { centered: true });
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * TAU;
        limbL.at(Math.cos(a) * 0.3, 0.2, Math.sin(a) * 0.3).rot(a);
        limbL.box(0.10, 0.04, 0.04, base, { centered: true });
      }
      limbL.rot(0);
      break;
    }

    default: {
      body.at(0, 0, 0).box(0.4, 0.6, 0.4, base, { topColor: light });
      head.at(0, 0, 0).box(0.3, 0.3, 0.3, lerpHex(base, 0x000000, 0.2));
      break;
    }
  }

  return {
    body: body.isEmpty ? null : body.build(),
    head: head.isEmpty ? null : head.build(),
    limbL: limbL.isEmpty ? null : limbL.build(),
    limbR: limbR.isEmpty ? null : limbR.build(),
    glow: glow.isEmpty ? null : glow.build(),
    def,
  };
}

function ensureBlob() {
  if (!blobMat) {
    blobMat = makeBlobShadowMaterial();
    blobGeo = new THREE.PlaneGeometry(1, 1);
    blobGeo.rotateX(-Math.PI / 2);
  }
}

/* ---------------------------------------------------------- the actor */
export class Actor {
  constructor(scene, kind, variant) {
    this.scene = scene;
    this.kind = kind;            /* 'player' | enemy type | 'construct' */
    this.group = new THREE.Group();
    this.parts = {};
    this.time = Math.random() * 10;
    this.hurtFlash = 0;
    ensureBlob();

    const solid = (geo, mat) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.layers.set(LAYER_WORLD);
      this.group.add(m);
      return m;
    };

    if (kind === 'player') {
      const p = cached('player:' + variant, () => buildPlayerParts(variant));
      this.colors = p.colors;
      const bodyMat = makeToonMaterial({ vertexColors: true, rim: 1.25 });
      const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
      this.parts.torso = solid(p.torso, bodyMat);
      this.parts.head = solid(p.head, bodyMat);
      this.parts.armL = solid(p.arm, bodyMat);
      this.parts.armR = solid(p.arm, bodyMat);
      this.parts.legL = solid(p.legs, bodyMat);
      this.parts.legR = solid(p.legs, bodyMat);
      this.parts.weapon = solid(p.weapon, bodyMat);
      this.parts.visor = new THREE.Mesh(p.visor, glowMat);
      this.parts.core = new THREE.Mesh(p.core, glowMat);
      this.parts.muzzle = new THREE.Mesh(p.weaponGlow, glowMat);
      for (const k of ['visor', 'core', 'muzzle']) {
        this.parts[k].layers.set(LAYER_WORLD);
        this.group.add(this.parts[k]);
      }
      this.height = 1.25;
    } else if (ALL_CREATURES[kind]) {
      const p = cached('enemy:' + kind, () => buildEnemyParts(kind));
      this.def = p.def;
      this.quad = QUADRUPEDS.has(kind);
      const bodyMat = makeToonMaterial({ vertexColors: true, rim: 1.4 });
      const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
      if (p.body) this.parts.body = solid(p.body, bodyMat);
      if (p.head) this.parts.head = solid(p.head, bodyMat);
      if (p.limbL) this.parts.limbL = solid(p.limbL, bodyMat);
      if (p.limbR) this.parts.limbR = solid(p.limbR, bodyMat);
      if (p.glow) {
        this.parts.glow = new THREE.Mesh(p.glow, glowMat);
        this.parts.glow.layers.set(LAYER_WORLD);
        this.group.add(this.parts.glow);
      }
      this.height = p.def.height;
    }

    this.shadow = new THREE.Mesh(blobGeo, blobMat);
    this.shadow.layers.set(LAYER_NO_OUTLINE);
    this.shadow.renderOrder = 2;
    scene.add(this.shadow);
    scene.add(this.group);
  }

  setVisible(v) {
    this.group.visible = v;
    this.shadow.visible = v;
  }

  dispose() {
    this.scene.remove(this.group);
    this.scene.remove(this.shadow);
  }

  /* `ent` is a simulation entity; this never writes to it. */
  update(dt, ent, opts = {}) {
    this.time += dt;
    const g = this.group;
    const scale = opts.scale || 1;
    g.position.set(ent.x, ent.y, ent.z);
    g.rotation.y = -(ent.facing || 0) + Math.PI / 2;
    g.scale.setScalar(scale);

    const moving = clamp01(ent.anim ? ent.anim.move : 0);
    const stride = this.time * (6 + moving * 8);
    const bob = Math.abs(Math.sin(stride)) * 0.07 * moving;
    const hurt = ent.anim ? ent.anim.hurt : 0;
    const attack = ent.anim ? ent.anim.attack : 0;

    const swing = Math.sin(stride) * 0.75 * moving;
    const down = ent.state === 'downed';

    if (this.kind === 'player') {
      const P = this.parts;
      const lean = clamp01(Math.hypot(ent.vx || 0, ent.vz || 0) / 7) * 0.18;
      P.torso.position.set(0, 0.52 + bob, 0);
      P.torso.rotation.set(lean * 0.5, 0, 0);
      P.head.position.set(0, 0.96 + bob * 1.2, 0);
      P.head.rotation.set(0, 0, Math.sin(this.time * 1.7) * 0.04);
      P.visor.position.copy(P.head.position);
      P.visor.rotation.copy(P.head.rotation);
      P.core.position.set(0.12, 0.66 + bob, 0);
      /* The gun arm tracks the aim; the other one swings. */
      P.armR.position.set(0.10, 0.80 + bob, 0.26);
      P.armR.rotation.set(0, 0, -1.25 - attack * 0.35);
      P.armL.position.set(0.02, 0.80 + bob, -0.26);
      P.armL.rotation.set(swing * 0.9, 0, 0.12);
      P.legL.position.set(0, 0.30 - bob * 0.4, 0.11);
      P.legL.rotation.set(-swing, 0, 0);
      P.legR.position.set(0, 0.30 - bob * 0.4, -0.11);
      P.legR.rotation.set(swing, 0, 0);
      P.weapon.position.set(0.34 + attack * 0.06, 0.70 + bob, 0.24);
      P.weapon.rotation.set(0, 0, 0);
      P.muzzle.position.set(0.56 + attack * 0.06, 0.70 + bob, 0.24);
      P.muzzle.scale.setScalar(0.4 + attack * 1.9);
      P.muzzle.visible = attack > 0.05;

      if (down) {
        g.rotation.z = Math.PI / 2 * 0.85;
        g.position.y = ent.y + 0.15;
      } else {
        g.rotation.z = 0;
      }
    } else {
      const P = this.parts;
      const h = this.height;
      if (P.body) {
        P.body.position.set(0, bob, 0);
        P.body.rotation.set(0, 0, 0);
      }
      if (P.head) {
        /* Four-legged things carry their head forward, not on top. */
        if (this.quad) {
          P.head.position.set(h * 0.72, h * 0.62 + bob, 0);
          P.head.rotation.set(0, 0, -0.12 + attack * 0.5);
        } else {
          P.head.position.set(0, h * 0.62 + bob * 1.2, 0);
          P.head.rotation.set(attack * 0.35, 0, 0);
        }
      }
      if (P.glow) {
        P.glow.position.copy(P.head ? P.head.position : new THREE.Vector3(0, h * 0.5, 0));
        if (this.kind === 'bomber') {
          const pulse = 1 + Math.sin(this.time * (ent.fuse > 0 ? 34 : 4)) * (ent.fuse > 0 ? 0.5 : 0.12);
          P.glow.position.set(0, h * 0.30, 0);
          P.glow.scale.setScalar(pulse);
        } else if (this.kind === 'riftheart') {
          P.glow.position.set(0, 0, 0);
          P.glow.rotation.y = this.time * 1.1;
        }
      }
      if (P.limbL && P.limbR) {
        if (this.kind === 'caster') {
          const orbit = this.time * 2.2;
          P.limbL.position.set(Math.cos(orbit) * 0.5, h * 0.55 + Math.sin(orbit * 1.4) * 0.12, Math.sin(orbit) * 0.5);
          P.limbR.position.set(-Math.cos(orbit * 0.8) * 0.4, h * 0.42, -Math.sin(orbit * 0.8) * 0.4);
        } else if (this.kind === 'riftheart') {
          P.limbL.position.set(0, h * 0.5, 0);
          P.limbL.rotation.set(0.5, this.time * 0.9, 0);
          P.limbR.position.set(0, h * 0.5, 0);
          P.limbR.rotation.set(-0.4, -this.time * 1.4, 0.3);
        } else if (this.quad) {
          P.limbL.position.set(0, h * 0.62 + bob * 0.5, 0);
          P.limbL.rotation.set(0, 0, swing * 0.55);
          P.limbR.position.set(0, h * 0.62 + bob * 0.5, 0);
          P.limbR.rotation.set(0, 0, -swing * 0.55);
        } else {
          const reach = attack * 0.9;
          P.limbL.position.set(reach * 0.35, h * 0.62 + bob, 0.22);
          P.limbL.rotation.set(-swing - reach, 0, 0.1);
          P.limbR.position.set(reach * 0.35, h * 0.62 + bob, -0.22);
          P.limbR.rotation.set(swing - reach, 0, -0.1);
        }
      }
      /* Floaters ignore the ground a little. */
      if (this.kind === 'lumen') {
        g.position.y = ent.y + 0.15 + Math.sin(this.time * 1.9) * 0.14;
      } else if (this.kind === 'caster' || this.kind === 'riftheart') {
        g.position.y = ent.y + 0.35 + Math.sin(this.time * 1.6) * 0.09;
      }
    }

    /* Damage flash, done by pushing the whole group's scale rather
       than swapping materials, which would break instancing. */
    if (hurt > 0.01) {
      const k = 1 + hurt * 0.16;
      g.scale.set(scale * k, scale * (2 - k), scale * k);
    }

    const sh = this.shadow;
    const r = (opts.shadowRadius || (this.def ? this.def.radius * 2.6 : 0.95)) * scale;
    sh.position.set(ent.x, (opts.groundY !== undefined ? opts.groundY : ent.y) + 0.035, ent.z);
    sh.scale.set(r, 1, r);
    sh.visible = this.group.visible;
  }
}

export function disposeActorCache() {
  for (const parts of geoCache.values()) {
    for (const v of Object.values(parts)) if (v && v.dispose) v.dispose();
  }
  geoCache.clear();
}
