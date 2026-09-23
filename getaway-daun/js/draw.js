/* ============================================================
   draw.js - painting the world into the 320x180 buffer.

   The thing that makes a small frame look like a place rather than
   a bar chart is DENSITY: a sky in bands, three layers of skyline
   with real window grids, parapets, aerials, lamp posts, rivets.
   None of it costs gameplay and all of it costs one pixel.
   ============================================================ */
(function (root) {
  'use strict';

  var P = null;   /* the canvas context, set each frame */

  var ROCKET = ['.ffbbn', 'ffbbbn', '.ffbbn'];
  var ROCKET_MAP = { b: '#d8d3c6', n: '#ff6a4d', f: '#ffbe50' };

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
      var minH = 11 + layer * 6, maxH = 24 + layer * 11;
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

    /* Flat, saturated cyan - no gradient. The only softness in the sky is
       a pale sun glow tucked into one corner. */
    sc.fillStyle = L.sky[0];
    sc.fillRect(0, 0, W, H);

    if (L.theme === 'indoor') return;

    var sunG = sc.createRadialGradient(W * 0.84, H * 0.10, 0, W * 0.84, H * 0.10, H * 0.55);
    sunG.addColorStop(0, 'rgba(255,248,206,0.46)');
    sunG.addColorStop(0.55, 'rgba(255,246,190,0.13)');
    sunG.addColorStop(1, 'rgba(255,246,190,0)');
    sc.fillStyle = sunG;
    sc.fillRect(0, 0, W, H);
  }

  /* ---------------------------------------------------------- sky */
  function drawSky(L, cam, time) {
    var sc = buildScenery(L);
    /* Each place gets its own horizon. A freight yard in the desert had
       a city skyline behind it, which is the kind of thing that makes a
       level look assembled rather than designed. */
    if (L.theme !== 'indoor') drawClouds(L, cam, sc, time);
    if (L.theme === 'desert') drawScrub(L, cam, sc);
    else {
      drawSkyline(L, cam, sc);
      if (L.theme !== 'indoor') { drawStreet(L, cam); drawPosts(L, cam, sc); }
    }
  }

  /* Lamp posts along the horizon. They sit between the skyline and the
     play area and are most of what gives the distance a floor. */
  function drawPosts(L, cam, sc) {
    /* street lamps stand on the ground line like everything else. Pinned
       to a fraction of the frame instead, they hang in the sky the
       moment the camera pulls back. */
    var baseY = L.groundY !== undefined
      ? Math.round(L.groundY - cam.y) - 1
      : Math.round(Pixel.H - 30 - 2 * 4 - cam.y * 0.17);
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

  /* Chunky clouds, in world units like everything else, so they share the
     art scale with the characters instead of being smooth shapes pasted
     behind them. Three tones and a slow drift of their own. */
  function drawClouds(L, cam, sc, time) {
    for (var i = 0; i < sc.clouds.length; i++) {
      var c = sc.clouds[i];
      var cx = Math.round(((c.x + time * c.sp) % (L.width + 400)) - cam.x * 0.16 - 80);
      var w = c.w;
      if (cx < -w * 2 || cx > Pixel.W + w) continue;
      var cy = Math.round(c.y - cam.y * 0.06);
      Pixel.rect(P, cx, cy, w, 4, '#ffffff');
      Pixel.rect(P, cx + 4, cy - 3, w - 11, 3, '#ffffff');
      Pixel.rect(P, cx + 9, cy - 6, w - 20, 3, '#f2fbff');
      Pixel.rect(P, cx + 2, cy + 4, w - 5, 2, '#d8eefc');
      Pixel.rect(P, cx + 7, cy + 6, w - 15, 1, '#c3e3f6');
    }
  }

  /* The street the whole skyline stands on: a flat pale strip with one
     darker curb line, running under everything. */
  function drawStreet(L, cam) {
    /* One line. Everything in the picture stands on it - the racers, the
       bus, the far skyline - and nothing is ever drawn below it except
       more of it. A course that names its own ground line gets that;
       the rooftop courses, which have no single floor, keep the thin
       band near the bottom of the frame for the skyline to sit on. */
    var y = L.groundY !== undefined
      ? Math.round(L.groundY - cam.y)
      : Math.round(Pixel.H * 0.88 - U.clamp(cam.y * 0.05, -6, 6));
    Pixel.rect(P, -170, y, Pixel.W + 340, 280, '#cfcac1');
    Pixel.rect(P, -170, y, Pixel.W + 340, 1, '#a9a399');
    if (L.groundY === undefined) return;
    Pixel.rect(P, -170, y + 5, Pixel.W + 340, 1, '#bdb8af');      /* the kerb */
    var first = Math.floor((cam.x - 140) / 130) * 130;
    for (var gx = first; gx < cam.x + Pixel.W * 2.2; gx += 130) {
      var sx = Math.round(gx - cam.x);
      Pixel.rect(P, sx, y + 8, 9, 3, '#bdb8af');                  /* drain */
      Pixel.rect(P, sx + 1, y + 9, 7, 1, '#a9a399');
    }
  }

  function drawSkyline(L, cam, sc) {
    /* three skyline layers, each slower and paler than the one in front */
    var par = [0.10, 0.20, 0.34];
    for (var l = 0; l < 3; l++) {
      var band = sc.layers[l], col = L.city[l];
      var winLit = L.theme === 'indoor' ? '#6a6a96' : mix(col, '#ffffff', 0.55);
      var winDark = mix(col, '#000000', 0.10);
      /* Low and far. The sky owns the top 55-60% of the frame, so the
         base is pinned near the bottom and the parallax drift is clamped
         - a background building must never reach the top of the screen. */
      var baseY = L.groundY !== undefined
        ? Math.round(L.groundY - cam.y) - l
        : Math.round(Pixel.H * 0.88 - l * 3 - U.clamp(cam.y * par[l] * 0.4, -10, 10));
      /* Warm and low, not hazy and blue. Distance is carried by the
         palette getting darker and browner, and by parallax, rather than
         by fading everything into the sky. */
      var haze = 0;
      var sky = L.sky[0];
      for (var k = 0; k < band.length; k++) {
        var bd = band[k];
        var bx = Math.round(bd.x - cam.x * par[l]);
        if (bx > Pixel.W + 8 || bx + bd.w < -8) continue;
        var by = baseY - bd.h;
        /* Each block leans a little cream or a little blue. A skyline in
           one flat colour reads as a bar chart however many windows you
           put on it; the variation is what makes it a city. */
        var face = mix(col, bd.lit > 0.5 ? L.cityWarm : L.cityCool, Math.abs(bd.lit - 0.5) * 1.4);
        if (haze) face = mix(face, sky, haze);
        Pixel.rect(P, bx, by, bd.w, bd.h + 60, face);
        Pixel.rect(P, bx + bd.w - 1, by, 1, bd.h + 60, mix(face, '#000000', 0.05));
        Pixel.rect(P, bx, by, bd.w, 1, mix(face, '#ffffff', 0.22));
        if (bd.cap) Pixel.rect(P, bx + (bd.w >> 1) - 1, by - 4, 2, 4, mix(face, '#000000', 0.12));
        /* Windows are LIGHTER than the wall and stand in neat columns -
           glass catching the sky, not holes punched in a facade. */
        /* A regular grid of small panes. Scattering them at random and
           making them large read as damage rather than as windows. */
        /* windows fade out with the rest of it */
        /* window grids in a light blue-grey, the way glass reads warm brick */
        var lit = L.theme === 'indoor' ? winLit : mix(face, '#b8cdd8', 0.62);
        var cols = Math.floor((bd.w - 2) / 4);
        var inset = Math.max(1, (bd.w - cols * 4 + 2) >> 1);
        for (var wy = by + 4; wy < by + bd.h - 3; wy += 5) {
          for (var ci = 0; ci < cols; ci++) {
            var wx = bx + inset + ci * 4;
            var key = (ci * 5 + Math.round(wy) * 3) % 13;
            Pixel.rect(P, wx, wy, 2, 3, key === 0 ? mix(face, '#000000', 0.06) : lit);
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
  /* Parses BOTH '#rrggbb' and the 'rgb(r,g,b)' that mix() itself returns.
     Without the second case a chained mix - shading a colour that was
     already blended - ran parseInt over 'rgb(...)', got NaN, and produced
     black. Every haze tint and every derived edge tone was coming out as
     a black smear. */
  function hex(c) {
    if (hexCache[c]) return hexCache[c];
    var out;
    if (c.charAt(0) === '#') {
      var h = c.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var n = parseInt(h, 16);
      out = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    } else {
      var m = /(-?\d+)\D+(-?\d+)\D+(-?\d+)/.exec(c);
      out = m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
    }
    hexCache[c] = out;
    return out;
  }

  /* ------------------------------------------------------ terrain */
  /* Measured off the reference: a flat neutral slab with a single dark
     lip. The first cut had warm tan with staggered brick courses, which
     at this size is just noise competing with the racers. */
  var FACE = {
    day:    { lip: '#8e8578', body: '#cfc7b6', low: '#b0a795', edge: '#2b2b30' },
    desert: { lip: '#6b6152', body: '#bdb5a4', low: '#a49c8c', edge: '#312c24' },
    indoor: { lip: '#1d1d28', body: '#3f3f52', low: '#33333f', edge: '#12121a' }
  };

  function drawSolid(s, L, cam) {
    var f = FACE[L.theme] || FACE.day;
    var x = Math.round(s.x - cam.x), y = Math.round(s.y - cam.y);
    if (x > Pixel.W * 1.9 || x + s.w < -Pixel.W * 0.5) return;
    /* A taxi is drawn as a taxi. The generic slab under one would only
       show as a grey box poking out of the bodywork, so the pieces on
       the street opt out and their decor does the drawing. */
    if (s.type === 'prop' || s.type === 'street') return;
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
    /* Flat colour and ONE slightly darker shade for depth. No black
       keyline: the reference has none anywhere, and an outline at this
       pixel size reads as grime rather than as definition. */
    Pixel.rect(P, x, y, s.w, s.h, f.body);
    Pixel.rect(P, x, y, s.w, 2, f.lip);
    Pixel.rect(P, x, y + s.h - 2, s.w, 2, f.low);
  }

  /* --------------------------------------------------------- decor */
  function drawDecor(d, L, cam, time) {
    var x = Math.round(d.x - cam.x), y = Math.round(d.y - cam.y);
    if (x > Pixel.W * 1.9 || x + (d.w || 30) < -Pixel.W * 0.5) return;
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
    } else if (d.kind === 'taxi') {
      /* a cab: flat yellow, one darker shade, glass in pale blue. Nothing
         pokes above y-14, which is the line you stand on. */
      Pixel.rect(P, x + 9, y - 14, 18, 6, '#f2c230');
      Pixel.rect(P, x + 10, y - 13, 7, 4, '#a9dcef');
      Pixel.rect(P, x + 19, y - 13, 7, 4, '#a9dcef');
      Pixel.rect(P, x + 15, y - 14, 6, 1, '#f0ece2');       /* roof sign */
      Pixel.rect(P, x + 1, y - 9, 34, 9, '#f2c230');
      Pixel.rect(P, x + 1, y - 8, 10, 3, '#2b2b30');        /* chequer band */
      Pixel.rect(P, x + 3, y - 8, 2, 3, '#f2c230');
      Pixel.rect(P, x + 7, y - 8, 2, 3, '#f2c230');
      Pixel.rect(P, x + 1, y - 3, 34, 2, '#d3a221');
      Pixel.rect(P, x + 4, y - 3, 7, 3, '#2b2b30');
      Pixel.rect(P, x + 25, y - 3, 7, 3, '#2b2b30');
      Pixel.rect(P, x + 33, y - 8, 2, 2, '#f4e6a8');
    } else if (d.kind === 'bus') {
      /* A Routemaster, and the same shape you can stand on: cab roof at
         y-16, upper deck at y-32, open platform at the back at y-16. */
      Pixel.rect(P, x, y - 16, 76, 16, '#d8402f');
      Pixel.rect(P, x + 14, y - 32, 48, 16, '#d8402f');
      Pixel.rect(P, x, y - 16, 76, 1, '#f0ece2');
      Pixel.rect(P, x + 14, y - 32, 48, 1, '#f0ece2');
      Pixel.rect(P, x, y - 4, 76, 2, '#a62c20');
      var wq;
      for (wq = 0; wq < 4; wq++) {
        Pixel.rect(P, x + 18 + wq * 11, y - 30, 8, 7, '#bfe4f2');
        Pixel.rect(P, x + 18 + wq * 11, y - 25, 8, 2, '#3f6fbf');
      }
      for (wq = 0; wq < 4; wq++) {
        Pixel.rect(P, x + 16 + wq * 11, y - 14, 8, 7, '#bfe4f2');
        Pixel.rect(P, x + 16 + wq * 11, y - 9, 8, 2, '#3f6fbf');
      }
      Pixel.rect(P, x + 1, y - 14, 11, 4, '#f0ece2');       /* destination blind */
      Pixel.rect(P, x + 2, y - 13, 9, 2, '#43403c');
      Pixel.rect(P, x + 64, y - 14, 10, 14, '#7a2418');     /* open platform */
      Pixel.rect(P, x + 64, y - 14, 10, 1, '#a62c20');
      Pixel.rect(P, x + 8, y - 3, 9, 3, '#2b2b30');
      Pixel.rect(P, x + 56, y - 3, 9, 3, '#2b2b30');
    } else if (d.kind === 'brick') {
      /* Backdrop, not something you climb: the pavement runs in front of
         it, so it is drawn from the kerb straight up and off the top of
         the frame. Flat brick, one darker tone, no outline anywhere. */
      var base = d.red ? '#c04f39' : '#f0e2a0';
      var dark = d.red ? '#a54331' : '#dccd8a';
      var mortar = d.red ? '#d0705a' : '#fcf3bd';
      var top = -12;
      if (y <= top) return;
      Pixel.rect(P, x, top, d.w, y - top, base);
      for (var by2 = y - 5; by2 > top; by2 -= 5) Pixel.rect(P, x, by2, d.w, 1, mortar);
      Pixel.rect(P, x, y - 32, d.w, 32, dark);              /* shop storey */
      Pixel.rect(P, x - 2, y - 36, d.w + 4, 4, '#f4f1e6');  /* cornice */
      Pixel.rect(P, x - 1, y - 33, d.w + 2, 1, '#d9d4c4');
      Pixel.rect(P, x + d.w - 5, y - 36, 2, 36, '#8d8471');  /* drainpipe */
      Pixel.rect(P, x + d.w - 6, y - 36, 4, 2, '#a49a85');
      for (var uy = y - 56; uy > top + 2; uy -= 22) {
        for (var ux = x + 9; ux < x + d.w - 14; ux += 21) {
          Pixel.rect(P, ux, uy, 12, 14, '#8fb4c9');
          Pixel.rect(P, ux, uy, 12, 2, '#b9d3e0');
          Pixel.rect(P, ux, uy + 6, 12, 1, '#6d92a8');
          Pixel.rect(P, ux - 1, uy + 14, 14, 2, '#f4f1e6');
        }
      }
    } else if (d.kind === 'shopfront') {
      /* A cutaway, the length of the building: the wall that would hide
         the ground floor is simply not drawn, so the whole parade of
         shops is open to the street. */
      Pixel.rect(P, x, y - 26, d.w, 26, '#33291f');
      Pixel.rect(P, x, y - 26, d.w, 1, '#1f1913');
      var bay, bw = 24, bays = Math.max(1, Math.round(d.w / bw));
      bw = Math.floor(d.w / bays);
      for (bay = 0; bay < bays; bay++) {
        var bxx = x + bay * bw, seed = (d.seed || 0) + bay;
        Pixel.rect(P, bxx + 1, y - 24, bw - 2, 23, seed % 2 ? '#54463a' : '#4a4033');
        if (seed % 3 === 0) {
          /* a doorway, lit from inside */
          Pixel.rect(P, bxx + 6, y - 20, 9, 20, '#8c6a41');
          Pixel.rect(P, bxx + 6, y - 20, 9, 1, '#b08b58');
          Pixel.rect(P, bxx + 12, y - 12, 2, 2, '#e8c87a');
        } else {
          Pixel.rect(P, bxx + 2, y - 10, bw - 4, 4, '#7a5f3a');        /* counter */
          Pixel.rect(P, bxx + 3, y - 21, 6, 7, seed % 2 ? '#d8c9a0' : '#c47a4a');
          Pixel.rect(P, bxx + 11, y - 21, 6, 7, seed % 2 ? '#8fb46a' : '#d8c9a0');
          Pixel.rect(P, bxx + 3, y - 13, bw - 7, 1, '#6b5436');
        }
      }
      var sgn = ['#d8402f', '#3f7fd8', '#e8a72c', '#46a86a'][(d.seed || 0) % 4];
      Pixel.rect(P, x - 2, y - 32, d.w + 4, 6, sgn);                   /* fascia */
      Pixel.rect(P, x + 4, y - 30, d.w - 14, 2, '#f4f1e6');
      Pixel.rect(P, x - 2, y - 27, d.w + 4, 1, mix(sgn, '#000000', 0.3));
    } else if (d.kind === 'awning') {
      /* hangs BELOW the line you stand on, so the canopy and the ledge
         are the same object from either side of the screen */
      Pixel.rect(P, x, y, d.w, 4, '#efe7d2');
      for (var aw = 0; aw < d.w; aw += 8) Pixel.rect(P, x + aw, y, 4, 4, '#d8402f');
      Pixel.rect(P, x, y + 4, d.w, 1, '#b3a58c');
    } else if (d.kind === 'shopdoor') {
      /* the way in upstairs: a recessed door with a fanlight over it */
      Pixel.rect(P, x, y - 22, d.w, 22, '#4a3c2c');
      Pixel.rect(P, x + 2, y - 20, d.w - 4, 20, '#7a5f3a');
      Pixel.rect(P, x + 2, y - 20, d.w - 4, 3, '#c6d8e0');
      Pixel.rect(P, x + 4, y - 16, d.w - 8, 1, '#6b5436');
      Pixel.rect(P, x + 4, y - 9, d.w - 8, 1, '#6b5436');
      Pixel.rect(P, x + d.w - 5, y - 11, 2, 2, '#e8c87a');
      Pixel.rect(P, x - 1, y - 24, d.w + 2, 2, '#f4f1e6');
    } else if (d.kind === 'wallbox') {
      Pixel.rect(P, x, y, d.w, 10, '#9aa2ae');
      Pixel.rect(P, x, y, d.w, 2, '#bcc3cd');
      Pixel.rect(P, x + 2, y + 4, d.w - 4, 1, '#6f7681');
      Pixel.rect(P, x + 2, y + 6, d.w - 4, 1, '#6f7681');
      Pixel.rect(P, x, y + 10, d.w, 1, '#6f7681');
    } else if (d.kind === 'fence') {
      /* Chain-link, with the yard's clutter stacked against the near side
         of it. Drawing the mesh OVER the pallets turned them into a
         chequerboard; in front, the wire only ever crosses sky. */
      var fy, fx2;
      for (fy = y - 18; fy < y; fy++) {
        for (fx2 = x; fx2 < x + d.w; fx2++) {
          if ((fx2 + fy) % 4 === 0 || (fx2 - fy + 400) % 4 === 0) {
            Pixel.rect(P, fx2, fy, 1, 1, 'rgba(226,234,240,0.38)');
          }
        }
      }
      Pixel.rect(P, x, y - 19, d.w, 2, '#9aa3ab');            /* top rail */
      for (var fp = x; fp <= x + d.w; fp += 20) Pixel.rect(P, fp, y - 19, 2, 19, '#9aa3ab');
      Pixel.rect(P, x + 4, y - 15, 18, 15, '#a8814e');        /* pallets */
      Pixel.rect(P, x + 4, y - 15, 18, 2, '#c49a60');
      Pixel.rect(P, x + 4, y - 10, 18, 2, '#8c6a3d');
      Pixel.rect(P, x + 4, y - 5, 18, 2, '#8c6a3d');
      Pixel.rect(P, x + 26, y - 11, 16, 11, '#c8892c');       /* a skip */
      Pixel.rect(P, x + 26, y - 11, 16, 2, '#e0a84a');
      Pixel.rect(P, x + 27, y - 14, 6, 3, '#6b5a44');
      Pixel.rect(P, x + 46, y - 9, 8, 9, '#4a6f9a');          /* a drum */
      Pixel.rect(P, x + 46, y - 9, 8, 2, '#6a91bd');
    } else if (d.kind === 'hoarding') {
      /* an advertising hoarding on legs - flat colour, big type-block */
      var hc = ['#d8402f', '#3f7fd8', '#e8a72c', '#46a86a'][(d.seed || 0) % 4];
      Pixel.rect(P, x + 6, y - 6, 3, 6, '#6d6459');
      Pixel.rect(P, x + d.w - 9, y - 6, 3, 6, '#6d6459');
      Pixel.rect(P, x, y - 30, d.w, 24, hc);
      Pixel.rect(P, x, y - 30, d.w, 2, mix(hc, '#ffffff', 0.3));
      Pixel.rect(P, x, y - 8, d.w, 2, mix(hc, '#000000', 0.25));
      Pixel.rect(P, x + 4, y - 26, d.w - 20, 5, '#f4f1e6');
      Pixel.rect(P, x + 4, y - 19, d.w - 30, 3, 'rgba(255,255,255,0.65)');
      Pixel.rect(P, x + 4, y - 14, d.w - 24, 3, 'rgba(255,255,255,0.45)');
    } else if (d.kind === 'dumpster') {
      Pixel.rect(P, x, y - 12, 20, 12, '#3f7a5c');
      Pixel.rect(P, x, y - 12, 20, 2, '#579a76');
      Pixel.rect(P, x, y - 6, 20, 1, '#2e5f46');
      Pixel.rect(P, x + 2, y - 2, 3, 2, '#2b2b30');
      Pixel.rect(P, x + 15, y - 2, 3, 2, '#2b2b30');
    } else if (d.kind === 'bags') {
      Pixel.rect(P, x, y - 6, 7, 6, '#2f2f38');
      Pixel.rect(P, x + 1, y - 7, 5, 1, '#2f2f38');
      Pixel.rect(P, x + 8, y - 5, 6, 5, '#26262e');
      Pixel.rect(P, x + 9, y - 6, 4, 1, '#26262e');
    } else if (d.kind === 'facade') {
      /* the tower under a roof deck: it runs off the bottom of the frame,
         so the deck reads as the top of a building rather than a bar
         floating in the sky */
      /* warm, so a tower reads as brick standing in the same city as the
         skyline behind it rather than as a slab of concrete */
      var fb = L.theme === 'indoor' ? mix(f.body, '#000000', 0.30) : mix(L.city[2], '#ffffff', 0.12);
      var fd = mix(fb, '#000000', 0.16);
      Pixel.rect(P, x, y, d.w, 220, fb);
      Pixel.rect(P, x, y, d.w, 1, mix(f.body, '#000000', 0.52));
      Pixel.rect(P, x + d.w - 2, y, 2, 220, fd);
      var fcols = Math.max(1, Math.floor((d.w - 6) / 11));
      var finset = Math.max(3, (d.w - fcols * 11) >> 1);
      for (var fwy = y + 6; fwy < y + 190; fwy += 13) {
        for (var fci = 0; fci < fcols; fci++) {
          var fwx = x + finset + fci * 11;
          var key2 = (fci * 7 + fwy * 3 + (d.seed || 0) * 5) % 11;
          Pixel.rect(P, fwx, fwy, 6, 7, key2 === 0 ? '#f0c063' : '#a8c6d8');
          Pixel.rect(P, fwx, fwy, 6, 1, key2 === 0 ? '#ffe2a2' : '#c9dde8');
        }
      }
    } else if (d.kind === 'tank') {
      /* a water tank on legs */
      Pixel.rect(P, x + 1, y - 4, 2, 4, '#4a4237');
      Pixel.rect(P, x + 11, y - 4, 2, 4, '#4a4237');
      Pixel.rect(P, x, y - 17, 14, 13, '#8a6f4a');
      Pixel.rect(P, x, y - 17, 14, 2, '#a98a5e');
      Pixel.rect(P, x, y - 12, 14, 1, '#5e4a2f');
      Pixel.rect(P, x, y - 8, 14, 1, '#5e4a2f');
      Pixel.rect(P, x + 4, y - 20, 6, 3, '#6b573a');
    } else if (d.kind === 'pipes') {
      Pixel.rect(P, x, y - 9, 3, 9, '#77808c');
      Pixel.rect(P, x, y - 11, 3, 2, '#99a2ae');
      Pixel.rect(P, x + 6, y - 14, 3, 14, '#77808c');
      Pixel.rect(P, x + 6, y - 16, 3, 2, '#99a2ae');
      Pixel.rect(P, x, y - 9, 9, 2, '#5f6771');
    } else if (d.kind === 'chimney') {
      Pixel.rect(P, x, y - 15, 7, 15, '#7a6152');
      Pixel.rect(P, x - 1, y - 17, 9, 2, '#8e7261');
      Pixel.rect(P, x, y - 11, 7, 1, '#5d4839');
      Pixel.rect(P, x, y - 6, 7, 1, '#5d4839');
    } else if (d.kind === 'ladder') {
      Pixel.rect(P, x, y - 12, 1, 14, '#6d7682');
      Pixel.rect(P, x + 4, y - 12, 1, 14, '#6d7682');
      for (var lr = y - 11; lr < y + 2; lr += 3) Pixel.rect(P, x, lr, 5, 1, '#8a949f');
    } else if (d.kind === 'sign') {
      var sc2 = ['#d8483d', '#3f7fd8', '#e8b23c'][(d.seed || 0) % 3];
      Pixel.rect(P, x + 3, y - 10, 1, 10, '#45403a');
      Pixel.rect(P, x, y - 18, 14, 9, sc2);
      Pixel.frame(P, x, y - 18, 14, 9, '#2b2b30');
      Pixel.rect(P, x + 2, y - 16, 10, 2, 'rgba(255,255,255,0.7)');
      Pixel.rect(P, x + 2, y - 13, 7, 2, 'rgba(255,255,255,0.45)');
    } else if (d.kind === 'rail') {
      /* the freight track */
      Pixel.rect(P, x, y, d.w, 3, '#1b1b22');
      Pixel.rect(P, x, y + 3, d.w, 1, '#3a3630');
      for (var sl = 0; sl < d.w; sl += 9) Pixel.rect(P, x + sl, y + 3, 5, 2, '#5b5044');
    } else if (d.kind === 'railing') {
      /* a safety railing along a roof edge */
      Pixel.rect(P, x, y - 9, d.w, 1, '#8a949f');
      Pixel.rect(P, x, y - 5, d.w, 1, '#767f8a');
      for (var pst = x; pst < x + d.w; pst += 8) Pixel.rect(P, pst, y - 9, 1, 9, '#6d7682');
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

  /* ---------------------------------------------------------- guns
     Built from the weapon's own barrel length, so the thing in your hand
     is the same size as the thing the maths uses. */
  var gunCache = {};
  function gunSprite(key, def) {
    var hit = gunCache[key];
    if (hit) return hit;
    var n = Math.max(3, Math.round(def.len));
    var bar = new Array(n + 1).join('B');
    var gap = new Array(n).join('.');
    var out = {
      rows: [
        '.' + new Array(n + 1).join('H'),
        'G' + bar,
        'G' + bar,
        'GG' + gap,
        '.G' + gap
      ],
      map: { H: '#9aa2b4', B: def.body, G: '#20232f' }
    };
    gunCache[key] = out;
    return out;
  }

  function drawGun(r, cam) {
    if (!r.weapon) return;
    var def = WEAPONS[r.weapon.key];
    if (!def) return;
    var g = gunSprite(r.weapon.key, def);
    var a = Guns.aimOf(r);
    var c = r.centre();
    var gx = c.x + Math.cos(a) * (def.len * 0.45) - cam.x;
    var gy = c.y + Math.sin(a) * (def.len * 0.45) - cam.y;
    Pixel.stamp(P, g.rows, g.map, gx, gy, a, false);

    if (r.flash > 0) {
      var m = Guns.muzzle(r, def);
      Pixel.disc(P, m.x - cam.x, m.y - cam.y, def.pellets > 1 ? 4 : 3, '#fff3c4');
      Pixel.disc(P, m.x - cam.x, m.y - cam.y, 2, '#ffffff');
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
    if (r.x - cam.x < -60 || r.x - cam.x > Pixel.W * 1.9) return;
    var flip = r.facing !== 1;

    if (r.shield > 0 && Math.floor(r.shield * 10) % 2) {
      Pixel.disc(P, r.x + r.w / 2 + ox, r.y + r.h / 2 + oy, 15, 'rgba(90,170,255,0.30)');
    }

    /* far side limbs first so the body reads in front of them */
    Pixel.limb(P, p[J.CHEST].x + ox, p[J.CHEST].y + oy, p[J.ELB_B].x + ox, p[J.ELB_B].y + oy, 2, m.limbBack);
    Pixel.limb(P, p[J.ELB_B].x + ox, p[J.ELB_B].y + oy, p[J.HAND_B].x + ox, p[J.HAND_B].y + oy, 2, m.limbBack);
    Pixel.stamp(P, ART.HAND, m.hand, p[J.HAND_B].x + ox, p[J.HAND_B].y + oy, 0, flip);
    /* ONE leg column, not two. These are plank-like people: the trousers
       are a single block from the hips down, ending in a dark shoe. Two
       separate legs at this size read as a spider, and they lose the
       stiff, tipping-over silhouette the whole look rests on. */
    var kx = (p[J.KNEE_A].x + p[J.KNEE_B].x) / 2, ky = (p[J.KNEE_A].y + p[J.KNEE_B].y) / 2;
    var fx = (p[J.FOOT_A].x + p[J.FOOT_B].x) / 2, fy = (p[J.FOOT_A].y + p[J.FOOT_B].y) / 2;
    Pixel.limb(P, p[J.HIP].x + ox, p[J.HIP].y + oy, kx + ox, ky + oy, 5, m.trousers);
    Pixel.limb(P, kx + ox, ky + oy, fx + ox, fy + oy, 5, m.trousers);
    Pixel.stamp(P, ART.SHOE, m.shoe, fx + ox, fy + oy, 0, flip);

    /* the torso rides the spine, not the collision box */
    var mx = (p[J.CHEST].x + p[J.HIP].x) / 2, my = (p[J.CHEST].y + p[J.HIP].y) / 2;
    var spine = Math.atan2(p[J.CHEST].y - p[J.HIP].y, p[J.CHEST].x - p[J.HIP].x) + Math.PI / 2;
    Pixel.stamp(P, ART.TORSO, m.torso, mx + ox, my + oy, spine, flip);

    var neck = Math.atan2(p[J.HEAD].y - p[J.CHEST].y, p[J.HEAD].x - p[J.CHEST].x) + Math.PI / 2;
    Pixel.stamp(P, ART.HEADS[r.def.head], m.head, p[J.HEAD].x + ox, p[J.HEAD].y + oy, neck, flip);

    Pixel.limb(P, p[J.CHEST].x + ox, p[J.CHEST].y + oy, p[J.ELB_A].x + ox, p[J.ELB_A].y + oy, 2, m.limbJacket);
    Pixel.limb(P, p[J.ELB_A].x + ox, p[J.ELB_A].y + oy, p[J.HAND_A].x + ox, p[J.HAND_A].y + oy, 2, m.limbJacket);
    Pixel.stamp(P, ART.HAND, m.hand, p[J.HAND_A].x + ox, p[J.HAND_A].y + oy, 0, flip);
    drawGun(r, cam);

    /* No meter under the feet. The wind-up already shows in the body:
       the further you have leaned, the longer you have held it. */
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
    /* three passes: what stands behind the street, the street and the
       structure itself, then everything parked on it */
    for (i = 0; i < L.decor.length; i++) if (L.decor[i].back) drawDecor(L.decor[i], L, cam, time);
    for (i = 0; i < L.decor.length; i++) if (!L.decor[i].back && (L.decor[i].kind === 'ground' || L.decor[i].kind === 'carpet')) drawDecor(L.decor[i], L, cam, time);
    for (i = 0; i < w.solids.length; i++) drawSolid(w.solids[i], L, cam);
    for (i = 0; i < L.decor.length; i++) if (!L.decor[i].back && L.decor[i].kind !== 'ground' && L.decor[i].kind !== 'carpet') drawDecor(L.decor[i], L, cam, time);

    /* the van you are all running for */
    var g = L.goal;
    drawVan(Math.round(g.x - cam.x), Math.round(g.y - cam.y), time);

    for (i = 0; i < w.items.length; i++) {
      var it = w.items[i];
      if (it.cool > 0) continue;
      var ix = Math.round(it.x - cam.x), iy = Math.round(it.y - cam.y + Math.sin(time * 3 + it.bob) * 1.5);
      /* a solid crate, not a translucent plate: nothing in this style is
         see-through, and a dark pane floating over the street reads as a
         hole in the picture */
      Pixel.rect(P, ix - 5, iy - 5, 10, 10, '#c98a3f');
      Pixel.rect(P, ix - 5, iy - 5, 10, 2, '#e0a85a');
      Pixel.rect(P, ix - 5, iy + 3, 10, 2, '#a86f2f');
      Pixel.rect(P, ix - 1, iy - 3, 2, 6, '#fff3c4');
      Pixel.rect(P, ix - 3, iy - 1, 6, 2, '#fff3c4');
    }

    for (i = 0; i < w.racers.length; i++) drawRacer(w.racers[i], cam);

    for (i = 0; i < w.bullets.length; i++) {
      var bu = w.bullets[i];
      if (bu.def.explosive) {
        /* a rocket, nose first, with its exhaust trailing behind */
        var ra = Math.atan2(bu.vy, bu.vx);
        Pixel.stamp(P, ROCKET, ROCKET_MAP, bu.x - cam.x, bu.y - cam.y, ra, false);
      } else {
        Pixel.rect(P, bu.x - cam.x - 1, bu.y - cam.y - 0.5, 2.5, 1, '#fff3c4');
      }
    }

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
