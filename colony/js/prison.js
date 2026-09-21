/* ============================================================
   prison.js - the facility and the regime.

   prisoners.js answers "we have a captive". This file answers the
   questions that come after it: where do they sleep, what is that
   room worth, what is their security category, what are they doing
   at eleven in the morning, who is watching the corridor, what are
   they digging under the floor, and what happens on the day the
   block decides it has had enough.

   The spine is three things and everything else hangs off them:

     A CELL is a real room. It is graded from its size, beauty,
     temperature, light, furniture and cleanliness, and the grade is
     read by mood, by compliance and by the escape planner. A flag on
     a bed is not a cell.

     A CATEGORY is what the colony has decided a prisoner is. It
     decides which block they may live in, how much guard time they
     cost and what the regime is allowed to let them do. Mixing
     categories is possible, and it costs.

     A REGIME is twenty-four hours the player authors by hand, per
     category or per prisoner. It is the most customisable object in
     the file on purpose: a regime that never schedules a shower is a
     block full of filthy, furious people, and that is the player's
     sentence to have written.

   Ownership, from section 15 of the contract: capture, recruitment,
   release and execution belong to prisoners.js and are called, never
   reimplemented. Enslavement belongs to slavery.js, the underground
   to contraband.js, programmes to reform.js. Every one of them is
   reached through typeof and this file runs alone without them.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Everything below this file in the load order - Game above all - is
     looked up when it is called rather than captured at load. */
  function sys(name) {
    var v = root[name];
    return v === undefined ? null : v;
  }

  function now() {
    var G = root.Game;
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  function hourNow() {
    var G = root.Game;
    if (G && typeof G.hour === 'function') return G.hour();
    return (now() % 60000) / 2500;
  }

  var Prison = {};

  /* ============================================================
     1. TUNING

     Spans are ticks: 60 to the second, 60000 to the day. Rates
     written per day are divided by the beat they run on.
     ============================================================ */

  var DAY = 60000;
  var HOUR = 2500;
  var RARE = 250;              /* the staggered per-prisoner beat      */
  var FACILITY_BEAT = 250;     /* the whole-prison sweep               */
  var FAST_BEAT = 30;          /* riots and lockdown react on this     */
  var ROSTER_BEAT = 120;       /* how often the prisoner list is rebuilt */

  /* Need fall per day, when nothing in the regime is feeding them. */
  var NEED_FALL = {
    hygiene: 0.55, exercise: 0.50, privacy: 0.38,
    safety: 0.16, family: 0.26, freedom: 0.48
  };

  /* Guard-hours a prisoner of each category costs, as a fraction of one
     colonist standing watch full time. Six maximum-security prisoners
     want four guards; six minimums want one. */
  var GUARD_COST = { minimum: 0.16, medium: 0.34, maximum: 0.62 };

  var CATEGORIES = ['minimum', 'medium', 'maximum'];
  var CATEGORY_RANK = { minimum: 0, medium: 1, maximum: 2 };

  /* The twenty-four hour vocabulary. Order is the order the regime
     editor lists them in. */
  var ACTIVITIES = ['sleep', 'eat', 'shower', 'yard', 'work', 'free', 'programme', 'visit', 'lockup'];

  var ACTIVITY_LABEL = {
    sleep: 'Sleep', eat: 'Eat', shower: 'Shower', yard: 'Yard', work: 'Work',
    free: 'Free time', programme: 'Programme', visit: 'Visits', lockup: 'Lockup'
  };

  var GRADE_NAMES = ['squalid', 'poor', 'basic', 'decent', 'good', 'excellent'];
  /* Score thresholds, low to high. A cell scoring below the first is
     squalid; above the last is excellent. */
  var GRADE_BANDS = [-18, -4, 10, 26, 44];

  /* Rates below are per facility beat and there are 240 of those in a
     day, which is the number that matters when reading them. A prison
     the player is running badly should take days to boil over, not
     hours: the point is that they can see it coming and choose not to
     act. */
  var RIOT_THRESHOLD = 0.80;
  var RIOT_CHANCE_PER_BEAT = 0.006;
  var RIOT_COOLDOWN = DAY;     /* a block does not riot twice in a day  */
  var LOCKDOWN_MAX = DAY;
  var SOLITARY_MAX = DAY * 3;
  var TUNNEL_START = 0.45;     /* escape-plan score that starts a dig   */
  var ESCAPE_READY = 1.0;      /* plan score that makes them go         */
  var PLAN_GAIN = 0.0025;      /* multiplied by opportunity x motive    */
  var PLAN_DECAY = 0.0009;     /* a quiet prison forgets its plans      */
  var TUNNEL_WORK_PER_BEAT = 0.0012;

  var SEARCH_WORK = 320;
  var SHAKEDOWN_WORK = 700;
  var POST_SHIFT = HOUR * 2;
  var INCIDENT_CAP = 240;

  /* ============================================================
     2. CONTENT

     Registered additively at load. Nothing here runs; the tables are
     data and the engine reads them the way it reads a potato.
     ============================================================ */

  var S11 = { w: 1, h: 1 };
  var S21 = { w: 2, h: 1 };

  /* def_things.js keeps its building template private, so this is the
     same shape written out again. Every field a consumer may read is
     present on every building, which is why power.js can ask a toilet
     about its power draw without a guard. */
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

  var BUILDING_DEFAULTS = {
    category: 'building', description: '',
    sprite: 'box', color: '#8f97a3', color2: null,
    stackLimit: 1, mass: 20, marketValue: 0,
    nutrition: 0, foodType: null, rotDays: null,
    isMedicine: false, medicinePotency: 0,
    passable: false, pathCost: 0, fillPercent: 1, blocksLight: false, holdsRoof: false,
    size: S11, rotatable: false, hp: 120, flammable: false,
    beauty: 0, comfort: 0, natural: false,
    buildCost: null, stuffable: false, workToBuild: 0, buildSkill: 'construction',
    buildCategory: null, researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null,
    building: null, weapon: null, apparel: null
  };

  Defs.add('thing', {

    /* ---- what makes a cell a cell rather than a box with a bed ---- */

    prisonToilet: {
      label: 'cell toilet',
      description: 'A steel pan bolted to the floor. Without one the occupant washes in the ' +
        'same room they sleep in, and the grade of the cell says so every morning.',
      sprite: 'box', color: '#b8bec8', color2: '#8f97a3',
      hp: 110, mass: 25, fillPercent: 0.5, beauty: -1,
      buildCost: { steel: 20 }, workToBuild: 420, buildCategory: 'furniture',
      building: bld({ interactionOffset: { dx: 0, dy: 1 } })
    },

    prisonSink: {
      label: 'cell sink',
      description: 'Cold water in the cell. It is the difference between a prisoner who can ' +
        'wash and one who spends the week waiting for a shower block you never scheduled.',
      sprite: 'box', color: '#c6ccd4', color2: '#7d8490',
      hp: 90, mass: 18, fillPercent: 0.45, beauty: 0,
      buildCost: { steel: 15 }, workToBuild: 320, buildCategory: 'furniture',
      building: bld({ interactionOffset: { dx: 0, dy: 1 } })
    },

    prisonShelf: {
      label: 'cell shelf',
      description: 'Somewhere to put the few things they are allowed. It grades the cell up ' +
        'and it is also the first place a shakedown looks.',
      sprite: 'dresser', color: '#7d6a4f', color2: '#a98f68',
      hp: 80, mass: 20, fillPercent: 0.5, beauty: 2, flammable: true,
      stuffable: true, buildCost: { wood: 25 }, workToBuild: 340, buildCategory: 'furniture'
    },

    prisonShower: {
      label: 'shower block',
      description: 'A tiled stall and a drain. Schedule shower hours and hygiene stops being ' +
        'the reason your cells smell and your prisoners hate you.',
      sprite: 'box', color: '#9fb0b8', color2: '#6f8088',
      hp: 140, mass: 45, fillPercent: 0.6, beauty: 1,
      buildCost: { steel: 30, wood: 10 }, workToBuild: 680, buildCategory: 'furniture',
      building: bld({ interactionOffset: { dx: 0, dy: 1 } })
    },

    visitorBooth: {
      label: 'visitor booth',
      description: 'A bench, a grille and a chair on the other side of it. A prisoner who can ' +
        'talk to somebody from home is a prisoner who is not planning anything.',
      sprite: 'table', color: '#8a6134', color2: '#c9b48a',
      size: S21, hp: 130, mass: 50, fillPercent: 0.5, beauty: 2, flammable: true,
      buildCost: { wood: 35, steel: 10 }, workToBuild: 720, buildCategory: 'furniture',
      building: bld({ interactionOffset: { dx: 0, dy: 1 } })
    },

    /* ---- security as geometry ---- */

    guardPost: {
      label: 'guard post',
      description: 'A painted square that says a guard stands here. Assign one and they will ' +
        'hold it through their shift, which is how a corridor gets watched.',
      sprite: 'spot', color: '#4a7fd4', color2: '#e8e2d4',
      hp: 40, mass: 5, passable: true, pathCost: 0, fillPercent: 0, beauty: 0,
      buildCost: { steel: 10 }, workToBuild: 220, buildCategory: 'security'
    },

    metalDetector: {
      label: 'metal detector',
      description: 'A powered arch at a choke point. Every prisoner who walks through it is ' +
        'searched for free, which is worth more than a guard who has to be told.',
      sprite: 'trap', color: '#8f97a3', color2: '#ffc23c',
      hp: 120, mass: 40, passable: true, pathCost: 12, fillPercent: 0.2, beauty: -1,
      buildCost: { steel: 35, components: 2 }, workToBuild: 900, buildCategory: 'security',
      building: bld({ powerConsumed: 55 })
    },

    securityCamera: {
      label: 'security camera',
      description: 'A lens on a mast. It watches further than a guard can and never gets ' +
        'bored, but it only reports to a manned security desk.',
      sprite: 'lamp', color: '#6e7480', color2: '#c0392b',
      hp: 70, mass: 10, fillPercent: 0.25, beauty: -2,
      buildCost: { steel: 20, components: 3 }, workToBuild: 780, buildCategory: 'security',
      building: bld({ powerConsumed: 30 })
    },

    securityDesk: {
      label: 'security desk',
      description: 'Monitors, a chair and somebody sitting in it. A guard here doubles what ' +
        'every camera on the map is worth; an empty desk is furniture.',
      sprite: 'research', color: '#5a5f6b', color2: '#4a7fd4',
      size: S21, hp: 180, mass: 70, fillPercent: 0.5, beauty: 0,
      buildCost: { steel: 45, components: 6 }, workToBuild: 1500, buildCategory: 'security',
      building: bld({ powerConsumed: 140, interactionOffset: { dx: 0, dy: 1 } })
    },

    prisonGate: {
      label: 'prison gate',
      description: 'A slab of steel on a heavy frame. It opens slowly, it takes a long time ' +
        'to break, and door control can hold it shut against everyone but staff.',
      sprite: 'door', color: '#7b828d', color2: '#ffc23c',
      hp: 420, mass: 90, passable: true, pathCost: 0, fillPercent: 1, holdsRoof: true,
      beauty: -1, rotatable: false,
      buildCost: { steel: 45 }, workToBuild: 950, buildCategory: 'structure',
      building: bld({ isDoor: true, openTicks: 70 })
    }

  }, BUILDING_DEFAULTS);

  Defs.add('research', {
    penology: {
      label: 'penology', cost: 900, techLevel: 'medieval', tab: 'basic',
      description: 'Classification, intake and the paperwork of keeping people. Unlocks the ' +
        'hardware a regime needs to be enforced rather than hoped for.',
      prerequisites: [],
      unlocks: ['metalDetector', 'visitorBooth'],
      uiPosition: { x: 1, y: 6 }
    },
    surveillance: {
      label: 'surveillance', cost: 1700, techLevel: 'industrial', tab: 'advanced',
      description: 'Lenses, cable and a room to watch them from. One guard at a desk covers ' +
        'corridors that would otherwise cost you four.',
      prerequisites: ['electricity', 'penology'],
      unlocks: ['securityCamera', 'securityDesk'],
      uiPosition: { x: 2, y: 6 }
    }
  });

  Defs.add('workType', {
    guard: {
      label: 'Guard', verb: 'guarding', order: 6.5,
      description: 'Hold a post, walk a patrol, search prisoners and cells, and go in first ' +
        'when a block riots. Presence is the work; the fighting is the failure.',
      skills: ['shooting', 'social'], relevantSkillsLabel: 'Shooting, Social'
    }
  });

  var PSYCHOPATH = ['psychopath'];

  Defs.add('thought', {
    prisonCell: {
      label: 'My cell', durationDays: 0.5, stackLimit: 1,
      stages: [
        { label: 'This cell is a hole', mood: -0.16 },
        { label: 'This cell is grim', mood: -0.09 },
        { label: 'This cell will do', mood: -0.02 },
        { label: 'A decent cell', mood: 0.03 },
        { label: 'A good cell', mood: 0.07 },
        { label: 'Better than where I came from', mood: 0.11 }
      ]
    },
    prisonCrowded: {
      label: 'Crowded cell', durationDays: 0.5, stackLimit: 2,
      stages: [
        { label: 'Sharing a cell', mood: -0.05 },
        { label: 'Packed in', mood: -0.11 }
      ]
    },
    prisonHolding: {
      label: 'Still in holding', durationDays: 1, stackLimit: 3,
      stages: [{ label: 'Nobody has given me a cell', mood: -0.10 }]
    },
    prisonSolitary: {
      label: 'Solitary confinement', durationDays: 0.5, stackLimit: 1,
      stages: [
        { label: 'Alone in the dark', mood: -0.18 },
        { label: 'Days of this', mood: -0.26 }
      ]
    },
    prisonSolitaryAfter: {
      label: 'Was held in solitary', durationDays: 5, stackLimit: 3,
      stages: [{ label: 'I still hear the door', mood: -0.09 }]
    },
    prisonFilthy: {
      label: 'Filthy', durationDays: 0.5, stackLimit: 1,
      stages: [
        { label: 'Unwashed', mood: -0.05 },
        { label: 'Filthy', mood: -0.10 },
        { label: 'I have not washed in days', mood: -0.16 }
      ]
    },
    prisonPenned: {
      label: 'No exercise', durationDays: 0.5, stackLimit: 1,
      stages: [
        { label: 'Stiff and penned in', mood: -0.04 },
        { label: 'I have not been outside', mood: -0.10 }
      ]
    },
    prisonNoPrivacy: {
      label: 'No privacy', durationDays: 0.5, stackLimit: 1,
      stages: [{ label: 'Never alone for a minute', mood: -0.07 }]
    },
    prisonUnsafe: {
      label: 'Unsafe', durationDays: 0.5, stackLimit: 1,
      stages: [
        { label: 'Watching my back', mood: -0.07 },
        { label: 'Somebody in here will kill me', mood: -0.15 }
      ]
    },
    prisonNoFamily: {
      label: 'No word from home', durationDays: 1, stackLimit: 1,
      stages: [{ label: 'No word from anyone', mood: -0.06 }]
    },
    prisonCaged: {
      label: 'Caged', durationDays: 0.5, stackLimit: 1,
      stages: [
        { label: 'Caged', mood: -0.06 },
        { label: 'Locked in a box', mood: -0.13 },
        { label: 'I will not die in here', mood: -0.20 }
      ]
    },
    prisonFairRegime: {
      label: 'Treated decently', durationDays: 0.6, stackLimit: 1,
      stages: [{ label: 'They treat us like people', mood: 0.08 }]
    },
    prisonSearched: {
      label: 'Searched', durationDays: 0.4, stackLimit: 3,
      stages: [{ label: 'They went through my things', mood: -0.05 }]
    },
    prisonLockdown: {
      label: 'Lockdown', durationDays: 0.4, stackLimit: 1,
      stages: [{ label: 'Locked down all day', mood: -0.09 }]
    },
    prisonRiotSeen: {
      label: 'The block rioted', durationDays: 3, stackLimit: 3,
      stages: [{ label: 'The prisoners turned on us', mood: -0.11 }]
    },
    prisonDeathInCustody: {
      label: 'A prisoner died in our care', durationDays: 5, stackLimit: 4,
      nullifiedByTrait: PSYCHOPATH,
      stages: [{ label: 'Somebody died in our cells', mood: -0.09 }]
    },
    prisonMixedBlock: {
      label: 'Dangerous neighbours', durationDays: 0.5, stackLimit: 1,
      stages: [{ label: 'They put me in with the animals', mood: -0.08 }]
    }
  });

  /* ============================================================
     3. STATE

     Module state is plain data and round-trips through save()/load().
     Anything that belongs to one bed, one door or one prisoner lives
     on that object instead, because save.js already carries a thing's
     own fields and a pawn's own fields and those survive a room being
     rebuilt under them. Room ids do not: Regions renumbers on every
     rebuild, so nothing here is ever keyed by one.
     ============================================================ */

  function defaultRegime(category) {
    var r = new Array(24), h;
    for (h = 0; h < 24; h++) {
      if (h >= 22 || h < 6) r[h] = 'sleep';
      else if (h === 6 || h === 12 || h === 18) r[h] = 'eat';
      else if (h === 7) r[h] = 'shower';
      else if (h >= 8 && h < 12) r[h] = category === 'maximum' ? 'lockup' : 'work';
      else if (h >= 13 && h < 15) r[h] = 'yard';
      else if (h === 15) r[h] = 'programme';
      else if (h >= 16 && h < 18) r[h] = category === 'maximum' ? 'lockup' : 'free';
      else if (h >= 19 && h < 21) r[h] = 'free';
      else r[h] = 'lockup';
    }
    return r;
  }

  function freshState() {
    return {
      nextId: 1,
      blocks: [
        { id: 1, label: 'A Block', categories: ['minimum', 'medium'], regimeId: null, color: '#4a7fd4' }
      ],
      regimes: {
        minimum: defaultRegime('minimum'),
        medium: defaultRegime('medium'),
        maximum: defaultRegime('maximum')
      },
      patrols: [],
      areas: { yard: [], workshop: [], canteen: [] },
      unrest: {},
      tunnels: [],
      incidents: [],
      deaths: [],
      lockdown: { on: false, ticksLeft: 0, reason: '', blockId: 0, startedTick: 0 },
      riots: [],
      investigation: { open: false, sinceTick: 0, deaths: 0, closedTick: 0 },
      policy: {
        autoAssignCells: true,
        autoClassify: true,
        autoSolitaryOnMisconduct: true,
        solitaryHours: 12,
        searchOnReturn: true,
        shakedownDays: 2.5,          /* a cell is due a toss this often */
        lockdownOnEscape: true,
        lockdownOnRiot: true,
        executeOnRiot: false,        /* the option, and what it costs    */
        mealsInCell: true,
        yardBelowFreezing: false,
        maxPerCell: 2,
        guardRatioWarn: 0.75,
        negotiateAllowed: true
      },
      stats: { escapes: 0, escapesFoiled: 0, riots: 0, searches: 0, shakedowns: 0,
               contrabandFound: 0, tunnelsFound: 0, solitaryTerms: 0, deaths: 0 },
      lastRiotTick: {},
      lastFacilityTick: -1,
      lastRosterTick: -1
    };
  }

  Prison.state = freshState();

  Prison.reset = function () {
    Prison.state = freshState();
    _roster.length = 0;
    _cellCache = null;
    return Prison;
  };

  Prison.CATEGORIES = CATEGORIES;
  Prison.ACTIVITIES = ACTIVITIES;
  Prison.ACTIVITY_LABEL = ACTIVITY_LABEL;
  Prison.GRADES = GRADE_NAMES;

  var _roster = [];
  var _cellCache = null;
  var _tickSeen = -1;
  var _driverInstalled = false;

  function nextId() { return Prison.state.nextId++; }

  /* ---------- small shared helpers ---------- */

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    if (typeof pawn.label === 'function') return pawn.label();
    var n = pawn.name;
    return (n && (n.nick || n.first)) || 'someone';
  }

  function fullName(pawn) {
    if (pawn && typeof pawn.fullName === 'function') return pawn.fullName();
    return nameOf(pawn);
  }

  function msg(text, pawn, type) {
    var G = root.Game;
    if (!G || !G.msg) return;
    G.msg(text, { type: type || 'info', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }

  function letter(title, text, kind, pawn) {
    var G = root.Game;
    if (!G || !G.letter) return;
    G.letter(title, text, { kind: kind || 'neutral', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }

  function think(pawn, thoughtId, opts) {
    var N = sys('Needs');
    if (!N || !N.addThought) return;
    if (Defs.has && !Defs.has('thought', thoughtId)) return;
    N.addThought(pawn, thoughtId, opts);
  }

  function hasTrait(pawn, id) {
    return !!(pawn && pawn.traits && pawn.traits.indexOf(id) >= 0);
  }

  function skillOf(pawn, id) {
    if (!pawn) return 0;
    if (typeof pawn.skillLevel === 'function') return pawn.skillLevel(id);
    var s = pawn.skills && pawn.skills[id];
    return s ? s.level : 0;
  }

  function moodOf(pawn) {
    var N = sys('Needs');
    if (N && N.mood) return N.mood(pawn);
    return typeof pawn.mood === 'number' ? pawn.mood : 0.5;
  }

  function isPrisoner(pawn) {
    return !!(pawn && pawn.prisoner && !pawn.dead);
  }

  function prisonersOf(map) {
    var P = sys('Prisoners');
    if (P && P.all) return P.all(map);
    var out = [];
    if (!map) return out;
    for (var i = 0; i < map.pawns.length; i++) {
      if (map.pawns[i].prisoner && !map.pawns[i].dead) out.push(map.pawns[i]);
    }
    return out;
  }

  function prisonerBeds(map) {
    var P = sys('Prisoners');
    if (P && P.beds) return P.beds(map);
    var out = [], defs = Defs.all('thing');
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      if (!d.building || !d.building.isBed) continue;
      var list = map.byDef(d.id);
      for (var k = 0; k < list.length; k++) {
        if (list[k].spawned !== false && list[k].forPrisoners === true) out.push(list[k]);
      }
    }
    return out;
  }

  function roomAt(map, x, y) {
    var R = sys('Regions');
    return (R && R.roomAt) ? R.roomAt(map, x, y) : null;
  }

  function roomIdAt(map, x, y) {
    var R = sys('Regions');
    if (R && R.roomIdAt) return R.roomIdAt(map, x, y);
    return map.roomId ? map.roomId[map.idx(x, y)] : 0;
  }

  function lightAt(map, x, y) {
    var P = sys('Power');
    if (P && P.lightAt) return P.lightAt(map, x, y);
    var G = root.Game;
    return G && G.daylight ? G.daylight() : 0.6;
  }

  function reachable(map, pawn, x, y) {
    var P = sys('Path');
    if (!P || !P.reachable) return true;
    return P.reachable(map, pawn.x, pawn.y, x, y, { pawn: pawn });
  }

  /* The prison's own state on a pawn. Plain fields, so save.js carries
     it inside the pawn blob without this file being wired into it. */
  function stateOf(pawn) {
    if (!pawn) return null;
    var ps = pawn.prisonState;
    if (ps) return ps;
    ps = pawn.prisonState = {
      category: 'medium',
      categorySetByPlayer: false,
      regime: null,
      blockId: 0,
      needs: { hygiene: 0.8, exercise: 0.7, privacy: 0.6, safety: 0.8, family: 0.6, freedom: 0.5 },
      activity: 'lockup',
      activityTick: 0,
      intakeDone: false,
      intakeTick: 0,
      misconducts: 0,
      strikes: 0,
      searches: 0,
      contrabandFound: 0,
      escapeAttempts: 0,
      solitaryLeft: 0,
      solitaryTotal: 0,
      solitaryReason: '',
      solitaryBedId: 0,
      plan: { score: 0, opportunity: 0, reason: '', tunnelId: 0, partners: [] },
      rioting: false,
      riotTicks: 0,
      lastShowerTick: 0,
      lastYardTick: 0,
      lastVisitTick: 0,
      lastSearchTick: 0,
      lastGradeScore: 0,
      deathRecorded: false,
      note: ''
    };
    return ps;
  }
  Prison.stateOf = stateOf;

  /* ============================================================
     4. THE INCIDENT LOG

     Everything the player is expected to be able to trace back to a
     decision of theirs is written here, with the tick and the place.
     ============================================================ */

  Prison.log = function (kind, text, opts) {
    opts = opts || {};
    var rec = {
      id: nextId(), kind: kind, text: text, tick: now(),
      day: Math.floor(now() / DAY),
      hour: Math.round(hourNow() * 10) / 10,
      pawnId: opts.pawn ? opts.pawn.id : 0,
      pawnName: opts.pawn ? fullName(opts.pawn) : (opts.pawnName || ''),
      blockId: opts.blockId || 0,
      x: opts.x === undefined ? (opts.pawn ? opts.pawn.x : -1) : opts.x,
      y: opts.y === undefined ? (opts.pawn ? opts.pawn.y : -1) : opts.y,
      severity: opts.severity || 'note'
    };
    var list = Prison.state.incidents;
    list.push(rec);
    if (list.length > INCIDENT_CAP) list.splice(0, list.length - INCIDENT_CAP);
    return rec;
  };

  Prison.incidents = function (limit) {
    var list = Prison.state.incidents;
    if (!limit || limit >= list.length) return list.slice().reverse();
    return list.slice(list.length - limit).reverse();
  };

  /* ============================================================
     5. BLOCKS

     A block is the player's name for a set of cells, and the unit
     everything above the cell is measured in: which categories may
     live there, whose unrest boils over, which corridor riots. Beds
     carry their block id, so a block survives a wall being knocked
     through and a room being renumbered.
     ============================================================ */

  Prison.blocks = function () { return Prison.state.blocks; };

  Prison.block = function (id) {
    var list = Prison.state.blocks;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };

  Prison.addBlock = function (label, categories, color) {
    var block = {
      id: nextId(),
      label: label || ('Block ' + (Prison.state.blocks.length + 1)),
      categories: (categories && categories.length) ? categories.slice() : ['medium'],
      regimeId: null,
      color: color || '#8f97a3'
    };
    Prison.state.blocks.push(block);
    return block;
  };

  Prison.removeBlock = function (id) {
    if (id === 1) return false;               /* the default block always exists */
    var block = Prison.block(id);
    if (!block) return false;
    U.remove(Prison.state.blocks, block);
    delete Prison.state.unrest[id];
    var G = root.Game, map = G && G.map;
    if (map) {
      var beds = prisonerBeds(map);
      for (var i = 0; i < beds.length; i++) if (beds[i].prisonBlockId === id) beds[i].prisonBlockId = 1;
    }
    _cellCache = null;
    return true;
  };

  Prison.setBlockCategories = function (id, categories) {
    var block = Prison.block(id);
    if (!block) return false;
    var out = [];
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (categories && categories.indexOf(CATEGORIES[i]) >= 0) out.push(CATEGORIES[i]);
    }
    block.categories = out.length ? out : ['medium'];
    _cellCache = null;
    return true;
  };

  Prison.setBlockRegime = function (id, regimeKey) {
    var block = Prison.block(id);
    if (!block) return false;
    block.regimeId = regimeKey || null;
    return true;
  };

  /* Put a bed - and therefore the cell it sits in - into a block. */
  Prison.setBedBlock = function (bed, blockId) {
    if (!bed || !bed.def || !bed.def.building || !bed.def.building.isBed) return false;
    if (!Prison.block(blockId)) return false;
    bed.prisonBlockId = blockId;
    _cellCache = null;
    return true;
  };

  Prison.setCellBlock = function (map, cell, blockId) {
    if (!cell || !cell.beds) return false;
    var ok = false;
    for (var i = 0; i < cell.beds.length; i++) ok = Prison.setBedBlock(cell.beds[i], blockId) || ok;
    return ok;
  };

  function blockOfBed(bed) {
    var id = bed && bed.prisonBlockId;
    return (id && Prison.block(id)) ? id : 1;
  }

  /* ============================================================
     6. CELLS AND GRADING

     A cell is an enclosed room holding at least one prisoner bed. It
     is derived from the map every time the map changes, never stored,
     and the grade is the number everything downstream reads.
     ============================================================ */

  function gradeIndexOf(score) {
    for (var i = 0; i < GRADE_BANDS.length; i++) if (score < GRADE_BANDS[i]) return i;
    return GRADE_NAMES.length - 1;
  }

  function furnitureScore(map, room) {
    var seen = {}, score = 0, art = 0;
    for (var i = 0; i < room.cells.length; i++) {
      var b = map.things.get(map.buildingId[room.cells[i]]);
      if (!b || !b.def) continue;
      var id = b.def.id;
      if (seen[id] && id !== 'sculpture') continue;
      seen[id] = true;
      if (id === 'prisonToilet') score += 10;
      else if (id === 'prisonSink') score += 6;
      else if (id === 'prisonShelf') score += 5;
      else if (id === 'standingLamp') score += 3;
      else if (id === 'stool') score += 2;
      else if (id === 'table') score += 3;
      else if (id === 'dresser') score += 3;
      else if (id === 'sculpture') { art += 6; }
    }
    return score + Math.min(art, 12);
  }

  /* The grade, and the reasons for it, because a number the player
     cannot argue with is a number they cannot act on. */
  Prison.cellGrade = function (room, opts) {
    opts = opts || {};
    var map = opts.map || (root.Game && root.Game.map);
    var parts = [];
    if (!room || !map) {
      return { score: -30, grade: 'squalid', gradeIndex: 0, norm: 0, parts: parts };
    }

    if (!room.cells || !room.cells.length) {
      return { score: -30, grade: 'squalid', gradeIndex: 0, norm: 0, parts: parts };
    }
    var bedCount = Math.max(1, opts.bedCount || 1);
    var occupants = opts.occupants === undefined ? bedCount : opts.occupants;
    var score = 0, v;

    /* Space only counts inside walls. A bunk under the sky has no room
       around it, however much ground there is. */
    var per = room.outdoor ? 1.2 : (room.size / bedCount);
    v = U.curve([[1, -20], [2, -9], [4, 0], [6, 8], [10, 14], [24, 18]], per);
    score += v; parts.push({ label: 'space per bunk', value: v });

    v = U.clamp(room.beauty, -22, 22) * 0.85;
    score += v; parts.push({ label: 'beauty', value: v });

    v = U.curve([[-2.5, -16], [-1, -8], [-0.2, -2], [0.3, 4], [1, 9]], room.cleanliness);
    score += v; parts.push({ label: 'cleanliness', value: v });

    var t = room.temperature;
    if (t < 14) v = -U.clamp((14 - t) * 1.4, 0, 22);
    else if (t > 28) v = -U.clamp((t - 28) * 1.4, 0, 22);
    else v = 3;
    score += v; parts.push({ label: 'temperature', value: v });

    var cx = map.xOf(room.cells[0]), cy = map.yOf(room.cells[0]);
    if (room.cells.length > 2) {
      var mid = room.cells[room.cells.length >> 1];
      cx = map.xOf(mid); cy = map.yOf(mid);
    }
    v = U.curve([[0, -13], [0.2, -7], [0.5, 0], [0.85, 5]], lightAt(map, cx, cy));
    score += v; parts.push({ label: 'light', value: v });

    v = furnitureScore(map, room);
    score += v; parts.push({ label: 'furniture', value: v });

    if (!room.roofed) { score -= 16; parts.push({ label: 'no roof', value: -16 }); }
    if (room.outdoor) { score -= 12; parts.push({ label: 'open to the sky', value: -12 }); }

    if (occupants > bedCount) {
      v = -9 * (occupants - bedCount);
      score += v; parts.push({ label: 'over capacity', value: v });
    }
    if (opts.solitary) { score -= 12; parts.push({ label: 'solitary', value: -12 }); }
    if (opts.holding) { score -= 10; parts.push({ label: 'holding cell', value: -10 }); }

    var gi = gradeIndexOf(score);
    return {
      score: Math.round(score * 10) / 10,
      grade: GRADE_NAMES[gi],
      gradeIndex: gi,
      norm: U.clamp01((score + 30) / 80),
      parts: parts
    };
  };

  function livingOwner(map, id) {
    for (var i = 0; i < map.pawns.length; i++) {
      if (map.pawns[i].id === id) return !map.pawns[i].dead;
    }
    return false;
  }

  /* The stand-in room for beds with no walls round them. */
  function openAirRoom(map, beds) {
    var cells = [];
    for (var i = 0; i < beds.length; i++) cells.push(map.idx(beds[i].x, beds[i].y));
    var G = root.Game;
    return {
      id: 0, cells: cells, size: cells.length, outdoor: true,
      temperature: (G && G.outdoorTemp) ? G.outdoorTemp() : 15,
      beauty: 0, cleanliness: -0.5, roofed: false, roofedFrac: 0,
      doorIds: [], role: 'none', wealth: 0, touchesEdge: true,
      bedCount: beds.length, tableCount: 0, chairCount: 0, benchCount: 0, pusherIds: []
    };
  }

  /* Every cell in the prison, rebuilt at most once a tick. */
  Prison.cells = function (map) {
    map = map || (root.Game && root.Game.map);
    if (!map) return [];
    var t = now();
    if (_cellCache && _cellCache.map === map && _cellCache.tick === t) return _cellCache.list;

    var beds = prisonerBeds(map);
    var byRoom = Object.create(null), order = [];
    var i;
    for (i = 0; i < beds.length; i++) {
      var bed = beds[i];
      if (bed.spawned === false) continue;
      var rid = roomIdAt(map, bed.x, bed.y);
      var key = 'r' + rid;
      var entry = byRoom[key];
      if (!entry) {
        entry = byRoom[key] = { roomId: rid, beds: [] };
        order.push(entry);
      }
      entry.beds.push(bed);
    }

    /* Who is standing in each cell right now. One pass over the
       prisoners rather than a pawnsAt per cell. */
    var occupantsByRoom = Object.create(null);
    var prisoners = prisonersOf(map);
    for (i = 0; i < prisoners.length; i++) {
      var p = prisoners[i];
      var prid = 'r' + roomIdAt(map, p.x, p.y);
      (occupantsByRoom[prid] || (occupantsByRoom[prid] = [])).push(p);
    }

    var list = [];
    for (i = 0; i < order.length; i++) {
      var e = order[i];
      /* A bed standing in the open is not a cell and must never be
         graded as one: the outdoors is a room of ten thousand tiles and
         walking it per bed per tick would cost more than the rest of
         this file put together. It gets a one-tile stand-in, which is
         also the honest description of the accommodation. */
      var room = e.roomId ? roomAt(map, e.beds[0].x, e.beds[0].y) : null;
      if (room && room.outdoor) room = null;
      if (!room) room = openAirRoom(map, e.beds);
      var solitary = false, holding = false, blockId = 0, assigned = 0;
      for (var b = 0; b < e.beds.length; b++) {
        var bd = e.beds[b];
        if (bd.prisonSolitary) solitary = true;
        if (bd.prisonHolding) holding = true;
        if (!blockId) blockId = blockOfBed(bd);
        if (bd.ownerId && livingOwner(map, bd.ownerId)) assigned++;
        else if (bd.ownerId) bd.ownerId = null;   /* the owner is dead */
      }
      var occ = occupantsByRoom['r' + e.roomId] || [];
      var grade = Prison.cellGrade(room, {
        map: map, bedCount: e.beds.length, occupants: Math.max(occ.length, assigned),
        solitary: solitary, holding: holding
      });
      list.push({
        roomId: e.roomId,
        room: room,
        beds: e.beds,
        bedIds: e.beds.map(function (x) { return x.id; }),
        capacity: e.beds.length,
        assigned: assigned,
        occupants: occ,
        blockId: blockId || 1,
        solitary: solitary,
        holding: holding,
        kind: solitary ? 'solitary' : (holding ? 'holding' : (e.beds.length > 1 ? 'shared' : 'cell')),
        x: e.beds[0].x, y: e.beds[0].y,
        grade: grade
      });
    }

    _cellCache = { map: map, tick: t, list: list };
    return list;
  };

  Prison.cellOf = function (pawn) {
    if (!pawn || !pawn.map) return null;
    var cells = Prison.cells(pawn.map), i, k;
    /* Their own bunk first: a prisoner standing in the corridor still
       has a cell, and that is the one the grade should be read from. */
    if (pawn.ownedBedId) {
      for (i = 0; i < cells.length; i++) {
        for (k = 0; k < cells[i].bedIds.length; k++) {
          if (cells[i].bedIds[k] === pawn.ownedBedId) return cells[i];
        }
      }
    }
    var rid = roomIdAt(pawn.map, pawn.x, pawn.y);
    if (!rid) return null;
    for (i = 0; i < cells.length; i++) if (cells[i].roomId === rid) return cells[i];
    return null;
  };

  Prison.cellAt = function (map, x, y) {
    var rid = roomIdAt(map, x, y);
    if (!rid) return null;
    var cells = Prison.cells(map);
    for (var i = 0; i < cells.length; i++) if (cells[i].roomId === rid) return cells[i];
    return null;
  };

  /* Prisoners with no bunk of their own. The report and the alert both
     read this, because an unassigned prisoner is a problem that grows:
     they sleep on the floor, their grade is nothing, and the block
     they are wandering is not the block they were classified for. */
  Prison.unassigned = function (map) {
    map = map || (root.Game && root.Game.map);
    var out = [], list = prisonersOf(map);
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.carriedBy) continue;
      var bed = p.ownedBedId ? map.thing(p.ownedBedId) : null;
      if (!bed || bed.spawned === false || !bed.forPrisoners) out.push(p);
    }
    return out;
  };

  /* Assign a prisoner to a cell, honouring classification and capacity
     unless the caller insists. Returns the bed, or null with the reason
     on Prison.lastRefusal. */
  Prison.lastRefusal = '';

  Prison.assignCell = function (pawn, cellOrRoomOrBed, opts) {
    opts = opts || {};
    Prison.lastRefusal = '';
    if (!pawn || !pawn.map || !isPrisoner(pawn)) { Prison.lastRefusal = 'not a prisoner'; return null; }
    var map = pawn.map;
    var bed = null, cell = null;

    if (cellOrRoomOrBed && cellOrRoomOrBed.def && cellOrRoomOrBed.def.building &&
        cellOrRoomOrBed.def.building.isBed) {
      bed = cellOrRoomOrBed;
      cell = Prison.cellAt(map, bed.x, bed.y);
    } else if (cellOrRoomOrBed && cellOrRoomOrBed.beds) {
      cell = cellOrRoomOrBed;
    } else if (cellOrRoomOrBed && cellOrRoomOrBed.cells) {
      cell = Prison.cellAt(map, map.xOf(cellOrRoomOrBed.cells[0]), map.yOf(cellOrRoomOrBed.cells[0]));
    }
    if (!cell && !bed) { Prison.lastRefusal = 'no such cell'; return null; }

    var ps = stateOf(pawn);
    if (cell && !opts.force) {
      var block = Prison.block(cell.blockId);
      if (block && block.categories.indexOf(ps.category) < 0) {
        Prison.lastRefusal = block.label + ' does not take ' + ps.category + '-security prisoners';
        if (!opts.allowMixing) return null;
      }
      var ceiling = Math.min(cell.capacity, Math.max(1, Prison.state.policy.maxPerCell));
      if (!cell.solitary && cell.assigned >= ceiling) {
        Prison.lastRefusal = 'that cell is full';
        return null;
      }
    }

    if (!bed && cell) {
      for (var i = 0; i < cell.beds.length; i++) {
        var b = cell.beds[i];
        if (b.ownerId && b.ownerId !== pawn.id) {
          var owner = null, pawns = map.pawns;
          for (var k = 0; k < pawns.length; k++) if (pawns[k].id === b.ownerId) { owner = pawns[k]; break; }
          if (owner && !owner.dead) continue;
        }
        bed = b; break;
      }
    }
    if (!bed) { Prison.lastRefusal = 'no free bunk in that cell'; return null; }

    /* Release the old bunk before taking the new one, or the prison
       slowly fills with beds owned by somebody who lives elsewhere. */
    if (pawn.ownedBedId && pawn.ownedBedId !== bed.id) {
      var old = map.thing(pawn.ownedBedId);
      if (old && old.ownerId === pawn.id) old.ownerId = null;
    }
    bed.ownerId = pawn.id;
    pawn.ownedBedId = bed.id;
    ps.blockId = cell ? cell.blockId : blockOfBed(bed);
    _cellCache = null;
    return bed;
  };

  /* The automatic version, used at intake and by the warden sweep. It
     prefers a cell whose block accepts the category and whose grade is
     best; it will use a holding cell rather than leave somebody on the
     floor, and it says so in the log. */
  Prison.autoAssign = function (pawn) {
    if (!pawn || !pawn.map) return null;
    var map = pawn.map, ps = stateOf(pawn);
    var cells = Prison.cells(map), best = null, bestScore = -1e9, fallback = null;

    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (c.solitary) continue;
      if (c.assigned >= Math.min(c.capacity, Math.max(1, Prison.state.policy.maxPerCell))) continue;
      if (!reachable(map, pawn, c.x, c.y)) continue;
      var block = Prison.block(c.blockId);
      var fits = !block || block.categories.indexOf(ps.category) >= 0;
      var score = c.grade.score - (c.holding ? 30 : 0) - (c.capacity > 1 ? 6 : 0);
      if (!fits) { if (!fallback || score > fallback.score) fallback = { cell: c, score: score }; continue; }
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best && fallback) best = fallback.cell;
    if (!best) {
      Prison.lastRefusal = cells.length
        ? 'every cell is taken or out of reach'
        : 'the prison has no cells in it';
      return null;
    }

    var already = pawn.ownedBedId && best.bedIds.indexOf(pawn.ownedBedId) >= 0;
    var bed = Prison.assignCell(pawn, best, { force: true, allowMixing: true });
    if (bed && !already) {
      var block = Prison.block(best.blockId);
      if (block && block.categories.indexOf(ps.category) < 0) {
        Prison.log('classification',
          fullName(pawn) + ' had to be housed in ' + block.label +
          ', which is not rated for ' + ps.category + ' security.',
          { pawn: pawn, blockId: best.blockId, severity: 'warn' });
      }
    }
    return bed;
  };

  /* ============================================================
     7. CLASSIFICATION AND INTAKE
     ============================================================ */

  /* What the colony would call them if nobody had an opinion: their
     civilization, what they can do in a fight, what they have already
     tried, and what they were carrying when they came in. */
  Prison.classifyRaw = function (pawn) {
    if (!pawn) return { category: 'medium', score: 0, parts: [] };
    var parts = [], score = 0, v;

    var combat = (skillOf(pawn, 'shooting') + skillOf(pawn, 'melee')) / 2;
    v = combat * 0.55;
    score += v; parts.push({ label: 'combat skill', value: v });

    var st = pawn.prisoner;
    var factionId = st ? st.factionId : pawn.faction;
    var F = sys('Factions');
    var faction = (F && F.get) ? F.get(factionId) : null;
    if (faction && faction.permanentEnemy) { score += 5; parts.push({ label: 'pirate', value: 5 }); }
    else if (factionId === 'raider') { score += 3.5; parts.push({ label: 'raider', value: 3.5 }); }
    if (faction && (faction.techLevel === 'spacer' || faction.techLevel === 'industrial')) {
      score += 1.5; parts.push({ label: 'knows the tech', value: 1.5 });
    }

    if (st && st.resistance > 14) { score += 2.5; parts.push({ label: 'unbroken', value: 2.5 }); }

    var ps = pawn.prisonState;
    if (ps) {
      if (ps.escapeAttempts) {
        v = Math.min(ps.escapeAttempts * 3, 9);
        score += v; parts.push({ label: 'escape attempts', value: v });
      }
      if (ps.misconducts) {
        v = Math.min(ps.misconducts * 1.1, 6);
        score += v; parts.push({ label: 'misconduct', value: v });
      }
      if (ps.contrabandFound) {
        v = Math.min(ps.contrabandFound * 1.2, 5);
        score += v; parts.push({ label: 'contraband', value: v });
      }
    }

    if (hasTrait(pawn, 'psychopath')) { score += 4; parts.push({ label: 'psychopath', value: 4 }); }
    if (hasTrait(pawn, 'bloodlust')) { score += 3; parts.push({ label: 'bloodlust', value: 3 }); }
    if (hasTrait(pawn, 'volatile')) { score += 2; parts.push({ label: 'volatile', value: 2 }); }
    if (hasTrait(pawn, 'ironWilled')) { score += 2; parts.push({ label: 'iron-willed', value: 2 }); }
    if (hasTrait(pawn, 'wimp')) { score -= 3; parts.push({ label: 'wimp', value: -3 }); }
    if (hasTrait(pawn, 'kind')) { score -= 2.5; parts.push({ label: 'kind', value: -2.5 }); }
    if (pawn.ageYears >= 60) { score -= 2; parts.push({ label: 'elderly', value: -2 }); }

    var H = sys('Health');
    if (H && H.capacity) {
      var moving = H.capacity(pawn, 'moving');
      if (moving < 0.6) { v = -4 * (1 - moving); score += v; parts.push({ label: 'cannot walk far', value: v }); }
    }

    var cat = score >= 14 ? 'maximum' : (score >= 6 ? 'medium' : 'minimum');
    return { category: cat, score: Math.round(score * 10) / 10, parts: parts };
  };

  Prison.categoryOf = function (pawn) {
    var ps = pawn && pawn.prisonState;
    return ps ? ps.category : 'medium';
  };

  Prison.setCategory = function (pawn, category, byPlayer) {
    if (!isPrisoner(pawn) || CATEGORIES.indexOf(category) < 0) return false;
    var ps = stateOf(pawn);
    if (ps.category === category) return true;
    var was = ps.category;
    ps.category = category;
    if (byPlayer !== false) ps.categorySetByPlayer = true;
    Prison.log('classification',
      fullName(pawn) + ' reclassified from ' + was + ' to ' + category + ' security.',
      { pawn: pawn, blockId: ps.blockId, severity: 'note' });

    /* A reclassification that leaves them in the wrong block is the
       player's problem to solve, and the report will keep saying so. */
    var cell = Prison.cellOf(pawn);
    if (cell) {
      var block = Prison.block(cell.blockId);
      if (block && block.categories.indexOf(category) < 0 && Prison.state.policy.autoAssignCells) {
        Prison.autoAssign(pawn);
      }
    }
    return true;
  };

  /* Everything that happens the first time a captive is looked at
     properly: a category, a block, a bunk, a note in the log. */
  Prison.intake = function (pawn) {
    var ps = stateOf(pawn);
    if (ps.intakeDone) return false;
    ps.intakeDone = true;
    ps.intakeTick = now();

    if (Prison.state.policy.autoClassify && !ps.categorySetByPlayer) {
      ps.category = Prison.classifyRaw(pawn).category;
    }
    if (Prison.state.policy.autoAssignCells) Prison.autoAssign(pawn);

    var cell = Prison.cellOf(pawn);
    ps.blockId = cell ? cell.blockId : 0;
    Prison.log('intake',
      fullName(pawn) + ' processed as ' + ps.category + ' security' +
      (cell ? ', housed in ' + (Prison.block(cell.blockId) || { label: 'a block' }).label +
        ' (' + cell.grade.grade + ' cell)' : ', with no cell free'),
      { pawn: pawn, blockId: ps.blockId, severity: cell ? 'note' : 'warn' });
    return true;
  };

  /* ============================================================
     8. THE REGIME

     Twenty-four slots the player writes by hand. A regime belongs to
     a security category, to a named block, or to one prisoner, and
     the lookup walks that list in that order. This is the knob the
     whole layer turns on: a regime with no shower hour, no yard hour
     and nothing but lockup is legal, it is what an anxious player
     writes, and it produces a riot in about four days.
     ============================================================ */

  function blankRegime(fill) {
    var r = new Array(24);
    for (var h = 0; h < 24; h++) r[h] = fill || 'lockup';
    return r;
  }

  var REGIME_PRESETS = [
    { id: 'balanced', label: 'Balanced',
      description: 'Sleep, three meals, a shower, yard in the afternoon, a programme and free time.',
      build: function () { return defaultRegime('medium'); } },
    { id: 'strict', label: 'Strict',
      description: 'Long lockup, one meal in the cell, a short yard hour. Cheap in guards, ' +
        'expensive in everything else.',
      build: function () {
        var r = blankRegime('lockup'), h;
        for (h = 21; h < 24; h++) r[h] = 'sleep';
        for (h = 0; h < 7; h++) r[h] = 'sleep';
        r[7] = 'eat'; r[13] = 'eat'; r[14] = 'yard'; r[19] = 'eat';
        return r;
      } },
    { id: 'permissive', label: 'Permissive',
      description: 'Most of the day out of the cell. Moods hold up, and so does the escape plan ' +
        'of everyone in the block.',
      build: function () {
        var r = blankRegime('free'), h;
        for (h = 23; h < 24; h++) r[h] = 'sleep';
        for (h = 0; h < 7; h++) r[h] = 'sleep';
        r[7] = 'shower'; r[8] = 'eat'; r[9] = 'yard'; r[10] = 'yard';
        r[13] = 'eat'; r[14] = 'programme'; r[15] = 'visit'; r[19] = 'eat';
        return r;
      } },
    { id: 'labour', label: 'Labour',
      description: 'Eight hours of prison work. It pays for itself and it wears people out.',
      build: function () {
        var r = blankRegime('lockup'), h;
        for (h = 22; h < 24; h++) r[h] = 'sleep';
        for (h = 0; h < 6; h++) r[h] = 'sleep';
        r[6] = 'eat'; r[7] = 'shower';
        for (h = 8; h < 12; h++) r[h] = 'work';
        r[12] = 'eat';
        for (h = 13; h < 17; h++) r[h] = 'work';
        r[17] = 'eat'; r[18] = 'yard'; r[19] = 'free'; r[20] = 'free'; r[21] = 'free';
        return r;
      } },
    { id: 'reform', label: 'Reform',
      description: 'Programmes, visits and long yard hours. The slowest way to empty a cell ' +
        'block, and the one that hands you colonists at the end of it.',
      build: function () {
        var r = blankRegime('programme'), h;
        for (h = 22; h < 24; h++) r[h] = 'sleep';
        for (h = 0; h < 7; h++) r[h] = 'sleep';
        r[7] = 'shower'; r[8] = 'eat'; r[9] = 'yard'; r[10] = 'yard';
        r[12] = 'eat'; r[16] = 'visit'; r[17] = 'free'; r[18] = 'eat';
        r[19] = 'free'; r[20] = 'free'; r[21] = 'free';
        return r;
      } }
  ];
  Prison.REGIME_PRESETS = REGIME_PRESETS;

  function regimeKeyOf(target) {
    if (typeof target === 'string') return CATEGORIES.indexOf(target) >= 0 ? target : null;
    return null;
  }

  /* The schedule that actually governs this prisoner right now:
     their own if they have one, then their block's if it names a
     regime, then their category's. */
  Prison.regime = function (target) {
    var key = regimeKeyOf(target);
    if (key) return Prison.state.regimes[key] || (Prison.state.regimes[key] = defaultRegime(key));

    if (target && target.prisoner) {
      var ps = stateOf(target);
      if (ps.regime && ps.regime.length === 24) return ps.regime;
      var block = ps.blockId ? Prison.block(ps.blockId) : null;
      if (block && block.regimeId && Prison.state.regimes[block.regimeId]) {
        return Prison.state.regimes[block.regimeId];
      }
      return Prison.regime(ps.category);
    }
    if (target && target.categories) {                 /* a block */
      if (target.regimeId && Prison.state.regimes[target.regimeId]) {
        return Prison.state.regimes[target.regimeId];
      }
      return Prison.regime(target.categories[0] || 'medium');
    }
    return Prison.regime('medium');
  };

  /* Write one hour, a range of hours, or the whole day. `hour` may be
     a number, a [from, to) pair or null for every hour. */
  Prison.setRegime = function (target, hour, activity) {
    if (ACTIVITIES.indexOf(activity) < 0) return false;
    var r = Prison.regimeForWrite(target);
    if (!r) return false;
    var h;
    if (hour === null || hour === undefined) {
      for (h = 0; h < 24; h++) r[h] = activity;
    } else if (Array.isArray(hour)) {
      var from = U.clamp(hour[0] | 0, 0, 23), to = U.clamp(hour[1] | 0, 0, 24);
      for (h = from; h < to; h++) r[h] = activity;
    } else {
      h = U.clamp(hour | 0, 0, 23);
      r[h] = activity;
    }
    return true;
  };

  /* The array a write should land in, creating a per-prisoner override
     the first time somebody edits one prisoner's day. */
  Prison.regimeForWrite = function (target) {
    var key = regimeKeyOf(target);
    if (key) return Prison.state.regimes[key] || (Prison.state.regimes[key] = defaultRegime(key));
    if (target && target.prisoner) {
      var ps = stateOf(target);
      if (!ps.regime || ps.regime.length !== 24) ps.regime = Prison.regime(target).slice();
      return ps.regime;
    }
    if (target && target.categories) {
      if (!target.regimeId) {
        var id = 'block' + target.id;
        Prison.state.regimes[id] = Prison.regime(target).slice();
        target.regimeId = id;
      }
      return Prison.state.regimes[target.regimeId];
    }
    return null;
  };

  Prison.clearRegimeOverride = function (pawn) {
    var ps = pawn && pawn.prisonState;
    if (!ps || !ps.regime) return false;
    ps.regime = null;
    return true;
  };

  Prison.applyPreset = function (target, presetId) {
    for (var i = 0; i < REGIME_PRESETS.length; i++) {
      if (REGIME_PRESETS[i].id !== presetId) continue;
      var built = REGIME_PRESETS[i].build();
      var r = Prison.regimeForWrite(target);
      if (!r) return false;
      for (var h = 0; h < 24; h++) r[h] = built[h];
      return true;
    }
    return false;
  };

  Prison.copyRegime = function (from, to) {
    var src = Prison.regime(from), dst = Prison.regimeForWrite(to);
    if (!src || !dst) return false;
    for (var h = 0; h < 24; h++) dst[h] = src[h];
    return true;
  };

  /* What this prisoner is supposed to be doing at this moment, before
     lockdown, solitary and their own health get a say. */
  Prison.scheduledActivity = function (pawn, hour) {
    var r = Prison.regime(pawn);
    var h = U.clamp(Math.floor(hour === undefined ? hourNow() : hour), 0, 23);
    return r[h] || 'lockup';
  };

  Prison.activityOf = function (pawn) {
    var ps = stateOf(pawn);
    if (ps.solitaryLeft > 0) return 'solitary';
    var L = Prison.state.lockdown;
    if (L.on && (!L.blockId || L.blockId === ps.blockId)) return 'lockup';
    return Prison.scheduledActivity(pawn);
  };

  /* How well the facility can actually deliver a regime: the hours it
     schedules against the rooms and objects that make them possible.
     This is what turns "I wrote a shower hour" into "you have no
     shower", and the report prints it. */
  Prison.regimeAudit = function (map, target) {
    map = map || (root.Game && root.Game.map);
    var r = Prison.regime(target);
    var counts = {}, h, i;
    for (i = 0; i < ACTIVITIES.length; i++) counts[ACTIVITIES[i]] = 0;
    for (h = 0; h < 24; h++) counts[r[h]] = (counts[r[h]] || 0) + 1;

    var facilities = Prison.facilities(map);
    var problems = [];
    if (!counts.sleep) problems.push('no sleep hours at all');
    if (counts.sleep < 5) problems.push('only ' + counts.sleep + ' hours of sleep');
    if (!counts.eat) problems.push('no meal hours');
    if (!counts.shower) problems.push('no shower hours');
    else if (!facilities.showers) problems.push('shower hours but no shower block built');
    if (!counts.yard) problems.push('no yard hours');
    else if (!facilities.yard) problems.push('yard hours but no yard marked');
    if (counts.visit && !facilities.booths) problems.push('visiting hours but no visitor booth');
    if (counts.work && !facilities.workshop) problems.push('work hours but no prison workshop');
    if (counts.programme && !facilities.programmes) problems.push('programme hours with nothing to run');
    if (counts.lockup >= 16) problems.push('locked up ' + counts.lockup + ' hours a day');
    return { counts: counts, problems: problems, facilities: facilities };
  };

  /* ============================================================
     9. WHAT THE FACILITY HAS

     Rooms and objects the regime needs, found once per facility beat
     and cached on the map so a per-prisoner lookup is a field read.
     ============================================================ */

  function spawnedList(map, defId) {
    var out = [], list = map.byDef ? map.byDef(defId) : null;
    if (!list) return out;
    for (var i = 0; i < list.length; i++) if (list[i].spawned !== false) out.push(list[i]);
    return out;
  }

  Prison.facilities = function (map) {
    map = map || (root.Game && root.Game.map);
    if (!map) return { showers: [], booths: [], posts: [], cameras: [], desks: [],
                       detectors: [], gates: [], yard: null, workshop: null, canteen: null,
                       programmes: false };
    var cache = map.__prisonFacilities;
    var t = now();
    if (cache && t - cache.tick < FACILITY_BEAT && cache.tick <= t) return cache.data;

    var data = {
      showers: spawnedList(map, 'prisonShower'),
      booths: spawnedList(map, 'visitorBooth'),
      posts: spawnedList(map, 'guardPost'),
      cameras: spawnedList(map, 'securityCamera'),
      desks: spawnedList(map, 'securityDesk'),
      detectors: spawnedList(map, 'metalDetector'),
      gates: spawnedList(map, 'prisonGate'),
      yard: null,
      workshop: null,
      canteen: null,
      programmes: false
    };
    var yard = Prison.yardCells(map), shop = Prison.workshopCells(map), mess = Prison.canteenCells(map);
    data.yard = yard.length ? yard : null;
    data.workshop = shop.length ? shop : null;
    data.canteen = mess.length ? mess : null;
    var Reform = sys('Reform');
    data.programmes = !!(Reform && (Reform.available || Reform.programmes));
    map.__prisonFacilities = { tick: t, data: data };
    return data;
  };

  /* ---------- player-painted prison areas ----------
     Three areas the player marks out by hand: the yard, the workshop
     and the canteen. They are cell-index sets on the state, so they
     survive rooms being renumbered and are cheap to test. */

  function areaSet(name) {
    var st = Prison.state;
    if (!st.areas) st.areas = { yard: [], workshop: [], canteen: [] };
    if (!st.areas[name]) st.areas[name] = [];
    return st.areas[name];
  }

  Prison.paintArea = function (map, name, cells, on) {
    if (!map || !cells) return 0;
    var list = areaSet(name), n = 0, i, idx;
    for (i = 0; i < cells.length; i++) {
      idx = typeof cells[i] === 'number' ? cells[i] : map.idx(cells[i].x, cells[i].y);
      if (idx < 0 || idx >= map.size) continue;
      var at = list.indexOf(idx);
      if (on === false) { if (at >= 0) { list.splice(at, 1); n++; } }
      else if (at < 0) { list.push(idx); n++; }
    }
    if (map.__prisonFacilities) map.__prisonFacilities = null;
    return n;
  };

  function areaCellsValid(map, name) {
    var list = areaSet(name), out = [];
    for (var i = 0; i < list.length; i++) {
      var idx = list[i];
      if (idx >= 0 && idx < map.size && map.pathCost[idx] < (map.IMPASSABLE || 65535)) out.push(idx);
    }
    return out;
  }

  Prison.yardCells = function (map) { return areaCellsValid(map, 'yard'); };
  Prison.workshopCells = function (map) { return areaCellsValid(map, 'workshop'); };
  Prison.canteenCells = function (map) { return areaCellsValid(map, 'canteen'); };

  Prison.areaCells = function (map, name) { return areaCellsValid(map, name); };

  /* Somewhere in a painted area a given prisoner can actually get to. */
  function areaTargetFor(pawn, name) {
    var map = pawn.map;
    var cells = areaCellsValid(map, name);
    if (!cells.length) return null;
    var best = null, bestD = 1e9;
    /* Sampled rather than walked: a yard can be two hundred tiles and
       this runs per prisoner per rare beat. */
    var step = Math.max(1, Math.floor(cells.length / 24));
    for (var i = 0; i < cells.length; i += step) {
      var x = map.xOf(cells[i]), y = map.yOf(cells[i]);
      var d = U.distSq(pawn.x, pawn.y, x, y);
      if (d >= bestD) continue;
      if (!reachable(map, pawn, x, y)) continue;
      bestD = d; best = { x: x, y: y };
    }
    return best;
  }

  /* The nearest usable object of a kind, reachable and unreserved. */
  function nearestUsable(pawn, defId) {
    var map = pawn.map, list = spawnedList(map, defId);
    var best = null, bestD = 1e9;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var d = U.distSq(pawn.x, pawn.y, t.x, t.y);
      if (d >= bestD) continue;
      if (!reachable(map, pawn, t.x, t.y)) continue;
      best = t; bestD = d;
    }
    return best;
  }

  /* ============================================================
     10. PRISONER NEEDS

     Six needs a colonist does not have, each on its own clock and
     each satisfiable only by something the player built and then
     scheduled. They are kept here rather than in pawn.needs because
     needs.js owns that set and this file does not edit it; they reach
     mood the way everything else does, through thoughts.
     ============================================================ */

  var NEED_LABELS = {
    hygiene: 'Hygiene', exercise: 'Exercise', privacy: 'Privacy',
    safety: 'Safety', family: 'Family contact', freedom: 'Freedom'
  };
  Prison.NEED_LABELS = NEED_LABELS;

  Prison.needs = function (pawn) {
    var ps = stateOf(pawn);
    return ps ? ps.needs : null;
  };

  Prison.needBreakdown = function (pawn) {
    var n = Prison.needs(pawn), out = [];
    if (!n) return out;
    for (var k in NEED_LABELS) out.push({ key: k, label: NEED_LABELS[k], value: n[k] });
    return out;
  };

  function gainNeed(ps, key, amount) {
    ps.needs[key] = U.clamp01(ps.needs[key] + amount);
  }

  /* Everything falls on the rare beat; what the activity gave them is
     added on top, so an hour of yard is a real, visible spike. */
  function tickNeedDecay(pawn, ps, cell) {
    var beat = RARE / DAY;
    var k;
    for (k in NEED_FALL) ps.needs[k] = U.clamp01(ps.needs[k] - NEED_FALL[k] * beat);

    /* A cell with a sink and a toilet slows the hygiene slide on its
       own - that is what the plumbing is for. */
    if (cell) {
      var hasSink = false, hasToilet = false;
      var map = pawn.map;
      for (var i = 0; i < cell.room.cells.length; i++) {
        var b = map.things.get(map.buildingId[cell.room.cells[i]]);
        if (!b || !b.def) continue;
        if (b.def.id === 'prisonSink') hasSink = true;
        else if (b.def.id === 'prisonToilet') hasToilet = true;
      }
      if (hasSink) gainNeed(ps, 'hygiene', NEED_FALL.hygiene * beat * 0.55);
      if (hasToilet) gainNeed(ps, 'hygiene', NEED_FALL.hygiene * beat * 0.30);
      /* Alone in a cell with a door is the only privacy in a prison. */
      if (cell.capacity === 1 && cell.occupants.length <= 1) {
        gainNeed(ps, 'privacy', NEED_FALL.privacy * beat * 2.2);
      } else if (cell.occupants.length > cell.capacity) {
        ps.needs.privacy = U.clamp01(ps.needs.privacy - NEED_FALL.privacy * beat);
      }
    }

    /* Safety is about who else is in the room, and it recovers when
       the room is quiet. */
    var threat = Prison.threatAround(pawn);
    if (threat > 0) ps.needs.safety = U.clamp01(ps.needs.safety - threat * beat * 1.4);
    else gainNeed(ps, 'safety', beat * 0.5);

    if (ps.solitaryLeft > 0) {
      ps.needs.freedom = U.clamp01(ps.needs.freedom - NEED_FALL.freedom * beat * 1.8);
      ps.needs.privacy = U.clamp01(ps.needs.privacy - NEED_FALL.privacy * beat * 0.5);
    }
  }

  /* How dangerous the immediate company is: a maximum-security
     prisoner in a minimum block, somebody already rioting, or a
     neighbour who has hurt people before. */
  Prison.threatAround = function (pawn) {
    var map = pawn.map;
    if (!map) return 0;
    var cell = Prison.cellOf(pawn);
    var list = cell ? cell.occupants : map.pawnsAt(pawn.x, pawn.y);
    var threat = 0;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o === pawn || !o.prisonState) continue;
      var ops = o.prisonState;
      if (ops.rioting) threat += 1.2;
      if (ops.category === 'maximum') threat += 0.5;
      if (ops.misconducts > 2) threat += 0.25;
      if (hasTrait(o, 'psychopath') || hasTrait(o, 'bloodlust')) threat += 0.4;
    }
    if (Prison.state.riots.length) threat += 0.6;
    return threat;
  };

  /* Needs become mood the moment they cross a line, and the thought is
     the sentence the player reads in the inspect panel. */
  function applyNeedThoughts(pawn, ps, cell) {
    var n = ps.needs;
    if (n.hygiene < 0.55) {
      think(pawn, 'prisonFilthy', { degree: n.hygiene < 0.18 ? 2 : (n.hygiene < 0.35 ? 1 : 0),
        duration: DAY * 0.5, noStack: true, situational: true });
    }
    if (n.exercise < 0.45) {
      think(pawn, 'prisonPenned', { degree: n.exercise < 0.2 ? 1 : 0,
        duration: DAY * 0.5, noStack: true, situational: true });
    }
    if (n.privacy < 0.3 && !hasTrait(pawn, 'ascetic')) {
      think(pawn, 'prisonNoPrivacy', { duration: DAY * 0.5, noStack: true, situational: true });
    }
    if (n.safety < 0.5) {
      think(pawn, 'prisonUnsafe', { degree: n.safety < 0.2 ? 1 : 0,
        duration: DAY * 0.5, noStack: true, situational: true });
    }
    if (n.family < 0.3) {
      think(pawn, 'prisonNoFamily', { duration: DAY, noStack: true, situational: true });
    }
    if (n.freedom < 0.5) {
      think(pawn, 'prisonCaged', { degree: n.freedom < 0.15 ? 2 : (n.freedom < 0.32 ? 1 : 0),
        duration: DAY * 0.5, noStack: true, situational: true });
    }

    if (cell) {
      var gi = cell.grade.gradeIndex;
      think(pawn, 'prisonCell', { degree: gi, duration: DAY * 0.5, noStack: true, situational: true });
      ps.lastGradeScore = cell.grade.score;
      if (cell.occupants.length > cell.capacity) {
        think(pawn, 'prisonCrowded', { degree: cell.occupants.length > cell.capacity + 1 ? 1 : 0,
          duration: DAY * 0.5, noStack: true, situational: true });
      }
      if (cell.holding) {
        think(pawn, 'prisonHolding', { duration: DAY, noStack: true, situational: true });
      }
      var block = Prison.block(cell.blockId);
      if (block && block.categories.indexOf('maximum') < 0) {
        for (var i = 0; i < cell.occupants.length; i++) {
          var o = cell.occupants[i];
          if (o !== pawn && o.prisonState && o.prisonState.category === 'maximum') {
            think(pawn, 'prisonMixedBlock', { duration: DAY * 0.5, noStack: true, situational: true });
            break;
          }
        }
      }
    } else {
      think(pawn, 'prisonHolding', { duration: DAY, noStack: true, situational: true });
    }

    if (ps.solitaryLeft > 0) {
      think(pawn, 'prisonSolitary', { degree: ps.solitaryTotal - ps.solitaryLeft > DAY ? 1 : 0,
        duration: DAY * 0.5, noStack: true, situational: true });
    }
    if (Prison.state.lockdown.on) {
      think(pawn, 'prisonLockdown', { duration: DAY * 0.4, noStack: true, situational: true });
    }

    /* The other side of the ledger: a prison that meets its needs is
       worth a standing lift, and it is the cheapest compliance in the
       game. */
    var met = (n.hygiene > 0.6) + (n.exercise > 0.55) + (n.freedom > 0.55) +
              (n.safety > 0.7) + (n.privacy > 0.5) + (n.family > 0.4);
    if (met >= 5 && cell && cell.grade.gradeIndex >= 3 && ps.solitaryLeft <= 0) {
      think(pawn, 'prisonFairRegime', { duration: DAY * 0.6, noStack: true, situational: true });
    }
  }

  /* ============================================================
     11. SECURITY AS GEOMETRY

     Posts, patrol routes, sightlines, cameras and door control. The
     spatial puzzle is the point: a corridor nobody can see from
     anywhere is the reason the escape planner starts scoring.
     ============================================================ */

  Prison.posts = function (map) {
    return Prison.facilities(map).posts;
  };

  Prison.assignPost = function (post, pawn) {
    if (!post || !post.def || post.def.id !== 'guardPost') return false;
    post.prisonGuardId = pawn ? pawn.id : 0;
    return true;
  };

  Prison.postOf = function (pawn) {
    if (!pawn || !pawn.map) return null;
    var posts = Prison.posts(pawn.map);
    for (var i = 0; i < posts.length; i++) if (posts[i].prisonGuardId === pawn.id) return posts[i];
    return null;
  };

  Prison.setPostShift = function (post, fromHour, toHour) {
    if (!post) return false;
    post.prisonFrom = U.clamp(fromHour | 0, 0, 23);
    post.prisonTo = U.clamp(toHour | 0, 0, 24);
    return true;
  };

  function postOnShift(post) {
    if (post.prisonFrom === undefined || post.prisonTo === undefined) return true;
    var h = Math.floor(hourNow());
    if (post.prisonFrom === post.prisonTo) return true;
    if (post.prisonFrom < post.prisonTo) return h >= post.prisonFrom && h < post.prisonTo;
    return h >= post.prisonFrom || h < post.prisonTo;   /* a shift across midnight */
  }

  /* ---------- patrol routes ---------- */

  Prison.patrols = function () { return Prison.state.patrols; };

  Prison.addPatrol = function (label, points) {
    var route = {
      id: nextId(),
      label: label || ('Patrol ' + (Prison.state.patrols.length + 1)),
      points: [],
      guardIds: [],
      fromHour: 0, toHour: 24,
      loop: true
    };
    if (points) for (var i = 0; i < points.length; i++) Prison.addPatrolPoint(route, points[i].x, points[i].y);
    Prison.state.patrols.push(route);
    return route;
  };

  Prison.patrol = function (id) {
    var list = Prison.state.patrols;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };

  Prison.addPatrolPoint = function (route, x, y) {
    if (!route) return false;
    route.points.push({ x: x | 0, y: y | 0 });
    return true;
  };

  Prison.removePatrolPoint = function (route, index) {
    if (!route || index < 0 || index >= route.points.length) return false;
    route.points.splice(index, 1);
    return true;
  };

  Prison.removePatrol = function (id) {
    var route = Prison.patrol(id);
    if (!route) return false;
    U.remove(Prison.state.patrols, route);
    return true;
  };

  Prison.assignPatrol = function (route, pawn, on) {
    if (!route || !pawn) return false;
    var at = route.guardIds.indexOf(pawn.id);
    if (on === false) { if (at >= 0) route.guardIds.splice(at, 1); return true; }
    if (at < 0) route.guardIds.push(pawn.id);
    return true;
  };

  Prison.patrolOf = function (pawn) {
    var list = Prison.state.patrols;
    for (var i = 0; i < list.length; i++) {
      if (list[i].guardIds.indexOf(pawn.id) >= 0 && list[i].points.length >= 2) return list[i];
    }
    return null;
  };

  function patrolOnShift(route) {
    if (route.fromHour === route.toHour) return true;
    var h = Math.floor(hourNow());
    if (route.fromHour < route.toHour) return h >= route.fromHour && h < route.toHour;
    return h >= route.fromHour || h < route.toHour;
  }

  /* ---------- sightlines and coverage ---------- */

  function lineOfSight(map, x1, y1, x2, y2) {
    var C = sys('Combat');
    if (C && C.lineOfSight) return C.lineOfSight(map, x1, y1, x2, y2);
    return U.cheb(x1, y1, x2, y2) <= 1;
  }

  var GUARD_SIGHT = 11;
  var CAMERA_SIGHT = 14;

  /* Is anybody watching this tile, and how well. 0 is a blind spot; 1
     is a guard standing in it. Cameras only count when a security desk
     somewhere has somebody sitting at it, which is the whole reason the
     desk exists. */
  Prison.coverageAt = function (map, x, y) {
    map = map || (root.Game && root.Game.map);
    if (!map) return 0;
    var best = 0, i;

    var pawns = map.pawns;
    for (i = 0; i < pawns.length; i++) {
      var g = pawns[i];
      if (g.dead || g.downed || !g.isHuman) continue;
      if (g.faction !== 'player' || g.prisoner) continue;
      var d = U.dist(g.x, g.y, x, y);
      if (d > GUARD_SIGHT) continue;
      if (!lineOfSight(map, g.x, g.y, x, y)) continue;
      var strength = U.clamp01(1 - d / GUARD_SIGHT);
      if (Prison.postOf(g) || Prison.patrolOf(g)) strength = U.clamp01(strength * 1.35);
      if (strength > best) best = strength;
    }

    var deskManned = Prison.deskManned(map);
    if (deskManned) {
      var cams = Prison.facilities(map).cameras;
      var P = sys('Power');
      for (i = 0; i < cams.length; i++) {
        var c = cams[i];
        if (P && P.isPowered && !P.isPowered(c)) continue;
        var cd = U.dist(c.x, c.y, x, y);
        if (cd > CAMERA_SIGHT) continue;
        if (!lineOfSight(map, c.x, c.y, x, y)) continue;
        var cs = U.clamp01(0.85 * (1 - cd / CAMERA_SIGHT)) * deskManned;
        if (cs > best) best = cs;
      }
    }
    return best;
  };

  /* 0 when no desk is manned, 1 for one watcher, up to 1.3 for two. */
  var _deskTick = -1, _deskValue = 0;

  Prison.deskManned = function (map) {
    var t = now();
    if (_deskTick === t) return _deskValue;
    _deskTick = t;
    _deskValue = 0;
    var desks = Prison.facilities(map).desks;
    if (!desks.length) return 0;
    var P = sys('Power'), watchers = 0, i, k;
    for (i = 0; i < desks.length; i++) {
      var d = desks[i];
      if (P && P.isPowered && !P.isPowered(d)) continue;
      for (var pass = 0; pass < 2; pass++) {
        var here = map.pawnsAt(d.x, d.y + pass);
        var found = false;
        for (k = 0; k < here.length; k++) {
          var p = here[k];
          if (p.dead || p.prisoner || p.faction !== 'player' || !p.isHuman) continue;
          if (p.job && p.job.defId === 'prisonWatchDesk') { watchers++; found = true; break; }
        }
        if (found) break;
      }
    }
    _deskValue = watchers ? (watchers === 1 ? 1 : 1.3) : 0;
    return _deskValue;
  };

  /* Average coverage over a cell's floor, which is the number the
     escape planner and the report both want. */
  Prison.cellCoverage = function (map, cell) {
    if (!cell || !cell.room) return 0;
    var cells = cell.room.cells, total = 0, n = 0;
    var step = Math.max(1, Math.floor(cells.length / 6));
    for (var i = 0; i < cells.length; i += step) {
      total += Prison.coverageAt(map, map.xOf(cells[i]), map.yOf(cells[i]));
      n++;
    }
    return n ? total / n : 0;
  };

  /* ---------- door control ---------- */

  var DOOR_MODES = ['open', 'staff', 'locked'];
  Prison.DOOR_MODES = DOOR_MODES;

  function isDoorThing(t) {
    return !!(t && t.def && t.def.building && t.def.building.isDoor);
  }

  Prison.doorLock = function (door) {
    if (!isDoorThing(door)) return null;
    return door.prisonLock || 'open';
  };

  Prison.setDoorLock = function (door, mode) {
    if (!isDoorThing(door)) return false;
    if (DOOR_MODES.indexOf(mode) < 0) return false;
    door.prisonLock = mode;
    return true;
  };

  Prison.doors = function (map) {
    map = map || (root.Game && root.Game.map);
    var out = [], defs = Defs.all('thing');
    for (var i = 0; i < defs.length; i++) {
      if (!defs[i].building || !defs[i].building.isDoor) continue;
      var list = spawnedList(map, defs[i].id);
      for (var k = 0; k < list.length; k++) out.push(list[k]);
    }
    return out;
  };

  /* Can this pawn walk through that door right now. Staff always can;
     a prisoner can only pass an open one, and only when nothing is
     holding the prison shut. */
  Prison.doorAllows = function (door, pawn) {
    if (!isDoorThing(door)) return true;
    var mode = Prison.doorLock(door);
    if (!pawn || !pawn.prisoner) return true;
    if (Prison.state.lockdown.on) return false;
    if (mode === 'open') return true;
    var ps = pawn.prisonState;
    return !!(ps && ps.escortTicks > 0);
  };

  /* Enforcement. The pathfinder does not know what a lock is, so the
     lock is enforced where the prisoner's foot lands: a path that is
     about to step onto a door they are not allowed through is cut, and
     they stand there. Cheap - one grid read per moving prisoner. */
  function enforceDoors(pawn) {
    if (!pawn.path || pawn.pathIdx >= pawn.path.length) return false;
    var map = pawn.map;
    var next = pawn.path[pawn.pathIdx];
    var bid = map.buildingId[next];
    if (!bid) return false;
    var door = map.things.get(bid);
    if (!isDoorThing(door)) return false;
    if (Prison.doorAllows(door, pawn)) return false;
    if (pawn.stopPath) pawn.stopPath();
    var J = sys('Jobs');
    if (pawn.job && J && J.end && pawn.job.defId !== 'layDown') J.end(pawn, 'interrupted');
    return true;
  }

  /* ---------- metal detectors ---------- */

  function checkDetectors(map, pawn, ps) {
    var dets = Prison.facilities(map).detectors;
    if (!dets.length) return;
    var P = sys('Power');
    for (var i = 0; i < dets.length; i++) {
      var d = dets[i];
      if (d.x !== pawn.x || d.y !== pawn.y) continue;
      if (P && P.isPowered && !P.isPowered(d)) return;
      if (ps.lastDetectorTick && now() - ps.lastDetectorTick < 600) return;
      ps.lastDetectorTick = now();
      Prison.searchPrisoner(pawn, null, { source: 'metal detector', quality: 0.85 });
      return;
    }
  }

  /* ---------- searches ---------- */

  /* One search of one prisoner. Contraband belongs to contraband.js
     when it is loaded; without it a search still finds the improvised
     weapon a rioter would otherwise have used, which is the part this
     file is entitled to own. */
  Prison.searchPrisoner = function (prisoner, searcher, opts) {
    opts = opts || {};
    if (!isPrisoner(prisoner)) return false;
    var ps = stateOf(prisoner);
    ps.searches++;
    ps.lastSearchTick = now();
    Prison.state.stats.searches++;

    var quality = opts.quality === undefined
      ? U.clamp01(0.4 + skillOf(searcher, 'shooting') * 0.02 + skillOf(searcher, 'social') * 0.02)
      : opts.quality;

    var found = 0;
    var C = sys('Contraband');
    if (C && C.searchPawn) {
      var r = C.searchPawn(prisoner, searcher, quality);
      found += (typeof r === 'number') ? r : (r ? 1 : 0);
    }

    /* A weapon in the inventory is the thing a prison search is for. */
    var inv = prisoner.inventory;
    if (inv && inv.length) {
      for (var i = inv.length - 1; i >= 0; i--) {
        var t = inv[i];
        if (!t || !t.def || !t.def.weapon) continue;
        if (!U.chance(quality)) continue;
        if (typeof prisoner.dropInventory === 'function') prisoner.dropInventory(t, prisoner.x, prisoner.y);
        else inv.splice(i, 1);
        found++;
      }
    }
    if (prisoner.equipment && U.chance(quality)) {
      if (typeof prisoner.dropEquipment === 'function') prisoner.dropEquipment();
      found++;
    }

    if (found) {
      ps.contrabandFound += found;
      Prison.state.stats.contrabandFound += found;
      ps.plan.score = Math.max(0, ps.plan.score - 0.25 * found);
      Prison.log('search',
        (searcher ? nameOf(searcher) + ' searched ' : 'The ' + (opts.source || 'search') + ' caught ') +
        fullName(prisoner) + ' and found ' + found + ' ' + U.plural(found, 'thing') + ' they should not have had.',
        { pawn: prisoner, blockId: ps.blockId, severity: 'warn' });
      Prison.addUnrest(ps.blockId, 0.02);
    } else if (searcher) {
      Prison.log('search', nameOf(searcher) + ' searched ' + fullName(prisoner) + ' and found nothing.',
        { pawn: prisoner, blockId: ps.blockId });
    }
    think(prisoner, 'prisonSearched', { duration: DAY * 0.4 });
    ps.plan.score = Math.max(0, ps.plan.score - 0.06);
    return found > 0;
  };

  /* Tossing a cell. Finds stashes, finds tunnels, and annoys everybody
     who lives in it - which is the trade the player is making. */
  Prison.shakedown = function (cell, searcher) {
    if (!cell) return 0;
    var map = searcher ? searcher.map : (root.Game && root.Game.map);
    var found = 0, i;
    Prison.state.stats.shakedowns++;
    for (i = 0; i < cell.beds.length; i++) cell.beds[i].prisonLastShakedown = now();

    var quality = U.clamp01(0.35 + skillOf(searcher, 'shooting') * 0.02 + skillOf(searcher, 'social') * 0.025);
    var C = sys('Contraband');
    if (C && C.searchCell) {
      var r = C.searchCell(cell, searcher, quality);
      found += (typeof r === 'number') ? r : (r ? 1 : 0);
    }

    /* A tunnel under this cell is found on a roll against how far it
       has got: a hole you could walk down is hard to miss. */
    var tunnels = Prison.tunnelsIn(cell);
    for (i = 0; i < tunnels.length; i++) {
      var tun = tunnels[i];
      if (tun.discovered) continue;
      if (!U.chance(U.clamp01(quality * 0.6 + tun.progress * 0.5))) continue;
      Prison.discoverTunnel(tun, searcher);
      found++;
    }

    for (i = 0; i < cell.occupants.length; i++) {
      var p = cell.occupants[i];
      if (!p.prisoner) continue;
      think(p, 'prisonSearched', { duration: DAY * 0.4 });
      var ps = stateOf(p);
      ps.plan.score = Math.max(0, ps.plan.score - 0.18);
    }
    Prison.addUnrest(cell.blockId, 0.025);

    Prison.log('shakedown',
      (searcher ? nameOf(searcher) : 'A guard') + ' turned over a ' + cell.kind + ' in ' +
      (Prison.block(cell.blockId) || { label: 'the prison' }).label +
      (found ? ' and found ' + found + ' ' + U.plural(found, 'thing') + '.' : ' and found nothing.'),
      { blockId: cell.blockId, x: cell.x, y: cell.y, severity: found ? 'warn' : 'note' });
    return found;
  };

  Prison.cellDueShakedown = function (cell) {
    var due = Prison.state.policy.shakedownDays * DAY;
    var last = 0;
    for (var i = 0; i < cell.beds.length; i++) {
      last = Math.max(last, cell.beds[i].prisonLastShakedown || 0);
    }
    return (now() - last) > due;
  };

  /* ============================================================
     12. SOLITARY

     A punishment with a timer, a cell that has to exist, and a cost
     to the mind that outlives the sentence. Marking a cell solitary
     is a build decision; sending somebody to it is a player decision;
     leaving them there is a player mistake.
     ============================================================ */

  Prison.setSolitaryCell = function (cell, on) {
    if (!cell || !cell.beds) return false;
    for (var i = 0; i < cell.beds.length; i++) cell.beds[i].prisonSolitary = !!on;
    _cellCache = null;
    return true;
  };

  Prison.setHoldingCell = function (cell, on) {
    if (!cell || !cell.beds) return false;
    for (var i = 0; i < cell.beds.length; i++) cell.beds[i].prisonHolding = !!on;
    _cellCache = null;
    return true;
  };

  Prison.solitaryCells = function (map) {
    var cells = Prison.cells(map), out = [];
    for (var i = 0; i < cells.length; i++) if (cells[i].solitary) out.push(cells[i]);
    return out;
  };

  Prison.sendToSolitary = function (pawn, hours, reason) {
    if (!isPrisoner(pawn)) return false;
    var map = pawn.map;
    var free = null, spare = null, cells = Prison.solitaryCells(map), occupied = 0, unreachable = 0;
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      var taken = false;
      for (var k = 0; k < c.occupants.length; k++) {
        if (c.occupants[k] !== pawn && c.occupants[k].prisoner) taken = true;
      }
      if (taken) { occupied++; continue; }
      if (!reachable(map, pawn, c.x, c.y)) { unreachable++; if (!spare) spare = c; continue; }
      free = c; break;
    }
    if (!free && spare) free = spare;
    if (!free) {
      Prison.lastRefusal = !cells.length ? 'no solitary cell has been marked out'
        : (occupied ? 'every solitary cell is occupied' : 'no solitary cell can be reached');
      Prison.log('discipline',
        'There was nowhere to put ' + fullName(pawn) + ': ' + Prison.lastRefusal + '.',
        { pawn: pawn, severity: 'warn' });
      return false;
    }

    var ps = stateOf(pawn);
    var ticks = U.clamp((hours === undefined ? Prison.state.policy.solitaryHours : hours) * HOUR,
      HOUR, SOLITARY_MAX);
    ps.solitaryLeft = ticks;
    ps.solitaryTotal = ticks;
    ps.solitaryReason = reason || 'misconduct';
    ps.solitaryBedId = free.beds[0].id;
    ps.previousBedId = pawn.ownedBedId || 0;
    Prison.state.stats.solitaryTerms++;
    Prison.assignCell(pawn, free.beds[0], { force: true, allowMixing: true });

    Prison.log('discipline',
      fullName(pawn) + ' sent to solitary for ' + Math.round(ticks / HOUR) + ' hours - ' + ps.solitaryReason + '.',
      { pawn: pawn, blockId: ps.blockId, severity: 'warn' });
    Prison.addUnrest(ps.blockId, 0.03);
    return true;
  };

  Prison.releaseFromSolitary = function (pawn, early) {
    var ps = pawn && pawn.prisonState;
    if (!ps || ps.solitaryLeft <= 0) return false;
    var served = ps.solitaryTotal - ps.solitaryLeft;
    ps.solitaryLeft = 0;
    ps.solitaryBedId = 0;

    /* The mark it leaves. Days of it and they carry it for a week. */
    var days = served / DAY;
    if (days > 0.2) {
      think(pawn, 'prisonSolitaryAfter', { duration: DAY * (3 + days * 2) });
      ps.needs.safety = U.clamp01(ps.needs.safety - 0.2);
      ps.needs.freedom = U.clamp01(ps.needs.freedom - 0.15);
    }
    if (days > 1.5) {
      /* Long enough and it stops being a punishment and starts being
         damage. The resistance they had left hardens. */
      var st = pawn.prisoner;
      if (st) st.resistance += 1.5 * (days - 1.5);
      ps.misconducts++;
    }
    if (Prison.state.policy.autoAssignCells) Prison.autoAssign(pawn);
    Prison.log('discipline',
      fullName(pawn) + (early ? ' let out of solitary early' : ' finished their time in solitary') +
      ' after ' + U.fmt(days * 24, 1) + ' hours.',
      { pawn: pawn, blockId: ps.blockId });
    return true;
  };

  /* Misconduct is the common entry point: a fight, a found weapon, a
     failed escape. It escalates, and the escalation is a policy. */
  Prison.noteMisconduct = function (pawn, what, weight) {
    if (!isPrisoner(pawn)) return false;
    var ps = stateOf(pawn);
    ps.misconducts += (weight || 1);
    ps.strikes++;
    Prison.log('misconduct', fullName(pawn) + ': ' + what + '.',
      { pawn: pawn, blockId: ps.blockId, severity: 'warn' });
    Prison.addUnrest(ps.blockId, 0.02 * (weight || 1));

    if (Prison.state.policy.autoClassify && !ps.categorySetByPlayer) {
      var want = Prison.classifyRaw(pawn).category;
      if (CATEGORY_RANK[want] > CATEGORY_RANK[ps.category]) Prison.setCategory(pawn, want, false);
    }
    if (Prison.state.policy.autoSolitaryOnMisconduct && ps.strikes >= 2 && ps.solitaryLeft <= 0) {
      ps.strikes = 0;
      ps.solitaryWanted = true;      /* a guard comes and gets them */
    }
    return true;
  };

  /* ============================================================
     13. ESCAPE

     Not a die roll. A prisoner accumulates a plan out of what the
     prison is actually giving them - a blind corridor, a door left on
     open, a guard shortfall, a tool somebody dropped, a wall they can
     get behind - multiplied by how badly they want out. When the plan
     is good enough they go, and they take whoever else is ready.
     ============================================================ */

  /* The named weaknesses, so the player can be told which one of their
     decisions is being exploited. */
  Prison.opportunity = function (pawn) {
    var map = pawn.map, ps = stateOf(pawn);
    if (!map) return { score: 0, reasons: [] };
    var reasons = [], score = 0, v;

    var cell = Prison.cellOf(pawn);
    var coverage = cell ? Prison.cellCoverage(map, cell) : Prison.coverageAt(map, pawn.x, pawn.y);
    v = (1 - coverage) * 0.45;
    if (v > 0.12) reasons.push({ label: 'nobody is watching', value: v });
    score += v;

    /* An unlocked door out of the block is the classic one. */
    if (cell && cell.room && cell.room.doorIds.length) {
      var openDoor = 0;
      for (var i = 0; i < cell.room.doorIds.length; i++) {
        var d = map.thing(cell.room.doorIds[i]);
        if (!d) continue;
        if (Prison.doorLock(d) === 'open') openDoor++;
      }
      if (openDoor) {
        v = 0.22 * Math.min(openDoor, 2);
        reasons.push({ label: 'a door on open', value: v });
        score += v;
      }
    } else if (cell && cell.room && !cell.room.doorIds.length && cell.room.outdoor) {
      reasons.push({ label: 'no walls at all', value: 0.5 });
      score += 0.5;
    }

    var staff = Prison.staffing(map);
    if (staff.shortfall > 0) {
      v = U.clamp(staff.shortfall * 0.28, 0, 0.35);
      reasons.push({ label: 'not enough guards on', value: v });
      score += v;
    }

    /* Something they could dig or cut with, lying where they can get
       at it. Builders leave these behind. */
    if (Prison.toolNear(pawn)) {
      reasons.push({ label: 'a tool within reach', value: 0.18 });
      score += 0.18;
    }

    /* A wall worth going through: wooden, damaged, or one tile of
       anything between them and the open air. */
    var weak = Prison.weakWallNear(pawn);
    if (weak) {
      v = weak.wooden ? 0.2 : 0.12;
      reasons.push({ label: weak.wooden ? 'a wooden wall' : 'a damaged wall', value: v });
      score += v;
    }

    var block = cell ? Prison.block(cell.blockId) : null;
    if (block && block.categories.indexOf(ps.category) < 0) {
      reasons.push({ label: 'housed below their category', value: 0.2 });
      score += 0.2;
    }

    if (Prison.state.riots.length) {
      reasons.push({ label: 'the block is rioting', value: 0.3 });
      score += 0.3;
    }
    if (Prison.state.lockdown.on) {
      reasons.push({ label: 'lockdown', value: -0.35 });
      score -= 0.35;
    }
    if (ps.solitaryLeft > 0) {
      reasons.push({ label: 'in solitary', value: -0.3 });
      score -= 0.3;
    }

    reasons.sort(function (a, b) { return Math.abs(b.value) - Math.abs(a.value); });
    return { score: U.clamp01(score), reasons: reasons, coverage: coverage };
  };

  Prison.toolNear = function (pawn) {
    var map = pawn.map;
    var cells = U.cellsInRadius(pawn.x, pawn.y, 3);
    for (var i = 0; i < cells.length; i++) {
      var cx = cells[i][0], cy = cells[i][1];
      if (!map.inBounds(cx, cy)) continue;
      var items = map.items(cx, cy);
      for (var k = 0; k < items.length; k++) {
        var d = items[k].def;
        if (!d) continue;
        if (d.weapon || d.id === 'steel' || d.id === 'stoneChunk' || d.id === 'components') return items[k];
      }
    }
    return null;
  };

  Prison.weakWallNear = function (pawn) {
    var map = pawn.map;
    var cell = Prison.cellOf(pawn);
    var cells = cell && cell.room ? cell.room.cells : null;
    if (!cells) return null;
    var seen = {}, i, k;
    for (i = 0; i < cells.length; i++) {
      var x = map.xOf(cells[i]), y = map.yOf(cells[i]);
      for (k = 0; k < U.ADJ4.length; k++) {
        var nx = x + U.ADJ4[k][0], ny = y + U.ADJ4[k][1];
        if (!map.inBounds(nx, ny)) continue;
        var key = ny * map.w + nx;
        if (seen[key]) continue;
        seen[key] = 1;
        var b = map.buildingAt(nx, ny);
        if (!b || !b.def || b.def.passable !== false) continue;
        if (b.def.natural) continue;
        var wooden = b.stuff === 'wood' || (b.def.stuffable && !b.stuff && b.def.buildCost && b.def.buildCost.wood);
        var damaged = b.hp !== undefined && b.def.hp && b.hp < b.def.hp * 0.55;
        if (wooden || damaged) return { thing: b, wooden: !!wooden, damaged: !!damaged, x: nx, y: ny };
      }
    }
    return null;
  };

  /* How badly they want out, which is what the opportunity multiplies. */
  function escapeMotivation(pawn, ps) {
    var st = pawn.prisoner;
    var m = 0.25;
    m += U.clamp(st ? st.resistance / 30 : 0.3, 0, 1) * 0.45;
    m += (1 - ps.needs.freedom) * 0.4;
    m += (1 - moodOf(pawn)) * 0.35;
    m += U.clamp(Prison.unrestOf(ps.blockId), 0, 1) * 0.3;
    if (st && st.mode === 'execute') m += 0.6;
    if (hasTrait(pawn, 'ironWilled')) m *= 1.25;
    if (hasTrait(pawn, 'wimp')) m *= 0.75;
    var H = sys('Health');
    var legs = (H && H.capacity) ? H.capacity(pawn, 'moving') : 1;
    return U.clamp(m, 0, 2) * U.clamp01(legs * 1.2);
  }

  /* ---------- tunnels ---------- */

  Prison.tunnels = function () { return Prison.state.tunnels; };

  Prison.tunnelsIn = function (cell) {
    var out = [], list = Prison.state.tunnels;
    if (!cell || !cell.room) return out;
    for (var i = 0; i < list.length; i++) {
      if (cell.room.cells.indexOf(list[i].fromIdx) >= 0) out.push(list[i]);
    }
    return out;
  };

  Prison.tunnelOf = function (pawn) {
    var ps = pawn && pawn.prisonState;
    if (!ps || !ps.plan.tunnelId) return null;
    var list = Prison.state.tunnels;
    for (var i = 0; i < list.length; i++) if (list[i].id === ps.plan.tunnelId) return list[i];
    return null;
  };

  /* A tunnel runs from a cell tile to the nearest tile outside the
     prison that is not in a room. Its length is what makes it take
     days, and the exit is a real wall that comes down at the end. */
  function startTunnel(pawn, ps) {
    var map = pawn.map;
    var cell = Prison.cellOf(pawn);
    if (!cell || !cell.room || cell.room.outdoor) return null;
    var weak = Prison.weakWallNear(pawn);
    var fromIdx = map.idx(pawn.x, pawn.y);

    /* Pick a direction: through the weak wall if there is one, else
       toward the nearest map edge. */
    var tx, ty;
    if (weak) { tx = weak.x; ty = weak.y; }
    else {
      var dLeft = pawn.x, dRight = map.w - 1 - pawn.x, dUp = pawn.y, dDown = map.h - 1 - pawn.y;
      var best = Math.min(dLeft, dRight, dUp, dDown);
      tx = pawn.x; ty = pawn.y;
      if (best === dLeft) tx = 0;
      else if (best === dRight) tx = map.w - 1;
      else if (best === dUp) ty = 0;
      else ty = map.h - 1;
    }

    /* Walk out from the cell until the room ends; that tile is where
       the tunnel must surface. */
    var dx = U.sign(tx - pawn.x), dy = U.sign(ty - pawn.y);
    var cx = pawn.x, cy = pawn.y, steps = 0, exitX = pawn.x, exitY = pawn.y;
    while (steps < 14) {
      cx += dx; cy += dy; steps++;
      if (!map.inBounds(cx, cy)) break;
      var rid = roomIdAt(map, cx, cy);
      if (rid !== cell.roomId && map.pathCost[map.idx(cx, cy)] < (map.IMPASSABLE || 65535)) {
        exitX = cx; exitY = cy; break;
      }
      exitX = cx; exitY = cy;
    }
    if (exitX === pawn.x && exitY === pawn.y) return null;

    var tunnel = {
      id: nextId(),
      fromIdx: fromIdx,
      exitIdx: map.idx(exitX, exitY),
      length: Math.max(2, U.manhattan(pawn.x, pawn.y, exitX, exitY)),
      progress: 0,
      discovered: false,
      diggerIds: [pawn.id],
      startedTick: now(),
      blockId: ps.blockId
    };
    Prison.state.tunnels.push(tunnel);
    ps.plan.tunnelId = tunnel.id;
    Prison.log('escape',
      fullName(pawn) + ' has started scraping at the floor of their cell. Nobody has noticed.',
      { pawn: pawn, blockId: ps.blockId, severity: 'note' });
    return tunnel;
  }

  Prison.discoverTunnel = function (tunnel, byWhom) {
    if (!tunnel || tunnel.discovered) return false;
    tunnel.discovered = true;
    Prison.state.stats.tunnelsFound++;
    var G = root.Game, map = G && G.map;
    for (var i = 0; i < tunnel.diggerIds.length; i++) {
      var p = pawnById(map, tunnel.diggerIds[i]);
      if (!p) continue;
      var ps = stateOf(p);
      ps.plan.tunnelId = 0;
      ps.plan.score = Math.max(0, ps.plan.score - 0.5);
      Prison.noteMisconduct(p, 'caught digging a tunnel', 2);
    }
    U.remove(Prison.state.tunnels, tunnel);
    letter('A tunnel under the cells',
      (byWhom ? nameOf(byWhom) : 'A guard') + ' found a tunnel running out from under a cell, ' +
      U.pct(tunnel.progress) + ' of the way to the outside. It has been filled in, and ' +
      'whoever was digging it is on the book.',
      'threat', byWhom);
    Prison.log('escape', 'A tunnel was found at ' + U.pct(tunnel.progress) + ' progress.',
      { blockId: tunnel.blockId, severity: 'warn',
        x: map ? map.xOf(tunnel.fromIdx) : -1, y: map ? map.yOf(tunnel.fromIdx) : -1 });
    return true;
  };

  function pawnById(map, id) {
    if (!map) return null;
    for (var i = 0; i < map.pawns.length; i++) if (map.pawns[i].id === id) return map.pawns[i];
    return null;
  }

  /* When a tunnel completes, the wall it surfaces under comes down.
     The player sees a hole, which is the honest way to be told. */
  function breachTunnel(map, tunnel) {
    var x = map.xOf(tunnel.exitIdx), y = map.yOf(tunnel.exitIdx);
    var b = map.buildingAt(x, y);
    if (b && b.def && b.def.passable === false && !b.def.natural) {
      map.destroyThing(b, 'tunnelled under');
    } else if (b && b.def && b.def.natural) {
      var Con = sys('Construct');
      if (Con && Con.completeMine) Con.completeMine(map, x, y, null);
      else map.destroyThing(b, 'tunnelled under');
    }
    return { x: x, y: y };
  }

  /* The moment they go. prisoners.js owns the run itself: setting the
     three fields it drives from is what hands the escape over to it,
     so the warden work giver that chases escapees still works. */
  Prison.beginEscape = function (pawn, reason, targetIdx) {
    var st = pawn && pawn.prisoner;
    if (!st || st.escaping) return false;
    var map = pawn.map, ps = stateOf(pawn);

    var idx = targetIdx;
    if (idx === undefined || idx === null || idx < 0) {
      var MG = sys('MapGen');
      var sides = ['n', 'e', 's', 'w'], cands = [];
      if (MG && MG.edgeSpawnCells) {
        for (var i = 0; i < sides.length; i++) {
          var cells = MG.edgeSpawnCells(map, sides[i]);
          for (var k = 0; k < cells.length; k += 2) {
            if (map.passable(cells[k].x, cells[k].y)) cands.push(cells[k]);
          }
        }
      }
      var best = null, bestD = 1e12, near = null, nearD = 1e12;
      for (var c = 0; c < cands.length; c++) {
        var d = U.distSq(pawn.x, pawn.y, cands[c].x, cands[c].y);
        if (d < nearD) { nearD = d; near = cands[c]; }
        if (d < bestD && reachable(map, pawn, cands[c].x, cands[c].y)) { bestD = d; best = cands[c]; }
      }
      /* A target it cannot reach is still better than none: prisoners.js
         re-picks the moment its own escape job cannot path there. */
      if (!best) best = near;
      if (!best) return false;
      idx = map.idx(best.x, best.y);
    }

    st.escaping = true;
    st.escapeWill = 1;
    st.escapeTargetIdx = idx;
    st.confineCool = 0;
    ps.escapeAttempts++;
    ps.plan.score = 0;
    Prison.state.stats.escapes++;

    letter('A prisoner is going over the wall',
      fullName(pawn) + ' is making a run for it - ' + reason + '. They have been planning this ' +
      'for a while; the prison gave them the opening.',
      'threat', pawn);
    Prison.log('escape', fullName(pawn) + ' broke out: ' + reason + '.',
      { pawn: pawn, blockId: ps.blockId, severity: 'major' });

    if (Prison.state.policy.lockdownOnEscape) Prison.setLockdown(true, 'an escape attempt', ps.blockId);
    return true;
  };

  /* One prisoner's planning beat. */
  function tickEscapePlan(pawn, ps) {
    var st = pawn.prisoner;
    if (!st || st.escaping) return;
    if (pawn.downed || ps.solitaryLeft > 0) return;

    var opp = Prison.opportunity(pawn);
    ps.plan.opportunity = opp.score;
    ps.plan.reason = opp.reasons.length ? opp.reasons[0].label : '';

    var motive = escapeMotivation(pawn, ps);
    var gain = opp.score * motive * PLAN_GAIN - PLAN_DECAY;
    ps.plan.score = U.clamp(ps.plan.score + gain, 0, 2);

    /* Digging: slow, invisible, and the only way out of a cell with
       no door they can reach. */
    var tunnel = Prison.tunnelOf(pawn);
    if (!tunnel && ps.plan.score > TUNNEL_START && opp.coverage < 0.35 && U.chance(0.25)) {
      tunnel = startTunnel(pawn, ps);
    }
    if (tunnel) {
      var digging = ps.activity === 'lockup' || ps.activity === 'free' || ps.activity === 'solitary';
      if (digging && !pawn.downed) {
        var pace = U.clamp(8 / tunnel.length, 0.6, 1.6);
        tunnel.progress = U.clamp01(tunnel.progress + TUNNEL_WORK_PER_BEAT * pace *
          (1 + tunnel.diggerIds.length * 0.35));
        if (tunnel.diggerIds.indexOf(pawn.id) < 0) tunnel.diggerIds.push(pawn.id);
      }
      /* A camera on the cell, or a guard walking past, can notice. */
      if (opp.coverage > 0.5 && U.chance(0.05 * opp.coverage)) {
        Prison.discoverTunnel(tunnel, null);
        return;
      }
      if (tunnel.progress >= 1) {
        var hole = breachTunnel(pawn.map, tunnel);
        U.remove(Prison.state.tunnels, tunnel);
        ps.plan.tunnelId = 0;
        for (var i = 0; i < tunnel.diggerIds.length; i++) {
          var mate = pawnById(pawn.map, tunnel.diggerIds[i]);
          if (mate && mate.prisoner && !mate.dead && !mate.downed) {
            Prison.beginEscape(mate, 'the tunnel they dug came out past the wall',
              pawn.map.idx(hole.x, hole.y));
          }
        }
        return;
      }
    }

    if (ps.plan.score < ESCAPE_READY) return;

    /* They go, and anyone in the same block who is nearly ready goes
       with them. A break is not usually one person. */
    Prison.beginEscape(pawn, opp.reasons.length ? opp.reasons[0].label : 'they saw their chance');
    var mates = prisonersOf(pawn.map);
    var went = 0;
    for (var m = 0; m < mates.length; m++) {
      var o = mates[m];
      if (o === pawn || !o.prisonState || o.downed) continue;
      if (o.prisonState.blockId !== ps.blockId) continue;
      if (o.prisonState.plan.score < ESCAPE_READY * 0.65) continue;
      if (o.prisoner.escaping) continue;
      if (Prison.beginEscape(o, 'they went with ' + nameOf(pawn),
          pawn.prisoner.escapeTargetIdx)) {
        ps.plan.partners.push(o.id);
        went++;
      }
      if (went >= 4) break;
    }
    if (went) {
      Prison.log('escape', went + ' more went out with ' + fullName(pawn) + '.',
        { pawn: pawn, blockId: ps.blockId, severity: 'major' });
    }
  }

  /* ============================================================
     14. STAFFING, UNREST, LOCKDOWN AND RIOTS
     ============================================================ */

  /* Guard-hours wanted against guard-hours on the floor. A colonist
     counts as staff when the guard column is on and they are not
     asleep, downed or in a cell themselves. */
  Prison.staffing = function (map) {
    map = map || (root.Game && root.Game.map);
    var need = 0, have = 0, onPost = 0, onPatrol = 0, guards = 0;
    if (!map) return { need: 0, have: 0, shortfall: 0, guards: 0, onPost: 0, onPatrol: 0, ratio: 1 };

    var prisoners = prisonersOf(map);
    for (var i = 0; i < prisoners.length; i++) {
      var ps = stateOf(prisoners[i]);
      need += GUARD_COST[ps.category] || GUARD_COST.medium;
    }

    var pawns = map.pawns;
    for (var k = 0; k < pawns.length; k++) {
      var p = pawns[k];
      if (p.dead || p.prisoner || !p.isHuman || p.faction !== 'player') continue;
      if (!p.workPriority || !p.workPriority.guard) continue;
      guards++;
      if (p.downed || (p.job && (p.job.defId === 'sleep' || p.job.defId === 'layDown'))) continue;
      var post = Prison.postOf(p), patrol = Prison.patrolOf(p);
      var worth = 0.4;                    /* just being available       */
      if (post) { onPost++; worth = 1; }
      else if (patrol) { onPatrol++; worth = 0.9; }
      else if (p.job && p.job.defId === 'prisonWatchDesk') worth = 0.8;
      /* The warden column counts for half: feeding and talking is not
         watching, but somebody in the block is somebody in the block. */
      if (!post && !patrol && p.workPriority.warden) worth = Math.max(worth, 0.5);
      have += worth;
    }

    var ratio = need > 0 ? have / need : 1;
    return {
      need: Math.round(need * 100) / 100,
      have: Math.round(have * 100) / 100,
      shortfall: Math.max(0, need - have),
      ratio: ratio,
      guards: guards, onPost: onPost, onPatrol: onPatrol
    };
  };

  Prison.unrestOf = function (blockId) {
    return Prison.state.unrest[blockId || 1] || 0;
  };

  Prison.addUnrest = function (blockId, amount) {
    var id = blockId || 1;
    var u = Prison.state.unrest;
    u[id] = U.clamp01((u[id] || 0) + amount);
    return u[id];
  };

  Prison.setLockdown = function (on, reason, blockId) {
    var L = Prison.state.lockdown;
    if (on) {
      if (L.on && L.blockId === (blockId || 0)) { L.ticksLeft = LOCKDOWN_MAX; return true; }
      L.on = true;
      L.reason = reason || 'the warden said so';
      L.blockId = blockId || 0;
      L.ticksLeft = LOCKDOWN_MAX;
      L.startedTick = now();
      letter('Lockdown',
        'The prison is locked down: ' + L.reason + '. Every door is held shut, nobody comes out ' +
        'of their cell, and every hour of it is an hour of the regime you are not running.',
        'threat');
      Prison.log('lockdown', 'Lockdown declared - ' + L.reason + '.',
        { blockId: L.blockId, severity: 'major' });
    } else {
      if (!L.on) return false;
      Prison.log('lockdown', 'Lockdown lifted after ' + U.fmt((now() - L.startedTick) / HOUR, 1) + ' hours.',
        { blockId: L.blockId });
      L.on = false; L.ticksLeft = 0; L.reason = ''; L.blockId = 0;
      msg('The lockdown is over.', null, 'info');
    }
    return true;
  };

  Prison.lockdown = function () { return Prison.state.lockdown; };

  /* Where unrest comes from. Every term is something the player did or
     failed to do, and the report prints them in this order. */
  Prison.unrestSources = function (map, blockId) {
    map = map || (root.Game && root.Game.map);
    var out = [], cells = Prison.cells(map), i;
    var gradeSum = 0, gradeN = 0, over = 0, capacity = 0, occupied = 0;
    for (i = 0; i < cells.length; i++) {
      if (cells[i].blockId !== blockId) continue;
      gradeSum += cells[i].grade.norm; gradeN++;
      capacity += cells[i].capacity;
      occupied += cells[i].occupants.length;
      if (cells[i].occupants.length > cells[i].capacity) over += cells[i].occupants.length - cells[i].capacity;
    }
    var grade = gradeN ? gradeSum / gradeN : 0.5;
    out.push({ label: 'cell grade', value: (0.55 - grade) * 0.0006 });
    if (over) out.push({ label: 'overcrowding', value: over * 0.00022 });

    var prisoners = prisonersOf(map), deficit = 0, n = 0, mixed = 0;
    var block = Prison.block(blockId);
    for (i = 0; i < prisoners.length; i++) {
      var ps = prisoners[i].prisonState;
      if (!ps || ps.blockId !== blockId) continue;
      n++;
      var nd = ps.needs;
      deficit += (1 - nd.hygiene) + (1 - nd.exercise) + (1 - nd.freedom) +
                 (1 - nd.safety) + (1 - nd.family) * 0.5;
      if (block && block.categories.indexOf(ps.category) < 0) mixed++;
    }
    if (n) out.push({ label: 'unmet needs', value: (deficit / (n * 4.5)) * 0.0011 });
    if (mixed) out.push({ label: 'categories mixed', value: mixed * 0.00018 });

    var staff = Prison.staffing(map);
    if (staff.shortfall > 0) {
      out.push({ label: 'guard shortfall', value: U.clamp(staff.shortfall, 0, 6) * 0.00009 });
    }

    var C = sys('Contraband');
    if (C && C.gangPressure) {
      var gp = C.gangPressure(blockId) || 0;
      if (gp) out.push({ label: 'gang pressure', value: gp * 0.0009 });
    }

    if (Prison.state.lockdown.on) out.push({ label: 'lockdown holds them down', value: -0.0005 });
    if (n === 0) out.push({ label: 'nobody in the block', value: -0.01 });
    else out.push({ label: 'time passing quietly', value: -0.00035 });
    return out;
  };

  function tickUnrest(map) {
    var blocks = Prison.state.blocks;
    for (var b = 0; b < blocks.length; b++) {
      var id = blocks[b].id;
      var sources = Prison.unrestSources(map, id), delta = 0;
      for (var i = 0; i < sources.length; i++) delta += sources[i].value;
      var before = Prison.unrestOf(id);
      var after = Prison.addUnrest(id, delta);

      if (before < 0.5 && after >= 0.5) {
        msg((blocks[b].label || 'A block') + ' is getting restless.', null, 'threat');
      }
      var cooling = (Prison.state.lastRiotTick || {})[id] || 0;
      if (after >= RIOT_THRESHOLD && !riotIn(id) && now() - cooling > RIOT_COOLDOWN &&
          U.chance(RIOT_CHANCE_PER_BEAT)) {
        Prison.startRiot(id);
      }
    }
  }

  function riotIn(blockId) {
    var list = Prison.state.riots;
    for (var i = 0; i < list.length; i++) if (list[i].blockId === blockId) return list[i];
    return null;
  }
  Prison.riotIn = riotIn;
  Prison.riots = function () { return Prison.state.riots; };

  /* ---------- riots ---------- */

  /* Something to hit with. A rioter picks up whatever is lying around
     rather than politely going bare-handed. */
  function armRioter(pawn) {
    if (pawn.equipment) return true;
    var map = pawn.map, cells = U.cellsInRadius(pawn.x, pawn.y, 4);
    for (var i = 0; i < cells.length; i++) {
      if (!map.inBounds(cells[i][0], cells[i][1])) continue;
      var items = map.items(cells[i][0], cells[i][1]);
      for (var k = 0; k < items.length; k++) {
        if (!items[k].def || !items[k].def.weapon) continue;
        if (typeof pawn.equip === 'function' && pawn.equip(items[k])) return true;
      }
    }
    return false;
  }

  Prison.startRiot = function (blockId) {
    var G = root.Game, map = G && G.map;
    if (!map) return null;
    var block = Prison.block(blockId) || { id: blockId, label: 'the cells' };
    var prisoners = prisonersOf(map), joining = [];
    for (var i = 0; i < prisoners.length; i++) {
      var p = prisoners[i];
      var ps = p.prisonState;
      if (!ps || ps.blockId !== blockId) continue;
      if (p.downed || p.dead) continue;
      if (ps.solitaryLeft > 0) continue;
      /* Who joins: the angry, the dangerous and the ones with nothing
         left to lose. The calm and the nearly-recruited sit it out. */
      var willing = (1 - moodOf(p)) * 0.8 + Prison.unrestOf(blockId) * 0.6 +
                    (ps.category === 'maximum' ? 0.25 : 0) +
                    (hasTrait(p, 'volatile') ? 0.25 : 0) +
                    (hasTrait(p, 'psychopath') ? 0.2 : 0) -
                    (p.prisoner && p.prisoner.resistance < 3 ? 0.4 : 0);
      if (U.chance(U.clamp01(willing))) joining.push(p);
    }
    if (joining.length < 2) {
      Prison.state.unrest[blockId] = 0.55;
      return null;
    }

    var riot = {
      id: nextId(), blockId: blockId, startedTick: now(),
      rioterIds: [], instigatorId: joining[0].id,
      damage: 0, injuries: 0, deaths: 0, negotiated: false
    };
    for (var k = 0; k < joining.length; k++) {
      var r = joining[k];
      var rs = stateOf(r);
      rs.rioting = true;
      rs.riotTicks = 0;
      riot.rioterIds.push(r.id);
      armRioter(r);
      var Think = sys('Think');
      if (Think && Think.startMentalState && (k < 2 || U.chance(0.45))) {
        Think.startMentalState(r, 'berserk');
      }
      Prison.noteMisconduct(r, 'took part in a riot', 2);
    }
    Prison.state.riots.push(riot);
    if (!Prison.state.lastRiotTick) Prison.state.lastRiotTick = {};
    Prison.state.lastRiotTick[blockId] = now();
    Prison.state.stats.riots++;
    Prison.state.unrest[blockId] = 1;

    var C = sys('Contraband');
    if (C && C.onRiot) C.onRiot(riot);

    /* The colony hears about it whether or not anybody is hurt yet. */
    var colonists = map.colonists();
    for (var c = 0; c < colonists.length; c++) {
      think(colonists[c], 'prisonRiotSeen', { duration: DAY * 3 });
    }

    letter('Riot in ' + block.label,
      joining.length + ' prisoners have taken ' + block.label + ' apart. They are armed with ' +
      'whatever was lying about and they are not going back into their cells on their own. ' +
      'Lock the prison down, send people in, or talk to them.',
      'threat', joining[0]);
    Prison.log('riot', 'Riot began in ' + block.label + ' with ' + joining.length + ' prisoners.',
      { blockId: blockId, pawn: joining[0], severity: 'major' });

    if (Prison.state.policy.lockdownOnRiot) Prison.setLockdown(true, 'a riot in ' + block.label, blockId);
    return riot;
  };

  function tickRiots(map) {
    var list = Prison.state.riots;
    for (var i = list.length - 1; i >= 0; i--) {
      var riot = list[i];
      var active = 0, ids = riot.rioterIds;
      for (var k = 0; k < ids.length; k++) {
        var p = pawnById(map, ids[k]);
        if (!p || p.dead) continue;
        var ps = p.prisonState;
        if (!ps || !ps.rioting) continue;
        if (p.downed) { ps.rioting = false; continue; }
        ps.riotTicks += FAST_BEAT;
        active++;

        /* A rioter with nobody to hit goes for the fixtures: doors,
           lamps, beds, the toilet they were complaining about. */
        if (!p.mentalState && U.chance(0.05)) wreckSomething(p, riot);

        /* They burn out: fear, exhaustion, or a guard in the doorway. */
        var give = 0.004 + (Prison.state.lockdown.on ? 0.006 : 0) +
                   (Prison.coverageAt(map, p.x, p.y) * 0.01);
        if (U.chance(give)) {
          ps.rioting = false;
          var Think = sys('Think');
          if (Think && Think.endMentalState && p.mentalState) Think.endMentalState(p, 'riot over');
          active--;
        }
      }

      if (active > 0) continue;
      endRiot(riot, 'it burned itself out');
      list.splice(i, 1);
    }
  }

  function wreckSomething(pawn, riot) {
    var map = pawn.map;
    var cells = U.cellsInRadius(pawn.x, pawn.y, 2);
    for (var i = 0; i < cells.length; i++) {
      if (!map.inBounds(cells[i][0], cells[i][1])) continue;
      var b = map.buildingAt(cells[i][0], cells[i][1]);
      if (!b || !b.def || b.def.natural) continue;
      if (b.def.id === 'wall' && !U.chance(0.2)) continue;
      var dmg = 14 + skillOf(pawn, 'melee');
      b.hp = (b.hp === undefined ? b.def.hp : b.hp) - dmg;
      riot.damage += dmg;
      if (b.hp <= 0) map.destroyThing(b, 'smashed in a riot');
      return true;
    }
    return false;
  }

  function endRiot(riot, how) {
    var G = root.Game, map = G && G.map;
    var block = Prison.block(riot.blockId) || { label: 'the cells' };

    /* The hard line, if the player asked for it. Prisoners.js owns the
       execution itself; this only names who is for it, and the colony
       and the prisoner's civilization both get a vote afterwards. */
    if (Prison.state.policy.executeOnRiot && !riot.negotiated && map) {
      var P = sys('Prisoners');
      var ring = pawnById(map, riot.instigatorId);
      if (P && P.setMode && ring && ring.prisoner && !ring.dead) {
        P.setMode(ring, 'execute');
        Prison.log('discipline', fullName(ring) + ' marked for execution as a ringleader.',
          { pawn: ring, blockId: riot.blockId, severity: 'major' });
      }
    }
    Prison.state.unrest[riot.blockId] = riot.negotiated ? 0.15 : 0.45;
    if (map) {
      for (var i = 0; i < riot.rioterIds.length; i++) {
        var p = pawnById(map, riot.rioterIds[i]);
        if (p && p.prisonState) { p.prisonState.rioting = false; p.prisonState.riotTicks = 0; }
      }
    }
    letter('The riot in ' + block.label + ' is over',
      'The block is quiet again - ' + how + '. ' + riot.damage + ' points of damage to the ' +
      'fixtures' + (riot.deaths ? ', and ' + riot.deaths + ' dead' : '') + '. ' +
      (riot.negotiated
        ? 'The terms you agreed to are already in the regime.'
        : 'Nothing about why it happened has changed.'),
      riot.deaths ? 'death' : 'neutral');
    Prison.log('riot', 'Riot in ' + block.label + ' ended: ' + how + '.',
      { blockId: riot.blockId, severity: 'major' });
  }

  Prison.suppressRiot = function (blockId) {
    var riot = riotIn(blockId);
    if (!riot) return false;
    Prison.setLockdown(true, 'putting down the riot in ' +
      (Prison.block(blockId) || { label: 'the cells' }).label, blockId);
    return true;
  };

  /* Talking them down. The warden trades concessions for quiet: the
     block's regime is loosened for two days and the player lives with
     it. A bad negotiator makes it worse. */
  Prison.negotiate = function (blockId, warden) {
    if (!Prison.state.policy.negotiateAllowed) return false;
    var riot = riotIn(blockId);
    if (!riot || !warden) return false;
    var chance = U.clamp01(0.12 + skillOf(warden, 'social') * 0.055 +
      (hasTrait(warden, 'kind') ? 0.1 : 0) - (hasTrait(warden, 'abrasive') ? 0.12 : 0) -
      riot.deaths * 0.15);
    if (!U.chance(chance)) {
      Prison.addUnrest(blockId, 0.1);
      Prison.log('riot', nameOf(warden) + ' tried to talk the block down and was shouted at.',
        { blockId: blockId, pawn: warden, severity: 'warn' });
      return false;
    }
    riot.negotiated = true;
    var block = Prison.block(blockId);
    // the concession is the price, and it is written into the regime
    if (block) {
      Prison.applyPreset(block, 'permissive');
      block.concessionUntil = now() + DAY * 2;
    }
    endRiot(riot, nameOf(warden) + ' talked them down');
    U.remove(Prison.state.riots, riot);
    Prison.setLockdown(false);
    return true;
  };

  /* ============================================================
     15. DEATHS IN CUSTODY AND WHO HEARS ABOUT IT
     ============================================================ */

  var NEGLIGENT = { starvation: 1, hypothermia: 1, heatstroke: 1, infection: 1, malnutrition: 1 };

  Prison.recordDeath = function (pawn, causeIn) {
    var ps = pawn && pawn.prisonState;
    if (!ps || ps.deathRecorded) return false;
    ps.deathRecorded = true;

    var cause = causeIn || (pawn.health && pawn.health.deathCause) || 'unknown causes';
    var st = pawn.prisoner || {};
    var negligent = !!NEGLIGENT[cause];
    var inRiot = !!ps.rioting;
    var rec = {
      id: nextId(), tick: now(), day: Math.floor(now() / DAY),
      name: fullName(pawn), pawnId: pawn.id,
      factionId: st.factionId || null, factionName: st.factionName || null,
      cause: cause, category: ps.category, blockId: ps.blockId,
      negligent: negligent, inRiot: inRiot,
      inSolitary: ps.solitaryLeft > 0,
      cellGrade: ps.lastGradeScore
    };
    Prison.state.deaths.push(rec);
    if (Prison.state.deaths.length > 120) Prison.state.deaths.shift();
    Prison.state.stats.deaths++;

    var riot = riotIn(ps.blockId);
    if (riot) riot.deaths++;

    var map = pawn.map || (root.Game && root.Game.map);
    if (map) {
      var colonists = map.colonists();
      for (var i = 0; i < colonists.length; i++) {
        think(colonists[i], 'prisonDeathInCustody', { duration: DAY * 5 });
      }
      /* The block hears first, and takes it worst. */
      var others = prisonersOf(map);
      for (var k = 0; k < others.length; k++) {
        var o = others[k];
        if (!o.prisonState || o.prisonState.blockId !== ps.blockId) continue;
        o.prisonState.needs.safety = U.clamp01(o.prisonState.needs.safety - (negligent ? 0.3 : 0.2));
        o.prisonState.plan.score = U.clamp(o.prisonState.plan.score + 0.15, 0, 2);
      }
      Prison.addUnrest(ps.blockId, negligent ? 0.22 : 0.14);
    }

    var F = sys('Factions');
    if (F && F.adjustGoodwill && rec.factionId && rec.factionId !== 'player') {
      F.adjustGoodwill(rec.factionId, negligent ? -16 : -8,
        negligent ? 'you let ' + rec.name + ' die in your cells' : rec.name + ' died in your custody');
    }

    Prison.log('death',
      rec.name + ' died in custody - ' + cause + (negligent ? ' (preventable)' : '') + '.',
      { pawn: pawn, blockId: ps.blockId, severity: 'major' });

    if (negligent) openInvestigation(rec);
    return true;
  };

  /* Two preventable deaths close together and the colony's own people
     start asking questions. It is a standing mood penalty and a
     standing goodwill penalty until the prison goes a week clean. */
  function openInvestigation(rec) {
    var inv = Prison.state.investigation;
    var recent = 0, list = Prison.state.deaths;
    for (var i = list.length - 1; i >= 0; i--) {
      if (now() - list[i].tick > DAY * 4) break;
      if (list[i].negligent) recent++;
    }
    if (recent < 2) return false;
    if (inv.open) { inv.deaths = recent; return false; }
    inv.open = true;
    inv.sinceTick = now();
    inv.deaths = recent;
    letter('Questions about the cells',
      'Two of your prisoners have died of things that do not happen to people who are being ' +
      'looked after. The colony has noticed and so has ' + (rec.factionName || 'the outside') +
      '. Nothing will settle until the prison goes a week without another one.',
      'threat');
    Prison.log('investigation', 'An investigation opened after ' + recent + ' preventable deaths.',
      { severity: 'major' });
    return true;
  }

  function tickInvestigation(map) {
    var inv = Prison.state.investigation;
    if (!inv.open) return;
    var clean = true, list = Prison.state.deaths;
    for (var i = list.length - 1; i >= 0; i--) {
      if (now() - list[i].tick > DAY * 6) break;
      if (list[i].negligent && list[i].tick > inv.sinceTick) { clean = false; break; }
    }
    if (now() - inv.sinceTick > DAY * 6 && clean) {
      inv.open = false;
      inv.closedTick = now();
      Prison.log('investigation', 'The investigation closed. The cells have been clean for a week.',
        { severity: 'note' });
      msg('The questions about the cells have stopped.', null, 'good');
      return;
    }
    /* While it is open, everybody is a little ashamed of the place. */
    if (now() % (HOUR * 4) < FACILITY_BEAT) {
      var colonists = map.colonists();
      for (var c = 0; c < colonists.length; c++) {
        think(colonists[c], 'prisonDeathInCustody', { duration: DAY * 2, noStack: true });
      }
    }
  }

  /* ============================================================
     16. JOBS

     Behaviour lives next to the system it belongs to, so the toils
     are here and only the scanning is in the work givers below.
     Prisoner jobs are prefixed `prison` so the per-tick pass can tell
     at a glance that a prisoner is out of their cell legitimately.
     ============================================================ */

  var Jobs = root.Jobs, Toils = root.Toils, T = root.T, Res = root.Res, Path = root.Path;
  var PE = Path ? Path.PE : { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  function needGain(pawn, key, amount) {
    var ps = pawn.prisonState;
    if (ps) gainNeed(ps, key, amount);
  }

  /* A prisoner on an authorised move is not "out of their cell" as far
     as prisoners.js is concerned. Its confinement cooldown is the hook
     it published for exactly this, and topping it up is how a regime
     gets to send somebody to the showers without being dragged back. */
  function authorise(pawn, ticks) {
    var st = pawn.prisoner;
    if (st) st.confineCool = Math.max(st.confineCool || 0, ticks || 60);
    var ps = pawn.prisonState;
    if (ps) ps.escortTicks = Math.max(ps.escortTicks || 0, ticks || 60);
  }

  if (Jobs && Toils) {

    Jobs.register('prisonShower', {
      label: 'shower', reportString: 'Washing.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.INTERACTION, failIfGone: true }),
          Toils.waitWith(function (pawn, job, s) {
            authorise(pawn, 90);
            if (s.ticks >= 420) {
              needGain(pawn, 'hygiene', 0.95);
              needGain(pawn, 'privacy', 0.1);
              var ps = pawn.prisonState;
              if (ps) ps.lastShowerTick = now();
              return 'done';
            }
            return 'stay';
          }, { name: 'wash' })
        ];
      }
    });

    Jobs.register('prisonYard', {
      label: 'yard time', reportString: 'In the yard.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false }),
          Toils.waitWith(function (pawn, job, s) {
            authorise(pawn, 90);
            needGain(pawn, 'exercise', 0.0016);
            needGain(pawn, 'freedom', 0.0011);
            var N = sys('Needs');
            if (N && N.gainJoy) N.gainJoy(pawn, 0.0007, 'outdoors');
            if (s.ticks >= 900) {
              var ps = pawn.prisonState;
              if (ps) ps.lastYardTick = now();
              return 'done';
            }
            /* Wander the yard rather than standing on one tile. */
            if (s.ticks % 200 === 0 && job.targetB) {
              var pos = T.pos(job.targetB, pawn.map);
              if (pos && pawn.startPath) {
                var dx = U.randInt(-3, 3), dy = U.randInt(-3, 3);
                if (pawn.map.passable(pos.x + dx, pos.y + dy)) {
                  pawn.startPath(pos.x + dx, pos.y + dy, PE.ON_CELL);
                }
              }
            }
            return 'stay';
          }, { name: 'yard' })
        ];
      }
    });

    Jobs.register('prisonWork', {
      label: 'prison labour', reportString: 'Working off the sentence.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false }),
          Toils.waitWith(function (pawn, job, s) {
            authorise(pawn, 90);
            needGain(pawn, 'freedom', 0.0006);
            needGain(pawn, 'exercise', 0.0004);
            if (s.ticks % 250 === 0) {
              /* Learning something is the only wage. reform.js prices
                 the rest of it if it is loaded. */
              if (typeof pawn.learn === 'function') pawn.learn('crafting', 14);
              var R = sys('Reform');
              if (R && R.creditWork) R.creditWork(pawn, 250);
            }
            return s.ticks >= 1200 ? 'done' : 'stay';
          }, { name: 'labour' })
        ];
      }
    });

    Jobs.register('prisonVisit', {
      label: 'visit', reportString: 'At the visitor booth.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.INTERACTION, failIfGone: true }),
          Toils.waitWith(function (pawn, job, s) {
            authorise(pawn, 90);
            if (s.ticks >= 600) {
              needGain(pawn, 'family', 1);
              needGain(pawn, 'freedom', 0.08);
              var ps = pawn.prisonState;
              if (ps) ps.lastVisitTick = now();
              /* Somebody from home is an argument for giving up. */
              var st = pawn.prisoner;
              if (st && st.resistance > 0) st.resistance = Math.max(0, st.resistance - 0.4);
              return 'done';
            }
            return 'stay';
          }, { name: 'visit' })
        ];
      }
    });

    Jobs.register('prisonMess', {
      label: 'mess hall', reportString: 'Eating with the others.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false }),
          Toils.waitWith(function (pawn, job, s) {
            authorise(pawn, 90);
            needGain(pawn, 'privacy', -0.0003);
            needGain(pawn, 'freedom', 0.0004);
            var N = sys('Needs');
            if (s.ticks % 300 === 0 && N && N.gainJoy) N.gainJoy(pawn, 0.0004, 'social');
            return s.ticks >= 700 ? 'done' : 'stay';
          }, { name: 'mess' })
        ];
      }
    });

    /* ---------- guard work ---------- */

    Jobs.register('prisonManPost', {
      label: 'hold a post', reportString: 'Holding a guard post.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.ON_CELL, failIfGone: true }),
          Toils.waitWith(function (pawn, job, s) {
            var post = T.resolve(job.targetA, pawn.map);
            if (!post || post.spawned === false) return 'done';
            if (post.prisonGuardId !== pawn.id) return 'done';
            if (!postOnShift(post)) return 'done';
            /* Standing on the post is the work; facing about is what
               makes the sightline sweep rather than stare. */
            if (s.ticks % 90 === 0 && pawn.faceTo) {
              pawn.faceTo(pawn.x + U.randInt(-4, 4), pawn.y + U.randInt(-4, 4));
            }
            if (s.ticks % 250 === 0) watchFromHere(pawn);
            return s.ticks >= POST_SHIFT ? 'done' : 'stay';
          }, { name: 'post' })
        ];
      }
    });

    Jobs.register('prisonWatchDesk', {
      label: 'watch the monitors', reportString: 'Watching the cameras.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.INTERACTION, failIfGone: true }),
          Toils.waitWith(function (pawn, job, s) {
            var desk = T.resolve(job.targetA, pawn.map);
            if (!desk || desk.spawned === false) return 'done';
            var P = sys('Power');
            if (P && P.isPowered && !P.isPowered(desk)) return 'done';
            if (s.ticks % 250 === 0) {
              watchFromHere(pawn);
              if (typeof pawn.learn === 'function') pawn.learn('intellectual', 6);
            }
            return s.ticks >= POST_SHIFT ? 'done' : 'stay';
          }, { name: 'desk' })
        ];
      }
    });

    Jobs.register('prisonPatrol', {
      label: 'patrol', reportString: 'Walking the patrol route.',
      toils: function () {
        return [Toils.custom({
          name: 'patrol',
          init: function (pawn, job, s) { s.leg = 0; s.ticks = 0; s.waited = 0; },
          tick: function (pawn, job, s) {
            var route = Prison.patrol(job.state.routeId);
            if (!route || route.points.length < 2) return 'done';
            if (!patrolOnShift(route)) return 'done';
            if (++s.ticks > POST_SHIFT) return 'done';

            var pt = route.points[s.leg % route.points.length];
            if (U.cheb(pawn.x, pawn.y, pt.x, pt.y) <= 1) {
              watchFromHere(pawn);
              if (++s.waited > 60) {
                s.waited = 0;
                s.leg++;
                if (!route.loop && s.leg >= route.points.length) return 'done';
              }
              return 'stay';
            }
            if (!pawn.moving || !pawn.moving()) {
              if (!pawn.startPath || !pawn.startPath(pt.x, pt.y, PE.ON_CELL)) {
                s.leg++;
                if (s.leg > route.points.length * 2) return 'fail';
              }
            }
            return 'stay';
          }
        })];
      }
    });

    Jobs.register('prisonSearch', {
      label: 'search a prisoner', reportString: 'Searching a prisoner.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.work({
            amount: function () { return SEARCH_WORK; },
            skill: 'social',
            failIfGone: true,
            onDone: function (pawn, job) {
              var target = T.resolve(job.targetA, pawn.map);
              if (target) Prison.searchPrisoner(target, pawn);
            }
          })
        ];
      }
    });

    Jobs.register('prisonShakedown', {
      label: 'shake down a cell', reportString: 'Turning over a cell.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.work({
            amount: function () { return SHAKEDOWN_WORK; },
            skill: 'social',
            failIfGone: true,
            onDone: function (pawn, job) {
              var bed = T.resolve(job.targetA, pawn.map);
              if (!bed) return;
              var cell = Prison.cellAt(pawn.map, bed.x, bed.y);
              if (cell) Prison.shakedown(cell, pawn);
              else bed.prisonLastShakedown = now();
            }
          })
        ];
      }
    });

    Jobs.register('prisonEscort', {
      label: 'take to solitary', reportString: 'Taking a prisoner to solitary.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.custom({
            name: 'marchThem',
            init: function (pawn, job, s) { s.ticks = 0; },
            tick: function (pawn, job, s) {
              var target = T.resolve(job.targetA, pawn.map);
              if (!target || target.dead || !target.prisoner) return 'fail';
              if (++s.ticks > 6000) return 'fail';
              var ps = stateOf(target);
              if (ps.solitaryLeft > 0) return 'done';
              /* They walk themselves, under escort, which is what the
                 authorisation window is for. */
              authorise(target, 120);
              if (U.cheb(pawn.x, pawn.y, target.x, target.y) > 2) {
                if (!pawn.moving || !pawn.moving()) {
                  if (pawn.startPath) pawn.startPath(target.x, target.y, PE.TOUCH);
                }
                return 'stay';
              }
              if (Prison.sendToSolitary(target, undefined, ps.solitaryReason || 'misconduct')) {
                ps.solitaryWanted = false;
                return 'done';
              }
              ps.solitaryWanted = false;
              return 'fail';
            }
          })
        ];
      }
    });

    Jobs.register('prisonQuell', {
      label: 'put down a riot', reportString: 'Putting down a riot.',
      suspendable: false,
      toils: function () {
        return [Toils.custom({
          name: 'quell',
          init: function (pawn, job, s) { s.ticks = 0; },
          tick: function (pawn, job, s) {
            var target = T.resolve(job.targetA, pawn.map);
            if (!target || target.dead || target.downed) return 'done';
            var ps = target.prisonState;
            if (!ps || !ps.rioting) return 'done';
            if (++s.ticks > 9000) return 'done';
            var d = U.dist(pawn.x, pawn.y, target.x, target.y);
            if (d > 1.45) {
              if (!pawn.moving || !pawn.moving()) {
                if (pawn.startPath) pawn.startPath(target.x, target.y, PE.TOUCH);
                else return 'fail';
              }
              return 'stay';
            }
            if (pawn.stopPath) pawn.stopPath();
            var C = sys('Combat');
            if (C && C.tryAttack) C.tryAttack(pawn, target);
            return 'stay';
          }
        })];
      }
    });
  }

  /* A guard standing somewhere useful notices things: a prisoner out
     of place, a cell that has not been tossed in a week, a tunnel. */
  function watchFromHere(pawn) {
    var map = pawn.map;
    var prisoners = prisonersOf(map);
    for (var i = 0; i < prisoners.length; i++) {
      var p = prisoners[i];
      if (U.dist(pawn.x, pawn.y, p.x, p.y) > GUARD_SIGHT) continue;
      if (!lineOfSight(map, pawn.x, pawn.y, p.x, p.y)) continue;
      var st = p.prisoner;
      if (st) st.lastWatchedTick = now();
      var ps = stateOf(p);
      ps.plan.score = Math.max(0, ps.plan.score - 0.012);

      var tunnel = Prison.tunnelOf(p);
      if (tunnel && !tunnel.discovered && U.chance(0.02 + skillOf(pawn, 'shooting') * 0.002)) {
        Prison.discoverTunnel(tunnel, pawn);
      }
    }
  }

  /* ============================================================
     17. WORK GIVERS

     prisoners.js already owns the warden column. This file owns the
     guard column it registered above, and nothing else.
     ============================================================ */

  var _registered = false;

  function claimed(pawn, defId, target, targetB, opts) {
    if (!Res.reserve(pawn, target, 1)) return null;
    return Jobs.make(defId, target, targetB || null, opts);
  }

  function guardsAllowed(pawn) {
    if (!pawn.workPriority) return false;
    return pawn.workPriority.guard > 0;
  }

  Prison.registerWork = function () {
    var WG = root.WorkGivers;
    if (_registered || !WG || !WG.register || !Jobs) return false;
    _registered = true;

    /* A riot outranks everything a guard could otherwise be doing. */
    WG.register({
      id: 'prisonQuellRiot', workType: 'guard', order: 2, label: 'put down riots',
      tryGiveJob: function (pawn) {
        if (!Prison.state.riots.length) return null;
        var map = pawn.map, best = null, bestD = 1e9;
        var list = prisonersOf(map);
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          if (!p.prisonState || !p.prisonState.rioting || p.downed) continue;
          if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
          if (!reachable(map, pawn, p.x, p.y)) continue;
          var d = U.distSq(pawn.x, pawn.y, p.x, p.y);
          if (d < bestD) { bestD = d; best = p; }
        }
        return best ? claimed(pawn, 'prisonQuell', T.pawn(best)) : null;
      }
    });

    WG.register({
      id: 'prisonEscortSolitary', workType: 'guard', order: 8, label: 'take prisoners to solitary',
      tryGiveJob: function (pawn) {
        var map = pawn.map, list = prisonersOf(map);
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          var ps = p.prisonState;
          if (!ps || !ps.solitaryWanted || ps.solitaryLeft > 0) continue;
          if (p.carriedBy || p.dead) continue;
          if (!Prison.solitaryCells(map).length) continue;
          if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
          if (!reachable(map, pawn, p.x, p.y)) continue;
          return claimed(pawn, 'prisonEscort', T.pawn(p));
        }
        return null;
      }
    });

    WG.register({
      id: 'prisonHoldPost', workType: 'guard', order: 12, label: 'hold a guard post',
      tryGiveJob: function (pawn) {
        if (!guardsAllowed(pawn)) return null;
        var posts = Prison.posts(pawn.map), i, post;
        for (i = 0; i < posts.length; i++) {
          post = posts[i];
          if (post.prisonGuardId !== pawn.id) continue;
          if (!postOnShift(post)) return null;
          if (!reachable(pawn.map, pawn, post.x, post.y)) return null;
          return claimed(pawn, 'prisonManPost', T.thing(post));
        }
        /* An unassigned post is worth taking when the prison is short
           of eyes rather than short of hands. */
        if (Prison.staffing(pawn.map).ratio > 1.1) return null;
        for (i = 0; i < posts.length; i++) {
          post = posts[i];
          if (post.prisonGuardId) continue;
          if (!postOnShift(post)) continue;
          if (!Res.canReserve(pawn, T.thing(post), 1)) continue;
          if (!reachable(pawn.map, pawn, post.x, post.y)) continue;
          return claimed(pawn, 'prisonManPost', T.thing(post));
        }
        return null;
      }
    });

    WG.register({
      id: 'prisonManDesk', workType: 'guard', order: 16, label: 'watch the security monitors',
      tryGiveJob: function (pawn) {
        if (!guardsAllowed(pawn)) return null;
        var f = Prison.facilities(pawn.map);
        if (!f.desks.length || !f.cameras.length) return null;
        if (Prison.deskManned(pawn.map)) return null;
        var P = sys('Power');
        for (var i = 0; i < f.desks.length; i++) {
          var d = f.desks[i];
          if (P && P.isPowered && !P.isPowered(d)) continue;
          if (!Res.canReserve(pawn, T.thing(d), 1)) continue;
          if (!reachable(pawn.map, pawn, d.x, d.y)) continue;
          return claimed(pawn, 'prisonWatchDesk', T.thing(d));
        }
        return null;
      }
    });

    WG.register({
      id: 'prisonSearchPrisoner', workType: 'guard', order: 22, label: 'search prisoners',
      tryGiveJob: function (pawn) {
        if (!guardsAllowed(pawn)) return null;
        if (!Prison.state.policy.searchOnReturn) return null;
        var map = pawn.map, list = prisonersOf(map), t = now();
        for (var i = 0; i < list.length; i++) {
          var p = list[i], ps = p.prisonState;
          if (!ps || p.downed || p.carriedBy) continue;
          if (t - (ps.lastSearchTick || 0) < DAY * 0.6) continue;
          /* Worth searching: just back from somewhere, or already on
             the book. */
          var due = ps.activity === 'yard' || ps.activity === 'work' ||
                    ps.misconducts > 0 || ps.category === 'maximum';
          if (!due) continue;
          if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
          if (!reachable(map, pawn, p.x, p.y)) continue;
          return claimed(pawn, 'prisonSearch', T.pawn(p));
        }
        return null;
      }
    });

    WG.register({
      id: 'prisonTossCell', workType: 'guard', order: 30, label: 'shake down cells',
      tryGiveJob: function (pawn) {
        if (!guardsAllowed(pawn)) return null;
        var map = pawn.map, cells = Prison.cells(map);
        for (var i = 0; i < cells.length; i++) {
          var c = cells[i];
          if (!Prison.cellDueShakedown(c)) continue;
          var bed = c.beds[0];
          if (!Res.canReserve(pawn, T.thing(bed), 1)) continue;
          if (!reachable(map, pawn, bed.x, bed.y)) continue;
          return claimed(pawn, 'prisonShakedown', T.thing(bed));
        }
        return null;
      }
    });

    WG.register({
      id: 'prisonWalkPatrol', workType: 'guard', order: 40, label: 'walk a patrol route',
      tryGiveJob: function (pawn) {
        if (!guardsAllowed(pawn)) return null;
        var route = Prison.patrolOf(pawn);
        if (!route || !patrolOnShift(route)) return null;
        var first = route.points[0];
        if (!reachable(pawn.map, pawn, first.x, first.y)) return null;
        return Jobs.make('prisonPatrol', T.cell(first.x, first.y), null,
          { state: { routeId: route.id } });
      }
    });

    return true;
  };

  Prison.registerWork();

  /* ============================================================
     18. RUNNING THE REGIME

     The rare beat for one prisoner: decay their needs, turn the hour
     into an activity, give them the job that activity needs, tell the
     mood system how they feel about all of it, and let the escape
     planner have a look at the prison they are standing in.
     ============================================================ */

  var IDLE_JOBS = { wander: 1, joyIdle: 1, goto: 1, wait: 1 };

  function jobIsPrison(job) {
    return !!(job && job.defId && job.defId.length > 6 && job.defId.slice(0, 6) === 'prison');
  }

  function canGiveJob(pawn) {
    if (pawn.downed || pawn.dead) return false;
    if (pawn.mentalState) return false;
    if (!pawn.job) return true;
    if (jobIsPrison(pawn.job)) return false;
    return !!IDLE_JOBS[pawn.job.defId];
  }

  function startRegimeJob(pawn, ps, activity) {
    var map = pawn.map, J = sys('Jobs');
    if (!J || !canGiveJob(pawn)) return false;
    var target;

    if (activity === 'shower') {
      if (ps.needs.hygiene > 0.9) return false;
      target = nearestUsable(pawn, 'prisonShower');
      if (!target) return false;
      return J.start(pawn, J.make('prisonShower', T.thing(target)));
    }
    if (activity === 'visit') {
      if (ps.needs.family > 0.9) return false;
      target = nearestUsable(pawn, 'visitorBooth');
      if (!target) return false;
      return J.start(pawn, J.make('prisonVisit', T.thing(target)));
    }
    if (activity === 'yard') {
      var G = root.Game;
      if (!Prison.state.policy.yardBelowFreezing && G && G.outdoorTemp && G.outdoorTemp() < -2) {
        ps.note = 'too cold for the yard';
        return false;
      }
      var yard = areaTargetFor(pawn, 'yard');
      if (!yard) return false;
      return J.start(pawn, J.make('prisonYard', T.cell(yard.x, yard.y), T.cell(yard.x, yard.y)));
    }
    if (activity === 'work') {
      var shop = areaTargetFor(pawn, 'workshop');
      if (!shop) return false;
      return J.start(pawn, J.make('prisonWork', T.cell(shop.x, shop.y)));
    }
    if (activity === 'eat') {
      if (!Prison.state.policy.mealsInCell) {
        var mess = areaTargetFor(pawn, 'canteen');
        if (mess) return J.start(pawn, J.make('prisonMess', T.cell(mess.x, mess.y)));
      }
      return false;
    }
    if (activity === 'programme') {
      var R = sys('Reform');
      if (R && R.tryAttend) return !!R.tryAttend(pawn);
      var free = areaTargetFor(pawn, 'yard');
      if (free) return J.start(pawn, J.make('prisonYard', T.cell(free.x, free.y), T.cell(free.x, free.y)));
      return false;
    }
    if (activity === 'free') {
      /* Free time inside the block: the yard if it is open to them,
         otherwise it is joy inside four walls, which is what think.js
         already does for anyone with nothing on. */
      var open = areaTargetFor(pawn, 'yard');
      if (open && U.chance(0.5)) {
        return J.start(pawn, J.make('prisonYard', T.cell(open.x, open.y), T.cell(open.x, open.y)));
      }
      return false;
    }
    return false;                    /* sleep, lockup and solitary need no job */
  }

  /* The activity that could not happen, and why - this is the sentence
     the inspect panel shows and the reason a regime fails visibly
     rather than silently. */
  function noteUnservedActivity(ps, activity, map) {
    var f = Prison.facilities(map);
    var why = '';
    if (activity === 'shower' && !f.showers.length) why = 'no shower block built';
    else if (activity === 'yard' && !f.yard) why = 'no yard marked out';
    else if (activity === 'work' && !f.workshop) why = 'no prison workshop marked out';
    else if (activity === 'visit' && !f.booths.length) why = 'no visitor booth built';
    else if (activity === 'programme' && !f.programmes) why = 'no programme to attend';
    ps.note = why;
    return why;
  }

  Prison.tickPawn = function (pawn) {
    if (!pawn || pawn.dead || !pawn.prisoner || !pawn.map) return;
    var ps = stateOf(pawn);
    var t = now();

    /* Anything that must happen every tick for a prisoner: the door
       locks, the detectors, and the authorisation window that keeps
       prisoners.js from dragging them off a scheduled errand. */
    if (ps.escortTicks > 0) ps.escortTicks--;
    if (jobIsPrison(pawn.job)) authorise(pawn, 40);
    enforceDoors(pawn);
    if (ps.solitaryLeft > 0) {
      ps.solitaryLeft -= 1;
      if (ps.solitaryLeft <= 0) Prison.releaseFromSolitary(pawn, false);
    }

    if (ps.lastPawnBeat === t) return;                /* two drivers, one beat */
    if (((t + pawn.id) % RARE) !== 0) return;
    ps.lastPawnBeat = t;

    if (!ps.intakeDone) Prison.intake(pawn);
    checkDetectors(pawn.map, pawn, ps);

    var cell = Prison.cellOf(pawn);
    if (cell) ps.blockId = cell.blockId;

    tickNeedDecay(pawn, ps, cell);

    var activity = Prison.activityOf(pawn);
    ps.activity = activity;
    ps.activityTick = t;

    if (activity === 'sleep' || activity === 'lockup' || activity === 'solitary') {
      /* prisoners.js already walks them back to their bunk; all this
         has to do is not fight it. */
      ps.note = '';
      if (activity !== 'solitary' && cell && cell.occupants.length <= cell.capacity) {
        gainNeed(ps, 'privacy', 0.02);
      }
    } else if (!startRegimeJob(pawn, ps, activity)) {
      noteUnservedActivity(ps, activity, pawn.map);
    } else {
      ps.note = '';
    }

    applyNeedThoughts(pawn, ps, cell);
    tickEscapePlan(pawn, ps);

    /* Compliance: what the cell and the regime have bought. It feeds
       back into prisoners.js's own numbers, which is the loop that
       makes a good prison recruit faster than a bad one. */
    var st = pawn.prisoner;
    if (st && !st.escaping) {
      var comfort = (cell ? cell.grade.norm : 0.15);
      var served = (ps.needs.hygiene + ps.needs.exercise + ps.needs.freedom +
                    ps.needs.safety + ps.needs.family + ps.needs.privacy) / 6;
      var compliance = U.clamp01(comfort * 0.5 + served * 0.5);
      ps.compliance = Math.round(compliance * 100) / 100;
      if (compliance > 0.6 && st.resistance > 0) {
        st.resistance = Math.max(0, st.resistance - 0.04 * (compliance - 0.6));
      } else if (compliance < 0.3) {
        st.resistance += 0.03 * (0.3 - compliance);
      }
    }
  };

  /* ============================================================
     19. THE FACILITY TICK
     ============================================================ */

  function refreshRoster(map) {
    _roster.length = 0;
    var list = prisonersOf(map);
    for (var i = 0; i < list.length; i++) _roster.push(list[i]);
    Prison.state.lastRosterTick = now();
  }

  /* Deaths are found here rather than hooked: a prisoner shot in a
     riot dies inside combat.js's tick, and the only honest way to
     notice is to look. */
  function sweepDeaths(map) {
    for (var i = _roster.length - 1; i >= 0; i--) {
      var p = _roster[i];
      if (!p || !p.prisoner) { _roster.splice(i, 1); continue; }
      if (!p.dead) continue;
      Prison.recordDeath(p, null);
      _roster.splice(i, 1);
    }
  }

  function tickLockdown() {
    var L = Prison.state.lockdown;
    if (!L.on) return;
    L.ticksLeft -= FAST_BEAT;
    if (L.ticksLeft <= 0) { Prison.setLockdown(false); return; }
    /* A lockdown with nothing left to lock down lifts itself, so the
       player is not punished for forgetting. */
    if (!Prison.state.riots.length) {
      var G = root.Game;
      var escaping = false, list = prisonersOf(G && G.map);
      for (var i = 0; i < list.length; i++) {
        if (list[i].prisoner && list[i].prisoner.escaping) { escaping = true; break; }
      }
      if (!escaping && now() - L.startedTick > HOUR * 4) Prison.setLockdown(false);
    }
  }

  /* The prison keeps a bunk for everybody it can. A prisoner with no
     cell is a standing alert; auto-assign is a policy, not a law. */
  function sweepAssignments(map) {
    if (!Prison.state.policy.autoAssignCells) return;
    var list = Prison.unassigned(map);
    for (var i = 0; i < list.length; i++) {
      if (list[i].prisoner && list[i].prisoner.escaping) continue;
      Prison.autoAssign(list[i]);
    }
  }

  /* prisoners.js claims the first free prisoner bed it can reach when
     it walks somebody back to their cell, and it has no idea what a
     block is. So the classification sweep also looks for people living
     in a wing that is not rated for them and moves them, unless the
     player turned auto-assignment off - in which case the mixing is
     theirs to own and the alert keeps saying so. */
  function sweepHousing(map) {
    if (!Prison.state.policy.autoAssignCells) return;
    for (var i = 0; i < _roster.length; i++) {
      var p = _roster[i];
      if (!p.prisonState || p.dead) continue;
      if (p.prisoner && p.prisoner.escaping) continue;
      if (p.prisonState.solitaryLeft > 0) continue;
      /* A bunk that is not a prisoner bunk is not theirs: think.js will
         happily claim a colonist's bed for anyone of the player faction,
         and a prisoner is one of those until they are recruited. */
      var owned = p.ownedBedId ? p.map.thing(p.ownedBedId) : null;
      if (owned && !owned.forPrisoners) {
        if (owned.ownerId === p.id) owned.ownerId = null;
        p.ownedBedId = null;
        Prison.autoAssign(p);
        continue;
      }
      var cell = Prison.cellOf(p);
      if (!cell) continue;
      if (cell.solitary && p.prisonState.solitaryLeft <= 0) { Prison.autoAssign(p); continue; }
      var block = Prison.block(cell.blockId);
      if (!block || block.categories.indexOf(p.prisonState.category) >= 0) continue;
      Prison.autoAssign(p);
    }
  }

  /* Reclassification on the facts, when the player has not taken the
     decision themselves. */
  function sweepClassification(map) {
    if (!Prison.state.policy.autoClassify) return;
    for (var i = 0; i < _roster.length; i++) {
      var p = _roster[i];
      if (!p.prisonState || p.prisonState.categorySetByPlayer) continue;
      var want = Prison.classifyRaw(p).category;
      if (want !== p.prisonState.category) Prison.setCategory(p, want, false);
    }
  }

  Prison.tick = function (map, game) {
    map = map || (game && game.map) || (root.Game && root.Game.map);
    if (!map) return;
    var t = now();
    if (_tickSeen === t) return;         /* game.js may also name us */
    _tickSeen = t;

    if (t % FAST_BEAT === 0) {
      tickLockdown();
      if (Prison.state.riots.length) tickRiots(map);
    }

    /* Prisoners are few and their beat is staggered inside tickPawn,
       so driving them from here costs a walk of a short list. */
    for (var i = 0; i < _roster.length; i++) {
      var p = _roster[i];
      if (p && p.prisoner && !p.dead) Prison.tickPawn(p);
    }

    if (t % ROSTER_BEAT === 0) { sweepDeaths(map); refreshRoster(map); }

    if (t % FACILITY_BEAT !== 0) return;
    Prison.state.lastFacilityTick = t;
    _cellCache = null;
    tickUnrest(map);
    tickInvestigation(map);
    sweepAssignments(map);
    if (t % (FACILITY_BEAT * 4) === 0) sweepHousing(map);
    if (t % (FACILITY_BEAT * 8) === 0) sweepClassification(map);

    /* A concession granted to end a riot expires, and the block goes
       back to whatever the player had written. */
    var blocks = Prison.state.blocks;
    for (var b = 0; b < blocks.length; b++) {
      if (blocks[b].concessionUntil && t > blocks[b].concessionUntil) {
        blocks[b].concessionUntil = 0;
        Prison.log('regime', (blocks[b].label || 'A block') + ' is back on its normal regime.',
          { blockId: blocks[b].id });
      }
    }
  };

  /* ============================================================
     20. DRIVING

     game.js's systems registry does not name Prison and game.js is
     not this file's to edit. GameMap.prototype.tick is called once a
     tick for the live map and exists at load, so the tick arrives
     through a guarded wrapper on it. The guard stands the wrapper
     down the moment Prison.tick has already run for this game tick,
     so adding ['Prison', 'tick'] to MAP_TICKERS makes it inert
     rather than doubling the work.
     ============================================================ */

  function installDriver() {
    var Ctor = root.GameMap;
    if (_driverInstalled || !Ctor || Ctor.prototype.__prisonDriven) return false;
    var original = Ctor.prototype.tick;
    Ctor.prototype.tick = function () {
      var out = original.apply(this, arguments);
      var G = root.Game;
      if (Prison.autoDrive && G && G.map === this && G.started) Prison.tick(this, G);
      return out;
    };
    Ctor.prototype.__prisonDriven = true;
    _driverInstalled = true;
    return true;
  }

  Prison.autoDrive = true;
  installDriver();

  /* ============================================================
     21. THE READOUT

     Everything the UI needs in one object, cheap enough to call once
     a second and specific enough that the player can see which of
     their decisions is the problem.
     ============================================================ */

  Prison.report = function (map) {
    map = map || (root.Game && root.Game.map);
    var out = {
      population: { total: 0, byCategory: { minimum: 0, medium: 0, maximum: 0 },
                    downed: 0, inSolitary: 0, escaping: 0, rioting: 0, unassigned: 0 },
      cells: { count: 0, capacity: 0, occupied: 0, averageGrade: 0, averageScore: 0,
               byGrade: {}, solitary: 0, solitaryBunks: 0, holding: 0, shared: 0 },
      blocks: [],
      staffing: Prison.staffing(map),
      unrest: { worst: 0, worstBlock: '', byBlock: {} },
      lockdown: Prison.state.lockdown,
      riots: Prison.state.riots.length,
      tunnels: 0,
      needs: { hygiene: 0, exercise: 0, privacy: 0, safety: 0, family: 0, freedom: 0 },
      regimeProblems: [],
      deaths: { total: Prison.state.stats.deaths, preventable: 0, recent: [] },
      investigation: Prison.state.investigation,
      stats: Prison.state.stats,
      alerts: [],
      incidents: Prison.incidents(12)
    };
    if (!map) return out;

    var i, k;
    for (i = 0; i < GRADE_NAMES.length; i++) out.cells.byGrade[GRADE_NAMES[i]] = 0;

    var cells = Prison.cells(map), scoreSum = 0;
    for (i = 0; i < cells.length; i++) {
      var c = cells[i];
      out.cells.count++;
      if (c.solitary) { out.cells.solitary++; out.cells.solitaryBunks += c.capacity; }
      else out.cells.capacity += c.capacity;
      out.cells.occupied += c.occupants.length;
      out.cells.byGrade[c.grade.grade]++;
      scoreSum += c.grade.score;
      if (c.holding) out.cells.holding++;
      if (c.capacity > 1) out.cells.shared++;
    }
    out.cells.averageScore = cells.length ? Math.round((scoreSum / cells.length) * 10) / 10 : 0;
    out.cells.averageGrade = GRADE_NAMES[gradeIndexOf(out.cells.averageScore)];

    var prisoners = prisonersOf(map);
    var needTotals = { hygiene: 0, exercise: 0, privacy: 0, safety: 0, family: 0, freedom: 0 };
    for (i = 0; i < prisoners.length; i++) {
      var p = prisoners[i], ps = stateOf(p);
      out.population.total++;
      out.population.byCategory[ps.category] = (out.population.byCategory[ps.category] || 0) + 1;
      if (p.downed) out.population.downed++;
      if (ps.solitaryLeft > 0) out.population.inSolitary++;
      if (p.prisoner.escaping) out.population.escaping++;
      if (ps.rioting) out.population.rioting++;
      for (k in needTotals) needTotals[k] += ps.needs[k];
    }
    if (out.population.total) {
      for (k in needTotals) out.needs[k] = Math.round((needTotals[k] / out.population.total) * 100) / 100;
    }
    out.population.unassigned = Prison.unassigned(map).length;
    out.tunnels = Prison.state.tunnels.length;

    var blocks = Prison.state.blocks;
    for (i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var bCells = 0, bCap = 0, bOcc = 0, bScore = 0, pop = 0, mixed = 0;
      for (k = 0; k < cells.length; k++) {
        if (cells[k].blockId !== block.id) continue;
        bCells++; bCap += cells[k].capacity; bOcc += cells[k].occupants.length;
        bScore += cells[k].grade.score;
      }
      for (k = 0; k < prisoners.length; k++) {
        var qs = prisoners[k].prisonState;
        if (!qs || qs.blockId !== block.id) continue;
        pop++;
        if (block.categories.indexOf(qs.category) < 0) mixed++;
      }
      var unrest = Prison.unrestOf(block.id);
      out.unrest.byBlock[block.id] = unrest;
      if (unrest > out.unrest.worst) { out.unrest.worst = unrest; out.unrest.worstBlock = block.label; }
      out.blocks.push({
        id: block.id, label: block.label, categories: block.categories.slice(),
        cells: bCells, capacity: bCap, occupied: bOcc, population: pop, mixed: mixed,
        averageScore: bCells ? Math.round((bScore / bCells) * 10) / 10 : 0,
        unrest: Math.round(unrest * 100) / 100,
        rioting: !!riotIn(block.id),
        regime: block.regimeId || 'by category',
        concession: !!block.concessionUntil
      });
    }

    if (out.population.total) {
      for (i = 0; i < CATEGORIES.length; i++) {
        if (!out.population.byCategory[CATEGORIES[i]]) continue;
        var audit = Prison.regimeAudit(map, CATEGORIES[i]);
        for (k = 0; k < audit.problems.length; k++) {
          out.regimeProblems.push({ regime: CATEGORIES[i], problem: audit.problems[k] });
        }
      }
    }

    var deaths = Prison.state.deaths;
    for (i = 0; i < deaths.length; i++) if (deaths[i].negligent) out.deaths.preventable++;
    out.deaths.recent = deaths.slice(Math.max(0, deaths.length - 8)).reverse();

    /* The alert list, in the order a player should read it. */
    if (out.population.unassigned) {
      out.alerts.push({ label: out.population.unassigned + ' ' +
        U.plural(out.population.unassigned, 'prisoner') + ' with no cell', severity: 'urgent' });
    }
    if (out.cells.occupied > out.cells.capacity) {
      out.alerts.push({ label: 'Cells over capacity', severity: 'urgent' });
    }
    if (out.staffing.ratio < Prison.state.policy.guardRatioWarn && out.population.total) {
      out.alerts.push({ label: 'Not enough guards (' + U.fmt(out.staffing.have, 1) + ' of ' +
        U.fmt(out.staffing.need, 1) + ' needed)', severity: 'warn' });
    }
    if (out.unrest.worst > 0.6) {
      out.alerts.push({ label: 'Unrest in ' + out.unrest.worstBlock, severity: 'urgent' });
    }
    if (out.regimeProblems.length) {
      out.alerts.push({ label: out.regimeProblems[0].regime + ' regime: ' +
        out.regimeProblems[0].problem, severity: 'warn' });
    }
    if (out.investigation.open) {
      out.alerts.push({ label: 'Deaths in custody under investigation', severity: 'urgent' });
    }
    var mixedTotal = 0;
    for (i = 0; i < out.blocks.length; i++) mixedTotal += out.blocks[i].mixed;
    if (mixedTotal) {
      out.alerts.push({ label: mixedTotal + ' prisoners housed outside their category',
        severity: 'warn' });
    }
    return out;
  };

  /* One prisoner, in the shape the inspect panel wants. */
  Prison.prisonerReport = function (pawn) {
    if (!isPrisoner(pawn)) return null;
    var ps = stateOf(pawn);
    var cell = Prison.cellOf(pawn);
    var opp = Prison.opportunity(pawn);
    var tunnel = Prison.tunnelOf(pawn);
    return {
      name: fullName(pawn),
      category: ps.category,
      categoryByPlayer: ps.categorySetByPlayer,
      classification: Prison.classifyRaw(pawn),
      block: cell ? (Prison.block(cell.blockId) || {}).label : null,
      cell: cell ? { kind: cell.kind, grade: cell.grade.grade, score: cell.grade.score,
                     parts: cell.grade.parts, occupants: cell.occupants.length,
                     capacity: cell.capacity, coverage: Prison.cellCoverage(pawn.map, cell) } : null,
      activity: ps.activity,
      activityLabel: ACTIVITY_LABEL[ps.activity] || U.cap(ps.activity),
      note: ps.note,
      regime: Prison.regime(pawn).slice(),
      regimeIsOverride: !!ps.regime,
      needs: Prison.needBreakdown(pawn),
      compliance: ps.compliance || 0,
      solitary: ps.solitaryLeft > 0
        ? { left: ps.solitaryLeft, total: ps.solitaryTotal, reason: ps.solitaryReason } : null,
      misconducts: ps.misconducts,
      searches: ps.searches,
      contrabandFound: ps.contrabandFound,
      escapeAttempts: ps.escapeAttempts,
      plan: { score: Math.round(ps.plan.score * 100) / 100, reasons: opp.reasons },
      tunnel: tunnel ? { progress: tunnel.progress, discovered: tunnel.discovered } : null,
      rioting: ps.rioting
    };
  };

  Prison.summary = function (pawn) {
    var ps = pawn && pawn.prisonState;
    if (!ps) return '';
    if (ps.rioting) return 'Rioting';
    if (ps.solitaryLeft > 0) return 'Solitary (' + U.fmt(ps.solitaryLeft / HOUR, 1) + 'h left)';
    var label = ACTIVITY_LABEL[ps.activity] || U.cap(ps.activity || 'held');
    return U.cap(ps.category) + ' security - ' + label + (ps.note ? ' (' + ps.note + ')' : '');
  };

  /* ============================================================
     22. SAVE

     Module state is plain data already; everything hung on a bed, a
     door or a pawn is carried by save.js on its own. The integrator
     wires `prison: Prison.save()` beside the other systems.
     ============================================================ */

  Prison.save = function () {
    var s = Prison.state;
    return {
      nextId: s.nextId,
      blocks: s.blocks,
      regimes: s.regimes,
      patrols: s.patrols,
      unrest: s.unrest,
      tunnels: s.tunnels,
      incidents: s.incidents,
      deaths: s.deaths,
      lockdown: s.lockdown,
      riots: s.riots,
      investigation: s.investigation,
      policy: s.policy,
      stats: s.stats,
      lastRiotTick: s.lastRiotTick || {},
      areas: s.areas || { yard: [], workshop: [], canteen: [] }
    };
  };

  Prison.load = function (obj) {
    var fresh = freshState();
    if (!obj || typeof obj !== 'object') { Prison.state = fresh; _roster.length = 0; return false; }
    var s = fresh, k;
    s.nextId = obj.nextId || 1;
    if (Array.isArray(obj.blocks) && obj.blocks.length) s.blocks = obj.blocks;
    if (obj.regimes) {
      for (k in obj.regimes) {
        if (Array.isArray(obj.regimes[k]) && obj.regimes[k].length === 24) s.regimes[k] = obj.regimes[k];
      }
    }
    if (Array.isArray(obj.patrols)) s.patrols = obj.patrols;
    if (obj.unrest) s.unrest = obj.unrest;
    if (Array.isArray(obj.tunnels)) s.tunnels = obj.tunnels;
    if (Array.isArray(obj.incidents)) s.incidents = obj.incidents;
    if (Array.isArray(obj.deaths)) s.deaths = obj.deaths;
    if (obj.lockdown) s.lockdown = obj.lockdown;
    if (Array.isArray(obj.riots)) s.riots = obj.riots;
    if (obj.investigation) s.investigation = obj.investigation;
    if (obj.policy) for (k in obj.policy) if (k in s.policy) s.policy[k] = obj.policy[k];
    if (obj.stats) for (k in obj.stats) if (k in s.stats) s.stats[k] = obj.stats[k];
    if (obj.areas) s.areas = obj.areas;
    if (obj.lastRiotTick) s.lastRiotTick = obj.lastRiotTick;

    Prison.state = s;
    _roster.length = 0;
    _cellCache = null;
    _tickSeen = -1;
    return true;
  };

  /* A small self-check the integrator can call: it proves the regime
     vocabulary, the grade bands and the category table agree with each
     other, which is the one thing a data typo here would break
     silently. */
  Prison.selfCheck = function () {
    var problems = [], i, h;
    for (i = 0; i < CATEGORIES.length; i++) {
      if (!GUARD_COST[CATEGORIES[i]]) problems.push('no guard cost for ' + CATEGORIES[i]);
      var r = Prison.regime(CATEGORIES[i]);
      if (!r || r.length !== 24) { problems.push('regime for ' + CATEGORIES[i] + ' is not 24 hours'); continue; }
      for (h = 0; h < 24; h++) {
        if (ACTIVITIES.indexOf(r[h]) < 0) problems.push(CATEGORIES[i] + ' hour ' + h + ': ' + r[h]);
      }
    }
    if (GRADE_BANDS.length !== GRADE_NAMES.length - 1) problems.push('grade bands do not match grade names');
    for (i = 0; i < REGIME_PRESETS.length; i++) {
      var built = REGIME_PRESETS[i].build();
      if (!built || built.length !== 24) { problems.push('preset ' + REGIME_PRESETS[i].id + ' is broken'); continue; }
      for (h = 0; h < 24; h++) {
        if (ACTIVITIES.indexOf(built[h]) < 0) {
          problems.push('preset ' + REGIME_PRESETS[i].id + ' hour ' + h + ': ' + built[h]);
        }
      }
    }
    return problems;
  };

  root.Prison = Prison;
})(this);
