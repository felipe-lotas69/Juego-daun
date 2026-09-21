/* ============================================================
   particles.js - smoke, sparks, blood, weather and floating text.

   Decoration, and only decoration. Nothing in this file writes to
   the simulation: it watches the world through read-only glances -
   fires burning, bullets leaving a muzzle, a pawn taking a wound,
   boots on wet ground - and turns what it sees into motes. Pause
   the game and the picture holds still, because a paused colony
   that keeps raining is a colony that is still running.

   Three decisions shape the file.

   1. Storage is a compact set of parallel typed arrays, not an
      array of objects. A firefight under a snowstorm is a few
      thousand particles a second, and an object per particle buys
      a garbage pause every few seconds - exactly the stutter that
      makes a browser game feel cheap. Dead slots are recycled by
      swapping the last live particle down into the hole, so the
      live set stays dense and a tick over an empty pool is a
      single comparison.

   2. Sprites are painted once, at init, into offscreen canvases -
      soft lumpy gradient puffs, glows, flakes, shards, leaves,
      flame tongues - and every frame afterwards is drawImage.
      Per-particle path work is reserved for shapes that genuinely
      change every frame: rain streaks and spark trails.

   3. Weather is screen space. Its cost follows the size of the
      window rather than the size of the map, and it reads the same
      whether the camera is close in or pulled right out.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Particles = {};

  var MAX = 4000;                /* hard cap on live particles */
  var TAU = Math.PI * 2;
  var FONT = '600 %px system-ui, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  /* Kinds. The numbers are the bucket order used by the draw pass, so
     anything added here also needs a slot in DRAW_ORDER below. */
  var K = {
    SMOKE: 0, FOG: 1, DUST: 2, SPLASH: 3, BLOOD: 4, CHIP: 5, LEAF: 6,
    EXPLOSION: 7, FIRE: 8, EMBER: 9, SPARK: 10, MUZZLE: 11,
    RAIN: 12, SNOW: 13, MOTE: 14
  };
  var KINDS = 15;
  Particles.K = K;

  /* Every name the rest of the game is allowed to spawn by, including the
     synonyms that read better at a call site ('blood', 'flame', 'text'). */
  var NAMES = {
    smoke: K.SMOKE, fog: K.FOG, dust: K.DUST, splash: K.SPLASH,
    blood: K.BLOOD, bloodDrop: K.BLOOD, chip: K.CHIP, debris: K.CHIP,
    leaf: K.LEAF, explosion: K.EXPLOSION, fire: K.FIRE, fireTongue: K.FIRE,
    flame: K.FIRE, ember: K.EMBER, spark: K.SPARK, muzzleFlash: K.MUZZLE,
    muzzle: K.MUZZLE, rain: K.RAIN, snow: K.SNOW, mote: K.MOTE, text: K.MOTE
  };

  var F_SCREEN = 1;              /* x/y are canvas pixels, not tiles */
  var F_RING = 2;                /* explosion shockwave rather than fireball */
  var F_SETTLE = 4;              /* snow that has landed and is melting out */

  /* Colours live in a table so a particle carries one byte, not a string.
     Anything spawned with a colour the table does not know is appended, so
     callers may pass plain CSS and still cost a byte per particle. */
  var COLORS = [
    '#6d6a67', '#9a9691', '#2b2724', '#ff9a2e', '#ffd98a', '#ff6a18', '#fff3cf',
    '#6b533b', '#c2b280', '#8b8894', '#8b1a1a', '#5a0f0f', '#7d7a82', '#a9783f',
    '#4f7a35', '#b8752a', '#5fa8d8', '#f2f7ff', '#bcd8f2', '#cfd8e4', '#ffe9a8',
    '#d8e2ef', '#7fd07f', '#e0605a', '#e8e2d4', '#ffc23c'
  ];
  var C = {
    smoke: 0, smokePale: 1, smokeSoot: 2, ember: 3, emberHot: 4, flame: 5,
    flameCore: 6, dustSoil: 7, dustSand: 8, dustRock: 9, blood: 10, bloodDark: 11,
    chipStone: 12, chipWood: 13, leafGreen: 14, leafFall: 15, water: 16,
    snow: 17, rain: 18, fog: 19, sparkHot: 20, sparkCold: 21,
    moteGood: 22, moteBad: 23, motePlain: 24, moteGold: 25
  };
  var colorIndex = new Map();
  for (var ci = 0; ci < COLORS.length; ci++) colorIndex.set(COLORS[ci], ci);

  function colOf(c) {
    if (c === undefined || c === null) return C.smoke;
    if (typeof c === 'number') return c < 0 ? 0 : (c > 254 ? 254 : c | 0);
    var hit = colorIndex.get(c);
    if (hit !== undefined) return hit;
    if (COLORS.length >= 255) return C.smoke;
    COLORS.push(c);
    colorIndex.set(c, COLORS.length - 1);
    return COLORS.length - 1;
  }

  /* ------------------------------------------------------------------
     The pool
     ------------------------------------------------------------------ */

  var pX = new Float32Array(MAX), pY = new Float32Array(MAX);
  var pVX = new Float32Array(MAX), pVY = new Float32Array(MAX);
  var pLife = new Float32Array(MAX), pMax = new Float32Array(MAX);
  var pSize = new Float32Array(MAX), pRot = new Float32Array(MAX), pSpin = new Float32Array(MAX);
  var pKind = new Uint8Array(MAX), pCol = new Uint8Array(MAX), pFlags = new Uint8Array(MAX);
  var pSeed = new Float32Array(MAX), pAlpha = new Float32Array(MAX);
  var pExtra = new Float32Array(MAX), pBorn = new Float64Array(MAX);
  var pText = new Array(MAX);

  var count = 0, serial = 0, evictCursor = 0;
  var liveByKind = new Int32Array(KINDS);

  /* Draw buckets: one pass per kind means the canvas composite mode and
     the sprite in hand change a dozen times a frame instead of per mote. */
  var bucketAt = new Int32Array(KINDS), bucketEnd = new Int32Array(KINDS);
  var order = new Int32Array(MAX);

  function rc() { return U && U.randCosmetic ? U.randCosmetic() : 0.5; }
  function rr(a, b) { return a + rc() * (b - a); }
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function alloc() {
    if (count < MAX) return count++;
    /* The pool is full. Finding the exact oldest would mean scanning four
       thousand slots on every spawn for as long as the storm lasts, so
       take the oldest of a rolling sample: the cursor walks the pool, so
       nothing genuinely old survives more than a few spawns. */
    var best = evictCursor % count, bestBorn = pBorn[best];
    for (var k = 1; k < 24; k++) {
      var i = (evictCursor + k * 167) % count;
      if (pBorn[i] < bestBorn) { bestBorn = pBorn[i]; best = i; }
    }
    evictCursor = (evictCursor + 53) % MAX;
    liveByKind[pKind[best]]--;
    pText[best] = null;
    return best;
  }

  function copySlot(from, to) {
    pX[to] = pX[from]; pY[to] = pY[from];
    pVX[to] = pVX[from]; pVY[to] = pVY[from];
    pLife[to] = pLife[from]; pMax[to] = pMax[from];
    pSize[to] = pSize[from]; pRot[to] = pRot[from]; pSpin[to] = pSpin[from];
    pKind[to] = pKind[from]; pCol[to] = pCol[from]; pFlags[to] = pFlags[from];
    pSeed[to] = pSeed[from]; pAlpha[to] = pAlpha[from];
    pExtra[to] = pExtra[from]; pBorn[to] = pBorn[from];
    pText[to] = pText[from];
  }

  function kill(i) {
    liveByKind[pKind[i]]--;
    count--;
    if (i !== count) copySlot(count, i);
    pText[count] = null;
  }

  /* ------------------------------------------------------------------
     Spawning

     One switch holds every kind's opening conditions: how long it lives,
     how big it starts, which way it leaves and what colour it is. Callers
     override any of it through opts, which is what lets the same 'spark'
     serve a chisel, a rifle ricochet and a shorting conduit.
     ------------------------------------------------------------------ */

  function emit(k, x, y, o) {
    ensureInit();
    var i = alloc();
    var s = rc();
    pKind[i] = k; pX[i] = x; pY[i] = y; pSeed[i] = s;
    pVX[i] = 0; pVY[i] = 0; pRot[i] = 0; pSpin[i] = 0;
    pFlags[i] = 0; pExtra[i] = 0; pText[i] = null; pAlpha[i] = 1;
    pBorn[i] = ++serial;

    switch (k) {
      case K.SMOKE:
        pLife[i] = rr(2.2, 4.4); pSize[i] = rr(0.42, 0.72); pCol[i] = C.smoke;
        pVY[i] = -rr(0.35, 0.7); pVX[i] = rr(-0.2, 0.2); pAlpha[i] = rr(0.26, 0.42);
        pSpin[i] = rr(-0.5, 0.5);
        break;
      case K.FOG:
        pLife[i] = rr(14, 26); pSize[i] = rr(150, 340); pCol[i] = C.fog;
        pAlpha[i] = rr(0.05, 0.13); pFlags[i] = F_SCREEN;
        break;
      case K.DUST:
        pLife[i] = rr(0.7, 1.4); pSize[i] = rr(0.22, 0.4); pCol[i] = C.dustSoil;
        pVX[i] = rr(-0.5, 0.5); pVY[i] = rr(-0.45, -0.1); pAlpha[i] = rr(0.3, 0.5);
        break;
      case K.SPLASH:
        pLife[i] = rr(0.35, 0.7); pSize[i] = rr(0.1, 0.18); pCol[i] = C.water;
        pVX[i] = rr(-1.4, 1.4); pVY[i] = rr(-2.6, -1.1); pAlpha[i] = 0.85;
        break;
      case K.BLOOD:
        pLife[i] = rr(0.3, 0.62); pSize[i] = rr(0.1, 0.2); pCol[i] = C.blood;
        pVX[i] = rr(-1.8, 1.8); pVY[i] = rr(-2.2, -0.4); pAlpha[i] = 0.95;
        break;
      case K.CHIP:
        pLife[i] = rr(0.5, 1.1); pSize[i] = rr(0.1, 0.2); pCol[i] = C.chipStone;
        pVX[i] = rr(-2.2, 2.2); pVY[i] = rr(-3.2, -1.2);
        pSpin[i] = rr(-9, 9); pRot[i] = rc() * TAU;
        break;
      case K.LEAF:
        pLife[i] = rr(2.4, 4.8); pSize[i] = rr(0.16, 0.3); pCol[i] = C.leafGreen;
        pVX[i] = rr(-0.7, 0.7); pVY[i] = rr(-1.4, -0.3);
        pSpin[i] = rr(-3, 3); pRot[i] = rc() * TAU; pAlpha[i] = 0.95;
        break;
      case K.EXPLOSION:
        pLife[i] = rr(0.34, 0.5); pSize[i] = rr(1.2, 1.6); pCol[i] = C.flame;
        pAlpha[i] = 1;
        break;
      case K.FIRE:
        pLife[i] = rr(0.26, 0.46); pSize[i] = rr(0.6, 1.0); pCol[i] = C.flame;
        pVY[i] = -rr(0.5, 1.0); pAlpha[i] = rr(0.7, 1);
        break;
      case K.EMBER:
        pLife[i] = rr(0.7, 1.8); pSize[i] = rr(0.05, 0.11); pCol[i] = C.ember;
        pVY[i] = -rr(1.1, 2.3); pVX[i] = rr(-0.5, 0.5); pAlpha[i] = 1;
        break;
      case K.SPARK:
        pLife[i] = rr(0.18, 0.5); pSize[i] = rr(0.04, 0.09); pCol[i] = C.sparkHot;
        pVX[i] = rr(-4, 4); pVY[i] = rr(-4.5, -0.5); pAlpha[i] = 1;
        break;
      case K.MUZZLE:
        pLife[i] = 0.075; pSize[i] = rr(0.7, 0.95); pCol[i] = C.flameCore; pAlpha[i] = 1;
        break;
      case K.RAIN:
        pLife[i] = 4; pSize[i] = rr(0.8, 1.5); pCol[i] = C.rain;
        pAlpha[i] = rr(0.3, 0.6); pFlags[i] = F_SCREEN;
        break;
      case K.SNOW:
        pLife[i] = 14; pSize[i] = rr(4, 11); pCol[i] = C.snow;
        pAlpha[i] = rr(0.45, 0.9); pFlags[i] = F_SCREEN; pSpin[i] = rr(-1.5, 1.5);
        break;
      case K.MOTE:
        pLife[i] = 1.9; pSize[i] = 1; pCol[i] = C.motePlain;
        pVY[i] = -0.75; pVX[i] = rr(-0.1, 0.1); pAlpha[i] = 1;
        break;
      default:
        pLife[i] = 1; pSize[i] = 0.3; pCol[i] = C.smoke;
    }

    if (o) {
      if (o.vx !== undefined) pVX[i] = o.vx;
      if (o.vy !== undefined) pVY[i] = o.vy;
      if (o.size !== undefined) pSize[i] = o.size;
      if (o.life !== undefined) pLife[i] = o.life;
      if (o.color !== undefined) pCol[i] = colOf(o.color);
      if (o.alpha !== undefined) pAlpha[i] = o.alpha;
      if (o.rot !== undefined) pRot[i] = o.rot;
      if (o.spin !== undefined) pSpin[i] = o.spin;
      if (o.extra !== undefined) pExtra[i] = o.extra;
      if (o.text !== undefined) pText[i] = String(o.text);
      if (o.screen) pFlags[i] |= F_SCREEN;
      if (o.flags) pFlags[i] |= o.flags;
      if (o.speed !== undefined) {
        var ang = o.angle === undefined ? rc() * TAU : o.angle;
        var spread = o.spread === undefined ? 0 : (rc() - 0.5) * o.spread;
        pVX[i] = Math.cos(ang + spread) * o.speed;
        pVY[i] = Math.sin(ang + spread) * o.speed;
      }
    }
    pMax[i] = pLife[i];
    liveByKind[k]++;
    return i;
  }

  Particles.spawn = function (kindName, x, y, opts) {
    var k = typeof kindName === 'number' ? kindName : NAMES[kindName];
    /* typeof rather than a plain undefined check: a kind name of
       'constructor' would otherwise find something on Object.prototype. */
    if (typeof k !== 'number' || k >= KINDS || !(x === x) || !(y === y)) return -1;
    if (k === K.EXPLOSION && (!opts || !opts.plain)) {
      explosionAt(x, y, opts && opts.radius, opts);
      return -1;
    }
    return emit(k, x, y, opts);
  };

  Particles.burst = function (kindName, x, y, n, opts) {
    var k = typeof kindName === 'number' ? kindName : NAMES[kindName];
    if (typeof k !== 'number' || k >= KINDS || !(x === x) || !(y === y)) return;
    n = Math.max(1, Math.min(160, n | 0 || 1));
    if (k === K.EXPLOSION) { explosionAt(x, y, (opts && opts.radius) || (0.6 + n * 0.12), opts); return; }
    var o = opts || null;
    var spread = o && o.spread !== undefined ? o.spread : TAU;
    var base = o && o.angle !== undefined ? o.angle : null;
    for (var i = 0; i < n; i++) {
      var ang = base === null ? rc() * TAU : base + (rc() - 0.5) * spread;
      var sp = o && o.speed !== undefined ? o.speed * rr(0.45, 1.15) : 0;
      var j = emit(k, x + (o && o.jitter ? rr(-o.jitter, o.jitter) : 0),
                      y + (o && o.jitter ? rr(-o.jitter, o.jitter) : 0), o);
      if (j < 0) continue;
      if (sp) { pVX[j] = Math.cos(ang) * sp; pVY[j] = Math.sin(ang) * sp * 0.8; }
    }
  };

  Particles.mote = function (text, x, y, opts) {
    if (text === undefined || text === null) return -1;
    var o = opts || {};
    var i = emit(K.MOTE, x, y + (o.dy || 0), {
      text: text,
      color: o.color === undefined ? C.motePlain : o.color,
      life: o.life === undefined ? 1.9 : o.life,
      size: o.size === undefined ? 1 : o.size
    });
    /* Two motes born on the same cell in the same second would sit on top
       of each other, so each one takes a step aside. */
    if (i >= 0) pX[i] += rr(-0.18, 0.18);
    return i;
  };

  /* A fireball, its shockwave, the sparks it throws and the column of
     smoke that outlives all of it. */
  function explosionAt(x, y, radius, opts) {
    var r = clamp(radius || 2, 0.7, 9);
    var fire = !opts || opts.fire !== false;
    emit(K.EXPLOSION, x, y, { size: r * 0.75, life: 0.30 + r * 0.03, color: C.flameCore });
    emit(K.EXPLOSION, x, y, { size: r * 1.25, life: 0.42 + r * 0.04, color: C.flame, alpha: 0.85 });
    emit(K.EXPLOSION, x, y, { size: r * 0.5, life: 0.44, flags: F_RING, alpha: 0.7 });
    if (fire) {
      Particles.burst('spark', x, y, Math.min(46, 10 + (r * 6) | 0), { speed: r * 3.4, jitter: r * 0.2 });
      Particles.burst('ember', x, y, Math.min(30, 6 + (r * 4) | 0), { speed: r * 1.5, jitter: r * 0.3 });
    }
    var n = Math.min(24, 4 + (r * 3) | 0);
    for (var i = 0; i < n; i++) {
      emit(K.SMOKE, x + rr(-r * 0.5, r * 0.5), y + rr(-r * 0.5, r * 0.5), {
        size: r * rr(0.3, 0.6), life: rr(2.5, 5), color: C.smokeSoot, alpha: rr(0.3, 0.5),
        vx: rr(-0.7, 0.7) * r * 0.4, vy: -rr(0.3, 0.9)
      });
    }
  }

  /* ------------------------------------------------------------------
     Ground decals

     A blood drop that lands has to leave something behind, and a mote
     that fades in three seconds is not it. Decals are their own tiny
     ring buffer, drawn under every particle, fading over a minute or so.
     They are picture only - map.blood is the simulation's filth and this
     file never touches it.
     ------------------------------------------------------------------ */

  var DECALS = 220;
  var dX = new Float32Array(DECALS), dY = new Float32Array(DECALS);
  var dSize = new Float32Array(DECALS), dRot = new Float32Array(DECALS);
  var dLife = new Float32Array(DECALS), dMax = new Float32Array(DECALS);
  var dVar = new Uint8Array(DECALS), dCol = new Uint8Array(DECALS);
  var dCount = 0, dCursor = 0;

  function decal(x, y, size, colour, life) {
    var i;
    if (dCount < DECALS) { i = dCount++; }
    else { i = dCursor; dCursor = (dCursor + 1) % DECALS; }
    dX[i] = x; dY[i] = y; dSize[i] = size; dRot[i] = rc() * TAU;
    dLife[i] = life || rr(50, 90); dMax[i] = dLife[i];
    dVar[i] = (rc() * 4) | 0; dCol[i] = colOf(colour === undefined ? C.blood : colour);
  }
  Particles.decal = decal;

  function tickDecals(dt) {
    for (var i = dCount - 1; i >= 0; i--) {
      if ((dLife[i] -= dt) > 0) continue;
      dCount--;
      if (i !== dCount) {
        dX[i] = dX[dCount]; dY[i] = dY[dCount]; dSize[i] = dSize[dCount];
        dRot[i] = dRot[dCount]; dLife[i] = dLife[dCount]; dMax[i] = dMax[dCount];
        dVar[i] = dVar[dCount]; dCol[i] = dCol[dCount];
      }
      if (dCursor >= dCount) dCursor = 0;
    }
  }

  /* ------------------------------------------------------------------
     Sprites

     Everything is authored large and drawn down, the same bargain art.js
     takes: a 96px puff scaled to a third of a tile is soft and round,
     where a 16px one scaled up is a smear.
     ------------------------------------------------------------------ */

  var ready = false, headless = false;
  /* The lists are created empty rather than in init() so that a headless
     boot, where there is no document to paint into, indexes them and gets
     undefined instead of throwing. */
  var SPR = { flame: [], shard: [], leaf: [], splat: [] };

  function makeCanvas(w, h) {
    var doc = root.document;
    if (!doc || !doc.createElement) return null;
    var c = doc.createElement('canvas');
    c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0);
    return c;
  }

  function paint(key, w, h, fn) {
    var c = makeCanvas(w, h);
    if (!c || !c.getContext) return null;
    var g = c.getContext('2d');
    if (!g) return null;
    c.pkey = key;
    var rnd = rngFrom(key);
    try { fn(g, w, h, rnd); } catch (e) { /* a half-painted sprite still draws */ }
    return c;
  }

  /* Sprite texture must be identical every time the page loads, so it uses
     a hash of the sprite's own name rather than either random stream. */
  function rngFrom(key) {
    var s = (U && U.hash ? U.hash(key) : 2166136261) >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* Per-pixel grain. Flat alpha gradients read as plastic; a couple of
     percent of noise reads as smoke, dust and soot. */
  function grain(g, w, h, amount, rnd) {
    var img;
    try { img = g.getImageData(0, 0, w, h); } catch (e) { return; }
    if (!img || !img.data || !img.data.length) return;
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      if (!d[i + 3]) continue;
      var n = (rnd() - 0.5) * amount;
      d[i] = clamp(d[i] + n, 0, 255);
      d[i + 1] = clamp(d[i + 1] + n, 0, 255);
      d[i + 2] = clamp(d[i + 2] + n, 0, 255);
      d[i + 3] = clamp(d[i + 3] + n * 0.8, 0, 255);
    }
    g.putImageData(img, 0, 0);
  }

  function paintPuff(g, w, h, rnd) {
    var c = w * 0.5, i, a, r, x, y, rad, grad, v;
    /* One radial gradient is a billiard ball. Seven of them, offset and
       overlapping, is a cloud with a silhouette. */
    for (i = 0; i < 7; i++) {
      a = rnd() * TAU; r = (0.06 + rnd() * 0.2) * w;
      x = c + Math.cos(a) * r; y = c + Math.sin(a) * r;
      rad = w * (0.18 + rnd() * 0.16);
      v = 200 + ((rnd() * 55) | 0);
      grad = g.createRadialGradient(x, y, rad * 0.1, x, y, rad);
      grad.addColorStop(0, 'rgba(' + v + ',' + v + ',' + v + ',0.5)');
      grad.addColorStop(0.55, 'rgba(' + v + ',' + v + ',' + v + ',0.22)');
      grad.addColorStop(1, 'rgba(' + v + ',' + v + ',' + v + ',0)');
      g.fillStyle = grad;
      g.beginPath(); g.arc(x, y, rad, 0, TAU); g.fill();
    }
    grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,255,0.34)');
    grad.addColorStop(0.55, 'rgba(228,228,228,0.16)');
    grad.addColorStop(1, 'rgba(190,190,190,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
    grain(g, w, h, 22, rnd);
  }

  function paintGlow(g, w, h, rnd, warm) {
    var c = w * 0.5;
    var grad = g.createRadialGradient(c, c, 0, c, c, c);
    if (warm) {
      grad.addColorStop(0, 'rgba(255,255,248,1)');
      grad.addColorStop(0.14, 'rgba(255,242,190,0.9)');
      grad.addColorStop(0.36, 'rgba(255,160,52,0.42)');
      grad.addColorStop(0.68, 'rgba(206,68,16,0.12)');
      grad.addColorStop(1, 'rgba(120,28,0,0)');
    } else {
      grad.addColorStop(0, 'rgba(255,255,255,1)');
      grad.addColorStop(0.3, 'rgba(255,255,255,0.4)');
      grad.addColorStop(0.7, 'rgba(255,255,255,0.09)');
      grad.addColorStop(1, 'rgba(255,255,255,0)');
    }
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }

  function paintFlame(g, w, h, rnd, frame) {
    var wob = [0, 0.1, -0.09][frame] || 0;
    g.beginPath();
    g.moveTo(w * 0.5, h * 0.02);
    g.bezierCurveTo(w * (0.76 + wob), h * 0.3, w * 0.9, h * 0.62, w * 0.76, h * 0.86);
    g.bezierCurveTo(w * 0.64, h * 1.0, w * 0.36, h * 1.0, w * 0.24, h * 0.86);
    g.bezierCurveTo(w * 0.1, h * 0.62, w * (0.24 + wob), h * 0.3, w * 0.5, h * 0.02);
    var grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,236,168,0.22)');
    grad.addColorStop(0.28, 'rgba(255,178,52,0.72)');
    grad.addColorStop(0.66, 'rgba(255,120,24,0.92)');
    grad.addColorStop(1, 'rgba(176,42,6,0.55)');
    g.fillStyle = grad;
    g.fill();
    /* The hot core: a second, narrower tongue sitting inside the first. */
    g.beginPath();
    g.moveTo(w * 0.5, h * 0.3);
    g.bezierCurveTo(w * 0.64, h * 0.52, w * 0.66, h * 0.76, w * 0.5, h * 0.92);
    g.bezierCurveTo(w * 0.34, h * 0.76, w * 0.36, h * 0.52, w * 0.5, h * 0.3);
    grad = g.createLinearGradient(0, h * 0.3, 0, h);
    grad.addColorStop(0, 'rgba(255,248,214,0.5)');
    grad.addColorStop(0.5, 'rgba(255,226,140,0.8)');
    grad.addColorStop(1, 'rgba(255,190,70,0.3)');
    g.fillStyle = grad;
    g.fill();
  }

  function paintFlake(g, w, h, rnd) {
    var c = w * 0.5, arm = w * 0.42, i;
    g.strokeStyle = 'rgba(255,255,255,0.92)';
    g.lineCap = 'round';
    g.lineWidth = Math.max(1, w * 0.07);
    for (i = 0; i < 6; i++) {
      var a = i * Math.PI / 3;
      g.beginPath();
      g.moveTo(c, c);
      g.lineTo(c + Math.cos(a) * arm, c + Math.sin(a) * arm);
      g.moveTo(c + Math.cos(a) * arm * 0.55, c + Math.sin(a) * arm * 0.55);
      g.lineTo(c + Math.cos(a + 0.7) * arm * 0.8, c + Math.sin(a + 0.7) * arm * 0.8);
      g.moveTo(c + Math.cos(a) * arm * 0.55, c + Math.sin(a) * arm * 0.55);
      g.lineTo(c + Math.cos(a - 0.7) * arm * 0.8, c + Math.sin(a - 0.7) * arm * 0.8);
      g.stroke();
    }
    var grad = g.createRadialGradient(c, c, 0, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,255,0.75)');
    grad.addColorStop(0.5, 'rgba(230,240,255,0.2)');
    grad.addColorStop(1, 'rgba(210,230,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }

  /* Debris: an angular shard with a lit face and a shaded one, so it still
     reads as a solid chip of rock or wood when it is six pixels across. */
  function paintShard(g, w, h, rnd) {
    var c = w * 0.5, n = 5 + ((rnd() * 3) | 0), i, pts = [];
    for (i = 0; i < n; i++) {
      var a = (i / n) * TAU + rnd() * 0.4;
      var r = w * (0.26 + rnd() * 0.2);
      pts.push([c + Math.cos(a) * r, c + Math.sin(a) * r]);
    }
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (i = 1; i < n; i++) g.lineTo(pts[i][0], pts[i][1]);
    g.closePath();
    var grad = g.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(188,188,188,1)');
    grad.addColorStop(1, 'rgba(96,96,96,1)');
    g.fillStyle = grad;
    g.fill();
    g.strokeStyle = 'rgba(40,40,40,0.55)';
    g.lineWidth = Math.max(1, w * 0.05);
    g.stroke();
  }

  function paintLeaf(g, w, h, rnd) {
    g.beginPath();
    g.moveTo(w * 0.5, h * 0.08);
    g.quadraticCurveTo(w * 0.94, h * 0.44, w * 0.5, h * 0.94);
    g.quadraticCurveTo(w * 0.06, h * 0.44, w * 0.5, h * 0.08);
    var grad = g.createLinearGradient(w * 0.2, 0, w * 0.8, h);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.55, 'rgba(198,198,198,1)');
    grad.addColorStop(1, 'rgba(120,120,120,1)');
    g.fillStyle = grad;
    g.fill();
    g.strokeStyle = 'rgba(70,70,70,0.5)';
    g.lineWidth = Math.max(1, w * 0.04);
    g.beginPath();
    g.moveTo(w * 0.5, h * 0.12);
    g.lineTo(w * 0.5, h * 0.9);
    g.stroke();
  }

  function paintDrop(g, w, h, rnd) {
    var grad = g.createRadialGradient(w * 0.42, h * 0.38, 0, w * 0.5, h * 0.5, w * 0.5);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.45, 'rgba(210,210,210,0.95)');
    grad.addColorStop(1, 'rgba(110,110,110,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.ellipse ? g.ellipse(w * 0.5, h * 0.5, w * 0.34, h * 0.46, 0, 0, TAU)
              : g.arc(w * 0.5, h * 0.5, w * 0.36, 0, TAU);
    g.fill();
  }

  function paintRing(g, w, h, rnd) {
    var c = w * 0.5;
    var grad = g.createRadialGradient(c, c, c * 0.62, c, c, c);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.75)');
    grad.addColorStop(0.85, 'rgba(255,255,255,0.28)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
  }

  /* The muzzle flash is authored pointing along +x, so a shot only needs
     its bearing to be rotated into place. */
  function paintFlash(g, w, h, rnd) {
    var cy = h * 0.5;
    var grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'rgba(255,255,236,0.95)');
    grad.addColorStop(0.35, 'rgba(255,214,110,0.7)');
    grad.addColorStop(0.75, 'rgba(255,140,26,0.22)');
    grad.addColorStop(1, 'rgba(255,110,10,0)');
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(0, cy);
    g.lineTo(w * 0.45, cy - h * 0.2);
    g.lineTo(w, cy - h * 0.045);
    g.lineTo(w, cy + h * 0.045);
    g.lineTo(w * 0.45, cy + h * 0.2);
    g.closePath();
    g.fill();
    var burst = g.createRadialGradient(w * 0.06, cy, 0, w * 0.06, cy, h * 0.42);
    burst.addColorStop(0, 'rgba(255,255,255,1)');
    burst.addColorStop(0.4, 'rgba(255,228,150,0.55)');
    burst.addColorStop(1, 'rgba(255,150,40,0)');
    g.fillStyle = burst;
    g.fillRect(0, 0, w, h);
  }

  function paintSplat(g, w, h, rnd) {
    var c = w * 0.5, i;
    for (i = 0; i < 5; i++) {
      var a = rnd() * TAU, r = rnd() * w * 0.2;
      var x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
      var rx = w * (0.14 + rnd() * 0.17), ry = rx * (0.6 + rnd() * 0.6);
      var grad = g.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
      grad.addColorStop(0, 'rgba(255,255,255,0.95)');
      grad.addColorStop(0.7, 'rgba(190,190,190,0.7)');
      grad.addColorStop(1, 'rgba(120,120,120,0)');
      g.fillStyle = grad;
      g.beginPath();
      if (g.ellipse) g.ellipse(x, y, rx, ry, rnd() * TAU, 0, TAU);
      else g.arc(x, y, rx, 0, TAU);
      g.fill();
    }
    /* Satellite spots: a splat without them looks like a stain, not a hit. */
    for (i = 0; i < 9; i++) {
      var sa = rnd() * TAU, sr = w * (0.2 + rnd() * 0.28);
      var sx = c + Math.cos(sa) * sr, sy = c + Math.sin(sa) * sr;
      var ss = w * (0.012 + rnd() * 0.035);
      g.fillStyle = 'rgba(220,220,220,' + (0.35 + rnd() * 0.5).toFixed(2) + ')';
      g.beginPath(); g.arc(sx, sy, ss, 0, TAU); g.fill();
    }
    grain(g, w, h, 18, rnd);
  }

  /* Multiply a white-ish sprite by a colour and put its own alpha back,
     which tints it without flattening the shading painted into it. */
  function tinted(spr, colIdx) {
    if (!spr) return null;
    /* Keyed by array index, not by a string: a string key here would mean
       one concatenation per particle per frame, which is a few thousand
       throwaway strings a second for nothing. */
    var list = spr.tints || (spr.tints = []);
    var hit = list[colIdx];
    if (hit !== undefined) return hit;
    var c = makeCanvas(spr.width, spr.height);
    if (!c || !c.getContext) { list[colIdx] = spr; return spr; }
    var g = c.getContext('2d');
    if (!g) { list[colIdx] = spr; return spr; }
    g.drawImage(spr, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = COLORS[colIdx] || '#ffffff';
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(spr, 0, 0);
    g.globalCompositeOperation = 'source-over';
    c.pkey = spr.pkey + '|' + colIdx;
    list[colIdx] = c;
    return c;
  }

  function ensureInit() {
    if (ready) return;
    Particles.init();
  }

  Particles.init = function () {
    if (ready) return Particles;
    ready = true;
    if (!root.document || !root.document.createElement) { headless = true; return Particles; }
    SPR.puff = paint('puff', 96, 96, paintPuff);
    SPR.glowWarm = paint('glowWarm', 64, 64, function (g, w, h, r) { paintGlow(g, w, h, r, true); });
    SPR.glow = paint('glow', 64, 64, function (g, w, h, r) { paintGlow(g, w, h, r, false); });
    SPR.flake = paint('flake', 32, 32, paintFlake);
    SPR.drop = paint('drop', 24, 32, paintDrop);
    SPR.ring = paint('ring', 96, 96, paintRing);
    SPR.flash = paint('flash', 96, 40, paintFlash);
    SPR.flame = [];
    for (var f = 0; f < 3; f++) {
      var fl = paint('flame' + f, 48, 72, function (g, w, h, r) { paintFlame(g, w, h, r, f); });
      /* The anchor art.js marks on its own effects, so both draw the same
         way: the point that stands on the ground is the base of the flame. */
      if (fl) { fl.cx = 24; fl.cy = 68; }
      SPR.flame.push(fl);
    }
    SPR.shard = [];
    SPR.leaf = [];
    SPR.splat = [];
    for (var v = 0; v < 4; v++) {
      SPR.shard.push(paint('shard' + v, 24, 24, paintShard));
      SPR.leaf.push(paint('leaf' + v, 32, 32, paintLeaf));
      SPR.splat.push(paint('splat' + v, 96, 96, paintSplat));
    }
    /* Warm the tints the first minute of a colony will ask for, so the
       first campfire does not build four canvases mid-frame. */
    [C.smoke, C.smokeSoot, C.dustSoil, C.dustRock, C.dustSand].forEach(function (c) { tinted(SPR.puff, c); });
    [C.ember, C.emberHot, C.sparkHot].forEach(function (c) { tinted(SPR.glow, c); });
    return Particles;
  };

  /* art.js owns the flame atlas when it has one; ours is the fallback.
     If Art ever throws we stop asking for the rest of the session. */
  var artFireOff = false;
  function artFlame(frame) {
    var A = root.Art;
    if (artFireOff || !A || !A.effect) return null;
    try {
      var c = A.effect('fire', frame);
      return c && c.width ? c : null;
    } catch (e) { artFireOff = true; return null; }
  }

  /* ------------------------------------------------------------------
     Wind and weather
     ------------------------------------------------------------------ */

  var weather = { kind: 'none', intensity: 0, manual: false };
  var windX = 0, windY = 0, windStrength = 0;
  var clock = 0, weatherCheck = 0, autoAt = -1;

  var WEATHERS = { none: 1, rain: 1, snow: 1, fog: 1 };

  Particles.setWeather = function (kind, intensity) {
    /* 'auto' hands the sky back to the calendar, which is what it runs on
       until somebody says otherwise. */
    if (kind === 'auto' || kind === null || kind === undefined) { weather.manual = false; return; }
    weather.manual = true;
    weather.kind = WEATHERS[kind] ? kind : 'none';
    weather.intensity = clamp(intensity === undefined ? 1 : intensity, 0, 1);
  };
  Particles.weather = function () { return { kind: weather.kind, intensity: weather.intensity }; };

  function updateWind() {
    var G = root.Game;
    var w = G && G.weather ? G.weather.wind : 0.5;
    if (!(w >= 0)) w = 0.5;
    windStrength = 0.25 + w * 2.1;
    /* No wind bearing exists in the simulation, so one is derived from the
       clock: a slow, deterministic swing rather than a weather vane that
       spins on every frame. */
    var t = (G && G.tick ? G.tick : 0) / 60000;
    var ang = t * 0.8 + Math.sin(t * 0.37) * 1.4 + 0.6;
    windX = Math.cos(ang) * windStrength;
    windY = Math.sin(ang) * windStrength * 0.45;
  }

  /* The storyteller may one day set precipitation on Game.weather; until
     it does, the sky runs itself off the calendar so a colony still sees
     rain in autumn and snow at midwinter. Either way an explicit
     setWeather call from the UI wins. */
  function updateWeather() {
    if (weather.manual) return;
    var G = root.Game;
    if (!G || !G.started) { weather.kind = 'none'; weather.intensity = 0; return; }
    var gw = G.weather || null;
    if (gw) {
      if (typeof gw.rain === 'number' && gw.rain > 0) { weather.kind = 'rain'; weather.intensity = clamp(gw.rain, 0, 1); return; }
      if (typeof gw.snow === 'number' && gw.snow > 0) { weather.kind = 'snow'; weather.intensity = clamp(gw.snow, 0, 1); return; }
      if (gw.rainTicksLeft > 0) { weather.kind = 'rain'; weather.intensity = 0.8; return; }
      if (gw.snowTicksLeft > 0) { weather.kind = 'snow'; weather.intensity = 0.8; return; }
      if (typeof gw.kind === 'string' && gw.kind !== 'none' && gw.kind !== 'clear') {
        weather.kind = gw.kind;
        weather.intensity = clamp(gw.intensity === undefined ? 0.8 : gw.intensity, 0, 1);
        return;
      }
    }
    /* The calendar does not change in a third of a second, and hashing a
       freshly built string every frame to learn that is work for nothing. */
    if (clock - autoAt < 0.3) return;
    autoAt = clock;
    var day = G.day ? G.day() : 0;
    var frac = G.timeOfDay ? G.timeOfDay() : 0;
    var wet = (U.hash('rimdaun-sky-' + day) % 1000) / 1000;
    var cold = (G.outdoorTemp ? G.outdoorTemp() : 12) < 0 || (G.season && G.season() === 'winter');
    if (wet > 0.68) {
      /* One shower a wet day, arriving and leaving on a smooth envelope so
         it never snaps on mid-frame. */
      var mid = 0.12 + ((U.hash('rimdaun-hour-' + day) % 1000) / 1000) * 0.72;
      var half = 0.10 + (wet - 0.68) * 0.5;
      var d = Math.abs(frac - mid) / half;
      if (d < 1) {
        weather.kind = cold ? 'snow' : 'rain';
        weather.intensity = clamp((1 - d * d) * (0.35 + (wet - 0.68) * 2), 0.05, 1);
        return;
      }
    }
    var hour = G.hour ? G.hour() : 12;
    var foggy = (U.hash('rimdaun-fog-' + day) % 1000) / 1000;
    if (foggy > 0.6 && hour > 3.5 && hour < 8.5) {
      var f = 1 - Math.abs(hour - 6) / 2.5;
      weather.kind = 'fog';
      weather.intensity = clamp(f * (foggy - 0.6) * 2.2, 0, 0.8);
      return;
    }
    weather.kind = 'none';
    weather.intensity = 0;
  }

  /* Weather fills the window, so how much of it there is depends on the
     window and not at all on the map. */
  function maintainWeather(dt) {
    if (!vw || !vh || headless) return;
    var area = vw * vh;
    var zoomK = clamp(vTile / 48, 0.55, 1.7);
    var kindId = weather.kind === 'rain' ? K.RAIN : (weather.kind === 'snow' ? K.SNOW : (weather.kind === 'fog' ? K.FOG : -1));
    var want = 0;
    if (kindId === K.RAIN) want = (area * 0.00024 * weather.intensity) | 0;
    else if (kindId === K.SNOW) want = (area * 0.00017 * weather.intensity) | 0;
    else if (kindId === K.FOG) want = (area * 0.000022 * weather.intensity) | 0;
    if (want > 900) want = 900;

    var k, live, i, n;
    for (k = K.RAIN; k <= K.SNOW; k++) {
      if (k === kindId) continue;
      if (liveByKind[k] > 0 && clock - weatherCheck > 0.5) cullKind(k, 0);
    }
    if (kindId !== K.FOG && liveByKind[K.FOG] > 0 && clock - weatherCheck > 0.5) cullKind(K.FOG, 0);
    if (clock - weatherCheck > 0.5) weatherCheck = clock;
    if (kindId < 0) return;

    live = liveByKind[kindId];
    if (live > want + 4) { cullKind(kindId, want); return; }
    n = Math.min(want - live, kindId === K.FOG ? 2 : 90);
    for (i = 0; i < n; i++) {
      if (kindId === K.RAIN) spawnRain(zoomK, true);
      else if (kindId === K.SNOW) spawnSnow(zoomK, true);
      else spawnFog();
    }
  }

  /* Trim a weather kind down to a target by giving the surplus a short
     life rather than deleting it, so a shower stops instead of vanishing. */
  function cullKind(k, want) {
    var over = liveByKind[k] - want;
    if (over <= 0) return;
    for (var i = 0; i < count && over > 0; i++) {
      if (pKind[i] !== k) continue;
      if (pLife[i] > 1.1) { pLife[i] = rr(0.2, 1.1); }
      over--;
    }
  }

  function spawnRain(zoomK, anywhere) {
    var wpx = windX * vTile * 0.55;
    var y = anywhere ? rr(-vh * 0.1, vh) : rr(-vh * 0.12, -vh * 0.02);
    var i = emit(K.RAIN, rr(-Math.abs(wpx) - 40, vw + Math.abs(wpx) + 40), y, null);
    pVY[i] = rr(760, 1180) * zoomK;
    pVX[i] = wpx * rr(0.8, 1.2);
    /* Top-down: every drop meets the ground where it is, so each one gets
       its own landing line and splashes there. */
    pExtra[i] = Math.min(vh + 8, y + vh * rr(0.12, 0.45));
    pLife[i] = 6;
    pMax[i] = 6;
  }

  function spawnSnow(zoomK, anywhere) {
    var y = anywhere ? rr(-vh * 0.1, vh) : rr(-vh * 0.14, -vh * 0.02);
    var i = emit(K.SNOW, rr(-60, vw + 60), y, null);
    pVY[i] = rr(38, 92) * zoomK;
    pVX[i] = windX * vTile * 0.16;
    pSize[i] = rr(4, 12) * zoomK;
    pExtra[i] = Math.min(vh + 8, y + vh * rr(0.2, 0.8));
    pLife[i] = 40;
    pMax[i] = 40;
  }

  function spawnFog() {
    var i = emit(K.FOG, rr(-160, vw + 160), rr(-120, vh + 120), null);
    pSize[i] = rr(160, 420);
    pVX[i] = windX * vTile * 0.05;
    pVY[i] = windY * vTile * 0.05;
  }

  /* ------------------------------------------------------------------
     Motion
     ------------------------------------------------------------------ */

  function integrate(dt) {
    var i = 0, k, t, f, sc, dx, dy, lx, ly, ls, lc;
    while (i < count) {
      pLife[i] -= dt;
      if (pLife[i] <= 0) {
        k = pKind[i]; lx = pX[i]; ly = pY[i]; ls = pSize[i]; lc = pCol[i]; f = pFlags[i];
        kill(i);
        /* Death effects spawn after the slot is gone, so nothing lands in
           a hole that is about to be overwritten. */
        if (k === K.BLOOD) decal(lx, ly, ls * rr(2.6, 4.2), lc, rr(45, 95));
        else if (k === K.RAIN && rc() < 0.55) {
          /* Only half of them splash. A ring under every single drop is
             both more particles than the picture needs and busier than
             rain actually looks. */
          emit(K.SPLASH, lx, ly, { screen: true, size: rr(3, 7), life: rr(0.16, 0.3), color: C.rain, alpha: 0.5, flags: F_RING });
        } else if (k === K.EXPLOSION && !(f & F_RING)) {
          emit(K.SMOKE, lx, ly, { size: ls * 0.6, life: rr(2.5, 4.5), color: C.smokeSoot, alpha: 0.42, vy: -rr(0.3, 0.7) });
        }
        continue;
      }
      k = pKind[i];
      sc = pFlags[i] & F_SCREEN;
      t = pLife[i] / pMax[i];

      switch (k) {
        case K.SMOKE:
          /* Rises, spreads, and leans downwind more the higher it gets. */
          pVY[i] -= 0.55 * dt;
          pVX[i] += (windX * 0.55 - pVX[i]) * 1.1 * dt;
          pVY[i] += (windY * 0.35 - pVY[i]) * 0.25 * dt;
          pSize[i] += (0.28 + pSeed[i] * 0.3) * dt;
          break;
        case K.FOG:
          pVX[i] += (windX * vTile * 0.05 - pVX[i]) * 0.4 * dt;
          pVY[i] += (windY * vTile * 0.05 - pVY[i]) * 0.4 * dt;
          if (pX[i] < -260) pX[i] = vw + 200;
          else if (pX[i] > vw + 260) pX[i] = -200;
          if (pY[i] < -220) pY[i] = vh + 180;
          else if (pY[i] > vh + 220) pY[i] = -180;
          break;
        case K.DUST:
          /* Kicked up, then it stops in the air and settles out. */
          pVX[i] -= pVX[i] * 2.4 * dt;
          pVY[i] -= pVY[i] * 2.4 * dt;
          pVX[i] += windX * 0.25 * dt;
          pSize[i] += 0.22 * dt;
          break;
        case K.SPLASH:
          if (!(pFlags[i] & F_RING)) { pVY[i] += (sc ? 700 : 7.5) * dt; }
          else { pSize[i] += (sc ? 44 : 0.7) * dt; }
          break;
        case K.BLOOD:
          pVY[i] += 9 * dt;
          pVX[i] -= pVX[i] * 0.8 * dt;
          break;
        case K.CHIP:
          pVY[i] += 11 * dt;
          pVX[i] -= pVX[i] * 1.1 * dt;
          pSpin[i] -= pSpin[i] * 0.6 * dt;
          break;
        case K.LEAF:
          /* Flutter: a leaf falls by sliding from side to side, and the
             phase comes off its own seed so no two share a rhythm. */
          pVX[i] += (Math.sin(clock * 2.6 + pSeed[i] * 9) * 0.7 + windX * 0.4 - pVX[i]) * 2 * dt;
          pVY[i] += (0.65 - pVY[i]) * 1.4 * dt;
          pSpin[i] = Math.cos(clock * 2.6 + pSeed[i] * 9) * 2.2;
          break;
        case K.EXPLOSION:
          pSize[i] += ((pFlags[i] & F_RING) ? 9 : 2.6) * dt;
          break;
        case K.FIRE:
          pVY[i] -= 0.9 * dt;
          pVX[i] += windX * 0.5 * dt;
          break;
        case K.EMBER:
          pVY[i] -= 1.5 * dt;
          pVX[i] += (windX * 0.8 + Math.sin(clock * 7 + pSeed[i] * 11) * 0.6 - pVX[i]) * 2.6 * dt;
          break;
        case K.SPARK:
          pVY[i] += 7.5 * dt;
          pVX[i] -= pVX[i] * 1.6 * dt;
          pVY[i] -= pVY[i] * 0.6 * dt;
          break;
        case K.MUZZLE:
          break;
        case K.RAIN:
          if (pY[i] >= pExtra[i]) { pLife[i] = 0.0001; }
          break;
        case K.SNOW:
          pVX[i] += (Math.sin(clock * 1.3 + pSeed[i] * 12) * 16 + windX * vTile * 0.16 - pVX[i]) * 1.6 * dt;
          if (pFlags[i] & F_SETTLE) { pVX[i] *= 0.1; pVY[i] *= 0.1; }
          else if (pY[i] >= pExtra[i]) {
            /* Landed: it stops where it fell and melts out of the picture. */
            pFlags[i] |= F_SETTLE;
            pLife[i] = Math.min(pLife[i], rr(0.8, 2.2));
            pMax[i] = pLife[i];
          }
          break;
        case K.MOTE:
          pVY[i] += (-0.28 - pVY[i]) * 1.6 * dt;
          break;
      }

      pX[i] += pVX[i] * dt;
      pY[i] += pVY[i] * dt;
      if (pSpin[i]) pRot[i] += pSpin[i] * dt;

      /* Screen-space weather that has left the window is finished with. */
      if (sc && k !== K.FOG) {
        dx = pX[i]; dy = pY[i];
        if (dy > vh + 60 || dx < -220 || dx > vw + 220) { kill(i); continue; }
      }
      i++;
    }
  }

  /* ------------------------------------------------------------------
     Watching the simulation

     Nothing else in the game knows this file exists, so rather than wait
     to be told, it looks: at the fires burning, the bullets in the air,
     the pawns walking and the wounds that just opened. All of it is
     read-only and all of it is bounded by the visible rectangle.
     ------------------------------------------------------------------ */

  var pawnSeen = new Map(), projSeen = new Map(), boomSeen = new Map();
  var lastMap = null, pruneAt = 0, fireAccum = 0;

  function injuryCount(p) {
    return p && p.health && p.health.injuries ? p.health.injuries.length : 0;
  }

  function terrainColour(map, x, y) {
    var t = map.terrainAt ? map.terrainAt(x | 0, y | 0) : null;
    if (!t) return C.dustSoil;
    if (t.isWater) return C.water;
    var cat = t.terrainCategory;
    if (cat === 'sand') return C.dustSand;
    if (cat === 'rock' || cat === 'floor') return C.dustRock;
    return C.dustSoil;
  }

  function isWaterAt(map, x, y) {
    var t = map.terrainAt ? map.terrainAt(x | 0, y | 0) : null;
    return !!(t && t.isWater);
  }

  function footfall(map, p, fx, fy) {
    var G = root.Game;
    if (isWaterAt(map, p.x, p.y)) {
      Particles.burst('splash', fx, fy + 0.25, 3, { speed: 1.4, jitter: 0.12 });
      emit(K.SPLASH, fx, fy + 0.25, { size: 0.16, life: 0.4, flags: F_RING, alpha: 0.5 });
      return;
    }
    var winter = G && G.season && G.season() === 'winter';
    var c = winter ? C.snow : terrainColour(map, p.x, p.y);
    var big = p.isAnimal ? 0.75 : 1;
    emit(K.DUST, fx + rr(-0.12, 0.12), fy + 0.28, {
      size: rr(0.16, 0.28) * big, color: c, alpha: rr(0.16, 0.3), life: rr(0.5, 0.95)
    });
  }

  /* What a job looks like from three tiles away: the chips, sparks and
     splinters that say work is happening here. */
  var WORK_FX = {
    mine: 'rock', deconstruct: 'rock', construct: 'build', repair: 'build',
    chopWood: 'wood', harvest: 'plant', cutPlant: 'plant', sow: 'plant', doBill: 'bill'
  };

  function jobSpot(map, job) {
    var T = root.T;
    if (!T || !T.pos || !job) return null;
    try { return T.pos(job.targetA, map) || null; } catch (e) { return null; }
  }

  function workSpark(map, p) {
    var job = p.job;
    if (!job || !job.defId) return;
    var style = WORK_FX[job.defId];
    if (!style) return;
    if (p.path && p.path.length && p.pathIdx < p.path.length) return;
    var spot = jobSpot(map, job);
    if (!spot) return;
    var d = Math.abs(spot.x - p.x) + Math.abs(spot.y - p.y);
    if (d > 2) return;
    var x = spot.x + 0.5 + rr(-0.2, 0.2), y = spot.y + 0.5 + rr(-0.2, 0.2);
    if (style === 'rock') {
      Particles.burst('chip', x, y, 2, { speed: 2.2, color: C.chipStone, jitter: 0.15 });
      emit(K.DUST, x, y, { size: 0.24, color: C.dustRock, alpha: 0.28, life: 0.9 });
    } else if (style === 'wood') {
      Particles.burst('chip', x, y, 3, { speed: 2.6, color: C.chipWood, jitter: 0.2 });
      if (rc() < 0.25) emit(K.LEAF, x, y - 0.4, { color: C.leafGreen });
    } else if (style === 'build') {
      Particles.burst('spark', x, y, 3, { speed: 3.2, color: C.sparkCold, jitter: 0.12 });
    } else if (style === 'plant') {
      if (rc() < 0.5) emit(K.LEAF, x, y, { color: rc() < 0.3 ? C.leafFall : C.leafGreen, life: rr(1.2, 2.4) });
    } else if (style === 'bill') {
      var b = map.buildingAt ? map.buildingAt(spot.x, spot.y) : null;
      var id = b && b.defId;
      if (id === 'smithy') Particles.burst('spark', x, y - 0.2, 4, { speed: 3.6, color: C.emberHot, jitter: 0.1 });
      else if (id === 'stove' || id === 'campfire') emit(K.SMOKE, x, y - 0.3, { size: 0.24, alpha: 0.2, color: C.smokePale, life: 1.8 });
      else if (id === 'butcherTable') { if (rc() < 0.4) Particles.burst('blood', x, y, 2, { speed: 1.2 }); }
      else if (id === 'stonecutterTable') Particles.burst('chip', x, y, 2, { speed: 2, color: C.chipStone });
    }
  }

  function bleedBurst(p, fx, fy, newInjuries) {
    var amount = 0, list = p.health && p.health.injuries;
    if (list) {
      for (var i = Math.max(0, list.length - newInjuries); i < list.length; i++) {
        amount += (list[i] && list[i].amount) || 0;
      }
    }
    var n = clamp(2 + amount * 0.35, 2, 14) | 0;
    Particles.burst('blood', fx, fy, n, { speed: 1.4 + amount * 0.09, jitter: 0.15 });
    if (p.isHuman && amount >= 1) {
      Particles.mote(Math.round(amount), fx, fy - 0.35, { color: C.moteBad, size: 0.95 });
    }
  }

  var DIRV = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  /* A shot is read off the shooter, not off the bullet. At six times speed
     a rifle round can be spawned, fly nine tiles and be gone between two
     frames, and a muzzle flash nobody ever sees is no muzzle flash at all;
     pawn.lastAttackTick is still sitting there when the frame arrives. */
  function attackFx(map, p, x, y) {
    var tp = null;
    if (p.aimTarget) {
      var T = root.T;
      if (T && T.pos) { try { tp = T.pos(p.aimTarget, map); } catch (e) { tp = null; } }
    }
    var ang, reach;
    if (tp) {
      ang = Math.atan2(tp.y - p.y, tp.x - p.x);
      reach = Math.sqrt((tp.x - p.x) * (tp.x - p.x) + (tp.y - p.y) * (tp.y - p.y));
    } else {
      var d = DIRV[(p.dir | 0) & 3];
      ang = Math.atan2(d[1], d[0]);
      reach = 3;
    }
    var cos = Math.cos(ang), sin = Math.sin(ang);
    if (reach > 1.6) {
      emit(K.MUZZLE, x + cos * 0.42, y + sin * 0.42, { rot: ang });
      Particles.burst('spark', x + cos * 0.55, y + sin * 0.55, 3,
        { speed: 2.8, angle: ang, spread: 0.8, color: C.emberHot });
      emit(K.SMOKE, x + cos * 0.7, y + sin * 0.7, {
        size: 0.2, alpha: 0.2, life: rr(0.6, 1.3), color: C.smokePale
      });
    } else {
      /* A swing: the effect belongs where the blow lands, not on the arm. */
      Particles.burst('spark', x + cos * 0.8, y + sin * 0.8, 2,
        { speed: 1.8, angle: ang + Math.PI, spread: 1.6, color: C.sparkCold });
      emit(K.DUST, x + cos * 0.8, y + sin * 0.8, { size: 0.16, alpha: 0.22, life: 0.4 });
    }
  }

  function observePawns(map, dt) {
    var pawns = map.pawns;
    if (!pawns || !pawns.length) return;
    var x0 = viewX0 - 2, x1 = viewX1 + 2, y0 = viewY0 - 2, y1 = viewY1 + 2;
    for (var i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      if (!p || p.map !== map) continue;
      var fx = p.fx === undefined ? p.x : p.fx;
      var fy = p.fy === undefined ? p.y : p.fy;
      if (!(fx === fx) || !(fy === fy)) continue;
      var rec = pawnSeen.get(p.id);
      if (!rec) {
        /* The first sighting only takes a baseline. Bursting blood for
           every wound a raider walked onto the map with would paint the
           edge of the screen red the moment a raid arrives. */
        pawnSeen.set(p.id, {
          x: fx, y: fy, walk: 0, inj: injuryCount(p), dead: !!p.dead,
          atk: p.lastAttackTick || 0, work: rr(0, 0.3), t: clock
        });
        continue;
      }
      rec.t = clock;
      var inView = fx >= x0 && fx <= x1 && fy >= y0 && fy <= y1;
      if (p.lastAttackTick > rec.atk) {
        rec.atk = p.lastAttackTick;
        if (inView) attackFx(map, p, fx + 0.5, fy + 0.5);
      }
      var inj = injuryCount(p);
      if (inj > rec.inj && inView) bleedBurst(p, fx + 0.5, fy + 0.5, inj - rec.inj);
      rec.inj = inj;
      if (p.dead && !rec.dead) {
        if (inView) {
          Particles.burst('blood', fx + 0.5, fy + 0.5, 10, { speed: 2.2, jitter: 0.2 });
          decal(fx + 0.5, fy + 0.5, 1.5, C.bloodDark, 120);
        }
        rec.dead = true;
      }
      var dx = fx - rec.x, dy = fy - rec.y;
      rec.x = fx; rec.y = fy;
      if (!inView || p.dead || p.downed) continue;

      var moved = Math.abs(dx) + Math.abs(dy);
      if (moved > 0 && moved < 1.4) {
        rec.walk += moved;
        if (rec.walk >= 0.85) { rec.walk = 0; footfall(map, p, fx + 0.5, fy + 0.5); }
      }
      rec.work -= dt;
      if (rec.work <= 0) { rec.work = rr(0.14, 0.3); workSpark(map, p); }
    }
  }

  function observeFires(map, dt, speed) {
    var fires = map.byDef ? map.byDef('fire') : null;
    if (!fires || !fires.length) return;
    fireAccum += dt * speed;
    var budget = Math.min(fires.length, 70);
    for (var i = 0; i < budget; i++) {
      var f = fires[i];
      if (!f || !f.spawned) continue;
      if (f.x < viewX0 - 1 || f.x > viewX1 + 1 || f.y < viewY0 - 1 || f.y > viewY1 + 1) continue;
      var g = clamp(f.growth === undefined ? 0.5 : f.growth, 0.1, 1);
      var x = f.x + 0.5, y = f.y + 0.5;
      /* Rate per fire, per second, turned into whole particles by rolling
         against the fraction - a small fire smoulders, a big one roars. */
      if (rc() < dt * speed * (2.2 + g * 4)) {
        emit(K.SMOKE, x + rr(-0.3, 0.3), y + rr(-0.3, 0.3), {
          size: rr(0.3, 0.55) * (0.6 + g), color: rc() < 0.4 ? C.smokeSoot : C.smoke,
          alpha: rr(0.22, 0.38), life: rr(2.2, 4.2)
        });
      }
      if (rc() < dt * speed * (1.2 + g * 3)) {
        emit(K.EMBER, x + rr(-0.25, 0.25), y + rr(-0.2, 0.2), {
          color: rc() < 0.5 ? C.ember : C.emberHot, size: rr(0.04, 0.09) * (0.7 + g)
        });
      }
      if (rc() < dt * speed * (3 + g * 6)) {
        emit(K.FIRE, x + rr(-0.22, 0.22), y + rr(-0.15, 0.15), { size: rr(0.5, 0.95) * (0.5 + g) });
      }
    }
  }

  /* A campfire with fuel in it, a generator burning wood: both should be
     visibly alight from across the map. */
  var BURNERS = ['campfire', 'woodGenerator'];
  function observeBurners(map, dt, speed) {
    for (var b = 0; b < BURNERS.length; b++) {
      var list = map.byDef ? map.byDef(BURNERS[b]) : null;
      if (!list || !list.length) continue;
      for (var i = 0; i < list.length && i < 24; i++) {
        var th = list[i];
        if (!th || !th.spawned || !(th.fuel > 0)) continue;
        if (th.x < viewX0 - 1 || th.x > viewX1 + 1 || th.y < viewY0 - 1 || th.y > viewY1 + 1) continue;
        var x = th.x + 0.5, y = th.y + 0.5;
        if (rc() < dt * speed * 1.6) {
          emit(K.SMOKE, x + rr(-0.2, 0.2), y - 0.1, {
            size: rr(0.22, 0.4), alpha: rr(0.16, 0.28), color: C.smokePale, life: rr(2, 3.6)
          });
        }
        if (b === 0 && rc() < dt * speed * 1.1) {
          emit(K.EMBER, x + rr(-0.2, 0.2), y, { size: rr(0.03, 0.07), life: rr(0.5, 1.1) });
        }
      }
    }
  }

  function observeProjectiles(map) {
    var Cb = root.Combat;
    var list = Cb && Cb.projectiles;
    if (!list) return;
    var i, p;
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (!p || p.map !== map) continue;
      var seen = projSeen.get(p.id);
      if (!seen) {
        seen = { x: p.x, y: p.y, t: clock };
        projSeen.set(p.id, seen);
        /* Pawns get their flash from lastAttackTick, which cannot be
           missed; a turret has no such field, so its rounds are flashed
           here, off the bullet that just appeared in front of it. */
        var shooter = p.instigator;
        if (p.defId === 'bullet' && (!shooter || shooter.needs === undefined)) {
          var ang = Math.atan2(p.ty - p.sy, p.tx - p.sx);
          emit(K.MUZZLE, p.sx + 0.5 + Math.cos(ang) * 0.4, p.sy + 0.5 + Math.sin(ang) * 0.4, { rot: ang });
          Particles.burst('spark', p.sx + 0.5 + Math.cos(ang) * 0.55, p.sy + 0.5 + Math.sin(ang) * 0.55, 3,
            { speed: 2.6, angle: ang, spread: 0.9, color: C.emberHot });
          emit(K.SMOKE, p.sx + 0.5 + Math.cos(ang) * 0.7, p.sy + 0.5 + Math.sin(ang) * 0.7, {
            size: 0.22, alpha: 0.22, life: rr(0.7, 1.4), color: C.smokePale
          });
        }
      } else { seen.x = p.x; seen.y = p.y; seen.t = clock; }
    }
    /* Anything that left the list this frame hit something. */
    projSeen.forEach(function (rec, id) {
      if (rec.t === clock) return;
      projSeen.delete(id);
      if (rec.x < viewX0 - 2 || rec.x > viewX1 + 2 || rec.y < viewY0 - 2 || rec.y > viewY1 + 2) return;
      Particles.burst('spark', rec.x + 0.5, rec.y + 0.5, 4, { speed: 3.4, jitter: 0.1 });
      emit(K.DUST, rec.x + 0.5, rec.y + 0.5, { size: 0.2, alpha: 0.3, life: 0.6, color: C.dustRock });
    });
  }

  function observeExplosions(map) {
    var Cb = root.Combat;
    var list = Cb && Cb.explosions;
    if (!list || !list.length) return;
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || e.map !== map || boomSeen.has(e.id)) continue;
      boomSeen.set(e.id, clock);
      explosionAt(e.x + 0.5, e.y + 0.5, e.radius, { fire: true });
    }
  }

  function pruneSeen() {
    var cut = clock - 8;
    pawnSeen.forEach(function (rec, id) { if (rec.t < cut) pawnSeen.delete(id); });
    boomSeen.forEach(function (t, id) { if (t < cut) boomSeen.delete(id); });
  }

  function observe(dt, speed) {
    var G = root.Game, map = G && G.map;
    if (!map) return;
    if (map !== lastMap) { Particles.clear(); lastMap = map; return; }
    observeProjectiles(map);
    observeExplosions(map);
    if (!viewReady) return;
    observeFires(map, dt, speed);
    observeBurners(map, dt, speed);
    observePawns(map, dt);
    if (clock > pruneAt) { pruneAt = clock + 4; pruneSeen(); }
  }

  /* ------------------------------------------------------------------
     The tick
     ------------------------------------------------------------------ */

  var failures = 0, disabled = false;

  function speedScale() {
    var G = root.Game;
    if (!G || !G.started) return 1;     /* the menu still has weather in it */
    if (G.gameOver) return 0;
    var mult = G.speeds && G.speeds[G.speed];
    if (!mult) return 0;
    /* Effects run a little faster on fast forward - not six times faster,
       which turns a campfire into a blowtorch, but enough that the picture
       agrees with the clock. */
    return Math.min(1 + (mult - 1) * 0.22, 1.9);
  }

  Particles.tick = function (dt) {
    if (disabled) return;
    if (!(dt > 0)) return;
    if (dt > 0.1) dt = 0.1;      /* a backgrounded tab must not teleport the weather */
    var scale = speedScale();
    if (scale <= 0) return;      /* paused: the picture holds still */
    var step = dt * scale;
    clock += step;
    try {
      updateWind();
      updateWeather();
      observe(step, scale);
      maintainWeather(step);
      if (count) integrate(step);
      if (dCount) tickDecals(step);
    } catch (e) {
      failures++;
      if (failures === 1 && typeof console !== 'undefined' && console.warn) console.warn('particles: tick', e);
      if (failures > 8) { disabled = true; Particles.clear(); }
    }
  };

  Particles.count = function () { return count; };
  Particles.decalCount = function () { return dCount; };

  Particles.clear = function () {
    count = 0; dCount = 0; dCursor = 0;
    for (var i = 0; i < KINDS; i++) liveByKind[i] = 0;
    for (var j = 0; j < MAX; j++) pText[j] = null;
    pawnSeen.clear(); projSeen.clear(); boomSeen.clear();
  };

  /* ------------------------------------------------------------------
     Drawing
     ------------------------------------------------------------------ */

  var vTile = 48, vOx = 0, vOy = 0, vw = 0, vh = 0;
  var viewX0 = 0, viewY0 = 0, viewX1 = 0, viewY1 = 0, viewReady = false;
  var groundFrame = -1, frameId = 0;

  /* render.js hands over the view it just drew with. The origin is the
     one thing it may not spell out, so it is rebuilt from the camera and
     the canvas - and if a future render.js does pass ox/oy, those win. */
  function resolveView(ctx, view) {
    var v = view || {};
    var tile = v.tile || v.ts || v.tileSize;
    if (!(tile > 0)) tile = 48;
    vTile = tile;

    var scale = 1;
    try {
      if (ctx.getTransform) {
        var m = ctx.getTransform();
        if (m && m.a > 0.001) scale = m.a;
      }
    } catch (e) { scale = 1; }
    var cnv = ctx.canvas || null;
    vw = v.w || v.width || (cnv && cnv.width ? cnv.width / scale : 0) || 0;
    vh = v.h || v.height || (cnv && cnv.height ? cnv.height / scale : 0) || 0;

    if (v.ox !== undefined && v.oy !== undefined) { vOx = v.ox; vOy = v.oy; }
    else if (v.originX !== undefined && v.originY !== undefined) { vOx = v.originX; vOy = v.originY; }
    else {
      var camX = v.camX, camY = v.camY;
      if (camX === undefined || camY === undefined) {
        var R = root.Render;
        if (R && R.camera) { camX = R.camera.x; camY = R.camera.y; }
      }
      if (camX === undefined && v.x0 !== undefined) { camX = (v.x0 + v.x1 + 1) * 0.5; camY = (v.y0 + v.y1 + 1) * 0.5; }
      if (camX === undefined) { camX = 0; camY = 0; }
      vOx = vw * 0.5 - camX * tile;
      vOy = vh * 0.5 - camY * tile;
    }

    if (v.x0 !== undefined) {
      viewX0 = v.x0; viewY0 = v.y0; viewX1 = v.x1; viewY1 = v.y1;
    } else {
      viewX0 = Math.floor(-vOx / tile); viewY0 = Math.floor(-vOy / tile);
      viewX1 = Math.ceil((vw - vOx) / tile); viewY1 = Math.ceil((vh - vOy) / tile);
    }
    viewReady = vw > 0 && vh > 0;
  }

  function sxOf(i) { return (pFlags[i] & F_SCREEN) ? pX[i] : vOx + pX[i] * vTile; }
  function syOf(i) { return (pFlags[i] & F_SCREEN) ? pY[i] : vOy + pY[i] * vTile; }

  /* Bucket the live set by kind so each pass is a contiguous run and the
     composite mode is set a dozen times a frame, not four thousand. */
  function bucket() {
    var i, k;
    for (k = 0; k < KINDS; k++) bucketAt[k] = 0;
    for (i = 0; i < count; i++) bucketAt[pKind[i]]++;
    var acc = 0;
    for (k = 0; k < KINDS; k++) {
      var n = bucketAt[k];
      bucketAt[k] = acc;
      acc += n;
      bucketEnd[k] = acc;
    }
    for (i = 0; i < count; i++) order[bucketAt[pKind[i]]++] = i;
    for (k = 0; k < KINDS; k++) bucketAt[k] = k ? bucketEnd[k - 1] : 0;
  }

  var DRAW_ORDER = [K.SMOKE, K.FOG, K.DUST, K.SPLASH, K.BLOOD, K.CHIP, K.LEAF,
                    K.EXPLOSION, K.FIRE, K.EMBER, K.SPARK, K.MUZZLE, K.RAIN, K.SNOW, K.MOTE];
  var ADDITIVE = {};
  ADDITIVE[K.EXPLOSION] = ADDITIVE[K.FIRE] = ADDITIVE[K.EMBER] = ADDITIVE[K.SPARK] = ADDITIVE[K.MUZZLE] = true;

  /* render.js may call this before it draws pawns, which puts the blood
     under the boots where it belongs; if it never does, draw() paints the
     decals itself on its way past. */
  Particles.drawGround = function (ctx, view) {
    if (disabled || !ctx) return;
    ensureInit();
    try {
      resolveView(ctx, view);
      groundFrame = frameId;
      drawDecals(ctx);
    } catch (e) {
      failures++;
      if (failures === 1 && typeof console !== 'undefined' && console.warn) console.warn('particles: ground', e);
      if (failures > 8) disabled = true;
    }
  };

  function drawDecals(ctx) {
    if (!dCount || !SPR.splat.length) return;
    for (var i = 0; i < dCount; i++) {
      var s = dSize[i] * vTile;
      var x = vOx + dX[i] * vTile, y = vOy + dY[i] * vTile;
      if (x < -s || y < -s || x > vw + s || y > vh + s) continue;
      var spr = tinted(SPR.splat[dVar[i] & 3], dCol[i]);
      if (!spr) continue;
      /* save/restore around each one rather than resetting the transform:
         the caller may be drawing through a device-pixel transform of its
         own, and clobbering that would move the whole world. */
      ctx.save();
      ctx.globalAlpha = clamp((dLife[i] / dMax[i]) * 0.62, 0, 0.62);
      ctx.translate(x, y);
      ctx.rotate(dRot[i]);
      ctx.drawImage(spr, -s * 0.5, -s * 0.5, s, s);
      ctx.restore();
    }
  }

  Particles.draw = function (ctx, view) {
    if (disabled || !ctx) return;
    ensureInit();
    frameId++;
    try {
      resolveView(ctx, view);
      if (!viewReady) return;
      /* drawGround stamps the frame it painted the decals on, so they are
         not painted twice when render.js calls both. */
      if (groundFrame !== frameId - 1 && groundFrame !== frameId) drawDecals(ctx);
      if (!count) return;
      bucket();
      ctx.save();
      var smooth = ctx.imageSmoothingEnabled;
      ctx.imageSmoothingEnabled = true;
      if (ctx.imageSmoothingQuality !== undefined) ctx.imageSmoothingQuality = 'high';
      var composite = 'source-over';
      ctx.globalCompositeOperation = composite;
      for (var d = 0; d < DRAW_ORDER.length; d++) {
        var k = DRAW_ORDER[d];
        var from = bucketAt[k], to = bucketEnd[k];
        if (from >= to) continue;
        var want = ADDITIVE[k] ? 'lighter' : 'source-over';
        if (want !== composite) { composite = want; ctx.globalCompositeOperation = want; }
        drawKind(ctx, k, from, to);
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      ctx.imageSmoothingEnabled = smooth;
      ctx.restore();
    } catch (e) {
      failures++;
      try { ctx.restore(); } catch (e2) { /* the save may never have happened */ }
      if (failures === 1 && typeof console !== 'undefined' && console.warn) console.warn('particles: draw', e);
      if (failures > 8) disabled = true;
    }
  };

  function drawKind(ctx, k, from, to) {
    var i, j, x, y, s, t, a, spr;
    var margin = vTile * 3;

    if (k === K.RAIN) {
      /* Every drop is a streak along its own velocity, and all of them are
         one path and one stroke. */
      ctx.beginPath();
      for (j = from; j < to; j++) {
        i = order[j];
        x = pX[i]; y = pY[i];
        if (x < -80 || x > vw + 80 || y < -80 || y > vh + 40) continue;
        var len = clamp(pVY[i] * 0.022, 6, 30) * pSize[i];
        ctx.moveTo(x, y);
        ctx.lineTo(x - pVX[i] * 0.022 * pSize[i], y - len);
      }
      ctx.strokeStyle = COLORS[C.rain];
      ctx.lineWidth = clamp(vTile * 0.028, 0.9, 2.2);
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      return;
    }

    if (k === K.SPARK) {
      /* Sparks are strokes too, batched by colour: a chisel throws one
         colour, a ricochet another, and each group is one path and one
         stroke. They fade by shortening rather than by alpha, because a
         per-particle alpha would mean a stroke call per spark. */
      var run = -1;
      ctx.lineCap = 'round';
      ctx.lineWidth = clamp(vTile * 0.05, 1, 3);
      ctx.globalAlpha = 0.9;
      for (j = from; j <= to; j++) {
        var cIdx = j < to ? pCol[order[j]] : -2;
        if (cIdx !== run) {
          if (run >= 0) { ctx.strokeStyle = COLORS[run]; ctx.stroke(); }
          if (j >= to) break;
          run = cIdx;
          ctx.beginPath();
        }
        i = order[j];
        x = sxOf(i); y = syOf(i);
        if (x < -margin || y < -margin || x > vw + margin || y > vh + margin) continue;
        var tl = 0.04 * (pLife[i] / pMax[i]) * vTile;
        ctx.moveTo(x, y);
        ctx.lineTo(x - pVX[i] * tl, y - pVY[i] * tl);
      }
      return;
    }

    for (j = from; j < to; j++) {
      i = order[j];
      x = sxOf(i); y = syOf(i);
      t = pLife[i] / pMax[i];
      s = (pFlags[i] & F_SCREEN) ? pSize[i] : pSize[i] * vTile;
      if (x < -margin - s || y < -margin - s || x > vw + margin + s || y > vh + margin + s) continue;

      switch (k) {
        case K.SMOKE:
          /* Fades in over the first fifth of its life and thins as it
             spreads, which is what stops a plume looking like a decal. */
          a = pAlpha[i] * clamp(t * 1.6, 0, 1) * clamp((1 - t) * 6, 0, 1);
          spr = tinted(SPR.puff, pCol[i]);
          if (!spr) break;
          ctx.globalAlpha = a;
          ctx.drawImage(spr, x - s, y - s, s * 2, s * 2);
          break;
        case K.FOG:
          spr = tinted(SPR.puff, pCol[i]);
          if (!spr) break;
          ctx.globalAlpha = pAlpha[i] * clamp(t * 4, 0, 1);
          ctx.drawImage(spr, x - s, y - s, s * 2, s * 2);
          break;
        case K.DUST:
          spr = tinted(SPR.puff, pCol[i]);
          if (!spr) break;
          ctx.globalAlpha = pAlpha[i] * clamp(t * 1.9, 0, 1);
          ctx.drawImage(spr, x - s, y - s, s * 2, s * 2);
          break;
        case K.SPLASH:
          if (pFlags[i] & F_RING) {
            spr = tinted(SPR.ring, pCol[i]);
            if (!spr) break;
            ctx.globalAlpha = pAlpha[i] * t * 0.8;
            ctx.drawImage(spr, x - s, y - s, s * 2, s * 2);
          } else {
            spr = tinted(SPR.drop, pCol[i]);
            if (!spr) break;
            ctx.globalAlpha = pAlpha[i] * clamp(t * 2, 0, 1);
            ctx.drawImage(spr, x - s * 0.5, y - s * 0.7, s, s * 1.4);
          }
          break;
        case K.BLOOD:
          spr = tinted(SPR.drop, pCol[i]);
          if (!spr) break;
          ctx.globalAlpha = pAlpha[i] * clamp(t * 3, 0, 1);
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(Math.atan2(pVY[i], pVX[i]) + Math.PI * 0.5);
          ctx.drawImage(spr, -s * 0.5, -s * 0.8, s, s * 1.6);
          ctx.restore();
          break;
        case K.CHIP:
          spr = tinted(SPR.shard[(pSeed[i] * 4) | 0], pCol[i]);
          if (!spr) break;
          ctx.globalAlpha = clamp(t * 3, 0, 1);
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(pRot[i]);
          ctx.drawImage(spr, -s * 0.5, -s * 0.5, s, s);
          ctx.restore();
          break;
        case K.LEAF:
          spr = tinted(SPR.leaf[(pSeed[i] * 4) | 0], pCol[i]);
          if (!spr) break;
          ctx.globalAlpha = pAlpha[i] * clamp(t * 2.5, 0, 1);
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(pRot[i]);
          /* The flutter is also a squash: a leaf turning edge-on is thin. */
          var lw = s * (0.3 + Math.abs(Math.cos(pRot[i] * 0.7)) * 0.7);
          ctx.drawImage(spr, -lw * 0.5, -s * 0.5, lw, s);
          ctx.restore();
          break;
        case K.EXPLOSION:
          if (pFlags[i] & F_RING) {
            spr = SPR.ring;
            if (!spr) break;
            ctx.globalAlpha = pAlpha[i] * t * t;
            ctx.drawImage(spr, x - s, y - s, s * 2, s * 2);
          } else {
            spr = SPR.glowWarm;
            if (!spr) break;
            ctx.globalAlpha = clamp(t * 1.5, 0, 1);
            ctx.drawImage(spr, x - s, y - s, s * 2, s * 2);
          }
          break;
        case K.FIRE:
          var fr = ((clock * 9 + pSeed[i] * 7) | 0) % 3;
          spr = artFlame(fr) || SPR.flame[fr];
          if (!spr) break;
          /* A tongue swells and dies away rather than fading flat. It keeps
             the aspect it was authored at - art.js's flame is a tile square,
             ours is tall - and stands on the anchor art.js marks with
             cx/cy, so the base of the flame is what sits on the ground. */
          a = Math.sin(clamp(1 - t, 0, 1) * Math.PI);
          var fw = s * (0.72 + a * 0.4);
          var fscale = fw / Math.max(1, spr.width);
          var fh = spr.height * fscale;
          ctx.globalAlpha = pAlpha[i] * clamp(a * 1.6, 0, 1);
          ctx.drawImage(spr,
            x - (spr.cx === undefined ? spr.width * 0.5 : spr.cx) * fscale,
            y - (spr.cy === undefined ? spr.height * 0.8 : spr.cy) * fscale,
            fw, fh);
          break;
        case K.EMBER:
          spr = tinted(SPR.glow, pCol[i]);
          if (!spr) break;
          /* Embers flicker: the same mote is twice as bright half a beat
             later, which is what makes a fire feel alive. */
          a = 0.55 + 0.45 * Math.sin(clock * 16 + pSeed[i] * 31);
          ctx.globalAlpha = clamp(t * 1.5, 0, 1) * a;
          ctx.drawImage(spr, x - s * 3, y - s * 3, s * 6, s * 6);
          break;
        case K.MUZZLE:
          spr = SPR.flash;
          if (!spr) break;
          ctx.globalAlpha = clamp(t * 2.5, 0, 1);
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(pRot[i]);
          ctx.drawImage(spr, -s * 0.2, -s * 0.42, s * 2.2, s * 0.85);
          ctx.restore();
          break;
        case K.SNOW:
          spr = SPR.flake;
          if (!spr) break;
          ctx.globalAlpha = pAlpha[i] * clamp(t * 6, 0, 1) * ((pFlags[i] & F_SETTLE) ? 0.7 : 1);
          ctx.drawImage(spr, x - s * 0.5, y - s * 0.5, s, s);
          break;
        case K.MOTE:
          drawMote(ctx, i, x, y, t);
          break;
      }
    }
    ctx.globalAlpha = 1;
  }

  var fontPx = -1, fontStr = '';

  function drawMote(ctx, i, x, y, t) {
    var txt = pText[i];
    if (!txt) return;
    var fs = Math.round(clamp(vTile * 0.32, 10, 26) * pSize[i]);
    if (fs !== fontPx) { fontPx = fs; fontStr = FONT.replace('%', fs); }
    ctx.globalAlpha = clamp(t * 2.2, 0, 1);
    ctx.font = fontStr;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, fs * 0.28);
    ctx.strokeStyle = 'rgba(8,10,16,0.8)';
    ctx.strokeText(txt, x, y);
    ctx.fillStyle = COLORS[pCol[i]] || '#e8e2d4';
    ctx.fillText(txt, x, y);
  }

  root.Particles = Particles;
})(this);
