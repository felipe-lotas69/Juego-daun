/* ============================================================
   slavery.js - the colony decides that a person is property.

   prisoners.js owns capture, cells, warden work and recruitment.
   This file owns what happens when the answer to "what do we do with
   them" is neither "let them go" nor "make them one of us".

   Six things live here and they are one system, not six. A slave is
   cheap labour held down by suppression. Suppression is topped up by a
   warden's work and by terror. Terror is made out of collars, out of
   executions people watched, and out of bodies left on poles where the
   cells can see them. Every one of those costs the mood of anyone who
   is not a psychopath and whose faith does not say otherwise. Selling a
   person costs you every decent civilization on the planet. And the
   colony that butchers its enemies and eats them is the same colony,
   spending the same currency: what it is willing to do to a body, and
   what its people carry around afterwards.

   Which is the trade the player is being offered. Slaves work for
   nothing and never have to be talked round. They will, eventually,
   pick up a knife and come looking for you.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;
  var T = root.T;
  var Res = root.Res;
  var Jobs = root.Jobs;
  var Toils = root.Toils;
  var Path = root.Path;
  var Regions = root.Regions;
  var WorkGivers = root.WorkGivers;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  /* ideology.js loads after this file, so every reference to it is made
     through here, from inside a function body, at tick time. */
  function sys(name) { return root[name] || null; }
  function now() { var G = root.Game; return G ? (G.tick | 0) : 0; }

  /* ============================================================
     0. NUMBERS

     Per-day rates are divided by the rare beat where they are spent,
     which is the contract's arithmetic and not a place for surprises.
     ============================================================ */

  var DAY = 60000;
  var RARE = 250;              /* the staggered beat a slave runs on    */
  var COLONY_BEAT = 500;       /* the colony-wide sweep                 */
  var SCAN_BEAT = 2000;        /* corpses, graves - the slow furniture  */

  /* Suppression falls this fast for one slave with nothing holding them
     down, so a fresh slave is back at the rebellion line in about four
     days if nobody ever walks into the room. */
  var SUPPRESSION_FALL_PER_DAY = 0.26;
  var REBEL_AT = 0.14;         /* below this they start rolling for it  */
  var REBEL_JOIN = 0.40;       /* who else walks out with them          */
  var WARN_AT = 0.30;          /* the alert line, for letters           */

  var SUPPRESS_WORK = 620;     /* one suppression session, in work units */
  var SUPPRESS_BASE = 0.34;    /* what it puts back at social 0          */
  var SUPPRESS_PER_SOCIAL = 0.018;
  var SUPPRESS_COOLDOWN = 7000;
  var SUPPRESS_AT = 0.72;      /* a warden tops them up below this       */
  var BEATING_BELOW = 0.28;    /* a session this low turns into a beating */

  var COLLAR_WORK = 300;
  var ENSLAVE_WORK = 500;
  var FREE_WORK = 200;
  var DISPLAY_WORK = 420;
  var ENTOMB_WORK = 900;

  var TERROR_COLLAR = 0.26;
  var TERROR_PER_CORPSE = 0.14;
  var TERROR_CORPSE_CAP = 0.42;
  var TERROR_EXECUTION = 0.22;
  var TERROR_BEATING = 0.18;
  var TERROR_RADIUS = 14;      /* how far a body on a pole carries      */
  var EXECUTION_MEMORY = DAY * 2;
  var BEATING_MEMORY = DAY;

  var DISPLAY_DAYS = 6;        /* a displayed body falls apart in the end */
  var ROT_NOTICE_TICKS = DAY;  /* how long a body lies before it is a slight */

  /* What a person is worth over a counter. Deliberately large: the
     point of the number is that the player can see what they are
     trading every decent faction's opinion for. */
  var SLAVE_BASE_VALUE = 900;

  var SLAVE_FORBIDDEN_WORK = {
    warden: 1,      /* you do not put the property in charge of property */
    doctor: 1,      /* nor hand it the scalpels                          */
    research: 1,
    hunt: 1,        /* hunting is a rifle with extra steps               */
    meditate: 1
  };

  /* What canDo answers no to, beyond the work columns. */
  var SLAVE_FORBIDDEN_ACTIONS = {
    weapon: 1, equipWeapon: 1, draft: 1, lead: 1, leadership: 1, role: 1,
    ritual: 1, trade: 1, negotiate: 1, warden: 1, doctor: 1, research: 1,
    hunt: 1, arrest: 1, ownRoom: 1
  };

  var Slavery = {};
  Slavery.REBEL_AT = REBEL_AT;
  Slavery.SUPPRESSION_FALL_PER_DAY = SUPPRESSION_FALL_PER_DAY;

  /* ============================================================
     1. SMALL HELPERS
     ============================================================ */

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    var n = pawn.name;
    if (!n) return 'someone';
    return n.nick || n.first || 'someone';
  }

  function fullName(pawn) {
    if (pawn && typeof pawn.fullName === 'function') return pawn.fullName();
    return nameOf(pawn);
  }

  function msg(text, pawn, type) {
    var G = sys('Game');
    if (!G || !G.msg) return;
    G.msg(text, { type: type || 'info', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }

  function letter(title, text, kind, pawn) {
    var G = sys('Game');
    if (!G || !G.letter) return;
    G.letter(title, text, { kind: kind || 'neutral', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }

  function think(pawn, thoughtId, opts) {
    var N = sys('Needs');
    if (!N || !N.addThought || !pawn || !pawn.thoughts || pawn.dead) return;
    N.addThought(pawn, thoughtId, opts);
  }

  function hasTrait(pawn, id) {
    var list = pawn && pawn.traits;
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === id || (list[i] && list[i].id === id)) return true;
    }
    return false;
  }

  function skillLevel(pawn, id) {
    var s = pawn && pawn.skills && pawn.skills[id];
    return s ? (s.level | 0) : 0;
  }

  function moodOf(pawn) {
    var N = sys('Needs');
    if (N && N.mood) return N.mood(pawn);
    return typeof pawn.mood === 'number' ? pawn.mood : 0.5;
  }

  function isHumanPawn(pawn) {
    return !!(pawn && pawn.isHuman && !pawn.isAnimal);
  }

  /* Everyone who can hold an opinion about what the colony just did:
     alive, human, ours, and not the property being discussed. */
  function witnesses(map) {
    var out = [];
    if (!map) return out;
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.dead || !isHumanPawn(p)) continue;
      if (p.faction !== 'player') continue;
      if (p.prisoner || p.slave) continue;
      out.push(p);
    }
    return out;
  }

  function reachable(map, pawn, x, y) {
    if (!Path || !Path.reachable) return true;
    return Path.reachable(map, pawn.x, pawn.y, x, y, { pawn: pawn });
  }

  function nearest(pawn, list) {
    if (!list.length) return null;
    if (!Path || !Path.closestReachable) return list[0];
    return Path.closestReachable(pawn.map, pawn, list, null);
  }

  function claimed(pawn, defId, target, targetB) {
    if (!Res.reserve(pawn, target, 1)) return null;
    var job = Jobs.make(defId, target, targetB || null);
    if (!job) Res.release(pawn, target);
    return job;
  }

  /* ---------- the ideology bridge ----------

     ideology.js already owns the precepts this system cares about -
     slavery, cannibalism, corpses, execution - and already turns an
     action into the right thought for the faith holding it. When it is
     loaded it is the authority and this file only tells it what
     happened. When it is not, the fallback thoughts below are the
     whole of the colony's conscience. */

  function ideo() { return sys('Ideology'); }

  function noteAction(pawn, action, opts) {
    var I = ideo();
    if (!I || !I.noteAction) return false;
    return I.noteAction(pawn, action, opts) !== null;
  }

  /* Does the colony's faith permit this at all - 'eatHumanMeat',
     'butcherHuman', 'slaveOwned', 'prisonerExecuted'. An absent ideology
     permits everything, because the mood penalty is the only brake the
     game has without one. Exposed because a float menu should grey an
     order out rather than let a colonist be told to break their faith. */
  function faithAllows(pawn, action) {
    var I = ideo();
    if (!I || !I.allows) return true;
    return I.allows(pawn || null, action);
  }
  Slavery.faithAllows = faithAllows;

  function faithApprovesSlavery(pawn) {
    var I = ideo();
    if (!I || !I.precept) return false;
    var d = I.precept(pawn || null, 'slavery');
    return !!d && (d.id === 'acceptable' || d.id === 'honourable');
  }

  function faithApprovesCannibalism(pawn) {
    var I = ideo();
    if (!I || !I.precept) return false;
    var d = I.precept(pawn || null, 'cannibalism');
    return !!d && (d.id === 'acceptable' || d.id === 'preferred' || d.id === 'required');
  }

  /* One call, two worlds: hand it to ideology.js if it is here, and
     fall back to this file's own thought otherwise. A pawn who cannot
     feel the thing at all - a psychopath, mostly - falls out of both. */
  function moralise(pawn, action, fallbackId, opts) {
    if (!pawn || pawn.dead || !isHumanPawn(pawn)) return;
    if (noteAction(pawn, action, opts)) return;
    think(pawn, fallbackId, opts);
  }

  /* ============================================================
     2. CONTENT

     def_things.js keeps its field templates private, so the shapes are
     restated. Everything registered here is namespaced or obviously
     new; nothing already in the registry is redefined.
     ============================================================ */

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
    stackLimit: 75, mass: 0.5, marketValue: 1,
    nutrition: 0, foodType: null, rotDays: null,
    isMedicine: false, medicinePotency: 0,
    passable: true, pathCost: 0, fillPercent: 0, blocksLight: false, holdsRoof: false,
    size: { w: 1, h: 1 }, rotatable: false, hp: 60, flammable: true,
    beauty: 0, comfort: 0, natural: false,
    buildCost: null, stuffable: false, workToBuild: 0, buildSkill: null,
    buildCategory: null, researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null,
    building: null, weapon: null, apparel: null,
    humanSourced: false
  };

  function itemDefaults(over) {
    var out = {}, k;
    for (k in ITEM_DEFAULTS) out[k] = ITEM_DEFAULTS[k];
    if (over) for (k in over) out[k] = over[k];
    return out;
  }

  /* ---------- the food nobody admits to ---------- */

  Defs.add('thing', {

    humanMeat: {
      label: 'human meat',
      description: 'Meat off a person. It keeps as well as any other meat and feeds a colonist ' +
        'just as far, which is exactly the problem with it.',
      sprite: 'meat', color: '#c25f57', color2: '#7d2c28',
      stackLimit: 75, mass: 0.05, marketValue: 0.8,
      nutrition: 0.05, foodType: 'raw', rotDays: 2.5, hp: 40,
      humanSourced: true
    },

    humanLeather: {
      label: 'human leather',
      description: 'Cured from a person. Warm, hard-wearing, and worth less than cowhide to ' +
        'anyone who knows where it came from.',
      sprite: 'cloth', color: '#b08878', color2: '#8a6355',
      stackLimit: 75, mass: 0.08, marketValue: 1.4, hp: 60,
      humanSourced: true
    },

    mealSimpleHuman: {
      label: 'simple meal (human)',
      description: 'A plain cooked meal made out of a person. It fills the same hole a proper ' +
        'one would and leaves a different one.',
      sprite: 'meal', color: '#c9906b', color2: '#8a3134',
      stackLimit: 10, mass: 0.44, marketValue: 9,
      nutrition: 0.9, foodType: 'meal', rotDays: 5, hp: 50,
      humanSourced: true
    },

    mealFineHuman: {
      label: 'fine meal (human)',
      description: 'Meat and vegetables, cooked properly, and the meat was somebody. Whoever ' +
        'eats it will be very clear on that.',
      sprite: 'meal', color: '#d8a878', color2: '#a8383c',
      stackLimit: 10, mass: 0.44, marketValue: 16,
      nutrition: 0.9, foodType: 'meal', rotDays: 5, hp: 50,
      humanSourced: true
    },

    slaveCollar: {
      label: 'slave collar',
      description: 'A banded steel ring, locked at the back. It does nothing a rope could not ' +
        'do; it is worn so that everybody who looks at the wearer knows what they are.',
      sprite: 'item', color: '#6e6e78', color2: '#3d3d46',
      stackLimit: 1, mass: 1.5, marketValue: 70, hp: 90, flammable: false,
      apparel: {
        slots: ['neck'], layer: 'onSkin',
        armorSharp: 0.02, armorBlunt: 0.02,
        insulationCold: 0, insulationHeat: 0, coverage: 0.2
      }
    }

  }, itemDefaults());

  var BUILDING_DEFAULTS = itemDefaults({
    category: 'building', sprite: 'box', stackLimit: 1,
    mass: 20, marketValue: 0, hp: 120,
    passable: false, pathCost: 0, fillPercent: 1,
    blocksLight: false, holdsRoof: false, flammable: false,
    buildSkill: 'construction', building: bld({})
  });

  Defs.add('thing', {

    /* A grave that says something. Mechanically it is a grave with a
       better mood on it and a stone bill of materials, which is the
       whole of the difference between burying somebody and burying
       somebody properly. */
    sarcophagus: {
      label: 'sarcophagus',
      description: 'A cut stone box with a lid, for a colonist the colony intends to remember. ' +
        'Slower and dearer than a hole in the ground, and everybody can tell.',
      sprite: 'grave', color: '#7d7d88', color2: '#c9b48a',
      size: { w: 1, h: 2 }, rotatable: true, hp: 320, mass: 120,
      passable: false, fillPercent: 0.6, beauty: 6, marketValue: 120,
      buildCost: { stoneBlocks: 50 }, workToBuild: ENTOMB_WORK + 900,
      buildCategory: 'furniture',
      building: bld({ isGrave: true, interactionOffset: { dx: 0, dy: 2 } })
    },

    /* The other end of the same idea. A pole with a body on it, facing
       the cells. It is the cheapest suppression in the game and the
       most expensive thing in the colony's head. */
    gibbet: {
      label: 'gibbet',
      description: 'A tarred post with a crossbar and a chain. Hang an enemy from it where the ' +
        'cells can see, and the cells stop talking about running. Everyone else stops talking too.',
      sprite: 'sculpture', color: '#4a3b2c', color2: '#8b1a1a',
      hp: 180, mass: 40, flammable: true,
      passable: false, fillPercent: 0.4, beauty: -14, marketValue: 30,
      buildCost: { wood: 35, steel: 5 }, workToBuild: 1100,
      buildCategory: 'security',
      building: bld({ interactionOffset: { dx: 0, dy: 1 } })
    }

  }, BUILDING_DEFAULTS);

  /* ---------- recipes ---------- */

  var RECIPE_DEFAULTS = {
    jobString: 'Working', skill: null, skillRequirement: 0,
    workType: 'craft', uiCategory: 'crafting', workbenches: [],
    products: {}, dynamicProducts: false, productQuality: false,
    researchPrerequisite: null,
    defaultRepeat: 'forever', defaultTargetCount: 0, defaultIngredientRadius: 999,
    foodPoisonChance: 0, description: ''
  };

  /* def_recipes.js resolves its ingredient categories out of a private
     table, so human meat can never wander into an ordinary meal. That
     is the right default - the player should have to ask for this - so
     these are separate bills rather than a widened category. */
  function humanIngredient(nutrition) {
    var ing = { anyOf: ['humanMeat'], nutrition: nutrition, count: Math.ceil(nutrition / 0.05) };
    ing.matches = function (thingDef) { return !!thingDef && thingDef.id === 'humanMeat'; };
    return ing;
  }

  function plantIngredient(nutrition) {
    var ids = ['riceRaw', 'potatoRaw', 'cornRaw', 'berries'];
    var set = {};
    ids.forEach(function (id) { set[id] = true; });
    var ing = { anyOf: ids, nutrition: nutrition, count: Math.ceil(nutrition / 0.05) };
    ing.matches = function (thingDef) { return !!thingDef && !!set[thingDef.id]; };
    return ing;
  }

  function acceptsAny(thingDef) {
    for (var i = 0; i < this.ingredients.length; i++) {
      if (this.ingredients[i].matches(thingDef)) return true;
    }
    return false;
  }

  Defs.add('recipe', {
    cookHumanMeal: {
      label: 'simple meal (human)', jobString: 'Cooking meal', uiCategory: 'cooking',
      workAmount: 300, skill: 'cooking', workType: 'cook',
      workbenches: ['stove', 'campfire'],
      ingredients: [humanIngredient(0.5)],
      products: { mealSimpleHuman: 1 }, foodPoisonChance: 0.02,
      defaultRepeat: 'count', defaultTargetCount: 10,
      description: 'Half a nutrition unit of human meat, cooked into one meal. It feeds a ' +
        'colonist exactly as far as any other meal does.'
    },
    cookFineHumanMeal: {
      label: 'fine meal (human)', jobString: 'Cooking fine meal', uiCategory: 'cooking',
      workAmount: 500, skill: 'cooking', skillRequirement: 6, workType: 'cook',
      workbenches: ['stove'],
      ingredients: [humanIngredient(0.4), plantIngredient(0.45)],
      products: { mealFineHuman: 1 }, foodPoisonChance: 0.015,
      defaultRepeat: 'count', defaultTargetCount: 6,
      description: 'Someone, with vegetables. The cook will remember making it.'
    },
    forgeSlaveCollar: {
      label: 'slave collar', jobString: 'Smithing', uiCategory: 'crafting',
      workAmount: 900, skill: 'crafting', skillRequirement: 2,
      workbenches: ['smithy', 'craftingSpot'],
      ingredients: [{ thing: 'steel', count: 25 }],
      products: { slaveCollar: 1 },
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'A banded ring of steel with a lock on the back. Worn, it keeps a slave ' +
        'quiet without anybody having to walk down to the cells.'
    }
  }, RECIPE_DEFAULTS);

  /* The two food recipes need the `accepts` helper def_recipes.js puts
     on its own table; production.js calls it while hunting ingredients
     and a recipe without one is a bill nobody can start. */
  ['cookHumanMeal', 'cookFineHumanMeal', 'forgeSlaveCollar'].forEach(function (id) {
    var r = Defs.maybe('recipe', id);
    if (!r) return;
    if (typeof r.accepts !== 'function') r.accepts = acceptsAny;
    r.ingredients.forEach(function (ing) {
      if (typeof ing.matches === 'function') return;
      var only = ing.thing;
      ing.matches = function (thingDef) { return !!thingDef && thingDef.id === only; };
    });
    /* foodPoisonChanceFor is left off on purpose: production.js falls
       back to its own skill curve, which is the same curve a normal
       meal is judged on. */
  });

  /* ---------- who yields human meat ----------

     butcherCorpse already asks the pawn kind what it is made of before
     it falls back to a generic slab of meat. Saying it on the human
     kinds is the whole of the wiring: no recipe changes hands, no
     private function in def_recipes.js is touched, and a colony that
     butchers a raider gets human meat out of an unmodified bill. */

  function markHumanKinds() {
    var kinds = Defs.all('pawnKind');
    for (var i = 0; i < kinds.length; i++) {
      var k = kinds[i];
      if (k.isAnimal || k.body !== 'human') continue;
      if (k.butcherProducts) continue;
      k.butcherProducts = { humanMeat: 34, humanLeather: 12 };
      if (!(k.leatherAmount > 0)) k.leatherAmount = 12;
      k.leatherDef = 'humanLeather';
    }
  }
  markHumanKinds();

  var HUMAN_FOOD = {
    humanMeat: 1, mealSimpleHuman: 1, mealFineHuman: 1
  };

  Slavery.isHumanFood = function (defOrId) {
    if (!defOrId) return false;
    var id = typeof defOrId === 'string' ? defOrId : defOrId.id;
    if (HUMAN_FOOD[id]) return true;
    return !!(typeof defOrId === 'object' && defOrId.humanSourced && defOrId.nutrition > 0);
  };

  /* ---------- traits ---------- */

  Defs.add('trait', {
    cannibal: {
      label: 'Cannibal', commonality: 0.16,
      description: 'Ate a person once under circumstances nobody asks about, and found they ' +
        'did not mind. Eats human meat with pleasure and thinks less of a colony that will not.',
      moodOffset: 0
    }
  }, {
    moodOffset: 0,
    skillGains: {},
    disabledWork: [],
    moveSpeedFactor: 1,
    workSpeedFactor: 1,
    mentalBreakThresholdOffset: 0,
    meleeFactor: 1,
    shootingFactor: 1,
    painFactor: 1,
    damageFactor: 1,
    hungerFactor: 1,
    restFallFactor: 1,
    learnFactor: 1,
    canDoJoy: true,
    forbidsFlee: false,
    commonality: 1.0
  });

  /* ---------- thoughts ----------

     These are the standalone conscience. Every one of them is skipped
     when ideology.js is loaded and has an opinion, because a precept
     ladder says the same thing with more nuance. Mood is in need units,
     the way needs.js states its own table. */

  var PSYCHOPATH = ['psychopath'];
  var PSYCHO_BLOOD = ['psychopath', 'bloodlust'];

  Defs.add('thought', {
    slaveryOwned: {
      label: 'We keep slaves', durationDays: 1, stackLimit: 1,
      nullifiedByTrait: PSYCHOPATH,
      stages: [
        { label: 'We keep a slave', mood: -0.05 },
        { label: 'We keep slaves', mood: -0.09 },
        { label: 'This place runs on slaves', mood: -0.14 }
      ]
    },
    slaveryBeating: {
      label: 'Saw a slave beaten', durationDays: 2, stackLimit: 3,
      nullifiedByTrait: PSYCHO_BLOOD,
      stages: [{ label: 'Saw a slave beaten', mood: -0.07 }]
    },
    slaveryEnslaved: {
      label: 'We enslaved someone', durationDays: 4, stackLimit: 2,
      nullifiedByTrait: PSYCHOPATH,
      stages: [{ label: 'We made a person into property', mood: -0.09 }]
    },
    slaverySold: {
      label: 'We sold a person', durationDays: 6, stackLimit: 3,
      nullifiedByTrait: PSYCHOPATH,
      stages: [{ label: 'We sold a person', mood: -0.14 }]
    },
    slaveryFreed: {
      label: 'We freed a slave', durationDays: 3, stackLimit: 1,
      stages: [{ label: 'We freed a slave', mood: 0.07 }]
    },
    slaveryRebellion: {
      label: 'A slave rebellion', durationDays: 4, stackLimit: 2,
      stages: [{ label: 'Our slaves turned on us', mood: -0.10 }]
    },

    /* What the property itself carries. */
    slaveryEnslavedSelf: {
      label: 'I am a slave', durationDays: 1, stackLimit: 1,
      stages: [
        { label: 'I am somebody\'s property', mood: -0.14 },
        { label: 'I am property and they remind me', mood: -0.22 }
      ]
    },
    slaverySuppressed: {
      label: 'Suppressed', durationDays: 0.5, stackLimit: 2,
      stages: [{ label: 'They came down to remind me', mood: -0.08 }]
    },
    slaveryBeaten: {
      label: 'Beaten', durationDays: 2, stackLimit: 3,
      stages: [{ label: 'They beat me', mood: -0.16 }]
    },
    slaveryTerror: {
      label: 'Terrified', durationDays: 0.6, stackLimit: 1,
      stages: [
        { label: 'There is a body on a pole out there', mood: -0.06 },
        { label: 'They hang people where I can see', mood: -0.11 }
      ]
    },
    slaveryTreatedWell: {
      label: 'Treated decently', durationDays: 0.6, stackLimit: 1,
      stages: [{ label: 'They treat me like a person', mood: 0.05 }]
    },
    slaveryFreedSelf: {
      label: 'They freed me', durationDays: 10, stackLimit: 1,
      stages: [{ label: 'They took the collar off me', mood: 0.18 }]
    },

    /* Cannibalism. Three stages because there are three kinds of
       person: the one who is horrified, the one who does not care, and
       the one who was waiting to be asked. */
    slaveryAteHuman: {
      label: 'Ate human meat', durationDays: 2, stackLimit: 3,
      nullifiedByTrait: PSYCHOPATH,
      stages: [
        { label: 'Ate human meat', mood: -0.25 },
        { label: 'Ate human meat', mood: -0.08 },
        { label: 'Ate a proper meal', mood: 0.10 }
      ]
    },
    slaveryButcheredHuman: {
      label: 'Butchered a human', durationDays: 2, stackLimit: 2,
      nullifiedByTrait: PSYCHO_BLOOD,
      stages: [
        { label: 'Butchered a person', mood: -0.20 },
        { label: 'Butchered a person', mood: -0.06 },
        { label: 'Put a body to good use', mood: 0.07 }
      ]
    },
    slaveryKnowsHumanMeat: {
      label: 'Human meat in the larder', durationDays: 0.6, stackLimit: 1,
      nullifiedByTrait: PSYCHOPATH,
      stages: [{ label: 'There are people in the larder', mood: -0.05 }]
    },

    /* Bodies: buried, left, or hung up on purpose. */
    slaveryBuriedWell: {
      label: 'Laid to rest', durationDays: 3, stackLimit: 2,
      stages: [
        { label: 'We buried our dead', mood: 0.04 },
        { label: 'We laid them in stone', mood: 0.08 }
      ]
    },
    slaveryLeftToRot: {
      label: 'A body left to rot', durationDays: 1.5, stackLimit: 3,
      nullifiedByTrait: PSYCHO_BLOOD,
      stages: [{ label: 'A body left lying about', mood: -0.06 }]
    },
    slaveryCorpseDisplayed: {
      label: 'A body on display', durationDays: 0.8, stackLimit: 2,
      nullifiedByTrait: PSYCHO_BLOOD,
      stages: [{ label: 'We hang people up outside', mood: -0.08 }]
    }
  });

  /* ============================================================
     3. BEING PROPERTY

     A slave is a player-faction human with a `slave` block and a
     suppression need. Nothing else in the game has to know: work givers
     hand them jobs off their work priorities like anybody, the think
     tree answers their hunger like anybody, and everything that makes
     them different from a colonist is a restriction applied here.
     ============================================================ */

  Slavery.isSlave = function (pawn) {
    return !!(pawn && pawn.slave && !pawn.dead);
  };

  Slavery.all = function (map) {
    var out = [];
    if (!map) return out;
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (p.slave && !p.dead) out.push(p);
    }
    return out;
  };

  Slavery.suppressionOf = function (pawn) {
    if (!pawn || !pawn.slave) return 1;
    var n = pawn.needs && pawn.needs.suppression;
    return typeof n === 'number' ? n : 1;
  };

  function setSuppression(pawn, value) {
    if (!pawn.needs) return;
    pawn.needs.suppression = U.clamp01(value);
  }

  /* The work sheet a slave is allowed. Their own priorities are kept on
     the slave block so emancipation hands the colony a person with the
     skills they arrived with rather than a blank column. */
  function restrictWork(pawn) {
    var types = Defs.all('workType');
    var sheet = {};
    for (var i = 0; i < types.length; i++) {
      var id = types[i].id;
      sheet[id] = SLAVE_FORBIDDEN_WORK[id] ? 0 : 3;
    }
    /* Hauling and cleaning are what a slave is actually for, so they
       come off the bottom of the list. */
    if (sheet.haul !== undefined && sheet.haul !== 0) sheet.haul = 2;
    if (sheet.clean !== undefined && sheet.clean !== 0) sheet.clean = 2;
    if (sheet.basic !== undefined && sheet.basic !== 0) sheet.basic = 2;
    pawn.workPriority = sheet;
    return sheet;
  }

  Slavery.canDo = function (pawn, action) {
    if (!pawn || !pawn.slave) return true;
    if (!action) return true;
    var key = String(action);
    if (SLAVE_FORBIDDEN_ACTIONS[key]) return false;
    if (key.indexOf('work:') === 0) return !SLAVE_FORBIDDEN_WORK[key.slice(5)];
    /* A bare work type id is the other spelling a caller reaches for. */
    if (SLAVE_FORBIDDEN_WORK[key]) return false;
    return true;
  };

  /* ---------- enslavement ---------- */

  Slavery.wantsEnslave = function (prisoner) {
    if (!prisoner || !prisoner.prisoner) return false;
    if (prisoner.enslaveDesignated) return true;
    return prisoner.prisoner.mode === 'enslave';
  };

  Slavery.setEnslave = function (prisoner, on) {
    if (!prisoner || !prisoner.prisoner) return false;
    prisoner.enslaveDesignated = on !== false;
    return true;
  };

  /* The other order, and the only one a warden acts on unprompted: mark
     a slave for the collar to come off. */
  Slavery.setFree = function (pawn, on) {
    if (!pawn || !pawn.slave) return false;
    pawn.freeDesignated = on !== false;
    return true;
  };

  Slavery.wantsFree = function (pawn) {
    return !!(pawn && pawn.slave && pawn.freeDesignated);
  };

  Slavery.enslave = function (prisoner, by) {
    if (!prisoner || prisoner.dead || !prisoner.map) return false;
    if (!isHumanPawn(prisoner)) return false;
    if (prisoner.slave) return false;
    var st = prisoner.prisoner;
    if (!st) return false;

    var map = prisoner.map;
    var who = fullName(prisoner);
    var t = now();

    var state = {
      factionId: st.factionId || null,
      factionName: st.factionName || null,
      enslavedTick: t,
      enslavedById: by ? by.id : 0,
      lastSuppressTick: t,
      lastBeatenTick: -1,
      lastExecutionSeenTick: -1,
      beatings: 0,
      sessions: 0,
      rebelling: false,
      rebelTick: 0,
      fleeIdx: -1,
      terror: 0,
      bought: false,
      /* The column they had before anyone put a collar on them. */
      freeWork: st.workPriority || null
    };

    prisoner.prisoner = false;
    prisoner.enslaveDesignated = false;
    prisoner.slave = state;
    prisoner.faction = 'player';
    prisoner.drafted = false;
    prisoner.draftTarget = null;
    prisoner.aimTarget = null;
    prisoner.mentalState = null;

    /* A prison bunk is not a bed. Let them find a real one the way
       anybody in the colony does. */
    var bed = prisoner.ownedBedId ? map.thing(prisoner.ownedBedId) : null;
    if (bed && bed.forPrisoners) {
      if (bed.ownerId === prisoner.id) bed.ownerId = null;
      prisoner.ownedBedId = null;
    }

    restrictWork(prisoner);
    if (prisoner.needs) prisoner.needs.suppression = 1;
    if (prisoner.equipment && prisoner.dropEquipment) prisoner.dropEquipment();

    var J = sys('Jobs');
    if (prisoner.job && J && J.end) J.end(prisoner, 'interrupted');
    if (Res) Res.releaseAll(prisoner);

    /* The colony feels it, and so do they. */
    var list = witnesses(map);
    for (var i = 0; i < list.length; i++) {
      moralise(list[i], 'slaveOwned', 'slaveryEnslaved', { subject: prisoner });
    }
    think(prisoner, 'slaveryEnslavedSelf', { degree: 0 });

    var F = sys('Factions');
    if (F && F.adjustGoodwill && state.factionId && state.factionId !== 'player') {
      F.adjustGoodwill(state.factionId, -30, 'you enslaved ' + who);
    }

    letter('A slave in the colony',
      who + ' wears your collar now' + (by ? ', fitted by ' + nameOf(by) : '') + '. They will ' +
      'work without being asked twice and without ever being one of you. Keep them suppressed - ' +
      'a warden, a collar, or something outside the window they would rather not look at - ' +
      'because the day they stop being afraid is the day they come and find you.',
      'neutral', prisoner);
    return true;
  };

  /* ---------- emancipation ----------

     RimWorld's answer, and the right one: a freed slave is a colonist,
     not a stranger walking off the map. They stayed, they worked, and
     somebody took the collar off. */

  Slavery.free = function (pawn, by) {
    var st = pawn && pawn.slave;
    if (!st || pawn.dead) return false;
    var map = pawn.map;
    var who = fullName(pawn);

    pawn.slave = false;
    pawn.faction = 'player';
    pawn.workPriority = st.freeWork || pawn.workPriority || {};
    if (pawn.needs) delete pawn.needs.suppression;

    var collar = pawn.wearingSlot ? pawn.wearingSlot('neck') : null;
    if (collar && collar.defId === 'slaveCollar' && pawn.removeApparel) pawn.removeApparel(collar);

    var J = sys('Jobs');
    if (pawn.job && J && J.end) J.end(pawn, 'interrupted');

    think(pawn, 'slaveryFreedSelf');
    think(pawn, 'newColonistJoined');
    var list = witnesses(map);
    for (var i = 0; i < list.length; i++) {
      if (list[i] === pawn) continue;
      moralise(list[i], 'slaveFreed', 'slaveryFreed', { subject: pawn });
    }

    var F = sys('Factions');
    if (F && F.notePrisonerReleased && st.factionId && st.factionId !== 'player') {
      F.notePrisonerReleased(st.factionId, who);
    }

    letter(who + ' has been freed',
      (by ? nameOf(by) + ' unlocked the collar. ' : '') + who + ' is a colonist now, with ' +
      'their own name on the work sheet and a long memory of the months before it.',
      'good', pawn);
    return true;
  };

  /* ============================================================
     4. SUPPRESSION AND TERROR
     ============================================================ */

  /* Everything in sight that makes a slave think twice, as one number.
     Recomputed on the slave's own rare beat and cached on the block so
     the work givers and the UI can read it for free. */
  function terrorFor(pawn, st) {
    var map = pawn.map;
    var t = now();
    var terror = 0;

    if (pawn.wearingSlot) {
      var neck = pawn.wearingSlot('neck');
      if (neck && neck.defId === 'slaveCollar') terror += TERROR_COLLAR;
    }

    /* Bodies on poles, within sight of wherever they are standing. */
    var poles = map.byDef ? map.byDef('gibbet') : null;
    var fromCorpses = 0;
    for (var i = 0; poles && i < poles.length; i++) {
      var g = poles[i];
      if (!g.spawned || !g.displayedName) continue;
      if (U.dist(g.x, g.y, pawn.x, pawn.y) > TERROR_RADIUS) continue;
      fromCorpses += TERROR_PER_CORPSE;
      if (fromCorpses >= TERROR_CORPSE_CAP) { fromCorpses = TERROR_CORPSE_CAP; break; }
    }
    terror += fromCorpses;

    if (st.lastExecutionSeenTick > 0 && t - st.lastExecutionSeenTick < EXECUTION_MEMORY) {
      terror += TERROR_EXECUTION * (1 - (t - st.lastExecutionSeenTick) / EXECUTION_MEMORY);
    }
    if (st.lastBeatenTick > 0 && t - st.lastBeatenTick < BEATING_MEMORY) {
      terror += TERROR_BEATING * (1 - (t - st.lastBeatenTick) / BEATING_MEMORY);
    }

    st.terror = U.clamp01(terror);
    return st.terror;
  }

  /* How fast the fear wears off. The headline number is the per-day
     fall; everything else is a multiplier on it, and every multiplier
     is a decision the player made. */
  function suppressionFall(pawn, st, slaveCount) {
    var rate = SUPPRESSION_FALL_PER_DAY * (RARE / DAY);

    /* A yard full of slaves is a yard full of people talking to each
       other, and that is the whole risk curve of the system. */
    rate *= 1 + 0.14 * Math.max(0, slaveCount - 1);

    /* Terror is the brake. A collared slave under a gibbet barely
       recovers at all, which is exactly why a player builds one. */
    rate *= 1 - 0.75 * st.terror;

    /* Decent treatment cuts the other way: a slave who is fed, warm and
       sleeping in a real bed stops looking for the door, but never
       stops entirely. */
    rate *= U.curve([[0, 1.55], [0.35, 1.2], [0.6, 0.95], [0.85, 0.62]], moodOf(pawn));

    if (hasTrait(pawn, 'ironWilled')) rate *= 1.5;
    if (hasTrait(pawn, 'volatile')) rate *= 1.2;
    if (hasTrait(pawn, 'wimp')) rate *= 0.7;
    if (hasTrait(pawn, 'ascetic')) rate *= 0.85;
    /* Somebody who can talk their way out of a room can talk themselves
       into trying. */
    rate *= 1 + skillLevel(pawn, 'social') * 0.015;

    var H = sys('Health');
    var legs = (H && H.capacity) ? H.capacity(pawn, 'moving') : 1;
    if (legs < 0.5) rate *= 0.5;

    return rate;
  }

  /* The public lever. Positive tops them up, negative wears them down;
     `source` only decides which thought lands. */
  Slavery.suppress = function (pawn, amount, source) {
    var st = pawn && pawn.slave;
    if (!st || pawn.dead) return 0;
    var before = Slavery.suppressionOf(pawn);
    setSuppression(pawn, before + amount);
    var after = Slavery.suppressionOf(pawn);

    if (amount > 0) {
      st.lastSuppressTick = now();
      if (source === 'beating') {
        st.lastBeatenTick = now();
        st.beatings++;
        think(pawn, 'slaveryBeaten');
      } else if (source !== 'terror' && source !== 'passive') {
        think(pawn, 'slaverySuppressed');
      }
    }
    return after - before;
  };

  /* One warden session. Talking works on a slave who is nearly under
     control; below the beating line it stops being a conversation,
     which is the moment the colony's mood gets a bill. */
  Slavery.suppressionSession = function (warden, slave) {
    var st = slave && slave.slave;
    if (!st || slave.dead) return null;

    var level = Slavery.suppressionOf(slave);
    var gain = SUPPRESS_BASE + SUPPRESS_PER_SOCIAL * skillLevel(warden, 'social');
    if (hasTrait(warden, 'abrasive')) gain *= 1.15;
    if (hasTrait(warden, 'kind')) gain *= 0.85;
    if (hasTrait(slave, 'ironWilled')) gain *= 0.75;

    var harsh = level < BEATING_BELOW || hasTrait(warden, 'bloodlust');
    st.sessions++;

    if (harsh) {
      gain *= 1.4;
      Slavery.suppress(slave, gain, 'beating');
      hurtLightly(slave, warden);
      noteBeating(slave, warden);
      msg(nameOf(warden) + ' beat ' + nameOf(slave) + ' back into line.', warden, 'threat');
      return 'beating';
    }

    Slavery.suppress(slave, gain, 'talk');
    msg(nameOf(warden) + ' suppressed ' + nameOf(slave) + '.', warden);
    return 'talk';
  };

  /* A beating is a real injury or it is a label, and the brief asks for
     the mechanic rather than the label. Small, blunt, never lethal:
     health.js decides whether it puts them down. */
  function hurtLightly(slave, warden) {
    var H = sys('Health');
    if (!H || !H.damage) return;
    var torso = null;
    var parts = slave.health && slave.health.parts;
    for (var i = 0; parts && i < parts.length; i++) {
      if (parts[i].defName === 'torso') { torso = parts[i]; break; }
    }
    H.damage(slave, {
      amount: U.randInt(3, 7), type: 'blunt',
      partId: torso ? torso.id : undefined,
      source: 'beating', instigator: warden, armorPen: 0
    });
  }

  function noteBeating(slave, warden) {
    var map = slave.map;
    var list = witnesses(map);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c === warden && hasTrait(c, 'bloodlust')) continue;
      if (U.dist(c.x, c.y, slave.x, slave.y) > 12) continue;
      if (faithApprovesSlavery(c)) continue;
      think(c, 'slaveryBeating', { otherPawnId: slave.id });
    }
    /* Every other slave in the room heard it happen. */
    var slaves = Slavery.all(map);
    for (var k = 0; k < slaves.length; k++) {
      var s = slaves[k];
      if (s === slave || U.dist(s.x, s.y, slave.x, slave.y) > TERROR_RADIUS) continue;
      s.slave.lastBeatenTick = now();
    }
  }

  /* ---------- executions and other things worth watching ----------

     prisoners.js fires the execution; nothing tells this file about it,
     so the sweep notices the same way the colony would - by counting
     the prisoners who were there a moment ago and are corpses now. */

  Slavery.noteExecution = function (map, victim) {
    var t = now();
    var slaves = Slavery.all(map);
    for (var i = 0; i < slaves.length; i++) {
      var s = slaves[i];
      if (victim && U.dist(s.x, s.y, victim.x, victim.y) > TERROR_RADIUS * 1.5) continue;
      s.slave.lastExecutionSeenTick = t;
      Slavery.suppress(s, 0.22, 'terror');
    }
    var P = sys('Prisoners');
    if (!P || !P.all) return;
    var cells = P.all(map);
    for (var k = 0; k < cells.length; k++) {
      var st = cells[k].prisoner;
      if (st) st.lastWatchedTick = t;
    }
  };

  /* ============================================================
     5. REBELLION
     ============================================================ */

  /* The colony-wide number, as a chance per day that somebody walks out
     of the barracks with a knife. The UI reads it, the alert reads it,
     and the per-slave roll is this divided across the beat. */
  Slavery.rebellionRisk = function (map) {
    if (!map) return 0;
    var slaves = Slavery.all(map);
    if (!slaves.length) return 0;

    var total = 0, worst = 1;
    for (var i = 0; i < slaves.length; i++) {
      var s = Slavery.suppressionOf(slaves[i]);
      total += s;
      if (s < worst) worst = s;
    }
    var avg = total / slaves.length;

    /* A colony that could shoot back is a colony a slave thinks twice
       about. Armed, awake, and not already lying down. */
    var armed = 0;
    var free = witnesses(map);
    for (var k = 0; k < free.length; k++) {
      var c = free[k];
      if (c.downed || c.mentalState) continue;
      armed += c.equipment ? 1 : 0.35;
    }
    var odds = slaves.length / Math.max(1, armed);

    var risk = U.curve([[0, 1], [0.15, 0.55], [0.35, 0.18], [0.6, 0.04], [1, 0]], avg);
    risk *= U.curve([[0, 0.5], [0.5, 0.85], [1, 1], [2, 1.6], [4, 2.4]], odds);
    risk *= 1 + 0.08 * Math.max(0, slaves.length - 1);
    if (worst < REBEL_AT) risk *= 1.5;
    return U.clamp01(risk);
  };

  Slavery.rebellionAlert = function (map) {
    var slaves = Slavery.all(map);
    if (!slaves.length) return null;
    var risk = Slavery.rebellionRisk(map);
    if (risk < 0.08) return null;
    var low = 0;
    for (var i = 0; i < slaves.length; i++) {
      if (Slavery.suppressionOf(slaves[i]) < WARN_AT) low++;
    }
    if (!low) return null;
    return {
      label: low + ' ' + U.plural(low, 'slave') + ' barely suppressed',
      severity: risk > 0.3 ? 'major' : 'minor',
      risk: risk
    };
  };

  /* Somewhere off the edge of the map that can be walked to from here. */
  function edgeCell(pawn) {
    var map = pawn.map;
    var MG = sys('MapGen');
    var cands = [], sides = ['n', 'e', 's', 'w'], i, k;
    if (MG && MG.edgeSpawnCells) {
      for (i = 0; i < sides.length; i++) {
        var cells = MG.edgeSpawnCells(map, sides[i]);
        for (k = 0; k < cells.length; k += 3) cands.push(cells[k]);
      }
    }
    if (!cands.length) {
      for (i = 1; i < map.w - 1; i += 4) {
        if (map.passable(i, 0)) cands.push({ x: i, y: 0 });
        if (map.passable(i, map.h - 1)) cands.push({ x: i, y: map.h - 1 });
      }
    }
    if (!cands.length || !Path) return null;
    return Path.closestReachable(map, pawn, cands, null);
  }

  /* A loose weapon a rebelling slave could reach before anybody stops
     them. Anything in a stockpile counts; that is what makes leaving
     the armoury unlocked a mistake. */
  function grabbableWeapon(pawn) {
    var map = pawn.map;
    var best = null, bestScore = -Infinity;
    var defs = Defs.all('thing');
    for (var d = 0; d < defs.length; d++) {
      if (!defs[d].weapon) continue;
      var list = map.byDef(defs[d].id);
      for (var i = 0; i < list.length; i++) {
        var w = list[i];
        if (!w.spawned) continue;
        var dist = U.dist(w.x, w.y, pawn.x, pawn.y);
        if (dist > 30) continue;
        if (!reachable(map, pawn, w.x, w.y)) continue;
        var score = (w.def.weapon.damage || 1) * 2 - dist;
        if (score > bestScore) { bestScore = score; best = w; }
      }
    }
    return best;
  }

  function turnRebel(pawn, st) {
    var map = pawn.map;
    st.rebelling = true;
    st.rebelTick = now();

    /* Faction is the switch. think.js hands any non-player human the
       fight tier, combat.js reads the faction relation, and the rest of
       the game treats them as exactly what they have become. */
    pawn.faction = 'raider';
    pawn.drafted = false;
    pawn.draftTarget = null;
    if (pawn.needs) delete pawn.needs.suppression;

    var types = Defs.all('workType');
    var blank = {};
    for (var i = 0; i < types.length; i++) blank[types[i].id] = 0;
    pawn.workPriority = blank;

    var J = sys('Jobs');
    if (pawn.job && J && J.end) J.end(pawn, 'interrupted');
    if (Res) Res.releaseAll(pawn);

    /* Queued rather than started: the queue outranks the fight tier in
       the think tree, so they get the knife before they use it. */
    var weapon = grabbableWeapon(pawn);
    if (weapon && J && J.make) {
      pawn.jobQueue = pawn.jobQueue || [];
      pawn.jobQueue.push(J.make('equipWeapon', T.thing(weapon)));
    }

    var bed = pawn.ownedBedId && map ? map.thing(pawn.ownedBedId) : null;
    if (bed && bed.ownerId === pawn.id) bed.ownerId = null;
    pawn.ownedBedId = null;
  }

  Slavery.startRebellion = function (map, ringleader) {
    if (!map) return 0;
    var slaves = Slavery.all(map);
    var joined = [];
    for (var i = 0; i < slaves.length; i++) {
      var s = slaves[i];
      if (s.slave.rebelling) continue;
      if (s !== ringleader && Slavery.suppressionOf(s) > REBEL_JOIN) continue;
      turnRebel(s, s.slave);
      joined.push(s);
    }
    if (!joined.length) return 0;

    var list = witnesses(map);
    for (var k = 0; k < list.length; k++) think(list[k], 'slaveryRebellion');

    var names = joined.map(nameOf).join(', ');
    letter('Slave rebellion',
      (joined.length === 1 ? names + ' has' : names + ' have') + ' thrown off the collar and ' +
      'gone looking for a weapon. They are hostile now, and they know the layout of every room ' +
      'you own. This is the bill for the work you did not pay for.',
      'threat', joined[0]);
    return joined.length;
  };

  /* ============================================================
     6. THE PER-SLAVE TICK
     ============================================================ */

  function rebelTick(pawn, st) {
    var t = now();
    if ((t + pawn.id) % RARE !== 0) return;
    var map = pawn.map;

    /* Still somebody to fight? Then the think tree is doing its job and
       this has nothing to add. */
    var foeNear = false;
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (p === pawn || p.dead || p.downed) continue;
      if (p.faction !== 'player' || !isHumanPawn(p)) continue;
      if (U.dist(p.x, p.y, pawn.x, pawn.y) < 22) { foeNear = true; break; }
    }
    if (foeNear) return;

    /* Nobody left worth hitting: take what they are carrying and go. */
    if (pawn.job && pawn.job.defId === 'slaveFlee') return;
    var J = sys('Jobs');
    if (!J) return;
    if (st.fleeIdx < 0) {
      var cell = edgeCell(pawn);
      if (!cell) return;
      st.fleeIdx = map.idx(cell.x, cell.y);
    }
    if (pawn.job) J.end(pawn, 'interrupted');
    J.start(pawn, J.make('slaveFlee', T.cell(map.xOf(st.fleeIdx), map.yOf(st.fleeIdx))));
  }

  Slavery.tickPawn = function (pawn) {
    if (!pawn || !pawn.map) return;
    colonyBeat(pawn.map);

    var st = pawn.slave;
    if (!st || pawn.dead) return;

    if (st.rebelling) { rebelTick(pawn, st); return; }
    if (pawn.carriedBy || pawn.downed) return;

    /* A slave never holds a weapon. Somebody who picked one up off the
       floor during a haul is disarmed on the spot, which is cheaper
       than teaching six work givers what a slave is. */
    if (pawn.equipment && pawn.dropEquipment) pawn.dropEquipment();
    if (pawn.drafted) { pawn.drafted = false; pawn.draftTarget = null; }

    var t = now();
    if ((t + pawn.id) % RARE !== 0) return;

    var map = pawn.map;
    var slaveCount = Slavery.all(map).length;

    terrorFor(pawn, st);
    var level = Slavery.suppressionOf(pawn);
    setSuppression(pawn, level - suppressionFall(pawn, st, slaveCount));
    level = Slavery.suppressionOf(pawn);

    /* What being property feels like from the inside. The degree is the
       colony's behaviour, not the slave's: a beaten slave carries the
       worse version of the same thought. */
    var recentlyBeaten = st.lastBeatenTick > 0 && t - st.lastBeatenTick < BEATING_MEMORY * 2;
    think(pawn, 'slaveryEnslavedSelf', {
      degree: recentlyBeaten ? 1 : 0, duration: DAY, noStack: true
    });
    if (st.terror > 0.2) {
      think(pawn, 'slaveryTerror', { degree: st.terror > 0.45 ? 1 : 0, noStack: true });
    }
    /* Decent treatment is a real lever and not a euphemism: a slave who
       is fed, rested and not in pain is a slave who is slower to run. */
    if (moodOf(pawn) > 0.62 && !recentlyBeaten) {
      think(pawn, 'slaveryTreatedWell', { noStack: true });
    }

    if (level > REBEL_AT) return;

    /* The roll. rebellionRisk is a chance per day across the colony; a
       slave who is under the line takes their share of it on the beat. */
    var risk = Slavery.rebellionRisk(map) * (RARE / DAY);
    risk *= 1 + (REBEL_AT - level) * 4;
    var H = sys('Health');
    var legs = (H && H.capacity) ? H.capacity(pawn, 'moving') : 1;
    if (legs < 0.4) return;
    if (U.chance(risk)) Slavery.startRebellion(map, pawn);
  };

  /* ============================================================
     7. THE COLONY BEAT

     Everything that is about the colony rather than about one pawn:
     who feels bad about the slaves, whose body is lying where, which
     grave was filled and which pole is empty. Guarded so it runs once
     per tick however many pawns call into it.
     ============================================================ */

  var _beatTick = -1;
  var _scanTick = -1;
  var _knownGraves = null;
  var _knownExecuted = null;

  /* `force` is what separates the two callers. tickPawn drives this from
     inside a per-pawn loop and has to be throttled or the sweep would run
     once per pawn per tick; Slavery.tick is somebody asking for it on
     purpose and gets it. */
  function colonyBeat(map, force) {
    if (!map) return;
    var t = now();
    if (!force) {
      if (t === _beatTick) return;
      _beatTick = t;
      if (t % COLONY_BEAT !== 0) return;
    } else {
      _beatTick = t;
    }

    ensureHooks();
    ownershipMood(map);
    displayMood(map);
    watchForExecutions(map);
    decayDisplays(map);

    if (force || t - _scanTick >= SCAN_BEAT) {
      _scanTick = t;
      burialMood(map);
      rotMood(map);
      larderMood(map);
    }
  }

  Slavery.tick = function (map) {
    colonyBeat(map || (root.Game && root.Game.map), true);
  };

  /* The standing cost of keeping people. One thought, three stages, and
     an ideoligion that approves turns the sign around through
     ideology.js rather than through anything here. */
  function ownershipMood(map) {
    var slaves = Slavery.all(map);
    if (!slaves.length) return;
    var degree = slaves.length >= 5 ? 2 : (slaves.length >= 2 ? 1 : 0);
    var list = witnesses(map);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (noteAction(c, 'slaveOwned', { scale: 1 + 0.15 * (slaves.length - 1) })) continue;
      think(c, 'slaveryOwned', { degree: degree, duration: DAY, noStack: true });
    }
  }

  /* Bodies on poles: everybody who can see one feels it, and every
     prisoner in the colony is reminded what the pole is for. */
  function displayMood(map) {
    var poles = map.byDef ? map.byDef('gibbet') : null;
    if (!poles || !poles.length) return;
    var live = [];
    for (var i = 0; i < poles.length; i++) {
      if (poles[i].spawned && poles[i].displayedName) live.push(poles[i]);
    }
    if (!live.length) return;

    var list = witnesses(map);
    for (var k = 0; k < list.length; k++) {
      var c = list[k];
      var seen = false;
      for (var g = 0; g < live.length; g++) {
        if (U.dist(c.x, c.y, live[g].x, live[g].y) <= TERROR_RADIUS) { seen = true; break; }
      }
      if (!seen) continue;
      if (noteAction(c, 'corpseSeen', { scale: 1.5 })) continue;
      think(c, 'slaveryCorpseDisplayed', { degree: live.length > 1 ? 1 : 0, noStack: true });
    }

    /* The cells get the point too. */
    var P = sys('Prisoners');
    var cells = (P && P.all) ? P.all(map) : [];
    for (var p = 0; p < cells.length; p++) {
      var pr = cells[p];
      for (var q = 0; q < live.length; q++) {
        if (U.dist(pr.x, pr.y, live[q].x, live[q].y) > TERROR_RADIUS) continue;
        if (pr.prisoner) pr.prisoner.escapeWill = Math.max(0, (pr.prisoner.escapeWill || 0) - 0.08);
        break;
      }
    }
  }

  /* Nobody tells this file when a prisoner is executed, so it counts.
     A prisoner who was on the roster last beat and is a corpse now was
     killed in the cells, which is close enough to the thing the slaves
     are supposed to be frightened by. */
  function watchForExecutions(map) {
    var P = sys('Prisoners');
    if (!P || !P.all) return;
    var live = P.all(map);
    var ids = Object.create(null);
    for (var i = 0; i < live.length; i++) ids[live[i].id] = 1;

    if (_knownExecuted) {
      for (var id in _knownExecuted) {
        if (ids[id]) continue;
        var pawn = _knownExecuted[id];
        if (pawn && pawn.dead) Slavery.noteExecution(map, pawn);
      }
    }
    _knownExecuted = Object.create(null);
    for (var k = 0; k < live.length; k++) _knownExecuted[live[k].id] = live[k];
  }

  /* A displayed body does not last forever; it comes apart and the pole
     goes back to being a pole. */
  function decayDisplays(map) {
    var poles = map.byDef ? map.byDef('gibbet') : null;
    var t = now();
    for (var i = 0; poles && i < poles.length; i++) {
      var g = poles[i];
      if (!g.spawned || !g.displayedName) continue;
      if (t - (g.displayedTick || 0) < DISPLAY_DAYS * DAY) continue;
      msg('What was left of ' + g.displayedName + ' has come off the gibbet.', g, 'info');
      g.displayedName = null;
      g.displayedKindId = null;
      g.displayedTick = 0;
    }
  }

  /* ---------- graves ----------

     jobs.js owns burial and stamps the grave with a name and a tick.
     Watching those stamps is cheaper than hooking the job, and it picks
     up a sarcophagus filled by this file's own job for free. */
  function burialMood(map) {
    var graves = [];
    if (map.byDef) {
      graves = (map.byDef('grave') || []).concat(map.byDef('sarcophagus') || []);
    }
    var fresh = [];
    var seen = Object.create(null);
    for (var i = 0; i < graves.length; i++) {
      var g = graves[i];
      if (!g.spawned || !g.buriedName) continue;
      seen[g.id] = 1;
      if (_knownGraves && _knownGraves[g.id]) continue;
      fresh.push(g);
    }
    _knownGraves = seen;
    if (!fresh.length) return;

    var list = witnesses(map);
    for (var k = 0; k < fresh.length; k++) {
      var stone = fresh[k].defId === 'sarcophagus';
      for (var c = 0; c < list.length; c++) {
        if (noteAction(list[c], 'corpseBuried', { scale: stone ? 1.4 : 1 })) continue;
        think(list[c], 'slaveryBuriedWell', { degree: stone ? 1 : 0 });
      }
    }
  }

  /* And the other half of the same rule: a body nobody dealt with. */
  function rotMood(map) {
    var corpses = map.byDef ? map.byDef('corpse') : null;
    if (!corpses || !corpses.length) return;
    var t = now(), lying = [];
    for (var i = 0; i < corpses.length && lying.length < 12; i++) {
      var c = corpses[i];
      if (!c.spawned || !c.corpse) continue;
      if (t - (c.spawnTick || 0) < ROT_NOTICE_TICKS) continue;
      var kind = Defs.maybe('pawnKind', c.corpse.kindId);
      if (!kind || kind.body !== 'human') continue;
      lying.push(c);
    }
    if (!lying.length) return;

    var list = witnesses(map);
    for (var k = 0; k < list.length; k++) {
      var p = list[k];
      var near = false;
      for (var j = 0; j < lying.length; j++) {
        if (U.dist(p.x, p.y, lying[j].x, lying[j].y) <= 16) { near = true; break; }
      }
      if (!near) continue;
      if (noteAction(p, 'corpseRotting', {})) continue;
      think(p, 'slaveryLeftToRot', { noStack: true });
    }
  }

  /* Knowing the larder has people in it is its own small horror, and it
     is the thing that turns cannibalism from an event into a policy. */
  function larderMood(map) {
    var stacks = map.byDef ? map.byDef('humanMeat') : null;
    var meals = map.byDef ? map.byDef('mealSimpleHuman') : null;
    var count = (stacks ? stacks.length : 0) + (meals ? meals.length : 0);
    if (!count) return;
    var list = witnesses(map);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (faithApprovesCannibalism(c)) continue;
      if (hasTrait(c, 'cannibal')) continue;
      think(c, 'slaveryKnowsHumanMeat', { noStack: true });
    }
  }

  /* ============================================================
     8. CANNIBALISM

     Two acts, and both of them happen inside somebody else's module.
     needs.js swallows the meal and production.js takes the body apart,
     and neither of them is ours to edit - so both are wrapped, once,
     the first time this file ticks. Wrapping rather than editing is the
     whole point: the original still does all the work and this only
     adds the sentence afterwards.
     ============================================================ */

  var _hooked = false;

  function ensureHooks() {
    if (_hooked) return;
    var N = sys('Needs');
    var Pr = sys('Production');
    if (!N || !Pr) return;
    _hooked = true;

    if (typeof N.eat === 'function' && !N.__slaveryEat) {
      var eat = N.eat;
      N.__slaveryEat = true;
      N.eat = function (pawn, thing) {
        var def = thing && (thing.def || Defs.maybe('thing', thing.defId));
        var human = Slavery.isHumanFood(def);
        var ok = eat.call(N, pawn, thing);
        if (ok && human) Slavery.noteAteHuman(pawn, def);
        return ok;
      };
    }

    if (typeof Pr.doRecipe === 'function' && !Pr.__slaveryButcher) {
      var doRecipe = Pr.doRecipe;
      Pr.__slaveryButcher = true;
      Pr.doRecipe = function (pawn, building, bill, ingredients) {
        var human = humanCarcass(ingredients);
        var made = doRecipe.call(Pr, pawn, building, bill, ingredients);
        if (human && made && made.length) Slavery.noteButcheredHuman(pawn, human);
        return made;
      };
    }
  }
  Slavery.installHooks = ensureHooks;

  function humanCarcass(ingredients) {
    for (var i = 0; ingredients && i < ingredients.length; i++) {
      var thing = ingredients[i] && (ingredients[i].thing || ingredients[i]);
      if (!thing || !thing.corpse) continue;
      var kind = Defs.maybe('pawnKind', thing.corpse.kindId);
      if (kind && kind.body === 'human' && !kind.isAnimal) return thing;
    }
    return null;
  }

  /* There are two axes to eating a person and they are not the same
     axis. What the colony believes is the ideoligion's, and ideology.js
     already grades that on five degrees. What the pawn is - a cannibal,
     a psychopath, or somebody who will be sick - is personal, applies
     with or without a faith, and overrides it, because a psychopath in
     a horrified colony still does not care and a cannibal in one still
     enjoys their dinner.

     'likes' | 'indifferent' | 'normal'. */
  function personalStance(pawn) {
    if (hasTrait(pawn, 'cannibal')) return 'likes';
    if (hasTrait(pawn, 'psychopath') || hasTrait(pawn, 'bloodlust')) return 'indifferent';
    return 'normal';
  }

  /* The stage index into this file's own thought: 0 horrified, 1
     indifferent, 2 glad of it. Only read when ideology.js is absent or
     has nothing to say. */
  function cannibalDegree(pawn) {
    var stance = personalStance(pawn);
    if (stance === 'likes') return 2;
    if (stance === 'indifferent') return 1;
    return faithApprovesCannibalism(pawn) ? 2 : 0;
  }

  Slavery.noteAteHuman = function (pawn, def) {
    if (!pawn || !isHumanPawn(pawn) || pawn.dead) return false;
    var stance = personalStance(pawn);
    /* Nothing at all lands on somebody who genuinely does not mind. */
    if (stance === 'indifferent') return false;
    if (stance === 'likes') {
      think(pawn, 'slaveryAteHuman', { degree: 2 });
      return true;
    }
    /* Everyone else is graded by what they believe, and ideology.js has
       a finer ladder for that than this file does. */
    if (noteAction(pawn, 'eatHumanMeat', { thingDefId: def && def.id })) return true;
    think(pawn, 'slaveryAteHuman', { degree: cannibalDegree(pawn) });
    return true;
  };

  Slavery.noteButcheredHuman = function (pawn, corpse) {
    if (!pawn || !pawn.map) return false;
    var map = pawn.map;
    var who = (corpse && corpse.corpse && corpse.corpse.name) || 'a body';

    var list = witnesses(map);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      /* The butcher always feels it; everyone else has to have been in
         the room. */
      if (c !== pawn && U.dist(c.x, c.y, pawn.x, pawn.y) > 10) continue;
      var stance = personalStance(c);
      if (stance === 'indifferent') continue;
      if (stance === 'likes') { think(c, 'slaveryButcheredHuman', { degree: 2 }); continue; }
      if (noteAction(c, 'butcherHuman', { subject: corpse })) continue;
      think(c, 'slaveryButcheredHuman', { degree: cannibalDegree(c) });
    }
    msg(nameOf(pawn) + ' butchered ' + who + '.', pawn,
        cannibalDegree(pawn) === 0 ? 'threat' : 'info');
    return true;
  };

  /* Does the colony's faith actually want this, which is the difference
     between a colony that eats its enemies and one that is edgy about
     it. Exposed because the bill list wants to say so. */
  Slavery.cannibalismStance = function (pawn) {
    var I = ideo();
    if (I && I.precept) {
      var d = I.precept(pawn || null, 'cannibalism');
      if (d) return d.id;
    }
    if (pawn && hasTrait(pawn, 'cannibal')) return 'preferred';
    return 'disapproved';
  };

  /* ============================================================
     9. THE SLAVE TRADE
     ============================================================ */

  /* What a person fetches. Health, youth and a useful skill all count,
     which is the uncomfortable part and is meant to be. */
  Slavery.valueOf = function (pawn) {
    if (!pawn) return 0;
    var v = SLAVE_BASE_VALUE;

    var H = sys('Health');
    if (H && H.capacity) {
      v *= U.clamp(H.capacity(pawn, 'moving'), 0.2, 1.2);
      v *= U.clamp(H.capacity(pawn, 'manipulation'), 0.2, 1.2);
      v *= U.clamp(1 - (pawn.health && pawn.health.bloodLoss || 0) * 0.5, 0.4, 1);
    }
    var age = pawn.ageYears || 30;
    v *= U.curve([[16, 0.7], [22, 1.05], [40, 1], [55, 0.75], [75, 0.4]], age);

    var best = 0;
    if (pawn.skills) {
      for (var id in pawn.skills) {
        var lvl = pawn.skills[id] ? (pawn.skills[id].level | 0) : 0;
        if (lvl > best) best = lvl;
      }
    }
    v *= 1 + best * 0.035;
    if (hasTrait(pawn, 'ironWilled')) v *= 0.9;   /* trouble, and buyers know it */
    if (pawn.slave) v *= 1 + 0.25 * Slavery.suppressionOf(pawn);
    return Math.max(10, Math.round(v));
  };

  function partnerFactionId(partner) {
    if (!partner) return null;
    return partner.factionId || (partner.faction && partner.faction.id) || null;
  }

  function partnerLabel(partner) {
    if (!partner) return 'a passing slaver';
    if (partner.name) return partner.name;
    if (partner.traderKind && partner.traderKind.label) {
      return partner.traderKind.label + (partner.factionName ? ' of ' + partner.factionName : '');
    }
    return partner.factionName || 'a trader';
  }

  function partnerSilver(partner) {
    if (!partner) return Infinity;
    if (typeof partner.silver === 'number') return partner.silver;
    if (typeof partner.wealth === 'number') return Math.round(partner.wealth * 0.25);
    return Infinity;
  }

  function payPartner(partner, amount) {
    if (!partner) return;
    if (typeof partner.silver === 'number') {
      partner.silver = Math.max(0, partner.silver - amount);
    } else if (typeof partner.wealth === 'number') {
      partner.wealth = Math.max(0, partner.wealth - amount);
    }
  }

  function anyPartner() {
    var Tr = sys('Trade');
    if (!Tr || !Tr.partners) return null;
    var list = Tr.partners();
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].partner) return list[i].partner;
    }
    return null;
  }

  /* Selling a person. The silver lands in the colony; the price of it
     lands on every civilization that is not a pirate band, because word
     of this kind of thing travels and nobody hears it kindly. */
  Slavery.sell = function (pawn, partner) {
    if (!pawn || pawn.dead || !pawn.map) return { ok: false, reason: 'nobody to sell' };
    if (!isHumanPawn(pawn)) return { ok: false, reason: 'not a person' };
    if (!pawn.slave && !pawn.prisoner) return { ok: false, reason: 'not yours to sell' };

    partner = partner || anyPartner();
    if (!partner) return { ok: false, reason: 'nobody is buying' };

    var Tr = sys('Trade');
    var map = pawn.map;
    var who = fullName(pawn);
    var buyerId = partnerFactionId(partner);

    var price = Slavery.valueOf(pawn);
    /* The trader's spread and your negotiator's tongue both apply, the
       same way they would to a crate of steel. */
    var spread = (Tr && typeof Tr.SELL_SPREAD === 'number') ? Tr.SELL_SPREAD : 0.6;
    var negotiator = null;
    if (Tr && Tr.negotiatorFor) negotiator = Tr.negotiatorFor(partner);
    if (!negotiator) {
      var free = witnesses(map);
      for (var n = 0; n < free.length; n++) {
        if (!negotiator || skillLevel(free[n], 'social') > skillLevel(negotiator, 'social')) {
          negotiator = free[n];
        }
      }
    }
    price = Math.round(price * spread * (1 + skillLevel(negotiator, 'social') * 0.012));

    var purse = partnerSilver(partner);
    if (purse < price) price = Math.floor(purse);
    if (price < 1) return { ok: false, reason: partnerLabel(partner) + ' cannot pay for a person' };

    payPartner(partner, price);
    var centre = (Tr && Tr.colonyCentre) ? Tr.colonyCentre(map) : { x: map.w >> 1, y: map.h >> 1 };
    if (map.addItem) map.addItem('silver', centre.x, centre.y, price);

    /* Off the map, in somebody's caravan. */
    var st = pawn.slave || pawn.prisoner;
    var homeFaction = (st && st.factionId) || null;
    pawn.slave = false;
    pawn.prisoner = false;
    if (pawn.needs) delete pawn.needs.suppression;
    var J = sys('Jobs');
    if (pawn.job && J && J.end) J.end(pawn, 'interrupted');
    if (Res) Res.releaseAll(pawn);
    if (pawn.ownedBedId && map.thing) {
      var bed = map.thing(pawn.ownedBedId);
      if (bed && bed.ownerId === pawn.id) bed.ownerId = null;
    }
    pawn.ownedBedId = null;
    if (map.removePawn) map.removePawn(pawn); else U.remove(map.pawns, pawn);
    pawn.map = null;

    /* The reckoning. */
    var F = sys('Factions');
    var angered = 0;
    if (F && F.all) {
      var all = F.all();
      for (var i = 0; i < all.length; i++) {
        var f = all[i];
        if (!f || f.id === 'player') continue;
        if (f.id === buyerId) {
          if (F.adjustGoodwill) F.adjustGoodwill(f.id, 6, 'you sold them ' + who);
          continue;
        }
        if (f.permanentEnemy || (f.kind && f.kind.permanentEnemy)) continue;
        var bite = (homeFaction && f.id === homeFaction) ? -30 : -14;
        if (F.adjustGoodwill) F.adjustGoodwill(f.id, bite, 'you sold ' + who + ' to a slaver');
        angered++;
      }
    }

    var list = witnesses(map);
    for (var k = 0; k < list.length; k++) {
      var c = list[k];
      if (faithApprovesSlavery(c)) continue;
      think(c, 'slaverySold', { noStack: false });
    }

    letter('You sold a person',
      who + ' went out of the gate in somebody else\'s column for ' + price + ' silver. ' +
      (angered ? 'Word of it has already reached ' + angered + ' ' +
        U.plural(angered, 'civilization') + ', and none of them are pleased.'
              : 'Nobody out there is in a position to object.'),
      'neutral');
    return { ok: true, silver: price, partner: partnerLabel(partner), angered: angered };
  };

  Slavery.canSell = function (pawn) {
    if (!pawn || pawn.dead) return { ok: false, reason: 'nobody to sell' };
    if (!pawn.slave && !pawn.prisoner) return { ok: false, reason: 'not yours to sell' };
    if (!anyPartner()) return { ok: false, reason: 'nobody is buying' };
    return { ok: true, price: Math.round(Slavery.valueOf(pawn) * 0.6) };
  };

  /* ============================================================
     10. JOBS
     ============================================================ */

  Jobs.register('enslavePrisoner', {
    label: 'enslave prisoner',
    reportString: 'Fitting a collar on {A}.',
    alwaysShow: true,
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'enslave',
          amount: ENSLAVE_WORK,
          skill: 'social',
          failIfGone: true,
          onDone: function (pawn, job) {
            var captive = T.resolve(job.targetA, pawn.map);
            if (!captive || !captive.prisoner) return 'fail';
            return Slavery.enslave(captive, pawn) ? 'done' : 'fail';
          }
        })
      ];
    }
  });

  Jobs.register('suppressSlave', {
    label: 'suppress slave',
    reportString: 'Suppressing {A}.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'suppress',
          amount: SUPPRESS_WORK,
          skill: 'social',
          failIfGone: true,
          onDone: function (pawn, job) {
            var slave = T.resolve(job.targetA, pawn.map);
            if (!slave || !slave.slave) return 'fail';
            Slavery.suppressionSession(pawn, slave);
            return 'done';
          }
        })
      ];
    }
  });

  Jobs.register('collarSlave', {
    label: 'collar slave',
    reportString: 'Putting a collar on {A}.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.reserve('B', 1),
        Toils.goto('B', { pe: PE.TOUCH, failIfGone: true }),
        Toils.pickUp('B', function () { return 1; }),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'fitCollar',
          amount: COLLAR_WORK,
          failIfGone: true,
          onDone: function (pawn, job) {
            var slave = T.resolve(job.targetA, pawn.map);
            var collar = pawn.carried;
            if (!slave || !slave.slave || !collar) return 'fail';
            pawn.carried = null;
            if (!slave.wear || !slave.wear(collar)) return 'fail';
            Slavery.suppress(slave, 0.18, 'terror');
            msg(nameOf(pawn) + ' collared ' + nameOf(slave) + '.', pawn);
            return 'done';
          }
        })
      ];
    }
  });

  Jobs.register('freeSlave', {
    label: 'free slave',
    reportString: 'Freeing {A}.',
    alwaysShow: true,
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'unlock',
          amount: FREE_WORK,
          failIfGone: true,
          onDone: function (pawn, job) {
            var slave = T.resolve(job.targetA, pawn.map);
            if (!slave || !slave.slave) return 'fail';
            return Slavery.free(slave, pawn) ? 'done' : 'fail';
          }
        })
      ];
    }
  });

  /* Carry a body to a pole and hang it there. Mechanically a haul with
     a different ending; the ending is the whole point. */
  Jobs.register('displayCorpse', {
    label: 'display corpse',
    reportString: 'Hanging {A} on the gibbet.',
    alwaysShow: true,
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.reserve('B', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.pickUp('A', function () { return 1; }),
        Toils.goto('B', { pe: PE.INTERACTION, failIfGone: true }),
        Toils.work({
          name: 'hang',
          which: 'B',
          amount: DISPLAY_WORK,
          skill: 'construction',
          failIfGone: true,
          onDone: function (pawn, job) {
            var map = pawn.map;
            var pole = T.resolve(job.targetB, map);
            var corpse = pawn.carried;
            if (!pole || !corpse || !corpse.corpse) return 'fail';
            if (pole.displayedName) return 'fail';
            pole.displayedName = corpse.corpse.name || 'someone';
            pole.displayedKindId = corpse.corpse.kindId || null;
            pole.displayedTick = now();
            pawn.carried = null;
            map.despawnThing(corpse);

            /* Every slave in range gets the message immediately rather
               than on their own beat: that is what it is for. */
            var slaves = Slavery.all(map);
            for (var i = 0; i < slaves.length; i++) {
              if (U.dist(slaves[i].x, slaves[i].y, pole.x, pole.y) > TERROR_RADIUS) continue;
              Slavery.suppress(slaves[i], 0.20, 'terror');
            }
            msg(nameOf(pawn) + ' hung ' + pole.displayedName + ' on the gibbet.', pawn, 'threat');
            return 'done';
          }
        })
      ];
    }
  });

  /* Burial in stone. jobs.js owns `bury` and only ever looks at graves,
     so the sarcophagus needs its own driver; the stamp it leaves is the
     same one, which is what lets burialMood read both. */
  Jobs.register('entomb', {
    label: 'entomb',
    reportString: 'Laying {A} to rest.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.reserve('B', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.pickUp('A', function () { return 1; }),
        Toils.goto('B', { pe: PE.INTERACTION, failIfGone: true }),
        Toils.work({
          name: 'inter',
          which: 'B',
          amount: ENTOMB_WORK,
          skill: 'construction',
          failIfGone: true,
          onDone: function (pawn, job) {
            var map = pawn.map;
            var tomb = T.resolve(job.targetB, map);
            var corpse = pawn.carried;
            if (!tomb || !corpse || !corpse.corpse) return 'fail';
            if (tomb.buriedName) return 'fail';
            tomb.buried = {
              name: corpse.corpse.name || 'someone',
              kindId: corpse.corpse.kindId || null,
              faction: corpse.corpse.faction || null,
              pawnId: corpse.corpse.pawnId || null,
              tick: now()
            };
            tomb.buriedName = tomb.buried.name;
            tomb.buriedTick = tomb.buried.tick;
            pawn.carried = null;
            map.despawnThing(corpse);
            msg(nameOf(pawn) + ' laid ' + tomb.buriedName + ' in stone.', pawn, 'good');
            return 'done';
          }
        })
      ];
    }
  });

  /* A rebel who has run out of people to hit walks off the map with
     whatever they took. Written here rather than borrowed, because
     prisoners.js keeps its own version private and duplicating six
     lines is cheaper than reaching into somebody else's closure. */
  Jobs.register('slaveFlee', {
    label: 'flee',
    reportString: 'Making for the edge of the map.',
    suspendable: false,
    alwaysShow: true,
    toils: function () {
      return [
        Toils.custom({
          name: 'runForIt',
          init: function (pawn, job, s) { s.ticks = 0; s.retries = 0; },
          tick: function (pawn, job, s) {
            var map = pawn.map;
            var pos = T.pos(job.targetA, map);
            if (!pos) return 'fail';
            if (pawn.x === pos.x && pawn.y === pos.y) { Jobs.stopMoving(pawn); return 'next'; }
            if (++s.ticks > 40000) return 'fail';
            if (!(pawn.path && pawn.pathIdx < pawn.path.length)) {
              if (!Jobs.walkTo(pawn, pos.x, pos.y, PE.ON_CELL)) {
                var fresh = (s.retries++ < 3) ? edgeCell(pawn) : null;
                if (!fresh) return 'fail';
                job.targetA = T.cell(fresh.x, fresh.y);
                return 'stay';
              }
              s.retries = 0;
            }
            return 'stay';
          }
        }),
        Toils.custom({
          name: 'gone',
          tick: function (pawn, job) {
            var map = pawn.map;
            var pos = T.pos(job.targetA, map);
            if (!pos) return 'fail';
            if (pawn.x !== pos.x || pawn.y !== pos.y) return 'stay';
            var who = fullName(pawn);
            var st = pawn.slave;
            if (st) {
              pawn.slave = false;
              var F = sys('Factions');
              if (F && F.adjustGoodwill && st.factionId && st.factionId !== 'player') {
                F.adjustGoodwill(st.factionId, -4, who + ' escaped your collar');
              }
              pawn.faction = st.factionId || 'raider';
            }
            letter('A rebel got away',
              who + ' reached the edge of the map and kept walking. Everything they learned ' +
              'about your colony goes with them.', 'threat', pawn);
            if (map.removePawn) map.removePawn(pawn); else U.remove(map.pawns, pawn);
            pawn.map = null;
            return 'done';
          }
        })
      ];
    }
  });

  /* ============================================================
     11. WORK

     Section 10.5 hands the warden column to prisoners.js; these are
     more of the same column, registered the same way, plus two hauling
     givers for the bodies. Every id is namespaced so a clash with
     prisoners.js is impossible.
     ============================================================ */

  var _registered = false;

  function slavesFor(pawn, test) {
    var map = pawn.map, out = [], list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p.slave || p.dead || p === pawn) continue;
      if (p.slave.rebelling) continue;
      if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
      if (!test(p, p.slave)) continue;
      if (!reachable(map, pawn, p.x, p.y)) continue;
      out.push(p);
    }
    return out;
  }

  Slavery.registerWork = function () {
    if (_registered || !WorkGivers || !WorkGivers.register) return false;
    _registered = true;

    WorkGivers.register({
      id: 'slaveryEnslave', workType: 'warden', order: 25, label: 'enslave prisoners',
      tryGiveJob: function (pawn) {
        var map = pawn.map, cands = [], list = map.pawns;
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          if (!p.prisoner || p.dead || p.carriedBy || p.downed) continue;
          if (!Slavery.wantsEnslave(p)) continue;
          if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
          if (!reachable(map, pawn, p.x, p.y)) continue;
          cands.push(p);
        }
        var target = nearest(pawn, cands);
        return target ? claimed(pawn, 'enslavePrisoner', T.pawn(target)) : null;
      }
    });

    /* Suppression outranks conversation but not dinner, which is why it
       sits between prisoners.js's feed giver and its recruit giver. */
    WorkGivers.register({
      id: 'slaverySuppress', workType: 'warden', order: 35, label: 'suppress slaves',
      tryGiveJob: function (pawn) {
        var t = now();
        var cands = slavesFor(pawn, function (p, st) {
          if (p.carriedBy || p.downed) return false;
          if (Slavery.suppressionOf(p) > SUPPRESS_AT) return false;
          if (t - st.lastSuppressTick < SUPPRESS_COOLDOWN) return false;
          return !(p.needs && p.needs.food < 0.15);
        });
        var target = nearest(pawn, cands);
        return target ? claimed(pawn, 'suppressSlave', T.pawn(target)) : null;
      }
    });

    WorkGivers.register({
      id: 'slaveryCollar', workType: 'warden', order: 45, label: 'collar slaves',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        var collars = map.byDef('slaveCollar');
        var collar = null;
        for (var i = 0; i < collars.length; i++) {
          var c = collars[i];
          if (!c.spawned || !Res.canReserve(pawn, T.thing(c), 1)) continue;
          if (!reachable(map, pawn, c.x, c.y)) continue;
          collar = c; break;
        }
        if (!collar) return null;

        var cands = slavesFor(pawn, function (p) {
          if (p.carriedBy || p.downed) return false;
          var worn = p.wearingSlot ? p.wearingSlot('neck') : null;
          return !(worn && worn.defId === 'slaveCollar');
        });
        var target = nearest(pawn, cands);
        if (!target) return null;
        var job = claimed(pawn, 'collarSlave', T.pawn(target), T.thing(collar));
        if (job && !Res.reserve(pawn, job.targetB, 1)) {
          Res.release(pawn, job.targetA);
          return null;
        }
        return job;
      }
    });

    WorkGivers.register({
      id: 'slaveryFree', workType: 'warden', order: 55, label: 'free slaves',
      tryGiveJob: function (pawn) {
        var cands = slavesFor(pawn, function (p) {
          return !!p.freeDesignated && !p.carriedBy;
        });
        var target = nearest(pawn, cands);
        return target ? claimed(pawn, 'freeSlave', T.pawn(target)) : null;
      }
    });

    /* Stone burial, offered just ahead of the plain grave so a colony
       that built a sarcophagus actually uses it. */
    WorkGivers.register({
      id: 'slaveryEntomb', workType: 'doctor', order: 48, label: 'lay the dead in stone',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        var tombs = map.byDef('sarcophagus'), free = null;
        for (var i = 0; i < tombs.length; i++) {
          var s = tombs[i];
          if (!s.spawned || s.buriedName) continue;
          if (!Res.canReserve(pawn, T.thing(s), 1)) continue;
          free = s; break;
        }
        if (!free) return null;

        var corpses = map.byDef('corpse'), cands = [];
        for (var k = 0; k < corpses.length; k++) {
          var c = corpses[k];
          if (!c.spawned || !c.corpse) continue;
          /* A sarcophagus is for your own dead. A raider gets the hole. */
          if (c.corpse.faction !== 'player') continue;
          if (!Res.canReserve(pawn, T.thing(c), 1)) continue;
          if (!reachable(map, pawn, c.x, c.y)) continue;
          cands.push(c);
        }
        var corpse = nearest(pawn, cands);
        if (!corpse) return null;
        var job = claimed(pawn, 'entomb', T.thing(corpse), T.thing(free));
        if (job && !Res.reserve(pawn, job.targetB, 1)) {
          Res.release(pawn, job.targetA);
          return null;
        }
        return job;
      }
    });

    /* An empty gibbet is an order. Building one is the player saying
       yes; nothing else has to be clicked. */
    WorkGivers.register({
      id: 'slaveryDisplayCorpse', workType: 'haul', order: 90, label: 'hang enemy dead',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        var poles = map.byDef('gibbet'), pole = null;
        for (var i = 0; i < poles.length; i++) {
          var g = poles[i];
          if (!g.spawned || g.displayedName) continue;
          if (!Res.canReserve(pawn, T.thing(g), 1)) continue;
          pole = g; break;
        }
        if (!pole) return null;

        var corpses = map.byDef('corpse'), cands = [];
        for (var k = 0; k < corpses.length; k++) {
          var c = corpses[k];
          if (!c.spawned || !c.corpse) continue;
          if (c.corpse.faction === 'player') continue;
          var kind = Defs.maybe('pawnKind', c.corpse.kindId);
          if (!kind || kind.body !== 'human') continue;
          if (!Res.canReserve(pawn, T.thing(c), 1)) continue;
          if (!reachable(map, pawn, c.x, c.y)) continue;
          cands.push(c);
        }
        var corpse = nearest(pawn, cands);
        if (!corpse) return null;
        var job = claimed(pawn, 'displayCorpse', T.thing(corpse), T.thing(pole));
        if (job && !Res.reserve(pawn, job.targetB, 1)) {
          Res.release(pawn, job.targetA);
          return null;
        }
        return job;
      }
    });

    return true;
  };

  Slavery.registerWork();

  /* ============================================================
     12. READOUTS
     ============================================================ */

  Slavery.summary = function (pawn) {
    var st = pawn && pawn.slave;
    if (!st) return '';
    if (st.rebelling) return 'Rebelling';
    var s = Slavery.suppressionOf(pawn);
    var word = s > 0.7 ? 'cowed' : (s > 0.4 ? 'watchful' : (s > REBEL_AT ? 'restless' : 'about to break'));
    return 'Slave - suppression ' + U.pct(s) + ' (' + word + ')';
  };

  Slavery.breakdown = function (pawn) {
    var st = pawn && pawn.slave;
    if (!st) return [];
    var out = [
      { label: 'Suppression', value: Slavery.suppressionOf(pawn) },
      { label: 'Terror', value: st.terror || 0 },
      { label: 'Beatings', value: st.beatings | 0 },
      { label: 'Sessions', value: st.sessions | 0 }
    ];
    if (st.factionName) out.push({ label: 'Taken from', value: st.factionName });
    return out;
  };

  Slavery.colonyState = function (map) {
    map = map || (root.Game && root.Game.map);
    var slaves = Slavery.all(map);
    var displayed = 0;
    var poles = map && map.byDef ? map.byDef('gibbet') : [];
    for (var i = 0; poles && i < poles.length; i++) {
      if (poles[i].spawned && poles[i].displayedName) displayed++;
    }
    return {
      slaves: slaves.length,
      rebelling: slaves.filter(function (p) { return p.slave.rebelling; }).length,
      risk: Slavery.rebellionRisk(map),
      displayed: displayed
    };
  };

  /* ============================================================
     13. SAVE

     Per-pawn state rides on the pawn as plain fields, which is all
     save.js needs; what is saved here is the bookkeeping that hangs off
     the map and off this module instead.
     ============================================================ */

  Slavery.save = function () {
    var map = root.Game && root.Game.map;
    var poles = [];
    if (map && map.byDef) {
      var list = map.byDef('gibbet');
      for (var i = 0; i < list.length; i++) {
        var g = list[i];
        if (!g.displayedName) continue;
        poles.push({
          id: g.id, name: g.displayedName,
          kindId: g.displayedKindId || null, tick: g.displayedTick || 0
        });
      }
    }
    var graves = [];
    if (_knownGraves) for (var id in _knownGraves) graves.push(id | 0);
    return { version: 1, displays: poles, knownGraves: graves, scanTick: _scanTick };
  };

  Slavery.load = function (obj) {
    _knownGraves = Object.create(null);
    _knownExecuted = null;
    _beatTick = -1;
    if (!obj) { _scanTick = -1; return false; }

    var map = root.Game && root.Game.map;
    var i;
    for (i = 0; i < (obj.knownGraves || []).length; i++) {
      _knownGraves[obj.knownGraves[i]] = 1;
    }
    _scanTick = typeof obj.scanTick === 'number' ? obj.scanTick : -1;

    /* A displayed body is two scalar fields on a building, and save.js
       carries a thing's scalars - but a save written before it did, or
       one restored onto rebuilt things, needs them put back. */
    if (map && map.thing) {
      for (i = 0; i < (obj.displays || []).length; i++) {
        var row = obj.displays[i];
        var pole = map.thing(row.id);
        if (!pole) continue;
        pole.displayedName = row.name;
        pole.displayedKindId = row.kindId;
        pole.displayedTick = row.tick;
      }
    }
    return true;
  };

  Slavery.reset = function () {
    _knownGraves = null;
    _knownExecuted = null;
    _beatTick = -1;
    _scanTick = -1;
  };

  root.Slavery = Slavery;
})(this);
