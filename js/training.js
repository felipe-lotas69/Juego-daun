/* ============================================================
   training.js - Husbandry: everything that happens to an animal
   after it is tame.

   animals.js owns the wild: what a beast decides to do, how it is
   hunted, how it is tamed and how it dies. The moment it belongs to
   the colony it becomes livestock, and livestock is a different game.
   Four ideas run through this file.

   A trained animal is not a flag, it is a maintained thing. Every
   discipline has steps and every step rots if nobody keeps it up, so
   a handler is a standing job rather than a one-off errand. The decay
   is slower for an animal that is bonded to its handler, which is why
   a colony with one good animal handler is worth more than a colony
   with four indifferent ones.

   A herd is a population, not a pile. Animals have a sex, a gestation,
   a growth curve from newborn to adult and a lifespan, and they carry
   a heritable stock value that shifts a little each generation. Feed
   them and the herd grows; feed them badly and it eats its own pasture
   down to the dirt and then starves on it.

   Everything this file writes onto a pawn lives under pawn.husbandry
   and is numbers, strings and plain objects only, so save.js carries it
   through a round trip without knowing anything about it. Pens are the
   one piece of world state, and they hang off a building - a pen marker
   - rather than off a table here, which is what lets them save for free
   and be deleted with a deconstruct order.

   What is here that the game this borrows from does not have is marked
   with a BEYOND comment: heritable stock and selective breeding, the
   dam-and-calf weaning bond, condition-scaled produce yields, and
   pasture pressure that actually ruins a pen.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;
  var Jobs = root.Jobs, Toils = root.Toils, T = root.T, Res = root.Res;

  var Husbandry = {};

  /* ---------- tuning ----------
     Rates written per day are divided by 60000 where they are used. */
  var TICKS_PER_DAY = 60000;
  var RARE = 250;                   /* the beat every per-animal update runs on   */
  var SLOW = 2500;                  /* pens, pasture and the slaughter policy     */

  var TRAIN_WORK_BASE = 220;        /* work units in one lesson, before wildness  */
  var DECAY_DAYS_PER_STEP = 4.0;    /* an unhandled animal forgets this fast      */
  var BOND_DECAY_FACTOR = 2.2;      /* a bonded animal forgets much more slowly   */
  var BOND_CHANCE_BASE = 0.010;     /* per finished interaction, before skill     */
  var BOND_MAX_PER_HANDLER = 4;
  var PET_JOY = 0.10;

  var TAME_CAP = 40;                /* hard ceiling on player-owned livestock     */
  var PEN_MAX_CELLS = 900;          /* a pen bigger than this is not a pen        */
  var PEN_TTL = SLOW;               /* how long a pen's flood fill is trusted     */
  var STRAY_FERAL_DAYS = 2.2;       /* loose livestock goes feral after this long */
  var TROUGH_CAPACITY = 12;         /* nutrition units a trough holds             */
  var TROUGH_RESTOCK_AT = 0.45;
  var TROUGH_RANGE = 26;            /* how far an animal will walk to a trough    */
  var STARVING_AT = 0.16;

  var HAUL_MIN_FOOD = 0.35;         /* a hungry animal works for itself first     */
  var FLOCK_MIN_DAY = 3;            /* before this no wild flock wanders in       */

  /* ============================================================
     CONTENT

     Registration only - nothing below runs until the game ticks.
     def_things.js and def_pawns.js are frozen, so everything this
     system needs that they do not already carry is added here under
     ids of its own.
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

  /* The full building block def_things.js hands every building, copied
     because that file's helper is private to it and power.js, jobs.js
     and render.js all read these fields without a guard. */
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
      turretRange: 0, turretWeapon: null, interactionOffset: null,
      openTicks: 0
    };
    if (o) for (var k in o) out[k] = o[k];
    return out;
  }

  var BUILDING = {};
  for (var _ik in ITEM) BUILDING[_ik] = ITEM[_ik];
  BUILDING.category = 'building';
  BUILDING.sprite = 'box';
  BUILDING.stackLimit = 1;
  BUILDING.mass = 20;
  BUILDING.marketValue = 0;
  BUILDING.hp = 120;
  BUILDING.passable = false;
  BUILDING.fillPercent = 1;
  BUILDING.flammable = false;
  BUILDING.buildSkill = 'construction';
  BUILDING.building = null;

  /* ---------- produce and feed ---------- */
  Defs.add('thing', {

    milk: {
      label: 'milk',
      description: 'A pail of fresh milk. Drinkable as it is, worth far more turned into ' +
        'cheese, and it will not keep for long either way.',
      sprite: 'item', color: '#efe9dc', color2: '#cdc6b4',
      stackLimit: 75, mass: 0.05, marketValue: 1.4,
      nutrition: 0.05, foodType: 'animal', rotDays: 8, hp: 40
    },

    wool: {
      label: 'wool',
      description: 'Raw fleece off a muffalo. Woven into cloth at a tailoring bench, and warm ' +
        'enough on its own that shearing day is worth planning for.',
      sprite: 'cloth', color: '#d9d2c4', color2: '#b6ae9c',
      stackLimit: 75, mass: 0.07, marketValue: 2.4, hp: 50
    },

    eggs: {
      label: 'eggs',
      description: 'Unfertilised eggs. A hen lays them wherever she happens to be standing, ' +
        'which is the whole argument for a pen.',
      sprite: 'item', color: '#efe3c8', color2: '#d4c49c',
      stackLimit: 50, mass: 0.1, marketValue: 2.2,
      nutrition: 0.25, rotDays: 12, hp: 30
    },

    hay: {
      label: 'hay',
      description: 'Dried fodder. Nothing a colonist would touch unless it came to that, and ' +
        'the difference between a herd that winters and a herd that does not.',
      sprite: 'item', color: '#c9b464', color2: '#a08f45',
      stackLimit: 75, mass: 0.06, marketValue: 0.6,
      nutrition: 0.05, foodType: 'animal', rotDays: 40, hp: 30, flammable: true
    },

    cheese: {
      label: 'cheese',
      description: 'Pressed and salted. It keeps for two months in a cool room, which makes a ' +
        'dairy herd a way of storing summer.',
      sprite: 'meal', color: '#e8c87a', color2: '#c39f4c',
      stackLimit: 50, mass: 0.2, marketValue: 11,
      nutrition: 0.3, rotDays: 60, hp: 40
    },

    mealEgg: {
      label: 'fried meal',
      description: 'Eggs fried with whatever came out of the field. Cheap, fast, and a proper ' +
        'meal by the time it reaches the table.',
      sprite: 'meal', color: '#f0d27a', color2: '#b8823f',
      stackLimit: 10, mass: 0.4, marketValue: 22,
      nutrition: 0.9, foodType: 'meal', rotDays: 5, hp: 50
    }

  }, ITEM);

  /* ---------- the buildings a herd needs ---------- */
  Defs.add('thing', {

    fence: {
      label: 'fence',
      description: 'A low run of rails. It will not stop a raider and it holds no roof, but it ' +
        'holds a muffalo, and it costs a third of a wall.',
      sprite: 'sandbags', color: '#a9783f', color2: '#7b5427',
      hp: 80, mass: 8, flammable: true,
      passable: false, fillPercent: 0.35, blocksLight: false, holdsRoof: false,
      beauty: 0, stuffable: true, buildCost: { wood: 3 }, workToBuild: 70,
      buildCategory: 'structure',
      building: bld({})
    },

    penMarker: {
      label: 'pen marker',
      description: 'A post that says the enclosure around it is a pen. Livestock assigned to it ' +
        'stay inside; if the fence has a gap, the marker says so.',
      sprite: 'spot', color: '#8a6134', color2: '#c9b464',
      hp: 45, mass: 4, flammable: true,
      passable: true, pathCost: 0, fillPercent: 0, blocksLight: false,
      buildCost: { wood: 10 }, workToBuild: 140,
      buildCategory: 'misc',
      building: bld({})
    },

    trough: {
      label: 'feed trough',
      description: 'A long wooden trough. Haul hay or kibble into it and the herd eats through ' +
        'winter without a colonist carrying every mouthful.',
      sprite: 'box', color: '#8a6134', color2: '#5f4425',
      hp: 110, mass: 24, flammable: true,
      passable: true, pathCost: 8, fillPercent: 0.3, blocksLight: false,
      beauty: -1, buildCost: { wood: 25 }, workToBuild: 240,
      buildCategory: 'furniture',
      building: bld({})
    }

  }, BUILDING);

  /* ---------- fodder in the ground ---------- */
  Defs.add('thing', {
    plantHaygrass: {
      label: 'haygrass',
      description: 'A coarse fodder grass. Useless on a plate and unbeatable in a trough: one ' +
        'field of it carries a herd through a winter that would otherwise eat the pasture bare.',
      category: 'plant',
      color: '#8b9a45', color2: '#b6b761', sprite: 'crop',
      flammable: 1.0, hp: 40, pathCost: 1, nutrition: 0.28,
      passable: true, blocksLight: false, stackLimit: 1, mass: 1,
      beauty: 0, marketValue: 0, buildCategory: null, buildCost: null, workToBuild: 0,
      plant: {
        growDays: 3.2, lifespanDays: 30,
        harvestedThing: 'hay', harvestYield: 18, harvestWork: 140,
        harvestMinGrowth: 1.0, harvestDestroys: true, regrowsTo: 0,
        sowable: true, sowWork: 140, sowTags: ['field'], sowMinSkill: 0,
        minFertility: 0.35, fertilitySensitivity: 0.7,
        minGrowthTemp: 0, maxGrowthTemp: 58, minLightToGrow: 0.51,
        wildDensity: 0, wildBiomes: null, wildCluster: [1, 1],
        isTree: false, dieIfLeafless: true, blightable: true,
        visualSizeRange: [0.5, 0.95]
      }
    }
  }, ITEM);

  /* ---------- a bird, because eggs need one ----------
     def_pawns.js registers a bird body and no bird. A flock wanders onto
     the map on its own once the colony has been standing a few days;
     taming one is the ordinary tame job, and after that it is the
     cheapest protein a colony can own. */
  Defs.add('pawnKind', {
    chicken: {
      label: 'chicken',
      description: 'A scruffy ground bird. Lays every few hours, eats anything, and panics at ' +
        'its own shadow.',
      race: 'animal', isAnimal: true, body: 'bird', defaultFaction: 'wild',
      techLevel: 'animal', sprite: 'chicken',
      combatPower: 8,
      baseHealthScale: 0.25, healthScale: 0.25,
      baseBodySize: 0.25, bodySize: 0.25, drawSize: 0.7,
      moveSpeed: 4.0, moveSpeedFactor: 1,
      baseHungerRate: 0.9, hungerRateFactor: 0.5,
      lifeExpectancyYears: 6, ageRange: [0.3, 4],
      wildness: 0.25, trainability: 'none', packSize: [3, 6],
      meleeDamage: 2, meleeDamageType: 'blunt', meleeCooldownTicks: 140, meleeSkill: 0,
      meleeArmorPen: 0,
      butcherProducts: { meatRaw: 12 }, leatherAmount: 0,
      color: '#e2d6bd', color2: '#c0392b',
      comfyTempMin: -8, comfyTempMax: 40,
      armorSharp: 0, armorBlunt: 0, armorHeat: 0,
      diet: 'omnivore', predator: false, grazer: true, nocturnal: false,
      packAnimal: false, breeds: true, nuzzles: true,
      manhunterChance: 0, revengeChance: 0, manhunterOnTameFail: 0,
      explodeOnDeath: false, explodes: false,
      weapons: [], apparel: []
    }
  });

  /* ---------- what a handler feels about all this ---------- */
  Defs.add('thought', {
    bondedAnimal: {
      label: 'Bonded animal', durationDays: 0.6,
      stages: [{ label: 'Bonded animal nearby', mood: 4 }]
    },
    bondedAnimalDied: {
      label: 'Bonded animal died', durationDays: 20, stackLimit: 3,
      stages: [{ label: 'My bonded animal died', mood: -14 }],
      nullifiedByTrait: ['psychopath']
    },
    bondedMasterDied: {
      label: 'Bonded master died', durationDays: 15, stackLimit: 2,
      stages: [{ label: 'My person is gone', mood: -20 }]
    },
    pettedAnimal: {
      label: 'Petted an animal', durationDays: 0.5, stackLimit: 2,
      stages: [{ label: 'Spent time with an animal', mood: 3 }]
    },
    newbornAnimal: {
      label: 'New life in the herd', durationDays: 1.5, stackLimit: 2,
      stages: [{ label: 'A newborn arrived', mood: 2 }]
    },
    livestockStarved: {
      label: 'Livestock starved', durationDays: 4, stackLimit: 3,
      stages: [{ label: 'We let an animal starve', mood: -5 }]
    }
  });

  /* ---------- what the produce turns into ---------- */
  Defs.add('recipe', {
    makeCheese: {
      label: 'cheese', jobString: 'Pressing cheese', uiCategory: 'cooking',
      workAmount: 450, skill: 'cooking', workType: 'cook',
      workbenches: ['stove'],
      ingredients: [{ thing: 'milk', count: 8 }],
      products: { cheese: 3 },
      defaultRepeat: 'untilHave', defaultTargetCount: 30,
      description: 'Eight pails into three wheels. Cheese keeps sixty days where milk keeps eight.'
    },
    cookEggMeal: {
      label: 'fried meal', jobString: 'Frying', uiCategory: 'cooking',
      workAmount: 300, skill: 'cooking', workType: 'cook',
      workbenches: ['stove', 'campfire'],
      ingredients: [{ thing: 'eggs', count: 3 },
        { anyOf: ['riceRaw', 'potatoRaw', 'cornRaw', 'berries'], count: 6 }],
      products: { mealEgg: 1 }, foodPoisonChance: 0.015,
      defaultRepeat: 'untilHave', defaultTargetCount: 20,
      description: 'Eggs and whatever came out of the field. A proper meal for the price of a hen.'
    },
    weaveWool: {
      label: 'weave wool', jobString: 'Weaving', uiCategory: 'tailoring',
      workAmount: 520, skill: 'crafting', workType: 'craft',
      workbenches: ['tailoringBench'],
      ingredients: [{ thing: 'wool', count: 30 }],
      products: { cloth: 26 },
      defaultRepeat: 'untilHave', defaultTargetCount: 150,
      description: 'Fleece into cloth. A sheared herd is a cotton field that walks itself home.'
    }
  });

  /* ============================================================
     SPECIES DATA

     def_pawns.js states body size, wildness, trainability and diet, and
     animals.js merges those into one view; everything below is what a
     livestock system needs on top and nothing else asks about. A kind
     that is not listed is filled in from its body size, so a species
     added later still breeds, grows and dies of old age.
     ============================================================ */

  var KINDS = {
    hare: { gestDays: 4, litter: [2, 5], matureYears: 0.5, lifeYears: 6 },
    deer: { gestDays: 9, litter: [1, 2], matureYears: 1.0, lifeYears: 10 },
    muffalo: {
      gestDays: 16, litter: [1, 1], matureYears: 1.5, lifeYears: 20,
      produce: {
        milk: { item: 'milk', amount: 11, days: 1.0, femaleOnly: true, work: 300, verb: 'milk' },
        wool: { item: 'wool', amount: 45, days: 9, work: 520, verb: 'shear' }
      }
    },
    boomrat: { gestDays: 4, litter: [2, 4], matureYears: 0.5, lifeYears: 8 },
    wolf: { gestDays: 8, litter: [1, 3], matureYears: 1.0, lifeYears: 12 },
    bear: { gestDays: 12, litter: [1, 2], matureYears: 1.5, lifeYears: 22 },
    chicken: {
      gestDays: 1.2, litter: [2, 4], matureYears: 0.3, lifeYears: 6,
      produce: {
        eggs: { item: 'eggs', amount: 1, days: 0.55, femaleOnly: true, auto: true, verb: 'collect' }
      }
    }
  };

  var _kind = {};

  /* The merged view of a species. Memoised: defs never change once the
     game is running, and this is read on every animal's rare tick. */
  function kindOf(kindId) {
    var got = _kind[kindId];
    if (got) return got;
    var A = root.Animals;
    var base = (A && A.info) ? A.info(kindId) : null;
    var size = (base && base.bodySize) || 0.7;
    var out = {
      id: kindId,
      label: (base && base.label) || kindId,
      bodySize: size,
      wildness: (base && typeof base.wildness === 'number') ? base.wildness : 0.6,
      trainability: (base && base.trainability) || 'none',
      predator: !!(base && base.predator),
      breeds: true,
      gestDays: 3 + size * 6,
      litter: size > 1.2 ? [1, 1] : [1, 3],
      matureYears: U.clamp(0.3 + size * 0.6, 0.3, 2),
      lifeYears: 6 + size * 6,
      produce: null
    };
    var table = KINDS[kindId];
    if (table) for (var k in table) out[k] = table[k];
    var def = Defs.maybe('pawnKind', kindId);
    if (def) {
      if (typeof def.lifeExpectancyYears === 'number') out.lifeYears = def.lifeExpectancyYears;
      if (def.breeds === false) out.breeds = false;
      /* A kind def may state its own produce table; if it ever does, it
         wins, exactly the way animals.js lets a def override its table. */
      if (def.produce) out.produce = def.produce;
    }
    if (base && base.breeds === false && !KINDS[kindId]) out.breeds = false;
    _kind[kindId] = out;
    return out;
  }
  Husbandry.kind = kindOf;

  /* ============================================================
     SMALL SHARED HELPERS
     ============================================================ */

  function sys(name) { return root[name] || null; }

  function now() {
    var G = root.Game;
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  function msg(text, type, at) {
    var G = root.Game;
    if (G && G.msg) G.msg(text, { type: type || 'info', x: at ? at.x : undefined, y: at ? at.y : undefined });
  }

  function letter(title, text, kind, at) {
    var G = root.Game;
    if (G && G.letter) G.letter(title, text, { kind: kind || 'neutral', x: at ? at.x : undefined, y: at ? at.y : undefined });
    else msg(title, 'info', at);
  }

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    if (pawn.name) {
      if (pawn.name.nick) return pawn.name.nick;
      var full = ((pawn.name.first || '') + ' ' + (pawn.name.last || '')).trim();
      if (full) return full;
    }
    return kindOf(pawn.kindId).label;
  }
  Husbandry.nameOf = nameOf;

  function skillLevel(pawn, id) {
    var s = pawn && pawn.skills && pawn.skills[id];
    return (s && typeof s.level === 'number') ? s.level : 0;
  }

  function workRate(pawn, skillId) {
    var H = sys('Health');
    var f = (H && H.workSpeedFactor) ? H.workSpeedFactor(pawn) : 1;
    return (0.4 + 0.08 * skillLevel(pawn, skillId)) * f;
  }

  function gainSkill(pawn, skillId, xp) {
    if (!pawn || !pawn.skills || !(xp > 0)) return;
    if (typeof pawn.learn === 'function') { pawn.learn(skillId, xp); return; }
    var s = pawn.skills[skillId];
    if (!s) return;
    s.xp = (s.xp || 0) + xp;
    while (s.xp >= 1000 * (s.level + 1) && s.level < 20) {
      s.xp -= 1000 * (s.level + 1);
      s.level++;
    }
  }

  function thought(pawn, id, opts) {
    var N = sys('Needs');
    if (N && N.addThought && pawn && pawn.thoughts) N.addThought(pawn, id, opts);
  }

  /* A pawn id lookup that is rebuilt at most once per tick. Bond and
     master checks run for every animal on the rare beat, and a linear
     scan each time is the kind of cost that only shows up at forty
     animals and three raids. */
  function pawnById(map, id) {
    if (!map || !id) return null;
    var stamp = now();
    if (!(map.__husIndex instanceof Map) || map.__husIndexTick !== stamp ||
        map.__husIndexN !== map.pawns.length) {
      var idx = new Map();
      for (var i = 0; i < map.pawns.length; i++) idx.set(map.pawns[i].id, map.pawns[i]);
      map.__husIndex = idx;
      map.__husIndexTick = stamp;
      map.__husIndexN = map.pawns.length;
    }
    return map.__husIndex.get(id) || null;
  }

  function livePawn(map, id) {
    var p = pawnById(map, id);
    return (p && !p.dead) ? p : null;
  }

  function isLivestock(pawn) {
    return !!(pawn && pawn.isAnimal === true && !pawn.dead && pawn.tame === true &&
      pawn.faction === 'player');
  }
  Husbandry.isLivestock = isLivestock;

  function foodOf(pawn) {
    return (pawn.needs && typeof pawn.needs.food === 'number') ? pawn.needs.food : 1;
  }

  function freeCellNear(map, x, y, radius) {
    if (!map) return null;
    var ring = U.cellsInRadius(x, y, radius || 3);
    for (var i = 0; i < ring.length; i++) {
      var cx = ring[i][0], cy = ring[i][1];
      if (map.inBounds(cx, cy) && map.passable(cx, cy)) return { x: cx, y: cy };
    }
    return null;
  }

  /* ============================================================
     PER-PAWN STATE

     One plain field, created on demand, holding nothing but numbers,
     strings, arrays and plain objects. save.js copies it wholesale and
     hands it back the same shape.
     ============================================================ */

  function hus(pawn) {
    var h = pawn.husbandry;
    if (h) return h;
    if (pawn.isAnimal === true) {
      h = pawn.husbandry = {
        beat: 0,                 /* tick of the last rare update            */
        train: { obedience: 0, release: 0, rescue: 0, haul: 0 },
        wear: { obedience: 0, release: 0, rescue: 0, haul: 0 },
        lesson: '', learn: 0,    /* the discipline being taught and its work */
        bondId: 0, bondTick: 0,
        familiar: 0,             /* 0..1, how used to handlers it is         */
        penId: 0, strayTicks: 0,
        preg: null,
        damId: 0, weaned: 0, bornTick: -1,
        stock: 1,                /* heritable quality, 0.6..1.5             */
        produce: {},
        gathered: 0, hunger: 0,
        starveNote: 0
      };
    } else {
      h = pawn.husbandry = { beat: 0, bonds: [], pets: 0 };
    }
    return h;
  }
  Husbandry.state = hus;

  /* An animal born before this file was loaded, tamed by animals.js or
     restored from a save written by an older build still has to answer
     every question below, so the shape is topped up rather than trusted. */
  function beast(pawn) {
    var h = hus(pawn);
    if (!h.train) h.train = { obedience: 0, release: 0, rescue: 0, haul: 0 };
    if (!h.wear) h.wear = { obedience: 0, release: 0, rescue: 0, haul: 0 };
    if (!h.produce) h.produce = {};
    if (typeof h.stock !== 'number') h.stock = 1;
    if (h.preg && typeof h.preg.left !== 'number') h.preg = null;
    return h;
  }

  /* ============================================================
     GROWTH, AGE AND DEATH BY TIME

     A newborn is a quarter of the animal an adult is: it eats less, it
     yields less, it cannot breed and it cannot be slaughtered for a full
     carcass. Everything scales off one number.
     ============================================================ */

  Husbandry.growth = function (animal) {
    if (!animal) return 1;
    var k = kindOf(animal.kindId);
    var age = animal.ageYears || 0;
    if (animal.ageTicks > 0) age = animal.ageTicks / (60 * 60000);
    return U.clamp(0.25 + 0.75 * (age / Math.max(0.15, k.matureYears)), 0.25, 1);
  };

  Husbandry.isAdult = function (animal) {
    var k = kindOf(animal.kindId);
    return (animal.ageYears || 0) >= k.matureYears;
  };

  Husbandry.lifeStage = function (animal) {
    var k = kindOf(animal.kindId);
    var age = animal.ageYears || 0;
    if (age < k.matureYears * 0.45) return 'newborn';
    if (age < k.matureYears) return 'juvenile';
    if (age > k.lifeYears * 0.85) return 'old';
    return 'adult';
  };

  /* BEYOND: yields scale with condition as well as size. A half-starved
     muffalo gives half the milk, which turns "feed the herd" from an
     instruction into an economy. */
  Husbandry.yieldFactor = function (animal) {
    var h = beast(animal);
    return Husbandry.growth(animal) * (0.55 + 0.45 * foodOf(animal)) * U.clamp(h.stock, 0.5, 1.6);
  };

  function tickAge(animal, h, dt) {
    var k = kindOf(animal.kindId);
    var age = animal.ageYears || 0;
    if (age <= k.lifeYears) return false;
    /* Past its span an animal has a rising chance of simply not waking
       up. Spread over the rare beat so a herd does not die in one tick. */
    var over = (age - k.lifeYears) / Math.max(1, k.lifeYears * 0.35);
    var chance = U.clamp01(0.02 * over) * (dt / TICKS_PER_DAY);
    if (!U.chance(chance)) return false;
    killOfAge(animal);
    return true;
  }

  function killOfAge(animal) {
    var H = sys('Health');
    var label = nameOf(animal);
    if (H && H.kill) H.kill(animal, 'old age');
    else animal.dead = true;
    if (animal.faction === 'player') {
      msg(label + ' died of old age.', 'info', animal);
    }
  }

  /* ============================================================
     TRAINING

     Four disciplines. Obedience is the gate: nothing else can be taught
     until the animal will stand where it is told. Release, rescue and
     haul need an advanced mind, which is the difference between a
     muffalo and a wolf.
     ============================================================ */

  var DISCIPLINES = ['obedience', 'release', 'rescue', 'haul'];
  var STEPS = { obedience: 4, release: 6, rescue: 6, haul: 6 };
  var DISCIPLINE_LABEL = {
    obedience: 'obedience', release: 'release', rescue: 'rescue', haul: 'hauling'
  };

  Husbandry.DISCIPLINES = DISCIPLINES;
  Husbandry.STEPS = STEPS;

  /* 0 nothing, 1 obedience only, 2 the lot. animals.js answers the same
     question for the two disciplines it knows about, so it is asked
     first and this table is only the fallback. */
  Husbandry.trainability = function (kindId) {
    var A = sys('Animals');
    if (A && A.trainability) return A.trainability(kindId);
    var t = kindOf(kindId).trainability;
    if (t === 'advanced') return 2;
    if (t === 'intermediate') return 1;
    return 0;
  };

  Husbandry.canLearn = function (animal, discipline) {
    if (!animal || animal.isAnimal !== true || !animal.tame) return false;
    if (STEPS[discipline] === undefined) return false;
    var cap = Husbandry.trainability(animal.kindId);
    if (cap < 1) return false;
    if (discipline === 'obedience') return true;
    if (cap < 2) return false;
    return Husbandry.isTrained(animal, 'obedience');
  };

  Husbandry.steps = function (animal, discipline) {
    if (!animal || !animal.husbandry) return 0;
    var t = animal.husbandry.train;
    return (t && t[discipline]) || 0;
  };

  Husbandry.isTrained = function (animal, discipline) {
    return Husbandry.steps(animal, discipline) >= STEPS[discipline];
  };

  /* animals.js keeps the two disciplines it knows about on
     pawn.trainedLevels, and its own work giver reads them. Both files
     therefore have to agree: whatever either one taught last is the
     truth, and it is copied both ways on every rare tick. That is why
     the two trainers compose instead of fighting - animals.js teaches
     obedience and release, this file teaches all four and is the only
     one that knows they rot. */
  function syncLevels(animal, h) {
    var lv = animal.trainedLevels;
    if (!lv) { lv = animal.trainedLevels = { obedience: 0, release: 0 }; }
    ['obedience', 'release'].forEach(function (d) {
      var theirs = lv[d] || 0, mine = h.train[d] || 0;
      if (theirs > mine) h.train[d] = Math.min(theirs, STEPS[d]);
      else if (mine !== theirs) lv[d] = mine;
    });
  }

  /* What a handler should be working on: an unfinished discipline, or a
     finished one that has started to slip. A step of wear is worth
     topping up before it is lost, which is what keeps handlers busy in a
     colony whose animals are all "fully trained". */
  Husbandry.lessonFor = function (animal) {
    if (!isLivestock(animal)) return null;
    var h = beast(animal);
    var d, i;
    for (i = 0; i < DISCIPLINES.length; i++) {
      d = DISCIPLINES[i];
      if (!Husbandry.canLearn(animal, d)) continue;
      if (h.train[d] < STEPS[d]) return d;
    }
    for (i = 0; i < DISCIPLINES.length; i++) {
      d = DISCIPLINES[i];
      if (!h.train[d]) continue;
      if (h.wear[d] >= decayPerStep(animal) * 0.6) return d;
    }
    return null;
  };

  function decayPerStep(animal) {
    var k = kindOf(animal.kindId);
    var h = beast(animal);
    var days = DECAY_DAYS_PER_STEP / (0.6 + k.wildness);
    if (h.bondId) days *= BOND_DECAY_FACTOR;
    return days * TICKS_PER_DAY;
  }

  function tickTraining(animal, h, dt) {
    var per = decayPerStep(animal), d, i;
    for (i = 0; i < DISCIPLINES.length; i++) {
      d = DISCIPLINES[i];
      if (!h.train[d]) { h.wear[d] = 0; continue; }
      h.wear[d] += dt;
      if (h.wear[d] < per) continue;
      h.wear[d] = 0;
      h.train[d]--;
      if (h.train[d] === STEPS[d] - 1) {
        msg(nameOf(animal) + ' is forgetting its ' + DISCIPLINE_LABEL[d] + '.', 'info', animal);
      }
    }
  }

  /* One lesson's worth of work has been put in. Whether it takes is a
     roll against the animal's wildness, the handler's skill and, BEYOND
     the game this borrows from, whether the two of them are bonded: an
     animal learns markedly faster from the person it has chosen. */
  Husbandry.teach = function (animal, handler, discipline) {
    if (!isLivestock(animal) || !handler) return false;
    var h = beast(animal);
    if (!discipline) discipline = Husbandry.lessonFor(animal);
    if (!discipline) return false;
    var k = kindOf(animal.kindId);
    var bonded = h.bondId === handler.id;
    var odds = 0.26 + 0.055 * skillLevel(handler, 'animals') - k.wildness * 0.22;
    if (bonded) odds += 0.18;
    odds += (h.stock - 1) * 0.15;
    gainSkill(handler, 'animals', 55);
    h.familiar = U.clamp01(h.familiar + 0.06);
    if (!U.chance(U.clamp01(odds))) return false;

    if (h.train[discipline] >= STEPS[discipline]) {
      /* A top-up lesson on a discipline that is already full: what it
         buys is time, not a step. */
      h.wear[discipline] = 0;
      return true;
    }
    h.train[discipline]++;
    h.wear[discipline] = 0;
    syncLevels(animal, h);
    if (h.train[discipline] >= STEPS[discipline]) {
      msg(nameOf(animal) + ' learned ' + DISCIPLINE_LABEL[discipline] + '.', 'good', animal);
      if (discipline === 'haul' || discipline === 'rescue') {
        letter('Animal trained',
          nameOf(animal) + ' can now ' + (discipline === 'haul' ? 'haul for the colony' :
            'drag a downed colonist to a bed') + '.', 'good', animal);
      }
    }
    return true;
  };

  Husbandry.trainingSummary = function (animal) {
    if (!animal || animal.isAnimal !== true) return '';
    var h = beast(animal), out = [], i, d;
    for (i = 0; i < DISCIPLINES.length; i++) {
      d = DISCIPLINES[i];
      if (!Husbandry.canLearn(animal, d) && !h.train[d]) continue;
      out.push(DISCIPLINE_LABEL[d] + ' ' + h.train[d] + '/' + STEPS[d]);
    }
    return out.join(', ') || 'untrainable';
  };

  /* ============================================================
     BONDING

     A bond is one animal and one person. It is not given out by a
     button: it happens during handling, and once it exists it changes
     mood on both sides, sets the animal to follow, slows its training
     decay - and makes the death of either the worst day in the colony.
     ============================================================ */

  /* Husbandry.bond(animal) reads the bond; Husbandry.bond(animal, human)
     forms one. Both shapes are used by the UI and by this file. */
  Husbandry.bond = function (animal, human) {
    if (!animal || animal.isAnimal !== true) return null;
    var h = beast(animal);
    if (human === undefined) return h.bondId ? livePawn(animal.map, h.bondId) : null;
    if (!human) { Husbandry.unbond(animal); return null; }
    if (h.bondId === human.id) return human;
    if (h.bondId) Husbandry.unbond(animal);

    var hh = hus(human);
    if (!hh.bonds) hh.bonds = [];
    if (hh.bonds.indexOf(animal.id) < 0) hh.bonds.push(animal.id);
    h.bondId = human.id;
    h.bondTick = now();
    Husbandry.setMaster(animal, human);
    letter('A bond formed',
      nameOf(human) + ' and ' + nameOf(animal) + ' have bonded. ' + nameOf(animal) +
      ' will follow ' + nameOf(human) + ', learn faster from ' + nameOf(human) +
      ' than from anyone else, and neither of them will take the other dying well.',
      'good', animal);
    return human;
  };

  Husbandry.unbond = function (animal) {
    if (!animal || !animal.husbandry) return false;
    var h = animal.husbandry;
    if (!h.bondId) return false;
    var human = animal.map ? pawnById(animal.map, h.bondId) : null;
    if (human && human.husbandry && human.husbandry.bonds) {
      U.remove(human.husbandry.bonds, animal.id);
    }
    h.bondId = 0;
    return true;
  };

  Husbandry.bondedAnimals = function (human) {
    var out = [];
    if (!human || !human.husbandry || !human.husbandry.bonds || !human.map) return out;
    var ids = human.husbandry.bonds;
    for (var i = 0; i < ids.length; i++) {
      var a = livePawn(human.map, ids[i]);
      if (a) out.push(a);
    }
    return out;
  };

  Husbandry.masterOf = function (animal) {
    if (!animal || !animal.map || !animal.master) return null;
    return livePawn(animal.map, animal.master);
  };

  Husbandry.setMaster = function (animal, human) {
    if (!animal || animal.isAnimal !== true) return false;
    animal.master = human ? human.id : null;
    var A = sys('Animals');
    if (A && A.setMaster && animal.master !== (human ? human.id : null)) A.setMaster(animal, human);
    return true;
  };

  /* Rolled at the end of every interaction a handler finishes with an
     animal: a lesson, a milking, a shearing, a few minutes of company. */
  function tryBond(animal, handler, weight) {
    if (!animal || !handler || !isLivestock(animal)) return false;
    var h = beast(animal);
    if (h.bondId) return false;
    var hh = hus(handler);
    if (!hh.bonds) hh.bonds = [];
    if (hh.bonds.length >= BOND_MAX_PER_HANDLER) return false;
    var chance = (BOND_CHANCE_BASE + 0.0022 * skillLevel(handler, 'animals')) * (weight || 1);
    chance *= 0.6 + h.familiar;
    if (!U.chance(U.clamp01(chance))) return false;
    Husbandry.bond(animal, handler);
    return true;
  }

  /* The pair has to be looked at from both ends, because either can die
     in a way this file never hears about - a slaughter, a raid, a wolf,
     a cave-in. The sweep is the one place grief is fired. */
  function sweepBonds(map) {
    var pawns = map.pawns, i, j;
    for (i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      var h = p.husbandry;
      if (!h) continue;

      if (p.isAnimal === true) {
        if (!h.bondId || p.dead) continue;
        var human = pawnById(map, h.bondId);
        if (human && !human.dead) continue;
        h.bondId = 0;
        thought(p, 'bondedMasterDied');
        p.master = null;
        /* An animal that has lost its person is not itself for a while,
           and a wild-hearted one may simply leave. */
        if (U.chance(0.25 * kindOf(p.kindId).wildness)) goFeral(p, 'grief');
        continue;
      }

      if (!h.bonds || !h.bonds.length) continue;
      for (j = h.bonds.length - 1; j >= 0; j--) {
        var animal = pawnById(map, h.bonds[j]);
        if (animal && !animal.dead) continue;
        h.bonds.splice(j, 1);
        if (p.dead) continue;
        thought(p, 'bondedAnimalDied');
        letter('Bonded animal died',
          (animal ? nameOf(animal) : 'An animal') + ', bonded to ' + nameOf(p) + ', is dead.',
          'death', p);
      }
    }
  }

  /* ============================================================
     BREEDING

     A cycle, not a dice roll on a timer: a female in condition finds a
     male of her kind, carries for a species-specific span and drops a
     litter that grows up. animals.js ships a one-shot version of this
     for the wild; install() switches it off so births happen in exactly
     one place.
     ============================================================ */

  Husbandry.isPregnant = function (animal) {
    return !!(animal && animal.husbandry && animal.husbandry.preg);
  };

  Husbandry.pregnancy = function (animal) {
    return (animal && animal.husbandry && animal.husbandry.preg) || null;
  };

  function tameCount(map, kindId) {
    var n = 0, list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!isLivestock(p)) continue;
      if (kindId && p.kindId !== kindId) continue;
      n++;
    }
    return n;
  }
  Husbandry.tameCount = tameCount;

  function overCap(animal) {
    var map = animal.map;
    if (!map) return true;
    if (animal.faction === 'player') return tameCount(map) >= TAME_CAP;
    var A = sys('Animals');
    if (A && A.wildCount && A.wildCap) return A.wildCount(map) >= A.wildCap(map);
    return false;
  }

  function nearbyMate(animal, radius) {
    var map = animal.map, list = map.pawns, best = null, bestD = 1e9;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p === animal || p.dead || p.downed) continue;
      if (p.isAnimal !== true || p.kindId !== animal.kindId) continue;
      if (p.gender !== 'male' || p.faction !== animal.faction) continue;
      if (!Husbandry.isAdult(p)) continue;
      var d = U.distSq(animal.x, animal.y, p.x, p.y);
      if (d > radius * radius || d >= bestD) continue;
      best = p; bestD = d;
    }
    return best;
  }

  /* Starts a pregnancy. Returns true only when one actually began, so a
     caller can tell "not now" from "never". */
  Husbandry.tryBreed = function (female, male) {
    if (!female || female.isAnimal !== true || female.dead) return false;
    if (female.gender !== 'female') return false;
    var k = kindOf(female.kindId);
    if (!k.breeds) return false;
    var h = beast(female);
    if (h.preg) return false;
    if (!Husbandry.isAdult(female)) return false;
    if (foodOf(female) < 0.55) return false;
    if (overCap(female)) return false;
    if (!male) male = nearbyMate(female, 9);
    if (!male) return false;

    var mh = beast(male);
    var litter = U.randInt(k.litter[0], k.litter[1]);
    /* A well-fed, well-bred pair throws a bigger litter. */
    if (U.chance(U.clamp01((h.stock + mh.stock - 2) * 0.5 + foodOf(female) * 0.25))) litter++;
    h.preg = {
      left: Math.round(k.gestDays * TICKS_PER_DAY * U.randRange(0.9, 1.1)),
      total: Math.round(k.gestDays * TICKS_PER_DAY),
      sireId: male.id,
      sireStock: mh.stock,
      litter: litter
    };
    if (female.faction === 'player') {
      msg(nameOf(female) + ' is pregnant.', 'good', female);
    }
    return true;
  };

  /* Advances a pregnancy by dt ticks and gives birth when it runs out.
     Returns the young, an empty array while she is still carrying. */
  Husbandry.tickPregnancy = function (animal, dt) {
    var h = animal && animal.husbandry;
    if (!h || !h.preg) return [];
    if (animal.dead) { h.preg = null; return []; }
    /* A starving mother loses the pregnancy rather than starving the
       whole herd for it. */
    if (foodOf(animal) < 0.1 && U.chance(0.2)) {
      h.preg = null;
      if (animal.faction === 'player') msg(nameOf(animal) + ' lost her young.', 'threat', animal);
      return [];
    }
    h.preg.left -= (dt || RARE);
    if (h.preg.left > 0) return [];
    return Husbandry.birth(animal);
  };

  var NAMES = ['Bess', 'Rusty', 'Pip', 'Ash', 'Moss', 'Tuck', 'Nell', 'Bram', 'Juno', 'Ozzy',
    'Clover', 'Dusty', 'Fern', 'Gus', 'Hazel', 'Ivy', 'Jasper', 'Kit', 'Luna', 'Mabel',
    'Olive', 'Pepper', 'Quill', 'Rooke', 'Sage', 'Thistle', 'Bramble', 'Cinder', 'Dill',
    'Echo', 'Flint', 'Ginger', 'Hopper', 'Juniper'];

  Husbandry.birth = function (mother) {
    var out = [];
    if (!mother || !mother.map) return out;
    var h = beast(mother);
    var preg = h.preg;
    h.preg = null;
    if (!preg) return out;
    var MG = sys('MapGen');
    var map = mother.map;
    if (!MG || typeof MG.makePawn !== 'function') return out;

    var litter = Math.max(1, preg.litter | 0);
    for (var i = 0; i < litter; i++) {
      if (overCap(mother)) break;
      var spot = freeCellNear(map, mother.x, mother.y, 3);
      if (!spot) break;
      var baby = MG.makePawn(mother.kindId, mother.faction,
        { x: spot.x, y: spot.y, map: map, ageYears: 0, tame: mother.tame === true });
      if (!baby) break;
      baby.ageYears = 0;
      baby.ageTicks = 0;
      if (!map.addPawn(baby, spot.x, spot.y)) break;
      baby.fx = baby.x; baby.fy = baby.y;

      var bh = beast(baby);
      /* BEYOND: stock is heritable. The average of the parents, plus a
         little drift, so a colony that keeps its best animals and eats
         the rest genuinely improves its herd over generations. */
      bh.stock = U.clamp(((h.stock + (preg.sireStock || 1)) / 2) + U.gauss(0, 0.07, -0.2, 0.2),
        0.6, 1.5);
      bh.damId = mother.id;
      bh.weaned = 0;
      bh.bornTick = now();
      bh.penId = h.penId;
      if (mother.tame) {
        baby.tame = true;
        baby.faction = mother.faction;
        baby.trainedLevels = { obedience: 0, release: 0 };
        if (!baby.name) baby.name = { first: '', nick: '', last: '' };
        baby.name.nick = U.pick(NAMES);
      }
      out.push(baby);
    }

    if (out.length && mother.faction === 'player') {
      letter('A birth',
        nameOf(mother) + ' gave birth to ' + out.length + ' ' +
        U.plural(out.length, 'young') + '. They will not be worth anything for a while, and ' +
        'they eat from the day they can stand.', 'good', mother);
      var master = Husbandry.masterOf(mother) || Husbandry.bond(mother);
      if (master) thought(master, 'newbornAnimal');
      _stats.births += out.length;
    }
    return out;
  };

  /* BEYOND: the dam matters. A calf that is still nursing follows its
     mother, grows faster while she lives, and takes a real setback if
     she dies before it is weaned. */
  function tickYoung(animal, h) {
    if (h.weaned || !h.damId) return;
    var k = kindOf(animal.kindId);
    if ((animal.ageYears || 0) >= k.matureYears * 0.45) {
      h.weaned = 1;
      h.damId = 0;
      return;
    }
    var dam = livePawn(animal.map, h.damId);
    if (!dam) {
      h.weaned = 1;
      h.damId = 0;
      /* Orphaned early: it survives, but it will never be the animal it
         would have been. */
      h.stock = U.clamp(h.stock - 0.12, 0.5, 1.5);
      return;
    }
    if (animal.needs && foodOf(dam) > 0.4 && foodOf(animal) < 0.75) {
      animal.needs.food = U.clamp01(animal.needs.food + 0.02);
    }
    if (!animal.master && dam.master) animal.master = dam.master;
  }

  /* ============================================================
     PRODUCE

     Milk, wool and eggs. Each is a timer on the animal that fills up and
     then waits for someone to come and take it - except eggs, which a
     hen lays wherever she is standing whether anyone is watching or not.
     ============================================================ */

  function produceTable(animal) {
    return kindOf(animal.kindId).produce || null;
  }

  function producible(animal, key, spec) {
    if (!isLivestock(animal)) return false;
    if (spec.femaleOnly && animal.gender !== 'female') return false;
    if (!Husbandry.isAdult(animal)) return false;
    return true;
  }

  /* Which produce is ready to be taken off this animal by hand. */
  Husbandry.dueProduce = function (animal) {
    var table = produceTable(animal);
    if (!table || !animal.husbandry) return null;
    var h = animal.husbandry;
    for (var key in table) {
      var spec = table[key];
      if (spec.auto) continue;
      if (!producible(animal, key, spec)) continue;
      if ((h.produce[key] === undefined ? 0 : h.produce[key]) > 0) continue;
      return key;
    }
    return null;
  };

  Husbandry.produceSpec = function (animal, key) {
    var table = produceTable(animal);
    return (table && table[key]) || null;
  };

  /* Takes the produce and spawns it where the animal stands. The handler
     may be null, which is how a hen lays an egg with nobody about. */
  Husbandry.gather = function (animal, key, handler) {
    var spec = Husbandry.produceSpec(animal, key);
    if (!spec || !animal.map) return 0;
    var h = beast(animal);
    var count = Math.max(1, Math.round(spec.amount * Husbandry.yieldFactor(animal)));
    var made = animal.map.addItem(spec.item, animal.x, animal.y, count, { faction: 'player' });
    if (!made.length) return 0;
    h.produce[key] = Math.round(spec.days * TICKS_PER_DAY * U.randRange(0.92, 1.08));
    h.gathered++;
    _stats.produce += count;
    if (handler) {
      gainSkill(handler, 'animals', 35);
      tryBond(animal, handler, 0.7);
    }
    return count;
  };

  function tickProduce(animal, h, dt) {
    var table = produceTable(animal);
    if (!table) return;
    for (var key in table) {
      var spec = table[key];
      if (!producible(animal, key, spec)) continue;
      if (h.produce[key] === undefined) {
        h.produce[key] = Math.round(spec.days * TICKS_PER_DAY * U.randRange(0.3, 1));
        continue;
      }
      if (h.produce[key] > 0) { h.produce[key] -= dt; continue; }
      if (!spec.auto) continue;
      /* A hungry hen stops laying rather than laying badly. */
      if (foodOf(animal) < 0.25) { h.produce[key] = Math.round(0.2 * TICKS_PER_DAY); continue; }
      Husbandry.gather(animal, key, null);
    }
  }

  Husbandry.produceSummary = function (animal) {
    var table = produceTable(animal);
    if (!table) return 'nothing';
    var h = beast(animal), out = [];
    for (var key in table) {
      var spec = table[key];
      if (!producible(animal, key, spec)) continue;
      var left = h.produce[key] === undefined ? 0 : h.produce[key];
      out.push(key + (left > 0 ? ' in ' + U.fmt(left / TICKS_PER_DAY, 1) + 'd' : ' ready'));
    }
    return out.join(', ') || 'nothing';
  };

  /* ============================================================
     PENS

     A pen is the enclosed space around a pen marker. Nothing is stored
     here that a save would have to carry: the marker is a building, the
     animal remembers the marker's id, and the shape of the pen is a
     flood fill recomputed from the world whenever it is asked for and
     older than the cache window. A fill that reaches the map edge, or
     runs past the cell budget, is a pen with a hole in it.
     ============================================================ */

  var _pens = new Map();          /* markerId -> {stamp, cells, enclosed, size, forage} */
  var _stats = { births: 0, produce: 0, starved: 0, feral: 0, slaughtered: 0 };

  Husbandry.invalidatePens = function () { _pens.clear(); };

  function markers(map) {
    return (map && map.byDef) ? (map.byDef('penMarker') || []) : [];
  }
  Husbandry.markers = markers;

  function blocksLivestock(map, x, y) {
    if (!map.passable(x, y)) return true;
    var b = map.buildingAt(x, y);
    /* A door is a barrier for livestock even though a colonist walks
       through it: a pen whose only gap is a door is a pen. */
    return !!(b && b.def && b.def.building && b.def.building.isDoor);
  }

  function buildPen(map, marker) {
    var cells = Object.create(null);
    var queue = [map.idx(marker.x, marker.y)];
    var enclosed = true, size = 0, forage = 0;
    cells[queue[0]] = 1;
    var head = 0;
    while (head < queue.length) {
      var i = queue[head++];
      var x = map.xOf(i), y = map.yOf(i);
      size++;
      if (size > PEN_MAX_CELLS) { enclosed = false; break; }
      if (x <= 0 || y <= 0 || x >= map.w - 1 || y >= map.h - 1) { enclosed = false; break; }
      var plant = map.plantAt(x, y);
      if (plant && plant.def && plant.def.nutrition > 0) {
        forage += plant.def.nutrition * (plant.growth === undefined ? 1 : plant.growth);
      }
      for (var k = 0; k < U.ADJ4.length; k++) {
        var nx = x + U.ADJ4[k][0], ny = y + U.ADJ4[k][1];
        if (!map.inBounds(nx, ny)) { enclosed = false; continue; }
        if (blocksLivestock(map, nx, ny)) continue;
        var ni = map.idx(nx, ny);
        if (cells[ni]) continue;
        cells[ni] = 1;
        queue.push(ni);
      }
    }
    return { stamp: now(), cells: cells, enclosed: enclosed, size: size, forage: forage };
  }

  Husbandry.penInfo = function (map, marker) {
    if (!map || !marker || !marker.spawned) return null;
    var got = _pens.get(marker.id);
    var t = now();
    if (got && t >= got.stamp && t - got.stamp < PEN_TTL) return got;
    var built = buildPen(map, marker);
    _pens.set(marker.id, built);
    return built;
  };

  Husbandry.penOf = function (animal) {
    if (!animal || !animal.map || !animal.husbandry || !animal.husbandry.penId) return null;
    var marker = animal.map.thing(animal.husbandry.penId);
    return (marker && marker.spawned && marker.defId === 'penMarker') ? marker : null;
  };

  Husbandry.inPen = function (animal) {
    var marker = Husbandry.penOf(animal);
    if (!marker) return false;
    var info = Husbandry.penInfo(animal.map, marker);
    return !!(info && info.cells[animal.map.idx(animal.x, animal.y)]);
  };

  /* The nearest enclosed pen the animal could actually reach. Called
     when an animal is tamed, born or finds itself homeless. */
  Husbandry.assignPen = function (animal) {
    var map = animal && animal.map;
    if (!map) return null;
    var list = markers(map), best = null, bestD = 1e9;
    for (var i = 0; i < list.length; i++) {
      var marker = list[i];
      if (!marker.spawned) continue;
      var info = Husbandry.penInfo(map, marker);
      if (!info || !info.enclosed) continue;
      var d = U.distSq(animal.x, animal.y, marker.x, marker.y);
      if (d >= bestD) continue;
      best = marker; bestD = d;
    }
    beast(animal).penId = best ? best.id : 0;
    return best;
  };

  /* A cell inside the pen to head for, preferring one near the marker so
     a herd driven home does not all stand on the same tile. */
  function penTarget(map, marker, animal) {
    var info = Husbandry.penInfo(map, marker);
    if (!info || !info.size) return null;
    var ring = U.cellsInRadius(marker.x, marker.y, 6);
    var options = [];
    for (var i = 0; i < ring.length; i++) {
      var x = ring[i][0], y = ring[i][1];
      if (!map.inBounds(x, y)) continue;
      if (!info.cells[map.idx(x, y)]) continue;
      if (!map.passable(x, y)) continue;
      options.push({ x: x, y: y });
      if (options.length > 24) break;
    }
    if (!options.length) return { x: marker.x, y: marker.y };
    return options[U.randInt(0, options.length - 1) % options.length];
  }

  /* ============================================================
     PASTURE

     Grass is a stock, not a tap. Every pen is scored on what it grows
     against what the animals standing in it eat, and a pen that is
     overdrawn loses plants to trampling on top of what is eaten, which
     is what turns a herd left too long in one field into bare dirt.
     ============================================================ */

  function dailyFeed(animal) {
    var k = kindOf(animal.kindId);
    return (0.25 + k.bodySize * 0.45) * Husbandry.growth(animal);
  }
  Husbandry.dailyFeed = dailyFeed;

  Husbandry.pasture = function (map, marker) {
    var info = Husbandry.penInfo(map, marker);
    if (!info) return null;
    var demand = 0, head = 0, list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!isLivestock(p)) continue;
      if (!p.husbandry || p.husbandry.penId !== marker.id) continue;
      demand += dailyFeed(p);
      head++;
    }
    /* Forage regrows over roughly two days, so half of what is standing
       is what the pen can actually give per day. */
    var supply = info.forage * 0.5;
    return {
      head: head, demand: demand, supply: supply, size: info.size,
      enclosed: info.enclosed,
      pressure: demand / Math.max(0.05, supply)
    };
  };

  function tickPasture(map) {
    var list = markers(map);
    for (var i = 0; i < list.length; i++) {
      var marker = list[i];
      if (!marker.spawned) continue;
      var p = Husbandry.pasture(map, marker);
      if (!p || !p.head) continue;
      if (p.pressure <= 1.2) continue;
      /* Overdrawn: something gets trampled into the mud. One plant per
         slow tick is slow enough to be recoverable and visible enough
         that a pen left too long is obvious from the ground colour. */
      var info = Husbandry.penInfo(map, marker);
      var keys = Object.keys(info.cells);
      for (var tries = 0; tries < 12; tries++) {
        var cell = keys[U.randInt(0, keys.length - 1) % keys.length] | 0;
        var plant = map.plantAt(map.xOf(cell), map.yOf(cell));
        if (!plant || !plant.def || !(plant.def.nutrition > 0)) continue;
        map.destroyThing(plant, 'grazed');
        break;
      }
    }
  }

  /* ============================================================
     TROUGHS

     Where there is no grass there has to be hay, and a colonist who
     carries every mouthful by hand is a colonist doing nothing else.
     A trough is a buffer measured in nutrition, filled by a handler and
     drawn down by whoever is hungry.
     ============================================================ */

  function troughs(map) {
    return (map && map.byDef) ? (map.byDef('trough') || []) : [];
  }
  Husbandry.troughs = troughs;

  function troughLevel(trough) {
    return typeof trough.troughFood === 'number' ? trough.troughFood : 0;
  }
  Husbandry.troughLevel = troughLevel;

  Husbandry.fodderDefIds = function () {
    return ['hay', 'kibble'];
  };

  Husbandry.addFodder = function (trough, defId, count) {
    var def = Defs.maybe('thing', defId);
    if (!trough || !def || !(count > 0)) return 0;
    var per = def.nutrition > 0 ? def.nutrition : 0.05;
    var room = TROUGH_CAPACITY - troughLevel(trough);
    if (room <= 0) return 0;
    var added = Math.min(room, per * count);
    trough.troughFood = troughLevel(trough) + added;
    return added;
  };

  /* One animal's mouthful. Deliberately small so a trough feeds a herd
     rather than one muffalo. */
  Husbandry.eatFromTrough = function (animal, trough) {
    var level = troughLevel(trough);
    if (level <= 0 || !animal.needs) return 0;
    var want = Math.min(0.35, 1 - animal.needs.food);
    if (want <= 0.01) return 0;
    var taken = Math.min(level, want);
    trough.troughFood = level - taken;
    animal.needs.food = U.clamp01(animal.needs.food + taken);
    return taken;
  };

  function nearestTrough(animal, needFood) {
    var map = animal.map;
    var list = troughs(map), best = null, bestD = TROUGH_RANGE * TROUGH_RANGE;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t.spawned) continue;
      if (needFood && troughLevel(t) <= 0) continue;
      var d = U.distSq(animal.x, animal.y, t.x, t.y);
      if (d > bestD) continue;
      best = t; bestD = d;
    }
    return best;
  }

  /* ============================================================
     GOING FERAL, AND STARVING

     Livestock with nowhere to be drifts. An animal that spends days
     outside a pen with no master eventually stops thinking of itself as
     anybody's, which is the cost of taming something and then not
     building it a home.
     ============================================================ */

  function goFeral(animal, why) {
    if (!animal || !animal.tame) return false;
    var label = nameOf(animal);
    var h = beast(animal);
    Husbandry.unbond(animal);
    animal.tame = false;
    animal.faction = 'wild';
    animal.master = null;
    animal.trainedLevels = null;
    h.train = { obedience: 0, release: 0, rescue: 0, haul: 0 };
    h.wear = { obedience: 0, release: 0, rescue: 0, haul: 0 };
    h.penId = 0;
    h.strayTicks = 0;
    var A = sys('Animals');
    if (A && A.undesignate) A.undesignate(animal);
    if (animal.job && Jobs && Jobs.end) Jobs.end(animal, 'interrupted');
    _stats.feral++;
    letter('An animal went wild',
      label + ' has gone back to the wild' + (why === 'grief' ? ' after losing its person.' :
        '. It had no pen, no master and no reason to stay.'), 'threat', animal);
    return true;
  }
  Husbandry.goFeral = goFeral;

  function tickStray(animal, h, dt) {
    if (!isLivestock(animal)) return;
    if (animal.master || h.bondId) { h.strayTicks = 0; return; }
    var marker = Husbandry.penOf(animal);
    if (!marker) {
      /* No pen assigned. Look for one before counting this against it:
         a colony that just built its first pen should collect its herd,
         not lose it. */
      if (markers(animal.map).length) { Husbandry.assignPen(animal); h.strayTicks = 0; return; }
      h.strayTicks += dt * 0.5;
    } else if (Husbandry.inPen(animal)) {
      h.strayTicks = 0;
      return;
    } else {
      h.strayTicks += dt;
    }
    if (h.strayTicks > STRAY_FERAL_DAYS * TICKS_PER_DAY && U.chance(0.06)) {
      goFeral(animal, 'stray');
    }
  }

  function tickHunger(animal, h, dt) {
    if (!isLivestock(animal)) return;
    var food = foodOf(animal);
    if (food > STARVING_AT) { h.hunger = 0; return; }
    h.hunger += dt;
    if (now() - h.starveNote < TICKS_PER_DAY) return;
    h.starveNote = now();
    if (h.hunger > TICKS_PER_DAY * 0.5) {
      msg(nameOf(animal) + ' is starving.', 'threat', animal);
    }
  }

  /* Called by the death sweep: an animal that starved is a colony
     failure, and the people who were feeding it know it. */
  function noteStarvedDeath(map, animal) {
    _stats.starved++;
    var colonists = map.colonists ? map.colonists() : [];
    for (var i = 0; i < colonists.length; i++) thought(colonists[i], 'livestockStarved');
  }

  /* ============================================================
     HERD POLICY

     "Keep four females and one male, butcher the rest." The single most
     asked-for piece of quality of life in a colony sim, because without
     it a working herd has to be culled by hand every few days. The rule
     picks what to keep by worth - bonded first, then the best stock -
     and designates the remainder for the slaughter work animals.js
     already does.
     ============================================================ */

  var _policy = Object.create(null);

  Husbandry.policy = function (kindId) {
    var p = _policy[kindId];
    if (p) return p;
    p = _policy[kindId] = { enabled: false, females: 4, males: 1, keepYoung: true };
    return p;
  };

  Husbandry.setPolicy = function (kindId, opts) {
    var p = Husbandry.policy(kindId);
    if (!opts) return p;
    if (opts.enabled !== undefined) p.enabled = !!opts.enabled;
    if (opts.females !== undefined) p.females = Math.max(0, opts.females | 0);
    if (opts.males !== undefined) p.males = Math.max(0, opts.males | 0);
    if (opts.keepYoung !== undefined) p.keepYoung = !!opts.keepYoung;
    return p;
  };

  Husbandry.policies = function () { return _policy; };

  /* Worth keeping, highest first. A bonded animal is never culled by a
     rule - that is a decision a player makes on purpose, not one a
     policy makes at three in the morning. */
  function keepScore(animal) {
    var h = beast(animal);
    var score = h.stock * 10;
    if (h.bondId) score += 1000;
    if (h.preg) score += 300;
    if (Husbandry.isTrained(animal, 'haul') || Husbandry.isTrained(animal, 'rescue')) score += 120;
    if (Husbandry.isTrained(animal, 'obedience')) score += 40;
    var k = kindOf(animal.kindId);
    var age = animal.ageYears || 0;
    if (age > k.lifeYears * 0.8) score -= 60;
    return score;
  }

  function applyPolicy(map) {
    var A = sys('Animals');
    if (!A || !A.designate) return 0;
    var byKind = Object.create(null), list = map.pawns, i;
    for (i = 0; i < list.length; i++) {
      var p = list[i];
      if (!isLivestock(p)) continue;
      var rule = _policy[p.kindId];
      if (!rule || !rule.enabled) continue;
      var slot = byKind[p.kindId] || (byKind[p.kindId] = { female: [], male: [], young: [] });
      if (!Husbandry.isAdult(p)) slot.young.push(p);
      else slot[p.gender === 'female' ? 'female' : 'male'].push(p);
    }

    var marked = 0;
    for (var kindId in byKind) {
      var rule2 = _policy[kindId];
      var group = byKind[kindId];
      var cull = [];
      ['female', 'male'].forEach(function (sex) {
        var keep = sex === 'female' ? rule2.females : rule2.males;
        var herd = group[sex].slice().sort(function (a, b) { return keepScore(b) - keepScore(a); });
        for (var n = keep; n < herd.length; n++) cull.push(herd[n]);
      });
      if (!rule2.keepYoung) {
        /* Young are only culled once the adults are already at quota,
           which is what stops a policy from eating next year's herd. */
        var adults = group.female.length + group.male.length;
        if (adults >= rule2.females + rule2.males) {
          for (var y = 0; y < group.young.length; y++) cull.push(group.young[y]);
        }
      }
      for (var c = 0; c < cull.length; c++) {
        var beastToCull = cull[c];
        if (beast(beastToCull).bondId) continue;
        if (beast(beastToCull).preg) continue;
        if (beastToCull.designated === 'slaughter') continue;
        A.designate(beastToCull, 'slaughter');
        marked++;
      }
      /* Under quota again - lift any standing order the rule itself put
         on an animal, so a raid that thinned the herd does not get
         followed by a butcher finishing the job. */
      if (!cull.length) {
        var all = group.female.concat(group.male, group.young);
        for (var u = 0; u < all.length; u++) {
          if (all[u].designated === 'slaughter' && A.undesignate) A.undesignate(all[u]);
        }
      }
    }
    if (marked) _stats.slaughtered += marked;
    return marked;
  }
  Husbandry.applyPolicy = applyPolicy;
