/* ============================================================
   plants.js - growth, sowing, harvest, wild spread and fire.

   Four ideas hold this file together.

   1. Plants are the most numerous thing on the map and the slowest
      moving, so nothing here runs every tick. Plants.tickSlice walks the
      plant list a few entries at a time and gives each plant a tickRare
      roughly every 250 ticks; every rate in this file is therefore
      quoted per tick and multiplied by however many ticks have actually
      elapsed since that plant was last looked at. Nothing assumes the
      cadence it is called at, so a caller may tick a plant more often,
      less often or twice in one tick and get the same growth. The clock
      is map.tickCount rather than Game.tick, for the same reason map.js
      ages rot on it: a map ticking in a test without a Game around it
      must still grow its crops.

   2. Growth is one multiplier, built from the cell. Fertility, light
      and temperature each independently gate it - below minLightToGrow
      or outside the temperature band nothing grows at all - and what
      survives that is a rate, not a yes/no. That is what makes rich
      soil worth clearing, a sun lamp worth its power draw, and a
      winter without a stockpile fatal.

   3. Harvesting is where value comes out of a plant and cutting is
      where it does not. A crop comes up whole; a berry bush is picked
      and left standing; a felled tree pays in wood whatever the
      grower's skill, because skill decides how fast a tree comes down,
      not how much of it is wood. Only the fiddly work of picking a
      crop can be fumbled, and that is the skill roll in yieldFactor.

   4. Fire is the one thing in here that runs every tick, because a
      fire that thought about spreading four seconds from now would not
      be frightening. It is deliberately cheap: a fire is a Thing on the
      item grid, it keeps its size in `growth` so save.js round-trips it
      for free, and the expensive questions - what is next to me, whose
      room am I in - are asked on staggered intervals keyed off the
      fire's own id so a burning forest never spikes one tick.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  var Plants = {};

  /* ---------- growth ---------- */

  /* The beat the plant list is walked on, and the assumed elapsed time
     for a plant nobody has looked at before. */
  var RARE_INTERVAL = 250;

  /* Growth falls off over the last few degrees at each end of a plant's
     temperature band rather than stopping dead at the boundary, so a
     cold snap slows a field before it stops it and the player gets a
     harvest that is visibly late instead of one that simply froze. */
  var TEMP_TAPER = 6;

  /* How long a frost-sensitive crop survives outside its band. Half a
     day of frost, measured net of the time it spends growing: an
     ordinary cold night in early spring costs a field some growth and
     no more, while a cold snap that holds a colony below freezing for a
     day takes the crop. Heat is tighter because nothing reaches 58C
     except a heat wave or the inside of a fire, and neither is
     survivable. */
  var COLD_DEATH_TICKS = 30000;
  var HEAT_DEATH_TICKS = 20000;

  /* Blight rots a crop out over about four fifths of a day, which is
     roughly one working day to cut the field down and re-sow it. */
  var BLIGHT_DEATH_TICKS = 48000;
  /* Per rare tick, per blighted plant, at one neighbour. A plant only
     lives about 190 rare ticks once blighted, so this keeps the infection
     just under self-sustaining: a blight takes a bite out of a field and
     burns out, and cutting early is what decides how big the bite is. */
  var BLIGHT_SPREAD_CHANCE = 0.0025;

  /* One "your crops are freezing" per in-game hour, not one per plant. */
  var CROP_LOSS_COOLDOWN = 2500;

  /* Wild seeding, per tick, before the per-def slowdown. A mature plant
     rolls this about 0.3 times a day; the density cap below is what
     actually decides whether the roll can land. */
  var SPREAD_BASE = 0.0000048;
  var SPREAD_CHECK_RADIUS = 4;
  var SPREAD_MIN_GROWTH = 0.55;

  /* ---------- fire ---------- */

  var FIRE_MIN_SIZE = 0.05;
  var FIRE_GROW_PER_TICK = 0.0022;      /* a new fire is full size in ~7 seconds */
  var FIRE_STARVE_PER_TICK = 0.006;     /* and gutters out in under three once the fuel is gone */
  var FIRE_DAMAGE_INTERVAL = 15;
  var FIRE_SPREAD_INTERVAL = 30;
  var FIRE_PAWN_INTERVAL = 60;
  var FIRE_SPREAD_MIN_SIZE = 0.2;
  /* Per neighbour, per spread check, at full size on ideal fuel. Eight
     neighbours roll it, so the number that matters is eight times this. */
  var FIRE_SPREAD_CHANCE = 0.14;
  var PLANT_BURN_DAMAGE = 4;
  var ITEM_BURN_DAMAGE = 3;
  var BUILDING_BURN_DAMAGE = 2.2;
  var FLOOR_BURN_CHANCE = 0.004;
  var EXTINGUISH_PER_TICK = 0.0045;

  /* One letter per fire outbreak, not one per flame; and a message at
     most every ten seconds for the fires that never reach a room. */
  var FIRE_LETTER_COOLDOWN = 2500;
  var FIRE_MSG_COOLDOWN = 600;
  var FIRE_ALERT_RADIUS = 14;
  var ROOM_SCAN_LIMIT = 600;

  /* How flammable a building or an item is once it is made of
     something. A stone wall is fireproof and a wooden one is not, and
     that difference is most of what stonecutting is for. */
  var STUFF_FLAMMABILITY = {
    wood: 1, cloth: 1, leather: 0.6, steel: 0, stoneBlocks: 0
  };
  var DEFAULT_FLAMMABILITY = 0.6;

  /* ---------- small shared helpers ---------- */

  function sys(name) { return root[name] || null; }

  /* The plant clock. map.tick() runs once per game tick, so this tracks
     Game.tick exactly while also working in a headless map test. */
  function clockOf(map) { return map ? (map.tickCount | 0) : 0; }

  /* Whether an alert of this kind was posted recently enough to skip
     this one. The stamp lives on the map, so a new colony is never
     silenced by how far the last one's clock had run; a stamp the map's
     own clock has not reached yet belongs to that other colony. */
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

  function plantDefOf(thing) {
    if (!thing) return null;
    var def = thing.def || Defs.maybe('thing', thing.defId);
    return (def && def.plant) ? def : null;
  }

  function labelOf(def) { return (def && def.label) || (def && def.id) || 'plant'; }

  function skillLevel(pawn, id) {
    if (!pawn) return 0;
    if (typeof pawn.skillLevel === 'function') return pawn.skillLevel(id) || 0;
    var s = pawn.skills && pawn.skills[id];
    return s ? (s.level || 0) : 0;
  }

  function zoneAt(map, x, y) {
    var Z = sys('Zones');
    return (Z && Z.zoneAt) ? Z.zoneAt(map, x, y) : null;
  }

  function growingZoneAt(map, x, y) {
    var z = zoneAt(map, x, y);
    return (z && z.kind === 'growing') ? z : null;
  }

  function roomAt(map, x, y) {
    var R = sys('Regions');
    return (R && R.roomAt) ? R.roomAt(map, x, y) : null;
  }

  Plants.temperatureAt = function (map, x, y) {
    if (map && map.temperatureAt) return map.temperatureAt(x, y);
    var G = sys('Game');
    return (G && G.outdoorTemp) ? G.outdoorTemp() : 20;
  };

  /* Light is power.js's answer when it is loaded, because only it knows
     about sun lamps. Without it, a roof is the difference between
     daylight and a dim shed - which is enough to stop a crop. */
  Plants.lightAt = function (map, x, y) {
    var P = sys('Power');
    if (P && P.lightAt) return P.lightAt(map, x, y);
    var G = sys('Game');
    var day = (G && G.daylight) ? G.daylight() : 1;
    if (map && map.hasRoofAt && map.hasRoofAt(x, y)) return day * 0.25;
    return day;
  };

  /* ============================================================
     GROWTH
     ============================================================ */

  Plants.growthRateAt = function (map, x, y, def, temperature, light) {
    var p = def && def.plant;
    if (!p || !map || !map.inBounds(x, y)) return 0;

    if (temperature === undefined || temperature === null) {
      temperature = Plants.temperatureAt(map, x, y);
    }
    if (light === undefined || light === null) light = Plants.lightAt(map, x, y);

    var terr = map.terrainAt(x, y);
    if (!terr || terr.supportsPlants === false) return 0;
    var fert = terr.fertility || 0;
    if (fert < p.minFertility) return 0;

    /* The def's own sentence: growth multiplies by
       1 + (fertility - 1) * sensitivity. Potatoes barely notice rich
       soil; rice ripens 40% faster in it. */
    var rate = 1 + (fert - 1) * p.fertilitySensitivity;
    if (rate <= 0) return 0;

    if (light < p.minLightToGrow) return 0;
    if (temperature <= p.minGrowthTemp || temperature >= p.maxGrowthTemp) return 0;

    var margin = Math.min(temperature - p.minGrowthTemp, p.maxGrowthTemp - temperature);
    if (margin < TEMP_TAPER) rate *= margin / TEMP_TAPER;

    return rate > 0 ? rate : 0;
  };

  /* Ticks since this plant was last considered. A plant nobody has seen
     before - freshly sown, or freshly loaded - is assumed to have been
     waiting one rare beat, and a long pause (a save left on the shelf,
     a slice that wrapped late) is capped so nothing ripens in one jump. */
  function elapsedSince(map, plant) {
    var now = clockOf(map);
    var last = plant._growTick;
    plant._growTick = now;
    if (last === undefined || last > now) return RARE_INTERVAL;
    var d = now - last;
    if (d <= 0) return 0;
    return d > RARE_INTERVAL * 8 ? RARE_INTERVAL * 8 : d;
  }

  /* The per-tick entry point for one plant. Everything real happens on
     the rare beat, staggered by the plant's own id so a thousand plants
     spread their work across the period instead of landing on one tick.
     Calling it more often than that is free, and calling it twice in one
     tick does nothing the second time: tickRare measures the elapsed
     ticks itself rather than assuming a cadence. */
  Plants.tick = function (map, plant) {
    if (!map || !plant || !plant.spawned) return;
    if ((clockOf(map) + plant.id) % RARE_INTERVAL !== 0) return;
    Plants.tickRare(map, plant);
  };

  /* The whole-map version, and the one a caller should prefer: a rolling
     slice that visits every plant once per RARE_INTERVAL, a handful per
     tick, so a map carrying twenty thousand plants costs what a map
     carrying twenty does.

     The list is rebuilt when the cursor reaches its end rather than
     being kept forever, because plants are created constantly - sown,
     seeded, regrown after a harvest - and a cached list that is never
     refilled is a list in which nothing planted after the first tick
     ever grows. A plant that appears mid-pass joins on the next one,
     which costs it at most a quarter of a second of game time. */
  Plants.tickSlice = function (map) {
    if (!map) return 0;
    var st = map._plantSlice;
    if (!st) { st = map._plantSlice = { list: [], cursor: 0 }; }
    if (st.cursor >= st.list.length) refillSlice(map, st);

    var n = st.list.length;
    if (!n) return 0;

    var per = Math.ceil(n / RARE_INTERVAL);
    var done = 0;
    for (var k = 0; k < per && st.cursor < n; k++) {
      var plant = st.list[st.cursor++];
      /* Stale entries are normal: a plant burned down or harvested since
         the list was built is simply skipped. */
      if (plant && plant.spawned) { Plants.tickRare(map, plant); done++; }
    }
    return done;
  };

  function refillSlice(map, st) {
    var defs = Defs.plants();
    var list = st.list;
    list.length = 0;
    for (var i = 0; i < defs.length; i++) {
      var of = map.byDef(defs[i].id);
      for (var j = 0; j < of.length; j++) list.push(of[j]);
    }
    st.cursor = 0;
  }

  Plants.tickRare = function (map, plant) {
    if (!map || !plant || !plant.spawned) return;
    var def = plantDefOf(plant);
    if (!def) return;
    var p = def.plant;

    var elapsed = elapsedSince(map, plant);
    if (elapsed <= 0) return;
    plant.plantAgeTicks = (plant.plantAgeTicks || 0) + elapsed;

    if (plant.blighted) { tickBlight(map, plant, elapsed); return; }

    var x = plant.x, y = plant.y;
    var temp = Plants.temperatureAt(map, x, y);
    var light = Plants.lightAt(map, x, y);
    var rate = Plants.growthRateAt(map, x, y, def, temp, light);

    if (rate > 0) {
      if (plant.growth < 1) {
        plant.growth = U.clamp01(plant.growth + (elapsed / p.growTicks) * rate);
      }
      /* Time in the growing band pays off the exposure the plant took:
         a night below freezing is survivable, a week of nights is not. */
      plant._stress = U.approach(plant._stress || 0, 0, elapsed);
    } else if (temp <= p.minGrowthTemp || temp >= p.maxGrowthTemp) {
      if (killByTemperature(map, plant, def, temp, elapsed)) return;
    }

    if (dieOfOldAge(map, plant, p, elapsed)) return;
    trySpread(map, plant, def, elapsed);
  };

  /* Only crops flagged dieIfLeafless are killed by cold: a rule that
     killed trees as well would wipe a boreal forest every winter, which
     is a forest reset rather than a game. Heat past maxGrowthTemp kills
     anything, because 58C only happens inside a heat wave or a fire.

     Exposure is signed - negative for cold, positive for heat - so a
     pine that stood through four months of winter does not arrive at the
     first hot afternoon already at death's door. Swapping direction
     starts the count again from zero. */
  function killByTemperature(map, plant, def, temp, elapsed) {
    var p = def.plant;
    var cold = temp <= p.minGrowthTemp;
    if (cold && !p.dieIfLeafless) { plant._stress = 0; return false; }

    var dir = cold ? -1 : 1;
    var stress = plant._stress || 0;
    if (stress * dir < 0) stress = 0;
    stress += dir * elapsed;
    plant._stress = stress;

    if (Math.abs(stress) < (cold ? COLD_DEATH_TICKS : HEAT_DEATH_TICKS)) return false;
    if (plant.sown) noteCropLoss(map, plant, cold);
    killPlant(map, plant, cold ? 'frost' : 'heat');
    return true;
  }

  /* A field that quietly disappears overnight is a mystery; a field that
     says why is a lesson. Only sown crops are worth the message - wild
     plants die of the weather constantly and nobody planted them - and
     it is rate-limited, because a frost takes a whole field at once. */
  function noteCropLoss(map, plant, cold) {
    var now = clockOf(map);
    if (recently(map, '_cropLossTick', now, CROP_LOSS_COOLDOWN)) return;
    map._cropLossTick = now;
    msg(cold
      ? 'Crops are freezing. Nothing will grow outdoors until it warms up.'
      : 'Crops are dying of the heat.',
      { type: 'threat', x: plant.x, y: plant.y });
  }

  /* Old age is rolled rather than scheduled, so a stand of pines planted
     by mapgen on the same tick does not vanish on the same tick either. */
  function dieOfOldAge(map, plant, p, elapsed) {
    var over = (plant.plantAgeTicks || 0) - p.lifespanTicks;
    if (over <= 0) return false;
    var chance = elapsed / (p.lifespanTicks * 0.12);
    if (!U.chance(chance > 1 ? 1 : chance)) return false;
    killPlant(map, plant, 'age');
    return true;
  }

  function killPlant(map, plant, cause) {
    if (!plant || !plant.spawned) return;
    map.destroyThing(plant, cause || 'died');
  }
  Plants.kill = killPlant;

  /* ============================================================
     BLIGHT

     The cropBlight incident marks a crop and walks away; the plants
     take themselves apart from there. A blighted plant stops growing,
     visibly withers (render.js dims anything blighted) and infects its
     neighbours of the same kind, so the player's choice is to cut the
     field early and salvage what is standing or lose all of it.
     ============================================================ */

  Plants.blight = function (map, plantDefId, opts) {
    if (!map) return 0;
    opts = opts || {};
    var list = map.byDef(plantDefId);
    if (!list || !list.length) return 0;

    var def = Defs.maybe('thing', plantDefId);
    if (!def || !def.plant || !def.plant.blightable) return 0;

    /* A blight starts in one corner of one field rather than everywhere
       at once: pick a seed plant and take everything near it. */
    var fraction = opts.fraction === undefined ? 0.7 : opts.fraction;
    var seed = opts.x !== undefined ? { x: opts.x, y: opts.y } : U.pick(list);
    if (!seed) return 0;
    var radius = opts.radius === undefined ? 14 : opts.radius;

    var hit = 0;
    for (var i = 0; i < list.length; i++) {
      var pl = list[i];
      if (!pl.spawned || pl.blighted) continue;
      if (U.cheb(pl.x, pl.y, seed.x, seed.y) > radius) continue;
      if (!U.chance(fraction)) continue;
      pl.blighted = true;
      pl._stress = 0;
      hit++;
    }

    if (hit) {
      letter('Blight',
        'A blight has taken hold in your ' + labelOf(def) + 's. Blighted plants will not ripen ' +
        'and will spread it to their neighbours. Cut them down before they take the whole field.',
        { kind: 'threat', x: seed.x, y: seed.y });
    }
    return hit;
  };

  function tickBlight(map, plant, elapsed) {
    /* Death runs on its own clock rather than on growth reaching zero:
       a seedling blighted the day it went in the ground should have the
       same fortnight-of-the-field feel as a crop blighted the day before
       harvest, not vanish in forty seconds. Growth decays towards zero
       beside it, which is what the withered sprite reads from. */
    plant._stress = Math.abs(plant._stress || 0) + elapsed;
    plant.growth *= Math.max(0, 1 - elapsed / BLIGHT_DEATH_TICKS);
    if (plant._stress >= BLIGHT_DEATH_TICKS) { killPlant(map, plant, 'blight'); return; }

    if (!U.chance(BLIGHT_SPREAD_CHANCE)) return;
    var step = U.pick(U.ADJ8);
    var n = map.plantAt(plant.x + step[0], plant.y + step[1]);
    if (n && !n.blighted && n.defId === plant.defId) n.blighted = true;
  }

  /* ============================================================
     SOWING
     ============================================================ */

  /* Only 'field' exists as a growing surface today; the hydroponic tag
     the crop defs carry is the list a basin would satisfy the day one is
     built, and asking for the tag now means that day needs no edit here. */
  function surfaceTagAt(map, x, y) {
    var terr = map.terrainAt(x, y);
    if (!terr || terr.supportsPlants === false) return null;
    return 'field';
  }

  Plants.canSowAt = function (map, x, y, plantDefId) {
    if (!map || !map.inBounds(x, y)) return false;
    var def = Defs.maybe('thing', plantDefId);
    var p = def && def.plant;
    if (!p || !p.sowable) return false;

    var terr = map.terrainAt(x, y);
    if (!terr || terr.supportsPlants === false) return false;
    if ((terr.fertility || 0) < p.minFertility) return false;

    var tag = surfaceTagAt(map, x, y);
    if (!tag || p.sowTags.indexOf(tag) < 0) return false;

    if (!map.passable(x, y)) return false;
    if (map.buildingAt(x, y)) return false;
    if (map.plantAt(x, y)) return false;

    /* A growing zone is an instruction, not a suggestion: sowing rice on
       a cell the player has set to corn would quietly undo the order. */
    var zone = growingZoneAt(map, x, y);
    if (zone) {
      if (zone.allowSow === false) return false;
      if (zone.plantDefId && zone.plantDefId !== plantDefId) return false;
    }
    return true;
  };

  Plants.sow = function (map, x, y, plantDefId) {
    if (!Plants.canSowAt(map, x, y, plantDefId)) return null;
    var plant = map.spawnThing(plantDefId, x, y, { growth: 0.05, sown: true });
    if (plant) plant._growTick = clockOf(map);
    return plant;
  };

  /* What a growing zone wants put in a cell, for the sow job and for
     workgivers.js. Falls back to whatever the job itself was told. */
  Plants.sowDefIdAt = function (map, x, y) {
    var zone = growingZoneAt(map, x, y);
    return (zone && zone.plantDefId) || null;
  };

  /* ============================================================
     HARVEST AND CUTTING
     ============================================================ */

  /* Picking a crop can be fumbled and felling a tree cannot: skill
     decides how fast a tree comes down, not how much of it is wood. */
  function yieldFactor(pawn) {
    if (!pawn) return 1;
    var keep = U.clamp(0.55 + 0.045 * skillLevel(pawn, 'plants'), 0.3, 1);
    return U.clamp(keep * U.randRange(0.85, 1.15), 0.2, 1);
  }

  Plants.isTree = function (thing) {
    var def = plantDefOf(thing);
    return !!(def && def.plant.isTree);
  };

  /* Ripe, and somebody has asked for it: either it is a crop standing in
     a growing zone that grew it, or it is a wild plant the player has
     marked for harvest. Wild berries nobody asked for stay on the bush. */
  Plants.harvestable = function (map, plant) {
    var def = plantDefOf(plant);
    if (!def || !plant.spawned) return false;
    var p = def.plant;
    if (!p.harvestedThing || !(p.harvestYield > 0)) return false;
    if (plant.blighted) return false;
    if (plant.growth < p.harvestMinGrowth) return false;

    if (map.designationAt(plant.x, plant.y, 'harvest')) return true;

    var zone = growingZoneAt(map, plant.x, plant.y);
    if (zone && zone.allowCut !== false && plant.growth >= 1) {
      return !zone.plantDefId || zone.plantDefId === plant.defId;
    }
    return false;
  };

  Plants.harvestWork = function (plant) {
    var def = plantDefOf(plant);
    return def ? def.plant.harvestWork : 0;
  };

  Plants.harvest = function (map, plant, pawn) {
    var def = plantDefOf(plant);
    if (!def || !plant.spawned) return [];
    var p = def.plant;
    if (!p.harvestedThing) { Plants.cutDown(map, plant, pawn); return []; }

    var x = plant.x, y = plant.y;
    var scale = U.clamp01(plant.growth) * yieldFactor(pawn);
    var count = Math.round(p.harvestYield * scale);

    /* A ripe plant always gives something. Nothing is more dispiriting
       than watching a colonist spend two hundred work on a full-grown
       rice plant and come away empty-handed. */
    if (count < 1 && plant.growth >= p.harvestMinGrowth) count = 1;

    map.undesignate(x, y, 'harvest');

    if (p.harvestDestroys) {
      map.despawnThing(plant);
    } else {
      plant.growth = p.regrowsTo;
      plant.plantAgeTicks = 0;
      plant._growTick = clockOf(map);
    }

    return count > 0 ? map.addItem(p.harvestedThing, x, y, count) : [];
  };

  /* Marked to be cleared. A cut or chop designation says so outright,
     and so does a growing zone with something else standing in it. */
  Plants.cuttable = function (map, plant) {
    var def = plantDefOf(plant);
    if (!def || !plant.spawned) return false;
    if (map.designationAt(plant.x, plant.y, 'cut')) return true;
    if (map.designationAt(plant.x, plant.y, 'chop')) return true;

    var zone = growingZoneAt(map, plant.x, plant.y);
    if (!zone || zone.allowCut === false) return false;
    /* Blighted crops and weeds standing in the field both have to go. */
    return plant.blighted || !zone.plantDefId || zone.plantDefId !== plant.defId;
  };

  /* Cutting is clearing, not harvesting. A crop comes up for nothing, a
     tree pays in wood scaled by how much tree there is. */
  Plants.cutDown = function (map, plant, pawn) {
    var def = plantDefOf(plant);
    if (!def || !plant.spawned) return [];
    var p = def.plant;
    var x = plant.x, y = plant.y;

    var out = [];
    if (p.isTree && p.harvestedThing && plant.growth >= p.harvestMinGrowth) {
      var count = Math.round(p.harvestYield * U.clamp01(plant.growth));
      if (count > 0) {
        map.despawnThing(plant);
        out = map.addItem(p.harvestedThing, x, y, count);
      }
    }
    if (plant.spawned) map.despawnThing(plant);

    map.undesignate(x, y, 'cut');
    map.undesignate(x, y, 'chop');
    return out;
  };

  /* The size a tree is drawn at, and the size fire treats it as. Growth
     drives it, the def's range bounds it, and a stable hash of the cell
     gives two oaks side by side different silhouettes. */
  Plants.visualSizeOf = function (plant) {
    var def = plantDefOf(plant);
    if (!def) return 1;
    var range = def.plant.visualSizeRange || [1, 1];
    var g = U.clamp01(plant.growth);
    var base = range[0] + (range[1] - range[0]) * g;
    var jitter = ((U.hash(plant.x + ':' + plant.y) % 1000) / 1000 - 0.5) * 0.12;
    return Math.max(0.15, base + jitter * g);
  };

  /* ============================================================
     WILD SPREAD

     Two callers: tickRare, when one mature wild plant seeds a
     neighbour, and mapgen, which scatters the whole map at once. Both
     go through canSeedAt and both respect wildDensity, which is what
     stops a hundred-day colony from being buried in grass.
     ============================================================ */

  Plants.canSeedAt = function (map, x, y, def) {
    var p = def && def.plant;
    if (!p || !map.inBounds(x, y)) return false;

    var terr = map.terrainAt(x, y);
    if (!terr || terr.supportsPlants === false) return false;
    if ((terr.fertility || 0) < p.minFertility) return false;
    if (!map.passable(x, y)) return false;
    if (map.plantAt(x, y) || map.buildingAt(x, y)) return false;
    if (map.ghostAt && map.ghostAt(x, y)) return false;
    /* Under a mountain there is no light and no reason to try. */
    if (map.roof[map.idx(x, y)] === 2) return false;
    /* Wild growth respects the player's floor plan: nothing seeds into a
       stockpile or a growing zone somebody is trying to farm. */
    if (zoneAt(map, x, y)) return false;
    return true;
  };

  /* How many of this kind are already standing nearby, as a fraction of
     the cells around here. wildDensity is the ceiling mapgen used, so
     reusing it as the regrowth ceiling keeps a cleared field clear until
     the neighbourhood thins out. */
  function localDensity(map, x, y, defId, radius) {
    var count = 0, cells = 0;
    for (var dy = -radius; dy <= radius; dy++) {
      var yy = y + dy;
      if (yy < 0 || yy >= map.h) continue;
      for (var dx = -radius; dx <= radius; dx++) {
        var xx = x + dx;
        if (xx < 0 || xx >= map.w) continue;
        cells++;
        var pl = map.plantAt(xx, yy);
        if (pl && pl.defId === defId) count++;
      }
    }
    return cells ? count / cells : 1;
  }

  function trySpread(map, plant, def, elapsed) {
    var p = def.plant;
    if (plant.sown || !(p.wildDensity > 0)) return;
    if (plant.growth < SPREAD_MIN_GROWTH) return;

    /* Slow growers seed slowly. The square root keeps an oak from being
       seven times rarer than grass on top of taking seven times as long
       to be worth seeding from in the first place. */
    var chance = SPREAD_BASE * elapsed * Math.sqrt(2 / p.growDays);
    if (!U.chance(chance)) return;

    var step = U.pick(U.ADJ8);
    var reach = U.randInt(1, 3);
    var x = plant.x + step[0] * reach, y = plant.y + step[1] * reach;
    if (!Plants.canSeedAt(map, x, y, def)) return;
    if (localDensity(map, x, y, def.id, SPREAD_CHECK_RADIUS) >= p.wildDensity) return;

    var seedling = map.spawnThing(def.id, x, y, { growth: 0.05 });
    if (seedling) seedling._growTick = clockOf(map);
  }

  function wildDefsFor(biome, only) {
    var all = Defs.plants();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      var d = all[i], p = d.plant;
      if (!p || p.sowable || !(p.wildDensity > 0)) continue;
      if (only && only.indexOf(d.id) < 0) continue;
      if (p.wildBiomes && biome && p.wildBiomes.indexOf(biome) < 0) continue;
      out.push(d);
    }

    /* Order decides what a map looks like. Grass has ten times the
       density of anything else, so scattering it first would carpet the
       ground and leave nowhere for an oak to stand. Trees pick their
       cells first, then the rarer plants, and the grass fills in around
       whatever is already there - which is also the order mapgen uses
       when it seeds a map itself. */
    out.sort(function (a, b) {
      var at = a.plant.isTree ? 0 : 1, bt = b.plant.isTree ? 0 : 1;
      if (at !== bt) return at - bt;
      return a.plant.wildDensity - b.plant.wildDensity;
    });
    return out;
  }

  function treeNear(map, x, y, radius) {
    for (var dy = -radius; dy <= radius; dy++) {
      for (var dx = -radius; dx <= radius; dx++) {
        var pl = map.plantAt(x + dx, y + dy);
        if (pl && Plants.isTree(pl)) return true;
      }
    }
    return false;
  }

  /* Scatter flora across a map, or a rectangle of one. Clusters rather
     than uniform noise: mapgen drops a seed point and grows a patch
     around it, which is what makes a map read as woods and clearings
     instead of even static. Berry bushes look for a wood to sit in,
     because a bush in the open is a bush a raider walks past and a bush
     under an oak is a reason to send a colonist into the trees.

     The area is either a corner pair or an origin and a size; mapgen
     passes the second form and a regrowth call passes the first, so both
     are read rather than making one caller translate for the other.

     opts: {biome, density, defIds, growth,
            x0, y0, x1, y1  |  x, y, w, h}                              */
  Plants.spawnWild = function (map, opts) {
    if (!map) return 0;
    opts = opts || {};
    var G = sys('Game');
    var biome = opts.biome || (G && G.biome) || 'temperateForest';
    var density = opts.density === undefined ? 1 : opts.density;
    var defs = wildDefsFor(biome, opts.defIds || null);
    if (!defs.length || density <= 0) return 0;

    var ox = opts.x0 !== undefined ? opts.x0 : (opts.x !== undefined ? opts.x : 0);
    var oy = opts.y0 !== undefined ? opts.y0 : (opts.y !== undefined ? opts.y : 0);
    var ex = opts.x1 !== undefined ? opts.x1
           : (opts.w !== undefined ? ox + opts.w - 1 : map.w - 1);
    var ey = opts.y1 !== undefined ? opts.y1
           : (opts.h !== undefined ? oy + opts.h - 1 : map.h - 1);

    var x0 = Math.max(0, ox | 0), y0 = Math.max(0, oy | 0);
    var x1 = Math.min(map.w - 1, ex | 0), y1 = Math.min(map.h - 1, ey | 0);
    var area = (x1 - x0 + 1) * (y1 - y0 + 1);
    if (x1 < x0 || y1 < y0 || area <= 0) return 0;

    var placed = 0;
    for (var d = 0; d < defs.length; d++) {
      var def = defs[d], p = def.plant;
      var cluster = p.wildCluster || [1, 1];
      var avg = Math.max(1, (cluster[0] + cluster[1]) / 2);
      var seeds = Math.round((area * p.wildDensity * density) / avg);
      if (seeds <= 0) continue;

      var wantsShade = def.id === 'berryBush';
      for (var s = 0; s < seeds; s++) {
        var spot = pickSeedSpot(map, def, x0, y0, x1, y1, wantsShade);
        if (!spot) continue;
        placed += growCluster(map, def, spot.x, spot.y, U.randInt(cluster[0], cluster[1]), opts);
      }
    }
    return placed;
  };

  /* A handful of tries rather than a scan: on a fresh map almost any
     cell works, and on a crowded one giving up quickly is correct. */
  function pickSeedSpot(map, def, x0, y0, x1, y1, wantsShade) {
    var fallback = null;
    for (var attempt = 0; attempt < 8; attempt++) {
      var x = U.randInt(x0, x1), y = U.randInt(y0, y1);
      if (!Plants.canSeedAt(map, x, y, def)) continue;
      if (!wantsShade) return { x: x, y: y };
      if (treeNear(map, x, y, 3)) return { x: x, y: y };
      if (!fallback) fallback = { x: x, y: y };
    }
    return fallback;
  }

  function growCluster(map, def, cx, cy, count, opts) {
    var radius = 1 + Math.ceil(Math.sqrt(count) / 1.1);
    var placed = 0;
    var tries = count * 4;
    var range = def.plant.isTree ? [0.3, 1] : [0.25, 1];

    for (var i = 0; i < tries && placed < count; i++) {
      var x = cx + U.randInt(-radius, radius);
      var y = cy + U.randInt(-radius, radius);
      if (!Plants.canSeedAt(map, x, y, def)) continue;
      var growth = opts.growth === undefined ? U.randRange(range[0], range[1]) : opts.growth;
      var plant = map.spawnThing(def.id, x, y, { growth: growth });
      if (!plant) continue;
      /* Age it in step with its growth so a map does not start with a
         forest that all reaches the end of its lifespan on one day. */
      plant.plantAgeTicks = Math.round(def.plant.growTicks * growth);
      plant._growTick = clockOf(map);
      placed++;
    }
    return placed;
  }

  /* ============================================================
     FIRE

     A fire keeps its size in `growth`, which every Thing already has and
     save.js already round-trips. It grows while there is fuel under it,
     starves when there is not, and everything expensive is staggered by
     the fire's own id so a burning treeline never costs one tick more
     than it costs any other.
     ============================================================ */

  function stuffFlammability(thing) {
    var f = STUFF_FLAMMABILITY[thing.stuff];
    return f === undefined ? DEFAULT_FLAMMABILITY : f;
  }

  /* Plants carry a 0..1 flammability and everything else a boolean, so
     this is the one place that turns both into the same number. A green
     sapling burns less well than a full-grown one. */
  Plants.flammabilityOf = function (thing) {
    if (!thing || !thing.def) return 0;
    var def = thing.def;
    if (def.id === 'fire' || def.id === 'filthBlood') return 0;
    if (def.category === 'plant') {
      return (def.flammable || 0) * (0.35 + 0.65 * U.clamp01(thing.growth));
    }
    if (!def.flammable) return 0;
    return thing.stuff ? stuffFlammability(thing) : DEFAULT_FLAMMABILITY;
  };

  /* A built floor made of wood or cloth burns; bare earth does not. The
     terrain defs carry no flammability of their own, so the cost list is
     the honest source: what a floor is made of is what it burns like. */
  function floorFlammability(terr) {
    if (!terr || terr.isNatural || !terr.buildCost) return 0;
    var best = 0;
    for (var k in terr.buildCost) {
      var f = STUFF_FLAMMABILITY[k];
      if (f !== undefined && f > best) best = f;
    }
    return best;
  }

  Plants.fuelAt = function (map, x, y) {
    if (!map.inBounds(x, y)) return 0;
    var fuel = 0;

    var plant = map.plantAt(x, y);
    if (plant) fuel += Plants.flammabilityOf(plant) * Plants.visualSizeOf(plant);

    var b = map.buildingAt(x, y);
    if (b) fuel += Plants.flammabilityOf(b) * 1.5;

    /* A half-built wall is a stack of wood standing on end, and it lives
       on its own grid rather than with the buildings. A blueprint is a
       chalk line and carries flammable:false, so it costs nothing here. */
    var g = map.ghostAt ? map.ghostAt(x, y) : null;
    if (g) fuel += Plants.flammabilityOf(g);

    var items = map.items(x, y);
    for (var i = 0; i < items.length; i++) {
      fuel += Plants.flammabilityOf(items[i]) * 0.5;
    }

    fuel += floorFlammability(map.terrainAt(x, y)) * 0.6;
    return fuel;
  };

  Plants.fireAt = function (map, x, y) {
    if (!map.inBounds(x, y)) return null;
    var items = map.items(x, y);
    for (var i = 0; i < items.length; i++) {
      if (items[i].defId === 'fire') return items[i];
    }
    return null;
  };

  Plants.fires = function (map) { return map ? map.byDef('fire') : []; };

  Plants.startFire = function (map, x, y) {
    if (!map || !map.inBounds(x, y)) return null;
    if (Plants.fireAt(map, x, y)) return null;

    var terr = map.terrainAt(x, y);
    if (!terr || terr.isWater) return null;
    /* Nothing to take and nothing to keep it: a spark on wet gravel just
       goes out, and spawning a fire that despawns next tick is churn. */
    if (Plants.fuelAt(map, x, y) <= 0) return null;

    var fire = map.spawnThing('fire', x, y);
    if (!fire) return null;
    fire.growth = FIRE_MIN_SIZE;
    alertFire(map, fire);
    return fire;
  };

  /* A fire outside in the woods is a message; a fire in a room the
     colony lives in is a letter, because that is the difference between
     something to watch and something to drop everything for. Both are
     rate-limited, because a blaze spreads by starting more fires and
     forty letters saying the same thing is not forty times the warning.

     The stamps live on the map rather than in this file: a new colony
     starts its clock at zero, and a module-level stamp left over from
     the last one would silence its first fire. */
  function alertFire(map, fire) {
    var G = sys('Game');
    if (!G) return;
    var now = clockOf(map);
    var room = roomAt(map, fire.x, fire.y);

    if (room && !room.outdoor) {
      /* Walking the room is the expensive half, so a blaze that has
         already announced itself never pays for it. */
      if (recently(map, '_fireLetterTick', now, FIRE_LETTER_COOLDOWN)) return;
      if (colonyRoom(map, room)) {
        map._fireLetterTick = now;
        letter('Fire!',
          'A fire has broken out inside your colony. Firefighting is the highest-priority work ' +
          'there is - anyone who can beat it out will drop what they are doing - but a fire in a ' +
          'wooden building spreads faster than three colonists can put it out.',
          { kind: 'threat', x: fire.x, y: fire.y });
        return;
      }
    }

    if (recently(map, '_fireMsgTick', now, FIRE_MSG_COOLDOWN)) return;
    if (!nearColonist(map, fire.x, fire.y, FIRE_ALERT_RADIUS)) return;
    map._fireMsgTick = now;
    msg('A fire has started.', { type: 'threat', x: fire.x, y: fire.y });
  }

  /* Somewhere the colony actually lives: a colonist in it, or something
     the colony built standing in it. A cave a raider set alight is not. */
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

  /* How readily the air carries a fire today. A summer afternoon is
     nearly twice a winter morning; nothing here needs rain, because a
     fire that runs out of fuel goes out on its own. */
  function dryness(map, x, y) {
    var temp = Plants.temperatureAt(map, x, y);
    var f = 0.55 + (temp - 15) / 45;
    var G = sys('Game');
    if (G && G.season) {
      var s = G.season();
      if (s === 'summer') f *= 1.25;
      else if (s === 'fall') f *= 1.1;
      else if (s === 'winter') f *= 0.75;
    }
    return U.clamp(f, 0.2, 1.8);
  }

  Plants.tickFires = function (map) {
    if (!map) return;
    var fires = map.byDef('fire');
    if (!fires.length) return;
    var now = clockOf(map);

    /* Backwards, because byDef removes with a swap-pop: an entry taken
       out is replaced by one already visited, and fires started by this
       tick's spread are appended past the cursor and wait their turn. */
    for (var i = fires.length - 1; i >= 0; i--) {
      var fire = fires[i];
      if (!fire || !fire.spawned) continue;
      tickOneFire(map, fire, now);
    }
  };

  function tickOneFire(map, fire, now) {
    var x = fire.x, y = fire.y;
    var fuel = Plants.fuelAt(map, x, y);

    if (fuel <= 0) {
      fire.growth -= FIRE_STARVE_PER_TICK;
      if (fire.growth <= 0) { map.despawnThing(fire); return; }
    } else if (fire.growth < 1 && !(fire._fought >= now - 1)) {
      /* A wall of dry grass takes hold faster than a damp shrub. */
      fire.growth = U.clamp01(fire.growth + FIRE_GROW_PER_TICK * Math.min(2, 0.5 + fuel));
    }

    var size = fire.growth;
    var phase = fire.id;

    if ((now + phase) % FIRE_DAMAGE_INTERVAL === 0) burnCell(map, fire, size);
    if ((now + phase) % FIRE_PAWN_INTERVAL === 0) burnPawns(map, x, y, size);
    if (size >= FIRE_SPREAD_MIN_SIZE && (now + phase) % FIRE_SPREAD_INTERVAL === 0) {
      spreadFire(map, fire, size);
    }
  }

  function burnCell(map, fire, size) {
    var x = fire.x, y = fire.y;

    var plant = map.plantAt(x, y);
    if (plant && Plants.flammabilityOf(plant) > 0) {
      plant.damage(Math.max(1, Math.round(PLANT_BURN_DAMAGE * size)));
    }

    var b = map.buildingAt(x, y);
    if (b && Plants.flammabilityOf(b) > 0) {
      b.damage(Math.max(1, Math.round(BUILDING_BURN_DAMAGE * size)));
    }

    /* A frame that burns down hands its materials back to the floor, and
       those then burn too - which is exactly what should happen to the
       pile of wood somebody left half-nailed together. */
    var g = map.ghostAt ? map.ghostAt(x, y) : null;
    if (g && Plants.flammabilityOf(g) > 0) {
      g.damage(Math.max(1, Math.round(BUILDING_BURN_DAMAGE * size)));
    }

    /* Backwards again: an item destroyed here leaves the cell's list. */
    var items = map.items(x, y);
    for (var i = items.length - 1; i >= 0; i--) {
      var it = items[i];
      if (it === fire || Plants.flammabilityOf(it) <= 0) continue;
      it.damage(Math.max(1, Math.round(ITEM_BURN_DAMAGE * size)));
    }

    /* A wooden floor does not have hit points, so it burns through as a
       roll instead: rare per check, near certain over a long blaze. */
    var terr = map.terrainAt(x, y);
    var ff = floorFlammability(terr);
    if (ff > 0 && U.chance(FLOOR_BURN_CHANCE * ff * size)) {
      map.setTerrain(x, y, 'soil');
    }
  }

  function burnPawns(map, x, y, size) {
    var H = sys('Health');
    var pawns = map.pawnsAt(x, y);
    for (var i = pawns.length - 1; i >= 0; i--) {
      var pawn = pawns[i];
      if (pawn.dead) continue;
      if (!H || !H.damage) return;
      H.damage(pawn, {
        amount: Math.max(1, Math.round(2 + 4 * size)),
        type: 'burn', source: 'fire'
      });
    }
  }

  /* Fire radiates in every direction, so every neighbour gets its own
     roll rather than one randomly chosen cell getting all of them. It
     costs eight cheap grid lookups on a staggered interval, and it is
     the difference between a grass fire that sweeps a field and one
     that sits burning a single tile until its own fuel runs out. */
  function spreadFire(map, fire, size) {
    var dry = dryness(map, fire.x, fire.y);
    for (var k = 0; k < U.ADJ8.length; k++) {
      var x = fire.x + U.ADJ8[k][0], y = fire.y + U.ADJ8[k][1];
      if (!map.inBounds(x, y)) continue;
      if (Plants.fireAt(map, x, y)) continue;

      var fuel = Plants.fuelAt(map, x, y);
      if (fuel <= 0) continue;

      if (!U.chance(FIRE_SPREAD_CHANCE * size * Math.min(1.5, fuel) * dry)) continue;
      Plants.startFire(map, x, y);
    }
  }

  /* Beating a fire down. Returns true when it is out; a fire being
     fought does not grow this tick, which is what makes two colonists
     on one fire meaningfully better than one. */
  Plants.extinguish = function (map, fire, amount) {
    if (!fire || !fire.spawned) return true;
    fire._fought = clockOf(map);
    fire.growth -= amount;
    if (fire.growth > 0) return false;
    map.despawnThing(fire);
    return true;
  };

  /* ============================================================
     JOBS

     Section 8 of the contract puts these five here, next to the system
     they belong to. workgivers.js does the scanning and builds them
     with Jobs.make; what each one does once the colonist arrives is
     below.

       Jobs.make('sow',            T.cell(x, y))   crop from the growing zone,
                                                   or job.state.plantDefId
       Jobs.make('harvest',        T.thing(plant))
       Jobs.make('cutPlant',       T.thing(plant))
       Jobs.make('chopWood',       T.thing(tree))
       Jobs.make('extinguishFire', T.thing(fire))

     All the grinding goes through Toils.work, which is the vocabulary
     jobs.js actually offers: it stops the pawn, turns them to face what
     they are working on, applies the contract's work rate and grants the
     plants skill its experience per work unit. What comes out at the end
     is the only part that belongs to this file, and that is onDone.
     ============================================================ */

  var Jobs = root.Jobs, Toils = root.Toils, T = root.T, Path = root.Path;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  function targetThing(job, which, map) {
    var t = job['target' + which];
    return (t && T) ? T.resolve(t, map) : null;
  }

  function targetPos(job, which, map) {
    var t = job['target' + which];
    return (t && T) ? T.pos(t, map) : null;
  }

  /* Progress a UI can read. Toils.work keeps its own counters in the
     toil scratch, so the job's own field has to be written from here. */
  function noteProgress(job, s) {
    job.workLeft = Math.max(0, s.total - s.done);
  }

  /* Everything a sow job needs to know, derived rather than stored: the
     cell it is aimed at, and what the growing zone under that cell wants
     put in it. A giver that already knows can say so on the job, which
     is what lets a player-forced sow work outside a zone. */
  function sowPlan(pawn, job) {
    var map = pawn.map;
    var pos = targetPos(job, 'A', map) || { x: pawn.x, y: pawn.y };
    var defId = job.plantDefId ||
                (job.state && job.state.plantDefId) ||
                Plants.sowDefIdAt(map, pos.x, pos.y);
    var def = defId ? Defs.maybe('thing', defId) : null;
    return {
      x: pos.x, y: pos.y,
      defId: def && def.plant && def.plant.sowable ? defId : null,
      work: (def && def.plant) ? def.plant.sowWork : 0
    };
  }

  /* One driver for harvest, cut and chop. They differ only in what the
     plant leaves behind, which is spec.finish. */
  function plantWorkJob(id, spec) {
    Jobs.register(id, {
      label: spec.label,
      reportString: function (job, pawn) {
        var t = targetThing(job, 'A', pawn && pawn.map);
        return spec.verb + ' ' + (t ? labelOf(t.def) : spec.noun);
      },
      toils: function () {
        return [
          Toils.reserve('A'),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.work({
            name: id + 'Work',
            skill: 'plants',
            failIfGone: true,
            amount: function (pawn, job) {
              return Plants.harvestWork(targetThing(job, 'A', pawn.map)) || 1;
            },
            onTick: function (pawn, job, s) { noteProgress(job, s); },
            onDone: function (pawn, job) {
              var plant = targetThing(job, 'A', pawn.map);
              if (!plant || !plant.spawned || !plantDefOf(plant)) return 'fail';
              spec.finish(pawn.map, plant, pawn);
              job.workLeft = 0;
              return 'done';
            }
          })
        ];
      }
    });
  }

  if (Jobs && Jobs.register && Toils && Toils.work) {

    /* --- sow ---
       The sower stands on the cell rather than beside it: a seed goes in
       the ground underfoot, and insisting on that is also what stops a
       colonist sowing a field through a wall. */
    Jobs.register('sow', {
      label: 'sow',
      reportString: function (job, pawn) {
        if (!pawn || !pawn.map) return 'Sowing';
        var def = Defs.maybe('thing', sowPlan(pawn, job).defId || '');
        return 'Sowing ' + (def ? labelOf(def) : 'plants');
      },
      toils: function () {
        return [
          Toils.reserve('A'),
          Toils.goto('A', { pe: PE.ON_CELL, failIfGone: true }),
          Toils.work({
            name: 'sowWork',
            skill: 'plants',
            amount: function (pawn, job) { return sowPlan(pawn, job).work; },
            init: function (pawn, job, s) {
              var plan = sowPlan(pawn, job);
              s.x = plan.x; s.y = plan.y; s.defId = plan.defId;
            },
            /* Asked every tick, because another grower may have got here
               first or the player may have re-pointed the zone while
               this one was still kneeling in the dirt. */
            onTick: function (pawn, job, s) {
              if (!s.defId || !Plants.canSowAt(pawn.map, s.x, s.y, s.defId)) return 'fail';
              noteProgress(job, s);
            },
            onDone: function (pawn, job, s) {
              job.workLeft = 0;
              return Plants.sow(pawn.map, s.x, s.y, s.defId) ? 'done' : 'fail';
            }
          })
        ];
      }
    });

    plantWorkJob('harvest', {
      label: 'harvest', verb: 'Harvesting', noun: 'plant',
      finish: function (map, plant, pawn) { Plants.harvest(map, plant, pawn); }
    });

    plantWorkJob('cutPlant', {
      label: 'cut plant', verb: 'Cutting', noun: 'plant',
      finish: function (map, plant, pawn) { Plants.cutDown(map, plant, pawn); }
    });

    plantWorkJob('chopWood', {
      label: 'chop wood', verb: 'Chopping', noun: 'tree',
      finish: function (map, plant, pawn) { Plants.cutDown(map, plant, pawn); }
    });

    /* --- extinguish fire ---
       Fought from an adjacent cell, and deliberately without a
       reservation: a fire is an emergency, and three colonists beating
       the same one is the right answer rather than a conflict to
       arbitrate. The work is not in work units either - what matters is
       how big the fire still is, and it fights back by growing. */
    Jobs.register('extinguishFire', {
      label: 'extinguish fire',
      suspendable: false,
      alwaysShow: true,
      reportString: function () { return 'Extinguishing fire'; },
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.ADJACENT, failIfGone: true, avoidFire: true }),
          Toils.custom({
            name: 'beatFire',
            tick: function (pawn, job) {
              var map = pawn.map;
              var fire = targetThing(job, 'A', map);
              /* Already out - by another colonist, or by running out of
                 anything to burn. Either way the job is done, not failed. */
              if (!fire || !fire.spawned) { job.workLeft = 0; return 'done'; }
              if (U.cheb(pawn.x, pawn.y, fire.x, fire.y) > 1) return 'fail';

              var H = sys('Health');
              var factor = (H && H.workSpeedFactor) ? H.workSpeedFactor(pawn) : 1;
              var amount = EXTINGUISH_PER_TICK * Math.max(0.2, factor);
              var out = Plants.extinguish(map, fire, amount);
              /* Ticks of beating still to go: a fire's size means nothing
                 to a player watching a progress bar. */
              job.workLeft = out ? 0 : Math.ceil(fire.growth / amount);
              return out ? 'done' : 'stay';
            },
            end: function (pawn, job) { job.workLeft = 0; }
          })
        ];
      }
    });
  }

  root.Plants = Plants;
})(this);
