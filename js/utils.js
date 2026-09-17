/* ============================================================
   utils.js - math, random, geometry helpers
   ============================================================ */
(function (root) {
  'use strict';

  var U = {};

  U.clamp = function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); };
  U.lerp = function (a, b, t) { return a + (b - a) * t; };
  U.sign = function (v) { return v < 0 ? -1 : (v > 0 ? 1 : 0); };
  U.rand = function (a, b) { return a + Math.random() * (b - a); };
  U.randInt = function (a, b) { return Math.floor(a + Math.random() * (b - a + 1)); };
  U.pick = function (arr) { return arr[Math.floor(Math.random() * arr.length)]; };
  U.dist = function (ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy); };
  U.dist2 = function (ax, ay, bx, by) { var dx = bx - ax, dy = by - ay; return dx * dx + dy * dy; };

  /* frame-rate independent damping: value *= damp(rate, dt) */
  U.damp = function (rate, dt) { return Math.exp(-rate * dt); };

  /* move `cur` toward `target` by at most `step` */
  U.approach = function (cur, target, step) {
    if (cur < target) return Math.min(cur + step, target);
    if (cur > target) return Math.max(cur - step, target);
    return target;
  };

  U.aabb = function (a, b) {
    return a.x < b.x + b.w && a.x + a.w > b.x &&
           a.y < b.y + b.h && a.y + a.h > b.y;
  };

  U.pointInRect = function (px, py, r) {
    return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h;
  };

  U.rectCenter = function (r) { return { x: r.x + r.w / 2, y: r.y + r.h / 2 }; };

  /* Segment vs axis-aligned rect (slab method).
     Returns nearest hit fraction in [0,1] or -1 when there's no hit. */
  U.segRect = function (x0, y0, x1, y1, r) {
    var dx = x1 - x0, dy = y1 - y0;
    var tmin = 0, tmax = 1;
    var p, q, t1, t2, i;
    for (i = 0; i < 2; i++) {
      p = i === 0 ? dx : dy;
      q = i === 0 ? x0 : y0;
      var lo = i === 0 ? r.x : r.y;
      var hi = i === 0 ? r.x + r.w : r.y + r.h;
      if (Math.abs(p) < 1e-9) {
        if (q < lo || q > hi) return -1;
      } else {
        t1 = (lo - q) / p;
        t2 = (hi - q) / p;
        if (t1 > t2) { var tmp = t1; t1 = t2; t2 = tmp; }
        if (t1 > tmin) tmin = t1;
        if (t2 < tmax) tmax = t2;
        if (tmin > tmax) return -1;
      }
    }
    return tmin;
  };

  /* Does the segment reach `to` without crossing any blocking rect? */
  U.lineOfSight = function (x0, y0, x1, y1, rects) {
    for (var i = 0; i < rects.length; i++) {
      if (U.segRect(x0, y0, x1, y1, rects[i]) >= 0) return false;
    }
    return true;
  };

  U.formatTime = function (sec) {
    if (sec == null || !isFinite(sec)) return '--';
    var m = Math.floor(sec / 60);
    var s = sec - m * 60;
    if (m > 0) return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
    return s.toFixed(2);
  };

  /* tiny localStorage wrapper that never throws (private mode, etc.) */
  U.store = {
    get: function (key, fallback) {
      try {
        var raw = root.localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set: function (key, value) {
      try { root.localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    }
  };

  /* rounded rectangle path */
  U.roundRect = function (ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };

  root.U = U;
})(typeof window !== 'undefined' ? window : globalThis);
