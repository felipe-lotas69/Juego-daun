/* ============================================================
   jobs.js - targets, reservations, the job driver, the toil
   vocabulary, and every personal job a pawn does for itself.

   A job is a small plan: a job def supplies a list of toils, a toil
   is a step that runs once per tick and answers 'stay', 'next',
   'done' or 'fail'. Nothing here knows why a pawn was given a job -
   workgivers.js and think.js decide that - and nothing here throws.
   A target that vanished mid-job is an ordinary outcome, not an
   exception, because half the targets in this game are items another
   colonist is already walking towards.

   Other systems register their own job defs against this registry at
   load time, so the behaviour of "mine a rock" lives in construct.js
   next to the mining rules. This file owns the machinery and the
   jobs a pawn does to its own body: eat, sleep, relax, haul, tend,
   and the five ways a colonist falls apart.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* pathfind.js is above us in the load order, so this reference is
     safe; the fallback exists only so the file can be loaded alone in
     a test sandbox. */
  var Path = root.Path;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  /* Everything a toil learns per work unit. Construct.js quotes the
     same constant; if these two ever disagree, a colonist learns
     mining faster by being given a different job def for it. */
  var XP_PER_WORK = 0.11;

  /* Work a pawn pours into the small jobs that have no def to read it
     from. All in work units, which at skill 0 is 0.4 per tick. */
  var CLEAN_WORK = 45;
  var FLICK_WORK = 14;
  var WEAR_WORK = 60;
  var BURY_WORK = 200;
  var TEND_WORK = 420;
  var FEED_WORK = 260;
  var EAT_TICKS = 240;          /* how long a meal takes to get through */

  /* Joy per tick while relaxing. The joy need falls 0.9/day - 0.000015
     per tick - so this refills in a few hundred ticks of sitting down,
     which is the point: recreation is cheap in time and expensive in
     the work not being done. */
  var JOY_RATE = 0.00042;

  /* A goto that has been repathing for this long has lost its target in
     some way the pathfinder cannot see. Longer than the worst honest
     walk across a 140x140 map. */
  var GOTO_TIMEOUT = 6000;
  var CARRY_TIMEOUT = 9000;

  function sys(name) { return root[name] || null; }

  function now() {
    var G = root.Game;
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  function msg(text, pawn, type) {
    var G = root.Game;
    if (G && G.msg) G.msg(text, { type: type || 'info', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    var n = pawn.name;
    if (!n) return 'someone';
    return n.nick || n.first || 'someone';
  }

  function isPawnLike(x) {
    return !!x && x.needs !== undefined && x.isAnimal !== undefined;
  }

  function skillLevel(pawn, id) {
    var s = pawn && pawn.skills && pawn.skills[id];
    return (s && typeof s.level === 'number') ? s.level : 0;
  }

  /* The contract's curve: 0.4 work units per tick at level 0, 2.0 at
     level 20, scaled by how well the body still works. */
  function workRate(pawn, skillId) {
    var H = sys('Health');
    var f = (H && H.workSpeedFactor) ? H.workSpeedFactor(pawn) : 1;
    return (0.4 + 0.08 * skillLevel(pawn, skillId)) * f;
  }

  function capacity(pawn, name) {
    var H = sys('Health');
    return (H && H.capacity) ? H.capacity(pawn, name) : 1;
  }

  /* pawn.js owns xp and levelling. The brief names pawn.learn, and the
     rest are the spellings the other systems already probe for. */
  function learn(pawn, skillId, xp) {
    if (!pawn || !skillId || !(xp > 0)) return;
    if (typeof pawn.learn === 'function') { pawn.learn(skillId, xp); return; }
    var P = root.Pawn;
    if (P) {
      if (typeof P.learn === 'function') { P.learn(pawn, skillId, xp); return; }
      if (typeof P.gainXp === 'function') { P.gainXp(pawn, skillId, xp); return; }
    }
    var s = pawn.skills && pawn.skills[skillId];
    if (!s) return;
    var passion = [0.35, 1.0, 1.5][s.passion || 0] || 1;
    s.xp = (s.xp || 0) + xp * passion;
    while (s.level < 20 && s.xp >= 1000 * (s.level + 1)) {
      s.xp -= 1000 * (s.level + 1);
      s.level++;
    }
  }

  /* ---------- movement ----------
     pawn.js walks the path; jobs.js only decides where the path goes.
     These write the exact fields the pawn model documents, which is the
     same handshake animals.js and combat.js use. */

  /* destX/destY name the GOAL, not the end of the path: the two differ
     whenever the end mode is TOUCH or INTERACTION, and pawn.js rebuilds
     a route from those fields plus pathMode when a wall goes up across
     a walk. Writing the path's last cell there instead would quietly
     turn a blocked walk to a workbench into a walk to whichever tile
     the old route happened to finish on. */
  function setPath(pawn, path, map, gx, gy, mode) {
    var last = path[path.length - 1];
    if (gx === undefined) { gx = map.xOf(last); gy = map.yOf(last); }
    pawn.path = path;
    pawn.pathIdx = 0;
    pawn.moveProgress = 0;
    pawn.destX = gx;
    pawn.destY = gy;
    pawn.pathMode = mode === undefined ? PE.ON_CELL : mode;
    pawn.pathDest = map.idx(gx, gy);
  }

  function stopMoving(pawn) {
    pawn.path = null;
    pawn.pathIdx = 0;
    pawn.pathDest = -1;
    pawn.destX = pawn.x;
    pawn.destY = pawn.y;
  }

  function isMoving(pawn) {
    return !!(pawn.path && pawn.pathIdx < pawn.path.length);
  }

  function walkTo(pawn, x, y, mode) {
    var map = pawn.map;
    if (!Path || !map.inBounds(x, y)) return false;
    if (mode === undefined) mode = PE.ON_CELL;
    var path = Path.find(map, pawn.x, pawn.y, x, y, { pawn: pawn, peMode: mode });
    if (!path) return false;
    if (!path.length) { stopMoving(pawn); return true; }
    setPath(pawn, path, map, x, y, mode);
    return true;
  }

  function faceToward(pawn, x, y) {
    var dx = x - pawn.x, dy = y - pawn.y;
    if (Math.abs(dx) > Math.abs(dy)) pawn.dir = dx > 0 ? 1 : 3;
    else if (dy !== 0) pawn.dir = dy > 0 ? 2 : 0;
  }

  /* ============================================================
     T - targets

     A target is a plain, JSON-safe record of what a job is aimed at,
     never a live reference: save.js writes jobs straight out, and a
     job that held a Thing would drag the whole map through the
     serialiser. Resolution goes through the map every time, which is
     also what makes "the steel I was walking to is gone" answerable
     rather than a dangling pointer.
     ============================================================ */

  var T = {};
  T.none = null;

  T.thing = function (thing) {
    if (!thing || thing.id === undefined) return null;
    return { k: 't', id: thing.id, x: thing.x | 0, y: thing.y | 0 };
  };

  T.cell = function (x, y) {
    return { k: 'c', x: x | 0, y: y | 0 };
  };

  T.pawn = function (pawn) {
    if (!pawn || pawn.id === undefined) return null;
    return { k: 'p', id: pawn.id, x: pawn.x | 0, y: pawn.y | 0 };
  };

  /* A pawn id index rebuilt at most once per tick. Pawn targets are
     resolved every tick by every combat, doctor and rescue job, and a
     linear scan of the pawn list per lookup is the kind of cost that
     only shows up once a raid is on the map. */
  function pawnIndex(map) {
    var stamp = now();
    if (!(map.__pawnById instanceof Map) ||
        map.__pawnByIdN !== map.pawns.length ||
        map.__pawnByIdTick !== stamp) {
      var idx = new Map();
      for (var i = 0; i < map.pawns.length; i++) idx.set(map.pawns[i].id, map.pawns[i]);
      map.__pawnById = idx;
      map.__pawnByIdN = map.pawns.length;
      map.__pawnByIdTick = stamp;
    }
    return map.__pawnById;
  }

  /* Who is holding the thing that is no longer on the map. Only ever
     reached when map.things has already said no, which happens for a
     stack the moment somebody picks the whole thing up - and a job
     that just picked its target up should not decide it has vanished. */
  var _holder = null;

  function findHeld(map, id) {
    _holder = null;
    var pawns = map.pawns, i, j, p;
    for (i = 0; i < pawns.length; i++) {
      p = pawns[i];
      if (p.carried && p.carried.id === id) { _holder = p; return p.carried; }
      if (p.equipment && p.equipment.id === id) { _holder = p; return p.equipment; }
      var inv = p.inventory;
      if (inv) for (j = 0; j < inv.length; j++) if (inv[j].id === id) { _holder = p; return inv[j]; }
      var ap = p.apparel;
      if (ap) for (j = 0; j < ap.length; j++) if (ap[j].id === id) { _holder = p; return ap[j]; }
    }
    return null;
  }

  T.resolve = function (target, map) {
    if (!target || !map) return null;
    if (target.k === 'c') return null;
    if (target.k === 'p') {
      var p = pawnIndex(map).get(target.id) || null;
      return (p && !p.dead) ? p : null;
    }
    if (target.k === 't') {
      _holder = null;
      var t = map.things.get(target.id);
      if (t) return t;
      return findHeld(map, target.id);
    }
    return null;
  };

  T.pos = function (target, map) {
    if (!target) return null;
    if (target.k === 'c') {
      return (map && !map.inBounds(target.x, target.y)) ? null : { x: target.x, y: target.y };
    }
    if (!map) return { x: target.x, y: target.y };
    var found = T.resolve(target, map);
    if (!found) return null;
    /* A carried stack keeps the coordinates it had on the floor, so ask
       the carrier where it actually is. */
    if (target.k === 't' && _holder && _holder.carried === found) {
      return { x: _holder.x, y: _holder.y };
    }
    return { x: found.x, y: found.y };
  };

  T.valid = function (target, map) {
    if (!target) return false;
    if (target.k === 'c') return !map || map.inBounds(target.x, target.y);
    return T.resolve(target, map) !== null;
  };

  /* The reservation key, and the only place the shape of one is
     decided: 't:12', 'c:4021', 'p:7'. */
  T.key = function (target, map) {
    if (!target) return null;
    if (target.k === 'c') {
      return 'c:' + (map ? map.idx(target.x, target.y) : target.x + '_' + target.y);
    }
    return target.k + ':' + target.id;
  };

  T.label = function (target, map) {
    if (!target) return 'nothing';
    if (target.k === 'c') return 'that spot';
    var x = T.resolve(target, map);
    if (!x) return 'something';
    if (isPawnLike(x)) return nameOf(x);
    if (typeof x.label === 'function') return x.label();
    return (x.def && x.def.label) || 'something';
  };

  T.equal = function (a, b) {
    if (a === b) return true;
    if (!a || !b || a.k !== b.k) return false;
    if (a.k === 'c') return a.x === b.x && a.y === b.y;
    return a.id === b.id;
  };

  /* ============================================================
     Res - reservations

     Two colonists walking thirty tiles to the same steel stack is the
     single most visible AI failure in a colony sim, so every job
     claims what it is about to use. Claims live on the map under a
     dunder key: save.js drops them wholesale and the colony rebuilds
     them on the next job, which is correct - a reservation is a
     statement about pawns who are mid-walk, and after a load nobody
     is mid-walk.
     ============================================================ */

  var Res = {};

  function table(map) {
    if (!(map.__reservations instanceof Map)) map.__reservations = new Map();
    return map.__reservations;
  }

  function entryFor(map, target, create) {
    var key = T.key(target, map);
    if (!key) return null;
    var tbl = table(map);
    var e = tbl.get(key);
    if (!e && create) { e = { ids: [], max: 1 }; tbl.set(key, e); }
    return e;
  }

  Res.canReserve = function (pawn, target, max) {
    if (!pawn || !target) return false;
    var map = pawn.map;
    if (!map) return false;
    var e = entryFor(map, target, false);
    if (!e || !e.ids.length) return true;
    if (e.ids.indexOf(pawn.id) >= 0) return true;
    var limit = max > 0 ? max : (e.max || 1);
    return e.ids.length < limit;
  };

  Res.reserve = function (pawn, target, max) {
    if (!pawn || !target || !pawn.map) return false;
    if (!Res.canReserve(pawn, target, max)) return false;
    var e = entryFor(pawn.map, target, true);
    if (!e) return false;
    e.max = max > 0 ? max : 1;
    if (e.ids.indexOf(pawn.id) < 0) e.ids.push(pawn.id);
    return true;
  };

  Res.release = function (pawn, target) {
    if (!pawn || !target || !pawn.map) return false;
    var key = T.key(target, pawn.map);
    var tbl = table(pawn.map);
    var e = tbl.get(key);
    if (!e) return false;
    var i = e.ids.indexOf(pawn.id);
    if (i < 0) return false;
    e.ids.splice(i, 1);
    if (!e.ids.length) tbl.delete(key);
    return true;
  };

  /* Job end calls this unconditionally, so it has to be cheap when the
     pawn holds nothing. The table only ever contains live claims -
     empty entries are deleted - so it stays about as long as the
     number of colonists currently working. */
  Res.releaseAll = function (pawn) {
    if (!pawn || !pawn.map) return 0;
    var tbl = table(pawn.map);
    if (!tbl.size) return 0;
    var dead = null, n = 0;
    tbl.forEach(function (e, key) {
      var i = e.ids.indexOf(pawn.id);
      if (i < 0) return;
      e.ids.splice(i, 1);
      n++;
      if (!e.ids.length) { if (!dead) dead = []; dead.push(key); }
    });
    if (dead) for (var k = 0; k < dead.length; k++) tbl.delete(dead[k]);
    return n;
  };

  Res.reservedBy = function (map, target) {
    if (!map || !target) return null;
    var e = entryFor(map, target, false);
    if (!e || !e.ids.length) return null;
    return pawnIndex(map).get(e.ids[0]) || null;
  };

  Res.claimants = function (map, target) {
    var out = [];
    if (!map || !target) return out;
    var e = entryFor(map, target, false);
    if (!e) return out;
    var idx = pawnIndex(map);
    for (var i = 0; i < e.ids.length; i++) {
      var p = idx.get(e.ids[i]);
      if (p) out.push(p);
    }
    return out;
  };

  /* True when somebody else has it. The common question a work giver
     asks, phrased so it reads the right way round at the call site. */
  Res.takenBy = function (pawn, target, max) {
    return !Res.canReserve(pawn, target, max);
  };

  Res.clear = function (map) { if (map) map.__reservations = new Map(); };

  /* ============================================================
     Job
     ============================================================ */

  function Job(defId, targetA, targetB, opts) {
    opts = opts || {};
    this.id = U.nextId();
    this.defId = defId;
    this.def = Jobs.defs[defId] || null;
    this.targetA = targetA || null;
    this.targetB = targetB || null;
    this.targetC = opts.targetC || null;
    this.count = opts.count === undefined ? -1 : (opts.count | 0);
    this.bill = opts.bill || null;
    this.workLeft = opts.workLeft || 0;
    this.playerForced = !!opts.playerForced;
    this.state = opts.state || {};
    this.toilIdx = 0;
    this.toilState = {};
    /* needs.js reads joyKind off the job to decide whether the pawn is
       recreating or working. */
    this.joyKind = opts.joyKind || (this.def && this.def.joyKind) || null;
    this.startTick = -1;
  }

  /* ============================================================
     The registry and the driver
     ============================================================ */

  var Jobs = {};
  /* A plain table rather than a Map: a job registry is read far more
     often than it is written, it round-trips through a headless
     checker in another realm (where `instanceof Map` is false), and a
     null prototype keeps an id called 'constructor' from ever
     resolving to something that is not a job def. */
  Jobs.defs = Object.create(null);
  Jobs.XP_PER_WORK = XP_PER_WORK;

  Jobs.register = function (id, spec) {
    spec = spec || {};
    var def = {
      id: id,
      label: spec.label || id,
      reportString: spec.reportString || null,
      toils: spec.toils || null,
      suspendable: spec.suspendable !== false,
      alwaysShow: !!spec.alwaysShow,
      joyKind: spec.joyKind || null,
      keepCarried: !!spec.keepCarried,
      allowGoneTarget: !!spec.allowGoneTarget,
      onEnd: spec.onEnd || null
    };
    Jobs.defs[id] = def;
    return def;
  };

  Jobs.def = function (id) { return Jobs.defs[id] || null; };
  Jobs.isRegistered = function (id) { return !!Jobs.defs[id]; };
  Jobs.defIds = function () { return Object.keys(Jobs.defs); };

  Jobs.make = function (defId, targetA, targetB, opts) {
    return new Job(defId, targetA, targetB, opts);
  };

  /* Starting a job is the one place the whole plan is checked: the def
     exists, it produces a toil list, and the thing the job is about
     still exists. Everything after this point is allowed to assume the
     plan was sane once. */
  Jobs.start = function (pawn, job) {
    if (!pawn || !job) return false;
    var def = job.def || Jobs.defs[job.defId];
    if (!def || typeof def.toils !== 'function') {
      if (root.Game && root.Game.debug) console.log('[jobs] no def for ' + job.defId);
      return false;
    }
    job.def = def;

    if (!def.allowGoneTarget && job.targetA && !T.valid(job.targetA, pawn.map)) return false;

    if (pawn.job) Jobs.end(pawn, 'interrupted');

    var toils;
    try {
      toils = def.toils(job, pawn);
    } catch (e) {
      if (root.Game && root.Game.debug) console.log('[jobs] toils threw for ' + job.defId + ': ' + e);
      return false;
    }
    if (!toils || !toils.length) return false;

    job.toilIdx = 0;
    job.toilState = {};
    job.startTick = now();
    pawn.job = job;
    pawn.driver = {
      job: job,
      toils: toils,
      idx: 0,
      s: job.toilState,
      entered: false,
      ticks: 0
    };
    return true;
  };

  /* One tick of the current toil. A toil may advance several steps in
     one tick - claiming a target and finding you are already standing
     on it is two 'next' answers with no time between them - so the
     loop runs until something says 'stay' or the job ends. */
  Jobs.tick = function (pawn) {
    var job = pawn && pawn.job, d = pawn && pawn.driver;
    if (!job || !d) return;
    d.ticks++;

    var guard = d.toils.length + 4;
    while (guard-- > 0) {
      var toil = d.toils[d.idx];
      if (!toil) { Jobs.end(pawn, 'done'); return; }

      if (!d.entered) {
        d.entered = true;
        job.toilIdx = d.idx;
        if (toil.init) {
          try { toil.init(pawn, job, d.s); }
          catch (e) { reportToilError(pawn, job, toil, e); Jobs.end(pawn, 'failed'); return; }
        }
      }

      var result;
      try {
        result = toil.tick ? toil.tick(pawn, job, d.s) : 'next';
      } catch (e) {
        reportToilError(pawn, job, toil, e);
        Jobs.end(pawn, 'failed');
        return;
      }

      if (result === 'stay' || result === undefined || result === null) return;
      if (result === 'done') { finishToil(pawn, job, d); Jobs.end(pawn, 'done'); return; }
      if (result === 'fail') { finishToil(pawn, job, d); Jobs.end(pawn, 'failed'); return; }

      /* 'next', and anything a toil returned by mistake, advances. */
      finishToil(pawn, job, d);
      d.idx++;
      if (d.idx >= d.toils.length) { Jobs.end(pawn, 'done'); return; }
      d.entered = false;
      d.s = job.toilState = {};
    }
    /* A toil list that advanced more times than it has toils is looping
       on itself; ending it beats spinning the whole frame. */
    Jobs.end(pawn, 'failed');
  };

  function finishToil(pawn, job, d) {
    var toil = d.toils[d.idx];
    if (!toil || !toil.end || !d.entered) return;
    try { toil.end(pawn, job, d.s); }
    catch (e) { reportToilError(pawn, job, toil, e); }
  }

  function reportToilError(pawn, job, toil, e) {
    if (root.Game && root.Game.debug) {
      console.log('[jobs] ' + job.defId + '/' + (toil && toil.name) + ' threw: ' + (e && e.stack || e));
    }
  }

  Jobs.end = function (pawn, reason) {
    if (!pawn) return;
    var job = pawn.job;
    if (!job) { Res.releaseAll(pawn); return; }
    /* A toil's end handler is allowed to touch the pawn, and touching
       the pawn is allowed to end its job. Do not re-enter. */
    if (pawn.__endingJob) return;
    pawn.__endingJob = true;
    reason = reason || 'done';

    var d = pawn.driver;
    if (d) finishToil(pawn, job, d);
    if (job.def && job.def.onEnd) {
      try { job.def.onEnd(pawn, job, reason); }
      catch (e) { reportToilError(pawn, job, { name: 'onEnd' }, e); }
    }

    pawn.job = null;
    pawn.driver = null;
    pawn.lastJobEndTick = now();
    pawn.lastJobDefId = job.defId;
    pawn.lastJobEndReason = reason;
    pawn.asleep = false;
    stopMoving(pawn);

    /* Releasing is mandatory: a claim that outlives its job locks a
       stack out of the colony until a reload. */
    Res.releaseAll(pawn);

    if (pawn.carried && !(job.def && job.def.keepCarried)) {
      placeCarried(pawn, pawn.x, pawn.y);
    }
    pawn.__endingJob = false;
  };

  Jobs.report = function (pawn) {
    var job = pawn && pawn.job;
    if (!job) return 'Standing';
    var def = job.def || Jobs.defs[job.defId];
    var rs = def && def.reportString;
    if (typeof rs === 'function') {
      try {
        var out = rs(job, pawn);
        if (out) return out;
      } catch (e) { /* a broken report string must not break the tick */ }
    } else if (typeof rs === 'string' && rs) {
      return fillReport(rs, job, pawn);
    }
    return U.cap((def && def.label) || job.defId) + '.';
  };

  /* {A} {B} {C} become the target labels, {count} the job's count. */
  function fillReport(template, job, pawn) {
    var map = pawn.map;
    return template.replace(/\{(A|B|C|count)\}/g, function (all, key) {
      if (key === 'count') return String(job.count > 0 ? job.count : 1);
      return T.label(job['target' + key], map);
    });
  }

  /* ============================================================
     Toils
     ============================================================ */

  var Toils = {};

  Toils.custom = function (spec) {
    spec = spec || {};
    return {
      name: spec.name || 'custom',
      init: spec.init || null,
      tick: spec.tick || null,
      end: spec.end || spec.onEnd || null
    };
  };

  /* Where a pawn has to stand to count as "there", per path-end mode.
     Path.findTo picks the same cells; this is the arrival test for the
     tick the pawn steps onto one of them, and for the case where it
     was already standing there when the job began. */
  function inRangeOf(pawn, target, map, mode) {
    var pos = T.pos(target, map);
    if (!pos) return false;
    var thing = T.resolve(target, map);
    var solid = thing && thing.def && typeof thing.covers === 'function' && !isPawnLike(thing);

    if (mode === PE.INTERACTION) {
      var spot = (solid && typeof thing.interactionCell === 'function') ? thing.interactionCell() : null;
      if (spot) return pawn.x === spot.x && pawn.y === spot.y;
      mode = PE.TOUCH;
    }
    if (mode === PE.ON_CELL) return pawn.x === pos.x && pawn.y === pos.y;

    if (solid) {
      if (mode === PE.TOUCH && thing.covers(pawn.x, pawn.y)) return true;
      var f = thing.footprint();
      return pawn.x >= thing.x - 1 && pawn.x <= thing.x + f.w &&
             pawn.y >= thing.y - 1 && pawn.y <= thing.y + f.h;
    }
    if (mode === PE.TOUCH && pawn.x === pos.x && pawn.y === pos.y) return true;
    return U.cheb(pawn.x, pawn.y, pos.x, pos.y) <= 1;
  }
  Toils.inRangeOf = inRangeOf;

  Toils.goto = function (which, opts) {
    opts = opts || {};
    var mode = opts.peMode !== undefined ? opts.peMode
             : (opts.pe !== undefined ? opts.pe : PE.ON_CELL);
    var checkGone = opts.failIfGone !== false;
    return {
      name: 'goto' + which,
      init: function (pawn, job, s) {
        s.destX = -9999; s.destY = -9999; s.cool = 0; s.ticks = 0; s.fails = 0;
      },
      tick: function (pawn, job, s) {
        var map = pawn.map;
        var target = job['target' + which];
        if (!target) return 'fail';
        if (checkGone && !T.valid(target, map)) return 'fail';
        var pos = T.pos(target, map);
        if (!pos) return 'fail';

        if (inRangeOf(pawn, target, map, mode)) { stopMoving(pawn); return 'next'; }
        if (++s.ticks > GOTO_TIMEOUT) return 'fail';

        /* Repath when the pawn has run out of path, or when a moving
           target has drifted off the cell the path was aimed at. The
           cooldown is what stops a chase from repathing every tick. */
        var drifted = U.cheb(pos.x, pos.y, s.destX, s.destY) > 1;
        if (s.cool > 0) s.cool--;
        if (!isMoving(pawn) || (drifted && s.cool === 0)) {
          if (!Path) return 'fail';
          var path = Path.findTo(map, pawn, target, {
            peMode: mode,
            pawn: pawn,
            maxCells: opts.maxCells | 0,
            avoidFire: !!opts.avoidFire
          });
          if (!path) {
            /* Unreachable. One retry covers a door that just closed or
               a colonist standing in the only gap. */
            return (++s.fails > 1) ? 'fail' : 'stay';
          }
          if (!path.length) { stopMoving(pawn); return 'next'; }
          setPath(pawn, path, map, pos.x, pos.y, mode);
          s.destX = pos.x; s.destY = pos.y; s.cool = 12; s.fails = 0;
        }
        return 'stay';
      }
    };
  };

  Toils.wait = function (ticks) {
    return {
      name: 'wait',
      init: function (pawn, job, s) {
        s.left = typeof ticks === 'function' ? ticks(pawn, job) : ticks;
        if (!(s.left > 0)) s.left = 1;
        stopMoving(pawn);
      },
      tick: function (pawn, job, s) {
        if (job.targetA) {
          var pos = T.pos(job.targetA, pawn.map);
          if (pos) faceToward(pawn, pos.x, pos.y);
        }
        return (--s.left <= 0) ? 'next' : 'stay';
      }
    };
  };

  /* Stand still and run a function every tick. The function's return is
     the toil's, so a caller can end the wait on any condition it likes. */
  Toils.waitWith = function (fn, opts) {
    opts = opts || {};
    return {
      name: opts.name || 'waitWith',
      init: function (pawn, job, s) { s.ticks = 0; stopMoving(pawn); },
      tick: function (pawn, job, s) {
        s.ticks++;
        var r = fn(pawn, job, s);
        return r || 'stay';
      }
    };
  };

  Toils.failIf = function (fn) {
    return {
      name: 'failIf',
      tick: function (pawn, job, s) { return fn(pawn, job, s) ? 'fail' : 'next'; }
    };
  };

  Toils.reserve = function (which, max) {
    return {
      name: 'reserve' + which,
      tick: function (pawn, job) {
        var target = job['target' + which];
        if (!target) return 'fail';
        return Res.reserve(pawn, target, max === undefined ? 1 : max) ? 'next' : 'fail';
      }
    };
  };

  /* The general work toil: pour work units into something until the
     total is met, learning as you go. Everything that has no side
     effect beyond "time passes and a number goes up" uses this. */
  Toils.work = function (opts) {
    opts = opts || {};
    var which = opts.which || 'A';
    return {
      name: opts.name || 'work',
      init: function (pawn, job, s) {
        s.total = typeof opts.amount === 'function' ? opts.amount(pawn, job) : (opts.amount || 0);
        if (!(s.total > 0)) s.total = 1;
        var thing = opts.progressKey ? T.resolve(job['target' + which], pawn.map) : null;
        s.done = (thing && typeof thing[opts.progressKey] === 'number') ? thing[opts.progressKey] : 0;
        s.rate = 0;
        stopMoving(pawn);
        if (opts.init) opts.init(pawn, job, s);
      },
      tick: function (pawn, job, s) {
        var map = pawn.map;
        var target = job['target' + which];
        var thing = target ? T.resolve(target, map) : null;
        if (opts.failIfGone && target && !T.valid(target, map)) return 'fail';
        if (thing && thing.spawned !== false) faceToward(pawn, thing.x, thing.y);

        var rate = opts.rate ? opts.rate(pawn, job) : workRate(pawn, opts.skill);
        if (!(rate > 0)) rate = 0.4;
        s.rate = rate;
        s.done += rate;
        if (opts.progressKey && thing) thing[opts.progressKey] = s.done;
        if (opts.skill) learn(pawn, opts.skill, rate * XP_PER_WORK);

        if (opts.onTick) {
          var early = opts.onTick(pawn, job, s);
          if (early) return early;
        }
        if (s.done < s.total) return 'stay';
        if (opts.onDone) {
          var last = opts.onDone(pawn, job, s);
          if (last) return last;
        }
        return 'next';
      },
      end: opts.onEnd || null
    };
  };

  Toils.pickUp = function (which, countFn) {
    return {
      name: 'pickUp' + which,
      tick: function (pawn, job) {
        var map = pawn.map;
        var target = job['target' + which];
        if (!target) return 'fail';
        var thing = T.resolve(target, map);
        if (!thing || isPawnLike(thing)) return 'fail';
        /* Already in hand: the previous toil picked it up, or a job was
           resumed. Nothing to do. */
        if (pawn.carried === thing) return 'next';
        if (!thing.spawned) return 'fail';
        if (U.cheb(pawn.x, pawn.y, thing.x, thing.y) > 1 && !(typeof thing.covers === 'function' && thing.covers(pawn.x, pawn.y))) {
          return 'fail';
        }

        var want = countFn ? (countFn(pawn, job) | 0)
                 : (job.count > 0 ? job.count : (thing.stack || 1));
        if (want <= 0) return 'fail';
        if (want > (thing.stack || 1)) want = thing.stack || 1;

        /* Hands are not a bag. Anything already held that will not merge
           goes on the floor rather than silently disappearing. */
        if (pawn.carried && pawn.carried.defId !== thing.defId) {
          placeCarried(pawn, pawn.x, pawn.y);
        }
        var limit = (thing.def.stackLimit || 1);
        if (pawn.carried) {
          var room = limit - pawn.carried.stack;
          if (room <= 0) return 'next';
          if (want > room) want = room;
        }

        var part = map.splitStack(thing, want);
        if (!part) return 'fail';
        part.x = pawn.x; part.y = pawn.y;
        part.spawned = false;
        part.map = map;
        if (pawn.carried) {
          map.mergeInto(part, pawn.carried);
        } else {
          pawn.carried = part;
        }
        return 'next';
      }
    };
  };

  /* Walk to a thing and pick it up in one step, for the jobs that only
     ever do those two things in sequence. */
  Toils.startCarry = function (which, countFn, opts) {
    opts = opts || {};
    var go = Toils.goto(which, { pe: PE.TOUCH, failIfGone: true, maxCells: opts.maxCells });
    var grab = Toils.pickUp(which, countFn);
    return {
      name: 'startCarry' + which,
      init: function (pawn, job, s) { s.phase = 0; s.go = {}; go.init(pawn, job, s.go); },
      tick: function (pawn, job, s) {
        if (s.phase === 0) {
          var r = go.tick(pawn, job, s.go);
          if (r === 'stay') return 'stay';
          if (r !== 'next') return r;
          s.phase = 1;
        }
        return grab.tick(pawn, job);
      }
    };
  };

  Toils.dropCarried = function (which) {
    return {
      name: 'dropCarried',
      tick: function (pawn, job) {
        if (!pawn.carried) return 'next';
        var pos = which ? T.pos(job['target' + which], pawn.map) : null;
        if (!pos) pos = { x: pawn.x, y: pawn.y };
        placeCarried(pawn, pos.x, pos.y);
        return 'next';
      }
    };
  };

  Toils.putInStorage = function (which) {
    return {
      name: 'putInStorage',
      tick: function (pawn, job) {
        if (!pawn.carried) return 'next';
        var pos = T.pos(job['target' + which], pawn.map) || { x: pawn.x, y: pawn.y };
        placeCarried(pawn, pos.x, pos.y);
        if (job['target' + which]) Res.release(pawn, job['target' + which]);
        return 'next';
      }
    };
  };

  /* Put whatever is in hand on the floor at a cell, merging into a
     stack that is already there. Used by the storage toils, by the
     drop job, and by Jobs.end when a job dies holding something. */
  function placeCarried(pawn, x, y) {
    var thing = pawn.carried;
    if (!thing) return null;
    var map = pawn.map;
    pawn.carried = null;
    if (!map) return null;
    if (!map.inBounds(x, y) || !map.passable(x, y)) {
      var free = map.freeNeighbour(pawn.x, pawn.y);
      if (free) { x = free.x; y = free.y; }
      else { x = pawn.x; y = pawn.y; }
    }

    var list = map.items(x, y);
    for (var i = 0; i < list.length; i++) {
      if (list[i].defId !== thing.defId) continue;
      map.mergeInto(thing, list[i]);
      if (thing.stack <= 0) return list[i];
    }
    map.moveThing(thing, x, y);
    return thing;
  }
  Toils.placeCarried = placeCarried;

  /* ============================================================
     Shared lookups the personal jobs need

     None of these are cheap enough to run every tick, and none of them
     do: they run once, at the start of the toil that needs an answer.
     ============================================================ */

  function buildingsWith(map, flag) {
    var out = [];
    var defs = Defs.buildings();
    for (var i = 0; i < defs.length; i++) {
      var b = defs[i].building;
      if (!b || !b[flag]) continue;
      var list = map.byDef(defs[i].id);
      for (var j = 0; j < list.length; j++) if (list[j].spawned) out.push(list[j]);
    }
    return out;
  }

  var _foodDefs = null;
  function foodDefs() {
    if (_foodDefs) return _foodDefs;
    var N = sys('Needs');
    _foodDefs = Defs.items().filter(function (d) {
      return (N && N.nutritionOf) ? N.nutritionOf(d) > 0 : d.nutrition > 0;
    });
    return _foodDefs;
  }

  function nutritionOf(def) {
    var N = sys('Needs');
    if (N && N.nutritionOf) return N.nutritionOf(def);
    return def && def.nutrition || 0;
  }

  /* How much a pawn would rather eat this than that. Humans hold out
     for a cooked meal until hunger stops being a preference. */
  function foodScore(pawn, def, starving) {
    var id = def.id;
    if (pawn.isAnimal) {
      if (def.foodType === 'meal' && !starving) return 2;
      return id === 'kibble' ? 9 : 7;
    }
    if (id === 'mealFine') return 12;
    if (def.foodType === 'meal') return 10;
    if (id === 'berries') return 5;
    if (id === 'kibble') return starving ? 2 : -1;
    if (def.foodType === 'animal') return starving ? 3 : 1;
    return 4;
  }

  function findFood(map, pawn, opts) {
    opts = opts || {};
    var starving = pawn.needs && pawn.needs.food < 0.12;
    var defs = foodDefs();
    var candidates = [];
    for (var i = 0; i < defs.length; i++) {
      if (foodScore(pawn, defs[i], starving) < 0) continue;
      var list = map.byDef(defs[i].id);
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        if (!t.spawned || t.stack <= 0) continue;
        if (opts.forOther !== true && !Res.canReserve(pawn, T.thing(t), 1)) continue;
        candidates.push(t);
      }
    }
    if (!candidates.length || !Path) return null;
    return Path.closestReachable(map, pawn, candidates, function (t, dist) {
      return foodScore(pawn, t.def, starving) * 4 - dist * 0.3 - t.rotProgress * 3;
    });
  }

  function isBed(thing) {
    return !!(thing && thing.def && thing.def.building && thing.def.building.isBed);
  }

  function bedIsFree(map, bed, pawn) {
    if (!bed || !bed.spawned) return false;
    if (!Res.canReserve(pawn, T.thing(bed), 1)) return false;
    /* Somebody else's assigned bed is theirs even while they are up. */
    if (bed.ownerId && pawn && bed.ownerId !== pawn.id) return false;
    var occupants = map.pawnsAt(bed.x, bed.y);
    for (var i = 0; i < occupants.length; i++) {
      if (occupants[i] !== pawn && !occupants[i].dead) return false;
    }
    return true;
  }

  function findBed(map, pawn, opts) {
    opts = opts || {};
    if (pawn.ownedBedId) {
      var own = map.thing(pawn.ownedBedId);
      if (isBed(own) && bedIsFree(map, own, pawn) &&
          Path && Path.reachable(map, pawn.x, pawn.y, own.x, own.y, { pawn: pawn })) {
        return own;
      }
    }
    var beds = buildingsWith(map, 'isBed').filter(function (b) {
      if (!bedIsFree(map, b, pawn)) return false;
      if (opts.realBedOnly && b.def.id === 'sleepingSpot') return false;
      if (b.faction && pawn.faction && b.faction !== pawn.faction) return false;
      return true;
    });
    if (!beds.length || !Path) return null;
    return Path.closestReachable(map, pawn, beds, function (b, dist) {
      var score = -dist;
      if (b.id === pawn.ownedBedId) score += 40;
      if (b.def.id !== 'sleepingSpot') score += 12;
      return score;
    });
  }

  /* A cell beside a table that a pawn can actually stand on, preferring
     one with a chair in it. Eating at a table is worth a mood point, so
     it is worth a short walk but not a long one. */
  function findTableSeat(map, pawn, radius) {
    var tables = buildingsWith(map, 'isTable');
    if (!tables.length) return null;
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      if (U.cheb(pawn.x, pawn.y, t.x, t.y) > radius) continue;
      var f = t.footprint();
      for (var dy = -1; dy <= f.h; dy++) {
        for (var dx = -1; dx <= f.w; dx++) {
          if (dx >= 0 && dx < f.w && dy >= 0 && dy < f.h) continue;
          var x = t.x + dx, y = t.y + dy;
          if (!map.inBounds(x, y) || !map.passable(x, y)) continue;
          if (map.pawnsAt(x, y).length && !(x === pawn.x && y === pawn.y)) continue;
          var chair = map.buildingAt(x, y);
          var score = -U.dist(pawn.x, pawn.y, x, y);
          if (chair && chair.def.building && chair.def.building.isChair) score += 8;
          else if (chair) continue;   /* a wall or a stove is not a seat */
          if (score > bestScore) { bestScore = score; best = { x: x, y: y }; }
        }
      }
    }
    if (!best || !Path) return best;
    return Path.reachable(map, pawn.x, pawn.y, best.x, best.y, { pawn: pawn }) ? best : null;
  }

  function randomNearbyCell(pawn, radius) {
    var map = pawn.map;
    for (var i = 0; i < 14; i++) {
      var x = pawn.x + U.randInt(-radius, radius);
      var y = pawn.y + U.randInt(-radius, radius);
      if (x === pawn.x && y === pawn.y) continue;
      if (!map.inBounds(x, y) || !map.passable(x, y)) continue;
      var R = sys('Regions');
      if (R && R.sameArea && !R.sameArea(map, pawn.x, pawn.y, x, y)) continue;
      return { x: x, y: y };
    }
    return null;
  }

  function cellHasRoomFor(map, x, y, thing) {
    if (!map.inBounds(x, y) || !map.passable(x, y)) return false;
    var list = map.items(x, y);
    if (!list.length) return true;
    var limit = thing.def.stackLimit || 1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].defId === thing.defId && list[i].stack < limit) return true;
    }
    return false;
  }

  function storageStillGood(map, pos, thing, pawn) {
    var Z = sys('Zones');
    if (Z && Z.isStorageFor && !Z.isStorageFor(map, pos.x, pos.y, thing)) return false;
    return cellHasRoomFor(map, pos.x, pos.y, thing);
  }

  /* ============================================================
     Personal jobs
     ============================================================ */

  /* --- goto / wait --- */

  Jobs.register('goto', {
    label: 'go',
    reportString: 'Going somewhere.',
    suspendable: false,
    alwaysShow: true,
    allowGoneTarget: true,
    toils: function (job) {
      var mode = job.state.pe === undefined ? PE.ON_CELL : job.state.pe;
      return [Toils.goto('A', { pe: mode, failIfGone: false })];
    }
  });

  Jobs.register('wait', {
    label: 'wait',
    reportString: 'Standing.',
    allowGoneTarget: true,
    toils: function (job) {
      return [Toils.wait(job.count > 0 ? job.count : 60)];
    }
  });

  /* Drafted and holding a position: stand your ground and shoot at
     anything that comes into range, without chasing it. */
  Jobs.register('waitCombat', {
    label: 'wait',
    reportString: 'Standing guard.',
    suspendable: false,
    alwaysShow: true,
    allowGoneTarget: true,
    toils: function (job) {
      return [Toils.custom({
        name: 'guard',
        init: function (pawn, job2, s) {
          s.left = job2.count > 0 ? job2.count : 250;
          stopMoving(pawn);
        },
        tick: function (pawn, job2, s) {
          var C = sys('Combat');
          if (C) {
            var stance = C.stanceOf ? C.stanceOf(pawn) : null;
            var foe = stance ? pawn.aimTarget : null;
            if (!foe && C.findTarget) foe = C.findTarget(pawn, { maxRange: 0 });
            if (foe) {
              faceToward(pawn, foe.x, foe.y);
              if (C.tryAttack) C.tryAttack(pawn, foe);
              /* Holding a firing line is not a countdown; the order
                 stands while there is anything to shoot at. */
              s.left = Math.max(s.left, 60);
              return 'stay';
            }
          }
          return (--s.left <= 0) ? 'done' : 'stay';
        },
        end: function (pawn) {
          var C = sys('Combat');
          if (C && C.clearStance) C.clearStance(pawn);
        }
      })];
    }
  });

  /* --- eat --- */

  function carryingFood(pawn) {
    return !!(pawn.carried && nutritionOf(pawn.carried.def) > 0 && pawn.carried.stack > 0);
  }

  function findFoodToil() {
    return Toils.custom({
      name: 'findFood',
      tick: function (pawn, job) {
        var map = pawn.map;
        if (job.targetA && T.valid(job.targetA, map)) {
          return Res.reserve(pawn, job.targetA, 1) ? 'next' : 'fail';
        }
        var food = findFood(map, pawn);
        if (!food) return 'fail';
        job.targetA = T.thing(food);
        Res.reserve(pawn, job.targetA, 1);
        return 'next';
      }
    });
  }

  /* Walk to a table if there is one within a short stroll. Never fails:
     eating standing up is a grievance, not an impossibility. */
  function seatToil(radius) {
    return Toils.custom({
      name: 'findSeat',
      init: function (pawn, job, s) {
        s.spot = pawn.isAnimal ? null : findTableSeat(pawn.map, pawn, radius || 14);
        s.ticks = 0;
      },
      tick: function (pawn, job, s) {
        if (!s.spot) return 'next';
        if (pawn.x === s.spot.x && pawn.y === s.spot.y) { stopMoving(pawn); return 'next'; }
        if (++s.ticks > 900) return 'next';
        if (!isMoving(pawn) && !walkTo(pawn, s.spot.x, s.spot.y, PE.ON_CELL)) return 'next';
        return 'stay';
      }
    });
  }

  function chewToil() {
    return Toils.custom({
      name: 'chew',
      init: function (pawn, job, s) {
        var eat = capacity(pawn, 'eating');
        s.left = Math.round(EAT_TICKS / Math.max(0.2, eat));
        stopMoving(pawn);
      },
      tick: function (pawn, job, s) {
        if (!carryingFood(pawn)) return 'fail';
        if (--s.left > 0) return 'stay';
        var N = sys('Needs');
        if (!N || !N.eat) return 'fail';
        var food = pawn.carried;
        if (!N.eat(pawn, food)) return 'fail';
        /* Needs.eat clears pawn.carried when the stack runs out; a
           half-eaten stack goes back on the floor. */
        if (pawn.carried && pawn.carried.stack <= 0) pawn.carried = null;
        return 'done';
      }
    });
  }

  Jobs.register('eat', {
    label: 'eat',
    reportString: 'Eating {A}.',
    joyKind: null,
    toils: function (job, pawn) {
      if (carryingFood(pawn)) {
        job.targetA = T.thing(pawn.carried);
        return [seatToil(10), chewToil()];
      }
      return [
        findFoodToil(),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.pickUp('A', function (p, j) {
          var food = T.resolve(j.targetA, p.map);
          if (!food) return 0;
          var per = nutritionOf(food.def);
          if (!(per > 0)) return 0;
          var missing = 1 - (p.needs ? p.needs.food : 0.5);
          var units = Math.max(1, Math.ceil(missing / per));
          return Math.min(units, food.stack || 1);
        }),
        seatToil(14),
        chewToil()
      ];
    }
  });

  /* --- sleep and lying down --- */

  function restToil(opts) {
    opts = opts || {};
    return Toils.custom({
      name: opts.name || 'rest',
      init: function (pawn, job, s) {
        stopMoving(pawn);
        s.ticks = 0;
        pawn.asleep = opts.awake !== true;
        job.state.asleep = pawn.asleep;
      },
      tick: function (pawn, job, s) {
        s.ticks++;
        var n = pawn.needs;
        pawn.asleep = opts.awake !== true;

        /* A downed pawn is not choosing to lie here and cannot get up. */
        if (pawn.downed) return 'stay';
        if (opts.maxTicks && s.ticks > opts.maxTicks) return 'done';
        if (n && n.rest >= 0.999) return 'done';
        /* Hunger wakes a colonist before starvation does. */
        if (n && n.food <= 0.04) return 'done';
        if (pawn.mentalState) return 'done';
        /* Woken by a fight in the room: anything hostile standing next
           to the bed means being asleep is the worse option. */
        if ((s.ticks & 31) === 0 && hostileAdjacent(pawn)) return 'done';
        return 'stay';
      },
      end: function (pawn, job) {
        pawn.asleep = false;
        job.state.asleep = false;
      }
    });
  }

  function hostileAdjacent(pawn) {
    var map = pawn.map;
    var G = root.Game, C = sys('Combat');
    for (var i = 0; i < U.ADJ8.length; i++) {
      var list = map.pawnsAt(pawn.x + U.ADJ8[i][0], pawn.y + U.ADJ8[i][1]);
      for (var j = 0; j < list.length; j++) {
        var other = list[j];
        if (other === pawn || other.dead) continue;
        var hostile = C && C.hostile ? C.hostile(pawn, other)
                    : (G && G.hostile ? G.hostile(pawn.faction, other.faction) : false);
        if (hostile) return true;
      }
    }
    return false;
  }

  function pickBedToil(required) {
    return Toils.custom({
      name: 'pickBed',
      tick: function (pawn, job) {
        var map = pawn.map;
        if (job.targetA && T.valid(job.targetA, map)) {
          var existing = T.resolve(job.targetA, map);
          if (!isBed(existing) || Res.reserve(pawn, job.targetA, 1)) return 'next';
        }
        var bed = findBed(map, pawn, {});
        if (bed) {
          job.targetA = T.thing(bed);
          Res.reserve(pawn, job.targetA, 1);
          return 'next';
        }
        if (required) return 'fail';
        /* No bed anywhere: lie down on the spot. The mood system charges
           for it, which is the whole feedback loop that makes a player
           build beds. */
        job.targetA = T.cell(pawn.x, pawn.y);
        return 'next';
      }
    });
  }

  Jobs.register('sleep', {
    label: 'sleep',
    reportString: 'Sleeping.',
    suspendable: false,
    toils: function () {
      return [
        pickBedToil(false),
        Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false }),
        restToil({ name: 'sleep' })
      ];
    }
  });

  Jobs.register('layDown', {
    label: 'lie down',
    reportString: 'Lying down.',
    suspendable: false,
    toils: function (job) {
      var toils = [];
      if (job.targetA) toils.push(Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false }));
      toils.push(restToil({
        name: 'layDown',
        awake: job.state.asleep === false,
        maxTicks: job.count > 0 ? job.count : 0
      }));
      return toils;
    }
  });

  /* --- recreation --- */

  Jobs.register('joyIdle', {
    label: 'relax',
    reportString: 'Relaxing.',
    joyKind: 'idle',
    toils: function (job) {
      if (!job.joyKind) job.joyKind = 'idle';
      return [
        Toils.custom({
          name: 'findRelaxSpot',
          init: function (pawn, job2, s) {
            s.ticks = 0;
            s.spot = null;
            if (job2.targetA) {
              var p = T.pos(job2.targetA, pawn.map);
              if (p) s.spot = p;
            }
            if (!s.spot) s.spot = findTableSeat(pawn.map, pawn, 12);
            if (!s.spot) s.spot = beautySpot(pawn.map, pawn);
            if (!s.spot) s.spot = randomNearbyCell(pawn, 5);
          },
          tick: function (pawn, job2, s) {
            if (!s.spot) return 'next';
            if (pawn.x === s.spot.x && pawn.y === s.spot.y) { stopMoving(pawn); return 'next'; }
            if (++s.ticks > 600) return 'next';
            if (!isMoving(pawn) && !walkTo(pawn, s.spot.x, s.spot.y, PE.ON_CELL)) return 'next';
            return 'stay';
          }
        }),
        Toils.custom({
          name: 'relax',
          init: function (pawn, job2, s) {
            s.left = job2.count > 0 ? job2.count : 1400;
            stopMoving(pawn);
          },
          tick: function (pawn, job2, s) {
            var N = sys('Needs');
            if (N && N.gainJoy) N.gainJoy(pawn, JOY_RATE, job2.joyKind || 'idle');
            if ((s.left & 63) === 0) pawn.dir = U.randInt(0, 3);
            if (pawn.needs && pawn.needs.joy >= 0.999) return 'done';
            return (--s.left <= 0) ? 'done' : 'stay';
          }
        })
      ];
    }
  });

  /* Somewhere worth looking at: a sculpture is the cheapest thing a
     colony can build that makes standing still pleasant. */
  function beautySpot(map, pawn) {
    var art = map.byDef('sculpture').filter(function (s) { return s.spawned; });
    if (!art.length || !Path) return null;
    var best = Path.closestReachable(map, pawn, art, function (s, dist) { return -dist; });
    if (!best) return null;
    var f = best.footprint();
    for (var i = 0; i < U.ADJ8.length; i++) {
      var x = best.x + (f.w - 1) / 2 + U.ADJ8[i][0] * 2;
      var y = best.y + (f.h - 1) / 2 + U.ADJ8[i][1] * 2;
      x = Math.round(x); y = Math.round(y);
      if (map.inBounds(x, y) && map.passable(x, y) && !map.pawnsAt(x, y).length) return { x: x, y: y };
    }
    return null;
  }

  /* --- wander --- */

  function wanderToil(opts) {
    opts = opts || {};
    return Toils.custom({
      name: opts.name || 'wander',
      init: function (pawn, job, s) {
        s.legs = opts.legs || (job.count > 0 ? job.count : 3);
        s.phase = 'pick';
        s.pause = 0;
        s.walkTicks = 0;
        s.total = 0;
      },
      tick: function (pawn, job, s) {
        s.total++;
        if (opts.requiresMentalState && !pawn.mentalState) return 'done';
        if (opts.maxTicks && s.total > opts.maxTicks) return 'done';

        if (s.phase === 'walk') {
          /* A leg that never ends means the path leads somewhere the
             pawn cannot actually walk; take the pause instead. */
          if (isMoving(pawn) && ++s.walkTicks < 600) return 'stay';
          stopMoving(pawn);
          s.phase = 'pause';
          s.pause = opts.pause ? opts.pause() : U.randInt(40, 140);
          return 'stay';
        }

        if (s.phase === 'pause') {
          if (--s.pause > 0) {
            if ((s.pause & 15) === 0) pawn.dir = U.randInt(0, 3);
            if (opts.onPauseTick) opts.onPauseTick(pawn, job, s);
            return 'stay';
          }
          if (--s.legs <= 0) return 'done';
          s.phase = 'pick';
        }

        var cell = randomNearbyCell(pawn, opts.radius || 6);
        if (cell && walkTo(pawn, cell.x, cell.y, PE.ON_CELL)) {
          s.phase = 'walk';
          s.walkTicks = 0;
          return 'stay';
        }
        /* Boxed in. Stand and look around rather than burning a tick
           per frame on a search that will fail again. */
        s.phase = 'pause';
        s.pause = opts.pause ? opts.pause() : U.randInt(40, 140);
        return 'stay';
      }
    });
  }

  Jobs.register('wander', {
    label: 'wander',
    reportString: 'Wandering.',
    toils: function (job) {
      return [wanderToil({ legs: job.count > 0 ? job.count : 3, radius: 7 })];
    }
  });

  /* --- hauling --- */

  function carryToStorageToil() {
    return Toils.custom({
      name: 'carryToStorage',
      init: function (pawn, job, s) { s.ticks = 0; s.tries = 0; },
      tick: function (pawn, job, s) {
        var map = pawn.map;
        var carried = pawn.carried;
        if (!carried) return 'fail';
        if (++s.ticks > CARRY_TIMEOUT) return 'fail';

        var spot = job.targetB ? T.pos(job.targetB, map) : null;
        if (spot && !storageStillGood(map, spot, carried, pawn)) {
          Res.release(pawn, job.targetB);
          job.targetB = null;
          spot = null;
        }
        if (!spot) {
          /* Somebody filled the pile while we were walking to it. Ask
             for another one; after a few failures the floor will do. */
          if (++s.tries > 6) { placeCarried(pawn, pawn.x, pawn.y); return 'done'; }
          var Z = sys('Zones');
          var best = (Z && Z.bestStorageFor) ? Z.bestStorageFor(map, carried, pawn) : null;
          if (!best) { placeCarried(pawn, pawn.x, pawn.y); return 'done'; }
          job.targetB = T.cell(best.x, best.y);
          Res.reserve(pawn, job.targetB, 1);
          spot = { x: best.x, y: best.y };
          stopMoving(pawn);
        }

        if (pawn.x === spot.x && pawn.y === spot.y) { stopMoving(pawn); return 'next'; }
        if (!isMoving(pawn) && !walkTo(pawn, spot.x, spot.y, PE.ON_CELL)) {
          Res.release(pawn, job.targetB);
          job.targetB = null;
          return 'stay';
        }
        return 'stay';
      }
    });
  }

  Jobs.register('haul', {
    label: 'haul',
    reportString: 'Hauling {A}.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.pickUp('A', function (pawn, job) {
          var thing = T.resolve(job.targetA, pawn.map);
          if (!thing) return 0;
          var limit = thing.def.stackLimit || 1;
          var want = job.count > 0 ? job.count : thing.stack;
          return Math.min(want, thing.stack, limit);
        }),
        carryToStorageToil(),
        Toils.putInStorage('B')
      ];
    }
  });

  Jobs.register('haulToContainer', {
    label: 'haul',
    reportString: 'Hauling {A} to {B}.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.pickUp('A', function (pawn, job) {
          var thing = T.resolve(job.targetA, pawn.map);
          if (!thing) return 0;
          var want = job.count > 0 ? job.count : thing.stack;
          return Math.min(want, thing.stack);
        }),
        Toils.goto('B', { pe: PE.TOUCH, failIfGone: true }),
        Toils.custom({
          name: 'deposit',
          tick: function (pawn, job) {
            var map = pawn.map;
            var container = T.resolve(job.targetB, map);
            var carried = pawn.carried;
            if (!container || !carried) return 'fail';

            if (container.isFrame || container.isBlueprint) {
              var C = sys('Construct');
              if (!C || !C.deliver) return 'fail';
              var took = C.deliver(container, carried.defId, carried.stack);
              if (took <= 0) return 'fail';
              carried.stack -= took;
              if (carried.stack > 0) placeCarried(pawn, pawn.x, pawn.y);
              else pawn.carried = null;
              return 'done';
            }

            /* A bill's ingredients are simply the stacks standing on or
               beside the bench, which is where production.js looks for
               them. Putting them down at the interaction cell is the
               delivery. */
            var spot = (typeof container.interactionCell === 'function' && container.interactionCell()) ||
                       { x: pawn.x, y: pawn.y };
            if (!map.passable(spot.x, spot.y)) spot = { x: pawn.x, y: pawn.y };
            placeCarried(pawn, spot.x, spot.y);
            return 'done';
          }
        })
      ];
    }
  });

  /* --- gear --- */

  Jobs.register('equipWeapon', {
    label: 'equip',
    reportString: 'Equipping {A}.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.custom({
          name: 'equip',
          tick: function (pawn, job) {
            var map = pawn.map;
            var weapon = T.resolve(job.targetA, map);
            if (!weapon || !weapon.def || !weapon.def.weapon) return 'fail';
            if (!weapon.spawned) return 'fail';

            var old = pawn.equipment;
            pawn.equipment = null;
            if (old) { old.spawned = false; map.moveThing(old, pawn.x, pawn.y); }

            /* A weapon never stacks, so the whole thing comes off the
               map and into the pawn's hands. */
            map.despawnThing(weapon);
            weapon.map = map;
            weapon.x = pawn.x; weapon.y = pawn.y;
            weapon.faction = pawn.faction;
            pawn.equipment = weapon;
            return 'done';
          }
        })
      ];
    }
  });

  Jobs.register('wearApparel', {
    label: 'wear',
    reportString: 'Putting on {A}.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'wear',
          amount: WEAR_WORK,
          failIfGone: true,
          onDone: function (pawn, job) {
            var map = pawn.map;
            var item = T.resolve(job.targetA, map);
            if (!item || !item.def.apparel || !item.spawned) return 'fail';
            if (!Array.isArray(pawn.apparel)) pawn.apparel = [];

            /* One thing per body slot: whatever was on those parts comes
               off and lands on the floor. */
            var slots = item.def.apparel.slots || [];
            for (var i = pawn.apparel.length - 1; i >= 0; i--) {
              var worn = pawn.apparel[i];
              var wornSlots = (worn.def.apparel && worn.def.apparel.slots) || [];
              var clash = false;
              for (var a = 0; a < slots.length && !clash; a++) {
                if (wornSlots.indexOf(slots[a]) >= 0) clash = true;
              }
              if (!clash) continue;
              pawn.apparel.splice(i, 1);
              worn.spawned = false;
              map.moveThing(worn, pawn.x, pawn.y);
            }

            map.despawnThing(item);
            item.map = map;
            item.x = pawn.x; item.y = pawn.y;
            pawn.apparel.push(item);
            return 'done';
          }
        })
      ];
    }
  });

  Jobs.register('dropThing', {
    label: 'drop',
    reportString: 'Dropping something.',
    allowGoneTarget: true,
    toils: function () {
      return [Toils.custom({
        name: 'drop',
        tick: function (pawn, job) {
          var map = pawn.map;
          if (pawn.carried) { placeCarried(pawn, pawn.x, pawn.y); return 'done'; }

          var target = job.targetA ? T.resolve(job.targetA, map) : null;
          if (!target || isPawnLike(target)) return 'done';
          if (target === pawn.equipment) {
            pawn.equipment = null;
            target.spawned = false;
            map.moveThing(target, pawn.x, pawn.y);
            return 'done';
          }
          if (Array.isArray(pawn.apparel) && U.remove(pawn.apparel, target)) {
            target.spawned = false;
            map.moveThing(target, pawn.x, pawn.y);
            return 'done';
          }
          if (Array.isArray(pawn.inventory) && U.remove(pawn.inventory, target)) {
            target.spawned = false;
            map.moveThing(target, pawn.x, pawn.y);
            return 'done';
          }
          return 'done';
        }
      })];
    }
  });

  /* --- cleaning --- */

  Jobs.register('clean', {
    label: 'clean',
    reportString: 'Cleaning.',
    toils: function () {
      return [
        Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false }),
        Toils.work({
          name: 'scrub',
          amount: function (pawn, job) {
            var pos = T.pos(job.targetA, pawn.map);
            if (!pos) return CLEAN_WORK;
            var filth = pawn.map.blood[pawn.map.idx(pos.x, pos.y)];
            /* A smear costs less than a pool. */
            return CLEAN_WORK * U.clamp(filth / 120, 0.35, 1.6);
          },
          onTick: function (pawn, job, s) {
            var map = pawn.map;
            var pos = T.pos(job.targetA, map);
            if (!pos) return 'fail';
            var i = map.idx(pos.x, pos.y);
            if (!map.blood[i]) return 'done';
            /* The stain shrinks while it is being scrubbed, so the
               renderer shows the work happening. */
            var frac = U.clamp01(s.done / s.total);
            map.blood[i] = Math.max(0, Math.round(s.startFilth * (1 - frac)));
            return null;
          },
          init: function (pawn, job, s) {
            var map = pawn.map;
            var pos = T.pos(job.targetA, map);
            s.startFilth = pos ? map.blood[map.idx(pos.x, pos.y)] : 0;
          },
          onDone: function (pawn, job) {
            var map = pawn.map;
            var pos = T.pos(job.targetA, map);
            if (pos) map.blood[map.idx(pos.x, pos.y)] = 0;
            return 'done';
          }
        })
      ];
    }
  });

  /* --- burial --- */

  function graveIsFree(grave) {
    return !!grave && grave.spawned && !grave.buried;
  }
  Jobs.graveIsFree = graveIsFree;

  Jobs.register('bury', {
    label: 'bury',
    reportString: 'Burying {A}.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.custom({
          name: 'findGrave',
          tick: function (pawn, job) {
            var map = pawn.map;
            var known = job.targetB ? T.resolve(job.targetB, map) : null;
            if (graveIsFree(known) && Res.reserve(pawn, job.targetB, 1)) return 'next';
            var graves = map.byDef('grave').filter(function (g) {
              return graveIsFree(g) && Res.canReserve(pawn, T.thing(g), 1);
            });
            if (!graves.length || !Path) return 'fail';
            var pick = Path.closestReachable(map, pawn, graves, function (g, dist) { return -dist; });
            if (!pick) return 'fail';
            job.targetB = T.thing(pick);
            Res.reserve(pawn, job.targetB, 1);
            return 'next';
          }
        }),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.pickUp('A', function () { return 1; }),
        Toils.goto('B', { pe: PE.INTERACTION, failIfGone: true }),
        Toils.work({
          name: 'inter',
          which: 'B',
          amount: BURY_WORK,
          skill: 'construction',
          onDone: function (pawn, job) {
            var map = pawn.map;
            var grave = T.resolve(job.targetB, map);
            var corpse = pawn.carried;
            if (!grave || !corpse) return 'fail';
            grave.buried = {
              name: (corpse.corpse && corpse.corpse.name) || 'someone',
              kindId: (corpse.corpse && corpse.corpse.kindId) || null,
              faction: (corpse.corpse && corpse.corpse.faction) || null,
              pawnId: (corpse.corpse && corpse.corpse.pawnId) || null,
              tick: now()
            };
            pawn.carried = null;
            map.despawnThing(corpse);
            msg(nameOf(pawn) + ' buried ' + grave.buried.name + '.', pawn);
            return 'done';
          }
        })
      ];
    }
  });

  /* --- fuel and switches --- */

  function fuelDefOf(thing) {
    var b = thing && thing.def && thing.def.building;
    return (b && b.fuelDefId) || null;
  }

  Jobs.register('refuel', {
    label: 'refuel',
    reportString: 'Refuelling {A}.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.custom({
          name: 'findFuel',
          tick: function (pawn, job) {
            var map = pawn.map;
            var building = T.resolve(job.targetA, map);
            var fuelId = fuelDefOf(building);
            if (!building || !fuelId) return 'fail';
            var cap = building.def.building.fuelCapacity;
            var want = Math.ceil(cap - (building.fuel || 0));
            if (want <= 0) return 'done';
            job.count = want;

            var known = job.targetB ? T.resolve(job.targetB, map) : null;
            if (known && known.defId === fuelId && known.spawned &&
                Res.reserve(pawn, job.targetB, 1)) return 'next';

            var stacks = map.byDef(fuelId).filter(function (t) {
              return t.spawned && t.stack > 0 && Res.canReserve(pawn, T.thing(t), 1);
            });
            if (!stacks.length || !Path) return 'fail';
            var pick = Path.closestReachable(map, pawn, stacks, function (t, dist) {
              return Math.min(t.stack, want) * 2 - dist;
            });
            if (!pick) return 'fail';
            job.targetB = T.thing(pick);
            Res.reserve(pawn, job.targetB, 1);
            return 'next';
          }
        }),
        Toils.goto('B', { pe: PE.TOUCH, failIfGone: true }),
        Toils.pickUp('B', function (pawn, job) {
          var stack = T.resolve(job.targetB, pawn.map);
          if (!stack) return 0;
          return Math.min(job.count > 0 ? job.count : stack.stack, stack.stack);
        }),
        Toils.goto('A', { pe: PE.INTERACTION, failIfGone: true }),
        Toils.custom({
          name: 'pourFuel',
          tick: function (pawn, job) {
            var map = pawn.map;
            var building = T.resolve(job.targetA, map);
            var carried = pawn.carried;
            if (!building || !carried) return 'fail';
            var b = building.def.building;
            if (carried.defId !== b.fuelDefId) return 'fail';
            var room = Math.max(0, b.fuelCapacity - (building.fuel || 0));
            var poured = Math.min(room, carried.stack);
            if (poured <= 0) return 'fail';
            building.fuel = (building.fuel || 0) + poured;
            carried.stack -= poured;
            if (carried.stack > 0) placeCarried(pawn, pawn.x, pawn.y);
            else { pawn.carried = null; map.despawnThing(carried); }
            var P = sys('Power');
            if (P && P.markDirty) P.markDirty(map);
            return 'done';
          }
        })
      ];
    }
  });

  /* A switch is a runtime flag rather than a def: any building that
     draws or makes power can be turned off at it, and power.js reads
     thing.switchOff when it walks a net. */
  Jobs.register('flick', {
    label: 'flick',
    reportString: 'Flicking {A}.',
    toils: function () {
      return [
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'flick',
          amount: FLICK_WORK,
          onDone: function (pawn, job) {
            var map = pawn.map;
            var building = T.resolve(job.targetA, map);
            if (!building) return 'fail';
            building.switchOff = !building.switchOff;
            building.flickWanted = false;
            var P = sys('Power');
            if (P && P.markDirty) P.markDirty(map);
            return 'done';
          }
        })
      ];
    }
  });

  /* --- research --- */

  Jobs.register('research', {
    label: 'research',
    reportString: function (job, pawn) {
      var R = sys('Research');
      var project = (R && R.current) ? R.current() : null;
      return 'Researching' + (project ? ' ' + (project.label || project.id) : '') + '.';
    },
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.goto('A', { pe: PE.INTERACTION, failIfGone: true }),
        Toils.custom({
          name: 'study',
          init: function (pawn, job, s) { s.ticks = 0; stopMoving(pawn); },
          tick: function (pawn, job, s) {
            var R = sys('Research');
            if (!R || !R.current || !R.current()) return 'done';
            var bench = T.resolve(job.targetA, pawn.map);
            if (!bench || !bench.spawned) return 'fail';
            faceToward(pawn, bench.x, bench.y);

            var rate = workRate(pawn, 'intellectual');
            R.addProgress(rate, pawn);
            learn(pawn, 'intellectual', rate * XP_PER_WORK);
            /* Come up for air every few hours so the think tree gets a
               chance to notice hunger, a raid or a finished project. */
            return (++s.ticks > 5000) ? 'done' : 'stay';
          }
        })
      ];
    }
  });

  /* --- medicine --- */

  function bestMedicine(map, pawn) {
    var out = [];
    var ids = ['medicine', 'herbalMedicine'];
    for (var i = 0; i < ids.length; i++) {
      if (!Defs.has('thing', ids[i])) continue;
      var list = map.byDef(ids[i]);
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        if (t.spawned && t.stack > 0 && Res.canReserve(pawn, T.thing(t), 1)) out.push(t);
      }
    }
    if (!out.length || !Path) return null;
    return Path.closestReachable(map, pawn, out, function (t, dist) {
      var potency = t.def.medicinePotency || 0.5;
      return potency * 20 - dist;
    });
  }

  /* Fetch one dose if there is any to fetch. Never fails: a doctor with
     bare hands still stops a bleed, just badly. */
  function fetchMedicineToil() {
    return Toils.custom({
      name: 'fetchMedicine',
      init: function (pawn, job, s) {
        s.ticks = 0;
        s.phase = 'pick';
        if (pawn.carried && pawn.carried.def.isMedicine) s.phase = 'have';
      },
      tick: function (pawn, job, s) {
        var map = pawn.map;
        if (s.phase === 'have') return 'next';
        if (++s.ticks > 2000) return 'next';

        if (s.phase === 'pick') {
          var med = job.targetB ? T.resolve(job.targetB, map) : null;
          if (!med || !med.def.isMedicine || !med.spawned) med = bestMedicine(map, pawn);
          if (!med) return 'next';
          job.targetB = T.thing(med);
          Res.reserve(pawn, job.targetB, 1);
          s.phase = 'walk';
        }

        var stack = T.resolve(job.targetB, map);
        if (!stack || !stack.spawned) { job.targetB = null; s.phase = 'pick'; return 'stay'; }
        if (U.cheb(pawn.x, pawn.y, stack.x, stack.y) <= 1) {
          stopMoving(pawn);
          var part = map.splitStack(stack, 1);
          if (!part) return 'next';
          part.x = pawn.x; part.y = pawn.y;
          part.spawned = false; part.map = map;
          if (pawn.carried) placeCarried(pawn, pawn.x, pawn.y);
          pawn.carried = part;
          return 'next';
        }
        if (!isMoving(pawn) && !walkTo(pawn, stack.x, stack.y, PE.TOUCH)) return 'next';
        return 'stay';
      }
    });
  }

  Jobs.register('tendPatient', {
    label: 'tend',
    reportString: 'Tending {A}.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        fetchMedicineToil(),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'tend',
          /* No skill here on purpose: Health.tend pays the medical xp
             itself, and paying it twice would train a doctor at double
             speed for no reason a player could see. */
          amount: function (pawn) { return TEND_WORK / Math.max(0.3, capacity(pawn, 'manipulation')); },
          rate: function (pawn) { return workRate(pawn, 'medicine'); },
          failIfGone: true,
          onDone: function (pawn, job) {
            var map = pawn.map;
            var patient = T.resolve(job.targetA, map);
            if (!patient) return 'fail';
            var H = sys('Health');
            if (!H || !H.tend) return 'fail';
            var medicine = (pawn.carried && pawn.carried.def.isMedicine) ? pawn.carried : null;
            H.tend(patient, pawn, medicine);
            if (medicine) {
              medicine.stack -= 1;
              if (medicine.stack <= 0) { pawn.carried = null; map.despawnThing(medicine); }
            }
            /* Done either way: a patient whose last wound closed while
               the doctor walked over needed no treatment, and that is
               not a failure worth restarting the job over. */
            return 'done';
          }
        })
      ];
    }
  });

  /* --- carrying people --- */

  function liftPawnToil() {
    return Toils.custom({
      name: 'liftPawn',
      tick: function (pawn, job) {
        var patient = T.resolve(job.targetA, pawn.map);
        if (!patient || !isPawnLike(patient) || patient.dead) return 'fail';
        if (U.cheb(pawn.x, pawn.y, patient.x, patient.y) > 1) return 'fail';
        pawn.carriedPawn = patient;
        patient.carriedBy = pawn.id;
        stopMoving(patient);
        return 'next';
      }
    });
  }

  /* The carried pawn is not taken off the map - health, rendering and
     bleeding all keep running on them - they are simply dragged to the
     carrier's cell every tick. */
  function dragCarriedPawn(pawn) {
    var patient = pawn.carriedPawn;
    if (!patient || patient.dead) return false;
    if (patient.x === pawn.x && patient.y === pawn.y) return true;
    var oldX = patient.x, oldY = patient.y;
    patient.x = pawn.x; patient.y = pawn.y;
    patient.fx = pawn.fx === undefined ? pawn.x : pawn.fx;
    patient.fy = pawn.fy === undefined ? pawn.y : pawn.fy;
    if (pawn.map && pawn.map.notePawnMoved) pawn.map.notePawnMoved(patient, oldX, oldY);
    return true;
  }

  function findBedForToil() {
    return Toils.custom({
      name: 'findPatientBed',
      tick: function (pawn, job) {
        var map = pawn.map;
        var known = job.targetB ? T.resolve(job.targetB, map) : null;
        if (isBed(known) && Res.reserve(pawn, job.targetB, 1)) return 'next';
        var patient = T.resolve(job.targetA, map);
        if (!patient) return 'fail';
        var bed = findBed(map, patient, { realBedOnly: false });
        if (!bed) return 'fail';
        job.targetB = T.thing(bed);
        Res.reserve(pawn, job.targetB, 1);
        return 'next';
      }
    });
  }

  function carryPawnToBedToil() {
    return Toils.custom({
      name: 'carryToBed',
      init: function (pawn, job, s) { s.ticks = 0; },
      tick: function (pawn, job, s) {
        var map = pawn.map;
        var patient = pawn.carriedPawn;
        var bed = T.resolve(job.targetB, map);
        if (!patient || patient.dead) return 'fail';
        if (!bed || !bed.spawned) return 'fail';
        if (++s.ticks > CARRY_TIMEOUT) return 'fail';

        dragCarriedPawn(pawn);
        if (pawn.x === bed.x && pawn.y === bed.y) {
          stopMoving(pawn);
          s.delivered = true;
          return 'next';
        }
        if (!isMoving(pawn) && !walkTo(pawn, bed.x, bed.y, PE.ON_CELL)) return 'fail';
        return 'stay';
      },
      end: function (pawn, job, s) {
        /* Dropped mid-carry - interrupted, downed, killed - leaves the
           patient on the floor where the carrier stopped. Arriving at
           the bed is not a drop: the next toil still needs both of them
           in hand to tuck the patient in. */
        if (s.delivered) return;
        var patient = pawn.carriedPawn;
        if (!patient) return;
        dragCarriedPawn(pawn);
        patient.carriedBy = null;
        pawn.carriedPawn = null;
      }
    });
  }

  function tuckInToil(rescued) {
    return Toils.custom({
      name: 'tuckIn',
      tick: function (pawn, job) {
        var map = pawn.map;
        var patient = pawn.carriedPawn;
        var bed = T.resolve(job.targetB, map);
        if (!patient) return 'fail';
        dragCarriedPawn(pawn);
        patient.carriedBy = null;
        pawn.carriedPawn = null;
        if (bed && !patient.ownedBedId && bed.def.id !== 'sleepingSpot') {
          patient.ownedBedId = bed.id;
        }
        var N = sys('Needs');
        if (rescued && N && N.addThought) N.addThought(patient, 'rescued');
        /* The patient is in bed; what they do there is their own job. */
        var restJob = Jobs.make('layDown', T.thing(bed || null), null, { state: { asleep: true } });
        if (bed && !patient.dead) Jobs.start(patient, restJob);
        if (rescued) msg(nameOf(pawn) + ' rescued ' + nameOf(patient) + '.', pawn, 'good');
        return 'done';
      }
    });
  }

  Jobs.register('rescue', {
    label: 'rescue',
    reportString: 'Rescuing {A}.',
    alwaysShow: true,
    toils: function () {
      return [
        Toils.reserve('A', 1),
        findBedForToil(),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        liftPawnToil(),
        carryPawnToBedToil(),
        tuckInToil(true)
      ];
    }
  });

  Jobs.register('carryToBed', {
    label: 'carry',
    reportString: 'Carrying {A} to bed.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        findBedForToil(),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        liftPawnToil(),
        carryPawnToBedToil(),
        tuckInToil(false)
      ];
    }
  });

  Jobs.register('feedPatient', {
    label: 'feed',
    reportString: 'Feeding {A}.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.custom({
          name: 'findPatientFood',
          tick: function (pawn, job) {
            var map = pawn.map;
            var patient = T.resolve(job.targetA, map);
            if (!patient) return 'fail';
            var known = job.targetB ? T.resolve(job.targetB, map) : null;
            if (known && known.spawned && nutritionOf(known.def) > 0 &&
                Res.reserve(pawn, job.targetB, 1)) return 'next';
            var food = findFood(map, patient.isAnimal ? patient : pawn, { forOther: true });
            if (!food) return 'fail';
            job.targetB = T.thing(food);
            Res.reserve(pawn, job.targetB, 1);
            return 'next';
          }
        }),
        Toils.goto('B', { pe: PE.TOUCH, failIfGone: true }),
        Toils.pickUp('B', function (pawn, job) {
          var food = T.resolve(job.targetB, pawn.map);
          if (!food) return 0;
          var per = nutritionOf(food.def);
          var patient = T.resolve(job.targetA, pawn.map);
          var missing = 1 - (patient && patient.needs ? patient.needs.food : 0.5);
          var units = per > 0 ? Math.max(1, Math.ceil(missing / per)) : 1;
          return Math.min(units, food.stack);
        }),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'feed',
          amount: FEED_WORK,
          failIfGone: true,
          onDone: function (pawn, job) {
            var patient = T.resolve(job.targetA, pawn.map);
            var N = sys('Needs');
            if (!patient || !pawn.carried || !N || !N.eat) return 'fail';
            N.eat(patient, pawn.carried);
            if (pawn.carried && pawn.carried.stack <= 0) pawn.carried = null;
            return 'done';
          }
        })
      ];
    }
  });

  /* ============================================================
     Mental states

     Each of these runs until think.js clears pawn.mentalState, so the
     duration lives with the state def and the behaviour lives here.
     None of them can be interrupted by work, which is the point.
     ============================================================ */

  Jobs.register('mentalWander', {
    label: 'wander',
    reportString: 'Wandering in a daze of misery.',
    suspendable: false,
    alwaysShow: true,
    allowGoneTarget: true,
    toils: function () {
      return [wanderToil({
        name: 'sadWander',
        legs: 9999,
        radius: 9,
        requiresMentalState: true,
        maxTicks: 30000,
        pause: function () { return U.randInt(90, 260); }
      })];
    }
  });

  Jobs.register('mentalDaze', {
    label: 'daze',
    reportString: 'Wandering, dazed.',
    suspendable: false,
    alwaysShow: true,
    allowGoneTarget: true,
    toils: function () {
      return [wanderToil({
        name: 'daze',
        legs: 9999,
        radius: 3,
        requiresMentalState: true,
        maxTicks: 30000,
        pause: function () { return U.randInt(150, 400); },
        onPauseTick: function (pawn, job, s) {
          if ((s.pause % 40) === 0) pawn.dir = U.randInt(0, 3);
        }
      })];
    }
  });

  Jobs.register('mentalTantrum', {
    label: 'tantrum',
    reportString: 'Smashing things in a rage.',
    suspendable: false,
    alwaysShow: true,
    allowGoneTarget: true,
    toils: function () {
      return [Toils.custom({
        name: 'tantrum',
        init: function (pawn, job, s) { s.target = null; s.cool = 0; s.ticks = 0; s.scan = 0; },
        tick: function (pawn, job, s) {
          var map = pawn.map;
          if (!pawn.mentalState) return 'done';
          if (++s.ticks > 30000) return 'done';
          if (s.cool > 0) s.cool--;

          var victim = s.target && map.things.get(s.target);
          if (!victim || !victim.spawned || victim.hp <= 0) {
            /* Sweeping every building on the map is not a per-tick
               question. When there is nothing in reach, ask again in
               half a second and storm about in the meantime. */
            if (s.scan > 0) { s.scan--; victim = null; }
            else victim = nearestSmashable(map, pawn);
            if (!victim) {
              if (s.scan <= 0) s.scan = 30;
              var cell = randomNearbyCell(pawn, 6);
              if (cell && !isMoving(pawn)) walkTo(pawn, cell.x, cell.y, PE.ON_CELL);
              return 'stay';
            }
            s.target = victim.id;
          }

          if (U.cheb(pawn.x, pawn.y, victim.x, victim.y) > 1 &&
              !victim.covers(pawn.x, pawn.y)) {
            if (!isMoving(pawn) && !walkTo(pawn, victim.x, victim.y, PE.TOUCH)) {
              s.target = null;
            }
            return 'stay';
          }

          stopMoving(pawn);
          faceToward(pawn, victim.x, victim.y);
          if (s.cool > 0) return 'stay';
          s.cool = 60;
          var hurt = U.randInt(8, 20);
          if (victim.damage(hurt)) s.target = null;
          learn(pawn, 'melee', 4);
          return 'stay';
        }
      })];
    }
  });

  /* Anything of the colony's that is not load-bearing for the pawn's
     own escape: furniture first, because smashing a chair is funnier
     and less fatal than smashing the only door. */
  function nearestSmashable(map, pawn) {
    var best = null, bestScore = -Infinity;
    var defs = Defs.buildings();
    for (var i = 0; i < defs.length; i++) {
      if (defs[i].building && defs[i].building.isDoor) continue;
      var list = map.byDef(defs[i].id);
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        if (!t.spawned || t.hp <= 0) continue;
        var d = U.dist(pawn.x, pawn.y, t.x, t.y);
        if (d > 14) continue;
        var score = -d + (defs[i].buildCategory === 'furniture' ? 6 : 0);
        if (score > bestScore) { bestScore = score; best = t; }
      }
    }
    return best;
  }

  Jobs.register('mentalBerserk', {
    label: 'berserk',
    reportString: 'Berserk.',
    suspendable: false,
    alwaysShow: true,
    allowGoneTarget: true,
    toils: function () {
      return [Toils.custom({
        name: 'berserk',
        init: function (pawn, job, s) { s.ticks = 0; s.victim = 0; s.tx = -1; s.ty = -1; s.scan = 0; },
        tick: function (pawn, job, s) {
          var map = pawn.map;
          if (!pawn.mentalState) return 'done';
          if (++s.ticks > 30000) return 'done';

          var victim = s.victim ? pawnIndex(map).get(s.victim) : null;
          if (!victim || victim.dead || victim.downed || U.dist(pawn.x, pawn.y, victim.x, victim.y) > 22) {
            if (s.scan > 0) { s.scan--; return 'stay'; }
            victim = nearestVictim(map, pawn);
            if (!victim) { s.scan = 20; return 'stay'; }
            s.victim = victim.id;
            s.tx = -1; s.ty = -1;
          }

          var d = U.dist(pawn.x, pawn.y, victim.x, victim.y);
          if (d > 1.45) {
            /* Repath only when the path ran out or the quarry left the
               cell it was aimed at. Comparing the pawn's own path end
               against the victim's cell would never match - a TOUCH
               path ends beside them - and would rebuild the path every
               tick, which resets the step and freezes the chase. */
            if (!isMoving(pawn) || U.cheb(victim.x, victim.y, s.tx, s.ty) > 1) {
              if (walkTo(pawn, victim.x, victim.y, PE.TOUCH)) { s.tx = victim.x; s.ty = victim.y; }
              else s.victim = 0;
            }
            return 'stay';
          }
          stopMoving(pawn);
          faceToward(pawn, victim.x, victim.y);
          var C = sys('Combat');
          if (C && C.tryAttack) C.tryAttack(pawn, victim);
          return 'stay';
        },
        end: function (pawn) {
          var C = sys('Combat');
          if (C && C.clearStance) C.clearStance(pawn);
        }
      })];
    }
  });

  function nearestVictim(map, pawn) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < map.pawns.length; i++) {
      var other = map.pawns[i];
      if (other === pawn || other.dead || other.downed) continue;
      var d = U.distSq(pawn.x, pawn.y, other.x, other.y);
      if (d > 484) continue;
      if (d < bestD) { bestD = d; best = other; }
    }
    return best;
  }

  Jobs.register('mentalBinge', {
    label: 'binge',
    reportString: 'Binge eating.',
    suspendable: false,
    alwaysShow: true,
    allowGoneTarget: true,
    toils: function () {
      return [Toils.custom({
        name: 'binge',
        init: function (pawn, job, s) { s.ticks = 0; s.chew = 0; s.target = 0; s.scan = 0; },
        tick: function (pawn, job, s) {
          var map = pawn.map;
          if (!pawn.mentalState) return 'done';
          if (++s.ticks > 30000) return 'done';

          var N = sys('Needs');
          if (s.chew > 0) {
            if (--s.chew > 0) return 'stay';
            if (pawn.carried && N && N.eat) {
              N.eat(pawn, pawn.carried);
              if (pawn.carried && pawn.carried.stack <= 0) pawn.carried = null;
              /* Bingeing is not nourishment: the mood hit for stuffing
                 yourself comes from the state, not from the meal. */
            }
            return 'stay';
          }

          var food = s.target ? map.things.get(s.target) : null;
          if (!food || !food.spawned || food.stack <= 0) {
            /* Same reasoning as the tantrum: the food search walks every
               edible stack on the map, so an empty larder is asked
               about on a slow beat rather than sixty times a second. */
            if (s.scan > 0) { s.scan--; return 'stay'; }
            food = findFood(map, pawn, { forOther: true });
            if (!food) { s.scan = 60; return 'stay'; }
            s.target = food.id;
          }

          if (U.cheb(pawn.x, pawn.y, food.x, food.y) > 1) {
            if (!isMoving(pawn) && !walkTo(pawn, food.x, food.y, PE.TOUCH)) s.target = 0;
            return 'stay';
          }
          stopMoving(pawn);
          if (pawn.carried) placeCarried(pawn, pawn.x, pawn.y);
          var bite = map.splitStack(food, Math.min(food.stack, 3));
          if (!bite) { s.target = 0; return 'stay'; }
          bite.x = pawn.x; bite.y = pawn.y;
          bite.spawned = false; bite.map = map;
          pawn.carried = bite;
          s.target = 0;
          s.chew = 90;
          return 'stay';
        }
      })];
    }
  });

  /* ============================================================
     Exports
     ============================================================ */

  Jobs.Job = Job;
  Jobs.T = T;
  Jobs.Res = Res;
  Jobs.Toils = Toils;
  Jobs.workRate = workRate;
  Jobs.learn = learn;
  Jobs.walkTo = walkTo;
  Jobs.stopMoving = stopMoving;
  Jobs.setPath = setPath;
  Jobs.findFood = findFood;
  Jobs.findBed = findBed;
  Jobs.isBed = isBed;
  Jobs.bedIsFree = bedIsFree;
  Jobs.findTableSeat = findTableSeat;

  root.T = T;
  root.Res = Res;
  root.Job = Job;
  root.Jobs = Jobs;
  root.Toils = Toils;
})(this);
