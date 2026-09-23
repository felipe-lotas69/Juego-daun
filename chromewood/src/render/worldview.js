/* ============================================================
   worldview.js - turning world data into meshes

   The map is cut into chunks and each chunk becomes three meshes:
   lit geometry, self-lit geometry and water. Chunks are built and
   thrown away as the camera moves, with a per-frame budget so a
   long walk never stutters.

   Terrain is emitted face by face: a tile only grows sides where
   its neighbour is lower, so a plateau costs one quad per tile and
   the cliffs come for free.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { MeshBuilder } from './geom.js';
import { makeToonMaterial } from './materials.js';
import { buildProp, propLight, GROUND_COLORS, GROUND_TEX, WATER_COLOR, DEEP_COLOR, GLOW_SCALE, lerpHex } from './props.js';
import { TEX } from './textures.js';
import { buildStructure } from './structures.js';
import { BIOME, FLAG, PROP, SEA_LEVEL } from '../world/worldgen.js';
import { CHUNK, TILE, LEVEL_STEP } from '../core/config.js';
import { LAYER_WORLD } from './pipeline.js';

const CHECKER = 0.965;      /* second tile tone on the checker  */
const SKIRT = 3.0;          /* how far the map's rim hangs down */

export class WorldView {
  constructor(world, scene) {
    this.world = world;
    this.scene = scene;
    this.chunks = new Map();
    this.pending = [];
    this.buildBudget = 2;
    this.radius = 4;

    this.solidMat = makeToonMaterial({ vertexColors: true, rim: 0.55 });
    this.glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
    this.waterMat = makeToonMaterial({
      vertexColors: true, transparent: true, opacity: 0.80,
      emissive: 0x11525e, emissiveIntensity: 0.9, rim: 1.6, depthWrite: false,
    });

    this.group = new THREE.Group();
    this.group.name = 'world';
    scene.add(this.group);

    this.lightSites = [];      /* candidate point lights, filled per chunk */
    this.structures = [];
    this._buildStructures();
  }

  /* Landmarks are built once and kept: there are only a couple of
     dozen and they are what the player navigates by. */
  _buildStructures() {
    const b = new MeshBuilder(), g = new MeshBuilder();
    for (const lm of this.world.landmarks) {
      const { x, y, z } = lm;   /* worldgen already placed these */
      const lights = buildStructure(b, g, lm.kind, x, y, z, lm.variant || 0);
      if (lights) for (const l of lights) this.lightSites.push(l);
    }
    if (!b.isEmpty) {
      const mesh = new THREE.Mesh(b.build(), this.solidMat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.layers.set(LAYER_WORLD);
      this.group.add(mesh);
      this.structureMesh = mesh;
    }
    if (!g.isEmpty) {
      scaleGlow(g);
      const mesh = new THREE.Mesh(g.build(), this.glowMat);
      mesh.layers.set(LAYER_WORLD);
      this.group.add(mesh);
      this.structureGlow = mesh;
    }
  }

  chunkKey(cx, cy) { return cy * this.world.chunksPerSide + cx; }

  /* ------------------------------------------------------- streaming */
  update(cameraTarget, zoom) {
    const w = this.world;
    /* How far to keep chunks alive scales with how far out the
       camera is zoomed, plus one ring of slack. */
    this.radius = Math.ceil((zoom * 1.9 + 10) / (CHUNK * TILE)) + 1;
    const ctx = Math.floor((cameraTarget.x + w.size * TILE / 2) / (CHUNK * TILE));
    const cty = Math.floor((cameraTarget.z + w.size * TILE / 2) / (CHUNK * TILE));

    const want = new Set();
    for (let dy = -this.radius; dy <= this.radius; dy++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        const cx = ctx + dx, cy = cty + dy;
        if (cx < 0 || cy < 0 || cx >= w.chunksPerSide || cy >= w.chunksPerSide) continue;
        const key = this.chunkKey(cx, cy);
        want.add(key);
        if (!this.chunks.has(key) && !this.pendingHas(key)) {
          this.pending.push({ key, cx, cy, d: dx * dx + dy * dy });
        }
      }
    }

    /* Nearest first, so the ground under your feet always exists. */
    this.pending.sort((a, b) => a.d - b.d);
    let built = 0;
    while (this.pending.length && built < this.buildBudget) {
      const job = this.pending.shift();
      if (!want.has(job.key)) continue;
      this.buildChunk(job.cx, job.cy);
      built++;
    }

    for (const [key, chunk] of this.chunks) {
      if (!want.has(key)) { this.disposeChunk(key, chunk); }
    }
  }

