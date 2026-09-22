/* ============================================================
   art.js - the sprite sheets, written as pixels.

   A sprite is rows of characters; the colour each character means
   is decided at draw time from the racer's palette, so one torso
   shape dresses four different people. Silhouette is what you
   actually recognise at 22 pixels tall, so the four racers differ
   at the head: cropped hair, a mop, a hood, a welder's cap.
   ============================================================ */
(function (root) {
  'use strict';

  /* k hair/hood   s skin   t skin in shadow   e eye   m mouth line
     o outline     w highlight                                     */
  /* At nine pixels across, a head has room for hair and ONE eye. The
     first cut also had a nose, a mouth, an ear and a shadow under the
     brim, and the result was mud - five tones fighting over a face the
     size of a fingernail. Flat skin, a hard hairline, one dark pixel. */
  var HEADS = {
    crop: [
      '.kkkkkkk.',
      'kkkkkkkkk',
      'ksssssss.',
      'ksssssss.',
      'kssssess.',
      'ksssssss.',
      'ksssssss.',
      '.sssssss.',
      '..sssss..'
    ],
    mop: [
      '.kkkkkkk.',
      'kkkkkkkkk',
      'kkkkkkkkk',
      'kkssssss.',
      'kksssess.',
      'kkssssss.',
      'kkssssss.',
      '.sssssss.',
      '..sssss..'
    ],
    hood: [
      '..kkkkk..',
      '.kkkkkkk.',
      'kkkkkkkkk',
      'kkssssskk',
      'kksssesk.',
      'kkssssss.',
      'kkssssss.',
      '.kssssss.',
      '..kkkkk..'
    ],
    cap: [
      '..kkkkk..',
      '.kkkkkkkk',
      'ooooooooo',
      '.sssssss.',
      '.ssssess.',
      '.sssssss.',
      '.sssssss.',
      '.ssssss..',
      '..ssss...'
    ]
  };

  /* Same idea for the body: a collar, a stripe and a belt. The pocket,
     the buckle and the lapels went - at this size they were noise. */
  var TORSO = [
    'duuuuuul',
    'duwwwwul',
    'duwaawul',
    'duuaauul',
    'duuaauul',
    'duuuuuul',
    'duuuuuul',
    'dkkkkkkl',
    'duuuuuul',
    'duuuuuul'
  ];

  var SHOE = [
    '.nnnn',
    'nnnnn',
    'vvvvv'
  ];

  var HAND = [
    'ss',
    'ss'
  ];

  /* ---------------------------------------------------------- items
     Six across, so they read as a silhouette on a busy background. */
  var ITEMS = {
    boost: [
      '..RR..',
      '.RWWR.',
      '.RWWR.',
      '.RRRR.',
      '.Y..Y.',
      '..YY..'
    ],
    bomb: [
      '...FY.',
      '..K.Y.',
      '.KKK..',
      'KKKKK.',
      'KKKKK.',
      '.KKK..'
    ],
    shield: [
      'BBBBBB',
      'BWWWWB',
      'BWBBWB',
      'BWWWWB',
      '.BWWB.',
      '..BB..'
    ],
    spring: [
      '.GGGG.',
      'G....G',
      '.GGGG.',
      'G....G',
      '.GGGG.',
      'KKKKKK'
    ]
  };

  var ITEM_MAP = {
    R: '#e2483d', W: '#ffffff', Y: '#ffc23c', K: '#20232f',
    F: '#ff8a3c', B: '#3f7fd8', G: '#57c96a'
  };

  /* A crate: planks, a brace, and a hard edge so it sits on a floor. */
  var CRATE = [
    'oooooooooooo',
    'oppppppppplo',
    'opqppppppqlo',
    'oppqpppqpplo',
    'opppqpqppplo',
    'opppqpqppplo',
    'oppqpppqpplo',
    'opqppppppqlo',
    'oppppppppplo',
    'oooooooooooo'
  ];
  var CRATE_MAP = { o: '#4a3418', p: '#b98a4e', q: '#8f6634', l: '#d4a566' };

  /* A drum, for the same job in an industrial map. */
  var DRUM = [
    '.oooooooo.',
    'orrrrrrrro',
    'orwrrrrrro',
    'oyyyyyyyyo',
    'orrrrrrrro',
    'orrrrrrrro',
    'oyyyyyyyyo',
    'orrrrrrrro',
    'orrrrrrrro',
    '.oooooooo.'
  ];
  var DRUM_MAP = { o: '#5a1d12', r: '#c23a22', y: '#e8b23c', w: '#e07a5a' };

  /* Rooftop clutter. Small, but it is what stops a roof reading as a bar. */
  var AC_UNIT = [
    'oooooooooooo',
    'ogggggggggpo',
    'og.g.g.g.gpo',
    'og.g.g.g.gpo',
    'ogggggggggpo',
    'oggggggggggo',
    'oooooooooooo'
  ];
  var AC_MAP = { o: '#3a4048', g: '#8f98a6', p: '#b6bec9' };

  /* ---------------------------------------------------------- racers
     Four palettes. Hair and jacket carry most of the recognition, so
     they are pushed apart in hue rather than in brightness. */
  var RACERS = [
    { name: 'PIP',  head: 'crop', skin: '#f0cfa4', hair: '#2b2118',
      jacket: '#e9edf2', shirt: '#ffffff', accent: '#3f7fd8',
      trousers: '#3a5fa8', mark: '#e2483d' },
    { name: 'VIC',  head: 'mop',  skin: '#e8b98c', hair: '#c9622a',
      jacket: '#d8d2c4', shirt: '#ffffff', accent: '#3aa0a8',
      trousers: '#7a6a52', mark: '#3f9ed8' },
    { name: 'NOX',  head: 'hood', skin: '#c68f63', hair: '#2a2a33',
      jacket: '#33333f', shirt: '#4a4a58', accent: '#8f5fd8',
      trousers: '#2b3550', mark: '#57c96a' },
    { name: 'BOLT', head: 'cap',  skin: '#a9714a', hair: '#e07a2a',
      jacket: '#e08a2a', shirt: '#ffd7a0', accent: '#20232f',
      trousers: '#4a4436', mark: '#ffc23c' }
  ];

  root.ART = {
    HEADS: HEADS, TORSO: TORSO, SHOE: SHOE, HAND: HAND,
    ITEMS: ITEMS, ITEM_MAP: ITEM_MAP,
    CRATE: CRATE, CRATE_MAP: CRATE_MAP,
    DRUM: DRUM, DRUM_MAP: DRUM_MAP,
    AC_UNIT: AC_UNIT, AC_MAP: AC_MAP,
    RACERS: RACERS
  };
})(typeof window !== 'undefined' ? window : globalThis);
