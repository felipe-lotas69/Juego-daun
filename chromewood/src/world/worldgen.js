/* ============================================================
   worldgen.js - the Chromewood

   Pure data: a seed in, typed arrays out. No three.js and no DOM,
   so a host and a joining client build byte-identical terrain from
   the same room code.

   The shape of a map: a continent with a coast, a spine of
   mountains, rivers that run from the peaks to the sea, and a ruined
   plaza at the middle where the beacon stands. Machine wreckage and
   arcane overgrowth are laid over that as patches, and the further
   out you go the more corrupted it gets.

   Height is the thing the old version did not have. Sixteen levels
   means real cliffs, and real cliffs mean places you cannot simply
   walk to - so generation ends with a pass that guarantees you can
   reach everything worth reaching, by cutting steps into the rock
   rather than by flattening it.
   ============================================================ */

import { makeRng, hash2, fbm, ridge, worley } from '../core/rng.js';
import { WORLD_TILES, WORLD_HALF, TILE, LEVEL_STEP, CHUNK } from '../core/config.js';

export const MAX_LEVEL = 16;
/* The only heights land is ever at. Two levels apart, so every
   change of plateau is a cliff a body cannot simply walk up. */
export const PLATEAUS = [0, 2, 4, 6, 8, 10, 12, 14, 16];
export const SEA_LEVEL = 2;          /* levels at or below this are water */

export const BIOME = {
  OCEAN: 0,
  BEACH: 1,
  MEADOW: 2,
  FOREST: 3,
  PINE: 4,
  HIGHLAND: 5,
  SNOW: 6,
  MARSH: 7,
  BLOOM: 8,
  SCRAP: 9,
  ASH: 10,
  PLAZA: 11,
};

export const BIOME_NAME = {
  [BIOME.OCEAN]: 'Shallows', [BIOME.BEACH]: 'Shore', [BIOME.MEADOW]: 'Meadow',
  [BIOME.FOREST]: 'Chromewood', [BIOME.PINE]: 'Pinehold', [BIOME.HIGHLAND]: 'Crags',
  [BIOME.SNOW]: 'Whitecap', [BIOME.MARSH]: 'Sump', [BIOME.BLOOM]: 'Bloomwood',
  [BIOME.SCRAP]: 'Scrapfield', [BIOME.ASH]: 'Ashlands', [BIOME.PLAZA]: 'The Plaza',
};

export const PROP = {
  NONE: 0,
  TREE_PINE: 1, TREE_OAK: 2, TREE_BIRCH: 3, TREE_BLOOM: 4, TREE_DEAD: 5, TREE_SNOW: 6, STUMP: 7,
  BUSH: 8, BERRY_BUSH: 9, GRASS: 10, FLOWER: 11, MUSHROOM: 12, REED: 13, FERN: 14,
  ROCK: 15, BOULDER: 16, ROCK_TALL: 17,
  ORE_COPPER: 18, ORE_IRON: 19, ORE_GOLD: 20, ORE_ESSENCE: 21,
  CRYSTAL: 22, RIFT_SHARD: 23,
  RUIN_WALL: 24, RUIN_PILLAR: 25, PYLON: 26, CONDUIT: 27, SCRAP_PILE: 28,
  ANTENNA: 29, CRATE: 30, LAMP: 31,
  BONES: 32, ICE_SPIKE: 33, SNOW_ROCK: 34,
};

/* Props that stop a body. */
export const SOLID_PROPS = new Set([
  PROP.TREE_PINE, PROP.TREE_OAK, PROP.TREE_BIRCH, PROP.TREE_BLOOM, PROP.TREE_DEAD,
  PROP.TREE_SNOW, PROP.BOULDER, PROP.ROCK_TALL, PROP.CRYSTAL, PROP.RIFT_SHARD,
  PROP.RUIN_WALL, PROP.RUIN_PILLAR, PROP.PYLON, PROP.ANTENNA, PROP.CRATE,
  PROP.ORE_COPPER, PROP.ORE_IRON, PROP.ORE_GOLD, PROP.ORE_ESSENCE, PROP.ICE_SPIKE,
]);

/* What a prop gives up when you break it, and what it takes to do
   it. `tier` is the tool tier required to get anything at all:
   0 bare hands, 1 stone, 2 iron, 3 arcane. `tool` names the kind of
   tool that is efficient against it. */
