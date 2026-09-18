/* ============================================================
   render.js - the camera, and every pixel of the world under the UI.

   Three ideas carry the whole file.

   1. Everything is drawn in device pixels at an integer scale. A tile is
      16 authored pixels times the zoom times an integer device scale, and
      the view origin is rounded to a whole pixel every frame, so a sprite
      never lands on a half pixel and nearest-neighbour art stays crisp.
   2. Terrain is cached. Ten thousand fillRects a frame is the obvious way
      to draw a map and the wrong one; instead each 32x32 chunk of the map
      owns an offscreen canvas at authored resolution, repainted only when
      the terrain under it actually changed, and a dozen blits draw the
      ground.
   3. Nothing in here may throw. A thrown frame kills main.js's animation
      loop and the game with it, so every reach into another system is
      guarded, every optional global is read off `root`, and frame() keeps
      a last-resort catch that reports once and carries on.
   ============================================================ */
(function (root) {
  'use strict';

  var PX = 16;                 /* authored pixels per tile */
  var CHUNK = 32;              /* tiles per cached terrain chunk */
  var ZOOM_MIN = 1, ZOOM_MAX = 3;
  var OVERSCROLL = 6;          /* tiles of void the camera may pull past an edge */
  var DARK_STEPS = 16;         /* quantisation of the night tint, to merge fill runs */
  var MAX_DARK = 0.62;         /* pitch midnight is still readable, just barely */

  var VOID = '#0a0c12';
  var BLOOD = '#8b1a1a';
  var INK = '#141821';
  var PAPER = '#e8e2d4';
  var GOLD = '#ffc23c';

  var Render = {};
  var canvas = null, ctx = null;

  /* View state, all recomputed once per frame by syncView(). */
  var pixelScale = 1;          /* device pixels per CSS pixel, forced to an integer */
  var cw = 0, ch = 0;          /* canvas size in device pixels */
  var TS = 32;                 /* tile size in device pixels */
  var originX = 0, originY = 0;
  var b0x = 0, b0y = 0, b1x = 0, b1y = 0;   /* visible tile rect, inclusive */

  var frameCount = 0, clock = 0;
  /* The live cursor, refreshed from Input.pointer once a frame. */
  var mouse = { sx: 0, sy: 0, x: 0, y: 0, inside: false };
  Render.mouse = mouse;
  Render.camera = { x: 0, y: 0, zoom: 2 };

  /* Hoisted scratch. Nothing in a per-cell loop may allocate. */
  var fp = { w: 1, h: 1 };
  var ONE = { w: 1, h: 1 };
  var ONE_SIZE_RANGE = [0.6, 1.0];
  var visPawns = [];
  var fireList = [];
  var ghostList = [];
  var flashes = [];
  var selBox = { x0: 0, y0: 0, x1: 0, y1: 0 }, selBoxOn = false;
  var ghostThing = {
    id: 0, defId: '', def: null, x: 0, y: 0, rot: 0, stack: 1, hp: 100,
    faction: 'player', quality: null, growth: 1, spawned: false, stuff: null
  };

  function gameTick() {
    var G = root.Game;
    return (G && G.tick) || 0;
  }

  var warned = {};
  function warnOnce(key, err) {
    if (warned[key]) return;
    warned[key] = true;
    if (typeof console !== 'undefined' && console.warn) console.warn('render: ' + key, err);
  }

  /* ---------- talking to art.js ----------
     art.js is a sibling client file and may be older, newer or absent.
     Each entry point is wrapped once; if it ever throws, that entry point
     is switched off for the session and the flat fallbacks take over,
     because a renderer that dies on a bad sprite is worse than an ugly one. */
  var artOff = { terrain: false, thing: false, pawn: false, icon: false, effect: false };

  /* art.js decides terrain variants so that anything else keyed on the
     same cell - wall joins, floor patterns - lines up with the ground. */
  function terrainVariant(x, y) {
    var A = root.Art;
    if (!artOff.terrain && A && A.terrainVariant) {
      try { return A.terrainVariant(x, y); }
      catch (e) { artOff.terrain = true; warnOnce('Art.terrainVariant', e); }
    }
    return (tileHash(x, y) >>> 15) & 3;
  }

  function artTerrain(def, variant) {
    var A = root.Art;
    if (artOff.terrain || !A || !A.terrain || !def) return null;
    try {
      var c = A.terrain(def, variant & 3);
      return (c && c.width) ? c : null;
    } catch (e) { artOff.terrain = true; warnOnce('Art.terrain', e); return null; }
  }

  function artThing(def, thing) {
    var A = root.Art;
    if (artOff.thing || !A || !A.thing || !def) return null;
    try {
      var c = A.thing(def, thing);
      return (c && c.width) ? c : null;
    } catch (e) { artOff.thing = true; warnOnce('Art.thing', e); return null; }
  }

  /* Art.ghost draws the finished building at the rotation and material
     the player has picked, which is exactly what a build ghost shows. */
  function artGhost(def, rot, stuffId, x, y) {
    var A = root.Art;
    if (!artOff.thing && A && A.ghost) {
      try {
        var c = A.ghost(def.id, rot, stuffId);
        if (c && c.width) return c;
      } catch (e) { artOff.thing = true; warnOnce('Art.ghost', e); }
    }
    if (def.defCategory === 'terrain') return artTerrain(def, terrainVariant(x, y));
    return artThing(def, ghostThing);
  }

  function artEffect(key, frame) {
    var A = root.Art;
    if (artOff.effect || !A || !A.effect) return null;
    try {
      var c = A.effect(key, frame);
      return (c && c.width) ? c : null;
    } catch (e) { artOff.effect = true; warnOnce('Art.effect', e); return null; }
  }

  function artPawn(pawn, dir, anim) {
    var A = root.Art;
    if (artOff.pawn || !A || !A.pawn) return null;
    try {
      var c = A.pawn(pawn, dir, anim);
      return (c && c.width) ? c : null;
    } catch (e) { artOff.pawn = true; warnOnce('Art.pawn', e); return null; }
  }

  /* art.js hands back sprites that are not always one tile: a tree is
     2x2 drawn from half a tile up and left, an explosion 3x3. Every
     sprite carries ox/oy in authored pixels, so one blit honours all of
     them and nothing has to know which sprite is which size. */
  function blitAt(art, px, py) {
    var u = TS / PX;
    ctx.drawImage(art,
      Math.round(px + (art.ox || 0) * u), Math.round(py + (art.oy || 0) * u),
      art.width * u, art.height * u);
  }

  function blit(art, tx, ty) { blitAt(art, originX + tx * TS, originY + ty * TS); }

  /* An unknown icon key is an ordinary miss and the caller draws its own
     mark; a throw is a broken art file, and that is latched like the rest. */
  function artIcon(key) {
    var A = root.Art;
    if (artOff.icon || !A || !A.icon) return null;
    try {
      var c = A.icon(key);
      return (c && c.width) ? c : null;
    } catch (e) { artOff.icon = true; warnOnce('Art.icon', e); return null; }
  }

  /* ---------- colour ---------- */

  function hexChannel(hex, i) { return parseInt(hex.substr(1 + i * 2, 2), 16); }

  function mixHex(a, b, t) {
    var r = Math.round(hexChannel(a, 0) + (hexChannel(b, 0) - hexChannel(a, 0)) * t);
    var g = Math.round(hexChannel(a, 1) + (hexChannel(b, 1) - hexChannel(a, 1)) * t);
    var bl = Math.round(hexChannel(a, 2) + (hexChannel(b, 2) - hexChannel(a, 2)) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
  }

  /* A ramp is a fixed array of colour strings sampled from stops, so a
     per-cell overlay never builds a string. */
  function buildRamp(stops, n) {
    var lo = stops[0][0], hi = stops[stops.length - 1][0], out = new Array(n);
    for (var i = 0; i < n; i++) {
      var v = lo + (hi - lo) * (i / (n - 1)), k = 1;
      while (k < stops.length - 1 && v > stops[k][0]) k++;
      var a = stops[k - 1], b = stops[k];
      var t = b[0] === a[0] ? 0 : (v - a[0]) / (b[0] - a[0]);
      out[i] = mixHex(a[1], b[1], t < 0 ? 0 : (t > 1 ? 1 : t));
    }
    out.lo = lo; out.hi = hi;
    return out;
  }

  function rampAt(ramp, v) {
    var t = (v - ramp.lo) / (ramp.hi - ramp.lo);
    var i = Math.round(t * (ramp.length - 1));
    if (!(i >= 0)) i = 0;
    return ramp[i < 0 ? 0 : (i >= ramp.length ? ramp.length - 1 : i)];
  }

  var BEAUTY_RAMP = buildRamp([
    [-10, '#c0392b'], [-4, '#c07a2b'], [0, '#6e6e78'], [5, '#7ec24a'], [14, '#3fd07a']
  ], 32);
  var TEMP_RAMP = buildRamp([
    [-30, '#2f5d78'], [-5, '#4a8fd4'], [16, '#5c7a3e'], [30, '#d4a03c'], [50, '#c0392b']
  ], 48);

  /* Stable pseudo-random per tile: terrain variation and sprite jitter
     that costs nothing to store because it is derived from the address. */
  function tileHash(x, y) {
    var h = (x * 374761393 + y * 668265263) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return (h ^ (h >>> 16)) >>> 0;
  }

  var idColors = new Map();
  function idColor(id, sat, light) {
    var key = id * 10000 + sat * 100 + light;
    var c = idColors.get(key);
    if (c) return c;
    c = 'hsl(' + (tileHash(id, id * 7 + 3) % 360) + ',' + sat + '%,' + light + '%)';
    idColors.set(key, c);
    return c;
  }

  /* ---------- canvas and view ---------- */

  Render.init = function (c) {
    if (!c || !c.getContext) return Render;
    canvas = c;
    ctx = canvas.getContext('2d', { alpha: false });
    Render.resize();
    return Render;
  };

  Render.resize = function () {
    if (!canvas || !ctx) return;
    var w = Math.max(1, root.innerWidth || canvas.clientWidth || 960);
    var h = Math.max(1, root.innerHeight || canvas.clientHeight || 600);
    /* A fractional device ratio would put 16px art on half pixels. Round
       it to an integer and let the browser do the last small downscale:
       slightly soft on a 1.5x screen, perfectly sharp everywhere else. */
    pixelScale = Math.max(1, Math.min(3, Math.round(root.devicePixelRatio || 1)));
    cw = Math.round(w * pixelScale);
    ch = Math.round(h * pixelScale);
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    ctx.imageSmoothingEnabled = false;
    backdrop = null;
    syncView();
  };

  function syncView() {
    var cam = Render.camera;
    var z = Math.round(cam.zoom);
    cam.zoom = z < ZOOM_MIN ? ZOOM_MIN : (z > ZOOM_MAX ? ZOOM_MAX : z);
    TS = PX * cam.zoom * pixelScale;

    var map = root.Game && Game.map;
    if (map) clampCamera(map);
    if (!isFinite(cam.x)) cam.x = 0;
    if (!isFinite(cam.y)) cam.y = 0;

    originX = Math.round(cw * 0.5 - cam.x * TS);
    originY = Math.round(ch * 0.5 - cam.y * TS);

    b0x = Math.floor(-originX / TS);
    b0y = Math.floor(-originY / TS);
    b1x = Math.floor((cw - 1 - originX) / TS);
    b1y = Math.floor((ch - 1 - originY) / TS);
    if (map) {
      if (b0x < 0) b0x = 0;
      if (b0y < 0) b0y = 0;
      if (b1x > map.w - 1) b1x = map.w - 1;
      if (b1y > map.h - 1) b1y = map.h - 1;
    }

    /* input.js owns the pointer, canvas rect and all. Converting its CSS
       pixels here rather than trusting the tile it cached keeps the build
       ghost under the cursor on a frame where the camera moved and the
       mouse did not. */
    var ptr = root.Input && Input.pointer;
    if (ptr) {
      mouse.sx = ptr.sx;
      mouse.sy = ptr.sy;
      mouse.inside = !!ptr.inside;
      mouse.x = Math.floor((ptr.sx * pixelScale - originX) / TS);
      mouse.y = Math.floor((ptr.sy * pixelScale - originY) / TS);
    } else {
      mouse.inside = false;
    }
  }

  /* The view always holds the map, give or take a few tiles of margin, so
     the colony can never be panned off into the void and lost. */
  function clampCamera(map) {
    var cam = Render.camera;
    var halfW = cw / (2 * TS), halfH = ch / (2 * TS);
    var lo = halfW - OVERSCROLL, hi = map.w - halfW + OVERSCROLL;
    cam.x = lo >= hi ? map.w * 0.5 : (cam.x < lo ? lo : (cam.x > hi ? hi : cam.x));
    lo = halfH - OVERSCROLL; hi = map.h - halfH + OVERSCROLL;
    cam.y = lo >= hi ? map.h * 0.5 : (cam.y < lo ? lo : (cam.y > hi ? hi : cam.y));
  }

  Render.screenToTile = function (sx, sy) {
    syncView();
    return {
      x: Math.floor((sx * pixelScale - originX) / TS),
      y: Math.floor((sy * pixelScale - originY) / TS)
    };
  };

  Render.tileToScreen = function (x, y) {
    syncView();
    return { sx: (originX + x * TS) / pixelScale, sy: (originY + y * TS) / pixelScale };
  };

  /* Fractional tile under a CSS-pixel point, which is what zooming needs
     so the cell under the cursor does not drift. */
  function tileAtFX(sx) { return (sx * pixelScale - originX) / TS; }
  function tileAtFY(sy) { return (sy * pixelScale - originY) / TS; }

  Render.visibleBounds = function () {
    syncView();
    return { x0: b0x, y0: b0y, x1: b1x, y1: b1y };
  };

  Render.centerOn = function (x, y) {
    Render.camera.x = x + 0.5;
    Render.camera.y = y + 0.5;
    syncView();
  };

  /* Positive delta zooms in. The cursor keeps whatever tile it was over. */
  Render.zoomBy = function (delta, sx, sy) {
    var cam = Render.camera, before = cam.zoom;
    var step = delta > 0 ? 1 : (delta < 0 ? -1 : 0);
    var z = before + step;
    if (z < ZOOM_MIN) z = ZOOM_MIN;
    if (z > ZOOM_MAX) z = ZOOM_MAX;
    if (z === before) return;
    syncView();
    var anchorX = null, anchorY = null;
    if (sx !== undefined && sy !== undefined) {
      anchorX = tileAtFX(sx); anchorY = tileAtFY(sy);
    }
    cam.zoom = z;
    syncView();
    if (anchorX !== null) {
      cam.x += anchorX - tileAtFX(sx);
      cam.y += anchorY - tileAtFY(sy);
      syncView();
    }
  };

  /* Moves the camera by screen pixels: positive dx slides the view right. */
  Render.panBy = function (dxPixels, dyPixels) {
    Render.camera.x += (dxPixels * pixelScale) / TS;
    Render.camera.y += (dyPixels * pixelScale) / TS;
    syncView();
  };

  Render.flashCell = function (x, y) {
    if (flashes.length > 40) flashes.shift();
    flashes.push({ x: x, y: y, t: clock });
  };

  Render.setSelectionBox = function (box) {
    if (!box) { selBoxOn = false; return; }
    var x0, y0, x1, y1;
    if (box.w !== undefined && box.h !== undefined && box.x !== undefined) {
      x0 = box.x; y0 = box.y; x1 = box.x + box.w - 1; y1 = box.y + box.h - 1;
    } else {
      x0 = box.x0 !== undefined ? box.x0 : box.sx;
      y0 = box.y0 !== undefined ? box.y0 : box.sy;
      x1 = box.x1 !== undefined ? box.x1 : box.ex;
      y1 = box.y1 !== undefined ? box.y1 : box.ey;
    }
    if (x0 === undefined || y0 === undefined || x1 === undefined || y1 === undefined) {
      selBoxOn = false; return;
    }
    selBox.x0 = Math.min(x0, x1); selBox.x1 = Math.max(x0, x1);
    selBox.y0 = Math.min(y0, y1); selBox.y1 = Math.max(y0, y1);
    selBoxOn = true;
  };

  /* ---------- small drawing helpers ---------- */

  function outlineRect(px, py, w, h, t, color) {
    ctx.fillStyle = color;
    ctx.fillRect(px, py, w, t);
    ctx.fillRect(px, py + h - t, w, t);
    ctx.fillRect(px, py + t, t, h - t * 2);
    ctx.fillRect(px + w - t, py + t, t, h - t * 2);
  }

  function bar(px, py, w, h, frac, fill, back) {
    ctx.fillStyle = back || 'rgba(8,10,16,0.75)';
    ctx.fillRect(px, py, w, h);
    var f = frac < 0 ? 0 : (frac > 1 ? 1 : frac);
    ctx.fillStyle = fill;
    ctx.fillRect(px, py, Math.round(w * f), h);
  }

  function edge() { return Math.max(1, (TS / 16) | 0); }

  /* ---------- terrain chunk cache ----------
     The map exposes no per-chunk dirty counter, so the cache keeps its own
     snapshot of the terrain indices it last painted and compares a visible
     chunk against the live grid each frame. That is a kilobyte of byte
     compares per visible chunk - a rounding error next to repainting one. */

  var chunks = null, chunksX = 0, chunksY = 0, chunkOwner = null;

  function ensureChunks(map) {
    if (chunks && chunkOwner === map) return;
    chunkOwner = map;
    chunksX = Math.ceil(map.w / CHUNK);
    chunksY = Math.ceil(map.h / CHUNK);
    chunks = new Array(chunksX * chunksY);
  }

  function chunkAt(cx, cy) {
    var ci = cy * chunksX + cx, c = chunks[ci];
    if (!c) {
      var el = document.createElement('canvas');
      el.width = CHUNK * PX;
      el.height = CHUNK * PX;
      var g = el.getContext('2d');
      g.imageSmoothingEnabled = false;
      c = chunks[ci] = { canvas: el, ctx: g, snap: new Uint8Array(CHUNK * CHUNK), painted: false, seen: 0 };
    }
    c.seen = frameCount;
    return c;
  }

  function chunkStale(map, c, cx, cy) {
    if (!c.painted) return true;
    var terrain = map.terrain, w = map.w, snap = c.snap;
    var x0 = cx * CHUNK, y0 = cy * CHUNK;
    var x1 = Math.min(x0 + CHUNK, map.w), y1 = Math.min(y0 + CHUNK, map.h);
    for (var y = y0; y < y1; y++) {
      var base = y * w, row = (y - y0) * CHUNK - x0;
      for (var x = x0; x < x1; x++) {
        if (snap[row + x] !== terrain[base + x]) return true;
      }
    }
    return false;
  }

  function repaintChunk(map, c, cx, cy) {
    var g = c.ctx;
    g.clearRect(0, 0, CHUNK * PX, CHUNK * PX);
    var terrain = map.terrain, w = map.w, snap = c.snap;
    var x0 = cx * CHUNK, y0 = cy * CHUNK;
    var x1 = Math.min(x0 + CHUNK, map.w), y1 = Math.min(y0 + CHUNK, map.h);
    for (var y = y0; y < y1; y++) {
      var base = y * w, row = (y - y0) * CHUNK - x0, dy = (y - y0) * PX;
      for (var x = x0; x < x1; x++) {
        var ti = terrain[base + x];
        snap[row + x] = ti;
        var def = Defs.fromIndex('terrain', ti);
        if (!def) continue;
        var variant = terrainVariant(x, y);
        var art = artTerrain(def, variant);
        var dx = (x - x0) * PX;
        if (art) {
          g.drawImage(art, dx + (art.ox || 0), dy + (art.oy || 0));
        } else {
          g.fillStyle = (variant & 1) && def.color2 ? def.color2 : (def.color || '#4a4a52');
          g.fillRect(dx, dy, PX, PX);
          /* Two speckles of the other shade keep a flat fill from reading
             as a solid colour field when art.js is not there. */
          g.fillStyle = (variant & 1) ? (def.color || '#4a4a52') : (def.color2 || def.color || '#4a4a52');
          g.fillRect(dx + (variant % 11), dy + ((variant >>> 4) % 11), 3, 2);
          g.fillRect(dx + ((variant >>> 8) % 12), dy + ((variant >>> 12) % 13), 2, 2);
        }
      }
    }
    c.painted = true;
  }

  function pruneChunks() {
    if (!chunks || (frameCount & 511) !== 0) return;
    for (var i = 0; i < chunks.length; i++) {
      var c = chunks[i];
      if (c && frameCount - c.seen > 1200) chunks[i] = null;
    }
  }

  function drawTerrain(map) {
    ensureChunks(map);
    var side = CHUNK * TS;
    var c0x = Math.max(0, Math.floor(b0x / CHUNK)), c1x = Math.min(chunksX - 1, Math.floor(b1x / CHUNK));
    var c0y = Math.max(0, Math.floor(b0y / CHUNK)), c1y = Math.min(chunksY - 1, Math.floor(b1y / CHUNK));
    for (var cy = c0y; cy <= c1y; cy++) {
      var dy = originY + cy * side;
      for (var cx = c0x; cx <= c1x; cx++) {
        var c = chunkAt(cx, cy);
        if (chunkStale(map, c, cx, cy)) repaintChunk(map, c, cx, cy);
        ctx.drawImage(c.canvas, originX + cx * side, dy, side, side);
      }
    }
    pruneChunks();
  }

  /* ---------- filth ---------- */

  function drawFilth(map) {
    var blood = map.blood;
    if (!blood) return;
    var w = map.w, q = Math.max(1, TS >> 3), lastA = -1;
    ctx.fillStyle = BLOOD;
    for (var y = b0y; y <= b1y; y++) {
      var base = y * w, py = originY + y * TS;
      for (var x = b0x; x <= b1x; x++) {
        var v = blood[base + x];
        if (!v) continue;
        var a = Math.round((0.10 + (v / 255) * 0.5) * 16) / 16;
        if (a !== lastA) { ctx.globalAlpha = a; lastA = a; }
        var h = tileHash(x, y + 9001), px = originX + x * TS;
        ctx.fillRect(px + (h % 5) * q, py + ((h >>> 4) % 5) * q, q * 4, q * 3);
        ctx.fillRect(px + ((h >>> 8) % 9) * q, py + ((h >>> 12) % 9) * q, q * 2, q * 2);
      }
    }
    ctx.globalAlpha = 1;
  }

  /* ---------- zones ---------- */

  var zoneCache = new Map(), zoneCacheFrame = -1, zoneFills = new Map(), zoneOwner = null;

  function rebuildZoneCache(map) {
    /* The id lookup is rebuilt every frame a zone is drawn; the colours
       are not, because a zone's hue is fixed for its whole life and
       building two strings per zone per frame is pure garbage. */
    if (zoneOwner !== map) { zoneFills.clear(); zoneOwner = map; }
    zoneCache.clear();
    var list = map.zones || [];
    for (var i = 0; i < list.length; i++) if (list[i]) zoneCache.set(list[i].id, list[i]);
    zoneCacheFrame = frameCount;
  }

  function zoneById(map, id) {
    var z = zoneCache.get(id);
    if (z) return z;
    if (zoneCacheFrame !== frameCount) { rebuildZoneCache(map); z = zoneCache.get(id); }
    return z || null;
  }

  function zoneFill(z) {
    var c = zoneFills.get(z.id);
    if (c) return c;
    var hue = z.kind === 'growing' ? 96 : 38;
    hue = (hue + (tileHash(z.id, 17) % 40) - 20 + 360) % 360;
    c = z.color
      ? [z.color, z.color]
      : ['hsla(' + hue + ',55%,45%,0.22)', 'hsla(' + hue + ',70%,62%,0.75)'];
    zoneFills.set(z.id, c);
    return c;
  }

  function zonesWanted() {
    var UIx = root.UI;
    if (UIx && UIx.overlay === 'zones') return true;
    if (UIx && UIx.tool && UIx.tool.kind === 'zone') return true;
    var sel = root.Game && Game.selection;
    if (sel) for (var i = 0; i < sel.length; i++) if (isZoneLike(sel[i])) return true;
    return false;
  }

  function drawZones(map) {
    var zid = map.zoneId;
    if (!zid) return;
    if (zoneCacheFrame !== frameCount) rebuildZoneCache(map);
    var w = map.w, h = map.h, e = edge();
    for (var y = b0y; y <= b1y; y++) {
      var base = y * w, py = originY + y * TS;
      for (var x = b0x; x <= b1x; x++) {
        var id = zid[base + x];
        if (!id) continue;
        var z = zoneById(map, id);
        if (!z) continue;
        var col = zoneFill(z), px = originX + x * TS;
        ctx.fillStyle = col[0];
        ctx.fillRect(px, py, TS, TS);
        ctx.fillStyle = col[1];
        if (x === 0 || zid[base + x - 1] !== id) ctx.fillRect(px, py, e, TS);
        if (x === w - 1 || zid[base + x + 1] !== id) ctx.fillRect(px + TS - e, py, e, TS);
        if (y === 0 || zid[base - w + x] !== id) ctx.fillRect(px, py, TS, e);
        if (y === h - 1 || zid[base + w + x] !== id) ctx.fillRect(px, py + TS - e, TS, e);
      }
    }
  }

  /* ---------- plants, items, buildings ---------- */

  function thingById(map, id) {
    if (!id) return null;
    if (map.things && map.things.get) return map.things.get(id) || null;
    return map.thing ? map.thing(id) : null;
  }

  function defOf(t) {
    return t.def || (t.defId ? Defs.maybe('thing', t.defId) : null);
  }

  function drawPlants(map) {
    var pid = map.plantId;
    if (!pid) return;
    var w = map.w;
    for (var y = b0y; y <= b1y; y++) {
      var base = y * w, py = originY + y * TS;
      for (var x = b0x; x <= b1x; x++) {
        var id = pid[base + x];
        if (!id) continue;
        var t = thingById(map, id);
        if (t) drawPlant(t, originX + x * TS, py, x, y);
      }
    }
  }

  function drawPlant(t, px, py, x, y) {
    var def = defOf(t);
    if (!def) return;
    var art = artThing(def, t);
    if (art) {
      /* The sprite already encodes growth stage, ripeness and blight, and
         a tree comes back oversized with the offset to match. */
      blitAt(art, px, py);
      return;
    }
    /* Flat-colour stand-in: grow the shape with the plant and jitter it a
       pixel or two, so a rice field does not read as a grid. */
    var pd = def.plant;
    var growth = t.growth === undefined ? 1 : t.growth;
    var rng = (pd && pd.visualSizeRange) || ONE_SIZE_RANGE;
    var s = rng[0] + (rng[1] - rng[0]) * (growth < 0 ? 0 : (growth > 1 ? 1 : growth));
    var size = Math.max(3, Math.round(TS * s));
    var h = tileHash(x, y);
    var ox = px + ((TS - size) >> 1) + ((h % 3) - 1) * pixelScale;
    var oy = py + ((TS - size) >> 1) + (((h >>> 3) % 3) - 1) * pixelScale;
    if (t.blighted) ctx.globalAlpha = 0.75;
    var q = Math.max(1, size >> 3);
    ctx.fillStyle = def.color || '#4e7a3c';
    ctx.fillRect(ox + (size >> 1) - q, oy + (size >> 1), q * 2, size >> 1);
    ctx.fillRect(ox + q, oy + q * 2, size - q * 2, size >> 1);
    ctx.fillStyle = def.color2 || def.color || '#6f9a4a';
    ctx.fillRect(ox + q * 2, oy + q, q * 2, q * 2);
    ctx.fillRect(ox + size - q * 4, oy + q * 2, q * 2, q * 2);
    if (t.blighted) {
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#6b5a33';
      ctx.fillRect(ox, oy, size, size);
      ctx.globalAlpha = 1;
    }
  }

  function drawItems(map) {
    var grid = map.itemGrid;
    if (!grid) return;
    var w = map.w;
    for (var y = b0y; y <= b1y; y++) {
      var base = y * w, py = originY + y * TS;
      for (var x = b0x; x <= b1x; x++) {
        var list = grid[base + x];
        if (!list || !list.length) continue;
        var px = originX + x * TS, shown = 0;
        /* The whole stack is walked even though only three of it is drawn,
           because fire is an item on this grid and burns above the pile it
           is eating, not in its place in the queue. */
        for (var k = 0; k < list.length; k++) {
          var t = list[k];
          if (!t) continue;
          if (t.defId === 'fire') { fireList.push(t); continue; }
          if (shown >= 3) continue;
          drawItem(t, px + shown * (TS >> 3), py + shown * (TS >> 3), x, y);
          shown++;
        }
      }
    }
  }

  function drawItem(t, px, py, x, y) {
    var def = defOf(t);
    if (!def) return;
    var art = artThing(def, t);
    if (art) { blitAt(art, px, py); return; }
    var q = Math.max(1, TS >> 3);
    ctx.fillStyle = INK;
    ctx.fillRect(px + q * 2, py + q * 3, TS - q * 4, TS - q * 5);
    ctx.fillStyle = def.color || '#b0b0b8';
    ctx.fillRect(px + q * 2 + pixelScale, py + q * 3 + pixelScale,
      TS - q * 4 - pixelScale * 2, TS - q * 5 - pixelScale * 2);
    ctx.fillStyle = def.color2 || def.color || '#d0d0d8';
    ctx.fillRect(px + q * 3, py + q * 4, q * 2, Math.max(1, q));
    if (tileHash(x, y) & 1) ctx.fillRect(px + TS - q * 4, py + TS - q * 4, q, q);
  }

  function drawBuildings(map) {
    var bid = map.buildingId;
    if (!bid) return;
    var w = map.w;
    /* The scan widens by three tiles so a four-wide solar array whose
       origin sits just off screen still draws its visible half. */
    var x0 = Math.max(0, b0x - 3), x1 = Math.min(map.w - 1, b1x + 3);
    var y0 = Math.max(0, b0y - 3), y1 = Math.min(map.h - 1, b1y + 3);
    for (var y = y0; y <= y1; y++) {
      var base = y * w;
      for (var x = x0; x <= x1; x++) {
        var id = bid[base + x];
        if (!id) continue;
        var t = thingById(map, id);
        if (!t || t.x !== x || t.y !== y) continue;
        drawBuilding(t);
      }
    }
  }

  function footprintOf(def, rot, out) {
    var s = (def && def.size) || ONE;
    if (rot === 1 || rot === 3) { out.w = s.h; out.h = s.w; } else { out.w = s.w; out.h = s.h; }
  }

  function drawBuilding(t) {
    var def = defOf(t);
    if (!def) return;
    footprintOf(def, t.rot | 0, fp);
    var px = originX + t.x * TS, py = originY + t.y * TS;
    var dw = fp.w * TS, dh = fp.h * TS;
    var art = artThing(def, t);
    if (art) {
      blitAt(art, px, py);
    } else {
      var q = Math.max(1, TS >> 4) * pixelScale;
      ctx.fillStyle = def.color || '#8f97a3';
      ctx.fillRect(px, py, dw, dh);
      ctx.fillStyle = def.color2 || INK;
      ctx.fillRect(px + q * 2, py + q * 2, dw - q * 4, Math.max(1, dh >> 3));
      outlineRect(px, py, dw, dh, q, 'rgba(10,12,18,0.55)');
    }
    /* A building that has taken a beating says so, because a wall at a
       fifth of its hit points is a raid about to come through. */
    var max = t.maxHp || (def && def.hp) || 0;
    if (t.hp !== undefined && max > 0 && t.hp < max * 0.7) {
      var bw = Math.max(4, dw - 4), bh = Math.max(2, pixelScale * 2);
      bar(px + 2, py + dh - bh - 2, bw, bh, t.hp / max, '#c0392b');
    }
  }

  /* ---------- blueprints and frames ---------- */

  /* map.js keeps blueprints and frames on their own cell grid, so the
     visible rectangle finds them exactly the way it finds buildings -
     no walk of every plan on the map, and nothing to de-duplicate. */
  function collectGhosts(map) {
    var gid = map.ghostId;
    if (!gid) { collectGhostsFromIndex(map); return; }
    var w = map.w;
    var x0 = Math.max(0, b0x - 3), x1 = Math.min(map.w - 1, b1x + 3);
    var y0 = Math.max(0, b0y - 3), y1 = Math.min(map.h - 1, b1y + 3);
    for (var y = y0; y <= y1; y++) {
      var base = y * w;
      for (var x = x0; x <= x1; x++) {
        var id = gid[base + x];
        if (!id) continue;
        var t = thingById(map, id);
        if (t && t.x === x && t.y === y) ghostList.push(t);
      }
    }
  }

  function collectGhostsFromIndex(map) {
    var C = root.Construct;
    if (!C || !C.blueprints || !C.frames) return;
    var a, b, i;
    try { a = C.blueprints(map); b = C.frames(map); }
    catch (e) { warnOnce('Construct.blueprints', e); return; }
    for (i = 0; i < a.length; i++) pushGhost(a[i]);
    for (i = 0; i < b.length; i++) pushGhost(b[i]);
  }

  function pushGhost(g) {
    if (!g || !g.spawned) return;
    if (g.x > b1x + 3 || g.y > b1y + 3 || g.x < b0x - 3 || g.y < b0y - 3) return;
    ghostList.push(g);
  }

  function buildDefOf(g) {
    if (!g.buildDefId) return defOf(g);
    return Defs.maybe('thing', g.buildDefId) || Defs.maybe('terrain', g.buildDefId) || defOf(g);
  }

  function drawGhosts(map) {
    for (var i = 0; i < ghostList.length; i++) {
      var g = ghostList[i];
      var def = buildDefOf(g);
      if (!def) continue;
      footprintOf(def, g.rot | 0, fp);
      var px = originX + g.x * TS, py = originY + g.y * TS;
      var dw = fp.w * TS, dh = fp.h * TS;
      var frame = !!g.isFrame;

      ctx.globalAlpha = frame ? 0.7 : 0.45;
      var art = artThing(defOf(g) || def, g);
      if (art) {
        blitAt(art, px, py);
      } else {
        ctx.fillStyle = def.color || '#8f97a3';
        ctx.fillRect(px, py, dw, dh);
      }
      ctx.globalAlpha = frame ? 0.30 : 0.38;
      ctx.fillStyle = frame ? '#9c8a5a' : '#6fa8dc';
      ctx.fillRect(px, py, dw, dh);
      ctx.globalAlpha = 1;
      outlineRect(px, py, dw, dh, Math.max(1, pixelScale), frame ? '#c9b48a' : '#6fa8dc');

      var total = workToBuild(g);
      var done = g.workDone || 0;
      if (total > 0 && done > 0) {
        var bh = Math.max(2, pixelScale * 2);
        bar(px + 2, py + dh - bh - 2, Math.max(4, dw - 4), bh, done / total, GOLD);
      } else if (!frame) {
        /* An unstarted blueprint is waiting on a hauler, and the corner
           pip is the cheapest way to say "materials, not labour". */
        ctx.fillStyle = 'rgba(111,168,220,0.9)';
        ctx.fillRect(px + 2, py + 2, Math.max(2, pixelScale * 2), Math.max(2, pixelScale * 2));
      }
    }
  }

  function workToBuild(g) {
    var C = root.Construct;
    if (C && C.workToBuild && g.buildDefId) {
      try { return C.workToBuild(g.buildDefId, g.stuff); } catch (e) { warnOnce('Construct.workToBuild', e); }
    }
    var def = buildDefOf(g);
    return (def && def.workToBuild) || 0;
  }

  /* ---------- pawns ---------- */

  var pawnRecs = new Map();
  var ppx = 0, ppy = 0;

  function pawnRec(p, interp) {
    var fx = p.fx === undefined ? p.x : p.fx;
    var fy = p.fy === undefined ? p.y : p.fy;
    var rec = pawnRecs.get(p.id);
    if (!rec) {
      rec = { px: fx, py: fy, cx: fx, cy: fy, tick: -1, moving: false, hp: 1, hpTick: -1, seen: 0 };
      pawnRecs.set(p.id, rec);
    }
    rec.seen = frameCount;
    var gt = gameTick();
    if (rec.tick !== gt) {
      rec.px = rec.cx; rec.py = rec.cy;
      rec.cx = fx; rec.cy = fy;
      rec.tick = gt;
      var d = Math.abs(fx - rec.px) + Math.abs(fy - rec.py);
      rec.moving = d > 0.002;
      /* A spawn, a drop pod or a rescue moves a pawn further than a tick
         ever could; snapping keeps it from streaking across the map. */
      if (d > 2) { rec.px = fx; rec.py = fy; }
    }
    ppx = rec.px + (rec.cx - rec.px) * interp;
    ppy = rec.py + (rec.cy - rec.py) * interp;
    return rec;
  }

  function prunePawnRecs() {
    if ((frameCount & 1023) !== 0) return;
    pawnRecs.forEach(function (rec, id) {
      if (frameCount - rec.seen > 2000) pawnRecs.delete(id);
    });
  }

  function byDepth(a, b) {
    var ra = pawnRecs.get(a.id), rb = pawnRecs.get(b.id);
    return (ra ? ra.cy : a.y) - (rb ? rb.cy : b.y);
  }

  function factionColor(p) {
    if (p.faction === 'player') return '#4a7fd4';
    if (p.faction === 'raider') return '#c0392b';
    if (p.faction === 'neutral') return '#7a9c52';
    return '#b08c5a';
  }

  function drawPawns(map, interp) {
    var list = map.pawns;
    if (!list) return;
    visPawns.length = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || p.dead) continue;
      pawnRec(p, interp);
      if (ppx < b0x - 2 || ppx > b1x + 2 || ppy < b0y - 2 || ppy > b1y + 2) continue;
      visPawns.push(p);
    }
    visPawns.sort(byDepth);
    for (var k = 0; k < visPawns.length; k++) drawPawn(visPawns[k], interp);
    prunePawnRecs();
  }

  function drawPawn(p, interp) {
    var rec = pawnRec(p, interp);
    var px = Math.round(originX + ppx * TS);
    var py = Math.round(originY + ppy * TS);
    var dir = p.dir | 0;
    var anim = rec.moving ? ((gameTick() / 9 | 0) & 1) : 0;
    var art = artPawn(p, dir, anim);

    if (art) {
      /* Art.pawn poses the sprite itself - upright, downed or dead - so
         there is nothing here to rotate. */
      blitAt(art, px, py);
    } else {
      var body = (p.kind && p.kind.bodySize) || (p.isAnimal ? 0.8 : 1);
      var dw = Math.max(4, Math.round(TS * Math.max(0.5, Math.min(2.2, body))));
      var ox = px + ((TS - dw) >> 1), oy = py + ((TS - dw) >> 1);
      /* Laid out flat, without save/restore: an exception between the two
         would leave every later frame drawn on its side. */
      if (p.downed) {
        var mx = px + TS * 0.5, my = py + TS * 0.5;
        ctx.translate(mx, my);
        ctx.rotate(1.5707963267948966);
        ctx.translate(-mx, -my);
      }
      drawPawnFallback(p, ox, oy, dw, dw, dir);
      if (p.downed) ctx.setTransform(1, 0, 0, 1, 0, 0);
    }

    if (p.carried) drawCarried(p, px, py, dir);
    if (p.aimTarget && p.stanceTicks > 0) drawAimPip(px, py);
  }

  function drawPawnFallback(p, ox, oy, dw, dh, dir) {
    var q = Math.max(1, dw >> 4) * 2;
    var col = factionColor(p);
    ctx.fillStyle = INK;
    ctx.fillRect(ox + q, oy + q, dw - q * 2, dh - q * 2);
    ctx.fillStyle = col;
    ctx.fillRect(ox + q + pixelScale, oy + (dh >> 2), dw - q * 2 - pixelScale * 2, dh - (dh >> 2) - q - pixelScale);
    ctx.fillStyle = p.isAnimal ? (p.kind && p.kind.color) || '#8a6134' : '#d9b08a';
    ctx.fillRect(ox + (dw >> 2), oy + q, dw >> 1, dh >> 2);
    /* A pip on the facing edge, so you can tell which way a pawn looks. */
    ctx.fillStyle = INK;
    var pw = Math.max(1, dw >> 4) * 2;
    if (dir === 0) ctx.fillRect(ox + (dw >> 1) - pw, oy + dh - q - pw, pw * 2, pw);
    else if (dir === 1) ctx.fillRect(ox + dw - q - pw, oy + (dh >> 1) - pw, pw, pw * 2);
    else if (dir === 2) ctx.fillRect(ox + (dw >> 1) - pw, oy + q, pw * 2, pw);
    else ctx.fillRect(ox + q, oy + (dh >> 1) - pw, pw, pw * 2);
  }

  function drawCarried(p, px, py, dir) {
    var t = p.carried, def = defOf(t);
    if (!def) return;
    var s = Math.max(4, Math.round(TS * 0.55));
    var dx = dir === 1 ? TS * 0.35 : (dir === 3 ? -TS * 0.35 : 0);
    var dy = dir === 2 ? -TS * 0.3 : TS * 0.28;
    var ox = Math.round(px + (TS - s) * 0.5 + dx);
    var oy = Math.round(py + (TS - s) * 0.5 + dy);
    var art = artThing(def, t);
    if (art) {
      ctx.drawImage(art, ox, oy, s, s);
    } else {
      ctx.fillStyle = INK;
      ctx.fillRect(ox, oy, s, s);
      ctx.fillStyle = def.color || '#b0b0b8';
      ctx.fillRect(ox + pixelScale, oy + pixelScale, s - pixelScale * 2, s - pixelScale * 2);
    }
  }

  function drawAimPip(px, py) {
    var s = Math.max(2, pixelScale * 2);
    ctx.fillStyle = 'rgba(255,194,60,0.9)';
    ctx.fillRect(px + TS - s * 2, py, s, s);
  }

  /* ---------- projectiles and fire ---------- */

  function drawProjectiles(map, interp) {
    var C = root.Combat;
    var list = C && C.projectiles;
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || p.dead) continue;
      /* combat.js holds one list for the world and only sweeps another
         map's rounds out on its next tick; a colony that has just been
         restarted must not fly the old one's bullets. */
      if (p.map && p.map !== map) continue;
      var x = p.x, y = p.y;
      if (x === undefined || y === undefined) continue;
      /* The projectile only moves on a tick, so lean on its own heading to
         carry it the rest of the way between ticks. */
      var dx = 0, dy = 0;
      if (p.dist > 0.001 && p.tx !== undefined && p.sx !== undefined) {
        dx = (p.tx - p.sx) / p.dist;
        dy = (p.ty - p.sy) / p.dist;
        var step = (p.speed || 0) * interp;
        x += dx * step; y += dy * step;
      }
      if (x < b0x - 2 || x > b1x + 2 || y < b0y - 2 || y > b1y + 2) continue;
      var def = p.defId ? Defs.maybe('thing', p.defId) : null;
      var cx = originX + (x + 0.5) * TS, cy = originY + (y + 0.5) * TS;
      var len = (p.defId === 'arrow' ? 0.8 : 0.45) * TS;
      ctx.strokeStyle = (def && def.color) || '#ffd77a';
      ctx.lineWidth = Math.max(1, pixelScale * (p.defId === 'arrow' ? 2 : 1));
      ctx.beginPath();
      ctx.moveTo(cx - dx * len, cy - dy * len);
      ctx.lineTo(cx, cy);
      ctx.stroke();
      ctx.fillStyle = (def && def.color2) || '#fff3c4';
      var s = Math.max(1, pixelScale);
      ctx.fillRect(cx - s, cy - s, s * 2, s * 2);
    }
  }

  function drawFire() {
    for (var i = 0; i < fireList.length; i++) {
      var t = fireList[i];
      var h = tileHash(t.x, t.y);
      var art = artEffect('fire', Math.floor(clock / 110) + h);
      if (art) { blit(art, t.x, t.y); continue; }
      var px = originX + t.x * TS, py = originY + t.y * TS;
      var wob = Math.sin(clock * 0.011 + (h % 628) / 100);
      var hgt = TS * (0.62 + 0.18 * wob);
      var wid = TS * (0.52 + 0.10 * Math.sin(clock * 0.017 + h % 7));
      var bx = px + (TS - wid) * 0.5, by = py + TS - hgt;
      ctx.fillStyle = '#ff8c1a';
      ctx.fillRect(bx, by, wid, hgt);
      ctx.fillStyle = '#ffd23c';
      ctx.fillRect(bx + wid * 0.22, by + hgt * 0.3, wid * 0.56, hgt * 0.7);
      ctx.fillStyle = '#fff3c4';
      ctx.fillRect(bx + wid * 0.4, by + hgt * 0.62, wid * 0.2, hgt * 0.38);
    }
  }

  /* ---------- light and night ---------- */

  var lightGrid = null, lightOwner = null, lightFrame = -999, powerOff = false;
  var lightB = [0, 0, 0, 0];
  var darkLUT = null, tintRamp = null, tintKey = -1;
  var glowSprite = null;

  function buildDarkLUT() {
    darkLUT = new Uint8Array(256);
    for (var v = 0; v < 256; v++) {
      var d = 1 - v / 255;
      darkLUT[v] = Math.round(Math.pow(d, 1.15) * DARK_STEPS);
    }
  }

  function tintFor(day) {
    /* Night is the blue of the palette; daytime gloom indoors is a
       neutral shadow. One ramp covers both, mixed by how bright it is
       outside, and is rebuilt only when that brightness really changes. */
    var key = Math.round(day * 24);
    if (tintRamp && tintKey === key) return tintRamp;
    tintKey = key;
    var t = key / 24;
    var r = Math.round(14 + (20 - 14) * t);
    var g = Math.round(20 + (24 - 20) * t);
    var b = Math.round(48 + (33 - 48) * t);
    tintRamp = new Array(DARK_STEPS + 1);
    for (var i = 0; i <= DARK_STEPS; i++) {
      tintRamp[i] = 'rgba(' + r + ',' + g + ',' + b + ',' + (MAX_DARK * i / DARK_STEPS).toFixed(3) + ')';
    }
    return tintRamp;
  }

  function updateLightGrid(map, day) {
    if (!lightGrid || lightOwner !== map || lightGrid.length !== map.size) {
      lightGrid = new Uint8Array(map.size);
      lightOwner = map;
      lightFrame = -999;
    }
    var moved = lightB[0] !== b0x || lightB[1] !== b0y || lightB[2] !== b1x || lightB[3] !== b1y;
    if (!moved && frameCount - lightFrame < 5) return;
    lightFrame = frameCount;
    lightB[0] = b0x; lightB[1] = b0y; lightB[2] = b1x; lightB[3] = b1y;

    var P = root.Power;
    var useLightAt = !powerOff && !!(P && P.lightAt);
    var roof = map.roof, w = map.w;
    for (var y = b0y; y <= b1y; y++) {
      var base = y * w;
      for (var x = b0x; x <= b1x; x++) {
        var l;
        if (useLightAt) {
          try {
            l = P.lightAt(map, x, y);
          } catch (e) {
            useLightAt = false;
            powerOff = true;
            warnOnce('Power.lightAt', e);
            l = day;
          }
        } else {
          /* Without a power grid, a roof is the only thing between a cell
             and the sky, and an unlit room should still feel like one. */
          l = day * (roof && roof[base + x] ? 0.28 : 1);
        }
        if (!(l >= 0)) l = 0;
        if (l > 1) l = 1;
        lightGrid[base + x] = (l * 255) | 0;
      }
    }
  }

  function glow() {
    if (glowSprite) return glowSprite;
    var c = document.createElement('canvas');
    c.width = c.height = 64;
    var g = c.getContext('2d');
    var grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,196,118,0.9)');
    grd.addColorStop(0.45, 'rgba(255,140,40,0.34)');
    grd.addColorStop(1, 'rgba(255,120,30,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    glowSprite = c;
    return c;
  }

  function drawLight(map) {
    var day = (root.Game && Game.daylight) ? Game.daylight() : 1;
    updateLightGrid(map, day);
    if (!darkLUT) buildDarkLUT();
    var ramp = tintFor(day);
    var w = map.w;

    /* Equal-darkness cells along a row collapse into one rect, so a lit
       room or an open field costs a handful of fills instead of hundreds. */
    for (var y = b0y; y <= b1y; y++) {
      var base = y * w, py = originY + y * TS;
      var runQ = -1, runStart = b0x;
      for (var x = b0x; x <= b1x + 1; x++) {
        var q = x > b1x ? -1 : darkLUT[lightGrid[base + x]];
        if (q !== runQ) {
          if (runQ > 0) {
            ctx.fillStyle = ramp[runQ];
            ctx.fillRect(originX + runStart * TS, py, (x - runStart) * TS, TS);
          }
          runQ = q; runStart = x;
        }
      }
    }

    if (fireList.length) {
      var g = glow(), r = TS * 3;
      ctx.globalCompositeOperation = 'lighter';
      ctx.imageSmoothingEnabled = true;
      for (var i = 0; i < fireList.length; i++) {
        var t = fireList[i];
        var flick = 0.8 + 0.2 * Math.sin(clock * 0.013 + (tileHash(t.x, t.y) % 628) / 100);
        var s = r * flick;
        ctx.drawImage(g, originX + (t.x + 0.5) * TS - s * 0.5, originY + (t.y + 0.5) * TS - s * 0.5, s, s);
      }
      ctx.imageSmoothingEnabled = false;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  /* ---------- designations ---------- */

  var desigMap = null;

  function drawDesignations(map) {
    var d = map.designations;
    if (!d || !d.forEach) return;
    desigMap = map;
    d.forEach(drawDesignation);
    desigMap = null;
  }

  function drawDesignation(info, i) {
    var map = desigMap;
    var x = info && info.x !== undefined ? info.x : i % map.w;
    var y = info && info.y !== undefined ? info.y : (i - (i % map.w)) / map.w;
    if (x < b0x || x > b1x || y < b0y || y > b1y) return;
    drawDesignationMark((info && info.type) || info, originX + x * TS, originY + y * TS);
  }

  function desigColor(type) {
    if (type === 'hunt' || type === 'slaughter' || type === 'deconstruct') return '#e07a5a';
    if (type === 'tame') return '#7ec24a';
    if (type === 'haulUrgent') return '#6fa8dc';
    return GOLD;
  }

  /* art.js has a sprite for every designation type, so the bracket below is
     only ever seen if art.js is missing or has been switched off: it says
     the cell is marked and roughly for what, and no more. */
  function drawDesignationMark(type, px, py) {
    var icon = artIcon('des-' + type);
    if (icon) { blitAt(icon, px, py); return; }
    var m = TS * 0.22, s = TS - m * 2, t = Math.max(1, pixelScale);
    outlineRect(px + m, py + m, s, s, t, 'rgba(8,10,16,0.75)');
    outlineRect(px + m + t, py + m + t, s - t * 2, s - t * 2, t, desigColor(type));
  }

  /* ---------- selection, status bars, orders ---------- */

  function isPawnLike(s) { return !!(s && s.needs && s.health); }
  function isZoneLike(s) { return !!(s && s.cells && s.kind && !s.defId); }

  function drawSelection(map, interp) {
    var G = root.Game;
    var sel = G ? G.selection : null;
    if (sel) {
      for (var i = 0; i < sel.length; i++) {
        var s = sel[i];
        if (!s) continue;
        if (isPawnLike(s)) drawPawnRing(s, interp);
        else if (isZoneLike(s)) drawZoneHighlight(map, s);
        else if (s.defId) drawThingRing(s);
      }
      for (var j = 0; j < sel.length; j++) if (isPawnLike(sel[j])) drawJobLine(map, sel[j], interp);
    }
    drawStatusBars(map, interp);
    drawSelectionBox();
    drawFlashes();
  }

  function ringPath(cx, cy, rx, ry) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, 0, 0, 6.283185307179586);
  }

  function drawPawnRing(p, interp) {
    if (p.dead) return;
    pawnRec(p, interp);
    if (ppx < b0x - 2 || ppx > b1x + 2 || ppy < b0y - 2 || ppy > b1y + 2) return;
    var cx = originX + (ppx + 0.5) * TS, cy = originY + (ppy + 0.75) * TS;
    ctx.lineWidth = Math.max(1, pixelScale);
    ctx.strokeStyle = 'rgba(8,10,16,0.7)';
    ringPath(cx, cy, TS * 0.42, TS * 0.22);
    ctx.stroke();
    ctx.strokeStyle = PAPER;
    ringPath(cx, cy, TS * 0.40, TS * 0.20);
    ctx.stroke();
  }

  function drawThingRing(t) {
    var def = defOf(t);
    footprintOf(def, t.rot | 0, fp);
    var px = originX + t.x * TS, py = originY + t.y * TS;
    var e = Math.max(1, pixelScale);
    outlineRect(px - e, py - e, fp.w * TS + e * 2, fp.h * TS + e * 2, e, 'rgba(8,10,16,0.7)');
    outlineRect(px, py, fp.w * TS, fp.h * TS, e, PAPER);
  }

  function drawZoneHighlight(map, z) {
    var zid = map.zoneId;
    if (!zid) return;
    var w = map.w, e = edge();
    ctx.fillStyle = PAPER;
    for (var y = b0y; y <= b1y; y++) {
      var base = y * w, py = originY + y * TS;
      for (var x = b0x; x <= b1x; x++) {
        if (zid[base + x] !== z.id) continue;
        var px = originX + x * TS;
        if (x === 0 || zid[base + x - 1] !== z.id) ctx.fillRect(px, py, e, TS);
        if (x === w - 1 || zid[base + x + 1] !== z.id) ctx.fillRect(px + TS - e, py, e, TS);
        if (y === 0 || zid[base - w + x] !== z.id) ctx.fillRect(px, py, TS, e);
        if (y === map.h - 1 || zid[base + w + x] !== z.id) ctx.fillRect(px, py + TS - e, TS, e);
      }
    }
  }

  function bodyHealth(p, rec) {
    var gt = gameTick();
    if (rec.hpTick === gt) return rec.hp;
    rec.hpTick = gt;
    var h = p.health, cur = 0, max = 0;
    if (h && h.parts) {
      for (var i = 0; i < h.parts.length; i++) {
        var part = h.parts[i];
        var pm = part.maxHp || 0;
        max += pm;
        cur += part.missing ? 0 : (part.hp || 0);
      }
    }
    var v = max > 0 ? cur / max : 1;
    if (h && h.bloodLoss) v = Math.min(v, 1 - h.bloodLoss);
    rec.hp = v < 0 ? 0 : (v > 1 ? 1 : v);
    return rec.hp;
  }

  function drawStatusBars(map, interp) {
    var list = map.pawns;
    if (!list) return;
    var bw = Math.max(6, Math.round(TS * 0.8));
    var bh = Math.max(2, pixelScale * 2);
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p || p.dead) continue;
      if (!p.isHuman && !p.tame) continue;
      var rec = pawnRec(p, interp);
      if (ppx < b0x - 1 || ppx > b1x + 1 || ppy < b0y - 1 || ppy > b1y + 1) continue;

      var hurt = !!(p.downed || (p.health && (p.health.bloodLoss > 0.02 ||
        (p.health.injuries && p.health.injuries.length))));
      var mood = p.mood;
      var upset = p.faction === 'player' && p.isHuman && mood !== undefined && mood < 0.5;
      if (!hurt && !upset) continue;

      var px = Math.round(originX + ppx * TS + (TS - bw) * 0.5);
      var py = Math.round(originY + ppy * TS) - bh * 2 - pixelScale;
      if (hurt) {
        var hp = bodyHealth(p, rec);
        bar(px, py, bw, bh, hp, hp > 0.6 ? '#7ec24a' : (hp > 0.3 ? '#d4a03c' : '#c0392b'));
        py += bh + pixelScale;
      }
      if (upset) {
        var th = p.breakThresholds;
        var minor = th ? th.minor : 0.35;
        bar(px, py, bw, bh, mood, mood < minor ? '#c0392b' : '#6fa8dc');
      }
    }
  }

  function drawJobLine(map, p, interp) {
    var job = p.job;
    if (!job) return;
    var Targ = root.T;
    if (!Targ || !Targ.pos) return;
    var tgt = (p.carried && job.targetB) ? job.targetB : (job.targetA || job.targetB);
    if (!tgt) return;
    var pos = null;
    try { pos = Targ.pos(tgt, map); } catch (e) { warnOnce('T.pos', e); return; }
    if (!pos) return;
    pawnRec(p, interp);
    var x0 = originX + (ppx + 0.5) * TS, y0 = originY + (ppy + 0.5) * TS;
    var x1 = originX + (pos.x + 0.5) * TS, y1 = originY + (pos.y + 0.5) * TS;
    ctx.strokeStyle = 'rgba(232,226,212,0.55)';
    ctx.lineWidth = Math.max(1, pixelScale);
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    var s = Math.max(2, pixelScale * 2);
    ctx.fillStyle = GOLD;
    ctx.fillRect(x1 - s, y1 - s, s * 2, s * 2);
  }

  function drawSelectionBox() {
    if (!selBoxOn) return;
    var UIx = root.UI;
    var kind = UIx && UIx.tool ? UIx.tool.kind : 'select';
    if (kind === 'build') return;               /* the ghost draws that drag */
    var px = originX + selBox.x0 * TS, py = originY + selBox.y0 * TS;
    var w = (selBox.x1 - selBox.x0 + 1) * TS, h = (selBox.y1 - selBox.y0 + 1) * TS;
    var col = kind === 'cancel' ? '#c0392b' : (kind === 'select' ? PAPER : GOLD);
    ctx.globalAlpha = 0.16;
    ctx.fillStyle = col;
    ctx.fillRect(px, py, w, h);
    ctx.globalAlpha = 1;
    outlineRect(px, py, w, h, Math.max(1, pixelScale), col);
  }

  function drawFlashes() {
    for (var i = flashes.length - 1; i >= 0; i--) {
      var f = flashes[i];
      var age = (clock - f.t) / 900;
      if (age >= 1) { flashes.splice(i, 1); continue; }
      if (f.x < b0x - 2 || f.x > b1x + 2 || f.y < b0y - 2 || f.y > b1y + 2) continue;
      var grow = TS * (0.2 + age * 0.9);
      var px = originX + f.x * TS - grow * 0.5, py = originY + f.y * TS - grow * 0.5;
      ctx.globalAlpha = 1 - age;
      outlineRect(px, py, TS + grow, TS + grow, Math.max(1, pixelScale * 2), GOLD);
      ctx.globalAlpha = 1;
    }
  }

  /* ---------- the build ghost ---------- */

  function toolDragRect() {
    if (selBoxOn) return selBox;
    var I = root.Input;
    var d = I && I.drag;
    if (!d || d.x0 === undefined || d.x1 === undefined) return null;
    selBox.x0 = Math.min(d.x0, d.x1); selBox.x1 = Math.max(d.x0, d.x1);
    selBox.y0 = Math.min(d.y0, d.y1); selBox.y1 = Math.max(d.y0, d.y1);
    return selBox;
  }

  /* Walls, conduits, sandbags and floors are the things you paint in a
     line; everything else is placed one at a time. */
  function draggable(def) {
    var s = def.size || ONE;
    if (s.w !== 1 || s.h !== 1) return false;
    if (def.defCategory === 'terrain') return true;
    if (def.buildCategory === 'structure') return true;
    var b = def.building;
    return !!(b && (b.isConduit || b.isSandbag || b.isTrap));
  }

  function drawBuildGhost(map) {
    var UIx = root.UI;
    var tool = UIx && UIx.tool;
    if (!tool || tool.kind !== 'build' || !tool.defId) return;
    var def = Defs.maybe('thing', tool.defId) || Defs.maybe('terrain', tool.defId);
    if (!def) return;
    var rot = tool.rot | 0;
    var drag = toolDragRect();
    if (drag && draggable(def)) {
      /* A drag can cover the whole map, so the run is clipped to the view
         first and then capped: the budget is spent on cells somebody is
         looking at rather than on the half of the rectangle off screen. */
      var y0 = Math.max(drag.y0, b0y - 4), y1 = Math.min(drag.y1, b1y + 1);
      var x0 = Math.max(drag.x0, b0x - 4), x1 = Math.min(drag.x1, b1x + 1);
      var budget = 0;
      for (var y = y0; y <= y1 && budget < 400; y++) {
        for (var x = x0; x <= x1 && budget < 400; x++) {
          budget++;
          ghostAt(map, def, x, y, rot, tool.stuffId);
        }
      }
    } else if (mouse.inside) {
      ghostAt(map, def, mouse.x, mouse.y, rot, tool.stuffId);
    }
  }

  function ghostAt(map, def, x, y, rot, stuffId) {
    if (x < b0x - 4 || x > b1x + 1 || y < b0y - 4 || y > b1y + 1) return;
    var ok = true;
    var C = root.Construct;
    if (C && C.canPlace) {
      try {
        var r = C.canPlace(map, def.id, x, y, rot);
        ok = !r || r.ok !== false;
      } catch (e) { warnOnce('Construct.canPlace', e); }
    } else {
      ok = map.inBounds(x, y);
    }
    footprintOf(def, rot, fp);
    var px = originX + x * TS, py = originY + y * TS;
    var dw = fp.w * TS, dh = fp.h * TS;

    ghostThing.defId = def.id;
    ghostThing.def = def;
    ghostThing.x = x; ghostThing.y = y; ghostThing.rot = rot;
    ghostThing.stuff = stuffId || null;
    ghostThing.hp = def.hp || 100;

    ctx.globalAlpha = 0.55;
    var art = artGhost(def, rot, stuffId, x, y);
    if (art) {
      blitAt(art, px, py);
    } else {
      ctx.fillStyle = def.color || '#8f97a3';
      ctx.fillRect(px, py, dw, dh);
    }
    ctx.globalAlpha = 0.34;
    ctx.fillStyle = ok ? '#4ad07a' : '#c0392b';
    ctx.fillRect(px, py, dw, dh);
    ctx.globalAlpha = 1;
    outlineRect(px, py, dw, dh, Math.max(1, pixelScale), ok ? '#8df0b0' : '#ff6b5a');
  }

  function drawToolRect(map) {
    var UIx = root.UI;
    var tool = UIx && UIx.tool;
    if (!tool) return;
    if (tool.kind !== 'designate' && tool.kind !== 'zone' && tool.kind !== 'cancel') return;
    if (!mouse.inside || selBoxOn) return;
    if (mouse.x < b0x || mouse.x > b1x || mouse.y < b0y || mouse.y > b1y) return;
    var px = originX + mouse.x * TS, py = originY + mouse.y * TS;
    var col = tool.kind === 'cancel' ? '#c0392b' : (tool.kind === 'zone' ? '#7ec24a' : GOLD);
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = col;
    ctx.fillRect(px, py, TS, TS);
    ctx.globalAlpha = 1;
    outlineRect(px, py, TS, TS, Math.max(1, pixelScale), col);
    if (tool.kind === 'designate' && tool.designation) {
      drawDesignationMark(tool.designation, px, py);
    }
  }

  /* ---------- overlays ---------- */

  var roomIds = [], roomSx = [], roomSy = [], roomN = [], roomIdx = new Map();

  function drawOverlay(map) {
    var UIx = root.UI;
    var ov = (UIx && UIx.overlay) || 'none';
    /* Zones already drew, down under the pawns where a floor marking
       belongs; drawing them again on top would only mute the colony. */
    if (ov === 'power') overlayPower(map);
    else if (ov === 'rooms') overlayRooms(map);
    else if (ov === 'beauty') overlayBeauty(map);
    else if (ov === 'temperature') overlayTemperature(map);
  }

  function overlayPower(map) {
    var bid = map.buildingId;
    if (!bid) return;
    var w = map.w, e = edge();
    var flash = 0.35 + 0.35 * Math.sin(clock * 0.008);
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = '#05070c';
    ctx.fillRect(originX + b0x * TS, originY + b0y * TS, (b1x - b0x + 1) * TS, (b1y - b0y + 1) * TS);
    ctx.globalAlpha = 1;
    for (var y = b0y; y <= b1y; y++) {
      var base = y * w, py = originY + y * TS;
      for (var x = b0x; x <= b1x; x++) {
        var id = bid[base + x];
        if (!id) continue;
        var t = thingById(map, id);
        if (!t || t.x !== x || t.y !== y) continue;
        var def = defOf(t), b = def && def.building;
        if (!b) continue;
        var px = originX + x * TS;
        if (b.isConduit) {
          ctx.fillStyle = 'rgba(255,194,60,0.85)';
          ctx.fillRect(px + TS * 0.35, py, TS * 0.3, TS);
          ctx.fillRect(px, py + TS * 0.35, TS, TS * 0.3);
        } else if (b.powerProduced > 0 || b.batteryCapacity > 0) {
          footprintOf(def, t.rot | 0, fp);
          outlineRect(px, py, fp.w * TS, fp.h * TS, e, '#7ec24a');
        } else if (b.powerConsumed > 0) {
          footprintOf(def, t.rot | 0, fp);
          if (t.powered) {
            outlineRect(px, py, fp.w * TS, fp.h * TS, e, '#6fa8dc');
          } else {
            ctx.globalAlpha = flash;
            ctx.fillStyle = '#c0392b';
            ctx.fillRect(px, py, fp.w * TS, fp.h * TS);
            ctx.globalAlpha = 1;
            outlineRect(px, py, fp.w * TS, fp.h * TS, e, '#ff6b5a');
          }
        }
      }
    }
  }

  function overlayRooms(map) {
    var rid = map.roomId;
    if (!rid) return;
    var w = map.w, e = edge();
    ctx.globalAlpha = 0.34;
    for (var y = b0y; y <= b1y; y++) {
      var base = y * w, py = originY + y * TS;
      for (var x = b0x; x <= b1x; x++) {
        var id = rid[base + x];
        if (id <= 0) continue;
        ctx.fillStyle = idColor(id, 62, 48);
        ctx.fillRect(originX + x * TS, py, TS, TS);
      }
    }
    ctx.globalAlpha = 0.8;
    for (y = b0y; y <= b1y; y++) {
      base = y * w; py = originY + y * TS;
      for (x = b0x; x <= b1x; x++) {
        id = rid[base + x];
        if (id <= 0) continue;
        var px = originX + x * TS;
        ctx.fillStyle = idColor(id, 70, 70);
        if (x === 0 || rid[base + x - 1] !== id) ctx.fillRect(px, py, e, TS);
        if (y === 0 || rid[base - w + x] !== id) ctx.fillRect(px, py, TS, e);
      }
    }
    ctx.globalAlpha = 1;
  }

  function cellBeauty(map, i) {
    var v = 0;
    var td = Defs.fromIndex('terrain', map.terrain[i]);
    if (td) v += td.beauty || 0;
    var t;
    if (map.buildingId && map.buildingId[i]) {
      t = thingById(map, map.buildingId[i]);
      if (t && t.def) v += t.def.beauty || 0;
    }
    if (map.plantId && map.plantId[i]) {
      t = thingById(map, map.plantId[i]);
      if (t && t.def) v += t.def.beauty || 0;
    }
    var list = map.itemGrid ? map.itemGrid[i] : null;
    if (list) for (var k = 0; k < list.length; k++) if (list[k] && list[k].def) v += list[k].def.beauty || 0;
    if (map.blood && map.blood[i]) v -= 2 * (map.blood[i] / 255);
    return v;
  }

  function overlayBeauty(map) {
    var w = map.w;
    ctx.globalAlpha = 0.5;
    for (var y = b0y; y <= b1y; y++) {
      var base = y * w, py = originY + y * TS;
      for (var x = b0x; x <= b1x; x++) {
        ctx.fillStyle = rampAt(BEAUTY_RAMP, cellBeauty(map, base + x));
        ctx.fillRect(originX + x * TS, py, TS, TS);
      }
    }
    ctx.globalAlpha = 1;
  }

  function overlayTemperature(map) {
    var rid = map.roomId;
    var R = root.Regions;
    if (!rid || !R || !R.rooms) return;
    var rooms = null;
    try { rooms = R.rooms(map); } catch (e) { warnOnce('Regions.rooms', e); return; }
    if (!rooms || !rooms.get) return;
    var outdoor = (root.Game && Game.outdoorTemp) ? Game.outdoorTemp() : 20;
    var w = map.w;

    roomIds.length = 0; roomSx.length = 0; roomSy.length = 0; roomN.length = 0;
    roomIdx.clear();

    ctx.globalAlpha = 0.45;
    for (var y = b0y; y <= b1y; y++) {
      var base = y * w, py = originY + y * TS;
      for (var x = b0x; x <= b1x; x++) {
        var id = rid[base + x];
        var room = id > 0 ? rooms.get(id) : null;
        var temp = room && room.temperature !== undefined && !room.outdoor ? room.temperature : outdoor;
        ctx.fillStyle = rampAt(TEMP_RAMP, temp);
        ctx.fillRect(originX + x * TS, py, TS, TS);
        if (!room || room.outdoor) continue;
        var k = roomIdx.get(id);
        if (k === undefined) {
          k = roomIds.length;
          roomIdx.set(id, k);
          roomIds.push(id); roomSx.push(0); roomSy.push(0); roomN.push(0);
        }
        roomSx[k] += x; roomSy[k] += y; roomN[k]++;
      }
    }
    ctx.globalAlpha = 1;

    /* One number per room, at the middle of the part you can actually see. */
    var fs = Math.max(9, Math.round(TS * 0.36));
    ctx.font = fs + 'px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, pixelScale * 2);
    ctx.strokeStyle = 'rgba(8,10,16,0.9)';
    ctx.fillStyle = PAPER;
    for (var i = 0; i < roomIds.length; i++) {
      if (roomN[i] < 2) continue;
      var rm = rooms.get(roomIds[i]);
      if (!rm) continue;
      var label = Math.round(rm.temperature) + '°';
      var lx = originX + (roomSx[i] / roomN[i] + 0.5) * TS;
      var ly = originY + (roomSy[i] / roomN[i] + 0.5) * TS;
      ctx.strokeText(label, lx, ly);
      ctx.fillText(label, lx, ly);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  /* ---------- the menu backdrop ---------- */

  var backdrop = null;

  function drawBackdrop() {
    if (backdrop && backdrop.width === cw && backdrop.height === ch) {
      ctx.drawImage(backdrop, 0, 0);
      return;
    }
    backdrop = document.createElement('canvas');
    backdrop.width = cw; backdrop.height = ch;
    var g = backdrop.getContext('2d');
    var grd = g.createLinearGradient(0, 0, 0, ch);
    grd.addColorStop(0, '#0b1024');
    grd.addColorStop(0.7, '#131a2e');
    grd.addColorStop(1, '#241d1c');
    g.fillStyle = grd;
    g.fillRect(0, 0, cw, ch);
    /* A field of stars, so the menu has a rimworld behind it and still
       asks for no image file. */
    for (var i = 0; i < 200; i++) {
      var h = tileHash(i, 7);
      g.fillStyle = 'rgba(232,226,212,' + (0.16 + ((h >>> 5) % 70) / 100) + ')';
      g.fillRect(h % cw, (h >>> 9) % Math.max(1, Math.floor(ch * 0.7)), pixelScale, pixelScale);
    }
    ctx.drawImage(backdrop, 0, 0);
  }

  /* ---------- the frame ---------- */

  var frameErrors = 0;

  Render.frame = function (interp) {
    if (!ctx) return;
    frameCount++;
    clock = (root.performance && root.performance.now) ? root.performance.now() : frameCount * 16.7;
    if (!(interp >= 0)) interp = 0;
    if (interp > 1) interp = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    syncView();

    var map = root.Game && Game.map;
    if (!map || !map.terrain) {
      drawBackdrop();
      return;
    }

    ctx.fillStyle = VOID;
    ctx.fillRect(0, 0, cw, ch);

    fireList.length = 0;
    ghostList.length = 0;

    try {
      drawTerrain(map);
      drawFilth(map);
      if (zonesWanted()) drawZones(map);
      drawPlants(map);
      drawItems(map);
      drawBuildings(map);
      collectGhosts(map);
      drawGhosts(map);
      drawPawns(map, interp);
      drawProjectiles(map, interp);
      drawFire();
      drawLight(map);
      drawDesignations(map);
      drawSelection(map, interp);
      drawBuildGhost(map);
      drawToolRect(map);
      drawOverlay(map);
    } catch (err) {
      /* main.js counts frame errors and pauses the game after four, so a
         renderer that swallows its own is the difference between one ugly
         frame and a dead colony. Report the first few and carry on. */
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.imageSmoothingEnabled = false;
      frameErrors++;
      if (frameErrors <= 3 && typeof console !== 'undefined') console.error('render frame:', err);
    }
  };

  root.Render = Render;
})(this);
