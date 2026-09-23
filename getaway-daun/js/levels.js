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
    /* A roof is a THIN slab with a building hanging under it, not a block
       that fills the bottom of the screen. Eight units is a parapet and
       its coping - the storeys below are drawn as a facade, so the deck
       reads as the top of a tower without being a grey bar. */
    var DECK = 8;
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
      if (r[1] > 110) L.decor.push({ kind: 'railing', x: r[0] + 6, w: Math.min(34, r[1] - 12), y: r[2] });
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
      spawn: { x: 22, y: 126 },
      goal: { x: 2390, y: 130, w: 26, h: 26 },
      solids: [], items: [], checkpoints: [], decor: []
    };
    /* the train: cars of two heights, with the couplings as the gaps */
    /* Roofs sit 30-odd units over the rail rather than sixty: a wagon
       two and a half characters tall filled half the frame and left no
       room for the yard it is standing in. The heights relative to each
       other are unchanged, so the run over the train is the same one. */
    var cars = [
      [0, 150, 156, 'box'], [176, 132, 156, 'tank'], [334, 150, 156, 'box'],
      [510, 120, 144, 'stack'], [656, 150, 156, 'box'], [832, 132, 156, 'tank'],
      [990, 150, 142, 'stack'], [1166, 132, 156, 'box'], [1324, 150, 156, 'tank'],
      [1500, 120, 142, 'stack'], [1646, 150, 156, 'box'], [1822, 132, 156, 'tank'],
      [1980, 150, 154, 'box'], [2156, 150, 144, 'stack'], [2332, 188, 156, 'box']
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

    L.items.push({ x: 250, y: 138 }, { x: 560, y: 124 }, { x: 900, y: 138 },
                  { x: 1220, y: 138 }, { x: 1545, y: 122 }, { x: 1880, y: 138 },
                  { x: 2200, y: 124 });
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

    L.solids.push(block(0, L.width, FLOOR, FLOOR + 26, 'prop'));
    L.groundY = FLOOR;            /* the window wall stands on it */
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

  /* --------------------------------------------------------- street
     Everything in this one stands on a single flat line. The street is a
     thin strip at the bottom of the frame with no depth to it, and every
     vehicle, bin and building sits exactly on top - nothing is ever drawn
     below or inside the road surface.

     Heights are laid against the jump: a wind-up lifts about 24 units, so
     a bin is 10 up, a taxi roof 14, a bus deck 22, and a shop awning is
     the step that makes a brick roof reachable at all. */
  function downtown() {
    var ST = 104;                 /* the one ground line, and the only one */
    var L = {
      name: 'DOWNTOWN',
      theme: 'day',
      width: 2040, height: 120,
      sky: ['#29c7f0', '#29c7f0', '#29c7f0'],
      city: ['#cdc49f', '#b09a72', '#7e6c4c'],
      cityWarm: '#ded4a2', cityCool: '#655c46',
      spawn: { x: 26, y: ST - 20 },
      goal: { x: 1940, y: ST - 20, w: 30, h: 20 },
      solids: [], items: [], checkpoints: [], decor: []
    };
    L.solids.push(block(0, L.width, ST, ST + 16, 'street'));
    L.groundY = ST;               /* the far skyline stands on it too */

    /* Every climb on this street is one step of sixteen, and every solid
       piece is the same height from BOTH sides. That second rule is the
       one that matters: a racer shoved off the back of a bus has to be
       able to get over it again, and a face taller than a jump lifts is
       where the race quietly ends. The buildings themselves are backdrop
       - the pavement runs in front of them - so the only things on the
       brickwork you can stand on are the shop awning and the air-con box
       bolted to the wall above it. */
    var STEP = 16;
    var plan = [
      ['taxi', 130], ['brick', 260], ['fence', 396], ['bus', 470],
      ['bin', 600], ['brick', 680], ['taxi', 830], ['hoarding', 906],
      ['bus', 990], ['brick', 1130], ['bin', 1280], ['taxi', 1360],
      ['bus', 1470], ['fence', 1596], ['brick', 1670], ['bin', 1850],
      ['hoarding', 1890]
    ];
    var bricks = 0;
    for (var i = 0; i < plan.length; i++) {
      var kind = plan[i][0], x = plan[i][1];
      if (kind === 'taxi') {
        L.solids.push(block(x, 36, ST - 14, ST, 'prop'));
        L.decor.push({ kind: 'taxi', x: x, y: ST, seed: i });
      } else if (kind === 'bin') {
        L.solids.push(block(x, 20, ST - 12, ST, 'prop'));
        L.decor.push({ kind: 'dumpster', x: x, y: ST });
        L.decor.push({ kind: 'bags', x: x + 22, y: ST, seed: i });
      } else if (kind === 'bus') {
        /* a Routemaster: open platform at either end, upper deck between
           them, so it is a staircase from whichever side you arrive */
        L.solids.push(block(x, 14, ST - STEP, ST, 'prop'));
        L.solids.push(block(x + 14, 48, ST - STEP * 2, ST, 'prop'));
        L.solids.push(block(x + 62, 14, ST - STEP, ST, 'prop'));
        L.decor.push({ kind: 'bus', x: x, y: ST });
        L.items.push({ x: x + 38, y: ST - STEP * 2 - 10 });
      } else if (kind === 'brick') {
        var w = 84 + (i % 3) * 8;
        L.decor.push({ kind: 'brick', x: x, w: w, y: ST, red: (bricks++ % 2) === 1, seed: i, back: true });
        /* the shops take the left half; the right half stays plain wall,
           which is what the air-con box is bolted to */
        L.decor.push({ kind: 'shopfront', x: x + 2, w: 54, y: ST, seed: i, back: true });
        /* both one-way, so neither is ever a wall in the running lane */
        L.solids.push(ledge(x + 4, 46, ST - STEP, 'prop'));
        L.solids.push(ledge(x + 56, 18, ST - STEP * 2, 'prop'));
        L.decor.push({ kind: 'awning', x: x + 4, w: 46, y: ST - STEP, seed: i });
        L.decor.push({ kind: 'wallbox', x: x + 56, w: 18, y: ST - STEP * 2 });
        L.decor.push({ kind: 'shopdoor', x: x + 60, w: 14, y: ST, seed: i, back: true });
        L.items.push({ x: x + 64, y: ST - STEP * 2 - 10 });
        L.checkpoints.push({ x: x - 30, y: ST - 20 });
      } else if (kind === 'fence') {
        L.decor.push({ kind: 'fence', x: x, w: 62, y: ST });
      } else if (kind === 'hoarding') {
        L.decor.push({ kind: 'hoarding', x: x, w: 56, y: ST, seed: i });
      }
    }

    L.items.push({ x: 380, y: ST - 12 }, { x: 930, y: ST - 12 },
                  { x: 1620, y: ST - 12 });
    return L;
  }

  root.LEVELS = [downtown(), rooftopRow(), freightLine(), nightOffice()];
})(typeof window !== 'undefined' ? window : globalThis);
