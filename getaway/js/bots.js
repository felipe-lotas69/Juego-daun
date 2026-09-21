/* ============================================================
   bots.js - AI opponents

   A bot drives the exact same input surface a human does: lean left,
   lean right, jump, interact, fire. It has no privileged access to
   the world - it paths over the nav graph, aims by leaning like
   everyone else, and can only shoot at angles the lean actually
   reaches.
   ============================================================ */
(function (root) {
  'use strict';

  /* engage  - how readily it starts a fight
     greed   - how far it will detour for a weapon
     risk    - tolerance for hazards and long jumps
     aimErr  - radians of slop before it pulls the trigger
     react   - seconds between re-decisions
     boom    - appetite for rockets, including rocket jumps
     hold    - how long it will stand still to line up a shot        */
  var PERSONALITIES = {
    dash: {
      key: 'dash', name: 'DASH', blurb: 'Runs. Does not stop, does not look back.',
      engage: 0.12, greed: 0.30, risk: 0.95, aimErr: 0.30, react: 0.30,
      boom: 0.75, hold: 0.20, range: 300, speedBias: 1.0
    },
    tank: {
      key: 'tank', name: 'TANK', blurb: 'Grabs every gun and comes looking for you.',
      engage: 0.92, greed: 0.95, risk: 0.60, aimErr: 0.18, react: 0.20,
      boom: 0.35, hold: 0.85, range: 480, speedBias: 0.85
    },
    quiet: {
      key: 'quiet', name: 'QUIET', blurb: 'Hangs back, takes its time, rarely misses.',
      engage: 0.70, greed: 0.70, risk: 0.28, aimErr: 0.07, react: 0.26,
      boom: 0.20, hold: 1.30, range: 620, speedBias: 0.8
    },
    chaos: {
      key: 'chaos', name: 'CHAOS', blurb: 'Explosives first. Thinking optional.',
      engage: 0.62, greed: 0.55, risk: 1.00, aimErr: 0.36, react: 0.14,
      boom: 1.00, hold: 0.35, range: 420, speedBias: 0.95
    }
  };

  var ORDER = ['dash', 'tank', 'quiet', 'chaos'];

  function Bot(personalityKey, seed) {
    this.p = PERSONALITIES[personalityKey] || PERSONALITIES.dash;
    this.seed = seed || Math.random() * 1000;
    this.st = {
      left: false, right: false, jump: false, jumpEdge: false,
      interact: false, fire: false, fireHold: false, drop: false
    };
    var st = this.st;
    this.input = {
      left: function () { return st.left; },
      right: function () { return st.right; },
      jump: function () { return st.jump; },
      jumpPressed: function () { return st.jumpEdge; },
      interactPressed: function () { return st.interact; },
      interactHeld: function () { return false; },
      firePressed: function () { return st.fire; },
      fireHeld: function () { return st.fireHold; },
      dropPressed: function () { return st.drop; },
      pressed: function () { return false; },
      mouse: { down: false, pressed: false }
    };

    this.path = null;
    this.pathAt = 0;
    this.thinkTimer = 0;
    this.target = null;          /* opponent being shot at */
    this.engageTimer = 0;
    this.detour = null;          /* a pickup worth a small diversion */
    this.stuckTimer = 0;
    this.lastX = 0; this.lastY = 0;
    this.unstick = 0;
    this.unstickDir = 1;
    this.jumpCool = 0;
    this.liftWait = 0;
  }

  Bot.prototype.reset = function () {
    this.bestToGoal = null;
    this.noProgress = 0;
    this.path = null;
    this.planChoice = null;
    this.planT = 0;
    this.pathAt = 0;
    this.target = null;
    this.detour = null;
    this.stuckTimer = 0;
    this.unstick = 0;
  };

  /* ---------------------------------------------------------- aiming
     The muzzle angle is a function of facing and lean, so a bot has to
     work out whether a shot is even reachable before committing. */
  function aimPlan(p, worldAngle) {
    /* facing right: aim = lean * 0.9 ; facing left: aim = PI + lean * 0.9 */
    var a = worldAngle;
    var leanR = a / 0.9;
    var la = a - Math.PI;
    while (la < -Math.PI) la += Math.PI * 2;
    while (la > Math.PI) la -= Math.PI * 2;
    var leanL = la / 0.9;
    var limit = p.grounded ? 1.2 : 1.45;

    var okR = Math.abs(a) < Math.PI / 2 && Math.abs(leanR) <= limit;
    var okL = Math.abs(la) < Math.PI / 2 && Math.abs(leanL) <= limit;
    /* on the ground you cannot lean away from your facing, so up-shots need air */
    if (p.grounded && okR && leanR < -0.05) okR = false;
    if (p.grounded && okL && leanL > 0.05) okL = false;

    if (okR && (!okL || Math.abs(leanR) <= Math.abs(leanL))) return { facing: 1, lean: leanR };
    if (okL) return { facing: -1, lean: leanL };
    return null;
  }

  /* ---------------------------------------------------------- think */
  Bot.prototype.think = function (dt, world, p) {
    var st = this.st;
    st.jumpEdge = false;
    st.interact = false;
    st.fire = false;
    st.drop = false;
    st.left = false;
    st.right = false;
    st.fireHold = false;

    if (p.dead || p.finished) return this.input;

    var P = this.p;
    var cx = p.x + p.w / 2, cy = p.y + p.h * 0.42;
    this.jumpCool = Math.max(0, this.jumpCool - dt);
    this.engageTimer = Math.max(0, this.engageTimer - dt);
    this.unstick = Math.max(0, this.unstick - dt);
    this.liftWait = Math.max(0, this.liftWait - dt);

    /* --- stuck detection: bumping a wall, wedged in a corner, waiting forever --- */
    var waitingOnPurpose = this.planChoice &&
      (this.planChoice.name === 'hold' || this.planChoice.name === 'back');
    if (U.dist2(cx, cy, this.lastX, this.lastY) < 16 * 16) {
      /* standing still because the plan says so is not the same as being wedged */
      this.stuckTimer += waitingOnPurpose ? dt * 0.22 : dt;
    } else {
      this.stuckTimer = Math.max(0, this.stuckTimer - dt * 2);
      this.lastX = cx; this.lastY = cy;
    }
    if (this.stuckTimer > 2.2 && this.unstick <= 0) {
      this.unstick = 0.8;
      this.unstickDir = -(this.lastDir || 1);
      this.stuckTimer = 0;
      this.path = null;
      this.planChoice = null;
    }

    /* --- last resort ---
       If a bot has not got closer to the van in a long time it is wedged in
       some corner the planner cannot see out of. Taking the respawn costs it
       the round but keeps the race moving. */
    var gc = { x: world.goal.x + world.goal.w / 2, y: world.goal.y + world.goal.h };
    var toGoal = U.dist(cx, cy, gc.x, gc.y);
    if (this.bestToGoal == null || toGoal < this.bestToGoal - 12) {
      this.bestToGoal = toGoal;
      this.noProgress = 0;
    } else {
      this.noProgress += dt;
      if (this.noProgress > 15) {
        this.noProgress = 0;
        this.bestToGoal = null;
        p.kill(world, 'gave up');
        return this.input;
      }
    }

    /* --- periodic re-decision (this is the bot's reaction time) --- */
    this.thinkTimer -= dt;
    if (this.thinkTimer <= 0) {
      this.thinkTimer = P.react * U.rand(0.8, 1.25);
      this.repath(world, p);
      this.pickTarget(world, p);
      this.pickDetour(world, p);
    }

    /* --- combat --- */
    var fighting = false;
    if (this.target && !this.target.dead && !this.target.finished && p.weapon) {
      fighting = this.fight(dt, world, p);
    }

    /* --- movement --- */
    if (!fighting) this.travel(dt, world, p);

    /* --- context key --- */
    this.useContext(world, p);

    return this.input;
  };

  /* ---------------------------------------------------------- routing */
  Bot.prototype.repath = function (world, p) {
    if (!world.nav) return;
    var goalPt = this.detour
      ? { x: this.detour.x + this.detour.w / 2, y: this.detour.y + this.detour.h }
      : { x: world.goal.x + world.goal.w / 2, y: world.goal.y + world.goal.h };

    var from = world.nav.nearest(p.x + p.w / 2, p.y + p.h, true);
    var to = world.nav.nearest(goalPt.x, goalPt.y, true);
    var path = world.nav.path(from, to);
    if (path && path.length) {
      this.path = path;
      this.pathAt = 0;
    }
  };

  Bot.prototype.pickTarget = function (world, p) {
    var P = this.p;
    this.target = null;
    if (!p.weapon || Math.random() > P.engage) return;
    var c = p.center();
    var best = null, bd = P.range * P.range;
    for (var i = 0; i < world.players.length; i++) {
      var o = world.players[i];
      if (o === p || o.dead || o.finished) continue;
      var oc = o.center();
      var d = U.dist2(c.x, c.y, oc.x, oc.y);
      if (d > bd) continue;
      if (!world.lineOfSight(c.x, c.y, oc.x, oc.y)) continue;
      bd = d; best = o;
    }
    /* goons count as targets too, in the campaign */
    for (i = 0; i < world.enemies.length && !best; i++) {
      var e = world.enemies[i];
      if (e.dead) continue;
      var ec = e.center();
      if (U.dist2(c.x, c.y, ec.x, ec.y) > bd) continue;
      if (!world.lineOfSight(c.x, c.y, ec.x, ec.y)) continue;
      best = e;
    }
    if (best) { this.target = best; this.engageTimer = P.hold; }
  };

  /* a weapon worth breaking stride for */
  Bot.prototype.pickDetour = function (world, p) {
    var P = this.p;
    var prev = this.detour;
    this.detour = null;

    /* Abandon a detour that is taking too long - chasing one pistol for the
       whole round is how a bot loses a race. */
    this.detourTime = prev ? (this.detourTime || 0) + P.react : 0;
    if (prev && this.detourTime > 3.2) {
      this.skipUntil = this.skipUntil || {};
      this.skipUntil[prev.x + ':' + prev.y] = world.time + 9;
      this.detourTime = 0;
      return;
    }

    var reach = 120 + P.greed * 320;
    var c = p.center();
    var gc = { x: world.goal.x + world.goal.w / 2, y: world.goal.y + world.goal.h };
    var myGoalDist = U.dist(c.x, c.y, gc.x, gc.y);
    var best = null, bd = reach * reach;
    for (var i = 0; i < world.pickups.length; i++) {
      var pk = world.pickups[i];
      if (pk.taken) continue;
      if (this.skipUntil && this.skipUntil[pk.x + ':' + pk.y] > world.time) continue;
      /* only worth it if it is on the way, not back down the course */
      if (U.dist(pk.x, pk.y, gc.x, gc.y) > myGoalDist + 40) continue;
      if (pk.key === 'medkit' && p.health > 70) continue;
      if (p.weapon && pk.key !== 'medkit') {
        /* only trade up, and only if it is close */
        var mine = WEAPONS[p.weapon.key], theirs = WEAPONS[pk.key];
        if (!theirs || !mine) continue;
        var better = (theirs.explosive && P.boom > 0.5) || theirs.damage * theirs.pellets > mine.damage * mine.pellets;
        if (!better || p.weapon.ammo > 3) continue;
      }
      var d = U.dist2(c.x, c.y, pk.x, pk.y);
      if (d < bd) { bd = d; best = pk; }
    }
    this.detour = best;
    if (best !== prev) this.detourTime = 0;
  };

  /* ---------------------------------------------------------- fighting */
  Bot.prototype.fight = function (dt, world, p) {
    var st = this.st, P = this.p;
    if (this.engageTimer <= 0) { this.target = null; return false; }

    /* Standing still to line up a shot is only an option somewhere safe.
       Without this a brawler will happily trade fire under a piston. */
    var danger = this.lethalBoxes(world);
    var room = { x: p.x - 26, y: p.y - 26, w: p.w + 52, h: p.h + 52 };
    for (var z = 0; z < danger.length; z++) {
      if (U.aabb(room, danger[z])) { this.target = null; this.engageTimer = 0; return false; }
    }

    var c = p.center(), tc = this.target.center();
    if (!world.lineOfSight(c.x, c.y, tc.x, tc.y)) { this.target = null; return false; }

    var lead = 0.1;
    var wa = Math.atan2(tc.y + this.target.vy * lead - c.y, tc.x + this.target.vx * lead - c.x);
    var plan = aimPlan(p, wa);
    if (!plan) { this.target = null; return false; }

    /* Steer the lean onto the firing solution. Pressing right grows the
       lean positive, pressing left grows it negative, and pressing
       nothing lets it fall back toward upright - so on the ground, where
       the keys also set facing, only one of those is available. */
    var want = plan.lean;
    var err = want - p.angle;

    if (p.grounded) {
      if (plan.facing !== p.facing) {
        if (plan.facing > 0) st.right = true; else st.left = true;
        return true;                       /* spend this tick turning around */
      }
      if (plan.facing > 0) {
        if (err > 0.05) st.right = true;   /* lean further into the shot */
      } else {
        if (err < -0.05) st.left = true;
      }
      /* the other direction is handled by releasing: the lean decays to 0 */
    } else {
      if (err > 0.05) st.right = true;
      else if (err < -0.05) st.left = true;
    }

    var def = WEAPONS[p.weapon.key];
    if (Math.abs(err) < P.aimErr) {
      /* do not fire a rocket into your own face */
      var dist = U.dist(c.x, c.y, tc.x, tc.y);
      if (!(def.explosive && dist < def.blast * 1.15)) {
        if (def.auto) st.fireHold = true; else st.fire = true;
      }
    }
    return true;
  };

  /* ---------------------------------------------------------- travelling

     Heuristics kept failing here because the movement model is genuinely
     awkward: you are airborne most of the time, and leaning over for
     distance costs you the height you need for the next step. So instead
     of guessing, the bot replays a handful of candidate plans through the
     real physics for two thirds of a second and picks the one that gets
     furthest without dying.                                              */

  var HORIZON = 0.80;
  var SIM_DT = 1 / 60;

  /* dir(t) and jump(t) for each candidate */
  var PLANS = [
    { name: 'run',     dir: function (t, d) { return d; },                 jump: function () { return false; } },
    { name: 'bound',   dir: function (t, d) { return d; },                 jump: function () { return true; } },
    { name: 'late',    dir: function (t, d) { return d; },                 jump: function (t) { return t >= 0.14; } },
    { name: 'charge',  dir: function (t, d) { return t < 0.16 ? 0 : d; },  jump: function (t) { return t >= 0.16; } },
    { name: 'charge2', dir: function (t, d) { return t < 0.30 ? 0 : d; },  jump: function (t) { return t >= 0.30; } },
    /* run in, then jump at the lip - without these the bot cannot plan any
       approach longer than a third of a second and simply refuses to move */
    { name: 'approach',  dir: function (t, d) { return d; },               jump: function (t) { return t >= 0.45; } },
    { name: 'approach2', dir: function (t, d) { return d; },               jump: function (t) { return t >= 0.62; } },
    { name: 'hold',    dir: function () { return 0; },                     jump: function () { return false; } },
    { name: 'back',    dir: function (t, d) { return -d; },                jump: function () { return false; } }
  ];

  function planInput(plan, d, clock) {
    return {
      left: function () { return plan.dir(clock.t, d) < 0; },
      right: function () { return plan.dir(clock.t, d) > 0; },
      jump: function () { return plan.jump(clock.t); },
      jumpPressed: function () { return plan.jump(clock.t); },
      interactPressed: function () { return false; },
      interactHeld: function () { return false; },
      firePressed: function () { return false; },
      fireHeld: function () { return false; },
      dropPressed: function () { return false; },
      pressed: function () { return false; },
      mouse: { down: false, pressed: false }
    };
  }

  var SCRATCH_KEYS = ['x', 'y', 'vx', 'vy', 'angle', 'facing', 'grounded', 'groundRef',
                      'hopTimer', 'coyote', 'jumpBuffer', 'stumble', 'flipTimer'];

  /* Everything in the world that will kill you, frozen for the horizon. */
  Bot.prototype.lethalBoxes = function (world) {
    var out = [], i;
    for (i = 0; i < world.hazards.length; i++) {
      var hb = world.hazards[i].hitbox();
      out.push({ x: hb.x - 4, y: hb.y - 4, w: hb.w + 8, h: hb.h + 8 });
    }
    for (i = 0; i < world.elevators.length; i++) {
      var e = world.elevators[i];
      if (!e.crusher) continue;
      if (e.timeToLow() < HORIZON + 0.45) {
        /* it is coming down inside our horizon: the whole column is lethal */
        var lo = Math.min(e.ay, e.by), hi = Math.max(e.ay, e.by);
        out.push({ x: Math.min(e.ax, e.bx), y: lo,
                   w: e.w + Math.abs(e.bx - e.ax), h: (hi - lo) + e.h });
      } else {
        out.push({ x: e.x, y: e.y, w: e.w, h: e.h });
      }
    }
    return out;
  };

  Bot.prototype.rollout = function (world, p, plan, d, target, lethal) {
    var sc = this._scratch || (this._scratch = new Player(0, 0));
    for (var k = 0; k < SCRATCH_KEYS.length; k++) sc[SCRATCH_KEYS[k]] = p[SCRATCH_KEYS[k]];
    sc.dead = false; sc.finished = false; sc.weapon = null;
    sc.invuln = 0; sc.emptyTimer = 0; sc.health = 100; sc.quietSim = true;
    sc.w = p.w; sc.h = p.h;

    var clock = { t: 0 };
    var input = planInput(plan, d, clock);
    var bestD = 1e18, died = false, i, j;
    var floor = world.level.height + 40;

    for (i = 0; i < Math.round(HORIZON / SIM_DT); i++) {
      sc.update(SIM_DT, world, input, true);
      clock.t += SIM_DT;

      if (sc.y > floor) { died = true; break; }
      for (j = 0; j < lethal.length; j++) {
        if (U.aabb(sc, lethal[j])) { died = true; break; }
      }
      if (died) break;

      var dd = U.dist2(sc.x + sc.w / 2, sc.y + sc.h, target.x, target.y);
      if (dd < bestD) bestD = dd;
    }

    var endD = U.dist2(sc.x + sc.w / 2, sc.y + sc.h, target.x, target.y);
    var score = -Math.sqrt(bestD) - 0.35 * Math.sqrt(endD);
    if (sc.grounded) score += 26;

    /* A long fall takes longer than the horizon, so the pit never shows up
       as a death inside the rollout. Recognise the shape of one instead:
       still airborne, dropping fast, and nothing underneath. */
    if (!died && !sc.grounded && sc.vy > 460) {
      var clear = true;
      for (var probe = 10; probe <= 320; probe += 16) {
        if (world.solidAt(sc.x + sc.w / 2, sc.y + sc.h + probe)) { clear = false; break; }
      }
      if (clear) died = true;
    }
    /* and simply ending up well below where we were headed is its own warning */
    if (!died && sc.y - target.y > 190) score -= 40000;

    /* when every option is fatal, buy the most time */
    if (died) score -= 100000 - clock.t * 4000;
    return score;
  };

  Bot.prototype.travel = function (dt, world, p) {
    var st = this.st, P = this.p;
    var cx = p.x + p.w / 2, feet = p.y + p.h;

    if (this.unstick > 0) {
      /* back out the way we came, but still refuse to walk into a blade */
      var esc = this.lethalBoxes(world);
      var tgt = { x: cx + this.unstickDir * 260, y: feet };
      var bestEsc = null, bestEscScore = -Infinity;
      for (var e = 0; e < PLANS.length; e++) {
        var es = this.rollout(world, p, PLANS[e], this.unstickDir, tgt, esc);
        if (es > bestEscScore) { bestEscScore = es; bestEsc = PLANS[e]; }
      }
      var ed = bestEsc.dir(0, this.unstickDir);
      if (ed > 0) st.right = true; else if (ed < 0) st.left = true;
      if (bestEsc.jump(0.2)) { st.jump = true; st.jumpEdge = true; }
      if (p.weapon && WEAPONS[p.weapon.key].explosive && p.angle > 0.8 && Math.random() < P.boom * dt * 3) {
        st.fire = true;
      }
      return this.input;
    }

    if (!this.path || !this.path.length) { this.repath(world, p); if (!this.path) return this.input; }

    /* --- advance along the route by progress, not proximity --- */
    var path = this.path, guard = 0;
    while (this.pathAt < path.length - 1 && guard++ < 64) {
      var here = path[this.pathAt], ahead = path[this.pathAt + 1];
      var dHere = U.dist2(cx, feet, here.x, here.y);
      if (dHere < 34 * 34 || U.dist2(cx, feet, ahead.x, ahead.y) < dHere) this.pathAt++;
      else break;
    }

    /* Aim the rollout at the next real transition, not just three nodes
       along. On a route that runs flat and then turns upward, a target on
       the same ledge means the bot never plans the climb at all. */
    var node = path[this.pathAt];
    var ti = this.pathAt, walked = 0;
    while (ti < path.length - 1 && ti < this.pathAt + 10) {
      ti++;
      if (path[ti].ref !== node.ref) break;
      walked += Math.abs(path[ti].x - path[ti - 1].x);
      if (walked > 170) break;
    }
    var lookahead = path[ti];
    var dirHint = lookahead.x > cx ? 1 : -1;
    if (Math.abs(lookahead.x - cx) < 20) dirHint = lookahead === node ? (this.lastDir || 1) : dirHint;
    this.lastDir = dirHint;

    /* --- aboard a moving lift: stand still and let it carry us --- */
    var stand = p.groundRef && p.groundRef.ref;
    if (p.grounded && stand && stand.kind === 'elevator' && Math.abs(stand.dy) > 0.02) {
      this.planChoice = null;
      return this.input;
    }

    /* --- re-plan on the personality's reaction clock --- */
    /* Re-plan faster than the personality's reaction clock: reaction time
       governs noticing things (targets, pickups), but steering wants a
       tight loop or the bot commits to a stale plan. */
    var planEvery = Math.min(P.react, 0.16);
    this.planT = (this.planT || 0) + dt;
    if (!this.planChoice || this.planT > planEvery) {
      var lethal = this.lethalBoxes(world);
      var target = { x: lookahead.x, y: lookahead.y };
      var best = null, bestScore = -Infinity;
      /* If we have been standing around too long, stop offering the bot the
         option of standing around. Waiting out a piston is smart; waiting
         out the whole match is not. */
      var mustMove = this.holdStreak > 2.6;
      for (var i = 0; i < PLANS.length; i++) {
        var plan = PLANS[i];
        var passive = plan.name === 'hold' || plan.name === 'back';
        if (mustMove && passive) continue;
        var sc = this.rollout(world, p, plan, dirHint, target, lethal);
        /* a cautious bot weights survival, a reckless one weights progress */
        if (passive) sc += (1 - P.risk) * 6;
        if (plan.name === 'bound') sc += P.speedBias * 8;
        if (sc > bestScore) { bestScore = sc; best = plan; }
      }
      this.planChoice = best || PLANS[0];
      this.planDir = dirHint;
      this.planT = 0;
      if (this.planChoice.name === 'hold' || this.planChoice.name === 'back') {
        this.holdStreak = (this.holdStreak || 0) + planEvery;
      } else {
        this.holdStreak = 0;
      }
    }

    var plan = this.planChoice;
    var d = this.planDir;
    var pd = plan.dir(this.planT, d);
    if (pd > 0) st.right = true; else if (pd < 0) st.left = true;
    if (plan.jump(this.planT)) { st.jump = true; st.jumpEdge = true; }
    return this.input;
  };

  /* ---------------------------------------------------------- the R key */
  Bot.prototype.useContext = function (world, p) {
    var it = p.prompt;
    if (!it) return;
    if (it.type === 'pickup') {
      if (it.obj.key === 'medkit' && p.health > 82) return;
      this.st.interact = true;
    } else if (it.type === 'button') {
      this.st.interact = true;
    } else if (it.type === 'elevator') {
      if (!it.obj.active && this.liftWait <= 0) {
        this.st.interact = true;
        this.liftWait = 1.2;
      }
    }
  };

  root.Bot = Bot;
  root.PERSONALITIES = PERSONALITIES;
  root.PERSONALITY_ORDER = ORDER;
})(typeof window !== 'undefined' ? window : globalThis);
