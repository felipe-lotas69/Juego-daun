/* ============================================================
   draw.js - painting the world into the 320x180 buffer.

   The thing that makes a small frame look like a place rather than
   a bar chart is DENSITY: a sky in bands, three layers of skyline
   with real window grids, parapets, aerials, lamp posts, rivets.
   None of it costs gameplay and all of it costs one pixel.
   ============================================================ */
(function (root) {
  'use strict';

  var P = null;   /* the buffer context, set each frame */

  /* Build the scenery once per level and keep it: a skyline that
     reshuffles every frame is worse than no skyline. */
  function buildScenery(L) {
    if (L._scenery) return L._scenery;
    var rnd = U.seeded(L.name.length * 7919 + L.width);
    var layers = [];
    for (var layer = 0; layer < 3; layer++) {
      var band = [], x = -40;
      /* Keep the tallest block clear of the top edge. A skyline that runs
         off the frame reads as a wall; the reference keeps a good band of
         sky above it, and that sky is most of the daylight in the shot. */
      var minH = 12 + layer * 7, maxH = 26 + layer * 14;
      while (x < L.width + 140) {
        var w = 14 + Math.floor(rnd() * 20);
        band.push({
          x: x, w: w,
          h: minH + Math.floor(rnd() * (maxH - minH)),
          lit: rnd(),
          cap: rnd() < 0.3
        });
        x += w + 4 + Math.floor(rnd() * 14);
      }
      layers.push(band);
    }
    var clouds = [];
    for (var i = 0; i < 14; i++) {
      clouds.push({
        x: rnd() * (L.width + 300), y: 12 + rnd() * 54,
        w: 16 + Math.floor(rnd() * 26), sp: 1.5 + rnd() * 3
      });
    }
    var posts = [];
    for (var pxx = 40; pxx < L.width; pxx += 96 + Math.floor(rnd() * 40)) {
      posts.push({ x: pxx, h: 20 + Math.floor(rnd() * 8) });
    }
    L._scenery = { layers: layers, clouds: clouds, posts: posts };
    return L._scenery;
  }

  /* ------------------------------------------------------ backdrop
     Drawn in SCREEN space, at the canvas's own resolution, because this
     is the part that should not look like blocks. A gradient sky and
     soft cloud banks are what a pixel grid cannot give you - squashed
     onto a 320-wide buffer the sky comes out as six flat stripes, which
     is the single biggest tell that a game is a grid rather than a set
     of pixel assets. */
  function backdrop(sc, L, cam, time) {
    var sceneryData = buildScenery(L);
    var W = Pixel.cw, H = Pixel.ch;

    var g = sc.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, L.sky[0]);
    g.addColorStop(0.52, L.sky[1]);
    g.addColorStop(1, L.sky[2]);
    sc.fillStyle = g;
    sc.fillRect(0, 0, W, H);

    if (L.theme === 'indoor') return;

    var S = Pixel.SCALE;
    /* a soft sun, and cloud banks built from overlapping blurred discs */
    var sunG = sc.createRadialGradient(W * 0.78, H * 0.17, 0, W * 0.78, H * 0.17, 90 * S / 4);
    sunG.addColorStop(0, 'rgba(255,255,255,0.45)');
    sunG.addColorStop(1, 'rgba(255,255,255,0)');
    sc.fillStyle = sunG;
    sc.fillRect(0, 0, W, H);

    for (var i = 0; i < sceneryData.clouds.length; i++) {
      var c = sceneryData.clouds[i];
      var cx = (((c.x + time * c.sp) % (L.width + 300)) - cam.x * 0.14 - 60) * S;
      if (cx < -c.w * S * 2 || cx > W + c.w * S) continue;
      var cy = (c.y - cam.y * 0.05) * S;
      var cw = c.w * S, ch = cw * 0.34;
      var cg = sc.createLinearGradient(0, cy - ch, 0, cy + ch);
      cg.addColorStop(0, 'rgba(255,255,255,0.92)');
      cg.addColorStop(1, 'rgba(255,255,255,0.55)');
      sc.fillStyle = cg;
      sc.beginPath();
      sc.ellipse(cx, cy, cw * 0.5, ch * 0.62, 0, 0, 6.2832);
      sc.ellipse(cx + cw * 0.26, cy + ch * 0.14, cw * 0.34, ch * 0.44, 0, 0, 6.2832);
      sc.ellipse(cx - cw * 0.3, cy + ch * 0.2, cw * 0.3, ch * 0.38, 0, 0, 6.2832);
      sc.fill();
    }
  }

  /* ---------------------------------------------------------- sky */
  function drawSky(L, cam, time) {
    var sc = buildScenery(L);
    /* Each place gets its own horizon. A freight yard in the desert had
       a city skyline behind it, which is the kind of thing that makes a
       level look assembled rather than designed. */
    if (L.theme === 'desert') drawScrub(L, cam, sc);
    else {
      drawSkyline(L, cam, sc);
      if (L.theme !== 'indoor') drawPosts(L, cam, sc);
    }
  }

  /* Lamp posts along the horizon. They sit between the skyline and the
     play area and are most of what gives the distance a floor. */
  function drawPosts(L, cam, sc) {
    var baseY = Math.round(Pixel.H - 30 - 2 * 4 - cam.y * 0.17);
    for (var i = 0; i < sc.posts.length; i++) {
      var po = sc.posts[i];
      var x = Math.round(po.x - cam.x * 0.34);
      if (x < -6 || x > Pixel.W + 6) continue;
      Pixel.rect(P, x, baseY - po.h, 1, po.h, '#7f8a86');
      Pixel.rect(P, x, baseY - po.h, 4, 1, '#7f8a86');
      Pixel.rect(P, x + 3, baseY - po.h + 1, 1, 1, '#e8efd0');
    }
  }

  /* Open country: two soft dune bands and a scatter of scrub. Almost
     nothing, which is the point - it leaves the freight cars to carry
     the frame instead of competing with a skyline. */
  function drawScrub(L, cam, sc) {
    var baseY = Math.round(Pixel.H - 26 - cam.y * 0.10);
    var bands = [
      { p: 0.06, col: L.city[0], drop: 0 },
      { p: 0.14, col: L.city[1], drop: 7 }
    ];
    for (var b = 0; b < bands.length; b++) {
      var bn = bands[b], y0 = baseY + bn.drop;
      Pixel.rect(P, 0, y0, Pixel.W, Pixel.H, bn.col);
      /* a soft rolling edge rather than a ruled line */
      for (var x = -2; x < Pixel.W + 2; x += 2) {
        var wob = Math.sin((x + cam.x * bn.p) * 0.05 + b * 2.1) * 2;
        Pixel.rect(P, x, y0 + Math.round(wob) - 1, 2, 2, bn.col);
      }
    }
    /* scrub and cactus, thinned out so it reads as distance */
    var scrubCol = mix(L.city[1], '#4f7a3e', 0.55);
    for (var i = 0; i < sc.posts.length * 3; i++) {
      var wx = (i * 37) % (L.width + 200);
      var x2 = Math.round(wx - cam.x * 0.22);
      if (x2 < -4 || x2 > Pixel.W + 4) continue;
      var y2 = baseY + 3 + ((i * 13) % 9);
      if (i % 3 === 0) {
        Pixel.rect(P, x2, y2 - 3, 1, 4, scrubCol);
        Pixel.rect(P, x2 - 1, y2 - 2, 1, 2, scrubCol);
        Pixel.rect(P, x2 + 1, y2 - 2, 1, 2, scrubCol);
      } else {
        Pixel.rect(P, x2, y2, 2, 1, scrubCol);
      }
    }
  }

  function drawSkyline(L, cam, sc) {
    /* three skyline layers, each slower and paler than the one in front */
    var par = [0.10, 0.20, 0.34];
    for (var l = 0; l < 3; l++) {
      var band = sc.layers[l], col = L.city[l];
      var winLit = L.theme === 'indoor' ? '#6a6a96' : mix(col, '#ffffff', 0.55);
      var winDark = mix(col, '#000000', 0.10);
      var baseY = Math.round(Pixel.H - 30 - l * 4 - cam.y * par[l] * 0.5);
      for (var k = 0; k < band.length; k++) {
        var bd = band[k];
        var bx = Math.round(bd.x - cam.x * par[l]);
        if (bx > Pixel.W + 8 || bx + bd.w < -8) continue;
        var by = baseY - bd.h;
        /* Each block leans a little cream or a little blue. A skyline in
           one flat colour reads as a bar chart however many windows you
           put on it; the variation is what makes it a city. */
        var face = mix(col, bd.lit > 0.5 ? L.cityWarm : L.cityCool, Math.abs(bd.lit - 0.5) * 1.4);
        Pixel.rect(P, bx, by, bd.w, bd.h + 60, face);
        Pixel.rect(P, bx + bd.w - 1, by, 1, bd.h + 60, mix(face, '#000000', 0.07));
        Pixel.rect(P, bx, by, bd.w, 1, mix(face, '#ffffff', 0.4));
        if (bd.cap) Pixel.rect(P, bx + (bd.w >> 1) - 1, by - 4, 2, 4, mix(face, '#000000', 0.12));
        /* Windows are LIGHTER than the wall and stand in neat columns -
           glass catching the sky, not holes punched in a facade. */
        /* A regular grid of small panes. Scattering them at random and
           making them large read as damage rather than as windows. */
        var lit = L.theme === 'indoor' ? winLit : mix(face, '#ffffff', 0.62);
        var cols = Math.floor((bd.w - 2) / 4);
        var inset = Math.max(1, (bd.w - cols * 4 + 2) >> 1);
        for (var wy = by + 4; wy < by + bd.h - 3; wy += 5) {
          for (var ci = 0; ci < cols; ci++) {
            var wx = bx + inset + ci * 4;
            var key = (ci * 5 + Math.round(wy) * 3) % 13;
            Pixel.rect(P, wx, wy, 2, 3, key === 0 ? winDark : lit);
          }
        }
      }
    }
  }

  function mix(a, b, t) {
    var A = hex(a), B = hex(b);
    return 'rgb(' + Math.round(A[0] + (B[0] - A[0]) * t) + ',' +
                    Math.round(A[1] + (B[1] - A[1]) * t) + ',' +
                    Math.round(A[2] + (B[2] - A[2]) * t) + ')';
  }
  var hexCache = {};
  function hex(c) {
    if (hexCache[c]) return hexCache[c];
    var h = c.charAt(0) === '#' ? c.slice(1) : c;
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    var out = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    hexCache[c] = out;
    return out;
  }

  /* ------------------------------------------------------ terrain */
  /* Measured off the reference: a flat neutral slab with a single dark
     lip. The first cut had warm tan with staggered brick courses, which
     at this size is just noise competing with the racers. */
  var FACE = {
    day:    { lip: '#5d5d5d', body: '#b3b3b3', low: '#9c9c9c', edge: '#2b2b30' },
    desert: { lip: '#6b6152', body: '#bdb5a4', low: '#a49c8c', edge: '#312c24' },
    indoor: { lip: '#1d1d28', body: '#3f3f52', low: '#33333f', edge: '#12121a' }
  };

  function drawSolid(s, L, cam) {
    var f = FACE[L.theme] || FACE.day;
    var x = Math.round(s.x - cam.x), y = Math.round(s.y - cam.y);
    if (x > Pixel.W || x + s.w < 0) return;
    if (s.type === 'bounce') {
      Pixel.rect(P, x, y, s.w, s.h, '#57c96a');
      Pixel.rect(P, x, y, s.w, 1, '#a8f890');
      for (var q = x + 1; q < x + s.w - 1; q += 3) Pixel.rect(P, q, y + 1, 1, s.h - 1, '#2f8f44');
      return;
    }
    if (s.oneWay) {
      Pixel.rect(P, x, y, s.w, s.h, f.body);
      Pixel.rect(P, x, y, s.w, 1, f.lip);
      return;
    }
    Pixel.rect(P, x, y, s.w, s.h, f.body);
    Pixel.rect(P, x, y, s.w, 2, f.lip);
    Pixel.rect(P, x, y + s.h - 2, s.w, 2, f.low);
    Pixel.rect(P, x, y, s.w, 1, f.edge);
    Pixel.rect(P, x, y, 1, s.h, f.edge);
    Pixel.rect(P, x + s.w - 1, y, 1, s.h, f.edge);
  }

  /* --------------------------------------------------------- decor */
  function drawDecor(d, L, cam, time) {
    var x = Math.round(d.x - cam.x), y = Math.round(d.y - cam.y);
    if (x > Pixel.W + 60 || x + (d.w || 30) < -60) return;
    var f = FACE[L.theme] || FACE.day;

    if (d.kind === 'parapet') {
      Pixel.rect(P, x, y - 4, d.w, 4, f.body);
      Pixel.rect(P, x, y - 4, d.w, 1, f.lip);
      for (var q = x + 2; q < x + d.w - 2; q += 6) Pixel.rect(P, q, y - 3, 2, 2, f.low);
    } else if (d.kind === 'ac') {
      Pixel.stamp(P, ART.AC_UNIT, ART.AC_MAP, x + 6, y + 3, 0, false);
    } else if (d.kind === 'vent') {
      Pixel.rect(P, x, y, 9, 9, '#767e8a');
      Pixel.rect(P, x, y, 9, 1, '#a6aeba');
      Pixel.rect(P, x + 1, y + 2, 7, 1, '#454b55');
      Pixel.rect(P, x + 1, y + 5, 7, 1, '#454b55');
    } else if (d.kind === 'aerial') {
      Pixel.rect(P, x, y - 13, 1, 13, '#4a4f5a');
      Pixel.rect(P, x - 3, y - 11, 7, 1, '#4a4f5a');
      Pixel.rect(P, x - 2, y - 8, 5, 1, '#4a4f5a');
      if (Math.floor(time * 2) % 2) Pixel.rect(P, x, y - 15, 1, 1, '#ff5e4d');
    } else if (d.kind === 'car') {
      drawFreightCar(d, x, y);
    } else if (d.kind === 'crate') {
      for (var cx = 0; cx < d.w; cx += 12) Pixel.stamp(P, ART.CRATE, ART.CRATE_MAP, x + cx + 6, y + 5, 0, false);
    } else if (d.kind === 'rail') {
      Pixel.rect(P, x, y, d.w, 3, '#1b1b22');
      Pixel.rect(P, x, y + 3, d.w, 1, '#3a3630');
      for (var sl = 0; sl < d.w; sl += 9) Pixel.rect(P, x + sl, y + 3, 5, 2, '#5b5044');
    } else if (d.kind === 'ground') {
      Pixel.rect(P, x, y, d.w, 3, '#d8cfa2');
      Pixel.rect(P, x, y + 3, d.w, 30, '#c0b68c');
      for (var g = 0; g < d.w; g += 17) {
        var gx = x + g + ((g * 7) % 5);
        Pixel.rect(P, gx, y - 3, 1, 3, '#7f9a5c');
        Pixel.rect(P, gx - 1, y - 2, 3, 1, '#7f9a5c');
      }
    } else if (d.kind === 'carpet') {
      Pixel.rect(P, x, y, d.w, 3, '#4a3550');
      Pixel.rect(P, x, y + 3, d.w, 30, '#33253a');
    } else if (d.kind === 'desk') {
      drawDesks(d, x, y);
    } else if (d.kind === 'shelf') {
      Pixel.rect(P, x, y - 1, d.w, 1, '#6a6a86');
      for (var s2 = x + 4; s2 < x + d.w - 4; s2 += 13) {
        Pixel.rect(P, s2, y - 7, 3, 6, '#7a5f3a');
        Pixel.rect(P, s2 + 4, y - 6, 2, 5, '#5a7a8a');
        Pixel.rect(P, s2 + 7, y - 8, 3, 7, '#8a5a5a');
      }
    }
  }

  function drawFreightCar(d, x, y) {
    var body = d.style === 'tank' ? '#b2452f' : (d.style === 'stack' ? '#2f6bb2' : '#3f7a4a');
    var dark = mix(body, '#000000', 0.34), lite = mix(body, '#ffffff', 0.2);
    var h = 186 - d.y;
    Pixel.rect(P, x, y, d.w, h, body);
    Pixel.rect(P, x, y, d.w, 2, lite);
    Pixel.rect(P, x, y + 2, d.w, 1, dark);
    Pixel.frame(P, x, y, d.w, h, '#1b1b22');
    /* vertical panel ribs and rivets - the detail that reads as steel */
    for (var q = x + 5; q < x + d.w - 4; q += 7) Pixel.rect(P, q, y + 4, 1, h - 8, dark);
    for (var rv = x + 3; rv < x + d.w - 2; rv += 5) {
      Pixel.rect(P, rv, y + 3, 1, 1, lite);
      Pixel.rect(P, rv, y + h - 5, 1, 1, lite);
    }
    if (d.style === 'tank') {
      Pixel.rect(P, x + (d.w >> 1) - 7, y - 4, 14, 5, '#8e8e98');
      Pixel.rect(P, x + (d.w >> 1) - 7, y - 4, 14, 1, '#c2c2cc');
    }
    /* bogies under the car */
    Pixel.rect(P, x + 8, y + h, 18, 5, '#25252e');
    Pixel.rect(P, x + d.w - 26, y + h, 18, 5, '#25252e');
    Pixel.disc(P, x + 13, y + h + 4, 3, '#14141a');
    Pixel.disc(P, x + 21, y + h + 4, 3, '#14141a');
    Pixel.disc(P, x + d.w - 21, y + h + 4, 3, '#14141a');
    Pixel.disc(P, x + d.w - 13, y + h + 4, 3, '#14141a');
  }

  function drawDesks(d, x, y) {
    Pixel.rect(P, x, y, d.w, 10, '#3c3c4e');
    Pixel.rect(P, x, y, d.w, 1, '#6a6a86');
    for (var q = 0; q < d.w; q += 34) {
      var bx = x + q + 4;
      if (bx > Pixel.W + 20 || bx < -40) continue;
      /* a cubicle: partition, desk, monitor */
      Pixel.rect(P, bx, y - 14, 22, 14, '#44445a');
      Pixel.rect(P, bx, y - 14, 22, 1, '#5e5e7c');
      Pixel.rect(P, bx + 21, y - 14, 1, 14, '#2c2c3c');
      Pixel.rect(P, bx + 4, y - 8, 9, 6, '#8e96a6');
      Pixel.rect(P, bx + 5, y - 7, 7, 4, '#5ec8e8');
      Pixel.rect(P, bx + 7, y - 2, 3, 2, '#6a6a86');
      Pixel.rect(P, bx + 15, y - 4, 5, 4, '#a08a5a');
    }
  }

  /* -------------------------------------------------------- racers */
  /* Cached per racer: the bake cache is keyed on the map OBJECT, so
     handing it a freshly built one every frame would re-bake every
     sprite every frame and never hit. */
  function racerMaps(r) {
    var state = r.hurtFlash > 0 ? 'hurt' : 'ok';
    if (r._maps && r._mapState === state) return r._maps;
    var d = r.def;
    r._mapState = state;
    r._maps = {
      head: {
        k: d.hair, s: d.skin, t: mix(d.skin, '#000000', 0.2),
        n: mix(d.skin, '#000000', 0.12), m: mix(d.skin, '#000000', 0.4),
        e: '#20232f', o: '#20232f'
      },
      torso: {
        u: d.jacket, d: mix(d.jacket, '#000000', 0.26), l: mix(d.jacket, '#ffffff', 0.18),
        w: d.shirt, a: d.accent, k: mix(d.jacket, '#000000', 0.5)
      },
      shoe: { n: '#20232f', v: '#4a4f60' },
      hand: { s: d.skin, t: mix(d.skin, '#000000', 0.2) },
      limbJacket: mix(d.jacket, '#000000', 0.1),
      limbBack: mix(d.jacket, '#000000', 0.3),
      trousers: d.trousers,
      trousersBack: mix(d.trousers, '#000000', 0.25)
    };
    return r._maps;
  }

  function drawRacer(r, cam) {
    var J = RAG_JOINTS, p = r.rag.p, m = racerMaps(r);
    var ox = -cam.x, oy = -cam.y;
    if (r.x - cam.x < -40 || r.x - cam.x > Pixel.W + 40) return;
    var flip = r.facing !== 1;

    if (r.shield > 0 && Math.floor(r.shield * 10) % 2) {
      Pixel.disc(P, r.x + r.w / 2 + ox, r.y + r.h / 2 + oy, 15, 'rgba(90,170,255,0.30)');
    }

    /* far side limbs first so the body reads in front of them */
    Pixel.limb(P, p[J.CHEST].x + ox, p[J.CHEST].y + oy, p[J.ELB_B].x + ox, p[J.ELB_B].y + oy, 3, m.limbBack);
    Pixel.limb(P, p[J.ELB_B].x + ox, p[J.ELB_B].y + oy, p[J.HAND_B].x + ox, p[J.HAND_B].y + oy, 3, m.limbBack);
    Pixel.stamp(P, ART.HAND, m.hand, p[J.HAND_B].x + ox, p[J.HAND_B].y + oy, 0, flip);
    Pixel.limb(P, p[J.HIP].x + ox, p[J.HIP].y + oy, p[J.KNEE_B].x + ox, p[J.KNEE_B].y + oy, 3, m.trousersBack);
    Pixel.limb(P, p[J.KNEE_B].x + ox, p[J.KNEE_B].y + oy, p[J.FOOT_B].x + ox, p[J.FOOT_B].y + oy, 3, m.trousersBack);
    Pixel.stamp(P, ART.SHOE, m.shoe, p[J.FOOT_B].x + ox, p[J.FOOT_B].y + oy, 0, flip);

    Pixel.limb(P, p[J.HIP].x + ox, p[J.HIP].y + oy, p[J.KNEE_A].x + ox, p[J.KNEE_A].y + oy, 3, m.trousers);
    Pixel.limb(P, p[J.KNEE_A].x + ox, p[J.KNEE_A].y + oy, p[J.FOOT_A].x + ox, p[J.FOOT_A].y + oy, 3, m.trousers);
    Pixel.stamp(P, ART.SHOE, m.shoe, p[J.FOOT_A].x + ox, p[J.FOOT_A].y + oy, 0, flip);

    /* the torso rides the spine, not the collision box */
    var mx = (p[J.CHEST].x + p[J.HIP].x) / 2, my = (p[J.CHEST].y + p[J.HIP].y) / 2;
    var spine = Math.atan2(p[J.CHEST].y - p[J.HIP].y, p[J.CHEST].x - p[J.HIP].x) + Math.PI / 2;
    Pixel.stamp(P, ART.TORSO, m.torso, mx + ox, my + oy, spine, flip);

    var neck = Math.atan2(p[J.HEAD].y - p[J.CHEST].y, p[J.HEAD].x - p[J.CHEST].x) + Math.PI / 2;
    Pixel.stamp(P, ART.HEADS[r.def.head], m.head, p[J.HEAD].x + ox, p[J.HEAD].y + oy, neck, flip);

    Pixel.limb(P, p[J.CHEST].x + ox, p[J.CHEST].y + oy, p[J.ELB_A].x + ox, p[J.ELB_A].y + oy, 3, m.limbJacket);
    Pixel.limb(P, p[J.ELB_A].x + ox, p[J.ELB_A].y + oy, p[J.HAND_A].x + ox, p[J.HAND_A].y + oy, 3, m.limbJacket);
    Pixel.stamp(P, ART.HAND, m.hand, p[J.HAND_A].x + ox, p[J.HAND_A].y + oy, 0, flip);

    /* the wind-up meter, right under the feet where you are looking */
    if (r.winding && r.charge > 0.04) {
      var bx = Math.round(r.x + r.w / 2 + ox) - 7, by = Math.round(r.y + r.h + oy) + 3;
      Pixel.rect(P, bx, by, 14, 3, 'rgba(0,0,0,0.5)');
      Pixel.rect(P, bx + 1, by + 1, Math.round(12 * r.charge), 1,
                 r.charge > 0.86 ? '#ff5e4d' : '#ffc23c');
    }
  }

  /* ---------------------------------------------------------- draw */
  function world(ctx, w, time) {
    P = ctx;
    var L = w.level, cam = { x: Math.round(w.cam.x), y: Math.round(w.cam.y) };
    if (w.shake > 0.4) {
      cam.x += Math.round(U.rand(-w.shake, w.shake));
      cam.y += Math.round(U.rand(-w.shake, w.shake));
    }
    drawSky(L, cam, time);

    var i;
    for (i = 0; i < L.decor.length; i++) if (L.decor[i].kind === 'ground' || L.decor[i].kind === 'carpet') drawDecor(L.decor[i], L, cam, time);
    for (i = 0; i < w.solids.length; i++) drawSolid(w.solids[i], L, cam);
    for (i = 0; i < L.decor.length; i++) if (L.decor[i].kind !== 'ground' && L.decor[i].kind !== 'carpet') drawDecor(L.decor[i], L, cam, time);

    /* the van you are all running for */
    var g = L.goal;
    drawVan(Math.round(g.x - cam.x), Math.round(g.y - cam.y), time);

    for (i = 0; i < w.items.length; i++) {
      var it = w.items[i];
      if (it.cool > 0) continue;
      var ix = Math.round(it.x - cam.x), iy = Math.round(it.y - cam.y + Math.sin(time * 3 + it.bob) * 1.5);
      Pixel.rect(P, ix - 5, iy - 5, 10, 10, 'rgba(20,24,34,0.45)');
      Pixel.frame(P, ix - 5, iy - 5, 10, 10, '#ffc23c');
      Pixel.rect(P, ix - 1, iy - 3, 2, 4, '#ffffff');
      Pixel.rect(P, ix - 1, iy + 2, 2, 2, '#ffffff');
    }

    for (i = 0; i < w.racers.length; i++) drawRacer(w.racers[i], cam);

    for (i = 0; i < w.bombs.length; i++) {
      var b = w.bombs[i];
      Pixel.stamp(P, ART.ITEMS.bomb, ART.ITEM_MAP, b.x - cam.x, b.y - cam.y, 0, false);
      if (Math.floor(b.fuse * 14) % 2) Pixel.rect(P, Math.round(b.x - cam.x) + 2, Math.round(b.y - cam.y) - 4, 1, 1, '#fff3c4');
    }

    for (i = 0; i < w.puffs.length; i++) {
      var pu = w.puffs[i];
      var a = 1 - pu.age / pu.life;
      if (a < 0.34) continue;
      Pixel.rect(P, pu.x - cam.x, pu.y - cam.y, a > 0.7 ? 2 : 1, a > 0.7 ? 2 : 1, pu.col);
    }
  }

  function drawVan(x, y, time) {
    Pixel.rect(P, x, y + 6, 26, 14, '#e8e4d8');
    Pixel.rect(P, x, y + 6, 26, 1, '#ffffff');
    Pixel.rect(P, x + 1, y, 14, 7, '#e8e4d8');
    Pixel.rect(P, x + 2, y + 1, 11, 5, '#6fc7e8');
    Pixel.rect(P, x + 16, y + 9, 9, 7, '#c9c4b6');
    Pixel.frame(P, x, y + 6, 26, 14, '#3a382f');
    Pixel.disc(P, x + 6, y + 20, 3, '#20232f');
    Pixel.disc(P, x + 20, y + 20, 3, '#20232f');
    if (Math.floor(time * 5) % 2) Pixel.rect(P, x + 25, y + 9, 2, 2, '#ffc23c');
  }

  root.Draw = { world: world, backdrop: backdrop, buildScenery: buildScenery, mix: mix, drawVan: drawVan };
})(typeof window !== 'undefined' ? window : globalThis);
