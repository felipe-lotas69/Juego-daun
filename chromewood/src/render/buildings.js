/* ============================================================
   buildings.js - what the player puts down

   Each recipe returns geometry for one tile. They are built from
   the same boxes as everything else so a player's wall sits in the
   world at the same visual weight as a ruin, and the outline pass
   treats them identically.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { TEX } from './textures.js';
import { TAU } from '../core/util.js';

export function buildStructureMesh(b, g, key, x, y, z, state = {}) {
  switch (key) {
    case 'campfire': {
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * TAU;
        b.at(x + Math.cos(a) * 0.42, y, z + Math.sin(a) * 0.42).rot(a);
        b.taper(0.2, 0.16, 0.18, 0.8, 0x8d95a4, { topColor: 0xb0b8c4, tex: TEX.ROCK });
      }
      b.at(x, y, z).rot(0);
      b.ground(0.7, 0.7, 0x2a2018, { yOff: 0.02, tex: TEX.ASH });
      for (let i = 0; i < 4; i++) {
        const a = i * 1.4;
        b.at(x, y + 0.06, z).rot(a);
        b.box(0.5, 0.08, 0.08, 0x5a4330, { centered: true, tex: TEX.BARK });
      }
      g.at(x, y + 0.22, z).rot(0);
      g.cone(0.20, 0.42, 5, 0xff9b3a, { topColor: 0xffe08a });
      g.at(x, y + 0.14, z).box(0.38, 0.06, 0.38, 0xff6a2a, { centered: true });
      break;
    }
    case 'workbench': {
      b.at(x, y, z).rot(0);
      b.box(0.86, 0.62, 0.62, 0x7a5a3c, { topColor: 0xa07c52, tex: TEX.PLANK });
      b.at(x, y + 0.62, z).box(0.94, 0.10, 0.70, 0x8a6a45, { topColor: 0xb89066, tex: TEX.PLANK });
      /* Tools left on the bench: reads instantly as a workbench. */
      b.at(x - 0.2, y + 0.72, z + 0.1).rot(0.4);
      b.box(0.36, 0.06, 0.07, 0x9aa3b2, { centered: true, tex: TEX.METAL });
      b.at(x + 0.22, y + 0.74, z - 0.12).rot(-0.3);
      b.box(0.10, 0.12, 0.10, 0x6d7583, { centered: true, tex: TEX.METAL });
      break;
    }
    case 'forge': {
      b.at(x, y, z).rot(0);
      b.box(0.9, 0.78, 0.9, 0x6d6960, { topColor: 0x8a857b, tex: TEX.BRICK });
      b.at(x, y + 0.78, z).taper(0.52, 0.55, 0.52, 0.55, 0x5a5650, { topColor: 0x7a756d, tex: TEX.BRICK });
      b.at(x, y + 0.2, z + 0.46).box(0.46, 0.34, 0.06, 0x241c16, { centered: true, tex: TEX.FLAT });
      g.at(x, y + 0.22, z + 0.44).box(0.36, 0.26, 0.05, 0xff7a2a, { centered: true });
      g.at(x, y + 1.36, z).box(0.16, 0.14, 0.16, 0xff9b3a, { centered: true });
      break;
    }
    case 'arcanebench': {
      b.at(x, y, z).rot(0);
      b.box(0.86, 0.56, 0.72, 0x5b4a6e, { topColor: 0x7a6490, tex: TEX.STONE });
      b.at(x, y + 0.56, z).box(0.96, 0.10, 0.80, 0x6d5a84, { topColor: 0x9a82b4, tex: TEX.STONE });
      for (const s of [-1, 1]) {
        b.at(x + s * 0.34, y + 0.66, z).rot(0);
        b.taper(0.12, 0.42, 0.12, 0.7, 0x4b3c5c, { topColor: 0x6d5a84, tex: TEX.METAL });
      }
      g.at(x, y + 1.02, z).rot(state.t || 0);
      g.crystal(0.16, 0.44, 0xb07bff, { sides: 6, tipColor: 0xffffff });
      g.at(x, y + 0.68, z).box(0.70, 0.03, 0.56, 0x8b5cf0, { centered: true });
      break;
    }
    case 'wall_wood': {
      b.at(x, y, z).rot(0);
      b.box(1.0, 1.55, 0.46, 0x7a5a3c, { topColor: 0xa07c52, tex: TEX.PLANK });
      b.at(x, y + 0.75, z).box(1.04, 0.10, 0.50, 0x5c432c, { centered: true, tex: TEX.BARK });
      break;
    }
    case 'wall_stone': {
      b.at(x, y, z).rot(0);
      b.box(1.0, 1.75, 0.52, 0x8a857b, { topColor: 0xa8a399, tex: TEX.BRICK });
      b.at(x, y + 1.75, z).box(1.06, 0.12, 0.58, 0x9a958b, { topColor: 0xbab5ab, tex: TEX.STONE });
      break;
    }
    case 'wall_plated': {
      b.at(x, y, z).rot(0);
      b.box(1.0, 1.85, 0.55, 0x6d7583, { topColor: 0x99a2b0, tex: TEX.METAL });
      b.at(x, y + 0.5, z + 0.29).box(0.8, 0.7, 0.05, 0x5a626f, { centered: true, tex: TEX.PANEL });
      g.at(x, y + 1.62, z + 0.28).box(0.5, 0.04, 0.03, 0x3fe0ff, { centered: true });
      break;
    }
    /* Blocks: a stack of cubes, each one a terrain step tall, with the
       courses offset a hair so the joints read from a distance. */
    case 'block_wood': case 'block_stone': case 'block_iron': {
      const n = Math.max(1, state.stack || 1);
      const skin = {
        block_wood: { side: 0x7a5a3c, top: 0xa07c52, tex: TEX.PLANK, edge: 0x5c432c },
        block_stone: { side: 0x8a857b, top: 0xa8a399, tex: TEX.BRICK, edge: 0x6f6a61 },
        block_iron: { side: 0x6d7583, top: 0x99a2b0, tex: TEX.METAL, edge: 0x4e5663 },
      }[key];
      for (let i = 0; i < n; i++) {
        const cy = y + i * 0.8;
        b.at(x, cy, z).rot(0);
        b.box(0.98, 0.8, 0.98, skin.side, { topColor: skin.top, tex: skin.tex });
        /* A darker band at each joint: without it a stack of four is
           one tall box and the whole point is lost. */
        if (i > 0) {
          b.at(x, cy, z).rot(0);
          b.box(1.0, 0.08, 1.0, skin.edge, { tex: TEX.FLAT });
        }
      }
      break;
    }

    case 'smelter': {
      b.at(x, y, z).rot(0);
      b.box(1.0, 0.22, 1.0, 0x6d6960, { topColor: 0x8a857b, tex: TEX.GRAVEL });
      b.at(x, y + 0.22, z).rot(0);
      b.box(0.86, 0.95, 0.86, 0x8a857b, { topColor: 0x9a958b, tex: TEX.BRICK });
      /* The mouth, and what is going on inside it. */
      b.at(x, y + 0.34, z + 0.44).rot(0);
      b.box(0.44, 0.44, 0.06, 0x241c18, { centered: true, tex: TEX.FLAT });
      g.at(x, y + 0.34, z + 0.46).rot(0);
      g.box(0.34, 0.34, 0.04, 0xff9b4a, { centered: true });
      /* Chimney. */
      b.at(x - 0.22, y + 1.17, z - 0.22).rot(0);
      b.box(0.34, 0.5, 0.34, 0x7d7669, { topColor: 0x99948a, tex: TEX.STONE });
      break;
    }

    case 'door': {
      b.at(x, y, z).rot(0);
      for (const s of [-1, 1]) {
        b.at(x + s * 0.44, y, z).box(0.14, 1.6, 0.4, 0x5c432c, { topColor: 0x7a5a3c, tex: TEX.BARK });
      }
      if (!state.open) {
        b.at(x, y, z).box(0.76, 1.5, 0.22, 0x8a6a45, { topColor: 0xb08c5e, tex: TEX.PLANK });
        b.at(x + 0.26, y + 0.78, z + 0.13).box(0.10, 0.10, 0.06, 0x3e4550, { centered: true, tex: TEX.METAL });
      } else {
        b.at(x - 0.38, y, z + 0.3).rot(1.2);
        b.box(0.76, 1.5, 0.22, 0x8a6a45, { topColor: 0xb08c5e, tex: TEX.PLANK });
        b.rot(0);
      }
      break;
    }
    case 'floor': {
      b.at(x, y, z).rot(0);
      b.box(1.0, 0.09, 1.0, 0x7a5a3c, { topColor: 0xa07c52, tex: TEX.PLANK });
      break;
    }
    case 'bed': {
      b.at(x, y, z).rot(0);
      b.box(0.9, 0.16, 0.62, 0x6b5a48, { topColor: 0x8a7560, tex: TEX.HIDE });
      b.at(x - 0.3, y + 0.16, z).box(0.24, 0.12, 0.5, 0xd8cfc0, { topColor: 0xefe8dc, tex: TEX.CLOTH });
      break;
    }
    case 'plot': {
      /* Turned earth with a low board round it, and whatever is
         coming up rising out of it as it grows - a plot you planted
         an hour ago should not look like one you planted just now. */
      b.at(x, y, z).rot(0);
      b.box(1.0, 0.10, 1.0, 0x4a3524, { topColor: 0x5e442d, tex: TEX.DIRT || TEX.ROCK });
      for (const [ox, oz, w, d] of [[0, -0.5, 1.04, 0.08], [0, 0.5, 1.04, 0.08],
        [-0.5, 0, 0.08, 1.04], [0.5, 0, 0.08, 1.04]]) {
        b.at(x + ox, y + 0.10, z + oz).box(w, 0.09, d, 0x6b4f33, { topColor: 0x8a6742, tex: TEX.PLANK });
      }
      /* Three furrows, so bare soil still reads as worked ground. */
      for (let i = -1; i <= 1; i++) {
        b.at(x, y + 0.10, z + i * 0.3).box(0.86, 0.03, 0.10, 0x3b2a1c, { topColor: 0x48331f });
      }

      const grow = Math.max(0, Math.min(1, state.grow || 0));
      const tint = state.cropTint || 0x6fbf4a;
      if (state.seed && grow > 0.02) {
        /* Nine shoots on a grid, taller and wider as they come on. */
        const h = 0.10 + grow * 0.62;
        const wdt = 0.05 + grow * 0.07;
        for (let gz = -1; gz <= 1; gz++) {
          for (let gx = -1; gx <= 1; gx++) {
            const sx = x + gx * 0.28, sz = z + gz * 0.28;
            b.at(sx, y + 0.13, sz).box(wdt, h, wdt, 0x4e7a34, { topColor: 0x6b9c46, tex: TEX.LEAF || TEX.GRASS });
            if (grow > 0.55) {
              /* The head of it, which is the bit you are waiting for. */
              const hs = 0.07 + (grow - 0.55) * 0.22;
              b.at(sx, y + 0.13 + h, sz).box(hs, hs, hs, tint, { topColor: tint, centered: false });
            }
          }
        }
      }
      break;
    }

    case 'chest': {
      b.at(x, y, z).rot(0);
      b.box(0.74, 0.44, 0.56, 0x7a5a3c, { topColor: 0x9a7550, tex: TEX.PLANK });
      b.at(x, y + 0.44, z).taper(0.78, 0.22, 0.60, 0.72, 0x6b4f33, { topColor: 0x8a6742, tex: TEX.PLANK });
      b.at(x, y + 0.40, z + 0.29).box(0.16, 0.14, 0.05, 0xc9a24a, { centered: true, tex: TEX.METAL });
      break;
    }
    case 'torch_post': {
      b.at(x, y, z).rot(0);
      b.taper(0.13, 1.35, 0.13, 0.75, 0x5c432c, { topColor: 0x7a5a3c, tex: TEX.BARK });
      b.at(x, y + 1.35, z).box(0.2, 0.14, 0.2, 0x3a2e24, { topColor: 0x54423a, tex: TEX.BARK });
      g.at(x, y + 1.52, z).cone(0.14, 0.3, 5, 0xff9b3a, { topColor: 0xffe08a });
      break;
    }
    case 'turret': {
      b.at(x, y, z).rot(0);
      b.taper(0.56, 0.42, 0.56, 0.72, 0x59616f, { topColor: 0x7b8493, tex: TEX.METAL });
      b.at(x, y + 0.42, z).rot(state.angle || 0);
      b.box(0.34, 0.30, 0.34, 0x6d7583, { topColor: 0x99a2b0, tex: TEX.PANEL });
      b.at(x + Math.cos(state.angle || 0) * 0.3, y + 0.58, z + Math.sin(state.angle || 0) * 0.3)
        .rot(state.angle || 0);
      b.box(0.46, 0.12, 0.12, 0x3e4550, { centered: true, tex: TEX.METAL });
      b.rot(0);
      g.at(x, y + 0.76, z).box(0.14, 0.08, 0.14, 0x3fe0ff, { centered: true });
      break;
    }
    case 'dampener': {
      b.at(x, y, z).rot(0);
      b.taper(0.5, 0.9, 0.5, 0.5, 0x4f5a58, { topColor: 0x6d7a78, tex: TEX.METAL });
      b.at(x, y + 0.9, z).box(0.3, 0.16, 0.3, 0x394341, { topColor: 0x55625f, tex: TEX.PANEL });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * TAU + (state.t || 0);
        g.at(x + Math.cos(a) * 0.5, y + 0.62, z + Math.sin(a) * 0.5).rot(a);
        g.box(0.16, 0.04, 0.04, 0x63ff9d, { centered: true });
      }
      g.rot(0);
      break;
    }
    case 'lure': {
      b.at(x, y, z).rot(0);
      b.taper(0.44, 1.05, 0.44, 0.42, 0x6b4f52, { topColor: 0x8a6468, tex: TEX.RUST });
      b.at(x, y + 1.05, z).box(0.36, 0.26, 0.36, 0x59404a, { topColor: 0x7a5a64, tex: TEX.PANEL });
      g.at(x, y + 1.2, z).box(0.22, 0.22, 0.22, 0xff4fd8, { centered: true });
      for (let i = 0; i < 3; i++) {
        const s = 0.5 + i * 0.35;
        g.at(x, y + 1.2, z).rot(0);
        g.box(s, 0.03, s, 0xff4fd8, { centered: true });
      }
      break;
    }
    case 'sealpylon': {
      b.at(x, y, z).rot(0);
      b.box(1.0, 0.18, 1.0, 0x8d8497, { topColor: 0xa79db1, tex: TEX.TILE });
      b.at(x, y + 0.18, z).taper(0.5, 1.5, 0.5, 0.45, 0x6a5a7d, { topColor: 0x8b7aa3, tex: TEX.STONE });
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + 0.78;
        b.at(x + Math.cos(a) * 0.42, y + 0.18, z + Math.sin(a) * 0.42).rot(a);
        b.taper(0.14, 0.8, 0.14, 0.6, 0x55486a, { topColor: 0x7a6a92, tex: TEX.STONE });
      }
      g.at(x, y + 1.9, z).rot(state.t || 0);
      g.crystal(0.2, 0.6, 0x7ee8ff, { sides: 6, tipColor: 0xffffff });
      const prog = state.progress || 0;
      for (let i = 0; i < 12; i++) {
        if (i / 12 > prog) break;
        const a = (i / 12) * TAU;
        g.at(x + Math.cos(a) * 1.1, y + 0.24, z + Math.sin(a) * 1.1).rot(a);
        g.box(0.26, 0.02, 0.09, 0x7ee8ff, { centered: true });
      }
      g.rot(0);
      break;
    }
    default: {
      b.at(x, y, z).rot(0);
      b.box(0.8, 0.8, 0.8, 0x8a8a8a, { topColor: 0xb0b0b0, tex: TEX.STONE });
      break;
    }
  }
}

/* A ghost of what you are about to build, drawn where the cursor
   is: green if it would go down, red if it would not. */
export function makeGhostMaterial(ok) {
  return new THREE.MeshBasicMaterial({
    color: ok ? 0x63ff9d : 0xff5a5a,
    transparent: true, opacity: 0.42, depthWrite: false,
    toneMapped: false, fog: false,
  });
}
