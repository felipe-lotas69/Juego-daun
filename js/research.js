/* ============================================================
   research.js - the tech tree, the benches that pay for it, and
   the study of things the colony did not build.

   Four halves, which is one more than a file should have, but they
   belong together because they are all one question: what does this
   colony know?

   1. CONTENT. Everything a project can open up that the frozen id
      registry does not already contain is registered here, next to the
      project that unlocks it - the better bench, the analyser that
      makes the bench faster, the fabrication line, the mortar, the
      hydroponics tray, and the six pieces of the ship.
   2. THE TREE. Fifty-odd projects across five tech levels, with real
      prerequisite chains. Every unlock names a real thing, recipe or
      terrain, and every buildable states its own researchPrerequisite,
      so the gate holds whether or not anything calls Defs.finalize.
   3. THE RUNTIME. Which projects are finished, which one is being
      worked on, how fast the work goes, and a queue so a colony does
      not stand idle the moment a project lands.
   4. ANALYSIS. Studying something you found rather than something you
      invented: ancient ruins, a dead mechanoid, an artifact nobody can
      name, a techprint bought off a spacer trader. Its own jobs, its
      own work givers, and its own scattering across the map.

   No DOM, and no Game at load time: this file is evaluated before
   game.js exists, so every reference to another system is guarded and
   resolved at tick time. Jobs and work givers are registered lazily
   for the same reason - jobs.js and workgivers.js load after this file
   and a registration at load would find nothing to register against.
   ============================================================ */
