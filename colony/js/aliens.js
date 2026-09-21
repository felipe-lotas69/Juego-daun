/* ============================================================
   aliens.js - the neighbours you did not ask for.

   Nothing in here exists for the first two in-game years. That is the
   rule the whole file is built around: a colony's first hundred and
   twenty days are about rain, raiders and rice, and the sky stays
   empty. After that a single number decides everything - the threat
   tier, 0..5 - and it is driven by how long you have been here, how
   much you own and how far your research has run, all three together.
   A colony that hides in a hole meets them late. A colony that rushes
   the tech tree gets a visitor while it still has wooden walls.

   Three neighbours, different in kind rather than in colour:

     the Vessel   - traders. They arrive first, they are genuinely
                    peaceful, and they sell technology two centuries
                    ahead of anything you can build. They are the only
                    reason a colony survives what comes after them.
     the Hive     - not diplomatic, not interested in you, and not in
                    a hurry. It puts a nest on the world map and takes
                    one more tile every few days until something stops
                    it. A strategic problem, not a raid.
     the Machines - a probe first, then incursions whose waves read
                    what beat the last one and answer it. Shoot them
                    down and the next wave wears armour. Meet them in
                    the doorway and the next wave stands off and
                    shoots. Wall them out and they come down inside.

   Everything it adds goes in additively: Defs.add for content,
   Jobs.register and WorkGivers.register for behaviour, and
   Incidents.register on the first tick, because events.js loads below
   this file and cannot be touched at load time. The storyteller keeps
   its own pacing; this file only gates what it is allowed to pick.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Everything above aliens.js in the load order may be bound now.
     Game, Save, Incidents and Storyteller load below it. */
  var T = root.T, Res = root.Res, Jobs = root.Jobs, Toils = root.Toils;
  var Path = root.Path, WorkGivers = root.WorkGivers;

  var Aliens = {};

  var TICKS_PER_DAY = 60000;
  var YEAR_DAYS = 60;                 /* four fifteen-day seasons */
  var CONTACT_DAY = YEAR_DAYS * 2;    /* nothing at all before this */
  var SLOW = 500;                     /* game.js calls Aliens.tick on this beat */

  /* ------------------------------------------------------------------
     Guarded access to everything that loads below, or that may simply
     not be in this build.
     ------------------------------------------------------------------ */

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
    if (g && g.debug && typeof console !== 'undefined') console.log('[aliens] ' + text);
  }

  /* ------------------------------------------------------------------
     Small map helpers. Deliberately local: events.js has its own and
     this file may not reach into them.
     ------------------------------------------------------------------ */

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

  /* A multi-cell building dropped on top of another one would write its
     id over cells the first still thinks it owns, so a code-spawned
     structure checks the whole footprint first. */
  function areaClear(map, x, y, w, h) {
    for (var dy = 0; dy < h; dy++) {
      for (var dx = 0; dx < w; dx++) {
        var cx = x + dx, cy = y + dy;
        if (!map.inBounds(cx, cy)) return false;
        if (!map.passable(cx, cy)) return false;
        if (map.buildingAt(cx, cy)) return false;
        if (map.plantAt(cx, cy)) return false;
      }
    }
    return true;
  }

  function colonyCentre(map) {
    var list = map.colonists ? map.colonists() : [];
    if (!list.length) return { x: map.w >> 1, y: map.h >> 1 };
    var sx = 0, sy = 0;
    for (var i = 0; i < list.length; i++) { sx += list[i].x; sy += list[i].y; }
    return { x: Math.round(sx / list.length), y: Math.round(sy / list.length) };
  }

  /* The nearest living colonist to a point, which is what an attacker
     is actually walking towards. */
  function colonyPoint(map, fromX, fromY) {
    var list = map.colonists ? map.colonists() : [];
    var best = null, bestD = Infinity;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.dead) continue;
      var d = U.distSq(p.x, p.y, fromX, fromY);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best ? { x: best.x, y: best.y } : colonyCentre(map);
  }

  /* Re-issuing a walk every slow tick resets the path and the pawn
     shuffles on the spot, so an existing walk to roughly the same place
     is left alone. */
  function keepWalking(pawn, x, y, pe) {
    if (!Jobs || !T) return false;
    var job = pawn.job;
    if (job && job.defId === 'goto' && job.targetA &&
        U.cheb(job.targetA.x, job.targetA.y, x, y) <= 6 &&
        (pawn.path || U.cheb(pawn.x, pawn.y, x, y) <= 2)) {
      return true;
    }
    return Jobs.start(pawn, Jobs.make('goto', T.cell(x, y), null, {
      state: { pe: pe === undefined ? (Path ? Path.PE.TOUCH : 1) : pe }
    }));
  }

  function holdPosition(pawn) {
    if (!Jobs) return false;
    if (pawn.job && pawn.job.defId === 'waitCombat') return true;
    return Jobs.start(pawn, Jobs.make('waitCombat', null, null, { count: 300 }));
  }

  function fightingAlready(pawn) {
    var job = pawn.job;
    if (!job || !T) return false;
    if (job.defId !== 'attackMelee' && job.defId !== 'attackStatic') return false;
    var cur = T.resolve(job.targetA, pawn.map);
    if (!cur || cur.dead || cur.downed || cur.spawned === false) return false;
    return true;
  }

  function attackJob(pawn, target) {
    var C = sys('Combat');
    if (!Jobs || !T || !target) return false;
    var isPawn = target.needs !== undefined || target.isHuman !== undefined;
    var tgt = isPawn ? T.pawn(target) : T.thing(target);
    var w = pawn.equipment && pawn.equipment.def && pawn.equipment.def.weapon;
    var ranged = false;
    if (w && w.ranged && C) {
      var d = U.dist(pawn.x, pawn.y, target.x, target.y);
      ranged = d <= w.range && d >= (w.minRange || 0) &&
        C.lineOfSight(pawn.map, pawn.x, pawn.y, target.x, target.y);
    }
    return Jobs.start(pawn, Jobs.make(ranged ? 'attackStatic' : 'attackMelee', tgt));
  }

  /* ============================================================
     1. STATE

     Most of it is deliberately re-derivable: the civilizations live in
     factions.js, the nests live on the world map and the half-studied
     artefact lives on the Thing itself, all three of which a save file
     already carries. What is left here is the bookkeeping that has
     nowhere else to live, and ensureState() rebuilds the rest when a
     save comes back without it.
     ============================================================ */

  function blankState() {
    return {
      tier: 0,
      peak: 0,
      bias: 0,                 /* what first contact did to the schedule */
      contactOffered: false,
      contactTick: 0,
      stance: 'none',          /* none | welcome | hide | attack */
      civs: {},                /* speciesId -> {factionId, tick, nests:[]} */
      hive: { nextSpreadTick: 0, spread: 0, lost: 0, warned: 0 },
      machine: {
        probed: false, waves: 0, counters: { armour: 0, standoff: 0, breach: 0, pods: 0 },
        active: null, nextWaveTick: 0
      },
      invasion: null,
      abductions: [],          /* {name, kindId, gender, ageYears, traits, skills, backstories, returnTick, taken} */
      studied: 0,
      lastSeenTick: 0,
      incidentsReady: false
    };
  }

  var state = blankState();

  Aliens.state = function () { return state; };

  Aliens.reset = function () {
    var ready = state.incidentsReady;
    state = blankState();
    state.incidentsReady = ready;
    return Aliens;
  };

  /* ============================================================
     2. THE THREAT TIER

     Days, wealth and research, multiplied out into one pressure
     number. The weights matter: research is worth more than silver,
     because a colony that lights up a spacer-grade research bench is
     shouting, and a colony that quietly stacks steel is not.
     ============================================================ */

  var TIER_AT = [0.30, 0.95, 1.75, 2.70, 3.80];

  function researchPressure() {
    var R = sys('Research');
    if (!R || !R.done) return 0;
    var all = Defs.all('research') || [];
    if (!all.length) return 0;
    var done = 0, spacer = 0;
    for (var i = 0; i < all.length; i++) {
      if (!R.done.has(all[i].id)) continue;
      done++;
      if (all[i].techLevel === 'spacer') spacer++;
    }
    /* A finished spacer project counts for far more than a finished
       stonecutting one: it is the loud kind of progress, and it is
       deliberately worth more than the same day's silver - a colony
       that lights a spacer bench is shouting, a colony that stacks
       steel is only rich. */
    return (done / all.length) * 1.15 + spacer * 0.30;
  }

  Aliens.pressure = function (game) {
    game = game || G();
    var day = game && game.day ? game.day() : today();
    var elapsed = day - CONTACT_DAY;
    if (elapsed < 0) return { days: 0, wealth: 0, tech: 0, total: 0, elapsed: elapsed };
    var wealth = (game && typeof game.wealth === 'number') ? game.wealth : 0;
    var parts = {
      days: elapsed / 50,
      wealth: U.clamp(wealth / 65000, 0, 1.8),
      tech: researchPressure(),
      elapsed: elapsed
    };
    parts.total = parts.days + parts.wealth + parts.tech + state.bias;
    return parts;
  };

  Aliens.threatTier = function (game) {
    game = game || G();
    var day = game && game.day ? game.day() : today();
    if (day < CONTACT_DAY) return 0;
    var p = Aliens.pressure(game);
    var tier = 0;
    for (var i = 0; i < TIER_AT.length; i++) if (p.total >= TIER_AT[i]) tier = i + 1;
    /* A colony that got rich in a hurry still does not meet the fleet
       in its first month of contact: wealth buys the ladder, days buy
       the rungs. */
    var cap = 1 + Math.floor((day - CONTACT_DAY) / 28);
    tier = Math.min(tier, cap, 5);
    /* Losing half the stockpile does not un-summon a hive. */
    if (tier < state.peak) tier = state.peak;
    return tier;
  };

  Aliens.tier = function () { return state.tier; };

  var TIER_LABEL = [
    'nothing out there',
    'contact',
    'a foothold',
    'probing',
    'incursion',
    'invasion'
  ];
  Aliens.tierLabel = function (t) {
    return TIER_LABEL[U.clamp(t === undefined ? state.tier : t, 0, 5)];
  };

  Aliens.daysToContact = function (game) {
    var day = game && game.day ? game.day() : today();
    return Math.max(0, CONTACT_DAY - day);
  };

  /* ============================================================
     3. CONTENT

     Research, items, benches, weapons and the pawn kinds the three
     species field. All registered at load, all additive.
     ============================================================ */

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

  Defs.add('research', {
    xenology: {
      label: 'xenology', cost: 2400, techLevel: 'industrial', tab: 'advanced',
      description: 'A bench, a clamp and a great deal of patience. It does not tell you ' +
        'how their machines work. It tells you how to find out without losing a hand.',
      prerequisites: ['electricity'],
      unlocks: ['xenoAnalyser'],
      uiPosition: { x: 4, y: 11 }
    },
    xenotechSalvage: {
      label: 'xenotech salvage', cost: 3800, techLevel: 'spacer', tab: 'advanced',
      description: 'Enough of their metallurgy understood to make a poor copy of it. ' +
        'The alloy is not as good as theirs. It is far better than yours.',
      prerequisites: ['xenology', 'machining'],
      unlocks: ['alienAlloy', 'replicateAlloy'],
      uiPosition: { x: 5, y: 11 }
    },
    xenotechWeapons: {
      label: 'xenotech weapons', cost: 5600, techLevel: 'spacer', tab: 'advanced',
      description: 'A coil, a lens and a capacitor the size of a fist. It punches through ' +
        'armour the way a rifle punches through cloth, and it costs a season to build.',
      prerequisites: ['xenotechSalvage', 'advancedFirearms'],
      unlocks: ['xenoLance', 'forgeXenoLance'],
      uiPosition: { x: 6, y: 11 }
    },
    signalOverride: {
      label: 'signal override', cost: 6400, techLevel: 'spacer', tab: 'advanced',
      description: 'Their fleet authenticates itself constantly, and anything that can ' +
        'answer in the right voice can tell it to go home. Broadcasting it takes days ' +
        'and an enormous amount of power.',
      prerequisites: ['xenotechSalvage', 'batteries'],
      unlocks: ['xenoBeacon'],
      uiPosition: { x: 6, y: 12 }
    }
  });

  Defs.add('thing', {

    /* ---- artefacts: the things you cannot make ---- */

    xenoCore: {
      label: 'singularity cell', color: '#7fe3d0', color2: '#123b3a',
      description: 'A palm-sized cylinder that is cold on one side and warm on the other ' +
        'and has been doing that, unattended, for longer than your species has had writing.',
      stackLimit: 10, mass: 1.5, marketValue: 900
    },
    xenoLens: {
      label: 'phase lens', color: '#cdb8ff', color2: '#2b2540',
      description: 'Glass that is not glass. Look through it at a wall and you can see the ' +
        'shape of what is behind the wall, which nobody in this system knows how to do.',
      stackLimit: 10, mass: 0.8, marketValue: 720
    },
    xenoWeave: {
      label: 'adaptive weave', color: '#9aa8b6', color2: '#3a4450',
      description: 'A bolt of cloth that stiffens where it is struck. A knife slides off it. ' +
        'Nobody has worked out how to cut it into a shape and have it stay cut.',
      stackLimit: 20, mass: 1.0, marketValue: 640
    },
    machineCoil: {
      label: 'drive coil', color: '#d8c27a', color2: '#4a3f22',
      description: 'Pulled from something that stopped moving. Still faintly humming, which ' +
        'the people who pull them out of wrecks have learned not to think about.',
      stackLimit: 10, mass: 2.0, marketValue: 520
    },
    hiveChitin: {
      label: 'hive chitin', color: '#8f7a4a', color2: '#4a3d22',
      description: 'Plate cut from something that grew it. Light, hard, and it smells of ' +
        'nothing at all, which is somehow worse.',
      stackLimit: 75, mass: 0.6, marketValue: 22
    },

    /* ---- what study and replication produce ---- */

    xenoSchematic: {
      label: 'xenotech schematic', color: '#ffc23c', color2: '#3a2e10',
      description: 'A stack of notes, castings and one page of numbers that took a month to ' +
        'get right. Worth more than the artefact it came out of, because it can be used twice.',
      stackLimit: 25, mass: 0.3, marketValue: 380
    },
    alienAlloy: {
      label: 'alien alloy', sprite: 'bar', color: '#b6c6cc', color2: '#59707a',
      description: 'Your best guess at their metal. Lighter than steel, harder than steel, ' +
        'and it takes a smithy a very long time to make a very small amount.',
      stackLimit: 75, mass: 0.4, marketValue: 48
    },

    /* ---- buildables ---- */

    xenoAnalyser: {
      label: 'xenology bench', sprite: 'researchBench', color: '#3c4a56', color2: '#7fe3d0',
      description: 'Clamps, a shielded box and a recorder. Artefacts are brought here and ' +
        'taken apart slowly enough that the person doing it usually survives.',
      category: 'building', stackLimit: 1, mass: 140, hp: 220,
      passable: false, fillPercent: 0.5, blocksLight: false, holdsRoof: false,
      beauty: -1, buildSkill: 'construction',
      size: { w: 2, h: 1 }, rotatable: true,
      buildCost: { steel: 90, components: 6 }, workToBuild: 2400,
      buildCategory: 'production', researchPrerequisite: 'xenology',
      leavings: { steel: 30, components: 2 },
      building: bld({ isWorkbench: true, powerConsumed: 180, interactionOffset: { dx: 0, dy: 1 } })
    },

    xenoBeacon: {
      label: 'override beacon', sprite: 'turret', color: '#2e3a48', color2: '#ffc23c',
      description: 'A dish, a capacitor bank and the one sequence of numbers their fleet ' +
        'cannot ignore. Powered and undisturbed for two days, it tells an invasion that it ' +
        'was never authorised.',
      category: 'building', stackLimit: 1, mass: 400, hp: 420,
      passable: false, fillPercent: 1, blocksLight: true, holdsRoof: true,
      beauty: -4, buildSkill: 'construction',
      size: { w: 2, h: 2 }, rotatable: false,
      buildCost: { alienAlloy: 80, components: 14, xenoSchematic: 4 }, workToBuild: 9000,
      buildCategory: 'misc', researchPrerequisite: 'signalOverride',
      leavings: { alienAlloy: 25, components: 4 },
      building: bld({ powerConsumed: 700 })
    },

    /* ---- spawned by code, never built ---- */

    hiveNode: {
      label: 'hive node', sprite: 'box', color: '#6d5a30', color2: '#c2a85e',
      description: 'A knot of resin the size of a cart, breathing slowly. Drones come out ' +
        'of it. Cutting it open stops that.',
      category: 'building', stackLimit: 1, mass: 300, hp: 420,
      passable: false, fillPercent: 1, blocksLight: true, holdsRoof: false,
      flammable: true, beauty: -8, buildSkill: 'construction',
      leavings: { hiveChitin: 22 },
      building: bld({})
    },

    machineSpire: {
      label: 'landing spire', sprite: 'wall', color: '#39424e', color2: '#d8c27a',
      description: 'Four legs and a throat. Everything that has landed on your map came ' +
        'down this, and everything that is still coming will too.',
      category: 'building', stackLimit: 1, mass: 900, hp: 900,
      passable: false, fillPercent: 1, blocksLight: true, holdsRoof: true,
      beauty: -10, buildSkill: 'construction',
      size: { w: 2, h: 2 }, rotatable: false,
      leavings: { machineCoil: 3, alienAlloy: 20 },
      building: bld({})
    },

    /* ---- one weapon worth the whole tech line ---- */

    xenoLance: {
      label: 'xeno lance', sprite: 'rifle', color: '#5a6a78', color2: '#7fe3d0',
      description: 'A copy of something that was never meant to be copied. Slow to bring on ' +
        'target and it does not care what the target is wearing.',
      category: 'item', stackLimit: 1, mass: 4.5, marketValue: 2200, hp: 120, flammable: false,
      weapon: {
        ranged: true, damage: 27, damageType: 'bullet', range: 32,
        warmupTicks: 100, cooldownTicks: 140, burstCount: 1, burstTicks: 0,
        accuracy: { touch: 0.55, short: 0.78, medium: 0.80, long: 0.72 },
        armorPen: 0.62, projectileSpeed: 110, projectileDef: 'bullet',
        minRange: 0, forcedMissRadius: 0
      }
    }

  }, ITEM);

  Defs.add('recipe', {
    replicateAlloy: {
      label: 'alien alloy', jobString: 'Replicating alien alloy', uiCategory: 'smithing',
      workAmount: 2200, skill: 'crafting', skillRequirement: 9,
      workbenches: ['smithy'],
      ingredients: [{ thing: 'steel', count: 25 }, { thing: 'components', count: 2 }],
      products: { alienAlloy: 6 },
      researchPrerequisite: 'xenotechSalvage',
      defaultRepeat: 'untilHave', defaultTargetCount: 40,
      description: 'Steel, a great deal of current and one page of their notes. Six bars ' +
        'for a day of a good smith, which is why nobody makes walls out of it.'
    },
    forgeXenoLance: {
      label: 'xeno lance', jobString: 'Building a xeno lance', uiCategory: 'smithing',
      workAmount: 5200, skill: 'crafting', skillRequirement: 12,
      workbenches: ['smithy'],
      ingredients: [{ thing: 'alienAlloy', count: 35 }, { thing: 'components', count: 6 },
                    { thing: 'xenoSchematic', count: 1 }],
      products: { xenoLance: 1 },
      researchPrerequisite: 'xenotechWeapons',
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'A season of a master crafter\'s time for one rifle. Worth it the first ' +
        'time it goes through a wall and the thing standing behind it.'
    }
  });

  Defs.add('thought', {
    xenoFirstSight: {
      label: 'We are not alone', durationDays: 8, stackLimit: 1,
      stages: [{ label: 'We are not alone after all', mood: 0.07 }]
    },
    xenoWelcomed: {
      label: 'We shook their hand', durationDays: 25, stackLimit: 1,
      stages: [{ label: 'We shook their hand', mood: 0.06 }]
    },
    xenoShame: {
      label: 'We shot the envoys', durationDays: 30, stackLimit: 1,
      nullifiedByTrait: ['psychopath', 'bloodlust'],
      stages: [{ label: 'We shot the envoys', mood: -0.12 }]
    },
    xenoDread: {
      label: 'Something is out there', durationDays: 3, stackLimit: 2,
      nullifiedByTrait: ['psychopath'],
      stages: [{ label: 'Something is out there', mood: -0.06 }]
    },
    xenoTaken: {
      label: 'They took someone', durationDays: 12, stackLimit: 2,
      nullifiedByTrait: ['psychopath'],
      stages: [{ label: 'They took someone and we watched', mood: -0.13 }]
    },
    xenoReturned: {
      label: 'They gave them back', durationDays: 10, stackLimit: 1,
      stages: [{ label: 'They gave them back', mood: 0.05 }]
    },
    xenoChanged: {
      label: 'They came back wrong', durationDays: 20, stackLimit: 1,
      nullifiedByTrait: ['psychopath'],
      stages: [{ label: 'They came back wrong', mood: -0.09 }]
    },
    xenoOverride: {
      label: 'We sent them home', durationDays: 25, stackLimit: 1,
      stages: [{ label: 'We told a fleet to go home and it went', mood: 0.20 }]
    }
  });

  /* One condition of this file's own. health.js exposes its table for
     exactly this; a returned colonist carries it for the rest of their
     life and it is not all bad news. */
  (function addHediff() {
    var H = root.Health;
    if (!H || !H.HEDIFFS || H.HEDIFFS.xenoGraft) return;
    H.HEDIFFS.xenoGraft = {
      id: 'xenoGraft', label: 'xenograft', lethal: false, driven: false,
      severityPerDay: 0, painOffset: 0.05,
      capMods: { consciousness: 0.10, sight: 0.15, moving: -0.05 }
    };
  })();

  /* ---- the pawn kinds each species fields ---- */

  Defs.add('pawnKind', {
    xenoEnvoy: {
      label: 'Vessel envoy',
      description: 'Tall, slow-moving, and it does the talking. Whatever it is wearing is ' +
        'doing more than keeping it warm.',
      combatPower: 70, defaultFaction: 'neutral', techLevel: 'spacer',
      weapons: ['pistol'], apparel: ['shirt', 'pants', 'jacket'],
      color: '#7fe3d0', color2: '#2a4c52', meleeSkill: 5, moveSpeed: 4.2
    },
    xenoGuard: {
      label: 'Vessel guard',
      description: 'It stands where it is put and watches the horizon. Nobody has seen one ' +
        'fire, which is not the same as nobody knowing what would happen.',
      combatPower: 165, defaultFaction: 'neutral', techLevel: 'spacer',
      weapons: ['boltRifle', 'autoRifle'], apparel: ['shirt', 'pants', 'armorVest', 'helmet'],
      color: '#4fbfae', color2: '#1d3a40', meleeSkill: 8,
      armorSharp: 0.28, armorBlunt: 0.18
    },
    machineProbe: {
      label: 'probe',
      description: 'A walking sensor with a cutting arm as an afterthought. It is here to ' +
        'count you.',
      combatPower: 70, defaultFaction: 'neutral', techLevel: 'spacer',
      weapons: [], apparel: [],
      color: '#8d97a3', color2: '#d8c27a', moveSpeed: 5.2,
      meleeDamage: 11, meleeDamageType: 'cut', meleeCooldownTicks: 90, meleeSkill: 7,
      armorSharp: 0.30, armorBlunt: 0.25, comfyTempMin: -60, comfyTempMax: 70
    },
    machineSoldier: {
      label: 'line unit',
      description: 'Waist-high, four-legged and carrying a rifle bolted where a head would ' +
        'be. There are always more of them than you counted.',
      combatPower: 155, defaultFaction: 'neutral', techLevel: 'spacer',
      weapons: ['autoRifle', 'boltRifle'], apparel: [],
      color: '#69737f', color2: '#d8c27a', moveSpeed: 4.4, meleeSkill: 7,
      armorSharp: 0.34, armorBlunt: 0.26, comfyTempMin: -60, comfyTempMax: 70
    },
    machineBreacher: {
      label: 'breacher',
      description: 'A ram with legs. It is not interested in your colonists and will walk ' +
        'through the wall they are standing behind.',
      combatPower: 200, defaultFaction: 'neutral', techLevel: 'spacer',
      weapons: [], apparel: [],
      color: '#4e5762', color2: '#c0392b', moveSpeed: 3.8,
      meleeDamage: 26, meleeDamageType: 'blunt', meleeCooldownTicks: 130, meleeSkill: 6,
      meleeArmorPen: 0.4, armorSharp: 0.45, armorBlunt: 0.40,
      baseHealthScale: 1.5, healthScale: 1.5, comfyTempMin: -60, comfyTempMax: 70
    },
    machineLance: {
      label: 'lance unit',
      description: 'Thin, long-legged and it opens the fight from further away than anything ' +
        'you own can answer.',
      combatPower: 215, defaultFaction: 'neutral', techLevel: 'spacer',
      weapons: ['sniperRifle'], apparel: [],
      color: '#7a8694', color2: '#7fe3d0', moveSpeed: 4.0, meleeSkill: 4,
      armorSharp: 0.22, armorBlunt: 0.18, comfyTempMin: -60, comfyTempMax: 70
    }
  }, {
    race: 'human', isAnimal: false, body: 'human', sprite: 'human',
    baseHealthScale: 1, healthScale: 1, moveSpeed: 4.6, moveSpeedFactor: 1,
    baseBodySize: 1, bodySize: 1, drawSize: 1,
    baseHungerRate: 1.6, hungerRateFactor: 1,
    lifeExpectancyYears: 90, ageRange: [22, 60],
    meleeDamage: 8, meleeDamageType: 'blunt', meleeCooldownTicks: 120,
    meleeArmorPen: 0, meleeSkill: 5,
    comfyTempMin: -25, comfyTempMax: 48,
    armorSharp: 0, armorBlunt: 0, armorHeat: 0,
    trainability: null, wildness: 0, packAnimal: false, predator: false,
    grazer: false, nocturnal: false, breeds: false, diet: 'omnivore',
    butcherProducts: null, leatherAmount: 0,
    manhunterChance: 0, revengeChance: 0, manhunterOnTameFail: 0,
    explodeOnDeath: false, explodes: false, nuzzles: false,
    color2: '#d8cfc0'
  });

  Defs.add('pawnKind', {
    hiveDrone: {
      label: 'hive drone',
      description: 'Knee-high, fast, and it does not flinch. On its own it is a nuisance. ' +
        'They are never on their own.',
      combatPower: 50,
      baseHealthScale: 0.5, healthScale: 0.5,
      baseBodySize: 0.4, bodySize: 0.4, drawSize: 0.9,
      moveSpeed: 5.6, lifeExpectancyYears: 3, ageRange: [0.2, 2],
      meleeDamage: 9, meleeCooldownTicks: 80, meleeSkill: 6,
      butcherProducts: { hiveChitin: 8 }, leatherAmount: 0,
      color: '#8f7a4a', color2: '#d6c188', sprite: 'hare'
    },
    hiveWarrior: {
      label: 'hive warrior',
      description: 'Plated, deliberate, and it puts itself between you and the drones ' +
        'without appearing to decide to.',
      combatPower: 140,
      baseHealthScale: 1.3, healthScale: 1.3,
      baseBodySize: 1.2, bodySize: 1.2, drawSize: 1.4,
      moveSpeed: 4.6, lifeExpectancyYears: 8, ageRange: [0.5, 6],
      meleeDamage: 17, meleeDamageType: 'cut', meleeCooldownTicks: 100, meleeSkill: 8,
      meleeArmorPen: 0.2, armorSharp: 0.28, armorBlunt: 0.22,
      butcherProducts: { hiveChitin: 28 },
      color: '#6d5a30', color2: '#c2a85e', sprite: 'wolf'
    },
    hiveQueen: {
      label: 'hive matron',
      description: 'The thing the nest is built around. Slow, enormous, and everything else ' +
        'on the map stops what it is doing when this arrives.',
      combatPower: 340,
      baseHealthScale: 2.4, healthScale: 2.4,
      baseBodySize: 2.4, bodySize: 2.4, drawSize: 2.1,
      moveSpeed: 3.0, lifeExpectancyYears: 40, ageRange: [2, 30],
      meleeDamage: 26, meleeDamageType: 'cut', meleeCooldownTicks: 120, meleeSkill: 9,
      meleeArmorPen: 0.35, armorSharp: 0.40, armorBlunt: 0.35,
      butcherProducts: { hiveChitin: 90 },
      color: '#5a4a24', color2: '#e0c87a', sprite: 'bear'
    }
  }, {
    race: 'animal', isAnimal: true, body: 'quadruped', sprite: 'wolf',
    defaultFaction: 'wild', techLevel: 'animal',
    moveSpeedFactor: 1, weapons: [], apparel: [],
    baseHungerRate: 1.2, hungerRateFactor: 0.8,
    meleeDamageType: 'bite', meleeArmorPen: 0, meleeSkill: 5,
    armorSharp: 0, armorBlunt: 0, armorHeat: 0,
    diet: 'carnivore', grazer: false, predator: true,
    wildness: 1, trainability: 'none', packSize: [3, 7],
    packAnimal: false, nocturnal: false, breeds: false,
    lifeExpectancyYears: 6, comfyTempMin: -35, comfyTempMax: 55,
    manhunterChance: 1, revengeChance: 1, manhunterOnTameFail: 1,
    explodeOnDeath: false, explodes: false, nuzzles: false,
    leatherAmount: 0, color2: '#d8cfc0'
  });

  Defs.add('faction', {
    xenoVessel: {
      label: 'The Vessel', color: '#7fe3d0',
      description: 'Traders from somewhere that has not needed a planet in a long time.',
      hostileToPlayer: false, techLevel: 'spacer'
    },
    xenoHive: {
      label: 'The Hive', color: '#c2a85e',
      description: 'Not a civilization. A process, with teeth.',
      hostileToPlayer: true, techLevel: 'animal'
    },
    xenoMachine: {
      label: 'The Fleet', color: '#8d97a3',
      description: 'A machine intelligence that counts first and lands second.',
      hostileToPlayer: true, techLevel: 'spacer'
    }
  }, { isPlayer: false, hostileToPlayer: false, techLevel: 'spacer' });

  Defs.add('settlementKind', {
    hiveNest: {
      label: 'hive nest',
      description: 'Resin over rock, spreading outward at the speed of a slow walk per week.',
      wealthRange: [0, 0], color: '#c2a85e', sprite: 'camp',
      stockCategories: [], defenders: ['hiveWarrior'], defenderCount: [6, 14],
      canTradeWith: false, restockDays: 999, marketRadius: 0,
      namePatterns: ['{A} Nest', 'The {A} Growth'],
      nameWords: { A: ['Ash', 'Pale', 'Low', 'Deep', 'Grey', 'Long', 'Black', 'Quiet', 'Old', 'Split'] }
    },
    machineForge: {
      label: 'landing site',
      description: 'A cleared circle with something standing in the middle of it that was ' +
        'not made here.',
      wealthRange: [3000, 9000], color: '#8d97a3', sprite: 'town',
      stockCategories: [], defenders: ['machineSoldier'], defenderCount: [5, 12],
      canTradeWith: false, restockDays: 999, marketRadius: 0,
      namePatterns: ['Site {A}', 'Landing {A}'],
      nameWords: { A: ['One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Nine', 'Twelve'] }
    },
    vesselPort: {
      label: 'Vessel port',
      description: 'A grounded hull the size of a town, open on one side, trading with ' +
        'anyone who walks up to it.',
      wealthRange: [9000, 24000], color: '#7fe3d0', sprite: 'town',
      stockCategories: ['manufactured', 'medicine', 'weapons', 'apparel'],
      defenders: ['xenoGuard'], defenderCount: [4, 9],
      canTradeWith: true, restockDays: 5, marketRadius: 14,
      namePatterns: ['The {A} Hull', '{A} Landing'],
      nameWords: { A: ['Long', 'Ninth', 'Quiet', 'Cold', 'Far', 'Second', 'Broken', 'Patient'] }
    }
  });

  /* ============================================================
     4. THE THREE SPECIES

     factions.js generates its civilizations at world gen and has no
     door for a civilization that turns up in year three, so these are
     built as plain records and pushed in through the save/load round
     trip it already exposes. Their kinds are NOT registered in the
     factionKind table on purpose: a kind in that table is a kind world
     gen can roll, and nothing here may exist on day one.
     ============================================================ */

  function kindTemplate(o) {
    var out = {
      id: o.id, label: o.label, description: o.description || '',
      techLevel: o.techLevel || 'spacer',
      permanentEnemy: !!o.permanentEnemy,
      canTrade: o.canTrade !== false, canAlly: !!o.canAlly,
      settlementCount: o.settlementCount || [1, 2],
      goodwillStart: o.goodwillStart || [0, 20],
      goodwillGainFactor: o.goodwillGainFactor === undefined ? 1 : o.goodwillGainFactor,
      goodwillLossFactor: o.goodwillLossFactor === undefined ? 1 : o.goodwillLossFactor,
      goodwillDriftPerDay: o.goodwillDriftPerDay === undefined ? 0.2 : o.goodwillDriftPerDay,
      raidPointsFactor: o.raidPointsFactor === undefined ? 1 : o.raidPointsFactor,
      allyHelpChance: o.allyHelpChance === undefined ? 0 : o.allyHelpChance,
      weight: 0,
      raidStrategies: o.raidStrategies || ['assault'],
      settlementKinds: o.settlementKinds || ['village'],
      pawnKinds: o.pawnKinds || { raider: ['raider'], trader: ['wanderer'], guard: ['raider'] },
      traderKinds: o.traderKinds || [],
      tradeCategories: o.tradeCategories || [],
      namePatterns: ['{A}'], nameWords: { A: [o.label] },
      leaderTitles: o.leaderTitles || ['Speaker'],
      colorPrimary: o.colorPrimary, colorSecondary: o.colorSecondary
    };
    return out;
  }

  var SPECIES = {
    vessel: {
      id: 'vessel', factionId: 'xenoVessel', minTier: 1,
      name: 'the Vessel', leader: 'The Ninth Voice', title: 'Voice',
      kind: kindTemplate({
        id: 'xenoVesselKind', label: 'the Vessel',
        description: 'A hull that has been travelling between systems for so long that ' +
          'the people inside it no longer think of themselves as being from anywhere.',
        techLevel: 'spacer', canTrade: true, canAlly: true,
        settlementCount: [1, 1], goodwillStart: [35, 55],
        goodwillGainFactor: 1.2, goodwillLossFactor: 1.8, goodwillDriftPerDay: 0.15,
        allyHelpChance: 0.4, raidPointsFactor: 1.4,
        raidStrategies: ['assault'],
        settlementKinds: ['vesselPort'],
        pawnKinds: { raider: ['xenoGuard'], trader: ['xenoEnvoy'], guard: ['xenoGuard'] },
        traderKinds: ['exotic'],
        tradeCategories: ['manufactured', 'medicine', 'weapons', 'apparel'],
        leaderTitles: ['Voice'],
        colorPrimary: '#7fe3d0', colorSecondary: '#2a4c52'
      })
    },
    hive: {
      id: 'hive', factionId: 'xenoHive', minTier: 2,
      name: 'the Hive', leader: 'the matron', title: 'Matron',
      kind: kindTemplate({
        id: 'xenoHiveKind', label: 'the Hive',
        description: 'It does not negotiate, it does not raid and it does not stop. It takes ' +
          'ground, and what is on the ground stops being there.',
        techLevel: 'neolithic', permanentEnemy: true, canTrade: false, canAlly: false,
        settlementCount: [1, 1], goodwillStart: [-100, -100],
        goodwillDriftPerDay: 0, raidPointsFactor: 0.85,
        raidStrategies: ['assault'],
        settlementKinds: ['hiveNest'],
        pawnKinds: { raider: ['hiveDrone'], trader: ['hiveDrone'], guard: ['hiveWarrior'] },
        leaderTitles: ['Matron'],
        colorPrimary: '#c2a85e', colorSecondary: '#5a4a24'
      })
    },
    machine: {
      id: 'machine', factionId: 'xenoMachine', minTier: 3,
      name: 'the Fleet', leader: 'the arbiter', title: 'Arbiter',
      kind: kindTemplate({
        id: 'xenoMachineKind', label: 'the Fleet',
        description: 'Something enormous, very far away, that has decided this system is ' +
          'worth a survey. Each thing it sends is an answer to the last thing you did.',
        techLevel: 'spacer', permanentEnemy: true, canTrade: false, canAlly: false,
        settlementCount: [1, 1], goodwillStart: [-100, -100],
        goodwillDriftPerDay: 0, raidPointsFactor: 1.35,
        raidStrategies: ['assault', 'sappers'],
        settlementKinds: ['machineForge'],
        pawnKinds: {
          raider: ['machineSoldier'], trader: ['machineProbe'], guard: ['machineSoldier']
        },
        leaderTitles: ['Arbiter'],
        colorPrimary: '#8d97a3', colorSecondary: '#d8c27a'
      })
    }
  };

  Aliens.species = function () { return [SPECIES.vessel, SPECIES.hive, SPECIES.machine]; };

  function factionOf(speciesId) {
    var F = sys('Factions');
    var spec = SPECIES[speciesId];
    if (!F || !F.get || !spec) return null;
    return F.get(spec.factionId);
  }
  Aliens.factionOf = factionOf;

  function setRelations(id, hostile) {
    var C = sys('Combat');
    if (!C || !C.setRelation) return;
    var others = ['player', 'raider', 'neutral', 'wild'];
    for (var i = 0; i < others.length; i++) {
      if (others[i] === 'wild') { C.setRelation(id, 'wild', false); continue; }
      C.setRelation(id, others[i], hostile);
    }
    /* The three of them are not friends either. Two hostile aliens on
       the same map fighting each other is a story worth having. */
    var mine = ['xenoVessel', 'xenoHive', 'xenoMachine'];
    for (var j = 0; j < mine.length; j++) {
      if (mine[j] === id) continue;
      C.setRelation(id, mine[j], id !== 'xenoVessel' || mine[j] !== 'xenoVessel');
    }
  }

  /* factions.js resolves a kind it does not know to a bland stand-in,
     so the real one is put back by hand after every load. */
  function repairKind(spec) {
    var f = factionOf(spec.id);
    if (!f) return null;
    if (f.kind !== spec.kind) f.kind = spec.kind;
    f.techLevel = spec.kind.techLevel;
    f.permanentEnemy = !!spec.kind.permanentEnemy;
    if (f.permanentEnemy) { f.hostile = true; f.allied = false; }
    setRelations(f.id, !!f.hostile);
    return f;
  }

  function placeHomeSite(spec, factionId) {
    var W = sys('World');
    if (!W || !W.placeSettlement || !W.liveSettlements) return null;
    var colony = W.colonyTile || 0;
    var kindId = spec.kind.settlementKinds[0];
    var wanted = spec.id === 'vessel' ? 10 : (spec.id === 'hive' ? 14 : 18);
    var best = -1, bestScore = -1;
    for (var attempt = 0; attempt < 220; attempt++) {
      var i = U.randInt(0, (W.size || 1) - 1);
      if (W.isOcean && W.isOcean(i)) continue;
      if (W.settlementAt && W.settlementAt(i)) continue;
      var d = W.distance ? W.distance(i, colony) : wanted;
      var score = 1 / (1 + Math.abs(d - wanted));
      if (score > bestScore) { bestScore = score; best = i; }
    }
    if (best < 0) return null;
    return W.placeSettlement(best, factionId, kindId, null);
  }

  /* One civilization, inserted through the only door factions.js has:
     its own save shape, handed straight back to it with one more
     record in the list. */
  function ensureCiv(speciesId) {
    var spec = SPECIES[speciesId];
    if (!spec) return null;
    var F = sys('Factions');
    if (!F || !F.save || !F.load || !F.get) return null;

    var already = F.get(spec.factionId);
    if (already) {
      if (!state.civs[speciesId]) {
        state.civs[speciesId] = { factionId: spec.factionId, tick: now(), nests: [] };
      }
      return repairKind(spec);
    }

    var kind = spec.kind;
    var hostile = !!kind.permanentEnemy;
    var record = {
      id: spec.factionId, kindId: kind.id, name: spec.name,
      leaderName: spec.leader, leaderTitle: spec.title, leaderGender: 'female',
      color: kind.colorPrimary, colorSecondary: kind.colorSecondary,
      goodwill: hostile ? -100 : U.randInt(kind.goodwillStart[0], kind.goodwillStart[1]),
      baseGoodwill: hostile ? -100 : 30,
      hostile: hostile, allied: false, permanentEnemy: hostile,
      settlements: [], techLevel: kind.techLevel, history: [],
      atWarSinceTick: hostile ? now() : 0,
      lastRaidTick: 0, lastHelpTick: 0, raidCount: 0, tradeCount: 0
    };

    var snapshot;
    try { snapshot = F.save(); } catch (e) { snapshot = null; }
    if (!snapshot) return null;
    if (!snapshot.factions) snapshot.factions = [];
    snapshot.factions.push(record);
    var ok = false;
    try { ok = F.load(snapshot); } catch (e) { ok = false; }
    if (!ok) return null;

    var f = repairKind(spec);
    if (!f) return null;

    var site = placeHomeSite(spec, spec.factionId);
    if (site) f.settlements.push(site.id);
    state.civs[speciesId] = {
      factionId: spec.factionId, tick: now(), nests: site ? [site.id] : []
    };
    debugLog('civilization arrived: ' + speciesId);
    return f;
  }
  Aliens.ensureCiv = ensureCiv;

  /* Which species the current tier has let onto the planet. */
  function ensureCivs() {
    var tier = state.tier;
    var keys = ['vessel', 'hive', 'machine'], out = [];
    for (var i = 0; i < keys.length; i++) {
      var spec = SPECIES[keys[i]];
      if (tier < spec.minTier) continue;
      /* An attacked Vessel is still a civilization; a Vessel that was
         never met is not. */
      var f = factionOf(keys[i]) ? repairKind(spec) : ensureCiv(keys[i]);
      if (f) out.push(f);
      if (f && !state.civs[keys[i]]) {
        state.civs[keys[i]] = { factionId: spec.factionId, tick: now(), nests: [] };
      }
      if (f && state.civs[keys[i]] && state.civs[keys[i]].tick === now()) announceArrival(keys[i], f);
    }
    return out;
  }

  function announceArrival(speciesId, f) {
    if (speciesId === 'vessel') {
      letter('A ship in the upper air',
        'Something crossed the sky this morning going too slowly to be falling and too high ' +
        'to be ours. By evening it had put a hull down on the far side of the continent and ' +
        'stopped moving. Nobody has come to the door yet.',
        'neutral');
    } else if (speciesId === 'hive') {
      letter('Grey ground',
        'A caravan came back describing a valley three weeks east where the ground has gone ' +
        'grey and hard and nothing grows. They did not go in. Whatever is doing it was ' +
        'doing it faster at the edges than in the middle.',
        'threat');
    } else {
      letter('Something is counting',
        'Every radio on the colony picked up the same eleven-second pattern last night, ' +
        'repeated exactly, from somewhere above the atmosphere. It is not a message. It is ' +
        'a survey, and we are in it.',
        'threat');
    }
    if (f && f.name) debugLog('announced ' + f.name);
  }

  /* ============================================================
     5. FIRST CONTACT

     One letter, three answers, and the answer is read for the rest of
     the game: it moves the schedule, it decides whether the Vessel
     ever comes back, and it decides how hard the first machine wave
     hits. An unanswered letter resolves to hiding after two days,
     because saying nothing is also an answer.
     ============================================================ */

  var CONTACT_DEADLINE = 2 * TICKS_PER_DAY;

  Aliens.contactPending = function () {
    return state.contactOffered && state.stance === 'none';
  };

  Aliens.contactOptions = function () {
    return [
      { id: 'welcome', label: 'Walk out and meet them',
        detail: 'They learn where you are, and so does everything that is listening to them.' },
      { id: 'hide', label: 'Stay indoors and say nothing',
        detail: 'Safer for a long while. You also get none of what they carry.' },
      { id: 'attack', label: 'Shoot them off the ridge',
        detail: 'No trade, no gifts, and a reputation you cannot put down.' }
    ];
  };

  Aliens.answerContact = function (choice) {
    if (state.stance !== 'none' || !state.contactOffered) return false;
    var g = G();
    var map = g && g.map;
    var colonists = map && map.colonists ? map.colonists() : [];
    var N = sys('Needs'), F = sys('Factions');
    var i;

    if (choice === 'welcome') {
      state.stance = 'welcome';
      state.bias += 0.55;
      if (F && F.adjustGoodwill) F.adjustGoodwill('xenoVessel', 25, 'we came out to meet them');
      for (i = 0; i < colonists.length; i++) {
        if (N && N.addThought) { N.addThought(colonists[i], 'xenoFirstSight'); N.addThought(colonists[i], 'xenoWelcomed'); }
      }
      letter('We walked out',
        'Three of them came down the slope with their hands where we could see them, and ' +
        'one of them had learned about forty words of our language on the way. They will ' +
        'trade. They also went home and told somebody, and the sky has been busier since.',
        'good');
    } else if (choice === 'attack') {
      state.stance = 'attack';
      state.bias += 0.25;
      if (F && F.declareWar) F.declareWar('xenoVessel', 'we fired on their envoys');
      else if (F && F.adjustGoodwill) F.adjustGoodwill('xenoVessel', -160, 'we fired on their envoys');
      for (i = 0; i < colonists.length; i++) {
        if (N && N.addThought) N.addThought(colonists[i], 'xenoShame');
      }
      letter('We fired first',
        'The first shot took the one in front through the chest and it went down without ' +
        'making a sound. The other two picked it up and walked back up the ridge at the same ' +
        'pace they came down it. Nobody is coming to trade with us now.',
        'threat');
    } else {
      state.stance = 'hide';
      state.bias -= 0.35;
      for (i = 0; i < colonists.length; i++) {
        if (N && N.addThought) N.addThought(colonists[i], 'xenoDread');
      }
      letter('We stayed inside',
        'They stood on the ridge for most of a day, then went back the way they came. ' +
        'Nobody fired and nobody spoke. We know nothing more than we did, and neither do they.',
        'neutral');
    }
    state.contactTick = now();
    return true;
  };

  function fireFirstContact(g) {
    if (state.contactOffered) return false;
    var map = g && g.map;
    if (!map || !map.colonists().length) return false;
    state.contactOffered = true;
    state.contactTick = now();
    var at = colonyCentre(map);
    letter('First contact',
      'Three figures are standing on the ridge east of the colony. They are too tall, they ' +
      'are not carrying anything, and they have been there since first light without moving ' +
      'much. One of them is holding something that makes a low sound.\n\n' +
      'You can walk out and meet them, stay inside and let them get bored, or put a rifle on ' +
      'the ridge and end it. Whatever you choose, this is the decision the rest of this ' +
      'colony gets judged by. If nothing is decided in two days, the doors stay shut.',
      'neutral', at);
    return true;
  }

  /* ============================================================
     6. ARTEFACTS, STUDY AND GIFTS

     An artefact is an item you cannot make. It is taken to a xenology
     bench and pulled apart over several days of intellectual work,
     which destroys it and produces schematics - and schematics are
     what the replication recipes eat. The half-finished study lives on
     the artefact Thing, so a save carries it without this file being
     asked.
     ============================================================ */

  var ARTEFACTS = ['xenoCore', 'xenoLens', 'xenoWeave', 'machineCoil'];

  Aliens.artefactIds = function () { return ARTEFACTS.slice(); };
  Aliens.isArtefact = function (defId) { return ARTEFACTS.indexOf(defId) >= 0; };

  var STUDY_WORK = { xenoCore: 5200, xenoLens: 4400, xenoWeave: 3600, machineCoil: 4000 };
  var STUDY_YIELD = { xenoCore: 3, xenoLens: 2, xenoWeave: 2, machineCoil: 2 };

  function studyWorkFor(defId) { return STUDY_WORK[defId] || 4000; }

  function analyserFor(map, pawn) {
    if (!map.byDef) return null;
    var list = map.byDef('xenoAnalyser');
    var best = null, bestD = Infinity;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b.spawned) continue;
      var P = sys('Power');
      if (P && P.isPowered && b.def && b.def.building && b.def.building.powerConsumed > 0 &&
          !P.isPowered(b)) continue;
      if (!Res.canReserve(pawn, T.thing(b), 1)) continue;
      var d = U.distSq(pawn.x, pawn.y, b.x, b.y);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  function finishStudy(pawn, artefactDefId, at) {
    var map = pawn.map;
    var yield_ = STUDY_YIELD[artefactDefId] || 2;
    var skill = pawn.skills && pawn.skills.intellectual ? pawn.skills.intellectual.level : 0;
    if (skill >= 12 && U.chance(0.35)) yield_++;
    map.addItem('xenoSchematic', at.x, at.y, yield_);
    state.studied++;

    /* Understanding one of their parts is worth real progress on
       whatever the colony happens to be working on. */
    var R = sys('Research');
    if (R && R.current && R.current() && R.addProgress) R.addProgress(700, pawn);

    var def = Defs.maybe('thing', artefactDefId);
    letter('Taken apart',
      (def ? U.cap(def.label) : 'The artefact') + ' has been reduced to ' + yield_ + ' ' +
      U.plural(yield_, 'schematic') + ', a box of scrap and eleven pages of notes. ' +
      'It will never be that object again, and now there is a chance of making something ' +
      'like it.',
      'good', at);
  }

  if (Jobs && Jobs.register) {
    Jobs.register('xenoStudy', {
      label: 'study artefact',
      reportString: 'Taking an artefact apart.',
      toils: function () {
        return [
          Toils.custom({
            name: 'claim',
            tick: function (pawn, job) {
              var map = pawn.map;
              if (!map) return 'fail';
              var art = T.resolve(job.targetA, map);
              var bench = T.resolve(job.targetB, map);
              if (!art || !bench || !art.spawned || !bench.spawned) return 'fail';
              if (!Res.reserve(pawn, job.targetA, 1)) return 'fail';
              if (!Res.reserve(pawn, job.targetB, 1)) return 'fail';
              job.state.artefactDefId = art.defId;
              return 'next';
            }
          }),
          Toils.goto('A', { pe: Path ? Path.PE.TOUCH : 1, failIfGone: true }),
          Toils.pickUp('A', function () { return 1; }),
          Toils.goto('B', { pe: Path ? Path.PE.INTERACTION : 3, failIfGone: true }),
          Toils.work({
            skill: 'intellectual',
            amount: function (pawn, job) { return studyWorkFor(job.state.artefactDefId); },
            onTick: function (pawn, job, s) {
              /* Progress belongs to the artefact in the pawn's hands, so
                 a study interrupted at four fifths is still four fifths
                 done tomorrow, and survives a save. */
              if (!pawn.carried) return;
              var total = studyWorkFor(job.state.artefactDefId) || 1;
              pawn.carried.xenoStudy = U.clamp01((s.done || 0) / total);
            },
            onDone: function (pawn, job) {
              var carried = pawn.carried;
              if (carried) {
                if (pawn.dropCarried) pawn.dropCarried();
                else pawn.carried = null;
                if (carried.spawned && pawn.map) pawn.map.destroyThing(carried, 'studied');
                else if (carried.stack !== undefined) carried.stack = 0;
              }
              finishStudy(pawn, job.state.artefactDefId, { x: pawn.x, y: pawn.y });
            }
          })
        ];
      }
    });
  }

  if (WorkGivers && WorkGivers.register) {
    WorkGivers.register({
      id: 'xenoStudy', workType: 'research', order: 20, label: 'study alien artefacts',
      tryGiveJob: function (pawn) {
        var map = pawn && pawn.map;
        if (!map || !map.byDef) return null;
        var bench = analyserFor(map, pawn);
        if (!bench) return null;
        var best = null, bestD = Infinity;
        for (var a = 0; a < ARTEFACTS.length; a++) {
          var list = map.byDef(ARTEFACTS[a]);
          for (var i = 0; i < list.length; i++) {
            var art = list[i];
            if (!art.spawned) continue;
            if (!Res.canReserve(pawn, T.thing(art), 1)) continue;
            if (Path && Path.reachable &&
                !Path.reachable(map, pawn.x, pawn.y, art.x, art.y, { pawn: pawn })) continue;
            var d = U.distSq(pawn.x, pawn.y, art.x, art.y);
            if (d < bestD) { bestD = d; best = art; }
          }
        }
        if (!best) return null;
        return Jobs.make('xenoStudy', T.thing(best), T.thing(bench), {});
      }
    });
  }

  /* ---- gifts, and the drops that come with them ---- */

  function dropSpot(map) {
    var MG = sys('MapGen');
    if (MG && MG.dropPodSpot) {
      var spot = MG.dropPodSpot(map);
      if (spot) return spot;
    }
    var c = colonyCentre(map);
    return freeCellNear(map, c.x + U.randInt(-6, 6), c.y + U.randInt(-6, 6), 12) || c;
  }

  Aliens.dropGift = function (game, opts) {
    game = game || G();
    opts = opts || {};
    var map = game && game.map;
    if (!map || !map.colonists().length) return false;
    var spot = dropSpot(map);
    if (!spot) return false;

    var pool = ARTEFACTS.slice();
    if (state.tier < 3) pool = ['xenoCore', 'xenoLens', 'xenoWeave'];
    var count = opts.count || (state.stance === 'welcome' ? U.randInt(1, 3) : 1);
    var given = [];
    for (var i = 0; i < count; i++) {
      var defId = U.pick(pool);
      map.addItem(defId, spot.x, spot.y, 1);
      given.push(Defs.maybe('thing', defId));
    }
    /* They do not understand what a colony eats, so the medicine comes
       with it whether or not anybody is hurt. */
    if (U.chance(0.55) && Defs.has('thing', 'medicine')) {
      map.addItem('medicine', spot.x, spot.y, U.randInt(4, 12));
    }
    var names = given.map(function (d) { return d ? d.label : 'something'; }).join(', ');
    letter('A gift',
      'A container the size of a barrel came down on a line and the line let go. Inside, ' +
      'packed in a grey foam that turns to dust when you touch it: ' + names + '. There is ' +
      'no note. There has never been a note.',
      'good', spot);
    return true;
  };

  /* ============================================================
     7. THE ONES WHO COME BACK

     A colonist goes missing overnight and is returned a few days
     later, changed. The pawn is rebuilt from the same generation
     inputs rather than stored whole, because a stored pawn is a pawn
     the save file cannot see.
     ============================================================ */

  function snapshotPawn(pawn) {
    var skills = {};
    if (pawn.skills) {
      for (var k in pawn.skills) {
        skills[k] = { level: pawn.skills[k].level, xp: pawn.skills[k].xp, passion: pawn.skills[k].passion };
      }
    }
    return {
      name: pawn.name ? { first: pawn.name.first, nick: pawn.name.nick, last: pawn.name.last } : null,
      kindId: pawn.kindId, gender: pawn.gender, ageYears: pawn.ageYears,
      traits: (pawn.traits || []).slice(),
      backstories: pawn.backstories ? {
        childhood: pawn.backstories.childhood, adulthood: pawn.backstories.adulthood
      } : null,
      skills: skills,
      workPriority: pawn.workPriority ? JSON.parse(JSON.stringify(pawn.workPriority)) : null
    };
  }

  Aliens.abduct = function (game) {
    game = game || G();
    var map = game && game.map;
    if (!map) return false;
    var pool = map.colonists().filter(function (p) {
      return !p.dead && !p.downed && !p.drafted && !p.prisoner;
    });
    if (pool.length < 2) return false;          /* never the last colonist */
    var victim = U.pick(pool);
    if (!victim) return false;

    var snap = snapshotPawn(victim);
    snap.taken = now();
    snap.returnTick = now() + Math.round(U.randRange(2.5, 6) * TICKS_PER_DAY);
    state.abductions.push(snap);

    var at = { x: victim.x, y: victim.y };
    if (victim.job && victim.endJob) victim.endJob('interrupted');
    if (Res && Res.releaseAll) Res.releaseAll(victim);
    map.removePawn(victim);

    var N = sys('Needs');
    var rest = map.colonists();
    for (var i = 0; i < rest.length; i++) {
      if (N && N.addThought) N.addThought(rest[i], 'xenoTaken');
    }
    var who = victim.name ? (victim.name.nick || victim.name.first) : 'somebody';
    letter('Taken',
      who + ' did not come in for the night meal. The door was open, the lamp was still lit, ' +
      'and there is a circle of flattened grass forty paces out with nothing in it. ' +
      'Nobody heard anything.',
      'threat', at);
    return true;
  };

  function returnAbductee(game, rec) {
    var map = game && game.map;
    var MG = sys('MapGen');
    if (!map || !MG || !MG.makePawn) return false;
    var edge = U.pick(['n', 'e', 's', 'w']);
    var cells = edgeCells(map, edge);
    if (!cells.length) return false;
    var at = U.pick(cells);
    var cell = freeCellNear(map, at.x, at.y, 8) || at;

    var pawn = MG.makePawn(rec.kindId || 'colonist', 'player', {
      x: cell.x, y: cell.y, map: map,
      gender: rec.gender, ageYears: rec.ageYears,
      traits: rec.traits, backstories: rec.backstories, skills: rec.skills,
      name: rec.name, gear: false
    });
    if (!pawn) return false;
    if (rec.workPriority) pawn.workPriority = rec.workPriority;
    if (!map.addPawn(pawn, cell.x, cell.y)) return false;
    pawn.fx = pawn.x; pawn.fy = pawn.y;

    /* Changed, and not only for the worse: better eyes, a clearer head
       and something in the shoulder that aches when it rains. */
    var H = sys('Health');
    if (H && H.addHediff) H.addHediff(pawn, 'xenoGraft', 1);
    if (pawn.skills && pawn.skills.intellectual) pawn.skills.intellectual.level =
      U.clamp(pawn.skills.intellectual.level + U.randInt(1, 3), 0, 20);

    var N = sys('Needs');
    var everyone = map.colonists();
    for (var i = 0; i < everyone.length; i++) {
      if (!N || !N.addThought) break;
      N.addThought(everyone[i], everyone[i] === pawn ? 'xenoChanged' : 'xenoReturned');
    }
    if (N && N.addThought) N.addThought(pawn, 'xenoChanged');

    var who = pawn.name ? (pawn.name.nick || pawn.name.first) : 'they';
    var days = Math.max(1, Math.round((now() - (rec.taken || now())) / TICKS_PER_DAY));
    letter('Returned',
      who + ' walked in out of the dark on the ' + days + 'th day, barefoot, unhurt and ' +
      'perfectly calm. There is a ring of grey tissue below the collarbone that was not ' +
      'there before. ' + who + ' does not remember anything and does not seem troubled by ' +
      'that, which is the part that has everyone else quiet.',
      'neutral', { x: pawn.x, y: pawn.y });
    return true;
  }

  function tickAbductions(game) {
    for (var i = state.abductions.length - 1; i >= 0; i--) {
      var rec = state.abductions[i];
      if (now() < rec.returnTick) continue;
      state.abductions.splice(i, 1);
      returnAbductee(game, rec);
    }
  }

  /* ============================================================
     8. THE HIVE

     It does not raid. It takes one world tile at a time, and the
     number of tiles it holds is the only number that matters: it sets
     how often it reaches your map, how many come when it does, and
     whether a node grows on your own ground.
     ============================================================ */

  var HIVE_CAP = 14;

  function hiveNests() {
    var W = sys('World');
    if (!W || !W.settlementsOf) return [];
    return W.settlementsOf('xenoHive');
  }

  Aliens.hiveNests = hiveNests;
  Aliens.hiveSize = function () { return hiveNests().length; };

  function hiveSpreadInterval() {
    /* Four days at the start, down to a day and a half once it is
       established and the tier has risen with it. */
    var base = 4.0 - state.tier * 0.4 - Math.min(2, hiveNests().length * 0.12);
    return Math.round(Math.max(1.4, base) * TICKS_PER_DAY);
  }

  function coldResists(W, tile) {
    if (!W || !W.biomeOf) return false;
    var b = W.biomeOf(tile);
    return b === 'tundra' || b === 'ocean';
  }

  function spreadHive(game) {
    var W = sys('World');
    var nests = hiveNests();
    if (!W || !W.neighbours || !W.placeSettlement) return false;
    if (!nests.length) return false;
    if (nests.length >= HIVE_CAP) return false;

    /* It grows from its edge, and it prefers warm ground. */
    var options = [];
    for (var i = 0; i < nests.length; i++) {
      var ns = W.neighbours(nests[i].tile) || [];
      for (var j = 0; j < ns.length; j++) {
        var t = ns[j];
        if (W.isOcean && W.isOcean(t)) continue;
        if (W.settlementAt && W.settlementAt(t)) continue;
        if (coldResists(W, t) && U.chance(0.75)) continue;
        options.push(t);
      }
    }
    if (!options.length) return false;

    var colony = W.colonyTile || 0;
    var tile = U.pickWeighted(options, function (t) {
      /* Nothing draws it, but it fills toward open ground, and open
         ground eventually means yours. */
      var d = W.distance ? W.distance(t, colony) : 10;
      return 1 + 6 / (1 + d);
    });
    var site = W.placeSettlement(tile, 'xenoHive', 'hiveNest', null);
    if (!site) return false;

    var f = factionOf('hive');
    if (f) f.settlements.push(site.id);
    state.hive.spread++;

    var dist = W.distance ? W.distance(tile, colony) : 99;
    if (dist <= 6 && now() - state.hive.warned > 3 * TICKS_PER_DAY) {
      state.hive.warned = now();
      letter('It is closer',
        'The grey ground has taken another valley, and it is now ' + dist + ' days\' walk ' +
        'from here at a caravan\'s pace. Nothing that went that way this season has come ' +
        'back with anything to sell.',
        'threat');
    }
    return true;
  }

  Aliens.noteNestLost = function () {
    state.hive.lost++;
    /* Burning a nest out buys real time: the next growth is pushed
       back rather than merely cancelled. */
    state.hive.nextSpreadTick = now() + Math.round(2.5 * TICKS_PER_DAY);
    return state.hive.lost;
  };

  function hiveSwarmSize(points) {
    var nests = hiveNests().length;
    var n = Math.round(4 + nests * 1.6 + points / 90);
    return U.clamp(n, 4, 34);
  }

  function spawnHiveUnit(map, kindId, cell) {
    var MG = sys('MapGen');
    if (!MG || !MG.makePawn) return null;
    var p = MG.makePawn(kindId, 'xenoHive', { x: cell.x, y: cell.y, map: map });
    if (!p) return null;
    p.faction = 'xenoHive';
    if (!map.addPawn(p, cell.x, cell.y)) return null;
    p.fx = p.x; p.fy = p.y;
    var A = sys('Animals');
    /* The hive has no second thoughts, and the manhunter clock is what
       says so in the only vocabulary animals.js has. */
    if (A && A.makeManhunter) A.makeManhunter(p, { ticks: 400000 });
    return p;
  }

  Aliens.hiveIncursion = function (game, points) {
    game = game || G();
    var map = game && game.map;
    if (!map || !map.colonists().length) return false;
    if (!hiveNests().length) return false;

    var n = hiveSwarmSize(points || 0);
    var side = U.pick(['n', 'e', 's', 'w']);
    var cells = edgeCells(map, side);
    if (!cells.length) return false;
    var anchor = U.pick(cells);

    var warriors = Math.max(1, Math.round(n * 0.25));
    var spawned = 0, i;
    for (i = 0; i < n; i++) {
      var cell = freeCellNear(map, anchor.x + U.randInt(-4, 4), anchor.y + U.randInt(-4, 4), 10);
      if (!cell) continue;
      var kindId = i < warriors ? 'hiveWarrior' : 'hiveDrone';
      if (spawnHiveUnit(map, kindId, cell)) spawned++;
    }
    if (hiveNests().length >= 8 && state.tier >= 4 && U.chance(0.35)) {
      var qc = freeCellNear(map, anchor.x, anchor.y, 12);
      if (qc) spawnHiveUnit(map, 'hiveQueen', qc);
    }
    if (!spawned) return false;

    /* Once it has real ground it stops sending and starts staying. */
    if (hiveNests().length >= 6 && U.chance(0.4)) plantHiveNode(map, anchor);

    letter('The swarm',
      spawned + ' of them came over the ' + sideName(side) + ' edge in one moving mass and ' +
      'did not slow down at the tree line. They do not take cover and they do not stop when ' +
      'the one in front goes down.',
      'threat', anchor);
    return true;
  };

  function sideName(side) {
    return side === 'n' ? 'north' : side === 's' ? 'south' : side === 'e' ? 'east' : 'west';
  }

  function plantHiveNode(map, near) {
    var spot = freeCellNear(map, near.x + U.randInt(-8, 8), near.y + U.randInt(-8, 8), 14);
    if (!spot || !areaClear(map, spot.x, spot.y, 1, 1)) return null;
    var node = map.spawnThing('hiveNode', spot.x, spot.y, { faction: 'xenoHive' });
    if (!node) return null;
    node.hiveNextSpawn = now() + Math.round(1.2 * TICKS_PER_DAY);
    letter('It has put something down',
      'A mound of resin the size of a cart has hardened on the edge of the map overnight, ' +
      'and it is breathing. Things are coming out of it. It will keep doing that until ' +
      'somebody takes it apart.',
      'threat', spot);
    return node;
  }

  function tickHiveNodes(game) {
    var map = game && game.map;
    if (!map || !map.byDef) return;
    var nodes = map.byDef('hiveNode');
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (!node.spawned) continue;
      if (!node.hiveNextSpawn) node.hiveNextSpawn = now() + TICKS_PER_DAY;
      if (now() < node.hiveNextSpawn) continue;
      node.hiveNextSpawn = now() + Math.round(U.randRange(0.8, 1.6) * TICKS_PER_DAY);
      var n = U.randInt(2, 4);
      for (var k = 0; k < n; k++) {
        var cell = freeCellNear(map, node.x + U.randInt(-3, 3), node.y + U.randInt(-3, 3), 6);
        if (cell) spawnHiveUnit(map, U.chance(0.25) ? 'hiveWarrior' : 'hiveDrone', cell);
      }
      msg('The hive node has hatched another brood.', 'threat', node);
    }
  }

  /* Two things have to be kept true about anything of the hive's that is
     standing on the map, including the ones the storyteller sent by
     picking the hive as the night's raiders: its manhunter clock must
     not run down, and it must not be carrying a shotgun. events.js arms
     whatever it spawns, which is correct for people and absurd for a
     drone, so the kit is taken back off - it was conjured for the raid
     and belongs to nobody. */
  function disarmHive(map, pawn) {
    var i, thing;
    if (pawn.equipment) {
      thing = pawn.dropEquipment ? pawn.dropEquipment() : null;
      if (thing && thing.spawned) map.destroyThing(thing, 'never theirs');
    }
    for (i = (pawn.apparel || []).length - 1; i >= 0; i--) {
      thing = pawn.removeApparel ? pawn.removeApparel(pawn.apparel[i]) : null;
      if (thing && thing.spawned) map.destroyThing(thing, 'never theirs');
      else if (!thing) pawn.apparel.splice(i, 1);
    }
  }

  function topUpHiveMinds(map) {
    var A = sys('Animals');
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (p.dead || p.faction !== 'xenoHive') continue;
      if (p.equipment || (p.apparel && p.apparel.length)) disarmHive(map, p);
      if (A && A.makeManhunter && A.isManhunter && !A.isManhunter(p)) {
        A.makeManhunter(p, { ticks: 400000 });
      }
    }
  }

  /* ============================================================
     9. THE MACHINES

     A probe first. Then waves, and each wave is built out of what the
     last one learned. The learning is honest: while a wave is on the
     map this file samples what is actually being used against it -
     turrets that are shooting, rifles at range, colonists in melee,
     walls in the way - and the heaviest of those is what the next wave
     is designed to beat.
     ============================================================ */

  var WAVE_GAP = Math.round(2.2 * TICKS_PER_DAY);

  function machineCounters() { return state.machine.counters; }

  function blankObservation() {
    return { turret: 0, ranged: 0, melee: 0, wall: 0, samples: 0 };
  }

  function observeDefences(map, members) {
    var obs = state.machine.active && state.machine.active.seen;
    if (!obs || !members.length) return;
    obs.samples++;
    var P = sys('Power');
    var i, j;

    for (i = 0; i < members.length; i++) {
      var m = members[i];
      if (!m || m.dead) continue;

      var turrets = map.byDef ? map.byDef('turret') : [];
      for (j = 0; j < turrets.length; j++) {
        var t = turrets[j];
        if (!t.spawned || t.faction !== 'player') continue;
        if (P && P.isPowered && !P.isPowered(t)) continue;
        if (U.dist(t.x, t.y, m.x, m.y) <= 30) { obs.turret += 1; break; }
      }

      var colonists = map.colonists();
      for (j = 0; j < colonists.length; j++) {
        var c = colonists[j];
        if (c.dead || c.downed) continue;
        var d = U.dist(c.x, c.y, m.x, m.y);
        if (d > 32) continue;
        var w = c.equipment && c.equipment.def && c.equipment.def.weapon;
        if (w && w.ranged && d <= w.range) obs.ranged += 1;
        else if (d <= 3) obs.melee += 1;
      }

      /* Anything of the colony's standing between this unit and the
         people it is walking at counts as fortification. */
      var target = colonyPoint(map, m.x, m.y);
      if (Path && Path.reachable &&
          !Path.reachable(map, m.x, m.y, target.x, target.y, { pawn: m })) obs.wall += 2;
      else if (map.buildingAt) {
        var mx = Math.round((m.x + target.x) / 2), my = Math.round((m.y + target.y) / 2);
        var b = map.inBounds(mx, my) ? map.buildingAt(mx, my) : null;
        if (b && b.faction === 'player' && b.def && b.def.fillPercent >= 1) obs.wall += 1;
      }
    }
  }

  function digestObservation() {
    var wave = state.machine.active;
    if (!wave || !wave.seen) return null;
    var obs = wave.seen;
    var best = null, bestV = 0;
    var keys = ['turret', 'ranged', 'melee', 'wall'];
    for (var i = 0; i < keys.length; i++) {
      if (obs[keys[i]] > bestV) { bestV = obs[keys[i]]; best = keys[i]; }
    }
    if (!best || bestV < 3) return null;
    var c = machineCounters();
    if (best === 'turret') c.breach = U.clamp(c.breach + 1, 0, 4);
    else if (best === 'ranged') c.armour = U.clamp(c.armour + 1, 0, 4);
    else if (best === 'melee') c.standoff = U.clamp(c.standoff + 1, 0, 4);
    else c.pods = U.clamp(c.pods + 1, 0, 4);
    return best;
  }

  var ADAPTATION_TEXT = {
    breach: 'The new ones walk straight at the gun emplacements and ignore everything else.',
    armour: 'These are plated. The first volley went into them and they kept coming.',
    standoff: 'They have stopped closing. They stand at the edge of sight and shoot.',
    pods: 'They did not come to the wall this time. They came down inside it.'
  };

  function waveRoster(points) {
    var c = machineCounters();
    var budget = Math.max(90, points || 120) * (1 + state.machine.waves * 0.12);
    var mix = [];
    var soldiers = Math.max(2, Math.round(budget / 170));
    for (var i = 0; i < soldiers; i++) mix.push('machineSoldier');
    var breachers = Math.min(6, c.breach + (c.pods > 0 ? 1 : 0));
    for (i = 0; i < breachers; i++) mix.push('machineBreacher');
    /* Armour answers rifles; so does refusing to walk into their
       range at all, which is what a lance unit is for. */
    var lances = Math.min(6, c.standoff + Math.ceil(c.armour / 2));
    for (i = 0; i < lances; i++) mix.push('machineLance');
    return {
      kinds: mix,
      armoured: c.armour > 0,
      pods: c.pods >= 2,
      breach: c.breach > 0,
      standoff: c.standoff > 0
    };
  }

  function spawnMachine(map, kindId, cell, points, armoured) {
    var MG = sys('MapGen');
    if (!MG || !MG.makePawn) return null;
    var p = MG.makePawn(kindId, 'xenoMachine', {
      x: cell.x, y: cell.y, map: map, gear: true
    });
    if (!p) return null;
    p.faction = 'xenoMachine';
    p.canBashDoors = true;
    if (!map.addPawn(p, cell.x, cell.y)) return null;
    p.fx = p.x; p.fy = p.y;
    if (armoured) {
      var extras = ['armorVest', 'helmet'];
      for (var i = 0; i < extras.length; i++) {
        if (!Defs.has('thing', extras[i])) continue;
        var worn = map.spawnThing(extras[i], p.x, p.y);
        if (worn && p.wear) p.wear(worn);
      }
    }
    return p;
  }

  Aliens.machineProbe = function (game) {
    game = game || G();
    var map = game && game.map;
    if (!map || !map.colonists().length) return false;
    var side = U.pick(['n', 'e', 's', 'w']);
    var cells = edgeCells(map, side);
    if (!cells.length) return false;
    var anchor = U.pick(cells);
    var made = 0;
    for (var i = 0; i < U.randInt(1, 3); i++) {
      var cell = freeCellNear(map, anchor.x + U.randInt(-3, 3), anchor.y + U.randInt(-3, 3), 8);
      if (cell && spawnMachine(map, 'machineProbe', cell, 60, false)) made++;
    }
    if (!made) return false;
    state.machine.probed = true;
    startWave(game, 'probe', made, anchor);
    letter('A probe',
      'Something the size of a dog walked out of the treeline on three legs, stood still for ' +
      'eleven seconds looking at the colony, and then began a slow circuit of it. It is not ' +
      'in a hurry. It is measuring.',
      'threat', anchor);
    return true;
  };

  function startWave(game, mode, count, anchor) {
    state.machine.active = {
      mode: mode, count: count, startTick: now(), seen: blankObservation(),
      objX: anchor ? anchor.x : 0, objY: anchor ? anchor.y : 0, objTick: 0,
      breach: mode === 'breach', standoff: false
    };
    state.machine.nextWaveTick = now() + WAVE_GAP;
  }

  Aliens.machineWave = function (game, points) {
    game = game || G();
    var map = game && game.map;
    if (!map || !map.colonists().length) return false;
    var fleet = factionOf('machine');
    if (!fleet || !fleet.hostile) return false;

    var roster = waveRoster(points);
    if (!roster.kinds.length) return false;

    var anchors = [];
    if (roster.pods) {
      var spot = dropSpot(map);
      if (spot) anchors.push(spot);
    }
    if (!anchors.length) {
      var side = U.pick(['n', 'e', 's', 'w']);
      var cells = edgeCells(map, side);
      if (!cells.length) return false;
      anchors.push(U.pick(cells));
      for (var e = 1; e < Math.ceil(roster.kinds.length / 4) && cells.length; e++) {
        anchors.push(U.pick(cells));
      }
    }

    var spawned = 0, first = null;
    for (var i = 0; i < roster.kinds.length; i++) {
      var anchor = anchors[i % anchors.length];
      var cell = freeCellNear(map, anchor.x + U.randInt(-3, 3), anchor.y + U.randInt(-3, 3), 9);
      if (!cell) continue;
      var p = spawnMachine(map, roster.kinds[i], cell, points, roster.armoured);
      if (!p) continue;
      if (!first) first = p;
      spawned++;
    }
    if (!spawned) return false;

    state.machine.waves++;
    startWave(game, roster.breach ? 'breach' : 'assault', spawned, first);
    state.machine.active.standoff = !!roster.standoff;

    var adapted = state.machine.lastAdaptation;
    var extra = adapted && ADAPTATION_TEXT[adapted] ? ' ' + ADAPTATION_TEXT[adapted] : '';
    letter('Incursion',
      spawned + ' machines are on the map. They landed in formation, they are not talking ' +
      'to each other, and they are already walking.' + extra,
      'threat', first);
    return true;
  };

  /* ---- driving the waves ---- */

  function machinesOnMap(map) {
    var out = [];
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (!p.dead && p.faction === 'xenoMachine') out.push(p);
    }
    return out;
  }

  function breachTarget(map, pawn) {
    var ids = ['turret', 'door', 'wall', 'sandbags'];
    var best = null, bestD = 900;
    for (var i = 0; i < ids.length; i++) {
      if (!Defs.has('thing', ids[i]) || !map.byDef) continue;
      var list = map.byDef(ids[i]);
      for (var j = 0; j < list.length; j++) {
        var b = list[j];
        if (!b.spawned || b.faction !== 'player') continue;
        var d = U.distSq(pawn.x, pawn.y, b.x, b.y);
        if (d < bestD) { bestD = d; best = b; }
      }
      if (best && ids[i] === 'turret') return best;
    }
    return best;
  }

  function driveMachine(game, map, wave, pawn) {
    if (pawn.downed || pawn.mentalState) return;
    if (fightingAlready(pawn)) return;
    var C = sys('Combat');
    if (!C || !C.findTarget) return;

    var foe = C.findTarget(pawn, {
      preferHumans: true,
      includeBuildings: wave.breach,
      maxDist: wave.standoff ? 34 : 30
    });
    if (foe) { attackJob(pawn, foe); return; }

    /* A breaching wave has a different idea of what a target is: the
       gun that killed the last wave comes down before anything else. */
    if (wave.breach) {
      var structure = breachTarget(map, pawn);
      if (structure) { attackJob(pawn, structure); return; }
    }

    if (now() - wave.objTick > 1500 || (!wave.objX && !wave.objY)) {
      var obj = colonyPoint(map, pawn.x, pawn.y);
      wave.objX = obj.x; wave.objY = obj.y; wave.objTick = now();
    }

    /* Standing off means holding at the edge of their reach instead of
       walking into a doorway full of people with knives. */
    if (wave.standoff) {
      var range = 18;
      var d = U.dist(pawn.x, pawn.y, wave.objX, wave.objY);
      if (d <= range) { holdPosition(pawn); return; }
    }

    var reachable = true;
    if (Path && Path.reachable) {
      reachable = Path.reachable(map, pawn.x, pawn.y, wave.objX, wave.objY, { pawn: pawn });
    }
    if (!reachable) {
      wave.breach = true;
      var wall = breachTarget(map, pawn);
      if (wall) { attackJob(pawn, wall); return; }
      holdPosition(pawn);
      return;
    }
    keepWalking(pawn, wave.objX, wave.objY, Path ? Path.PE.TOUCH : 1);
  }

  function tickMachines(game) {
    var map = game && game.map;
    if (!map) return;
    var members = machinesOnMap(map);
    var wave = state.machine.active;

    if (!members.length) {
      if (wave) {
        var learned = digestObservation();
        state.machine.lastAdaptation = learned;
        state.machine.active = null;
        if (learned) {
          letter('They were watching too',
            'The last of them went down and stopped. Before it did, the whole group spent ' +
            'more time looking at your defences than at your people. Whatever comes next ' +
            'will have been built around what it saw.',
            'threat');
        }
      }
      return;
    }
    if (!wave) {
      startWave(game, 'assault', members.length, members[0]);
      wave = state.machine.active;
    }
    observeDefences(map, members);
    for (var i = 0; i < members.length; i++) driveMachine(game, map, wave, members[i]);
  }

  Aliens.adaptation = function () {
    var c = machineCounters();
    return {
      armour: c.armour, standoff: c.standoff, breach: c.breach, pods: c.pods,
      waves: state.machine.waves, last: state.machine.lastAdaptation || null
    };
  };

  /* ============================================================
     10. THE INVASION

     Tier five, once. Not a raid: a landing, with spires that keep
     producing waves for as long as they stand. Two ways out, and
     killing what is in front of you is not either of them on its own:
     bring the spires down, or build the override beacon, power it and
     hold it for two days while they try to stop you.
     ============================================================ */

  var OVERRIDE_DAYS = 2;
  var SPIRE_WAVE_GAP = Math.round(1.4 * TICKS_PER_DAY);

  Aliens.invasion = function () { return state.invasion; };

  Aliens.beginInvasion = function (game) {
    game = game || G();
    var map = game && game.map;
    if (!map || state.invasion || !map.colonists().length) return false;

    var side = U.pick(['n', 'e', 's', 'w']);
    var cells = edgeCells(map, side);
    if (!cells.length) return false;
    var anchor = U.pick(cells);

    var spires = [];
    for (var i = 0; i < 2; i++) {
      var spot = null;
      for (var attempt = 0; attempt < 12 && !spot; attempt++) {
        var cand = freeCellNear(map, anchor.x + U.randInt(-10, 10), anchor.y + U.randInt(-6, 6), 16);
        if (cand && areaClear(map, cand.x, cand.y, 2, 2)) spot = cand;
      }
      if (!spot) continue;
      var spire = map.spawnThing('machineSpire', spot.x, spot.y, { faction: 'xenoMachine' });
      if (spire) { spire.spireNextWave = now() + SPIRE_WAVE_GAP; spires.push(spire.id); }
    }
    if (!spires.length) return false;

    state.invasion = {
      phase: 'landed', startTick: now(), waves: 0,
      spireIds: spires, side: side, overrideTicks: 0, resolved: null
    };
    ensureCiv('machine');
    Aliens.machineWave(game, 420);

    letter('Landing',
      'Two towers came down on the ' + sideName(side) + ' edge inside forty seconds and dug ' +
      'their legs into the rock. They are not ships. They are doors, and things are already ' +
      'walking out of them.\n\n' +
      'Killing what is on the ground will not end this: the towers will simply make more. ' +
      'Bring the towers down, or build an override beacon, give it power, and hold it for ' +
      'two days while it tells their fleet that none of this was authorised.',
      'threat', { x: map.xOf(0), y: 0 });
    return true;
  };

  function liveSpires(map) {
    var inv = state.invasion;
    var out = [];
    if (!inv || !map.thing) return out;
    for (var i = 0; i < inv.spireIds.length; i++) {
      var s = map.thing(inv.spireIds[i]);
      if (s && s.spawned) out.push(s);
    }
    return out;
  }

  function beaconProgress(map) {
    if (!map.byDef) return null;
    var list = map.byDef('xenoBeacon');
    var P = sys('Power');
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b.spawned || b.faction !== 'player') continue;
      if (P && P.isPowered && !P.isPowered(b)) continue;
      return b;
    }
    return null;
  }

  function endInvasion(game, how) {
    var map = game && game.map;
    var inv = state.invasion;
    if (!inv || !map) return;
    inv.phase = 'over';
    inv.resolved = how;

    if (how === 'override') {
      /* Everything of theirs on the map stops where it stands, and the
         fleet stops answering. That is the win, and it is not a
         massacre. */
      var gone = 0, i;
      for (i = map.pawns.length - 1; i >= 0; i--) {
        var p = map.pawns[i];
        if (p.dead || p.faction !== 'xenoMachine') continue;
        map.removePawn(p);
        gone++;
      }
      var spires = liveSpires(map);
      for (i = 0; i < spires.length; i++) map.destroyThing(spires[i], 'override');

      var F = sys('Factions');
      var f = factionOf('machine');
      if (f) {
        f.permanentEnemy = false;
        f.hostile = false;
        f.goodwill = 0;
        if (F && F.invalidateRelations) F.invalidateRelations();
        setRelations('xenoMachine', false);
      }
      var N = sys('Needs');
      var colonists = map.colonists();
      for (i = 0; i < colonists.length; i++) {
        if (N && N.addThought) N.addThought(colonists[i], 'xenoOverride');
      }
      letter('Authorisation withdrawn',
        'The beacon finished its sequence at twenty past four in the morning and every ' +
        'machine on the map stopped mid-stride. ' + gone + ' of them are standing in the ' +
        'fields like fence posts. The towers folded their legs and sank. Nothing has come ' +
        'out of the sky since.',
        'good');
    } else {
      letter('The towers are down',
        'The last spire came apart under sustained fire and what was left of it burned for ' +
        'six hours. Nothing new has landed. There is a great deal of scrap out there and ' +
        'nobody wants to be the one to walk out and collect it.',
        'good');
    }
    state.machine.active = null;
  }

  function tickInvasion(game) {
    var inv = state.invasion;
    var map = game && game.map;
    if (!inv || !map || inv.phase === 'over') return;

    var spires = liveSpires(map);
    if (!spires.length) { endInvasion(game, 'spires'); return; }

    var beacon = beaconProgress(map);
    if (beacon) {
      inv.overrideTicks += SLOW;
      var need = OVERRIDE_DAYS * TICKS_PER_DAY;
      beacon.overrideProgress = U.clamp01(inv.overrideTicks / need);
      if (inv.overrideTicks === SLOW) {
        letter('The beacon is transmitting',
          'The dish came up to power and the capacitor bank settled into a hum you can feel ' +
          'in the floor. Two days. Keep the power on and keep them off it.',
          'good', beacon);
      }
      if (inv.overrideTicks >= need) { endInvasion(game, 'override'); return; }
    } else if (inv.overrideTicks > 0) {
      /* Lose the beacon or lose its power and the sequence rots rather
         than resetting: a brownout costs you hours, not the war. */
      inv.overrideTicks = Math.max(0, inv.overrideTicks - SLOW * 3);
    }

    for (var i = 0; i < spires.length; i++) {
      var spire = spires[i];
      if (!spire.spireNextWave) spire.spireNextWave = now() + SPIRE_WAVE_GAP;
      if (now() < spire.spireNextWave) continue;
      spire.spireNextWave = now() + SPIRE_WAVE_GAP + U.randInt(0, 12000);
      inv.waves++;
      var points = 300 + inv.waves * 90;
      var roster = waveRoster(points);
      var spawned = 0;
      for (var k = 0; k < roster.kinds.length; k++) {
        var cell = freeCellNear(map, spire.x + U.randInt(-4, 4), spire.y + U.randInt(-4, 4), 10);
        if (!cell) continue;
        if (spawnMachine(map, roster.kinds[k], cell, points, roster.armoured)) spawned++;
      }
      if (spawned) {
        if (!state.machine.active) startWave(game, roster.breach ? 'breach' : 'assault', spawned, spire);
        msg(spawned + ' more walked out of a spire.', 'threat', spire);
      }
    }
  }

  Aliens.invasionSummary = function () {
    var inv = state.invasion;
    var g = G();
    var map = g && g.map;
    if (!inv) return null;
    return {
      phase: inv.phase,
      waves: inv.waves,
      spires: map ? liveSpires(map).length : 0,
      overrideDays: inv.overrideTicks / TICKS_PER_DAY,
      overrideNeeded: OVERRIDE_DAYS,
      resolved: inv.resolved
    };
  };

  /* ============================================================
     11. INCIDENTS

     events.js loads below this file, so these are registered on the
     first tick. Every one of them is gated on the tier, and the
     storyteller keeps its own pacing: nothing here schedules itself.
     ============================================================ */

  function tierAtLeast(n) { return state.tier >= n; }

  function ensureIncidents() {
    if (state.incidentsReady) return;
    var I = sys('Incidents');
    if (!I || !I.register) return;
    state.incidentsReady = true;

    I.register({
      id: 'alienFirstContact', label: 'first contact', category: 'misc',
      minDay: CONTACT_DAY,
      weight: function () { return (tierAtLeast(1) && !state.contactOffered) ? 14 : 0; },
      fire: function (g) { return fireFirstContact(g); }
    });

    I.register({
      id: 'alienTraderArrival', label: 'a Vessel trader', category: 'good',
      minDay: CONTACT_DAY,
      weight: function () {
        if (!tierAtLeast(1) || state.stance === 'attack') return 0;
        if (!factionOf('vessel')) return 0;
        return state.stance === 'welcome' ? 2.2 : (state.stance === 'hide' ? 0.5 : 1);
      },
      fire: function (g) { return Aliens.vesselTrader(g); }
    });

    I.register({
      id: 'alienGift', label: 'a gift from the Vessel', category: 'good',
      minDay: CONTACT_DAY,
      weight: function () {
        if (!tierAtLeast(1) || state.stance === 'attack' || state.stance === 'none') return 0;
        return state.stance === 'welcome' ? 1.3 : 0.4;
      },
      fire: function (g) { return Aliens.dropGift(g); }
    });

    I.register({
      id: 'alienAbduction', label: 'somebody is taken', category: 'threatSmall',
      minDay: CONTACT_DAY,
      weight: function () { return tierAtLeast(2) ? 0.7 : 0; },
      fire: function (g) { return Aliens.abduct(g); }
    });

    I.register({
      id: 'hiveIncursion', label: 'a hive swarm', category: 'threatBig',
      minDay: CONTACT_DAY,
      weight: function () {
        if (!tierAtLeast(2) || !hiveNests().length) return 0;
        return 0.8 + hiveNests().length * 0.22;
      },
      fire: function (g, points) { return Aliens.hiveIncursion(g, points); }
    });

    I.register({
      id: 'machineProbe', label: 'a machine probe', category: 'threatSmall',
      minDay: CONTACT_DAY,
      weight: function () { return (tierAtLeast(3) && !state.machine.probed) ? 9 : 0; },
      fire: function (g) { return Aliens.machineProbe(g); }
    });

    I.register({
      id: 'machineIncursion', label: 'a machine incursion', category: 'threatBig',
      minDay: CONTACT_DAY,
      weight: function () {
        if (!tierAtLeast(3) || !state.machine.probed) return 0;
        if (state.invasion && state.invasion.phase !== 'over') return 0;
        if (state.machine.active) return 0;
        if (now() < state.machine.nextWaveTick) return 0;
        /* A fleet that has been told to go home does not come back. */
        var f = factionOf('machine');
        if (!f || !f.hostile) return 0;
        return 1.1 + state.tier * 0.35;
      },
      fire: function (g, points) { return Aliens.machineWave(g, points); }
    });

    I.register({
      id: 'alienInvasion', label: 'the landing', category: 'threatBig',
      minDay: CONTACT_DAY,
      weight: function () {
        if (state.tier < 5 || state.invasion) return 0;
        return 12;
      },
      fire: function (g) { return Aliens.beginInvasion(g); }
    });
  }

  /* ---- the Vessel's counter ---- */

  Aliens.vesselTrader = function (game) {
    game = game || G();
    var Trade = sys('Trade');
    var f = factionOf('vessel');
    if (!Trade || !Trade.arrivingTrader || !f || f.hostile) return false;
    var visit = Trade.arrivingTrader(game, 'xenoVessel');
    if (!visit) return false;

    /* What makes them worth meeting: things nobody on this planet can
       build, at a price nobody on this planet wants to pay. */
    var offer = ARTEFACTS.slice();
    if (state.tier >= 2) offer.push('xenoSchematic');
    var added = 0;
    for (var i = 0; i < offer.length; i++) {
      if (!U.chance(state.stance === 'welcome' ? 0.7 : 0.45)) continue;
      var defId = offer[i];
      var def = Defs.maybe('thing', defId);
      if (!def) continue;
      var count = defId === 'xenoSchematic' ? U.randInt(1, 3) : 1;
      var price = Math.round((def.marketValue || 500) * U.randRange(1.8, 2.8));
      visit.stock.push({ defId: defId, count: count, price: price });
      added++;
    }
    if (added) {
      msg('The Vessel trader is carrying ' + added + ' things nobody here can make.', 'good',
        { x: visit.standX, y: visit.standY });
    }
    return true;
  };

  /* ============================================================
     12. THE TICK

     game.js calls this on its 500-tick beat, which is the right clock
     for everything in here: nothing an alien does happens inside a
     second.
     ============================================================ */

  function detectNewGame(game) {
    /* A new colony rewinds the clock, and nothing calls Aliens.reset
       for us. A tick that has gone backwards by a day is the only
       reliable signal that this is a different run. */
    if (game.tick + TICKS_PER_DAY < state.lastSeenTick) Aliens.reset();
    state.lastSeenTick = game.tick;
  }

  /* A save that came back without this file's own state still has the
     civilizations, the nests and the artefacts, because those live
     where a save file can see them. Rebuild the rest from them. */
  function ensureState() {
    var keys = ['vessel', 'hive', 'machine'];
    for (var i = 0; i < keys.length; i++) {
      var f = factionOf(keys[i]);
      if (!f) continue;
      repairKind(SPECIES[keys[i]]);
      if (!state.civs[keys[i]]) {
        state.civs[keys[i]] = { factionId: f.id, tick: 0, nests: [] };
        if (state.peak < SPECIES[keys[i]].minTier) state.peak = SPECIES[keys[i]].minTier;
        if (keys[i] !== 'vessel' && state.stance === 'none') state.stance = 'hide';
        if (state.stance !== 'none') state.contactOffered = true;
      }
    }
  }

  function tickDread(game) {
    if (state.tier < 2) return;
    if ((game.tick % (SLOW * 24)) !== 0) return;
    var map = game.map;
    var threat = hiveNests().length > 0 || state.machine.probed || !!state.invasion;
    if (!threat) return;
    var N = sys('Needs');
    if (!N || !N.addThought) return;
    var colonists = map.colonists();
    for (var i = 0; i < colonists.length; i++) {
      if (U.chance(0.35)) N.addThought(colonists[i], 'xenoDread');
    }
  }

  Aliens.tick = function (game) {
    game = game || G();
    if (!game || !game.map) return;
    ensureIncidents();
    detectNewGame(game);
    if (game.gameOver) return;

    var day = game.day ? game.day() : today();
    if (day < CONTACT_DAY) { state.tier = 0; return; }

    ensureState();

    var tier = Aliens.threatTier(game);
    if (tier > state.peak) state.peak = tier;
    if (tier !== state.tier) {
      state.tier = tier;
      debugLog('threat tier -> ' + tier + ' (' + Aliens.tierLabel(tier) + ')');
    }

    ensureCivs();

    /* An unanswered first contact letter answers itself. */
    if (state.contactOffered && state.stance === 'none' &&
        now() - state.contactTick > CONTACT_DEADLINE) {
      Aliens.answerContact('hide');
    }

    /* The hive takes ground whether or not anybody is looking at it. */
    if (state.tier >= 2 && hiveNests().length) {
      if (!state.hive.nextSpreadTick) state.hive.nextSpreadTick = now() + hiveSpreadInterval();
      if (now() >= state.hive.nextSpreadTick) {
        state.hive.nextSpreadTick = now() + hiveSpreadInterval();
        spreadHive(game);
      }
      tickHiveNodes(game);
      topUpHiveMinds(game.map);
    }

    tickMachines(game);
    tickInvasion(game);
    tickAbductions(game);
    tickDread(game);
  };

  /* ============================================================
     13. WHAT THE UI ASKS FOR
     ============================================================ */

  Aliens.summary = function (game) {
    game = game || G();
    var day = game && game.day ? game.day() : today();
    var p = Aliens.pressure(game);
    var rows = [];
    var keys = ['vessel', 'hive', 'machine'];
    for (var i = 0; i < keys.length; i++) {
      var spec = SPECIES[keys[i]];
      var f = factionOf(keys[i]);
      rows.push({
        id: keys[i], name: spec.name, known: !!f,
        goodwill: f ? f.goodwill : null,
        hostile: f ? !!f.hostile : false,
        minTier: spec.minTier,
        sites: f ? (f.settlements ? f.settlements.length : 0) : 0
      });
    }
    return {
      tier: state.tier, label: Aliens.tierLabel(state.tier),
      daysToContact: Math.max(0, CONTACT_DAY - day),
      pressure: { days: U.fmt(p.days, 2), wealth: U.fmt(p.wealth, 2), tech: U.fmt(p.tech, 2), total: U.fmt(p.total, 2) },
      stance: state.stance,
      contactPending: Aliens.contactPending(),
      species: rows,
      hiveNests: hiveNests().length,
      studied: state.studied,
      machines: Aliens.adaptation(),
      invasion: Aliens.invasionSummary(),
      taken: state.abductions.length
    };
  };

  /* ============================================================
     14. SAVE
     ============================================================ */

  Aliens.save = function () {
    return {
      version: 1,
      tier: state.tier, peak: state.peak, bias: state.bias,
      contactOffered: state.contactOffered, contactTick: state.contactTick,
      stance: state.stance,
      civs: JSON.parse(JSON.stringify(state.civs)),
      hive: { nextSpreadTick: state.hive.nextSpreadTick, spread: state.hive.spread,
              lost: state.hive.lost, warned: state.hive.warned },
      machine: {
        probed: state.machine.probed, waves: state.machine.waves,
        counters: {
          armour: state.machine.counters.armour, standoff: state.machine.counters.standoff,
          breach: state.machine.counters.breach, pods: state.machine.counters.pods
        },
        nextWaveTick: state.machine.nextWaveTick,
        lastAdaptation: state.machine.lastAdaptation || null
      },
      invasion: state.invasion ? {
        phase: state.invasion.phase, startTick: state.invasion.startTick,
        waves: state.invasion.waves, spireIds: state.invasion.spireIds.slice(),
        side: state.invasion.side, overrideTicks: state.invasion.overrideTicks,
        resolved: state.invasion.resolved
      } : null,
      abductions: state.abductions.map(function (a) { return JSON.parse(JSON.stringify(a)); }),
      studied: state.studied,
      lastSeenTick: state.lastSeenTick
    };
  };

  Aliens.load = function (obj) {
    if (!obj || typeof obj !== 'object') return false;
    var ready = state.incidentsReady;
    state = blankState();
    state.incidentsReady = ready;
    state.tier = obj.tier || 0;
    state.peak = obj.peak || state.tier;
    state.bias = obj.bias || 0;
    state.contactOffered = !!obj.contactOffered;
    state.contactTick = obj.contactTick || 0;
    state.stance = obj.stance || 'none';
    state.civs = obj.civs || {};
    if (obj.hive) {
      state.hive.nextSpreadTick = obj.hive.nextSpreadTick || 0;
      state.hive.spread = obj.hive.spread || 0;
      state.hive.lost = obj.hive.lost || 0;
      state.hive.warned = obj.hive.warned || 0;
    }
    if (obj.machine) {
      state.machine.probed = !!obj.machine.probed;
      state.machine.waves = obj.machine.waves || 0;
      state.machine.nextWaveTick = obj.machine.nextWaveTick || 0;
      state.machine.lastAdaptation = obj.machine.lastAdaptation || null;
      var c = obj.machine.counters || {};
      state.machine.counters = {
        armour: c.armour || 0, standoff: c.standoff || 0,
        breach: c.breach || 0, pods: c.pods || 0
      };
    }
    state.invasion = obj.invasion ? {
      phase: obj.invasion.phase || 'landed', startTick: obj.invasion.startTick || 0,
      waves: obj.invasion.waves || 0, spireIds: (obj.invasion.spireIds || []).slice(),
      side: obj.invasion.side || 'n', overrideTicks: obj.invasion.overrideTicks || 0,
      resolved: obj.invasion.resolved || null
    } : null;
    state.abductions = (obj.abductions || []).slice();
    state.studied = obj.studied || 0;
    state.lastSeenTick = obj.lastSeenTick || 0;
    ensureState();
    return true;
  };

  Aliens.CONTACT_DAY = CONTACT_DAY;
  Aliens.TIER_AT = TIER_AT;

  root.Aliens = Aliens;
})(this);
