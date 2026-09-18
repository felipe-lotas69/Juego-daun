/* ============================================================
   animals.js - wildlife: what a beast decides to do, how the colony
   hunts, tames, trains and slaughters it, and what happens when any
   of that goes wrong.

   Three ideas run through the file.

   An animal's brain is a short priority list, not a plan. think() runs
   for every idle animal and a map carries dozens of them, so every
   branch above "wander" is either a field read or a scan held behind a
   timer kept on the animal itself.

   Danger is asymmetric. Prey panics at twelve tiles from anything that
   might eat it; a predator looks for the easiest meal within thirty and
   will take a lone human once it is hungry enough. That asymmetry is
   the whole reason a wolf crossing the fields is frightening.

   Nothing stored here is state a save cannot carry. Everything this
   file writes onto a pawn lives under pawn.animalMind and is numbers
   and ids only, so a reloaded colony wakes with the same animals in
   the same mood.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;
  var Jobs = root.Jobs, Toils = root.Toils, T = root.T;

  var Animals = {};

  /* ---------- tuning ----------
     Food thresholds are on the 0..1 need, so 0.72 means "three quarters
     fed and already looking at the grass": grazers eat almost constantly
     and predators hold out much longer between kills. */
  var GRAZE_AT = 0.72;
  var PREDATOR_HUNT_AT = 0.60;
  var PREDATOR_MAN_EATER_AT = 0.42;   /* below this a predator will take a human */
  var PANIC_RANGE = 12;
  var PREY_RADIUS = 30;
  var GRAZE_RADIUS = 9;
  var SCAN_TICKS = 40;                /* between threat scans for one animal */
  var FLEE_STAMINA = 900;             /* how long anything can keep running */
  var PREY_SCAN_TICKS = 300;
  var HUNT_GIVE_UP = 9000;            /* 2.5 minutes of real chasing */
  var MANHUNTER_MIN = 18000, MANHUNTER_MAX = 52000;
  var TRAIN_STEPS = { obedience: 4, release: 6 };
  var RARE_TICKS = 250;
  var BREED_PER_DAY = 0.07;
  var TAME_CAP = 30;
  var FOOD_FALL_PER_DAY = 1.6;        /* only used when needs.js is absent */

  /* ---------- species data ----------
     def_pawns.js owns the pawnKind defs and its numbers always win. This
     table only fills gaps, so the day a kind def grows a `wildness` field
     it silently takes over from the number here and nothing else moves. */
  var KIND_INFO = {
    hare:    { bodySize: 0.3, wildness: 0.35, trainability: 'none',         packSize: [1, 3], revengeChance: 0.00, manhunterOnTameFail: 0.00, breeds: true },
    deer:    { bodySize: 0.75, wildness: 0.70, trainability: 'none',         packSize: [2, 5], revengeChance: 0.02, manhunterOnTameFail: 0.01, breeds: true },
    muffalo: { bodySize: 2.1, wildness: 0.75, trainability: 'intermediate', packSize: [3, 6], revengeChance: 0.04, manhunterOnTameFail: 0.02, breeds: true },
    boomrat: { bodySize: 0.4, wildness: 0.50, trainability: 'intermediate', packSize: [1, 4], revengeChance: 0.06, manhunterOnTameFail: 0.03, breeds: true,
               nocturnal: true, explodes: true },
    wolf:    { bodySize: 0.75, wildness: 0.90, trainability: 'advanced',     packSize: [1, 3], revengeChance: 0.07, manhunterOnTameFail: 0.08,
               predator: true, grazer: false, nocturnal: true },
    bear:    { bodySize: 1.9, wildness: 0.97, trainability: 'advanced',     packSize: [1, 2], revengeChance: 0.10, manhunterOnTameFail: 0.12,
               predator: true, grazer: false }
  };

  var KIND_DEFAULT = {
    bodySize: 0.7, wildness: 0.6, trainability: 'none', predator: false, grazer: true,
    nocturnal: false, explodes: false, breeds: false, packSize: [1, 3],
    revengeChance: 0.05, manhunterOnTameFail: 0.02, butcherProducts: null
  };

  /* Merged view of a species, memoised because defs never change once
     the game is running. */
  var _info = {};
  function info(kindId) {
    var got = _info[kindId];
    if (got) return got;
    var out = {}, key;
    for (key in KIND_DEFAULT) out[key] = KIND_DEFAULT[key];
    var fb = KIND_INFO[kindId];
    if (fb) for (key in fb) out[key] = fb[key];
    var def = Defs && Defs.maybe ? Defs.maybe('pawnKind', kindId) : null;
    if (def) {
      var nested = def.animal || null;
      for (key in KIND_DEFAULT) {
        if (def[key] !== undefined && def[key] !== null) out[key] = def[key];
        else if (nested && nested[key] !== undefined && nested[key] !== null) out[key] = nested[key];
      }
      out.label = def.label || kindId;
      /* Whether a species grazes is read off what it eats, not off the
         grazer flag: def_pawns.js states that flag once, in the defaults
         block every animal kind shares, so it says the same thing about a
         wolf as about a deer whichever way it is set. Diet and predator
         are the fields that actually vary per kind. */
      out.grazer = out.predator !== true && def.diet !== 'carnivore';
      /* def_pawns.js spells the boomrat's party trick two ways and states
         the blast it makes; both are taken so the numbers live in one
         place rather than being repeated here. */
      if (def.explodeOnDeath === true || def.explosionRadius > 0) out.explodes = true;
      if (def.explosionRadius > 0) out.explosionRadius = def.explosionRadius;
      if (def.explosionDamage > 0) out.explosionDamage = def.explosionDamage;
      if (def.explosionType) out.explosionType = def.explosionType;
    }
    if (!out.label) out.label = kindId;
    if (!out.explosionRadius) out.explosionRadius = 2.9;
    if (!out.explosionDamage) out.explosionDamage = 10;
    if (!out.explosionType) out.explosionType = 'flame';
    out.id = kindId;
    /* Meat and leather scale off body size unless the def says otherwise.
       0.05 nutrition per unit of raw meat means a deer is worth about two
       and a half simple meals, which is what makes hunting worth the risk. */
    if (!out.meat) out.meat = Math.max(1, Math.round(out.bodySize * 70));
    if (!out.leather) out.leather = Math.max(0, Math.round(out.bodySize * 35));
    _info[kindId] = out;
    return out;
  }

  /* ---------- engine modules ----------
     Read at call time rather than captured at load: mapgen.js and game.js
     come after this file, and nothing here runs before the first tick. */
  function now() { var G = root.Game; return (G && typeof G.tick === 'number') ? G.tick : 0; }

  function msg(text, type, at) {
    var G = root.Game;
    if (G && G.msg) G.msg(text, { type: type || 'info', x: at ? at.x : undefined, y: at ? at.y : undefined });
  }
  function letter(title, text, kind, at) {
    var G = root.Game;
    if (G && G.letter) G.letter(title, text, { kind: kind || 'neutral', x: at ? at.x : undefined, y: at ? at.y : undefined });
    else msg(title, kind === 'threat' ? 'threat' : 'info', at);
  }

  /* ---------- pawn helpers ---------- */

  function mindOf(pawn) {
    var m = pawn.animalMind;
    if (m) return m;
    m = pawn.animalMind = {
      manhunterTicks: 0, revengeId: 0, threatId: 0, fleeUntil: 0, nextScan: 0,
      fleeSince: 0, windedUntil: 0,
      preyId: 0, nextPrey: 0, nextRare: 0, grazeIdx: 0, nextGraze: 0, releaseTargetId: 0,
      tameWork: 0, trainWork: 0, slaughterWork: 0, releaseWork: 0,
      desType: '', desX: -1, desY: -1,
      lastJob: '', lastJobTick: -99, repeats: 0, deathDone: 0, ownNeeds: 0
    };
    return m;
  }

  function labelOf(pawn) {
    if (pawn.name && pawn.name.nick) return pawn.name.nick;
    return info(pawn.kindId).label;
  }
  function nameOf(pawn) {
    if (!pawn) return 'someone';
    if (pawn.name) return pawn.name.nick || ((pawn.name.first || '') + ' ' + (pawn.name.last || '')).trim();
    return 'someone';
  }

  function foodOf(pawn) { return pawn.needs && typeof pawn.needs.food === 'number' ? pawn.needs.food : 1; }
  function restOf(pawn) { return pawn.needs && typeof pawn.needs.rest === 'number' ? pawn.needs.rest : 1; }
  function addFood(pawn, amount) {
    if (!pawn.needs) return;
    pawn.needs.food = U.clamp01(pawn.needs.food + amount);
  }
  function painOf(pawn) {
    var H = root.Health;
    if (H && H.painLevel) return H.painLevel(pawn);
    return pawn.health && pawn.health.pain || 0;
  }
  function bleedOf(pawn) {
    var H = root.Health;
    if (H && H.bleedRate) return H.bleedRate(pawn);
    return 0;
  }
  function injuryCount(pawn) {
    return pawn.health && pawn.health.injuries ? pawn.health.injuries.length : 0;
  }
  function skillLevel(pawn, id) {
    var s = pawn && pawn.skills && pawn.skills[id];
    return s && typeof s.level === 'number' ? s.level : 0;
  }

  /* Work units per tick, the same curve the contract quotes for every
     other worker: 0.4 at level 0, 2.0 at level 20, scaled by how well
     the body still works. */
  function workRate(pawn, skillId) {
    var H = root.Health;
    var f = H && H.workSpeedFactor ? H.workSpeedFactor(pawn) : 1;
    return (0.4 + 0.08 * skillLevel(pawn, skillId)) * f;
  }

  /* pawn.js may expose its own xp entry point; if it does not, the
     contract's own numbers are enough to do it here. */
  function gainSkill(pawn, skillId, xp) {
    if (!pawn || !pawn.skills || xp <= 0) return;
    var P = root.Pawn;
    if (P) {
      if (typeof P.learn === 'function') { P.learn(pawn, skillId, xp); return; }
      if (typeof P.gainXp === 'function') { P.gainXp(pawn, skillId, xp); return; }
    }
    var s = pawn.skills[skillId];
    if (!s) return;
    var passion = [0.35, 1.0, 1.5][s.passion || 0] || 1;
    s.xp = (s.xp || 0) + xp * passion;
    while (s.level < 20 && s.xp >= 1000 * (s.level + 1)) {
      s.xp -= 1000 * (s.level + 1);
      s.level++;
    }
  }

  function faceToward(pawn, target) {
    var dx = target.x - pawn.x, dy = target.y - pawn.y;
    if (Math.abs(dx) > Math.abs(dy)) pawn.dir = dx > 0 ? 1 : 3;
    else if (dy !== 0) pawn.dir = dy > 0 ? 2 : 0;
  }

  function pawnById(map, id) {
    if (!id || !map) return null;
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function nearestPawn(map, x, y, radius, filter) {
    var best = null, bestD = radius * radius, list = map.pawns, i, p, d;
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (p.dead || !filter(p)) continue;
      d = U.distSq(x, y, p.x, p.y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /* ---------- movement ----------
     Toils.goto walks right up to what it is sent at, which is wrong for a
     hunter who wants to stop at rifle range and for a tamer chasing an
     animal that keeps drifting. Those two cases steer the pawn directly
     through the movement fields the contract freezes onto every pawn. */
  function walkTo(pawn, x, y) {
    var P = root.Pawn, map = pawn.map;
    if (P) {
      if (typeof P.startPath === 'function') return P.startPath(pawn, x, y) !== false;
      if (typeof P.pathTo === 'function') return P.pathTo(pawn, x, y) !== false;
      if (typeof P.goTo === 'function') return P.goTo(pawn, x, y) !== false;
    }
    var dest = map.idx(x, y);
    if (pawn.pathDest === dest && pawn.path && pawn.pathIdx < pawn.path.length) return true;
    var Path = root.Path;
    if (!Path) return false;
    var path = Path.find(map, pawn.x, pawn.y, x, y, { pawn: pawn });
    if (!path) return false;
    pawn.path = path;
    pawn.pathIdx = 0;
    pawn.moveProgress = 0;
    pawn.destX = x; pawn.destY = y; pawn.pathDest = dest;
    return true;
  }

  /* pawn.js's own stopPath is the one that leaves the pawn in a state
     tickMove and onStepBlocked agree about - it clears moveProgress and
     snaps fx/fy back onto the tile, so a pawn halted mid-step does not
     stay drawn between two of them. */
  function stopMoving(pawn) {
    if (typeof pawn.stopPath === 'function') { pawn.stopPath(); return; }
    pawn.path = null;
    pawn.pathIdx = 0;
    pawn.moveProgress = 0;
    pawn.pathDest = -1;
    pawn.fx = pawn.x; pawn.fy = pawn.y;
  }

  function cellOk(map, pawn, x, y) {
    if (!map.inBounds(x, y) || !map.passable(x, y)) return false;
    var R = root.Regions;
    if (R && R.sameArea && !R.sameArea(map, pawn.x, pawn.y, x, y)) return false;
    return true;
  }

  function randomNearbyCell(pawn, map, radius) {
    for (var i = 0; i < 10; i++) {
      var x = pawn.x + U.randInt(-radius, radius);
      var y = pawn.y + U.randInt(-radius, radius);
      if ((x !== pawn.x || y !== pawn.y) && cellOk(map, pawn, x, y)) return { x: x, y: y };
    }
    return null;
  }

  function cellNear(map, pawn, cx, cy, radius) {
    var ring = ringOffsets(radius);
    for (var i = 0; i < ring.length; i++) {
      var x = cx + ring[i][0], y = cy + ring[i][1];
      if (cellOk(map, pawn, x, y)) return { x: x, y: y };
    }
    return null;
  }

  /* U.cellsInRadius sorts every time it is called; grazing calls it for
     every hungry animal, so the offsets are built once per radius. */
  var _ring = {};
  function ringOffsets(r) {
    if (!_ring[r]) _ring[r] = U.cellsInRadius(0, 0, r);
    return _ring[r];
  }

  /* ============================================================
     THE ANIMAL BRAIN
     ============================================================ */

  Animals.think = function (pawn) {
    if (!pawn || pawn.isAnimal !== true || pawn.dead || pawn.downed || !pawn.map) return null;
    /* The rare tick is driven from here as well as from pawn.js, because
       an animal whose rare tick never runs never stops being a manhunter,
       never drags its designation along behind it and never breeds. Both
       callers go through the same 250-tick stamp, so whichever arrives
       first does the work and the other costs one comparison. */
    Animals.tickRare(pawn);
    return vet(pawn, decide(pawn));
  };

  /* A job def that fails the instant it starts would otherwise spin an
     animal at one job per tick forever. Four identical handouts inside
     four ticks and the animal sits down instead. */
  function vet(pawn, job) {
    if (!job) return null;
    var t = now();
    if (!t) return job;
    var mind = mindOf(pawn);
    if (job.defId === mind.lastJob && t - mind.lastJobTick < 4) {
      if (++mind.repeats > 3) {
        mind.repeats = 0;
        mind.lastJob = 'wait';
        mind.lastJobTick = t;
        return waitJob(pawn, U.randInt(120, 260));
      }
    } else {
      mind.repeats = 0;
    }
    mind.lastJob = job.defId;
    mind.lastJobTick = t;
    return job;
  }

  function decide(pawn) {
    var map = pawn.map, mind = mindOf(pawn), k = info(pawn.kindId), tick = now();

    if (mind.manhunterTicks > 0) return manhunterJob(pawn, mind, map);

    /* An animal its master has set on something goes, and keeps going. */
    if (pawn.tame && mind.releaseTargetId) {
      var victim = pawnById(map, mind.releaseTargetId);
      if (victim && !victim.dead && !victim.downed && U.dist(pawn.x, pawn.y, victim.x, victim.y) < 40) {
        return Jobs.make('attackMelee', T.pawn(victim));
      }
      mind.releaseTargetId = 0;
    }

    var threat = null;
    if (mind.windedUntil <= tick) {
      if (mind.fleeUntil > tick) {
        threat = pawnById(map, mind.threatId);
        if (threat && (threat.dead || U.dist(pawn.x, pawn.y, threat.x, threat.y) > 22)) threat = null;
      }
      if (!threat && tick >= mind.nextScan) {
        mind.nextScan = tick + SCAN_TICKS;
        threat = findThreat(pawn, k, map);
        if (threat) {
          mind.threatId = threat.id;
          mind.fleeUntil = tick + U.randInt(240, 600);
        }
      }
    }
    if (!threat) {
      mind.fleeSince = 0;
    } else if (!mind.fleeSince) {
      mind.fleeSince = tick;
    }
    /* Nothing runs for ever. An animal that has been fleeing for a quarter
       of a minute straight is blown and stands whatever it wants to do,
       which is the only reason a predator ever catches anything and the
       only reason a hunter with a knife ever comes home with meat. */
    if (threat && tick - mind.fleeSince > FLEE_STAMINA) {
      mind.windedUntil = tick + 700;
      mind.fleeSince = 0;
      mind.fleeUntil = 0;
      threat = null;
    }
    if (threat) {
      var run = fleeJob(pawn, threat, map);
      if (run) return run;
    }

    if (k.predator) {
      var hunt = predatorJob(pawn, mind, k, map, tick);
      if (hunt) return hunt;
    }

    if (pawn.tame && pawn.master) {
      var follow = followMaster(pawn, map);
      if (follow) return follow;
    }

    if (foodOf(pawn) < GRAZE_AT) {
      var feed = grazeJob(pawn, mind, k, map, tick);
      if (feed) return feed;
    }

    if (wantsSleep(pawn, k)) return Jobs.make('layDown', T.cell(pawn.x, pawn.y));

    return wanderJob();
  }

  /* jobs.js's wander toil picks its own legs and its own cells and never
     looks at a target, so handing it one is work thrown away - and worse,
     an animal that momentarily could not find a cell would sit down
     instead of browsing. All it reads is the number of legs. */
  function wanderJob() {
    return Jobs.make('wander', null, null, { count: U.randInt(2, 4) });
  }

  /* jobs.js's wait def reads its length off job.count, and the Job
     constructor keeps no other field that could carry one. */
  function waitJob(pawn, ticks) {
    return Jobs.make('wait', T.cell(pawn.x, pawn.y), null, { count: ticks });
  }

  /* ---------- fear ---------- */

  function findThreat(pawn, k, map) {
    var hurt = painOf(pawn) > 0.18 || bleedOf(pawn) > 0.04;
    /* A predator is nobody's prey until something has already hurt it. */
    if (k.predator && !hurt) return null;
    var radius = hurt ? 16 : PANIC_RANGE;
    var tame = pawn.tame === true;
    return nearestPawn(map, pawn.x, pawn.y, radius, function (p) {
      if (p === pawn || p.downed) return false;
      if (p.isAnimal) {
        if (p.kindId === pawn.kindId) return false;
        if (tame && p.faction === pawn.faction) return false;
        var pk = info(p.kindId);
        if (isManhunter(p)) return true;
        return pk.predator && pk.bodySize > k.bodySize * 0.7;
      }
      /* People are only frightening once they have drawn blood - which is
         exactly what makes a hunt go loud and send the herd running. */
      if (!hurt) return false;
      return !tame;
    });
  }

  function fleeJob(pawn, threat, map) {
    var dest = fleeDest(pawn, threat.x, threat.y, map);
    if (!dest) return null;
    return Jobs.make('goto', T.cell(dest.x, dest.y));
  }

  function fleeDest(pawn, tx, ty, map) {
    var dx = pawn.x - tx, dy = pawn.y - ty;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;
    for (var i = 0; i < 6; i++) {
      var a = i === 0 ? 0 : U.randRange(-1.1, 1.1);
      var cos = Math.cos(a), sin = Math.sin(a);
      var ux = dx * cos - dy * sin, uy = dx * sin + dy * cos;
      var d = U.randInt(9, 15);
      var x = Math.round(pawn.x + ux * d), y = Math.round(pawn.y + uy * d);
      if (cellOk(map, pawn, x, y)) return { x: x, y: y };
    }
    return randomNearbyCell(pawn, map, 10);
  }

  /* ---------- manhunting ---------- */

  function manhunterJob(pawn, mind, map) {
    var victim = mind.revengeId ? pawnById(map, mind.revengeId) : null;
    if (victim && (victim.dead || U.dist(pawn.x, pawn.y, victim.x, victim.y) > 45)) victim = null;
    if (!victim) {
      victim = nearestPawn(map, pawn.x, pawn.y, 60, function (p) {
        if (p === pawn || p.dead) return false;
        if (p.isHuman) return true;
        return p.faction === 'player' && p.isAnimal === true;
      });
      if (victim) mind.revengeId = victim.id;
    }
    if (!victim) return wanderJob();
    var R = root.Regions;
    if (R && R.sameArea && !R.sameArea(map, pawn.x, pawn.y, victim.x, victim.y)) {
      mind.revengeId = 0;
      return wanderJob();
    }
    return Jobs.make('attackMelee', T.pawn(victim));
  }

  /* ---------- predators ----------
     The targeting rule, stated plainly because it decides how frightening
     the early game is: take other animals first, in a size band the
     predator can actually pull down; only when properly hungry will it
     look at a human, and then only one that is downed or on their own. */

  function predatorJob(pawn, mind, k, map, tick) {
    var food = foodOf(pawn);

    if (food < 0.85) {
      var kill = nearestCorpse(map, pawn, 20);
      if (kill) {
        if (U.cheb(pawn.x, pawn.y, kill.x, kill.y) <= 1) return biteCorpse(pawn, k, kill, map);
        return Jobs.make('goto', T.cell(kill.x, kill.y));
      }
    }

    /* combat.js reads mind.preyId to decide that this animal is hostile to
       that one pawn, so a predator that has stopped hunting must be seen
       to have stopped: a fed wolf is not stalking anybody. */
    if (food > PREDATOR_HUNT_AT) { mind.preyId = 0; return null; }

    var prey = mind.preyId ? pawnById(map, mind.preyId) : null;
    if (prey && (prey.dead || U.dist(pawn.x, pawn.y, prey.x, prey.y) > 40)) prey = null;
    if (!prey) mind.preyId = 0;
    if (!prey && tick >= mind.nextPrey) {
      mind.nextPrey = tick + PREY_SCAN_TICKS;
      prey = pickPrey(pawn, k, map, food < PREDATOR_MAN_EATER_AT);
      mind.preyId = prey ? prey.id : 0;
      if (prey && prey.isHuman && prey.faction === 'player') {
        letter('Predator hunting',
          U.cap(info(pawn.kindId).label) + ' is stalking ' + nameOf(prey) + '.',
          'threat', pawn);
      }
    }
    if (!prey) return null;

    /* Combat stops at downed, because a colonist who drops an enemy wants
       a prisoner, not a corpse. A predator wants the corpse: it finishes
       what it has pulled down before it eats. */
    if (prey.downed) {
      if (U.cheb(pawn.x, pawn.y, prey.x, prey.y) > 1) return Jobs.make('goto', T.cell(prey.x, prey.y));
      killAnimal(prey, pawn, 'killed by a ' + info(pawn.kindId).label);
      mind.preyId = 0;
      return waitJob(pawn, 60);
    }

    /* Stalk in from a distance, then commit. */
    if (U.dist(pawn.x, pawn.y, prey.x, prey.y) > 12) return Jobs.make('goto', T.cell(prey.x, prey.y));
    return Jobs.make('attackMelee', T.pawn(prey));
  }

  function pickPrey(pawn, k, map, manEater) {
    var best = null, bestScore = 0, list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i], score;
      if (p === pawn || p.dead || p.kindId === pawn.kindId) continue;
      if (pawn.faction === 'player' && p.faction === 'player') continue;
      var d = U.dist(pawn.x, pawn.y, p.x, p.y);
      if (d > PREY_RADIUS) continue;
      if (p.isAnimal) {
        var pk = info(p.kindId);
        if (pk.bodySize > k.bodySize * 1.35) continue;
        if (pk.predator && pk.bodySize >= k.bodySize * 0.9) continue;
        score = 1 + pk.bodySize + (p.downed ? 1 : 0);
      } else {
        if (!manEater) continue;
        if (!p.downed && !isAlone(map, p)) continue;
        score = p.downed ? 1.8 : 0.9;
      }
      var R = root.Regions;
      if (R && R.sameArea && !R.sameArea(map, pawn.x, pawn.y, p.x, p.y)) continue;
      score /= 6 + d;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    return best;
  }

  function isAlone(map, human) {
    var friend = nearestPawn(map, human.x, human.y, 12, function (p) {
      return p !== human && p.isHuman && !p.downed && p.faction === human.faction;
    });
    return !friend;
  }

  function nearestCorpse(map, pawn, radius) {
    if (!map.byDef) return null;
    var list = map.byDef('corpse'), best = null, bestD = radius * radius;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c.spawned || (c.eatenFrac || 0) >= 0.99) continue;
      var d = U.distSq(pawn.x, pawn.y, c.x, c.y);
      if (d >= bestD) continue;
      var R = root.Regions;
      if (R && R.sameArea && !R.sameArea(map, pawn.x, pawn.y, c.x, c.y)) continue;
      bestD = d; best = c;
    }
    return best;
  }

  function biteCorpse(pawn, k, corpse, map) {
    var eaten = corpse.eatenFrac || 0;
    var bite = Math.min(1 - eaten, 0.22);
    corpse.eatenFrac = eaten + bite;
    var total = corpse.def && corpse.def.nutrition ? corpse.def.nutrition : 2.5;
    addFood(pawn, total * bite / Math.max(0.5, k.bodySize));
    if (corpse.eatenFrac >= 0.99) map.destroyThing(corpse, 'eaten');
    stopMoving(pawn);
    return waitJob(pawn, U.randInt(120, 220));
  }

  /* ---------- grazing ---------- */

  function edible(plant) {
    return !!(plant && plant.def && plant.def.nutrition > 0 && plant.growth >= 0.1);
  }

  function grazeJob(pawn, mind, k, map, tick) {
    if (!k.grazer) return null;
    var here = map.plantAt(pawn.x, pawn.y);
    if (edible(here)) return bitePlant(pawn, k, here, map);

    var target = null;
    if (mind.grazeIdx > 0) {
      var gp = map.plantAt(map.xOf(mind.grazeIdx), map.yOf(mind.grazeIdx));
      if (edible(gp)) target = gp; else mind.grazeIdx = 0;
    }
    if (!target && tick >= mind.nextGraze) {
      mind.nextGraze = tick + 120;
      target = findGraze(pawn, map);
      mind.grazeIdx = target ? map.idx(target.x, target.y) : 0;
    }
    if (!target) return null;
    return Jobs.make('goto', T.cell(target.x, target.y));
  }

  function findGraze(pawn, map) {
    var ring = ringOffsets(GRAZE_RADIUS), best = null, bestScore = 0;
    var Z = root.Zones, tame = pawn.faction === 'player';
    for (var i = 0; i < ring.length; i++) {
      var x = pawn.x + ring[i][0], y = pawn.y + ring[i][1];
      if (!map.inBounds(x, y)) continue;
      var pl = map.plantAt(x, y);
      if (!edible(pl)) continue;
      var score = pl.def.nutrition * pl.growth;
      /* A tame animal grazing the crop field is a disaster the player did
         not ask for, so sown ground is a last resort. */
      if (pl.sown || (tame && Z && Z.zoneAt && Z.zoneAt(map, x, y))) score *= 0.15;
      score /= 1 + 0.18 * U.dist(pawn.x, pawn.y, x, y);
      if (score <= bestScore) continue;
      if (!cellOk(map, pawn, x, y)) continue;
      bestScore = score; best = pl;
      /* The ring is sorted nearest-first, so once something decent is in
         hand there is no point walking the whole disc. Stopping before
         anything was found would quietly shrink the search radius. */
      if (best && i > 90) break;
    }
    return best;
  }

  /* Taking the mouthful and standing still to chew it are separate, because
     the rare tick eats what is already underfoot without wanting to cancel
     whatever the animal was walking towards. */
  function eatPlant(pawn, k, plant, map) {
    var take = Math.min(plant.growth, U.clamp(0.3 * k.bodySize, 0.15, 1));
    plant.growth -= take;
    addFood(pawn, (plant.def.nutrition * take * 2.2) / Math.max(0.5, Math.sqrt(k.bodySize)));
    if (plant.growth <= 0.04) map.destroyThing(plant, 'eaten');
  }

  function bitePlant(pawn, k, plant, map) {
    eatPlant(pawn, k, plant, map);
    stopMoving(pawn);
    return waitJob(pawn, U.randInt(90, 170));
  }

  /* ---------- rest and company ---------- */

  function wantsSleep(pawn, k) {
    var G = root.Game;
    var hour = G && G.hour ? G.hour() : 12;
    var dark = hour < 6 || hour >= 21;
    var itsBedtime = k.nocturnal ? !dark : dark;
    return itsBedtime ? restOf(pawn) < 0.85 : restOf(pawn) < 0.18;
  }

  function followMaster(pawn, map) {
    if (!isTrained(pawn, 'obedience')) return null;
    var m = pawnById(map, pawn.master);
    if (!m || m.dead) return null;
    var d = U.dist(pawn.x, pawn.y, m.x, m.y);
    if (d < 6 || d > 60) return null;
    var c = cellNear(map, pawn, m.x, m.y, 3);
    return c ? Jobs.make('goto', T.cell(c.x, c.y)) : null;
  }

  /* ============================================================
     THE COLONY'S SIDE: hunting, taming, training, slaughter
     ============================================================ */

  /* Combat.weaponOf is asked first because it also resolves a weapon that
     came back from a save carrying only its defId; reading equipment.def
     alone would disarm every hunter across a reload. */
  function weaponRange(pawn) {
    var Combat = root.Combat;
    var w = (Combat && Combat.weaponOf) ? Combat.weaponOf(pawn) : null;
    if (!w) {
      var eq = pawn && pawn.equipment;
      w = eq && eq.def ? eq.def.weapon : null;
    }
    if (!w || !w.ranged) return 0;
    return w.range > 1.5 ? w.range : 0;
  }
  Animals.huntRange = weaponRange;

  /* combat.js keeps its own aim/burst/cooldown stance and expects
     tryAttack every tick to advance it, so a hunter holds the trigger
     down rather than pulling it once. Breaking off has to drop the aim
     or the shooter stays locked on something it is walking away from. */
  function clearStance(pawn) {
    var Combat = root.Combat;
    if (Combat && Combat.clearStance) Combat.clearStance(pawn);
    else { pawn.stanceTicks = 0; pawn.aimTarget = null; }
  }

  function killAnimal(animal, killer, cause) {
    var H = root.Health;
    if (H && H.kill) H.kill(animal, cause || 'killed');
    else if (H && H.damage) H.damage(animal, { amount: 9999, type: 'cut', instigator: killer });
    else { animal.dead = true; animal.downed = false; }
    Animals.notifyDeath(animal, killer);
  }

  /* combat.js pays the xp for each shot taken; this is the lump the hunt
     itself is worth, paid once when the quarry goes down, so a hunt still
     teaches a colonist something even when the kill came from one lucky
     shot at the treeline. */
  function creditKill(pawn, s) {
    if (s.credited) return;
    s.credited = 1;
    gainSkill(pawn, weaponRange(pawn) ? 'shooting' : 'melee', 40);
  }

  /* The quarry of every hunt in progress, by job id.

     A bullet kills between one tick and the next, and the moment it does
     pawn.js takes the animal off map.pawns and T.resolve starts answering
     null - so by the time the driver notices, the only way back to the
     pawn that just died is a reference kept from the tick before. It is
     held here rather than in job.state because save.js writes a job
     straight out and a pawn in there would drag the map through the
     serialiser. The toil's end handler always runs, on the step to the
     next toil and on any failure, so nothing outlives its hunt. */
  var _quarry = new Map();

  function makeCorpse(map, state) {
    if (!Defs.has('thing', 'corpse') || !map.spawnThing) return null;
    return map.spawnThing('corpse', state.x, state.y, {
      corpse: {
        name: state.preyName, kindId: state.preyKind, faction: 'wild',
        rotTicks: 0, pawnId: state.preyId
      }
    });
  }

  function corpseOf(map, pawnId) {
    if (!map.byDef || !pawnId) return null;
    var list = map.byDef('corpse');
    for (var i = 0; i < list.length; i++) {
      if (list[i].corpse && list[i].corpse.pawnId === pawnId) return list[i];
    }
    return null;
  }


  /* ---------- hunt ---------- */

  Jobs.register('hunt', {
    label: 'hunt',
    reportString: 'Hunting {A}.',
    suspendable: true,
    toils: function () {
      var PE = root.Path.PE;
      return [
        huntKillToil(),
        huntCorpseToil(),
        Toils.goto('B', { pe: PE.TOUCH, failIfGone: true }),
        Toils.pickUp('B', function () { return 1; }),
        Toils.goto('C', { pe: PE.ON_CELL }),
        Toils.putInStorage('C')
      ];
    }
  });

  function huntKillToil() {
    return Toils.custom({
      name: 'huntKill',
      init: function (pawn, job, s) {
        s.ticks = 0; s.injuries = -1; s.engaged = 0;
        var prey = T.resolve(job.targetA, pawn.map);
        if (prey) {
          job.state.preyId = prey.id;
          job.state.preyKind = prey.kindId;
          job.state.preyName = labelOf(prey);
          job.state.x = prey.x; job.state.y = prey.y;
          _quarry.set(job.id, prey);
        }
        if (!weaponRange(pawn) && prey) {
          msg(nameOf(pawn) + ' is hunting ' + labelOf(prey) + ' with no ranged weapon.', 'threat', pawn);
        }
      },
      tick: function (pawn, job, s) {
        var map = pawn.map, prey = T.resolve(job.targetA, map);
        /* A quarry that stops resolving mid-hunt has died - T.resolve
           answers null for a dead pawn and pawn.js has already taken it
           off the map. The corpse is still ours to fetch, and the animal
           itself still has to be told it is dead, because nothing between
           the trigger and here does that: a shot boomrat only detonates
           because of this call. */
        if (!prey) {
          if (!s.engaged) { _quarry.delete(job.id); return 'next'; }
          job.state.killed = 1;
          var shot = _quarry.get(job.id);
          if (shot) Animals.notifyDeath(shot, pawn);
          else if (map.undesignate) map.undesignate(job.state.x, job.state.y, 'hunt');
          creditKill(pawn, s);
          return 'next';
        }
        s.engaged = 1;
        _quarry.set(job.id, prey);
        job.state.x = prey.x; job.state.y = prey.y;
        if (++s.ticks > HUNT_GIVE_UP) return 'fail';

        var range = weaponRange(pawn);
        var melee = range < 2;
        var d = U.dist(pawn.x, pawn.y, prey.x, prey.y);

        /* A downed animal is finished by hand wherever it fell. */
        if (prey.downed) {
          clearStance(pawn);
          if (d > 1.45) return walkTo(pawn, prey.x, prey.y) ? 'stay' : 'fail';
          stopMoving(pawn);
          faceToward(pawn, prey);
          killAnimal(prey, pawn, 'hunted');
          job.state.killed = 1;
          creditKill(pawn, s);
          return 'next';
        }

        var Combat = root.Combat;
        var want = melee ? 1.4 : Math.max(3, range - 1);
        var los = melee || !Combat || !Combat.lineOfSight ||
          Combat.lineOfSight(map, pawn.x, pawn.y, prey.x, prey.y);
        if (d > want || !los) {
          clearStance(pawn);
          return walkTo(pawn, prey.x, prey.y) ? 'stay' : 'fail';
        }
        stopMoving(pawn);
        faceToward(pawn, prey);

        /* Fresh wounds are counted rather than guessed at, so a bullet that
           lands three ticks after the trigger still rolls for revenge. */
        var wounds = injuryCount(prey);
        if (s.injuries < 0) s.injuries = wounds;
        else if (wounds > s.injuries) {
          s.injuries = wounds;
          var chance = info(prey.kindId).revengeChance * (melee ? 2.2 : 1);
          if (U.chance(chance)) {
            clearStance(pawn);
            makeManhunter(prey, { target: pawn });
            letter('Wounded animal revenge',
              U.cap(labelOf(prey)) + ' turned on ' + nameOf(pawn) + '.', 'threat', prey);
            return 'fail';
          }
        }

        if (Combat && Combat.tryAttack) Combat.tryAttack(pawn, prey);
        return 'stay';
      },
      end: function (pawn, job) { clearStance(pawn); _quarry.delete(job.id); }
    });
  }

  function huntCorpseToil() {
    return Toils.custom({
      name: 'huntClaimCorpse',
      init: function (pawn, job, s) { s.waited = 0; },
      tick: function (pawn, job, s) {
        var map = pawn.map;
        if (!job.state.killed) return 'done';
        var corpse = corpseOf(map, job.state.preyId);
        if (!corpse) {
          if (++s.waited < 90) return 'stay';
          corpse = makeCorpse(map, job.state);
          if (!corpse) return 'done';
        }
        var Z = root.Zones;
        var spot = Z && Z.bestStorageFor ? Z.bestStorageFor(map, corpse, pawn) : null;
        if (!spot) return 'done';
        job.targetB = T.thing(corpse);
        job.targetC = T.cell(spot.x, spot.y);
        var Res = root.Res;
        if (Res && Res.reserve) Res.reserve(pawn, job.targetB, 1);
        return 'next';
      }
    });
  }

  /* ---------- handler jobs ----------
     Taming, training, slaughtering and releasing are all the same shape:
     walk over, stay next to an animal that will not stand still, and put
     work in until something happens. Progress lives on the animal, so a
     tame that is interrupted twice by a wandering deer still adds up. */

  function handlerJob(id, spec) {
    Jobs.register(id, {
      label: spec.label,
      reportString: spec.report,
      suspendable: true,
      toils: function () {
        return [
          Toils.goto('A', { pe: root.Path.PE.TOUCH, failIfGone: true }),
          handlerToil(spec)
        ];
      }
    });
  }

  function handlerToil(spec) {
    return Toils.custom({
      name: spec.key,
      init: function (pawn, job, s) { s.chase = 0; },
      tick: function (pawn, job, s) {
        var map = pawn.map, a = T.resolve(job.targetA, map);
        if (!a || a.isAnimal !== true || a.dead) return 'fail';
        if (!spec.valid(a, pawn)) return 'fail';
        if (U.cheb(pawn.x, pawn.y, a.x, a.y) > 1) {
          if (++s.chase > 1200 || !walkTo(pawn, a.x, a.y)) return 'fail';
          return 'stay';
        }
        stopMoving(pawn);
        faceToward(pawn, a);
        var mind = mindOf(a);
        var rate = workRate(pawn, 'animals');
        mind[spec.progress] = (mind[spec.progress] || 0) + rate;
        gainSkill(pawn, 'animals', rate * 0.11);
        if (mind[spec.progress] < spec.work(a)) return 'stay';
        mind[spec.progress] = 0;
        spec.done(a, pawn);
        return 'next';
      }
    });
  }

  handlerJob('tame', {
    key: 'tame', label: 'tame', report: 'Taming {A}.', progress: 'tameWork',
    work: function (a) { return 350 + info(a.kindId).wildness * 750; },
    valid: function (a) { return !a.tame && !isManhunter(a) && a.faction !== 'player'; },
    done: function (a, pawn) { Animals.tryTame(a, pawn); }
  });

  handlerJob('slaughter', {
    key: 'slaughter', label: 'slaughter', report: 'Slaughtering {A}.', progress: 'slaughterWork',
    work: function (a) { return 300 + info(a.kindId).bodySize * 260; },
    valid: function (a) { return a.tame === true && a.faction === 'player'; },
    done: function (a, pawn) {
      var name = labelOf(a);
      killAnimal(a, pawn, 'slaughtered');
      gainSkill(pawn, 'animals', 120);
      msg(nameOf(pawn) + ' slaughtered ' + name + '.', 'info', pawn);
    }
  });

  handlerJob('trainAnimal', {
    key: 'train', label: 'train', report: 'Training {A}.', progress: 'trainWork',
    work: function () { return 420; },
    valid: function (a) { return a.tame === true && !!Animals.trainingNeeded(a); },
    done: function (a, pawn) {
      var which = Animals.trainingNeeded(a);
      if (!which) return;
      if (!a.trainedLevels) a.trainedLevels = { obedience: 0, release: 0 };
      var k = info(a.kindId);
      var odds = U.clamp01(0.25 + 0.06 * skillLevel(pawn, 'animals') - k.wildness * 0.25);
      if (!U.chance(odds)) { msg(labelOf(a) + ' would not take the lesson.', 'info', a); return; }
      a.trainedLevels[which] = (a.trainedLevels[which] || 0) + 1;
      gainSkill(pawn, 'animals', 60);
      if (a.trainedLevels[which] >= TRAIN_STEPS[which]) {
        msg(labelOf(a) + ' learned ' + which + '.', 'good', a);
      }
    }
  });

  handlerJob('releaseAnimal', {
    key: 'release', label: 'release', report: 'Releasing {A}.', progress: 'releaseWork',
    work: function () { return 200; },
    valid: function (a) { return a.tame === true && a.faction === 'player'; },
    done: function (a, pawn) {
      var name = labelOf(a);
      a.tame = false;
      a.faction = 'wild';
      a.master = null;
      a.trainedLevels = null;
      var mind = mindOf(a);
      mind.releaseTargetId = 0;
      mind.threatId = pawn.id;
      mind.fleeUntil = now() + 600;
      undesignate(a);
      msg(name + ' was released back into the wild.', 'info', a);
    }
  });

  /* ---------- taming ---------- */

  Animals.tameChance = function (animal, tamer) {
    var k = info(animal.kindId);
    var base = U.curve([[0, 0.12], [4, 0.40], [8, 0.65], [12, 0.86], [16, 1.02], [20, 1.18]],
      skillLevel(tamer, 'animals'));
    return U.clamp01(base * (1 - k.wildness) * 0.9 + 0.02);
  };

  Animals.tryTame = function (animal, tamer) {
    if (!animal || animal.isAnimal !== true || animal.dead || animal.tame) return false;
    var k = info(animal.kindId);
    if (U.chance(Animals.tameChance(animal, tamer))) {
      applyTame(animal, tamer);
      letter('Animal tamed',
        nameOf(tamer) + ' tamed a ' + k.label + '. It answers to ' + labelOf(animal) + ' now.',
        'good', animal);
      return true;
    }
    if (U.chance(k.manhunterOnTameFail)) {
      makeManhunter(animal, { target: tamer });
      letter('Taming failed',
        'The ' + k.label + ' turned on ' + nameOf(tamer) + ' instead.', 'threat', animal);
    } else {
      msg(nameOf(tamer) + ' failed to tame the ' + k.label + '.', 'info', animal);
    }
    return false;
  };

  var NAMES = ['Bess', 'Rusty', 'Pip', 'Ash', 'Moss', 'Tuck', 'Nell', 'Bram', 'Juno', 'Ozzy',
    'Clover', 'Dusty', 'Fern', 'Gus', 'Hazel', 'Ivy', 'Jasper', 'Kit', 'Luna', 'Mabel',
    'Olive', 'Pepper', 'Quill', 'Rooke', 'Sage', 'Thistle'];

  function applyTame(animal, tamer) {
    animal.tame = true;
    animal.faction = 'player';
    animal.manhunter = false;
    animal.trainedLevels = { obedience: 0, release: 0 };
    animal.master = tamer ? tamer.id : null;
    var mind = mindOf(animal);
    mind.manhunterTicks = 0; mind.revengeId = 0; mind.preyId = 0;
    if (!animal.name) animal.name = { first: '', nick: '', last: '' };
    animal.name.nick = U.pick(NAMES);
    undesignate(animal);
    if (tamer) gainSkill(tamer, 'animals', 200);
  }
  Animals.tameNow = applyTame;

  /* ---------- training ---------- */

  function trainableTo(kindId) {
    var t = info(kindId).trainability;
    if (t === 'advanced') return 2;
    if (t === 'intermediate') return 1;
    return 0;
  }

  function isTrained(animal, which) {
    var lv = animal.trainedLevels;
    return !!(lv && (lv[which] || 0) >= TRAIN_STEPS[which]);
  }

  Animals.isTrained = isTrained;
  Animals.trainability = trainableTo;
  Animals.TRAIN_STEPS = TRAIN_STEPS;

  Animals.canTrain = function (animal, which) {
    if (!animal || !animal.tame || animal.dead) return false;
    var cap = trainableTo(animal.kindId);
    if (which === 'obedience') return cap >= 1 && !isTrained(animal, 'obedience');
    if (which === 'release') return cap >= 2 && isTrained(animal, 'obedience') && !isTrained(animal, 'release');
    return false;
  };

  Animals.trainingNeeded = function (animal) {
    if (Animals.canTrain(animal, 'obedience')) return 'obedience';
    if (Animals.canTrain(animal, 'release')) return 'release';
    return null;
  };

  /* A drafted master sends everything that is trained for it at a target;
     think() picks the order up on the animal's next idle tick. */
  Animals.releaseAt = function (master, target) {
    if (!master || !target || !master.map) return 0;
    var list = master.map.pawns, sent = 0;
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      if (!a.tame || a.dead || a.downed || a.master !== master.id) continue;
      if (!isTrained(a, 'release')) continue;
      if (U.dist(a.x, a.y, master.x, master.y) > 30) continue;
      mindOf(a).releaseTargetId = target.id;
      if (a.job && Jobs.end) Jobs.end(a, 'interrupted');
      sent++;
    }
    return sent;
  };

  Animals.setMaster = function (animal, master) {
    if (!animal || !animal.tame) return false;
    animal.master = master ? master.id : null;
    return true;
  };

  /* ---------- designations ----------
     map.designations is keyed by cell and animals do not hold still, so
     the truth lives on the pawn and the cell entry is a mirror that the
     rare tick drags along behind it. That way a drag-select over a herd
     and a scan of map.designations both see the same thing. */

  Animals.designate = function (animal, type) {
    if (!animal || animal.isAnimal !== true || animal.dead) return false;
    var mind = mindOf(animal);
    if (mind.desType && mind.desType !== type) undesignate(animal);
    animal.designated = type;
    mind.desType = type;
    syncDesignation(animal, mind);
    return true;
  };

  function undesignate(animal) {
    if (!animal || !animal.animalMind) { if (animal) animal.designated = null; return; }
    var mind = animal.animalMind, map = animal.map;
    if (mind.desType && mind.desX >= 0 && map && map.undesignate) {
      map.undesignate(mind.desX, mind.desY, mind.desType);
    }
    mind.desType = ''; mind.desX = -1; mind.desY = -1;
    animal.designated = null;
  }
  Animals.undesignate = undesignate;

  /* The cell mirror can outlive its animal: anything at all can kill a
     designated beast and nothing is obliged to tell this file. Once in a
     while the animal designations are walked and the orphans dropped.
     Only entries written here carry a pawnId, so a mining or chopping
     designation is never touched. */
  var _sweepTick = -99999;
  function sweepDesignations(map) {
    if (!map || !map.designations || !map.designations.forEach) return;
    var stale = [];
    map.designations.forEach(function (d, i) {
      if (!d || !d.pawnId) return;
      var p = pawnById(map, d.pawnId);
      if (!p || p.dead || p.designated !== d.type) stale.push([i, d.type]);
    });
    for (var i = 0; i < stale.length; i++) {
      map.undesignate(map.xOf(stale[i][0]), map.yOf(stale[i][0]), stale[i][1]);
    }
  }

  function syncDesignation(animal, mind) {
    var map = animal.map;
    if (!map || !map.designate || !mind.desType) return;
    if (mind.desX === animal.x && mind.desY === animal.y) {
      /* save.js writes a designation back out as type and defId only, so
         a mirror that came from a file has forgotten whose it is and the
         sweep below would never recognise it again. Re-stamp it. */
      var standing = map.designationAt ? map.designationAt(animal.x, animal.y, mind.desType) : null;
      if (standing && standing.pawnId !== animal.id) standing.pawnId = animal.id;
      return;
    }
    if (mind.desX >= 0 && map.undesignate) map.undesignate(mind.desX, mind.desY, mind.desType);
    /* map.designate copies only defId out of its options, so the owning
       pawn goes onto the record it hands back - that record is the one
       stored in map.designations, and sweepDesignations reads the id off
       it to tell an animal's mirror from a mining or chopping mark. */
    var d = map.designate(animal.x, animal.y, mind.desType, { defId: animal.kindId });
    if (d) d.pawnId = animal.id;
    mind.desX = animal.x; mind.desY = animal.y;
  }

  Animals.designated = function (map, type) {
    var out = [], list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.isAnimal === true && !p.dead && p.designated === type) out.push(p);
    }
    return out;
  };

  /* ---------- manhunters ---------- */

  function isManhunter(pawn) {
    return !!(pawn.manhunter || (pawn.animalMind && pawn.animalMind.manhunterTicks > 0));
  }
  Animals.isManhunter = isManhunter;
  Animals.isPredator = function (pawn) { return info(pawn.kindId).predator === true; };
  Animals.isHostileAnimal = function (pawn) {
    return pawn.isAnimal === true && !pawn.dead && isManhunter(pawn);
  };

  function makeManhunter(animal, opts) {
    opts = opts || {};
    var mind = mindOf(animal);
    animal.manhunter = true;
    mind.manhunterTicks = opts.ticks || U.randInt(MANHUNTER_MIN, MANHUNTER_MAX);
    mind.revengeId = opts.target ? opts.target.id : 0;
    mind.preyId = 0;
    mind.fleeUntil = 0;
    if (animal.tame) { animal.tame = false; animal.faction = 'wild'; animal.master = null; }
    undesignate(animal);
    if (animal.job && Jobs.end) Jobs.end(animal, 'interrupted');
  }
  Animals.makeManhunter = makeManhunter;

  Animals.calmManhunter = function (animal) {
    var mind = mindOf(animal);
    mind.manhunterTicks = 0; mind.revengeId = 0;
    animal.manhunter = false;
  };

  /* ---------- spawning ---------- */

  /* How many wild animals the map carries before ambient packs stop
     arriving. mapgen.js seeds three to five herds of up to six at world
     gen, so a cap that a fresh 140x140 map already sits on would mean no
     births and no wildlife incidents for the rest of the game. */
  Animals.wildCap = function (map) { return 18 + Math.floor(map.size / 900); };

  Animals.wildCount = function (map) {
    var n = 0, list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.isAnimal === true && !p.dead && p.faction !== 'player') n++;
    }
    return n;
  };

  function tameCount(map) {
    var n = 0, list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      if (list[i].isAnimal === true && !list[i].dead && list[i].faction === 'player') n++;
    }
    return n;
  }

  /* map.js owns the pawn-per-cell index, so a new animal joins through
     addPawn; pushing one onto map.pawns by hand would leave pawnsAt blind
     to it. The float position is ours to set: nothing has drawn it yet. */
  function place(map, pawn, x, y) {
    if (!map.addPawn) return false;
    map.addPawn(pawn, x, y);
    pawn.fx = pawn.x; pawn.fy = pawn.y;
    return map.pawns.indexOf(pawn) >= 0;
  }

  function spawnCellNear(map, x, y, radius) {
    var ring = ringOffsets(radius);
    for (var i = 0; i < ring.length; i++) {
      var cx = x + ring[i][0], cy = y + ring[i][1];
      if (map.inBounds(cx, cy) && map.passable(cx, cy)) return { x: cx, y: cy };
    }
    return null;
  }

  Animals.spawnWild = function (map, kindId, x, y, count) {
    var out = [], MG = root.MapGen;
    if (!map || !MG || typeof MG.makePawn !== 'function') return out;
    var k = info(kindId);
    /* The cap is what stops ambient packs from filling the map, so it
       binds the pack this function picks for itself. A caller that names
       a count is a scripted arrival - mapgen's two predators, the
       predatorAttack and animalSelfTame incidents - and gets what it
       asked for, or the first wolf to walk out of the trees after the map
       filled up would never arrive at all. */
    if (count === undefined || count === null) {
      count = U.randInt(k.packSize[0], k.packSize[1]);
      var room = Animals.wildCap(map) - Animals.wildCount(map);
      if (room <= 0) return out;
      if (count > room) count = room;
    }
    for (var i = 0; i < count; i++) {
      var c = spawnCellNear(map, x + U.randInt(-3, 3), y + U.randInt(-3, 3), 7);
      if (!c) break;
      var a = MG.makePawn(kindId, 'wild', { x: c.x, y: c.y, map: map });
      if (!a) break;
      if (!place(map, a, c.x, c.y)) break;
      mindOf(a);
      out.push(a);
    }
    return out;
  };

  function edgeCells(map, side) {
    var out = [], i;
    for (i = 2; i < (side === 'n' || side === 's' ? map.w : map.h) - 2; i++) {
      var x = side === 'n' || side === 's' ? i : (side === 'w' ? 1 : map.w - 2);
      var y = side === 'w' || side === 'e' ? i : (side === 'n' ? 1 : map.h - 2);
      if (map.passable(x, y)) out.push({ x: x, y: y });
    }
    return out;
  }

  Animals.manhunterPack = function (map, kindId, count) {
    var out = [], MG = root.MapGen;
    if (!map || !MG || typeof MG.makePawn !== 'function') return out;
    var k = info(kindId);
    if (!count) count = U.randInt(Math.max(2, k.packSize[0] + 1), Math.max(3, k.packSize[1] + 2));
    var side = U.pick(['n', 'e', 's', 'w']);
    var cells = MG.edgeSpawnCells ? MG.edgeSpawnCells(map, side) : edgeCells(map, side);
    if (!cells || !cells.length) cells = edgeCells(map, side);
    if (!cells.length) return out;
    var anchor = U.pick(cells);
    for (var i = 0; i < count; i++) {
      var c = spawnCellNear(map, anchor.x, anchor.y, 6);
      if (!c) break;
      var a = MG.makePawn(kindId, 'wild', { x: c.x, y: c.y, map: map });
      if (!a || !place(map, a, c.x, c.y)) break;
      makeManhunter(a, { ticks: U.randInt(MANHUNTER_MAX, MANHUNTER_MAX + 30000) });
      out.push(a);
    }
    if (out.length) {
      letter('Manhunter pack',
        'A pack of ' + out.length + ' ' + U.plural(out.length, k.label) +
        ' has gone mad and is coming for anything that moves.', 'threat', out[0]);
    }
    return out;
  };

  /* ---------- butchering ---------- */

  Animals.butcherProducts = function (kind) {
    var id = typeof kind === 'string' ? kind : (kind && (kind.id || kind.kindId));
    var k = info(id);
    if (k.butcherProducts) {
      var copy = {};
      for (var key in k.butcherProducts) copy[key] = k.butcherProducts[key];
      return copy;
    }
    var out = {};
    if (k.meat > 0) out.meatRaw = k.meat;
    if (k.leather > 0) out.leather = k.leather;
    return out;
  };

  /* ---------- death ---------- */

  Animals.notifyDeath = function (animal, killer) {
    if (!animal || animal.isAnimal !== true) return;
    var mind = mindOf(animal);
    if (mind.deathDone) return;
    mind.deathDone = 1;
    undesignate(animal);
    animal.manhunter = false;
    mind.manhunterTicks = 0;
    mind.releaseTargetId = 0;

    /* A boomrat takes the room with it. Every death this file causes -
       a hunt, a slaughter, a predator finishing its meal - comes through
       here. A boomrat killed by anything else only detonates if whoever
       owns that death hook calls this too. */
    var k = info(animal.kindId);
    if (k.explodes && animal.map) {
      var Combat = root.Combat;
      if (Combat && Combat.explosion) {
        Combat.explosion(animal.map, animal.x, animal.y,
          k.explosionRadius, k.explosionDamage, k.explosionType,
          { instigator: killer || null });
        msg('The ' + k.label + ' went up.', 'threat', animal);
      }
    }

    /* Nobody stays bonded to a dead animal, and nothing keeps hunting one. */
    var map = animal.map;
    if (!map) return;
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i], m = p.animalMind;
      if (!m) continue;
      if (m.preyId === animal.id) m.preyId = 0;
      if (m.revengeId === animal.id) m.revengeId = 0;
      if (m.threatId === animal.id) { m.threatId = 0; m.fleeUntil = 0; }
    }
  };

  /* ---------- the rare tick ----------
     needs.js already decays food for every pawn it knows about; this only
     fills in for an animal that was never given needs, then handles what
     is specific to being an animal. Safe to call more often than every
     250 ticks: the stamp on the animal holds the real cadence, which is
     what lets think() drive it as well as pawn.js. */

  Animals.tickRare = function (pawn) {
    if (!pawn || pawn.isAnimal !== true || pawn.dead) return;
    var mind = mindOf(pawn), k = info(pawn.kindId);
    var beat = now();
    if (beat && mind.nextRare > beat) return;
    mind.nextRare = beat + RARE_TICKS;

    if (!pawn.needs) {
      pawn.needs = { food: 0.8, rest: 0.8, joy: 1, comfort: 0.5, outdoors: 1 };
      mind.ownNeeds = 1;
    }
    if (mind.ownNeeds) {
      pawn.needs.food = U.clamp01(pawn.needs.food - (FOOD_FALL_PER_DAY * RARE_TICKS) / 60000);
    }

    /* Starvation is not handled here on purpose: health.js reads
       needs.food for every pawn it ticks and applies malnutrition itself,
       so an animal that runs out of grass wastes away exactly the way a
       colonist who runs out of meals does. */

    /* Grazing while standing still: think() walks an animal to its food,
       this is the mouthful it takes when the food is already underfoot.
       It must not stop a walking animal, so it eats without ending the
       walk the way the grazing job does. */
    if (k.grazer && pawn.needs.food < GRAZE_AT && !pawn.downed && pawn.map) {
      var here = pawn.map.plantAt(pawn.x, pawn.y);
      if (edible(here)) eatPlant(pawn, k, here, pawn.map);
    }

    if (mind.manhunterTicks > 0) {
      mind.manhunterTicks -= RARE_TICKS;
      if (mind.manhunterTicks <= 0) {
        mind.manhunterTicks = 0;
        pawn.manhunter = false;
        mind.revengeId = 0;
        mind.fleeUntil = beat + 900;
      }
    }

    if (mind.desType) syncDesignation(pawn, mind);
    if (beat - _sweepTick >= 2000) { _sweepTick = beat; sweepDesignations(pawn.map); }

    tryBreed(pawn, mind, k);
  };

  /* Breeding is deliberately slow and hard-capped. A newborn is an
     ordinary spawned pawn, so it saves and loads like any other. */
  function tryBreed(pawn, mind, k) {
    if (!k.breeds || pawn.gender !== 'female' || pawn.dead) return;
    if ((pawn.ageYears || 0) < 1) return;
    if (foodOf(pawn) < 0.6 || painOf(pawn) > 0.2) return;
    var map = pawn.map;
    if (!map) return;
    if (pawn.faction === 'player') { if (tameCount(map) >= TAME_CAP) return; }
    else if (Animals.wildCount(map) >= Animals.wildCap(map)) return;
    if (!U.chance((BREED_PER_DAY * RARE_TICKS) / 60000)) return;

    var mate = nearestPawn(map, pawn.x, pawn.y, 8, function (p) {
      return p !== pawn && p.isAnimal === true && p.kindId === pawn.kindId &&
        p.gender === 'male' && (p.ageYears || 0) >= 1;
    });
    if (!mate) return;

    var MG = root.MapGen;
    if (!MG || typeof MG.makePawn !== 'function') return;
    var spot = spawnCellNear(map, pawn.x, pawn.y, 3);
    if (!spot) return;
    var baby = MG.makePawn(pawn.kindId, pawn.faction, { x: spot.x, y: spot.y, map: map, ageYears: 0.2 });
    if (!baby) return;
    if (!place(map, baby, spot.x, spot.y)) return;
    baby.ageYears = 0.2;
    baby.ageTicks = 0;
    mindOf(baby);
    if (pawn.faction === 'player') {
      baby.tame = true;
      baby.trainedLevels = { obedience: 0, release: 0 };
      if (!baby.name) baby.name = { first: '', nick: '', last: '' };
      baby.name.nick = U.pick(NAMES);
      msg(labelOf(pawn) + ' gave birth to ' + labelOf(baby) + '.', 'good', baby);
    }
  }

  /* ---------- odds and ends the rest of the game asks for ---------- */

  Animals.info = info;
  Animals.canTame = function (animal) {
    return !!(animal && animal.isAnimal === true && !animal.dead && !animal.tame && !isManhunter(animal));
  };
  Animals.canSlaughter = function (animal) {
    return !!(animal && animal.isAnimal === true && !animal.dead && animal.tame && animal.faction === 'player');
  };
  Animals.wildKinds = ['hare', 'deer', 'muffalo', 'boomrat', 'wolf', 'bear'];

  root.Animals = Animals;
})(this);