(function (root) {
  'use strict';

  var Defs = root.Defs;
  var U = root.U;

  /* ------------------------------------------------------------------
     Local def templates.

     def_things.js keeps its own copies of these and does not export
     them, so rather than reach into another file this one restates the
     shapes it needs. The point of a template is that every consumer can
     read def.building.powerConsumed without a guard, so the field list
     has to be complete; an unknown key is a typo and throws while a
     data file can still be fixed cheaply.
     ------------------------------------------------------------------ */

  var S11 = Object.freeze({ w: 1, h: 1 });
  var S12 = Object.freeze({ w: 1, h: 2 });
  var S21 = Object.freeze({ w: 2, h: 1 });
  var S22 = Object.freeze({ w: 2, h: 2 });
  var S33 = Object.freeze({ w: 3, h: 3 });

  function withDefaults(base, over) {
    var out = {}, k;
    for (k in base) out[k] = base[k];
    for (k in over) out[k] = over[k];
    return out;
  }

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
        if (!(k in BUILDING_TEMPLATE)) throw new Error('research.js: unknown building field ' + k);
        out[k] = o[k];
      }
    }
    return out;
  }

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
      if (!(k in WEAPON_TEMPLATE)) throw new Error('research.js: unknown weapon field ' + k);
      out[k] = o[k];
    }
    if (!out.accuracy) out.accuracy = { touch: 0.95, short: 0.8, medium: 0.6, long: 0.4 };
    return out;
  }

  var APPAREL_TEMPLATE = {
    slots: null, armorSharp: 0, armorBlunt: 0,
    insulationCold: 0, insulationHeat: 0, coverage: 0.9
  };

  function app(o) {
    var out = {}, k;
    for (k in APPAREL_TEMPLATE) out[k] = APPAREL_TEMPLATE[k];
    for (k in o) {
      if (!(k in APPAREL_TEMPLATE)) throw new Error('research.js: unknown apparel field ' + k);
      out[k] = o[k];
    }
    return out;
  }

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
    building: null, weapon: null, apparel: null, study: null
  };

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
     ITEMS

     Everything here is the product of a recipe registered further
     down, except the two that are found rather than made: the artifact
     a colonist digs out of a ruin, and the techprint a spacer trader
     will sell you for a great deal of silver.
     ============================================================ */
  Defs.add('thing', {

    travelRations: {
      label: 'travel rations',
      description: 'Meat and fat pressed with dried fruit and wrapped in wax cloth. It ' +
        'keeps for a year and nobody enjoys it, which is exactly what a caravan wants.',
      sprite: 'meal', color: '#9c7b4a', color2: '#6b5638',
      stackLimit: 30, mass: 0.35, marketValue: 9,
      nutrition: 0.7, foodType: 'meal', rotDays: null, hp: 50
    },

    mealPaste: {
      label: 'paste meal',
      description: 'Beige, warm, and nutritionally complete. The dispenser turns almost ' +
        'anything organic into it, and every colonist who eats one knows it.',
      sprite: 'meal', color: '#c8bd93', color2: '#9c9470',
      stackLimit: 10, mass: 0.44, marketValue: 7,
      nutrition: 0.9, foodType: 'meal', rotDays: 4, hp: 50
    },

    medicineAdvanced: {
      label: 'advanced medicine',
      description: 'Sealed trauma packs with tissue foam and a broad-spectrum course. A ' +
        'doctor with these can close a wound that would otherwise take a limb.',
      sprite: 'medkit', color: '#e8e2d4', color2: '#4a7fd4',
      stackLimit: 25, mass: 0.4, marketValue: 90, hp: 50, flammable: false,
      isMedicine: true, medicinePotency: 1.6
    },

    advancedComponents: {
      label: 'advanced components',
      description: 'Sealed assemblies no smithy can produce: superconductors, field coils, ' +
        'logic dies. Everything spacer-grade is mostly a box of these.',
      sprite: 'component', color: '#c0c8d8', color2: '#4a7fd4',
      stackLimit: 25, mass: 0.8, marketValue: 90, hp: 70, flammable: false
    },

    prostheticLimb: {
      label: 'prosthetic limb',
      description: 'A machined arm or leg on a socket cuff. Worse than the one it replaces ' +
        'and far better than the empty sleeve it replaces it in.',
      sprite: 'item', color: '#9aa2ae', color2: '#6b7280',
      stackLimit: 5, mass: 3, marketValue: 180, hp: 90, flammable: false
    },

    bionicLimb: {
      label: 'bionic limb',
      description: 'A powered limb that reads the nerve directly. Stronger and steadier ' +
        'than the original, which is the part body purists object to.',
      sprite: 'item', color: '#7fb0d4', color2: '#3f5b6b',
      stackLimit: 5, mass: 3, marketValue: 900, hp: 100, flammable: false
    },

    techPrint: {
      label: 'techprint',
      description: 'A sealed data wafer holding the whole of somebody else\'s work. Study ' +
        'it at a bench and the colony simply knows what it says.',
      sprite: 'item', color: '#d0c27a', color2: '#4a7fd4',
      stackLimit: 5, mass: 0.5, marketValue: 1100, hp: 40, flammable: false
    },

    unknownArtifact: {
      label: 'unknown artifact',
      description: 'A fist-sized object of no material anyone here can name. It is warm. ' +
        'Carry it to a bench and find out what it is before it finds out what you are.',
      sprite: 'item', color: '#8f6fd4', color2: '#d0c27a',
      stackLimit: 1, mass: 5, marketValue: 220, hp: 90, flammable: false,
      study: { work: 2400, kind: 'artifact', points: 900 }
    }

  }, ITEM);

  /* ============================================================
     APPAREL AND WEAPONS
     The far end of the armour and firearms branches, plus the two
     weapon defs that exist only to be bolted onto a gun emplacement.
     ============================================================ */
  Defs.add('thing', {

    duster: {
      label: 'duster',
      description: 'A long coat cut for the road. It sheds sun, rain and grit, and a ' +
        'caravanner who left without one says so for the whole journey.',
      sprite: 'jacket', color: '#8a7a56', color2: '#5e5238',
      mass: 2.4, marketValue: 160, hp: 110,
      apparel: app({
        slots: ['torso'], armorSharp: 0.12, armorBlunt: 0.05,
        insulationCold: 14, insulationHeat: 6, coverage: 0.9
      })
    },

    plateArmor: {
      label: 'plate armour',
      description: 'Shaped steel over a padded backing. It turns a blade outright and ' +
        'slows the colonist inside it down to a determined walk.',
      sprite: 'vest', color: '#8f97a3', color2: '#4a5058',
      mass: 12, marketValue: 620, hp: 180, flammable: false,
      apparel: app({
        slots: ['torso'], armorSharp: 0.55, armorBlunt: 0.28,
        insulationCold: 4, insulationHeat: -6, coverage: 0.85
      })
    },

    powerArmor: {
      label: 'powered armour',
      description: 'A sealed shell with its own actuators taking the weight. Rifle fire ' +
        'is a nuisance to whoever is wearing it.',
      sprite: 'vest', color: '#4a5540', color2: '#c0c8d8',
      mass: 14, marketValue: 1800, hp: 220, flammable: false,
      apparel: app({
        slots: ['torso'], armorSharp: 0.76, armorBlunt: 0.44,
        insulationCold: 26, insulationHeat: 14, coverage: 0.92
      })
    },

    powerHelmet: {
      label: 'powered helmet',
      description: 'The head of the same suit: sealed, filtered, and with a visor that ' +
        'sees better in the dark than the eye behind it.',
      sprite: 'helmet', color: '#4a5540', color2: '#c0c8d8',
      mass: 4, marketValue: 700, hp: 160, flammable: false,
      apparel: app({
        slots: ['head'], armorSharp: 0.62, armorBlunt: 0.4,
        insulationCold: 8, insulationHeat: 4, coverage: 0.8
      })
    },

    chargeRifle: {
      label: 'charge rifle',
      description: 'It throws a packet of charged plasma instead of a bullet, in short ' +
        'bursts, and armour helps less than the wearer would like.',
      sprite: 'rifle', color: '#3a4a5a', color2: '#7fb0d4',
      mass: 3.6, marketValue: 1400, hp: 120, flammable: false,
      weapon: weap({
        ranged: true, damage: 19, damageType: 'bullet', range: 28,
        warmupTicks: 55, cooldownTicks: 75, burstCount: 3, burstTicks: 9,
        accuracy: { touch: 0.8, short: 0.82, medium: 0.76, long: 0.6 },
        armorPen: 0.42, projectileSpeed: 90, projectileDef: 'bullet'
      })
    },

    /* The two below are emplacement weapons: a building names one in
       building.turretWeapon and combat.js reads it from there. Neither
       is ever spawned as an item, and both carry marketValue 0 so that
       no trader can be carrying a mortar barrel in a sack. */
    mortarBarrel: {
      label: 'mortar barrel',
      description: 'A short tube on a baseplate that lobs a shell over the wall it is ' +
        'standing behind.',
      sprite: 'barrel', color: '#4a4a52', color2: '#2c2c33',
      mass: 40, marketValue: 0, hp: 120, flammable: false,
      weapon: weap({
        ranged: true, damage: 45, damageType: 'explosion', range: 48, minRange: 10,
        warmupTicks: 300, cooldownTicks: 900, forcedMissRadius: 4,
        accuracy: { touch: 0.1, short: 0.25, medium: 0.45, long: 0.55 },
        armorPen: 0.3, projectileSpeed: 18, projectileDef: 'bullet'
      })
    },

    turretCannon: {
      label: 'turret cannon',
      description: 'The autoloading gun on a heavy emplacement. Nobody carries one; it ' +
        'arrives bolted to its own tripod.',
      sprite: 'rifle', color: '#3f4a3a', color2: '#2c2c33',
      mass: 30, marketValue: 0, hp: 120, flammable: false,
      weapon: weap({
        ranged: true, damage: 22, damageType: 'bullet', range: 34,
        warmupTicks: 70, cooldownTicks: 95, burstCount: 4, burstTicks: 8,
        accuracy: { touch: 0.66, short: 0.78, medium: 0.76, long: 0.64 },
        armorPen: 0.32, projectileSpeed: 80, projectileDef: 'bullet'
      })
    }

  }, GEAR);

  /* ============================================================
     BUILDINGS

     Each one is the payoff of a project below, and each states its own
     researchPrerequisite as well as appearing in that project's
     `unlocks` list. Stating both sides is not redundancy: nothing in
     the running game calls Defs.finalize, so the gate the build menu
     reads is the field on the building, and the tree the research tab
     draws is the list on the project.
     ============================================================ */
  Defs.add('thing', {

    /* ---- neolithic and medieval ---- */

    dryingRack: {
      label: 'drying rack',
      description: 'Slats in the wind under a roof. Meat and fruit laid out here keep ' +
        'for a year instead of a week, which is what lets a caravan leave at all.',
      sprite: 'butcher', color: '#8a6134', color2: '#b09060',
      size: S21, rotatable: true, hp: 150, mass: 50, flammable: true,
      passable: false, fillPercent: 0.4,
      buildCost: { wood: 45 }, workToBuild: 700,
      buildCategory: 'production', researchPrerequisite: 'foodPreservation',
      recipes: ['makeTravelRations'],
      building: bld({ isWorkbench: true, interactionOffset: { dx: 0, dy: 1 } })
    },

    herbalistBench: {
      label: 'herbalist bench',
      description: 'A pestle, a press and drying trays. The same leaves go further here ' +
        'than they ever did pounded on a rock by the fire.',
      sprite: 'tailor', color: '#6d7a4a', color2: '#b7c98a',
      size: S21, rotatable: true, hp: 160, mass: 60, flammable: true,
      passable: false, fillPercent: 0.5,
      buildCost: { wood: 50 }, workToBuild: 900,
      buildCategory: 'production', researchPrerequisite: 'apothecary',
      recipes: ['refineHerbalMedicine'],
      building: bld({ isWorkbench: true, interactionOffset: { dx: 0, dy: 1 } })
    },

    torchLamp: {
      label: 'torch lamp',
      description: 'A pitch-soaked head on a stake. Somebody has to feed it wood, and ' +
        'until there is a generator it is the only way to work after dark.',
      sprite: 'lamp', color: '#7b5427', color2: '#ff8c1a',
      hp: 55, mass: 6, flammable: true,
      passable: true, pathCost: 25, fillPercent: 0.2, beauty: 1,
      buildCost: { wood: 12 }, workToBuild: 140,
      buildCategory: 'furniture', researchPrerequisite: 'firecraft',
      building: bld({
        isLamp: true, lightRadius: 5,
        fuelDefId: 'wood', fuelCapacity: 20, fuelBurnPerDay: 7,
        interactionOffset: { dx: 0, dy: 0 }
      })
    },

    chessTable: {
      label: 'chess table',
      description: 'A board inlaid into a small table. Two colonists who sit at it come ' +
        'away in a better mood than an hour of staring at a wall ever gave them.',
      sprite: 'table', color: '#8a6134', color2: '#e8e2d4',
      hp: 110, mass: 25, flammable: true,
      passable: false, fillPercent: 0.4, beauty: 6, comfort: 0.6,
      buildCost: { wood: 35 }, workToBuild: 900,
      buildCategory: 'furniture', researchPrerequisite: 'recreation',
      building: bld({ isTable: true })
    },

    armchair: {
      label: 'armchair',
      description: 'Padded, backed and worth sitting in. A colonist who eats and works ' +
        'in one of these complains about a great deal less.',
      sprite: 'stool', color: '#7b4a4a', color2: '#d8cfc0',
      hp: 90, mass: 18, flammable: true,
      passable: true, pathCost: 8, fillPercent: 0.3, beauty: 3, comfort: 0.85,
      buildCost: { wood: 20, cloth: 30 }, workToBuild: 700,
      buildCategory: 'furniture', researchPrerequisite: 'recreation',
      building: bld({ isChair: true })
    },

    poolTable: {
      label: 'billiards table',
      description: 'Slate, felt and a rack of balls. It takes up half a room and it is ' +
        'the best recreation a colony can build out of wood and cloth.',
      sprite: 'table', color: '#2f5d3a', color2: '#8a6134',
      size: S22, hp: 160, mass: 80, flammable: true,
      passable: false, fillPercent: 0.5, beauty: 8, comfort: 0.5,
      buildCost: { wood: 70, cloth: 30, steel: 10 }, workToBuild: 1800,
      buildCategory: 'furniture', researchPrerequisite: 'fineFurniture',
      building: bld({ isTable: true })
    },

    cushionedBed: {
      label: 'cushioned bed',
      description: 'A sprung frame under a stuffed mattress. Sleep comes faster in one ' +
        'and the colonist wakes up meaning it.',
      sprite: 'bed', color: '#8a6134', color2: '#c9a86a',
      size: S12, rotatable: true, hp: 130, mass: 45, flammable: true,
      passable: true, pathCost: 10, fillPercent: 0.4, beauty: 3,
      buildCost: { wood: 45, cloth: 40 }, workToBuild: 1400,
      buildCategory: 'furniture', researchPrerequisite: 'fineFurniture',
      building: bld({
        isBed: true, bedRestEffectiveness: 1.25, bedComfort: 0.85,
        canBeForPrisoners: true
      })
    },

    barricade: {
      label: 'stone barricade',
      description: 'Waist-high dressed stone. Better cover than a bag of sand and it ' +
        'does not catch when the field in front of it burns.',
      sprite: 'sandbags', color: '#7d7d88', color2: '#5c5c66',
      hp: 240, mass: 60, flammable: false,
      passable: true, pathCost: 14, fillPercent: 0.72, beauty: -1,
      buildCost: { stoneBlocks: 12 }, workToBuild: 180,
      buildCategory: 'security', researchPrerequisite: 'masonry',
      leavings: { stoneChunk: 1 },
      building: bld({ isSandbag: true })
    },

    /* ---- industrial ---- */

    machiningTable: {
      label: 'machining table',
      description: 'A powered lathe, a mill and a bench of gauges. Rifles that were guess ' +
        'work at the smithy come off this one to a tolerance.',
      sprite: 'smithy', color: '#6a6a72', color2: '#6fa8dc',
      size: S21, rotatable: true, hp: 220, mass: 130, flammable: false,
      passable: false, fillPercent: 0.5,
      buildCost: { steel: 110, components: 4 }, workToBuild: 2400,
      buildCategory: 'production', researchPrerequisite: 'machining',
      leavings: { steel: 55, components: 2 },
      recipes: ['forgeAutoRifle', 'forgeShotgun', 'forgeSniperRifle', 'makeProstheticLimb'],
      building: bld({
        isWorkbench: true, powerConsumed: 210, interactionOffset: { dx: 0, dy: 1 }
      })
    },

    nutrientPasteBench: {
      label: 'paste dispenser',
      description: 'A hopper, a macerator and a warm spout. It turns six units of almost ' +
        'anything into a full meal, and the colony eats it because it is there.',
      sprite: 'stove', color: '#9aa2ae', color2: '#c8bd93',
      size: S21, rotatable: true, hp: 180, mass: 90, flammable: false,
      passable: false, fillPercent: 0.5,
      buildCost: { steel: 70, components: 2 }, workToBuild: 1400,
      buildCategory: 'production', researchPrerequisite: 'nutrientPaste',
      leavings: { steel: 35, components: 1 },
      recipes: ['makeNutrientPaste'],
      building: bld({
        isWorkbench: true, isStove: true, powerConsumed: 160,
        interactionOffset: { dx: 0, dy: 1 }
      })
    },

    sunLamp: {
      label: 'sun lamp',
      description: 'A wide, hungry lamp tuned to what a plant wants rather than what an ' +
        'eye wants. Crops under one keep growing through the night.',
      sprite: 'lamp', color: '#c2c8d2', color2: '#ffe08a',
      hp: 90, mass: 20, flammable: false,
      passable: true, pathCost: 25, fillPercent: 0.2, beauty: 1,
      buildCost: { steel: 100, components: 2 }, workToBuild: 1100,
      buildCategory: 'power', researchPrerequisite: 'hydroponics',
      leavings: { steel: 50, components: 1 },
      building: bld({ isLamp: true, powerConsumed: 900, lightRadius: 11 })
    },

    geothermalGenerator: {
      label: 'geothermal generator',
      description: 'A cased turbine sunk over a hot fissure. It costs a mountain of steel ' +
        'and then never stops, through the night, the eclipse and the still air.',
      sprite: 'generator', color: '#6a6a72', color2: '#c0392b',
      size: S22, hp: 320, mass: 300, flammable: false,
      passable: false, fillPercent: 0.6,
      buildCost: { steel: 340, components: 8 }, workToBuild: 4300,
      buildCategory: 'power', researchPrerequisite: 'geothermalPower',
      leavings: { steel: 170, components: 4 },
      building: bld({ isGenerator: true, powerProduced: 3600 })
    },

    largeBattery: {
      label: 'bulk battery',
      description: 'Four times the cells on a braced rack. A colony with two of these ' +
        'rides out a solar flare without noticing it happened.',
      sprite: 'battery', color: '#4a5540', color2: '#ffc23c',
      size: S21, rotatable: true, hp: 220, mass: 160, flammable: false,
      passable: false, fillPercent: 0.5,
      buildCost: { steel: 140, components: 6 }, workToBuild: 1500,
      buildCategory: 'power', researchPrerequisite: 'highCapacityBatteries',
      leavings: { steel: 70, components: 3 },
      building: bld({ isBattery: true, batteryCapacity: 2400 })
    },

    hiTechResearchBench: {
      label: 'hi-tech research bench',
      description: 'Instruments, a sealed sample cabinet and a screen worth reading. ' +
        'Everything studied on it goes faster, provided the power stays on.',
      sprite: 'research', color: '#5c6470', color2: '#6fa8dc',
      size: S21, rotatable: true, hp: 220, mass: 120, flammable: false,
      passable: false, fillPercent: 0.5, beauty: 2,
      buildCost: { steel: 120, components: 6, wood: 30 }, workToBuild: 2600,
      buildCategory: 'production', researchPrerequisite: 'computing',
      leavings: { steel: 60, components: 3 },
      building: bld({
        isResearchBench: true, powerConsumed: 300, interactionOffset: { dx: 0, dy: 1 }
      })
    },

    multiAnalyzer: {
      label: 'multi-analyser',
      description: 'A rack of spectrometers wired to whatever bench is nearest. It ' +
        'studies nothing by itself and makes every bench around it quicker.',
      sprite: 'conduit', color: '#3a4a5a', color2: '#7fb0d4',
      size: S21, rotatable: true, hp: 200, mass: 110, flammable: false,
      passable: false, fillPercent: 0.5, beauty: 1,
      buildCost: { steel: 150, components: 8 }, workToBuild: 3000,
      buildCategory: 'production', researchPrerequisite: 'multiAnalysis',
      leavings: { steel: 75, components: 4 },
      building: bld({ powerConsumed: 250 })
    },

    clinicBed: {
      label: 'clinic bed',
      description: 'A steel frame with a hard clean mattress and a rail. A patient in one ' +
        'mends noticeably faster than a patient on a straw pallet.',
      sprite: 'bed', color: '#e8e2d4', color2: '#6fa8dc',
      size: S12, rotatable: true, hp: 160, mass: 55, flammable: false,
      passable: true, pathCost: 10, fillPercent: 0.4, beauty: 1,
      buildCost: { steel: 45, cloth: 30 }, workToBuild: 1300,
      buildCategory: 'furniture', researchPrerequisite: 'sterileConditions',
      leavings: { steel: 22 },
      building: bld({
        isBed: true, bedRestEffectiveness: 1.35, bedComfort: 0.7,
        canBeForPrisoners: true
      })
    },

    mortar: {
      label: 'mortar',
      description: 'A tube on a plate that drops a shell somewhere near where it was ' +
        'aimed. Useless up close and the only answer to a siege camped out of range.',
      sprite: 'turret', color: '#4a4a52', color2: '#8f97a3',
      size: S22, hp: 240, mass: 200, flammable: false,
      passable: false, fillPercent: 0.5,
      buildCost: { steel: 160, components: 4 }, workToBuild: 1800,
      buildCategory: 'security', researchPrerequisite: 'mortars',
      leavings: { steel: 80, components: 2 },
      building: bld({ isTurret: true, turretRange: 48, turretWeapon: 'mortarBarrel' })
    },

    heavyTurret: {
      label: 'heavy turret',
      description: 'A cased autocannon on a powered mount. It reaches further than the ' +
        'mini-turret, hits harder, and eats its own weight in components.',
      sprite: 'turret', color: '#3f4a3a', color2: '#c0c8d8',
      size: S22, hp: 320, mass: 220, flammable: false,
      passable: false, fillPercent: 0.45,
      buildCost: { steel: 200, components: 6, advancedComponents: 2 }, workToBuild: 2600,
      buildCategory: 'security', researchPrerequisite: 'advancedTurrets',
      leavings: { steel: 100, components: 3 },
      building: bld({
        isTurret: true, turretRange: 34, turretWeapon: 'turretCannon', powerConsumed: 150
      })
    },

    /* ---- the ship ----
       Six buildings, one per ultra-tier project, and between them the
       only ending this game has that is not a funeral. Research.ship()
       counts them; the reactor is what starts the clock. */

    shipBeam: {
      label: 'ship structural beam',
      description: 'A spine section for the hull. Nothing on its own, and the frame ' +
        'everything else bolts to.',
      sprite: 'wall', color: '#9aa2ae', color2: '#5c6470',
      size: S21, rotatable: true, hp: 400, mass: 400, flammable: false,
      passable: false, fillPercent: 0.9, marketValue: 260,
      buildCost: { steel: 200, advancedComponents: 1 }, workToBuild: 2000,
      buildCategory: 'ship', researchPrerequisite: 'shipStructure',
      leavings: { steel: 100 },
      building: bld({})
    },

    shipReactor: {
      label: 'ship reactor',
      description: 'The pile that will push the ship out of the gravity well. Starting it ' +
        'lights the colony up on every sensor on the planet.',
      sprite: 'generator', color: '#5c6470', color2: '#ffc23c',
      size: S33, hp: 600, mass: 900, flammable: false,
      passable: false, fillPercent: 0.9, marketValue: 1400,
      buildCost: { steel: 500, components: 20, advancedComponents: 12 }, workToBuild: 9000,
      buildCategory: 'ship', researchPrerequisite: 'shipReactorTech',
      leavings: { steel: 200, components: 6 },
      building: bld({ isGenerator: true, powerProduced: 1000 })
    },

    shipEngine: {
      label: 'ship engine',
      description: 'A fusion thruster with its own shielding. Do not stand behind it, ' +
        'and do not build the wall you like behind it either.',
      sprite: 'turbine', color: '#6a6a72', color2: '#ff8c1a',
      size: S33, hp: 550, mass: 900, flammable: false,
      passable: false, fillPercent: 0.9, marketValue: 1200,
      buildCost: { steel: 600, advancedComponents: 10 }, workToBuild: 9000,
      buildCategory: 'ship', researchPrerequisite: 'shipEngineTech',
      leavings: { steel: 240 },
      building: bld({})
    },

    shipComputerCore: {
      label: 'ship computer core',
      description: 'The navigation core. It knows where the stars were when it was built ' +
        'and can work out the rest from there.',
      sprite: 'research', color: '#3a4a5a', color2: '#7fb0d4',
      size: S22, hp: 400, mass: 500, flammable: false,
      passable: false, fillPercent: 0.8, marketValue: 1100,
      buildCost: { steel: 200, advancedComponents: 12 }, workToBuild: 7000,
      buildCategory: 'ship', researchPrerequisite: 'shipComputerTech',
      leavings: { steel: 80 },
      building: bld({ powerConsumed: 300 })
    },

    shipSensorCluster: {
      label: 'ship sensor cluster',
      description: 'Ranging and star-fixing gear in a hardened dome. Without it the ship ' +
        'leaves and arrives nowhere in particular.',
      sprite: 'solar', color: '#3a4a5a', color2: '#c0c8d8',
      size: S22, hp: 350, mass: 400, flammable: false,
      passable: false, fillPercent: 0.7, marketValue: 800,
      buildCost: { steel: 200, advancedComponents: 6 }, workToBuild: 5000,
      buildCategory: 'ship', researchPrerequisite: 'shipSensorTech',
      leavings: { steel: 80 },
      building: bld({ powerConsumed: 200 })
    },

    shipCryptosleepCasket: {
      label: 'cryptosleep casket',
      description: 'One colonist, frozen, for the crossing. The ship needs one of these ' +
        'for every person who is leaving on it.',
      sprite: 'bed', color: '#c0c8d8', color2: '#6fa8dc',
      size: S12, rotatable: true, hp: 260, mass: 220, flammable: false,
      passable: false, fillPercent: 0.6, marketValue: 500,
      buildCost: { steel: 120, components: 8, advancedComponents: 2 }, workToBuild: 3000,
      buildCategory: 'ship', researchPrerequisite: 'shipCryptosleepTech',
      leavings: { steel: 60, components: 2 },
      building: bld({ powerConsumed: 60 })
    },

    /* ---- what the map was hiding ----
       Not buildable, spawned by Research.populateMap into the corners
       of the map the colony has not walked yet. Each carries a `study`
       block: how much work it takes to get through, and what comes out
       the other end. */

    ancientRuins: {
      label: 'ancient ruins',
      description: 'Half a wall and a floor of something that is not concrete, older than ' +
        'anyone who ever landed here. Somebody should go through it properly.',
      sprite: 'wall', color: '#6b6b60', color2: '#4a4a44',
      size: S22, hp: 400, mass: 400, flammable: false,
      passable: true, pathCost: 16, fillPercent: 0.5, beauty: -2,
      leavings: { stoneChunk: 2 },
      study: { work: 3000, kind: 'ruins', points: 700 },
      building: bld({})
    },

    ancientTerminal: {
      label: 'ancient terminal',
      description: 'A dead console on a pedestal, sealed against a weather that has been ' +
        'working on it for centuries. Something is still warm inside it.',
      sprite: 'research', color: '#4a4a52', color2: '#5c8f3e',
      hp: 250, mass: 120, flammable: false,
      passable: false, fillPercent: 0.6, beauty: -1,
      leavings: { steel: 20, components: 1 },
      study: { work: 3600, kind: 'terminal', points: 1100 },
      building: bld({})
    },

    mechanoidWreck: {
      label: 'mechanoid wreck',
      description: 'A machine the size of a bear, dead on its side, half sunk into the ' +
        'dirt. Taking it apart carefully teaches more than melting it down.',
      sprite: 'turret', color: '#5a5a62', color2: '#c0392b',
      hp: 300, mass: 260, flammable: false,
      passable: false, fillPercent: 0.6, beauty: -3,
      leavings: { steel: 60, components: 3 },
      study: { work: 4200, kind: 'mechanoid', points: 1400 },
      building: bld({})
    }

  }, BUILDING);

  /* ============================================================
     TERRAIN
     Three surfaces a project opens up: one for the farm, one for the
     greenhouse, and one for the room where somebody is cut open.
     ============================================================ */
  Defs.add('terrain', {

    tilledSoil: {
      label: 'tilled soil',
      description: 'Broken up, cleared of stones and worked through with mulch. Plants ' +
        'come in noticeably faster and it has to be laid before they are sown.',
      color: '#4f3d2b', color2: '#3f3022',
      fertility: 1.35, cleanliness: -1, beauty: 0, pathCost: 1,
      supportsPlants: true, terrainCategory: 'soil',
      buildCost: { wood: 3 }, workToBuild: 160,
      buildCategory: 'floor', researchPrerequisite: 'agriculture',
      removable: true, isWater: false, isNatural: false, passable: true
    },

    hydroponicTray: {
      label: 'hydroponics tray',
      description: 'A shallow nutrient bath under a steel lip. Nothing grows faster ' +
        'anywhere, and it does not care what the ground underneath it was.',
      color: '#2f5d5a', color2: '#4a8f86',
      fertility: 2.6, cleanliness: 0.2, beauty: 1, pathCost: 4,
      supportsPlants: true, terrainCategory: 'floor',
      buildCost: { steel: 20, components: 1 }, workToBuild: 600,
      buildCategory: 'floor', researchPrerequisite: 'hydroponics',
      removable: true, isWater: false, isNatural: false, passable: true
    },

    sterileFloor: {
      label: 'sterile tile',
      description: 'A sealed, seamless surface that can be scrubbed to nothing. Lay it ' +
        'under the beds where wounds are tended and infections go elsewhere.',
      color: '#d8dde4', color2: '#c2c8d2',
      fertility: 0, cleanliness: 1.2, beauty: 1, pathCost: 0,
      supportsPlants: false, terrainCategory: 'floor',
      buildCost: { steel: 8, components: 1 }, workToBuild: 320,
      buildCategory: 'floor', researchPrerequisite: 'sterileConditions',
      removable: true, isWater: false, isNatural: false, passable: true
    }

  });
