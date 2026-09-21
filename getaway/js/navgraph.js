/* ============================================================
   navgraph.js - walkable graph over a map, built once per round

   Nodes are points sampled along every standable surface. Edges use
   the same jump envelope the levels were validated against, measured
   from the real physics rather than guessed, so a bot only commits to
   a leap the engine can actually make.
   ============================================================ */
(function (root) {
  'use strict';

  /* gap -> highest rise still held at that distance (measured) */
  /* Measured from the running engine by sweeping input sequences a player
     can actually perform. Unwinding the lean to gain height also bleeds
     speed, so these two trade off much harder than they look. */
  var FRONTIER = [[0,126],[10,126],[20,126],[30,121],[40,121],[50,119],[60,115],[70,109],[80,108],[90,103],[100,100],[110,95],[120,92],[130,88],[140,85],[150,81],[160,78],[170,75],[180,71],[190,68],[200,66],[210,63],[220,60],[230,56],[240,52],[250,48],[260,43],[270,36],[280,30],[290,23],[300,14],[310,5],[320,0]];
  /* Permissive on purpose: the graph only proposes routes, and the bot's
     rollout planner is what decides whether a given leap is survivable.
     Clipping the graph tighter than the level design budget just leaves
     bots with no route at all. */
  var MARGIN = 0.95;          /* bots are held to a slightly tighter budget than the level design */
  var MAX_GAP = 312;
  var STEP = 68;              /* node spacing along a surface */

  function maxRise(g) {
    if (g > MAX_GAP) return -1e9;
    for (var i = 1; i < FRONTIER.length; i++) {
      if (g <= FRONTIER[i][0]) {
        var a = FRONTIER[i - 1], b = FRONTIER[i];
        return (a[1] + (b[1] - a[1]) * (g - a[0]) / (b[0] - a[0])) * MARGIN;
      }
    }
    return -1e9;
  }

  function NavGraph(world) {
    this.world = world;
    this.nodes = [];
    this.build(world);
  }

  NavGraph.prototype.addSurface = function (x1, x2, y, tag, ref, risky) {
    var first = this.nodes.length;
    var span = x2 - x1;
    var n = Math.max(1, Math.round(span / STEP));
    for (var i = 0; i <= n; i++) {
      var x = x1 + (span * i) / n;
      this.nodes.push({
        x: x, y: y, sx1: x1, sx2: x2, tag: tag, ref: ref || null,
        risky: risky || 0, edges: [], id: this.nodes.length
      });
    }
    /* risk is per node: one end of a ledge can be safe while the other is not */
    for (var r = first; r < this.nodes.length; r++) {
      var nd = this.nodes[r];
      nd.risky = (typeof this._riskAt === 'function') ? this._riskAt(nd.x, nd.y) : (risky || 0);
      if (risky) nd.risky = Math.max(nd.risky, risky);
    }

    /* walking along the surface */
    for (var k = first; k < this.nodes.length - 1; k++) {
      var a = this.nodes[k], b = this.nodes[k + 1];
      var cost = Math.abs(b.x - a.x) / 300;
      a.edges.push({ to: b.id, cost: cost, kind: 'walk' });
      b.edges.push({ to: a.id, cost: cost, kind: 'walk' });
    }
    return first;
  };

  NavGraph.prototype.build = function (world) {
    var L = world.level, i, j;
    this.nodes.length = 0;

    var hazBoxes = (world.hazards || []).map(function (h) {
      var a = { x: Math.min(h.ax, h.bx), y: Math.min(h.ay, h.by) };
      return { x: a.x - 10, y: a.y - 10,
               w: Math.abs(h.bx - h.ax) + h.w + 20, h: Math.abs(h.by - h.ay) + h.h + 20 };
    });
    this._riskAt = function (x, y) {
      for (var k = 0; k < hazBoxes.length; k++) {
        if (U.pointInRect(x, y - 22, hazBoxes[k])) return 1;
      }
      return 0;
    };

    /* standable tops */
    for (i = 0; i < world.platforms.length; i++) {
      var pf = world.platforms[i];
      if (pf.w < 26 || pf.h < 6) continue;
      this.addSurface(pf.x + 6, pf.x + pf.w - 6, pf.y, 'plat', pf, 0);
    }
    for (i = 0; i < world.glass.length; i++) {
      var gl = world.glass[i];
      /* A tall thin pane is a wall to go through, not a ledge to stand on. */
      if (gl.h > gl.w) continue;
      /* glass counts, but a bot would rather not trust it */
      this.addSurface(gl.x + 4, gl.x + gl.w - 4, gl.y, 'glass', gl, 0.18);
    }
    for (i = 0; i < world.doors.length; i++) {
      var dr = world.doors[i];
      this.addSurface(dr.ox + 4, dr.ox + dr.w - 4, dr.oy, 'door', dr, 0);
    }

    /* elevators contribute a node cluster at each end, linked by the ride */
    this.lifts = [];
    for (i = 0; i < world.elevators.length; i++) {
      var e = world.elevators[i];
      if (e.crusher) continue;                       /* never path onto a piston */
      var aFirst = this.nodes.length;
      this.addSurface(e.ax + 4, e.ax + e.w - 4, e.ay, 'lift', e, 0);
      var aLast = this.nodes.length - 1;
      var bFirst = this.nodes.length;
      this.addSurface(e.bx + 4, e.bx + e.w - 4, e.by, 'lift', e, 0);
      var bLast = this.nodes.length - 1;
      for (var q = aFirst; q <= aLast; q++) this.nodes[q].liftEnd = { x: e.ax, y: e.ay };
      for (q = bFirst; q <= bLast; q++) this.nodes[q].liftEnd = { x: e.bx, y: e.by };
      var ride = U.dist(e.ax, e.ay, e.bx, e.by) / Math.max(20, e.speed) + (e.mode === 'call' ? 1.2 : 1.6);
      for (j = aFirst; j <= aLast; j++) {
        for (var k2 = bFirst; k2 <= bLast; k2++) {
          this.nodes[j].edges.push({ to: k2, cost: ride, kind: 'ride', lift: e });
          this.nodes[k2].edges.push({ to: j, cost: ride, kind: 'ride', lift: e });
        }
      }
      this.lifts.push(e);
    }

    /* jumps and drops between surfaces */
    var N = this.nodes.length;
    for (i = 0; i < N; i++) {
      var a = this.nodes[i];
      for (j = 0; j < N; j++) {
        if (i === j) continue;
        var b = this.nodes[j];
        if (a.ref && b.ref && a.ref === b.ref) continue;    /* same surface, walk covers it */

        var gap = Math.abs(b.x - a.x);
        var rise = a.y - b.y;
        var kind = null, cost = 0;

        if (rise >= -4) {
          if (gap > MAX_GAP || rise > maxRise(gap)) continue;
          kind = 'jump';
          /* Prefer the comfortable route: a jump near the top of the
             envelope costs far more than one with room to spare. */
          var ceiling = Math.max(1, maxRise(gap) / MARGIN);
          var tight = U.clamp(rise / ceiling, 0, 1);
          cost = 0.45 + gap / 260 + rise / 200 + tight * tight * 2.4;
        } else {
          var drop = -rise;
          if (gap > Math.min(430, 250 + drop * 0.28)) continue;
          if (drop > 900) continue;                          /* that is not a drop, that is a fall */
          kind = 'drop';
          cost = 0.3 + gap / 320 + drop / 1600;
        }
        cost += b.risky * 3.2;
        a.edges.push({ to: j, cost: cost, kind: kind });
      }
    }
    void L;
  };

  NavGraph.prototype.nearest = function (x, y, preferBelow) {
    var best = null, bd = 1e18;
    for (var i = 0; i < this.nodes.length; i++) {
      var n = this.nodes[i];
      var dy = n.y - y;
      /* prefer a surface at or just under the point */
      var pen = preferBelow && dy < -40 ? 400 : 0;
      var d = (n.x - x) * (n.x - x) + dy * dy * 1.6 + pen * pen;
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  };

  /* A* - returns a list of nodes, or null */
  NavGraph.prototype.path = function (from, to) {
    if (!from || !to) return null;
    if (from === to) return [to];
    var N = this.nodes.length;
    var g = new Float64Array(N), f = new Float64Array(N);
    var prev = new Int32Array(N), seen = new Uint8Array(N), open = new Uint8Array(N);
    var i;
    for (i = 0; i < N; i++) { g[i] = Infinity; f[i] = Infinity; prev[i] = -1; }

    var self = this;
    function h(n) { return U.dist(self.nodes[n].x, self.nodes[n].y, to.x, to.y) / 330; }

    g[from.id] = 0; f[from.id] = h(from.id);
    var queue = [from.id];
    open[from.id] = 1;

    var guard = 0;
    while (queue.length && guard++ < 20000) {
      /* small graphs, a linear scan beats a heap's bookkeeping */
      var bi = 0;
      for (i = 1; i < queue.length; i++) if (f[queue[i]] < f[queue[bi]]) bi = i;
      var cur = queue[bi];
      queue.splice(bi, 1);
      open[cur] = 0;
      if (cur === to.id) break;
      seen[cur] = 1;

      var edges = this.nodes[cur].edges;
      for (i = 0; i < edges.length; i++) {
        var e = edges[i];
        if (seen[e.to]) continue;
        var ng = g[cur] + e.cost;
        if (ng >= g[e.to]) continue;
        prev[e.to] = cur;
        g[e.to] = ng;
        f[e.to] = ng + h(e.to);
        if (!open[e.to]) { queue.push(e.to); open[e.to] = 1; }
      }
    }

    if (prev[to.id] < 0 && to.id !== from.id) return null;
    var out = [], at = to.id;
    while (at >= 0) { out.push(this.nodes[at]); at = prev[at]; }
    out.reverse();
    return out;
  };

  /* what kind of move gets you from a to b, so the bot knows to jump */
  NavGraph.prototype.edgeKind = function (a, b) {
    for (var i = 0; i < a.edges.length; i++) {
      if (a.edges[i].to === b.id) return a.edges[i];
    }
    return null;
  };

  root.NavGraph = NavGraph;
})(typeof window !== 'undefined' ? window : globalThis);
