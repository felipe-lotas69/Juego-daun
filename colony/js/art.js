/* ============================================================
   art.js - every sprite in the game, drawn in code.

   There are no image files anywhere in this project, which is the only
   reason it runs off a file:// URL with nothing to fetch. Every sprite
   below is illustrated with the full 2D canvas API - paths, arcs,
   bezier curves, linear and radial gradients, alpha layers and
   per-pixel grain - into an offscreen canvas at 64 pixels per tile,
   once, at boot, and then cached by key.

   Three conventions run through the whole file:

   1. SIXTY-FOUR. A tile is authored at 64x64 and a thing of size {w,h}
      at 64w x 64h. The renderer shows tiles at 24, 32, 48 or 64 screen
      pixels, so a sprite is downscaled rather than magnified, and it is
      drawn with image smoothing ON. That is the whole reason this file
      can stop thinking in blocks and start thinking in shapes: at 64
      pixels a wall has courses and a bevel, a pawn has shoulders, and a
      rifle has a stock. UI icons are the exception - they are authored
      at 32, in flat pixels, and drawn unsmoothed, because a 20-pixel
      chip in a panel wants hard edges.

   2. Light comes from the north-west. Every bevel, every specular
      sweep and every cast shadow in this file agrees on that, which is
      what makes a screen full of unrelated sprites read as one scene.

   3. Variation is deterministic, never random. A field of soil is
      textured because the renderer hashes the cell into one of four
      pre-drawn variants, and each variant's clods come from a local
      generator seeded by its cache key. Nothing here touches U.rand:
      the simulation stream must not move because somebody scrolled the
      camera over a new patch of grass.

   Every canvas returned carries `ox`/`oy`: the offset, in authored
   pixels, from the thing's top-left tile to where the canvas should be
   drawn. It is zero for almost everything and negative for sprites that
   overhang their tile, such as trees, large animals and explosions.
   Effect canvases additionally carry `cx`/`cy`, the effect's centre
   inside the canvas, for callers that position by centre rather than by
   tile corner.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U, Defs = root.Defs;

  var PX = 64;          /* authored pixels per tile */
  var ICON_PX = 32;     /* UI icons: half a tile, flat pixels, unsmoothed */
  var TAU = Math.PI * 2;

  /* ------------------------------------------------------------------
     The palette

     One table for the whole game. The canvas colours and the interface
     accents live together on purpose: a swatch in a panel and a pixel
     on the map are then the same colour by construction rather than by
     two people typing the same hex twice. The UI block mirrors the
     custom properties styles.css declares on :root.
     ------------------------------------------------------------------ */
  var P = {
    /* art direction anchors */
    soil: '#6b533b', richSoil: '#4f3d2b', grass: '#5c7a3e', sand: '#c2b280',
    rock: '#5a5a62', rockFloor: '#6e6e78', water: '#2f5d78', woodFloor: '#8a6134',
    steel: '#8f97a3', blood: '#8b1a1a', night: '#0e1430', colonist: '#4a7fd4',
    raider: '#c0392b', wild: '#b08c5a', paper: '#e8e2d4', ink: '#141821',
    gold: '#ffc23c', wood: '#a9783f', flame: '#ff8c1a', sky: '#6fa8dc',
    leaf: '#3f6b33', bone: '#d8cfc0', shadow: '#2a2118',

    /* material tones the illustrations lean on */
    mortar: '#584f45', iron: '#5c6068', smoke: '#4a4a52', brass: '#c9a24a', glass: '#9fd2e8',
    ember: '#ffd23c', charcoal: '#241d18', linen: '#e4dcc6', hide: '#9c6b3f',
    foliageDark: '#2c4a26', foliageLight: '#7fa64c', bark: '#5a4227',

    /* interface accents - these are the values in styles.css :root */
    bg0: '#0b0e14', bg1: '#171c26', bg2: '#1f2531', bg3: '#2a3140', bg4: '#38404f',
    line: '#39414f', lineSoft: '#2b3240', dim: '#98a0ad', faint: '#6c7686',
    accent: '#ffc23c', good: '#7fae4f', warn: '#e0912a', bad: '#d4553f',
    cold: '#7fb4e0', hot: '#e08a5a'
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
     Canvases
     ------------------------------------------------------------------ */

  function makeCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
    var g = c.getContext('2d');
    smooth(g, true);
    c.ox = 0; c.oy = 0;
    return c;
  }

  /* Sprites are downscaled on screen, so every composite step inside
     this file - rotations, mirrors, tints, blurs - wants the smooth
     path. Icons ask for the other one. */
  function smooth(g, on) {
    g.imageSmoothingEnabled = !!on;
    if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = on ? 'high' : 'low';
    return g;
  }

  function ctxOf(c) { return smooth(c.getContext('2d'), true); }

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

  var shadeMemo = Object.create(null);

  /* f > 0 lightens toward white, f < 0 darkens toward black.

     The factor is rounded to a hundredth before it becomes a cache key.
     Half the painters below shade by a random amount - a plank is a
     little lighter than its neighbour - and without the rounding every
     one of those calls would add a permanent entry to this table. A
     hundredth of a step is far below what the eye resolves, and it caps
     the table at a couple of hundred entries per colour. */
  function shade(c, f) {
    f = Math.round(f * 100) / 100;
    var k = c + '|' + f;
    var hit = shadeMemo[k];
    if (hit) return hit;
    var p = parse(c), t = f < 0 ? 0 : 255, a = f < 0 ? -f : f;
    return (shadeMemo[k] = toHex(
      p[0] + (t - p[0]) * a, p[1] + (t - p[1]) * a, p[2] + (t - p[2]) * a));
  }

  function mix(a, b, t) {
    var p = parse(a), q = parse(b);
    return toHex(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t);
  }

  var rgbaMemo = Object.create(null);

  /* Alpha is rounded for the same reason the shade factor is. */
  function rgba(c, a) {
    a = Math.round(a * 100) / 100;
    var k = c + '|' + a;
    var hit = rgbaMemo[k];
    if (hit) return hit;
    var p = parse(c);
    return (rgbaMemo[k] = 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')');
  }

  /* Pull a colour toward the grey of dead tissue and dry stone. Used by
     corpses and downed animals, which must not read as living ones. */
  function drained(c) { return mix(c, '#7a7068', 0.45); }

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

  /* rnd() in a range, and a signed one centred on zero. Both read
     better than the same arithmetic spelled out forty times. */
  function rr(rnd, lo, hi) { return lo + rnd() * (hi - lo); }
  function rs(rnd, amp) { return (rnd() * 2 - 1) * amp; }
  function ri(rnd, lo, hi) { return lo + ((rnd() * (hi - lo + 1)) | 0); }

  /* ------------------------------------------------------------------
     Flat-pixel primitives

     These are exactly the old 16-pixel vocabulary, kept because UI icons
     are still pixel art and because an axis-aligned rectangle is an
     axis-aligned rectangle at any resolution. World sprites use them for
     hard edges and the shape vocabulary below for everything else.
     ------------------------------------------------------------------ */

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
     pixels rather than an anti-aliased curve. Icons only. */
  function pellipse(g, cx, cy, rx, ry, c) {
    g.fillStyle = c;
    for (var y = -ry; y <= ry; y++) {
      var w = Math.round(rx * Math.sqrt(Math.max(0, 1 - (y * y) / (ry * ry))));
      if (w > 0) g.fillRect(Math.round(cx - w), Math.round(cy + y), w * 2, 1);
    }
  }

  function pdisc(g, cx, cy, r, c) { pellipse(g, cx, cy, r, r, c); }

  function dashedBox(g, w, h, c) {
    g.fillStyle = c;
    var step = Math.max(3, Math.round(w / 5));
    var len = Math.max(2, (step * 0.62) | 0);
    var t = Math.max(1, Math.round(w / 32));
    for (var x = 0; x < w; x += step) { g.fillRect(x, 0, len, t); g.fillRect(x, h - t, len, t); }
    for (var y = 0; y < h; y += step) { g.fillRect(0, y, t, len); g.fillRect(w - t, y, t, len); }
  }

  /* ------------------------------------------------------------------
     Shape vocabulary - the part that makes this not pixel art
     ------------------------------------------------------------------ */

  function ell(g, cx, cy, rx, ry, rot, c) {
    g.beginPath();
    g.ellipse(cx, cy, Math.max(0.01, rx), Math.max(0.01, ry), rot || 0, 0, TAU);
    g.fillStyle = c;
    g.fill();
  }

  function circle(g, cx, cy, r, c) { ell(g, cx, cy, r, r, 0, c); }

  function ring(g, cx, cy, r, w, c) {
    g.beginPath();
    g.arc(cx, cy, Math.max(0.01, r), 0, TAU);
    g.strokeStyle = c; g.lineWidth = w; g.stroke();
  }

  /* Rounded rectangle as a path, built from arcs so it does not need
     ctx.roundRect - which is recent enough that a browser without it is
     still a browser someone might open this in. */
  function rrectPath(g, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y);
    g.arcTo(x + w, y, x + w, y + r, r);
    g.lineTo(x + w, y + h - r);
    g.arcTo(x + w, y + h, x + w - r, y + h, r);
    g.lineTo(x + r, y + h);
    g.arcTo(x, y + h, x, y + h - r, r);
    g.lineTo(x, y + r);
    g.arcTo(x, y, x + r, y, r);
    g.closePath();
  }

  function rrect(g, x, y, w, h, r, c) {
    rrectPath(g, x, y, w, h, r);
    g.fillStyle = c; g.fill();
  }

  function rrectLine(g, x, y, w, h, r, c, lw) {
    rrectPath(g, x, y, w, h, r);
    g.strokeStyle = c; g.lineWidth = lw || 1; g.stroke();
  }

  /* A polygon from a flat [x0,y0,x1,y1,...] array. */
  function poly(g, pts, c) {
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.closePath();
    g.fillStyle = c; g.fill();
  }

  function stroke(g, pts, c, w, cap) {
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.strokeStyle = c; g.lineWidth = w || 1;
    g.lineCap = cap || 'round'; g.lineJoin = 'round';
    g.stroke();
    g.lineCap = 'butt';
  }

  /* A quadratic whip: one control point, which is all a blade of grass,
     a wisp of smoke or a strand of wood grain ever needs. */
  function whip(g, x0, y0, cxp, cyp, x1, y1, c, w) {
    g.beginPath();
    g.moveTo(x0, y0);
    g.quadraticCurveTo(cxp, cyp, x1, y1);
    g.strokeStyle = c; g.lineWidth = w || 1;
    g.lineCap = 'round';
    g.stroke();
    g.lineCap = 'butt';
  }

  /* ------------------------------------------------------------------
     Gradients and soft edges

     Nothing here uses ctx.filter: it is still missing or slow in enough
     places that a radial gradient is the honest way to get a soft edge.
     ------------------------------------------------------------------ */

  function linGrad(g, x0, y0, x1, y1, stops) {
    var gr = g.createLinearGradient(x0, y0, x1, y1);
    for (var i = 0; i < stops.length; i += 2) gr.addColorStop(stops[i], stops[i + 1]);
    return gr;
  }

  function radGrad(g, cx, cy, r0, r1, stops) {
    var gr = g.createRadialGradient(cx, cy, Math.max(0, r0), cx, cy, Math.max(0.01, r1));
    for (var i = 0; i < stops.length; i += 2) gr.addColorStop(stops[i], stops[i + 1]);
    return gr;
  }

  function gradRect(g, x, y, w, h, grad) { g.fillStyle = grad; g.fillRect(x, y, w, h); }

  /* A blob with a feathered edge: the workhorse behind smoke, glow,
     contact shadows and the mottling on concrete. `hard` is the
     fraction of the radius that stays at full strength. */
  function blob(g, cx, cy, r, color, alpha, hard) {
    if (r <= 0) return;
    hard = hard === undefined ? 0.25 : hard;
    g.fillStyle = radGrad(g, cx, cy, 0, r, [
      0, rgba(color, alpha), hard, rgba(color, alpha),
      1, rgba(color, 0)
    ]);
    g.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  /* The same thing squashed, for shadows on the ground. */
  function blobEll(g, cx, cy, rx, ry, color, alpha, hard) {
    if (rx <= 0 || ry <= 0) return;
    g.save();
    g.translate(cx, cy);
    g.scale(1, ry / rx);
    blob(g, 0, 0, rx, color, alpha, hard);
    g.restore();
  }

  /* ------------------------------------------------------------------
     Material grain

     Per-pixel noise, built as an ImageData on a shared scratch canvas
     and composited in one drawImage. No getImageData anywhere: nothing
     is ever read back, which keeps this fast and keeps the canvas out
     of any tainting question on file://.
     ------------------------------------------------------------------ */

  var NOISE = 64;
  var noiseTiles = null;

  /* Four tiles of per-pixel noise, built once and then stamped wherever
     grain is wanted. Filling a fresh ImageData for every sprite is an
     honest way to do this and a slow one: a few hundred sprites is over
     a million pixel writes at boot, for noise nobody can tell apart.
     Four tiles, stamped at a random offset, cannot be told apart from
     four hundred once they are sitting under a wall at 30% opacity. */
  function noiseTile(i) {
    if (!noiseTiles) {
      noiseTiles = [];
      var rnd = seeded(0x9e3779b9);
      for (var t = 0; t < 4; t++) {
        var c = makeCanvas(NOISE, NOISE), cg = c.getContext('2d');
        var img = cg.createImageData(NOISE, NOISE);
        var d = img.data;
        for (var k = 0, n = NOISE * NOISE; k < n; k++) {
          var o = k << 2, v = rnd() - 0.5;
          var lum = v < 0 ? 0 : 255;
          d[o] = lum; d[o + 1] = lum; d[o + 2] = lum;
          d[o + 3] = (Math.min(1, Math.abs(v) * 2) * 255) | 0;
        }
        cg.putImageData(img, 0, 0);
        noiseTiles.push(c);
      }
    }
    return noiseTiles[i & 3];
  }

  /* `mode` picks how the grain meets the paint underneath: 'overlay'
     for material texture that keeps the hue, 'source-atop' to spatter
     an actual colour inside whatever is already drawn. */
  function grain(g, rnd, x, y, w, h, alpha, mode) {
    w = Math.round(w); h = Math.round(h);
    if (w <= 0 || h <= 0) return;
    var tile = noiseTile((rnd() * 4) | 0);
    var ox = (rnd() * NOISE) | 0, oy = (rnd() * NOISE) | 0;
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.globalAlpha = alpha;
    g.globalCompositeOperation = mode || 'overlay';
    for (var yy = -oy; yy < h; yy += NOISE) {
      for (var xx = -ox; xx < w; xx += NOISE) g.drawImage(tile, x + xx, y + yy);
    }
    g.restore();
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
  }

  /* Coarser than grain(): blotches a few pixels across, which is what
     reads as clods of earth or flecks in stone once the tile is
     downscaled to 32 on screen. */
  function flecks(g, rnd, n, x, y, w, h, colors, rmin, rmax, alpha) {
    g.globalAlpha = alpha === undefined ? 1 : alpha;
    for (var i = 0; i < n; i++) {
      var fx = x + rnd() * w, fy = y + rnd() * h;
      var r = rr(rnd, rmin, rmax);
      ell(g, fx, fy, r, r * rr(rnd, 0.6, 1), rnd() * TAU,
        colors[(rnd() * colors.length) | 0]);
    }
    g.globalAlpha = 1;
  }

  /* An inner bevel: light where the north-west light lands, shadow on
     the far side. `sides` is a 4-bit mask N/E/S/W of which edges to
     treat as an outside edge of the mass. */
  function bevel(g, x, y, w, h, d, lightC, darkC, sides, alpha) {
    if (sides === undefined) sides = 15;
    g.globalAlpha = alpha === undefined ? 1 : alpha;
    if (sides & 1) gradRect(g, x, y, w, d, linGrad(g, 0, y, 0, y + d, [0, rgba(lightC, 1), 1, rgba(lightC, 0)]));
    if (sides & 8) gradRect(g, x, y, d, h, linGrad(g, x, 0, x + d, 0, [0, rgba(lightC, 1), 1, rgba(lightC, 0)]));
    if (sides & 4) gradRect(g, x, y + h - d, w, d, linGrad(g, 0, y + h - d, 0, y + h, [0, rgba(darkC, 0), 1, rgba(darkC, 1)]));
    if (sides & 2) gradRect(g, x + w - d, y, d, h, linGrad(g, x + w - d, 0, x + w, 0, [0, rgba(darkC, 0), 1, rgba(darkC, 1)]));
    g.globalAlpha = 1;
  }

  /* A specular sweep across a flat panel: the diagonal band of sky a
     solar cell or a steel plate reflects. */
  function sheen(g, x, y, w, h, alpha, tilt) {
    tilt = tilt === undefined ? 0.55 : tilt;
    g.globalCompositeOperation = 'screen';
    gradRect(g, x, y, w, h, linGrad(g, x, y, x + w * tilt, y + h, [
      0, rgba('#ffffff', 0), 0.34, rgba('#ffffff', alpha),
      0.46, rgba('#ffffff', alpha * 0.35), 0.6, rgba('#ffffff', 0)
    ]));
    g.globalCompositeOperation = 'source-over';
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

     Fourteen surfaces, four variants each, and every one has to tile
     against itself and against the other thirteen. That rules out
     directional gradients on natural ground - two neighbouring tiles
     lit from opposite corners show the seam immediately - so the
     natural terrains are built from a flat base, soft mottling that
     falls where the seed puts it, and per-pixel grain. Built floors are
     the opposite case: a plank or a slab is a manufactured unit, so
     their edges are supposed to line up with the tile grid, and they do.
     ------------------------------------------------------------------ */

  /* Flat base plus a few wide, soft patches. Seamless because nothing
     in it knows where the tile edge is. */
  function groundBase(g, rnd, c1, c2, patches) {
    fill(g, 0, 0, PX, PX, c1);
    for (var i = 0; i < patches; i++) {
      blob(g, rr(rnd, -8, PX + 8), rr(rnd, -8, PX + 8), rr(rnd, 14, 30),
        rnd() < 0.5 ? c2 : shade(c1, -0.09), rr(rnd, 0.16, 0.34), 0.05);
    }
  }

  /* A pebble with the contact shadow that makes it sit on the ground
     rather than float above it. */
  function pebble(g, rnd, x, y, r, c) {
    ell(g, x + r * 0.35, y + r * 0.4, r * 1.05, r * 0.8, 0, rgba('#000000', 0.28));
    var rot = rnd() * TAU;
    ell(g, x, y, r, r * rr(rnd, 0.72, 0.95), rot, c);
    ell(g, x - r * 0.28, y - r * 0.3, r * 0.45, r * 0.3, rot, shade(c, 0.22));
  }

  function paintSoil(g, rnd, c1, c2, rich) {
    groundBase(g, rnd, c1, c2, 5);
    /* Clods: a dark under-shape with a lit crown, which is the whole
       trick for reading broken earth from directly above. */
    for (var i = 0; i < (rich ? 30 : 24); i++) {
      var x = rnd() * PX, y = rnd() * PX, r = rr(rnd, 2, 5.5);
      ell(g, x + 0.8, y + 0.9, r, r * 0.8, 0, rgba(shade(c1, -0.4), 0.35));
      ell(g, x, y, r, r * 0.78, rnd() * TAU, shade(c1, rr(rnd, -0.1, 0.05)));
      ell(g, x - r * 0.25, y - r * 0.3, r * 0.5, r * 0.3, 0, rgba(shade(c1, 0.22), 0.5));
    }
    if (rich) {
      for (var f = 0; f < 6; f++) {
        var fx = rnd() * PX, fy = rnd() * PX;
        whip(g, fx, fy, fx + rs(rnd, 9), fy + rs(rnd, 9), fx + rs(rnd, 16), fy + rs(rnd, 16),
          rgba(shade(c1, 0.3), 0.3), 1);
      }
    }
    for (var s = 0; s < (rich ? 2 : 5); s++) {
      pebble(g, rnd, rr(rnd, 4, PX - 4), rr(rnd, 4, PX - 4), rr(rnd, 1.6, 3), '#8b8278');
    }
    grain(g, rnd, 0, 0, PX, PX, 0.34, 'overlay');
  }

  function paintGrassTerrain(g, rnd, c1, c2) {
    /* Soil shows through between the blades, which is what stops a
       grass field reading as a flat green rectangle. */
    groundBase(g, rnd, shade(mix(c1, P.soil, 0.45), -0.05), shade(c1, -0.2), 4);
    var tones = [c1, c2, shade(c1, -0.16), mix(c1, P.foliageLight, 0.4)];
    for (var i = 0; i < 132; i++) {
      var x = rnd() * PX, y = rr(rnd, 3, PX + 3);
      var h = rr(rnd, 5, 12), lean = rs(rnd, 4.5);
      whip(g, x, y, x + lean * 0.4, y - h * 0.6, x + lean, y - h,
        tones[(rnd() * tones.length) | 0], rr(rnd, 0.9, 1.7));
    }
    /* A last pass of pale tips catches the light and gives the mat some
       depth instead of one uniform height. */
    for (var t = 0; t < 26; t++) {
      var tx = rnd() * PX, ty = rr(rnd, 6, PX);
      whip(g, tx, ty, tx + rs(rnd, 2), ty - 5, tx + rs(rnd, 5), ty - 9,
        rgba(shade(c2, 0.26), 0.75), 1);
    }
    grain(g, rnd, 0, 0, PX, PX, 0.16, 'overlay');
  }

  function paintSand(g, rnd, c1, c2) {
    groundBase(g, rnd, c1, c2, 4);
    /* Wind ripples: a pale crest with its own trough shadow just below,
       which is the only reason a ripple reads as relief. */
    for (var i = 0; i < 6; i++) {
      var y = rr(rnd, 2, PX - 2), amp = rr(rnd, 3, 7);
      whip(g, -6, y + 2, PX * 0.5, y + amp + 2, PX + 6, y + 2, rgba(shade(c1, -0.22), 0.4), 2.4);
      whip(g, -6, y, PX * 0.5, y + amp, PX + 6, y, rgba(shade(c1, 0.26), 0.55), 1.8);
    }
    flecks(g, rnd, 26, 0, 0, PX, PX, [shade(c1, 0.18), shade(c1, -0.14)], 0.8, 2, 0.5);
    grain(g, rnd, 0, 0, PX, PX, 0.42, 'overlay');
  }

  function paintGravel(g, rnd, c1, c2) {
    groundBase(g, rnd, shade(c1, -0.18), shade(c1, -0.08), 4);
    var tones = [c1, c2, shade(c1, 0.16), shade(c1, -0.12), mix(c1, P.sand, 0.25)];
    for (var i = 0; i < 46; i++) {
      pebble(g, rnd, rr(rnd, -2, PX + 2), rr(rnd, -2, PX + 2), rr(rnd, 1.8, 4.4),
        tones[(rnd() * tones.length) | 0]);
    }
    grain(g, rnd, 0, 0, PX, PX, 0.3, 'overlay');
  }

  function paintMud(g, rnd, c1, c2) {
    groundBase(g, rnd, c1, c2, 6);
    for (var i = 0; i < 14; i++) {
      var x = rnd() * PX, y = rnd() * PX, r = rr(rnd, 4, 10);
      ell(g, x, y, r, r * rr(rnd, 0.45, 0.75), rnd() * TAU, rgba(shade(c1, -0.35), 0.5));
    }
    /* Wet sheen: standing water reflects the sky, so the highlights are
       cool and sit in the hollows rather than on the ridges. */
    for (var s = 0; s < 5; s++) {
      var sx = rr(rnd, 6, PX - 6), sy = rr(rnd, 6, PX - 6), sr = rr(rnd, 5, 11);
      blobEll(g, sx, sy, sr, sr * 0.5, mix(P.sky, '#ffffff', 0.35), rr(rnd, 0.16, 0.3), 0.1);
      ell(g, sx - sr * 0.3, sy - sr * 0.15, sr * 0.34, sr * 0.11, rr(rnd, -0.4, 0.4),
        rgba('#ffffff', 0.4));
    }
    grain(g, rnd, 0, 0, PX, PX, 0.26, 'overlay');
  }

  function paintMarsh(g, rnd, c1, c2) {
    groundBase(g, rnd, c1, c2, 5);
    for (var i = 0; i < 7; i++) {
      var x = rnd() * PX, y = rnd() * PX, r = rr(rnd, 7, 15);
      blobEll(g, x, y, r, r * 0.6, mix(P.water, c1, 0.35), rr(rnd, 0.3, 0.55), 0.35);
      ell(g, x - r * 0.2, y - r * 0.2, r * 0.3, r * 0.12, 0, rgba('#ffffff', 0.22));
    }
    var reed = shade(c1, 0.22), reedDark = shade(c1, -0.25);
    for (var k = 0; k < 30; k++) {
      var rx = rnd() * PX, ry = rr(rnd, 8, PX + 4), h = rr(rnd, 8, 18);
      whip(g, rx, ry, rx + rs(rnd, 3), ry - h * 0.6, rx + rs(rnd, 7), ry - h,
        rnd() < 0.4 ? reedDark : reed, rr(rnd, 1, 1.8));
    }
    grain(g, rnd, 0, 0, PX, PX, 0.2, 'overlay');
  }

  function paintWater(g, rnd, c1, c2, deep, variant) {
    fill(g, 0, 0, PX, PX, c1);
    /* Depth banding: broad soft patches of lighter and darker water so
       the surface has somewhere to shelve, without a straight edge
       anywhere that could line up into a grid across the map. */
    for (var i = 0; i < 7; i++) {
      blob(g, rr(rnd, -10, PX + 10), rr(rnd, -10, PX + 10), rr(rnd, 16, 34),
        rnd() < 0.5 ? c2 : shade(c1, deep ? -0.22 : 0.16), rr(rnd, 0.2, 0.42), 0.05);
    }
    if (!deep) {
      /* Shallow water is lit from a different quarter in each variant.
         Scattered across the map that reads as sun dappling a sandy
         bottom; a fixed direction would read as a tile edge. */
      var dirs = [[0, -1], [-1, 0], [1, 0], [0, 1]][variant & 3];
      gradRect(g, 0, 0, PX, PX, linGrad(g,
        PX / 2 - dirs[0] * PX / 2, PX / 2 - dirs[1] * PX / 2,
        PX / 2 + dirs[0] * PX / 2, PX / 2 + dirs[1] * PX / 2,
        [0, rgba(mix(c2, P.sand, 0.45), 0.34), 1, rgba(c1, 0)]));
    }
    /* Caustics: the bright net of light refracted onto the bottom. */
    var lit = mix(c2, '#ffffff', deep ? 0.28 : 0.45);
    for (var k = 0; k < (deep ? 7 : 11); k++) {
      var x = rnd() * PX, y = rnd() * PX, w = rr(rnd, 8, 20);
      whip(g, x - w, y, x, y + rs(rnd, 5), x + w, y + rs(rnd, 3),
        rgba(lit, rr(rnd, 0.1, 0.24)), rr(rnd, 1.2, 2.6));
    }
    /* Two specular glints - the sun itself, not the sky. */
    for (var s = 0; s < 2; s++) {
      var gx = rr(rnd, 8, PX - 8), gy = rr(rnd, 8, PX - 8);
      blobEll(g, gx, gy, rr(rnd, 5, 9), rr(rnd, 1.6, 3), '#ffffff', 0.3, 0.15);
      ell(g, gx, gy, rr(rnd, 2, 3.4), 0.9, rs(rnd, 0.3), rgba('#ffffff', 0.7));
    }
    grain(g, rnd, 0, 0, PX, PX, 0.1, 'overlay');
  }

  function paintRockFloor(g, rnd, c1, c2) {
    fill(g, 0, 0, PX, PX, c1);
    /* Chiselled facets: a handful of irregular plates at slightly
       different angles to the light, the way a mined-out floor breaks. */
    for (var i = 0; i < 7; i++) {
      var cx = rnd() * PX, cy = rnd() * PX, n = ri(rnd, 5, 7), pts = [];
      var r0 = rr(rnd, 9, 20);
      for (var k = 0; k < n; k++) {
        var a = (k / n) * TAU + rs(rnd, 0.3), rk = r0 * rr(rnd, 0.6, 1.15);
        pts.push(cx + Math.cos(a) * rk, cy + Math.sin(a) * rk);
      }
      g.globalAlpha = rr(rnd, 0.3, 0.6);
      poly(g, pts, shade(c1, rr(rnd, -0.16, 0.13)));
      g.globalAlpha = 1;
    }
    /* Cracks, with a lit lip on the north-west side of each. */
    for (var c = 0; c < 4; c++) {
      var x0 = rr(rnd, -4, PX + 4), y0 = rr(rnd, -4, PX + 4);
      var x1 = x0 + rs(rnd, 26), y1 = y0 + rs(rnd, 26);
      var mx = (x0 + x1) / 2 + rs(rnd, 8), my = (y0 + y1) / 2 + rs(rnd, 8);
      whip(g, x0, y0, mx, my, x1, y1, rgba(shade(c1, -0.45), 0.6), 1.6);
      whip(g, x0 - 1, y0 - 1, mx - 1, my - 1, x1 - 1, y1 - 1, rgba(shade(c2, 0.3), 0.3), 1);
    }
    flecks(g, rnd, 34, 0, 0, PX, PX, [shade(c1, 0.2), shade(c1, -0.22), c2], 0.8, 2.4, 0.55);
    grain(g, rnd, 0, 0, PX, PX, 0.33, 'overlay');
  }

  /* ---------- built floors ---------- */

  function paintWoodFloor(g, rnd, c1, c2, variant) {
    var dark = shade(c1, -0.42), seam = shade(c1, -0.55);
    fill(g, 0, 0, PX, PX, dark);
    /* Four courses of plank, sixteen pixels each, so the seams line up
       across the whole floor rather than stopping at the tile. */
    for (var row = 0; row < 4; row++) {
      var y = row * 16, tone = shade(c1, rr(rnd, -0.07, 0.07));
      fill(g, 0, y + 1, PX, 14, tone);
      gradRect(g, 0, y + 1, PX, 14, linGrad(g, 0, y + 1, 0, y + 15,
        [0, rgba('#ffffff', 0.13), 0.35, rgba('#ffffff', 0), 1, rgba('#000000', 0.16)]));
      /* Grain runs the length of the plank and wanders a little. */
      for (var k = 0; k < 6; k++) {
        var gy = y + rr(rnd, 2, 14);
        whip(g, -4, gy, PX / 2, gy + rs(rnd, 2.2), PX + 4, gy + rs(rnd, 1.6),
          rgba(rnd() < 0.35 ? shade(c1, 0.2) : shade(c1, -0.22), rr(rnd, 0.2, 0.42)),
          rr(rnd, 0.7, 1.5));
      }
      /* One butt joint per course; where it falls moves with the
         variant, so a floor does not grow a column of end grain. */
      var jx = 8 + ((variant * 13 + row * 21) % 48);
      fill(g, jx, y + 1, 2, 14, seam);
      fill(g, jx + 2, y + 1, 1, 14, rgba(shade(c1, 0.3), 0.5));
      for (var e = 0; e < 4; e++) {
        whip(g, jx - 5, y + 3 + e * 3, jx - 2, y + 4 + e * 3, jx - 1, y + 3 + e * 3,
          rgba(shade(c1, -0.3), 0.4), 0.8);
      }
      fill(g, 0, y, PX, 1, seam);
      fill(g, 0, y + 15, PX, 1, rgba('#000000', 0.35));
    }
    /* Two nail heads per course line, sunk and catching the light. */
    for (var n = 0; n < 6; n++) {
      var nx = rr(rnd, 4, PX - 4), ny = (((rnd() * 4) | 0) * 16) + 3;
      circle(g, nx, ny, 1.3, shade(P.iron, -0.2));
      circle(g, nx - 0.4, ny - 0.4, 0.7, shade(P.iron, 0.4));
    }
    grain(g, rnd, 0, 0, PX, PX, 0.16, 'overlay');
  }

  function paintStoneFloor(g, rnd, c1, c2) {
    var mortar = shade(mix(c1, P.mortar, 0.5), -0.2);
    fill(g, 0, 0, PX, PX, mortar);
    /* Four cut slabs to the tile, inset by one pixel so the joints line
       up with the neighbouring tile's slabs and form one grid. */
    for (var sy = 0; sy < 2; sy++) {
      for (var sx = 0; sx < 2; sx++) {
        var x = 1 + sx * 32, y = 1 + sy * 32, s = 30;
        var tone = shade(c1, rr(rnd, -0.08, 0.08));
        fill(g, x, y, s, s, tone);
        gradRect(g, x, y, s, s, linGrad(g, x, y, x + s, y + s,
          [0, rgba('#ffffff', 0.12), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.14)]));
        flecks(g, rnd, 16, x, y, s, s, [shade(tone, 0.22), shade(tone, -0.2), c2], 0.7, 2, 0.5);
        /* The cut edge: lit on the north-west, shadowed on the far side. */
        bevel(g, x, y, s, s, 2.5, rgba('#ffffff', 0.35), rgba('#000000', 0.42), 15, 1);
        if (rnd() < 0.45) {
          var hx = x + rr(rnd, 4, s - 8), hy = y + rr(rnd, 4, s - 8);
          whip(g, hx, hy, hx + rs(rnd, 6), hy + rs(rnd, 6), hx + rs(rnd, 11), hy + rs(rnd, 11),
            rgba(shade(tone, -0.4), 0.45), 1);
        }
      }
    }
    grain(g, rnd, 0, 0, PX, PX, 0.2, 'overlay');
  }

  function paintConcrete(g, rnd, c1, c2) {
    fill(g, 0, 0, PX, PX, c1);
    /* Float finish: broad, very soft patches where the trowel pulled
       the cream, plus the aggregate that shows through. */
    for (var i = 0; i < 9; i++) {
      blob(g, rr(rnd, -8, PX + 8), rr(rnd, -8, PX + 8), rr(rnd, 12, 28),
        rnd() < 0.5 ? shade(c1, 0.07) : shade(c2, -0.08), rr(rnd, 0.18, 0.34), 0.1);
    }
    for (var s = 0; s < 4; s++) {
      var ax = rr(rnd, 0, PX), ay = rr(rnd, 0, PX), r = rr(rnd, 12, 22);
      g.beginPath();
      g.arc(ax, ay, r, rr(rnd, 0, TAU), rr(rnd, 1.2, 2.6));
      g.strokeStyle = rgba('#ffffff', 0.07); g.lineWidth = 3; g.stroke();
    }
    flecks(g, rnd, 60, 0, 0, PX, PX,
      [shade(c1, -0.2), shade(c1, 0.16), shade(c2, -0.28)], 0.5, 1.5, 0.45);
    /* Control joints on the tile lines: a sawn groove with a lit lip. */
    fill(g, 0, 0, PX, 2, rgba('#000000', 0.22));
    fill(g, 0, 0, 2, PX, rgba('#000000', 0.22));
    fill(g, 0, 2, PX, 1, rgba('#ffffff', 0.14));
    fill(g, 2, 0, 1, PX, rgba('#ffffff', 0.14));
    grain(g, rnd, 0, 0, PX, PX, 0.24, 'overlay');
  }

  function paintSteelFloor(g, rnd, c1, c2) {
    fill(g, 0, 0, PX, PX, shade(c1, -0.45));
    rrect(g, 1, 1, PX - 2, PX - 2, 4, c1);
    /* Brushed metal: fine directional lines, then one broad sweep of
       reflected sky across the plate. */
    for (var i = 0; i < 54; i++) {
      var y = rr(rnd, 2, PX - 2);
      fill(g, 2, y, PX - 4, rr(rnd, 0.6, 1.2),
        rgba(rnd() < 0.5 ? '#ffffff' : '#000000', rr(rnd, 0.03, 0.09)));
    }
    sheen(g, 1, 1, PX - 2, PX - 2, 0.16, 0.8);
    bevel(g, 1, 1, PX - 2, PX - 2, 3, rgba('#ffffff', 0.4), rgba('#000000', 0.45), 15, 1);
    /* Rivets, one to a corner, each a dome: lit crown, dark seat. */
    var pos = [[7, 7], [PX - 7, 7], [7, PX - 7], [PX - 7, PX - 7]];
    for (var r = 0; r < 4; r++) {
      var rx = pos[r][0], ry = pos[r][1];
      circle(g, rx, ry + 0.8, 3, rgba('#000000', 0.4));
      circle(g, rx, ry, 2.6, shade(c1, -0.1));
      circle(g, rx - 0.7, ry - 0.8, 1.4, shade(c2, 0.4));
    }
    grain(g, rnd, 0, 0, PX, PX, 0.14, 'overlay');
  }

  function paintCarpet(g, rnd, c1, c2) {
    fill(g, 0, 0, PX, PX, shade(c1, -0.12));
    /* Woven pile: short strokes whose direction alternates by cell, so
       the light catches every other tuft and the weave reads. */
    for (var y = 0; y < PX; y += 4) {
      for (var x = 0; x < PX; x += 4) {
        var over = ((x >> 2) + (y >> 2)) & 1;
        var tone = shade(over ? c1 : c2, rr(rnd, -0.09, 0.12));
        if (over) {
          stroke(g, [x + 0.6, y + 2, x + 3.4, y + 2], tone, 2.6);
          fill(g, x + 0.6, y + 0.8, 2.8, 0.8, rgba('#ffffff', 0.1));
        } else {
          stroke(g, [x + 2, y + 0.6, x + 2, y + 3.4], tone, 2.6);
          fill(g, x + 0.8, y + 0.6, 0.8, 2.8, rgba('#ffffff', 0.08));
        }
      }
    }
    for (var f = 0; f < 22; f++) {
      var fx = rnd() * PX, fy = rnd() * PX;
      whip(g, fx, fy, fx + rs(rnd, 2), fy - 2, fx + rs(rnd, 3), fy - 3.5,
        rgba(shade(c1, 0.3), 0.35), 1);
    }
    grain(g, rnd, 0, 0, PX, PX, 0.2, 'overlay');
  }

  function paintTerrain(g, rnd, def, variant) {
    var c1 = def.color, c2 = def.color2 || shade(c1, 0.06);
    switch (def.id) {
      case 'soil': paintSoil(g, rnd, c1, c2, false); break;
      case 'richSoil': paintSoil(g, rnd, c1, c2, true); break;
      case 'gravel': paintGravel(g, rnd, c1, c2); break;
      case 'sand': paintSand(g, rnd, c1, c2); break;
      case 'mud': paintMud(g, rnd, c1, c2); break;
      case 'marsh': paintMarsh(g, rnd, c1, c2); break;
      case 'shallowWater': paintWater(g, rnd, c1, c2, false, variant); break;
      case 'deepWater': paintWater(g, rnd, c1, c2, true, variant); break;
      case 'rockFloor': paintRockFloor(g, rnd, c1, c2); break;
      case 'woodFloor': paintWoodFloor(g, rnd, c1, c2, variant); break;
      case 'stoneFloor': paintStoneFloor(g, rnd, c1, c2); break;
      case 'concreteFloor': paintConcrete(g, rnd, c1, c2); break;
      case 'steelFloor': paintSteelFloor(g, rnd, c1, c2); break;
      case 'carpet': paintCarpet(g, rnd, c1, c2); break;
      default:
        /* A terrain this file has not met yet still has to look like
           ground rather than like a bug: grass if it grows things,
           grit if it does not. */
        if (def.terrainCategory === 'water') paintWater(g, rnd, c1, c2, true, variant);
        else if (def.supportsPlants) paintGrassTerrain(g, rnd, c1, c2);
        else paintGravel(g, rnd, c1, c2);
    }
  }

  /* ------------------------------------------------------------------
     Walls

     A wall sprite is a face plus edges. The 4-bit mask says which
     orthogonal neighbours are also wall; the face is drawn across the
     whole tile and then the open sides get treated as the outside of
     the mass - lit on the north and west, shadowed on the south and
     east. A run of wall therefore reads as one block of masonry with
     thickness, instead of sixteen tiles with outlines.
     ------------------------------------------------------------------ */

  /* d is how deep the light and shadow reach in from an open side. */
  function wallEdges(g, mask, w, h, lightA, darkA) {
    var d = 7;
    if (!(mask & 1)) {
      gradRect(g, 0, 0, w, d, linGrad(g, 0, 0, 0, d,
        [0, rgba('#ffffff', lightA), 1, rgba('#ffffff', 0)]));
      fill(g, 0, 0, w, 1.2, rgba('#ffffff', lightA * 0.9));
    }
    if (!(mask & 8)) {
      gradRect(g, 0, 0, d, h, linGrad(g, 0, 0, d, 0,
        [0, rgba('#ffffff', lightA * 0.8), 1, rgba('#ffffff', 0)]));
      fill(g, 0, 0, 1.2, h, rgba('#ffffff', lightA * 0.7));
    }
    if (!(mask & 4)) {
      gradRect(g, 0, h - d - 2, w, d + 2, linGrad(g, 0, h - d - 2, 0, h,
        [0, rgba('#000000', 0), 1, rgba('#000000', darkA)]));
    }
    if (!(mask & 2)) {
      gradRect(g, w - d - 2, 0, d + 2, h, linGrad(g, w - d - 2, 0, w, 0,
        [0, rgba('#000000', 0), 1, rgba('#000000', darkA * 0.85)]));
    }
    /* Where two neighbours meet, the corner between them is interior and
       must not keep the bright pixel an open side would have given it. */
    if ((mask & 1) && (mask & 8)) fill(g, 0, 0, 3, 3, rgba('#000000', 0.12));
    if ((mask & 1) && (mask & 2)) fill(g, w - 3, 0, 3, 3, rgba('#000000', 0.12));
  }

  /* One course of masonry: irregular blocks with mortar between them,
     each block chipped and bevelled to the same light. */
  function stoneCourse(g, rnd, y, rowH, w, base, offset) {
    var x = -offset;
    while (x < w) {
      var bw = rr(rnd, 17, 27);
      var bx = x + 1.2, by = y + 1.2, bh = rowH - 2.4;
      var tone = shade(base, rr(rnd, -0.12, 0.11));
      rrect(g, bx, by, bw - 2.4, bh, 2.2, tone);
      rrectPath(g, bx, by, bw - 2.4, bh, 2.2);
      g.save(); g.clip();
      gradRect(g, bx, by, bw, bh, linGrad(g, bx, by, bx + bw * 0.5, by + bh,
        [0, rgba('#ffffff', 0.2), 0.45, rgba('#ffffff', 0), 1, rgba('#000000', 0.26)]));
      flecks(g, rnd, 7, bx, by, bw - 2.4, bh,
        [shade(tone, 0.2), shade(tone, -0.24)], 0.7, 2.2, 0.5);
      /* A chipped corner or a spall, which is what keeps a course of
         cut stone from reading as a row of identical buttons. */
      if (rnd() < 0.55) {
        var cx = rnd() < 0.5 ? bx : bx + bw - 2.4, cy = rnd() < 0.5 ? by : by + bh;
        circle(g, cx, cy, rr(rnd, 1.6, 3.4), rgba(shade(base, -0.5), 0.75));
      }
      if (rnd() < 0.4) {
        var kx = bx + rr(rnd, 3, bw - 6), ky = by + rr(rnd, 2, bh - 3);
        whip(g, kx, ky, kx + rs(rnd, 4), ky + rs(rnd, 3), kx + rs(rnd, 8), ky + rs(rnd, 5),
          rgba(shade(tone, -0.45), 0.5), 1);
      }
      g.restore();
      x += bw;
    }
  }

  function paintStoneWall(g, rnd, mask, base, w, h) {
    var mortar = shade(mix(base, P.mortar, 0.45), -0.35);
    fill(g, 0, 0, w, h, mortar);
    var rowH = 16;
    for (var row = 0, y = 0; y < h; y += rowH, row++) {
      stoneCourse(g, rnd, y, rowH, w, base, (row & 1) ? 11 : 0);
    }
    grain(g, rnd, 0, 0, w, h, 0.2, 'overlay');
    wallEdges(g, mask, w, h, 0.3, 0.34);
  }

  function paintPlankWall(g, rnd, mask, base, w, h) {
    var seam = shade(base, -0.55);
    fill(g, 0, 0, w, h, seam);
    /* Vertical boards, sixteen to the tile, each shaded like the round
       of a plank so the wall has a corrugation you can read from above. */
    for (var x = 0; x < w; x += 16) {
      var tone = shade(base, rr(rnd, -0.08, 0.08));
      fill(g, x + 1, 0, 14, h, tone);
      gradRect(g, x + 1, 0, 14, h, linGrad(g, x + 1, 0, x + 15, 0,
        [0, rgba('#ffffff', 0.16), 0.35, rgba('#ffffff', 0.03),
         0.75, rgba('#000000', 0.1), 1, rgba('#000000', 0.3)]));
      for (var k = 0; k < 7; k++) {
        var gx = x + rr(rnd, 2, 14);
        whip(g, gx, -4, gx + rs(rnd, 2.4), h / 2, gx + rs(rnd, 1.8), h + 4,
          rgba(rnd() < 0.35 ? shade(base, 0.22) : shade(base, -0.26), rr(rnd, 0.2, 0.45)),
          rr(rnd, 0.7, 1.5));
      }
      /* A knot: rings that deflect the grain, with a dark eye. */
      if (rnd() < 0.7) {
        var kx = x + rr(rnd, 5, 11), ky = rr(rnd, 8, h - 8);
        for (var r = 4.4; r > 0.8; r -= 1.1) {
          ell(g, kx, ky, r, r * 0.66, 0.3, rgba(shade(base, r > 2.4 ? -0.3 : -0.45), 0.55));
        }
        ell(g, kx, ky, 1.3, 0.9, 0.3, rgba(shade(base, -0.6), 0.85));
      }
      /* Nail heads, sunk into the board at the framing lines. */
      for (var n = 0; n < 2; n++) {
        var nx = x + 8 + rs(rnd, 3), ny = n ? h - 8 : 8;
        circle(g, nx, ny + 0.7, 2, rgba('#000000', 0.35));
        circle(g, nx, ny, 1.7, shade(P.iron, -0.05));
        circle(g, nx - 0.5, ny - 0.5, 0.8, shade(P.iron, 0.45));
      }
      fill(g, x, 0, 1, h, rgba('#000000', 0.45));
      fill(g, x + 15, 0, 1, h, rgba('#000000', 0.3));
    }
    grain(g, rnd, 0, 0, w, h, 0.16, 'overlay');
    wallEdges(g, mask, w, h, 0.26, 0.32);
  }

  function paintPlateWall(g, rnd, mask, base, w, h) {
    fill(g, 0, 0, w, h, shade(base, -0.5));
    rrect(g, 1.5, 1.5, w - 3, h - 3, 3, base);
    for (var i = 0; i < 46; i++) {
      var y = rr(rnd, 2, h - 2);
      fill(g, 2, y, w - 4, rr(rnd, 0.6, 1.3),
        rgba(rnd() < 0.5 ? '#ffffff' : '#000000', rr(rnd, 0.03, 0.1)));
    }
    sheen(g, 1.5, 1.5, w - 3, h - 3, 0.14, 0.7);
    /* A welded seam across the middle, because a plate this size would
       be two plates. */
    fill(g, 0, h / 2 - 1, w, 2, rgba('#000000', 0.28));
    fill(g, 0, h / 2 + 1, w, 1, rgba('#ffffff', 0.16));
    var pos = [[8, 8], [w - 8, 8], [8, h - 8], [w - 8, h - 8]];
    for (var r = 0; r < 4; r++) {
      circle(g, pos[r][0], pos[r][1] + 1, 3.2, rgba('#000000', 0.42));
      circle(g, pos[r][0], pos[r][1], 2.8, shade(base, -0.08));
      circle(g, pos[r][0] - 0.8, pos[r][1] - 0.9, 1.5, shade(base, 0.42));
    }
    bevel(g, 1.5, 1.5, w - 3, h - 3, 3.5, rgba('#ffffff', 0.35), rgba('#000000', 0.4), 15, 1);
    grain(g, rnd, 0, 0, w, h, 0.12, 'overlay');
    wallEdges(g, mask, w, h, 0.28, 0.3);
  }

  /* Natural rock. Strata first, then the blocky fracture on top of it,
     then ore if this is a compacted seam. */
  function paintRockWall(g, rnd, mask, base, ore, w, h) {
    fill(g, 0, 0, w, h, base);
    var tilt = rs(rnd, 0.28);
    for (var s = 0; s < 8; s++) {
      var y = rr(rnd, -6, h + 6), th = rr(rnd, 4, 13);
      g.save();
      g.translate(w / 2, y);
      g.rotate(tilt);
      gradRect(g, -w, -th / 2, w * 2, th, linGrad(g, 0, -th / 2, 0, th / 2,
        [0, rgba(shade(base, 0.22), 0), 0.5, rgba(shade(base, rnd() < 0.5 ? 0.18 : -0.2), 0.42),
         1, rgba(shade(base, -0.3), 0)]));
      g.restore();
    }
    for (var i = 0; i < 11; i++) {
      var cx = rnd() * w, cy = rnd() * h, n = ri(rnd, 5, 7), pts = [], r0 = rr(rnd, 7, 17);
      for (var k = 0; k < n; k++) {
        var a = (k / n) * TAU + rs(rnd, 0.35), rk = r0 * rr(rnd, 0.55, 1.2);
        pts.push(cx + Math.cos(a) * rk, cy + Math.sin(a) * rk);
      }
      g.globalAlpha = rr(rnd, 0.22, 0.5);
      poly(g, pts, shade(base, rr(rnd, -0.22, 0.2)));
      g.globalAlpha = 1;
    }
    for (var c = 0; c < 5; c++) {
      var x0 = rr(rnd, -4, w + 4), y0 = rr(rnd, -4, h + 4);
      var x1 = x0 + rs(rnd, 30), y1 = y0 + rs(rnd, 30);
      whip(g, x0, y0, (x0 + x1) / 2 + rs(rnd, 9), (y0 + y1) / 2 + rs(rnd, 9), x1, y1,
        rgba(shade(base, -0.5), 0.55), rr(rnd, 1.1, 2.1));
      whip(g, x0 - 1, y0 - 1.2, (x0 + x1) / 2 + rs(rnd, 9), (y0 + y1) / 2 - 1.2, x1 - 1, y1 - 1.2,
        rgba(shade(base, 0.3), 0.25), 1);
    }
    flecks(g, rnd, 40, 0, 0, w, h,
      [shade(base, 0.24), shade(base, -0.28)], 0.7, 2.4, 0.5);
    if (ore) {
      /* Ore sits in the rock as short bright seams with a specular
         crumb on each, so a steel vein is obvious from a screen away. */
      for (var o = 0; o < 13; o++) {
        var ox = rr(rnd, 4, w - 4), oy = rr(rnd, 4, h - 4);
        var orx = rr(rnd, 2.2, 5.5), ang = rnd() * TAU;
        ell(g, ox, oy, orx + 1, orx * 0.55 + 1, ang, rgba(shade(base, -0.45), 0.6));
        ell(g, ox, oy, orx, orx * 0.5, ang, ore);
        ell(g, ox - orx * 0.25, oy - orx * 0.2, orx * 0.4, orx * 0.2, ang,
          rgba(shade(ore, 0.5), 0.9));
        if (rnd() < 0.5) {
          blob(g, ox, oy, orx * 2.2, ore, 0.18, 0.05);
        }
      }
    }
    grain(g, rnd, 0, 0, w, h, 0.3, 'overlay');
    wallEdges(g, mask, w, h, 0.26, 0.36);
  }

  /* Built walls take their look from what they are built out of, which
     is exactly what a player expects when they pick the material. */
  function paintBuiltWall(g, rnd, mask, base, material, w, h) {
    if (material === 'wood') paintPlankWall(g, rnd, mask, base, w, h);
    else if (material === 'metal') paintPlateWall(g, rnd, mask, base, w, h);
    else paintStoneWall(g, rnd, mask, base, w, h);
  }

  /* ------------------------------------------------------------------
     Buildings, furniture and items

     Every painter takes (g, a). `a` carries the resolved colours, the
     pixel size of the footprint, the join mask, the power state and the
     sprite's own noise generator. Top-down art lives or dies on whether
     a thing is identifiable from directly above, so each of these has
     one silhouette feature that says what it is - a hob, a barrel, a
     screen - and the rest is material.
     ------------------------------------------------------------------ */

  /* A soft contact shadow under a rectangular object, offset the way the
     north-west light demands. */
  function softShade(g, x, y, w, h, r, alpha, spread) {
    spread = spread || 4;
    var step = alpha / spread;
    for (var i = spread; i >= 1; i--) {
      g.globalAlpha = step;
      rrect(g, x - i + 2.5, y - i + 3.5, w + i * 2, h + i * 2, r + i, '#000000');
    }
    g.globalAlpha = 1;
  }

  /* A slab of material with a bevel: the base of nearly every piece of
     furniture and every machine casing in the game. */
  function slab(g, x, y, w, h, r, c, depth) {
    rrect(g, x, y, w, h, r, c);
    rrectPath(g, x, y, w, h, r);
    g.save(); g.clip();
    bevel(g, x, y, w, h, depth || 4, rgba('#ffffff', 0.34), rgba('#000000', 0.4), 15, 1);
    g.restore();
    rrectLine(g, x, y, w, h, r, rgba('#000000', 0.45), 1.2);
  }

  /* What a stuffable thing is actually made of. Defs name their stuff
     by thing id, and the look splits three ways: boards, plate, block.
     A def with no stuff chosen yet falls back to the first material in
     its buildCost, which is the one the architect offers by default. */
  function materialKind(stuffId) {
    if (stuffId === 'wood') return 'wood';
    if (stuffId === 'steel' || stuffId === 'silver' || stuffId === 'components') return 'metal';
    if (stuffId === 'stoneBlocks' || stuffId === 'stoneChunk') return 'stone';
    return null;
  }

  function defaultStuff(def) {
    if (!def.stuffable || !def.buildCost) return null;
    for (var k in def.buildCost) return k;
    return null;
  }

  /* Wood grain inside whatever path is currently clipped. */
  function woodGrain(g, rnd, x, y, w, h, c, n, vertical) {
    for (var i = 0; i < n; i++) {
      if (vertical) {
        var gx = x + rnd() * w;
        whip(g, gx, y - 4, gx + rs(rnd, 3), y + h / 2, gx + rs(rnd, 2), y + h + 4,
          rgba(rnd() < 0.4 ? shade(c, 0.2) : shade(c, -0.26), rr(rnd, 0.18, 0.4)),
          rr(rnd, 0.7, 1.6));
      } else {
        var gy = y + rnd() * h;
        whip(g, x - 4, gy, x + w / 2, gy + rs(rnd, 3), x + w + 4, gy + rs(rnd, 2),
          rgba(rnd() < 0.4 ? shade(c, 0.2) : shade(c, -0.26), rr(rnd, 0.18, 0.4)),
          rr(rnd, 0.7, 1.6));
      }
    }
  }

  /* The texture a finished surface carries, chosen by what it is made
     of, so a steel table does not come out of the shop with wood grain
     on it. Expects the caller to have clipped to the surface already. */
  function surfaceTexture(g, a, x, y, w, h, vertical, n) {
    if (a.material === 'metal') {
      sheen(g, x, y, w, h, 0.14, 0.8);
      for (var i = 0; i < 26; i++) {
        var ly = y + a.rnd() * h;
        fill(g, x, ly, w, rr(a.rnd, 0.6, 1.2),
          rgba(a.rnd() < 0.5 ? '#ffffff' : '#000000', rr(a.rnd, 0.03, 0.09)));
      }
      grain(g, a.rnd, x, y, w, h, 0.1, 'overlay');
    } else if (a.material === 'stone') {
      flecks(g, a.rnd, Math.round(w * h / 90), x, y, w, h,
        [shade(a.c1, 0.2), shade(a.c1, -0.22), a.c2], 0.8, 2.6, 0.5);
      grain(g, a.rnd, x, y, w, h, 0.22, 'overlay');
    } else {
      woodGrain(g, a.rnd, x, y, w, h, a.c1, n || 9, vertical);
    }
  }

  /* Four legs, seen from above as the corners of the frame poking out
     from under the top. */
  function cornerLegs(g, a, inset, size) {
    var dk = shade(a.c1, -0.5);
    var pts = [[inset, inset], [a.w - inset - size, inset],
               [inset, a.h - inset - size], [a.w - inset - size, a.h - inset - size]];
    for (var i = 0; i < 4; i++) {
      rrect(g, pts[i][0] + 1.5, pts[i][1] + 2, size, size, 1.5, rgba('#000000', 0.35));
      rrect(g, pts[i][0], pts[i][1], size, size, 1.5, dk);
      rrect(g, pts[i][0] + 0.8, pts[i][1] + 0.8, size * 0.5, size * 0.5, 1, shade(a.c1, 0.1));
    }
  }

  /* The shared body of every workbench: shadow, frame, worktop, legs. */
  function benchBase(g, a, topCol) {
    var w = a.w, h = a.h;
    softShade(g, 3, 5, w - 6, h - 8, 4, 0.36);
    slab(g, 3, 3, w - 6, h - 6, 4, a.c1, 5);
    rrectPath(g, 3, 3, w - 6, h - 6, 4);
    g.save(); g.clip();
    surfaceTexture(g, a, 3, 3, w - 6, h - 6, false, 9);
    g.restore();
    var tx = 7, ty = 7, tw = w - 14, th = h - 16;
    slab(g, tx, ty, tw, th, 3, topCol || shade(a.c1, -0.16), 3);
    return { x: tx, y: ty, w: tw, h: th };
  }

  /* A machine casing: painted metal with a vented top and a bevel. */
  function casing(g, a, x, y, w, h, c) {
    softShade(g, x, y + 2, w, h, 4, 0.36);
    slab(g, x, y, w, h, 4, c, 5);
    rrectPath(g, x, y, w, h, 4);
    g.save(); g.clip();
    sheen(g, x, y, w, h, 0.1, 0.9);
    grain(g, a.rnd, x, y, w, h, 0.1, 'overlay');
    g.restore();
  }

  function vents(g, x, y, w, h, n, c) {
    var step = h / n;
    for (var i = 0; i < n; i++) {
      var vy = y + i * step;
      rrect(g, x, vy, w, Math.max(1.4, step * 0.5), 1, rgba('#000000', 0.42));
      fill(g, x, vy + Math.max(1.4, step * 0.5), w, 1, rgba('#ffffff', 0.16));
    }
    if (c) fill(g, x, y, w, 1, rgba(c, 0.3));
  }

  function bolt(g, x, y, r, c) {
    circle(g, x, y + 0.6, r, rgba('#000000', 0.4));
    circle(g, x, y, r * 0.85, shade(c, -0.05));
    circle(g, x - r * 0.28, y - r * 0.3, r * 0.42, shade(c, 0.45));
  }

  /* A warm light source seen from above: the core, the bloom, and the
     pool it throws on the ground around it. */
  function glow(g, x, y, r, c, strength) {
    g.globalCompositeOperation = 'lighter';
    blob(g, x, y, r * 2.4, c, 0.1 * strength, 0);
    blob(g, x, y, r * 1.35, c, 0.24 * strength, 0.05);
    blob(g, x, y, r * 0.7, mix(c, '#ffffff', 0.55), 0.45 * strength, 0.2);
    g.globalCompositeOperation = 'source-over';
  }

  var SPRITE = {

    wall: function (g, a) {
      paintBuiltWall(g, a.rnd, a.variant, a.c1, a.material, a.w, a.h);
    },
    rockWall: function (g, a) { paintRockWall(g, a.rnd, a.variant, a.c1, null, a.w, a.h); },
    oreWall: function (g, a) { paintRockWall(g, a.rnd, a.variant, a.c1, a.c2, a.w, a.h); },

    /* The leaves part along the run of wall the door sits in, which is
       what the join mask is actually telling us. */
    door: function (g, a) {
      var horiz = !!(a.variant & 10);
      var w = a.w, h = a.h, jamb = shade(a.c1, -0.45);
      var leaf = a.c1;

      function panel(g2, x, y, pw, ph) {
        slab(g2, x, y, pw, ph, 2, leaf, 4);
        rrectPath(g2, x, y, pw, ph, 2);
        g2.save(); g2.clip();
        surfaceTexture(g2, a, x, y, pw, ph, ph > pw, 7);
        g2.restore();
        /* A recessed panel, which is what makes a door a door. */
        var ix = x + pw * 0.22, iy = y + ph * 0.18;
        rrect(g2, ix, iy, pw * 0.56, ph * 0.64, 2, rgba('#000000', 0.16));
        rrectLine(g2, ix, iy, pw * 0.56, ph * 0.64, 2, rgba('#ffffff', 0.16), 1);
      }

      if (horiz) {
        fill(g, 0, 0, w, h, rgba('#000000', 0.25));
        fill(g, 0, 0, 7, h, jamb); fill(g, w - 7, 0, 7, h, jamb);
        fill(g, 6, 0, 1, h, rgba('#ffffff', 0.18));
        if (a.open) {
          panel(g, 7, 2, 12, h - 4);
          panel(g, w - 19, 2, 12, h - 4);
        } else {
          panel(g, 7, 2, (w - 14) / 2 - 1, h - 4);
          panel(g, w / 2 + 1, 2, (w - 14) / 2 - 1, h - 4);
          fill(g, w / 2 - 1, 2, 2, h - 4, rgba('#000000', 0.5));
          /* Handles either side of the meeting stile. */
          rrect(g, w / 2 - 8, h / 2 - 2, 5, 4, 2, a.c2);
          rrect(g, w / 2 + 3, h / 2 - 2, 5, 4, 2, a.c2);
        }
      } else {
        fill(g, 0, 0, w, h, rgba('#000000', 0.25));
        fill(g, 0, 0, w, 7, jamb); fill(g, 0, h - 7, w, 7, jamb);
        fill(g, 0, 6, w, 1, rgba('#ffffff', 0.18));
        if (a.open) {
          panel(g, 2, 7, w - 4, 12);
          panel(g, 2, h - 19, w - 4, 12);
        } else {
          panel(g, 2, 7, w - 4, (h - 14) / 2 - 1);
          panel(g, 2, h / 2 + 1, w - 4, (h - 14) / 2 - 1);
          fill(g, 2, h / 2 - 1, w - 4, 2, rgba('#000000', 0.5));
          rrect(g, w / 2 - 2, h / 2 - 8, 4, 5, 2, a.c2);
          rrect(g, w / 2 - 2, h / 2 + 3, 4, 5, 2, a.c2);
        }
      }
    },

    conduit: function (g, a) {
      var m = a.variant, c = a.c1, mid = PX / 2;
      function run(x, y, w, h) {
        rrect(g, x, y + 1.5, w, h, 3, rgba('#000000', 0.3));
        rrect(g, x, y, w, h, 3, c);
        gradRect(g, x, y, w, h, h > w
          ? linGrad(g, x, 0, x + w, 0, [0, rgba('#ffffff', 0.22), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.28)])
          : linGrad(g, 0, y, 0, y + h, [0, rgba('#ffffff', 0.22), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.28)]));
      }
      if (m & 1) run(mid - 6, 0, 12, mid + 6);
      if (m & 4) run(mid - 6, mid - 6, 12, mid + 6);
      if (m & 8) run(0, mid - 6, mid + 6, 12);
      if (m & 2) run(mid - 6, mid - 6, mid + 6, 12);
      if (!m) run(mid - 6, mid - 10, 12, 20);
      circle(g, mid, mid + 1.5, 8, rgba('#000000', 0.3));
      circle(g, mid, mid, 7.5, shade(c, 0.05));
      ring(g, mid, mid, 6, 1.4, rgba('#000000', 0.35));
      circle(g, mid - 1.5, mid - 1.8, 3, rgba('#ffffff', 0.22));
      circle(g, mid, mid, 2.4, a.c2);
    },

    battery: function (g, a) {
      var w = a.w, h = a.h;
      casing(g, a, 4, 4, w - 8, h - 8, a.c1);
      /* Cooling ribs down the case. */
      vents(g, 9, 14, w - 18, h * 0.34, 5);
      /* Terminals: one positive, one negative, both with a strap. */
      var ty = h - 26;
      rrect(g, 9, ty, w - 18, 18, 3, shade(a.c1, -0.32));
      bolt(g, 18, ty + 9, 5, P.steel);
      bolt(g, w - 18, ty + 9, 5, P.steel);
      fill(g, 15, ty + 4, 6, 2, rgba(P.bad, 0.9));
      fill(g, w - 21, ty + 4, 6, 2, rgba(P.ink, 0.8));
      /* Charge indicator: four cells, the brightest one at the top. */
      for (var i = 0; i < 4; i++) {
        var by = 16 + i * 7;
        rrect(g, w - 16, by, 7, 4, 1.5, rgba('#000000', 0.45));
        rrect(g, w - 15.2, by + 0.8, 5.4, 2.4, 1, i < 3 ? a.c2 : shade(a.c2, -0.55));
      }
      glow(g, w - 12.5, 18, 5, a.c2, 0.5);
    },

    solar: function (g, a) {
      var w = a.w, h = a.h, frame = shade(P.steel, -0.25);
      softShade(g, 2, 4, w - 4, h - 6, 4, 0.34);
      slab(g, 1, 1, w - 2, h - 2, 4, frame, 4);
      var pad = 7, cell = (w - pad * 2) / 3, cellH = (h - pad * 2) / 3;
      for (var cy = 0; cy < 3; cy++) {
        for (var cx = 0; cx < 3; cx++) {
          var x = pad + cx * cell + 1.5, y = pad + cy * cellH + 1.5;
          var cw = cell - 3, ch = cellH - 3;
          fill(g, x, y, cw, ch, a.c1);
          gradRect(g, x, y, cw, ch, linGrad(g, x, y, x + cw, y + ch,
            [0, rgba('#ffffff', 0.16), 0.5, rgba('#000000', 0.08), 1, rgba('#000000', 0.22)]));
          /* Busbars: the fine silver fingers across each cell. */
          for (var b = 1; b < 5; b++) {
            fill(g, x + cw * b / 5, y, 0.9, ch, rgba(a.c2, 0.4));
          }
          fill(g, x, y + ch * 0.33, cw, 1.1, rgba(a.c2, 0.55));
          fill(g, x, y + ch * 0.66, cw, 1.1, rgba(a.c2, 0.55));
          box(g, x, y, cw, ch, rgba('#000000', 0.4));
        }
      }
      /* One sweep of reflected sky across the whole array. */
      sheen(g, 4, 4, w - 8, h - 8, 0.3, 0.75);
      rrectLine(g, 1, 1, w - 2, h - 2, 4, rgba('#000000', 0.5), 1.4);
    },

    turbine: function (g, a) {
      var w = a.w, h = a.h, cx = w / 2, cy = h / 2;
      var blade = a.c1, hub = a.c2;
      /* The tower first, so the blades pass in front of it. */
      softShade(g, cx - 7, cy, 14, h / 2 - 4, 4, 0.34);
      rrect(g, cx - 6, cy, 12, h / 2 - 2, 3, shade(hub, -0.2));
      gradRect(g, cx - 6, cy, 12, h / 2 - 2, linGrad(g, cx - 6, 0, cx + 6, 0,
        [0, rgba('#ffffff', 0.25), 0.4, rgba('#ffffff', 0), 1, rgba('#000000', 0.3)]));
      var ang = [-0.42, 1.68, 3.78];
      for (var i = 0; i < 3; i++) {
        var ca = Math.cos(ang[i]), sa = Math.sin(ang[i]);
        var tipx = cx + ca * (w * 0.46), tipy = cy + sa * (h * 0.42);
        var nx = -sa, ny = ca;
        /* A blade is a long triangle with a rounded root, twisted so one
           face catches the light and the other does not. */
        poly(g, [
          cx + nx * 7, cy + ny * 7,
          tipx + nx * 1.2, tipy + ny * 1.2,
          tipx - nx * 1.2, tipy - ny * 1.2,
          cx - nx * 7, cy - ny * 7
        ], blade);
        poly(g, [
          cx + nx * 7, cy + ny * 7,
          tipx + nx * 1.2, tipy + ny * 1.2,
          tipx, tipy, cx, cy
        ], shade(blade, 0.22));
        stroke(g, [cx, cy, tipx, tipy], rgba('#000000', 0.25), 1.2);
      }
      circle(g, cx, cy + 2, 13, rgba('#000000', 0.32));
      circle(g, cx, cy, 12, shade(hub, -0.15));
      circle(g, cx, cy, 9, hub);
      circle(g, cx - 3, cy - 3.5, 4.5, rgba('#ffffff', 0.3));
      circle(g, cx, cy, 3, shade(hub, -0.5));
    },

    generator: function (g, a) {
      var w = a.w, h = a.h;
      casing(g, a, 3, 3, w - 6, h - 6, a.c1);
      /* Firebox with a grate and the fuel glowing behind it. */
      var fx = 9, fy = 14, fw = w * 0.42, fh = h - 28;
      rrect(g, fx, fy, fw, fh, 3, shade(a.c1, -0.5));
      glow(g, fx + fw / 2, fy + fh / 2, fh * 0.45, a.c2, a.lit ? 1 : 0.15);
      for (var b = 0; b < 4; b++) {
        fill(g, fx + 2 + b * (fw - 4) / 4, fy + 2, 2, fh - 4, rgba(P.iron, 0.9));
      }
      rrectLine(g, fx, fy, fw, fh, 3, rgba('#000000', 0.55), 1.5);
      /* Flywheel and exhaust on the other half. */
      var mx = w - 22, my = h / 2;
      circle(g, mx, my + 1.5, 13, rgba('#000000', 0.3));
      circle(g, mx, my, 12, shade(P.steel, -0.2));
      ring(g, mx, my, 8, 3, shade(P.steel, 0.15));
      circle(g, mx - 3, my - 4, 4, rgba('#ffffff', 0.25));
      circle(g, mx, my, 3.5, shade(P.iron, -0.3));
      rrect(g, w - 17, 8, 10, 10, 2, shade(P.iron, -0.1));
      circle(g, w - 12, 13, 3, rgba('#000000', 0.55));
      vents(g, 10, h - 11, w * 0.4, 6, 2);
    },

    heater: function (g, a) {
      var w = a.w, h = a.h;
      casing(g, a, 4, 4, w - 8, h - 8, a.c1);
      var ix = 10, iy = 14, iw = w - 20, ih = h - 26;
      rrect(g, ix, iy, iw, ih, 3, shade(a.c1, -0.45));
      /* Element coils, hot in the middle and cooler at the ends. */
      for (var i = 0; i < 4; i++) {
        var y = iy + 4 + i * (ih - 8) / 3;
        stroke(g, [ix + 4, y, ix + iw - 4, y], shade(a.c2, -0.15), 3.2);
        stroke(g, [ix + 7, y, ix + iw - 7, y], mix(a.c2, '#ffffff', 0.4), 1.6);
      }
      if (a.lit) glow(g, w / 2, iy + ih / 2, ih * 0.7, a.c2, 0.65);
      rrectLine(g, ix, iy, iw, ih, 3, rgba('#000000', 0.5), 1.4);
      circle(g, w - 12, 10, 2.6, a.lit ? P.good : shade(P.good, -0.6));
    },

    cooler: function (g, a) {
      var w = a.w, h = a.h;
      casing(g, a, 4, 4, w - 8, h - 8, a.c1);
      var cx = w / 2, cy = h / 2;
      circle(g, cx, cy, Math.min(w, h) * 0.32, shade(a.c1, -0.4));
      /* A five-bladed fan, seen down the duct. */
      for (var i = 0; i < 5; i++) {
        var ang = i * TAU / 5;
        g.save();
        g.translate(cx, cy);
        g.rotate(ang);
        poly(g, [0, 0, 11, -5, 13, 2, 2, 5], shade(P.steel, 0.1));
        poly(g, [0, 0, 11, -5, 12, -1], shade(P.steel, 0.32));
        g.restore();
      }
      circle(g, cx, cy, 4, shade(P.steel, -0.3));
      circle(g, cx - 1, cy - 1.4, 1.8, rgba('#ffffff', 0.35));
      ring(g, cx, cy, Math.min(w, h) * 0.32, 2, rgba('#000000', 0.45));
      blob(g, cx, cy, Math.min(w, h) * 0.42, a.c2, a.lit ? 0.16 : 0.03, 0.1);
      circle(g, w - 12, 10, 2.6, a.lit ? a.c2 : shade(a.c2, -0.6));
    },

    lamp: function (g, a) {
      var cx = PX / 2, base = PX - 12;
      softShade(g, cx - 11, base - 4, 22, 12, 6, 0.4);
      /* Base, stem, shade - read from above as three stacked discs. */
      ell(g, cx, base + 2, 11, 5, 0, shade(a.c1, -0.3));
      ell(g, cx, base, 11, 5, 0, a.c1);
      ell(g, cx, base - 1.5, 7, 3, 0, shade(a.c1, 0.2));
      rrect(g, cx - 3, base - 20, 6, 20, 2, shade(a.c1, -0.15));
      fill(g, cx - 3, base - 20, 2, 20, rgba('#ffffff', 0.22));
      if (a.lit) {
        glow(g, cx, base - 26, 22, a.c2, 1);
        circle(g, cx, base - 26, 11, shade(a.c2, -0.1));
        circle(g, cx, base - 26, 8, mix(a.c2, '#ffffff', 0.45));
        circle(g, cx - 2, base - 28.5, 3.4, '#ffffff');
      } else {
        circle(g, cx, base - 26, 11, shade(P.steel, -0.25));
        circle(g, cx, base - 26, 8, shade(P.steel, 0.05));
        circle(g, cx - 3, base - 29, 3, rgba('#ffffff', 0.3));
      }
      ring(g, cx, base - 26, 11, 1.6, rgba('#000000', 0.4));
    },

    turret: function (g, a) {
      var cx = PX / 2, cy = PX / 2 + 3;
      softShade(g, cx - 22, cy - 18, 44, 40, 20, 0.4);
      /* Base ring bolted to the floor. */
      circle(g, cx, cy + 6, 23, shade(a.c1, -0.4));
      circle(g, cx, cy + 5, 21, shade(a.c1, -0.12));
      ring(g, cx, cy + 5, 21, 2, rgba('#000000', 0.4));
      for (var i = 0; i < 6; i++) {
        var ang = i * TAU / 6 + 0.5;
        bolt(g, cx + Math.cos(ang) * 17, cy + 5 + Math.sin(ang) * 17, 2.6, P.steel);
      }
      /* Body: a squat turret housing with an ammo drum. */
      rrect(g, cx - 13, cy - 12, 26, 26, 6, shade(a.c1, -0.08));
      rrectPath(g, cx - 13, cy - 12, 26, 26, 6);
      g.save(); g.clip();
      sheen(g, cx - 13, cy - 12, 26, 26, 0.16, 0.8);
      g.restore();
      bevel(g, cx - 13, cy - 12, 26, 26, 4, rgba('#ffffff', 0.32), rgba('#000000', 0.42), 15, 1);
      rrectLine(g, cx - 13, cy - 12, 26, 26, 6, rgba('#000000', 0.45), 1.3);
      circle(g, cx + 8, cy + 6, 6, shade(a.c1, -0.3));
      ring(g, cx + 8, cy + 6, 4, 1.4, rgba('#ffffff', 0.2));
      /* Barrel, pointing north, with a muzzle brake. */
      rrect(g, cx - 3.5, cy - 32, 7, 24, 2, shade(a.c2, -0.15));
      fill(g, cx - 3.5, cy - 32, 2.2, 24, rgba('#ffffff', 0.25));
      fill(g, cx + 1.8, cy - 32, 1.7, 24, rgba('#000000', 0.3));
      rrect(g, cx - 5.5, cy - 34, 11, 6, 2, shade(a.c2, 0.06));
      fill(g, cx - 5.5, cy - 33.4, 11, 1.4, rgba('#ffffff', 0.3));
      circle(g, cx, cy - 33.5, 2.1, rgba('#000000', 0.8));
      circle(g, cx, cy - 12, 4, shade(a.c1, -0.45));
    },

    trap: function (g, a) {
      var w = a.w, h = a.h;
      rrect(g, 3, 3, w - 6, h - 6, 3, shade(a.c1, -0.35));
      rrectPath(g, 3, 3, w - 6, h - 6, 3);
      g.save(); g.clip();
      grain(g, a.rnd, 3, 3, w - 6, h - 6, 0.2, 'overlay');
      g.restore();
      /* Spikes: each a triangle with a lit face and a point. */
      for (var i = 0; i < 9; i++) {
        var sx = 10 + (i % 3) * 22, sy = 12 + ((i / 3) | 0) * 19;
        poly(g, [sx - 6, sy + 9, sx, sy - 9, sx + 6, sy + 9], shade(a.c2, -0.25));
        poly(g, [sx - 6, sy + 9, sx, sy - 9, sx, sy + 9], shade(a.c2, 0.25));
        stroke(g, [sx, sy - 9, sx, sy + 8], rgba('#ffffff', 0.3), 1);
        ell(g, sx, sy + 9, 6, 2, 0, rgba('#000000', 0.3));
      }
      rrectLine(g, 3, 3, w - 6, h - 6, 3, rgba('#000000', 0.45), 1.4);
    },

    sandbags: function (g, a) {
      var lt = shade(a.c1, 0.16), dk = shade(a.c1, -0.4);
      for (var row = 0; row < 3; row++) {
        var y = 11 + row * 20, off = (row & 1) ? 12 : 0;
        for (var x = -18 + off; x < PX + 6; x += 24) {
          var cx = x + 12, tone = row === 0 ? lt : (row === 2 ? dk : a.c1);
          ell(g, cx, y + 4, 13, 9, 0, rgba('#000000', 0.32));
          ell(g, cx, y, 13, 9, rs(a.rnd, 0.12), tone);
          ell(g, cx - 3, y - 3, 8, 4.5, -0.2, shade(tone, 0.2));
          /* Seam and the pucker at each end of the bag. */
          whip(g, cx - 11, y + 1, cx, y + 4, cx + 11, y + 1, rgba('#000000', 0.25), 1.4);
          ell(g, cx - 12, y, 2.5, 3.4, 0, shade(tone, -0.3));
          ell(g, cx + 12, y, 2.5, 3.4, 0, shade(tone, -0.3));
          grain(g, a.rnd, cx - 13, y - 9, 26, 18, 0.12, 'overlay');
        }
      }
    },

    grave: function (g, a) {
      var w = a.w, h = a.h;
      softShade(g, 4, 6, w - 8, h - 10, 3, 0.32);
      slab(g, 4, 4, w - 8, h - 8, 3, shade(a.c1, -0.12), 4);
      /* The mound of turned earth, then the marker at the head. */
      var mx = 9, my = 20, mw = w - 18, mh = h - 28;
      rrect(g, mx, my, mw, mh, 6, shade(P.soil, -0.14));
      rrectPath(g, mx, my, mw, mh, 6);
      g.save(); g.clip();
      for (var i = 0; i < 26; i++) {
        var cx2 = mx + a.rnd() * mw, cy2 = my + a.rnd() * mh, r = rr(a.rnd, 2, 5);
        ell(g, cx2, cy2 + 0.8, r, r * 0.7, 0, rgba('#000000', 0.3));
        ell(g, cx2, cy2, r, r * 0.7, a.rnd() * TAU, shade(P.soil, rr(a.rnd, -0.1, 0.1)));
      }
      g.restore();
      rrect(g, w / 2 - 12, 8, 24, 13, 2, a.c2);
      fill(g, w / 2 - 12, 8, 24, 2, shade(a.c2, 0.3));
      fill(g, w / 2 - 12, 19, 24, 2, rgba('#000000', 0.3));
      fill(g, w / 2 - 2, 10, 4, 9, rgba('#000000', 0.35));
      fill(g, w / 2 - 7, 12.5, 14, 4, rgba('#000000', 0.35));
    },

    sculpture: function (g, a) {
      var cx = PX / 2;
      softShade(g, cx - 17, PX - 22, 34, 16, 8, 0.42);
      ell(g, cx, PX - 12, 17, 8, 0, shade(a.c2, -0.25));
      ell(g, cx, PX - 14, 17, 8, 0, a.c2);
      ell(g, cx, PX - 16, 12, 5, 0, shade(a.c2, 0.2));
      /* An abstract twist: two lobes and an arm, shaded as one solid. */
      g.beginPath();
      g.moveTo(cx - 9, PX - 18);
      g.bezierCurveTo(cx - 17, PX - 34, cx - 4, PX - 40, cx - 2, PX - 52);
      g.bezierCurveTo(cx + 2, PX - 42, cx + 14, PX - 40, cx + 10, PX - 22);
      g.bezierCurveTo(cx + 8, PX - 19, cx - 4, PX - 16, cx - 9, PX - 18);
      g.closePath();
      g.fillStyle = a.c1; g.fill();
      g.save(); g.clip();
      gradRect(g, cx - 20, PX - 56, 40, 42, linGrad(g, cx - 14, PX - 52, cx + 14, PX - 16,
        [0, rgba('#ffffff', 0.4), 0.45, rgba('#ffffff', 0.05), 1, rgba('#000000', 0.34)]));
      grain(g, a.rnd, cx - 20, PX - 56, 40, 42, 0.12, 'overlay');
      g.restore();
      whip(g, cx - 5, PX - 22, cx - 7, PX - 36, cx - 3, PX - 48, rgba('#ffffff', 0.32), 2);
      ell(g, cx + 5, PX - 30, 3.4, 6, 0.4, rgba('#000000', 0.16));
    },

    bed: function (g, a) {
      var w = a.w, h = a.h;
      softShade(g, 3, 5, w - 6, h - 8, 4, 0.36);
      /* Frame first, then the mattress sitting inside it. */
      slab(g, 2, 2, w - 4, h - 4, 4, a.c1, 5);
      rrectPath(g, 2, 2, w - 4, h - 4, 4);
      g.save(); g.clip();
      surfaceTexture(g, a, 2, 2, w - 4, h - 4, h > w, 8);
      g.restore();
      var mx = 7, my = 8, mw = w - 14, mh = h - 16;
      rrect(g, mx, my, mw, mh, 4, P.linen);
      gradRect(g, mx, my, mw, mh, linGrad(g, mx, my, mx + mw * 0.6, my + mh,
        [0, rgba('#ffffff', 0.3), 0.4, rgba('#ffffff', 0), 1, rgba('#000000', 0.16)]));
      /* Pillow at the head, plumped and creased. */
      var ph = mh * 0.2;
      rrect(g, mx + 3, my + 3, mw - 6, ph, 5, shade(P.linen, 0.1));
      rrectLine(g, mx + 3, my + 3, mw - 6, ph, 5, rgba('#000000', 0.16), 1.2);
      whip(g, mx + 8, my + 3 + ph * 0.6, mx + mw / 2, my + 3 + ph * 0.75,
        mx + mw - 8, my + 3 + ph * 0.6, rgba('#000000', 0.12), 2);
      /* Blanket over the lower two thirds, with a turned-back cuff and
         the fold shadow that makes the cuff read as cloth. */
      var by = my + mh * 0.33;
      rrect(g, mx + 1, by, mw - 2, mh - (by - my) - 2, 3, a.c2);
      gradRect(g, mx + 1, by, mw - 2, mh - (by - my) - 2,
        linGrad(g, mx, by, mx + mw, by + mh, [0, rgba('#ffffff', 0.2), 1, rgba('#000000', 0.2)]));
      fill(g, mx + 1, by, mw - 2, 5, shade(a.c2, 0.22));
      fill(g, mx + 1, by + 5, mw - 2, 2.5, rgba('#000000', 0.3));
      for (var f = 0; f < 3; f++) {
        var fy = by + 12 + f * (mh - (by - my)) * 0.24;
        whip(g, mx + 3, fy, mx + mw / 2, fy + 3, mx + mw - 3, fy, rgba('#000000', 0.14), 2.6);
        whip(g, mx + 3, fy - 2, mx + mw / 2, fy + 1, mx + mw - 3, fy - 2, rgba('#ffffff', 0.12), 1.6);
      }
      grain(g, a.rnd, mx, my, mw, mh, 0.1, 'overlay');
      rrectLine(g, 2, 2, w - 4, h - 4, 4, rgba('#000000', 0.5), 1.4);
    },

    spot: function (g, a) {
      var w = a.w, h = a.h;
      dashedBox(g, w, h, a.c1);
      if (a.def.id === 'sleepingSpot') {
        /* A bedroll laid out on the ground. */
        rrect(g, 12, 10, w - 24, h - 20, 6, a.c2);
        gradRect(g, 12, 10, w - 24, h - 20, linGrad(g, 12, 10, w - 12, h - 10,
          [0, rgba('#ffffff', 0.22), 1, rgba('#000000', 0.2)]));
        rrect(g, 16, 14, w - 32, 12, 5, shade(P.linen, -0.06));
        for (var i = 0; i < 4; i++) {
          whip(g, 14, 30 + i * 7, w / 2, 33 + i * 7, w - 14, 30 + i * 7, rgba('#000000', 0.13), 2.2);
        }
        rrectLine(g, 12, 10, w - 24, h - 20, 6, rgba('#000000', 0.35), 1.2);
      } else {
        /* Crossed tools: this is a place where work happens. */
        stroke(g, [18, h - 18, w - 18, 18], shade(a.c2, -0.2), 4);
        stroke(g, [18, 18, w - 18, h - 18], a.c2, 4);
        circle(g, w / 2, h / 2, 5, shade(a.c2, 0.25));
        circle(g, w / 2 - 1.5, h / 2 - 1.8, 2, rgba('#ffffff', 0.4));
      }
    },

    table: function (g, a) {
      var w = a.w, h = a.h;
      cornerLegs(g, a, 5, 9);
      softShade(g, 4, 6, w - 8, h - 10, 3, 0.38);
      slab(g, 3, 3, w - 6, h - 6, 3, a.c1, 5);
      rrectPath(g, 3, 3, w - 6, h - 6, 3);
      g.save(); g.clip();
      surfaceTexture(g, a, 3, 3, w - 6, h - 6, false, 14);
      /* Board joints across the top: a table this size is planks. */
      for (var b = 1; b * 21 < h - 6; b++) {
        fill(g, 3, 3 + b * 21, w - 6, 1.4, rgba('#000000', 0.26));
        fill(g, 3, 4.4 + b * 21, w - 6, 1, rgba('#ffffff', 0.13));
      }
      g.restore();
      rrectLine(g, 3, 3, w - 6, h - 6, 3, rgba('#000000', 0.45), 1.4);
    },

    stool: function (g, a) {
      var cx = PX / 2, cy = PX / 2;
      softShade(g, cx - 15, cy - 13, 30, 30, 15, 0.4);
      for (var i = 0; i < 4; i++) {
        var ang = i * TAU / 4 + 0.78;
        var lx = cx + Math.cos(ang) * 13, ly = cy + Math.sin(ang) * 13;
        circle(g, lx, ly, 3.4, shade(a.c1, -0.5));
        circle(g, lx - 0.8, ly - 1, 1.6, shade(a.c1, -0.2));
      }
      circle(g, cx, cy + 1.5, 16, rgba('#000000', 0.3));
      circle(g, cx, cy, 15, a.c1);
      g.beginPath(); g.arc(cx, cy, 15, 0, TAU); g.save(); g.clip();
      surfaceTexture(g, a, cx - 16, cy - 16, 32, 32, false, 9);
      gradRect(g, cx - 16, cy - 16, 32, 32, linGrad(g, cx - 12, cy - 12, cx + 12, cy + 12,
        [0, rgba('#ffffff', 0.28), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.26)]));
      g.restore();
      ring(g, cx, cy, 15, 1.4, rgba('#000000', 0.4));
      ring(g, cx, cy, 8, 1.2, rgba('#000000', 0.16));
    },

    dresser: function (g, a) {
      var w = a.w, h = a.h;
      softShade(g, 4, 6, w - 8, h - 10, 3, 0.36);
      slab(g, 3, 3, w - 6, h - 6, 3, a.c1, 5);
      rrectPath(g, 3, 3, w - 6, h - 6, 3);
      g.save(); g.clip();
      surfaceTexture(g, a, 3, 3, w - 6, h - 6, h > w, 10);
      g.restore();
      /* Three drawers, each with a lit top lip and a pull. */
      var n = h > w ? 3 : 2, dh = (h - 12) / n;
      for (var i = 0; i < n; i++) {
        var y = 6 + i * dh;
        rrect(g, 7, y + 1.5, w - 14, dh - 3, 2, shade(a.c1, -0.08));
        fill(g, 7, y + 1.5, w - 14, 1.6, rgba('#ffffff', 0.22));
        fill(g, 7, y + dh - 3, w - 14, 1.6, rgba('#000000', 0.32));
        rrect(g, w / 2 - 9, y + dh / 2 - 2.2, 18, 4.4, 2.2, a.c2);
        fill(g, w / 2 - 9, y + dh / 2 - 2.2, 18, 1.4, rgba('#ffffff', 0.35));
      }
      rrectLine(g, 3, 3, w - 6, h - 6, 3, rgba('#000000', 0.45), 1.4);
    },

    campfire: function (g, a) {
      var cx = PX / 2, cy = PX / 2 + 2;
      /* Ring of stones, then the fuel, then the fire on top. */
      for (var i = 0; i < 9; i++) {
        var ang = i * TAU / 9 + 0.3;
        var sx = cx + Math.cos(ang) * 24, sy = cy + Math.sin(ang) * 23;
        pebble(g, a.rnd, sx, sy, rr(a.rnd, 4, 6.5), shade(P.rock, rr(a.rnd, -0.06, 0.16)));
      }
      blob(g, cx, cy, 20, '#000000', 0.35, 0.2);
      for (var k = 0; k < 4; k++) {
        var ang2 = k * 0.7 + 0.4;
        var ex = Math.cos(ang2) * 15, ey = Math.sin(ang2) * 9;
        stroke(g, [cx - ex, cy - ey, cx + ex, cy + ey], shade(P.bark, -0.15), 5.5);
        stroke(g, [cx - ex, cy - ey - 1.4, cx + ex, cy + ey - 1.4], shade(P.bark, 0.14), 2);
      }
      /* Embers under the flame, brightest at the heart. */
      for (var e = 0; e < 10; e++) {
        var ex2 = cx + rs(a.rnd, 13), ey2 = cy + rs(a.rnd, 8);
        circle(g, ex2, ey2, rr(a.rnd, 1.2, 3), rgba(a.rnd() < 0.5 ? '#ff5a1a' : P.ember, 0.75));
      }
      glow(g, cx, cy, 22, P.flame, 0.8);
      flameIllus(g, cx, cy - 2, a.frame, 22, 1);
    },

    stove: function (g, a) {
      var w = a.w, h = a.h;
      casing(g, a, 3, 3, w - 6, h - 6, a.c1);
      /* Two hobs with their rings, and the oven door on the right. */
      for (var i = 0; i < 2; i++) {
        var hx = 20 + i * 27, hy = h / 2 - 2;
        circle(g, hx, hy, 12, shade(a.c1, -0.35));
        ring(g, hx, hy, 12, 1.6, rgba('#000000', 0.4));
        ring(g, hx, hy, 8.5, 2.6, shade(P.iron, -0.15));
        ring(g, hx, hy, 4.5, 2.2, shade(P.iron, -0.05));
        if (a.lit && i === 0) {
          glow(g, hx, hy, 14, a.c2, 0.7);
          ring(g, hx, hy, 8.5, 2.6, rgba(a.c2, 0.7));
          ring(g, hx, hy, 4.5, 2.2, rgba(mix(a.c2, '#ffffff', 0.4), 0.7));
        }
      }
      var ox = w - 34, oy = 10;
      rrect(g, ox, oy, 28, h - 20, 3, shade(a.c1, -0.22));
      rrect(g, ox + 4, oy + 4, 20, h - 34, 2, shade(P.ink, 0.18));
      /* A sliver of firelight behind the oven glass. */
      if (a.lit) {
        gradRect(g, ox + 4, oy + 4, 20, h - 34, linGrad(g, 0, oy + 4, 0, oy + h - 30,
          [0, rgba(a.c2, 0.1), 1, rgba(a.c2, 0.5)]));
      }
      rrectLine(g, ox + 4, oy + 4, 20, h - 34, 2, rgba('#ffffff', 0.18), 1.2);
      rrect(g, ox + 2, h - 19, 24, 5, 2.5, P.steel);
      fill(g, ox + 2, h - 19, 24, 1.8, rgba('#ffffff', 0.4));
      /* Vent strip along the front, warm when the stove is working. */
      vents(g, 12, h - 13, 30, 7, 2);
      if (a.lit) glow(g, 27, h - 10, 12, a.c2, 0.45);
    },

    butcher: function (g, a) {
      var t = benchBase(g, a, shade(P.linen, -0.14));
      /* A scarred cutting block with meat on it and a cleaver beside. */
      rrect(g, t.x + 3, t.y + 3, t.w * 0.5, t.h - 6, 3, shade(P.linen, -0.05));
      for (var i = 0; i < 16; i++) {
        var sx = t.x + 5 + a.rnd() * (t.w * 0.5 - 4), sy = t.y + 5 + a.rnd() * (t.h - 10);
        whip(g, sx, sy, sx + rs(a.rnd, 4), sy + rs(a.rnd, 3), sx + rs(a.rnd, 8), sy + rs(a.rnd, 4),
          rgba(shade(P.linen, -0.45), 0.4), 1);
      }
      flecks(g, a.rnd, 9, t.x + 4, t.y + 4, t.w * 0.5 - 4, t.h - 8, [a.c2, shade(a.c2, -0.3)], 1, 3, 0.75);
      ell(g, t.x + t.w * 0.28, t.y + t.h * 0.5, 9, 6, 0.3, a.c2);
      ell(g, t.x + t.w * 0.26, t.y + t.h * 0.46, 5, 3, 0.3, shade(a.c2, 0.25));
      var bx = t.x + t.w * 0.68;
      poly(g, [bx, t.y + 6, bx + 20, t.y + 8, bx + 19, t.y + 22, bx - 1, t.y + 20], P.steel);
      poly(g, [bx, t.y + 6, bx + 20, t.y + 8, bx + 20, t.y + 12, bx, t.y + 11], shade(P.steel, 0.35));
      rrect(g, bx - 14, t.y + 12, 15, 5, 2.5, shade(P.wood, -0.2));
      ell(g, t.x + t.w * 0.72, t.y + t.h - 10, 7, 4, 0, rgba(P.blood, 0.55));
    },

    stonecutter: function (g, a) {
      var t = benchBase(g, a, shade(a.c1, -0.2));
      /* A half-cut block clamped on the bench, with the offcuts. */
      var bx = t.x + 6, by = t.y + 5, bw = t.w * 0.42, bh = t.h - 10;
      rrect(g, bx, by, bw, bh, 2, a.c2);
      gradRect(g, bx, by, bw, bh, linGrad(g, bx, by, bx + bw, by + bh,
        [0, rgba('#ffffff', 0.3), 1, rgba('#000000', 0.26)]));
      flecks(g, a.rnd, 10, bx, by, bw, bh, [shade(a.c2, 0.25), shade(a.c2, -0.25)], 0.8, 2.4, 0.6);
      fill(g, bx + bw * 0.55, by, 2, bh, rgba('#000000', 0.4));
      rrectLine(g, bx, by, bw, bh, 2, rgba('#000000', 0.4), 1.2);
      /* Chisel and mallet on the free half. */
      var cx = t.x + t.w * 0.7;
      stroke(g, [cx, t.y + 20, cx + 16, t.y + 8], P.steel, 4);
      poly(g, [cx + 14, t.y + 6, cx + 20, t.y + 10, cx + 16, t.y + 13], shade(P.steel, 0.4));
      rrect(g, cx + 2, t.y + t.h - 16, 18, 8, 3, shade(P.wood, -0.1));
      stroke(g, [cx + 1, t.y + t.h - 12, cx - 12, t.y + t.h - 6], shade(P.wood, -0.3), 3.5);
      flecks(g, a.rnd, 14, t.x, t.y, t.w, t.h, [shade(a.c2, 0.4)], 0.6, 1.6, 0.6);
    },

    tailor: function (g, a) {
      var t = benchBase(g, a, shade(a.c1, -0.2));
      /* Bolt of cloth, a pattern piece and the machine head. */
      var cx = t.x + 5, cy = t.y + 5;
      rrect(g, cx, cy, t.w * 0.4, t.h - 10, 3, a.c2);
      for (var i = 0; i < 5; i++) {
        var fy = cy + 3 + i * (t.h - 16) / 4;
        whip(g, cx + 1, fy, cx + t.w * 0.2, fy + 3, cx + t.w * 0.4 - 1, fy,
          rgba('#000000', 0.16), 2.4);
        whip(g, cx + 1, fy - 1.6, cx + t.w * 0.2, fy + 1.4, cx + t.w * 0.4 - 1, fy - 1.6,
          rgba('#ffffff', 0.2), 1.2);
      }
      rrectLine(g, cx, cy, t.w * 0.4, t.h - 10, 3, rgba('#000000', 0.32), 1.2);
      var mx = t.x + t.w * 0.62;
      rrect(g, mx, t.y + 4, 24, 10, 3, shade(P.steel, -0.15));
      rrect(g, mx + 18, t.y + 10, 6, t.h - 18, 2, shade(P.steel, -0.15));
      fill(g, mx, t.y + 4, 24, 2, rgba('#ffffff', 0.32));
      stroke(g, [mx + 3, t.y + 14, mx + 3, t.y + 20], P.steel, 1.6);
      circle(g, mx + 20, t.y + 8, 3.4, P.gold);
      circle(g, mx + 19, t.y + 7, 1.4, rgba('#ffffff', 0.5));
      flecks(g, a.rnd, 8, t.x, t.y, t.w, t.h, [a.c2, P.linen], 0.7, 2, 0.5);
    },

    smithy: function (g, a) {
      var w = a.w, h = a.h;
      softShade(g, 4, 6, w - 8, h - 10, 4, 0.36);
      slab(g, 3, 3, w - 6, h - 6, 4, shade(a.c1, -0.12), 5);
      /* Anvil on the left: horn, face and waist, read from above. */
      var ax = 26, ay = h / 2;
      ell(g, ax, ay + 12, 20, 7, 0, rgba('#000000', 0.34));
      poly(g, [ax - 18, ay - 9, ax + 14, ay - 7, ax + 24, ay, ax + 14, ay + 7, ax - 18, ay + 9],
        shade(P.iron, 0.05));
      poly(g, [ax - 18, ay - 9, ax + 14, ay - 7, ax + 24, ay, ax + 12, ay - 1, ax - 18, ay - 2],
        shade(P.iron, 0.3));
      stroke(g, [ax - 16, ay + 8, ax + 12, ay + 6], rgba('#000000', 0.45), 2);
      grain(g, a.rnd, ax - 20, ay - 10, 46, 22, 0.14, 'overlay');
      /* Forge on the right, glowing. */
      var fx = w - 30, fy = h / 2;
      circle(g, fx, fy, 16, shade(P.rock, -0.25));
      circle(g, fx, fy, 12, shade(P.charcoal, 0.1));
      for (var e = 0; e < 9; e++) {
        circle(g, fx + rs(a.rnd, 8), fy + rs(a.rnd, 8), rr(a.rnd, 1.4, 3.4),
          rgba(a.rnd() < 0.5 ? '#ff5a1a' : P.ember, 0.8));
      }
      glow(g, fx, fy, 17, a.c2, a.lit ? 0.95 : 0.3);
      ring(g, fx, fy, 16, 2, rgba('#000000', 0.45));
      rrectLine(g, 3, 3, w - 6, h - 6, 4, rgba('#000000', 0.45), 1.4);
    },

    research: function (g, a) {
      var t = benchBase(g, a, shade(a.c1, -0.2));
      /* A screen, a keyboard and parts scattered where they were left. */
      var sx = t.x + 4, sy = t.y + 3, sw = t.w * 0.44, sh = t.h * 0.62;
      rrect(g, sx, sy, sw, sh, 3, shade(P.ink, 0.12));
      rrect(g, sx + 2.5, sy + 2.5, sw - 5, sh - 5, 2, shade(a.c2, -0.45));
      for (var i = 0; i < 5; i++) {
        fill(g, sx + 5, sy + 6 + i * (sh - 12) / 5, (sw - 12) * rr(a.rnd, 0.3, 1), 1.8,
          rgba(a.c2, rr(a.rnd, 0.5, 1)));
      }
      glow(g, sx + sw / 2, sy + sh / 2, sw * 0.6, a.c2, 0.35);
      rrectLine(g, sx, sy, sw, sh, 3, rgba('#000000', 0.45), 1.2);
      rrect(g, sx + 1, t.y + t.h - 11, sw + 4, 8, 2, shade(P.steel, -0.1));
      for (var k = 0; k < 9; k++) {
        fill(g, sx + 3 + k * (sw / 9), t.y + t.h - 9.5, sw / 12, 2.4, rgba('#000000', 0.35));
      }
      var px2 = t.x + t.w * 0.58;
      rrect(g, px2, t.y + 5, 20, 14, 2, shade(P.steel, -0.2));
      for (var c = 0; c < 4; c++) {
        fill(g, px2 + 3 + c * 4.5, t.y + 8, 2.4, 8, rgba(P.good, 0.8));
      }
      circle(g, px2 + 26, t.y + 12, 6, rgba(P.glass, 0.5));
      ring(g, px2 + 26, t.y + 12, 6, 1.4, P.steel);
      circle(g, px2 + 24, t.y + 10, 2, rgba('#ffffff', 0.55));
      flecks(g, a.rnd, 7, t.x + t.w * 0.55, t.y + t.h * 0.55, t.w * 0.4, t.h * 0.4,
        [P.brass, P.steel, P.gold], 1, 2.4, 0.8);
    },

    box: function (g, a) {
      var w = a.w, h = a.h;
      softShade(g, 4, 6, w - 8, h - 10, 3, 0.34);
      slab(g, 3, 3, w - 6, h - 6, 3, a.c1, 5);
      rrectPath(g, 3, 3, w - 6, h - 6, 3);
      g.save(); g.clip();
      sheen(g, 3, 3, w - 6, h - 6, 0.1, 0.8);
      g.restore();
      /* A hinged lid with a strap and a latch. */
      fill(g, 3, h / 2 - 1.5, w - 6, 3, rgba('#000000', 0.38));
      fill(g, 3, h / 2 + 1.5, w - 6, 1.2, rgba('#ffffff', 0.16));
      rrect(g, w / 2 - 7, h / 2 - 8, 14, 16, 2, shade(a.c1, -0.25));
      rrect(g, w / 2 - 4, h / 2 - 3, 8, 6, 1.5, a.c2);
      bolt(g, 10, 10, 2.6, P.steel);
      bolt(g, w - 10, 10, 2.6, P.steel);
      bolt(g, 10, h - 10, 2.6, P.steel);
      bolt(g, w - 10, h - 10, 2.6, P.steel);
      rrectLine(g, 3, 3, w - 6, h - 6, 3, rgba('#000000', 0.45), 1.4);
    },

    blueprint: function (g, a) {
      var c = a.c1, w = a.w, h = a.h;
      fill(g, 0, 0, w, h, rgba(c, 0.1));
      /* Drafting paper: a faint grid, corner ticks and a hatch. */
      for (var x = 8; x < w; x += 8) fill(g, x, 0, 0.6, h, rgba(c, 0.14));
      for (var y = 8; y < h; y += 8) fill(g, 0, y, w, 0.6, rgba(c, 0.14));
      for (var d = -h; d < w; d += 14) {
        stroke(g, [d, h, d + h, 0], rgba(c, 0.18), 1.2);
      }
      g.strokeStyle = rgba(c, 0.9); g.lineWidth = 2;
      g.setLineDash([7, 5]);
      g.strokeRect(1.5, 1.5, w - 3, h - 3);
      g.setLineDash([]);
      var t = 10;
      fill(g, 0, 0, t, 2.4, c); fill(g, 0, 0, 2.4, t, c);
      fill(g, w - t, 0, t, 2.4, c); fill(g, w - 2.4, 0, 2.4, t, c);
      fill(g, 0, h - 2.4, t, 2.4, c); fill(g, 0, h - t, 2.4, t, c);
      fill(g, w - t, h - 2.4, t, 2.4, c); fill(g, w - 2.4, h - t, 2.4, t, c);
    },

    frame: function (g, a) {
      var w = a.w, h = a.h;
      /* Half-built: posts at the corners, a couple of braces, and the
         ground still showing through. */
      fill(g, 0, 0, w, h, rgba(a.c2, 0.16));
      stroke(g, [6, 6, w - 6, h - 6], rgba(a.c1, 0.55), 3);
      stroke(g, [w - 6, 6, 6, h - 6], rgba(a.c1, 0.55), 3);
      for (var i = 0; i < 4; i++) {
        var px2 = (i & 1) ? w - 11 : 4, py = (i & 2) ? h - 11 : 4;
        rrect(g, px2, py, 7, 7, 1.5, rgba('#000000', 0.3));
        rrect(g, px2 - 1, py - 1, 7, 7, 1.5, a.c1);
        fill(g, px2 - 1, py - 1, 7, 2, rgba('#ffffff', 0.25));
      }
      g.strokeStyle = rgba(a.c1, 0.85); g.lineWidth = 2.4;
      g.setLineDash([9, 6]);
      g.strokeRect(2, 2, w - 4, h - 4);
      g.setLineDash([]);
    },

    /* Laid on its side, head to the left. A dead muffalo must not read
       as a dead colonist, so the animal kinds keep their own silhouette
       and colour, drained toward grey. */
    corpse: function (g, a) {
      var an = a.kindId && ANIMAL[a.kindId];
      var cx = PX / 2, cy = PX / 2 + 4;
      blobEll(g, cx + 2, cy + 8, 24, 8, '#000000', 0.32, 0.2);
      if (an) {
        var body = drained(an.body), belly = drained(an.belly);
        ell(g, cx + 4, cy, 19, 11, 0.06, body);
        ell(g, cx + 4, cy + 4, 16, 6, 0.06, belly);
        ell(g, cx - 16, cy - 2, 8, 7, -0.2, body);
        ell(g, cx - 23, cy - 1, 4, 3.4, -0.2, belly);
        for (var i = 0; i < 4; i++) {
          var lx = cx - 6 + (i & 1) * 18, ly = cy + (i < 2 ? 9 : -9);
          stroke(g, [lx, ly, lx + rs(a.rnd, 5), ly + (i < 2 ? 12 : -12)], shade(body, -0.25), 5);
        }
        if (an.tail) stroke(g, [cx + 22, cy, cx + 30, cy + 6], body, 4);
        if (an.shag) flecks(g, a.rnd, 26, cx - 14, cy - 11, 38, 22, [shade(body, 0.16)], 1, 3, 0.5);
      } else {
        var skin = drained('#c89868'), cloth = drained(P.wild);
        ell(g, cx + 5, cy, 15, 10, 0.05, cloth);
        ell(g, cx + 5, cy - 3, 12, 5, 0.05, shade(cloth, 0.16));
        stroke(g, [cx + 14, cy - 6, cx + 26, cy - 10], drained(P.steel), 6);
        stroke(g, [cx + 14, cy + 6, cx + 26, cy + 11], drained(P.steel), 6);
        circle(g, cx - 14, cy - 1, 9, skin);
        g.beginPath(); g.arc(cx - 14, cy - 1, 9, 0, TAU); g.save(); g.clip();
        ell(g, cx - 16, cy - 5, 8, 6, -0.3, drained('#4a3020'));
        g.restore();
        stroke(g, [cx - 4, cy - 8, cx + 4, cy - 12], cloth, 5);
      }
      /* Pooled blood, which is the thing that says this is a corpse and
         not a sleeping pawn. */
      for (var b = 0; b < 5; b++) {
        ell(g, cx + rs(a.rnd, 20), cy + rr(a.rnd, 2, 14), rr(a.rnd, 3, 8), rr(a.rnd, 2, 4),
          a.rnd() * TAU, rgba(P.blood, rr(a.rnd, 0.35, 0.7)));
      }
      grain(g, a.rnd, 8, 8, PX - 16, PX - 16, 0.12, 'overlay');
    }
  };

  /* ------------------------------------------------------------------
     Items

     An item lies on the ground at about two thirds of a tile, with a
     contact shadow under it. The shadow is what stops a stack of steel
     looking like a decal printed on the floor.
     ------------------------------------------------------------------ */

  function groundShadow(g, cx, cy, rx, ry, alpha) {
    blobEll(g, cx + 2, cy + 3, rx, ry, '#000000', alpha === undefined ? 0.36 : alpha, 0.3);
  }

  /* End grain: the rings and the split of a sawn log, seen head-on. */
  function endGrain(g, rnd, cx, cy, r, c) {
    ell(g, cx, cy, r, r, 0, shade(c, 0.12));
    for (var k = r - 1.5; k > 0.8; k -= rr(rnd, 1.1, 2.1)) {
      ring(g, cx + rs(rnd, 0.6), cy + rs(rnd, 0.6), k, 0.8, rgba(shade(c, -0.3), 0.55));
    }
    circle(g, cx, cy, 1, rgba(shade(c, -0.45), 0.8));
    whip(g, cx, cy, cx + r * 0.5, cy - r * 0.4, cx + r * 0.9, cy - r * 0.75,
      rgba(shade(c, -0.5), 0.5), 1);
    ring(g, cx, cy, r, 1.2, rgba('#000000', 0.4));
  }

  var ITEMS = {

    item: function (g, a) {
      var cx = PX / 2, cy = PX / 2;
      groundShadow(g, cx, cy + 12, 17, 6);
      slab(g, cx - 17, cy - 13, 34, 27, 3, a.c1, 4);
      rrectPath(g, cx - 17, cy - 13, 34, 27, 3);
      g.save(); g.clip();
      sheen(g, cx - 17, cy - 13, 34, 27, 0.12, 0.8);
      g.restore();
      fill(g, cx - 17, cy - 2, 34, 2.4, rgba(a.c2, 0.75));
      fill(g, cx - 2, cy - 13, 3, 27, rgba(a.c2, 0.55));
    },

    log: function (g, a) {
      groundShadow(g, PX / 2, PX / 2 + 13, 21, 7);
      /* A bundle: two logs down, two on top, all end-on to the camera. */
      var pos = [[20, 38], [40, 40], [26, 24], [44, 26], [33, 32]];
      for (var i = 0; i < pos.length; i++) {
        var x = pos[i][0], y = pos[i][1], r = i === 4 ? 8 : 9.5;
        circle(g, x + 1.5, y + 2, r, rgba('#000000', 0.3));
        circle(g, x, y, r, a.c1);
        endGrain(g, a.rnd, x, y, r - 0.6, a.c1);
        /* Bark on the shoulder the light does not reach. */
        g.beginPath();
        g.arc(x, y, r, 0.5, 2.5);
        g.strokeStyle = rgba(shade(a.c2, -0.2), 0.8); g.lineWidth = 2.4; g.stroke();
      }
      /* The twine holding it together. */
      stroke(g, [13, 33, 30, 28, 50, 33], rgba(P.sand, 0.85), 2);
      stroke(g, [13, 34.5, 30, 29.5, 50, 34.5], rgba('#000000', 0.3), 1);
    },

    ingot: function (g, a) {
      groundShadow(g, PX / 2, PX / 2 + 15, 21, 6);
      /* Three bars, each a trapezoid so the cast taper shows. */
      var rows = [[10, 44, 44], [14, 33, 36], [19, 22, 27]];
      for (var i = 0; i < 3; i++) {
        var x = rows[i][0], y = rows[i][1], w = rows[i][2];
        poly(g, [x + 3, y - 10, x + w - 3, y - 10, x + w, y + 1, x, y + 1],
          shade(a.c1, -0.12));
        poly(g, [x + 3, y - 10, x + w - 3, y - 10, x + w - 5, y - 6, x + 5, y - 6],
          mix(a.c2 || a.c1, '#ffffff', 0.35));
        poly(g, [x + 5, y - 6, x + w - 5, y - 6, x + w, y + 1, x, y + 1], a.c1);
        gradRect(g, x, y - 6, w, 7, linGrad(g, x, 0, x + w, 0,
          [0, rgba('#ffffff', 0.3), 0.4, rgba('#ffffff', 0.05), 1, rgba('#000000', 0.26)]));
        stroke(g, [x + 5, y - 6, x + w - 5, y - 6], rgba('#ffffff', 0.5), 1.2);
        stroke(g, [x, y + 0.5, x + w, y + 0.5], rgba('#000000', 0.4), 1.2);
      }
    },

    component: function (g, a) {
      var cx = PX / 2, cy = PX / 2;
      groundShadow(g, cx, cy + 13, 17, 5);
      rrect(g, cx - 16, cy - 13, 32, 26, 2, a.c1);
      rrectPath(g, cx - 16, cy - 13, 32, 26, 2);
      g.save(); g.clip();
      /* Traces, pads and two chips: a board readable at a glance. */
      for (var i = 0; i < 7; i++) {
        var y = cy - 11 + i * 3.4;
        stroke(g, [cx - 14, y, cx + rs(a.rnd, 6), y, cx + 14, y + rs(a.rnd, 3)],
          rgba(a.c2, 0.75), 1.1);
      }
      for (var k = 0; k < 5; k++) {
        stroke(g, [cx - 10 + k * 5, cy - 12, cx - 10 + k * 5, cy + 12], rgba(a.c2, 0.35), 1);
      }
      rrect(g, cx - 12, cy - 8, 12, 9, 1, shade(P.ink, 0.15));
      for (var p = 0; p < 4; p++) {
        fill(g, cx - 12 + p * 3, cy + 1, 1.6, 2.4, P.brass);
        fill(g, cx - 12 + p * 3, cy - 10.4, 1.6, 2.4, P.brass);
      }
      rrect(g, cx + 3, cy + 1, 10, 7, 1, shade(P.ink, 0.15));
      circle(g, cx + 8, cy - 7, 3.4, shade(P.steel, 0.1));
      ring(g, cx + 8, cy - 7, 3.4, 1, rgba('#000000', 0.4));
      g.restore();
      bevel(g, cx - 16, cy - 13, 32, 26, 3, rgba('#ffffff', 0.25), rgba('#000000', 0.35), 15, 1);
      rrectLine(g, cx - 16, cy - 13, 32, 26, 2, rgba('#000000', 0.45), 1.2);
    },

    coin: function (g, a) {
      groundShadow(g, PX / 2, PX / 2 + 12, 19, 6);
      /* A loose pile: stacks lean, and the top faces catch the light. */
      var st = [[24, 40, 4], [40, 42, 3], [32, 30, 5]];
      for (var s = 0; s < st.length; s++) {
        var x = st[s][0], y = st[s][1], n = st[s][2];
        for (var i = 0; i < n; i++) {
          ell(g, x, y - i * 3, 9, 5, 0, shade(a.c1, -0.2));
          ell(g, x, y - i * 3 - 1.4, 9, 5, 0, a.c1);
        }
        ell(g, x, y - n * 3 + 1.6, 9, 5, 0, a.c2);
        ell(g, x - 2.6, y - n * 3 + 0.4, 4.4, 2.2, 0, rgba('#ffffff', 0.5));
        ring(g, x, y - n * 3 + 1.6, 6, 1, rgba('#000000', 0.25));
      }
      circle(g, 17, 44, 4.6, a.c1);
      ell(g, 17, 43, 4.6, 2.6, 0, a.c2);
    },

    chunk: function (g, a) {
      var cx = PX / 2, cy = PX / 2 + 2;
      groundShadow(g, cx, cy + 11, 20, 7);
      var n = 7, pts = [];
      for (var k = 0; k < n; k++) {
        var ang = (k / n) * TAU, r = rr(a.rnd, 15, 22);
        pts.push(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r * 0.78);
      }
      poly(g, pts, a.c1);
      g.beginPath();
      g.moveTo(pts[0], pts[1]);
      for (var i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
      g.closePath();
      g.save(); g.clip();
      gradRect(g, cx - 24, cy - 20, 48, 40, linGrad(g, cx - 14, cy - 14, cx + 16, cy + 16,
        [0, rgba('#ffffff', 0.34), 0.45, rgba('#ffffff', 0), 1, rgba('#000000', 0.32)]));
      /* Fracture planes: this was struck off a wall, so it has facets. */
      for (var f = 0; f < 4; f++) {
        var fx = cx + rs(a.rnd, 14), fy = cy + rs(a.rnd, 11);
        whip(g, fx - 12, fy - 6, fx, fy + rs(a.rnd, 5), fx + 12, fy + 4,
          rgba(shade(a.c1, -0.42), 0.5), 1.4);
      }
      flecks(g, a.rnd, 18, cx - 22, cy - 18, 44, 36, [a.c2, shade(a.c1, 0.28)], 0.8, 2.4, 0.55);
      grain(g, a.rnd, cx - 24, cy - 20, 48, 40, 0.24, 'overlay');
      g.restore();
      stroke(g, [pts[0], pts[1], pts[2], pts[3]], rgba('#ffffff', 0.25), 1.2);
    },

    block: function (g, a) {
      groundShadow(g, PX / 2, PX / 2 + 14, 20, 6);
      /* Two courses of dressed blocks, the top one set back. */
      var rows = [[10, 46, 44, 13], [16, 32, 32, 13]];
      for (var i = 0; i < 2; i++) {
        var x = rows[i][0], y = rows[i][1], w = rows[i][2], h = rows[i][3];
        for (var b = 0; b < (i ? 2 : 3); b++) {
          var bw = w / (i ? 2 : 3);
          var bx = x + b * bw;
          rrect(g, bx + 1, y - h, bw - 2, h, 1.5, shade(a.c1, rr(a.rnd, -0.08, 0.08)));
          gradRect(g, bx + 1, y - h, bw - 2, h, linGrad(g, bx, y - h, bx + bw, y,
            [0, rgba('#ffffff', 0.28), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.26)]));
          flecks(g, a.rnd, 5, bx + 2, y - h + 1, bw - 4, h - 2,
            [a.c2, shade(a.c1, 0.25)], 0.7, 1.8, 0.55);
          stroke(g, [bx + 1, y - h + 0.6, bx + bw - 1, y - h + 0.6], rgba('#ffffff', 0.4), 1.2);
          stroke(g, [bx + 1, y - 0.6, bx + bw - 1, y - 0.6], rgba('#000000', 0.4), 1.2);
        }
      }
    },

    cloth: function (g, a) {
      var cx = PX / 2, cy = PX / 2;
      groundShadow(g, cx, cy + 13, 19, 6);
      if (a.def.id === 'leather') {
        /* A hide: an irregular pelt with a shorn edge and a nap. */
        g.beginPath();
        g.moveTo(cx - 20, cy - 6);
        g.bezierCurveTo(cx - 16, cy - 20, cx - 2, cy - 18, cx + 4, cy - 12);
        g.bezierCurveTo(cx + 14, cy - 20, cx + 22, cy - 8, cx + 18, cy + 4);
        g.bezierCurveTo(cx + 20, cy + 16, cx + 4, cy + 18, cx - 4, cy + 12);
        g.bezierCurveTo(cx - 14, cy + 18, cx - 22, cy + 6, cx - 20, cy - 6);
        g.closePath();
        g.fillStyle = a.c1; g.fill();
        g.save(); g.clip();
        gradRect(g, cx - 24, cy - 22, 48, 44, linGrad(g, cx - 16, cy - 16, cx + 16, cy + 16,
          [0, rgba('#ffffff', 0.28), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.3)]));
        for (var i = 0; i < 24; i++) {
          var hx = cx + rs(a.rnd, 20), hy = cy + rs(a.rnd, 16);
          whip(g, hx, hy, hx + 3, hy + 2, hx + 6, hy + 1, rgba(a.c2, 0.4), 1);
        }
        grain(g, a.rnd, cx - 24, cy - 22, 48, 44, 0.16, 'overlay');
        g.restore();
        g.strokeStyle = rgba(shade(a.c1, -0.4), 0.6); g.lineWidth = 1.4; g.stroke();
        return;
      }
      /* Folded fabric: three layers, each with a soft roll at the fold. */
      for (var k = 0; k < 3; k++) {
        var y = cy + 10 - k * 9, w = 38 - k * 3;
        rrect(g, cx - w / 2, y - 9, w, 11, 4, shade(a.c1, k * 0.05));
        gradRect(g, cx - w / 2, y - 9, w, 11, linGrad(g, 0, y - 9, 0, y + 2,
          [0, rgba('#ffffff', 0.26), 0.45, rgba('#ffffff', 0), 1, rgba('#000000', 0.28)]));
        rrect(g, cx - w / 2, y - 9, w, 3, 3, rgba('#ffffff', 0.14));
        /* The weave, which is what tells cloth from a painted board. */
        for (var t = 0; t < 4; t++) {
          fill(g, cx - w / 2 + 2, y - 7 + t * 2.4, w - 4, 0.8, rgba(a.c2, 0.32));
        }
        rrectLine(g, cx - w / 2, y - 9, w, 11, 4, rgba('#000000', 0.3), 1);
      }
    },

    herb: function (g, a) {
      var cx = PX / 2, cy = PX / 2 + 4;
      groundShadow(g, cx, cy + 12, 16, 5);
      /* A tied bundle of stems, leaves fanning out at the top. */
      for (var i = 0; i < 9; i++) {
        var ang = -Math.PI / 2 + rs(a.rnd, 0.9);
        var len = rr(a.rnd, 18, 27);
        var ex = cx + Math.cos(ang) * len, ey = cy + Math.sin(ang) * len;
        stroke(g, [cx, cy + 10, cx + (ex - cx) * 0.4, cy - 2, ex, ey],
          shade(a.c1, -0.25), 1.6);
        var lc = i % 2 ? a.c1 : a.c2;
        ell(g, ex, ey, 6, 3.2, ang + 0.2, lc);
        ell(g, ex - 1, ey - 0.8, 3.6, 1.6, ang + 0.2, rgba('#ffffff', 0.28));
        stroke(g, [ex - 5, ey, ex + 5, ey], rgba(shade(lc, -0.35), 0.5), 0.8);
      }
      rrect(g, cx - 8, cy + 6, 16, 6, 3, P.sand);
      fill(g, cx - 8, cy + 6, 16, 2, rgba('#ffffff', 0.35));
      for (var t = 0; t < 3; t++) fill(g, cx - 6 + t * 5, cy + 6, 1.4, 6, rgba('#000000', 0.25));
    },

    medkit: function (g, a) {
      var cx = PX / 2, cy = PX / 2;
      groundShadow(g, cx, cy + 13, 18, 6);
      slab(g, cx - 19, cy - 13, 38, 27, 4, a.c1, 4);
      rrectPath(g, cx - 19, cy - 13, 38, 27, 4);
      g.save(); g.clip();
      fill(g, cx - 19, cy - 3, 38, 2.6, rgba('#000000', 0.3));
      fill(g, cx - 19, cy - 0.4, 38, 1.2, rgba('#ffffff', 0.25));
      g.restore();
      /* The cross, the one thing this has to read as. */
      fill(g, cx - 4, cy - 10, 8, 20, a.c2);
      fill(g, cx - 12, cy - 4, 24, 8, a.c2);
      fill(g, cx - 4, cy - 10, 8, 2, rgba('#ffffff', 0.35));
      fill(g, cx - 12, cy - 4, 24, 1.6, rgba('#ffffff', 0.3));
      rrect(g, cx - 6, cy - 16, 12, 5, 2, shade(a.c1, -0.25));
      rrectLine(g, cx - 19, cy - 13, 38, 27, 4, rgba('#000000', 0.4), 1.3);
    },

    barrel: function (g, a) {
      var cx = PX / 2, cy = PX / 2 + 1;
      groundShadow(g, cx, cy + 15, 16, 6);
      rrect(g, cx - 14, cy - 20, 28, 40, 6, a.c1);
      rrectPath(g, cx - 14, cy - 20, 28, 40, 6);
      g.save(); g.clip();
      gradRect(g, cx - 14, cy - 20, 28, 40, linGrad(g, cx - 14, 0, cx + 14, 0,
        [0, rgba('#ffffff', 0.3), 0.32, rgba('#ffffff', 0.05),
         0.75, rgba('#000000', 0.12), 1, rgba('#000000', 0.34)]));
      /* Rolling hoops. */
      for (var i = 0; i < 2; i++) {
        var y = cy - 11 + i * 22;
        fill(g, cx - 14, y, 28, 5, shade(a.c2, -0.1));
        fill(g, cx - 14, y, 28, 1.4, rgba('#ffffff', 0.3));
        fill(g, cx - 14, y + 4, 28, 1, rgba('#000000', 0.3));
      }
      g.restore();
      /* Bung on the top face. */
      ell(g, cx, cy - 20, 14, 5, 0, shade(a.c1, 0.14));
      ell(g, cx + 4, cy - 20, 4, 2.2, 0, shade(P.steel, -0.1));
      ell(g, cx + 4, cy - 20.6, 2.4, 1.2, 0, rgba('#ffffff', 0.4));
      rrectLine(g, cx - 14, cy - 20, 28, 40, 6, rgba('#000000', 0.45), 1.3);
    },

    grain: function (g, a) {
      var cx = PX / 2, cy = PX / 2 + 6;
      groundShadow(g, cx, cy + 9, 20, 6);
      /* A heap, lit on the crown, with individual grains on top. */
      g.beginPath();
      g.moveTo(cx - 22, cy + 10);
      g.bezierCurveTo(cx - 18, cy - 14, cx + 16, cy - 16, cx + 22, cy + 10);
      g.closePath();
      g.fillStyle = a.c2; g.fill();
      g.save(); g.clip();
      gradRect(g, cx - 24, cy - 18, 48, 30, linGrad(g, cx - 10, cy - 14, cx + 14, cy + 10,
        [0, rgba('#ffffff', 0.35), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.26)]));
      for (var i = 0; i < 70; i++) {
        var gx = cx + rs(a.rnd, 21), gy = cy + rr(a.rnd, -13, 9);
        ell(g, gx, gy, rr(a.rnd, 1.4, 2.4), 0.9, rs(a.rnd, 1),
          a.rnd() < 0.5 ? a.c1 : shade(a.c1, 0.2));
      }
      g.restore();
      /* A few husks standing out of the pile. */
      for (var k = 0; k < 4; k++) {
        var hx = cx + rs(a.rnd, 16);
        whip(g, hx, cy - 4, hx + rs(a.rnd, 3), cy - 12, hx + rs(a.rnd, 6), cy - 18,
          rgba(shade(a.c2, -0.25), 0.8), 1.2);
      }
    },

    root: function (g, a) {
      groundShadow(g, PX / 2, PX / 2 + 12, 18, 6);
      var pos = [[26, 36, 11, 8], [42, 40, 9, 7], [35, 25, 8, 6]];
      for (var i = 0; i < 3; i++) {
        var x = pos[i][0], y = pos[i][1], rx = pos[i][2], ry = pos[i][3];
        ell(g, x + 1.5, y + 2, rx, ry, 0.3, rgba('#000000', 0.3));
        ell(g, x, y, rx, ry, 0.3 + i, a.c1);
        ell(g, x - rx * 0.3, y - ry * 0.4, rx * 0.5, ry * 0.35, 0.3 + i, rgba('#ffffff', 0.28));
        /* Eyes, which is the only thing that makes a blob a potato. */
        for (var e = 0; e < 4; e++) {
          var ex = x + rs(a.rnd, rx * 0.7), ey = y + rs(a.rnd, ry * 0.7);
          ell(g, ex, ey, 1.4, 0.9, a.rnd() * TAU, rgba(a.c2, 0.8));
          dot(g, ex, ey - 1, rgba(shade(a.c2, -0.4), 0.7));
        }
        ell(g, x, y, rx, ry, 0.3 + i, rgba('#000000', 0));
        g.beginPath(); g.ellipse(x, y, rx, ry, 0.3 + i, 0, TAU);
        g.strokeStyle = rgba(shade(a.c1, -0.4), 0.45); g.lineWidth = 1; g.stroke();
      }
    },

    corn: function (g, a) {
      groundShadow(g, PX / 2, PX / 2 + 14, 18, 6);
      /* Two cobs, husk peeled back off the kernels. */
      for (var i = 0; i < 2; i++) {
        var x = 24 + i * 16, y = 40 - i * 4, ang = -0.35 + i * 0.7;
        g.save();
        g.translate(x, y);
        g.rotate(ang);
        ell(g, 0, 0, 8, 17, 0, shade(a.c1, -0.2));
        ell(g, -1, -1, 7, 16, 0, a.c1);
        for (var r = -5; r < 5; r++) {
          for (var c = -2; c < 3; c++) {
            var kx = c * 3 + (r & 1 ? 1.5 : 0), ky = r * 3;
            if (kx * kx / 25 + ky * ky / 200 > 1) continue;
            circle(g, kx, ky, 1.6, shade(a.c1, rr(a.rnd, -0.06, 0.16)));
            circle(g, kx - 0.4, ky - 0.5, 0.8, rgba('#ffffff', 0.4));
          }
        }
        /* Husk leaves peeled down. */
        poly(g, [-8, 6, -14, 20, -4, 16, -2, 6], shade(a.c2, 0.25));
        poly(g, [8, 6, 14, 21, 4, 16, 2, 6], a.c2);
        g.restore();
      }
    },

    berry: function (g, a) {
      groundShadow(g, PX / 2, PX / 2 + 11, 17, 6);
      var pos = [[24, 36], [36, 32], [42, 42], [30, 44], [33, 26], [45, 30]];
      for (var i = 0; i < pos.length; i++) {
        var x = pos[i][0], y = pos[i][1], r = 6.5 - (i % 2);
        circle(g, x + 1.2, y + 1.8, r, rgba('#000000', 0.3));
        circle(g, x, y, r, a.c1);
        g.fillStyle = radGrad(g, x - r * 0.35, y - r * 0.4, 0, r * 1.4,
          [0, rgba('#ffffff', 0.5), 0.35, rgba(a.c2, 0.25), 1, rgba(shade(a.c1, -0.4), 0.45)]);
        g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
        circle(g, x - r * 0.35, y - r * 0.42, r * 0.22, rgba('#ffffff', 0.85));
        /* The calyx star each berry keeps. */
        for (var s = 0; s < 4; s++) {
          var ang = s * TAU / 4 + 0.6;
          stroke(g, [x, y - r * 0.6, x + Math.cos(ang) * 2.4, y - r * 0.6 + Math.sin(ang) * 2.4],
            rgba(P.foliageDark, 0.6), 1);
        }
      }
    },

    meat: function (g, a) {
      var cx = PX / 2, cy = PX / 2 + 2;
      groundShadow(g, cx, cy + 11, 19, 6);
      g.beginPath();
      g.moveTo(cx - 19, cy);
      g.bezierCurveTo(cx - 17, cy - 13, cx - 2, cy - 15, cx + 6, cy - 10);
      g.bezierCurveTo(cx + 18, cy - 12, cx + 20, cy + 4, cx + 10, cy + 10);
      g.bezierCurveTo(cx - 2, cy + 15, cx - 17, cy + 10, cx - 19, cy);
      g.closePath();
      g.fillStyle = a.c1; g.fill();
      g.save(); g.clip();
      gradRect(g, cx - 22, cy - 18, 44, 34, linGrad(g, cx - 14, cy - 12, cx + 14, cy + 12,
        [0, rgba('#ffffff', 0.32), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.3)]));
      /* Marbling and the grain of the muscle. */
      for (var i = 0; i < 9; i++) {
        var mx = cx + rs(a.rnd, 15), my = cy + rs(a.rnd, 10);
        whip(g, mx - 7, my, mx, my + rs(a.rnd, 4), mx + 7, my,
          rgba(i % 3 ? a.c2 : P.linen, 0.45), rr(a.rnd, 1, 2.2));
      }
      grain(g, a.rnd, cx - 22, cy - 18, 44, 34, 0.14, 'overlay');
      g.restore();
      ell(g, cx + 2, cy - 9, 8, 3, -0.2, rgba(P.bone, 0.85));
      ell(g, cx + 2, cy - 9.8, 6, 1.4, -0.2, rgba('#ffffff', 0.4));
    },

    meal: function (g, a) {
      var cx = PX / 2, cy = PX / 2 + 2;
      groundShadow(g, cx, cy + 12, 21, 6);
      /* The plate, seen from above: rim, well, and a highlight. */
      circle(g, cx, cy, 22, shade(P.linen, -0.2));
      circle(g, cx, cy, 20.5, P.linen);
      circle(g, cx, cy, 15, shade(P.linen, -0.1));
      g.fillStyle = radGrad(g, cx - 7, cy - 8, 2, 26,
        [0, rgba('#ffffff', 0.5), 0.5, rgba('#ffffff', 0.05), 1, rgba('#000000', 0.16)]);
      g.beginPath(); g.arc(cx, cy, 20.5, 0, TAU); g.fill();
      /* The food itself: a mound, a garnish and something sauced. */
      ell(g, cx - 4, cy + 1, 10, 7, -0.2, a.c1);
      ell(g, cx - 5, cy - 1, 6, 4, -0.2, shade(a.c1, 0.25));
      ell(g, cx + 7, cy + 4, 7, 4.5, 0.4, a.c2);
      ell(g, cx + 6, cy + 3, 4, 2.4, 0.4, shade(a.c2, 0.3));
      for (var i = 0; i < 5; i++) {
        var vx = cx + rs(a.rnd, 9), vy = cy - 6 + rs(a.rnd, 4);
        ell(g, vx, vy, 3.4, 1.8, rs(a.rnd, 1), a.def.id === 'mealFine' ? P.good : shade(P.grass, 0.1));
      }
      if (a.def.id === 'mealFine') {
        /* Fine meals get a sprig, because you can see the difference. */
        stroke(g, [cx + 2, cy - 4, cx + 6, cy - 11], P.grass, 1.4);
        ell(g, cx + 7, cy - 12, 3.4, 1.8, -0.6, shade(P.grass, 0.2));
        ell(g, cx + 4, cy - 9, 3, 1.6, -0.3, shade(P.grass, 0.2));
      }
      ring(g, cx, cy, 20.5, 1.2, rgba('#000000', 0.3));
    },

    kibble: function (g, a) {
      var cx = PX / 2, cy = PX / 2 + 4;
      groundShadow(g, cx, cy + 10, 19, 6);
      g.beginPath();
      g.moveTo(cx - 20, cy + 9);
      g.bezierCurveTo(cx - 16, cy - 10, cx + 14, cy - 12, cx + 20, cy + 9);
      g.closePath();
      g.fillStyle = a.c2; g.fill();
      for (var i = 0; i < 46; i++) {
        var x = cx + rs(a.rnd, 19), y = cy + rr(a.rnd, -10, 8);
        if (Math.abs(x - cx) > 19 - Math.abs(y - cy)) continue;
        var r = rr(a.rnd, 1.8, 3.2);
        ell(g, x + 0.8, y + 0.9, r, r * 0.7, 0, rgba('#000000', 0.3));
        ell(g, x, y, r, r * 0.7, a.rnd() * TAU, shade(a.c1, rr(a.rnd, -0.12, 0.16)));
        ell(g, x - r * 0.3, y - r * 0.3, r * 0.4, r * 0.24, 0, rgba('#ffffff', 0.35));
      }
    },

    /* ---------- weapons ----------
       A weapon on the ground lies diagonally with its business end to
       the top right, which is enough for a player to tell a rifle from
       a bow at a glance. */

    knife: function (g, a) {
      groundShadow(g, 32, 38, 16, 5, 0.3);
      g.save(); g.translate(32, 32); g.rotate(-0.72);
      poly(g, [-4, -3, 22, -4, 27, 0, 22, 3, -4, 3], a.c1);
      poly(g, [-4, -3, 22, -4, 27, 0, 20, -1, -4, -1], shade(a.c1, 0.4));
      stroke(g, [-4, 2.2, 22, 2.6], rgba('#000000', 0.35), 1.2);
      rrect(g, -22, -4, 18, 8, 3, a.c2);
      gradRect(g, -22, -4, 18, 8, linGrad(g, 0, -4, 0, 4,
        [0, rgba('#ffffff', 0.3), 1, rgba('#000000', 0.3)]));
      rrect(g, -5, -5, 3, 10, 1.5, shade(P.steel, -0.2));
      g.restore();
    },

    club: function (g, a) {
      groundShadow(g, 32, 38, 17, 5, 0.3);
      g.save(); g.translate(32, 32); g.rotate(-0.72);
      rrect(g, -24, -3.5, 30, 7, 3.5, a.c1);
      gradRect(g, -24, -3.5, 30, 7, linGrad(g, 0, -3.5, 0, 3.5,
        [0, rgba('#ffffff', 0.28), 1, rgba('#000000', 0.3)]));
      for (var i = 0; i < 4; i++) fill(g, -22 + i * 4, -3.5, 1.4, 7, rgba('#000000', 0.2));
      ell(g, 14, 0, 12, 9, 0, a.c2);
      ell(g, 11, -3, 7, 4.5, -0.3, shade(a.c2, 0.3));
      for (var k = 0; k < 5; k++) {
        var ang = k * TAU / 5;
        circle(g, 14 + Math.cos(ang) * 7, Math.sin(ang) * 5, 1.8, shade(a.c2, -0.35));
      }
      g.restore();
    },

    spear: function (g, a) {
      groundShadow(g, 32, 38, 21, 5, 0.3);
      g.save(); g.translate(32, 32); g.rotate(-0.72);
      rrect(g, -28, -2.4, 50, 4.8, 2.4, a.c1);
      gradRect(g, -28, -2.4, 50, 4.8, linGrad(g, 0, -2.4, 0, 2.4,
        [0, rgba('#ffffff', 0.3), 1, rgba('#000000', 0.3)]));
      poly(g, [21, -5, 34, 0, 21, 5, 24, 0], a.c2);
      poly(g, [21, -5, 34, 0, 24, 0], shade(a.c2, 0.4));
      for (var i = 0; i < 3; i++) stroke(g, [16 + i * 2, -2.4, 16 + i * 2, 2.4], rgba(P.sand, 0.7), 1.4);
      g.restore();
    },

    bow: function (g, a) {
      groundShadow(g, 32, 40, 13, 5, 0.3);
      g.save(); g.translate(32, 32); g.rotate(-0.3);
      /* A recurve: two arcs meeting at a wrapped grip, with the string
         cutting straight across. */
      g.beginPath();
      g.moveTo(-3, -26);
      g.bezierCurveTo(12, -18, 14, 18, -3, 26);
      g.strokeStyle = a.c1; g.lineWidth = 4.4; g.lineCap = 'round'; g.stroke();
      g.beginPath();
      g.moveTo(-3, -26);
      g.bezierCurveTo(11, -18, 13, 18, -3, 26);
      g.strokeStyle = rgba('#ffffff', 0.2); g.lineWidth = 1.6; g.stroke();
      g.lineCap = 'butt';
      stroke(g, [-3, -26, -3, 26], a.c2, 1.2);
      rrect(g, 3, -7, 7, 14, 3, shade(a.c1, -0.35));
      for (var i = 0; i < 4; i++) fill(g, 3, -6 + i * 3.4, 7, 1.2, rgba('#000000', 0.25));
      g.restore();
    },

    gun: function (g, a) {
      groundShadow(g, 32, 38, 15, 5, 0.3);
      g.save(); g.translate(30, 32); g.rotate(-0.55);
      /* Slide, frame, grip, trigger guard: a pistol silhouette. */
      rrect(g, -16, -7, 34, 9, 2, a.c1);
      gradRect(g, -16, -7, 34, 9, linGrad(g, 0, -7, 0, 2,
        [0, rgba('#ffffff', 0.32), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.3)]));
      fill(g, -16, -7, 34, 1.4, rgba('#ffffff', 0.3));
      for (var i = 0; i < 6; i++) fill(g, -14 + i * 2.2, -6, 1.1, 7, rgba('#000000', 0.22));
      rrect(g, 14, -5, 8, 5, 1.5, shade(a.c1, -0.2));
      circle(g, 21, -2.5, 1.6, rgba('#000000', 0.75));
      poly(g, [-14, 2, -4, 2, -8, 18, -17, 17], a.c2);
      poly(g, [-14, 2, -9, 2, -13, 17, -17, 17], shade(a.c2, 0.25));
      g.beginPath(); g.arc(-2, 4, 5, 0.1, Math.PI - 0.1);
      g.strokeStyle = a.c1; g.lineWidth = 2; g.stroke();
      stroke(g, [-3, 2, -3, 6], shade(a.c2, -0.3), 1.6);
      g.restore();
    },

    rifle: function (g, a) {
      groundShadow(g, 32, 40, 22, 5, 0.3);
      g.save(); g.translate(32, 32); g.rotate(-0.62);
      /* Barrel, receiver, magazine, stock - in that reading order. */
      rrect(g, -4, -3, 36, 6, 2, shade(a.c1, -0.1));
      gradRect(g, -4, -3, 36, 6, linGrad(g, 0, -3, 0, 3,
        [0, rgba('#ffffff', 0.32), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.3)]));
      rrect(g, 26, -3.6, 7, 7.2, 2, shade(a.c1, 0.1));
      circle(g, 32, 0, 1.8, rgba('#000000', 0.8));
      rrect(g, -18, -5, 22, 10, 2.5, a.c2);
      gradRect(g, -18, -5, 22, 10, linGrad(g, 0, -5, 0, 5,
        [0, rgba('#ffffff', 0.26), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.3)]));
      rrect(g, -10, 4, 8, 13, 2, shade(a.c1, -0.25));
      fill(g, -9, 5, 2, 11, rgba('#ffffff', 0.18));
      poly(g, [-18, -5, -30, -1, -32, 6, -18, 5], a.c1);
      poly(g, [-18, -5, -30, -1, -29, 1, -18, -2], rgba('#ffffff', 0.25));
      rrect(g, -6, -9, 14, 4, 1.5, shade(P.ink, 0.3));
      g.beginPath(); g.arc(-14, 6, 5, 0.2, Math.PI - 0.2);
      g.strokeStyle = a.c2; g.lineWidth = 1.8; g.stroke();
      g.restore();
    },

    shotgun: function (g, a) {
      groundShadow(g, 32, 40, 22, 5, 0.3);
      g.save(); g.translate(32, 32); g.rotate(-0.62);
      /* Two barrels, which is the whole silhouette. */
      rrect(g, -6, -5, 38, 4.4, 2, shade(a.c1, -0.05));
      rrect(g, -6, -0.2, 38, 4.4, 2, shade(a.c1, -0.18));
      fill(g, -6, -5, 38, 1.4, rgba('#ffffff', 0.3));
      circle(g, 31, -2.8, 1.7, rgba('#000000', 0.8));
      circle(g, 31, 2, 1.7, rgba('#000000', 0.8));
      rrect(g, -20, -6, 16, 12, 3, a.c2);
      gradRect(g, -20, -6, 16, 12, linGrad(g, 0, -6, 0, 6,
        [0, rgba('#ffffff', 0.26), 1, rgba('#000000', 0.3)]));
      poly(g, [-20, -6, -33, -2, -34, 8, -20, 6], a.c1);
      poly(g, [-20, -6, -33, -2, -32, 0, -20, -3], rgba('#ffffff', 0.25));
      g.beginPath(); g.arc(-15, 7, 5, 0.2, Math.PI - 0.2);
      g.strokeStyle = a.c2; g.lineWidth = 1.8; g.stroke();
      g.restore();
    },

    /* ---------- apparel ----------
       Laid flat on the ground the way a garment falls, with the cloth
       shading that tells it from a painted shape. */

    shirt: function (g, a) {
      var cx = PX / 2, cy = PX / 2;
      groundShadow(g, cx, cy + 16, 19, 5);
      poly(g, [cx - 11, cy - 16, cx + 11, cy - 16, cx + 21, cy - 8, cx + 17, cy + 1,
               cx + 11, cy - 3, cx + 11, cy + 17, cx - 11, cy + 17, cx - 11, cy - 3,
               cx - 17, cy + 1, cx - 21, cy - 8], a.c1);
      g.save();
      poly(g, [cx - 11, cy - 16, cx + 11, cy - 16, cx + 21, cy - 8, cx + 17, cy + 1,
               cx + 11, cy - 3, cx + 11, cy + 17, cx - 11, cy + 17, cx - 11, cy - 3,
               cx - 17, cy + 1, cx - 21, cy - 8], rgba('#000000', 0));
      g.clip();
      gradRect(g, cx - 24, cy - 20, 48, 40, linGrad(g, cx - 12, cy - 14, cx + 14, cy + 16,
        [0, rgba('#ffffff', 0.28), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.26)]));
      for (var i = 0; i < 4; i++) {
        whip(g, cx - 10, cy - 2 + i * 5, cx, cy + i * 5, cx + 10, cy - 2 + i * 5,
          rgba('#000000', 0.12), 2);
      }
      g.restore();
      ell(g, cx, cy - 15, 7, 4, 0, a.c2);
      ell(g, cx, cy - 16, 6, 3, 0, shade(a.c2, -0.25));
      stroke(g, [cx, cy - 12, cx, cy + 16], rgba('#000000', 0.16), 1.4);
    },

    pants: function (g, a) {
      var cx = PX / 2, cy = PX / 2;
      groundShadow(g, cx, cy + 18, 15, 5);
      poly(g, [cx - 13, cy - 18, cx + 13, cy - 18, cx + 13, cy + 18, cx + 3, cy + 18,
               cx, cy + 2, cx - 3, cy + 18, cx - 13, cy + 18], a.c1);
      g.save();
      poly(g, [cx - 13, cy - 18, cx + 13, cy - 18, cx + 13, cy + 18, cx + 3, cy + 18,
               cx, cy + 2, cx - 3, cy + 18, cx - 13, cy + 18], rgba('#000000', 0));
      g.clip();
      gradRect(g, cx - 16, cy - 20, 32, 40, linGrad(g, cx - 10, cy - 14, cx + 12, cy + 16,
        [0, rgba('#ffffff', 0.26), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.28)]));
      for (var i = 0; i < 5; i++) {
        whip(g, cx - 12, cy - 4 + i * 5, cx, cy - 2 + i * 5, cx + 12, cy - 4 + i * 5,
          rgba('#000000', 0.11), 2);
      }
      g.restore();
      rrect(g, cx - 13, cy - 18, 26, 6, 1.5, a.c2);
      fill(g, cx - 13, cy - 18, 26, 1.6, rgba('#ffffff', 0.3));
      rrect(g, cx - 3, cy - 16.5, 6, 3, 1.5, shade(P.brass, 0.1));
    },

    jacket: function (g, a) {
      var cx = PX / 2, cy = PX / 2;
      groundShadow(g, cx, cy + 17, 21, 5);
      poly(g, [cx - 13, cy - 17, cx + 13, cy - 17, cx + 23, cy - 8, cx + 19, cy + 3,
               cx + 13, cy - 2, cx + 13, cy + 18, cx - 13, cy + 18, cx - 13, cy - 2,
               cx - 19, cy + 3, cx - 23, cy - 8], a.c1);
      g.save();
      poly(g, [cx - 13, cy - 17, cx + 13, cy - 17, cx + 23, cy - 8, cx + 19, cy + 3,
               cx + 13, cy - 2, cx + 13, cy + 18, cx - 13, cy + 18, cx - 13, cy - 2,
               cx - 19, cy + 3, cx - 23, cy - 8], rgba('#000000', 0));
      g.clip();
      gradRect(g, cx - 26, cy - 20, 52, 42, linGrad(g, cx - 14, cy - 14, cx + 16, cy + 18,
        [0, rgba('#ffffff', 0.26), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.28)]));
      /* Lapels and the open front. */
      poly(g, [cx - 10, cy - 15, cx - 1, cy - 15, cx - 3, cy + 18, cx - 10, cy + 18], shade(a.c1, -0.18));
      poly(g, [cx + 10, cy - 15, cx + 1, cy - 15, cx + 3, cy + 18, cx + 10, cy + 18], shade(a.c1, -0.1));
      g.restore();
      fill(g, cx - 1, cy - 14, 2, 32, rgba('#000000', 0.35));
      for (var b = 0; b < 3; b++) {
        circle(g, cx - 5, cy - 6 + b * 9, 2.2, a.c2);
        circle(g, cx - 5.6, cy - 6.6 + b * 9, 0.9, rgba('#ffffff', 0.45));
      }
      ell(g, cx, cy - 16, 8, 4, 0, shade(a.c1, -0.3));
    },

    parka: function (g, a) {
      var cx = PX / 2, cy = PX / 2 + 1;
      groundShadow(g, cx, cy + 17, 22, 5);
      poly(g, [cx - 15, cy - 14, cx + 15, cy - 14, cx + 24, cy - 5, cx + 20, cy + 6,
               cx + 15, cy + 1, cx + 15, cy + 18, cx - 15, cy + 18, cx - 15, cy + 1,
               cx - 20, cy + 6, cx - 24, cy - 5], a.c1);
      g.save();
      poly(g, [cx - 15, cy - 14, cx + 15, cy - 14, cx + 24, cy - 5, cx + 20, cy + 6,
               cx + 15, cy + 1, cx + 15, cy + 18, cx - 15, cy + 18, cx - 15, cy + 1,
               cx - 20, cy + 6, cx - 24, cy - 5], rgba('#000000', 0));
      g.clip();
      gradRect(g, cx - 26, cy - 18, 52, 40, linGrad(g, cx - 14, cy - 12, cx + 16, cy + 18,
        [0, rgba('#ffffff', 0.24), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.3)]));
      /* Quilting: the channels a stuffed coat is sewn into. */
      for (var i = 0; i < 5; i++) {
        var qy = cy - 8 + i * 6;
        whip(g, cx - 15, qy, cx, qy + 2, cx + 15, qy, rgba('#000000', 0.2), 1.6);
        whip(g, cx - 15, qy + 2, cx, qy + 4, cx + 15, qy + 2, rgba('#ffffff', 0.14), 1.2);
      }
      g.restore();
      /* Fur-trimmed hood. */
      ell(g, cx, cy - 15, 13, 8, 0, shade(a.c1, -0.2));
      for (var f = 0; f < 22; f++) {
        var ang = Math.PI + f * Math.PI / 21;
        var fx = cx + Math.cos(ang) * 13, fy = cy - 15 + Math.sin(ang) * 8;
        stroke(g, [fx, fy, fx + Math.cos(ang) * 4, fy + Math.sin(ang) * 3.4],
          rgba(a.c2, 0.85), 2.2);
      }
      ell(g, cx, cy - 14, 8, 4.5, 0, rgba(P.ink, 0.5));
    },

    vest: function (g, a) {
      var cx = PX / 2, cy = PX / 2;
      groundShadow(g, cx, cy + 16, 17, 5);
      rrect(g, cx - 16, cy - 16, 32, 33, 5, a.c1);
      rrectPath(g, cx - 16, cy - 16, 32, 33, 5);
      g.save(); g.clip();
      gradRect(g, cx - 16, cy - 16, 32, 33, linGrad(g, cx - 10, cy - 12, cx + 12, cy + 14,
        [0, rgba('#ffffff', 0.3), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.3)]));
      /* Armour plates with their seams. */
      for (var i = 0; i < 4; i++) {
        fill(g, cx - 16, cy - 10 + i * 7, 32, 1.6, rgba('#000000', 0.32));
        fill(g, cx - 16, cy - 8.4 + i * 7, 32, 1, rgba('#ffffff', 0.18));
      }
      fill(g, cx - 2, cy - 16, 4, 33, rgba('#000000', 0.22));
      g.restore();
      /* Shoulder straps. */
      rrect(g, cx - 21, cy - 14, 6, 14, 3, shade(a.c2, -0.1));
      rrect(g, cx + 15, cy - 14, 6, 14, 3, shade(a.c2, -0.1));
      rrectLine(g, cx - 16, cy - 16, 32, 33, 5, rgba('#000000', 0.42), 1.3);
      circle(g, cx, cy + 12, 3, a.c2);
    },

    helmet: function (g, a) {
      var cx = PX / 2, cy = PX / 2 + 1;
      groundShadow(g, cx, cy + 13, 17, 5);
      /* A dome seen from above: crown highlight, brim, chin strap. */
      circle(g, cx, cy, 19, shade(a.c1, -0.3));
      circle(g, cx, cy, 17, a.c1);
      g.fillStyle = radGrad(g, cx - 6, cy - 7, 1, 24,
        [0, rgba('#ffffff', 0.5), 0.35, rgba('#ffffff', 0.1), 1, rgba('#000000', 0.32)]);
      g.beginPath(); g.arc(cx, cy, 17, 0, TAU); g.fill();
      ring(g, cx, cy, 17, 2, rgba('#000000', 0.4));
      /* Brow ridge and the strap. */
      g.beginPath(); g.arc(cx, cy, 13, 0.35, Math.PI - 0.35);
      g.strokeStyle = rgba(a.c2, 0.9); g.lineWidth = 4; g.stroke();
      g.beginPath(); g.arc(cx, cy, 13, 0.35, Math.PI - 0.35);
      g.strokeStyle = rgba('#ffffff', 0.18); g.lineWidth = 1.4; g.stroke();
      circle(g, cx - 5, cy - 6, 3.4, rgba('#ffffff', 0.35));
      circle(g, cx, cy - 15, 2.4, shade(a.c2, 0.2));
    },

    /* ---------- effects that are also things ---------- */

    fire: function (g, a) {
      glow(g, PX / 2, PX / 2 + 8, 26, P.flame, 0.9);
      flameIllus(g, PX / 2, PX - 8, a.frame, 34, 1);
    },

    filth: function (g, a) { bloodSplat(g, a.rnd, a.c1, a.c2, PX, PX); },

    bullet: function (g, a) {
      var cx = PX / 2, cy = PX / 2;
      /* Nose up: the renderer rotates it to the line of flight. */
      blob(g, cx, cy, 11, P.ember, 0.24, 0);
      g.beginPath();
      g.moveTo(cx, cy - 11);
      g.bezierCurveTo(cx + 3.4, cy - 6, cx + 3.4, cy + 2, cx + 3, cy + 6);
      g.lineTo(cx - 3, cy + 6);
      g.bezierCurveTo(cx - 3.4, cy + 2, cx - 3.4, cy - 6, cx, cy - 11);
      g.closePath();
      g.fillStyle = a.c1; g.fill();
      stroke(g, [cx - 1.4, cy - 8, cx - 1.4, cy + 5], rgba('#ffffff', 0.6), 1.4);
      rrect(g, cx - 3.2, cy + 5, 6.4, 6, 1.5, a.c2);
      /* A short tracer tail so a shot reads as motion. */
      gradRect(g, cx - 2, cy + 10, 4, 14, linGrad(g, 0, cy + 10, 0, cy + 24,
        [0, rgba(P.ember, 0.6), 1, rgba(P.ember, 0)]));
    },

    arrow: function (g, a) {
      var cx = PX / 2;
      stroke(g, [cx, 12, cx, 50], a.c1, 2.4);
      stroke(g, [cx - 0.8, 12, cx - 0.8, 50], rgba('#ffffff', 0.25), 1);
      poly(g, [cx, 4, cx + 4.5, 15, cx, 12.5, cx - 4.5, 15], a.c2);
      poly(g, [cx, 4, cx + 4.5, 15, cx, 12.5], rgba('#ffffff', 0.3));
      for (var i = 0; i < 2; i++) {
        var s = i ? 1 : -1;
        poly(g, [cx, 40, cx + s * 6, 48, cx + s * 5, 53, cx, 47], P.linen);
        poly(g, [cx, 40, cx + s * 6, 48, cx, 44], rgba('#000000', 0.16));
      }
    }
  };

  for (var ik in ITEMS) SPRITE[ik] = ITEMS[ik];

  /* ------------------------------------------------------------------
     Plants

     A plant is drawn over whatever terrain it stands on, so every one
     of these starts with a contact shadow and then builds upward. Three
     growth stages, and the silhouette has to change between them or the
     player cannot tell a field that is ready from a field that is not.
     ------------------------------------------------------------------ */

  function leaf(g, x, y, len, wide, ang, c, vein) {
    g.save();
    g.translate(x, y);
    g.rotate(ang);
    g.beginPath();
    g.moveTo(0, 0);
    g.quadraticCurveTo(wide, -len * 0.45, 0, -len);
    g.quadraticCurveTo(-wide, -len * 0.45, 0, 0);
    g.closePath();
    g.fillStyle = c; g.fill();
    if (vein !== false) {
      stroke(g, [0, -1, 0, -len + 1], rgba(shade(c, -0.3), 0.5), 0.9);
      stroke(g, [-wide * 0.5, -len * 0.35, 0, -len * 0.45], rgba(shade(c, -0.25), 0.35), 0.7);
      stroke(g, [wide * 0.5, -len * 0.35, 0, -len * 0.45], rgba(shade(c, -0.25), 0.35), 0.7);
    }
    g.beginPath();
    g.moveTo(0, -len * 0.1);
    g.quadraticCurveTo(wide * 0.55, -len * 0.45, 0, -len * 0.9);
    g.closePath();
    g.fillStyle = rgba('#ffffff', 0.16); g.fill();
    g.restore();
  }

  function paintGrassPlant(g, rnd, def, stage, variant) {
    var c1 = def.color, c2 = def.color2 || shade(c1, 0.12);
    var tall = def.id === 'tallGrass';
    var base = 50, spread = tall ? 22 : 18;
    var h = (tall ? 34 : 22) * (0.5 + stage * 0.25);
    blobEll(g, PX / 2 + 2, base + 3, spread, 5, '#000000', 0.22, 0.2);
    var tones = [c1, c2, shade(c1, -0.18), mix(c1, P.foliageLight, 0.35)];
    var n = tall ? 22 : 16;
    for (var i = 0; i < n; i++) {
      var x = PX / 2 + rs(rnd, spread);
      var y = base + rs(rnd, 5);
      var bh = h * rr(rnd, 0.55, 1.1);
      var lean = rs(rnd, bh * 0.45) + (variant - 1) * 2;
      whip(g, x, y, x + lean * 0.35, y - bh * 0.6, x + lean, y - bh,
        tones[(rnd() * tones.length) | 0], rr(rnd, 1.2, 2.4));
      if (bh > 16 && rnd() < 0.4) {
        /* A seed head on the longest blades. */
        ell(g, x + lean, y - bh, 1.6, 3.4, lean * 0.04, rgba(shade(c2, 0.18), 0.85));
      }
    }
    for (var t = 0; t < 6; t++) {
      var tx = PX / 2 + rs(rnd, spread);
      whip(g, tx, base, tx + rs(rnd, 4), base - h * 0.5, tx + rs(rnd, 8), base - h * 0.95,
        rgba(shade(c2, 0.28), 0.6), 1);
    }
  }

  function paintBush(g, rnd, def, stage, ripe) {
    var c1 = def.color, c2 = def.color2 || shade(c1, 0.15);
    var s = [0.5, 0.78, 1][stage];
    var cx = PX / 2, cy = PX / 2 + 5, r = 22 * s;
    blobEll(g, cx + 3, cy + r * 0.62, r * 0.95, r * 0.3, '#000000', 0.3, 0.25);
    /* Woody stems first, then three tones of foliage in clumps. */
    for (var st = 0; st < 4; st++) {
      var ang = -Math.PI / 2 + rs(rnd, 1.1);
      stroke(g, [cx, cy + r * 0.5, cx + Math.cos(ang) * r * 0.5, cy + Math.sin(ang) * r * 0.5],
        shade(P.bark, -0.1), 2.6);
    }
    var tones = [shade(c1, -0.22), c1, mix(c1, P.foliageLight, 0.3)];
    for (var layer = 0; layer < 3; layer++) {
      var n = 5 - layer, rr0 = r * (1 - layer * 0.16);
      for (var i = 0; i < n; i++) {
        var a2 = (i / n) * TAU + layer * 0.7;
        var bx = cx + Math.cos(a2) * rr0 * 0.42 - layer * 1.6;
        var by = cy + Math.sin(a2) * rr0 * 0.34 - layer * 3;
        ell(g, bx, by, rr0 * 0.52, rr0 * 0.44, rs(rnd, 0.5), tones[layer]);
      }
    }
    /* Individual leaves around the rim break the blob silhouette. */
    for (var l = 0; l < 14; l++) {
      var la = rnd() * TAU, ld = r * rr(rnd, 0.55, 0.95);
      leaf(g, cx + Math.cos(la) * ld * 0.8, cy + Math.sin(la) * ld * 0.6,
        r * 0.32, r * 0.13, la + Math.PI / 2,
        rnd() < 0.4 ? tones[2] : tones[1]);
    }
    if (def.id === 'healroot') {
      /* Five-petalled flowers, which is how you spot healroot in the
         wild from across the map. */
      for (var f = 0; f < 4 + stage * 2; f++) {
        var fx = cx + rs(rnd, r * 0.7), fy = cy + rs(rnd, r * 0.55);
        for (var p = 0; p < 5; p++) {
          var pa = p * TAU / 5 + rnd();
          ell(g, fx + Math.cos(pa) * 2.4, fy + Math.sin(pa) * 2.4, 2.2, 1.5, pa, c2);
        }
        circle(g, fx, fy, 1.5, P.gold);
      }
    } else if (ripe) {
      for (var b = 0; b < 12; b++) {
        var bx2 = cx + rs(rnd, r * 0.8), by2 = cy + rs(rnd, r * 0.62);
        circle(g, bx2 + 0.8, by2 + 1, 3.4, rgba('#000000', 0.3));
        circle(g, bx2, by2, 3.2, c2);
        circle(g, bx2 - 1, by2 - 1.2, 1.1, rgba('#ffffff', 0.7));
      }
    }
  }

  /* Trees overhang their tile. The canvas is 2x2 tiles placed at
     ox/oy = -32, so the tile the tree actually occupies is canvas
     x 32..95, y 32..95 - which is where the trunk has to land. */
  function paintTree(g, rnd, def, stage) {
    var leafC = def.color, bark = def.color2 || P.bark;
    var pine = def.id === 'treePine';
    var scale = [0.42, 0.7, 1][stage];
    var cx = 64, base = 92;
    var trunkH = (pine ? 46 : 38) * scale;
    var top = base - trunkH;
    var canopyR = (pine ? 30 : 38) * scale;

    /* The shadow the canopy throws, south-east of the trunk. */
    blobEll(g, cx + canopyR * 0.42, base - canopyR * 0.1, canopyR * 0.95, canopyR * 0.4,
      '#000000', 0.34, 0.25);

    /* Trunk: tapered, with bark running up it and roots flaring out. */
    var tw = (pine ? 7 : 8) * scale + 2;
    g.beginPath();
    g.moveTo(cx - tw, base);
    g.quadraticCurveTo(cx - tw * 0.55, base - trunkH * 0.5, cx - tw * 0.4, top);
    g.lineTo(cx + tw * 0.4, top);
    g.quadraticCurveTo(cx + tw * 0.55, base - trunkH * 0.5, cx + tw, base);
    g.closePath();
    g.fillStyle = bark; g.fill();
    g.save(); g.clip();
    gradRect(g, cx - tw - 2, top - 2, tw * 2 + 4, trunkH + 4,
      linGrad(g, cx - tw, 0, cx + tw, 0,
        [0, rgba('#ffffff', 0.26), 0.35, rgba('#ffffff', 0.02), 1, rgba('#000000', 0.34)]));
    for (var b = 0; b < 7; b++) {
      var bx = cx + rs(rnd, tw);
      whip(g, bx, base, bx + rs(rnd, 2.5), base - trunkH * 0.5, bx + rs(rnd, 2), top,
        rgba(shade(bark, -0.35), rr(rnd, 0.3, 0.6)), rr(rnd, 0.8, 1.8));
    }
    g.restore();
    for (var rt = 0; rt < 3; rt++) {
      var ra = Math.PI * (0.15 + rt * 0.35);
      stroke(g, [cx, base - 2, cx + Math.cos(ra) * tw * 2.4, base + Math.sin(ra) * 4],
        shade(bark, -0.15), 3.2);
    }

    if (pine) {
      /* Four tiers of needles, each a fan of short strokes, darkest at
         the bottom where the light does not reach. */
      var tiers = 4;
      for (var t = 0; t < tiers; t++) {
        var ty = base - 8 - t * (trunkH * 0.26);
        var tr = canopyR * (1 - t * 0.19);
        var tone = mix(leafC, t > 1 ? P.foliageLight : P.foliageDark, 0.18 + t * 0.08);
        ell(g, cx, ty - tr * 0.28, tr, tr * 0.5, 0, mix(leafC, P.foliageDark, 0.35));
        for (var n = 0; n < 26; n++) {
          var ang = Math.PI + (n / 25) * Math.PI;
          var dist = tr * rr(rnd, 0.35, 1);
          var nx = cx + Math.cos(ang) * dist, ny = ty - Math.abs(Math.sin(ang)) * tr * 0.4;
          stroke(g, [nx, ny + 5, nx + Math.cos(ang) * 6, ny + 9],
            rnd() < 0.4 ? mix(tone, '#000000', 0.2) : tone, rr(rnd, 1.6, 3.2));
        }
        ell(g, cx - tr * 0.2, ty - tr * 0.36, tr * 0.5, tr * 0.22, -0.15,
          rgba(mix(leafC, P.foliageLight, 0.5), 0.5));
      }
      circle(g, cx, base - trunkH - 4, 5 * scale, mix(leafC, P.foliageLight, 0.3));
    } else {
      /* A broadleaf canopy is overlapping clumps: a dark mass, a mid
         tone rolled toward the light, and a few lit crowns. */
      var cy = top - canopyR * 0.28;
      var clumps = [];
      for (var i = 0; i < 9; i++) {
        var ang2 = (i / 9) * TAU + rs(rnd, 0.3);
        var d = canopyR * (i === 0 ? 0 : rr(rnd, 0.35, 0.62));
        clumps.push([cx + Math.cos(ang2) * d, cy + Math.sin(ang2) * d * 0.8,
          canopyR * rr(rnd, 0.4, 0.58)]);
      }
      for (var k = 0; k < clumps.length; k++) {
        ell(g, clumps[k][0] + 2, clumps[k][1] + 3, clumps[k][2], clumps[k][2] * 0.86,
          0, mix(leafC, '#000000', 0.42));
      }
      for (var k2 = 0; k2 < clumps.length; k2++) {
        ell(g, clumps[k2][0], clumps[k2][1], clumps[k2][2], clumps[k2][2] * 0.86, 0, leafC);
      }
      for (var k3 = 0; k3 < clumps.length; k3++) {
        ell(g, clumps[k3][0] - clumps[k3][2] * 0.25, clumps[k3][1] - clumps[k3][2] * 0.28,
          clumps[k3][2] * 0.6, clumps[k3][2] * 0.48, -0.3,
          mix(leafC, P.foliageLight, 0.45));
      }
      /* Leaf edges around the rim, so the canopy is not a set of discs. */
      for (var l = 0; l < 30; l++) {
        var la = rnd() * TAU, ld = canopyR * rr(rnd, 0.72, 1.05);
        var lx = cx + Math.cos(la) * ld, ly = cy + Math.sin(la) * ld * 0.84;
        leaf(g, lx, ly, canopyR * 0.28, canopyR * 0.11, la + Math.PI / 2,
          rnd() < 0.45 ? mix(leafC, P.foliageLight, 0.35) : mix(leafC, '#000000', 0.2), false);
      }
      /* Dapple: the holes the sun comes through. */
      for (var d2 = 0; d2 < 12; d2++) {
        var da = rnd() * TAU, dd = canopyR * rr(rnd, 0.1, 0.8);
        blob(g, cx + Math.cos(da) * dd, cy + Math.sin(da) * dd * 0.84,
          canopyR * rr(rnd, 0.08, 0.18),
          rnd() < 0.5 ? '#ffffff' : '#000000', rr(rnd, 0.06, 0.16), 0.1);
      }
    }
  }

  function paintCrop(g, rnd, def, stage) {
    var c1 = def.color, c2 = def.color2 || shade(c1, 0.2);
    var id = def.id;
    var cx = PX / 2, base = 54;
    var s = [0.34, 0.66, 1][stage];
    blobEll(g, cx + 2, base + 2, 20 * s + 5, 4.5, '#000000', 0.24, 0.2);

    if (id === 'plantCorn') {
      /* One tall stalk with broad arching leaves; cobs when ripe. */
      var h = 46 * s;
      stroke(g, [cx, base, cx + 1, base - h * 0.5, cx - 1, base - h], shade(c1, -0.15), 3.4 * s + 1);
      stroke(g, [cx - 1, base, cx, base - h * 0.5, cx - 2, base - h], rgba('#ffffff', 0.2), 1.2);
      for (var i = 0; i < 6; i++) {
        var side = i & 1 ? 1 : -1, ly = base - h * (0.2 + i * 0.13);
        var len = (26 - i * 2) * s;
        g.beginPath();
        g.moveTo(cx, ly);
        g.quadraticCurveTo(cx + side * len * 0.7, ly - len * 0.35,
          cx + side * len, ly + len * 0.2);
        g.quadraticCurveTo(cx + side * len * 0.65, ly - len * 0.1, cx, ly + 2);
        g.closePath();
        g.fillStyle = i % 2 ? c1 : shade(c1, 0.12); g.fill();
        stroke(g, [cx, ly, cx + side * len * 0.9, ly + len * 0.08],
          rgba(shade(c1, -0.3), 0.4), 0.9);
      }
      if (stage === 2) {
        for (var k = 0; k < 2; k++) {
          var kx = cx + (k ? 7 : -7), ky = base - h * (0.42 + k * 0.16);
          ell(g, kx, ky, 4.4, 10, k ? 0.2 : -0.2, c2);
          ell(g, kx - 1, ky - 1, 2.2, 7, k ? 0.2 : -0.2, shade(c2, 0.3));
          for (var t = -3; t <= 3; t++) {
            stroke(g, [kx - 3.4, ky + t * 2.6, kx + 3.4, ky + t * 2.6],
              rgba(shade(c2, -0.28), 0.5), 0.8);
          }
          /* Silk at the tip. */
          for (var w = 0; w < 4; w++) {
            whip(g, kx, ky - 9, kx + rs(rnd, 3), ky - 13, kx + rs(rnd, 6), ky - 16,
              rgba(P.sand, 0.8), 1);
          }
        }
      }
      return;
    }

    /* Everything else is a low leafy plant: a rosette of leaves with
       whatever it produces sitting in or above it. */
    var n = stage === 0 ? 4 : 7;
    var len = 20 * s;
    for (var i2 = 0; i2 < n; i2++) {
      var ang = -Math.PI / 2 + ((i2 / (n - 1)) - 0.5) * 2.5 + rs(rnd, 0.14);
      var ll = len * rr(rnd, 0.75, 1.15);
      leaf(g, cx + rs(rnd, 4), base, ll, ll * 0.36, ang,
        i2 % 3 ? c1 : shade(c1, 0.14));
    }

    if (stage === 0) return;

    if (id === 'plantRice') {
      /* Ripe rice droops: the heavier the head, the more it bends. */
      var stalks = stage === 2 ? 5 : 3;
      for (var r = 0; r < stalks; r++) {
        var sx = cx + (r - (stalks - 1) / 2) * 6 + rs(rnd, 2);
        var sh = (stage === 2 ? 34 : 22) * rr(rnd, 0.85, 1.1);
        var droop = stage === 2 ? 9 : 2;
        whip(g, sx, base, sx + rs(rnd, 3), base - sh * 0.6, sx + droop, base - sh,
          shade(c1, 0.1), 1.8);
        if (stage === 2) {
          for (var gk = 0; gk < 7; gk++) {
            var t2 = gk / 7;
            var gx = sx + droop * (0.5 + t2 * 0.7), gy = base - sh + t2 * 11;
            ell(g, gx + rs(rnd, 1.6), gy, 1.7, 3, 0.5 + t2 * 0.5, c2);
          }
        }
      }
    } else if (id === 'plantCotton') {
      if (stage === 2) {
        for (var bl = 0; bl < 4; bl++) {
          var bx = cx + rs(rnd, 15), by = base - rr(rnd, 8, 22);
          /* A boll is four lobes of fibre out of a dry brown husk. */
          for (var lb = 0; lb < 4; lb++) {
            var la2 = lb * TAU / 4 + 0.4;
            ell(g, bx + Math.cos(la2) * 3, by + Math.sin(la2) * 3, 4.4, 3.6, la2,
              rgba(c2, 0.95));
          }
          circle(g, bx, by, 3.4, '#ffffff');
          for (var hk = 0; hk < 4; hk++) {
            var ha = hk * TAU / 4 + 0.4 + Math.PI / 4;
            stroke(g, [bx, by, bx + Math.cos(ha) * 6, by + Math.sin(ha) * 6],
              rgba(shade(P.bark, 0.1), 0.85), 2);
          }
        }
      } else {
        for (var f2 = 0; f2 < 3; f2++) {
          circle(g, cx + rs(rnd, 10), base - rr(rnd, 6, 14), 2.2, rgba(P.gold, 0.7));
        }
      }
    } else if (id === 'plantHealroot') {
      var fl = stage === 2 ? 6 : 2;
      for (var f3 = 0; f3 < fl; f3++) {
        var fx = cx + rs(rnd, 13), fy = base - rr(rnd, 10, 26);
        stroke(g, [fx, base - 4, fx, fy], shade(c1, -0.2), 1.4);
        for (var p2 = 0; p2 < 5; p2++) {
          var pa2 = p2 * TAU / 5 + f3;
          ell(g, fx + Math.cos(pa2) * 3, fy + Math.sin(pa2) * 3, 3, 2, pa2, c2);
        }
        circle(g, fx, fy, 1.8, P.gold);
      }
    } else if (id === 'plantPotato') {
      if (stage === 2) {
        /* The crop is under the ground, so what shows is the tuber
           shouldering out of the soil at the base. */
        for (var t3 = 0; t3 < 3; t3++) {
          var tx = cx + rs(rnd, 13), ty = base + rr(rnd, -2, 3);
          ell(g, tx + 1, ty + 1.5, 6, 4, 0.3, rgba('#000000', 0.3));
          ell(g, tx, ty, 6, 4, 0.3, mix(P.sand, P.soil, 0.45));
          ell(g, tx - 1.6, ty - 1.2, 2.6, 1.6, 0.3, rgba('#ffffff', 0.25));
        }
      }
      for (var f4 = 0; f4 < 3; f4++) {
        circle(g, cx + rs(rnd, 11), base - rr(rnd, 10, 20), 2.2, rgba(c2, 0.8));
      }
    } else if (stage === 2) {
      for (var b2 = 0; b2 < 5; b2++) {
        var bx3 = cx + rs(rnd, 13), by3 = base - rr(rnd, 6, 20);
        circle(g, bx3 + 0.7, by3 + 1, 3.2, rgba('#000000', 0.25));
        circle(g, bx3, by3, 3, c2);
        circle(g, bx3 - 1, by3 - 1, 1, rgba('#ffffff', 0.6));
      }
    }
  }

  /* ------------------------------------------------------------------
     Effects

     Everything particles.js and render.js draw that is not a thing: the
     fire atlas, smoke, explosions, blood, muzzle flashes, sparks, dust,
     splashes and weather. Each atlas is a small fixed number of frames,
     and Art.effect folds whatever frame number a caller hands in back
     into range before it reaches a cache key - a clock that climbs for
     as long as the page is open must not grow the cache with it.
     ------------------------------------------------------------------ */

  /* One tongue of flame: a teardrop whose tip leans and whose waist
     wobbles with the frame. */
  function flameBody(g, cx, baseY, w, h, lean, wob, color) {
    g.beginPath();
    g.moveTo(cx - w, baseY);
    g.bezierCurveTo(cx - w * 1.1, baseY - h * 0.42, cx - w * 0.5 + lean * 0.3 - wob,
      baseY - h * 0.72, cx + lean, baseY - h);
    g.bezierCurveTo(cx + w * 0.5 + lean * 0.3 + wob, baseY - h * 0.72,
      cx + w * 1.1, baseY - h * 0.42, cx + w, baseY);
    g.quadraticCurveTo(cx, baseY + h * 0.1, cx - w, baseY);
    g.closePath();
    g.fillStyle = color; g.fill();
  }

  /* `frame` runs 0..5. Intensity scales the whole thing without
     changing its shape, which is what a dying fire needs. */
  function flameIllus(g, cx, baseY, frame, height, intensity) {
    frame = ((frame % 6) + 6) % 6;
    intensity = intensity === undefined ? 1 : intensity;
    var phase = frame / 6 * TAU;
    var lean = Math.sin(phase) * height * 0.13;
    var wob = Math.cos(phase * 2) * height * 0.06;
    var h = height * (0.86 + Math.sin(phase * 2) * 0.14) * intensity;
    var w = height * 0.3 * intensity;

    g.globalCompositeOperation = 'lighter';
    blob(g, cx + lean * 0.4, baseY - h * 0.45, h * 0.85, P.flame, 0.18 * intensity, 0);
    g.globalCompositeOperation = 'source-over';

    /* Four nested bodies: dark root, orange, yellow, white heart. */
    flameBody(g, cx, baseY, w * 1.12, h * 0.55, lean * 0.3, wob * 0.4, rgba('#7a1f0a', 0.75));
    flameBody(g, cx, baseY, w, h, lean, wob, '#e8501a');
    flameBody(g, cx, baseY, w * 0.72, h * 0.74, lean * 0.85, wob * 0.8, P.flame);
    flameBody(g, cx, baseY, w * 0.45, h * 0.5, lean * 0.7, wob * 0.6, P.ember);
    flameBody(g, cx, baseY - h * 0.05, w * 0.2, h * 0.26, lean * 0.4, 0, '#fff4c4');

    /* Detached licks above the body, which is what makes it move. */
    for (var i = 0; i < 3; i++) {
      var t = (i + frame * 0.37) % 1;
      var lx = cx + lean * (1.1 + i * 0.2) + Math.sin(phase + i * 2) * w * 0.55;
      var ly = baseY - h * (0.85 + t * 0.5);
      flameBody(g, lx, ly, w * (0.22 - t * 0.1), h * (0.22 - t * 0.1), lean * 0.4, 0,
        rgba(t < 0.5 ? P.ember : P.flame, 0.7 - t * 0.5));
    }
    /* Embers riding the column. */
    for (var e = 0; e < 5; e++) {
      var ea = phase + e * 1.7;
      circle(g, cx + Math.sin(ea) * w * 1.1, baseY - h * (0.5 + (e / 5) * 0.9),
        height * 0.028, rgba(P.ember, 0.85));
    }
  }

  /* Blood: a main pool with a lit meniscus, satellite drops, and the
     directional spatter of the hit that made it. */
  function bloodSplat(g, rnd, c1, c2, w, h) {
    var dark = c2 || shade(c1, -0.35);
    var cx = w / 2 + rs(rnd, w * 0.1), cy = h / 2 + rs(rnd, h * 0.1);
    var dir = rnd() * TAU;
    var r = w * rr(rnd, 0.17, 0.26);
    /* An irregular pool rather than an ellipse: blood does not pool
       round. */
    var n = 9, pts = [];
    for (var k = 0; k < n; k++) {
      var ang = (k / n) * TAU, rk = r * rr(rnd, 0.7, 1.3);
      pts.push(cx + Math.cos(ang) * rk, cy + Math.sin(ang) * rk * 0.85);
    }
    g.beginPath();
    g.moveTo(pts[0], pts[1]);
    for (var i = 2; i < pts.length; i += 2) {
      var px2 = pts[i], py = pts[i + 1];
      var qx = (pts[i - 2] + px2) / 2 + rs(rnd, r * 0.18);
      var qy = (pts[i - 1] + py) / 2 + rs(rnd, r * 0.18);
      g.quadraticCurveTo(qx, qy, px2, py);
    }
    g.closePath();
    g.fillStyle = c1; g.fill();
    g.fillStyle = radGrad(g, cx - r * 0.3, cy - r * 0.3, 0, r * 1.5,
      [0, rgba('#ffffff', 0.22), 0.5, rgba(dark, 0.1), 1, rgba(dark, 0.55)]);
    g.fill();
    /* Fingers thrown in the direction of travel. */
    for (var f = 0; f < 5; f++) {
      var fa = dir + rs(rnd, 0.6);
      var fd = r * rr(rnd, 1.1, 2.2);
      var fx = cx + Math.cos(fa) * fd, fy = cy + Math.sin(fa) * fd * 0.85;
      ell(g, fx, fy, rr(rnd, 1.4, 3.4), rr(rnd, 1, 2.2), fa, c1);
      stroke(g, [cx + Math.cos(fa) * r * 0.8, cy + Math.sin(fa) * r * 0.7, fx, fy],
        rgba(c1, 0.6), rr(rnd, 1, 2.4));
    }
    /* Fine droplets, all over. */
    for (var d = 0; d < 14; d++) {
      var da = rnd() * TAU, dd = r * rr(rnd, 1.1, 3);
      var dx = cx + Math.cos(da) * dd, dy = cy + Math.sin(da) * dd * 0.85;
      if (dx < 1 || dy < 1 || dx > w - 1 || dy > h - 1) continue;
      circle(g, dx, dy, rr(rnd, 0.7, 2), rgba(rnd() < 0.4 ? dark : c1, rr(rnd, 0.55, 0.95)));
    }
  }

  function paintSmoke(g, rnd, size, tone) {
    var cx = PX / 2, cy = PX / 2;
    /* Overlapping soft lobes so a puff has some internal structure
       rather than being one radial gradient. */
    for (var i = 0; i < 5; i++) {
      var ang = (i / 5) * TAU + rnd();
      var d = size * rr(rnd, 0.1, 0.35);
      blob(g, cx + Math.cos(ang) * d, cy + Math.sin(ang) * d * 0.9,
        size * rr(rnd, 0.5, 0.8), tone, rr(rnd, 0.16, 0.3), 0.08);
    }
    blob(g, cx - size * 0.18, cy - size * 0.2, size * 0.42, mix(tone, '#ffffff', 0.5), 0.14, 0.05);
  }

  function paintExplosion(g, rnd, frame) {
    var S = PX * 3, cx = S / 2, cy = S / 2;
    var t = frame / 5;
    var r = S * (0.08 + t * 0.4);

    if (frame <= 1) {
      /* The flash: all the light at once, before anything is visible. */
      g.globalCompositeOperation = 'lighter';
      blob(g, cx, cy, r * (frame ? 2.6 : 1.9), '#fff4c4', frame ? 0.5 : 0.85, 0.15);
      blob(g, cx, cy, r * 1.2, '#ffffff', 0.95, 0.5);
      g.globalCompositeOperation = 'source-over';
    }
    if (frame >= 1 && frame <= 4) {
      /* Fireball: a ring of burning lobes cooling from white to red. */
      var heat = 1 - (frame - 1) / 3;
      var lobes = 11;
      for (var i = 0; i < lobes; i++) {
        var ang = (i / lobes) * TAU + frame;
        var d = r * rr(rnd, 0.55, 1);
        var lr = r * rr(rnd, 0.3, 0.55);
        blob(g, cx + Math.cos(ang) * d, cy + Math.sin(ang) * d, lr,
          mix('#c0392b', P.ember, heat), 0.55 * heat + 0.2, 0.25);
      }
      g.globalCompositeOperation = 'lighter';
      blob(g, cx, cy, r * 0.85, mix(P.flame, '#fff4c4', heat), 0.6 * heat + 0.15, 0.2);
      g.globalCompositeOperation = 'source-over';
    }
    if (frame >= 2) {
      /* Smoke, thickening and spreading as the fire dies. */
      var sa = 0.16 + (frame - 2) * 0.06;
      var sr = S * (0.16 + (frame - 2) * 0.07);
      for (var k = 0; k < 14; k++) {
        var ang2 = (k / 14) * TAU + frame * 0.6;
        var dd = r * rr(rnd, 0.85, 1.35);
        blob(g, cx + Math.cos(ang2) * dd, cy + Math.sin(ang2) * dd, sr * rr(rnd, 0.5, 1),
          mix(P.smoke, '#9a9a9a', (frame - 2) / 3), sa * rr(rnd, 0.6, 1.2), 0.1);
      }
    }
    if (frame >= 1 && frame <= 4) {
      /* Debris streaks thrown clear of the blast. */
      for (var d2 = 0; d2 < 10; d2++) {
        var a2 = rnd() * TAU, d3 = r * rr(rnd, 0.9, 1.5);
        stroke(g, [cx + Math.cos(a2) * d3 * 0.6, cy + Math.sin(a2) * d3 * 0.6,
          cx + Math.cos(a2) * d3, cy + Math.sin(a2) * d3],
          rgba(P.ember, rr(rnd, 0.3, 0.8)), rr(rnd, 1, 2.6));
      }
    }
  }

  function paintMuzzle(g, rnd, frame) {
    /* Points north; the renderer rotates it onto the line of fire. */
    var cx = PX / 2, cy = PX * 0.72;
    var len = [26, 34, 18][frame] || 22;
    var w = [7, 9, 5][frame] || 6;
    g.globalCompositeOperation = 'lighter';
    blob(g, cx, cy - len * 0.35, len * 0.8, P.ember, 0.4, 0.05);
    g.globalCompositeOperation = 'source-over';
    flameBody(g, cx, cy, w, len, 0, 0, rgba(P.flame, 0.95));
    flameBody(g, cx, cy, w * 0.6, len * 0.75, 0, 0, P.ember);
    flameBody(g, cx, cy, w * 0.3, len * 0.45, 0, 0, '#fffbe8');
    /* Side petals: the gas escaping around the muzzle. */
    for (var i = 0; i < 4; i++) {
      var ang = -Math.PI / 2 + (i - 1.5) * 0.75;
      var d = len * rr(rnd, 0.3, 0.55);
      stroke(g, [cx, cy - 2, cx + Math.cos(ang) * d, cy + Math.sin(ang) * d],
        rgba(P.ember, 0.65), 3.2);
    }
  }

  function paintSpark(g, rnd, frame) {
    var cx = PX / 2, cy = PX / 2;
    var spread = 8 + frame * 7;
    g.globalCompositeOperation = 'lighter';
    blob(g, cx, cy, spread * 0.8, P.ember, 0.25 - frame * 0.05, 0.05);
    for (var i = 0; i < 9; i++) {
      var ang = (i / 9) * TAU + frame * 0.4 + rnd() * 0.3;
      var d = spread * rr(rnd, 0.5, 1.1);
      var x0 = cx + Math.cos(ang) * d * 0.35, y0 = cy + Math.sin(ang) * d * 0.35;
      var x1 = cx + Math.cos(ang) * d, y1 = cy + Math.sin(ang) * d;
      stroke(g, [x0, y0, x1, y1], rgba(i % 3 ? P.ember : '#fff4c4', 0.9 - frame * 0.2),
        rr(rnd, 1, 2.2));
      circle(g, x1, y1, rr(rnd, 0.8, 1.6), rgba('#ffffff', 0.8 - frame * 0.2));
    }
    g.globalCompositeOperation = 'source-over';
  }

  function paintDust(g, rnd, frame) {
    var cx = PX / 2, cy = PX / 2;
    var r = 7 + frame * 6;
    for (var i = 0; i < 6; i++) {
      var ang = (i / 6) * TAU + frame;
      var d = r * rr(rnd, 0.2, 0.7);
      blob(g, cx + Math.cos(ang) * d, cy + Math.sin(ang) * d * 0.7, r * rr(rnd, 0.5, 0.9),
        mix(P.sand, P.soil, 0.35), (0.3 - frame * 0.05) * rr(rnd, 0.7, 1.2), 0.06);
    }
    for (var k = 0; k < 5; k++) {
      circle(g, cx + rs(rnd, r), cy + rs(rnd, r * 0.7), rr(rnd, 0.7, 1.6),
        rgba(shade(P.soil, 0.15), 0.4));
    }
  }

  function paintSplash(g, rnd, frame) {
    var cx = PX / 2, cy = PX / 2 + 4;
    var r = 8 + frame * 6;
    /* The ring on the surface, then the crown, then the thrown drops. */
    g.beginPath();
    g.ellipse(cx, cy, r, r * 0.42, 0, 0, TAU);
    g.strokeStyle = rgba(mix(P.water, '#ffffff', 0.55), 0.55 - frame * 0.1);
    g.lineWidth = 2.4 - frame * 0.4;
    g.stroke();
    for (var i = 0; i < 8; i++) {
      var ang = (i / 8) * TAU;
      var hx = cx + Math.cos(ang) * r * 0.55, hy = cy + Math.sin(ang) * r * 0.24;
      var top = cy - (10 - frame * 2) - Math.abs(Math.sin(ang)) * 3;
      whip(g, hx, hy, hx + Math.cos(ang) * 3, (hy + top) / 2, hx + Math.cos(ang) * 6, top,
        rgba(mix(P.water, '#ffffff', 0.45), 0.7 - frame * 0.12), 2.2);
    }
    for (var d = 0; d < 7; d++) {
      var da = rnd() * TAU, dd = r * rr(rnd, 0.8, 1.5);
      var dx = cx + Math.cos(da) * dd, dy = cy + Math.sin(da) * dd * 0.5 - frame * 3;
      ell(g, dx, dy, rr(rnd, 1, 2.2), rr(rnd, 1.6, 3), 0,
        rgba(mix(P.water, '#ffffff', 0.6), 0.75 - frame * 0.12));
    }
    blobEll(g, cx, cy, r * 0.8, r * 0.3, '#ffffff', 0.2 - frame * 0.04, 0.1);
  }

  function paintSnow(g, rnd, frame) {
    var cx = PX / 2, cy = PX / 2;
    var r = 3 + frame * 1.6;
    blob(g, cx, cy, r * 2.2, '#ffffff', 0.2, 0.05);
    g.strokeStyle = 'rgba(255,255,255,0.95)';
    g.lineWidth = 1.2;
    g.lineCap = 'round';
    for (var i = 0; i < 6; i++) {
      var ang = i * TAU / 6 + frame * 0.2;
      var ex = cx + Math.cos(ang) * r, ey = cy + Math.sin(ang) * r;
      g.beginPath(); g.moveTo(cx, cy); g.lineTo(ex, ey); g.stroke();
      /* Barbs, which is what makes it a snowflake and not an asterisk. */
      var bx = cx + Math.cos(ang) * r * 0.55, by = cy + Math.sin(ang) * r * 0.55;
      g.beginPath();
      g.moveTo(bx, by);
      g.lineTo(bx + Math.cos(ang + 0.9) * r * 0.32, by + Math.sin(ang + 0.9) * r * 0.32);
      g.moveTo(bx, by);
      g.lineTo(bx + Math.cos(ang - 0.9) * r * 0.32, by + Math.sin(ang - 0.9) * r * 0.32);
      g.stroke();
    }
    g.lineCap = 'butt';
    circle(g, cx, cy, r * 0.22, '#ffffff');
  }

  function paintRain(g, rnd, frame) {
    var cx = PX / 2, cy = PX / 2;
    var len = 14 + frame * 5;
    /* A drop falling with a slight westerly lean, tapered at the top. */
    g.beginPath();
    g.moveTo(cx - 2.2, cy + len / 2);
    g.quadraticCurveTo(cx - 1, cy, cx - 3, cy - len / 2);
    g.lineTo(cx - 1.4, cy - len / 2);
    g.quadraticCurveTo(cx + 1, cy, cx + 0.6, cy + len / 2);
    g.closePath();
    g.fillStyle = rgba(mix(P.water, '#ffffff', 0.6), 0.55);
    g.fill();
    stroke(g, [cx - 2.4, cy + len / 2 - 2, cx - 2.4, cy - len / 2 + 4],
      rgba('#ffffff', 0.4), 0.9);
    ell(g, cx - 1, cy + len / 2, 2.4, 1.6, 0, rgba(mix(P.water, '#ffffff', 0.7), 0.7));
  }

  /* ------------------------------------------------------------------
     Pawns

     The most important sprite in the game. A human is assembled from
     layered parts - legs, torso, arms, head, hair, hat - so the walk
     cycle can move the parts rather than swap whole pictures, and so
     apparel colours land on the right piece. Four facings, four walk
     frames, plus a carrying pose and a lying pose.

     The figure is seen from above and slightly behind, which is the
     angle that lets a top-down game show a face at all. Light from the
     north-west, as everywhere else.
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
    var sid = t.stuff || t.stuffId;
    var stuff = sid && Defs.maybe('thing', sid);
    return stuff ? mix(d.color, stuff.color, 0.45) : d.color;
  }

  function humanStyle(pawn) {
    var h = U.hash('pawn' + (pawn.id || 0) + (pawn.kindId || ''));
    var fc = factionColor(pawn.faction);
    var s = {
      skin: SKIN[h % SKIN.length],
      hair: HAIR[(h >>> 5) % HAIR.length],
      style: (h >>> 11) % 4,
      build: ((h >>> 17) % 3) - 1,
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

  /* A limb: a capsule with a lit edge on the north-west side. */
  function limb(g, x0, y0, x1, y1, w, c) {
    stroke(g, [x0, y0, x1, y1], shade(c, -0.3), w);
    stroke(g, [x0, y0, x1, y1], c, w - 1.6);
    stroke(g, [x0 - w * 0.18, y0 - w * 0.18, x1 - w * 0.18, y1 - w * 0.18],
      rgba('#ffffff', 0.18), w * 0.35);
  }

  function paintHumanLying(g, s, dead) {
    var body = s.over || s.top;
    var skin = dead ? drained(s.skin) : s.skin;
    var cloth = dead ? drained(body) : body;
    var legC = dead ? drained(s.leg) : s.leg;
    var hair = dead ? drained(s.hair) : s.hair;
    var cx = 34, cy = 34;
    /* Head to the west, legs to the east, arms thrown out. */
    limb(g, cx + 4, cy + 4, cx + 22, cy + 12, 9, legC);
    limb(g, cx + 4, cy - 4, cx + 24, cy - 6, 9, legC);
    ell(g, cx, cy, 15, 11, 0.04, cloth);
    ell(g, cx - 2, cy - 3, 11, 6, 0.04, shade(cloth, 0.2));
    ell(g, cx + 6, cy + 5, 10, 5, 0.1, rgba('#000000', 0.2));
    limb(g, cx - 6, cy - 6, cx - 2, cy - 20, 7.5, cloth);
    limb(g, cx - 6, cy + 6, cx + 4, cy + 19, 7.5, cloth);
    circle(g, cx - 2, cy - 21, 3.6, skin);
    circle(g, cx + 5, cy + 20, 3.6, skin);
    circle(g, cx - 17, cy - 2, 11, skin);
    g.fillStyle = radGrad(g, cx - 21, cy - 6, 1, 15,
      [0, rgba('#ffffff', 0.32), 0.55, rgba('#ffffff', 0), 1, rgba('#000000', 0.3)]);
    g.beginPath(); g.arc(cx - 17, cy - 2, 11, 0, TAU); g.fill();
    /* Hair falls to the side the head is turned. */
    g.beginPath();
    g.arc(cx - 17, cy - 2, 11, Math.PI * 0.6, Math.PI * 1.9);
    g.closePath();
    g.fillStyle = hair; g.fill();
    if (dead) {
      for (var i = 0; i < 5; i++) {
        ell(g, cx - 10 + i * 9, cy + 8 + (i % 3) * 4, 5 + (i % 3) * 2, 3, i,
          rgba(P.blood, 0.55));
      }
      stroke(g, [cx - 22, cy + 2, cx - 14, cy + 4], rgba(P.blood, 0.7), 2);
    }
  }

  function paintHuman(g, s, dir, frame, pose) {
    if (pose === 'down' || pose === 'dead') {
      paintHumanLying(g, s, pose === 'dead');
      return;
    }
    var carry = pose === 'carry';
    var body = s.over || s.top;
    var dkBody = shade(body, -0.35);
    var cx = 32;
    var phase = (frame & 3) * Math.PI / 2;
    var swing = Math.sin(phase);
    var bob = (frame & 1) ? -1.4 : 0;
    var side = dir === 1 || dir === 3;
    var back = dir === 0;

    var hipY = 40 + bob, footY = 57;
    var shoulderY = 27 + bob, headY = 15 + bob;
    var halfW = (side ? 8 : 11) + s.build;

    /* ---- legs ---- */
    var legW = 9;
    if (side) {
      var fwd = swing * 8;
      limb(g, cx - 2, hipY, cx - 2 - fwd, footY - Math.abs(swing) * 2, legW, shade(s.leg, -0.22));
      limb(g, cx + 1, hipY, cx + 1 + fwd, footY - Math.abs(swing) * 2, legW, s.leg);
      ell(g, cx - 2 - fwd, footY, 5, 3.4, 0, shade(P.bark, -0.25));
      ell(g, cx + 1 + fwd, footY, 5, 3.4, 0, shade(P.bark, -0.15));
    } else {
      limb(g, cx - 6, hipY, cx - 6 - swing * 2, footY - Math.max(0, swing) * 4, legW, s.leg);
      limb(g, cx + 6, hipY, cx + 6 - swing * 2, footY + Math.min(0, swing) * 4, legW, s.leg);
      ell(g, cx - 6 - swing * 2, footY - Math.max(0, swing) * 4, 4.6, 3.2, 0, shade(P.bark, -0.2));
      ell(g, cx + 6 - swing * 2, footY + Math.min(0, swing) * 4, 4.6, 3.2, 0, shade(P.bark, -0.2));
    }

    /* ---- torso ---- */
    g.beginPath();
    g.moveTo(cx - halfW, shoulderY + 1);
    g.quadraticCurveTo(cx - halfW - 1.5, shoulderY - 4, cx - halfW * 0.62, shoulderY - 5);
    g.lineTo(cx + halfW * 0.62, shoulderY - 5);
    g.quadraticCurveTo(cx + halfW + 1.5, shoulderY - 4, cx + halfW, shoulderY + 1);
    g.lineTo(cx + halfW * 0.82, hipY + 3);
    g.quadraticCurveTo(cx, hipY + 6, cx - halfW * 0.82, hipY + 3);
    g.closePath();
    g.fillStyle = body; g.fill();
    g.save(); g.clip();
    gradRect(g, cx - halfW - 2, shoulderY - 8, halfW * 2 + 4, hipY - shoulderY + 16,
      linGrad(g, cx - halfW, shoulderY - 6, cx + halfW, hipY + 4,
        [0, rgba('#ffffff', 0.3), 0.42, rgba('#ffffff', 0.02), 1, rgba('#000000', 0.3)]));
    if (s.over) {
      /* A jacket hangs open over the shirt beneath it. */
      fill(g, cx - 2.2, shoulderY - 6, 4.4, hipY - shoulderY + 12, rgba(s.top, 0.95));
      fill(g, cx - 2.6, shoulderY - 6, 1, hipY - shoulderY + 12, rgba('#000000', 0.3));
      fill(g, cx + 1.8, shoulderY - 6, 1, hipY - shoulderY + 12, rgba('#000000', 0.3));
    }
    if (s.vest) {
      rrect(g, cx - halfW * 0.95, shoulderY - 4, halfW * 1.9, hipY - shoulderY + 6, 3, s.vest);
      gradRect(g, cx - halfW, shoulderY - 4, halfW * 2, hipY - shoulderY + 8,
        linGrad(g, cx - halfW, shoulderY, cx + halfW, hipY,
          [0, rgba('#ffffff', 0.28), 1, rgba('#000000', 0.28)]));
      for (var v = 0; v < 3; v++) {
        fill(g, cx - halfW, shoulderY + v * 5, halfW * 2, 1.4, rgba('#000000', 0.3));
      }
    }
    g.restore();
    /* Belt at the hip, which separates torso from legs at any zoom. */
    fill(g, cx - halfW * 0.86, hipY - 1, halfW * 1.72, 3, rgba('#000000', 0.35));

    /* ---- arms ---- */
    var armW = 7.5, shX = halfW - 1;
    if (carry) {
      /* Both arms forward, holding whatever render.js draws in front. */
      limb(g, cx - shX, shoulderY, cx - 7, hipY + 2, armW, body);
      limb(g, cx + shX, shoulderY, cx + 7, hipY + 2, armW, body);
      circle(g, cx - 7, hipY + 3, 3.6, s.skin);
      circle(g, cx + 7, hipY + 3, 3.6, s.skin);
    } else if (side) {
      var ax = dir === 1 ? shX : -shX;
      limb(g, cx + ax, shoulderY, cx + ax - swing * 7, hipY, armW, body);
      circle(g, cx + ax - swing * 7, hipY + 1, 3.4, s.skin);
      limb(g, cx + ax * 0.2, shoulderY + 1, cx + ax * 0.2 + swing * 6, hipY - 1,
        armW - 1, shade(body, -0.2));
    } else {
      limb(g, cx - shX, shoulderY, cx - shX - 1, hipY + swing * 3, armW, body);
      limb(g, cx + shX, shoulderY, cx + shX + 1, hipY - swing * 3, armW, body);
      circle(g, cx - shX - 1, hipY + swing * 3 + 1, 3.4, s.skin);
      circle(g, cx + shX + 1, hipY - swing * 3 + 1, 3.4, s.skin);
    }

    /* ---- head ---- */
    var hr = 10.5;
    var hx = cx + (side ? (dir === 1 ? 2 : -2) : 0);
    circle(g, hx, headY, hr, s.skin);
    g.fillStyle = radGrad(g, hx - 4, headY - 5, 1, hr * 1.5,
      [0, rgba('#ffffff', 0.34), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.3)]);
    g.beginPath(); g.arc(hx, headY, hr, 0, TAU); g.fill();
    /* Neck shadow, so the head sits on the shoulders. */
    ell(g, hx, headY + hr - 1, hr * 0.7, 2.6, 0, rgba('#000000', 0.22));

    if (!s.head) {
      /* Hair: a cap of it, with the hairline where the facing needs it. */
      var hair = s.hair;
      g.save();
      g.beginPath(); g.arc(hx, headY, hr + 0.8, 0, TAU); g.clip();
      if (back) {
        circle(g, hx, headY, hr + 0.6, hair);
        circle(g, hx - 3, headY - 3.5, hr * 0.45, shade(hair, 0.18));
      } else {
        ell(g, hx, headY - hr * 0.5, hr + 0.6, hr * 0.85, 0, hair);
        if (s.style === 0) ell(g, hx, headY - hr * 0.35, hr + 0.6, hr * 0.7, 0, hair);
        if (s.style === 1) {
          /* Long: falls past the jaw on both sides. */
          ell(g, hx - hr * 0.78, headY + 1, hr * 0.42, hr * 0.95, 0, hair);
          ell(g, hx + hr * 0.78, headY + 1, hr * 0.42, hr * 0.95, 0, hair);
        }
        if (s.style === 2) {
          circle(g, hx + hr * 0.5, headY - hr * 0.6, hr * 0.42, shade(hair, 0.12));
        }
        if (s.style === 3) ell(g, hx, headY - hr * 0.72, hr * 0.95, hr * 0.5, 0, hair);
        ell(g, hx - hr * 0.3, headY - hr * 0.66, hr * 0.4, hr * 0.22, -0.3,
          rgba('#ffffff', 0.18));
      }
      g.restore();
    }

    /* Face: readable at half size, which means two dark eyes and a
       mouth and nothing else. */
    if (!back) {
      var ey = headY + 1.6, ex = hr * 0.42;
      if (dir === 2) {
        ell(g, hx - ex, ey, 1.7, 2, 0, P.ink);
        ell(g, hx + ex, ey, 1.7, 2, 0, P.ink);
        ell(g, hx - ex - 0.5, ey - 0.7, 0.7, 0.7, 0, rgba('#ffffff', 0.7));
        ell(g, hx + ex - 0.5, ey - 0.7, 0.7, 0.7, 0, rgba('#ffffff', 0.7));
        stroke(g, [hx - 2.4, headY + 5.6, hx + 2.4, headY + 5.6],
          rgba(shade(s.skin, -0.45), 0.7), 1.2);
        ell(g, hx, headY + 3.4, 1, 1.6, 0, rgba(shade(s.skin, -0.25), 0.5));
      } else {
        var f = dir === 1 ? 1 : -1;
        ell(g, hx + f * ex * 0.9, ey, 1.7, 2, 0, P.ink);
        ell(g, hx + f * ex * 0.4, ey - 0.7, 0.7, 0.7, 0, rgba('#ffffff', 0.6));
        ell(g, hx + f * (hr - 1), headY + 3, 1.6, 1.2, 0, rgba(shade(s.skin, -0.2), 0.6));
        stroke(g, [hx + f * 1, headY + 5.6, hx + f * 4, headY + 5.6],
          rgba(shade(s.skin, -0.45), 0.6), 1.2);
      }
    }

    if (s.head) {
      /* A hat sits over the skull and shades the face under its brim. */
      var hc = s.head;
      circle(g, hx, headY - 1.5, hr + 1.2, hc);
      g.fillStyle = radGrad(g, hx - 4, headY - 7, 1, hr * 1.6,
        [0, rgba('#ffffff', 0.4), 0.5, rgba('#ffffff', 0.04), 1, rgba('#000000', 0.34)]);
      g.beginPath(); g.arc(hx, headY - 1.5, hr + 1.2, 0, TAU); g.fill();
      if (!back) {
        g.beginPath();
        g.ellipse(hx, headY + 4, hr + 2.5, 3.4, 0, Math.PI, TAU);
        g.fillStyle = shade(hc, -0.3); g.fill();
        ell(g, hx, headY + 3, hr * 0.9, 1.6, 0, rgba('#000000', 0.3));
      }
      ring(g, hx, headY - 1.5, hr + 1.2, 1.2, rgba('#000000', 0.35));
    }
  }

  /* The drafted marker: a gold chevron under the boots. Drawn last so
     nothing covers it, and kept off the figure itself so it does not
     read as a piece of apparel. */
  function draftMark(g) {
    var cx = 32, y = 60;
    g.beginPath();
    g.moveTo(cx - 9, y - 4);
    g.lineTo(cx, y + 2);
    g.lineTo(cx + 9, y - 4);
    g.strokeStyle = rgba('#000000', 0.5); g.lineWidth = 4.5;
    g.lineJoin = 'round'; g.lineCap = 'round';
    g.stroke();
    g.strokeStyle = P.gold; g.lineWidth = 2.6;
    g.stroke();
    g.lineCap = 'butt';
    circle(g, cx, y - 7, 1.6, P.gold);
  }

  /* Animal silhouettes. Every one is painted facing north and then
     rotated, because a quadruped seen from above is the same animal
     from every side - only humans need a distinct face and back. */
  var ANIMAL = {
    hare:    { size: 0.8,  body: '#b08c5a', belly: '#e6ddc8', ear: 11, tail: 4, snout: 4,
               lean: 0.55, legW: 0.075 },
    deer:    { size: 1.35, body: '#8a6134', belly: '#d8cfc0', ear: 6, tail: 5, snout: 7,
               lean: 0.5, legW: 0.06, antler: true },
    muffalo: { size: 1.9,  body: '#4a3b2c', belly: '#6b5638', ear: 4, tail: 8, snout: 8,
               lean: 0.78, legW: 0.1, horn: true, shag: true },
    boomrat: { size: 0.75, body: '#a3503a', belly: '#e0803c', ear: 6, tail: 16, snout: 6,
               lean: 0.6, legW: 0.07 },
    wolf:    { size: 1.15, body: '#6e6e78', belly: '#b0b0b8', ear: 8, tail: 14, snout: 8,
               lean: 0.56, legW: 0.07 },
    bear:    { size: 1.6,  body: '#4a3524', belly: '#6b4f33', ear: 5, tail: 3, snout: 7,
               lean: 0.82, legW: 0.11 }
  };

  function paintAnimal(g, rnd, a, S, frame, dead) {
    var body = dead ? drained(a.body) : a.body;
    var belly = dead ? drained(a.belly) : a.belly;
    var dk = shade(body, -0.38);
    var cx = S / 2;
    var rx = S * 0.13 * (a.lean + 0.5) * 1.4, ry = S * 0.24;
    var bodyY = S * 0.56;
    var headY = S * 0.2, hr = S * 0.115;
    var swing = Math.sin((frame & 3) * Math.PI / 2);
    var legW = Math.max(2.5, S * a.legW), legL = S * 0.2;

    /* Legs first: front pair and back pair on opposite phases. */
    var pairs = [[bodyY - ry * 0.55, swing], [bodyY + ry * 0.55, -swing]];
    for (var p = 0; p < 2; p++) {
      var ly = pairs[p][0], sw = pairs[p][1] * legL * 0.33;
      for (var side2 = -1; side2 <= 1; side2 += 2) {
        var lx = cx + side2 * rx * 0.82;
        limb(g, lx, ly, lx + side2 * legW * 0.3, ly + (p ? 1 : -1) * legL + sw,
          legW, side2 < 0 ? shade(body, -0.18) : shade(body, -0.28));
        ell(g, lx + side2 * legW * 0.3, ly + (p ? 1 : -1) * legL + sw,
          legW * 0.55, legW * 0.42, 0, dk);
      }
    }

    if (a.tail) {
      var tl = S * a.tail * 0.012;
      whip(g, cx, bodyY + ry * 0.85, cx + swing * tl * 0.4, bodyY + ry + tl * 0.5,
        cx + swing * tl * 0.8, bodyY + ry + tl, body, Math.max(2, legW * 0.8));
      circle(g, cx + swing * tl * 0.8, bodyY + ry + tl, Math.max(1.6, legW * 0.42), belly);
    }

    /* Barrel of the body, with the belly catching bounce light and the
       spine catching the sun. */
    ell(g, cx, bodyY, rx, ry, 0, body);
    g.save();
    g.beginPath(); g.ellipse(cx, bodyY, rx, ry, 0, 0, TAU); g.clip();
    g.fillStyle = radGrad(g, cx - rx * 0.4, bodyY - ry * 0.45, 1, rx * 2,
      [0, rgba('#ffffff', 0.26), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.3)]);
    g.fillRect(cx - rx, bodyY - ry, rx * 2, ry * 2);
    ell(g, cx, bodyY + ry * 0.45, rx * 0.72, ry * 0.4, 0, rgba(belly, 0.5));
    if (a.shag) {
      /* Shag: a coat of overlapping tufts, which is the whole read on a
         muffalo at any zoom. */
      for (var t = 0; t < 46; t++) {
        var tx = cx + rs(rnd, rx), ty = bodyY + rs(rnd, ry);
        whip(g, tx, ty, tx + rs(rnd, 3), ty + 3, tx + rs(rnd, 5), ty + 6,
          rgba(rnd() < 0.5 ? shade(body, 0.2) : shade(body, -0.25), 0.5),
          rr(rnd, 1.4, 3));
      }
    } else {
      for (var f = 0; f < 20; f++) {
        var fx = cx + rs(rnd, rx), fy = bodyY + rs(rnd, ry);
        whip(g, fx, fy, fx + rs(rnd, 2), fy + 2.4, fx + rs(rnd, 3), fy + 4.4,
          rgba(shade(body, rnd() < 0.5 ? 0.16 : -0.2), 0.3), 1.2);
      }
    }
    g.restore();
    /* Haunches and shoulders: two bulges that give the barrel its
       quadruped shape. */
    ell(g, cx - rx * 0.62, bodyY + ry * 0.4, rx * 0.5, ry * 0.36, 0.3, rgba(shade(body, 0.1), 0.6));
    ell(g, cx + rx * 0.62, bodyY + ry * 0.4, rx * 0.5, ry * 0.36, -0.3, rgba(shade(body, 0.1), 0.6));
    stroke(g, [cx, bodyY - ry * 0.8, cx, bodyY + ry * 0.8], rgba('#ffffff', 0.12), rx * 0.3);

    /* Neck, then the head. */
    limb(g, cx, bodyY - ry * 0.7, cx, headY + hr * 0.5, hr * 1.1, body);
    ell(g, cx, headY, hr, hr * 1.05, 0, body);
    g.save();
    g.beginPath(); g.ellipse(cx, headY, hr, hr * 1.05, 0, 0, TAU); g.clip();
    g.fillStyle = radGrad(g, cx - hr * 0.4, headY - hr * 0.5, 1, hr * 2,
      [0, rgba('#ffffff', 0.26), 0.5, rgba('#ffffff', 0), 1, rgba('#000000', 0.26)]);
    g.fillRect(cx - hr, headY - hr * 1.1, hr * 2, hr * 2.2);
    g.restore();

    /* Muzzle pushed out past the skull. */
    var sn = S * a.snout * 0.012;
    ell(g, cx, headY - hr * 0.6 - sn * 0.5, hr * 0.5, sn * 0.75, 0, belly);
    ell(g, cx, headY - hr * 0.6 - sn, hr * 0.28, hr * 0.2, 0, dk);

    if (a.ear) {
      var el2 = S * a.ear * 0.012;
      for (var s2 = -1; s2 <= 1; s2 += 2) {
        var ex = cx + s2 * hr * 0.72;
        ell(g, ex, headY - hr * 0.5 - el2 * 0.4, hr * 0.3, el2 * 0.55, s2 * 0.35, body);
        ell(g, ex, headY - hr * 0.5 - el2 * 0.4, hr * 0.16, el2 * 0.36, s2 * 0.35,
          rgba(belly, 0.7));
      }
    }
    if (a.horn) {
      for (var s3 = -1; s3 <= 1; s3 += 2) {
        g.beginPath();
        g.moveTo(cx + s3 * hr * 0.8, headY - hr * 0.2);
        g.quadraticCurveTo(cx + s3 * hr * 2.1, headY - hr * 0.9,
          cx + s3 * hr * 1.9, headY - hr * 1.9);
        g.strokeStyle = P.bone; g.lineWidth = Math.max(2.5, hr * 0.32);
        g.lineCap = 'round'; g.stroke();
        g.strokeStyle = rgba('#ffffff', 0.3); g.lineWidth = Math.max(1, hr * 0.12);
        g.stroke();
        g.lineCap = 'butt';
      }
    }
    if (a.antler) {
      for (var s4 = -1; s4 <= 1; s4 += 2) {
        var bx = cx + s4 * hr * 0.5, by = headY - hr * 0.7;
        stroke(g, [bx, by, bx + s4 * hr * 1.1, by - hr * 1.8], P.bone, Math.max(1.6, hr * 0.2));
        stroke(g, [bx + s4 * hr * 0.55, by - hr * 0.9, bx + s4 * hr * 1.7, by - hr * 1.1],
          P.bone, Math.max(1.2, hr * 0.15));
        stroke(g, [bx + s4 * hr * 1.1, by - hr * 1.8, bx + s4 * hr * 1.8, by - hr * 2.4],
          P.bone, Math.max(1.2, hr * 0.15));
      }
    }
    if (!dead) {
      for (var s5 = -1; s5 <= 1; s5 += 2) {
        ell(g, cx + s5 * hr * 0.48, headY - hr * 0.15, hr * 0.17, hr * 0.2, 0, P.ink);
        ell(g, cx + s5 * hr * 0.48 - hr * 0.06, headY - hr * 0.22, hr * 0.07, hr * 0.07, 0,
          rgba('#ffffff', 0.8));
      }
    } else {
      for (var s6 = -1; s6 <= 1; s6 += 2) {
        stroke(g, [cx + s6 * hr * 0.7, headY - hr * 0.3, cx + s6 * hr * 0.26, headY],
          rgba(P.ink, 0.7), Math.max(1, hr * 0.14));
      }
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

     These stay flat pixel art. A panel chip is twenty pixels across and
     wants hard edges, not a downscaled illustration - so the painters
     below are authored in a 16-unit space and stamped into a 32-pixel
     canvas at exactly 2x, which lands every fillRect on whole device
     pixels and keeps them crisp.
     ------------------------------------------------------------------ */

  function pflame(g, cx, cy, frame, size) {
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
    gear: function (g, c) { pdisc(g, 8, 8, 5, c); pdisc(g, 8, 8, 2, shade(c, -0.6)); for (var i = 0; i < 4; i++) { var a = i * 1.5707963267948966; fill(g, (8 + Math.cos(a) * 6) | 0, (8 + Math.sin(a) * 6) | 0, 2, 2, c); } },
    pick: function (g, c) { line(g, 2, 4, 13, 7, c, 1); line(g, 2, 5, 13, 8, shade(c, -0.25), 1); line(g, 7, 6, 11, 14, P.woodFloor, 2); },
    axe: function (g, c) { line(g, 4, 14, 11, 3, P.woodFloor, 2); fill(g, 9, 1, 5, 5, c); fill(g, 8, 2, 2, 3, shade(c, 0.25)); },
    sickle: function (g, c) { for (var y = 2; y < 9; y++) fill(g, 3 + ((y - 2) * (y - 2) >> 2), y, 2, 1, c); line(g, 4, 9, 8, 14, P.woodFloor, 2); },
    scissors: function (g, c) { line(g, 3, 2, 11, 11, c, 1); line(g, 12, 2, 4, 11, c, 1); pdisc(g, 4, 13, 2, shade(c, -0.2)); pdisc(g, 11, 13, 2, shade(c, -0.2)); },
    hammer: function (g, c) { fill(g, 3, 2, 9, 4, c); fill(g, 3, 2, 9, 1, shade(c, 0.25)); line(g, 8, 6, 8, 14, P.woodFloor, 2); },
    upArrow: function (g, c) { for (var i = 0; i < 6; i++) fill(g, 8 - i, 2 + i, 1 + i * 2, 1, c); fill(g, 6, 8, 5, 7, c); },
    crosshair: function (g, c) { box(g, 3, 3, 10, 10, c); fill(g, 7, 0, 2, 5, c); fill(g, 7, 11, 2, 5, c); fill(g, 0, 7, 5, 2, c); fill(g, 11, 7, 5, 2, c); dot(g, 7, 7, c); },
    heart: function (g, c) { pdisc(g, 5, 6, 3, c); pdisc(g, 11, 6, 3, c); for (var i = 0; i < 7; i++) fill(g, 2 + i, 8 + i, 13 - i * 2, 1, c); },
    knifeIcon: function (g, c) { line(g, 3, 12, 11, 3, c, 2); line(g, 4, 13, 7, 10, P.woodFloor, 2); dot(g, 12, 2, shade(c, 0.35)); },
    xMark: function (g, c) { line(g, 3, 3, 12, 12, c, 2); line(g, 12, 3, 3, 12, c, 2); },
    flame: function (g, c) { pflame(g, 8, 14, 0, 8); },
    cross: function (g, c) { fill(g, 6, 2, 4, 12, c); fill(g, 2, 6, 12, 4, c); },
    bed: function (g, c) { fill(g, 1, 5, 14, 7, c); fill(g, 2, 6, 4, 4, P.paper); fill(g, 7, 6, 7, 4, shade(c, -0.25)); fill(g, 1, 12, 2, 3, shade(c, -0.4)); fill(g, 13, 12, 2, 3, shade(c, -0.4)); },
    key: function (g, c) { pdisc(g, 4, 6, 3, c); pdisc(g, 4, 6, 1, shade(c, -0.7)); line(g, 6, 8, 13, 14, c, 2); fill(g, 11, 9, 3, 2, c); },
    paw: function (g, c) { pdisc(g, 8, 11, 4, c); pdisc(g, 4, 6, 2, c); pdisc(g, 7, 4, 2, c); pdisc(g, 11, 5, 2, c); pdisc(g, 13, 9, 2, c); },
    pot: function (g, c) { fill(g, 3, 6, 10, 7, c); fill(g, 2, 5, 12, 2, shade(c, 0.2)); fill(g, 0, 6, 2, 2, c); fill(g, 14, 6, 2, 2, c); fill(g, 6, 2, 1, 3, shade(c, 0.4)); fill(g, 9, 1, 1, 4, shade(c, 0.4)); },
    sprout: function (g, c) { fill(g, 7, 7, 2, 8, shade(c, -0.25)); pellipse(g, 4, 6, 3, 2, c); pellipse(g, 12, 5, 3, 2, shade(c, 0.2)); pellipse(g, 8, 3, 2, 2, c); },
    boxIcon: function (g, c) { fill(g, 2, 4, 12, 10, c); box(g, 2, 4, 12, 10, shade(c, -0.45)); fill(g, 2, 8, 12, 1, shade(c, -0.45)); fill(g, 7, 4, 2, 10, shade(c, -0.3)); },
    broom: function (g, c) { line(g, 4, 14, 11, 4, P.woodFloor, 2); fill(g, 2, 12, 7, 4, c); for (var i = 0; i < 7; i += 2) fill(g, 2 + i, 12, 1, 4, shade(c, -0.3)); },
    flask: function (g, c) { fill(g, 6, 1, 4, 5, shade(c, 0.3)); for (var i = 0; i < 7; i++) fill(g, 6 - i, 6 + i, 4 + i * 2, 1, i > 3 ? c : shade(c, 0.3)); fill(g, 2, 13, 12, 2, c); },
    apple: function (g, c) { pdisc(g, 8, 10, 5, c); fill(g, 7, 3, 2, 3, shade(P.grass, -0.2)); pellipse(g, 11, 4, 2, 1, P.grass); dot(g, 6, 8, shade(c, 0.4)); },
    moon: function (g, c) { pdisc(g, 8, 8, 7, c); g.globalCompositeOperation = 'destination-out'; pdisc(g, 13, 5, 6, '#000'); g.globalCompositeOperation = 'source-over'; },
    sun: function (g, c) { pdisc(g, 8, 8, 4, c); for (var i = 0; i < 8; i++) { var a = i * 0.7853981633974483; fill(g, (8 + Math.cos(a) * 6.5) | 0, (8 + Math.sin(a) * 6.5) | 0, 2, 2, c); } },
    person: function (g, c) { pdisc(g, 8, 4, 3, c); fill(g, 5, 8, 6, 7, c); fill(g, 3, 8, 2, 5, c); fill(g, 11, 8, 2, 5, c); },
    clock: function (g, c) { pdisc(g, 8, 8, 7, shade(c, -0.5)); pdisc(g, 8, 8, 6, c); fill(g, 7, 4, 2, 5, shade(c, -0.6)); fill(g, 8, 8, 4, 2, shade(c, -0.6)); },
    list: function (g, c) { for (var i = 0; i < 3; i++) { fill(g, 2, 3 + i * 4, 2, 2, c); fill(g, 6, 3 + i * 4, 8, 2, shade(c, -0.15)); } },
    star: function (g, c) { fill(g, 7, 1, 2, 14, c); fill(g, 1, 7, 14, 2, c); line(g, 3, 3, 13, 13, c, 1); line(g, 13, 3, 3, 13, c, 1); pdisc(g, 8, 8, 3, shade(c, 0.3)); },
    thermo: function (g, c) { fill(g, 6, 1, 4, 10, P.paper); pdisc(g, 8, 12, 3, c); fill(g, 7, 4, 2, 8, c); box(g, 6, 1, 4, 11, shade(P.ink, 0.3)); },
    envelope: function (g, c) { fill(g, 1, 4, 14, 9, c); box(g, 1, 4, 14, 9, shade(c, -0.45)); line(g, 1, 4, 8, 9, shade(c, -0.3), 1); line(g, 14, 4, 8, 9, shade(c, -0.3), 1); },
    skull: function (g, c) { pdisc(g, 8, 7, 5, c); fill(g, 5, 11, 6, 3, c); dot(g, 6, 7, P.ink); dot(g, 10, 7, P.ink); fill(g, 6, 6, 2, 2, P.ink); fill(g, 9, 6, 2, 2, P.ink); fill(g, 7, 11, 1, 3, shade(c, -0.4)); fill(g, 9, 11, 1, 3, shade(c, -0.4)); },
    bang: function (g, c) { for (var i = 0; i < 7; i++) fill(g, 8 - i, 3 + i * 2, 1 + i * 2, 2, c); fill(g, 7, 6, 2, 5, P.ink); fill(g, 7, 12, 2, 2, P.ink); }
  };

  /* Six mouth pixels, y offsets per mood. Screen y grows downward, so a
     frown sits low at the corners and a grin sits low in the middle. */
  var MOUTH = [[3, 2, 1, 1, 2, 3], [2, 1, 1, 1, 1, 2], [1, 1, 1, 1, 1, 1],
               [0, 1, 2, 2, 1, 0], [0, 1, 3, 3, 1, 0]];

  function paintFace(g, level) {
    var c = ['#c0392b', '#d07a2a', P.gold, '#8fbb62', '#5fae4a'][level];
    pdisc(g, 8, 8, 7, shade(c, -0.35));
    pdisc(g, 8, 8, 6, c);
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

  var Art = { PX: PX, ICON_PX: ICON_PX, PALETTE: P, FACTION: FACTION };

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

  /* Integer mixing, so scrolling over new ground allocates nothing. */
  function cellHash(x, y) {
    var h = (x * 374761393 + y * 668265263) | 0;
    return Math.imul(h ^ (h >>> 13), 1274126177);
  }

  Art.terrainVariant = function (x, y) { return (cellHash(x, y) >>> 15) & 3; };

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

  function isLinkOf(map, x, y, defId) {
    if (!map.inBounds(x, y)) return false;
    var b = map.buildingAt(x, y);
    return !!(b && b.defId === defId);
  }

  /* The same join logic for anything that links to its own kind, which
     in practice means power conduits. */
  Art.linkVariant = function (map, x, y, defId) {
    if (!map || !map.inBounds) return 0;
    return (isLinkOf(map, x, y - 1, defId) ? 1 : 0) |
           (isLinkOf(map, x + 1, y, defId) ? 2 : 0) |
           (isLinkOf(map, x, y + 1, defId) ? 4 : 0) |
           (isLinkOf(map, x - 1, y, defId) ? 8 : 0);
  };

  var LINKED = { wall: 1, rockWall: 1, oreWall: 1, door: 1, conduit: 1 };

  function cellBuildingId(map, x, y) {
    return map.inBounds(x, y) ? map.buildingId[map.idx(x, y)] : -1;
  }

  /* A join mask is a pure function of which building ids sit in the four
     orthogonal cells, and an id never changes what it points at. Those
     four ids are one typed-array read each, against four registry
     lookups to rebuild the mask, so a wall whose neighbours have not
     changed since last frame keeps the mask it already had. On a screen
     full of mountain that is the difference between sixteen thousand
     hash lookups a frame and none. */
  var maskMemo = new WeakMap();

  function variantOf(def, thing) {
    if (!LINKED[def.sprite] || !thing) return 0;
    if (typeof thing.wallVariant === 'number') return thing.wallVariant & 15;
    var map = thing.map || (root.Game && root.Game.map);
    if (!map || !map.inBounds || !map.buildingId || thing.x === undefined) return 0;
    var x = thing.x, y = thing.y;
    var n0 = cellBuildingId(map, x, y - 1), n1 = cellBuildingId(map, x + 1, y);
    var n2 = cellBuildingId(map, x, y + 1), n3 = cellBuildingId(map, x - 1, y);
    var m = maskMemo.get(thing);
    if (m && m.map === map && m.n0 === n0 && m.n1 === n1 && m.n2 === n2 && m.n3 === n3) {
      return m.mask;
    }
    var mask = def.sprite === 'conduit'
      ? Art.linkVariant(map, x, y, def.id)
      : Art.wallVariant(map, x, y);
    if (m) {
      m.map = map; m.n0 = n0; m.n1 = n1; m.n2 = n2; m.n3 = n3; m.mask = mask;
    } else {
      maskMemo.set(thing, { map: map, n0: n0, n1: n1, n2: n2, n3: n3, mask: mask });
    }
    return mask;
  }

  function stuffOf(def, thing) {
    if (!def.stuffable || !thing) return null;
    var sid = thing.stuffId || thing.stuff;
    return (sid && Defs.has('thing', sid)) ? sid : null;
  }

  function needsPower(def) {
    var b = def.building;
    return !!(b && (b.powerConsumed > 0 || b.powerProduced > 0 || b.isLamp));
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
    return !VARIES[def.sprite] && !def.rotatable && !def.stuffable &&
      def.category !== 'plant' && !needsPower(def);
  }

  function plantStage(thing) {
    var g = thing && typeof thing.growth === 'number' ? thing.growth : 1;
    return g < 0.32 ? 0 : (g < 0.85 ? 1 : 2);
  }

  function paintPlant(g, rnd, def, stage, variant, ripe) {
    switch (def.sprite) {
      case 'grass': paintGrassPlant(g, rnd, def, stage, variant); break;
      case 'bush': paintBush(g, rnd, def, stage, ripe); break;
      case 'tree': paintTree(g, rnd, def, stage); break;
      default: paintCrop(g, rnd, def, stage);
    }
  }

  function plantSprite(def, thing) {
    var stage = plantStage(thing);
    var pl = def.plant || {};
    var ripe = stage === 2 && !!pl.harvestedThing;
    var tree = !!pl.isTree;
    /* A tuft of grass differs from its neighbour; a tree does not need
       to, because at 2x2 the silhouette already carries the variety. */
    var variant = tree ? 0 : (thing && thing.id ? thing.id : 0) % 3;
    var blighted = !!(thing && thing.blighted);
    var key = 'pl|' + def.id + '|' + stage + '|' + variant + (ripe ? 'r' : '') +
      (blighted ? 'b' : '');
    var size = tree ? PX * 2 : PX;
    return cached(key, size, size, function (g, rnd) {
      paintPlant(g, rnd, def, stage, variant, ripe);
      if (blighted) {
        g.globalCompositeOperation = 'source-atop';
        g.globalAlpha = 0.55;
        fill(g, 0, 0, size, size, '#6b6046');
        g.globalAlpha = 1;
        g.globalCompositeOperation = 'source-over';
      }
    }, tree ? -PX / 2 : 0, tree ? -PX / 2 : 0);
  }

  /* Everything a variable sprite can vary along is a small number, so
     they pack into one integer and a per-def table answers the lookup
     without building a string. That matters because drawing one frame of
     a mountain colony asks for a few thousand walls, and a key string
     per wall per frame is garbage the player feels as a stutter. The
     string key is still built, but only when the variant is new. */
  var varCache = new Map();

  function stuffCode(stuffId) {
    return stuffId ? Defs.index('thing', stuffId) + 1 : 0;
  }

  Art.thing = function (def, thing) {
    var plain = plainCache.get(def);
    if (plain) return plain;
    if (def.category === 'plant') return plantSprite(def, thing);

    var sw = (def.size && def.size.w) || 1, sh = (def.size && def.size.h) || 1;
    var rot = (def.rotatable && thing) ? ((thing.rot | 0) & 3) : 0;
    var mask = variantOf(def, thing);
    var stuffId = stuffOf(def, thing);
    var open = !!(def.building && def.building.isDoor && thing && thing.open);
    var lit = !needsPower(def) || !thing || thing.powered !== false;
    var frame = def.sprite === 'fire' || def.sprite === 'campfire'
      ? ((((root.Game && root.Game.tick) || 0) >> 3) + (thing && thing.id ? thing.id : 0)) % 6 : 0;
    /* Filth picks one of six splat shapes from its id; natural rock
       picks one of two faces from where it sits, so a mined-out mountain
       is not the same tile twenty times in a row. */
    var noise = 0;
    if (def.sprite === 'filth') noise = (thing && thing.id ? thing.id : 0) % 6;
    else if (def.natural && thing && thing.x !== undefined) {
      noise = (cellHash(thing.x, thing.y) >>> 19) & 1;
    }
    var kindId = (def.sprite === 'corpse' && thing && thing.corpse && thing.corpse.kindId) || null;

    /* Blueprints and frames wear the footprint of what they will become,
       so a half-built 3x3 solar panel occupies the right nine tiles. */
    var target = thing && thing.buildDefId && Defs.maybe('thing', thing.buildDefId);
    if (target) {
      sw = (target.size && target.size.w) || 1;
      sh = (target.size && target.size.h) || 1;
      rot = target.rotatable ? ((thing.rot | 0) & 3) : 0;
    }

    /* A ghost and a corpse carry a whole def id in their identity, which
       does not fit an integer; both are rare enough to keep paying for
       the string. */
    var row = null, code = 0;
    if (!target && !kindId) {
      code = mask | (rot << 4) | (open ? 64 : 0) | (lit ? 128 : 0) |
        (frame << 8) | (noise << 11) | (stuffCode(stuffId) << 14);
      row = varCache.get(def);
      if (!row) varCache.set(def, (row = new Map()));
      var hit = row.get(code);
      if (hit) return hit;
    }

    var key = 'th|' + def.id + '|' + sw + 'x' + sh + '|' + mask + '|' + (stuffId || '-') +
      '|' + (open ? 'o' : 'c') + (lit ? 'L' : 'd') + '|' + frame + '|' + noise +
      (kindId ? '|' + kindId : '');

    var base = cached(key, sw * PX, sh * PX, function (g, rnd) {
      var c1 = stuffId ? Defs.thing(stuffId).color : def.color;
      var a = {
        def: def, rnd: rnd, variant: mask, open: open, lit: lit,
        frame: frame, noise: noise, kindId: kindId, stuffId: stuffId,
        material: materialKind(stuffId) || materialKind(defaultStuff(def)) || 'stone',
        w: sw * PX, h: sh * PX,
        c1: c1, c2: def.color2 || shade(c1, -0.25)
      };
      (SPRITE[def.sprite] || SPRITE.item)(g, a);
    });

    var out = rot ? cachedRotation(base, rot) : base;
    if (row) row.set(code, out);
    if (isPlain(def) && !target) plainCache.set(def, out);
    return out;
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
     rotation and material the player currently has selected.

     Dragging a wall asks for this once per cell under the drag, several
     hundred times a frame, so the stand-in thing is one reused object
     rather than a fresh one per cell. Art.thing never keeps a reference
     to it: only the canvas it returns is cached. */
  var ghostStand = { rot: 0, stuffId: null, wallVariant: 0, x: 0, y: 0 };

  Art.ghost = function (defId, rot, stuffId) {
    var floor = Defs.maybe('terrain', defId);
    if (floor) return Art.terrain(floor, 0);
    var def = Defs.maybe('thing', defId);
    if (!def) return Art.icon('cat-misc');
    ghostStand.rot = rot | 0;
    ghostStand.stuffId = stuffId || null;
    return Art.thing(def, ghostStand);
  };

  /* ---------- pawns ----------
     Humans are the one part of the cache that is genuinely unbounded:
     every raid can arrive wearing a colour combination nobody has worn
     before. So human sprites are held in a bounded queue and the oldest
     fall out, which costs a repaint if that pawn comes back and keeps
     the cache flat for a colony that runs for a hundred days. */
  var humanKeys = [];
  var HUMAN_CACHE_MAX = 1024;

  function noteHuman(key) {
    humanKeys.push(key);
    while (humanKeys.length > HUMAN_CACHE_MAX) cache.delete(humanKeys.shift());
  }

  Art.pawn = function (pawn, dir, frame) {
    dir = (dir | 0) & 3;
    frame = (frame | 0) & 3;
    var dead = !!pawn.dead, down = !dead && !!(pawn.downed || (pawn.health && pawn.health.downed));
    var pose = dead ? 'dead' : (down ? 'down' : (pawn.carried ? 'carry' : 'up'));
    var lying = pose === 'down' || pose === 'dead';

    if (pawn.isAnimal || (pawn.kind && pawn.kind.isAnimal)) {
      var kid = pawn.kindId || 'hare';
      var a = ANIMAL[kid] || ANIMAL.hare;
      var kind = pawn.kind;
      var ds = (kind && kind.drawSize) || a.size;
      if (ds && ds.length) ds = ds[0];
      var S = Math.max(24, Math.round(ds * PX / 2) * 2);
      var spec = {
        body: (kind && kind.color) || a.body, belly: (kind && kind.color2) || a.belly,
        ear: a.ear, tail: a.tail, snout: a.snout, horn: a.horn, antler: a.antler,
        shag: a.shag, lean: a.lean, legW: a.legW
      };
      var af = lying ? 0 : frame;
      var akey = 'an|' + kid + '|' + S + '|' + af + '|' + (lying ? 'x' : 'u');
      var north = cached(akey, S, S, function (g, rnd) {
        paintAnimal(g, rnd, spec, S, af, lying);
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
    /* A lying pawn has no facing and no gait, so those drop out of the
       key: one sprite covers all sixteen combinations. A pawn with its
       arms full keeps a two-beat walk rather than a four-beat one,
       which halves that pose's share of the cache and reads the same,
       because the arms it would swing are busy. */
    var hdir = lying ? 0 : dir;
    var hframe = lying ? 0 : (pose === 'carry' ? (frame & 1) * 2 : frame);
    var hkey = 'hu|' + s.skin + s.hair + s.style + s.build + '|' + s.top + '|' +
      (s.over || '-') + '|' + (s.vest || '-') + '|' + s.leg + '|' + (s.head || '-') +
      '|' + hdir + hframe + pose + (pawn.drafted && !lying ? 'D' : '');
    var have = cache.get(hkey);
    if (have) return have;

    /* West is the mirror of east, which keeps the two side views
       identical instead of almost-identical. */
    if (hdir === 3 && !lying) {
      var east = Art.pawn(pawn, 1, frame);
      var m = mirrored(east);
      m.key = hkey; m.ox = 0; m.oy = 0;
      cache.set(hkey, m);
      noteHuman(hkey);
      return m;
    }
    var made = cached(hkey, PX, PX, function (g) {
      paintHuman(g, s, hdir, hframe, pose);
      if (pawn.drafted && !lying) draftMark(g);
    });
    noteHuman(hkey);
    return made;
  };

  /* ---------- UI icons ---------- */

  var iconTmp = null, iconEdge = null;

  function cachedIcon(key, paint) {
    var c = cache.get(key);
    if (c) return c;
    var k = ICON_PX / 16;
    if (!iconTmp) { iconTmp = makeCanvas(ICON_PX, ICON_PX); iconEdge = makeCanvas(ICON_PX, ICON_PX); }
    var tg = iconTmp.getContext('2d');
    smooth(tg, false);
    tg.clearRect(0, 0, ICON_PX, ICON_PX);
    tg.save();
    tg.scale(k, k);
    paint(tg);
    tg.restore();
    /* A one-pixel dark edge, stamped from the icon's own silhouette, so
       a gold chip still reads against a pale panel. */
    var eg = iconEdge.getContext('2d');
    smooth(eg, false);
    eg.clearRect(0, 0, ICON_PX, ICON_PX);
    eg.globalCompositeOperation = 'source-over';
    eg.drawImage(iconTmp, 0, 0);
    eg.globalCompositeOperation = 'source-in';
    eg.fillStyle = rgba(P.ink, 0.75);
    eg.fillRect(0, 0, ICON_PX, ICON_PX);
    eg.globalCompositeOperation = 'source-over';

    c = makeCanvas(ICON_PX, ICON_PX);
    c.key = key; c.ox = 0; c.oy = 0;
    var g = c.getContext('2d');
    smooth(g, false);
    var off = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (var i = 0; i < 4; i++) g.drawImage(iconEdge, off[i][0], off[i][1]);
    g.drawImage(iconTmp, 0, 0);
    cache.set(key, c);
    return c;
  }

  Art.icon = function (key) {
    key = String(key);
    var ck = 'ic|' + key;
    var hit = cache.get(ck);
    if (hit) return hit;
    if (/^mood-[0-4]$/.test(key)) {
      var lvl = parseInt(key.slice(5), 10);
      return cachedIcon(ck, function (g) { paintFace(g, lvl); });
    }
    var spec = ICON_MAP[key];
    if (spec) {
      return cachedIcon(ck, function (g) { ICON[spec[0]](g, spec[1]); });
    }
    /* An unmapped key still has to draw something honest: its first two
       characters on a paper chip, which is legible and obviously a
       fallback rather than pretending to be an icon. */
    return cachedIcon(ck, function (g) {
      fill(g, 1, 1, 14, 14, P.paper);
      box(g, 1, 1, 14, 14, shade(P.ink, 0.3));
      g.save(); g.translate(3, 5);
      paintText(g, key.slice(0, 2).toUpperCase(), P.ink);
      g.restore();
    });
  };

  /* ---------- effects ----------
     Every effect canvas is square and carries cx/cy, the centre of the
     effect inside it, plus the usual ox/oy for callers that draw from a
     tile's top-left corner. Frame counts, in order: fire 6, smoke 4,
     explosion 6, blood 6, muzzle 3, spark 4, dust 4, splash 4, snow 4,
     rain 3. */
  var EFFECT_FRAMES = {
    fire: 6, smoke: 4, explosion: 6, blood: 6, muzzle: 3,
    spark: 4, dust: 4, splash: 4, snow: 4, rain: 3
  };

  function centred(c, cx, cy) { c.cx = cx; c.cy = cy; return c; }

  Art.effectFrames = function (key) { return EFFECT_FRAMES[key] || 1; };

  /* Callers animate from a wall clock, so the frame number that arrives
     here climbs for as long as the page is open. Folding it into range
     before it reaches a cache key is what stops the cache growing by one
     canvas every tenth of a second for as long as something is on fire. */
  Art.effect = function (key, frame) {
    frame = frame | 0;
    if (key === 'bullet' || key === 'arrow') return Art.thing(Defs.thing(key), null);
    var n = EFFECT_FRAMES[key];
    if (!n) return Art.icon(key);
    frame = ((frame % n) + n) % n;
    var ck = 'fx|' + key + '|' + frame;
    var hit = cache.get(ck);
    if (hit) return hit;

    switch (key) {
      case 'fire':
        return centred(cached(ck, PX, PX, function (g) {
          glow(g, PX / 2, PX - 14, 26, P.flame, 0.85);
          flameIllus(g, PX / 2, PX - 6, frame, 40, 1);
        }), PX / 2, PX - 10);
      case 'smoke':
        return centred(cached(ck, PX, PX, function (g, rnd) {
          paintSmoke(g, rnd, 9 + frame * 7, mix(P.smoke, '#b8b8bc', frame / 3));
        }), PX / 2, PX / 2);
      case 'explosion':
        return centred(cached(ck, PX * 3, PX * 3, function (g, rnd) {
          paintExplosion(g, rnd, frame);
        }, -PX, -PX), PX * 1.5, PX * 1.5);
      case 'blood':
        return centred(cached(ck, PX, PX, function (g, rnd) {
          bloodSplat(g, rnd, P.blood, shade(P.blood, -0.35), PX, PX);
        }), PX / 2, PX / 2);
      case 'muzzle':
        return centred(cached(ck, PX, PX, function (g, rnd) {
          paintMuzzle(g, rnd, frame);
        }), PX / 2, PX * 0.72);
      case 'spark':
        return centred(cached(ck, PX, PX, function (g, rnd) {
          paintSpark(g, rnd, frame);
        }), PX / 2, PX / 2);
      case 'dust':
        return centred(cached(ck, PX, PX, function (g, rnd) {
          paintDust(g, rnd, frame);
        }), PX / 2, PX / 2);
      case 'splash':
        return centred(cached(ck, PX, PX, function (g, rnd) {
          paintSplash(g, rnd, frame);
        }), PX / 2, PX / 2);
      case 'snow':
        return centred(cached(ck, PX / 2, PX / 2, function (g, rnd) {
          paintSnow(g, rnd, frame);
        }, PX / 4, PX / 4), PX / 4, PX / 4);
      default:
        return centred(cached(ck, PX / 2, PX / 2, function (g, rnd) {
          paintRain(g, rnd, frame);
        }, PX / 4, PX / 4), PX / 4, PX / 4);
    }
  };

  /* The soft contact shadow render.js drops under a pawn or a tree.
     Sizes are quantised so a hundred pawns of slightly different body
     size share a handful of canvases. */
  Art.shadow = function (size) {
    var s = U.clamp(Math.round((size || PX) / 8) * 8, 16, 256);
    var ck = 'sh|' + s;
    var hit = cache.get(ck);
    if (hit) return hit;
    return centred(cached(ck, s, s, function (g) {
      blobEll(g, s / 2, s / 2, s * 0.46, s * 0.24, '#000000', 0.42, 0.18);
    }, (PX - s) / 2, (PX - s) / 2), s / 2, s / 2);
  };

  Art.text = function (str, color) {
    str = String(str);
    color = color || P.paper;
    var ck = 'tx|' + str + '|' + color;
    var hit = cache.get(ck);
    if (hit) return hit;
    return cached(ck, Math.max(1, str.length * 4 - 1), 5, function (g) {
      smooth(g, false);
      paintText(g, str, color);
    });
  };

  /* Multiply the source by a colour and put its own alpha back, which
     tints a finished sprite without flattening its shading. */
  Art.colorize = function (canvas, color) {
    var ck = canvas.key ? 'tint|' + canvas.key + '|' + color : null;
    if (ck) {
      var hit = cache.get(ck);
      if (hit) return hit;
    }
    var c = makeCanvas(canvas.width, canvas.height), g = ctxOf(c);
    c.ox = canvas.ox; c.oy = canvas.oy; c.key = ck;
    c.cx = canvas.cx; c.cy = canvas.cy;
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
            /* Natural rock also comes in two faces, picked by cell, so
               both are built now rather than during the first mining. */
            var nv = d.natural ? 2 : 1;
            for (var nz = 0; nz < nv; nz++) {
              Art.thing(d, { wallVariant: m, stuffId: mats[mi], x: nz, y: 0 });
            }
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
      for (var d = 0; d < 4; d++) {
        for (var f = 0; f < 4; f++) Art.pawn(stub, d, f);
      }
    });

    Object.keys(ICON_MAP).forEach(Art.icon);
    for (var mo = 0; mo < 5; mo++) Art.icon('mood-' + mo);
    Object.keys(EFFECT_FRAMES).forEach(function (k) {
      for (var f = 0, n = EFFECT_FRAMES[k]; f < n; f++) Art.effect(k, f);
    });
    for (var sz = 16; sz <= 128; sz += 16) Art.shadow(sz);

    return Art;
  };

  Art.ready = function () { return ready; };
  Art.cacheSize = function () { return cache.size + rotCache.size; };

  /* Roughly what the sprite set costs in video memory. Authoring at 64
     rather than 16 multiplies every canvas by sixteen, so this is worth
     being able to read rather than guess at. */
  Art.cacheBytes = function () {
    var n = 0;
    function add(c) { n += c.width * c.height * 4; }
    cache.forEach(add);
    rotCache.forEach(add);
    if (noiseTiles) noiseTiles.forEach(add);
    return n;
  };

  root.Art = Art;
})(this);
