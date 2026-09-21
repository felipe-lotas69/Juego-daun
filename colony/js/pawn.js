/* ============================================================
   pawn.js - the pawn model: who someone is, how they move, what
   they know, and what is left when they stop.

   Three things are worth knowing before reading the rest.

   One: this file owns the shape of a pawn and almost none of its
   decisions. Health owns the body, Needs owns the mood, Jobs owns
   the work, Think owns the choice, Combat owns the fight. What is
   here is the record they all write into and the per-tick order in
   which they get their turn.

   Two: everything outside this file is reached through a guarded
   lookup. pawn.js sits at position 15 in the load order and half the
   systems it talks to are defined below it, so a missing global is a
   quiet no-op rather than a crash at load. That is also what lets the
   file be exercised on its own.

   Three: movement is measured in ticks, not tiles. Path.stepCost
   answers "how many ticks does this step cost", the pawn's own speed
   factor divides that, and moveProgress walks from 0 to 1 across the
   result. A pawn therefore arrives exactly when the pathfinder said
   it would, which is what keeps a job's estimate honest.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;

  /* Systems defined after this file in the load order. Resolved at call
     time, never at load time. */
  function sys(name) {
    var v = root[name];
    return v === undefined ? null : v;
  }
  function gameTick() {
    var G = root.Game;
    return (G && G.tick) | 0;
  }

  var TICKS_PER_DAY = 60000;
  var TICKS_PER_YEAR = TICKS_PER_DAY * 60;   /* fifteen days a season, four seasons */
  var RARE = 250;
  var IMPASSABLE = 65535;
  var MAX_LEVEL = 20;
  var STEP_EPS = 1e-6;                       /* rounding slack on moveProgress */

  /* ---------- learning ---------- */
  var PASSION_LEARN = [0.35, 1.0, 1.5];
  /* Past level ten a skill is a grind: the same xp buys a fraction of
     what it did, which is why a level 20 shooter is a colony's decision
     and not an afternoon. */
  var LEARN_CURVE = [[0, 1], [10, 1], [13, 0.62], [16, 0.32], [20, 0.12]];
  /* Unpractised expertise rots. Sixty xp per day per level over ten is
     roughly one level a year for a master who never touches the trade. */
  var DECAY_XP_PER_DAY_PER_LEVEL = 60;
  var DECAY_EVERY = RARE * 12;               /* every 3000 ticks, 20 times a day */

  /* ---------- what a trait does to the things pawn.js owns ----------
     Mood traits live in needs.js and combat traits in combat.js; move,
     work, learn and decay are the four this file is responsible for.

     def_pawns.js states all four on the trait def itself, and the def
     always wins. This table is only what a trait falls back to when its
     def is not registered, which is the case in the exercise harnesses
     that load pawn.js without the data files. */
  var TRAIT_FX = {
    jogger:      { move: 1.087 },
    slowpoke:    { move: 0.90 },
    nimble:      { move: 1.05 },
    neurotic:    { work: 1.08 },
    industrious: { work: 1.35 },
    lazy:        { work: 0.80 },
    slothful:    { work: 0.50 },
    toosmart:    { learn: 1.40 },
    greatMemory: { learn: 1.15, decay: 0 }
  };

  /* Traits that answer the same question about a person cannot both be
     true. A def may state its own conflicts; this is the fallback, and
     it is also what keeps a kind psychopath out of the game. */
  var TRAIT_GROUPS = {
    optimist: 'nature', pessimist: 'nature',
    ironWilled: 'nerves', neurotic: 'nerves', volatile: 'nerves',
    industrious: 'drive', lazy: 'drive', slothful: 'drive',
    jogger: 'speed', slowpoke: 'speed',
    tough: 'body', wimp: 'body',
    carefulShooter: 'combatStyle', triggerHappy: 'combatStyle', brawler: 'combatStyle',
    gourmand: 'appetite', ascetic: 'appetite',
    kind: 'temperament', abrasive: 'temperament', psychopath: 'temperament'
  };

  /* Jobs that already are the urgent thing, so the rare-tick review
     leaves them alone. */
  var SETTLED_JOBS = {
    eat: 1, sleep: 1, layDown: 1, attackMelee: 1, attackStatic: 1, flee: 1,
    tendPatient: 1, rescue: 1, carryToBed: 1, extinguishFire: 1,
    mentalWander: 1, mentalTantrum: 1, mentalBerserk: 1, mentalBinge: 1, mentalDaze: 1
  };
  /* Jobs that are only a way of passing time. A goto is not one of them:
     something asked for that walk, and cancelling it halfway across the
     map every rare tick strands the pawn where the walk was going. */
  var IDLE_JOBS = { wander: 1, joyIdle: 1, wait: 1 };
  var RESTING_JOBS = { sleep: 1, layDown: 1, wait: 1 };

  /* The pawnKind ids the contract freezes as animals. Only used when a
     kind def cannot be consulted. */
  var ANIMAL_KINDS = { hare: 1, deer: 1, muffalo: 1, boomrat: 1, wolf: 1, bear: 1 };

  /* ============================================================
     NAMES

     def_pawns.js owns the name lists and publishes them as PawnNames.
     Its shape is not frozen by the contract, so every plausible spelling
     is probed and a small pool here covers the case where the data file
     is not loaded at all.
     ============================================================ */

  var FALLBACK_FIRST_MALE = [
    'Ander', 'Bran', 'Cai', 'Dorn', 'Emil', 'Fyodor', 'Garrick', 'Hale', 'Ivo', 'Joss',
    'Kell', 'Lasso', 'Milo', 'Nikola', 'Osric', 'Pavel', 'Quill', 'Rurik', 'Sten', 'Tobin',
    'Ulf', 'Vance', 'Wray', 'Yuri'
  ];
  var FALLBACK_FIRST_FEMALE = [
    'Ada', 'Bex', 'Cira', 'Dova', 'Elska', 'Fen', 'Greta', 'Hana', 'Ilse', 'Juna',
    'Kira', 'Lys', 'Mira', 'Nadia', 'Orla', 'Pell', 'Quen', 'Rhea', 'Sable', 'Tamsin',
    'Ursa', 'Vesna', 'Wren', 'Yara'
  ];
  var FALLBACK_LAST = [
    'Ashby', 'Brant', 'Calder', 'Drell', 'Esker', 'Falk', 'Grieve', 'Hollis', 'Ives',
    'Kestrel', 'Lowen', 'Marsh', 'Nyx', 'Orme', 'Pike', 'Quarrow', 'Redmane', 'Stark',
    'Thorne', 'Umber', 'Vask', 'Wilder', 'Yarrow', 'Zane'
  ];
  var FALLBACK_NICK = [
    'Ace', 'Bolt', 'Chief', 'Dusty', 'Echo', 'Flint', 'Ghost', 'Hatchet', 'Jinx',
    'Kilo', 'Lucky', 'Moss', 'Nails', 'Patch', 'Rook', 'Scrap', 'Tinker', 'Vex'
  ];

  /* A list may be an array or a function; either is fine to draw from. */
  function drawFrom(source, gender) {
    if (!source) return null;
    if (typeof source === 'function') {
      var v = source(gender);
      return typeof v === 'string' ? v : null;
    }
    if (Array.isArray(source) && source.length) return U.pick(source);
    return null;
  }

  function namesLib() { return sys('PawnNames'); }

  function firstNameFrom(lib, gender) {
    if (!lib) return null;
    var male = gender === 'male';
    return drawFrom(male ? lib.firstMale : lib.firstFemale, gender) ||
           drawFrom(male ? lib.male : lib.female, gender) ||
           drawFrom(lib.first && (lib.first[gender] || lib.first), gender) ||
           drawFrom(lib.given, gender);
  }

  function humanName(gender) {
    var lib = namesLib();

    /* A library that generates the whole name wins outright: it may be
       pairing first and last names on purpose. */
    if (lib) {
      var made = null;
      if (typeof lib.generate === 'function') made = lib.generate(gender);
      else if (typeof lib.human === 'function') made = lib.human(gender);
      else if (typeof lib.randomName === 'function') made = lib.randomName(gender);
      if (made && typeof made === 'object' && made.first) {
        return { first: made.first, nick: made.nick || made.first, last: made.last || '' };
      }
    }

    var first = firstNameFrom(lib, gender) ||
                U.pick(gender === 'male' ? FALLBACK_FIRST_MALE : FALLBACK_FIRST_FEMALE);
    var last = (lib && (drawFrom(lib.last, gender) || drawFrom(lib.surnames, gender) ||
                        drawFrom(lib.family, gender))) || U.pick(FALLBACK_LAST);
    /* Most people go by their first name; a third of a rimworld goes by
       something they earned. */
    var nick = first;
    if (U.chance(0.34)) {
      nick = (lib && (drawFrom(lib.nick, gender) || drawFrom(lib.nicks, gender) ||
                      drawFrom(lib.nicknames, gender))) || U.pick(FALLBACK_NICK);
    }
    return { first: first, nick: nick, last: last };
  }

  /* Animals are counted, not named: the third muffalo you ever met is
     Muffalo #3 forever, which is exactly enough identity to grieve over. */
  var animalCounts = Object.create(null);

  function animalName(kind, kindId) {
    var label = (kind && kind.label) || kindId || 'animal';
    var n = (animalCounts[kindId] || 0) + 1;
    animalCounts[kindId] = n;
    return { first: '', nick: U.cap(label) + ' #' + n, last: '' };
  }

  /* The counter is a module variable, so a loaded save would start it at
     zero and name the next muffalo after one already grazing outside.
     Every restored animal pushes it past its own number instead. */
  function noteAnimalNumber(pawn) {
    if (!pawn || !pawn.isAnimal || !pawn.name) return;
    var m = /#(\d+)\s*$/.exec(pawn.name.nick || '');
    if (!m) return;
    var n = parseInt(m[1], 10);
    if (n > (animalCounts[pawn.kindId] || 0)) animalCounts[pawn.kindId] = n;
  }

  /* ============================================================
     KINDS, BACKSTORIES, TRAITS, SKILLS
     ============================================================ */

  function defMaybe(category, id) {
    var D = root.Defs;
    if (!D || !D.maybe || !id) return null;
    return D.maybe(category, id);
  }
  function defList(category) {
    var D = root.Defs;
    if (!D || !D.all) return [];
    try { return D.all(category) || []; } catch (e) { return []; }
  }

  /* A pawnKind that the def tables do not know about still has to produce
     a usable pawn - pawn.js is loaded and tested before def_pawns.js in
     more than one place - so a minimal stand-in is built instead. */
  function kindOf(kindId) {
    var def = defMaybe('pawnKind', kindId);
    if (def) return def;
    var animal = !!ANIMAL_KINDS[kindId];
    return {
      id: kindId, label: kindId, synthetic: true,
      isAnimal: animal, body: animal ? 'quadruped' : 'human',
      bodySize: animal ? 0.8 : 1, moveSpeed: 1,
      ageRange: animal ? [1, 8] : [19, 55]
    };
  }

  function isAnimalKind(kind, kindId) {
    if (!kind) return !!ANIMAL_KINDS[kindId];
    if (kind.isAnimal !== undefined) return !!kind.isAnimal;
    if (kind.animal !== undefined) return !!kind.animal;
    if (kind.race === 'animal' || kind.raceKind === 'animal') return true;
    if (kind.body && kind.body !== 'human') return true;
    return !!ANIMAL_KINDS[kindId];
  }

  /* Backstory defs carry their slot under one of several names, and an id
     that starts with "child" or "adult" settles the rest. */
  function backstorySlot(def) {
    if (!def) return null;
    var s = def.slot || def.stage || def.bodyType || def.backstorySlot || def.type;
    if (s === 'childhood' || s === 'adulthood') return s;
    if (/^child/i.test(def.id)) return 'childhood';
    if (/^adult/i.test(def.id)) return 'adulthood';
    return null;
  }

  var backstoryCache = null;
  function backstoriesBySlot() {
    if (backstoryCache) return backstoryCache;
    var all = defList('backstory');
    if (!all.length) return { childhood: [], adulthood: [] };
    var out = { childhood: [], adulthood: [] };
    for (var i = 0; i < all.length; i++) {
      var slot = backstorySlot(all[i]);
      if (slot) out[slot].push(all[i]);
    }
    backstoryCache = out;
    return out;
  }

  function pickBackstories(pawn) {
    var pool = backstoriesBySlot();
    var child = pool.childhood.length ? U.pick(pool.childhood) : null;
    /* A pawn who never grew up has no adulthood: colony-born children
       exist, and an adulthood story would be a lie about them. */
    var adult = (pawn.ageYears >= 18 && pool.adulthood.length) ? U.pick(pool.adulthood) : null;
    return { childhood: child ? child.id : null, adulthood: adult ? adult.id : null };
  }

  function traitConflicts(def, chosen) {
    var group = def.exclusionGroup || def.group || TRAIT_GROUPS[def.id] || null;
    var listed = def.conflicts || def.conflictingTraits || null;
    for (var i = 0; i < chosen.length; i++) {
      var other = chosen[i];
      if (other.id === def.id) return true;
      var otherGroup = other.exclusionGroup || other.group || TRAIT_GROUPS[other.id] || null;
      if (group && otherGroup && group === otherGroup) return true;
      if (listed && listed.indexOf(other.id) >= 0) return true;
      var otherListed = other.conflicts || other.conflictingTraits;
      if (otherListed && otherListed.indexOf(def.id) >= 0) return true;
    }
    return false;
  }

  function pickTraits(count) {
    var pool = defList('trait');
    var chosen = [];
    if (!pool.length) return chosen;
    var guard = 0;
    while (chosen.length < count && guard++ < 60) {
      var def = U.pickWeighted(pool, function (t) {
        return t.commonality === undefined ? 1 : Math.max(0, t.commonality);
      });
      if (!def || traitConflicts(def, chosen)) continue;
      chosen.push(def);
    }
    return chosen.map(function (t) { return t.id; });
  }

  /* The four multipliers a pawn's traits hand this file, folded into one
     object. Traits never change after generation, so this is computed
     once per pawn rather than three times a tick through a def lookup
     per trait. */
  function traitFactors(pawn) {
    if (pawn._fx) return pawn._fx;
    var fx = { move: 1, work: 1, learn: 1, decay: 1 };
    var traits = pawn.traits || [];
    for (var i = 0; i < traits.length; i++) {
      var def = defMaybe('trait', traits[i]);
      if (def) {
        if (typeof def.moveSpeedFactor === 'number') fx.move *= def.moveSpeedFactor;
        if (typeof def.workSpeedFactor === 'number') fx.work *= def.workSpeedFactor;
        if (typeof def.learnFactor === 'number') fx.learn *= def.learnFactor;
        if (def.noSkillDecay) fx.decay = 0;
        continue;
      }
      var local = TRAIT_FX[traits[i]];
      if (!local) continue;
      if (local.move) fx.move *= local.move;
      if (local.work) fx.work *= local.work;
      if (local.learn) fx.learn *= local.learn;
      if (local.decay === 0) fx.decay = 0;
    }
    pawn._fx = fx;
    return fx;
  }

  function addGains(into, def) {
    var gains = def && (def.skillGains || def.skillGain);
    if (!gains) return;
    for (var k in gains) into[k] = (into[k] || 0) + (gains[k] | 0);
  }

  function xpToNext(level) { return 1000 * (level + 1); }

  function skillEntry(level) {
    return {
      level: level,
      xp: level >= MAX_LEVEL ? 0 : U.randInt(0, xpToNext(level) - 1),
      passion: 0,
      lastGainTick: 0
    };
  }

  /* A caller who states a skill table - mapgen rolls its own, and save.js
     hands back one that was rolled a hundred days ago - gets exactly that
     table, with any skill it did not mention filled in at zero. Rolling
     first and overwriting afterwards would draw a dozen numbers out of
     the seeded stream and throw them away, which moves every roll made
     after it in the same game. */
  function adoptSkills(pawn, given) {
    var skills = defList('skill');
    var out = {};
    for (var i = 0; i < skills.length; i++) out[skills[i].id] = adoptSkill(given[skills[i].id]);
    /* A skill the registry does not know about still belongs to the pawn
       who arrived carrying it. */
    for (var k in given) if (!out[k]) out[k] = adoptSkill(given[k]);
    pawn.skills = out;
    return out;
  }

  /* A caller may hand over a whole entry or just the level it wants. */
  function adoptSkill(s) {
    if (s && typeof s === 'object') return s;
    var level = typeof s === 'number' ? U.clamp(Math.round(s), 0, MAX_LEVEL) : 0;
    return { level: level, xp: 0, passion: 0, lastGainTick: 0 };
  }

  function rollSkills(pawn) {
    var skills = defList('skill');
    var out = {};
    /* Animals carry their competence on their kind def - combat.js reads
       kind.meleeSkill directly - so an empty table is the honest answer
       and stops a wolf from being a level 0 shooter. */
    if (pawn.isAnimal || !skills.length) { pawn.skills = out; return out; }

    var gains = {};
    addGains(gains, defMaybe('backstory', pawn.backstories.childhood));
    addGains(gains, defMaybe('backstory', pawn.backstories.adulthood));
    for (var t = 0; t < pawn.traits.length; t++) addGains(gains, defMaybe('trait', pawn.traits[t]));

    /* Years count for something: a drifter of forty has picked things up
       that an eighteen year old has not. */
    var maturity = U.clamp((pawn.ageYears - 18) / 22, 0, 1);

    var i, def, base, level;
    for (i = 0; i < skills.length; i++) {
      def = skills[i];
      base = gains[def.id] || 0;
      level = Math.round(base + U.gauss(1.3 + 3.4 * maturity, 2.6, -3, 10));
      /* A trade nobody trained you in is usually a trade you do not have. */
      if (base <= 0 && U.chance(0.35)) level -= 3;
      level = U.clamp(level, 0, MAX_LEVEL);
      out[def.id] = skillEntry(level);
    }

    assignPassions(out, skills);
    pawn.skills = out;
    return out;
  }

  /* Roughly one skill in five burns a little and one in twelve burns
     hard, capped so that nobody rolls a prodigy at everything. */
  function assignPassions(table, skills) {
    var order = U.shuffle(skills.slice());
    var majors = 0, total = 0;
    for (var i = 0; i < order.length; i++) {
      var s = table[order[i].id];
      if (!s) continue;
      if (total >= 6) break;
      var r = U.rand();
      if (r < 1 / 12 && majors < 3) { s.passion = 2; majors++; total++; }
      else if (r < 1 / 12 + 1 / 5) { s.passion = 1; total++; }
    }
  }

  function disabledWorkFor(pawn) {
    var out = {};
    var sources = [
      defMaybe('backstory', pawn.backstories.childhood),
      defMaybe('backstory', pawn.backstories.adulthood)
    ];
    for (var t = 0; t < pawn.traits.length; t++) sources.push(defMaybe('trait', pawn.traits[t]));
    for (var i = 0; i < sources.length; i++) {
      var list = sources[i] && (sources[i].disabledWork || sources[i].disabledWorkTypes);
      if (!list) continue;
      for (var k = 0; k < list.length; k++) out[list[k]] = true;
    }
    return out;
  }

  function buildWorkPriorities(pawn) {
    var types = defList('workType');
    var out = {};
    if (pawn.isAnimal || !types.length) { pawn.workPriority = out; return out; }

    var disabled = disabledWorkFor(pawn);
    for (var i = 0; i < types.length; i++) {
      var wt = types[i];
      if (disabled[wt.id]) { out[wt.id] = 0; continue; }
      out[wt.id] = 3;
      /* Somebody who loves the work should be found doing it before
         somebody who merely can. */
      var list = wt.skills || wt.relevantSkills;
      if (!list) continue;
      for (var k = 0; k < list.length; k++) {
        var s = pawn.skills[list[k]];
        if (s && s.passion >= 1) { out[wt.id] = 2; break; }
      }
    }
    pawn.workPriority = out;
    return out;
  }

  /* ============================================================
     THE PAWN
     ============================================================ */

  function Pawn(kindId, faction, opts) {
    opts = opts || {};
    var kind = kindOf(kindId);

    this.id = U.nextId();
    this.kindId = kindId;
    this.kind = kind;
    this.isAnimal = isAnimalKind(kind, kindId);
    this.isHuman = !this.isAnimal;
    this.faction = faction || kind.defaultFaction || (this.isAnimal ? 'wild' : 'neutral');

    this.gender = opts.gender || (U.chance(0.5) ? 'male' : 'female');

    var range = kind.ageRange || (this.isAnimal ? [1, 8] : [19, 58]);
    this.ageYears = opts.ageYears !== undefined
      ? opts.ageYears
      : Math.round(U.gauss((range[0] + range[1]) / 2, (range[1] - range[0]) / 4, range[0], range[1]));
    this.ageTicks = Math.round(this.ageYears * TICKS_PER_YEAR);

    this.name = opts.name || (this.isAnimal ? animalName(kind, kindId) : humanName(this.gender));

    /* Position. fx/fy are the drawing position and only ever differ from
       x/y while a step is in progress. */
    this.map = opts.map || null;
    this.x = opts.x | 0;
    this.y = opts.y | 0;
    this.fx = this.x;
    this.fy = this.y;
    this.dir = 2;

    this.path = null;
    this.pathIdx = 0;
    this.moveProgress = 0;
    this.destX = -1;
    this.destY = -1;
    this.pathDest = -1;
    this.pathMode = 0;
    this._pathFails = 0;

    this.job = null;
    this.driver = null;
    this.jobQueue = [];
    this.lastJobEndTick = 0;
    this._thinkDelay = 0;

    /* Who they are. Traits come before Needs.create, which caches them. */
    this.backstories = this.isAnimal
      ? { childhood: null, adulthood: null }
      : (opts.backstories || pickBackstories(this));
    this.traits = this.isAnimal ? [] : (opts.traits || pickTraits(U.chance(0.4) ? 3 : 2));
    this._fx = null;
    if (opts.skills && !this.isAnimal) adoptSkills(this, opts.skills);
    else rollSkills(this);
    buildWorkPriorities(this);

    this.equipment = null;
    this.apparel = [];
    this.inventory = [];
    this.carried = null;
    this.ownedBedId = null;

    this.drafted = false;
    this.draftTarget = null;

    this.tame = opts.tame !== undefined ? !!opts.tame : (this.isAnimal && this.faction === 'player');
    this.trainedLevels = this.isAnimal ? { obedience: 0, release: 0 } : null;
    this.master = null;
    this.manhunter = false;
    this.designated = null;

    this.stanceTicks = 0;
    this.aimTarget = null;
    this.lastAttackTick = 0;
    this.canBashDoors = false;
    this.asleep = false;
    this.prisoner = false;
    this.mentalState = null;
    this.dead = false;
    this.downed = false;
    this.deadTick = 0;
    this.spawnTick = gameTick();
    this._tickCount = 0;
    this._rareCount = 0;
    this._deathDone = false;

    var H = sys('Health');
    if (H && H.create) H.create(this);
    var N = sys('Needs');
    if (N && N.create) N.create(this);

    if (opts.map && opts.gear === true) this.equipKindGear();
  }

  /* ============================================================
     MOVEMENT
     ============================================================ */

  function dirTo(dx, dy) {
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 1 : 3;
    if (dy !== 0) return dy > 0 ? 2 : 0;
    return -1;
  }

  Pawn.prototype.faceTo = function (x, y) {
    var d = dirTo(x - this.x, y - this.y);
    if (d >= 0) this.dir = d;
    return this.dir;
  };

  Pawn.prototype.stopPath = function () {
    this.path = null;
    this.pathIdx = 0;
    this.moveProgress = 0;
    this.pathDest = -1;
    this.fx = this.x;
    this.fy = this.y;
  };

  Pawn.prototype.moving = function () {
    return !!(this.path && this.pathIdx < this.path.length);
  };

  /* Ask for a route and keep it. `pe` is a Path.PE mode, or an options
     object when a caller needs more than the end mode. Returns false when
     there is no way there, which is a job failure, not an exception. */
  Pawn.prototype.startPath = function (destX, destY, pe) {
    var map = this.map, Path = sys('Path');
    if (!map || !Path || this.dead || this.downed) return false;
    destX = destX | 0; destY = destY | 0;
    if (!map.inBounds(destX, destY)) return false;

    var opts;
    if (pe && typeof pe === 'object') {
      opts = { pawn: this };
      for (var k in pe) opts[k] = pe[k];
      opts.pawn = this;
    } else {
      opts = { pawn: this, peMode: pe === undefined || pe === null ? 0 : (pe | 0) };
    }
    if (opts.avoidFire === undefined) opts.avoidFire = !this.manhunter;

    var path = Path.find(map, this.x, this.y, destX, destY, opts);
    if (!path) return false;

    this.destX = destX;
    this.destY = destY;
    this.pathMode = (opts.peMode !== undefined ? opts.peMode : opts.pe) | 0;
    this.pathDest = map.idx(destX, destY);
    this.moveProgress = 0;
    this.pathIdx = 0;
    this._pathFails = 0;

    /* An empty path means the pawn is already standing somewhere that
       satisfies the end mode. That is an arrival, not a failure. */
    if (!path.length) { this.path = null; this.fx = this.x; this.fy = this.y; return true; }
    this.path = path;
    this.faceTo(map.xOf(path[0]), map.yOf(path[0]));
    return true;
  };

  /* How fast this pawn covers ground, as a multiplier on the pathfinder's
     tick costs. Terrain is already inside those costs, so it is absent
     here on purpose. */
  Pawn.prototype.moveSpeedFactor = function () {
    var kind = this.kind, f = 1;
    var ks = kind && (kind.moveSpeed !== undefined ? kind.moveSpeed : kind.moveSpeedFactor);
    if (typeof ks === 'number' && ks > 0) {
      /* A kind may state a factor (1.0) or an outright speed in tiles per
         second (4.6 is the pawn baseline); anything past 2.5 can only be
         the latter. */
      f *= ks > 2.5 ? ks / 4.6 : ks;
    }

    f *= traitFactors(this).move;

    var H = sys('Health');
    if (H && H.moveSpeedFactor) f *= H.moveSpeedFactor(this);

    /* Weight slows a hauler down once the load passes what the body can
       comfortably manage. */
    var cap = this.carryCapacity;
    var mass = this.mass;
    if (mass > cap && cap > 0) f *= U.clamp(1 - ((mass - cap) / cap) * 0.5, 0.35, 1);

    if (this.mentalState && this.mentalState.id === 'panicFlee') f *= 1.2;
    return f > 0 ? f : 0;
  };

  /* One tick of walking. Returns true while the pawn is still on a path. */
  Pawn.prototype.tickMove = function () {
    if (!this.path || this.pathIdx >= this.path.length) return false;
    var map = this.map, Path = sys('Path');
    if (!map || !Path) { this.stopPath(); return false; }
    if (this.dead || this.downed) { this.stopPath(); return false; }

    var next = this.path[this.pathIdx];
    var nx = map.xOf(next), ny = map.yOf(next);
    var fromI = map.idx(this.x, this.y);
    var cost = Path.stepCost(map, fromI, next, this);
    if (cost >= IMPASSABLE) return this.onStepBlocked();

    var speed = this.moveSpeedFactor();
    if (speed <= 0.001) return true;           /* alive, on a path, and going nowhere */

    if (this.moveProgress === 0) this.faceTo(nx, ny);

    var ticks = cost / speed;
    if (ticks < 1) ticks = 1;                  /* never more than one tile per tick */
    this.moveProgress += 1 / ticks;

    /* Thirteen additions of 1/13 land a hair under 1 in binary, and
       without the tolerance every orthogonal step would quietly cost a
       fourteenth tick - a seven per cent tax on every walk in the game,
       and an arrival the pathfinder's estimate no longer matches. */
    if (this.moveProgress < 1 - STEP_EPS) {
      this.fx = this.x + (nx - this.x) * this.moveProgress;
      this.fy = this.y + (ny - this.y) * this.moveProgress;
      return true;
    }

    var oldX = this.x, oldY = this.y;
    this.x = nx; this.y = ny;
    this.fx = nx; this.fy = ny;
    this.moveProgress = 0;
    this.pathIdx++;
    this._pathFails = 0;
    if (map.notePawnMoved) map.notePawnMoved(this, oldX, oldY);

    if (this.pathIdx >= this.path.length) {
      this.path = null;
      this.pathDest = -1;
      return false;
    }
    return true;
  };

  /* A wall went up, a door was locked, or something else closed the way
     between one tick and the next. One fresh route is fair; a second
     failure means the job was built on a world that no longer exists. */
  Pawn.prototype.onStepBlocked = function () {
    if (this._pathFails === 0 && this.destX >= 0) {
      var dx = this.destX, dy = this.destY, mode = this.pathMode;
      this.path = null;
      if (this.startPath(dx, dy, mode)) { this._pathFails = 1; return true; }
    }
    this._pathFails = 0;
    this.stopPath();
    var J = sys('Jobs');
    if (this.job && J && J.end) J.end(this, 'failed');
    return false;
  };

  /* ============================================================
     THE TICK

     Order matters. A pawn that died to bleeding does not then swing a
     hammer; a pawn whose job was cancelled does not then walk the rest
     of its path; a pawn who is about to break down does not get asked
     for a fifth stack of steel first.
     ============================================================ */

  Pawn.prototype.tick = function () {
    if (this.dead) return;
    if (!this.map) return;
    this._tickCount++;

    if (this.downed) { this.tickDowned(); return; }

    this.tickStance();
    this.tickMental();

    if (!this.job) this.tickThink();

    var J = sys('Jobs');
    if (this.job && J && J.tick) J.tick(this);

    /* The driver may have started, replaced or cancelled a path this
       tick; walking after it is what makes goto a single toil. */
    if (!this.dead && !this.downed) this.tickMove();

    this.tickCondition();
  };

  /* Flat on the ground: no work, no walking, and no second chance at the
     job that was interrupted. Needs and health still run, because
     bleeding out while nobody comes is the point of being downed. */
  Pawn.prototype.tickDowned = function () {
    if (this.moving()) this.stopPath();
    var J = sys('Jobs');
    if (this.job && !RESTING_JOBS[this.job.defId] && J && J.end) J.end(this, 'interrupted');
    /* think.js ends a mental state the moment its owner goes down, and
       this hook is the only way it hears about the tick, so a pawn who
       broke and then collapsed would otherwise wake up still berserk. */
    this.tickMental();
    if (!this.job) this.tickThink();
    if (this.job && J && J.tick) J.tick(this);
    this.tickCondition();
  };

  /* think.js hangs its rare-tick break check and its abandon-the-job
     review off this hook, so it has to reach think.js every tick for
     every live pawn, downed ones included. */
  Pawn.prototype.tickMental = function () {
    var Think = sys('Think');
    if (Think && Think.tickMental) Think.tickMental(this);
    else this.tickMentalFallback();
  };

  /* combat.js runs its own stance machine and decrements stanceTicks from
     inside tryAttack, so this only drains a stance nothing is driving -
     a shooter whose target died, or a stance restored from a save. */
  Pawn.prototype.tickStance = function () {
    if (this.stanceTicks <= 0) return;
    var C = sys('Combat');
    if (C && C.stanceOf && C.stanceOf(this)) return;
    this.stanceTicks--;
    if (this.stanceTicks <= 0) {
      this.stanceTicks = 0;
      this.aimTarget = null;
    }
  };

  /* Without think.js a state still has to end, or the first breakdown
     of the game is the last thing that pawn ever does. */
  Pawn.prototype.tickMentalFallback = function () {
    var ms = this.mentalState;
    if (!ms) return;
    if (ms.ticksLeft === undefined) return;
    if (--ms.ticksLeft <= 0) this.mentalState = null;
  };

  Pawn.prototype.tickThink = function () {
    if (this._thinkDelay > 0) { this._thinkDelay--; return; }
    var Think = sys('Think'), J = sys('Jobs');
    if (!Think || !Think.think || !J || !J.start) { this._thinkDelay = 30; return; }
    var job = Think.think(this);
    if (job) { J.start(this, job); this._thinkDelay = 0; return; }
    /* Nothing to do this instant. Rescanning every tick would put a work
       scan on every idle colonist sixty times a second for no gain. */
    this._thinkDelay = 15;
  };

  /* Needs and health carry their own staggered rare tick inside, so they
     are fed every tick and decide for themselves when the expensive part
     runs. What is staggered here is this file's own slow work. */
  Pawn.prototype.tickCondition = function () {
    var N = sys('Needs');
    if (N && N.tick) N.tick(this);
    var H = sys('Health');
    if (H && H.tick) H.tick(this);
    if (this.dead) return;

    if (((this._tickCount + this.id) % RARE) !== 0) return;
    this._rareCount++;
    this.tickRare();
  };

  Pawn.prototype.tickRare = function () {
    this.ageTicks += RARE;
    if (this.ageTicks >= (this.ageYears + 1) * TICKS_PER_YEAR) {
      this.ageYears = Math.floor(this.ageTicks / TICKS_PER_YEAR);
    }

    if (this.isHuman && (this._rareCount % 12) === 0) this.decaySkills(DECAY_EVERY);

    /* An animal's own rare work - manhunter cooldown, designations,
       breeding - hangs off Animals.tickRare, which animals.js otherwise
       only reaches through Animals.think. An animal with a job in hand
       is never asked to think, so without this call a manhunter muffalo
       stays a manhunter for the rest of the game. Both callers share one
       250-tick stamp, so whichever arrives first does the work. */
    if (this.isAnimal) {
      var A = sys('Animals');
      if (A && A.tickRare) A.tickRare(this);
    }

    /* think.js runs the abandon check itself, from tickMental, with the
       tier rules that decide what actually outranks what. Doing it again
       here would cancel jobs it had just decided to keep. */
    var Think = sys('Think');
    if (Think && Think.tickMental) return;

    if (this.shouldRethink()) {
      var J = sys('Jobs');
      if (J && J.end) J.end(this, 'interrupted');
      this._thinkDelay = 0;
    }
  };

  /* Is the pawn busy with the wrong thing? think.js owns this question
     and answers it by comparing job tiers; what is left here is the
     answer for a build without it - a player order stands, a fight
     stands, and eating stands, but loitering does not survive contact
     with a colonist who is about to starve. */
  Pawn.prototype.shouldRethink = function () {
    var Think = sys('Think');
    if (Think && Think.shouldAbandonJob) return !!Think.shouldAbandonJob(this);

    var job = this.job;
    if (!job || job.playerForced || this.drafted || this.mentalState) return false;
    if (SETTLED_JOBS[job.defId]) return false;

    var N = sys('Needs');
    if (N) {
      if (N.urgentlyHungry && N.urgentlyHungry(this)) return true;
      if (N.veryTired && N.veryTired(this)) return true;
    }
    return !!IDLE_JOBS[job.defId];
  };

  /* ============================================================
     SKILLS
     ============================================================ */

  Pawn.prototype.skillLevel = function (skillId) {
    var s = this.skills && this.skills[skillId];
    if (s) return s.level;
    /* An animal's competence lives on its kind, which is where combat.js
       looks for it too. */
    var kind = this.kind;
    if (kind) {
      if (skillId === 'melee' && kind.meleeSkill !== undefined) return kind.meleeSkill;
      if (kind.combatPower !== undefined) return U.clamp(Math.round(kind.combatPower / 20), 1, 12);
    }
    return 0;
  };

  Pawn.prototype.passionOf = function (skillId) {
    var s = this.skills && this.skills[skillId];
    return s ? (s.passion | 0) : 0;
  };

  Pawn.prototype.learnFactor = function () {
    return traitFactors(this).learn;
  };

  /* Grant experience. The passion multiplier, the above-ten grind and the
     level-up loop all live here so that every system in the game teaches
     a skill at the same rate. Returns the xp actually banked. */
  Pawn.prototype.learn = function (skillId, xp) {
    if (!(xp > 0) || this.dead) return 0;
    var s = this.skills && this.skills[skillId];
    if (!s) return 0;

    var gain = xp * PASSION_LEARN[s.passion | 0] * this.learnFactor() *
               U.curve(LEARN_CURVE, s.level);
    if (!(gain > 0)) return 0;

    s.xp += gain;
    s.lastGainTick = gameTick();
    while (s.level < MAX_LEVEL && s.xp >= xpToNext(s.level)) {
      s.xp -= xpToNext(s.level);
      s.level++;
    }
    if (s.level >= MAX_LEVEL) {
      s.level = MAX_LEVEL;
      s.xp = Math.min(s.xp, xpToNext(MAX_LEVEL - 1));
    }
    return gain;
  };

  Pawn.prototype.gainXp = function (skillId, xp) { return this.learn(skillId, xp); };

  /* Expertise that is never exercised slips. Only above level ten, only
     for skills the pawn has not used in a while, and slowly enough that
     it reads as a reason to keep a cook cooking rather than a punishment. */
  Pawn.prototype.decaySkills = function (ticks) {
    if (traitFactors(this).decay === 0) return;

    var now = gameTick();
    for (var id in this.skills) {
      var s = this.skills[id];
      if (s.level <= 10) continue;
      if (now - (s.lastGainTick || 0) < TICKS_PER_DAY) continue;
      s.xp -= DECAY_XP_PER_DAY_PER_LEVEL * (s.level - 10) * (ticks / TICKS_PER_DAY);
      /* Falling below zero xp costs the level, and the guard above means
         the level being spent is always one above ten. */
      if (s.xp < 0) { s.level--; s.xp += xpToNext(s.level); }
    }
  };

  /* The contract's one number for how fast skill makes work go: level 0
     is 0.4x, level 20 is 2.0x. Health and traits are deliberately not in
     here, because every caller applies those itself; workRate is the one
     that puts all three together. */
  Pawn.prototype.workSpeed = function (skillId) {
    return 0.4 + 0.08 * this.skillLevel(skillId);
  };

  Pawn.prototype.workFactor = function () {
    return traitFactors(this).work;
  };

  /* traitFactors memoises onto pawn._fx, which is right for traits (they
     are rolled once and never change) but wrong for anything that edits
     the list later - a gene implant, an ideoligion granting a trait, a
     brain injury. Anything that touches pawn.traits calls this. */
  Pawn.prototype.invalidateTraitCache = function () {
    this._fx = null;
    return this;
  };

  Pawn.prototype.workRate = function (skillId) {
    var f = this.workSpeed(skillId) * this.workFactor();
    var H = sys('Health');
    if (H && H.workSpeedFactor) f *= H.workSpeedFactor(this);
    return f > 0 ? f : 0;
  };

  Pawn.prototype.priorityOf = function (workTypeId) {
    var p = this.workPriority && this.workPriority[workTypeId];
    return p === undefined ? 0 : p;
  };

  /* Can this pawn be given this kind of work at all - enabled in the work
     tab, human, awake, and with hands enough to hold a tool. */
  Pawn.prototype.capable = function (workTypeId) {
    if (this.isAnimal || this.dead || this.downed) return false;
    if (this.priorityOf(workTypeId) <= 0) return false;
    var H = sys('Health');
    if (H && H.capacity) {
      if (H.capacity(this, 'consciousness') < 0.3) return false;
      var wt = defMaybe('workType', workTypeId);
      var needsHands = !wt || wt.requiresManipulation !== false;
      if (needsHands && H.capacity(this, 'manipulation') < 0.2) return false;
    }
    return true;
  };

  /* ============================================================
     EQUIPMENT, APPAREL, CARRYING
     ============================================================ */

  function unspawn(thing, map) {
    if (!thing) return;
    if (thing.spawned && map && map.despawnThing) map.despawnThing(thing);
    thing.spawned = false;
  }

  /* def_things.js states which body slots a garment covers but not which
     layer it sits on, and the six apparel ids in the registry are known,
     so the layer lives here rather than being invented in the data.

     Every torso garment on one layer would be the simpler table and the
     wrong one: jacket, parka and vest all cover the torso, so a vest and
     a coat could never be worn together and dressing a raider for the
     cold would silently take their armour off. art.js already draws the
     vest in a slot of its own, over the shirt and under the coat, which
     is the layering this matches. */
  var APPAREL_LAYER = {
    shirt: 'onSkin', pants: 'onSkin',
    armorVest: 'middle',
    jacket: 'shell', parka: 'shell',
    helmet: 'overhead'
  };

  function apparelLayer(def) {
    if (!def) return 'middle';
    var a = def.apparel;
    return (a && a.layer) || APPAREL_LAYER[def.id] || 'middle';
  }

  function putOnGround(thing, map, x, y) {
    if (!thing || !map) return false;
    var tx = x, ty = y;
    if (!map.inBounds(tx, ty) || !map.passable(tx, ty)) {
      var free = map.freeNeighbour ? map.freeNeighbour(x, y) : null;
      if (free) { tx = free.x; ty = free.y; }
    }
    if (!map.inBounds(tx, ty)) return false;
    /* moveThing registers and places it, and placing is what sets
       spawned; setting it first only makes moveThing unplace a thing
       that is not on the grids. */
    return map.moveThing(thing, tx, ty) !== false;
  }

  Pawn.prototype.equip = function (thing) {
    if (!thing) return false;
    if (this.equipment === thing) return true;
    if (this.equipment) this.dropEquipment();
    unspawn(thing, this.map);
    thing.faction = this.faction;
    this.equipment = thing;
    return true;
  };

  Pawn.prototype.dropEquipment = function (x, y) {
    var t = this.equipment;
    if (!t) return null;
    this.equipment = null;
    putOnGround(t, this.map, x === undefined ? this.x : x, y === undefined ? this.y : y);
    return t;
  };

  Pawn.prototype.wear = function (apparel) {
    if (!apparel || !apparel.def || !apparel.def.apparel) return false;
    var slots = apparel.def.apparel.slots || [];
    var layer = apparelLayer(apparel.def);
    /* Clothes stack by layer: a shirt under a vest under a parka is
       fine, a parka over a jacket is not, and nobody wears two shirts. */
    for (var i = this.apparel.length - 1; i >= 0; i--) {
      var worn = this.apparel[i];
      if (apparelLayer(worn.def) !== layer) continue;
      var wornSlots = (worn.def.apparel && worn.def.apparel.slots) || [];
      var clash = false;
      for (var k = 0; k < slots.length; k++) {
        if (wornSlots.indexOf(slots[k]) >= 0) { clash = true; break; }
      }
      if (clash) this.removeApparel(worn);
    }
    unspawn(apparel, this.map);
    apparel.faction = this.faction;
    this.apparel.push(apparel);
    var H = sys('Health');
    if (H && H.invalidate) H.invalidate(this);
    return true;
  };

  Pawn.prototype.removeApparel = function (apparel, x, y) {
    if (!apparel || !U.remove(this.apparel, apparel)) return null;
    putOnGround(apparel, this.map, x === undefined ? this.x : x, y === undefined ? this.y : y);
    var H = sys('Health');
    if (H && H.invalidate) H.invalidate(this);
    return apparel;
  };

  Pawn.prototype.wearingSlot = function (slot) {
    for (var i = 0; i < this.apparel.length; i++) {
      var a = this.apparel[i].def.apparel;
      if (a && a.slots && a.slots.indexOf(slot) >= 0) return this.apparel[i];
    }
    return null;
  };

  /* Pick a thing up into the hands. A count smaller than the stack splits
     it first, which is how a hauler takes twenty of a pile of seventy. */
  Pawn.prototype.carry = function (thing, count) {
    if (!thing) return false;
    if (this.carried && this.carried !== thing) this.dropCarried();
    var map = this.map;
    var take = thing;
    if (count !== undefined && count > 0 && count < thing.stack && map && map.splitStack) {
      take = map.splitStack(thing, count);
      if (!take) return false;
    }
    unspawn(take, map);
    this.carried = take;
    return true;
  };

  Pawn.prototype.dropCarried = function (x, y) {
    var t = this.carried;
    if (!t) return null;
    this.carried = null;
    var map = this.map;
    var tx = x === undefined ? this.x : x;
    var ty = y === undefined ? this.y : y;
    if (!map) return t;

    /* Merge into what is already lying there rather than leaving two
       stacks of steel on one tile. mergeInto takes what it can and
       subtracts it from the carried stack, so only an emptied stack is
       finished with: a partial pour still has a remainder to put down,
       and returning early here would delete it. */
    if (map.itemOfDefAt && map.mergeInto) {
      var existing = map.itemOfDefAt(tx, ty, t.defId);
      if (existing && existing !== t) {
        map.mergeInto(t, existing);
        if (t.stack <= 0) return existing;
      }
    }
    putOnGround(t, map, tx, ty);
    return t;
  };

  Pawn.prototype.addToInventory = function (thing) {
    if (!thing) return false;
    unspawn(thing, this.map);
    this.inventory.push(thing);
    return true;
  };

  Pawn.prototype.dropInventory = function (thing, x, y) {
    if (!thing || !U.remove(this.inventory, thing)) return null;
    putOnGround(thing, this.map, x === undefined ? this.x : x, y === undefined ? this.y : y);
    return thing;
  };

  Pawn.prototype.dropAll = function (x, y) {
    var tx = x === undefined ? this.x : x, ty = y === undefined ? this.y : y;
    this.dropCarried(tx, ty);
    this.dropEquipment(tx, ty);
    while (this.inventory.length) this.dropInventory(this.inventory[0], tx, ty);
  };

  /* Weapons and clothes a raider or a wild animal should arrive with. The
     kind names the ids; this is only the wiring, and mapgen decides
     whether to use it. */
  Pawn.prototype.equipKindGear = function () {
    var map = this.map, kind = this.kind;
    if (!map || !kind || !map.spawnThing) return false;
    var made = false;
    if (kind.weapons && kind.weapons.length) {
      var w = map.spawnThing(U.pick(kind.weapons), this.x, this.y);
      if (w) { this.equip(w); made = true; }
    }
    if (kind.apparel && kind.apparel.length) {
      for (var i = 0; i < kind.apparel.length; i++) {
        var a = map.spawnThing(kind.apparel[i], this.x, this.y);
        if (a) { this.wear(a); made = true; }
      }
    }
    return made;
  };

  /* ============================================================
     DRAFTING
     ============================================================ */

  Pawn.prototype.draft = function () {
    if (this.drafted || this.isAnimal || this.dead) return false;
    if (this.faction !== 'player') return false;
    this.drafted = true;
    this.draftTarget = null;
    this.endJob('interrupted');
    this.stopPath();
    return true;
  };

  Pawn.prototype.undraft = function () {
    if (!this.drafted) return false;
    this.drafted = false;
    this.draftTarget = null;
    this.endJob('interrupted');
    this.stopPath();
    var C = sys('Combat');
    if (C && C.clearStance) C.clearStance(this);
    return true;
  };

  Pawn.prototype.toggleDraft = function () {
    return this.drafted ? this.undraft() : this.draft();
  };

  Pawn.prototype.endJob = function (reason) {
    var J = sys('Jobs');
    if (this.job && J && J.end) { J.end(this, reason || 'interrupted'); return true; }
    this.job = null;
    this.driver = null;
    this.lastJobEndTick = gameTick();
    return false;
  };

  /* ============================================================
     DEATH
     ============================================================ */

  Pawn.prototype.die = function (cause) {
    if (this._deathDone) return false;
    var H = sys('Health');
    /* Health owns the dying: it sets the flags, drops what was held and
       calls back into Pawn.onDeath for the world-facing half. */
    if (H && H.kill && !(this.health && this.health.dead)) { H.kill(this, cause); return true; }
    Pawn.onDeath(this, cause);
    return true;
  };

  /* Everything that has to happen to the map and to the colony when a
     pawn stops. Called by Health.kill, and directly when health.js is
     not loaded. Safe to call twice. */
  Pawn.onDeath = function (pawn, cause) {
    if (!pawn || pawn._deathDone) return;
    pawn._deathDone = true;
    pawn.dead = true;
    pawn.downed = false;
    pawn.drafted = false;
    pawn.draftTarget = null;
    pawn.aimTarget = null;
    pawn.stanceTicks = 0;
    pawn.mentalState = null;
    pawn.asleep = false;
    pawn.deadTick = gameTick();
    pawn.stopPath();

    var map = pawn.map;
    var wasColonist = pawn.isHuman && pawn.faction === 'player' && !pawn.prisoner;
    var deathName = pawn.fullName();

    var J = sys('Jobs');
    if (pawn.job && J && J.end) J.end(pawn, 'failed');
    pawn.job = null;
    pawn.driver = null;
    pawn.jobQueue.length = 0;
    var R = sys('Res');
    if (R && R.releaseAll) R.releaseAll(pawn);
    var C = sys('Combat');
    if (C && C.clearStance) C.clearStance(pawn);

    if (map) {
      pawn.dropAll(pawn.x, pawn.y);
      var corpse = map.spawnThing ? map.spawnThing('corpse', pawn.x, pawn.y, {
        corpse: {
          name: deathName, kindId: pawn.kindId, faction: pawn.faction,
          rotTicks: 0, pawnId: pawn.id
        }
      }) : null;
      /* Apparel moves onto the corpse rather than onto the floor -
         health.js leaves it here for exactly that, and save.js packs
         corpse.apparel back out again - so stripping the dead stays a
         job somebody has to do. With no corpse to carry them the clothes
         go on the ground, because the alternative is losing them. */
      if (pawn.apparel.length) {
        if (corpse) {
          corpse.apparel = pawn.apparel.slice();
          pawn.apparel.length = 0;
        } else {
          while (pawn.apparel.length) pawn.removeApparel(pawn.apparel[0], pawn.x, pawn.y);
        }
      }
      if (map.addBlood) map.addBlood(pawn.x, pawn.y, 120);
      if (map.removePawn) map.removePawn(pawn);
      else U.remove(map.pawns, pawn);

      spreadDeathThoughts(pawn, map, wasColonist);
    }

    var G = sys('Game');
    if (!G) return;
    if (wasColonist) {
      G.letter(deathName + ' has died',
        deathName + ' died of ' + (cause || 'unknown causes') + '. ' +
        'Bury the body before the colony has to keep walking past it.',
        { kind: 'death', x: pawn.x, y: pawn.y });
    } else if (pawn.faction === 'player') {
      G.msg(deathName + ' has died.', { type: 'info', x: pawn.x, y: pawn.y });
    }
  };

  /* Who saw it, and what it did to them. A colony mourns its own wherever
     they were standing; anybody close enough to watch carries the sight
     around for a few days on top of that. */
  function spreadDeathThoughts(pawn, map, wasColonist) {
    var N = sys('Needs');
    if (!N || !N.addThought) return;
    var list = map.pawns, i, other;
    for (i = 0; i < list.length; i++) {
      other = list[i];
      if (other === pawn || other.dead || !other.isHuman) continue;
      if (other.faction !== 'player') continue;

      if (wasColonist) N.addThought(other, 'colonistDied', { otherPawnId: pawn.id });
      var near = U.dist(other.x, other.y, pawn.x, pawn.y) <= 14;
      if (near && (wasColonist || pawn.faction === 'player')) {
        N.addThought(other, 'witnessedDeathAlly', { otherPawnId: pawn.id });
      }
      /* killedHumanBloodlust belongs to whoever swung, and combat.js
         knows who that was; a death has no instigator by the time it
         reaches here, so handing it to every bloodlust colonist in
         sight would be the wrong pawn and a second copy of the thought. */
    }
  }

  /* ============================================================
     LABELS AND READOUTS
     ============================================================ */

  Pawn.prototype.label = function () {
    var n = this.name;
    if (!n) return this.kind.label || this.kindId;
    return n.nick || n.first || n.last || this.kind.label || this.kindId;
  };

  Pawn.prototype.fullName = function () {
    var n = this.name;
    if (!n) return this.kind.label || this.kindId;
    if (this.isAnimal || !n.first) return n.nick || this.kind.label || this.kindId;
    if (n.nick && n.nick !== n.first) return n.first + " '" + n.nick + "' " + n.last;
    return (n.first + ' ' + n.last).trim();
  };

  Pawn.prototype.labelWithKind = function () {
    if (this.isAnimal) return this.label();
    return this.label() + ', ' + (this.kind.label || this.kindId);
  };

  Pawn.prototype.jobReport = function () {
    if (this.dead) return 'Dead';
    if (this.mentalState) {
      var ms = this.mentalState.def || defMaybe('mentalState', this.mentalState.id);
      return U.cap((ms && ms.label) || this.mentalState.id || 'Having a breakdown');
    }
    var J = sys('Jobs');
    if (this.job && J && J.report) {
      var r = J.report(this);
      if (r) return r;
    }
    if (this.downed) return 'Downed';
    if (this.asleep) return 'Sleeping';
    if (this.drafted) return this.moving() ? 'Moving' : 'Standing';
    if (this.job) return U.cap((this.job.def && this.job.def.label) || this.job.defId);
    return 'Idle';
  };

  /* Fraction of the body still intact, for the health bar on the
     colonist chip. Coverage weights it so a lost finger is not a lost leg. */
  Pawn.prototype.healthPercent = function () {
    var h = this.health;
    if (!h || !h.parts || !h.parts.length) return this.dead ? 0 : 1;
    var total = 0, have = 0;
    for (var i = 0; i < h.parts.length; i++) {
      var p = h.parts[i];
      if (p.depth === 'inside') continue;
      var w = p.coverage || 0.05;
      total += w;
      have += w * (p.missing ? 0 : U.clamp01(p.hp / Math.max(1, p.maxHp)));
    }
    if (total <= 0) return 1;
    return U.clamp01(have / total) * (1 - U.clamp01(h.bloodLoss || 0) * 0.5);
  };

  /* One object with everything the colonist bar draws, so ui.js never has
     to reach into needs, health and jobs for one chip. */
  Pawn.prototype.needsSummary = function () {
    var n = this.needs || {};
    var N = sys('Needs');
    var H = sys('Health');
    return {
      id: this.id,
      name: this.label(),
      fullName: this.fullName(),
      mood: N && N.mood ? N.mood(this) : (this.mood || 0),
      moodLabel: N && N.moodLabel ? N.moodLabel(this) : '',
      moodLevel: N && N.moodLevel ? N.moodLevel(this) : 'ok',
      food: n.food === undefined ? 1 : n.food,
      rest: n.rest === undefined ? 1 : n.rest,
      joy: n.joy === undefined ? 1 : n.joy,
      comfort: n.comfort === undefined ? 0 : n.comfort,
      health: this.healthPercent(),
      healthLabel: H && H.summary ? H.summary(this) : (this.downed ? 'downed' : 'healthy'),
      bleeding: H && H.bleedRate ? H.bleedRate(this) : 0,
      downed: !!this.downed,
      dead: !!this.dead,
      drafted: !!this.drafted,
      mental: this.mentalState ? this.mentalState.id : null,
      job: this.jobReport(),
      x: this.x, y: this.y
    };
  };

  /* ============================================================
     PROPERTIES AND RELATIONS
     ============================================================ */

  function massOf(thing) {
    if (!thing || !thing.def) return 0;
    return (thing.def.mass || 0) * (thing.stack || 1);
  }

  Object.defineProperty(Pawn.prototype, 'bodySize', {
    get: function () {
      var k = this.kind;
      var v = k && (k.bodySize !== undefined ? k.bodySize : k.baseHealthScale);
      return typeof v === 'number' && v > 0 ? v : 1;
    }
  });

  /* What the pawn weighs right now, gear included. Hauling reads it and
     so does movement. */
  Object.defineProperty(Pawn.prototype, 'mass', {
    get: function () {
      var m = 0, i;
      m += massOf(this.carried);
      m += massOf(this.equipment);
      for (i = 0; i < this.apparel.length; i++) m += massOf(this.apparel[i]);
      for (i = 0; i < this.inventory.length; i++) m += massOf(this.inventory[i]);
      return m;
    }
  });

  Object.defineProperty(Pawn.prototype, 'carryCapacity', {
    get: function () { return 35 * this.bodySize; }
  });

  Pawn.prototype.isColonist = function () {
    return this.isHuman && this.faction === 'player' && !this.dead && !this.prisoner;
  };

  Pawn.prototype.isFreeColonist = function () {
    return this.isColonist() && !this.downed && !this.mentalState;
  };

  Pawn.prototype.hostileTo = function (other) {
    if (!other || other === this) return false;
    var C = sys('Combat');
    if (C && C.hostile) return C.hostile(this, other);
    var G = sys('Game');
    if (G && G.hostile) return G.hostile(this.faction, other.faction);
    var a = this.faction, b = other.faction;
    if (!a || !b || a === b) return false;
    return (a === 'player' && b === 'raider') || (a === 'raider' && b === 'player');
  };

  Pawn.prototype.canReach = function (x, y, pe) {
    var Path = sys('Path');
    if (!Path || !this.map) return false;
    return Path.reachable(this.map, this.x, this.y, x, y, { pawn: this, peMode: pe });
  };

  Pawn.prototype.distanceTo = function (target) {
    if (!target) return Infinity;
    return U.dist(this.x, this.y, target.x, target.y);
  };

  /* Put a freshly built pawn onto a map. mapgen and the incident code
     both need this and neither should be poking at map.pawns. */
  Pawn.prototype.spawn = function (map, x, y) {
    if (!map) return false;
    this.map = map;
    if (x !== undefined) this.x = x | 0;
    if (y !== undefined) this.y = y | 0;
    this.fx = this.x;
    this.fy = this.y;
    this.stopPath();
    if (map.addPawn) return map.addPawn(this, this.x, this.y);
    if (map.pawns.indexOf(this) < 0) map.pawns.push(this);
    return true;
  };

  Pawn.prototype.deSpawn = function () {
    var map = this.map;
    if (!map) return false;
    this.stopPath();
    this.endJob('interrupted');
    if (map.removePawn) return map.removePawn(this);
    return U.remove(map.pawns, this);
  };

  /* ============================================================
     STATIC ENTRY POINTS

     combat.js, construct.js, animals.js and health.js all look for a
     function on the Pawn namespace before falling back to their own
     copy of the rules. These are the ones they look for.
     ============================================================ */

  Pawn.make = function (kindId, faction, opts) { return new Pawn(kindId, faction, opts); };

  Pawn.learn = function (pawn, skillId, xp) {
    return pawn && pawn.learn ? pawn.learn(skillId, xp) : 0;
  };
  Pawn.gainXp = Pawn.learn;

  Pawn.skillLevel = function (pawn, skillId) {
    return pawn && pawn.skillLevel ? pawn.skillLevel(skillId) : 0;
  };
  Pawn.workSpeed = function (pawn, skillId) {
    return pawn && pawn.workSpeed ? pawn.workSpeed(skillId) : 1;
  };
  Pawn.startPath = function (pawn, x, y, pe) {
    return pawn && pawn.startPath ? pawn.startPath(x, y, pe) : false;
  };
  Pawn.spawn = function (pawn, map, x, y) {
    return pawn && pawn.spawn ? pawn.spawn(map, x, y) : false;
  };
  Pawn.hostile = function (a, b) {
    return a && a.hostileTo ? a.hostileTo(b) : false;
  };
  Pawn.xpToNext = xpToNext;
  Pawn.TRAIT_FX = TRAIT_FX;

  /* save.js hands back plain objects: the prototype, the kind def and the
     map reference all have to be put back before the pawn can tick. */
  Pawn.rebind = function (data, map) {
    if (!data) return null;
    if (!(data instanceof Pawn)) Object.setPrototypeOf(data, Pawn.prototype);
    data.kind = kindOf(data.kindId);
    if (map) data.map = map;
    if (!data.traits) data.traits = [];
    /* Trait defs may have been reloaded under this pawn, so the cached
       multipliers are rebuilt from whatever is registered now. */
    data._fx = null;
    noteAnimalNumber(data);
    if (!data.apparel) data.apparel = [];
    if (!data.inventory) data.inventory = [];
    if (!data.jobQueue) data.jobQueue = [];
    if (!data.backstories) data.backstories = { childhood: null, adulthood: null };
    if (data.fx === undefined) { data.fx = data.x; data.fy = data.y; }
    if (data._tickCount === undefined) data._tickCount = 0;
    if (data._rareCount === undefined) data._rareCount = 0;
    if (data._deathDone === undefined) data._deathDone = !!data.dead;
    if (data._thinkDelay === undefined) data._thinkDelay = 0;
    if (data._pathFails === undefined) data._pathFails = 0;
    var H = sys('Health');
    if (H && H.rebind) H.rebind(data);
    return data;
  };

  /* Animal numbering is a counter, not a roll, so a new game has to
     start it over or the first muffalo of the second colony is #14. */
  Pawn.resetNameCounters = function () { animalCounts = Object.create(null); };
  Pawn.clearDefCache = function () { backstoryCache = null; };

  root.Pawn = Pawn;
})(this);
