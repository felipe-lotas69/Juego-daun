/* ============================================================
   levels.js - hand built levels, pure data

   Movement budget used while laying these out:
     hop chain .......... ~360 px/s top speed, ~30 px of lift
     running jump ....... ~300 px across, ~75 px up
     standing jump ...... ~125 px up, almost no travel
     bounce pad ......... ~150 px up minimum, more if you land fast
   So: gaps stay <= 200 px, steps <= 75 px, and anything taller
   gets an elevator, a bounce pad or a ladder of ledges.
   ============================================================ */
(function (root) {
  'use strict';

  function P(x, y, w, h, type) { return { x: x, y: y, w: w, h: h, type: type || 'solid' }; }
  function G(x, y, w, h) { return { x: x, y: y, w: w, h: h }; }

  var LEVELS = [

    /* ================================================================
       1 - SERVICE ENTRANCE : teaches hop, jump, pick up, elevator, glass
       ================================================================ */
    {
      name: 'SERVICE ENTRANCE',
      sky: ['#2fb6ea', '#86d4f0', '#d5c9a2', 'rgba(92,80,58,0.30)'],
      theme: 'city',
      width: 2680, height: 880,
      spawn: { x: 90, y: 700 },
      platforms: [
        P(-60, 0, 60, 880, 'solid'),
        P(0, 700, 780, 180, 'solid'),
        P(780, 660, 120, 220, 'solid'),
        P(1080, 660, 340, 220, 'solid'),
        P(1380, 790, 300, 90, 'solid'),          /* catch ledge under the glass */
        P(1560, 778, 70, 12, 'bounce'),
        P(1680, 660, 240, 220, 'solid'),
        P(2030, 380, 650, 500, 'solid')
      ],
      glass: [
        G(1420, 660, 160, 16)
      ],
      elevators: [
        { x: 1920, y: 644, w: 110, h: 16, by: 380, mode: 'auto', speed: 95, wait: 1.1 }
      ],
      crates: [
        { x: 1180, y: 626, w: 34, h: 34 },
        { x: 1214, y: 626, w: 34, h: 34 }
      ],
      pickups: [
        { x: 640, y: 676, key: 'pistol' }
      ],
      enemies: [
        { x: 1790, y: 660, weapon: 'pistol', patrol: 70, facing: -1 }
      ],
      hazards: [],
      checkpoints: [
        { x: 1120, y: 660 }, { x: 1720, y: 660 }
      ],
      hints: [
        { x: 120, y: 620, text: 'A / D  to lean and hop' },
        { x: 620, y: 600, text: 'R  picks things up' },
        { x: 830, y: 560, text: 'W  jumps where you lean' },
        { x: 1440, y: 600, text: 'glass does not hold' },
        { x: 1960, y: 560, text: 'ride it' }
      ],
      goal: { x: 2400, y: 312 }
    },

    /* ================================================================
       2 - GLASS TOWER : vertical climb, shotgun, lots of breaking
       ================================================================ */
    {
      name: 'GLASS TOWER',
      sky: ['#38bced', '#8ed8f2', '#c9d2dc', 'rgba(56,78,102,0.30)'],
      theme: 'office',
      width: 1760, height: 1900,
      spawn: { x: 110, y: 1780 },
      platforms: [
        P(-60, 0, 60, 1900, 'solid'),
        P(1760, 0, 60, 1900, 'solid'),
        P(0, 1780, 1760, 120, 'solid'),

        P(200, 1706, 230, 18, 'metal'),
        P(540, 1632, 220, 18, 'metal'),
        P(880, 1570, 220, 18, 'metal'),
        P(1230, 1558, 200, 18, 'metal'),

        P(1430, 1470, 330, 18, 'metal'),
        P(1040, 1396, 240, 18, 'metal'),
        P(700, 1334, 220, 18, 'metal'),
        P(330, 1322, 220, 18, 'metal'),

        P(60, 1240, 240, 18, 'metal'),
        P(280, 1100, 300, 20, 'solid'),          /* landing off the lift */
        P(470, 1030, 200, 18, 'metal'),
        P(820, 1030, 220, 18, 'metal'),

        P(1180, 950, 260, 18, 'metal'),
        P(1500, 870, 260, 18, 'metal'),
        P(1180, 790, 220, 18, 'metal'),
        P(830, 730, 220, 18, 'metal'),

        P(430, 670, 260, 18, 'metal'),
        P(280, 580, 300, 18, 'metal'),

        P(280, 300, 400, 30, 'solid'),
        P(760, 300, 1000, 30, 'solid')
      ],
      glass: [
        G(430, 1322, 270, 14),                   /* the gap between two ledges */
        G(1040, 1030, 140, 14),
        G(1400, 950, 100, 14),
        G(690, 670, 140, 14),
        G(680, 300, 80, 30),                     /* the pane between the two roof halves */
        G(580, 1100, 110, 20)
      ],
      elevators: [
        { x: 60, y: 1222, w: 180, h: 16, by: 1116, mode: 'auto', speed: 80, wait: 1.0 },
        { x: 60, y: 542, w: 180, h: 18, by: 300, mode: 'call', speed: 105, label: 'ROOF' }
      ],
      crates: [
        { x: 900, y: 1524, w: 34, h: 34 },
        { x: 1500, y: 1436, w: 34, h: 34 },
        { x: 1534, y: 1436, w: 34, h: 34 }
      ],
      pickups: [
        { x: 620, y: 1608, key: 'pistol' },
        { x: 1540, y: 1446, key: 'shotgun' },
        { x: 900, y: 1006, key: 'medkit' },
        { x: 1600, y: 846, key: 'shotgun' }
      ],
      enemies: [
        { x: 1300, y: 1558, weapon: 'pistol', patrol: 60, facing: -1 },
        { x: 1250, y: 950, weapon: 'pistol', patrol: 80, facing: -1 },
        { x: 900, y: 730, weapon: 'smg', patrol: 60, facing: 1 },
        { x: 520, y: 670, weapon: 'pistol', patrol: 70, facing: -1 }
      ],
      hazards: [],
      checkpoints: [
        { x: 1520, y: 1470 }, { x: 320, y: 1100 }, { x: 1250, y: 790 }, { x: 330, y: 580 }
      ],
      hints: [
        { x: 130, y: 1700, text: 'up we go' },
        { x: 470, y: 1270, text: 'shoot the glass, or trust it' },
        { x: 150, y: 520, text: 'R at the lift' }
      ],
      goal: { x: 1500, y: 232 }
    },

    /* ================================================================
       3 - ELEVATOR SHAFT : call buttons, pressure plates, doors
       ================================================================ */
    {
      name: 'ELEVATOR SHAFT',
      sky: ['#45a8dc', '#8cc8e4', '#bab4a6', 'rgba(70,68,64,0.32)'],
      theme: 'industrial',
      width: 3000, height: 1500,
      spawn: { x: 90, y: 1340 },
      platforms: [
        P(-60, 0, 60, 1500, 'solid'),
        P(0, 1340, 620, 160, 'solid'),
        P(760, 1340, 300, 160, 'solid'),
        P(1060, 1270, 40, 230, 'solid'),

        P(1230, 1270, 330, 20, 'metal'),
        P(1560, 1200, 40, 300, 'solid'),

        P(1700, 1120, 300, 20, 'metal'),
        P(2120, 1120, 260, 20, 'metal'),

        P(1700, 900, 680, 20, 'metal'),
        P(1280, 845, 300, 20, 'metal'),
        P(880, 790, 300, 20, 'metal'),
        P(440, 735, 320, 20, 'metal'),

        P(300, 420, 460, 24, 'solid'),
        P(1000, 420, 300, 24, 'solid'),
        P(1600, 360, 380, 24, 'solid'),
        P(2200, 300, 800, 24, 'solid'),
        P(2960, 0, 40, 1500, 'solid')
      ],
      glass: [
        G(620, 1340, 140, 16),
        G(2000, 1120, 120, 16),
        G(1300, 420, 300, 24),
        G(1980, 360, 220, 24)
      ],
      elevators: [
        { x: 2380, y: 1104, w: 150, h: 16, by: 884, mode: 'call', speed: 120, id: 'lift2' },
        { x: 1560, y: 1048, w: 140, h: 16, bx: 2120, by: 1048, mode: 'auto', speed: 115, wait: 0.7 },
        { x: 120, y: 690, w: 160, h: 18, by: 444, mode: 'call', speed: 125, id: 'lift3' },
        { x: 760, y: 420, w: 240, h: 18, bx: 1000, by: 420, mode: 'auto', speed: 95, wait: 0.9 }
      ],
      doors: [
        { x: 2080, y: 980, w: 40, h: 140, id: 'door1', slide: 'up' },
        { x: 2650, y: 180, w: 40, h: 120, id: 'door2', slide: 'up' }
      ],
      buttons: [
        { x: 1900, y: 1098, target: 'door1' },
        { x: 2380, y: 286, target: 'door2', plate: true, w: 66, h: 14 }
      ],
      crates: [
        { x: 2280, y: 1086, w: 34, h: 34 },
        { x: 1350, y: 811, w: 34, h: 34 },
        { x: 1384, y: 811, w: 34, h: 34, explosive: true }
      ],
      pickups: [
        { x: 400, y: 1316, key: 'pistol' },
        { x: 1350, y: 1250, key: 'smg' },
        { x: 1850, y: 880, key: 'medkit' },
        { x: 2250, y: 276, key: 'shotgun' }
      ],
      enemies: [
        { x: 900, y: 1340, weapon: 'pistol', patrol: 80, facing: -1 },
        { x: 1400, y: 1270, weapon: 'pistol', patrol: 70, facing: -1 },
        { x: 1900, y: 900, weapon: 'smg', patrol: 100, facing: -1 },
        { x: 2250, y: 900, weapon: 'pistol', patrol: 60, facing: -1 },
        { x: 1700, y: 360, weapon: 'smg', patrol: 90, facing: 1 },
        { x: 2880, y: 300, weapon: 'pistol', patrol: 70, facing: -1 }
      ],
      hazards: [
        { type: 'spike', x: 1100, y: 1460, w: 460, h: 40 },
        { type: 'spike', x: 2120, y: 1460, w: 400, h: 40 }
      ],
      checkpoints: [
        { x: 800, y: 1340 }, { x: 1750, y: 1120 }, { x: 1750, y: 900 }, { x: 350, y: 420 }, { x: 2260, y: 300 }
      ],
      hints: [
        { x: 1920, y: 1050, text: 'R the switch' },
        { x: 200, y: 640, text: 'R calls the lift' },
        { x: 2400, y: 240, text: 'stand here' }
      ],
      goal: { x: 2800, y: 232 }
    },

    /* ================================================================
       4 - COLD STORAGE : saws, ice, spikes, SMG
       ================================================================ */
    {
      name: 'COLD STORAGE',
      sky: ['#6fd0ee', '#a6e4f6', '#cfe6ee', 'rgba(66,100,122,0.28)'],
      theme: 'ice',
      width: 3400, height: 1200,
      spawn: { x: 90, y: 1000 },
      platforms: [
        P(-60, 0, 60, 1200, 'solid'),
        P(0, 1000, 520, 200, 'solid'),
        P(640, 1000, 300, 200, 'ice'),
        P(1060, 940, 280, 260, 'ice'),
        P(1460, 940, 200, 20, 'metal'),
        P(1660, 870, 180, 20, 'metal'),
        P(1960, 870, 380, 20, 'ice'),
        P(2460, 800, 220, 20, 'metal'),
        P(2460, 1060, 480, 140, 'solid'),
        P(2800, 730, 260, 20, 'metal'),
        P(3060, 660, 340, 540, 'solid'),
        P(1400, 1130, 200, 12, 'bounce'),
        P(800, 930, 90, 14, 'metal'),
        P(3360, 0, 40, 1200, 'solid')
      ],
      glass: [
        G(940, 1000, 120, 16),
        G(1840, 870, 120, 16),
        G(2340, 800, 120, 16),
        G(2680, 730, 120, 16)
      ],
      elevators: [
        { x: 2680, y: 1044, w: 120, h: 16, by: 784, mode: 'call', speed: 120 },
        { x: 520, y: 984, w: 120, h: 16, bx: 640, by: 984, mode: 'auto', speed: 90, wait: 0.6 }
      ],
      hazards: [
        { type: 'spike', x: 940, y: 1160, w: 460, h: 40 },
        { type: 'saw', x: 1163, y: 903, w: 74, h: 74, bx: 1163, by: 903, speed: 0 },
        { type: 'saw', x: 1862, y: 700, w: 74, h: 74, bx: 1862, by: 940, speed: 150 },
        { type: 'saw', x: 2000, y: 833, w: 74, h: 74, bx: 2266, by: 833, speed: 170 },
        { type: 'spike', x: 1660, y: 1160, w: 700, h: 40 },
        { type: 'saw', x: 2860, y: 693, w: 74, h: 74, bx: 2960, by: 693, speed: 120 }
      ],
      crates: [
        { x: 700, y: 966, w: 34, h: 34 },
        { x: 2500, y: 766, w: 34, h: 34 },
        { x: 2900, y: 696, w: 34, h: 34, explosive: true }
      ],
      pickups: [
        { x: 300, y: 976, key: 'smg' },
        { x: 1540, y: 916, key: 'medkit' },
        { x: 2560, y: 776, key: 'smg' },
        { x: 3140, y: 636, key: 'shotgun' }
      ],
      enemies: [
        { x: 1560, y: 940, weapon: 'smg', patrol: 30, facing: -1 },
        { x: 1750, y: 870, weapon: 'pistol', patrol: 40, facing: -1 },
        { x: 2600, y: 1060, weapon: 'smg', patrol: 120, facing: -1 },
        { x: 2570, y: 800, weapon: 'pistol', patrol: 40, facing: -1 },
        { x: 3200, y: 660, weapon: 'smg', patrol: 80, facing: -1 }
      ],
      checkpoints: [
        { x: 700, y: 1000 }, { x: 1500, y: 940 }, { x: 1750, y: 870 }, { x: 2830, y: 730 }
      ],
      hints: [
        { x: 660, y: 940, text: 'ice keeps your momentum' },
        { x: 1420, y: 1080, text: 'boing' }
      ],
      goal: { x: 3180, y: 592 }
    },

    /* ================================================================
       5 - MELTDOWN : lava, rockets, rocket jumps
       ================================================================ */
    {
      name: 'MELTDOWN',
      sky: ['#ef7a3a', '#f4a86c', '#b8623c', 'rgba(58,20,12,0.32)'],
      theme: 'lava',
      width: 3200, height: 1250,
      spawn: { x: 90, y: 980 },
      platforms: [
        P(-60, 0, 60, 1250, 'solid'),
        P(0, 980, 480, 270, 'solid'),
        P(640, 980, 240, 270, 'solid'),
        P(1020, 910, 200, 20, 'metal'),
        P(1380, 980, 260, 270, 'solid'),
        P(1800, 890, 220, 20, 'metal'),
        P(2160, 980, 300, 270, 'solid'),
        P(1020, 620, 260, 20, 'metal'),
        P(1500, 560, 260, 20, 'metal'),
        P(2000, 500, 260, 20, 'metal'),
        P(2460, 440, 300, 20, 'metal'),
        P(2760, 380, 440, 870, 'solid'),
        P(300, 700, 200, 20, 'metal'),
        P(640, 640, 200, 20, 'metal'),
        P(3160, 0, 40, 1250, 'solid')
      ],
      glass: [
        G(880, 980, 140, 18),
        G(1640, 980, 160, 18),
        G(1280, 620, 220, 18),
        G(2260, 500, 200, 18)
      ],
      elevators: [
        { x: 2460, y: 964, w: 140, h: 16, by: 424, mode: 'call', speed: 130 },
        { x: 480, y: 964, w: 160, h: 16, bx: 480, by: 684, mode: 'auto', speed: 100, wait: 1.0 }
      ],
      hazards: [
        { type: 'lava', x: 0, y: 1190, w: 3200, h: 60 },
        { type: 'saw', x: 1440, y: 800, w: 74, h: 74, bx: 1700, by: 800, speed: 180 },
        { type: 'spike', x: 2000, y: 1150, w: 160, h: 40 }
      ],
      crates: [
        { x: 700, y: 946, w: 34, h: 34, explosive: true },
        { x: 1450, y: 946, w: 34, h: 34 },
        { x: 1484, y: 946, w: 34, h: 34, explosive: true },
        { x: 2300, y: 946, w: 34, h: 34 }
      ],
      pickups: [
        { x: 260, y: 956, key: 'pistol' },
        { x: 400, y: 676, key: 'rocket' },
        { x: 1120, y: 886, key: 'medkit' },
        { x: 1900, y: 866, key: 'rocket' },
        { x: 2300, y: 476, key: 'shotgun' },
        { x: 2600, y: 416, key: 'medkit' }
      ],
      enemies: [
        { x: 760, y: 980, weapon: 'smg', patrol: 70, facing: -1 },
        { x: 1500, y: 980, weapon: 'shotgun', patrol: 90, facing: -1 },
        { x: 2260, y: 980, weapon: 'smg', patrol: 100, facing: -1 },
        { x: 1100, y: 620, weapon: 'pistol', patrol: 70, facing: 1 },
        { x: 2080, y: 500, weapon: 'smg', patrol: 80, facing: -1 },
        { x: 2900, y: 380, weapon: 'shotgun', patrol: 90, facing: -1 }
      ],
      checkpoints: [
        { x: 700, y: 980 }, { x: 1420, y: 980 }, { x: 2200, y: 980 }, { x: 2500, y: 440 }
      ],
      hints: [
        { x: 340, y: 640, text: 'aim down. fire. fly.' },
        { x: 2480, y: 390, text: 'R' }
      ],
      goal: { x: 2980, y: 312 }
    },

    /* ================================================================
       6 - THE VAULT : teleporter, doors, the long way out
       ================================================================ */
    {
      name: 'THE VAULT',
      sky: ['#2f9fd8', '#7cc4e6', '#c2bda8', 'rgba(58,58,70,0.30)'],
      theme: 'vault',
      width: 3600, height: 1400,
      spawn: { x: 90, y: 1180 },
      platforms: [
        P(-60, 0, 60, 1400, 'solid'),
        P(0, 1180, 560, 220, 'solid'),
        P(700, 1180, 360, 220, 'solid'),
        P(1060, 1140, 40, 260, 'solid'),
        P(1200, 1100, 280, 20, 'metal'),
        P(1620, 1030, 280, 20, 'metal'),
        P(2040, 1180, 420, 220, 'solid'),
        P(2600, 1100, 240, 20, 'metal'),
        P(2940, 1180, 660, 220, 'solid'),

        P(2940, 820, 660, 24, 'solid'),
        P(2460, 760, 320, 24, 'metal'),
        P(2000, 700, 300, 24, 'metal'),
        P(1540, 640, 300, 24, 'metal'),
        P(1060, 580, 300, 24, 'metal'),
        P(560, 520, 320, 24, 'metal'),
        P(60, 460, 340, 24, 'solid'),

        P(600, 240, 700, 24, 'solid'),
        P(1480, 240, 420, 24, 'solid'),
        P(2140, 180, 1460, 24, 'solid'),
        P(3560, 0, 40, 1400, 'solid')
      ],
      glass: [
        G(560, 1180, 140, 18),
        G(1480, 1030, 140, 18),
        G(2780, 760, 160, 24),
        G(2300, 700, 160, 24),
        G(1840, 640, 160, 24),
        G(1360, 580, 180, 24),
        G(880, 520, 180, 24),
        G(1300, 240, 180, 24),
        G(1900, 180, 240, 24)
      ],
      elevators: [
        { x: 1900, y: 1014, w: 140, h: 16, bx: 1900, by: 1164, mode: 'auto', speed: 70, wait: 0.8 },
        { x: 2840, y: 1164, w: 100, h: 16, bx: 2840, by: 804, mode: 'call', speed: 150, id: 'liftA' },
        { x: 400, y: 444, w: 160, h: 18, bx: 400, by: 224, mode: 'call', speed: 130, id: 'liftB' },
        { x: 2460, y: 1164, w: 140, h: 16, bx: 2600, by: 1084, mode: 'auto', speed: 120, wait: 0.5 }
      ],
      doors: [
        { x: 1480, y: 940, w: 40, h: 90, id: 'vaultA', slide: 'up' },
        { x: 3300, y: 60, w: 40, h: 120, id: 'vaultB', slide: 'up' }
      ],
      buttons: [
        { x: 1300, y: 1078, target: 'vaultA' },
        { x: 2200, y: 166, target: 'vaultB', plate: true, w: 70, h: 14 }
      ],
      crates: [
        { x: 300, y: 1146, w: 34, h: 34 },
        { x: 2250, y: 1146, w: 34, h: 34, explosive: true },
        { x: 2284, y: 1146, w: 34, h: 34 },
        { x: 3200, y: 786, w: 34, h: 34 }
      ],
      pickups: [
        { x: 200, y: 1156, key: 'pistol' },
        { x: 1300, y: 1076, key: 'smg' },
        { x: 2200, y: 1156, key: 'shotgun' },
        { x: 3100, y: 796, key: 'teleport' },
        { x: 1700, y: 616, key: 'medkit' },
        { x: 700, y: 496, key: 'rocket' },
        { x: 2400, y: 156, key: 'medkit' },
        { x: 3150, y: 156, key: 'smg' }
      ],
      enemies: [
        { x: 820, y: 1180, weapon: 'pistol', patrol: 90, facing: -1 },
        { x: 1320, y: 1100, weapon: 'smg', patrol: 70, facing: 1 },
        { x: 2200, y: 1180, weapon: 'shotgun', patrol: 120, facing: -1 },
        { x: 3200, y: 1180, weapon: 'smg', patrol: 140, facing: -1 },
        { x: 3300, y: 820, weapon: 'pistol', patrol: 100, facing: -1 },
        { x: 2150, y: 700, weapon: 'smg', patrol: 60, facing: -1 },
        { x: 1620, y: 640, weapon: 'shotgun', patrol: 80, facing: 1 },
        { x: 700, y: 520, weapon: 'smg', patrol: 60, facing: 1 },
        { x: 1600, y: 240, weapon: 'smg', patrol: 120, facing: 1 },
        { x: 2600, y: 180, weapon: 'shotgun', patrol: 150, facing: -1 },
        { x: 3100, y: 180, weapon: 'smg', patrol: 120, facing: -1 }
      ],
      hazards: [
        { type: 'spike', x: 560, y: 1360, w: 140, h: 40 },
        { type: 'saw', x: 1200, y: 960, w: 74, h: 74, bx: 1440, by: 960, speed: 160 },
        { type: 'saw', x: 2560, y: 660, w: 74, h: 74, bx: 2700, by: 660, speed: 190 },
        { type: 'saw', x: 1140, y: 480, w: 74, h: 74, bx: 1300, by: 480, speed: 175 },
        { type: 'spike', x: 1960, y: 1360, w: 80, h: 40 }
      ],
      checkpoints: [
        { x: 760, y: 1180 }, { x: 2100, y: 1180 }, { x: 3000, y: 1180 },
        { x: 3000, y: 820 }, { x: 120, y: 460 }, { x: 2200, y: 180 }
      ],
      hints: [
        { x: 3120, y: 750, text: 'the blue one moves you' },
        { x: 2230, y: 140, text: 'stand here' }
      ],
      goal: { x: 3380, y: 112 }
    }
  ];

  root.LEVELS = LEVELS;
})(typeof window !== 'undefined' ? window : globalThis);
