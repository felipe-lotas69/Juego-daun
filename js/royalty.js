/* ============================================================
   royalty.js - the stellar empire, its titles, and psycasts.

   Three systems that only make sense together. The empire grants
   titles in exchange for honor; a title buys privileges and sells
   obligations - a bedroom worthy of the rank, noble dress, and a
   flat refusal to haul corpses; and the higher titles come with a
   psylink, which is the licence to spend psyfocus and carry the
   entropy that spending it leaves behind.

   Nothing here edits a file it does not own. Content is registered
   through Defs.add, behaviour through Jobs.register and
   WorkGivers.register, and the two places the engine offers no hook
   at all - a per-pawn tick and enemy targeting - are reached by
   chaining the existing function rather than replacing it. Both
   chains are idempotent, so an integrator who later calls
   Royalty.tickPawn from game.js costs nothing and breaks nothing.

   Mech clusters are deliberately out of scope: see the note at the
   foot of this file.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Everything above royalty.js in the load order may be bound now;
     Game, Save, Incidents and Storyteller load after it, so those are
     fetched by name at tick time. */
  var T = root.T, Res = root.Res, Jobs = root.Jobs, Toils = root.Toils, Path = root.Path;

  function sys(name) { return root[name] || null; }
  function now() {
    var G = root.Game;
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  var TICKS_PER_DAY = 60000;
  var TICKS_PER_HOUR = TICKS_PER_DAY / 24;
  var RARE = 250;

  var Royalty = {};

  /* ============================================================
     1. CONTENT

     Registered into the existing categories at load time. defs.js
     is untouched: every category used here is one it already knows.
     ============================================================ */

  /* def_things.js keeps its field templates private, so the same
     shapes are restated here. Every consumer reads these fields
     without a guard, which is why they all have to be present. */
  var BUILDING_BLOCK = {
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
    for (k in BUILDING_BLOCK) out[k] = BUILDING_BLOCK[k];
    if (o) for (k in o) out[k] = o[k];
    return out;
  }

  var ITEM_DEFAULTS = {
    category: 'item', description: '',
    sprite: 'item', color: '#b0b0b8', color2: null,
    stackLimit: 1, mass: 1, marketValue: 1,
    nutrition: 0, foodType: null, rotDays: null,
    isMedicine: false, medicinePotency: 0,
    passable: true, pathCost: 0, fillPercent: 0, blocksLight: false, holdsRoof: false,
    size: { w: 1, h: 1 }, rotatable: false, hp: 60, flammable: false,
    beauty: 0, comfort: 0, natural: false,
    buildCost: null, stuffable: false, workToBuild: 0, buildSkill: null,
    buildCategory: null, researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null,
    building: null, weapon: null, apparel: null,
    royalApparel: false, psyFocusStrength: 0
  };

  function itemDefaults(over) {
    var out = {}, k;
    for (k in ITEM_DEFAULTS) out[k] = ITEM_DEFAULTS[k];
    if (over) for (k in over) out[k] = over[k];
    return out;
  }

  /* The one item the empire will not make for you twice: a psylink
     neuroformer. It is a plain trade good, which is all it takes to
     reach the stock rolls - trade.js builds a counter from Zones
     categories, and its price is what keeps it off a tribal camp's
     table and on an imperial one. */
  Defs.add('thing', {

    psylinkNeuroformer: {
      label: 'psylink neuroformer',
      description: 'A single-use archotech lace that threads a new psychic link through the ' +
        'user\'s cortex. The empire sells them and pretends they are a formality.',
      sprite: 'item', color: '#6a4fb0', color2: '#ffc23c',
      mass: 1, marketValue: 1800, hp: 60, beauty: 2
    },

    formalShirt: {
      label: 'formal shirt',
      description: 'Stiff collar, real buttons, worn under everything else. Court dress for ' +
        'somebody who still has to walk through a mine on the way.',
      sprite: 'item', color: '#e8e2d4', color2: '#c9a24a',
      mass: 2, marketValue: 180, hp: 90, flammable: true,
      royalApparel: true,
      apparel: { slots: ['torso'], layer: 'onSkin', armorSharp: 0.02, armorBlunt: 0.02,
                 insulationCold: 2, insulationHeat: 0, coverage: 0.85 }
    },

    nobleCape: {
      label: 'noble cape',
      description: 'Heavy weave over one shoulder, in the colours of a house that is not yours yet.',
      sprite: 'vest', color: '#6a4fb0', color2: '#ffc23c',
      mass: 4, marketValue: 420, hp: 110, flammable: true,
      royalApparel: true,
      apparel: { slots: ['torso'], layer: 'shell', armorSharp: 0.12, armorBlunt: 0.08,
                 insulationCold: 9, insulationHeat: -3, coverage: 0.8 }
    },

    nobleCrown: {
      label: 'coronet',
      description: 'A thin band of worked silver. It stops nothing, which is the point: only ' +
        'somebody who is never in danger can afford to wear one.',
      sprite: 'helmet', color: '#c9a24a', color2: '#ffc23c',
      mass: 1, marketValue: 620, hp: 80, flammable: false,
      royalApparel: true,
      apparel: { slots: ['head'], layer: 'overhead', armorSharp: 0.05, armorBlunt: 0.05,
                 insulationCold: 1, insulationHeat: 0, coverage: 0.5 }
    }

  }, itemDefaults());

  var BUILDING_DEFAULTS = itemDefaults({
    category: 'building', sprite: 'box', mass: 20, marketValue: 0, hp: 120,
    passable: false, pathCost: 0, fillPercent: 1,
    buildSkill: 'construction', building: bld({})
  });

  Defs.add('thing', {

    animusStone: {
      label: 'animus stone',
      description: 'A shard of something that was thinking long before anyone landed here. ' +
        'Psycasters who sit with it come away with their focus back and their sleep worse.',
      sprite: 'sculpture', color: '#6a4fb0', color2: '#9fd2e8',
      hp: 240, mass: 90, flammable: false,
      passable: false, fillPercent: 0.6, beauty: 12, marketValue: 700,
      buildCost: { steel: 40, silver: 120 }, workToBuild: 2600,
      buildSkill: 'artistic', buildCategory: 'furniture',
      psyFocusStrength: 0.48,
      building: bld({})
    },

    /* Raised by a psycast and gone again in half a minute. Not
       buildable, so the architect never offers it and verify-defs
       never asks it for a build cost. */
    psychicWall: {
      label: 'psychic wall',
      description: 'Compressed air and refusal, holding the shape of a wall for as long as the ' +
        'caster\'s heat lasts.',
      sprite: 'wall', color: '#6a4fb0', color2: '#9fd2e8',
      hp: 120, mass: 0, flammable: false,
      passable: false, fillPercent: 1, blocksLight: true, holdsRoof: false,
      beauty: 0, marketValue: 0,
      building: bld({})
    },

    solarPinhole: {
      label: 'solar pinhole',
      description: 'A pinprick of borrowed daylight hanging at head height. It needs no wire ' +
        'and burns nothing, and it ends when the psycast does.',
      sprite: 'lamp', color: '#ffc23c', color2: '#ff8c1a',
      hp: 30, mass: 0, flammable: false,
      passable: true, pathCost: 0, fillPercent: 0, beauty: 4, marketValue: 0,
      building: bld({ isLamp: true, lightRadius: 11 })
    }

  }, BUILDING_DEFAULTS);

  /* Noble dress the colony can make for itself rather than buying. */
  Defs.add('recipe', {
    sewFormalShirt: {
      label: 'formal shirt', jobString: 'Tailoring', uiCategory: 'tailoring',
      workAmount: 900, skill: 'crafting', skillRequirement: 3,
      workbenches: ['tailoringBench'],
      ingredients: [{ thing: 'cloth', count: 45 }],
      products: { formalShirt: 1 }, productQuality: true,
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Court dress, cut at home. A titled colonist stops sulking about their wardrobe.'
    },
    sewNobleCape: {
      label: 'noble cape', jobString: 'Tailoring', uiCategory: 'tailoring',
      workAmount: 1600, skill: 'crafting', skillRequirement: 6,
      workbenches: ['tailoringBench'],
      ingredients: [{ thing: 'cloth', count: 60 }, { thing: 'leather', count: 30 }],
      products: { nobleCape: 1 }, productQuality: true,
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Warm, expensive and visibly useless, which is exactly what it is for.'
    },
    forgeNobleCrown: {
      label: 'coronet', jobString: 'Smithing', uiCategory: 'crafting',
      workAmount: 2400, skill: 'crafting', skillRequirement: 7,
      workbenches: ['smithy'],
      ingredients: [{ thing: 'silver', count: 150 }, { thing: 'steel', count: 20 }],
      products: { nobleCrown: 1 }, productQuality: true,
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Silver drawn into a band. The empire recognises the shape and nothing else.'
    }
  }, {
    jobString: 'Working', skill: null, skillRequirement: 0,
    workType: 'craft', uiCategory: 'crafting', workbenches: [],
    products: {}, dynamicProducts: false, productQuality: false,
    researchPrerequisite: null,
    defaultRepeat: 'forever', defaultTargetCount: 0, defaultIngredientRadius: 999,
    foodPoisonChance: 0, description: ''
  });

  /* Meditation is its own column, registered last so it sits at the
     far right of the Work tab and is therefore the last thing a
     colonist falls through to. That is the whole design: a psycaster
     tops up their focus in the time they would otherwise spend idle,
     and a player who disagrees turns the column off. */
  Defs.add('workType', {
    meditate: {
      label: 'Meditate', verb: 'meditating', order: 18,
      description: 'Sit with a focus object and recover psyfocus. Only psycasters can do it, ' +
        'and only when there is nothing else left on their list.',
      skills: [], relevantSkillsLabel: 'None',
      requiresManipulation: false, alwaysDoable: true
    }
  });

  Defs.add('thought', {
    titleNoBedroom: {
      label: 'Unfit quarters', durationDays: 0.4,
      stages: [
        { label: 'My room is beneath me', mood: -5 },
        { label: 'These are not a noble\'s quarters', mood: -11 },
        { label: 'I am housed like a serf', mood: -18 }
      ]
    },
    titleNoApparel: {
      label: 'Undressed for my rank', durationDays: 0.4,
      stages: [
        { label: 'Not dressed for my station', mood: -4 },
        { label: 'Dressed like a labourer', mood: -9 }
      ]
    },
    titleDegraded: {
      label: 'Degraded by dirty work', durationDays: 1.2, stackLimit: 3,
      stages: [{ label: 'Made to do a peasant\'s work', mood: -8 }]
    },
    titleGranted: {
      label: 'Raised to a title', durationDays: 8,
      stages: [{ label: 'The empire named me', mood: 14 }]
    },
    titleRevoked: {
      label: 'Stripped of my title', durationDays: 12,
      stages: [{ label: 'The empire took my title back', mood: -22 }]
    },
    titleHonoured: {
      label: 'Well kept', durationDays: 0.4,
      stages: [{ label: 'Quarters and dress worthy of my rank', mood: 5 }]
    },
    psylinkGained: {
      label: 'New psylink', durationDays: 6,
      stages: [{ label: 'A new psychic link opened', mood: 9 }]
    },
    psychicBreakdown: {
      label: 'Neural heat burn', durationDays: 2.5,
      stages: [{ label: 'My head is still burning', mood: -13 }]
    },
    meditated: {
      label: 'Meditated', durationDays: 0.6,
      stages: [{ label: 'Meditated in peace', mood: 4 }]
    }
  });

  /* Health owns the hediff table and exposes it; these are added to
     it rather than invented as a private status effect, so the health
     tab, the capacity maths and the save file all see them without a
     line of health.js changing. Every one of them decays on its own,
     and Royalty's rare tick sweeps the spent husks. */
  var PSY_HEDIFFS = {
    psychicStun: {
      id: 'psychicStun', label: 'psychic stun', lethal: false, severityPerDay: -100,
      capMods: { consciousness: -0.75 }
    },
    psychicBlindness: {
      id: 'psychicBlindness', label: 'psychic blindness', lethal: false, severityPerDay: -12,
      painOffset: 0.02, capMods: { sight: -0.92 }
    },
    psychicVertigo: {
      id: 'psychicVertigo', label: 'psychic vertigo', lethal: false, severityPerDay: -20,
      capMods: { moving: -0.55, consciousness: -0.12 }
    },
    psychicPainblock: {
      id: 'psychicPainblock', label: 'pain block', lethal: false, severityPerDay: -3,
      painOffset: -0.65
    },
    psychicFocus: {
      id: 'psychicFocus', label: 'psychic focus', lethal: false, severityPerDay: -4,
      capMods: { consciousness: 0.15, manipulation: 0.12 }
    },
    psychicComa: {
      id: 'psychicComa', label: 'neural heat coma', lethal: false, severityPerDay: -9,
      capMods: { consciousness: -0.85, moving: -0.6 }
    }
  };

  (function installHediffs() {
    var H = sys('Health');
    if (!H || !H.HEDIFFS) return;
    for (var k in PSY_HEDIFFS) if (!H.HEDIFFS[k]) H.HEDIFFS[k] = PSY_HEDIFFS[k];
  })();

  /* ============================================================
     2. TITLES

     honor is what the empire charges; psylink is what it hands over;
     everything else on the row is the bill that arrives afterwards.
     bedroomCells and bedroomImpressive are the two halves of "a room
     worthy of the rank", and refusedWork is the list of work types
     the holder will not touch again.
     ============================================================ */

  var TITLES = [
    { id: 'freeholder', label: 'Freeholder', honor: 12, psylink: 0,
      bedroomCells: 0, bedroomImpressive: 0, apparel: false, refusedWork: [],
      aid: 0, tradeFactor: 0.02 },
    { id: 'yeoman', label: 'Yeoman', honor: 34, psylink: 0,
      bedroomCells: 14, bedroomImpressive: 0.12, apparel: false, refusedWork: [],
      aid: 0, tradeFactor: 0.04 },
    { id: 'acolyte', label: 'Acolyte', honor: 72, psylink: 1,
      bedroomCells: 18, bedroomImpressive: 0.20, apparel: false, refusedWork: [],
      aid: 0, tradeFactor: 0.06 },
    { id: 'knight', label: 'Knight', honor: 125, psylink: 1,
      bedroomCells: 24, bedroomImpressive: 0.28, apparel: true, refusedWork: ['clean'],
      aid: 60, tradeFactor: 0.08 },
    { id: 'praetor', label: 'Praetor', honor: 205, psylink: 2,
      bedroomCells: 30, bedroomImpressive: 0.34, apparel: true, refusedWork: ['clean'],
      aid: 90, tradeFactor: 0.10 },
    { id: 'baron', label: 'Baron', honor: 310, psylink: 2,
      bedroomCells: 36, bedroomImpressive: 0.42, apparel: true, refusedWork: ['clean', 'haul'],
      aid: 130, tradeFactor: 0.12 },
    { id: 'count', label: 'Count', honor: 450, psylink: 3,
      bedroomCells: 44, bedroomImpressive: 0.50, apparel: true,
      refusedWork: ['clean', 'haul', 'mine', 'plantCut', 'basic'],
      aid: 180, tradeFactor: 0.15 },
    { id: 'marquess', label: 'Marquess', honor: 660, psylink: 4,
      bedroomCells: 52, bedroomImpressive: 0.58, apparel: true,
      refusedWork: ['clean', 'haul', 'mine', 'plantCut', 'basic', 'grow'],
      aid: 240, tradeFactor: 0.18 },
    { id: 'duke', label: 'Duke', honor: 920, psylink: 5,
      bedroomCells: 62, bedroomImpressive: 0.66, apparel: true,
      refusedWork: ['clean', 'haul', 'mine', 'plantCut', 'basic', 'grow', 'construct', 'cook'],
      aid: 320, tradeFactor: 0.22 },
    { id: 'consul', label: 'Consul', honor: 1240, psylink: 6,
      bedroomCells: 74, bedroomImpressive: 0.74, apparel: true,
      refusedWork: ['clean', 'haul', 'mine', 'plantCut', 'basic', 'grow', 'construct', 'cook',
                    'craft', 'handle'],
      aid: 420, tradeFactor: 0.26 }
  ];

  var TITLE_BY_ID = {};
  TITLES.forEach(function (t, i) { t.rank = i; TITLE_BY_ID[t.id] = t; });

  Royalty.titles = function () { return TITLES.slice(); };
  Royalty.title = function (id) { return TITLE_BY_ID[id] || null; };

  /* ============================================================
     3. PSYCASTS

     Sixteen of them, and every one changes the world rather than the
     message log. apply() is the whole effect; the job in section 8
     is only the warm-up in front of it.
     ============================================================ */

  var PSYCASTS = {};

  function psycast(spec) { PSYCASTS[spec.id] = spec; return spec; }

  /* Target kinds: 'pawn' needs a live pawn, 'cell' a tile, 'self' the
     caster, 'any' takes either a pawn or a tile. */

  psycast({
    id: 'stun', label: 'Stun', level: 1, psyfocus: 0.02, entropy: 8,
    range: 24, castTicks: 30, target: 'pawn', hostileOk: true,
    description: 'Drops a mind out of the fight for about ten seconds.',
    apply: function (caster, ctx) {
      var H = sys('Health');
      if (!H) return false;
      H.addHediff(ctx.pawn, 'psychicStun', 1);
      interrupt(ctx.pawn);
      return true;
    }
  });

  psycast({
    id: 'painblock', label: 'Painblock', level: 1, psyfocus: 0.03, entropy: 12,
    range: 24, castTicks: 60, target: 'pawn',
    description: 'Cuts a colonist off from their own pain for a few minutes.',
    apply: function (caster, ctx) {
      var H = sys('Health');
      if (!H) return false;
      H.addHediff(ctx.pawn, 'psychicPainblock', 1);
      return true;
    }
  });

  psycast({
    id: 'blindingPulse', label: 'Blinding Pulse', level: 1, psyfocus: 0.04, entropy: 14,
    range: 24, castTicks: 60, target: 'pawn', hostileOk: true,
    description: 'Blanks a target\'s sight. A blinded shooter cannot find anything to shoot.',
    apply: function (caster, ctx) {
      var H = sys('Health');
      if (!H) return false;
      H.addHediff(ctx.pawn, 'psychicBlindness', 1);
      return true;
    }
  });

  psycast({
    id: 'vertigoPulse', label: 'Vertigo Pulse', level: 2, psyfocus: 0.06, entropy: 16,
    range: 24, castTicks: 60, target: 'pawn', hostileOk: true,
    description: 'Rolls the horizon over. They can still fight; they cannot close the distance.',
    apply: function (caster, ctx) {
      var H = sys('Health');
      if (!H) return false;
      H.addHediff(ctx.pawn, 'psychicVertigo', 1);
      interrupt(ctx.pawn);
      return true;
    }
  });

  psycast({
    id: 'neuralHeatDump', label: 'Neural Heat Dump', level: 5, psyfocus: 0.10, entropy: 0,
    range: 0, castTicks: 120, target: 'self',
    description: 'Vents the caster\'s accumulated entropy into the air around them.',
    apply: function (caster) {
      var psy = psyOf(caster);
      psy.entropy = 0;
      return true;
    }
  });

  psycast({
    id: 'skip', label: 'Skip', level: 2, psyfocus: 0.03, entropy: 12,
    range: 24, castTicks: 30, target: 'pawn', hostileOk: true, needsDest: true,
    description: 'Moves a body a short distance without moving it through anything between.',
    apply: function (caster, ctx) {
      var dest = ctx.dest || nearestFreeCell(ctx.map, ctx.x, ctx.y, 6);
      if (!dest) return false;
      return teleport(ctx.pawn, dest.x, dest.y);
    }
  });

  psycast({
    id: 'wallraise', label: 'Wallraise', level: 4, psyfocus: 0.20, entropy: 30,
    range: 22, castTicks: 180, target: 'cell',
    description: 'Throws up five tiles of solid air across the line of advance. It lasts half ' +
      'a minute, which is a whole firefight.',
    apply: function (caster, ctx) {
      var map = ctx.map;
      /* Across the caster\'s line of sight, not along it: a wall that
         runs at the enemy is a corridor, a wall that runs across them
         is cover. */
      var dx = ctx.x - caster.x, dy = ctx.y - caster.y;
      var px, py;
      if (Math.abs(dx) >= Math.abs(dy)) { px = 0; py = 1; } else { px = 1; py = 0; }
      var raised = 0;
      for (var k = -2; k <= 2; k++) {
        var x = ctx.x + px * k, y = ctx.y + py * k;
        if (!map.inBounds(x, y)) continue;
        if (map.buildingAt(x, y) || map.pawnsAt(x, y).length) continue;
        if (!map.passable(x, y)) continue;
        if (map.spawnThing('psychicWall', x, y, { faction: caster.faction })) raised++;
      }
      return raised > 0;
    }
  });

  psycast({
    id: 'berserk', label: 'Berserk', level: 3, psyfocus: 0.14, entropy: 25,
    range: 24, castTicks: 180, target: 'pawn', hostileOk: true,
    description: 'Turns a mind on whoever is nearest, which on a raid line is their own people.',
    apply: function (caster, ctx) {
      var Think = sys('Think');
      if (!Think || !Think.startMentalState) return false;
      return Think.startMentalState(ctx.pawn, 'berserk');
    }
  });

  psycast({
    id: 'chunkSkip', label: 'Chunk Skip', level: 2, psyfocus: 0.04, entropy: 14,
    range: 26, castTicks: 60, target: 'cell',
    description: 'Gathers loose stone from across the map and drops it on a tile from a height.',
    apply: function (caster, ctx) {
      var map = ctx.map;
      var chunks = map.byDef('stoneChunk') || [];
      var moved = 0;
      for (var i = 0; i < chunks.length && moved < 5; i++) {
        var c = chunks[i];
        if (!c.spawned) continue;
        if (U.cheb(c.x, c.y, caster.x, caster.y) > 28) continue;
        if (c.x === ctx.x && c.y === ctx.y) continue;
        map.moveThing(c, ctx.x, ctx.y);
        moved++;
      }
      if (!moved) return false;
      var hit = map.pawnsAt(ctx.x, ctx.y);
      var H = sys('Health');
      for (var p = 0; p < hit.length; p++) {
        if (H) H.damage(hit[p], { amount: 6 * moved, type: 'blunt', instigator: caster,
                                  source: 'chunk skip' });
      }
      return true;
    }
  });

  psycast({
    id: 'beckon', label: 'Beckon', level: 3, psyfocus: 0.08, entropy: 16,
    range: 28, castTicks: 60, target: 'pawn', hostileOk: true, needsDest: true,
    description: 'Makes somebody walk to a place of your choosing, out of their cover and ' +
      'into yours.',
    apply: function (caster, ctx) {
      var dest = ctx.dest || { x: caster.x, y: caster.y };
      var target = ctx.pawn;
      if (!Jobs || !Jobs.make) return false;
      interrupt(target);
      var job = Jobs.make('goto', T.cell(dest.x, dest.y), null, { playerForced: true });
      job.state.pe = 0;
      return Jobs.start(target, job);
    }
  });

  psycast({
    id: 'solarPinhole', label: 'Solar Pinhole', level: 4, psyfocus: 0.15, entropy: 25,
    range: 22, castTicks: 300, target: 'cell',
    description: 'Hangs a point of daylight in the air. It needs no wire and it lasts a day.',
    apply: function (caster, ctx) {
      var map = ctx.map;
      var spot = map.buildingAt(ctx.x, ctx.y) ? nearestFreeCell(map, ctx.x, ctx.y, 4) : ctx;
      if (!spot) return false;
      return !!map.spawnThing('solarPinhole', spot.x, spot.y, { faction: caster.faction });
    }
  });

  psycast({
    id: 'wordOfSerenity', label: 'Word of Serenity', level: 2, psyfocus: 0.10, entropy: 10,
    range: 24, castTicks: 300, target: 'pawn',
    description: 'Ends a mental break where it stands, without a punch being thrown.',
    apply: function (caster, ctx) {
      var Think = sys('Think');
      if (!Think || !Think.endMentalState) return false;
      if (!ctx.pawn.mentalState) return false;
      Think.endMentalState(ctx.pawn, 'calmed by a psycast');
      return true;
    }
  });

  psycast({
    id: 'wordOfJoy', label: 'Word of Joy', level: 2, psyfocus: 0.12, entropy: 12,
    range: 24, castTicks: 300, target: 'pawn',
    description: 'A colonist who has not seen a day off in a season suddenly feels rested.',
    apply: function (caster, ctx) {
      var N = sys('Needs');
      if (!N || !N.gainJoy) return false;
      N.gainJoy(ctx.pawn, 0.65, 'psychic');
      return true;
    }
  });

  psycast({
    id: 'focus', label: 'Focus', level: 4, psyfocus: 0.05, entropy: 10,
    range: 0, castTicks: 120, target: 'self',
    description: 'Sharpens the caster for a few minutes of work nobody else can do as fast.',
    apply: function (caster) {
      var H = sys('Health');
      if (!H) return false;
      H.addHediff(caster, 'psychicFocus', 1);
      return true;
    }
  });

  psycast({
    id: 'invisibility', label: 'Invisibility', level: 5, psyfocus: 0.25, entropy: 35,
    range: 18, castTicks: 300, target: 'pawn',
    description: 'Nothing hostile can find the target for twenty seconds. Long enough to reach ' +
      'the downed one and carry them out.',
    apply: function (caster, ctx) {
      var psy = psyOf(ctx.pawn);
      psy.invisUntil = now() + 1200;
      invisibleCount++;
      return true;
    }
  });

  psycast({
    id: 'manhunterPulse', label: 'Manhunter Pulse', level: 3, psyfocus: 0.18, entropy: 30,
    range: 30, castTicks: 300, target: 'cell',
    description: 'Every wild animal within twenty tiles decides the nearest upright thing is ' +
      'the problem.',
    apply: function (caster, ctx) {
      var A = sys('Animals');
      if (!A || !A.makeManhunter) return false;
      var pawns = ctx.map.pawns, turned = 0;
      for (var i = 0; i < pawns.length; i++) {
        var a = pawns[i];
        if (!a.isAnimal || a.dead || a.faction === 'player') continue;
        if (U.cheb(a.x, a.y, ctx.x, ctx.y) > 20) continue;
        A.makeManhunter(a, {});
        turned++;
      }
      return turned > 0;
    }
  });

  Royalty.psycasts = function () {
    var out = [];
    for (var k in PSYCASTS) out.push(PSYCASTS[k]);
    out.sort(function (a, b) { return a.level - b.level || (a.id < b.id ? -1 : 1); });
    return out;
  };
  Royalty.psycast = function (id) { return PSYCASTS[id] || null; };

  /* ============================================================
     4. PER-PAWN STATE

     Both blobs are plain fields on the pawn, so save.js carries them
     with the pawn and nothing here has to be told about saving.
     ============================================================ */

  var MAX_PSYLINK = 6;
  var ENTROPY_DRAIN_PER_DAY = 1800;       /* about thirty points a quarter minute */
  var FOCUS_DECAY_PER_DAY = 0.10;
  var FOCUS_FLOOR_FOR_CAST = 0.01;

  function psyOf(pawn) {
    var p = pawn.psy;
    if (!p) {
      p = pawn.psy = { level: 0, focus: 1, entropy: 0, known: [], t: now(), invisUntil: 0 };
    }
    /* A blob restored from an older save, or written by hand in a
       test, is completed rather than rejected. */
    if (typeof p.level !== 'number') p.level = 0;
    if (typeof p.focus !== 'number') p.focus = 1;
    if (typeof p.entropy !== 'number') p.entropy = 0;
    if (!p.known) p.known = [];
    if (typeof p.t !== 'number') p.t = now();
    if (typeof p.invisUntil !== 'number') p.invisUntil = 0;
    return p;
  }

  function titleState(pawn) {
    var t = pawn.title;
    if (!t) t = pawn.title = { id: null, honor: 0, grantedTick: 0, suspended: null, unmet: [] };
    if (typeof t.honor !== 'number') t.honor = 0;
    if (!t.unmet) t.unmet = [];
    return t;
  }

  Royalty.psyOf = function (pawn) { return pawn && pawn.psy ? psyOf(pawn) : null; };
  Royalty.entropyLimit = function (pawn) {
    var psy = pawn && pawn.psy ? psyOf(pawn) : null;
    return 30 + 10 * (psy ? psy.level : 0);
  };

  Royalty.titleOf = function (pawn) {
    var t = pawn && pawn.title;
    return (t && t.id) ? (TITLE_BY_ID[t.id] || null) : null;
  };
  Royalty.honorOf = function (pawn) {
    var t = pawn && pawn.title;
    return t ? (t.honor || 0) : 0;
  };

  /* ============================================================
     5. THE EMPIRE

     factions.js only rolls an empire onto four planets in ten, and it
     exposes no way to add one. When the planet has one, this is a
     thin view onto that Faction so goodwill stays in one place; when
     it does not, Royalty keeps its own record, which is why goodwill
     is read and written through here and never off the faction.
     ============================================================ */

  var PRIDE = 2.4;             /* offending the empire costs this much more */
  var localEmpire = null;      /* used only when Factions has no empire */

  function factionEmpire() {
    var F = sys('Factions');
    if (!F || !F.all) return null;
    var all = F.all();
    for (var i = 0; i < all.length; i++) {
      var f = all[i];
      if (f.kindId === 'empire' || (f.kind && f.kind.techLevel === 'spacer' && !f.permanentEnemy)) {
        return f;
      }
    }
    return null;
  }

  function makeLocalEmpire() {
    var kind = Defs.maybe && Defs.maybe('factionKind', 'empire');
    var seedState = U.getSeed();
    U.seed((U.hash('royalty-empire') ^ (root.Game ? (root.Game.seed | 0) : 1)) >>> 0);
    var names = ['The Auros Imperium', 'The Celestia Dominion', 'The Varenne Realm',
                 'The Solmara Ascendancy', 'The Highmark Imperium'];
    var e = {
      id: 'empireRoyal',
      kindId: 'empire',
      kind: kind || null,
      name: U.pick(names),
      leaderTitle: U.pick(['Stellarch', 'Archduke', 'Archduchess', 'High Consul']),
      leaderName: U.pick(['Vaun Ordwin', 'Ilse Thessaly', 'Marek Caelum', 'Ariane Vindrel']),
      color: '#ffc23c',
      goodwill: U.randInt(-5, 20),
      hostile: false,
      local: true
    };
    U.setSeed(seedState);
    return e;
  }

  Royalty.empire = function () {
    var f = factionEmpire();
    if (f) { localEmpire = null; return f; }
    if (!localEmpire) localEmpire = makeLocalEmpire();
    return localEmpire;
  };

  Royalty.empireGoodwill = function () {
    var e = Royalty.empire();
    if (!e) return 0;
    if (e.local) return e.goodwill;
    var F = sys('Factions');
    return F && F.goodwill ? F.goodwill(e.id) : e.goodwill;
  };

  /* Praise is cheap to them and offence is not, which is the whole
     character of the faction: PRIDE multiplies only the losses, and
     sits on top of the kind's own goodwillLossFactor. */
  Royalty.adjustEmpire = function (delta, reason) {
    var e = Royalty.empire();
    if (!e) return 0;
    var d = delta < 0 ? delta * PRIDE : delta;
    if (e.local) {
      e.goodwill = U.clamp(Math.round(e.goodwill + d), -100, 100);
      e.hostile = e.goodwill <= -75;
      if (e.hostile) message(e.name + ' has declared you an enemy of the throne.', 'threat');
      return e.goodwill;
    }
    var F = sys('Factions');
    if (F && F.adjustGoodwill) return F.adjustGoodwill(e.id, d, reason || 'imperial business');
    return e.goodwill;
  };

  Royalty.empireHostile = function () {
    var e = Royalty.empire();
    if (!e) return false;
    return e.local ? !!e.hostile : !!e.hostile;
  };

  /* What a title is worth at the counter, and what it can call down. */
  Royalty.tradePriceFactor = function () {
    var best = Royalty.highestTitle();
    var bonus = best ? best.tradeFactor : 0;
    var gw = Royalty.empireGoodwill();
    return 1 + bonus + U.clamp(gw / 100, -0.2, 0.15);
  };

  Royalty.highestTitle = function () {
    var G = sys('Game');
    if (!G || !G.map) return null;
    var list = G.map.colonists(), best = null;
    for (var i = 0; i < list.length; i++) {
      var t = Royalty.titleOf(list[i]);
      if (t && (!best || t.rank > best.rank)) best = t;
    }
    return best;
  };

  /* A titled colonist can call the empire down on a raid. The soldiers
     arrive by pod next to the colony rather than walking in from the
     edge, which is the privilege being paid for. */
  Royalty.callAid = function (pawn, opts) {
    opts = opts || {};
    var title = Royalty.titleOf(pawn);
    if (!title || !title.aid) return { ok: false, reason: 'no title that can call for aid' };
    if (Royalty.empireHostile()) return { ok: false, reason: 'the empire is at war with you' };
    var G = sys('Game'), MG = sys('MapGen');
    var map = G && G.map;
    if (!map || !MG || !MG.makePawn) return { ok: false, reason: 'no map' };

    var st = titleState(pawn);
    var cooldown = 2 * TICKS_PER_DAY;
    if (st.lastAidTick && now() - st.lastAidTick < cooldown) {
      return { ok: false, reason: 'the empire answered recently' };
    }
    var spot = MG.dropPodSpot ? MG.dropPodSpot(map) : null;
    if (!spot) return { ok: false, reason: 'nowhere to land' };

    var count = U.clamp(Math.round(title.aid / 60), 1, 6);
    var spawned = [];
    for (var i = 0; i < count; i++) {
      var cell = nearestFreeCell(map, spot.x, spot.y, 4) || spot;
      var soldier = MG.makePawn('colonist', 'neutral', { x: cell.x, y: cell.y, map: map });
      if (!soldier) continue;
      soldier.royalAid = true;
      map.addPawn(soldier, cell.x, cell.y);
      spawned.push(soldier);
    }
    if (!spawned.length) return { ok: false, reason: 'nobody came' };
    st.lastAidTick = now();
    letter('Imperial aid', (Royalty.empire().name) + ' honours ' + nameOf(pawn) + '\'s rank: ' +
      spawned.length + ' soldiers came down by pod beside the colony.', 'good', spot);
    return { ok: true, pawns: spawned };
  };

  /* ============================================================
     6. HONOR AND TITLES
     ============================================================ */

  Royalty.addHonor = function (pawn, n, reason) {
    if (!pawn || !pawn.isHuman || !(n > 0)) return 0;
    var st = titleState(pawn);
    st.honor += n;
    if (pawn.faction === 'player') {
      message(nameOf(pawn) + ' earned ' + Math.round(n) + ' honor (' + (reason || 'service') + ').',
        'good', pawn);
    }
    return st.honor;
  };

  Royalty.spendHonor = function (pawn, n) {
    var st = titleState(pawn);
    if (st.honor < n) return false;
    st.honor -= n;
    return true;
  };

  /* The UI asks this to decide whether to offer the ceremony at all. */
  Royalty.canBeGranted = function (pawn) {
    if (!pawn || !pawn.isHuman || pawn.dead) return { ok: false, reason: 'not a colonist' };
    if (pawn.faction !== 'player') return { ok: false, reason: 'not one of yours' };
    if (Royalty.empireHostile()) return { ok: false, reason: 'the empire is at war with you' };
    var st = titleState(pawn);
    var current = Royalty.titleOf(pawn);
    var next = TITLES[current ? current.rank + 1 : 0];
    if (!next) return { ok: false, reason: 'already a consul' };
    if (st.honor < next.honor) {
      return { ok: false, reason: 'needs ' + (next.honor - Math.floor(st.honor)) + ' more honor',
               titleId: next.id, honorNeeded: next.honor - st.honor };
    }
    return { ok: true, titleId: next.id, honorNeeded: 0 };
  };

  Royalty.grantTitle = function (pawn, titleId) {
    if (!pawn || !pawn.isHuman) return false;
    var title = TITLE_BY_ID[titleId];
    if (!title) return false;
    var st = titleState(pawn);
    var old = Royalty.titleOf(pawn);
    if (old && old.rank >= title.rank) return false;

    /* The honor is spent, not merely proven: a colony cannot hold ten
       barons on one quest's worth of favour. */
    if (st.honor >= title.honor) st.honor -= title.honor;

    restoreWork(pawn);
    st.id = title.id;
    st.grantedTick = now();
    suspendWork(pawn, title);

    if (title.psylink > 0) Royalty.setPsylink(pawn, Math.max(psyOf(pawn).level, title.psylink));

    addThought(pawn, 'titleGranted');
    letter('A title granted', nameOf(pawn) + ' is now a ' + title.label + ' of ' +
      Royalty.empire().name + '. They will want quarters to match, and they will not be ' +
      'hauling anything they consider beneath them.', 'good', pawn);
    return true;
  };

  Royalty.revokeTitle = function (pawn, reason) {
    var title = Royalty.titleOf(pawn);
    if (!title) return false;
    var st = titleState(pawn);
    restoreWork(pawn);
    st.id = null;
    st.revokedTick = now();
    addThought(pawn, 'titleRevoked');
    letter('A title revoked', nameOf(pawn) + ' is no longer a ' + title.label + '. ' +
      (reason || 'The empire did not explain itself.'), 'threat', pawn);
    return true;
  };

  /* Work the holder refuses is switched off in the work tab rather
     than refused at the last moment, so the player can see why the
     baron is standing next to a crate doing nothing. The old
     priorities are kept so a revoked title gives the column back. */
  function suspendWork(pawn, title) {
    if (!pawn.workPriority || !title.refusedWork.length) return;
    var st = titleState(pawn);
    var kept = st.suspended || {};
    for (var i = 0; i < title.refusedWork.length; i++) {
      var id = title.refusedWork[i];
      if (pawn.workPriority[id] === undefined) continue;
      if (kept[id] === undefined) kept[id] = pawn.workPriority[id];
      pawn.workPriority[id] = 0;
    }
    st.suspended = kept;
  }

  function restoreWork(pawn) {
    var st = pawn.title;
    if (!st || !st.suspended || !pawn.workPriority) return;
    for (var id in st.suspended) {
      if (pawn.workPriority[id] !== undefined) pawn.workPriority[id] = st.suspended[id];
    }
    st.suspended = null;
  }

  /* ============================================================
     7. DEMANDS

     The real gameplay of a title: a room worthy of the rank, clothes
     worthy of the rank, and work beneath it left alone.
     ============================================================ */

  /* One number out of the room stats Regions already keeps. Beauty
     carries most of it because that is the stat a player can actually
     move; size and the wealth standing in the room do the rest. */
  Royalty.roomImpressiveness = function (room) {
    if (!room || room.outdoor) return 0;
    var beauty = U.clamp01((room.beauty + 4) / 34);
    var space = U.clamp01(room.size / 70);
    var wealth = U.clamp01(room.wealth / 2600);
    var clean = U.clamp01((room.cleanliness + 1) / 2.4);
    return U.clamp01(0.48 * beauty + 0.24 * space + 0.18 * wealth + 0.10 * clean);
  };

  function bedroomOf(pawn) {
    var map = pawn.map;
    if (!map || !pawn.ownedBedId) return null;
    var bed = map.thing(pawn.ownedBedId);
    if (!bed || !bed.spawned) return null;
    var R = sys('Regions');
    if (!R || !R.roomAt) return null;
    return R.roomAt(map, bed.x, bed.y);
  }

  function wearsNoble(pawn) {
    var list = pawn.apparel || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].def && list[i].def.royalApparel) return true;
    }
    return false;
  }

  Royalty.demandsMet = function (pawn) {
    var title = Royalty.titleOf(pawn);
    if (!title) return { ok: true, unmet: [] };
    var unmet = [];

    if (title.bedroomCells > 0) {
      var room = bedroomOf(pawn);
      if (!room) {
        unmet.push({ id: 'bedroom', label: 'no bedroom of their own', severity: 2 });
      } else if (room.size < title.bedroomCells) {
        unmet.push({ id: 'bedroomSize',
          label: 'bedroom is ' + room.size + ' tiles, wants ' + title.bedroomCells,
          severity: 1 });
      } else if (Royalty.roomImpressiveness(room) < title.bedroomImpressive) {
        unmet.push({ id: 'bedroomImpressive',
          label: 'bedroom is not impressive enough (' +
            Math.round(Royalty.roomImpressiveness(room) * 100) + '/' +
            Math.round(title.bedroomImpressive * 100) + ')',
          severity: 1 });
      }
    }

    if (title.apparel && !wearsNoble(pawn)) {
      unmet.push({ id: 'apparel', label: 'wears nothing befitting the rank', severity: 1 });
    }

    return { ok: unmet.length === 0, unmet: unmet, title: title };
  };

  /* Refused work that somehow happened anyway - a player forcing the
     job by hand, which is allowed and costs mood. */
  function checkDegradingWork(pawn, title) {
    var job = pawn.job;
    if (!job || !job.def) return;
    var wt = DEGRADING_JOBS[job.defId];
    if (!wt) return;
    if (title.refusedWork.indexOf(wt) < 0) return;
    addThought(pawn, 'titleDegraded');
  }

  var DEGRADING_JOBS = {
    haul: 'haul', haulToContainer: 'haul', clean: 'clean', bury: 'haul',
    mine: 'mine', cutPlant: 'plantCut', chopWood: 'plantCut',
    sow: 'grow', harvest: 'grow', refuel: 'basic'
  };

  function applyDemandThoughts(pawn) {
    var title = Royalty.titleOf(pawn);
    if (!title) return;
    var st = titleState(pawn);
    var result = Royalty.demandsMet(pawn);
    st.unmet = result.unmet.map(function (u) { return u.id; });

    if (result.ok) {
      addThought(pawn, 'titleHonoured', { duration: 0.5 * TICKS_PER_DAY, noStack: true });
    } else {
      var bedroom = null, apparel = false, i;
      for (i = 0; i < result.unmet.length; i++) {
        if (result.unmet[i].id === 'apparel') apparel = true;
        else bedroom = result.unmet[i];
      }
      if (bedroom) {
        /* How badly it stings scales with the rank as well as with the
           room: a yeoman in a shed is disappointed, a duke is furious. */
        var degree = U.clamp(Math.floor(title.rank / 3) + (bedroom.severity - 1), 0, 2);
        addThought(pawn, 'titleNoBedroom', { degree: degree, duration: 0.5 * TICKS_PER_DAY,
                                             noStack: true });
      }
      if (apparel) {
        addThought(pawn, 'titleNoApparel', { degree: title.rank >= 6 ? 1 : 0,
                                             duration: 0.5 * TICKS_PER_DAY, noStack: true });
      }
    }
    checkDegradingWork(pawn, title);
  }

  /* ============================================================
     8. PSYLINK, PSYFOCUS AND ENTROPY
     ============================================================ */

  Royalty.setPsylink = function (pawn, level) {
    var psy = psyOf(pawn);
    level = U.clamp(level | 0, 0, MAX_PSYLINK);
    if (level <= psy.level) return false;
    var gained = level - psy.level;
    psy.level = level;
    learnPsycasts(pawn, psy, gained * 2);
    addThought(pawn, 'psylinkGained');
    if (pawn.faction === 'player') {
      message(nameOf(pawn) + ' now carries a psylink of level ' + level + '.', 'good', pawn);
    }
    return true;
  };

  /* Two abilities per level, drawn from what the new level opens up
     and falling back to anything still unlearned, so a pawn who
     jumps three levels at once does not come away with nothing. */
  function learnPsycasts(pawn, psy, picks) {
    var all = Royalty.psycasts();
    for (var n = 0; n < picks; n++) {
      var pool = all.filter(function (d) {
        return d.level <= psy.level && psy.known.indexOf(d.id) < 0;
      });
      if (!pool.length) return;
      var atLevel = pool.filter(function (d) { return d.level === psy.level; });
      var chosen = U.pick(atLevel.length ? atLevel : pool);
      psy.known.push(chosen.id);
    }
  }

  Royalty.psycastsFor = function (pawn) {
    var psy = pawn && pawn.psy ? psyOf(pawn) : null;
    if (!psy || !psy.level) return [];
    var out = [];
    for (var i = 0; i < psy.known.length; i++) {
      var d = PSYCASTS[psy.known[i]];
      if (d && d.level <= psy.level) out.push(d);
    }
    return out;
  };

  Royalty.knows = function (pawn, id) {
    var psy = pawn && pawn.psy ? psyOf(pawn) : null;
    return !!(psy && psy.known.indexOf(id) >= 0);
  };

  /* Both meters catch up from the last time anybody looked rather
     than being stepped every tick. Calling this twice in one tick is
     therefore free, which is what makes it safe for the integrator to
     wire into game.js on top of the chain installed at the foot of
     this file. */
  Royalty.tickPawn = function (pawn) {
    if (!pawn || pawn.dead || pawn.isHuman === false) return;
    var psy = pawn.psy, title = pawn.title;
    if (!psy && !title) return;
    var t = now();

    if (psy) {
      var dt = t - (psy.t || t);
      if (dt < 0) dt = 0;
      if (dt >= 60) {
        psy.t = t;
        if (psy.entropy > 0) {
          psy.entropy = Math.max(0, psy.entropy - ENTROPY_DRAIN_PER_DAY * dt / TICKS_PER_DAY);
        }
        if (psy.level > 0 && psy.focus > 0 && !pawn.meditating) {
          psy.focus = U.clamp01(psy.focus - FOCUS_DECAY_PER_DAY * dt / TICKS_PER_DAY);
        }
        if (psy.invisUntil && t >= psy.invisUntil) {
          psy.invisUntil = 0;
          if (invisibleCount > 0) invisibleCount--;
        }
      }
    }

    /* The expensive half - room stats, worn apparel - runs on the
       contract's rare beat, staggered by pawn id. */
    if (((t + pawn.id) % RARE) !== 0) return;
    if (title && title.id) applyDemandThoughts(pawn);
    sweepSpentHediffs(pawn);
  };

  function sweepSpentHediffs(pawn) {
    var H = sys('Health');
    var h = pawn.health;
    if (!H || !h || !h.hediffs || !h.hediffs.length) return;
    for (var i = h.hediffs.length - 1; i >= 0; i--) {
      var hd = h.hediffs[i];
      if (!PSY_HEDIFFS[hd.id]) continue;
      if (hd.severity <= 0.02) H.removeHediff(pawn, hd.id);
    }
  }

  /* ---------- casting ---------- */

  Royalty.canCast = function (pawn, psycastId, target) {
    var def = PSYCASTS[psycastId];
    if (!def) return { ok: false, reason: 'no such psycast' };
    if (!pawn || pawn.dead || pawn.downed) return { ok: false, reason: 'cannot act' };
    if (pawn.mentalState) return { ok: false, reason: 'not in their right mind' };
    var psy = psyOf(pawn);
    if (psy.level < def.level) return { ok: false, reason: 'psylink level ' + def.level + ' needed' };
    if (psy.known.indexOf(psycastId) < 0) return { ok: false, reason: 'has not learned it' };
    if (psy.focus < def.psyfocus + FOCUS_FLOOR_FOR_CAST) {
      return { ok: false, reason: 'not enough psyfocus' };
    }
    if (psy.entropy + def.entropy > Royalty.entropyLimit(pawn) * 1.5) {
      return { ok: false, reason: 'too much neural heat' };
    }
    var ctx = resolveTarget(pawn, def, target);
    if (!ctx.ok) return { ok: false, reason: ctx.reason };
    return { ok: true, reason: null, def: def };
  };

  function resolveTarget(pawn, def, target) {
    var map = pawn.map;
    if (!map) return { ok: false, reason: 'not on a map' };
    if (def.target === 'self') {
      return { ok: true, map: map, x: pawn.x, y: pawn.y, pawn: pawn };
    }
    if (!target) return { ok: false, reason: 'needs a target' };

    var victim = null, pos = null;
    if (target.k === 'p' || target.k === 't') {
      victim = T.resolve(target, map);
      if (!victim) return { ok: false, reason: 'the target is gone' };
      pos = { x: victim.x, y: victim.y };
      if (victim.isHuman === undefined && victim.isAnimal === undefined) victim = null;
    } else {
      pos = T.pos(target, map);
    }
    if (!pos) return { ok: false, reason: 'no such place' };

    if (def.target === 'pawn' && !victim) return { ok: false, reason: 'needs a living target' };
    if (U.dist(pawn.x, pawn.y, pos.x, pos.y) > def.range) {
      return { ok: false, reason: 'out of range' };
    }
    var C = sys('Combat');
    if (C && C.lineOfSight && !C.lineOfSight(map, pawn.x, pawn.y, pos.x, pos.y)) {
      return { ok: false, reason: 'no line of sight' };
    }
    return { ok: true, map: map, x: pos.x, y: pos.y, pawn: victim };
  }

  /* The public entry point. With a job system in reach this starts a
     cast job so the warm-up is visible and interruptible; without one
     - a headless check, or a pawn who cannot hold a job - it resolves
     on the spot. */
  Royalty.cast = function (pawn, psycastId, target, opts) {
    opts = opts || {};
    var check = Royalty.canCast(pawn, psycastId, target);
    if (!check.ok) return check;
    var def = check.def;

    if (opts.immediate || !Jobs || !Jobs.make || !pawn.map) {
      return Royalty.resolveCast(pawn, psycastId, target);
    }
    var job = Jobs.make('psycast', target || null, null, {
      playerForced: true, state: { psycastId: psycastId, dest: opts.dest || null }
    });
    if (!Jobs.start(pawn, job)) return { ok: false, reason: 'could not begin the cast' };
    return { ok: true, reason: null, job: job, castTicks: def.castTicks };
  };

  /* The moment the warm-up ends: spend, apply, then pay the heat. */
  Royalty.resolveCast = function (pawn, psycastId, target, dest) {
    var check = Royalty.canCast(pawn, psycastId, target);
    if (!check.ok) return check;
    var def = check.def;
    var ctx = resolveTarget(pawn, def, target);
    if (!ctx.ok) return { ok: false, reason: ctx.reason };
    ctx.dest = dest || null;

    var psy = psyOf(pawn);
    var worked = false;
    try {
      worked = !!def.apply(pawn, ctx);
    } catch (e) {
      if (root.Game && root.Game.debug) console.log('[royalty] ' + psycastId + ' threw: ' + e);
      worked = false;
    }
    if (!worked) return { ok: false, reason: 'the cast found nothing to work on' };

    psy.focus = U.clamp01(psy.focus - def.psyfocus);
    psy.entropy += def.entropy;
    psy.t = now();
    if (pawn.faction === 'player') {
      message(nameOf(pawn) + ' cast ' + def.label + '.', 'info', pawn);
    }
    checkOverload(pawn, psy);
    return { ok: true, reason: null, def: def };
  };

  /* Entropy past the limit is a burn, not a warning: the caster drops
     and stays down while the heat bleeds off. */
  function checkOverload(pawn, psy) {
    var limit = Royalty.entropyLimit(pawn);
    if (psy.entropy <= limit) return false;
    var over = (psy.entropy - limit) / Math.max(1, limit);
    var H = sys('Health');
    if (H) H.addHediff(pawn, 'psychicComa', U.clamp01(0.35 + over));
    addThought(pawn, 'psychicBreakdown');
    if (H && over > 0.5) {
      H.damage(pawn, { amount: Math.round(6 + 10 * over), type: 'burn', partName: 'brain',
                       source: 'neural heat' });
    }
    interrupt(pawn);
    letter('Psychic breakdown', nameOf(pawn) + ' pushed past their entropy limit. Their mind is ' +
      'burning off the excess and they are not getting up until it stops.', 'threat', pawn);
    return true;
  }

  /* ---------- psyfocus and meditation ---------- */

  var FOCUS_OBJECTS = { animusStone: 0.48, sculpture: 0.30, treeOak: 0.22, treePine: 0.22,
                        standingLamp: 0.14, solarPinhole: 0.18 };
  var FOCUS_BARE = 0.10;
  var MEDITATE_RATE = 0.00062;     /* per tick, multiplied by the object's strength */
  var MEDITATE_MAX_TICKS = 5000;

  Royalty.focusStrength = function (thing) {
    if (!thing || !thing.def) return 0;
    if (thing.def.psyFocusStrength > 0) return thing.def.psyFocusStrength;
    return FOCUS_OBJECTS[thing.defId] || 0;
  };

  Royalty.focusObjectsNear = function (map, x, y, radius) {
    var out = [];
    for (var id in FOCUS_OBJECTS) {
      var list = map.byDef(id);
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t.spawned) continue;
        if (U.cheb(t.x, t.y, x, y) > radius) continue;
        out.push(t);
      }
    }
    var stones = map.byDef('animusStone');
    for (var s = 0; s < stones.length; s++) {
      if (stones[s].spawned && out.indexOf(stones[s]) < 0 &&
          U.cheb(stones[s].x, stones[s].y, x, y) <= radius) out.push(stones[s]);
    }
    return out;
  };

  Royalty.wantsToMeditate = function (pawn) {
    var psy = pawn && pawn.psy ? psyOf(pawn) : null;
    if (!psy || psy.level <= 0) return false;
    if (pawn.drafted || pawn.mentalState || pawn.downed) return false;
    return psy.focus < 0.72;
  };

  /* ============================================================
     9. JOBS

     Behaviour lives with the system that owns it, per the contract;
     the scan that hands the meditation job out lives in the work
     giver below it.
     ============================================================ */

  Jobs.register('psycast', {
    label: 'cast a psycast',
    reportString: function (job, pawn) {
      var def = PSYCASTS[job.state.psycastId];
      return 'Casting ' + (def ? def.label : 'a psycast') + '.';
    },
    allowGoneTarget: true,
    toils: function (job) {
      var def = PSYCASTS[job.state.psycastId];
      if (!def) return null;
      return [
        Toils.custom({
          name: 'warmup',
          init: function (pawn, j, s) {
            s.left = def.castTicks;
            if (pawn.stopPath) pawn.stopPath();
          },
          tick: function (pawn, j, s) {
            var pos = j.targetA ? T.pos(j.targetA, pawn.map) : null;
            if (pos) faceCell(pawn, pos.x, pos.y);
            if (--s.left > 0) return 'stay';
            var out = Royalty.resolveCast(pawn, def.id, j.targetA, j.state.dest);
            if (!out.ok && pawn.faction === 'player') {
              message(nameOf(pawn) + ' lost the cast: ' + out.reason + '.', 'info', pawn);
            }
            return 'done';
          }
        })
      ];
    }
  });

  Jobs.register('meditate', {
    label: 'meditate',
    reportString: 'Meditating.',
    toils: function () {
      return [
        Toils.goto('A', { pe: Path.PE.TOUCH, failIfGone: false }),
        Toils.custom({
          name: 'meditate',
          init: function (pawn, job, s) {
            var thing = job.targetA ? T.resolve(job.targetA, pawn.map) : null;
            s.strength = Royalty.focusStrength(thing) || FOCUS_BARE;
            s.ticks = 0;
            pawn.meditating = true;
            if (pawn.stopPath) pawn.stopPath();
            if (thing) faceCell(pawn, thing.x, thing.y);
          },
          tick: function (pawn, job, s) {
            var psy = psyOf(pawn);
            psy.focus = U.clamp01(psy.focus + MEDITATE_RATE * s.strength);
            psy.t = now();
            /* Sitting still with a clear head is also rest of a kind. */
            if ((s.ticks % 120) === 0) {
              var N = sys('Needs');
              if (N && N.gainJoy) N.gainJoy(pawn, 0.012, 'meditation');
            }
            if (++s.ticks >= MEDITATE_MAX_TICKS) return 'done';
            if (psy.focus >= 0.999) return 'done';
            if (pawn.drafted || pawn.mentalState) return 'done';
            return 'stay';
          },
          end: function (pawn, job, s) {
            pawn.meditating = false;
            if (s && s.ticks > 600) addThought(pawn, 'meditated');
          }
        })
      ];
    }
  });

  Jobs.register('useNeuroformer', {
    label: 'use a psylink neuroformer',
    reportString: 'Threading a psylink neuroformer.',
    toils: function () {
      return [
        Toils.goto('A', { pe: Path.PE.TOUCH, failIfGone: true }),
        Toils.work({
          amount: function () { return 240; },
          rate: function () { return 1; },
          failIfGone: true,
          onDone: function (pawn, job) {
            var thing = T.resolve(job.targetA, pawn.map);
            if (!thing) return 'fail';
            var psy = psyOf(pawn);
            if (psy.level >= MAX_PSYLINK) return 'fail';
            var map = pawn.map;
            if (thing.stack > 1) map.splitStack(thing, 1);
            else map.despawnThing(thing);
            Royalty.setPsylink(pawn, psy.level + 1);
            letter('A new psylink', nameOf(pawn) + ' threaded a neuroformer and came out the ' +
              'other side with another psychic link.', 'good', pawn);
            return null;
          }
        })
      ];
    }
  });

  /* The ceremony that turns favour into rank. A colonist stands at a
     focus object or their own bed for a while, and the empire counts
     it as service. */
  Jobs.register('bestowingCeremony', {
    label: 'hold a bestowing ceremony',
    reportString: 'Attending a bestowing ceremony.',
    allowGoneTarget: true,
    toils: function () {
      return [
        Toils.goto('A', { pe: Path.PE.TOUCH, failIfGone: false }),
        Toils.custom({
          name: 'ceremony',
          init: function (pawn, job, s) { s.left = 2400; if (pawn.stopPath) pawn.stopPath(); },
          tick: function (pawn, job, s) {
            if (--s.left > 0) return 'stay';
            var title = Royalty.titleOf(pawn);
            Royalty.addHonor(pawn, 40 + 12 * (title ? title.rank + 1 : 0), 'a bestowing ceremony');
            Royalty.noteCeremony(pawn);
            var can = Royalty.canBeGranted(pawn);
            if (can.ok) Royalty.grantTitle(pawn, can.titleId);
            return 'done';
          }
        })
      ];
    }
  });

  Royalty.useNeuroformer = function (pawn, thing) {
    if (!pawn || !thing || thing.defId !== 'psylinkNeuroformer') {
      return { ok: false, reason: 'not a neuroformer' };
    }
    if (psyOf(pawn).level >= MAX_PSYLINK) return { ok: false, reason: 'already at level six' };
    var job = Jobs.make('useNeuroformer', T.thing(thing), null, { playerForced: true });
    if (!Jobs.start(pawn, job)) return { ok: false, reason: 'could not start' };
    return { ok: true };
  };

  Royalty.beginCeremony = function (pawn) {
    if (!pawn || pawn.faction !== 'player') return { ok: false, reason: 'not one of yours' };
    if (Royalty.empireHostile()) return { ok: false, reason: 'the empire is at war with you' };
    var map = pawn.map;
    if (!map) return { ok: false, reason: 'no map' };
    var spots = Royalty.focusObjectsNear(map, pawn.x, pawn.y, 40);
    var at = spots.length ? spots[0] : (pawn.ownedBedId ? map.thing(pawn.ownedBedId) : null);
    var target = at ? T.thing(at) : T.cell(pawn.x, pawn.y);
    var job = Jobs.make('bestowingCeremony', target, null, { playerForced: true });
    if (!Jobs.start(pawn, job)) return { ok: false, reason: 'could not start' };
    return { ok: true };
  };

  /* Drafted colonists reach a psycast through this, so input.js can
     offer the list on a right click without knowing anything about
     entropy. A drafted pawn keeps its draft; the cast job simply
     outranks the drafted branch of the think tree. */
  Royalty.draftedCast = function (pawn, psycastId, target, opts) {
    if (!pawn || !pawn.drafted) return { ok: false, reason: 'not drafted' };
    return Royalty.cast(pawn, psycastId, target, opts);
  };

  /* ============================================================
     10. WORK

     One giver, on the column registered above. It only ever answers
     for a psycaster whose focus has slipped, which is why it can
     afford to look at every focus object on the map. */
  var WG = sys('WorkGivers');
  if (WG && WG.register) {
    WG.register({
      id: 'meditateAtFocus',
      workType: 'meditate',
      order: 10,
      label: 'meditate at a focus object',
      tryGiveJob: function (pawn) {
        if (!Royalty.wantsToMeditate(pawn)) return null;
        var map = pawn.map;
        var objects = Royalty.focusObjectsNear(map, pawn.x, pawn.y, 32);
        var best = null, bestScore = -1;
        for (var i = 0; i < objects.length; i++) {
          var o = objects[i];
          var target = T.thing(o);
          if (!Res.canReserve(pawn, target, 1)) continue;
          if (!Path.reachable(map, pawn.x, pawn.y, o.x, o.y, { pawn: pawn })) continue;
          var score = Royalty.focusStrength(o) * 30 - U.cheb(pawn.x, pawn.y, o.x, o.y);
          if (score > bestScore) { bestScore = score; best = o; }
        }
        if (!best) return null;
        var t = T.thing(best);
        if (!Res.reserve(pawn, t, 1)) return null;
        return Jobs.make('meditate', t, null, {});
      }
    });
  }

  /* ============================================================
     11. QUESTS

     The empire does not hand out honor for nothing. Three shapes of
     errand, all of them checked off the world rather than off a
     button: keep everyone alive, trade with them, or hold the
     ceremony they asked for.
     ============================================================ */

  var quests = [];
  var questSeq = 1;
  var empireTradeMark = -1;
  var incidentsReady = false;

  function newQuest(kind) {
    var honor = 0, label = '', days = 0;
    if (kind === 'endure') {
      days = U.randInt(3, 5);
      honor = 45 + days * 12;
      label = 'Hold your ground for ' + days + ' days without losing a colonist';
    } else if (kind === 'tribute') {
      days = U.randInt(6, 10);
      honor = 70;
      label = 'Trade with the empire before the deadline';
    } else {
      days = U.randInt(3, 6);
      honor = 55;
      label = 'Hold a bestowing ceremony before the deadline';
    }
    return {
      id: questSeq++, kind: kind, label: label, honor: honor,
      offeredTick: now(), expiresTick: now() + days * TICKS_PER_DAY,
      accepted: false, done: false, failed: false,
      colonistsAtStart: 0, ceremonies: 0
    };
  }

  Royalty.quests = function () {
    return quests.filter(function (q) { return !q.done && !q.failed; });
  };

  Royalty.offerQuest = function (kind) {
    if (Royalty.empireHostile()) return null;
    var live = Royalty.quests();
    if (live.length >= 2) return null;
    var q = newQuest(kind || U.pick(['endure', 'tribute', 'ceremony']));
    quests.push(q);
    letter('An imperial errand', Royalty.empire().name + ' offers ' + q.honor + ' honor: ' +
      q.label + '.', 'neutral');
    return q;
  };

  Royalty.acceptQuest = function (id) {
    var q = questById(id);
    if (!q || q.accepted || q.done || q.failed) return false;
    q.accepted = true;
    q.colonistsAtStart = colonistCount();
    q.ceremonies = ceremonyCount;
    empireTradeMark = empireTradeCount();
    return true;
  };

  Royalty.declineQuest = function (id) {
    var q = questById(id);
    if (!q || q.done) return false;
    q.failed = true;
    Royalty.adjustEmpire(-3, 'declined an imperial errand');
    return true;
  };

  function questById(id) {
    for (var i = 0; i < quests.length; i++) if (quests[i].id === id) return quests[i];
    return null;
  }

  var ceremonyCount = 0;
  Royalty.noteCeremony = function () { ceremonyCount++; };

  function colonistCount() {
    var G = sys('Game');
    return (G && G.map) ? G.map.colonists().length : 0;
  }

  function empireTradeCount() {
    var e = Royalty.empire();
    if (!e || e.local) return 0;
    return e.tradeCount || 0;
  }

  /* Honor is handed to the highest-ranking colonist who could use it,
     because that is who the empire was dealing with. */
  function awardQuest(q) {
    q.done = true;
    var G = sys('Game');
    var list = (G && G.map) ? G.map.colonists() : [];
    if (!list.length) return;
    var best = list[0];
    for (var i = 1; i < list.length; i++) {
      if (Royalty.honorOf(list[i]) > Royalty.honorOf(best)) best = list[i];
    }
    Royalty.addHonor(best, q.honor, 'an imperial errand');
    Royalty.adjustEmpire(4, 'completed an errand');
    letter('Errand complete', Royalty.empire().name + ' is satisfied. ' + nameOf(best) +
      ' gains ' + q.honor + ' honor.', 'good', best);
  }

  function tickQuests() {
    var t = now();
    for (var i = 0; i < quests.length; i++) {
      var q = quests[i];
      if (q.done || q.failed) continue;
      if (!q.accepted) {
        if (t > q.offeredTick + 1.5 * TICKS_PER_DAY) q.failed = true;
        continue;
      }
      if (q.kind === 'endure' && colonistCount() < q.colonistsAtStart) {
        q.failed = true;
        Royalty.adjustEmpire(-2, 'failed an errand');
        continue;
      }
      if (q.kind === 'tribute' && empireTradeCount() > empireTradeMark) { awardQuest(q); continue; }
      if (q.kind === 'ceremony' && ceremonyCount > q.ceremonies) { awardQuest(q); continue; }
      if (t >= q.expiresTick) {
        if (q.kind === 'endure') awardQuest(q);
        else { q.failed = true; Royalty.adjustEmpire(-2, 'let an errand lapse'); }
      }
    }
    if (quests.length > 24) quests.splice(0, quests.length - 24);
  }

  /* events.js loads after this file, so the incident is registered the
     first time the world ticks rather than at load. */
  function ensureIncidents() {
    if (incidentsReady) return;
    var I = sys('Incidents');
    if (!I || !I.register) return;
    incidentsReady = true;
    I.register({
      id: 'empireQuest',
      label: 'imperial errand',
      category: 'misc',
      minDay: 5,
      weight: function () {
        if (Royalty.empireHostile()) return 0;
        return Royalty.quests().length ? 0.2 : 1.1;
      },
      fire: function () { return !!Royalty.offerQuest(); }
    });
  }

  /* ============================================================
     12. THE GLOBAL TICK

     Cheap, self-guarding and driven from the pawn chain below, so the
     system runs today and costs nothing when an integrator wires
     Royalty.tick(map) into game.js as well.
     ============================================================ */

  var PSYCHIC_WALL_TICKS = 1800;      /* half a minute of firefight */
  var PINHOLE_TICKS = 1.2 * TICKS_PER_DAY;
  var lastGlobalTick = -1;

  Royalty.tick = function (map) {
    var t = now();
    if (t === lastGlobalTick) return;
    lastGlobalTick = t;
    ensureIncidents();

    if ((t % RARE) === 0) sweepTemporary(map);
    if ((t % 500) === 0) {
      tickQuests();
      watchEmpireTrade();
    }
  };

  function sweepTemporary(map) {
    if (!map || !map.byDef) return;
    expire(map, 'psychicWall', PSYCHIC_WALL_TICKS);
    expire(map, 'solarPinhole', PINHOLE_TICKS);
  }

  /* Lifetime is read off spawnTick, which save.js already carries, so
     a wall raised before a save still falls at the right moment after
     the load without Royalty holding a list of ids. */
  function expire(map, defId, lifetime) {
    var list = map.byDef(defId);
    if (!list || !list.length) return;
    var t = now();
    for (var i = list.length - 1; i >= 0; i--) {
      var thing = list[i];
      if (!thing.spawned) continue;
      if (t - (thing.spawnTick || 0) < lifetime) continue;
      map.destroyThing(thing, 'the psycast ended');
    }
  }

  /* Selling to the empire is honor, and factions.js already counts the
     deals, so the counter is watched rather than trade.js being asked
     to call anybody. */
  function watchEmpireTrade() {
    var e = Royalty.empire();
    if (!e || e.local) return;
    var count = e.tradeCount || 0;
    if (empireTradeMark < 0) { empireTradeMark = count; return; }
    if (count <= empireTradeMark) return;
    var deals = count - empireTradeMark;
    empireTradeMark = count;
    var G = sys('Game');
    var list = (G && G.map) ? G.map.colonists() : [];
    if (!list.length) return;
    var best = list[0];
    for (var i = 1; i < list.length; i++) {
      if (Royalty.honorOf(list[i]) > Royalty.honorOf(best)) best = list[i];
    }
    Royalty.addHonor(best, 8 * deals, 'trade with the empire');
  }

  /* ============================================================
     13. SAVE
     ============================================================ */

  Royalty.save = function () {
    var e = Royalty.empire();
    return {
      v: 1,
      localEmpire: (e && e.local) ? {
        id: e.id, name: e.name, leaderTitle: e.leaderTitle, leaderName: e.leaderName,
        goodwill: e.goodwill, hostile: !!e.hostile
      } : null,
      quests: quests.map(function (q) {
        return {
          id: q.id, kind: q.kind, label: q.label, honor: q.honor,
          offeredTick: q.offeredTick, expiresTick: q.expiresTick,
          accepted: q.accepted, done: q.done, failed: q.failed,
          colonistsAtStart: q.colonistsAtStart, ceremonies: q.ceremonies
        };
      }),
      questSeq: questSeq,
      ceremonies: ceremonyCount,
      tradeMark: empireTradeMark
    };
  };

  Royalty.load = function (obj) {
    quests.length = 0;
    questSeq = 1;
    ceremonyCount = 0;
    empireTradeMark = -1;
    localEmpire = null;
    invisibleCount = 0;
    lastGlobalTick = -1;
    if (!obj) return false;
    if (obj.localEmpire) {
      localEmpire = {
        id: obj.localEmpire.id || 'empireRoyal', kindId: 'empire',
        kind: Defs.maybe ? Defs.maybe('factionKind', 'empire') : null,
        name: obj.localEmpire.name || 'The Auros Imperium',
        leaderTitle: obj.localEmpire.leaderTitle || 'Stellarch',
        leaderName: obj.localEmpire.leaderName || 'Vaun Ordwin',
        color: '#ffc23c',
        goodwill: obj.localEmpire.goodwill || 0,
        hostile: !!obj.localEmpire.hostile,
        local: true
      };
    }
    if (obj.quests) for (var i = 0; i < obj.quests.length; i++) quests.push(obj.quests[i]);
    if (typeof obj.questSeq === 'number') questSeq = obj.questSeq;
    if (typeof obj.ceremonies === 'number') ceremonyCount = obj.ceremonies;
    if (typeof obj.tradeMark === 'number') empireTradeMark = obj.tradeMark;

    /* An invisible pawn restored from a save has to be counted again,
       or the fast path in the targeting chain stays switched off. */
    var G = sys('Game');
    if (G && G.map) {
      var pawns = G.map.pawns;
      for (var p = 0; p < pawns.length; p++) {
        if (pawns[p].psy && pawns[p].psy.invisUntil > now()) invisibleCount++;
      }
    }
    return true;
  };

  Royalty.reset = function () {
    quests.length = 0;
    questSeq = 1;
    ceremonyCount = 0;
    empireTradeMark = -1;
    localEmpire = null;
    invisibleCount = 0;
    lastGlobalTick = -1;
  };

  /* ============================================================
     14. SMALL HELPERS
     ============================================================ */

  function nameOf(pawn) {
    var n = pawn && pawn.name;
    if (!n) return 'somebody';
    return n.nick || n.first || 'somebody';
  }

  function message(text, type, at) {
    var G = sys('Game');
    if (!G || !G.msg) return;
    G.msg(text, at ? { type: type, x: at.x, y: at.y } : { type: type });
  }

  function letter(title, text, kind, at) {
    var G = sys('Game');
    if (!G || !G.letter) return;
    G.letter(title, text, at ? { kind: kind, x: at.x, y: at.y } : { kind: kind });
  }

  function addThought(pawn, id, opts) {
    var N = sys('Needs');
    if (N && N.addThought) N.addThought(pawn, id, opts || {});
  }

  function interrupt(pawn) {
    if (!pawn) return;
    if (pawn.job && Jobs && Jobs.end) Jobs.end(pawn, 'interrupted');
    if (pawn.stopPath) pawn.stopPath();
  }

  function faceCell(pawn, x, y) {
    var dx = x - pawn.x, dy = y - pawn.y;
    if (!dx && !dy) return;
    if (Math.abs(dx) > Math.abs(dy)) pawn.dir = dx > 0 ? 1 : 3;
    else pawn.dir = dy > 0 ? 0 : 2;
  }

  function nearestFreeCell(map, x, y, radius) {
    var ring = U.cellsInRadius(x, y, radius);
    for (var i = 0; i < ring.length; i++) {
      var cx = ring[i][0], cy = ring[i][1];
      if (!map.inBounds(cx, cy) || !map.passable(cx, cy)) continue;
      if (map.pawnsAt(cx, cy).length) continue;
      return { x: cx, y: cy };
    }
    return null;
  }

  function teleport(pawn, x, y) {
    var map = pawn.map;
    if (!map || !map.inBounds(x, y) || !map.passable(x, y)) return false;
    var oldX = pawn.x, oldY = pawn.y;
    if (pawn.stopPath) pawn.stopPath();
    pawn.x = x; pawn.y = y;
    pawn.fx = x; pawn.fy = y;
    if (map.notePawnMoved) map.notePawnMoved(pawn, oldX, oldY);
    interrupt(pawn);
    return true;
  }

  /* ============================================================
     15. THE TWO CHAINS

     pawn.js has no per-pawn extension point and combat.js has no
     targeting filter, and neither file may be edited from here. Both
     originals are kept and called, so any other expansion that
     chains the same function composes with this one, and both
     additions bail in a property read when nothing royal is going on.
     ============================================================ */

  var invisibleCount = 0;

  (function chainPawnTick() {
    var P = root.Pawn;
    if (!P || !P.prototype || P.prototype.__royaltyChained) return;
    var base = P.prototype.tick;
    if (typeof base !== 'function') return;
    P.prototype.__royaltyChained = true;
    P.prototype.tick = function () {
      base.call(this);
      if (this.dead) return;
      Royalty.tickPawn(this);
      if (this.map) Royalty.tick(this.map);
    };
  })();

  (function chainHostility() {
    var C = sys('Combat');
    if (!C || !C.hostile || C.__royaltyChained) return;
    var base = C.hostile;
    C.__royaltyChained = true;
    C.hostile = function (a, b) {
      /* Nothing is invisible almost always, and this runs inside every
         target scan in the game, so the counter is the first thing
         read and the last word when it is zero. */
      if (invisibleCount > 0 && b && b.psy && b.psy.invisUntil > now()) return false;
      return base.call(C, a, b);
    };
  })();

  Royalty.isInvisible = function (pawn) {
    return !!(pawn && pawn.psy && pawn.psy.invisUntil > now());
  };

  /* ============================================================
     OUT OF SCOPE

     Mech clusters are not built and nothing here half-builds them:
     no mechanoid pawn kinds, no cluster generator, no defence
     structures and no activator buildings. They want a mechanoid
     faction, a body layout and a threat generator of their own, and a
     stub would only look like a bug.
     ============================================================ */

  root.Royalty = Royalty;
})(this);