export const HARVEST = {
  [PROP.TREE_PINE]:   { tool: 'axe',  tier: 0, hp: 60, yield: [['wood', 5], ['fiber', 1]] },
  [PROP.TREE_OAK]:    { tool: 'axe',  tier: 0, hp: 75, yield: [['wood', 7], ['fiber', 1]] },
  [PROP.TREE_BIRCH]:  { tool: 'axe',  tier: 0, hp: 55, yield: [['wood', 5], ['fiber', 2]] },
  [PROP.TREE_BLOOM]:  { tool: 'axe',  tier: 1, hp: 80, yield: [['wood', 4], ['essence', 3]] },
  [PROP.TREE_DEAD]:   { tool: 'axe',  tier: 0, hp: 45, yield: [['wood', 3]] },
  [PROP.TREE_SNOW]:   { tool: 'axe',  tier: 0, hp: 65, yield: [['wood', 6], ['resin', 1]] },
  [PROP.STUMP]:       { tool: 'axe',  tier: 0, hp: 30, yield: [['wood', 2]] },
  [PROP.BUSH]:        { tool: 'hand', tier: 0, hp: 12, yield: [['fiber', 3]] },
  [PROP.BERRY_BUSH]:  { tool: 'hand', tier: 0, hp: 12, yield: [['fiber', 2], ['berries', 3]] },
  [PROP.GRASS]:       { tool: 'hand', tier: 0, hp: 4,  yield: [['fiber', 1]] },
  [PROP.FERN]:        { tool: 'hand', tier: 0, hp: 6,  yield: [['fiber', 2]] },
  [PROP.MUSHROOM]:    { tool: 'hand', tier: 0, hp: 4,  yield: [['mushroom', 2]] },
  [PROP.REED]:        { tool: 'hand', tier: 0, hp: 5,  yield: [['fiber', 2]] },
  [PROP.FLOWER]:      { tool: 'hand', tier: 0, hp: 3,  yield: [['petal', 1]] },
  [PROP.ROCK]:        { tool: 'pick', tier: 0, hp: 25, yield: [['stone', 3]] },
  [PROP.BOULDER]:     { tool: 'pick', tier: 0, hp: 70, yield: [['stone', 8], ['flint', 1]] },
  [PROP.ROCK_TALL]:   { tool: 'pick', tier: 1, hp: 90, yield: [['stone', 10], ['flint', 2]] },
  [PROP.SNOW_ROCK]:   { tool: 'pick', tier: 0, hp: 30, yield: [['stone', 4]] },
  [PROP.ORE_COPPER]:  { tool: 'pick', tier: 1, hp: 110, yield: [['copper_ore', 5], ['stone', 3]] },
  [PROP.ORE_IRON]:    { tool: 'pick', tier: 1, hp: 150, yield: [['iron_ore', 5], ['stone', 3]] },
  [PROP.ORE_GOLD]:    { tool: 'pick', tier: 2, hp: 190, yield: [['gold_ore', 4], ['stone', 3]] },
  [PROP.ORE_ESSENCE]: { tool: 'pick', tier: 2, hp: 210, yield: [['essence', 8], ['stone', 2]] },
  [PROP.CRYSTAL]:     { tool: 'pick', tier: 1, hp: 95, yield: [['essence', 6]] },
  [PROP.RIFT_SHARD]:  { tool: 'pick', tier: 2, hp: 130, yield: [['riftglass', 3], ['essence', 4]] },
  [PROP.SCRAP_PILE]:  { tool: 'hand', tier: 0, hp: 35, yield: [['scrap', 5]] },
  [PROP.CONDUIT]:     { tool: 'pick', tier: 0, hp: 40, yield: [['scrap', 3], ['wire', 2]] },
  [PROP.CRATE]:       { tool: 'hand', tier: 0, hp: 28, yield: [['scrap', 3], ['wood', 2]] },
  [PROP.RUIN_WALL]:   { tool: 'pick', tier: 1, hp: 120, yield: [['stone', 6]] },
  [PROP.RUIN_PILLAR]: { tool: 'pick', tier: 1, hp: 140, yield: [['stone', 8]] },
  [PROP.LAMP]:        { tool: 'pick', tier: 0, hp: 45, yield: [['scrap', 4], ['wire', 1]] },
  [PROP.ANTENNA]:     { tool: 'pick', tier: 1, hp: 100, yield: [['scrap', 8], ['wire', 3]] },
  [PROP.PYLON]:       { tool: 'pick', tier: 2, hp: 180, yield: [['scrap', 10], ['wire', 5], ['essence', 2]] },
  [PROP.BONES]:       { tool: 'hand', tier: 0, hp: 20, yield: [['bone', 3]] },
  [PROP.ICE_SPIKE]:   { tool: 'pick', tier: 1, hp: 60, yield: [['ice', 3]] },
};

export const FLAG = {
  WATER: 1,
  SOLID: 2,
  PLAZA: 4,
  ROAD: 8,
  BLOCKED_EDGE: 16,
  RIVER: 32,
  BUILT: 64,        /* a player structure stands here */
  SHALLOW: 128,
};

/* How far a body can climb in one step. Two levels is a scramble;
   three is a cliff. */
export const CLIMB = 1;

