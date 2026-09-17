/* ============================================================
   pixel.js - the chunky look

   Everything is drawn into a small offscreen buffer and blown up
   with nearest-neighbour, so one "pixel" is PIXEL world units on
   screen. That is what gives rotated characters their stair-step
   edges instead of smooth anti-aliased ones - the blending happens
   at buffer resolution and then gets magnified with everything else.
   ============================================================ */
(function (root) {
  'use strict';

  var PIXEL = 3;                 /* world units per screen pixel */

  /* ---------------------------------------------------------- 3x5 font
     Each glyph is five rows; each row is three bits, high bit on the
     left. Small, but it reads cleanly once it is blown up. */
  var GLYPHS = {
    '0': [7, 5, 5, 5, 7], '1': [2, 6, 2, 2, 7], '2': [7, 1, 7, 4, 7],
    '3': [7, 1, 7, 1, 7], '4': [5, 5, 7, 1, 1], '5': [7, 4, 7, 1, 7],
    '6': [7, 4, 7, 5, 7], '7': [7, 1, 1, 1, 1], '8': [7, 5, 7, 5, 7],
    '9': [7, 5, 7, 1, 7],
    'A': [7, 5, 7, 5, 5], 'B': [6, 5, 6, 5, 6], 'C': [7, 4, 4, 4, 7],
    'D': [6, 5, 5, 5, 6], 'E': [7, 4, 6, 4, 7], 'F': [7, 4, 6, 4, 4],
    'G': [7, 4, 5, 5, 7], 'H': [5, 5, 7, 5, 5], 'I': [7, 2, 2, 2, 7],
    'J': [1, 1, 1, 5, 7], 'K': [5, 5, 6, 5, 5], 'L': [4, 4, 4, 4, 7],
    'M': [5, 7, 7, 5, 5], 'N': [5, 7, 7, 7, 5], 'O': [7, 5, 5, 5, 7],
    'P': [7, 5, 7, 4, 4], 'Q': [7, 5, 5, 7, 1], 'R': [7, 5, 7, 6, 5],
    'S': [7, 4, 7, 1, 7], 'T': [7, 2, 2, 2, 2], 'U': [5, 5, 5, 5, 7],
    'V': [5, 5, 5, 5, 2], 'W': [5, 5, 7, 7, 5], 'X': [5, 5, 2, 5, 5],
    'Y': [5, 5, 7, 2, 2], 'Z': [7, 1, 2, 4, 7],
    ' ': [0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 2], ':': [0, 2, 0, 2, 0],
    '-': [0, 0, 7, 0, 0], '!': [2, 2, 2, 0, 2], '/': [1, 1, 2, 4, 4],
    '+': [0, 2, 7, 2, 0], "'": [2, 2, 0, 0, 0], ',': [0, 0, 0, 2, 4],
    '?': [7, 1, 2, 0, 2], '%': [5, 1, 2, 4, 5], '·': [0, 0, 2, 0, 0]
  };

  var Pixel = {
    SIZE: PIXEL,
    buffer: null,
    bctx: null,
    w: 0,
    h: 0,

    /* snap a world coordinate onto the pixel grid */
    s: function (v) { return Math.round(v / PIXEL) * PIXEL; },

    init: function (viewW, viewH) {
      this.w = Math.round(viewW / PIXEL);
      this.h = Math.round(viewH / PIXEL);
      /* The grid maths is useful on a headless host too; the buffer is not. */
      if (typeof document === 'undefined') return null;
      this.buffer = document.createElement('canvas');
      this.buffer.width = this.w;
      this.buffer.height = this.h;
      this.bctx = this.buffer.getContext('2d');
      this.bctx.imageSmoothingEnabled = false;
      return this.bctx;
    },

    /* Hand back the buffer context, cleared, already scaled so callers
       keep working in world units. */
    begin: function () {
      var b = this.bctx;
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.clearRect(0, 0, this.w, this.h);
      b.scale(1 / PIXEL, 1 / PIXEL);
      return b;
    },

    blit: function (ctx, viewW, viewH) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, viewW, viewH);
      ctx.drawImage(this.buffer, 0, 0, this.w, this.h, 0, 0, viewW, viewH);
    },

    /* ---------------------------------------------------------- shapes
       Grid-aligned so edges land on whole buffer pixels instead of
       smearing across two. */
    rect: function (ctx, x, y, w, h, color) {
      var x0 = this.s(x), y0 = this.s(y);
      var x1 = this.s(x + w), y1 = this.s(y + h);
      if (x1 <= x0) x1 = x0 + PIXEL;
      if (y1 <= y0) y1 = y0 + PIXEL;
      if (color) ctx.fillStyle = color;
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
    },

    /* hollow box, one pixel thick */
    frame: function (ctx, x, y, w, h, color) {
      this.rect(ctx, x, y, w, PIXEL, color);
      this.rect(ctx, x, y + h - PIXEL, w, PIXEL, color);
      this.rect(ctx, x, y, PIXEL, h, color);
      this.rect(ctx, x + w - PIXEL, y, PIXEL, h, color);
    },

    /* A circle built out of blocks. Slower than arc(), but round things
       have to be made of squares here or they look out of place. */
    disc: function (ctx, cx, cy, r, color) {
      if (color) ctx.fillStyle = color;
      var p = PIXEL;
      var steps = Math.max(1, Math.round(r / p));
      for (var iy = -steps; iy <= steps; iy++) {
        var yy = iy * p;
        var half = Math.sqrt(Math.max(0, r * r - yy * yy));
        var hw = Math.round(half / p) * p;
        if (hw <= 0) continue;
        ctx.fillRect(this.s(cx) - hw, this.s(cy) + yy, hw * 2, p);
      }
    },

    /* A limb: a run of blocks from joint to joint. Squares rather than a
       stroked path, so it stays on the grid at any angle. */
    line: function (ctx, x0, y0, x1, y1, thick, color) {
      var P = PIXEL;
      var dx = x1 - x0, dy = y1 - y0;
      var steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / P));
      var half = Math.max(P, Math.round(thick / 2 / P) * P);
      if (color) ctx.fillStyle = color;
      for (var i = 0; i <= steps; i++) {
        var t = i / steps;
        ctx.fillRect(this.s(x0 + dx * t) - half, this.s(y0 + dy * t) - half, half * 2, half * 2);
      }
    },

    /* ---------------------------------------------------------- colour
       Shading tones are derived rather than written out, so a palette only
       has to name its base colours and anything drawn from it - players,
       enemies, the hurt flash - gets the same treatment. */
    tintCache: {},
    tint: function (hex, f) {
      if (!hex || hex.charAt(0) !== '#') return hex;
      var key = hex + '|' + f;
      var hit = this.tintCache[key];
      if (hit) return hit;
      var h = hex.slice(1);
      if (h.length === 3) {
        h = h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2);
      }
      var n = parseInt(h, 16);
      var t = f > 0 ? 255 : 0, a = Math.abs(f);
      var r = Math.round(((n >> 16) & 255) + (t - ((n >> 16) & 255)) * a);
      var g = Math.round(((n >> 8) & 255) + (t - ((n >> 8) & 255)) * a);
      var b = Math.round((n & 255) + (t - (n & 255)) * a);
      var out = '#' + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
      this.tintCache[key] = out;
      return out;
    },

    /* Alpha in steps rather than a smooth ramp. A continuous fade lands on
       a slightly different blend every frame, and a pile of them - smoke,
       blood, a body fading out - turns into a soft gradient, which is the
       one thing a grid this coarse cannot carry. Four steps keep the whole
       pile on a countable set of tones. */
    qa: function (a) {
      if (!(a > 0)) return 0;
      if (a >= 1) return 1;
      return Math.round(a * 4) / 4;
    },

    /* ---------------------------------------------------------- sprites
       A sprite is rows of characters, one per pixel, looked up in a colour
       map; anything the map has no colour for is transparent.

       Rotation is why this exists rather than a rotate() and a fillRect.
       The buffer is only a couple of hundred pixels across, so a rotated
       rect gets anti-aliased AT THAT SIZE and the blended edge pixels are
       then magnified with everything else - which is a smear, not a stair
       step. Here every destination pixel is filled whole, in a colour that
       came out of the map: the shape rotates, the palette stays pure.

       Destination pixels are walked and mapped BACK through the rotation,
       so no gap opens up between source pixels at an angle. */
    stamp: function (ctx, sprite, map, cx, cy, angle, flipX) {
      var h = sprite.length, w = sprite[0].length;
      var cos = Math.cos(angle), sin = Math.sin(angle);
      var reach = Math.ceil(Math.sqrt(w * w + h * h) / 2) + 1;
      var ox = this.s(cx), oy = this.s(cy);
      var last = null;
      for (var dy = -reach; dy <= reach; dy++) {
        for (var dx = -reach; dx <= reach; dx++) {
          var lx = dx + 0.5, ly = dy + 0.5;
          var sx = lx * cos + ly * sin;
          var sy = -lx * sin + ly * cos;
          var col = Math.floor(sx + w / 2);
          var row = Math.floor(sy + h / 2);
          if (row < 0 || row >= h || col < 0 || col >= w) continue;
          var c = map[sprite[row].charAt(flipX ? w - 1 - col : col)];
          if (!c) continue;
          if (c !== last) { ctx.fillStyle = c; last = c; }
          ctx.fillRect(ox + dx * PIXEL, oy + dy * PIXEL, PIXEL, PIXEL);
        }
      }
    },

    /* ---------------------------------------------------------- text */
    textWidth: function (str, size) {
      size = size || PIXEL;
      return str.length * 4 * size;
    },

    text: function (ctx, str, x, y, size, color, align) {
      size = size || PIXEL;
      str = String(str).toUpperCase();
      var w = this.textWidth(str, size);
      var sx = this.s(align === 'center' ? x - w / 2 : (align === 'right' ? x - w : x));
      var sy = this.s(y);
      ctx.fillStyle = color || '#fff';
      for (var i = 0; i < str.length; i++) {
        var g = GLYPHS[str.charAt(i)];
        if (!g) { continue; }
        for (var row = 0; row < 5; row++) {
          var bits = g[row];
          if (!bits) continue;
          for (var col = 0; col < 3; col++) {
            if (bits & (4 >> col)) {
              ctx.fillRect(sx + (i * 4 + col) * size, sy + row * size, size, size);
            }
          }
        }
      }
      return w;
    },

    /* text with a hard one-pixel drop shadow, which is how the real
       thing keeps HUD numbers readable over a bright sky */
    shadowText: function (ctx, str, x, y, size, color, align) {
      this.text(ctx, str, x + size, y + size, size, 'rgba(0,0,0,0.45)', align);
      return this.text(ctx, str, x, y, size, color, align);
    }
  };

  root.Pixel = Pixel;
})(typeof window !== 'undefined' ? window : globalThis);
