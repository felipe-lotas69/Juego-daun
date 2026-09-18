/* ============================================================
   fire.js - flame, smoke, heat, and the people who fight it.

   plants.js shipped a thin fire: a Thing on the item grid that grew,
   burned what shared its cell and rolled to spread. This is the real
   one, and it is a superset of that: every name plants.js exported is
   answered here with the same shape, so the call sites can be moved
   over without changing a line at the other end.

   Four ideas run through the whole file.

   1. Fire follows fuel. A cell with nothing flammable in it never
      catches, which is what turns a cleared strip into a firebreak and
      makes a stone wall worth the stonecutting. The one exception is
      deliberate: in a strong wind a big blaze throws embers a few tiles
      downwind, so a firebreak has to be WIDE, not merely present.
   2. Fire is hot before it is close. A blaze raises the temperature of
      the room it stands in, sharply, and a sealed room cooks everything
      inside it - including the colonist who ran in to save the meals.
      Past a point the room flashes over and lights all at once.
   3. Fire makes smoke, and smoke moves. It is a grid that drifts on the
      wind, pools under a roof, blinds anyone shooting through it and
      chokes anyone standing in it.
   4. Fire leaves a mark. Burned ground is scorched for days: it will not
      take a second fire while it is black, which is why a burned-over
      field is the safest place on the map for about a week.

   Everything expensive is either staggered by the burning thing's own
   id or runs on its own beat, because a wildfire is three hundred fires
   at once and it still has to hold sixty ticks a second.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  var Fire = {};

  /* ---------- tuning ----------
     Sizes are 0..1 and live in the fire Thing's `growth`, which map.js
     already carries and save.js already round-trips. Intervals are in
     ticks: 60 to the second, 60000 to the day. */

  var FIRE_MIN_SIZE = 0.05;
  var FIRE_GROW_PER_TICK = 0.0022;      /* full size in about seven seconds */
  var FIRE_STARVE_PER_TICK = 0.006;     /* and out in under three once the fuel is gone */
  var FIRE_DAMAGE_INTERVAL = 15;
  var FIRE_SPREAD_INTERVAL = 30;
  var FIRE_PAWN_INTERVAL = 30;
  var FUEL_RECHECK_INTERVAL = 5;        /* fuel under a fire changes slowly; cache between checks */
  var FIRE_SPREAD_MIN_SIZE = 0.2;
  var FIRE_SPREAD_CHANCE = 0.11;        /* per neighbour, per check, at full size on ideal fuel */
  var FIRE_MAX = 900;                   /* a hard ceiling so a wildfire cannot eat the frame budget */

  var PLANT_BURN_DAMAGE = 4;
  var ITEM_BURN_DAMAGE = 3;
  var BUILDING_BURN_DAMAGE = 2.2;
  var FLOOR_BURN_CHANCE = 0.004;
  var PAWN_BURN_BASE = 2;
  var PAWN_BURN_SCALE = 4;
  var PAWN_IGNITE_CHANCE = 0.30;
  var RADIANT_MIN_SIZE = 0.55;          /* below this a fire only hurts what stands in it */

  /* Embers. Wind is 0..1 from Game.weather; above the threshold a big
     fire starts throwing sparks past whatever gap it cannot cross. */
  var EMBER_MIN_WIND = 0.55;
  var EMBER_MIN_SIZE = 0.6;
  var EMBER_CHANCE = 0.035;
  var EMBER_MIN_RANGE = 2;
  var EMBER_MAX_RANGE = 4;

  var EXTINGUISH_PER_TICK = 0.0045;     /* matches the beat-out job plants.js shipped */
  var EXTINGUISHER_FACTOR = 5;          /* a canister is worth five bare pairs of hands */
  var EXTINGUISHER_CHARGES = 4;
  var EXTINGUISHER_USES_PER_CHARGE = 240;
  var EXTINGUISHER_REFILL_WORK = 240;
  var FIREFIGHTER_CATCH_CHANCE = 0.0006;/* per tick of beating at a big fire, bare-handed */

  var SMOKE_INTERVAL = 15;
  var SMOKE_PER_BEAT = 46;              /* 0..255 added under a full-size fire */
  var SMOKE_DECAY_INDOOR = 0.035;
  var SMOKE_DECAY_OUTDOOR = 0.26;
  var SMOKE_MOVE_INDOOR = 0.30;
  var SMOKE_MOVE_OUTDOOR = 0.55;
  var SMOKE_MIN = 3;                    /* below this a cell is clear and stops being tracked */
  var SMOKE_SIGHT_BLOCK = 0.45;
  var SMOKE_CHOKE = 0.25;
  var SMOKE_MAX_CELLS = 2600;
  var CHOKE_PER_BEAT = 0.004;
  var CHOKE_RECOVER = 0.010;

  var HEAT_INTERVAL = 60;
  var HEAT_PER_FIRE = 3.2;              /* degrees per beat into a room of nominal size */
  var NOMINAL_ROOM = 40;
  var HEAT_DAMAGE_FROM = 110;           /* a room this hot burns the people in it */
  var FLASHOVER_TEMP = 250;
  var FLASHOVER_CHANCE = 0.25;
  var MAX_ROOM_TEMP = 300;              /* what Regions clamps to; staying inside it keeps both honest */

  var DECAY_INTERVAL = 120;
  var SCORCH_DAYS = 6;                  /* how long burned ground stays black and unburnable */
  var WET_DAYS = 0.35;
  var SPRINKLER_INTERVAL = 30;
  var SPRINKLER_RADIUS = 6;
  var SPRINKLER_POWER_MIN = 0.35;       /* how hard it hits a fire per pulse */

  var DANGER_INTERVAL = 1000;
  var WILDFIRE_MIN_DAY = 4;
  var WILDFIRE_CHANCE = 0.055;          /* per danger check, at maximum danger */
  var WILDFIRE_SEEDS = 3;

  var LETTER_COOLDOWN = 2500;
  var MSG_COOLDOWN = 600;
  var ALERT_RADIUS = 14;
  var ROOM_SCAN_LIMIT = 600;
  var CREW_MAX = 4;
  var RESPONSE_RADIUS = 60;             /* the colony is burning: walk across the map for it */

  var TICKS_PER_DAY = 60000;

  /* What a thing is made of decides whether it burns. A stone wall is
     fireproof and a wooden one is not, and that difference is most of
     what stonecutting is for. */
  var STUFF_FLAMMABILITY = {
    wood: 1, cloth: 1, leather: 0.6, steel: 0, stoneBlocks: 0
  };
  var DEFAULT_FLAMMABILITY = 0.6;

  /* Chemfuel is not merely flammable; it is the reason you do not store
     it next to the stove. */
  var VOLATILE = { chemfuel: 2.2 };

  Fire.autoPause = true;                /* the first fire inside the colony stops the clock */

  /* ============================================================
     CONTENT

     Registered additively at load: two buildings, one research project
     and two hediffs. Nothing else happens at load time.
     ============================================================ */

  var S11 = { w: 1, h: 1 };

  /* def_things.js fills every building flag once so power.js can read
     def.building.powerConsumed without a guard on each access. A def
     registered from anywhere else has to carry the same shape. */
  var BUILDING_FLAGS = {
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
    for (k in BUILDING_FLAGS) out[k] = BUILDING_FLAGS[k];
    for (k in o) out[k] = o[k];
    return out;
  }

  var BUILDING_DEFAULTS = {
    category: 'building', description: '', sprite: 'box', color: '#8f97a3', color2: null,
    stackLimit: 1, mass: 20, marketValue: 0,
    nutrition: 0, foodType: null, rotDays: null, isMedicine: false, medicinePotency: 0,
    passable: false, pathCost: 0, fillPercent: 1, blocksLight: false, holdsRoof: false,
    size: S11, rotatable: false, hp: 120, flammable: false,
    beauty: 0, comfort: 0, natural: false,
    buildCost: null, stuffable: false, workToBuild: 0, buildSkill: 'construction',
    buildCategory: null, researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null, building: null, weapon: null, apparel: null
  };

  if (Defs && !Defs.has('thing', 'fireExtinguisher')) {
    Defs.add('thing', {

      fireExtinguisher: {
        label: 'fire extinguisher',
        description: 'A pressurised canister on a stand. A colonist who grabs one before ' +
          'running at a fire puts it out about five times faster; empty, it needs ' +
          'repressurising before it is worth anything again.',
        sprite: 'barrel', color: '#c0392b', color2: '#8f97a3',
        hp: 60, mass: 12, fillPercent: 0.3,
        buildCost: { steel: 15 }, workToBuild: 300,
        buildCategory: 'security', leavings: { steel: 7 },
        building: bld({})
      },

      fireSprinkler: {
        label: 'sprinkler',
        description: 'A powered head that floods the room the moment something in it ' +
          'catches. It cannot beat a blaze on its own, but it buys the minutes a ' +
          'colonist needs to get there, and it leaves everything too wet to relight.',
        sprite: 'cooler', color: '#4a7fd4', color2: '#8f97a3',
        hp: 50, mass: 8, passable: true, pathCost: 0, fillPercent: 0,
        buildCost: { steel: 30, components: 1 }, workToBuild: 500,
        buildCategory: 'security', researchPrerequisite: 'fireSuppression',
        leavings: { steel: 15 },
        building: bld({ powerConsumed: 20 })
      }

    }, BUILDING_DEFAULTS);
  }

  if (Defs && !Defs.has('research', 'fireSuppression')) {
    Defs.add('research', {
      fireSuppression: {
        label: 'fire suppression', cost: 1400, techLevel: 'industrial', tab: 'advanced',
        description: 'Plumbing, a pressure head and a heat trigger. A colony that has ' +
          'burned down once builds these over the kitchen before it rebuilds the kitchen.',
        prerequisites: ['electricity'],
        unlocks: ['fireSprinkler'],
        uiPosition: { x: 2, y: 3 }
      }
    });
  }

  /* Two conditions health.js has no reason to know about on its own. It
     keeps hediffs in one table, and severity for both of these is driven
     from here rather than by a per-day rate. */
  (function registerHediffs() {
    var H = root.Health;
    if (!H || !H.HEDIFFS) return;
    if (!H.HEDIFFS.burning) {
      H.HEDIFFS.burning = {
        id: 'burning', label: 'burning', lethal: false, painOffset: 0.55,
        capMods: { consciousness: -0.10, manipulation: -0.20 }
      };
    }
    if (!H.HEDIFFS.smokeInhalation) {
      H.HEDIFFS.smokeInhalation = {
        id: 'smokeInhalation', label: 'smoke inhalation', lethal: true, painOffset: 0.05,
        capMods: { breathing: -0.45, consciousness: -0.15 },
        deathCause: 'smoke inhalation'
      };
    }
  })();

  /* ============================================================
     SMALL SHARED HELPERS
     ============================================================ */

  function sys(name) { return root[name] || null; }

  /* The map's own clock. It tracks Game.tick exactly while the game is
     running and still works in a headless map test, which is what lets
     every stamp below live on the map rather than in this file. */
  function clockOf(map) { return map ? (map.tickCount | 0) : 0; }

  function recently(map, key, now, gap) {
    var last = map[key];
    return last !== undefined && now >= last && now - last < gap;
  }

  function msg(text, opts) {
    var G = sys('Game');
    if (G && G.msg) G.msg(text, opts);
  }

  function letter(title, text, opts) {
    var G = sys('Game');
    if (G && G.letter) G.letter(title, text, opts);
    else msg(title, { type: (opts && opts.kind) === 'threat' ? 'threat' : 'info' });
  }

  function roomAt(map, x, y) {
    var R = sys('Regions');
    return (R && R.roomAt) ? R.roomAt(map, x, y) : null;
  }

  function temperatureAt(map, x, y) {
    var R = sys('Regions');
    if (R && R.temperatureAt) return R.temperatureAt(map, x, y);
    if (map && map.temperatureAt) return map.temperatureAt(x, y);
    return 20;
  }

  function nameOf(pawn) {
    if (!pawn || !pawn.name) return 'someone';
    return pawn.name.nick || pawn.name.first || 'someone';
  }

  /* ============================================================
     PER-MAP STATE

     Three byte grids and the bookkeeping that keeps them cheap. The
     grids are sparse in practice, so each one carries a list of the
     cells that are not zero and nothing ever walks the whole map.
     ============================================================ */

  function createState(map) {
    return {
      size: map.size,
      smoke: new Uint8Array(map.size),
      scorch: new Uint8Array(map.size),
      wet: new Uint8Array(map.size),
      smokeCells: [], smokeSeen: new Uint8Array(map.size),
      scorchCells: [], wetCells: [],
      next: null, touched: null, touchedFlag: null,
      burning: [],
      windDir: 0, windTargetDir: 0, windX: 1, windY: 0, windSpeed: 0.5,
      alarm: null, outbreaks: 0, pausedDay: -1, lastDanger: 0
    };
  }

  function stateOf(map) {
    var st = map.__fire;
    if (!st || st.size !== map.size) { st = createState(map); map.__fire = st; }
    return st;
  }
  Fire.state = stateOf;

  function trackCell(list, seenGrid, i) {
    if (seenGrid) {
      if (seenGrid[i]) return;
      seenGrid[i] = 1;
    }
    list.push(i);
  }

  /* ============================================================
     FUEL

     What a cell has to offer a flame, as one number. Everything that
     can burn contributes: the plant, the building, the half-built
     frame, the pile of wood somebody left on the floor, and the wooden
     floor itself. Zero means fire cannot live here, and zero is what a
     firebreak is made of.
     ============================================================ */

  function stuffFlammability(thing) {
    var f = STUFF_FLAMMABILITY[thing.stuff];
    return f === undefined ? DEFAULT_FLAMMABILITY : f;
  }

  Fire.flammabilityOf = function (thing) {
    if (!thing || !thing.def) return 0;
    var def = thing.def;
    if (def.id === 'fire' || def.id === 'filthBlood') return 0;
    if (VOLATILE[def.id] !== undefined) return VOLATILE[def.id];
    if (def.category === 'plant') {
      /* A green sapling burns worse than a full-grown tree. */
      return (def.flammable || 0) * (0.35 + 0.65 * U.clamp01(thing.growth));
    }
    if (!def.flammable) return 0;
    return thing.stuff ? stuffFlammability(thing) : DEFAULT_FLAMMABILITY;
  };

  /* A built floor made of wood or cloth burns; bare earth does not. The
     terrain defs carry no flammability of their own, so what a floor
     cost to lay is the honest source of what it burns like. */
  function floorFlammability(terr) {
    if (!terr || terr.isNatural || !terr.buildCost) return 0;
    var best = 0;
    for (var k in terr.buildCost) {
      var f = STUFF_FLAMMABILITY[k];
      if (f !== undefined && f > best) best = f;
    }
    return best;
  }

  /* How big a plant reads as, both to the eye and to a flame. plants.js
     owns the drawing answer; this is the local one, so fire.js does not
     fail to load when plants.js is absent from a bring-up harness. */
  function plantSize(plant) {
    var P = sys('Plants');
    if (P && P.visualSizeOf) return P.visualSizeOf(plant);
    var def = plant.def;
    var base = (def.plant && def.plant.isTree) ? 1.6 : 0.8;
    return base * (0.4 + 0.6 * U.clamp01(plant.growth));
  }

  Fire.fuelAt = function (map, x, y) {
    if (!map.inBounds(x, y)) return 0;
    var st = map.__fire;
    var i = map.idx(x, y);

    /* Black ground has already given up everything it had. This is what
       stops a fire from walking back over its own scar and what makes a
       burned-over field the safe side of the line for a few days. */
    if (st && st.scorch[i] > 160) return 0;

    var fuel = 0;
    var plant = map.plantAt(x, y);
    if (plant) fuel += Fire.flammabilityOf(plant) * plantSize(plant);

    var b = map.buildingAt(x, y);
    if (b) fuel += Fire.flammabilityOf(b) * 1.5;

    /* A half-built wall is a stack of wood standing on end. A blueprint
       is a chalk line and carries flammable:false, so it costs nothing. */
    var g = map.ghostAt ? map.ghostAt(x, y) : null;
    if (g) fuel += Fire.flammabilityOf(g);

    var items = map.items(x, y);
    for (var k = 0; k < items.length; k++) fuel += Fire.flammabilityOf(items[k]) * 0.5;

    fuel += floorFlammability(map.terrainAt(x, y)) * 0.6;

    if (st && st.scorch[i]) fuel *= 1 - st.scorch[i] / 320;
    return fuel;
  };

  /* ============================================================
     WEATHER: WIND AND DRYNESS
     ============================================================ */

  /* Game.weather carries a wind SPEED and nothing else, because wind
     turbines never needed to know which way it was blowing. Fire does,
     so the direction is kept here and mirrored onto the weather block
     for anything that wants to draw it. */
  function tickWind(map, st, now) {
    if (now % 240 !== 0) return;
    var G = sys('Game');
    var speed = (G && G.weather && typeof G.weather.wind === 'number') ? G.weather.wind : 0.5;
    st.windSpeed = U.clamp(speed, 0, 1);

    /* The target direction wanders; the real one chases it, so gusts
       swing round over a minute or two rather than snapping. */
    if (now % 3600 === 0 || st.windTargetDir === undefined) {
      st.windTargetDir = st.windDir + U.randRange(-1.2, 1.2);
    }
    var diff = st.windTargetDir - st.windDir;
    st.windDir += U.clamp(diff, -0.06, 0.06);
    st.windX = Math.cos(st.windDir);
    st.windY = Math.sin(st.windDir);
    if (G && G.weather) {
      G.weather.windDir = st.windDir;
      G.weather.windX = st.windX;
      G.weather.windY = st.windY;
    }
  }

  Fire.wind = function (map) {
    var st = map ? stateOf(map) : null;
    if (!st) return { x: 1, y: 0, dir: 0, speed: 0.5 };
    return { x: st.windX, y: st.windY, dir: st.windDir, speed: st.windSpeed };
  };

  /* How readily the air carries a fire here, today. A summer afternoon
     is nearly twice a winter morning. */
  function dryness(map, x, y) {
    var temp = temperatureAt(map, x, y);
    var f = 0.55 + (temp - 15) / 45;
    var G = sys('Game');
    if (G && G.season) {
      var s = G.season();
      if (s === 'summer') f *= 1.3;
      else if (s === 'fall') f *= 1.1;
      else if (s === 'winter') f *= 0.7;
    }
    return U.clamp(f, 0.2, 1.9);
  }

  /* One number for the top bar: how close the map is to burning on its
     own. Heat, season and wind, which is exactly what a fire watch
     looks at. */
  Fire.dangerIndex = function (map) {
    if (!map) return 0;
    var st = stateOf(map);
    var G = sys('Game');
    var temp = G && G.outdoorTemp ? G.outdoorTemp() : 20;
    var heat = U.clamp01((temp - 8) / 30);
    var season = 0.5;
    if (G && G.season) {
      var s = G.season();
      season = s === 'summer' ? 1 : (s === 'fall' ? 0.75 : (s === 'spring' ? 0.45 : 0.15));
    }
    return U.clamp01(0.55 * heat + 0.30 * season + 0.15 * st.windSpeed);
  };

  Fire.dangerLabel = function (map) {
    var d = Fire.dangerIndex(map);
    if (d < 0.25) return 'low';
    if (d < 0.45) return 'moderate';
    if (d < 0.65) return 'high';
    if (d < 0.85) return 'severe';
    return 'extreme';
  };

  /* ============================================================
     QUERIES
     ============================================================ */

  Fire.at = function (map, x, y) {
    if (!map || !map.inBounds(x, y)) return null;
    var items = map.items(x, y);
    for (var i = 0; i < items.length; i++) {
      if (items[i].defId === 'fire' && items[i].spawned) return items[i];
    }
    return null;
  };
  Fire.fireAt = Fire.at;

  Fire.fires = function (map) { return map ? map.byDef('fire') : []; };
  Fire.count = function (map) { return map ? map.byDef('fire').length : 0; };
  Fire.any = function (map) { return Fire.count(map) > 0; };

  Fire.smokeAt = function (map, x, y) {
    if (!map || !map.inBounds(x, y)) return 0;
    var st = map.__fire;
    return st ? st.smoke[map.idx(x, y)] / 255 : 0;
  };

  /* Combat asks this through a line: a round fired into a smoke bank
     loses the target. */
  Fire.blocksSight = function (map, x, y) {
    return Fire.smokeAt(map, x, y) >= SMOKE_SIGHT_BLOCK;
  };

  Fire.scorchAt = function (map, x, y) {
    if (!map || !map.inBounds(x, y)) return 0;
    var st = map.__fire;
    return st ? st.scorch[map.idx(x, y)] / 255 : 0;
  };

  Fire.wetAt = function (map, x, y) {
    if (!map || !map.inBounds(x, y)) return 0;
    var st = map.__fire;
    return st ? st.wet[map.idx(x, y)] / 255 : 0;
  };

  Fire.isBurning = function (pawn) { return !!(pawn && pawn.burning && pawn.burning.sev > 0); };

  /* ============================================================
     STARTING FIRES
     ============================================================ */

  Fire.start = function (map, x, y, opts) {
    if (!map || !map.inBounds(x, y)) return null;
    opts = opts || {};
    if (Fire.at(map, x, y)) return null;
    if (map.byDef('fire').length >= FIRE_MAX) return null;

    var terr = map.terrainAt(x, y);
    if (!terr || terr.isWater) return null;

    var st = stateOf(map);
    var i = map.idx(x, y);
    if (st.wet[i] > 40 && !opts.force) return null;

    /* Nothing to take and nothing to keep it: a spark on wet gravel goes
       out, and spawning a fire that despawns next tick is churn. */
    if (!opts.force && Fire.fuelAt(map, x, y) <= 0) return null;

    var fire = map.spawnThing('fire', x, y);
    if (!fire) return null;
    fire.growth = opts.size === undefined ? FIRE_MIN_SIZE : U.clamp01(opts.size);
    fire.hp = fire.def.hp;

    if (!opts.silent) alertFire(map, st, fire, opts);
    return fire;
  };

  /* plants.js called it startFire and combat.js calls that name for an
     explosion, so both spellings answer. */
  Fire.startFire = Fire.start;

  /* Light up whatever this is where it stands: a Thing lights its own
     cell, a pawn catches fire personally. */
  Fire.startFireAt = function (thing, opts) {
    if (!thing) return null;
    var map = thing.map || (root.Game && root.Game.map);
    if (!map) return null;
    if (thing.needs && thing.health) return Fire.ignitePawn(thing, opts && opts.size, opts);
    if (thing.spawned === false) return null;
    return Fire.start(map, thing.x, thing.y, opts);
  };

  /* A pawn on fire. The hediff is what the health tab shows; the panic
     is what makes a burning colonist run through the barracks and set
     the beds alight, which is the single most expensive mistake in the
     game and should feel like one. */
  Fire.ignitePawn = function (pawn, severity, opts) {
    if (!pawn || pawn.dead || !pawn.map) return null;
    opts = opts || {};
    var map = pawn.map;
    var st = stateOf(map);
    var sev = severity === undefined ? U.randRange(0.25, 0.45) : severity;

    if (pawn.burning) {
      pawn.burning.sev = U.clamp01(pawn.burning.sev + sev * 0.5);
      return pawn.burning;
    }
    /* Standing in water is not a thing you can be set on fire in. */
    var terr = map.terrainAt(pawn.x, pawn.y);
    if (terr && terr.isWater) return null;

    pawn.burning = { sev: U.clamp01(sev), ticks: 0 };
    st.burning.push(pawn);

    var H = sys('Health');
    if (H && H.addHediff) H.addHediff(pawn, 'burning', pawn.burning.sev);

    if (!opts.silent && pawn.faction === 'player') {
      msg(nameOf(pawn) + ' is on fire!', { type: 'threat', x: pawn.x, y: pawn.y });
    }

    /* Animals and undrafted colonists bolt. A drafted colonist holds the
       line, because the player told them to and fire is not an argument
       the player loses to. */
    var Th = sys('Think');
    if (Th && Th.startMentalState && !pawn.drafted && !pawn.mentalState && !pawn.downed) {
      if (pawn.isAnimal || U.chance(0.55)) Th.startMentalState(pawn, 'panicFlee');
    }
    return pawn.burning;
  };

  /* Lightning: the way a wildfire actually starts. The bolt itself hurts
     whatever it lands on, then the grass takes it. */
  Fire.lightningStrike = function (map, x, y, opts) {
    if (!map || !map.inBounds(x, y)) return null;
    opts = opts || {};
    var C = sys('Combat');
    if (C && C.explosion) C.explosion(map, x, y, 1.5, 20, 'burn', { instigator: null });
    var lit = Fire.start(map, x, y, { size: 0.35, silent: true, force: true });
    for (var k = 0; k < U.ADJ8.length; k++) {
      if (U.chance(0.5)) Fire.start(map, x + U.ADJ8[k][0], y + U.ADJ8[k][1], { size: 0.2, silent: true });
    }
    if (!opts.silent) {
      msg('Lightning strikes.', { type: 'threat', x: x, y: y });
    }
    return lit;
  };

  /* ============================================================
     WILDFIRE

     A dry season, a hot afternoon and a strike at the edge of the map.
     It starts UPWIND of the colony on purpose: the wind then walks it
     towards you over several minutes, which is time enough to cut a
     break, wet a line or simply decide what you are willing to lose.
     ============================================================ */

  function colonyCentre(map) {
    var list = map.colonists();
    if (!list.length) return { x: map.w >> 1, y: map.h >> 1 };
    var sx = 0, sy = 0;
    for (var i = 0; i < list.length; i++) { sx += list[i].x; sy += list[i].y; }
    return { x: Math.round(sx / list.length), y: Math.round(sy / list.length) };
  }

  Fire.wildfire = function (map, opts) {
    if (!map) return 0;
    opts = opts || {};
    var st = stateOf(map);
    var centre = colonyCentre(map);

    /* Upwind of the colony, out at the edge, on something that will take
       a light. Twenty tries is plenty on any map with grass on it. */
    var best = null;
    for (var attempt = 0; attempt < 24 && !best; attempt++) {
      var dist = Math.max(map.w, map.h) * U.randRange(0.35, 0.48);
      var jitter = U.randRange(-0.6, 0.6);
      var dx = -st.windX * dist + -st.windY * dist * jitter;
      var dy = -st.windY * dist + st.windX * dist * jitter;
      var x = U.clamp(Math.round(centre.x + dx), 1, map.w - 2);
      var y = U.clamp(Math.round(centre.y + dy), 1, map.h - 2);
      if (Fire.fuelAt(map, x, y) > 0.3) best = { x: x, y: y };
    }
    if (!best) return 0;

    var lit = 0;
    Fire.lightningStrike(map, best.x, best.y, { silent: true });
    for (var k = 0; k < (opts.seeds || WILDFIRE_SEEDS); k++) {
      var sx = best.x + U.randInt(-3, 3), sy = best.y + U.randInt(-3, 3);
      if (Fire.start(map, sx, sy, { size: 0.5, silent: true })) lit++;
    }
    if (!lit && !Fire.at(map, best.x, best.y)) return 0;

    st.outbreaks++;
    letter('Wildfire',
      'Lightning has set the scrub alight at the edge of the map, and the wind is carrying ' +
      'it towards the colony. Fire only crosses ground that will burn: a cut line, a stone ' +
      'wall or a strip of bare earth will stop it, and in this wind the line needs to be ' +
      'more than one tile wide.',
      { kind: 'threat', x: best.x, y: best.y });
    return lit;
  };

  function tickWildfireRisk(map, st, now) {
    var G = sys('Game');
    if (!G || !G.day || G.day() < WILDFIRE_MIN_DAY) return;
    if (map.byDef('fire').length) return;          /* one disaster at a time */
    var danger = Fire.dangerIndex(map);
    st.lastDanger = danger;
    if (danger < 0.62) return;
    /* Scaled so an extreme-danger summer averages roughly one wildfire a
       season rather than one an afternoon. */
    if (!U.chance(WILDFIRE_CHANCE * (danger - 0.6) * 2.5)) return;
    Fire.wildfire(map);
  }

  /* ============================================================
     ALERTS

     A fire in the woods is a message. A fire in a room the colony lives
     in is a letter, and the first time it happens it stops the clock,
     because the difference between noticing that and not is the colony.
     ============================================================ */

  function colonyRoom(map, room) {
    var cells = room.cells;
    if (!cells || !cells.length) return false;
    var limit = Math.min(cells.length, ROOM_SCAN_LIMIT);
    for (var i = 0; i < limit; i++) {
      var c = cells[i];
      var b = map.buildingAtIdx ? map.buildingAtIdx(c) : null;
      if (b && b.faction === 'player') return true;
      var pawns = map.pawnsAtIdx(c);
      for (var k = 0; k < pawns.length; k++) {
        if (pawns[k].faction === 'player' && !pawns[k].dead) return true;
      }
    }
    return false;
  }

  function nearColonist(map, x, y, radius) {
    var list = map.colonists();
    for (var i = 0; i < list.length; i++) {
      if (U.cheb(list[i].x, list[i].y, x, y) <= radius) return true;
    }
    return false;
  }

  function alertFire(map, st, fire, opts) {
    var G = sys('Game');
    if (!G) return;
    var now = clockOf(map);
    var room = roomAt(map, fire.x, fire.y);

    if (room && !room.outdoor) {
      if (recently(map, '_fireLetterTick', now, LETTER_COOLDOWN)) return;
      if (colonyRoom(map, room)) {
        map._fireLetterTick = now;
        st.outbreaks++;
        st.alarm = { x: fire.x, y: fire.y, tick: now, indoor: true };
        letter('Fire!',
          'A fire has broken out inside your colony. Firefighting is the highest-priority ' +
          'work there is - anyone who can beat it out will drop what they are doing - but a ' +
          'fire in a wooden building spreads faster than three colonists can put it out, and ' +
          'a sealed room full of flame cooks whoever runs into it.',
          { kind: 'threat', x: fire.x, y: fire.y });

        /* Once per day at most, and only for the room the colony lives
           in: the alarm that is worth a pause is the one you would have
           missed while looking at the other end of the map. */
        var day = G.day ? G.day() : 0;
        if (Fire.autoPause && st.pausedDay !== day && G.setSpeed && (opts && !opts.spread)) {
          st.pausedDay = day;
          G.setSpeed(0);
        }
        return;
      }
    }

    if (recently(map, '_fireMsgTick', now, MSG_COOLDOWN)) return;
    if (!nearColonist(map, fire.x, fire.y, ALERT_RADIUS)) return;
    map._fireMsgTick = now;
    msg('A fire has started.', { type: 'threat', x: fire.x, y: fire.y });
  }

  Fire.alarm = function (map) {
    var st = map ? map.__fire : null;
    if (!st || !st.alarm) return null;
    if (!map.byDef('fire').length) return null;
    return st.alarm;
  };

  /* ============================================================
     THE TICK
     ============================================================ */

  Fire.tick = function (map) {
    if (!map) return;
    var st = stateOf(map);
    var now = clockOf(map);

    tickWind(map, st, now);

    var fires = map.byDef('fire');
    if (fires.length) {
      /* Backwards, because byDef removes with a swap-pop: an entry taken
         out is replaced by one already visited, and fires started by
         this tick's spread are appended past the cursor. */
      for (var i = fires.length - 1; i >= 0; i--) {
        var fire = fires[i];
        if (fire && fire.spawned) tickOneFire(map, st, fire, now);
      }
    } else if (st.alarm && now - st.alarm.tick > 600) {
      st.alarm = null;
    }

    if (st.burning.length) tickBurningPawns(map, st, now);
    if (now % SMOKE_INTERVAL === 0 && st.smokeCells.length) tickSmoke(map, st);
    if (now % HEAT_INTERVAL === 0 && fires.length) tickRoomHeat(map, st, fires, now);
    if (now % SPRINKLER_INTERVAL === 0 && fires.length) tickSprinklers(map, st);
    if (now % DECAY_INTERVAL === 0) tickDecay(map, st);
    if (now % DANGER_INTERVAL === 0) tickWildfireRisk(map, st, now);
  };

  /* plants.js's name for the same loop. */
  Fire.tickFires = Fire.tick;

  function tickOneFire(map, st, fire, now) {
    var x = fire.x, y = fire.y;
    var i = map.idx(x, y);
    var phase = fire.id;

    /* Fuel changes slowly compared to a tick, so it is recomputed on a
       stagger and remembered in between. At three hundred fires that is
       the difference between a frame and a stutter. */
    if (fire._fuel === undefined || (now + phase) % FUEL_RECHECK_INTERVAL === 0) {
      fire._fuel = Fire.fuelAt(map, x, y);
    }
    var fuel = fire._fuel;

    /* Water beats fire, whoever poured it: a sprinkler, a firefighter's
       canister, or the shallows the wind pushed the flame into. */
    if (st.wet[i] > 0) {
      fire.growth -= FIRE_STARVE_PER_TICK * (1 + st.wet[i] / 90);
      if (fire.growth <= 0) { removeFire(map, st, fire); return; }
    } else if (fuel <= 0) {
      fire.growth -= FIRE_STARVE_PER_TICK;
      if (fire.growth <= 0) { removeFire(map, st, fire); return; }
    } else if (fire.growth < 1 && !(fire._fought >= now - 1)) {
      /* A wall of dry grass takes hold faster than a damp shrub, and a
         fire being beaten does not grow this tick - which is what makes
         two colonists on one fire better than one. */
      fire.growth = U.clamp01(fire.growth + FIRE_GROW_PER_TICK * Math.min(2, 0.5 + fuel));
    }

    var size = fire.growth;

    if ((now + phase) % FIRE_DAMAGE_INTERVAL === 0) burnCell(map, st, fire, size);
    if ((now + phase) % FIRE_PAWN_INTERVAL === 0) burnPawns(map, st, x, y, size);
    if ((now + phase) % SMOKE_INTERVAL === 0) {
      addSmoke(map, st, x, y, SMOKE_PER_BEAT * (0.35 + 0.65 * size) * (map.roof[i] ? 1.4 : 0.85));
    }
    if (size >= FIRE_SPREAD_MIN_SIZE && (now + phase) % FIRE_SPREAD_INTERVAL === 0) {
      spreadFire(map, st, fire, size);
    }
  }

  function removeFire(map, st, fire) {
    map.despawnThing(fire);
    /* A fire that burned itself out leaves the ground black behind it. */
    scorch(map, st, fire.x, fire.y, 40);
  }

  /* ---------- what a fire does to the cell it stands on ---------- */

  function burnCell(map, st, fire, size) {
    var x = fire.x, y = fire.y;

    var plant = map.plantAt(x, y);
    if (plant && Fire.flammabilityOf(plant) > 0) {
      plant.damage(Math.max(1, Math.round(PLANT_BURN_DAMAGE * size)));
    }

    var b = map.buildingAt(x, y);
    if (b && Fire.flammabilityOf(b) > 0) {
      /* A building that burns down goes through destroyThing, so its
         leavings land on the floor and the roof it was holding up comes
         down on whatever is underneath. */
      b.damage(Math.max(1, Math.round(BUILDING_BURN_DAMAGE * size)));
    }

    var g = map.ghostAt ? map.ghostAt(x, y) : null;
    if (g && Fire.flammabilityOf(g) > 0) {
      g.damage(Math.max(1, Math.round(BUILDING_BURN_DAMAGE * size)));
    }

    /* Backwards again: an item destroyed here leaves the cell's list. */
    var items = map.items(x, y);
    for (var i = items.length - 1; i >= 0; i--) {
      var it = items[i];
      if (it === fire || Fire.flammabilityOf(it) <= 0) continue;
      var volatileStack = VOLATILE[it.defId] !== undefined ? it.stack : 0;
      var gone = it.damage(Math.max(1, Math.round(ITEM_BURN_DAMAGE * size)));
      if (gone && volatileStack) cookOff(map, x, y, volatileStack);
    }

    /* A wooden floor has no hit points, so it burns through as a roll:
       rare per check, near certain over a long blaze. */
    var terr = map.terrainAt(x, y);
    var ff = floorFlammability(terr);
    if (ff > 0 && U.chance(FLOOR_BURN_CHANCE * ff * size)) map.setTerrain(x, y, 'soil');

    scorch(map, st, x, y, Math.round(6 * size) + 1);
  }

  /* A stack of chemfuel does not burn, it goes off. */
  function cookOff(map, x, y, stack) {
    var C = sys('Combat');
    var radius = U.clamp(1.6 + stack / 22, 1.6, 5.5);
    if (C && C.explosion) C.explosion(map, x, y, radius, 26, 'burn', {});
    var cells = U.cellsInRadius(x, y, Math.round(radius));
    for (var i = 0; i < cells.length; i++) {
      if (U.chance(0.45)) Fire.start(map, cells[i][0], cells[i][1], { size: 0.3, silent: true, spread: true });
    }
    msg('Chemfuel cooks off.', { type: 'threat', x: x, y: y });
  }

  function burnPawns(map, st, x, y, size) {
    var H = sys('Health');
    if (!H || !H.damage) return;

    var here = map.pawnsAt(x, y);
    for (var i = here.length - 1; i >= 0; i--) {
      var pawn = here[i];
      if (pawn.dead) continue;
      H.damage(pawn, {
        amount: Math.max(1, Math.round(PAWN_BURN_BASE + PAWN_BURN_SCALE * size)),
        type: 'burn', source: 'fire'
      });
      if (!pawn.dead && !pawn.burning && U.chance(PAWN_IGNITE_CHANCE * size)) {
        Fire.ignitePawn(pawn, 0.2 + 0.3 * size);
      }
    }

    /* Radiant heat. Standing next to a blaze is not safe either, and a
       colonist beating at a big fire feels it - which is why the
       extinguisher, which lets them work from arm's length, is worth
       fifteen steel. */
    if (size < RADIANT_MIN_SIZE) return;
    for (var k = 0; k < U.ADJ8.length; k++) {
      var nx = x + U.ADJ8[k][0], ny = y + U.ADJ8[k][1];
      if (!map.inBounds(nx, ny)) continue;
      var near = map.pawnsAt(nx, ny);
      for (var n = 0; n < near.length; n++) {
        if (near[n].dead) continue;
        if (!U.chance(0.35 * size)) continue;
        H.damage(near[n], { amount: 1, type: 'burn', source: 'fire' });
      }
    }
  }

  /* ---------- spread ---------- */

  /* Fire radiates in every direction, so every neighbour gets its own
     roll rather than one randomly chosen cell taking all of them. The
     wind decides which of those rolls is worth anything: downwind is
     two and a half times as likely as still air, upwind barely at all,
     and that asymmetry is the whole reason a fire has a front. */
  function spreadFire(map, st, fire, size) {
    var dry = dryness(map, fire.x, fire.y);
    var wind = st.windSpeed;

    for (var k = 0; k < U.ADJ8.length; k++) {
      var dx = U.ADJ8[k][0], dy = U.ADJ8[k][1];
      var x = fire.x + dx, y = fire.y + dy;
      if (!map.inBounds(x, y)) continue;
      if (Fire.at(map, x, y)) continue;

      /* A corner sealed by two walls is sealed. Without this, flame
         leaks diagonally between two wall ends and every room in the
         colony is one bad tile away from the one that is burning. */
      if (dx && dy && !map.passable(fire.x, y) && !map.passable(x, fire.y) &&
          !flammableAt(map, fire.x, y) && !flammableAt(map, x, fire.y)) continue;

      var i = map.idx(x, y);
      if (st.wet[i] > 30) continue;

      var fuel = Fire.fuelAt(map, x, y);
      if (fuel <= 0) continue;

      var align = dx * st.windX + dy * st.windY;
      var mag = Math.sqrt(dx * dx + dy * dy);
      align = mag ? align / mag : 0;
      var windFactor = 1 + wind * (align > 0 ? 1.7 * align : 0.8 * align);

      var chance = FIRE_SPREAD_CHANCE * size * Math.min(1.5, fuel) * dry * windFactor;
      if (chance <= 0 || !U.chance(chance)) continue;
      Fire.start(map, x, y, { silent: true, spread: true });
    }

    castEmbers(map, st, fire, size, dry);
  }

  function flammableAt(map, x, y) {
    if (!map.inBounds(x, y)) return false;
    var b = map.buildingAt(x, y);
    return !!(b && Fire.flammabilityOf(b) > 0);
  }

  /* Embers. A fire that cannot cross the gap in front of it throws
     sparks over it instead, and a single tile of cleared ground stops
     being a firebreak the moment the wind gets up. Three tiles still
     works; that is the lesson, and it costs a wildfire to learn. */
  function castEmbers(map, st, fire, size, dry) {
    if (st.windSpeed < EMBER_MIN_WIND || size < EMBER_MIN_SIZE) return;
    if (!U.chance(EMBER_CHANCE * size * st.windSpeed * dry)) return;

    var range = U.randInt(EMBER_MIN_RANGE, EMBER_MAX_RANGE);
    var spread = U.randRange(-0.45, 0.45);
    var dx = st.windX * range + -st.windY * range * spread;
    var dy = st.windY * range + st.windX * range * spread;
    var x = fire.x + Math.round(dx), y = fire.y + Math.round(dy);
    if (!map.inBounds(x, y) || Fire.at(map, x, y)) return;
    /* An ember that lands under a roof is smothered by it soon enough;
       one that lands on dry grass is a second fire. */
    if (Fire.fuelAt(map, x, y) < 0.35) return;
    Fire.start(map, x, y, { silent: true, spread: true, size: 0.08 });
  }

  /* ============================================================
     BURNING PAWNS
     ============================================================ */

  function tickBurningPawns(map, st, now) {
    var H = sys('Health');
    for (var i = st.burning.length - 1; i >= 0; i--) {
      var pawn = st.burning[i];
      if (!pawn || pawn.dead || pawn.map !== map || !pawn.burning) {
        if (pawn && pawn.burning && (pawn.dead || pawn.map !== map)) clearBurning(pawn);
        st.burning.splice(i, 1);
        continue;
      }
      if ((now + pawn.id) % 12 !== 0) continue;

      var b = pawn.burning;
      b.ticks += 12;
      var idx = map.idx(pawn.x, pawn.y);
      var terr = map.terrainAt(pawn.x, pawn.y);

      /* Water is the one thing that ends it instantly, which is why a
         colony with a pond has an answer and a colony without one has a
         colonist rolling around screaming. */
      if (terr && terr.isWater) {
        extinguishPawnFully(map, st, pawn, i, 'the water');
        continue;
      }
      if (st.wet[idx] > 60) {
        extinguishPawnFully(map, st, pawn, i, 'the spray');
        continue;
      }

      var standingInFire = !!Fire.at(map, pawn.x, pawn.y);
      b.sev = U.clamp01(b.sev + (standingInFire ? 0.02 : -0.004));

      if (H && H.damage) {
        H.damage(pawn, {
          amount: Math.max(1, Math.round(1 + 5 * b.sev)),
          type: 'burn', source: 'fire'
        });
      }
      if (H && H.addHediff) {
        var hd = H.hediff ? H.hediff(pawn, 'burning') : null;
        if (hd) hd.severity = b.sev; else H.addHediff(pawn, 'burning', b.sev);
      }

      /* A person running while alight is a moving ignition source. */
      if (b.sev > 0.25 && U.chance(0.25 * b.sev)) {
        Fire.start(map, pawn.x, pawn.y, { silent: true, spread: true, size: 0.1 });
      }

      if (b.sev <= 0.01) {
        clearBurning(pawn);
        st.burning.splice(i, 1);
      }
    }
  }

  function clearBurning(pawn) {
    pawn.burning = null;
    var H = sys('Health');
    if (H && H.removeHediff) H.removeHediff(pawn, 'burning');
  }

  function extinguishPawnFully(map, st, pawn, index, how) {
    clearBurning(pawn);
    if (index >= 0) st.burning.splice(index, 1);
    if (pawn.faction === 'player' && how) {
      msg(nameOf(pawn) + ' is out, thanks to ' + how + '.', { type: 'good', x: pawn.x, y: pawn.y });
    }
  }

  /* Beating the flames off somebody. Returns true once they are out. */
  Fire.extinguishPawn = function (pawn, amount) {
    if (!pawn || !pawn.burning) return true;
    var map = pawn.map;
    var st = stateOf(map);
    pawn.burning.sev -= (amount === undefined ? 0.02 : amount);
    if (pawn.burning.sev > 0) {
      var H = sys('Health');
      var hd = (H && H.hediff) ? H.hediff(pawn, 'burning') : null;
      if (hd) hd.severity = pawn.burning.sev;
      return false;
    }
    var at = st.burning.indexOf(pawn);
    extinguishPawnFully(map, st, pawn, at, null);
    return true;
  };

  /* ============================================================
     SMOKE

     One byte per cell, and a list of the cells that are not zero. Every
     beat the smoke in a cell loses some to the air and hands the rest
     to its neighbours, weighted downwind. Under a roof it barely
     disperses, so a burning room fills with it; outdoors it is a plume
     that leans, thins and is gone.
     ============================================================ */

  function addSmoke(map, st, x, y, amount) {
    if (!map.inBounds(x, y) || amount <= 0) return;
    var i = map.idx(x, y);
    var v = st.smoke[i] + amount;
    st.smoke[i] = v > 255 ? 255 : v;
    trackCell(st.smokeCells, st.smokeSeen, i);
  }
  Fire.addSmoke = function (map, x, y, amount) { addSmoke(map, stateOf(map), x, y, amount); };

  function smokePasses(map, i) {
    if (map.passableIdx) return map.passableIdx(i);
    return map.passable(map.xOf(i), map.yOf(i));
  }

  function tickSmoke(map, st) {
    if (!st.next) {
      st.next = new Float32Array(map.size);
      st.touchedFlag = new Uint8Array(map.size);
      st.touched = [];
    }
    var next = st.next, flag = st.touchedFlag, touched = st.touched;
    touched.length = 0;

    var cells = st.smokeCells;
    var overCap = cells.length > SMOKE_MAX_CELLS ? 1.8 : 1;
    var w = map.w;

    function give(i, amount) {
      if (amount <= 0) return;
      next[i] += amount;
      if (!flag[i]) { flag[i] = 1; touched.push(i); }
    }

    for (var c = 0; c < cells.length; c++) {
      var i = cells[c];
      var v = st.smoke[i];
      if (v <= 0) continue;

      var roofed = map.roof[i] !== 0;
      var decay = (roofed ? SMOKE_DECAY_INDOOR : SMOKE_DECAY_OUTDOOR + st.windSpeed * 0.22) * overCap;
      var keep = v * (1 - decay);
      var move = keep * (roofed ? SMOKE_MOVE_INDOOR : SMOKE_MOVE_OUTDOOR);
      keep -= move;

      /* Four cardinal neighbours, weighted by how well the wind is
         pushing that way. Smoke does not walk through walls. */
      var total = 0, wt = [0, 0, 0, 0], n = [0, 0, 0, 0];
      for (var k = 0; k < 4; k++) {
        var dx = U.ADJ4[k][0], dy = U.ADJ4[k][1];
        var x = map.xOf(i) + dx, y = map.yOf(i) + dy;
        if (x < 0 || y < 0 || x >= map.w || y >= map.h) { wt[k] = 0; continue; }
        var ni = y * w + x;
        if (!smokePasses(map, ni)) { wt[k] = 0; continue; }
        var align = dx * st.windX + dy * st.windY;
        var weight = 1 + (align > 0 ? align * st.windSpeed * 4 : align * 0.7);
        if (weight < 0.05) weight = 0.05;
        wt[k] = weight; n[k] = ni; total += weight;
      }

      if (total <= 0) { give(i, keep + move); continue; }
      give(i, keep);
      for (var m = 0; m < 4; m++) {
        if (wt[m] <= 0) continue;
        give(n[m], move * (wt[m] / total));
      }
    }

    /* Write back, and rebuild the tracked list from whatever is left. */
    cells.length = 0;
    var seen = st.smokeSeen;
    seen.fill(0);
    for (var t = 0; t < touched.length; t++) {
      var idx = touched[t];
      flag[idx] = 0;
      var val = next[idx];
      next[idx] = 0;
      if (val < SMOKE_MIN) { st.smoke[idx] = 0; continue; }
      st.smoke[idx] = val > 255 ? 255 : val;
      seen[idx] = 1;
      cells.push(idx);
    }

    if (cells.length) chokePawns(map, st);
  }

  /* Anyone standing in it breathes it. It is not fast, and it is not a
     death sentence on its own - but a downed colonist left in a smoke-
     filled room does not get back up. */
  function chokePawns(map, st) {
    var H = sys('Health');
    if (!H || !H.addHediff) return;
    var pawns = map.pawns;
    for (var i = 0; i < pawns.length; i++) {
      var pawn = pawns[i];
      if (pawn.dead || !pawn.isHuman) continue;
      var v = st.smoke[map.idx(pawn.x, pawn.y)] / 255;
      var hd = H.hediff ? H.hediff(pawn, 'smokeInhalation') : null;
      if (v >= SMOKE_CHOKE) {
        H.addHediff(pawn, 'smokeInhalation', CHOKE_PER_BEAT * (0.5 + v));
      } else if (hd) {
        hd.severity -= CHOKE_RECOVER;
        if (hd.severity <= 0.01 && H.removeHediff) H.removeHediff(pawn, 'smokeInhalation');
      }
    }
  }

  /* ============================================================
     HEAT

     Regions owns room temperature and drifts it towards the weather on
     its own beat. Fire pushes against that drift, hard. A big fire in a
     sealed room wins by a couple of hundred degrees, which cooks the
     meals, the colonist who went in for them, and eventually lights
     everything at once.
     ============================================================ */

  function tickRoomHeat(map, st, fires, now) {
    var R = sys('Regions');
    if (!R || !R.roomAt) return;

    var hot = new Map();
    for (var i = 0; i < fires.length; i++) {
      var f = fires[i];
      if (!f.spawned) continue;
      var room = R.roomAt(map, f.x, f.y);
      if (!room || room.outdoor) continue;
      var e = hot.get(room.id);
      if (e) e.heat += f.growth;
      else hot.set(room.id, { room: room, heat: f.growth });
    }
    if (!hot.size) return;

    hot.forEach(function (e) {
      var room = e.room;
      var gain = HEAT_PER_FIRE * e.heat * (NOMINAL_ROOM / Math.max(6, room.size));
      room.temperature = U.clamp(room.temperature + gain, -120, MAX_ROOM_TEMP);
      if (room.temperature > FLASHOVER_TEMP) flashover(map, st, room);
    });

    /* Who is cooking. Reading roomId off the grid per pawn is cheaper
       than walking the cells of a room that might be four hundred tiles. */
    var H = sys('Health');
    if (!H || !H.damage) return;
    var pawns = map.pawns;
    for (var p = pawns.length - 1; p >= 0; p--) {
      var pawn = pawns[p];
      if (pawn.dead) continue;
      var entry = hot.get(map.roomId[map.idx(pawn.x, pawn.y)]);
      if (!entry) continue;
      var t = entry.room.temperature;
      if (t < HEAT_DAMAGE_FROM) continue;
      H.damage(pawn, {
        amount: Math.max(1, Math.round((t - HEAT_DAMAGE_FROM) / 22)),
        type: 'burn', source: 'heat'
      });
      if (!pawn.dead && !pawn.burning && t > 200 && U.chance(0.2)) Fire.ignitePawn(pawn, 0.3);
    }
  }

  /* Flashover: a room hot enough that everything in it reaches its
     ignition point at the same moment. Opening the door on one of these
     is how a colony loses two colonists to a kitchen fire. */
  function flashover(map, st, room) {
    if (!U.chance(FLASHOVER_CHANCE)) return;
    var lit = 0;
    for (var k = 0; k < 6 && lit < 3; k++) {
      var cell = room.cells[U.randInt(0, room.cells.length - 1)];
      if (cell === undefined) break;
      var x = map.xOf(cell), y = map.yOf(cell);
      if (Fire.at(map, x, y)) continue;
      if (Fire.start(map, x, y, { silent: true, spread: true, size: 0.4 })) lit++;
    }
    if (lit && !recently(map, '_flashoverTick', clockOf(map), LETTER_COOLDOWN)) {
      map._flashoverTick = clockOf(map);
      msg('The room flashes over.', { type: 'threat', x: map.xOf(room.cells[0]), y: map.yOf(room.cells[0]) });
    }
  }

  /* ============================================================
     WATER, SCORCH AND DECAY
     ============================================================ */

  function scorch(map, st, x, y, amount) {
    if (!map.inBounds(x, y)) return;
    var i = map.idx(x, y);
    if (!st.scorch[i]) st.scorchCells.push(i);
    var v = st.scorch[i] + amount;
    st.scorch[i] = v > 255 ? 255 : v;
  }
  Fire.scorch = function (map, x, y, amount) { scorch(map, stateOf(map), x, y, amount === undefined ? 60 : amount); };

  Fire.dampen = function (map, x, y, amount) {
    if (!map || !map.inBounds(x, y)) return;
    var st = stateOf(map);
    var i = map.idx(x, y);
    if (!st.wet[i]) st.wetCells.push(i);
    var v = st.wet[i] + (amount === undefined ? 120 : amount);
    st.wet[i] = v > 255 ? 255 : v;
  };

  /* Both grids fade, on the same slow beat, walking only the cells that
     are not already zero. Burned ground takes about six days to come
     back; a wetted floor dries in a few hours. */
  function tickDecay(map, st) {
    var scorchStep = Math.max(1, Math.round(255 / (SCORCH_DAYS * TICKS_PER_DAY / DECAY_INTERVAL)));
    var wetStep = Math.max(1, Math.round(255 / (WET_DAYS * TICKS_PER_DAY / DECAY_INTERVAL)));
    st.scorchCells = fade(st.scorch, st.scorchCells, scorchStep);
    st.wetCells = fade(st.wet, st.wetCells, wetStep);
  }

  function fade(grid, cells, step) {
    var out = [];
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var v = grid[c] - step;
      if (v <= 0) { grid[c] = 0; continue; }
      grid[c] = v;
      out.push(c);
    }
    return out;
  }

  /* ============================================================
     EXTINGUISHING
     ============================================================ */

  /* The contract's shape is (map, x, y). The shape plants.js used was
     (map, fireThing, amount) and returned whether it was out, so both
     are answered: a Thing in the second slot means the old call. */
  Fire.extinguish = function (map, x, y, pawn) {
    if (!map) return false;
    if (x && typeof x === 'object') return Fire.extinguishWork(map, x, y, pawn);
    var fire = Fire.at(map, x, y);
    if (!fire) return false;
    var st = stateOf(map);
    removeFire(map, st, fire);
    Fire.dampen(map, x, y, 80);
    return true;
  };

  /* Beating a fire down, in work units of size per tick. Returns true
     the moment it is out. */
  Fire.extinguishWork = function (map, fire, amount, pawn) {
    if (!fire || !fire.spawned) return true;
    var st = stateOf(map);
    var now = clockOf(map);
    fire._fought = now;

    var work = amount === undefined ? EXTINGUISH_PER_TICK : amount;
    if (pawn && pawn._fireCharge > 0) {
      pawn._fireCharge--;
      work *= EXTINGUISHER_FACTOR;
    } else if (pawn && fire.growth > 0.5 && U.chance(FIREFIGHTER_CATCH_CHANCE * fire.growth)) {
      /* Bare hands against a blaze. This is what the canister is for. */
      Fire.ignitePawn(pawn, 0.2);
    }

    fire.growth -= work;
    if (fire.growth > 0) return false;

    removeFire(map, st, fire);
    /* A beaten fire leaves the cell wet enough not to relight from its
       neighbour the moment the colonist turns their back. */
    Fire.dampen(map, fire.x, fire.y, 70);
    return true;
  };

  /* Everything in a radius, at once: what a sprinkler does, and the hook
     an ability or a bucket of water would use. */
  Fire.douse = function (map, x, y, radius, power) {
    if (!map) return 0;
    var st = stateOf(map);
    var cells = U.cellsInRadius(x, y, radius);
    var out = 0;
    for (var i = 0; i < cells.length; i++) {
      var cx = cells[i][0], cy = cells[i][1];
      if (!map.inBounds(cx, cy)) continue;
      Fire.dampen(map, cx, cy, 45);
      var fire = Fire.at(map, cx, cy);
      if (!fire) continue;
      fire._fought = clockOf(map);
      fire.growth -= (power === undefined ? SPRINKLER_POWER_MIN : power);
      if (fire.growth <= 0) { removeFire(map, st, fire); out++; }
    }
    return out;
  };

  /* ---------- sprinklers ---------- */

  function tickSprinklers(map, st) {
    var list = map.byDef('fireSprinkler');
    if (!list.length) return;
    var P = sys('Power');
    var R = sys('Regions');

    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s.spawned) continue;
      if (P && P.isPowered && !P.isPowered(s)) continue;

      /* A head only fires for its own room, so a sprinkler indoors does
         not waste itself on the grass fire out of the window. */
      var room = R && R.roomAt ? R.roomAt(map, s.x, s.y) : null;
      var fired = false;
      var cells = U.cellsInRadius(s.x, s.y, SPRINKLER_RADIUS);
      for (var c = 0; c < cells.length; c++) {
        var x = cells[c][0], y = cells[c][1];
        if (!map.inBounds(x, y)) continue;
        var fire = Fire.at(map, x, y);
        if (!fire) continue;
        if (room && R.roomAt(map, x, y) !== room) continue;
        fire._fought = clockOf(map);
        fire.growth -= SPRINKLER_POWER_MIN;
        Fire.dampen(map, x, y, 60);
        if (fire.growth <= 0) removeFire(map, st, fire);
        fired = true;
      }
      if (fired && room) {
        /* Wet the room it protects, so what it put out stays out. */
        for (var k = 0; k < cells.length; k++) {
          if (map.inBounds(cells[k][0], cells[k][1])) Fire.dampen(map, cells[k][0], cells[k][1], 12);
        }
      }
    }
  }

  /* ---------- extinguishers ---------- */

  function chargesOf(thing) {
    if (!thing) return 0;
    if (thing.charges === undefined) thing.charges = EXTINGUISHER_CHARGES;
    return thing.charges;
  }
  Fire.chargesOf = chargesOf;

  Fire.extinguishers = function (map) { return map ? map.byDef('fireExtinguisher') : []; };

  /* ============================================================
     FIREBREAK PLANNING

     One call that designates the flammable ring around a point for
     cutting. A player can do it by hand with a drag; doing it by hand
     while the treeline is already alight is how colonies burn down.
     ============================================================ */

  Fire.designateFirebreak = function (map, x, y, opts) {
    if (!map) return 0;
    opts = opts || {};
    var inner = opts.inner === undefined ? 5 : opts.inner;
    var outer = opts.outer === undefined ? inner + 2 : opts.outer;
    var n = 0;
    for (var cy = y - outer; cy <= y + outer; cy++) {
      for (var cx = x - outer; cx <= x + outer; cx++) {
        if (!map.inBounds(cx, cy)) continue;
        var d = U.cheb(cx, cy, x, y);
        if (d < inner || d > outer) continue;
        var plant = map.plantAt(cx, cy);
        if (!plant || Fire.flammabilityOf(plant) <= 0) continue;
        var isTree = !!(plant.def.plant && plant.def.plant.isTree);
        var type = isTree ? 'chop' : 'cut';
        if (map.designationAt(cx, cy, type)) continue;
        map.designate(cx, cy, type);
        n++;
      }
    }
    if (n) msg('Firebreak marked: ' + n + ' plants to clear.', { type: 'info', x: x, y: y });
    return n;
  };

  /* ============================================================
     JOBS

     Three of them, all new: nothing here re-registers a job another
     file owns. The beat-out job itself stays where the contract put it
     and calls Fire.extinguishWork through plants.js.
     ============================================================ */

  var Jobs = root.Jobs, Toils = root.Toils, T = root.T, Res = root.Res, Path = root.Path;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  function targetThing(job, which, map) {
    var t = job['target' + which];
    return (t && T) ? T.resolve(t, map) : null;
  }

  function workFactor(pawn) {
    var H = sys('Health');
    var f = (H && H.workSpeedFactor) ? H.workSpeedFactor(pawn) : 1;
    return Math.max(0.2, f);
  }

  if (Jobs && Toils && T) {

    /* Beat the flames off a person. Adjacent, not on top of them: the
       helper is not standing in the fire, they are smothering it. */
    Jobs.register('extinguishPawn', {
      label: 'put out colonist',
      suspendable: false,
      alwaysShow: true,
      reportString: function (job, pawn) {
        var t = targetThing(job, 'A', pawn && pawn.map);
        return 'Putting out ' + (t ? nameOf(t) : 'someone');
      },
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true, avoidFire: true }),
          Toils.custom({
            name: 'beatPawnFire',
            tick: function (pawn, job) {
              var victim = targetThing(job, 'A', pawn.map);
              if (!victim || victim.dead || !victim.burning) { job.workLeft = 0; return 'done'; }
              if (U.cheb(pawn.x, pawn.y, victim.x, victim.y) > 1) return 'fail';
              var rate = 0.012 * workFactor(pawn) * (pawn._fireCharge > 0 ? 3 : 1);
              if (pawn._fireCharge > 0) pawn._fireCharge--;
              var out = Fire.extinguishPawn(victim, rate);
              job.workLeft = out ? 0 : Math.ceil(victim.burning.sev / rate);
              return out ? 'done' : 'stay';
            },
            end: function (pawn, job) { job.workLeft = 0; }
          })
        ];
      }
    });

    /* Grab a canister on the way. The charge rides on the pawn and is
       spent by whatever beating they do next, whoever gave them the job. */
    Jobs.register('takeExtinguisher', {
      label: 'take extinguisher',
      suspendable: false,
      reportString: function () { return 'Fetching a fire extinguisher'; },
      toils: function () {
        return [
          Toils.reserve('A'),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true, avoidFire: true }),
          Toils.wait(20),
          Toils.custom({
            name: 'takeCharge',
            tick: function (pawn, job) {
              var thing = targetThing(job, 'A', pawn.map);
              if (!thing || !thing.spawned || chargesOf(thing) <= 0) return 'fail';
              thing.charges = chargesOf(thing) - 1;
              pawn._fireCharge = EXTINGUISHER_USES_PER_CHARGE;
              return 'done';
            }
          })
        ];
      }
    });

    /* And put it back together afterwards. Work, not materials: a
       canister needs repressurising, and that is somebody's afternoon. */
    Jobs.register('refillExtinguisher', {
      label: 'refill extinguisher',
      reportString: function () { return 'Refilling a fire extinguisher'; },
      toils: function () {
        return [
          Toils.reserve('A'),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.work({
            name: 'refillWork',
            skill: 'construction',
            failIfGone: true,
            amount: function () { return EXTINGUISHER_REFILL_WORK; },
            onTick: function (pawn, job, s) { job.workLeft = Math.max(0, s.total - s.done); },
            onDone: function (pawn, job) {
              var thing = targetThing(job, 'A', pawn.map);
              if (!thing || !thing.spawned) return 'fail';
              thing.charges = EXTINGUISHER_CHARGES;
              job.workLeft = 0;
              return 'done';
            }
          })
        ];
      }
    });
  }

  /* ============================================================
     WORK GIVERS

     workgivers.js owns the ordinary beat-out scan and the emergency
     path. These three are what it has no way to know about: a person
     alight, a canister worth the detour, and the response to a fire
     that is eating the colony from the far side of the map.
     ============================================================ */

  var WorkGivers = root.WorkGivers;

  function reachable(map, pawn, x, y) {
    var R = sys('Regions');
    if (!R || !R.areaOf) return true;
    var from = R.areaOf(map, pawn.x, pawn.y);
    if (!from) return true;
    if (R.areaOf(map, x, y) === from) return true;
    if (map.passable(x, y)) return false;
    for (var k = 0; k < U.ADJ8.length; k++) {
      if (R.areaOf(map, x + U.ADJ8[k][0], y + U.ADJ8[k][1]) === from) return true;
    }
    return false;
  }

  /* How many colonists are already on this fire, counted from their
     jobs rather than kept in a table that could go stale. */
  function crewOn(map, fire) {
    var n = 0;
    var list = map.colonists();
    for (var i = 0; i < list.length; i++) {
      var job = list[i].job;
      if (!job || !job.targetA) continue;
      if (job.defId !== 'extinguishFire' && job.defId !== 'extinguishPawn') continue;
      if (job.targetA.id === fire.id) n++;
    }
    return n;
  }

  /* Inside the colony rather than out in the woods. A grass fire forty
     tiles away is weather; a fire against a wall is an emergency. */
  function threatensColony(map, fire) {
    var room = roomAt(map, fire.x, fire.y);
    if (room && room.id > 0 && !room.outdoor) return true;
    for (var k = 0; k < U.ADJ8.length; k++) {
      var x = fire.x + U.ADJ8[k][0], y = fire.y + U.ADJ8[k][1];
      if (!map.inBounds(x, y)) continue;
      var b = map.buildingAt(x, y);
      if (b && b.faction === 'player' && !b.isBlueprint) return true;
      if (map.zoneId && map.zoneId[map.idx(x, y)]) return true;
    }
    return false;
  }

  if (WorkGivers && WorkGivers.register && Jobs && T && Res) {

    WorkGivers.register({
      id: 'firePawnAblaze', workType: 'firefight', order: 4,
      label: 'put out a burning colonist',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        var st = map.__fire;
        if (!st || !st.burning.length) return null;
        if (pawn.burning) return null;            /* deal with yourself first */
        for (var i = 0; i < st.burning.length; i++) {
          var victim = st.burning[i];
          if (!victim || victim.dead || victim === pawn) continue;
          if (victim.faction !== 'player') continue;
          if (U.dist(pawn.x, pawn.y, victim.x, victim.y) > 30) continue;
          if (!reachable(map, pawn, victim.x, victim.y)) continue;
          if (!Res.canReserve(pawn, T.pawn(victim), 1)) continue;
          if (!Res.reserve(pawn, T.pawn(victim), 1)) continue;
          var job = Jobs.make('extinguishPawn', T.pawn(victim), null, {});
          if (job) return job;
          Res.release(pawn, T.pawn(victim));
        }
        return null;
      }
    });

    WorkGivers.register({
      id: 'fireTakeExtinguisher', workType: 'firefight', order: 6,
      label: 'take a fire extinguisher',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        if (pawn._fireCharge > 0) return null;
        var fires = map.byDef('fire');
        if (!fires.length) return null;

        /* Only worth the detour if there is a fire worth fighting and a
           charged canister that is not miles away. */
        var worth = false;
        for (var f = 0; f < fires.length; f++) {
          if (U.dist(pawn.x, pawn.y, fires[f].x, fires[f].y) > RESPONSE_RADIUS) continue;
          if (fires[f].growth > 0.3 || threatensColony(map, fires[f])) { worth = true; break; }
        }
        if (!worth) return null;

        var list = map.byDef('fireExtinguisher');
        var best = null, bestD = 24;
        for (var i = 0; i < list.length; i++) {
          var e = list[i];
          if (!e.spawned || chargesOf(e) <= 0) continue;
          var d = U.dist(pawn.x, pawn.y, e.x, e.y);
          if (d >= bestD) continue;
          if (!reachable(map, pawn, e.x, e.y)) continue;
          if (!Res.canReserve(pawn, T.thing(e), 1)) continue;
          best = e; bestD = d;
        }
        if (!best) return null;
        if (!Res.reserve(pawn, T.thing(best), 1)) return null;
        var job = Jobs.make('takeExtinguisher', T.thing(best), null, {});
        if (!job) Res.release(pawn, T.thing(best));
        return job;
      }
    });

    /* The colony is burning and you are on the other side of the map.
       workgivers.js stops at forty-eight tiles for an ordinary fire;
       this one has no such limit, because a fire in the storeroom is
       not an ordinary fire. */
    WorkGivers.register({
      id: 'fireColonyResponse', workType: 'firefight', order: 8,
      label: 'fight a fire in the colony',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        if (!Jobs.isRegistered || !Jobs.isRegistered('extinguishFire')) return null;
        var fires = map.byDef('fire');
        if (!fires.length) return null;

        var best = null, bestScore = -1e9;
        for (var i = 0; i < fires.length; i++) {
          var fire = fires[i];
          if (!fire.spawned) continue;
          if (!threatensColony(map, fire)) continue;
          var d = U.dist(pawn.x, pawn.y, fire.x, fire.y);
          if (d > RESPONSE_RADIUS) continue;
          if (crewOn(map, fire) >= CREW_MAX) continue;
          if (!reachable(map, pawn, fire.x, fire.y)) continue;
          var score = fire.growth * 8 - d;
          if (score > bestScore) { best = fire; bestScore = score; }
        }
        return best ? Jobs.make('extinguishFire', T.thing(best), null, {}) : null;
      }
    });

    WorkGivers.register({
      id: 'fireRefillExtinguisher', workType: 'basic', order: 70,
      label: 'refill a fire extinguisher',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        if (map.byDef('fire').length) return null;   /* not while it is still burning */
        var list = map.byDef('fireExtinguisher');
        for (var i = 0; i < list.length; i++) {
          var e = list[i];
          if (!e.spawned || chargesOf(e) >= EXTINGUISHER_CHARGES) continue;
          if (!reachable(map, pawn, e.x, e.y)) continue;
          if (!Res.reserve(pawn, T.thing(e), 1)) continue;
          var job = Jobs.make('refillExtinguisher', T.thing(e), null, {});
          if (job) return job;
          Res.release(pawn, T.thing(e));
        }
        return null;
      }
    });
  }

  /* An emergency answer of Fire's own, for a think tree that wants to
     ask the fire system directly rather than through the work columns. */
  Fire.emergencyJob = function (pawn) {
    if (!WorkGivers || !pawn || !pawn.map || pawn.dead || pawn.downed) return null;
    var giver = WorkGivers.get && WorkGivers.get('firePawnAblaze');
    return giver ? giver.tryGiveJob(pawn) : null;
  };

  /* ============================================================
     SAVE

     The fires themselves are Things, so map.js and save.js already
     carry them; so are the burning flags, which live in plain fields on
     the pawn. What is left is three byte grids and the weather, and
     they run-length encode to almost nothing because they are mostly
     zero.
     ============================================================ */

  function rle(grid) {
    var runs = [], last = grid[0], n = 0;
    for (var i = 0; i < grid.length; i++) {
      if (grid[i] === last) { n++; continue; }
      runs.push(last, n);
      last = grid[i]; n = 1;
    }
    if (grid.length) runs.push(last, n);
    return runs;
  }

  function unrle(runs, grid) {
    var at = 0;
    for (var i = 0; i < runs.length; i += 2) {
      var v = runs[i], n = runs[i + 1];
      for (var k = 0; k < n && at < grid.length; k++) grid[at++] = v;
    }
    return grid;
  }

  function rebuildIndex(grid) {
    var out = [];
    for (var i = 0; i < grid.length; i++) if (grid[i]) out.push(i);
    return out;
  }

  Fire.save = function () {
    var map = root.Game && root.Game.map;
    if (!map || !map.__fire) return null;
    var st = map.__fire;
    return {
      w: map.w, h: map.h,
      smoke: rle(st.smoke), scorch: rle(st.scorch), wet: rle(st.wet),
      windDir: st.windDir, windTargetDir: st.windTargetDir, windSpeed: st.windSpeed,
      alarm: st.alarm, outbreaks: st.outbreaks, pausedDay: st.pausedDay,
      autoPause: Fire.autoPause
    };
  };

  Fire.load = function (obj) {
    var map = root.Game && root.Game.map;
    if (!map) return false;
    var st = stateOf(map);
    if (!obj) return false;
    if (obj.w !== map.w || obj.h !== map.h) return false;

    if (obj.smoke) unrle(obj.smoke, st.smoke);
    if (obj.scorch) unrle(obj.scorch, st.scorch);
    if (obj.wet) unrle(obj.wet, st.wet);
    st.smokeCells = rebuildIndex(st.smoke);
    st.smokeSeen.fill(0);
    for (var i = 0; i < st.smokeCells.length; i++) st.smokeSeen[st.smokeCells[i]] = 1;
    st.scorchCells = rebuildIndex(st.scorch);
    st.wetCells = rebuildIndex(st.wet);

    st.windDir = obj.windDir || 0;
    st.windTargetDir = obj.windTargetDir === undefined ? st.windDir : obj.windTargetDir;
    st.windSpeed = obj.windSpeed === undefined ? 0.5 : obj.windSpeed;
    st.windX = Math.cos(st.windDir);
    st.windY = Math.sin(st.windDir);
    st.alarm = obj.alarm || null;
    st.outbreaks = obj.outbreaks || 0;
    st.pausedDay = obj.pausedDay === undefined ? -1 : obj.pausedDay;
    if (obj.autoPause !== undefined) Fire.autoPause = !!obj.autoPause;

    /* Who is on fire is stored on the pawns; the live list is rebuilt
       from them rather than saved twice and allowed to disagree. */
    st.burning.length = 0;
    for (var p = 0; p < map.pawns.length; p++) {
      var pawn = map.pawns[p];
      if (pawn.burning && pawn.burning.sev > 0 && !pawn.dead) st.burning.push(pawn);
      else if (pawn.burning) pawn.burning = null;
    }
    return true;
  };

  /* A one-line summary for an inspect panel or a debug overlay. */
  Fire.summary = function (map) {
    if (!map) return 'no map';
    var st = stateOf(map);
    return map.byDef('fire').length + ' fires, ' + st.burning.length + ' burning, ' +
      st.smokeCells.length + ' smoke cells, danger ' + Fire.dangerLabel(map);
  };

  root.Fire = Fire;
})(this);
