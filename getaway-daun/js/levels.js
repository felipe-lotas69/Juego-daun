/* ============================================================
   levels.js - the three courses.

   Laid out against what a jump can actually do. A full wind-up
   carries about 100 pixels across and lifts about 20, so nothing
   here asks for a step taller than 16 or a gap wider than 60. The
   verifier in tools/ walks each course and says so out loud.
   ============================================================ */
(function (root) {
  'use strict';

  /* a building or a freight car: a top surface with mass under it */
  function block(x, w, top, bottom, type) {
    return { x: x, y: top, w: w, h: bottom - top, type: type || 'solid' };
  }
  function ledge(x, w, y, type) {
    return { x: x, y: y, w: w, h: 3, type: type || 'solid', oneWay: true };
  }

  /* ---------------------------------------------------------- one */
  function rooftopRow() {
    var L = {
      name: 'ROOFTOP ROW',
      theme: 'day',
      width: 2460, height: 230,
      sky: ['#29c7f0', '#29c7f0', '#29c7f0'],
      city: ['#d9cfa8', '#bfa87c', '#8a7350'],
      cityWarm: '#efe7a7', cityCool: '#6b6348',
      spawn: { x: 24, y: 120 },
      goal: { x: 2330, y: 122, w: 26, h: 26 },
      solids: [], items: [], checkpoints: [], decor: []
    };
    var roofs = [
      [0, 170, 150], [200, 120, 142], [350, 90, 150], [480, 110, 134],
      [640, 140, 150], [820, 80, 138], [940, 120, 124], [1110, 160, 142],
      [1310, 90, 130], [1450, 130, 148], [1620, 110, 136], [1780, 160, 150],
      [1990, 120, 140], [2150, 310, 148]
    ];
    /* A roof is a THIN slab with a long drop under it, not a block that
       fills the bottom of the screen. Thirty units is about a character
       and a half - enough to read as a building top, little enough that
       the gaps between them are obviously gaps. */
    var DECK = 30;
    for (var i = 0; i < roofs.length; i++) {
      var r = roofs[i];
      L.solids.push(block(r[0], r[1], r[2], r[2] + DECK));
      L.decor.push({ kind: 'parapet', x: r[0], w: r[1], y: r[2] });
      L.decor.push({ kind: 'facade', x: r[0], w: r[1], y: r[2] + DECK, seed: i });

      /* clutter, thickly: the roof should look worked-on, and every piece
         is something to trip over or hide behind */
      var mid = r[0] + (r[1] >> 1);
      if (i % 3 === 1) L.decor.push({ kind: 'ac', x: r[0] + 14, y: r[2] - 7 });
      if (i % 4 === 2) L.decor.push({ kind: 'vent', x: r[0] + r[1] - 22, y: r[2] - 9 });
      if (i % 2 === 0) L.decor.push({ kind: 'aerial', x: mid, y: r[2] });
      if (i % 5 === 3) L.decor.push({ kind: 'tank', x: r[0] + 20, y: r[2] });
      if (i % 3 === 2) L.decor.push({ kind: 'pipes', x: r[0] + r[1] - 34, y: r[2] });
      if (i % 4 === 1) L.decor.push({ kind: 'chimney', x: mid + 18, y: r[2] });
      if (r[1] > 110) L.decor.push({ kind: 'rail', x: r[0] + 6, w: Math.min(34, r[1] - 12), y: r[2] });
      if (i % 3 === 0) L.decor.push({ kind: 'ladder', x: r[0] + r[1] - 8, y: r[2] + DECK });
      if (i % 5 === 1) L.decor.push({ kind: 'sign', x: mid - 10, y: r[2] + 8, seed: i });
      if (i > 0 && i % 2 === 0) L.checkpoints.push({ x: r[0] + 10, y: r[2] - 22 });
    }
    /* a couple of high ledges worth the risk */
    L.solids.push(ledge(560, 46, 118));
    L.solids.push(ledge(1128, 50, 126));
    L.solids.push(ledge(1830, 54, 134));
    L.solids.push({ x: 1520, y: 144, w: 40, h: 4, type: 'bounce', bounce: 250 });

    L.items.push({ x: 300, y: 130 }, { x: 583, y: 108 }, { x: 880, y: 126 },
                  { x: 1153, y: 116 }, { x: 1500, y: 112 }, { x: 1857, y: 124 },
                  { x: 2060, y: 128 });
    return L;
  }

  /* ---------------------------------------------------------- two */
  function freightLine() {
    var L = {
      name: 'FREIGHT LINE',
      theme: 'desert',
      width: 2520, height: 230,
      sky: ['#49c3ea', '#95dcee', '#cfe6cf'],
      city: ['#d9e0ae', '#cdd69e', '#c0ca8e'],
      cityWarm: '#e6ebc2', cityCool: '#c2e0d8',
      spawn: { x: 22, y: 112 },
      goal: { x: 2390, y: 116, w: 26, h: 26 },
      solids: [], items: [], checkpoints: [], decor: []
    };
    /* the train: cars of two heights, with the couplings as the gaps */
    var cars = [
      [0, 150, 142, 'box'], [176, 132, 142, 'tank'], [334, 150, 142, 'box'],
      [510, 120, 130, 'stack'], [656, 150, 142, 'box'], [832, 132, 142, 'tank'],
      [990, 150, 128, 'stack'], [1166, 132, 142, 'box'], [1324, 150, 142, 'tank'],
      [1500, 120, 128, 'stack'], [1646, 150, 142, 'box'], [1822, 132, 142, 'tank'],
      [1980, 150, 140, 'box'], [2156, 150, 130, 'stack'], [2332, 188, 142, 'box']
    ];
    for (var i = 0; i < cars.length; i++) {
      var c = cars[i];
      L.solids.push(block(c[0], c[1], c[2], 186));
      L.decor.push({ kind: 'car', x: c[0], w: c[1], y: c[2], style: c[3], seed: i });
      if (c[3] === 'stack') {
        /* a container perched on the roof, to climb over rather than past */
        L.solids.push(block(c[0] + 30, 52, c[2] - 16, c[2]));
        L.decor.push({ kind: 'crate', x: c[0] + 30, y: c[2] - 16, w: 52 });
      }
      if (i > 0 && i % 3 === 0) L.checkpoints.push({ x: c[0] + 12, y: c[2] - 22 });
    }
    /* the desert floor under it all - falling costs you a checkpoint */
    L.solids.push(block(0, L.width, 214, 240, 'sand'));
    L.decor.push({ kind: 'ground', x: 0, w: L.width, y: 214 });
    /* the rail the whole train sits on, which is what stops the cars
       looking like they are floating over the sand */
    L.decor.push({ kind: 'rail', x: 0, w: L.width, y: 186 });

    L.items.push({ x: 250, y: 124 }, { x: 560, y: 110 }, { x: 900, y: 124 },
                  { x: 1220, y: 124 }, { x: 1545, y: 108 }, { x: 1880, y: 124 },
                  { x: 2200, y: 110 });
    return L;
  }

  /* -------------------------------------------------------- three */
  function nightOffice() {
    var L = {
      name: 'NIGHT SHIFT',
      theme: 'indoor',
      width: 2420, height: 270,
      sky: ['#14141f', '#1d1d2c', '#262638'],
      city: ['#2a2a3e', '#32324a', '#3a3a56'],
      cityWarm: '#40405c', cityCool: '#2c3348',
      spawn: { x: 22, y: 188 },
      goal: { x: 2300, y: 186, w: 26, h: 26 },
      solids: [], items: [], checkpoints: [], decor: []
    };

    /* Two working heights and a floor under both. Every step is inside
       what a jump can lift (24px) IN BOTH DIRECTIONS - the first cut had
       the floor 26 below the desks, which meant anyone who dropped was
       stuck down there for the rest of the race with no way back up. */
    var DESK = 210, SHELF = 190, FLOOR = 228;
    var desks = [
      [0, 420], [470, 300], [820, 320], [1180, 280],
      [1500, 300], [1860, 300], [2200, 220]
    ];
    var shelves = [
      [150, 260], [560, 200], [900, 240], [1270, 220], [1580, 240], [1930, 260]
    ];

    L.solids.push(block(0, L.width, FLOOR, FLOOR + 26));
    L.decor.push({ kind: 'carpet', x: 0, w: L.width, y: FLOOR });

    for (var i = 0; i < desks.length; i++) {
      var d = desks[i];
      L.solids.push(block(d[0], d[1], DESK, DESK + 14));
      L.decor.push({ kind: 'desk', x: d[0], w: d[1], y: DESK, seed: i });
      if (i > 0) L.checkpoints.push({ x: d[0] + 14, y: DESK - 22 });
    }
    for (var j = 0; j < shelves.length; j++) {
      var sh = shelves[j];
      L.solids.push(ledge(sh[0], sh[1], SHELF));
      L.decor.push({ kind: 'shelf', x: sh[0], w: sh[1], y: SHELF });
    }

    /* the way out, and a pad that flings you at it */
    L.solids.push({ x: 2120, y: 206, w: 40, h: 4, type: 'bounce', bounce: 250 });

    L.items.push({ x: 300, y: 176 }, { x: 640, y: 176 }, { x: 980, y: 176 },
                  { x: 1330, y: 176 }, { x: 1660, y: 176 }, { x: 2010, y: 176 });
    return L;
  }

  root.LEVELS = [rooftopRow(), freightLine(), nightOffice()];
})(typeof window !== 'undefined' ? window : globalThis);
