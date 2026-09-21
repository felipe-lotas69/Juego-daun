/* ============================================================
   engine.js - the low-level layer: maths, the pixel buffer,
   the font, sprite stamping, and the keyboard.

   Everything is drawn into a 320x180 buffer and blown up whole.
   That is a real pixel grid, and it is meant to be: the look this
   game is after comes from packing DETAIL into a small frame -
   window grids, panel lines, lamp posts - rather than from making
   the pixels enormous. A character is 22 pixels tall in a frame
   180 tall, and the frame is dense around it.
   ============================================================ */
(function (root) {
  'use strict';

  /* ---------------------------------------------------------- maths */
  var U = {
    clamp: function (v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); },
    lerp: function (a, b, t) { return a + (b - a) * t; },
    rand: function (a, b) { return a + Math.random() * (b - a); },
    pick: function (arr) { return arr[(Math.random() * arr.length) | 0]; },
    dist: function (ax, ay, bx, by) {
      var dx = bx - ax, dy = by - ay; return Math.sqrt(dx * dx + dy * dy);
    },
    overlap: function (a, b) {
      return a.x < b.x + b.w && a.x + a.w > b.x &&
             a.y < b.y + b.h && a.y + a.h > b.y;
    },
    /* a small seeded generator, so a level's scenery is the same every run */
    seeded: function (seed) {
      var s = seed | 0;
      return function () {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        return s / 0x7fffffff;
      };
    }
  };

  /* ---------------------------------------------------------- font
     5x7, which is enough for a lower-case-looking chunky face and
     wide enough to carry an outline without closing up. Each glyph
     is seven rows of five, written out so it can be read and fixed. */
  var GLYPH = {
    'A': '01110100011000111111100011000110001',
    'B': '11110100011000111110100011000111110',
    'C': '01110100011000010000100001000101110',
    'D': '11110100011000110001100011000111110',
    'E': '11111100001000011110100001000011111',
    'F': '11111100001000011110100001000010000',
    'G': '01110100011000010111100011000101111',
    'H': '10001100011000111111100011000110001',
    'I': '11111001000010000100001000010011111',
    'J': '00111000100001000010000101001001100',
    'K': '10001100101010011000101001001010001',
    'L': '10000100001000010000100001000011111',
    'M': '10001110111010110001100011000110001',
    'N': '10001110011010110011100011000110001',
    'O': '01110100011000110001100011000101110',
    'P': '11110100011000111110100001000010000',
    'Q': '01110100011000110001101011001001101',
    'R': '11110100011000111110101001001010001',
    'S': '01111100001000001110000011000011110',
    'T': '11111001000010000100001000010000100',
    'U': '10001100011000110001100011000101110',
    'V': '10001100011000110001100010101000100',
    'W': '10001100011000110001101011101110001',
    'X': '10001100010101000100010101000110001',
    'Y': '10001100011000101010001000010000100',
    'Z': '11111000010001000100010001000011111',
    '0': '01110100011001110101110011000101110',
    '1': '00100011000010000100001000010001110',
    '2': '01110100010000100110010001000011111',
    '3': '11110000010000101110000011000111110',
    '4': '00010001100101010010111110001000010',
    '5': '11111100001111000001000011000111110',
    '6': '00110010001000011110100011000101110',
    '7': '11111000010001000100001000010000100',
    '8': '01110100011000101110100011000101110',
    '9': '01110100011000101111000010001001100',
    ' ': '00000000000000000000000000000000000',
    '.': '00000000000000000000000000110001100',
    ',': '00000000000000000000000001100011000',
    '!': '00100001000010000100001000000000100',
    '?': '01110100010000100110001000000000100',
    ':': '00000011000110000000011000110000000',
    '-': '00000000000000001111000000000000000',
    '/': '00001000100010001000100010001000000',
    "'": '00100001000010000000000000000000000',
    '+': '00000001000010001111100100001000000',
    '%': '11001110010001000100010001001110011',
    '(': '00010001000100001000010000100000010',
    ')': '01000001000001000010000100010001000'
  };
  var GLYPH_W = 5, GLYPH_H = 7;

  /* ---------------------------------------------------------- buffer */
  var Pixel = {
    W: 320,
    H: 180,
    buf: null,
    ctx: null,

    init: function () {
      if (typeof document === 'undefined') return null;   /* headless tools */
      this.buf = document.createElement('canvas');
      this.buf.width = this.W;
      this.buf.height = this.H;
      this.ctx = this.buf.getContext('2d');
      this.ctx.imageSmoothingEnabled = false;
      return this.ctx;
    },

    begin: function () {
      var c = this.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      c.clearRect(0, 0, this.W, this.H);
      return c;
    },

    blit: function (dst, w, h) {
      dst.imageSmoothingEnabled = false;
      dst.clearRect(0, 0, w, h);
      dst.drawImage(this.buf, 0, 0, this.W, this.H, 0, 0, w, h);
    },

    /* --- shapes. Whole pixels only; a fractional edge would blend. --- */
    rect: function (c, x, y, w, h, col) {
      x = Math.round(x); y = Math.round(y);
      w = Math.round(w); h = Math.round(h);
      if (w <= 0 || h <= 0) return;
      c.fillStyle = col;
      c.fillRect(x, y, w, h);
    },

    frame: function (c, x, y, w, h, col) {
      this.rect(c, x, y, w, 1, col);
      this.rect(c, x, y + h - 1, w, 1, col);
      this.rect(c, x, y, 1, h, col);
      this.rect(c, x + w - 1, y, 1, h, col);
    },

    /* A circle made of rows of whole pixels. */
    disc: function (c, cx, cy, r, col) {
      cx = Math.round(cx); cy = Math.round(cy);
      c.fillStyle = col;
      for (var dy = -r; dy <= r; dy++) {
        var half = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
        if (half <= 0 && r > 1) continue;
        c.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
      }
    },

    /* A limb: blocks walked from joint to joint, so it stays on the
       grid at any angle instead of stroking a smooth diagonal. */
    limb: function (c, x0, y0, x1, y1, thick, col) {
      var dx = x1 - x0, dy = y1 - y0;
      var steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy))));
      var off = (thick - 1) >> 1;
      c.fillStyle = col;
      for (var i = 0; i <= steps; i++) {
        var t = i / steps;
        c.fillRect(Math.round(x0 + dx * t) - off, Math.round(y0 + dy * t) - off,
                   thick, thick);
      }
    },

    /* --- sprites ---
       A sprite is rows of characters looked up in a colour map; a
       character the map has no colour for is transparent. Rotation maps
       each DESTINATION pixel back through the angle, so nothing is
       anti-aliased and no gap opens up at a diagonal. */
    stamp: function (c, sprite, map, cx, cy, angle, flip) {
      var h = sprite.length, w = sprite[0].length;
      cx = Math.round(cx); cy = Math.round(cy);
      if (!angle) {
        var x0 = cx - (w >> 1), y0 = cy - (h >> 1), last = null;
        for (var r = 0; r < h; r++) {
          var row = sprite[r];
          for (var q = 0; q < w; q++) {
            var ch = map[row.charAt(flip ? w - 1 - q : q)];
            if (!ch) continue;
            if (ch !== last) { c.fillStyle = ch; last = ch; }
            c.fillRect(x0 + q, y0 + r, 1, 1);
          }
        }
        return;
      }
      var cos = Math.cos(angle), sin = Math.sin(angle);
      var reach = Math.ceil(Math.sqrt(w * w + h * h) / 2) + 1;
      var prev = null;
      for (var dy = -reach; dy <= reach; dy++) {
        for (var dx = -reach; dx <= reach; dx++) {
          var lx = dx + 0.5, ly = dy + 0.5;
          var sx = lx * cos + ly * sin, sy = -lx * sin + ly * cos;
          var col = Math.floor(sx + w / 2), rw = Math.floor(sy + h / 2);
          if (rw < 0 || rw >= h || col < 0 || col >= w) continue;
          var cc = map[sprite[rw].charAt(flip ? w - 1 - col : col)];
          if (!cc) continue;
          if (cc !== prev) { c.fillStyle = cc; prev = cc; }
          c.fillRect(cx + dx, cy + dy, 1, 1);
        }
      }
    },

    /* --- text --- */
    textWidth: function (str, scale) {
      scale = scale || 1;
      return String(str).length * (GLYPH_W + 1) * scale;
    },

    text: function (c, str, x, y, scale, col, align) {
      scale = scale || 1;
      str = String(str).toUpperCase();
      var w = this.textWidth(str, scale);
      var sx = Math.round(align === 'center' ? x - w / 2 : (align === 'right' ? x - w : x));
      var sy = Math.round(y);
      c.fillStyle = col || '#fff';
      for (var i = 0; i < str.length; i++) {
        var g = GLYPH[str.charAt(i)];
        if (!g) continue;
        for (var r = 0; r < GLYPH_H; r++) {
          for (var q = 0; q < GLYPH_W; q++) {
            if (g.charAt(r * GLYPH_W + q) === '1') {
              c.fillRect(sx + (i * (GLYPH_W + 1) + q) * scale, sy + r * scale, scale, scale);
            }
          }
        }
      }
      return w;
    },

    /* Title lettering: a hard outline all the way round, the way the
       signage in this kind of game is drawn. */
    outlineText: function (c, str, x, y, scale, col, outline, align) {
      var o = outline || '#101018';
      for (var dy = -scale; dy <= scale; dy += scale) {
        for (var dx = -scale; dx <= scale; dx += scale) {
          if (!dx && !dy) continue;
          this.text(c, str, x + dx, y + dy, scale, o, align);
        }
      }
      return this.text(c, str, x, y, scale, col, align);
    }
  };

  /* ---------------------------------------------------------- input */
  var Input = {
    down: {},
    hit: {},
    released: {},
    held: {},          /* seconds a key has been held */

    attach: function (target) {
      var self = this;
      target.addEventListener('keydown', function (e) {
        if (e.repeat) return;
        if (!self.down[e.code]) { self.down[e.code] = true; self.hit[e.code] = true; self.held[e.code] = 0; }
        if (BLOCK[e.code]) e.preventDefault();
      });
      target.addEventListener('keyup', function (e) {
        if (self.down[e.code]) { self.down[e.code] = false; self.released[e.code] = true; }
        if (BLOCK[e.code]) e.preventDefault();
      });
      target.addEventListener('blur', function () {
        for (var k in self.down) { if (self.down[k]) self.released[k] = true; }
        self.down = {};
      });
    },

    tick: function (dt) {
      for (var k in this.down) if (this.down[k]) this.held[k] += dt;
    },

    /* called at the end of a frame, once everything has read the edges */
    clear: function () { this.hit = {}; this.released = {}; },

    isDown: function (code) { return !!this.down[code]; },
    pressed: function (code) { return !!this.hit[code]; },
    letGo: function (code) { return !!this.released[code]; },
    heldFor: function (code) { return this.held[code] || 0; }
  };

  var BLOCK = {
    Space: 1, ArrowUp: 1, ArrowDown: 1, ArrowLeft: 1, ArrowRight: 1,
    KeyW: 1, KeyE: 1, KeyR: 1, Tab: 1
  };

  root.U = U;
  root.Pixel = Pixel;
  root.Input = Input;
})(typeof window !== 'undefined' ? window : globalThis);
