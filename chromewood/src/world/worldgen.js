/* ============================================================
   worldgen.js - the Chromewood itself

   Pure data: a seed in, typed arrays out. No three.js and no DOM,
   so the simulation running on a host and the view running on a
   joiner build byte-identical terrain from the same room code.

   The map is a fixed square arena rather than an endless world:
   a survival run wants a place you learn, with a beacon at its
   heart and landmarks you can navigate by.
   ============================================================ */

import { makeRng, hash2, fbm, ridge, worley } from '../core/rng.js';
import { WORLD_TILES, WORLD_HALF, TILE, LEVEL_STEP, CHUNK } from '../core/config.js';

export const BIOME = {
  VERDANT: 0,   /* ordinary forest: the safe middle ground        */
  BLOOM: 1,     /* arcane overgrowth, glowing and generous        */
  SCRAP: 2,     /* machine ruins, dense in salvage                */
  ASH: 3,       /* rift-burnt ground, where the worst things live */
  PLAZA: 4,     /* the flat stone around the beacon               */
};

export const PROP = {
  NONE: 0,
  TREE_PINE: 1, TREE_BLOOM: 2, DEAD_TREE: 3, STUMP: 4,
  ROCK: 5, BOULDER: 6, CRYSTAL: 7, RIFT_SHARD: 8,
  GRASS: 9, FLOWER: 10, MUSHROOM: 11, REED: 12,
  RUIN_WALL: 13, RUIN_PILLAR: 14, PYLON: 15, CONDUIT: 16,
  SCRAP_PILE: 17, ANTENNA: 18, CRATE: 19, LAMP: 20,
};

/* Which props stop a character, and which are just scenery. */
export const SOLID_PROPS = new Set([
  PROP.TREE_PINE, PROP.TREE_BLOOM, PROP.DEAD_TREE, PROP.BOULDER,
  PROP.CRYSTAL, PROP.RIFT_SHARD, PROP.RUIN_WALL, PROP.RUIN_PILLAR,
  PROP.PYLON, PROP.ANTENNA, PROP.CRATE,
]);

/* Props you can break for resources: [resource, amount, hp]. */
export const HARVESTABLE = {
  [PROP.CRYSTAL]: { res: 'essence', amount: 4, hp: 40 },
  [PROP.RIFT_SHARD]: { res: 'essence', amount: 6, hp: 55 },
  [PROP.SCRAP_PILE]: { res: 'scrap', amount: 4, hp: 30 },
  [PROP.CONDUIT]: { res: 'scrap', amount: 3, hp: 26 },
  [PROP.CRATE]: { res: 'scrap', amount: 5, hp: 22 },
  [PROP.TREE_BLOOM]: { res: 'essence', amount: 2, hp: 45 },
  [PROP.DEAD_TREE]: { res: 'scrap', amount: 1, hp: 35 },
};

export const FLAG = {
  WATER: 1,
  SOLID: 2,
  PLAZA: 4,
  ROAD: 8,
  BLOCKED_EDGE: 16,
};

export const MAX_LEVEL = 4;

