/* ============================================================
   ecology.js - the population layer: what lives on this map, how
   many of it there are, and what eats what.

   animals.js owns one beast's brain and training.js owns a tame
   one's life; neither of them has an opinion about how many deer a
   forest can carry. This file does, and that is the whole of its
   job. It never decides where a wolf walks. It decides whether
   there is a wolf at all.

   Four ideas run through it.

   A population is a number chasing a capacity. Capacity comes from
   the plant matter actually standing on the map, so a grazed-bare
   valley carries fewer deer next season whether or not anybody
   noticed. Predator capacity comes from herbivore biomass the same
   way, one trophic level up. Shoot the deer out and the wolves
   starve or come through the wall looking for something softer;
   shoot the wolves out and the deer strip the map to dirt and then
   starve on it. That loop is visible inside one season, which is
   the only reason it is worth simulating at all.

   A map's wildlife is not a roster fixed at generation. Herds
   arrive in spring and leave in the fall, small things boom through
   summer and die back, scavengers turn up when there are corpses to
   turn up for, and an apex predator crosses the map perhaps twice a
   year and is not a fight a young colony wins.

   Ground remembers. Grazing pressure, clear-felling and repeated
   cropping are all recorded per patch, they all decay slowly, and
   they all feed back into what will grow there next. A forest
   regrows where seed trees were left standing and does not where
   they were not. A field cropped with the same thing every season
   quietly stops paying, and rotating or resting it is the fix.

   Everything expensive runs on a rotating phase of the 500-tick
   slow beat, so one pass never walks the map twice.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;
  var Jobs = root.Jobs, Toils = root.Toils, T = root.T;

  var Ecology = {};

  function sys(name) { return root[name] || null; }
  function game() { return root.Game || null; }
  function now() { var G = root.Game; return (G && typeof G.tick === 'number') ? G.tick : 0; }
  function debug() { var G = root.Game; return !!(G && G.debug); }

  /* ---------- tuning ----------
     Rates written per day are divided by TICKS_PER_DAY where used. */
  var TICKS_PER_DAY = 60000;
  var SLOW = 500;                   /* game.js calls us on this beat            */
  var PHASES = 4;                   /* work is spread across four slow beats    */
  var CHUNK = 8;                    /* patch size for pressure bookkeeping      */

  /* How much standing plant nutrition it takes to carry one unit of
     herbivore body size. Tuned so a full temperate forest carries
     roughly two dozen deer-sized animals and an arid map a third of
     that, which is what mapgen's herd counts already imply. */
  var HERB_PER_NUTRITION = 0.016;
  var PRED_SHARE = 0.17;            /* predator biomass as a share of prey       */
  var SCAV_BASE = 1.2;              /* scavenger units a map carries with no dead */
  var HARD_CEILING = 42;            /* wild animals on one map, for the tick cost */

  var BIRTH_PER_DAY = 0.30;         /* per species per day at full headroom      */
  /* Being over capacity is a decline, not a cull. A herd one animal too
     large should thin out over a season; culling it inside three days
     reads as a bug even when the arithmetic is right. */
  var STARVE_PER_DAY = 0.18;
  var STARVE_SLACK = 1.35;          /* headroom before anything starts to die    */
  var MIGRATE_CHECK_DAYS = 1.0;

  var GRAZE_DECAY_PER_DAY = 0.055;  /* how fast bare ground stops being bare     */
  var GRAZE_PER_UNIT_DAY = 0.070;   /* pressure one body-size unit lays on a patch */
  var GRAZE_BARE = 0.55;            /* above this the ground starts going bare   */
  var REGROW_TRIES = 22;            /* patches examined per regrowth pass        */
  var SEED_RADIUS = 9;              /* how far a mature tree will seed a clearing */

  var SOIL_MIN = 0.28, SOIL_MAX = 1.15;
  var SOIL_DRAIN_PER_DAY = 0.022;   /* a crop standing on a cell, before its own factor */
  var SOIL_REST_PER_DAY = 0.020;    /* bare, rested ground coming back           */
  var MONOCULTURE_STEP = 0.35;      /* extra drain per repeat of the same crop   */
  var ROTATION_RELIEF = 0.35;       /* what a different crop costs, against the same one */
  var SOIL_DRAG = 0.33;             /* growth per day lost on wholly dead soil   */
  var SOIL_EXHAUSTED = 0.55;        /* below this the player should be told      */

  var FISH_PER_WATER = 0.115;       /* stock a water cell supports               */
  var FISH_GROW_PER_DAY = 0.16;
  var FISH_DRIFT_PER_DAY = 0.09;    /* recruitment from upstream, so 0 recovers  */
  var FISH_WORK = 900;
  var FISH_BASE_YIELD = 13;
  var FISH_SPOT_TTL = 12000;
  var FISH_RANGE = 46;

  /* ============================================================
     CONTENT

     Registration only. Nothing below this banner runs until the
     game ticks. def_things.js, def_plants.js and def_pawns.js are
     frozen, so everything this system needs that they do not carry
     is added here under ids of its own.
     ============================================================ */

  var S11 = { w: 1, h: 1 };

  var ITEM = {
    category: 'item', description: '',
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

  Defs.add('thing', {
    fishRaw: {
      label: 'raw fish',
      description: 'Fish pulled out of the river. Better eating than raw meat, worse keeping, ' +
        'and the only food on the map that costs nothing but a colonist\'s afternoon.',
      sprite: 'meat', color: '#8fa9b8', color2: '#5b7d90',
      stackLimit: 75, mass: 0.04, marketValue: 2.2,
      nutrition: 0.055, foodType: 'raw', rotDays: 1.8, hp: 40
    }
  }, ITEM);

  Defs.add('recipe', {
    cookFishMeal: {
      label: 'fish meal', jobString: 'Cooking fish', uiCategory: 'cooking',
      workAmount: 280, skill: 'cooking', workType: 'cook',
      workbenches: ['stove', 'campfire'],
      ingredients: [{ anyOf: ['fishRaw'], count: 10 }],
      products: { mealSimple: 1 }, foodPoisonChance: 0.02,
      defaultRepeat: 'untilHave', defaultTargetCount: 30,
      description: 'A river\'s worth of protein turned into something a colonist will eat ' +
        'without resenting you for it.'
    }
  });

  Defs.add('workType', {
    fish: {
      label: 'Fish', verb: 'fishing', order: 9.5,
      description: 'Take fish out of the rivers and lakes. Slow, safe, and the one food source ' +
        'that needs no soil - until the water is fished out, which it can be.',
      skills: ['animals'], relevantSkillsLabel: 'Animals'
    }
  });

  /* ---------- the animals ----------
     Every field def_pawns.js states on its own animal block is stated
     here too, because animals.js, combat.js, health.js and art.js all
     read these without a guard. The helper below is the only thing
     between that and an unreadable table. */

  function beast(o) {
    var out = {
      race: 'animal', isAnimal: false, body: 'quadruped', defaultFaction: 'wild',
      techLevel: 'animal', sprite: 'deer',
      combatPower: 40,
      baseHealthScale: 1, healthScale: 1,
      baseBodySize: 1, bodySize: 1, drawSize: 1,
      moveSpeed: 4.5, moveSpeedFactor: 1,
      baseHungerRate: 1.5, hungerRateFactor: 1,
      lifeExpectancyYears: 10, ageRange: [0.5, 8],
      wildness: 0.7, trainability: 'none', packSize: [1, 3],
      meleeDamage: 6, meleeDamageType: 'bite', meleeCooldownTicks: 120, meleeSkill: 4,
      meleeArmorPen: 0,
      butcherProducts: null, leatherAmount: 0, leatherDef: 'leather',
      color: '#b08c5a', color2: '#d8cfc0',
      comfyTempMin: -25, comfyTempMax: 40,
      armorSharp: 0, armorBlunt: 0, armorHeat: 0,
      diet: 'herbivore', predator: false, grazer: true, nocturnal: false,
      packAnimal: false, breeds: true, nuzzles: false,
      manhunterChance: 0, revengeChance: 0.04, manhunterOnTameFail: 0.02,
      explodeOnDeath: false, explodes: false,
      weapons: [], apparel: []
    };
    for (var k in o) out[k] = o[k];
    /* isAnimal is the flag every other file branches on, and forgetting
       it turns a gazelle into a colonist with hooves. */
    out.isAnimal = true;
    return out;
  }

  Defs.add('pawnKind', {

    /* --- pests and small things that boom --- */
    gopher: beast({
      label: 'gopher', description: 'A burrowing rodent with a talent for finding the one ' +
        'crop you were counting on. Harmless, numerous, and expensive.',
      combatPower: 8, sprite: 'hare',
      baseHealthScale: 0.2, healthScale: 0.2, baseBodySize: 0.18, bodySize: 0.18, drawSize: 0.6,
      moveSpeed: 4.2, baseHungerRate: 1.0, hungerRateFactor: 0.5,
      lifeExpectancyYears: 4, ageRange: [0.2, 3], wildness: 0.4, packSize: [2, 5],
      meleeDamage: 2, meleeCooldownTicks: 150, meleeSkill: 0,
      butcherProducts: { meatRaw: 8 },
      color: '#9a7a52', color2: '#cbb894', comfyTempMin: -18, comfyTempMax: 42
    }),
    marmot: beast({
      label: 'marmot', description: 'A fat hillside rodent that spends the summer eating and ' +
        'the winter asleep. Three of them are a stew.',
      combatPower: 12, sprite: 'hare',
      baseHealthScale: 0.32, healthScale: 0.32, baseBodySize: 0.3, bodySize: 0.3, drawSize: 0.75,
      moveSpeed: 4.0, baseHungerRate: 1.0, hungerRateFactor: 0.6,
      lifeExpectancyYears: 7, ageRange: [0.3, 6], wildness: 0.35, packSize: [2, 6],
      meleeDamage: 3, meleeCooldownTicks: 140, meleeSkill: 1,
      butcherProducts: { meatRaw: 16, leather: 6 }, leatherAmount: 6,
      color: '#a8854f', color2: '#ddcfae', nuzzles: true, comfyTempMin: -35, comfyTempMax: 34
    }),
    locustSwarm: beast({
      label: 'locust swarm', description: 'Not one insect but a column of them. It eats a ' +
        'standing field down to stubble in an afternoon and then moves on.',
      combatPower: 18, sprite: 'boomrat',
      baseHealthScale: 0.18, healthScale: 0.18, baseBodySize: 0.12, bodySize: 0.12, drawSize: 0.85,
      moveSpeed: 4.8, baseHungerRate: 2.6, hungerRateFactor: 1.6,
      lifeExpectancyYears: 1, ageRange: [0.1, 0.9], wildness: 1, packSize: [5, 9],
      meleeDamage: 2, meleeDamageType: 'bite', meleeCooldownTicks: 90, meleeSkill: 0,
      butcherProducts: null, breeds: false,
      color: '#7a6a2e', color2: '#c8b858',
      comfyTempMin: 2, comfyTempMax: 50
    }),

    /* --- grazers and browsers --- */
    gazelle: beast({
      label: 'gazelle', description: 'Built entirely out of running away. Worth an arrow if ' +
        'you can land one before the herd is a dust cloud on the ridge.',
      combatPower: 30, sprite: 'deer',
      baseHealthScale: 0.7, healthScale: 0.7, baseBodySize: 0.55, bodySize: 0.55, drawSize: 1.15,
      moveSpeed: 6.4, baseHungerRate: 1.4, lifeExpectancyYears: 9, ageRange: [0.4, 8],
      wildness: 0.78, packSize: [4, 8],
      meleeDamage: 5, meleeCooldownTicks: 130,
      butcherProducts: { meatRaw: 40, leather: 22 }, leatherAmount: 22,
      color: '#c19a5e', color2: '#efe3c8', comfyTempMin: -10, comfyTempMax: 48
    }),
    elk: beast({
      label: 'elk', description: 'A browser the size of a horse. It lives off saplings and ' +
        'bark, which means a wood full of elk is a wood that never grows back.',
      combatPower: 85, sprite: 'deer',
      baseHealthScale: 1.5, healthScale: 1.5, baseBodySize: 1.4, bodySize: 1.4, drawSize: 1.7,
      moveSpeed: 5.0, baseHungerRate: 1.9, hungerRateFactor: 1.2,
      lifeExpectancyYears: 16, ageRange: [0.8, 14], wildness: 0.8,
      trainability: 'intermediate', packSize: [3, 6],
      meleeDamage: 13, meleeDamageType: 'blunt', meleeCooldownTicks: 130, meleeSkill: 3,
      butcherProducts: { meatRaw: 105, leather: 48 }, leatherAmount: 48,
      color: '#6f4f2e', color2: '#c2ac8a', revengeChance: 0.06, comfyTempMin: -40, comfyTempMax: 32
    }),
    bison: beast({
      label: 'bison', description: 'Two tonnes of grazing inertia. A herd of them will flatten ' +
        'a pasture and anybody standing in it.',
      combatPower: 190, sprite: 'muffalo',
      baseHealthScale: 2.1, healthScale: 2.1, baseBodySize: 2.4, bodySize: 2.4, drawSize: 2.0,
      moveSpeed: 3.6, baseHungerRate: 2.4, hungerRateFactor: 1.5,
      lifeExpectancyYears: 22, ageRange: [1, 20], wildness: 0.82,
      trainability: 'intermediate', packSize: [4, 8],
      meleeDamage: 16, meleeDamageType: 'blunt', meleeCooldownTicks: 150, meleeSkill: 4,
      butcherProducts: { meatRaw: 175, leather: 75 }, leatherAmount: 75,
      color: '#4b3a2a', color2: '#7a6245',
      revengeChance: 0.09, manhunterChance: 0.03, comfyTempMin: -45, comfyTempMax: 34
    }),
    ibex: beast({
      label: 'ibex', description: 'A cliff goat that browses whatever the herd below cannot ' +
        'reach. Sure-footed, foul-tempered and very hard to sneak up on.',
      combatPower: 45, sprite: 'deer',
      baseHealthScale: 0.85, healthScale: 0.85, baseBodySize: 0.7, bodySize: 0.7, drawSize: 1.2,
      moveSpeed: 5.2, baseHungerRate: 1.4, lifeExpectancyYears: 14, ageRange: [0.6, 12],
      wildness: 0.85, trainability: 'intermediate', packSize: [2, 5],
      meleeDamage: 9, meleeDamageType: 'blunt', meleeCooldownTicks: 120, meleeSkill: 4,
      butcherProducts: { meatRaw: 52, leather: 26 }, leatherAmount: 26,
      color: '#8a7b5e', color2: '#d6cbb0', revengeChance: 0.1, comfyTempMin: -40, comfyTempMax: 34
    }),

    /* --- livestock worth the trouble of taming --- */
    highlandCow: beast({
      label: 'highland cow', description: 'Slow, shaggy and patient. Two of them in a pen is ' +
        'a colony that never runs out of milk again.',
      combatPower: 110, sprite: 'muffalo',
      baseHealthScale: 1.7, healthScale: 1.7, baseBodySize: 1.7, bodySize: 1.7, drawSize: 1.75,
      moveSpeed: 3.2, baseHungerRate: 2.1, hungerRateFactor: 1.35,
      lifeExpectancyYears: 20, ageRange: [1, 17], wildness: 0.45,
      trainability: 'intermediate', packSize: [2, 4],
      meleeDamage: 10, meleeDamageType: 'blunt', meleeCooldownTicks: 150, meleeSkill: 2,
      butcherProducts: { meatRaw: 130, leather: 58 }, leatherAmount: 58,
      color: '#7d4a28', color2: '#c98f4e', comfyTempMin: -40, comfyTempMax: 30,
      nuzzles: true,
      produce: {
        milk: { item: 'milk', amount: 14, days: 0.9, femaleOnly: true, work: 300, verb: 'milk' }
      }
    }),
    alpaca: beast({
      label: 'alpaca', description: 'A fleece on legs with an opinion about being touched. ' +
        'Shears well, milks poorly, and spits at anyone who forgets which.',
      combatPower: 55, sprite: 'muffalo',
      baseHealthScale: 0.9, healthScale: 0.9, baseBodySize: 0.9, bodySize: 0.9, drawSize: 1.3,
      moveSpeed: 4.0, baseHungerRate: 1.5, lifeExpectancyYears: 16, ageRange: [0.8, 14],
      wildness: 0.5, trainability: 'intermediate', packSize: [3, 6],
      meleeDamage: 6, meleeDamageType: 'blunt', meleeCooldownTicks: 140, meleeSkill: 2,
      butcherProducts: { meatRaw: 60, leather: 30 }, leatherAmount: 30,
      color: '#c9b79a', color2: '#efe6d5', comfyTempMin: -35, comfyTempMax: 32,
      produce: {
        wool: { item: 'wool', amount: 38, days: 7, work: 480, verb: 'shear' },
        milk: { item: 'milk', amount: 5, days: 1.4, femaleOnly: true, work: 260, verb: 'milk' }
      }
    }),
    dromedary: beast({
      label: 'dromedary', description: 'The reason a caravan can cross forty tiles of nothing. ' +
        'Carries a colonist\'s bodyweight in trade goods and complains the entire way.',
      combatPower: 120, sprite: 'muffalo',
      baseHealthScale: 1.6, healthScale: 1.6, baseBodySize: 2.0, bodySize: 2.0, drawSize: 1.8,
      moveSpeed: 4.0, baseHungerRate: 1.6, hungerRateFactor: 0.9,
      lifeExpectancyYears: 24, ageRange: [1, 20], wildness: 0.55,
      trainability: 'intermediate', packAnimal: true, packSize: [2, 5],
      meleeDamage: 11, meleeDamageType: 'blunt', meleeCooldownTicks: 145, meleeSkill: 3,
      butcherProducts: { meatRaw: 145, leather: 62 }, leatherAmount: 62,
      color: '#c2a273', color2: '#e8d9ba', comfyTempMin: -12, comfyTempMax: 52,
      produce: {
        milk: { item: 'milk', amount: 9, days: 1.1, femaleOnly: true, work: 300, verb: 'milk' }
      }
    }),

    /* --- birds --- */
    grouse: beast({
      label: 'grouse', description: 'A ground bird that would rather freeze than fly. Easy ' +
        'hunting, and about one meal on the bone.',
      combatPower: 8, body: 'bird', sprite: 'chicken',
      baseHealthScale: 0.22, healthScale: 0.22, baseBodySize: 0.2, bodySize: 0.2, drawSize: 0.65,
      moveSpeed: 4.4, baseHungerRate: 0.9, hungerRateFactor: 0.5,
      lifeExpectancyYears: 5, ageRange: [0.3, 4], wildness: 0.5, packSize: [3, 7],
      meleeDamage: 2, meleeDamageType: 'blunt', meleeCooldownTicks: 140, meleeSkill: 0,
      butcherProducts: { meatRaw: 11 },
      color: '#8c7248', color2: '#cbb387', diet: 'omnivore', comfyTempMin: -40, comfyTempMax: 36
    }),
    heron: beast({
      label: 'heron', description: 'Stands in the shallows all day doing nothing, then does ' +
        'one thing very fast. It is competition, and it is winning.',
      combatPower: 16, body: 'bird', sprite: 'chicken',
      baseHealthScale: 0.3, healthScale: 0.3, baseBodySize: 0.35, bodySize: 0.35, drawSize: 0.95,
      moveSpeed: 4.6, baseHungerRate: 1.2, lifeExpectancyYears: 12, ageRange: [0.5, 10],
      wildness: 0.8, packSize: [1, 2],
      meleeDamage: 5, meleeDamageType: 'stab', meleeCooldownTicks: 110, meleeSkill: 3,
      butcherProducts: { meatRaw: 18, leather: 5 }, leatherAmount: 5,
      color: '#9aa7ad', color2: '#e3e7e8', diet: 'carnivore', grazer: false,
      comfyTempMin: -12, comfyTempMax: 42
    }),
    vulture: beast({
      label: 'vulture', description: 'Arrives the day after something dies and leaves the day ' +
        'after that. A sky full of them is a report on how your week went.',
      combatPower: 24, body: 'bird', sprite: 'chicken',
      baseHealthScale: 0.38, healthScale: 0.38, baseBodySize: 0.4, bodySize: 0.4, drawSize: 1.0,
      moveSpeed: 5.0, baseHungerRate: 1.1, lifeExpectancyYears: 18, ageRange: [0.6, 15],
      wildness: 0.88, packSize: [2, 5],
      meleeDamage: 6, meleeDamageType: 'bite', meleeCooldownTicks: 110, meleeSkill: 3,
      butcherProducts: { meatRaw: 20, leather: 8 }, leatherAmount: 8,
      color: '#4a423c', color2: '#b5a08a', diet: 'carnivore', grazer: false,
      revengeChance: 0.06, comfyTempMin: -20, comfyTempMax: 48
    }),

    /* --- predators, in order of how much trouble they are --- */
    jackal: beast({
      label: 'jackal', description: 'Half scavenger, half thief. Will not fight a colonist and ' +
        'will absolutely empty an unroofed meat store.',
      combatPower: 45, sprite: 'wolf',
      baseHealthScale: 0.5, healthScale: 0.5, baseBodySize: 0.45, bodySize: 0.45, drawSize: 1.0,
      moveSpeed: 5.6, baseHungerRate: 1.4, lifeExpectancyYears: 11, ageRange: [0.5, 9],
      wildness: 0.85, trainability: 'advanced', packSize: [2, 4], nocturnal: true,
      predator: true, diet: 'carnivore', grazer: false,
      meleeDamage: 8, meleeDamageType: 'bite', meleeCooldownTicks: 95, meleeSkill: 5,
      butcherProducts: { meatRaw: 32, leather: 20 }, leatherAmount: 20,
      color: '#a07b4c', color2: '#d9c39c',
      revengeChance: 0.06, manhunterOnTameFail: 0.05, comfyTempMin: -20, comfyTempMax: 48
    }),
    lynx: beast({
      label: 'lynx', description: 'Takes hares, birds and anything sleeping outside. Rarely ' +
        'seen, which is not the same as rarely present.',
      combatPower: 70, sprite: 'wolf',
      baseHealthScale: 0.65, healthScale: 0.65, baseBodySize: 0.6, bodySize: 0.6, drawSize: 1.05,
      moveSpeed: 5.6, baseHungerRate: 1.5, lifeExpectancyYears: 14, ageRange: [0.5, 12],
      wildness: 0.92, trainability: 'advanced', packSize: [1, 2], nocturnal: true,
      predator: true, diet: 'carnivore', grazer: false,
      meleeDamage: 11, meleeDamageType: 'bite', meleeCooldownTicks: 95, meleeSkill: 7,
      butcherProducts: { meatRaw: 44, leather: 28 }, leatherAmount: 28,
      color: '#9c8a6a', color2: '#e0d5bd',
      revengeChance: 0.08, manhunterOnTameFail: 0.09, manhunterChance: 0.05,
      comfyTempMin: -45, comfyTempMax: 36
    }),
    panther: beast({
      label: 'panther', description: 'The big cat. It will not attack a group and it will take ' +
        'anyone working alone at the far end of the map.',
      combatPower: 140, sprite: 'wolf',
      baseHealthScale: 1.1, healthScale: 1.1, baseBodySize: 1.1, bodySize: 1.1, drawSize: 1.35,
      moveSpeed: 6.0, baseHungerRate: 1.8, hungerRateFactor: 1.1,
      lifeExpectancyYears: 16, ageRange: [0.8, 14], wildness: 0.95,
      trainability: 'advanced', packSize: [1, 1], nocturnal: true,
      predator: true, diet: 'carnivore', grazer: false,
      meleeDamage: 16, meleeDamageType: 'bite', meleeCooldownTicks: 95, meleeSkill: 8,
      meleeArmorPen: 0.08,
      butcherProducts: { meatRaw: 85, leather: 45 }, leatherAmount: 45,
      color: '#2c2a30', color2: '#4e4a54', armorSharp: 0.05,
      revengeChance: 0.12, manhunterOnTameFail: 0.14, manhunterChance: 0.1,
      comfyTempMin: -25, comfyTempMax: 46
    }),
    direwolf: beast({
      label: 'dire wolf', description: 'Wolves that never got the message about being afraid ' +
        'of people. They hunt as a pack and they do not break off.',
      combatPower: 150, sprite: 'wolf',
      baseHealthScale: 1.1, healthScale: 1.1, baseBodySize: 1.1, bodySize: 1.1, drawSize: 1.4,
      moveSpeed: 5.6, baseHungerRate: 1.8, hungerRateFactor: 1.15,
      lifeExpectancyYears: 14, ageRange: [0.8, 12], wildness: 0.96,
      trainability: 'advanced', packSize: [3, 5], nocturnal: true,
      predator: true, diet: 'carnivore', grazer: false,
      meleeDamage: 15, meleeDamageType: 'bite', meleeCooldownTicks: 90, meleeSkill: 8,
      butcherProducts: { meatRaw: 80, leather: 46 }, leatherAmount: 46,
      color: '#43434c', color2: '#8c8c96',
      revengeChance: 0.14, manhunterOnTameFail: 0.16, manhunterChance: 0.14,
      comfyTempMin: -50, comfyTempMax: 34
    }),
    sabrecat: beast({
      label: 'sabrecat', description: 'The thing at the top. It crosses the map perhaps twice ' +
        'a year, it is not afraid of a turret, and a colony of three does not fight it - ' +
        'it goes indoors and waits.',
      combatPower: 420, sprite: 'bear',
      baseHealthScale: 2.4, healthScale: 2.4, baseBodySize: 2.6, bodySize: 2.6, drawSize: 1.9,
      moveSpeed: 5.2, baseHungerRate: 2.2, hungerRateFactor: 1.4,
      lifeExpectancyYears: 24, ageRange: [2, 20], wildness: 0.99,
      trainability: 'advanced', packSize: [1, 1],
      predator: true, diet: 'carnivore', grazer: false,
      meleeDamage: 30, meleeDamageType: 'bite', meleeCooldownTicks: 100, meleeSkill: 10,
      meleeArmorPen: 0.25,
      butcherProducts: { meatRaw: 200, leather: 95 }, leatherAmount: 95,
      color: '#7a6340', color2: '#cbb489', armorSharp: 0.2, armorBlunt: 0.18,
      revengeChance: 0.3, manhunterOnTameFail: 0.4, manhunterChance: 0.25,
      comfyTempMin: -50, comfyTempMax: 44
    }),

    /* --- the water ----------
       These two are stock species: the population is the fish stock in
       the rivers and lakes, not a set of pawns wandering the bank. They
       are registered as kinds anyway so the biomass report, the fishing
       job and the trade value of a catch can all name what was caught
       rather than talking about an abstract number. */
    riverTrout: beast({
      label: 'river trout', description: 'Lives in running water and is the reason a colony ' +
        'built on a river never quite starves.',
      combatPower: 1, sprite: 'hare', stockOnly: true,
      baseHealthScale: 0.15, healthScale: 0.15, baseBodySize: 0.2, bodySize: 0.2, drawSize: 0.5,
      moveSpeed: 3.0, baseHungerRate: 0.8, lifeExpectancyYears: 6, ageRange: [0.2, 5],
      wildness: 1, packSize: [1, 1], breeds: false,
      meleeDamage: 1, meleeCooldownTicks: 200, meleeSkill: 0,
      butcherProducts: { fishRaw: 9 },
      color: '#7f9aa8', color2: '#d3dbdf', diet: 'carnivore', grazer: false,
      comfyTempMin: -5, comfyTempMax: 28
    }),
    lakePike: beast({
      label: 'lake pike', description: 'Slow-growing, long-lived and worth three trout. Fish a ' +
        'lake hard enough and the pike are the first thing that stops coming up.',
      combatPower: 3, sprite: 'hare', stockOnly: true,
      baseHealthScale: 0.25, healthScale: 0.25, baseBodySize: 0.5, bodySize: 0.5, drawSize: 0.7,
      moveSpeed: 3.0, baseHungerRate: 0.9, lifeExpectancyYears: 14, ageRange: [0.5, 12],
      wildness: 1, packSize: [1, 1], breeds: false,
      meleeDamage: 3, meleeCooldownTicks: 180, meleeSkill: 1,
      butcherProducts: { fishRaw: 22 },
      color: '#5f7a4a', color2: '#c3cc9a', diet: 'carnivore', grazer: false,
      comfyTempMin: -5, comfyTempMax: 26
    })
  });

  /* ============================================================
     THE ECOLOGICAL TABLE

     def_pawns.js says how big a thing is and how hard it hits.
     This says what it does for a living: which trophic level it
     sits on, which biomes carry it, how it moves with the seasons,
     and how large a share of the map's food budget it claims when
     several species are competing for the same grass.
     ============================================================ */

  var ALL = ['temperateForest', 'aridShrubland', 'borealForest'];
  var WARM = ['temperateForest', 'aridShrubland'];
  var COLD = ['temperateForest', 'borealForest'];

  /* season: multipliers on capacity, spring/summer/fall/winter.
     migrates: leaves the map entirely for the winter and comes back.
     share:   relative claim on the food budget of its trophic level. */
  var SPECIES = {
    /* Herbivores. Shares are deliberately lopsided: an ecosystem is two
       or three common species and a long tail of rarer ones, and a table
       where everything is equally likely reads as a zoo. */
    hare:        { role: 'grazer', biomes: ALL, share: 2.4, season: [1.2, 1.5, 1.0, 0.5], breed: 2.2 },
    deer:        { role: 'grazer', biomes: COLD, share: 2.6, season: [1.2, 1.2, 1.1, 0.7], breed: 1.0 },
    muffalo:     { role: 'grazer', biomes: ALL, share: 2.0, season: [1.0, 1.1, 1.1, 0.9], breed: 0.6 },
    boomrat:     { role: 'grazer', biomes: WARM, share: 1.1, season: [1.1, 1.4, 1.0, 0.6], breed: 1.8 },
    chicken:     { role: 'grazer', biomes: ALL, share: 0.4, season: [1.1, 1.3, 1.0, 0.6], breed: 1.6 },
    /* new herbivores */
    gopher:      { role: 'pest', biomes: ALL, share: 0.8, season: [1.3, 1.8, 1.1, 0.4], breed: 2.6 },
    marmot:      { role: 'grazer', biomes: COLD, share: 0.9, season: [1.2, 1.7, 0.9, 0.2], breed: 2.0 },
    grouse:      { role: 'grazer', biomes: ALL, share: 1.0, season: [1.2, 1.5, 1.0, 0.6], breed: 1.7 },
    gazelle:     { role: 'grazer', biomes: WARM, share: 2.2, season: [1.3, 1.1, 1.2, 0.3], breed: 1.1,
                   migrates: true },
    elk:         { role: 'browser', biomes: COLD, share: 1.0, season: [1.2, 1.0, 1.3, 0.4], breed: 0.55,
                   migrates: true, browses: true },
    ibex:        { role: 'browser', biomes: COLD, share: 0.5, season: [1.0, 1.1, 1.0, 0.8], breed: 0.7,
                   browses: true },
    bison:       { role: 'grazer', biomes: ALL, share: 0.9, season: [1.1, 1.3, 1.2, 0.6], breed: 0.5 },
    highlandCow: { role: 'livestock', biomes: COLD, share: 0.3, season: [1.0, 1.1, 1.0, 0.8], breed: 0.5 },
    alpaca:      { role: 'livestock', biomes: ALL, share: 0.3, season: [1.0, 1.1, 1.0, 0.8], breed: 0.7 },
    dromedary:   { role: 'livestock', biomes: WARM, share: 0.3, season: [1.0, 1.1, 1.0, 0.9], breed: 0.5 },
    locustSwarm: { role: 'insect', biomes: WARM, share: 0.5, season: [0.2, 1.8, 0.5, 0.0], breed: 0 },
    /* predators and scavengers */
    wolf:        { role: 'predator', biomes: ALL, share: 2.4, season: [1.0, 1.0, 1.1, 1.0], breed: 0.7 },
    bear:        { role: 'predator', biomes: COLD, share: 1.4, season: [1.1, 1.1, 1.2, 0.4], breed: 0.4 },
    jackal:      { role: 'scavenger', biomes: WARM, share: 1.2, season: [1.0, 1.1, 1.1, 0.9], breed: 1.1 },
    vulture:     { role: 'scavenger', biomes: ALL, share: 1.0, season: [1.0, 1.2, 1.1, 0.7], breed: 0.6 },
    lynx:        { role: 'predator', biomes: COLD, share: 1.0, season: [1.0, 1.0, 1.1, 0.9], breed: 0.7 },
    panther:     { role: 'predator', biomes: WARM, share: 0.6, season: [1.0, 1.0, 1.1, 0.8], breed: 0.4 },
    direwolf:    { role: 'predator', biomes: COLD, share: 0.5, season: [0.9, 0.9, 1.1, 1.2], breed: 0.4 },
    sabrecat:    { role: 'apex', biomes: ALL, share: 0.4, season: [0.8, 1.0, 1.2, 1.0], breed: 0.15 },
    heron:       { role: 'fisher', biomes: ALL, share: 1.0, season: [1.1, 1.2, 1.0, 0.4], breed: 0.7,
                   migrates: true },
    /* stock species: no pawns, the fishery is their population */
    riverTrout:  { role: 'fish', biomes: ALL, share: 0.7, season: [1.1, 1.0, 1.1, 0.8], breed: 0 },
    lakePike:    { role: 'fish', biomes: ALL, share: 0.3, season: [1.0, 1.0, 1.1, 0.9], breed: 0 }
  };

  var SEASON_IDX = { spring: 0, summer: 1, fall: 2, winter: 3 };
  var HERB_ROLES = { grazer: 1, browser: 1, livestock: 1, pest: 1, insect: 1 };
  var MEAT_ROLES = { predator: 1, apex: 1, scavenger: 1, fisher: 1 };

  function eco(kindId) { return SPECIES[kindId] || null; }
  function sizeOf(kindId) {
    var A = sys('Animals');
    if (A && A.info) { var i = A.info(kindId); if (i && i.bodySize > 0) return i.bodySize; }
    var d = Defs.maybe('pawnKind', kindId);
    return (d && d.bodySize > 0) ? d.bodySize : 0.7;
  }
  function labelOf(kindId) {
    var d = Defs.maybe('pawnKind', kindId);
    return (d && d.label) || kindId;
  }

  /* How much crop drain each sowable plant does, relative to rice. A
     field of haygrass is close to a rest, which is the whole reason a
     rotation is worth planning. */
  /* A negative number is a crop that puts something back: haygrass is
     the rest crop, which is why a four-field rotation through it is very
     nearly sustainable and a field of rice is not. */
  var CROP_DRAIN = {
    plantRice: 1.0, plantCorn: 1.3, plantCotton: 1.15,
    plantPotato: 0.7, plantHealroot: 0.5, plantHaygrass: -0.4
  };

  /* ============================================================
     STATE

     Persistent: populations the map is aiming at, soil memory,
     the fishery, and the log the UI reads. Derived state hangs off
     the map under a private key and is rebuilt on load, because
     none of it is worth a byte in a save file.
     ============================================================ */

  function freshState() {
    return {
      beat: 0,
      lastTick: 0,
      biome: 'temperateForest',
      pop: {},              /* kindId -> live count, refreshed every beat     */
      cap: {},              /* kindId -> carrying capacity                    */
      taken: {},            /* kindId -> how many the colony has killed       */
      born: {}, starved: {}, arrived: {}, left: {},
      soil: {},             /* cellIdx -> [fertility, lastCropId, streak, rest] */
      fish: { stock: 0, cap: 0, caught: 0, seeded: false },
      seasonSeen: '',
      apexDay: -99,
      swarmDay: -99,
      predatorRaidDay: -99,
      log: [],
      _starveTold: {},
      _goneTold: {},
      policy: {
        fishing: 'auto',    /* 'auto' | 'always' | 'never'                    */
        fishTarget: 45,     /* stored nutrition below which 'auto' fishes     */
        fishFloor: 0.25,    /* refuse to fish a stock below this share of cap */
        hunting: true,      /* let predator pressure push beasts at the colony */
        reseed: true        /* let the map regrow trees and cover             */
      }
    };
  }

  var state = freshState();
  var _map = null;
  var _loaded = false;
  var _installed = false;

  Ecology.state = state;

  Ecology.reset = function () {
    state = freshState();
    Ecology.state = state;
    _map = null;
    return state;
  };

  function note(text) {
    state.log.push({ tick: now(), text: text });
    if (state.log.length > 40) state.log.splice(0, state.log.length - 40);
  }

  function letter(title, text, kind, at) {
    var G = game();
    if (!G || !G.letter) return;
    G.letter(title, text, {
      kind: kind || 'neutral',
      x: at ? at.x : undefined, y: at ? at.y : undefined
    });
    note(title);
  }

  function msg(text, kind, at) {
    var G = game();
    if (!G || !G.msg) return;
    G.msg(text, { type: kind || 'info', x: at ? at.x : undefined, y: at ? at.y : undefined });
  }

  /* ---------- derived, per map ---------- */

  function derived(map) {
    var d = map.__eco;
    if (d && d.w === map.w) return d;
    var cw = Math.ceil(map.w / CHUNK), ch = Math.ceil(map.h / CHUNK);
    d = map.__eco = {
      w: map.w, cw: cw, ch: ch, n: cw * ch,
      graze: new Float32Array(cw * ch),     /* 0..1 how chewed down a patch is  */
      felled: new Float32Array(cw * ch),    /* trees taken out of a patch       */
      plant: new Float32Array(cw * ch),     /* standing nutrition per patch     */
      trees: new Int16Array(cw * ch),
      seeds: new Int16Array(cw * ch),       /* mature trees that can seed       */
      biomass: 0, treeCount: 0, seedTrees: 0, cover: 0,
      water: 0, spots: null, spotTick: -99999,
      censusTick: -99999
    };
    return d;
  }

  function chunkAt(d, x, y) { return ((y / CHUNK) | 0) * d.cw + ((x / CHUNK) | 0); }

  /* ============================================================
     CENSUS

     Two walks, on different beats. Animals are cheap and counted
     every beat; plants are the expensive one and are counted on
     phase zero, which is every four beats - two thousand ticks, or
     about two minutes of game time at 1x.
     ============================================================ */

  function censusAnimals(map) {
    var pop = {}, list = map.pawns, i, p;
    var herbUnits = 0, predUnits = 0, wildCount = 0, tameCount = 0;
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (p.isAnimal !== true || p.dead) continue;
      pop[p.kindId] = (pop[p.kindId] || 0) + 1;
      var role = (eco(p.kindId) || {}).role || 'grazer';
      var size = sizeOf(p.kindId);
      if (p.faction === 'player') { tameCount++; continue; }
      wildCount++;
      if (HERB_ROLES[role]) herbUnits += size;
      else if (MEAT_ROLES[role]) predUnits += size;
    }
    state.pop = pop;
    state.herbUnits = herbUnits;
    state.predUnits = predUnits;
    state.wildCount = wildCount;
    state.tameCount = tameCount;
    return pop;
  }

  function censusPlants(map) {
    var d = derived(map);
    var defs = Defs.plants();
    var i, j;
    for (i = 0; i < d.n; i++) { d.plant[i] = 0; d.trees[i] = 0; d.seeds[i] = 0; }
    var total = 0, trees = 0, seedTrees = 0, cover = 0;
    for (i = 0; i < defs.length; i++) {
      var def = defs[i];
      var p = def.plant;
      if (!p) continue;
      var nut = def.nutrition || 0;
      var isTree = !!p.isTree;
      var list = map.byDef(def.id);
      for (j = 0; j < list.length; j++) {
        var plant = list[j];
        if (!plant.spawned) continue;
        cover++;
        var c = chunkAt(d, plant.x, plant.y);
        if (nut > 0) {
          var value = nut * (0.25 + 0.75 * (plant.growth || 0));
          total += value;
          d.plant[c] += value;
        }
        if (isTree) {
          trees++; d.trees[c]++;
          if ((plant.growth || 0) >= 0.55) { seedTrees++; d.seeds[c]++; }
        }
      }
    }
    d.biomass = total;
    d.treeCount = trees;
    d.seedTrees = seedTrees;
    d.cover = cover;
    d.censusTick = now();
    return total;
  }

  function biomassOf(map) {
    var d = derived(map);
    if (d.censusTick < 0) censusPlants(map);
    return d.biomass;
  }

  function waterCells(map) {
    var d = derived(map);
    if (d.water) return d.water;
    var n = 0;
    for (var i = 0; i < map.size; i++) {
      var t = map.terrainAtIdx ? map.terrainAtIdx(i) : null;
      if (t && t.isWater) n++;
    }
    d.water = n;
    return n;
  }

  /* ============================================================
     CARRYING CAPACITY
     ============================================================ */

  function seasonFactor(rec) {
    var G = game();
    var s = (G && G.season) ? G.season() : 'spring';
    var arr = rec.season || [1, 1, 1, 1];
    return arr[SEASON_IDX[s] === undefined ? 0 : SEASON_IDX[s]];
  }

  function inBiome(rec) {
    var b = (game() && game().biome) || state.biome || 'temperateForest';
    return !rec.biomes || rec.biomes.indexOf(b) >= 0;
  }

  /* Everything a capacity calculation needs, computed once per beat
     rather than once per species. */
  var EMPTY_BUDGET = {
    tick: -1, plant: 0, corpses: 0, herbTotal: 0, predTotal: 0, scavTotal: 0,
    herbShare: 1, predShare: 1, scavShare: 1, fishShare: 1, grazeMean: 0
  };

  function budget(map) {
    if (!map || !map.pawns) return EMPTY_BUDGET;
    var b = state._budget;
    if (b && b.tick === now()) return b;
    var plant = biomassOf(map);
    var d = derived(map);
    var corpses = map.byDef ? map.byDef('corpse').length : 0;

    var herbTotal = plant * HERB_PER_NUTRITION;
    var predTotal = Math.max(0, state.herbUnits || 0) * PRED_SHARE;
    var scavTotal = SCAV_BASE + corpses * 0.22;

    /* Shares are worked out over the species that actually live in this
       biome, so the same forest carries more deer when there are no elk
       competing for the same browse. */
    var herbShare = 0, predShare = 0, scavShare = 0, fishShare = 0;
    for (var id in SPECIES) {
      var rec = SPECIES[id];
      if (!inBiome(rec)) continue;
      var w = rec.share * seasonFactor(rec);
      if (HERB_ROLES[rec.role]) herbShare += w;
      else if (rec.role === 'scavenger') scavShare += w;
      else if (rec.role === 'fish') fishShare += w;
      else if (MEAT_ROLES[rec.role]) predShare += w;
    }

    b = state._budget = {
      tick: now(), plant: plant, corpses: corpses,
      herbTotal: herbTotal, predTotal: predTotal, scavTotal: scavTotal,
      herbShare: herbShare || 1, predShare: predShare || 1,
      scavShare: scavShare || 1, fishShare: fishShare || 1,
      grazeMean: meanGraze(d)
    };
    return b;
  }

  /* Grazing pressure weighted by how much food each patch holds. A herd
     standing on one bare hillside should not lower the whole map's
     capacity; a map grazed flat everywhere should. */
  function meanGraze(d) {
    var wsum = 0, gsum = 0;
    for (var i = 0; i < d.n; i++) {
      var w = d.plant[i] + 0.2;
      wsum += w;
      gsum += w * d.graze[i];
    }
    return wsum ? gsum / wsum : 0;
  }

  Ecology.capacityFor = function (map, kindId) {
    map = mapOf(map);
    var rec = eco(kindId);
    if (!map || !rec || !inBiome(rec)) return 0;
    var b = budget(map);
    var size = sizeOf(kindId);
    var weight = rec.share * seasonFactor(rec);
    var units;

    if (rec.role === 'fish') {
      return Math.round(state.fish.cap * (rec.share / b.fishShare));
    }
    if (rec.role === 'scavenger') {
      units = b.scavTotal * (weight / b.scavShare);
    } else if (rec.role === 'fisher') {
      /* A heron lives off the fishery, not off the grass. */
      units = state.fish.cap > 0 ? (state.fish.stock / Math.max(1, state.fish.cap)) * 1.6 : 0;
    } else if (HERB_ROLES[rec.role]) {
      units = b.herbTotal * (weight / b.herbShare);
      /* Chewed-down ground carries less than the standing crop implies,
         because the animals got there first and it has not come back. */
      units *= (1 - 0.55 * b.grazeMean);
      if (rec.role === 'insect') units *= 0.5;
    } else {
      units = b.predTotal * (weight / b.predShare);
      if (rec.role === 'apex') units *= 0.45;
    }
    if (!(units > 0)) return 0;
    var cap = units / Math.max(0.1, size);
    /* Livestock species do not build a wild population worth the name:
       they are here to be tamed, not to fill the valley. */
    if (rec.role === 'livestock') cap = Math.min(cap, 6);
    if (rec.role === 'apex') cap = Math.min(cap, 1);
    return Math.round(cap * 10) / 10;
  };

  Ecology.populationOf = function (map, kindId) {
    if (kindId === undefined && typeof map === 'string') { kindId = map; map = null; }
    var rec = eco(kindId);
    if (rec && rec.role === 'fish') {
      var b = budget(mapOf(map));
      return Math.round(state.fish.stock * (rec.share / b.fishShare));
    }
    return state.pop[kindId] || 0;
  };

  /* ============================================================
     POPULATION DYNAMICS

     Births, starvation and the pressure a hungry predator puts on
     the colony, once per beat on phase one. Nothing here moves an
     animal: it adds them, removes them, or makes one angry.
     ============================================================ */

  function spawnNear(map, kindId, x, y, count) {
    var A = sys('Animals');
    if (!A || !A.spawnWild) return [];
    return A.spawnWild(map, kindId, x, y, count) || [];
  }

  function anchorFor(map, kindId) {
    /* Newborns appear beside an adult of their own kind; an arrival
       appears at the map edge. */
    var list = map.pawns, found = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.kindId === kindId && !p.dead && p.faction !== 'player') found.push(p);
    }
    return found.length ? U.pick(found) : null;
  }

  function edgeSpot(map) {
    var MG = sys('MapGen');
    var side = U.pick(['n', 'e', 's', 'w']);
    var cells = (MG && MG.edgeSpawnCells) ? MG.edgeSpawnCells(map, side) : null;
    if (cells && cells.length) return U.pick(cells);
    for (var t = 0; t < 120; t++) {
      var x = U.randInt(2, map.w - 3), y = U.randInt(2, map.h - 3);
      if (map.passable(x, y)) {
        var terr = map.terrainAt(x, y);
        if (!terr || !terr.isWater) return { x: x, y: y };
      }
    }
    return null;
  }

  /* An animal that walks off the map is not a dead animal: no corpse,
     no meat, nothing to butcher. It is simply not here any more. */
  function leaveMap(pawn) {
    var map = pawn.map;
    if (!map) return false;
    var J = sys('Jobs');
    if (pawn.job && J && J.end) J.end(pawn, 'interrupted');
    var R = sys('Res');
    if (R && R.releaseAll) R.releaseAll(pawn);
    if (map.removePawn) map.removePawn(pawn);
    else U.remove(map.pawns, pawn);
    pawn.map = null;
    return true;
  }

  function killAnimal(pawn, cause) {
    var A = sys('Animals'), H = sys('Health');
    if (A && A.notifyDeath) A.notifyDeath(pawn, null);
    if (H && H.kill) H.kill(pawn, cause || 'starvation');
    else pawn.dead = true;
  }

  function tickPopulations(map, days) {
    var b = budget(map);
    var total = state.wildCount || 0;
    var id, rec, pop, cap, i;

    for (id in SPECIES) {
      rec = SPECIES[id];
      if (rec.role === 'fish') continue;
      pop = state.pop[id] || 0;
      cap = Ecology.capacityFor(map, id);
      state.cap[id] = cap;
      if (!pop) continue;

      /* Over capacity: the weakest go first, and a herd standing on
         chewed ground goes faster than the number alone suggests. */
      if (pop > cap * STARVE_SLACK + 0.8) {
        var over = (pop - cap) / Math.max(1, cap + 1);
        var pStarve = STARVE_PER_DAY * days * U.clamp(over, 0, 2.5);
        for (i = 0; i < pop && U.chance(pStarve); i++) {
          var victim = weakestOf(map, id);
          if (!victim) break;
          killAnimal(victim, 'starvation');
          state.starved[id] = (state.starved[id] || 0) + 1;
          pStarve *= 0.55;
        }
        if ((state.starved[id] || 0) >= 3 && !state._starveTold[id]) {
          state._starveTold[id] = 1;
          note('There is not enough forage on this map for the ' + labelOf(id) + '.');
        }
        continue;
      }

      /* Under capacity with room on the map: breed toward it. */
      if (!(rec.breed > 0) || total >= HARD_CEILING) continue;
      var headroom = (cap - pop) / Math.max(1, cap);
      if (headroom <= 0.05) continue;
      var pBirth = BIRTH_PER_DAY * rec.breed * days * headroom;
      if (!U.chance(pBirth)) continue;
      var dam = anchorFor(map, id);
      if (!dam) continue;
      var young = spawnNear(map, id, dam.x, dam.y, 1);
      if (young.length) {
        young[0].ageYears = 0.2;
        young[0].ageTicks = 0;
        state.born[id] = (state.born[id] || 0) + 1;
        total++;
      }
    }

    predatorPressure(map, days);
  }

  function weakestOf(map, kindId) {
    var list = map.pawns, worst = null, worstScore = Infinity;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.kindId !== kindId || p.dead || p.faction === 'player') continue;
      var food = (p.needs && typeof p.needs.food === 'number') ? p.needs.food : 1;
      var age = p.ageYears || 1;
      var score = food * 10 + Math.min(age, 4);
      if (score < worstScore) { worstScore = score; worst = p; }
    }
    return worst;
  }

  /* A predator with nothing left to eat is the most direct feedback
     this system has into the rest of the game: it comes for the colony.
     Hunt the deer out and the wolves become your problem. */
  function predatorPressure(map, days) {
    if (!state.policy.hunting) return;
    var preyUnits = state.herbUnits || 0;
    var predUnits = state.predUnits || 0;
    if (predUnits <= 0) return;
    var pressure = predUnits / Math.max(0.35, preyUnits * PRED_SHARE);
    state.pressure = pressure;
    if (pressure < 1.6) return;

    var A = sys('Animals');
    if (!A || !A.makeManhunter) return;
    var candidates = [];
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.dead || p.faction === 'player' || p.isAnimal !== true) continue;
      var rec = eco(p.kindId);
      if (!rec || !MEAT_ROLES[rec.role] || rec.role === 'scavenger') continue;
      var food = (p.needs && typeof p.needs.food === 'number') ? p.needs.food : 1;
      if (food < 0.42) candidates.push(p);
    }
    if (!candidates.length) return;

    var G = game();
    var day = G && G.day ? G.day() : 0;
    if (day - (state.predatorRaidDay || -99) < 2) return;
    var chance = 0.45 * days * U.clamp(pressure - 1.5, 0, 3);
    if (!U.chance(chance)) return;
    state.predatorRaidDay = day;
    var beast = U.pick(candidates);
    A.makeManhunter(beast, { ticks: U.randInt(14000, 30000) });
    letter('Starving predator',
      'There is not enough game left on this map to keep the ' + labelOf(beast.kindId) +
      ' fed. One of them has stopped being careful and is heading for the colony.',
      'threat', beast);
  }

  /* ============================================================
     SEASONS AND MIGRATION

     Herds are not furniture. They arrive, they leave, and a species
     marked migratory is simply absent for a season. Small things
     boom through summer and die back in the cold; the boom is in
     the season table, the dying back is capacity doing its work.
     ============================================================ */

  function seasonTurned(map) {
    var G = game();
    var season = (G && G.season) ? G.season() : 'spring';
    if (season === state.seasonSeen) return false;
    var was = state.seasonSeen;
    state.seasonSeen = season;
    if (!was) return false;

    var leavers = [], arrivers = [];
    for (var id in SPECIES) {
      var rec = SPECIES[id];
      if (!rec.migrates || !inBiome(rec)) continue;
      if (season === 'winter') leavers.push(id);
      else if (was === 'winter') arrivers.push(id);
    }
    if (season === 'winter' && leavers.length) departSeason(map, leavers);
    if (was === 'winter' && arrivers.length) arriveSeason(map, arrivers);

    /* Something the player can feel without reading a panel: the log
       says what the season did to the map. */
    note(U.cap(season) + ': ' + describeSeason(map, season));
    return true;
  }

  function describeSeason(map, season) {
    if (season === 'winter') return 'the herds have gone and the small things are underground.';
    if (season === 'spring') return 'the herds are back and everything is breeding.';
    if (season === 'summer') return 'small game is everywhere and the insects are awake.';
    return 'the browse is heavy and the predators are fattening up.';
  }

  function departSeason(map, ids) {
    var gone = 0, list = map.pawns.slice();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.dead || p.faction === 'player' || ids.indexOf(p.kindId) < 0) continue;
      if (p.tame) continue;
      if (leaveMap(p)) { gone++; state.left[p.kindId] = (state.left[p.kindId] || 0) + 1; }
    }
    if (!gone) return;
    letter('The herds move on',
      gone + ' ' + U.plural(gone, 'animal') + ' have left the map for the winter. They will be ' +
      'back in spring, and until then there is nothing out there to hunt.', 'neutral');
  }

  function arriveSeason(map, ids) {
    var arrived = 0, first = null;
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var cap = Ecology.capacityFor(map, id);
      if (cap < 1) continue;
      var want = Math.min(Math.round(cap * U.randRange(0.5, 0.9)), 8);
      if (want < 1) continue;
      var spot = edgeSpot(map);
      if (!spot) continue;
      var born = spawnNear(map, id, spot.x, spot.y, want);
      arrived += born.length;
      state.arrived[id] = (state.arrived[id] || 0) + born.length;
      if (!first && born.length) first = born[0];
    }
    if (!arrived) return;
    letter('Migration',
      arrived + ' ' + U.plural(arrived, 'animal') + ' have come back onto the map with the ' +
      'thaw. Hunt them while they are here.', 'good', first);
  }

  /* Between the seasonal moves, a species below capacity with nobody
     left on the map to breed from gets a wandering group instead, so a
     hunted-out species is not gone forever - only until something walks
     back in over the ridge. */
  function tickImmigration(map, days) {
    if ((state.wildCount || 0) >= HARD_CEILING) return;
    var pool = [];
    for (var id in SPECIES) {
      var rec = SPECIES[id];
      if (rec.role === 'fish' || rec.role === 'insect' || !inBiome(rec)) continue;
      if (rec.migrates && state.seasonSeen === 'winter') continue;
      var pop = state.pop[id] || 0;
      var cap = state.cap[id] === undefined ? Ecology.capacityFor(map, id) : state.cap[id];
      if (cap < 1.5 || pop >= cap * 0.5) continue;
      pool.push({ id: id, cap: cap, pop: pop });
    }
    if (!pool.length) return;
    if (!U.chance(0.09 * days)) return;
    var pick = U.pickWeighted(pool, function (e) { return (e.cap - e.pop); });
    if (!pick) return;
    var spot = edgeSpot(map);
    if (!spot) return;
    var count = U.clamp(Math.round(pick.cap * 0.4), 1, 5);
    var born = spawnNear(map, pick.id, spot.x, spot.y, count);
    if (!born.length) return;
    state.arrived[pick.id] = (state.arrived[pick.id] || 0) + born.length;
    msg(born.length + ' ' + labelOf(pick.id) + ' wandered onto the map.', 'info', born[0]);
  }

  /* The apex predator is an event, not a population. It crosses the map
     at most twice a year and it is not a fight a small colony takes. */
  function tickApex(map, days) {
    var G = game();
    var day = G && G.day ? G.day() : 0;
    if (day - state.apexDay < 45) return;
    if (day < 12) return;
    if (!U.chance(0.012 * days)) return;
    if (!inBiome(SPECIES.sabrecat)) return;
    state.apexDay = day;
    var spot = edgeSpot(map);
    if (!spot) return;
    var born = spawnNear(map, 'sabrecat', spot.x, spot.y, 1);
    if (!born.length) return;
    letter('Something big is on the map',
      'A sabrecat has come down out of the hills. It weighs as much as three colonists and it ' +
      'is not frightened of anything you own. Bring everyone inside and let it pass.',
      'threat', born[0]);
  }

  /* An insect swarm is summer's own disaster: it arrives, it eats the
     standing crop, and then it dies with the first cold night. */
  function tickSwarm(map, days) {
    var G = game();
    var day = G && G.day ? G.day() : 0;
    if ((G && G.season ? G.season() : '') !== 'summer') return;
    if (day - state.swarmDay < 30) return;
    if (!U.chance(0.02 * days)) return;
    state.swarmDay = day;
    var spot = edgeSpot(map);
    if (!spot) return;
    var born = spawnNear(map, 'locustSwarm', spot.x, spot.y, U.randInt(5, 8));
    if (!born.length) return;
    letter('Locusts',
      'A swarm has come in off the dry ground. They will eat every standing crop they can ' +
      'reach and then die with the first cold night. Harvest early or lose the field.',
      'threat', born[0]);
  }

  /* What the swarm actually does. Run on the same beat as the plant
     work, because it is plant work. */
  function swarmDamage(map, days) {
    var pawns = map.pawns, hit = 0;
    for (var i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      if (p.dead || p.kindId !== 'locustSwarm') continue;
      for (var t = 0; t < 3; t++) {
        var x = p.x + U.randInt(-2, 2), y = p.y + U.randInt(-2, 2);
        var plant = map.inBounds(x, y) ? map.plantAt(x, y) : null;
        if (!plant || !plant.spawned) continue;
        var def = plant.def;
        if (!def || !def.plant || def.plant.isTree) continue;
        plant.growth = Math.max(0, (plant.growth || 0) - U.randRange(0.25, 0.6) * days * 4);
        if (plant.growth <= 0.02) {
          var P = sys('Plants');
          if (P && P.kill) P.kill(map, plant, 'eaten');
          hit++;
        }
      }
    }
    if (hit > 6) msg('Locusts have stripped ' + hit + ' plants.', 'threat');
  }

  /* ============================================================
     PLANT ECOLOGY

     Grazing pressure is written per patch by the herbivores standing
     on it and decays slowly; regrowth reads it and refuses to seed a
     patch that has been chewed to dirt. Trees come back where there
     is a mature tree left to seed them and nowhere else, which is
     the whole argument for leaving a treeline standing.
     ============================================================ */

  function tickGrazing(map, days) {
    var d = derived(map);
    var i;
    var decay = GRAZE_DECAY_PER_DAY * days;
    for (i = 0; i < d.n; i++) {
      if (d.graze[i] > 0) d.graze[i] = Math.max(0, d.graze[i] - decay);
      if (d.felled[i] > 0) d.felled[i] = Math.max(0, d.felled[i] - decay * 0.4);
    }

    var list = map.pawns;
    for (i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.dead || p.isAnimal !== true) continue;
      var rec = eco(p.kindId);
      if (!rec || !HERB_ROLES[rec.role]) continue;
      var c = chunkAt(d, p.x, p.y);
      d.graze[c] = U.clamp01(d.graze[c] + GRAZE_PER_UNIT_DAY * sizeOf(p.kindId) * days);
    }

    /* Where the pressure is highest the ground actually goes bare. This
       is the half of overgrazing a player can see from the camera: the
       grass under a standing herd stops being grass, and the patch stays
       dirt long after the herd has moved on because regrowth refuses to
       seed anything above GRAZE_BARE. */
    var worst = 0, bare = 0;
    for (i = 0; i < d.n; i++) {
      var g = d.graze[i];
      if (g > worst) worst = g;
      if (g >= GRAZE_BARE) bare++;
      if (g < GRAZE_BARE) continue;
      var bite = U.clamp(3.2 * days * (g - GRAZE_BARE + 0.1), 0, 0.95);
      for (var k = 0; k < 3; k++) {
        if (!U.chance(bite)) break;
        if (!stripPatch(map, d, i)) break;
      }
    }
    state.grazeWorst = worst;
    state.grazeBare = bare;
  }

  Ecology.grazingAt = function (map, x, y) {
    map = mapOf(map);
    if (!map || !map.inBounds(x, y)) return 0;
    var d = derived(map);
    return d.graze[chunkAt(d, x, y)];
  };

  function patchOrigin(d, c) {
    return { x: (c % d.cw) * CHUNK, y: ((c / d.cw) | 0) * CHUNK };
  }

  function stripPatch(map, d, c) {
    var o = patchOrigin(d, c);
    var P = sys('Plants');
    for (var t = 0; t < 4; t++) {
      var x = o.x + U.randInt(0, CHUNK - 1), y = o.y + U.randInt(0, CHUNK - 1);
      if (!map.inBounds(x, y)) continue;
      var plant = map.plantAt(x, y);
      if (!plant || !plant.spawned || plant.sown) continue;
      var def = plant.def;
      if (!def || !def.plant || def.plant.isTree) continue;
      if (!(def.nutrition > 0)) continue;
      if (P && P.kill) P.kill(map, plant, 'grazed');
      return true;
    }
    return false;
  }

  /* Regrowth. Wild cover creeps back into patches that are not chewed
     bare, and trees come back only within seeding range of a mature
     tree. A patch that was clear-felled with nothing left standing
     stays a clearing, which is the point. */
  function tickRegrowth(map, days) {
    if (!state.policy.reseed) return;
    var d = derived(map);
    var P = sys('Plants');
    if (!P || !P.canSeedAt || !d.n) return;
    var biome = (game() && game().biome) || state.biome;

    for (var t = 0; t < REGROW_TRIES; t++) {
      var c = U.randInt(0, d.n - 1);
      if (d.graze[c] > 0.45) continue;
      var o = patchOrigin(d, c);
      var x = o.x + U.randInt(0, CHUNK - 1), y = o.y + U.randInt(0, CHUNK - 1);
      if (!map.inBounds(x, y)) continue;

      /* Trees first: they are the slow half and the half that needs a
         parent. Everything else fills in around them. */
      if (d.trees[c] < 7 && U.chance(0.45)) {
        var treeId = seedTreeNear(map, x, y, biome);
        if (treeId) {
          var def = Defs.maybe('thing', treeId);
          if (def && P.canSeedAt(map, x, y, def)) {
            var sapling = map.spawnThing(treeId, x, y, { growth: 0.04 });
            if (sapling) { sapling.plantAgeTicks = 0; d.trees[c]++; }
          }
        }
        continue;
      }
      coverSeed(map, P, x, y, biome, d, c);
    }
  }

  /* Which tree can seed this cell: a mature one of the same species
     within reach. No parent, no sapling. */
  function seedTreeNear(map, x, y, biome) {
    var best = null;
    for (var t = 0; t < 10; t++) {
      var a = U.rand() * 6.283185307179586;
      var r = U.randRange(1, SEED_RADIUS);
      var sx = Math.round(x + Math.cos(a) * r), sy = Math.round(y + Math.sin(a) * r);
      if (!map.inBounds(sx, sy)) continue;
      var plant = map.plantAt(sx, sy);
      if (!plant || !plant.spawned) continue;
      var def = plant.def;
      if (!def || !def.plant || !def.plant.isTree) continue;
      if ((plant.growth || 0) < 0.55) continue;
      var bi = def.plant.wildBiomes;
      if (bi && biome && bi.indexOf(biome) < 0) continue;
      best = def.id;
      break;
    }
    return best;
  }

  /* Ground cover competes: the species already dominant in the patch
     has the advantage, which is how a map keeps its character instead
     of homogenising into one grass. */
  function coverSeed(map, P, x, y, biome, d, c) {
    var defs = Defs.plants();
    var pool = [];
    for (var i = 0; i < defs.length; i++) {
      var def = defs[i], p = def.plant;
      if (!p || p.sowable || p.isTree || !(p.wildDensity > 0)) continue;
      if (p.wildBiomes && biome && p.wildBiomes.indexOf(biome) < 0) continue;
      if (!P.canSeedAt(map, x, y, def)) continue;
      pool.push(def);
    }
    if (!pool.length) return;
    var choice = U.pickWeighted(pool, function (def) {
      var w = def.plant.wildDensity;
      /* Whatever is already standing nearby seeds more readily. */
      if (neighbourOf(map, x, y, def.id)) w *= 3.2;
      return w;
    });
    if (!choice) return;
    var seedling = map.spawnThing(choice.id, x, y, { growth: 0.05 });
    if (seedling) seedling.plantAgeTicks = 0;
  }

  function neighbourOf(map, x, y, defId) {
    for (var i = 0; i < U.ADJ8.length; i++) {
      var pl = map.plantAt(x + U.ADJ8[i][0], y + U.ADJ8[i][1]);
      if (pl && pl.defId === defId) return true;
    }
    return false;
  }

  /* ============================================================
     SOIL

     A cell that has had a crop on it remembers. The memory is
     [fertility multiplier, last crop id, repeat streak, rest ticks]
     and it is the whole of crop rotation: the same crop twice
     running drains harder, a different one drains less, and bare
     ground comes back on its own if you leave it alone.
     ============================================================ */

  /* [fertility, last crop id, repeat streak, days since a crop stood here,
     1 while one is standing]. The fifth slot is what lets a harvest be
     noticed without anybody reporting it: a crop that was here last pass
     and is gone this one came off the field. */
  function soilRec(idx) {
    var r = state.soil[idx];
    if (!r) { r = state.soil[idx] = [1, '', 0, 0, 0]; }
    if (r.length < 5) r[4] = 0;
    return r;
  }

  Ecology.fertilityAt = function (map, x, y) {
    map = mapOf(map);
    if (!map || !map.inBounds(x, y)) return 0;
    var terr = map.terrainAt(x, y);
    var base = terr ? (terr.fertility || 0) : 0;
    var r = state.soil[map.idx(x, y)];
    return base * (r ? r[0] : 1);
  };

  Ecology.soilAt = function (map, x, y) {
    map = mapOf(map);
    if (!map || !map.inBounds(x, y)) return 1;
    var r = state.soil[map.idx(x, y)];
    return r ? r[0] : 1;
  };

  function tickSoil(map, days) {
    var seen = 0, exhausted = 0, resting = 0, worst = 1;
    var zones = map.zones || [];
    var touched = {};

    /* Cells inside a growing zone are the ones a player is farming, and
       they are the only ones worth remembering. */
    for (var z = 0; z < zones.length; z++) {
      var zone = zones[z];
      if (!zone || zone.kind !== 'growing' || !zone.cells) continue;
      zone.cells.forEach(function (idx) {
        touched[idx] = 1;
        var x = map.xOf(idx), y = map.yOf(idx);
        var r = soilRec(idx);
        var plant = map.plantAt(x, y);
        var cropId = (plant && plant.sown && plant.def && plant.def.plant &&
                      plant.def.plant.sowable) ? plant.defId : '';

        if (cropId) {
          var rotated = false;
          if (cropId !== r[1]) {
            /* Rotation. A new crop resets the streak, and the ground
               notices immediately. */
            r[1] = cropId;
            r[2] = 0;
            rotated = true;
          }
          r[3] = 0;
          r[4] = 1;
          var drain = (CROP_DRAIN[cropId] === undefined ? 1 : CROP_DRAIN[cropId]);
          drain *= (1 + MONOCULTURE_STEP * Math.min(r[2], 4));
          /* A crop that follows a different one takes far less out than
             the same one over and over. This is the whole of rotation and
             it is the cheapest real idea in the genre. */
          if (rotated || r[2] === 0) drain *= ROTATION_RELIEF;
          r[0] = U.clamp(r[0] - SOIL_DRAIN_PER_DAY * drain * days, SOIL_MIN, SOIL_MAX);
          /* Growth actually slows on tired ground. Without this the
             number would be a readout rather than a mechanic. */
          if (r[0] < 1 && plant.growth > 0) {
            plant.growth = Math.max(0, plant.growth - SOIL_DRAG * (1 - r[0]) * days);
          }
        } else {
          if (r[4]) { r[4] = 0; bumpStreak(r, r[1]); }
          r[3] += days;
          if (r[2] > 0 && r[3] > 1.5) r[2] = Math.max(0, r[2] - 1);
          var rest = SOIL_REST_PER_DAY * days * (r[3] > 3 ? 1.6 : 1);
          r[0] = Math.min(SOIL_MAX, r[0] + rest);
          if (r[3] > 2) resting++;
        }
        seen++;
        if (r[0] < SOIL_EXHAUSTED) exhausted++;
        if (r[0] < worst) worst = r[0];
      });
    }

    /* A cell that left every growing zone stops being tracked, but not
       instantly: a field taken out of rotation for one season should
       still remember it was farmed. */
    for (var key in state.soil) {
      if (touched[key]) continue;
      var rec = state.soil[key];
      rec[3] += days;
      rec[0] = Math.min(SOIL_MAX, rec[0] + SOIL_REST_PER_DAY * days * 1.6);
      if (rec[0] >= SOIL_MAX - 0.01 && rec[3] > 12) delete state.soil[key];
    }

    state.soilStats = { tracked: seen, exhausted: exhausted, resting: resting, worst: worst };
    if (exhausted > 8 && !state._soilTold) {
      state._soilTold = true;
      letter('The fields are tired',
        'Most of the growing zone has been cropped with the same thing for too long and is ' +
        'giving back less every harvest. Sow something different in it, or leave a part of it ' +
        'empty for a season and let it come back.', 'neutral');
    } else if (exhausted === 0) {
      state._soilTold = false;
    }
  }

  function bumpStreak(r, defId) {
    if (!defId || CROP_DRAIN[defId] === undefined) return;
    if (defId === r[1]) r[2] = Math.min(6, r[2] + 1);
    else { r[1] = defId; r[2] = 0; }
  }

  /* When a crop comes off a cell, the streak for that crop goes up.
     plants.js does not report a harvest and nothing obliges it to, so
     tickSoil notices the crop disappearing by itself; this entry point
     exists for callers that would rather say so outright, and calling it
     twice for one harvest is harmless because the standing-crop flag has
     already been cleared by then. */
  Ecology.noteHarvest = function (map, x, y, defId, count) {
    map = mapOf(map);
    if (!map || !map.inBounds(x, y)) return;
    var r = soilRec(map.idx(x, y));
    if (r[4]) { r[4] = 0; bumpStreak(r, defId || r[1]); }
    r[3] = 0;
    state.harvested = (state.harvested || 0) + (count || 0);
  };

  /* Somebody killed something. Used for the "hunted out" readout and,
     more importantly, so a colony that empties the map of deer gets the
     predator consequence rather than a shrug. */
  Ecology.noteKill = function (pawn, killer) {
    if (!pawn || pawn.isAnimal !== true) return;
    var id = pawn.kindId;
    state.taken[id] = (state.taken[id] || 0) + 1;
    if (killer && killer.faction === 'player') {
      state.takenByColony = (state.takenByColony || 0) + 1;
    }
    var cap = state.cap[id] || 0;
    var pop = Math.max(0, (state.pop[id] || 1) - 1);
    state.pop[id] = pop;
    if (cap >= 2 && pop === 0 && !state._goneTold[id]) {
      state._goneTold[id] = 1;
      note('The last ' + labelOf(id) + ' on the map is gone.');
    } else if (pop > 0) {
      state._goneTold[id] = 0;
    }
  };

  /* Census fallback: a species that was here last beat and is not here
     now was taken by something, whether or not anybody reported it. */
  function reconcile(previous) {
    for (var id in previous) {
      var was = previous[id] || 0, is = state.pop[id] || 0;
      if (is < was) state.taken[id] = (state.taken[id] || 0) + (was - is);
    }
  }

  /* ============================================================
     THE FISHERY

     One stock for the whole map, sized by how much water there is.
     It grows logistically, it takes recruitment from upstream so a
     fished-out river can come back, and every catch takes from it.
     Fish it hard and the yields fall before the fish run out, which
     is the warning a player gets.
     ============================================================ */

  function fishCap(map) {
    var n = waterCells(map);
    return Math.round(n * FISH_PER_WATER);
  }

  function tickFish(map, days) {
    var f = state.fish;
    f.cap = fishCap(map);
    if (!f.cap) { f.stock = 0; return; }
    if (!f.seeded) { f.stock = f.cap * U.randRange(0.7, 0.95); f.seeded = true; }
    var logistic = f.stock * (1 - f.stock / f.cap) * FISH_GROW_PER_DAY * days;
    var drift = FISH_DRIFT_PER_DAY * days * (1 - f.stock / f.cap);
    f.stock = U.clamp(f.stock + logistic + drift, 0, f.cap);

    /* Herons take their share before the colony does. */
    var herons = state.pop.heron || 0;
    if (herons) f.stock = Math.max(0, f.stock - herons * 0.35 * days);

    if (f.stock < f.cap * 0.2 && !f._told) {
      f._told = true;
      letter('The river is fished out',
        'Catches have collapsed. The stock needs a season with nobody standing on the bank ' +
        'before it is worth fishing again - set fishing to never, or watch the yields keep ' +
        'falling.', 'neutral');
    } else if (f.stock > f.cap * 0.5) {
      f._told = false;
    }
  }

  Ecology.fishStock = function () {
    return { stock: Math.round(state.fish.stock * 10) / 10, cap: state.fish.cap };
  };

  function fishYield() {
    var f = state.fish;
    if (!f.cap || f.stock <= 0) return 0;
    var share = U.clamp01(f.stock / f.cap);
    return Math.max(1, Math.round(FISH_BASE_YIELD * (0.25 + 0.75 * share)));
  }

  function fishSpecies() {
    var share = state.fish.cap ? U.clamp01(state.fish.stock / state.fish.cap) : 0;
    /* Pike are the first thing to disappear from a pressed fishery. */
    return (share > 0.55 && U.chance(0.3)) ? 'lakePike' : 'riverTrout';
  }

  /* Shore cells a colonist can stand on and fish from: passable, dry
     enough to work from, and next to open water. Cached, because the
     coastline does not move. */
  function fishSpots(map) {
    var d = derived(map);
    if (d.spots && now() - d.spotTick < FISH_SPOT_TTL) return d.spots;
    var spots = [];
    for (var y = 0; y < map.h; y++) {
      for (var x = 0; x < map.w; x++) {
        if (!map.passable(x, y)) continue;
        var here = map.terrainAt(x, y);
        /* Stand on the bank, not in the river. */
        if (here && here.isWater) continue;
        if (map.buildingAt(x, y)) continue;
        for (var i = 0; i < U.ADJ4.length; i++) {
          var nx = x + U.ADJ4[i][0], ny = y + U.ADJ4[i][1];
          if (!map.inBounds(nx, ny)) continue;
          var t = map.terrainAt(nx, ny);
          if (t && t.isWater) { spots.push(map.idx(x, y)); break; }
        }
      }
    }
    d.spots = spots;
    d.spotTick = now();
    return spots;
  }

  /* How much food the colony has on hand, in nutrition units. The
     'auto' fishing policy reads this so a colonist does not spend the
     whole summer on the bank with a full larder behind them. */
  function storedNutrition(map) {
    var total = 0;
    var defs = Defs.items();
    for (var i = 0; i < defs.length; i++) {
      var def = defs[i];
      if (!(def.nutrition > 0) || def.foodType === 'animal') continue;
      var list = map.byDef(def.id);
      for (var j = 0; j < list.length; j++) {
        var thing = list[j];
        if (thing.spawned) total += def.nutrition * (thing.stack || 1);
      }
    }
    return total;
  }

  function shouldFish(map) {
    var p = state.policy;
    if (p.fishing === 'never') return false;
    if (!state.fish.cap) return false;
    if (state.fish.stock < state.fish.cap * p.fishFloor) return false;
    if (p.fishing === 'always') return true;
    var cached = state._food;
    if (!cached || cached.tick !== now()) {
      cached = state._food = { tick: now(), value: storedNutrition(map) };
    }
    return cached.value < p.fishTarget;
  }

  Ecology.shouldFish = function (map) { return shouldFish(mapOf(map)); };

  /* ---------- the fishing job ---------- */

  if (Jobs && Jobs.register && Toils && Toils.work) {
    var PE = (root.Path && root.Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };
    Jobs.register('fish', {
      label: 'fish',
      reportString: function () { return 'Fishing'; },
      toils: function () {
        return [
          Toils.reserve('A'),
          Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false }),
          Toils.work({
            name: 'fishWork',
            skill: 'animals',
            amount: function () { return FISH_WORK; },
            onTick: function (pawn, job, s) {
              job.workLeft = Math.max(0, s.total - s.done);
              /* Somebody else emptied the stock while this one sat
                 there. Better to stand up than to land a fish that is
                 not in the river. */
              if (state.fish.stock < 1) return 'fail';
            },
            onDone: function (pawn, job) {
              job.workLeft = 0;
              var map = pawn.map;
              if (!map) return 'fail';
              var count = fishYield();
              if (count < 1) return 'fail';
              var speciesId = fishSpecies();
              var weight = speciesId === 'lakePike' ? 2.2 : 1;
              state.fish.stock = Math.max(0, state.fish.stock - weight);
              state.fish.caught += count;
              state.taken[speciesId] = (state.taken[speciesId] || 0) + 1;
              var pos = T.pos(job.targetA, map) || { x: pawn.x, y: pawn.y };
              map.addItem('fishRaw', pos.x, pos.y, count);
              return 'done';
            }
          })
        ];
      }
    });
  }

  function fishJobFor(pawn) {
    var map = pawn.map;
    if (!map || !shouldFish(map)) return null;
    var spots = fishSpots(map);
    if (!spots.length) return null;
    var Res = sys('Res'), Path = sys('Path');
    var best = null, bestD = Infinity;
    /* A sample rather than a scan: a river is hundreds of cells long
       and the nearest twenty tries are always good enough. */
    for (var t = 0; t < 24; t++) {
      var idx = spots[U.randInt(0, spots.length - 1)];
      var x = map.xOf(idx), y = map.yOf(idx);
      var dist = U.dist(pawn.x, pawn.y, x, y);
      if (dist > FISH_RANGE || dist >= bestD) continue;
      var target = T.cell(x, y);
      if (Res && Res.reservedBy && Res.reservedBy(map, target)) continue;
      if (Path && Path.reachable && !Path.reachable(map, pawn.x, pawn.y, x, y, { pawn: pawn })) continue;
      best = target; bestD = dist;
    }
    if (!best) return null;
    if (Res && !Res.reserve(pawn, best, 1)) return null;
    var job = Jobs.make('fish', best, null, {});
    if (!job && Res) Res.release(pawn, best);
    return job;
  }

  Ecology.installWork = function () {
    if (_installed) return true;
    var W = sys('WorkGivers');
    if (!W || !W.register || !Jobs || !Jobs.isRegistered || !Jobs.isRegistered('fish')) return false;
    _installed = true;
    try {
      W.register({
        id: 'ecologyFish', workType: 'fish', order: 20, label: 'fish',
        tryGiveJob: fishJobFor
      });
    } catch (e) {
      if (debug()) console.log('[ecology] work giver refused: ' + (e && e.message));
      return false;
    }
    installIncidents();
    return true;
  };

  /* events.js loads after this file, so its registry is only there once
     the game is running. Registering from the first tick is the same
     thing a beat later. */
  function installIncidents() {
    var I = sys('Incidents');
    if (!I || !I.register || state._incidents) return;
    state._incidents = true;
    I.register({
      id: 'herdMigration', label: 'herd migration', category: 'good', minDay: 4,
      weight: function () {
        var G = game();
        var s = G && G.season ? G.season() : 'spring';
        return (s === 'spring' || s === 'fall') ? 1.1 : 0.25;
      },
      fire: function (g) {
        var map = g && g.map;
        if (!map) return false;
        var pool = [];
        for (var id in SPECIES) {
          var rec = SPECIES[id];
          if (rec.role !== 'grazer' && rec.role !== 'browser') continue;
          if (!inBiome(rec)) continue;
          pool.push(id);
        }
        if (!pool.length) return false;
        var id2 = U.pick(pool);
        var spot = edgeSpot(map);
        if (!spot) return false;
        var born = spawnNear(map, id2, spot.x, spot.y, U.randInt(4, 7));
        if (!born.length) return false;
        state.arrived[id2] = (state.arrived[id2] || 0) + born.length;
        letter('A herd is passing through',
          born.length + ' ' + labelOf(id2) + ' have crossed onto the map. They will not stay ' +
          'long, and that is a lot of meat walking past your door.', 'good', born[0]);
        return true;
      }
    });
    I.register({
      id: 'locustSwarm', label: 'locust swarm', category: 'threatSmall', minDay: 10,
      weight: function () {
        var G = game();
        return (G && G.season && G.season() === 'summer') ? 0.9 : 0;
      },
      fire: function (g) {
        var map = g && g.map;
        if (!map) return false;
        var spot = edgeSpot(map);
        if (!spot) return false;
        var born = spawnNear(map, 'locustSwarm', spot.x, spot.y, U.randInt(5, 9));
        if (!born.length) return false;
        state.swarmDay = g.day ? g.day() : 0;
        letter('Locusts',
          'A swarm has settled on the fields. Every standing crop they can reach is going to ' +
          'be stubble by nightfall.', 'threat', born[0]);
        return true;
      }
    });
  }

  /* Wildlife incidents in events.js pick from this list, so the species
     added here become manhunter packs and self-taming strays the same
     way the original six do. The apex predator is deliberately left out:
     it arrives on its own terms or not at all. */
  function shareWildKinds() {
    var A = sys('Animals');
    if (!A || !Array.isArray(A.wildKinds) || state._shared) return;
    state._shared = true;
    var add = ['gazelle', 'elk', 'bison', 'ibex', 'marmot', 'grouse',
      'jackal', 'lynx', 'panther', 'direwolf', 'vulture'];
    for (var i = 0; i < add.length; i++) {
      if (A.wildKinds.indexOf(add[i]) < 0) A.wildKinds.push(add[i]);
    }
  }

  /* ============================================================
     REPORTING - what the UI draws
     ============================================================ */

  Ecology.speciesList = function (map) {
    map = mapOf(map);
    var out = [];
    for (var id in SPECIES) {
      var rec = SPECIES[id];
      if (!inBiome(rec)) continue;
      var pop = Ecology.populationOf(map, id);
      var cap = map ? Ecology.capacityFor(map, id) : 0;
      out.push({
        id: id, label: labelOf(id), role: rec.role,
        population: pop, capacity: cap,
        taken: state.taken[id] || 0,
        born: state.born[id] || 0,
        starved: state.starved[id] || 0,
        migratory: !!rec.migrates,
        status: statusOf(pop, cap, rec)
      });
    }
    out.sort(function (a, b) { return b.population - a.population || (a.label < b.label ? -1 : 1); });
    return out;
  };

  function statusOf(pop, cap, rec) {
    if (rec.migrates && state.seasonSeen === 'winter') return 'migrated';
    if (cap < 0.5) return pop > 0 ? 'over capacity' : 'absent';
    if (!pop) return 'hunted out';
    if (pop > cap * 1.25) return 'over capacity';
    if (pop < cap * 0.4) return 'depleted';
    return 'steady';
  }

  Ecology.biomassReport = function (map) {
    map = mapOf(map);
    if (!map) return null;
    var d = derived(map);
    if (d.censusTick < 0) censusPlants(map);
    var b = budget(map);
    var soil = state.soilStats || { tracked: 0, exhausted: 0, resting: 0, worst: 1 };
    var G = game();
    return {
      biome: (G && G.biome) || state.biome,
      season: (G && G.season) ? G.season() : state.seasonSeen,
      plants: {
        biomass: Math.round(d.biomass),
        cover: d.cover,
        trees: d.treeCount || 0,
        seedTrees: d.seedTrees || 0,
        grazed: Math.round(b.grazeMean * 100) / 100,
        grazedWorst: Math.round((state.grazeWorst || 0) * 100) / 100,
        barePatches: state.grazeBare || 0,
        clearings: countClearings(d)
      },
      herbivores: {
        count: countRole(HERB_ROLES),
        biomass: Math.round((state.herbUnits || 0) * 10) / 10,
        capacity: Math.round(b.herbTotal * 10) / 10
      },
      predators: {
        count: countRole(MEAT_ROLES),
        biomass: Math.round((state.predUnits || 0) * 10) / 10,
        capacity: Math.round(b.predTotal * 10) / 10,
        pressure: Math.round((state.pressure || 0) * 100) / 100
      },
      fish: {
        stock: Math.round(state.fish.stock * 10) / 10,
        capacity: state.fish.cap,
        caught: state.fish.caught,
        fishing: shouldFish(map)
      },
      soil: soil,
      species: Ecology.speciesList(map),
      policy: state.policy,
      log: state.log.slice(-10),
      notes: adviceFor(map, d, b, soil)
    };
  };

  function countRole(table) {
    var n = 0;
    for (var id in state.pop) {
      var rec = eco(id);
      if (rec && table[rec.role]) n += state.pop[id];
    }
    return n;
  }

  function countClearings(d) {
    var n = 0;
    for (var i = 0; i < d.n; i++) if (d.trees[i] === 0 && d.seeds[i] === 0 && d.felled[i] > 0.2) n++;
    return n;
  }

  /* The sentences the panel prints. Each one names a decision the
     player made and what it is doing to the map. */
  function adviceFor(map, d, b, soil) {
    var out = [];
    if (b.grazeMean > 0.35) {
      out.push('The whole map is grazed hard. Cull the herds or the pasture will not come back ' +
        'before winter.');
    } else if ((state.grazeBare || 0) > 2) {
      out.push((state.grazeBare || 0) + ' patches have been eaten down to dirt and will not ' +
        'reseed while the herds are still standing on them.');
    }
    if ((state.pressure || 0) > 1.6) {
      out.push('There is not enough game left to feed the predators on this map.');
    }
    if (d.seedTrees === 0 && d.treeCount === 0) {
      out.push('Every tree is gone and there is nothing left to seed a new one. This map will ' +
        'not grow wood again.');
    } else if (d.seedTrees < 4) {
      out.push('Only ' + d.seedTrees + ' mature ' + U.plural(d.seedTrees, 'tree') + ' left to ' +
        'seed from. Leave some standing or the woods will not regrow.');
    }
    if (soil.exhausted > 4) {
      out.push(soil.exhausted + ' field cells are worn out. Rotate the crop or leave them fallow.');
    }
    if (state.fish.cap && state.fish.stock < state.fish.cap * 0.3) {
      out.push('The fishery is down to ' + Math.round(100 * state.fish.stock / state.fish.cap) +
        '% of what the water carries.');
    }
    if (!out.length) out.push('The map is carrying what it can carry.');
    return out;
  }

  /* What a player should sow next in a given cell, given what has been
     grown there. Cheap enough for a tooltip. */
  Ecology.rotationAdvice = function (map, x, y) {
    map = mapOf(map);
    if (!map || !map.inBounds(x, y)) return null;
    var r = state.soil[map.idx(x, y)];
    if (!r) return { fertility: 1, advice: 'This ground has not been farmed.' };
    var last = r[1];
    var best = null, bestDrain = Infinity;
    for (var id in CROP_DRAIN) {
      if (id === last) continue;
      if (!Defs.has('thing', id)) continue;
      if (CROP_DRAIN[id] < bestDrain) { bestDrain = CROP_DRAIN[id]; best = id; }
    }
    var advice;
    if (r[0] >= 0.95) advice = 'Good ground. Anything will take.';
    else if (r[0] < SOIL_EXHAUSTED) {
      advice = 'Worn out. Leave it empty for a season, or sow ' +
        (best ? labelOf2(best) : 'something else') + '.';
    } else if (r[2] >= 2) {
      advice = 'Same crop ' + r[2] + ' times running. Rotate to ' +
        (best ? labelOf2(best) : 'another crop') + '.';
    } else advice = 'Holding up.';
    return { fertility: Math.round(r[0] * 100) / 100, lastCrop: last, streak: r[2], advice: advice };
  };

  function labelOf2(thingId) {
    var d = Defs.maybe('thing', thingId);
    return (d && d.label) || thingId;
  }

  Ecology.setPolicy = function (opts) {
    if (!opts) return state.policy;
    for (var k in opts) {
      if (state.policy[k] !== undefined) state.policy[k] = opts[k];
    }
    return state.policy;
  };
  Ecology.policy = function () { return state.policy; };

  /* ============================================================
     SAVE / LOAD
     ============================================================ */

  Ecology.save = function () {
    var soil = [];
    for (var key in state.soil) {
      var r = state.soil[key];
      soil.push([key | 0, Math.round(r[0] * 1000) / 1000, r[1], r[2], Math.round(r[3] * 100) / 100, r[4] || 0]);
    }
    return {
      v: 1,
      beat: state.beat,
      lastTick: state.lastTick,
      biome: state.biome,
      taken: state.taken, born: state.born, starved: state.starved,
      arrived: state.arrived, left: state.left,
      soil: soil,
      fish: { stock: state.fish.stock, cap: state.fish.cap, caught: state.fish.caught, seeded: state.fish.seeded },
      seasonSeen: state.seasonSeen,
      apexDay: state.apexDay, swarmDay: state.swarmDay,
      predatorRaidDay: state.predatorRaidDay,
      policy: state.policy,
      log: state.log.slice(-20)
    };
  };

  Ecology.load = function (obj) {
    Ecology.reset();
    if (!obj || typeof obj !== 'object') return false;
    state.beat = obj.beat | 0;
    state.lastTick = obj.lastTick | 0;
    if (obj.biome) state.biome = obj.biome;
    ['taken', 'born', 'starved', 'arrived', 'left'].forEach(function (k) {
      if (obj[k] && typeof obj[k] === 'object') state[k] = obj[k];
    });
    if (Array.isArray(obj.soil)) {
      for (var i = 0; i < obj.soil.length; i++) {
        var row = obj.soil[i];
        if (!row || row.length < 4) continue;
        state.soil[row[0] | 0] = [
          U.clamp(+row[1] || 1, SOIL_MIN, SOIL_MAX),
          typeof row[2] === 'string' ? row[2] : '',
          row[3] | 0,
          +row[4] || 0,
          row[5] ? 1 : 0
        ];
      }
    }
    if (obj.fish) {
      state.fish.stock = +obj.fish.stock || 0;
      state.fish.cap = obj.fish.cap | 0;
      state.fish.caught = obj.fish.caught | 0;
      state.fish.seeded = !!obj.fish.seeded;
    }
    state.seasonSeen = obj.seasonSeen || '';
    state.apexDay = obj.apexDay === undefined ? -99 : obj.apexDay;
    state.swarmDay = obj.swarmDay === undefined ? -99 : obj.swarmDay;
    state.predatorRaidDay = obj.predatorRaidDay === undefined ? -99 : obj.predatorRaidDay;
    if (obj.policy) Ecology.setPolicy(obj.policy);
    if (Array.isArray(obj.log)) state.log = obj.log.slice(-40);
    _loaded = true;
    _map = null;
    return true;
  };

  /* ============================================================
     THE TICK

     game.js lists this under its slow tickers and calls it with the
     game rather than the map, while the contract's signature is
     tick(map, game). Both are accepted: whichever object arrived,
     the other is derived from it.
     ============================================================ */

  function mapOf(x) {
    if (!x) return _map || (root.Game ? root.Game.map : null);
    if (x.terrain && x.pawns) return x;
    if (x.map) return x.map;
    return _map;
  }

  function attach(map) {
    if (_map === map) return;
    if (!_loaded) {
      /* A brand new colony, not a restored one: everything the old map
         remembered is about ground that no longer exists. The player's
         own settings are theirs and survive. */
      var keepPolicy = state.policy;
      Ecology.reset();
      state.policy = keepPolicy;
    }
    _loaded = false;
    _map = map;
    var G = game();
    state.biome = (G && G.biome) || state.biome;
    state.seasonSeen = (G && G.season) ? G.season() : state.seasonSeen;
    derived(map);
    censusPlants(map);
    state.fish.cap = fishCap(map);
    if (!state.fish.seeded) {
      state.fish.stock = state.fish.cap * U.randRange(0.7, 0.95);
      state.fish.seeded = true;
    }
  }

  Ecology.tick = function (map, game_) {
    var g = (map && map.doTick) ? map : (game_ || root.Game);
    map = mapOf(map) || (g && g.map);
    if (!map || !map.pawns) return;

    attach(map);
    shareWildKinds();
    Ecology.installWork();

    var tick = now();
    var elapsed = state.lastTick ? (tick - state.lastTick) : SLOW;
    if (elapsed <= 0 || elapsed > SLOW * 40) elapsed = SLOW;
    state.lastTick = tick;
    var days = elapsed / TICKS_PER_DAY;

    var previous = state.pop;
    censusAnimals(map);
    reconcile(previous);

    state.beat = (state.beat + 1) % PHASES;
    switch (state.beat) {
      case 0:
        censusPlants(map);
        swarmDamage(map, days * PHASES);
        break;
      case 1:
        tickPopulations(map, days * PHASES);
        tickImmigration(map, days * PHASES);
        break;
      case 2:
        if (!seasonTurned(map)) {
          tickApex(map, days * PHASES);
          tickSwarm(map, days * PHASES);
        }
        tickGrazing(map, days * PHASES);
        break;
      default:
        tickSoil(map, days * PHASES);
        tickRegrowth(map, days * PHASES);
        break;
    }
    tickFish(map, days);
  };

  /* A one-line summary for a tooltip or a debug overlay. */
  Ecology.summary = function (map) {
    map = mapOf(map);
    if (!map) return 'no map';
    var b = budget(map);
    return 'plants ' + Math.round(b.plant) +
      ' · herbivores ' + countRole(HERB_ROLES) + '/' + Math.round(b.herbTotal) +
      ' · predators ' + countRole(MEAT_ROLES) +
      ' · fish ' + Math.round(state.fish.stock) + '/' + state.fish.cap +
      ' · grazed ' + U.pct(b.grazeMean);
  };

  Ecology.SPECIES = SPECIES;
  Ecology.CROP_DRAIN = CROP_DRAIN;

  root.Ecology = Ecology;
})(this);