export class World {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.size = WORLD_TILES;
    const n = this.size * this.size;
    this.height = new Uint8Array(n);
    this.biome = new Uint8Array(n);
    this.flags = new Uint16Array(n);
    this.prop = new Uint8Array(n);
    this.variant = new Uint8Array(n);
    this.propHp = new Map();
    this.landmarks = [];
    this.spawnPoints = [];
    this.chunksPerSide = Math.ceil(this.size / CHUNK);
    this.stats = {};
    this.generate();
  }

  idx(tx, ty) { return ty * this.size + tx; }
  inBounds(tx, ty) { return tx >= 0 && ty >= 0 && tx < this.size && ty < this.size; }

  tileToWorldX(tx) { return (tx + 0.5) * TILE - WORLD_HALF; }
  tileToWorldZ(ty) { return (ty + 0.5) * TILE - WORLD_HALF; }
  worldToTileX(x) { return Math.floor((x + WORLD_HALF) / TILE); }
  worldToTileZ(z) { return Math.floor((z + WORLD_HALF) / TILE); }

  levelAt(tx, ty) {
    if (!this.inBounds(tx, ty)) return 0;
    return this.height[this.idx(tx, ty)];
  }

  heightAtTile(tx, ty) { return this.levelAt(tx, ty) * LEVEL_STEP; }

  /* Bilinear so a body walking across tiles rises smoothly instead
     of popping a whole step at the boundary. */
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
    if (!this.inBounds(tx, ty)) return BIOME.ASH;
    return this.biome[this.idx(tx, ty)];
  }

  propAt(x, z) {
    const tx = this.worldToTileX(x), ty = this.worldToTileZ(z);
    if (!this.inBounds(tx, ty)) return PROP.NONE;
    return this.prop[this.idx(tx, ty)];
  }

  isSolidTile(tx, ty) {
    if (!this.inBounds(tx, ty)) return true;
    return (this.flags[this.idx(tx, ty)] & FLAG.SOLID) !== 0;
  }

  /* Can a body at `fromLevel` stand here? Deep water and cliffs of
     more than CLIMB steps are the two things that say no. */
  blockedAt(x, z, fromLevel) {
    const tx = this.worldToTileX(x), ty = this.worldToTileZ(z);
    if (!this.inBounds(tx, ty)) return true;
    const i = this.idx(tx, ty);
    const f = this.flags[i];
    if (f & FLAG.SOLID) return true;
    if ((f & FLAG.WATER) && !(f & FLAG.SHALLOW)) return true;
    if (fromLevel !== undefined && Math.abs(this.height[i] - fromLevel) > CLIMB) return true;
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
    if (!(this.flags[i] & FLAG.BUILT)) this.flags[i] &= ~FLAG.SOLID;
    this.propHp.delete(i);
  }

  /* ------------------------------------------------- generation */
  generate() {
    const t0 = Date.now();
    this._elevation();
    this._water();
    this._shallows();
    this._biomes();
    this._plaza();
    this._connect();
    this._scatter();
    this._starterGround();
    this._ore();
    this._landmarks();
    this.stats.genMs = Date.now() - t0;
  }

  /* Continent, mountains, valleys. Built as a float field and
     normalised, because raw fbm clusters around its mean and would
     only ever use three of the sixteen levels. */
  _elevation() {
    const S = this.seed, n = this.size;
    const ef = new Float32Array(n * n);
    this.moisture = new Float32Array(n * n);
    this.temperature = new Float32Array(n * n);
    const cx = n / 2, cy = n / 2;
    let lo = Infinity, hi = -Infinity;

    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = this.idx(tx, ty);
        const nx = tx * 0.014, ny = ty * 0.014;

        /* Three scales, each with enough amplitude to cross a
           terrace boundary on its own. Relief that only exists in
           the lowest octave gives plateaus seventy tiles wide, which
           is a flat world with a slope, not a landscape. */
        let e = fbm(nx, ny, S, 3) * 0.50;                       /* continent */
        e += fbm(nx * 3.1, ny * 3.1, S + 11, 3) * 0.30;         /* hills     */
        e += fbm(nx * 8.0, ny * 8.0, S + 313, 2) * 0.09;        /* roughness */

        /* A spine of mountains: ridged noise, raised to a power so
           the ridges stay sharp and the ground between stays low. */
        const r = ridge(nx * 0.75 + 31.7, ny * 0.75 - 12.3, S + 991, 4);
        const mountainMask = Math.max(0, fbm(nx * 0.40 + 7, ny * 0.40 + 19, S + 555, 2) - 0.40) / 0.60;
        e += Math.pow(r, 1.7) * mountainMask * 1.30;

        /* Coast: a radial falloff makes an island rather than a
           square, so the edge of the map is sea and not a wall. */
        const dx = (tx - cx) / cx, dy = (ty - cy) / cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const coast = 1 - Math.pow(Math.max(0, (d - 0.70) / 0.30), 1.6);
        e = e * Math.max(0, coast);

        ef[i] = e;

        this.moisture[i] = fbm(nx * 1.7 + 61.3, ny * 1.7 - 28.9, S + 3313, 4);
        /* Cooler with height and toward one edge, so snow has a side. */
        /* Warm base, cooled by latitude; height is subtracted later
           so the same field can decide both snow line and treeline. */
        this.temperature[i] = 0.42 + fbm(nx * 0.9 - 14.2, ny * 0.9 + 44.1, S + 7717, 3) * 0.46
          + (1 - ty / n) * 0.22;
      }
    }

    /* Normalise on percentiles, not on min and max. A single
       ridge peak or one deep corner would otherwise squash every
       other tile into a narrow band, which is how a whole continent
       ends up at the same altitude. */
    const sample = [];
    for (let i = 0; i < n * n; i += 7) sample.push(ef[i]);
    sample.sort((a, b) => a - b);
    lo = sample[Math.floor(sample.length * 0.015)];
    hi = sample[Math.floor(sample.length * 0.988)];
    const span = Math.max(1e-5, hi - lo);
    const cx2 = n / 2, cy2 = n / 2;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = this.idx(tx, ty);
        let t = Math.max(0, Math.min(1, (ef[i] - lo) / span));

        /* Coast. The outer ring drops below the sea so the map ends
           in water rather than at an invisible wall. */
        const dx = (tx - cx2) / cx2, dy = (ty - cy2) / cy2;
        const d = Math.sqrt(dx * dx + dy * dy);
        const shelf = Math.max(0, (d - 0.84) / 0.18);
        t -= Math.pow(shelf, 1.4) * 1.0;

        /* Hard terracing: the height field is snapped to one of
           nine plateaus with nothing in between. Interpolating
           inside a band - which is what a smooth quantiser does -
           turns every cliff into a ramp one level at a time, and
           then sixteen levels of range buys nothing but a gentle
           hill. Snapped, two neighbouring tiles are either on the
           same plateau or a full step apart, which is a cliff, and
           the connectivity pass below is what cuts the stairs. */
        const band = Math.max(0, Math.min(PLATEAUS.length - 1,
          Math.floor(t * PLATEAUS.length)));
        this.height[i] = PLATEAUS[band];
      }
    }
    this.elevField = ef;
    this.elevSpan = span;
  }

  /* Sea, lakes and rivers. Rivers are traced downhill from high
     wet ground; where they fall off a step you get a waterfall for
     free, because the terrain below is simply lower. */
  _water() {
    const n = this.size;
    for (let i = 0; i < n * n; i++) {
      if (this.height[i] <= SEA_LEVEL) {
        this.flags[i] |= FLAG.WATER;
        if (this.height[i] >= SEA_LEVEL - 1) this.flags[i] |= FLAG.SHALLOW;
      }
    }

    const rng = makeRng(this.seed ^ 0x51f7ace);
    const sources = [];
    for (let attempt = 0; attempt < 900 && sources.length < 14; attempt++) {
      const tx = 4 + Math.floor(rng() * (n - 8));
      const ty = 4 + Math.floor(rng() * (n - 8));
      const i = this.idx(tx, ty);
      if (this.height[i] < MAX_LEVEL * 0.62) continue;
      if (this.moisture[i] < 0.42) continue;
      if (sources.some(s => Math.abs(s[0] - tx) < 18 && Math.abs(s[1] - ty) < 18)) continue;
      sources.push([tx, ty]);
    }

    const nudge = this.elevSpan * 0.012;
    for (const [sx, sy] of sources) {
      let x = sx, y = sy;
      const seen = new Set();
      for (let step = 0; step < n * 1.5; step++) {
        const i = this.idx(x, y);
        if (seen.has(i)) break;
        seen.add(i);
        this.flags[i] |= FLAG.RIVER | FLAG.WATER | FLAG.SHALLOW;
        /* The height before the channel is cut. The descent has to
           be judged against it: cutting first and then looking for
           a lower neighbour makes every tile its own basin, which
           stopped every river after a single step. */
        const hBefore = this.height[i];
        const eBefore = this.elevField[i];
        /* Cut the channel a step into the ground and widen it a
           little as it descends. */
        this.height[i] = Math.max(SEA_LEVEL, hBefore - 1);
        if (step > 22) {
          for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const j = this.idx(Math.min(n - 1, Math.max(0, x + ox)), Math.min(n - 1, Math.max(0, y + oy)));
            if (this.height[j] > this.height[i] + 1) continue;
            this.flags[j] |= FLAG.RIVER | FLAG.WATER | FLAG.SHALLOW;
            this.height[j] = Math.max(SEA_LEVEL, Math.min(this.height[j], this.height[i]));
          }
        }
        if (this.height[i] <= SEA_LEVEL) break;

        /* Downhill on the continuous elevation field, not on the
           snapped height. Terraces are flat by construction, so on
           the stepped heightmap every source sits in its own basin
           and no river ever leaves its first tile. A nudge on top
           so rivers meander instead of running in straight lines. */
        let best = null, bestH = Infinity;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
          const nx2 = x + ox, ny2 = y + oy;
          if (!this.inBounds(nx2, ny2)) continue;
          const j = this.idx(nx2, ny2);
          if (seen.has(j)) continue;
          const h = this.elevField[j] + hash2(nx2, ny2, this.seed + 17) * nudge;
          if (h < bestH) { bestH = h; best = [nx2, ny2]; }
        }
        if (!best) break;
        /* A basin with nowhere to go becomes a lake. */
        if (bestH >= eBefore) {
          for (let ly = -2; ly <= 2; ly++) for (let lx = -2; lx <= 2; lx++) {
            if (lx * lx + ly * ly > 5) continue;
            const j2 = x + lx, k2 = y + ly;
            if (!this.inBounds(j2, k2)) continue;
            const j = this.idx(j2, k2);
            this.height[j] = Math.min(this.height[j], this.height[i]);
            this.flags[j] |= FLAG.WATER | FLAG.SHALLOW;
          }
          break;
        }
        x = best[0]; y = best[1];
      }
    }
  }

  /* A wadeable ring wherever water meets land. Without it, snapped
     plateaus drop straight from the shore to the sea floor and every
     offshore rock becomes an island you can only look at. */
  _shallows() {
    const n = this.size;
    const toShallow = [];
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = this.idx(tx, ty);
        if (!(this.flags[i] & FLAG.WATER)) continue;
        let nearLand = false;
        for (let oy = -2; oy <= 2 && !nearLand; oy++) {
          for (let ox = -2; ox <= 2; ox++) {
            if (!this.inBounds(tx + ox, ty + oy)) continue;
            const j = this.idx(tx + ox, ty + oy);
            if (!(this.flags[j] & FLAG.WATER)) { nearLand = true; break; }
          }
        }
        if (nearLand) toShallow.push(i);
      }
    }
    for (const i of toShallow) {
      this.height[i] = Math.max(this.height[i], SEA_LEVEL - 1);
      this.flags[i] |= FLAG.SHALLOW;
    }
  }

  _biomes() {
    const n = this.size, S = this.seed;
    const cx = n / 2, cy = n / 2;
    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = this.idx(tx, ty);
        const h = this.height[i];
        const m = this.moisture[i];
        const temp = this.temperature[i] - (h / MAX_LEVEL) * 0.62;
        const dx = (tx - cx) / cx, dy = (ty - cy) / cy;
        const d = Math.sqrt(dx * dx + dy * dy);

        /* Thresholds in levels rather than ratios: terracing puts
           plateaus on even levels, so a band expressed as a
           fraction can land entirely on risers and never appear. */
        let b;
        if (this.flags[i] & FLAG.WATER) b = BIOME.OCEAN;
        else if (h <= SEA_LEVEL + 2) b = (m > 0.54 ? BIOME.MARSH : BIOME.BEACH);
        else if (h <= 8) b = m < 0.46 ? BIOME.MEADOW : BIOME.FOREST;
        else if (h <= 11) b = m < 0.40 ? BIOME.PINE : BIOME.FOREST;
        else if (h <= 13) b = temp < 0.26 ? BIOME.SNOW : temp < 0.48 ? BIOME.HIGHLAND : BIOME.PINE;
        else b = temp < 0.34 ? BIOME.SNOW : BIOME.HIGHLAND;

        /* Overgrowth and wreckage sit on top as worley patches. */
        if (b !== BIOME.OCEAN) {
          const wx = tx * 0.040 + fbm(tx * 0.03, ty * 0.03, S + 77, 2) * 2.0;
          const wy = ty * 0.040 + fbm(tx * 0.03 + 9, ty * 0.03 + 3, S + 78, 2) * 2.0;
          const cell = worley(wx, wy, S + 4242);
          const pick = hash2(Math.floor(wx), Math.floor(wy), S + 555);
          if (cell < 0.44) {
            const ashBias = Math.max(0, (d - 0.40) / 0.45);
            if (pick < 0.16 + ashBias * 0.45) b = BIOME.ASH;
            else if (pick < 0.58) b = BIOME.BLOOM;
            else b = BIOME.SCRAP;
          }
        }
        this.biome[i] = b;
      }
    }
  }

  /* The beacon's plaza: flattened, paved, and cleared. */
  _plaza() {
    const c = Math.floor(this.size / 2);
    /* Put the plaza on the nearest sensible ground rather than on
       whatever the middle happens to be, in case it is a lake. */
    let best = [c, c], bestScore = -Infinity;
    for (let ty = c - 26; ty <= c + 26; ty += 2) {
      for (let tx = c - 26; tx <= c + 26; tx += 2) {
        if (!this.inBounds(tx, ty)) continue;
        const i = this.idx(tx, ty);
        if (this.flags[i] & FLAG.WATER) continue;
        const h = this.height[i];
        if (h <= SEA_LEVEL + 1 || h > MAX_LEVEL * 0.6) continue;
        /* Prefer flat ground close to the middle. */
        let rough = 0;
        for (let oy = -3; oy <= 3; oy++) for (let ox = -3; ox <= 3; ox++) {
          rough += Math.abs(this.levelAt(tx + ox, ty + oy) - h);
        }
        const score = -rough * 1.2 - Math.hypot(tx - c, ty - c) * 0.6;
        if (score > bestScore) { bestScore = score; best = [tx, ty]; }
      }
    }
    this.plaza = { tx: best[0], ty: best[1] };
    const [px, py] = best;
    const target = this.height[this.idx(px, py)];
    const R = 8;
    for (let ty = py - R - 3; ty <= py + R + 3; ty++) {
      for (let tx = px - R - 3; tx <= px + R + 3; tx++) {
        if (!this.inBounds(tx, ty)) continue;
        const i = this.idx(tx, ty);
        const dist = Math.hypot(tx - px, ty - py);
        if (dist <= R) {
          this.height[i] = target;
          this.biome[i] = BIOME.PLAZA;
          this.flags[i] = (this.flags[i] & ~(FLAG.WATER | FLAG.SHALLOW | FLAG.SOLID | FLAG.RIVER)) | FLAG.PLAZA;
          this.prop[i] = PROP.NONE;
        } else if (dist <= R + 3) {
          /* Terrace the apron down so the plaza is approachable
             from every side. */
          const want = target + Math.round((dist - R)) * Math.sign(this.height[i] - target);
          const h = this.height[i];
          if (Math.abs(h - target) > Math.round(dist - R)) this.height[i] = want;
        }
      }
    }
  }

  /* Cut steps until everything worth reaching is reachable.

     A flood fill from the plaza grows; whenever it stalls, the
     cheapest cliff on its frontier gets a step cut into it and the
     fill continues. That leaves the mountains as mountains and the
     cliffs as cliffs, but guarantees a route up. */
  _connect() {
    const n = this.size, total = n * n;
    const reached = new Uint8Array(total);
    const start = this.idx(this.plaza.tx, this.plaza.ty);
    const queue = [start];
    reached[start] = 1;
    let head = 0;
    let count = 1;

    /* Frontier cliffs bucketed by how big the step is, so the
       cheapest cut is always taken first. */
    const buckets = [];
    /* Pairs are packed with multiplication, not a shift: fifty
       thousand tiles needs sixteen bits each, and `from << 20`
       overflows int32 and silently corrupts the index, which leaves
       the pass thinking there is no cliff to cut anywhere. */
    const PACK = 1 << 20;
    const pushFrontier = (from, to, drop) => {
      const b = Math.min(MAX_LEVEL, drop);
      if (!buckets[b]) buckets[b] = [];
      buckets[b].push(from * PACK + to);
    };

    const neighbours = (i) => {
      const tx = i % n, ty = (i / n) | 0;
      const out = [];
      if (tx > 0) out.push(i - 1);
      if (tx < n - 1) out.push(i + 1);
      if (ty > 0) out.push(i - n);
      if (ty < n - 1) out.push(i + n);
      return out;
    };

    const passable = (i) => {
      const f = this.flags[i];
      if (f & FLAG.SOLID) return false;
      if ((f & FLAG.WATER) && !(f & FLAG.SHALLOW)) return false;
      return true;
    };

    const expand = () => {
      while (head < queue.length) {
        const i = queue[head++];
        const hi = this.height[i];
        for (const j of neighbours(i)) {
          if (reached[j]) continue;
          if (!passable(j)) continue;
          const drop = Math.abs(this.height[j] - hi);
          if (drop <= CLIMB) {
            reached[j] = 1;
            count++;
            queue.push(j);
          } else {
            pushFrontier(i, j, drop);
          }
        }
      }
    };

    expand();

    let cuts = 0;
    const walkable = [];
    for (let i = 0; i < total; i++) if (passable(i)) walkable.push(i);
    const wantTiles = walkable.length;

    while (count < wantTiles * 0.985 && cuts < 26000) {
      /* Take the shallowest unresolved cliff anywhere on the
         frontier and cut one step into it. */
      let pair = -1;   /* packed as from * PACK + to */
      for (let b = CLIMB + 1; b <= MAX_LEVEL; b++) {
        const list = buckets[b];
        if (!list || !list.length) continue;
        while (list.length) {
          const p = list.pop();
          const to = p % PACK;
          if (reached[to] || !passable(to)) continue;
          pair = p;
          break;
        }
        if (pair >= 0) break;
      }
      if (pair < 0) break;

      const from = Math.floor(pair / PACK), to = pair % PACK;
      const hFrom = this.height[from];
      const hTo = this.height[to];
      /* One step toward the far side, which over several passes
         carves a staircase rather than a ramp. */
      this.height[to] = hFrom + Math.sign(hTo - hFrom) * CLIMB;
      this.prop[to] = PROP.NONE;
      this.flags[to] &= ~FLAG.SOLID;
      reached[to] = 1;
      count++;
      queue.push(to);
      cuts++;
      expand();
    }

    this.stats.reachable = count;
    this.stats.walkable = wantTiles;
    this.stats.cuts = cuts;
    this.reachMask = reached;
  }

  _scatter() {
    const n = this.size;
    const rng = makeRng(this.seed ^ 0x9e3779b9);
    const S = this.seed;

    /* One slow field per family, plus a clearing field that thins
       everything at once. These are what turn an even sprinkle into
       woods with edges, scree slopes, meadows and open ground. */
    const density = (fam, tx, ty) => {
      const nx = tx * 0.035, ny = ty * 0.035;
      switch (fam) {
        case FAMILY.CANOPY: {
          const d = fbm(nx * 0.8 + 11.5, ny * 0.8 - 4.25, S + 4001, 3);
          return Math.max(0, Math.min(1.9, (d - 0.26) * 3.4));
        }
        case FAMILY.ROCK: {
          const d = fbm(nx * 1.15 - 27.0, ny * 1.15 + 8.75, S + 4002, 3);
          return Math.max(0, Math.min(2.0, (d - 0.33) * 3.8));
        }
        case FAMILY.COVER: {
          const d = fbm(nx * 0.65 + 5.0, ny * 0.65 + 19.0, S + 4003, 2);
          return Math.max(0, Math.min(1.8, (d - 0.22) * 2.8));
        }
        case FAMILY.DEBRIS: {
          /* Wreckage lies where wreckage lay: tight patches, mostly
             nothing, so a scrapfield feels like somewhere it happened. */
          const d = fbm(nx * 1.6 + 63.0, ny * 1.6 - 41.0, S + 4004, 3);
          return Math.max(0, Math.min(2.4, (d - 0.45) * 5.2));
        }
        default: {
          const d = fbm(nx * 1.9 - 13.0, ny * 1.9 + 71.0, S + 4005, 2);
          return Math.max(0, Math.min(2.0, (d - 0.40) * 4.2));
        }
      }
    };

    /* Genuine clearings, so there is somewhere to stand and build
       and somewhere for a structure to be seen from. */
    const clearing = (tx, ty) => {
      const c = fbm(tx * 0.022 + 91.0, ty * 0.022 - 57.0, S + 4100, 2);
      return c < 0.30 ? Math.max(0, (c - 0.15) / 0.15) : 1;
    };

    for (let ty = 0; ty < n; ty++) {
      for (let tx = 0; tx < n; tx++) {
        const i = this.idx(tx, ty);
        this.variant[i] = rng.int(256);
        const f = this.flags[i];
        if (f & (FLAG.PLAZA | FLAG.BUILT)) continue;
        const b = this.biome[i];

        if (f & FLAG.WATER) {
          if ((f & FLAG.SHALLOW) && rng.chance(0.08)) this.setProp(tx, ty, PROP.REED);
          continue;
        }

        /* Steep ground carries less, so cliff edges stay legible. */
        const steep = Math.abs(this.levelAt(tx + 1, ty) - this.levelAt(tx - 1, ty))
                    + Math.abs(this.levelAt(tx, ty + 1) - this.levelAt(tx, ty - 1));
        const openness = steep > 2 ? 0.25 : steep > 0 ? 0.7 : 1;
        const open = clearing(tx, ty);

        const table = SCATTER[b];
        if (!table) continue;

        /* Cache the five fields once per tile rather than per entry. */
        const dens = this._densCache || (this._densCache = new Float32Array(FAMILY_COUNT));
        for (let k = 0; k < FAMILY_COUNT; k++) dens[k] = density(k, tx, ty);

        const roll = rng();
        let acc = 0;
        for (const entry of table) {
          acc += entry.p * openness * open * dens[familyOf(entry.prop)];
          if (roll < acc) { this.setProp(tx, ty, entry.prop); break; }
        }
      }
    }

    /* Give the big things room. Ground cover pressed against a tree
       trunk or a ruin wall reads as texture on the object instead of
       as a separate thing, and the silhouette goes with it. */
    for (let ty = 1; ty < n - 1; ty++) {
      for (let tx = 1; tx < n - 1; tx++) {
        const prop = this.prop[this.idx(tx, ty)];
        if (!prop || !isLandmarkProp(prop)) continue;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const j = this.idx(tx + ox, ty + oy);
          const q = this.prop[j];
          if (q && familyOf(q) === FAMILY.COVER && rng.chance(0.7)) this.clearProp(tx + ox, ty + oy);
        }
      }
    }

    /* Thin out solid props that wall each other in. */
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

  /* Somewhere to start.

     Clustering is what makes the map read as a landscape, but it
     also means the ground around any given point may legitimately
     be a clearing - and waking up with nothing in the middle of one
     is not an interesting first five minutes, it is a walk. So the
     ring around the plaza is guaranteed to hold the two things you
     need before you can do anything at all: wood and stone. */
  _starterGround() {
    const rng = makeRng(this.seed ^ 0x5741b17);
    const cx = this.plaza ? this.plaza.tx : Math.floor(this.size / 2);
    const cy = this.plaza ? this.plaza.ty : Math.floor(this.size / 2);
    const WANT_WOOD = 26, WANT_STONE = 18, INNER = 5, OUTER = 20;

    const free = [];
    let wood = 0, stone = 0;
    for (let oy = -OUTER; oy <= OUTER; oy++) {
      for (let ox = -OUTER; ox <= OUTER; ox++) {
        const d2 = ox * ox + oy * oy;
        if (d2 < INNER * INNER || d2 > OUTER * OUTER) continue;
        const tx = cx + ox, ty = cy + oy;
        if (!this.inBounds(tx, ty)) continue;
        const i = this.idx(tx, ty);
        const f = this.flags[i];
        if (f & (FLAG.WATER | FLAG.PLAZA | FLAG.BUILT | FLAG.BLOCKED_EDGE)) continue;
        const prop = this.prop[i];
        if (prop) {
          const h = HARVEST[prop];
          if (h) {
            for (const [item] of h.yield) {
              if (item === 'wood') wood++;
              else if (item === 'stone') stone++;
            }
          }
          continue;
        }
        /* Not on a cliff edge, where nothing else grows either. */
        const steep = Math.abs(this.levelAt(tx + 1, ty) - this.levelAt(tx - 1, ty))
                    + Math.abs(this.levelAt(tx, ty + 1) - this.levelAt(tx, ty - 1));
        if (steep > 1) continue;
        free.push(i > 0 ? [tx, ty] : [tx, ty]);
      }
    }

    /* Shuffle so the top-ups land in a scatter rather than a line. */
    for (let i = free.length - 1; i > 0; i--) {
      const j = rng.int(i + 1);
      const t = free[i]; free[i] = free[j]; free[j] = t;
    }

    let k = 0;
    const treeFor = (tx, ty) => {
      const b = this.biome[this.idx(tx, ty)];
      if (b === BIOME.SNOW) return PROP.TREE_SNOW;
      if (b === BIOME.PINE) return PROP.TREE_PINE;
      if (b === BIOME.ASH || b === BIOME.MARSH) return PROP.TREE_DEAD;
      return rng.chance(0.5) ? PROP.TREE_OAK : PROP.TREE_BIRCH;
    };
    while (wood < WANT_WOOD && k < free.length) {
      const [tx, ty] = free[k++];
      this.setProp(tx, ty, treeFor(tx, ty));
      wood += 5;
    }
    while (stone < WANT_STONE && k < free.length) {
      const [tx, ty] = free[k++];
      this.setProp(tx, ty, rng.chance(0.3) ? PROP.BOULDER : PROP.ROCK);
      stone += 3;
    }
    this.stats.starterTopUp = k;
  }


  /* Ore sits in exposed rock: tiles with a real drop beside them,
     up in the crags and under the snow. Veins cluster, so finding
     one is worth something. */
  _ore() {
    const n = this.size;
    const rng = makeRng(this.seed ^ 0x0e1a7e);
    const candidates = [];
    for (let ty = 2; ty < n - 2; ty++) {
      for (let tx = 2; tx < n - 2; tx++) {
        const i = this.idx(tx, ty);
        if (this.flags[i] & (FLAG.WATER | FLAG.PLAZA | FLAG.SOLID)) continue;
        const h = this.height[i];
        let drop = 0;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          drop = Math.max(drop, h - this.levelAt(tx + ox, ty + oy));
        }
        if (drop < 2) continue;
        candidates.push([tx, ty, h, drop]);
      }
    }

    const veins = Math.round(candidates.length * 0.012) + 24;
    for (let v = 0; v < veins; v++) {
      const pick = candidates[Math.floor(rng() * candidates.length)];
      if (!pick) break;
      const [tx, ty, h] = pick;
      const depth = h / MAX_LEVEL;
      /* Better ore lives higher and further out. */
      let kind;
      const roll = rng();
      if (depth > 0.78) kind = roll < 0.34 ? PROP.ORE_GOLD : roll < 0.62 ? PROP.ORE_ESSENCE : PROP.ORE_IRON;
      else if (depth > 0.52) kind = roll < 0.55 ? PROP.ORE_IRON : roll < 0.8 ? PROP.ORE_COPPER : PROP.ORE_ESSENCE;
      else kind = roll < 0.72 ? PROP.ORE_COPPER : PROP.ORE_IRON;

      const size = 2 + Math.floor(rng() * 4);
      for (let k = 0; k < size; k++) {
        const ox = tx + Math.floor(rng() * 5) - 2;
        const oy = ty + Math.floor(rng() * 5) - 2;
        if (!this.inBounds(ox, oy)) continue;
        const j = this.idx(ox, oy);
        if (this.flags[j] & (FLAG.WATER | FLAG.PLAZA | FLAG.SOLID)) continue;
        this.setProp(ox, oy, kind);
      }
    }
    this.stats.oreVeins = veins;
  }

  _landmarks() {
    const rng = makeRng(this.seed ^ 0x517cc1b7);
    const n = this.size;
    const px = this.plaza.tx, py = this.plaza.ty;

    this.landmarks.push({ kind: 'beacon', tx: px, ty: py });

    const place = (kind, count, minR, maxR, clear, opts = {}) => {
      for (let k = 0; k < count; k++) {
        for (let attempt = 0; attempt < 140; attempt++) {
          const ang = rng() * Math.PI * 2;
          const rad = (minR + rng() * (maxR - minR)) * (n / 2);
          const tx = Math.round(px + Math.cos(ang) * rad);
          const ty = Math.round(py + Math.sin(ang) * rad);
          if (!this.inBounds(tx + 5, ty + 5) || !this.inBounds(tx - 5, ty - 5)) continue;
          const i = this.idx(tx, ty);
          if (this.flags[i] & (FLAG.WATER | FLAG.PLAZA)) continue;
          if (this.reachMask && !this.reachMask[i]) continue;
          if (opts.minHeight !== undefined && this.height[i] < opts.minHeight) continue;
          if (opts.maxHeight !== undefined && this.height[i] > opts.maxHeight) continue;
          if (this.landmarks.some(l => Math.abs(l.tx - tx) < 16 && Math.abs(l.ty - ty) < 16)) continue;
          this._flatten(tx, ty, clear);
          this.landmarks.push({ kind, tx, ty, variant: rng.int(256) });
          break;
        }
      }
    };

    place('rift', 5, 0.30, 0.82, 3);
    place('cache', 8, 0.16, 0.82, 2);
    place('shrine', 4, 0.20, 0.70, 2);
    place('wreck', 6, 0.14, 0.84, 3);
    place('camp', 4, 0.22, 0.78, 3);
    place('mine', 4, 0.34, 0.86, 3, { minHeight: Math.round(MAX_LEVEL * 0.55) });

    /* Camps and wrecks leave a litter of salvage: the first thing
       a new run needs is scrap, and it should be findable near a
       landmark rather than only in one biome. */
    for (const lm of this.landmarks) {
      if (lm.kind !== 'camp' && lm.kind !== 'wreck') continue;
      for (let k = 0; k < 9; k++) {
        const a = rng() * Math.PI * 2;
        const r = 3 + rng() * 5;
        const tx = Math.round(lm.tx + Math.cos(a) * r);
        const ty = Math.round(lm.ty + Math.sin(a) * r);
        if (!this.inBounds(tx, ty)) continue;
        const i = this.idx(tx, ty);
        if (this.flags[i] & (FLAG.WATER | FLAG.PLAZA | FLAG.SOLID)) continue;
        this.setProp(tx, ty, rng() < 0.55 ? PROP.SCRAP_PILE : rng() < 0.6 ? PROP.CRATE : PROP.CONDUIT);
      }
    }

    /* Ore is dense around a mine mouth: that is the reason to go. */
    for (const lm of this.landmarks) {
      if (lm.kind !== 'mine') continue;
      for (let k = 0; k < 14; k++) {
        const a = rng() * Math.PI * 2;
        const r = 4 + rng() * 5;
        const tx = Math.round(lm.tx + Math.cos(a) * r);
        const ty = Math.round(lm.ty + Math.sin(a) * r);
        if (!this.inBounds(tx, ty)) continue;
        const i = this.idx(tx, ty);
        if (this.flags[i] & (FLAG.WATER | FLAG.PLAZA)) continue;
        this.setProp(tx, ty, rng() < 0.4 ? PROP.ORE_IRON : rng() < 0.7 ? PROP.ORE_COPPER : PROP.ORE_GOLD);
      }
    }

    for (const lm of this.landmarks) {
      lm.x = this.tileToWorldX(lm.tx);
      lm.z = this.tileToWorldZ(lm.ty);
      lm.y = this.heightAtTile(lm.tx, lm.ty);
    }

    for (let k = 0; k < 8; k++) {
      const ang = (k / 8) * Math.PI * 2;
      const tx = Math.round(px + Math.cos(ang) * 6);
      const ty = Math.round(py + Math.sin(ang) * 6);
      this.spawnPoints.push({ x: this.tileToWorldX(tx), z: this.tileToWorldZ(ty) });
    }
  }

  _flatten(cx, cy, radius) {
    if (!this.inBounds(cx, cy)) return;
    const target = this.height[this.idx(cx, cy)];
    for (let ty = cy - radius - 2; ty <= cy + radius + 2; ty++) {
      for (let tx = cx - radius - 2; tx <= cx + radius + 2; tx++) {
        if (!this.inBounds(tx, ty)) continue;
        const d = Math.hypot(tx - cx, ty - cy);
        const i = this.idx(tx, ty);
        if (d <= radius) {
          this.height[i] = target;
          this.clearProp(tx, ty);
          this.flags[i] &= ~(FLAG.WATER | FLAG.SHALLOW);
        } else if (d <= radius + 2) {
          const allowed = Math.round(d - radius) * CLIMB;
          const h = this.height[i];
          if (Math.abs(h - target) > allowed) this.height[i] = target + Math.sign(h - target) * allowed;
        }
      }
    }
  }

  chunkIndex(cx, cy) { return cy * this.chunksPerSide + cx; }
}

