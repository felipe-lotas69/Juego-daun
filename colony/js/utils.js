/* ============================================================
   utils.js - maths, seeded randomness, grid helpers, heap.
   No DOM. No Math.random. No Date. Everything here has to be
   replayable, because the whole simulation is.
   ============================================================ */
(function (root) {
  'use strict';

  var U = {};

  /* ---------- seeded random (mulberry32) ----------
     One stream for the whole simulation. Save/load carries the state,
     so a reloaded colony rolls the same dice the live one would have. */
  var _state = 0x2f6e2b1 >>> 0;

  U.seed = function (n) {
    _state = (n >>> 0) || 1;
    /* Shuffle a few times so adjacent seeds don't start alike. */
    for (var i = 0; i < 8; i++) U.rand();
    return _state;
  };
  U.getSeed = function () { return _state; };
  U.setSeed = function (s) { _state = s >>> 0; };

  U.rand = function () {
    _state = (_state + 0x6D2B79F5) >>> 0;
    var t = _state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /* A second, independent stream for things that must NOT disturb the
     simulation stream - cosmetic wobble, sprite variation, UI flourishes. */
  var _cosmetic = 0x9e3779b9 >>> 0;
  U.randCosmetic = function () {
    _cosmetic = (_cosmetic + 0x6D2B79F5) >>> 0;
    var t = _cosmetic;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  /* Deterministic hash of a string - stable sprite/name variation. */
  U.hash = function (str) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  };

  U.randInt = function (lo, hi) {            /* inclusive both ends */
    return lo + Math.floor(U.rand() * (hi - lo + 1));
  };
  U.randRange = function (lo, hi) { return lo + U.rand() * (hi - lo); };
  U.chance = function (p) { return U.rand() < p; };
  U.pick = function (arr) { return arr[Math.floor(U.rand() * arr.length)]; };

  U.pickWeighted = function (arr, weightFn) {
    var total = 0, i, w, weights = [];
    for (i = 0; i < arr.length; i++) {
      w = Math.max(0, weightFn(arr[i], i));
      weights.push(w); total += w;
    }
    if (total <= 0) return arr.length ? arr[0] : null;
    var r = U.rand() * total;
    for (i = 0; i < arr.length; i++) { r -= weights[i]; if (r <= 0) return arr[i]; }
    return arr[arr.length - 1];
  };

  U.shuffle = function (arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(U.rand() * (i + 1));
      var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  };

  /* Box-Muller, clamped - used for ages, skill spreads, damage rolls. */
  U.gauss = function (mean, sd, lo, hi) {
    var u = 1 - U.rand(), v = U.rand();
    var n = Math.sqrt(-2 * Math.log(u)) * Math.cos(6.283185307179586 * v);
    var out = mean + n * sd;
    if (lo !== undefined) out = Math.max(lo, out);
    if (hi !== undefined) out = Math.min(hi, out);
    return out;
  };

  /* ---------- maths ---------- */
  U.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
  U.clamp01 = function (v) { return v < 0 ? 0 : (v > 1 ? 1 : v); };
  U.lerp = function (a, b, t) { return a + (b - a) * t; };
  U.invLerp = function (a, b, v) { return b === a ? 0 : (v - a) / (b - a); };
  U.sign = function (v) { return v > 0 ? 1 : (v < 0 ? -1 : 0); };
  U.approach = function (v, target, step) {
    if (v < target) return Math.min(target, v + step);
    return Math.max(target, v - step);
  };

  /* RimWorld's SimpleCurve: linear interpolation over [[x,y], ...]. */
  U.curve = function (points, x) {
    if (!points.length) return 0;
    if (x <= points[0][0]) return points[0][1];
    for (var i = 1; i < points.length; i++) {
      if (x <= points[i][0]) {
        var a = points[i - 1], b = points[i];
        var t = b[0] === a[0] ? 0 : (x - a[0]) / (b[0] - a[0]);
        return a[1] + (b[1] - a[1]) * t;
      }
    }
    return points[points.length - 1][1];
  };

  /* ---------- distances ---------- */
  U.distSq = function (x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1; return dx * dx + dy * dy;
  };
  U.dist = function (x1, y1, x2, y2) { return Math.sqrt(U.distSq(x1, y1, x2, y2)); };
  U.manhattan = function (x1, y1, x2, y2) {
    return Math.abs(x2 - x1) + Math.abs(y2 - y1);
  };
  U.cheb = function (x1, y1, x2, y2) {
    return Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  };
  U.adjacent = function (x1, y1, x2, y2) {
    return U.cheb(x1, y1, x2, y2) <= 1 && !(x1 === x2 && y1 === y2);
  };

  /* ---------- grid ---------- */
  U.ADJ4 = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  U.ADJ8 = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];
  U.DIAG = [[1, -1], [1, 1], [-1, 1], [-1, -1]];

  /* Cells in rings of increasing radius - the standard "search outward
     from here" order used by hauling, spawning and float menus. */
  U.cellsInRadius = function (cx, cy, radius) {
    var out = [], r2 = radius * radius;
    for (var dy = -radius; dy <= radius; dy++)
      for (var dx = -radius; dx <= radius; dx++)
        if (dx * dx + dy * dy <= r2) out.push([cx + dx, cy + dy]);
    out.sort(function (a, b) {
      return U.distSq(cx, cy, a[0], a[1]) - U.distSq(cx, cy, b[0], b[1]);
    });
    return out;
  };

  /* ---------- binary heap, for A* ----------
     Parallel arrays rather than objects: the pathfinder pushes tens of
     thousands of nodes and we do not want a garbage object per node. */
  function MinHeap() { this.items = []; this.prio = []; this.n = 0; }

  MinHeap.prototype.clear = function () { this.items.length = 0; this.prio.length = 0; this.n = 0; };
  MinHeap.prototype.size = function () { return this.n; };
  MinHeap.prototype.isEmpty = function () { return this.n === 0; };

  MinHeap.prototype.push = function (item, priority) {
    var i = this.n++;
    this.items[i] = item; this.prio[i] = priority;
    while (i > 0) {
      var parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this._swap(i, parent);
      i = parent;
    }
  };

  MinHeap.prototype.pop = function () {
    if (this.n === 0) return undefined;
    var top = this.items[0];
    this.n--;
    if (this.n > 0) {
      this.items[0] = this.items[this.n];
      this.prio[0] = this.prio[this.n];
      var i = 0;
      for (;;) {
        var l = i * 2 + 1, r = l + 1, small = i;
        if (l < this.n && this.prio[l] < this.prio[small]) small = l;
        if (r < this.n && this.prio[r] < this.prio[small]) small = r;
        if (small === i) break;
        this._swap(i, small);
        i = small;
      }
    }
    this.items.length = this.n; this.prio.length = this.n;
    return top;
  };

  MinHeap.prototype.peekPriority = function () {
    return this.n ? this.prio[0] : Infinity;
  };

  MinHeap.prototype._swap = function (a, b) {
    var ti = this.items[a]; this.items[a] = this.items[b]; this.items[b] = ti;
    var tp = this.prio[a]; this.prio[a] = this.prio[b]; this.prio[b] = tp;
  };

  U.MinHeap = MinHeap;

  /* ---------- ids ---------- */
  var _nextId = 1;
  U.nextId = function () { return _nextId++; };
  U.peekId = function () { return _nextId; };
  U.setIdCounter = function (n) { _nextId = n; };

  /* ---------- arrays ---------- */
  U.remove = function (arr, item) {
    var i = arr.indexOf(item);
    if (i >= 0) { arr.splice(i, 1); return true; }
    return false;
  };
  U.sum = function (arr, fn) {
    var t = 0;
    for (var i = 0; i < arr.length; i++) t += fn ? fn(arr[i], i) : arr[i];
    return t;
  };
  U.minBy = function (arr, fn) {
    var best = null, bestV = Infinity;
    for (var i = 0; i < arr.length; i++) {
      var v = fn(arr[i], i);
      if (v < bestV) { bestV = v; best = arr[i]; }
    }
    return best;
  };
  U.maxBy = function (arr, fn) {
    return U.minBy(arr, function (a, i) { return -fn(a, i); });
  };
  U.countBy = function (arr, fn) {
    var n = 0;
    for (var i = 0; i < arr.length; i++) if (fn(arr[i], i)) n++;
    return n;
  };

  /* ---------- text ---------- */
  U.cap = function (s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
  U.plural = function (n, one, many) { return n === 1 ? one : (many || one + 's'); };
  U.fmt = function (v, dp) {
    var p = Math.pow(10, dp === undefined ? 1 : dp);
    return String(Math.round(v * p) / p);
  };
  U.pct = function (v) { return Math.round(v * 100) + '%'; };
  U.signed = function (v, dp) { return (v >= 0 ? '+' : '') + U.fmt(v, dp); };

  root.U = U;
})(this);
