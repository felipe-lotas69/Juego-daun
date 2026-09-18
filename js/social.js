/* ============================================================
   social.js - colonists as people who know each other.

   Four ideas hold this file together.

   One: an opinion is never stored as a number somebody edits. It is
   recomputed from a list of dated memories plus the things that do not
   change much - who they are related to, whose personality grates,
   whose face they like, whether they pray to the same thing. That is
   why an insult fades on its own and why a pattern of insults does
   not, and it is why loading a save cannot drift the number.

   Two: everything a pawn owns lives on `pawn.social`, a plain object of
   plain fields, and everything the colony owns lives in one module
   state object. save.js copies the first for free and Social.save()
   hands over the second. Nothing here holds a pawn reference that has
   to survive a reload; the module's own watch list is rebuilt from the
   map after a load.

   Three: the expensive work is staggered. Social.tickPawn runs for
   every pawn every tick and leaves in three comparisons unless
   (tick + id) % 250 is zero. Social.tick does colony-wide work on a
   120-tick beat and the wedding on its own clock. Nothing walks the
   pawn list per pawn.

   Four: this file registers, it does not edit. Thoughts go in through
   Defs.add, jobs through Jobs.register, and the two behaviours that
   need to reach into another system - the work bonus for standing next
   to a friend, the grudge against a particular doctor - chain the
   original function and call it, so any other expansion that chains
   the same one composes with this.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;

  /* Systems that load after this file are resolved at call time. */
  function sys(name) {
    var v = root[name];
    return v === undefined ? null : v;
  }
  function now() {
    var G = root.Game;
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }
  function debugOn() {
    var G = root.Game;
    return !!(G && G.debug);
  }

  var DAY = 60000;
  var RARE = 250;
  var HOUR = DAY / 24;

  /* How long a computed opinion is trusted before it is rebuilt. */
  var OPINION_CACHE = 240;
  /* Memories per pair, and pairs per pawn. A hundred-day colony has to
     fit in a save, so both are hard caps and the weakest goes first. */
  var MAX_MEM = 14;
  var MAX_PAIRS = 48;

  var TALK_MIN = 900;            /* ticks between interaction attempts */
  var TALK_MAX = 2600;
  var TALK_RADIUS = 5;
  var FIGHT_COOLDOWN = DAY;
  var LIFE_DEBT_COOLDOWN = 2000;

  var Social = {};

  /* ============================================================
     1. THOUGHTS

     def_pawns.js owns the base table and is not ours to edit; adding
     to the registry is exactly what Defs.add is for. Every id here is
     prefixed so two expansions written at the same time cannot collide.
     Mood is stated in RimWorld points; needs.js divides by a hundred.
     ============================================================ */

  var PSYCHO = ['psychopath'];

  var THOUGHTS = {
    socDeepTalk: {
      label: 'Deep conversation', durationDays: 2, stackLimit: 2,
      stages: [{ label: 'We really talked', mood: 6 }]
    },
    socKindWord: {
      label: 'Kind word', durationDays: 1.5, stackLimit: 3,
      stages: [{ label: 'Someone was kind to me', mood: 4 }]
    },
    socJoke: {
      label: 'Shared a laugh', durationDays: 1, stackLimit: 3,
      stages: [{ label: 'We laughed about it', mood: 3 }]
    },
    socStory: {
      label: 'Heard a good story', durationDays: 1.2, stackLimit: 2,
      stages: [{ label: 'Heard a good story', mood: 4 }]
    },
    socSlighted: {
      label: 'Slighted', durationDays: 2, stackLimit: 3,
      stages: [{ label: 'Someone slighted me', mood: -4 }],
      nullifiedByTrait: PSYCHO
    },
    socArgued: {
      label: 'Argument', durationDays: 2, stackLimit: 3,
      stages: [{ label: 'We had words', mood: -5 }],
      nullifiedByTrait: PSYCHO
    },
    socComforted: {
      label: 'Comforted', durationDays: 2.5, stackLimit: 1,
      stages: [{ label: 'Somebody sat with me', mood: 10 }]
    },
    socFlirted: {
      label: 'Flirted with', durationDays: 1, stackLimit: 2,
      stages: [{ label: 'Somebody flirted with me', mood: 4 }]
    },
    socRebuffed: {
      label: 'Rebuffed', durationDays: 1.5, stackLimit: 2,
      stages: [{ label: 'I was turned down', mood: -7 }]
    },
    socFightHad: {
      label: 'Social fight', durationDays: 3, stackLimit: 3,
      stages: [{ label: 'We came to blows', mood: -12 }]
    },
    socRival: {
      label: 'Rival in the colony', durationDays: 0.4, stackLimit: 2,
      stages: [{ label: 'I cannot stand someone here', mood: -6 }],
      nullifiedByTrait: PSYCHO
    },
    socFriendHere: {
      label: 'Friends here', durationDays: 0.4, stackLimit: 1,
      stages: [
        { label: 'I have a friend here', mood: 4 },
        { label: 'I am among friends', mood: 7 }
      ],
      nullifiedByTrait: PSYCHO
    },
    socLonely: {
      label: 'Nobody here likes me', durationDays: 0.4, stackLimit: 1,
      stages: [{ label: 'Nobody here likes me', mood: -5 }],
      nullifiedByTrait: PSYCHO
    },
    socMarried: {
      label: 'Got married', durationDays: 20, stackLimit: 1,
      stages: [{ label: 'We got married', mood: 40 }]
    },
    socWeddingAttended: {
      label: 'Attended a wedding', durationDays: 10, stackLimit: 1,
      stages: [{ label: 'We saw a wedding', mood: 12 }]
    },
    socBrokeUp: {
      label: 'Broke up', durationDays: 15, stackLimit: 1,
      stages: [{ label: 'We broke up', mood: -35 }],
      nullifiedByTrait: PSYCHO
    },
    socCheatedOn: {
      label: 'Cheated on', durationDays: 25, stackLimit: 1,
      stages: [{ label: 'My partner cheated on me', mood: -50 }],
      nullifiedByTrait: PSYCHO
    },
    socCheatGuilt: {
      label: 'I cheated', durationDays: 8, stackLimit: 1,
      stages: [{ label: 'I betrayed my partner', mood: -10 }],
      nullifiedByTrait: PSYCHO
    },
    socProposalYes: {
      label: 'Engaged', durationDays: 10, stackLimit: 1,
      stages: [{ label: 'We are going to be married', mood: 25 }]
    },
    socProposalNo: {
      label: 'Proposal refused', durationDays: 8, stackLimit: 1,
      stages: [{ label: 'My proposal was refused', mood: -15 }]
    },
    socNewLover: {
      label: 'New lover', durationDays: 8, stackLimit: 1,
      stages: [{ label: 'We are together now', mood: 18 }]
    },
    socSpouseDied: {
      label: 'Spouse died', durationDays: 30, stackLimit: 1,
      stages: [{ label: 'My spouse is dead', mood: -60 }],
      nullifiedByTrait: PSYCHO
    },
    socLoverDied: {
      label: 'Lover died', durationDays: 25, stackLimit: 1,
      stages: [{ label: 'My lover is dead', mood: -45 }],
      nullifiedByTrait: PSYCHO
    },
    socFamilyDied: {
      label: 'Family died', durationDays: 20, stackLimit: 3,
      stages: [
        { label: 'A relative of mine died', mood: -18 },
        { label: 'My parent died', mood: -30 },
        { label: 'My child died', mood: -50 }
      ],
      nullifiedByTrait: PSYCHO
    },
    socFriendDied: {
      label: 'Friend died', durationDays: 15, stackLimit: 3,
      stages: [{ label: 'My friend is dead', mood: -25 }],
      nullifiedByTrait: PSYCHO
    },
    socRivalDied: {
      label: 'Rival died', durationDays: 6, stackLimit: 2,
      stages: [{ label: 'Someone I hated is dead', mood: 6 }]
    },
    socFriendExecuted: {
      label: 'Friend executed', durationDays: 12, stackLimit: 2,
      stages: [{ label: 'Someone I liked was executed', mood: -30 }],
      nullifiedByTrait: PSYCHO
    },
    socFriendImprisoned: {
      label: 'Friend imprisoned', durationDays: 8, stackLimit: 2,
      stages: [{ label: 'Someone I care about is in our cells', mood: -12 }],
      nullifiedByTrait: PSYCHO
    },
    socFriendHurt: {
      label: 'Friend hurt', durationDays: 4, stackLimit: 3,
      stages: [{ label: 'Someone I care about was hurt', mood: -8 }],
      nullifiedByTrait: PSYCHO
    },
    socFriendCorpse: {
      label: 'Saw a friend\'s corpse', durationDays: 2, stackLimit: 3,
      stages: [{ label: 'I saw the body of someone I knew', mood: -10 }],
      nullifiedByTrait: PSYCHO
    },
    socLifeSaved: {
      label: 'They saved my life', durationDays: 20, stackLimit: 1,
      stages: [{ label: 'Somebody saved my life', mood: 18 }]
    },
    socLeftToBleed: {
      label: 'Left me bleeding', durationDays: 12, stackLimit: 3,
      stages: [{ label: 'They left me bleeding on the floor', mood: -14 }]
    },
    socTendedByEnemy: {
      label: 'Treated by an enemy', durationDays: 2, stackLimit: 2,
      stages: [{ label: 'I had to be patched up by them', mood: -8 }]
    },
    socPartnerApart: {
      label: 'Sleeping apart', durationDays: 0.4, stackLimit: 1,
      stages: [{ label: 'We do not even share a room', mood: -6 }]
    },
    socPartnerTogether: {
      label: 'Sharing quarters', durationDays: 0.4, stackLimit: 1,
      stages: [{ label: 'We share our quarters', mood: 5 }]
    },
    socWorkedWithFriend: {
      label: 'Worked beside a friend', durationDays: 0.4, stackLimit: 1,
      stages: [{ label: 'Working beside a friend', mood: 3 }]
    }
  };

  if (root.Defs && root.Defs.add) root.Defs.add('thought', THOUGHTS);

  function thought(pawn, id, other, opts) {
    var N = sys('Needs');
    if (!N || !N.addThought || !pawn || pawn.dead || !pawn.thoughts) return;
    opts = opts || {};
    if (other) opts.otherPawnId = other.id !== undefined ? other.id : other;
    N.addThought(pawn, id, opts);
  }

  /* ============================================================
     2. RELATIONS

     A relation is symmetric: adding one writes the mirror on the other
     side, so nothing has to search both directions. `op` is the opinion
     the relation is worth on its own, before anything either of them
     actually did.
     ============================================================ */

  var REL = {
    parent:      { label: 'parent',      rev: 'child',       op: 25,  family: 1 },
    child:       { label: 'child',       rev: 'parent',      op: 30,  family: 1 },
    sibling:     { label: 'sibling',     rev: 'sibling',     op: 20,  family: 1 },
    halfSibling: { label: 'half-sibling', rev: 'halfSibling', op: 12, family: 1 },
    grandparent: { label: 'grandparent', rev: 'grandchild',  op: 15,  family: 1 },
    grandchild:  { label: 'grandchild',  rev: 'grandparent', op: 18,  family: 1 },
    cousin:      { label: 'cousin',      rev: 'cousin',      op: 8,   family: 1 },
    kin:         { label: 'kin',         rev: 'kin',         op: 4,   family: 1 },
    spouse:      { label: 'spouse',      rev: 'spouse',      op: 55,  romantic: 1 },
    fiance:      { label: 'fiance',      rev: 'fiance',      op: 50,  romantic: 1 },
    lover:       { label: 'lover',       rev: 'lover',       op: 45,  romantic: 1 },
    exSpouse:    { label: 'ex-spouse',   rev: 'exSpouse',    op: -35 },
    exLover:     { label: 'ex-lover',    rev: 'exLover',     op: -20 }
  };

  /* The words a player actually uses. A relation that has no gendered
     word falls back to the neutral one. */
  var GENDERED = {
    parent: { male: 'father', female: 'mother' },
    child: { male: 'son', female: 'daughter' },
    sibling: { male: 'brother', female: 'sister' },
    halfSibling: { male: 'half-brother', female: 'half-sister' },
    grandparent: { male: 'grandfather', female: 'grandmother' },
    grandchild: { male: 'grandson', female: 'granddaughter' },
    spouse: { male: 'husband', female: 'wife' },
    exSpouse: { male: 'ex-husband', female: 'ex-wife' }
  };

  function relLabel(kind, gender) {
    var g = GENDERED[kind];
    if (g && gender && g[gender]) return g[gender];
    return (REL[kind] && REL[kind].label) || kind;
  }

  var CLOSE_FAMILY = {
    parent: 1, child: 1, sibling: 1, halfSibling: 1, grandparent: 1, grandchild: 1
  };
  var ROMANTIC = { spouse: 1, fiance: 1, lover: 1 };

  /* ============================================================
     3. SOCIAL MEMORIES

     `a` is what the memory is worth in opinion points on the day it
     happened, `days` how long it takes to fade to nothing. A memory
     with no duration never fades: being killed for, or left to bleed,
     is not something a person gets over because a season turned.
     ============================================================ */

  var MEM = {
    chitchat:      { a: 3,   days: 6,  label: 'chatted' },
    deepTalk:      { a: 14,  days: 20, label: 'talked about real things' },
    kindWord:      { a: 10,  days: 12, label: 'said something kind' },
    joke:          { a: 6,   days: 8,  label: 'made me laugh' },
    story:         { a: 7,   days: 10, label: 'told me a story' },
    comforted:     { a: 18,  days: 20, label: 'comforted me' },
    slight:        { a: -8,  days: 8,  label: 'slighted me' },
    insult:        { a: -20, days: 12, label: 'insulted me' },
    argument:      { a: -14, days: 12, label: 'argued with me' },
    flirt:         { a: 8,   days: 10, label: 'flirted with me' },
    rebuffed:      { a: -10, days: 10, label: 'turned me down' },
    proposalYes:   { a: 30,  days: 60, label: 'said yes' },
    proposalNo:    { a: -18, days: 25, label: 'refused me' },
    becameLovers:  { a: 25,  days: 40, label: 'became my lover' },
    brokeUp:       { a: -35, days: 45, label: 'broke it off' },
    cheated:       { a: -60, days: 60, label: 'cheated on me' },
    fight:         { a: -25, days: 20, label: 'fought me' },
    tended:        { a: 8,   days: 15, label: 'patched me up' },
    rescued:       { a: 25,  days: 30, label: 'carried me to safety' },
    savedMyLife:   { a: 45,  days: 0,  label: 'saved my life' },
    leftMeBleeding:{ a: -30, days: 30, label: 'left me bleeding' },
    killedMyLoved: { a: -90, days: 0,  label: 'killed someone I loved' },
    hurtMyLoved:   { a: -25, days: 25, label: 'hurt someone I love' },
    workedTogether:{ a: 2,   days: 4,  label: 'worked beside me' }
  };

  /* ============================================================
     4. MODULE STATE
     ============================================================ */

  function freshState() {
    return {
      offId: -1000,             /* ids handed to relatives who are not here */
      log: [],                  /* recent interactions, newest last */
      wedding: null,
      counts: {
        interactions: 0, positive: 0, negative: 0, fights: 0, romances: 0,
        marriages: 0, breakups: 0, kinLinks: 0, lifeDebts: 0, comforts: 0
      },
      byKind: {},
      pairs: {}                 /* 'lowId:highId' -> last fight tick */
    };
  }

  var state = freshState();
  /* Pawn objects we have introduced, so a death can be noticed even
     though the dead are removed from map.pawns. Never saved. */
  var watch = [];
  var watchIds = Object.create(null);
  var lastScan = -99999;
  var lastBedPass = -99999;

  Social.state = state;

  /* ============================================================
     5. PER-PAWN STATE
     ============================================================ */

  function isPerson(pawn) {
    return !!(pawn && pawn.isHuman && !pawn.isAnimal);
  }

  function ensure(pawn) {
    if (!isPerson(pawn)) return null;
    var s = pawn.social;
    if (!s) {
      s = pawn.social = {
        op: {},
        orient: rollOrientation(pawn),
        beauty: rollBeauty(pawn),
        nextTalk: now() + U.randInt(TALK_MIN, TALK_MAX),
        fam: 0,
        talks: 0,
        fights: 0,
        workBonus: 1,
        lastFight: 0,
        lastRomance: 0,
        mourned: 0
      };
      if (!pawn.relations) pawn.relations = [];
      return s;
    }
    /* A pawn out of a save has the fields it was written with; anything
       added since is filled in rather than left undefined. */
    if (!s.op) s.op = {};
    if (!s.orient) s.orient = rollOrientation(pawn);
    if (typeof s.beauty !== 'number') s.beauty = rollBeauty(pawn);
    if (typeof s.nextTalk !== 'number') s.nextTalk = now() + U.randInt(TALK_MIN, TALK_MAX);
    if (typeof s.workBonus !== 'number') s.workBonus = 1;
    if (!pawn.relations) pawn.relations = [];
    return s;
  }
  Social.ensure = ensure;

  /* Orientation is rolled once and never changes. The split is roughly
     what a colony-sized sample of people looks like, and asexual pawns
     simply never take part in the romance half of this file. */
  function rollOrientation(pawn) {
    var r = U.rand();
    if (r < 0.75) return 'straight';
    if (r < 0.87) return 'bi';
    if (r < 0.96) return 'gay';
    return 'ace';
  }

  /* There is no beauty stat in the game, so one is derived: a stable
     roll per pawn, nudged by age, in -2..2. It is read the same way
     RimWorld reads its beauty stat - a standing opinion offset. */
  function rollBeauty(pawn) {
    var v = U.gauss(0, 0.9, -2, 2);
    return Math.round(v * 10) / 10;
  }

  Social.beautyOf = function (pawn) {
    var s = ensure(pawn);
    if (!s) return 0;
    /* Age wears on it slowly, which is the only part of this that is
       not a fixed roll. */
    var age = pawn.ageYears || 25;
    var wear = age > 45 ? -(age - 45) * 0.02 : 0;
    return U.clamp(s.beauty + wear, -2.5, 2.5);
  };

  Social.orientationOf = function (pawn) {
    var s = ensure(pawn);
    return s ? s.orient : 'straight';
  };

  function entryFor(s, otherId, t) {
    var e = s.op[otherId];
    if (e) return e;
    e = { v: 0, vt: -99999, met: t, mem: [], c: 0, cSet: 0, fight: 0, debt: 0 };
    s.op[otherId] = e;
    trimPairs(s);
    return e;
  }

  /* The pair table is bounded. What goes is the acquaintance with
     nothing behind it - no memories, no relation, no recent contact. */
  function trimPairs(s) {
    var keys = Object.keys(s.op);
    if (keys.length <= MAX_PAIRS) return;
    var t = now(), worst = null, worstScore = Infinity;
    for (var i = 0; i < keys.length; i++) {
      var e = s.op[keys[i]];
      var score = (e.mem ? e.mem.length * 1000 : 0) + Math.max(0, 40000 - (t - e.met));
      if (score < worstScore) { worstScore = score; worst = keys[i]; }
    }
    if (worst !== null) delete s.op[worst];
  }

  /* ============================================================
     6. MEMORY AND OPINION
     ============================================================ */

  function memValue(m, t) {
    if (!m.d) return m.a;
    var age = t - m.t;
    if (age <= 0) return m.a;
    if (age >= m.d) return 0;
    return m.a * (1 - age / m.d);
  }

  /* `who` remembers `about` doing `kind`. Scale multiplies the base,
     which is how one punch and a broken jaw differ. */
  Social.addMemory = function (who, about, kind, scale) {
    if (!isPerson(who) || !about || who === about) return null;
    var def = MEM[kind];
    if (!def) return null;
    var s = ensure(who);
    if (!s) return null;
    var t = now();
    var e = entryFor(s, about.id, t);
    var amount = def.a * (scale === undefined ? 1 : scale);
    /* A psychopath registers the event and feels almost nothing about
       it, which is exactly how they end up with no enemies and no
       friends either. */
    if (hasTrait(who, 'psychopath')) amount *= 0.35;
    var m = { k: kind, t: t, a: Math.round(amount * 10) / 10, d: (def.days || 0) * DAY };

    /* One entry per kind: doing the same thing again refreshes the clock
       and deepens it rather than stacking a hundred rows. */
    for (var i = 0; i < e.mem.length; i++) {
      if (e.mem[i].k !== kind) continue;
      var old = e.mem[i];
      var carried = memValue(old, t);
      old.t = t;
      old.d = m.d;
      old.a = Math.round(U.clamp(carried + m.a * 0.6, -100, 100) * 10) / 10;
      e.vt = -99999;
      return old;
    }
    e.mem.push(m);
    if (e.mem.length > MAX_MEM) dropWeakestMemory(e, t);
    e.vt = -99999;
    return m;
  };

  function dropWeakestMemory(e, t) {
    var idx = -1, best = Infinity;
    for (var i = 0; i < e.mem.length; i++) {
      var v = Math.abs(memValue(e.mem[i], t));
      if (!e.mem[i].d) v += 1000;          /* permanent memories stay */
      if (v < best) { best = v; idx = i; }
    }
    if (idx >= 0) e.mem.splice(idx, 1);
  }

  function pruneMemories(s, t) {
    var keys = Object.keys(s.op);
    for (var i = 0; i < keys.length; i++) {
      var e = s.op[keys[i]];
      if (!e.mem || !e.mem.length) continue;
      for (var j = e.mem.length - 1; j >= 0; j--) {
        if (e.mem[j].d && t - e.mem[j].t >= e.mem[j].d) { e.mem.splice(j, 1); e.vt = -99999; }
      }
    }
  }

  function hasTrait(pawn, id) {
    var tr = pawn && pawn.traits;
    if (!tr) return false;
    for (var i = 0; i < tr.length; i++) {
      if (tr[i] === id || (tr[i] && tr[i].id === id)) return true;
    }
    return false;
  }
  Social.hasTrait = hasTrait;

  function skill(pawn, id) {
    if (pawn && typeof pawn.skillLevel === 'function') return pawn.skillLevel(id);
    var s = pawn && pawn.skills && pawn.skills[id];
    return s ? s.level : 0;
  }

  function moodOf(pawn) {
    var N = sys('Needs');
    if (N && N.mood) return N.mood(pawn);
    return typeof pawn.mood === 'number' ? pawn.mood : 0.5;
  }

  /* Two people either fit or they do not, and it is not about anything
     either of them did. The roll is a hash of the pair so it is the
     same answer every time it is asked, in a live game and in a
     reloaded one, without storing anything. */
  function compatibility(a, b) {
    var lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id);
    var h = U.hash('compat:' + lo + ':' + hi);
    var base = ((h % 2000) / 1000) - 1;            /* -1..1 */
    var gap = Math.abs((a.ageYears || 25) - (b.ageYears || 25));
    var ageTerm = gap <= 6 ? 0.35 : (gap >= 30 ? -0.45 : 0.35 - (gap - 6) / 34);
    return U.clamp((base + ageTerm) * 16, -22, 22);
  }

  /* What it is like to be around this person, before they open their
     mouth. These are the trait clashes the brief names, plus the ones
     that obviously belong beside them. */
  function traitOpinion(viewer, subject) {
    var v = 0;
    if (hasTrait(subject, 'abrasive')) v -= 22;
    if (hasTrait(subject, 'kind')) v += 16;
    if (hasTrait(subject, 'optimist')) v += 5;
    if (hasTrait(subject, 'pessimist')) v -= 5;
    if (hasTrait(subject, 'volatile')) v -= 6;
    if (hasTrait(subject, 'psychopath') && !hasTrait(viewer, 'psychopath')) v -= 10;
    if (hasTrait(subject, 'bloodlust')) v -= hasTrait(viewer, 'kind') ? 14 : 6;
    if (hasTrait(subject, 'pyromaniac')) v -= 5;
    if (hasTrait(subject, 'slothful')) v -= 8;
    if (hasTrait(subject, 'industrious') && hasTrait(viewer, 'industrious')) v += 6;
    if (hasTrait(viewer, 'kind')) v += 8;          /* they like people */
    if (hasTrait(viewer, 'abrasive')) v -= 6;
    return v;
  }

  function ideologyOpinion(a, b) {
    var I = sys('Ideology');
    if (!I || !I.sameFaith || !I.of) return 0;
    var ia = I.of(a), ib = I.of(b);
    if (!ia || !ib) return 0;
    return I.sameFaith(a, b) ? 12 : -12;
  }

  function relationOpinion(a, b) {
    var rel = a.relations;
    if (!rel || !rel.length) return 0;
    var total = 0;
    for (var i = 0; i < rel.length; i++) {
      if (rel[i].otherId !== b.id) continue;
      var def = REL[rel[i].kind];
      if (def) total += def.op;
    }
    return U.clamp(total, -60, 70);
  }

  function factionOpinion(a, b) {
    if (!a.faction || !b.faction || a.faction === b.faction) return 0;
    var G = root.Game;
    if (G && G.hostile && G.hostile(a.faction, b.faction)) return -30;
    return -6;
  }

  function computeOpinion(a, b, e, t) {
    var total = 0, i;
    for (i = 0; i < e.mem.length; i++) total += memValue(e.mem[i], t);
    if (!e.cSet) { e.c = Math.round(compatibility(a, b)); e.cSet = 1; }
    total += e.c;
    total += traitOpinion(a, b);
    total += Math.round(Social.beautyOf(b) * 7);
    total += relationOpinion(a, b);
    total += ideologyOpinion(a, b);
    total += factionOpinion(a, b);
    return Math.round(U.clamp(total, -100, 100));
  }

  Social.opinionOf = function (a, b) {
    if (!isPerson(a) || !isPerson(b) || a === b) return 0;
    var s = ensure(a);
    if (!s) return 0;
    var t = now();
    var e = s.op[b.id];
    if (e && t - e.vt < OPINION_CACHE && e.vt <= t) return e.v;
    if (!e) e = entryFor(s, b.id, t);
    e.v = computeOpinion(a, b, e, t);
    e.vt = t;
    return e.v;
  };

  /* A one-line reason, for the tooltip a UI wants next to the number. */
  Social.opinionBreakdown = function (a, b) {
    var out = [];
    if (!isPerson(a) || !isPerson(b) || a === b) return out;
    var s = ensure(a), t = now();
    var e = s.op[b.id];
    if (e) {
      for (var i = 0; i < e.mem.length; i++) {
        var v = memValue(e.mem[i], t);
        if (Math.abs(v) < 0.5) continue;
        out.push({ label: MEM[e.mem[i].k] ? MEM[e.mem[i].k].label : e.mem[i].k, value: Math.round(v) });
      }
      if (e.cSet && e.c) out.push({ label: 'personality', value: e.c });
    }
    var tv = traitOpinion(a, b);
    if (tv) out.push({ label: 'who they are', value: tv });
    var bv = Math.round(Social.beautyOf(b) * 7);
    if (bv) out.push({ label: 'looks', value: bv });
    var rv = relationOpinion(a, b);
    if (rv) out.push({ label: 'family', value: rv });
    var iv = ideologyOpinion(a, b);
    if (iv) out.push({ label: 'faith', value: iv });
    out.sort(function (x, y) { return Math.abs(y.value) - Math.abs(x.value); });
    return out;
  };

  /* ============================================================
     7. THE RELATION GRAPH
     ============================================================ */

  function relationRow(pawn, otherId, kind, opts) {
    opts = opts || {};
    return {
      otherId: otherId,
      kind: kind,
      label: relLabel(kind, opts.gender),
      name: opts.name || '',
      gender: opts.gender || '',
      age: opts.age || 0,
      off: opts.off ? 1 : 0,
      dead: opts.dead ? 1 : 0,
      opinion: 0,
      since: now()
    };
  }

  var EXCLUSIVE = { spouse: 1, fiance: 1, lover: 1, exSpouse: 1, exLover: 1 };

  Social.addRelation = function (a, b, kind, opts) {
    if (!isPerson(a) || !isPerson(b) || a === b) return false;
    var def = REL[kind];
    if (!def) return false;
    ensure(a); ensure(b);
    Social.removeRelation(a, b, kind);
    Social.removeRelation(b, a, def.rev);
    /* Two people are lovers or exes, never both: leaving the old row in
       place would pay the opinion for a relationship that ended. */
    if (EXCLUSIVE[kind]) {
      Object.keys(EXCLUSIVE).forEach(function (other) {
        if (other === kind) return;
        Social.removeRelation(a, b, other);
        Social.removeRelation(b, a, other);
      });
    }
    a.relations.push(relationRow(a, b.id, kind, { gender: b.gender, name: fullName(b), age: b.ageYears }));
    b.relations.push(relationRow(b, a.id, def.rev, { gender: a.gender, name: fullName(a), age: a.ageYears }));
    dirty(a, b); dirty(b, a);
    return true;
  };

  Social.removeRelation = function (a, b, kind) {
    if (!a || !a.relations) return false;
    var id = b && b.id !== undefined ? b.id : b;
    var hit = false;
    for (var i = a.relations.length - 1; i >= 0; i--) {
      var r = a.relations[i];
      if (r.otherId !== id) continue;
      if (kind && r.kind !== kind) continue;
      a.relations.splice(i, 1);
      hit = true;
    }
    if (hit && b && b.id !== undefined) dirty(a, b);
    return hit;
  };

  function dirty(a, b) {
    var s = a.social;
    if (s && s.op && s.op[b.id]) s.op[b.id].vt = -99999;
  }

  Social.relationKinds = function (a, b) {
    var out = [];
    if (!a || !a.relations || !b) return out;
    var id = b.id !== undefined ? b.id : b;
    for (var i = 0; i < a.relations.length; i++) {
      if (a.relations[i].otherId === id) out.push(a.relations[i].kind);
    }
    return out;
  };

  Social.related = function (a, b) {
    return Social.relationKinds(a, b).length > 0;
  };

  Social.closeFamily = function (a, b) {
    var kinds = Social.relationKinds(a, b);
    for (var i = 0; i < kinds.length; i++) if (CLOSE_FAMILY[kinds[i]]) return true;
    return false;
  };

  Social.partnerOf = function (pawn) {
    if (!pawn || !pawn.relations || !pawn.map) return null;
    var best = null, rank = -1;
    var order = { spouse: 3, fiance: 2, lover: 1 };
    for (var i = 0; i < pawn.relations.length; i++) {
      var r = pawn.relations[i];
      if (!order[r.kind] || r.off) continue;
      var other = findPawn(pawn.map, r.otherId);
      if (!other || other.dead) continue;
      if (order[r.kind] > rank) { rank = order[r.kind]; best = other; }
    }
    return best;
  };

  Social.partnerKind = function (pawn) {
    var partner = Social.partnerOf(pawn);
    if (!partner) return null;
    var kinds = Social.relationKinds(pawn, partner);
    if (kinds.indexOf('spouse') >= 0) return 'spouse';
    if (kinds.indexOf('fiance') >= 0) return 'fiance';
    if (kinds.indexOf('lover') >= 0) return 'lover';
    return null;
  };

  function fullName(pawn) {
    if (pawn && typeof pawn.fullName === 'function') return pawn.fullName();
    var n = pawn && pawn.name;
    if (!n) return 'someone';
    return ((n.first || '') + ' ' + (n.last || '')).trim() || n.nick || 'someone';
  }

  function shortName(pawn) {
    if (pawn && typeof pawn.label === 'function') return pawn.label();
    var n = pawn && pawn.name;
    return (n && (n.nick || n.first)) || 'someone';
  }

  function findPawn(map, id) {
    if (!map) return null;
    var T = sys('T');
    if (T && T.resolve) {
      var p = T.resolve({ k: 'p', id: id }, map);
      if (p) return p;
    }
    for (var i = 0; i < map.pawns.length; i++) if (map.pawns[i].id === id) return map.pawns[i];
    return null;
  }

  /* ---------- relatives who are not here ---------- */

  function names() {
    var N = root.PawnNames;
    if (N && N.first && N.last) return N;
    return {
      first: { male: ['Ander', 'Bram', 'Emil', 'Joss', 'Roman'], female: ['Ada', 'Freya', 'Mira', 'Nell', 'Vera'] },
      last: ['Ashby', 'Crane', 'Falk', 'Marsh', 'Roth']
    };
  }

  function offRelative(pawn, kind, gender, surname, age) {
    var N = names();
    var pool = (N.first && N.first[gender]) || N.first.male;
    var first = U.pick(pool);
    var id = state.offId--;
    var dead = false;
    /* The older the relative the likelier the rimworld already took
       them, which is what makes a living grandmother worth a letter. */
    if (age > 70) dead = U.chance(0.7);
    else if (age > 55) dead = U.chance(0.35);
    else dead = U.chance(0.12);
    ensure(pawn);
    pawn.relations.push(relationRow(pawn, id, kind, {
      gender: gender, name: first + ' ' + surname, age: age, off: 1, dead: dead
    }));
    return id;
  }

  function generateOffMapFamily(pawn) {
    var surname = (pawn.name && pawn.name.last) || U.pick(names().last);
    var age = pawn.ageYears || 25;
    offRelative(pawn, 'parent', 'female', surname, age + U.randInt(19, 36));
    offRelative(pawn, 'parent', 'male', surname, age + U.randInt(21, 40));
    var sibs = U.chance(0.55) ? U.randInt(1, 2) : 0;
    for (var i = 0; i < sibs; i++) {
      offRelative(pawn, U.chance(0.2) ? 'halfSibling' : 'sibling',
        U.chance(0.5) ? 'male' : 'female', surname, Math.max(1, age + U.randInt(-9, 9)));
    }
    if (age > 30 && U.chance(0.25)) {
      offRelative(pawn, 'exSpouse', pawn.gender === 'male' ? 'female' : 'male',
        U.pick(names().last), age + U.randInt(-6, 6));
    }
    if (age > 34 && U.chance(0.18)) {
      offRelative(pawn, 'child', U.chance(0.5) ? 'male' : 'female', surname,
        Math.max(1, age - U.randInt(18, 26)));
    }
  }

  /* ---------- kin who turn out to be standing right there ---------- */

  function kinKindFor(newcomer, other) {
    var gap = (other.ageYears || 25) - (newcomer.ageYears || 25);
    var abs = Math.abs(gap);
    if (abs >= 40) return gap > 0 ? 'grandparent' : 'grandchild';
    if (abs >= 18) return gap > 0 ? 'parent' : 'child';
    if (abs <= 11) {
      var r = U.rand();
      if (r < 0.6) return 'sibling';
      if (r < 0.8) return 'halfSibling';
      return 'cousin';
    }
    return U.chance(0.6) ? 'cousin' : 'kin';
  }

  function tryKinLink(pawn, map) {
    var cands = [], i;
    for (i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (p === pawn || !isPerson(p) || p.dead) continue;
      if (!p.social || !p.social.fam) continue;
      if (Social.related(pawn, p)) continue;
      cands.push(p);
    }
    if (!cands.length) return null;

    /* A fellow colonist is far likelier to be family - you came down in
       the same pod. A raider is rare, and that rarity is the point. */
    var colonist = pawn.faction === 'player';
    var chance = colonist ? 0.30 : 0.07;
    if (!U.chance(chance)) return null;

    var other = U.pick(cands);
    var kind = kinKindFor(pawn, other);
    if (!Social.addRelation(pawn, other, kind)) return null;
    state.counts.kinLinks++;

    /* Blood shows in the surname, and a shared surname is how a player
       reads the relation at a glance. */
    if (CLOSE_FAMILY[kind] && kind !== 'grandchild' && pawn.name && other.name && other.name.last) {
      if (kind === 'sibling' || kind === 'halfSibling' || kind === 'child' || kind === 'grandparent') {
        pawn.name.last = other.name.last;
      }
    }

    var label = relLabel(kind, other.gender);
    if (other.faction === 'player' || pawn.faction === 'player') {
      var G = root.Game;
      if (G && G.letter && other.faction !== pawn.faction) {
        G.letter('A face from home',
          fullName(pawn) + ' is ' + fullName(other) + '\'s ' + label + '. They did not expect to ' +
          'meet again on the wrong end of a rifle.',
          { kind: 'neutral', x: pawn.x, y: pawn.y });
      } else if (G && G.msg) {
        G.msg(fullName(pawn) + ' is ' + shortName(other) + '\'s ' + label + '.', { type: 'info' });
      }
    }
    return other;
  }

  function introduce(pawn, map) {
    var s = ensure(pawn);
    if (!s || s.fam) return;
    s.fam = 1;
    generateOffMapFamily(pawn);
    tryKinLink(pawn, map);
  }
  Social.introduce = introduce;

  /* ============================================================
     8. INTERACTIONS

     Every one of them ends in the same three things: a memory on both
     sides, a thought where it is worth a mood point, and a line in the
     log. The weight functions are where the personality lives - an
     abrasive pawn in a foul mood does not decide to tell a joke.
     ============================================================ */

  function successChance(c, base) {
    var p = base + 0.035 * c.skill + c.op / 500;
    /* A miserable person is hard to please and easy to offend. */
    p += (c.moodB - 0.5) * 0.35;
    if (hasTrait(c.b, 'kind')) p += 0.1;
    if (hasTrait(c.b, 'abrasive')) p -= 0.1;
    return U.clamp(p, 0.05, 0.96);
  }

  function logLine(c, kind, ok, text) {
    state.counts.interactions++;
    state.byKind[kind] = (state.byKind[kind] || 0) + 1;
    if (ok) state.counts.positive++; else state.counts.negative++;
    state.log.push({ t: now(), a: c.a.id, b: c.b.id, k: kind, ok: ok ? 1 : 0, text: text });
    if (state.log.length > 80) state.log.splice(0, state.log.length - 80);
    return text;
  }

  function both(c, kind, kindBack, scale) {
    Social.addMemory(c.b, c.a, kind, scale);
    if (kindBack) Social.addMemory(c.a, c.b, kindBack, scale);
  }

  function joy(pawn, amount) {
    var N = sys('Needs');
    if (N && N.gainJoy) N.gainJoy(pawn, amount, 'social');
  }

  function learnSocial(pawn, xp) {
    if (pawn && typeof pawn.learn === 'function') pawn.learn('social', xp);
  }

  var TALKS = [
    {
      id: 'chitchat',
      weight: function () { return 14; },
      run: function (c) {
        var ok = U.chance(successChance(c, 0.6));
        if (ok) {
          both(c, 'chitchat', 'chitchat');
          thought(c.b, 'chatted', c.a);
          joy(c.a, 0.012); joy(c.b, 0.012);
          return shortName(c.a) + ' chatted with ' + shortName(c.b) + '.';
        }
        both(c, 'slight', null, 0.4);
        return shortName(c.a) + ' made small talk with ' + shortName(c.b) + ', badly.';
      }
    },
    {
      id: 'joke',
      weight: function (c) { return 4 + c.skill * 0.6; },
      run: function (c) {
        var ok = U.chance(successChance(c, 0.5));
        if (ok) {
          both(c, 'joke', 'joke');
          thought(c.b, 'socJoke', c.a);
          joy(c.a, 0.02); joy(c.b, 0.03);
          return shortName(c.a) + ' made ' + shortName(c.b) + ' laugh.';
        }
        both(c, 'slight', null, 0.5);
        return shortName(c.a) + '\'s joke landed badly with ' + shortName(c.b) + '.';
      }
    },
    {
      id: 'story',
      weight: function (c) { return c.skill >= 3 ? 3 + c.skill * 0.4 : 0; },
      run: function (c) {
        var ok = U.chance(successChance(c, 0.55));
        if (ok) {
          both(c, 'story', 'chitchat');
          thought(c.b, 'socStory', c.a);
          joy(c.b, 0.035);
          return shortName(c.a) + ' told ' + shortName(c.b) + ' a story about the old world.';
        }
        both(c, 'slight', null, 0.3);
        return shortName(c.b) + ' had heard ' + shortName(c.a) + '\'s story before.';
      }
    },
    {
      id: 'deepTalk',
      weight: function (c) { return c.op > 15 ? 4 + c.op * 0.05 : 0; },
      run: function (c) {
        var ok = U.chance(successChance(c, 0.5));
        if (ok) {
          both(c, 'deepTalk', 'deepTalk');
          thought(c.b, 'socDeepTalk', c.a);
          thought(c.a, 'socDeepTalk', c.b);
          joy(c.a, 0.05); joy(c.b, 0.05);
          return shortName(c.a) + ' and ' + shortName(c.b) + ' talked about things that matter.';
        }
        both(c, 'chitchat', 'chitchat', 0.5);
        return shortName(c.a) + ' tried to open up to ' + shortName(c.b) + '.';
      }
    },
    {
      id: 'kindWord',
      weight: function (c) {
        if (c.op < -10) return 0;
        return 3 + (hasTrait(c.a, 'kind') ? 14 : 0) + (c.moodA > 0.7 ? 3 : 0);
      },
      run: function (c) {
        var ok = U.chance(successChance(c, 0.75));
        if (ok) {
          both(c, 'kindWord', 'chitchat');
          thought(c.b, 'socKindWord', c.a);
          joy(c.b, 0.03);
          return shortName(c.a) + ' said something kind to ' + shortName(c.b) + '.';
        }
        both(c, 'chitchat', null, 0.5);
        return shortName(c.b) + ' shrugged off ' + shortName(c.a) + '\'s kind word.';
      }
    },
    {
      id: 'comfort',
      weight: function (c) {
        if (c.moodB > 0.35 || c.op < 5) return 0;
        return 12 + (hasTrait(c.a, 'kind') ? 10 : 0) + c.skill;
      },
      run: function (c) {
        var ok = U.chance(successChance(c, 0.7));
        if (ok) {
          both(c, 'comforted', 'kindWord');
          thought(c.b, 'socComforted', c.a);
          joy(c.b, 0.06);
          state.counts.comforts++;
          notable(c, shortName(c.a) + ' sat with ' + shortName(c.b) + ' for a while.');
          return shortName(c.a) + ' comforted ' + shortName(c.b) + '.';
        }
        both(c, 'chitchat', null, 0.4);
        return shortName(c.b) + ' did not want comforting.';
      }
    },
    {
      id: 'slight',
      weight: function (c) {
        var w = 2 + (hasTrait(c.a, 'abrasive') ? 9 : 0) + (c.op < -10 ? 5 : 0);
        if (c.moodA < 0.35) w += 6;
        if (hasTrait(c.a, 'kind')) w = 0;
        return w;
      },
      run: function (c) {
        both(c, 'slight', null);
        thought(c.b, 'socSlighted', c.a);
        Social.addMemory(c.a, c.b, 'slight', 0.3);
        return shortName(c.a) + ' slighted ' + shortName(c.b) + '.';
      }
    },
    {
      id: 'insult',
      weight: function (c) {
        var w = (hasTrait(c.a, 'abrasive') ? 8 : 1) + (c.op < -25 ? 7 : 0);
        if (c.moodA < 0.3) w += 7;
        if (hasTrait(c.a, 'volatile')) w += 4;
        if (hasTrait(c.a, 'kind')) w = 0;
        return w;
      },
      run: function (c) {
        both(c, 'insult', 'argument', 1);
        thought(c.b, 'insulted', c.a);
        notable(c, shortName(c.a) + ' insulted ' + shortName(c.b) + '.');
        return shortName(c.a) + ' insulted ' + shortName(c.b) + '.';
      }
    },
    {
      id: 'argument',
      weight: function (c) { return c.op < 0 ? 3 + (-c.op) * 0.06 : 1; },
      run: function (c) {
        var lost = U.chance(0.5 - 0.02 * (c.skill - skill(c.b, 'social')));
        both(c, 'argument', 'argument');
        thought(c.b, 'socArgued', c.a);
        thought(c.a, 'socArgued', c.b);
        return shortName(c.a) + ' and ' + shortName(c.b) + ' argued' +
          (lost ? ', and ' + shortName(c.a) + ' came off worse.' : '.');
      }
    },
    {
      id: 'flirt',
      weight: function (c) {
        if (!Social.canRomance(c.a, c.b)) return 0;
        var w = 3 + Math.max(0, c.op) * 0.06 + Social.beautyOf(c.b) * 2;
        if (Social.partnerKind(c.a)) w *= 0.15;   /* attached, but not dead */
        return Math.max(0, w);
      },
      run: function (c) {
        var p = successChance(c, 0.35) + Social.beautyOf(c.a) * 0.05;
        if (U.chance(U.clamp(p, 0.05, 0.9))) {
          both(c, 'flirt', 'flirt');
          thought(c.b, 'socFlirted', c.a);
          /* A flirt that keeps landing is how two colonists end up
             together; the romance check reads these memories. */
          return shortName(c.a) + ' flirted with ' + shortName(c.b) + '.';
        }
        Social.addMemory(c.a, c.b, 'rebuffed');
        thought(c.a, 'socRebuffed', c.b);
        return shortName(c.b) + ' turned ' + shortName(c.a) + ' down.';
      }
    }
  ];

  function notable(c, text) {
    var G = root.Game;
    if (G && G.msg) G.msg(text, { type: 'info', x: c.a.x, y: c.a.y });
  }

  function makeContext(a, b) {
    return {
      a: a, b: b,
      op: Social.opinionOf(a, b),
      back: Social.opinionOf(b, a),
      skill: skill(a, 'social'),
      moodA: moodOf(a),
      moodB: moodOf(b)
    };
  }

  Social.interact = function (a, b, forcedId) {
    if (!canTalk(a) || !canTalk(b) || a === b) return null;
    var c = makeContext(a, b);
    var talk = null, i;
    if (forcedId) {
      for (i = 0; i < TALKS.length; i++) if (TALKS[i].id === forcedId) talk = TALKS[i];
    }
    if (!talk) {
      talk = U.pickWeighted(TALKS, function (t) {
        var w = t.weight(c);
        return w > 0 ? w : 0;
      });
    }
    if (!talk) return null;

    var before = Social.opinionOf(b, a);
    var text = talk.run(c);
    var after = Social.opinionOf(b, a);
    var ok = after >= before;
    learnSocial(a, 18);
    learnSocial(b, 6);

    var sa = ensure(a), sb = ensure(b);
    sa.talks++; sb.talks++;
    sa.nextTalk = now() + U.randInt(TALK_MIN, TALK_MAX);
    sb.nextTalk = Math.max(sb.nextTalk, now() + U.randInt(400, 900));
    return logLine(c, talk.id, ok, text);
  };

  function canTalk(pawn) {
    if (!isPerson(pawn) || pawn.dead || pawn.downed) return false;
    if (pawn.asleep || pawn.mentalState) return false;
    if (!pawn.map) return false;
    var H = sys('Health');
    if (H && H.capacity && H.capacity(pawn, 'consciousness') < 0.3) return false;
    if (H && H.capacity && H.capacity(pawn, 'talking') < 0.2) return false;
    return true;
  }
  Social.canTalk = canTalk;

  /* Who is near enough, awake enough and on speaking terms with the
     world to be talked at. */
  function pickPartner(pawn) {
    var map = pawn.map;
    if (!map) return null;
    var best = null, bestScore = -Infinity;
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var other = list[i];
      if (other === pawn || !isPerson(other)) continue;
      var d = U.cheb(pawn.x, pawn.y, other.x, other.y);
      if (d > TALK_RADIUS) continue;
      if (!canTalk(other)) continue;
      if (!speakable(pawn, other)) continue;
      var op = Social.opinionOf(pawn, other);
      /* People seek out the ones they like and, a little, the ones they
         cannot let go of. Indifference is what keeps them apart. */
      var score = Math.abs(op) * 0.4 + (op > 0 ? op * 0.3 : 0) - d * 3 + U.rand() * 12;
      if (score > bestScore) { bestScore = score; best = other; }
    }
    return best;
  }

  function speakable(a, b) {
    if (a.faction === b.faction) return true;
    /* A warden and a prisoner talk; two strangers on opposite sides of a
       firefight do not. */
    if (b.prisoner && a.faction === 'player') return true;
    if (a.prisoner && b.faction === 'player') return true;
    var G = root.Game;
    if (G && G.hostile && G.hostile(a.faction, b.faction)) return false;
    return true;
  }

  /* ============================================================
     9. ROMANCE, ENGAGEMENT, MARRIAGE
     ============================================================ */

  function attracted(a, b) {
    var sa = ensure(a);
    if (!sa || sa.orient === 'ace') return false;
    if ((a.ageYears || 0) < 16 || (b.ageYears || 0) < 16) return false;
    if (sa.orient === 'bi') return true;
    var same = a.gender === b.gender;
    return sa.orient === 'gay' ? same : !same;
  }

  Social.canRomance = function (a, b) {
    if (!isPerson(a) || !isPerson(b) || a === b) return false;
    if (a.dead || b.dead || a.downed || b.downed) return false;
    if (Social.closeFamily(a, b)) return false;
    if (!attracted(a, b) || !attracted(b, a)) return false;
    var gap = Math.abs((a.ageYears || 25) - (b.ageYears || 25));
    if (gap > 28) return false;
    return true;
  };

  /* A pass, not a proposal: this is the check the rare tick runs to see
     whether two people who like each other become two people who are
     together. */
  Social.tryRomance = function (a, b) {
    if (!Social.canRomance(a, b)) return false;
    var kindA = Social.partnerKind(a), kindB = Social.partnerKind(b);
    var cheating = !!(kindA || kindB);
    var op = Social.opinionOf(a, b), back = Social.opinionOf(b, a);
    if (op < 25 || back < 25) return false;

    var p = 0.10 + (op + back - 50) / 900;
    p += (Social.beautyOf(a) + Social.beautyOf(b)) * 0.012;
    if (cheating) p *= 0.12;
    if (!U.chance(U.clamp(p, 0, 0.6))) return false;

    if (cheating) return cheat(a, b, kindA ? a : b);

    Social.addRelation(a, b, 'lover');
    Social.addMemory(a, b, 'becameLovers');
    Social.addMemory(b, a, 'becameLovers');
    thought(a, 'socNewLover', b);
    thought(b, 'socNewLover', a);
    state.counts.romances++;
    var G = root.Game;
    if (G && G.msg) {
      G.msg(shortName(a) + ' and ' + shortName(b) + ' are lovers now.',
        { type: 'good', x: a.x, y: a.y });
    }
    return true;
  };

  /* The messiest thing this file does, and the one that produces the
     best stories. The betrayed partner finds out immediately, because a
     colony is twelve people in four rooms. */
  function cheat(a, b, unfaithful) {
    var other = unfaithful === a ? b : a;
    var partner = Social.partnerOf(unfaithful);
    if (!partner) return false;
    Social.addMemory(partner, unfaithful, 'cheated');
    Social.addMemory(partner, other, 'insult', 1.2);
    thought(partner, 'socCheatedOn', unfaithful);
    thought(unfaithful, 'socCheatGuilt', partner);
    Social.addMemory(a, b, 'flirt', 1.5);
    Social.addMemory(b, a, 'flirt', 1.5);
    var G = root.Game;
    if (G && G.letter) {
      G.letter('Betrayal',
        fullName(unfaithful) + ' has been sleeping with ' + fullName(other) + '. ' +
        fullName(partner) + ' knows.',
        { kind: 'neutral', x: unfaithful.x, y: unfaithful.y });
    }
    /* Half the time the marriage does not survive the night. */
    if (U.chance(0.5)) Social.breakUp(partner, unfaithful);
    return true;
  }

  Social.breakUp = function (a, b) {
    if (!isPerson(a) || !isPerson(b)) return false;
    var kinds = Social.relationKinds(a, b);
    var wasSpouse = kinds.indexOf('spouse') >= 0;
    var wasAny = wasSpouse || kinds.indexOf('lover') >= 0 || kinds.indexOf('fiance') >= 0;
    if (!wasAny) return false;

    Social.removeRelation(a, b, 'spouse');
    Social.removeRelation(b, a, 'spouse');
    Social.removeRelation(a, b, 'lover');
    Social.removeRelation(b, a, 'lover');
    Social.removeRelation(a, b, 'fiance');
    Social.removeRelation(b, a, 'fiance');
    Social.addRelation(a, b, wasSpouse ? 'exSpouse' : 'exLover');

    Social.addMemory(a, b, 'brokeUp');
    Social.addMemory(b, a, 'brokeUp');
    thought(a, 'socBrokeUp', b);
    thought(b, 'socBrokeUp', a);
    state.counts.breakups++;
    var G = root.Game;
    if (G && G.msg) {
      G.msg(shortName(a) + ' and ' + shortName(b) + ' have broken up.',
        { type: 'info', x: a.x, y: a.y });
    }
    return true;
  };

  /* ---------- the wedding ---------- */

  Social.marry = function (a, b) {
    if (!isPerson(a) || !isPerson(b) || a === b) return false;
    if (a.dead || b.dead || !a.map) return false;
    if (state.wedding) return false;
    var kinds = Social.relationKinds(a, b);
    if (kinds.indexOf('spouse') >= 0) return false;

    var spot = weddingSpot(a, b);
    if (!spot) return false;
    state.wedding = {
      a: a.id, b: b.id, x: spot.x, y: spot.y,
      start: now(), ticks: 0, dur: 2400, guests: []
    };
    var G = root.Game;
    if (G && G.letter) {
      G.letter('A wedding',
        fullName(a) + ' and ' + fullName(b) + ' are getting married. Everyone who can be ' +
        'spared is gathering.',
        { kind: 'good', x: spot.x, y: spot.y });
    }
    return true;
  };

  function weddingSpot(a, b) {
    var map = a.map;
    if (!map) return null;
    var tables = map.byDef ? map.byDef('table') : null;
    if (tables && tables.length) {
      var best = null, bestD = Infinity;
      for (var i = 0; i < tables.length; i++) {
        var d = U.cheb(a.x, a.y, tables[i].x, tables[i].y);
        if (d < bestD) { bestD = d; best = tables[i]; }
      }
      if (best) {
        var cell = freeCellNear(map, best.x, best.y, 2);
        if (cell) return cell;
      }
    }
    return freeCellNear(map, a.x, a.y, 2) || { x: a.x, y: a.y };
  }

  function freeCellNear(map, x, y, r) {
    var ring = U.cellsInRadius(x, y, r);
    for (var i = 0; i < ring.length; i++) {
      var cx = ring[i][0], cy = ring[i][1];
      if (!map.inBounds(cx, cy) || !map.passable(cx, cy)) continue;
      if (map.buildingAt(cx, cy)) continue;
      return { x: cx, y: cy };
    }
    return null;
  }

  function tickWedding(map) {
    var w = state.wedding;
    if (!w) return;
    var a = findPawn(map, w.a), b = findPawn(map, w.b);
    if (!a || !b || a.dead || b.dead || a.downed || b.downed) {
      state.wedding = null;
      var G = root.Game;
      if (G && G.msg) G.msg('The wedding was called off.', { type: 'info' });
      return;
    }
    w.ticks++;

    /* Guests are gathered on a slow beat; the couple is walked to the
       spot the same way, so a wedding is a thing the colony stops for. */
    if (w.ticks % 60 === 1) gatherGuests(map, w, a, b);

    if (w.ticks >= w.dur) completeWedding(map, w, a, b);
  }

  function gatherGuests(map, w, a, b) {
    var Jobs = sys('Jobs'), T = sys('T');
    if (!Jobs || !T || !Jobs.make || !Jobs.start) return;
    var list = map.colonists ? map.colonists() : [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.dead || p.downed || p.drafted || p.mentalState || p.asleep) continue;
      if (p.job && p.job.defId === 'socialWedding') continue;
      if (p.job && (p.job.playerForced || URGENT_JOBS[p.job.defId])) continue;
      if (U.cheb(p.x, p.y, w.x, w.y) > 45) continue;
      var cell = freeCellNear(map, w.x + U.randInt(-2, 2), w.y + U.randInt(-2, 2), 2);
      if (!cell) continue;
      var job = Jobs.make('socialWedding', T.cell(cell.x, cell.y));
      if (job) Jobs.start(p, job);
    }
    /* The couple stands together. */
    [a, b].forEach(function (p) {
      if (p.job && p.job.defId === 'socialWedding') return;
      if (p.drafted || p.mentalState || p.downed) return;
      var cell = freeCellNear(map, w.x, w.y, 1);
      if (!cell) return;
      var job = Jobs.make('socialWedding', T.cell(cell.x, cell.y));
      if (job) Jobs.start(p, job);
    });
  }

  var URGENT_JOBS = {
    eat: 1, sleep: 1, layDown: 1, attackMelee: 1, attackStatic: 1, flee: 1,
    tendPatient: 1, rescue: 1, carryToBed: 1, extinguishFire: 1
  };

  function completeWedding(map, w, a, b) {
    state.wedding = null;
    Social.removeRelation(a, b, 'lover');
    Social.removeRelation(b, a, 'lover');
    Social.removeRelation(a, b, 'fiance');
    Social.removeRelation(b, a, 'fiance');
    Social.addRelation(a, b, 'spouse');
    Social.addMemory(a, b, 'proposalYes');
    Social.addMemory(b, a, 'proposalYes');
    thought(a, 'socMarried', b);
    thought(b, 'socMarried', a);
    state.counts.marriages++;

    var list = map.colonists ? map.colonists() : [];
    var attended = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p === a || p === b) continue;
      if (U.cheb(p.x, p.y, w.x, w.y) > 8) continue;
      thought(p, 'socWeddingAttended');
      /* Standing at a wedding also makes people like each other a
         little more, which is what a wedding is for. */
      for (var j = 0; j < list.length; j++) {
        if (list[j] === p) continue;
        if (U.cheb(list[j].x, list[j].y, w.x, w.y) > 8) continue;
        Social.addMemory(p, list[j], 'chitchat', 0.6);
      }
      attended++;
    }
    var G = root.Game;
    if (G && G.letter) {
      G.letter('Married',
        fullName(a) + ' and ' + fullName(b) + ' are married. ' +
        (attended ? attended + ' colonist' + (attended === 1 ? '' : 's') + ' stood with them.'
                  : 'Nobody could be spared to watch.'),
        { kind: 'good', x: w.x, y: w.y });
    }
    Social.pairBeds(map);
  }

  /* ---------- the romance rare tick ---------- */

  function romanceCheck(pawn, map) {
    var s = ensure(pawn);
    var t = now();
    if (t - s.lastRomance < 4000) return;
    s.lastRomance = t;
    if (!canTalk(pawn)) return;
    if (s.orient === 'ace') return;

    var partner = Social.partnerOf(pawn);
    var kind = Social.partnerKind(pawn);

    /* Already attached: propose, or fall apart. */
    if (partner) {
      var op = Social.opinionOf(pawn, partner);
      if (op < -20 && U.chance(0.25)) { Social.breakUp(pawn, partner); return; }
      if (kind === 'lover' && op > 55 && Social.opinionOf(partner, pawn) > 45 && U.chance(0.18)) {
        propose(pawn, partner);
        return;
      }
      if (kind === 'fiance' && !state.wedding && t - (s.engagedAt || 0) > DAY && U.chance(0.4)) {
        Social.marry(pawn, partner);
        return;
      }
      if (!U.chance(0.15)) return;       /* an attached pawn rarely looks */
    }

    /* Otherwise look at whoever is nearby and worth looking at. */
    var best = null, bestScore = 0;
    for (var i = 0; i < map.pawns.length; i++) {
      var other = map.pawns[i];
      if (other === pawn || !isPerson(other) || other.dead) continue;
      if (other.faction !== pawn.faction) continue;
      if (!Social.canRomance(pawn, other)) continue;
      var score = Social.opinionOf(pawn, other) + Social.opinionOf(other, pawn);
      if (score > bestScore) { bestScore = score; best = other; }
    }
    if (best) Social.tryRomance(pawn, best);
  }

  function propose(a, b) {
    var op = Social.opinionOf(b, a);
    var yes = U.chance(U.clamp(0.25 + op / 160, 0.05, 0.95));
    if (yes) {
      Social.removeRelation(a, b, 'lover');
      Social.removeRelation(b, a, 'lover');
      Social.addRelation(a, b, 'fiance');
      Social.addMemory(a, b, 'proposalYes');
      Social.addMemory(b, a, 'proposalYes');
      thought(a, 'socProposalYes', b);
      thought(b, 'socProposalYes', a);
      ensure(a).engagedAt = now();
      ensure(b).engagedAt = now();
      logLine(makeContext(a, b), 'proposal', true,
        shortName(a) + ' asked ' + shortName(b) + ' to marry them, and was accepted.');
      var G = root.Game;
      if (G && G.msg) {
        G.msg(shortName(a) + ' and ' + shortName(b) + ' are engaged.', { type: 'good', x: a.x, y: a.y });
      }
    } else {
      Social.addMemory(a, b, 'proposalNo');
      thought(a, 'socProposalNo', b);
      logLine(makeContext(a, b), 'proposal', false,
        shortName(b) + ' refused ' + shortName(a) + '\'s proposal.');
    }
  }

  /* ---------- quarters ----------
     There is no double bed in this game, so a couple wants the next best
     thing: two beds in one room. Social hands them out rather than
     leaving the player to notice, and says so in the mood tab either
     way. */

  Social.pairBeds = function (map) {
    if (!map || !map.byDef) return 0;
    var Regions = sys('Regions');
    var beds = (map.byDef('bed') || []).filter(function (b) {
      return b.spawned && !b.forPrisoners;
    });
    if (!beds.length) return 0;
    var done = 0;
    var list = map.colonists ? map.colonists() : [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      var b = Social.partnerOf(a);
      if (!b || b.id < a.id) continue;
      if (a.ownedBedId && b.ownedBedId && sameRoom(map, Regions, a.ownedBedId, b.ownedBedId)) continue;
      var pair = findBedPair(map, Regions, beds, a, b);
      if (!pair) continue;
      assignBed(map, a, pair[0]);
      assignBed(map, b, pair[1]);
      done++;
    }
    return done;
  };

  function sameRoom(map, Regions, idA, idB) {
    var ba = map.thing(idA), bb = map.thing(idB);
    if (!ba || !bb) return false;
    if (!Regions || !Regions.roomAt) return U.cheb(ba.x, ba.y, bb.x, bb.y) <= 3;
    var ra = Regions.roomAt(map, ba.x, ba.y), rb = Regions.roomAt(map, bb.x, bb.y);
    return !!(ra && rb && ra.id === rb.id);
  }

  function findBedPair(map, Regions, beds, a, b) {
    for (var i = 0; i < beds.length; i++) {
      if (!bedFreeFor(map, beds[i], a)) continue;
      for (var j = 0; j < beds.length; j++) {
        if (i === j || !bedFreeFor(map, beds[j], b)) continue;
        if (!sameRoom(map, Regions, beds[i].id, beds[j].id)) continue;
        return [beds[i], beds[j]];
      }
    }
    return null;
  }

  function bedFreeFor(map, bed, pawn) {
    if (!bed || !bed.spawned) return false;
    if (!bed.ownerId || bed.ownerId === pawn.id) return true;
    var owner = findPawn(map, bed.ownerId);
    if (!owner || owner.dead) { bed.ownerId = null; return true; }
    return false;
  }

  function assignBed(map, pawn, bed) {
    if (pawn.ownedBedId && pawn.ownedBedId !== bed.id) {
      var old = map.thing(pawn.ownedBedId);
      if (old && old.ownerId === pawn.id) old.ownerId = null;
    }
    pawn.ownedBedId = bed.id;
    bed.ownerId = pawn.id;
  }

  function quartersThought(pawn, map) {
    var partner = Social.partnerOf(pawn);
    if (!partner) return;
    if (!pawn.ownedBedId || !partner.ownedBedId) {
      thought(pawn, 'socPartnerApart', partner);
      return;
    }
    var Regions = sys('Regions');
    if (sameRoom(map, Regions, pawn.ownedBedId, partner.ownedBedId)) {
      thought(pawn, 'socPartnerTogether', partner);
    } else {
      thought(pawn, 'socPartnerApart', partner);
    }
  }

  /* ============================================================
     10. SOCIAL FIGHTS

     Not a message: two people walk up to each other and throw punches
     until somebody has had enough, and both of them carry the bruises
     and the memory afterwards.
     ============================================================ */

  var PE = null;
  function pathEnd() {
    if (PE) return PE;
    var P = sys('Path');
    PE = (P && P.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };
    return PE;
  }

  function pairKey(a, b) {
    var lo = Math.min(a.id, b.id), hi = Math.max(a.id, b.id);
    return lo + ':' + hi;
  }

  Social.fightChance = function (a, b) {
    var op = Social.opinionOf(a, b);
    if (op > -30) return 0;
    var p = (-op - 30) / 700;
    if (hasTrait(a, 'volatile')) p *= 2.4;
    if (hasTrait(a, 'abrasive')) p *= 1.6;
    if (hasTrait(a, 'bloodlust')) p *= 1.8;
    if (hasTrait(a, 'ironWilled')) p *= 0.4;
    if (hasTrait(a, 'kind')) p *= 0.3;
    if (moodOf(a) < 0.35) p *= 2;
    return U.clamp(p, 0, 0.35);
  };

  Social.startSocialFight = function (a, b, retaliation) {
    if (!canTalk(a) || !canTalk(b)) return false;
    if (a.drafted || b.drafted) return false;
    var Jobs = sys('Jobs'), T = sys('T');
    if (!Jobs || !T || !Jobs.make || !Jobs.start) return false;
    var t = now();
    var key = pairKey(a, b);
    if (!retaliation) {
      if (t - (state.pairs[key] || -99999) < FIGHT_COOLDOWN) return false;
      state.pairs[key] = t;
    }
    var job = Jobs.make('socialFight', T.pawn(b));
    if (!job) return false;
    job.state.retaliation = !!retaliation;
    if (!Jobs.start(a, job)) return false;
    ensure(a).fights++;
    if (!retaliation) {
      state.counts.fights++;
      var G = root.Game;
      if (G && G.msg) {
        G.msg(shortName(a) + ' and ' + shortName(b) + ' are fighting.',
          { type: 'threat', x: a.x, y: a.y });
      }
      Social.startSocialFight(b, a, true);
    }
    return true;
  };

  function throwPunch(attacker, victim) {
    var H = sys('Health');
    if (!H || !H.damage) return;
    var power = 2 + skill(attacker, 'melee') * 0.35 + (hasTrait(attacker, 'bloodlust') ? 2 : 0);
    var amount = Math.max(1, Math.round(U.randRange(power * 0.5, power * 1.4)));
    H.damage(victim, {
      amount: amount, type: 'blunt', source: 'fist', instigator: attacker, armorPen: 0.1
    });
    if (attacker.learn) attacker.learn('melee', 12);
  }

  function endFight(pawn, job) {
    var other = job.state && job.state.otherId ? findPawn(pawn.map, job.state.otherId) : null;
    if (!other) return;
    Social.addMemory(pawn, other, 'fight');
    thought(pawn, 'socFightHad', other);
  }

  /* ============================================================
     11. WHAT HAPPENS TO PEOPLE

     Death, imprisonment, being hurt, being saved, being left. The
     reactions that make a colony feel like it noticed.
     ============================================================ */

  function feelingsAbout(pawn, subject) {
    /* One number, and the sign of it decides which thought fires. */
    return Social.opinionOf(pawn, subject);
  }

  Social.noteDeath = function (victim, map) {
    if (!isPerson(victim)) return;
    var s = victim.social;
    if (s && s.mourned) return;
    if (s) s.mourned = 1;
    map = map || victim.map;
    if (!map) return;
    var cause = (victim.health && victim.health.deathCause) || '';
    var executed = String(cause).indexOf('execut') >= 0;

    var list = map.colonists ? map.colonists() : [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p === victim || p.dead) continue;
      var kinds = Social.relationKinds(p, victim);
      var op = feelingsAbout(p, victim);
      var fired = false;

      if (kinds.indexOf('spouse') >= 0 || kinds.indexOf('fiance') >= 0) {
        thought(p, 'socSpouseDied', victim); fired = true;
      } else if (kinds.indexOf('lover') >= 0) {
        thought(p, 'socLoverDied', victim); fired = true;
      }
      if (kinds.indexOf('child') >= 0) { thought(p, 'socFamilyDied', victim, { degree: 2 }); fired = true; }
      else if (kinds.indexOf('parent') >= 0 || kinds.indexOf('sibling') >= 0) {
        thought(p, 'socFamilyDied', victim, { degree: 1 }); fired = true;
      } else if (kinds.length && !fired) {
        thought(p, 'socFamilyDied', victim, { degree: 0 }); fired = true;
      }

      if (!fired) {
        if (executed && op > 20) { thought(p, 'socFriendExecuted', victim); fired = true; }
        else if (op >= 35) { thought(p, 'socFriendDied', victim); fired = true; }
        else if (op <= -35) { thought(p, 'socRivalDied', victim); fired = true; }
      }

      /* Whoever swung last answers for it, for as long as they live. */
      var killer = victim._socLastAttacker ? findPawn(map, victim._socLastAttacker) : null;
      if (killer && killer !== p && (op >= 25 || kinds.length)) {
        Social.addMemory(p, killer, 'killedMyLoved');
      }
    }
    dropRelationsOfDead(victim, map);
  };

  /* The dead keep their relations - a widow is still a widow - but the
     living need their copy marked so the UI does not offer to send
     somebody to talk to a corpse. */
  function dropRelationsOfDead(victim, map) {
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!isPerson(p) || !p.relations) continue;
      for (var j = 0; j < p.relations.length; j++) {
        if (p.relations[j].otherId === victim.id) p.relations[j].dead = 1;
      }
    }
  }

  Social.noteImprisoned = function (prisoner, map) {
    if (!isPerson(prisoner)) return;
    map = map || prisoner.map;
    if (!map || !map.colonists) return;
    var list = map.colonists();
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p === prisoner) continue;
      if (Social.relationKinds(p, prisoner).length || Social.opinionOf(p, prisoner) >= 30) {
        thought(p, 'socFriendImprisoned', prisoner);
      }
    }
  };

  Social.noteHurt = function (victim, instigator) {
    if (!isPerson(victim) || !victim.map) return;
    if (instigator && isPerson(instigator)) victim._socLastAttacker = instigator.id;
    var map = victim.map;
    var list = map.colonists ? map.colonists() : [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p === victim) continue;
      var close = Social.relationKinds(p, victim).length || Social.opinionOf(p, victim) >= 40;
      if (!close) continue;
      thought(p, 'socFriendHurt', victim);
      if (instigator && isPerson(instigator) && instigator !== p) {
        Social.addMemory(p, instigator, 'hurtMyLoved');
      }
    }
  };

  /* Someone I knew, on the floor, not getting up. needs.js already
     fires the generic corpse thought; this is the one that is about
     who it was. */
  function corpseCheck(pawn, map) {
    if (!map.byDef) return;
    var corpses = map.byDef('corpse');
    if (!corpses || !corpses.length) return;
    var limit = Math.min(corpses.length, 24);
    for (var i = 0; i < limit; i++) {
      var c = corpses[i];
      if (!c.spawned || !c.corpse) continue;
      if (U.cheb(pawn.x, pawn.y, c.x, c.y) > 6) continue;
      var id = c.corpse.pawnId;
      if (!id || id === pawn.id) continue;
      var s = pawn.social;
      var e = s.op[id];
      if (!e) continue;
      if (e.v >= 25 || relationsWith(pawn, id)) thought(pawn, 'socFriendCorpse', { id: id });
    }
  }

  function relationsWith(pawn, id) {
    if (!pawn.relations) return false;
    for (var i = 0; i < pawn.relations.length; i++) if (pawn.relations[i].otherId === id) return true;
    return false;
  }

  /* ---------- life debts ---------- */

  function rescueCheck(pawn) {
    var carrier = pawn.carriedBy ? findPawn(pawn.map, pawn.carriedBy) : null;
    if (!carrier || !isPerson(carrier)) return;
    var s = ensure(pawn);
    var e = entryFor(s, carrier.id, now());
    if (now() - (e.debt || 0) < LIFE_DEBT_COOLDOWN) return;
    e.debt = now();
    var dying = pawn.downed || (pawn.health && pawn.health.bloodLoss > 0.3);
    Social.addMemory(pawn, carrier, dying ? 'savedMyLife' : 'rescued');
    if (dying) {
      thought(pawn, 'socLifeSaved', carrier);
      state.counts.lifeDebts++;
    }
  }

  /* The other half of the ledger, and the part no colony sim keeps: who
     was standing around while you bled. Checked from the victim, once
     in a while, and only against people who could have done something. */
  function abandonmentCheck(pawn, map) {
    if (!pawn.downed) return;
    var H = sys('Health');
    if (!H || !H.bleedRate || H.bleedRate(pawn) <= 0.05) return;
    if (H.needsTending && !H.needsTending(pawn)) return;
    var s = ensure(pawn);
    var t = now();
    if (t - (s.bledAt || 0) < 3000) return;
    if (!s.bledAt) { s.bledAt = t; return; }      /* first sighting starts the clock */
    s.bledAt = t;

    var list = map.colonists ? map.colonists() : [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p === pawn || p.dead || p.downed) continue;
      if (U.cheb(pawn.x, pawn.y, p.x, p.y) > 14) continue;
      if (p.job && (p.job.defId === 'tendPatient' || p.job.defId === 'rescue')) continue;
      if (typeof p.capable === 'function' && !p.capable('doctor')) continue;
      var e = entryFor(s, p.id, t);
      if (t - (e.debt || 0) < LIFE_DEBT_COOLDOWN * 3) continue;
      e.debt = t;
      Social.addMemory(pawn, p, 'leftMeBleeding');
      thought(pawn, 'socLeftToBleed', p);
    }
  }

  /* ============================================================
     12. FRIENDSHIP AT WORK AND GRUDGES IN THE INFIRMARY

     Two things this game's model should have and does not. Both reach
     into health.js by chaining its function rather than editing it.
     ============================================================ */

  Social.friendsOf = function (pawn, threshold) {
    var out = [];
    if (!isPerson(pawn) || !pawn.map) return out;
    var min = threshold === undefined ? 35 : threshold;
    var list = pawn.map.pawns;
    for (var i = 0; i < list.length; i++) {
      var other = list[i];
      if (other === pawn || !isPerson(other) || other.dead) continue;
      if (Social.opinionOf(pawn, other) >= min) out.push(other);
    }
    return out;
  };

  Social.rivalsOf = function (pawn, threshold) {
    var out = [];
    if (!isPerson(pawn) || !pawn.map) return out;
    var max = threshold === undefined ? -35 : threshold;
    var list = pawn.map.pawns;
    for (var i = 0; i < list.length; i++) {
      var other = list[i];
      if (other === pawn || !isPerson(other) || other.dead) continue;
      if (Social.opinionOf(pawn, other) <= max) out.push(other);
    }
    return out;
  };

  /* Refreshed on the rare tick and read by the chained work-speed
     function, so the hot path is one property lookup. */
  function refreshWorkBonus(pawn, map) {
    var s = pawn.social;
    if (!pawn.job || pawn.drafted) { s.workBonus = 1; return; }
    var friends = 0;
    var list = map.pawns;
    for (var i = 0; i < list.length && friends < 2; i++) {
      var other = list[i];
      if (other === pawn || !isPerson(other) || other.dead || other.downed) continue;
      if (!other.job || other.asleep) continue;
      if (U.cheb(pawn.x, pawn.y, other.x, other.y) > 6) continue;
      if (Social.opinionOf(pawn, other) < 35) continue;
      friends++;
      if (U.chance(0.08)) Social.addMemory(pawn, other, 'workedTogether');
    }
    s.workBonus = 1 + 0.05 * friends;
    if (friends) thought(pawn, 'socWorkedWithFriend');
  }

  Social.workSpeedFactor = function (pawn) {
    var s = pawn && pawn.social;
    return (s && typeof s.workBonus === 'number') ? s.workBonus : 1;
  };

  /* A patient who hates the doctor pushes them away once. Once, because
     a colonist who refuses treatment forever is a bug, not a grudge:
     the second attempt goes through and leaves a bad taste instead. */
  Social.refusesDoctor = function (patient, doctor) {
    if (!isPerson(patient) || !isPerson(doctor) || patient === doctor) return false;
    if (patient.downed || patient.dead) return false;
    var H = sys('Health');
    if (H && H.capacity && H.capacity(patient, 'consciousness') < 0.5) return false;
    if (Social.opinionOf(patient, doctor) > -50) return false;
    var s = ensure(patient);
    var e = entryFor(s, doctor.id, now());
    if (now() - (e.refused || 0) < 2500) return false;
    return true;
  };

  function noteTend(patient, doctor) {
    if (!isPerson(patient) || !isPerson(doctor) || patient === doctor) return;
    var s = ensure(patient);
    var t = now();
    var e = entryFor(s, doctor.id, t);
    var dying = patient.downed || (patient.health && patient.health.bloodLoss > 0.35);
    if (dying && t - (e.debt || 0) > LIFE_DEBT_COOLDOWN) {
      e.debt = t;
      Social.addMemory(patient, doctor, 'savedMyLife');
      thought(patient, 'socLifeSaved', doctor);
      state.counts.lifeDebts++;
    } else {
      Social.addMemory(patient, doctor, 'tended');
    }
    if (Social.opinionOf(patient, doctor) <= -50) thought(patient, 'socTendedByEnemy', doctor);
  }

  (function chainTend() {
    var H = sys('Health');
    if (!H || typeof H.tend !== 'function' || H.__socialChained) return;
    var base = H.tend;
    H.__socialChained = true;
    H.tend = function (patient, doctor, medicine) {
      if (doctor && Social.refusesDoctor(patient, doctor)) {
        var s = ensure(patient);
        var e = entryFor(s, doctor.id, now());
        e.refused = now();
        var G = root.Game;
        if (G && G.msg) {
          G.msg(shortName(patient) + ' will not be touched by ' + shortName(doctor) + '.',
            { type: 'info', x: patient.x, y: patient.y });
        }
        return false;
      }
      var ok = base.call(H, patient, doctor, medicine);
      if (ok && doctor) noteTend(patient, doctor);
      return ok;
    };
  })();

  (function chainWorkSpeed() {
    var H = sys('Health');
    if (!H || typeof H.workSpeedFactor !== 'function' || H.__socialWorkChained) return;
    var base = H.workSpeedFactor;
    H.__socialWorkChained = true;
    H.workSpeedFactor = function (pawn) {
      var f = base.call(H, pawn);
      var s = pawn && pawn.social;
      return (s && s.workBonus && s.workBonus !== 1) ? f * s.workBonus : f;
    };
  })();

  /* ============================================================
     13. JOBS
     ============================================================ */

  (function registerJobs() {
    var Jobs = sys('Jobs'), Toils = sys('Toils'), T = sys('T');
    if (!Jobs || !Jobs.register || !Toils || !T) return;

    Jobs.register('socialFight', {
      label: 'brawl',
      reportString: 'Fighting {A}.',
      toils: function () {
        return [
          Toils.goto('A', { pe: pathEnd().TOUCH, failIfGone: true }),
          Toils.custom({
            name: 'brawl',
            init: function (pawn, job, s) {
              s.rounds = 0;
              s.max = U.randInt(3, 7);
              s.wait = 20;
              var other = T.resolve(job.targetA, pawn.map);
              if (other) job.state.otherId = other.id;
            },
            tick: function (pawn, job, s) {
              var other = T.resolve(job.targetA, pawn.map);
              if (!other || other.dead || other.downed || pawn.downed) return 'done';
              if (U.cheb(pawn.x, pawn.y, other.x, other.y) > 1) return 'done';
              if (--s.wait > 0) return 'stay';
              s.wait = U.randInt(30, 60);
              throwPunch(pawn, other);
              if (++s.rounds >= s.max) return 'done';
              return 'stay';
            }
          })
        ];
      },
      onEnd: function (pawn, job) { endFight(pawn, job); }
    });

    /* Standing at a wedding. The toil ends itself when the ceremony
       does, so a cancelled wedding does not strand the colony. */
    Jobs.register('socialWedding', {
      label: 'attend a wedding',
      reportString: 'Attending a wedding.',
      joyKind: 'social',
      toils: function () {
        return [
          Toils.goto('A', { pe: pathEnd().ON_CELL, failIfGone: false }),
          Toils.waitWith(function (pawn, job, s) {
            if (!state.wedding) return 'done';
            if (s.ticks % 120 === 0) joy(pawn, 0.02);
            return 'stay';
          }, { name: 'watchWedding' })
        ];
      }
    });

    /* Going to find somebody to talk to, rather than waiting for the
       job list to put two people in the same room. */
    Jobs.register('socialRelax', {
      label: 'socialise',
      reportString: 'Relaxing with {A}.',
      joyKind: 'social',
      toils: function () {
        return [
          Toils.goto('A', { pe: pathEnd().ADJACENT, failIfGone: true }),
          Toils.waitWith(function (pawn, job, s) {
            var other = T.resolve(job.targetA, pawn.map);
            if (!other || !canTalk(other)) return 'done';
            if (s.ticks === 30) Social.interact(pawn, other);
            if (s.ticks % 60 === 0) joy(pawn, 0.03);
            return s.ticks > 420 ? 'done' : 'stay';
          }, { name: 'hangAround' })
        ];
      }
    });
  })();

  /* A colonist with time on their hands goes and finds a friend instead
     of walking in a circle. Only ever replaces idling. */
  var IDLE_JOBS = { joyIdle: 1, wander: 1, wait: 1 };

  function trySocialise(pawn, map) {
    var N = sys('Needs');
    if (!N || !N.wantsJoy) return false;
    if (pawn.drafted || pawn.mentalState || pawn.downed) return false;
    if (pawn.job && !IDLE_JOBS[pawn.job.defId]) return false;
    if (pawn.job && pawn.job.playerForced) return false;
    if (!pawn.needs || pawn.needs.joy > 0.45) return false;

    var friend = null, bestOp = 25;
    for (var i = 0; i < map.pawns.length; i++) {
      var other = map.pawns[i];
      if (other === pawn || !isPerson(other) || !canTalk(other)) continue;
      if (other.faction !== pawn.faction) continue;
      if (U.cheb(pawn.x, pawn.y, other.x, other.y) > 22) continue;
      if (other.job && !IDLE_JOBS[other.job.defId]) continue;
      var op = Social.opinionOf(pawn, other);
      if (op > bestOp) { bestOp = op; friend = other; }
    }
    if (!friend) return false;

    var Jobs = sys('Jobs'), T = sys('T');
    if (!Jobs || !T) return false;
    var job = Jobs.make('socialRelax', T.pawn(friend));
    return !!(job && Jobs.start(pawn, job));
  }

  /* ============================================================
     14. READOUTS FOR THE UI
     ============================================================ */

  Social.relationsOf = function (pawn) {
    var out = [];
    if (!isPerson(pawn) || !pawn.relations) return out;
    var map = pawn.map;
    for (var i = 0; i < pawn.relations.length; i++) {
      var r = pawn.relations[i];
      var other = (!r.off && map) ? findPawn(map, r.otherId) : null;
      var op = other ? Social.opinionOf(pawn, other) : (REL[r.kind] ? REL[r.kind].op : 0);
      r.opinion = op;                 /* ui.js reads this off the row */
      out.push({
        other: other,
        otherId: r.otherId,
        kind: r.kind,
        label: r.label || relLabel(r.kind, r.gender),
        name: other ? fullName(other) : (r.name || 'someone'),
        opinion: op,
        offMap: !!r.off,
        dead: !!r.dead
      });
    }
    out.sort(function (a, b) { return Math.abs(b.opinion) - Math.abs(a.opinion); });
    return out;
  };

  /* Everybody this pawn has an opinion about, strongest first. The
     Social tab wants this more than it wants the relation list. */
  Social.opinionsOf = function (pawn, limit) {
    var out = [];
    if (!isPerson(pawn) || !pawn.map) return out;
    var list = pawn.map.pawns;
    for (var i = 0; i < list.length; i++) {
      var other = list[i];
      if (other === pawn || !isPerson(other) || other.dead) continue;
      if (!pawn.social || !pawn.social.op[other.id]) continue;
      out.push({
        other: other, name: fullName(other),
        opinion: Social.opinionOf(pawn, other),
        theirs: Social.opinionOf(other, pawn),
        kinds: Social.relationKinds(pawn, other)
      });
    }
    out.sort(function (a, b) { return Math.abs(b.opinion) - Math.abs(a.opinion); });
    return limit ? out.slice(0, limit) : out;
  };

  Social.summary = function (pawn) {
    if (!isPerson(pawn)) return '';
    ensure(pawn);
    var partner = Social.partnerOf(pawn);
    var kind = Social.partnerKind(pawn);
    var friends = Social.friendsOf(pawn).length;
    var rivals = Social.rivalsOf(pawn).length;
    var bits = [];
    if (partner) bits.push(U.cap(relLabel(kind, partner.gender)) + ': ' + fullName(partner));
    bits.push(friends === 0 ? 'No friends here'
      : friends + ' friend' + (friends === 1 ? '' : 's'));
    if (rivals) bits.push(rivals + ' rival' + (rivals === 1 ? '' : 's'));
    var s = pawn.social;
    if (s && s.fights) bits.push(s.fights + ' fight' + (s.fights === 1 ? '' : 's'));
    return bits.join('. ') + '.';
  };

  Social.recentInteractions = function (pawn, n) {
    var out = [];
    if (!pawn) return out;
    var want = n || 8;
    for (var i = state.log.length - 1; i >= 0 && out.length < want; i--) {
      var row = state.log[i];
      if (row.a !== pawn.id && row.b !== pawn.id) continue;
      var otherId = row.a === pawn.id ? row.b : row.a;
      out.push({
        tick: row.t, kind: row.k, text: row.text, good: !!row.ok,
        initiated: row.a === pawn.id, otherId: otherId,
        other: pawn.map ? findPawn(pawn.map, otherId) : null
      });
    }
    return out;
  };

  Social.familyTree = function (pawn) {
    var tree = {
      self: pawn ? fullName(pawn) : '', parents: [], children: [], siblings: [],
      grandparents: [], grandchildren: [], cousins: [], kin: [],
      spouse: null, exes: [], lovers: []
    };
    if (!isPerson(pawn) || !pawn.relations) return tree;
    var map = pawn.map;
    for (var i = 0; i < pawn.relations.length; i++) {
      var r = pawn.relations[i];
      var other = (!r.off && map) ? findPawn(map, r.otherId) : null;
      var row = {
        id: r.otherId, name: other ? fullName(other) : (r.name || 'someone'),
        kind: r.kind, label: r.label || relLabel(r.kind, r.gender),
        offMap: !!r.off, dead: !!r.dead || !!(other && other.dead),
        onMap: !!other, age: r.age || (other ? other.ageYears : 0)
      };
      switch (r.kind) {
        case 'parent': tree.parents.push(row); break;
        case 'child': tree.children.push(row); break;
        case 'sibling': case 'halfSibling': tree.siblings.push(row); break;
        case 'grandparent': tree.grandparents.push(row); break;
        case 'grandchild': tree.grandchildren.push(row); break;
        case 'cousin': tree.cousins.push(row); break;
        case 'spouse': tree.spouse = row; break;
        case 'fiance': case 'lover': tree.lovers.push(row); break;
        case 'exSpouse': case 'exLover': tree.exes.push(row); break;
        default: tree.kin.push(row); break;
      }
    }
    return tree;
  };

  Social.stats = function () {
    return {
      interactions: state.counts.interactions,
      positive: state.counts.positive,
      negative: state.counts.negative,
      fights: state.counts.fights,
      romances: state.counts.romances,
      marriages: state.counts.marriages,
      breakups: state.counts.breakups,
      kinLinks: state.counts.kinLinks,
      lifeDebts: state.counts.lifeDebts,
      comforts: state.counts.comforts,
      byKind: state.byKind,
      logged: state.log.length,
      wedding: !!state.wedding
    };
  };

  /* ============================================================
     15. THE TICK
     ============================================================ */

  Social.tick = function (map) {
    if (!map) return;
    var t = now();
    if (state.wedding) tickWedding(map);

    if (t - lastScan < 120) return;
    lastScan = t;
    scanPawns(map);

    if (t - lastBedPass > 6000) {
      lastBedPass = t;
      Social.pairBeds(map);
    }
  };

  /* One walk of the pawn list: introduce anybody new, notice anybody who
     has died since the last pass, and forget the ones who have left. */
  function scanPawns(map) {
    var i, p;
    for (i = watch.length - 1; i >= 0; i--) {
      p = watch[i];
      if (p.dead) {
        Social.noteDeath(p, map);
        watch.splice(i, 1);
        delete watchIds[p.id];
        continue;
      }
      if (p.map !== map) {
        watch.splice(i, 1);
        delete watchIds[p.id];
        continue;
      }
      if (p.prisoner && !p._socPrisonNoted) {
        p._socPrisonNoted = 1;
        Social.noteImprisoned(p, map);
      }
    }
    for (i = 0; i < map.pawns.length; i++) {
      p = map.pawns[i];
      if (!isPerson(p) || p.dead) continue;
      if (watchIds[p.id]) continue;
      ensure(p);
      introduce(p, map);
      watch.push(p);
      watchIds[p.id] = 1;
    }
  }

  Social.tickPawn = function (pawn) {
    if (!pawn || !pawn.isHuman || pawn.dead || !pawn.map) return;
    var t = now();
    if (((t + pawn.id) % RARE) !== 0) return;

    var s = ensure(pawn);
    if (!s) return;
    var map = pawn.map;

    /* Being carried is the only thing that matters while downed, and it
       is the thing that decides who you owe. */
    rescueCheck(pawn);
    if (pawn.downed) { abandonmentCheck(pawn, map); return; }
    if (pawn.asleep || pawn.mentalState) return;

    s.rare = (s.rare || 0) + 1;
    pruneMemories(s, t);
    refreshWorkBonus(pawn, map);
    standingThoughts(pawn, map);
    woundWatch(pawn, s);

    if ((s.rare % 3) === 0) corpseCheck(pawn, map);
    if ((s.rare % 5) === 0) quartersThought(pawn, map);

    /* Fights first: a pawn who is about to swing does not stop to chat. */
    if (t - (s.lastFight || 0) > 2000 && tryFight(pawn, map)) return;

    if (pawn.faction === 'player' && (s.rare % 4) === 0) romanceCheck(pawn, map);

    if (t >= s.nextTalk && canTalk(pawn)) {
      var partner = pickPartner(pawn);
      if (partner) Social.interact(pawn, partner);
      else s.nextTalk = t + U.randInt(400, 900);
    }

    if ((s.rare % 6) === 0 && pawn.faction === 'player') trySocialise(pawn, map);
  };

  /* combat.js has no "somebody was hurt" hook and is not ours to edit, so
     the wound count is watched instead: more injuries than last time means
     something happened to them since, and the people who care hear about
     it. The attacker, when one is known, was recorded by noteHurt. */
  function woundWatch(pawn, s) {
    var h = pawn.health;
    var n = (h && h.injuries) ? h.injuries.length : 0;
    if (s.injN === undefined) { s.injN = n; return; }
    if (n > s.injN && pawn.faction === 'player') {
      Social.noteHurt(pawn, freshAttacker(pawn, h));
    }
    s.injN = n;
  }

  /* health.js stamps every injury with whoever caused it, so the newest
     wound names the person the colony is about to resent. */
  function freshAttacker(pawn, h) {
    if (!h || !h.injuries) return null;
    var best = null, youngest = Infinity;
    for (var i = 0; i < h.injuries.length; i++) {
      var inj = h.injuries[i];
      if (!inj.instigatorId || inj.instigatorId === pawn.id) continue;
      var age = inj.ageTicks === undefined ? 0 : inj.ageTicks;
      if (age < youngest) { youngest = age; best = inj.instigatorId; }
    }
    if (best === null || youngest > RARE * 2) return null;
    return findPawn(pawn.map, best);
  }

  function tryFight(pawn, map) {
    if (pawn.drafted || (pawn.job && pawn.job.playerForced)) return false;
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var other = list[i];
      if (other === pawn || !isPerson(other) || other.dead) continue;
      if (other.faction !== pawn.faction) continue;
      if (U.cheb(pawn.x, pawn.y, other.x, other.y) > 4) continue;
      if (!canTalk(other) || !canTalk(pawn)) continue;
      var chance = Social.fightChance(pawn, other);
      if (chance <= 0 || !U.chance(chance)) continue;
      pawn.social.lastFight = now();
      if (Social.startSocialFight(pawn, other)) return true;
    }
    return false;
  }

  /* The standing feelings: refreshed while they are true and left to
     expire on their own the moment they stop being true. */
  function standingThoughts(pawn, map) {
    if (pawn.faction !== 'player') return;
    var friends = 0, rivals = 0, worstRival = null, worst = 0;
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var other = list[i];
      if (other === pawn || !isPerson(other) || other.dead) continue;
      if (other.faction !== 'player') continue;
      var op = Social.opinionOf(pawn, other);
      if (op >= 40) friends++;
      else if (op <= -40) {
        rivals++;
        if (op < worst) { worst = op; worstRival = other; }
      }
    }
    if (friends) thought(pawn, 'socFriendHere', null, { degree: friends >= 3 ? 1 : 0 });
    if (rivals && worstRival) thought(pawn, 'socRival', worstRival);
    if (!friends && list.length > 2) {
      var colony = map.colonists ? map.colonists().length : 0;
      if (colony >= 3) thought(pawn, 'socLonely');
    }
  }

  /* ============================================================
     16. SAVE AND LOAD

     Per-pawn state rides along on pawn.social, which save.js copies as
     a plain field. What is here is the colony's own: the log, the
     counters, the wedding in progress and the id counter for relatives
     who are not on the map.
     ============================================================ */

  Social.save = function () {
    return {
      v: 1,
      offId: state.offId,
      log: state.log.slice(),
      wedding: state.wedding ? {
        a: state.wedding.a, b: state.wedding.b, x: state.wedding.x, y: state.wedding.y,
        start: state.wedding.start, ticks: state.wedding.ticks, dur: state.wedding.dur
      } : null,
      counts: {
        interactions: state.counts.interactions, positive: state.counts.positive,
        negative: state.counts.negative, fights: state.counts.fights,
        romances: state.counts.romances, marriages: state.counts.marriages,
        breakups: state.counts.breakups, kinLinks: state.counts.kinLinks,
        lifeDebts: state.counts.lifeDebts, comforts: state.counts.comforts
      },
      byKind: shallow(state.byKind),
      pairs: shallow(state.pairs)
    };
  };

  function shallow(obj) {
    var out = {}, keys = Object.keys(obj || {});
    for (var i = 0; i < keys.length; i++) out[keys[i]] = obj[keys[i]];
    return out;
  }

  Social.load = function (data) {
    state = freshState();
    Social.state = state;
    watch.length = 0;
    watchIds = Object.create(null);
    lastScan = -99999;
    lastBedPass = -99999;
    if (!data) return false;
    if (typeof data.offId === 'number') state.offId = data.offId;
    if (Array.isArray(data.log)) state.log = data.log.slice(0, 80);
    if (data.wedding && data.wedding.a && data.wedding.b) state.wedding = data.wedding;
    if (data.counts) {
      var keys = Object.keys(state.counts);
      for (var i = 0; i < keys.length; i++) {
        if (typeof data.counts[keys[i]] === 'number') state.counts[keys[i]] = data.counts[keys[i]];
      }
    }
    if (data.byKind) state.byKind = shallow(data.byKind);
    if (data.pairs) state.pairs = shallow(data.pairs);
    return true;
  };

  Social.reset = function () {
    state = freshState();
    Social.state = state;
    watch.length = 0;
    watchIds = Object.create(null);
    lastScan = -99999;
    lastBedPass = -99999;
    return Social;
  };

  /* Useful in the harness and behind Game.debug: force the whole colony
     through one round of interactions without waiting for the clock. */
  Social.debugRound = function (map) {
    if (!map) return 0;
    scanPawns(map);
    var list = map.colonists ? map.colonists() : [];
    var done = 0;
    for (var i = 0; i < list.length; i++) {
      var partner = pickPartner(list[i]);
      if (partner && Social.interact(list[i], partner)) done++;
    }
    if (debugOn()) console.log('[social] forced ' + done + ' interactions');
    return done;
  };

  Social.THOUGHTS = THOUGHTS;
  Social.REL = REL;
  Social.MEM = MEM;
  Social.TALKS = TALKS;

  root.Social = Social;
})(this);
