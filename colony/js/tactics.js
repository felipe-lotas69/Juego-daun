/* ============================================================
   tactics.js - combat intelligence: cover, suppression, retreat,
   squads, threat assessment and combat experience.

   combat.js already knows how to shoot. What it does not know is
   where to stand, when to stop standing there, who to shoot first
   and when to stop shooting altogether, and without those four
   answers a fight is two lines of pawns walking into open ground
   and swapping bullets until one line falls over.

   Two things shape everything below.

   First, ownership. combat.js, think.js and events.js are not this
   file's to edit, so tactics never takes a decision one of them has
   already taken. It acts in exactly two ways:

     THE JOB PATH. Tactics.combatJob(pawn) is a think-tree level. It
     returns a job only when it has something the tree does not
     already say - move to a firing position, fall back, carry out a
     squad order - and null the rest of the time, which leaves
     think.js's own self-defence and fight levels exactly as they
     were. Extending, not duplicating.

     THE STEER PATH. A raider in a storyteller raid group is driven
     by events.js every tick: it is handed attackStatic the moment a
     colonist is in sight, and any job tactics started would be
     thrown away the same tick. So for a pawn already committed to a
     combat job, tactics does not touch the job - it puts a short
     path on the pawn and lets the driver keep running. events.js
     sees a raider who is already fighting and leaves it alone, and
     the raider slides behind the rocks while it shoots. The visible
     cost is a round loosed on the move; relocations start in the
     recovery between shots and run a few tiles, and that is the
     price of raiders who use terrain without rewriting the raid
     driver.

   Second, oscillation. A pawn that steps into cover, decides the
   cell it came from scores better, steps back, and does that for
   the rest of the fight is THE failure mode of this system. Five
   rules hold it off, none of them optional: the cell underfoot gets
   a bonus, the cell just left is penalised for fifteen seconds, a
   move must beat standing still by a margin that includes the walk,
   there is a floor on the time between two moves and a ceiling on
   the number of them in one engagement. Every commitment goes
   through noteMove, which counts a doubling-back if one ever
   happens - Tactics.stats().bounces is the number that says this
   file works, and it is asserted at zero.

   Suppression and dodging are the two places where the honest thing
   would be a hook inside combat.js's hit roll, and combat.js is
   frozen. Both are exposed as hooks it could call one day -
   Tactics.dodgeChance, Tactics.aimFactor, Tactics.noteIncomingFire -
   and, because a hook nobody calls is not behaviour, both are also
   applied here, by reading Combat.projectiles (a public array) while
   the rounds are still in the air: a dodged shot has its hit flag
   cleared and is sent wide, and a pinned shooter has a share of its
   would-be hits spoiled the same way. Nothing here ever turns a
   miss into a hit.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;

  /* Above this file in the load order, so binding them here is safe. */
  var Jobs = root.Jobs;
  var Toils = root.Toils;
  var T = root.T;
  var Path = root.Path;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  /* Below it, or optional entirely. Looked up at call time so a partial
     harness simply does less rather than failing to load. */
  function sys(name) {
    var v = root[name];
    return v === undefined ? null : v;
  }

  function gameTick() {
    var G = sys('Game');
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  var Tactics = {};

  /* Counters, in the shape pathfind.js keeps its own: cheap to bump,
     and the only honest way to answer "did this file move anybody, and
     did it ever move them back where they came from". bounces must
     stay at zero - it is the oscillation this system exists to avoid,
     counted rather than assumed. */
  var stats = {
    relocations: 0, bounces: 0, retreats: 0, breaks: 0,
    dodges: 0, spoiled: 0, pins: 0
  };
  Tactics.stats = function () { return stats; };
  Tactics.resetStats = function () {
    stats.relocations = 0; stats.bounces = 0; stats.retreats = 0; stats.breaks = 0;
    stats.dodges = 0; stats.spoiled = 0; stats.pins = 0;
  };

  /* ------------------------------------------------------------------
     Tuning

     Ticks, everywhere: 60 to the second.
     ------------------------------------------------------------------ */

  var SCAN_RADIUS = 30;            /* how far a pawn looks for a fight        */
  var ENGAGE_MEMORY = 600;         /* quiet ticks before an engagement is over */
  var ENGAGE_TICKS = 300;          /* one firing stint, then a fresh decision  */
  var MELEE_RANGE = 1.8;
  var THINK_GAP = 30;              /* a null answer is good for half a second  */

  /* The five anti-oscillation numbers. */
  var MIN_RELOCATE_TICKS = 150;    /* floor between two moves by one pawn      */
  var MAX_RELOCATIONS = 5;         /* ceiling per engagement                   */
  var RELOCATE_MARGIN = 0.14;      /* how much better the new cell must score  */
  var INCUMBENT_BONUS = 0.10;      /* standing still is worth something        */
  var RECENT_PENALTY = 0.35;       /* ...and going back where you came from is not */
  var HOME_MEMORY = 900;           /* how long that penalty lasts              */

  var CLAIM_TICKS = 400;           /* how long a pawn holds a cover cell       */

  /* Scoring weights. Cover is the unit everything else is quoted in:
     the weapon's best range, a position their cover does not work
     from (more so on a flank order), fire and traps, a dead end, a
     friend's line of fire, being seen by guns other than the one
     aimed at, the walk itself, the squad's anchor, and a cell
     somebody is already standing in. */
  var W_COVER = 1.00, W_BAND = 0.45, W_FLANK = 0.30, W_FLANK_ORDER = 0.80;
  var W_HAZARD = 1.10, W_DEADEND = 0.35, W_FRIENDLY_FIRE = 0.55, W_CROSSFIRE = 0.22;
  var W_TRAVEL = 0.035, W_ANCHOR = 0.25, W_CROWD = 0.50;

  /* Suppression. A near miss pins; the pin bleeds off over about five
     seconds; a pinned shooter throws rounds away, and a pinned pawn
     can lose its nerve - drafted ones at a much higher bar, because
     the player gave them an order. */
  var SUP_DECAY = 0.0035, SUP_RADIUS = 3.4, SUPPRESSED_AT = 0.45, SUP_AIM_SPOIL = 0.40;
  var SUP_NEAR = 0.30, SUP_MID = 0.16, SUP_FAR = 0.07;
  var BREAK_SUPPRESSION = 0.80, DRAFTED_BREAK_SUPPRESSION = 0.95;

  /* Dodging. Small numbers: this is a sidestep, not a force field. */
  var DODGE_BASE = 0.04, DODGE_PER_LEVEL = 0.007, DODGE_MOVING = 1.35, DODGE_MAX = 0.38;

  /* Combat sense - the thing the source has no notion of. It is not the
     shooting skill: it is knowing when to get behind something, and it
     is earned by being shot at and by coming out the other side.
     sense = xp / (xp + XP_HALF), so 600 xp is half way. */
  var XP_PER_COMBAT_TICK = 0.02, XP_NEAR_MISS = 0.40, XP_SURVIVED = 18, XP_HALF = 600;

  /* Falling back. A veteran pulls out earlier than a recruit, which is
     most of what makes them a veteran. A withdrawal is asked for once,
     stands for RETREAT_TICKS, and is not asked for again from
     somewhere already SAFE_DISTANCE clear of everyone shooting. */
  var RETREAT_BLOOD = 0.42, RETREAT_PAIN = 0.58, RETREAT_CONSC = 0.55;
  var RETREAT_SIDE_LOST = 0.5;     /* half the side down = the line is gone    */
  var RETREAT_TICKS = 1500, RETREAT_GAP = 600, SAFE_DISTANCE = 14;

  var ORDER_TICKS = 6000;          /* a squad order is good for a minute or so */

  /* Cover weighting, copied from combat.js so a score predicts the
     penalty a bullet will actually take. Only used when Combat itself
     is absent, which is a harness case. */
  var COVER_NEAR = 1.0, COVER_FAR = 0.55, COVER_MAX = 0.85, PAWN_FILL = 0.30;

  var TRAIT_DODGE = { nimble: 1.40, tough: 0.85, wimp: 0.80, jogger: 1.10 };
  var TRAIT_NERVE = { ironWilled: 1.45, tough: 1.25, psychopath: 1.30, bloodlust: 1.20,
                      volatile: 0.80, neurotic: 0.75, wimp: 0.65, pessimist: 0.85 };

  var VETERANCY = [
    [0.12, 'green'], [0.30, 'blooded'], [0.55, 'seasoned'], [0.80, 'veteran'], [2, 'grizzled']
  ];

  /* ------------------------------------------------------------------
     Per-pawn state

     Plain fields on pawn.tactics, so save.js carries it with the rest
     of the colonist and a veteran stays a veteran across a reload.
     Nothing in here is a reference: ids only.
     ------------------------------------------------------------------ */

  function stateOf(pawn) {
    var st = pawn.tactics;
    if (!st) {
      st = pawn.tactics = {
        xp: 0,                     /* combat sense, earned                     */
        fights: 0,
        suppression: 0,
        engaged: false,
        lastFoeTick: -99999,
        lastRelocTick: -99999,
        relocations: 0,
        leftX: -1, leftY: -1, leftTick: -99999,
        claimX: -1, claimY: -1,
        targetId: 0,
        broken: false,
        retreatUntil: 0,
        lastRetreatTick: -99999,
        nextThink: 0,
        order: null                /* {kind, tick, x, y, targetId}             */
      };
    }
    return st;
  }
  Tactics.stateOf = stateOf;

  Tactics.senseOf = function (pawn) {
    var st = pawn && pawn.tactics;
    var xp = st ? st.xp : 0;
    return xp > 0 ? xp / (xp + XP_HALF) : 0;
  };

  Tactics.veterancy = function (pawn) {
    var s = Tactics.senseOf(pawn);
    for (var i = 0; i < VETERANCY.length; i++) if (s < VETERANCY[i][0]) return VETERANCY[i][1];
    return 'grizzled';
  };

  /* practice.js probes for one of a list of names and calls it to bank
     drill time; this is the one it finds. */
  Tactics.gainExperience = function (pawn, amount, kind) {
    if (!pawn || !(amount > 0) || pawn.isAnimal) return 0;
    var st = stateOf(pawn);
    /* Drills teach less than being shot at, and teach less the more of
       it a pawn has already seen. */
    var factor = kind === 'drill' ? 0.55 : 1;
    factor *= 1 - 0.5 * Tactics.senseOf(pawn);
    st.xp += amount * factor;
    return st.xp;
  };
  Tactics.gainXp = Tactics.gainExperience;

  /* ------------------------------------------------------------------
     Small questions
     ------------------------------------------------------------------ */

  function isPawn(x) { return !!x && x.isHuman !== undefined; }

  function traitFactor(pawn, table) {
    var traits = pawn && pawn.traits;
    if (!traits || !traits.length) return 1;
    var f = 1;
    for (var i = 0; i < traits.length; i++) {
      var id = typeof traits[i] === 'string' ? traits[i] : (traits[i] && traits[i].id);
      var v = id && table[id];
      if (v !== undefined) f *= v;
    }
    return f;
  }

  function capacity(pawn, name) {
    var H = sys('Health');
    if (!H || !H.capacity || !pawn.health) return 1;
    return H.capacity(pawn, name);
  }

  function skillLevel(pawn, id) {
    var s = pawn.skills && pawn.skills[id];
    if (s) return s.level || 0;
    var kind = pawn.kind;
    if (kind && kind.combatPower !== undefined) return U.clamp(Math.round(kind.combatPower / 20), 1, 12);
    return 3;
  }

  function weaponOf(pawn) {
    var C = sys('Combat');
    if (C && C.weaponOf) return C.weaponOf(pawn);
    var eq = pawn && pawn.equipment;
    var def = eq && (eq.def || null);
    return (def && def.weapon) || null;
  }

  function rangedWeapon(pawn) {
    var w = weaponOf(pawn);
    return w && w.ranged ? w : null;
  }

  function hostile(a, b) {
    var C = sys('Combat');
    if (C && C.hostile) return C.hostile(a, b);
    var G = sys('Game');
    return !!(G && G.hostile && G.hostile(a.faction, b.faction));
  }

  function lineOfSight(map, x1, y1, x2, y2) {
    var C = sys('Combat');
    if (C && C.lineOfSight) return C.lineOfSight(map, x1, y1, x2, y2);
    return true;
  }

  function sameArea(map, x1, y1, x2, y2) {
    var R = sys('Regions');
    if (R && R.sameArea) return R.sameArea(map, x1, y1, x2, y2);
    return true;
  }

  function burning(pawn) {
    var F = sys('Fire');
    if (F && F.isBurning && F.isBurning(pawn)) return true;
    return pawn.burning === true;
  }

  function fireAt(map, x, y) {
    if (!map.byDef) return null;
    var list = map.byDef('fire');
    for (var i = 0; i < list.length; i++) {
      if (list[i].spawned && list[i].x === x && list[i].y === y) return list[i];
    }
    return null;
  }

  /* Wildlife minding its own business is not a threat, and a raid that
     stops to shoot a hare has already lost. */
  function harmless(q) {
    if (!q.isAnimal) return false;
    if (q.manhunter === true) return false;
    if (q.mentalState && q.mentalState.id === 'berserk') return false;
    return q.faction === 'wild';
  }

  /* ------------------------------------------------------------------
     Cover

     A cell's cover is read the way combat.js reads it: from the two
     cells in front of whoever is being shot at, on the line back to
     the shooter. Asking Combat.coverPenalty directly means a score
     here predicts the penalty a round will really take, rather than
     a second opinion that slowly drifts away from the first.
     ------------------------------------------------------------------ */

  /* Fraction of incoming fire from (fromX, fromY) that something stops
     for a pawn standing at (x, y). 0 is open ground, 0.85 is a wall. */
  Tactics.coverScoreAt = function (map, x, y, fromX, fromY) {
    if (!map || !map.inBounds(x, y)) return 0;
    var C = sys('Combat');
    if (C && C.coverPenalty) return C.coverPenalty(map, fromX, fromY, x, y);

    /* Without combat.js loaded, the same two cells read by hand: one
       and two steps from the target back along the line to the gun. */
    var dx = fromX - x, dy = fromY - y;
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len < 0.001) return 0;
    dx /= len; dy /= len;
    var best = 0;
    for (var k = 1; k <= 2; k++) {
      var cx = Math.round(x + dx * k), cy = Math.round(y + dy * k);
      if ((cx === x && cy === y) || !map.inBounds(cx, cy)) continue;
      var b = map.buildingAt(cx, cy);
      var fill = (b && b.def) ? (b.def.fillPercent || 0) : 0;
      var here = map.pawnsAt ? map.pawnsAt(cx, cy) : null;
      if (here && here.length && fill < PAWN_FILL) fill = PAWN_FILL;
      var v = fill * (k === 1 ? COVER_NEAR : COVER_FAR);
      if (v > best) best = v;
    }
    return Math.min(best, COVER_MAX);
  };

  /* How boxed in a cell is. A hole with one way out is a grave once
     somebody walks up to it, and it is worth a little cover to avoid. */
  function deadEndScore(map, x, y) {
    var open = 0;
    for (var i = 0; i < U.ADJ8.length; i++) {
      var nx = x + U.ADJ8[i][0], ny = y + U.ADJ8[i][1];
      if (map.inBounds(nx, ny) && map.passable(nx, ny)) open++;
    }
    if (open >= 5) return 0;
    return (5 - open) / 5;
  }

  /* Fire, traps and water. A cell that is about to be on fire is not a
     firing position however good the sandbags are. */
  function hazardAt(map, x, y) {
    var h = 0;
    if (map.byDef) {
      var fires = map.byDef('fire');
      for (var i = 0; i < fires.length; i++) {
        var f = fires[i];
        if (!f.spawned) continue;
        var d = U.cheb(x, y, f.x, f.y);
        if (d <= 1) { h = 1; break; }
        if (d <= 3 && h < 0.45) h = 0.45;
      }
    }
    var b = map.buildingAt(x, y);
    if (b && b.def && b.def.building && b.def.building.isTrap && h < 0.8) h = 0.8;
    var t = map.terrainAt(x, y);
    if (t && (t.id === 'marsh' || t.id === 'shallowWater') && h < 0.3) h = 0.3;
    return h;
  }

  /* Point-to-segment distance, used to ask whether a candidate cell
     sits inside a friend's line to the same enemy. */
  function distToSegment(px, py, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay;
    var len2 = vx * vx + vy * vy;
    if (len2 < 0.0001) return U.dist(px, py, ax, ay);
    var t = U.clamp(((px - ax) * vx + (py - ay) * vy) / len2, 0, 1);
    return U.dist(px, py, ax + vx * t, ay + vy * t);
  }

  /* ------------------------------------------------------------------
     Who is on the map and where

     Both scans walk map.pawns once. They are only ever called from a
     decision, never from the per-tick path, and the decision itself is
     throttled - see THINK_GAP and the rare-tick slice in tickPawn.
     ------------------------------------------------------------------ */

  function hostilesNear(pawn, radius, includeDowned) {
    var map = pawn.map, out = [];
    if (!map) return out;
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (q === pawn || q.dead) continue;
      if (!includeDowned && q.downed) continue;
      if (harmless(q)) continue;
      if (!hostile(pawn, q)) continue;
      if (U.dist(pawn.x, pawn.y, q.x, q.y) > radius) continue;
      out.push(q);
    }
    return out;
  }

  function alliesNear(pawn, radius) {
    var map = pawn.map, out = [];
    if (!map) return out;
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (q === pawn || q.dead || q.isAnimal) continue;
      if (q.faction !== pawn.faction) continue;
      if (U.dist(pawn.x, pawn.y, q.x, q.y) > radius) continue;
      out.push(q);
    }
    return out;
  }

  /* Where the fire is coming from, as one point: the threat-weighted
     mean of everyone shooting at this pawn. A pawn between two raiders
     gets a direction that belongs to neither, which is correct - there
     is no cover from both and the score should say so. */
  Tactics.threatPoint = function (pawn, foes) {
    foes = foes || hostilesNear(pawn, SCAN_RADIUS);
    if (!foes.length) return null;
    var wx = 0, wy = 0, total = 0;
    for (var i = 0; i < foes.length; i++) {
      var f = foes[i];
      var w = Tactics.threatOf(f, pawn);
      wx += f.x * w; wy += f.y * w; total += w;
    }
    if (total <= 0) return { x: foes[0].x, y: foes[0].y };
    return { x: wx / total, y: wy / total };
  };

  /* ------------------------------------------------------------------
     Threat assessment

     A colonist should shoot the raider with the rifle, not the nearest
     one with a club. threatOf answers "how much damage can this thing
     do to me", pickTarget divides that by how far away it is and adds
     the two pieces of memory that stop a firing line from flapping
     between targets: what the squad was told to focus on, and what
     this pawn was already shooting at.
     ------------------------------------------------------------------ */

  Tactics.threatOf = function (pawn, from) {
    if (!pawn) return 0;
    if (!isPawn(pawn)) {
      /* A turret is a gun that does not bleed, so it is rated as one. */
      var C = sys('Combat');
      var tw = C && C.turretWeapon ? C.turretWeapon(pawn.def) : null;
      if (tw) return 40 + tw.damage * Math.max(1, tw.burstCount || 1) * 1.5;
      return 6;
    }
    if (pawn.dead) return 0;

    var v = 10;
    var w = weaponOf(pawn);
    if (w && w.ranged) {
      v += w.damage * Math.max(1, w.burstCount || 1) * 1.8;
      v += (w.range || 0) * 0.35;
      v += (w.armorPen || 0) * 25;
      if (w.explosionRadius > 0) v += 40 * w.explosionRadius;
    } else if (w) {
      v += w.damage * 1.2;
    } else if (pawn.isAnimal && pawn.kind) {
      v += (pawn.kind.meleeDamage || 5) * 1.2 + (pawn.kind.combatPower || 0) * 0.25;
    } else {
      v += 6;
    }

    /* Skill is most of the difference between a rifle in two pairs of
       hands. Health is the rest. */
    v *= 0.7 + 0.03 * skillLevel(pawn, w && w.ranged ? 'shooting' : 'melee');
    v *= U.lerp(0.3, 1, capacity(pawn, 'consciousness'));
    v *= U.lerp(0.6, 1, capacity(pawn, 'manipulation'));
    if (pawn.downed) v *= 0.06;
    if (pawn.tactics && pawn.tactics.suppression >= SUPPRESSED_AT) v *= 0.75;

    if (from && from.x !== undefined) {
      var d = U.dist(pawn.x, pawn.y, from.x, from.y);
      /* A gun that cannot reach me this second is a smaller problem than
         one that can, and one already aimed at me is the biggest. */
      var reach = w && w.ranged ? w.range : MELEE_RANGE;
      if (d > reach) v *= 0.55;
      if (aimingAt(pawn, from)) v *= 1.6;
      else if (pawn.aimTarget) v *= 1.15;
    }
    return v;
  };

  function aimingAt(shooter, victim) {
    var at = shooter.aimTarget;
    if (!at || !victim || victim.id === undefined) return false;
    return at.k === 'p' && at.id === victim.id;
  }

  /* Distance still matters more than danger - you take the threat in
     front of you rather than walking past it - but the square term
     keeps a rifleman ahead of an unarmed colonist two tiles nearer. */
  function distanceWeight(d) { return 6 + d + d * d * 0.22; }

  Tactics.pickTarget = function (pawn, candidates) {
    if (!pawn || !pawn.map) return null;
    var list = candidates || hostilesNear(pawn, SCAN_RADIUS);
    if (!list.length) return null;
    var map = pawn.map;
    var st = pawn.tactics;
    var focusId = Tactics.focusOf(pawn);
    var w = rangedWeapon(pawn);
    var best = null, bestScore = 0;

    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (!q || q.dead) continue;
      if (isPawn(q) && q.downed) continue;
      var d = U.dist(pawn.x, pawn.y, q.x, q.y);
      var score = Tactics.threatOf(q, pawn) / distanceWeight(d);

      /* Out of reach or out of sight is not "never", it is "worth less":
         a pawn should still walk toward the dangerous one. */
      if (w && d > w.range) score *= 0.45;
      if (!lineOfSight(map, pawn.x, pawn.y, q.x, q.y)) score *= 0.35;
      if (focusId && q.id === focusId) score *= 2.2;
      if (st && st.targetId === q.id) score *= 1.3;
      if (q.isAnimal) score *= 0.85;

      if (score > bestScore) { bestScore = score; best = q; }
    }
    return best;
  };

  /* ------------------------------------------------------------------
     Firing positions

     One scoring function, used by every caller: the job path picking
     somewhere to walk to, the steer path deciding whether the cell
     under a raider's feet is good enough, and the retreat picking
     somewhere to bleed quietly.
     ------------------------------------------------------------------ */

  function claims(map) {
    if (!(map.__tacticsClaims instanceof Map)) map.__tacticsClaims = new Map();
    return map.__tacticsClaims;
  }

  /* A claim is a promise not to walk into the cell somebody else is
     already walking to. It expires on its own, which is what keeps it
     out of the reservation table save.js and verify-sim watch. */
  function claimCell(pawn, x, y) {
    var map = pawn.map;
    if (!map) return;
    var tbl = claims(map), tick = gameTick();
    var st = stateOf(pawn);
    if (st.claimX >= 0) tbl.delete(st.claimX + ',' + st.claimY);
    st.claimX = x; st.claimY = y;
    tbl.set(x + ',' + y, { id: pawn.id, until: tick + CLAIM_TICKS });
  }

  function releaseClaim(pawn) {
    var st = pawn.tactics;
    if (!st || st.claimX < 0 || !pawn.map) return;
    var tbl = claims(pawn.map);
    var e = tbl.get(st.claimX + ',' + st.claimY);
    if (e && e.id === pawn.id) tbl.delete(st.claimX + ',' + st.claimY);
    st.claimX = -1; st.claimY = -1;
  }

  /* Every commitment to a new cell goes through here, from both paths,
     so the move budget, the memory of the cell just left and the
     bounce counter cannot disagree with each other. */
  function noteMove(pawn, st, toX, toY) {
    var tick = gameTick();
    if (toX === st.leftX && toY === st.leftY && tick - st.leftTick < HOME_MEMORY) stats.bounces++;
    st.leftX = pawn.x; st.leftY = pawn.y; st.leftTick = tick;
    st.lastRelocTick = tick;
    st.relocations++;
    stats.relocations++;
  }

  function claimedByOther(map, x, y, pawn) {
    var tbl = map.__tacticsClaims;
    if (!tbl) return false;
    var e = tbl.get(x + ',' + y);
    if (!e) return false;
    if (e.until < gameTick()) { tbl.delete(x + ',' + y); return false; }
    return e.id !== pawn.id;
  }

  /* The range a weapon is happiest at: the band with the best accuracy
     number, pulled inside the weapon's actual reach. */
  function idealRange(w) {
    if (!w) return 1;
    var acc = w.accuracy;
    if (!acc) return Math.min(12, w.range || 12);
    var bands = [[3, acc.touch], [12, acc.short], [25, acc.medium], [40, acc.long]];
    var bestD = 12, bestV = -1;
    for (var i = 0; i < bands.length; i++) {
      if (bands[i][0] > (w.range || 40)) continue;
      if (bands[i][1] > bestV) { bestV = bands[i][1]; bestD = bands[i][0]; }
    }
    return U.clamp(bestD, w.minRange || 0, (w.range || 40) * 0.92);
  }

  function scoreCell(ctx, x, y) {
    var map = ctx.map, pawn = ctx.pawn;
    if (!map.inBounds(x, y) || !map.passable(x, y)) return null;
    if (claimedByOther(map, x, y, pawn)) return null;
    if (!(x === pawn.x && y === pawn.y) && !sameArea(map, pawn.x, pawn.y, x, y)) return null;

    var d = ctx.target ? U.dist(x, y, ctx.tx, ctx.ty) : 0;
    var los = true;

    if (ctx.target) {
      if (ctx.w) {
        if (d > ctx.w.range * 0.97) return null;
        if (d < (ctx.w.minRange || 0)) return null;
      } else if (d > MELEE_RANGE + 0.5) {
        /* Without a gun, a "firing position" is a cell you can swing
           from, so anything out of reach is not one. */
        return null;
      }
      los = lineOfSight(map, x, y, ctx.tx, ctx.ty);
      if (!los && !ctx.allowNoLos) return null;
    }

    if (ctx.anchorR > 0 && U.cheb(x, y, ctx.anchorX, ctx.anchorY) > ctx.anchorR) return null;

    var cover = Tactics.coverScoreAt(map, x, y, ctx.threatX, ctx.threatY);
    var score = W_COVER * cover;

    if (ctx.target && ctx.w) {
      var band = 1 - Math.abs(d - ctx.ideal) / Math.max(8, ctx.w.range);
      score += W_BAND * U.clamp01(band);
    }
    if (!los) score -= 0.5;

    /* Flanking, stated mechanically: a cell their cover does not work
       from. Worth something always, worth a lot when the order says so
       and the enemy is pinned in place. */
    if (ctx.target) {
      var theirCover = Tactics.coverScoreAt(map, ctx.tx, ctx.ty, x, y);
      score += (ctx.flank ? W_FLANK_ORDER : W_FLANK) * (1 - theirCover);
    }

    score -= W_HAZARD * hazardAt(map, x, y);
    score -= W_DEADEND * deadEndScore(map, x, y);

    /* Somebody else's line of fire, and everybody else's guns. */
    var i, ff = 0;
    if (ctx.target && ctx.friends.length) {
      for (i = 0; i < ctx.friends.length; i++) {
        var fr = ctx.friends[i];
        if (fr.x === x && fr.y === y) continue;
        if (distToSegment(x, y, fr.x, fr.y, ctx.tx, ctx.ty) < 1.1 &&
            U.dist(fr.x, fr.y, ctx.tx, ctx.ty) > d) ff += 1;
      }
    }
    score -= W_FRIENDLY_FIRE * U.clamp01(ff * 0.6);

    var seen = 0;
    for (i = 0; i < ctx.foes.length; i++) {
      var foe = ctx.foes[i];
      if (foe === ctx.target) continue;
      if (U.dist(x, y, foe.x, foe.y) > SCAN_RADIUS) continue;
      if (lineOfSight(map, x, y, foe.x, foe.y)) seen++;
    }
    score -= W_CROSSFIRE * U.clamp01(seen * 0.5);

    var crowd = map.pawnsAt ? map.pawnsAt(x, y) : null;
    if (crowd) {
      for (i = 0; i < crowd.length; i++) {
        if (crowd[i] !== pawn && !crowd[i].dead && !crowd[i].downed) { score -= W_CROWD; break; }
      }
    }

    if (ctx.anchorR > 0) {
      score += W_ANCHOR * (1 - U.cheb(x, y, ctx.anchorX, ctx.anchorY) / Math.max(1, ctx.anchorR));
    }

    /* The walk itself, then the two memory terms that stop a pawn
       trading the same two cells for the rest of the fight. */
    var travel = U.cheb(pawn.x, pawn.y, x, y);
    score -= W_TRAVEL * travel;
    if (travel === 0) score += INCUMBENT_BONUS;
    else if (ctx.recent && x === ctx.recentX && y === ctx.recentY) score -= RECENT_PENALTY;

    return { x: x, y: y, score: score, cover: cover, dist: d, los: los, travel: travel };
  }

  /* opts: {radius, maxCells, allowNoLos, flank, anchorX, anchorY, anchorR,
            threatX, threatY, foes, friends} */
  Tactics.bestFiringPosition = function (pawn, target, opts) {
    opts = opts || {};
    var map = pawn && pawn.map;
    if (!map) return null;

    var st = stateOf(pawn);
    var sense = Tactics.senseOf(pawn);
    var foes = opts.foes || hostilesNear(pawn, SCAN_RADIUS);
    var threat = (opts.threatX !== undefined)
      ? { x: opts.threatX, y: opts.threatY }
      : (Tactics.threatPoint(pawn, foes) || (target ? { x: target.x, y: target.y } : null));
    if (!threat) return null;

    var w = rangedWeapon(pawn);
    var ctx = {
      map: map, pawn: pawn, target: target || null,
      tx: target ? target.x : threat.x, ty: target ? target.y : threat.y,
      threatX: threat.x, threatY: threat.y,
      w: w, ideal: idealRange(w),
      flank: !!opts.flank,
      allowNoLos: !!opts.allowNoLos,
      anchorX: opts.anchorX === undefined ? pawn.x : opts.anchorX,
      anchorY: opts.anchorY === undefined ? pawn.y : opts.anchorY,
      anchorR: opts.anchorR || 0,
      foes: foes,
      friends: opts.friends || alliesNear(pawn, 18),
      recent: gameTick() - st.leftTick < HOME_MEMORY,
      recentX: st.leftX, recentY: st.leftY
    };

    /* A veteran looks further for somewhere to stand, and a pinned pawn
       will not go far at all. */
    var radius = opts.radius;
    if (!radius) {
      radius = 3 + Math.round(4 * sense);
      if (st.suppression >= SUPPRESSED_AT) radius = Math.min(radius, 3);
    }
    radius = U.clamp(radius, 1, 8);

    var cells = U.cellsInRadius(pawn.x, pawn.y, radius);
    var limit = opts.maxCells || 150;
    var best = null, current = null, looked = 0;

    for (var i = 0; i < cells.length && looked < limit; i++) {
      var rec = scoreCell(ctx, cells[i][0], cells[i][1]);
      if (!rec) continue;
      looked++;
      if (rec.travel === 0) current = rec;
      if (!best || rec.score > best.score) best = rec;
    }
    if (!best) return null;
    best.current = current;
    best.gain = current ? best.score - current.score : best.score;
    return best;
  };

  /* ------------------------------------------------------------------
     Suppression and dodging

     Hooks first, for the day combat.js can call them, then the side
     that actually runs today.
     ------------------------------------------------------------------ */

  /* HOOK. combat.js could multiply its ranged hit roll by this and get
     a suppressed shooter who misses more. Nothing calls it yet; the
     same number is applied below by spoiling rounds in flight. */
  Tactics.aimFactor = function (pawn) {
    var st = pawn && pawn.tactics;
    if (!st || !(st.suppression > 0)) return 1;
    return 1 - SUP_AIM_SPOIL * U.clamp01(st.suppression);
  };

  /* HOOK. combat.js could roll this before it decides a shot connects.
     Applied below instead, by clearing the hit flag on a round already
     in the air. */
  Tactics.dodgeChance = function (pawn, shooter, weapon) {
    if (!isPawn(pawn) || pawn.dead || pawn.downed) return 0;
    var lvl = Math.max(skillLevel(pawn, 'melee'), skillLevel(pawn, 'shooting'));
    var v = DODGE_BASE + DODGE_PER_LEVEL * lvl;
    v *= traitFactor(pawn, TRAIT_DODGE);
    v *= capacity(pawn, 'moving');
    v *= 1 + 0.5 * Tactics.senseOf(pawn);
    if (pawn.moving && pawn.moving()) v *= DODGE_MOVING;
    /* Pinned down means pressed into the dirt, not dancing. */
    var st = pawn.tactics;
    if (st && st.suppression >= SUPPRESSED_AT) v *= 0.6;
    /* A shotgun at contact range is not dodged. */
    if (shooter && U.dist(pawn.x, pawn.y, shooter.x, shooter.y) < 3) v *= 0.5;
    if (weapon && weapon.burstCount > 1) v *= 0.85;
    return U.clamp(v, 0, DODGE_MAX);
  };

  /* HOOK, and the one this file calls itself: a round went past close
     enough to hear. */
  Tactics.noteIncomingFire = function (pawn, fromX, fromY, weight) {
    if (!isPawn(pawn) || pawn.dead || pawn.isAnimal) return 0;
    var st = stateOf(pawn);
    var nerve = traitFactor(pawn, TRAIT_NERVE) * (1 + 0.6 * Tactics.senseOf(pawn));
    /* Cover is most of what stops a near miss from pinning you: the
       round hit the sandbag, and a pawn behind a sandbag knows it. */
    var cover = Tactics.coverScoreAt(pawn.map, pawn.x, pawn.y, fromX, fromY);
    var add = (weight || SUP_MID) * (1 - 0.55 * cover) / Math.max(0.4, nerve);
    var was = st.suppression;
    st.suppression = U.clamp01(st.suppression + add);
    if (was < SUPPRESSED_AT && st.suppression >= SUPPRESSED_AT) stats.pins++;
    st.lastFoeTick = gameTick();
    st.xp += XP_NEAR_MISS;
    return st.suppression;
  };

  Tactics.suppressionOf = function (pawn) {
    var st = pawn && pawn.tactics;
    return st ? st.suppression : 0;
  };
  Tactics.isSuppressed = function (pawn) {
    return Tactics.suppressionOf(pawn) >= SUPPRESSED_AT;
  };

  /* One pass over the rounds in the air, once per tick for the whole
     map. Everything that cannot be done inside combat.js happens here:
     a dodge clears the hit flag, a pin is banked, and a pinned
     shooter's round is thrown away. Each round is looked at once for
     each of those - the flags on the record say which have been done -
     and the record dies with the projectile, so nothing accumulates. */
  function scanProjectiles(map) {
    var C = sys('Combat');
    if (!C || !C.projectiles) return;
    var list = C.projectiles;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.map !== map || p.dead) continue;

      if (!p._tacRolled) {
        p._tacRolled = 1;
        var victim = p.target;
        if (p.willHit && isPawn(victim) && !victim.dead) {
          var shooter = p.instigator;
          if (U.chance(Tactics.dodgeChance(victim, shooter, weaponBlockOf(p)))) {
            sendWide(map, p);
            stats.dodges++;
            gainFightXp(victim, 1.2);
          } else if (isPawn(shooter) && !shooter.isAnimal &&
                     U.chance(SUP_AIM_SPOIL * Tactics.suppressionOf(shooter))) {
            /* The pinned shooter's round: fired from behind cover with
               the head down, and it goes wherever it goes. */
            sendWide(map, p);
            stats.spoiled++;
          }
        }
      }

      /* The pin lands when the round does, not when it leaves the
         barrel, so it waits until the round is most of the way there. */
      if (!p._tacPinned && p.travelled >= p.dist * 0.5) {
        p._tacPinned = 1;
        pinNear(map, p);
      }
    }
  }

  function weaponBlockOf(p) {
    var src = p.sourceDef;
    if (!src) return null;
    return src.weapon || (src.ranged !== undefined ? src : null);
  }

  /* A dodged or spoiled round is re-aimed a cell or two off so it
     visibly goes wide. Never the other way: this function only ever
     turns a hit into a miss. */
  function sendWide(map, p) {
    p.willHit = false;
    var ox = p.tx + U.randInt(-2, 2);
    var oy = p.ty + U.randInt(-2, 2);
    if (ox === p.tx && oy === p.ty) ox += U.chance(0.5) ? 1 : -1;
    p.tx = U.clamp(ox, 0, map.w - 1);
    p.ty = U.clamp(oy, 0, map.h - 1);
    /* The flight was measured to the old cell; remeasure or the round
       stops short of where it is now going. */
    var d = U.dist(p.sx, p.sy, p.tx, p.ty);
    p.dist = d > 0.001 ? d : p.dist;
  }

  function pinNear(map, p) {
    if (!map.pawnsAt) return;
    var r = Math.ceil(SUP_RADIUS);
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        var x = p.tx + dx, y = p.ty + dy;
        if (!map.inBounds(x, y)) continue;
        var d = U.dist(x, y, p.tx, p.ty);
        if (d > SUP_RADIUS) continue;
        var here = map.pawnsAt(x, y);
        for (var i = 0; i < here.length; i++) {
          var q = here[i];
          if (q.dead || q.downed || q.isAnimal) continue;
          if (q.id === p.instigatorId) continue;
          if (p.faction && q.faction === p.faction) continue;
          var weight = d <= 1.2 ? SUP_NEAR : (d <= 2.2 ? SUP_MID : SUP_FAR);
          Tactics.noteIncomingFire(q, p.sx, p.sy, weight);
        }
      }
    }
  }

  function gainFightXp(pawn, amount) {
    if (!pawn || pawn.isAnimal) return;
    stateOf(pawn).xp += amount;
  }

  /* ------------------------------------------------------------------
     Squad orders

     input.js can offer these five; nothing else in the game needs to
     know they exist. An order is remembered per pawn with the tick it
     was given, so it fades on its own rather than outliving the fight
     it was given in.
     ------------------------------------------------------------------ */

  var ORDER_KINDS = { hold: 1, advance: 1, fallback: 1, focus: 1, flank: 1 };
  Tactics.ORDERS = ['hold', 'advance', 'fallback', 'focus', 'flank'];

  /* Focus fire is a squad-wide fact, not a per-pawn one: it is stored
     by faction so every colonist reads the same answer. */
  var _focus = {};

  Tactics.focusOf = function (pawn) {
    var f = _focus[pawn.faction];
    if (!f) return 0;
    if (gameTick() - f.tick > ORDER_TICKS) { delete _focus[pawn.faction]; return 0; }
    var map = pawn.map;
    var live = (T && map) ? T.resolve({ k: 'p', id: f.id, x: 0, y: 0 }, map) : null;
    if (!live || live.dead || live.downed) { delete _focus[pawn.faction]; return 0; }
    return f.id;
  };

  Tactics.setFocus = function (faction, target) {
    if (!faction) return 0;
    if (!target || !target.id) { delete _focus[faction]; return 0; }
    _focus[faction] = { id: target.id, tick: gameTick() };
    return target.id;
  };

  /* The most dangerous thing the squad can see, which is what focus
     fire is for. */
  Tactics.mostDangerous = function (pawns, candidates) {
    if (!pawns || !pawns.length) return null;
    var lead = pawns[0];
    var list = candidates || hostilesNear(lead, SCAN_RADIUS);
    var best = null, bestV = 0;
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (!q || q.dead || q.downed) continue;
      var v = 0;
      for (var j = 0; j < pawns.length; j++) v += Tactics.threatOf(q, pawns[j]);
      if (v > bestV) { bestV = v; best = q; }
    }
    return best;
  };

  Tactics.squadOrder = function (pawns, kind, target) {
    if (!pawns || !pawns.length || !ORDER_KINDS[kind]) return null;
    var tick = gameTick();
    var lead = pawns[0];
    var map = lead.map;
    if (!map) return null;

    var focus = target || null;
    if (kind === 'focus' && !focus) focus = Tactics.mostDangerous(pawns);
    if (focus) Tactics.setFocus(lead.faction, focus);

    /* Where the order points. Hold and flank are measured from where
       the squad already is; advance leans on the enemy; fallback picks
       a rally point behind the line, away from the shooting. */
    var cx = 0, cy = 0, n = 0, i;
    for (i = 0; i < pawns.length; i++) {
      if (!pawns[i] || pawns[i].dead) continue;
      cx += pawns[i].x; cy += pawns[i].y; n++;
    }
    if (!n) return null;
    cx /= n; cy /= n;

    var aim = focus ? { x: focus.x, y: focus.y } : Tactics.threatPoint(lead);
    var ax = cx, ay = cy;
    if (aim) {
      var dx = aim.x - cx, dy = aim.y - cy;
      var len = Math.sqrt(dx * dx + dy * dy) || 1;
      if (kind === 'advance') { ax = cx + (dx / len) * 6; ay = cy + (dy / len) * 6; }
      else if (kind === 'fallback') { ax = cx - (dx / len) * 10; ay = cy - (dy / len) * 10; }
    }
    ax = U.clamp(Math.round(ax), 1, map.w - 2);
    ay = U.clamp(Math.round(ay), 1, map.h - 2);

    var given = 0;
    for (i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      if (!p || p.dead || p.isAnimal) continue;
      var st = stateOf(p);
      st.order = {
        kind: kind, tick: tick,
        x: kind === 'hold' ? p.x : ax,
        y: kind === 'hold' ? p.y : ay,
        targetId: focus ? focus.id : 0
      };
      /* A new order is a new plan: the move budget resets with it, and
         so does the memory of the cell just left. */
      st.relocations = 0;
      st.lastRelocTick = -99999;
      st.broken = false;
      if (kind !== 'fallback') st.retreatUntil = 0;
      st.nextThink = 0;
      if (p.job && kind !== 'hold') endJob(p);
      given++;
    }
    return { kind: kind, pawns: given, x: ax, y: ay, targetId: focus ? focus.id : 0 };
  };

  Tactics.orderOf = function (pawn) {
    var st = pawn && pawn.tactics;
    var o = st && st.order;
    if (!o) return null;
    if (gameTick() - o.tick > ORDER_TICKS) { st.order = null; return null; }
    return o;
  };

  Tactics.clearOrder = function (pawn) {
    var st = pawn && pawn.tactics;
    if (st) st.order = null;
  };

  /* ------------------------------------------------------------------
     Retreat
     ------------------------------------------------------------------ */

  function hurtBadly(pawn, sense) {
    var H = sys('Health');
    if (!H || !pawn.health) return false;
    /* Judgement, not toughness: a veteran reads the same wound as the
       moment to leave, and a recruit reads it as a scratch. */
    var scale = 1 - 0.25 * sense;
    if ((pawn.health.bloodLoss || 0) > RETREAT_BLOOD * scale) return true;
    if (H.painLevel && H.painLevel(pawn) > RETREAT_PAIN * scale) return true;
    if (capacity(pawn, 'consciousness') < RETREAT_CONSC) return true;
    if (H.bleedRate && H.bleedRate(pawn) > 0.28 * scale) return true;
    return false;
  }

  function sideCollapsing(pawn) {
    var map = pawn.map;
    if (!map) return false;
    var live = 0, lost = 0;
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var q = list[i];
      if (q === pawn || q.isAnimal) continue;
      if (q.faction !== pawn.faction) continue;
      if (U.dist(pawn.x, pawn.y, q.x, q.y) > 35) continue;
      if (q.dead || q.downed) lost++; else live++;
    }
    if (live + lost < 2) return false;
    return lost / (live + lost) >= RETREAT_SIDE_LOST;
  }

  Tactics.shouldRetreat = function (pawn) {
    if (!pawn || pawn.isAnimal) return false;
    var st = stateOf(pawn);
    var sense = Tactics.senseOf(pawn);
    if (st.retreatUntil > gameTick()) return true;
    if (hurtBadly(pawn, sense)) return true;
    if (st.broken) return true;
    /* Watching your side come apart. A raider leaves; a colonist gets
       behind something and keeps shooting, because there is nowhere to
       leave to. */
    if (sideCollapsing(pawn) && !pawn.drafted) return true;
    return false;
  };

  function isRaider(pawn) {
    return pawn.faction !== 'player' && !pawn.isAnimal;
  }

  function nearestEdgeCell(map, pawn) {
    var left = pawn.x, right = map.w - 1 - pawn.x;
    var up = pawn.y, down = map.h - 1 - pawn.y;
    var best = Math.min(left, right, up, down);
    if (best === left) return { x: 0, y: U.clamp(pawn.y, 0, map.h - 1) };
    if (best === right) return { x: map.w - 1, y: U.clamp(pawn.y, 0, map.h - 1) };
    if (best === up) return { x: U.clamp(pawn.x, 0, map.w - 1), y: 0 };
    return { x: U.clamp(pawn.x, 0, map.w - 1), y: map.h - 1 };
  }

  /* Has the withdrawal already done its job? A pawn who has put
     distance or a wall between itself and everyone shooting at it is
     out of the fight, and asking for a second retreat from there is
     how a pawn ends up walking the length of the map one job at a
     time. */
  function alreadySafe(pawn, foes) {
    var map = pawn.map;
    for (var i = 0; i < foes.length; i++) {
      var f = foes[i];
      var d = U.dist(pawn.x, pawn.y, f.x, f.y);
      if (d < SAFE_DISTANCE && lineOfSight(map, pawn.x, pawn.y, f.x, f.y)) return false;
      if (d < 6) return false;
    }
    return true;
  }

  /* Somewhere to withdraw to: off the map for a raider, a bed for a
     colonist who needs a doctor, and otherwise the best cover well away
     from whatever is shooting. */
  Tactics.retreatDestination = function (pawn, reason) {
    var map = pawn.map;
    if (!map) return null;
    var foes = hostilesNear(pawn, SCAN_RADIUS);
    var threat = Tactics.threatPoint(pawn, foes);

    if (isRaider(pawn) && reason !== 'fire') {
      var edge = nearestEdgeCell(map, pawn);
      if (map.passable(edge.x, edge.y)) return edge;
    }

    var H = sys('Health');
    if (pawn.faction === 'player' && H && H.needsTending && H.needsTending(pawn) &&
        Jobs && Jobs.findBed) {
      var bed = Jobs.findBed(map, pawn, { realBedOnly: false });
      if (bed && (!threat || U.dist(bed.x, bed.y, threat.x, threat.y) > 14)) {
        return { x: bed.x, y: bed.y };
      }
    }

    /* Walk the other way and take the best cover found on the way. The
       search is a ring of candidate cells rather than a flood fill:
       this runs at most once per withdrawal. */
    var bestCell = null, bestScore = -Infinity;
    var dx = 0, dy = 0;
    if (threat) {
      dx = pawn.x - threat.x; dy = pawn.y - threat.y;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0.001) { dx /= len; dy /= len; } else { dx = 1; dy = 0; }
    } else { dx = 1; dy = 0; }

    for (var step = 12; step >= 4; step -= 2) {
      for (var a = -2; a <= 2; a++) {
        var ang = a * 0.45;
        var ox = Math.round(pawn.x + (dx * Math.cos(ang) - dy * Math.sin(ang)) * step);
        var oy = Math.round(pawn.y + (dx * Math.sin(ang) + dy * Math.cos(ang)) * step);
        ox = U.clamp(ox, 1, map.w - 2);
        oy = U.clamp(oy, 1, map.h - 2);
        if (!map.passable(ox, oy)) continue;
        if (!sameArea(map, pawn.x, pawn.y, ox, oy)) continue;
        var score = 0;
        if (threat) {
          score += U.dist(ox, oy, threat.x, threat.y) * 0.25;
          score += 2.5 * Tactics.coverScoreAt(map, ox, oy, threat.x, threat.y);
          if (!lineOfSight(map, ox, oy, threat.x, threat.y)) score += 2.2;
        }
        score -= 3 * hazardAt(map, ox, oy);
        score -= W_DEADEND * deadEndScore(map, ox, oy);
        if (score > bestScore) { bestScore = score; bestCell = { x: ox, y: oy }; }
      }
      if (bestCell) return bestCell;
    }
    return bestCell;
  };

  /* ------------------------------------------------------------------
     Jobs

     Two of them. takeCover is move-then-shoot; combatRetreat is
     move-then-catch-your-breath. Both are registered here because
     behaviour lives next to the system it belongs to.
     ------------------------------------------------------------------ */

  function endJob(pawn) {
    if (pawn.job && Jobs && Jobs.end) Jobs.end(pawn, 'interrupted');
  }

  function foeName(target) {
    if (!target) return 'them';
    if (target.name) return target.name.nick || target.name.first || 'them';
    return (target.def && target.def.label) || 'it';
  }

  if (Jobs && Jobs.register && Toils && T) {

    /* --- takeCover ---
       targetA is what we are shooting at, targetB is the cell chosen to
       shoot it from. The walk is jobs.js's own goto toil, so repathing
       and the unreachable case behave exactly like every other walk in
       the game; the second toil is the firing stint. */
    Jobs.register('takeCover', {
      label: 'take cover',
      suspendable: false,
      alwaysShow: true,
      allowGoneTarget: true,
      reportString: function (job, pawn) {
        var t = T.resolve(job.targetA, pawn && pawn.map);
        return 'Moving to cover against ' + foeName(t);
      },
      toils: function () {
        return [
          Toils.custom({
            name: 'claimCover',
            tick: function (pawn, job) {
              var pos = job.targetB ? T.pos(job.targetB, pawn.map) : null;
              if (!pos) return 'fail';
              claimCell(pawn, pos.x, pos.y);
              var st = stateOf(pawn);
              if (pawn.x !== pos.x || pawn.y !== pos.y) noteMove(pawn, st, pos.x, pos.y);
              return 'next';
            }
          }),
          Toils.goto('B', { pe: PE.ON_CELL, avoidFire: true, failIfGone: false, maxCells: 900 }),
          Toils.custom({
            name: 'engage',
            init: function (pawn, job, s) {
              s.left = ENGAGE_TICKS;
              s.lost = 0;
              if (pawn.stopPath) pawn.stopPath();
            },
            tick: function (pawn, job, s) {
              var map = pawn.map;
              var C = sys('Combat');
              if (!C) return 'done';
              var foe = T.resolve(job.targetA, map);
              if (!foe || foe.dead || (isPawn(foe) && foe.downed)) return 'done';

              var d = U.dist(pawn.x, pawn.y, foe.x, foe.y);
              /* Something got close enough to hit us. That is no longer
                 a firing position, and think.js has a melee answer. */
              if (d <= MELEE_RANGE) return 'done';

              var w = rangedWeapon(pawn);
              if (!w) return 'done';
              if (d > w.range || !C.lineOfSight(map, pawn.x, pawn.y, foe.x, foe.y)) {
                /* Lost them behind something. Give it a second before
                   throwing the whole plan away. */
                return (++s.lost > 60) ? 'done' : 'stay';
              }
              s.lost = 0;
              C.tryAttack(pawn, foe);
              if (s.noted !== foe.id) { s.noted = foe.id; stateOf(pawn).targetId = foe.id; }
              return (--s.left <= 0) ? 'done' : 'stay';
            },
            end: function (pawn) {
              var C = sys('Combat');
              if (C && C.clearStance) C.clearStance(pawn);
            }
          })
        ];
      },
      onEnd: function (pawn) { releaseClaim(pawn); }
    });

    /* --- combatRetreat ---
       targetA is the cell to withdraw to. The wait at the end is what
       stops a hurt colonist from turning round the instant they arrive
       and walking straight back into the fire they just left. */
    Jobs.register('combatRetreat', {
      label: 'fall back',
      suspendable: false,
      alwaysShow: true,
      allowGoneTarget: true,
      reportString: 'Falling back.',
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.ON_CELL, avoidFire: true, failIfGone: false, maxCells: 1600 }),
          Toils.custom({
            name: 'catchBreath',
            init: function (pawn, job, s) {
              s.left = 240;
              if (pawn.stopPath) pawn.stopPath();
            },
            tick: function (pawn, job, s) {
              var st = stateOf(pawn);
              /* Still shooting back, if there is anything in front of
                 the new position worth shooting at. Four times a second
                 is plenty to notice one, and a target scan every tick
                 for every withdrawing pawn is not free. */
              var C = sys('Combat');
              var w = rangedWeapon(pawn);
              if (C && w && !pawn.isAnimal && (s.left % 15) === 0 &&
                  !(C.stanceOf && C.stanceOf(pawn))) {
                var foe = Tactics.pickTarget(pawn, hostilesNear(pawn, w.range));
                if (foe && C.lineOfSight(pawn.map, pawn.x, pawn.y, foe.x, foe.y)) {
                  C.tryAttack(pawn, foe);
                }
              }
              if (--s.left > 0) return 'stay';
              st.broken = false;
              return 'done';
            },
            end: function (pawn) {
              var C = sys('Combat');
              if (C && C.clearStance) C.clearStance(pawn);
            }
          })
        ];
      }
    });
  }

  /* ------------------------------------------------------------------
     The entry point

     One function for think.js. It answers with a job only when it has
     something the rest of the tree does not already say, and with null
     the rest of the time - which is what makes this an extension of
     the existing defend level rather than a replacement for it.
     ------------------------------------------------------------------ */

  function canAct(pawn) {
    if (!pawn || pawn.dead || pawn.downed || !pawn.map) return false;
    if (pawn.isAnimal) return false;          /* animals.js owns those heads  */
    if (pawn.mentalState) return false;       /* so does think.js, while it lasts */
    if (capacity(pawn, 'consciousness') < 0.2) return false;
    return true;
  }

  function makeJob(defId, a, b, opts) {
    if (!Jobs || !Jobs.make || !Jobs.defs || !Jobs.defs[defId]) return null;
    return Jobs.make(defId, a, b, opts);
  }

  /* Walking to a rally point is a retreat by another name, and it is
     gated the same way: a fallback order that re-issued its job every
     time think came round would reset the path instead of following
     it. */
  var RALLY_GAP = 180;

  function rallyJob(pawn, st, order, tick) {
    if (U.cheb(pawn.x, pawn.y, order.x, order.y) <= 3) return null;
    if (tick - st.lastRetreatTick < RALLY_GAP) return null;
    st.lastRetreatTick = tick;
    releaseClaim(pawn);
    return makeJob('combatRetreat', T.cell(order.x, order.y), null, {});
  }

  function retreatJob(pawn, reason) {
    var cell = Tactics.retreatDestination(pawn, reason);
    if (!cell) return null;
    var st = stateOf(pawn);
    st.retreatUntil = gameTick() + RETREAT_TICKS;
    st.lastRetreatTick = gameTick();
    stats.retreats++;
    releaseClaim(pawn);
    return makeJob('combatRetreat', T.cell(cell.x, cell.y), null, {});
  }

  function coverJob(pawn, foe, opts) {
    var best = Tactics.bestFiringPosition(pawn, foe, opts);
    if (!best) return null;
    var cur = best.current;
    /* Already in the best cell there is: say nothing and let the tree
       below do the shooting it was always going to do. */
    if (best.travel === 0) return null;
    if (cur && best.score < cur.score + RELOCATE_MARGIN) return null;
    if (!best.los) return null;
    var job = makeJob('takeCover', T.pawn(foe), T.cell(best.x, best.y), {});
    if (job) stateOf(pawn).targetId = foe.id;
    return job;
  }

  Tactics.combatJob = function (pawn) {
    if (!canAct(pawn)) return null;
    var st = stateOf(pawn);
    var tick = gameTick();
    if (tick < st.nextThink) return null;
    st.nextThink = tick + THINK_GAP;

    var map = pawn.map;

    /* Standing in a fire outranks every order there is, drafted or not. */
    if (burning(pawn) || fireAt(map, pawn.x, pawn.y)) {
      var out = retreatJob(pawn, 'fire');
      if (out) return out;
    }

    var order = Tactics.orderOf(pawn);
    var foes = hostilesNear(pawn, SCAN_RADIUS);
    if (!foes.length) {
      /* The fight is over as far as this pawn can see. */
      if (order && order.kind === 'fallback') {
        var home = rallyJob(pawn, st, order, tick);
        if (home) return home;
      }
      if (st.engaged && tick - st.lastFoeTick > ENGAGE_MEMORY) endEngagement(pawn, st);
      releaseClaim(pawn);
      st.nextThink = tick + THINK_GAP * 4;
      return null;
    }

    st.lastFoeTick = tick;
    if (!st.engaged) startEngagement(pawn, st);

    /* A withdrawal already decided stands until it is finished. */
    var drafted = !!pawn.drafted;
    if (order && order.kind === 'fallback') {
      var rally = rallyJob(pawn, st, order, tick);
      if (rally) return rally;
    } else if (!drafted && Tactics.shouldRetreat(pawn)) {
      /* Only once per withdrawal, and not from somewhere already safe:
         both halves of that are what stop the retreat from re-issuing
         itself every time the pawn finishes walking. */
      var pressed = !alreadySafe(pawn, foes);
      if (pressed && tick - st.lastRetreatTick >= RETREAT_GAP) {
        var away = retreatJob(pawn, 'hurt');
        if (away) return away;
      }
      if (!pressed) return null;
    } else if (drafted && st.broken) {
      /* A drafted pawn who has had enough does not run for the hills -
         they get their head down behind the nearest thing, which is a
         cover move with a short leash, handled below. */
      st.retreatUntil = 0;
    }

    var w = rangedWeapon(pawn);
    if (!w) return null;                       /* melee is think.js's answer */

    /* A pawn the player has just sent somewhere goes there. A pawn the
       player has pointed at something shoots that, not whatever this
       file would have chosen. */
    var forced = null;
    if (drafted && pawn.draftTarget) {
      if (pawn.draftTarget.k === 'c') return null;
      forced = T.resolve(pawn.draftTarget, map);
      if (forced && forced.isHuman === undefined) forced = null;   /* a wall, not a foe */
    }

    var foe = forced || Tactics.pickTarget(pawn, foes);
    if (!foe || foe.dead) return null;
    if (U.dist(pawn.x, pawn.y, foe.x, foe.y) <= MELEE_RANGE) return null;

    /* How far this pawn is willing to move for a better cell. The
       player's draft order is the tightest leash there is. */
    var opts = { foes: foes };
    if (order && order.kind === 'flank' && Tactics.isSuppressed(foe)) opts.flank = true;

    if (drafted) {
      if (order && (order.kind === 'advance' || order.kind === 'flank')) {
        opts.anchorX = order.x; opts.anchorY = order.y; opts.anchorR = 7;
        opts.radius = 7;
      } else if (order && order.kind === 'hold') {
        opts.anchorX = order.x; opts.anchorY = order.y; opts.anchorR = 3;
        opts.radius = 3;
      } else {
        /* No order at all: a drafted pawn holds where the player put
           them, and only shuffles into cover when they are being shot
           at from open ground. */
        if (!st.broken && !Tactics.isSuppressed(pawn)) return null;
        opts.radius = 3;
        opts.anchorX = pawn.x; opts.anchorY = pawn.y; opts.anchorR = 3;
      }
    } else if (order && order.kind === 'advance') {
      opts.anchorX = order.x; opts.anchorY = order.y; opts.anchorR = 8;
    }

    /* The move budget and the floor between moves are checked here, in
       front of the one call that can produce a move. */
    if (st.relocations >= MAX_RELOCATIONS) return null;
    if (tick - st.lastRelocTick < MIN_RELOCATE_TICKS) return null;

    return coverJob(pawn, foe, opts);
  };

  /* ------------------------------------------------------------------
     Engagements and what they teach
     ------------------------------------------------------------------ */

  function startEngagement(pawn, st) {
    st.engaged = true;
    st.relocations = 0;
    st.broken = false;
  }

  function endEngagement(pawn, st) {
    st.engaged = false;
    st.broken = false;
    st.suppression = 0;
    st.targetId = 0;
    st.relocations = 0;
    st.fights++;
    if (!pawn.dead && !pawn.downed) {
      var before = Tactics.veterancy(pawn);
      st.xp += XP_SURVIVED;
      var after = Tactics.veterancy(pawn);
      if (before !== after && pawn.faction === 'player' && pawn.isHuman) {
        var G = sys('Game');
        if (G && G.msg) {
          G.msg((pawn.name && (pawn.name.nick || pawn.name.first) || 'A colonist') +
            ' came out of that fight ' + after + '.', { type: 'good', x: pawn.x, y: pawn.y });
        }
      }
    }
    releaseClaim(pawn);
  }

  /* Nerve check. Failing it does not make a pawn run - it makes them
     stop being useful, which the retreat and the cover leash read. */
  function breakCheck(pawn, st) {
    var bar = pawn.drafted ? DRAFTED_BREAK_SUPPRESSION : BREAK_SUPPRESSION;
    if (st.broken || st.suppression < bar) return;
    var nerve = traitFactor(pawn, TRAIT_NERVE);
    nerve *= 1 + Tactics.senseOf(pawn);
    var N = sys('Needs');
    if (N && N.mood) nerve *= U.lerp(0.6, 1.25, U.clamp01(N.mood(pawn)));
    /* Per half-second of being pinned: an ordinary pawn under sustained
       fire has about even odds of losing its nerve inside ten seconds,
       an iron-willed veteran almost never does. */
    var chance = U.clamp(0.06 / Math.max(0.3, nerve), 0.004, 0.2);
    if (pawn.drafted) chance *= 0.25;
    if (!U.chance(chance)) return;
    st.broken = true;
    stats.breaks++;
    st.nextThink = 0;
    if (pawn.job) endJob(pawn);
    var G = sys('Game');
    if (G && G.msg && pawn.faction === 'player') {
      G.msg((pawn.name && (pawn.name.nick || pawn.name.first) || 'A colonist') +
        ' is pinned down and losing their nerve.', { type: 'threat', x: pawn.x, y: pawn.y });
    }
  }

  /* ------------------------------------------------------------------
     The steer path

     For a pawn whose job somebody else owns. It never touches the job:
     it puts a path on the pawn and lets the driver keep running, which
     is the only way a raider driven by events.js can end up behind a
     rock without rewriting the raid driver.
     ------------------------------------------------------------------ */

  /* Jobs whose position tactics may adjust, and the wider set that
     says "this pawn is in a fight" - a colonist swinging a knife earns
     combat sense too, and a pawn running from a raider is still in the
     engagement it is running from. */
  var STEERABLE = { attackStatic: 1, waitCombat: 1 };
  var COMBAT_JOBS = {
    attackStatic: 1, waitCombat: 1, attackMelee: 1, flee: 1,
    takeCover: 1, combatRetreat: 1
  };

  function steer(pawn, st) {
    var job = pawn.job;
    if (!job || !STEERABLE[job.defId]) return;
    if (pawn.moving && pawn.moving()) return;
    if (st.relocations >= MAX_RELOCATIONS) return;

    var tick = gameTick();
    if (tick - st.lastRelocTick < MIN_RELOCATE_TICKS) return;

    var C = sys('Combat');
    if (!C) return;
    /* Between shots, never mid-burst. A firing pawn is in a stance
       almost every tick - the shoot toil starts the next one the moment
       combat.js clears the last - so waiting for no stance at all would
       mean never moving. Recovery is the window a real fighter uses,
       and moving in it costs at most the round that comes out of the
       far end of the cooldown. */
    var stance = C.stanceOf ? C.stanceOf(pawn) : null;
    if (stance && stance.mode !== 'cooldown') return;

    var w = rangedWeapon(pawn);
    if (!w) return;

    var map = pawn.map;
    var foe = job.targetA ? T.resolve(job.targetA, map) : null;
    if (!foe && pawn.aimTarget) foe = T.resolve(pawn.aimTarget, map);
    var foes = hostilesNear(pawn, SCAN_RADIUS);
    if (!foe || foe.dead || (isPawn(foe) && foe.downed)) foe = Tactics.pickTarget(pawn, foes);
    if (!foe) return;

    /* A drafted colonist steers on the shortest leash there is: the
       player put them there on purpose. */
    var opts = { foes: foes };
    if (pawn.drafted) {
      if (!Tactics.isSuppressed(pawn) && !st.broken) return;
      opts.radius = 3;
      opts.anchorX = pawn.x; opts.anchorY = pawn.y; opts.anchorR = 3;
    }

    var best = Tactics.bestFiringPosition(pawn, foe, opts);
    if (!best || best.travel === 0 || !best.los) return;
    var cur = best.current;
    if (cur && best.score < cur.score + RELOCATE_MARGIN) return;

    if (!pawn.startPath || pawn.startPath(best.x, best.y, PE.ON_CELL) === false) return;
    claimCell(pawn, best.x, best.y);
    noteMove(pawn, st, best.x, best.y);
  }

  /* ------------------------------------------------------------------
     The tick

     game.js calls tickPawn for every live pawn every tick, so the body
     of it has to be nearly free for the ninety-nine pawns who are not
     in a fight. The map-wide work - the one pass over the rounds in
     the air - is done once per tick by whichever pawn is ticked first.
     ------------------------------------------------------------------ */

  var _mapTick = -1;

  Tactics.tick = function (map, game) {
    var tick = game && typeof game.tick === 'number' ? game.tick : gameTick();
    if (tick === _mapTick || !map) return;
    _mapTick = tick;
    scanProjectiles(map);
  };

  Tactics.tickPawn = function (pawn) {
    if (!pawn || pawn.dead || !pawn.map) return;

    Tactics.tick(pawn.map, sys('Game'));

    var st = pawn.tactics;
    if (!st) {
      /* Nothing has happened to this pawn yet. Only give it a mind once
         it is holding a combat job or has been drafted. */
      if (pawn.isAnimal) return;
      if (!pawn.drafted && !(pawn.job && COMBAT_JOBS[pawn.job.defId])) return;
      st = stateOf(pawn);
    }

    if (st.suppression > 0) {
      st.suppression -= SUP_DECAY;
      if (st.suppression < 0) st.suppression = 0;
    }
    if (pawn.downed) { st.suppression = 0; st.broken = false; return; }

    /* The rest is the expensive half, on a staggered slice. The nerve
       check belongs here rather than in the decay above: rolled every
       tick it would break a pinned pawn within a second of the fire
       arriving, which is a panic, not a firefight. */
    if (((gameTick() + pawn.id) % 30) !== 0) return;
    if (st.suppression > 0) breakCheck(pawn, st);

    var near = hostilesNear(pawn, SCAN_RADIUS);
    if (near.length) {
      st.lastFoeTick = gameTick();
      if (!st.engaged) startEngagement(pawn, st);
      st.xp += XP_PER_COMBAT_TICK * 30;
      steer(pawn, st);
    } else if (st.engaged && gameTick() - st.lastFoeTick > ENGAGE_MEMORY) {
      endEngagement(pawn, st);
    }
  };

  /* ------------------------------------------------------------------
     Readouts, for whoever wants them
     ------------------------------------------------------------------ */

  Tactics.summary = function (pawn) {
    if (!pawn || pawn.isAnimal) return '';
    var st = pawn.tactics;
    var bits = [Tactics.veterancy(pawn)];
    if (!st) return bits[0];
    if (st.suppression >= SUPPRESSED_AT) bits.push('pinned');
    if (st.broken) bits.push('shaken');
    if (st.retreatUntil > gameTick()) bits.push('falling back');
    var order = Tactics.orderOf(pawn);
    if (order) bits.push(order.kind);
    return bits.join(' · ');
  };

  /* ------------------------------------------------------------------
     Save

     Per-pawn state rides on pawn.tactics, which save.js copies with
     the rest of the colonist, so a veteran stays a veteran. Only focus
     fire is global, and it is one id per faction.
     ------------------------------------------------------------------ */

  Tactics.save = function () {
    var out = { v: 1, focus: {} };
    for (var k in _focus) {
      if (Object.prototype.hasOwnProperty.call(_focus, k)) {
        out.focus[k] = { id: _focus[k].id, tick: _focus[k].tick };
      }
    }
    return out;
  };

  Tactics.load = function (obj) {
    _focus = {};
    _mapTick = -1;
    if (!obj || !obj.focus) return true;
    for (var k in obj.focus) {
      if (!Object.prototype.hasOwnProperty.call(obj.focus, k)) continue;
      var f = obj.focus[k];
      if (f && f.id) _focus[k] = { id: f.id | 0, tick: f.tick | 0 };
    }
    return true;
  };

  Tactics.reset = function () {
    _focus = {};
    _mapTick = -1;
  };

  root.Tactics = Tactics;
})(this);
