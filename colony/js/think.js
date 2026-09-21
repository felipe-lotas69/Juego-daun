/* ============================================================
   think.js - the think tree, mental breaks and drafted behaviour.

   Everything a pawn does starts here. jobs.js knows how to carry a
   steel bar; workgivers.js knows there is a steel bar worth carrying;
   this file is the one that decides that carrying it is what should
   happen next, and it decides by asking a fixed list of questions in
   a fixed order. The order is the behaviour: a pawn who is on fire
   does not stop to eat, a pawn who is starving does not stop to haul,
   and a pawn with nothing pressing wanders.

   Every level of the tree is a small named function returning a Job or
   null, and every level carries a tier number. The tiers do double
   duty: think() walks them top down to pick a job, and
   shouldAbandonJob() compares the tier of what a pawn is doing against
   the tier of what has just become true, so a hauler reacts to a fire
   instead of finishing the haul first.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;

  /* Half the systems this file talks to sit below it in the load order,
     so every one of them is looked up at call time and a missing one is
     a level that quietly declines rather than a crash. */
  function sys(name) {
    var v = root[name];
    return v === undefined ? null : v;
  }

  function tickNow() {
    var G = sys('Game');
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  var TICKS_PER_DAY = 60000;
  var TICKS_PER_HOUR = TICKS_PER_DAY / 24;      /* 2500 */
  var RARE = 250;

  /* How long a pawn lies in a bed before getting up to look at the world
     again. Without a cap a patient whose wounds were tended would lie
     there until hunger woke them. */
  var BED_REST_TICKS = 2500;
  /* A failed hunt for food means there is none; stop asking for a while
     so the pawn goes and cooks or hunts instead of spinning. */
  var FOOD_RETRY_TICKS = 600;
  /* A tier that made a pawn drop a job and then handed back nothing is
     wrong about the world. Stop trusting it for a bit. */
  var SUPPRESS_TICKS = 1500;
  var SHELTER_RESCAN = 1200;
  var COMFY_MIN = 8, COMFY_MAX = 32, COMFY_TARGET = 21;
  var JOY_WANT = 0.30;
  var BREAK_IMMUNITY = TICKS_PER_DAY;

  var Think = {};

  /* ------------------------------------------------------------------
     Tiers. Lower is more urgent. The fractional ones are levels that
     were not in the original list and slot between two that were.
     ------------------------------------------------------------------ */
  var TIER = {
    DOWNED: 1,
    BURNING: 2,
    MENTAL: 3,
    COLLAPSE: 3.5,     /* a drafted pawn about to pass out outranks the order */
    ORDERED: 3.8,      /* jobs the player queued with a right click */
    DRAFTED: 4,
    ANIMAL: 5,
    DEFEND: 5.4,       /* something is attacking this colonist right now */
    FIGHT: 5.5,        /* a raider between jobs looks for someone to shoot */
    EMERGENCY: 6,
    URGENT: 7,
    SLEEP: 8,
    HUNGER: 9,
    WORK: 10,
    JOY: 11,
    IDLE: 12
  };
  Think.TIER = TIER;

  var MENTAL_JOBS = {
    mentalWander: 1, mentalTantrum: 1, mentalBerserk: 1, mentalBinge: 1, mentalDaze: 1
  };
  var FIGHT_JOBS = { attackMelee: 1, attackStatic: 1, flee: 1 };
  var EMERGENCY_JOBS = { tendPatient: 1, rescue: 1, carryToBed: 1, feedPatient: 1 };
  var IDLE_JOBS = { wander: 1, wait: 1, goto: 1 };

  /* mentalState def id -> the job that acts it out. jobs.js registers
     the five mental jobs; panicFlee borrows combat's flee. */
  var MENTAL_JOB = {
    sadWander: 'mentalWander',
    tantrum: 'mentalTantrum',
    berserk: 'mentalBerserk',
    foodBinge: 'mentalBinge',
    daze: 'mentalDaze',
    panicFlee: 'flee',
    runWild: 'mentalWander'
  };

  /* Which break a mood band produces, and how likely it is per hour
     spent under that line. Extreme is deliberately fast: a colonist
     left at rock bottom for an afternoon should cost the player
     something, not merely look sad. */
  var BREAK_STATES = {
    extreme: ['berserk', 'foodBinge'],
    major: ['tantrum', 'daze'],
    minor: ['sadWander']
  };
  /* Roughly: an hour under the extreme line is a coin flip over three
     hours, a day under the minor line is even odds. Low enough that an
     unhappy colony is a warning, high enough that ignoring one costs. */
  var BREAK_CHANCE_PER_HOUR = { extreme: 0.35, major: 0.12, minor: 0.04 };
  var DEFAULT_THRESHOLDS = { minor: 0.35, major: 0.25, extreme: 0.15 };
  var DEFAULT_DURATION = [6000, 12000];

  var BREAK_TEXT = {
    sadWander: {
      title: '{name} is wandering sadly',
      body: '{name} has given up on the day and is wandering in a daze of misery. They will come round on their own.',
      kind: 'neutral'
    },
    tantrum: {
      title: '{name} is having a tantrum!',
      body: '{name} has snapped and is smashing whatever furniture is within reach.',
      kind: 'threat'
    },
    berserk: {
      title: '{name} has gone berserk!',
      body: '{name} is attacking everyone nearby. Draft someone and put them down before they kill a colonist.',
      kind: 'threat'
    },
    foodBinge: {
      title: '{name} is binge eating',
      body: '{name} is working through the colony larder and will not stop until it passes.',
      kind: 'neutral'
    },
    daze: {
      title: '{name} is dazed',
      body: '{name} has stopped answering and is shuffling about, staring at nothing.',
      kind: 'neutral'
    },
    panicFlee: {
      title: '{name} is panicking',
      body: '{name} has lost their nerve and is running from the fight.',
      kind: 'threat'
    },
    runWild: {
      title: '{name} has gone wild',
      body: '{name} has reverted to the wild and no longer answers to the colony.',
      kind: 'threat'
    }
  };

  var WATER = { shallowWater: 1, deepWater: 1, marsh: 1 };

  /* ------------------------------------------------------------------
     Per-pawn scratch. Not saved: everything in it is a timer that is
     harmless to lose, and a reloaded colonist getting one free rethink
     is better than a save format that has to know about this file.
     ------------------------------------------------------------------ */
  function mindOf(pawn) {
    var m = pawn._mind;
    if (!m) {
      m = pawn._mind = {
        ticks: (pawn.id || 0) % RARE,   /* stagger the rare tick by pawn */
        immuneUntil: 0,
        pendingTier: 0,
        suppress: {},
        shelterTick: -SHELTER_RESCAN,
        lastLevel: 'none'
      };
    }
    return m;
  }

  /* ------------------------------------------------------------------
     Small questions the levels ask
     ------------------------------------------------------------------ */

  function isHuman(pawn) { return pawn.isHuman === true; }

  function need(pawn, id) {
    var n = pawn.needs;
    return (n && typeof n[id] === 'number') ? n[id] : 1;
  }

  function threshold(name, fallback) {
    var N = sys('Needs');
    var t = N && N.thresholds;
    return (t && typeof t[name] === 'number') ? t[name] : fallback;
  }

  function hasTrait(pawn, id) {
    var list = pawn.traits;
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t === id || (t && t.id === id)) return true;
    }
    return false;
  }

  function hourNow() {
    var G = sys('Game');
    if (G && typeof G.hour === 'function') return G.hour();
    return (tickNow() % TICKS_PER_DAY) / TICKS_PER_HOUR;
  }

  /* The colony sleeps 22:00 to 06:00. A night owl keeps their own hours
     and takes the same eight, shifted four on. */
  function isSleepTime(pawn) {
    var h = hourNow();
    if (hasTrait(pawn, 'nightOwl')) return h >= 2 && h < 10;
    return h >= 22 || h < 6;
  }

  function outdoorTemp() {
    var G = sys('Game');
    return (G && G.outdoorTemp) ? G.outdoorTemp() : 21;
  }

  function target(kind, a, b) {
    var T = sys('T');
    if (!T) return null;
    if (kind === 'cell') return T.cell(a, b);
    if (kind === 'pawn') return T.pawn(a);
    return T.thing(a);
  }

  /* A job def that is not loaded is not a plan. Returning null lets the
     tree fall through to the next level instead of handing the driver
     something it cannot start. */
  function makeJob(id, targetA, targetB, opts) {
    var J = sys('Jobs');
    if (!J || !J.make) return null;
    if (J.isRegistered && !J.isRegistered(id)) return null;
    return J.make(id, targetA || null, targetB || null, opts);
  }

  function endJob(pawn, reason) {
    var J = sys('Jobs');
    if (pawn.job && J && J.end) J.end(pawn, reason || 'interrupted');
  }

  function bedUnder(pawn) {
    var map = pawn.map;
    if (!map || !map.buildingAt) return null;
    var b = map.buildingAt(pawn.x, pawn.y);
    return (b && b.def && b.def.building && b.def.building.isBed) ? b : null;
  }

  function fireAt(map, x, y) {
    if (!map || !map.inBounds(x, y)) return null;
    var items = map.items(x, y);
    for (var i = 0; i < items.length; i++) {
      if (items[i].defId === 'fire') return items[i];
    }
    return null;
  }

  /* plants.js keeps fire on the item grid and burns whoever is standing
     in it, so the cell is the honest test. The flag is the hook for
     anything that wants to set a pawn alight on its own. */
  function isBurning(pawn) {
    if (pawn.burning === true) return true;
    return !!fireAt(pawn.map, pawn.x, pawn.y);
  }

  function needsTreatment(pawn) {
    var H = sys('Health');
    if (!H || !pawn.health) return false;
    if (!H.needsTending || !H.needsTending(pawn)) return false;
    var bleed = H.bleedRate ? H.bleedRate(pawn) : 0;
    var pain = H.painLevel ? H.painLevel(pawn) : 0;
    return bleed > 0.02 || pain > 0.30 || (pawn.health.bloodLoss || 0) > 0.15;
  }

  /* A plan that just failed is not a better plan for being asked again
     fifteen ticks later. Every level that can hand out the same job over
     and over checks this first. */
  function justFailed(pawn, defId, within) {
    if (pawn.lastJobDefId !== defId || pawn.lastJobEndReason !== 'failed') return false;
    return (tickNow() - (pawn.lastJobEndTick || 0)) < within;
  }

  /* The last eat job failed, so there is nothing edible the pawn can
     reach: go and cook, hunt or haul instead of standing still. */
  function foodHuntFailed(pawn) {
    return justFailed(pawn, 'eat', FOOD_RETRY_TICKS);
  }

  function aboutToCollapse(pawn) {
    return need(pawn, 'food') < 0.02 || need(pawn, 'rest') < 0.02;
  }

  /* ------------------------------------------------------------------
     The levels, in the order they are asked
     ------------------------------------------------------------------ */

  /* 1. Flat on the ground, or already in a bed and still waiting on a
     doctor. Either way the answer is to lie still. */
  function downedJob(pawn) {
    if (!pawn.downed) return bedRestHoldJob(pawn);
    /* Nobody rages face down in the dirt. */
    if (pawn.mentalState) Think.endMentalState(pawn, 'downed');
    var bed = bedUnder(pawn);
    var job = makeJob('layDown', bed ? target('thing', bed) : target('cell', pawn.x, pawn.y));
    if (job) job.state.asleep = true;
    return job;
  }

  function bedRestHoldJob(pawn) {
    if (!isHuman(pawn)) return null;
    var bed = bedUnder(pawn);
    if (!bed || !needsTreatment(pawn) || !canLieDown(pawn)) return null;
    return lieDownJob(pawn, bed);
  }

  /* Lying in a bed you cannot gain rest from ends the instant it starts -
     jobs.js closes the toil at a full rest need - so a patient who is
     wide awake and fully rested is better off on their feet than in a
     one-tick loop of getting into bed. */
  function canLieDown(pawn) {
    return need(pawn, 'rest') < 0.98;
  }

  function lieDownJob(pawn, bed) {
    var job = makeJob('layDown', target('thing', bed), null, { count: BED_REST_TICKS });
    /* Awake unless they are tired enough to sleep it off: bed rest is
       waiting for the doctor, and a waking patient keeps their rest need
       falling, which is what keeps them in the bed. */
    if (job) job.state.asleep = need(pawn, 'rest') < 0.55;
    return job;
  }

  /* 2. On fire. Water first, then beat at the flames; whatever was being
     carried hits the ground when jobs.js ends the old job. */
  function burningJob(pawn) {
    if (!isBurning(pawn)) return null;
    var map = pawn.map;
    var here = map.terrainAt(pawn.x, pawn.y);

    if (!(here && WATER[here.id])) {
      var water = nearestWater(map, pawn, 16);
      if (water) {
        var run = makeJob('goto', target('cell', water.x, water.y));
        if (run) { run.state.pe = 0; return run; }
      }
    }

    var fire = fireAt(map, pawn.x, pawn.y) || adjacentFire(map, pawn);
    if (fire && !justFailed(pawn, 'extinguishFire', 200)) {
      var beat = makeJob('extinguishFire', target('thing', fire));
      if (beat) return beat;
    }
    return makeJob('flee', null, fire ? target('thing', fire) : null) || makeJob('wander');
  }

  function nearestWater(map, pawn, radius) {
    if (!map || !map.terrainAt) return null;
    var cells = U.cellsInRadius(pawn.x, pawn.y, radius);
    var found = [];
    for (var i = 0; i < cells.length && found.length < 8; i++) {
      var x = cells[i][0], y = cells[i][1];
      if (!map.inBounds(x, y) || !map.passable(x, y)) continue;
      var t = map.terrainAt(x, y);
      if (t && WATER[t.id]) found.push({ x: x, y: y });
    }
    if (!found.length) return null;
    var P = sys('Path');
    if (!P || !P.closestReachable) return found[0];
    return P.closestReachable(map, pawn, found, function (c, d) { return -d; });
  }

  function adjacentFire(map, pawn) {
    for (var i = 0; i < U.ADJ8.length; i++) {
      var f = fireAt(map, pawn.x + U.ADJ8[i][0], pawn.y + U.ADJ8[i][1]);
      if (f) return f;
    }
    return null;
  }

  /* 3. Mid-breakdown. The state's job is the only thing on offer; work
     of any kind is refused until the state runs out. */
  function mentalJob(pawn) {
    var ms = pawn.mentalState;
    if (!ms) return null;
    var id = (ms.def && ms.def.jobId) || MENTAL_JOB[ms.id] || 'mentalWander';
    return makeJob(id) || makeJob('mentalWander') || makeJob('wander');
  }

  /* 3.8 Orders the player queued with a right click. They outrank
     anything the pawn would pick for itself. */
  function queuedJob(pawn) {
    var queue = pawn.jobQueue;
    if (!queue || !queue.length) return null;
    var T = sys('T');
    while (queue.length) {
      var job = queue.shift();
      if (!job) continue;
      if (job.targetA && T && !T.valid(job.targetA, pawn.map)) continue;
      return job;
    }
    return null;
  }

  /* 4. Under player control. */
  function draftedBranch(pawn) {
    if (!pawn.drafted) return null;
    /* Drafted pawns ignore needs - right up to the point where ignoring
       them would drop the pawn where they stand. */
    if (aboutToCollapse(pawn)) {
      var save = urgentNeedsJob(pawn);
      if (save) return save;
    }
    return Think.draftedJob(pawn);
  }

  Think.draftedJob = function (pawn) {
    if (!pawn || !pawn.drafted || !pawn.map) return null;
    var map = pawn.map, T = sys('T'), tgt = pawn.draftTarget;

    if (tgt && T) {
      if (tgt.k === 't' || tgt.k === 'p') {
        var victim = T.resolve(tgt, map);
        if (victim && victim !== pawn) {
          var attack = attackJob(pawn, victim);
          if (attack) return attack;
        }
        pawn.draftTarget = null;          /* it died or despawned */
      } else {
        var pos = T.pos(tgt, map);
        if (pos && (pawn.x !== pos.x || pawn.y !== pos.y)) {
          var go = makeJob('goto', target('cell', pos.x, pos.y), null, { playerForced: true });
          if (go) { go.state.pe = 0; return go; }
        }
        pawn.draftTarget = null;          /* arrived: hold this ground */
      }
    }

    /* Standing where they were put, shooting anything that comes into
       range without chasing it. waitCombat is both halves of that. */
    return makeJob('waitCombat', null, null, { count: 250 }) ||
           makeJob('wait', null, null, { count: 120 });
  };

  function attackJob(pawn, victim) {
    var C = sys('Combat');
    var map = pawn.map;
    var tgt = victim.isHuman !== undefined ? target('pawn', victim) : target('thing', victim);
    var w = C && C.weaponOf ? C.weaponOf(pawn) : null;
    var d = U.dist(pawn.x, pawn.y, victim.x, victim.y);
    var los = !C || !C.lineOfSight || C.lineOfSight(map, pawn.x, pawn.y, victim.x, victim.y);

    if (w && w.ranged && d <= w.range && d >= (w.minRange || 0) && los) {
      var shoot = makeJob('attackStatic', tgt, null, { playerForced: true });
      if (shoot) return shoot;
    }
    return makeJob('attackMelee', tgt, null, { playerForced: true });
  }

  /* 5. Animals have their own head. */
  function animalJob(pawn) {
    if (!pawn.isAnimal) return null;
    var A = sys('Animals');
    if (A && A.think) {
      var job = A.think(pawn);
      if (job) return job;
    }
    /* Without animals.js an animal still has to do something, and
       browsing about is the truthful default. */
    return makeJob('wander');
  }

  /* 5.5 A hostile human with nothing else on: find someone to fight.
     Colonists never take this level - they fight when drafted, and the
     player decides when that is. */
  function fightBackJob(pawn) {
    if (!isHuman(pawn) || pawn.faction === 'player') return null;
    var foe = findFoe(pawn);
    if (!foe) return null;
    return attackJob(pawn, foe);
  }

  /* 5.4 Self-defence. A colonist is not a soldier - the player drafts
     them for a raid - but standing still while a bear takes the colony
     apart one person at a time is not restraint, it is a missing
     behaviour. So: anything already on top of them gets hit back, a
     hostile animal close enough to be a problem gets shot if there is a
     gun to hand, and a raider gets run away from, because that one really
     is the player's decision. */
  var REACT_MELEE = 1.8;        /* it is already on me */
  var REACT_ANIMAL = 6;         /* close enough to be coming for me */
  var REACT_RAIDER = 12;        /* close enough to run from */

  function selfDefenceJob(pawn) {
    if (!isHuman(pawn) || pawn.drafted || pawn.faction !== 'player') return null;
    if (pawn.downed || pawn.dead || !pawn.map) return null;

    var map = pawn.map, best = null, bestD = Infinity;
    for (var i = 0; i < map.pawns.length; i++) {
      var other = map.pawns[i];
      if (other === pawn || other.dead || other.downed) continue;
      if (!hostileTo(pawn, other)) continue;
      var d = U.dist(pawn.x, pawn.y, other.x, other.y);
      if (d < bestD) { bestD = d; best = other; }
    }
    if (!best) return null;

    if (bestD <= REACT_MELEE) return attackJob(pawn, best);

    if (best.isAnimal) {
      if (bestD > REACT_ANIMAL) return null;
      var C = sys('Combat');
      var w = C && C.weaponOf ? C.weaponOf(pawn) : null;
      if (w && w.ranged) return attackJob(pawn, best);
      return fleeJob(pawn, best);
    }

    /* A hostile human. Undrafted colonists get out of the way and leave
       the fighting to whoever the player drafts. */
    if (bestD <= REACT_RAIDER) return fleeJob(pawn, best);
    return null;
  }

  /* Combat.hostile answers best when it is handed the two pawns: given only
     faction ids it cannot see a berserk colonist, a manhunter animal or a
     predator that has already picked its prey. */
  function hostileTo(pawn, other) {
    var C = sys('Combat');
    if (C && C.hostile && C.hostile(pawn, other)) return true;
    if (other.isAnimal && other.manhunter === true) return true;
    var G = sys('Game');
    return !!(G && G.hostile && G.hostile(pawn.faction, other.faction));
  }

  function fleeJob(pawn, from) {
    /* The flee driver reads targetA as where to run TO and targetB as what
       to run FROM. Passing the threat as targetA walked the colonist onto
       the thing chasing them. */
    var job = makeJob('flee', null, target('pawn', from), {});
    if (job) return job;
    /* No flee driver on hand: put ground between them the hard way. */
    var map = pawn.map;
    var dx = U.sign(pawn.x - from.x), dy = U.sign(pawn.y - from.y);
    for (var step = 8; step >= 3; step--) {
      var tx = U.clamp(pawn.x + dx * step, 0, map.w - 1);
      var ty = U.clamp(pawn.y + dy * step, 0, map.h - 1);
      if (map.passable(tx, ty)) return makeJob('goto', target('cell', tx, ty), null, {});
    }
    return null;
  }

  function findFoe(pawn) {
    var C = sys('Combat');
    if (!C || !C.findTarget) return null;
    return C.findTarget(pawn, { preferHumans: true });
  }

  /* 6. The colony is on fire or somebody is bleeding out. */
  function emergencyJob(pawn) {
    if (!isHuman(pawn) || pawn.drafted) return null;
    var W = sys('WorkGivers');
    if (!W || !W.emergency) return null;
    return W.emergency(pawn) || null;
  }

  /* 7. Needs that will not wait: starving, exhausted, or hurt badly
     enough that a bed and a doctor come before anything else. */
  function urgentNeedsJob(pawn) {
    if (!isHuman(pawn)) return null;
    if (need(pawn, 'food') < threshold('urgentlyHungry', 0.15) && !foodHuntFailed(pawn)) {
      var eat = makeJob('eat');
      if (eat) return eat;
    }
    if (need(pawn, 'rest') < threshold('veryTired', 0.14)) {
      var sleep = makeJob('sleep');
      if (sleep) return sleep;
    }
    return treatmentJob(pawn);
  }

  function treatmentJob(pawn) {
    if (!needsTreatment(pawn) || !canLieDown(pawn)) return null;
    var J = sys('Jobs');
    var bed = (J && J.findBed) ? J.findBed(pawn.map, pawn, { realBedOnly: false }) : null;
    if (!bed) return null;
    return lieDownJob(pawn, bed);
  }

  /* 8. Bedtime. */
  function scheduledSleepJob(pawn) {
    if (!isHuman(pawn) || !isSleepTime(pawn)) return null;
    if (need(pawn, 'rest') >= 0.75) return null;
    return makeJob('sleep');
  }

  /* 9. Hungry, but not desperate. */
  function hungerJob(pawn) {
    if (!isHuman(pawn)) return null;
    if (need(pawn, 'food') >= threshold('hungry', 0.30)) return null;
    if (foodHuntFailed(pawn)) return null;
    return makeJob('eat');
  }

  /* 10. Work. */
  function workJob(pawn) {
    if (!isHuman(pawn) || pawn.drafted) return null;
    var W = sys('WorkGivers');
    if (!W || !W.tryGiveWorkJob) return null;
    return W.tryGiveWorkJob(pawn) || null;
  }

  /* 11. Recreation. */
  function joyJob(pawn) {
    if (!isHuman(pawn)) return null;
    if (need(pawn, 'joy') >= JOY_WANT) return null;
    return makeJob('joyIdle');
  }

  /* 12. Nothing to do: stand somewhere that is not trying to kill you,
     and otherwise wander. */
  function idleJob(pawn) {
    return shelterJob(pawn) ||
           makeJob('wander') ||
           makeJob('wait', null, null, { count: 120 });
  }

  function shelterJob(pawn) {
    if (!isHuman(pawn)) return null;
    var R = sys('Regions');
    if (!R || !R.roomAt || !R.rooms) return null;

    var mind = mindOf(pawn), now = tickNow();
    if (now - mind.shelterTick < SHELTER_RESCAN) return null;
    mind.shelterTick = now;

    var here = R.roomAt(pawn.map, pawn.x, pawn.y);
    if (here && !here.outdoor && here.roofed) return null;
    var temp = outdoorTemp();
    if (temp > COMFY_MIN && temp < COMFY_MAX) return null;

    var spot = bestShelterCell(pawn.map, pawn, temp);
    if (!spot) return null;
    var job = makeJob('goto', target('cell', spot.x, spot.y));
    if (job) job.state.pe = 0;
    return job;
  }

  /* One candidate cell per indoor room, so the reachability probe stays
     cheap however many tiles the colony has enclosed. A room only counts
     if it is meaningfully kinder than the weather: an unheated shack in a
     blizzard is, a freezer is not. */
  function bestShelterCell(map, pawn, outside) {
    var R = sys('Regions');
    var rooms = R.rooms(map);
    if (!rooms || !rooms.forEach) return null;
    var outsideMiss = Math.abs(outside - COMFY_TARGET);
    var cands = [];
    rooms.forEach(function (room) {
      if (room.outdoor || !room.roofed || room.size < 4) return;
      var gain = outsideMiss - Math.abs(room.temperature - COMFY_TARGET);
      if (gain < 3) return;
      var i = room.cells[(room.cells.length / 2) | 0];
      var x = map.xOf(i), y = map.yOf(i);
      if (map.passable(x, y)) cands.push({ x: x, y: y, gain: gain });
    });
    if (!cands.length) return null;
    var P = sys('Path');
    if (!P || !P.closestReachable) return cands[0];
    /* Warmth is worth walking for, but not across the whole map: a degree
       of relief pays for about a tile and a half of travel. */
    return P.closestReachable(map, pawn, cands, function (c, d) { return c.gain * 1.5 - d; });
  }

  /* ------------------------------------------------------------------
     The tree itself
     ------------------------------------------------------------------ */

  var LEVELS = [
    { tier: TIER.DOWNED,    name: 'downed',    fn: downedJob },
    { tier: TIER.BURNING,   name: 'burning',   fn: burningJob },
    { tier: TIER.MENTAL,    name: 'mental',    fn: mentalJob },
    { tier: TIER.ORDERED,   name: 'ordered',   fn: queuedJob },
    { tier: TIER.DRAFTED,   name: 'drafted',   fn: draftedBranch },
    { tier: TIER.ANIMAL,    name: 'animal',    fn: animalJob },
    { tier: TIER.DEFEND,    name: 'defend',    fn: selfDefenceJob },
    { tier: TIER.FIGHT,     name: 'fight',     fn: fightBackJob },
    { tier: TIER.EMERGENCY, name: 'emergency', fn: emergencyJob },
    { tier: TIER.URGENT,    name: 'urgent',    fn: urgentNeedsJob },
    { tier: TIER.SLEEP,     name: 'bedtime',   fn: scheduledSleepJob },
    { tier: TIER.HUNGER,    name: 'hunger',    fn: hungerJob },
    { tier: TIER.WORK,      name: 'work',      fn: workJob },
    { tier: TIER.JOY,       name: 'joy',       fn: joyJob },
    { tier: TIER.IDLE,      name: 'idle',      fn: idleJob }
  ];
  Think.LEVELS = LEVELS;

  Think.think = function (pawn) {
    if (!pawn || pawn.dead || !pawn.map) return null;
    var mind = mindOf(pawn);
    for (var i = 0; i < LEVELS.length; i++) {
      var level = LEVELS[i];
      var job = level.fn(pawn);
      if (!job) continue;
      noteChoice(mind, level);
      return job;
    }
    return null;
  };

  /* If a rare-tick abandon claimed tier X was pressing and the tree then
     answered from below X, X was wrong about the world - a fire nobody
     can reach, a doctor with no route to the patient. Mute it for a
     while, or the pawn drops what they are holding every rare tick. */
  function noteChoice(mind, level) {
    if (mind.pendingTier && level.tier > mind.pendingTier) {
      mind.suppress[mind.pendingTier] = tickNow() + SUPPRESS_TICKS;
    }
    mind.pendingTier = 0;
    mind.lastLevel = level.name;
  }

  function allowed(mind, tier) {
    return (mind.suppress[tier] || 0) <= tickNow();
  }

  /* Which level would fire right now, judged with cheap tests only - no
     work scans, no pathfinding. Anything at or below WORK is "nothing
     pressing", which is why the walk stops there. */
  function urgentTier(pawn, mind) {
    if (pawn.downed) return TIER.DOWNED;
    if (allowed(mind, TIER.BURNING) && isBurning(pawn)) return TIER.BURNING;
    if (pawn.mentalState) return TIER.MENTAL;
    if (pawn.drafted) return aboutToCollapse(pawn) ? TIER.COLLAPSE : TIER.DRAFTED;
    if (pawn.jobQueue && pawn.jobQueue.length) return TIER.ORDERED;
    /* An animal's own head is the only judge of an animal's time. */
    if (pawn.isAnimal) return TIER.WORK;
    if (allowed(mind, TIER.FIGHT) && pawn.faction !== 'player' && findFoe(pawn)) return TIER.FIGHT;
    if (allowed(mind, TIER.EMERGENCY) && emergencyPending(pawn)) return TIER.EMERGENCY;
    if (allowed(mind, TIER.URGENT) && urgentNeedPending(pawn)) return TIER.URGENT;
    if (allowed(mind, TIER.SLEEP) && isHuman(pawn) && isSleepTime(pawn) &&
        need(pawn, 'rest') < 0.75) return TIER.SLEEP;
    if (allowed(mind, TIER.HUNGER) && isHuman(pawn) &&
        need(pawn, 'food') < threshold('hungry', 0.30) && !foodHuntFailed(pawn)) return TIER.HUNGER;
    return TIER.WORK;
  }

  function urgentNeedPending(pawn) {
    if (!isHuman(pawn)) return false;
    if (need(pawn, 'food') < threshold('urgentlyHungry', 0.15) && !foodHuntFailed(pawn)) return true;
    if (need(pawn, 'rest') < threshold('veryTired', 0.14)) return true;
    return needsTreatment(pawn);
  }

  /* The two things that make a colonist drop a crate: something burning
     within sight of the colony, and somebody bleeding out. Both are
     answered off maintained indexes, because this runs per pawn. */
  function emergencyPending(pawn) {
    if (!isHuman(pawn) || pawn.downed) return false;
    var map = pawn.map, i;

    if (map.byDef && (!pawn.capable || pawn.capable('firefight'))) {
      var fires = map.byDef('fire');
      for (i = 0; fires && i < fires.length; i++) {
        if (fires[i].spawned && U.dist(pawn.x, pawn.y, fires[i].x, fires[i].y) < 40) return true;
      }
    }

    if (map.colonists && (!pawn.capable || pawn.capable('doctor'))) {
      var H = sys('Health');
      if (!H || !H.bleedRate) return false;
      var list = map.colonists();
      for (i = 0; i < list.length; i++) {
        var p = list[i];
        if (p === pawn || p.dead) continue;
        if (H.bleedRate(p) > 0.12 && H.needsTending(p)) return true;
      }
    }
    return false;
  }

  /* What tier the job in hand belongs to. Read together with urgentTier,
     this is the whole anti-thrash rule: a pawn only ever breaks off for
     something strictly higher up the list than what they are doing. */
  Think.jobTier = function (pawn, job) {
    job = job || (pawn && pawn.job);
    if (!job) return TIER.IDLE;
    var id = job.defId;
    if (MENTAL_JOBS[id]) return TIER.MENTAL;
    if (pawn.drafted) return TIER.DRAFTED;
    if (id === 'layDown') return pawn.downed ? TIER.DOWNED : TIER.URGENT;
    if (id === 'sleep') {
      return need(pawn, 'rest') < threshold('veryTired', 0.14) ? TIER.URGENT : TIER.SLEEP;
    }
    if (id === 'eat') {
      return need(pawn, 'food') < threshold('urgentlyHungry', 0.15) ? TIER.URGENT : TIER.HUNGER;
    }
    if (id === 'extinguishFire') return isBurning(pawn) ? TIER.BURNING : TIER.EMERGENCY;
    if (FIGHT_JOBS[id]) return TIER.FIGHT;
    if (EMERGENCY_JOBS[id]) return TIER.EMERGENCY;
    if (id === 'joyIdle') return TIER.JOY;
    if (IDLE_JOBS[id]) return TIER.IDLE;
    return TIER.WORK;
  };

  Think.shouldAbandonJob = function (pawn) {
    var job = pawn && pawn.job;
    if (!job || pawn.dead) return false;
    var mind = mindOf(pawn);

    var want = urgentTier(pawn, mind);
    if (want >= TIER.WORK) return false;

    /* A player's own order, or a drafted stance, is only overruled by
       something that takes the pawn out of the player's hands. */
    if ((job.playerForced || pawn.drafted) && want > TIER.COLLAPSE) return false;

    if (want >= Think.jobTier(pawn, job)) return false;
    mind.pendingTier = want;
    return true;
  };

  /* ------------------------------------------------------------------
     Mental states
     ------------------------------------------------------------------ */

  function defOf(id) {
    var D = sys('Defs');
    return (D && D.maybe) ? D.maybe('mentalState', id) : null;
  }

  /* How long a break lasts belongs to the def, which states it either as
     a number of ticks or as a range to roll inside. The fallback is only
     for a state nobody registered. */
  function durationOf(def) {
    var v;
    if (def) {
      v = def.durationTicks !== undefined ? def.durationTicks : def.duration;
      if (typeof v === 'number') return v | 0;
      if (Array.isArray(v) && v.length === 2) return U.randInt(v[0], v[1]);
      if (typeof def.minTicks === 'number' && typeof def.maxTicks === 'number') {
        return U.randInt(def.minTicks, def.maxTicks);
      }
    }
    return U.randInt(DEFAULT_DURATION[0], DEFAULT_DURATION[1]);
  }

  function nameOf(pawn) {
    if (pawn.label) return pawn.label();
    var n = pawn.name;
    return (n && (n.nick || n.first)) || 'A colonist';
  }

  function isColonyPawn(pawn) {
    return pawn.faction === 'player';
  }

  function announceBreak(pawn, state) {
    if (!isColonyPawn(pawn)) return;
    var G = sys('Game');
    if (!G || !G.letter) return;
    var text = BREAK_TEXT[state.id] || {
      title: '{name} is having a mental break',
      body: '{name} has stopped working and cannot be reasoned with.',
      kind: 'neutral'
    };
    var who = nameOf(pawn);
    G.letter(text.title.replace('{name}', who), text.body.replace(/\{name\}/g, who), {
      kind: text.kind, x: pawn.x, y: pawn.y
    });
  }

  function announceRecovery(pawn, state) {
    if (!isColonyPawn(pawn)) return;
    var G = sys('Game');
    if (!G || !G.letter) return;
    var who = nameOf(pawn);
    /* The def labels a state for a heading ("Tantrum"); mid-sentence it
       wants to be lower case. */
    var label = (state.def && state.def.label) || state.id;
    label = label.charAt(0).toLowerCase() + label.slice(1);
    G.letter(who + ' has calmed down',
      who + ' is over their ' + label + ' and is back to work. Getting it out of their system ' +
      'has left them feeling a little better about things.',
      { kind: 'good', x: pawn.x, y: pawn.y });
  }

  Think.startMentalState = function (pawn, id) {
    if (!pawn || pawn.dead || !id) return false;
    if (pawn.mentalState) return false;

    var def = defOf(id);
    var state = { id: id, ticksLeft: durationOf(def), def: def };
    pawn.mentalState = state;

    /* Nobody breaks down to order, and nobody takes orders while broken
       down. Undrafting first also clears the stance combat is holding. */
    if (pawn.drafted && pawn.undraft) pawn.undraft();
    pawn.draftTarget = null;
    if (pawn.jobQueue) pawn.jobQueue.length = 0;
    endJob(pawn, 'interrupted');
    if (pawn.stopPath) pawn.stopPath();

    announceBreak(pawn, state);
    return true;
  };

  Think.endMentalState = function (pawn, reason) {
    var state = pawn && pawn.mentalState;
    if (!state) return false;
    pawn.mentalState = null;

    var mind = mindOf(pawn);
    /* Having just broken buys a day's grace, so a colonist who is still
       miserable does not break again the moment they stand up. */
    mind.immuneUntil = tickNow() + BREAK_IMMUNITY;

    if (pawn.job && MENTAL_JOBS[pawn.job.defId]) endJob(pawn, 'interrupted');

    /* Every state def names the thought its ending leaves behind, and
       every one of them names catharsis. */
    var N = sys('Needs');
    var thought = (state.def && state.def.thought) || 'catharsis';
    if (N && N.addThought && isHuman(pawn)) N.addThought(pawn, thought);

    if (reason !== 'downed') announceRecovery(pawn, state);
    return true;
  };

  Think.tickMental = function (pawn) {
    if (!pawn || pawn.dead) return;
    var mind = mindOf(pawn);
    mind.ticks++;

    var state = pawn.mentalState;
    if (state) { tickState(pawn, state); return; }

    /* Everything below is a rare tick's worth of work, staggered across
       pawns by the id the mind was seeded with. */
    if ((mind.ticks % RARE) !== 0) return;

    if (breakCheck(pawn, mind)) return;

    /* The abandon check lives here because this is the one hook the pawn
       tick gives think.js every tick, and a decision nobody acts on is
       not behaviour. */
    if (pawn.job && Think.shouldAbandonJob(pawn)) endJob(pawn, 'interrupted');
  };

  function tickState(pawn, state) {
    if (!state.def) state.def = defOf(state.id);
    if (typeof state.ticksLeft !== 'number') state.ticksLeft = durationOf(state.def);
    state.ticksLeft--;

    if (pawn.downed || (pawn.health && pawn.health.dead)) {
      Think.endMentalState(pawn, 'downed');
      return;
    }
    /* Nobody sulks through starvation. Without this a colonist who broke
       down while hungry dies of it, and the player has no move to make -
       which is a spiral, not a setback. A binge is already eating. */
    if (state.id !== 'foodBinge' && need(pawn, 'food') <= 0.001) {
      Think.endMentalState(pawn, 'starving');
      return;
    }
    if (state.ticksLeft <= 0) Think.endMentalState(pawn, 'ended');
  }

  /* Per-hour odds converted to this rare tick's slice of an hour. */
  function perRareChance(perHour) {
    return 1 - Math.pow(1 - perHour, RARE / TICKS_PER_HOUR);
  }

  function breakCheck(pawn, mind) {
    if (!isHuman(pawn) || !isColonyPawn(pawn)) return false;
    if (pawn.downed || pawn.mentalState) return false;
    if (tickNow() < mind.immuneUntil) return false;

    var N = sys('Needs');
    if (!N || !N.mood) return false;
    var mood = N.mood(pawn);
    var t = (N.breakThresholds ? N.breakThresholds(pawn) : pawn.breakThresholds) || DEFAULT_THRESHOLDS;

    var band = null;
    if (mood < t.extreme) band = 'extreme';
    else if (mood < t.major) band = 'major';
    else if (mood < t.minor) band = 'minor';
    if (!band) return false;

    if (!U.chance(perRareChance(BREAK_CHANCE_PER_HOUR[band]))) return false;
    return Think.startMentalState(pawn, U.pick(BREAK_STATES[band]));
  }

  /* What the pawn last decided and why, for the inspect panel and for
     anyone debugging a colonist who will not pick up a rock. */
  Think.lastLevel = function (pawn) {
    var m = pawn && pawn._mind;
    return m ? (m.lastLevel || 'none') : 'none';
  };

  Think.mentalImmuneUntil = function (pawn) {
    return pawn && pawn._mind ? pawn._mind.immuneUntil : 0;
  };

  root.Think = Think;
})(this);