/* Scatter tables, evaluated in order: probability per tile. */
/* Which family a prop belongs to, for the clustering pass below.
   Scatter used to be an independent roll per tile, which is white
   noise: every tile had the same chance of the same spread of
   things, so the map came out as an even confetti of small objects
   with no groves, no boulder fields, no clearings and nothing for
   the eye to rest on. Each family now gets its own slow-moving
   density field, so trees gather into woods and woods have edges. */
const FAMILY = { CANOPY: 0, ROCK: 1, COVER: 2, DEBRIS: 3, ORE: 4 };
const FAMILY_COUNT = 5;

function familyOf(prop) {
  switch (prop) {
    case PROP.TREE_PINE: case PROP.TREE_OAK: case PROP.TREE_BIRCH:
    case PROP.TREE_BLOOM: case PROP.TREE_DEAD: case PROP.TREE_SNOW:
    case PROP.STUMP:
      return FAMILY.CANOPY;
    case PROP.ROCK: case PROP.BOULDER: case PROP.ROCK_TALL:
    case PROP.SNOW_ROCK: case PROP.ICE_SPIKE:
      return FAMILY.ROCK;
    case PROP.ORE_COPPER: case PROP.ORE_IRON: case PROP.ORE_GOLD:
    case PROP.ORE_ESSENCE: case PROP.CRYSTAL: case PROP.RIFT_SHARD:
      return FAMILY.ORE;
    case PROP.SCRAP_PILE: case PROP.CONDUIT: case PROP.CRATE:
    case PROP.RUIN_WALL: case PROP.RUIN_PILLAR: case PROP.LAMP:
    case PROP.ANTENNA: case PROP.PYLON: case PROP.BONES:
      return FAMILY.DEBRIS;
    default:
      return FAMILY.COVER;
  }
}

