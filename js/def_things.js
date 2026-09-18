/* ============================================================
   def_things.js - resources, food, weapons, apparel, and every
   building the colony can put down.

   This file is data, not machinery. The engine never hard-codes a
   wall or a potato; it looks up a def and reads the fields below.
   Four conventions run through the whole table:

   1. marketValue is in silver, and map.wealth() sums it. The
      storyteller turns wealth into raid points, so a number invented
      here is a number of raiders three days later. The ratios are
      kept close to the balance table on purpose.
   2. Anything impassable says so with `passable: false` and leaves
      pathCost at 0. map.js turns the flag into map.IMPASSABLE;
      pathCost only ever means "extra ticks to walk over this".
   3. A stuffable def lists its cost against wood, its default stuff.
      construct.js swaps the key for whatever material the player
      picked and keeps the count - "5 stuff" is one number, not five.
   4. Rates written per day (fuel burn, rot) are per day; whoever
      consumes them divides by 60000. Ticks are ticks.
   ============================================================ */
(function (root) {
  'use strict';

  var Defs = root.Defs;

  /* ---------- shared footprints ----------
     Frozen because every one-tile def points at the same object. A def
     is read-only data; freezing turns an accidental write into a loud
     error instead of a silent resize of half the game. */
  var S11 = Object.freeze({ w: 1, h: 1 });
  var S12 = Object.freeze({ w: 1, h: 2 });
  var S21 = Object.freeze({ w: 2, h: 1 });
  var S22 = Object.freeze({ w: 2, h: 2 });
  var S33 = Object.freeze({ w: 3, h: 3 });
  var S42 = Object.freeze({ w: 4, h: 2 });

  function withDefaults(base, over) {
    var out = {}, k;
    for (k in base) out[k] = base[k];
    for (k in over) out[k] = over[k];
    return out;
  }

  /* ---------- sub-object templates ----------
     Buildings get asked about flags they mostly do not have. Filling
     every flag once means power.js can read def.building.powerConsumed
     and jobs.js can read def.building.isBed without a guard on each
     access. The throw on an unknown key catches a typo at load time,
     which is the only moment a data file can still be fixed cheaply. */
  var BUILDING_TEMPLATE = {
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
    for (k in BUILDING_TEMPLATE) out[k] = BUILDING_TEMPLATE[k];
    if (o) {
      for (k in o) {
        if (!(k in BUILDING_TEMPLATE)) throw new Error('unknown building field: ' + k);
        out[k] = o[k];
      }
    }
    return out;
  }

  /* accuracy is the chance to hit at touch / short / medium / long
     range before skill and cover are applied:
     hit = accuracy(range) * (0.4 + 0.03 * shooting) * cover. */
  var WEAPON_TEMPLATE = {
    ranged: false, damage: 1, damageType: 'blunt', range: 1,
    warmupTicks: 0, cooldownTicks: 60, burstCount: 1, burstTicks: 0,
    accuracy: null, armorPen: 0,
    projectileSpeed: 0, projectileDef: null, minRange: 0, forcedMissRadius: 0
  };

  function weap(o) {
    var out = {}, k;
    for (k in WEAPON_TEMPLATE) out[k] = WEAPON_TEMPLATE[k];
    for (k in o) {
      if (!(k in WEAPON_TEMPLATE)) throw new Error('unknown weapon field: ' + k);
      out[k] = o[k];
    }
    /* Melee weapons never miss by range, so they carry a flat curve
       rather than four numbers that would never be read. */
    if (!out.accuracy) out.accuracy = { touch: 0.95, short: 0.8, medium: 0.6, long: 0.4 };
    return out;
  }

  /* insulation is in degrees C of comfortable range added, armor is the
     fraction of incoming damage of that type deflected or blunted, and
     coverage is the chance the piece is in the way of a hit that lands
     on one of its slots. */
  var APPAREL_TEMPLATE = {
    slots: null, armorSharp: 0, armorBlunt: 0,
    insulationCold: 0, insulationHeat: 0, coverage: 0.9
  };

  function app(o) {
    var out = {}, k;
    for (k in APPAREL_TEMPLATE) out[k] = APPAREL_TEMPLATE[k];
    for (k in o) {
      if (!(k in APPAREL_TEMPLATE)) throw new Error('unknown apparel field: ' + k);
      out[k] = o[k];
    }
    return out;
  }

  /* ---------- defaults ----------
     Every field a consumer may read is present on every def, so no
     system has to know which optional fields exist on which category. */
  var ITEM = {
    category: 'item',
    description: '',
    sprite: 'item', color: '#b0b0b8', color2: null,
    stackLimit: 75, mass: 0.5, marketValue: 1,
    nutrition: 0, foodType: null, rotDays: null,
    isMedicine: false, medicinePotency: 0,
    passable: true, pathCost: 0, fillPercent: 0, blocksLight: false, holdsRoof: false,
    size: S11, rotatable: false, hp: 60, flammable: true,
    beauty: 0, comfort: 0, natural: false,
    buildCost: null, stuffable: false, workToBuild: 0, buildSkill: null,
    buildCategory: null, researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null,
    building: null, weapon: null, apparel: null
  };

  /* Weapons and apparel are items that never stack and are worth real
     silver, which matters twice: raid size, and what a raider drops. */
  var GEAR = withDefaults(ITEM, {
    stackLimit: 1, mass: 2, marketValue: 50, hp: 100, flammable: true
  });

  var BUILDING = withDefaults(ITEM, {
    category: 'building', sprite: 'box', stackLimit: 1,
    mass: 20, marketValue: 0, hp: 120,
    passable: false, pathCost: 0, fillPercent: 1,
    blocksLight: false, holdsRoof: false, flammable: false,
    buildSkill: 'construction', building: bld({})
  });

  /* ============================================================
     RESOURCES
     The stuff everything else is made of. Stack limits follow mass:
     silver is small and travels 500 to a pile, stone chunks are a
     tile each and do not stack at all.
     ============================================================ */
  Defs.add('thing', {

    wood: {
      label: 'wood',
      description: 'Rough logs cut from trees. Builds, burns and cooks; every colony starts on it.',
      sprite: 'log', color: '#a9783f', color2: '#7b5427',
      stackLimit: 75, mass: 0.3, marketValue: 1.7, hp: 60, flammable: true, beauty: 0
    },

    steel: {
      label: 'steel',
      description: 'Refined metal in flat bars. Strong, non-flammable, and the backbone of anything electrical.',
      sprite: 'ingot', color: '#8f97a3', color2: '#c2c8d2',
      stackLimit: 75, mass: 0.5, marketValue: 1.9, hp: 80, flammable: false
    },

    components: {
      label: 'components',
      description: 'Bundled circuitry and precision parts. Cannot be improvised; mined from compacted seams or machined at a smithy.',
      sprite: 'component', color: '#6f8fa8', color2: '#d0c27a',
      stackLimit: 50, mass: 0.6, marketValue: 14, hp: 60, flammable: false
    },

    silver: {
      label: 'silver',
      description: 'The currency everyone accepts. Piles of it in the stockpile are also the first thing a raider counts.',
      sprite: 'coin', color: '#c8ccd4', color2: '#8d939c',
      stackLimit: 500, mass: 0.01, marketValue: 1, hp: 60, flammable: false
    },

    stoneChunk: {
      label: 'stone chunk',
      description: 'A rough block of rock left where a wall was mined out. Useless until a stonecutter squares it off.',
      sprite: 'chunk', color: '#6e6e78', color2: '#565660',
      stackLimit: 1, mass: 20, marketValue: 2, hp: 100, flammable: false, beauty: -2,
      fillPercent: 0.35, pathCost: 18
    },

    stoneBlocks: {
      label: 'stone blocks',
      description: 'Squared masonry. Slow to build with, but it never burns and it never rots.',
      sprite: 'block', color: '#7d7d88', color2: '#5c5c66',
      stackLimit: 75, mass: 1, marketValue: 2.2, hp: 100, flammable: false
    },

    cloth: {
      label: 'cloth',
      description: 'Woven cotton fibre. Clothes, beds, sandbags - anything that has to be soft or cheap.',
      sprite: 'cloth', color: '#d8cfc0', color2: '#b3a795',
      stackLimit: 75, mass: 0.06, marketValue: 1.9, hp: 50, flammable: true
    },

    leather: {
      label: 'leather',
      description: 'Cured animal hide from the butcher table. Warmer than cloth and turns a knife better.',
      sprite: 'cloth', color: '#9c6b3f', color2: '#7a5030',
      stackLimit: 75, mass: 0.08, marketValue: 3, hp: 60, flammable: true
    },

    herbalMedicine: {
      label: 'herbal medicine',
      description: 'Pounded healroot leaves. Crude, but it stops a wound bleeding and buys time against infection.',
      sprite: 'herb', color: '#5c8f3e', color2: '#8fbb62',
      stackLimit: 25, mass: 0.35, marketValue: 10, hp: 50,
      isMedicine: true, medicinePotency: 0.6
    },

    medicine: {
      label: 'medicine',
      description: 'Sterile packaged medicine. Doubles what a doctor can do for a gunshot or a fever.',
      sprite: 'medkit', color: '#e8e2d4', color2: '#c0392b',
      stackLimit: 25, mass: 0.4, marketValue: 26, hp: 50,
      isMedicine: true, medicinePotency: 1
    },

    chemfuel: {
      label: 'chemfuel',
      description: 'Volatile refined fuel. Burns hot and fast, and takes the room with it if a stray spark lands.',
      sprite: 'barrel', color: '#c4622a', color2: '#7a3a18',
      stackLimit: 75, mass: 0.2, marketValue: 2.2, hp: 40, flammable: true
    }

  }, ITEM);

  /* ============================================================
     FOOD
     Nutrition is the fuel the food need burns: 1.6 per day per
     colonist. Raw ingredients are 0.05 a unit so a meal costs ten of
     them, cooked meals are 0.9 - roughly two thirds of a day.
     ============================================================ */
  Defs.add('thing', {

    riceRaw: {
      label: 'rice',
      description: 'Raw rice grains. Edible as they are, miserable as a meal, and the fastest crop there is.',
      sprite: 'grain', color: '#e6dba8', color2: '#c2b280',
      stackLimit: 75, mass: 0.04, marketValue: 1.1,
      nutrition: 0.05, foodType: 'raw', rotDays: 10, hp: 40
    },

    potatoRaw: {
      label: 'potatoes',
      description: 'Raw potatoes. Slow to grow, but they yield nearly twice what rice does per plant.',
      sprite: 'root', color: '#c9a86a', color2: '#8a6134',
      stackLimit: 75, mass: 0.05, marketValue: 1.2,
      nutrition: 0.05, foodType: 'raw', rotDays: 12, hp: 40
    },

    cornRaw: {
      label: 'corn',
      description: 'Raw corn. Takes a long season to come in and keeps far better than anything else in the field.',
      sprite: 'corn', color: '#e8c24a', color2: '#9c8a2e',
      stackLimit: 75, mass: 0.05, marketValue: 1.3,
      nutrition: 0.05, foodType: 'raw', rotDays: 20, hp: 40
    },

    berries: {
      label: 'berries',
      description: 'Wild berries picked off a bush. Sweet, perishable, and free.',
      sprite: 'berry', color: '#9c2d4f', color2: '#d4557a',
      stackLimit: 75, mass: 0.03, marketValue: 1.4,
      nutrition: 0.05, foodType: 'raw', rotDays: 6, hp: 30
    },

    meatRaw: {
      label: 'raw meat',
      description: 'Butchered animal meat. Spoils in days and turns a colonist queasy if eaten as it is.',
      sprite: 'meat', color: '#b0453f', color2: '#7d2c28',
      stackLimit: 75, mass: 0.05, marketValue: 2,
      nutrition: 0.05, foodType: 'raw', rotDays: 2.5, hp: 40
    },

    mealSimple: {
      label: 'simple meal',
      description: 'A plain cooked meal. Nothing to write home about, but nobody eats it over a sink either.',
      sprite: 'meal', color: '#d9b36b', color2: '#8a6134',
      stackLimit: 10, mass: 0.44, marketValue: 11,
      nutrition: 0.9, foodType: 'meal', rotDays: 5, hp: 50
    },

    mealFine: {
      label: 'fine meal',
      description: 'A cooked meal with meat and vegetables both. Worth the extra cooking time for the mood alone.',
      sprite: 'meal', color: '#e8c87a', color2: '#b0453f',
      stackLimit: 10, mass: 0.44, marketValue: 20,
      nutrition: 0.9, foodType: 'meal', rotDays: 5, hp: 50
    },

    kibble: {
      label: 'kibble',
      description: 'Dried pellets pressed from scraps and meat. Animals live on it; a colonist eating it says so for days.',
      sprite: 'kibble', color: '#8f7550', color2: '#6b5638',
      stackLimit: 75, mass: 0.04, marketValue: 1.1,
      nutrition: 0.05, foodType: 'kibble', rotDays: null, hp: 40
    }

  }, ITEM);

  /* ============================================================
     MELEE WEAPONS
     A melee weapon is a cooldown and a damage number. cooldownTicks is
     the whole swing cycle, so a knife lands a hit every 1.7 seconds
     and a spear every 2.3 - the spear hits harder for the wait.
     ============================================================ */
  Defs.add('thing', {

    knife: {
      label: 'knife',
      description: 'A short blade. Fast, concealable, and the difference between a cornered colonist and a corpse.',
      sprite: 'knife', color: '#8f97a3', color2: '#7b5427',
      mass: 0.5, marketValue: 50, hp: 100, flammable: false,
      weapon: weap({
        ranged: false, damage: 11, damageType: 'stab', range: 1,
        cooldownTicks: 100, armorPen: 0.15
      })
    },

    club: {
      label: 'club',
      description: 'A weighted length of wood. Crude, cheap, and it puts people down without opening them up.',
      sprite: 'club', color: '#a9783f', color2: '#7b5427',
      mass: 1.5, marketValue: 25, hp: 90, flammable: true,
      weapon: weap({
        ranged: false, damage: 14, damageType: 'blunt', range: 1,
        cooldownTicks: 120, armorPen: 0.1
      })
    },

    spear: {
      label: 'spear',
      description: 'A long hafted point. Slow to bring back around, but it reaches first and it reaches hard.',
      sprite: 'spear', color: '#a9783f', color2: '#8f97a3',
      mass: 2, marketValue: 60, hp: 100, flammable: true,
      weapon: weap({
        ranged: false, damage: 18, damageType: 'stab', range: 1,
        cooldownTicks: 140, armorPen: 0.15
      })
    },

    /* ============================================================
       RANGED WEAPONS
       warmupTicks is the aim before the shot and is where a pawn is
       vulnerable; cooldownTicks is the recovery after. Burst weapons
       fire burstCount shots burstTicks apart inside one cooldown.
       ============================================================ */

    shortBow: {
      label: 'short bow',
      description: 'A bent stave and a string. No research, no metal, and it still puts an arrow through a raider.',
      sprite: 'bow', color: '#a9783f', color2: '#d8cfc0',
      mass: 1.5, marketValue: 100, hp: 90, flammable: true,
      weapon: weap({
        ranged: true, damage: 12, damageType: 'stab', range: 23,
        warmupTicks: 70, cooldownTicks: 90,
        accuracy: { touch: 0.8, short: 0.72, medium: 0.6, long: 0.4 },
        armorPen: 0.1, projectileSpeed: 30, projectileDef: 'arrow'
      })
    },

    pistol: {
      label: 'pistol',
      description: 'A simple autoloading sidearm. Quick to bring up and forgiving up close, useless past the treeline.',
      sprite: 'gun', color: '#6a6a72', color2: '#3d3d44',
      mass: 1.4, marketValue: 210, hp: 100, flammable: false,
      weapon: weap({
        ranged: true, damage: 11, damageType: 'bullet', range: 26,
        warmupTicks: 30, cooldownTicks: 60,
        accuracy: { touch: 0.87, short: 0.77, medium: 0.58, long: 0.36 },
        armorPen: 0.15, projectileSpeed: 70, projectileDef: 'bullet'
      })
    },

    boltRifle: {
      label: 'bolt-action rifle',
      description: 'One heavy round at a time, worked by hand. The most accurate thing a new colony can carry.',
      sprite: 'rifle', color: '#7b5427', color2: '#4a4a52',
      mass: 3, marketValue: 300, hp: 100, flammable: false,
      weapon: weap({
        ranged: true, damage: 18, damageType: 'bullet', range: 31,
        warmupTicks: 90, cooldownTicks: 100,
        accuracy: { touch: 0.6, short: 0.79, medium: 0.84, long: 0.77 },
        armorPen: 0.18, projectileSpeed: 70, projectileDef: 'bullet'
      })
    },

    autoRifle: {
      label: 'assault rifle',
      description: 'Three-round bursts from a box magazine. Trades the bolt rifle accuracy for volume of fire.',
      sprite: 'rifle', color: '#4a4a52', color2: '#2c2c33',
      mass: 3.5, marketValue: 600, hp: 100, flammable: false,
      weapon: weap({
        ranged: true, damage: 12, damageType: 'bullet', range: 26,
        warmupTicks: 60, cooldownTicks: 80, burstCount: 3, burstTicks: 10,
        accuracy: { touch: 0.72, short: 0.73, medium: 0.68, long: 0.55 },
        armorPen: 0.15, projectileSpeed: 70, projectileDef: 'bullet'
      })
    },

    shotgun: {
      label: 'pump shotgun',
      description: 'Three heavy pellets in one blast. Devastating in a doorway, wasted across a field.',
      sprite: 'shotgun', color: '#5c4630', color2: '#3d3d44',
      mass: 3, marketValue: 250, hp: 100, flammable: false,
      weapon: weap({
        ranged: true, damage: 18, damageType: 'bullet', range: 14,
        warmupTicks: 60, cooldownTicks: 110, burstCount: 3, burstTicks: 3,
        accuracy: { touch: 0.86, short: 0.78, medium: 0.52, long: 0.22 },
        armorPen: 0.1, projectileSpeed: 65, projectileDef: 'bullet'
      })
    },

    sniperRifle: {
      label: 'sniper rifle',
      description: 'A long, slow, scoped rifle. It opens the fight before the raiders know there is one.',
      sprite: 'rifle', color: '#3f4a3a', color2: '#2c2c33',
      mass: 5, marketValue: 650, hp: 100, flammable: false,
      weapon: weap({
        ranged: true, damage: 25, damageType: 'bullet', range: 45,
        warmupTicks: 150, cooldownTicks: 120,
        accuracy: { touch: 0.5, short: 0.65, medium: 0.8, long: 0.88 },
        armorPen: 0.3, projectileSpeed: 80, projectileDef: 'bullet'
      })
    }

  }, GEAR);

  /* ============================================================
     APPAREL
     Armor is a fraction of the damage turned away. insulationCold is
     how many degrees of cold the wearer stops noticing, which is the
     only thing standing between a colony and its first winter.
     ============================================================ */
  Defs.add('thing', {

    shirt: {
      label: 'shirt',
      description: 'A plain button shirt. Covers the torso, keeps the worst of the chill off, stops nothing sharper than a branch.',
      sprite: 'shirt', color: '#d8cfc0', color2: '#b3a795',
      mass: 0.6, marketValue: 32, hp: 80,
      apparel: app({
        slots: ['torso'], armorSharp: 0.03, armorBlunt: 0.02,
        insulationCold: 3, insulationHeat: 1, coverage: 0.9
      })
    },

    pants: {
      label: 'pants',
      description: 'Simple trousers. Nobody thinks about them until a colonist has none and the mood tab says so.',
      sprite: 'pants', color: '#6b7a8f', color2: '#4a5566',
      mass: 0.5, marketValue: 22, hp: 80,
      apparel: app({
        slots: ['legs'], armorSharp: 0.03, armorBlunt: 0.02,
        insulationCold: 3, insulationHeat: 0.5, coverage: 0.9
      })
    },

    jacket: {
      label: 'jacket',
      description: 'A lined outer coat. Worn over a shirt, it buys ten degrees of winter.',
      sprite: 'jacket', color: '#7a5030', color2: '#4f3421',
      mass: 1.5, marketValue: 60, hp: 100,
      apparel: app({
        slots: ['torso'], armorSharp: 0.08, armorBlunt: 0.05,
        insulationCold: 10, insulationHeat: 0, coverage: 0.85
      })
    },

    parka: {
      label: 'parka',
      description: 'A heavy hooded coat. Bulky and hot indoors, and the reason anyone survives a cold snap outside.',
      sprite: 'parka', color: '#3f5b6b', color2: '#273a45',
      mass: 2.5, marketValue: 140, hp: 110,
      apparel: app({
        slots: ['torso'], armorSharp: 0.1, armorBlunt: 0.06,
        insulationCold: 24, insulationHeat: -4, coverage: 0.9
      })
    },

    armorVest: {
      label: 'flak vest',
      description: 'Layered plates over the chest. Heavy, ugly, and it turns a rifle round into a bruise more often than not.',
      sprite: 'vest', color: '#4a5540', color2: '#2f382a',
      mass: 6, marketValue: 250, hp: 140, flammable: false,
      apparel: app({
        slots: ['torso'], armorSharp: 0.35, armorBlunt: 0.1,
        insulationCold: 2, insulationHeat: -2, coverage: 0.75
      })
    },

    helmet: {
      label: 'steel helmet',
      description: 'A shaped steel shell. The head is a small target that ends a colonist instantly, so it is worth covering.',
      sprite: 'helmet', color: '#6f7784', color2: '#474e58',
      mass: 2, marketValue: 130, hp: 120, flammable: false,
      apparel: app({
        slots: ['head'], armorSharp: 0.3, armorBlunt: 0.18,
        insulationCold: 1, insulationHeat: -1, coverage: 0.7
      })
    }

  }, GEAR);

  /* ============================================================
     STRUCTURE
     The two buildings the whole base is made of. Both hold a roof up
     and both are stuffable, so the same wall is 180 hp in wood and a
     good deal more in stone once construct.js scales it by material.
     ============================================================ */
  Defs.add('thing', {

    wall: {
      label: 'wall',
      description: 'A solid wall. Holds up a roof, blocks sight and bullets, and turns outdoors into a room.',
      sprite: 'wall', color: '#8a6134', color2: '#6b4a27',
      hp: 180, mass: 40, flammable: true,
      passable: false, fillPercent: 1, blocksLight: true, holdsRoof: true,
      stuffable: true, buildCost: { wood: 5 }, workToBuild: 135,
      buildCategory: 'structure', beauty: 0
    },

    door: {
      label: 'door',
      description: 'A powered-open door. Colonists and tame animals pass; it keeps the heat in and strangers slowed down.',
      sprite: 'door', color: '#8a6134', color2: '#c9a86a',
      hp: 150, mass: 35, flammable: true,
      passable: true, pathCost: 0, fillPercent: 1, blocksLight: true, holdsRoof: true,
      stuffable: true, buildCost: { wood: 5 }, workToBuild: 300,
      buildCategory: 'structure',
      /* openTicks is the swing time a pawn waits through on first touch.
         Path.stepCost charges the standing 20-tick penalty separately. */
      building: bld({ isDoor: true, openTicks: 45 })
    }

  }, BUILDING);

  /* ============================================================
     NATURAL WALLS
     Not buildable and never in a build menu: mapgen writes them, and
     the only way through is a miner with 800 work in him. The three
     compacted seams are the sole source of steel and components on a
     map that has no traders yet.
     ============================================================ */
  Defs.add('thing', {

    rockWall: {
      label: 'rock',
      description: 'Solid natural stone. Mining it out leaves a chunk behind and a roof that still needs holding up.',
      sprite: 'rockWall', color: '#5a5a62', color2: '#6e6e78',
      hp: 600, mass: 200, flammable: false,
      passable: false, fillPercent: 1, blocksLight: true, holdsRoof: true,
      natural: true, mineable: true, mineYield: { stoneChunk: 1 },
      leavings: { stoneChunk: 1 },
      /* Not buildable, so workToBuild is free to mean the mining work
         and Construct.mineWork has one place to read. */
      workToBuild: 800, buildSkill: 'mining'
    },

    compactedSteel: {
      label: 'compacted steel',
      description: 'A seam of pressed metal in the rock. Forty steel to whoever spends the pick work.',
      sprite: 'oreWall', color: '#5a5a62', color2: '#8f97a3',
      hp: 600, mass: 200, flammable: false,
      passable: false, fillPercent: 1, blocksLight: true, holdsRoof: true,
      natural: true, mineable: true, mineYield: { steel: 40 },
      leavings: { steel: 20 },
      workToBuild: 800, buildSkill: 'mining'
    },

    compactedComponents: {
      label: 'compacted machinery',
      description: 'Crushed ancient machinery fused into the stone. The only components a colony gets before it can machine its own.',
      sprite: 'oreWall', color: '#5a5a62', color2: '#6f8fa8',
      hp: 600, mass: 200, flammable: false,
      passable: false, fillPercent: 1, blocksLight: true, holdsRoof: true,
      natural: true, mineable: true, mineYield: { components: 20 },
      leavings: { components: 8 },
      workToBuild: 800, buildSkill: 'mining'
    },

    compactedSilver: {
      label: 'compacted silver',
      description: 'A bright vein running through the rock. Pure wealth, which is also pure raid points.',
      sprite: 'oreWall', color: '#5a5a62', color2: '#c8ccd4',
      hp: 600, mass: 200, flammable: false,
      passable: false, fillPercent: 1, blocksLight: true, holdsRoof: true,
      natural: true, mineable: true, mineYield: { silver: 40 },
      leavings: { silver: 20 },
      workToBuild: 800, buildSkill: 'mining'
    }

  }, BUILDING);

  /* ============================================================
     FURNITURE
     Mood lives here. A bed that is owned, in a room with a floor and
     a lamp, is worth more to a colony than another rifle.
     ============================================================ */
  Defs.add('thing', {

    bed: {
      label: 'bed',
      description: 'A proper bed. Sleeping in one recovers rest fast and gives a colonist somewhere that is theirs.',
      sprite: 'bed', color: '#8a6134', color2: '#d8cfc0',
      size: S12, rotatable: true, hp: 100, mass: 30, flammable: true,
      passable: true, pathCost: 10, fillPercent: 0.4,
      beauty: 2, comfort: 0.75,
      stuffable: true, buildCost: { wood: 30 }, workToBuild: 800,
      buildCategory: 'furniture',
      building: bld({
        isBed: true, bedRestEffectiveness: 1, bedComfort: 0.75,
        canBeForPrisoners: true
      })
    },

    sleepingSpot: {
      label: 'sleeping spot',
      description: 'A patch of ground someone has claimed. Free, immediate, and it shows in the mood tab every morning.',
      sprite: 'spot', color: '#7b6a4f', color2: '#5c4f3a',
      hp: 20, mass: 0, flammable: false,
      passable: true, pathCost: 0, fillPercent: 0,
      beauty: -1, comfort: 0.4,
      buildCost: {}, workToBuild: 15, buildCategory: 'furniture',
      building: bld({
        isBed: true, bedRestEffectiveness: 0.7, bedComfort: 0.4,
        canBeForPrisoners: true
      })
    },

    table: {
      label: 'table',
      description: 'A flat surface to eat at. Eating without one is a small grievance that every colonist keeps count of.',
      sprite: 'table', color: '#8a6134', color2: '#6b4a27',
      size: S22, hp: 180, mass: 60, flammable: true,
      passable: true, pathCost: 30, fillPercent: 0.4,
      beauty: 1,
      stuffable: true, buildCost: { wood: 40 }, workToBuild: 700,
      buildCategory: 'furniture',
      building: bld({ isTable: true })
    },

    stool: {
      label: 'stool',
      description: 'Something to sit on while eating or working. Comfort is a need like any other.',
      sprite: 'stool', color: '#8a6134', color2: '#6b4a27',
      hp: 75, mass: 12, flammable: true,
      passable: true, pathCost: 15, fillPercent: 0.25,
      beauty: 0, comfort: 0.7,
      stuffable: true, buildCost: { wood: 12 }, workToBuild: 200,
      buildCategory: 'furniture',
      building: bld({ isChair: true, interactionOffset: { dx: 0, dy: 0 } })
    },

    dresser: {
      label: 'dresser',
      description: 'A chest of drawers. Adds nothing but the sense that a bedroom is a room and not a cell.',
      sprite: 'dresser', color: '#8a6134', color2: '#c9a86a',
      hp: 100, mass: 40, flammable: true,
      passable: false, fillPercent: 0.5,
      beauty: 3,
      stuffable: true, buildCost: { wood: 40 }, workToBuild: 600,
      buildCategory: 'furniture'
    },

    grave: {
      label: 'grave',
      description: 'A dug plot for the dead. Burying a colonist stops the corpse rotting in the open where everyone walks past it.',
      sprite: 'grave', color: '#5c4f3a', color2: '#6e6e78',
      size: S12, rotatable: true, hp: 150, mass: 20, flammable: false,
      passable: false, fillPercent: 0.5,
      beauty: -2,
      buildCost: {}, workToBuild: 200, buildCategory: 'furniture',
      /* The plot is two tiles long, so the burier stands past the foot
         end at dy 2 - dy 1 would be the grave itself. */
      building: bld({ isGrave: true, interactionOffset: { dx: 0, dy: 2 } })
    },

    sculpture: {
      label: 'sculpture',
      description: 'An artwork made for its own sake. The single cheapest way to make a room somewhere people want to be.',
      sprite: 'sculpture', color: '#c9b48a', color2: '#8f97a3',
      hp: 100, mass: 45, flammable: true,
      passable: false, fillPercent: 0.5,
      beauty: 15, marketValue: 200,
      stuffable: true, buildCost: { wood: 40 }, workToBuild: 2200,
      buildSkill: 'artistic', buildCategory: 'furniture'
    },

    standingLamp: {
      label: 'standing lamp',
      description: 'An electric lamp on a pole. Colonists in the dark work slower and sour faster.',
      sprite: 'lamp', color: '#8f97a3', color2: '#ffc23c',
      hp: 65, mass: 8, flammable: false,
      passable: true, pathCost: 25, fillPercent: 0.2,
      beauty: 1,
      buildCost: { steel: 15 }, workToBuild: 250, buildCategory: 'furniture',
      researchPrerequisite: 'electricity',
      building: bld({ isLamp: true, powerConsumed: 65, lightRadius: 6 })
    }

  }, BUILDING);

  /* ============================================================
     PRODUCTION
     Every workbench is impassable and carries an interactionOffset:
     the tile, relative to the origin and rotated with the building,
     that a pawn has to stand on to work it. Keeping that cell clear
     is the player problem; jobs.js only has to read the offset.
     ============================================================ */
  Defs.add('thing', {

    campfire: {
      label: 'campfire',
      description: 'Burning wood in a ring of stones. Cooks, lights and heats a small room, and needs feeding forever.',
      sprite: 'campfire', color: '#5c4630', color2: '#ff8c1a',
      hp: 80, mass: 15, flammable: true,
      passable: false, fillPercent: 0.35,
      beauty: 2,
      buildCost: { wood: 20 }, workToBuild: 150, buildCategory: 'production',
      recipes: ['cookSimpleMeal'],
      building: bld({
        isWorkbench: true, isCampfire: true,
        fuelDefId: 'wood', fuelCapacity: 30, fuelBurnPerDay: 12,
        lightRadius: 6, tempPushTarget: null, tempPushRate: 10,
        interactionOffset: { dx: 0, dy: 1 }
      })
    },

    stove: {
      label: 'electric stove',
      description: 'A powered cooking range. Faster than a campfire, immune to the weather, and it can manage a fine meal.',
      sprite: 'stove', color: '#8f97a3', color2: '#c0392b',
      size: S21, rotatable: true, hp: 180, mass: 80, flammable: false,
      passable: false, fillPercent: 0.5,
      buildCost: { steel: 80, components: 2 }, workToBuild: 1400,
      buildCategory: 'production', researchPrerequisite: 'electricStove',
      recipes: ['cookSimpleMeal', 'cookFineMeal'],
      building: bld({
        isWorkbench: true, isStove: true, powerConsumed: 350,
        interactionOffset: { dx: 0, dy: 1 }
      })
    },

    butcherTable: {
      label: 'butcher table',
      description: 'A scarred wooden block. Turns dead animals into meat and leather, and raiders into neither.',
      sprite: 'butcher', color: '#8a6134', color2: '#b0453f',
      size: S21, rotatable: true, hp: 180, mass: 60, flammable: true,
      passable: false, fillPercent: 0.5,
      beauty: -3,
      buildCost: { wood: 45, steel: 15 }, workToBuild: 1200,
      buildCategory: 'production',
      recipes: ['butcherCorpse', 'makeKibble'],
      building: bld({
        isWorkbench: true, interactionOffset: { dx: 0, dy: 1 }
      })
    },

    craftingSpot: {
      label: 'crafting spot',
      description: 'A marked patch of ground. No bench, no power, no excuses - it makes bows and medicine on day one.',
      sprite: 'spot', color: '#7b6a4f', color2: '#8a6134',
      hp: 20, mass: 0, flammable: false,
      passable: true, pathCost: 0, fillPercent: 0,
      buildCost: {}, workToBuild: 20, buildCategory: 'production',
      recipes: ['makeHerbalMedicine', 'makeMedicine', 'forgeClub', 'forgeSpear', 'forgeShortBow'],
      building: bld({
        isWorkbench: true, interactionOffset: { dx: 0, dy: 0 }
      })
    },

    stonecutterTable: {
      label: 'stonecutter table',
      description: 'A frame and a saw for squaring chunks into blocks. Slow work that turns a mined-out mountain into a fireproof base.',
      sprite: 'stonecutter', color: '#8a6134', color2: '#7d7d88',
      size: S21, rotatable: true, hp: 180, mass: 70, flammable: true,
      passable: false, fillPercent: 0.5,
      buildCost: { wood: 50 }, workToBuild: 900,
      buildCategory: 'production', researchPrerequisite: 'stonecutting',
      recipes: ['cutStoneBlocks'],
      building: bld({
        isWorkbench: true, interactionOffset: { dx: 0, dy: 1 }
      })
    },

    tailoringBench: {
      label: 'tailoring bench',
      description: 'A bench of needles, thread and patterns. Everything anyone wears comes off this table.',
      sprite: 'tailor', color: '#8a6134', color2: '#d8cfc0',
      size: S21, rotatable: true, hp: 180, mass: 70, flammable: true,
      passable: false, fillPercent: 0.5,
      buildCost: { wood: 55, steel: 10 }, workToBuild: 1600,
      buildCategory: 'production', researchPrerequisite: 'tailoring',
      recipes: ['sewShirt', 'sewPants', 'sewJacket', 'sewParka', 'sewArmorVest', 'sewHelmet'],
      building: bld({
        isWorkbench: true, interactionOffset: { dx: 0, dy: 1 }
      })
    },

    smithy: {
      label: 'smithy',
      description: 'A forge, an anvil and a quench barrel. Knives, guns and the components to build with.',
      sprite: 'smithy', color: '#6a6a72', color2: '#ff8c1a',
      size: S21, rotatable: true, hp: 220, mass: 110, flammable: false,
      passable: false, fillPercent: 0.5,
      buildCost: { steel: 90, wood: 20 }, workToBuild: 2000,
      buildCategory: 'production', researchPrerequisite: 'smithing',
      recipes: ['forgeKnife', 'forgeClub', 'forgeSpear', 'forgePistol', 'forgeBoltRifle',
        'makeComponents', 'smeltWeapon'],
      building: bld({
        isWorkbench: true, interactionOffset: { dx: 0, dy: 1 }
      })
    },

    researchBench: {
      label: 'research bench',
      description: 'Notes, samples and a working surface. Everything the colony does not know yet goes through here.',
      sprite: 'research', color: '#8a6134', color2: '#6fa8dc',
      size: S21, rotatable: true, hp: 180, mass: 80, flammable: true,
      passable: false, fillPercent: 0.5,
      beauty: 1,
      buildCost: { wood: 60, steel: 20 }, workToBuild: 1500,
      buildCategory: 'production',
      building: bld({
        isResearchBench: true, interactionOffset: { dx: 0, dy: 1 }
      })
    }

  }, BUILDING);

  /* ============================================================
     POWER
     Watts, straight. Production is what a generator adds to its net
     each tick, consumption what a device takes, and batteryCapacity
     is stored watt-days - one full battery runs a stove most of a day.
     ============================================================ */
  Defs.add('thing', {

    solarPanel: {
      label: 'solar generator',
      description: 'A field of panels. Free power all day, nothing at night, and nothing at all during an eclipse.',
      sprite: 'solar', color: '#2f4a6b', color2: '#6fa8dc',
      size: S33, hp: 200, mass: 120, flammable: false,
      passable: false, fillPercent: 0.3,
      buildCost: { steel: 100, components: 3 }, workToBuild: 1600,
      buildCategory: 'power', researchPrerequisite: 'solarPower',
      leavings: { steel: 50, components: 1 },
      building: bld({ isGenerator: true, powerProduced: 1600 })
    },

    windTurbine: {
      label: 'wind turbine',
      description: 'A mast and three blades. Turns whenever the weather feels like it, which is most of the time.',
      sprite: 'turbine', color: '#c2c8d2', color2: '#8f97a3',
      size: S42, hp: 250, mass: 180, flammable: false,
      passable: false, fillPercent: 0.4,
      buildCost: { steel: 120, components: 6 }, workToBuild: 2400,
      buildCategory: 'power', researchPrerequisite: 'electricity',
      leavings: { steel: 60, components: 3 },
      building: bld({ isGenerator: true, powerProduced: 1800 })
    },

    woodGenerator: {
      label: 'wood-fired generator',
      description: 'A boiler that eats logs. Steady power at any hour as long as somebody keeps hauling wood into it.',
      sprite: 'generator', color: '#6a6a72', color2: '#ff8c1a',
      size: S21, rotatable: true, hp: 200, mass: 100, flammable: false,
      passable: false, fillPercent: 0.5,
      buildCost: { steel: 100, components: 2 }, workToBuild: 1200,
      buildCategory: 'power', researchPrerequisite: 'electricity',
      leavings: { steel: 50, components: 1 },
      building: bld({
        isGenerator: true, powerProduced: 1000,
        fuelDefId: 'wood', fuelCapacity: 75, fuelBurnPerDay: 40,
        interactionOffset: { dx: 0, dy: 1 }
      })
    },

    battery: {
      label: 'battery',
      description: 'A bank of cells on a frame. Stores the daylight so the lights stay on after dark.',
      sprite: 'battery', color: '#4a5540', color2: '#ffc23c',
      size: S12, rotatable: true, hp: 150, mass: 70, flammable: false,
      passable: false, fillPercent: 0.5,
      buildCost: { steel: 50, components: 2 }, workToBuild: 600,
      buildCategory: 'power', researchPrerequisite: 'batteries',
      leavings: { steel: 25, components: 1 },
      building: bld({ isBattery: true, batteryCapacity: 600 })
    },

    conduit: {
      label: 'power conduit',
      description: 'Buried cable. Carries power between everything on the same net and is otherwise completely in the way of nothing.',
      sprite: 'conduit', color: '#5c5c66', color2: '#ffc23c',
      hp: 50, mass: 2, flammable: false,
      passable: true, pathCost: 0, fillPercent: 0,
      buildCost: { steel: 1 }, workToBuild: 35,
      buildCategory: 'power', researchPrerequisite: 'electricity',
      building: bld({ isConduit: true })
    },

    heater: {
      label: 'heater',
      description: 'A powered element that pushes a room up to its target temperature and then idles.',
      sprite: 'heater', color: '#8f97a3', color2: '#c0392b',
      hp: 120, mass: 40, flammable: false,
      passable: false, fillPercent: 0.4,
      buildCost: { steel: 80, components: 2 }, workToBuild: 800,
      buildCategory: 'power', researchPrerequisite: 'airConditioning',
      leavings: { steel: 40, components: 1 },
      /* tempPushRate is degrees per hour into a room of nominal size;
         Regions scales it by how many cells it actually has to heat. */
      building: bld({
        powerConsumed: 175, tempPushTarget: 21, tempPushRate: 24
      })
    },

    cooler: {
      label: 'cooler',
      description: 'The same element run backwards. Keeps a food store below freezing, which is the only thing that stops meals rotting.',
      sprite: 'cooler', color: '#8f97a3', color2: '#6fa8dc',
      hp: 120, mass: 45, flammable: false,
      passable: false, fillPercent: 0.4,
      buildCost: { steel: 90, components: 3 }, workToBuild: 900,
      buildCategory: 'power', researchPrerequisite: 'airConditioning',
      leavings: { steel: 45, components: 1 },
      building: bld({
        powerConsumed: 200, tempPushTarget: 21, tempPushRate: -21
      })
    }

  }, BUILDING);

  /* ============================================================
     SECURITY
     Cover is the whole point. fillPercent is read straight by
     Combat.coverPenalty, so sandbags at 0.57 cut roughly half the
     incoming fire for whoever is crouched behind them.
     ============================================================ */
  Defs.add('thing', {

    sandbags: {
      label: 'sandbags',
      description: 'A low line of filled bags. Cheap, quick, and it halves what comes back at the colonist behind it.',
      sprite: 'sandbags', color: '#b9a06a', color2: '#8d7845',
      hp: 100, mass: 25, flammable: true,
      passable: true, pathCost: 12, fillPercent: 0.57,
      beauty: -2,
      buildCost: { cloth: 6 }, workToBuild: 90, buildCategory: 'security',
      building: bld({ isSandbag: true })
    },

    turret: {
      label: 'mini-turret',
      description: 'An autoloading gun on a tripod that shoots anything hostile in range. It also cooks off when destroyed, so keep it away from the wall you like.',
      sprite: 'turret', color: '#5a6a4a', color2: '#2c2c33',
      hp: 200, mass: 100, flammable: false,
      passable: false, fillPercent: 0.4,
      buildCost: { steel: 110, components: 5 }, workToBuild: 1200,
      buildCategory: 'security', researchPrerequisite: 'defensiveTurrets',
      leavings: { steel: 30, components: 1 },
      building: bld({
        isTurret: true, turretRange: 27, turretWeapon: 'autoRifle'
      })
    },

    spikeTrap: {
      label: 'spike trap',
      description: 'Sharpened stakes under a thin cover. Springs on the first enemy across it; colonists step around and grumble.',
      sprite: 'trap', color: '#7b6a4f', color2: '#8f97a3',
      hp: 60, mass: 20, flammable: true,
      passable: true, pathCost: 25, fillPercent: 0,
      beauty: -2,
      stuffable: true, buildCost: { wood: 35 }, workToBuild: 220,
      buildCategory: 'security',
      building: bld({ isTrap: true }),
      /* A trap is a weapon that fires once, at touch range, into
         whoever stepped on it - accuracy.touch is the spring chance. */
      weapon: weap({
        ranged: false, damage: 32, damageType: 'stab', range: 1,
        cooldownTicks: 0, armorPen: 0.2,
        accuracy: { touch: 0.85, short: 0, medium: 0, long: 0 }
      })
    }

  }, BUILDING);

  /* ============================================================
     MARKERS
     Neither of these does anything by itself. They are places the
     player names on the map so that a system with no other way to ask
     "where?" has an answer: which stockpile a trade ship can reach,
     and where a caravan forms up before it leaves.
     ============================================================ */
  Defs.add('thing', {

    tradeBeacon: {
      label: 'trade beacon',
      description: 'A transponder that tells passing traders what is for sale. Goods stacked within twelve tiles of one can be sold without hauling them anywhere.',
      sprite: 'box', color: '#8f97a3', color2: '#ffc23c',
      hp: 100, mass: 30, flammable: false,
      passable: false, fillPercent: 0.3, beauty: 0,
      buildCost: { steel: 40, components: 2 }, workToBuild: 700,
      buildCategory: 'misc',
      leavings: { steel: 20, components: 1 },
      /* Passive on purpose: it draws no power, so a beacon that is
         built is a beacon that works. Trade.beaconCells only asks
         whether one is spawned, and a power draw it could not see
         would make the two disagree the first time a net browned out. */
      building: bld({})
    },

    caravanPackspot: {
      label: 'caravan packing spot',
      description: 'A marked patch of ground where a departing caravan gathers. Put it by the door and the pack animals stop walking through the dining room.',
      sprite: 'spot', color: '#b9a06a', color2: '#6b5a33',
      hp: 20, mass: 0, flammable: false,
      passable: true, pathCost: 0, fillPercent: 0, beauty: 0,
      buildCost: {}, workToBuild: 15,
      buildCategory: 'misc',
      building: bld({})
    }

  }, BUILDING);

  /* ============================================================
     ENGINE-SPAWNED
     Nothing here is ever in a build menu. The engine spawns them and
     the renderer draws them, so they carry the minimum a def needs to
     exist plus the art keys.

     Fire and filth are items rather than buildings on purpose: they
     sit on the item grid, where landing on an occupied cell costs
     nothing. On the building grid a fire spreading onto a wooden wall
     would overwrite that wall in map.buildingId and the wall would
     quietly stop existing for pathing and combat.
     ============================================================ */
  Defs.add('thing', {

    blueprint: {
      label: 'blueprint',
      description: 'A planned building waiting on a hauler to bring its materials.',
      sprite: 'blueprint', color: '#6fa8dc', color2: '#e8e2d4',
      hp: 10, mass: 0, marketValue: 0, flammable: false,
      passable: true, pathCost: 0, fillPercent: 0, blocksLight: false, holdsRoof: false
    },

    frame: {
      label: 'frame',
      description: 'A half-built structure holding the materials that went into it. Finishing it needs a builder, not a hauler.',
      sprite: 'frame', color: '#9c8a5a', color2: '#6b5a33',
      hp: 40, mass: 10, marketValue: 0, flammable: true,
      /* Frames stay passable so that walling in a room cannot strand a
         builder inside their own half-finished wall. */
      passable: true, pathCost: 12, fillPercent: 0.2, blocksLight: false, holdsRoof: false
    }

  }, BUILDING);

  Defs.add('thing', {

    corpse: {
      label: 'corpse',
      description: 'A dead body. Bury it, butcher it, or watch the mood of everyone who walks past it drop.',
      sprite: 'corpse', color: '#8b1a1a', color2: '#5c4f3a',
      stackLimit: 1, mass: 70, marketValue: 0, hp: 100,
      rotDays: 5, foodType: 'animal', nutrition: 2.5, beauty: -8,
      passable: true, pathCost: 6
    },

    bullet: {
      label: 'bullet',
      description: 'A round in flight. Owned by combat.js from the muzzle to whatever it hits.',
      sprite: 'bullet', color: '#ffd77a', color2: '#c99a2e',
      stackLimit: 1, mass: 0, marketValue: 0, hp: 1, flammable: false
    },

    arrow: {
      label: 'arrow',
      description: 'An arrow in flight. Slower than a bullet and visibly so, which is half the fun of a tribal fight.',
      sprite: 'arrow', color: '#c9a86a', color2: '#d8cfc0',
      stackLimit: 1, mass: 0, marketValue: 0, hp: 1
    },

    fire: {
      label: 'fire',
      description: 'Open flame. Spreads to anything flammable next to it and goes out when there is nothing left to take.',
      sprite: 'fire', color: '#ff8c1a', color2: '#ffd23c',
      stackLimit: 1, mass: 0, marketValue: 0, hp: 10, flammable: false,
      passable: true, pathCost: 0, beauty: 0
    },

    filthBlood: {
      label: 'blood',
      description: 'Spilled blood on the floor. Cleaning it is low-priority work; leaving it makes a room that everyone dislikes.',
      sprite: 'filth', color: '#8b1a1a', color2: '#5c1010',
      stackLimit: 1, mass: 0, marketValue: 0, hp: 10, flammable: false,
      passable: true, pathCost: 0, beauty: -3
    }

  }, ITEM);

  /* ------------------------------------------------------------------
     Two passes over the finished table. Both exist so that the data
     above can stay short without lying about what it means.
     ------------------------------------------------------------------ */

  /* Every building that never described itself picked up the one shared
     object sitting in the BUILDING defaults, which means nine defs would
     be aliases of each other. Hand each its own copy: a def that is
     quietly the same object as another def is a bug waiting for the
     first system that writes a cached field onto it. */
  Defs.all('thing').forEach(function (d) {
    if (d.category === 'building' && d.building === BUILDING.building) d.building = bld({});
  });

  /* A building is worth what went into it. Deriving that here rather
     than typing it twice means the wealth the storyteller reads can
     never drift from the build costs above, and map.wealth() can sum
     marketValue uniformly across items and buildings instead of knowing
     how a wall is paid for. Stuffable costs are priced in wood, their
     default stuff; stone or steel shifts the real figure a little and
     nothing downstream cares about the difference. Anything that states
     its own value - a sculpture, worth far more than its material -
     keeps it. */
  Defs.all('thing').forEach(function (d) {
    if (d.category !== 'building' || !d.buildCost || d.marketValue) return;
    var total = 0;
    Object.keys(d.buildCost).forEach(function (k) {
      total += d.buildCost[k] * Defs.thing(k).marketValue;
    });
    d.marketValue = Math.round(total);
  });

})(this);