  pendingHas(key) {
    for (const p of this.pending) if (p.key === key) return true;
    return false;
  }

  /* Builds every chunk in range at once - used on load so the first
     frame is already complete. */
  buildAllNear(center, rings) {
    const w = this.world;
    const ctx = Math.floor((center.x + w.size * TILE / 2) / (CHUNK * TILE));
    const cty = Math.floor((center.z + w.size * TILE / 2) / (CHUNK * TILE));
    for (let dy = -rings; dy <= rings; dy++) {
      for (let dx = -rings; dx <= rings; dx++) {
        const cx = ctx + dx, cy = cty + dy;
        if (cx < 0 || cy < 0 || cx >= w.chunksPerSide || cy >= w.chunksPerSide) continue;
        if (!this.chunks.has(this.chunkKey(cx, cy))) this.buildChunk(cx, cy);
      }
    }
  }

  disposeChunk(key, chunk) {
    for (const m of [chunk.solid, chunk.glow, chunk.water]) {
      if (!m) continue;
      this.group.remove(m);
      m.geometry.dispose();
    }
    for (const site of chunk.lights) {
      const i = this.lightSites.indexOf(site);
      if (i >= 0) this.lightSites.splice(i, 1);
    }
    this.chunks.delete(key);
  }

  /* Called when a prop is harvested or destroyed. */
  rebuildChunkAtTile(tx, ty) {
    const cx = Math.floor(tx / CHUNK), cy = Math.floor(ty / CHUNK);
    const key = this.chunkKey(cx, cy);
    const existing = this.chunks.get(key);
    if (existing) this.disposeChunk(key, existing);
    this.buildChunk(cx, cy);
  }