export class World {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.size = WORLD_TILES;
    const n = this.size * this.size;
    this.height = new Uint8Array(n);
    this.biome = new Uint8Array(n);
    this.flags = new Uint8Array(n);
    this.prop = new Uint8Array(n);
    this.variant = new Uint8Array(n);
    /* Damage taken by harvestable props, cleared when they break. */
    this.propHp = new Map();
    this.landmarks = [];
    this.spawnPoints = [];
    this.chunksPerSide = Math.ceil(this.size / CHUNK);
    this.generate();
  }

  idx(tx, ty) { return ty * this.size + tx; }
  inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < this.size && ty < this.size; }

  /* Tile <-> world conversions. The grid is centred on the origin
     so the beacon sits at (0, 0). */
  tileToWorldX(tx) { return (tx + 0.5) * TILE - WORLD_HALF; }
  tileToWorldZ(ty) { return (ty + 0.5) * TILE - WORLD_HALF; }
  worldToTileX(x) { return Math.floor((x + WORLD_HALF) / TILE); }
  worldToTileZ(z) { return Math.floor((z + WORLD_HALF) / TILE); }

  levelAt(tx, ty) {
    if (!this.inBounds(tx, ty)) return 0;
    return this.height[this.idx(tx, ty)];
  }

  heightAtTile(tx, ty) { return this.levelAt(tx, ty) * LEVEL_STEP; }

  /* Ground height under a world position, bilinearly smoothed so
     characters do not pop between tiles. */
  groundAt(x, z) {
    const fx = (x + WORLD_HALF) / TILE - 0.5;
    const fz = (z + WORLD_HALF) / TILE - 0.5;
    const x0 = Math.floor(fx), z0 = Math.floor(fz);
    const tx = fx - x0, tz = fz - z0;
    const h00 = this.levelAt(x0, z0), h10 = this.levelAt(x0 + 1, z0);
    const h01 = this.levelAt(x0, z0 + 1), h11 = this.levelAt(x0 + 1, z0 + 1);
    const a = h00 + (h10 - h00) * tx;
    const b = h01 + (h11 - h01) * tx;
    return (a + (b - a) * tz) * LEVEL_STEP;
  }

  flagAt(x, z) {
    const tx = this.worldToTileX(x), ty = this.worldToTileZ(z);
    if (!this.inBounds(tx, ty)) return FLAG.SOLID;
    return this.flags[this.idx(tx, ty)];
  }

  biomeAt(x, z) {
    const tx = this.worldToTileX(x), ty = this.worldToTileZ(z);
    if (!this.inBounds(tx, ty)) return BIOME.VERDANT;
    return this.biome[this.idx(tx, ty)];
  }

  isSolidTile(tx, ty) {
    if (!this.inBounds(tx, ty)) return true;
    return (this.flags[this.idx(tx, ty)] & FLAG.SOLID) !== 0;
  }

  /* Movement blocker test in world space. Cliffs of two steps or
     more are walls; a single step is a scramble you can take. */
  blockedAt(x, z, fromLevel) {
    const tx = this.worldToTileX(x), ty = this.worldToTileZ(z);
    if (!this.inBounds(tx, ty)) return true;
    const i = this.idx(tx, ty);
    if (this.flags[i] & FLAG.SOLID) return true;
    if (fromLevel !== undefined && Math.abs(this.height[i] - fromLevel) >= 2) return true;
    return false;
  }

  setProp(tx, ty, prop) {
    const i = this.idx(tx, ty);
    this.prop[i] = prop;
    if (SOLID_PROPS.has(prop)) this.flags[i] |= FLAG.SOLID;
    else this.flags[i] &= ~FLAG.SOLID;
  }

  clearProp(tx, ty) {
    const i = this.idx(tx, ty);
    this.prop[i] = PROP.NONE;
    this.flags[i] &= ~FLAG.SOLID;
    this.propHp.delete(i);
  }

  /* ------------------------------------------------------- generation */
  generate() {
    const S = this.seed;
    const n = this.size;
    const cx = n / 2, cy = n / 2;

    /* Elevation is built as a float field first and normalised over
       the whole map. Raw fbm clusters around its mean, so without
       this the quantiser would only ever use two of the levels. */
    const ef = new Float32Array(n * n);
    const wf = new Float32Array(n * n);
    let lo = Infinity, hi = -Infinity;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = this.idx(tx, ty);
        const nx = tx * 0.021, ny = ty * 0.021;
        /* Broad fbm shaped by a ridge, so plateaus get flat tops
           and abrupt sides instead of round hills. */
        const e = fbm(nx, ny, S, 4) * 0.66 + ridge(nx * 0.7 + 11.3, ny * 0.7 - 4.1, S + 991, 3) * 0.34;
        ef[i] = e;
        wf[i] = fbm(nx * 1.6 + 30.7, ny * 1.6 - 12.2, S + 3313, 3);
        if (e < lo) lo = e;
        if (e > hi) hi = e;
      }
    }
    const span = Math.max(1e-5, hi - lo);

    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = this.idx(tx, ty);
        let e = (ef[i] - lo) / span;

        const dx = (tx - cx) / cx, dy = (ty - cy) / cy;
        const d = Math.sqrt(dx * dx + dy * dy);

        /* The arena is a disc. Past the rim the ground rears up into
           an unclimbable ring of cliffs, which is a wall you can read
           at a glance instead of an invisible one. */
        const plaza = Math.max(0, 1 - d / 0.075);
        e = e * (1 - plaza) + 0.45 * plaza;
        if (d > 0.80) e += Math.pow((d - 0.80) / 0.20, 1.6) * 1.35;

        let level = Math.round(e * MAX_LEVEL);
        level = Math.max(0, Math.min(MAX_LEVEL, level));
        this.height[i] = level;

        if (d >= 0.95) {
          this.height[i] = MAX_LEVEL;
          this.flags[i] |= FLAG.SOLID | FLAG.BLOCKED_EDGE;
          this.biome[i] = BIOME.ASH;
          continue;
        }

        /* Water pools in the low basins where the moisture field
           agrees, and never on the plaza. */
        if (e < 0.22 && wf[i] > 0.50 && d < 0.70 && plaza <= 0) {
          this.flags[i] |= FLAG.WATER;
          this.height[i] = Math.min(this.height[i], 0);
        }

        /* Biomes are worley blobs warped by fbm, so borders
           interlock rather than looking like circles. Corruption
           weights up with distance: the map gets worse the further
           out you go, which is the whole risk curve. */
        const nx = tx * 0.021, ny = ty * 0.021;
        const wx = tx * 0.044 + fbm(nx * 2, ny * 2, S + 77, 2) * 1.7;
        const wy = ty * 0.044 + fbm(nx * 2 + 9, ny * 2 + 3, S + 78, 2) * 1.7;
        const cell = worley(wx, wy, S + 4242);
        const pick = hash2(Math.floor(wx), Math.floor(wy), S + 555);

        let biome = BIOME.VERDANT;
        if (plaza > 0.3) biome = BIOME.PLAZA;
        else if (cell < 0.50) {
          const ashBias = Math.max(0, (d - 0.42) / 0.45);
          if (pick < 0.12 + ashBias * 0.34) biome = BIOME.ASH;
          else if (pick < 0.56) biome = BIOME.BLOOM;
          else biome = BIOME.SCRAP;
        } else if (d > 0.90) biome = BIOME.ASH;
        this.biome[i] = biome;
        if (biome === BIOME.PLAZA) this.flags[i] |= FLAG.PLAZA;
      }
    }

    this._carveRoads();
    this._scatterProps();
    this._placeLandmarks();
  }

  /* Four stone paths out of the plaza. They read as ruins of a
     road network and give the player fast, readable lanes. */
  _carveRoads() {
    const n = this.size, c = Math.floor(n / 2);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const [dx, dy] of dirs) {
      let x = c, y = c;
      let drift = 0;
      for (let step = 0; step < n * 0.46; step++) {
        drift += (hash2(Math.floor(x), Math.floor(y), this.seed + 8123) - 0.5) * 0.9;
        drift = Math.max(-6, Math.min(6, drift));
        const px = Math.round(x + (dy !== 0 ? drift : 0));
        const py = Math.round(y + (dx !== 0 ? drift : 0));
        for (let w = -1; w <= 1; w++) {
          const tx = px + (dy !== 0 ? w : 0);
          const ty = py + (dx !== 0 ? w : 0);
          if (!this.inBounds(tx, ty)) continue;
          const i = this.idx(tx, ty);
          this.flags[i] |= FLAG.ROAD;
          this.flags[i] &= ~FLAG.WATER;
          /* Smooth the road so it never runs into a cliff face. */
          const around = [
            this.levelAt(tx - 1, ty), this.levelAt(tx + 1, ty),
            this.levelAt(tx, ty - 1), this.levelAt(tx, ty + 1),
          ];
          const avg = Math.round(around.reduce((a, b) => a + b, 0) / 4);
          this.height[i] = Math.max(0, Math.min(MAX_LEVEL, avg));
        }
        x += dx; y += dy;
      }
    }
    /* A road only reads as a road if you can walk it, so knock any
       remaining two-step ledges along it down to one. */
    for (let pass = 0; pass < 2; pass++) {
      for (let ty = 1; ty < this.size - 1; ty++) {
        for (let tx = 1; tx < this.size - 1; tx++) {
          const i = this.idx(tx, ty);
          if (!(this.flags[i] & (FLAG.ROAD | FLAG.PLAZA))) continue;
          const h = this.height[i];
          for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const j = this.idx(tx + ox, ty + oy);
            if (this.height[j] - h >= 2) this.height[j] = h + 1;
            else if (h - this.height[j] >= 2) this.height[j] = h - 1;
          }
        }
      }
    }
  }

  _scatterProps() {
    const n = this.size;
    const rng = makeRng(this.seed ^ 0x9e3779b9);
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = this.idx(tx, ty);
        const f = this.flags[i];
        if (f & (FLAG.ROAD | FLAG.PLAZA)) {
          /* Roadside dressing only. */
          if (rng.chance(0.045)) this.setProp(tx, ty, PROP.GRASS);
          this.variant[i] = rng.int(255);
          continue;
        }
        this.variant[i] = rng.int(255);
        if (f & FLAG.WATER) {
          if (rng.chance(0.10)) this.setProp(tx, ty, PROP.REED);
          continue;
        }

        const biome = this.biome[i];
        /* Density falls off where the ground is steep, so cliff
           edges stay legible. */
        const steep = Math.abs(this.levelAt(tx + 1, ty) - this.levelAt(tx - 1, ty))
                    + Math.abs(this.levelAt(tx, ty + 1) - this.levelAt(tx, ty - 1));
        const openness = steep > 1 ? 0.35 : 1;

        const roll = rng();
        const table = PROP_TABLES[biome];
        let acc = 0, chosen = PROP.NONE;
        for (const entry of table) {
          acc += entry.p * openness;
          if (roll < acc) { chosen = entry.prop; break; }
        }
        if (chosen !== PROP.NONE) this.setProp(tx, ty, chosen);
      }
    }

    /* Trees crowded shoulder to shoulder make the map unreadable
       and unwalkable, so thin solid props that have solid
       neighbours on both axes. */
    for (let ty = 1; ty < n - 1; ty++) {
      for (let tx = 1; tx < n - 1; tx++) {
        const i = this.idx(tx, ty);
        if (!(this.flags[i] & FLAG.SOLID)) continue;
        const around = (this.isSolidTile(tx - 1, ty) ? 1 : 0) + (this.isSolidTile(tx + 1, ty) ? 1 : 0)
                     + (this.isSolidTile(tx, ty - 1) ? 1 : 0) + (this.isSolidTile(tx, ty + 1) ? 1 : 0);
        if (around >= 3) this.clearProp(tx, ty);
      }
    }
  }

  /* Landmarks are hand-placed structures the run is built around:
     the beacon, salvage caches, rift gates and shrines. */
  _placeLandmarks() {
    const rng = makeRng(this.seed ^ 0x517cc1b7);
    const n = this.size, c = n / 2;

    this.landmarks.push({ kind: 'beacon', tx: Math.floor(c), ty: Math.floor(c) });

    const ringPlace = (kind, count, minR, maxR, clearRadius) => {
      for (let k = 0; k < count; k++) {
        for (let attempt = 0; attempt < 60; attempt++) {
          const ang = rng() * Math.PI * 2;
          const rad = rng.range(minR, maxR) * c;
          const tx = Math.round(c + Math.cos(ang) * rad);
          const ty = Math.round(c + Math.sin(ang) * rad);
          if (!this.inBounds(tx + 3, ty + 3) || !this.inBounds(tx - 3, ty - 3)) continue;
          if (this.flags[this.idx(tx, ty)] & FLAG.WATER) continue;
          const tooClose = this.landmarks.some(l =>
            Math.abs(l.tx - tx) < 14 && Math.abs(l.ty - ty) < 14);
          if (tooClose) continue;
          this._flatten(tx, ty, clearRadius);
          this.landmarks.push({ kind, tx, ty, variant: rng.int(255) });
          break;
        }
      }
    };

    ringPlace('cache', 6, 0.22, 0.80, 2);
    ringPlace('rift', 4, 0.42, 0.86, 3);
    ringPlace('shrine', 3, 0.26, 0.70, 2);
    ringPlace('wreck', 5, 0.20, 0.84, 3);

    /* Beacon plaza: flat, clear and paved. */
    this._flatten(Math.floor(c), Math.floor(c), 7);
    for (let ty = Math.floor(c) - 7; ty <= Math.floor(c) + 7; ty++) {
      for (let tx = Math.floor(c) - 7; tx <= Math.floor(c) + 7; tx++) {
        if (!this.inBounds(tx, ty)) continue;
        const i = this.idx(tx, ty);
        this.biome[i] = BIOME.PLAZA;
        this.flags[i] |= FLAG.PLAZA;
        this.flags[i] &= ~FLAG.WATER;
      }
    }

    /* World coordinates belong with the landmark, not with whoever
       happens to draw it: the headless host has no view layer and
       still needs to know where the beacon is. Computed last, after
       every flatten has settled the heights. */
    for (const lm of this.landmarks) {
      lm.x = this.tileToWorldX(lm.tx);
      lm.z = this.tileToWorldZ(lm.ty);
      lm.y = this.heightAtTile(lm.tx, lm.ty);
    }

    /* Spawn ring just outside the plaza. */
    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      const tx = Math.round(c + Math.cos(ang) * 5.5);
      const ty = Math.round(c + Math.sin(ang) * 5.5);
      this.spawnPoints.push({ x: this.tileToWorldX(tx), z: this.tileToWorldZ(ty) });
    }
  }

  _flatten(cx, cy, radius) {
    if (!this.inBounds(cx, cy)) return;
    const target = this.height[this.idx(cx, cy)];
    for (let ty = cy - radius - 1; ty <= cy + radius + 1; ty++) {
      for (let tx = cx - radius - 1; tx <= cx + radius + 1; tx++) {
        if (!this.inBounds(tx, ty)) continue;
        const d = Math.hypot(tx - cx, ty - cy);
        const i = this.idx(tx, ty);
        if (d <= radius) {
          this.height[i] = target;
          this.clearProp(tx, ty);
          this.flags[i] &= ~FLAG.WATER;
        } else if (d <= radius + 1) {
          /* One-step apron so the flattened pad is reachable. */
          const h = this.height[i];
          if (Math.abs(h - target) >= 2) this.height[i] = target + Math.sign(h - target);
        }
      }
    }
  }

  /* Chunk helpers used by the view layer. */
  chunkIndex(cx, cy) { return cy * this.chunksPerSide + cx; }
  chunkCenter(cx, cy) {
    return {
      x: this.tileToWorldX(cx * CHUNK + CHUNK / 2) - TILE / 2,
      z: this.tileToWorldZ(cy * CHUNK + CHUNK / 2) - TILE / 2,
    };
  }
}

