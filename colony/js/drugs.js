/* ============================================================
   drugs.js - chemicals, tolerance, addiction and the mood they buy.

   A colony can refuse this system entirely and lose nothing it had
   before. That is the point: every drug here is a bargain, and the
   whole file exists to make the second half of the bargain arrive
   late enough to be a surprise and early enough to be survivable.

   Four ideas hold it together.

   1. A dose is cheap and tolerance is the price. Every dose raises a
      tolerance that decays over days, and tolerance - not the dose -
      is what rolls for an addiction. So the colonist who drinks once
      a week is safe forever and the one who drinks every evening is
      not, and nothing in between needs a special case.

   2. An addiction is a clock, not a status. It asks for a dose on a
      cycle; fed, it costs the colony production; unfed, withdrawal
      ramps up over half a day into a mood collapse, stat penalties
      and a real chance the colonist tears the place apart looking
      for a fix. Sit through enough deep withdrawal and the addiction
      is gone, which is the one genuinely hard thing a player can
      choose to do here.

   3. Effects go through health.js wherever health.js can carry them.
      A drug's penalties are hediff capMods and painOffsets, so every
      system that already reads consciousness, manipulation, moving or
      pain sees a drunk colonist without being told about drugs. Only
      what a capacity cannot express - a boost above baseline, a
      drunk's ruined aim, a stagger - lives in this file's exported
      factors, and section 11 names the exact call site for each one
      so nothing is applied twice.

   4. Too much at once kills. Overdose is not a warning light.

   Everything here is additive: things, recipes, research, thoughts, a
   mental state, a job, a work giver, a handful of hediffs registered
   into Health.HEDIFFS, and one plain field on the pawn (pawn.drugs)
   that save.js carries with the rest of the pawn blob.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;
  var Health = root.Health;

  /* Anything below this file in the load order, or optional entirely,
     is looked up when it is needed rather than bound at load. */
  function sys(name) {
    var v = root[name];
    return v === undefined ? null : v;
  }

  var TICKS_PER_DAY = 60000;
  var RARE = 250;                       /* the colony-wide rare-tick beat */
  var DAY = TICKS_PER_DAY;

  function now() {
    var G = sys('Game');
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  function msg(text, opts) {
    var G = sys('Game');
    if (G && G.msg) G.msg(text, opts || {});
  }

  function letter(title, text, opts) {
    var G = sys('Game');
    if (G && G.letter) G.letter(title, text, opts || {});
    else msg(title);
  }

  function nameOf(pawn) {
    if (pawn && typeof pawn.label === 'function') return pawn.label();
    var n = pawn && pawn.name;
    return (n && (n.nick || n.first)) || 'A colonist';
  }

  function isPerson(pawn) {
    return !!pawn && pawn.isHuman !== false && !pawn.isAnimal && !pawn.dead;
  }

  /* pawn.traits holds ids, but a def object turns up often enough in
     other files that reading both costs nothing and saves a bug. */
  function hasTrait(pawn, id) {
    var list = pawn && pawn.traits;
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if ((t && t.id ? t.id : t) === id) return true;
    }
    return false;
  }

  var Drugs = {};

  /* ==================================================================
     1. CONTENT

     def_things.js, def_plants.js, def_recipes.js and research.js are
     all other files, so everything this system needs is registered
     from here. The building and item templates are restated in full
     because map.js, power.js, zones.js and ui.js read fields off a def
     without guarding, and a missing field is a crash three systems
     away from the typo.
     ================================================================== */

  var S11 = Object.freeze({ w: 1, h: 1 });
  var S21 = Object.freeze({ w: 2, h: 1 });

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

  function bld(over) {
    var out = {}, k;
    for (k in BUILDING_FIELDS) out[k] = BUILDING_FIELDS[k];
    if (over) for (k in over) out[k] = over[k];
    return out;
  }

  var ITEM_DEFAULTS = {
    category: 'item', description: '',
    sprite: 'item', color: '#b0b0b8', color2: null,
    stackLimit: 25, mass: 0.2, marketValue: 10,
    nutrition: 0, foodType: null, rotDays: null,
    isMedicine: false, medicinePotency: 0,
    passable: true, pathCost: 0, fillPercent: 0, blocksLight: false, holdsRoof: false,
    size: S11, rotatable: false, hp: 50, flammable: true,
    beauty: 0, comfort: 0, natural: false,
    buildCost: null, stuffable: false, workToBuild: 0, buildSkill: null,
    buildCategory: null, researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null,
    building: null, weapon: null, apparel: null
  };

  var BUILDING_DEFAULTS = {
    category: 'building', description: '',
    sprite: 'box', color: '#8a6134', color2: '#6b4a27',
    stackLimit: 1, mass: 70, marketValue: 0,
    nutrition: 0, foodType: null, rotDays: null,
    isMedicine: false, medicinePotency: 0,
    size: S21, rotatable: true, hp: 180, flammable: true,
    passable: false, pathCost: 0, fillPercent: 0.5,
    blocksLight: false, holdsRoof: false,
    beauty: 0, comfort: 0, natural: false,
    stuffable: false, buildSkill: 'construction',
    researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null,
    weapon: null, apparel: null
  };

  /* def_plants.js's plant block, restated field for field: plants.js
     reads every one of these without a guard, and a crop missing
     minLightToGrow simply never grows. */
  var PLANT_FIELDS = {
    growDays: 5,
    harvestedThing: null, harvestYield: 0, harvestWork: 120,
    harvestMinGrowth: 1.0, harvestDestroys: true, regrowsTo: 0,
    sowable: false, sowWork: 0, sowTags: null, sowMinSkill: 0,
    minFertility: 0.05, fertilitySensitivity: 0.5,
    minGrowthTemp: 0, maxGrowthTemp: 58, minLightToGrow: 0.51,
    lifespanDays: 60,
    wildDensity: 0, wildBiomes: null, wildCluster: [1, 1],
    isTree: false, dieIfLeafless: false, blightable: false,
    visualSizeRange: [0.6, 1.0]
  };

  function plant(over) {
    var out = {}, k;
    for (k in PLANT_FIELDS) out[k] = PLANT_FIELDS[k];
    if (over) for (k in over) out[k] = over[k];
    return out;
  }

  /* ---------- the crops ---------- */

  Defs.add('thing', {

    plantHops: {
      label: 'hops plant',
      description: 'Climbing bines on a string frame. Useless as food, worth a great deal ' +
        'in a barrel, and the reason a colony plants a field it cannot eat.',
      category: 'plant', color: '#7f9a4a', color2: '#b9c96b', sprite: 'crop',
      flammable: 1.0, hp: 50, pathCost: 1,
      plant: plant({
        growDays: 4.0, lifespanDays: 30,
        harvestedThing: 'hops', harvestYield: 8, harvestWork: 180,
        sowable: true, sowWork: 200, sowTags: ['field'], sowMinSkill: 2,
        minFertility: 0.6, fertilitySensitivity: 1.0,
        dieIfLeafless: true, blightable: true, visualSizeRange: [0.5, 0.9]
      })
    },

    plantSmokeleaf: {
      label: 'smokeleaf plant',
      description: 'Broad fragrant leaves on a woody stem. Easy to grow, easy to dry, and ' +
        'the fastest mood a poor colony can buy.',
      category: 'plant', color: '#6f8f49', color2: '#a7bd6a', sprite: 'crop',
      flammable: 1.0, hp: 50, pathCost: 1,
      plant: plant({
        growDays: 4.6, lifespanDays: 32,
        harvestedThing: 'smokeleafLeaves', harvestYield: 7, harvestWork: 200,
        sowable: true, sowWork: 220, sowTags: ['field'], sowMinSkill: 3,
        minFertility: 0.5, fertilitySensitivity: 0.9,
        dieIfLeafless: true, blightable: true, visualSizeRange: [0.5, 0.9]
      })
    },

    plantPsychoid: {
      label: 'psychoid plant',
      description: 'A low grey-green shrub that wants heat and poor ground. Everything hard ' +
        'in the drug lab starts as a handful of these leaves.',
      category: 'plant', color: '#6d8471', color2: '#aabfa2', sprite: 'crop',
      flammable: 0.9, hp: 55, pathCost: 1,
      plant: plant({
        growDays: 6.5, lifespanDays: 45,
        harvestedThing: 'psychoidLeaves', harvestYield: 6, harvestWork: 300,
        sowable: true, sowWork: 340, sowTags: ['field'], sowMinSkill: 6,
        minFertility: 0.4, fertilitySensitivity: 0.6,
        /* Psychoid wants heat: a boreal colony can grow hops and
           smokeleaf and will never get a hard drug out of the ground. */
        minGrowthTemp: 8,
        dieIfLeafless: true, blightable: true, visualSizeRange: [0.4, 0.8]
      })
    }

  }, ITEM_DEFAULTS);

  /* ---------- the harvests and the feedstock ---------- */

  Defs.add('thing', {

    hops: {
      label: 'hops',
      description: 'Dried bitter flowers. Worth nothing until somebody boils them.',
      sprite: 'herb', color: '#9fb35c', color2: '#c9d68a',
      stackLimit: 75, mass: 0.03, marketValue: 1.2
    },

    smokeleafLeaves: {
      label: 'smokeleaf leaves',
      description: 'Cured leaf, chopped and bagged. One step from a joint and two from a habit.',
      sprite: 'herb', color: '#7d8f4e', color2: '#b0bd77',
      stackLimit: 75, mass: 0.03, marketValue: 2.6
    },

    psychoidLeaves: {
      label: 'psychoid leaves',
      description: 'Bitter grey leaves. Brewed they are a mild tea; refined they are the ' +
        'backbone of every hard drug the colony can make.',
      sprite: 'herb', color: '#8ea08b', color2: '#c3d2bc',
      stackLimit: 75, mass: 0.03, marketValue: 3.4
    },

    neutroamine: {
      label: 'neutroamine',
      description: 'A shelf-stable precursor powder. Traders sell it by the crate and a drug ' +
        'lab can cook a poor grade of it from chemfuel when they will not.',
      sprite: 'item', color: '#c6c1d8', color2: '#8f8aa6',
      stackLimit: 75, mass: 0.04, marketValue: 6
    }

  }, ITEM_DEFAULTS);

  /* ---------- the drugs ----------
     `drug` is this file's own block. Nothing outside drugs.js reads it,
     which is why it can carry whatever the model needs. */

  Defs.add('thing', {

    beer: {
      label: 'beer',
      description: 'Bottled, cloudy and strong. Lifts a bad evening, ruins the next morning, ' +
        'and the colonist who reaches for it every evening is already in trouble.',
      sprite: 'barrel', color: '#c08a2e', color2: '#e8d9a8',
      stackLimit: 25, mass: 0.5, marketValue: 11, rotDays: null
    },

    smokeleafJoint: {
      label: 'smokeleaf joint',
      description: 'Rolled, dried leaf. Cheap, calming, and it makes a working day take ' +
        'noticeably longer than it should.',
      sprite: 'herb', color: '#8b7a4e', color2: '#d5c58c',
      stackLimit: 25, mass: 0.02, marketValue: 14
    },

    psychiteTea: {
      label: 'psychite tea',
      description: 'A mild brew of psychoid leaf. The gentle end of a family whose other end ' +
        'is flake, which is exactly how most colonies get there.',
      sprite: 'herb', color: '#a8b89a', color2: '#e0e6d4',
      stackLimit: 25, mass: 0.05, marketValue: 16
    },

    flake: {
      label: 'flake',
      description: 'Crude psychite crystal. Hits in seconds, wears off in hours, and takes a ' +
        'colonist from curious to addicted in about a week of evenings.',
      sprite: 'item', color: '#e4e0ee', color2: '#b7a7d6',
      stackLimit: 25, mass: 0.02, marketValue: 28
    },

    yayo: {
      label: 'yayo',
      description: 'Refined psychite. Cleaner than flake, slower to hook, and worth the ' +
        'neutroamine it takes to make it.',
      sprite: 'item', color: '#f2f0f8', color2: '#cfc4e6',
      stackLimit: 25, mass: 0.02, marketValue: 42
    },

    goJuice: {
      label: 'go-juice',
      description: 'A combat stimulant in a sealed injector. Faster, harder to hurt, harder ' +
        'to stop - and the hook sets after a handful of fights.',
      sprite: 'medkit', color: '#c0392b', color2: '#ffc23c',
      stackLimit: 25, mass: 0.04, marketValue: 70
    },

    wakeUp: {
      label: 'wake-up',
      description: 'Buys a working day out of a night of sleep, then takes it back with ' +
        'interest the moment it wears off.',
      sprite: 'item', color: '#ffc23c', color2: '#7b5427',
      stackLimit: 25, mass: 0.02, marketValue: 48
    },

    luciferium: {
      label: 'luciferium',
      description: 'Mechanite serum in a red capsule. It makes a colonist better at ' +
        'everything, permanently, and it kills them in three days if the next dose does ' +
        'not arrive. There is no coming off it.',
      sprite: 'item', color: '#b0141a', color2: '#ffd7a0',
      stackLimit: 25, mass: 0.02, marketValue: 160
    },

    penoxycyline: {
      label: 'penoxycyline',
      description: 'A prophylactic taken on a schedule. It does nothing you can see, which ' +
        'is the whole idea: the plague that never arrives leaves no story.',
      sprite: 'medkit', color: '#9fd6c6', color2: '#e8e2d4',
      stackLimit: 25, mass: 0.02, marketValue: 24
    },

    painkiller: {
      label: 'painkiller',
      description: 'Pressed analgesic tablets. Not a cure, not addictive, and the difference ' +
        'between a shot colonist who can work and one who cannot.',
      sprite: 'medkit', color: '#e8e2d4', color2: '#6fa8dc',
      stackLimit: 25, mass: 0.01, marketValue: 13
    }

  }, ITEM_DEFAULTS);

  /* ---------- the benches ---------- */

  Defs.add('thing', {

    brewery: {
      label: 'brewery',
      description: 'Copper kettle, mash tun and a rack of bottles. Turns a field nobody can ' +
        'eat into the only thing that makes a bad winter bearable.',
      sprite: 'barrel', color: '#8a6134', color2: '#c08a2e',
      hp: 200, mass: 90, flammable: true,
      buildCost: { wood: 60, steel: 20 }, workToBuild: 1600,
      buildCategory: 'production', researchPrerequisite: 'brewing',
      recipes: ['brewBeer', 'brewPsychiteTea'],
      building: bld({ isWorkbench: true, interactionOffset: { dx: 0, dy: 1 } })
    },

    drugLab: {
      label: 'drug lab',
      description: 'Glassware, a centrifuge and a fume hood that mostly works. Everything the ' +
        'colony is not supposed to be making comes out of here.',
      sprite: 'stonecutter', color: '#6e6e78', color2: '#9fd6c6',
      hp: 200, mass: 110, flammable: false,
      buildCost: { steel: 90, components: 3 }, workToBuild: 2400,
      buildCategory: 'production', researchPrerequisite: 'drugProduction',
      recipes: ['rollSmokeleaf', 'makeFlake', 'makeYayo', 'makeGoJuice', 'makeWakeUp',
        'makePenoxycyline', 'makePainkiller', 'synthesizeNeutroamine'],
      building: bld({ isWorkbench: true, powerConsumed: 200, interactionOffset: { dx: 0, dy: 1 } })
    }

  }, BUILDING_DEFAULTS);

  /* ---------- the recipes ---------- */

  Defs.add('recipe', {

    brewBeer: {
      label: 'beer', jobString: 'Brewing beer', uiCategory: 'drugs',
      workAmount: 700, skill: 'cooking', skillRequirement: 2,
      workbenches: ['brewery'],
      ingredients: [{ thing: 'hops', count: 25 }],
      products: { beer: 5 },
      defaultRepeat: 'untilHave', defaultTargetCount: 30,
      description: 'Twenty-five hops down to five bottles. Slow, and the only thing hops are for.'
    },

    brewPsychiteTea: {
      label: 'psychite tea', jobString: 'Brewing psychite tea', uiCategory: 'drugs',
      workAmount: 600, skill: 'cooking', skillRequirement: 3,
      workbenches: ['brewery'],
      ingredients: [{ thing: 'psychoidLeaves', count: 4 }],
      products: { psychiteTea: 1 },
      defaultRepeat: 'untilHave', defaultTargetCount: 20,
      description: 'The mild end of psychite, and the doorway to the rest of it.'
    },

    rollSmokeleaf: {
      label: 'smokeleaf joints', jobString: 'Rolling joints', uiCategory: 'drugs',
      workAmount: 400, skill: 'crafting',
      workbenches: ['drugLab', 'craftingSpot'],
      ingredients: [{ thing: 'smokeleafLeaves', count: 8 }],
      products: { smokeleafJoint: 2 },
      defaultRepeat: 'untilHave', defaultTargetCount: 20,
      description: 'Eight leaves into two joints. Needs no lab and no research.'
    },

    makeFlake: {
      label: 'flake', jobString: 'Cooking flake', uiCategory: 'drugs',
      workAmount: 900, skill: 'intellectual', skillRequirement: 4,
      workbenches: ['drugLab'], researchPrerequisite: 'drugProduction',
      ingredients: [{ thing: 'psychoidLeaves', count: 8 }],
      products: { flake: 2 },
      defaultRepeat: 'untilHave', defaultTargetCount: 20,
      description: 'Crude, cheap and the most addictive thing a colony can make from a field.'
    },

    makeYayo: {
      label: 'yayo', jobString: 'Refining yayo', uiCategory: 'drugs',
      workAmount: 1100, skill: 'intellectual', skillRequirement: 6,
      workbenches: ['drugLab'], researchPrerequisite: 'drugSynthesis',
      ingredients: [{ thing: 'psychoidLeaves', count: 12 }],
      products: { yayo: 3 },
      defaultRepeat: 'untilHave', defaultTargetCount: 20,
      description: 'More leaf per dose than flake, and a far gentler hook for the difference.'
    },

    makeGoJuice: {
      label: 'go-juice', jobString: 'Synthesizing go-juice', uiCategory: 'drugs',
      workAmount: 1600, skill: 'intellectual', skillRequirement: 8,
      workbenches: ['drugLab'], researchPrerequisite: 'drugSynthesis',
      ingredients: [{ thing: 'yayo', count: 2 }, { thing: 'neutroamine', count: 2 }],
      products: { goJuice: 1 },
      defaultRepeat: 'untilHave', defaultTargetCount: 8,
      description: 'Expensive per injector, and worth it exactly once per raid.'
    },

    makeWakeUp: {
      label: 'wake-up', jobString: 'Synthesizing wake-up', uiCategory: 'drugs',
      workAmount: 1300, skill: 'intellectual', skillRequirement: 6,
      workbenches: ['drugLab'], researchPrerequisite: 'drugSynthesis',
      ingredients: [{ thing: 'yayo', count: 1 }, { thing: 'neutroamine', count: 2 }],
      products: { wakeUp: 2 },
      defaultRepeat: 'untilHave', defaultTargetCount: 10,
      description: 'A working night borrowed against the following afternoon.'
    },

    makePenoxycyline: {
      label: 'penoxycyline', jobString: 'Synthesizing penoxycyline', uiCategory: 'drugs',
      workAmount: 1000, skill: 'intellectual', skillRequirement: 5,
      workbenches: ['drugLab'], researchPrerequisite: 'drugSynthesis',
      ingredients: [{ thing: 'neutroamine', count: 2 }, { thing: 'herbalMedicine', count: 1 }],
      products: { penoxycyline: 2 },
      defaultRepeat: 'untilHave', defaultTargetCount: 20,
      description: 'Five days of protection per dose against anything infectious.'
    },

    makePainkiller: {
      label: 'painkillers', jobString: 'Pressing painkillers', uiCategory: 'drugs',
      workAmount: 700, skill: 'intellectual', skillRequirement: 3,
      workbenches: ['drugLab'], researchPrerequisite: 'drugProduction',
      ingredients: [{ thing: 'neutroamine', count: 1 }, { thing: 'herbalMedicine', count: 2 }],
      products: { painkiller: 3 },
      defaultRepeat: 'untilHave', defaultTargetCount: 25,
      description: 'The one thing in the lab with no hook on the other end of it.'
    },

    synthesizeNeutroamine: {
      label: 'neutroamine', jobString: 'Synthesizing neutroamine', uiCategory: 'drugs',
      workAmount: 1500, skill: 'intellectual', skillRequirement: 7,
      workbenches: ['drugLab'], researchPrerequisite: 'drugSynthesis',
      ingredients: [{ thing: 'chemfuel', count: 15 }, { thing: 'steel', count: 5 }],
      products: { neutroamine: 3 },
      defaultRepeat: 'untilHave', defaultTargetCount: 30,
      description: 'Deliberately worse value than buying it. The answer when nobody will sell.'
    }

  }, {
    jobString: 'Working', skill: null, skillRequirement: 0,
    workType: 'craft', uiCategory: 'drugs', workbenches: [],
    products: {}, dynamicProducts: false, productQuality: false,
    researchPrerequisite: null,
    defaultRepeat: 'forever', defaultTargetCount: 0, defaultIngredientRadius: 999,
    foodPoisonChance: 0, description: ''
  });

  /* ---------- the research ---------- */

  Defs.add('research', {
    brewing: {
      label: 'brewing', cost: 500, techLevel: 'neolithic', tab: 'basic',
      description: 'Mash, boil, ferment, bottle. The cheapest morale a colony can grow ' +
        'for itself, and the first step onto a road it may not want to be on.',
      prerequisites: [],
      unlocks: ['brewery', 'brewBeer', 'brewPsychiteTea'],
      uiPosition: { x: 0, y: 6 }
    },
    drugProduction: {
      label: 'drug production', cost: 1600, techLevel: 'industrial', tab: 'advanced',
      description: 'Extraction, precipitation and a fume hood. Flake, joints and the ' +
        'painkillers that are the only honest thing to come out of the lab.',
      /* rollSmokeleaf is deliberately not listed: Defs.finalize would
         gate it behind this project, and a joint rolled by hand at a
         crafting spot is the one drug a tribal colony should have. */
      prerequisites: ['medicineProduction'],
      unlocks: ['drugLab', 'makeFlake', 'makePainkiller'],
      uiPosition: { x: 2, y: 6 }
    },
    drugSynthesis: {
      label: 'drug synthesis', cost: 2600, techLevel: 'industrial', tab: 'advanced',
      description: 'Real chemistry: refined psychite, combat stimulants, prophylactics, ' +
        'and a way to make the precursor when no trader will sell it.',
      prerequisites: ['drugProduction', 'machining'],
      unlocks: ['makeYayo', 'makeGoJuice', 'makeWakeUp', 'makePenoxycyline',
        'synthesizeNeutroamine'],
      uiPosition: { x: 3, y: 6 }
    }
  });

  /* ---------- the thoughts ----------
     Mood is stated in RimWorld points, which needs.js divides by 100.
     Every magnitude here is comfortably past 1.5 so nothing can be read
     as a raw need-unit offset by accident. */

  Defs.add('thought', {
    drugHigh: {
      label: 'Chemical high', durationDays: 0.5, stackLimit: 1,
      stages: [
        { label: 'Feeling good', mood: 8 },
        { label: 'Feeling great', mood: 16 },
        { label: 'Chemical bliss', mood: 26 }
      ]
    },
    hangover: {
      label: 'Hangover', durationDays: 0.5, stackLimit: 1,
      stages: [{ label: 'Hungover', mood: -8 }]
    },
    chemicalCrash: {
      label: 'Chemical crash', durationDays: 0.6, stackLimit: 1,
      stages: [{ label: 'Crashing', mood: -12 }]
    },
    drugWithdrawal: {
      label: 'Withdrawal', durationDays: 0.4, stackLimit: 1,
      stages: [
        { label: 'Craving a fix', mood: -8 },
        { label: 'Withdrawal', mood: -20 },
        { label: 'Severe withdrawal', mood: -34 }
      ]
    },
    withdrawalBeaten: {
      label: 'Kicked the habit', durationDays: 8, stackLimit: 1,
      stages: [{ label: 'I kicked the habit', mood: 12 }]
    },
    sawDrugUse: {
      label: 'Saw drug use', durationDays: 1, stackLimit: 4,
      stages: [{ label: 'Someone was using drugs', mood: -5 }]
    },
    friendInWithdrawal: {
      label: 'Friend in withdrawal', durationDays: 1, stackLimit: 3,
      nullifiedByTrait: ['psychopath'],
      stages: [{ label: 'A friend is in withdrawal', mood: -6 }]
    },
    luciferiumRelief: {
      label: 'Luciferium', durationDays: 0.8, stackLimit: 1,
      stages: [{ label: 'The mechanites are quiet', mood: 6 }]
    }
  });

  /* ---------- the binge break ----------
     think.js reads `jobId` off a mental state def before it falls back
     to its own table, which is the hook a new state is meant to use. */

  Defs.add('mentalState', {
    drugBinge: {
      label: 'Drug binge', breakLevel: 'major', jobId: 'drugBinge',
      description: 'Tears through the stockpiles for anything that will take the edge off, ' +
        'and smashes what is in the way when there is nothing left to take.',
      durationTicks: [5000, 13000],
      thought: 'catharsis', blocksWork: true
    }
  });

  /* ==================================================================
     2. HEDIFFS

     Registered into health.js's own table so that capMods, painOffset
     and the lethal check all work exactly as they do for a fever. This
     is the whole reason a drunk colonist walks slower, works worse and
     falls over without a single other file knowing drugs exist.

     Registration never clobbers: another system may own an id here one
     day, and losing its numbers silently would be worse than losing
     ours loudly.
     ================================================================== */

  var HEDIFFS = {
    alcoholHigh: {
      id: 'alcoholHigh', label: 'drunk', driven: true, painOffset: -0.10,
      capMods: { consciousness: -0.34, moving: -0.22, manipulation: -0.26 }
    },
    alcoholBlackout: {
      id: 'alcoholBlackout', label: 'blackout drunk', driven: true,
      capMods: { consciousness: -0.80, moving: -0.60, manipulation: -0.60 }
    },
    hangover: {
      id: 'hangover', label: 'hangover', driven: true, painOffset: 0.14,
      capMods: { consciousness: -0.16, manipulation: -0.14 }
    },
    smokeleafHigh: {
      id: 'smokeleafHigh', label: 'smokeleaf high', driven: true, painOffset: -0.14,
      capMods: { consciousness: -0.14, manipulation: -0.12 }
    },
    psychiteHigh: {
      id: 'psychiteHigh', label: 'psychite rush', driven: true, painOffset: -0.10,
      capMods: {}
    },
    goJuiceHigh: {
      id: 'goJuiceHigh', label: 'go-juice rush', driven: true, painOffset: -0.60,
      capMods: {}
    },
    wakeUpHigh: {
      id: 'wakeUpHigh', label: 'wake-up', driven: true, painOffset: -0.05,
      capMods: {}
    },
    luciferiumHigh: {
      id: 'luciferiumHigh', label: 'luciferium', driven: true, painOffset: -0.35,
      capMods: {}
    },
    chemicalCrash: {
      id: 'chemicalCrash', label: 'chemical crash', driven: true, painOffset: 0.10,
      capMods: { consciousness: -0.30, moving: -0.22, manipulation: -0.24 }
    },
    drugOverdose: {
      id: 'drugOverdose', label: 'overdose', lethal: true, driven: true, painOffset: 0.45,
      capMods: { consciousness: -0.55, moving: -0.45, breathing: -0.40 },
      deathCause: 'a drug overdose'
    },
    penoxycylineProtection: {
      id: 'penoxycylineProtection', label: 'penoxycyline', driven: true, capMods: {}
    },
    painkillerRelief: {
      id: 'painkillerRelief', label: 'painkillers', driven: true, painOffset: -0.42,
      capMods: {}
    },
    withdrawalAlcohol: {
      id: 'withdrawalAlcohol', label: 'alcohol withdrawal', driven: true, painOffset: 0.20,
      capMods: { consciousness: -0.22, manipulation: -0.20, moving: -0.10 }
    },
    withdrawalSmokeleaf: {
      id: 'withdrawalSmokeleaf', label: 'smokeleaf withdrawal', driven: true, painOffset: 0.08,
      capMods: { consciousness: -0.12, manipulation: -0.12 }
    },
    withdrawalPsychite: {
      id: 'withdrawalPsychite', label: 'psychite withdrawal', driven: true, painOffset: 0.24,
      capMods: { consciousness: -0.28, manipulation: -0.26, moving: -0.16 }
    },
    withdrawalGoJuice: {
      id: 'withdrawalGoJuice', label: 'go-juice withdrawal', driven: true, painOffset: 0.30,
      capMods: { consciousness: -0.30, manipulation: -0.28, moving: -0.22 }
    },
    withdrawalWakeUp: {
      id: 'withdrawalWakeUp', label: 'wake-up withdrawal', driven: true, painOffset: 0.16,
      capMods: { consciousness: -0.26, manipulation: -0.18, moving: -0.14 }
    },
    luciferiumWithdrawal: {
      id: 'luciferiumWithdrawal', label: 'mechanite breakdown', lethal: true, driven: true,
      painOffset: 0.55,
      capMods: { consciousness: -0.50, moving: -0.45, manipulation: -0.45, bloodPumping: -0.35 },
      deathCause: 'luciferium withdrawal'
    }
  };

  (function registerHediffs() {
    if (!Health || !Health.HEDIFFS) return;
    Object.keys(HEDIFFS).forEach(function (id) {
      if (!Health.HEDIFFS[id]) Health.HEDIFFS[id] = HEDIFFS[id];
    });
  })();

  function setHediff(pawn, id, severity) {
    if (!Health || !Health.addHediff) return null;
    if (!(severity > 0.005)) {
      if (Health.hasHediff && Health.hasHediff(pawn, id)) Health.removeHediff(pawn, id);
      return null;
    }
    var hd = Health.hediff(pawn, id);
    if (!hd) hd = Health.addHediff(pawn, id, severity);
    if (!hd) return null;
    hd.severity = U.clamp01(severity);
    if (Health.invalidate) Health.invalidate(pawn);
    return hd;
  }

  function clearHediff(pawn, id) {
    if (Health && Health.hasHediff && Health.hasHediff(pawn, id)) Health.removeHediff(pawn, id);
  }

  /* ==================================================================
     3. THE CHEMICAL FAMILIES

     A drug belongs to a family; tolerance, addiction and withdrawal all
     live on the family, which is why psychite tea and flake share one
     habit and why a tea drinker can slide into a flake problem without
     ever deciding to.
     ================================================================== */

  var CHEMS = {
    alcohol: {
      label: 'alcohol', hediff: 'withdrawalAlcohol',
      toleranceDecayPerDay: 0.055, addictThreshold: 0.22, addictChance: 0.060,
      needDays: 0.85, rampDays: 0.55, endureDays: 3.5, fatal: false
    },
    smokeleaf: {
      label: 'smokeleaf', hediff: 'withdrawalSmokeleaf',
      toleranceDecayPerDay: 0.050, addictThreshold: 0.26, addictChance: 0.050,
      needDays: 1.10, rampDays: 0.70, endureDays: 2.5, fatal: false
    },
    psychite: {
      label: 'psychite', hediff: 'withdrawalPsychite',
      toleranceDecayPerDay: 0.040, addictThreshold: 0.18, addictChance: 0.100,
      needDays: 0.75, rampDays: 0.45, endureDays: 4.5, fatal: false
    },
    goJuice: {
      label: 'go-juice', hediff: 'withdrawalGoJuice',
      toleranceDecayPerDay: 0.035, addictThreshold: 0.14, addictChance: 0.160,
      needDays: 0.65, rampDays: 0.40, endureDays: 5.5, fatal: false
    },
    wakeUp: {
      label: 'wake-up', hediff: 'withdrawalWakeUp',
      toleranceDecayPerDay: 0.045, addictThreshold: 0.20, addictChance: 0.100,
      needDays: 0.90, rampDays: 0.50, endureDays: 3.5, fatal: false
    },
    /* The trap. Permanent by construction: the addiction is created by
       the first dose, endurance never cures it, and the withdrawal ramp
       runs all the way to a lethal severity. */
    luciferium: {
      label: 'luciferium', hediff: 'luciferiumWithdrawal',
      toleranceDecayPerDay: 0, addictThreshold: 0, addictChance: 1,
      needDays: 0.55, rampDays: 2.2, endureDays: Infinity, fatal: true, permanent: true
    }
  };

  /* ---------- the drug table ----------
     `high` is the hediff a dose applies, `peak` its severity at full
     strength, `highDays` how long the whole curve lasts and `onset` how
     many ticks it takes to get there. `tol` is what one dose adds to
     the family's tolerance and `od` what it adds to the overdose meter.
     The factor fields - move, work, melee, accuracy - are read by
     section 8 and are the only place a boost can live, because a
     capacity cannot go above 1. */

  var DEFAULT_ONSET = 600;              /* ten seconds at 1x */

  var DRUGS = {
    beer: {
      chem: 'alcohol', label: 'beer', recreational: true, hard: false,
      high: 'alcoholHigh', peak: 0.62, highDays: 0.34, onset: 900,
      tol: 0.038, od: 0.14, ingestTicks: 360, verb: 'drinks',
      mood: 0, moodDegree: 0, joy: 0.32,
      after: { hediff: 'hangover', severity: 0.55, days: 0.42, chance: 0.65,
               thought: 'hangover' },
      drunk: true
    },
    smokeleafJoint: {
      chem: 'smokeleaf', label: 'a joint', recreational: true, hard: false,
      high: 'smokeleafHigh', peak: 0.70, highDays: 0.42, onset: 700,
      tol: 0.042, od: 0.10, ingestTicks: 420, verb: 'smokes',
      mood: 0, moodDegree: 1, joy: 0.38,
      work: 0.85
    },
    psychiteTea: {
      chem: 'psychite', label: 'psychite tea', recreational: true, hard: false,
      high: 'psychiteHigh', peak: 0.40, highDays: 0.50, onset: 800,
      tol: 0.032, od: 0.09, ingestTicks: 340, verb: 'drinks',
      mood: 0, moodDegree: 0, joy: 0.26,
      rest: 0.20, work: 1.06, move: 1.04
    },
    flake: {
      chem: 'psychite', label: 'flake', recreational: true, hard: true,
      high: 'psychiteHigh', peak: 0.95, highDays: 0.24, onset: 240,
      tol: 0.105, od: 0.26, ingestTicks: 200, verb: 'takes',
      mood: 0, moodDegree: 2, joy: 0.55,
      rest: 0.30, work: 1.12, move: 1.12, accuracy: 0.92
    },
    yayo: {
      chem: 'psychite', label: 'yayo', recreational: true, hard: true,
      high: 'psychiteHigh', peak: 0.80, highDays: 0.30, onset: 300,
      tol: 0.062, od: 0.18, ingestTicks: 200, verb: 'takes',
      mood: 0, moodDegree: 1, joy: 0.45,
      rest: 0.26, work: 1.10, move: 1.10
    },
    goJuice: {
      chem: 'goJuice', label: 'go-juice', recreational: false, hard: true, combat: true,
      high: 'goJuiceHigh', peak: 1.0, highDays: 0.28, onset: 120,
      tol: 0.090, od: 0.22, ingestTicks: 120, verb: 'injects',
      mood: 0, moodDegree: 0, joy: 0.10,
      move: 1.50, melee: 1.45, accuracy: 1.05, work: 1.05
    },
    wakeUp: {
      chem: 'wakeUp', label: 'wake-up', recreational: false, hard: true,
      high: 'wakeUpHigh', peak: 1.0, highDays: 0.55, onset: 400,
      tol: 0.072, od: 0.20, ingestTicks: 160, verb: 'takes',
      mood: 0, moodDegree: 0, joy: 0.05,
      work: 1.12, move: 1.05, restHold: true,
      after: { hediff: 'chemicalCrash', severity: 0.8, days: 0.5, chance: 1,
               thought: 'chemicalCrash', restCost: 0.35 }
    },
    luciferium: {
      chem: 'luciferium', label: 'luciferium', recreational: false, hard: true,
      high: 'luciferiumHigh', peak: 1.0, highDays: 0.60, onset: 300,
      tol: 0, od: 0.05, ingestTicks: 200, verb: 'takes',
      mood: 0, moodThought: 'luciferiumRelief', joy: 0,
      work: 1.25, move: 1.25, melee: 1.30, accuracy: 1.15
    },
    /* The two honest ones. No family, so no tolerance and no habit -
       a colony can lean on these as hard as it can afford to. */
    penoxycyline: {
      chem: null, label: 'penoxycyline', recreational: false, hard: false, medical: true,
      high: 'penoxycylineProtection', peak: 1.0, highDays: 5.0, flat: true,
      tol: 0, od: 0.02, ingestTicks: 160, verb: 'takes',
      mood: 0, joy: 0, preventsDisease: true
    },
    painkiller: {
      chem: null, label: 'a painkiller', recreational: false, hard: false, medical: true,
      high: 'painkillerRelief', peak: 1.0, highDays: 0.7, flat: true,
      tol: 0, od: 0.06, ingestTicks: 180, verb: 'takes',
      mood: 0, joy: 0.04, painRelief: 0.42, painReliefDays: 0.7
    }
  };

  Drugs.DRUGS = DRUGS;
  Drugs.CHEMS = CHEMS;

  Drugs.isDrug = function (defOrId) {
    var id = typeof defOrId === 'string' ? defOrId : (defOrId && (defOrId.id || defOrId.defId));
    return !!(id && DRUGS[id]);
  };
  Drugs.drugDef = function (id) { return DRUGS[id] || null; };

  /* ==================================================================
     4. PER-PAWN STATE

     One plain field of numbers, strings and plain objects, which is
     exactly what save.js's pawn blob copies without being told. The
     field is `pawn.drugs` rather than the generic `pawn.med` because
     medicine.js sits one line above this file in the load order and
     that name is plainly its.
     ================================================================== */

  function ensure(pawn) {
    var st = pawn.drugs;
    if (st && st.tol && st.add) return st;
    st = pawn.drugs = {
      tol: {},              /* chemical -> 0..1 tolerance                */
      add: {},              /* chemical -> addiction record              */
      hi: {},               /* hediff id -> {peak, start, end, drug}     */
      od: 0,                /* overdose meter, 0..1                      */
      doses: 0,             /* lifetime doses, for the readout           */
      lastDoseTick: -999999,
      painUntil: 0, painRelief: 0,
      restHoldUntil: 0,
      policy: null,         /* per-pawn override of the colony policy    */
      warned: {}            /* chemical -> tick the player was told      */
    };
    return st;
  }
  Drugs.state = ensure;

  function tolerance(pawn, chem) {
    var st = pawn.drugs;
    return (st && st.tol && st.tol[chem]) || 0;
  }
  Drugs.tolerance = tolerance;

  Drugs.addiction = function (pawn, chem) {
    var st = pawn.drugs;
    return (st && st.add && st.add[chem]) || null;
  };

  Drugs.addictions = function (pawn) {
    var st = pawn.drugs, out = [];
    if (!st || !st.add) return out;
    Object.keys(st.add).forEach(function (c) { out.push(st.add[c]); });
    return out;
  };

  Drugs.isAddicted = function (pawn, chem) {
    var st = pawn.drugs;
    if (!st || !st.add) return false;
    if (chem) return !!st.add[chem];
    for (var k in st.add) if (st.add[k]) return true;
    return false;
  };

  /* ==================================================================
     5. TAKING A DOSE

     The one entry point. Everything that can make a pawn take a drug -
     the self-medication work giver, the binge, a player order, a
     ritual - comes through here, so the tolerance roll, the ideoligion
     check, the witnesses and the overdose meter can never be skipped.
     ================================================================== */

  function consumeOne(pawn, thing) {
    var map = pawn.map || thing.map;
    if (thing.stack === undefined || thing.stack === null) thing.stack = 1;
    thing.stack -= 1;
    if (thing.stack > 0) return;
    thing.stack = 0;
    if (pawn.carried === thing) pawn.carried = null;
    if (pawn.inventory) U.remove(pawn.inventory, thing);
    if (thing.spawned && map && map.despawnThing) map.despawnThing(thing);
  }

  function startHigh(pawn, st, drug, drugId) {
    if (!drug.high || !(drug.peak > 0) || !(drug.highDays > 0)) return;
    var t = now();
    var prior = st.hi[drug.high];
    /* A second dose on top of a first does not restart the clock, it
       deepens what is already there and pushes the end out. */
    var peak = drug.peak;
    var end = t + Math.round(drug.highDays * DAY);
    if (prior && prior.end > t) {
      peak = Math.min(1, Math.max(prior.peak, peak) + peak * 0.35);
      end = Math.max(prior.end, end);
    }
    /* Onset is in ticks, not a fraction of the curve, because how fast a
       drug hits has nothing to do with how long it lasts: an injector
       lands in three seconds and a bottle of beer takes a quarter hour,
       and both wear off over hours. */
    var onset = Math.min(drug.onset || DEFAULT_ONSET, (end - t) * 0.4);
    st.hi[drug.high] = {
      peak: peak, start: t, end: end, drug: drugId, flat: !!drug.flat,
      onset: Math.max(1, Math.round(onset))
    };
  }

  function scheduleAfterEffect(pawn, st, drug) {
    var a = drug.after;
    if (!a || !U.chance(a.chance === undefined ? 1 : a.chance)) return;
    var t = now();
    var begin = t + Math.round((drug.highDays || 0.3) * DAY);
    st.hi[a.hediff] = {
      peak: a.severity, start: begin, end: begin + Math.round(a.days * DAY),
      drug: null, thought: a.thought, restCost: a.restCost || 0, pending: true
    };
  }

  /* Tolerance is the price of the dose and the roll for the habit. */
  function raiseTolerance(pawn, st, drug) {
    var chem = drug.chem;
    if (!chem) return;
    var cd = CHEMS[chem];
    if (!cd) return;
    var tol = U.clamp01((st.tol[chem] || 0) + drug.tol);
    st.tol[chem] = tol;

    if (st.add[chem]) return;                 /* already hooked */
    if (cd.permanent) { addAddiction(pawn, st, chem, true); return; }
    if (tol < cd.addictThreshold) return;

    /* Past the threshold the chance climbs with how far past it is, so
       a colonist who drinks daily for a week is in real danger and one
       who drinks on feast days never is. */
    var over = (tol - cd.addictThreshold) / Math.max(0.05, 1 - cd.addictThreshold);
    var chance = cd.addictChance * (0.4 + 2.6 * over);
    if (hasTrait(pawn, 'ironWilled')) chance *= 0.55;
    if (hasTrait(pawn, 'volatile')) chance *= 1.3;
    if (U.chance(chance)) addAddiction(pawn, st, chem, false);
  }

  function addAddiction(pawn, st, chem, silentIfPermanent) {
    if (st.add[chem]) return st.add[chem];
    var cd = CHEMS[chem];
    var rec = {
      chem: chem, since: now(), lastDose: now(),
      wd: 0,               /* 0..1 withdrawal depth                  */
      endured: 0,          /* ticks of deep withdrawal sat through    */
      permanent: !!(cd && cd.permanent)
    };
    st.add[chem] = rec;
    if (pawn.faction === 'player' && isPerson(pawn)) {
      if (rec.permanent && silentIfPermanent) {
        letter(nameOf(pawn) + ' is on luciferium',
          nameOf(pawn) + ' has taken luciferium. The mechanites are permanent. From now on ' +
          'they need a dose every few days or the colony buries them - and there is no ' +
          'treatment that undoes this.', { kind: 'threat', x: pawn.x, y: pawn.y });
      } else {
        letter(nameOf(pawn) + ' is addicted to ' + (cd ? cd.label : chem),
          nameOf(pawn) + ' has formed a ' + (cd ? cd.label : chem) + ' addiction. They will ' +
          'need a dose every day or so. Cut them off and they will go through several days of ' +
          'withdrawal - mood, work and a real chance of a breakdown - and come out clean.',
          { kind: 'threat', x: pawn.x, y: pawn.y });
      }
    }
    return rec;
  }
  Drugs.addAddiction = function (pawn, chem) {
    if (!CHEMS[chem]) return null;
    return addAddiction(pawn, ensure(pawn), chem, true);
  };

  /* Who saw it, and who minds. A teetotaler in this game is a colonist
     whose ideoligion prohibits drugs or who is ascetic by temperament;
     there is no separate trait in the frozen registry and inventing one
     would put an id in the game that no other file could read. */
  function noteWitnesses(pawn, drug) {
    var map = pawn.map;
    var N = sys('Needs');
    if (!map || !N || !N.addThought) return;
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var other = list[i];
      if (other === pawn || !isPerson(other) || other.faction !== pawn.faction) continue;
      if (U.cheb(pawn.x, pawn.y, other.x, other.y) > 8) continue;
      if (!isTeetotal(other)) continue;
      N.addThought(other, 'sawDrugUse', { otherPawnId: pawn.id });
    }
  }

  function isTeetotal(pawn) {
    var I = sys('Ideology');
    if (I && I.preceptIs && I.preceptIs(pawn, 'drugs', 'prohibited')) return true;
    return hasTrait(pawn, 'ascetic');
  }
  Drugs.isTeetotal = isTeetotal;

  /* True when this colonist's faith forbids the drug outright. A player
     order still goes through; only the pawn's own choices are bound. */
  Drugs.forbidden = function (pawn) {
    var I = sys('Ideology');
    return !!(I && I.allows && !I.allows(pawn, 'tookDrug'));
  };

  /* Ideoligions that celebrate drugs make a colonist want them, which
     is what turns a precept into behaviour rather than a mood line. */
  Drugs.ideoUrge = function (pawn) {
    var I = sys('Ideology');
    if (!I || !I.precept) return 0;
    var d = I.precept(pawn, 'drugs');
    if (!d) return 0;
    if (d.id === 'celebrated') return 1;
    if (d.id === 'acceptable') return 0.4;
    return 0;
  };

  /* The whole dose, start to finish. `thing` may be null when a dose
     comes from somewhere other than an item on the map. */
  Drugs.ingest = function (pawn, drugId, thing, opts) {
    opts = opts || {};
    var drug = DRUGS[drugId];
    if (!drug || !pawn || pawn.dead) return false;
    if (!isPerson(pawn)) return false;

    var st = ensure(pawn);
    if (thing) consumeOne(pawn, thing);

    st.doses++;
    st.lastDoseTick = now();

    startHigh(pawn, st, drug, drugId);
    scheduleAfterEffect(pawn, st, drug);
    raiseTolerance(pawn, st, drug);

    /* A dose of the right family answers the craving, whatever the
       colonist actually reached for. */
    var chem = drug.chem;
    if (chem && st.add[chem]) {
      var rec = st.add[chem];
      rec.lastDose = now();
      rec.wd = 0;
      rec.endured = 0;
      clearHediff(pawn, CHEMS[chem].hediff);
      var N0 = sys('Needs');
      if (N0 && N0.removeThought) N0.removeThought(pawn, 'drugWithdrawal');
      if (chem === 'luciferium' && N0 && N0.addThought) {
        N0.addThought(pawn, 'luciferiumRelief');
      }
    }

    if (drug.painRelief) {
      st.painRelief = drug.painRelief;
      st.painUntil = now() + Math.round((drug.painReliefDays || 0.5) * DAY);
    }
    if (drug.restHold) {
      st.restHoldUntil = now() + Math.round((drug.highDays || 0.5) * DAY);
    }

    var N = sys('Needs');
    if (N) {
      if (drug.joy && N.gainJoy) N.gainJoy(pawn, drug.joy, 'chemical');
      if (drug.rest && pawn.needs) pawn.needs.rest = U.clamp01(pawn.needs.rest + drug.rest);
      if (N.addThought && drug.moodThought) {
        N.addThought(pawn, drug.moodThought);
      } else if (N.addThought && drug.high && drug.peak > 0) {
        /* Tolerance dulls the high: the fortieth beer is a chore. */
        var deg = drug.moodDegree || 0;
        var dulled = tolerance(pawn, chem) > 0.55 && deg > 0 ? deg - 1 : deg;
        N.addThought(pawn, 'drugHigh', { degree: dulled });
      }
    }

    addOverdose(pawn, st, drug);

    var I = sys('Ideology');
    if (I && I.noteAction) I.noteAction(pawn, 'tookDrug');
    if (!opts.quiet) noteWitnesses(pawn, drug);

    applyHighs(pawn, st);
    return true;
  };

  /* ==================================================================
     6. OVERDOSE

     The meter rises per dose and falls over a day. Half of it is a
     warning the player gets once; all of it is a death. Tolerance does
     not protect: a colonist who can drink all night is exactly the one
     who finds the ceiling.
     ================================================================== */

  var OD_WARN = 0.50;
  var OD_DECAY_PER_DAY = 1.15;

  function addOverdose(pawn, st, drug) {
    var gain = drug.od || 0;
    if (!(gain > 0)) return;
    /* Coming down hard on top of an existing high is what kills. */
    var stacked = 1;
    for (var k in st.hi) {
      var h = st.hi[k];
      if (h && !h.pending && h.end > now()) stacked += 0.35;
    }
    st.od = U.clamp01(st.od + gain * stacked);

    if (st.od >= 1) {
      setHediff(pawn, 'drugOverdose', 1);
      if (pawn.faction === 'player') {
        letter(nameOf(pawn) + ' has overdosed',
          nameOf(pawn) + ' took too much, too fast. Their breathing has stopped. There is ' +
          'nothing a doctor can do about this one.', { kind: 'death', x: pawn.x, y: pawn.y });
      }
      if (Health && Health.kill) Health.kill(pawn, 'a drug overdose');
      return;
    }
    if (st.od >= OD_WARN) {
      setHediff(pawn, 'drugOverdose', U.clamp01((st.od - OD_WARN) / (1 - OD_WARN) * 0.55));
      if (pawn.faction === 'player' && !st.warned.od) {
        st.warned.od = now();
        letter(nameOf(pawn) + ' is overdosing',
          nameOf(pawn) + ' has taken far too much and is going grey. Another dose in the next ' +
          'day will kill them.', { kind: 'threat', x: pawn.x, y: pawn.y });
      }
    }
  }

  Drugs.overdoseLevel = function (pawn) {
    var st = pawn && pawn.drugs;
    return st ? st.od : 0;
  };

  /* ==================================================================
     7. THE RARE TICK

     Highs decay, tolerance decays, addictions demand, withdrawal ramps
     and luciferium counts down to a funeral. All of it on the 250-tick
     beat, staggered by pawn id.
     ================================================================== */

  /* A high runs a short onset then a long fall, which is what makes a
     dose feel like an event rather than a step function. */
  function highSeverity(rec, t) {
    var span = rec.end - rec.start;
    if (span <= 0) return 0;
    if (t < rec.start || t > rec.end) return 0;
    /* A prophylactic either protects you or does not; only a high has a
       curve, because only a high is something you feel. */
    if (rec.flat) return rec.peak;
    var into = t - rec.start;
    var onset = rec.onset || DEFAULT_ONSET;
    if (onset >= span) onset = span * 0.4;
    if (into < onset) return rec.peak * (into / onset);
    return rec.peak * (1 - (into - onset) / (span - onset));
  }

  function applyHighs(pawn, st) {
    var t = now(), id, rec, sev;
    for (id in st.hi) {
      rec = st.hi[id];
      if (!rec) { delete st.hi[id]; continue; }
      if (t < rec.start) continue;            /* an after-effect still waiting */
      if (rec.pending) {
        rec.pending = false;
        var N = sys('Needs');
        if (rec.thought && N && N.addThought) N.addThought(pawn, rec.thought);
        if (rec.restCost && pawn.needs) {
          pawn.needs.rest = U.clamp01(pawn.needs.rest - rec.restCost);
        }
      }
      if (t >= rec.end) {
        clearHediff(pawn, id);
        delete st.hi[id];
        continue;
      }
      sev = highSeverity(rec, t);
      if (sev > 0.005) setHediff(pawn, id, sev);
      else clearHediff(pawn, id);
    }

    /* Past the threshold a drunk stops being funny and falls over. The
       blackout is its own hediff so health.js's own downing check does
       the work; nothing here pushes the pawn over. */
    var drunk = Drugs.drunkenness(pawn);
    if (drunk > 0.86) setHediff(pawn, 'alcoholBlackout', (drunk - 0.86) / 0.14);
    else clearHediff(pawn, 'alcoholBlackout');
  }

  function decayTolerance(pawn, st, days) {
    for (var chem in st.tol) {
      var cd = CHEMS[chem];
      if (!cd || !cd.toleranceDecayPerDay) continue;
      var v = st.tol[chem] - cd.toleranceDecayPerDay * days;
      if (v <= 0.0005) delete st.tol[chem];
      else st.tol[chem] = v;
    }
  }

  function tickAddictions(pawn, st, days) {
    var t = now(), N = sys('Needs');
    var worst = 0, worstChem = null;

    for (var chem in st.add) {
      var rec = st.add[chem];
      var cd = CHEMS[chem];
      if (!rec || !cd) { delete st.add[chem]; continue; }

      var sinceDose = (t - rec.lastDose) / DAY;
      if (sinceDose < cd.needDays) {
        /* Fed. The habit costs production and nothing else today. */
        rec.wd = 0;
        clearHediff(pawn, cd.hediff);
        continue;
      }

      /* Unfed: withdrawal ramps from nothing to full over rampDays, and
         for luciferium keeps going past full, which is the death. */
      var over = sinceDose - cd.needDays;
      rec.wd = over / cd.rampDays;
      if (!cd.fatal) rec.wd = Math.min(1, rec.wd);

      if (cd.fatal) {
        setHediff(pawn, cd.hediff, U.clamp01(rec.wd));
        if (rec.wd >= 1 && Health && Health.kill && !pawn.dead) {
          if (pawn.faction === 'player') {
            letter(nameOf(pawn) + ' has died of luciferium withdrawal',
              'The mechanites in ' + nameOf(pawn) + ' turned on them. There was never going ' +
              'to be another ending to this without another dose.',
              { kind: 'death', x: pawn.x, y: pawn.y });
          }
          Health.kill(pawn, 'luciferium withdrawal');
          return;
        }
      } else {
        setHediff(pawn, cd.hediff, rec.wd);
        /* Deep withdrawal is the only thing that counts towards a cure,
           so a colonist dosed just enough to take the edge off never
           gets clean - which is exactly the trap. */
        if (rec.wd >= 0.9) {
          rec.endured += RARE;
          if (rec.endured >= cd.endureDays * DAY) {
            delete st.add[chem];
            clearHediff(pawn, cd.hediff);
            if (N && N.addThought) N.addThought(pawn, 'withdrawalBeaten');
            if (pawn.faction === 'player') {
              letter(nameOf(pawn) + ' has kicked the habit',
                nameOf(pawn) + ' has come through ' + cd.label + ' withdrawal clean. It took ' +
                Math.round(cd.endureDays) + ' days of misery and it is over.',
                { kind: 'good', x: pawn.x, y: pawn.y });
            }
            continue;
          }
        }
      }

      if (rec.wd > worst) { worst = rec.wd; worstChem = chem; }
    }

    /* Not flagged situational: needs.js reconciles its own situational
       list against a fixed table every rare tick and would delete an
       entry it does not recognise. A short duration refreshed on this
       beat gives the same behaviour - the thought fades out shortly
       after the last dose rather than snapping off. */
    if (N && N.addThought) {
      if (worst > 0.05) {
        var degree = worst >= 0.85 ? 2 : (worst >= 0.45 ? 1 : 0);
        N.addThought(pawn, 'drugWithdrawal',
          { degree: degree, noStack: true, duration: RARE * 6 });
      } else if (N.removeThought) {
        N.removeThought(pawn, 'drugWithdrawal');
      }
    }

    st.worstWd = worst;
    st.worstChem = worstChem;
    if (worst > 0) rollBinge(pawn, st, worst);
    if (worst >= 0.55) noteFriendsInWithdrawal(pawn);
  }

  /* Once per colonist in deep withdrawal, the people who care about them
     feel it. Cheap because it only fires past a high water mark and
     only on a rare tick. */
  function noteFriendsInWithdrawal(pawn) {
    var S = sys('Social'), N = sys('Needs');
    if (!N || !N.addThought || !S || !S.opinionOf || !pawn.map) return;
    var list = pawn.map.pawns;
    for (var i = 0; i < list.length; i++) {
      var other = list[i];
      if (other === pawn || !isPerson(other) || other.faction !== pawn.faction) continue;
      if (U.cheb(pawn.x, pawn.y, other.x, other.y) > 10) continue;
      if (S.opinionOf(other, pawn) < 20) continue;
      N.addThought(other, 'friendInWithdrawal', { otherPawnId: pawn.id });
    }
  }

  function rollBinge(pawn, st, wd) {
    if (pawn.mentalState || pawn.drafted || pawn.downed) return;
    var Think = sys('Think');
    if (!Think || !Think.startMentalState) return;
    if (pawn.faction !== 'player') return;

    /* A colonist in a good mood white-knuckles it; one already on the
       edge does not. The base is per rare tick, so roughly a coin flip
       over a full day at the deepest end of a bad mood. */
    var N = sys('Needs');
    var mood = (N && N.mood) ? N.mood(pawn) : 0.6;
    var p = 0.010 * wd * wd * (1.6 - mood);
    if (hasTrait(pawn, 'ironWilled')) p *= 0.4;
    if (hasTrait(pawn, 'volatile')) p *= 1.8;
    if (!U.chance(U.clamp(p, 0, 0.06))) return;
    Think.startMentalState(pawn, 'drugBinge');
  }

  /* ==================================================================
     8. THE EXPORTED FACTORS

     Read this before wiring anything up.

     Penalties are NOT here. A drunk colonist is slow, clumsy and easy
     to knock down because `alcoholHigh` drops consciousness, moving and
     manipulation in health.js, and pawn.moveSpeedFactor, pawn.workRate
     and combat's accuracy already multiply those capacities in. Adding
     them here as well would apply them twice.

     What is here is everything a capacity cannot express: a boost above
     baseline (capacities clamp at 1), the specific ruin a drink makes
     of fine aim on top of the general fog, and a stagger.

     Call sites, exactly:

       Drugs.moveFactor(pawn)     -> js/pawn.js, Pawn.prototype.moveSpeedFactor,
                                     as one more multiplier beside the trait
                                     and health factors.
       Drugs.workFactor(pawn)     -> js/pawn.js, Pawn.prototype.workRate,
                                     beside Health.workSpeedFactor.
       Drugs.accuracyFactor(pawn) -> js/combat.js, shooterAccuracy() for ranged
                                     and Combat.meleeHitChance for the attacker.
       Drugs.meleeFactor(pawn)    -> js/combat.js, melee damage or cooldown.
       Drugs.socialFactor(pawn)   -> js/social.js, Social.interact, as a
                                     multiplier on the opinion the talk moves.
       Drugs.socialFightFactor()  -> js/social.js, Social.fightChance.
       Drugs.wanderChance(pawn)   -> js/pawn.js, Pawn.prototype.tickMove, as the
                                     chance to take a neighbouring cell instead
                                     of the pathed one.

     Until pawn.js and combat.js are wired, Drugs.tickPawn still makes a
     drunk stagger by itself (see stumble, below), so the effect is
     visible in the game as it stands.
     ================================================================== */

  /* Read the curve, not the hediff. The hediff is only resampled on the
     rare tick, which is right for capacities - health.js recomputes a
     lot when one changes - but wrong for a factor a shot or a step
     asks for on the tick it happens. */
  function activeHigh(pawn, hediffId) {
    var st = pawn && pawn.drugs;
    if (!st || !st.hi) return 0;
    var rec = st.hi[hediffId];
    if (!rec || rec.pending) return 0;
    return highSeverity(rec, now());
  }
  Drugs.highLevel = activeHigh;

  Drugs.drunkenness = function (pawn) {
    if (!pawn || pawn.dead) return 0;
    return activeHigh(pawn, 'alcoholHigh');
  };

  /* The strongest boost wins rather than stacking, so a colonist on
     go-juice and yayo is not twice as fast as physics allows. */
  function bestFactor(pawn, key) {
    var st = pawn && pawn.drugs;
    if (!st || !st.hi) return 1;
    var best = 1, t = now();
    for (var id in st.hi) {
      var rec = st.hi[id];
      if (!rec || rec.pending || t >= rec.end || t < rec.start) continue;
      var drug = rec.drug && DRUGS[rec.drug];
      if (!drug || !drug[key]) continue;
      var sev = highSeverity(rec, t);
      if (sev <= 0.01) continue;
      /* Scale the stated factor by how far into the curve the pawn is. */
      var v = 1 + (drug[key] - 1) * sev;
      if (drug[key] > 1 ? v > best : v < best) best = v;
    }
    return best;
  }

  Drugs.moveFactor = function (pawn) {
    if (!pawn || pawn.dead) return 1;
    return bestFactor(pawn, 'move');
  };

  Drugs.workFactor = function (pawn) {
    if (!pawn || pawn.dead) return 1;
    return bestFactor(pawn, 'work');
  };

  Drugs.meleeFactor = function (pawn) {
    if (!pawn || pawn.dead) return 1;
    return bestFactor(pawn, 'melee');
  };

  Drugs.accuracyFactor = function (pawn) {
    if (!pawn || pawn.dead) return 1;
    var f = bestFactor(pawn, 'accuracy');
    /* Drink ruins aim far past what the general fog accounts for: the
       hand shakes and the sights will not hold still. Down to a third
       at blackout level, which is the difference between a colonist who
       should be on the wall and one who should be in bed. */
    var drunk = Drugs.drunkenness(pawn);
    if (drunk > 0) f *= U.lerp(1, 0.32, U.clamp01(drunk));
    var smoke = activeHigh(pawn, 'smokeleafHigh');
    if (smoke > 0) f *= U.lerp(1, 0.72, U.clamp01(smoke));
    return f;
  };

  /* Drink makes a colonist louder, warmer and much more likely to say
     the thing they cannot take back. Both ends of the same number. */
  Drugs.socialFactor = function (pawn) {
    var drunk = Drugs.drunkenness(pawn);
    var smoke = activeHigh(pawn, 'smokeleafHigh');
    var f = 1 + drunk * 0.9 + smoke * 0.3;
    var st = pawn && pawn.drugs;
    if (st && st.worstWd > 0.4) f *= 1 + st.worstWd * 0.6;
    return f;
  };

  Drugs.socialFightFactor = function (pawn) {
    var drunk = Drugs.drunkenness(pawn);
    var st = pawn && pawn.drugs;
    var wd = (st && st.worstWd) || 0;
    return 1 + drunk * 1.8 + wd * 1.2;
  };

  Drugs.wanderChance = function (pawn) {
    var drunk = Drugs.drunkenness(pawn);
    if (drunk <= 0.12) return 0;
    return U.clamp((drunk - 0.12) * 0.42, 0, 0.30);
  };

  /* Pain relief is reported rather than applied twice: the painkiller's
     own hediff carries a negative painOffset, so health.js already has
     it. This is for the UI and for the self-medication policy. */
  Drugs.painRelief = function (pawn) {
    var st = pawn && pawn.drugs;
    if (!st || now() > st.painUntil) return 0;
    return st.painRelief || 0;
  };

  Drugs.preventsDisease = function (pawn) {
    return !!(Health && Health.hasHediff && Health.hasHediff(pawn, 'penoxycylineProtection'));
  };

  /* A colonist on wake-up simply does not get tired for a while. Rest
     is needs.js's number, so this nudges it back up rather than trying
     to stop the decay from outside. */
  function holdRest(pawn, st) {
    if (now() > st.restHoldUntil || !pawn.needs) return;
    pawn.needs.rest = U.clamp01(Math.max(pawn.needs.rest, 0.55));
  }

  /* The stagger. Losing the progress made on the current tile reads as
     a stumble and costs real time, and it only touches per-tick scratch
     that pawn.js recomputes from nothing every step. */
  function stumble(pawn) {
    if (!pawn.path || pawn.pathIdx >= pawn.path.length) return;
    pawn.moveProgress = 0;
    pawn.fx = pawn.x;
    pawn.fy = pawn.y;
    pawn.dir = U.randInt(0, 3);
  }

  /* ==================================================================
     9. SELF-MEDICATION AND THE POLICY

     A colonist who is in pain, miserable or in withdrawal should not
     need to be told. The policy is what keeps that from becoming a
     colony that drinks itself to death the first time morale dips.
     ================================================================== */

  Drugs.policy = {
    allowRecreational: true,     /* beer, joints, tea for a low mood     */
    allowHard: false,            /* flake, yayo without being told       */
    allowPainkillers: true,
    feedAddictions: true,        /* dose an addict before withdrawal     */
    painThreshold: 0.25,
    moodThreshold: 0.34,
    minJoyBefore: 0.45,          /* do not drink for fun with joy this high */
    dosesPerDay: 3               /* a ceiling per colonist, whatever else */
  };

  function policyFor(pawn) {
    var st = ensure(pawn);
    var p = Drugs.policy, out = {}, k;
    for (k in p) out[k] = p[k];
    if (st.policy) for (k in st.policy) out[k] = st.policy[k];
    return out;
  }
  Drugs.policyFor = policyFor;

  Drugs.setPolicy = function (pawn, over) {
    var st = ensure(pawn);
    st.policy = over || null;
    return st.policy;
  };

  function dosesToday(pawn, st) {
    /* One number rather than a log: doses reset on the day boundary. */
    var d = Math.floor(now() / DAY);
    if (st.dayStamp !== d) { st.dayStamp = d; st.dayDoses = 0; }
    return st.dayDoses || 0;
  }

  function noteDoseToday(st) {
    var d = Math.floor(now() / DAY);
    if (st.dayStamp !== d) { st.dayStamp = d; st.dayDoses = 0; }
    st.dayDoses = (st.dayDoses || 0) + 1;
  }

  /* Which drug this colonist would reach for right now, and why. The
     reason is returned because the UI and the readout both want it. */
  Drugs.wants = function (pawn) {
    if (!isPerson(pawn) || pawn.drafted || pawn.downed || pawn.mentalState) return null;
    if (pawn.faction !== 'player') return null;
    var st = ensure(pawn);
    var pol = policyFor(pawn);
    if (dosesToday(pawn, st) >= pol.dosesPerDay) return null;
    if (st.od >= OD_WARN) return null;                 /* already too much */

    /* 1. An addiction that is about to bite, or already biting. */
    if (pol.feedAddictions) {
      var soonest = null, soonestScore = -1;
      for (var chem in st.add) {
        var rec = st.add[chem], cd = CHEMS[chem];
        if (!rec || !cd) continue;
        var sinceDose = (now() - rec.lastDose) / DAY;
        var urgency = sinceDose / Math.max(0.1, cd.needDays);
        if (urgency < 0.85) continue;
        if (urgency > soonestScore) { soonestScore = urgency; soonest = chem; }
      }
      if (soonest) {
        /* A craving takes whatever answers it. The ladder is ordered
           mildest first, so a tea drinker reaches for tea and only
           finds the flake when there is no tea left. */
        return { defIds: CHEM_LADDER[soonest] || [], reason: CHEMS[soonest].label + ' craving' };
      }
    }

    /* 2. Pain the colony can do something about. */
    var pain = (Health && Health.painLevel) ? Health.painLevel(pawn) : 0;
    if (pol.allowPainkillers && pain >= pol.painThreshold && !Drugs.painRelief(pawn)) {
      return { defIds: ['painkiller'], reason: 'pain' };
    }

    /* 3. A mood low enough to be worth the price, with joy already
          spent - a colonist with somewhere better to be goes there.
          This is the only branch a prohibition binds: a faith that
          forbids drugs is talking about getting high, not about a
          painkiller for a gunshot, and an addicted body does not
          consult anybody's precepts before it starts shaking. */
    if (Drugs.forbidden(pawn)) return null;
    var N = sys('Needs');
    var mood = (N && N.mood) ? N.mood(pawn) : 1;
    var joy = pawn.needs ? pawn.needs.joy : 1;
    var urge = Drugs.ideoUrge(pawn);
    var threshold = pol.moodThreshold + urge * 0.18;
    if (pol.allowRecreational && mood < threshold && joy < pol.minJoyBefore) {
      var order = ['beer', 'smokeleafJoint', 'psychiteTea'];
      if (pol.allowHard) order = order.concat(['yayo', 'flake']);
      return { defIds: order, reason: 'low mood' };
    }
    return null;
  };

  /* The least dangerous thing that answers a craving: tea before yayo,
     yayo before flake. A colonist self-medicating never escalates on
     purpose - only when the mild end of the shelf is empty. */
  var CHEM_LADDER = {
    alcohol: ['beer'],
    smokeleaf: ['smokeleafJoint'],
    psychite: ['psychiteTea', 'yayo', 'flake'],
    goJuice: ['goJuice'],
    wakeUp: ['wakeUp'],
    luciferium: ['luciferium']
  };

  /* Find a stack of a drug the pawn can actually get to. Walks
     map.byDef, which is a maintained index, so this is a short list
     even on a colony drowning in beer. */
  Drugs.findDrug = function (pawn, defIds, opts) {
    opts = opts || {};
    var map = pawn.map;
    if (!map) return null;
    var Path = sys('Path');
    var Res = sys('Res');
    var T = sys('T');
    var best = null, bestD = Infinity;
    var radius = opts.radius || 9999;

    for (var i = 0; i < defIds.length; i++) {
      var list = map.byDef(defIds[i]) || [];
      for (var j = 0; j < list.length; j++) {
        var thing = list[j];
        if (!thing || !thing.spawned || !(thing.stack > 0)) continue;
        var d = U.dist(pawn.x, pawn.y, thing.x, thing.y);
        if (d > radius || d >= bestD) continue;
        if (Res && T && Res.reservedBy) {
          var by = Res.reservedBy(map, T.thing(thing));
          if (by && by !== pawn) continue;
        }
        if (Path && Path.reachable &&
            !Path.reachable(map, pawn.x, pawn.y, thing.x, thing.y, { pawn: pawn })) continue;
        best = thing; bestD = d;
      }
    }
    return best;
  };

  /* Walk a preference list in order and take the first one the colony
     actually has, rather than the nearest of the whole shelf. */
  Drugs.findPreferred = function (pawn, defIds, opts) {
    for (var i = 0; i < defIds.length; i++) {
      var thing = Drugs.findDrug(pawn, [defIds[i]], opts);
      if (thing) return thing;
    }
    return null;
  };

  /* ==================================================================
     10. JOBS AND THE WORK GIVER

     jobs.js and workgivers.js both load after this file in the current
     index.html order, so registration is done on whichever comes first:
     load, if those globals already exist, or the first tick if they do
     not. That keeps the file correct wherever the script tag ends up.
     ================================================================== */

  var registered = false;

  function registerBehaviour() {
    if (registered) return false;
    var Jobs = sys('Jobs'), Toils = sys('Toils'), T = sys('T'), Path = sys('Path');
    var WorkGivers = sys('WorkGivers');
    if (!Jobs || !Jobs.register || !Toils || !T) return false;
    registered = true;

    var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

    Jobs.register('takeDrug', {
      label: 'take drug',
      reportString: 'Taking {A}.',
      toils: function (job, pawn) {
        var drugId = job.state && job.state.drugId;
        var drug = DRUGS[drugId] || DRUGS.beer;
        return [
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.pickUp('A', function () { return 1; }),
          Toils.custom({
            name: 'ingest',
            init: function (p, j, s) {
              s.left = drug.ingestTicks || 240;
              if (p.stopPath) p.stopPath();
            },
            tick: function (p, j, s) {
              if (!p.carried) return 'fail';
              if (--s.left > 0) return 'stay';
              var held = p.carried;
              var id = held.defId;
              if (!DRUGS[id]) return 'fail';
              Drugs.ingest(p, id, held);
              noteDoseToday(ensure(p));
              return 'done';
            }
          })
        ];
      }
    });

    /* The binge: tear through the stockpiles for anything at all, and
       smash what is in the way when there is nothing left to take. */
    Jobs.register('drugBinge', {
      label: 'binge',
      reportString: 'Tearing the place apart for a fix.',
      suspendable: false,
      alwaysShow: true,
      allowGoneTarget: true,
      toils: function () {
        return [Toils.custom({
          name: 'binge',
          init: function (pawn, job, s) {
            s.ticks = 0; s.scan = 0; s.target = 0; s.chew = 0; s.cool = 0; s.smash = 0;
          },
          tick: function (pawn, job, s) {
            var map = pawn.map;
            if (!pawn.mentalState) return 'done';
            if (++s.ticks > 30000) return 'done';
            if (s.cool > 0) s.cool--;

            if (s.chew > 0) {
              if (--s.chew > 0) return 'stay';
              if (pawn.carried && DRUGS[pawn.carried.defId]) {
                Drugs.ingest(pawn, pawn.carried.defId, pawn.carried, { quiet: true });
              }
              return 'stay';
            }

            var thing = s.target ? map.things.get(s.target) : null;
            if (!thing || !thing.spawned || !(thing.stack > 0)) {
              /* Sweeping the map for every drug stack is not a per-tick
                 question; ask again in half a second and storm about in
                 the meantime. */
              if (s.scan > 0) { s.scan--; thing = null; }
              else {
                thing = Drugs.findDrug(pawn, BINGE_ORDER, {});
                if (!thing) s.scan = 60;
              }
              if (!thing) return smashSomething(pawn, s);
              s.target = thing.id;
            }

            if (U.cheb(pawn.x, pawn.y, thing.x, thing.y) > 1) {
              if (!pawn.moving() && !pawn.startPath(thing.x, thing.y, PE.TOUCH)) s.target = 0;
              return 'stay';
            }

            if (pawn.stopPath) pawn.stopPath();
            var map2 = pawn.map;
            var part = map2.splitStack(thing, 1);
            if (!part) { s.target = 0; return 'stay'; }
            part.x = pawn.x; part.y = pawn.y; part.spawned = false; part.map = map2;
            if (pawn.carried) {
              if (pawn.carried.defId === part.defId) map2.mergeInto(part, pawn.carried);
              else pawn.dropCarried(pawn.x, pawn.y);
            }
            if (!pawn.carried) pawn.carried = part;
            s.target = 0;
            s.chew = 90;
            return 'stay';
          }
        })];
      }
    });

    if (WorkGivers && WorkGivers.register && !WorkGivers.get('drugsSelfMedicate')) {
      WorkGivers.register({
        id: 'drugsSelfMedicate', workType: 'basic', order: 85,
        label: 'take a drug',
        tryGiveJob: function (pawn) {
          var want = Drugs.wants(pawn);
          if (!want || !want.defIds || !want.defIds.length) return null;
          var thing = Drugs.findPreferred(pawn, want.defIds, { radius: 60 });
          if (!thing) return null;
          var job = Jobs.make('takeDrug', T.thing(thing), null, { count: 1 });
          job.state.drugId = thing.defId;
          job.state.reason = want.reason;
          return job;
        }
      });
    }
    return true;
  }

  /* What a bingeing colonist grabs, worst first, because a binge is not
     a considered decision. */
  var BINGE_ORDER = ['flake', 'yayo', 'goJuice', 'wakeUp', 'beer', 'smokeleafJoint',
    'psychiteTea', 'luciferium'];

  function smashSomething(pawn, s) {
    var map = pawn.map;
    if (s.smash > 0) { s.smash--; return 'stay'; }
    var victim = null, bestD = 9;
    for (var dy = -4; dy <= 4 && !victim; dy++) {
      for (var dx = -4; dx <= 4; dx++) {
        var x = pawn.x + dx, y = pawn.y + dy;
        if (!map.inBounds(x, y)) continue;
        var b = map.buildingAt(x, y);
        if (!b || b.faction !== 'player' || b.isBlueprint || b.isFrame) continue;
        var d = U.cheb(pawn.x, pawn.y, x, y);
        if (d < bestD) { victim = b; bestD = d; }
      }
    }
    if (!victim) {
      if (!pawn.moving()) {
        pawn.startPath(pawn.x + U.randInt(-5, 5), pawn.y + U.randInt(-5, 5), 0);
      }
      s.smash = 40;
      return 'stay';
    }
    if (bestD > 1 && !victim.covers(pawn.x, pawn.y)) {
      if (!pawn.moving() && !pawn.startPath(victim.x, victim.y, 1)) s.smash = 40;
      return 'stay';
    }
    if (pawn.stopPath) pawn.stopPath();
    s.smash = 50;
    victim.damage(U.randInt(6, 16));
    return 'stay';
  }

  /* ==================================================================
     11. READOUTS

     The brief the player wrote was "legible enough that the player can
     see the trap closing before it has closed", so tolerance is shown
     as a percentage of the threshold it is climbing towards, not as a
     bare number nobody can interpret.
     ================================================================== */

  Drugs.addictionReadout = function (pawn) {
    var out = [];
    var st = pawn && pawn.drugs;
    if (!st) return out;
    var t = now(), chem, cd;

    for (chem in st.add) {
      var rec = st.add[chem];
      cd = CHEMS[chem];
      if (!rec || !cd) continue;
      var sinceDose = (t - rec.lastDose) / DAY;
      var note;
      if (rec.wd > 0) {
        note = cd.fatal
          ? 'dying: ' + U.fmt(Math.max(0, (1 - rec.wd) * cd.rampDays), 1) + ' days left'
          : 'withdrawal ' + U.pct(rec.wd) +
            (rec.permanent ? '' : ', ' +
              U.fmt(Math.max(0, cd.endureDays - rec.endured / DAY), 1) + ' days to clean');
      } else {
        note = 'needs a dose in ' +
          U.fmt(Math.max(0, cd.needDays - sinceDose), 1) + ' days';
      }
      out.push({
        kind: 'addiction', chem: chem,
        label: cd.label + ' addiction',
        value: rec.wd, severity: rec.wd > 0.5 ? 'major' : (rec.wd > 0 ? 'minor' : 'none'),
        permanent: !!rec.permanent, note: note
      });
    }

    /* Tolerance only earns a row once it is going somewhere. */
    for (chem in st.tol) {
      cd = CHEMS[chem];
      if (!cd || st.add[chem]) continue;
      var tol = st.tol[chem];
      if (tol < 0.04) continue;
      var toward = cd.addictThreshold > 0 ? U.clamp01(tol / cd.addictThreshold) : 0;
      out.push({
        kind: 'tolerance', chem: chem,
        label: cd.label + ' tolerance',
        value: toward,
        severity: toward >= 1 ? 'major' : (toward > 0.6 ? 'minor' : 'none'),
        note: toward >= 1
          ? 'every dose can now form a habit'
          : U.pct(toward) + ' of the way to a habit'
      });
    }

    if (st.od > 0.08) {
      out.push({
        kind: 'overdose', chem: null, label: 'overdose risk', value: st.od,
        severity: st.od >= OD_WARN ? 'major' : 'minor',
        note: st.od >= OD_WARN ? 'another dose today could kill' : 'recovering'
      });
    }

    out.sort(function (a, b) { return b.value - a.value; });
    return out;
  };

  Drugs.summary = function (pawn) {
    var st = pawn && pawn.drugs;
    if (!st) return '';
    var drunk = Drugs.drunkenness(pawn);
    if (Health && Health.hasHediff && Health.hasHediff(pawn, 'alcoholBlackout')) {
      return 'passed out drunk';
    }
    if (st.worstWd >= 0.85) return 'severe ' + (CHEMS[st.worstChem] || {}).label + ' withdrawal';
    if (st.worstWd > 0.1) return (CHEMS[st.worstChem] || {}).label + ' withdrawal';
    if (drunk > 0.55) return 'very drunk';
    if (drunk > 0.1) return 'drunk';
    for (var id in st.hi) {
      var rec = st.hi[id];
      if (rec && !rec.pending && rec.end > now() && rec.drug) {
        return 'on ' + (DRUGS[rec.drug] ? DRUGS[rec.drug].label : rec.drug);
      }
    }
    return '';
  };

  /* One line per colonist the player should worry about. ui.js may ask
     for this every frame, so the answer is cached for a few seconds of
     game time rather than walking every colonist sixty times a second. */
  var _readoutTick = -99999;

  Drugs.colonyReadout = function (force) {
    var t = now();
    if (!force && t - _readoutTick < 500) return Drugs.alerts;
    _readoutTick = t;
    var G = sys('Game');
    var out = [];
    if (!G || !G.colonists) { Drugs.alerts = out; return out; }
    var list = G.colonists();
    for (var i = 0; i < list.length; i++) {
      var pawn = list[i];
      var rows = Drugs.addictionReadout(pawn);
      for (var j = 0; j < rows.length; j++) {
        if (rows[j].severity === 'none') continue;
        out.push({ pawn: pawn, name: nameOf(pawn), row: rows[j] });
      }
    }
    Drugs.alerts = out;
    return out;
  };

  /* ==================================================================
     12. THE TICKS
     ================================================================== */

  Drugs.tickPawn = function (pawn) {
    if (!registered) registerBehaviour();
    if (!pawn || pawn.dead || !isPerson(pawn)) return;
    var st = pawn.drugs;
    /* A pawn who has never touched anything costs one property read a
       tick and nothing else; the state object is not created until the
       first dose. */
    if (!st) return;

    /* Per-tick: only the stagger, and only while actually walking. */
    if (st._drunk && pawn.path && pawn.pathIdx < pawn.path.length) {
      if (U.chance(st._drunk * 0.02)) stumble(pawn);
    }

    if (((now() + pawn.id + Drugs._beat) % RARE) !== 0) return;

    var days = RARE / DAY;
    applyHighs(pawn, st);
    decayTolerance(pawn, st, days);
    if (st.od > 0) {
      st.od = Math.max(0, st.od - OD_DECAY_PER_DAY * days);
      if (st.od < OD_WARN) {
        clearHediff(pawn, 'drugOverdose');
        st.warned.od = 0;
      }
    }
    tickAddictions(pawn, st, days);
    if (pawn.dead) return;
    holdRest(pawn, st);

    /* Cached for the per-tick stagger so the hot path never walks the
       hediff list. */
    st._drunk = Drugs.wanderChance(pawn);

    /* Penoxycyline is a promise the colony paid for: while it holds,
       nothing infectious takes. */
    if (Drugs.preventsDisease(pawn) && Health && Health.hasHediff) {
      var diseases = ['flu', 'infection'];
      for (var i = 0; i < diseases.length; i++) {
        var hd = Health.hediff(pawn, diseases[i]);
        if (hd && hd.severity < 0.5) Health.removeHediff(pawn, diseases[i]);
      }
    }

    /* Nothing left to remember: drop the state so a colonist who dried
       out twenty days ago stops costing a rare tick and a save line. */
    if (isClean(st)) pawn.drugs = null;
  };

  function isClean(st) {
    /* A policy the player set by hand is a decision, not residue. */
    if (st.policy) return false;
    if (st.od > 0.01) return false;
    if (now() < st.restHoldUntil || now() < st.painUntil) return false;
    for (var k in st.add) if (st.add[k]) return false;
    for (k in st.tol) if (st.tol[k] > 0.005) return false;
    for (k in st.hi) if (st.hi[k]) return false;
    return true;
  }

  /* Staggering the rare tick: everything else in the game offsets by
     pawn id alone, so a colony of three would land all three drug ticks
     in the same 250 as their health ticks. One constant fixes that. */
  Drugs._beat = 113;

  /* game.js calls this on the map beat when the systems registry lists
     Drugs there; it is not needed for the simulation, only to keep the
     readout warm for whoever draws it. */
  Drugs.tick = function (map, game) {
    if (!registered) registerBehaviour();
    if (!map) return;
    var t = (game && game.tick) || now();
    if (t % 500 !== 0) return;
    Drugs.colonyReadout(true);
  };

  Drugs.alerts = [];

  /* ==================================================================
     13. SAVE

     Per-pawn state rides along in save.js's pawn blob because it is a
     plain field of plain values. What is left here is colony-wide: the
     default policy, which is a player setting.
     ================================================================== */

  Drugs.save = function () {
    var p = Drugs.policy, out = {}, k;
    for (k in p) out[k] = p[k];
    return { policy: out };
  };

  Drugs.load = function (obj) {
    if (!obj || !obj.policy) return false;
    var k;
    for (k in Drugs.policy) {
      if (obj.policy[k] !== undefined) Drugs.policy[k] = obj.policy[k];
    }
    return true;
  };

  Drugs.reset = function () {
    Drugs.policy.allowRecreational = true;
    Drugs.policy.allowHard = false;
    Drugs.policy.allowPainkillers = true;
    Drugs.policy.feedAddictions = true;
    Drugs.alerts = [];
  };

  /* If jobs.js and workgivers.js are already loaded when this file is
     evaluated, register now; otherwise the first tick does it. */
  registerBehaviour();

  root.Drugs = Drugs;
})(this);