  /* ---------------------------------------------------- chunk meshes */
  buildChunk(cx, cy) {
    const w = this.world;
    const b = new MeshBuilder();
    const g = new MeshBuilder();
    const water = new MeshBuilder();
    const lights = [];

    const tx0 = cx * CHUNK, ty0 = cy * CHUNK;
    const tx1 = Math.min(w.size, tx0 + CHUNK), ty1 = Math.min(w.size, ty0 + CHUNK);

    for (let ty = ty0; ty < ty1; ty++) {
      for (let tx = tx0; tx < tx1; tx++) {
        const i = w.idx(tx, ty);
        const level = w.height[i];
        const flags = w.flags[i];
        const biome = w.biome[i];
        const y = level * LEVEL_STEP;
        const wx = w.tileToWorldX(tx), wz = w.tileToWorldZ(ty);

        const pal = GROUND_COLORS[biome] || GROUND_COLORS[BIOME.VERDANT];
        const tex = GROUND_TEX[biome] || GROUND_TEX[BIOME.VERDANT];
        let topTex = tex[0];
        if (flags & FLAG.ROAD) topTex = TEX.GRAVEL;
        let top = ((tx + ty) & 1) ? pal[0] : pal[1];
        if (flags & FLAG.ROAD) top = lerpHex(top, 0xa79db1, 0.72);
        /* A little per-tile drift stops large flats looking painted. */
        /* Snow settles on top of anything high and flat. */
        if (biome === BIOME.SNOW && level >= 13) top = lerpHex(top, 0xffffff, 0.22);
        const drift = ((w.variant[i] & 15) / 15 - 0.5) * 0.032;
        top = lerpHex(top, drift > 0 ? 0xffffff : 0x000000, Math.abs(drift));

        const nW = neighbourLevel(w, tx - 1, ty, level);
        const nE = neighbourLevel(w, tx + 1, ty, level);
        const nN = neighbourLevel(w, tx, ty - 1, level);
        const nS = neighbourLevel(w, tx, ty + 1, level);
        const minN = Math.min(nW, nE, nN, nS);

        if (minN < level) {
          const base = minN * LEVEL_STEP;
          const isRim = (flags & FLAG.BLOCKED_EDGE) !== 0;
          const sideCol = isRim ? lerpHex(pal[2], 0x2a2434, 0.4) : pal[2];
          b.at(wx, base, wz).rot(0).sc(1);
          b.box(TILE, y - base, TILE, sideCol, {
            topColor: top,
            topTex,
            tex: tex[1],
            faces: { ny: false, nx: nW < level, px: nE < level, nz: nN < level, pz: nS < level },
          });
          /* Darker band right under the lip: cheap ambient occlusion
             that survives the toon quantiser. */
          if (y - base > LEVEL_STEP * 0.9) {
            b.at(wx, base, wz);
            b.box(TILE * 1.001, (y - base) * 0.3, TILE * 1.001, lerpHex(pal[3], 0x000000, 0.25), {
              tex: tex[1],
              faces: { ny: false, py: false, nx: nW < level, px: nE < level, nz: nN < level, pz: nS < level },
            });
          }
        } else {
          b.at(wx, y, wz).rot(0).sc(1);
          b.ground(TILE, TILE, top, { yOff: 0, tex: topTex });
        }

        /* The outer rim drops away into nothing, so give it a skirt
           rather than letting the camera see under the world. */
        if (tx === 0 || ty === 0 || tx === w.size - 1 || ty === w.size - 1) {
          b.at(wx, y - SKIRT, wz);
          b.box(TILE, SKIRT, TILE, pal[3], { tex: TEX.ROCK, faces: { py: false, ny: false } });
        }

        if (flags & FLAG.WATER) {
          /* One surface for the whole sea, at sea level, rather than
             a sheet following the floor: that is what makes shallows
             read as shallow and the deep read as deep. */
          const surface = (flags & FLAG.RIVER) ? y + 0.22 : SEA_LEVEL * LEVEL_STEP + 0.20;
          const depth = Math.max(0, surface - y);
          water.at(wx, surface, wz).rot(0).sc(1);
          water.ground(TILE, TILE, depth > 0.9 ? DEEP_COLOR : WATER_COLOR, { yOff: 0, tex: TEX.WATER });
        }

        const prop = w.prop[i];
        if (prop !== PROP.NONE) {
          buildProp(b, g, prop, wx, y, wz, w.variant[i], biome);
          const l = propLight(prop, w.variant[i]);
          if (l) {
            const site = { x: wx, y: y + l.y, z: wz, color: l.color, intensity: l.intensity, range: l.range };
            lights.push(site);
            this.lightSites.push(site);
          }
        }
      }
    }

    const chunk = { solid: null, glow: null, water: null, lights };
    if (!b.isEmpty) {
      const mesh = new THREE.Mesh(b.build(), this.solidMat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.layers.set(LAYER_WORLD);
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      chunk.solid = mesh;
    }
    if (!g.isEmpty) {
      scaleGlow(g);
      const mesh = new THREE.Mesh(g.build(), this.glowMat);
      mesh.layers.set(LAYER_WORLD);
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      chunk.glow = mesh;
    }
    if (!water.isEmpty) {
      const mesh = new THREE.Mesh(water.build(), this.waterMat);
      mesh.receiveShadow = true;
      mesh.layers.set(LAYER_WORLD);
      mesh.matrixAutoUpdate = false;
      mesh.renderOrder = 1;
      this.group.add(mesh);
      chunk.water = mesh;
    }
    this.chunks.set(this.chunkKey(cx, cy), chunk);
    return chunk;
  }

  dispose() {
    for (const [key, chunk] of this.chunks) this.disposeChunk(key, chunk);
    if (this.structureMesh) this.structureMesh.geometry.dispose();
    if (this.structureGlow) this.structureGlow.geometry.dispose();
    this.scene.remove(this.group);
  }
}

/* Out of bounds counts as one step lower, so the map edge gets a
   visible lip instead of a floating plane. */
function neighbourLevel(w, tx, ty, fallbackLevel) {
  if (!w.inBounds(tx, ty)) return Math.max(0, fallbackLevel - 1);
  return w.height[w.idx(tx, ty)];
}

/* Self-lit geometry wants vertex colours above 1 so the bright pass
   sees it. The builder writes 0..1, so scale after the fact. */
function scaleGlow(builder) {
  const c = builder.col;
  for (let i = 0; i < c.length; i++) c[i] *= GLOW_SCALE;
}

export { scaleGlow };