/* Big things need room around them or they stop reading as
   silhouettes and become part of the texture. */
function isLandmarkProp(prop) {
  const f = familyOf(prop);
  return f === FAMILY.CANOPY || prop === PROP.BOULDER || prop === PROP.ROCK_TALL
    || prop === PROP.RUIN_WALL || prop === PROP.RUIN_PILLAR || prop === PROP.PYLON
    || prop === PROP.ANTENNA;
}

const SCATTER = {
  [BIOME.BEACH]: [
    { prop: PROP.SCRAP_PILE, p: 0.012 }, { prop: PROP.CRATE, p: 0.006 },
    { prop: PROP.GRASS, p: 0.05 }, { prop: PROP.ROCK, p: 0.03 }, { prop: PROP.BONES, p: 0.004 },
  ],
  [BIOME.MARSH]: [
    { prop: PROP.REED, p: 0.16 }, { prop: PROP.TREE_DEAD, p: 0.05 }, { prop: PROP.MUSHROOM, p: 0.06 },
    { prop: PROP.FERN, p: 0.10 }, { prop: PROP.ROCK, p: 0.02 }, { prop: PROP.BUSH, p: 0.05 },
  ],
  [BIOME.MEADOW]: [
    { prop: PROP.SCRAP_PILE, p: 0.010 }, { prop: PROP.GRASS, p: 0.22 }, { prop: PROP.FLOWER, p: 0.07 }, { prop: PROP.BUSH, p: 0.04 },
    { prop: PROP.BERRY_BUSH, p: 0.022 }, { prop: PROP.TREE_OAK, p: 0.025 }, { prop: PROP.ROCK, p: 0.03 },
    { prop: PROP.BOULDER, p: 0.008 },
  ],
  [BIOME.FOREST]: [
    { prop: PROP.SCRAP_PILE, p: 0.009 }, { prop: PROP.CRATE, p: 0.005 },
    { prop: PROP.TREE_OAK, p: 0.075 }, { prop: PROP.TREE_BIRCH, p: 0.045 }, { prop: PROP.TREE_PINE, p: 0.03 },
    { prop: PROP.BUSH, p: 0.06 }, { prop: PROP.FERN, p: 0.07 }, { prop: PROP.GRASS, p: 0.11 },
    { prop: PROP.MUSHROOM, p: 0.03 }, { prop: PROP.BERRY_BUSH, p: 0.018 }, { prop: PROP.ROCK, p: 0.02 },
    { prop: PROP.STUMP, p: 0.008 }, { prop: PROP.FLOWER, p: 0.02 },
  ],
  [BIOME.PINE]: [
    { prop: PROP.SCRAP_PILE, p: 0.008 }, { prop: PROP.TREE_PINE, p: 0.12 }, { prop: PROP.ROCK, p: 0.045 }, { prop: PROP.BOULDER, p: 0.015 },
    { prop: PROP.GRASS, p: 0.07 }, { prop: PROP.BUSH, p: 0.03 }, { prop: PROP.MUSHROOM, p: 0.02 },
  ],
  [BIOME.HIGHLAND]: [
    { prop: PROP.ROCK, p: 0.09 }, { prop: PROP.BOULDER, p: 0.035 }, { prop: PROP.ROCK_TALL, p: 0.016 },
    { prop: PROP.GRASS, p: 0.035 }, { prop: PROP.TREE_PINE, p: 0.012 },
  ],
  [BIOME.SNOW]: [
    { prop: PROP.TREE_SNOW, p: 0.045 }, { prop: PROP.SNOW_ROCK, p: 0.06 }, { prop: PROP.ICE_SPIKE, p: 0.02 },
    { prop: PROP.BOULDER, p: 0.02 }, { prop: PROP.BONES, p: 0.004 },
  ],
  [BIOME.BLOOM]: [
    { prop: PROP.TREE_BLOOM, p: 0.07 }, { prop: PROP.CRYSTAL, p: 0.035 }, { prop: PROP.GRASS, p: 0.11 },
    { prop: PROP.FLOWER, p: 0.06 }, { prop: PROP.MUSHROOM, p: 0.05 }, { prop: PROP.BUSH, p: 0.03 },
    { prop: PROP.ROCK, p: 0.015 },
  ],
  [BIOME.SCRAP]: [
    { prop: PROP.RUIN_WALL, p: 0.042 }, { prop: PROP.RUIN_PILLAR, p: 0.02 }, { prop: PROP.SCRAP_PILE, p: 0.05 },
    { prop: PROP.CONDUIT, p: 0.032 }, { prop: PROP.PYLON, p: 0.012 }, { prop: PROP.CRATE, p: 0.02 },
    { prop: PROP.GRASS, p: 0.06 }, { prop: PROP.ANTENNA, p: 0.008 }, { prop: PROP.LAMP, p: 0.01 },
    { prop: PROP.ROCK, p: 0.015 },
  ],
  [BIOME.ASH]: [
    { prop: PROP.SCRAP_PILE, p: 0.020 }, { prop: PROP.CONDUIT, p: 0.010 },
    { prop: PROP.TREE_DEAD, p: 0.07 }, { prop: PROP.RIFT_SHARD, p: 0.03 }, { prop: PROP.ROCK, p: 0.04 },
    { prop: PROP.BOULDER, p: 0.02 }, { prop: PROP.STUMP, p: 0.02 }, { prop: PROP.GRASS, p: 0.03 },
    { prop: PROP.BONES, p: 0.008 },
  ],
  [BIOME.PLAZA]: [],
  [BIOME.OCEAN]: [],
};

export { SCATTER };
