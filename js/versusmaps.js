/* ============================================================
   versusmaps.js - the three race maps the match rotates through

   Same movement budget as the campaign (gap <= 270, rise <= the
   measured envelope), but every map has to carry: verticality or a
   real challenge, ways to die that are not another player, and
   invisible checkpoints strung along the route so a death costs you
   position rather than the whole run.
   ============================================================ */
(function (root) {
  'use strict';

  function P(x, y, w, h, type) { return { x: x, y: y, w: w, h: h, type: type || 'solid' }; }
  function G(x, y, w, h) { return { x: x, y: y, w: w, h: h }; }
  /* invisible checkpoint: a wide trigger volume you cross without noticing */
  function CP(x, y, w, h) { return { x: x, y: y, invisible: true, w: w || 90, h: h || 150 }; }

  var VERSUS_MAPS = [

    /* ================================================================
       ROOFTOP DASH - a flat-out sprint with one very bad elevator
       ================================================================ */
    {
      name: 'ROOFTOP DASH',
      sky: ['#1d2748', '#4a3355', '#a05a4e'],
      width: 3460, height: 1060,
      spawns: [{ x: 70, y: 760 }, { x: 150, y: 760 }, { x: 230, y: 760 }, { x: 310, y: 760 }],
      platforms: [
        P(-60, 0, 60, 1060),
        P(0, 760, 520, 300),
        P(700, 760, 300, 300),
        P(1060, 690, 300, 20, 'metal'),
        P(1400, 620, 260, 20, 'metal'),
        P(1760, 620, 240, 20, 'metal'),
        P(2160, 690, 240, 20, 'metal'),
        P(2440, 660, 80, 16, 'metal'),            /* stepping stone */
        P(2560, 620, 200, 20, 'metal'),
        P(2900, 540, 560, 520),
        P(3460, 0, 60, 1060)
      ],
      glass: [
        G(520, 760, 180, 16),
        G(1660, 620, 100, 14),
        G(2400, 690, 160, 14)
      ],
      elevators: [
        /* the piston. it is on a timer and it does not care about you. */
        { x: 1820, y: 400, w: 120, h: 44, by: 576, mode: 'auto', speed: 300, wait: 2.0, crusher: true },
        { x: 2760, y: 604, w: 140, h: 16, bx: 2900, by: 524, mode: 'auto', speed: 125, wait: 0.5 }
      ],
      hazards: [
        { type: 'saw', x: 1140, y: 653, w: 74, h: 74, bx: 1200, by: 653, speed: 150 },
        { type: 'saw', x: 2180, y: 653, w: 74, h: 74, bx: 2260, by: 653, speed: 165 }
      ],
      crates: [
        { x: 760, y: 726, w: 34, h: 34 },
        { x: 794, y: 726, w: 34, h: 34, explosive: true }
      ],
      pickups: [
        { x: 260, y: 736, key: 'pistol' },
        { x: 860, y: 736, key: 'shotgun' },
        { x: 1500, y: 596, key: 'smg' },
        { x: 1860, y: 596, key: 'rocket' },
        { x: 2620, y: 596, key: 'shotgun' },
        { x: 3000, y: 516, key: 'smg' }
      ],
      checkpoints: [
        CP(760, 760), CP(1100, 690), CP(1500, 620), CP(1620, 620),
        CP(2370, 690), CP(2640, 620), CP(3000, 540)
      ],
      hints: [
        { x: 260, y: 700, text: 'first to the van' },
        { x: 1880, y: 500, text: 'mind the piston' }
      ],
      goal: { x: 3200, y: 472 }
    },

    /* ================================================================
       THE SPIRE - straight up, over a lava floor that never moves
       ================================================================ */
    {
      name: 'THE SPIRE',
      sky: ['#101528', '#241b3d', '#4a2447'],
      width: 1560, height: 2460,
      spawns: [{ x: 560, y: 2200 }, { x: 650, y: 2200 }, { x: 790, y: 2200 }, { x: 890, y: 2200 }],
      platforms: [
        P(-60, 0, 60, 2460),
        P(1560, 0, 60, 2460),
        P(500, 2200, 500, 90),

        P(300, 2120, 180, 18, 'metal'),
        P(560, 2060, 240, 18, 'metal'),
        P(900, 2000, 280, 18, 'metal'),
        P(1200, 1990, 180, 16, 'metal'),      /* safe landing beside the lift shaft */

        P(1200, 1790, 300, 18, 'metal'),
        P(860, 1720, 260, 18, 'metal'),
        P(380, 1650, 260, 18, 'metal'),
        P(120, 1580, 260, 18, 'metal'),

        P(400, 1540, 80, 16, 'metal'),            /* stepping stone */
        P(500, 1500, 240, 18, 'metal'),
        P(900, 1430, 240, 18, 'metal'),
        P(1240, 1360, 260, 18, 'metal'),

        P(1240, 1150, 280, 18, 'metal'),
        P(880, 1080, 240, 18, 'metal'),
        P(520, 1020, 240, 18, 'metal'),
        P(220, 960, 240, 18, 'metal'),

        P(100, 720, 300, 18, 'metal'),
        P(540, 660, 240, 18, 'metal'),
        P(920, 600, 240, 18, 'metal'),

        P(560, 380, 760, 26)
      ],
      glass: [
        G(700, 1720, 160, 14),
        G(740, 1500, 160, 14),
        G(1120, 1150, 120, 14),
        G(460, 960, 120, 14),
        G(400, 720, 140, 14)
      ],
      elevators: [
        { x: 1400, y: 1974, w: 160, h: 16, by: 1810, mode: 'auto', speed: 115, wait: 0.9 },
        /* a piston guarding the halfway ledge */
        { x: 190, y: 1380, w: 120, h: 40, by: 1540, mode: 'auto', speed: 285, wait: 2.1, crusher: true },
        { x: 1240, y: 1344, w: 170, h: 16, by: 1134, mode: 'auto', speed: 120, wait: 0.7 },
        { x: 20, y: 944, w: 180, h: 16, by: 702, mode: 'auto', speed: 125, wait: 0.8 },
        { x: 1340, y: 564, w: 170, h: 16, by: 364, mode: 'auto', speed: 130, wait: 0.7 }
      ],
      hazards: [
        { type: 'lava', x: -60, y: 2380, w: 1680, h: 80 },
        { type: 'saw', x: 820, y: 1683, w: 74, h: 74, bx: 960, by: 1683, speed: 170 },
        { type: 'saw', x: 1260, y: 1113, w: 74, h: 74, bx: 1400, by: 1113, speed: 185 },
        { type: 'saw', x: 580, y: 623, w: 74, h: 74, bx: 700, by: 623, speed: 175 }
      ],
      crates: [
        { x: 620, y: 2166, w: 34, h: 34 },
        { x: 1300, y: 1756, w: 34, h: 34, explosive: true }
      ],
      pickups: [
        { x: 700, y: 2176, key: 'pistol' },
        { x: 1040, y: 1976, key: 'smg' },
        { x: 1320, y: 1766, key: 'shotgun' },
        { x: 600, y: 1476, key: 'rocket' },
        { x: 960, y: 1406, key: 'medkit' },
        { x: 600, y: 996, key: 'smg' },
        { x: 200, y: 696, key: 'shotgun' },
        { x: 1000, y: 576, key: 'rocket' }
      ],
      checkpoints: [
        CP(390, 2120, 200, 130), CP(680, 2060, 240, 130), CP(1040, 2000, 260, 130),
        CP(1340, 1790, 300, 130), CP(1080, 1720, 240, 130), CP(500, 1650, 240, 130),
        CP(600, 1500, 220, 130), CP(1000, 1430, 240, 130), CP(1360, 1360, 260, 130),
        CP(1000, 1080, 240, 130), CP(300, 960, 240, 130),
        CP(240, 720, 300, 130), CP(1040, 600, 240, 130)
      ],
      hints: [
        { x: 700, y: 2140, text: 'up. all the way up.' },
        { x: 250, y: 1530, text: 'it comes down fast' }
      ],
      goal: { x: 640, y: 312 }
    },

    /* ================================================================
       FOUNDRY - lava, pistons, and a lot of things that spin
       ================================================================ */
    {
      name: 'FOUNDRY',
      sky: ['#2b1016', '#63201a', '#9c4420'],
      width: 2900, height: 1340,
      spawns: [{ x: 70, y: 1020 }, { x: 150, y: 1020 }, { x: 230, y: 1020 }, { x: 310, y: 1020 }],
      platforms: [
        P(-60, 0, 60, 1340),
        P(0, 1020, 460, 320),
        P(620, 1020, 260, 320),
        P(900, 990, 90, 16, 'metal'),            /* stepping stone over the lava */
        P(1040, 950, 240, 20, 'metal'),
        P(1420, 1020, 260, 320),
        P(1700, 990, 90, 16, 'metal'),
        P(1840, 950, 220, 20, 'metal'),
        P(2200, 1020, 300, 320),

        P(620, 700, 240, 20, 'metal'),
        P(1000, 630, 240, 20, 'metal'),
        P(1400, 700, 240, 20, 'metal'),
        P(1780, 630, 240, 20, 'metal'),
        P(2120, 560, 220, 20, 'metal'),
        P(2500, 480, 400, 860),
        P(2900, 0, 60, 1340),

        P(200, 1008, 90, 12, 'bounce')
      ],
      glass: [
        G(1280, 950, 140, 16),
        G(2060, 950, 140, 16),
        G(860, 700, 140, 14),
        G(1240, 630, 160, 14),
        G(2020, 630, 140, 14)
      ],
      elevators: [
        { x: 460, y: 1004, w: 160, h: 16, bx: 460, by: 684, mode: 'auto', speed: 130, wait: 0.9 },
        /* two pistons on the lower route */
        { x: 1100, y: 740, w: 120, h: 40, by: 890, mode: 'auto', speed: 290, wait: 2.0, crusher: true },
        { x: 1890, y: 740, w: 120, h: 40, by: 890, mode: 'auto', speed: 270, wait: 2.2, crusher: true },
        { x: 2340, y: 1004, w: 140, h: 16, by: 464, mode: 'auto', speed: 150, wait: 0.8 }
      ],
      hazards: [
        { type: 'lava', x: -60, y: 1260, w: 3020, h: 80 },
        { type: 'saw', x: 700, y: 663, w: 74, h: 74, bx: 820, by: 663, speed: 175 },
        { type: 'saw', x: 1460, y: 663, w: 74, h: 74, bx: 1580, by: 663, speed: 190 },
        { type: 'saw', x: 1060, y: 593, w: 74, h: 74, bx: 1180, by: 593, speed: 160 },
        { type: 'saw', x: 2200, y: 523, w: 74, h: 74, bx: 2340, by: 523, speed: 180 }
      ],
      crates: [
        { x: 680, y: 986, w: 34, h: 34, explosive: true },
        { x: 1480, y: 986, w: 34, h: 34 },
        { x: 1514, y: 986, w: 34, h: 34, explosive: true },
        { x: 2260, y: 986, w: 34, h: 34 }
      ],
      pickups: [
        { x: 240, y: 996, key: 'pistol' },
        { x: 720, y: 996, key: 'smg' },
        { x: 700, y: 676, key: 'rocket' },
        { x: 1500, y: 996, key: 'shotgun' },
        { x: 1100, y: 606, key: 'medkit' },
        { x: 1880, y: 926, key: 'smg' },
        { x: 1860, y: 606, key: 'shotgun' },
        { x: 2280, y: 536, key: 'rocket' },
        { x: 2600, y: 456, key: 'medkit' }
      ],
      checkpoints: [
        CP(680, 1020), CP(1500, 1020), CP(2280, 1020),
        CP(655, 700), CP(1030, 630), CP(1430, 700), CP(1860, 630), CP(2150, 560), CP(2600, 480)
      ],
      hints: [
        { x: 240, y: 960, text: 'high road or low road' },
        { x: 1160, y: 860, text: 'timing' }
      ],
      goal: { x: 2660, y: 412 }
    }
  ];

  root.VERSUS_MAPS = VERSUS_MAPS;
})(typeof window !== 'undefined' ? window : globalThis);
