/* ============================================================
   anomaly.js - the things that should not exist.

   There is a black slab standing somewhere on your map. It was
   there when you landed, it does nothing, and a colony can play a
   full campaign without ever walking over to it. That is the whole
   design: everything in this file is behind a door the player has
   to open themselves, and the door is opened by dragging the mine
   tool across a rock that is not rock.

   After that the world worsens in stages, and each stage is also
   bought by the player - dark research points, spent at the slab,
   because the alternative is spending them on the tree of things
   that make the next stage survivable. A colony that escalates
   fast has power it cannot use yet. A colony that escalates slowly
   has a researcher going quietly strange in the corner.

   Six entities, and none of them is a raider with a different
   sprite:
     shamblers    slow, numerous, and they get back up
     fleshbeasts  fast, and they come through the wall
     metalhorrors inside one of your colonists, for days
     sightstealer puts the lights out and kills in the dark
     revenants    take someone and you have to go and find it
     devourers    swallow a pawn whole, and can be cut open

   State lives in two places and both of them are already saved:
   plain fields on pawns (pawn.anomaly), and plain scalars on the
   monolith and the holding platforms. save.js carries scalars off
   Things and whole plain objects off pawns, so nothing here needs
   save.js to know this file exists. Anomaly.save/load exist anyway
   for whoever wires them.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Everything above anomaly.js in the load order binds now. Game,
     Incidents and Storyteller load below it and are fetched lazily. */
  var T = root.T, Res = root.Res, Jobs = root.Jobs, Toils = root.Toils;
  var Path = root.Path, WorkGivers = root.WorkGivers;

  var Anomaly = {};

  var TICKS_PER_DAY = 60000;
  var SLOW = 500;                  /* game.js calls Anomaly.tick on this beat */
  var FACTION = 'anomaly';
  var STAGE_MAX = 6;

  /* ============================================================
     1. GUARDED ACCESS TO EVERYTHING ELSE
     ============================================================ */

  function sys(name) { return root[name] || null; }
  function G() { return root.Game || null; }
  function now() {
    var g = G();
    return (g && typeof g.tick === 'number') ? g.tick : 0;
  }
  function today() {
    var g = G();
    return (g && g.day) ? g.day() : Math.floor(now() / TICKS_PER_DAY);
  }
  function msg(text, type, at) {
    var g = G();
    if (g && g.msg) g.msg(text, { type: type || 'info', x: at ? at.x : undefined, y: at ? at.y : undefined });
  }
  function letter(title, text, kind, at) {
    var g = G();
    if (g && g.letter) g.letter(title, text, { kind: kind || 'neutral', x: at ? at.x : undefined, y: at ? at.y : undefined });
    else msg(title, kind);
  }
  function debugLog(text) {
    var g = G();
    if (g && g.debug && typeof console !== 'undefined') console.log('[anomaly] ' + text);
  }
  function nameOf(pawn) {
    if (!pawn) return 'someone';
    if (pawn.fullName) return pawn.fullName();
    return (pawn.name && (pawn.name.nick || pawn.name.first)) || 'someone';
  }

  function colonists(map) {
    return (map && map.colonists) ? map.colonists() : [];
  }

  function colonyCentre(map) {
    var list = colonists(map);
    if (!list.length) return { x: map.w >> 1, y: map.h >> 1 };
    var sx = 0, sy = 0;
    for (var i = 0; i < list.length; i++) { sx += list[i].x; sy += list[i].y; }
    return { x: Math.round(sx / list.length), y: Math.round(sy / list.length) };
  }

  function freeCellNear(map, x, y, radius) {
    x = U.clamp(x | 0, 1, map.w - 2);
    y = U.clamp(y | 0, 1, map.h - 2);
    var ring = U.cellsInRadius(x, y, radius || 8);
    for (var i = 0; i < ring.length; i++) {
      var cx = ring[i][0], cy = ring[i][1];
      if (!map.inBounds(cx, cy)) continue;
      if (!map.passable(cx, cy)) continue;
      if (map.pawnsAt(cx, cy).length) continue;
      return { x: cx, y: cy };
    }
    return null;
  }

  function edgeCells(map, side) {
    var MG = sys('MapGen');
    if (MG && MG.edgeSpawnCells) {
      var got = MG.edgeSpawnCells(map, side);
      if (got && got.length) return got;
    }
    var out = [], horizontal = side === 'n' || side === 's';
    var n = horizontal ? map.w : map.h;
    for (var i = 2; i < n - 2; i++) {
      var x = horizontal ? i : (side === 'w' ? 1 : map.w - 2);
      var y = horizontal ? (side === 'n' ? 1 : map.h - 2) : i;
      if (map.passable(x, y)) out.push({ x: x, y: y });
    }
    return out;
  }

  function lightAt(map, x, y) {
    var P = sys('Power');
    if (P && P.lightAt) return P.lightAt(map, x, y);
    var g = G();
    return g && g.daylight ? g.daylight() : 1;
  }

  /* ============================================================
     2. STATE

     The authoritative copy of anything durable is mirrored onto
     the monolith as scalars at the end of every tick, because
     save.js copies scalars off a Thing and knows nothing about
     this file. rehydrate() reads them back after a load.
     ============================================================ */

  function blankState() {
    return {
      lastSeenTick: 0,
      incidentsReady: false,
      placed: false,
      monolithId: 0,
      stage: 0,
      touched: false,
      touchWanted: false,
      touchTick: 0,
      dark: 0,                 /* unspent dark research points */
      spent: 0,                /* lifetime spend, for the readout */
      tree: {},                /* nodeId -> true */
      sessions: 0,
      flesh: { cells: [], nextTick: 0, ticksLeft: 0, scanned: false },
      darknessUntil: 0,
      finale: null,            /* {phase, startTick, charge, waves, nextWaveTick} */
      stats: { killed: 0, contained: 0, escaped: 0, taken: 0, risen: 0, hosts: 0 },
      nextEntityCheck: 0
    };
  }

  var state = blankState();

  Anomaly.reset = function () {
    state = blankState();
    return Anomaly;
  };

  function detectNewGame(game) {
    /* A new colony rewinds the clock and nothing calls reset for us.
       A tick that has gone backwards by a day is the only reliable
       signal that this is a different run. */
    if (game.tick + TICKS_PER_DAY < state.lastSeenTick) Anomaly.reset();
    state.lastSeenTick = game.tick;
  }

  /* ============================================================
     3. CONTENT

     Terrain, things, pawn kinds, a faction, thoughts, mental
     states and hediffs. All registered at load, all additive.
     ============================================================ */

  Defs.add('terrain', {
    fleshTerrain: {
      label: 'flesh',
      description: 'The ground here is warm and it gives under a boot. Nothing will grow ' +
        'in it and nobody wants to walk across it twice.',
      color: '#7a3540', color2: '#96444e',
      pathCost: 6, fertility: 0,
      beauty: -8, cleanliness: -5,
      isWater: false, isNatural: false, passable: true, supportsPlants: false,
      terrainCategory: 'soil',
      buildCost: null, workToBuild: 0, buildCategory: null,
      researchPrerequisite: null, removable: false
    }
  });

  var ITEM = {
    category: 'item', sprite: 'item', stackLimit: 25, mass: 1.2,
    hp: 80, flammable: false, passable: true, pathCost: 0, fillPercent: 0,
    blocksLight: false, holdsRoof: false, size: { w: 1, h: 1 }, rotatable: false,
    beauty: 0, comfort: 0, natural: false, nutrition: 0, foodType: null, rotDays: null,
    isMedicine: false, medicinePotency: 0, buildCost: null, stuffable: false,
    workToBuild: 0, buildSkill: null, buildCategory: null, researchPrerequisite: null,
    recipes: null, leavings: null, mineable: false, mineYield: null,
    building: null, weapon: null, apparel: null
  };

  function bld(o) {
    var out = {
      isBed: false, isTable: false, isChair: false, isWorkbench: false,
      isDoor: false, isGrave: false, isTurret: false, isBattery: false,
      isConduit: false, isLamp: false, isGenerator: false, isResearchBench: false,
      isStove: false, isCampfire: false, isTrap: false, isSandbag: false,
      powerProduced: 0, powerConsumed: 0, batteryCapacity: 0, lightRadius: 0,
      tempPushTarget: null, tempPushRate: 0,
      bedRestEffectiveness: 0, bedComfort: 0, canBeForPrisoners: false,
      fuelDefId: null, fuelCapacity: 0, fuelBurnPerDay: 0,
      turretRange: 0, turretWeapon: null, interactionOffset: null, openTicks: 0
    };
    if (o) for (var k in o) out[k] = o[k];
    return out;
  }

  Defs.add('thing', {

    /* ---- the slab ---- */

    monolith: {
      label: 'monolith', sprite: 'sculpture', color: '#14121a', color2: '#4a3f6b',
      description: 'A slab of something that is not stone, standing upright in ground that ' +
        'has not been disturbed. It is colder than the air. Left alone it does nothing at ' +
        'all, which is the single most important fact about it.',
      category: 'building', stackLimit: 1, mass: 4000, hp: 3000, maxHp: 3000,
      passable: false, fillPercent: 1, blocksLight: true, holdsRoof: false,
      flammable: false, beauty: -6, marketValue: 0,
      natural: true, mineable: true, workToBuild: 90000, mineYield: null,
      leavings: null, building: bld({})
    },

    /* ---- what the entities leave behind ---- */

    voidShard: {
      label: 'void shard', sprite: 'chunk', color: '#3c2f52', color2: '#9d7fe0',
      description: 'A splinter that came out of something that should not have had a ' +
        'skeleton. It is warm on one face. Researchers take it apart and write things down.',
      stackLimit: 20, mass: 1.0, marketValue: 180
    },
    dreadmetal: {
      label: 'dreadmetal', sprite: 'ingot', color: '#4a4f5c', color2: '#8fa0b8',
      description: 'Rendered out of a contained entity over several unpleasant days. It is ' +
        'lighter than steel and it will not hold an edge unless the edge is meant for ' +
        'something that does not bleed.',
      stackLimit: 75, mass: 0.5, marketValue: 34
    },
    dreadSerum: {
      label: 'inhibitor serum', sprite: 'medkit', color: '#2c4a44', color2: '#7fe3c0',
      description: 'A dose that quiets whatever it is in the back of the skull that ' +
        'notices the monolith. It wears off. The people who take it regularly stop ' +
        'noticing other things too.',
      stackLimit: 25, mass: 0.2, marketValue: 120, isMedicine: false
    },

    /* ---- containment and dark study ---- */

    holdingPlatform: {
      label: 'holding platform', sprite: 'battery', color: '#2a2e3a', color2: '#9d7fe0',
      description: 'A plinth, a field emitter and a great deal of current. It holds one ' +
        'entity still. The field decays whenever the power does, and the thing inside ' +
        'is aware of that before you are.',
      category: 'building', stackLimit: 1, mass: 260, hp: 320,
      passable: false, fillPercent: 0.6, blocksLight: false, holdsRoof: false,
      beauty: -5, buildSkill: 'construction',
      size: { w: 1, h: 1 }, rotatable: false,
      buildCost: { steel: 120, components: 8 }, workToBuild: 3200,
      leavings: { steel: 40, components: 3 },
      building: bld({ powerConsumed: 250, interactionOffset: { dx: 0, dy: 1 } })
    },

    darkLab: {
      label: 'containment lab', sprite: 'research', color: '#232838', color2: '#9d7fe0',
      description: 'A bench, a shielded recorder and a shelf of notes nobody reads twice. ' +
        'Study happens here, and so does the slow business of turning shards into ' +
        'something a smith can work with.',
      category: 'building', stackLimit: 1, mass: 180, hp: 250,
      passable: false, fillPercent: 0.5, blocksLight: false, holdsRoof: false,
      beauty: -3, buildSkill: 'construction',
      size: { w: 2, h: 1 }, rotatable: true,
      buildCost: { steel: 100, components: 6 }, workToBuild: 2600,
      leavings: { steel: 35, components: 2 },
      building: bld({ isWorkbench: true, powerConsumed: 200, interactionOffset: { dx: 0, dy: 1 } })
    },

    anomalyScanner: {
      label: 'deep scanner', sprite: 'box', color: '#2e3a3a', color2: '#7fe3c0',
      description: 'A frame a person stands inside while it looks at what is under their ' +
        'skin. It was built to find tumours. It finds other things.',
      category: 'building', stackLimit: 1, mass: 200, hp: 260,
      passable: false, fillPercent: 0.5, blocksLight: false, holdsRoof: false,
      beauty: -2, buildSkill: 'construction',
      size: { w: 1, h: 1 }, rotatable: false,
      buildCost: { steel: 90, components: 10 }, workToBuild: 2800,
      leavings: { steel: 30, components: 4 },
      building: bld({ powerConsumed: 300, interactionOffset: { dx: 0, dy: 1 } })
    },

    wardLamp: {
      label: 'ward lamp', sprite: 'lamp', color: '#4a4436', color2: '#ffe9a8',
      description: 'A lamp with a second filament that burns in a colour nothing likes. ' +
        'It cannot be put out by the thing that puts lamps out.',
      category: 'building', stackLimit: 1, mass: 40, hp: 110,
      passable: true, fillPercent: 0.2, blocksLight: false, holdsRoof: false,
      beauty: 2, buildSkill: 'construction',
      size: { w: 1, h: 1 }, rotatable: false,
      buildCost: { steel: 40, components: 3, dreadmetal: 10 }, workToBuild: 1400,
      leavings: { steel: 12, components: 1 },
      building: bld({ isLamp: true, powerConsumed: 90, lightRadius: 9 })
    },

    voidAnchor: {
      label: 'void anchor', sprite: 'turret', color: '#1c2030', color2: '#c8a8ff',
      description: 'Six tonnes of dreadmetal wound around a shard the size of a fist. ' +
        'Powered and undisturbed beside the monolith, it does not destroy the thing. It ' +
        'holds it still long enough for the colony to finish the argument.',
      category: 'building', stackLimit: 1, mass: 1200, hp: 900,
      passable: false, fillPercent: 1, blocksLight: true, holdsRoof: true,
      beauty: -12, buildSkill: 'construction',
      size: { w: 2, h: 2 }, rotatable: false,
      buildCost: { dreadmetal: 180, components: 24, voidShard: 8, steel: 200 },
      workToBuild: 12000,
      leavings: { steel: 60, components: 6 },
      building: bld({ powerConsumed: 1400 })
    },

    ritualPillar: {
      label: 'ritual pillar', sprite: 'sculpture', color: '#3a2030', color2: '#c04a5a',
      description: 'It was not here yesterday. The ground around it is arranged, and the ' +
        'arrangement means something to whoever did it. Pulling it down helps. Leaving it ' +
        'up is a decision too.',
      category: 'building', stackLimit: 1, mass: 300, hp: 260,
      passable: false, fillPercent: 1, blocksLight: true, holdsRoof: false,
      beauty: -14, marketValue: 0,
      natural: true, mineable: true, workToBuild: 1600,
      mineYield: { voidShard: 2 },
      leavings: null, building: bld({})
    },

    /* ---- weapons worth the whole dark tree ---- */

    dreadBlade: {
      label: 'dread blade', sprite: 'knife', color: '#6a7080', color2: '#c8a8ff',
      description: 'Dreadmetal takes an edge only against things that are not properly ' +
        'alive. Against a raider it is a heavy, badly balanced knife.',
      category: 'item', stackLimit: 1, mass: 1.6, marketValue: 620, hp: 140,
      weapon: {
        ranged: false, damage: 21, damageType: 'cut', range: 1,
        warmupTicks: 0, cooldownTicks: 100, burstCount: 1, burstTicks: 0,
        accuracy: { touch: 0.9, short: 0, medium: 0, long: 0 },
        armorPen: 0.45, projectileSpeed: 0, projectileDef: null,
        minRange: 0, forcedMissRadius: 0
      }
    },

    shardLance: {
      label: 'shard lance', sprite: 'rifle', color: '#4a4f5c', color2: '#c8a8ff',
      description: 'A shard held under tension and let go. It is slow, it is loud, and it ' +
        'goes through a fleshbeast lengthways.',
      category: 'item', stackLimit: 1, mass: 4.2, marketValue: 1700, hp: 120,
      weapon: {
        ranged: true, damage: 29, damageType: 'cut', range: 26,
        warmupTicks: 110, cooldownTicks: 150, burstCount: 1, burstTicks: 0,
        accuracy: { touch: 0.5, short: 0.76, medium: 0.74, long: 0.6 },
        armorPen: 0.5, projectileSpeed: 95, projectileDef: 'bullet',
        minRange: 0, forcedMissRadius: 0
      }
    }

  }, ITEM);

  /* Everything produced here is made at the containment lab, so the
     recipes appear exactly when the lab does - which is itself behind
     the first stage. Ingredients come off entities, so a colony that
     has never contained anything cannot run a single one of them. */
  Defs.add('recipe', {
    renderEntity: {
      label: 'dreadmetal', jobString: 'Rendering shards into dreadmetal', uiCategory: 'anomaly',
      workAmount: 1400, skill: 'crafting', skillRequirement: 4,
      workbenches: ['darkLab'],
      ingredients: [{ thing: 'voidShard', count: 2 }, { thing: 'steel', count: 20 }],
      products: { dreadmetal: 14 },
      defaultRepeat: 'untilHave', defaultTargetCount: 80,
      description: 'Shard, flux and a very slow furnace. The smell stays in the room.'
    },
    brewDreadSerum: {
      label: 'inhibitor serum', jobString: 'Brewing inhibitor serum', uiCategory: 'anomaly',
      workAmount: 900, skill: 'intellectual', skillRequirement: 5,
      workbenches: ['darkLab'],
      ingredients: [{ thing: 'voidShard', count: 1 }, { thing: 'medicine', count: 2 }],
      products: { dreadSerum: 4 },
      defaultRepeat: 'untilHave', defaultTargetCount: 12,
      description: 'Four doses per shard. Enough to get one bad night out of somebody.'
    },
    forgeDreadBlade: {
      label: 'dread blade', jobString: 'Forging a dread blade', uiCategory: 'anomaly',
      workAmount: 2600, skill: 'crafting', skillRequirement: 7,
      workbenches: ['darkLab'],
      ingredients: [{ thing: 'dreadmetal', count: 40 }, { thing: 'steel', count: 20 }],
      products: { dreadBlade: 1 },
      defaultRepeat: 'count', defaultTargetCount: 2,
      description: 'Two days of a good crafter for a knife that is wrong in the hand.'
    },
    forgeShardLance: {
      label: 'shard lance', jobString: 'Building a shard lance', uiCategory: 'anomaly',
      workAmount: 5000, skill: 'crafting', skillRequirement: 10,
      workbenches: ['darkLab'],
      ingredients: [{ thing: 'dreadmetal', count: 70 }, { thing: 'components', count: 8 },
                    { thing: 'voidShard', count: 3 }],
      products: { shardLance: 1 },
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'The only thing in the colony that a metalhorror is afraid of.'
    }
  });

  /* ---- the entities ---- */

  var HUMANOID_DEFAULTS = {
    race: 'human', isAnimal: false, body: 'human', sprite: 'human',
    defaultFaction: FACTION, techLevel: 'animal',
    baseHealthScale: 1, healthScale: 1, moveSpeed: 4.6, moveSpeedFactor: 1,
    baseBodySize: 1, bodySize: 1, drawSize: 1,
    baseHungerRate: 0.05, hungerRateFactor: 0.05,
    lifeExpectancyYears: 400, ageRange: [3, 40],
    weapons: [], apparel: [],
    meleeDamage: 10, meleeDamageType: 'blunt', meleeCooldownTicks: 120,
    meleeArmorPen: 0, meleeSkill: 5,
    comfyTempMin: -80, comfyTempMax: 90,
    armorSharp: 0, armorBlunt: 0, armorHeat: 0,
    trainability: null, wildness: 1, packAnimal: false, predator: false,
    grazer: false, nocturnal: false, breeds: false, diet: 'omnivore',
    butcherProducts: null, leatherAmount: 0,
    manhunterChance: 1, revengeChance: 1, manhunterOnTameFail: 1,
    explodeOnDeath: false, explodes: false, nuzzles: false,
    color2: '#9d7fe0'
  };

  Defs.add('pawnKind', {
    shambler: {
      label: 'shambler',
      description: 'It was a person, or it was near a person. It walks at the speed of a ' +
        'tired man and it does not stop walking, and when you put it down it is not ' +
        'necessarily down.',
      combatPower: 55,
      baseHealthScale: 1.35, healthScale: 1.35,
      moveSpeed: 2.3, meleeDamage: 13, meleeDamageType: 'blunt',
      meleeCooldownTicks: 140, meleeSkill: 3,
      armorBlunt: 0.30, armorSharp: 0.05,
      color: '#6a6458', color2: '#9a3a3a'
    },
    metalhorror: {
      label: 'metalhorror',
      description: 'It came out of one of yours. It is mostly edges and it has been ' +
        'listening to your colony from the inside for a week.',
      combatPower: 240,
      baseHealthScale: 1.9, healthScale: 1.9,
      moveSpeed: 5.0, meleeDamage: 24, meleeDamageType: 'cut',
      meleeCooldownTicks: 90, meleeSkill: 9, meleeArmorPen: 0.4,
      armorSharp: 0.48, armorBlunt: 0.35,
      color: '#8f97a3', color2: '#c04a5a'
    },
    revenant: {
      label: 'revenant',
      description: 'Tall, thin, and it has never once been seen moving. It takes one ' +
        'person at a time and it goes back to wherever it sleeps.',
      combatPower: 200,
      baseHealthScale: 1.5, healthScale: 1.5,
      moveSpeed: 5.6, meleeDamage: 16, meleeDamageType: 'cut',
      meleeCooldownTicks: 100, meleeSkill: 8,
      armorSharp: 0.30, armorBlunt: 0.25,
      color: '#2a2434', color2: '#c8a8ff'
    }
  }, HUMANOID_DEFAULTS);

  var BEAST_DEFAULTS = {
    race: 'animal', isAnimal: true, body: 'quadruped', sprite: 'wolf',
    defaultFaction: FACTION, techLevel: 'animal',
    moveSpeedFactor: 1, weapons: [], apparel: [],
    baseHungerRate: 0.05, hungerRateFactor: 0.05,
    baseBodySize: 1, bodySize: 1, drawSize: 1.2,
    baseHealthScale: 1, healthScale: 1, moveSpeed: 4.6,
    lifeExpectancyYears: 200, ageRange: [1, 20],
    meleeDamageType: 'bite', meleeArmorPen: 0, meleeSkill: 6,
    meleeDamage: 14, meleeCooldownTicks: 110,
    armorSharp: 0, armorBlunt: 0, armorHeat: 0,
    diet: 'carnivore', grazer: false, predator: true,
    wildness: 1, trainability: 'none', packSize: [2, 5],
    packAnimal: false, nocturnal: false, breeds: false,
    comfyTempMin: -80, comfyTempMax: 90,
    manhunterChance: 1, revengeChance: 1, manhunterOnTameFail: 1,
    explodeOnDeath: false, explodes: false, nuzzles: false,
    butcherProducts: null, leatherAmount: 0, color2: '#9d7fe0'
  };

  Defs.add('pawnKind', {
    fleshbeast: {
      label: 'fleshbeast',
      description: 'A long muscle with teeth at one end. It does not use doors and it does ' +
        'not go around walls; it goes through them, slowly, and then quickly.',
      combatPower: 120,
      baseHealthScale: 1.1, healthScale: 1.1,
      baseBodySize: 1.1, bodySize: 1.1, drawSize: 1.3,
      moveSpeed: 6.0, meleeDamage: 17, meleeDamageType: 'cut',
      meleeCooldownTicks: 85, meleeSkill: 7, meleeArmorPen: 0.2,
      armorSharp: 0.15, armorBlunt: 0.22,
      butcherProducts: { meatRaw: 24 },
      color: '#9a4550', color2: '#d4707a', sprite: 'wolf'
    },
    sightstealer: {
      label: 'sightstealer',
      description: 'Nobody has described it, because everybody who was close enough was in ' +
        'the dark at the time. Lamps go out ahead of it. Bring light or bring nothing.',
      combatPower: 150,
      baseHealthScale: 0.85, healthScale: 0.85,
      baseBodySize: 0.9, bodySize: 0.9, drawSize: 1.15,
      moveSpeed: 6.6, meleeDamage: 22, meleeDamageType: 'cut',
      meleeCooldownTicks: 80, meleeSkill: 9, meleeArmorPen: 0.3,
      armorSharp: 0.10, armorBlunt: 0.10,
      color: '#14121a', color2: '#3c3450', sprite: 'wolf'
    },
    devourer: {
      label: 'devourer',
      description: 'Enormous, unhurried, and its mouth opens further than its head is wide. ' +
        'What it takes is not dead yet. That is the part that matters.',
      combatPower: 230,
      baseHealthScale: 2.3, healthScale: 2.3,
      baseBodySize: 2.2, bodySize: 2.2, drawSize: 1.9,
      moveSpeed: 4.0, meleeDamage: 19, meleeDamageType: 'blunt',
      meleeCooldownTicks: 130, meleeSkill: 7,
      armorSharp: 0.30, armorBlunt: 0.38,
      butcherProducts: { meatRaw: 60 },
      color: '#5a3a44', color2: '#c8a8ff', sprite: 'bear'
    }
  }, BEAST_DEFAULTS);

  Defs.add('faction', {
    anomaly: {
      label: 'the unquiet', color: '#9d7fe0',
      description: 'Not a civilization, not wildlife, and not interested in terms.',
      hostileToPlayer: true, techLevel: 'animal', isPlayer: false
    }
  });

  Defs.add('thought', {
    dreadWeight: {
      label: 'Dread', durationDays: 0.4, stackLimit: 1,
      nullifiedByTrait: ['psychopath'],
      stages: [
        { label: 'Uneasy', mood: -3 },
        { label: 'Cannot stop listening', mood: -9 },
        { label: 'Something is wrong with the air', mood: -16 },
        { label: 'It knows my name', mood: -24 }
      ]
    },
    sawEntity: {
      label: 'Saw something', durationDays: 2.5, stackLimit: 3,
      nullifiedByTrait: ['psychopath'],
      stages: [{ label: 'Saw something that should not exist', mood: -7 }]
    },
    monolithWoke: {
      label: 'The slab woke up', durationDays: 12, stackLimit: 1,
      stages: [{ label: 'We woke the slab up', mood: -8 }]
    },
    entityContained: {
      label: 'It is in a box now', durationDays: 6, stackLimit: 2,
      stages: [{ label: 'We put one of them in a box', mood: 5 }]
    },
    hollowed: {
      label: 'Hollow', durationDays: 9999, stackLimit: 1,
      stages: [{ label: 'There is nothing behind my eyes any more', mood: -12 }]
    },
    shardsight: {
      label: 'Shardsight', durationDays: 9999, stackLimit: 1,
      stages: [{ label: 'I have read too much of it', mood: -5 }]
    },
    anomalyEnded: {
      label: 'We put it out', durationDays: 40, stackLimit: 1,
      stages: [{ label: 'We stood in front of it and it stopped', mood: 22 }]
    },
    anomalyLost: {
      label: 'It did not stop', durationDays: 25, stackLimit: 1,
      stages: [{ label: 'We stood in front of it and it did not stop', mood: -20 }]
    }
  });

  Defs.add('mentalState', {
    dreadWhispers: {
      label: 'Listening', breakLevel: 'minor', jobId: 'mentalWander',
      description: 'Stops answering and walks towards whatever is talking. It is not ' +
        'talking from anywhere.',
      durationTicks: [5000, 12000]
    },
    dreadFlight: {
      label: 'Blind panic', breakLevel: 'minor', jobId: 'flee', canBeVoluntary: true,
      description: 'Runs, and keeps running long after there is nothing to run from.',
      durationTicks: [3000, 8000]
    },
    dreadRage: {
      label: 'Dread fury', breakLevel: 'major', jobId: 'mentalBerserk', isAggressive: true,
      description: 'Attacks the nearest living thing because the alternative is standing ' +
        'still and thinking about it.',
      durationTicks: [3000, 7000]
    },
    dreadCatatonia: {
      label: 'Dread catatonia', breakLevel: 'extreme', jobId: 'mentalDaze',
      description: 'Sits down facing the wall and stops. Feeding them is somebody else\'s ' +
        'job now.',
      durationTicks: [12000, 30000]
    }
  }, {
    thought: 'catharsis',
    blocksWork: true,
    isAggressive: false,
    canBeVoluntary: false,
    breakLevel: 'minor'
  });

  /* Hediffs go straight into health.js's table, which is how every
     other late system adds a condition without editing that file. */
  (function registerHediffs() {
    var H = sys('Health');
    if (!H || !H.HEDIFFS) return;
    var add = {
      metalhorrorImplant: {
        id: 'metalhorrorImplant', label: 'unidentified mass', lethal: false,
        painOffset: 0.03, isDisease: false,
        capMods: { consciousness: -0.04 }
      },
      dreadShock: {
        id: 'dreadShock', label: 'dread shock', lethal: false, driven: true,
        painOffset: 0.05,
        capMods: { consciousness: -0.25, manipulation: -0.20, moving: -0.10 }
      },
      swallowed: {
        id: 'swallowed', label: 'swallowed', lethal: true, driven: true,
        painOffset: 0.55,
        capMods: { consciousness: -0.90, moving: -0.95, manipulation: -0.90, breathing: -0.50 },
        deathCause: 'being digested'
      },
      hypnotised: {
        id: 'hypnotised', label: 'hypnotised', lethal: false, driven: true,
        painOffset: 0,
        capMods: { consciousness: -0.85, moving: -0.90, manipulation: -0.85 }
      },
      serumCalm: {
        id: 'serumCalm', label: 'inhibitor serum', lethal: false, driven: true,
        painOffset: 0, capMods: { consciousness: -0.05 }
      }
    };
    for (var k in add) if (!H.HEDIFFS[k]) H.HEDIFFS[k] = add[k];
  })();

  /* The unquiet fight everyone. combat.js keeps a small relation table
     for exactly this: a faction that arrives late declares itself. */
  (function declareRelations() {
    var C = sys('Combat');
    if (!C || !C.setRelation) return;
    ['player', 'raider', 'neutral'].forEach(function (f) { C.setRelation(FACTION, f, true); });
  })();

  /* ============================================================
     4. THE DARK RESEARCH TREE

     A second currency and a second tree, entirely inside this file.
     Nodes buy buildings and mechanics, never recipes: the recipes
     live on the containment lab, and the lab is itself node one.
     ============================================================ */

  var TREE = [
    {
      id: 'containment', label: 'containment fields', cost: 0, stage: 1,
      unlocks: ['holdingPlatform', 'darkLab'],
      blurb: 'A field that holds one of them still, and a bench to work beside it.'
    },
    {
      id: 'dissection', label: 'dissection protocol', cost: 15, stage: 1,
      unlocks: [],
      blurb: 'Study sessions yield half again as much, and a killed entity leaves a shard.'
    },
    {
      id: 'scanning', label: 'deep scanning', cost: 22, stage: 2,
      unlocks: ['anomalyScanner'],
      blurb: 'A frame that sees what is living inside a colonist before it comes out.'
    },
    {
      id: 'wardlight', label: 'ward light', cost: 30, stage: 2,
      unlocks: ['wardLamp'],
      blurb: 'A lamp the dark cannot reach into.'
    },
    {
      id: 'suppression', label: 'field suppression', cost: 40, stage: 3,
      unlocks: [],
      blurb: 'Containment decays at two fifths the rate. Breaches become a choice again.'
    },
    {
      id: 'inoculation', label: 'inoculation', cost: 45, stage: 4,
      unlocks: [],
      blurb: 'Colonists build resistance to dread twice as fast, and break less deeply.'
    },
    {
      id: 'unmaking', label: 'unmaking', cost: 80, stage: 5,
      unlocks: ['voidAnchor'],
      blurb: 'How to hold the slab still. Not how to destroy it: nobody knows that.'
    }
  ];

  var TREE_BY_ID = {};
  TREE.forEach(function (n) { TREE_BY_ID[n.id] = n; });

  var STAGE_COST = [0, 0, 18, 30, 48, 70, 0];
  var STAGE_LABEL = [
    'dormant', 'awake', 'disturbed', 'restless', 'waking', 'calling', 'silent'
  ];

  Anomaly.stage = function () { return state.stage; };
  Anomaly.stageLabel = function (s) {
    return STAGE_LABEL[U.clamp(s === undefined ? state.stage : s, 0, STAGE_MAX)];
  };
  Anomaly.darkPoints = function () { return state.dark; };
  Anomaly.has = function (nodeId) { return !!state.tree[nodeId]; };
  Anomaly.tree = function () {
    return TREE.map(function (n) {
      return {
        id: n.id, label: n.label, cost: n.cost, stage: n.stage, blurb: n.blurb,
        bought: !!state.tree[n.id],
        available: !state.tree[n.id] && state.stage >= n.stage && state.dark >= n.cost,
        locked: state.stage < n.stage
      };
    });
  };

  /* A node's buildings become buildable by getting a buildCategory,
     which is the only gate the architect has. Registering them
     without one is what keeps an untouched colony from ever seeing
     a holding platform in its build menu. */
  var BUILD_CATEGORY = {
    holdingPlatform: 'misc', darkLab: 'production', anomalyScanner: 'production',
    wardLamp: 'power', voidAnchor: 'misc'
  };

  function applyUnlocks(node) {
    for (var i = 0; i < node.unlocks.length; i++) {
      var id = node.unlocks[i];
      var def = Defs.maybe('thing', id);
      if (def && !def.buildCategory) def.buildCategory = BUILD_CATEGORY[id] || 'misc';
    }
    if (Defs.clearCache) Defs.clearCache();
  }

  Anomaly.buy = function (nodeId) {
    var node = TREE_BY_ID[nodeId];
    if (!node) return false;
    if (state.tree[nodeId]) return false;
    if (state.stage < node.stage) return false;
    if (state.dark < node.cost) return false;
    state.dark -= node.cost;
    state.spent += node.cost;
    state.tree[nodeId] = true;
    applyUnlocks(node);
    letter('Dark research: ' + node.label,
      node.blurb + ' Reading it through once is enough to understand why the notes are ' +
      'kept in a locked box.', 'neutral');
    mirror();
    return true;
  };

  function grantDark(amount, why, at) {
    if (!(amount > 0)) return 0;
    if (state.tree.dissection) amount = Math.round(amount * 1.5);
    state.dark += amount;
    msg(amount + ' dark research' + (why ? ' - ' + why : '') + '.', 'info', at);
    return amount;
  }
  Anomaly.grantDark = grantDark;

  /* ============================================================
     5. THE MONOLITH

     Placed once, far from the colony, and inert. The player's way
     in is the mine tool: a slab that answers canMine is a slab the
     player can drag a designation across, and doing that is a
     decision nobody made for them.
     ============================================================ */

  function monolith(map) {
    if (!map || !map.byDef) return null;
    if (state.monolithId) {
      var t = map.thing(state.monolithId);
      if (t && t.spawned) return t;
    }
    var list = map.byDef('monolith');
    var found = list && list.length ? list[0] : null;
    state.monolithId = found ? found.id : 0;
    return found;
  }
  Anomaly.monolith = function () {
    var g = G();
    return g && g.map ? monolith(g.map) : null;
  };

  function placeMonolith(game, map) {
    if (state.placed || monolith(map)) { state.placed = true; return; }
    var c = colonyCentre(map);
    var best = null;
    for (var attempt = 0; attempt < 220 && !best; attempt++) {
      var ang = U.rand() * 6.283185307179586;
      var r = U.randRange(20, Math.min(46, Math.min(map.w, map.h) * 0.4));
      var x = Math.round(c.x + Math.cos(ang) * r);
      var y = Math.round(c.y + Math.sin(ang) * r);
      if (x < 3 || y < 3 || x >= map.w - 3 || y >= map.h - 3) continue;
      if (!map.passable(x, y)) continue;
      if (map.buildingAt(x, y)) continue;
      var terrain = map.terrainAt(x, y);
      if (terrain && terrain.isWater) continue;
      /* It must not be the one tile holding a corridor open: count the
         neighbours that stay walkable once the slab is standing. */
      var open = 0;
      for (var k = 0; k < U.ADJ8.length; k++) {
        var nx = x + U.ADJ8[k][0], ny = y + U.ADJ8[k][1];
        if (map.inBounds(nx, ny) && map.passable(nx, ny)) open++;
      }
      if (open < 6) continue;
      best = { x: x, y: y };
    }
    if (!best) best = freeCellNear(map, c.x + 24, c.y + 12, 20);
    if (!best) return;

    var plant = map.plantAt(best.x, best.y);
    if (plant) map.destroyThing(plant, 'monolith');
    var slab = map.spawnThing('monolith', best.x, best.y, { faction: null });
    if (!slab) return;
    state.monolithId = slab.id;
    state.placed = true;
    map.markPathDirty(best.x, best.y);
    var R = sys('Regions');
    if (R && R.markDirty) R.markDirty(map, best.x, best.y);

    letter('Something is standing out there',
      'There is a slab of black material standing upright about ' +
      Math.round(U.dist(best.x, best.y, c.x, c.y)) + ' tiles from the landing site. The ' +
      'ground around it has never been dug. It is colder than the air and it is doing ' +
      'nothing at all.\n\nYou can leave it alone. Nothing bad happens to a colony that ' +
      'leaves it alone. If you would rather find out, mark it for mining and send ' +
      'somebody over to put a hand on it.',
      'neutral', best);
  }

  /* The mine designation is the player saying yes. It is taken off
     the map immediately, because this is not going to be a mining
     job: the work giver below sends somebody to touch it instead. */
  function tickTouch(game, map) {
    var slab = monolith(map);
    if (!slab) return;
    if (state.stage > 0) {
      if (map.designationAt(slab.x, slab.y, 'mine')) map.undesignate(slab.x, slab.y, 'mine');
      return;
    }
    if (map.designationAt(slab.x, slab.y, 'mine')) {
      map.undesignate(slab.x, slab.y, 'mine');
      if (!state.touchWanted) {
        state.touchWanted = true;
        msg('Somebody is going to have a look at the slab.', 'info', slab);
      }
    }
  }

  Anomaly.touchWanted = function () { return state.touchWanted && state.stage <= 0; };
  Anomaly.orderTouch = function () {
    if (state.stage > 0) return false;
    state.touchWanted = true;
    return true;
  };

  Anomaly.touch = function (pawn) {
    if (state.stage > 0) return false;
    var g = G(), map = g && g.map;
    var slab = map ? monolith(map) : null;
    if (!slab) return false;
    state.touchWanted = false;
    state.touched = true;
    state.touchTick = now();
    setStage(1, pawn);
    if (pawn) {
      dread(pawn).dread = Math.min(1, dread(pawn).dread + 0.35);
      addThought(pawn, 'monolithWoke');
    }
    return true;
  };

  function setStage(next, at) {
    next = U.clamp(next | 0, 0, STAGE_MAX);
    if (next <= state.stage) return false;
    state.stage = next;
    if (next === 1) {
      /* Node one is the price of admission, not a purchase. */
      state.tree.containment = true;
      applyUnlocks(TREE_BY_ID.containment);
    }
    for (var i = 0; i < TREE.length; i++) {
      if (state.tree[TREE[i].id]) applyUnlocks(TREE[i]);
    }
    var texts = [
      '',
      'The slab is warm now, and it is humming at a pitch nobody can quite hear. Something ' +
      'about the map has changed and none of the instruments agree about what. Whatever ' +
      'comes next, you started it.',
      'The hum has words in it. Colonists have begun sleeping badly in rooms that are ' +
      'perfectly warm, and the dead in the ground outside are not lying the way they were ' +
      'buried.',
      'The slab has opened along one face. Things are coming out of the ground now rather ' +
      'than across the map edge, and one of them is not coming out at all yet.',
      'The dark comes early and it comes wrong. There is something in it that is putting ' +
      'out lamps ahead of itself, methodically, like a man closing a house for the night.',
      'The slab is calling and the colony can hear it from inside the walls. It wants ' +
      'somebody to come and stand in front of it. Build the anchor, or keep paying for ' +
      'the privilege of not building it.',
      'It is quiet.'
    ];
    var kinds = ['neutral', 'threat', 'threat', 'threat', 'threat', 'threat', 'good'];
    var g = G();
    letter('The monolith: ' + STAGE_LABEL[next], texts[next] || '', kinds[next] || 'threat',
      at || (g && g.map ? monolith(g.map) : null));

    /* Everybody feels a stage change, whether or not they were there. */
    if (g && g.map) {
      var list = colonists(g.map);
      for (var c = 0; c < list.length; c++) {
        var d = dread(list[c]);
        d.dread = Math.min(1, d.dread + 0.06 * next);
      }
    }
    debugLog('stage -> ' + next);
    mirror();
    return true;
  }
  Anomaly.setStage = setStage;

  Anomaly.stageCost = function () {
    if (state.stage < 1 || state.stage >= 5) return 0;
    return STAGE_COST[state.stage + 1] || 0;
  };

  /* Escalating is bought, at the slab, with the same points the
     tree wants. That is the whole tension of the system. */
  Anomaly.commune = function () {
    if (state.stage < 1 || state.stage >= 5) return false;
    var cost = STAGE_COST[state.stage + 1];
    if (state.dark < cost) return false;
    state.dark -= cost;
    state.spent += cost;
    return setStage(state.stage + 1);
  };

  /* ============================================================
     6. DREAD

     A second meter, on its own clock, with its own breaks. It
     leaks into mood through one thought so the player can see it
     in the needs tab, but the breaks it causes are not mood
     breaks and ironWilled does not simply switch them off.
     ============================================================ */

  function dread(pawn) {
    var a = pawn.anomaly;
    if (!a) {
      a = pawn.anomaly = {
        dread: 0, resist: 0, peak: 0, breaks: 0, hollow: false,
        studied: 0, shardsight: false,
        infestedTick: 0, emergeTick: 0, infestedKnown: false,
        swallowedBy: 0, digest: 0,
        lurking: false, strikeTick: 0, hunted: false,
        serumTicks: 0
      };
      /* Who the colony already is decides where they start. */
      var traits = pawn.traits || [];
      if (traits.indexOf('psychopath') >= 0) a.resist = 0.75;
      else if (traits.indexOf('ironWilled') >= 0) a.resist = 0.40;
      else if (traits.indexOf('toosmart') >= 0) a.resist = 0.15;
      if (traits.indexOf('neurotic') >= 0) a.resist -= 0.18;
      if (traits.indexOf('wimp') >= 0) a.resist -= 0.12;
      if (traits.indexOf('volatile') >= 0) a.resist -= 0.10;
      a.resist = U.clamp(a.resist, -0.3, 0.9);
    }
    return a;
  }
  Anomaly.dreadOf = function (pawn) { return pawn ? dread(pawn).dread : 0; };
  Anomaly.state = dread;

  function addThought(pawn, id, opts) {
    var N = sys('Needs');
    if (N && N.addThought) N.addThought(pawn, id, opts || {});
  }

  function addDread(pawn, amount, reason) {
    if (!pawn || pawn.dead || !pawn.isHuman) return 0;
    var a = dread(pawn);
    if (a.hollow) return 0;
    if (amount > 0) {
      if (a.serumTicks > 0) amount *= 0.35;
      amount *= 1 - U.clamp01(a.resist) * 0.7;
    }
    a.dread = U.clamp01(a.dread + amount);
    if (a.dread > a.peak) a.peak = a.dread;
    if (reason && amount > 0.1) debugLog(nameOf(pawn) + ' +' + U.fmt(amount, 2) + ' dread (' + reason + ')');
    return amount;
  }
  Anomaly.addDread = addDread;

  var DREAD_STAGES = [0.30, 0.55, 0.78];

  function dreadDegree(v) {
    var d = 0;
    for (var i = 0; i < DREAD_STAGES.length; i++) if (v >= DREAD_STAGES[i]) d = i + 1;
    return d;
  }

  function dreadBreak(pawn, a) {
    var Th = sys('Think');
    if (!Th || !Th.startMentalState) return false;
    if (pawn.mentalState) return false;
    var soft = state.tree.inoculation;
    var pool;
    if (a.dread > 0.92) pool = soft ? ['dreadWhispers', 'dreadRage', 'dreadFlight'] : ['dreadCatatonia', 'dreadRage'];
    else if (a.dread > 0.78) pool = ['dreadRage', 'dreadFlight', 'dreadWhispers'];
    else pool = ['dreadWhispers', 'dreadFlight'];
    var id = U.pick(pool);
    if (!Th.startMentalState(pawn, id)) return false;
    a.breaks++;
    /* Surviving one is what teaches the resistance. */
    a.resist = U.clamp(a.resist + (state.tree.inoculation ? 0.10 : 0.05), -0.3, 0.9);
    a.dread = Math.max(0, a.dread - 0.30);
    letter(nameOf(pawn) + ' has broken',
      nameOf(pawn) + ' is ' + (Defs.maybe('mentalState', id) || { label: 'not right' }).label
        .toLowerCase() + '. It is not the mood. It is the other thing.',
      'threat', pawn);
    return true;
  }

  function goHollow(pawn, a) {
    a.hollow = true;
    a.dread = 0.5;
    a.resist = 0.9;
    addThought(pawn, 'hollowed');
    /* A hollowed colonist is not useless, but they will never do the
       work that hollowed them again. */
    if (pawn.workPriority) {
      pawn.workPriority.research = 0;
      pawn.workPriority.intellectual = 0;
    }
    var H = sys('Health');
    if (H && H.addHediff) H.addHediff(pawn, 'dreadShock', 0.4);
    letter(nameOf(pawn) + ' is hollow',
      nameOf(pawn) + ' stopped in the middle of a sentence three days ago and has not ' +
      'finished it. They eat, they walk where they are sent, and they will not go near ' +
      'a bench again.',
      'death', pawn);
    state.stats.taken++;
  }

  function tickDread(game, map) {
    /* Dread is a slow meter; it does not need looking at eight times a
       minute. Once every four anomaly ticks is twice a game hour. */
    if ((game.tick % (SLOW * 4)) !== 0) return;
    var list = colonists(map);
    if (!list.length) return;
    var slab = monolith(map);
    var entities = liveEntities(map);
    var dark = state.darknessUntil > now();
    var stageWeight = 0.004 * state.stage;

    for (var i = 0; i < list.length; i++) {
      var pawn = list[i];
      if (pawn.dead) continue;
      var a = dread(pawn);
      if (a.serumTicks > 0) a.serumTicks = Math.max(0, a.serumTicks - SLOW * 4);

      var gain = 0;
      if (slab && state.stage > 0) {
        var d = U.cheb(pawn.x, pawn.y, slab.x, slab.y);
        var reach = 7 + state.stage * 4;
        if (d < reach) gain += stageWeight * (1 - d / reach) * 3;
      }
      for (var e = 0; e < entities.length; e++) {
        var dist = U.cheb(pawn.x, pawn.y, entities[e].x, entities[e].y);
        if (dist <= 14) gain += 0.024 * (1 - dist / 15);
      }
      if (dark && lightAt(map, pawn.x, pawn.y) < 0.2) gain += 0.016;
      var terrain = map.terrainAt(pawn.x, pawn.y);
      if (terrain && terrain.id === 'fleshTerrain') gain += 0.006;
      /* Standing next to a contained entity is a different, quieter
         kind of bad: it is behind a field, but it is there. */
      var platforms = map.byDef('holdingPlatform') || [];
      for (var p = 0; p < platforms.length; p++) {
        if (!platforms[p].holdKind) continue;
        if (U.cheb(pawn.x, pawn.y, platforms[p].x, platforms[p].y) <= 5) gain += 0.004;
      }

      if (gain > 0) {
        addDread(pawn, gain, 'ambient');
      } else if (!a.hollow) {
        /* Quiet, lit, roofed and far from all of it: the meter falls. */
        var calm = 0.010;
        if (map.hasRoofAt(pawn.x, pawn.y) && lightAt(map, pawn.x, pawn.y) > 0.4) calm = 0.018;
        if (pawn.asleep) calm *= 1.6;
        a.dread = Math.max(0, a.dread - calm);
      }

      if (a.dread > 0.35 && !a.hollow) {
        a.resist = U.clamp(a.resist + (state.tree.inoculation ? 0.0040 : 0.0020), -0.3, 0.9);
      }

      var degree = dreadDegree(a.dread);
      if (degree > 0) addThought(pawn, 'dreadWeight', { degree: degree - 1, situational: true });

      if (a.hollow) continue;
      if (a.dread >= 0.999 && a.resist < 0.35 && U.chance(0.25)) { goHollow(pawn, a); continue; }
      if (a.dread > 0.55 && !pawn.mentalState) {
        var p95 = (a.dread - 0.5) * 0.10 * (1 - U.clamp01(a.resist));
        if (U.chance(p95)) dreadBreak(pawn, a);
      }
    }
  }

  /* Anything that is watched happening: a death, a thing coming out
     of the floor, somebody being swallowed. */
  function witness(map, x, y, amount, thoughtId) {
    var list = colonists(map);
    for (var i = 0; i < list.length; i++) {
      var pawn = list[i];
      if (pawn.dead) continue;
      if (U.cheb(pawn.x, pawn.y, x, y) > 16) continue;
      var C = sys('Combat');
      if (C && C.lineOfSight && !C.lineOfSight(map, pawn.x, pawn.y, x, y)) continue;
      addDread(pawn, amount, 'witness');
      if (thoughtId) addThought(pawn, thoughtId);
    }
  }
  Anomaly.witness = witness;

  Anomaly.takeSerum = function (pawn) {
    if (!pawn) return false;
    var a = dread(pawn);
    a.serumTicks = 18000;
    a.dread = Math.max(0, a.dread - 0.28);
    /* Every dose narrows them a little. Four of them and the thing
       that was protecting the mind has eaten part of it. */
    a.resist = U.clamp(a.resist - 0.04, -0.3, 0.9);
    var H = sys('Health');
    if (H && H.addHediff) H.addHediff(pawn, 'serumCalm', 0.5);
    return true;
  };

  /* ============================================================
     7. ENTITIES

     Spawning, and the per-kind behaviour that makes each of them a
     different problem. The base AI is animals.js's manhunter for
     the beasts and think.js's fight-back branch for the humanoid
     ones; everything below is the layer on top.
     ============================================================ */

  function isEntity(pawn) {
    return !!pawn && pawn.faction === FACTION && !pawn.dead;
  }
  Anomaly.isEntity = isEntity;

  function liveEntities(map) {
    var out = [];
    if (!map) return out;
    for (var i = 0; i < map.pawns.length; i++) {
      if (isEntity(map.pawns[i])) out.push(map.pawns[i]);
    }
    return out;
  }
  Anomaly.entities = function () {
    var g = G();
    return g && g.map ? liveEntities(g.map) : [];
  };

  function spawnEntity(map, kindId, cell, opts) {
    opts = opts || {};
    var MG = sys('MapGen');
    if (!MG || !MG.makePawn || !cell) return null;
    var pawn = MG.makePawn(kindId, FACTION, {
      x: cell.x, y: cell.y, map: map, gear: false
    });
    if (!pawn) return null;
    pawn.faction = FACTION;
    if (pawn.apparel && pawn.apparel.length) pawn.apparel.length = 0;
    pawn.equipment = null;
    if (!map.addPawn(pawn, cell.x, cell.y)) return null;
    pawn.fx = pawn.x; pawn.fy = pawn.y;
    dread(pawn).dread = 0;
    if (pawn.isAnimal) {
      var A = sys('Animals');
      /* An entity has no second thoughts, and the manhunter clock is
         the only vocabulary animals.js has for saying so. */
      if (A && A.makeManhunter && opts.calm !== true) A.makeManhunter(pawn, { ticks: 400000 });
    }
    return pawn;
  }
  Anomaly.spawnEntity = spawnEntity;

  function spawnGroup(map, kindId, count, anchor, radius) {
    var out = [];
    for (var i = 0; i < count; i++) {
      var cell = freeCellNear(map, anchor.x + U.randInt(-3, 3), anchor.y + U.randInt(-3, 3), radius || 10);
      if (!cell) continue;
      var p = spawnEntity(map, kindId, cell);
      if (p) out.push(p);
    }
    return out;
  }

  /* ---- shamblers: they get back up ---- */

  /* A corpse left where it fell is a shambler on a timer. Burning it,
     burying it or butchering it takes the timer away, which is the
     whole reason the player suddenly cares about their graveyard. */
  function markRisable(map, x, y, delayDays) {
    var items = map.items(x, y);
    for (var i = 0; i < items.length; i++) {
      var thing = items[i];
      if (!thing.corpse) continue;
      if (thing.anomRise) continue;
      thing.anomRise = now() + Math.round((delayDays || 0.4) * TICKS_PER_DAY);
    }
  }

  function raiseCorpse(map, corpse) {
    var cell = freeCellNear(map, corpse.x, corpse.y, 4);
    if (!cell) return null;
    var wasColonist = corpse.corpse && corpse.corpse.faction === 'player';
    var wasName = corpse.corpse ? corpse.corpse.name : null;
    map.destroyThing(corpse, 'raised');
    var pawn = spawnEntity(map, 'shambler', cell);
    if (!pawn) return null;
    if (wasName && pawn.name) pawn.name = { first: wasName, nick: wasName, last: '' };
    state.stats.risen++;
    if (wasColonist) {
      letter('The dead do not stay down',
        (wasName || 'One of your dead') + ' is standing up. Whatever is doing this did ' +
        'not ask for the body back; it simply took it.',
        'threat', cell);
      witness(map, cell.x, cell.y, 0.22, 'sawEntity');
    } else {
      witness(map, cell.x, cell.y, 0.10, 'sawEntity');
    }
    return pawn;
  }

  function tickShamblerRise(game, map) {
    if (state.stage < 1) return;
    var corpses = map.byDef('corpse') || [];
    var tick = now();
    for (var i = corpses.length - 1; i >= 0; i--) {
      var c = corpses[i];
      if (!c.spawned || !c.anomRise) continue;
      if (tick < c.anomRise) continue;
      c.anomRise = 0;
      /* The stage decides how often it actually happens; at stage one
         it is rare enough to be a rumour. */
      var p = 0.12 + 0.16 * state.stage;
      if (state.finale) p = 1;
      if (U.chance(p)) raiseCorpse(map, c);
    }
  }

  /* ---- fleshbeasts: they come through the wall ---- */

  function tickFleshbeast(map, pawn) {
    if (pawn.kindId !== 'fleshbeast') return;
    /* If it has no path to anybody it starts eating the building in
       its way. Two anomaly ticks per wall, which is slow enough to
       be a warning and fast enough to be a breach. */
    var victim = nearestColonist(map, pawn.x, pawn.y, 60);
    if (!victim) return;
    var R = sys('Regions');
    var blocked = R && R.sameArea && !R.sameArea(map, pawn.x, pawn.y, victim.x, victim.y);
    if (!blocked) return;
    var dx = U.clamp(victim.x - pawn.x, -1, 1);
    var dy = U.clamp(victim.y - pawn.y, -1, 1);
    var wall = map.buildingAt(pawn.x + dx, pawn.y + dy);
    if (!wall) wall = map.buildingAt(pawn.x + dx, pawn.y) || map.buildingAt(pawn.x, pawn.y + dy);
    if (!wall || wall.defId === 'monolith') return;
    var H = sys('Health');
    wall.hp -= 160;
    if (wall.hp <= 0) {
      var wx = wall.x, wy = wall.y;
      map.destroyThing(wall, 'fleshbeast');
      msg('A fleshbeast has come through the wall.', 'threat', { x: wx, y: wy });
      witness(map, wx, wy, 0.14, 'sawEntity');
    }
    if (H) { /* keeps the guard honest when health.js is absent */ }
  }

  /* ---- the sightstealer: light is the weapon ---- */

  function tickSightstealer(game, map, pawn) {
    if (pawn.kindId !== 'sightstealer') return;
    var light = lightAt(map, pawn.x, pawn.y);
    if (light > 0.45) {
      /* Caught in the light. It burns and it runs for the dark. */
      var H = sys('Health');
      if (H && H.damage) H.damage(pawn, { amount: Math.round(8 * light), type: 'burn', source: 'light' });
      var away = darkCellNear(map, pawn.x, pawn.y, 12);
      if (away && pawn.map && Jobs && Jobs.make) {
        var job = Jobs.make('goto', T.cell(away.x, away.y));
        if (job && Jobs.start) { Jobs.end(pawn, 'interrupted'); Jobs.start(pawn, job); }
      }
      return;
    }
    /* In the dark it works: lamps near it go out, one per beat. */
    var lamps = nearbyLamps(map, pawn.x, pawn.y, 9);
    for (var i = 0; i < lamps.length; i++) {
      var lamp = lamps[i];
      if (lamp.defId === 'wardLamp') continue;
      lamp.hp -= 90;
      if (lamp.hp <= 0) {
        map.destroyThing(lamp, 'sightstealer');
        msg('A lamp has gone out.', 'threat', lamp);
      }
      break;
    }
    /* And anyone standing in the dark beside it is in real trouble. */
    var list = colonists(map);
    for (var c = 0; c < list.length; c++) {
      var v = list[c];
      if (v.dead) continue;
      if (U.cheb(v.x, v.y, pawn.x, pawn.y) > 1) continue;
      if (lightAt(map, v.x, v.y) > 0.35) continue;
      var Hh = sys('Health');
      if (Hh && Hh.damage) {
        Hh.damage(v, { amount: U.randInt(12, 22), type: 'cut', source: 'sightstealer', instigator: pawn, armorPen: 0.4 });
      }
      addDread(v, 0.20, 'the dark');
    }
  }

  function nearbyLamps(map, x, y, radius) {
    var out = [];
    var kinds = ['standingLamp', 'wardLamp'];
    for (var k = 0; k < kinds.length; k++) {
      var list = map.byDef(kinds[k]) || [];
      for (var i = 0; i < list.length; i++) {
        if (!list[i].spawned) continue;
        if (U.cheb(list[i].x, list[i].y, x, y) <= radius) out.push(list[i]);
      }
    }
    return out;
  }

  function darkCellNear(map, x, y, radius) {
    var ring = U.cellsInRadius(x, y, radius);
    for (var i = ring.length - 1; i >= 0; i--) {
      var cx = ring[i][0], cy = ring[i][1];
      if (!map.inBounds(cx, cy) || !map.passable(cx, cy)) continue;
      if (lightAt(map, cx, cy) < 0.2) return { x: cx, y: cy };
    }
    return null;
  }

  /* ---- the revenant: it lurks until you go and find it ---- */

  function tickRevenant(game, map, pawn) {
    if (pawn.kindId !== 'revenant') return;
    var a = dread(pawn);
    if (!a.lurking) return;             /* found: it fights like anything else */

    /* While lurking it keeps away from the colony and takes one
       person at a time. It is on the map and it can be hunted; it
       simply will not come to you. */
    if (now() < a.strikeTick) {
      keepAway(map, pawn);
      return;
    }
    a.strikeTick = now() + U.randInt(Math.round(0.8 * TICKS_PER_DAY), Math.round(1.6 * TICKS_PER_DAY));

    var victim = loneColonist(map);
    if (!victim) { keepAway(map, pawn); return; }
    var H = sys('Health');
    if (H && H.addHediff) H.addHediff(victim, 'hypnotised', 1);
    var J = sys('Jobs');
    if (victim.job && J && J.end) J.end(victim, 'interrupted');
    if (victim.stopPath) victim.stopPath();
    /* Dragged to wherever it sleeps. */
    var den = freeCellNear(map, pawn.x, pawn.y, 6) || { x: pawn.x, y: pawn.y };
    var oldX = victim.x, oldY = victim.y;
    victim.x = den.x; victim.y = den.y; victim.fx = den.x; victim.fy = den.y;
    if (map.notePawnMoved) map.notePawnMoved(victim, oldX, oldY);
    state.stats.taken++;

    letter(nameOf(victim) + ' is gone',
      nameOf(victim) + ' was alone and now is not where they were. There is no blood and ' +
      'no trail. Something is holding them somewhere on this map and it has not killed ' +
      'them yet, which is worse.',
      'threat', den);
    witness(map, oldX, oldY, 0.26, 'sawEntity');
  }

  function keepAway(map, pawn) {
    var c = colonyCentre(map);
    if (U.cheb(pawn.x, pawn.y, c.x, c.y) > 28) return;
    var dx = pawn.x - c.x, dy = pawn.y - c.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var tx = U.clamp(Math.round(pawn.x + (dx / len) * 14), 2, map.w - 3);
    var ty = U.clamp(Math.round(pawn.y + (dy / len) * 14), 2, map.h - 3);
    var cell = freeCellNear(map, tx, ty, 10);
    if (!cell || !Jobs || !Jobs.make || !Jobs.start) return;
    if (pawn.job && pawn.job.defId === 'goto') return;
    Jobs.start(pawn, Jobs.make('goto', T.cell(cell.x, cell.y)));
  }

  function loneColonist(map) {
    var list = colonists(map);
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var pawn = list[i];
      if (pawn.dead || pawn.downed) continue;
      var friends = 0;
      for (var j = 0; j < list.length; j++) {
        if (list[j] === pawn || list[j].dead) continue;
        if (U.cheb(list[i].x, list[i].y, list[j].x, list[j].y) <= 8) friends++;
      }
      if (friends > 0) continue;
      if (!best || U.chance(0.5)) best = pawn;
    }
    return best;
  }

  Anomaly.revealRevenant = function (map, pawn) {
    var a = dread(pawn);
    if (!a.lurking) return false;
    a.lurking = false;
    a.hunted = true;
    var A = sys('Animals');
    if (A && A.makeManhunter && pawn.isAnimal) A.makeManhunter(pawn, { ticks: 400000 });
    letter('The revenant is awake',
      'Whatever was taking people has stopped pretending it is not here. It is standing ' +
      'in the open and it is coming.',
      'threat', pawn);
    return true;
  };

  /* Anybody the revenant took wakes when the revenant dies. */
  function freeHypnotised(map) {
    var H = sys('Health');
    if (!H || !H.hediff) return;
    var list = colonists(map);
    for (var i = 0; i < list.length; i++) {
      var hd = H.hediff(list[i], 'hypnotised');
      if (!hd) continue;
      hd.severity = 0;
      if (H.removeHediff) H.removeHediff(list[i], 'hypnotised');
      else hd.severity = 0;
      addDread(list[i], 0.30, 'woke up somewhere else');
      msg(nameOf(list[i]) + ' has woken up.', 'good', list[i]);
    }
  }

  /* ---- the devourer: swallowed, and cuttable-out ---- */

  function tickDevourer(game, map, pawn) {
    if (pawn.kindId !== 'devourer') return;
    var a = dread(pawn);
    if (a.holding) {
      var held = pawnById(map, a.holding);
      if (!held || held.dead) { a.holding = 0; return; }
      /* The passenger travels with it, which is what makes cutting it
         open in time a real race across the map. */
      var oldX = held.x, oldY = held.y;
      held.x = pawn.x; held.y = pawn.y; held.fx = pawn.fx; held.fy = pawn.fy;
      if (map.notePawnMoved) map.notePawnMoved(held, oldX, oldY);
      var h = dread(held);
      h.digest -= SLOW;
      var H = sys('Health');
      if (h.digest <= 0) {
        if (H && H.kill) H.kill(held, 'being digested');
        a.holding = 0;
        letter(nameOf(held) + ' is gone',
          'You did not get to it in time.', 'death', pawn);
      } else if (H && H.damage) {
        H.damage(held, { amount: 3, type: 'burn', source: 'digestion' });
      }
      return;
    }
    /* Nothing in its mouth: look for something to put there. */
    var list = colonists(map);
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (v.dead) continue;
      if (U.cheb(v.x, v.y, pawn.x, pawn.y) > 1) continue;
      swallow(map, pawn, v);
      break;
    }
  }

  function swallow(map, beast, victim) {
    var a = dread(beast), v = dread(victim);
    a.holding = victim.id;
    v.swallowedBy = beast.id;
    v.digest = Math.round(0.7 * TICKS_PER_DAY);
    var H = sys('Health');
    if (H && H.addHediff) H.addHediff(victim, 'swallowed', 1);
    var J = sys('Jobs');
    if (victim.job && J && J.end) J.end(victim, 'interrupted');
    if (victim.stopPath) victim.stopPath();
    letter(nameOf(victim) + ' has been swallowed',
      'The devourer took ' + nameOf(victim) + ' whole and is still moving. They are alive ' +
      'in there for about half a day. Put the thing down and cut it open.',
      'threat', beast);
    witness(map, beast.x, beast.y, 0.30, 'sawEntity');
  }

  Anomaly.cutOpen = function (beast, surgeon) {
    var map = beast && beast.map;
    if (!map) return false;
    var a = dread(beast);
    if (!a.holding) return false;
    var held = pawnById(map, a.holding);
    a.holding = 0;
    if (!held) return false;
    var h = dread(held);
    h.swallowedBy = 0;
    h.digest = 0;
    var H = sys('Health');
    if (H && H.removeHediff) H.removeHediff(held, 'swallowed');
    else if (H && H.hediff) { var hd = H.hediff(held, 'swallowed'); if (hd) hd.severity = 0; }
    var cell = freeCellNear(map, beast.x, beast.y, 4);
    if (cell) {
      var oldX = held.x, oldY = held.y;
      held.x = cell.x; held.y = cell.y; held.fx = cell.x; held.fy = cell.y;
      if (map.notePawnMoved) map.notePawnMoved(held, oldX, oldY);
    }
    addDread(held, 0.35, 'was inside it');
    letter(nameOf(held) + ' is out',
      nameOf(held) + ' came out of the devourer alive. They will not talk about it, and ' +
      (surgeon ? nameOf(surgeon) + ' will not talk about it either.' : 'nor will anyone who watched.'),
      'good', held);
    return true;
  };

  /* ---- the metalhorror: it is already inside ---- */

  Anomaly.implant = function (pawn) {
    if (!pawn || pawn.dead || !pawn.isHuman) return false;
    var a = dread(pawn);
    if (a.infestedTick) return false;
    a.infestedTick = now();
    a.emergeTick = now() + U.randInt(Math.round(4 * TICKS_PER_DAY), Math.round(9 * TICKS_PER_DAY));
    a.infestedKnown = false;
    var H = sys('Health');
    if (H && H.addHediff) H.addHediff(pawn, 'metalhorrorImplant', 0.2);
    state.stats.hosts++;
    /* Deliberately not a letter. The player is not told. */
    debugLog('implanted ' + nameOf(pawn) + ', emerges in ' + Math.round((a.emergeTick - now()) / TICKS_PER_DAY) + 'd');
    return true;
  };

  Anomaly.isInfested = function (pawn) {
    return !!(pawn && pawn.anomaly && pawn.anomaly.infestedTick);
  };
  Anomaly.infestationKnown = function (pawn) {
    return !!(pawn && pawn.anomaly && pawn.anomaly.infestedKnown);
  };

  Anomaly.revealInfestation = function (pawn, by) {
    var a = dread(pawn);
    if (!a.infestedTick || a.infestedKnown) return false;
    a.infestedKnown = true;
    letter('There is something inside ' + nameOf(pawn),
      (by ? nameOf(by) + '\'s scan' : 'The scan') + ' found a mass under ' + nameOf(pawn) +
      '\'s ribs that is not an organ and is not a tumour. It has been there for ' +
      Math.max(1, Math.round((now() - a.infestedTick) / TICKS_PER_DAY)) + ' days. It can be ' +
      'cut out, and cutting it out is going to hurt.',
      'threat', pawn);
    addDread(pawn, 0.35, 'it is inside me');
    return true;
  };

  Anomaly.extract = function (pawn, surgeon) {
    var a = dread(pawn);
    if (!a.infestedTick) return false;
    a.infestedTick = 0;
    a.emergeTick = 0;
    a.infestedKnown = false;
    var H = sys('Health');
    if (H && H.removeHediff) H.removeHediff(pawn, 'metalhorrorImplant');
    if (H && H.damage) {
      H.damage(pawn, { amount: U.randInt(14, 26), type: 'cut', source: 'extraction',
                       partName: 'torso', armorPen: 99, instigator: surgeon || null });
    }
    if (pawn.map) pawn.map.addItem('voidShard', pawn.x, pawn.y, 1);
    letter('It is out',
      (surgeon ? nameOf(surgeon) : 'The surgeon') + ' got it out of ' + nameOf(pawn) +
      ' in one piece. It is still moving in the tray.',
      'good', pawn);
    return true;
  };

  function emerge(map, host) {
    var a = dread(host);
    a.infestedTick = 0;
    a.emergeTick = 0;
    a.infestedKnown = false;
    var H = sys('Health');
    if (H && H.removeHediff) H.removeHediff(host, 'metalhorrorImplant');
    if (H && H.damage) {
      H.damage(host, { amount: U.randInt(28, 46), type: 'cut', source: 'metalhorror',
                       partName: 'torso', armorPen: 99 });
    }
    var cell = freeCellNear(map, host.x, host.y, 5) || { x: host.x, y: host.y };
    var beast = spawnEntity(map, 'metalhorror', cell);
    letter('It came out of ' + nameOf(host),
      'The thing that has been living in ' + nameOf(host) + ' for ' +
      'the last week came out through their chest in about two seconds. It is standing in ' +
      'the middle of your colony and it knows the layout.',
      'threat', cell);
    witness(map, cell.x, cell.y, 0.45, 'sawEntity');
    /* And it does not come out alone if it can help it. */
    var list = colonists(map);
    for (var i = 0; i < list.length; i++) {
      if (list[i] === host || list[i].dead) continue;
      if (U.cheb(list[i].x, list[i].y, cell.x, cell.y) > 2) continue;
      if (U.chance(0.30)) Anomaly.implant(list[i]);
    }
    return beast;
  }

  function tickInfections(game, map) {
    if (state.stage < 2) return;
    var list = colonists(map);
    var tick = now();
    for (var i = 0; i < list.length; i++) {
      var pawn = list[i];
      if (pawn.dead) continue;
      var a = pawn.anomaly;
      if (!a || !a.infestedTick) continue;
      /* A host who is nearly ready starts sleeping badly, which is the
         only free clue the player gets. */
      if (tick > a.emergeTick - TICKS_PER_DAY && U.chance(0.10)) {
        addDread(pawn, 0.03, 'host');
        if (U.chance(0.20)) msg(nameOf(pawn) + ' keeps rubbing their chest.', 'info', pawn);
      }
      if (tick >= a.emergeTick) emerge(map, pawn);
    }
  }

  /* ============================================================
     8. CONTAINMENT

     One entity per platform, stored as scalars on the platform
     Thing so save.js carries it. Strength falls on its own, falls
     faster when the power is off, falls when it is studied, and
     when it reaches nothing the thing walks out.
     ============================================================ */

  var HOLD_STRENGTH = {
    shambler: 1.0, fleshbeast: 0.8, sightstealer: 0.65,
    revenant: 0.55, devourer: 0.6, metalhorror: 0.5
  };
  var STUDY_VALUE = {
    shambler: 4, fleshbeast: 5, sightstealer: 7,
    revenant: 9, devourer: 8, metalhorror: 10
  };

  function platforms(map) {
    return map.byDef('holdingPlatform') || [];
  }
  function freePlatform(map, pawn) {
    var list = platforms(map);
    var best = null, bestD = Infinity;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p.spawned || p.holdKind) continue;
      if (Res && Res.reservedBy && Res.reservedBy(map, T.thing(p))) continue;
      if (pawn && Path && Path.reachable && !Path.reachable(map, pawn.x, pawn.y, p.x, p.y, { pawn: pawn })) continue;
      var d = pawn ? U.distSq(pawn.x, pawn.y, p.x, p.y) : 0;
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }
  Anomaly.freePlatform = freePlatform;

  Anomaly.canCapture = function (pawn) {
    if (!isEntity(pawn)) return false;
    if (!pawn.downed && !(pawn.health && pawn.health.downed)) return false;
    return HOLD_STRENGTH[pawn.kindId] !== undefined;
  };

  Anomaly.contain = function (entity, platform, by) {
    if (!entity || !platform || platform.holdKind) return false;
    var map = entity.map;
    if (!map) return false;
    platform.holdKind = entity.kindId;
    platform.holdName = nameOf(entity);
    platform.holdStrength = 1;
    platform.holdStudy = 0;
    platform.holdTick = now();
    /* A devourer with somebody inside it lets them out on the way in. */
    if (dread(entity).holding) Anomaly.cutOpen(entity, by);
    map.removePawn(entity);
    entity.dead = true;
    entity.deadTick = now();
    state.stats.contained++;
    var kindDef = Defs.maybe('pawnKind', platform.holdKind);
    letter('Contained',
      'The ' + ((kindDef && kindDef.label) || 'thing') + ' is on a platform with a field ' +
      'around it. It has not moved since it went on, which does not mean it is not doing ' +
      'anything. Study it while the field holds.',
      'good', platform);
    var list = colonists(map);
    for (var i = 0; i < list.length; i++) addThought(list[i], 'entityContained');
    mirror();
    return true;
  };

  function containmentDrain(platform) {
    var kind = platform.holdKind;
    var base = 0.0022 / (HOLD_STRENGTH[kind] || 1);
    var P = sys('Power');
    var powered = P && P.isPowered ? P.isPowered(platform) : true;
    if (!powered) base *= 4.5;
    if (state.tree.suppression) base *= 0.4;
    /* A platform that has been picked at all week holds worse. */
    base *= 1 + (platform.holdStudy || 0) * 0.06;
    return base;
  }

  function breach(map, platform) {
    var kind = platform.holdKind;
    var name = platform.holdName;
    platform.holdKind = '';
    platform.holdName = '';
    platform.holdStrength = 0;
    platform.holdStudy = 0;
    var cell = freeCellNear(map, platform.x, platform.y, 6);
    if (!cell) return;
    var pawn = spawnEntity(map, kind, cell);
    if (pawn && name && pawn.name) pawn.name = { first: name, nick: name, last: '' };
    state.stats.escaped++;
    letter('Containment failure',
      'The field on the holding platform went out and what was on it is not on it any ' +
      'more. ' + (name || 'It') + ' is loose inside the colony.',
      'threat', cell);
    witness(map, cell.x, cell.y, 0.28, 'sawEntity');
  }

  function tickContainment(game, map) {
    var list = platforms(map);
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p.spawned || !p.holdKind) continue;
      p.holdStrength = (p.holdStrength === undefined ? 1 : p.holdStrength) - containmentDrain(p) * (SLOW / 500);
      if (p.holdStrength <= 0.25 && !p.holdWarned) {
        p.holdWarned = 1;
        letter('Containment is slipping',
          'The field around the ' + ((Defs.maybe('pawnKind', p.holdKind) || {}).label || 'thing') +
          ' is down to a quarter. Restore the power, or stop studying it, or be somewhere ' +
          'else when it goes.',
          'threat', p);
      }
      if (p.holdStrength > 0.25) p.holdWarned = 0;
      if (p.holdStrength <= 0) breach(map, p);
    }
  }

  Anomaly.containedAt = function (platform) {
    if (!platform || !platform.holdKind) return null;
    var def = Defs.maybe('pawnKind', platform.holdKind);
    return {
      kindId: platform.holdKind,
      label: (def && def.label) || platform.holdKind,
      name: platform.holdName || '',
      strength: U.clamp01(platform.holdStrength === undefined ? 1 : platform.holdStrength),
      sessions: platform.holdStudy || 0,
      value: STUDY_VALUE[platform.holdKind] || 4
    };
  };

  /* A study session: points out, containment down, and the person
     doing it takes a little of it home with them. */
  function finishStudy(pawn, platform) {
    if (!platform || !platform.holdKind) return;
    var map = pawn.map;
    var value = STUDY_VALUE[platform.holdKind] || 4;
    var skill = pawn.skills && pawn.skills.intellectual ? pawn.skills.intellectual.level : 5;
    var gained = Math.max(2, Math.round(value * (0.6 + skill * 0.045)));
    grantDark(gained, 'study', platform);
    platform.holdStudy = (platform.holdStudy || 0) + 1;
    platform.holdStrength = Math.max(0, (platform.holdStrength === undefined ? 1 : platform.holdStrength) - 0.09);
    state.sessions++;

    var a = dread(pawn);
    a.studied++;
    addDread(pawn, 0.06, 'study');
    if (map && U.chance(0.22)) map.addItem('voidShard', pawn.x, pawn.y, 1);

    /* A researcher who keeps going changes. The first change is
       useful, which is exactly why they keep going. */
    if (a.studied === 12 && !a.shardsight) {
      a.shardsight = true;
      a.resist = U.clamp(a.resist + 0.35, -0.3, 0.9);
      addThought(pawn, 'shardsight');
      letter(nameOf(pawn) + ' has shardsight',
        nameOf(pawn) + ' has read enough of it to stop being frightened of it, and they ' +
        'have started finishing sentences nobody began. Their work is faster now. They ' +
        'are also not quite the person who started.',
        'neutral', pawn);
    }
    if (a.studied >= 26 && !a.hollow && U.chance(0.22)) goHollow(pawn, a);
  }

  /* ============================================================
     9. JOBS

     Behaviour lives with the system; the scans that hand these out
     are the work givers below, which is the same split the rest of
     the game uses.
     ============================================================ */

  function pawnById(map, id) {
    if (!map || !id) return null;
    for (var i = 0; i < map.pawns.length; i++) if (map.pawns[i].id === id) return map.pawns[i];
    return null;
  }

  function nearestColonist(map, x, y, radius) {
    var list = colonists(map), best = null, bestD = radius * radius;
    for (var i = 0; i < list.length; i++) {
      if (list[i].dead) continue;
      var d = U.distSq(x, y, list[i].x, list[i].y);
      if (d < bestD) { bestD = d; best = list[i]; }
    }
    return best;
  }

  var PE = Path ? Path.PE : { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  if (Jobs && Jobs.register) {

    Jobs.register('anomalyTouch', {
      label: 'touch the monolith',
      reportString: 'Walking up to the monolith.',
      alwaysShow: true,
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.wait(180),
          Toils.custom({
            name: 'touch',
            tick: function (pawn) {
              Anomaly.touch(pawn);
              return 'done';
            }
          })
        ];
      }
    });

    Jobs.register('anomalyStudy', {
      label: 'study entity',
      reportString: 'Studying a contained entity.',
      toils: function () {
        return [
          Toils.reserve('A', 1),
          Toils.goto('A', { pe: PE.INTERACTION, failIfGone: true }),
          Toils.work({
            skill: 'intellectual',
            amount: function () { return 2200; },
            onTick: function (pawn, job) {
              var platform = T.resolve(job.targetA, pawn.map);
              if (!platform || !platform.holdKind) return 'fail';
              return null;
            },
            onDone: function (pawn, job) {
              finishStudy(pawn, T.resolve(job.targetA, pawn.map));
            }
          })
        ];
      }
    });

    Jobs.register('anomalyShardStudy', {
      label: 'study shard',
      reportString: 'Taking a shard apart.',
      toils: function () {
        return [
          Toils.reserve('A', 1),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.pickUp('A', function () { return 1; }),
          Toils.goto('B', { pe: PE.INTERACTION, failIfGone: true }),
          Toils.work({
            skill: 'intellectual',
            amount: function () { return 1200; },
            onDone: function (pawn) {
              var carried = pawn.carried;
              if (carried) {
                if (pawn.dropCarried) pawn.dropCarried();
                else pawn.carried = null;
                if (carried.spawned && pawn.map) pawn.map.destroyThing(carried, 'studied');
                else if (carried.stack !== undefined) carried.stack = 0;
              }
              var skill = pawn.skills && pawn.skills.intellectual ? pawn.skills.intellectual.level : 5;
              grantDark(Math.max(1, Math.round(2 + skill * 0.25)), 'a shard', pawn);
              dread(pawn).studied += 1;
              addDread(pawn, 0.03, 'study');
            }
          })
        ];
      }
    });

    Jobs.register('anomalyCapture', {
      label: 'contain entity',
      reportString: 'Carrying something to a holding platform.',
      alwaysShow: true,
      toils: function () {
        return [
          Toils.reserve('A', 1),
          Toils.reserve('B', 1),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.custom({
            name: 'lift',
            tick: function (pawn, job) {
              var beast = T.resolve(job.targetA, pawn.map);
              if (!beast || beast.dead) return 'fail';
              if (U.cheb(pawn.x, pawn.y, beast.x, beast.y) > 1) return 'fail';
              if (!Anomaly.canCapture(beast)) return 'fail';
              var J = sys('Jobs');
              if (beast.job && J && J.end) J.end(beast, 'interrupted');
              if (beast.stopPath) beast.stopPath();
              pawn.carriedPawn = beast;
              beast.carriedBy = pawn.id;
              return 'next';
            }
          }),
          Toils.custom({
            name: 'haulToPlatform',
            init: function (pawn, job, s) { s.ticks = 0; },
            tick: function (pawn, job, s) {
              var platform = T.resolve(job.targetB, pawn.map);
              var beast = pawn.carriedPawn;
              if (!beast || beast.dead) return 'fail';
              if (!platform || !platform.spawned || platform.holdKind) return 'fail';
              if (++s.ticks > 9000) return 'fail';
              drag(pawn);
              if (U.cheb(pawn.x, pawn.y, platform.x, platform.y) <= 1) {
                if (Jobs.stopMoving) Jobs.stopMoving(pawn);
                return 'next';
              }
              var moving = pawn.path && pawn.pathIdx < pawn.path.length;
              if (!moving && !Jobs.walkTo(pawn, platform.x, platform.y, PE.TOUCH)) return 'fail';
              return 'stay';
            },
            end: function (pawn) {
              var beast = pawn.carriedPawn;
              if (!beast) return;
              beast.carriedBy = null;
              pawn.carriedPawn = null;
            }
          }),
          Toils.custom({
            name: 'loadPlatform',
            tick: function (pawn, job) {
              var platform = T.resolve(job.targetB, pawn.map);
              var beast = pawn.carriedPawn;
              if (!beast) return 'fail';
              beast.carriedBy = null;
              pawn.carriedPawn = null;
              if (!platform || platform.holdKind) return 'fail';
              Anomaly.contain(beast, platform, pawn);
              addDread(pawn, 0.10, 'carried one');
              return 'done';
            }
          })
        ];
      }
    });

    Jobs.register('anomalyScan', {
      label: 'deep scan',
      reportString: 'Scanning {A}.',
      alwaysShow: true,
      toils: function () {
        return [
          Toils.reserve('B', 1),
          Toils.goto('B', { pe: PE.INTERACTION, failIfGone: true }),
          Toils.work({
            which: 'B',
            skill: 'medicine',
            amount: function () { return 1500; },
            onDone: function (pawn, job) {
              var map = pawn.map;
              var found = 0;
              var list = colonists(map);
              for (var i = 0; i < list.length; i++) {
                var a = list[i].anomaly;
                if (!a || !a.infestedTick || a.infestedKnown) continue;
                /* The scanner only reaches what is in the room with it,
                   which is why a sweep is a job and not a button. */
                if (U.cheb(list[i].x, list[i].y, pawn.x, pawn.y) > 14) continue;
                if (Anomaly.revealInfestation(list[i], pawn)) found++;
              }
              if (!found) msg('The sweep found nothing under anybody\'s ribs.', 'info', pawn);
              state.lastScanTick = now();
            }
          })
        ];
      }
    });

    Jobs.register('anomalySurgery', {
      label: 'extract implant',
      reportString: 'Cutting something out of {A}.',
      alwaysShow: true,
      toils: function () {
        return [
          Toils.reserve('A', 1),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.work({
            skill: 'medicine',
            amount: function () { return 2000; },
            onDone: function (pawn, job) {
              var patient = T.resolve(job.targetA, pawn.map);
              if (!patient) return 'fail';
              var skill = pawn.skills && pawn.skills.medicine ? pawn.skills.medicine.level : 4;
              /* A bad surgeon wakes it up instead of taking it out. */
              if (U.chance(U.clamp(0.42 - skill * 0.035, 0.04, 0.42))) {
                msg(nameOf(pawn) + ' cut in the wrong place.', 'threat', patient);
                emerge(pawn.map, patient);
                return null;
              }
              Anomaly.extract(patient, pawn);
              return null;
            }
          })
        ];
      }
    });

    Jobs.register('anomalyCutOpen', {
      label: 'cut open',
      reportString: 'Cutting a devourer open.',
      alwaysShow: true,
      toils: function () {
        return [
          Toils.reserve('A', 1),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.work({
            skill: 'medicine',
            amount: function () { return 900; },
            onDone: function (pawn, job) {
              var beast = T.resolve(job.targetA, pawn.map);
              if (!beast) return 'fail';
              Anomaly.cutOpen(beast, pawn);
              return null;
            }
          })
        ];
      }
    });
  }

  function drag(carrier) {
    var p = carrier.carriedPawn;
    if (!p || p.dead) return false;
    if (p.x === carrier.x && p.y === carrier.y) return true;
    var oldX = p.x, oldY = p.y;
    p.x = carrier.x; p.y = carrier.y;
    p.fx = carrier.fx === undefined ? carrier.x : carrier.fx;
    p.fy = carrier.fy === undefined ? carrier.y : carrier.fy;
    if (carrier.map && carrier.map.notePawnMoved) carrier.map.notePawnMoved(p, oldX, oldY);
    return true;
  }

  /* ============================================================
     10. WORK GIVERS
     ============================================================ */

  function labFor(map, pawn) {
    var list = map.byDef('darkLab') || [];
    var best = null, bestD = Infinity;
    var P = sys('Power');
    for (var i = 0; i < list.length; i++) {
      var bench = list[i];
      if (!bench.spawned) continue;
      if (P && P.isPowered && !P.isPowered(bench)) continue;
      if (Path && Path.reachable && !Path.reachable(map, pawn.x, pawn.y, bench.x, bench.y, { pawn: pawn })) continue;
      var d = U.distSq(pawn.x, pawn.y, bench.x, bench.y);
      if (d < bestD) { bestD = d; best = bench; }
    }
    return best;
  }

  if (WorkGivers && WorkGivers.register) {

    WorkGivers.register({
      id: 'anomalyTouch', workType: 'basic', order: 5, label: 'touch the monolith',
      tryGiveJob: function (pawn) {
        if (!state.touchWanted || state.stage > 0) return null;
        var map = pawn && pawn.map;
        if (!map) return null;
        var slab = monolith(map);
        if (!slab) return null;
        if (!Res.canReserve(pawn, T.thing(slab), 1)) return null;
        if (Path && Path.reachable && !Path.reachable(map, pawn.x, pawn.y, slab.x, slab.y, { pawn: pawn })) return null;
        return Jobs.make('anomalyTouch', T.thing(slab), null, {});
      }
    });

    WorkGivers.register({
      id: 'anomalyStudy', workType: 'research', order: 30, label: 'study contained entities',
      tryGiveJob: function (pawn) {
        if (state.stage < 1) return null;
        var map = pawn && pawn.map;
        if (!map) return null;
        if (pawn.anomaly && pawn.anomaly.hollow) return null;
        var list = platforms(map);
        var best = null, bestD = Infinity;
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          if (!p.spawned || !p.holdKind) continue;
          /* Never study a field that is already close to going. */
          if ((p.holdStrength === undefined ? 1 : p.holdStrength) < 0.30) continue;
          if (!Res.canReserve(pawn, T.thing(p), 1)) continue;
          if (Path && Path.reachable && !Path.reachable(map, pawn.x, pawn.y, p.x, p.y, { pawn: pawn })) continue;
          var d = U.distSq(pawn.x, pawn.y, p.x, p.y);
          if (d < bestD) { bestD = d; best = p; }
        }
        if (!best) return null;
        return Jobs.make('anomalyStudy', T.thing(best), null, {});
      }
    });

    WorkGivers.register({
      id: 'anomalyShardStudy', workType: 'research', order: 35, label: 'study void shards',
      tryGiveJob: function (pawn) {
        if (state.stage < 1) return null;
        var map = pawn && pawn.map;
        if (!map) return null;
        if (pawn.anomaly && pawn.anomaly.hollow) return null;
        var bench = labFor(map, pawn);
        if (!bench) return null;
        var shards = map.byDef('voidShard') || [];
        var best = null, bestD = Infinity;
        for (var i = 0; i < shards.length; i++) {
          var s = shards[i];
          if (!s.spawned) continue;
          if (!Res.canReserve(pawn, T.thing(s), 1)) continue;
          if (Path && Path.reachable && !Path.reachable(map, pawn.x, pawn.y, s.x, s.y, { pawn: pawn })) continue;
          var d = U.distSq(pawn.x, pawn.y, s.x, s.y);
          if (d < bestD) { bestD = d; best = s; }
        }
        if (!best) return null;
        return Jobs.make('anomalyShardStudy', T.thing(best), T.thing(bench), {});
      }
    });

    WorkGivers.register({
      id: 'anomalyCapture', workType: 'handle', order: 12, label: 'contain a downed entity',
      tryGiveJob: function (pawn) {
        if (state.stage < 1) return null;
        var map = pawn && pawn.map;
        if (!map) return null;
        var platform = freePlatform(map, pawn);
        if (!platform) return null;
        var list = liveEntities(map);
        var best = null, bestD = Infinity;
        for (var i = 0; i < list.length; i++) {
          var beast = list[i];
          if (!Anomaly.canCapture(beast)) continue;
          if (!Res.canReserve(pawn, T.pawn(beast), 1)) continue;
          if (Path && Path.reachable && !Path.reachable(map, pawn.x, pawn.y, beast.x, beast.y, { pawn: pawn })) continue;
          var d = U.distSq(pawn.x, pawn.y, beast.x, beast.y);
          if (d < bestD) { bestD = d; best = beast; }
        }
        if (!best) return null;
        return Jobs.make('anomalyCapture', T.pawn(best), T.thing(platform), {});
      }
    });

    WorkGivers.register({
      id: 'anomalyCutOpen', workType: 'doctor', order: 1, label: 'cut open a devourer',
      tryGiveJob: function (pawn) {
        var map = pawn && pawn.map;
        if (!map) return null;
        for (var i = 0; i < map.pawns.length; i++) {
          var beast = map.pawns[i];
          if (beast.kindId !== 'devourer') continue;
          if (!beast.anomaly || !beast.anomaly.holding) continue;
          /* Only once it can no longer object. */
          if (!beast.dead && !beast.downed && !(beast.health && beast.health.downed)) continue;
          if (!Res.canReserve(pawn, T.pawn(beast), 1)) continue;
          if (Path && Path.reachable && !Path.reachable(map, pawn.x, pawn.y, beast.x, beast.y, { pawn: pawn })) continue;
          return Jobs.make('anomalyCutOpen', T.pawn(beast), null, {});
        }
        return null;
      }
    });

    WorkGivers.register({
      id: 'anomalySurgery', workType: 'doctor', order: 6, label: 'extract an implant',
      tryGiveJob: function (pawn) {
        if (state.stage < 2) return null;
        var map = pawn && pawn.map;
        if (!map) return null;
        var list = colonists(map);
        for (var i = 0; i < list.length; i++) {
          var patient = list[i];
          if (patient === pawn) continue;
          var a = patient.anomaly;
          if (!a || !a.infestedTick || !a.infestedKnown) continue;
          if (!patient.downed && !patient.asleep && !(patient.health && patient.health.downed)) continue;
          if (!Res.canReserve(pawn, T.pawn(patient), 1)) continue;
          if (Path && Path.reachable && !Path.reachable(map, pawn.x, pawn.y, patient.x, patient.y, { pawn: pawn })) continue;
          return Jobs.make('anomalySurgery', T.pawn(patient), null, {});
        }
        return null;
      }
    });

    WorkGivers.register({
      id: 'anomalyScan', workType: 'doctor', order: 45, label: 'run a deep scan',
      tryGiveJob: function (pawn) {
        if (state.stage < 2 || !state.tree.scanning) return null;
        var map = pawn && pawn.map;
        if (!map) return null;
        /* Sweeping every hour is a waste of a doctor; half a day is
           the cadence a suspicious colony actually wants. */
        if (now() - (state.lastScanTick || 0) < Math.round(0.4 * TICKS_PER_DAY)) return null;
        var scanners = map.byDef('anomalyScanner') || [];
        var P = sys('Power');
        for (var i = 0; i < scanners.length; i++) {
          var s = scanners[i];
          if (!s.spawned) continue;
          if (P && P.isPowered && !P.isPowered(s)) continue;
          if (!Res.canReserve(pawn, T.thing(s), 1)) continue;
          if (Path && Path.reachable && !Path.reachable(map, pawn.x, pawn.y, s.x, s.y, { pawn: pawn })) continue;
          return Jobs.make('anomalyScan', null, T.thing(s), {});
        }
        return null;
      }
    });
  }

  /* ============================================================
     11. EVENTS

     Registered on the first tick, because events.js loads below
     this file. Every weight is gated on the stage this file owns
     rather than on the storyteller's points, so a colony that
     never touched the slab never draws one of them.
     ============================================================ */

  function stageAtLeast(n) { return state.stage >= n; }

  function ensureIncidents() {
    if (state.incidentsReady) return;
    var I = sys('Incidents');
    if (!I || !I.register) return;
    state.incidentsReady = true;

    I.register({
      id: 'anomalyStrangeNight', label: 'a strange night', category: 'misc', minDay: 6,
      weight: function () { return state.stage === 0 ? 0.55 : 0.2; },
      fire: function (g) { return Anomaly.strangeNight(g); }
    });

    I.register({
      id: 'anomalyShamblers', label: 'shamblers', category: 'threatBig', minDay: 0,
      weight: function () { return stageAtLeast(1) ? 1.0 + state.stage * 0.25 : 0; },
      fire: function (g, points) { return Anomaly.shamblerSwarm(g, points); }
    });

    I.register({
      id: 'anomalyDeadRise', label: 'the dead do not stay down', category: 'threatBig', minDay: 0,
      weight: function () { return stageAtLeast(2) ? 0.7 + state.stage * 0.15 : 0; },
      fire: function (g) { return Anomaly.deadRise(g); }
    });

    I.register({
      id: 'anomalyFleshbeasts', label: 'fleshbeasts', category: 'threatBig', minDay: 0,
      weight: function () { return stageAtLeast(2) ? 0.9 + state.stage * 0.2 : 0; },
      fire: function (g, points) { return Anomaly.fleshbeastBurrow(g, points); }
    });

    I.register({
      id: 'anomalyDarkness', label: 'unnatural darkness', category: 'weather', minDay: 0,
      weight: function () {
        if (!stageAtLeast(2)) return 0;
        return state.darknessUntil > now() ? 0 : 0.8 + state.stage * 0.15;
      },
      fire: function (g) { return Anomaly.unnaturalDarkness(g); }
    });

    I.register({
      id: 'anomalyImplant', label: 'something got in', category: 'threatSmall', minDay: 0,
      weight: function () { return stageAtLeast(2) ? 0.9 : 0; },
      fire: function (g) { return Anomaly.quietImplant(g); }
    });

    I.register({
      id: 'anomalyFleshSpread', label: 'the flesh spreads', category: 'threatSmall', minDay: 0,
      weight: function () {
        if (!stageAtLeast(3)) return 0;
        return state.flesh.ticksLeft > 0 ? 0 : 0.8;
      },
      fire: function (g) { return Anomaly.fleshSpread(g); }
    });

    I.register({
      id: 'anomalyRevenant', label: 'a revenant', category: 'threatSmall', minDay: 0,
      weight: function () {
        if (!stageAtLeast(3)) return 0;
        return hasKind(g_map(), 'revenant') ? 0 : 0.7;
      },
      fire: function (g) { return Anomaly.sendRevenant(g); }
    });

    I.register({
      id: 'anomalyDevourer', label: 'a devourer', category: 'threatSmall', minDay: 0,
      weight: function () { return stageAtLeast(3) ? 0.6 : 0; },
      fire: function (g) { return Anomaly.sendDevourer(g); }
    });

    I.register({
      id: 'anomalyRitualSite', label: 'a ritual site', category: 'misc', minDay: 0,
      weight: function () {
        if (!stageAtLeast(3)) return 0;
        var map = g_map();
        return (map && (map.byDef('ritualPillar') || []).length) ? 0 : 0.8;
      },
      fire: function (g) { return Anomaly.ritualSite(g); }
    });

    I.register({
      id: 'anomalySightstealerHunt', label: 'a sightstealer hunt', category: 'threatBig', minDay: 0,
      weight: function () { return stageAtLeast(4) ? 1.1 : 0; },
      fire: function (g, points) { return Anomaly.sightstealerHunt(g, points); }
    });

    I.register({
      id: 'anomalyCall', label: 'the monolith calls', category: 'misc', minDay: 0,
      weight: function () { return (state.stage === 5 && !state.finale) ? 4 : 0; },
      fire: function (g) { return Anomaly.callLetter(g); }
    });
  }

  function g_map() { var g = G(); return g ? g.map : null; }

  function hasKind(map, kindId) {
    if (!map) return false;
    for (var i = 0; i < map.pawns.length; i++) {
      if (map.pawns[i].kindId === kindId && !map.pawns[i].dead) return true;
    }
    return false;
  }

  /* ---- the ambient strangeness a dormant colony gets ---- */

  Anomaly.strangeNight = function (game) {
    game = game || G();
    var map = game && game.map;
    if (!map || !colonists(map).length) return false;
    var lines = [
      'Every clock in the colony agrees it is twelve minutes later than it was a moment ago.',
      'The dogs will not go past the east wall tonight, and there are no dogs.',
      'Somebody heard their own voice from outside, saying their own name, badly.',
      'All the water in the barrels was warm this morning and nobody lit anything.'
    ];
    letter('A strange night', U.pick(lines) + ' Nothing came of it.', 'neutral');
    var list = colonists(map);
    for (var i = 0; i < list.length; i++) addDread(list[i], 0.04, 'a strange night');
    return true;
  };

  /* ---- shamblers ---- */

  Anomaly.shamblerSwarm = function (game, points) {
    game = game || G();
    var map = game && game.map;
    if (!map || !colonists(map).length) return false;
    var n = U.clamp(Math.round(5 + state.stage * 2.5 + (points || 0) / 90), 4, 32);
    var side = U.pick(['n', 'e', 's', 'w']);
    var cells = edgeCells(map, side);
    if (!cells.length) return false;
    var anchor = U.pick(cells);
    var made = spawnGroup(map, 'shambler', n, anchor, 12);
    if (!made.length) return false;
    letter('Shamblers',
      made.length + ' of them came over the ' + sideName(side) + ' edge, walking. They are ' +
      'slow and there is no cleverness in them at all. Kill them somewhere you are willing ' +
      'to burn the bodies, because the bodies are the problem.',
      'threat', made[0]);
    witness(map, made[0].x, made[0].y, 0.12, 'sawEntity');
    return true;
  };

  Anomaly.deadRise = function (game) {
    game = game || G();
    var map = game && game.map;
    if (!map) return false;
    var corpses = (map.byDef('corpse') || []).filter(function (c) { return c.spawned; });
    if (corpses.length < 2) return false;
    var raised = 0;
    for (var i = 0; i < corpses.length && raised < 18; i++) {
      if (!U.chance(0.75)) continue;
      if (raiseCorpse(map, corpses[i])) raised++;
    }
    if (!raised) return false;
    letter('The dead do not stay down',
      raised + ' ' + U.plural(raised, 'body', 'bodies') + ' on this map got up tonight. ' +
      'Some of them you buried. Graves did not help; they came up through the dirt.',
      'threat');
    var list = colonists(map);
    for (var c = 0; c < list.length; c++) addDread(list[c], 0.22, 'the dead rose');
    return true;
  };

  /* ---- fleshbeasts ---- */

  Anomaly.fleshbeastBurrow = function (game, points) {
    game = game || G();
    var map = game && game.map;
    if (!map || !colonists(map).length) return false;
    var n = U.clamp(Math.round(2 + state.stage * 1.1 + (points || 0) / 160), 2, 10);
    /* They come out of the ground, which means inside the walls. */
    var c = colonyCentre(map);
    var spot = freeCellNear(map, c.x + U.randInt(-8, 8), c.y + U.randInt(-8, 8), 14);
    if (!spot) return false;
    var made = spawnGroup(map, 'fleshbeast', n, spot, 8);
    if (!made.length) return false;
    for (var i = 0; i < made.length; i++) {
      map.addBlood(made[i].x, made[i].y, 160);
    }
    letter('Something came up through the floor',
      'The ground opened in ' + (map.hasRoofAt(spot.x, spot.y) ? 'one of your rooms' : 'the yard') +
      ' and ' + made.length + ' ' + U.plural(made.length, 'fleshbeast') + ' came out of it. ' +
      'They do not need your door.',
      'threat', spot);
    witness(map, spot.x, spot.y, 0.26, 'sawEntity');
    return true;
  };

  /* ---- unnatural darkness ---- */

  Anomaly.unnaturalDarkness = function (game) {
    game = game || G();
    if (!game || !game.map) return false;
    var days = U.randRange(0.8, 2.2) + state.stage * 0.2;
    var ticks = Math.round(days * TICKS_PER_DAY);
    state.darknessUntil = now() + ticks;
    /* game.js already has a map-wide light switch, and the whole
       lighting system reads it: eclipse is exactly this shape. */
    if (game.weather) {
      game.weather.eclipseTicksLeft = Math.max(game.weather.eclipseTicksLeft || 0, ticks);
    }
    letter('Unnatural darkness',
      'The light went out of the sky at a quarter past two in the afternoon and it is not ' +
      'coming back for about ' + U.fmt(days, 1) + ' days. Solar panels are dead, crops have ' +
      'stopped, and there is something in this that is not an eclipse. Keep lamps lit and ' +
      'keep people indoors.',
      'threat');
    if (stageAtLeast(4) && U.chance(0.7)) Anomaly.sightstealerHunt(game, 0);
    return true;
  };

  /* ---- sightstealers ---- */

  Anomaly.sightstealerHunt = function (game, points) {
    game = game || G();
    var map = game && game.map;
    if (!map || !colonists(map).length) return false;
    var n = U.clamp(Math.round(2 + state.stage * 0.8 + (points || 0) / 200), 2, 7);
    var c = colonyCentre(map);
    var spot = darkCellNear(map, c.x, c.y, 22) || freeCellNear(map, c.x + 18, c.y, 20);
    if (!spot) return false;
    var made = spawnGroup(map, 'sightstealer', n, spot, 12);
    if (!made.length) return false;
    letter('Something is putting the lamps out',
      'Lamps around the colony are going dark one at a time, in order, from the outside ' +
      'in. Whatever is doing it will not come into the light and will not miss anybody who ' +
      'stands outside it.',
      'threat', made[0]);
    var list = colonists(map);
    for (var i = 0; i < list.length; i++) addDread(list[i], 0.12, 'the lamps');
    return true;
  };

  /* ---- revenant and devourer ---- */

  Anomaly.sendRevenant = function (game) {
    game = game || G();
    var map = game && game.map;
    if (!map || !colonists(map).length) return false;
    if (hasKind(map, 'revenant')) return false;
    var side = U.pick(['n', 'e', 's', 'w']);
    var cells = edgeCells(map, side);
    if (!cells.length) return false;
    var pawn = spawnEntity(map, 'revenant', U.pick(cells), { calm: true });
    if (!pawn) return false;
    var a = dread(pawn);
    a.lurking = true;
    a.strikeTick = now() + Math.round(0.5 * TICKS_PER_DAY);
    letter('Somebody is being watched',
      'Three separate people have described the same shape standing at the edge of the ' +
      'light and then not standing there. Nothing has happened yet. Something is going to.',
      'threat');
    return true;
  };

  Anomaly.sendDevourer = function (game) {
    game = game || G();
    var map = game && game.map;
    if (!map || !colonists(map).length) return false;
    var side = U.pick(['n', 'e', 's', 'w']);
    var cells = edgeCells(map, side);
    if (!cells.length) return false;
    var pawn = spawnEntity(map, 'devourer', U.pick(cells));
    if (!pawn) return false;
    letter('A devourer',
      'Something the size of a cart is crossing the ' + sideName(side) + ' field at a walk. ' +
      'It is not in a hurry because it has never needed to be.',
      'threat', pawn);
    witness(map, pawn.x, pawn.y, 0.14, 'sawEntity');
    return true;
  };

  function sideName(side) {
    return side === 'n' ? 'north' : side === 's' ? 'south' : side === 'e' ? 'east' : 'west';
  }

  /* ---- flesh, spreading ---- */

  Anomaly.fleshSpread = function (game) {
    game = game || G();
    var map = game && game.map;
    if (!map) return false;
    var c = colonyCentre(map);
    var seed = freeCellNear(map, c.x + U.randInt(-16, 16), c.y + U.randInt(-16, 16), 16);
    if (!seed) return false;
    state.flesh.cells = [map.idx(seed.x, seed.y)];
    state.flesh.nextTick = now();
    state.flesh.ticksLeft = Math.round(U.randRange(2.5, 5) * TICKS_PER_DAY);
    fleshAt(map, seed.x, seed.y);
    letter('The ground has changed',
      'There is a patch of ground near the colony that is warm, red and soft, and it was ' +
      'grass yesterday. It is getting bigger. Nothing will grow in it and nothing wants to ' +
      'walk on it.',
      'threat', seed);
    return true;
  };

  function fleshAt(map, x, y) {
    if (!map.inBounds(x, y)) return false;
    var terrain = map.terrainAt(x, y);
    /* It will not eat a floor somebody paid for, and it will not cross
       water. Keeping it on natural ground also means the only lasting
       damage is a scar where the good soil used to be. */
    if (!terrain || terrain.id === 'fleshTerrain') return false;
    if (terrain.isWater || !terrain.isNatural) return false;
    if (!map.passable(x, y)) return false;
    map.setTerrain(x, y, 'fleshTerrain');
    var plant = map.plantAt(x, y);
    if (plant) map.destroyThing(plant, 'flesh');
    return true;
  }

  function tickFlesh(game, map) {
    if (state.flesh.ticksLeft <= 0) {
      if (state.flesh.cells.length && state.stage >= STAGE_MAX) recedeFlesh(map);
      return;
    }
    state.flesh.ticksLeft -= SLOW;
    if (state.flesh.ticksLeft <= 0) {
      msg('The flesh has stopped spreading.', 'info');
      return;
    }
    if (!state.flesh.cells.length) return;
    /* Two or three new tiles a beat: fast enough to watch, slow enough
       that walling it off is a real answer. */
    var grew = 0;
    for (var attempt = 0; attempt < 14 && grew < 3; attempt++) {
      var from = state.flesh.cells[U.randInt(0, state.flesh.cells.length - 1)];
      var d = U.pick(U.ADJ8);
      var x = map.xOf(from) + d[0], y = map.yOf(from) + d[1];
      if (fleshAt(map, x, y)) { state.flesh.cells.push(map.idx(x, y)); grew++; }
    }
    if (state.flesh.cells.length > 900) state.flesh.ticksLeft = 0;
  }

  function recedeFlesh(map) {
    for (var i = 0; i < state.flesh.cells.length; i++) {
      var idx = state.flesh.cells[i];
      map.setTerrain(map.xOf(idx), map.yOf(idx), 'soil');
    }
    state.flesh.cells.length = 0;
  }

  /* After a load the cell list is gone but the terrain is not, so
     rebuild it with one pass over the grid. Once per load, and only
     when the monolith says there was flesh to begin with. */
  function rescanFlesh(map) {
    if (state.flesh.scanned) return;
    state.flesh.scanned = true;
    if (!Defs.has('terrain', 'fleshTerrain')) return;
    var want = Defs.index('terrain', 'fleshTerrain');
    var out = [];
    for (var i = 0; i < map.size; i++) if (map.terrain[i] === want) out.push(i);
    if (out.length) state.flesh.cells = out;
  }

  /* ---- ritual sites ---- */

  Anomaly.ritualSite = function (game) {
    game = game || G();
    var map = game && game.map;
    if (!map) return false;
    var c = colonyCentre(map);
    var spot = freeCellNear(map, c.x + U.randInt(-22, 22), c.y + U.randInt(-22, 22), 18);
    if (!spot) return false;
    var pillar = map.spawnThing('ritualPillar', spot.x, spot.y, { faction: null });
    if (!pillar) return false;
    map.markPathDirty(spot.x, spot.y);
    var R = sys('Regions');
    if (R && R.markDirty) R.markDirty(map, spot.x, spot.y);
    letter('A ritual site',
      'Somebody built a pillar out of bone and dreadmetal a short walk from your fences, ' +
      'overnight, and arranged the ground around it. While it stands the colony will not ' +
      'sleep well. Mine it out and the shards are yours.',
      'threat', spot);
    return true;
  };

  function tickRitual(game, map) {
    var pillars = map.byDef('ritualPillar') || [];
    if (!pillars.length) return;
    if ((game.tick % (SLOW * 8)) !== 0) return;
    var list = colonists(map);
    for (var i = 0; i < list.length; i++) addDread(list[i], 0.03 * pillars.length, 'a pillar');
  }

  /* ============================================================
     12. THE ENDING

     The anchor is built next to the slab and switched on, and then
     the colony has to still be standing when it finishes charging.
     Nothing announces a victory: a victory is what it is called
     when the waves stop coming and somebody is still there.
     ============================================================ */

  var FINALE_CHARGE = Math.round(1.2 * TICKS_PER_DAY);

  Anomaly.callLetter = function (game) {
    letter('The monolith is calling',
      'Everybody in the colony woke at the same moment and none of them will say what woke ' +
      'them. The slab wants somebody to stand in front of it. Build a void anchor within ' +
      'six tiles of it, give it power, and be ready for everything that has been arriving ' +
      'in ones and twos to arrive at once.',
      'threat', Anomaly.monolith());
    return true;
  };

  function anchorNearMonolith(map) {
    var slab = monolith(map);
    if (!slab) return null;
    var list = map.byDef('voidAnchor') || [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i].spawned) continue;
      if (U.cheb(list[i].x, list[i].y, slab.x, slab.y) <= 7) return list[i];
    }
    return null;
  }
  Anomaly.anchor = function () {
    var g = G();
    return g && g.map ? anchorNearMonolith(g.map) : null;
  };

  Anomaly.beginFinale = function (game) {
    game = game || G();
    var map = game && game.map;
    if (!map || state.finale || state.stage < 5) return false;
    var anchor = anchorNearMonolith(map);
    if (!anchor) return false;
    state.finale = {
      phase: 'charging', startTick: now(), charge: 0, waves: 0,
      nextWaveTick: now() + 2000
    };
    letter('The anchor is live',
      'The anchor has taken hold of the slab and it is not letting go for about a day and ' +
      'a quarter. Everything that has ever come out of it is coming now, all at once, and ' +
      'it is coming for the anchor. Keep the anchor standing and keep the power on.',
      'threat', anchor);
    var list = colonists(map);
    for (var i = 0; i < list.length; i++) addDread(list[i], 0.25, 'the anchor');
    mirror();
    return true;
  };

  function finaleWave(game, map, f) {
    var slab = monolith(map);
    var anchor = anchorNearMonolith(map);
    var at = anchor || slab;
    if (!at) return;
    f.waves++;
    var pool = ['shambler', 'shambler', 'fleshbeast'];
    if (f.waves >= 2) pool.push('sightstealer');
    if (f.waves >= 3) pool.push('devourer');
    if (f.waves >= 4) pool.push('metalhorror');
    var n = U.clamp(4 + f.waves * 2, 4, 20);
    var anchorCell = freeCellNear(map, at.x + U.randInt(-6, 6), at.y + U.randInt(-6, 6), 12) || at;
    for (var i = 0; i < n; i++) {
      var kind = U.pick(pool);
      var cell = freeCellNear(map, anchorCell.x + U.randInt(-5, 5), anchorCell.y + U.randInt(-5, 5), 10);
      if (cell) spawnEntity(map, kind, cell);
    }
    msg('Wave ' + f.waves + ' is out of the slab.', 'threat', at);
  }

  function tickFinale(game, map) {
    var f = state.finale;
    if (!f || f.phase !== 'charging') return;
    var anchor = anchorNearMonolith(map);
    if (!anchor || !anchor.spawned) { failFinale(game, map, 'The anchor is rubble.'); return; }
    var P = sys('Power');
    var powered = P && P.isPowered ? P.isPowered(anchor) : true;
    if (powered) f.charge += SLOW;
    else if ((game.tick % (SLOW * 4)) === 0) {
      msg('The anchor has no power. The charge has stopped.', 'threat', anchor);
    }
    if (now() >= f.nextWaveTick) {
      f.nextWaveTick = now() + U.randInt(5000, 9000);
      finaleWave(game, map, f);
    }
    if (!colonists(map).filter(function (p) { return !p.dead; }).length) {
      failFinale(game, map, 'There was nobody left to hold it.');
      return;
    }
    if (f.charge >= FINALE_CHARGE) winFinale(game, map, anchor);
  }

  function winFinale(game, map, anchor) {
    state.finale = { phase: 'won', startTick: state.finale.startTick, charge: FINALE_CHARGE,
                     waves: state.finale.waves, nextWaveTick: 0 };
    setStage(STAGE_MAX);
    /* Everything of theirs on the map stops at once, and the slab
       goes with it. Nothing else changes: the colony still has to eat. */
    var list = liveEntities(map);
    for (var i = 0; i < list.length; i++) {
      var H = sys('Health');
      if (H && H.kill) H.kill(list[i], 'the anchor');
    }
    var slab = monolith(map);
    if (slab) {
      map.addItem('voidShard', slab.x, slab.y, U.randInt(8, 16));
      map.addItem('dreadmetal', slab.x, slab.y, U.randInt(60, 120));
      map.destroyThing(slab, 'unmade');
      state.monolithId = 0;
    }
    if (anchor && anchor.spawned) map.destroyThing(anchor, 'spent');
    var survivors = colonists(map);
    for (var c = 0; c < survivors.length; c++) {
      addThought(survivors[c], 'anomalyEnded');
      var a = dread(survivors[c]);
      a.dread = 0;
      a.resist = U.clamp(a.resist + 0.25, -0.3, 0.9);
    }
    letter('It is quiet',
      'The anchor finished, the slab came apart along lines that were always there, and ' +
      'everything that was standing up out there stopped standing up. It took ' +
      state.stats.risen + ' risen bodies, ' + state.stats.escaped + ' containment failures ' +
      'and ' + state.stats.taken + ' people to get here.\n\nThe ground is still scarred, ' +
      'the shards are still in the store, and nobody is going to sleep properly for a ' +
      'season. But it is quiet.',
      'good', slab || undefined);
    mirror();
  }

  function failFinale(game, map, why) {
    state.finale = { phase: 'failed', startTick: state.finale.startTick,
                     charge: state.finale.charge, waves: state.finale.waves, nextWaveTick: 0 };
    letter('The anchor is gone',
      why + ' The slab is still standing and it is louder than it was. The colony can try ' +
      'again, if there is anybody left willing to build another anchor.',
      'death', Anomaly.monolith());
    var list = colonists(map);
    for (var i = 0; i < list.length; i++) {
      addThought(list[i], 'anomalyLost');
      addDread(list[i], 0.45, 'the anchor failed');
    }
    mirror();
  }

  Anomaly.finale = function () {
    if (!state.finale) return null;
    return {
      phase: state.finale.phase,
      progress: U.clamp01(state.finale.charge / FINALE_CHARGE),
      waves: state.finale.waves
    };
  };

  /* ============================================================
     13. THE TICK
     ============================================================ */

  function tickEntities(game, map) {
    var list = liveEntities(map);
    for (var i = 0; i < list.length; i++) {
      var pawn = list[i];
      switch (pawn.kindId) {
        case 'fleshbeast': tickFleshbeast(map, pawn); break;
        case 'sightstealer': tickSightstealer(game, map, pawn); break;
        case 'revenant': tickRevenant(game, map, pawn); break;
        case 'devourer': tickDevourer(game, map, pawn); break;
        default: break;
      }
    }
    /* A revenant that died releases whoever it was holding, and a
       devourer that died stops being a container the moment somebody
       opens it - that one is a job, this one is not. */
    if (state.stage >= 3 && !hasKind(map, 'revenant')) freeHypnotised(map);

    /* Anything of theirs that dies leaves something worth studying,
       and corpses left where they fell are tomorrow's problem. */
    var corpses = map.byDef('corpse') || [];
    for (var c = 0; c < corpses.length; c++) {
      var body = corpses[c];
      if (!body.spawned || body.anomChecked) continue;
      body.anomChecked = 1;
      var kindId = body.corpse ? body.corpse.kindId : null;
      if (kindId && HOLD_STRENGTH[kindId] !== undefined) {
        state.stats.killed++;
        if (state.tree.dissection && U.chance(0.55)) map.addItem('voidShard', body.x, body.y, 1);
        map.destroyThing(body, 'dissolved');
        continue;
      }
      if (state.stage >= 1) markRisable(map, body.x, body.y, 0.35 + U.rand());
    }
  }

  Anomaly.tick = function (game) {
    game = game || G();
    if (!game || !game.map) return;
    ensureIncidents();
    detectNewGame(game);
    if (game.gameOver) return;
    var map = game.map;

    rehydrate(map);
    placeMonolith(game, map);
    tickTouch(game, map);

    if (state.stage < 1) { mirror(); return; }

    rescanFlesh(map);
    tickEntities(game, map);
    tickShamblerRise(game, map);
    tickContainment(game, map);
    tickInfections(game, map);
    tickFlesh(game, map);
    tickRitual(game, map);
    tickDread(game, map);
    tickFinale(game, map);

    if (state.stage === 5 && !state.finale && anchorNearMonolith(map)) {
      var anchor = anchorNearMonolith(map);
      var P = sys('Power');
      if (!P || !P.isPowered || P.isPowered(anchor)) Anomaly.beginFinale(game);
    }
    mirror();
  };

  /* ============================================================
     14. PERSISTENCE

     save.js copies scalars off a Thing and whole plain objects off
     a pawn, and it does neither for a module's private state. So
     the durable half of this system lives on the monolith as
     scalars and is read back after a load.
     ============================================================ */

  function treeBits() {
    var out = [];
    for (var i = 0; i < TREE.length; i++) if (state.tree[TREE[i].id]) out.push(TREE[i].id);
    return out.join('|');
  }

  function mirror() {
    var g = G();
    var map = g && g.map;
    var slab = map ? monolith(map) : null;
    if (!slab) return;
    slab.anomStage = state.stage;
    slab.anomDark = state.dark;
    slab.anomSpent = state.spent;
    slab.anomTree = treeBits();
    slab.anomTouch = state.touched ? 1 : 0;
    slab.anomSessions = state.sessions;
    slab.anomKilled = state.stats.killed;
    slab.anomContained = state.stats.contained;
    slab.anomEscaped = state.stats.escaped;
    slab.anomTaken = state.stats.taken;
    slab.anomRisenCount = state.stats.risen;
    slab.anomHosts = state.stats.hosts;
    slab.anomFinale = state.finale ? state.finale.phase : '';
    slab.anomCharge = state.finale ? state.finale.charge : 0;
    slab.anomWaves = state.finale ? state.finale.waves : 0;
  }

  /* A save restored into a fresh page has a monolith carrying the
     whole chain and a module that knows nothing. One read puts them
     back in agreement, and it only ever reads forwards. */
  function rehydrate(map) {
    var slab = monolith(map);
    if (!slab || slab.anomStage === undefined) return;
    if (slab.anomStage <= state.stage && state.stage > 0) return;
    if (slab.anomStage <= 0) return;
    state.stage = slab.anomStage | 0;
    state.dark = slab.anomDark || 0;
    state.spent = slab.anomSpent || 0;
    state.touched = !!slab.anomTouch;
    state.sessions = slab.anomSessions || 0;
    state.stats.killed = slab.anomKilled || 0;
    state.stats.contained = slab.anomContained || 0;
    state.stats.escaped = slab.anomEscaped || 0;
    state.stats.taken = slab.anomTaken || 0;
    state.stats.risen = slab.anomRisenCount || 0;
    state.stats.hosts = slab.anomHosts || 0;
    state.tree = {};
    (slab.anomTree || '').split('|').forEach(function (id) {
      if (TREE_BY_ID[id]) { state.tree[id] = true; applyUnlocks(TREE_BY_ID[id]); }
    });
    if (slab.anomFinale) {
      state.finale = {
        phase: slab.anomFinale, startTick: 0,
        charge: slab.anomCharge || 0, waves: slab.anomWaves || 0,
        nextWaveTick: now() + 3000
      };
    }
    state.placed = true;
    state.flesh.scanned = false;
    debugLog('rehydrated at stage ' + state.stage);
  }

  Anomaly.save = function () {
    return {
      version: 1,
      stage: state.stage, touched: state.touched, touchWanted: state.touchWanted,
      dark: state.dark, spent: state.spent, tree: treeBits(),
      sessions: state.sessions, monolithId: state.monolithId, placed: state.placed,
      darknessUntil: state.darknessUntil,
      flesh: { ticksLeft: state.flesh.ticksLeft, cells: state.flesh.cells.slice(0, 1200) },
      finale: state.finale ? {
        phase: state.finale.phase, startTick: state.finale.startTick,
        charge: state.finale.charge, waves: state.finale.waves
      } : null,
      stats: {
        killed: state.stats.killed, contained: state.stats.contained,
        escaped: state.stats.escaped, taken: state.stats.taken,
        risen: state.stats.risen, hosts: state.stats.hosts
      },
      lastSeenTick: state.lastSeenTick
    };
  };

  Anomaly.load = function (obj) {
    if (!obj || typeof obj !== 'object') return false;
    var ready = state.incidentsReady;
    state = blankState();
    state.incidentsReady = ready;
    state.stage = obj.stage || 0;
    state.touched = !!obj.touched;
    state.touchWanted = !!obj.touchWanted;
    state.dark = obj.dark || 0;
    state.spent = obj.spent || 0;
    state.sessions = obj.sessions || 0;
    state.monolithId = obj.monolithId || 0;
    state.placed = !!obj.placed;
    state.darknessUntil = obj.darknessUntil || 0;
    (obj.tree || '').split('|').forEach(function (id) {
      if (TREE_BY_ID[id]) { state.tree[id] = true; applyUnlocks(TREE_BY_ID[id]); }
    });
    if (obj.flesh) {
      state.flesh.ticksLeft = obj.flesh.ticksLeft || 0;
      state.flesh.cells = (obj.flesh.cells || []).slice();
      state.flesh.scanned = state.flesh.cells.length > 0;
    }
    state.finale = obj.finale ? {
      phase: obj.finale.phase || 'charging', startTick: obj.finale.startTick || 0,
      charge: obj.finale.charge || 0, waves: obj.finale.waves || 0,
      nextWaveTick: now() + 3000
    } : null;
    if (obj.stats) {
      for (var k in state.stats) if (obj.stats[k] !== undefined) state.stats[k] = obj.stats[k];
    }
    state.lastSeenTick = obj.lastSeenTick || 0;
    return true;
  };

  /* ============================================================
     15. WHAT A UI WOULD ASK FOR
     ============================================================ */

  Anomaly.summary = function (game) {
    game = game || G();
    var map = game && game.map;
    var held = [];
    var infested = [];
    var worst = null;
    if (map) {
      var list = platforms(map);
      for (var i = 0; i < list.length; i++) {
        var info = Anomaly.containedAt(list[i]);
        if (info) held.push(info);
      }
      var people = colonists(map);
      for (var p = 0; p < people.length; p++) {
        var a = people[p].anomaly;
        if (a && a.infestedTick && a.infestedKnown) infested.push(nameOf(people[p]));
        if (a && (!worst || a.dread > worst.dread)) {
          worst = { name: nameOf(people[p]), dread: a.dread, hollow: a.hollow };
        }
      }
    }
    return {
      stage: state.stage,
      stageLabel: Anomaly.stageLabel(),
      touched: state.touched,
      dark: state.dark,
      spent: state.spent,
      nextStageCost: Anomaly.stageCost(),
      canCommune: state.stage >= 1 && state.stage < 5 && state.dark >= Anomaly.stageCost(),
      tree: Anomaly.tree(),
      contained: held,
      knownInfested: infested,
      entities: map ? liveEntities(map).length : 0,
      darkness: state.darknessUntil > now(),
      flesh: state.flesh.cells.length,
      worstDread: worst,
      sessions: state.sessions,
      stats: {
        killed: state.stats.killed, contained: state.stats.contained,
        escaped: state.stats.escaped, taken: state.stats.taken,
        risen: state.stats.risen, hosts: state.stats.hosts
      },
      finale: Anomaly.finale()
    };
  };

  Anomaly.TREE = TREE;
  Anomaly.STAGE_LABEL = STAGE_LABEL;
  Anomaly.FACTION = FACTION;

  root.Anomaly = Anomaly;
})(this);
