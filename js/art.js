/* ============================================================
   art.js - every sprite in the game, drawn in code.

   There are no image files anywhere in this project, which is the
   only reason it runs off a file:// URL with nothing to fetch. Every
   sprite below is painted with fillRect into an offscreen canvas at
   16x16 pixels per tile, once, at boot, and then cached by key.

   Two conventions run through the whole file:

   1. A "pixel" is one fillRect of size 1. At zoom 1 that is literally
      one screen pixel, so the art is authored the way it will be seen:
      flat colours, hard edges, no gradients and no anti-aliasing. The
      only transforms used are exact 90-degree rotations and mirrors,
      which land on pixel centres and so stay lossless.

   2. Variation is deterministic, never random. A field of soil is
      textured because the renderer hashes the cell coordinates into
      one of four pre-drawn variants, and each variant's speckles come
      from a local generator seeded by its cache key. Nothing here ever
      touches U.rand: the simulation stream must not move because
      somebody scrolled the camera over a new patch of grass.

   Every canvas returned carries `ox`/`oy`: the offset, in authored
   pixels, from the thing's top-left tile to where the canvas should be
   drawn. It is zero for almost everything and negative for sprites that
   overhang their tile, such as trees and large animals.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U, Defs = root.Defs;
  var PX = 16;

  /* Palette anchors from the art direction. Exported so render.js and
     ui.js can tint overlays and panels in the same colours. */
  var P = {
    soil: '#6b533b', richSoil: '#4f3d2b', grass: '#5c7a3e', sand: '#c2b280',
    rock: '#5a5a62', rockFloor: '#6e6e78', water: '#2f5d78', woodFloor: '#8a6134',
    steel: '#8f97a3', blood: '#8b1a1a', night: '#0e1430', colonist: '#4a7fd4',
    raider: '#c0392b', wild: '#b08c5a', paper: '#e8e2d4', ink: '#141821',
    gold: '#ffc23c', wood: '#a9783f', flame: '#ff8c1a', sky: '#6fa8dc',
    leaf: '#3f6b33', bone: '#d8cfc0', shadow: '#2a2118'
  };

  var FACTION = {
    player: P.colonist, raider: P.raider, wild: P.wild, neutral: '#8a7f6a'
  };

  /* Faction defs may carry their own colour; the table above is the
     fallback for factions that do not, and for pawns with none. */
  function factionColor(id) {
    var d = id && Defs.maybe('faction', id);
    return (d && d.color) || FACTION[id] || FACTION.neutral;
  }

  /* ------------------------------------------------------------------
     Canvas and pixel primitives
     ------------------------------------------------------------------ */

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    c.ox = 0; c.oy = 0;
    return c;
  }

  function ctxOf(c) {
    var g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    return g;
  }

  function fill(g, x, y, w, h, c) { g.fillStyle = c; g.fillRect(x, y, w, h); }
  function dot(g, x, y, c) { g.fillStyle = c; g.fillRect(x, y, 1, 1); }

  function box(g, x, y, w, h, c) {
    g.fillStyle = c;
    g.fillRect(x, y, w, 1); g.fillRect(x, y + h - 1, w, 1);
    g.fillRect(x, y, 1, h); g.fillRect(x + w - 1, y, 1, h);
  }

  function line(g, x0, y0, x1, y1, c, t) {
    t = t || 1;
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
    var dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
    var sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx - dy;
    g.fillStyle = c;
    for (;;) {
      g.fillRect(x0, y0, t, t);
      if (x0 === x1 && y0 === y1) break;
      var e2 = err * 2;
      if (e2 > -dy) { err -= dy; x0 += sx; }
      if (e2 < dx) { err += dx; y0 += sy; }
    }
  }

  /* Filled ellipse drawn row by row, so the edge is a staircase of whole
     pixels rather than the anti-aliased curve an arc() would give. */
  function ellipse(g, cx, cy, rx, ry, c) {
    g.fillStyle = c;
    for (var y = -ry; y <= ry; y++) {
      var w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry))));
      if (w > 0) g.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2, 1);
    }
  }

  function disc(g, cx, cy, r, c) { ellipse(g, cx, cy, r, r, c); }

  function speckle(g, rnd, n, c, x, y, w, h) {
    g.fillStyle = c;
    for (var i = 0; i < n; i++) {
      g.fillRect(x + ((rnd() * w) | 0), y + ((rnd() * h) | 0), 1, 1);
    }
  }

  /* ------------------------------------------------------------------
     Colour maths
     ------------------------------------------------------------------ */

  function parse(c) {
    var n = parseInt(c.charAt(0) === '#' ? c.slice(1) : c, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function toHex(r, g, b) {
    r = U.clamp(Math.round(r), 0, 255);
    g = U.clamp(Math.round(g), 0, 255);
    b = U.clamp(Math.round(b), 0, 255);
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  var shadeMemo = {};

  /* f > 0 lightens toward white, f < 0 darkens toward black. */
  function shade(c, f) {
    var k = c + '|' + f;
    if (shadeMemo[k]) return shadeMemo[k];
    var p = parse(c), t = f < 0 ? 0 : 255, a = Math.abs(f);
    return (shadeMemo[k] = toHex(
      p[0] + (t - p[0]) * a, p[1] + (t - p[1]) * a, p[2] + (t - p[2]) * a));
  }

  function mix(a, b, t) {
    var p = parse(a), q = parse(b);
    return toHex(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t);
  }

  /* ------------------------------------------------------------------
     Deterministic per-sprite noise

     Seeded from the cache key rather than from U.rand, so the same
     sprite comes out identical in every session and drawing one never
     disturbs the simulation's random stream.
     ------------------------------------------------------------------ */
  function seeded(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* ------------------------------------------------------------------
     The sprite cache
     ------------------------------------------------------------------ */

  var cache = new Map();

  function cached(key, w, h, paint, ox, oy) {
    var c = cache.get(key);
    if (c) return c;
    c = makeCanvas(w, h);
    c.key = key;
    c.ox = ox || 0; c.oy = oy || 0;
    paint(ctxOf(c), seeded(U.hash(key)));
    cache.set(key, c);
    return c;
  }

  function rotated(src, rot) {
    if (!rot) return src;
    var w = src.width, h = src.height;
    var rw = (rot & 1) ? h : w, rh = (rot & 1) ? w : h;
    var c = makeCanvas(rw, rh), g = ctxOf(c);
    g.translate(rw / 2, rh / 2);
    g.rotate(rot * Math.PI / 2);
    g.drawImage(src, -w / 2, -h / 2);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }

  function mirrored(src) {
    var c = makeCanvas(src.width, src.height), g = ctxOf(c);
    g.translate(src.width, 0);
    g.scale(-1, 1);
    g.drawImage(src, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return c;
  }

  /* ------------------------------------------------------------------
     Terrain
     ------------------------------------------------------------------ */

  function paintTerrain(g, rnd, def, variant) {
    var c1 = def.color, c2 = def.color2 || shade(c1, 0.06);
    var dark = shade(c1, -0.18), light = shade(c2, 0.14);
    fill(g, 0, 0, PX, PX, c1);

    if (def.terrainCategory === 'water') {
      /* Two shades of water plus a bright rim, so a shoreline reads as
         water rather than as a differently coloured field. */
      for (var i = 0; i < 5; i++) {
        var wy = 1 + ((rnd() * 14) | 0), wx = ((rnd() * 11) | 0);
        fill(g, wx, wy, 3 + ((rnd() * 3) | 0), 1, c2);
      }
      speckle(g, rnd, 7, shade(c1, 0.22), 0, 0, PX, PX);
      fill(g, 0, 0, PX, 1, light);
      dot(g, 2 + ((rnd() * 12) | 0), 1, light);
      return;
    }

    switch (def.id) {
      case 'woodFloor':
        for (var py = 3; py < PX; py += 4) fill(g, 0, py, PX, 1, dark);
        fill(g, (variant & 1) ? 5 : 11, 0, 1, 4, dark);
        fill(g, (variant & 2) ? 3 : 9, 4, 1, 4, dark);
        fill(g, (variant & 1) ? 12 : 6, 8, 1, 4, dark);
        fill(g, (variant & 2) ? 8 : 2, 12, 1, 4, dark);
        speckle(g, rnd, 5, c2, 0, 0, PX, PX);
        break;
      case 'stoneFloor':
      case 'concreteFloor':
        fill(g, 7, 0, 1, PX, dark); fill(g, 0, 7, PX, 1, dark);
        fill(g, 0, 0, 7, 1, light); fill(g, 8, 8, 7, 1, light);
        speckle(g, rnd, 10, c2, 0, 0, PX, PX);
        speckle(g, rnd, 4, dark, 0, 0, PX, PX);
        break;
      case 'steelFloor':
        box(g, 0, 0, PX, PX, dark);
        fill(g, 0, 7, PX, 1, shade(c1, -0.08));
        dot(g, 2, 2, light); dot(g, 13, 2, light);
        dot(g, 2, 13, light); dot(g, 13, 13, light);
        dot(g, 2, 3, dark); dot(g, 13, 3, dark);
        speckle(g, rnd, 3, c2, 1, 1, 14, 14);
        break;
      case 'carpet':
        speckle(g, rnd, 26, c2, 0, 0, PX, PX);
        speckle(g, rnd, 10, dark, 0, 0, PX, PX);
        speckle(g, rnd, 6, light, 0, 0, PX, PX);
        break;
      case 'rockFloor':
        speckle(g, rnd, 16, c2, 0, 0, PX, PX);
        speckle(g, rnd, 7, dark, 0, 0, PX, PX);
        for (var b = 0; b < 3; b++) {
          fill(g, (rnd() * 13) | 0, (rnd() * 13) | 0, 2, 2, shade(c1, 0.1));
        }
        break;
      case 'sand':
        speckle(g, rnd, 22, c2, 0, 0, PX, PX);
        speckle(g, rnd, 6, shade(c1, -0.1), 0, 0, PX, PX);
        break;
      case 'gravel':
        for (var k = 0; k < 9; k++) {
          fill(g, (rnd() * 14) | 0, (rnd() * 14) | 0, 2, 1 + ((rnd() * 2) | 0), rnd() < 0.5 ? c2 : dark);
        }
        speckle(g, rnd, 8, light, 0, 0, PX, PX);
        break;
      case 'marsh':
        speckle(g, rnd, 12, c2, 0, 0, PX, PX);
        for (var r = 0; r < 5; r++) {
          var rx = 1 + ((rnd() * 14) | 0), ry = 3 + ((rnd() * 9) | 0);
          fill(g, rx, ry, 1, 3 + ((rnd() * 2) | 0), shade(c2, 0.2));
        }
        speckle(g, rnd, 4, shade(P.water, 0.1), 0, 0, PX, PX);
        break;
      case 'mud':
        for (var m = 0; m < 5; m++) {
          fill(g, (rnd() * 12) | 0, (rnd() * 13) | 0, 3 + ((rnd() * 2) | 0), 2, dark);
        }
        speckle(g, rnd, 10, c2, 0, 0, PX, PX);
        speckle(g, rnd, 3, shade(c2, 0.2), 0, 0, PX, PX);
        break;
      default:
        speckle(g, rnd, 14, c2, 0, 0, PX, PX);
        speckle(g, rnd, 5, dark, 0, 0, PX, PX);
        speckle(g, rnd, 3, light, 0, 0, PX, PX);
    }
  }

  /* ------------------------------------------------------------------
     Walls

     A wall sprite is a face plus edges. The 4-bit variant says which
     orthogonal neighbours are also wall, and the sprite draws a dark
     mortar edge only on the sides that are open, so a run of wall reads
     as one continuous mass instead of sixteen separate blocks.
     ------------------------------------------------------------------ */

  function wallEdges(g, mask, dark, light) {
    if (!(mask & 1)) { fill(g, 0, 0, PX, 1, light); fill(g, 0, 1, PX, 1, shade(dark, 0.1)); }
    if (!(mask & 2)) fill(g, PX - 1, 0, 1, PX, dark);
    if (!(mask & 4)) fill(g, 0, PX - 1, PX, 1, dark);
    if (!(mask & 8)) fill(g, 0, 0, 1, PX, dark);
    /* Inner corners: where two neighbours meet the mortar has to turn. */
    if ((mask & 1) && (mask & 8)) dot(g, 0, 0, dark);
    if ((mask & 1) && (mask & 2)) dot(g, PX - 1, 0, dark);
    if ((mask & 4) && (mask & 8)) dot(g, 0, PX - 1, dark);
    if ((mask & 4) && (mask & 2)) dot(g, PX - 1, PX - 1, dark);
  }

  function paintBuiltWall(g, rnd, mask, base) {
    var mid = base, dark = shade(base, -0.42), mortar = shade(base, -0.24);
    var light = shade(base, 0.16);
    fill(g, 0, 0, PX, PX, mid);
    /* Brick courses, offset every other row; the vertical joints move
       with the mask so neighbouring wall tiles never line up. */
    for (var y = 3; y < PX; y += 4) fill(g, 0, y, PX, 1, mortar);
    var off = (mask & 3) ? 2 : 0;
    for (var row = 0, ry = 0; ry < PX; ry += 4, row++) {
      var jx = ((row & 1) ? 3 : 11) + off;
      fill(g, jx % PX, ry, 1, 3, mortar);
      fill(g, (jx + 8) % PX, ry, 1, 3, mortar);
      fill(g, 0, ry, PX, 1, light);
    }
    speckle(g, rnd, 8, shade(base, 0.08), 0, 0, PX, PX);
    wallEdges(g, mask, dark, light);
  }

  function paintRockWall(g, rnd, mask, base, ore) {
    var dark = shade(base, -0.45), light = shade(base, 0.18);
    fill(g, 0, 0, PX, PX, base);
    for (var i = 0; i < 7; i++) {
      fill(g, (rnd() * 13) | 0, (rnd() * 13) | 0, 2 + ((rnd() * 2) | 0), 2, shade(base, 0.1));
    }
    speckle(g, rnd, 20, light, 0, 0, PX, PX);
    speckle(g, rnd, 16, shade(base, -0.2), 0, 0, PX, PX);
    if (ore) {
      /* Ore reads as short bright seams rather than loose dust, so a
         steel vein is obvious from a screen away. */
      for (var s = 0; s < 6; s++) {
        var ox = 2 + ((rnd() * 11) | 0), oy = 2 + ((rnd() * 11) | 0);
        if (rnd() < 0.5) fill(g, ox, oy, 2, 1, ore); else fill(g, ox, oy, 1, 2, ore);
        dot(g, ox, oy, shade(ore, 0.3));
      }
    }
    wallEdges(g, mask, dark, light);
  }

  /* ------------------------------------------------------------------
     Buildings and furniture

     Every painter takes (g, a) where `a` carries the resolved colours,
     the pixel size of the footprint and the sprite's noise generator.
     ------------------------------------------------------------------ */

  function benchTop(g, a, topCol) {
    var w = a.w, h = a.h, dk = shade(a.c1, -0.4);
    fill(g, 0, 1, w, h - 2, a.c1);
    fill(g, 0, 1, w, 2, shade(a.c1, 0.14));
    fill(g, 0, h - 3, w, 2, dk);
    box(g, 0, 1, w, h - 2, dk);
    if (topCol) fill(g, 2, 3, w - 4, h - 7, topCol);
  }

  function legs(g, a) {
    var dk = shade(a.c1, -0.5);
    fill(g, 1, a.h - 2, 2, 2, dk);
    fill(g, a.w - 3, a.h - 2, 2, 2, dk);
  }

  function dashedBox(g, w, h, c) {
    g.fillStyle = c;
    for (var x = 0; x < w; x += 3) { g.fillRect(x, 0, 2, 1); g.fillRect(x, h - 1, 2, 1); }
    for (var y = 0; y < h; y += 3) { g.fillRect(0, y, 1, 2); g.fillRect(w - 1, y, 1, 2); }
  }

  var SPRITE = {

    wall: function (g, a) { paintBuiltWall(g, a.rnd, a.variant, a.c1); },
    rockWall: function (g, a) { paintRockWall(g, a.rnd, a.variant, a.c1, null); },
    oreWall: function (g, a) { paintRockWall(g, a.rnd, a.variant, a.c1, a.c2); },

    door: function (g, a) {
      var horiz = !!(a.variant & 10), dk = shade(a.c1, -0.45), lt = shade(a.c1, 0.18);
      var jamb = shade(a.c1, -0.3);
      if (horiz) {
        fill(g, 0, 0, 2, PX, jamb); fill(g, PX - 2, 0, 2, PX, jamb);
        if (a.open) { fill(g, 2, 0, 3, PX, a.c1); fill(g, 11, 0, 3, PX, a.c1); }
        else {
          fill(g, 2, 0, 12, PX, a.c1);
          fill(g, 2, 0, 12, 1, lt); fill(g, 2, PX - 1, 12, 1, dk);
          fill(g, 7, 0, 2, PX, dk);
          dot(g, 6, 8, a.c2); dot(g, 9, 8, a.c2);
        }
      } else {
        fill(g, 0, 0, PX, 2, jamb); fill(g, 0, PX - 2, PX, 2, jamb);
        if (a.open) { fill(g, 0, 2, PX, 3, a.c1); fill(g, 0, 11, PX, 3, a.c1); }
        else {
          fill(g, 0, 2, PX, 12, a.c1);
          fill(g, 0, 2, 1, 12, lt); fill(g, PX - 1, 2, 1, 12, dk);
          fill(g, 0, 7, PX, 2, dk);
          dot(g, 8, 6, a.c2); dot(g, 8, 9, a.c2);
        }
      }
    },

    conduit: function (g, a) {
      var dk = shade(a.c1, -0.3), m = a.variant;
      if (m & 1) { fill(g, 6, 0, 4, 9, a.c1); fill(g, 7, 0, 2, 9, a.c2); }
      if (m & 4) { fill(g, 6, 7, 4, 9, a.c1); fill(g, 7, 7, 2, 9, a.c2); }
      if (m & 8) { fill(g, 0, 6, 9, 4, a.c1); fill(g, 0, 7, 9, 2, a.c2); }
      if (m & 2) { fill(g, 7, 6, 9, 4, a.c1); fill(g, 7, 7, 9, 2, a.c2); }
      fill(g, 6, 6, 4, 4, a.c1);
      fill(g, 7, 7, 2, 2, shade(a.c2, 0.2));
      dot(g, 6, 6, dk); dot(g, 9, 9, dk);
    },

    battery: function (g, a) {
      var w = a.w, h = a.h, dk = shade(a.c1, -0.4);
      fill(g, 1, 1, w - 2, h - 2, a.c1);
      box(g, 1, 1, w - 2, h - 2, dk);
      fill(g, 3, 3, w - 6, 3, shade(a.c1, 0.2));
      fill(g, 3, h - 10, w - 6, 7, shade(a.c1, -0.25));
      fill(g, 4, h - 9, w - 8, 5, a.c2);
      fill(g, 4, h - 9, w - 8, 1, shade(a.c2, 0.3));
      fill(g, 4, 7, 3, 2, P.steel); fill(g, w - 7, 7, 3, 2, P.steel);
      dot(g, 5, 8, dk);
    },

    solar: function (g, a) {
      var w = a.w, h = a.h, frame = shade(P.steel, -0.2);
      fill(g, 0, 0, w, h, frame);
      fill(g, 1, 1, w - 2, h - 2, a.c1);
      for (var cy = 0; cy < 3; cy++) {
        for (var cx = 0; cx < 3; cx++) {
          var x = 2 + cx * 15, y = 2 + cy * 15;
          fill(g, x, y, 13, 13, a.c1);
          box(g, x, y, 13, 13, shade(a.c1, 0.25));
          fill(g, x + 2, y + 2, 4, 1, a.c2);
          fill(g, x + 2, y + 3, 2, 1, a.c2);
          fill(g, x + 6, y + 6, 3, 3, shade(a.c1, -0.2));
        }
      }
      box(g, 0, 0, w, h, shade(frame, -0.3));
    },

    turbine: function (g, a) {
      var w = a.w, h = a.h, cx = w >> 1, cy = h >> 1;
      var blade = a.c1, dk = shade(a.c2, -0.35);
      /* Three blades from a central hub, drawn as pixel runs so the
         diagonals stay hard-edged. */
      var ang = [-0.35, 2.05, 3.5];
      for (var i = 0; i < 3; i++) {
        var ex = cx + Math.cos(ang[i]) * 29, ey = cy + Math.sin(ang[i]) * 13;
        line(g, cx, cy, ex | 0, ey | 0, blade, 2);
        line(g, cx, cy, (cx + (ex - cx) * 0.6) | 0, (cy + (ey - cy) * 0.6) | 0, shade(blade, 0.2), 2);
      }
      disc(g, cx, cy, 5, a.c2);
      disc(g, cx, cy, 3, shade(a.c2, 0.2));
      disc(g, cx, cy, 1, dk);
      fill(g, cx - 1, cy + 5, 3, h - cy - 6, dk);
    },

    generator: function (g, a) {
      var w = a.w, h = a.h, dk = shade(a.c1, -0.4);
      fill(g, 1, 2, w - 2, h - 4, a.c1);
      box(g, 1, 2, w - 2, h - 4, dk);
      fill(g, 2, 3, w - 4, 2, shade(a.c1, 0.18));
      fill(g, 3, 6, 9, 6, shade(a.c1, -0.25));
      fill(g, 4, 7, 7, 4, a.c2);
      fill(g, 5, 8, 5, 2, shade(a.c2, 0.3));
      fill(g, w - 8, 4, 4, 4, P.steel);
      fill(g, w - 7, 5, 2, 2, shade(P.steel, -0.4));
      fill(g, w - 6, 9, 3, 4, dk);
    },

    heater: function (g, a) {
      var dk = shade(P.steel, -0.45);
      fill(g, 1, 2, 14, 12, a.c1);
      box(g, 1, 2, 14, 12, dk);
      fill(g, 2, 3, 12, 2, shade(a.c1, 0.2));
      for (var y = 6; y < 13; y += 2) fill(g, 3, y, 10, 1, a.c2);
      fill(g, 3, 6, 10, 1, shade(a.c2, 0.3));
      dot(g, 13, 4, P.gold);
    },

    cooler: function (g, a) {
      var dk = shade(P.steel, -0.45);
      fill(g, 1, 2, 14, 12, a.c1);
      box(g, 1, 2, 14, 12, dk);
      fill(g, 2, 3, 12, 2, shade(a.c1, 0.2));
      for (var x = 3; x < 13; x += 2) fill(g, x, 6, 1, 7, a.c2);
      fill(g, 3, 12, 10, 1, shade(a.c2, -0.2));
      dot(g, 13, 4, P.sky);
    },

    lamp: function (g, a) {
      var dk = shade(a.c1, -0.4);
      fill(g, 6, 9, 4, 5, a.c1);
      fill(g, 5, 13, 6, 2, dk);
      if (a.lit) {
        disc(g, 8, 6, 5, shade(a.c2, -0.25));
        disc(g, 8, 6, 4, a.c2);
        disc(g, 8, 6, 2, shade(a.c2, 0.45));
      } else {
        disc(g, 8, 6, 5, shade(P.steel, -0.3));
        disc(g, 8, 6, 3, shade(P.steel, 0.05));
      }
      box(g, 6, 9, 4, 4, dk);
    },

    turret: function (g, a) {
      var dk = shade(a.c1, -0.5);
      disc(g, 8, 9, 6, shade(a.c1, -0.2));
      disc(g, 8, 9, 5, a.c1);
      box(g, 3, 12, 11, 3, dk);
      fill(g, 5, 5, 6, 7, shade(a.c1, 0.12));
      box(g, 5, 5, 6, 7, dk);
      fill(g, 7, 0, 2, 6, a.c2);
      fill(g, 6, 1, 4, 2, shade(a.c2, 0.25));
      dot(g, 8, 0, P.gold);
    },

    trap: function (g, a) {
      var dk = shade(a.c1, -0.4);
      fill(g, 1, 1, 14, 14, a.c1);
      box(g, 1, 1, 14, 14, dk);
      line(g, 2, 2, 13, 13, dk, 1);
      line(g, 13, 2, 2, 13, dk, 1);
      for (var i = 0; i < 4; i++) {
        var sx = 3 + (i & 1) * 8, sy = 3 + (i >> 1) * 8;
        line(g, sx, sy + 3, sx + 2, sy, a.c2, 1);
        line(g, sx + 2, sy, sx + 4, sy + 3, shade(a.c2, -0.25), 1);
      }
    },

    sandbags: function (g, a) {
      var dk = shade(a.c1, -0.35), lt = shade(a.c1, 0.16);
      for (var row = 0; row < 3; row++) {
        var y = 2 + row * 5, off = (row & 1) ? 3 : 0;
        for (var x = -3 + off; x < PX; x += 6) {
          ellipse(g, x + 3, y + 2, 3, 2, a.c2);
          ellipse(g, x + 3, y + 1, 3, 1, a.c1);
          fill(g, x + 1, y, 4, 1, lt);
          dot(g, x, y + 2, dk); dot(g, x + 6, y + 2, dk);
        }
      }
    },

    grave: function (g, a) {
      var w = a.w, h = a.h, dk = shade(a.c1, -0.35);
      fill(g, 1, 1, w - 2, h - 2, a.c1);
      box(g, 1, 1, w - 2, h - 2, dk);
      fill(g, 3, 5, w - 6, h - 8, shade(a.c1, -0.18));
      speckle(g, a.rnd, 12, shade(a.c1, 0.12), 3, 5, w - 6, h - 8);
      fill(g, 4, 2, w - 8, 4, a.c2);
      fill(g, 5, 3, w - 10, 1, shade(a.c2, 0.25));
      fill(g, 6, 4, 1, 1, shade(a.c2, -0.4));
      fill(g, 7, 3, 3, 1, shade(a.c2, -0.4));
    },

    sculpture: function (g, a) {
      var dk = shade(a.c1, -0.4);
      fill(g, 3, 12, 10, 3, a.c2);
      fill(g, 3, 12, 10, 1, shade(a.c2, 0.25));
      ellipse(g, 8, 8, 4, 5, a.c1);
      ellipse(g, 8, 7, 2, 3, shade(a.c1, 0.2));
      fill(g, 6, 2, 2, 5, a.c1);
      fill(g, 9, 3, 2, 4, shade(a.c1, -0.15));
      dot(g, 7, 1, shade(a.c1, 0.3));
      box(g, 3, 12, 10, 3, dk);
    },

    bed: function (g, a) {
      var w = a.w, h = a.h, dk = shade(a.c1, -0.42);
      fill(g, 0, 0, w, h, a.c1);
      box(g, 0, 0, w, h, dk);
      fill(g, 1, 1, w - 2, 1, shade(a.c1, 0.2));
      fill(g, 2, 2, w - 4, 7, P.paper);
      fill(g, 2, 2, w - 4, 1, shade(P.paper, 0.1));
      fill(g, 2, 8, w - 4, 1, shade(P.paper, -0.18));
      fill(g, 2, 9, w - 4, h - 11, a.c2);
      fill(g, 2, 13, w - 4, 1, shade(a.c2, -0.15));
      fill(g, 2, 20, w - 4, 1, shade(a.c2, -0.15));
      fill(g, 2, h - 3, w - 4, 1, shade(a.c2, 0.18));
    },

    spot: function (g, a) {
      dashedBox(g, a.w, a.h, a.c1);
      if (a.def.id === 'sleepingSpot') {
        fill(g, 4, 4, 8, 8, a.c2);
        fill(g, 4, 4, 8, 2, shade(a.c2, 0.2));
        fill(g, 5, 7, 6, 1, shade(a.c2, -0.25));
      } else {
        line(g, 4, 11, 11, 4, a.c2, 1);
        line(g, 4, 4, 11, 11, shade(a.c2, -0.25), 1);
        dot(g, 8, 8, shade(a.c2, 0.3));
      }
    },

    table: function (g, a) {
      var w = a.w, h = a.h, dk = shade(a.c1, -0.42);
      fill(g, 1, 1, w - 2, h - 2, a.c1);
      box(g, 1, 1, w - 2, h - 2, dk);
      fill(g, 2, 2, w - 4, 1, shade(a.c1, 0.18));
      fill(g, 1, (h >> 1) - 1, w - 2, 1, a.c2);
      speckle(g, a.rnd, 8, shade(a.c1, -0.12), 2, 2, w - 4, h - 4);
      fill(g, 2, h - 3, w - 4, 1, shade(a.c1, -0.2));
    },

    stool: function (g, a) {
      var dk = shade(a.c1, -0.42);
      disc(g, 8, 8, 5, a.c1);
      disc(g, 8, 8, 4, shade(a.c1, 0.14));
      disc(g, 8, 8, 2, a.c2);
      dot(g, 3, 8, dk); dot(g, 13, 8, dk); dot(g, 8, 3, dk); dot(g, 8, 13, dk);
    },

    dresser: function (g, a) {
      var dk = shade(a.c1, -0.42);
      fill(g, 1, 2, 14, 12, a.c1);
      box(g, 1, 2, 14, 12, dk);
      fill(g, 2, 3, 12, 1, shade(a.c1, 0.2));
      fill(g, 2, 7, 12, 1, dk);
      fill(g, 2, 11, 12, 1, dk);
      fill(g, 6, 5, 4, 1, a.c2);
      fill(g, 6, 9, 4, 1, a.c2);
      fill(g, 6, 12, 4, 1, a.c2);
    },

    campfire: function (g, a) {
      var stone = shade(P.rock, 0.05);
      for (var i = 0; i < 8; i++) {
        var ang = i * 0.7853981633974483;
        fill(g, (8 + Math.cos(ang) * 6) | 0, (8 + Math.sin(ang) * 6) | 0, 2, 2, stone);
      }
      line(g, 4, 11, 12, 6, a.c1, 2);
      line(g, 4, 6, 12, 11, shade(a.c1, -0.2), 2);
      flame(g, 8, 9, a.frame || 0, 4);
    },

    stove: function (g, a) {
      var w = a.w, dk = shade(a.c1, -0.45);
      fill(g, 1, 2, w - 2, 12, a.c1);
      box(g, 1, 2, w - 2, 12, dk);
      fill(g, 2, 3, w - 4, 2, shade(a.c1, 0.2));
      disc(g, 8, 9, 3, shade(a.c1, -0.35));
      disc(g, 8, 9, 2, shade(a.c1, -0.5));
      disc(g, w - 9, 9, 3, shade(a.c1, -0.35));
      disc(g, w - 9, 9, 2, a.c2);
      fill(g, w - 5, 4, 3, 2, a.c2);
      dot(g, w - 4, 4, shade(a.c2, 0.4));
    },

    butcher: function (g, a) {
      benchTop(g, a, shade(a.c1, -0.18));
      fill(g, 3, 5, a.w - 6, 5, P.bone);
      speckle(g, a.rnd, 9, a.c2, 3, 5, a.w - 6, 5);
      line(g, a.w - 10, 4, a.w - 5, 9, P.steel, 2);
      fill(g, a.w - 6, 9, 3, 2, shade(P.woodFloor, -0.2));
      legs(g, a);
    },

    stonecutter: function (g, a) {
      benchTop(g, a, shade(a.c1, -0.18));
      fill(g, 4, 4, 7, 7, a.c2);
      fill(g, 4, 4, 7, 1, shade(a.c2, 0.22));
      fill(g, 4, 10, 7, 1, shade(a.c2, -0.25));
      line(g, a.w - 9, 4, a.w - 4, 9, P.steel, 1);
      fill(g, a.w - 5, 8, 3, 3, shade(P.woodFloor, -0.2));
      speckle(g, a.rnd, 7, shade(a.c2, 0.25), 2, 3, a.w - 4, a.h - 7);
      legs(g, a);
    },

    tailor: function (g, a) {
      benchTop(g, a, shade(a.c1, -0.18));
      fill(g, 3, 4, 8, 7, a.c2);
      fill(g, 3, 4, 8, 1, shade(a.c2, 0.18));
      fill(g, 3, 7, 8, 1, shade(a.c2, -0.2));
      fill(g, a.w - 9, 4, 5, 5, shade(P.steel, -0.1));
      line(g, a.w - 8, 9, a.w - 5, 5, P.steel, 1);
      dot(g, a.w - 8, 10, P.gold);
      legs(g, a);
    },

    smithy: function (g, a) {
      var dk = shade(a.c1, -0.45);
      fill(g, 0, 2, a.w, a.h - 4, shade(a.c1, -0.15));
      box(g, 0, 2, a.w, a.h - 4, dk);
      fill(g, 2, 4, 9, 6, a.c1);
      fill(g, 3, 3, 7, 2, shade(a.c1, 0.18));
      fill(g, 5, 10, 3, 3, dk);
      disc(g, a.w - 7, 8, 4, shade(a.c2, -0.4));
      disc(g, a.w - 7, 8, 3, a.c2);
      disc(g, a.w - 7, 8, 1, shade(a.c2, 0.4));
      legs(g, a);
    },

    research: function (g, a) {
      benchTop(g, a, shade(a.c1, -0.18));
      fill(g, 3, 3, 10, 7, shade(P.ink, 0.18));
      box(g, 3, 3, 10, 7, shade(P.steel, -0.2));
      fill(g, 4, 4, 8, 5, a.c2);
      fill(g, 5, 5, 3, 1, shade(a.c2, 0.4));
      fill(g, 5, 7, 5, 1, shade(a.c2, 0.4));
      fill(g, a.w - 10, 4, 7, 6, P.paper);
      fill(g, a.w - 9, 6, 5, 1, shade(P.ink, 0.4));
      fill(g, a.w - 9, 8, 4, 1, shade(P.ink, 0.4));
      legs(g, a);
    },

    box: function (g, a) {
      var dk = shade(a.c1, -0.42);
      fill(g, 1, 1, 14, 14, a.c1);
      box(g, 1, 1, 14, 14, dk);
      fill(g, 2, 2, 12, 1, shade(a.c1, 0.2));
      fill(g, 1, 7, 14, 1, dk);
      fill(g, 7, 1, 1, 14, dk);
    },

    blueprint: function (g, a) {
      var c = a.c1;
      dashedBox(g, a.w, a.h, c);
      fill(g, 0, 0, 3, 1, c); fill(g, 0, 0, 1, 3, c);
      fill(g, a.w - 3, 0, 3, 1, c); fill(g, a.w - 1, 0, 1, 3, c);
      fill(g, 0, a.h - 1, 3, 1, c); fill(g, 0, a.h - 3, 1, 3, c);
      fill(g, a.w - 3, a.h - 1, 3, 1, c); fill(g, a.w - 1, a.h - 3, 1, 3, c);
      for (var d = -a.h; d < a.w; d += 6) line(g, d, a.h - 1, d + a.h, -1, shade(c, -0.25), 1);
    },

    frame: function (g, a) {
      var dk = shade(a.c1, -0.4);
      box(g, 0, 0, a.w, a.h, a.c1);
      box(g, 1, 1, a.w - 2, a.h - 2, dk);
      line(g, 1, 1, a.w - 2, a.h - 2, a.c2, 1);
      line(g, a.w - 2, 1, 1, a.h - 2, a.c2, 1);
      fill(g, 0, 0, 2, 2, a.c1); fill(g, a.w - 2, 0, 2, 2, a.c1);
      fill(g, 0, a.h - 2, 2, 2, a.c1); fill(g, a.w - 2, a.h - 2, 2, 2, a.c1);
    },

    /* Laid on its side, head to the left. A dead muffalo must not read
       as a dead colonist, so the animal kinds keep their own silhouette
       and colour, drained toward grey. */
    corpse: function (g, a) {
      var an = a.kindId && ANIMAL[a.kindId];
      if (an) {
        var body = mix(an.body, P.rock, 0.4), belly = mix(an.belly, P.rock, 0.4);
        ellipse(g, 9, 9, 5, 3, body);
        ellipse(g, 9, 10, 4, 1, belly);
        ellipse(g, 3, 8, 2, 2, body);
        fill(g, 1, 7, 2, 1, belly);
        fill(g, 6, 12, 2, 3, shade(body, -0.35));
        fill(g, 11, 12, 2, 3, shade(body, -0.35));
        if (an.tail) fill(g, 14, 8, an.tail > 2 ? 2 : 1, 2, body);
      } else {
        var skin = shade('#c89868', -0.3), cloth = mix(P.wild, P.rock, 0.35);
        ellipse(g, 4, 8, 2, 2, skin);
        ellipse(g, 9, 8, 4, 3, cloth);
        fill(g, 12, 6, 3, 2, cloth);
        fill(g, 12, 9, 3, 2, cloth);
        dot(g, 3, 7, shade(skin, -0.4));
      }
      speckle(g, a.rnd, 6, a.c1, 2, 5, 12, 8);
    },

    /* ---------- items ---------- */

    item: function (g, a) {
      fill(g, 4, 5, 8, 7, a.c1);
      fill(g, 4, 5, 8, 1, shade(a.c1, 0.2));
      fill(g, 4, 11, 8, 1, shade(a.c1, -0.3));
      box(g, 4, 5, 8, 7, shade(a.c1, -0.45));
      fill(g, 6, 4, 4, 2, shade(a.c1, -0.2));
    },

    log: function (g, a) {
      var dk = shade(a.c1, -0.4);
      for (var i = 0; i < 3; i++) {
        var y = 4 + i * 3, x = 2 + (i & 1);
        fill(g, x, y, 12, 3, a.c1);
        fill(g, x, y, 12, 1, shade(a.c1, 0.16));
        box(g, x, y, 12, 3, dk);
        fill(g, x + 1, y + 1, 2, 1, a.c2);
      }
    },

    ingot: function (g, a) {
      var dk = shade(a.c1, -0.45);
      fill(g, 3, 9, 11, 4, a.c1); fill(g, 3, 9, 11, 1, a.c2); box(g, 3, 9, 11, 4, dk);
      fill(g, 4, 6, 9, 3, a.c1); fill(g, 4, 6, 9, 1, a.c2); box(g, 4, 6, 9, 3, dk);
      fill(g, 5, 3, 7, 3, a.c1); fill(g, 5, 3, 7, 1, a.c2); box(g, 5, 3, 7, 3, dk);
    },

    component: function (g, a) {
      var dk = shade(a.c1, -0.45);
      fill(g, 3, 4, 10, 9, a.c1);
      box(g, 3, 4, 10, 9, dk);
      fill(g, 5, 6, 6, 3, shade(a.c1, -0.25));
      line(g, 4, 11, 12, 11, a.c2, 1);
      line(g, 4, 5, 4, 11, a.c2, 1);
      dot(g, 11, 6, a.c2); dot(g, 11, 8, a.c2);
      for (var i = 0; i < 4; i++) dot(g, 5 + i * 2, 13, shade(a.c2, -0.2));
    },

    coin: function (g, a) {
      var dk = shade(a.c2, -0.3);
      disc(g, 6, 9, 3, a.c1); disc(g, 6, 8, 2, a.c2);
      disc(g, 10, 10, 3, a.c1); disc(g, 10, 9, 2, a.c2);
      disc(g, 8, 5, 3, a.c1); disc(g, 8, 4, 2, shade(a.c1, 0.2));
      dot(g, 8, 4, dk);
    },

    chunk: function (g, a) {
      var dk = shade(a.c1, -0.4);
      ellipse(g, 8, 9, 6, 4, a.c1);
      ellipse(g, 7, 7, 4, 3, shade(a.c1, 0.14));
      speckle(g, a.rnd, 9, a.c2, 3, 5, 10, 8);
      speckle(g, a.rnd, 5, dk, 3, 5, 10, 8);
      fill(g, 3, 11, 10, 1, dk);
    },

    block: function (g, a) {
      var dk = shade(a.c1, -0.42);
      fill(g, 2, 8, 12, 5, a.c1); fill(g, 2, 8, 12, 1, shade(a.c1, 0.18));
      box(g, 2, 8, 12, 5, dk); fill(g, 8, 8, 1, 5, dk);
      fill(g, 4, 3, 8, 5, a.c1); fill(g, 4, 3, 8, 1, shade(a.c1, 0.18));
      box(g, 4, 3, 8, 5, dk);
      speckle(g, a.rnd, 5, a.c2, 3, 4, 10, 8);
    },

    cloth: function (g, a) {
      var dk = shade(a.c1, -0.3);
      fill(g, 2, 4, 12, 8, a.c1);
      fill(g, 2, 4, 12, 1, shade(a.c1, 0.16));
      box(g, 2, 4, 12, 8, dk);
      fill(g, 2, 7, 12, 1, a.c2);
      fill(g, 2, 10, 12, 1, a.c2);
      fill(g, 5, 4, 1, 8, shade(a.c1, -0.12));
      fill(g, 10, 4, 1, 8, shade(a.c1, -0.12));
    },

    herb: function (g, a) {
      var dk = shade(a.c1, -0.3);
      fill(g, 7, 6, 2, 8, shade(a.c1, -0.4));
      for (var i = 0; i < 5; i++) {
        var side = (i & 1) ? 1 : -1, y = 3 + i * 2;
        ellipse(g, 8 + side * 3, y, 3, 1, i % 2 ? a.c1 : a.c2);
      }
      ellipse(g, 8, 2, 2, 2, a.c2);
      fill(g, 5, 11, 6, 1, dk);
    },

    medkit: function (g, a) {
      var dk = shade(a.c1, -0.35);
      fill(g, 2, 4, 12, 9, a.c1);
      box(g, 2, 4, 12, 9, dk);
      fill(g, 2, 4, 12, 1, shade(a.c1, 0.1));
      fill(g, 7, 6, 3, 6, a.c2);
      fill(g, 5, 8, 7, 2, a.c2);
      fill(g, 6, 3, 4, 1, dk);
    },

    barrel: function (g, a) {
      var dk = shade(a.c1, -0.45);
      fill(g, 3, 2, 10, 12, a.c1);
      box(g, 3, 2, 10, 12, dk);
      fill(g, 4, 3, 3, 10, shade(a.c1, 0.18));
      fill(g, 3, 5, 10, 1, a.c2);
      fill(g, 3, 10, 10, 1, a.c2);
      fill(g, 6, 1, 4, 2, shade(P.steel, -0.2));
    },

    grain: function (g, a) {
      ellipse(g, 8, 10, 6, 3, a.c2);
      ellipse(g, 8, 9, 5, 2, a.c1);
      for (var i = 0; i < 10; i++) {
        var gx = 3 + ((a.rnd() * 10) | 0), gy = 6 + ((a.rnd() * 6) | 0);
        fill(g, gx, gy, 2, 1, i % 3 ? a.c1 : shade(a.c1, 0.2));
      }
      fill(g, 5, 4, 1, 3, shade(a.c2, -0.2));
      fill(g, 9, 3, 1, 4, shade(a.c2, -0.2));
    },

    root: function (g, a) {
      ellipse(g, 6, 7, 3, 3, a.c1);
      ellipse(g, 10, 10, 3, 2, a.c1);
      ellipse(g, 10, 5, 2, 2, shade(a.c1, 0.12));
      speckle(g, a.rnd, 7, a.c2, 3, 3, 10, 9);
      dot(g, 5, 6, shade(a.c2, -0.2)); dot(g, 11, 10, shade(a.c2, -0.2));
    },

    corn: function (g, a) {
      for (var i = 0; i < 2; i++) {
        var x = 4 + i * 5, y = 3 + i;
        ellipse(g, x, y + 5, 2, 5, a.c1);
        for (var k = 0; k < 4; k++) fill(g, x - 1, y + 2 + k * 2, 3, 1, a.c2);
        fill(g, x, y - 1, 1, 2, shade(a.c2, -0.1));
      }
      line(g, 2, 13, 13, 11, shade(P.grass, -0.1), 1);
    },

    berry: function (g, a) {
      var pts = [[5, 6], [9, 5], [11, 9], [7, 10], [4, 11]];
      for (var i = 0; i < pts.length; i++) {
        disc(g, pts[i][0], pts[i][1], 2, a.c1);
        dot(g, pts[i][0] - 1, pts[i][1] - 1, a.c2);
      }
      dot(g, 9, 3, shade(P.grass, -0.1));
    },

    meat: function (g, a) {
      ellipse(g, 8, 9, 6, 4, a.c1);
      ellipse(g, 8, 8, 5, 3, shade(a.c1, 0.1));
      for (var i = 0; i < 4; i++) line(g, 4 + i * 2, 6, 5 + i * 2, 11, a.c2, 1);
      fill(g, 3, 10, 3, 1, shade(a.c2, -0.2));
      ellipse(g, 8, 5, 3, 1, P.bone);
    },

    meal: function (g, a) {
      var dk = shade(P.paper, -0.35);
      ellipse(g, 8, 9, 7, 5, P.paper);
      ellipse(g, 8, 9, 5, 3, shade(P.paper, -0.12));
      ellipse(g, 7, 8, 3, 2, a.c1);
      ellipse(g, 10, 10, 2, 1, a.c2);
      dot(g, 6, 10, a.c2);
      ellipse(g, 8, 13, 7, 1, dk);
    },

    kibble: function (g, a) {
      ellipse(g, 8, 10, 6, 3, a.c2);
      for (var i = 0; i < 14; i++) {
        fill(g, 2 + ((a.rnd() * 12) | 0), 5 + ((a.rnd() * 7) | 0), 2, 1,
          i % 3 ? a.c1 : shade(a.c1, 0.18));
      }
    },

    /* ---------- weapons ---------- */

    knife: function (g, a) {
      line(g, 5, 11, 11, 4, a.c1, 2);
      line(g, 6, 11, 11, 5, shade(a.c1, 0.3), 1);
      line(g, 3, 13, 6, 10, a.c2, 2);
      dot(g, 11, 3, shade(a.c1, 0.4));
    },

    club: function (g, a) {
      line(g, 3, 13, 10, 5, a.c1, 2);
      ellipse(g, 11, 4, 3, 3, a.c2);
      ellipse(g, 11, 4, 2, 2, shade(a.c2, 0.2));
      fill(g, 3, 12, 2, 3, shade(a.c1, -0.3));
    },

    spear: function (g, a) {
      line(g, 2, 14, 12, 4, a.c1, 1);
      line(g, 3, 14, 13, 4, shade(a.c1, -0.2), 1);
      line(g, 11, 5, 14, 2, a.c2, 2);
      dot(g, 14, 1, shade(a.c2, 0.35));
      fill(g, 6, 8, 2, 2, shade(a.c1, -0.4));
    },

    bow: function (g, a) {
      for (var y = 2; y <= 13; y++) {
        var t = (y - 7.5) / 5.5;
        fill(g, 4 + Math.round(t * t * 4), y, 2, 1, a.c1);
      }
      line(g, 5, 2, 5, 13, a.c2, 1);
      line(g, 5, 8, 12, 8, shade(a.c2, -0.2), 1);
      fill(g, 12, 7, 2, 2, shade(a.c1, -0.3));
    },

    gun: function (g, a) {
      fill(g, 3, 6, 10, 3, a.c1);
      fill(g, 3, 6, 10, 1, shade(a.c1, 0.2));
      fill(g, 11, 7, 4, 2, a.c2);
      fill(g, 4, 9, 3, 5, a.c2);
      fill(g, 5, 9, 2, 4, shade(a.c2, 0.18));
      dot(g, 8, 9, shade(a.c2, -0.2));
    },

    rifle: function (g, a) {
      line(g, 1, 13, 14, 3, a.c1, 2);
      line(g, 2, 13, 14, 4, shade(a.c1, 0.15), 1);
      line(g, 1, 14, 5, 11, a.c2, 2);
      fill(g, 6, 9, 3, 3, a.c2);
      dot(g, 13, 2, shade(a.c1, 0.35));
    },

    shotgun: function (g, a) {
      line(g, 1, 13, 14, 3, a.c1, 2);
      line(g, 2, 14, 15, 4, a.c1, 2);
      line(g, 1, 14, 5, 11, a.c2, 2);
      fill(g, 7, 8, 4, 3, shade(a.c2, 0.1));
      dot(g, 13, 2, shade(a.c1, 0.35));
    },

    /* ---------- apparel ---------- */

    shirt: function (g, a) {
      var dk = shade(a.c1, -0.3);
      fill(g, 5, 4, 6, 9, a.c1);
      fill(g, 2, 4, 3, 4, a.c1); fill(g, 11, 4, 3, 4, a.c1);
      fill(g, 6, 3, 4, 2, a.c2);
      box(g, 5, 4, 6, 9, dk);
      fill(g, 7, 6, 2, 6, shade(a.c1, -0.12));
    },

    pants: function (g, a) {
      var dk = shade(a.c1, -0.3);
      fill(g, 4, 3, 8, 4, a.c1);
      fill(g, 4, 7, 3, 7, a.c1); fill(g, 9, 7, 3, 7, a.c1);
      fill(g, 4, 3, 8, 1, a.c2);
      box(g, 4, 3, 8, 4, dk);
      fill(g, 7, 7, 2, 7, shade(a.c1, -0.35));
    },

    jacket: function (g, a) {
      var dk = shade(a.c1, -0.32);
      fill(g, 5, 3, 6, 10, a.c1);
      fill(g, 2, 3, 3, 8, a.c1); fill(g, 11, 3, 3, 8, a.c1);
      fill(g, 5, 2, 6, 2, a.c2);
      fill(g, 7, 4, 2, 9, shade(a.c1, -0.2));
      box(g, 5, 3, 6, 10, dk);
      dot(g, 8, 6, P.gold); dot(g, 8, 9, P.gold);
    },

    parka: function (g, a) {
      var dk = shade(a.c1, -0.32);
      fill(g, 4, 4, 8, 10, a.c1);
      fill(g, 1, 4, 3, 8, a.c1); fill(g, 12, 4, 3, 8, a.c1);
      ellipse(g, 8, 3, 4, 2, a.c2);
      ellipse(g, 8, 3, 3, 1, shade(a.c2, 0.2));
      fill(g, 7, 5, 2, 9, shade(a.c1, -0.2));
      fill(g, 4, 13, 8, 1, a.c2);
      box(g, 4, 4, 8, 10, dk);
    },

    vest: function (g, a) {
      var dk = shade(a.c1, -0.35);
      fill(g, 4, 4, 8, 9, a.c1);
      fill(g, 4, 4, 8, 1, shade(a.c1, 0.18));
      box(g, 4, 4, 8, 9, dk);
      fill(g, 6, 4, 1, 9, a.c2); fill(g, 9, 4, 1, 9, a.c2);
      fill(g, 4, 8, 8, 1, shade(a.c1, -0.2));
      fill(g, 3, 5, 1, 5, dk); fill(g, 12, 5, 1, 5, dk);
    },

    helmet: function (g, a) {
      var dk = shade(a.c1, -0.4);
      ellipse(g, 8, 8, 6, 5, a.c1);
      ellipse(g, 8, 6, 5, 3, shade(a.c1, 0.16));
      fill(g, 2, 9, 12, 2, a.c2);
      box(g, 2, 9, 12, 2, dk);
      dot(g, 6, 5, shade(a.c1, 0.3));
    },

    /* ---------- effects as things ---------- */

    fire: function (g, a) { flame(g, 8, 10, a.frame || 0, 6); },

    filth: function (g, a) { paintBlood(g, a.rnd, a.c1, a.c2); },

    bullet: function (g, a) {
      fill(g, 7, 5, 2, 5, a.c1);
      fill(g, 7, 4, 2, 1, shade(a.c1, 0.35));
      fill(g, 7, 10, 2, 3, a.c2);
      dot(g, 6, 12, shade(a.c2, -0.3)); dot(g, 9, 12, shade(a.c2, -0.3));
    },

    arrow: function (g, a) {
      line(g, 8, 2, 8, 13, a.c1, 1);
      line(g, 8, 1, 6, 5, a.c2, 1); line(g, 8, 1, 10, 5, a.c2, 1);
      line(g, 8, 11, 6, 15, P.paper, 1); line(g, 8, 11, 10, 15, P.paper, 1);
    }
  };

  /* ------------------------------------------------------------------
     Plants
     ------------------------------------------------------------------ */

  function paintGrass(g, rnd, def, stage, variant) {
    var c1 = def.color, c2 = def.color2 || shade(c1, 0.12);
    var tall = def.id === 'tallGrass';
    var n = tall ? 9 : 7, maxH = (tall ? 9 : 6) * (0.55 + stage * 0.22);
    for (var i = 0; i < n; i++) {
      var x = 1 + ((rnd() * 14) | 0), base = 6 + ((rnd() * 9) | 0);
      var h = 2 + ((rnd() * maxH) | 0);
      var top = Math.max(0, base - h);
      fill(g, x, top, 1, base - top, i % 3 ? c1 : c2);
      if (h > 4) dot(g, x + (variant & 1 ? 1 : -1), top, shade(c2, 0.12));
    }
  }

  function paintBush(g, rnd, def, stage, ripe) {
    var c1 = def.color, c2 = def.color2 || shade(c1, 0.15);
    var r = [2, 4, 5][stage];
    var blobs = [[8, 8, r], [5, 10, r - 1], [11, 9, r - 1], [8, 5, r - 1]];
    for (var i = 0; i < blobs.length; i++) {
      if (blobs[i][2] <= 0) continue;
      disc(g, blobs[i][0], blobs[i][1], blobs[i][2], i ? shade(c1, -0.08) : c1);
    }
    speckle(g, rnd, 6 + stage * 3, shade(c1, 0.16), 3, 3, 11, 11);
    if (def.id === 'healroot') {
      for (var k = 0; k < 4; k++) dot(g, 4 + ((rnd() * 9) | 0), 3 + ((rnd() * 9) | 0), c2);
      fill(g, 7, 12, 2, 3, shade(c1, -0.35));
    } else if (ripe) {
      for (var b = 0; b < 6; b++) {
        var bx = 3 + ((rnd() * 10) | 0), by = 3 + ((rnd() * 10) | 0);
        fill(g, bx, by, 2, 2, c2);
        dot(g, bx, by, shade(c2, 0.35));
      }
    }
  }

  /* Trees overhang their tile. The canvas is 2x2 tiles placed at
     ox/oy = -8, so the tile the tree actually occupies is canvas
     x 8..23, y 8..23 - which is where the trunk has to land. */
  function paintTree(g, rnd, def, stage) {
    var leaf = def.color, bark = def.color2 || '#5a4227';
    var pine = def.id === 'treePine';
    var scale = [0.45, 0.72, 1][stage];
    var cx = 16, base = 23;
    var top = base - Math.round((pine ? 9 : 12) * scale);
    fill(g, cx - 2, top, 4, base - top + 1, bark);
    fill(g, cx - 2, top, 1, base - top + 1, shade(bark, 0.18));
    fill(g, cx + 1, top, 1, base - top + 1, shade(bark, -0.25));

    if (pine) {
      var th = Math.max(3, Math.round(7 * scale));
      for (var t = 0; t < 3; t++) {
        var ty = base - 3 - t * Math.round(5 * scale);
        var tw = Math.max(2, Math.round((11 - t * 3) * scale));
        for (var row = 0; row < th; row++) {
          var hw = Math.max(1, Math.round(tw * (1 - row / th)));
          fill(g, cx - hw, ty - row, hw * 2, 1, row > th - 3 ? shade(leaf, 0.14) : leaf);
        }
      }
      speckle(g, rnd, 10, shade(leaf, -0.2), cx - 8, base - 20, 16, 18);
    } else {
      var r = Math.max(4, Math.round(10 * scale));
      var cy = base - 2 - r;
      ellipse(g, cx, cy, r, Math.round(r * 0.95), leaf);
      ellipse(g, cx - Math.round(r * 0.35), cy - Math.round(r * 0.35),
        Math.round(r * 0.55), Math.round(r * 0.45), shade(leaf, 0.14));
      speckle(g, rnd, 20, shade(leaf, -0.18), cx - r, cy - r, r * 2, r * 2);
      speckle(g, rnd, 10, shade(leaf, 0.22), cx - r, cy - r, r * 2, r * 2);
    }
  }

  function paintCrop(g, rnd, def, stage) {
    var c1 = def.color, c2 = def.color2 || shade(c1, 0.2);
    var h = [3, 7, 11][stage];
    var stalks = stage === 0 ? 3 : 5;
    for (var i = 0; i < stalks; i++) {
      var x = 3 + i * 2 + ((rnd() * 2) | 0), base = 14 - ((rnd() * 2) | 0);
      var top = base - h + ((rnd() * 2) | 0);
      fill(g, x, top, 1, base - top, c1);
      if (stage > 0) {
        dot(g, x - 1, top + 2, shade(c1, -0.12));
        dot(g, x + 1, top + 4, shade(c1, -0.12));
      }
      if (stage === 2) {
        if (def.id === 'plantCorn') fill(g, x, top, 1, 3, c2);
        else if (def.id === 'plantCotton') fill(g, x - 1, top - 1, 3, 2, c2);
        else if (def.id === 'plantPotato') dot(g, x, base - 1, c2);
        else fill(g, x, top - 1, 1, 2, c2);
      }
    }
    if (stage === 2 && def.id === 'plantPotato') {
      ellipse(g, 8, 14, 4, 1, shade(c2, -0.15));
    }
  }

  /* ------------------------------------------------------------------
     Effects
     ------------------------------------------------------------------ */

  function flame(g, cx, cy, frame, size) {
    var lean = [0, 1, -1][frame % 3];
    var hot = '#ffd23c', mid = P.flame, cool = '#c0392b';
    for (var i = 0; i < size; i++) {
      var w = Math.max(1, size - i - (i > size - 3 ? 1 : 0));
      var x = cx - (w >> 1) + Math.round(lean * i / size);
      fill(g, x, cy - i, w, 1, i < size * 0.3 ? cool : (i < size * 0.7 ? mid : hot));
    }
    dot(g, cx + lean, cy - size, hot);
    dot(g, cx - 1 + lean, cy - size + 1, hot);
    fill(g, cx - (size >> 1), cy, size, 1, shade(cool, -0.25));
  }

  function paintBlood(g, rnd, c1, c2) {
    var dark = c2 || shade(c1, -0.3);
    ellipse(g, 6 + ((rnd() * 4) | 0), 7 + ((rnd() * 3) | 0), 3 + ((rnd() * 2) | 0), 2, c1);
    ellipse(g, 9, 10, 2, 2, dark);
    for (var i = 0; i < 6; i++) {
      var x = 1 + ((rnd() * 13) | 0), y = 2 + ((rnd() * 12) | 0);
      fill(g, x, y, 1 + ((rnd() * 2) | 0), 1, rnd() < 0.4 ? dark : c1);
    }
  }

  function paintExplosion(g, frame) {
    var cx = 24, cy = 24;
    var r = 5 + frame * 6;
    var cols = ['#ffe9a0', '#ffd23c', P.flame, '#c0392b'];
    disc(g, cx, cy, r, cols[Math.min(3, frame)]);
    if (r > 4) disc(g, cx, cy, r - 3, cols[Math.max(0, Math.min(3, frame - 1))]);
    if (r > 8) disc(g, cx, cy, r - 7, '#ffe9a0');
    if (frame >= 2) {
      var smoke = shade(P.ink, 0.28);
      for (var i = 0; i < 12; i++) {
        var ang = i * 0.5235987755982988;
        fill(g, (cx + Math.cos(ang) * (r + 2)) | 0, (cy + Math.sin(ang) * (r + 2)) | 0, 3, 3, smoke);
      }
    }
  }

  /* ------------------------------------------------------------------
     Pawns
     ------------------------------------------------------------------ */

  var SKIN = ['#f0c8a0', '#e0b088', '#c89868', '#a87848', '#8a5c34', '#5e3a20'];
  var HAIR = ['#2b1d12', '#4a3020', '#7a5230', '#a8763c', '#c9b48a', '#6e6e78'];

  var APPAREL_SLOT = {
    shirt: 'top', jacket: 'over', parka: 'over', armorVest: 'vest',
    pants: 'leg', helmet: 'head'
  };

  function apparelColor(t) {
    var d = t.def || (t.defId && Defs.maybe('thing', t.defId));
    if (!d) return null;
    var stuff = t.stuffId && Defs.maybe('thing', t.stuffId);
    return stuff ? mix(d.color, stuff.color, 0.45) : d.color;
  }

  function humanStyle(pawn) {
    var h = U.hash('pawn' + (pawn.id || 0) + (pawn.kindId || ''));
    var fc = factionColor(pawn.faction);
    var s = {
      skin: SKIN[h % SKIN.length],
      hair: HAIR[(h >>> 5) % HAIR.length],
      style: (h >>> 11) % 4,
      top: null, over: null, vest: null, leg: null, head: null
    };
    var worn = pawn.apparel || [];
    for (var i = 0; i < worn.length; i++) {
      var t = worn[i], id = t && (t.defId || (t.def && t.def.id));
      var slot = id && APPAREL_SLOT[id];
      if (slot) s[slot] = apparelColor(t);
    }
    /* Faction colour is mixed into the worn garment rather than painted
       over it, so a colonist still reads blue and a raider red without
       throwing away what they are actually wearing. */
    s.top = s.top ? mix(s.top, fc, 0.35) : fc;
    s.over = s.over ? mix(s.over, fc, 0.3) : null;
    s.leg = s.leg || shade(fc, -0.35);
    return s;
  }

  function paintHuman(g, s, dir, frame, pose) {
    var body = s.over || s.top, dk = shade(body, -0.4);
    var lean = frame ? 1 : 0;

    if (pose !== 'up') {
      /* Lying pose: the whole figure turned onto its side, head left. */
      var flat = pose === 'dead' ? mix(body, P.rock, 0.45) : body;
      var skin = pose === 'dead' ? mix(s.skin, P.rock, 0.4) : s.skin;
      fill(g, 13, 6, 3, 2, s.leg); fill(g, 13, 9, 3, 2, s.leg);
      ellipse(g, 10, 8, 4, 3, flat);
      ellipse(g, 10, 7, 3, 2, shade(flat, 0.14));
      fill(g, 6, 11, 9, 1, shade(flat, -0.4));
      fill(g, 6, 7, 3, 3, flat);
      disc(g, 4, 8, 3, skin);
      disc(g, 3, 7, 2, pose === 'dead' ? mix(s.hair, P.rock, 0.4) : s.hair);
      if (pose === 'dead') { dot(g, 5, 10, P.blood); dot(g, 7, 11, P.blood); }
      return;
    }

    /* Legs first, so the torso overlaps the hips. */
    fill(g, 5, 11 + lean, 3, 4 - lean, s.leg);
    fill(g, 9, 11 - lean, 3, 4 + lean, s.leg);
    fill(g, 5, 14, 3, 1, shade(s.leg, -0.4));
    fill(g, 9, 14, 3, 1, shade(s.leg, -0.4));

    var tx = dir === 1 ? 5 : 3;
    var tw = (dir === 1 || dir === 3) ? 8 : 10;
    fill(g, tx, 6, tw, 6, body);
    fill(g, tx, 6, tw, 1, shade(body, 0.16));
    box(g, tx, 6, tw, 6, dk);

    if (s.vest) {
      fill(g, tx + 1, 6, tw - 2, 5, s.vest);
      fill(g, tx + 1, 6, tw - 2, 1, shade(s.vest, 0.2));
      fill(g, tx + 3, 6, 1, 5, shade(s.vest, -0.3));
    }

    /* Arms: two visible from front and back, one from the side. */
    if (dir === 0 || dir === 2) {
      fill(g, 2, 7, 2, 4, body); fill(g, 12, 7, 2, 4, body);
      fill(g, 2, 11, 2, 1, s.skin); fill(g, 12, 11, 2, 1, s.skin);
    } else {
      var ax = dir === 1 ? 12 : 2;
      fill(g, ax, 7 + lean, 2, 4, body);
      fill(g, ax, 11 + lean, 2, 1, s.skin);
    }

    var hx = dir === 1 ? 6 : 5;
    fill(g, hx, 1, 6, 6, s.skin);
    box(g, hx, 1, 6, 6, shade(s.skin, -0.35));

    if (s.head) {
      fill(g, hx - 1, 0, 8, 4, s.head);
      fill(g, hx - 1, 3, 8, 1, shade(s.head, -0.35));
      if (dir === 2) { dot(g, hx + 1, 4, P.ink); dot(g, hx + 4, 4, P.ink); }
    } else {
      var hair = s.hair;
      if (dir === 0) {
        fill(g, hx, 0, 6, 6, hair);
        if (s.style === 1) { fill(g, hx - 1, 2, 1, 5, hair); fill(g, hx + 6, 2, 1, 5, hair); }
      } else {
        fill(g, hx, 0, 6, 2, hair);
        if (s.style !== 3) { fill(g, hx, 2, 1, 2, hair); fill(g, hx + 5, 2, 1, 2, hair); }
        if (s.style === 1) { fill(g, hx - 1, 2, 1, 5, hair); fill(g, hx + 6, 2, 1, 5, hair); }
        if (s.style === 2) fill(g, hx + 2, 0, 2, 1, shade(hair, 0.2));
        if (dir === 2) { dot(g, hx + 1, 4, P.ink); dot(g, hx + 4, 4, P.ink); }
        else if (dir === 1) dot(g, hx + 4, 4, P.ink);
        else dot(g, hx + 1, 4, P.ink);
      }
    }
  }

  function draftMark(g) {
    fill(g, 6, 14, 4, 1, P.gold);
    dot(g, 5, 13, P.gold); dot(g, 10, 13, P.gold);
    dot(g, 7, 15, shade(P.gold, -0.3)); dot(g, 8, 15, shade(P.gold, -0.3));
  }

  /* Animal silhouettes. Every one is painted facing north and then
     rotated, because a quadruped seen from above is the same animal
     from every side - only humans need a distinct face and back. */
  var ANIMAL = {
    hare:    { size: 0.8,  body: '#b08c5a', belly: '#e6ddc8', ear: 4, tail: 1, snout: 1 },
    deer:    { size: 1.35, body: '#8a6134', belly: '#d8cfc0', ear: 2, tail: 2, snout: 2, antler: true },
    muffalo: { size: 1.9,  body: '#4a3b2c', belly: '#6b5638', ear: 1, tail: 3, snout: 2, horn: true, shag: true },
    boomrat: { size: 0.75, body: '#a3503a', belly: '#e0803c', ear: 2, tail: 5, snout: 2 },
    wolf:    { size: 1.15, body: '#6e6e78', belly: '#b0b0b8', ear: 3, tail: 4, snout: 3 },
    bear:    { size: 1.6,  body: '#4a3524', belly: '#6b4f33', ear: 2, tail: 0, snout: 2 }
  };

  function paintAnimal(g, rnd, a, S, frame, dead) {
    var body = dead ? mix(a.body, P.rock, 0.45) : a.body;
    var belly = dead ? mix(a.belly, P.rock, 0.45) : a.belly;
    var dk = shade(body, -0.4);
    var cx = S / 2, rx = Math.max(2, Math.round(S * 0.26)), ry = Math.max(3, Math.round(S * 0.32));
    var bodyY = Math.round(S * 0.56);
    var headY = Math.round(S * 0.22), hr = Math.max(2, Math.round(S * 0.17));

    if (a.tail) {
      fill(g, Math.round(cx) - 1, bodyY + ry - 1, 2, a.tail, body);
      dot(g, Math.round(cx) - 1, bodyY + ry + a.tail - 1, belly);
    }
    /* Legs: the two pairs swap forward and back between walk frames. */
    var lw = Math.max(1, Math.round(S * 0.1)), lh = Math.max(2, Math.round(S * 0.17));
    var lx = Math.round(cx - rx), rxx = Math.round(cx + rx - lw);
    var fy = bodyY - Math.round(ry * 0.5) + (frame ? 1 : -1);
    var by = bodyY + Math.round(ry * 0.4) - (frame ? 1 : -1);
    fill(g, lx, fy, lw, lh, dk); fill(g, rxx, fy, lw, lh, dk);
    fill(g, lx, by, lw, lh, dk); fill(g, rxx, by, lw, lh, dk);

    ellipse(g, cx, bodyY, rx, ry, body);
    ellipse(g, cx, bodyY + Math.round(ry * 0.35), Math.max(1, rx - 1), Math.max(1, ry >> 1), belly);
    if (a.shag) speckle(g, rnd, Math.round(S * 1.2), shade(body, 0.16), cx - rx, bodyY - ry, rx * 2, ry * 2);

    ellipse(g, cx, headY, hr, hr, body);
    fill(g, Math.round(cx - 1), headY - hr - a.snout + 1, 2, a.snout + 1, belly);
    dot(g, Math.round(cx), headY - hr - a.snout, dk);
    if (a.ear) {
      /* Ears grow upward out of the skull, so they start above it and
         a hare still reads as a hare at eight pixels across. */
      var ey = Math.max(0, headY - hr - a.ear + 1);
      fill(g, Math.round(cx - hr - 1), ey, 1, a.ear, body);
      fill(g, Math.round(cx + hr), ey, 1, a.ear, body);
    }
    if (a.horn) {
      fill(g, Math.round(cx - hr - 1), headY - 1, 2, 1, P.bone);
      fill(g, Math.round(cx + hr - 1), headY - 1, 2, 1, P.bone);
    }
    if (a.antler) {
      line(g, Math.round(cx - 1), headY - hr, Math.round(cx - hr - 1), headY - hr - 3, P.bone, 1);
      line(g, Math.round(cx + 1), headY - hr, Math.round(cx + hr + 1), headY - hr - 3, P.bone, 1);
    }
    if (!dead) {
      dot(g, Math.round(cx - hr + 1), headY - 1, P.ink);
      dot(g, Math.round(cx + hr - 1), headY - 1, P.ink);
    }
  }

  /* ------------------------------------------------------------------
     A 3x5 pixel font, enough for stack badges and motes. Each glyph is
     five octal digits, one per row, three bits wide.
     ------------------------------------------------------------------ */
  var FONT = {
    '0': '75557', '1': '26227', '2': '71747', '3': '71717', '4': '55711',
    '5': '74717', '6': '74757', '7': '71222', '8': '75757', '9': '75717',
    'A': '25755', 'B': '65656', 'C': '34443', 'D': '65556', 'E': '74747',
    'F': '74744', 'G': '34553', 'H': '55755', 'I': '72227', 'J': '11152',
    'K': '55655', 'L': '44447', 'M': '57755', 'N': '57775', 'O': '75557',
    'P': '65644', 'Q': '25573', 'R': '65655', 'S': '34216', 'T': '72222',
    'U': '55557', 'V': '55552', 'W': '55775', 'X': '55255', 'Y': '55222',
    'Z': '71247', '+': '02720', '-': '00700', '.': '00002', ':': '02020',
    '%': '51245', '/': '11244', '!': '22202', '?': '61202', ' ': '00000'
  };

  function paintText(g, str, color) {
    g.fillStyle = color;
    for (var i = 0; i < str.length; i++) {
      var rows = FONT[str.charAt(i).toUpperCase()] || FONT['?'];
      for (var r = 0; r < 5; r++) {
        var bits = rows.charCodeAt(r) - 48;
        for (var c = 0; c < 3; c++) if (bits & (4 >> c)) g.fillRect(i * 4 + c, r, 1, 1);
      }
    }
  }

  /* ------------------------------------------------------------------
     UI icons
     ------------------------------------------------------------------ */

  function tri(g, x, y, s, c) {
    g.fillStyle = c;
    for (var i = 0; i < s; i++) {
      var h = s * 2 - 1 - i * 2;
      g.fillRect(x + i, y + i, 1, h);
    }
  }

  var ICON = {
    pause: function (g, c) { fill(g, 4, 3, 3, 10, c); fill(g, 9, 3, 3, 10, c); },
    play1: function (g, c) { tri(g, 6, 3, 5, c); },
    play2: function (g, c) { tri(g, 2, 3, 5, c); tri(g, 9, 3, 5, c); },
    play3: function (g, c) { tri(g, 0, 3, 5, c); tri(g, 6, 3, 5, c); tri(g, 11, 3, 5, c); },
    wallIcon: function (g, c) { fill(g, 1, 4, 14, 8, c); fill(g, 1, 8, 14, 1, shade(c, -0.4)); fill(g, 6, 4, 1, 4, shade(c, -0.4)); fill(g, 10, 9, 1, 3, shade(c, -0.4)); },
    chair: function (g, c) { fill(g, 4, 2, 8, 7, c); fill(g, 3, 9, 10, 3, shade(c, 0.15)); fill(g, 4, 12, 2, 3, shade(c, -0.3)); fill(g, 10, 12, 2, 3, shade(c, -0.3)); },
    anvil: function (g, c) { fill(g, 3, 4, 10, 3, c); fill(g, 1, 5, 3, 2, c); fill(g, 6, 7, 4, 4, shade(c, -0.2)); fill(g, 4, 11, 8, 2, c); },
    bolt: function (g, c) { line(g, 9, 1, 5, 8, c, 2); line(g, 5, 8, 10, 8, c, 1); line(g, 10, 7, 6, 15, c, 2); },
    shield: function (g, c) { fill(g, 3, 2, 10, 7, c); for (var i = 0; i < 5; i++) fill(g, 3 + i, 9 + i, 10 - i * 2, 1, c); fill(g, 5, 4, 6, 1, shade(c, 0.3)); },
    tiles: function (g, c) { fill(g, 1, 1, 6, 6, c); fill(g, 9, 1, 6, 6, shade(c, -0.25)); fill(g, 1, 9, 6, 6, shade(c, -0.25)); fill(g, 9, 9, 6, 6, c); },
    dashSquare: function (g, c) { dashedBox(g, 16, 16, c); },
    handArrow: function (g, c) { line(g, 3, 13, 12, 4, c, 2); fill(g, 9, 2, 5, 2, c); fill(g, 12, 2, 2, 5, c); },
    gear: function (g, c) { disc(g, 8, 8, 5, c); disc(g, 8, 8, 2, shade(c, -0.6)); for (var i = 0; i < 4; i++) { var a = i * 1.5707963267948966; fill(g, (8 + Math.cos(a) * 6) | 0, (8 + Math.sin(a) * 6) | 0, 2, 2, c); } },
    pick: function (g, c) { line(g, 2, 4, 13, 7, c, 1); line(g, 2, 5, 13, 8, shade(c, -0.25), 1); line(g, 7, 6, 11, 14, P.woodFloor, 2); },
    axe: function (g, c) { line(g, 4, 14, 11, 3, P.woodFloor, 2); fill(g, 9, 1, 5, 5, c); fill(g, 8, 2, 2, 3, shade(c, 0.25)); },
    sickle: function (g, c) { for (var y = 2; y < 9; y++) fill(g, 3 + ((y - 2) * (y - 2) >> 2), y, 2, 1, c); line(g, 4, 9, 8, 14, P.woodFloor, 2); },
    scissors: function (g, c) { line(g, 3, 2, 11, 11, c, 1); line(g, 12, 2, 4, 11, c, 1); disc(g, 4, 13, 2, shade(c, -0.2)); disc(g, 11, 13, 2, shade(c, -0.2)); },
    hammer: function (g, c) { fill(g, 3, 2, 9, 4, c); fill(g, 3, 2, 9, 1, shade(c, 0.25)); line(g, 8, 6, 8, 14, P.woodFloor, 2); },
    upArrow: function (g, c) { tri(g, 8, 2, 5, c); fill(g, 7, 7, 3, 8, c); },
    crosshair: function (g, c) { box(g, 3, 3, 10, 10, c); fill(g, 7, 0, 2, 5, c); fill(g, 7, 11, 2, 5, c); fill(g, 0, 7, 5, 2, c); fill(g, 11, 7, 5, 2, c); dot(g, 7, 7, c); },
    heart: function (g, c) { disc(g, 5, 6, 3, c); disc(g, 11, 6, 3, c); for (var i = 0; i < 7; i++) fill(g, 2 + i, 8 + i, 13 - i * 2, 1, c); },
    knifeIcon: function (g, c) { line(g, 3, 12, 11, 3, c, 2); line(g, 4, 13, 7, 10, P.woodFloor, 2); dot(g, 12, 2, shade(c, 0.35)); },
    xMark: function (g, c) { line(g, 3, 3, 12, 12, c, 2); line(g, 12, 3, 3, 12, c, 2); },
    flame: function (g, c) { flame(g, 8, 14, 0, 8); },
    cross: function (g, c) { fill(g, 6, 2, 4, 12, c); fill(g, 2, 6, 12, 4, c); },
    bed: function (g, c) { fill(g, 1, 5, 14, 7, c); fill(g, 2, 6, 4, 4, P.paper); fill(g, 7, 6, 7, 4, shade(c, -0.25)); fill(g, 1, 12, 2, 3, shade(c, -0.4)); fill(g, 13, 12, 2, 3, shade(c, -0.4)); },
    key: function (g, c) { disc(g, 4, 6, 3, c); disc(g, 4, 6, 1, shade(c, -0.7)); line(g, 6, 8, 13, 14, c, 2); fill(g, 11, 9, 3, 2, c); },
    paw: function (g, c) { disc(g, 8, 11, 4, c); disc(g, 4, 6, 2, c); disc(g, 7, 4, 2, c); disc(g, 11, 5, 2, c); disc(g, 13, 9, 2, c); },
    pot: function (g, c) { fill(g, 3, 6, 10, 7, c); fill(g, 2, 5, 12, 2, shade(c, 0.2)); fill(g, 0, 6, 2, 2, c); fill(g, 14, 6, 2, 2, c); fill(g, 6, 2, 1, 3, shade(c, 0.4)); fill(g, 9, 1, 1, 4, shade(c, 0.4)); },
    sprout: function (g, c) { fill(g, 7, 7, 2, 8, shade(c, -0.25)); ellipse(g, 4, 6, 3, 2, c); ellipse(g, 12, 5, 3, 2, shade(c, 0.2)); ellipse(g, 8, 3, 2, 2, c); },
    boxIcon: function (g, c) { fill(g, 2, 4, 12, 10, c); box(g, 2, 4, 12, 10, shade(c, -0.45)); fill(g, 2, 8, 12, 1, shade(c, -0.45)); fill(g, 7, 4, 2, 10, shade(c, -0.3)); },
    broom: function (g, c) { line(g, 4, 14, 11, 4, P.woodFloor, 2); fill(g, 2, 12, 7, 4, c); for (var i = 0; i < 7; i += 2) fill(g, 2 + i, 12, 1, 4, shade(c, -0.3)); },
    flask: function (g, c) { fill(g, 6, 1, 4, 5, shade(c, 0.3)); for (var i = 0; i < 7; i++) fill(g, 6 - i, 6 + i, 4 + i * 2, 1, i > 3 ? c : shade(c, 0.3)); fill(g, 2, 13, 12, 2, c); },
    apple: function (g, c) { disc(g, 8, 10, 5, c); fill(g, 7, 3, 2, 3, shade(P.grass, -0.2)); ellipse(g, 11, 4, 2, 1, P.grass); dot(g, 6, 8, shade(c, 0.4)); },
    moon: function (g, c) { disc(g, 8, 8, 7, c); g.globalCompositeOperation = 'destination-out'; disc(g, 13, 5, 6, '#000'); g.globalCompositeOperation = 'source-over'; },
    sun: function (g, c) { disc(g, 8, 8, 4, c); for (var i = 0; i < 8; i++) { var a = i * 0.7853981633974483; fill(g, (8 + Math.cos(a) * 6.5) | 0, (8 + Math.sin(a) * 6.5) | 0, 2, 2, c); } },
    person: function (g, c) { disc(g, 8, 4, 3, c); fill(g, 5, 8, 6, 7, c); fill(g, 3, 8, 2, 5, c); fill(g, 11, 8, 2, 5, c); },
    clock: function (g, c) { disc(g, 8, 8, 7, shade(c, -0.5)); disc(g, 8, 8, 6, c); fill(g, 7, 4, 2, 5, shade(c, -0.6)); fill(g, 8, 8, 4, 2, shade(c, -0.6)); },
    list: function (g, c) { for (var i = 0; i < 3; i++) { fill(g, 2, 3 + i * 4, 2, 2, c); fill(g, 6, 3 + i * 4, 8, 2, shade(c, -0.15)); } },
    star: function (g, c) { fill(g, 7, 1, 2, 14, c); fill(g, 1, 7, 14, 2, c); line(g, 3, 3, 13, 13, c, 1); line(g, 13, 3, 3, 13, c, 1); disc(g, 8, 8, 3, shade(c, 0.3)); },
    thermo: function (g, c) { fill(g, 6, 1, 4, 10, P.paper); disc(g, 8, 12, 3, c); fill(g, 7, 4, 2, 8, c); box(g, 6, 1, 4, 11, shade(P.ink, 0.3)); },
    envelope: function (g, c) { fill(g, 1, 4, 14, 9, c); box(g, 1, 4, 14, 9, shade(c, -0.45)); line(g, 1, 4, 8, 9, shade(c, -0.3), 1); line(g, 14, 4, 8, 9, shade(c, -0.3), 1); },
    skull: function (g, c) { disc(g, 8, 7, 5, c); fill(g, 5, 11, 6, 3, c); dot(g, 6, 7, P.ink); dot(g, 10, 7, P.ink); fill(g, 6, 6, 2, 2, P.ink); fill(g, 9, 6, 2, 2, P.ink); fill(g, 7, 11, 1, 3, shade(c, -0.4)); fill(g, 9, 11, 1, 3, shade(c, -0.4)); },
    bang: function (g, c) { for (var i = 0; i < 7; i++) fill(g, 8 - i, 3 + i * 2, 1 + i * 2, 2, c); fill(g, 7, 6, 2, 5, P.ink); fill(g, 7, 12, 2, 2, P.ink); }
  };

  /* Six mouth pixels, y offsets per mood. Screen y grows downward, so a
     frown sits low at the corners and a grin sits low in the middle. */
  var MOUTH = [[3, 2, 1, 1, 2, 3], [2, 1, 1, 1, 1, 2], [1, 1, 1, 1, 1, 1],
               [0, 1, 2, 2, 1, 0], [0, 1, 3, 3, 1, 0]];

  function paintFace(g, level) {
    var c = ['#c0392b', '#d07a2a', P.gold, '#8fbb62', '#5fae4a'][level];
    disc(g, 8, 8, 7, shade(c, -0.35));
    disc(g, 8, 8, 6, c);
    fill(g, 5, 5, 2, 2, P.ink); fill(g, 9, 5, 2, 2, P.ink);
    for (var i = 0; i < 6; i++) fill(g, 5 + i, 10 + MOUTH[level][i], 1, 1, P.ink);
  }

  /* key -> [painter, colour]. Aliases are the point: a pickaxe is a
     pickaxe whether it is a designation, a work type or a build menu. */
  var ICON_MAP = {
    'speed0': ['pause', P.paper], 'speed1': ['play1', P.paper],
    'speed2': ['play2', P.paper], 'speed3': ['play3', P.paper],
    'speed4': ['play3', P.gold],
    'cat-structure': ['wallIcon', P.steel], 'cat-furniture': ['chair', P.woodFloor],
    'cat-production': ['anvil', P.steel], 'cat-power': ['bolt', P.gold],
    'cat-security': ['shield', '#8a9ab0'], 'cat-floor': ['tiles', '#9a958c'],
    'cat-zone': ['dashSquare', P.gold], 'cat-orders': ['handArrow', P.paper],
    'cat-misc': ['gear', P.steel],
    'des-mine': ['pick', P.steel], 'des-chop': ['axe', P.steel],
    'des-harvest': ['sickle', P.steel], 'des-cut': ['scissors', P.steel],
    'des-deconstruct': ['hammer', '#b08c5a'], 'des-haulUrgent': ['upArrow', P.gold],
    'des-hunt': ['crosshair', P.raider], 'des-tame': ['heart', '#d4557a'],
    'des-slaughter': ['knifeIcon', P.blood], 'des-cancel': ['xMark', P.raider],
    'work-firefight': ['flame', P.flame], 'work-patient': ['bed', '#8fbb62'],
    'work-doctor': ['cross', '#e05a5a'], 'work-bedRest': ['bed', '#7fa0c0'],
    'work-basic': ['gear', P.steel], 'work-warden': ['key', P.gold],
    'work-handle': ['paw', P.wild], 'work-cook': ['pot', '#b8bcc4'],
    'work-hunt': ['crosshair', P.raider], 'work-construct': ['hammer', '#b08c5a'],
    'work-grow': ['sprout', P.grass], 'work-mine': ['pick', P.steel],
    'work-plantCut': ['axe', P.steel], 'work-craft': ['anvil', P.steel],
    'work-haul': ['boxIcon', P.woodFloor], 'work-clean': ['broom', '#c2b280'],
    'work-research': ['flask', P.sky],
    'need-food': ['apple', '#c0392b'], 'need-rest': ['moon', '#c9cfe0'],
    'need-joy': ['star', P.gold], 'need-comfort': ['chair', P.woodFloor],
    'need-outdoors': ['sun', P.gold], 'need-mood': ['heart', '#d4557a'],
    'alert-low': ['bang', P.gold], 'alert-medium': ['bang', '#e08a2a'],
    'alert-high': ['bang', '#e05a3a'],
    'letter-neutral': ['envelope', P.paper], 'letter-threat': ['envelope', '#e08a7a'],
    'letter-good': ['envelope', '#9ed08a'], 'letter-death': ['skull', P.bone],
    'tab-work': ['list', P.paper], 'tab-research': ['flask', P.sky],
    'tab-colonists': ['person', P.colonist], 'tab-schedule': ['clock', P.paper],
    'tab-menu': ['list', P.gold], 'tab-bills': ['list', '#c2b280'],
    'overlay-zones': ['dashSquare', P.gold], 'overlay-power': ['bolt', P.gold],
    'overlay-rooms': ['wallIcon', P.steel], 'overlay-beauty': ['star', '#d4557a'],
    'overlay-temperature': ['thermo', '#e05a5a']
  };

  /* ------------------------------------------------------------------
     Public API
     ------------------------------------------------------------------ */

  var Art = { PX: PX, PALETTE: P, FACTION: FACTION };

  /* Keyed by the def object rather than by a string: this runs once per
     visible tile per frame, and building ten thousand throwaway strings
     a frame is a garbage collector pause the player can feel. */
  var terrainCache = new Map();

  Art.terrain = function (def, variant) {
    variant = (variant | 0) & 3;
    var row = terrainCache.get(def);
    if (!row) terrainCache.set(def, (row = [null, null, null, null]));
    return row[variant] || (row[variant] = cached('ter|' + def.id + '|' + variant, PX, PX,
      function (g, rnd) { paintTerrain(g, rnd, def, variant); }));
  };

  /* Which of the four terrain variants a cell uses. Integer mixing, so
     scrolling over new ground allocates nothing. */
  Art.terrainVariant = function (x, y) {
    var h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h >>> 15) & 3;
  };

  function isWallLike(map, x, y) {
    /* Off-map reads as wall so a mountain running off the edge does not
       grow a bright outline along it. */
    if (!map.inBounds(x, y)) return true;
    var b = map.buildingAt(x, y);
    return !!(b && b.def && b.def.holdsRoof);
  }

  Art.wallVariant = function (map, x, y) {
    if (!map || !map.inBounds) return 0;
    return (isWallLike(map, x, y - 1) ? 1 : 0) |
           (isWallLike(map, x + 1, y) ? 2 : 0) |
           (isWallLike(map, x, y + 1) ? 4 : 0) |
           (isWallLike(map, x - 1, y) ? 8 : 0);
  };

  /* The same join logic for anything that links to its own kind, which
     in practice means power conduits. */
  Art.linkVariant = function (map, x, y, defId) {
    if (!map || !map.inBounds) return 0;
    function has(cx, cy) {
      if (!map.inBounds(cx, cy)) return false;
      var b = map.buildingAt(cx, cy);
      return !!(b && b.defId === defId);
    }
    return (has(x, y - 1) ? 1 : 0) | (has(x + 1, y) ? 2 : 0) |
           (has(x, y + 1) ? 4 : 0) | (has(x - 1, y) ? 8 : 0);
  };

  var LINKED = { wall: 1, rockWall: 1, oreWall: 1, door: 1, conduit: 1 };

  function variantOf(def, thing) {
    if (!LINKED[def.sprite]) return 0;
    if (thing && typeof thing.wallVariant === 'number') return thing.wallVariant & 15;
    var map = thing && (thing.map || (root.Game && root.Game.map));
    if (!map || !map.inBounds || thing.x === undefined) return 0;
    return def.sprite === 'conduit'
      ? Art.linkVariant(map, thing.x, thing.y, def.id)
      : Art.wallVariant(map, thing.x, thing.y);
  }

  function stuffOf(def, thing) {
    if (!def.stuffable || !thing) return null;
    var sid = thing.stuffId || thing.stuff;
    return (sid && Defs.has('thing', sid)) ? sid : null;
  }

  /* Sprites whose look depends on something other than the def: a join
     mask, a material, a rotation, a growth stage, a power state or an
     animation frame. Everything else is one canvas forever, and that is
     the majority of what a frame draws. */
  var VARIES = {
    wall: 1, rockWall: 1, oreWall: 1, door: 1, conduit: 1,
    fire: 1, campfire: 1, filth: 1, blueprint: 1, frame: 1, lamp: 1, corpse: 1
  };
  var plainCache = new Map();

  function isPlain(def) {
    return !VARIES[def.sprite] && !def.rotatable && !def.stuffable && def.category !== 'plant';
  }

  function plantStage(thing) {
    var g = thing && typeof thing.growth === 'number' ? thing.growth : 1;
    return g < 0.32 ? 0 : (g < 0.85 ? 1 : 2);
  }

  function paintPlant(g, rnd, def, stage, variant, ripe) {
    switch (def.sprite) {
      case 'grass': paintGrass(g, rnd, def, stage, variant); break;
      case 'bush': paintBush(g, rnd, def, stage, ripe); break;
      case 'tree': paintTree(g, rnd, def, stage); break;
      default: paintCrop(g, rnd, def, stage);
    }
  }

  Art.thing = function (def, thing) {
    var plain = plainCache.get(def);
    if (plain) return plain;

    if (def.category === 'plant') {
      var stage = plantStage(thing);
      var pl = def.plant || {};
      var ripe = stage === 2 && !!pl.harvestedThing;
      var tree = !!pl.isTree;
      /* A tuft of grass differs from its neighbour; a tree does not need
         to, because at 2x2 the silhouette already carries the variety. */
      var variant = tree ? 0 : (thing && thing.id ? thing.id : 0) % 3;
      var key = 'pl|' + def.id + '|' + stage + '|' + variant + (ripe ? 'r' : '') +
        (thing && thing.blighted ? 'b' : '');
      var size = tree ? PX * 2 : PX;
      var c = cached(key, size, size, function (g, rnd) {
        paintPlant(g, rnd, def, stage, variant, ripe);
        if (thing && thing.blighted) {
          g.globalCompositeOperation = 'source-atop';
          g.globalAlpha = 0.55;
          fill(g, 0, 0, size, size, '#6b6046');
          g.globalAlpha = 1;
          g.globalCompositeOperation = 'source-over';
        }
      }, tree ? -PX / 2 : 0, tree ? -PX / 2 : 0);
      return c;
    }

    var sw = (def.size && def.size.w) || 1, sh = (def.size && def.size.h) || 1;
    var rot = (def.rotatable && thing) ? ((thing.rot | 0) & 3) : 0;
    var mask = variantOf(def, thing);
    var stuffId = stuffOf(def, thing);
    var open = def.building && def.building.isDoor &&
      !!(thing && (thing.open || thing.doorOpen || thing.openTicksLeft > 0));
    var lit = !(def.building && def.building.isLamp) || !thing || thing.powered !== false;
    var frame = def.sprite === 'fire' || def.sprite === 'campfire'
      ? ((((root.Game && root.Game.tick) || 0) >> 3) + (thing && thing.id ? thing.id : 0)) % 3 : 0;
    var noise = def.sprite === 'filth' ? ((thing && thing.id ? thing.id : 0) % 4) : 0;
    var kindId = (def.sprite === 'corpse' && thing && thing.corpse && thing.corpse.kindId) || null;

    /* Blueprints and frames wear the footprint of what they will become,
       so a half-built 3x3 solar panel occupies the right nine tiles. */
    var target = thing && thing.buildDefId && Defs.maybe('thing', thing.buildDefId);
    if (target) {
      sw = (target.size && target.size.w) || 1;
      sh = (target.size && target.size.h) || 1;
      rot = target.rotatable ? ((thing.rot | 0) & 3) : 0;
    }

    var key = 'th|' + def.id + '|' + sw + 'x' + sh + '|' + mask + '|' + (stuffId || '-') +
      '|' + (open ? 'o' : 'c') + (lit ? 'L' : 'd') + '|' + frame + '|' + noise +
      (kindId ? '|' + kindId : '');

    var base = cached(key, sw * PX, sh * PX, function (g, rnd) {
      var c1 = stuffId ? Defs.thing(stuffId).color : def.color;
      var a = {
        def: def, thing: thing, rnd: rnd, variant: mask, open: open, lit: lit,
        frame: frame, kindId: kindId, w: sw * PX, h: sh * PX,
        c1: c1, c2: def.color2 || shade(c1, -0.25)
      };
      (SPRITE[def.sprite] || SPRITE.item)(g, a);
    });

    if (isPlain(def) && !target) plainCache.set(def, base);
    return rot ? cachedRotation(base, rot) : base;
  };

  var rotCache = new Map();

  /* Rotating swaps the canvas dimensions, but the draw origin stays the
     footprint's top-left cell, so ox/oy carry over unchanged. The only
     sprites with a non-zero offset are square (animals) or never
     rotated (trees), which is why that holds. */
  function cachedRotation(src, rot) {
    var key = 'rot|' + src.key + '|' + rot;
    var c = rotCache.get(key);
    if (!c) {
      c = rotated(src, rot);
      c.key = key; c.ox = src.ox; c.oy = src.oy;
      rotCache.set(key, c);
    }
    return c;
  }

  /* The sprite a build ghost shows: the finished building, at the
     rotation and material the player currently has selected. */
  Art.ghost = function (defId, rot, stuffId) {
    var floor = Defs.maybe('terrain', defId);
    if (floor) return Art.terrain(floor, 0);
    var def = Defs.maybe('thing', defId);
    if (!def) return Art.icon('cat-misc');
    return Art.thing(def, { rot: rot | 0, stuffId: stuffId || null, wallVariant: 0, x: 0, y: 0 });
  };

  Art.pawn = function (pawn, dir, frame) {
    dir = (dir | 0) & 3;
    frame = (frame | 0) & 1;
    var dead = !!pawn.dead, down = !dead && !!(pawn.downed || (pawn.health && pawn.health.downed));
    var pose = dead ? 'dead' : (down ? 'down' : 'up');

    if (pawn.isAnimal || (pawn.kind && pawn.kind.isAnimal)) {
      var kid = pawn.kindId || 'hare';
      var a = ANIMAL[kid] || ANIMAL.hare;
      var kind = pawn.kind;
      var ds = (kind && kind.drawSize) || a.size;
      if (ds && ds.length) ds = ds[0];
      var S = Math.max(8, Math.round(ds * PX / 2) * 2);
      var spec = {
        body: (kind && kind.color) || a.body, belly: (kind && kind.color2) || a.belly,
        ear: a.ear, tail: a.tail, snout: a.snout, horn: a.horn, antler: a.antler, shag: a.shag
      };
      var akey = 'an|' + kid + '|' + S + '|' + frame + '|' + pose;
      var north = cached(akey, S, S, function (g, rnd) {
        paintAnimal(g, rnd, spec, S, frame, pose !== 'up');
      }, (PX - S) / 2, (PX - S) / 2);
      if (!dir) return north;
      var rk = akey + '|d' + dir;
      var rc = rotCache.get(rk);
      if (!rc) {
        rc = rotated(north, dir);
        rc.key = rk; rc.ox = north.ox; rc.oy = north.oy;
        rotCache.set(rk, rc);
      }
      return rc;
    }

    var s = humanStyle(pawn);
    var hkey = 'hu|' + s.skin + s.hair + s.style + '|' + s.top + '|' + (s.over || '-') + '|' +
      (s.vest || '-') + '|' + s.leg + '|' + (s.head || '-') + '|' + dir + frame + pose +
      (pawn.drafted ? 'D' : '');
    if (cache.has(hkey)) return cache.get(hkey);

    /* West is the mirror of east, which keeps the two side views
       identical instead of almost-identical. */
    if (dir === 3 && pose === 'up') {
      var east = Art.pawn(pawn, 1, frame);
      var m = mirrored(east);
      m.key = hkey; m.ox = 0; m.oy = 0;
      cache.set(hkey, m);
      return m;
    }
    return cached(hkey, PX, PX, function (g) {
      paintHuman(g, s, dir, frame, pose);
      if (pawn.drafted && pose === 'up') draftMark(g);
    });
  };

  Art.icon = function (key) {
    var ck = 'ic|' + key;
    if (cache.has(ck)) return cache.get(ck);
    if (/^mood-[0-4]$/.test(key)) {
      var lvl = parseInt(key.slice(5), 10);
      return cached(ck, PX, PX, function (g) { paintFace(g, lvl); });
    }
    var spec = ICON_MAP[key];
    if (spec) {
      return cached(ck, PX, PX, function (g) { ICON[spec[0]](g, spec[1]); });
    }
    /* An unmapped key still has to draw something honest: its first two
       characters on a paper chip, which is legible and obviously a
       fallback rather than pretending to be an icon. */
    return cached(ck, PX, PX, function (g) {
      fill(g, 1, 1, 14, 14, P.paper);
      box(g, 1, 1, 14, 14, shade(P.ink, 0.3));
      g.save(); g.translate(3, 5);
      paintText(g, key.slice(0, 2).toUpperCase(), P.ink);
      g.restore();
    });
  };

  Art.effect = function (key, frame) {
    frame = frame | 0;
    var ck = 'fx|' + key + '|' + frame;
    if (cache.has(ck)) return cache.get(ck);
    switch (key) {
      case 'fire':
        return cached(ck, PX, PX, function (g) { flame(g, 8, 14, frame % 3, 9); });
      case 'blood':
        return cached(ck, PX, PX, function (g, rnd) {
          paintBlood(g, rnd, P.blood, shade(P.blood, -0.35));
        });
      case 'explosion':
        return cached(ck, PX * 3, PX * 3, function (g) {
          paintExplosion(g, U.clamp(frame, 0, 3));
        }, -PX, -PX);
      case 'bullet':
      case 'arrow':
        return Art.thing(Defs.thing(key), null);
      default:
        return Art.icon(key);
    }
  };

  Art.text = function (str, color) {
    str = String(str);
    color = color || P.paper;
    var ck = 'tx|' + str + '|' + color;
    if (cache.has(ck)) return cache.get(ck);
    return cached(ck, Math.max(1, str.length * 4 - 1), 5, function (g) {
      paintText(g, str, color);
    });
  };

  /* Multiply the source by a colour and put its own alpha back, which
     tints a finished sprite without flattening its shading. */
  Art.colorize = function (canvas, color) {
    var ck = canvas.key ? 'tint|' + canvas.key + '|' + color : null;
    if (ck && cache.has(ck)) return cache.get(ck);
    var c = makeCanvas(canvas.width, canvas.height), g = ctxOf(c);
    c.ox = canvas.ox; c.oy = canvas.oy; c.key = ck;
    g.drawImage(canvas, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(canvas, 0, 0);
    g.globalCompositeOperation = 'source-over';
    if (ck) cache.set(ck, c);
    return c;
  };

  /* ------------------------------------------------------------------
     Warm-up

     Everything a colony sees in its first seconds is drawn here so the
     first frame does not stutter. Anything rarer - a wall of a material
     nobody has cut yet, an animal that has not wandered in - is built
     the first time it is asked for and cached from then on.
     ------------------------------------------------------------------ */

  var ready = false;

  Art.init = function () {
    if (ready) return Art;
    ready = true;

    Defs.all('terrain').forEach(function (t) {
      for (var v = 0; v < 4; v++) Art.terrain(t, v);
    });

    var stuffs = [null, 'wood', 'steel', 'stoneBlocks'];
    Defs.all('thing').forEach(function (d) {
      if (d.category === 'plant') {
        for (var s = 0; s < 3; s++) {
          for (var v = 0; v < 3; v++) {
            Art.thing(d, { id: v, growth: [0.1, 0.6, 1][s] });
          }
        }
        return;
      }
      if (LINKED[d.sprite]) {
        var mats = d.stuffable ? stuffs : [null];
        for (var mi = 0; mi < mats.length; mi++) {
          for (var m = 0; m < 16; m++) {
            Art.thing(d, { wallVariant: m, stuffId: mats[mi], x: 0, y: 0 });
          }
        }
        return;
      }
      Art.thing(d, null);
      if (d.stuffable) {
        Art.thing(d, { stuffId: 'steel', x: 0, y: 0 });
        Art.thing(d, { stuffId: 'stoneBlocks', x: 0, y: 0 });
      }
    });

    Object.keys(ANIMAL).forEach(function (kid) {
      var kind = Defs.maybe('pawnKind', kid);
      var stub = { kindId: kid, kind: kind, isAnimal: true, id: 0, faction: 'wild' };
      for (var d = 0; d < 4; d++) { Art.pawn(stub, d, 0); Art.pawn(stub, d, 1); }
    });

    Object.keys(ICON_MAP).forEach(Art.icon);
    for (var mo = 0; mo < 5; mo++) Art.icon('mood-' + mo);
    for (var f = 0; f < 3; f++) Art.effect('fire', f);
    for (var b = 0; b < 4; b++) Art.effect('blood', b);
    for (var e = 0; e < 4; e++) Art.effect('explosion', e);

    return Art;
  };

  Art.ready = function () { return ready; };
  Art.cacheSize = function () { return cache.size + rotCache.size; };

  root.Art = Art;
})(this);
