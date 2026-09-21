/* ============================================================
   contraband.js - the economy running underneath the floor.

   prisoners.js owns the cell, the warden and the recruitment chat.
   prison.js owns the facility and the regime. This file owns the part
   neither of them can see: what comes in over the wall, who is holding
   it, where it is buried, who is selling it, who is talking to you
   about it, and which of your prisoners have quietly organised
   themselves into something that can take a wing off you.

   The design rule for the whole file is one sentence: everything here
   must be findable and fixable by a player who is paying attention,
   and invisible to one who is not. So nothing is random noise. Every
   gram that gets inside came through a ROUTE, and every route is a
   real fact about the map the player built - an unroofed yard within
   throwing distance of the edge, a stove the cell block can walk to, a
   stockpile of flake that shares an area with the cells, a warden who
   walks in wearing a pistol. Close the route and the supply stops.
   Leave it open and the supply compounds, because supply makes
   dealers, dealers make favours, favours make gangs, and gangs make
   the riot that takes your wing apart with knives you delivered.

   State lives where save.js can already carry it. Per-prisoner facts
   sit on `pawn.contraband`, which save.js walks as plain own fields.
   Stashes hang off the prisoner who dug them, because every stash has
   an owner. Gangs are rebuilt from their members. What is left -
   policy, the ledger, the route cache - is small, and Contraband.save
   hands it over for whoever wires it up.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Everything above this file in the load order may be bound now.
     Anything below it - Social, Prison, Reform, Game, Factions - is
     reached through sys() inside a function body, at tick time. */
  var T = root.T;
  var Res = root.Res;
  var Jobs = root.Jobs;
  var Toils = root.Toils;
  var Path = root.Path;
  var Regions = root.Regions;
  var WorkGivers = root.WorkGivers;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  function sys(name) { return root[name] || null; }
  function now() { var G = root.Game; return (G && typeof G.tick === 'number') ? G.tick : 0; }

  /* ============================================================
     0. NUMBERS

     Per-day rates are divided by the beat they are spent on, which is
     the contract's arithmetic: 60000 ticks to the day.
     ============================================================ */

  var DAY = 60000;
  var BEAT = 250;              /* the underground's own clock            */
  var ROUTE_BEATS = 4;         /* route openness is recomputed this often */
  var GANG_BEATS = 8;          /* membership is recomputed this often     */
  var MAX_CATCHUP = 4;         /* beats a single pump may make up         */

  var THROW_REACH = 13;        /* how far a package can be thrown inward  */
  var ROUTE_BASE = 0.009;      /* per beat, so a wide-open route runs ~2 items a day */

  var STASH_CAP = 6;           /* items one hole in the floor will hold   */
  var CARRY_CAP = 3;           /* what a prisoner keeps on their person   */
  var HEAT_PER_BEAT = 0.006;   /* a stash warms up while guards walk past */
  var HEAT_MOVE_AT = 0.6;      /* above this they go and move it          */
  var MOVE_COOLDOWN = 9000;    /* nobody digs the same hole up twice an hour */

  var SHAKEDOWN_WORK = 760;
  var FRISK_WORK = 220;
  var DOG_SWEEP_WORK = 540;
  var CONFISCATE_WORK = 90;
  var INFORMANT_WORK = 430;
  var TURN_WORK = 640;
  var RAISE_DOG_WORK = 2400;
  var RAISE_DOG_KIBBLE = 25;

  var FRISK_COOLDOWN = 9000;
  var SHAKEDOWN_COOLDOWN = 20000;
  var INFORMANT_COOLDOWN = 22000;

  var DEALER_SUPPLY = 4;       /* holding + stashed value that makes a dealer */
  var DEAL_COOLDOWN = 5000;
  var DEBT_PATIENCE = DAY * 1.5;

  var GANG_MIN = 3;            /* affiliates needed before a gang exists  */
  var GANG_HEAT_FIGHT = 1.0;   /* rival tension that spills into blood    */
  var EXPOSURE_FATAL = 1.0;

  /* ============================================================
     1. CONTENT

     def_things.js keeps its field templates private, so the shapes are
     restated. Every id registered here is new and namespaced; nothing
     already in the registry is touched.
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
    building: null, weapon: null, apparel: null
  };

  function itemDefaults(over) {
    var out = {}, k;
    for (k in ITEM_DEFAULTS) out[k] = ITEM_DEFAULTS[k];
    if (over) for (k in over) out[k] = over[k];
    return out;
  }

  var MELEE_ACCURACY = { touch: 0.95, short: 0.8, medium: 0.6, long: 0.4 };

  Defs.add('thing', {

    /* The archetype. Made out of whatever the cell provided - a bed
       slat, a sharpened spoon, a length of window frame - which is why
       it exists at all even in a prison nothing ever gets into. */
    cbShiv: {
      label: 'shiv',
      description: 'A ground-down strip of metal with cloth wound round one end. Worthless, ' +
        'unregistered, and it turns an argument in a corridor into a death.',
      sprite: 'knife', color: '#9aa0aa', color2: '#7a5c3a',
      stackLimit: 1, mass: 0.2, marketValue: 6, hp: 40, flammable: false,
      weapon: {
        ranged: false, damage: 8, damageType: 'stab', range: 1,
        warmupTicks: 0, cooldownTicks: 90, burstCount: 1, burstTicks: 0,
        accuracy: MELEE_ACCURACY, armorPen: 0.1,
        projectileSpeed: 0, projectileDef: null, minRange: 0, forcedMissRadius: 0
      }
    },

    cbFile: {
      label: 'file',
      description: 'A hand file with the handle snapped off. Given a week of nights it will ' +
        'take the pins out of a door, and nobody hears a thing.',
      sprite: 'item', color: '#8f97a3', color2: '#4a4a52',
      stackLimit: 1, mass: 0.4, marketValue: 22, hp: 60, flammable: false
    },

    cbLockpick: {
      label: 'lockpick',
      description: 'Two pieces of wire, bent right. The cheapest object in the prison and the ' +
        'one that makes every door in it a suggestion.',
      sprite: 'item', color: '#c9a227', color2: '#7a6318',
      stackLimit: 1, mass: 0.05, marketValue: 30, hp: 30, flammable: false
    },

    cbDiggingSpike: {
      label: 'digging spike',
      description: 'A shortened bar of steel, flattened at one end. Slow going through packed ' +
        'earth, and it does not care what the walls are made of.',
      sprite: 'item', color: '#6e6e78', color2: '#3b3b42',
      stackLimit: 1, mass: 1.6, marketValue: 26, hp: 90, flammable: false
    },

    cbBurnerRadio: {
      label: 'burner radio',
      description: 'A handset in a sock, charged off a lamp socket. Whoever is holding it can ' +
        'tell people outside exactly where your walls are thin.',
      sprite: 'item', color: '#3d5a6c', color2: '#c0c8cf',
      stackLimit: 1, mass: 0.3, marketValue: 90, hp: 25, flammable: false
    },

    cbHooch: {
      label: 'hooch',
      description: 'Fruit, sugar and bread water, fermented in a bag behind a cistern. It ' +
        'tastes like the bag. Nobody in the block cares.',
      sprite: 'barrel', color: '#8e6b3a', color2: '#d9c38a',
      stackLimit: 10, mass: 0.6, marketValue: 9, rotDays: null
    }

  }, itemDefaults());

  var BUILDING_DEFAULTS = itemDefaults({
    category: 'building', sprite: 'box', stackLimit: 1,
    mass: 30, marketValue: 0, hp: 160,
    passable: false, pathCost: 0, fillPercent: 1,
    blocksLight: false, holdsRoof: false, flammable: false,
    buildSkill: 'construction', building: bld({})
  });

  Defs.add('thing', {

    /* The security spend. It sits in a doorway and reads everyone who
       walks through it, which is why where you put it is the whole
       decision: on the only corridor out of the block it catches
       everything and stops the block dead every time it chirps. */
    cbMetalDetector: {
      label: 'metal detector',
      description: 'A powered arch with a sensor loop. It sees steel going past and nothing ' +
        'else, so it catches shivs and files and never once catches a bag of flake.',
      sprite: 'box', color: '#8f97a3', color2: '#ffc23c',
      hp: 180, mass: 60, passable: true, pathCost: 4, fillPercent: 0.2,
      beauty: -2, marketValue: 180,
      buildCost: { steel: 45, components: 3 }, workToBuild: 1400,
      buildCategory: 'security',
      building: bld({ powerConsumed: 120, interactionOffset: null })
    },

    /* Where confiscated goods go. A locker the player can point at is
       also the ledger of what the prison has been eating. */
    cbEvidenceLocker: {
      label: 'evidence locker',
      description: 'A steel cabinet with a tally sheet on the door. Everything taken off a ' +
        'prisoner ends up in here, which makes it the most interesting furniture you own.',
      sprite: 'box', color: '#6e7480', color2: '#c9b48a',
      hp: 200, mass: 55, beauty: -1, marketValue: 120,
      buildCost: { steel: 30, wood: 10 }, workToBuild: 900,
      buildCategory: 'furniture',
      building: bld({ isTable: false })
    },

    /* The visiting route, made physical. Build it and people come to
       see your prisoners; they come carrying. Do not build it and your
       prisoners never see anyone, which prisoners.js charges you for
       in mood and resistance that will not fall. */
    cbVisitationTable: {
      label: 'visitation table',
      description: 'A long table split by a low partition, bolted down. Families sit one side, ' +
        'prisoners the other, and something goes across it every single week.',
      sprite: 'table', color: '#8a6134', color2: '#c9b48a',
      size: { w: 2, h: 1 }, rotatable: true,
      hp: 160, mass: 45, fillPercent: 0.4, beauty: 2, comfort: 0.4, marketValue: 90,
      buildCost: { wood: 45 }, workToBuild: 850,
      buildCategory: 'furniture',
      building: bld({ isTable: true })
    },

    /* The other half of the search problem. A dog smells what a metal
       detector cannot, and a dog has to be raised by somebody who
       knows how, out of food the colony could have eaten. */
    cbKennel: {
      label: 'kennel',
      description: 'A run, a shelter and a feed bin. A handler who works it for long enough ' +
        'raises a dog that can smell a bag of leaf through a mattress.',
      sprite: 'box', color: '#7b5427', color2: '#b08c5a',
      size: { w: 2, h: 2 },
      hp: 220, mass: 80, beauty: -1, marketValue: 100,
      buildCost: { wood: 60, steel: 10 }, workToBuild: 1100,
      buildCategory: 'furniture',
      building: bld({})
    }

  }, BUILDING_DEFAULTS);

  Defs.add('pawnKind', {
    searchDog: {
      label: 'search dog',
      description: 'Lean, obsessive and entirely uninterested in you. Raised on a scent and ' +
        'paid in praise, and it will find a stash four prisoners swore was not there.',
      race: 'animal', isAnimal: true, body: 'quadruped', defaultFaction: 'player',
      techLevel: 'animal', sprite: 'wolf',
      combatPower: 55,
      baseHealthScale: 0.6, healthScale: 0.6,
      baseBodySize: 0.5, bodySize: 0.5, drawSize: 0.95,
      moveSpeed: 5.6, moveSpeedFactor: 1,
      baseHungerRate: 1.1, hungerRateFactor: 0.8,
      lifeExpectancyYears: 13, ageRange: [0.5, 11],
      wildness: 0.05, trainability: 'advanced', packSize: [1, 1],
      meleeDamage: 9, meleeDamageType: 'bite', meleeCooldownTicks: 95, meleeSkill: 5,
      meleeArmorPen: 0,
      butcherProducts: { meatRaw: 35, leather: 20 }, leatherAmount: 20,
      color: '#7a6a55', color2: '#3b332a',
      comfyTempMin: -28, comfyTempMax: 36,
      diet: 'carnivore', predator: false, grazer: false, nocturnal: false,
      packAnimal: false, breeds: false, nuzzles: true,
      manhunterChance: 0, revengeChance: 0, manhunterOnTameFail: 0,
      explodeOnDeath: false, explodes: false,
      weapons: [], apparel: []
    }
  });

  Defs.add('research', {
    cbScanning: {
      label: 'contraband scanning', cost: 1100, techLevel: 'industrial', tab: 'advanced',
      description: 'Induction loops and a threshold that can be tuned. Steel walking past a ' +
        'doorway becomes a number, and a number becomes an alarm.',
      prerequisites: ['electricity'],
      unlocks: ['cbMetalDetector'],
      uiPosition: { x: 2, y: 8 }
    },
    cbScentHounds: {
      label: 'scent hounds', cost: 600, techLevel: 'neolithic', tab: 'basic',
      description: 'Raise a dog on one smell until it wants nothing else. Cheap, patient, ' +
        'and it works on the half of the trade no machine will ever see.',
      prerequisites: [],
      unlocks: ['cbKennel'],
      uiPosition: { x: 1, y: 8 }
    }
  });

  /* Mood is stated in RimWorld points; needs.js divides by 100. Every
     magnitude is past 1.5 so nothing here can be read as a raw offset. */
  Defs.add('thought', {
    cbCellTossed: {
      label: 'Cell tossed', durationDays: 1.2, stackLimit: 3,
      stages: [{ label: 'They pulled my cell apart', mood: -9 }]
    },
    cbFrisked: {
      label: 'Searched', durationDays: 0.4, stackLimit: 4,
      stages: [{ label: 'Hands on me again', mood: -4 }]
    },
    cbLostStash: {
      label: 'Stash found', durationDays: 1.5, stackLimit: 2,
      stages: [{ label: 'They found my stash', mood: -8 }]
    },
    cbScored: {
      label: 'Scored', durationDays: 0.6, stackLimit: 2,
      stages: [{ label: 'I got hold of something', mood: 7 }]
    },
    cbExtorted: {
      label: 'Taxed by the block', durationDays: 1.5, stackLimit: 3,
      stages: [{ label: 'They took it off me', mood: -10 }]
    },
    cbGangProtected: {
      label: 'Crew at my back', durationDays: 1, stackLimit: 1,
      stages: [{ label: 'Nobody touches me now', mood: 7 }]
    },
    cbDealerRespect: {
      label: 'Everyone owes me', durationDays: 1, stackLimit: 1,
      stages: [{ label: 'Everyone in here owes me', mood: 6 }]
    },
    cbSnitchKilled: {
      label: 'They killed the snitch', durationDays: 4, stackLimit: 2,
      stages: [{ label: 'They cut the snitch in the corridor', mood: -12 }],
      nullifiedByTrait: ['psychopath']
    },
    cbInformantPaid: {
      label: 'Looked after', durationDays: 1.2, stackLimit: 1,
      stages: [{ label: 'The warden looks after me', mood: 9 }]
    },
    cbBlockWar: {
      label: 'The block is at war', durationDays: 2, stackLimit: 2,
      stages: [{ label: 'The block is at war with itself', mood: -11 }]
    }
  });

  /* ============================================================
     2. THE CATALOGUE

     Every contraband item is one row: where it comes from, what it is
     worth inside, what finds it, and - the part that matters - the one
     specific thing it lets a prisoner do.
     ============================================================ */

  var Contraband = {};

  var ITEMS = {
    hooch:   { label: 'hooch', tier: 'luxury', defId: 'cbHooch', value: 1, bulk: 1,
               metal: 0.0, scent: 0.7, search: 0.8, enables: 'mood',
               sources: ['cell', 'kitchen', 'visitor'] },
    booze:   { label: 'smuggled drink', tier: 'luxury', defId: 'beer', value: 2, bulk: 1,
               metal: 0.0, scent: 0.8, search: 0.7, enables: 'mood',
               sources: ['visitor', 'thrown', 'delivery'] },
    leaf:    { label: 'smokeleaf', tier: 'drug', defId: 'smokeleafJoint', value: 3, bulk: 0.4,
               metal: 0.0, scent: 0.9, search: 0.5, enables: 'drug',
               sources: ['visitor', 'thrown', 'delivery'] },
    powder:  { label: 'flake', tier: 'drug', defId: 'flake', value: 6, bulk: 0.2,
               metal: 0.0, scent: 0.85, search: 0.35, enables: 'drug',
               sources: ['visitor', 'thrown', 'delivery'] },
    yayo:    { label: 'yayo', tier: 'drug', defId: 'yayo', value: 9, bulk: 0.2,
               metal: 0.0, scent: 0.85, search: 0.3, enables: 'drug',
               sources: ['visitor', 'delivery'] },
    shiv:    { label: 'shiv', tier: 'weapon', defId: 'cbShiv', value: 4, bulk: 0.5,
               metal: 0.75, scent: 0.1, search: 0.55, enables: 'violence',
               sources: ['cell', 'workshop'] },
    knife:   { label: 'kitchen knife', tier: 'weapon', defId: 'knife', value: 7, bulk: 0.6,
               metal: 0.95, scent: 0.1, search: 0.6, enables: 'violence',
               sources: ['kitchen', 'workshop'] },
    gun:     { label: 'pistol', tier: 'weapon', defId: 'pistol', value: 20, bulk: 1.4,
               metal: 0.99, scent: 0.15, search: 0.75, enables: 'gun',
               sources: ['guard', 'thrown'] },
    file:    { label: 'file', tier: 'tool', defId: 'cbFile', value: 5, bulk: 0.4,
               metal: 0.9, scent: 0.05, search: 0.5, enables: 'escapeDoor',
               sources: ['workshop', 'delivery', 'visitor'] },
    pick:    { label: 'lockpick', tier: 'tool', defId: 'cbLockpick', value: 6, bulk: 0.1,
               metal: 0.45, scent: 0.05, search: 0.3, enables: 'escapeLock',
               sources: ['cell', 'visitor', 'workshop'] },
    spike:   { label: 'digging spike', tier: 'tool', defId: 'cbDiggingSpike', value: 6, bulk: 1.6,
               metal: 0.95, scent: 0.05, search: 0.8, enables: 'escapeTunnel',
               sources: ['workshop', 'delivery', 'thrown'] },
    radio:   { label: 'burner radio', tier: 'comms', defId: 'cbBurnerRadio', value: 12, bulk: 0.4,
               metal: 0.6, scent: 0.05, search: 0.45, enables: 'callOut',
               sources: ['visitor', 'thrown', 'guard'] }
  };

  var ITEM_IDS = Object.keys(ITEMS);
  ITEM_IDS.forEach(function (id) { ITEMS[id].id = id; });

  Contraband.ITEMS = ITEMS;
  Contraband.items = function () { return ITEM_IDS.slice(); };
  Contraband.itemDef = function (id) { return ITEMS[id] || null; };

  /* A catalogue row is only real if the thing def behind it shipped.
     drugs.js may not be loaded; a prison without flake is still a
     prison, and the row quietly drops out of every weighted pick. */
  function itemExists(row) {
    return !row.defId || (Defs.has && Defs.has('thing', row.defId));
  }

  function tierAllowed(row, pol) {
    var t = pol.tolerate;
    return !(t && t[row.tier]);
  }

  /* ============================================================
     3. POLICY - the knobs, and what each one costs

     Every field here is a trade the player makes. None of them is a
     setting with a right answer.
     ============================================================ */

  function freshPolicy() {
    return {
      /* How hard the prison is searched, and how much mood that burns. */
      frisk: 'random',            /* never | random | suspicion | always     */
      shakedown: 'intel',         /* never | scheduled | intel | constant    */
      shakedownEveryDays: 2,
      dogPatrols: true,
      detectorAlarm: 'confiscate',/* ignore | confiscate | lockdown          */

      /* What happens to what you find. */
      confiscate: 'store',        /* destroy | store | sell                  */

      /* Which tiers the prison bothers to police. Leaving hooch alone
         buys quiet; leaving weapons alone buys a riot. */
      tolerate: { luxury: false, drug: false, tool: false, weapon: false, comms: false },

      /* Visiting. Closing it entirely closes the best route in and the
         only thing keeping some prisoners sane. */
      visits: 'open',             /* closed | open | patSearch | stripSearch */

      /* Informants: what a turned prisoner is paid, and how many you
         are willing to run at once. */
      informantPay: 'privileges', /* food | privileges | parole              */
      informantCap: 2,

      /* Gangs. Ignoring them is cheap until it is not; crushing them
         means putting hands on people every day. */
      gangs: 'watch'              /* ignore | watch | split | crush          */
    };
  }

  Contraband.policy = freshPolicy();

  Contraband.setPolicy = function (key, value) {
    var pol = Contraband.policy;
    if (!(key in pol)) return false;
    if (key === 'tolerate') {
      if (!value || typeof value !== 'object') return false;
      Object.keys(pol.tolerate).forEach(function (t) {
        if (value[t] !== undefined) pol.tolerate[t] = !!value[t];
      });
      return true;
    }
    pol[key] = value;
    state.routesTick = -1;        /* policy changes what the routes are worth */
    return true;
  };

  /* Searching is not free. This is the number every search multiplies
     its mood cost by, and the number the player is really setting when
     they turn the dial up. */
  function searchPressure() {
    var pol = Contraband.policy;
    var f = pol.frisk === 'always' ? 1 : (pol.frisk === 'suspicion' ? 0.5 : (pol.frisk === 'random' ? 0.35 : 0));
    var s = pol.shakedown === 'constant' ? 1 : (pol.shakedown === 'scheduled' ? 0.6 : (pol.shakedown === 'intel' ? 0.3 : 0));
    return U.clamp01(f * 0.45 + s * 0.55);
  }

  /* ============================================================
     4. STATE

     Module state is the index and the history. The facts themselves
     live on pawns, which is what makes them survive a save.
     ============================================================ */

  function freshState() {
    return {
      lastBeat: -1,
      beats: 0,
      routes: null,
      routesTick: -1,
      gangs: [],
      gangsTick: -1,
      gangSeq: 0,
      territory: {},
      fear: 0,                    /* what the block learned from the last body */
      lastShakedown: -99999,
      lastSweep: -99999,
      ledger: [],
      totals: {
        smuggled: 0, found: 0, confiscated: 0, destroyed: 0, sold: 0,
        deals: 0, extortions: 0, informants: 0, informantsKilled: 0, breaches: 0,
        gangFights: 0, shakedowns: 0, frisks: 0
      },
      mapId: 0
    };
  }

  var state = freshState();
  Contraband.state = state;

  function cbOf(pawn) {
    if (!pawn) return null;
    if (!pawn.contraband) {
      pawn.contraband = {
        holding: {}, stashes: [],
        gangId: 0, gangName: '', gangRank: 0, joinedTick: 0, affinity: '',
        dealer: false, favours: 0, sales: 0, debts: {},
        informant: false, informantSince: 0, informantById: 0,
        exposure: 0, intelGiven: 0, lastMeetTick: -99999,
        suspicion: 0, lastFriskTick: -99999, lastShakedownTick: -99999, lastTaxedTick: -99999,
        lastDealTick: -99999, lastMadeTick: -99999, lastGetTick: -99999,
        grudge: 0, protection: 0
      };
    }
    return pawn.contraband;
  }
  Contraband.of = cbOf;

  function nameOf(pawn) {
    if (!pawn || !pawn.name) return 'someone';
    return pawn.name.nick || pawn.name.first || 'someone';
  }

  function msg(text, pawn, type) {
    var G = sys('Game');
    if (G && G.msg) G.msg(text, { type: type || 'info', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }

  function letter(title, text, kind, pawn) {
    var G = sys('Game');
    if (G && G.letter) G.letter(title, text, { kind: kind || 'neutral', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
    else msg(title, pawn, kind === 'threat' ? 'threat' : 'info');
  }

  function think(pawn, id, opts) {
    var N = sys('Needs');
    if (N && N.addThought && Defs.has('thought', id)) N.addThought(pawn, id, opts);
  }

  function log(kind, text) {
    state.ledger.push({ tick: now(), kind: kind, text: text });
    if (state.ledger.length > 160) state.ledger.splice(0, state.ledger.length - 160);
  }
  Contraband.ledger = function (n) {
    var l = state.ledger;
    return n ? l.slice(Math.max(0, l.length - n)) : l.slice();
  };

  function skill(pawn, id) {
    if (!pawn) return 0;
    if (typeof pawn.skillLevel === 'function') return pawn.skillLevel(id) || 0;
    var s = pawn.skills && pawn.skills[id];
    return s ? (s.level || 0) : 0;
  }

  function hasTrait(pawn, id) {
    var t = pawn && pawn.traits;
    if (!t) return false;
    for (var i = 0; i < t.length; i++) {
      var v = t[i];
      if (v === id || (v && v.id === id) || (v && v.defId === id)) return true;
    }
    return false;
  }

  function moodOf(pawn) {
    var N = sys('Needs');
    if (N && N.mood) return N.mood(pawn);
    return typeof pawn.mood === 'number' ? pawn.mood : 0.5;
  }

  /* Who the underground is made of. Prisoners always; slaves too, once
     slavery.js is loaded, because a slave has the same nights and the
     same reasons and no wage to lose. */
  function inmates(map) {
    var out = [];
    if (!map) return out;
    var S = sys('Slavery');
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (p.dead || !p.isHuman) continue;
      if (p.prisoner) { out.push(p); continue; }
      if (S && S.isSlave && S.isSlave(p)) out.push(p);
    }
    return out;
  }
  Contraband.inmates = inmates;

  /* Staff, as opposed to stock. map.colonists() is faction-based and a
     prisoner wears the player's faction id, so asking it who is watching
     the block would answer "the prisoners are". */
  function freeColonists(map) {
    var out = [], list = map.colonists();
    for (var i = 0; i < list.length; i++) if (!isInmate(list[i])) out.push(list[i]);
    return out;
  }
  Contraband.staff = freeColonists;

  function isInmate(pawn) {
    if (!pawn || pawn.dead || !pawn.isHuman) return false;
    if (pawn.prisoner) return true;
    var S = sys('Slavery');
    return !!(S && S.isSlave && S.isSlave(pawn));
  }
  Contraband.isInmate = isInmate;

  /* The rooms the trade happens in. prisoners.js already works this
     out from the beds it owns; fall back to the rooms inmates are
     standing in so the file is not useless without it. */
  function blockRooms(map) {
    var P = sys('Prisoners');
    if (P && P.prisonRoomIds) {
      var ids = P.prisonRoomIds(map);
      if (ids && Object.keys(ids).length) return ids;
    }
    var out = {}, list = inmates(map);
    if (!Regions) return out;
    for (var i = 0; i < list.length; i++) {
      var rid = Regions.roomIdAt(map, list[i].x, list[i].y);
      if (rid > 0) out[rid] = true;
    }
    return out;
  }
  Contraband.blockRooms = blockRooms;

  function holdingValue(st) {
    var total = 0;
    for (var id in st.holding) {
      var row = ITEMS[id];
      if (row) total += row.value * st.holding[id];
    }
    return total;
  }

  function stashValue(st) {
    var total = 0;
    for (var i = 0; i < st.stashes.length; i++) {
      var items = st.stashes[i].items;
      for (var id in items) {
        var row = ITEMS[id];
        if (row) total += row.value * items[id];
      }
    }
    return total;
  }

  function holdingCount(st) {
    var n = 0;
    for (var id in st.holding) n += st.holding[id];
    return n;
  }

  function give(pawn, itemId, count) {
    var st = cbOf(pawn);
    st.holding[itemId] = (st.holding[itemId] || 0) + (count || 1);
    return st.holding[itemId];
  }

  function take(pawn, itemId, count) {
    var st = cbOf(pawn);
    var have = st.holding[itemId] || 0;
    var n = Math.min(have, count === undefined ? 1 : count);
    if (n <= 0) return 0;
    st.holding[itemId] = have - n;
    if (st.holding[itemId] <= 0) delete st.holding[itemId];
    return n;
  }

  Contraband.holds = function (pawn, itemId) {
    var st = pawn && pawn.contraband;
    if (!st) return 0;
    if (!itemId) return holdingCount(st);
    return st.holding[itemId] || 0;
  };

  /* Does this prisoner have the means to do a specific thing. This is
     the question every other system asks of this file. */
  Contraband.enables = function (pawn, what) {
    var st = pawn && pawn.contraband;
    if (!st) return null;
    for (var id in st.holding) {
      var row = ITEMS[id];
      if (row && row.enables === what && st.holding[id] > 0) return id;
    }
    return null;
  };

  Contraband.armed = function (pawn) {
    return Contraband.enables(pawn, 'gun') || Contraband.enables(pawn, 'violence');
  };

  /* ============================================================
     5. ROUTES

     Six ways in and one way it is made on site. Each one reads the map
     the player actually built and reports how open it is, where it is,
     and what the player would have to change. This is the part that
     makes the trade fixable instead of atmospheric.
     ============================================================ */

  /* A building stands on an impassable cell and an impassable cell has no
     area, so "can the block walk to this stove" is really "can the block
     walk to a tile beside it". */
  function sameAreaAsBlock(map, x, y, anchor) {
    if (!anchor || !Regions) return false;
    if (map.passable(x, y) && Regions.sameArea(map, anchor.x, anchor.y, x, y)) return true;
    for (var d = 0; d < U.ADJ8.length; d++) {
      var nx = x + U.ADJ8[d][0], ny = y + U.ADJ8[d][1];
      if (!map.inBounds(nx, ny) || !map.passable(nx, ny)) continue;
      if (Regions.sameArea(map, anchor.x, anchor.y, nx, ny)) return true;
    }
    return false;
  }

  function blockAnchor(map) {
    var list = inmates(map);
    if (list.length) return { x: list[0].x, y: list[0].y };
    var P = sys('Prisoners');
    var beds = (P && P.beds) ? P.beds(map) : [];
    return beds.length ? { x: beds[0].x, y: beds[0].y } : null;
  }

  function thingsInArea(map, defIds, anchor, limit) {
    var out = [];
    for (var d = 0; d < defIds.length; d++) {
      if (!Defs.has('thing', defIds[d])) continue;
      var list = map.byDef(defIds[d]) || [];
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t.spawned) continue;
        if (!sameAreaAsBlock(map, t.x, t.y, anchor)) continue;
        out.push(t);
        if (out.length >= (limit || 8)) return out;
      }
    }
    return out;
  }

  /* An unroofed cell inside the block that is close enough to the map
     edge for somebody outside to put a package on it. The single most
     common self-inflicted hole in a prison. */
  function thrownSpot(map, rooms) {
    if (!Regions) return null;
    var ids = Object.keys(rooms);
    for (var r = 0; r < ids.length; r++) {
      var room = Regions.rooms(map).get(Number(ids[r]));
      if (!room || !room.cells) continue;
      for (var c = 0; c < room.cells.length; c += 3) {
        var i = room.cells[c];
        var x = map.xOf(i), y = map.yOf(i);
        if (map.hasRoofAt(x, y)) continue;
        var edge = Math.min(x, y, map.w - 1 - x, map.h - 1 - y);
        if (edge <= THROW_REACH) return { x: x, y: y, edge: edge };
      }
    }
    return null;
  }

  var ROUTES = [
    {
      id: 'visitor', label: 'visitors',
      fix: 'take the visitation table out, or search what comes through it',
      items: ['booze', 'leaf', 'powder', 'yayo', 'pick', 'file', 'radio'],
      open: function (map, anchor, rooms) {
        var pol = Contraband.policy;
        if (pol.visits === 'closed') return { v: 0, why: 'visiting is closed', at: null };
        var tables = thingsInArea(map, ['cbVisitationTable'], anchor, 3);
        if (!tables.length) return { v: 0, why: 'nowhere for a visitor to sit', at: null };
        var v = 0.9;
        if (pol.visits === 'patSearch') v *= 0.5;
        if (pol.visits === 'stripSearch') v *= 0.18;
        return { v: v, why: tables.length + ' visitation table(s) inside the block', at: tables[0] };
      }
    },
    {
      id: 'thrown', label: 'over the wall',
      fix: 'roof the yard, or move it away from the map edge',
      items: ['booze', 'leaf', 'powder', 'spike', 'gun', 'radio'],
      open: function (map, anchor, rooms) {
        var spot = thrownSpot(map, rooms);
        if (!spot) return { v: 0, why: 'no open ground within throwing distance', at: null };
        var v = U.clamp01(1 - spot.edge / (THROW_REACH + 3));
        return { v: 0.35 + 0.65 * v, why: 'open yard ' + spot.edge + ' tiles from the edge', at: spot };
      }
    },
    {
      id: 'delivery', label: 'deliveries',
      fix: 'store drugs and weapons where the block cannot walk to them',
      items: ['booze', 'leaf', 'powder', 'yayo', 'file', 'spike'],
      open: function (map, anchor) {
        var ids = ['beer', 'smokeleafJoint', 'flake', 'yayo', 'goJuice', 'knife', 'pistol', 'steel'];
        var found = thingsInArea(map, ids, anchor, 6);
        if (!found.length) return { v: 0, why: 'nothing worth taking is stored in reach', at: null };
        return {
          v: U.clamp01(0.2 + 0.16 * found.length),
          why: found.length + ' stack(s) of tradeable goods share an area with the cells',
          at: found[0]
        };
      }
    },
    {
      id: 'workshop', label: 'the workshop',
      fix: 'keep workbenches out of the block, or stop prison labour',
      items: ['shiv', 'file', 'spike', 'pick'],
      open: function (map, anchor) {
        var benches = [];
        var all = Defs.buildings ? Defs.buildings() : [];
        for (var i = 0; i < all.length && benches.length < 4; i++) {
          var d = all[i];
          if (!d.building || !d.building.isWorkbench) continue;
          var list = map.byDef(d.id) || [];
          for (var j = 0; j < list.length; j++) {
            if (!list[j].spawned) continue;
            if (!sameAreaAsBlock(map, list[j].x, list[j].y, anchor)) continue;
            benches.push(list[j]); break;
          }
        }
        if (!benches.length) return { v: 0, why: 'no workbench the block can reach', at: null };
        return { v: U.clamp01(0.25 + 0.2 * benches.length), why: benches.length + ' workbench(es) in reach', at: benches[0] };
      }
    },
    {
      id: 'kitchen', label: 'the kitchen',
      fix: 'put a wall and a locked door between the cells and the stove',
      items: ['knife', 'hooch'],
      open: function (map, anchor) {
        var found = thingsInArea(map, ['stove', 'butcherTable', 'campfire'], anchor, 4);
        if (!found.length) return { v: 0, why: 'the block cannot reach a kitchen', at: null };
        return { v: U.clamp01(0.3 + 0.2 * found.length), why: found.length + ' cooking station(s) in reach', at: found[0] };
      }
    },
    {
      id: 'guard', label: 'a careless guard',
      fix: 'do not send armed colonists into the block, and train your wardens',
      items: ['gun', 'radio', 'pick'],
      open: function (map, anchor, rooms) {
        var worst = 0, who = null, inside = false;
        var list = freeColonists(map);
        for (var i = 0; i < list.length; i++) {
          var c = list[i];
          if (!c.equipment) continue;
          /* Anyone with warden or handler work is going into that block
             today whether or not they are standing in it right now, which
             is the decision the player is really making. */
          var rid = Regions ? Regions.roomIdAt(map, c.x, c.y) : 0;
          var here = !!rooms[rid];
          var assigned = c.workPriority && (c.workPriority.warden > 0 || c.workPriority.handle > 0);
          if (!here && !assigned) continue;
          /* A warden who knows the job does not put a pistol down on a
             table in a cell block. One who does not, does. */
          var sloppy = U.clamp01(1 - (skill(c, 'social') + skill(c, 'melee')) / 26);
          if (moodOf(c) < 0.35) sloppy = Math.min(1, sloppy + 0.25);
          if (!here) sloppy *= 0.5;
          if (sloppy > worst) { worst = sloppy; who = c; inside = here; }
        }
        if (!who) return { v: 0, why: 'nobody armed goes into the block', at: null };
        return {
          v: 0.10 + 0.5 * worst,
          why: nameOf(who) + (inside ? ' is in the block carrying a weapon' : ' works the block carrying a weapon'),
          at: who
        };
      }
    },
    {
      id: 'cell', label: 'made in a cell',
      fix: 'shake the cells down, and do not leave the block unwatched',
      items: ['shiv', 'hooch', 'pick'],
      open: function (map, anchor, rooms) {
        var ids = Object.keys(rooms);
        if (!ids.length) return { v: 0, why: 'no block to work in', at: null };
        /* Unwatched time is the raw material. A block with a colonist
           standing in it is a block where nothing gets ground down. */
        var watched = 0, total = 0;
        var list = freeColonists(map);
        for (var r = 0; r < ids.length; r++) {
          total++;
          for (var i = 0; i < list.length; i++) {
            if (Regions && Regions.roomIdAt(map, list[i].x, list[i].y) === Number(ids[r])) { watched++; break; }
          }
        }
        var alone = total ? 1 - watched / total : 1;
        return { v: 0.18 + 0.4 * alone, why: Math.round(alone * 100) + '% of the block is unwatched', at: null };
      }
    }
  ];

  function refreshRoutes(map) {
    var anchor = blockAnchor(map);
    var rooms = blockRooms(map);
    var pol = Contraband.policy;
    var out = [];
    for (var i = 0; i < ROUTES.length; i++) {
      var r = ROUTES[i], res;
      try { res = anchor ? r.open(map, anchor, rooms) : { v: 0, why: 'no prisoners', at: null }; }
      catch (e) { res = { v: 0, why: 'unknown', at: null }; }
      out.push({
        id: r.id, label: r.label, fix: r.fix,
        openness: U.clamp01(res.v), why: res.why,
        x: res.at ? res.at.x : null, y: res.at ? res.at.y : null,
        items: r.items
      });
    }
    /* Searching does not close a route; it makes using one expensive.
       That is the difference between a policy and a wall. */
    var damp = 1 - 0.45 * searchPressure();
    for (var j = 0; j < out.length; j++) out[j].effective = out[j].openness * damp;
    state.routes = out;
    state.routesTick = now();
    return out;
  }

  Contraband.routes = function (map) {
    map = map || (sys('Game') && sys('Game').map);
    if (!map) return state.routes || [];
    if (!state.routes || now() - state.routesTick > BEAT * ROUTE_BEATS) refreshRoutes(map);
    return state.routes;
  };

  /* ============================================================
     6. ACQUISITION - a route delivers
     ============================================================ */

  function wantsSomething(pawn, st) {
    /* Appetite: an addict, a bored prisoner, a frightened one, and a
       dealer who wants stock. Everyone else is only mildly interested. */
    var pull = 0.25;
    var D = sys('Drugs');
    if (D && D.addictions) {
      var add = D.addictions(pawn) || [];
      pull += 0.35 * Math.min(2, add.length);
    }
    pull += (1 - moodOf(pawn)) * 0.4;
    if (st.dealer) pull += 0.4;
    if (st.gangId) pull += 0.15;
    if (hasTrait(pawn, 'psychopath')) pull += 0.1;
    return U.clamp01(pull);
  }

  function pickItem(route, pol) {
    var rows = [];
    for (var i = 0; i < route.items.length; i++) {
      var row = ITEMS[route.items[i]];
      if (row && itemExists(row)) rows.push(row);
    }
    if (!rows.length) return null;
    /* Cheap things come in constantly, expensive ones rarely. A pistol
       over the wall is a story precisely because it is a long roll. */
    return U.pickWeighted(rows, function (r) {
      var w = 12 / (2 + r.value);
      if (!tierAllowed(r, pol)) w *= 1;          /* tolerated tiers still arrive */
      return w;
    });
  }

  function runRoutes(map, list) {
    if (!list.length) return;
    var routes = Contraband.routes(map);
    var pol = Contraband.policy;
    /* More bodies, more traffic. Two prisoners cannot keep a route busy;
       twenty of them keep all seven busy at once. */
    var crowd = U.clamp01(0.25 + list.length * 0.1);
    for (var i = 0; i < routes.length; i++) {
      var route = routes[i];
      if (route.effective <= 0.01) continue;
      if (!U.chance(ROUTE_BASE * route.effective * crowd)) continue;

      var row = pickItem(route, pol);
      if (!row) continue;

      /* Whoever wants it most and is nearest the hole gets it. */
      var best = null, bestScore = -1;
      for (var p = 0; p < list.length; p++) {
        var pawn = list[p];
        if (pawn.downed || pawn.dead) continue;
        var st = cbOf(pawn);
        if (holdingCount(st) >= CARRY_CAP + (st.dealer ? 4 : 0)) continue;
        var score = wantsSomething(pawn, st) * U.randRange(0.6, 1.4);
        if (route.x !== null) score *= 1 / (1 + U.dist(pawn.x, pawn.y, route.x, route.y) * 0.03);
        if (score > bestScore) { bestScore = score; best = pawn; }
      }
      if (!best) continue;

      give(best, row.id, 1);
      cbOf(best).lastGetTick = now();
      state.totals.smuggled++;
      think(best, 'cbScored', {});
      log('in', nameOf(best) + ' got hold of ' + row.label + ' - ' + route.label);

      /* The player is told about the things that change the threat
         model, and left to find the rest for themselves. That
         asymmetry is the entire point of the system. */
      if (row.enables === 'gun') {
        letter('A gun is inside',
          'Somebody in the block is holding a ' + row.label + '. It came in through ' +
          route.label + ': ' + route.why + '. Until it is found, every search your wardens ' +
          'run is a search that can end badly.', 'threat', best);
      }
    }
  }

  /* ============================================================
     7. STASHES

     A prisoner holding something looks for somewhere to put it: their
     own cell floor, a piece of furniture, a corner of the yard. Heat
     is how close the guards have been walking; a hot stash gets moved,
     which is the prisoner telling the player something without
     knowing it.
     ============================================================ */

  function makeStash(pawn, st, map) {
    var x = pawn.x, y = pawn.y, kind = 'floor', thingId = 0;
    var here = map.buildingAt(pawn.x, pawn.y);
    if (!here) {
      /* Under the bed is the first place anyone looks and still the
         most popular, because the alternative is carrying it. */
      for (var d = 0; d < U.ADJ8.length; d++) {
        var b = map.buildingAt(pawn.x + U.ADJ8[d][0], pawn.y + U.ADJ8[d][1]);
        if (b && b.def && b.def.building && (b.def.building.isBed || b.def.building.isTable)) {
          x = b.x; y = b.y; kind = 'furniture'; thingId = b.id; break;
        }
      }
    } else { kind = 'furniture'; thingId = here.id; }
    if (kind === 'floor' && Regions) {
      var room = Regions.roomAt(map, pawn.x, pawn.y);
      if (room && room.outdoor) kind = 'yard';
    }
    var stash = {
      id: U.nextId(), x: x, y: y, kind: kind, thingId: thingId,
      items: {}, heat: 0, known: false, madeTick: now(), movedTick: now()
    };
    st.stashes.push(stash);
    return stash;
  }

  function stashSomething(pawn, st, map) {
    var ids = Object.keys(st.holding);
    if (!ids.length) return false;
    var stash = null;
    for (var i = 0; i < st.stashes.length; i++) {
      var s = st.stashes[i];
      var n = 0;
      for (var k in s.items) n += s.items[k];
      if (n < STASH_CAP && !s.known) { stash = s; break; }
    }
    if (!stash) {
      if (st.stashes.length >= 3) return false;
      stash = makeStash(pawn, st, map);
    }
    var id = U.pick(ids);
    if (!take(pawn, id, 1)) return false;
    stash.items[id] = (stash.items[id] || 0) + 1;
    return true;
  }

  function moveStash(pawn, st, map, stash) {
    /* Somewhere else in the same block, and the heat resets with it.
       A player watching the block sees a prisoner walk somewhere odd
       and come back empty-handed. */
    var tries = 8;
    while (tries-- > 0) {
      var x = pawn.x + U.randInt(-5, 5), y = pawn.y + U.randInt(-5, 5);
      if (!map.inBounds(x, y) || !map.passable(x, y)) continue;
      if (Regions && !Regions.sameArea(map, pawn.x, pawn.y, x, y)) continue;
      stash.x = x; stash.y = y; stash.heat = 0; stash.known = false;
      stash.movedTick = now();
      stash.kind = map.buildingAt(x, y) ? 'furniture' : stash.kind;
      log('move', nameOf(pawn) + ' moved a stash out of the way of a search');
      return true;
    }
    return false;
  }

  Contraband.stashes = function (map) {
    var out = [], list = inmates(map);
    for (var i = 0; i < list.length; i++) {
      var st = list[i].contraband;
      if (!st) continue;
      for (var j = 0; j < st.stashes.length; j++) {
        var s = st.stashes[j];
        out.push({
          id: s.id, x: s.x, y: s.y, kind: s.kind, heat: s.heat, known: s.known,
          ownerId: list[i].id, owner: nameOf(list[i]), items: s.items
        });
      }
    }
    return out;
  };

  function stashOwner(map, stashId) {
    var list = inmates(map);
    for (var i = 0; i < list.length; i++) {
      var st = list[i].contraband;
      if (!st) continue;
      for (var j = 0; j < st.stashes.length; j++) {
        if (st.stashes[j].id === stashId) return { pawn: list[i], st: st, stash: st.stashes[j], idx: j };
      }
    }
    return null;
  }
  Contraband.stashOwner = stashOwner;

  /* ============================================================
     8. SEARCHES

     Four ways to find it, each good at something different, each with
     a bill attached. A shakedown wrecks the cell and infuriates whoever
     lives in it; that is the trade, and it is the trade on purpose.
     ============================================================ */

  function confiscateItems(finder, map, x, y, items) {
    var pol = Contraband.policy;
    var lines = [], value = 0, n = 0;
    for (var id in items) {
      var count = items[id], row = ITEMS[id];
      if (!row || count <= 0) continue;
      n += count;
      value += row.value * count;
      lines.push(count > 1 ? count + ' ' + row.label : row.label);
      if (pol.confiscate === 'destroy') { state.totals.destroyed += count; continue; }
      if (!row.defId || !Defs.has('thing', row.defId)) { state.totals.destroyed += count; continue; }
      var locker = nearestLocker(map, x, y);
      var tx = locker ? locker.x : x, ty = locker ? locker.y : y;
      if (map.addItem) map.addItem(row.defId, tx, ty, count);
    }
    if (!n) return null;
    state.totals.confiscated += n;
    if (pol.confiscate === 'sell') {
      var E = sys('Economy');
      var silver = Math.round(value * 6);
      if (E && E.addSilver) E.addSilver(silver, 'contraband sale');
      else if (map.addItem && Defs.has('thing', 'silver')) map.addItem('silver', x, y, silver);
      state.totals.sold += silver;
      /* Selling what you took off a prisoner is profitable and it is
         not free: the colony is now in the trade it is policing. */
      var list = freeColonists(map);
      for (var c = 0; c < list.length; c++) {
        if (hasTrait(list[c], 'kind')) think(list[c], 'cbFrisked', { mood: -3 });
      }
    }
    return { count: n, value: value, text: lines.join(', ') };
  }

  function nearestLocker(map, x, y) {
    var list = map.byDef('cbEvidenceLocker') || [];
    var best = null, bd = Infinity;
    for (var i = 0; i < list.length; i++) {
      if (!list[i].spawned) continue;
      var d = U.distSq(x, y, list[i].x, list[i].y);
      if (d < bd) { bd = d; best = list[i]; }
    }
    return best;
  }

  /* One search roll against one item, by whatever is doing the
     searching. `channel` picks which of the item's three exposures
     matters, which is why a dog and a metal detector are not the same
     tool with a different sprite. */
  function finds(row, channel, power) {
    var base = channel === 'metal' ? row.metal : (channel === 'scent' ? row.scent : row.search);
    return U.chance(U.clamp01(base * power));
  }

  Contraband.frisk = function (warden, prisoner) {
    var map = prisoner && prisoner.map;
    if (!map || !isInmate(prisoner)) return null;
    var st = cbOf(prisoner);
    st.lastFriskTick = now();
    state.totals.frisks++;

    var power = 0.55 + 0.035 * skill(warden, 'social') + 0.02 * skill(warden, 'melee');
    var got = {};
    for (var id in st.holding) {
      var row = ITEMS[id];
      if (!row) continue;
      if (!tierAllowed(row, Contraband.policy)) continue;
      var count = st.holding[id], hit = 0;
      for (var i = 0; i < count; i++) if (finds(row, 'search', power)) hit++;
      if (hit) { got[id] = hit; take(prisoner, id, hit); }
    }
    think(prisoner, 'cbFrisked', {});
    st.suspicion = Math.max(0, st.suspicion - 0.4);

    var res = confiscateItems(warden, map, prisoner.x, prisoner.y, got);
    if (res) {
      state.totals.found += res.count;
      log('found', nameOf(warden) + ' found ' + res.text + ' on ' + nameOf(prisoner));
      msg(nameOf(warden) + ' found ' + res.text + ' on ' + nameOf(prisoner), prisoner, 'threat');
      noteLoss(prisoner, st);
    }
    return res;
  };

  function noteLoss(prisoner, st) {
    think(prisoner, 'cbLostStash', {});
    st.grudge = U.clamp01(st.grudge + 0.18);
    /* Somebody talked. They do not know who, and that is exactly the
       problem an informant has. */
    st.suspicion = U.clamp01(st.suspicion + 0.25);
  }

  /* Tearing a cell apart. Finds stashes in the room, wrecks the
     furniture, and everybody who sleeps there hates you for a day. */
  Contraband.shakedown = function (warden, map, x, y) {
    if (!map || !Regions) return null;
    var rid = Regions.roomIdAt(map, x, y);
    var room = Regions.roomAt(map, x, y);
    var power = 0.5 + 0.04 * skill(warden, 'social') + 0.03 * skill(warden, 'intellectual');
    state.totals.shakedowns++;

    var got = {}, hitAny = 0, victims = [];
    var list = inmates(map);
    for (var p = 0; p < list.length; p++) {
      var st = list[p].contraband;
      if (!st) continue;
      var mine = 0;
      for (var s = st.stashes.length - 1; s >= 0; s--) {
        var stash = st.stashes[s];
        if (Regions.roomIdAt(map, stash.x, stash.y) !== rid) continue;
        var localPower = power * (stash.known ? 2.2 : 1) * (stash.kind === 'furniture' ? 0.85 : 1);
        var emptied = true;
        for (var id in stash.items) {
          var row = ITEMS[id];
          if (!row) continue;
          var count = stash.items[id], hit = 0;
          for (var i = 0; i < count; i++) if (finds(row, 'search', localPower)) hit++;
          if (hit) {
            got[id] = (got[id] || 0) + hit;
            stash.items[id] -= hit;
            hitAny += hit; mine += hit;
          }
          if (stash.items[id] <= 0) delete stash.items[id];
          else emptied = false;
        }
        if (emptied) st.stashes.splice(s, 1);
        else stash.known = false;
      }
      /* A shakedown is also a frisk of whoever is standing in it. */
      if (Regions.roomIdAt(map, list[p].x, list[p].y) === rid) {
        for (var hid in st.holding) {
          var hrow = ITEMS[hid];
          if (!hrow) continue;
          if (finds(hrow, 'search', power * 0.8)) {
            got[hid] = (got[hid] || 0) + 1;
            take(list[p], hid, 1);
            hitAny++; mine++;
          }
        }
      }
      if (mine) victims.push(list[p]);
    }

    /* The bill. Furniture is damaged, everyone who lives here is
       furious, and the gang that owns the block takes it personally. */
    var wrecked = 0;
    if (room && room.cells) {
      for (var c = 0; c < room.cells.length; c++) {
        var b = map.buildingAt(map.xOf(room.cells[c]), map.yOf(room.cells[c]));
        if (!b || !b.def || !b.def.building) continue;
        if (!b.def.building.isBed && !b.def.building.isTable) continue;
        b.hp = Math.max(1, (b.hp || 100) - U.randInt(6, 18));
        wrecked++;
      }
    }
    for (var v = 0; v < list.length; v++) {
      var lst = list[v].contraband;
      if (!lst) continue;
      var lives = Regions.roomIdAt(map, list[v].x, list[v].y) === rid;
      for (var q = 0; q < lst.stashes.length && !lives; q++) {
        if (Regions.roomIdAt(map, lst.stashes[q].x, lst.stashes[q].y) === rid) lives = true;
      }
      if (!lives) continue;
      lst.lastShakedownTick = now();
      think(list[v], 'cbCellTossed', {});
      lst.grudge = U.clamp01(lst.grudge + 0.22);
      var g = gangById(lst.gangId);
      if (g) g.grievance = U.clamp01((g.grievance || 0) + 0.12);
    }

    var res = confiscateItems(warden, map, x, y, got);
    if (res) {
      state.totals.found += res.count;
      log('found', nameOf(warden) + ' tossed a cell and found ' + res.text);
      letter('Shakedown', nameOf(warden) + ' pulled the block apart and found ' + res.text + '. ' +
        wrecked + ' piece(s) of furniture took damage and everyone who sleeps there knows ' +
        'exactly what happened.', 'neutral', warden);
      for (var w = 0; w < victims.length; w++) noteLoss(victims[w], cbOf(victims[w]));
    } else {
      log('search', nameOf(warden) + ' tossed a cell and found nothing');
      msg(nameOf(warden) + ' searched the block and found nothing.', warden, 'info');
    }
    return res || { count: 0, value: 0, text: 'nothing' };
  };

  /* A dog works the other half of the catalogue: it cannot smell a
     lockpick and it will find leaf through a mattress. */
  Contraband.dogSweep = function (handler, dog, map, x, y) {
    if (!map || !Regions) return null;
    var rid = Regions.roomIdAt(map, x, y);
    var trained = dog && dog.trainedLevels ? (dog.trainedLevels.obedience || 0) : 0;
    var breed = dog && dog.kindId === 'searchDog' ? 1 : 0.45;
    var power = (0.5 + 0.05 * skill(handler, 'animals') + 0.1 * trained) * breed;

    var got = {}, n = 0, victims = [];
    var list = inmates(map);
    for (var p = 0; p < list.length; p++) {
      var st = list[p].contraband;
      if (!st) continue;
      for (var s = st.stashes.length - 1; s >= 0; s--) {
        var stash = st.stashes[s];
        if (Regions.roomIdAt(map, stash.x, stash.y) !== rid) continue;
        for (var id in stash.items) {
          var row = ITEMS[id];
          if (!row) continue;
          if (finds(row, 'scent', power)) {
            got[id] = (got[id] || 0) + 1;
            stash.items[id]--;
            if (stash.items[id] <= 0) delete stash.items[id];
            n++;
            if (victims.indexOf(list[p]) < 0) victims.push(list[p]);
          }
        }
        if (!Object.keys(stash.items).length) st.stashes.splice(s, 1);
      }
    }
    var res = confiscateItems(handler, map, x, y, got);
    if (res) {
      state.totals.found += res.count;
      log('found', (dog ? nameOf(dog) : 'the dog') + ' found ' + res.text);
      msg((dog ? nameOf(dog) : 'The dog') + ' found ' + res.text + '.', handler, 'threat');
      for (var v = 0; v < victims.length; v++) noteLoss(victims[v], cbOf(victims[v]));
    }
    return res;
  };

  /* The detector is passive and cheap to run and catches exactly one
     kind of thing. It is attached to the building rather than swept
     for, so where the player puts it is the whole of its value. */
  function detectorTick(thing, map) {
    if ((now() + thing.id) % 30 !== 0) return;
    var P = sys('Power');
    if (P && P.isPowered && !P.isPowered(thing)) return;
    var here = map.pawnsAt(thing.x, thing.y);
    for (var i = 0; i < here.length; i++) {
      var pawn = here[i];
      if (!isInmate(pawn)) continue;
      var st = cbOf(pawn);
      var got = {};
      for (var id in st.holding) {
        var row = ITEMS[id];
        if (!row || !tierAllowed(row, Contraband.policy)) continue;
        if (finds(row, 'metal', 0.9)) { got[id] = (got[id] || 0) + 1; take(pawn, id, 1); }
      }
      var n = 0;
      for (var g in got) n += got[g];
      if (!n) continue;
      var pol = Contraband.policy;
      if (pol.detectorAlarm === 'ignore') {
        /* The alarm is off, so this is a record, not an intervention. */
        log('alarm', 'the detector chirped at ' + nameOf(pawn) + ' and nobody came');
        for (var back in got) give(pawn, back, got[back]);
        continue;
      }
      var res = confiscateItems(null, map, thing.x, thing.y, got);
      if (res) {
        state.totals.found += res.count;
        log('found', 'the detector caught ' + res.text + ' on ' + nameOf(pawn));
        msg('The metal detector caught ' + res.text + ' on ' + nameOf(pawn) + '.', pawn, 'threat');
        noteLoss(pawn, st);
      }
      if (pol.detectorAlarm === 'lockdown') {
        /* The expensive setting. Everyone in the block stops where they
           are, which is fine at three in the morning and a disaster at
           dinner. */
        var Pr = sys('Prison');
        if (Pr && Pr.lockdown) Pr.lockdown(map, 3000, 'metal detector alarm');
        else {
          var block = inmates(map);
          for (var b = 0; b < block.length; b++) cbOf(block[b]).suspicion = U.clamp01(cbOf(block[b]).suspicion + 0.1);
        }
      }
    }
  }

  function attachDetectors(map) {
    var list = map.byDef('cbMetalDetector') || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].spawned && !list[i].tickFn && map.setTickFn) map.setTickFn(list[i], detectorTick);
    }
  }

  /* ============================================================
     9. DEALERS AND THE INTERNAL MARKET

     Supply becomes influence. A prisoner with more than they can use
     starts selling, and what they are paid in is favours: the promise
     of protection, a turn at the table, somebody else's meal. Favours
     are what a gang is made of, which is how the trade and the
     politics turn out to be the same system.
     ============================================================ */

  function updateDealer(pawn, st) {
    var supply = holdingValue(st) + stashValue(st) * 0.7;
    var was = st.dealer;
    st.dealer = supply >= DEALER_SUPPLY || st.favours >= 6;
    if (st.dealer && !was) {
      log('dealer', nameOf(pawn) + ' is running the block trade now');
      msg(nameOf(pawn) + ' has become the block dealer.', pawn, 'threat');
    }
    if (!st.dealer && was) st.favours = Math.max(0, st.favours - 1);
  }

  function findDealer(map, buyer) {
    var list = inmates(map), best = null, bestScore = -1;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p === buyer || p.dead || p.downed) continue;
      var st = p.contraband;
      if (!st || !st.dealer || !holdingCount(st)) continue;
      if (Regions && !Regions.sameArea(map, buyer.x, buyer.y, p.x, p.y)) continue;
      var score = holdingValue(st) / (1 + U.dist(buyer.x, buyer.y, p.x, p.y) * 0.05);
      /* Your own crew serves you first, and a rival crew charges you
         or refuses. */
      var bg = buyer.contraband && buyer.contraband.gangId;
      if (bg && st.gangId === bg) score *= 1.6;
      else if (bg && st.gangId && st.gangId !== bg) score *= 0.25;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  function doDeal(map, buyer) {
    var bst = cbOf(buyer);
    if (now() - bst.lastDealTick < DEAL_COOLDOWN) return false;
    var dealer = findDealer(map, buyer);
    if (!dealer || dealer === buyer) return false;
    var dst = cbOf(dealer);
    if (now() - dst.lastDealTick < DEAL_COOLDOWN) return false;
    var ids = Object.keys(dst.holding);
    if (!ids.length) return false;

    /* What they want, not what is cheapest. An addict buys the drug. */
    var wantId = null;
    var D = sys('Drugs');
    if (D && D.addictions) {
      var add = D.addictions(buyer) || [];
      if (add.length) {
        for (var i = 0; i < ids.length; i++) if (ITEMS[ids[i]].tier === 'drug') { wantId = ids[i]; break; }
      }
    }
    /* Stock means the things that get used up. A shiv somebody is
       carrying is not for sale; it is the reason nobody asks. */
    if (!wantId) {
      var sellable = [];
      for (var k = 0; k < ids.length; k++) {
        var r = ITEMS[ids[k]];
        if (r && (r.tier === 'drug' || r.tier === 'luxury')) sellable.push(ids[k]);
      }
      wantId = sellable.length ? U.pick(sellable) : U.pick(ids);
    }
    var row = ITEMS[wantId];
    if (!row) return false;

    take(dealer, wantId, 1);
    bst.lastDealTick = now();
    dst.lastDealTick = now();
    dst.sales++;
    dst.favours += row.value;
    state.totals.deals++;

    /* Paid for on credit, because nobody in here has anything. */
    bst.debts[dealer.id] = (bst.debts[dealer.id] || 0) + row.value;

    consume(buyer, row, map);
    think(dealer, 'cbDealerRespect', {});
    var S = sys('Social');
    if (S && S.addMemory) S.addMemory(buyer, dealer, 'helped', 0.6);
    log('deal', nameOf(dealer) + ' sold ' + row.label + ' to ' + nameOf(buyer));
    return true;
  }

  /* What the item actually does when it is used up. This is where the
     underground writes into the rest of the game. */
  function consume(pawn, row, map) {
    var N = sys('Needs'), D = sys('Drugs');
    if (row.tier === 'drug' && D && D.ingest && row.defId && Defs.has('thing', row.defId)) {
      D.ingest(pawn, row.defId, null, { source: 'contraband' });
      return;
    }
    if (row.tier === 'drug' || row.tier === 'luxury') {
      if (N && N.gainJoy) N.gainJoy(pawn, 0.35, 'contraband');
      think(pawn, 'cbScored', {});
      return;
    }
    /* Tools and weapons are not consumed; they go back in the pocket. */
    give(pawn, row.id, 1);
  }

  function collectDebts(map, pawn, st) {
    var ids = Object.keys(st.debts);
    for (var i = 0; i < ids.length; i++) {
      var owed = st.debts[ids[i]];
      if (owed <= 0) { delete st.debts[ids[i]]; continue; }
      var dealer = pawnById(map, Number(ids[i]));
      if (!dealer || dealer.dead) { delete st.debts[ids[i]]; continue; }
      /* Paid off in work, favours and fear, a little at a time. */
      st.debts[ids[i]] = owed - 0.4;
      if (owed < 8) continue;
      if (!U.chance(0.10)) continue;

      /* The debt has gone too far. Somebody comes to collect. */
      var H = sys('Health');
      var enforcer = gangEnforcer(map, dealer, pawn) || (dealer === pawn ? null : dealer);
      if (!enforcer) { delete st.debts[ids[i]]; continue; }
      if (H && H.damage) {
        H.damage(pawn, {
          amount: U.randInt(4, 11), type: 'blunt',
          source: 'beating', instigator: enforcer
        });
      }
      st.debts[ids[i]] = Math.max(0, owed - 6);
      think(pawn, 'cbExtorted', {});
      var S = sys('Social');
      if (S && S.addMemory) S.addMemory(pawn, enforcer, 'insulted', 1.2);
      log('debt', nameOf(enforcer) + ' collected on ' + nameOf(pawn) + ' for ' + nameOf(dealer));
      msg(nameOf(pawn) + ' was beaten over a debt in the block.', pawn, 'threat');
    }
  }

  function pawnById(map, id) {
    for (var i = 0; i < map.pawns.length; i++) if (map.pawns[i].id === id) return map.pawns[i];
    return null;
  }

  Contraband.dealers = function (map) {
    var out = [], list = inmates(map);
    for (var i = 0; i < list.length; i++) {
      var st = list[i].contraband;
      if (st && st.dealer) {
        out.push({
          pawn: list[i], name: nameOf(list[i]), favours: Math.round(st.favours),
          sales: st.sales, supply: holdingValue(st) + stashValue(st),
          gangId: st.gangId, gangName: st.gangName
        });
      }
    }
    out.sort(function (a, b) { return b.favours - a.favours; });
    return out;
  };

  /* ============================================================
     10. INFORMANTS

     A warden buys a prisoner with something the prison can give -
     better food, privileges, a word about their sentence - and gets
     back what only somebody inside can know. Every meeting is a risk
     taken by the informant, not by the warden, and the block
     eventually works out who has been going quiet at the same hour
     every day.
     ============================================================ */

  Contraband.turnChance = function (warden, prisoner) {
    if (!warden || !prisoner || !isInmate(prisoner)) return 0;
    var st = cbOf(prisoner);
    if (st.informant) return 0;
    var pol = Contraband.policy;
    var pay = pol.informantPay === 'parole' ? 0.30 : (pol.informantPay === 'privileges' ? 0.18 : 0.10);
    var chance = 0.06 + 0.022 * skill(warden, 'social') + pay;
    chance *= 1 + (0.5 - moodOf(prisoner));           /* the miserable talk */
    if (st.gangId) chance *= 0.45;                    /* the affiliated do not */
    if (hasTrait(prisoner, 'ironWilled')) chance *= 0.55;
    if (hasTrait(prisoner, 'psychopath')) chance *= 1.3;
    if (st.grudge > 0.5) chance *= 0.6;               /* you tossed their cell */
    chance *= 1 - state.fear * 0.6;                   /* the last snitch died */
    return U.clamp01(chance);
  };

  Contraband.turnInformant = function (warden, prisoner) {
    if (!prisoner || prisoner === warden || !prisoner.map || !isInmate(prisoner)) return false;
    if (warden && isInmate(warden)) return false;
    var st = cbOf(prisoner);
    if (st.informant) return false;
    var cap = Contraband.policy.informantCap;
    if (Contraband.informants(prisoner.map).length >= cap) return false;
    if (!U.chance(Contraband.turnChance(warden, prisoner))) {
      st.suspicion = U.clamp01(st.suspicion + 0.2);
      msg(nameOf(prisoner) + ' would not talk to ' + nameOf(warden) + '.', prisoner, 'info');
      return false;
    }
    st.informant = true;
    st.informantSince = now();
    st.informantById = warden ? warden.id : 0;
    st.exposure = 0.1;
    state.totals.informants++;
    think(prisoner, 'cbInformantPaid', {});
    log('informant', nameOf(prisoner) + ' agreed to talk to ' + nameOf(warden));
    letter('An informant', nameOf(prisoner) + ' has agreed to talk. They will give up stashes, ' +
      'dealers and who runs which crew, and the longer you use them the more the block ' +
      'notices who keeps being called away.', 'good', prisoner);
    return true;
  };

  Contraband.informants = function (map) {
    var out = [], list = inmates(map);
    for (var i = 0; i < list.length; i++) {
      var st = list[i].contraband;
      if (st && st.informant) out.push(list[i]);
    }
    return out;
  };

  /* One meeting: one thing you did not know. */
  Contraband.debrief = function (warden, informant) {
    var map = informant.map, st = cbOf(informant);
    st.lastMeetTick = now();
    st.intelGiven++;
    st.exposure = U.clamp01(st.exposure + 0.10 + 0.04 * (st.gangId ? 1 : 0));
    think(informant, 'cbInformantPaid', {});

    /* Nobody informs on themselves. What an informant has that is worth
       a privilege is always about somebody else in there. */
    var kinds = [];
    var stashes = Contraband.stashes(map).filter(function (s) {
      return !s.known && s.ownerId !== informant.id;
    });
    if (stashes.length) kinds.push('stash');
    var dealers = Contraband.dealers(map).filter(function (d) { return d.pawn !== informant; });
    if (dealers.length) kinds.push('dealer');
    if (state.gangs.length) kinds.push('gang');
    var runner = escapePlanner(map, informant);
    if (runner) kinds.push('plan');
    if (!kinds.length) {
      msg(nameOf(informant) + ' had nothing new for ' + nameOf(warden) + '.', informant, 'info');
      return null;
    }

    var kind = U.pick(kinds), intel = null;
    if (kind === 'stash') {
      var s = U.pick(stashes);
      var owner = stashOwner(map, s.id);
      if (owner) owner.stash.known = true;
      intel = { kind: 'stash', x: s.x, y: s.y,
        text: 'a stash ' + (s.kind === 'yard' ? 'out in the yard' : 'in the block') +
              ', ' + nameOf(owner ? owner.pawn : null) + '\'s' };
    } else if (kind === 'dealer') {
      var d = U.pick(dealers);
      cbOf(d.pawn).suspicion = U.clamp01(cbOf(d.pawn).suspicion + 0.3);
      intel = { kind: 'dealer', pawnId: d.pawn.id, x: d.pawn.x, y: d.pawn.y,
        text: d.name + ' is the one selling, and ' + d.sales + ' people owe them' };
    } else if (kind === 'gang') {
      var g = U.pick(state.gangs);
      g.known = true;
      intel = { kind: 'gang', gangId: g.id,
        text: 'the ' + g.name + ' are ' + g.memberIds.length + ' strong and hold ' +
              (g.rooms.length || 'no') + ' part(s) of the block' };
    } else {
      intel = { kind: 'plan', pawnId: runner.id, x: runner.x, y: runner.y,
        text: nameOf(runner) + ' has the tools to get through a wall and is waiting for a night' };
    }

    log('intel', nameOf(informant) + ': ' + intel.text);
    letter('Word from inside', nameOf(informant) + ' told ' + nameOf(warden) + ' that ' +
      intel.text + '.', 'neutral', informant);
    return intel;
  };

  function escapePlanner(map, notThis) {
    var list = inmates(map);
    for (var i = 0; i < list.length; i++) {
      if (list[i] === notThis) continue;
      var st = list[i].contraband;
      if (!st) continue;
      for (var id in st.holding) {
        var row = ITEMS[id];
        if (row && row.enables && row.enables.indexOf('escape') === 0) return list[i];
      }
    }
    return null;
  }

  /* Exposure catches up. When it does, somebody with a shiv settles
     it, and the whole block learns the lesson the player was relying
     on them not learning. */
  function checkExposure(map, pawn, st) {
    if (!st.informant) return;
    /* Slow: about five points a day for an unaffiliated prisoner. An
       informant left alone stays alive; one debriefed every morning does
       not, which is the decision the player is being handed. */
    st.exposure = U.clamp01(st.exposure + 0.0002 * (st.gangId ? 2 : 1));
    if (st.exposure < EXPOSURE_FATAL) return;

    var killer = null, list = inmates(map);
    for (var i = 0; i < list.length; i++) {
      var other = list[i];
      if (other === pawn || other.dead || other.downed) continue;
      var ost = other.contraband;
      if (!ost) continue;
      if (Regions && !Regions.sameArea(map, pawn.x, pawn.y, other.x, other.y)) continue;
      if (Contraband.enables(other, 'violence') || ost.gangRank > 0) { killer = other; break; }
      if (!killer) killer = other;
    }
    if (!killer) { st.exposure = 0.8; return; }

    var H = sys('Health');
    var weapon = Contraband.enables(killer, 'violence');
    var damage = weapon ? U.randInt(22, 40) : U.randInt(9, 16);
    if (H && H.damage) {
      H.damage(pawn, {
        amount: damage, type: weapon ? 'stab' : 'blunt',
        partName: weapon ? 'neck' : null, source: 'murder', instigator: killer
      });
    }
    st.informant = false;
    st.exposure = 0;
    state.totals.informantsKilled++;
    state.fear = U.clamp01(state.fear + 0.4);

    for (var b = 0; b < list.length; b++) {
      if (list[b] === pawn) continue;
      think(list[b], 'cbSnitchKilled', {});
      cbOf(list[b]).suspicion = U.clamp01(cbOf(list[b]).suspicion + 0.3);
    }
    log('murder', nameOf(killer) + ' settled with ' + nameOf(pawn) + ' for talking');
    letter('They found the snitch',
      nameOf(pawn) + ' was attacked in the block by ' + nameOf(killer) + '. Everyone in there ' +
      'knows why, which means the next prisoner you ask will say no.', 'threat', pawn);
  }

  /* ============================================================
     11. GANGS

     Prisoners affiliate by where they came from, by what they believe,
     and by who they already like. Three of a kind and a leader with
     favours makes a crew; a crew claims rooms, recruits, taxes anyone
     standing alone, and decides that the crew across the corridor is
     the reason everything is bad.
     ============================================================ */

  var GANG_WORDS_A = ['Ashfall', 'Iron', 'Black', 'Red', 'Long', 'Nine', 'Salt', 'Cold', 'Low', 'Brass'];
  var GANG_WORDS_B = ['Crew', 'Hands', 'Row', 'Gate', 'Block', 'Yard', 'Line', 'Kings', 'Wire', 'Dogs'];

  function affinityOf(pawn) {
    var st = pawn.prisoner;
    if (st && st.factionId) return 'f:' + st.factionId;
    var I = sys('Ideology');
    if (I && I.of) {
      var ideo = I.of(pawn);
      if (ideo && ideo.id) return 'i:' + ideo.id;
    }
    if (pawn.faction && pawn.faction !== 'player') return 'f:' + pawn.faction;
    return 'x:' + (pawn.kindId || 'inmate');
  }

  function gangById(id) {
    for (var i = 0; i < state.gangs.length; i++) if (state.gangs[i].id === id) return state.gangs[i];
    return null;
  }
  Contraband.gang = gangById;

  /* A prisoner who walks out of the block - recruited into the colony,
     released, freed from slavery - takes their name off the trade. What
     they had buried stays buried, and the crew argues over it. */
  function retireLeavers(map) {
    var pawns = map.pawns, left = [];
    for (var i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      if (!p.contraband || p.dead || isInmate(p)) continue;
      left.push(p);
    }
    if (!left.length) return;
    var staying = inmates(map);
    for (var k = 0; k < left.length; k++) {
      var pawn = left[k], st = pawn.contraband;
      var stashes = st.stashes || [];
      var heir = null;
      for (var h = 0; h < staying.length; h++) {
        var hst = cbOf(staying[h]);
        if (st.gangId && hst.gangId === st.gangId) { heir = staying[h]; break; }
        if (!heir) heir = staying[h];
      }
      if (heir && stashes.length) {
        var hs = cbOf(heir);
        for (var s = 0; s < stashes.length; s++) hs.stashes.push(stashes[s]);
        log('inherit', nameOf(heir) + ' took over what ' + nameOf(pawn) + ' left buried');
      }
      if (st.dealer || st.gangId) {
        log('left', nameOf(pawn) + ' is out of the block, and the trade in it has changed hands');
      }
      pawn.contraband = null;
    }
  }

  function rebuildGangs(map) {
    retireLeavers(map);
    var list = inmates(map);
    var buckets = {};
    for (var i = 0; i < list.length; i++) {
      var pawn = list[i], st = cbOf(pawn);
      st.affinity = affinityOf(pawn);
      (buckets[st.affinity] || (buckets[st.affinity] = [])).push(pawn);
    }

    var keep = [];
    Object.keys(buckets).forEach(function (key) {
      var members = buckets[key];
      /* Shared history counts as much as shared origin: two prisoners
         who like each other pull a third in, which is how a crew forms
         out of people from three different factions. */
      if (members.length < GANG_MIN) return;
      var leader = null, bestFavours = -1;
      for (var m = 0; m < members.length; m++) {
        var mst = cbOf(members[m]);
        var pull = mst.favours + holdingValue(mst) + skill(members[m], 'social') * 0.4;
        if (pull > bestFavours) { bestFavours = pull; leader = members[m]; }
      }
      if (bestFavours < 1) return;

      var existing = null;
      for (var g = 0; g < state.gangs.length; g++) if (state.gangs[g].key === key) existing = state.gangs[g];
      if (!existing) {
        existing = {
          id: ++state.gangSeq, key: key,
          name: U.pick(GANG_WORDS_A) + ' ' + U.pick(GANG_WORDS_B),
          leaderId: 0, memberIds: [], rooms: [], strength: 0,
          heat: {}, grievance: 0, known: false, formedTick: now()
        };
        log('gang', 'the ' + existing.name + ' have formed in the block');
        letter('A crew has formed',
          'The ' + existing.name + ' now run as a group inside your prison - ' + members.length +
          ' of them, led by ' + nameOf(leader) + '. They will recruit, they will tax whoever ' +
          'stands alone, and they will make any trouble in there considerably worse.',
          'threat', leader);
      }
      existing.leaderId = leader.id;
      existing.memberIds = [];
      var strength = 0;
      for (var k = 0; k < members.length; k++) {
        var kst = cbOf(members[k]);
        kst.gangId = existing.id;
        kst.gangName = existing.name;
        kst.gangRank = members[k] === leader ? 2 : (kst.favours > 3 ? 1 : 0);
        if (!kst.joinedTick) kst.joinedTick = now();
        existing.memberIds.push(members[k].id);
        strength += 1 + kst.favours * 0.25 + (Contraband.enables(members[k], 'violence') ? 1.5 : 0);
      }
      existing.strength = strength;
      keep.push(existing);
    });

    /* Anyone whose crew dissolved is on their own again, and knows it. */
    for (var p = 0; p < list.length; p++) {
      var pst = cbOf(list[p]);
      if (!pst.gangId) continue;
      var still = false;
      for (var q = 0; q < keep.length; q++) if (keep[q].id === pst.gangId) still = true;
      if (!still) { pst.gangId = 0; pst.gangName = ''; pst.gangRank = 0; }
    }
    state.gangs = keep;
    state.gangsTick = now();
    rebuildTerritory(map);
  }

  function rebuildTerritory(map) {
    var terr = {};
    if (!Regions) { state.territory = terr; return; }
    var counts = {};
    var list = inmates(map);
    for (var i = 0; i < list.length; i++) {
      var st = list[i].contraband;
      if (!st || !st.gangId) continue;
      var rid = Regions.roomIdAt(map, list[i].x, list[i].y);
      if (!rid) continue;
      var row = counts[rid] || (counts[rid] = {});
      row[st.gangId] = (row[st.gangId] || 0) + 1;
      for (var s = 0; s < st.stashes.length; s++) {
        var srid = Regions.roomIdAt(map, st.stashes[s].x, st.stashes[s].y);
        if (!srid) continue;
        var srow = counts[srid] || (counts[srid] = {});
        srow[st.gangId] = (srow[st.gangId] || 0) + 0.5;
      }
    }
    for (var g = 0; g < state.gangs.length; g++) state.gangs[g].rooms = [];
    Object.keys(counts).forEach(function (rid) {
      var row = counts[rid], bestId = 0, best = 0, total = 0;
      Object.keys(row).forEach(function (gid) {
        total += row[gid];
        if (row[gid] > best) { best = row[gid]; bestId = Number(gid); }
      });
      if (!bestId) return;
      terr[rid] = { gangId: bestId, share: total ? best / total : 1, contested: Object.keys(row).length > 1 };
      var gang = gangById(bestId);
      if (gang) gang.rooms.push(Number(rid));
      /* Two crews standing in the same room is how a war starts. */
      if (Object.keys(row).length > 1) {
        Object.keys(row).forEach(function (a) {
          Object.keys(row).forEach(function (b) {
            if (a === b) return;
            var ga = gangById(Number(a));
            if (!ga) return;
            ga.heat[b] = (ga.heat[b] || 0) + 0.15;
          });
        });
      }
    });
    state.territory = terr;
  }

  Contraband.gangs = function (map) {
    if (map && (state.gangsTick < 0 || now() - state.gangsTick > BEAT * GANG_BEATS)) rebuildGangs(map);
    return state.gangs.slice();
  };

  Contraband.gangOf = function (pawn) {
    var st = pawn && pawn.contraband;
    if (!st || !st.gangId) return null;
    return gangById(st.gangId);
  };

  Contraband.territory = function (map) {
    if (map && !Object.keys(state.territory).length) rebuildTerritory(map);
    return state.territory;
  };

  /* How hard a crew is leaning on one room. Other systems read this:
     a room under pressure is a room where a warden is not safe and a
     riot starts with a head start. */
  Contraband.pressure = function (map, roomId) {
    var t = Contraband.territory(map)[roomId];
    if (!t) return 0;
    var gang = gangById(t.gangId);
    if (!gang) return 0;
    var base = U.clamp01(gang.strength / 12) * t.share;
    if (t.contested) base = Math.min(1, base + 0.25);
    return U.clamp01(base + gang.grievance * 0.3);
  };

  function gangEnforcer(map, forWhom, notThis) {
    var st = forWhom && forWhom.contraband;
    if (!st || !st.gangId) return null;
    var gang = gangById(st.gangId);
    if (!gang) return null;
    var best = null, bestScore = -1;
    for (var i = 0; i < gang.memberIds.length; i++) {
      var pawn = pawnById(map, gang.memberIds[i]);
      if (!pawn || pawn.dead || pawn.downed || pawn === forWhom || pawn === notThis) continue;
      var score = skill(pawn, 'melee') + (Contraband.enables(pawn, 'violence') ? 6 : 0);
      if (score > bestScore) { bestScore = score; best = pawn; }
    }
    return best;
  }

  function gangBeat(map) {
    var pol = Contraband.policy;
    for (var i = 0; i < state.gangs.length; i++) {
      var gang = state.gangs[i];
      if (pol.gangs === 'crush') gang.grievance = U.clamp01(gang.grievance + 0.03);
      if (pol.gangs === 'split') gang.strength *= 0.97;

      /* Tax whoever is standing alone in a room the crew holds. About
         twice a day per crew, and never the same person twice running. */
      if (U.chance(0.012)) extort(map, gang);

      /* Rivalry. Heat comes from shared rooms and from stolen trade;
         when it tips, two people come out of it hurt. */
      var keys = Object.keys(gang.heat);
      for (var k = 0; k < keys.length; k++) {
        gang.heat[keys[k]] *= 0.999;
        if (gang.heat[keys[k]] < GANG_HEAT_FIGHT) continue;
        gang.heat[keys[k]] = 0.2;
        gangFight(map, gang, gangById(Number(keys[k])));
      }
    }
  }

  function extort(map, gang) {
    var victims = [], list = inmates(map);
    for (var i = 0; i < list.length; i++) {
      var st = list[i].contraband;
      if (!st || st.gangId === gang.id) continue;
      var rid = Regions ? Regions.roomIdAt(map, list[i].x, list[i].y) : 0;
      if (gang.rooms.indexOf(rid) < 0) continue;
      victims.push(list[i]);
    }
    if (!victims.length) return;
    var victim = U.pick(victims), vst = cbOf(victim);
    if (now() - (vst.lastTaxedTick || -99999) < DAY * 0.4) return;
    vst.lastTaxedTick = now();
    var taken = null;
    var ids = Object.keys(vst.holding);
    if (ids.length) {
      taken = U.pick(ids);
      take(victim, taken, 1);
      var leader = pawnById(map, gang.leaderId);
      if (leader) give(leader, taken, 1);
    }
    vst.favours = Math.max(0, vst.favours - 1);
    think(victim, 'cbExtorted', {});
    state.totals.extortions++;

    /* The obvious answer to being taxed is to join. That is how a
       crew grows without anybody deciding anything. */
    if (!vst.gangId && U.chance(0.22)) {
      vst.gangId = gang.id; vst.gangName = gang.name; vst.gangRank = 0; vst.joinedTick = now();
      gang.memberIds.push(victim.id);
      think(victim, 'cbGangProtected', {});
      log('gang', nameOf(victim) + ' joined the ' + gang.name);
    } else {
      log('extort', 'the ' + gang.name + ' taxed ' + nameOf(victim) +
        (taken ? ' for ' + ITEMS[taken].label : ''));
    }
  }

  function gangFight(map, a, b) {
    if (!a || !b) return;
    var pa = pawnById(map, a.leaderId), pb = pawnById(map, b.leaderId);
    if (!pa || !pb || pa.dead || pb.dead) return;
    state.totals.gangFights++;
    var H = sys('Health');

    var pairs = Math.min(3, Math.min(a.memberIds.length, b.memberIds.length));
    var casualties = 0;
    for (var i = 0; i < pairs; i++) {
      var x = pawnById(map, a.memberIds[i]), y = pawnById(map, b.memberIds[i]);
      if (!x || !y || x.dead || y.dead) continue;
      var xw = Contraband.enables(x, 'violence'), yw = Contraband.enables(y, 'violence');
      if (H && H.damage) {
        var rx = H.damage(y, { amount: xw ? U.randInt(14, 30) : U.randInt(5, 12), type: xw ? 'stab' : 'blunt', source: 'gang fight', instigator: x });
        var ry = H.damage(x, { amount: yw ? U.randInt(14, 30) : U.randInt(5, 12), type: yw ? 'stab' : 'blunt', source: 'gang fight', instigator: y });
        if (rx && (rx.dead || rx.downed)) casualties++;
        if (ry && (ry.dead || ry.downed)) casualties++;
      }
      var S = sys('Social');
      if (S && S.addMemory) { S.addMemory(x, y, 'insulted', 1.5); S.addMemory(y, x, 'insulted', 1.5); }
    }
    var list = inmates(map);
    for (var p = 0; p < list.length; p++) think(list[p], 'cbBlockWar', {});
    log('war', 'the ' + a.name + ' and the ' + b.name + ' fought in the block');
    letter('Fighting in the block',
      'The ' + a.name + ' and the ' + b.name + ' went at each other. ' + casualties +
      ' down. Both crews have knives you did not find, and the block will not settle ' +
      'while they are both still in it.', 'threat', pa);

    var Pr = sys('Prison');
    if (Pr && Pr.noteViolence) Pr.noteViolence(map, { cause: 'gang fight', casualties: casualties });
  }

  /* ============================================================
     12. WHAT IT ENABLES

     Contraband that is never used is just an inventory. This is where
     a file in a pocket becomes a hole in your wall and a burner radio
     becomes a raid.
     ============================================================ */

  /* Which piece of the shell a given tool works on. A file goes at the
     lock, a spike goes at the wall, and a lockpick is quiet enough to
     work in daylight but only ever opens a door. */
  var TOOL_TARGET = { escapeDoor: 'door', escapeLock: 'door', escapeTunnel: 'wall' };

  function shellPiece(map, pawn, want) {
    if (!Regions) return null;
    var rid = Regions.roomIdAt(map, pawn.x, pawn.y);
    if (!rid) return null;
    var best = null, bestD = Infinity;
    var ring = U.cellsInRadius(pawn.x, pawn.y, 6);
    for (var i = 0; i < ring.length; i++) {
      var x = ring[i][0], y = ring[i][1];
      if (!map.inBounds(x, y)) continue;
      var b = map.buildingAt(x, y);
      if (!b || !b.def || !b.def.building) continue;
      var isDoor = !!b.def.building.isDoor;
      if (want === 'door' ? !isDoor : isDoor) continue;
      if (!isDoor && b.def.category !== 'building') continue;
      if (!isDoor && !b.def.holdsRoof && b.defId !== 'wall' && !b.def.natural) continue;
      /* It has to be part of this room's shell, not a partition inside it:
         something on the far side of it must be somewhere else. */
      var opensOut = false;
      for (var d = 0; d < U.ADJ4.length; d++) {
        var nx = x + U.ADJ4[d][0], ny = y + U.ADJ4[d][1];
        if (!map.inBounds(nx, ny)) continue;
        var nr = Regions.roomIdAt(map, nx, ny);
        if (nr !== rid && map.passable(nx, ny)) { opensOut = true; break; }
      }
      if (!opensOut) continue;
      var dist = U.distSq(pawn.x, pawn.y, x, y);
      if (dist < bestD) { bestD = dist; best = b; }
    }
    return best;
  }

  function watchedRoom(map, pawn) {
    if (!Regions) return false;
    var rid = Regions.roomIdAt(map, pawn.x, pawn.y);
    var staff = freeColonists(map);
    for (var i = 0; i < staff.length; i++) {
      if (Regions.roomIdAt(map, staff[i].x, staff[i].y) === rid) return true;
    }
    return false;
  }

  function escalate(map, pawn, st) {
    /* A tool plus unwatched time equals a hole. This file never decides
       that somebody escapes - it takes the wall down, and prisoners.js
       finds the opening on its own beat, which keeps one system in
       charge of one thing and makes the hole something the player can
       walk past and notice. */
    var tool = Contraband.enables(pawn, 'escapeTunnel') || Contraband.enables(pawn, 'escapeDoor') ||
               Contraband.enables(pawn, 'escapeLock');
    if (tool && pawn.prisoner && !pawn.downed && !watchedRoom(map, pawn)) {
      var piece = shellPiece(map, pawn, TOOL_TARGET[ITEMS[tool].enables] || 'wall');
      if (piece) {
        var bite = U.randInt(6, 14) * (ITEMS[tool].enables === 'escapeTunnel' ? 1.6 : 1);
        piece.hp = (piece.hp || (piece.def.hp || 100)) - bite;
        pawn.prisoner.escapeWill = U.clamp01((pawn.prisoner.escapeWill || 0) + 0.06);
        /* Tools wear out on stone, which is why one spike is not a
           guaranteed escape and three of them are. */
        if (U.chance(0.04)) {
          take(pawn, tool, 1);
          log('tool', nameOf(pawn) + ' wore out a ' + ITEMS[tool].label);
        }
        if (piece.hp <= 0) {
          var px = piece.x, py = piece.y;
          map.destroyThing(piece, 'broken out');
          if (map.markPathDirty) map.markPathDirty(px, py);
          if (Regions.markDirty) Regions.markDirty(map, px, py);
          take(pawn, tool, 1);
          state.totals.breaches++;
          log('breach', nameOf(pawn) + ' broke through with a ' + ITEMS[tool].label);
          letter('A hole in the block',
            nameOf(pawn) + ' has worked a ' + ITEMS[tool].label + ' through the shell of your ' +
            'prison and there is now a gap in it at ' + px + ',' + py + '. Whatever else is in ' +
            'there can walk out of it too.', 'threat', pawn);
        }
      }
    }

    /* A radio is a map of your walls in somebody else's hands. */
    var radio = Contraband.enables(pawn, 'callOut');
    if (radio && U.chance(0.012)) {
      take(pawn, radio, 1);
      var S = sys('Storyteller'), I = sys('Incidents'), G = sys('Game');
      var points = (S && S.threatPoints) ? S.threatPoints(G) * 0.8 : 120;
      letter('Somebody called out',
        nameOf(pawn) + ' got a message out of the block. Whoever is on the other end now ' +
        'knows where your walls are thin.', 'threat', pawn);
      log('radio', nameOf(pawn) + ' used a burner radio');
      if (I && I.raid && G) I.raid(G, points, { reason: 'a prisoner called them' });
    }

    /* A weapon in a pocket becomes a weapon in a hand the moment
       somebody is angry enough. */
    var weapon = Contraband.enables(pawn, 'violence') || Contraband.enables(pawn, 'gun');
    if (weapon && st.grudge > 0.7 && U.chance(0.03)) {
      var row = ITEMS[weapon];
      if (row.defId && Defs.has('thing', row.defId) && !pawn.equipment) {
        var thing = map.spawnThing(row.defId, pawn.x, pawn.y, { faction: null });
        if (thing && typeof pawn.equip === 'function') {
          map.despawnThing(thing);
          pawn.equip(thing);
          take(pawn, weapon, 1);
          log('armed', nameOf(pawn) + ' pulled a ' + row.label);
          letter('Armed prisoner',
            nameOf(pawn) + ' has produced a ' + row.label + ' inside the block. Whatever they ' +
            'have been holding, they are holding it openly now.', 'threat', pawn);
          var Th = sys('Think');
          if (Th && Th.startMentalState) Th.startMentalState(pawn, 'berserk');
        }
      }
    }
  }

  /* ============================================================
     13. THE BEAT

     One pass over the underground every BEAT ticks. It is pumped from
     several places - the systems registry when the integrator wires
     it, the work givers when a colonist looks for something to do, the
     metal detector's own tick - and it is idempotent inside a beat, so
     none of them can run it twice.
     ============================================================ */

  function beat(map) {
    var list = inmates(map);
    state.beats++;
    attachDetectors(map);

    if (state.beats % ROUTE_BEATS === 0 || !state.routes) refreshRoutes(map);
    if (list.length && (state.beats % GANG_BEATS === 0 || state.gangsTick < 0)) rebuildGangs(map);

    runRoutes(map, list);

    for (var i = 0; i < list.length; i++) {
      var pawn = list[i], st = cbOf(pawn);
      if (pawn.dead) continue;

      /* Heat on every stash, and the decision to move the hot ones. */
      for (var s = st.stashes.length - 1; s >= 0; s--) {
        var stash = st.stashes[s];
        if (!Object.keys(stash.items).length) { st.stashes.splice(s, 1); continue; }
        var near = 0, colonists = freeColonists(map);
        for (var c = 0; c < colonists.length; c++) {
          if (U.cheb(colonists[c].x, colonists[c].y, stash.x, stash.y) <= 4) { near++; break; }
        }
        stash.heat = U.clamp01(stash.heat + (near ? HEAT_PER_BEAT * 3 : -HEAT_PER_BEAT * 0.5) +
          (stash.known ? HEAT_PER_BEAT * 2 : 0));
        if (stash.heat > HEAT_MOVE_AT && !pawn.downed &&
            now() - (stash.movedTick || 0) > MOVE_COOLDOWN && U.chance(0.3)) {
          moveStash(pawn, st, map, stash);
        }
      }

      if (pawn.downed) continue;

      /* Anything over what they can keep on them goes in the ground. */
      if (holdingCount(st) > CARRY_CAP) stashSomething(pawn, st, map);

      updateDealer(pawn, st);
      if (!st.dealer && U.chance(0.18 * wantsSomething(pawn, st))) doDeal(map, pawn);
      if (Object.keys(st.debts).length) collectDebts(map, pawn, st);
      checkExposure(map, pawn, st);
      escalate(map, pawn, st);

      st.grudge = Math.max(0, st.grudge - 0.004);
      st.suspicion = Math.max(0, st.suspicion - 0.006);
      if (st.favours > 0) st.favours -= 0.02;
    }

    if (list.length) gangBeat(map);
    state.fear = Math.max(0, state.fear - 0.004);
  }

  /* The heartbeat. Every public entry point calls it; whichever gets
     there first in a given beat does the work. */
  function pump(map) {
    if (!map) return;
    var t = now();
    if (state.mapId !== (map.__cbId || 0)) {
      map.__cbId = map.__cbId || U.nextId();
      state.mapId = map.__cbId;
      state.routes = null; state.routesTick = -1; state.gangsTick = -1;
    }
    if (state.lastBeat < 0) { state.lastBeat = t; return; }
    var due = Math.floor((t - state.lastBeat) / BEAT);
    if (due <= 0) return;
    if (due > MAX_CATCHUP) due = MAX_CATCHUP;
    state.lastBeat = t;
    for (var i = 0; i < due; i++) {
      try { beat(map); }
      catch (e) {
        var G = sys('Game');
        if (G && G.debug && typeof console !== 'undefined') console.log('[contraband] beat threw: ' + (e && e.stack || e));
      }
    }
  }
  Contraband.pump = pump;

  /* The three shapes game.js's systems registry calls, so wiring this
     file in is one name in one list whichever list it goes in. */
  Contraband.tick = function (map) { pump(map); };
  Contraband.tickPawn = function (pawn) { if (pawn && pawn.map) pump(pawn.map); };
  Contraband.tickSlow = function (game) { pump(game && game.map); };

  /* ============================================================
     14. JOBS
     ============================================================ */

  function atTarget(which) {
    return Toils.goto(which, { pe: PE.TOUCH, failIfGone: true });
  }

  Jobs.register('cbFrisk', {
    label: 'search prisoner',
    reportString: 'Searching {A}.',
    toils: function () {
      return [
        atTarget('A'),
        Toils.work({
          amount: function () { return FRISK_WORK; },
          skill: 'social',
          onDone: function (pawn, job) {
            var target = T.resolve(job.targetA, pawn.map);
            if (target) Contraband.frisk(pawn, target);
          }
        })
      ];
    }
  });

  Jobs.register('cbShakedown', {
    label: 'shake down a cell',
    reportString: 'Searching the block.',
    toils: function () {
      return [
        Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false }),
        Toils.work({
          amount: function () { return SHAKEDOWN_WORK; },
          skill: 'social',
          onDone: function (pawn, job) {
            var pos = T.pos(job.targetA, pawn.map) || { x: pawn.x, y: pawn.y };
            Contraband.shakedown(pawn, pawn.map, pos.x, pos.y);
          }
        })
      ];
    }
  });

  Jobs.register('cbDogSweep', {
    label: 'sweep the block with a dog',
    reportString: 'Sweeping the block.',
    toils: function () {
      return [
        Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false }),
        Toils.work({
          amount: function () { return DOG_SWEEP_WORK; },
          skill: 'animals',
          onDone: function (pawn, job) {
            var pos = T.pos(job.targetA, pawn.map) || { x: pawn.x, y: pawn.y };
            var dog = job.targetB ? T.resolve(job.targetB, pawn.map) : null;
            Contraband.dogSweep(pawn, dog, pawn.map, pos.x, pos.y);
          }
        })
      ];
    }
  });

  Jobs.register('cbTurnInformant', {
    label: 'turn a prisoner',
    reportString: 'Talking quietly to {A}.',
    toils: function () {
      return [
        atTarget('A'),
        Toils.work({
          amount: function () { return TURN_WORK; },
          skill: 'social',
          onDone: function (pawn, job) {
            var target = T.resolve(job.targetA, pawn.map);
            if (target) Contraband.turnInformant(pawn, target);
          }
        })
      ];
    }
  });

  Jobs.register('cbMeetInformant', {
    label: 'meet an informant',
    reportString: 'Listening to {A}.',
    toils: function () {
      return [
        atTarget('A'),
        Toils.work({
          amount: function () { return INFORMANT_WORK; },
          skill: 'social',
          onDone: function (pawn, job) {
            var target = T.resolve(job.targetA, pawn.map);
            if (target && target.contraband && target.contraband.informant) Contraband.debrief(pawn, target);
          }
        })
      ];
    }
  });

  /* Raising a dog: a handler, a kennel and a quarter of a stack of
     kibble the colony could have eaten. */
  Jobs.register('cbRaiseDog', {
    label: 'raise a search dog',
    reportString: 'Raising a dog at the kennel.',
    toils: function () {
      return [
        atTarget('A'),
        Toils.work({
          amount: function () { return RAISE_DOG_WORK; },
          skill: 'animals',
          onDone: function (pawn, job) {
            var kennel = T.resolve(job.targetA, pawn.map);
            if (!kennel) return 'fail';
            if (!consumeNearby(pawn.map, kennel.x, kennel.y, 6, ['kibble', 'meatRaw'], RAISE_DOG_KIBBLE)) return 'fail';
            var dog = spawnSearchDog(pawn.map, kennel.x, kennel.y, pawn);
            if (dog) {
              letter('A dog for the block',
                nameOf(pawn) + ' has raised ' + nameOf(dog) + ', a search dog. Walk it through ' +
                'the cells and it will find what no detector ever will.', 'good', dog);
            }
          }
        })
      ];
    }
  });

  function consumeNearby(map, x, y, radius, defIds, count) {
    var need = count, cells = U.cellsInRadius(x, y, radius);
    var found = [];
    for (var c = 0; c < cells.length && need > 0; c++) {
      if (!map.inBounds(cells[c][0], cells[c][1])) continue;
      var items = map.items(cells[c][0], cells[c][1]);
      for (var i = 0; i < items.length; i++) {
        if (defIds.indexOf(items[i].defId) < 0) continue;
        found.push(items[i]);
        need -= items[i].stack || 1;
        if (need <= 0) break;
      }
    }
    if (need > 0) return false;
    need = count;
    for (var f = 0; f < found.length && need > 0; f++) {
      var take2 = Math.min(need, found[f].stack || 1);
      found[f].stack -= take2;
      need -= take2;
      if (found[f].stack <= 0) map.despawnThing(found[f]);
    }
    return true;
  }

  function spawnSearchDog(map, x, y, handler) {
    var MG = sys('MapGen');
    if (!MG || !MG.makePawn || !map.addPawn) return null;
    var spot = null;
    for (var d = 0; d < U.ADJ8.length && !spot; d++) {
      var cx = x + U.ADJ8[d][0], cy = y + U.ADJ8[d][1];
      if (map.inBounds(cx, cy) && map.passable(cx, cy)) spot = { x: cx, y: cy };
    }
    if (!spot) spot = { x: x, y: y };
    var dog = MG.makePawn('searchDog', 'player', { x: spot.x, y: spot.y, map: map });
    if (!dog) return null;
    map.addPawn(dog, spot.x, spot.y);
    dog.fx = dog.x; dog.fy = dog.y;
    dog.tame = true;
    dog.faction = 'player';
    dog.trainedLevels = { obedience: 2, release: 0 };
    dog.master = handler ? handler.id : null;
    dog.name = { first: '', nick: U.pick(['Scrap', 'Nettle', 'Bolt', 'Cinder', 'Wick', 'Shale', 'Rook', 'Tally']), last: '' };
    log('dog', nameOf(handler) + ' raised ' + nameOf(dog));
    return dog;
  }

  /* ============================================================
     15. WORK GIVERS

     prisoners.js is already the exception to "workgivers.js owns every
     register call"; this file is the same exception for the same
     reason, and it keeps its ids in its own namespace.
     ============================================================ */

  var _registered = false;

  /* Whoever is being handed this job has to be staff. prisoners.js can
     turn a prisoner into a colonist mid-game, and a freshly recruited one
     with warden work enabled would otherwise be sent to search himself. */
  function staffOnly(pawn) {
    return !!pawn && !!pawn.map && !isInmate(pawn);
  }

  function claim(pawn, defId, target, targetB) {
    if (!Res.reserve(pawn, target, 1)) return null;
    var job = Jobs.make(defId, target, targetB || null);
    if (!job) Res.release(pawn, target);
    return job;
  }

  function reachable(map, pawn, x, y) {
    if (!Path) return true;
    return Path.reachable(map, pawn.x, pawn.y, x, y, { pawn: pawn });
  }

  function anyBlockCell(map, rooms, pawn) {
    var ids = Object.keys(rooms);
    for (var i = 0; i < ids.length; i++) {
      var room = Regions.rooms(map).get(Number(ids[i]));
      if (!room || !room.cells || !room.cells.length) continue;
      for (var c = 0; c < room.cells.length; c += 2) {
        var x = map.xOf(room.cells[c]), y = map.yOf(room.cells[c]);
        if (map.passable(x, y) && reachable(map, pawn, x, y)) return { x: x, y: y, roomId: Number(ids[i]) };
      }
    }
    return null;
  }

  Contraband.registerWork = function () {
    if (_registered || !WorkGivers || !WorkGivers.register) return false;
    _registered = true;

    /* The heartbeat lives on the cheapest giver, so the underground
       runs whether or not anybody has warden work enabled. */
    WorkGivers.register({
      id: 'cbShakedownBlock', workType: 'warden', order: 60, label: 'shake down the block',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        pump(map);
        if (!staffOnly(pawn)) return null;
        var pol = Contraband.policy;
        if (pol.shakedown === 'never') return null;
        var rooms = blockRooms(map);
        if (!Object.keys(rooms).length || !Regions) return null;

        /* Intel mode only goes in when somebody told you where to go,
           which is what makes an informant worth the risk they run. */
        var target = null;
        if (pol.shakedown === 'intel') {
          var known = Contraband.stashes(map).filter(function (s) { return s.known; });
          if (!known.length) return null;
          target = { x: known[0].x, y: known[0].y };
        } else {
          var every = pol.shakedown === 'constant' ? SHAKEDOWN_COOLDOWN : DAY * Math.max(0.25, pol.shakedownEveryDays);
          if (now() - state.lastShakedown < every) return null;
          target = anyBlockCell(map, rooms, pawn);
        }
        if (!target || !reachable(map, pawn, target.x, target.y)) return null;
        state.lastShakedown = now();
        return claim(pawn, 'cbShakedown', T.cell(target.x, target.y));
      }
    });

    WorkGivers.register({
      id: 'cbFriskPrisoner', workType: 'warden', order: 55, label: 'search prisoners',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        pump(map);
        if (!staffOnly(pawn)) return null;
        var pol = Contraband.policy;
        if (pol.frisk === 'never') return null;
        var list = inmates(map), best = null, bestScore = 0;
        for (var i = 0; i < list.length; i++) {
          var p = list[i], st = p.contraband;
          if (p === pawn || p.downed || p.carriedBy) continue;
          if (!isInmate(p)) continue;
          if (st && now() - st.lastFriskTick < FRISK_COOLDOWN) continue;
          if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
          if (!reachable(map, pawn, p.x, p.y)) continue;
          var score = 0.2;
          if (pol.frisk === 'always') score = 1;
          else if (pol.frisk === 'suspicion') score = st ? st.suspicion : 0;
          else score = U.rand() * 0.5;
          if (score > bestScore) { bestScore = score; best = p; }
        }
        if (!best || bestScore < 0.2) return null;
        return claim(pawn, 'cbFrisk', T.pawn(best));
      }
    });

    WorkGivers.register({
      id: 'cbMeetInformant', workType: 'warden', order: 45, label: 'meet informants',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        pump(map);
        if (!staffOnly(pawn)) return null;
        var list = Contraband.informants(map);
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          if (p === pawn || p.downed || p.carriedBy) continue;
          if (now() - p.contraband.lastMeetTick < INFORMANT_COOLDOWN) continue;
          if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
          if (!reachable(map, pawn, p.x, p.y)) continue;
          return claim(pawn, 'cbMeetInformant', T.pawn(p));
        }
        return null;
      }
    });

    WorkGivers.register({
      id: 'cbTurnInformant', workType: 'warden', order: 70, label: 'turn a prisoner',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        pump(map);
        if (!staffOnly(pawn)) return null;
        var pol = Contraband.policy;
        if (Contraband.informants(map).length >= pol.informantCap) return null;
        var list = inmates(map), best = null, bestChance = 0.08;
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          if (p === pawn || p.downed || p.carriedBy || !p.contraband) continue;
          if (p.contraband.informant) continue;
          if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
          if (!reachable(map, pawn, p.x, p.y)) continue;
          var c = Contraband.turnChance(pawn, p);
          if (c > bestChance) { bestChance = c; best = p; }
        }
        return best ? claim(pawn, 'cbTurnInformant', T.pawn(best)) : null;
      }
    });

    WorkGivers.register({
      id: 'cbDogSweep', workType: 'handle', order: 60, label: 'sweep the block with a dog',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        pump(map);
        if (!staffOnly(pawn) || !Contraband.policy.dogPatrols || !Regions) return null;
        var rooms = blockRooms(map);
        if (!Object.keys(rooms).length) return null;
        var dog = null;
        for (var i = 0; i < map.pawns.length; i++) {
          var a = map.pawns[i];
          if (!a.isAnimal || a.dead || a.downed || a.faction !== 'player' || !a.tame) continue;
          if (a.kindId !== 'searchDog' && !(a.trainedLevels && a.trainedLevels.obedience > 0)) continue;
          if (!Res.canReserve(pawn, T.pawn(a), 1)) continue;
          dog = a; break;
        }
        if (!dog) return null;
        var cell = anyBlockCell(map, rooms, pawn);
        if (!cell) return null;
        if (now() - state.lastSweep < 12000) return null;
        state.lastSweep = now();
        return claim(pawn, 'cbDogSweep', T.cell(cell.x, cell.y), T.pawn(dog));
      }
    });

    WorkGivers.register({
      id: 'cbRaiseDog', workType: 'handle', order: 80, label: 'raise a search dog',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        if (!staffOnly(pawn)) return null;
        var kennels = map.byDef('cbKennel') || [];
        for (var i = 0; i < kennels.length; i++) {
          var k = kennels[i];
          if (!k.spawned) continue;
          if (!Res.canReserve(pawn, T.thing(k), 1)) continue;
          if (!reachable(map, pawn, k.x, k.y)) continue;
          if (!consumeCheck(map, k.x, k.y, 6, ['kibble', 'meatRaw'], RAISE_DOG_KIBBLE)) continue;
          /* One dog per kennel is enough; more is a handler wasting a day. */
          if (countSearchDogs(map) >= kennels.length) continue;
          return claim(pawn, 'cbRaiseDog', T.thing(k));
        }
        return null;
      }
    });
    return true;
  };

  function consumeCheck(map, x, y, radius, defIds, count) {
    var have = 0, cells = U.cellsInRadius(x, y, radius);
    for (var c = 0; c < cells.length; c++) {
      if (!map.inBounds(cells[c][0], cells[c][1])) continue;
      var items = map.items(cells[c][0], cells[c][1]);
      for (var i = 0; i < items.length; i++) {
        if (defIds.indexOf(items[i].defId) >= 0) have += items[i].stack || 1;
        if (have >= count) return true;
      }
    }
    return false;
  }

  function countSearchDogs(map) {
    var n = 0;
    for (var i = 0; i < map.pawns.length; i++) {
      if (map.pawns[i].kindId === 'searchDog' && !map.pawns[i].dead) n++;
    }
    return n;
  }

  /* ============================================================
     16. READOUTS

     Everything the player needs to see why it went wrong. ui.js owns
     the pixels; this owns the truth it draws.
     ============================================================ */

  Contraband.summary = function (pawn) {
    var st = pawn && pawn.contraband;
    if (!st) return '';
    var bits = [];
    var held = holdingCount(st);
    if (held) bits.push('carrying ' + held);
    if (st.stashes.length) bits.push(st.stashes.length + ' stash(es)');
    if (st.dealer) bits.push('dealer, ' + Math.round(st.favours) + ' favours');
    if (st.gangName) bits.push(st.gangRank === 2 ? 'leads the ' + st.gangName : st.gangName);
    if (st.informant) bits.push('informant (' + Math.round(st.exposure * 100) + '% exposed)');
    return bits.join(' - ');
  };

  /* What a warden would know, as opposed to what is true. A stash
     nobody has been told about does not appear here, which is the
     asymmetry the whole file exists to produce. */
  Contraband.inspect = function (pawn) {
    var st = pawn && pawn.contraband;
    if (!st) return null;
    return {
      name: nameOf(pawn),
      suspicion: Math.round(st.suspicion * 100),
      knownStashes: st.stashes.filter(function (s) { return s.known; }).length,
      gang: st.gangName || null,
      rank: ['member', 'lieutenant', 'leader'][st.gangRank] || 'member',
      dealer: st.dealer,
      informant: st.informant,
      exposure: Math.round(st.exposure * 100),
      debts: Object.keys(st.debts).length,
      grudge: Math.round(st.grudge * 100)
    };
  };

  Contraband.readout = function (map) {
    map = map || (sys('Game') && sys('Game').map);
    if (!map) return null;
    var gangs = Contraband.gangs(map).map(function (g) {
      return {
        id: g.id, name: g.name, members: g.memberIds.length, strength: Math.round(g.strength * 10) / 10,
        rooms: g.rooms.slice(), leader: nameOf(pawnById(map, g.leaderId)),
        grievance: Math.round(g.grievance * 100), known: g.known
      };
    });
    return {
      routes: Contraband.routes(map).map(function (r) {
        return {
          id: r.id, label: r.label, openness: Math.round(r.effective * 100),
          why: r.why, fix: r.fix, x: r.x, y: r.y
        };
      }),
      knownStashes: Contraband.stashes(map).filter(function (s) { return s.known; }),
      dealers: Contraband.dealers(map).map(function (d) {
        return { name: d.name, favours: d.favours, sales: d.sales, gang: d.gangName };
      }),
      informants: Contraband.informants(map).map(function (p) {
        return { name: nameOf(p), exposure: Math.round(p.contraband.exposure * 100), intel: p.contraband.intelGiven };
      }),
      gangs: gangs,
      fear: Math.round(state.fear * 100),
      pressure: searchPressure(),
      policy: Contraband.policy,
      totals: state.totals,
      ledger: Contraband.ledger(30)
    };
  };

  Contraband.alerts = function (map) {
    map = map || (sys('Game') && sys('Game').map);
    var out = [];
    if (!map) return out;
    var list = inmates(map);
    if (!list.length) return out;

    var guns = 0, blades = 0, tools = 0;
    for (var i = 0; i < list.length; i++) {
      if (Contraband.enables(list[i], 'gun')) guns++;
      if (Contraband.enables(list[i], 'violence')) blades++;
      var st = list[i].contraband;
      if (!st) continue;
      for (var id in st.holding) if (ITEMS[id] && ITEMS[id].tier === 'tool') tools++;
    }
    if (guns) out.push({ label: guns + ' firearm(s) inside the block', severity: 'critical' });
    if (blades > 2) out.push({ label: blades + ' prisoners are carrying blades', severity: 'high' });
    if (tools) out.push({ label: tools + ' escape tool(s) unaccounted for', severity: 'high' });

    var routes = Contraband.routes(map);
    for (var r = 0; r < routes.length; r++) {
      if (routes[r].effective > 0.6) {
        out.push({ label: 'wide open: ' + routes[r].label + ' (' + routes[r].fix + ')', severity: 'medium',
          lookAt: routes[r].x === null ? null : { x: routes[r].x, y: routes[r].y } });
      }
    }
    for (var g = 0; g < state.gangs.length; g++) {
      if (state.gangs[g].strength > 8) {
        out.push({ label: 'the ' + state.gangs[g].name + ' control the block', severity: 'high' });
      }
    }
    if (state.fear > 0.5) out.push({ label: 'the block is too frightened to talk to you', severity: 'medium' });
    return out;
  };

  /* Debug and scenario hooks: force one route to deliver, so a test or
     a scripted start does not have to wait for a dice roll. */
  Contraband.smuggle = function (pawn, itemId, count) {
    if (!ITEMS[itemId] || !pawn) return false;
    give(pawn, itemId, count || 1);
    state.totals.smuggled += (count || 1);
    log('in', nameOf(pawn) + ' got hold of ' + ITEMS[itemId].label);
    return true;
  };

  Contraband.stats = function () { return state.totals; };

  /* ============================================================
     17. SAVE

     The facts are on the pawns, so they are already in the file.
     What is left is policy, the ledger and the counters - and the
     gang identity, which is rebuilt from its members on first use.
     ============================================================ */

  Contraband.save = function () {
    return {
      policy: JSON.parse(JSON.stringify(Contraband.policy)),
      totals: JSON.parse(JSON.stringify(state.totals)),
      ledger: state.ledger.slice(-80),
      fear: state.fear,
      gangSeq: state.gangSeq,
      gangs: state.gangs.map(function (g) {
        return { id: g.id, key: g.key, name: g.name, leaderId: g.leaderId,
          grievance: g.grievance, known: g.known, formedTick: g.formedTick,
          memberIds: g.memberIds.slice(), heat: g.heat };
      })
    };
  };

  Contraband.load = function (obj) {
    state = freshState();
    Contraband.state = state;
    Contraband.policy = freshPolicy();
    if (!obj) return false;
    if (obj.policy) {
      Object.keys(Contraband.policy).forEach(function (k) {
        if (obj.policy[k] !== undefined) Contraband.policy[k] = obj.policy[k];
      });
    }
    if (obj.totals) Object.keys(state.totals).forEach(function (k) {
      if (typeof obj.totals[k] === 'number') state.totals[k] = obj.totals[k];
    });
    state.ledger = Array.isArray(obj.ledger) ? obj.ledger.slice() : [];
    state.fear = obj.fear || 0;
    state.gangSeq = obj.gangSeq || 0;
    state.gangs = (obj.gangs || []).map(function (g) {
      return {
        id: g.id, key: g.key, name: g.name, leaderId: g.leaderId || 0,
        memberIds: g.memberIds || [], rooms: [], strength: 0,
        heat: g.heat || {}, grievance: g.grievance || 0,
        known: !!g.known, formedTick: g.formedTick || 0
      };
    });
    state.gangsTick = -1;
    return true;
  };

  Contraband.reset = function () {
    state = freshState();
    Contraband.state = state;
    Contraband.policy = freshPolicy();
    return Contraband;
  };

  Contraband.registerWork();

  root.Contraband = Contraband;
})(this);
