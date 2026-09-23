/* ============================================================
   reform.js - programmes, labour, and how a prisoner leaves.

   The prison layer is three questions. prisoners.js answers "we have
   a captive". prison.js answers "where do they sleep and what are
   they doing at eleven in the morning". This file answers the last
   one, which is the only one with a story in it: what did the time
   do to them, and what walks out of the gate.

   Four things live here and nothing else does:

     A PROGRAMME is a room, a piece of equipment, a qualified
     colonist and an hour of the regime. It runs in sessions with a
     register, a lockdown can cancel it, and it succeeds or fails on
     the instructor's skill, the prisoner's head and how many times
     they have sat through it already.

     LABOUR is the other half of the day. Prisoners in the workshop,
     the kitchen or the laundry produce things the colony can use or
     sell, under supervision, with tools that go missing. Leaning on
     it pays for the prison; leaning too hard on it fills the block
     with exhausted people holding sharpened files.

     A RECORD is what the player reads. Sentence, incidents,
     programmes, work done, searches failed, hours in solitary. It is
     bounded, it is the input to every decision below, and it is the
     thing that makes a disposition a judgement rather than a menu.

     A DISPOSITION is the exit. Recruited, enslaved, released,
     ransomed, traded, paroled, executed, or dead in the cells. Every
     one of them writes a release record, and a release record is a
     person who is still out there.

   Ownership, from section 15 of the contract: capture, beds,
   recruitment, release and execution are prisoners.js and are
   CALLED. Cells, the regime, security, solitary, lockdown and riots
   are prison.js and are READ. Enslavement is slavery.js. The
   underground is contraband.js. Every one of them is reached through
   typeof, and this file runs alone without any of them.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Everything above this file in the load order is bound once.
     Prison, Prisoners, Slavery, Contraband, Drugs, Ideology, Social,
     Factions and Game are looked up when they are called, because
     three of them load after this file does. */
  var Jobs = root.Jobs;
  var Toils = root.Toils;
  var T = root.T;
  var Res = root.Res;
  var Path = root.Path;
  var Regions = root.Regions;
  var WorkGivers = root.WorkGivers;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

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

  var Reform = {};

  /* ============================================================
     1. TUNING

     Ticks: 60 to the second, 60000 to the day. A rate written per
     day is divided by the beat it runs on.
     ============================================================ */

  var DAY = 60000;
  var HOUR = 2500;
  var RARE = 250;              /* the staggered per-prisoner beat     */
  var FACILITY_BEAT = 250;     /* rooms, rosters, enrolment           */
  var SLOW_BEAT = 2500;        /* recidivism and the world outside    */

  var SESSION_TICKS = 2200;    /* a little under an hour of regime    */
  var SESSION_GRACE = 600;     /* how long a session waits for a class */
  var STUDY_TICKS = 1800;
  var ATTEND_FRACTION = 0.55;  /* of the session, to count as present */

  var LABOUR_BATCH = 2400;     /* work units in one produced batch    */
  var LABOUR_BASE = 0.55;      /* work units per tick, unskilled      */
  var SUPERVISION_RADIUS = 9;

  var LEDGER_CAP = 160;
  var INCIDENT_CAP = 16;       /* per prisoner - a record is bounded  */
  var RELEASE_CAP = 60;
  var RETURN_CAP = 40;

  /* How long after they walk out before the world hears from them
     again, and how long the window stays open. */
  var RETURN_MIN = DAY * 5;
  var RETURN_MAX = DAY * 32;

  var Reform_VERSION = 1;

  /* ============================================================
     2. CONTENT

     Registered additively at load. Nothing here runs.
     ============================================================ */

  var S11 = { w: 1, h: 1 };
  var S21 = { w: 2, h: 1 };

  /* def_things.js keeps its building template private, so the shape is
     written out again, exactly as prison.js and slavery.js do, and for
     the same reason: every consumer may read every field. */
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

    /* ---- the six programme rooms, one object each ---- */

    classroomDesk: {
      label: 'classroom desk',
      description: 'A desk, a slate and somewhere to put an elbow. Put four in a lit room and ' +
        'you have a classroom; put one in a corridor and you have a desk in a corridor.',
      sprite: 'research', color: '#8a6134', color2: '#d8cba8',
      hp: 90, mass: 30, fillPercent: 0.45, beauty: 1, flammable: true,
      buildCost: { wood: 30 }, workToBuild: 420, buildCategory: 'furniture',
      building: bld({ interactionOffset: { dx: 0, dy: 1 } })
    },

    vocationalBench: {
      label: 'training bench',
      description: 'A bench laid out with the tools of a trade and nothing sharp left loose. ' +
        'Prisoners trained on it work faster in your workshop and are worth more to whoever ' +
        'they end up working for.',
      sprite: 'smithy', color: '#6f7480', color2: '#c98a3c',
      size: S21, hp: 160, mass: 70, fillPercent: 0.5, beauty: 0,
      buildCost: { wood: 25, steel: 30 }, workToBuild: 900, buildCategory: 'furniture',
      building: bld({ interactionOffset: { dx: 0, dy: 1 } })
    },

    detoxCot: {
      label: 'detox cot',
      description: 'A low cot with a bucket beside it and a light that stays on. Coming off ' +
        'something is a medical event, and this is where it happens instead of in a cell.',
      sprite: 'bed', color: '#9fb0b8', color2: '#e0e4e8',
      size: S11, hp: 100, mass: 35, fillPercent: 0.4, beauty: -1,
      buildCost: { cloth: 20, steel: 15 }, workToBuild: 560, buildCategory: 'furniture',
      building: bld({ interactionOffset: { dx: 0, dy: 1 } })
    },

    therapyChairs: {
      label: 'therapy circle',
      description: 'Chairs facing each other with nothing between them. It looks like nothing ' +
        'and it is the only thing in the prison that reliably stops a man hitting people.',
      sprite: 'stool', color: '#7d6a4f', color2: '#a98f68',
      size: S21, hp: 80, mass: 25, fillPercent: 0.35, beauty: 2, flammable: true,
      buildCost: { wood: 35 }, workToBuild: 480, buildCategory: 'furniture',
      building: bld({ interactionOffset: { dx: 0, dy: 1 } })
    },

    chapelLectern: {
      label: 'lectern',
      description: 'Somewhere to stand and be listened to. What gets said from it is whatever ' +
        'your colony believes, and prisoners who come to believe it stop counting the days.',
      sprite: 'sculpture', color: '#c9b48a', color2: '#ffc23c',
      hp: 110, mass: 40, fillPercent: 0.5, beauty: 4, flammable: true,
      buildCost: { wood: 40 }, workToBuild: 620, buildCategory: 'furniture',
      building: bld({ interactionOffset: { dx: 0, dy: 1 } })
    },

    counsellingDesk: {
      label: 'counselling desk',
      description: 'Two chairs and a table, one prisoner at a time. The slowest programme in ' +
        'the building and the one that most reliably empties a cell.',
      sprite: 'table', color: '#8a6134', color2: '#c9b48a',
      size: S21, hp: 130, mass: 50, fillPercent: 0.5, beauty: 2, flammable: true,
      buildCost: { wood: 30, cloth: 10 }, workToBuild: 520, buildCategory: 'furniture',
      building: bld({ interactionOffset: { dx: 0, dy: 1 } })
    },

    /* ---- the three labour lines ---- */

    prisonWorkbench: {
      label: 'prison workbench',
      description: 'A bolted-down bench with counted tools. Prisoners cut stone blocks here. ' +
        'It is the one thing in a prison that makes money, and every tool on it is a weapon ' +
        'that has not been taken yet.',
      sprite: 'stonecutter', color: '#6e6e78', color2: '#8f97a3',
      size: S21, hp: 200, mass: 90, fillPercent: 0.5, beauty: -1,
      buildCost: { steel: 40, wood: 20 }, workToBuild: 1100, buildCategory: 'production',
      building: bld({ isWorkbench: true, interactionOffset: { dx: 0, dy: 1 } })
    },

    prisonKitchen: {
      label: 'prison kitchen',
      description: 'A steel range behind a grille. Prisoners cook for the block, which is ' +
        'cheaper than your cooks doing it and puts a knife in a room full of prisoners.',
      sprite: 'stove', color: '#7b828d', color2: '#c0392b',
      size: S21, hp: 180, mass: 85, fillPercent: 0.5, beauty: -1,
      buildCost: { steel: 45, components: 1 }, workToBuild: 1000, buildCategory: 'production',
      building: bld({ isWorkbench: true, isStove: true, interactionOffset: { dx: 0, dy: 1 } })
    },

    prisonLaundry: {
      label: 'laundry tub',
      description: 'Hot water and a mangle. It produces nothing you can sell and it is the ' +
        'difference between a block that smells and a block that does not, which turns out ' +
        'to be most of what a riot is about.',
      sprite: 'barrel', color: '#8fa0a8', color2: '#c6ccd4',
      hp: 120, mass: 55, fillPercent: 0.5, beauty: 0,
      buildCost: { steel: 25, wood: 15 }, workToBuild: 640, buildCategory: 'production',
      building: bld({ interactionOffset: { dx: 0, dy: 1 } })
    }

  }, BUILDING_DEFAULTS);

  Defs.add('research', {
    rehabilitation: {
      label: 'rehabilitation', cost: 1100, techLevel: 'medieval', tab: 'basic',
      description: 'The idea that a prisoner is a person who will one day be somewhere else, ' +
        'and the equipment that follows from it. Unlocks the programme rooms and the prison ' +
        'workshop that pays for them.',
      prerequisites: [],
      unlocks: ['classroomDesk', 'vocationalBench', 'detoxCot', 'therapyChairs',
                'chapelLectern', 'counsellingDesk', 'prisonWorkbench', 'prisonKitchen',
                'prisonLaundry'],
      uiPosition: { x: 1, y: 7 }
    }
  });

  Defs.add('workType', {
    instruct: {
      label: 'Instruct', verb: 'instructing', order: 6.7,
      description: 'Teach a class, run a therapy circle, supervise the prison workshop, and ' +
        'sit the hearings that decide who goes home. The colonists you put on this column are ' +
        'the colonists who are not doing anything else.',
      skills: ['social', 'intellectual'], relevantSkillsLabel: 'Social, Intellectual'
    }
  });

  var PSYCHOPATH = ['psychopath'];

  Defs.add('thought', {
    reformSession: {
      label: 'Sat through a class', durationDays: 0.8, stackLimit: 3,
      stages: [{ label: 'Something to do that is not the wall', mood: 0.05 }]
    },
    reformBreakthrough: {
      label: 'Something got through', durationDays: 3, stackLimit: 2,
      stages: [{ label: 'Somebody in here talked sense at me', mood: 0.12 }]
    },
    reformGraduated: {
      label: 'Finished the programme', durationDays: 8, stackLimit: 3,
      stages: [{ label: 'I finished something', mood: 0.16 }]
    },
    reformCompelled: {
      label: 'Marched to a class', durationDays: 0.8, stackLimit: 3,
      stages: [{ label: 'They made me sit there', mood: -0.07 }]
    },
    reformLabourHard: {
      label: 'Worked into the ground', durationDays: 1.2, stackLimit: 4,
      stages: [{ label: 'They work us until we drop', mood: -0.11 }]
    },
    reformLabourPaid: {
      label: 'The work was worth doing', durationDays: 1, stackLimit: 2,
      stages: [{ label: 'At least the work was worth doing', mood: 0.06 }]
    },
    reformParoleHope: {
      label: 'A date to count to', durationDays: 6, stackLimit: 1,
      stages: [{ label: 'They said I might go home', mood: 0.14 }]
    },
    reformParoleRefused: {
      label: 'Turned down at the hearing', durationDays: 4, stackLimit: 2,
      stages: [{ label: 'They turned me down', mood: -0.15 }]
    },
    /* The colony's own feeling about the far end of all this. */
    reformBetrayed: {
      label: 'Our parolee came back armed', durationDays: 10, stackLimit: 3,
      nullifiedByTrait: PSYCHOPATH,
      stages: [{ label: 'We let them go and they came back shooting', mood: -0.12 }]
    },
    reformVindicated: {
      label: 'Somebody we let go came good', durationDays: 8, stackLimit: 2,
      stages: [{ label: 'Somebody we let go came back to help', mood: 0.11 }]
    }
  });

  /* ============================================================
     3. THE PROGRAMMES

     Six rows. Each names the object it needs, the skill it is taught
     with, how many sessions make a graduate, and what graduating
     actually changes. `eligible` is the class of prisoner it is for,
     which is what stops the colony putting a teetotal bookkeeper
     through addiction treatment.
     ============================================================ */

  var PROGRAMMES = {
    literacy: {
      id: 'literacy', label: 'Basic education', short: 'School',
      description: 'Letters, numbers and an hour a day of not being in a cell. It makes every ' +
        'other programme land better and it makes a released prisoner employable.',
      equipment: 'classroomDesk', skill: 'intellectual', minSkill: 3,
      sessions: 6, seatsPer: 1, maxClass: 5, teaches: 'intellectual', xp: 110,
      resistanceDrop: 0.9, allowStudy: true,
      eligible: function () { return true; }
    },
    vocational: {
      id: 'vocational', label: 'Workshop training', short: 'Trade',
      description: 'A trade. Trained prisoners produce far more on the labour lines, which is ' +
        'the programme that pays for the rest of them.',
      equipment: 'vocationalBench', skill: 'crafting', minSkill: 5,
      sessions: 7, seatsPer: 1, maxClass: 3, teaches: 'crafting', xp: 190,
      resistanceDrop: 0.6, allowStudy: false,
      eligible: function () { return true; }
    },
    detox: {
      id: 'detox', label: 'Addiction treatment', short: 'Detox',
      description: 'Supervised withdrawal on a cot instead of unsupervised withdrawal on a ' +
        'cell floor. Only for prisoners who are actually carrying an addiction.',
      equipment: 'detoxCot', skill: 'medicine', minSkill: 5,
      sessions: 8, seatsPer: 1, maxClass: 2, teaches: 'medicine', xp: 90,
      resistanceDrop: 1.1, allowStudy: false,
      eligible: function (pawn) {
        var D = sys('Drugs');
        if (D && D.isAddicted) return !!D.isAddicted(pawn);
        return hasTrait(pawn, 'gourmand');
      }
    },
    anger: {
      id: 'anger', label: 'Violence therapy', short: 'Therapy',
      description: 'A circle of chairs for the people who put somebody in your infirmary. It ' +
        'is the only thing that reliably stops the fights, and it is slow.',
      equipment: 'therapyChairs', skill: 'social', minSkill: 6,
      sessions: 8, seatsPer: 1, maxClass: 5, teaches: 'social', xp: 80,
      resistanceDrop: 0.8, allowStudy: false,
      eligible: function (pawn) {
        if (hasTrait(pawn, 'bloodlust') || hasTrait(pawn, 'volatile') ||
            hasTrait(pawn, 'abrasive') || hasTrait(pawn, 'psychopath')) return true;
        var ps = prisonStateOf(pawn);
        if (ps && (ps.misconducts > 0 || ps.rioting)) return true;
        return skillOf(pawn, 'melee') >= 6;
      }
    },
    faith: {
      id: 'faith', label: 'Ideological instruction', short: 'Faith',
      description: 'An hour at the lectern being told what this colony believes. A prisoner ' +
        'who comes to share your ideoligion stops being a captive and starts being a convert.',
      equipment: 'chapelLectern', skill: 'social', minSkill: 3,
      sessions: 5, seatsPer: 1, maxClass: 6, teaches: 'social', xp: 70,
      resistanceDrop: 1.6, allowStudy: false,
      eligible: function (pawn) {
        var I = sys('Ideology');
        if (I && I.sameFaithAsColony) return !I.sameFaithAsColony(pawn);
        return true;
      }
    },
    counsel: {
      id: 'counsel', label: 'Counselling', short: 'Counsel',
      description: 'One prisoner, one colonist, one hour, no audience. The most expensive ' +
        'programme per head in the building and the one that takes the fight out of people.',
      equipment: 'counsellingDesk', skill: 'social', minSkill: 4,
      sessions: 4, seatsPer: 1, maxClass: 1, teaches: 'social', xp: 120,
      resistanceDrop: 2.2, allowStudy: false,
      eligible: function () { return true; }
    }
  };

  var PROGRAMME_IDS = Object.keys(PROGRAMMES);

  Reform.PROGRAMMES = PROGRAMMES;
  Reform.programmes = function () {
    var out = [];
    for (var i = 0; i < PROGRAMME_IDS.length; i++) out.push(PROGRAMMES[PROGRAMME_IDS[i]]);
    return out;
  };
  Reform.programme = function (id) { return PROGRAMMES[id] || null; };
  /* prison.js asks whether programmes exist at all before it tells the
     player its facility audit is complete. */
  Reform.available = function (map) { return Reform.rooms(map).length > 0; };

  /* ============================================================
     4. THE LABOUR LINES

     Each line is a station, an input, an output and a set of tools
     that can walk. A line with no station cannot run; a line with a
     station and no input idles, which is a specific, legible failure
     the report names.
     ============================================================ */

  var LABOUR = {
    workshop: {
      id: 'workshop', label: 'Workshop', station: 'prisonWorkbench',
      input: { defId: 'stoneChunk', count: 1 },
      output: { defId: 'stoneBlocks', count: 18 },
      skill: 'crafting', tools: ['file', 'spike', 'shiv'], toolRisk: 1.3,
      description: 'Cutting stone blocks. The most valuable line and the one with the most ' +
        'metal lying on it.'
    },
    kitchen: {
      id: 'kitchen', label: 'Kitchen', station: 'prisonKitchen',
      input: { defId: null, count: 1, foodNutrition: 0.5 },
      output: { defId: 'mealSimple', count: 2 },
      skill: 'cooking', tools: ['knife', 'shiv'], toolRisk: 1.0,
      description: 'Cooking the block\'s meals from your raw food. Feeds the prison out of ' +
        'its own hours, and leaves knives in a room full of prisoners.'
    },
    laundry: {
      id: 'laundry', label: 'Laundry', station: 'prisonLaundry',
      input: null, output: null,
      skill: 'crafting', tools: ['pick'], toolRisk: 0.35,
      description: 'Washing. It sells for nothing and it is why the block does not smell, ' +
        'which is most of what unrest is made of.'
    },
    clean: {
      id: 'clean', label: 'Cleaning', station: null,
      input: null, output: null,
      skill: 'crafting', tools: [], toolRisk: 0,
      description: 'Mopping the corridors. Needs no equipment at all, produces nothing, and ' +
        'is better than eight hours of staring at a wall.'
    }
  };

  var LABOUR_IDS = Object.keys(LABOUR);
  Reform.LABOUR = LABOUR;
  Reform.lines = function () {
    var out = [];
    for (var i = 0; i < LABOUR_IDS.length; i++) out.push(LABOUR[LABOUR_IDS[i]]);
    return out;
  };

  var INTENSITY = {
    off:      { id: 'off', label: 'None', rate: 0, fatigue: 0, mood: 0, risk: 0, unrest: 0 },
    light:    { id: 'light', label: 'Light', rate: 0.55, fatigue: 0.4, mood: 0.03, risk: 0.7, unrest: -0.004 },
    standard: { id: 'standard', label: 'Standard', rate: 1.0, fatigue: 1.0, mood: 0, risk: 1.0, unrest: 0.002 },
    hard:     { id: 'hard', label: 'Hard', rate: 1.5, fatigue: 2.0, mood: -0.09, risk: 1.7, unrest: 0.012 }
  };
  Reform.INTENSITY = INTENSITY;

  var TOOL_CONTROL = {
    loose:   { id: 'loose', label: 'Loose', risk: 2.3, output: 1.12, staff: 0 },
    counted: { id: 'counted', label: 'Counted', risk: 1.0, output: 1.0, staff: 0.5 },
    strict:  { id: 'strict', label: 'Strict', risk: 0.3, output: 0.82, staff: 1 }
  };
  Reform.TOOL_CONTROL = TOOL_CONTROL;

  /* ============================================================
     5. STATE

     Module state is plain data and round-trips through save()/load().
     Anything belonging to one prisoner lives on `pawn.reform`, which
     save.js already carries inside the pawn blob.
     ============================================================ */

  function freshPolicy() {
    return {
      /* enrolment */
      autoEnrol: true,
      enrolCap: 2,                 /* programmes one prisoner may hold at once */
      attendance: 'voluntary',     /* 'voluntary' | 'compulsory'               */
      classSize: 4,                /* seats a session will fill                */
      minCellGrade: 0,             /* refuse to enrol below this cell grade    */

      /* labour */
      labour: 'standard',          /* off | light | standard | hard            */
      line: 'auto',                /* auto | workshop | kitchen | laundry | clean */
      toolControl: 'counted',
      supervision: 'shared',       /* none | shared | dedicated                */
      labourShareDays: 0.35,       /* days off the sentence per produced batch */

      /* the exit */
      paroleEnabled: true,
      paroleMinProgrammes: 1,
      paroleMinServedDays: 2,
      ransomEnabled: true,
      ransomMarkup: 1.0,
      releaseGift: 0,              /* silver handed over at the gate           */
      sentenceDays: 8,             /* the nominal term a new intake is given   */
      recordCap: INCIDENT_CAP
    };
  }

  function freshStats() {
    return {
      sessionsRun: 0, sessionsDisrupted: 0, sessionsAbandoned: 0,
      attendances: 0, absences: 0, compelled: 0,
      successes: 0, failures: 0, graduations: 0, studyHours: 0,
      byProgramme: {},
      labour: { ticks: 0, batches: 0, value: 0, toolsLost: 0, injuries: 0, idleBatches: 0,
                unsupervised: 0, byLine: {} },
      dispositions: { recruited: 0, enslaved: 0, released: 0, ransomed: 0, traded: 0,
                      paroled: 0, executed: 0, died: 0, escaped: 0 },
      silverIn: 0, silverOut: 0,
      recidivism: { left: 0, returned: 0, raider: 0, ally: 0, trader: 0, joiner: 0,
                    quiet: 0, paroleKept: 0, paroleBroken: 0 }
    };
  }

  function freshState() {
    var st = {
      version: Reform_VERSION,
      nextId: 1,
      sessions: [],
      ledger: [],
      releases: [],
      returns: [],
      policy: freshPolicy(),
      stats: freshStats(),
      lastBeat: -1,
      lastSlow: -1,
      mapId: 0
    };
    for (var i = 0; i < PROGRAMME_IDS.length; i++) {
      st.stats.byProgramme[PROGRAMME_IDS[i]] = {
        sessions: 0, attendances: 0, successes: 0, failures: 0, graduations: 0, disrupted: 0
      };
    }
    for (var k = 0; k < LABOUR_IDS.length; k++) {
      st.stats.labour.byLine[LABOUR_IDS[k]] = { batches: 0, value: 0, ticks: 0 };
    }
    return st;
  }

  Reform.state = freshState();
  Reform.policy = Reform.state.policy;

  Reform.reset = function () {
    Reform.state = freshState();
    Reform.policy = Reform.state.policy;
    _roster.length = 0;
    _known = {};
    _rooms = null;
    _roomsTick = -1;
    _tickSeen = -1;
    _emptyUntil = {};
    return Reform;
  };

  var _roster = [];
  var _known = {};
  var _rooms = null;
  var _roomsTick = -1;
  var _tickSeen = -1;
  var _driverInstalled = false;
  var _registered = false;
  /* When a room last had a session nobody came to, keyed programme:room.
     An instructor who has just stood in an empty classroom for ten
     minutes should go and do something else rather than open another. */
  var _emptyUntil = {};
  var _incidentsRegistered = false;

  function nextId() { return Reform.state.nextId++; }

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

  /* prison.js publishes its per-pawn state; reading it is how this file
     learns about solitary, misconduct and escape plans without owning
     any of them. It may simply not be loaded. */
  function prisonStateOf(pawn) {
    var P = sys('Prison');
    if (P && P.stateOf) return P.stateOf(pawn);
    return pawn ? (pawn.prisonState || null) : null;
  }

  function roomAt(map, x, y) {
    return (Regions && Regions.roomAt) ? Regions.roomAt(map, x, y) : null;
  }

  function roomIdAt(map, x, y) {
    if (Regions && Regions.roomIdAt) return Regions.roomIdAt(map, x, y);
    return map.roomId ? map.roomId[map.idx(x, y)] : 0;
  }

  function reachable(map, pawn, x, y) {
    if (!Path || !Path.reachable) return true;
    return Path.reachable(map, pawn.x, pawn.y, x, y, { pawn: pawn });
  }

  function gameMap() {
    var G = root.Game;
    return (G && G.map) || null;
  }

  /* A prisoner on an authorised move is not "out of their cell" as far
     as prisoners.js is concerned: `confineCool` is the hook it counts
     down, and topping it up every tick is what lets a class happen. */
  function authorise(pawn, ticks) {
    var st = pawn.prisoner;
    if (st) st.confineCool = Math.max(st.confineCool || 0, ticks || 60);
    var ps = pawn.prisonState;
    if (ps) ps.escortTicks = Math.max(ps.escortTicks || 0, ticks || 60);
  }

  /* Start a job that takes a prisoner out of their cell. The window
     has to be open before the driver paths, not after, because the
     confinement check runs later in this same tick. */
  function launchEscorted(pawn, job) {
    authorise(pawn, 150);
    if (Jobs.start(pawn, job)) return true;
    if (pawn.prisoner) pawn.prisoner.confineCool = 0;
    if (pawn.prisonState) pawn.prisonState.escortTicks = 0;
    return false;
  }

  function lockedDown(pawn) {
    var P = sys('Prison');
    if (!P || !P.lockdown) return false;
    var L = P.lockdown();
    if (!L || !L.on) return false;
    var ps = pawn && pawn.prisonState;
    return !L.blockId || !ps || L.blockId === ps.blockId;
  }

  function rioting(map) {
    var P = sys('Prison');
    if (!P || !P.riots) return false;
    var list = P.riots();
    return !!(list && list.length);
  }

  function prisonLog(kind, text, pawn) {
    var P = sys('Prison');
    if (P && P.log) {
      var ps = pawn && pawn.prisonState;
      P.log(kind, text, { pawn: pawn, blockId: ps ? ps.blockId : 0 });
    }
  }

  /* ============================================================
     6. THE LEDGER

     One line per thing the player should be able to trace back to a
     decision. Bounded, because a prison runs for a hundred days.
     ============================================================ */

  Reform.log = function (kind, text, opts) {
    opts = opts || {};
    var row = {
      tick: now(), kind: kind, text: text,
      pawnId: opts.pawn ? opts.pawn.id : (opts.pawnId || 0),
      name: opts.pawn ? fullName(opts.pawn) : (opts.name || ''),
      x: opts.pawn ? opts.pawn.x : (opts.x === undefined ? -1 : opts.x),
      y: opts.pawn ? opts.pawn.y : (opts.y === undefined ? -1 : opts.y)
    };
    var led = Reform.state.ledger;
    led.push(row);
    if (led.length > LEDGER_CAP) led.splice(0, led.length - LEDGER_CAP);
    return row;
  };

  Reform.ledger = function (n) {
    var led = Reform.state.ledger;
    if (!n || n >= led.length) return led.slice();
    return led.slice(led.length - n);
  };

  /* ============================================================
     7. THE RECORD

     Everything the colony knows about one prisoner, bounded so it
     cannot grow forever, and the input to every judgement below.
     ============================================================ */

  function blankProgress() {
    var out = {};
    for (var i = 0; i < PROGRAMME_IDS.length; i++) {
      out[PROGRAMME_IDS[i]] = {
        sessions: 0, attended: 0, missed: 0, failed: 0,
        study: 0, completed: false, completedTick: 0, quality: 0
      };
    }
    return out;
  }

  function record(pawn) {
    if (!pawn) return null;
    var r = pawn.reform;
    if (r) {
      /* A save written before a programme existed, or a pawn built by a
         scenario, can arrive with a short table. Fill the gaps rather
         than throwing the record away. */
      for (var i = 0; i < PROGRAMME_IDS.length; i++) {
        if (!r.progress[PROGRAMME_IDS[i]]) {
          r.progress[PROGRAMME_IDS[i]] = {
            sessions: 0, attended: 0, missed: 0, failed: 0,
            study: 0, completed: false, completedTick: 0, quality: 0
          };
        }
      }
      return r;
    }
    var st = pawn.prisoner || null;
    r = pawn.reform = {
      opened: now(),
      status: 'held',
      disposition: 'hold',
      factionId: st ? (st.factionId || null) : null,
      factionName: st ? (st.factionName || null) : null,
      sentenceTicks: Math.round(Reform.state.policy.sentenceDays * DAY),
      servedTicks: 0,
      remissionTicks: 0,
      enrolled: [],
      progress: blankProgress(),
      effects: { volatility: 1, gangPull: 1, output: 1, escape: 1, resistance: 1, rehab: 0 },
      labour: {
        line: null, progress: 0, ticks: 0, batches: 0, value: 0,
        toolsLost: 0, injuries: 0, supervisedTicks: 0, unsupervisedTicks: 0,
        idleTicks: 0, lastTick: 0
      },
      counters: {
        sessionsAttended: 0, sessionsMissed: 0, compelled: 0,
        programmesDone: 0, searchesFailed: 0, solitaryTicks: 0,
        misconducts: 0, escapeAttempts: 0, riots: 0, hungerHours: 0
      },
      incidents: [],
      parole: null,
      hearings: 0,
      lastHearingTick: -999999,
      ransomAsked: 0,
      exitVia: null,
      lastBeat: -1
    };
    note(pawn, 'intake', fullName(pawn) + ' was booked in' +
      (r.factionName ? ' from the ' + r.factionName : '') + '.');
    return r;
  }

  Reform.record = function (pawn) {
    if (!pawn) return null;
    if (!pawn.reform && !isPrisoner(pawn)) return null;
    return record(pawn);
  };

  function note(pawn, kind, text) {
    var r = pawn && pawn.reform;
    if (!r) return null;
    var row = { tick: now(), kind: kind, text: text };
    r.incidents.push(row);
    var cap = Reform.state.policy.recordCap || INCIDENT_CAP;
    if (r.incidents.length > cap) r.incidents.splice(0, r.incidents.length - cap);
    return row;
  }
  Reform.note = function (pawn, kind, text) { return note(pawn, kind, text); };

  /* What the prison did to them, read off prison.js rather than kept
     twice. Called on the prisoner's own rare beat. */
  function refreshCounters(pawn, r) {
    var ps = prisonStateOf(pawn);
    if (!ps) return;
    var c = r.counters;
    if (ps.contrabandFound > c.searchesFailed) {
      var gained = ps.contrabandFound - c.searchesFailed;
      c.searchesFailed = ps.contrabandFound;
      note(pawn, 'search', 'Searched and found holding' + (gained > 1 ? ' (x' + gained + ')' : '') + '.');
    }
    if (ps.misconducts > c.misconducts) {
      c.misconducts = ps.misconducts;
      note(pawn, 'misconduct', 'Written up for misconduct.');
    }
    if (ps.escapeAttempts > c.escapeAttempts) {
      c.escapeAttempts = ps.escapeAttempts;
      note(pawn, 'escape', 'Tried to get out.');
    }
    if (ps.solitaryLeft > 0) c.solitaryTicks += RARE;
    if (ps.rioting) c.riots += 1;
    if (pawn.needs && pawn.needs.food < 0.12) c.hungerHours += RARE / HOUR;
  }

  /* ============================================================
     8. WHAT PROGRAMMES CHANGE

     A completed programme is a set of numbers on the record, and
     those numbers are read by the escape planner, by the recruiter,
     by the labour lines, by the underground and - the part that
     matters - by whatever walks back over the ridge in thirty days.
     ============================================================ */

  function fractionOf(r, id) {
    var p = r.progress[id];
    if (!p) return 0;
    var def = PROGRAMMES[id];
    if (!def) return 0;
    var f = p.sessions / def.sessions;
    if (p.completed) f = Math.max(f, 1);
    return U.clamp01(f);
  }

  function recomputeEffects(pawn, r) {
    var lit = fractionOf(r, 'literacy');
    var voc = fractionOf(r, 'vocational');
    var det = fractionOf(r, 'detox');
    var ang = fractionOf(r, 'anger');
    var fai = fractionOf(r, 'faith');
    var cou = fractionOf(r, 'counsel');

    var e = r.effects;
    /* Volatility: how likely they are to start something. Therapy does
       most of it, counselling the rest. */
    e.volatility = U.clamp(1 - 0.30 * ang - 0.14 * cou - 0.06 * lit - 0.05 * det, 0.30, 1);
    /* The pull of the block's crews, which is mostly boredom and fear. */
    e.gangPull = U.clamp(1 - 0.26 * ang - 0.20 * cou - 0.12 * fai - 0.06 * lit, 0.32, 1);
    /* What an hour of their labour is worth. */
    e.output = U.clamp(1 + 0.42 * voc + 0.14 * lit + 0.08 * det, 1, 1.95);
    /* How badly they still want to be over the wall. */
    e.escape = U.clamp(1 - 0.30 * cou - 0.20 * fai - 0.12 * ang - 0.10 * lit - 0.06 * det, 0.22, 1);
    /* How much fight is left in the argument about joining you. */
    e.resistance = U.clamp(1 - 0.22 * fai - 0.18 * cou - 0.10 * lit - 0.08 * ang, 0.35, 1);
    /* The one number the far end of the story reads. */
    e.rehab = U.clamp01(0.16 * lit + 0.20 * voc + 0.16 * det + 0.20 * ang + 0.12 * fai + 0.18 * cou);
    return e;
  }

  /* Recomputed rather than read: the table is six lookups and a line of
     arithmetic, and a cached answer is wrong for everything between a
     graduation and the prisoner's next beat - which is exactly when a
     panel or another system asks. */
  Reform.effectsOf = function (pawn) {
    var r = pawn && pawn.reform;
    if (!r) return { volatility: 1, gangPull: 1, output: 1, escape: 1, resistance: 1, rehab: 0 };
    return recomputeEffects(pawn, r);
  };

  /* Published so anything that wants to ask can, and used here on the
     prisoner's own beat so they are real whether or not it does. */
  Reform.rehabilitation = function (pawn) { return Reform.effectsOf(pawn).rehab; };
  Reform.volatilityFactor = function (pawn) { return Reform.effectsOf(pawn).volatility; };
  Reform.gangPull = function (pawn) { return Reform.effectsOf(pawn).gangPull; };
  Reform.outputFactor = function (pawn) { return Reform.effectsOf(pawn).output; };
  Reform.escapeFactor = function (pawn) { return Reform.effectsOf(pawn).escape; };

  /* Applying them. Each of these writes to a field its owner publishes
     and recomputes anyway, so nothing here is reaching behind a wall:
     the escape plan is prison.js's own accumulator, resistance is
     prisoners.js's own counter, and favours and grudge are the two
     numbers contraband.js says decide who ends up in a crew. */
  function applyEffects(pawn, r) {
    var e = r.effects;
    if (e.rehab <= 0.02) return;

    var ps = prisonStateOf(pawn);
    if (ps && ps.plan && ps.plan.score > 0) {
      /* A prisoner who has somewhere to be in the morning stops
         rehearsing the corridor. */
      ps.plan.score = Math.max(0, ps.plan.score * (1 - 0.06 * (1 - e.escape)));
    }

    var st = pawn.prisoner;
    if (st && st.resistance > 0 && e.resistance < 1) {
      st.resistance = Math.max(0, st.resistance - 0.05 * (1 - e.resistance));
    }

    var cb = pawn.contraband;
    if (cb && e.gangPull < 1) {
      var pull = 1 - e.gangPull;
      if (cb.favours > 0) cb.favours = Math.max(0, cb.favours - 0.08 * pull);
      if (cb.grudge > 0) cb.grudge = Math.max(0, cb.grudge - 0.02 * pull);
    }

    /* Volatility is spent on the people they would otherwise be hitting:
       social.js starts a fight off a bad opinion, so therapy repairs the
       worst one in the block rather than suppressing the symptom. */
    if (e.volatility < 0.8 && U.chance(0.06)) mendWorstOpinion(pawn);
  }

  function mendWorstOpinion(pawn) {
    var S = sys('Social');
    if (!S || !S.rivalsOf || !S.addMemory) return;
    var rivals = S.rivalsOf(pawn, -25) || [];
    if (!rivals.length) return;
    var row = rivals[0];
    var other = row && (row.pawn || row.other || row);
    if (!other || !other.id || other === pawn) return;
    S.addMemory(pawn, other, 'deepTalk', 0.6);
    S.addMemory(other, pawn, 'deepTalk', 0.4);
  }

  /* ============================================================
     9. THE FACILITY

     A programme room is a real room with the right object in it. The
     seats are the cells a prisoner can actually sit on, which is why
     a lectern in a corridor teaches nobody.
     ============================================================ */

  function seatCellsFor(map, thing) {
    var out = [];
    var rid = roomIdAt(map, thing.x, thing.y);
    var spot = (typeof thing.interactionCell === 'function') ? thing.interactionCell() : null;
    if (spot && map.inBounds(spot.x, spot.y) && map.passable(spot.x, spot.y)) {
      out.push({ x: spot.x, y: spot.y });
    }
    for (var i = 0; i < U.ADJ8.length && out.length < 4; i++) {
      var x = thing.x + U.ADJ8[i][0], y = thing.y + U.ADJ8[i][1];
      if (!map.inBounds(x, y) || !map.passable(x, y)) continue;
      if (roomIdAt(map, x, y) !== rid) continue;
      var dup = false;
      for (var k = 0; k < out.length; k++) if (out[k].x === x && out[k].y === y) dup = true;
      if (!dup) out.push({ x: x, y: y });
    }
    return out;
  }

  function roomQualityOf(map, room) {
    /* A class held in a clean, lit, roofed room lands; a class held in
       a cold shed with blood on the floor does not. Returns -1..1. */
    if (!room) return -0.4;
    var q = 0;
    q += U.curve([[0, -0.6], [12, -0.1], [30, 0.2], [70, 0.35]], room.size || 1);
    q += U.clamp((room.beauty || 0) / 25, -0.35, 0.35);
    q += U.clamp((room.cleanliness || 0) / 2.2, -0.3, 0.3);
    if (room.outdoor) q -= 0.35;
    else if (!room.roofed) q -= 0.2;
    var temp = room.temperature;
    if (typeof temp === 'number') {
      if (temp < 8) q -= U.clamp((8 - temp) / 24, 0, 0.4);
      if (temp > 32) q -= U.clamp((temp - 32) / 20, 0, 0.35);
    }
    var P = sys('Power');
    if (P && P.lightAt) {
      var light = P.lightAt(map, room.cells && room.cells.length ? map.xOf(room.cells[0]) : 0,
                            room.cells && room.cells.length ? map.yOf(room.cells[0]) : 0);
      if (light < 0.35) q -= 0.25;
    }
    return U.clamp(q, -1, 1);
  }

  Reform.rooms = function (map) {
    map = map || gameMap();
    if (!map) return [];
    var t = now();
    if (_rooms && _roomsTick === t && _rooms.mapId === (map.__reformId || 0)) return _rooms.list;

    map.__reformId = map.__reformId || U.nextId();
    var byKey = {};
    var list = [];

    for (var i = 0; i < PROGRAMME_IDS.length; i++) {
      var def = PROGRAMMES[PROGRAMME_IDS[i]];
      var pieces = map.byDef(def.equipment) || [];
      for (var j = 0; j < pieces.length; j++) {
        var thing = pieces[j];
        if (!thing || thing.spawned === false || thing.isBlueprint || thing.isFrame) continue;
        var rid = roomIdAt(map, thing.x, thing.y);
        var key = def.id + ':' + rid;
        var entry = byKey[key];
        if (!entry) {
          var room = roomAt(map, thing.x, thing.y);
          entry = byKey[key] = {
            programmeId: def.id, roomId: rid, pieces: [], seats: [],
            quality: roomQualityOf(map, room),
            x: thing.x, y: thing.y,
            outdoor: !!(room && room.outdoor)
          };
          list.push(entry);
        }
        entry.pieces.push(thing);
        var seats = seatCellsFor(map, thing);
        for (var s = 0; s < seats.length && entry.seats.length < 12; s++) entry.seats.push(seats[s]);
      }
    }

    /* Capacity is seats, but never more than the programme's class
       size: a counselling desk with four chairs round it is still one
       prisoner at a time. */
    for (var n = 0; n < list.length; n++) {
      var d = PROGRAMMES[list[n].programmeId];
      list[n].capacity = Math.max(1, Math.min(d.maxClass, list[n].pieces.length * d.seatsPer));
      if (!list[n].seats.length) list[n].seats.push({ x: list[n].x, y: list[n].y });
    }

    _rooms = { list: list, mapId: map.__reformId };
    _roomsTick = t;
    return list;
  };

  Reform.roomsFor = function (map, programmeId) {
    var all = Reform.rooms(map), out = [];
    for (var i = 0; i < all.length; i++) if (all[i].programmeId === programmeId) out.push(all[i]);
    return out;
  };

  /* The labour station a prisoner is standing at, or the best one in
     reach if the player has nominated a line. */
  function stationNear(map, pawn, lineId) {
    var line = LABOUR[lineId];
    if (!line || !line.station) return null;
    var list = map.byDef(line.station) || [];
    var best = null, bestD = 1e9;
    for (var i = 0; i < list.length; i++) {
      var thing = list[i];
      if (!thing || thing.spawned === false || thing.isBlueprint || thing.isFrame) continue;
      var d = U.distSq(pawn.x, pawn.y, thing.x, thing.y);
      if (d < bestD) { bestD = d; best = thing; }
    }
    if (!best) return null;
    if (bestD > 12 * 12 && !reachable(map, pawn, best.x, best.y)) return null;
    return best;
  }

  Reform.lineFor = function (pawn) {
    var map = pawn && pawn.map;
    if (!map) return null;
    var pol = Reform.state.policy;
    if (pol.labour === 'off') return null;
    if (pol.line !== 'auto') return LABOUR[pol.line] ? pol.line : null;
    /* Automatic: whichever station they are nearest, then cleaning,
       which needs nothing at all. */
    var best = null, bestD = 1e9;
    for (var i = 0; i < LABOUR_IDS.length; i++) {
      var line = LABOUR[LABOUR_IDS[i]];
      if (!line.station) continue;
      var thing = stationNear(map, pawn, line.id);
      if (!thing) continue;
      var d = U.distSq(pawn.x, pawn.y, thing.x, thing.y);
      if (d < bestD) { bestD = d; best = line.id; }
    }
    return best || 'clean';
  };

  /* ============================================================
     10. ENROLMENT

     The player's biggest knob. Automatic enrolment fills the rooms
     you built; turning it off means every prisoner sits in a cell
     until somebody says otherwise, which is a legitimate way to play
     and a legitimate way to end up with a riot.
     ============================================================ */

  Reform.eligible = function (pawn, programmeId) {
    var def = PROGRAMMES[programmeId];
    if (!def || !isPrisoner(pawn)) return false;
    try { return !!def.eligible(pawn); }
    catch (e) { return false; }
  };

  Reform.enrolled = function (pawn) {
    var r = pawn && pawn.reform;
    return r ? r.enrolled.slice() : [];
  };

  Reform.isEnrolled = function (pawn, programmeId) {
    var r = pawn && pawn.reform;
    return !!(r && r.enrolled.indexOf(programmeId) >= 0);
  };

  Reform.enrol = function (pawn, programmeId, byPlayer) {
    if (!isPrisoner(pawn) || !PROGRAMMES[programmeId]) return false;
    var r = record(pawn);
    if (r.enrolled.indexOf(programmeId) >= 0) return true;
    if (r.progress[programmeId].completed) return false;
    var pol = Reform.state.policy;
    if (!byPlayer && r.enrolled.length >= pol.enrolCap) return false;
    r.enrolled.push(programmeId);
    note(pawn, 'enrol', 'Enrolled in ' + PROGRAMMES[programmeId].label.toLowerCase() + '.');
    return true;
  };

  Reform.unenrol = function (pawn, programmeId) {
    var r = pawn && pawn.reform;
    if (!r) return false;
    if (!U.remove(r.enrolled, programmeId)) return false;
    note(pawn, 'enrol', 'Taken off ' + (PROGRAMMES[programmeId] ? PROGRAMMES[programmeId].label.toLowerCase() : programmeId) + '.');
    return true;
  };

  function autoEnrol(pawn, r, map) {
    var pol = Reform.state.policy;
    if (!pol.autoEnrol) return;
    if (r.enrolled.length >= pol.enrolCap) return;
    if (r.disposition === 'execute') return;

    /* A cell below the grade the player set is a cell whose occupant is
       in no state to learn anything, and saying so out loud is the point
       of the knob. */
    if (pol.minCellGrade > 0) {
      var P = sys('Prison');
      var cell = (P && P.cellOf) ? P.cellOf(pawn) : null;
      if (cell && typeof cell.grade === 'number' && cell.grade < pol.minCellGrade) return;
    }

    var rooms = Reform.rooms(map);
    var wanted = [];
    for (var i = 0; i < rooms.length; i++) {
      var id = rooms[i].programmeId;
      if (r.enrolled.indexOf(id) >= 0) continue;
      if (r.progress[id].completed) continue;
      if (!Reform.eligible(pawn, id)) continue;
      if (wanted.indexOf(id) < 0) wanted.push(id);
    }
    if (!wanted.length) return;

    /* Order of need, not order of the table: treat the addiction, then
       calm the violence, then teach them something. */
    var priority = { detox: 0, anger: 1, counsel: 2, literacy: 3, vocational: 4, faith: 5 };
    wanted.sort(function (a, b) { return priority[a] - priority[b]; });
    while (r.enrolled.length < pol.enrolCap && wanted.length) {
      Reform.enrol(pawn, wanted.shift(), false);
    }
  }

  /* ============================================================
     11. SESSIONS

     A session is an object with a register. It exists from the moment
     an instructor sits down to the moment they get up, and the only
     things that end it early are a lockdown, a riot, an instructor
     who was needed elsewhere, or an empty room.
     ============================================================ */

  function openSession(instructor, room) {
    var s = {
      id: nextId(),
      programmeId: room.programmeId,
      instructorId: instructor.id,
      roomId: room.roomId,
      x: room.x, y: room.y,
      capacity: room.capacity,
      quality: room.quality,
      startTick: now(),
      ticks: 0,
      length: SESSION_TICKS,
      present: {},
      register: [],
      closed: false,
      disrupted: false,
      reason: ''
    };
    Reform.state.sessions.push(s);
    return s;
  }

  Reform.sessions = function () { return Reform.state.sessions; };

  Reform.session = function (id) {
    var list = Reform.state.sessions;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  };

  function sessionInRoom(room) {
    var list = Reform.state.sessions;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (!s.closed && s.programmeId === room.programmeId && s.roomId === room.roomId) return s;
    }
    return null;
  }

  function seatsLeft(s) {
    var n = 0;
    for (var k in s.present) if (s.present[k] !== undefined) n++;
    return s.capacity - n;
  }

  Reform.markPresent = function (sessionId, pawn) {
    var s = Reform.session(sessionId);
    if (!s || s.closed || !pawn) return false;
    if (s.present[pawn.id] === undefined) {
      if (seatsLeft(s) <= 0) return false;
      s.present[pawn.id] = 0;
      s.register.push(pawn.id);
      var r = record(pawn);
      r.progress[s.programmeId].attended++;
      r.counters.sessionsAttended++;
      Reform.state.stats.attendances++;
      programmeStat(s.programmeId).attendances++;
    }
    s.present[pawn.id]++;
    return true;
  };

  function programmeStat(id) {
    var byP = Reform.state.stats.byProgramme;
    if (!byP[id]) {
      byP[id] = { sessions: 0, attendances: 0, successes: 0, failures: 0, graduations: 0, disrupted: 0 };
    }
    return byP[id];
  }

  /* The roll. Instructor first, because a bad teacher is the commonest
     reason a room full of equipment changes nobody. */
  function sessionSuccess(instructor, pawn, def, s, classSize) {
    var p = 0.28 + 0.028 * skillOf(instructor, def.skill);
    p += 0.12 * s.quality;
    p -= 0.035 * Math.max(0, classSize - 1);
    p += 0.20 * (moodOf(pawn) - 0.5);

    var r = record(pawn);
    p += 0.022 * r.progress[def.id].sessions;         /* momentum          */
    p += 0.05 * fractionOf(r, 'literacy');            /* school first      */

    if (hasTrait(pawn, 'toosmart')) p += 0.07;
    if (hasTrait(pawn, 'greatMemory')) p += 0.06;
    if (hasTrait(pawn, 'ironWilled')) p -= 0.08;
    if (hasTrait(pawn, 'psychopath')) p -= 0.12;
    if (hasTrait(pawn, 'volatile')) p -= 0.05;
    if (hasTrait(pawn, 'kind')) p += 0.04;
    if (def.id === 'anger' && hasTrait(pawn, 'bloodlust')) p -= 0.10;
    if (def.id === 'faith' && hasTrait(pawn, 'ironWilled')) p -= 0.06;
    if (def.id === 'detox' && hasTrait(pawn, 'ascetic')) p += 0.08;

    /* Somebody marched in at the end of a rifle learns less than
       somebody who chose to come. */
    if (Reform.state.policy.attendance === 'compulsory') p -= 0.09;

    var ps = prisonStateOf(pawn);
    if (ps) {
      if (ps.solitaryLeft > 0) p -= 0.15;
      p -= U.clamp(ps.misconducts * 0.015, 0, 0.12);
      p += U.clamp((ps.compliance || 0) * 0.12, 0, 0.12);
    }
    if (pawn.needs) {
      if (pawn.needs.food < 0.25) p -= 0.10;
      if (pawn.needs.rest < 0.25) p -= 0.10;
    }
    return U.clamp(p, 0.04, 0.92);
  }

  function runSessionOutcome(s, instructor) {
    var def = PROGRAMMES[s.programmeId];
    var map = instructor && instructor.map;
    if (!def || !map) return;

    var need = Math.round(s.length * ATTEND_FRACTION);
    var attendees = [];
    for (var i = 0; i < s.register.length; i++) {
      var pawn = pawnById(map, s.register[i]);
      if (!pawn || pawn.dead) continue;
      if ((s.present[pawn.id] || 0) < need) {
        var rMissed = record(pawn);
        rMissed.progress[def.id].missed++;
        rMissed.counters.sessionsMissed++;
        Reform.state.stats.absences++;
        note(pawn, 'programme', 'Left the ' + def.short.toLowerCase() + ' session early.');
        continue;
      }
      attendees.push(pawn);
    }

    for (var a = 0; a < attendees.length; a++) {
      var p = attendees[a];
      var r = record(p);
      var prog = r.progress[def.id];
      var chance = sessionSuccess(instructor, p, def, s, attendees.length);
      if (U.chance(chance)) {
        prog.sessions++;
        prog.quality = U.clamp01((prog.quality * (prog.sessions - 1) + chance) / prog.sessions);
        Reform.state.stats.successes++;
        programmeStat(def.id).successes++;
        think(p, 'reformSession');
        if (typeof p.learn === 'function') p.learn(def.teaches, def.xp);
        if (typeof instructor.learn === 'function') instructor.learn(def.skill, 35);
        if (U.chance(0.25)) think(p, 'reformBreakthrough');
        if (prog.sessions >= def.sessions && !prog.completed) graduate(p, def, instructor);
      } else {
        prog.failed++;
        Reform.state.stats.failures++;
        programmeStat(def.id).failures++;
        if (typeof instructor.learn === 'function') instructor.learn(def.skill, 12);
      }
      if (Reform.state.policy.attendance === 'compulsory') {
        think(p, 'reformCompelled');
        r.counters.compelled++;
        Reform.state.stats.compelled++;
      }
      recomputeEffects(p, r);
    }

    if (attendees.length) {
      Reform.log('session', nameOf(instructor) + ' ran ' + def.label.toLowerCase() + ' for ' +
        attendees.length + '.', { pawn: instructor });
    }
  }

  function closeSession(s, reason, instructor) {
    if (s.closed) return;
    s.closed = true;
    s.reason = reason || 'done';
    var def = PROGRAMMES[s.programmeId];

    if (reason === 'done') {
      Reform.state.stats.sessionsRun++;
      programmeStat(s.programmeId).sessions++;
      if (instructor) runSessionOutcome(s, instructor);
    } else if (reason === 'disrupted') {
      s.disrupted = true;
      Reform.state.stats.sessionsDisrupted++;
      programmeStat(s.programmeId).disrupted++;
      for (var i = 0; i < s.register.length; i++) {
        var pawn = pawnById(instructor && instructor.map, s.register[i]);
        if (!pawn) continue;
        var r = record(pawn);
        r.progress[s.programmeId].missed++;
        r.counters.sessionsMissed++;
        note(pawn, 'programme', 'Session broken up.');
      }
      Reform.state.stats.absences += s.register.length;
      if (def) {
        Reform.log('disrupted', def.label + ' was broken up: ' + (s.note || 'the block went down') + '.',
          { pawn: instructor });
      }
    } else {
      Reform.state.stats.sessionsAbandoned++;
      if (!s.register.length) _emptyUntil[s.programmeId + ':' + s.roomId] = now() + HOUR;
    }

    U.remove(Reform.state.sessions, s);
  }

  function pawnById(map, id) {
    if (!map || !id) return null;
    for (var i = 0; i < map.pawns.length; i++) if (map.pawns[i].id === id) return map.pawns[i];
    return null;
  }

  /* ---------- graduation ---------- */

  function graduate(pawn, def, instructor) {
    var r = record(pawn);
    var prog = r.progress[def.id];
    prog.completed = true;
    prog.completedTick = now();
    r.counters.programmesDone++;
    Reform.state.stats.graduations++;
    programmeStat(def.id).graduations++;
    U.remove(r.enrolled, def.id);
    recomputeEffects(pawn, r);

    think(pawn, 'reformGraduated');
    note(pawn, 'graduate', 'Completed ' + def.label.toLowerCase() + '.');

    /* The resistance drop is the thing the player actually feels: a
       graduate is measurably closer to saying yes. prisoners.js owns
       the number, so it is moved rather than replaced. */
    var st = pawn.prisoner;
    if (st && st.resistance > 0) {
      st.resistance = Math.max(0, st.resistance - def.resistanceDrop * (1 + 0.4 * prog.quality));
    }

    /* Programme-specific outcomes, each handed to the file that owns
       the thing being changed. */
    if (def.id === 'detox') finishDetox(pawn, instructor);
    if (def.id === 'faith') finishFaith(pawn, instructor);
    if (def.id === 'anger') finishAnger(pawn);
    if (def.id === 'vocational' && typeof pawn.learn === 'function') pawn.learn('crafting', 900);
    if (def.id === 'literacy' && typeof pawn.learn === 'function') pawn.learn('intellectual', 700);

    prisonLog('programme', fullName(pawn) + ' completed ' + def.label.toLowerCase() + '.', pawn);
    Reform.log('graduate', fullName(pawn) + ' completed ' + def.label.toLowerCase() + '.', { pawn: pawn });
    letter(fullName(pawn) + ' finished ' + def.label.toLowerCase(),
      fullName(pawn) + ' has completed ' + def.label.toLowerCase() + ' in your prison' +
      (instructor ? ', taught by ' + nameOf(instructor) : '') + '. ' + graduateBlurb(def) +
      ' Their resistance now stands at ' +
      (st ? U.fmt(st.resistance, 1) : 'nothing') + '.',
      'good', pawn);
  }

  function graduateBlurb(def) {
    switch (def.id) {
      case 'literacy': return 'They can read, which turns out to matter more than it sounds like it should.';
      case 'vocational': return 'They are worth nearly twice as much on the labour lines now.';
      case 'detox': return 'They are clean, and they know what it cost to get there.';
      case 'anger': return 'The thing that used to come out of them as a fist now comes out as words.';
      case 'faith': return 'They have started to talk about your colony as we rather than you.';
      default: return 'Somebody sat with them for long enough that it landed.';
    }
  }

  function finishDetox(pawn, instructor) {
    var D = sys('Drugs');
    if (!D || !D.addictions) return;
    var list = D.addictions(pawn) || [];
    var cleared = 0;
    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      if (!rec || rec.permanent) continue;
      if (pawn.drugs && pawn.drugs.add) {
        delete pawn.drugs.add[rec.chem];
        cleared++;
      }
    }
    if (cleared) {
      note(pawn, 'detox', 'Came off ' + cleared + ' addiction' + (cleared === 1 ? '' : 's') + '.');
      msg(nameOf(pawn) + ' has come off everything they were on.', pawn, 'good');
      if (instructor && typeof instructor.learn === 'function') instructor.learn('medicine', 240);
    }
  }

  function finishFaith(pawn, instructor) {
    var I = sys('Ideology');
    if (!I || !I.convertAttempt || !instructor) return;
    /* Conversion belongs here, and the attempt belongs to ideology.js.
       Five sessions buy several goes at it rather than one. */
    for (var i = 0; i < 3; i++) {
      var out = I.convertAttempt(instructor, pawn);
      if (out === true || (out && out.converted)) {
        note(pawn, 'faith', 'Converted to the colony\'s ideoligion.');
        return;
      }
    }
    note(pawn, 'faith', 'Finished instruction, still unconvinced.');
  }

  function finishAnger(pawn) {
    var S = sys('Social');
    if (!S || !S.rivalsOf) return;
    var rivals = S.rivalsOf(pawn, -20) || [];
    for (var i = 0; i < rivals.length && i < 3; i++) {
      var row = rivals[i];
      var other = row && (row.pawn || row.other || row);
      if (!other || other === pawn || !other.id) continue;
      if (S.addMemory) {
        S.addMemory(pawn, other, 'deepTalk', 1.4);
        S.addMemory(other, pawn, 'kindWord', 0.8);
      }
    }
    note(pawn, 'therapy', 'Made peace with the people they were fighting.');
  }

  /* ---------- attendance, from the regime ---------- */

  /* prison.js calls this for the hour its regime marks 'programme'. It
     returns true when it has actually started a job, which is the
     contract that file is written against. */
  Reform.tryAttend = function (pawn) {
    if (!isPrisoner(pawn) || pawn.downed || pawn.carriedBy) return false;
    var map = pawn.map;
    if (!map || !Jobs) return false;
    if (lockedDown(pawn)) return false;
    var ps = prisonStateOf(pawn);
    if (ps && ps.solitaryLeft > 0) return false;

    var r = record(pawn);
    if (r.disposition === 'execute') return false;

    var open = bestSessionFor(pawn, r, map);
    if (open) {
      var seat = pickSeat(open.session, open.room, pawn, map);
      if (seat) {
        var job = Jobs.make('reformAttend', T.cell(seat.x, seat.y), null,
          { state: { sessionId: open.session.id, programmeId: open.session.programmeId } });
        if (launchEscorted(pawn, job)) return true;
      }
    }

    /* No class running. A prisoner enrolled in something with a desk
       they can reach reads on their own, which is worth a fraction of
       a taught session and never the last one. */
    return trySelfStudy(pawn, r, map);
  };

  function bestSessionFor(pawn, r, map) {
    var list = Reform.state.sessions;
    var rooms = Reform.rooms(map);
    var best = null;
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      if (s.closed) continue;
      if (s.ticks > s.length * 0.6) continue;        /* too late to join */
      if (seatsLeft(s) <= 0) continue;
      if (r.enrolled.indexOf(s.programmeId) < 0) continue;
      if (!reachable(map, pawn, s.x, s.y)) continue;
      var room = null;
      for (var k = 0; k < rooms.length; k++) {
        if (rooms[k].programmeId === s.programmeId && rooms[k].roomId === s.roomId) room = rooms[k];
      }
      if (!room) continue;
      if (!best || U.distSq(pawn.x, pawn.y, s.x, s.y) < U.distSq(pawn.x, pawn.y, best.session.x, best.session.y)) {
        best = { session: s, room: room };
      }
    }
    return best;
  }

  function pickSeat(session, room, pawn, map) {
    var taken = {};
    for (var i = 0; i < map.pawns.length; i++) {
      var other = map.pawns[i];
      if (other === pawn || !other.job || other.job.defId !== 'reformAttend') continue;
      var st = other.job.state;
      if (st && st.sessionId === session.id) taken[other.x + ',' + other.y] = true;
    }
    for (var s = 0; s < room.seats.length; s++) {
      var seat = room.seats[s];
      if (taken[seat.x + ',' + seat.y]) continue;
      if (!map.passable(seat.x, seat.y)) continue;
      if (!reachable(map, pawn, seat.x, seat.y)) continue;
      return seat;
    }
    return room.seats.length ? room.seats[0] : null;
  }

  function trySelfStudy(pawn, r, map) {
    var rooms = Reform.rooms(map);
    for (var i = 0; i < rooms.length; i++) {
      var room = rooms[i];
      var def = PROGRAMMES[room.programmeId];
      if (!def || !def.allowStudy) continue;
      if (r.enrolled.indexOf(def.id) < 0) continue;
      var prog = r.progress[def.id];
      /* The last session needs a person in the room. Reading alone
         gets them to the door and no further. */
      if (prog.sessions >= def.sessions - 1) continue;
      if (sessionInRoom(room)) continue;
      var seat = pickSeat({ id: -1 }, room, pawn, map);
      if (!seat || !reachable(map, pawn, seat.x, seat.y)) continue;
      var job = Jobs.make('reformStudy', T.cell(seat.x, seat.y), null,
        { state: { programmeId: def.id } });
      if (launchEscorted(pawn, job)) return true;
    }
    return false;
  }

  Reform.creditStudy = function (pawn, programmeId) {
    var def = PROGRAMMES[programmeId];
    if (!def || !isPrisoner(pawn)) return false;
    var r = record(pawn);
    var prog = r.progress[programmeId];
    prog.study += 0.34 + 0.02 * skillOf(pawn, def.teaches);
    Reform.state.stats.studyHours += STUDY_TICKS / HOUR;
    if (typeof pawn.learn === 'function') pawn.learn(def.teaches, Math.round(def.xp * 0.35));
    while (prog.study >= 1 && prog.sessions < def.sessions - 1) {
      prog.study -= 1;
      prog.sessions++;
      note(pawn, 'study', 'Worked through the ' + def.short.toLowerCase() + ' material alone.');
    }
    recomputeEffects(pawn, r);
    return true;
  };

  /* ============================================================
     12. PRISON LABOUR

     prison.js's regime sends a prisoner to the workshop and calls in
     here every 250 ticks of it. This file decides what that hour was
     worth, whether anybody was watching, and what left the room in
     somebody's waistband.
     ============================================================ */

  function supervisionAt(map, x, y) {
    /* Anybody on the payroll standing nearby counts, because that is
       what supervision is. A dedicated supervisor is worth more than a
       passing hauler, and nobody at all is the interesting case. */
    var best = 0;
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (p.dead || p.downed || !p.isHuman) continue;
      if (p.faction !== 'player' || p.prisoner || p.slave) continue;
      if (U.cheb(p.x, p.y, x, y) > SUPERVISION_RADIUS) continue;
      var w = 0.5;
      var jobId = p.job && p.job.defId;
      if (jobId === 'reformSupervise') w = 1.3;
      else if (jobId === 'prisonManPost' || jobId === 'prisonPatrol' || jobId === 'prisonWatchDesk') w = 1.0;
      else if (p.drafted) w = 0.8;
      if (w > best) best = w;
    }
    var P = sys('Prison');
    if (P && P.coverageAt) {
      var cover = P.coverageAt(map, x, y);
      if (typeof cover === 'number') best = Math.max(best, U.clamp(cover, 0, 1.2));
    }
    return best;
  }

  Reform.supervisionAt = function (map, x, y) {
    map = map || gameMap();
    return map ? supervisionAt(map, x, y) : 0;
  };

  /* Find the input a batch needs, in the room the work is happening in.
     A workshop with no chunks in it is a room full of people pretending
     to cut stone, and the report says exactly that. */
  function takeInput(map, station, line) {
    if (!line.input) return true;
    var rid = roomIdAt(map, station.x, station.y);
    var wantFood = !!line.input.foodNutrition;

    /* Two passes on purpose. Taking as it goes would eat half a batch's
       worth of chunks and then report that there was nothing to work
       with, which is how a workshop quietly swallows a stockpile. */
    var found = [], have = 0;
    var need = wantFood ? (line.input.foodNutrition || 0) : (line.input.count || 1);

    /* U.cellsInRadius hands back [x, y] pairs, not objects. */
    var cells = U.cellsInRadius(station.x, station.y, 8);
    for (var c = 0; c < cells.length && have < need; c++) {
      var cx = cells[c][0], cy = cells[c][1];
      if (!map.inBounds(cx, cy)) continue;
      if (roomIdAt(map, cx, cy) !== rid) continue;
      var items = map.items(cx, cy);
      for (var i = 0; i < items.length && have < need; i++) {
        var item = items[i];
        if (!item || !item.def) continue;
        var per;
        if (wantFood) {
          if (!(item.def.nutrition > 0) || item.def.foodType === 'meal') continue;
          per = item.def.nutrition;
        } else {
          if (item.defId !== line.input.defId) continue;
          per = 1;
        }
        var take = Math.min(item.stack, Math.ceil((need - have) / per));
        if (take <= 0) continue;
        found.push({ thing: item, count: take });
        have += take * per;
      }
    }
    if (have + 0.001 < need) return false;

    for (var k = 0; k < found.length; k++) {
      found[k].thing.stack -= found[k].count;
      if (found[k].thing.stack <= 0) map.despawnThing(found[k].thing);
    }
    return true;
  }

  function produceBatch(map, pawn, station, line, r) {
    var stats = Reform.state.stats.labour;
    var byLine = stats.byLine[line.id] || (stats.byLine[line.id] = { batches: 0, value: 0, ticks: 0 });

    if (line.input && !takeInput(map, station, line)) {
      stats.idleBatches++;
      r.labour.idleTicks += LABOUR_BATCH;
      note(pawn, 'labour', 'Stood at the ' + line.label.toLowerCase() + ' with nothing to work on.');
      return false;
    }

    var value = 0;
    if (line.output && line.output.defId) {
      var made = map.addItem(line.output.defId, station.x, station.y, line.output.count);
      var def = Defs.maybe ? Defs.maybe('thing', line.output.defId) : Defs.thing(line.output.defId);
      var unit = (def && def.marketValue) || 1;
      value = unit * line.output.count;
      if (!made || !made.length) value = 0;
    } else if (line.id === 'laundry' || line.id === 'clean') {
      value = washBlock(map, station || pawn, pawn);
    }

    r.labour.batches++;
    r.labour.value += value;
    stats.batches++;
    stats.value += value;
    byLine.batches++;
    byLine.value += value;

    /* Time off the sentence. The player sets the rate, and a player who
       sets it high empties the prison faster than the programmes can
       finish, which is a real way to run it badly. */
    var share = Reform.state.policy.labourShareDays;
    if (share > 0) r.remissionTicks += Math.round(share * DAY);

    if (value > 0 && U.chance(0.3)) think(pawn, 'reformLabourPaid');
    return true;
  }

  /* The laundry and the mop produce no item, so their output is the
     state of the block: less filth, cleaner cells, less unrest. */
  function washBlock(map, at, pawn) {
    var cleaned = 0;
    var rid = roomIdAt(map, at.x, at.y);
    var cells = U.cellsInRadius(at.x, at.y, 7);
    for (var i = 0; i < cells.length && cleaned < 40; i++) {
      var cx = cells[i][0], cy = cells[i][1];
      if (!map.inBounds(cx, cy)) continue;
      var idx = map.idx(cx, cy);
      if (map.blood && map.blood[idx] > 0) {
        map.blood[idx] = Math.max(0, map.blood[idx] - 90);
        cleaned++;
      }
    }
    var P = sys('Prison');
    var list = prisonersOf(map);
    for (var p = 0; p < list.length; p++) {
      var other = list[p];
      if (roomIdAt(map, other.x, other.y) !== rid && U.cheb(other.x, other.y, at.x, at.y) > 10) continue;
      if (P && P.needs) {
        var n = P.needs(other);
        if (n) n.hygiene = U.clamp01(n.hygiene + 0.12);
      }
    }
    if (P && P.addUnrest) {
      var ps = pawn && pawn.prisonState;
      P.addUnrest(ps ? ps.blockId : 0, -0.012);
    }
    return Math.round(cleaned * 0.6);
  }

  function loseTool(map, pawn, line, r) {
    var C = sys('Contraband');
    r.labour.toolsLost++;
    Reform.state.stats.labour.toolsLost++;
    note(pawn, 'tool', 'A tool went missing off the ' + line.label.toLowerCase() + '.');
    Reform.log('tool', nameOf(pawn) + ' walked off the ' + line.label.toLowerCase() +
      ' with something they should not have.', { pawn: pawn });

    if (C && C.smuggle && line.tools.length) {
      var pick = U.pick(line.tools);
      C.smuggle(pawn, pick, 1);
      return true;
    }
    /* Without the underground loaded there is nowhere for a stolen tool
       to go, so it is still a fact on the record and still unrest. */
    var P = sys('Prison');
    if (P && P.noteMisconduct) P.noteMisconduct(pawn, 'took a tool off the line', 1);
    return false;
  }

  /* The entry point prison.js calls. `ticks` is the slice of the work
     toil that has just elapsed. */
  Reform.creditWork = function (pawn, ticks) {
    if (!isPrisoner(pawn) || pawn.downed) return 0;
    var map = pawn.map;
    if (!map) return 0;
    ticks = ticks || RARE;

    var pol = Reform.state.policy;
    var intensity = INTENSITY[pol.labour] || INTENSITY.standard;
    if (!intensity.rate) return 0;

    var r = record(pawn);
    var lineId = r.labour.line || Reform.lineFor(pawn);
    if (!lineId) return 0;
    r.labour.line = lineId;
    var line = LABOUR[lineId];
    if (!line) return 0;

    var station = line.station ? stationNear(map, pawn, lineId) : null;
    if (line.station && !station) {
      /* The player pointed the block at a line they never built. */
      r.labour.idleTicks += ticks;
      Reform.state.stats.labour.idleBatches++;
      return 0;
    }
    var at = station || pawn;

    var supervision = supervisionAt(map, at.x, at.y);
    var control = TOOL_CONTROL[pol.toolControl] || TOOL_CONTROL.counted;
    var superFactor = supervision > 0 ? U.clamp(0.72 + supervision * 0.28, 0.72, 1.12) : 0.5;
    if (supervision > 0) r.labour.supervisedTicks += ticks;
    else { r.labour.unsupervisedTicks += ticks; Reform.state.stats.labour.unsupervised += ticks; }

    var skillFactor = 0.55 + 0.055 * skillOf(pawn, line.skill);
    var moodFactor = U.curve([[0, 0.45], [0.35, 0.8], [0.7, 1.05], [1, 1.2]], moodOf(pawn));
    var work = ticks * LABOUR_BASE * intensity.rate * control.output *
               superFactor * skillFactor * moodFactor * r.effects.output;

    r.labour.progress += work;
    r.labour.ticks += ticks;
    r.labour.lastTick = now();
    Reform.state.stats.labour.ticks += ticks;
    var byLine = Reform.state.stats.labour.byLine[lineId];
    if (byLine) byLine.ticks += ticks;

    if (typeof pawn.learn === 'function') pawn.learn(line.skill, Math.round(ticks * 0.05));

    var made = 0;
    while (r.labour.progress >= LABOUR_BATCH && made < 3) {
      r.labour.progress -= LABOUR_BATCH;
      if (produceBatch(map, pawn, at, line, r)) made++;

      var risk = 0.030 * control.risk * line.toolRisk * intensity.risk *
                 (supervision > 0 ? 0.5 : 1.8) * r.effects.volatility;
      if (line.tools.length && U.chance(U.clamp(risk, 0, 0.6))) loseTool(map, pawn, line, r);
    }

    /* Hard labour is a cost and it lands on the body. */
    if (intensity.fatigue && pawn.needs) {
      pawn.needs.rest = U.clamp01(pawn.needs.rest - 0.00004 * intensity.fatigue * ticks);
    }
    if (intensity.mood < 0 && U.chance(0.05)) think(pawn, 'reformLabourHard');
    else if (intensity.mood > 0 && U.chance(0.04)) think(pawn, 'reformLabourPaid');

    if (intensity.unrest) {
      var P = sys('Prison');
      if (P && P.addUnrest) {
        var ps = pawn.prisonState;
        P.addUnrest(ps ? ps.blockId : 0, intensity.unrest * (ticks / RARE));
      }
    }

    /* An accident. Only on hard shifts, only on the lines with edges,
       and always the player's decision that put them there. */
    if (intensity.id === 'hard' && line.tools.length && U.chance(0.0035 * (ticks / RARE))) {
      hurtAtWork(pawn, r, line);
    }
    return work;
  };

  function hurtAtWork(pawn, r, line) {
    var H = sys('Health');
    r.labour.injuries++;
    Reform.state.stats.labour.injuries++;
    note(pawn, 'injury', 'Hurt on the ' + line.label.toLowerCase() + ' line.');
    if (H && H.damage) {
      H.damage(pawn, { amount: U.randInt(4, 11), type: 'cut', source: 'prison labour' });
    }
    var P = sys('Prison');
    if (P && P.addUnrest) {
      var ps = pawn.prisonState;
      P.addUnrest(ps ? ps.blockId : 0, 0.05);
    }
    Reform.log('injury', nameOf(pawn) + ' was hurt on the ' + line.label.toLowerCase() +
      ' line working a hard shift.', { pawn: pawn });
    msg(nameOf(pawn) + ' was hurt on the prison ' + line.label.toLowerCase() + ' line.', pawn, 'threat');
  }

  /* ============================================================
     13. DISPOSITIONS

     Every way out of the building, what each one needs, and what it
     costs. The UI draws this table; the work givers act on whichever
     row the player picked.
     ============================================================ */

  var DISPOSITIONS = ['hold', 'recruit', 'parole', 'release', 'ransom', 'trade', 'enslave', 'execute'];
  Reform.DISPOSITIONS = DISPOSITIONS;

  /* Who would be asked about this prisoner. factions.js knows the
     generated civilizations; the four built-in faction ids are not
     among them, and a raider with nobody to ask is a raider who can
     never be ransomed, which quietly removed the option from most of
     the prisoners a colony actually takes. */
  function factionOf(pawn) {
    var r = pawn && pawn.reform;
    var st = pawn && pawn.prisoner;
    var id = (st && st.factionId) || (r && r.factionId) || null;
    if (!id || id === 'player') return null;
    var F = sys('Factions');
    var known = (F && F.get) ? F.get(id) : null;
    if (known) return known;
    return {
      id: id,
      name: (r && r.factionName) || (id === 'raider' ? 'pirates' : id),
      goodwill: (F && F.goodwill) ? F.goodwill(id) : 0,
      permanentEnemy: id === 'raider',
      synthetic: true
    };
  }

  Reform.ransomValue = function (pawn) {
    var base = 300;
    base += skillOf(pawn, 'shooting') * 12 + skillOf(pawn, 'medicine') * 22 +
            skillOf(pawn, 'intellectual') * 18 + skillOf(pawn, 'construction') * 10;
    base *= U.curve([[16, 0.7], [24, 1.05], [40, 1], [58, 0.7], [75, 0.4]], pawn.ageYears || 30);
    var f = factionOf(pawn);
    if (f) {
      base *= 1 + U.clamp(f.goodwill || 0, -100, 100) / 260;
      if (f.kind && f.kind.techLevel === 'spacer') base *= 1.5;
      else if (f.kind && f.kind.techLevel === 'neolithic') base *= 0.6;
    }
    /* A prisoner you have beaten half to death is not worth what a
       healthy one is, and their people can tell. */
    var H = sys('Health');
    if (H && H.capacity) base *= U.clamp(H.capacity(pawn, 'consciousness'), 0.35, 1.1);
    var r = pawn.reform;
    if (r) base *= U.clamp(1 - r.counters.solitaryTicks / (DAY * 8), 0.5, 1);
    return Math.max(40, Math.round(base * (Reform.state.policy.ransomMarkup || 1)));
  };

  Reform.paroleChance = function (pawn) {
    var r = pawn && pawn.reform;
    if (!r) return 0;
    var p = 0.30 + 0.48 * r.effects.rehab;
    p += 0.18 * (moodOf(pawn) - 0.5);
    p -= 0.05 * r.counters.escapeAttempts;
    p -= 0.03 * r.counters.misconducts;
    p -= 0.04 * r.counters.searchesFailed;
    p += U.clamp(r.servedTicks / (DAY * 12), 0, 0.15);
    if (hasTrait(pawn, 'psychopath')) p -= 0.25;
    if (hasTrait(pawn, 'kind')) p += 0.10;
    if (hasTrait(pawn, 'ironWilled')) p -= 0.06;
    var cb = pawn.contraband;
    if (cb && cb.gangId) p -= 0.18;
    return U.clamp(p, 0.03, 0.96);
  };

  Reform.sentenceLeft = function (pawn) {
    var r = pawn && pawn.reform;
    if (!r) return 0;
    return Math.max(0, r.sentenceTicks - r.servedTicks - r.remissionTicks);
  };

  Reform.dispositions = function (pawn) {
    var out = [];
    if (!isPrisoner(pawn)) return out;
    var r = record(pawn);
    var pol = Reform.state.policy;
    var f = factionOf(pawn);
    var st = pawn.prisoner;
    var current = r.disposition;

    function row(id, label, available, reason, cost, gain, note) {
      out.push({
        id: id, label: label, available: !!available, reason: available ? '' : (reason || ''),
        cost: cost || {}, gain: gain || {}, note: note || '', current: current === id
      });
    }

    row('hold', 'Hold', true, '', { food: 'a meal a day', guard: 'guard hours' }, {},
      'Nothing happens. Time is doing the work, or it is not.');

    var resistance = st ? st.resistance : 0;
    row('recruit', 'Recruit', true, '',
      { goodwill: f ? -12 : 0, time: 'talk them down from ' + U.fmt(resistance, 1) },
      { colonist: 1 },
      'Programmes cut resistance directly; this prisoner is at ' +
      U.pct(1 - r.effects.resistance) + ' off their natural stubbornness.');

    var paroleOk = pol.paroleEnabled &&
      r.counters.programmesDone >= pol.paroleMinProgrammes &&
      r.servedTicks >= pol.paroleMinServedDays * DAY;
    var paroleWhy = !pol.paroleEnabled ? 'parole is switched off'
      : (r.counters.programmesDone < pol.paroleMinProgrammes
        ? 'needs ' + pol.paroleMinProgrammes + ' completed programme(s), has ' + r.counters.programmesDone
        : 'has served ' + U.fmt(r.servedTicks / DAY, 1) + ' of ' + pol.paroleMinServedDays + ' days');
    row('parole', 'Parole', paroleOk, paroleWhy,
      { risk: U.pct(1 - Reform.paroleChance(pawn)) + ' chance they break it' },
      { goodwill: f ? 10 : 0, mood: 'the colony approves' },
      'A hearing decides it. Keep the promise and they may come back as a friend; break it ' +
      'and they come back knowing the way in.');

    row('release', 'Release', true, '',
      { silver: pol.releaseGift },
      { goodwill: f ? 14 : 4 },
      'Straight out of the gate. The cheapest goodwill in the game and it costs you a body.');

    var ransomOk = pol.ransomEnabled && !!f && (f.goodwill === undefined || f.goodwill > -85);
    row('ransom', 'Ransom', ransomOk,
      !pol.ransomEnabled ? 'ransom is switched off'
        : (!f ? 'they have no people to ask' : 'their people will not deal with you'),
      {}, { silver: ransomOk ? Reform.ransomValue(pawn) : 0, goodwill: 6 },
      'Their civilization pays for them. Good money, and it tells every faction you sell people.');

    var S = sys('Slavery');
    var tradeOk = !!(S && S.canSell) ? !!S.canSell(pawn) : true;
    row('trade', 'Trade away', tradeOk, 'nobody is buying',
      { goodwill: f ? -24 : -8 },
      { silver: S && S.valueOf ? S.valueOf(pawn) : 250 },
      'Hand them to whoever is passing. Their people find out.');

    var enslaveOk = !!(S && S.setEnslave);
    row('enslave', 'Enslave', enslaveOk, 'slavery is not part of this game',
      { goodwill: f ? -20 : 0, mood: 'colonists who mind will mind' },
      { labour: 'permanent' },
      'slavery.js takes it from here: suppression, rebellion and all.');

    row('execute', 'Execute', true, '',
      { goodwill: f ? -32 : -10, mood: 'everybody who saw it', war: !!f },
      {},
      'Fast, final, and the single most expensive thing on this list.');

    return out;
  };

  Reform.setDisposition = function (pawn, id, by) {
    if (!isPrisoner(pawn) || DISPOSITIONS.indexOf(id) < 0) return false;
    var r = record(pawn);
    if (r.disposition === id) return true;
    r.disposition = id;
    note(pawn, 'disposition', 'Marked for ' + id + '.');

    var P = sys('Prisoners');
    if (P && P.setMode) {
      /* prisoners.js owns the four modes its own wardens act on, so the
         three this file adds are parked on 'hold' and picked up by the
         handover giver below. */
      if (id === 'recruit') P.setMode(pawn, 'recruit');
      else if (id === 'release') P.setMode(pawn, 'release');
      else if (id === 'execute') P.setMode(pawn, 'execute');
      else P.setMode(pawn, 'hold');
    }
    var S = sys('Slavery');
    if (S && S.setEnslave) S.setEnslave(pawn, id === 'enslave');

    if (id === 'parole') {
      think(pawn, 'reformParoleHope');
      r.hearings = r.hearings;      /* the hearing itself is a job */
    }
    Reform.log('disposition', fullName(pawn) + ' marked for ' + id +
      (by ? ' by ' + nameOf(by) : '') + '.', { pawn: pawn });
    return true;
  };

  Reform.disposition = function (pawn) {
    var r = pawn && pawn.reform;
    return r ? r.disposition : 'hold';
  };

  /* ---------- carrying a disposition out ---------- */

  function paySilver(map, x, y, amount) {
    if (amount <= 0) return 0;
    var Z = sys('Zones');
    var spot = null;
    if (Z && Z.bestStorageFor) {
      var fake = { defId: 'silver', def: Defs.maybe ? Defs.maybe('thing', 'silver') : null, stack: amount };
      try { spot = Z.bestStorageFor(map, fake, null); } catch (e) { spot = null; }
    }
    var tx = spot ? spot.x : x, ty = spot ? spot.y : y;
    map.addItem('silver', tx, ty, amount);
    Reform.state.stats.silverIn += amount;
    return amount;
  }

  Reform.ransom = function (prisoner, by) {
    if (!isPrisoner(prisoner)) return false;
    var map = prisoner.map;
    var r = record(prisoner);
    var f = factionOf(prisoner);
    if (!f || !Reform.state.policy.ransomEnabled) return false;
    if (f.goodwill !== undefined && f.goodwill <= -85) return false;
    var amount = Reform.ransomValue(prisoner);
    var who = fullName(prisoner);

    r.exitVia = 'ransomed';
    paySilver(map, prisoner.x, prisoner.y, amount);

    var F = sys('Factions');
    if (F && F.adjustGoodwill && !f.synthetic) {
      F.adjustGoodwill(f.id, 6, 'you ransomed ' + who + ' back to them');
    }

    var P = sys('Prisoners');
    if (P && P.release) P.release(prisoner, by);

    Reform.state.stats.dispositions.ransomed++;
    Reform.log('ransom', who + ' was ransomed for ' + amount + ' silver.', { pawn: prisoner });
    letter('Ransom paid for ' + who,
      (f.name || 'Their people') + ' paid ' + amount + ' silver for ' + who + ' and took them ' +
      'back. They will remember that you asked rather than took, and ' + who + ' will remember ' +
      'every corridor in this place.',
      'good', prisoner);
    return true;
  };

  Reform.tradeAway = function (prisoner, partner, by) {
    if (!isPrisoner(prisoner)) return false;
    var r = record(prisoner);
    var who = fullName(prisoner);
    var S = sys('Slavery');

    /* An enslaved prisoner is slavery.js's to sell, and it prices the
       sale, moves the silver and posts the fallout. */
    if (prisoner.slave && S && S.sell) {
      r.exitVia = 'traded';
      var ok = S.sell(prisoner, partner);
      if (ok) Reform.state.stats.dispositions.traded++;
      return !!ok;
    }

    var value = (S && S.valueOf) ? S.valueOf(prisoner) : 250;
    r.exitVia = 'traded';
    paySilver(prisoner.map, prisoner.x, prisoner.y, value);

    var f = factionOf(prisoner);
    var F = sys('Factions');
    if (F && F.adjustGoodwill && f && !f.synthetic) {
      F.adjustGoodwill(f.id, -24, 'you sold ' + who + ' to a passing trader');
    }
    var P = sys('Prisoners');
    if (P && P.release) P.release(prisoner, by);

    Reform.state.stats.dispositions.traded++;
    Reform.log('trade', who + ' was handed over for ' + value + ' silver.', { pawn: prisoner });
    letter(who + ' was sold on',
      who + ' has been handed to a passing trader for ' + value + ' silver' +
      (f ? '. The ' + (f.name || 'their people') + ' have heard about it' : '') +
      '. Wherever they end up, they will not have forgotten who put them there.',
      'neutral', prisoner);
    return true;
  };

  /* The hearing. A person sits down with the record and says yes or no,
     and the record is the only thing that decides it. */
  Reform.hearing = function (officer, prisoner) {
    if (!isPrisoner(prisoner)) return 'failed';
    var r = record(prisoner);
    r.hearings++;
    r.lastHearingTick = now();

    var pol = Reform.state.policy;
    if (!pol.paroleEnabled) return 'denied';

    var merit = 0.18 + 0.55 * r.effects.rehab + 0.03 * skillOf(officer, 'social');
    merit += U.clamp(r.counters.programmesDone * 0.08, 0, 0.24);
    merit -= 0.08 * r.counters.escapeAttempts;
    merit -= 0.05 * r.counters.misconducts;
    merit -= 0.06 * r.counters.searchesFailed;
    merit += U.clamp(r.servedTicks / (DAY * 10), 0, 0.2);
    if (Reform.sentenceLeft(prisoner) <= 0) merit += 0.25;
    merit = U.clamp(merit, 0.02, 0.97);

    if (!U.chance(merit)) {
      think(prisoner, 'reformParoleRefused');
      note(prisoner, 'hearing', 'Parole refused at hearing ' + r.hearings + '.');
      Reform.log('hearing', fullName(prisoner) + ' was refused parole.', { pawn: prisoner });
      msg(nameOf(officer) + ' refused ' + nameOf(prisoner) + ' parole.', officer);
      return 'denied';
    }
    Reform.parole(prisoner, officer);
    return 'granted';
  };

  Reform.parole = function (prisoner, by) {
    if (!isPrisoner(prisoner)) return false;
    var r = record(prisoner);
    var keep = Reform.paroleChance(prisoner);
    var who = fullName(prisoner);

    r.exitVia = 'paroled';
    r.parole = { grantedTick: now(), keepChance: keep, byId: by ? by.id : 0, breached: false };
    note(prisoner, 'parole', 'Paroled on a promise.');

    var f = factionOf(prisoner);
    var F = sys('Factions');
    if (F && F.adjustGoodwill && f && !f.synthetic) {
      F.adjustGoodwill(f.id, 10, 'you paroled ' + who + ' rather than keeping them');
    }

    var P = sys('Prisoners');
    if (P && P.release) P.release(prisoner, by);

    Reform.state.stats.dispositions.paroled++;
    Reform.log('parole', who + ' was paroled (' + U.pct(keep) + ' likely to keep it).', { pawn: prisoner });
    letter(who + ' has been paroled',
      who + ' walked out of your gate on a promise' + (by ? ' given to ' + nameOf(by) : '') +
      '. By your own records they are about ' + U.pct(keep) + ' likely to keep it. ' +
      'If they do, you have a friend out there. If they do not, they know your floor plan.',
      'neutral', prisoner);
    return true;
  };

  /* ============================================================
     14. LEAVING

     Nobody leaves without a record being written, whichever door
     they used. The roster sweep is what catches the ones this file
     did not personally show out - recruited, enslaved, executed,
     dead in the cells, or over the wall in the night.
     ============================================================ */

  function topSkills(pawn) {
    var out = [];
    if (!pawn.skills) return out;
    for (var id in pawn.skills) {
      var s = pawn.skills[id];
      if (s && s.level >= 6) out.push({ id: id, level: s.level });
    }
    out.sort(function (a, b) { return b.level - a.level; });
    return out.slice(0, 3);
  }

  /* How the colony treated them, 0..1. It is the other half of the
     recidivism roll, and it is entirely the player's doing. */
  function treatmentScore(pawn, r) {
    var t = 0.62;
    t -= U.clamp(r.counters.solitaryTicks / (DAY * 4), 0, 0.42);
    t -= U.clamp(r.counters.hungerHours / 60, 0, 0.30);
    t -= U.clamp(r.counters.misconducts * 0.02, 0, 0.14);
    t += U.clamp(r.counters.programmesDone * 0.10, 0, 0.30);
    t += U.clamp(r.labour.value / 2500, 0, 0.12);
    if (r.labour.injuries) t -= U.clamp(r.labour.injuries * 0.07, 0, 0.2);
    if (r.labour.unsupervisedTicks > r.labour.supervisedTicks * 3) t -= 0.05;
    var P = sys('Prison');
    if (P && P.cellOf) {
      var cell = P.cellOf(pawn);
      if (cell && typeof cell.grade === 'number') t += U.clamp((cell.grade - 2) * 0.05, -0.15, 0.15);
    }
    t += U.clamp((moodOf(pawn) - 0.5) * 0.3, -0.15, 0.15);
    return U.clamp01(t);
  }

  function recordRelease(pawn, via) {
    var r = pawn.reform;
    if (!r || r.status !== 'held') return null;
    r.status = via;
    var st = pawn.prisoner || null;

    Reform.state.stats.recidivism.left++;
    if (via === 'died' || via === 'executed' || via === 'recruited') {
      /* Nothing comes back from these three, and the first two are
         still the record the colony has to live with. */
      Reform.log('exit', fullName(pawn) + ': ' + via + '.', { pawn: pawn });
      return null;
    }

    var f = factionOf(pawn);
    var entry = {
      id: U.nextId(),
      pawnId: pawn.id,
      name: nameOf(pawn),
      full: fullName(pawn),
      kindId: pawn.kindId || 'raider',
      gender: pawn.gender,
      ageYears: pawn.ageYears,
      traits: (pawn.traits || []).slice(),
      skills: topSkills(pawn),
      factionId: f ? f.id : ((st && st.factionId) || null),
      factionName: f ? f.name : (r.factionName || null),
      via: via,
      tick: now(),
      dueTick: now() + Math.round(U.randRange(RETURN_MIN, RETURN_MAX)),
      rehab: r.effects.rehab,
      treatment: treatmentScore(pawn, r),
      programmes: r.counters.programmesDone,
      paroled: via === 'paroled',
      paroleKeep: r.parole ? r.parole.keepChance : 0,
      days: Math.round(r.servedTicks / DAY * 10) / 10,
      resolved: false,
      outcome: null
    };

    var list = Reform.state.releases;
    list.push(entry);
    if (list.length > RELEASE_CAP) list.splice(0, list.length - RELEASE_CAP);

    Reform.log('exit', entry.full + ' left the prison: ' + via + '.', { pawn: pawn });
    return entry;
  }

  function classifyExit(pawn) {
    var r = pawn.reform;
    if (!r) return null;
    if (r.exitVia) { var v = r.exitVia; r.exitVia = null; return v; }
    if (pawn.dead) {
      /* prisoners.js posts the execution letter and its own fallout; all
         this file records is which of the two it was. */
      var cause = (pawn.health && pawn.health.deathCause) || '';
      return (cause === 'execution' || r.disposition === 'execute') ? 'executed' : 'died';
    }
    if (pawn.slave) return 'enslaved';
    if (pawn.faction === 'player' && !pawn.prisoner) return 'recruited';
    if (pawn.released) return 'released';
    return 'escaped';
  }

  function refreshRoster(map) {
    var live = prisonersOf(map);
    var seen = {};
    for (var i = 0; i < live.length; i++) {
      var p = live[i];
      seen[p.id] = true;
      if (!_known[p.id]) _known[p.id] = p;
      record(p);
    }

    /* Anybody who was on the list last sweep and is not on it now has
       left by one door or another. */
    for (var id in _known) {
      if (seen[id]) continue;
      var pawn = _known[id];
      delete _known[id];
      if (!pawn || !pawn.reform) continue;
      var via = classifyExit(pawn);
      if (!via) continue;
      var stats = Reform.state.stats.dispositions;
      if (stats[via] !== undefined) stats[via]++;
      recordRelease(pawn, via);
    }

    _roster.length = 0;
    for (var k = 0; k < live.length; k++) _roster.push(live[k]);
  }

  /* ============================================================
     15. RECIDIVISM

     The reason the rest of this file exists. Everybody who walked out
     is still somewhere, and some day a weighted roll decides which
     version of them comes back.
     ============================================================ */

  var OUTCOMES = ['raider', 'joiner', 'ally', 'trader', 'quiet'];

  function returnWeights(entry) {
    var good = 0.10 + 0.85 * entry.rehab + 0.55 * entry.treatment;
    var bad = 0.20 + 0.70 * (1 - entry.rehab) + 0.60 * (1 - entry.treatment);

    if (entry.via === 'escaped') { bad += 0.85; good *= 0.3; }
    if (entry.via === 'traded') { bad += 0.70; good *= 0.25; }
    if (entry.via === 'enslaved') { bad += 0.95; good *= 0.15; }
    if (entry.via === 'ransomed') { bad *= 0.75; good += 0.20; }
    if (entry.via === 'released') { good += 0.25; }
    if (entry.paroled) {
      /* A parole is a coin the player minted themselves. */
      if (U.chance(entry.paroleKeep)) { good += 0.65; bad *= 0.35; entry.keptParole = true; }
      else { bad += 1.1; good *= 0.2; entry.keptParole = false; }
    }

    var F = sys('Factions');
    if (F && F.goodwill && entry.factionId) {
      var gw = F.goodwill(entry.factionId);
      good += U.clamp(gw, -100, 100) / 220;
      bad -= U.clamp(gw, -100, 100) / 300;
    }
    good = Math.max(0, good);
    bad = Math.max(0, bad);

    var G = root.Game;
    var colonists = (G && G.colonists) ? G.colonists().length : 5;
    return {
      raider: bad * 1.05,
      joiner: colonists >= 14 ? 0 : good * 0.42,
      ally: good * 0.55,
      trader: good * 0.48,
      quiet: 1.25
    };
  }

  function rollReturn(entry, game) {
    var w = returnWeights(entry);
    var pick = U.pickWeighted(OUTCOMES, function (id) { return w[id]; });
    if (!pick) pick = 'quiet';
    entry.resolved = true;
    entry.outcome = pick;
    entry.resolvedTick = now();

    var stats = Reform.state.stats.recidivism;
    stats.returned++;
    if (stats[pick] !== undefined) stats[pick]++;
    if (entry.paroled) {
      if (entry.keptParole) stats.paroleKept++;
      else stats.paroleBroken++;
    }

    var ret = { tick: now(), name: entry.full, via: entry.via, outcome: pick,
                rehab: Math.round(entry.rehab * 100) / 100,
                treatment: Math.round(entry.treatment * 100) / 100,
                programmes: entry.programmes, factionName: entry.factionName };
    Reform.state.returns.push(ret);
    if (Reform.state.returns.length > RETURN_CAP) {
      Reform.state.returns.splice(0, Reform.state.returns.length - RETURN_CAP);
    }

    if (pick === 'quiet') {
      Reform.log('return', entry.full + ' was never heard from again.', { name: entry.full });
      return true;
    }
    if (pick === 'raider') return returnAsRaider(entry, game);
    if (pick === 'joiner') return returnAsJoiner(entry, game);
    if (pick === 'ally') return returnAsAlly(entry, game);
    return returnAsTrader(entry, game);
  }

  function edgeCell(map) {
    var MG = sys('MapGen');
    var sides = ['n', 'e', 's', 'w'];
    U.shuffle(sides);
    for (var i = 0; i < sides.length; i++) {
      var cells = (MG && MG.edgeSpawnCells) ? MG.edgeSpawnCells(map, sides[i]) : null;
      if (cells && cells.length) return U.pick(cells);
    }
    /* Nothing walkable on any edge is possible on a sealed map; drop
       them on any passable cell rather than losing the story. */
    for (var t = 0; t < 400; t++) {
      var x = U.randInt(1, map.w - 2), y = U.randInt(1, map.h - 2);
      if (map.passable(x, y)) return { x: x, y: y };
    }
    return null;
  }

  function makeReturnee(map, entry, faction, points) {
    var MG = sys('MapGen');
    if (!MG || !MG.makePawn) return null;
    var cell = edgeCell(map);
    if (!cell) return null;
    var pawn = MG.makePawn(entry.kindId || 'raider', faction, {
      x: cell.x, y: cell.y, map: map,
      gender: entry.gender,
      ageYears: entry.ageYears,
      traits: entry.traits && entry.traits.length ? entry.traits.slice() : undefined,
      points: points
    });
    if (!pawn) return null;
    if (!map.addPawn(pawn, cell.x, cell.y)) return null;
    pawn.fx = pawn.x; pawn.fy = pawn.y;
    /* The name is the whole point: the player has to recognise them. */
    if (pawn.name && entry.name) pawn.name.nick = entry.name;
    pawn.reformReturnee = {
      via: entry.via, rehab: Math.round(entry.rehab * 100) / 100,
      leftTick: entry.tick, outcome: entry.outcome
    };
    /* Their old skills, because a trained prisoner is a trained enemy. */
    if (entry.skills && pawn.skills) {
      for (var i = 0; i < entry.skills.length; i++) {
        var s = pawn.skills[entry.skills[i].id];
        if (s && s.level < entry.skills[i].level) s.level = entry.skills[i].level;
      }
    }
    return pawn;
  }

  function hostileFactionFor(entry) {
    var F = sys('Factions');
    if (entry.factionId && F && F.hostileTo && F.hostileTo(entry.factionId, 'player')) {
      return entry.factionId;
    }
    return 'raider';
  }

  function returnAsRaider(entry, game) {
    var map = game && game.map;
    if (!map || !map.colonists().length) return false;
    var S = sys('Storyteller');
    var points = S && S.threatPoints ? S.threatPoints(game) : 120;
    points = U.clamp(points * 0.7, 45, 900);

    var faction = hostileFactionFor(entry);
    var leader = makeReturnee(map, entry, faction, points);
    if (!leader) return false;

    var escorts = 1 + Math.min(5, Math.round(points / 140));
    var MG = sys('MapGen');
    for (var i = 0; i < escorts; i++) {
      var cell = { x: leader.x + U.randInt(-2, 2), y: leader.y + U.randInt(-2, 2) };
      if (!map.inBounds(cell.x, cell.y) || !map.passable(cell.x, cell.y)) { cell.x = leader.x; cell.y = leader.y; }
      var friend = MG && MG.makePawn ? MG.makePawn(entry.kindId || 'raider', faction,
        { x: cell.x, y: cell.y, map: map, points: points }) : null;
      if (friend) {
        map.addPawn(friend, cell.x, cell.y);
        friend.fx = friend.x; friend.fy = friend.y;
      }
    }

    /* The block hears about it before the player does. */
    var P = sys('Prison');
    if (P && P.addUnrest) P.addUnrest(0, 0.18);
    if (P && P.log) P.log('escape', entry.full + ' is outside the wire with a gun.', { severity: 'warn' });

    /* And the colony feels it, if they were the ones who opened the gate. */
    if (entry.paroled || entry.via === 'released') {
      var list = map.colonists();
      for (var c = 0; c < list.length; c++) think(list[c], 'reformBetrayed');
    }

    Reform.log('return', entry.full + ' came back armed.', { pawn: leader });
    letter(entry.full + ' has come back',
      entry.full + ' was ' + exitPhrase(entry) + ' ' + entry.days + ' days in your cells. They are ' +
      'at the edge of the map with ' + escorts + ' others and they know the way in: which door ' +
      'you leave open, where the food is, and which wall is thin. ' +
      (entry.programmes ? 'Whatever those ' + entry.programmes + ' programme(s) did, it was not enough.'
                        : 'Nobody ever ran a programme for them.'),
      'threat', leader);
    return true;
  }

  function exitPhrase(entry) {
    switch (entry.via) {
      case 'paroled': return 'paroled after';
      case 'released': return 'released after';
      case 'ransomed': return 'ransomed after';
      case 'traded': return 'sold on after';
      case 'enslaved': return 'enslaved after';
      case 'escaped': return 'over the wall after';
      default: return 'let out after';
    }
  }

  function returnAsJoiner(entry, game) {
    var map = game && game.map;
    if (!map) return false;
    var pawn = makeReturnee(map, entry, 'player', undefined);
    if (!pawn) return false;
    pawn.faction = 'player';
    pawn.prisoner = false;
    /* They arrive with the colony's own work sheet, because they know
       the place. */
    var list = map.colonists();
    for (var i = 0; i < list.length; i++) {
      if (list[i] !== pawn) think(list[i], 'newColonistJoined');
      think(list[i], 'reformVindicated');
    }
    Reform.state.stats.dispositions.recruited++;
    Reform.log('return', entry.full + ' came back and asked to stay.', { pawn: pawn });
    letter(entry.full + ' has come back to stay',
      entry.full + ' walked back up to your gate with nothing, and asked whether the offer of a ' +
      'bunk still stood. They spent ' + entry.days + ' days in your cells and ' +
      (entry.programmes ? 'finished ' + entry.programmes + ' programme(s) while they were in there'
                        : 'nobody ran a programme for them') +
      '. They have joined the colony.',
      'good', pawn);
    return true;
  }

  function returnAsAlly(entry, game) {
    var F = sys('Factions');
    var gain = 8 + Math.round(entry.rehab * 18);
    if (F && F.adjustGoodwill && entry.factionId) {
      F.adjustGoodwill(entry.factionId, gain, entry.full + ' spoke for you at home');
    }
    var map = game && game.map;
    if (map) {
      var list = map.colonists();
      for (var i = 0; i < list.length; i++) think(list[i], 'reformVindicated');
    }
    Reform.log('return', entry.full + ' spoke for the colony back home.', { name: entry.full });
    letter('Word from ' + entry.full,
      'A message has come in from ' + entry.full + ', who spent ' + entry.days + ' days in your ' +
      'cells and was ' + exitPhrase(entry) + ' them. They have been telling ' +
      (entry.factionName || 'their people') + ' that you treat prisoners like people' +
      (F && entry.factionId ? ', and it is worth ' + gain + ' goodwill' : '') + '.',
      'good');
    return true;
  }

  function returnAsTrader(entry, game) {
    var Tr = sys('Trade');
    var fired = false;
    if (Tr && Tr.arrivingTrader && entry.factionId) {
      try { fired = !!Tr.arrivingTrader(game, entry.factionId); }
      catch (e) { fired = false; }
    }
    var F = sys('Factions');
    if (F && F.adjustGoodwill && entry.factionId) {
      F.adjustGoodwill(entry.factionId, 5, entry.full + ' sent business your way');
    }
    Reform.log('return', entry.full + ' came back trading.', { name: entry.full });
    letter(entry.full + ' is back, with goods',
      entry.full + ' learned a trade in your prison and has come back to use it on you. ' +
      (fired ? 'Their caravan is on your map now.'
             : 'They have put your colony on their route, which is worth more than one deal.'),
      'good');
    return true;
  }

  /* A hook for the debug menu and for the test that proves this can
     happen at all: force the oldest open release to resolve now. */
  Reform.forceReturn = function (outcome, game) {
    game = game || root.Game;
    var list = Reform.state.releases;
    for (var i = 0; i < list.length; i++) {
      if (list[i].resolved) continue;
      if (outcome) {
        list[i].resolved = true;
        list[i].outcome = outcome;
        var stats = Reform.state.stats.recidivism;
        stats.returned++;
        if (stats[outcome] !== undefined) stats[outcome]++;
        Reform.state.returns.push({ tick: now(), name: list[i].full, via: list[i].via,
          outcome: outcome, rehab: list[i].rehab, treatment: list[i].treatment,
          programmes: list[i].programmes, factionName: list[i].factionName });
        if (outcome === 'raider') return returnAsRaider(list[i], game);
        if (outcome === 'joiner') return returnAsJoiner(list[i], game);
        if (outcome === 'ally') return returnAsAlly(list[i], game);
        if (outcome === 'trader') return returnAsTrader(list[i], game);
        return true;
      }
      list[i].dueTick = now();
      return rollReturn(list[i], game);
    }
    return false;
  };

  Reform.pendingReturns = function () {
    var out = [], list = Reform.state.releases;
    for (var i = 0; i < list.length; i++) if (!list[i].resolved) out.push(list[i]);
    return out;
  };

  function tickReturns(game) {
    var list = Reform.state.releases;
    var t = now();
    var map = game && game.map;
    if (!map || !map.colonists().length) return;
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (entry.resolved || t < entry.dueTick) continue;
      /* One a beat, so two parolees never come over the ridge in the
         same second. */
      rollReturn(entry, game);
      return;
    }
  }

  /* The storyteller gets a handle on it too, so a colony that has been
     letting people go feels the pacing rather than only the clock. */
  function registerIncidents() {
    if (_incidentsRegistered) return false;
    var I = sys('Incidents');
    if (!I || !I.register) return false;
    _incidentsRegistered = true;
    I.register({
      id: 'reformReturn',
      label: 'a former prisoner comes back',
      category: 'misc',
      minDay: 6,
      weight: function () {
        var n = Reform.pendingReturns().length;
        return n ? Math.min(3, 0.6 + n * 0.35) : 0;
      },
      fire: function (g) {
        var list = Reform.state.releases;
        for (var i = 0; i < list.length; i++) {
          if (!list[i].resolved) return rollReturn(list[i], g);
        }
        return false;
      }
    });
    return true;
  }

  /* ============================================================
     16. JOBS

     Behaviour lives next to the system it belongs to. Everything a
     colonist or a prisoner physically does for this file is here;
     the scanning is in the work givers below.
     ============================================================ */

  function atTarget(which, mode) {
    return Toils.goto(which, { pe: mode === undefined ? PE.ON_CELL : mode, failIfGone: false });
  }

  /* The same walk, with the prisoner authorised for every tick of it.
     prisoners.js runs its confinement check on the tick, so a prisoner
     crossing the corridor to a classroom is "out of their cell" the
     whole way there: without this the first tick of the walk cancels
     the job and the class sits empty, which is exactly what it did. */
  function escortedGoto(which, mode) {
    var inner = Toils.goto(which, { pe: mode === undefined ? PE.ON_CELL : mode, failIfGone: false });
    return {
      name: 'escorted' + which,
      init: inner.init,
      tick: function (pawn, job, s) {
        authorise(pawn, 120);
        return inner.tick(pawn, job, s);
      },
      end: inner.end
    };
  }

  if (Jobs && Toils) {

    /* ---- the instructor ---- */
    Jobs.register('reformTeach', {
      label: 'teach', reportString: 'Running a programme.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.INTERACTION, failIfGone: true }),
          Toils.custom({
            name: 'session',
            init: function (pawn, job, s) {
              var map = pawn.map;
              var rooms = Reform.rooms(map);
              var anchor = T.resolve(job.targetA, map);
              var room = null;
              if (anchor) {
                var rid = roomIdAt(map, anchor.x, anchor.y);
                for (var i = 0; i < rooms.length; i++) {
                  if (rooms[i].roomId !== rid) continue;
                  var def = PROGRAMMES[rooms[i].programmeId];
                  if (def && def.equipment === anchor.defId) { room = rooms[i]; break; }
                }
              }
              if (!room) { s.session = null; return; }
              s.session = openSession(pawn, room);
              s.ticks = 0;
              s.empty = 0;
            },
            tick: function (pawn, job, s) {
              if (!s.session) return 'fail';
              var session = s.session;
              if (session.closed) return 'done';
              session.ticks++;
              s.ticks++;

              /* A lockdown or a riot ends the class where it stands. */
              if (s.ticks % 30 === 0) {
                if (rioting(pawn.map)) {
                  session.note = 'the block went up';
                  closeSession(session, 'disrupted', pawn);
                  return 'fail';
                }
                var P = sys('Prison');
                var L = P && P.lockdown ? P.lockdown() : null;
                if (L && L.on) {
                  session.note = 'a lockdown was called';
                  closeSession(session, 'disrupted', pawn);
                  return 'fail';
                }
              }

              /* Nobody turned up. Wait a while, then give the hour back. */
              if (!session.register.length) {
                s.empty++;
                if (s.empty > SESSION_GRACE) {
                  closeSession(session, 'abandoned', pawn);
                  return 'fail';
                }
                return 'stay';
              }
              s.empty = 0;

              if (session.ticks >= session.length) {
                closeSession(session, 'done', pawn);
                return 'done';
              }
              return 'stay';
            },
            end: function (pawn, job, s) {
              if (s.session && !s.session.closed) closeSession(s.session, 'abandoned', pawn);
            }
          })
        ];
      }
    });

    /* ---- the prisoner in the chair ---- */
    Jobs.register('reformAttend', {
      label: 'attend a programme', reportString: 'In a programme session.',
      toils: function () {
        return [
          escortedGoto('A'),
          Toils.waitWith(function (pawn, job, s) {
            authorise(pawn, 90);
            var id = job.state && job.state.sessionId;
            var session = Reform.session(id);
            if (!session || session.closed) return 'done';
            if (!Reform.markPresent(id, pawn)) return 'done';
            if (s.ticks % 250 === 0) {
              var P = sys('Prison');
              if (P && P.needs) {
                var n = P.needs(pawn);
                if (n) {
                  n.freedom = U.clamp01(n.freedom + 0.02);
                  n.privacy = U.clamp01(n.privacy + 0.004);
                }
              }
              var N = sys('Needs');
              if (N && N.gainJoy) N.gainJoy(pawn, 0.004, 'learning');
            }
            return session.ticks >= session.length ? 'done' : 'stay';
          }, { name: 'attend' })
        ];
      }
    });

    /* ---- reading alone, because nobody was free to teach ---- */
    Jobs.register('reformStudy', {
      label: 'study', reportString: 'Working through the material.',
      toils: function () {
        return [
          escortedGoto('A'),
          Toils.waitWith(function (pawn, job, s) {
            authorise(pawn, 90);
            if (rioting(pawn.map) || lockedDown(pawn)) return 'fail';
            if (s.ticks >= STUDY_TICKS) {
              Reform.creditStudy(pawn, job.state && job.state.programmeId);
              return 'done';
            }
            if (s.ticks % 250 === 0 && typeof pawn.learn === 'function') pawn.learn('intellectual', 8);
            return 'stay';
          }, { name: 'study' })
        ];
      }
    });

    /* ---- somebody watching the workshop ---- */
    Jobs.register('reformSupervise', {
      label: 'supervise labour', reportString: 'Supervising prison labour.',
      toils: function () {
        return [
          atTarget('A'),
          Toils.waitWith(function (pawn, job, s) {
            if (s.ticks >= 2400) return 'done';
            if (s.ticks % 300 === 0) {
              /* Standing there is the work; the eyes are what matter. */
              if (typeof pawn.learn === 'function') pawn.learn('social', 6);
              if (!labourUnderway(pawn.map)) return 'done';
            }
            return 'stay';
          }, { name: 'supervise' })
        ];
      }
    });

    /* ---- the hearing ---- */
    Jobs.register('reformHearing', {
      label: 'parole hearing', reportString: 'Sitting a parole hearing.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.waitWith(function (pawn, job, s) {
            var prisoner = T.resolve(job.targetA, pawn.map);
            if (!prisoner || !isPrisoner(prisoner)) return 'fail';
            authorise(prisoner, 120);
            if (s.ticks < 700) return 'stay';
            Reform.hearing(pawn, prisoner);
            if (typeof pawn.learn === 'function') pawn.learn('social', 120);
            return 'done';
          }, { name: 'hearing' })
        ];
      }
    });

    /* ---- ransom and trade handovers ---- */
    Jobs.register('reformHandover', {
      label: 'process a prisoner', reportString: 'Processing a prisoner for release.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.waitWith(function (pawn, job, s) {
            var prisoner = T.resolve(job.targetA, pawn.map);
            if (!prisoner || !isPrisoner(prisoner)) return 'fail';
            authorise(prisoner, 120);
            if (s.ticks < 500) return 'stay';
            var want = Reform.disposition(prisoner);
            if (want === 'ransom') Reform.ransom(prisoner, pawn);
            else if (want === 'trade') Reform.tradeAway(prisoner, null, pawn);
            else return 'fail';
            if (typeof pawn.learn === 'function') pawn.learn('social', 90);
            return 'done';
          }, { name: 'handover' })
        ];
      }
    });
  }

  function labourUnderway(map) {
    if (Reform.state.policy.labour === 'off') return false;
    var list = prisonersOf(map);
    for (var i = 0; i < list.length; i++) {
      var job = list[i].job;
      if (job && (job.defId === 'prisonWork')) return true;
    }
    return false;
  }

  /* ============================================================
     17. WORK GIVERS

     prisoners.js owns the warden column and prison.js owns the guard
     column. This file owns `instruct` and nothing else.
     ============================================================ */

  function claimed(pawn, defId, target, targetB, opts) {
    if (!Res.reserve(pawn, target, 1)) return null;
    return Jobs.make(defId, target, targetB || null, opts);
  }

  function instructorAllowed(pawn) {
    if (!pawn.workPriority) return false;
    return pawn.workPriority.instruct > 0;
  }

  /* How many prisoners could actually walk into this room right now.
     A class nobody can attend is an hour of a colonist's day thrown
     away, and refusing to start it is the whole of the check. */
  function demandFor(map, programmeId) {
    var list = prisonersOf(map), n = 0;
    var P = sys('Prison');
    var hour = hourNow();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.downed || p.carriedBy) continue;
      var r = p.reform;
      if (!r || r.enrolled.indexOf(programmeId) < 0) continue;
      var ps = p.prisonState;
      if (ps && ps.solitaryLeft > 0) continue;
      if (lockedDown(p)) continue;
      if (p.asleep) continue;
      if (p.needs && (p.needs.rest < 0.28 || p.needs.food < 0.30)) continue;
      /* Already sitting in a class, or in one of their own. */
      if (p.job && (p.job.defId === 'reformAttend' || p.job.defId === 'reformStudy')) continue;
      if (P && P.activityOf) {
        var act = P.activityOf(p);
        if (act !== 'programme' && act !== 'free') continue;
      } else if (hour < 8 || hour > 19) {
        continue;
      }
      n++;
    }
    return n;
  }

  Reform.demandFor = function (map, programmeId) {
    map = map || gameMap();
    return map ? demandFor(map, programmeId) : 0;
  };

  Reform.registerWork = function () {
    if (_registered || !WorkGivers || !WorkGivers.register || !Jobs) return false;
    _registered = true;

    WorkGivers.register({
      id: 'reformRunSession', workType: 'instruct', order: 10, label: 'run a programme session',
      tryGiveJob: function (pawn) {
        if (!instructorAllowed(pawn)) return null;
        var map = pawn.map;
        if (rioting(map)) return null;
        var P = sys('Prison');
        var L = P && P.lockdown ? P.lockdown() : null;
        if (L && L.on) return null;

        var rooms = Reform.rooms(map);
        var best = null, bestScore = 0;
        for (var i = 0; i < rooms.length; i++) {
          var room = rooms[i];
          var def = PROGRAMMES[room.programmeId];
          if (!def) continue;
          if (skillOf(pawn, def.skill) < def.minSkill) continue;
          if (sessionInRoom(room)) continue;
          if ((_emptyUntil[def.id + ':' + room.roomId] || 0) > now()) continue;
          var want = demandFor(map, def.id);
          if (!want) continue;
          var anchor = room.pieces[0];
          if (!anchor || !Res.canReserve(pawn, T.thing(anchor), 1)) continue;
          if (!reachable(map, pawn, anchor.x, anchor.y)) continue;
          /* Prefer the room with the most people waiting for it and the
             instructor's best subject. */
          var score = want * 2 + skillOf(pawn, def.skill) * 0.3 + room.quality;
          if (score > bestScore) { bestScore = score; best = room; }
        }
        if (!best) return null;
        return claimed(pawn, 'reformTeach', T.thing(best.pieces[0]));
      }
    });

    WorkGivers.register({
      id: 'reformHandover', workType: 'instruct', order: 20, label: 'process ransoms and sales',
      tryGiveJob: function (pawn) {
        if (!instructorAllowed(pawn)) return null;
        var map = pawn.map, list = prisonersOf(map);
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          if (p.downed || p.carriedBy) continue;
          var want = Reform.disposition(p);
          if (want !== 'ransom' && want !== 'trade') continue;
          if (want === 'ransom' && !factionOf(p)) continue;
          if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
          if (!reachable(map, pawn, p.x, p.y)) continue;
          return claimed(pawn, 'reformHandover', T.pawn(p));
        }
        return null;
      }
    });

    WorkGivers.register({
      id: 'reformParoleHearing', workType: 'instruct', order: 30, label: 'sit parole hearings',
      tryGiveJob: function (pawn) {
        if (!instructorAllowed(pawn)) return null;
        if (!Reform.state.policy.paroleEnabled) return null;
        var map = pawn.map, list = prisonersOf(map), t = now();
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          if (p.downed || p.carriedBy) continue;
          var r = p.reform;
          if (!r || r.disposition !== 'parole') continue;
          if (t - r.lastHearingTick < DAY) continue;
          if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
          if (!reachable(map, pawn, p.x, p.y)) continue;
          return claimed(pawn, 'reformHearing', T.pawn(p));
        }
        return null;
      }
    });

    WorkGivers.register({
      id: 'reformSuperviseLabour', workType: 'instruct', order: 40, label: 'supervise prison labour',
      tryGiveJob: function (pawn) {
        if (!instructorAllowed(pawn)) return null;
        var pol = Reform.state.policy;
        if (pol.supervision === 'none' || pol.labour === 'off') return null;
        var map = pawn.map;
        if (!labourUnderway(map)) return null;

        /* Stand where the prisoners actually are. prison.js paints the
           workshop; without it, the nearest labour station will do. */
        var P = sys('Prison');
        var spot = null;
        if (P && P.workshopCells) {
          var cells = P.workshopCells(map);
          if (cells && cells.length) {
            var idx = cells[Math.floor(cells.length / 2)];
            spot = { x: map.xOf(idx), y: map.yOf(idx) };
          }
        }
        if (!spot) {
          for (var i = 0; i < LABOUR_IDS.length && !spot; i++) {
            var line = LABOUR[LABOUR_IDS[i]];
            if (!line.station) continue;
            var list = map.byDef(line.station) || [];
            for (var k = 0; k < list.length; k++) {
              if (list[k] && list[k].spawned !== false && !list[k].isBlueprint) {
                spot = { x: list[k].x, y: list[k].y }; break;
              }
            }
          }
        }
        if (!spot) return null;
        if (pol.supervision === 'shared' && supervisionAt(map, spot.x, spot.y) >= 1) return null;
        if (!reachable(map, pawn, spot.x, spot.y)) return null;
        if (!Res.canReserve(pawn, T.cell(spot.x, spot.y), 1)) return null;
        return claimed(pawn, 'reformSupervise', T.cell(spot.x, spot.y));
      }
    });

    return true;
  };

  /* ============================================================
     18. POLICY

     Every knob, validated, so a UI can throw anything at it.
     ============================================================ */

  var POLICY_ENUMS = {
    attendance: ['voluntary', 'compulsory'],
    labour: ['off', 'light', 'standard', 'hard'],
    line: ['auto', 'workshop', 'kitchen', 'laundry', 'clean'],
    toolControl: ['loose', 'counted', 'strict'],
    supervision: ['none', 'shared', 'dedicated']
  };

  var POLICY_RANGES = {
    enrolCap: [0, 6], classSize: [1, 8], minCellGrade: [0, 5],
    labourShareDays: [0, 3], paroleMinProgrammes: [0, 6], paroleMinServedDays: [0, 40],
    ransomMarkup: [0.3, 3], releaseGift: [0, 2000], sentenceDays: [1, 120],
    recordCap: [4, 64]
  };

  Reform.setPolicy = function (key, value) {
    var pol = Reform.state.policy;
    if (!(key in pol)) return false;
    if (POLICY_ENUMS[key]) {
      if (POLICY_ENUMS[key].indexOf(value) < 0) return false;
      pol[key] = value;
      return true;
    }
    if (POLICY_RANGES[key]) {
      var r = POLICY_RANGES[key];
      pol[key] = U.clamp(Number(value) || 0, r[0], r[1]);
      return true;
    }
    pol[key] = !!value;
    return true;
  };

  Reform.policyRows = function () {
    var pol = Reform.state.policy;
    return [
      { key: 'autoEnrol', label: 'Enrol automatically', value: pol.autoEnrol, kind: 'bool',
        note: 'Off means nobody sits a class until you say so.' },
      { key: 'enrolCap', label: 'Programmes at once', value: pol.enrolCap, kind: 'number',
        range: POLICY_RANGES.enrolCap, note: 'More at once finishes none of them faster.' },
      { key: 'attendance', label: 'Attendance', value: pol.attendance, kind: 'enum',
        options: POLICY_ENUMS.attendance, note: 'Compulsory fills the room and lowers every roll in it.' },
      { key: 'classSize', label: 'Class size', value: pol.classSize, kind: 'number',
        range: POLICY_RANGES.classSize, note: 'A bigger class teaches each person less.' },
      { key: 'minCellGrade', label: 'Minimum cell grade to enrol', value: pol.minCellGrade, kind: 'number',
        range: POLICY_RANGES.minCellGrade, note: 'Refuse to teach people you are keeping badly.' },
      { key: 'labour', label: 'Labour', value: pol.labour, kind: 'enum',
        options: POLICY_ENUMS.labour, note: 'Hard pays best, hurts people and feeds the riot.' },
      { key: 'line', label: 'Labour line', value: pol.line, kind: 'enum',
        options: POLICY_ENUMS.line, note: 'The laundry sells for nothing and stops the block stinking.' },
      { key: 'toolControl', label: 'Tool control', value: pol.toolControl, kind: 'enum',
        options: POLICY_ENUMS.toolControl, note: 'Strict costs output; loose arms the block.' },
      { key: 'supervision', label: 'Supervision', value: pol.supervision, kind: 'enum',
        options: POLICY_ENUMS.supervision, note: 'Unsupervised labour is half the output and triple the theft.' },
      { key: 'labourShareDays', label: 'Remission per batch (days)', value: pol.labourShareDays, kind: 'number',
        range: POLICY_RANGES.labourShareDays, note: 'Time off for work done. Generous empties the prison.' },
      { key: 'paroleEnabled', label: 'Parole', value: pol.paroleEnabled, kind: 'bool',
        note: 'The only exit that can come back as a friend.' },
      { key: 'paroleMinProgrammes', label: 'Programmes before parole', value: pol.paroleMinProgrammes,
        kind: 'number', range: POLICY_RANGES.paroleMinProgrammes },
      { key: 'paroleMinServedDays', label: 'Days served before parole', value: pol.paroleMinServedDays,
        kind: 'number', range: POLICY_RANGES.paroleMinServedDays },
      { key: 'ransomEnabled', label: 'Ransom', value: pol.ransomEnabled, kind: 'bool' },
      { key: 'ransomMarkup', label: 'Ransom markup', value: pol.ransomMarkup, kind: 'number',
        range: POLICY_RANGES.ransomMarkup, note: 'Ask more and they pay it, and they remember it.' },
      { key: 'releaseGift', label: 'Silver at the gate', value: pol.releaseGift, kind: 'number',
        range: POLICY_RANGES.releaseGift, note: 'Buying goodwill by the head.' },
      { key: 'sentenceDays', label: 'Default sentence (days)', value: pol.sentenceDays, kind: 'number',
        range: POLICY_RANGES.sentenceDays }
    ];
  };

  /* ============================================================
     19. THE BEAT
     ============================================================ */

  Reform.tickPawn = function (pawn) {
    if (!pawn || pawn.dead) return;
    if (!pawn.prisoner) return;
    var t = now();
    var r = record(pawn);
    /* Staggered, so twenty prisoners never land on the same tick. */
    if (r.lastBeat >= 0 && (t - r.lastBeat) < RARE) return;
    if (r.lastBeat < 0 && (t % RARE) !== (pawn.id % RARE)) return;
    r.lastBeat = t;

    r.servedTicks += RARE;
    refreshCounters(pawn, r);
    recomputeEffects(pawn, r);
    applyEffects(pawn, r);

    var map = pawn.map;
    if (map) autoEnrol(pawn, r, map);

    /* A sentence that has run out is a standing recommendation, not an
       automatic gate: somebody still has to sit the hearing. */
    if (r.disposition === 'hold' && Reform.state.policy.paroleEnabled &&
        Reform.sentenceLeft(pawn) <= 0 && r.counters.programmesDone >= Reform.state.policy.paroleMinProgrammes) {
      Reform.setDisposition(pawn, 'parole');
      note(pawn, 'sentence', 'Sentence served; put up for a hearing.');
    }
  };

  Reform.tick = function (map, game) {
    map = map || (game && game.map) || gameMap();
    if (!map) return;
    var t = now();
    if (_tickSeen === t) return;      /* game.js may also name us */
    _tickSeen = t;

    /* A new colony wipes the module the way prison.js does. */
    var id = map.__reformId || 0;
    if (Reform.state.mapId !== id && id) Reform.state.mapId = id;

    if (t % FACILITY_BEAT === 0) {
      refreshRoster(map);
      _rooms = null;
      _roomsTick = -1;
      closeStaleSessions(map);
    }

    for (var i = 0; i < _roster.length; i++) {
      var p = _roster[i];
      if (p && p.prisoner && !p.dead) Reform.tickPawn(p);
    }

    if (t % SLOW_BEAT === 0) {
      registerIncidents();
      tickReturns(root.Game || game || { map: map, tick: t });
    }
  };

  /* game.js's slow list hands the whole game over; contraband.js and
     prison.js both expose all three shapes so wiring is one name in
     one list. This file does the same. */
  Reform.tickSlow = function (game) {
    Reform.tick(game && game.map, game);
  };

  function closeStaleSessions(map) {
    var list = Reform.state.sessions;
    for (var i = list.length - 1; i >= 0; i--) {
      var s = list[i];
      var instructor = pawnById(map, s.instructorId);
      if (!instructor || instructor.dead || instructor.downed ||
          !instructor.job || instructor.job.defId !== 'reformTeach') {
        s.note = 'the instructor was called away';
        closeSession(s, s.register.length ? 'disrupted' : 'abandoned', instructor || null);
      }
    }
  }

  /* ============================================================
     20. DRIVING

     game.js's systems registry does not name Reform and game.js is
     not this file's to edit. GameMap.prototype.tick runs once a tick
     for the live map and exists at load, so the beat arrives through
     a guarded wrapper on it. The guard stands the wrapper down the
     moment Reform.tick has already run for this game tick, so adding
     ['Reform', 'tick'] (or 'tickSlow', or 'tickPawn') to a list in
     game.js makes the wrapper inert rather than doubling the work.
     ============================================================ */

  function installDriver() {
    var Ctor = root.GameMap;
    if (_driverInstalled || !Ctor || Ctor.prototype.__reformDriven) return false;
    var original = Ctor.prototype.tick;
    Ctor.prototype.tick = function () {
      var out = original.apply(this, arguments);
      var G = root.Game;
      if (Reform.autoDrive && G && G.map === this && G.started) Reform.tick(this, G);
      return out;
    };
    Ctor.prototype.__reformDriven = true;
    _driverInstalled = true;
    return true;
  }

  Reform.autoDrive = true;
  installDriver();
  Reform.registerWork();

  /* ============================================================
     21. THE READOUT

     Everything the UI needs in one object: what is running, how well
     it is going, where everybody went, and who came back.
     ============================================================ */

  Reform.report = function (map) {
    map = map || gameMap();
    var st = Reform.state;
    var stats = st.stats;
    var out = {
      policy: st.policy,
      rooms: [],
      programmes: [],
      sessions: [],
      labour: {
        line: st.policy.line, intensity: st.policy.labour,
        toolControl: st.policy.toolControl, supervision: st.policy.supervision,
        ticks: stats.labour.ticks, hours: Math.round(stats.labour.ticks / HOUR),
        batches: stats.labour.batches, value: Math.round(stats.labour.value),
        toolsLost: stats.labour.toolsLost, injuries: stats.labour.injuries,
        idleBatches: stats.labour.idleBatches,
        unsupervisedHours: Math.round(stats.labour.unsupervised / HOUR),
        byLine: [], workers: 0, stations: {}
      },
      attendance: {
        sessionsRun: stats.sessionsRun, disrupted: stats.sessionsDisrupted,
        abandoned: stats.sessionsAbandoned,
        attendances: stats.attendances, absences: stats.absences,
        rate: stats.attendances + stats.absences
          ? stats.attendances / (stats.attendances + stats.absences) : 0,
        compelled: stats.compelled, studyHours: Math.round(stats.studyHours)
      },
      dispositions: {},
      recidivism: {
        left: stats.recidivism.left, returned: stats.recidivism.returned,
        raider: stats.recidivism.raider, ally: stats.recidivism.ally,
        trader: stats.recidivism.trader, joiner: stats.recidivism.joiner,
        quiet: stats.recidivism.quiet,
        paroleKept: stats.recidivism.paroleKept, paroleBroken: stats.recidivism.paroleBroken,
        pending: 0, rate: 0, history: st.returns.slice(-12)
      },
      silver: { in: stats.silverIn, out: stats.silverOut },
      prisoners: [],
      staffing: { instructors: 0, qualified: {}, demand: 0 },
      ledger: Reform.ledger(16),
      alerts: []
    };

    for (var d in stats.dispositions) out.dispositions[d] = stats.dispositions[d];

    /* programmes and their rooms */
    var rooms = map ? Reform.rooms(map) : [];
    for (var i = 0; i < rooms.length; i++) {
      out.rooms.push({
        programmeId: rooms[i].programmeId,
        label: PROGRAMMES[rooms[i].programmeId].label,
        roomId: rooms[i].roomId, capacity: rooms[i].capacity,
        quality: Math.round(rooms[i].quality * 100) / 100,
        pieces: rooms[i].pieces.length, outdoor: rooms[i].outdoor,
        x: rooms[i].x, y: rooms[i].y
      });
    }

    for (var p = 0; p < PROGRAMME_IDS.length; p++) {
      var id = PROGRAMME_IDS[p];
      var def = PROGRAMMES[id];
      var ps = programmeStat(id);
      var roomsFor = 0, capacity = 0;
      for (var rr = 0; rr < rooms.length; rr++) {
        if (rooms[rr].programmeId !== id) continue;
        roomsFor++; capacity += rooms[rr].capacity;
      }
      var enrolledNow = 0, graduatesNow = 0;
      var live = map ? prisonersOf(map) : [];
      for (var l = 0; l < live.length; l++) {
        var rec = live[l].reform;
        if (!rec) continue;
        if (rec.enrolled.indexOf(id) >= 0) enrolledNow++;
        if (rec.progress[id] && rec.progress[id].completed) graduatesNow++;
      }
      out.programmes.push({
        id: id, label: def.label, short: def.short, equipment: def.equipment,
        skill: def.skill, minSkill: def.minSkill, sessionsNeeded: def.sessions,
        rooms: roomsFor, capacity: capacity,
        enrolled: enrolledNow, graduatesHeld: graduatesNow,
        sessions: ps.sessions, attendances: ps.attendances,
        successes: ps.successes, failures: ps.failures, graduations: ps.graduations,
        disrupted: ps.disrupted,
        successRate: ps.successes + ps.failures ? ps.successes / (ps.successes + ps.failures) : 0,
        demand: map ? demandFor(map, id) : 0
      });
      out.staffing.demand += out.programmes[out.programmes.length - 1].demand;
    }

    for (var s = 0; s < st.sessions.length; s++) {
      var ses = st.sessions[s];
      out.sessions.push({
        id: ses.id, programmeId: ses.programmeId,
        label: PROGRAMMES[ses.programmeId] ? PROGRAMMES[ses.programmeId].label : ses.programmeId,
        instructorId: ses.instructorId, attending: ses.register.length,
        capacity: ses.capacity, progress: U.clamp01(ses.ticks / ses.length),
        x: ses.x, y: ses.y
      });
    }

    for (var lk = 0; lk < LABOUR_IDS.length; lk++) {
      var lineId = LABOUR_IDS[lk];
      var lrow = stats.labour.byLine[lineId] || { batches: 0, value: 0, ticks: 0 };
      var stations = 0;
      if (map && LABOUR[lineId].station) {
        var things = map.byDef(LABOUR[lineId].station) || [];
        for (var th = 0; th < things.length; th++) {
          if (things[th] && things[th].spawned !== false && !things[th].isBlueprint) stations++;
        }
      }
      out.labour.stations[lineId] = stations;
      out.labour.byLine.push({
        id: lineId, label: LABOUR[lineId].label, stations: stations,
        batches: lrow.batches, value: Math.round(lrow.value),
        hours: Math.round(lrow.ticks / HOUR)
      });
    }

    /* staff who could actually teach */
    if (map) {
      var colonists = map.colonists();
      for (var c = 0; c < colonists.length; c++) {
        var col = colonists[c];
        if (col.prisoner || col.slave) continue;
        if (col.workPriority && col.workPriority.instruct > 0) out.staffing.instructors++;
        for (var q = 0; q < PROGRAMME_IDS.length; q++) {
          var qd = PROGRAMMES[PROGRAMME_IDS[q]];
          if (skillOf(col, qd.skill) >= qd.minSkill) {
            out.staffing.qualified[qd.id] = (out.staffing.qualified[qd.id] || 0) + 1;
          }
        }
      }
      var held = prisonersOf(map);
      for (var h = 0; h < held.length; h++) out.prisoners.push(Reform.prisonerCard(held[h]));
      out.labour.workers = held.filter(function (x) {
        return x.job && x.job.defId === 'prisonWork';
      }).length;
    }

    out.recidivism.pending = Reform.pendingReturns().length;
    out.recidivism.rate = stats.recidivism.returned
      ? stats.recidivism.raider / stats.recidivism.returned : 0;
    out.alerts = Reform.alerts(map);
    return out;
  };

  Reform.prisonerCard = function (pawn) {
    var r = record(pawn);
    var st = pawn.prisoner;
    var rows = [];
    for (var i = 0; i < PROGRAMME_IDS.length; i++) {
      var id = PROGRAMME_IDS[i];
      var prog = r.progress[id];
      if (!prog.sessions && !prog.attended && !prog.completed) continue;
      rows.push({
        id: id, label: PROGRAMMES[id].short,
        sessions: prog.sessions, needed: PROGRAMMES[id].sessions,
        completed: prog.completed, quality: Math.round(prog.quality * 100) / 100,
        enrolled: r.enrolled.indexOf(id) >= 0
      });
    }
    return {
      id: pawn.id, name: fullName(pawn),
      faction: r.factionName || '',
      status: r.status, disposition: r.disposition,
      resistance: st ? st.resistance : 0,
      servedDays: Math.round(r.servedTicks / DAY * 10) / 10,
      sentenceDays: Math.round(r.sentenceTicks / DAY * 10) / 10,
      remissionDays: Math.round(r.remissionTicks / DAY * 10) / 10,
      leftDays: Math.round(Reform.sentenceLeft(pawn) / DAY * 10) / 10,
      rehab: Math.round(r.effects.rehab * 100) / 100,
      effects: r.effects,
      programmes: rows,
      enrolled: r.enrolled.slice(),
      labour: {
        line: r.labour.line, hours: Math.round(r.labour.ticks / HOUR),
        batches: r.labour.batches, value: Math.round(r.labour.value),
        toolsLost: r.labour.toolsLost, injuries: r.labour.injuries,
        supervised: r.labour.supervisedTicks + r.labour.unsupervisedTicks
          ? r.labour.supervisedTicks / (r.labour.supervisedTicks + r.labour.unsupervisedTicks) : 0
      },
      counters: r.counters,
      incidents: r.incidents.slice(),
      parole: r.parole,
      paroleChance: Reform.paroleChance(pawn),
      ransomValue: Reform.ransomValue(pawn),
      hearings: r.hearings
    };
  };

  Reform.summary = function (pawn) {
    var r = pawn && pawn.reform;
    if (!r) return '';
    var bits = [];
    if (r.enrolled.length) {
      var names = [];
      for (var i = 0; i < r.enrolled.length; i++) {
        var def = PROGRAMMES[r.enrolled[i]];
        var prog = r.progress[r.enrolled[i]];
        names.push(def.short + ' ' + prog.sessions + '/' + def.sessions);
      }
      bits.push(names.join(', '));
    }
    if (r.counters.programmesDone) bits.push(r.counters.programmesDone + ' completed');
    if (r.labour.batches) bits.push(r.labour.batches + ' batches worked');
    if (r.disposition !== 'hold') bits.push('for ' + r.disposition);
    return bits.join(' - ');
  };

  Reform.alerts = function (map) {
    map = map || gameMap();
    var out = [];
    if (!map) return out;
    var pol = Reform.state.policy;
    var rooms = Reform.rooms(map);
    var held = prisonersOf(map);
    if (!held.length) return out;

    if (!rooms.length) {
      out.push({ label: 'no programme rooms: every prisoner is just doing time', severity: 'low' });
    }

    /* Rooms with nobody who can teach in them. */
    var colonists = map.colonists();
    for (var i = 0; i < rooms.length; i++) {
      var def = PROGRAMMES[rooms[i].programmeId];
      var can = false;
      for (var c = 0; c < colonists.length; c++) {
        var col = colonists[c];
        if (col.prisoner || col.slave) continue;
        if (!col.workPriority || !(col.workPriority.instruct > 0)) continue;
        if (skillOf(col, def.skill) >= def.minSkill) { can = true; break; }
      }
      if (!can) {
        out.push({ label: 'nobody can teach ' + def.label.toLowerCase() +
          ' (needs ' + def.skill + ' ' + def.minSkill + ')', severity: 'medium',
          lookAt: { x: rooms[i].x, y: rooms[i].y } });
      }
    }

    if (pol.labour !== 'off' && pol.supervision === 'none') {
      out.push({ label: 'prison labour is running unsupervised', severity: 'high' });
    }
    if (pol.labour === 'hard') {
      out.push({ label: 'the block is on hard labour', severity: 'medium' });
    }
    if (pol.toolControl === 'loose' && Reform.state.stats.labour.toolsLost > 1) {
      out.push({ label: Reform.state.stats.labour.toolsLost + ' tools have walked off the line',
        severity: 'high' });
    }
    if (Reform.state.stats.labour.idleBatches > 3) {
      out.push({ label: 'the labour line keeps running out of materials', severity: 'low' });
    }
    if (Reform.state.stats.sessionsDisrupted > Reform.state.stats.sessionsRun &&
        Reform.state.stats.sessionsDisrupted > 2) {
      out.push({ label: 'more programme sessions are being broken up than finished', severity: 'medium' });
    }
    var pending = Reform.pendingReturns().length;
    if (pending >= 4) {
      out.push({ label: pending + ' former prisoners are still out there', severity: 'low' });
    }
    return out;
  };

  /* ============================================================
     22. SAVE

     The per-prisoner record is on the pawn, so save.js already has
     it. What is left is the module: policy, the ledger, the release
     book and the counters. Live sessions are deliberately not saved -
     a session is an hour of a colonist's day and the job it belongs
     to does not survive a save either.
     ============================================================ */

  Reform.save = function () {
    var st = Reform.state;
    return {
      version: Reform_VERSION,
      nextId: st.nextId,
      policy: st.policy,
      stats: st.stats,
      ledger: st.ledger.slice(-80),
      releases: st.releases.slice(),
      returns: st.returns.slice()
    };
  };

  Reform.load = function (obj) {
    if (!obj) return false;
    var fresh = freshState();
    if (obj.policy) {
      for (var k in fresh.policy) {
        if (obj.policy[k] !== undefined) fresh.policy[k] = obj.policy[k];
      }
    }
    if (obj.stats) {
      for (var s in fresh.stats) {
        if (obj.stats[s] === undefined) continue;
        if (typeof fresh.stats[s] === 'object' && fresh.stats[s]) {
          for (var q in fresh.stats[s]) {
            if (obj.stats[s][q] !== undefined) fresh.stats[s][q] = obj.stats[s][q];
          }
        } else {
          fresh.stats[s] = obj.stats[s];
        }
      }
    }
    fresh.nextId = obj.nextId || 1;
    fresh.ledger = obj.ledger || [];
    fresh.releases = obj.releases || [];
    fresh.returns = obj.returns || [];
    Reform.state = fresh;
    Reform.policy = fresh.policy;
    _roster.length = 0;
    _known = {};
    _rooms = null;
    _roomsTick = -1;
    _tickSeen = -1;
    return true;
  };

  /* A self-check the integrator can call: it proves the six programmes,
     the four labour lines and the policy table agree with each other,
     which is the one thing a data typo here would break silently. */
  Reform.selfCheck = function () {
    var problems = [], i;
    for (i = 0; i < PROGRAMME_IDS.length; i++) {
      var def = PROGRAMMES[PROGRAMME_IDS[i]];
      if (!Defs.has('thing', def.equipment)) problems.push(def.id + ' needs missing thing/' + def.equipment);
      if (!Defs.has('skill', def.skill)) problems.push(def.id + ' taught with missing skill/' + def.skill);
      if (!Defs.has('skill', def.teaches)) problems.push(def.id + ' teaches missing skill/' + def.teaches);
      if (!(def.sessions > 0)) problems.push(def.id + ' needs no sessions');
      if (typeof def.eligible !== 'function') problems.push(def.id + ' has no eligibility test');
      if (!Reform.state.stats.byProgramme[def.id]) problems.push(def.id + ' has no stats row');
    }
    for (i = 0; i < LABOUR_IDS.length; i++) {
      var line = LABOUR[LABOUR_IDS[i]];
      if (line.station && !Defs.has('thing', line.station)) {
        problems.push(line.id + ' needs missing thing/' + line.station);
      }
      if (line.input && line.input.defId && !Defs.has('thing', line.input.defId)) {
        problems.push(line.id + ' consumes missing thing/' + line.input.defId);
      }
      if (line.output && !Defs.has('thing', line.output.defId)) {
        problems.push(line.id + ' produces missing thing/' + line.output.defId);
      }
      for (var t = 0; t < line.tools.length; t++) {
        var C = sys('Contraband');
        if (C && C.itemDef && !C.itemDef(line.tools[t])) {
          problems.push(line.id + ' names unknown contraband ' + line.tools[t]);
        }
      }
    }
    var EXITS = ['recruited', 'enslaved', 'released', 'ransomed', 'traded',
                 'paroled', 'executed', 'died', 'escaped'];
    for (var d = 0; d < EXITS.length; d++) {
      if (Reform.state.stats.dispositions[EXITS[d]] === undefined) {
        problems.push('no exit counter for ' + EXITS[d]);
      }
    }
    for (var o = 0; o < OUTCOMES.length; o++) {
      if (Reform.state.stats.recidivism[OUTCOMES[o]] === undefined) {
        problems.push('no recidivism counter for ' + OUTCOMES[o]);
      }
    }
    var pol = Reform.state.policy;
    for (var key in POLICY_ENUMS) {
      if (POLICY_ENUMS[key].indexOf(pol[key]) < 0) problems.push('policy ' + key + ' is ' + pol[key]);
    }
    return problems;
  };

  root.Reform = Reform;
})(this);
