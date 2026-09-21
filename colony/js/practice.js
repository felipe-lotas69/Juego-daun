/* ============================================================
   practice.js - training facilities, the practice job, drills.

   A colony can build a wall to learn construction and cook a meal to
   learn cooking, but the only way the base game teaches shooting is to
   be shot at. That makes the one skill a colony most needs the one it
   cannot safely build, and this file is the answer: a shooting range, a
   melee dummy, a sparring ring, a study desk, a surgical mannequin, an
   easel, a cooking station, an instrument and a shoot house.

   Three rules shape the numbers, and they are the whole design:

   1. Practice is always worse than production. The xp rate is the same
      shape as a real job's - it scales with skill and health exactly the
      way jobs.js's work toil does - but it is multiplied down. Nobody
      should ever train cooking at a practice station when there is a
      meal that wants cooking.
   2. Practice makes recruits competent and cannot make masters. The
      practice curve is flat to level six, halves by ten and is almost
      nothing past fifteen, on top of the above-ten grind pawn.js already
      applies. A level 18 shooter is a thing you earn in a firefight.
   3. It is safe but not free. A sparring bout leaves bruises, a careless
      colonist on the firing line gets a graze, and a colony-wide drill
      costs most of a working day. That is what makes calling one the
      night before a raid an actual decision.

   Skill decay is pawn.js's: above level ten, for skills untouched for a
   day. Nothing here duplicates it. Practice complements it simply by
   being a way to touch a skill, because Pawn.learn stamps lastGainTick
   and the decay clock restarts. Practice.decayWatch reports what is
   currently slipping so the player knows what to train.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Above this file in the load order, so binding them here is safe. */
  var Jobs = root.Jobs;
  var Toils = root.Toils;
  var T = root.T;
  var Res = root.Res;
  var Path = root.Path;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  /* Below it, or optional entirely: looked up at call time so a partial
     harness - or a colony running without tactics.js - simply does less. */
  function sys(name) {
    var v = root[name];
    return v === undefined ? null : v;
  }

  function gameTick() {
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

  var Practice = {};

  /* ------------------------------------------------------------------
     Tuning
     ------------------------------------------------------------------ */

  var TICKS_PER_DAY = 60000;
  var TICKS_PER_HOUR = 2500;

  /* jobs.js grants rate * 0.11 xp per work tick. Every facility rate
     below is quoted in those units and every one of them is under it. */
  var REAL_JOB_XP = 0.11;

  var SESSION_TICKS = 2400;          /* about an hour at the bench     */
  var DRILL_SESSION_TICKS = 3000;
  var SESSION_COOLDOWN = 1800;       /* breathing room between stints  */
  var ASSIGNED_DAILY_BUDGET = 6000;  /* how much working time an assignment may eat */
  var IDLE_MEMORY = 2500;            /* how long "had nothing to do" stays true */
  var JOY_WANT = 0.30;

  /* Fit to train: a hungry, exhausted or bleeding colonist goes and
     deals with that instead. */
  var MIN_FOOD = 0.32, MIN_REST = 0.34, MIN_MOOD = 0.22;

  /* Diminishing returns, on top of the above-ten grind in pawn.js. */
  var PRACTICE_CURVE = [[0, 1], [6, 1], [10, 0.60], [12, 0.30], [15, 0.10], [18, 0.03], [20, 0.02]];
  var SOFT_CAP = 15;                 /* past here a facility is barely worth walking to */

  var ACCIDENT_BEAT = 240;           /* accidents are rolled on this beat, not per tick */
  var PARTNER_CHECK_BEAT = 60;

  /* What a pair at one facility is worth over training alone. */
  var PAIR_XP_BONUS = 1.35;
  var PAIR_OPINION_EVERY = 1200;

  /* ------------------------------------------------------------------
     Content

     def_things.js is another file's, so every facility is registered
     from here. The building block is spelled out in full because
     map.js, power.js and ui.js read fields off it without guarding.
     ------------------------------------------------------------------ */

  var S11 = Object.freeze({ w: 1, h: 1 });
  var S21 = Object.freeze({ w: 2, h: 1 });
  var S31 = Object.freeze({ w: 3, h: 1 });
  var S22 = Object.freeze({ w: 2, h: 2 });
  var S33 = Object.freeze({ w: 3, h: 3 });

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

  /* The same defaults def_things.js gives a building, restated so a
     facility answers every question the engine asks of a thing. */
  var FACILITY_DEFAULTS = {
    category: 'building', description: '',
    sprite: 'box', color: '#8a6134', color2: '#6b4a27',
    stackLimit: 1, mass: 30, marketValue: 0,
    nutrition: 0, foodType: null, rotDays: null,
    isMedicine: false, medicinePotency: 0,
    size: S11, rotatable: false, hp: 120, flammable: true,
    passable: false, pathCost: 0, fillPercent: 0.5,
    blocksLight: false, holdsRoof: false,
    beauty: 0, comfort: 0, natural: false,
    stuffable: false, buildSkill: 'construction',
    researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null,
    weapon: null, apparel: null
  };

  Defs.add('thing', {

    archeryButt: {
      label: 'archery butt',
      description: 'A straw bale with a target painted on it. Costs almost nothing, teaches a tribal to aim, ' +
        'and is the first thing a colony with bows and no gunmen should put down.',
      sprite: 'sandbags', color: '#c2b280', color2: '#b0453f',
      hp: 90, mass: 15, flammable: true,
      passable: false, fillPercent: 0.45,
      buildCost: { wood: 25 }, workToBuild: 350,
      buildCategory: 'security',
      building: bld({})
    },

    shootingRange: {
      label: 'shooting range',
      description: 'A firing line, a backstop and a row of paper targets. A colonist burns powder here instead of ' +
        'learning to shoot the hard way, which is by being shot at.',
      sprite: 'sandbags', color: '#8f97a3', color2: '#c0392b',
      size: S31, rotatable: true, hp: 200, mass: 90, flammable: false,
      passable: false, fillPercent: 0.55,
      buildCost: { steel: 45, wood: 30 }, workToBuild: 1600,
      buildCategory: 'security', researchPrerequisite: 'firearms',
      building: bld({})
    },

    shootHouse: {
      label: 'shoot house',
      description: 'A walled lane of blinds and pop-up targets. It teaches nothing about the trigger and everything ' +
        'about the second before it: where the cover is, when to move, when to stay down.',
      sprite: 'sandbags', color: '#6e6e78', color2: '#ffc23c',
      size: S33, hp: 320, mass: 160, flammable: false,
      passable: true, pathCost: 22, fillPercent: 0.35,
      buildCost: { steel: 55, wood: 60 }, workToBuild: 2600,
      buildCategory: 'security', researchPrerequisite: 'advancedFirearms',
      building: bld({})
    },

    meleeDummy: {
      label: 'training dummy',
      description: 'A post, a crossbeam and a sack of sand. It does not hit back, which is its whole virtue and ' +
        'its whole limitation.',
      sprite: 'sculpture', color: '#8a6134', color2: '#c2b280',
      hp: 140, mass: 35, flammable: true,
      passable: false, fillPercent: 0.5,
      buildCost: { wood: 40 }, workToBuild: 700,
      buildCategory: 'security',
      building: bld({})
    },

    sparringRing: {
      label: 'sparring ring',
      description: 'Roped posts around a patch of packed earth. Two colonists learn faster from each other than ' +
        'either learns from a sack, and they come out of it liking each other better - bruises and all.',
      sprite: 'spot', color: '#7b6a4f', color2: '#8a6134',
      size: S33, hp: 120, mass: 25, flammable: true,
      passable: true, pathCost: 8, fillPercent: 0,
      buildCost: { wood: 30, steel: 10 }, workToBuild: 900,
      buildCategory: 'security',
      building: bld({})
    },

    studyDesk: {
      label: 'study desk',
      description: 'A desk, a lamp bracket and a shelf of salvaged manuals. Reading is slower than doing, but a ' +
        'colonist at a desk is also chipping away at whatever the colony is researching.',
      sprite: 'research', color: '#8a6134', color2: '#6fa8dc',
      size: S21, rotatable: true, hp: 160, mass: 60, flammable: true,
      passable: false, fillPercent: 0.5,
      beauty: 1,
      buildCost: { wood: 50, steel: 10 }, workToBuild: 1100,
      buildCategory: 'furniture',
      building: bld({})
    },

    surgicalMannequin: {
      label: 'surgical mannequin',
      description: 'A stitched dummy with a canvas abdomen and replaceable organs. The colony doctor gets to be ' +
        'bad at this somewhere other than on a colonist.',
      sprite: 'medkit', color: '#d8cfc0', color2: '#b0453f',
      hp: 110, mass: 30, flammable: true,
      passable: false, fillPercent: 0.45,
      buildCost: { cloth: 30, wood: 15 }, workToBuild: 900,
      buildCategory: 'furniture', researchPrerequisite: 'medicineProduction',
      building: bld({})
    },

    artEasel: {
      label: 'art easel',
      description: 'A frame, a palette and a stack of boards. Nothing that comes off it is worth selling for a ' +
        'long while, which is exactly what practice means.',
      sprite: 'sculpture', color: '#c9b48a', color2: '#6fa8dc',
      hp: 80, mass: 15, flammable: true,
      passable: false, fillPercent: 0.35,
      beauty: 2,
      buildCost: { wood: 25, cloth: 10 }, workToBuild: 600,
      buildCategory: 'furniture',
      building: bld({})
    },

    cookingPracticeStation: {
      label: 'cooking practice station',
      description: 'A cold bench with knives, boards and yesterday’s scraps. Knife work, portioning and timing, ' +
        'without putting a meal on the line.',
      sprite: 'butcher', color: '#8a6134', color2: '#d8cfc0',
      size: S21, rotatable: true, hp: 160, mass: 55, flammable: true,
      passable: false, fillPercent: 0.5,
      buildCost: { wood: 35, steel: 5 }, workToBuild: 800,
      buildCategory: 'furniture',
      building: bld({})
    },

    musicalInstrument: {
      label: 'musical instrument',
      description: 'A battered stringed thing on a stand. Playing it is artistic practice and recreation in the ' +
        'same hour, which makes it the cheapest morale building a colony can put up.',
      sprite: 'stool', color: '#8a6134', color2: '#ffc23c',
      size: S22, hp: 90, mass: 20, flammable: true,
      passable: false, fillPercent: 0.4,
      beauty: 4,
      buildCost: { wood: 30, cloth: 5 }, workToBuild: 900,
      buildCategory: 'furniture',
      building: bld({})
    }

  }, FACILITY_DEFAULTS);

  /* ------------------------------------------------------------------
     What each facility teaches, and how badly

     xpRate is in the same units as jobs.js's XP_PER_WORK (0.11). Every
     number here is under it, on purpose and permanently.
     ------------------------------------------------------------------ */

  var FACILITIES = {
    archeryButt: {
      skill: 'shooting', xpRate: 0.050, slots: 1, verb: 'shooting at the butt',
      accident: 'range', accidentBase: 0.0025, tactics: 0.4
    },
    shootingRange: {
      skill: 'shooting', xpRate: 0.075, slots: 2, verb: 'on the firing line',
      accident: 'range', accidentBase: 0.0040, tactics: 0.6
    },
    shootHouse: {
      skill: 'shooting', xpRate: 0.055, slots: 3, verb: 'running the shoot house',
      accident: 'range', accidentBase: 0.0035, tactics: 2.4, pairs: true
    },
    meleeDummy: {
      skill: 'melee', xpRate: 0.065, slots: 1, verb: 'working the dummy',
      accident: 'melee', accidentBase: 0.0030, tactics: 0.5
    },
    sparringRing: {
      skill: 'melee', xpRate: 0.085, slots: 2, verb: 'sparring',
      accident: 'melee', accidentBase: 0.0060, tactics: 1.6, pairs: true, opinion: true
    },
    studyDesk: {
      skill: 'intellectual', xpRate: 0.070, slots: 1, verb: 'studying',
      accident: null, accidentBase: 0, research: 0.10
    },
    surgicalMannequin: {
      skill: 'medicine', xpRate: 0.065, slots: 1, verb: 'practising surgery',
      accident: null, accidentBase: 0
    },
    artEasel: {
      skill: 'artistic', xpRate: 0.070, slots: 1, verb: 'sketching',
      accident: null, accidentBase: 0, joy: 0.06
    },
    cookingPracticeStation: {
      skill: 'cooking', xpRate: 0.065, slots: 1, verb: 'practising knife work',
      accident: null, accidentBase: 0
    },
    musicalInstrument: {
      skill: 'artistic', xpRate: 0.060, slots: 1, verb: 'playing',
      accident: null, accidentBase: 0, joy: 0.22, joyKind: 'music', pairs: true
    }
  };

  var FACILITY_IDS = Object.keys(FACILITIES);

  /* Which work type owns a skill, so a colonist who has that column
     switched off is not dragged to a bench for it. Built once from the
     workType defs, which name their own skills. */
  var _skillWork = null;
  function workTypeForSkill(skillId) {
    if (!_skillWork) {
      _skillWork = Object.create(null);
      var types = Defs.all('workType');
      for (var i = 0; i < types.length; i++) {
        var list = types[i].skills || [];
        for (var k = 0; k < list.length; k++) {
          if (_skillWork[list[k]] === undefined) _skillWork[list[k]] = types[i].id;
        }
      }
    }
    return _skillWork[skillId] || null;
  }

  Practice.FACILITIES = FACILITIES;
  Practice.facilityIds = function () { return FACILITY_IDS.slice(); };
  Practice.facilityInfo = function (defId) { return FACILITIES[defId] || null; };
  Practice.trains = function (defId) {
    var f = FACILITIES[defId];
    return f ? f.skill : null;
  };
  Practice.facilitiesForSkill = function (skillId) {
    var out = [];
    for (var i = 0; i < FACILITY_IDS.length; i++) {
      if (FACILITIES[FACILITY_IDS[i]].skill === skillId) out.push(FACILITY_IDS[i]);
    }
    return out;
  };

  /* ------------------------------------------------------------------
     Per-pawn state

     A plain object on the pawn, so save.js carries it with everything
     else it copies off a colonist. Nothing in it is a reference.
     ------------------------------------------------------------------ */

  function stateOf(pawn) {
    var st = pawn.practice;
    if (!st || typeof st !== 'object') {
      st = pawn.practice = {
        assigned: null,      /* skill id the player pinned, or null      */
        log: {},             /* skillId -> {ticks, xp, levels, sessions} */
        sessions: 0,
        totalTicks: 0,
        accidents: 0,
        sparTicks: 0,
        lastSkill: null,
        lastFacility: null,
        lastEndTick: -99999,
        idleTick: -99999,
        budgetDay: -1,
        budgetTicks: 0
      };
    }
    if (!st.log) st.log = {};
    return st;
  }
  Practice.stateOf = stateOf;

  function logEntry(st, skillId) {
    var e = st.log[skillId];
    if (!e) e = st.log[skillId] = { ticks: 0, xp: 0, levels: 0, sessions: 0 };
    return e;
  }

  Practice.assign = function (pawn, skillId) {
    if (!pawn) return false;
    if (skillId && !Defs.has('skill', skillId)) return false;
    var st = stateOf(pawn);
    st.assigned = skillId || null;
    return true;
  };

  Practice.clear = function (pawn) {
    if (!pawn) return false;
    stateOf(pawn).assigned = null;
    return true;
  };

  Practice.assignedSkill = function (pawn) {
    return pawn ? stateOf(pawn).assigned : null;
  };

  /* ------------------------------------------------------------------
     Skills
     ------------------------------------------------------------------ */

  function skillEntry(pawn, skillId) {
    return (pawn.skills && pawn.skills[skillId]) || null;
  }

  function levelOf(pawn, skillId) {
    var s = skillEntry(pawn, skillId);
    return s ? (s.level || 0) : 0;
  }

  /* pawn.js owns levelling: the passion multiplier, the above-ten grind
     and the level-up loop all live there, and every system in the game
     is supposed to go through it. */
  function learn(pawn, skillId, xp) {
    if (!(xp > 0)) return 0;
    if (typeof pawn.learn === 'function') return pawn.learn(skillId, xp) || 0;
    var P = sys('Pawn');
    if (P && typeof P.learn === 'function') return P.learn(pawn, skillId, xp) || 0;
    var s = skillEntry(pawn, skillId);
    if (!s) return 0;
    s.xp = (s.xp || 0) + xp;
    s.lastGainTick = gameTick();
    while (s.level < 20 && s.xp >= 1000 * (s.level + 1)) {
      s.xp -= 1000 * (s.level + 1);
      s.level++;
    }
    return xp;
  }

  function healthFactor(pawn) {
    var H = sys('Health');
    if (H && H.workSpeedFactor) {
      var f = H.workSpeedFactor(pawn);
      return f > 0 ? f : 0.1;
    }
    return 1;
  }

  /* The rate a facility teaches at: the same shape a real job's work
     toil has - 0.4 + 0.08 per level, scaled by health - times the
     facility's xp rate, times the practice curve. */
  function xpPerTick(pawn, skillId, info, paired) {
    var level = levelOf(pawn, skillId);
    var base = (0.4 + 0.08 * level) * healthFactor(pawn);
    var v = base * info.xpRate * U.curve(PRACTICE_CURVE, level);
    if (paired && info.pairs) v *= PAIR_XP_BONUS;
    return v;
  }
  Practice.xpPerTick = xpPerTick;

  /* How much better than the real job this would be, for the UI and for
     anyone who wants to check rule one is still true. */
  Practice.efficiency = function (defId) {
    var info = FACILITIES[defId];
    return info ? info.xpRate / REAL_JOB_XP : 0;
  };

  /* ------------------------------------------------------------------
     Facility selection
     ------------------------------------------------------------------ */

  function isUsableFacility(map, thing) {
    if (!thing || !thing.spawned || thing.isBlueprint || thing.isFrame) return false;
    if (!thing.def || !FACILITIES[thing.defId]) return false;
    if (thing.faction && thing.faction !== 'player') return false;
    var b = thing.def.building;
    if (b && b.powerConsumed > 0 && thing.powered === false) return false;
    return true;
  }

  /* Colonists already training at this thing, by walking the pawn list
     rather than the reservation table: a colony has tens of pawns and
     the answer has to include somebody who took the job this same tick. */
  function occupantsOf(map, thing) {
    var out = [], list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.dead || !p.job || p.job.defId !== 'practice') continue;
      var a = p.job.targetA;
      if (a && a.k === 't' && a.id === thing.id) out.push(p);
    }
    return out;
  }
  Practice.occupantsOf = occupantsOf;

  var PASSION_WEIGHT = [0.75, 1.7, 2.6];

  /* How much this colonist wants this skill raised. Level matters most:
     the point of a range is to turn a level 2 shooter into a level 8
     one, and nothing above the soft cap is worth an evening. */
  function skillAppetite(pawn, skillId) {
    var s = skillEntry(pawn, skillId);
    if (!s) return 0;
    var level = s.level || 0;
    if (level >= 20) return 0;
    var want = Math.max(0.5, SOFT_CAP + 2 - level);
    want *= PASSION_WEIGHT[s.passion | 0] || 1;
    if (level >= SOFT_CAP) want *= 0.12;

    /* A column the player switched off says this colonist is not meant
       to do that work; a passion in it still counts for something. */
    var wt = workTypeForSkill(skillId);
    if (wt && pawn.workPriority && !pawn.workPriority[wt]) want *= 0.25;

    /* Shooting and melee get a thumb on the scale because they are the
       two skills with no safe real job behind them. */
    if (skillId === 'shooting' || skillId === 'melee') want *= 1.3;
    return want;
  }
  Practice.skillAppetite = skillAppetite;

  function reachableFor(pawn, thing) {
    var W = sys('WorkGivers');
    if (W && W.inReach) return W.inReach(pawn.map, pawn, thing.x, thing.y);
    var R = sys('Regions');
    if (R && R.sameArea) return R.sameArea(pawn.map, pawn.x, pawn.y, thing.x, thing.y);
    return true;
  }

  /* Every facility this colonist could sensibly walk to right now, with
     the score that says which one is worth the walk. */
  function candidates(pawn, wantSkill) {
    var map = pawn.map, out = [];
    for (var i = 0; i < FACILITY_IDS.length; i++) {
      var defId = FACILITY_IDS[i];
      var info = FACILITIES[defId];
      if (wantSkill && info.skill !== wantSkill) continue;
      var appetite = skillAppetite(pawn, info.skill);
      if (appetite <= 0) continue;
      var list = map.byDef(defId);
      for (var k = 0; k < list.length; k++) {
        var thing = list[k];
        if (!isUsableFacility(map, thing)) continue;
        var here = occupantsOf(map, thing);
        if (here.length >= info.slots) continue;
        if (!Res.canReserve(pawn, T.thing(thing), info.slots)) continue;
        if (!reachableFor(pawn, thing)) continue;
        var score = appetite * (info.xpRate / REAL_JOB_XP) * 12;
        /* A ring with one person in it is worth crossing the base for:
           two colonists learn faster and end up friends. */
        if (here.length && info.pairs) score *= 1.8;
        out.push({ thing: thing, defId: defId, info: info, score: score, paired: here.length > 0 });
      }
    }
    return out;
  }

  function choose(pawn, wantSkill) {
    var cands = candidates(pawn, wantSkill);
    if (!cands.length) return null;
    if (Path && Path.closestReachable) {
      return Path.closestReachable(pawn.map, pawn, cands, function (c, d) {
        return c.score * 2.5 - d;
      });
    }
    return U.maxBy(cands, function (c) { return c.score; });
  }
  Practice.chooseFacility = choose;

  /* ------------------------------------------------------------------
     When a colonist may train
     ------------------------------------------------------------------ */

  function hourNow() {
    var G = sys('Game');
    if (G && typeof G.hour === 'function') return G.hour();
    return (gameTick() % TICKS_PER_DAY) / TICKS_PER_HOUR;
  }

  /* ui.js paints pawn.schedule; the default day is work until eight in
     the evening, recreation until ten, then sleep. */
  function scheduleKind(pawn) {
    var sched = pawn.schedule;
    var h = Math.floor(hourNow()) % 24;
    if (sched && sched.length === 24 && sched[h]) return sched[h];
    if (h >= 22 || h < 6) return 'sleep';
    if (h >= 20) return 'recreation';
    return 'work';
  }

  function needOf(pawn, id) {
    var n = pawn.needs;
    return (n && typeof n[id] === 'number') ? n[id] : 1;
  }

  function fitToTrain(pawn) {
    if (!pawn || pawn.dead || pawn.downed || !pawn.map) return false;
    if (!pawn.isHuman || pawn.faction !== 'player') return false;
    if (pawn.drafted || pawn.mentalState) return false;
    if (needOf(pawn, 'food') < MIN_FOOD) return false;
    if (needOf(pawn, 'rest') < MIN_REST) return false;
    if (typeof pawn.mood === 'number' && pawn.mood < MIN_MOOD) return false;
    var H = sys('Health');
    if (H) {
      if (H.needsTending && H.needsTending(pawn)) return false;
      if (H.bleedRate && H.bleedRate(pawn) > 0.05) return false;
      if (H.capacity && H.capacity(pawn, 'moving') < 0.5) return false;
      if (H.capacity && H.capacity(pawn, 'consciousness') < 0.55) return false;
    }
    return true;
  }
  Practice.fitToTrain = fitToTrain;

  function budgetLeft(pawn) {
    var st = stateOf(pawn);
    var G = sys('Game');
    var day = G && G.day ? G.day() : Math.floor(gameTick() / TICKS_PER_DAY);
    if (st.budgetDay !== day) { st.budgetDay = day; st.budgetTicks = 0; }
    return ASSIGNED_DAILY_BUDGET - st.budgetTicks;
  }

  /* Why this colonist would go and train, or null for "not now". The
     order is the priority: a drill outranks everything short of an
     emergency, and a pinned assignment is the only thing that may eat
     into a working hour. */
  function practiceMoment(pawn) {
    if (!fitToTrain(pawn)) return null;
    var st = stateOf(pawn);
    var now = gameTick();

    if (drillCovers(pawn)) return 'drill';
    if (now - st.lastEndTick < SESSION_COOLDOWN) return null;

    var kind = scheduleKind(pawn);
    if (kind === 'sleep') return null;
    if (kind === 'recreation') return 'recreation';

    var idle = (now - st.idleTick) < IDLE_MEMORY;
    if (kind === 'anything') {
      if (needOf(pawn, 'joy') < JOY_WANT) return 'recreation';
      if (idle) return 'idle';
      return (st.assigned && budgetLeft(pawn) > 0) ? 'assigned' : null;
    }

    /* A working hour. Nothing but "there is genuinely nothing else to
       do" or the player's own standing order buys one of these. */
    if (idle) return 'idle';
    if (st.assigned && budgetLeft(pawn) > 0) return 'assigned';
    return null;
  }
  Practice.practiceMoment = practiceMoment;

  /* ------------------------------------------------------------------
     Tactics, when tactics.js is loaded

     It is not written yet at the time this file was, so the call is a
     probe rather than a hard dependency. What is expected: a function
     taking (pawn, amount, kindString) that banks combat-sense
     experience - cover discipline, target priority, when to fall back.
     If tactics.js names it something else from this list it is found;
     if it names it something new, add a line here.
     ------------------------------------------------------------------ */

  var TACTICS_FNS = ['gainExperience', 'gainXp', 'learn', 'addExperience', 'train', 'noteTraining'];
  var _tacticsFn = undefined;

  function grantCombatSense(pawn, amount, kind) {
    if (!(amount > 0)) return false;
    var Tac = sys('Tactics');
    if (!Tac) return false;
    if (_tacticsFn === undefined || !Tac[_tacticsFn]) {
      _tacticsFn = null;
      for (var i = 0; i < TACTICS_FNS.length; i++) {
        if (typeof Tac[TACTICS_FNS[i]] === 'function') { _tacticsFn = TACTICS_FNS[i]; break; }
      }
    }
    if (!_tacticsFn) return false;
    try {
      Tac[_tacticsFn](pawn, amount, kind || 'drill');
      return true;
    } catch (e) {
      _tacticsFn = null;
      return false;
    }
  }
  Practice.grantCombatSense = grantCombatSense;

  /* ------------------------------------------------------------------
     Accidents

     Small, rare, and the reason a shooting range reads as a real place
     rather than an xp faucet. A careful shooter almost never has one; a
     trigger-happy recruit has them often enough to notice.
     ------------------------------------------------------------------ */

  function hasTrait(pawn, id) {
    var list = pawn.traits;
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t === id || (t && t.id === id)) return true;
    }
    return false;
  }

  function nameOf(pawn) {
    if (pawn && pawn.name) return pawn.name.nick || pawn.name.first || 'someone';
    return 'someone';
  }

  function accidentChance(pawn, info, paired) {
    var base = info.accidentBase || 0;
    if (!base) return 0;
    var level = levelOf(pawn, info.skill);
    /* Competence cuts it roughly in half by level ten. */
    base *= U.clamp(1.25 - 0.05 * level, 0.35, 1.25);
    if (info.accident === 'range') {
      if (hasTrait(pawn, 'triggerHappy')) base *= 3;
      if (hasTrait(pawn, 'carefulShooter')) base *= 0.25;
    } else {
      if (hasTrait(pawn, 'brawler')) base *= 1.4;
      if (hasTrait(pawn, 'nimble')) base *= 0.6;
      if (hasTrait(pawn, 'wimp')) base *= 1.3;
    }
    if (paired) base *= 1.5;
    return base;
  }

  var BRUISE_PARTS = ['armLeft', 'armRight', 'legLeft', 'legRight', 'torso', 'handLeft', 'handRight'];
  var GRAZE_PARTS = ['armLeft', 'armRight', 'handLeft', 'handRight', 'legLeft', 'legRight'];

  function partIdNamed(pawn, defName) {
    var parts = pawn.health && pawn.health.parts;
    if (!parts) return null;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].defName === defName && !parts[i].missing) return parts[i].id;
    }
    return null;
  }

  function trainingAccident(pawn, info, partner) {
    var H = sys('Health');
    if (!H || !H.damage) return false;
    var melee = info.accident === 'melee';
    var names = melee ? BRUISE_PARTS : GRAZE_PARTS;
    var partId = partIdNamed(pawn, U.pick(names));
    var amount = melee ? U.randInt(3, 9) : U.randInt(4, 11);
    H.damage(pawn, {
      amount: amount,
      type: melee ? 'blunt' : 'bullet',
      partId: partId,
      source: null,
      armorPen: 0,
      instigator: melee ? (partner || null) : null
    });
    stateOf(pawn).accidents++;
    var where = melee
      ? (partner ? ' sparring with ' + nameOf(partner) : ' on the training dummy')
      : ' on the firing line';
    msg(U.cap(nameOf(pawn)) + ' was hurt' + where + '.',
      { type: 'threat', x: pawn.x, y: pawn.y });
    return true;
  }

  /* ------------------------------------------------------------------
     Sparring: what a partner is worth beyond the xp
     ------------------------------------------------------------------ */

  function buildOpinion(a, b) {
    if (!a || !b || a === b) return false;
    var S = sys('Social');
    if (S) {
      var fn = S.adjustOpinion || S.addOpinion || S.changeOpinion;
      if (typeof fn === 'function') {
        try { fn.call(S, a, b, 4, 'sparred together'); return true; } catch (e) { /* fall through */ }
      }
    }
    var N = sys('Needs');
    if (N && N.addThought) {
      N.addThought(a, 'chatted', { otherPawnId: b.id });
      return true;
    }
    return false;
  }

  Practice.startSpar = function (a, b) {
    if (!a || !b || a === b || !a.map || a.map !== b.map) return false;
    if (!fitToTrain(a) || !fitToTrain(b)) return false;
    var pick = choose(a, 'melee');
    if (!pick || !pick.info.pairs) return false;
    var J = sys('Jobs');
    if (!J || !J.make || !J.start) return false;
    var ok = 0;
    var pair = [a, b];
    for (var i = 0; i < pair.length; i++) {
      var pawn = pair[i];
      if (!Res.reserve(pawn, T.thing(pick.thing), pick.info.slots)) continue;
      var job = J.make('practice', T.thing(pick.thing), null, { count: SESSION_TICKS });
      if (!job) { Res.release(pawn, T.thing(pick.thing)); continue; }
      job.state.skill = pick.info.skill;
      job.state.reason = 'spar';
      if (pawn.job) J.end(pawn, 'interrupted');
      if (J.start(pawn, job)) ok++;
    }
    return ok === 2;
  };

  /* ------------------------------------------------------------------
     The practice job
     ------------------------------------------------------------------ */

  function facilityOfJob(job, map) {
    var thing = job.targetA ? T.resolve(job.targetA, map) : null;
    if (!thing || !FACILITIES[thing.defId]) return null;
    return thing;
  }

  function faceToward(pawn, x, y) {
    if (pawn.dir === undefined) return;
    var dx = x - pawn.x, dy = y - pawn.y;
    if (!dx && !dy) return;
    pawn.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
  }

  function endSession(pawn, job, s) {
    var st = stateOf(pawn);
    st.lastEndTick = gameTick();
    if (!s || !s.skill) return;
    var entry = logEntry(st, s.skill);
    var gained = levelOf(pawn, s.skill) - (s.startLevel || 0);
    entry.ticks += s.ticks || 0;
    entry.xp += s.xp || 0;
    entry.sessions++;
    if (gained > 0) entry.levels += gained;
    st.sessions++;
    st.totalTicks += s.ticks || 0;
    st.lastSkill = s.skill;
    st.lastFacility = s.defId || null;
    if (s.reason === 'assigned') {
      budgetLeft(pawn);                       /* rolls the day over if needed */
      st.budgetTicks += s.ticks || 0;
    }
    if (gained > 0) {
      msg(U.cap(nameOf(pawn)) + ' reached ' + s.skill + ' ' + levelOf(pawn, s.skill) + ' in training.',
        { type: 'good', x: pawn.x, y: pawn.y });
    }
  }

  if (Jobs && Jobs.register) {
    Jobs.register('practice', {
      label: 'practice',
      suspendable: true,
      reportString: function (job, pawn) {
        var thing = pawn && pawn.map ? facilityOfJob(job, pawn.map) : null;
        var info = thing ? FACILITIES[thing.defId] : null;
        if (!info) return 'Training.';
        return U.cap(info.verb) + ' (' + info.skill + ').';
      },
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),

          Toils.custom({
            name: 'train',
            init: function (pawn, job, s) {
              var thing = facilityOfJob(job, pawn.map);
              if (!thing) { s.dead = true; return; }
              s.defId = thing.defId;
              s.info = FACILITIES[thing.defId];
              s.skill = job.state.skill || s.info.skill;
              s.reason = job.state.reason || 'idle';
              s.startLevel = levelOf(pawn, s.skill);
              s.left = job.count > 0 ? job.count : SESSION_TICKS;
              s.ticks = 0;
              s.xp = 0;
              s.paired = false;
              s.partnerId = 0;
              s.opinionAt = 0;
              if (typeof pawn.stopPath === 'function') pawn.stopPath();
            },

            tick: function (pawn, job, s) {
              if (s.dead || !s.info) return 'fail';
              var map = pawn.map;
              var thing = facilityOfJob(job, map);
              if (!thing || !isUsableFacility(map, thing)) return 'done';

              /* Standing next to it is the whole requirement; a facility
                 that is two tiles wide is touched from anywhere along it. */
              if (!thing.covers(pawn.x, pawn.y) && U.cheb(pawn.x, pawn.y, thing.x, thing.y) > 2) return 'fail';
              faceToward(pawn, thing.x, thing.y);

              /* Somebody may have joined or left the ring since the last
                 look, and a pair trains faster than either half. */
              if ((s.ticks % PARTNER_CHECK_BEAT) === 0) {
                var here = occupantsOf(map, thing), partner = null;
                for (var i = 0; i < here.length; i++) if (here[i] !== pawn) { partner = here[i]; break; }
                s.paired = !!partner;
                s.partnerId = partner ? partner.id : 0;
              }

              var partner = s.partnerId ? findPawn(map, s.partnerId) : null;
              var gain = xpPerTick(pawn, s.skill, s.info, s.paired && !!partner);
              s.xp += learn(pawn, s.skill, gain);
              s.ticks++;

              /* A desk is also a pair of hands on the current project,
                 an instrument is also an evening off, and both are worth
                 less than the real thing - which is the point. */
              if (s.info.research) {
                var R = sys('Research');
                if (R && R.addProgress && R.current && R.current()) R.addProgress(s.info.research, null);
              }
              if (s.info.joy) {
                var N = sys('Needs');
                if (N && N.gainJoy) N.gainJoy(pawn, s.info.joy / 60000 * 60, s.info.joyKind || 'training');
              }
              if (s.info.tactics) {
                grantCombatSense(pawn, s.info.tactics / 60, s.paired ? 'spar' : 'drill');
              }

              if (s.paired && partner && s.info.opinion) {
                stateOf(pawn).sparTicks++;
                if (s.ticks - s.opinionAt >= PAIR_OPINION_EVERY) {
                  s.opinionAt = s.ticks;
                  buildOpinion(pawn, partner);
                }
              }

              /* Hard training costs rest on top of the hour it takes. */
              if (pawn.needs && typeof pawn.needs.rest === 'number' && s.info.accident) {
                pawn.needs.rest = U.clamp01(pawn.needs.rest - 0.35 / 60000);
              }

              if ((s.ticks % ACCIDENT_BEAT) === 0 && s.info.accident) {
                if (U.chance(accidentChance(pawn, s.info, s.paired))) {
                  trainingAccident(pawn, s.info, partner);
                  if (pawn.downed || pawn.dead) return 'done';
                }
              }

              /* Stop when the body says so rather than when the clock
                 does: a colonist who got hungry mid-session goes and eats. */
              if ((s.ticks % 120) === 0 && !fitToTrain(pawn)) return 'done';

              return (--s.left <= 0) ? 'done' : 'stay';
            },

            end: function (pawn, job, s) { endSession(pawn, job, s); }
          })
        ];
      }
    });
  }

  function findPawn(map, id) {
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  /* ------------------------------------------------------------------
     Drills

     A colony-wide order: everybody who is not putting out a fire or
     holding a rifle on the player's orders goes and trains for a few
     hours. It costs most of a working day, which is exactly why calling
     one the evening before a raid you can see coming is a decision.
     ------------------------------------------------------------------ */

  var drill = null;

  Practice.drill = function () { return drill; };
  Practice.drillActive = function () { return !!(drill && drill.ticksLeft > 0); };

  function drillCovers(pawn) {
    if (!drill || drill.ticksLeft <= 0) return false;
    if (!pawn || pawn.faction !== 'player' || !pawn.isHuman) return false;
    if (drill.only && drill.only.indexOf(pawn.id) < 0) return false;
    return true;
  }

  Practice.callDrill = function (opts) {
    opts = opts || {};
    var hours = opts.hours === undefined ? 4 : opts.hours;
    hours = U.clamp(hours, 1, 12);
    var skillId = opts.skill && Defs.has('skill', opts.skill) ? opts.skill : null;
    drill = {
      ticksLeft: Math.round(hours * TICKS_PER_HOUR),
      totalTicks: Math.round(hours * TICKS_PER_HOUR),
      startedTick: gameTick(),
      skill: skillId,
      only: opts.pawnIds && opts.pawnIds.length ? opts.pawnIds.slice() : null,
      xp: 0,
      participants: 0
    };
    letter('Training drill',
      'The colony has been called to drill for ' + hours + (hours === 1 ? ' hour' : ' hours') + '. ' +
      'Everyone who is not fighting a fire or under arms drops what they are holding and trains' +
      (skillId ? ' ' + skillId : '') + '. Nothing else gets done while it runs, and that is the price.',
      { kind: 'neutral' });
    return drill;
  };

  Practice.endDrill = function (quiet) {
    if (!drill) return false;
    var banked = Math.round(drill.xp);
    var who = drill.participants;
    drill = null;
    if (!quiet) {
      letter('Drill over',
        'The drill is finished. ' + who + (who === 1 ? ' colonist' : ' colonists') +
        ' took part and banked about ' + banked + ' experience between them. ' +
        'Put them back to work before the day is entirely gone.',
        { kind: 'good' });
    }
    return true;
  };

  /* Nothing short of an emergency interrupts a drill, and the player's
     own orders always win: a drafted colonist stays where they were put. */
  var DRILL_EXEMPT_JOBS = {
    extinguishFire: 1, tendPatient: 1, rescue: 1, carryToBed: 1, feedPatient: 1,
    eat: 1, sleep: 1, layDown: 1, attackMelee: 1, attackStatic: 1, flee: 1,
    practice: 1
  };

  function shoveIntoDrill(map) {
    var J = sys('Jobs');
    if (!J || !J.end) return;
    var list = map.colonists ? map.colonists() : [];
    for (var i = 0; i < list.length; i++) {
      var pawn = list[i];
      if (!drillCovers(pawn)) continue;
      if (pawn.drafted || pawn.mentalState || pawn.downed) continue;
      var id = pawn.job && pawn.job.defId;
      if (id && DRILL_EXEMPT_JOBS[id]) continue;
      if (!fitToTrain(pawn)) continue;
      if (!choose(pawn, drill.skill || stateOf(pawn).assigned)) continue;
      /* Ending the job is enough: think.js asks again straight away and
         the drill work giver is the first thing it finds. */
      J.end(pawn, 'interrupted');
      drill.participants++;
    }
  }

  /* ------------------------------------------------------------------
     Work givers

     workgivers.js loads after this file, so the registry cannot be
     touched at load time; the first Practice.tick installs them. Two
     givers, both on the `basic` column: the drill one runs before any
     ordinary basic work, and the voluntary one runs after all of it.
     ------------------------------------------------------------------ */

  var _installed = false;

  function giveJob(pawn, reason) {
    var wantSkill = null;
    if (reason === 'drill' && drill && drill.skill) wantSkill = drill.skill;
    if (!wantSkill) wantSkill = stateOf(pawn).assigned;

    var pick = choose(pawn, wantSkill);
    /* A pinned skill with no facility for it means the player asked for
       something the colony has not built. Say nothing rather than
       quietly training the wrong thing. */
    if (!pick && wantSkill && stateOf(pawn).assigned === wantSkill) return null;
    if (!pick) pick = choose(pawn, null);
    if (!pick) return null;

    var target = T.thing(pick.thing);
    if (!Res.reserve(pawn, target, pick.info.slots)) return null;

    var length = reason === 'drill' ? DRILL_SESSION_TICKS : SESSION_TICKS;
    if (reason === 'drill' && drill) length = Math.min(length, Math.max(600, drill.ticksLeft));
    if (reason === 'assigned') length = Math.min(length, Math.max(600, budgetLeft(pawn)));

    var job = Jobs.make('practice', target, null, { count: length });
    if (!job) { Res.release(pawn, target); return null; }
    job.state.skill = pick.info.skill;
    job.state.reason = reason;
    return job;
  }

  Practice.installWork = function () {
    if (_installed) return true;
    var W = sys('WorkGivers');
    if (!W || !W.register || !Jobs || !Jobs.isRegistered || !Jobs.isRegistered('practice')) return false;
    _installed = true;
    try {
      W.register({
        id: 'practiceDrill', workType: 'basic', order: 5, label: 'drill',
        tryGiveJob: function (pawn) {
          if (!Practice.drillActive() || !drillCovers(pawn)) return null;
          if (!fitToTrain(pawn)) return null;
          return giveJob(pawn, 'drill');
        }
      });
      W.register({
        id: 'practiceSession', workType: 'basic', order: 95, label: 'practice',
        tryGiveJob: function (pawn) {
          var reason = practiceMoment(pawn);
          if (!reason || reason === 'drill') return null;
          return giveJob(pawn, reason);
        }
      });
    } catch (e) {
      var G = sys('Game');
      if (G && G.debug) console.log('[practice] work givers refused: ' + (e && e.message));
      return false;
    }
    return true;
  };

  Practice.installed = function () { return _installed; };

  /* ------------------------------------------------------------------
     The tick

     game.js runs this on the slow beat, every 500 ticks, with Game as
     its argument. Everything here is measured in hours, so that is
     plenty often, and nothing in it walks the map.
     ------------------------------------------------------------------ */

  var SLOW_BEAT = 500;
  var IDLE_JOBS = { wander: 1, joyIdle: 1, wait: 1 };
  var _lastTick = -1;

  Practice.tick = function (arg) {
    Practice.installWork();

    var G = sys('Game');
    var game = (arg && typeof arg.tick === 'number' && arg.map !== undefined) ? arg : G;
    var map = game ? game.map : (arg && arg.pawns ? arg : null);
    if (!map || !map.colonists) return;

    var now = gameTick();
    var elapsed = _lastTick < 0 ? SLOW_BEAT : Math.max(1, now - _lastTick);
    _lastTick = now;

    /* Who currently has nothing better to do. The work tier has already
       had its turn by the time a colonist is wandering, so this is the
       honest signal that an hour at the dummy costs the colony nothing. */
    var colonists = map.colonists();
    for (var i = 0; i < colonists.length; i++) {
      var pawn = colonists[i];
      var id = pawn.job && pawn.job.defId;
      if (!id || IDLE_JOBS[id]) stateOf(pawn).idleTick = now;
      else {
        var Th = sys('Think');
        if (Th && Th.lastLevel) {
          var level = Th.lastLevel(pawn);
          if (level === 'idle' || level === 'joy') stateOf(pawn).idleTick = now;
        }
      }
      if (pawn.job && pawn.job.defId === 'practice' && drill) drill.xp += 0;
    }

    if (drill) {
      drill.ticksLeft -= elapsed;
      if (drill.ticksLeft <= 0) Practice.endDrill(false);
      else shoveIntoDrill(map);
    }
  };

  /* ------------------------------------------------------------------
     Reporting: the training log and the decay watch
     ------------------------------------------------------------------ */

  /* What this colonist has practised and what it bought them. */
  Practice.logOf = function (pawn) {
    if (!pawn) return [];
    var st = stateOf(pawn), out = [];
    for (var skillId in st.log) {
      var e = st.log[skillId];
      out.push({
        skill: skillId,
        label: (Defs.maybe('skill', skillId) || {}).label || skillId,
        sessions: e.sessions,
        hours: Math.round(e.ticks / TICKS_PER_HOUR * 10) / 10,
        xp: Math.round(e.xp),
        levels: e.levels,
        level: levelOf(pawn, skillId)
      });
    }
    out.sort(function (a, b) { return b.xp - a.xp; });
    return out;
  };

  Practice.summary = function (pawn) {
    if (!pawn) return '';
    var rows = Practice.logOf(pawn);
    if (!rows.length) return 'Has never trained.';
    var st = stateOf(pawn), parts = [];
    for (var i = 0; i < rows.length && i < 4; i++) {
      parts.push(rows[i].label + ' ' + rows[i].hours + 'h' +
        (rows[i].levels ? ' (+' + rows[i].levels + ')' : ''));
    }
    var line = parts.join(', ');
    if (st.accidents) line += '; ' + st.accidents + ' training injur' + (st.accidents === 1 ? 'y' : 'ies');
    return line;
  };

  /* pawn.js rots expertise above level ten that has gone a day
     untouched. This does not redo that - it reports it, so the player
     can see what a night at the bench would save. */
  Practice.decayWatch = function (pawn) {
    if (!pawn || !pawn.skills) return [];
    var now = gameTick(), out = [];
    for (var id in pawn.skills) {
      var s = pawn.skills[id];
      if (!s || s.level <= 10) continue;
      var idle = now - (s.lastGainTick || 0);
      if (idle < TICKS_PER_DAY) continue;
      out.push({
        skill: id,
        level: s.level,
        daysIdle: Math.round(idle / TICKS_PER_DAY * 10) / 10,
        trainable: Practice.facilitiesForSkill(id).length > 0
      });
    }
    out.sort(function (a, b) { return b.level - a.level; });
    return out;
  };

  Practice.isPracticing = function (pawn) {
    return !!(pawn && pawn.job && pawn.job.defId === 'practice');
  };

  /* Everything the colony could train right now, for a UI panel. */
  Practice.colonySummary = function (map) {
    var out = { facilities: [], drill: drill ? { ticksLeft: drill.ticksLeft, skill: drill.skill } : null };
    if (!map || !map.byDef) return out;
    for (var i = 0; i < FACILITY_IDS.length; i++) {
      var defId = FACILITY_IDS[i];
      var list = map.byDef(defId), live = 0;
      for (var k = 0; k < list.length; k++) if (isUsableFacility(map, list[k])) live++;
      if (live) {
        out.facilities.push({
          defId: defId, count: live,
          skill: FACILITIES[defId].skill,
          efficiency: Practice.efficiency(defId)
        });
      }
    }
    return out;
  };

  /* ------------------------------------------------------------------
     Save

     Per-pawn state rides on pawn.practice, which save.js copies with
     the rest of the colonist. Only the drill is global.
     ------------------------------------------------------------------ */

  Practice.save = function () {
    return {
      drill: drill ? {
        ticksLeft: drill.ticksLeft, totalTicks: drill.totalTicks,
        startedTick: drill.startedTick, skill: drill.skill,
        only: drill.only ? drill.only.slice() : null,
        xp: drill.xp, participants: drill.participants
      } : null
    };
  };

  Practice.load = function (obj) {
    drill = null;
    _lastTick = -1;
    if (!obj || !obj.drill) return true;
    var d = obj.drill;
    drill = {
      ticksLeft: d.ticksLeft || 0,
      totalTicks: d.totalTicks || d.ticksLeft || 0,
      startedTick: d.startedTick || 0,
      skill: d.skill || null,
      only: d.only ? d.only.slice() : null,
      xp: d.xp || 0,
      participants: d.participants || 0
    };
    if (drill.ticksLeft <= 0) drill = null;
    return true;
  };

  Practice.reset = function () {
    drill = null;
    _lastTick = -1;
  };

  root.Practice = Practice;
})(this);
