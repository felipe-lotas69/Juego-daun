/* ============================================================
   needs.js - needs, thoughts, mood, and the mental break line.

   Three ideas hold this file together.

   A *need* is one number in 0..1 that drifts every tick. Drift is the
   only thing done at full tick rate, because it is three multiplies per
   pawn; everything that has to look at the world - the room a pawn is
   standing in, the light on the tile, how badly they are hurt - happens
   on the rare tick (every 250, staggered by pawn.id) and is cached in
   between. The per-day rates in the balance table are divided by 60000
   once, at load, and never again.

   A *thought* is a mood modifier with an age. There are two kinds and
   they live in the same list so the UI only has to read one array.
   Memories are added by other systems (Needs.addThought) and expire on
   their own; situational thoughts are derived from the world every rare
   tick by refreshSituationalThoughts and are reconciled rather than
   accumulated, so a pawn who walks out of a cold room simply stops
   having the cold thought instead of carrying a stale memory of it.
   Situational entries carry `situational: true` and never age out.

   *Mood* is 0.5 plus every thought offset plus trait offsets, clamped.
   It is cached on pawn.mood and only recomputed when the thought list
   changed or the rare tick came round, because the Needs tab, the alert
   list and the break check all ask for it several times a tick.

   Thought and trait defs belong to def_pawns.js. This file reads them
   defensively - stage arrays or a flat mood, either field spelling -
   and falls back to its own table when a def is absent, so needs.js
   loads and behaves alone in the harness. Mood values are normalised:
   anything bigger than 1.5 is assumed to be stated in RimWorld-style
   mood points and divided by 100.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;

  var TICKS_PER_DAY = 60000;
  var RARE = 250;
  var MOOD_BASE = 0.5;

  /* Balance-table rates, per day, converted to per tick once. */
  var FOOD_FALL = 1.6 / TICKS_PER_DAY;
  var REST_FALL = 1.0 / TICKS_PER_DAY;
  var REST_GAIN = 2.6 / TICKS_PER_DAY;
  var JOY_FALL = 0.9 / TICKS_PER_DAY;
  var JOY_GAIN = 5.0 / TICKS_PER_DAY;
  var COMFORT_RATE = 8.0 / TICKS_PER_DAY;
  var OUTDOORS_FALL = 0.45 / TICKS_PER_DAY;
  var OUTDOORS_GAIN = 2.2 / TICKS_PER_DAY;
  var TOLERANCE_FALL = 0.30 / TICKS_PER_DAY;

  /* Comfort of bare ground. A pawn who never sits parks here. */
  var GROUND_COMFORT = 0.35;
  /* Rest multiplier for sleeping on the floor with no bed at all. */
  var NO_BED_REST = 0.65;

  function sys(name) { return typeof root[name] !== 'undefined' && root[name] ? root[name] : null; }
  function clamp01(v) { return v < 0 ? 0 : (v > 1 ? 1 : v); }

  /* ------------------------------------------------------------------
     Fallback thought table.

     def_pawns.js owns the real thought defs. This table is only read
     when a def is missing, which happens in the harness and in any test
     that loads needs.js on its own. Mood is in need units (0..1), so
     -0.06 here is RimWorld's -6.
     ------------------------------------------------------------------ */
  var FALLBACK = {
    hungry: { stages: [{ label: 'Hungry', mood: -0.06 }, { label: 'Urgently hungry', mood: -0.12 }] },
    starving: { label: 'Starving', mood: -0.20 },
    ateRawFood: { label: 'Ate raw food', mood: -0.05, durationDays: 1 },
    ateFineMeal: { label: 'Ate a fine meal', mood: 0.05, durationDays: 1 },
    ateWithoutTable: { label: 'Ate without a table', mood: -0.03, durationDays: 0.5 },
    ateInImpressiveRoom: {
      durationDays: 1,
      stages: [{ label: 'Ate in a decent room', mood: 0.02 },
               { label: 'Ate in a fine room', mood: 0.04 },
               { label: 'Ate in an impressive room', mood: 0.06 }]
    },
    sleptOutside: { label: 'Slept outside', mood: -0.05, durationDays: 0.6 },
    sleptOnGround: { label: 'Slept on the ground', mood: -0.04, durationDays: 0.6 },
    sleptInBarracks: { label: 'Slept in a barracks', mood: -0.03, durationDays: 0.6 },
    sleptInBedroom: { label: 'Slept in own bedroom', mood: 0.03, durationDays: 0.6 },
    coldRoom: {
      stages: [{ label: 'A bit chilly', mood: -0.04 },
               { label: 'Cold', mood: -0.07 },
               { label: 'Freezing', mood: -0.11 }]
    },
    hotRoom: {
      stages: [{ label: 'A bit warm', mood: -0.04 },
               { label: 'Hot', mood: -0.07 },
               { label: 'Sweltering', mood: -0.11 }]
    },
    darkness: { label: 'In the dark', mood: -0.05 },
    uglyRoom: {
      stages: [{ label: 'Ugly surroundings', mood: -0.03 },
               { label: 'Very ugly surroundings', mood: -0.05 },
               { label: 'Hideous surroundings', mood: -0.08 }]
    },
    prettyRoom: {
      stages: [{ label: 'Pretty surroundings', mood: 0.03 },
               { label: 'Beautiful surroundings', mood: 0.05 },
               { label: 'Stunning surroundings', mood: 0.08 }]
    },
    colonistDied: { label: 'A colonist died', mood: -0.15, durationDays: 8, stackLimit: 5 },
    colonistLost: { label: 'A colonist left us', mood: -0.10, durationDays: 6, stackLimit: 3 },
    observedCorpse: { label: 'Saw a corpse', mood: -0.04, durationDays: 0.6, stackLimit: 3 },
    pain: {
      stages: [{ label: 'Minor pain', mood: -0.04 },
               { label: 'Pain', mood: -0.10 },
               { label: 'Severe pain', mood: -0.20 },
               { label: 'Agony', mood: -0.32 }]
    },
    sick: {
      stages: [{ label: 'Feeling sick', mood: -0.05 },
               { label: 'Ill', mood: -0.10 },
               { label: 'Gravely ill', mood: -0.18 }]
    },
    tendedWound: { label: 'Wounds tended', mood: 0.03, durationDays: 1, stackLimit: 3 },
    rescued: { label: 'Rescued by a colonist', mood: 0.10, durationDays: 8 },
    recruitedColonist: { label: 'We recruited someone', mood: 0.08, durationDays: 5 },
    newColonistJoined: { label: 'A new colonist joined', mood: 0.06, durationDays: 3 },
    raidBeaten: { label: 'We beat off a raid', mood: 0.10, durationDays: 3 },
    catharsis: { label: 'Catharsis', mood: 0.10, durationDays: 2 },
    insulted: { label: 'Insulted me', mood: -0.06, durationDays: 2, stackLimit: 3 },
    chatted: { label: 'Chatted with a friend', mood: 0.02, durationDays: 0.6, stackLimit: 3 },
    killedHumanBloodlust: { label: 'I killed someone', mood: 0.10, durationDays: 2, stackLimit: 3 },
    witnessedDeathAlly: { label: 'Witnessed an ally die', mood: -0.10, durationDays: 5, stackLimit: 3 },
    naturalMoodBuff: { label: 'Natural optimism', mood: 0.12 },
    naturalMoodDebuff: { label: 'Natural pessimism', mood: -0.12 },
    hadNiceMeal: { label: 'Had a nice meal', mood: 0.03, durationDays: 1 },
    comfortableBed: {
      stages: [{ label: 'Comfortable bed', mood: 0.02 },
               { label: 'Very comfortable bed', mood: 0.04 }]
    },
    soakingWet: { label: 'Soaking wet', mood: -0.06 },
    ateKibble: { label: 'Ate kibble', mood: -0.05, durationDays: 1 }
  };

  Object.keys(FALLBACK).forEach(function (id) {
    var d = FALLBACK[id];
    d.id = id;
    if (d.label === undefined) d.label = (d.stages && d.stages[0] && d.stages[0].label) || id;
    if (d.durationDays === undefined) d.durationDays = 1;
    if (d.stackLimit === undefined) d.stackLimit = 1;
  });

  /* Thoughts that are recomputed from the world instead of remembered. */
  var SITUATIONAL = {
    hungry: 1, starving: 1, pain: 1, sick: 1, coldRoom: 1, hotRoom: 1, darkness: 1,
    uglyRoom: 1, prettyRoom: 1, comfortableBed: 1,
    naturalMoodBuff: 1, naturalMoodDebuff: 1
  };

  /* A psychopath feels nothing about any of these; bloodlust shrugs off corpses. */
  var DEATH_THOUGHTS = {
    colonistDied: 1, colonistLost: 1, observedCorpse: 1, witnessedDeathAlly: 1
  };

  /* Nutrition per unit when def_things.js has not stated it. */
  var FALLBACK_NUTRITION = {
    mealSimple: 0.9, mealFine: 0.9, kibble: 0.05,
    riceRaw: 0.05, potatoRaw: 0.05, cornRaw: 0.05, berries: 0.05, meatRaw: 0.05
  };
  var RAW_FOOD = { riceRaw: 1, potatoRaw: 1, cornRaw: 1, meatRaw: 1 };
  var RAW_TASTY = { berries: 1 };
  var COOKED_MEAL = { mealSimple: 1, mealFine: 1 };
  var DISEASE_HEDIFFS = {
    flu: 1, infection: 1, foodPoisoning: 1, hypothermia: 1, heatstroke: 1
  };

  var Needs = {};

  Needs.thresholds = { hungry: 0.30, urgentlyHungry: 0.15, tired: 0.28, veryTired: 0.14 };
  Needs.breakBase = { minor: 0.35, major: 0.25, extreme: 0.15 };
  Needs.MOOD_BASE = MOOD_BASE;
  Needs.JOY_WANT = 0.30;
  Needs.CABIN_FEVER = 0.10;

  /* Break threshold shifts, by trait. Summed, so a volatile neurotic is
     genuinely fragile. */
  var BREAK_SHIFT = { ironWilled: -0.06, volatile: 0.06, neurotic: 0.04, psychopath: -0.03 };

  /* ---------- def reading ---------- */

  /* Memoised, but only once def_pawns.js has actually registered the def:
     a fallback answer is never cached, so a lookup that happened early
     does not pin the stand-in table for the rest of the game. */
  var _defCache = {};

  function thoughtDef(id) {
    var d = _defCache[id];
    if (d) return d;
    var D = sys('Defs');
    if (D && D.has('thought', id)) {
      d = D.get('thought', id);
      _defCache[id] = d;
      return d;
    }
    return FALLBACK[id] || null;
  }

  /* Thoughts hold their def id, never the def object, so save.js can
     serialise pawn.thoughts as it stands. */
  function defOfThought(t) { return thoughtDef(t.defId); }

  /* def_pawns.js may state mood in need units or in RimWorld mood points;
     anything past 1.5 can only be the latter. */
  function normMood(v) {
    if (typeof v !== 'number' || v !== v) return 0;
    return Math.abs(v) > 1.5 ? v / 100 : v;
  }

  function pickStage(def, degree) {
    var st = def.stages;
    if (!st || !st.length) return null;
    var i = degree | 0;
    if (i < 0) i = 0;
    if (i >= st.length) i = st.length - 1;
    return st[i];
  }

  function readMood(o) {
    if (!o || typeof o !== 'object') return null;
    if (typeof o.mood === 'number') return normMood(o.mood);
    if (typeof o.baseMoodEffect === 'number') return normMood(o.baseMoodEffect);
    if (typeof o.moodOffset === 'number') return normMood(o.moodOffset);
    if (typeof o.baseMood === 'number') return normMood(o.baseMood);
    return null;
  }

  /* A real def that states no mood anywhere borrows this file's number
     instead of becoming a weightless thought nobody can see. */
  function fallbackFor(def) {
    var fb = FALLBACK[def.id];
    return (fb && fb !== def) ? fb : null;
  }

  function stageMood(def, degree) {
    var m = readMood(pickStage(def, degree));
    if (m === null) m = readMood(def);
    if (m !== null) return m;
    var fb = fallbackFor(def);
    return fb ? stageMood(fb, degree) : 0;
  }

  function stageLabel(def, degree) {
    var s = pickStage(def, degree);
    if (typeof s === 'string' && s) return s;
    if (s && s.label) return s.label;
    if (def.label) return def.label;
    var fb = fallbackFor(def);
    return fb ? stageLabel(fb, degree) : def.id;
  }

  function stackLimitOf(def) {
    var n = def.stackLimit;
    if (typeof n === 'number' && n > 0) return n;
    var fb = fallbackFor(def);
    return fb ? stackLimitOf(fb) : 1;
  }

  /* The second and later copies of one thought count for less, the way
     the fourth funeral hurts less than the first. */
  function stackedFactor(def) {
    if (typeof def.stackedMoodFactor === 'number') return def.stackedMoodFactor;
    if (typeof def.stackedEffectMultiplier === 'number') return def.stackedEffectMultiplier;
    return 0.75;
  }

  function durationTicksOf(def) {
    var d = def.durationDays;
    if (typeof d !== 'number' || !(d > 0)) {
      var fb = fallbackFor(def);
      d = fb ? fb.durationDays : 1;
      if (typeof d !== 'number' || !(d > 0)) d = 1;
    }
    return Math.round(d * TICKS_PER_DAY);
  }

  /* ---------- pawn helpers ---------- */

  function hasTrait(pawn, id) {
    var tr = pawn.traits;
    if (!tr || !tr.length) return false;
    for (var i = 0; i < tr.length; i++) {
      var t = tr[i];
      if (t === id) return true;
      if (t && t.id === id) return true;
    }
    return false;
  }
  Needs.hasTrait = hasTrait;

  function traitDefOf(t) {
    if (t && typeof t === 'object') return t;
    var D = sys('Defs');
    return (D && D.maybe) ? D.maybe('trait', t) : null;
  }

  function isHuman(pawn) { return pawn.isAnimal !== true && pawn.isHuman !== false; }

  /* Sleeping means the rest need is being refilled. A downed pawn counts:
     they are flat on their back either way. */
  function isAsleep(pawn) {
    if (pawn.asleep === true) return true;
    if (pawn.downed === true) return true;
    var j = pawn.job;
    if (!j) return false;
    if (j.defId === 'sleep') return true;
    if (j.defId === 'layDown') return !j.state || j.state.asleep !== false;
    return false;
  }
  Needs.isAsleep = isAsleep;

  /* def_things.js keeps building flags in def.building; the loose spellings
     are only here so a hand-made stub in a test still reads as a bed. */
  function bedDef(def) {
    if (!def) return false;
    if (def.building && def.building.isBed) return true;
    if (def.isBed || def.bed) return true;
    return def.id === 'bed' || def.id === 'sleepingSpot';
  }

  function buildingFlag(def, name) {
    if (!def) return null;
    if (def.building && def.building[name] !== undefined) return def.building[name];
    return def[name] !== undefined ? def[name] : null;
  }

  /* The bed (or spot) the pawn is lying on, if any. */
  function bedUnder(pawn) {
    var map = pawn.map;
    if (!map || !map.buildingAt) return null;
    var b = map.buildingAt(pawn.x, pawn.y);
    return (b && bedDef(b.def)) ? b : null;
  }

  /* A bed multiplies the base 2.6/day. The building template fills this
     field with 0 for everything that is not a bed, so only a positive
     number counts; bare ground and an unrecognised bed are both 1. */
  function bedRestEffectiveness(bed) {
    if (!bed || !bed.def) return 1;
    var e = buildingFlag(bed.def, 'bedRestEffectiveness');
    return (typeof e === 'number' && e > 0) ? e : 1;
  }

  function comfortOfBuilding(b) {
    if (!b || !b.def) return -1;
    if (typeof b.def.comfort === 'number' && b.def.comfort > 0) return b.def.comfort;
    var bc = buildingFlag(b.def, 'bedComfort');
    if (typeof bc === 'number' && bc > 0) return bc;
    return -1;
  }

  function comfortHere(pawn) {
    var map = pawn.map;
    if (!map || !map.buildingAt) return GROUND_COMFORT;
    var b = map.buildingAt(pawn.x, pawn.y);
    var c = comfortOfBuilding(b);
    if (c < 0) return GROUND_COMFORT;
    /* Crafted furniture is nicer when it is well made. */
    if (typeof b.quality === 'number') c += (b.quality - 3) * 0.03;
    return clamp01(c);
  }

  function roomOf(pawn) {
    var Reg = sys('Regions');
    if (!Reg || !Reg.roomAt || !pawn.map) return null;
    return Reg.roomAt(pawn.map, pawn.x, pawn.y);
  }

  function roofedOver(pawn) {
    var map = pawn.map;
    if (map && map.hasRoofAt) return !!map.hasRoofAt(pawn.x, pawn.y);
    return false;
  }

  function lightHere(pawn) {
    var P = sys('Power');
    if (P && P.lightAt && pawn.map) return P.lightAt(pawn.map, pawn.x, pawn.y);
    var G = sys('Game');
    if (G && G.daylight) return roofedOver(pawn) ? 0.5 * G.daylight() : G.daylight();
    return 1;
  }

  function hourNow() {
    var G = sys('Game');
    return (G && G.hour) ? G.hour() : 12;
  }

  /* What joy kind the current job provides, or null when this is work. */
  function joyJobKind(pawn) {
    var j = pawn.job;
    if (!j) return null;
    if (j.joyKind) return j.joyKind;
    if (j.def && j.def.joyKind) return j.def.joyKind;
    if (j.defId === 'joyIdle') return 'idle';
    return null;
  }

  /* ---------- creation ---------- */

  Needs.create = function (pawn) {
    pawn.needs = {
      food: startLevel(),
      rest: startLevel(),
      joy: startLevel(),
      comfort: GROUND_COMFORT,
      outdoors: startLevel()
    };
    pawn.thoughts = [];
    pawn.mood = MOOD_BASE;
    pawn.joyTolerance = {};
    pawn.lastJoyKind = null;
    pawn._needTick = 0;
    pawn._moodDirty = true;
    pawn._comfortTarget = GROUND_COMFORT;
    pawn._comfortX = -1;
    pawn._comfortY = -1;
    refreshTraitCache(pawn);
    Needs.refreshBreakThresholds(pawn);
    return pawn.needs;
  };

  function startLevel() {
    return clamp01(U.gauss(0.80, 0.05, 0.62, 0.95));
  }

  /* ---------- the tick ---------- */

  Needs.tick = function (pawn) {
    var n = pawn.needs;
    if (!n || pawn.dead) return;

    var asleep = isAsleep(pawn);
    var human = isHuman(pawn);
    var fx = pawn._traitFx || refreshTraitCache(pawn);

    n.food = clamp01(n.food - FOOD_FALL * foodFallFactor(pawn, fx));

    if (asleep) n.rest = clamp01(n.rest + REST_GAIN * restGainFactor(pawn));
    else n.rest = clamp01(n.rest - REST_FALL * restFallFactor(fx));

    if (human) {
      var kind = asleep ? null : joyJobKind(pawn);
      if (kind) Needs.gainJoy(pawn, JOY_GAIN, kind);
      else if (!asleep) n.joy = clamp01(n.joy - JOY_FALL);

      if (!fx.ascetic) {
        /* The comfort source only changes when the pawn does, so the
           lookup is two integer compares on most ticks. */
        if (pawn.x !== pawn._comfortX || pawn.y !== pawn._comfortY) {
          pawn._comfortX = pawn.x;
          pawn._comfortY = pawn.y;
          pawn._comfortTarget = comfortHere(pawn);
        }
        n.comfort = U.approach(n.comfort, pawn._comfortTarget, COMFORT_RATE);
      }
    }

    pawn._needTick = (pawn._needTick + 1) | 0;
    if (((pawn._needTick + (pawn.id | 0)) % RARE) === 0) rareTick(pawn, human);
  };

  /* The three traits the per-tick drift asks about, answered once instead
     of walking the trait list on every pawn on every tick. Refreshed each
     rare tick so a trait gained after generation still counts. */
  function refreshTraitCache(pawn) {
    pawn._traitFx = {
      ascetic: hasTrait(pawn, 'ascetic'),
      gourmand: hasTrait(pawn, 'gourmand'),
      nightOwl: hasTrait(pawn, 'nightOwl')
    };
    return pawn._traitFx;
  }

  function foodFallFactor(pawn, fx) {
    var f = fx.gourmand ? 1.25 : 1;
    if (pawn.kind && typeof pawn.kind.hungerRateFactor === 'number') f *= pawn.kind.hungerRateFactor;
    return f;
  }

  /* Night owls are wide awake after dark and drag through the morning. */
  function restFallFactor(fx) {
    if (!fx.nightOwl) return 1;
    var h = hourNow();
    return (h >= 18 || h < 4) ? 0.80 : 1.20;
  }

  /* 2.6/day is what a bed gives, so def_things' bed (effectiveness 1)
     lands exactly on the balance figure and the floor has to be the
     thing that is worse. A sleeping spot at 0.7 then sits where it
     belongs: better than the bare boards, well short of a real bed. */
  function restGainFactor(pawn) {
    var bed = bedUnder(pawn);
    return bed ? bedRestEffectiveness(bed) : NO_BED_REST;
  }

  function rareTick(pawn, human) {
    refreshTraitCache(pawn);
    ageThoughts(pawn);

    if (human) {
      Needs.refreshSituationalThoughts(pawn);
      decayJoyTolerance(pawn);
      updateOutdoors(pawn);
      if (!pawn.breakThresholds) Needs.refreshBreakThresholds(pawn);
      recomputeMood(pawn);
    }
    /* Nothing here for an empty stomach on purpose: health.js reads
       pawn.needs.food on its own rare tick and drives malnutrition from
       it, so adding severity here would starve a pawn twice as fast. */
  }

  function updateOutdoors(pawn) {
    var n = pawn.needs;
    /* Cheap on purpose: one roof lookup every 250 ticks, then 250 ticks
       of movement applied in one go. */
    if (roofedOver(pawn)) n.outdoors = clamp01(n.outdoors - OUTDOORS_FALL * RARE);
    else n.outdoors = clamp01(n.outdoors + OUTDOORS_GAIN * RARE);
  }

  function decayJoyTolerance(pawn) {
    var tol = pawn.joyTolerance;
    if (!tol) return;
    var keys = Object.keys(tol);
    for (var i = 0; i < keys.length; i++) {
      var v = tol[keys[i]] - TOLERANCE_FALL * RARE;
      if (v <= 0.001) delete tol[keys[i]];
      else tol[keys[i]] = v;
    }
  }

  function ageThoughts(pawn) {
    var list = pawn.thoughts;
    if (!list || !list.length) return;
    for (var i = list.length - 1; i >= 0; i--) {
      var t = list[i];
      if (t.situational) continue;
      t.ageTicks += RARE;
      if (t.ageTicks >= t.durationTicks) {
        list.splice(i, 1);
        pawn._moodDirty = true;
      }
    }
  }

  /* ---------- thoughts ---------- */

  Needs.addThought = function (pawn, thoughtId, opts) {
    if (!pawn || !pawn.thoughts) return null;
    var def = thoughtDef(thoughtId);
    if (!def) return null;
    opts = opts || {};

    var degree = opts.degree | 0;
    var other = opts.otherPawnId !== undefined ? opts.otherPawnId : null;
    var duration = typeof opts.duration === 'number' ? opts.duration : durationTicksOf(def);
    var limit = stackLimitOf(def);
    var list = pawn.thoughts;
    /* health.js fires pain and sick as plain memories. Both are things
       this file reads straight off the world, so the entry is marked
       situational whoever asked for it and refreshSituationalThoughts
       clears it the moment the cause is gone. */
    var situational = !!opts.situational || !!SITUATIONAL[thoughtId];

    /* One entry per (def, other pawn). Re-firing refreshes the clock and
       adds a stack, which is what makes three insults in a row sting. */
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t.defId !== thoughtId || t.otherPawnId !== other) continue;
      t.ageTicks = 0;
      t.durationTicks = duration;
      t.degree = degree;
      if (typeof opts.mood === 'number') t.moodOverride = normMood(opts.mood);
      if (situational) t.situational = true;
      if (!opts.noStack && t.stacks < limit) t.stacks++;
      pawn._moodDirty = true;
      return t;
    }

    var entry = {
      defId: thoughtId,
      ageTicks: 0,
      degree: degree,
      stacks: 1,
      otherPawnId: other,
      durationTicks: duration,
      situational: situational,
      /* Set only when the caller states a mood of its own, which is how
         a trait's number reaches the thought that represents it. */
      moodOverride: typeof opts.mood === 'number' ? normMood(opts.mood) : null
    };
    list.push(entry);

    /* A colony that runs for a hundred days should not carry a thousand
       memories. Oldest non-situational memory goes first. */
    if (list.length > 48) {
      for (var j = 0; j < list.length; j++) {
        if (!list[j].situational) { list.splice(j, 1); break; }
      }
    }
    pawn._moodDirty = true;
    return entry;
  };

  function findThought(pawn, thoughtId) {
    var list = pawn.thoughts;
    for (var i = 0; i < list.length; i++) if (list[i].defId === thoughtId) return list[i];
    return null;
  }

  /* Which of the two natural-mood thoughts this pawn carries, and the
     trait's own number when it states one. */
  function naturalMood(pawn) {
    var tr = pawn.traits;
    if (!tr) return null;
    for (var i = 0; i < tr.length; i++) {
      var id = (tr[i] && tr[i].id) || tr[i];
      if (id !== 'optimist' && id !== 'pessimist') continue;
      var def = traitDefOf(tr[i]);
      var m = (def && typeof def.moodOffset === 'number') ? normMood(def.moodOffset) : null;
      return { id: id === 'optimist' ? 'naturalMoodBuff' : 'naturalMoodDebuff', mood: m };
    }
    return null;
  }

  Needs.hasThought = function (pawn, thoughtId) {
    var list = pawn && pawn.thoughts;
    if (!list) return false;
    for (var i = 0; i < list.length; i++) if (list[i].defId === thoughtId) return true;
    return false;
  };

  Needs.removeThought = function (pawn, thoughtId) {
    var list = pawn && pawn.thoughts;
    if (!list) return 0;
    var n = 0;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].defId === thoughtId) { list.splice(i, 1); n++; }
    }
    if (n) pawn._moodDirty = true;
    return n;
  };

  /* Reused across pawns so the rare tick allocates nothing. Flat pairs of
     [defId, degree]; single-threaded simulation, so this is safe. */
  var _want = [];
  function want(id, degree) { _want.push(id); _want.push(degree | 0); }

  Needs.refreshSituationalThoughts = function (pawn) {
    if (!pawn || !pawn.thoughts || !pawn.needs) return;
    _want.length = 0;

    var n = pawn.needs;
    var asleep = isAsleep(pawn);
    var TH = Needs.thresholds;

    if (n.food <= 0.0001) want('starving', 0);
    else if (n.food < TH.urgentlyHungry) want('hungry', 1);
    else if (n.food < TH.hungry) want('hungry', 0);

    /* Same degree boundaries health.js uses, so the two never disagree
       about how much a wound hurts. */
    var H = sys('Health');
    if (H && H.painLevel) {
      var p = H.painLevel(pawn) || 0;
      if (p > 0.05) want('pain', p > 0.7 ? 3 : (p > 0.4 ? 2 : (p > 0.2 ? 1 : 0)));
    }

    var sickness = worstSickness(pawn);
    if (sickness > 0.05) want('sick', sickness < 0.35 ? 0 : (sickness < 0.7 ? 1 : 2));

    var room = roomOf(pawn);
    var temp = room ? room.temperature : outdoorTemp();
    if (typeof temp === 'number') {
      if (temp < 12) want('coldRoom', temp < -6 ? 2 : (temp < 4 ? 1 : 0));
      else if (temp > 30) want('hotRoom', temp > 46 ? 2 : (temp > 38 ? 1 : 0));
    }

    /* Beauty only reads as a room when there is a room; the great outdoors
       has no decorator to blame. */
    if (room && !room.outdoor && !hasTrait(pawn, 'ascetic')) {
      var b = room.beauty || 0;
      if (b <= -1) want('uglyRoom', b <= -8 ? 2 : (b <= -4 ? 1 : 0));
      else if (b >= 2) want('prettyRoom', b >= 10 ? 2 : (b >= 5 ? 1 : 0));
    }

    if (!asleep && lightHere(pawn) < 0.30) want('darkness', 0);

    if (asleep && !hasTrait(pawn, 'ascetic')) {
      var bed = bedUnder(pawn);
      var c = comfortOfBuilding(bed);
      if (c >= 0.6) want('comfortableBed', c >= 0.75 ? 1 : 0);
    }

    var nat = naturalMood(pawn);
    if (nat) want(nat.id, 0);

    reconcileSituational(pawn);

    /* The trait def is the authority on how sunny a pawn is, so when
       def_pawns.js gives optimist a moodOffset that number is written
       onto the thought instead of the thought def's own. */
    if (nat && nat.mood !== null) {
      var natT = findThought(pawn, nat.id);
      if (natT && natT.moodOverride !== nat.mood) {
        natT.moodOverride = nat.mood;
        pawn._moodDirty = true;
      }
    }

    /* Sleep quality is fired as a memory, not a situational, so waking up
       does not instantly erase a night spent on the bare ground.
       Refreshing it every rare tick keeps it alive while the pawn sleeps. */
    if (asleep) refreshSleepThoughts(pawn);

    /* Nothing in this climate rains, but wading a river will soak a pawn,
       and they stay damp for a few hours after climbing out. */
    var terr = (pawn.map && pawn.map.terrainAt) ? pawn.map.terrainAt(pawn.x, pawn.y) : null;
    if (terr && terr.isWater) {
      Needs.addThought(pawn, 'soakingWet', { noStack: true, duration: 0.25 * TICKS_PER_DAY });
    }
  };

  function reconcileSituational(pawn) {
    var list = pawn.thoughts;
    var i, j, t, found;
    for (i = list.length - 1; i >= 0; i--) {
      t = list[i];
      if (!t.situational) continue;
      found = -1;
      for (j = 0; j < _want.length; j += 2) {
        if (_want[j] === t.defId) { found = j; break; }
      }
      if (found < 0) {
        list.splice(i, 1);
        pawn._moodDirty = true;
      } else {
        if (t.degree !== _want[found + 1]) {
          t.degree = _want[found + 1];
          pawn._moodDirty = true;
        }
        _want[found] = null;
      }
    }
    for (j = 0; j < _want.length; j += 2) {
      if (_want[j] === null) continue;
      Needs.addThought(pawn, _want[j], { degree: _want[j + 1], situational: true });
    }
    _want.length = 0;
  }

  function refreshSleepThoughts(pawn) {
    var bed = bedUnder(pawn);
    var opt = { noStack: true };
    if (!roofedOver(pawn)) Needs.addThought(pawn, 'sleptOutside', opt);
    if (!bed || bed.def.id === 'sleepingSpot') {
      Needs.addThought(pawn, 'sleptOnGround', opt);
      return;
    }
    var room = roomOf(pawn);
    if (!room || room.outdoor) return;
    var owned = pawn.ownedBedId && bed.id === pawn.ownedBedId;
    if (owned && room.role === 'bedroom') Needs.addThought(pawn, 'sleptInBedroom', opt);
    else if (countBedsIn(pawn.map, room) > 1) Needs.addThought(pawn, 'sleptInBarracks', opt);
  }

  /* Rooms are small and this only runs for a sleeping pawn once per rare
     tick, so a straight scan of the cells beats keeping another index. */
  function countBedsIn(map, room) {
    if (!map || !room || !room.cells || !map.buildingAt) return 0;
    var seen = null, n = 0;
    for (var i = 0; i < room.cells.length; i++) {
      var c = room.cells[i];
      var b = map.buildingAt(map.xOf(c), map.yOf(c));
      if (!b || !bedDef(b.def)) continue;
      if (seen === null) seen = {};
      if (seen[b.id]) continue;
      seen[b.id] = 1;
      n++;
      if (n > 1) return n;
    }
    return n;
  }

  function worstSickness(pawn) {
    var h = pawn.health;
    if (!h || !h.hediffs || !h.hediffs.length) return 0;
    var worst = 0;
    for (var i = 0; i < h.hediffs.length; i++) {
      var hd = h.hediffs[i];
      var id = hd.id || (hd.def && hd.def.id) || hd.defId;
      /* health.js already marks the hediffs that make a pawn feel ill by
         hanging the sick thought off the def; the id table is only for a
         hand-made hediff in a test. */
      var disease = (hd.def && (hd.def.thought === 'sick' || hd.def.isDisease)) || DISEASE_HEDIFFS[id];
      if (!disease) continue;
      var sev = typeof hd.severity === 'number' ? hd.severity : 0.3;
      if (sev > worst) worst = sev;
    }
    return worst;
  }

  function outdoorTemp() {
    var G = sys('Game');
    return (G && G.outdoorTemp) ? G.outdoorTemp() : 20;
  }

  /* ---------- mood ---------- */

  /* Worked out once per pass rather than per thought: a psychopath feels
     nothing about a death, and bloodlust shrugs off the corpse. */
  function moodFilter(pawn) {
    return {
      psycho: hasTrait(pawn, 'psychopath'),
      blood: hasTrait(pawn, 'bloodlust')
    };
  }

  function blocked(flags, defId) {
    if (flags.psycho && DEATH_THOUGHTS[defId]) return true;
    return flags.blood && defId === 'observedCorpse';
  }

  function entryMood(t, occurrence) {
    var def = defOfThought(t);
    if (!def) return 0;
    var m = typeof t.moodOverride === 'number' ? t.moodOverride : stageMood(def, t.degree);
    if (m === 0) return 0;
    var stacks = t.stacks > 1 ? t.stacks : 1;
    var f = stackedFactor(def);
    if (stacks > 1) m *= 1 + (stacks - 1) * f;
    if (occurrence > 0) m *= f;
    return m;
  }

  /* Trait mood, minus optimist/pessimist: those two are expressed as the
     naturalMoodBuff/Debuff thoughts so they get their own line in the tab,
     and counting them here as well would double them. */
  function traitMoodTotal(pawn) {
    var tr = pawn.traits;
    if (!tr || !tr.length) return 0;
    var total = 0;
    for (var i = 0; i < tr.length; i++) {
      var id = (tr[i] && tr[i].id) || tr[i];
      if (id === 'optimist' || id === 'pessimist') continue;
      var def = traitDefOf(tr[i]);
      if (def && typeof def.moodOffset === 'number') total += normMood(def.moodOffset);
    }
    return total;
  }

  function recomputeMood(pawn) {
    var list = pawn.thoughts;
    var total = MOOD_BASE + traitMoodTotal(pawn);
    if (list && list.length) {
      var seen = {}, flags = moodFilter(pawn);
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (blocked(flags, t.defId)) continue;
        var occ = seen[t.defId] || 0;
        seen[t.defId] = occ + 1;
        total += entryMood(t, occ);
      }
    }
    pawn.mood = clamp01(total);
    pawn._moodDirty = false;
    return pawn.mood;
  }

  Needs.mood = function (pawn) {
    if (!pawn || !pawn.thoughts) return MOOD_BASE;
    if (pawn._moodDirty || typeof pawn.mood !== 'number') recomputeMood(pawn);
    return pawn.mood;
  };

  Needs.recomputeMood = function (pawn) { return recomputeMood(pawn); };

  Needs.breakdown = function (pawn) {
    var out = [];
    if (!pawn || !pawn.thoughts) return out;

    var list = pawn.thoughts, seen = {}, flags = moodFilter(pawn), i;
    for (i = 0; i < list.length; i++) {
      var t = list[i];
      if (blocked(flags, t.defId)) continue;
      var occ = seen[t.defId] || 0;
      seen[t.defId] = occ + 1;
      var v = entryMood(t, occ);
      if (v === 0) continue;
      var def = defOfThought(t);
      var label = def ? stageLabel(def, t.degree) : t.defId;
      if (t.stacks > 1) label += ' x' + t.stacks;
      out.push({ label: label, value: v, defId: t.defId, stacks: t.stacks });
    }

    var tr = pawn.traits || [];
    for (i = 0; i < tr.length; i++) {
      var id = (tr[i] && tr[i].id) || tr[i];
      if (id === 'optimist' || id === 'pessimist') continue;
      var tdef = traitDefOf(tr[i]);
      if (!tdef || typeof tdef.moodOffset !== 'number') continue;
      var tv = normMood(tdef.moodOffset);
      if (tv === 0) continue;
      out.push({ label: tdef.label || id, value: tv, defId: id, stacks: 1 });
    }

    out.sort(function (a, b) { return Math.abs(b.value) - Math.abs(a.value); });
    /* Baseline leads the list so the column sums to the mood bar. */
    out.unshift({ label: 'Baseline', value: MOOD_BASE, defId: null, stacks: 1, base: true });
    return out;
  };

  /* ---------- break thresholds ---------- */

  Needs.refreshBreakThresholds = function (pawn) {
    var shift = 0, tr = pawn.traits || [];
    for (var i = 0; i < tr.length; i++) {
      var id = (tr[i] && tr[i].id) || tr[i];
      if (BREAK_SHIFT[id]) shift += BREAK_SHIFT[id];
    }
    var minor = U.clamp(Needs.breakBase.minor + shift, 0.08, 0.90);
    var major = U.clamp(Needs.breakBase.major + shift, 0.05, minor - 0.02);
    var extreme = U.clamp(Needs.breakBase.extreme + shift, 0.01, major - 0.02);
    pawn.breakThresholds = { minor: minor, major: major, extreme: extreme };
    return pawn.breakThresholds;
  };

  Needs.breakThresholds = function (pawn) {
    if (!pawn.breakThresholds) Needs.refreshBreakThresholds(pawn);
    return pawn.breakThresholds;
  };

  Needs.breakThreshold = function (pawn, which) {
    var t = Needs.breakThresholds(pawn);
    return t[which || 'minor'];
  };

  /* Which break band the pawn is in right now. think.js decides whether to
     actually break; this only names the line that was crossed. */
  Needs.moodLevel = function (pawn) {
    var m = Needs.mood(pawn), t = Needs.breakThresholds(pawn);
    if (m < t.extreme) return 'extreme';
    if (m < t.major) return 'major';
    if (m < t.minor) return 'minor';
    return 'ok';
  };

  /* ---------- eating ---------- */

  Needs.nutritionOf = function (def) {
    if (!def) return 0;
    if (typeof def.nutrition === 'number') return def.nutrition;
    if (def.food && typeof def.food.nutrition === 'number') return def.food.nutrition;
    return FALLBACK_NUTRITION[def.id] || 0;
  };

  Needs.isFood = function (def) { return Needs.nutritionOf(def) > 0; };

  /* def_things.js tags every edible with foodType: raw / meal / kibble /
     animal. Berries are raw but pleasant, which is the one exception the
     mood system cares about. */
  function isRawFood(def) {
    if (!def) return false;
    if (RAW_TASTY[def.id]) return false;
    if (def.foodType === 'raw' || def.foodType === 'animal') return true;
    return !!RAW_FOOD[def.id];
  }

  function isCookedMeal(def) {
    if (!def) return false;
    if (def.foodType) return def.foodType === 'meal';
    return !!COOKED_MEAL[def.id];
  }

  function isKibble(def) {
    if (!def) return false;
    return def.foodType === 'kibble' || def.id === 'kibble';
  }

  function tableAdjacent(pawn) {
    var map = pawn.map;
    if (!map || !map.buildingAt) return false;
    if (isTable(map.buildingAt(pawn.x, pawn.y))) return true;
    for (var i = 0; i < U.ADJ8.length; i++) {
      var x = pawn.x + U.ADJ8[i][0], y = pawn.y + U.ADJ8[i][1];
      if (!map.inBounds || !map.inBounds(x, y)) continue;
      if (isTable(map.buildingAt(x, y))) return true;
    }
    return false;
  }

  function isTable(b) {
    if (!b || !b.def) return false;
    return buildingFlag(b.def, 'isTable') === true || b.def.id === 'table';
  }

  Needs.eat = function (pawn, thing) {
    if (!pawn || !pawn.needs || !thing) return false;
    var def = thing.def;
    if (!def) {
      var D = sys('Defs');
      def = (D && D.maybe) ? D.maybe('thing', thing.defId) : null;
    }
    var per = Needs.nutritionOf(def);
    if (!(per > 0)) return false;

    var stack = (thing.stack === undefined || thing.stack === null) ? 1 : thing.stack;
    if (stack <= 0) return false;

    /* One unit of a proper meal, or as many berries as it takes to fill
       up. Whole units that FIT, never one more: rounding up would have a
       starving colonist eat two meals and pour most of the second away.
       Capped so nobody swallows a whole stockpile in one sitting. */
    var missing = 1 - pawn.needs.food;
    var units = Math.floor(missing / per);
    if (units < 1) units = 1;
    if (units > 30) units = 30;
    if (units > stack) units = stack;

    pawn.needs.food = clamp01(pawn.needs.food + units * per);
    consume(pawn, thing, units);

    if (isHuman(pawn) && pawn.thoughts) applyMealThoughts(pawn, thing, def);
    pawn.lastAteTick = tickNow();
    return true;
  };

  function consume(pawn, thing, units) {
    var map = pawn.map || thing.map;
    if (thing.stack === undefined || thing.stack === null) thing.stack = 1;
    thing.stack -= units;
    if (thing.stack > 0) return;
    thing.stack = 0;
    if (pawn.carried === thing) pawn.carried = null;
    if (pawn.inventory) U.remove(pawn.inventory, thing);
    if (thing.spawned && map && map.despawnThing) map.despawnThing(thing);
  }

  function applyMealThoughts(pawn, thing, def) {
    var id = def.id || thing.defId;
    var ascetic = hasTrait(pawn, 'ascetic');

    if (isKibble(def)) {
      Needs.addThought(pawn, 'ateKibble');
    } else if (isRawFood(def)) {
      Needs.addThought(pawn, 'ateRawFood');
    } else if (id === 'mealFine') {
      /* An ascetic takes no pleasure in a fancy plate. */
      if (!ascetic) Needs.addThought(pawn, 'ateFineMeal');
    } else if (isCookedMeal(def) && !ascetic && typeof thing.quality === 'number' && thing.quality >= 4) {
      Needs.addThought(pawn, 'hadNiceMeal');
    }

    var room = roomOf(pawn);
    if (tableAdjacent(pawn)) {
      if (room && !room.outdoor && room.role === 'dining' && !ascetic) {
        var b = room.beauty || 0;
        if (b >= 2) Needs.addThought(pawn, 'ateInImpressiveRoom', { degree: b >= 10 ? 2 : (b >= 5 ? 1 : 0) });
      }
    } else if (!ascetic) {
      Needs.addThought(pawn, 'ateWithoutTable');
    }

    rollFoodPoisoning(pawn, thing, def);
  }

  /* A badly cooked meal is the colony's most reliable source of misery.
     Quality runs awful(0)..legendary(6); an unmarked meal is treated as
     normal(3). */
  function rollFoodPoisoning(pawn, thing, def) {
    var chance = 0;
    if (typeof thing.foodPoisonChance === 'number') {
      chance = thing.foodPoisonChance;
    } else if (isCookedMeal(def)) {
      var q = typeof thing.quality === 'number' ? thing.quality : 3;
      chance = U.curve([[0, 0.09], [1, 0.05], [2, 0.03], [3, 0.012], [4, 0.004], [6, 0]], q);
    } else if (isRawFood(def)) {
      chance = 0.01;
    }
    if (!(chance > 0) || !U.chance(chance)) return;

    var H = sys('Health');
    if (H && H.addHediff) H.addHediff(pawn, 'foodPoisoning', 0.06);
    var G = sys('Game');
    if (G && G.msg && pawn.faction === 'player') {
      G.msg(pawnName(pawn) + ' has food poisoning.', { type: 'threat', x: pawn.x, y: pawn.y });
    }
  }

  function pawnName(pawn) {
    var n = pawn.name;
    if (!n) return 'A colonist';
    return n.nick || n.first || 'A colonist';
  }

  function tickNow() {
    var G = sys('Game');
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  /* ---------- what think.js asks ---------- */

  Needs.wantsFood = function (pawn) {
    var n = pawn.needs;
    return !!n && n.food <= Needs.thresholds.hungry;
  };

  Needs.urgentlyHungry = function (pawn) {
    var n = pawn.needs;
    return !!n && n.food <= Needs.thresholds.urgentlyHungry;
  };

  Needs.starving = function (pawn) {
    var n = pawn.needs;
    return !!n && n.food <= 0.0001;
  };

  Needs.wantsSleep = function (pawn) {
    var n = pawn.needs;
    if (!n) return false;
    if (n.rest <= Needs.thresholds.tired) return true;
    if (pawn.drafted) return false;
    /* Outside the tired line a pawn still turns in at bedtime, as long as
       they have room to gain from it. Night owls keep their own hours. */
    var h = hourNow(), owl = hasTrait(pawn, 'nightOwl');
    var night = owl ? (h >= 2 && h < 10) : (h >= 22 || h < 6);
    return night && n.rest < 0.75;
  };

  Needs.veryTired = function (pawn) {
    var n = pawn.needs;
    return !!n && n.rest <= Needs.thresholds.veryTired;
  };

  Needs.wantsJoy = function (pawn) {
    var n = pawn.needs;
    if (!n || pawn.drafted || !isHuman(pawn)) return false;
    if (isAsleep(pawn)) return false;
    return n.joy < Needs.JOY_WANT;
  };

  /* Too long under a roof. think.js can use this for a cabin-fever break;
     it never touches mood on its own. */
  Needs.cabinFever = function (pawn) {
    var n = pawn.needs;
    return !!n && isHuman(pawn) && n.outdoors < Needs.CABIN_FEVER;
  };

  /* ---------- joy ---------- */

  Needs.gainJoy = function (pawn, amount, kind) {
    var n = pawn.needs;
    if (!n || !(amount > 0)) return 0;
    kind = kind || 'idle';
    if (!pawn.joyTolerance) pawn.joyTolerance = {};

    /* The fifth game of horseshoes in a row is worth less than the first. */
    var tol = pawn.joyTolerance[kind] || 0;
    var factor = 1 - tol;
    if (factor < 0.20) factor = 0.20;

    var before = n.joy;
    n.joy = clamp01(before + amount * factor);
    var gained = n.joy - before;

    tol += gained * 1.2;
    pawn.joyTolerance[kind] = tol > 0.80 ? 0.80 : tol;
    pawn.lastJoyKind = kind;
    return gained;
  };

  Needs.joyTolerance = function (pawn, kind) {
    return (pawn.joyTolerance && pawn.joyTolerance[kind]) || 0;
  };

  /* ---------- display helpers ---------- */

  Needs.label = function (needId, value) {
    if (needId === 'food') {
      if (value <= 0.0001) return 'starving';
      if (value < Needs.thresholds.urgentlyHungry) return 'urgently hungry';
      if (value < Needs.thresholds.hungry) return 'hungry';
      return 'fed';
    }
    if (needId === 'rest') {
      if (value <= 0.0001) return 'exhausted';
      if (value < Needs.thresholds.veryTired) return 'very tired';
      if (value < Needs.thresholds.tired) return 'tired';
      return 'rested';
    }
    if (value < 0.15) return 'very low';
    if (value < 0.35) return 'low';
    if (value < 0.7) return 'fine';
    return 'high';
  };

  Needs.moodLabel = function (pawn) {
    var lvl = Needs.moodLevel(pawn);
    if (lvl === 'extreme') return 'about to break';
    if (lvl === 'major') return 'stressed';
    if (lvl === 'minor') return 'unhappy';
    return Needs.mood(pawn) > 0.75 ? 'happy' : 'content';
  };

  root.Needs = Needs;
})(this);
