/* ============================================================
   worldview.js - the planet screen, and the two dialogs that
   turn looking at it into doing something.

   Three things shape this file.

   It borrows #tab-panel rather than opening a canvas of its own
   over the whole window. The main #game canvas is sized to the
   window in device pixels and owned by render.js; a second one on
   top of it would fight for the wheel, the cursor and the resize.
   Living inside the panel ui.js already positions means the world
   screen inherits the frame, the border and the z-order, and the
   only thing this file has to own is what is inside it.

   The planet wraps east to west, so nothing here stores a screen
   position. Every tile is projected through nearestX(), which
   picks whichever copy of the world column is closest to the
   camera. Drag past the dateline and the map keeps going, because
   the column you dragged onto was never at a fixed x to begin
   with.

   Nothing below owns any state the simulation needs. Closing the
   screen mid-dialog drops a Deal on the floor and that is safe:
   trade.js writes goods only in Trade.confirm, and a caravan's
   deal is reopened lazily the next time anyone asks for it. That
   is what lets escape always work.
   ============================================================ */
(function (root) {
  'use strict';

  var doc = root.document;
  var U = root.U;

  var WorldView = {};

  var TICKS_PER_DAY = 60000;
  var MIN_SCALE = 5;                /* pixels per world tile */
  var MAX_SCALE = 44;
  var LABEL_SCALE = 13;             /* settlements get their names past this */
  var COLONY_GOLD = '#ffc23c';
  var SIDE_WIDTH = 336;

  /* ------------------------------------------------------------------
     Small DOM and formatting helpers. ui.js has its own copies of the
     first three; they are private to it, and four lines is a cheaper
     price than a shared dependency between two files that own their
     own markup.
     ------------------------------------------------------------------ */

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function btn(label, cls, fn) {
    var b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    if (fn) b.addEventListener('click', fn);
    return b;
  }

  function style(node, css) {
    for (var k in css) node.style[k] = css[k];
    return node;
  }

  function row(parent, label, value, valueCls) {
    var r = el('div', 'kv');
    r.appendChild(el('div', 'kv-l', label));
    r.appendChild(el('div', 'kv-v' + (valueCls ? ' ' + valueCls : ''), value));
    parent.appendChild(r);
    return r;
  }

  function days(d) { return U.fmt(d, 1) + ' ' + U.plural(Math.round(d), 'day'); }
  function tempStr(c) { return U.fmt(c, 0) + ' C'; }

  /* Goodwill runs -100..100 and the bar has to read at a glance, so it
     is drawn as a centred meter: the fill grows right from the middle
     when they like you and left when they do not. */
  function goodwillBar(value) {
    var wrap = el('div', '');
    style(wrap, {
      position: 'relative', height: '7px', background: 'var(--bg0)',
      border: '1px solid var(--line-soft)', margin: '3px 0'
    });
    var mid = el('div', '');
    style(mid, { position: 'absolute', left: '50%', top: '0', bottom: '0', width: '1px', background: 'var(--line)' });
    wrap.appendChild(mid);
    var fill = el('div', '');
    var frac = U.clamp(value, -100, 100) / 100;
    var colour = value <= -75 ? 'var(--bad)' : (value < 0 ? 'var(--warn)'
      : (value >= 40 ? 'var(--good)' : 'var(--colonist)'));
    style(fill, {
      position: 'absolute', top: '0', bottom: '0', background: colour,
      left: (frac < 0 ? (50 + frac * 50) : 50) + '%',
      width: Math.abs(frac) * 50 + '%'
    });
    wrap.appendChild(fill);
    return wrap;
  }

  /* ---------- colour ---------- */

  function rgbOf(hex) {
    var s = String(hex || '#888888').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    if (!isFinite(n)) return [136, 136, 136];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function shade(hex, factor) {
    var c = rgbOf(hex);
    return 'rgb(' + Math.round(U.clamp(c[0] * factor, 0, 255)) + ',' +
      Math.round(U.clamp(c[1] * factor, 0, 255)) + ',' +
      Math.round(U.clamp(c[2] * factor, 0, 255)) + ')';
  }

  /* ------------------------------------------------------------------
     State
     ------------------------------------------------------------------ */

  var S = {
    inited: false,
    open: false,
    root: null, mapWrap: null, canvas: null, ctx: null, side: null,
    tooltip: null, dialogLayer: null,
    cam: { x: 0, y: 0, scale: 16 },
    view: { w: 0, h: 0 },
    drag: null,
    hoverTile: -1, mouse: null, hoverCaravan: null,
    sel: null,                      /* {kind:'settlement'|'caravan'|'tile', ...} */
    dialog: null,
    roadCache: null, roadStamp: '',
    sideSig: '', frame: 0
  };

  function W() { return root.World && root.World.generated ? root.World : null; }
  function G() { return root.Game || null; }
  function Fac() { return root.Factions || null; }
  function Car() { return root.Caravans || null; }
  function Trd() { return root.Trade || null; }

  function say(text) {
    if (root.UI && root.UI.toast) root.UI.toast(text);
    else if (G() && G().msg) G().msg(text, {});
  }

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    if (typeof pawn.label === 'function') return pawn.label();
    if (pawn.name) return pawn.name.nick || pawn.name.first || 'someone';
    return 'someone';
  }

  function defOf(id) {
    return root.Defs && root.Defs.maybe ? root.Defs.maybe('thing', id) : null;
  }
  function labelOf(id) { var d = defOf(id); return d ? d.label : id; }

  /* ------------------------------------------------------------------
     Life cycle
     ------------------------------------------------------------------ */

  WorldView.init = function () {
    if (S.inited || !doc) return WorldView;
    S.inited = true;
    /* Capture phase, because input.js listens on the document too and
       the world screen has to answer escape before it turns into "close
       the tab panel" behind our back. */
    if (doc.addEventListener) doc.addEventListener('keydown', onKeyDown, true);
    return WorldView;
  };

  WorldView.isOpen = function () { return !!S.open; };

  WorldView.open = function () {
    if (!doc) return false;
    WorldView.init();
    if (S.open) return true;
    var panel = doc.getElementById('tab-panel');
    if (!panel) return false;

    /* ui.js keeps its own idea of which tab is showing and rebuilds the
       panel from it. Closing that first is what stops UI.update() wiping
       this screen out from under the cursor on its next frame. */
    if (root.UI && root.UI.closeTab) root.UI.closeTab();

    clear(panel);
    panel.classList.remove('hidden');
    buildFrame(panel);
    S.open = true;
    S.sideSig = '';
    S.roadCache = null;
    S.dialog = null;
    S.sel = null;
    centreOnColony();
    resize();
    renderSide();
    draw();
    requestFrame();
    return true;
  };

  WorldView.close = function () {
    if (!S.open) return false;
    S.open = false;
    closeDialog();
    var panel = doc && doc.getElementById('tab-panel');
    if (panel) {
      if (S.root && S.root.parentNode === panel) panel.removeChild(S.root);
      /* Only hide the panel if nothing else has claimed it since. */
      if (!panel.firstChild) panel.classList.add('hidden');
    }
    S.root = S.canvas = S.ctx = S.side = S.tooltip = S.dialogLayer = S.mapWrap = null;
    S.drag = null;
    S.sel = null;
    S.hoverTile = -1;
    S.hoverCaravan = null;
    return true;
  };

  WorldView.toggle = function () {
    return S.open ? (WorldView.close(), false) : WorldView.open();
  };

  function buildFrame(panel) {
    var rootEl = el('div', 'wv-root');
    style(rootEl, { display: 'flex', flexDirection: 'column', flex: '1', minHeight: '0' });

    var head = el('div', 'tp-head');
    head.appendChild(el('div', 'tp-title', 'The planet'));
    var hint = el('div', 'faint', 'drag to pan  ·  wheel to zoom  ·  esc to leave');
    style(hint, { marginRight: '10px', fontSize: '11px' });
    head.appendChild(hint);
    head.appendChild(btn('Home', 'mini', centreOnColony));
    head.appendChild(btn('Close', 'tp-close', function () { WorldView.close(); }));
    rootEl.appendChild(head);

    var body = el('div', 'wv-body');
    style(body, { flex: '1', display: 'flex', minHeight: '0', position: 'relative' });

    var wrap = el('div', 'wv-map');
    style(wrap, { flex: '1', minWidth: '0', position: 'relative', overflow: 'hidden', background: '#080b11' });
    var canvas = el('canvas', 'wv-canvas');
    style(canvas, { position: 'absolute', left: '0', top: '0', width: '100%', height: '100%', cursor: 'grab' });
    wrap.appendChild(canvas);

    var tip = el('div', 'wv-tip');
    style(tip, {
      position: 'absolute', display: 'none', pointerEvents: 'none', zIndex: '3',
      background: 'rgba(20,24,33,0.96)', border: '1px solid var(--line)',
      padding: '4px 7px', fontSize: '11px', lineHeight: '1.4', maxWidth: '240px',
      color: 'var(--text)', boxShadow: 'var(--panel-shadow)'
    });
    wrap.appendChild(tip);
    body.appendChild(wrap);

    var side = el('div', 'wv-side');
    style(side, {
      width: SIDE_WIDTH + 'px', flex: 'none', borderLeft: '1px solid var(--line)',
      display: 'flex', flexDirection: 'column', minHeight: '0',
      background: 'var(--bg1)', fontSize: '11px'
    });
    body.appendChild(side);

    var layer = el('div', 'wv-dialog-layer');
    style(layer, {
      position: 'absolute', left: '0', top: '0', right: '0', bottom: '0', display: 'none',
      background: 'rgba(8,10,14,0.84)', zIndex: '6',
      alignItems: 'center', justifyContent: 'center', padding: '16px'
    });
    body.appendChild(layer);

    rootEl.appendChild(body);
    panel.appendChild(rootEl);

    S.root = rootEl; S.mapWrap = wrap; S.canvas = canvas; S.side = side;
    S.tooltip = tip; S.dialogLayer = layer;
    S.ctx = canvas.getContext ? canvas.getContext('2d') : null;

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', function (e) { if (e.preventDefault) e.preventDefault(); });
    if (doc.addEventListener) {
      doc.addEventListener('mousemove', onDocMove);
      doc.addEventListener('mouseup', onDocUp);
    }
  }

  /* ------------------------------------------------------------------
     Keyboard

     input.js owns w/a/s/d for panning the colony map and this file is
     not allowed to take that away, so the planet opens on shift+W: the
     same finger, and a key nothing else was using. While the screen is
     up every key is swallowed except pause and the speed digits, which
     are still worth having when a caravan is three days out.
     ------------------------------------------------------------------ */

  var PASS_THROUGH = { ' ': 1, Spacebar: 1, '1': 1, '2': 1, '3': 1, '4': 1 };

  function onKeyDown(e) {
    if (!e || e.ctrlKey || e.metaKey || e.altKey) return;
    var key = e.key;
    if (!key) return;
    if (key.length > 1 && /^F\d+$/.test(key)) return;

    var target = e.target;
    var typing = target && target.tagName &&
      /^(INPUT|TEXTAREA|SELECT)$/.test(String(target.tagName).toUpperCase());

    if (!S.open) {
      if (!typing && e.shiftKey && (e.code === 'KeyW' || key === 'W')) {
        if (!G() || !G().started || !G().map) return;
        if (e.preventDefault) e.preventDefault();
        if (e.stopPropagation) e.stopPropagation();
        WorldView.open();
      }
      return;
    }

    if (key === 'Escape') {
      if (e.preventDefault) e.preventDefault();
      if (e.stopPropagation) e.stopPropagation();
      if (S.dialog) closeDialog(); else WorldView.close();
      return;
    }
    if (typing || PASS_THROUGH[key]) return;
    /* Everything else would steer a map nobody is looking at. */
    if (e.stopPropagation) e.stopPropagation();
    if (key === 'Home' || key === 'h' || key === 'H') centreOnColony();
  }

  /* ------------------------------------------------------------------
     Camera and projection
     ------------------------------------------------------------------ */

  function worldW() { var w = W(); return w ? w.w : 1; }
  function worldH() { var w = W(); return w ? w.h : 1; }

  function wrapDelta(d) {
    var w = worldW();
    d -= Math.round(d / w) * w;
    return d;
  }

  /* Whichever copy of this column is nearest the camera. Everything on
     the map is placed through this, which is the whole east-west wrap. */
  function nearestX(tx) { return S.cam.x + wrapDelta(tx - S.cam.x); }

  function screenX(txUnwrapped) { return (txUnwrapped + 0.5 - S.cam.x) * S.cam.scale + S.view.w / 2; }
  function screenY(ty) { return (ty + 0.5 - S.cam.y) * S.cam.scale + S.view.h / 2; }

  function tileAtScreen(sx, sy) {
    var w = W();
    if (!w) return -1;
    var tx = Math.floor((sx - S.view.w / 2) / S.cam.scale + S.cam.x);
    var ty = Math.floor((sy - S.view.h / 2) / S.cam.scale + S.cam.y);
    if (ty < 0 || ty >= w.h) return -1;
    return w.idx(((tx % w.w) + w.w) % w.w, ty);
  }

  function clampCam() {
    var w = worldW(), h = worldH();
    S.cam.x = ((S.cam.x % w) + w) % w;
    /* Vertically there is no wrap: the poles are the edge of the map, so
       the camera is allowed to overhang by half a screen and no more. */
    var halfTiles = S.view.h / (2 * S.cam.scale);
    var lo = Math.min(h / 2, halfTiles * 0.6);
    S.cam.y = U.clamp(S.cam.y, -lo, h + lo);
  }

  function centreOnColony() {
    var w = W();
    if (!w) return;
    S.cam.x = w.xOf(w.colonyTile) + 0.5;
    S.cam.y = w.yOf(w.colonyTile) + 0.5;
    /* A world tile is half a day's walk; sixteen pixels of it is enough
       to read a name beside a dot and still see a week in every
       direction. */
    S.cam.scale = U.clamp(S.cam.scale, 12, MAX_SCALE);
    clampCam();
  }

  function resize() {
    var c = S.canvas;
    if (!c) return;
    var w = c.clientWidth || (S.mapWrap && S.mapWrap.clientWidth) || 800;
    var h = c.clientHeight || (S.mapWrap && S.mapWrap.clientHeight) || 600;
    var dpr = root.devicePixelRatio || 1;
    S.view.w = w; S.view.h = h;
    var pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
    if (c.width !== pw || c.height !== ph) { c.width = pw; c.height = ph; }
  }

  /* ------------------------------------------------------------------
     Drawing
     ------------------------------------------------------------------ */

  /* Roads never move once a world is generated, except when factions.js
     hooks a newly placed town into the network, so the segment list is
     rebuilt only when the settlement count changes. */
  function roadSegments() {
    var w = W();
    if (!w) return [];
    var stamp = w.seed + ':' + w.settlements.length;
    if (S.roadCache && S.roadStamp === stamp) return S.roadCache;
    var segs = [];
    var forward = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var y = 0; y < w.h; y++) {
      for (var x = 0; x < w.w; x++) {
        var i = w.idx(x, y);
        var level = w.roadAt(i);
        if (!level) continue;
        for (var d = 0; d < forward.length; d++) {
          var ny = y + forward[d][1];
          if (ny < 0 || ny >= w.h) continue;
          var nx = ((x + forward[d][0]) % w.w + w.w) % w.w;
          var j = w.idx(nx, ny);
          var other = w.roadAt(j);
          if (!other) continue;
          segs.push({ x: x, y: y, dx: forward[d][0], dy: forward[d][1], level: Math.min(level, other) });
        }
      }
    }
    S.roadCache = segs;
    S.roadStamp = stamp;
    return segs;
  }

  function draw() {
    var ctx = S.ctx, w = W();
    if (!ctx) return;
    var dpr = root.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S.view.w, S.view.h);
    ctx.fillStyle = '#080b11';
    ctx.fillRect(0, 0, S.view.w, S.view.h);
    if (!w) {
      ctx.fillStyle = '#6c7686';
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No planet has been generated.', S.view.w / 2, S.view.h / 2);
      ctx.textAlign = 'left';
      return;
    }
    drawTiles(ctx, w);
    drawRoads(ctx, w);
    drawCaravans(ctx, w);
    drawSettlements(ctx, w);
    drawColony(ctx, w);
    drawHoverRing(ctx, w);
  }

  function drawTiles(ctx, w) {
    var s = S.cam.scale;
    var halfX = S.view.w / (2 * s), halfY = S.view.h / (2 * s);
    var x0 = Math.floor(S.cam.x - halfX) - 1, x1 = Math.ceil(S.cam.x + halfX) + 1;
    var y0 = Math.max(0, Math.floor(S.cam.y - halfY) - 1);
    var y1 = Math.min(w.h - 1, Math.ceil(S.cam.y + halfY) + 1);
    /* One extra pixel on each rectangle: at fractional scales the gaps
       between them would otherwise show the background through as a
       grid of hairlines. */
    var size = Math.ceil(s) + 1;

    for (var y = y0; y <= y1; y++) {
      var sy = Math.floor(screenY(y) - s / 2);
      for (var x = x0; x <= x1; x++) {
        var wx = ((x % w.w) + w.w) % w.w;
        var i = w.idx(wx, y);
        ctx.fillStyle = tileColour(w, i);
        ctx.fillRect(Math.floor(screenX(x) - s / 2), sy, size, size);
      }
    }
  }

  /* Biome gives the hue; elevation gives the light. Land climbs from a
     dim coast to a pale ridge line, and water darkens with depth, so the
     shape of the continent reads even in a band of one colour. */
  function tileColour(w, i) {
    var def = w.biomeDef(i);
    var base = (def && def.color) || '#4e7a3a';
    var e = w.tiles.elevation[i];
    if (w.isOcean(i)) {
      var depth = U.clamp01((w.SEA_LEVEL - e) / Math.max(0.05, w.SEA_LEVEL));
      return shade(base, 1.18 - depth * 0.62);
    }
    var rise = U.clamp01((e - w.SEA_LEVEL) / Math.max(0.05, 1 - w.SEA_LEVEL));
    var lit = 0.74 + rise * 0.62;
    if (w.tiles.river[i]) lit *= 0.86;
    return shade(base, lit);
  }

  function drawRoads(ctx, w) {
    var segs = roadSegments();
    if (!segs.length || S.cam.scale < 4) return;
    ctx.lineCap = 'round';
    for (var pass = 0; pass < 2; pass++) {
      ctx.strokeStyle = pass === 0 ? 'rgba(40,30,20,0.55)' : '#b9a077';
      ctx.lineWidth = Math.max(1, S.cam.scale * (pass === 0 ? 0.20 : 0.11));
      ctx.beginPath();
      for (var k = 0; k < segs.length; k++) {
        var seg = segs[k];
        var ax = nearestX(seg.x);
        var sx = screenX(ax), sy = screenY(seg.y);
        if (sx < -60 || sx > S.view.w + 60 || sy < -60 || sy > S.view.h + 60) continue;
        ctx.moveTo(sx, sy);
        ctx.lineTo(screenX(ax + seg.dx), screenY(seg.y + seg.dy));
      }
      ctx.stroke();
    }
  }

  function drawSettlements(ctx, w) {
    var list = w.liveSettlements();
    var fac = Fac();
    var s = S.cam.scale;
    var r = U.clamp(s * 0.30, 3, 11);
    ctx.font = Math.max(9, Math.min(13, Math.round(s * 0.62))) + 'px system-ui, sans-serif';
    ctx.textBaseline = 'middle';

    for (var i = 0; i < list.length; i++) {
      var st = list[i];
      var sx = screenX(nearestX(w.xOf(st.tile))), sy = screenY(w.yOf(st.tile));
      if (sx < -80 || sx > S.view.w + 160 || sy < -40 || sy > S.view.h + 40) continue;
      var colour = (fac && fac.colorOf) ? fac.colorOf(st.factionId) : '#c4ccd8';
      var picked = S.sel && S.sel.kind === 'settlement' && S.sel.id === st.id;

      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, 6.283185307179586);
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.lineWidth = picked ? 2.5 : 1.25;
      ctx.strokeStyle = picked ? COLONY_GOLD : 'rgba(10,12,18,0.9)';
      ctx.stroke();

      if (s >= LABEL_SCALE) {
        var name = st.name;
        ctx.fillStyle = 'rgba(8,10,14,0.72)';
        var tw = ctx.measureText(name).width;
        ctx.fillRect(sx + r + 3, sy - 7, tw + 6, 14);
        ctx.fillStyle = '#e8e2d4';
        ctx.fillText(name, sx + r + 6, sy);
      }
    }
    ctx.textBaseline = 'alphabetic';
  }

  function drawColony(ctx, w) {
    var sx = screenX(nearestX(w.xOf(w.colonyTile))), sy = screenY(w.yOf(w.colonyTile));
    var r = U.clamp(S.cam.scale * 0.42, 5, 15);
    /* A diamond, not another dot: on a map of twenty coloured circles
       the one that is yours has to be a different shape. */
    ctx.beginPath();
    ctx.moveTo(sx, sy - r); ctx.lineTo(sx + r, sy);
    ctx.lineTo(sx, sy + r); ctx.lineTo(sx - r, sy);
    ctx.closePath();
    ctx.fillStyle = COLONY_GOLD;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#141821';
    ctx.stroke();
    if (S.cam.scale >= LABEL_SCALE) {
      ctx.font = 'bold ' + Math.max(10, Math.min(14, Math.round(S.cam.scale * 0.66))) + 'px system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#141821';
      var tw = ctx.measureText('Your colony').width;
      ctx.fillRect(sx + r + 3, sy - 8, tw + 6, 16);
      ctx.fillStyle = COLONY_GOLD;
      ctx.fillText('Your colony', sx + r + 6, sy);
      ctx.textBaseline = 'alphabetic';
    }
  }

  /* Where a caravan is between two tiles of its path. The x step is
     taken through wrapDelta so a party crossing the dateline walks one
     tile rather than the width of the planet. */
  function caravanPos(c) {
    var w = W();
    if (!w) return null;
    var path = c.path || [];
    if (!path.length) return { x: w.xOf(c.tile), y: w.yOf(c.tile) };
    var f = U.clamp01(c.progress || 0) * path.length;
    var k = Math.floor(f);
    var t = f - k;
    var a = k <= 0 ? (c.originTile === undefined ? path[0] : c.originTile)
                   : path[Math.min(k, path.length) - 1];
    var b = path[Math.min(k, path.length - 1)];
    var ax = w.xOf(a), ay = w.yOf(a);
    return { x: ax + wrapDelta(w.xOf(b) - ax) * t, y: ay + (w.yOf(b) - ay) * t };
  }

  function drawCaravans(ctx, w) {
    var C = Car();
    if (!C || !C.all || !C.all.length) return;
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < C.all.length; i++) {
      var c = C.all[i];
      var pos = caravanPos(c);
      if (!pos) continue;
      var sx = screenX(nearestX(pos.x)), sy = screenY(pos.y);
      if (sx < -80 || sx > S.view.w + 160 || sy < -40 || sy > S.view.h + 40) continue;

      /* The line behind them is the road still to walk, which is the one
         number a player actually watches. */
      if (c.state === 'travelling' && c.path && c.path.length) {
        ctx.strokeStyle = 'rgba(255,194,60,0.4)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        var prevX = pos.x;
        var from = Math.floor(U.clamp01(c.progress || 0) * c.path.length);
        for (var p = U.clamp(from, 0, c.path.length - 1); p < c.path.length; p++) {
          var px = prevX + wrapDelta(w.xOf(c.path[p]) - prevX);
          ctx.lineTo(screenX(nearestX(px)), screenY(w.yOf(c.path[p])));
          prevX = px;
        }
        ctx.stroke();
        ctx.setLineDash([]);
      }

      var picked = S.sel && S.sel.kind === 'caravan' && S.sel.id === c.id;
      var r = U.clamp(S.cam.scale * 0.22, 3, 8);
      ctx.beginPath();
      ctx.arc(sx, sy, r, 0, 6.283185307179586);
      ctx.fillStyle = c.purpose === 'attack' ? '#c0392b' : '#e8e2d4';
      ctx.fill();
      ctx.lineWidth = picked ? 2.5 : 1.5;
      ctx.strokeStyle = picked ? COLONY_GOLD : '#141821';
      ctx.stroke();

      var label = c.state === 'trading' ? 'at market' : U.fmt(C.daysLeft(c), 1) + 'd';
      ctx.fillStyle = 'rgba(8,10,14,0.75)';
      var tw = ctx.measureText(label).width;
      ctx.fillRect(sx - tw / 2 - 3, sy - r - 16, tw + 6, 13);
      ctx.fillStyle = COLONY_GOLD;
      ctx.textAlign = 'center';
      ctx.fillText(label, sx, sy - r - 9);
      ctx.textAlign = 'left';
    }
    ctx.textBaseline = 'alphabetic';
  }

  function drawHoverRing(ctx, w) {
    if (S.hoverTile < 0) return;
    var s = S.cam.scale;
    var sx = screenX(nearestX(w.xOf(S.hoverTile))), sy = screenY(w.yOf(S.hoverTile));
    ctx.strokeStyle = 'rgba(232,226,212,0.75)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.floor(sx - s / 2) + 0.5, Math.floor(sy - s / 2) + 0.5, Math.round(s) - 1, Math.round(s) - 1);
  }

  /* ------------------------------------------------------------------
     Mouse
     ------------------------------------------------------------------ */

  function localPos(e) {
    var c = S.canvas;
    if (!c || !c.getBoundingClientRect) return { x: 0, y: 0 };
    var r = c.getBoundingClientRect();
    return { x: (e.clientX || 0) - r.left, y: (e.clientY || 0) - r.top };
  }

  function onMouseDown(e) {
    if (!S.open || S.dialog) return;
    if (e.preventDefault) e.preventDefault();
    var p = localPos(e);
    S.drag = { x: p.x, y: p.y, camX: S.cam.x, camY: S.cam.y, moved: 0 };
    if (S.canvas) S.canvas.style.cursor = 'grabbing';
  }

  function onDocMove(e) {
    if (!S.open || !S.drag) return;
    var p = localPos(e);
    var dx = p.x - S.drag.x, dy = p.y - S.drag.y;
    S.drag.moved = Math.max(S.drag.moved, Math.abs(dx) + Math.abs(dy));
    S.cam.x = S.drag.camX - dx / S.cam.scale;
    S.cam.y = S.drag.camY - dy / S.cam.scale;
    clampCam();
  }

  function onDocUp(e) {
    if (!S.open || !S.drag) return;
    var moved = S.drag.moved;
    S.drag = null;
    if (S.canvas) S.canvas.style.cursor = 'grab';
    /* A drag of three pixels is a click with a shaky hand, not a pan. */
    if (moved > 4) return;
    var p = localPos(e);
    if (p.x < 0 || p.y < 0 || p.x > S.view.w || p.y > S.view.h) return;
    pickAt(p.x, p.y);
  }

  function onMouseMove(e) {
    if (!S.open) return;
    var p = localPos(e);
    S.mouse = p;
    S.hoverTile = tileAtScreen(p.x, p.y);
    S.hoverCaravan = caravanAtScreen(p.x, p.y);
    updateTooltip();
  }

  function onMouseLeave() {
    S.hoverTile = -1;
    S.hoverCaravan = null;
    S.mouse = null;
    if (S.tooltip) S.tooltip.style.display = 'none';
  }

  function onWheel(e) {
    if (!S.open || S.dialog) return;
    if (e.preventDefault) e.preventDefault();
    var p = localPos(e);
    var before = {
      x: (p.x - S.view.w / 2) / S.cam.scale + S.cam.x,
      y: (p.y - S.view.h / 2) / S.cam.scale + S.cam.y
    };
    var factor = (e.deltaY || 0) > 0 ? 0.86 : 1.16;
    S.cam.scale = U.clamp(S.cam.scale * factor, MIN_SCALE, MAX_SCALE);
    /* Keep whatever was under the cursor under the cursor. */
    S.cam.x = before.x - (p.x - S.view.w / 2) / S.cam.scale;
    S.cam.y = before.y - (p.y - S.view.h / 2) / S.cam.scale;
    clampCam();
    S.hoverTile = tileAtScreen(p.x, p.y);
    updateTooltip();
  }

  function caravanAtScreen(sx, sy) {
    var C = Car(), w = W();
    if (!C || !w || !C.all) return null;
    var best = null, bestD = 14 * 14;
    for (var i = 0; i < C.all.length; i++) {
      var pos = caravanPos(C.all[i]);
      if (!pos) continue;
      var dx = screenX(nearestX(pos.x)) - sx, dy = screenY(pos.y) - sy;
      var d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = C.all[i]; }
    }
    return best;
  }

  function pickAt(sx, sy) {
    var w = W();
    if (!w) return;
    var car = caravanAtScreen(sx, sy);
    if (car) { S.sel = { kind: 'caravan', id: car.id }; S.sideSig = ''; return; }
    var i = tileAtScreen(sx, sy);
    if (i < 0) { S.sel = null; S.sideSig = ''; return; }
    var st = w.settlementAt(i);
    S.sel = st ? { kind: 'settlement', id: st.id } : { kind: 'tile', tile: i };
    S.sideSig = '';
  }

  /* ------------------------------------------------------------------
     Tooltip
     ------------------------------------------------------------------ */

  function travelDaysFromColony(tile) {
    var w = W();
    if (!w || tile < 0) return null;
    if (w.isOcean(tile)) return null;
    if (!w.reachableByLand(w.colonyTile, tile)) return null;
    return w.travelTicks(w.colonyTile, tile, 1) / TICKS_PER_DAY;
  }

  function updateTooltip() {
    var tip = S.tooltip, w = W();
    if (!tip) return;
    if (!w || S.hoverTile < 0 || !S.mouse || S.dialog) { tip.style.display = 'none'; return; }
    clear(tip);

    if (S.hoverCaravan) {
      var C = Car();
      tip.appendChild(el('div', 'gold', S.hoverCaravan.label || 'Caravan'));
      tip.appendChild(el('div', 'dim', C.describe(S.hoverCaravan)));
      tip.appendChild(el('div', 'faint', 'click for the party and its cargo'));
    } else {
      var i = S.hoverTile;
      var def = w.biomeDef(i);
      var st = w.settlementAt(i);
      if (st) {
        var fac = Fac();
        var f = fac && fac.ofSettlement ? fac.ofSettlement(st) : null;
        tip.appendChild(el('div', 'gold', st.name));
        tip.appendChild(el('div', 'dim', (f ? f.name : 'unclaimed') + ' · ' + st.kind));
      }
      tip.appendChild(el('div', '', U.cap((def && def.label) || 'unknown')));
      var facts = el('div', 'dim', tempStr(w.seasonalTemp(i)) + ' · ' +
        Math.round(w.rainfallMm(i)) + 'mm · ' + w.season(i));
      tip.appendChild(facts);
      tip.appendChild(el('div', w.isHabitable(i) ? 'good' : 'bad',
        w.isOcean(i) ? 'open water - nothing crosses it'
                     : (w.isHabitable(i) ? 'habitable' : 'not habitable')));
      if (i === w.colonyTile) {
        tip.appendChild(el('div', 'gold', 'your colony stands here'));
      } else {
        var d = travelDaysFromColony(i);
        tip.appendChild(el('div', d === null ? 'bad' : '',
          d === null ? 'no land route from the colony' : days(d) + ' out on foot'));
      }
      if (w.roadAt(i)) tip.appendChild(el('div', 'faint', w.roadAt(i) > 1 ? 'highway' : 'road'));
    }

    tip.style.display = 'block';
    var x = S.mouse.x + 16, y = S.mouse.y + 14;
    if (x > S.view.w - 250) x = Math.max(4, S.mouse.x - 250);
    if (y > S.view.h - 120) y = Math.max(4, S.mouse.y - 120);
    tip.style.left = Math.round(x) + 'px';
    tip.style.top = Math.round(y) + 'px';
  }

  /* ------------------------------------------------------------------
     The side column: what is selected, then every civilization
     ------------------------------------------------------------------ */

  function sideSignature() {
    var w = W(), C = Car(), fac = Fac();
    var s = (S.sel ? S.sel.kind + (S.sel.id || S.sel.tile) : '-') + '|';
    if (C && C.all) {
      for (var i = 0; i < C.all.length; i++) {
        s += C.all[i].id + ':' + C.all[i].state + ':' + Math.round(C.daysLeft(C.all[i]) * 4) + ';';
      }
    }
    if (fac && fac.all) {
      var list = fac.all();
      for (var f = 0; f < list.length; f++) {
        s += list[f].id + ':' + Math.round(list[f].goodwill) + ':' + list[f].history.length + ';';
      }
    }
    var T = Trd();
    if (T && T.visitors) s += 'v' + T.visitors.length;
    if (w) s += '|s' + w.settlements.length;
    return s;
  }

  function sectionHead(text) {
    var h = el('div', 'head', text);
    style(h, { padding: '6px 9px 3px', borderTop: '1px solid var(--line-soft)' });
    return h;
  }

  function renderSide() {
    var side = S.side;
    if (!side) return;
    clear(side);

    var top = el('div', 'wv-sel');
    style(top, { padding: '8px 9px', borderBottom: '1px solid var(--line)', maxHeight: '52%', overflowY: 'auto' });
    renderSelection(top);
    side.appendChild(top);

    var bottom = el('div', 'wv-factions');
    style(bottom, { flex: '1', minHeight: '0', overflowY: 'auto', padding: '0 0 8px' });
    renderFactions(bottom);
    side.appendChild(bottom);
  }

  function renderSelection(box) {
    var w = W();
    if (!w) {
      box.appendChild(el('div', 'dim', 'There is no planet loaded. Start a colony first.'));
      return;
    }
    if (S.sel && S.sel.kind === 'settlement') {
      var st = w.settlementById(S.sel.id);
      if (st && !st.destroyed) return renderSettlement(box, st);
    }
    if (S.sel && S.sel.kind === 'caravan') {
      var C = Car();
      var c = C && C.all.filter(function (x) { return x.id === S.sel.id; })[0];
      if (c) return renderCaravan(box, c);
    }
    if (S.sel && S.sel.kind === 'tile') return renderTile(box, S.sel.tile);
    return renderOverview(box);
  }

  function renderOverview(box) {
    var w = W(), C = Car(), T = Trd();
    box.appendChild(el('div', 'ins-title', 'The planet'));
    box.appendChild(el('div', 'ins-sub', w.w + ' x ' + w.h + ' tiles, wrapping east to west'));
    row(box, 'Your tile', U.cap(w.biomeDef(w.colonyTile).label));
    row(box, 'Settlements', String(w.liveSettlements().length));
    row(box, 'Caravans out', String(C ? C.all.length : 0));

    var visitors = T && T.visiting ? T.visiting().filter(function (v) {
      return v.phase !== 'leaving' && !v.angered;
    }) : [];
    if (visitors.length) {
      box.appendChild(el('div', 'head', 'Traders on your land'));
      visitors.forEach(function (v) {
        var line = el('div', 'line');
        var kindLabel = (v.traderKind && v.traderKind.label) || 'trader';
        line.appendChild(el('span', '', kindLabel + ' of ' + v.factionName + ' '));
        line.appendChild(btn('Trade', 'mini', function () { openTradeWithVisitor(v); }));
        box.appendChild(line);
      });
    }
    box.appendChild(el('div', 'faint',
      'Click a settlement to deal with it, a caravan to see the party, or any tile to send one out.'));
  }

  function renderTile(box, tile) {
    var w = W();
    var def = w.biomeDef(tile);
    box.appendChild(el('div', 'ins-title', U.cap(def.label)));
    box.appendChild(el('div', 'ins-sub', 'tile ' + w.xOf(tile) + ', ' + w.yOf(tile)));
    if (def.description) {
      var d = el('div', 'dim', def.description);
      style(d, { margin: '4px 0' });
      box.appendChild(d);
    }
    row(box, 'Temperature', tempStr(w.seasonalTemp(tile)));
    row(box, 'Rainfall', Math.round(w.rainfallMm(tile)) + 'mm');
    row(box, 'Season', w.season(tile));
    row(box, 'Habitable', w.isHabitable(tile) ? 'yes' : 'no',
      w.isHabitable(tile) ? 'good' : 'bad');
    var travel = travelDaysFromColony(tile);
    row(box, 'Travel', travel === null ? 'no land route' : days(travel) + ' each way',
      travel === null ? 'bad' : '');
    if (tile !== w.colonyTile && travel !== null) {
      var b = btn('Send a caravan here', '', function () { openCaravanDialog(tile, 'visit'); });
      style(b, { marginTop: '6px' });
      box.appendChild(b);
    }
  }

  function renderSettlement(box, st) {
    var w = W(), fac = Fac(), C = Car();
    var f = fac && fac.ofSettlement ? fac.ofSettlement(st) : null;
    var kindDef = root.Defs && root.Defs.maybe ? root.Defs.maybe('settlementKind', st.kind) : null;

    box.appendChild(el('div', 'ins-title', st.name));
    box.appendChild(el('div', 'ins-sub', ((kindDef && kindDef.label) || st.kind) +
      (f ? ' of ' + f.name : '')));

    if (f) {
      row(box, 'Leader', (f.leaderTitle ? f.leaderTitle + ' ' : '') + f.leaderName);
      row(box, 'Tech level', f.techLevel);
      var gw = Math.round(f.goodwill);
      row(box, 'Goodwill', gw + ' (' + fac.goodwillLabel(gw) + ')',
        f.hostile ? 'bad' : (f.allied ? 'good' : ''));
      box.appendChild(goodwillBar(gw));
    }
    var travel = travelDaysFromColony(st.tile);
    row(box, 'Travel', travel === null ? 'no land route' : days(travel) + ' each way',
      travel === null ? 'bad' : '');
    row(box, 'Wealth', Math.round(st.wealth) + ' silver');

    var cats = (kindDef && kindDef.stockCategories) || [];
    row(box, 'Trades', cats.length ? cats.join(', ') : 'nothing worth a counter');
    if (kindDef && kindDef.canTradeWith === false) {
      box.appendChild(el('div', 'bad', 'This place has no market. They will not deal with you.'));
    }

    var here = C && C.forSettlement ? C.forSettlement(st) : null;
    var actions = el('div', '');
    style(actions, { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '7px' });

    if (here) {
      actions.appendChild(btn('Trade', '', function () { openTradeWithCaravan(here); }));
      actions.appendChild(btn('Send them home', 'mini', function () {
        if (C.sendHome) { C.sendHome(here); S.sideSig = ''; }
      }));
    } else if (travel !== null && st.tile !== w.colonyTile) {
      actions.appendChild(btn('Form caravan here', '', function () {
        openCaravanDialog(st.tile, 'trade');
      }));
      actions.appendChild(btn('Attack', 'bad', function () { confirmAttack(st); }));
    }
    box.appendChild(actions);
  }

  function renderCaravan(box, c) {
    var C = Car();
    box.appendChild(el('div', 'ins-title', c.label || 'Caravan'));
    box.appendChild(el('div', 'ins-sub', C.describe(c)));

    row(box, 'People', c.pawns.map(nameOf).join(', ') || 'nobody');
    row(box, 'Carrying', U.fmt(c.mass, 0) + ' kg of ' + U.fmt(C.freeMass(c) + c.mass, 0) + ' kg');
    var foodDays = c.pawns.length ? c.food / (c.pawns.length * 1.6) : 0;
    row(box, 'Food', U.fmt(c.food, 1) + ' nutrition (' + days(foodDays) + ')',
      foodDays < 1 ? 'bad' : (foodDays < 2.5 ? 'warn' : 'good'));
    if (c.state === 'travelling') row(box, 'Arrives in', days(C.daysLeft(c)));

    var goods = C.goods(c);
    if (goods.length) {
      box.appendChild(el('div', 'head', 'Cargo'));
      goods.forEach(function (g) {
        box.appendChild(el('div', 'line', labelOf(g.defId) + ' x' + g.count));
      });
    } else {
      box.appendChild(el('div', 'faint', 'They are carrying nothing.'));
    }

    var actions = el('div', '');
    style(actions, { display: 'flex', flexWrap: 'wrap', gap: '4px', marginTop: '7px' });
    if (c.state === 'trading') {
      actions.appendChild(btn('Trade', '', function () { openTradeWithCaravan(c); }));
    }
    if (c.purpose !== 'return' || c.state === 'trading') {
      actions.appendChild(btn('Recall', '', function () {
        if (C.recall(c)) { S.sideSig = ''; say('The party is turning for home.'); }
      }));
    }
    box.appendChild(actions);
  }

  function renderFactions(box) {
    var fac = Fac();
    box.appendChild(sectionHead('Civilizations'));
    if (!fac || !fac.relationsSummary) {
      box.appendChild(el('div', 'faint', 'No civilizations are loaded.'));
      return;
    }
    var rows = fac.relationsSummary();
    if (!rows.length) {
      box.appendChild(el('div', 'faint', 'This planet has nobody else on it.'));
      return;
    }
    rows.forEach(function (r) {
      var card = el('div', 'wv-fac');
      style(card, {
        margin: '4px 7px', padding: '5px 7px', background: 'var(--bg2)',
        borderLeft: '3px solid ' + r.color, border: '1px solid var(--line-soft)'
      });
      var title = el('div', '');
      style(title, { display: 'flex', alignItems: 'baseline', gap: '5px' });
      var nm = el('span', '', r.name);
      style(nm, { fontWeight: '600' });
      title.appendChild(nm);
      title.appendChild(el('span', r.hostile ? 'bad' : (r.allied ? 'good' : 'dim'),
        r.hostile ? 'AT WAR' : (r.allied ? 'ALLIED' : r.standing)));
      card.appendChild(title);
      card.appendChild(el('div', 'faint', r.kindLabel + ' · ' + r.techLevel + ' · ' +
        r.settlementCount + ' ' + U.plural(r.settlementCount, 'settlement')));
      card.appendChild(el('div', 'dim', r.leader));
      card.appendChild(goodwillBar(r.goodwill));
      card.appendChild(el('div', 'faint', 'goodwill ' + r.goodwill +
        (r.permanentEnemy ? ' — they will never talk' : '')));

      if (r.history.length) {
        var hist = el('div', '');
        style(hist, { marginTop: '3px' });
        r.history.forEach(function (h) {
          var line = el('div', 'faint', U.signed(h.delta, 1) + '  ' + h.reason);
          style(line, { fontSize: '10px' });
          hist.appendChild(line);
        });
        card.appendChild(hist);
      }

      if (r.offer && !r.offer.resolved) {
        var offer = el('div', '');
        style(offer, { marginTop: '5px', display: 'flex', gap: '4px', alignItems: 'center' });
        offer.appendChild(el('span', 'gold', offerText(r.offer)));
        offer.appendChild(btn('Accept', 'mini', function () {
          fac.respond(r.offer.id, true); S.sideSig = '';
        }));
        offer.appendChild(btn('Refuse', 'mini bad', function () {
          fac.respond(r.offer.id, false); S.sideSig = '';
        }));
        card.appendChild(offer);
      }
      box.appendChild(card);
    });
  }

  function offerText(offer) {
    if (offer.type === 'peace') return 'offers peace';
    if (offer.type === 'alliance') return 'offers an alliance';
    if (offer.type === 'tribute') return 'demands ' + offer.silver + ' silver';
    return 'wants an answer';
  }

  /* ------------------------------------------------------------------
     Dialog plumbing

     Every dialog is a box inside the map area, so escape closes it
     without touching ui.js's #modal and closing the screen mid-dialog
     leaves nothing behind.
     ------------------------------------------------------------------ */

  function closeDialog() {
    S.dialog = null;
    if (S.dialogLayer) {
      clear(S.dialogLayer);
      S.dialogLayer.style.display = 'none';
    }
  }

  function dialogBox(title, widthPx) {
    var layer = S.dialogLayer;
    clear(layer);
    layer.style.display = 'flex';
    var box = el('div', 'wv-dialog');
    style(box, {
      width: (widthPx || 760) + 'px', maxWidth: '100%', maxHeight: '100%',
      display: 'flex', flexDirection: 'column', minHeight: '0',
      background: 'var(--bg1)', border: '1px solid var(--line)',
      borderTop: '2px solid var(--accent)', boxShadow: 'var(--panel-shadow)'
    });
    var head = el('div', 'tp-head');
    head.appendChild(el('div', 'tp-title', title));
    head.appendChild(btn('Close', 'tp-close', closeDialog));
    box.appendChild(head);
    layer.appendChild(box);
    return box;
  }

  function confirmAttack(st) {
    var fac = Fac();
    var f = fac && fac.ofSettlement ? fac.ofSettlement(st) : null;
    var box = dialogBox('Attack ' + st.name + '?', 480);
    S.dialog = { kind: 'confirm' };
    var body = el('div', 'tp-body');
    var p = el('div', '', 'A war party has to walk there, fight whoever is holding the place, ' +
      'and walk home with whatever it can carry. People will die.');
    style(p, { marginBottom: '8px', lineHeight: '1.5' });
    body.appendChild(p);
    if (f) {
      body.appendChild(el('div', 'bad', 'This puts you at war with ' + f.name +
        ', and war with them does not end because you want it to.'));
    }
    var actions = el('div', '');
    style(actions, { display: 'flex', justifyContent: 'flex-end', gap: '6px', marginTop: '14px' });
    actions.appendChild(btn('Never mind', '', closeDialog));
    actions.appendChild(btn('Raise a war party', 'bad', function () {
      openCaravanDialog(st.tile, 'attack');
    }));
    body.appendChild(actions);
    box.appendChild(body);
  }

  /* ------------------------------------------------------------------
     The caravan dialog
     ------------------------------------------------------------------ */

  /* What the colony could actually pack. caravan.js takes cargo off the
     floor with map.byDef and no regard for stockpiles, so counting the
     same way is the only honest number to show. */
  function colonyStock(map) {
    var out = [];
    var Z = root.Zones;
    var defs = root.Defs.items();
    for (var d = 0; d < defs.length; d++) {
      var def = defs[d];
      var cat = Z && Z.categoryOf ? Z.categoryOf(def) : (def.id === 'corpse' ? 'corpses' : 'resources');
      if (!cat || cat === 'corpses') continue;
      var list = map.byDef(def.id), n = 0;
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t || !t.spawned || t.isBlueprint || t.isFrame) continue;
        n += t.stack === undefined ? 1 : t.stack;
      }
      if (n > 0) out.push({ def: def, defId: def.id, have: n, category: cat });
    }
    out.sort(function (a, b) {
      return a.category === b.category ? (a.def.label < b.def.label ? -1 : 1)
                                       : (a.category < b.category ? -1 : 1);
    });
    return out;
  }

  function travellerCandidates(map) {
    var out = [];
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (p.dead || p.faction !== 'player') continue;
      if (p.isAnimal && !p.tame) continue;
      if (!p.isHuman && !p.isAnimal) continue;
      if (p.prisoner) continue;
      out.push(p);
    }
    out.sort(function (a, b) { return (a.isHuman ? 0 : 1) - (b.isHuman ? 0 : 1); });
    return out;
  }

  function blockedReason(p) {
    if (p.downed || (root.Health && root.Health.isDowned && root.Health.isDowned(p))) return 'downed';
    if (p.drafted) return 'drafted';
    if (p.mentalState) return 'not in their right mind';
    return null;
  }

  function openCaravanDialog(tile, purpose, keep) {
    var w = W(), g = G();
    if (!w || !g || !g.map) return;
    var d = {
      kind: 'caravan', tile: tile, purpose: purpose || 'trade',
      chosen: (keep && keep.chosen) || new Set(),
      goods: (keep && keep.goods) || Object.create(null),
      stock: colonyStock(g.map), pawns: travellerCandidates(g.map),
      readout: null, launch: null, launchNote: null
    };
    S.dialog = d;

    var st = w.settlementAt(tile);
    var box = dialogBox('Form a caravan to ' + (st ? st.name : 'tile ' + w.xOf(tile) + ',' + w.yOf(tile)), 860);
    var body = el('div', 'tp-body');
    style(body, { display: 'flex', flexDirection: 'column', minHeight: '0' });

    var purposes = el('div', '');
    style(purposes, { display: 'flex', gap: '4px', alignItems: 'center', marginBottom: '8px' });
    purposes.appendChild(el('span', 'dim', 'Purpose'));
    [['trade', 'Trade'], ['visit', 'Visit'], ['attack', 'Attack']].forEach(function (pair) {
      var b = btn(pair[1], d.purpose === pair[0] ? 'on' : '', function () {
        openCaravanDialog(d.tile, pair[0], d);
      });
      purposes.appendChild(b);
    });
    body.appendChild(purposes);

    var cols = el('div', '');
    style(cols, { display: 'flex', gap: '12px', flex: '1', minHeight: '0' });
    var left = el('div', '');
    style(left, { flex: '1', minWidth: '0', overflowY: 'auto', borderRight: '1px solid var(--line-soft)', paddingRight: '8px' });
    var right = el('div', '');
    style(right, { flex: '1.25', minWidth: '0', overflowY: 'auto' });
    cols.appendChild(left);
    cols.appendChild(right);
    body.appendChild(cols);

    buildTravellerColumn(d, left);
    buildGoodsColumn(d, right);

    var foot = el('div', '');
    style(foot, {
      borderTop: '1px solid var(--line)', marginTop: '8px', paddingTop: '8px',
      display: 'flex', alignItems: 'flex-start', gap: '12px'
    });
    d.readout = el('div', '');
    style(d.readout, { flex: '1', minWidth: '0', lineHeight: '1.5' });
    foot.appendChild(d.readout);

    var launchWrap = el('div', '');
    style(launchWrap, { textAlign: 'right', flex: 'none' });
    d.launch = btn('Launch', 'big-btn primary', function () { launchCaravan(d); });
    d.launchNote = el('div', 'faint', '');
    style(d.launchNote, { maxWidth: '260px', marginTop: '4px' });
    launchWrap.appendChild(d.launch);
    launchWrap.appendChild(d.launchNote);
    foot.appendChild(launchWrap);
    body.appendChild(foot);

    box.appendChild(body);
    refreshCaravanReadout(d);
  }

  function buildTravellerColumn(d, box) {
    box.appendChild(el('div', 'head', 'Who goes'));
    if (!d.pawns.length) {
      box.appendChild(el('div', 'faint', 'There is nobody to send.'));
      return;
    }
    d.pawns.forEach(function (p) {
      var reason = blockedReason(p);
      var line = el('label', '');
      style(line, {
        display: 'flex', alignItems: 'center', gap: '6px', padding: '3px 2px',
        borderBottom: '1px solid var(--line-soft)',
        opacity: reason ? '0.42' : '1', cursor: reason ? 'not-allowed' : 'pointer'
      });
      var cb = el('input', '');
      cb.type = 'checkbox';
      cb.disabled = !!reason;
      cb.checked = d.chosen.has(p);
      cb.addEventListener('change', function () {
        if (cb.checked) d.chosen.add(p); else d.chosen.delete(p);
        refreshCaravanReadout(d);
      });
      line.appendChild(cb);

      var body = el('div', '');
      style(body, { flex: '1', minWidth: '0' });
      body.appendChild(el('div', '', nameOf(p)));
      var sub = p.isAnimal ? ((p.kind && p.kind.label) || 'pack animal')
        : (root.Health && root.Health.summary ? root.Health.summary(p) : 'colonist');
      body.appendChild(el('div', 'faint', (reason ? reason + ' · ' : '') + sub +
        ' · carries ' + U.fmt(p.carryCapacity === undefined ? 35 : p.carryCapacity, 0) + ' kg'));
      line.appendChild(body);
      box.appendChild(line);
    });
  }

  function buildGoodsColumn(d, box) {
    var head = el('div', '');
    style(head, { display: 'flex', alignItems: 'baseline', gap: '6px' });
    head.appendChild(el('div', 'head', 'What they carry'));
    head.appendChild(btn('Clear', 'mini', function () {
      d.goods = Object.create(null);
      rebuildGoodsRows(d);
      refreshCaravanReadout(d);
    }));
    box.appendChild(head);

    d.goodsBox = el('div', '');
    box.appendChild(d.goodsBox);
    rebuildGoodsRows(d);
  }

  function rebuildGoodsRows(d) {
    var box = d.goodsBox;
    if (!box) return;
    clear(box);
    if (!d.stock.length) {
      box.appendChild(el('div', 'faint', 'The colony has nothing loose to pack.'));
      return;
    }
    var lastCat = null;
    d.stock.forEach(function (item) {
      if (item.category !== lastCat) {
        lastCat = item.category;
        var h = el('div', 'faint', item.category);
        style(h, { marginTop: '5px', textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '10px' });
        box.appendChild(h);
      }
      box.appendChild(goodsRow(d, item));
    });
  }

  function goodsRow(d, item) {
    var line = el('div', '');
    style(line, {
      display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 0',
      borderBottom: '1px solid var(--line-soft)'
    });
    var name = el('div', '');
    style(name, { flex: '1', minWidth: '0' });
    name.appendChild(el('span', '', item.def.label));
    name.appendChild(el('span', 'faint', '  ' + item.have + ' in store'));
    line.appendChild(name);

    var amount = el('div', '');
    style(amount, { width: '46px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' });
    line.appendChild(amount);

    function set(n, quiet) {
      n = U.clamp(Math.round(n), 0, item.have);
      if (n > 0) d.goods[item.defId] = n; else delete d.goods[item.defId];
      amount.textContent = String(n);
      amount.className = n > 0 ? 'gold' : 'faint';
      if (!quiet) refreshCaravanReadout(d);
    }
    function step(delta) { set((d.goods[item.defId] || 0) + delta); }

    [['-10', -10], ['-1', -1], ['+1', 1], ['+10', 10]].forEach(function (pair) {
      var b = btn(pair[0], 'mini', function () { step(pair[1]); });
      line.appendChild(b);
    });
    line.appendChild(btn('all', 'mini', function () { set(item.have); }));
    set(d.goods[item.defId] || 0, true);
    return line;
  }

  function dialogItems(d) {
    var out = [];
    for (var id in d.goods) if (d.goods[id] > 0) out.push({ defId: id, count: d.goods[id] });
    return out;
  }

  function refreshCaravanReadout(d) {
    if (!d.readout || !d.launch) return;
    var C = Car();
    var pawns = [];
    d.chosen.forEach(function (p) { pawns.push(p); });
    var items = dialogItems(d);
    var plan = C.plan(pawns, items, d.tile);

    clear(d.readout);
    row(d.readout, 'Party', pawns.length ? pawns.map(nameOf).join(', ') : 'nobody yet');
    row(d.readout, 'Load', U.fmt(plan.load, 1) + ' kg of ' + U.fmt(plan.capacity, 0) + ' kg',
      plan.load > plan.capacity ? 'bad' : '');
    row(d.readout, 'Travel', days(plan.days) + ' each way, at ' + U.fmt(plan.speed, 2) + 'x pace');
    var short = plan.nutrition < plan.nutritionNeeded;
    row(d.readout, 'Food', U.fmt(plan.nutrition, 1) + ' packed of ' +
      U.fmt(plan.nutritionNeeded, 1) + ' needed there and back',
      plan.nutrition <= 0 ? 'bad' : (short ? 'warn' : 'good'));
    row(d.readout, 'Cargo value', Math.round(plan.value) + ' silver');
    if (short && plan.nutrition > 0) {
      d.readout.appendChild(el('div', 'warn',
        'They can reach it, but not get home on what is packed.'));
    }

    var ok = plan.check.ok;
    d.launch.disabled = !ok;
    if (d.launch.classList) d.launch.classList.toggle('off', !ok);
    d.launch.textContent = d.purpose === 'attack' ? 'March' : 'Launch';
    d.launchNote.textContent = ok
      ? (d.purpose === 'attack' ? 'They will fight when they arrive.' : 'Ready to leave.')
      : plan.check.reason;
    d.launchNote.className = ok ? 'faint' : 'bad';
  }

  function launchCaravan(d) {
    var C = Car();
    var pawns = [];
    d.chosen.forEach(function (p) { pawns.push(p); });
    var caravan = C.form({
      pawns: pawns, items: dialogItems(d),
      destinationTile: d.tile, purpose: d.purpose
    });
    if (!caravan) { refreshCaravanReadout(d); return; }
    closeDialog();
    S.sel = { kind: 'caravan', id: caravan.id };
    S.sideSig = '';
    say((caravan.label || 'The caravan') + ' has left.');
  }

  /* ------------------------------------------------------------------
     The trade dialog
     ------------------------------------------------------------------ */

  function openTradeWithCaravan(c) {
    var C = Car();
    var deal = C && C.deal ? C.deal(c) : null;
    if (!deal) { say('There is no counter open there.'); return; }
    openTradeDialog(deal, deal.partnerLabel || 'the market');
  }

  function openTradeWithVisitor(v) {
    var T = Trd(), g = G();
    if (!T || !g) return;
    var check = T.canOpen(v);
    if (!check.ok) { say('They will not trade: ' + check.reason + '.'); return; }
    var deal = T.open(v, { map: g.map });
    if (!deal) { say('They will not trade.'); return; }
    openTradeDialog(deal, deal.partnerLabel || v.factionName);
  }

  function openTradeDialog(deal, title) {
    var d = { kind: 'trade', deal: deal, balanceEl: null, errorEl: null, rowsBox: null };
    S.dialog = d;
    var box = dialogBox('Trading with ' + title, 900);
    var body = el('div', 'tp-body');
    style(body, { display: 'flex', flexDirection: 'column', minHeight: '0' });

    var sub = el('div', 'dim', ((deal.traderKind && deal.traderKind.label) || 'trader') +
      ' · negotiator ' + (deal.negotiator ? nameOf(deal.negotiator) : 'nobody') +
      ' (social ' + U.fmt(deal.socialSkill, 0) + ')');
    style(sub, { marginBottom: '6px' });
    body.appendChild(sub);
    if (deal.note) body.appendChild(el('div', 'warn', deal.note));

    d.rowsBox = el('div', '');
    style(d.rowsBox, { display: 'flex', gap: '12px', flex: '1', minHeight: '0' });
    body.appendChild(d.rowsBox);

    var foot = el('div', '');
    style(foot, {
      borderTop: '1px solid var(--line)', marginTop: '8px', paddingTop: '8px',
      display: 'flex', alignItems: 'center', gap: '12px'
    });
    d.balanceEl = el('div', '');
    style(d.balanceEl, { flex: '1', minWidth: '0', lineHeight: '1.5' });
    foot.appendChild(d.balanceEl);
    d.errorEl = el('div', 'bad', '');
    style(d.errorEl, { flex: 'none', maxWidth: '240px' });
    foot.appendChild(d.errorEl);
    foot.appendChild(btn('Cancel', '', closeDialog));
    foot.appendChild(btn('Confirm', 'big-btn primary', function () { confirmTrade(d); }));
    body.appendChild(foot);

    box.appendChild(body);
    buildTradeRows(d);
  }

  function buildTradeRows(d) {
    var deal = d.deal;
    clear(d.rowsBox);
    d.rowsBox.appendChild(tradeColumn(d, 'They are selling', deal.theirStock, 1));
    d.rowsBox.appendChild(tradeColumn(d, 'You are selling', deal.ourGoods, -1));
    refreshTradeFooter(d);
  }

  function tradeColumn(d, title, rows, sign) {
    var col = el('div', '');
    style(col, { flex: '1', minWidth: '0', overflowY: 'auto' });
    col.appendChild(el('div', 'head', title));
    if (!rows.length) {
      col.appendChild(el('div', 'faint', sign > 0 ? 'Their counter is empty.'
        : 'You have nothing here they want.'));
      return col;
    }
    rows.forEach(function (r) { col.appendChild(tradeRow(d, r, sign)); });
    return col;
  }

  function tradeRow(d, r, sign) {
    var deal = d.deal;
    var line = el('div', '');
    style(line, {
      display: 'flex', alignItems: 'center', gap: '4px', padding: '2px 0',
      borderBottom: '1px solid var(--line-soft)'
    });
    var name = el('div', '');
    style(name, { flex: '1', minWidth: '0' });
    name.appendChild(el('span', '', r.label));
    name.appendChild(el('span', 'faint', '  x' + r.count));
    line.appendChild(name);

    var price = el('div', 'gold', r.price + 's');
    style(price, { width: '52px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' });
    line.appendChild(price);

    var amount = el('div', '');
    style(amount, { width: '42px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' });
    line.appendChild(amount);

    function show() {
      var n = Math.abs(deal.basket[r.defId] || 0);
      amount.textContent = n ? String(n) : '-';
      amount.className = n ? (sign > 0 ? 'good' : 'warn') : 'faint';
    }
    function step(delta) {
      var T = Trd();
      deal.error = null;
      if (sign > 0) T.buy(deal, r.defId, delta); else T.sell(deal, r.defId, delta);
      show();
      refreshTradeFooter(d);
    }

    [['-10', -10], ['-1', -1], ['+1', 1], ['+10', 10]].forEach(function (pair) {
      line.appendChild(btn(pair[0], 'mini', function () { step(pair[1]); }));
    });
    line.appendChild(btn('all', 'mini', function () { step(r.count); }));
    show();
    return line;
  }

  function refreshTradeFooter(d) {
    var deal = d.deal, T = Trd();
    T.recalc(deal);
    var summary = T.basketSummary(deal);
    var owed = deal.balance;
    clear(d.balanceEl);
    row(d.balanceEl, 'Basket', summary.bought + ' bought, ' + summary.sold + ' sold');
    var cannotPay = owed > 0 && deal.ourSilver < owed;
    var theyCannotPay = owed < 0 && deal.theirSilver < -owed;
    row(d.balanceEl, 'Balance',
      owed > 0 ? ('you pay ' + owed + ' silver')
        : (owed < 0 ? ('they pay ' + (-owed) + ' silver') : 'even'),
      (cannotPay || theyCannotPay) ? 'bad' : (owed <= 0 ? 'good' : ''));
    row(d.balanceEl, 'Silver', 'yours ' + deal.ourSilver + ' · theirs ' + deal.theirSilver);
    d.errorEl.textContent = deal.error ? U.cap(deal.error) : '';
  }

  function confirmTrade(d) {
    var T = Trd();
    var before = T.basketSummary(d.deal);
    if (T.confirm(d.deal)) {
      say('Deal done: ' + before.bought + ' bought, ' + before.sold + ' sold.');
      buildTradeRows(d);
      S.sideSig = '';
    } else {
      refreshTradeFooter(d);
    }
  }

  /* ------------------------------------------------------------------
     The frame

     main.js does not know about this file, so the screen drives its own
     animation frame while it is open and stops the moment it closes.
     ------------------------------------------------------------------ */

  function requestFrame() {
    if (!S.open || !root.requestAnimationFrame) return;
    root.requestAnimationFrame(function () {
      if (!S.open) return;
      WorldView.update();
      requestFrame();
    });
  }

  WorldView.update = function () {
    if (!S.open) return;
    /* ui.js may have reclaimed #tab-panel for one of its own tabs while
       this was up. Whoever asked for that wins; the world screen lets go
       rather than fighting for the node. */
    var panel = doc && doc.getElementById('tab-panel');
    if (!panel || !S.root || S.root.parentNode !== panel) {
      S.open = false;
      S.dialog = null;
      S.root = S.canvas = S.ctx = S.side = S.tooltip = S.dialogLayer = S.mapWrap = null;
      return;
    }
    S.frame++;
    resize();
    draw();
    /* The side column holds live buttons, so it is rebuilt only when
       something it shows has actually changed. */
    if (S.frame % 6 === 0 || S.sideSig === '') {
      var sig = sideSignature();
      if (sig !== S.sideSig) { S.sideSig = sig; renderSide(); }
    }
    /* A caravan dialog left open while the colony is running is looking
       at a larder that moves, so its numbers are re-read on a slow beat. */
    if (S.dialog && S.dialog.kind === 'caravan' && S.frame % 30 === 0) {
      refreshCaravanReadout(S.dialog);
    }
  };

  /* Registered at load rather than on the first open: the shift+W key has
     to work before anyone has found the button in the top bar. */
  WorldView.init();

  root.WorldView = WorldView;
})(this);
