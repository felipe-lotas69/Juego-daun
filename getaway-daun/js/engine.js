/* ============================================================
   engine.js - the low-level layer: maths, the canvas, the font,
   sprite stamping, and the keyboard.

   The canvas runs at its own resolution and the ASSETS are pixel
   art drawn onto it - not the whole picture squashed onto one
   coarse grid. So a character is a 22-pixel sprite in blocks you
   can count, while the sky behind it is a gradient with as many
   steps as it wants.
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

  /* ---------------------------------------------------------- canvas
     The canvas is its real size and is drawn on directly. There is no
     small buffer being blown up, because that put EVERYTHING on one
     coarse grid - the sky, the clouds, the lettering - and a sky in six
     flat bands is the one thing that gives it away.

     Instead: assets are pixel art at SCALE screen pixels per art pixel,
     and the backdrop behind them is drawn at the canvas's own resolution,
     where a gradient can have as many steps as it likes. Measuring the
     reference art says that is exactly how it is built - its buildings
     sit on a clean 7px grid and hold 19 colours, while its sky is on no
     grid at all and holds over two hundred. */
  var Pixel = {
    /* Measured against the reference: its art grid works out at roughly
       294x154 across the frame, where this was 320x180 - finer, so every
       pixel read smaller than it should. 256x144 puts the grid a shade
       coarser than the reference rather than a shade finer, and keeps
       SCALE a whole number, which crisp blocks depend on. */
    /* One art pixel is SCALE screen pixels and that is true of EVERY
       asset - characters, platforms, props, skyline, clouds. Three, so a
       22-unit character stands about a tenth of the frame and the camera
       can show a wide slice of the level. */
    /* Measured off the reference art: its frame works out at about
       160x100 art pixels. A 22-unit character in a 120-unit frame stands
       about a fifth of the screen, and the wider frame shows more of the
       level. Six screen pixels an art pixel, and that holds for every
       asset in the game. */
    W: 213,          /* world units across the view */
    H: 120,
    SCALE: 6,        /* screen pixels per world unit, and per art pixel */

    /* The interface does NOT live in world units - it would shrink every
       time the camera pulled back. It gets a fixed space of its own. */
    UI_W: 213,
    UI_H: 120,
    UI_SCALE: 6,
    ctx: null,
    cw: 1280,
    ch: 720,
    world: true,

    init: function (canvas) {
      if (!canvas) return null;
      this.ctx = canvas.getContext('2d');
      this.cw = canvas.width;
      this.ch = canvas.height;
      this.SCALE = this.cw / this.W;
      return this.ctx;
    },

    /* world space: one unit is SCALE screen pixels, so a sprite pixel
       comes out as a crisp SCALE-wide block */
    begin: function (zoom) {
      var c = this.ctx;
      var z = this.SCALE * (zoom || 1);
      c.setTransform(z, 0, 0, z, 0, 0);
      c.imageSmoothingEnabled = false;
      this.world = true;
      return c;
    },

    /* a fixed space for the HUD, independent of the camera */
    ui: function () {
      var c = this.ctx;
      c.setTransform(this.UI_SCALE, 0, 0, this.UI_SCALE, 0, 0);
      c.imageSmoothingEnabled = false;
      this.world = true;
      return c;
    },

    /* screen space: full canvas resolution, for anything that should be
       smooth rather than blocky */
    screen: function (clear) {
      var c = this.ctx;
      c.setTransform(1, 0, 0, 1, 0, 0);
      if (clear) c.clearRect(0, 0, this.cw, this.ch);
      this.world = false;
      return c;
    },

    /* Snap to the SCREEN pixel grid, whichever space we are in. Terrain
       and UI use it so their edges stay hard. SPRITES DO NOT: they move
       and rotate freely, which is what keeps chunky art from juddering
       onto a grid every time the camera drifts half a unit. */
    s: function (v) {
      return this.world ? Math.round(v * this.SCALE) / this.SCALE : Math.round(v);
    },

    /* --- shapes. Whole pixels only; a fractional edge would blend. --- */
    rect: function (c, x, y, w, h, col) {
      var x0 = this.s(x), y0 = this.s(y);
      var x1 = this.s(x + w), y1 = this.s(y + h);
      var unit = this.world ? 1 / this.SCALE : 1;
      if (x1 <= x0) x1 = x0 + unit;
      if (y1 <= y0) y1 = y0 + unit;
      if (col) c.fillStyle = col;
      c.fillRect(x0, y0, x1 - x0, y1 - y0);
    },

    frame: function (c, x, y, w, h, col) {
      var t = this.world ? 1 : 1;
      this.rect(c, x, y, w, t, col);
      this.rect(c, x, y + h - t, w, t, col);
      this.rect(c, x, y, t, h, col);
      this.rect(c, x + w - t, y, t, h, col);
    },

    /* A circle made of rows of whole pixels. */
    disc: function (c, cx, cy, r, col) {
      cx = this.s(cx); cy = this.s(cy);
      c.fillStyle = col;
      for (var dy = -r; dy <= r; dy++) {
        var half = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
        if (half <= 0 && r > 1) continue;
        c.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
      }
    },

    /* --- sprites ---
       A sprite is baked ONCE into a little offscreen bitmap, one canvas
       pixel per art pixel, and then drawn rotated as a whole.

       The first version rotated by walking every destination pixel and
       asking which source pixel landed there. That re-picks each art
       pixel independently every frame, so the pattern inside the sprite
       reorganises as the angle drifts - the pixels crawl around within
       the character instead of the character turning. A limb or a head is
       a rigid part: it has to keep its own pixels and rotate as one
       piece, the way a sprite does in any 2D engine. */
    baked: {},
    ids: (typeof WeakMap !== 'undefined') ? new WeakMap() : null,
    idSeq: 1,

    idOf: function (o) {
      if (!this.ids) return 'x';
      var id = this.ids.get(o);
      if (!id) { id = this.idSeq++; this.ids.set(o, id); }
      return id;
    },

    bake: function (sprite, map) {
      var key = 's' + this.idOf(sprite) + ':' + this.idOf(map);
      var hit = this.baked[key];
      if (hit) return hit;
      var h = sprite.length, w = sprite[0].length;
      var cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      var c = cv.getContext('2d');
      for (var r = 0; r < h; r++) {
        for (var q = 0; q < w; q++) {
          var col = map[sprite[r].charAt(q)];
          if (!col) continue;
          c.fillStyle = col;
          c.fillRect(q, r, 1, 1);
        }
      }
      this.baked[key] = cv;
      return cv;
    },

    /* a limb segment: a bar of a given length, thickness and colour */
    bakeBar: function (len, thick, col) {
      var key = 'b' + len + ':' + thick + ':' + col;
      var hit = this.baked[key];
      if (hit) return hit;
      var cv = document.createElement('canvas');
      cv.width = len; cv.height = thick;
      var c = cv.getContext('2d');
      c.fillStyle = col;
      c.fillRect(0, 0, len, thick);
      this.baked[key] = cv;
      return cv;
    },

    stamp: function (c, sprite, map, cx, cy, angle, flip) {
      var img = this.bake(sprite, map);
      var w = img.width, h = img.height;
      if (!angle && !flip) {
        c.imageSmoothingEnabled = false;
        c.drawImage(img, cx - w / 2, cy - h / 2, w, h);
        return;
      }
      c.save();
      c.translate(cx, cy);
      if (angle) c.rotate(angle);
      if (flip) c.scale(-1, 1);
      c.imageSmoothingEnabled = false;
      c.drawImage(img, -w / 2, -h / 2, w, h);
      c.restore();
    },

    /* A limb, drawn the same way: one rigid bar turned to the joint
       angle, rather than a run of blocks stamped along the line. */
    limb: function (c, x0, y0, x1, y1, thick, col) {
      var dx = x1 - x0, dy = y1 - y0;
      var len = Math.max(1, Math.round(Math.sqrt(dx * dx + dy * dy)) + 1);
      var img = this.bakeBar(len, thick, col);
      c.save();
      c.translate((x0 + x1) / 2, (y0 + y1) / 2);
      c.rotate(Math.atan2(dy, dx));
      c.imageSmoothingEnabled = false;
      c.drawImage(img, -len / 2, -thick / 2, len, thick);
      c.restore();
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
      var sx = this.s(align === 'center' ? x - w / 2 : (align === 'right' ? x - w : x));
      var sy = this.s(y);
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
