/* ============================================================
   levels.js - verticality: basements and upper floors.

   The whole design rests on one decision: A LEVEL IS AN ORDINARY
   GameMap. Not a third dimension threaded through every grid, not a
   z index on Thing, not a 3D pathfinder - a complete, ordinary map
   with its own terrain, buildings, items, roofs, regions, rooms,
   zones and pawns. Every system in the game already knows how to
   work on one map, so every system keeps working, unchanged, on all
   of them. What this file owns is the array of maps and everything
   that crosses between them: support, collapse, stairs, routing and
   the transfer of a pawn from one map to another.

   Level keys are signed. z = 0 is the surface, z = -1 the first
   basement, z = +1 the first upper floor, bounded to -3..+3. A level
   is created on demand - the first time somebody digs into it or
   builds onto it - so a colony that never digs pays nothing for the
   feature beyond a handful of length checks per tick.

   Three rules make it a building game rather than free real estate:

   1. SOLID ROCK IS TERRAIN, THE MINE FACE IS A THING. A basement is
      bedrock terrain (impassable) with a rockWall Thing materialised
      only on the cells adjacent to open space. Mining works exactly as
      it does on the surface, but an untouched basement costs two
      thousand things instead of fourteen thousand.

   2. AN UPPER FLOOR STARTS AS SKY. Its terrain is `openSky`, which is
      impassable, and the only way to get a floor there is to have a
      wall or a column under it - directly beneath, or within a three
      cell beam span. Mine the support out and what it held falls.

   3. A CONNECTION IS A PAIR. Stairs, a ladder or a freight lift exist
      as two buildings at the same x,y on adjacent levels, linked into
      one record. Build either and the other appears; remove either and
      the other goes. A route between levels is A* within each map plus
      a step across at a connection, never a 3D search.

   game.js does not name this file in its systems registry, so the tick
   arrives through a guarded wrapper on GameMap.prototype.tick instead
   (see `installDriver`). Adding ['Levels', 'tick'] to game.js's
   MAP_TICKERS makes the wrapper a no-op; it detects the duplicate and
   stands down.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  function sys(name) { return root[name] || null; }
  function now() {
    var g = root.Game;
    return (g && typeof g.tick === 'number') ? g.tick : 0;
  }

  /* ---------- tuning ----------
     Periods are in ticks: 60 to the second, 60000 to the day. */

  var MIN_Z = -3, MAX_Z = 3;
  var BEAM_SPAN = 3;             /* how far a floor reaches from its support   */

  var BASEMENT_TEMP = 11;        /* bedrock a storey down, in celsius          */
  var BASEMENT_DRIFT = -0.9;     /* per further level down                     */

  var FACE_PERIOD = 20;          /* how often mined-out faces are noticed      */
  var FACE_SLICE = 32;           /* face cells examined per sweep              */
  var CONNECTION_PERIOD = 60;    /* how often stair pairs are reconciled       */
  var COLLAPSE_PER_TICK = 6;     /* bounded, so a cave-in never eats a frame   */
  var COLLAPSE_CAP = 3000;
  var SUPPORT_PERIOD = 250;      /* rolling re-check of everything overhead    */
  var SUPPORT_SLICE = 24;
  var HOUSEKEEPING_PERIOD = 250; /* claims, vaults, temperature                */
  var HAUL_SCAN_LIMIT = 40;

  var COLLAPSE_DAMAGE = [9, 26]; /* blunt, to whatever falls and whatever it lands on */

  /* ============================================================
     CONTENT

     Two terrains and five buildings, all registered additively at
     load. Nothing else happens at load time: no map, no state, no
     reference to a global defined below this file.
     ============================================================ */

  var TERRAIN_DEFAULTS = {
    description: '', beauty: 0, cleanliness: 0, isWater: false, isNatural: true,
    passable: true, supportsPlants: false, terrainCategory: 'rock', fertility: 0,
    buildCost: null, workToBuild: 0, buildCategory: null,
    researchPrerequisite: null, removable: false
  };

  if (!Defs.has('terrain', 'bedrock')) {
    Defs.add('terrain', {
      bedrock: {
        label: 'bedrock',
        description: 'Unbroken stone. There is no cell here yet - only rock that has never been cut.',
        color: '#3a3a42', color2: '#44444e',
        pathCost: 0, passable: false
      },
      openSky: {
        label: 'open sky',
        description: 'Nothing. A floor has to rest on something below before anything can stand here.',
        color: '#0e1430', color2: '#161d3c',
        pathCost: 0, passable: false, terrainCategory: 'sky'
      }
    }, TERRAIN_DEFAULTS);
  }

  /* The same field set def_things.js gives every building, so power.js
     and jobs.js can read a flag off any of these without a guard. */
  var BUILDING_FIELDS = {
    isBed: false, isTable: false, isChair: false, isWorkbench: false,
    isDoor: false, isGrave: false, isTurret: false, isBattery: false,
    isConduit: false, isLamp: false, isGenerator: false, isResearchBench: false,
    isStove: false, isCampfire: false, isTrap: false, isSandbag: false,
    powerProduced: 0, powerConsumed: 0, batteryCapacity: 0, lightRadius: 0,
    tempPushTarget: null, tempPushRate: 0,
    bedRestEffectiveness: 0, bedComfort: 0, canBeForPrisoners: false,
    fuelDefId: null, fuelCapacity: 0, fuelBurnPerDay: 0,
    turretRange: 0, turretWeapon: null, interactionOffset: null,
    openTicks: 0
  };

  function bld(o) {
    var out = {}, k;
    for (k in BUILDING_FIELDS) out[k] = BUILDING_FIELDS[k];
    if (o) for (k in o) out[k] = o[k];
    return out;
  }

  var BUILDING_DEFAULTS = {
    category: 'building', description: '', sprite: 'box', color: '#8f97a3', color2: '#6e6e78',
    stackLimit: 1, mass: 30, marketValue: 0, hp: 160,
    nutrition: 0, foodType: null, rotDays: null, isMedicine: false, medicinePotency: 0,
    passable: true, pathCost: 0, fillPercent: 0.3, blocksLight: false, holdsRoof: false,
    size: { w: 1, h: 1 }, rotatable: false, flammable: false,
    beauty: 0, comfort: 0, natural: false,
    buildCost: null, stuffable: false, workToBuild: 0, buildSkill: 'construction',
    buildCategory: 'structure', researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null, weapon: null, apparel: null,
    building: bld({})
  };

  if (!Defs.has('thing', 'stairsUp')) {
    Defs.add('thing', {

      /* Stairs are built as a pair and always carry both halves: the
         def a player picks decides which way the shaft is cut, and the
         counterpart on the other level is spawned by this file. */
      stairsUp: {
        label: 'stairs up',
        description: 'A cut stone flight rising through the ceiling. Building it opens the level ' +
          'above and puts a matching flight down on the far side.',
        sprite: 'box', color: '#8a6134', color2: '#c9a86a',
        hp: 220, mass: 60, flammable: true,
        pathCost: 16, fillPercent: 0.4,
        buildCost: { wood: 35 }, workToBuild: 1100,
        leavings: { wood: 15 },
        building: bld({})
      },

      stairsDown: {
        label: 'stairs down',
        description: 'A shaft cut through the floor with a flight of steps in it. Building it opens ' +
          'the level below and puts a matching flight up on the far side.',
        sprite: 'box', color: '#8a6134', color2: '#5a4526',
        hp: 220, mass: 60, flammable: true,
        pathCost: 16, fillPercent: 0.4,
        buildCost: { wood: 35 }, workToBuild: 1100,
        leavings: { wood: 15 },
        building: bld({})
      },

      /* Cheap and slow: the answer when a colony wants a second way
         down and does not want to spend the afternoon on it. */
      levelLadder: {
        label: 'ladder',
        description: 'Bolted rungs in a narrow shaft. Costs almost nothing and everybody hates ' +
          'carrying steel up it.',
        sprite: 'box', color: '#6f5533', color2: '#8a6134',
        hp: 90, mass: 18, flammable: true,
        pathCost: 52, fillPercent: 0.2,
        buildCost: { wood: 15 }, workToBuild: 420,
        leavings: { wood: 6 },
        building: bld({})
      },

      /* The industrial answer: fast, and dead the moment the lower
         platform loses power. */
      freightLift: {
        label: 'freight lift',
        description: 'A powered platform on a winch. Moves a loaded hauler between levels in ' +
          'seconds, and stops dead when the lower platform loses power.',
        sprite: 'box', color: '#8f97a3', color2: '#ffc23c',
        hp: 260, mass: 140, flammable: false,
        pathCost: 4, fillPercent: 0.5,
        buildCost: { steel: 70, components: 4 }, workToBuild: 2000,
        leavings: { steel: 35 },
        researchPrerequisite: 'electricity',
        building: bld({ powerConsumed: 180 })
      },

      /* A wall you build purely to hold something up, which is the
         whole content of rule 2 in one def. */
      supportColumn: {
        label: 'support column',
        description: 'A steel pillar whose only job is to be under something. Holds a floor ' +
          'overhead the way a wall does, without being a wall.',
        sprite: 'box', color: '#8f97a3', color2: '#a8b0bd',
        hp: 280, mass: 90, flammable: false,
        passable: false, pathCost: 0, fillPercent: 1, holdsRoof: true, blocksLight: false,
        buildCost: { steel: 25 }, workToBuild: 380,
        leavings: { steel: 12 },
        building: bld({})
      }

    }, BUILDING_DEFAULTS);
  }

  var CONNECTOR_DEFS = ['stairsUp', 'stairsDown', 'levelLadder', 'freightLift'];
  var KIND_OF_DEF = {
    stairsUp: 'stairs', stairsDown: 'stairs',
    levelLadder: 'ladder', freightLift: 'lift'
  };
  /* Which def stands on the LOWER level of a pair, and which on the upper. */
  var PAIR_LOW = { stairs: 'stairsUp', ladder: 'levelLadder', lift: 'freightLift' };
  var PAIR_HIGH = { stairs: 'stairsDown', ladder: 'levelLadder', lift: 'freightLift' };

  /* ============================================================
     STATE
     ============================================================ */

  var Levels = {};

  var _levels = Object.create(null);   /* z -> Level            */
  var _list = [];                      /* levels sorted by z    */
  var _connections = [];
  var _surface = null;
  var _seed = 1;
  var _inited = false;
  var _active = 0;
  var _gen = 0;                        /* bumped whenever the connection set changes */
  var _graph = null;
  var _collapse = [];
  var _collapseSet = Object.create(null);
  var _tickSeen = -1;
  var _driverInstalled = false;
  var _registered = false;
  var _lastCollapseLetter = -100000;

  Levels.MIN_Z = MIN_Z;
  Levels.MAX_Z = MAX_Z;
  Levels.BEAM_SPAN = BEAM_SPAN;
  Levels.autoDrive = true;             /* set false to hand ticking to game.js */

  function Level(z, map) {
    this.z = z;
    this.map = map;
    this.kind = z < 0 ? 'basement' : (z > 0 ? 'upper' : 'surface');
    this.generated = false;
    this.faces = [];                   /* cell indices holding a live mine face */
    this.faceCursor = 0;
    this.supportList = [];             /* cells on this level that could fall   */
    this.supportCursor = 0;
    this.vaults = [];
    this.lamps = null;
    this.lampTick = -1;
    this.lampCount = -1;
    this.plantTick = -1;
    this.plants = [];
    this.plantCursor = 0;
  }

  /* ============================================================
     CONTAINER
     ============================================================ */

  Levels.init = function (surfaceMap) {
    if (!surfaceMap) return false;
    Levels.reset();
    _surface = surfaceMap;
    _seed = (root.Game && root.Game.seed) ? (root.Game.seed >>> 0) : 1;
    var lv = new Level(0, surfaceMap);
    lv.generated = true;
    register(lv);
    _inited = true;
    _active = 0;
    registerContent();
    installAggregates();
    return true;
  };

  Levels.reset = function () {
    _levels = Object.create(null);
    _list = [];
    _connections = [];
    _surface = null;
    _inited = false;
    _active = 0;
    _gen++;
    _graph = null;
    _collapse = [];
    _collapseSet = Object.create(null);
  };

  function register(level) {
    _levels[level.z] = level;
    level.map.__levelZ = level.z;
    _list.push(level);
    _list.sort(function (a, b) { return a.z - b.z; });
    _gen++;
    _graph = null;
  }

  Levels.get = function (z) { return _levels[z | 0] || null; };
  Levels.all = function () { return _list; };
  Levels.count = function () { return _list.length; };
  Levels.surface = function () { return _surface; };
  Levels.inited = function () { return _inited; };

  Levels.zOf = function (map) {
    if (!map) return null;
    var z = map.__levelZ;
    return typeof z === 'number' ? z : null;
  };

  Levels.mapOf = function (z) {
    var lv = Levels.get(z);
    return lv ? lv.map : null;
  };

  Levels.forEach = function (fn) {
    for (var i = 0; i < _list.length; i++) fn(_list[i], _list[i].z, _list[i].map);
  };

  /* Run one function over every level's map. The simulation never needs
     this - each level ticks itself - but tools, saves and the renderer
     all want "do this to all of them" in one call. */
  Levels.tickAll = function (fn) {
    for (var i = 0; i < _list.length; i++) fn(_list[i].map, _list[i].z, _list[i]);
  };

  /* The level the player is looking at. The simulation does not read
     this: every system works on pawn.map or a map it was handed. */
  Object.defineProperty(Levels, 'active', {
    get: function () { return _active; },
    set: function (z) { Levels.setActive(z); }
  });

  Levels.setActive = function (z, bindGameMap) {
    z = z | 0;
    if (!Levels.get(z)) return false;
    _active = z;
    /* Opt in only. Pointing Game.map at a basement would move every
       system that reasonably assumes Game.map is the colony surface -
       raids, caravans, weather - down a hole with the player. */
    if (bindGameMap && root.Game) root.Game.map = Levels.mapOf(z);
    return true;
  };

  Levels.activeMap = function () {
    var lv = Levels.get(_active);
    return lv ? lv.map : _surface;
  };

  /* Create a level if it does not exist yet. This is the only place a
     GameMap other than the surface is ever born. */
  Levels.ensure = function (z, opts) {
    z = z | 0;
    if (!_inited) {
      var g = root.Game;
      if (g && g.map) Levels.init(g.map); else return null;
    }
    if (z < MIN_Z || z > MAX_Z) return null;
    var have = _levels[z];
    if (have) return have;

    var GameMapCtor = root.GameMap;
    if (!GameMapCtor || !_surface) return null;

    var map = new GameMapCtor(_surface.w, _surface.h);
    map.biome = _surface.biome;
    map.seed = _seed;
    map.mountainous = true;
    var level = new Level(z, map);
    register(level);

    if (!(opts && opts.blank)) {
      if (z < 0) generateBasement(level); else generateUpper(level);
    }
    level.generated = true;

    var Regions = sys('Regions');
    if (Regions) Regions.rebuildAll(map);
    var Power = sys('Power');
    if (Power) { Power.markDirty(map); Power.update(map); }
    return level;
  };

  /* ============================================================
     GENERATION

     Deterministic from the colony seed and z, and it must not disturb
     the simulation stream: a basement dug on day 40 cannot change
     which raider walks in on day 41. So the global RNG is borrowed,
     re-seeded from a hash of (seed, z, salt), and handed back.
     ============================================================ */

  function withSeed(salt, fn) {
    var keep = U.getSeed();
    U.setSeed(U.hash('levels|' + _seed + '|' + salt) >>> 0);
    try { return fn(); } finally { U.setSeed(keep); }
  }

  var _tIndex = null;
  function tIdx(id) {
    if (!_tIndex) _tIndex = Object.create(null);
    if (_tIndex[id] === undefined) _tIndex[id] = Defs.index('terrain', id);
    return _tIndex[id];
  }

  /* What a given cell of solid rock turns out to be when it is finally
     cut into. A pure hash rather than a roll, so the answer is the same
     whether the face is materialised on day one or day two hundred, and
     no RNG state has to be saved for it. */
  function oreAt(z, i) {
    var h = U.hash('ore|' + _seed + '|' + z + '|' + i);
    var r = (h % 100000) / 100000;
    var depth = -z;
    var steel = 0.040 + 0.022 * depth;
    var comp = 0.010 + 0.011 * depth;
    var silver = 0.006 + 0.009 * depth;
    if (r < steel) return 'compactedSteel';
    if (r < steel + comp) return 'compactedComponents';
    if (r < steel + comp + silver) return 'compactedSilver';
    return 'rockWall';
  }

  function generateBasement(level) {
    var map = level.map, w = map.w, h = map.h, size = map.size;
    var BEDROCK = tIdx('bedrock'), FLOOR = tIdx('rockFloor');
    var SHALLOW = tIdx('shallowWater'), DEEP = tIdx('deepWater');

    map.terrain.fill(BEDROCK);
    map.roof.fill(2);

    var open = new Uint8Array(size);
    var depth = -level.z;

    withSeed('cavern|' + level.z, function () {
      /* Chambers joined by corridors, not a long thin random walk. The
         shape matters for more than looks: a one-wide worm of the same
         area has five times the perimeter, and perimeter is what costs
         - every cell of rock touching open air becomes a Thing. */
      var chamberCount = Math.max(3, Math.round(size / 2400)) + depth;
      var seats = [];

      for (var c = 0; c < chamberCount; c++) {
        var cx = U.randInt(10, w - 11), cy = U.randInt(10, h - 11);
        seats.push([cx, cy]);
        var lobes = U.randInt(2, 4);
        for (var l = 0; l < lobes; l++) {
          carveDisc(open, map,
            cx + U.randInt(-4, 4), cy + U.randInt(-4, 4), U.randInt(3, 7));
        }
      }

      /* Join them into one cave system, plus a couple of extra links so
         it is a network rather than a corridor. */
      for (var k = 1; k < seats.length; k++) carveCorridor(open, map, seats[k - 1], seats[k]);
      var extras = Math.min(2, seats.length - 2);
      for (var e = 0; e < extras; e++) {
        carveCorridor(open, map, U.pick(seats), U.pick(seats));
      }

      for (var i = 0; i < size; i++) if (open[i]) map.terrain[i] = FLOOR;

      /* Flood a chamber or two, centred on somewhere that really is a
         chamber rather than a random patch of bedrock. */
      var floods = U.randInt(depth > 1 ? 1 : 0, 1 + (depth > 1 ? 1 : 0));
      for (var f = 0; f < floods && seats.length; f++) {
        var seat = U.pick(seats);
        var fx = seat[0], fy = seat[1], rad = U.randInt(4, 7);
        for (var yy = fy - rad; yy <= fy + rad; yy++) {
          for (var xx = fx - rad; xx <= fx + rad; xx++) {
            if (!map.inBounds(xx, yy)) continue;
            var ii = map.idx(xx, yy);
            if (!open[ii]) continue;
            var d = U.dist(xx, yy, fx, fy);
            if (d > rad) continue;
            map.terrain[ii] = d < rad * 0.5 ? DEEP : SHALLOW;
          }
        }
      }

      /* The sealed room. Nothing has opened it since it was closed, so
         it is not joined to the caverns: the only way in is through the
         rock, which is the point. */
      if (U.chance(0.35 + 0.16 * depth)) placeVault(level, open);
    });

    /* Cost model: only the faces become Things. Everything behind them
       is terrain until somebody cuts that far.

       The mask decides what counts as open, not the live terrain grid:
       materialising a face turns bedrock into cut floor, so reading the
       grid as it changes would let the face cascade into the whole map
       one cell at a time. */
    var faceList = [];
    for (var i2 = 0; i2 < size; i2++) {
      if (open[i2] || map.terrain[i2] !== BEDROCK) continue;
      if (!touchesMask(map, i2, open)) continue;
      faceList.push(i2);
    }
    for (var fi = 0; fi < faceList.length; fi++) materialiseFace(level, faceList[fi]);

    for (var c2 = 0; c2 < size; c2++) map.pathCost[c2] = map._computeCost(c2);
  }

  /* A wandering two-wide passage between two chambers. Straight lines
     read as corridors somebody built; a little wander reads as rock. */
  function carveCorridor(open, map, a, b) {
    var x = a[0], y = a[1], guard = 0;
    while ((x !== b[0] || y !== b[1]) && guard++ < 600) {
      carveDisc(open, map, x, y, 1);
      var dx = b[0] - x, dy = b[1] - y;
      if (U.rand() < 0.14) {
        var p = U.pick(U.ADJ4);
        x += p[0]; y += p[1];
      } else if (Math.abs(dx) > Math.abs(dy)) {
        x += U.sign(dx);
      } else {
        y += U.sign(dy);
      }
      x = U.clamp(x, 4, map.w - 5);
      y = U.clamp(y, 4, map.h - 5);
    }
    carveDisc(open, map, b[0], b[1], 1);
  }

  /* Returns how many cells this cut actually opened, so the caller can
     spend a budget rather than guess at a step count. */
  function carveDisc(open, map, cx, cy, r) {
    var n = 0;
    for (var y = cy - r; y <= cy + r; y++) {
      for (var x = cx - r; x <= cx + r; x++) {
        if (x < 3 || y < 3 || x >= map.w - 3 || y >= map.h - 3) continue;
        if (U.distSq(x, y, cx, cy) > r * r + 0.3) continue;
        var i = map.idx(x, y);
        if (open[i]) continue;
        open[i] = 1;
        n++;
      }
    }
    return n;
  }

  function touchesMask(map, i, mask) {
    var x = map.xOf(i), y = map.yOf(i);
    for (var k = 0; k < U.ADJ8.length; k++) {
      var nx = x + U.ADJ8[k][0], ny = y + U.ADJ8[k][1];
      if (!map.inBounds(nx, ny)) continue;
      if (mask[map.idx(nx, ny)]) return true;
    }
    return false;
  }

  /* Turn one cell of solid rock into a cut face: walkable stone under a
     mineable wall, exactly the shape the surface presents to a miner. */
  function materialiseFace(level, i) {
    var map = level.map;
    if (map.terrain[i] !== tIdx('bedrock')) return false;
    if (map.buildingId[i]) return false;
    var x = map.xOf(i), y = map.yOf(i);
    map.terrain[i] = tIdx('rockFloor');
    map.spawnThing(oreAt(level.z, i), x, y);
    map.markPathDirtyIdx(i);
    level.faces.push(i);
    return true;
  }

  function placeVault(level, open) {
    var map = level.map;
    var vw = U.randInt(5, 8), vh = U.randInt(4, 6);
    for (var attempt = 0; attempt < 30; attempt++) {
      var x0 = U.randInt(6, map.w - vw - 7), y0 = U.randInt(6, map.h - vh - 7);
      var clear = true;
      for (var y = y0 - 2; y < y0 + vh + 2 && clear; y++) {
        for (var x = x0 - 2; x < x0 + vw + 2; x++) {
          if (!map.inBounds(x, y) || open[map.idx(x, y)]) { clear = false; break; }
        }
      }
      if (!clear) continue;

      var stone = tIdx('stoneFloor');
      for (var yy = y0; yy < y0 + vh; yy++) {
        for (var xx = x0; xx < x0 + vw; xx++) {
          var i = map.idx(xx, yy);
          map.terrain[i] = stone;
          open[i] = 1;
        }
      }
      var loot = [
        ['silver', U.randInt(140, 420)],
        ['components', U.randInt(4, 14)],
        ['medicine', U.randInt(2, 8)],
        ['steel', U.randInt(30, 110)]
      ];
      for (var l = 0; l < loot.length; l++) {
        map.addItem(loot[l][0], x0 + 1 + (l % (vw - 2)), y0 + 1 + ((l / (vw - 2)) | 0), loot[l][1]);
      }
      if (U.chance(0.5)) map.addItem(U.pick(['boltRifle', 'autoRifle', 'shotgun']), x0 + vw - 2, y0 + vh - 2, 1);

      level.vaults.push({
        x: x0, y: y0, w: vw, h: vh, triggered: false,
        kindId: U.pick(['wolf', 'bear', 'boomrat']),
        count: U.randInt(2, 2 + (-level.z))
      });
      return true;
    }
    return false;
  }

  function generateUpper(level) {
    var map = level.map;
    map.terrain.fill(tIdx('openSky'));
    map.roof.fill(0);
    for (var i = 0; i < map.size; i++) map.pathCost[i] = map._computeCost(i);
  }

  /* ============================================================
     SUPPORT AND COLLAPSE
     ============================================================ */

  function holdsUp(map, x, y) {
    if (!map || !map.inBounds(x, y)) return false;
    var b = map.buildingAt(x, y);
    return !!(b && b.def && b.def.holdsRoof && !b.isBlueprint && !b.isFrame);
  }

  /* Is a cell on level z held up by the level below it? Directly
     beneath is the obvious answer; a beam reaches BEAM_SPAN cells from
     a support in any of the four directions, which is what lets a room
     upstairs be wider than the wall downstairs. */
  Levels.supportedAt = function (z, x, y) {
    z = z | 0;
    if (z <= 0) return true;                 /* the surface and below rest on rock */
    var below = Levels.get(z - 1);
    if (!below) return false;
    var map = below.map;
    if (!map.inBounds(x, y)) return false;
    if (holdsUp(map, x, y)) return true;
    for (var d = 0; d < 4; d++) {
      var dx = U.ADJ4[d][0], dy = U.ADJ4[d][1];
      for (var s = 1; s <= BEAM_SPAN; s++) {
        var bx = x + dx * s, by = y + dy * s;
        if (!map.inBounds(bx, by)) break;
        if (holdsUp(map, bx, by)) return true;
      }
    }
    return false;
  };

  /* Is there anything here that could fall? Sky holds nothing up and
     falls out of nothing. */
  function hasStructure(map, x, y) {
    if (!map.inBounds(x, y)) return false;
    var i = map.idx(x, y);
    if (map.terrain[i] !== tIdx('openSky')) return true;
    return !!map.buildingId[i];
  }

  /* What input.js and ui.js should ask before letting a build ghost sit
     on an upper floor. Construct.canPlace is not editable from here, so
     this is offered rather than enforced: call it, and refuse the
     placement when it says no. */
  Levels.canBuildAt = function (z, x, y) {
    z = z | 0;
    var lv = Levels.get(z);
    if (!lv) return { ok: false, reason: 'that level does not exist' };
    if (!lv.map.inBounds(x, y)) return { ok: false, reason: 'off the map' };
    if (z <= 0) return { ok: true, reason: '' };
    var i = lv.map.idx(x, y);
    if (lv.map.terrain[i] !== tIdx('openSky')) return { ok: true, reason: '' };
    if (Levels.supportedAt(z, x, y)) return { ok: true, reason: '' };
    return { ok: false, reason: 'nothing below holds this up' };
  };

  /* Lay a floor on an upper level. The only way an upper floor grows. */
  Levels.buildFloor = function (z, x, y, terrainId) {
    var can = Levels.canBuildAt(z, x, y);
    if (!can.ok) return false;
    var lv = Levels.get(z);
    var id = terrainId && Defs.has('terrain', terrainId) ? terrainId : 'concreteFloor';
    if (!lv.map.setTerrain(x, y, id)) return false;
    watchSupport(lv, lv.map.idx(x, y));
    return true;
  };

  function watchSupport(level, i) {
    if (level.z <= 0) return;
    if (level.supportList.indexOf(i) < 0) level.supportList.push(i);
  }

  Levels.checkCollapse = function (z, x, y) {
    z = z | 0;
    if (z <= 0) return false;
    var lv = Levels.get(z);
    if (!lv || !lv.map.inBounds(x, y)) return false;
    if (!hasStructure(lv.map, x, y)) return false;
    if (Levels.supportedAt(z, x, y)) return false;
    return queueCollapse(z, x, y);
  };

  /* Mining a cell out is the common cause, and the cell above is the
     only one that can have lost support because of it - plus whatever
     a beam was reaching to. Queued, never recursed. */
  Levels.noteCellOpened = function (z, x, y) {
    var above = Levels.get(z + 1);
    if (!above) return 0;
    var n = 0;
    for (var dy = -BEAM_SPAN; dy <= BEAM_SPAN; dy++) {
      for (var dx = -BEAM_SPAN; dx <= BEAM_SPAN; dx++) {
        if (dx && dy) continue;                       /* beams run straight */
        if (Levels.checkCollapse(z + 1, x + dx, y + dy)) n++;
      }
    }
    return n;
  };

  function queueCollapse(z, x, y) {
    if (_collapse.length >= COLLAPSE_CAP) return false;
    var key = z + ':' + x + ':' + y;
    if (_collapseSet[key]) return false;
    _collapseSet[key] = 1;
    _collapse.push({ z: z, x: x, y: y, key: key });
    return true;
  }

  function runCollapses() {
    var budget = COLLAPSE_PER_TICK, fell = 0, fx = 0, fy = 0, fz = 0;
    while (budget-- > 0 && _collapse.length) {
      var job = _collapse.shift();
      delete _collapseSet[job.key];
      if (collapseCell(job.z, job.x, job.y)) { fell++; fx = job.x; fy = job.y; fz = job.z; }
    }
    if (fell) announceCollapse(fz, fx, fy, fell);
  }

  function collapseCell(z, x, y) {
    var lv = Levels.get(z);
    if (!lv) return false;
    var map = lv.map;
    if (!map.inBounds(x, y)) return false;
    if (!hasStructure(map, x, y)) return false;
    if (Levels.supportedAt(z, x, y)) return false;    /* somebody propped it back up */

    var below = Levels.get(z - 1);
    var i = map.idx(x, y);
    var Health = sys('Health');

    /* The building goes first, so its leavings land on the floor it is
       about to stop being. */
    var b = map.buildingAt(x, y);
    if (b && !b.isBlueprint && !b.isFrame) map.destroyThing(b, 'collapse');
    var ghost = map.ghostAt ? map.ghostAt(x, y) : null;
    if (ghost) map.destroyThing(ghost, 'collapse');

    /* Everything loose falls through to the level below. */
    var items = map.items(x, y).slice();
    for (var k = 0; k < items.length; k++) {
      var t = items[k];
      var defId = t.defId, stack = t.stack;
      map.despawnThing(t);
      if (below) below.map.addItem(defId, x, y, stack);
    }

    /* And so does anybody standing here. */
    var here = map.pawnsAt(x, y);
    var riders = here.length ? here.slice() : [];
    for (var p = 0; p < riders.length; p++) {
      var pawn = riders[p];
      if (below) Levels.transfer(pawn, z - 1, { force: true });
      if (Health && Health.damage) {
        Health.damage(pawn, {
          amount: U.randInt(COLLAPSE_DAMAGE[0], COLLAPSE_DAMAGE[1]),
          type: 'blunt', source: 'collapse'
        });
      }
    }

    /* Whatever it lands on takes the same beating. */
    if (below) {
      var under = below.map.pawnsAt(x, y);
      for (var q = 0; q < under.length; q++) {
        if (riders.indexOf(under[q]) >= 0) continue;
        if (Health && Health.damage) {
          Health.damage(under[q], {
            amount: U.randInt(COLLAPSE_DAMAGE[0], COLLAPSE_DAMAGE[1]),
            type: 'blunt', source: 'collapse'
          });
        }
      }
      var hitBuilding = below.map.buildingAt(x, y);
      if (hitBuilding && hitBuilding.def && !hitBuilding.def.natural) {
        hitBuilding.hp -= U.randInt(20, 60);
        if (hitBuilding.hp <= 0) below.map.destroyThing(hitBuilding, 'collapse');
      }
    }

    /* The floor itself falls away and the cell goes back to sky, which
       is also what stops this cell being queued a second time. */
    map.terrain[i] = tIdx('openSky');
    map.markPathDirtyIdx(i);
    U.remove(lv.supportList, i);

    /* Neighbours that were leaning on this cell's support may now be
       unsupported themselves. Queued, so the sweep stays bounded. */
    for (var d = 0; d < 4; d++) {
      var nx = x + U.ADJ4[d][0], ny = y + U.ADJ4[d][1];
      if (map.inBounds(nx, ny) && hasStructure(map, nx, ny) && !Levels.supportedAt(z, nx, ny)) {
        queueCollapse(z, nx, ny);
      }
    }
    _graph = null;
    return true;
  }

  function announceCollapse(z, x, y, n) {
    var G = root.Game;
    if (!G || !G.letter) return;
    if (G.tick - _lastCollapseLetter < 600) return;
    _lastCollapseLetter = G.tick;
    G.letter('Collapse',
      n + ' cell' + (n === 1 ? '' : 's') + ' of upper floor ' + z + ' came down: nothing below ' +
      'was holding ' + (n === 1 ? 'it' : 'them') + ' up. Put a wall or a column under the span ' +
      'before building there again.',
      { kind: 'threat', x: x, y: y });
  }

  /* Rolling re-check of everything overhead, so a support mined out by
     a system that never calls checkCollapse is still found within a few
     seconds of game time. Empty, and free, while no upper floor exists. */
  function sweepSupport(level) {
    var list = level.supportList;
    if (!list.length) return;
    var n = Math.min(SUPPORT_SLICE, list.length);
    for (var k = 0; k < n; k++) {
      if (level.supportCursor >= list.length) level.supportCursor = 0;
      var i = list[level.supportCursor++];
      var x = level.map.xOf(i), y = level.map.yOf(i);
      if (!hasStructure(level.map, x, y)) {
        U.remove(list, i);
        if (level.supportCursor > 0) level.supportCursor--;
        continue;
      }
      if (!Levels.supportedAt(level.z, x, y)) queueCollapse(level.z, x, y);
    }
  }

  /* ============================================================
     THE MINE FACE

     A face that has been mined out stops being a face, and the cells
     behind it become the new face. Nothing hooks construct.js for
     this; a bounded slice of each basement's face list is re-examined
     every FACE_PERIOD ticks, which is a third of a second against the
     thirteen seconds it takes to mine one rock.
     ============================================================ */

  function sweepFaces(level) {
    var list = level.faces;
    if (!list.length) return;
    var map = level.map;
    var n = Math.min(FACE_SLICE, list.length);
    for (var k = 0; k < n; k++) {
      if (level.faceCursor >= list.length) level.faceCursor = 0;
      var i = list[level.faceCursor];
      if (map.buildingId[i]) { level.faceCursor++; continue; }

      /* Mined out. Swap-pop and leave the cursor where it is, because
         the entry that just moved into this slot has not been seen. */
      var last = list.pop();
      if (level.faceCursor < list.length) list[level.faceCursor] = last;

      var x = map.xOf(i), y = map.yOf(i);
      var bedrock = tIdx('bedrock');
      for (var d = 0; d < U.ADJ8.length; d++) {
        var nx = x + U.ADJ8[d][0], ny = y + U.ADJ8[d][1];
        if (!map.inBounds(nx, ny)) continue;
        var j = map.idx(nx, ny);
        if (map.terrain[j] === bedrock) materialiseFace(level, j);
      }
      Levels.noteCellOpened(level.z, x, y);
    }
  }

  /* ============================================================
     CONNECTIONS

     One record per pair. Everything about it is derived from the two
     buildings, so a load or a mid-game deconstruct is reconciled by
     looking at the maps rather than by trusting a saved id.
     ============================================================ */

  function Connection(kind, lowZ, x, y, lowThing, highThing) {
    this.id = U.nextId();
    this.kind = kind;
    this.lowZ = lowZ;
    this.x = x;
    this.y = y;
    this.lowId = lowThing ? lowThing.id : 0;
    this.highId = highThing ? highThing.id : 0;
    this._aLow = -1;
    this._aHigh = -1;
    this._usable = false;
  }

  Connection.prototype.lowThing = function () {
    var m = Levels.mapOf(this.lowZ);
    return m ? m.thing(this.lowId) : null;
  };
  Connection.prototype.highThing = function () {
    var m = Levels.mapOf(this.lowZ + 1);
    return m ? m.thing(this.highId) : null;
  };
  Connection.prototype.intact = function () {
    var a = this.lowThing(), b = this.highThing();
    return !!(a && a.spawned && b && b.spawned);
  };
  Connection.prototype.otherZ = function (z) {
    return z === this.lowZ ? this.lowZ + 1 : this.lowZ;
  };

  /* Usable means both ends are standing, neither cell is blocked, and -
     for a lift - the winch at the bottom has power. */
  Connection.prototype.usable = function () {
    var a = this.lowThing(), b = this.highThing();
    if (!a || !a.spawned || !b || !b.spawned) return false;
    var lowMap = Levels.mapOf(this.lowZ), highMap = Levels.mapOf(this.lowZ + 1);
    if (!lowMap || !highMap) return false;
    if (!lowMap.passable(this.x, this.y) || !highMap.passable(this.x, this.y)) return false;
    if (this.kind === 'lift') {
      var Power = sys('Power');
      if (Power && Power.isPowered && !Power.isPowered(a)) return false;
    }
    return true;
  };

  Levels.connections = function () { return _connections; };

  Levels.connectionsFrom = function (z) {
    z = z | 0;
    var out = [];
    for (var i = 0; i < _connections.length; i++) {
      var c = _connections[i];
      if (c.lowZ === z || c.lowZ + 1 === z) out.push(c);
    }
    return out;
  };

  Levels.connectionAt = function (z, x, y) {
    z = z | 0;
    for (var i = 0; i < _connections.length; i++) {
      var c = _connections[i];
      if (c.x !== x || c.y !== y) continue;
      if (c.lowZ === z || c.lowZ + 1 === z) return c;
    }
    return null;
  };

  Levels.connectionBetween = function (fromZ, toZ, x, y) {
    if (Math.abs(fromZ - toZ) !== 1) return null;
    var low = Math.min(fromZ, toZ);
    for (var i = 0; i < _connections.length; i++) {
      var c = _connections[i];
      if (c.lowZ === low && c.x === x && c.y === y) return c;
    }
    return null;
  };

  /* Build a pair from the lower level up. The counterpart is spawned,
     not blueprinted: you paid for the shaft when you paid for this end. */
  Levels.link = function (lowZ, x, y, kind, opts) {
    lowZ = lowZ | 0;
    kind = PAIR_LOW[kind] ? kind : 'stairs';
    if (lowZ < MIN_Z || lowZ + 1 > MAX_Z) return null;
    var have = Levels.connectionBetween(lowZ, lowZ + 1, x, y);
    if (have) return have;

    var low = Levels.ensure(lowZ), high = Levels.ensure(lowZ + 1);
    if (!low || !high) return null;

    var faction = (opts && opts.faction) || 'player';
    var lowThing = existingConnector(low.map, x, y) || placeConnector(low, PAIR_LOW[kind], x, y, faction);
    var highThing = existingConnector(high.map, x, y) || placeConnector(high, PAIR_HIGH[kind], x, y, faction);
    if (!lowThing || !highThing) return null;

    var c = new Connection(kind, lowZ, x, y, lowThing, highThing);
    _connections.push(c);
    _gen++;
    _graph = null;
    return c;
  };

  Levels.unlink = function (connection) {
    if (!connection) return false;
    var i = _connections.indexOf(connection);
    if (i < 0) return false;
    _connections.splice(i, 1);
    var a = connection.lowThing(), b = connection.highThing();
    var lowMap = Levels.mapOf(connection.lowZ), highMap = Levels.mapOf(connection.lowZ + 1);
    if (a && lowMap) lowMap.destroyThing(a, 'unlinked');
    if (b && highMap) highMap.destroyThing(b, 'unlinked');
    _gen++;
    _graph = null;
    return true;
  };

  function existingConnector(map, x, y) {
    var b = map.buildingAt(x, y);
    if (b && CONNECTOR_DEFS.indexOf(b.defId) >= 0) return b;
    return null;
  }

  /* Cutting a shaft clears the cell it lands in: on an upper floor that
     means laying a floor there, in bedrock it means opening the rock. */
  function placeConnector(level, defId, x, y, faction) {
    var map = level.map;
    if (!map.inBounds(x, y)) return null;
    var i = map.idx(x, y);

    if (map.terrain[i] === tIdx('bedrock')) {
      map.terrain[i] = tIdx('rockFloor');
      map.markPathDirtyIdx(i);
      var bedrock = tIdx('bedrock');
      for (var d = 0; d < U.ADJ8.length; d++) {
        var nx = x + U.ADJ8[d][0], ny = y + U.ADJ8[d][1];
        if (!map.inBounds(nx, ny)) continue;
        var j = map.idx(nx, ny);
        if (map.terrain[j] === bedrock) materialiseFace(level, j);
      }
    } else if (map.terrain[i] === tIdx('openSky')) {
      map.terrain[i] = tIdx('concreteFloor');
      map.markPathDirtyIdx(i);
      watchSupport(level, i);
    }

    var standing = map.buildingAt(x, y);
    if (standing) map.destroyThing(standing, 'shaft');
    var plant = map.plantAt(x, y);
    if (plant) map.destroyThing(plant, 'shaft');

    return map.spawnThing(defId, x, y, { faction: faction });
  }

  /* A player builds one half through the ordinary construction path,
     which this file cannot hook. So every CONNECTION_PERIOD ticks the
     connector buildings on every level are matched against the records:
     an unpaired one gets its counterpart, and a pair that lost an end
     loses the other. Four array-length reads when nothing is going on. */
  function reconcileConnections() {
    if (!_inited) return;
    var i, c;

    for (i = _connections.length - 1; i >= 0; i--) {
      c = _connections[i];
      if (c.intact()) continue;
      _connections.splice(i, 1);
      var survivor = c.lowThing() || c.highThing();
      if (survivor) {
        var m = survivor.map || Levels.mapOf(c.lowZ);
        if (m) m.destroyThing(survivor, 'unlinked');
      }
      _gen++;
      _graph = null;
    }

    for (var l = 0; l < _list.length; l++) {
      var level = _list[l];
      for (var d = 0; d < CONNECTOR_DEFS.length; d++) {
        var list = level.map.byDef(CONNECTOR_DEFS[d]);
        if (!list.length) continue;
        for (var k = 0; k < list.length; k++) {
          var t = list[k];
          if (!t.spawned) continue;
          if (connectionOwning(t)) continue;
          pairUp(level, t);
        }
      }
    }
  }

  function connectionOwning(thing) {
    for (var i = 0; i < _connections.length; i++) {
      if (_connections[i].lowId === thing.id || _connections[i].highId === thing.id) return _connections[i];
    }
    return null;
  }

  /* stairsDown reaches down, stairsUp reaches up; a ladder or a lift
     reaches whichever way there is room for, preferring down. */
  function pairUp(level, thing) {
    var kind = KIND_OF_DEF[thing.defId];
    if (!kind) return null;
    var goesDown = thing.defId === 'stairsDown' ||
      (kind !== 'stairs' && level.z - 1 >= MIN_Z);
    if (thing.defId === 'stairsUp') goesDown = false;
    var lowZ = goesDown ? level.z - 1 : level.z;
    if (lowZ < MIN_Z || lowZ + 1 > MAX_Z) return null;
    return Levels.link(lowZ, thing.x, thing.y, kind, { faction: thing.faction || 'player' });
  }

  /* ============================================================
     REACHABILITY

     Each level already answers "can a pawn get from here to there on
     THIS map" in one integer compare, through Regions' area labelling.
     Across levels the question is the same one asked of a tiny graph:
     a node is (level, area), an edge is a usable connection, and the
     answer is whether two nodes share a component.

     The cache is rebuilt when the connection set changes, when a
     connection's usability flips, or when any endpoint's area id moves
     - which is every area rebuild, because regions.js renumbers from
     one each time. That is O(connections) to check, and a stale
     "reachable" is the one failure that makes colonists take jobs they
     can never finish, so it is checked on every query.
     ============================================================ */

  function areaAt(z, x, y) {
    var lv = Levels.get(z);
    if (!lv || !lv.map.inBounds(x, y)) return 0;
    var Regions = sys('Regions');
    if (Regions) Regions.update(lv.map);
    return lv.map.areaId[lv.map.idx(x, y)];
  }

  function nodeKey(z, area) { return area ? (z + '#' + area) : null; }

  function graphCurrent() {
    if (!_graph || _graph.gen !== _gen) return false;
    for (var i = 0; i < _connections.length; i++) {
      var c = _connections[i];
      if (areaAt(c.lowZ, c.x, c.y) !== c._aLow) return false;
      if (areaAt(c.lowZ + 1, c.x, c.y) !== c._aHigh) return false;
      if (c.usable() !== c._usable) return false;
    }
    return true;
  }

  function buildGraph() {
    var parent = Object.create(null);
    var adj = Object.create(null);

    function find(k) {
      var r = k;
      while (parent[r] !== undefined && parent[r] !== r) r = parent[r];
      while (parent[k] !== undefined && parent[k] !== k) { var n = parent[k]; parent[k] = r; k = n; }
      return r;
    }
    function add(k) { if (parent[k] === undefined) parent[k] = k; return k; }
    function union(a, b) {
      var ra = find(add(a)), rb = find(add(b));
      if (ra !== rb) parent[rb] = ra;
    }

    for (var i = 0; i < _connections.length; i++) {
      var c = _connections[i];
      c._aLow = areaAt(c.lowZ, c.x, c.y);
      c._aHigh = areaAt(c.lowZ + 1, c.x, c.y);
      c._usable = c.usable();
      if (!c._usable || !c._aLow || !c._aHigh) continue;

      var a = nodeKey(c.lowZ, c._aLow), b = nodeKey(c.lowZ + 1, c._aHigh);
      union(a, b);
      (adj[a] || (adj[a] = [])).push({ to: b, conn: c, toZ: c.lowZ + 1 });
      (adj[b] || (adj[b] = [])).push({ to: a, conn: c, toZ: c.lowZ });
    }

    _graph = { gen: _gen, parent: parent, adj: adj, find: find, add: add };
    return _graph;
  }

  function graph() {
    if (graphCurrent()) return _graph;
    return buildGraph();
  }

  /* A cell that is itself unlabelled - a wall, a stack under a shelf -
     is answered by its neighbours, because a pawn reaches a thing by
     standing next to it. */
  function areaNear(z, x, y) {
    var a = areaAt(z, x, y);
    if (a) return a;
    for (var d = 0; d < U.ADJ8.length; d++) {
      a = areaAt(z, x + U.ADJ8[d][0], y + U.ADJ8[d][1]);
      if (a) return a;
    }
    return 0;
  }

  Levels.reachable = function (fromZ, fx, fy, toZ, tx, ty) {
    fromZ = fromZ | 0; toZ = toZ | 0;
    var from = Levels.get(fromZ), to = Levels.get(toZ);
    if (!from || !to) return false;

    var Regions = sys('Regions');
    if (fromZ === toZ) {
      if (Regions && Regions.sameArea) return Regions.sameArea(from.map, fx, fy, tx, ty);
      return false;
    }

    var a = areaNear(fromZ, fx, fy), b = areaNear(toZ, tx, ty);
    if (!a || !b) return false;
    var g = graph();
    var ka = nodeKey(fromZ, a), kb = nodeKey(toZ, b);
    if (g.parent[ka] === undefined || g.parent[kb] === undefined) return false;
    return g.find(ka) === g.find(kb);
  };

  /* The next step of a cross-level route: either a cell on this level
     for the ordinary A* to walk to, or the connection to take. There is
     no 3D pathfinder and there is not going to be one. */
  Levels.route = function (pawn, toZ, tx, ty) {
    if (!pawn || !pawn.map) return null;
    toZ = toZ | 0;
    var z = Levels.zOf(pawn.map);
    if (z === null) return null;
    if (z === toZ) return { kind: 'cell', z: z, x: tx, y: ty };

    var a = areaNear(z, pawn.x, pawn.y), b = areaNear(toZ, tx, ty);
    if (!a || !b) return null;

    var g = graph();
    var start = nodeKey(z, a), goal = nodeKey(toZ, b);
    if (g.parent[start] === undefined || g.parent[goal] === undefined) return null;
    if (g.find(start) !== g.find(goal)) return null;

    /* Breadth first over a graph with one node per (level, area): a
       handful of nodes even in a colony that has dug every level. */
    var queue = [start], seen = Object.create(null), from = Object.create(null);
    seen[start] = 1;
    var head = 0, found = false;
    while (head < queue.length) {
      var node = queue[head++];
      if (node === goal) { found = true; break; }
      var edges = g.adj[node];
      if (!edges) continue;
      for (var i = 0; i < edges.length; i++) {
        var e = edges[i];
        if (seen[e.to]) continue;
        seen[e.to] = 1;
        from[e.to] = { node: node, edge: e };
        queue.push(e.to);
      }
    }
    if (!found) return null;

    var cur = goal, step = null;
    while (from[cur]) {
      step = from[cur];
      if (step.node === start) break;
      cur = step.node;
    }
    if (!step) return null;
    var c = step.edge.conn;
    return {
      kind: 'connection', conn: c, x: c.x, y: c.y,
      fromZ: z, toZ: c.otherZ(z)
    };
  };

  /* ============================================================
     TRANSFER AND CROSS-LEVEL CLAIMS

     A pawn moving between maps keeps its job, its driver, its carried
     stack and its inventory: those are fields on the pawn, and a
     carried thing is unspawned and belongs to nobody's registry while
     it is in hand. What does NOT travel is a reservation, because
     jobs.js keys reservations per map (map.__reservations) and
     Res.releaseAll only ever clears the table on pawn.map.

     So Levels keeps a ledger on the pawn itself - pawn.levelClaims, a
     list of [z, key] pairs in plain arrays so save.js carries it. Every
     claim the pawn holds on the level it is leaving is recorded there
     at the moment it leaves, the claim itself is left standing (it is
     still wanted: the storage cell downstairs must stay reserved while
     the hauler is upstairs), and it is dropped either by the job that
     made it or by a rare-tick sweep that catches any pawn holding a
     remote claim without a job to justify it.
     ============================================================ */

  function claimsTable(z) {
    var map = Levels.mapOf(z);
    if (!map) return null;
    if (!(map.__reservations instanceof Map)) map.__reservations = new Map();
    return map.__reservations;
  }

  function rememberClaims(pawn, z) {
    var tbl = claimsTable(z);
    if (!tbl || !tbl.size) return;
    if (!pawn.levelClaims) pawn.levelClaims = [];
    tbl.forEach(function (entry, key) {
      if (entry.ids.indexOf(pawn.id) < 0) return;
      for (var i = 0; i < pawn.levelClaims.length; i++) {
        if (pawn.levelClaims[i][0] === z && pawn.levelClaims[i][1] === key) return;
      }
      pawn.levelClaims.push([z, key]);
    });
  }

  /* Claim something on a level the pawn is not standing on. A work
     giver handing out a cross-level job needs this: the destination
     cell must be locked at the moment of the decision, exactly as a
     local claim is, or two haulers walk down the same stairs. */
  Levels.reserveOn = function (z, pawn, target, max) {
    var T = sys('T');
    var map = Levels.mapOf(z);
    if (!T || !map || !pawn || !target) return false;
    var key = T.key(target, map);
    if (!key) return false;
    var tbl = claimsTable(z);
    var e = tbl.get(key);
    var want = max > 0 ? max : 1;
    if (e && e.ids.length) {
      if (e.ids.indexOf(pawn.id) < 0 && e.ids.length >= Math.min(want, e.max || 1)) return false;
    }
    if (!e) { e = { ids: [], max: want }; tbl.set(key, e); }
    e.max = e.ids.length ? Math.min(e.max || want, want) : want;
    if (e.ids.indexOf(pawn.id) < 0) e.ids.push(pawn.id);
    if (!pawn.levelClaims) pawn.levelClaims = [];
    pawn.levelClaims.push([z, key]);
    return true;
  };

  Levels.canReserveOn = function (z, pawn, target, max) {
    var T = sys('T');
    var map = Levels.mapOf(z);
    if (!T || !map || !pawn || !target) return false;
    var key = T.key(target, map);
    var tbl = claimsTable(z);
    var e = tbl && tbl.get(key);
    if (!e || !e.ids.length) return true;
    if (e.ids.indexOf(pawn.id) >= 0) return true;
    return e.ids.length < Math.min(max > 0 ? max : 1, e.max || 1);
  };

  /* Give back every claim this pawn holds on a level it is not on. */
  Levels.releaseRemoteClaims = function (pawn) {
    var list = pawn && pawn.levelClaims;
    if (!list || !list.length) return 0;
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var z = list[i][0], key = list[i][1];
      var tbl = claimsTable(z);
      if (!tbl) continue;
      var e = tbl.get(key);
      if (!e) continue;
      var at = e.ids.indexOf(pawn.id);
      if (at < 0) continue;
      e.ids.splice(at, 1);
      n++;
      if (!e.ids.length) tbl.delete(key);
    }
    pawn.levelClaims = null;
    return n;
  };

  function landingCell(map, x, y) {
    if (map.inBounds(x, y) && map.passable(x, y)) return { x: x, y: y };
    var free = map.freeNeighbour ? map.freeNeighbour(x, y) : null;
    if (free) return free;
    var ring = U.cellsInRadius(x, y, 6);
    for (var i = 0; i < ring.length; i++) {
      if (map.inBounds(ring[i][0], ring[i][1]) && map.passable(ring[i][0], ring[i][1])) {
        return { x: ring[i][0], y: ring[i][1] };
      }
    }
    return null;
  }

  Levels.transfer = function (pawn, toZ, opts) {
    opts = opts || {};
    if (!pawn || !pawn.map || pawn.dead) return false;
    toZ = toZ | 0;
    var fromZ = Levels.zOf(pawn.map);
    var target = Levels.get(toZ);
    if (fromZ === null || !target || fromZ === toZ) return false;

    if (!opts.force) {
      var c = Levels.connectionBetween(fromZ, toZ, pawn.x, pawn.y);
      if (!c || !c.usable()) return false;
    }

    var dest = landingCell(target.map, pawn.x, pawn.y);
    if (!dest) return false;

    rememberClaims(pawn, fromZ);

    var old = pawn.map;
    old.removePawn(pawn);
    pawn.stopPath();
    pawn.map = target.map;
    pawn.x = dest.x; pawn.y = dest.y;
    pawn.fx = dest.x; pawn.fy = dest.y;
    pawn.destX = dest.x; pawn.destY = dest.y;
    pawn.levelZ = toZ;
    target.map.addPawn(pawn, dest.x, dest.y);

    /* Anything the pawn had aimed at on the old map is gone from its
       point of view; the job's own toils re-aim on the new one. */
    if (pawn.aimTarget) pawn.aimTarget = null;
    return true;
  };

  /* ============================================================
     TEMPERATURE AND LIGHT
     ============================================================ */

  /* A basement is a long way from the weather and barely moves; an
     upper floor is a roof with walls on it and gets the full outdoor
     swing. */
  Levels.ambientTemperature = function (z) {
    z = z | 0;
    var G = root.Game;
    var outdoor = (G && G.outdoorTemp) ? G.outdoorTemp() : 18;
    if (z < 0) return BASEMENT_TEMP + BASEMENT_DRIFT * (-z - 1);
    return outdoor;
  };

  Levels.isOutdoorLevel = function (z) { return (z | 0) >= 0; };

  /* Cached per tick, and also against the map's thing count, because a
     lamp built this tick has to light the cell this tick. */
  function lampList(level) {
    var t = now(), n = level.map.things.size;
    if (level.lamps && level.lampTick === t && level.lampCount === n) return level.lamps;
    var out = [];
    level.map.things.forEach(function (thing) {
      if (!thing.spawned || !thing.def || !thing.def.building) return;
      if (!(thing.def.building.lightRadius > 0)) return;
      out.push(thing);
    });
    level.lamps = out;
    level.lampTick = t;
    level.lampCount = n;
    return out;
  }

  /* A basement is pitch dark: no daylight reaches it at all, whatever
     roof leakage power.js allows a roofed surface room. Above ground
     the ordinary answer is the right one. */
  Levels.lightAt = function (z, x, y) {
    z = z | 0;
    var lv = Levels.get(z);
    if (!lv) return 0;
    var Power = sys('Power');
    if (z >= 0) return Power && Power.lightAt ? Power.lightAt(lv.map, x, y) : 1;

    var lamps = lampList(lv), light = 0;
    for (var i = 0; i < lamps.length; i++) {
      var t = lamps[i];
      /* A campfire needs fuel, not a grid; only ask about power when the
         thing actually draws any. */
      if (t.def.building.powerConsumed > 0 && !t.powered) continue;
      if (t.def.building.fuelCapacity > 0 && !(t.fuel > 0)) continue;
      if (t.switchOff) continue;
      var r = t.def.building.lightRadius;
      var d = U.dist(x, y, t.x, t.y);
      if (d > r) continue;
      var v = 1 - (d / r) * 0.8;
      if (v > light) light = v;
    }
    return U.clamp01(light);
  };

  /* ============================================================
     JOBS, WORK AND INCIDENTS

     jobs.js, workgivers.js and events.js all load AFTER this file, so
     nothing here can register at load time. Registration happens once,
     from init(), which runs on the first tick of a colony.
     ============================================================ */

  function registerContent() {
    if (_registered) return;
    var Jobs = sys('Jobs'), Toils = sys('Toils'), T = sys('T'), Res = sys('Res');
    if (!Jobs || !Toils || !T || !Res) return;
    _registered = true;

    var PE = sys('Path') ? sys('Path').PE : { ON_CELL: 0, TOUCH: 1 };

    Jobs.register('levelTransit', {
      label: 'change level',
      reportString: 'Heading to another level.',
      keepCarried: true,
      toils: function () { return [transitToil()]; }
    });

    Jobs.register('haulAcrossLevels', {
      label: 'haul between levels',
      reportString: 'Hauling {A} to another level.',
      keepCarried: true,
      toils: function () {
        return [
          Toils.reserve('A', 1),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.pickUp('A', function (pawn, job) {
            var thing = T.resolve(job.targetA, pawn.map);
            if (!thing) return 0;
            var limit = thing.def.stackLimit || 1;
            var want = job.count > 0 ? job.count : thing.stack;
            return Math.min(want, thing.stack, limit);
          }),
          transitToil(),
          Toils.goto('B', { pe: PE.ON_CELL, failIfGone: false }),
          Toils.custom({
            name: 'putDownAcross',
            tick: function (pawn, job) {
              if (pawn.carried) Toils.placeCarried(pawn, pawn.x, pawn.y);
              Levels.releaseRemoteClaims(pawn);
              return 'next';
            },
            end: function (pawn) { Levels.releaseRemoteClaims(pawn); }
          })
        ];
      }
    });

    var WorkGivers = sys('WorkGivers');
    if (WorkGivers && WorkGivers.register && !WorkGivers.get('haulBetweenLevels')) {
      /* The contract puts every work giver in workgivers.js. This one
         lives here because the scan it needs - "is there storage for
         this on ANOTHER map" - is a question only this file can ask.
         Order 40 puts it behind haulGeneral, so a colonist always
         clears the stack in front of them before walking downstairs.
         If workgivers.js would rather own it, it can call
         Levels.tryGiveHaulJob(pawn) and this registration drops out. */
      WorkGivers.register({
        id: 'haulBetweenLevels', workType: 'haul', order: 40,
        label: 'haul between levels',
        tryGiveJob: function (pawn) { return Levels.tryGiveHaulJob(pawn); }
      });
    }

    var Incidents = sys('Incidents');
    if (Incidents && Incidents.register) {
      Incidents.register({
        id: 'deepCollapse',
        label: 'deep collapse',
        category: 'threatSmall',
        minDay: 8,
        weight: function () {
          /* Only a colony that has dug can have a cave-in. */
          var n = 0;
          for (var i = 0; i < _list.length; i++) if (_list[i].z < 0) n++;
          return n ? 1.2 * n : 0;
        },
        fire: function (g) { return fireDeepCollapse(g); }
      });
    }
  }

  /* Walk to the next connection on the route and take it, repeating
     until the pawn is standing on the level the job is aimed at. */
  function transitToil() {
    var Toils = sys('Toils');
    return Toils.custom({
      name: 'levelTransit',
      init: function (pawn, job, s) { s.fails = 0; s.ticks = 0; s.dx = -1; s.dy = -1; },
      tick: function (pawn, job, s) {
        var toZ = job.state && job.state.toZ;
        if (toZ === undefined || toZ === null) return 'next';
        var z = Levels.zOf(pawn.map);
        if (z === null) return 'fail';
        if (z === toZ) { pawn.stopPath(); return 'next'; }
        if (++s.ticks > 6000) return 'fail';

        var step = Levels.route(pawn, toZ, job.state.tx | 0, job.state.ty | 0);
        if (!step || step.kind !== 'connection') return 'fail';

        if (pawn.x === step.x && pawn.y === step.y) {
          if (!Levels.transfer(pawn, step.toZ)) return 'fail';
          s.dx = -1; s.dy = -1; s.fails = 0;
          return 'stay';
        }
        if (!pawn.moving() || s.dx !== step.x || s.dy !== step.y) {
          if (!pawn.startPath(step.x, step.y, 0)) {
            return (++s.fails > 1) ? 'fail' : 'stay';
          }
          s.dx = step.x; s.dy = step.y; s.fails = 0;
        }
        return 'stay';
      },
      end: function (pawn, job, s) { if (s) s.dx = -1; }
    });
  }

  /* Loose things on this pawn's level that no stockpile HERE will take
     but a stockpile on another level will. Anything with local storage
     is haulGeneral's business and is skipped, so the two givers never
     fight over the same stack. */
  function crossHaulCandidates(map, limit) {
    var cache = map.__levelsHaulScan;
    var t = now();
    if (cache && cache.tick === t) return cache.list;

    var Zones = sys('Zones');
    var out = [];
    if (Zones && Zones.storable && Zones.bestStorageFor) {
      var defs = Defs.items();
      for (var d = 0; d < defs.length && out.length < limit; d++) {
        if (!Zones.storable(defs[d])) continue;
        var list = map.byDef(defs[d].id);
        for (var k = 0; k < list.length && out.length < limit; k++) {
          var thing = list[k];
          if (!thing.spawned || thing.isBlueprint || thing.isFrame) continue;
          if (Zones.bestStorageFor(map, thing, null)) continue;
          out.push(thing);
        }
      }
    }
    map.__levelsHaulScan = { tick: t, list: out };
    return out;
  }

  Levels.tryGiveHaulJob = function (pawn) {
    if (_list.length < 2 || !pawn || !pawn.map) return null;
    var z = Levels.zOf(pawn.map);
    if (z === null) return null;

    var Jobs = sys('Jobs'), T = sys('T'), Res = sys('Res'), Zones = sys('Zones');
    if (!Jobs || !T || !Res || !Zones) return null;

    var candidates = crossHaulCandidates(pawn.map, HAUL_SCAN_LIMIT);
    for (var i = 0; i < candidates.length; i++) {
      var thing = candidates[i];
      if (!thing.spawned) continue;
      if (!Res.canReserve(pawn, T.thing(thing), 1)) continue;
      if (!Levels.reachable(z, pawn.x, pawn.y, z, thing.x, thing.y)) continue;

      for (var l = 0; l < _list.length; l++) {
        var lv = _list[l];
        if (lv.z === z) continue;
        var spot = Zones.bestStorageFor(lv.map, thing, null);
        if (!spot) continue;
        if (!Levels.reachable(z, pawn.x, pawn.y, lv.z, spot.x, spot.y)) continue;

        var cell = T.cell(spot.x, spot.y);
        if (!Levels.canReserveOn(lv.z, pawn, cell, 1)) continue;
        if (!Res.reserve(pawn, T.thing(thing), 1)) continue;
        if (!Levels.reserveOn(lv.z, pawn, cell, 1)) { Res.release(pawn, T.thing(thing)); continue; }

        return Jobs.make('haulAcrossLevels', T.thing(thing), cell, {
          count: thing.stack,
          state: { fromZ: z, toZ: lv.z, tx: spot.x, ty: spot.y }
        });
      }
    }
    return null;
  };

  function fireDeepCollapse(g) {
    var deep = [];
    for (var i = 0; i < _list.length; i++) if (_list[i].z < 0) deep.push(_list[i]);
    if (!deep.length) return false;
    var lv = U.pick(deep);
    var map = lv.map;

    /* Somewhere a colonist has actually opened up: a cave-in in rock
       nobody has touched is not an event, it is a sound effect. */
    var open = [];
    for (var f = 0; f < lv.faces.length && open.length < 60; f++) {
      var idx = lv.faces[f];
      if (!map.buildingId[idx]) open.push(idx);
    }
    if (!open.length) return false;
    var at = U.pick(open);
    var x = map.xOf(at), y = map.yOf(at);

    var Plants = sys('Plants');
    var hurt = 0;
    var cells = U.cellsInRadius(x, y, 3);
    for (var c = 0; c < cells.length; c++) {
      var cx = cells[c][0], cy = cells[c][1];
      if (!map.inBounds(cx, cy)) continue;
      if (map.terrain[map.idx(cx, cy)] === tIdx('bedrock')) continue;
      var pawns = map.pawnsAt(cx, cy);
      var Health = sys('Health');
      for (var p = 0; p < pawns.length; p++) {
        if (Health && Health.damage) {
          Health.damage(pawns[p], { amount: U.randInt(6, 18), type: 'blunt', source: 'cave-in' });
          hurt++;
        }
      }
      if (U.chance(0.25) && !map.buildingId[map.idx(cx, cy)]) {
        map.addItem('stoneChunk', cx, cy, 1);
      }
    }
    if (g && g.letter) {
      g.letter('Cave-in',
        'A section of the workings on level ' + lv.z + ' came down. ' +
        (hurt ? hurt + ' of your people were under it.' : 'Nobody was under it.'),
        { kind: 'threat', x: x, y: y });
    }
    return true;
  }

  /* ============================================================
     THE TICK

     Game.doTick ticks Game.map. Every OTHER level is ticked here, in
     the same order and with the same systems, so a colonist in a
     basement lives in the same world as one on the surface.
     ============================================================ */

  var MAP_TICKERS = [['Fire', 'tick'], ['Gore', 'tick'], ['Breakdowns', 'tick']];
  var PAWN_TICKERS = [
    ['Medicine', 'tickPawn'], ['Drugs', 'tickPawn'], ['Statuses', 'tickPawn'],
    ['Abilities', 'tickPawn'], ['Royalty', 'tickPawn'], ['Biotech', 'tickPawn'],
    ['Social', 'tickPawn'], ['Husbandry', 'tickPawn'], ['Slavery', 'tickPawn'],
    ['Tactics', 'tickPawn']
  ];

  function tickLevel(level, t) {
    var map = level.map;
    var Regions = sys('Regions'), Power = sys('Power');

    if (Regions) Regions.update(map);
    if (Power) { Power.update(map); Power.tick(map); }
    map.tick();

    var i, fn;
    for (i = 0; i < MAP_TICKERS.length; i++) {
      var g = root[MAP_TICKERS[i][0]];
      fn = g && g[MAP_TICKERS[i][1]];
      if (typeof fn === 'function') fn.call(g, map, root.Game);
    }

    tickPlantSlice(level, t);

    var pawns = map.pawns.slice();
    var Prisoners = sys('Prisoners');
    for (var p = 0; p < pawns.length; p++) {
      var pawn = pawns[p];
      if (pawn.dead) continue;
      pawn.tick();
      if (Prisoners && pawn.prisoner) Prisoners.tick(pawn);
      for (i = 0; i < PAWN_TICKERS.length; i++) {
        var pg = root[PAWN_TICKERS[i][0]];
        fn = pg && pg[PAWN_TICKERS[i][1]];
        if (typeof fn === 'function') fn.call(pg, pawn);
      }
    }

    var Combat = sys('Combat');
    if (Combat) Combat.tick(map);

    if (t % HOUSEKEEPING_PERIOD === 0 && Regions && Regions.tickTemperature) {
      Regions.tickTemperature(map, Levels.ambientTemperature(level.z));
    }
  }

  /* Plants are rare below ground and possible above it, so the slice
     costs one length check on a level that has none. */
  function tickPlantSlice(level, t) {
    var Plants = sys('Plants');
    if (!Plants || !Plants.tickRare) return;
    if (level.plantTick !== (t / 250 | 0)) {
      level.plantTick = t / 250 | 0;
      level.plants.length = 0;
      var defs = Defs.plants();
      for (var d = 0; d < defs.length; d++) {
        var list = level.map.byDef(defs[d].id);
        for (var k = 0; k < list.length; k++) level.plants.push(list[k]);
      }
    }
    var n = level.plants.length;
    if (!n) return;
    var slice = Math.max(1, Math.ceil(n / 250));
    for (var s = 0; s < slice; s++) {
      if (level.plantCursor >= n) level.plantCursor = 0;
      var plant = level.plants[level.plantCursor++];
      if (plant && plant.spawned) Plants.tickRare(level.map, plant);
    }
  }

  function sweepClaims() {
    for (var l = 0; l < _list.length; l++) {
      var pawns = _list[l].map.pawns;
      for (var p = 0; p < pawns.length; p++) {
        var pawn = pawns[p];
        if (!pawn.levelClaims || !pawn.levelClaims.length) continue;
        var job = pawn.job;
        if (job && (job.defId === 'haulAcrossLevels' || job.defId === 'levelTransit')) continue;
        Levels.releaseRemoteClaims(pawn);
      }
    }
  }

  function sweepVaults() {
    for (var l = 0; l < _list.length; l++) {
      var level = _list[l];
      if (!level.vaults.length) continue;
      for (var v = 0; v < level.vaults.length; v++) {
        var vault = level.vaults[v];
        if (vault.triggered) continue;
        if (!someoneInside(level.map, vault)) continue;
        vault.triggered = true;
        wakeVault(level, vault);
      }
    }
  }

  function someoneInside(map, vault) {
    for (var y = vault.y; y < vault.y + vault.h; y++) {
      for (var x = vault.x; x < vault.x + vault.w; x++) {
        var list = map.pawnsAt(x, y);
        for (var i = 0; i < list.length; i++) {
          if (list[i].faction === 'player' && !list[i].dead) return true;
        }
      }
    }
    return false;
  }

  function wakeVault(level, vault) {
    var Animals = sys('Animals');
    var spawned = 0;
    if (Animals && Animals.spawnWild) {
      var made = Animals.spawnWild(level.map, vault.kindId, vault.x, vault.y, vault.count) || [];
      for (var i = 0; i < made.length; i++) {
        made[i].manhunter = true;
        spawned++;
      }
    }
    var G = root.Game;
    if (G && G.letter) {
      G.letter('Something was down there',
        'The sealed chamber on level ' + level.z + ' was not empty. ' +
        (spawned ? spawned + ' of them came out of the dark.' : 'Whatever it held is long dead.'),
        { kind: 'threat', x: vault.x, y: vault.y });
    }
  }

  /* The entry point game.js's registry would call if it named this
     file. Signature matches MAP_TICKERS: (map, game). */
  Levels.tick = function (map, g) {
    if (!_inited) {
      var G = g || root.Game;
      if (G && G.map) Levels.init(G.map); else return;
    }
    var t = now();
    if (_tickSeen === t) return;
    _tickSeen = t;

    /* Cheap enough to run with one level: it is how a stairway built on
       the surface finds out it needs a basement under it. */
    if (t % CONNECTION_PERIOD === 0) reconcileConnections();
    if (_list.length < 2) return;

    var driving = root.Game ? root.Game.map : _surface;
    for (var i = 0; i < _list.length; i++) {
      var level = _list[i];
      if (level.map === driving) continue;
      tickLevel(level, t);
    }

    if (t % FACE_PERIOD === 0) {
      for (var f = 0; f < _list.length; f++) if (_list[f].z < 0) sweepFaces(_list[f]);
    }
    if (t % SUPPORT_PERIOD === 0) {
      for (var s = 0; s < _list.length; s++) if (_list[s].z > 0) sweepSupport(_list[s]);
    }
    if (_collapse.length) runCollapses();
    if (t % HOUSEKEEPING_PERIOD === 0) { sweepClaims(); sweepVaults(); }
  };

  /* ============================================================
     DRIVING

     game.js's systems registry does not name Levels, and game.js is
     not this file's to edit. GameMap.prototype.tick IS called once a
     tick for the driving map and exists at load time, so the tick
     arrives through a guarded wrapper on it. The wrapper stands down
     the moment Levels.tick has already run for this game tick, so
     adding ['Levels', 'tick'] to MAP_TICKERS makes it inert rather
     than doubling the work.
     ============================================================ */

  function installDriver() {
    var GameMapCtor = root.GameMap;
    if (_driverInstalled || !GameMapCtor || GameMapCtor.prototype.__levelsDriven) return false;
    var original = GameMapCtor.prototype.tick;
    GameMapCtor.prototype.tick = function () {
      var out = original.apply(this, arguments);
      var G = root.Game;
      if (Levels.autoDrive && G && G.map === this && G.started) {
        if (!_inited || _surface !== G.map) Levels.init(G.map);
        Levels.tick(this, G);
      }
      return out;
    };
    GameMapCtor.prototype.__levelsDriven = true;
    _driverInstalled = true;
    return true;
  }

  /* Two reads on Game that have to see every level rather than the
     surface alone. Without the first, sending the whole colony down a
     staircase reads as "every colonist is dead" and ends the game. */
  function installAggregates() {
    var G = root.Game;
    if (!G || G.__levelsAggregated) return false;
    var baseColonists = G.colonists;
    G.colonists = function () {
      var out = baseColonists.call(G);
      if (_list.length < 2) return out;
      for (var i = 0; i < _list.length; i++) {
        if (_list[i].map === G.map) continue;
        var more = _list[i].map.colonists();
        for (var k = 0; k < more.length; k++) out.push(more[k]);
      }
      return out;
    };
    G.__levelsAggregated = true;
    return true;
  }

  Levels.wealth = function () {
    var total = 0;
    for (var i = 0; i < _list.length; i++) total += _list[i].map.wealth();
    return total;
  };

  Levels.colonists = function () {
    var out = [];
    for (var i = 0; i < _list.length; i++) {
      var more = _list[i].map.colonists();
      for (var k = 0; k < more.length; k++) out.push(more[k]);
    }
    return out;
  };

  /* ============================================================
     SAVE

     save.js serialises exactly one map, inline, inside Save.serialize.
     The change it needs is three call sites:

       1. pull that inline map block out into `Save.mapRecord(map)` and
          its restore half into `Save.restoreMap(rec)`;
       2. `levels: Levels.save(Save.mapRecord)` beside `map:` in the
          returned payload;
       3. `Levels.load(data.levels, Save.restoreMap)` after the surface
          map has been rebuilt.

     Called with a packer, every level round-trips completely. Called
     with none - which is what happens today, before save.js is touched
     - Levels falls back to its own compact packer: terrain, roofs,
     things and designations survive, and pawns standing on a sub-level
     come back on the surface. That is a visible degradation and it is
     stated rather than hidden.
     ============================================================ */

  Levels.SAVE_VERSION = 1;

  /* A cheap fingerprint of a level's terrain, stored beside it so a load
     can say whether what came back is what went in. */
  function terrainSignature(map) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < map.size; i += 7) {
      h ^= map.terrain[i];
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  Levels.terrainSignature = terrainSignature;

  Levels.save = function (packMap) {
    if (!_inited) return null;
    var out = {
      v: Levels.SAVE_VERSION,
      seed: _seed,
      active: _active,
      levels: []
    };
    for (var i = 0; i < _list.length; i++) {
      var level = _list[i];
      if (level.z === 0) continue;         /* save.js already holds the surface */
      out.levels.push({
        z: level.z,
        kind: level.kind,
        vaults: level.vaults.map(function (v) {
          return { x: v.x, y: v.y, w: v.w, h: v.h, triggered: !!v.triggered, kindId: v.kindId, count: v.count };
        }),
        mapSig: terrainSignature(level.map),
        map: typeof packMap === 'function' ? packMap(level.map) : compactMap(level.map)
      });
    }
    return out;
  };

  Levels.load = function (data, unpackMap) {
    var G = root.Game;
    Levels.reset();
    if (!G || !G.map) return false;
    Levels.init(G.map);
    if (!data || !data.levels) return true;

    _seed = data.seed || _seed;
    for (var i = 0; i < data.levels.length; i++) {
      var rec = data.levels[i];
      var level = Levels.ensure(rec.z, { blank: true });
      if (!level) continue;
      if (typeof unpackMap === 'function') {
        var built = unpackMap(rec.map);
        if (built) { level.map = built; level.map.__levelZ = rec.z; }
      } else {
        expandMap(level.map, rec.map);
      }
      level.vaults = rec.vaults || [];
      rebuildDerived(level);
    }
    _active = data.active || 0;
    if (!Levels.get(_active)) _active = 0;
    reconcileConnections();
    _graph = null;
    return true;
  };

  /* After a load nothing knows where the mine faces or the unsupported
     cells are, and both are derivable: a face is a natural wall sitting
     on cut floor, and anything on an upper level that is not sky can
     fall. */
  function rebuildDerived(level) {
    var map = level.map;
    level.faces.length = 0;
    level.supportList.length = 0;
    var sky = tIdx('openSky');
    for (var i = 0; i < map.size; i++) {
      var id = map.buildingId[i];
      if (id) {
        var t = map.things.get(id);
        if (t && t.def && t.def.natural && t.def.mineable) level.faces.push(i);
      }
      if (level.z > 0 && map.terrain[i] !== sky) level.supportList.push(i);
    }
    var Regions = sys('Regions');
    if (Regions) Regions.rebuildAll(map);
    var Power = sys('Power');
    if (Power) { Power.markDirty(map); Power.update(map); }
  }

  /* The fallback packer. Uses save.js's own run-length encoder when it
     is loaded so the two formats stay the same shape. */
  function encode(arr) {
    var Save = sys('Save');
    if (Save && Save.encodeGrid) return Save.encodeGrid(arr);
    return Array.prototype.slice.call(arr);
  }

  function decode(grid, out, remap) {
    var Save = sys('Save');
    if (grid && !Array.isArray(grid) && Save && Save.decodeGrid) {
      Save.decodeGrid(grid, out, remap || null);
      return out;
    }
    if (Array.isArray(grid)) {
      for (var i = 0; i < out.length && i < grid.length; i++) {
        out[i] = remap ? remap(grid[i]) : grid[i];
      }
    }
    return out;
  }

  function compactMap(map) {
    var things = [];
    map.things.forEach(function (t) {
      if (!t.spawned) return;
      things.push([
        t.defId, t.x, t.y, t.stack, t.hp, t.rot, t.faction || null,
        t.quality === null ? -1 : t.quality, t.stuff || null,
        t.growth || 0, t.fuel === null ? -1 : t.fuel
      ]);
    });
    var desig = [];
    map.designations.forEach(function (d, i) { desig.push([i, d.type, d.defId || null]); });
    return {
      w: map.w, h: map.h,
      terrainIds: Defs.all('terrain').map(function (d) { return d.id; }),
      terrain: encode(map.terrain),
      roof: encode(map.roof),
      things: things,
      desig: desig
    };
  }

  function expandMap(map, rec) {
    if (!rec) return false;

    /* Terrain indices are positional, so a build that registered its
       terrains in a different order has to be remapped by id as the
       grid is read rather than patched up afterwards. */
    var table = null;
    if (rec.terrainIds) {
      table = new Array(rec.terrainIds.length);
      for (var t = 0; t < rec.terrainIds.length; t++) {
        table[t] = Defs.has('terrain', rec.terrainIds[t]) ? Defs.index('terrain', rec.terrainIds[t]) : 0;
      }
    }
    decode(rec.terrain, map.terrain, table ? function (v) {
      return table[v] === undefined ? 0 : table[v];
    } : null);
    decode(rec.roof, map.roof, null);

    var things = rec.things || [];
    for (var k = 0; k < things.length; k++) {
      var r = things[k];
      if (!Defs.has('thing', r[0])) continue;
      var thing = map.spawnThing(r[0], r[1], r[2], {
        stack: r[3], rot: r[5], faction: r[6],
        quality: r[7] < 0 ? null : r[7], stuff: r[8], growth: r[9]
      });
      if (thing) {
        thing.hp = r[4];
        if (r[10] >= 0) thing.fuel = r[10];
      }
    }
    var desig = rec.desig || [];
    for (var d = 0; d < desig.length; d++) {
      map.designate(map.xOf(desig[d][0]), map.yOf(desig[d][0]), desig[d][1], { defId: desig[d][2] });
    }
    for (var c = 0; c < map.size; c++) map.pathCost[c] = map._computeCost(c);
    return true;
  }

  /* ============================================================
     DIAGNOSTICS
     ============================================================ */

  Levels.stats = function () {
    var rows = [];
    for (var i = 0; i < _list.length; i++) {
      var lv = _list[i];
      rows.push({
        z: lv.z, kind: lv.kind, things: lv.map.things.size, pawns: lv.map.pawns.length,
        faces: lv.faces.length, watched: lv.supportList.length, vaults: lv.vaults.length,
        temperature: Levels.ambientTemperature(lv.z)
      });
    }
    return {
      levels: _list.length, connections: _connections.length,
      pendingCollapses: _collapse.length, graphGen: _gen, rows: rows
    };
  };

  installDriver();

  root.Levels = Levels;
})(this);
