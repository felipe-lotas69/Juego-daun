/* ============================================================
   world.js - the planet, and the fact that the colony is one tile of it.

   Three ideas run through this file.

   Oceans are grown, not sprinkled. A threshold on a noise field puts
   water every third cell, and a world you cannot walk across is not a
   world. Here the sea floods out from a handful of seeds and always
   takes the lowest land left on its shore, so what comes out is a
   coastline with bays and headlands, and a continent wide enough that
   crossing it is a fortnight of someone's life.

   Distance is the point of everything built on top of this file. A
   caravan is an interesting decision only because the trip costs days
   you could have spent farming, so travelTicks is honest about biome,
   hills and roads, and a road really is worth the detour.

   Nothing here decides who owns what. The planet lays out sites where
   a town could stand; factions.js says whose flag flies over them.
   Everything the world knows lives in typed arrays plus one list of
   settlements, because save.js has to write the lot out and read it
   back, and a save file is no place for live object references.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  var World = {};

  /* ---------- tuning ---------- */

  var DEFAULT_W = 60, DEFAULT_H = 30;
  var SEA_LEVEL = 0.32;              /* elevation below this is under water */
  var OCEAN_FRACTION = 0.34;
  var BASE_TICKS_PER_TILE = 30000;   /* half a day on flat temperate ground */
  var DIAG = 1.4142135623730951;
  var ROAD_FACTOR = [1, 0.55, 0.45]; /* none, road, the highway a second route wore in */
  var MIN_SITE_DIST = 4;             /* keeps settlements three clear tiles apart */
  var MAX_ROAD_DIST = 13;            /* further than this and nobody keeps a road up */
  var RIVER_RAIN_BONUS = 0.1;
  var PATH_CACHE_MAX = 900;
  var RAIN_MM = 2000;                /* rainfall is stored 0..1; this is what 1 means */

  /* Rain by latitude: wet on the equator, the subtropical dry belt a
     quarter of the way to the pole, temperate rain again, then the cold
     desert nobody thinks of as a desert. */
  var RAIN_BY_LAT = [[0, 1], [0.12, 0.95], [0.28, 0.3], [0.42, 0.55], [0.58, 0.9], [0.75, 0.6], [1, 0.3]];
  var RAIN_BY_TEMP = [[-25, 0.25], [-5, 0.6], [5, 0.85], [15, 1], [40, 1]];
  var TEMP_LIVEABLE = [[-25, 0], [-10, 0.15], [0, 0.5], [10, 1], [22, 1], [32, 0.5], [42, 0.05]];
  var RAIN_LIVEABLE = [[0, 0.08], [0.1, 0.35], [0.3, 0.8], [0.6, 1], [1, 0.85]];
  var SEASON_OPPOSITE = { spring: 'fall', summer: 'winter', fall: 'spring', winter: 'summer' };

  /* def_factions.js owns the worldBiome defs and its numbers always win.
     This is the same table in miniature, for the day something loads the
     planet without them: same field names, same bands, so the generator
     below never has to know which of the two it is reading. */
  var BIOME_FALLBACK = [
    { id: 'temperateForest', label: 'temperate forest', color: '#4e7a3a', mapBiome: 'temperateForest',
      habitable: true, travelCostFactor: 1, settlementWeight: 1.6,
      temperatureBand: [-8, 28], rainfallBand: [0.42, 0.78], latitudeBand: [0.28, 0.62] },
    { id: 'grassland', label: 'grassland', color: '#7d9a4a', mapBiome: 'temperateForest',
      habitable: true, travelCostFactor: 0.85, settlementWeight: 1.5,
      temperatureBand: [-4, 31], rainfallBand: [0.3, 0.55], latitudeBand: [0.2, 0.5] },
    { id: 'aridShrubland', label: 'arid shrubland', color: '#9d9350', mapBiome: 'aridShrubland',
      habitable: true, travelCostFactor: 0.95, settlementWeight: 1.1,
      temperatureBand: [2, 38], rainfallBand: [0.16, 0.34], latitudeBand: [0.12, 0.42] },
    { id: 'desert', label: 'desert', color: '#c2b280', mapBiome: 'aridShrubland',
      habitable: true, travelCostFactor: 1.2, settlementWeight: 0.45,
      temperatureBand: [6, 46], rainfallBand: [0.03, 0.16], latitudeBand: [0.14, 0.38] },
    { id: 'borealForest', label: 'boreal forest', color: '#3e5f4a', mapBiome: 'borealForest',
      habitable: true, travelCostFactor: 1.15, settlementWeight: 0.9,
      temperatureBand: [-28, 22], rainfallBand: [0.35, 0.75], latitudeBand: [0.58, 0.8] },
    { id: 'tundra', label: 'tundra', color: '#8a927f', mapBiome: 'borealForest',
      habitable: true, travelCostFactor: 1.3, settlementWeight: 0.35,
      temperatureBand: [-38, 14], rainfallBand: [0.12, 0.6], latitudeBand: [0.76, 0.92] },
    { id: 'ocean', label: 'ocean', color: '#2f5d78', mapBiome: 'temperateForest',
      habitable: false, impassable: true, travelCostFactor: 0, settlementWeight: 0,
      temperatureBand: [-2, 26], rainfallBand: [0, 1], latitudeBand: [0, 1] }
  ];

  /* ---------- state ---------- */

  var w = 0, h = 0, size = 0;
  var grids = null;
  var biomeDefs = null;              /* index-aligned with the Uint8 biome grid */
  var oceanIndex = 0, landIndex = 0;
  var settlements = [];
  var settlementsById = new Map();
  var sites = [];
  var siteInfo = new Map();
  var colonyTile = 0;
  var worldSeed = 0;
  var noiseSeeds = { elevation: 1, rainfall: 2, warp: 3, detail: 4 };
  var minStepFactor = 0.45;

  /* A* scratch, allocated once per world so a path does not churn arrays. */
  var _g = null, _seen = null, _closed = null, _from = null, _heap = null, _mark = 0;
  var _pathCache = new Map();

  /* ---------- seeded value noise ----------
     Written here rather than borrowed, because it has to be a pure
     function of (seed, position): the same tile must give the same
     number whatever order the generator walks the map in, and it has to
     be periodic in x or the world would have a seam down one meridian. */

  function hashLattice(seed, xi, yi) {
    var n = (seed ^ Math.imul(xi | 0, 374761393) ^ Math.imul(yi | 0, 668265263)) | 0;
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967296;
  }

  function smoothstep(t) { return t * t * (3 - 2 * t); }

  /* u runs 0..1 around the world and wraps; v runs pole to pole and does
     not. fx is the number of lattice columns, so it must be a whole
     number: it is the period that hides the seam. */
  function valueNoise(seed, u, v, fx, fy) {
    var px = u * fx, py = v * fy;
    var x0 = Math.floor(px), y0 = Math.floor(py);
    var tx = smoothstep(px - x0), ty = smoothstep(py - y0);
    var xa = ((x0 % fx) + fx) % fx, xb = (((x0 + 1) % fx) + fx) % fx;
    var n00 = hashLattice(seed, xa, y0), n10 = hashLattice(seed, xb, y0);
    var n01 = hashLattice(seed, xa, y0 + 1), n11 = hashLattice(seed, xb, y0 + 1);
    return U.lerp(U.lerp(n00, n10, tx), U.lerp(n01, n11, tx), ty);
  }

  function fbm(seed, u, v, octaves, fx, fy) {
    var amp = 1, sum = 0, norm = 0;
    for (var o = 0; o < octaves; o++) {
      sum += amp * valueNoise(seed + o * 7919, u, v, fx, fy);
      norm += amp;
      amp *= 0.5; fx *= 2; fy *= 2;
    }
    return sum / norm;
  }

  /* ---------- grid helpers ---------- */

  function wrapX(x) { return ((x % w) + w) % w; }
  function idx(x, y) { return y * w + wrapX(x); }
  function xOf(i) { return i % w; }
  function yOf(i) { return (i / w) | 0; }
  function latOf(i) { return Math.abs((yOf(i) + 0.5) / h - 0.5) * 2; }
  function isOceanIdx(i) { return grids.biome[i] === oceanIndex; }

  function neighbourIdx(i, d) {
    var ny = yOf(i) + U.ADJ8[d][1];
    if (ny < 0 || ny >= h) return -1;
    return ny * w + wrapX(xOf(i) + U.ADJ8[d][0]);
  }

  function distanceIdx(a, b) {
    var dx = Math.abs(xOf(a) - xOf(b));
    if (dx > w * 0.5) dx = w - dx;
    var dy = yOf(a) - yOf(b);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ---------- biome defs ---------- */

  function resolveBiomeDefs() {
    var list = null;
    try {
      if (Defs && typeof Defs.all === 'function') list = Defs.all('worldBiome');
    } catch (e) { list = null; }
    if (!list || !list.length) list = BIOME_FALLBACK;

    biomeDefs = list.map(function (def, i) {
      var band = def.temperatureBand || [-60, 60];
      return {
        id: def.id, index: i, def: def,
        label: def.label || def.id,
        color: def.color || '#5c7a3e',
        mapBiome: def.mapBiome || 'temperateForest',
        habitable: def.habitable !== false && !def.impassable,
        impassable: !!def.impassable,
        travelCostFactor: def.travelCostFactor > 0 ? def.travelCostFactor : 1,
        settlementWeight: def.settlementWeight === undefined ? 1 : def.settlementWeight,
        temperatureBand: band,
        rainfallBand: def.rainfallBand || [0, 1],
        latitudeBand: def.latitudeBand || [0, 1]
      };
    });

    oceanIndex = 0;
    landIndex = -1;
    for (var k = 0; k < biomeDefs.length; k++) {
      if (biomeDefs[k].id === 'ocean' || biomeDefs[k].impassable) oceanIndex = k;
      else if (landIndex < 0) landIndex = k;
    }
    if (landIndex < 0) landIndex = oceanIndex === 0 ? 1 : 0;

    /* The A* heuristic may never overestimate, so it is scaled by the
       cheapest step the planet could possibly offer. */
    var min = Infinity;
    for (var j = 0; j < biomeDefs.length; j++) {
      if (j !== oceanIndex && !biomeDefs[j].impassable) min = Math.min(min, biomeDefs[j].travelCostFactor);
    }
    minStepFactor = Math.max(0.05, (isFinite(min) ? min : 1) * ROAD_FACTOR[2]);
    return biomeDefs;
  }

  function bandMiss(value, band) {
    if (!band) return 0;
    if (value < band[0]) return band[0] - value;
    if (value > band[1]) return value - band[1];
    return 0;
  }

  /* Whichever biome's three bands the tile misses by least. Degrees,
     a 0..1 rainfall fraction and a 0..1 latitude are not comparable
     numbers, so each miss is scaled before they are added: climate
     decides, and latitude only breaks the ties climate leaves. */
  function pickBiomeIndex(temp, rain, lat) {
    var best = landIndex, bestMiss = Infinity;
    for (var i = 0; i < biomeDefs.length; i++) {
      var b = biomeDefs[i];
      if (i === oceanIndex || b.impassable) continue;
      var miss = bandMiss(temp, b.temperatureBand) / 8 +
                 bandMiss(rain, b.rainfallBand) * 6 +
                 bandMiss(lat, b.latitudeBand) * 3;
      if (miss < bestMiss) { bestMiss = miss; best = i; }
    }
    return best;
  }

  function habitability(temp, rain) {
    return U.curve(TEMP_LIVEABLE, temp) * U.curve(RAIN_LIVEABLE, rain);
  }

  /* ---------- allocation ---------- */

  function allocate(nw, nh) {
    w = Math.max(8, nw | 0);
    h = Math.max(6, nh | 0);
    size = w * h;
    grids = {
      biome: new Uint8Array(size),
      elevation: new Float32Array(size),
      temperature: new Float32Array(size),
      rainfall: new Float32Array(size),
      settlement: new Int32Array(size),
      roads: new Uint8Array(size),
      river: new Uint8Array(size)
    };
    _g = new Float64Array(size);
    _seen = new Int32Array(size);
    _closed = new Int32Array(size);
    _from = new Int32Array(size);
    _heap = new U.MinHeap();
    _mark = 0;
    settlements.length = 0;
    settlementsById.clear();
    sites = [];
    siteInfo.clear();
    _pathCache.clear();
  }

  function publish() {
    World.w = w; World.h = h; World.size = size;
    World.tiles = grids;
    World.settlements = settlements;
    World.sites = sites;
    World.colonyTile = colonyTile;
    World.seed = worldSeed;
    World.noiseSeeds = noiseSeeds;
    World.biomeIds = biomeDefs.map(function (b) { return b.id; });
    World.generated = !!grids;
  }

  /* ---------- generation ---------- */

  World.generate = function (opts) {
    opts = opts || {};
    /* The planet is a pure function of the seed, so it borrows the shared
       stream, winds it to a world-only starting point and hands it back
       exactly where it found it: MapGen rolls the same dice either way. */
    var streamState = U.getSeed();
    worldSeed = (opts.seed === undefined ? U.randInt(1, 2000000000) : opts.seed) >>> 0;
    U.seed((worldSeed ^ 0x776f726c) >>> 0);

    allocate(opts.w || DEFAULT_W, opts.h || DEFAULT_H);
    resolveBiomeDefs();

    noiseSeeds = {
      elevation: U.randInt(1, 2000000000),
      rainfall: U.randInt(1, 2000000000),
      warp: U.randInt(1, 2000000000),
      detail: U.randInt(1, 2000000000)
    };

    buildElevation();
    floodOceans();
    normaliseElevation();
    buildClimate();
    carveRivers();
    assignBiomes();

    colonyTile = pickColonyTile();
    sites = pickSites();
    buildRoadNetwork(sites);

    publish();
    U.setSeed(streamState);
    return World;
  };

  function buildElevation() {
    var e = grids.elevation;
    for (var y = 0; y < h; y++) {
      var v = (y + 0.5) / h;
      for (var x = 0; x < w; x++) {
        var u = (x + 0.5) / w;
        /* Warping the sample point bends what would be round blobs into
           ridges, peninsulas and inlets. */
        var wu = u + (valueNoise(noiseSeeds.warp, u, v, 3, 2) - 0.5) * 0.22;
        var wv = v + (valueNoise(noiseSeeds.warp + 101, u, v, 3, 2) - 0.5) * 0.14;
        e[y * w + x] = U.clamp01((fbm(noiseSeeds.elevation, wu, wv, 5, 4, 2) - 0.5) * 1.55 + 0.5);
      }
    }
  }

  /* Priority flood: the sea starts at a few low points and repeatedly
     swallows the lowest tile on its own shore until it has taken about a
     third of the planet. Basins fill first, so what comes out is seas
     with coastlines instead of noise above a threshold. */
  function floodOceans() {
    var e = grids.elevation, biome = grids.biome;
    var target = Math.round(size * OCEAN_FRACTION);
    var seedTiles = [], guard = 0;
    var wanted = U.randInt(3, 5);
    while (seedTiles.length < wanted && guard < 600) {
      guard++;
      var i = U.randInt(0, size - 1);
      if (e[i] > (guard < 300 ? 0.45 : 1)) continue;
      var far = true;
      for (var s = 0; s < seedTiles.length; s++) {
        if (distanceIdx(i, seedTiles[s]) < w * 0.16) { far = false; break; }
      }
      if (far) seedTiles.push(i);
    }
    if (!seedTiles.length) {
      var low = 0;
      for (var k = 1; k < size; k++) if (e[k] < e[low]) low = k;
      seedTiles.push(low);
    }

    /* The biome grid is not written until the climate is known, so the
       flood keeps its own record of what is under water. */
    var sea = new Uint8Array(size);
    var heap = _heap;
    heap.clear();
    var count = 0, t, d, n;
    for (t = 0; t < seedTiles.length; t++) {
      if (sea[seedTiles[t]]) continue;
      sea[seedTiles[t]] = 1;
      count++;
      for (d = 0; d < 8; d++) {
        n = neighbourIdx(seedTiles[t], d);
        if (n >= 0 && !sea[n]) heap.push(n, e[n]);
      }
    }
    while (count < target && !heap.isEmpty()) {
      var next = heap.pop();
      if (sea[next]) continue;
      sea[next] = 1;
      count++;
      for (d = 0; d < 8; d++) {
        n = neighbourIdx(next, d);
        if (n >= 0 && !sea[n]) heap.push(n, e[n]);
      }
    }

    smoothCoast(sea);
    for (var j = 0; j < size; j++) biome[j] = sea[j] ? oceanIndex : landIndex;
  }

  /* Two rounds of majority smoothing: a spit of land with the sea on six
     sides drowns, a one-tile pond dries up, and the shape of the coast
     survives both. */
  function smoothCoast(sea) {
    for (var pass = 0; pass < 2; pass++) {
      var next = sea.slice();
      for (var i = 0; i < size; i++) {
        var oceanN = 0, total = 0;
        for (var d = 0; d < 8; d++) {
          var n = neighbourIdx(i, d);
          if (n < 0) continue;
          total++;
          if (sea[n]) oceanN++;
        }
        if (!total) continue;
        var frac = oceanN / total;
        if (!sea[i] && frac >= 0.74) next[i] = 1;
        else if (sea[i] && frac <= 0.22) next[i] = 0;
      }
      sea.set(next);
    }
  }

  /* Land is stretched to fill the range above the waterline and the sea
     bed the range below it, so elevation reads the same everywhere: 0.32
     is the shore, 1 is the top of the highest mountain. */
  function normaliseElevation() {
    var e = grids.elevation;
    var landMin = Infinity, landMax = -Infinity, seaMin = Infinity, seaMax = -Infinity, i;
    for (i = 0; i < size; i++) {
      if (isOceanIdx(i)) {
        if (e[i] < seaMin) seaMin = e[i];
        if (e[i] > seaMax) seaMax = e[i];
      } else {
        if (e[i] < landMin) landMin = e[i];
        if (e[i] > landMax) landMax = e[i];
      }
    }
    for (i = 0; i < size; i++) {
      if (isOceanIdx(i)) {
        var ds = seaMax > seaMin ? (e[i] - seaMin) / (seaMax - seaMin) : 0.5;
        e[i] = 0.02 + ds * (SEA_LEVEL - 0.05);
      } else {
        var dl = landMax > landMin ? (e[i] - landMin) / (landMax - landMin) : 0.4;
        e[i] = SEA_LEVEL + 0.01 + Math.pow(dl, 1.25) * (1 - SEA_LEVEL - 0.01);
      }
    }
  }

  function buildClimate() {
    var e = grids.elevation, temp = grids.temperature, rain = grids.rainfall;
    for (var y = 0; y < h; y++) {
      var lat = Math.abs((y + 0.5) / h - 0.5) * 2;
      var latTemp = 30 - 55 * Math.pow(lat, 1.6);
      var band = U.curve(RAIN_BY_LAT, lat);
      var v = (y + 0.5) / h;
      for (var x = 0; x < w; x++) {
        var i = y * w + x, u = (x + 0.5) / w;
        var wobble = (fbm(noiseSeeds.detail, u, v, 3, 5, 3) - 0.5) * 9;
        var t = latTemp + wobble - 30 * Math.max(0, e[i] - SEA_LEVEL);
        /* Water holds its heat: the sea is never as cold, or as hot, as
           the latitude on its own would make it. */
        if (isOceanIdx(i)) t = U.lerp(t, 12, 0.45);
        temp[i] = t;
        var r = band * (0.35 + 1.15 * fbm(noiseSeeds.rainfall, u, v, 4, 3, 2));
        rain[i] = U.clamp01(r * U.curve(RAIN_BY_TEMP, t));
      }
    }
  }

  /* Rivers run downhill from wet high ground until they reach the sea,
     join a bigger river, or settle into a basin with no way out. They
     are what makes an inland town worth founding. */
  function carveRivers() {
    var e = grids.elevation, river = grids.river, rain = grids.rainfall;
    var wanted = Math.max(3, Math.round(size / 260));
    for (var n = 0; n < wanted; n++) {
      var best = -1, bestScore = -1;
      for (var k = 0; k < 24; k++) {
        var i = U.randInt(0, size - 1);
        if (isOceanIdx(i) || river[i]) continue;
        var score = (e[i] - SEA_LEVEL) * 2 + rain[i];
        if (score > bestScore) { bestScore = score; best = i; }
      }
      if (best >= 0) traceRiver(best);
    }
    for (var j = 0; j < size; j++) {
      if (river[j]) rain[j] = U.clamp01(rain[j] + RIVER_RAIN_BONUS);
    }
  }

  function traceRiver(start) {
    var e = grids.elevation, river = grids.river;
    var cur = start, steps = 0;
    while (steps++ < 140) {
      river[cur] = 1;
      var next = -1, low = e[cur];
      for (var d = 0; d < 8; d++) {
        var n = neighbourIdx(cur, d);
        if (n < 0) continue;
        if (isOceanIdx(n)) return;                  /* reached the sea */
        if (river[n]) { if (e[n] <= e[cur]) return; continue; }
        if (e[n] < low) { low = e[n]; next = n; }
      }
      if (next < 0) return;                         /* a lake with no outflow */
      cur = next;
    }
  }

  function assignBiomes() {
    var biome = grids.biome;
    for (var i = 0; i < size; i++) {
      if (biome[i] === oceanIndex) continue;
      biome[i] = pickBiomeIndex(grids.temperature[i], grids.rainfall[i], latOf(i));
    }
  }

  /* ---------- where the pods come down ---------- */

  function pickColonyTile() {
    var pool = [], i;
    for (i = 0; i < size; i++) {
      if (isOceanIdx(i)) continue;
      var b = biomeDefs[grids.biome[i]];
      if (!b.habitable) continue;
      var lat = latOf(i);
      if (lat < 0.14 || lat > 0.58) continue;
      var t = grids.temperature[i];
      if (t < 2 || t > 28) continue;
      if (grids.elevation[i] > SEA_LEVEL + 0.42) continue;
      pool.push({
        i: i,
        score: habitability(t, grids.rainfall[i]) +
          (b.mapBiome === 'temperateForest' ? 0.4 : 0) + (grids.river[i] ? 0.15 : 0)
      });
    }
    if (!pool.length) {
      for (i = 0; i < size; i++) {
        if (isOceanIdx(i) || !biomeDefs[grids.biome[i]].habitable) continue;
        pool.push({ i: i, score: habitability(grids.temperature[i], grids.rainfall[i]) + 0.01 });
      }
    }
    if (!pool.length) return 0;
    pool.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    var top = pool.slice(0, Math.min(60, pool.length));
    var chosen = U.pickWeighted(top, function (c) { return c.score * c.score; });
    return chosen ? chosen.i : pool[0].i;
  }

  /* ---------- settlement sites ----------
     The planet lays out where a town could plausibly stand: on the coast
     or on a river, on ground someone could live off, and never crowded
     in on its neighbour. Who owns each one is factions.js's business. */

  function scoreSite(i) {
    var b = biomeDefs[grids.biome[i]];
    if (!b.habitable || b.settlementWeight <= 0) return -1;
    var hab = habitability(grids.temperature[i], grids.rainfall[i]);
    if (hab < 0.2) return -1;
    var coastal = false;
    for (var d = 0; d < 8; d++) {
      var n = neighbourIdx(i, d);
      if (n >= 0 && isOceanIdx(n)) { coastal = true; break; }
    }
    var river = grids.river[i] !== 0;
    siteInfo.set(i, { tile: i, coastal: coastal, river: river, habitability: hab });
    return hab * b.settlementWeight + (coastal ? 0.35 : 0) + (river ? 0.3 : 0) -
      Math.max(0, grids.elevation[i] - SEA_LEVEL - 0.25) * 0.8;
  }

  function pickSites() {
    var target = U.clamp(Math.round(size / 90), 6, 40);
    var scored = [], i;
    for (i = 0; i < size; i++) {
      if (isOceanIdx(i)) continue;
      var s = scoreSite(i);
      if (s < 0) continue;
      var info = siteInfo.get(i);
      /* A little noise on the score, so two worlds with the same coast do
         not put their towns on exactly the same headlands. */
      scored.push({ i: i, score: s + U.rand() * 0.25, water: info.coastal || info.river });
    }
    scored.sort(function (a, b) { return b.score - a.score || a.i - b.i; });

    var out = [];
    function tryTake(cand) {
      if (distanceIdx(cand.i, colonyTile) < MIN_SITE_DIST) return;
      for (var k = 0; k < out.length; k++) {
        if (distanceIdx(cand.i, out[k]) < MIN_SITE_DIST) return;
      }
      out.push(cand.i);
    }
    for (i = 0; i < scored.length && out.length < target; i++) {
      if (scored[i].water) tryTake(scored[i]);
    }
    /* Landlocked worlds exist. If the coasts and rivers could not supply
       enough room, the rest of the continent gets its turn. */
    for (i = 0; i < scored.length && out.length < target; i++) {
      if (!scored[i].water) tryTake(scored[i]);
    }
    return out;
  }

  World.candidateSites = function () { return sites.slice(); };
  World.siteInfo = function (tile) { return siteInfo.get(tile) || null; };

  /* ---------- roads ----------
     A minimum spanning tree over the sites near enough to each other to
     bother, plus a few short extra links so the network has loops in it.
     Every road is an A* path over land, and since roads are already cheap
     by the time the next one is laid, later routes merge onto earlier
     ones and wear them into highways. */

  function buildRoadNetwork(tiles) {
    if (tiles.length < 2) return;
    var edges = [], i, j;
    for (i = 0; i < tiles.length; i++) {
      for (j = i + 1; j < tiles.length; j++) {
        var d = distanceIdx(tiles[i], tiles[j]);
        if (d <= MAX_ROAD_DIST) edges.push({ a: i, b: j, d: d, used: false });
      }
    }
    edges.sort(function (x, y) { return x.d - y.d || x.a - y.a || x.b - y.b; });

    var parent = [];
    for (i = 0; i < tiles.length; i++) parent.push(i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }

    for (i = 0; i < edges.length; i++) {
      var ra = find(edges[i].a), rb = find(edges[i].b);
      if (ra === rb) continue;
      if (!layRoad(tiles[edges[i].a], tiles[edges[i].b])) continue;
      parent[ra] = rb;
      edges[i].used = true;
    }
    for (i = 0; i < edges.length; i++) {
      if (edges[i].used || edges[i].d > 8) continue;
      if (U.chance(0.3)) layRoad(tiles[edges[i].a], tiles[edges[i].b]);
    }
  }

  function layRoad(a, b) {
    var path = aStar(a, b);
    if (!path) return false;
    var roads = grids.roads;
    roads[a] = Math.min(2, roads[a] + 1);
    for (var i = 0; i < path.length; i++) roads[path[i]] = Math.min(2, roads[path[i]] + 1);
    _pathCache.clear();      /* every cached cost was priced without this road */
    return true;
  }

  /* ---------- tile access ---------- */

  function TileView(i) { this.i = i; }

  function tileProp(name, get) {
    Object.defineProperty(TileView.prototype, name, { enumerable: true, get: get });
  }
  tileProp('x', function () { return xOf(this.i); });
  tileProp('y', function () { return yOf(this.i); });
  tileProp('biome', function () { return biomeDefs[grids.biome[this.i]].id; });
  tileProp('biomeDef', function () { return biomeDefs[grids.biome[this.i]]; });
  tileProp('elevation', function () { return grids.elevation[this.i]; });
  tileProp('temperature', function () { return grids.temperature[this.i]; });
  tileProp('rainfall', function () { return grids.rainfall[this.i]; });
  tileProp('river', function () { return grids.river[this.i] !== 0; });
  tileProp('roads', function () { return grids.roads[this.i]; });
  tileProp('ocean', function () { return grids.biome[this.i] === oceanIndex; });
  tileProp('settlement', function () { return settlementsById.get(grids.settlement[this.i]) || null; });

  World.tileAt = function (i, y) {
    if (!grids) return null;
    if (y !== undefined) i = idx(i, y);
    if (!(i >= 0 && i < size)) return null;
    return new TileView(i);
  };

  World.idx = function (x, y) { return grids ? idx(x, y) : 0; };
  World.xOf = function (i) { return grids ? xOf(i) : 0; };
  World.yOf = function (i) { return grids ? yOf(i) : 0; };
  World.inBounds = function (x, y) { return !!grids && y >= 0 && y < h; };
  World.wrapX = function (x) { return grids ? wrapX(x) : 0; };
  World.latitudeOf = function (i) { return grids ? latOf(i) : 0; };
  World.rainfallMm = function (i) { return grids ? grids.rainfall[i] * RAIN_MM : 0; };
  World.roadAt = function (i) { return grids ? grids.roads[i] : 0; };
  World.isOcean = function (i) { return !!grids && grids.biome[i] === oceanIndex; };
  World.isHabitable = function (i) {
    return !!grids && !isOceanIdx(i) && biomeDefs[grids.biome[i]].habitable;
  };

  World.neighbours = function (i) {
    var out = [];
    if (!grids) return out;
    for (var d = 0; d < 8; d++) {
      var n = neighbourIdx(i, d);
      if (n >= 0) out.push(n);
    }
    return out;
  };

  World.biomeOf = function (i) { return grids ? biomeDefs[grids.biome[i]].id : 'ocean'; };
  World.biomes = function () { return (biomeDefs || resolveBiomeDefs()).slice(); };
  World.biomeDef = function (key) {
    if (!biomeDefs) resolveBiomeDefs();
    if (typeof key === 'string') {
      for (var i = 0; i < biomeDefs.length; i++) if (biomeDefs[i].id === key) return biomeDefs[i];
      return null;
    }
    return (grids && key >= 0 && key < size) ? biomeDefs[grids.biome[key]] : null;
  };

  /* The colony map's biome is decided by the tile the pods came down on.
     MapGen understands three of them, which is what mapBiome names. */
  World.colonyBiome = function () {
    if (!grids) return 'temperateForest';
    return biomeDefs[grids.biome[colonyTile]].mapBiome || 'temperateForest';
  };

  /* ---------- distance and travel ---------- */

  World.distance = function (a, b) { return grids ? distanceIdx(a, b) : 0; };

  function travelFactor(i) {
    var b = biomeDefs[grids.biome[i]];
    return b.impassable ? 999 : b.travelCostFactor;
  }

  function stepCost(a, b, diag) {
    var e = grids.elevation, roads = grids.roads;
    var terrain = (travelFactor(a) + travelFactor(b)) * 0.5;
    var climb = 1 + 1.1 * Math.max(0, (e[a] + e[b]) * 0.5 - SEA_LEVEL) + 2.2 * Math.max(0, e[b] - e[a]);
    var road = (roads[a] && roads[b]) ? ROAD_FACTOR[Math.min(roads[a], roads[b])] : 1;
    return BASE_TICKS_PER_TILE * (diag ? DIAG : 1) * terrain * climb * road;
  }

  World.stepCost = function (a, b) {
    if (!grids) return 0;
    return stepCost(a, b, xOf(a) !== xOf(b) && yOf(a) !== yOf(b));
  };

  /* ---------- A* over the planet ---------- */

  function cacheKey(a, b) { return a * size + b; }

  function aStar(a, b) {
    if (!grids || a === b) return null;
    if (!(a >= 0 && a < size && b >= 0 && b < size)) return null;
    if (isOceanIdx(a) || isOceanIdx(b)) return null;
    var cached = _pathCache.get(cacheKey(a, b));
    if (cached) return cached.path;

    _mark++;
    var heap = _heap;
    heap.clear();
    _g[a] = 0; _seen[a] = _mark; _from[a] = -1;
    heap.push(a, distanceIdx(a, b) * BASE_TICKS_PER_TILE * minStepFactor);

    while (!heap.isEmpty()) {
      var cur = heap.pop();
      if (_closed[cur] === _mark) continue;
      _closed[cur] = _mark;
      if (cur === b) return finishPath(a, b);
      var cx = xOf(cur), cy = yOf(cur);
      for (var d = 0; d < 8; d++) {
        var dx = U.ADJ8[d][0], dy = U.ADJ8[d][1];
        var ny = cy + dy;
        if (ny < 0 || ny >= h) continue;
        var nx = wrapX(cx + dx);
        var n = ny * w + nx;
        if (isOceanIdx(n) || _closed[n] === _mark) continue;
        var diag = dx !== 0 && dy !== 0;
        /* No squeezing between two headlands that meet at a corner. */
        if (diag && isOceanIdx(cy * w + nx) && isOceanIdx(ny * w + cx)) continue;
        var g = _g[cur] + stepCost(cur, n, diag);
        if (_seen[n] !== _mark || g < _g[n]) {
          _seen[n] = _mark; _g[n] = g; _from[n] = cur;
          heap.push(n, g + distanceIdx(n, b) * BASE_TICKS_PER_TILE * minStepFactor);
        }
      }
    }
    _pathCache.set(cacheKey(a, b), { path: null, cost: Infinity });
    return null;
  }

  function finishPath(a, b) {
    var out = [], cur = b;
    while (cur !== a && cur >= 0) { out.push(cur); cur = _from[cur]; }
    out.reverse();
    if (_pathCache.size > PATH_CACHE_MAX) _pathCache.clear();
    _pathCache.set(cacheKey(a, b), { path: out, cost: _g[b] });
    return out;
  }

  /* Callers get their own copy: caravan.js walks a path by shifting tiles
     off the front of it, and that must not chew the cache. */
  World.pathBetween = function (a, b) {
    if (!grids) return null;
    if (a === b) return [];
    var path = aStar(a, b);
    return path ? path.slice() : null;
  };

  World.pathCost = function (a, b) {
    if (!grids || a === b) return 0;
    aStar(a, b);
    var entry = _pathCache.get(cacheKey(a, b));
    return entry ? entry.cost : Infinity;
  };

  World.reachableByLand = function (a, b) {
    if (!grids) return false;
    return a === b || !!aStar(a, b);
  };

  /* caravanSpeed is a multiplier where 1 is a colonist on foot: the tile
     next door is about half a day, and a quarter of the way around the
     planet over real ground is a fortnight. */
  World.travelTicks = function (a, b, caravanSpeed) {
    if (!grids || a === b) return 0;
    var speed = caravanSpeed > 0 ? caravanSpeed : 1;
    var cost = World.pathCost(a, b);
    /* No land route at all. Nothing should be walking this, but callers
       deserve a number rather than an Infinity to divide by. */
    if (!isFinite(cost)) cost = distanceIdx(a, b) * BASE_TICKS_PER_TILE * 3;
    return Math.max(1, Math.round(cost / speed));
  };

  World.travelDays = function (a, b, caravanSpeed) {
    return World.travelTicks(a, b, caravanSpeed) / 60000;
  };

  /* ---------- settlements ---------- */

  var NAME_HEAD = ['Bre', 'Cal', 'Dun', 'Far', 'Gol', 'Har', 'Kes', 'Mor', 'Nor', 'Ost',
                   'Rav', 'Sel', 'Tor', 'Var', 'Wyn', 'Zar'];
  var NAME_TAIL = ['ford', 'holm', 'stead', 'gate', 'reach', 'vale', 'mark', 'crest',
                   'wick', 'burn', 'fell', 'haven'];

  function kindDef(kindId) {
    try { return (Defs && Defs.maybe) ? Defs.maybe('settlementKind', kindId) : null; }
    catch (e) { return null; }
  }

  /* factions.js normally names its own towns, but a settlement placed
     without one still gets a name a player can say out loud. */
  World.generateName = function (kindId) {
    var def = kindDef(kindId);
    if (def && def.namePatterns && def.namePatterns.length && def.nameWords) {
      var words = def.nameWords;
      var out = U.pick(def.namePatterns).replace(/\{(\w+)\}/g, function (all, key) {
        var list = words[key];
        return (list && list.length) ? U.pick(list) : '';
      }).replace(/\s+/g, ' ').trim();
      if (out) return out;
    }
    return U.pick(NAME_HEAD) + U.pick(NAME_TAIL);
  };

  function freeLandTile(tile) {
    if (!(tile >= 0 && tile < size)) return -1;
    if (!isOceanIdx(tile) && !grids.settlement[tile]) return tile;
    /* factions.js may ask for a tile the world has already spoken for.
       Rather than refuse, slide to the nearest square that works. */
    for (var r = 1; r <= 3; r++) {
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          var ny = yOf(tile) + dy;
          if (ny < 0 || ny >= h) continue;
          var n = ny * w + wrapX(xOf(tile) + dx);
          if (!isOceanIdx(n) && !grids.settlement[n]) return n;
        }
      }
    }
    return -1;
  }

  World.placeSettlement = function (tile, factionId, kindId, name) {
    if (!grids) return null;
    var at = freeLandTile(tile);
    if (at < 0) return null;
    var def = kindDef(kindId);
    var range = (def && def.wealthRange) || [800, 3000];
    var s = {
      id: U.nextId(),
      tile: at,
      factionId: factionId || null,
      kind: kindId || 'village',
      name: name || World.generateName(kindId),
      wealth: U.randInt(range[0], range[1]),
      stock: [],
      lastRestockTick: 0,
      destroyed: false
    };
    settlements.push(s);
    settlementsById.set(s.id, s);
    grids.settlement[at] = s.id;
    linkToRoads(at);
    return s;
  };

  /* A town founded off the road network gets hooked into it, if it has a
     neighbour close enough to care about it. */
  function linkToRoads(tile) {
    if (grids.roads[tile]) return;
    var best = -1, bestD = MAX_ROAD_DIST + 1, i, d;
    for (i = 0; i < settlements.length; i++) {
      var s = settlements[i];
      if (s.destroyed || s.tile === tile) continue;
      d = distanceIdx(tile, s.tile);
      if (d < bestD) { bestD = d; best = s.tile; }
    }
    for (i = 0; i < sites.length; i++) {
      if (sites[i] === tile || !grids.roads[sites[i]]) continue;
      d = distanceIdx(tile, sites[i]);
      if (d < bestD) { bestD = d; best = sites[i]; }
    }
    if (best >= 0) layRoad(tile, best);
  }

  World.settlementAt = function (i) {
    if (!grids) return null;
    var s = settlementsById.get(grids.settlement[i]);
    return s && !s.destroyed ? s : null;
  };
  World.settlementById = function (id) { return settlementsById.get(id) || null; };
  World.liveSettlements = function () {
    return settlements.filter(function (s) { return !s.destroyed; });
  };
  World.settlementsOf = function (factionId) {
    return settlements.filter(function (s) { return !s.destroyed && s.factionId === factionId; });
  };

  World.nearestSettlement = function (tile, filter) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < settlements.length; i++) {
      var s = settlements[i];
      if (s.destroyed || (filter && !filter(s))) continue;
      var d = distanceIdx(tile, s.tile);
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  };

  World.destroySettlement = function (s) {
    if (!s || s.destroyed) return false;
    s.destroyed = true;
    if (grids && grids.settlement[s.tile] === s.id) grids.settlement[s.tile] = 0;
    return true;
  };

  /* ---------- seasons at a distance ---------- */

  /* Game.season() is the season where the player is standing. Cross the
     equator and it is the other one; sit on the equator and there is no
     winter worth the name. */
  World.season = function (i) {
    var base = (root.Game && root.Game.season) ? root.Game.season() : 'spring';
    if (!grids) return base;
    var here = (yOf(i) + 0.5) / h - 0.5;
    if (Math.abs(here) * 2 < 0.13) return 'summer';
    var colony = (yOf(colonyTile) + 0.5) / h - 0.5;
    return ((here >= 0) === (colony >= 0)) ? base : (SEASON_OPPOSITE[base] || base);
  };

  /* The annual mean plus the swing latitude gives it, so the world screen
     can say what a tile is like now rather than on average. */
  World.seasonalTemp = function (i) {
    if (!grids) return 0;
    var phase = { spring: 0, summer: 1, fall: 0, winter: -1 }[World.season(i)];
    return grids.temperature[i] + (4 + 20 * latOf(i)) * (phase || 0) * 0.5;
  };

  World.describe = function (i) {
    if (!grids) return 'no world';
    return biomeDefs[grids.biome[i]].label + ', ' + U.fmt(World.seasonalTemp(i), 0) + 'C, ' +
      Math.round(grids.rainfall[i] * RAIN_MM) + 'mm' +
      (grids.roads[i] ? (grids.roads[i] > 1 ? ', highway' : ', road') : '') +
      (grids.river[i] ? ', river' : '');
  };

  /* ---------- save and load ---------- */

  function roundTo(v, dp) {
    var m = Math.pow(10, dp);
    return Math.round(v * m) / m;
  }

  World.save = function () {
    if (!grids) return null;
    var elevation = new Array(size), temperature = new Array(size), rainfall = new Array(size);
    for (var i = 0; i < size; i++) {
      elevation[i] = roundTo(grids.elevation[i], 4);
      temperature[i] = roundTo(grids.temperature[i], 2);
      rainfall[i] = roundTo(grids.rainfall[i], 4);
    }
    return {
      v: 1, w: w, h: h, seed: worldSeed, colonyTile: colonyTile,
      noiseSeeds: {
        elevation: noiseSeeds.elevation, rainfall: noiseSeeds.rainfall,
        warp: noiseSeeds.warp, detail: noiseSeeds.detail
      },
      /* The biome grid holds def indices, so the ids travel with it: a
         save made before def_factions.js grew a biome still loads. */
      biomeIds: biomeDefs.map(function (b) { return b.id; }),
      biome: Array.prototype.slice.call(grids.biome),
      roads: Array.prototype.slice.call(grids.roads),
      river: Array.prototype.slice.call(grids.river),
      settlementGrid: Array.prototype.slice.call(grids.settlement),
      elevation: elevation, temperature: temperature, rainfall: rainfall,
      sites: sites.slice(),
      settlements: settlements.map(function (s) {
        return {
          id: s.id, tile: s.tile, factionId: s.factionId, kind: s.kind, name: s.name,
          wealth: s.wealth, lastRestockTick: s.lastRestockTick, destroyed: !!s.destroyed,
          stock: (s.stock || []).map(function (it) {
            return { defId: it.defId, count: it.count, price: it.price };
          })
        };
      })
    };
  };

  function copyInto(target, src) {
    if (!src) return;
    var n = Math.min(target.length, src.length);
    for (var i = 0; i < n; i++) target[i] = src[i];
  }

  World.load = function (obj) {
    if (!obj || !obj.w || !obj.h) return false;
    allocate(obj.w, obj.h);
    resolveBiomeDefs();
    worldSeed = (obj.seed || 0) >>> 0;
    if (obj.noiseSeeds) {
      noiseSeeds = {
        elevation: obj.noiseSeeds.elevation, rainfall: obj.noiseSeeds.rainfall,
        warp: obj.noiseSeeds.warp, detail: obj.noiseSeeds.detail
      };
    }

    copyInto(grids.biome, obj.biome);
    copyInto(grids.roads, obj.roads);
    copyInto(grids.river, obj.river);
    copyInto(grids.settlement, obj.settlementGrid);
    copyInto(grids.elevation, obj.elevation);
    copyInto(grids.temperature, obj.temperature);
    copyInto(grids.rainfall, obj.rainfall);
    remapBiomes(obj.biomeIds);

    colonyTile = U.clamp(obj.colonyTile | 0, 0, size - 1);
    sites = (obj.sites || []).slice();
    var list = obj.settlements || [];
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      var s = {
        id: raw.id, tile: raw.tile, factionId: raw.factionId || null,
        kind: raw.kind || 'village', name: raw.name || '', wealth: raw.wealth || 0,
        stock: (raw.stock || []).map(function (it) {
          return { defId: it.defId, count: it.count, price: it.price };
        }),
        lastRestockTick: raw.lastRestockTick || 0, destroyed: !!raw.destroyed
      };
      settlements.push(s);
      settlementsById.set(s.id, s);
      if (!s.destroyed && s.tile >= 0 && s.tile < size) grids.settlement[s.tile] = s.id;
    }
    publish();
    return true;
  };

  function remapBiomes(savedIds) {
    if (!savedIds || !savedIds.length) return;
    var same = savedIds.length === biomeDefs.length;
    var lookup = [];
    for (var i = 0; i < savedIds.length; i++) {
      var at = landIndex;
      for (var j = 0; j < biomeDefs.length; j++) {
        if (biomeDefs[j].id === savedIds[i]) { at = j; break; }
      }
      if (at !== i) same = false;
      lookup.push(at);
    }
    if (same) return;
    for (var k = 0; k < size; k++) {
      var was = grids.biome[k];
      grids.biome[k] = was < lookup.length ? lookup[was] : landIndex;
    }
  }

  World.reset = function () {
    grids = null;
    settlements.length = 0;
    settlementsById.clear();
    sites = [];
    siteInfo.clear();
    colonyTile = 0;
    _pathCache.clear();
    World.tiles = null;
    World.generated = false;
  };

  World.SEA_LEVEL = SEA_LEVEL;
  World.BASE_TICKS_PER_TILE = BASE_TICKS_PER_TILE;
  World.w = DEFAULT_W;
  World.h = DEFAULT_H;
  World.size = 0;
  World.tiles = null;
  World.settlements = settlements;
  World.sites = sites;
  World.colonyTile = 0;
  World.generated = false;

  root.World = World;
})(this);
