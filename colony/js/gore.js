/* ============================================================
   gore.js - what violence leaves behind.

   health.js owns wounds: which part was hit, how much it bleeds,
   when the pawn goes down and when the pawn stops. statuses.js owns
   the bleeding trail and the wet pools it makes. This file owns the
   consequences neither of them keeps: the arm on the floor, the
   splatter up the wall, the body that swells and then stops smelling
   because there is nothing left of it, and the sentence in the log
   that tells you who did it and where it went in.

   Five things live here and they are one system. A blow that takes a
   limb spawns the limb as an ordinary item; the item rots where it
   falls, and a wolf will eat it. A body nobody buries passes through
   four stages, each with its own smell radius, and the mood of
   everyone who walks past it falls further at every stage. The blood
   the fight left behind is bytes in map.blood, which regions.js reads
   as room cleanliness, which medicine.js reads as the chance a
   surgery goes septic - so an unmopped operating theatre is a way to
   kill your own people, and it is a way the player chose.

   None of that changes with the gore level. Gore.setLevel only
   decides how much of it is drawn and how bluntly it is described.

   ---------------------------------------------------------------
   WHAT THE RENDERER SHOULD CALL (render.js, art.js - not mine)

     Gore.woundMarksFor(pawn) -> [{kind, dx, dy, r, color, alpha}]
        Draw each mark over the pawn sprite at
        (pawn.fx + dx, pawn.fy + dy) with radius r, all in TILES.
        kind: 'blood'   wet smear      - a soft round blob
              'stain'   dried blood    - smaller, darker
              'bandage' a tended wound - a pale rectangle
              'scar'    healed         - a thin pale line
              'stump'   a lost limb    - draw NO limb there, draw a cap
        The array is cached and rebuilt only when the pawn changes, so
        calling it once per visible pawn per frame is the intended use.

     Gore.gaitOf(pawn) -> 'normal' | 'limp' | 'crawl'
     Gore.corpseInfo(thing) -> {stage, key, label, color, bloat, ...}
        A corpse's colour and how far it has swollen, by stage.
     Gore.isWallSplatter(map, i) -> bool
        True when map.blood[i] sits on an impassable cell: draw it as a
        spray up a wall rather than as a pool on the floor.
     Gore.showBlood() -> bool          false at gore level 'off'
     Gore.labelOf(thing) -> string     "Bram's left arm", for ui.js
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;
  var T = root.T;
  var Res = root.Res;
  var Jobs = root.Jobs;
  var Toils = root.Toils;
  var Path = root.Path;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  /* workgivers.js, animals.js and regions.js all load after this file,
     so every reference to them is made from inside a function body. */
  function sys(name) { return root[name] || null; }
  function now() { var G = root.Game; return G ? (G.tick | 0) : 0; }

  var Gore = {};

  /* ============================================================
     0. NUMBERS
     ============================================================ */

  var DAY = 60000;
  var PAWN_BEAT = 250;          /* the staggered per-pawn beat        */
  var CORPSE_BEAT = 500;        /* stage, smell and mood              */
  var SCAVENGE_BEAT = 2500;     /* what the smell brings in           */

  /* Blood, in map.blood bytes. A cell holds 0..255 and nothing else,
     so every number here is a byte budget, not a volume. */
  var HIT_BLOOD = 14;           /* base stain under a blow            */
  var HIT_PER_DAMAGE = 4;
  var HIT_BLOOD_CAP = 90;
  var SPRAY_CELLS = 3;          /* how far a spray carries            */
  var WALL_SPLATTER_CAP = 150;  /* a wall never looks freshly painted */
  var SEVER_BLOOD = 170;        /* a limb coming off is the messiest  */
  var DEATH_POOL = 120;
  var SEEP_PER_BEAT = 6;        /* what a rotting body leaves         */

  /* Boots. Walking through a wet pool picks blood up; it comes off
     over the next few cells, which is how one fight in the kitchen
     ends up as a week of mopping in the corridor. */
  var BOOT_WET_FLOOR = 60;      /* below this a cell is too dry to lift */
  var BOOT_PICKUP = 0.34;
  var BOOT_DEPOSIT = 26;        /* bytes laid down at boots = 1        */
  var BOOT_DECAY = 0.62;
  var BOOT_MIN = 0.03;

  /* Corpse stages, keyed off rotProgress so a body in a freezer never
     leaves the first one - which is the entire argument for a freezer. */
  var STAGES = [
    { key: 'fresh',    label: 'fresh',           until: 0.12, smell: 2, mood: 0, bloat: 0.00,
      color: '#8b1a1a', desc: 'newly dead' },
    { key: 'bloating', label: 'bloating',        until: 0.45, smell: 5, mood: 1, bloat: 0.22,
      color: '#7d6a4a', desc: 'swollen and discoloured' },
    { key: 'rotten',   label: 'rotting',         until: 0.85, smell: 9, mood: 2, bloat: 0.10,
      color: '#4f5a35', desc: 'coming apart' },
    { key: 'skeletal', label: 'little but bone', until: 2.00, smell: 3, mood: 3, bloat: -0.15,
      color: '#c8c2ad', desc: 'picked clean' }
  ];
  var ROT_CAP = 0.985;          /* map.js destroys a corpse at 1.0     */
  var BONE_DAYS = 15;           /* how long bare bones lie there       */
  var DISEASE_CHANCE = 0.05;    /* per beat, per person, beside rot    */
  var STENCH_ALERT = 3;         /* rotting bodies indoors before a letter */

  var MAX_DEATH_RECORDS = 60;

  /* ============================================================
     1. CONTENT

     Three severed-part defs rather than one per body part: what the
     player needs to tell apart is the size of the thing on the floor,
     and the part it actually was is written on the item.
     ============================================================ */

  var PART_ITEM = {
    category: 'item', description: '',
    sprite: 'item', color: '#8b1a1a', color2: '#5c1010',
    stackLimit: 1, mass: 4, marketValue: 0,
    /* No foodType: a colonist must never pick an arm up for dinner by
       accident. What eats these is an animal, and that is code below. */
    nutrition: 0, foodType: null,
    isMedicine: false, medicinePotency: 0,
    passable: true, pathCost: 0, fillPercent: 0, blocksLight: false, holdsRoof: false,
    rotatable: false, hp: 40, flammable: true,
    beauty: -6, comfort: 0, natural: false,
    buildCost: null, stuffable: false, workToBuild: 0, buildSkill: null,
    buildCategory: null, researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null,
    building: null, weapon: null, apparel: null
  };

  if (Defs && Defs.add && !Defs.has('thing', 'severedLimb')) {
    Defs.add('thing', {
      severedLimb: {
        label: 'severed limb',
        description: 'An arm or a leg, taken off at the joint. It rots, it ruins a room, ' +
          'and something in the treeline can smell it.',
        mass: 6, rotDays: 4, beauty: -8
      },
      severedExtremity: {
        label: 'severed part',
        description: 'A hand, a foot, an ear - small, and no less of a thing to find on ' +
          'your kitchen floor.',
        mass: 1, rotDays: 3, beauty: -5
      },
      severedHead: {
        label: 'severed head',
        description: 'A head, and whoever it belonged to is not using it. Bury it or lose ' +
          'the room it is lying in.',
        mass: 5, rotDays: 5, beauty: -12, marketValue: 0
      }
    }, PART_ITEM);
  }

  if (Defs && Defs.add && Defs.has('thing', 'butcherTable') && !Defs.has('recipe', 'butcherSeveredPart')) {
    Defs.add('recipe', {
      butcherSeveredPart: {
        label: 'butcher severed part', jobString: 'Butchering', uiCategory: 'butchery',
        workAmount: 160, skill: 'cooking', workType: 'cook',
        workbenches: ['butcherTable'],
        ingredients: [{ anyOf: ['severedLimb', 'severedExtremity', 'severedHead'], count: 1 }],
        products: { meatRaw: 6 },
        defaultRepeat: 'forever',
        description: 'Render a severed limb down to meat. It stops the smell. It does not ' +
          'stop anyone remembering whose arm it was.'
      }
    });
  }

  if (Defs && Defs.add && !Defs.has('thought', 'sawRottenCorpse')) {
    Defs.add('thought', {
      sawRottenCorpse: {
        label: 'Rotting body', durationDays: 1.2, stackLimit: 3,
        stages: [
          { label: 'Saw a bloating corpse', mood: -6 },
          { label: 'Saw a rotting corpse', mood: -10 },
          { label: 'Saw what was left of somebody', mood: -5 }
        ],
        nullifiedByTrait: ['psychopath']
      },
      stenchOfDeath: {
        label: 'Stench of death', durationDays: 0.4, stackLimit: 1,
        stages: [{ label: 'The whole room smells of death', mood: -8 }],
        nullifiedByTrait: ['psychopath']
      },
      bloodySurroundings: {
        label: 'Blood everywhere', durationDays: 0.3, stackLimit: 1,
        stages: [
          { label: 'Blood on the floor', mood: -3 },
          { label: 'Standing in somebody’s blood', mood: -6 }
        ],
        nullifiedByTrait: ['psychopath', 'bloodlust']
      },
      sawDismemberment: {
        label: 'Saw a limb come off', durationDays: 2.5, stackLimit: 2,
        stages: [{ label: 'Watched somebody lose a limb', mood: -9 }],
        nullifiedByTrait: ['psychopath', 'bloodlust']
      },
      lostALimb: {
        label: 'Lost a limb', durationDays: 8, stackLimit: 2,
        stages: [{ label: 'I am missing a part of me', mood: -8 }],
        nullifiedByTrait: ['psychopath']
      }
    });
  }

  /* ============================================================
     2. THE GORE LEVEL

     Three settings, and only two of them are allowed to touch
     anything: how many marks come back from woundMarksFor, and how
     bluntly a death is written. Nothing below this line reads the
     level to decide whether blood lands on the floor, because the
     floor is simulation and a setting that changed it would quietly
     change how often a surgery kills somebody.
     ============================================================ */

  Gore.LEVELS = ['full', 'moderate', 'off'];
  Gore.level = 'full';

  Gore.setLevel = function (level) {
    if (Gore.LEVELS.indexOf(level) < 0) return Gore.level;
    Gore.level = level;
    markCache = Object.create(null);
    return Gore.level;
  };

  Gore.showBlood = function () { return Gore.level !== 'off'; };
  function full() { return Gore.level === 'full'; }
  function silent() { return Gore.level === 'off'; }

  /* Player-facing knobs with real trade-offs: burying parts costs a
     hauler's day and a grave, leaving them costs beauty and draws
     animals. Both are defensible, which is the point of a knob. */
  Gore.policy = {
    buryParts: true,        /* haulers carry severed parts to a grave  */
    scavengers: true,       /* rot brings predators to the map edge    */
    deathMessages: true     /* the described killing blow in the log   */
  };

  /* ============================================================
     3. BLOOD ON THE WORLD

     statuses.js owns wet pools, their creep and their drying. When it
     is loaded every drop this file spills goes through it, so a pool
     Gore made behaves exactly like a pool a wound made. When it is
     not, the byte still lands - this file works alone.
     ============================================================ */

  Gore.addBlood = function (map, x, y, amount) {
    if (!map || !map.blood || !(amount > 0) || !map.inBounds(x, y)) return 0;
    var S = sys('Statuses');
    if (S && S.addBlood) { S.addBlood(map, x, y, amount); return amount; }
    var i = map.idx(x, y);
    var v = map.blood[i] + Math.round(amount);
    map.blood[i] = v > 255 ? 255 : v;
    return amount;
  };

  /* A blow throws blood the way it was travelling. The cell under the
     hit takes the pool; the cells beyond it take the spray, and a wall
     in the way takes the lot and keeps it, which is what makes a
     corridor fight readable an hour later. */
  Gore.splatter = function (map, x, y, amount, dx, dy) {
    if (!map || !map.blood || !map.inBounds(x, y)) return;
    amount = Math.min(HIT_BLOOD_CAP, Math.max(1, amount | 0));
    Gore.addBlood(map, x, y, amount);
    if (!dx && !dy) return;

    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var ux = dx / len, uy = dy / len;
    var fx = x, fy = y, carried = amount * 0.7;
    for (var step = 1; step <= SPRAY_CELLS && carried >= 4; step++) {
      fx += ux; fy += uy;
      var cx = Math.round(fx), cy = Math.round(fy);
      if (!map.inBounds(cx, cy)) return;
      var i = map.idx(cx, cy);
      if (!map.passable(cx, cy)) {
        /* A wall stops the spray and wears it. */
        var w = map.blood[i] + Math.round(carried);
        map.blood[i] = w > WALL_SPLATTER_CAP ? WALL_SPLATTER_CAP : w;
        return;
      }
      Gore.addBlood(map, cx, cy, Math.round(carried));
      carried *= 0.55;
    }
  };

  Gore.isWallSplatter = function (map, i) {
    if (!map || !map.blood || !map.blood[i]) return false;
    return !map.passable(map.xOf(i), map.yOf(i));
  };

  Gore.filthAt = function (map, x, y) {
    if (!map || !map.blood || !map.inBounds(x, y)) return 0;
    return map.blood[map.idx(x, y)] / 255;
  };

  /* What a dirty room is costing, as one number the UI can print and
     medicine.js can multiply by. regions.js already folds map.blood
     into room.cleanliness; this states the same fact in the one place
     the player is looking when they wonder why the patient died. */
  Gore.cleanlinessPenalty = function (map, x, y) {
    var R = sys('Regions');
    var room = (R && R.roomAt) ? R.roomAt(map, x, y) : null;
    if (!room) return 0;
    var c = typeof room.cleanliness === 'number' ? room.cleanliness : 0;
    return c < 0 ? -c : 0;
  };

  Gore.infectionFactorAt = function (map, x, y) {
    return 1 + Math.min(1.5, Gore.cleanlinessPenalty(map, x, y));
  };

  /* Boots. Called on the beat a pawn changes cell, which is at most
     every thirteen ticks at walking pace. */
  function trackBlood(pawn, map, fromCell, toCell) {
    var boots = pawn.goreBoots || 0;
    var lifted = map.blood[fromCell];
    if (lifted >= BOOT_WET_FLOOR) {
      boots = U.clamp01(boots + (lifted / 255) * BOOT_PICKUP);
      /* What comes up off the floor is gone from the floor. */
      map.blood[fromCell] = Math.max(0, lifted - 6);
    }
    if (boots > BOOT_MIN) {
      var give = Math.round(boots * BOOT_DEPOSIT);
      if (give > 0 && map.blood[toCell] < 200) Gore.addBlood(map, map.xOf(toCell), map.yOf(toCell), give);
      boots *= BOOT_DECAY;
    }
    pawn.goreBoots = boots < BOOT_MIN ? 0 : boots;
  }

  /* ============================================================
     4. WOUNDS THAT SHOW

     Data, not drawing. Offsets are in tiles from the centre of the
     pawn's sprite, so a renderer at any zoom multiplies and draws.
     ============================================================ */

  var BODY_SPOT = {
    head: [0, -0.30], skull: [0, -0.32], brain: [0, -0.33],
    eyeLeft: [-0.09, -0.31], eyeRight: [0.09, -0.31],
    earLeft: [-0.16, -0.29], earRight: [0.16, -0.29],
    nose: [0, -0.27], jaw: [0, -0.23], neck: [0, -0.19],
    torso: [0, -0.02], ribcage: [0, -0.04], spine: [0, 0.02],
    heart: [-0.05, -0.05], lungLeft: [-0.10, -0.06], lungRight: [0.10, -0.06],
    liver: [0.07, 0.03], stomach: [-0.02, 0.04],
    kidneyLeft: [-0.11, 0.04], kidneyRight: [0.11, 0.04],
    armLeft: [-0.27, -0.04], armRight: [0.27, -0.04],
    handLeft: [-0.32, 0.09], handRight: [0.32, 0.09],
    legLeft: [-0.12, 0.27], legRight: [0.12, 0.27],
    footLeft: [-0.13, 0.40], footRight: [0.13, 0.40]
  };

  var COLOR_WET = '#8b1a1a';
  var COLOR_DRY = '#5c1010';
  var COLOR_BANDAGE = '#d9d2c0';
  var COLOR_SCAR = '#b08d86';
  var COLOR_STUMP = '#6d1414';

  /* Cosmetic jitter must be stable across frames and must not consume
     the simulation RNG, so it is hashed out of the part name. */
  function jitter(seedStr, spread) {
    var h = U.hash(seedStr);
    return (((h % 1000) / 1000) - 0.5) * 2 * spread;
  }

  function spotFor(part, seedStr) {
    var s = BODY_SPOT[part.defName];
    if (s) return [s[0] + jitter(seedStr + 'x', 0.05), s[1] + jitter(seedStr + 'y', 0.05)];
    return [jitter(seedStr + 'ax', 0.26), jitter(seedStr + 'ay', 0.24)];
  }

  var markCache = Object.create(null);

  function markKey(pawn) {
    var h = pawn.health;
    if (!h) return 'none';
    return h.injuries.length + ':' + Math.round((h.bloodLoss || 0) * 20) + ':' +
           (h.downed ? 1 : 0) + ':' + Gore.level;
  }

  Gore.woundMarksFor = function (pawn) {
    var h = pawn && pawn.health;
    if (!h) return [];
    var key = markKey(pawn);
    var hit = markCache[pawn.id];
    if (hit && hit.key === key) return hit.marks;

    var marks = [];
    var budget = full() ? 8 : (silent() ? 0 : 3);
    var i, part, spot;

    /* A lost limb is information, not decoration: it is drawn at every
       gore level, because a one-armed colonist who looks whole is a
       colonist the player will keep sending to the wall. */
    for (i = 0; i < h.parts.length; i++) {
      part = h.parts[i];
      if (!part.missing || part.depth !== 'outside') continue;
      if (part.parent !== null && part.parent !== undefined) {
        var parent = partById(h, part.parent);
        if (parent && parent.missing) continue;        /* only the top of the chain */
      }
      spot = spotFor(part, 'stump' + part.id);
      marks.push({
        kind: 'stump', part: part.defName, label: part.label,
        dx: spot[0], dy: spot[1], r: 0.10, color: COLOR_STUMP, alpha: 1
      });
    }

    for (i = 0; i < h.injuries.length && budget > 0; i++) {
      var inj = h.injuries[i];
      if (inj.label && inj.label.indexOf('missing') === 0) continue;
      part = partById(h, inj.partId);
      if (!part) continue;
      spot = spotFor(part, 'w' + inj.id);

      var kind, color;
      if (inj.permanent && inj.label === 'scar') { kind = 'scar'; color = COLOR_SCAR; }
      else if (inj.tended) { kind = 'bandage'; color = COLOR_BANDAGE; }
      else if (inj.bleedRate > 0.02) { kind = 'blood'; color = COLOR_WET; }
      else { kind = 'stain'; color = COLOR_DRY; }

      if (silent() && kind !== 'bandage') continue;
      if (!full() && kind === 'scar') continue;

      marks.push({
        kind: kind, part: part.defName, label: part.label,
        dx: spot[0], dy: spot[1],
        r: U.clamp(0.035 + inj.amount * 0.005, 0.035, 0.12),
        color: color, alpha: U.clamp(0.5 + inj.amount * 0.03, 0.5, 1)
      });
      budget--;
    }

    markCache[pawn.id] = { key: key, marks: marks };
    return marks;
  };

  Gore.bloodinessOf = function (pawn) {
    var h = pawn && pawn.health;
    if (!h || silent()) return 0;
    var H = sys('Health');
    var bleed = (H && H.bleedRate) ? H.bleedRate(pawn) : 0;
    return U.clamp01(bleed * 1.4 + (h.bloodLoss || 0) * 0.5);
  };

  Gore.gaitOf = function (pawn) {
    var h = pawn && pawn.health;
    if (!h) return 'normal';
    if (h.downed || h.dead) return 'crawl';
    for (var i = 0; i < h.parts.length; i++) {
      var p = h.parts[i];
      if (p.missing && /leg|foot|paw/i.test(p.defName)) return 'limp';
    }
    var H = sys('Health');
    var move = (H && H.capacity) ? H.capacity(pawn, 'moving') : 1;
    return move < 0.6 ? 'limp' : 'normal';
  };

  function partById(h, id) {
    for (var i = 0; i < h.parts.length; i++) if (h.parts[i].id === id) return h.parts[i];
    return null;
  }

  /* ============================================================
     5. DISMEMBERMENT

     health.js already destroys a non-vital part when its hp reaches
     zero and hangs a permanent "missing" injury on it. This watches
     for parts that have newly gone, and turns the ones big enough to
     pick up into things on the floor. Detection rather than a hook:
     health.js is not mine to reach into, and a pawn's own injury
     count is an O(1) gate that is right every time.
     ============================================================ */

  function partItemDef(part) {
    var n = part.defName || '';
    if (/^head$/i.test(n)) return 'severedHead';
    if (/arm|leg|wing|tail/i.test(n)) return 'severedLimb';
    if (/hand|foot|paw|ear|nose|jaw|horn|claw|finger|toe/i.test(n)) return 'severedExtremity';
    return null;
  }

  Gore.severParts = function (pawn) {
    var h = pawn && pawn.health;
    var map = pawn && pawn.map;
    if (!h || !map || !map.spawnThing) return [];
    if (!pawn.goreSevered) pawn.goreSevered = [];
    var out = [];

    for (var i = 0; i < h.parts.length; i++) {
      var part = h.parts[i];
      if (!part.missing || part.depth !== 'outside') continue;
      if (pawn.goreSevered.indexOf(part.id) >= 0) continue;

      /* Only the top of a chain: an arm taking its hand with it is one
         arm on the floor, not an arm and a hand. */
      var parent = (part.parent === null || part.parent === undefined) ? null : partById(h, part.parent);
      var topOfChain = !parent || !parent.missing;
      pawn.goreSevered.push(part.id);
      if (!topOfChain) continue;

      var defId = partItemDef(part);
      if (!defId || !Defs.has('thing', defId)) continue;
      if (part.maxHp < 6) continue;         /* a hare's ear is not an item */

      var thing = map.spawnThing(defId, pawn.x, pawn.y, { stack: 1 });
      if (!thing) continue;
      thing.gorePart = part.label || part.defName;
      thing.goreOwner = nameOf(pawn);
      thing.goreOwnerId = pawn.id;
      thing.goreKindId = pawn.kindId || null;
      out.push(thing);

      /* A limb coming off is the loudest thing that happens to a
         floor, and it happens in whichever direction the pawn was
         facing when it landed. */
      var d = dirVector(pawn);
      Gore.splatter(map, pawn.x, pawn.y, SEVER_BLOOD, d[0], d[1]);
      announceSever(pawn, part);
    }
    return out;
  };

  function dirVector(pawn) {
    switch (pawn.dir | 0) {
      case 0: return [0, -1];
      case 1: return [1, 0];
      case 2: return [0, 1];
      default: return [-1, 0];
    }
  }

  function announceSever(pawn, part) {
    var G = root.Game;
    var N = sys('Needs');
    var who = nameOf(pawn);
    if (N && N.addThought && !pawn.dead && pawn.isHuman) N.addThought(pawn, 'lostALimb');

    if (N && N.addThought && pawn.map) {
      var list = pawn.map.pawns;
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (o === pawn || o.dead || !o.isHuman || o.faction !== 'player') continue;
        if (U.dist(o.x, o.y, pawn.x, pawn.y) > 12) continue;
        N.addThought(o, 'sawDismemberment', { otherPawnId: pawn.id });
      }
    }
    if (!G || !G.msg || silent()) {
      if (G && G.msg) G.msg(who + ' lost a ' + (part.label || 'limb') + '.', { type: 'threat', x: pawn.x, y: pawn.y });
      return;
    }
    G.msg(U.cap(who) + '’s ' + (part.label || 'limb') + ' was torn off.',
      { type: 'threat', x: pawn.x, y: pawn.y });
  }

  Gore.labelOf = function (thing) {
    if (!thing) return '';
    if (thing.gorePart) {
      var owner = thing.goreOwner;
      if (silent()) return thing.def ? thing.def.label : 'remains';
      return owner ? (owner + '’s ' + thing.gorePart) : ('a severed ' + thing.gorePart);
    }
    if (thing.corpse) {
      var info = Gore.corpseInfo(thing);
      var base = 'corpse of ' + (thing.corpse.name || 'someone');
      if (silent() || info.stage === 0) return base;
      return base + ' (' + info.label + ')';
    }
    return thing.label ? thing.label() : '';
  };

  /* ============================================================
     6. CORPSES OVER TIME

     A body passes through four stages on the clock map.js already
     runs for rot, which means temperature decides the pace: a corpse
     in a walk-in freezer stays fresh, and one left in a summer field
     is bone inside a week. map.js destroys anything whose rotProgress
     reaches 1.0, so this holds every corpse just under that line and
     ages the bones on its own count - a skeleton that evaporated on
     its own would be the colony getting away with it.
     ============================================================ */

  Gore.corpseStage = function (thing) {
    if (!thing || !thing.corpse) return 0;
    var p = thing.rotProgress || 0;
    for (var i = 0; i < STAGES.length; i++) if (p < STAGES[i].until) return i;
    return STAGES.length - 1;
  };

  Gore.corpseInfo = function (thing) {
    var i = Gore.corpseStage(thing);
    var s = STAGES[i];
    var c = thing && thing.corpse;
    return {
      stage: i, key: s.key, label: s.label, desc: s.desc,
      color: s.color, bloat: s.bloat,
      smellRadius: s.smell,
      moodDegree: s.mood,
      name: (c && c.name) || 'someone',
      faction: (c && c.faction) || null,
      boneDays: c && c.goreBoneTicks ? c.goreBoneTicks / DAY : 0
    };
  };

  Gore.smellRadiusOf = function (thing) { return Gore.corpseInfo(thing).smellRadius; };

  /* One pass over every corpse on the map, on the slow beat. Stage,
     seepage, who has to smell it, and what the smell brings. */
  function tickCorpses(map, state, elapsed) {
    var corpses = map.byDef ? map.byDef('corpse') : null;
    if (!corpses || !corpses.length) { state.rottingIndoors = 0; return; }

    var R = sys('Regions');
    var N = sys('Needs');
    var H = sys('Health');
    var rottingIndoors = 0, worst = null;

    for (var i = corpses.length - 1; i >= 0; i--) {
      var body = corpses[i];
      if (!body || !body.spawned || !body.corpse) continue;

      /* Hold it under the line map.js destroys at. */
      if (body.rotProgress > ROT_CAP) body.rotProgress = ROT_CAP;

      var info = Gore.corpseInfo(body);
      if (info.stage >= 3) {
        body.corpse.goreBoneTicks = (body.corpse.goreBoneTicks || 0) + elapsed;
        if (body.corpse.goreBoneTicks > BONE_DAYS * DAY) {
          map.destroyThing(body, 'crumbled');
          continue;
        }
      }

      /* A body that is coming apart leaves a little of itself behind. */
      if (info.stage === 2) Gore.addBlood(map, body.x, body.y, SEEP_PER_BEAT);

      var room = (R && R.roomAt) ? R.roomAt(map, body.x, body.y) : null;
      var indoors = !!(room && !room.outdoor && room.id > 0);
      if (info.stage >= 1 && indoors) rottingIndoors++;
      if (!worst || info.stage > Gore.corpseStage(worst)) worst = body;

      if (info.stage === 0) continue;
      spreadCorpseMood(map, body, info, room, indoors, N, H);
    }

    state.rottingIndoors = rottingIndoors;
    state.worstCorpse = worst;
  }

  function spreadCorpseMood(map, body, info, room, indoors, N, H) {
    if (!N || !N.addThought) return;
    var radius = info.smellRadius;
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.dead || !p.isHuman || p.faction !== 'player') continue;
      if (U.cheb(p.x, p.y, body.x, body.y) > radius) continue;

      /* Indoors the smell is the room's, not a radius: a wall is a
         wall. Outdoors it carries as far as the stage says. */
      if (indoors) {
        var R = sys('Regions');
        var theirs = (R && R.roomAt) ? R.roomAt(map, p.x, p.y) : null;
        if (!theirs || theirs.id !== room.id) continue;
        N.addThought(p, 'stenchOfDeath');
      }
      N.addThought(p, 'sawRottenCorpse', { degree: info.moodDegree, otherPawnId: body.id });

      /* Rot is a disease vector, and a colony that sleeps beside it
         finds that out the way colonies do. */
      if (info.stage === 2 && H && H.addHediff && U.chance(DISEASE_CHANCE)) {
        var id = H.HEDIFFS && H.HEDIFFS.gutWorms ? 'gutWorms'
               : (H.HEDIFFS && H.HEDIFFS.foodPoisoning ? 'foodPoisoning' : 'flu');
        if (!H.hasHediff || !H.hasHediff(p, id)) H.addHediff(p, id, 0.06);
      }
    }
  }

  /* What the smell brings in. Predators do not need to be told twice,
     and a colony that leaves its raiders where they fell has invited
     everything with a nose to come and look at the walls. */
  function tickScavengers(map, state) {
    if (!Gore.policy.scavengers) return;
    var A = sys('Animals');
    var MG = sys('MapGen');
    if (!A || !A.spawnWild || !MG) return;

    var bodies = countOutdoorRot(map);
    var parts = countSeveredParts(map);
    var draw = bodies * 0.06 + parts * 0.03;
    if (draw <= 0) return;
    if (!U.chance(Math.min(0.55, draw))) return;

    var kindId = scavengerKind();
    if (!kindId) return;
    var edge = MG.edgeSpawnCells ? MG.edgeSpawnCells(map, U.pick(['n', 'e', 's', 'w'])) : null;
    if (!edge || !edge.length) return;
    var at = U.pick(edge);
    var pack = A.spawnWild(map, kindId, at.x, at.y, U.randInt(1, 3));
    if (!pack || !pack.length) return;

    var G = root.Game;
    if (G && G.letter) {
      var kind = Defs.maybe('pawnKind', kindId);
      G.letter('Scavengers',
        (kind ? U.cap(kind.label) : 'Scavengers') + ' have come in off the map edge. ' +
        'Something out here smells of meat, and it is the ' +
        (bodies ? 'bodies nobody buried' : 'parts nobody cleared away') + '.',
        { kind: 'threat', x: at.x, y: at.y });
    }
  }

  var _scavengerKind = undefined;
  function scavengerKind() {
    if (_scavengerKind !== undefined) return _scavengerKind;
    _scavengerKind = null;
    var kinds = Defs.all('pawnKind');
    var best = [];
    for (var i = 0; i < kinds.length; i++) {
      var k = kinds[i];
      if (!k.isAnimal) continue;
      if (k.predator || k.diet === 'carnivore') best.push(k.id);
    }
    if (best.length) _scavengerKind = best[0];
    return _scavengerKind;
  }

  function countOutdoorRot(map) {
    var corpses = map.byDef ? map.byDef('corpse') : null;
    if (!corpses) return 0;
    var n = 0;
    for (var i = 0; i < corpses.length; i++) {
      if (corpses[i].spawned && Gore.corpseStage(corpses[i]) >= 1) n++;
    }
    return n;
  }

  function severedPartsOn(map) {
    var out = [];
    var ids = ['severedLimb', 'severedExtremity', 'severedHead'];
    for (var d = 0; d < ids.length; d++) {
      var list = map.byDef ? map.byDef(ids[d]) : null;
      if (!list) continue;
      for (var i = 0; i < list.length; i++) if (list[i].spawned) out.push(list[i]);
    }
    return out;
  }
  function countSeveredParts(map) { return severedPartsOn(map).length; }
  Gore.severedParts = severedPartsOn;

  /* An animal standing on a severed part eats it. This is the whole
     reason a colony can get away with not burying an arm, and the
     reason the wolf was standing in the kitchen. */
  function tickAnimalsEating(map) {
    var parts = severedPartsOn(map);
    if (!parts.length) return;
    for (var i = parts.length - 1; i >= 0; i--) {
      var part = parts[i];
      var near = map.pawnsAt ? map.pawnsAt(part.x, part.y) : [];
      for (var p = 0; p < near.length; p++) {
        var a = near[p];
        if (!a.isAnimal || a.dead || a.faction === 'player') continue;
        var kind = a.kind || {};
        if (kind.diet === 'herbivore') continue;
        if (!U.chance(0.35)) continue;
        if (Res && Res.reservedBy && Res.reservedBy(map, T.thing(part))) continue;
        if (a.needs) a.needs.food = U.clamp01((a.needs.food || 0) + 0.35);
        Gore.addBlood(map, part.x, part.y, 40);
        map.destroyThing(part, 'eaten');
        break;
      }
    }
  }

  /* The standing regret: bodies indoors, rotting, and nobody digging. */
  function checkStench(map, state) {
    var G = root.Game;
    if (!G || !G.letter) return;
    if (state.rottingIndoors < STENCH_ALERT) { state.stenchWarned = false; return; }
    if (state.stenchWarned) return;
    state.stenchWarned = true;
    var at = state.worstCorpse;
    G.letter('The dead are still here',
      state.rottingIndoors + ' bodies are rotting inside the base. Everyone who walks past ' +
      'one loses mood for it, the rooms they are in are filthy enough to turn a surgery ' +
      'septic, and the smell is carrying past the walls. Dig graves.',
      { kind: 'threat', x: at ? at.x : undefined, y: at ? at.y : undefined });
  }

  Gore.unburiedReport = function (map) {
    var corpses = map && map.byDef ? map.byDef('corpse') : [];
    var rows = { fresh: 0, bloating: 0, rotten: 0, skeletal: 0 };
    for (var i = 0; i < corpses.length; i++) {
      if (!corpses[i].spawned) continue;
      rows[STAGES[Gore.corpseStage(corpses[i])].key]++;
    }
    rows.parts = countSeveredParts(map);
    return rows;
  };

  /* ============================================================
     7. DEATH THAT LANDS

     "Bram was killed" is a line of bookkeeping. The wound, the part
     and the weapon are all sitting on the pawn at the moment it dies,
     so this keeps every pawn it has seen for a few hundred ticks and
     reads the sentence off the body afterwards.
     ============================================================ */

  var VERBS = {
    'gunshot': 'shot', 'arrow wound': 'shot with an arrow', 'stab wound': 'stabbed',
    'cut': 'cut down', 'scratch': 'clawed open', 'bite': 'mauled',
    'bruise': 'beaten to death', 'crushed': 'crushed', 'shredded': 'blown apart',
    'burn': 'burned to death', 'frostbite': 'frozen', 'toxic burn': 'poisoned'
  };

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    if (typeof pawn.fullName === 'function') return pawn.fullName();
    var n = pawn.name;
    if (!n) return 'someone';
    return n.nick || n.first || 'someone';
  }

  function sourceLabel(src) {
    if (!src) return null;
    if (typeof src === 'string') return src;
    return src.label || src.id || null;
  }

  function fatalInjury(h) {
    var best = null, score = -1;
    for (var i = 0; i < h.injuries.length; i++) {
      var inj = h.injuries[i];
      if (inj.permanent && inj.label === 'scar') continue;
      /* The newest serious wound is the one that did it: injuries are
         pushed in order, and age is counted up from zero. */
      var s = inj.amount - inj.ageTicks * 0.002 + (inj.label === 'gunshot' ? 2 : 0);
      if (s > score) { score = s; best = inj; }
    }
    return best;
  }

  Gore.deathRecord = function (pawn) {
    var h = pawn && pawn.health;
    var rec = {
      id: pawn ? pawn.id : 0, tick: now(),
      name: nameOf(pawn), faction: pawn ? pawn.faction : null,
      kindId: pawn ? pawn.kindId : null, isHuman: !!(pawn && pawn.isHuman),
      x: pawn ? pawn.x : 0, y: pawn ? pawn.y : 0,
      cause: (h && h.deathCause) || 'unknown causes',
      wound: null, part: null, inside: false,
      weapon: null, killerId: null, killerName: null, killerFaction: null,
      severed: 0
    };
    if (!h) return rec;

    var inj = fatalInjury(h);
    if (inj) {
      rec.wound = inj.label || null;
      var part = partById(h, inj.partId);
      if (part) { rec.part = part.label; rec.inside = part.depth === 'inside'; }
      rec.weapon = sourceLabel(inj.source);
      rec.killerId = inj.instigatorId === undefined ? null : inj.instigatorId;

      /* A round that goes through an organ leaves the torso as the
         wound and the organ as a separate "missing" record, because
         that is how health.js takes a body apart. The organ is the
         sentence the player wants: shot through the left lung beats
         shot in the torso every time. */
      var deep = freshestDestroyedOrgan(h, inj);
      if (deep) { rec.part = deep.label; rec.inside = true; }
    }
    for (var i = 0; i < h.parts.length; i++) if (h.parts[i].missing) rec.severed++;

    var killer = rec.killerId ? knownPawn(rec.killerId) : null;
    if (killer) {
      rec.killerName = nameOf(killer);
      rec.killerFaction = killer.faction || null;
      if (!rec.weapon && killer.equipment && killer.equipment.def) {
        rec.weapon = killer.equipment.def.label;
      }
    }
    rec.text = Gore.describeDeath(rec);
    return rec;
  };

  /* Destroyed while the fatal blow was landing, and deeper than the
     part the blow is filed under. */
  function freshestDestroyedOrgan(h, inj) {
    var best = null;
    for (var i = 0; i < h.injuries.length; i++) {
      var other = h.injuries[i];
      if (other === inj || !other.label || other.label.indexOf('missing ') !== 0) continue;
      if (other.ageTicks > inj.ageTicks + 60) continue;
      var part = partById(h, other.partId);
      if (!part || part.depth !== 'inside') continue;
      if (!best || part.coverage < best.coverage) best = part;
    }
    return best;
  }

  function whoseSide(faction) {
    if (faction === 'raider') return 'a raider';
    if (faction === 'player') return 'a colonist';
    if (faction === 'wild') return 'a wild animal';
    return 'someone';
  }

  Gore.describeDeath = function (x) {
    var rec = (x && x.health) ? Gore.deathRecord(x) : x;
    if (!rec) return 'Someone has died.';
    var who = U.cap(rec.name);

    if (silent()) {
      return who + (rec.killerName ? ' was killed by ' + rec.killerName + '.' : ' has died.');
    }

    var verb = rec.wound ? (VERBS[rec.wound] || ('wounded by ' + rec.wound)) : null;
    if (!verb) {
      return who + ' died of ' + rec.cause + '.';
    }

    var s = who + ' was ' + verb;
    if (full() && rec.part) s += (rec.inside ? ' through the ' : ' in the ') + rec.part;

    if (rec.killerName) {
      s += ' by ' + rec.killerName;
      if (rec.killerFaction && rec.killerFaction !== 'player') {
        s += ' (' + whoseSide(rec.killerFaction) + ')';
      }
    } else if (rec.killerFaction) {
      s += ' by ' + whoseSide(rec.killerFaction);
    }
    if (rec.weapon) s += ' with ' + withArticle(rec.weapon);
    return s + '.';
  };

  function article(word) {
    return /^[aeiou]/i.test(word || '') ? 'an' : 'a';
  }

  /* A source is sometimes a weapon def label ("bolt-action rifle") and
     sometimes a phrase health.js wrote ("a fire", "botched surgery"),
     so the article is only added to the ones that want one. */
  function withArticle(word) {
    if (!word) return '';
    if (/^(a|an|the) /i.test(word)) return word;
    return article(word) + ' ' + word;
  }

  Gore.describeInjury = function (pawn, injury) {
    if (!injury) return '';
    var h = pawn && pawn.health;
    var part = h ? partById(h, injury.partId) : null;
    var where = part ? part.label : 'body';

    if (injury.label && injury.label.indexOf('missing') === 0) {
      return silent() ? ('missing ' + where) : ('a missing ' + where);
    }
    if (injury.label === 'scar') return 'a scar on the ' + where;

    var head = (silent() ? injury.label : withArticle(injury.label));
    var s = head + (part && part.depth === 'inside' ? ' through the ' : ' in the ') + where;
    if (silent()) return s;

    var tags = [];
    if (!injury.tended && injury.bleedRate > 0.02) tags.push('bleeding');
    if (injury.tended) tags.push('tended');
    if (injury.infection > 0) tags.push('infected');
    if (full() && injury.amount >= 12) tags.push('severe');
    return tags.length ? (s + ' (' + tags.join(', ') + ')') : s;
  };

  Gore.deaths = [];

  function recordDeath(pawn) {
    var rec = Gore.deathRecord(pawn);
    Gore.deaths.push(rec);
    if (Gore.deaths.length > MAX_DEATH_RECORDS) {
      Gore.deaths.splice(0, Gore.deaths.length - MAX_DEATH_RECORDS);
    }
    var G = root.Game;
    if (G && G.msg && Gore.policy.deathMessages && rec.isHuman) {
      G.msg(rec.text, { type: 'threat', x: rec.x, y: rec.y });
    }
    /* The floor remembers it too. */
    if (pawn.map) {
      var d = dirVector(pawn);
      Gore.splatter(pawn.map, pawn.x, pawn.y, DEATH_POOL, d[0], d[1]);
    }
    return rec;
  }

  Gore.lastDeath = function () {
    return Gore.deaths.length ? Gore.deaths[Gore.deaths.length - 1] : null;
  };

  /* ============================================================
     8. THE ROSTER

     A pawn who dies is off map.pawns before the next tick, and the
     wound that killed them goes with it. Holding the object for a few
     hundred ticks is what lets the sentence be written afterwards -
     and what lets an injury name the pawn who caused it.
     ============================================================ */

  var roster = new Map();       /* pawnId -> {pawn, seen} */
  var ROSTER_KEEP = 1200;

  function noteAlive(pawn, t) {
    var e = roster.get(pawn.id);
    if (e) { e.seen = t; return e; }
    roster.set(pawn.id, { pawn: pawn, seen: t });
    return roster.get(pawn.id);
  }

  function knownPawn(id) {
    var e = roster.get(id);
    if (e) return e.pawn;
    var G = root.Game;
    if (!G || !G.map) return null;
    var list = G.map.pawns;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }
  Gore.knownPawn = knownPawn;

  function pruneRoster(t) {
    roster.forEach(function (e, id) {
      if (t - e.seen > ROSTER_KEEP) {
        roster.delete(id);
        delete markCache[id];
      }
    });
  }

  /* ============================================================
     9. THE PER-PAWN PASS

     Two O(1) gates before anything walks an array: the cell the pawn
     is standing on, and how many injuries it has. A pawn who has not
     moved and has not been hit costs two integer compares.
     ============================================================ */

  function tickPawnGore(pawn, map, t) {
    var cell = map.idx(pawn.x, pawn.y);
    if (pawn.goreCell === undefined) pawn.goreCell = cell;
    else if (pawn.goreCell !== cell) {
      var from = pawn.goreCell;
      pawn.goreCell = cell;
      /* Nothing with wings and nothing being carried leaves prints. */
      if (!pawn.carriedBy && !(pawn.kind && pawn.kind.body === 'bird')) {
        trackBlood(pawn, map, from, cell);
      }
    }

    var h = pawn.health;
    if (!h) return;
    var n = h.injuries.length;
    if (pawn.goreInjN !== n) {
      pawn.goreInjN = n;
      delete markCache[pawn.id];
      Gore.severParts(pawn);
    }

    /* The room, on the pawn's own staggered beat. */
    if ((t + pawn.id) % PAWN_BEAT !== 0) return;
    if (!pawn.isHuman || pawn.faction !== 'player' || pawn.dead) return;
    var N = sys('Needs');
    if (!N || !N.addThought) return;

    var here = map.blood[cell];
    var penalty = Gore.cleanlinessPenalty(map, pawn.x, pawn.y);
    if (here >= 110 || penalty > 0.9) {
      N.addThought(pawn, 'bloodySurroundings', { degree: (here >= 180 || penalty > 1.6) ? 1 : 0 });
    }
  }

  /* ============================================================
     10. BURYING WHAT CAME OFF

     A severed part is an ordinary item, so hauling it to a stockpile
     already works. This is the other option: put it in the ground,
     preferring a grave that already holds the person it came off, so
     burying arms never costs the colony a grave a body needed.
     ============================================================ */

  var BURY_PART_WORK = 240;
  var _workRegistered = false;

  /* Four parts to a plot. A grave that already holds a body still has
     room for the arm that came off it, which is the whole reason this
     never competes with burying the dead. */
  function graveHasRoom(grave) {
    return !!(grave && grave.spawned && (grave.goreParts || 0) < 4);
  }

  function graveScore(grave, part, dist) {
    var s = -dist;
    if (grave.buried) s += 40;                      /* with the body, first choice */
    if (part && grave.buried && grave.buried.pawnId === part.goreOwnerId) s += 200;
    return s;
  }

  if (Jobs && Jobs.register && !Jobs.isRegistered('goreBuryPart')) {
    Jobs.register('goreBuryPart', {
      label: 'bury remains',
      reportString: 'Burying remains.',
      toils: function () {
        return [
          Toils.reserve('A', 1),
          Toils.custom({
            name: 'findGraveForPart',
            tick: function (pawn, job) {
              var map = pawn.map;
              var part = T.resolve(job.targetA, map);
              if (!part || !part.spawned) return 'fail';
              var graves = map.byDef('grave') || [];
              var cands = [];
              for (var i = 0; i < graves.length; i++) {
                if (!graveHasRoom(graves[i])) continue;
                if (!Res.canReserve(pawn, T.thing(graves[i]), 1)) continue;
                cands.push(graves[i]);
              }
              if (!cands.length || !Path) return 'fail';
              var pick = Path.closestReachable(map, pawn, cands, function (g, d) {
                return graveScore(g, part, d);
              });
              if (!pick) return 'fail';
              job.targetB = T.thing(pick);
              return Res.reserve(pawn, job.targetB, 1) ? 'next' : 'fail';
            }
          }),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.pickUp('A', function () { return 1; }),
          Toils.goto('B', { pe: PE.INTERACTION, failIfGone: true }),
          Toils.work({
            name: 'inter', which: 'B',
            amount: BURY_PART_WORK, skill: 'construction',
            onDone: function (pawn, job) {
              var map = pawn.map;
              var grave = T.resolve(job.targetB, map);
              var part = pawn.carried;
              if (!grave || !part) return 'fail';
              grave.goreParts = (grave.goreParts || 0) + 1;
              pawn.carried = null;
              map.despawnThing(part);
              var G = root.Game;
              if (G && G.msg) {
                G.msg(nameOf(pawn) + ' buried ' + (silent() ? 'some remains' : Gore.labelOf(part)) + '.',
                  { type: 'info', x: grave.x, y: grave.y });
              }
              return 'done';
            }
          })
        ];
      }
    });
  }

  Gore.registerWork = function () {
    var WG = sys('WorkGivers');
    if (_workRegistered || !WG || !WG.register) return false;
    _workRegistered = true;

    WG.register({
      id: 'goreBuryParts', workType: 'haul', order: 90,
      label: 'bury severed remains',
      tryGiveJob: function (pawn) {
        if (!Gore.policy.buryParts) return null;
        var map = pawn.map;
        var parts = severedPartsOn(map);
        if (!parts.length) return null;

        var graves = map.byDef('grave') || [];
        var anyGrave = false;
        for (var g = 0; g < graves.length; g++) {
          if (graveHasRoom(graves[g])) { anyGrave = true; break; }
        }
        if (!anyGrave) return null;

        var cands = [];
        for (var i = 0; i < parts.length; i++) {
          var p = parts[i];
          if (!Res.canReserve(pawn, T.thing(p), 1)) continue;
          if (Path && !Path.reachable(map, pawn.x, pawn.y, p.x, p.y, { pawn: pawn })) continue;
          cands.push(p);
        }
        if (!cands.length || !Path) return null;
        var pick = Path.closestReachable(map, pawn, cands, function (p, d) { return -d; });
        if (!pick) return null;
        if (!Res.reserve(pawn, T.thing(pick), 1)) return null;
        var job = Jobs.make('goreBuryPart', T.thing(pick), null, {});
        if (!job) Res.release(pawn, T.thing(pick));
        return job;
      }
    });
    return true;
  };

  /* ============================================================
     11. THE TICK
     ============================================================ */

  function stateOf(map) {
    if (!map._gore) {
      map._gore = {
        corpseTick: 0, scavTick: 0, eatTick: 0,
        rottingIndoors: 0, stenchWarned: false, worstCorpse: null,
        pawnCount: -1
      };
    }
    return map._gore;
  }

  Gore.tick = function (map, game) {
    if (!map || !map.blood) return;
    if (!_workRegistered) Gore.registerWork();
    var t = game && game.tick !== undefined ? game.tick : now();
    var st = stateOf(map);

    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var pawn = list[i];
      if (pawn.dead) continue;
      noteAlive(pawn, t);
      tickPawnGore(pawn, map, t);
    }

    /* Deaths only ever shrink map.pawns, so a length that has not
       fallen cannot hide one. The periodic sweep is the safety net for
       the tick where a raider arrived as a colonist died. */
    if (map.pawns.length !== st.pawnCount || t % PAWN_BEAT === 0) {
      st.pawnCount = map.pawns.length;
      sweepDeaths(t);
    }

    if (t - st.corpseTick >= CORPSE_BEAT) {
      var elapsed = st.corpseTick ? (t - st.corpseTick) : CORPSE_BEAT;
      st.corpseTick = t;
      tickCorpses(map, st, elapsed);
      checkStench(map, st);
      tickAnimalsEating(map);
      pruneRoster(t);
    }

    if (t - st.scavTick >= SCAVENGE_BEAT) {
      st.scavTick = t;
      tickScavengers(map, st);
    }
  };

  function sweepDeaths(t) {
    roster.forEach(function (e) {
      var pawn = e.pawn;
      if (!pawn.dead || pawn.goreDeathDone) return;
      pawn.goreDeathDone = true;
      e.seen = t;
      /* A killing blow can take a limb with it, and the body it came
         off is already gone from the map: sever what is still owed. */
      if (pawn.map) Gore.severParts(pawn);
      recordDeath(pawn);
    });
  }

  /* ============================================================
     12. STATE

     Everything that belongs to a pawn, a corpse or a severed part is
     a plain field on that pawn, that corpse or that part, so save.js
     carries it without knowing this file exists. What is left is the
     colony's own: the setting, the knobs and the obituary.
     ============================================================ */

  Gore.save = function () {
    return {
      level: Gore.level,
      policy: {
        buryParts: !!Gore.policy.buryParts,
        scavengers: !!Gore.policy.scavengers,
        deathMessages: !!Gore.policy.deathMessages
      },
      deaths: Gore.deaths.slice(-MAX_DEATH_RECORDS)
    };
  };

  Gore.load = function (obj) {
    Gore.reset();
    if (!obj) return false;
    if (obj.level && Gore.LEVELS.indexOf(obj.level) >= 0) Gore.level = obj.level;
    if (obj.policy) {
      if (typeof obj.policy.buryParts === 'boolean') Gore.policy.buryParts = obj.policy.buryParts;
      if (typeof obj.policy.scavengers === 'boolean') Gore.policy.scavengers = obj.policy.scavengers;
      if (typeof obj.policy.deathMessages === 'boolean') {
        Gore.policy.deathMessages = obj.policy.deathMessages;
      }
    }
    if (Array.isArray(obj.deaths)) Gore.deaths = obj.deaths.slice(-MAX_DEATH_RECORDS);
    return true;
  };

  Gore.reset = function () {
    Gore.level = 'full';
    Gore.policy.buryParts = true;
    Gore.policy.scavengers = true;
    Gore.policy.deathMessages = true;
    Gore.deaths = [];
    roster.clear();
    markCache = Object.create(null);
  };

  /* Rows for the UI: the setting, what it is costing and what is
     still lying around. */
  Gore.report = function (map) {
    var rows = [
      { label: 'Gore level', value: Gore.level }
    ];
    if (map) {
      var r = Gore.unburiedReport(map);
      rows.push({ label: 'Bodies unburied', value: r.fresh + r.bloating + r.rotten + r.skeletal });
      rows.push({ label: 'Rotting', value: r.rotten + r.skeletal });
      rows.push({ label: 'Severed remains', value: r.parts });
      var st = map._gore;
      if (st) rows.push({ label: 'Rotting indoors', value: st.rottingIndoors | 0 });
    }
    rows.push({ label: 'Deaths recorded', value: Gore.deaths.length });
    return rows;
  };

  root.Gore = Gore;
})(this);
