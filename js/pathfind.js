/* ============================================================
   pathfind.js - A*, reachability, and "the closest one I can
   actually get to".

   Three things are worth knowing before reading the rest.

   One: cost is measured in ticks, not tiles. An orthogonal step costs
   13 ticks and a diagonal 18, which is the 4.6 tiles/s from the balance
   table, and map.pathCost carries the extra ticks that mud, sandbags or
   a dropped chunk of stone add on top. A path's accumulated cost is
   therefore the number of ticks the walk will really take, so a caller
   can compare a route against a deadline without a second pass.

   Two: a query allocates nothing but the array it hands back. The
   open/closed/cost/parent grids live as long as the map does and are
   invalidated by bumping a generation counter instead of being cleared,
   so the pathfinder never asks the collector for anything mid-tick.

   Three: the cheapest A* is the one that never runs. Regions labels
   every connected area, so a query across a mountain range is refused
   by comparing two integers, and closestReachable leans on that to
   weigh a hundred haulable stacks without a single search.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;

  /* ---------- the cost model, in ticks ---------- */
  var COST_ORTH = 13;
  var COST_DIAG = 18;
  var DOOR_COST = 20;          /* standing through the swing of a closed door */
  var DOOR_BASH_COST = 120;    /* smashing one open: worth a long detour to avoid */
  var FIRE_COST = 150;         /* opts.avoidFire, roughly "walk two seconds around it" */
  var IMPASSABLE = 65535;
  var DEFAULT_MAX_CELLS = 40000;

  /* Priority is the pair (f, h) packed into one number, so that among
     equal-f nodes the heap pops the one nearest the goal. That is a pure
     tie-break - it never reorders nodes with different f - so the path
     stays optimal while the search stops fanning out across open ground. */
  var TIE = 1048576;

  var PE = { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  /* Orthogonals first: the loop uses k < 4 to pick the step cost and to
     decide whether the corner rule applies. */
  var DX = [0, 1, 0, -1, 1, 1, -1, -1];
  var DY = [-1, 0, 1, 0, -1, 1, 1, -1];

  var AREA_NONE = 0, AREA_SAME = 1, AREA_UNKNOWN = 2;

  var EMPTY = {};

  var stats = {
    calls: 0, nodesExpanded: 0, failures: 0,
    earlyOuts: 0, reachableChecks: 0, closestChecks: 0, worst: 0
  };

  /* ============================================================
     PER-MAP WORKSPACE
     One set of grids per map, reused forever. `gen` stamps which cells
     the current query has touched; anything stamped with an older
     generation is untouched, which is how a 20k-cell grid is "cleared"
     in one increment.
     ============================================================ */
  var workspaces = new WeakMap();

  function workspaceFor(map) {
    var ws = workspaces.get(map);
    if (ws && ws.size === map.size) return ws;
    var n = map.size;
    ws = {
      size: n,
      gen: new Int32Array(n),      /* generation this cell was last seen in   */
      status: new Uint8Array(n),   /* 1 open, 2 closed; valid only if gen hits */
      cost: new Int32Array(n),     /* g, in ticks                              */
      parent: new Int32Array(n),
      goalGen: new Int32Array(n),  /* stamped on every goal cell of this query */
      extraGen: new Int32Array(n), /* stamped on doors and fires               */
      extra: new Int32Array(n),
      back: new Int32Array(n),     /* scratch for walking the parent chain     */
      heap: new U.MinHeap(),
      generation: 0
    };
    workspaces.set(map, ws);
    return ws;
  }

  /* Generation 0 means "never touched", so counting starts at 1. A colony
     that somehow outlives the Int32 range gets one wipe and carries on. */
  function nextGeneration(ws) {
    ws.generation++;
    if (ws.generation > 0x3ffffff0) {
      ws.gen.fill(0); ws.goalGen.fill(0); ws.extraGen.fill(0);
      ws.generation = 1;
    }
    return ws.generation;
  }


  /* ============================================================
     GOALS
     A query can have many goal cells (the eight tiles around a bed, the
     whole apron of a 4x2 workbench). They live in module scope rather
     than in the workspace because only one search runs at a time, and
     the heuristic reads them on every node expansion. Nothing calls back
     into caller code while a search is in flight, so a work giver whose
     scoreFn asks for a path of its own cannot walk over these.
     ============================================================ */
  var goalI = [], goalXs = [], goalYs = [], goalN = 0;
  var boxX0 = 0, boxY0 = 0, boxX1 = 0, boxY1 = 0;

  /* Above this many goals the per-node min over every goal costs more
     than it saves, so the heuristic switches to the bounding box - still
     admissible, since the box contains every goal. */
  var EXACT_GOAL_LIMIT = 16;
  var exactGoals = true;

  var rect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  function addGoal(map, ws, gen, x, y, pc, imp) {
    if (x < 0 || y < 0 || x >= map.w || y >= map.h) return;
    var i = y * map.w + x;
    if (ws.goalGen[i] === gen) return;
    if (pc[i] >= imp) return;
    ws.goalGen[i] = gen;
    goalI[goalN] = i; goalXs[goalN] = x; goalYs[goalN] = y;
    goalN++;
  }

  /* The tiles a thing actually occupies. A 2x1 stove turned east is two
     tiles tall, and a pawn standing at either end of it is touching it.
     map.js owns that rule and two of its cases are not obvious from
     def.size alone: a def that is not rotatable keeps its rot at 0 however
     it was placed, and a blueprint or frame stands on the footprint of the
     building it will become, not on the 1x1 of the blueprint def. So ask
     the Thing whenever it can answer. The arithmetic below is the fallback
     for a plain {def, rot} stand-in, and matches map.footprintOf. */
  function footprintRect(thing, x, y, out) {
    var w = 1, h = 1;
    var f = (thing && typeof thing.footprint === 'function') ? thing.footprint() : null;
    if (f) {
      w = f.w || 1; h = f.h || 1;
    } else {
      var s = thing && thing.def && thing.def.size;
      w = s ? (s.w || 1) : 1; h = s ? (s.h || 1) : 1;
      var rot = thing ? (thing.rot | 0) : 0;
      if (rot === 1 || rot === 3) { var t = w; w = h; h = t; }
    }
    out.x0 = x; out.y0 = y; out.x1 = x + w - 1; out.y1 = y + h - 1;
  }

  /* The tile in front of a workbench. map.js may give Things the method;
     construct.js knows the rotation rule; the def carries the raw offset.
     All three are read lazily because construct.js loads after this file. */
  function interactionCellOf(thing) {
    if (!thing) return null;
    if (typeof thing.interactionCell === 'function') {
      var c = thing.interactionCell();
      if (c) return c;
    }
    var C = root.Construct;
    if (C && C.interactionCell && thing.def) {
      var c2 = C.interactionCell(thing.def, thing.x, thing.y, thing.rot | 0);
      if (c2) return c2;
    }
    var off = thing.def && thing.def.building && thing.def.building.interactionOffset;
    if (!off) return null;
    var dx = off.dx || 0, dy = off.dy || 0, rot = thing.rot | 0;
    if (rot === 1) return { x: thing.x - dy, y: thing.y + dx };
    if (rot === 2) return { x: thing.x - dx, y: thing.y - dy };
    if (rot === 3) return { x: thing.x + dy, y: thing.y - dx };
    return { x: thing.x + dx, y: thing.y + dy };
  }

  function buildGoals(map, ws, gen, gx, gy, mode, thing, pc, imp) {
    goalN = 0;
    /* A multi-tile building's origin is not always the cell the caller named:
       map.buildingAt() hands back the same Thing from any tile it covers. So
       the footprint is measured from the thing itself whenever there is one,
       and only ON_CELL keeps to the literal cell it was given. */
    var ox = (thing && typeof thing.x === 'number') ? thing.x : gx;
    var oy = (thing && typeof thing.y === 'number') ? thing.y : gy;
    footprintRect(thing, ox, oy, rect);

    if (mode === PE.INTERACTION) {
      var spot = interactionCellOf(thing);
      if (spot) {
        addGoal(map, ws, gen, spot.x, spot.y, pc, imp);
        if (goalN) { finishGoals(); return; }
      }
      mode = PE.TOUCH;   /* no spot, or the spot is walled in: settle for touching */
    }

    if (mode === PE.ON_CELL) {
      addGoal(map, ws, gen, gx, gy, pc, imp);
      finishGoals();
      return;
    }

    var x, y;
    if (mode === PE.TOUCH) {
      for (y = rect.y0; y <= rect.y1; y++)
        for (x = rect.x0; x <= rect.x1; x++) addGoal(map, ws, gen, x, y, pc, imp);
    }
    /* The ring around the footprint, skipping its interior. */
    for (y = rect.y0 - 1; y <= rect.y1 + 1; y++) {
      for (x = rect.x0 - 1; x <= rect.x1 + 1; x++) {
        if (x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1) continue;
        addGoal(map, ws, gen, x, y, pc, imp);
      }
    }
    finishGoals();
  }

  function finishGoals() {
    exactGoals = goalN <= EXACT_GOAL_LIMIT;
    if (!goalN) return;
    boxX0 = boxX1 = goalXs[0]; boxY0 = boxY1 = goalYs[0];
    for (var i = 1; i < goalN; i++) {
      if (goalXs[i] < boxX0) boxX0 = goalXs[i];
      if (goalXs[i] > boxX1) boxX1 = goalXs[i];
      if (goalYs[i] < boxY0) boxY0 = goalYs[i];
      if (goalYs[i] > boxY1) boxY1 = goalYs[i];
    }
  }

  /* Octile distance: one orthogonal step's worth of ticks along the longer
     axis, plus the 5 extra ticks a diagonal costs for every step of the
     shorter one that can be folded into it. It never overestimates,
     because map.pathCost and the overlay only ever add ticks on top. */
  var H_FOLD = COST_DIAG - COST_ORTH;

  function heuristic(x, y) {
    var dx, dy, i, v, best;
    if (exactGoals) {
      best = 2147483647;
      for (i = 0; i < goalN; i++) {
        dx = goalXs[i] - x; if (dx < 0) dx = -dx;
        dy = goalYs[i] - y; if (dy < 0) dy = -dy;
        v = dx < dy ? (COST_ORTH * dy + H_FOLD * dx) : (COST_ORTH * dx + H_FOLD * dy);
        if (v < best) best = v;
      }
      return best;
    }
    /* Distance to the goals' bounding box: the box holds every goal, so
       this is still admissible, and it costs one comparison per axis
       instead of a loop over thirty goal cells. */
    dx = x < boxX0 ? boxX0 - x : (x > boxX1 ? x - boxX1 : 0);
    dy = y < boxY0 ? boxY0 - y : (y > boxY1 ? y - boxY1 : 0);
    return dx < dy ? (COST_ORTH * dy + H_FOLD * dx) : (COST_ORTH * dx + H_FOLD * dy);
  }

  /* ============================================================
     DOORS AND FIRE
     Neither lives in map.pathCost: a door's cost depends on who is
     walking through it, and fire only matters to a pawn told to avoid
     it. Both are stamped into the overlay grid before the search, which
     is O(number of doors) - a couple of dozen writes - rather than a
     building lookup on every node the search touches.
     ============================================================ */
  function isBuiltinFaction(id) {
    return id === 'player' || id === 'raider' || id === 'wild' || id === 'neutral';
  }

  /* The four built-in ids answer out of a two-line table here, because this
     file has to work in a bare harness and in a game that has not generated
     a world yet, and because "player versus raider" must never depend on a
     module that loads fourteen files later. A pawn carrying any other id is
     a generated civilization, and only factions.js knows whether that
     civilization is currently at war with the colony, so that pair is asked
     there - lazily, since factions.js loads long after this one. */
  function factionsHostile(a, b) {
    if (!a || !b || a === b) return false;
    if (isBuiltinFaction(a) && isBuiltinFaction(b)) {
      return (a === 'player' && b === 'raider') || (a === 'raider' && b === 'player');
    }
    var F = root.Factions;
    return !!(F && typeof F.hostileTo === 'function' && F.hostileTo(a, b));
  }

  /* Anyone at war with the colony comes through its doors by breaking them;
     everyone else who is at war with a door's owner simply will not use it.
     A pawn may carry canBashDoors itself, which is how a manhunter or a
     berserk colonist gets the same licence without a special case here. */
  function defaultBash(pawn) {
    if (!pawn) return false;
    if (pawn.canBashDoors === true) return true;
    if (pawn.faction === 'raider') return true;
    return factionsHostile(pawn.faction, 'player');
  }

  function doorPenalty(door, pawn, canBash) {
    if (pawn && factionsHostile(door.faction, pawn.faction)) {
      return canBash ? DOOR_BASH_COST : IMPASSABLE;
    }
    /* A door's open state is owned by whoever ticks it. Unknown means
       closed, which is the honest cost: the pawn waits out the swing. */
    return (door.open === true || door.holdOpen === true) ? 0 : DOOR_COST;
  }

  function doorsOf(map) {
    return (map.byDef ? map.byDef('door') : null) || null;
  }

  function hasBlockingDoor(map, pawn, canBash) {
    if (canBash || !pawn || !pawn.faction) return false;
    var doors = doorsOf(map);
    if (!doors) return false;
    for (var i = 0; i < doors.length; i++) {
      var d = doors[i];
      if (d && d.spawned !== false && factionsHostile(d.faction, pawn.faction)) return true;
    }
    return false;
  }

  function stampOverlay(map, ws, gen, pawn, canBash, avoidFire) {
    var any = false, i, t, cell;
    var doors = doorsOf(map);
    if (doors) {
      for (i = 0; i < doors.length; i++) {
        t = doors[i];
        if (!t || t.spawned === false) continue;
        cell = t.y * map.w + t.x;
        ws.extraGen[cell] = gen;
        ws.extra[cell] = doorPenalty(t, pawn, canBash);
        any = true;
      }
    }
    if (avoidFire) {
      var fires = (map.byDef ? map.byDef('fire') : null) || null;
      if (fires) {
        for (i = 0; i < fires.length; i++) {
          t = fires[i];
          if (!t || t.spawned === false) continue;
          cell = t.y * map.w + t.x;
          ws.extra[cell] = (ws.extraGen[cell] === gen ? ws.extra[cell] : 0) + FIRE_COST;
          ws.extraGen[cell] = gen;
          any = true;
        }
      }
    }
    return any;
  }

  /* ============================================================
     THE SEARCH
     ============================================================ */
  function push(heap, i, g, h) {
    var f = g + h;
    heap.push(i, f * TIE + (h < TIE - 1 ? h : TIE - 1));
  }

  /* Returns the goal cell reached, -1 when the search ran out of map, or
     -2 when it hit maxCells. The start cell is never tested for
     passability: a pawn standing where a wall just went up still walks
     out of it. */
  function runAStar(map, startI, ws, gen, maxCells, hasOverlay) {
    var w = map.w, h = map.h;
    var pc = map.pathCost, imp = map.IMPASSABLE || IMPASSABLE;
    var seen = ws.gen, status = ws.status, gcost = ws.cost, parent = ws.parent;
    var goalGen = ws.goalGen, extraGen = ws.extraGen, extra = ws.extra;
    var heap = ws.heap;
    heap.clear();

    seen[startI] = gen; status[startI] = 1; gcost[startI] = 0; parent[startI] = -1;
    var sx = startI % w, sy = (startI - sx) / w;
    push(heap, startI, 0, heuristic(sx, sy));

    var expanded = 0, result = -1;
    while (!heap.isEmpty()) {
      var cur = heap.pop();
      if (status[cur] === 2) continue;     /* a stale copy of an already-closed node */
      status[cur] = 2;
      expanded++;

      if (goalGen[cur] === gen) { result = cur; break; }
      if (expanded >= maxCells) { result = -2; break; }

      var cx = cur % w, cy = (cur - cx) / w, cg = gcost[cur];

      for (var k = 0; k < 8; k++) {
        var nx = cx + DX[k]; if (nx < 0 || nx >= w) continue;
        var ny = cy + DY[k]; if (ny < 0 || ny >= h) continue;
        var ni = ny * w + nx;
        var c = pc[ni];
        if (c >= imp) continue;

        var step;
        if (k < 4) {
          step = COST_ORTH + c;
        } else {
          /* No cutting the corner of a wall: both tiles the diagonal
             squeezes between have to be open. */
          if (pc[cy * w + nx] >= imp || pc[ny * w + cx] >= imp) continue;
          step = COST_DIAG + c;
        }

        if (hasOverlay && extraGen[ni] === gen) {
          var e = extra[ni];
          if (e >= imp) continue;
          step += e;
        }

        var ng = cg + step;
        if (seen[ni] === gen) {
          if (status[ni] === 2 || gcost[ni] <= ng) continue;
        } else {
          seen[ni] = gen; status[ni] = 1;
        }
        gcost[ni] = ng; parent[ni] = cur;
        push(heap, ni, ng, heuristic(nx, ny));
      }
    }

    stats.nodesExpanded += expanded;
    if (expanded > stats.worst) stats.worst = expanded;
    return result;
  }

  function rebuild(ws, startI, endI) {
    var back = ws.back, parent = ws.parent, limit = ws.size;
    var n = 0, cur = endI;
    while (cur !== startI && cur >= 0 && n < limit) { back[n++] = cur; cur = parent[cur]; }
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = back[n - 1 - i];
    return out;
  }

  /* ============================================================
     AREA REJECTION
     The O(1) half of the pathfinder. Goals in another area are dropped
     outright; if that empties the goal list the caller is asking for
     something on the far side of a mountain and gets null without a
     single node being expanded.
     ============================================================ */
  function areaCheck(map, ws, gen, sx, sy) {
    var R = root.Regions;
    if (typeof R === 'undefined' || !R || !R.areaOf) return AREA_UNKNOWN;
    var a = R.areaOf(map, sx, sy);
    if (!(a > 0)) return AREA_UNKNOWN;   /* start unlabelled, or Regions not built yet */
    var keep = 0, unknown = false;
    for (var i = 0; i < goalN; i++) {
      var ga = R.areaOf(map, goalXs[i], goalYs[i]);
      if (ga === a || !(ga > 0)) {
        if (!(ga > 0)) unknown = true;
        goalI[keep] = goalI[i]; goalXs[keep] = goalXs[i]; goalYs[keep] = goalYs[i];
        keep++;
      } else {
        ws.goalGen[goalI[i]] = 0;
      }
    }
    if (keep !== goalN) { goalN = keep; finishGoals(); }
    if (!keep) return AREA_NONE;
    return unknown ? AREA_UNKNOWN : AREA_SAME;
  }

  /* ============================================================
     PUBLIC API
     ============================================================ */
  var Path = {};
  Path.PE = PE;
  Path.COST_ORTH = COST_ORTH;
  Path.COST_DIAG = COST_DIAG;
  Path.IMPASSABLE = IMPASSABLE;

  function modeOf(opts) {
    var m = opts.peMode !== undefined ? opts.peMode : opts.pe;
    return (m === undefined || m === null) ? PE.ON_CELL : (m | 0);
  }

  /* The one path routine everything else funnels into. Returns an array
     of cell indices that excludes the start cell and ends on whichever
     goal cell turned out cheapest, [] when the pawn is already standing
     on a goal, or null when there is no route. */
  function runQuery(map, sx, sy, gx, gy, mode, thing, pawn, canBash, avoidFire, maxCells) {
    stats.calls++;
    if (!map.inBounds(sx, sy) || !map.inBounds(gx, gy)) { stats.failures++; return null; }

    var pc = map.pathCost, imp = map.IMPASSABLE || IMPASSABLE;
    var ws = workspaceFor(map), gen = nextGeneration(ws);

    buildGoals(map, ws, gen, gx, gy, mode, thing, pc, imp);
    if (!goalN) { stats.failures++; return null; }

    var startI = sy * map.w + sx;
    if (ws.goalGen[startI] === gen) return [];

    if (areaCheck(map, ws, gen, sx, sy) === AREA_NONE) {
      stats.earlyOuts++; stats.failures++; return null;
    }

    var hasOverlay = stampOverlay(map, ws, gen, pawn, canBash, avoidFire);
    var end = runAStar(map, startI, ws, gen, maxCells > 0 ? maxCells : DEFAULT_MAX_CELLS, hasOverlay);
    if (end < 0) { stats.failures++; return null; }
    return rebuild(ws, startI, end);
  }

  Path.find = function (map, sx, sy, dx, dy, opts) {
    opts = opts || EMPTY;
    var mode = modeOf(opts);
    if (sx === dx && sy === dy && mode !== PE.ADJACENT && mode !== PE.INTERACTION) {
      stats.calls++;
      return [];
    }
    /* find() is given a cell, not a thing, so an end mode that needs a
       footprint or a working spot has to look up whatever is standing
       there. A blueprint or frame lives in its own grid, so it takes a
       second question - and a builder walking to a half-built 4x2 turbine
       needs its real footprint, not the one tile the caller named. */
    var thing = opts.thing || null;
    if (!thing && (mode === PE.INTERACTION || mode === PE.TOUCH || mode === PE.ADJACENT)) {
      thing = (map.buildingAt ? map.buildingAt(dx, dy) : null) ||
              (map.ghostAt ? map.ghostAt(dx, dy) : null);
    }
    var pawn = opts.pawn || null;
    var canBash = opts.canBashDoors !== undefined ? !!opts.canBashDoors : defaultBash(pawn);
    return runQuery(map, sx, sy, dx, dy, mode, thing, pawn, canBash,
                    !!opts.avoidFire, opts.maxCells | 0);
  };

  /* Path to a Target: the position is read live through T.pos, so a path
     to a moving pawn aims at where it is now, and the thing behind the
     target supplies its footprint and its interaction spot. */
  Path.findTo = function (map, pawn, target, opts) {
    opts = opts || EMPTY;
    if (!target) { stats.calls++; stats.failures++; return null; }
    var T = root.T;
    var pos = (T && T.pos) ? T.pos(target, map) : null;
    if (!pos && typeof target.x === 'number' && typeof target.y === 'number') pos = target;
    if (!pos) { stats.calls++; stats.failures++; return null; }

    var thing = opts.thing || ((T && T.resolve) ? T.resolve(target, map) : null);
    var mode = modeOf(opts);
    var who = pawn || opts.pawn || null;
    var canBash = opts.canBashDoors !== undefined ? !!opts.canBashDoors : defaultBash(who);
    var sx = who ? who.x : opts.fromX, sy = who ? who.y : opts.fromY;
    if (sx === undefined || sy === undefined) { stats.calls++; stats.failures++; return null; }

    return runQuery(map, sx, sy, pos.x, pos.y, mode, thing, who, canBash,
                    !!opts.avoidFire, opts.maxCells | 0);
  };

  /* Can this pawn get there at all? Almost always answered by two area
     labels. The one case that needs more is a map with doors this pawn
     is not allowed through, where the areas agree but the way does not:
     then, and only then, does a real search run. */
  Path.reachable = function (map, sx, sy, dx, dy, opts) {
    opts = opts || EMPTY;
    stats.reachableChecks++;
    if (!map.inBounds(sx, sy) || !map.inBounds(dx, dy)) return false;
    if (sx === dx && sy === dy) return true;

    var pawn = opts.pawn || null;
    var canBash = opts.canBashDoors !== undefined ? !!opts.canBashDoors : defaultBash(pawn);
    var pc = map.pathCost, imp = map.IMPASSABLE || IMPASSABLE;

    /* Asking whether a wall, a tree or a workbench is reachable means
       asking whether a pawn can stand next to it, so an impassable
       destination falls back to TOUCH unless the caller said otherwise. */
    var mode = (opts.peMode !== undefined) ? (opts.peMode | 0)
             : (opts.pe !== undefined) ? (opts.pe | 0)
             : (pc[dy * map.w + dx] >= imp ? PE.TOUCH : PE.ON_CELL);

    var ws = workspaceFor(map), gen = nextGeneration(ws);
    var thing = opts.thing || null;
    if (!thing && mode !== PE.ON_CELL) {
      thing = (map.buildingAt ? map.buildingAt(dx, dy) : null) ||
              (map.ghostAt ? map.ghostAt(dx, dy) : null);
    }

    buildGoals(map, ws, gen, dx, dy, mode, thing, pc, imp);
    if (!goalN) return false;

    var startI = sy * map.w + sx;
    if (ws.goalGen[startI] === gen) return true;

    var area = areaCheck(map, ws, gen, sx, sy);
    if (area === AREA_NONE) { stats.earlyOuts++; return false; }
    if (area === AREA_SAME && !hasBlockingDoor(map, pawn, canBash)) return true;

    var hasOverlay = stampOverlay(map, ws, gen, pawn, canBash, false);
    var max = opts.maxCells > 0 ? opts.maxCells : DEFAULT_MAX_CELLS;
    return runAStar(map, startI, ws, gen, max, hasOverlay) >= 0;
  };

  /* ============================================================
     CLOSEST REACHABLE
     Every work giver in the game funnels through this, so the cost is
     worth stating: one sort of the candidate list, then reachability
     probes in nearest-first order. A probe is two integer lookups
     unless the map has doors this pawn cannot open, and probing stops
     as soon as the list runs past the distance tolerance of the first
     hit or MAX_PROBES, whichever comes first. A list where nothing is
     reachable is scanned no further than HARD_PROBES, which is the only
     thing standing between a work giver and a thousand probes on a map
     with no region data. No candidate ever gets a full A* of its own.

     scoreFn(candidate, roughDistance) returns a number where HIGHER IS
     BETTER, or null/undefined/NaN to reject the candidate outright.
     Omit it and the nearest reachable candidate wins.
     ============================================================ */
  var TOLERANCE_FACTOR = 1.5;   /* how much further than the first hit is still worth looking */
  var TOLERANCE_FLAT = 6;       /* ...plus this many tiles, so close-quarters ties all count */
  var MAX_PROBES = 48;          /* once something has been found, stop looking for better */
  var HARD_PROBES = 256;        /* and stop looking at all, even if nothing has been found */

  /* One scratch frame per nesting level. scoreFn is caller code, and a work
     giver is entitled to run a closestReachable of its own inside it - "how
     good is this stack" can reasonably mean "how far is the stockpile that
     would take it". Module-wide scratch would let that nested scan hand its
     own winner back to the outer loop, so each level gets its own frame.
     Depth is 0 in every call the game makes today, and frame 0 is reused
     forever, so the ordinary path still allocates nothing. */
  var frames = [];
  var depth = 0;

  function frameAt(d) {
    var f = frames[d];
    if (!f) {
      f = frames[d] = {
        list: [], x: [], y: [], dist: [], order: [],
        opts: { pawn: null, canBashDoors: undefined, maxCells: 0 }
      };
    }
    return f;
  }

  /* sort() is synchronous and this comparator cannot reenter the pathfinder,
     so aiming it at the active frame for the length of one sort is safe. */
  var sortDist = null;
  var posOut = { x: 0, y: 0 };

  /* Candidates come in as Things, Pawns, cell indices, {x,y} or Targets. */
  function posOf(c, map) {
    if (c === null || c === undefined) return null;
    if (typeof c === 'number') {
      if (c < 0 || c >= map.size) return null;
      posOut.x = c % map.w; posOut.y = (c - posOut.x) / map.w;
      return posOut;
    }
    if (c.k !== undefined && root.T && root.T.pos) {
      var p = root.T.pos(c, map);
      if (!p) return null;
      posOut.x = p.x; posOut.y = p.y;
      return posOut;
    }
    if (typeof c.x === 'number' && typeof c.y === 'number') {
      posOut.x = c.x; posOut.y = c.y;
      return posOut;
    }
    return null;
  }

  function orderByDistance(a, b) { return sortDist[a] - sortDist[b]; }

  Path.closestReachable = function (map, pawn, candidates, scoreFn) {
    if (!candidates || !candidates.length) return null;
    stats.closestChecks++;

    var f = frameAt(depth);
    depth++;
    try {
      var cList = f.list, cX = f.x, cY = f.y, cD = f.dist, cOrder = f.order;
      var px = pawn ? pawn.x : 0, py = pawn ? pawn.y : 0;
      var n = 0, i;
      for (i = 0; i < candidates.length; i++) {
        var pos = posOf(candidates[i], map);
        if (!pos) continue;
        var dx = pos.x - px; if (dx < 0) dx = -dx;
        var dy = pos.y - py; if (dy < 0) dy = -dy;
        cList[n] = candidates[i]; cX[n] = pos.x; cY[n] = pos.y;
        /* Rough distance in tiles: octile, cheap, and close enough to order by. */
        cD[n] = dx < dy ? (dy + 0.41 * dx) : (dx + 0.41 * dy);
        cOrder[n] = n;
        n++;
      }
      if (!n) return null;
      cList.length = n; cX.length = n; cY.length = n; cD.length = n; cOrder.length = n;
      sortDist = cD;
      cOrder.sort(orderByDistance);

      var reachOpts = f.opts;
      reachOpts.pawn = pawn;
      reachOpts.canBashDoors = undefined;

      var best = null, bestScore = -Infinity, limit = Infinity, probes = 0;
      for (i = 0; i < n; i++) {
        var j = cOrder[i];
        if (cD[j] > limit) break;
        /* `best !== null`, not `best`: cell index 0 is a legitimate
           candidate and must not reopen the wide probe budget. */
        if (probes >= (best !== null ? MAX_PROBES : HARD_PROBES)) break;
        probes++;
        if (!Path.reachable(map, px, py, cX[j], cY[j], reachOpts)) continue;

        var s = scoreFn ? scoreFn(cList[j], cD[j]) : -cD[j];
        if (s === null || s === undefined || s === false || s !== s) continue;
        if (best === null) limit = cD[j] * TOLERANCE_FACTOR + TOLERANCE_FLAT;
        if (best === null || s > bestScore) { best = cList[j]; bestScore = s; }
      }
      return best;
    } finally {
      depth--;
    }
  };

  /* ============================================================
     SINGLE STEPS
     pawn.js walks a path one cell at a time and asks how long each step
     takes; the answer has to match what the search charged for it, or
     the pawn's arrival time drifts from the plan. The one deliberate
     difference is opts.avoidFire: its surcharge steers the route away
     from a burning tile but is not a real delay, so a pawn who walks
     through fire anyway pays only the ordinary cost of the tile.
     ============================================================ */
  Path.stepCost = function (map, fromI, toI, pawn) {
    var w = map.w, imp = map.IMPASSABLE || IMPASSABLE;
    if (fromI < 0 || toI < 0 || fromI >= map.size || toI >= map.size) return IMPASSABLE;
    var fx = fromI % w, fy = (fromI - fx) / w;
    var tx = toI % w, ty = (toI - tx) / w;
    var dx = tx - fx; if (dx < 0) dx = -dx;
    var dy = ty - fy; if (dy < 0) dy = -dy;
    if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) return IMPASSABLE;

    var pc = map.pathCost;
    var c = pc[toI];
    if (c >= imp) return IMPASSABLE;

    var cost;
    if (dx && dy) {
      if (pc[fy * w + tx] >= imp || pc[ty * w + fx] >= imp) return IMPASSABLE;
      cost = COST_DIAG + c;
    } else {
      cost = COST_ORTH + c;
    }

    var b = map.buildingAt ? map.buildingAt(tx, ty) : null;
    if (b && b.def && b.def.building && b.def.building.isDoor) {
      var extra = doorPenalty(b, pawn || null, defaultBash(pawn));
      if (extra >= imp) return IMPASSABLE;
      cost += extra;
    }
    return cost;
  };

  /* What a finished path will cost in ticks, start cell excluded. Handy
     for comparing two routes, and for a job driver that wants to know
     whether the walk is worth the work at the end of it. */
  Path.pathCostOf = function (map, path, pawn, fromI) {
    if (!path || !path.length) return 0;
    var total = 0, prev = (fromI === undefined || fromI === null) ? path[0] : fromI;
    var start = (fromI === undefined || fromI === null) ? 1 : 0;
    for (var i = start; i < path.length; i++) {
      var c = Path.stepCost(map, prev, path[i], pawn);
      if (c >= IMPASSABLE) return IMPASSABLE;
      total += c;
      prev = path[i];
    }
    return total;
  };

  /* ============================================================
     BOOKKEEPING
     ============================================================ */
  Path.debugStats = function () {
    return {
      calls: stats.calls,
      nodesExpanded: stats.nodesExpanded,
      failures: stats.failures,
      earlyOuts: stats.earlyOuts,
      reachableChecks: stats.reachableChecks,
      closestChecks: stats.closestChecks,
      worst: stats.worst
    };
  };

  Path.resetStats = function () {
    stats.calls = 0; stats.nodesExpanded = 0; stats.failures = 0;
    stats.earlyOuts = 0; stats.reachableChecks = 0; stats.closestChecks = 0; stats.worst = 0;
  };

  /* Drop a map's grids. Only save/load needs this - a map that is simply
     forgotten takes its workspace with it, because the cache is weak. */
  Path.forget = function (map) {
    if (map) workspaces.delete(map);
    else workspaces = new WeakMap();
  };

  root.Path = Path;
})(this);