/* Scatter tables: probability per tile, evaluated in order. */
const PROP_TABLES = {
  [BIOME.VERDANT]: [
    { prop: PROP.TREE_PINE, p: 0.115 },
    { prop: PROP.GRASS, p: 0.190 },
    { prop: PROP.ROCK, p: 0.035 },
    { prop: PROP.BOULDER, p: 0.016 },
    { prop: PROP.MUSHROOM, p: 0.028 },
    { prop: PROP.FLOWER, p: 0.032 },
    { prop: PROP.STUMP, p: 0.010 },
  ],
  [BIOME.BLOOM]: [
    { prop: PROP.TREE_BLOOM, p: 0.090 },
    { prop: PROP.CRYSTAL, p: 0.042 },
    { prop: PROP.GRASS, p: 0.150 },
    { prop: PROP.FLOWER, p: 0.070 },
    { prop: PROP.MUSHROOM, p: 0.048 },
    { prop: PROP.ROCK, p: 0.022 },
  ],
  [BIOME.SCRAP]: [
    { prop: PROP.RUIN_WALL, p: 0.052 },
    { prop: PROP.RUIN_PILLAR, p: 0.026 },
    { prop: PROP.SCRAP_PILE, p: 0.055 },
    { prop: PROP.CONDUIT, p: 0.038 },
    { prop: PROP.PYLON, p: 0.020 },
    { prop: PROP.CRATE, p: 0.022 },
    { prop: PROP.GRASS, p: 0.075 },
    { prop: PROP.ANTENNA, p: 0.010 },
    { prop: PROP.LAMP, p: 0.012 },
  ],
  [BIOME.ASH]: [
    { prop: PROP.DEAD_TREE, p: 0.085 },
    { prop: PROP.RIFT_SHARD, p: 0.040 },
    { prop: PROP.ROCK, p: 0.048 },
    { prop: PROP.BOULDER, p: 0.022 },
    { prop: PROP.STUMP, p: 0.026 },
    { prop: PROP.GRASS, p: 0.040 },
  ],
  [BIOME.PLAZA]: [
    { prop: PROP.GRASS, p: 0.02 },
  ],
};

export { PROP_TABLES };
