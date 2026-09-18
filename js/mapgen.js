/* ============================================================
   mapgen.js - where a colony comes from: the ground it lands on,
   the people who walk out of the pods, and the wildlife that was
   already there.

   Three things are worth knowing before reading the rest.

   One: nothing here touches Math.random. Every map is a pure function
   of its seed, which is what makes a save one number and a bug report
   reproducible. The value noise below is seeded from U's stream at the
   top of generate(), so the fields, the river, the ore and the people
   all move together when the seed moves.

   Two: generation works on plain typed arrays first and only writes to
   the GameMap at the end. Carving a river through a mountain is much
   easier when the mountain is a byte in an array than when it is four
   thousand Things with path costs hanging off them, and materialising
   once means every cell pays for its derived state exactly one time.

   Three: a map is judged by whether it is playable, not by whether it
   is pretty. A river that crosses the map beats a pond; a landing spot
   is verified reachable and not walled in before anyone is put on it;
   and the starting three are re-rolled until they can between them
   build, feed and defend the place.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Systems below this file in the load order, and systems that may
     simply not be written yet. Resolved at call time, never at load. */
  function sys(name) {
    var v = root[name];
    return v === undefined ? null : v;
  }

  var MapGen = {};

  /* Kinds that are animals when no pawnKind def is loaded to say so. */
  var ANIMAL_KINDS = { hare: 1, deer: 1, muffalo: 1, boomrat: 1, wolf: 1, bear: 1 };

  /* ============================================================
     VALUE NOISE

     A 32-bit integer hash per lattice point, smoothstep-interpolated,
     summed over a few octaves. No tables to build, no state to carry,
     and the same (seed, x, y) always gives the same number - which is
     what lets a field be sampled lazily and out of order.
     ============================================================ */

  function hash2i(seed, x, y) {
    var h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
    h = (h ^ (h >>> 12)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0x297a2d39) >>> 0;
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  }

  function smoothstep(t) { return t * t * (3 - 2 * t); }

  function value2(seed, x, y) {
    var xi = Math.floor(x), yi = Math.floor(y);
    var u = smoothstep(x - xi), v = smoothstep(y - yi);
    var a = hash2i(seed, xi, yi), b = hash2i(seed, xi + 1, yi);
    var c = hash2i(seed, xi, yi + 1), d = hash2i(seed, xi + 1, yi + 1);
    var top = a + (b - a) * u;
    var bot = c + (d - c) * u;
    return top + (bot - top) * v;
  }

  /* Fractal sum, normalised to 0..1. `scale` is the wavelength of the
     first octave in tiles, so 30 means "features about thirty tiles
     across", which is the unit map generation actually thinks in. */
  function fbm(seed, x, y, octaves, scale) {
    var amp = 1, freq = 1 / scale, sum = 0, norm = 0;
    for (var o = 0; o < octaves; o++) {
      sum += amp * value2((seed + o * 7919) >>> 0, x * freq, y * freq);
      norm += amp;
      amp *= 0.5;
      freq *= 2;
    }
    return sum / norm;
  }

  function noiseSeed() { return (U.rand() * 4294967296) >>> 0; }

  /* The value below which `q` of the field lies. Thresholding on a
     quantile rather than a constant is what guarantees a mountainous
     map is 30% rock no matter how the noise happened to land. */
  function quantile(field, q) {
    var copy = Array.prototype.slice.call(field);
    copy.sort(function (a, b) { return a - b; });
    var i = Math.floor(q * (copy.length - 1));
    return copy[U.clamp(i, 0, copy.length - 1)];
  }

  function quantileOfList(list, q) {
    if (!list.length) return 0;
    var copy = list.slice();
    copy.sort(function (a, b) { return a - b; });
    return copy[U.clamp(Math.floor(q * (copy.length - 1)), 0, copy.length - 1)];
  }

  /* ============================================================
     BIOMES

     Plant composition comes out of def_plants.js - every plant already
     states which biomes it grows in and how densely - so the table here
     only carries what that file cannot know: how much of the biome is
     bare, how wet it is, and what lives on it.
     ============================================================ */

  var BIOMES = {
    temperateForest: {
      label: 'temperate forest',
      plantDensity: 1.0,
      plantBias: { treeOak: 1.25, treePine: 0.7, berryBush: 1.3, tallGrass: 1.0, grass: 1.0 },
      herbivores: ['deer', 'hare', 'muffalo'],
      predators: ['wolf', 'bear'],
      herds: [3, 5],
      riverChance: 0.8,
      sandiness: 0.06, marshiness: 0.30, richness: 0.26, gravelSpread: 1
    },
    aridShrubland: {
      label: 'arid shrubland',
      plantDensity: 0.42,
      plantBias: { bush: 1.7, tallGrass: 1.5, grass: 0.8, healroot: 0.7 },
      herbivores: ['hare', 'muffalo', 'boomrat'],
      predators: ['wolf'],
      herds: [2, 4],
      riverChance: 0.35,
      sandiness: 0.34, marshiness: 0.08, richness: 0.10, gravelSpread: 2
    },
    borealForest: {
      label: 'boreal forest',
      plantDensity: 0.78,
      plantBias: { treePine: 1.5, grass: 1.2, bush: 0.8, berryBush: 0.9 },
      herbivores: ['deer', 'muffalo', 'hare'],
      predators: ['wolf', 'bear'],
      herds: [2, 4],
      riverChance: 0.6,
      sandiness: 0.05, marshiness: 0.38, richness: 0.16, gravelSpread: 1
    }
  };

  /* Rock codes in the working grid. The mapping to thing defs lives in
     one place so an ore blob is a number until the moment it is built. */
  var ROCK_NONE = 0, ROCK_PLAIN = 1;
  var ROCK_DEFS = ['', 'rockWall', 'compactedSteel', 'compactedComponents', 'compactedSilver'];

  /* Vein rarity scales with value: one steel seam per three hundred rock
     cells, silver at a quarter of that. */
  var ORE_PLANS = [
    { code: 2, per: 290, size: [8, 20] },
    { code: 3, per: 850, size: [4, 10] },
    { code: 4, per: 1150, size: [3, 8] }
  ];

  var WATER_NONE = 0, WATER_SHALLOW = 1, WATER_DEEP = 2;

  /* ============================================================
     GENERATION
     ============================================================ */

  MapGen.generate = function (opts) {
    opts = opts || {};
    var w = Math.max(24, (opts.w | 0) || 140);
    var h = Math.max(24, (opts.h | 0) || 140);
    var seed = opts.seed === undefined ? U.randInt(1, 2000000000) : (opts.seed >>> 0);

    /* Everything downstream of here is a pure function of this call. */
    U.seed(seed);

    var biome = BIOMES[opts.biome] ? opts.biome : 'temperateForest';
    var mountainous = opts.mountainous === undefined ? true : !!opts.mountainous;

    var map = new root.GameMap(w, h);
    map.biome = biome;
    map.seed = seed;
    map.mountainous = mountainous;

    var size = w * h;
    var ctx = {
      map: map, w: w, h: h, size: size,
      biome: biome, bio: BIOMES[biome], mountainous: mountainous,
      elev: new Float32Array(size),
      fert: new Float32Array(size),
      moist: new Float32Array(size),
      rock: new Uint8Array(size),
      water: new Uint8Array(size),
      waterDist: new Int16Array(size),
      rockDist: new Int16Array(size),
      terr: new Array(size),
      ns: {
        elev: noiseSeed(), warp: noiseSeed(), fert: noiseSeed(),
        moist: noiseSeed(), river: noiseSeed(), width: noiseSeed(),
        clump: noiseSeed(), grain: noiseSeed()
      }
    };

    buildElevation(ctx);
    buildRock(ctx);
    carveWater(ctx);
    placeOre(ctx);
    distanceFields(ctx);
    buildMoistureAndFertility(ctx);
    chooseTerrain(ctx);
    materialise(ctx);
    roofCaves(ctx);
    spawnPlants(ctx);
    spawnWildlife(ctx);

    return map;
  };

  /* Elevation is one warped fractal plus a mass anchored to a randomly
     chosen compass direction. The anchor is what makes a mountainous map
     a mountain you can tunnel into from one side rather than a rash of
     boulders across the middle of the buildable ground. */
  function buildElevation(ctx) {
    var w = ctx.w, h = ctx.h, elev = ctx.elev, ns = ctx.ns;
    var ang = U.rand() * 6.283185307179586;
    var ax = Math.cos(ang), ay = Math.sin(ang);
    var massWeight = ctx.mountainous ? 0.46 : 0.16;
    var massStart = ctx.mountainous ? 0.30 : 0.55;
    var warpAmp = 7 + U.rand() * 6;

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        /* Domain warp: sampling the field at a wobbled position is what
           turns smooth contours into a ragged, broken-up rock edge. */
        var wx = x + (fbm(ns.warp, x, y, 2, 19) - 0.5) * 2 * warpAmp;
        var wy = y + (fbm((ns.warp + 1013) >>> 0, x, y, 2, 19) - 0.5) * 2 * warpAmp;

        var base = fbm(ns.elev, wx, wy, 4, 34);
        var proj = ((x / w - 0.5) * ax + (y / h - 0.5) * ay) + 0.5;
        var mass = U.clamp01((proj - massStart) / (1 - massStart));
        mass = mass * mass;

        /* A high-frequency grain nudges cells right at the threshold in
           and out of the rock, which crumbles the edge one tile at a
           time instead of leaving a clean noise contour. */
        var grain = (fbm(ns.grain, x, y, 2, 3.5) - 0.5) * 0.075;

        elev[y * w + x] = base * (1 - massWeight) + mass * massWeight + grain;
      }
    }
  }

  function buildRock(ctx) {
    var target = ctx.mountainous ? 0.30 : 0.085;
    var thr = quantile(ctx.elev, 1 - target);
    var rock = ctx.rock, elev = ctx.elev, size = ctx.size;
    var i;
    for (i = 0; i < size; i++) rock[i] = elev[i] >= thr ? ROCK_PLAIN : ROCK_NONE;

    /* One cleanup pass. Single rock cells stranded in open ground read as
       noise rather than geology, and single open cells inside a mountain
       are one-tile rooms nobody will ever reach. Neighbour counts are
       taken from a snapshot so the pass does not chase its own tail. */
    var before = rock.slice();
    var w = ctx.w, h = ctx.h;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var n = 0;
        for (var k = 0; k < U.ADJ8.length; k++) {
          var nx = x + U.ADJ8[k][0], ny = y + U.ADJ8[k][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) { n++; continue; }
          if (before[ny * w + nx]) n++;
        }
        i = y * w + x;
        if (before[i] && n <= 1 && U.chance(0.8)) rock[i] = ROCK_NONE;
        else if (!before[i] && n >= 7) rock[i] = ROCK_PLAIN;
      }
    }
  }

  /* ---------- water ----------
     A river that crosses the map is worth far more than a pond: it gives
     the map a spine, a fertile valley and a reason for the colony to sit
     where it sits. Deep water is impassable, so the river is stamped as
     shallow banks with a deep channel only where it is wide, and fords
     are forced at intervals - a map cut into two halves nobody can walk
     between is a broken map, not a hard one. */
  function carveWater(ctx) {
    var river = U.chance(ctx.bio.riverChance);
    if (river) carveRiver(ctx);

    var ponds = river ? U.randInt(0, 2) : U.randInt(1, 3);
    var made = 0, tries = 0;
    /* A pond wants a hollow to sit in and will refuse a ridge, so it is
       asked repeatedly. A map with no water at all has nowhere for the
       herds to gather and nothing to build a colony against, so the
       first pond on a riverless map is insisted upon. */
    while (made < ponds && tries++ < 40) {
      if (carvePond(ctx)) made++;
    }
  }

  function carveRiver(ctx) {
    var w = ctx.w, h = ctx.h, ns = ctx.ns;
    var horizontal = U.chance(0.55);
    var sx, sy, ex, ey;
    if (horizontal) {
      sx = 0; ex = w - 1;
      sy = U.randInt(Math.round(h * 0.18), Math.round(h * 0.82));
      ey = U.randInt(Math.round(h * 0.18), Math.round(h * 0.82));
    } else {
      sy = 0; ey = h - 1;
      sx = U.randInt(Math.round(w * 0.18), Math.round(w * 0.82));
      ex = U.randInt(Math.round(w * 0.18), Math.round(w * 0.82));
    }

    var dx = ex - sx, dy = ey - sy;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var px = -dy / len, py = dx / len;          /* unit perpendicular */
    var amp = (horizontal ? h : w) * 0.16;
    var steps = Math.ceil(len * 3);

    /* Three fords, jittered, so there is always a way across without a
       bridge and the crossings are not in the same place every game. */
    var fords = [0.2 + U.rand() * 0.1, 0.46 + U.rand() * 0.1, 0.74 + U.rand() * 0.1];

    for (var s = 0; s <= steps; s++) {
      var t = s / steps;
      var wob = (fbm(ns.river, t * 260, 31.5, 3, 40) - 0.5) * 2;
      var cx = sx + dx * t + px * wob * amp;
      var cy = sy + dy * t + py * wob * amp;

      var ford = 1;
      for (var f = 0; f < fords.length; f++) {
        var d = Math.abs(t - fords[f]);
        if (d < 0.035) ford = Math.min(ford, d / 0.035);
      }

      var width = (2.4 + 3.0 * fbm(ns.width, t * 300, 5.5, 2, 45)) * (0.55 + 0.45 * ford);
      stampWater(ctx, cx, cy, width, ford > 0.55);
    }
  }

  function carvePond(ctx) {
    var w = ctx.w, h = ctx.h;
    var cx = U.randInt(6, w - 7), cy = U.randInt(6, h - 7);
    /* Ponds sit in hollows; a pond on a ridge would look like a mistake. */
    if (ctx.elev[cy * w + cx] > 0.55) return false;
    var r = U.randRange(3, 7);
    var seed = noiseSeed();
    for (var y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
      for (var x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
        if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
        var d = U.dist(x, y, cx, cy);
        var edge = r * (0.75 + 0.5 * fbm(seed, x, y, 2, 6));
        if (d > edge) continue;
        var i = y * w + x;
        ctx.rock[i] = ROCK_NONE;
        ctx.water[i] = d < edge - 1.6 ? WATER_DEEP : WATER_SHALLOW;
      }
    }
    return true;
  }

  function stampWater(ctx, cx, cy, width, allowDeep) {
    var w = ctx.w, h = ctx.h;
    var r = width * 0.5;
    var x0 = Math.floor(cx - r - 1), x1 = Math.ceil(cx + r + 1);
    var y0 = Math.floor(cy - r - 1), y1 = Math.ceil(cy + r + 1);
    for (var y = y0; y <= y1; y++) {
      for (var x = x0; x <= x1; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        var d = U.dist(x, y, cx, cy);
        if (d > r) continue;
        var i = y * w + x;
        /* Water cuts the rock: a river predates the colony and does not
           stop at a cliff, it wears a gorge through it. */
        ctx.rock[i] = ROCK_NONE;
        var deep = allowDeep && d < r - 1.15;
        if (deep) ctx.water[i] = WATER_DEEP;
        else if (ctx.water[i] !== WATER_DEEP) ctx.water[i] = WATER_SHALLOW;
      }
    }
  }

  /* ---------- ore ----------
     Veins grow as blobs from a seed cell that is buried in the rock, so
     a seam is something a miner has to dig towards rather than something
     lying on the mountain's doorstep. */
  function placeOre(ctx) {
    var rock = ctx.rock, size = ctx.size, w = ctx.w, h = ctx.h;
    var buried = [];
    for (var i = 0; i < size; i++) {
      if (rock[i] !== ROCK_PLAIN) continue;
      var x = i % w, y = (i / w) | 0;
      if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
      var solid = true;
      for (var k = 0; k < U.ADJ8.length && solid; k++) {
        if (!rock[(y + U.ADJ8[k][1]) * w + (x + U.ADJ8[k][0])]) solid = false;
      }
      if (solid) buried.push(i);
    }
    if (!buried.length) return;

    var rockCount = 0;
    for (i = 0; i < size; i++) if (rock[i]) rockCount++;

    for (var p = 0; p < ORE_PLANS.length; p++) {
      var plan = ORE_PLANS[p];
      var veins = Math.round(rockCount / plan.per);
      for (var v = 0; v < veins; v++) {
        var start = buried[U.randInt(0, buried.length - 1)];
        if (rock[start] !== ROCK_PLAIN) continue;
        growVein(ctx, start, U.randInt(plan.size[0], plan.size[1]), plan.code);
      }
    }
  }

  function growVein(ctx, start, size, code) {
    var rock = ctx.rock, w = ctx.w, h = ctx.h;
    var frontier = [start];
    rock[start] = code;
    var placed = 1, guard = size * 12;
    while (placed < size && frontier.length && guard-- > 0) {
      var from = frontier[U.randInt(0, frontier.length - 1)];
      var fx = from % w, fy = (from / w) | 0;
      var dir = U.ADJ8[U.randInt(0, 7)];
      var nx = fx + dir[0], ny = fy + dir[1];
      if (nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1) continue;
      var ni = ny * w + nx;
      if (rock[ni] !== ROCK_PLAIN) continue;
      rock[ni] = code;
      frontier.push(ni);
      placed++;
    }
  }

  /* ---------- distance fields ----------
     Two capped multi-source BFS passes. Everything that follows - marsh,
     rich soil, gravel, where a colony wants to land - is a question about
     how far a cell is from water or from stone. */
  function distanceFields(ctx) {
    ctx.waterDist = bfsDistance(ctx, function (i) { return ctx.water[i] !== WATER_NONE; }, 24);
    ctx.rockDist = bfsDistance(ctx, function (i) { return ctx.rock[i] !== ROCK_NONE; }, 18);
  }

  function bfsDistance(ctx, isSource, cap) {
    var w = ctx.w, h = ctx.h, size = ctx.size;
    var dist = new Int16Array(size);
    var queue = new Int32Array(size);
    var head = 0, tail = 0, i;
    for (i = 0; i < size; i++) {
      if (isSource(i)) { dist[i] = 0; queue[tail++] = i; }
      else dist[i] = cap;
    }
    while (head < tail) {
      var cur = queue[head++];
      var d = dist[cur] + 1;
      if (d > cap) continue;
      var x = cur % w, y = (cur / w) | 0;
      for (var k = 0; k < 4; k++) {
        var nx = x + U.ADJ4[k][0], ny = y + U.ADJ4[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var ni = ny * w + nx;
        if (dist[ni] <= d) continue;
        dist[ni] = d;
        queue[tail++] = ni;
      }
    }
    return dist;
  }

  function buildMoistureAndFertility(ctx) {
    var w = ctx.w, h = ctx.h, ns = ctx.ns;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var near = 1 - U.clamp01(ctx.waterDist[i] / 16);
        ctx.moist[i] = U.clamp01(fbm(ns.moist, x, y, 3, 26) * 0.6 + near * 0.55);
        /* Fertility follows the water table and dislikes high ground:
           the good soil is in the valley, which is where a river map
           wants the player to farm. */
        ctx.fert[i] = U.clamp01(
          fbm(ns.fert, x, y, 3, 21) * 0.62 +
          near * 0.30 -
          U.clamp01((ctx.elev[i] - 0.5) * 0.8) * 0.2 + 0.08
        );
      }
    }
  }

  function chooseTerrain(ctx) {
    var size = ctx.size, terr = ctx.terr, bio = ctx.bio;
    var openMoist = [], openFert = [], i;
    for (i = 0; i < size; i++) {
      if (ctx.rock[i] || ctx.water[i]) continue;
      openMoist.push(ctx.moist[i]);
      openFert.push(ctx.fert[i]);
    }
    /* Thresholds as quantiles of the open ground, so "a third of an arid
       map is sand" stays true whatever the noise did this time. */
    var sandThr = quantileOfList(openMoist, bio.sandiness);
    var marshThr = quantileOfList(openMoist, 1 - bio.marshiness);
    var richThr = quantileOfList(openFert, 1 - bio.richness);

    for (i = 0; i < size; i++) {
      if (ctx.rock[i]) { terr[i] = 'rockFloor'; continue; }
      if (ctx.water[i] === WATER_DEEP) { terr[i] = 'deepWater'; continue; }
      if (ctx.water[i] === WATER_SHALLOW) { terr[i] = 'shallowWater'; continue; }

      var wd = ctx.waterDist[i], rd = ctx.rockDist[i];
      var m = ctx.moist[i], f = ctx.fert[i];

      if (wd <= 2 && m >= marshThr) terr[i] = 'marsh';
      else if (wd <= 1) terr[i] = 'mud';
      else if (rd <= bio.gravelSpread) terr[i] = 'gravel';
      else if (m <= sandThr) terr[i] = 'sand';
      else if (f >= richThr && wd <= 14) terr[i] = 'richSoil';
      else terr[i] = 'soil';
    }
  }

  /* Everything above worked on arrays; this is the one pass that writes
     to the map, so each cell recomputes its path cost exactly once. */
  function materialise(ctx) {
    var map = ctx.map, w = ctx.w, h = ctx.h;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        map.setTerrain(x, y, ctx.terr[i]);
        var code = ctx.rock[i];
        if (!code) continue;
        map.spawnThing(ROCK_DEFS[code], x, y, { faction: null });
        map.setRoof(x, y, 2);
      }
    }
  }

  /* Open ground the outside air cannot reach is a cave, and a cave is
     under the same thick roof as the rock around it. */
  function roofCaves(ctx) {
    var w = ctx.w, h = ctx.h, size = ctx.size, rock = ctx.rock;
    var seen = new Uint8Array(size);
    var queue = new Int32Array(size);
    var head = 0, tail = 0, x, y, i;

    for (x = 0; x < w; x++) {
      i = x;
      if (!rock[i] && !seen[i]) { seen[i] = 1; queue[tail++] = i; }
      i = (h - 1) * w + x;
      if (!rock[i] && !seen[i]) { seen[i] = 1; queue[tail++] = i; }
    }
    for (y = 0; y < h; y++) {
      i = y * w;
      if (!rock[i] && !seen[i]) { seen[i] = 1; queue[tail++] = i; }
      i = y * w + w - 1;
      if (!rock[i] && !seen[i]) { seen[i] = 1; queue[tail++] = i; }
    }

    while (head < tail) {
      var cur = queue[head++];
      x = cur % w; y = (cur / w) | 0;
      for (var k = 0; k < 4; k++) {
        var nx = x + U.ADJ4[k][0], ny = y + U.ADJ4[k][1];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        var ni = ny * w + nx;
        if (seen[ni] || rock[ni]) continue;
        seen[ni] = 1;
        queue[tail++] = ni;
      }
    }

    for (i = 0; i < size; i++) {
      if (!rock[i] && !seen[i]) ctx.map.setRoof(i % w, (i / w) | 0, 2);
    }
  }

  /* ============================================================
     PLANTS

     Composition is data: a plant def already says which biomes it grows
     in, how densely, and how big a patch it arrives in. What mapgen adds
     is clustering. Scattering by per-cell probability gives an even
     static of trees; seeding patches inside a low-frequency clump field
     gives woods with clearings between them, which is what a map needs
     if clearing land is going to mean anything.
     ============================================================ */

  function wildPlantsFor(biome) {
    var all = Defs.all('thing');
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var def = all[i];
      if (def.category !== 'plant' || !def.plant) continue;
      var p = def.plant;
      if (!(p.wildDensity > 0)) continue;
      if (p.wildBiomes && p.wildBiomes.indexOf(biome) < 0) continue;
      out.push(def);
    }
    /* Trees first: they are the biggest claim on a cell, and a wood that
       has to fit around the grass is not a wood. */
    out.sort(function (a, b) {
      var at = a.plant.isTree ? 0 : 1, bt = b.plant.isTree ? 0 : 1;
      if (at !== bt) return at - bt;
      return a.plant.wildDensity - b.plant.wildDensity;
    });
    return out;
  }

  function plantCount(map) {
    var all = Defs.all('thing'), n = 0;
    for (var i = 0; i < all.length; i++) {
      if (all[i].category === 'plant') n += map.byDef(all[i].id).length;
    }
    return n;
  }

  function spawnPlants(ctx) {
    var map = ctx.map;
    var defs = wildPlantsFor(ctx.biome);
    if (!defs.length) return 0;

    /* plants.js owns wild growth once the game is running and may want to
       do the initial pass itself. Give it the chance, then check whether
       it actually covered the map; if it did not, seed the map here.
       The contract leaves the shape of its opts open, so a version that
       wants different fields is allowed to reject this call outright -
       what it must not do is take the whole map generator down with it. */
    var P = sys('Plants');
    var before = plantCount(map);
    if (P && typeof P.spawnWild === 'function') {
      try {
        P.spawnWild(map, {
          biome: ctx.biome, density: ctx.bio.plantDensity, initial: true,
          x: 0, y: 0, w: ctx.w, h: ctx.h
        });
      } catch (e) {
        if (root.Game && root.Game.debug) console.log('Plants.spawnWild declined: ' + e.message);
      }
    }
    var made = plantCount(map) - before;
    var expected = 0;
    for (var d = 0; d < defs.length; d++) {
      expected += defs[d].plant.wildDensity * ctx.bio.plantDensity * ctx.size * 0.6;
    }
    if (made >= expected * 0.5) return made;

    return seedPlants(ctx, defs);
  }

  function seedPlants(ctx, defs) {
    var map = ctx.map, w = ctx.w, size = ctx.size;
    var eligible = [];
    for (var i = 0; i < size; i++) {
      if (ctx.rock[i] || ctx.water[i]) continue;
      var t = map.terrainAtIdx(i);
      if (!t || !t.supportsPlants || !(t.fertility > 0)) continue;
      eligible.push(i);
    }
    if (!eligible.length) return 0;

    var total = 0;
    for (var d = 0; d < defs.length; d++) {
      var def = defs[d], p = def.plant;
      var bias = ctx.bio.plantBias[def.id];
      var density = p.wildDensity * ctx.bio.plantDensity * (bias === undefined ? 1 : bias);
      var cluster = p.wildCluster || [1, 1];
      var avg = Math.max(1, (cluster[0] + cluster[1]) / 2);
      var patches = Math.round(density * eligible.length / avg);
      if (patches <= 0) continue;

      var clumpSeed = (ctx.ns.clump + U.hash(def.id)) >>> 0;
      /* A rarity that would never form a patch still wants to exist, so
         the clump gate loosens as the plant gets rarer. */
      var gate = 0.52 - U.clamp01(density * 6) * 0.22;

      for (var s = 0; s < patches; s++) {
        var seedCell = pickClumped(ctx, eligible, clumpSeed, gate);
        if (seedCell < 0) continue;
        var n = U.randInt(cluster[0], cluster[1]);
        var radius = 1 + Math.sqrt(n);
        total += scatterPatch(ctx, def, seedCell % w, (seedCell / w) | 0, n, radius);
      }
    }
    return total;
  }

  function pickClumped(ctx, eligible, clumpSeed, gate) {
    var w = ctx.w;
    var fallback = -1;
    for (var tries = 0; tries < 14; tries++) {
      var i = eligible[U.randInt(0, eligible.length - 1)];
      if (fallback < 0) fallback = i;
      var x = i % w, y = (i / w) | 0;
      if (fbm(clumpSeed, x, y, 2, 13) >= gate) return i;
    }
    return fallback;
  }

  function scatterPatch(ctx, def, cx, cy, count, radius) {
    var map = ctx.map, made = 0;
    var isTree = !!def.plant.isTree;
    for (var k = 0; k < count; k++) {
      var x = Math.round(cx + U.gauss(0, radius * 0.6, -radius, radius));
      var y = Math.round(cy + U.gauss(0, radius * 0.6, -radius, radius));
      if (!map.inBounds(x, y)) continue;
      var i = map.idx(x, y);
      if (ctx.rock[i] || ctx.water[i]) continue;
      if (map.plantAt(x, y) || map.buildingAt(x, y)) continue;
      var t = map.terrainAtIdx(i);
      if (!t || !t.supportsPlants) continue;
      if (t.fertility < def.plant.minFertility) continue;
      /* Wild growth is staggered in age: a stand of identical saplings
         would ripen as one, and a forest that is all mature is a forest
         with no future. */
      var growth = isTree ? U.randRange(0.35, 1) : U.randRange(0.2, 1);
      if (map.spawnThing(def.id, x, y, { growth: growth })) made++;
    }
    return made;
  }

  /* ============================================================
     WILDLIFE
     ============================================================ */

  function spawnWildlife(ctx) {
    var A = sys('Animals');
    if (!A || typeof A.spawnWild !== 'function') return;
    var map = ctx.map, bio = ctx.bio;

    var herds = U.randInt(bio.herds[0], bio.herds[1]);
    for (var i = 0; i < herds; i++) {
      var spot = randomOpenCell(ctx, 6);
      if (!spot) break;
      A.spawnWild(map, U.pick(bio.herbivores), spot.x, spot.y);
    }

    /* One or two predators. More than that and a fresh colony loses a
       colonist to a wolf before it has a wall. */
    var preds = U.randInt(1, 2);
    for (var p = 0; p < preds; p++) {
      var at = randomOpenCell(ctx, 6);
      if (!at) break;
      A.spawnWild(map, U.pick(bio.predators), at.x, at.y, U.randInt(1, 2));
    }
  }

  function randomOpenCell(ctx, margin) {
    var map = ctx.map, w = ctx.w, h = ctx.h;
    for (var tries = 0; tries < 200; tries++) {
      var x = U.randInt(margin, w - 1 - margin);
      var y = U.randInt(margin, h - 1 - margin);
      if (!map.passable(x, y)) continue;
      var t = map.terrainAt(x, y);
      if (t && t.isWater) continue;
      return { x: x, y: y };
    }
    return null;
  }

  /* ============================================================
     PAWN GENERATION

     pawn.js owns the pawn; this owns who that pawn turns out to be.
     Backstories come first because they seed the skills, traits are
     filtered so a person never holds two opposite opinions of
     themselves, and everything is handed to the constructor at once so
     work priorities are built from the finished person.
     ============================================================ */

  var MAX_LEVEL = 20;

  /* Traits that answer the same question about someone. pawn.js keeps
     its own copy for the pawns it rolls unaided; this one is here so
     mapgen never hands it a contradictory pair to begin with. */
  var TRAIT_GROUPS = {
    optimist: 'nature', pessimist: 'nature',
    ironWilled: 'nerves', neurotic: 'nerves', volatile: 'nerves',
    industrious: 'drive', lazy: 'drive', slothful: 'drive',
    jogger: 'speed', slowpoke: 'speed',
    tough: 'body', wimp: 'body',
    carefulShooter: 'combatStyle', triggerHappy: 'combatStyle', brawler: 'combatStyle',
    gourmand: 'appetite', ascetic: 'appetite',
    kind: 'temperament', abrasive: 'temperament', psychopath: 'temperament'
  };

  function defsOf(category) {
    if (!Defs || !Defs.all) return [];
    return Defs.all(category) || [];
  }
  function defMaybe(category, id) {
    if (!Defs || !Defs.maybe || !id) return null;
    return Defs.maybe(category, id);
  }

  function isAnimalKind(kindId) {
    var def = defMaybe('pawnKind', kindId);
    if (!def) return !!ANIMAL_KINDS[kindId];
    if (def.isAnimal !== undefined) return !!def.isAnimal;
    if (def.animal !== undefined) return !!def.animal;
    if (def.body && def.body !== 'human') return true;
    return !!ANIMAL_KINDS[kindId];
  }

  function backstorySlot(def) {
    var s = def.slot || def.stage || def.backstorySlot || def.type;
    if (s === 'childhood' || s === 'adulthood') return s;
    if (/^child/i.test(def.id)) return 'childhood';
    if (/^adult/i.test(def.id)) return 'adulthood';
    return null;
  }

  var _bsPool = null;
  function backstoryPool() {
    if (_bsPool) return _bsPool;
    var all = defsOf('backstory');
    var out = { childhood: [], adulthood: [] };
    for (var i = 0; i < all.length; i++) {
      var slot = backstorySlot(all[i]);
      if (slot) out[slot].push(all[i]);
    }
    if (all.length) _bsPool = out;
    return out;
  }

  function backstoryWeight(def, favor) {
    var w = def.commonality === undefined ? 1 : Math.max(0.02, def.commonality);
    if (favor && def.skillGains && def.skillGains[favor] > 0) {
      w *= 1 + def.skillGains[favor];
    }
    return w;
  }

  function rollBackstories(ageYears, favor) {
    var pool = backstoryPool();
    var child = pool.childhood.length
      ? U.pickWeighted(pool.childhood, function (b) { return backstoryWeight(b, favor); })
      : null;
    /* Someone born in the colony and still a child has no adulthood, and
       inventing one would be a lie about them. */
    var adult = (ageYears >= 18 && pool.adulthood.length)
      ? U.pickWeighted(pool.adulthood, function (b) { return backstoryWeight(b, favor); })
      : null;
    return { childhood: child ? child.id : null, adulthood: adult ? adult.id : null };
  }

  function traitGroupOf(def) {
    return def.exclusionGroup || def.group || TRAIT_GROUPS[def.id] || null;
  }

  function traitConflicts(def, chosen, banned) {
    if (banned && banned.indexOf(def.id) >= 0) return true;
    var group = traitGroupOf(def);
    var listed = def.conflicts || def.conflictingTraits || null;
    for (var i = 0; i < chosen.length; i++) {
      var other = chosen[i];
      if (other.id === def.id) return true;
      var otherGroup = traitGroupOf(other);
      if (group && otherGroup && group === otherGroup) return true;
      if (listed && listed.indexOf(other.id) >= 0) return true;
      var back = other.conflicts || other.conflictingTraits;
      if (back && back.indexOf(def.id) >= 0) return true;
    }
    return false;
  }

  function rollTraits(count, banned) {
    var pool = defsOf('trait');
    var chosen = [];
    if (!pool.length) return [];
    var guard = 0;
    while (chosen.length < count && guard++ < 80) {
      var def = U.pickWeighted(pool, function (t) {
        return t.commonality === undefined ? 1 : Math.max(0, t.commonality);
      });
      if (!def || traitConflicts(def, chosen, banned)) continue;
      chosen.push(def);
    }
    return chosen.map(function (t) { return t.id; });
  }

  function addSkillGains(into, def) {
    var gains = def && (def.skillGains || def.skillGain);
    if (!gains) return;
    for (var k in gains) into[k] = (into[k] || 0) + (gains[k] | 0);
  }

  function xpToNext(level) { return 1000 * (level + 1); }

  function rollSkills(backstories, traits, ageYears, favor) {
    var skills = defsOf('skill');
    var out = {};
    if (!skills.length) return out;

    var gains = {};
    addSkillGains(gains, defMaybe('backstory', backstories.childhood));
    addSkillGains(gains, defMaybe('backstory', backstories.adulthood));
    for (var t = 0; t < traits.length; t++) addSkillGains(gains, defMaybe('trait', traits[t]));

    /* Years count for something: a drifter of forty has picked things up
       along the way that an eighteen year old has not. */
    var maturity = U.clamp((ageYears - 18) / 22, 0, 1);

    for (var i = 0; i < skills.length; i++) {
      var id = skills[i].id;
      var base = gains[id] || 0;
      var level = Math.round(base + U.gauss(1.3 + 3.4 * maturity, 2.6, -3, 10));
      /* A trade nobody trained you in is usually a trade you do not have. */
      if (base <= 0 && U.chance(0.35)) level -= 3;
      level = U.clamp(level, 0, MAX_LEVEL);
      if (favor === id && level < 6) level = U.randInt(6, 9);
      out[id] = {
        level: level,
        xp: level >= MAX_LEVEL ? 0 : U.randInt(0, xpToNext(level) - 1),
        passion: 0,
        lastGainTick: 0
      };
    }
    assignPassions(out, skills, favor);
    return out;
  }

  /* Roughly one skill in five burns a little and one in twelve burns
     hard, capped so nobody rolls a prodigy at everything. */
  function assignPassions(table, skills, favor) {
    var order = U.shuffle(skills.slice());
    var majors = 0, total = 0;
    for (var i = 0; i < order.length; i++) {
      var s = table[order[i].id];
      if (!s) continue;
      if (total >= 6) break;
      var r = U.rand();
      if (r < 1 / 12 && majors < 3) { s.passion = 2; majors++; total++; }
      else if (r < 1 / 12 + 1 / 5) { s.passion = 1; total++; }
    }
    /* Someone generated to fill a role at least cares about it, which is
       also what pushes that work up their priority list. */
    if (favor && table[favor] && table[favor].passion === 0) table[favor].passion = 1;
  }

  function ageFor(kind, isAnimal) {
    var range = (kind && kind.ageRange) || (isAnimal ? [1, 8] : [19, 58]);
    return Math.round(U.gauss((range[0] + range[1]) / 2, (range[1] - range[0]) / 4,
                              range[0], range[1]));
  }

  MapGen.makePawn = function (kindId, faction, opts) {
    opts = opts || {};
    if (!root.Pawn) return null;
    var kind = defMaybe('pawnKind', kindId);
    var animal = isAnimalKind(kindId);

    var build = {
      x: opts.x | 0, y: opts.y | 0,
      map: opts.map || null,
      gender: opts.gender,
      ageYears: opts.ageYears,
      tame: opts.tame
    };

    if (animal) {
      if (build.ageYears === undefined) build.ageYears = ageFor(kind, true);
      var beast = new root.Pawn(kindId, faction || 'wild', build);
      if (opts.tame !== undefined) beast.tame = !!opts.tame;
      return beast;
    }

    var gender = opts.gender || (U.chance(0.5) ? 'male' : 'female');
    var ageYears = opts.ageYears === undefined ? ageFor(kind, false) : opts.ageYears;
    var favor = opts.favorSkill || null;

    var backstories = opts.backstories || rollBackstories(ageYears, favor);
    var traits = opts.traits || rollTraits(U.chance(0.4) ? 3 : 2, opts.bannedTraits);
    var skills = opts.skills || rollSkills(backstories, traits, ageYears, favor);

    build.gender = gender;
    build.ageYears = ageYears;
    build.backstories = backstories;
    build.traits = traits;
    build.skills = skills;
    if (opts.name) build.name = opts.name;

    var pawn = new root.Pawn(kindId, faction || 'neutral', build);

    /* Gear has to be made out of Things, and Things only exist on a map,
       so a pawn built without one is dressed later by whoever spawns it.
       A raider is only armed here when the caller states the raid's
       points: events.js builds its raiders first and calls equipRaider
       itself once it knows how big the raid is, and arming them twice
       would leave a trail of dropped clubs across the map edge. */
    if (pawn.map && opts.gear !== false) {
      if (opts.points !== undefined) {
        MapGen.equipRaider(pawn, opts.points, opts);
      } else if (faction !== 'raider') {
        if (opts.gear === true) pawn.equipKindGear();
        MapGen.dressPawn(pawn, opts);
      }
    }
    return pawn;
  };

  /* ---------- raider gear ----------
     Raid points buy quality, not just numbers: a fifty-point raid is
     tribals with clubs, a thousand-point raid arrives in flak vests. */
  var RAIDER_WEAPONS = [
    { id: 'club', lo: -0.3, peak: 0.05, hi: 0.45 },
    { id: 'knife', lo: -0.3, peak: 0.05, hi: 0.45 },
    { id: 'spear', lo: -0.2, peak: 0.15, hi: 0.55 },
    { id: 'shortBow', lo: -0.2, peak: 0.2, hi: 0.6 },
    { id: 'pistol', lo: 0.0, peak: 0.35, hi: 0.9 },
    { id: 'shotgun', lo: 0.15, peak: 0.5, hi: 1.1 },
    { id: 'boltRifle', lo: 0.2, peak: 0.6, hi: 1.2 },
    { id: 'autoRifle', lo: 0.45, peak: 1.0, hi: 1.6 },
    { id: 'sniperRifle', lo: 0.55, peak: 1.1, hi: 1.7 }
  ];
  var PRIMITIVE_WEAPONS = { club: 1, knife: 1, spear: 1, shortBow: 1 };
  /* Apparel that pawn.js puts in the same layer over the torso: at most
     one of these can be worn, and offering two drops the first. */
  var MIDDLE_TORSO = { jacket: 1, parka: 1, armorVest: 1 };

  function weaponWeight(entry, tier) {
    if (tier <= entry.lo || tier >= entry.hi) return 0;
    var span = tier < entry.peak ? entry.peak - entry.lo : entry.hi - entry.peak;
    if (span <= 0) return 0;
    return 1 - Math.abs(tier - entry.peak) / span;
  }

  MapGen.equipRaider = function (pawn, points, opts) {
    opts = opts || {};
    var map = pawn && pawn.map;
    if (!map || !map.spawnThing) return false;
    var tier = U.clamp((points || 0) / 700, 0, 1);
    var kind = pawn.kind;
    var cold = opts.cold !== undefined ? opts.cold : isColdMap(map);

    /* A kind that names its own arsenal wins; the tier only decides which
       of those it reaches for. */
    var allowed = (kind && kind.weapons && kind.weapons.length) ? kind.weapons : null;
    if (!allowed && pawn.kindId === 'tribalRaider') {
      allowed = ['club', 'spear', 'shortBow', 'knife'];
    }

    var pool = [];
    for (var i = 0; i < RAIDER_WEAPONS.length; i++) {
      var e = RAIDER_WEAPONS[i];
      if (allowed && allowed.indexOf(e.id) < 0) continue;
      if (!Defs.has('thing', e.id)) continue;
      if (weaponWeight(e, tier) > 0) pool.push(e);
    }
    var weaponId = null;
    if (pool.length) {
      weaponId = U.pickWeighted(pool, function (e) { return weaponWeight(e, tier); }).id;
    } else if (allowed && allowed.length) {
      weaponId = U.pick(allowed);
    }
    /* A brawler who was handed a rifle is a brawler who will not use it. */
    if (weaponId && pawn.traits && pawn.traits.indexOf('brawler') >= 0 &&
        !PRIMITIVE_WEAPONS[weaponId] && Defs.has('thing', 'knife')) {
      weaponId = U.chance(0.7) ? 'knife' : weaponId;
    }
    if (weaponId) {
      var weapon = map.spawnThing(weaponId, pawn.x, pawn.y);
      if (weapon) pawn.equip(weapon);
    }

    var base;
    if (kind && kind.apparel && kind.apparel.length) {
      base = kind.apparel.slice();
    } else {
      base = ['shirt', 'pants'];
      if (cold) base.push('parka');
      else if (tier > 0.15) base.push('jacket');
    }
    var vest = Defs.has('thing', 'armorVest') && U.chance(tier * 0.75);

    var wear = [], a;
    for (a = 0; a < base.length; a++) {
      /* Flak sits in the same layer as a coat. Handing a raider both
         means pawn.wear throws the coat straight back on the floor, and
         the map edge ends up carpeted in jackets nobody dropped. */
      if (vest && MIDDLE_TORSO[base[a]]) continue;
      wear.push(base[a]);
    }
    if (vest) wear.push('armorVest');
    if (U.chance(tier * 0.6)) wear.push('helmet');

    for (var k = 0; k < wear.length; k++) {
      if (!Defs.has('thing', wear[k]) || alreadyWearing(pawn, wear[k])) continue;
      var piece = map.spawnThing(wear[k], pawn.x, pawn.y);
      if (piece) pawn.wear(piece);
    }
    return true;
  };

  /* Everyone who is not a raider still arrives dressed. Two pieces of
     cloth is not wealth worth counting, and a colonist with no jacket
     in a boreal winter is a hypothermia case in the first week. */
  MapGen.dressPawn = function (pawn, opts) {
    opts = opts || {};
    var map = pawn && pawn.map;
    if (!map || !map.spawnThing || pawn.isAnimal) return false;
    var cold = opts.cold !== undefined ? opts.cold : isColdMap(map);
    var wear = ['shirt', 'pants'];
    if (cold) wear.push('parka');
    else if (U.chance(0.35)) wear.push('jacket');
    for (var i = 0; i < wear.length; i++) {
      if (!Defs.has('thing', wear[i]) || alreadyWearing(pawn, wear[i])) continue;
      var piece = map.spawnThing(wear[i], pawn.x, pawn.y);
      if (piece) pawn.wear(piece);
    }
    return true;
  };

  /* The map remembers which biome it was cut from, and Game holds the
     answer for a map that predates this field. */
  function isColdMap(map) {
    var biome = (map && map.biome) || (root.Game && root.Game.biome) || '';
    return biome === 'borealForest';
  }

  function alreadyWearing(pawn, defId) {
    for (var i = 0; i < pawn.apparel.length; i++) {
      if (pawn.apparel[i].defId === defId) return true;
    }
    return false;
  }

  /* ============================================================
     THE STARTING COLONY
     ============================================================ */

  var START_ITEMS = [
    { defId: 'silver', count: 800 },
    { defId: 'steel', count: 300 },
    { defId: 'wood', count: 50 },
    { defId: 'mealSimple', count: 30 },
    { defId: 'medicine', count: 3 }
  ];
  var START_WEAPONS = [
    { id: 'boltRifle', w: 3 },
    { id: 'pistol', w: 3 },
    { id: 'shotgun', w: 2 },
    { id: 'shortBow', w: 1 }
  ];

  /* The roles a colony cannot open without, in the order it needs them.
     A colony of one needs to eat before it needs a wall. */
  var ROLES = [
    { id: 'feed', favor: 'cooking', test: function (p) {
        return (workable(p, 'cook') && p.skillLevel('cooking') >= 3) ||
               (workable(p, 'grow') && p.skillLevel('plants') >= 3);
      } },
    { id: 'build', favor: 'construction', test: function (p) {
        return workable(p, 'construct') && p.skillLevel('construction') >= 3;
      } },
    { id: 'shoot', favor: 'shooting', test: function (p) {
        return p.skillLevel('shooting') >= 4 && p.traits.indexOf('brawler') < 0;
      } }
  ];

  function workable(pawn, workTypeId) {
    if (!Defs.has('workType', workTypeId)) return true;
    return pawn.priorityOf(workTypeId) > 0;
  }

  function anyWorkEnabled(pawn) {
    var types = defsOf('workType');
    if (!types.length) return true;
    for (var i = 0; i < types.length; i++) {
      if (pawn.priorityOf(types[i].id) > 0) return true;
    }
    return false;
  }

  function trioPlayable(pawns, count) {
    for (var i = 0; i < pawns.length; i++) {
      if (!anyWorkEnabled(pawns[i])) return false;
    }
    if (!defsOf('skill').length) return true;
    var needed = Math.min(count, ROLES.length);
    for (var r = 0; r < needed; r++) {
      var found = false;
      for (var p = 0; p < pawns.length && !found; p++) {
        if (ROLES[r].test(pawns[p])) found = true;
      }
      if (!found) return false;
    }
    return true;
  }

  function rollColonists(map, count, spot) {
    var attempt, i, pawns;
    /* Cheap route first: roll the whole group and keep it if it works.
       Most groups do, and a group rolled freely reads as a group of
       people rather than a set of job titles. */
    for (attempt = 0; attempt < 40; attempt++) {
      pawns = [];
      for (i = 0; i < count; i++) {
        pawns.push(MapGen.makePawn('colonist', 'player', {
          x: spot.x, y: spot.y, map: map, gear: false
        }));
      }
      if (trioPlayable(pawns, count)) return pawns;
    }

    /* Forty unlucky groups in a row means the def tables cannot produce
       one by chance, so the last group is built to the roles directly. */
    pawns = [];
    for (i = 0; i < count; i++) {
      var role = ROLES[i % ROLES.length];
      pawns.push(MapGen.makePawn('colonist', 'player', {
        x: spot.x, y: spot.y, map: map, gear: false,
        favorSkill: role.favor,
        bannedTraits: role.id === 'shoot' ? ['brawler'] : null
      }));
    }
    return pawns;
  }

  MapGen.spawnStartingColony = function (map, count, opts) {
    opts = opts || {};
    count = count > 0 ? (count | 0) : 3;

    var spot = (opts.landing && map.inBounds(opts.landing.x, opts.landing.y))
      ? { x: opts.landing.x | 0, y: opts.landing.y | 0 }
      : MapGen.landingSpot(map);

    clearLandingSite(map, spot);

    var pawns = rollColonists(map, count, spot);
    var cells = freeCellsAround(map, spot.x, spot.y, 4, count);
    for (var i = 0; i < pawns.length; i++) {
      var at = cells[i] || spot;
      pawns[i].spawn(map, at.x, at.y);
      MapGen.dressPawn(pawns[i], {});
    }

    dropStartingItems(map, spot);
    map.landingSpot = { x: spot.x, y: spot.y };
    return pawns;
  };

  /* The pods came down here and flattened what was growing. A temperate
     map is nine tenths under plants, so without this the colony's first
     hour is spent cutting grass to find somewhere to put a stockpile.
     The clearing thins outward and leaves most of the trees, which reads
     as a scar rather than a lawn. */
  function clearLandingSite(map, spot) {
    var ring = U.cellsInRadius(spot.x, spot.y, 6);
    for (var i = 0; i < ring.length; i++) {
      var x = ring[i][0], y = ring[i][1];
      var plant = map.inBounds(x, y) ? map.plantAt(x, y) : null;
      if (!plant) continue;
      var d = U.dist(x, y, spot.x, spot.y);
      var isTree = !!(plant.def.plant && plant.def.plant.isTree);
      if (isTree) {
        if (d <= 3 || (d <= 4.5 && U.chance(0.5))) map.despawnThing(plant);
        continue;
      }
      if (d <= 2 || U.chance(U.lerp(0.9, 0.2, U.clamp01((d - 2) / 4)))) {
        map.despawnThing(plant);
      }
    }
  }

  function dropStartingItems(map, spot) {
    var drops = START_ITEMS.slice();
    for (var n = 0; n < 2; n++) {
      var pick = U.pickWeighted(START_WEAPONS, function (e) {
        return Defs.has('thing', e.id) ? e.w : 0;
      });
      if (pick) drops.push({ defId: pick.id, count: 1 });
    }

    /* One kind of thing per cell where possible: a single tile holding
       eight hundred silver, three medicine and a rifle is a tile the
       player cannot read at a glance. */
    var cells = freeCellsAround(map, spot.x, spot.y, 5, drops.length + 4);
    var ci = 0;
    for (var i = 0; i < drops.length; i++) {
      if (!Defs.has('thing', drops[i].defId)) continue;
      var at = cells[ci++] || spot;
      map.addItem(drops[i].defId, at.x, at.y, drops[i].count);
    }
  }

  function freeCellsAround(map, cx, cy, radius, want) {
    var ring = U.cellsInRadius(cx, cy, radius);
    var out = [];
    for (var i = 0; i < ring.length && out.length < want; i++) {
      var x = ring[i][0], y = ring[i][1];
      if (!map.inBounds(x, y) || !map.passable(x, y)) continue;
      var t = map.terrainAt(x, y);
      if (t && t.isWater) continue;
      if (map.buildingAt(x, y)) continue;
      out.push({ x: x, y: y });
    }
    /* A landing site hemmed in this tightly should not have passed the
       spot check, but nothing downstream should crash if it did. */
    if (!out.length) out.push({ x: cx, y: cy });
    return out;
  }

  /* ---------- picking where to land ----------
     Flat, fertile, off the edge, and - the part that actually matters -
     standing in the map's main walkable body. A beautiful clearing
     sealed inside a mountain is a lost colony. */
  MapGen.landingSpot = function (map) {
    var labels = componentLabels(map);
    var best = bestComponent(labels);
    var minSize = Math.max(200, Math.floor(map.size * 0.10));

    var margin = Math.max(10, Math.floor(Math.min(map.w, map.h) * 0.12));
    var step = Math.max(2, Math.floor(Math.min(map.w, map.h) / 45));
    var candidates = [];
    var hazards = predatorPositions(map);

    for (var y = margin; y < map.h - margin; y += step) {
      for (var x = margin; x < map.w - margin; x += step) {
        var i = map.idx(x, y);
        if (labels.label[i] !== best.id) continue;
        var t = map.terrainAt(x, y);
        if (!t || t.isWater) continue;
        candidates.push({ x: x, y: y, score: scoreSpot(map, x, y, hazards) });
      }
    }
    if (!candidates.length) return fallbackSpot(map);

    candidates.sort(function (a, b) { return b.score - a.score; });

    /* Verify the top few for real rather than trusting the score: the
       body of ground has to be big and open to the map edge, and each
       spot has to have room for three people and their supplies. */
    var bodyOk = best.size >= minSize && edgeReachable(map, labels, best.id);
    if (bodyOk) {
      var limit = Math.min(candidates.length, 24);
      for (var c = 0; c < limit; c++) {
        var spot = candidates[c];
        if (freeCellsAround(map, spot.x, spot.y, 4, 12).length < 10) continue;
        if (!pathConfirms(map, spot, labels, best.id)) continue;
        return { x: spot.x, y: spot.y };
      }
    }
    return { x: candidates[0].x, y: candidates[0].y };
  };

  /* Where the wolves already were. A colony that lands inside a predator's
     range loses somebody on the first afternoon, before the player has
     anything to answer with, and that reads as the game cheating rather
     than as a rimworld being dangerous. */
  var LOCAL_PREDATORS = { wolf: 1, bear: 1 };

  function predatorPositions(map) {
    var A = sys('Animals');
    var out = [];
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (!p.isAnimal || p.dead || p.faction === 'player') continue;
      var isPred = (A && A.isPredator) ? A.isPredator(p) : !!LOCAL_PREDATORS[p.kindId];
      if (isPred) out.push({ x: p.x, y: p.y });
    }
    return out;
  }

  function scoreSpot(map, cx, cy, hazards) {
    var open = 0, fert = 0, waterNear = 0, rockNear = 0, cells = 0;
    for (var dy = -5; dy <= 5; dy++) {
      for (var dx = -5; dx <= 5; dx++) {
        var x = cx + dx, y = cy + dy;
        if (!map.inBounds(x, y)) continue;
        cells++;
        var t = map.terrainAt(x, y);
        if (!t) continue;
        var near = Math.abs(dx) <= 3 && Math.abs(dy) <= 3;
        if (t.isWater) { waterNear++; continue; }
        if (map.passable(x, y)) {
          open++;
          fert += t.fertility || 0;
        }
        var b = map.buildingAt(x, y);
        if (b && b.def.natural) { rockNear++; if (near) rockNear += 2; }
      }
    }
    if (!cells) return -1e9;

    var score = 0;
    score += (open / cells) * 60;                        /* flat and walkable  */
    score += (fert / Math.max(1, open)) * 40;            /* something will grow */
    score -= (rockNear / cells) * 55;                    /* not in the scree    */
    /* Water in sight is good, water underfoot is not. */
    score += U.clamp(waterNear, 0, 14) * 1.1;
    score -= Math.max(0, waterNear - 26) * 2.0;

    var edge = Math.min(cx, cy, map.w - 1 - cx, map.h - 1 - cy);
    score += U.clamp(edge, 0, 22) * 0.8;

    /* Stone within a short walk is worth having; stone in the kitchen is
       not, and the rockNear penalty above already covers that. */
    score += rockWithin(map, cx, cy, 14) ? 6 : 0;

    if (hazards) {
      for (var k = 0; k < hazards.length; k++) {
        var gap = U.dist(cx, cy, hazards[k].x, hazards[k].y);
        if (gap < 24) score -= (24 - gap) * 2.5;
      }
    }
    return score;
  }

  function rockWithin(map, cx, cy, r) {
    for (var dy = -r; dy <= r; dy += 3) {
      for (var dx = -r; dx <= r; dx += 3) {
        var b = map.buildingAt(cx + dx, cy + dy);
        if (b && b.def.natural) return true;
      }
    }
    return false;
  }

  /* Connected components of passable ground, labelled once. This is the
     ground truth for "can anyone actually get there", and it is also how
     the spot check avoids trusting a pathfinder that may not have had
     its regions built yet. */
  function componentLabels(map) {
    var size = map.size, w = map.w, h = map.h;
    var label = new Int32Array(size);
    var sizes = [0];
    var queue = new Int32Array(size);
    var next = 1;

    for (var start = 0; start < size; start++) {
      if (label[start] || !map.passableIdx(start)) continue;
      var id = next++;
      var head = 0, tail = 0, n = 0;
      label[start] = id;
      queue[tail++] = start;
      while (head < tail) {
        var cur = queue[head++];
        n++;
        var x = cur % w, y = (cur / w) | 0;
        for (var k = 0; k < 4; k++) {
          var nx = x + U.ADJ4[k][0], ny = y + U.ADJ4[k][1];
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          var ni = ny * w + nx;
          if (label[ni] || !map.passableIdx(ni)) continue;
          label[ni] = id;
          queue[tail++] = ni;
        }
      }
      sizes[id] = n;
    }
    return { label: label, sizes: sizes };
  }

  function bestComponent(labels) {
    var bestId = 0, bestSize = 0;
    for (var i = 1; i < labels.sizes.length; i++) {
      if (labels.sizes[i] > bestSize) { bestSize = labels.sizes[i]; bestId = i; }
    }
    return { id: bestId, size: bestSize };
  }

  function edgeReachable(map, labels, id) {
    var w = map.w, h = map.h, x, y;
    for (x = 0; x < w; x++) {
      if (labels.label[x] === id) return true;
      if (labels.label[(h - 1) * w + x] === id) return true;
    }
    for (y = 0; y < h; y++) {
      if (labels.label[y * w] === id) return true;
      if (labels.label[y * w + w - 1] === id) return true;
    }
    return false;
  }

  /* A second opinion from the pathfinder when there is one. The labels
     already answered the question; this catches the case where the two
     disagree, which would mean the colony is about to be told it can
     walk somewhere the game will refuse to path it to. */
  function pathConfirms(map, spot, labels, id) {
    var Path = sys('Path');
    if (!Path || typeof Path.reachable !== 'function') return true;
    var target = null, w = map.w, h = map.h, x, y;
    for (x = 1; x < w - 1 && !target; x++) {
      if (labels.label[x] === id) target = { x: x, y: 0 };
      else if (labels.label[(h - 1) * w + x] === id) target = { x: x, y: h - 1 };
    }
    for (y = 1; y < h - 1 && !target; y++) {
      if (labels.label[y * w] === id) target = { x: 0, y: y };
      else if (labels.label[y * w + w - 1] === id) target = { x: w - 1, y: y };
    }
    if (!target) return false;
    return Path.reachable(map, spot.x, spot.y, target.x, target.y, { peMode: 0 });
  }

  function fallbackSpot(map) {
    var cx = map.w >> 1, cy = map.h >> 1;
    var ring = U.cellsInRadius(cx, cy, Math.max(map.w, map.h) >> 1);
    for (var i = 0; i < ring.length; i++) {
      var x = ring[i][0], y = ring[i][1];
      if (!map.inBounds(x, y) || !map.passable(x, y)) continue;
      var t = map.terrainAt(x, y);
      if (t && t.isWater) continue;
      return { x: x, y: y };
    }
    return { x: cx, y: cy };
  }

  /* ============================================================
     ARRIVALS - raids walk in from an edge, cargo comes down from above
     ============================================================ */

  var SIDE_ALIASES = {
    n: 'n', north: 'n', top: 'n', up: 'n',
    s: 's', south: 's', bottom: 's', down: 's',
    e: 'e', east: 'e', right: 'e',
    w: 'w', west: 'w', left: 'w'
  };

  function normaliseSide(side) {
    if (typeof side === 'number') return ['n', 'e', 's', 'w'][side & 3];
    var key = String(side || '').toLowerCase();
    return SIDE_ALIASES[key] || U.pick(['n', 'e', 's', 'w']);
  }

  /* Every lane along one edge, walked inward until it finds open ground,
     so a raid arriving on the mountain side still arrives rather than
     being told there is no room. */
  MapGen.edgeSpawnCells = function (map, side) {
    var s = normaliseSide(side);
    var vertical = (s === 'n' || s === 's');
    var along = vertical ? map.w : map.h;
    var depth = Math.min(10, (vertical ? map.h : map.w) >> 2);
    var out = [];

    for (var i = 2; i < along - 2; i++) {
      var found = null;
      for (var d = 0; d < depth && !found; d++) {
        var x, y;
        if (s === 'n') { x = i; y = d; }
        else if (s === 's') { x = i; y = map.h - 1 - d; }
        else if (s === 'w') { x = d; y = i; }
        else { x = map.w - 1 - d; y = i; }
        if (!map.inBounds(x, y) || !map.passable(x, y)) continue;
        var t = map.terrainAt(x, y);
        if (t && t.isWater) continue;
        found = { x: x, y: y };
      }
      if (found) out.push(found);
    }
    return out;
  };

  /* Where the colony's stuff falls out of the sky: close enough to be a
     gift, far enough that it does not land on someone's head, and never
     under a roof it would have to punch through. */
  MapGen.dropPodSpot = function (map) {
    var anchor = colonyAnchor(map);
    var ring = U.cellsInRadius(anchor.x, anchor.y, 26);
    var fallback = null;

    for (var i = 0; i < ring.length; i++) {
      var x = ring[i][0], y = ring[i][1];
      if (!map.inBounds(x, y) || !map.passable(x, y)) continue;
      var t = map.terrainAt(x, y);
      if (t && t.isWater) continue;
      if (map.buildingAt(x, y)) continue;
      if (!fallback) fallback = { x: x, y: y };
      if (U.dist(x, y, anchor.x, anchor.y) < 5) continue;
      if (map.hasRoofAt(x, y)) continue;
      if (map.pawnsAt(x, y).length) continue;

      var open = 0;
      for (var k = 0; k < U.ADJ8.length; k++) {
        if (map.passable(x + U.ADJ8[k][0], y + U.ADJ8[k][1])) open++;
      }
      if (open < 5) continue;
      return { x: x, y: y };
    }
    return fallback || fallbackSpot(map);
  };

  function colonyAnchor(map) {
    var colonists = map.colonists ? map.colonists() : [];
    if (colonists.length) {
      var sx = 0, sy = 0;
      for (var i = 0; i < colonists.length; i++) { sx += colonists[i].x; sy += colonists[i].y; }
      return { x: Math.round(sx / colonists.length), y: Math.round(sy / colonists.length) };
    }
    if (map.landingSpot) return map.landingSpot;
    return { x: map.w >> 1, y: map.h >> 1 };
  }

  /* ---------- odds and ends the rest of the game asks for ---------- */

  MapGen.biomes = function () { return Object.keys(BIOMES); };
  MapGen.biomeLabel = function (id) {
    return (BIOMES[id] && BIOMES[id].label) || id;
  };
  /* def tables are rebuilt between test runs; the backstory pool is the
     one thing here that caches across a game. */
  MapGen.clearDefCache = function () { _bsPool = null; };

  root.MapGen = MapGen;
})(this);
