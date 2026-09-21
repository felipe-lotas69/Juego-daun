/* ============================================================
   beauty.js - what a place looks like, and who made it look that way.

   regions.js already answers "roughly how pretty is this room": it sums
   def.beauty over the room's cells and divides. That number is honest
   but it is flat, and a flat number cannot make placing a statue a
   decision - a sculpture in the corner of a barracks reads exactly the
   same as one in the middle of it.

   So this file owns the DETAIL and leaves regions.js the structure.
   Beauty lives per CELL. A sculpture pushes beauty into the cells around
   it with distance falloff and stops at the walls of its own room; a
   corpse, spilled blood, rubble and burnt ground push the other way. A
   colonist's mood reads the cell they are standing on, not a room mean,
   which is why walking past the statue is different from sleeping in the
   far corner.

   Taking over without fighting: regions.js writes room.beauty on its own
   rare tick, and it should keep doing so - it is the fallback before
   this file has built a grid for a brand new map. On top of that write,
   Beauty installs an accessor on each Room so a read returns the
   detailed value and regions' own write lands in the backing field. If
   regions.js is ever edited, the one line it should call is
   `Beauty.roomBeautyFor(map, room)` at the end of statsFor, and the
   accessor can go.

   Art is the second half. A sculpture is not "a sculpture": it is a
   piece with a size, a material, a quality rolled from its artist's
   skill and whether they were inspired, a generated TITLE and a
   DESCRIPTION of what it depicts - and what it depicts is drawn from
   the colony's own history, harvested out of Game.letters. A colony
   that survived a siege on day 12 ends up with a stone relief called
   "The Long Watch" that shows people waiting behind sandbags. That is
   the whole point of the system and it costs almost nothing once a
   message log exists.

   Nothing here runs per tick. The grid rebuilds on the slow tick (every
   500) and only when something asked for it; everything else is cached
   on the room or stored as plain scalar fields on the Thing, which is
   how save.js carries a sculpture's title without knowing this file
   exists.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  function sys(name) { return root[name]; }

  /* ============================================================
     TUNING
     ============================================================ */

  /* Mean clamped cell beauty times this is the room number needs.js
     reads, whose bands are -8/-4/-1 ugly and 2/5/10 pretty. A plank
     floor alone lands near 3; one normal sculpture in a small room near
     8; a masterwork near 18. */
  var SCALE = 2.2;
  var CELL_FLOOR = -12;        /* a single vile cell cannot sink a whole room */
  var CELL_CEIL = 14;          /* nor can a single glorious one carry it      */
  var ROOM_LIMIT = 40;         /* the range regions.js already promised       */

  /* Falloff is 1 / (1 + FALLOFF * d^2): full on the object's own tile,
     three quarters one tile away, a tenth at five. */
  var FALLOFF = 0.35;
  var RADIATE_MIN = 3;         /* below this a thing is felt on its own tile only */
  var MAX_RADIUS = 9;

  var QUALITY_NAME = ['awful', 'poor', 'normal', 'good', 'excellent', 'masterwork', 'legendary'];
  var QUALITY_BEAUTY = [0.30, 0.60, 1.00, 1.45, 2.00, 2.70, 3.60];
  var QUALITY_VALUE = [0.35, 0.65, 1.00, 1.60, 2.50, 4.00, 7.00];

  /* What the piece is cut from changes how it reads. Silver catches the
     light; cloth on a frame does not. */
  var STUFF_BEAUTY = {
    wood: 1.00, stoneBlocks: 1.12, stoneChunk: 0.80, steel: 0.92,
    silver: 1.55, cloth: 0.78, leather: 0.84, components: 0.90
  };

  /* "a stone blocks sculpture" is what a database says; "a stone
     sculpture" is what a person says. */
  var STUFF_ADJ = {
    wood: 'wooden', stoneBlocks: 'stone', stoneChunk: 'rough stone', steel: 'steel',
    silver: 'silver', cloth: 'cloth', leather: 'leather', components: 'wired'
  };

  /* A legendary grand silver piece multiplies out to over a hundred,
     which is a white square on the overlay and a room that no second
     statue can improve. Past the knee the curve flattens instead of
     stopping, so quality keeps mattering all the way to legendary
     without any one object owning the map. */
  var ART_KNEE = 35;
  var ART_KNEE_SLOPE = 0.45;
  var ART_BEAUTY_CAP = 95;

  function compressArt(b) {
    if (b <= ART_KNEE) return b;
    return Math.min(ART_BEAUTY_CAP, ART_KNEE + (b - ART_KNEE) * ART_KNEE_SLOPE);
  }

  var ART_SIZES = [
    { id: 'small', label: 'small', beauty: 0.70, value: 0.62, word: 'a small' },
    { id: 'medium', label: 'medium', beauty: 1.00, value: 1.00, word: 'a' },
    { id: 'large', label: 'large', beauty: 1.35, value: 1.55, word: 'a large' },
    { id: 'grand', label: 'grand', beauty: 1.75, value: 2.30, word: 'a grand' }
  ];

  var TIERS = [
    { id: 'hovel', label: 'dreary hovel', min: 0.00 },
    { id: 'shelter', label: 'rough shelter', min: 0.11 },
    { id: 'plain', label: 'plain room', min: 0.22 },
    { id: 'decent', label: 'decent room', min: 0.34 },
    { id: 'fine', label: 'fine room', min: 0.46 },
    { id: 'impressive', label: 'impressive room', min: 0.58 },
    { id: 'grand', label: 'grand room', min: 0.70 },
    { id: 'splendid', label: 'splendid room', min: 0.82 },
    { id: 'magnificent', label: 'magnificent room', min: 0.92 }
  ];

  /* Every room is scored on the same five parts; what changes by role is
     how much each part counts. A hospital that is filthy is a bad
     hospital however many statues are in it. */
  var ROLE_WEIGHTS = {
    none: { beauty: 0.42, space: 0.20, clean: 0.13, wealth: 0.15, finish: 0.10 },
    bedroom: { beauty: 0.44, space: 0.22, clean: 0.10, wealth: 0.12, finish: 0.12 },
    barracks: { beauty: 0.38, space: 0.30, clean: 0.12, wealth: 0.08, finish: 0.12 },
    dining: { beauty: 0.40, space: 0.16, clean: 0.24, wealth: 0.10, finish: 0.10 },
    hospital: { beauty: 0.20, space: 0.18, clean: 0.44, wealth: 0.08, finish: 0.10 },
    throne: { beauty: 0.42, space: 0.20, clean: 0.06, wealth: 0.24, finish: 0.08 },
    workshop: { beauty: 0.22, space: 0.24, clean: 0.32, wealth: 0.10, finish: 0.12 },
    prison: { beauty: 0.34, space: 0.24, clean: 0.20, wealth: 0.08, finish: 0.14 }
  };

  var INSPIRE_DAYS = 1.6;
  var CHRONICLE_LIMIT = 96;

  /* ============================================================
     THOUGHTS

     Registered here rather than in def_pawns.js because they belong to
     this system; needs.js normalises every thought def at load and this
     file loads first, so they arrive in time.
     ============================================================ */

  Defs.add('thought', {
    beautySurroundings: {
      label: 'Surroundings',
      durationDays: 0.35, stackLimit: 1,
      /* The mood number is always supplied by this file - personal taste
         scales it - so these are the fallback and, more usefully, the
         wording the Needs tab shows. It has to work two ways: indoors
         the thought judges this corner against the rest of the room,
         outdoors it is the plain view, and "standing somewhere grim" is
         true of both. */
      stages: [
        { label: 'Standing somewhere grim', mood: -6 },
        { label: 'Standing somewhere ugly', mood: -3 },
        { label: 'Nothing much to look at', mood: 0 },
        { label: 'Standing somewhere pleasant', mood: 3 },
        { label: 'Standing somewhere beautiful', mood: 6 },
        { label: 'Pleasingly plain', mood: 3 },
        { label: 'Free of gaudy vanity', mood: 5 },
        { label: 'Surrounded by vanity', mood: -4 }
      ]
    },
    admiredArtwork: {
      label: 'Admired an artwork',
      durationDays: 1.2, stackLimit: 2,
      stages: [
        { label: 'Looked at a fine sculpture', mood: 3 },
        { label: 'Admired an excellent sculpture', mood: 5 },
        { label: 'Stood before a masterwork', mood: 8 }
      ],
      nullifiedByTrait: ['ascetic']
    },
    artisticInspiration: {
      label: 'Inspired',
      durationDays: 2, stackLimit: 1,
      stages: [{ label: 'Inspired: creativity', mood: 6 }]
    }
  });

  var Beauty = {};

  /* ============================================================
     PER-MAP STATE

     Off to the side in a WeakMap, exactly as regions.js keeps its own,
     so save.js serialises a map without dragging a float grid along.
     ============================================================ */

  var states = new WeakMap();

  function stateOf(map) {
    var st = states.get(map);
    if (st && st.size === map.size) return st;
    st = {
      size: map.size,
      grid: new Float32Array(map.size),
      built: false,
      dirty: true,
      serial: 0,            /* bumped on every rebuild; room caches compare it */
      builtTick: -1,
      sources: 0,           /* how many radiating things the last pass found  */
      artIds: [],
      lastBuildMs: 0
    };
    states.set(map, st);
    return st;
  }

  Beauty.markDirty = function (map) {
    if (!map) return;
    stateOf(map).dirty = true;
  };

  Beauty.reset = function (map) {
    if (map) states.delete(map);
    else {
      chronicle.length = 0;
      seenLetters = Object.create(null);
      artCount = 0;
      lastTick = 0;
    }
  };

  /* ============================================================
     WHAT A THING IS WORTH TO LOOK AT
     ============================================================ */

  Beauty.QUALITY = QUALITY_NAME;

  Beauty.qualityLabel = function (q) {
    return (typeof q === 'number' && QUALITY_NAME[q]) ? QUALITY_NAME[q] : 'normal';
  };
  Beauty.qualityFactor = function (q) {
    return QUALITY_BEAUTY[U.clamp(q | 0, 0, 6)];
  };

  function stuffFactor(stuffId) {
    if (!stuffId) return 1;
    var f = STUFF_BEAUTY[stuffId];
    return f === undefined ? 1 : f;
  }

  function artSizeOf(thing) {
    var id = thing && thing.artSize;
    for (var i = 0; i < ART_SIZES.length; i++) if (ART_SIZES[i].id === id) return ART_SIZES[i];
    return ART_SIZES[1];
  }
  Beauty.artSizeOf = artSizeOf;

  Beauty.isArt = function (thing) {
    return !!(thing && thing.def && thing.def.buildSkill === 'artistic' && (thing.def.beauty || 0) > 0);
  };

  function corpseBeauty(thing) {
    var c = thing.corpse;
    var kind = c ? Defs.maybe('pawnKind', c.kindId) : null;
    var human = !!(kind && kind.body === 'human');
    var rot = U.clamp01(thing.rotProgress || 0);
    /* A body nobody has buried gets worse to be near, which is the whole
       argument for digging graves before the flies find it. */
    return (human ? -8 : -5) * (1 + 1.1 * rot);
  }

  /* The number this thing pushes into the world. Quality, material and
     size only apply to things that were made to be looked at; a damaged
     one is worth less and eventually worth nothing. */
  Beauty.thingBeauty = function (thing) {
    if (!thing || !thing.def) return 0;
    if (thing.corpse) return corpseBeauty(thing);
    if (thing.isBlueprint) return 0;
    if (thing.isFrame) return -1;          /* an unfinished build is a building site */

    var def = thing.def;
    var b = def.beauty || 0;
    if (!b) return 0;

    if (b > 0) {
      if (typeof thing.quality === 'number') b *= QUALITY_BEAUTY[U.clamp(thing.quality | 0, 0, 6)];
      if (Beauty.isArt(thing)) {
        b = compressArt(b * artSizeOf(thing).beauty * stuffFactor(thing.stuff));
      }
      var maxHp = thing.maxHp || def.hp || 0;
      if (maxHp > 0 && thing.hp !== undefined && thing.hp < maxHp * 0.6) {
        var frac = U.clamp01(thing.hp / (maxHp * 0.6));
        b = b * (0.25 + 0.75 * frac) - 1.5 * (1 - frac);
      }
    }
    return b;
  };

  Beauty.artValue = function (thing) {
    if (!thing || !thing.def) return 0;
    var v = thing.def.marketValue || 0;
    if (typeof thing.quality === 'number') v *= QUALITY_VALUE[U.clamp(thing.quality | 0, 0, 6)];
    if (Beauty.isArt(thing)) v *= artSizeOf(thing).value;
    return Math.round(v);
  };

  /* ============================================================
     THE CELL GRID
     ============================================================ */

  /* Art stops at the wall it stands against. Comparing room ids is an
     integer test and it is exactly the right answer: a statue in the
     dining room does nothing for the corridor outside, which is what
     makes where you put it a decision rather than a formality. Before
     regions.js has ever labelled the map every id is 0, so the test
     passes everywhere and the falloff alone decides - which is the
     right behaviour for a map that has no rooms yet. */
  function splat(map, grid, cx, cy, value, radius, srcRoom) {
    var w = map.w, h = map.h, roomId = map.roomId;
    var x0 = cx - radius; if (x0 < 0) x0 = 0;
    var y0 = cy - radius; if (y0 < 0) y0 = 0;
    var x1 = cx + radius; if (x1 > w - 1) x1 = w - 1;
    var y1 = cy + radius; if (y1 > h - 1) y1 = h - 1;
    var r2 = radius * radius;

    for (var y = y0; y <= y1; y++) {
      var dy = y - cy, row = y * w, dy2 = dy * dy;
      for (var x = x0; x <= x1; x++) {
        var dx = x - cx, d2 = dx * dx + dy2;
        if (d2 > r2) continue;
        var i = row + x;
        if (roomId[i] !== srcRoom) continue;
        grid[i] += value / (1 + FALLOFF * d2);
      }
    }
  }

  function radiusFor(value) {
    var mag = value < 0 ? -value : value;
    return U.clamp(Math.round(2 + mag * 0.14), 1, MAX_RADIUS);
  }

  function build(map, st) {
    var size = map.size, w = map.w;
    var grid = st.grid;
    var terrains = Defs.all('terrain');
    var Fire = sys('Fire');
    var scorchAsk = Fire && Fire.scorchAt ? Fire : null;
    var roomId = map.roomId;
    var sx = [], sy = [], sv = [], srcs = 0;
    var artIds = st.artIds;
    var i, k, t, list, d;

    grid.fill(0);
    artIds.length = 0;

    for (i = 0; i < size; i++) {
      var cx = i % w, cy = (i - cx) / w;
      var here = 0;

      var td = terrains[map.terrain[i]];
      if (td && td.beauty) here += td.beauty;

      /* An unbuilt floor under a roof is not neutral, it is a dirt
         floor in a house, and that is the state a colony grows out of. */
      if (td && !td.buildCategory && map.roof[i] !== 0) here -= 0.4;

      var blood = map.blood[i];
      if (blood) here -= 5 * (blood / 255);

      if (scorchAsk) {
        var sc = scorchAsk.scorchAt(map, cx, cy);
        if (sc) here -= 3.2 * sc;
      }

      var pid = map.plantId[i];
      if (pid) {
        t = map.things.get(pid);
        if (t && t.def && t.def.beauty) here += t.def.beauty;
      }

      var bid = map.buildingId[i];
      if (bid) {
        t = map.things.get(bid);
        /* Count a multi-tile building once, at its own corner, and push
           it from the middle of its footprint. */
        if (t && t.def && t.x === cx && t.y === cy) {
          var bv = Beauty.thingBeauty(t);
          if (bv) {
            if (bv >= RADIATE_MIN || bv <= -RADIATE_MIN) {
              d = t.def.size;
              var mx = cx + (d && d.w > 1 ? (d.w - 1) >> 1 : 0);
              var my = cy + (d && d.h > 1 ? (d.h - 1) >> 1 : 0);
              sx[srcs] = mx; sy[srcs] = my; sv[srcs] = bv; srcs++;
            } else here += bv;
          }
          if (Beauty.isArt(t)) artIds.push(t.id);
        }
      }

      list = map.itemGrid[i];
      if (list) {
        for (k = 0; k < list.length; k++) {
          t = list[k];
          if (!t || !t.def) continue;
          var iv = Beauty.thingBeauty(t);
          if (!iv) continue;
          if (iv >= RADIATE_MIN || iv <= -RADIATE_MIN) {
            sx[srcs] = cx; sy[srcs] = cy; sv[srcs] = iv; srcs++;
          } else here += iv;
          if (Beauty.isArt(t)) artIds.push(t.id);
        }
      }

      if (here) grid[i] += here;
    }

    for (k = 0; k < srcs; k++) {
      var v = sv[k];
      splat(map, grid, sx[k], sy[k], v, radiusFor(v), roomId[sy[k] * w + sx[k]]);
    }

    st.sources = srcs;
    st.built = true;
    st.dirty = false;
    st.serial++;
  }

  /* Rebuild only when something asked for it or enough time has passed
     that the world has moved on anyway. Callers that must have the
     current answer pass force. */
  Beauty.refresh = function (map, force) {
    if (!map || !map.size) return null;
    var st = stateOf(map);
    var now = tickNow();
    if (force || !st.built || st.dirty || now - st.builtTick >= 500) {
      /* The room labels are what stops art passing through walls, so
         they have to be current before the splats go in. */
      var R = sys('Regions');
      if (R && R.update) R.update(map);
      build(map, st);
      st.builtTick = now;
    }
    return st;
  };

  Beauty.grid = function (map) {
    if (!map) return null;
    var st = stateOf(map);
    if (!st.built) Beauty.refresh(map, true);
    return st.grid;
  };

  Beauty.cellBeauty = function (map, i) {
    if (!map || i < 0 || i >= map.size) return 0;
    var st = stateOf(map);
    if (!st.built) Beauty.refresh(map, true);
    return st.grid[i];
  };

  Beauty.beautyAt = function (map, x, y) {
    if (!map || !map.inBounds(x, y)) return 0;
    return Beauty.cellBeauty(map, y * map.w + x);
  };

  /* ============================================================
     ROOMS

     The number needs.js and royalty.js read, and the accessor that gets
     it to them without either file knowing this one exists.
     ============================================================ */

  Beauty.roomBeautyFor = function (map, room) {
    if (!map || !room || !room.cells || !room.cells.length) return 0;
    var st = stateOf(map);
    if (!st.built) return null;          /* nothing computed yet; use the rough value */
    var grid = st.grid, cells = room.cells, n = cells.length;
    var sum = 0;
    for (var k = 0; k < n; k++) {
      var v = grid[cells[k]];
      sum += v < CELL_FLOOR ? CELL_FLOOR : (v > CELL_CEIL ? CELL_CEIL : v);
    }
    return U.clamp((sum / n) * SCALE, -ROOM_LIMIT, ROOM_LIMIT);
  };

  /* One cached read per room per grid rebuild: needs.js asks once per
     pawn per rare tick and a 200-cell average would otherwise be walked
     a dozen times for the same answer. */
  function cachedRoomBeauty(map, room) {
    var st = states.get(map);
    if (!st || !st.built) return null;
    if (room._beautyStamp === st.serial) return room._beautyCache;
    var v = Beauty.roomBeautyFor(map, room);
    room._beautyStamp = st.serial;
    room._beautyCache = v;
    return v;
  }

  /* regions.js keeps writing its own estimate; that write lands in the
     closure and is what a reader gets until the grid exists. */
  Beauty.hookRoom = function (map, room) {
    if (!room || room._beautyHooked) return room;
    var rough = room.beauty || 0;
    try {
      Object.defineProperty(room, 'beauty', {
        configurable: true,
        enumerable: true,
        get: function () {
          var v = cachedRoomBeauty(map, room);
          return v === null || v === undefined ? rough : v;
        },
        set: function (v) { rough = v; }
      });
      room._beautyHooked = true;
    } catch (e) {
      /* A frozen room object is not worth failing a tick over; the
         rough value stays and everything below still works. */
      room._beautyHooked = true;
    }
    return room;
  };

  Beauty.hookRooms = function (map) {
    var R = sys('Regions');
    if (!R || !R.rooms || !map) return 0;
    var rooms = R.rooms(map), n = 0;
    rooms.forEach(function (room) {
      if (!room._beautyHooked) { Beauty.hookRoom(map, room); n++; }
    });
    return n;
  };

  /* ============================================================
     ROOM STATS AND IMPRESSIVENESS
     ============================================================ */

  function roomMap(room) {
    /* Rooms do not carry their map, so the live one is the only sensible
       default and is right in every call the game makes. */
    var G = sys('Game');
    return (G && G.map) || null;
  }

  function isMedicalBed(bed) {
    var M = sys('Medicine');
    if (M && M.isMedicalBed) return !!M.isMedicalBed(bed);
    return !!(bed && bed.medical);
  }

  function bedOwner(map, bed) {
    if (!bed) return null;
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].ownedBedId === bed.id) return list[i];
    }
    return null;
  }

  /* regions.js answers bedroom/barracks/dining/workshop. The three roles
     it cannot see are the ones that belong to files written after it. */
  function refineRole(map, room) {
    var role = room.role || 'none';
    if (room.outdoor) return 'none';
    var beds = [], i, t;
    for (i = 0; i < room.cells.length; i++) {
      var bid = map.buildingId[room.cells[i]];
      if (!bid) continue;
      t = map.things.get(bid);
      if (!t || !t.def || !t.def.building || !t.def.building.isBed) continue;
      if (beds.indexOf(t) < 0) beds.push(t);
    }
    for (i = 0; i < beds.length; i++) {
      if (isMedicalBed(beds[i])) return 'hospital';
      if (beds[i].forPrisoners) return 'prison';
    }
    var Royalty = sys('Royalty');
    if (Royalty && Royalty.titleOf) {
      for (i = 0; i < beds.length; i++) {
        var owner = bedOwner(map, beds[i]);
        if (owner && Royalty.titleOf(owner)) return 'throne';
      }
    }
    return role;
  }

  /* How much of the room somebody actually finished, and what is
     standing in it. Wealth is recounted here rather than read off the
     room: regions.js refreshes room.wealth on its own rare tick, so a
     sculpture finished thirty seconds ago would not be in it yet, and
     "I built the statue and the number did not move" is the kind of
     thing that makes a player stop trusting a readout. */
  function surveyRoom(map, room) {
    var cells = room.cells, n = cells.length, floored = 0, wealth = 0;
    var terrains = Defs.all('terrain');
    for (var k = 0; k < n; k++) {
      var i = cells[k];
      var td = terrains[map.terrain[i]];
      if (td && td.buildCategory) floored++;

      var cx = i % map.w, cy = (i - cx) / map.w;
      var bid = map.buildingId[i];
      if (bid) {
        var b = map.things.get(bid);
        if (b && b.def && b.x === cx && b.y === cy) {
          wealth += Beauty.isArt(b) ? Beauty.artValue(b) : (b.def.marketValue || 0);
        }
      }
      var list = map.itemGrid[i];
      if (list) {
        for (var j = 0; j < list.length; j++) {
          var t = list[j];
          if (!t || !t.def) continue;
          wealth += (Beauty.isArt(t) ? Beauty.artValue(t) : (t.def.marketValue || 0)) * (t.stack || 1);
        }
      }
    }
    var floorFrac = n ? floored / n : 0;
    return {
      floorFrac: floorFrac,
      wealth: wealth,
      score: U.clamp01(floorFrac * 0.65 + (room.roofedFrac || 0) * 0.35)
    };
  }

  Beauty.tier = function (v) {
    var t = TIERS[0];
    for (var i = 0; i < TIERS.length; i++) if (v >= TIERS[i].min) t = TIERS[i];
    return { index: TIERS.indexOf(t), id: t.id, label: t.label };
  };
  Beauty.tiers = function () { return TIERS.slice(); };

  Beauty.roomStats = function (room, map) {
    map = map || roomMap(room);
    if (!room || !map) return null;
    if (!room._beautyHooked) Beauty.hookRoom(map, room);

    var role = room.outdoor ? 'none' : refineRole(map, room);
    var weights = ROLE_WEIGHTS[role] || ROLE_WEIGHTS.none;
    var fin = surveyRoom(map, room);

    var beauty = room.beauty || 0;
    var clean = room.cleanliness || 0;
    var size = room.size || 0;
    var wealth = fin.wealth;

    var parts = {
      beauty: U.clamp01((beauty + 8) / 40),
      space: U.clamp01(size / 75),
      clean: U.clamp01((clean + 1) / 2.4),
      wealth: U.clamp01(wealth / 3000),
      finish: fin.score
    };

    var score = 0;
    for (var key in weights) score += weights[key] * parts[key];
    /* Outdoors is weather, not decorating: it is never impressive and it
       is never a hovel. */
    if (room.outdoor) score = 0;
    score = U.clamp01(score);

    var art = Beauty.artInRoom(map, room);
    return {
      id: room.id,
      role: role,
      outdoor: !!room.outdoor,
      size: size,
      beauty: Math.round(beauty * 10) / 10,
      cleanliness: Math.round(clean * 100) / 100,
      wealth: Math.round(wealth),
      roofedFrac: Math.round((room.roofedFrac || 0) * 100) / 100,
      floorFrac: Math.round(fin.floorFrac * 100) / 100,
      parts: parts,
      weights: weights,
      impressiveness: score,
      tier: Beauty.tier(score),
      artCount: art.length,
      bestArt: art.length ? art[0] : null,
      advice: Beauty.advice(map, room, role, parts)
    };
  };

  Beauty.impressiveness = function (room, map) {
    var s = Beauty.roomStats(room, map);
    return s ? s.impressiveness : 0;
  };

  /* What the room is short of, worst first, in the words a player would
     use. This is the whole legibility half of the system: a number that
     says 0.31 tells nobody what to build next. */
  Beauty.advice = function (map, room, role, parts) {
    var out = [];
    if (!room || room.outdoor) return out;
    if (parts.finish < 0.55) out.push({ id: 'floor', label: 'bare ground underfoot', gain: 0.9 - parts.finish });
    if (parts.beauty < 0.45) out.push({ id: 'art', label: 'nothing worth looking at', gain: 0.8 - parts.beauty });
    if (parts.clean < 0.40) out.push({ id: 'clean', label: 'filthy', gain: 0.9 - parts.clean });
    if (parts.space < 0.35) out.push({ id: 'space', label: 'cramped', gain: 0.7 - parts.space });
    if (role === 'hospital' && parts.clean < 0.7) {
      out.push({ id: 'sterile', label: 'not clean enough to operate in', gain: 1 });
    }
    if (role === 'dining' && parts.clean < 0.55) {
      out.push({ id: 'diningClean', label: 'people are eating in this', gain: 0.8 });
    }
    if (role === 'throne' && parts.wealth < 0.5) {
      out.push({ id: 'throneWealth', label: 'too plain for a noble', gain: 0.7 });
    }
    if ((room.roofedFrac || 0) < 0.9 && !room.outdoor) {
      out.push({ id: 'roof', label: 'open to the sky', gain: 0.6 });
    }
    out.sort(function (a, b) { return b.gain - a.gain; });
    return out;
  };

  Beauty.artInRoom = function (map, room) {
    if (!map || !room || !room.cells) return [];
    var st = stateOf(map);
    if (!st.built) Beauty.refresh(map, true);
    var out = [];
    for (var k = 0; k < st.artIds.length; k++) {
      var t = map.things.get(st.artIds[k]);
      if (!t || !t.spawned) continue;
      if (map.roomId[t.y * map.w + t.x] !== room.id) continue;
      out.push(t);
    }
    out.sort(function (a, b) { return Beauty.thingBeauty(b) - Beauty.thingBeauty(a); });
    return out;
  };

  Beauty.artworks = function (map) {
    if (!map) return [];
    var st = stateOf(map);
    if (!st.built) Beauty.refresh(map, true);
    var out = [];
    for (var k = 0; k < st.artIds.length; k++) {
      var t = map.things.get(st.artIds[k]);
      if (t && t.spawned) out.push(t);
    }
    return out;
  };

  /* ============================================================
     THE CHRONICLE

     What has actually happened here, harvested out of Game.letters. It
     is the only record of the colony's life that exists, and it is
     exactly what a sculpture needs to be about.
     ============================================================ */

  var chronicle = [];
  var seenLetters = Object.create(null);
  var artCount = 0;
  var lastTick = 0;

  function tickNow() {
    var G = sys('Game');
    return G ? (G.tick | 0) : 0;
  }
  function dayNow() {
    var G = sys('Game');
    return G && G.day ? G.day() : 0;
  }

  function classify(title, text, kind) {
    var t = String(title || '').toLowerCase();
    if (kind === 'death' || / has died/.test(t)) return 'death';
    if (/crash landing|landing|first day/.test(t)) return 'founding';
    if (/beaten|have gone|breaking|breaks/.test(t)) return 'victory';
    if (/raid|raider|siege|assault/.test(t)) return 'raid';
    if (/manhunter|predator|pack/.test(t)) return 'beasts';
    if (/join|refugee|wanderer|recruit/.test(t)) return 'joined';
    if (/eclipse|flare|heat wave|cold snap|blight|flu|plague|disease/.test(t)) return 'hardship';
    if (/cargo|fine work|harvest|gift|trade/.test(t)) return 'fortune';
    if (/fire|burn/.test(t)) return 'fire';
    return 'event';
  }

  function nameFrom(title) {
    var m = /^(.+?) has died/.exec(String(title || ''));
    if (m) return m[1].trim();
    return null;
  }

  Beauty.note = function (kind, title, opts) {
    opts = opts || {};
    chronicle.push({
      kind: kind || 'event',
      title: String(title || '').slice(0, 90),
      who: opts.who || null,
      day: opts.day === undefined ? dayNow() : opts.day,
      tick: opts.tick === undefined ? tickNow() : opts.tick
    });
    if (chronicle.length > CHRONICLE_LIMIT) chronicle.splice(0, chronicle.length - CHRONICLE_LIMIT);
    return chronicle[chronicle.length - 1];
  };

  Beauty.chronicle = function () { return chronicle.slice(); };

  function harvest(game) {
    var letters = game && game.letters;
    if (!letters) return 0;
    var added = 0;
    for (var i = 0; i < letters.length; i++) {
      var L = letters[i];
      if (!L || seenLetters[L.id]) continue;
      seenLetters[L.id] = 1;
      Beauty.note(classify(L.title, L.text, L.kind), L.title,
        { who: nameFrom(L.title), day: Math.floor((L.tick || 0) / 60000), tick: L.tick || 0 });
      added++;
    }
    return added;
  }

  /* ============================================================
     ART: TITLES AND DESCRIPTIONS
     ============================================================ */

  var ADJ = {
    grim: ['Silent', 'Broken', 'Cold', 'Last', 'Long', 'Bitter', 'Hollow', 'Grey', 'Unquiet'],
    bright: ['Bright', 'Rising', 'First', 'Golden', 'Open', 'Steady', 'Wide', 'Unbroken'],
    plain: ['Small', 'Still', 'Turning', 'Deep', 'Far', 'Old', 'Patient', 'Nameless']
  };

  var NOUN = {
    death: ['Vigil', 'Mourning', 'Remembrance', 'Departure', 'Absence', 'Grave'],
    raid: ['Line', 'Siege', 'Approach', 'Watch', 'Threshold', 'Muster'],
    victory: ['Stand', 'Breaking', 'Return', 'Reckoning', 'Answer'],
    founding: ['Landing', 'Beginning', 'Descent', 'Arrival', 'First Light'],
    joined: ['Welcome', 'Stranger', 'Opening', 'Hand'],
    hardship: ['Winter', 'Dark', 'Famine', 'Long Night', 'Endurance'],
    fortune: ['Harvest', 'Gift', 'Plenty', 'Windfall'],
    beasts: ['Hunt', 'Pack', 'Teeth', 'Quarry'],
    fire: ['Burning', 'Ash', 'Smoke', 'Ember'],
    event: ['Form', 'Study', 'Composition', 'Figure', 'Movement', 'Rhythm', 'Shape']
  };

  var TONE = {
    death: 'grim', raid: 'grim', hardship: 'grim', beasts: 'grim', fire: 'grim',
    victory: 'bright', founding: 'bright', joined: 'bright', fortune: 'bright',
    event: 'plain'
  };

  var ABSTRACT = [
    'an abstract spiral turning in on itself',
    'interlocking geometric forms',
    'a stylised muffalo with its head lowered',
    'a human figure with both arms raised',
    'a pattern of wind moving through grass',
    'two hands meeting at the wrist',
    'a tree with its roots showing'
  ];

  var ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

  function subjectFor(entry) {
    if (!entry) return U.pick(ABSTRACT);
    var who = entry.who;
    var day = entry.day;
    switch (entry.kind) {
      case 'founding': return U.pick([
        'the landing of the escape pods',
        'survivors walking away from a wreck',
        'the first fire lit on this world'
      ]);
      case 'death': return who ? U.pick([
        'the death of ' + who,
        who + ' as they were remembered',
        'a grave dug for ' + who
      ]) : 'a colonist who did not come back';
      case 'raid': return U.pick([
        'armed strangers coming out of the treeline',
        'the colony waiting behind sandbags',
        'the raid of day ' + day
      ]);
      case 'victory': return U.pick([
        'the day the raiders broke and ran',
        'a line that held',
        'the last attacker fleeing the field'
      ]);
      case 'beasts': return U.pick([
        'a pack of animals turning on the colony',
        'a hunt that went the wrong way'
      ]);
      case 'joined': return who ? 'the arrival of ' + who : U.pick([
        'a stranger walking into camp',
        'a hand offered to someone with nothing'
      ]);
      case 'hardship': return U.pick([
        'a colony under a dead sun',
        'the cold of that winter',
        'a season that would not end'
      ]);
      case 'fortune': return U.pick([
        'supplies falling out of the sky',
        'a store room finally full'
      ]);
      case 'fire': return U.pick([
        'a roof going up in flames',
        'smoke standing over the fields'
      ]);
      default: return U.pick([
        'a scene from the life of the colony',
        'people at work on day ' + day
      ]);
    }
  }

  function titleFor(kind, who) {
    var tone = TONE[kind] || 'plain';
    var adj = U.pick(ADJ[tone]);
    var noun = U.pick(NOUN[kind] || NOUN.event);
    artCount++;
    var roll = U.randInt(1, 5);
    if (roll === 1) return 'The ' + adj + ' ' + noun;
    if (roll === 2 && who) return noun + ' of ' + who;
    if (roll === 3) return adj + ' ' + noun;
    if (roll === 4) return noun + ' ' + ROMAN[Math.min(ROMAN.length - 1, (artCount - 1) % ROMAN.length)];
    return who ? who + '’s ' + noun : 'The ' + adj + ' ' + noun;
  }

  var CRAFT = [
    ['The proportions are wrong and the surface is badly gouged.', 'It is hard to look at for long.'],
    ['The cuts are uneven and the figures are crowded.', 'It reads as a first attempt.'],
    ['The work is competent and clearly finished.', 'It does what it set out to do.'],
    ['The lines are clean and the composition balanced.', 'Someone took their time with it.'],
    ['Every figure is picked out with real care.', 'People stop in front of it without meaning to.'],
    ['The surface is worked to a finish that catches the light.', 'It is the best thing in the colony.'],
    ['Nothing in it could be moved without making it worse.', 'People who see it talk about it for days.']
  ];

  function stuffWord(thing) {
    if (!thing.stuff) return '';
    if (STUFF_ADJ[thing.stuff]) return STUFF_ADJ[thing.stuff];
    var d = Defs.maybe('thing', thing.stuff);
    return d ? (d.label || thing.stuff) : thing.stuff;
  }

  /* Everything a UI panel needs about one piece, and nothing it has to
     recompute. Safe to call on any thing; a plank gets a plank's
     answer. */
  Beauty.describeArt = function (thing) {
    if (!thing || !thing.def) return null;
    var q = typeof thing.quality === 'number' ? U.clamp(thing.quality | 0, 0, 6) : 2;
    var size = artSizeOf(thing);
    var material = stuffWord(thing);
    var art = Beauty.isArt(thing);

    var craft = CRAFT[q];
    var lines = [];
    /* Built as "A large stone sculpture." rather than pasted around an
       article, which is what stops "a excellent piece" ever appearing. */
    lines.push(U.cap(size.word) + ' ' +
      (material ? material + ' ' : '') + (thing.def.label || 'thing') + '.');
    if (thing.artDesc) lines.push('It depicts ' + thing.artDesc + '.');
    lines.push(U.cap(QUALITY_NAME[q]) + ' work. ' + craft[0] + ' ' + craft[1]);
    if (thing.artAuthor) {
      lines.push('Carved by ' + thing.artAuthor +
        (thing.artDay === undefined ? '' : ' on day ' + thing.artDay) + '.');
    } else if (art) {
      lines.push('Its maker is not recorded.');
    }

    return {
      title: thing.artTitle || (U.cap(thing.def.label || 'artwork')),
      description: lines.join(' '),
      lines: lines,
      depicts: thing.artDesc || null,
      author: thing.artAuthor || null,
      day: thing.artDay === undefined ? null : thing.artDay,
      quality: q,
      qualityLabel: QUALITY_NAME[q],
      size: size.id,
      material: material || null,
      beauty: Math.round(Beauty.thingBeauty(thing) * 10) / 10,
      value: Beauty.artValue(thing),
      isArt: art
    };
  };

  /* Who is most likely to have made this. construct.js does not record a
     builder, so: whoever is standing next to a piece that appeared in
     the last slow tick, else the colony's best artist. Both are honest
     guesses and the second one is right most of the time. */
  function creditArtist(map, thing) {
    var now = tickNow();
    var best = null, bestSkill = -1, i, p;
    var fresh = now - (thing.spawnTick || 0) <= 600;
    for (i = 0; i < map.pawns.length; i++) {
      p = map.pawns[i];
      if (!p || p.dead || p.faction !== 'player' || !p.isHuman) continue;
      if (fresh && U.cheb(p.x, p.y, thing.x, thing.y) <= 2) return p;
      var lvl = p.skillLevel ? p.skillLevel('artistic') : 0;
      if (lvl > bestSkill) { bestSkill = lvl; best = p; }
    }
    return best;
  }

  function rollArtSize(skill) {
    return U.pickWeighted(ART_SIZES, function (s) {
      if (s.id === 'small') return 3;
      if (s.id === 'medium') return 5;
      if (s.id === 'large') return 1 + skill * 0.25;
      return 0.2 + skill * 0.18;
    });
  }

  /* Give a piece its identity. Everything written here is a scalar on
     the Thing, which is exactly what save.js carries without being told
     anything about this file. */
  Beauty.nameArt = function (thing, artist, map) {
    if (!thing || !thing.def || thing.artTitle) return null;
    map = map || (sys('Game') && sys('Game').map);

    var skill = artist && artist.skillLevel ? artist.skillLevel('artistic') : 0;
    var inspired = artist ? Beauty.isInspired(artist) : false;

    if (typeof thing.quality !== 'number') {
      thing.quality = U.clamp(Math.round(U.gauss(1 + skill * 0.16, 1.1, 0, 6)), 0, 6);
    }
    if (inspired) {
      thing.quality = U.clamp((thing.quality | 0) + U.randInt(1, 2), 0, 6);
      Beauty.endInspiration(artist, thing);
    }
    thing.artSize = rollArtSize(skill).id;

    var entry = pickChronicle();
    thing.artDesc = subjectFor(entry);
    thing.artTitle = titleFor(entry ? entry.kind : 'event', entry ? entry.who : null);
    thing.artAuthor = artist && artist.fullName ? artist.fullName() :
      (artist && artist.name ? (artist.name.nick || artist.name.first) : null);
    thing.artDay = dayNow();

    Beauty.note('art', thing.artTitle, { who: thing.artAuthor });
    if (map) Beauty.markDirty(map);

    /* Only a piece this colony made is worth interrupting the player
       for, and only when it came out better than ordinary. */
    var G = sys('Game');
    if (G && artist && thing.quality >= 4 && G.letter) {
      var d = Beauty.describeArt(thing);
      G.letter('A work of art: ' + d.title,
        thing.artAuthor + ' has finished ' + d.qualityLabel + ' work. ' + d.description,
        { kind: 'good', x: thing.x, y: thing.y });
    } else if (G && artist && G.msg) {
      G.msg('"' + thing.artTitle + '" is finished.', { type: 'info', x: thing.x, y: thing.y });
    }
    return thing;
  };

  /* Recent history is more likely to be on an artist's mind than the
     landing, but the landing never quite goes away. */
  function pickChronicle() {
    if (!chronicle.length) return null;
    var now = tickNow();
    return U.pickWeighted(chronicle, function (e) {
      var ageDays = Math.max(0, (now - (e.tick || 0)) / 60000);
      var base = e.kind === 'founding' ? 1.4 : (e.kind === 'art' ? 0.25 : 1);
      if (e.kind === 'death' || e.kind === 'victory' || e.kind === 'raid') base *= 1.8;
      return base / (1 + ageDays * 0.12);
    });
  }

  /* ============================================================
     INSPIRATION

     Per-pawn state is two plain numeric fields, so save.js carries it
     with the rest of the pawn and nothing here needs a load hook.
     ============================================================ */

  Beauty.isInspired = function (pawn) {
    return !!(pawn && pawn.artInspiredTicks > 0);
  };

  Beauty.inspire = function (pawn) {
    if (!pawn || pawn.dead || Beauty.isInspired(pawn)) return false;
    pawn.artInspiredTicks = Math.round(INSPIRE_DAYS * 60000);
    pawn.artInspiredCount = (pawn.artInspiredCount | 0) + 1;
    var N = sys('Needs');
    if (N && N.addThought) N.addThought(pawn, 'artisticInspiration', { degree: 0 });
    var G = sys('Game');
    if (G && G.letter) {
      G.letter('Inspired: creativity',
        (pawn.fullName ? pawn.fullName() : 'A colonist') + ' has an idea they cannot let go of. ' +
        'The next sculpture they finish will be better than they can usually manage - ' +
        'but the mood passes in a day and a half.',
        { kind: 'good', x: pawn.x, y: pawn.y });
    }
    return true;
  };

  Beauty.endInspiration = function (pawn, thing) {
    if (!pawn || !Beauty.isInspired(pawn)) return false;
    pawn.artInspiredTicks = 0;
    var N = sys('Needs');
    if (N && N.addThought && thing) {
      N.addThought(pawn, 'admiredArtwork', { degree: 2 });
    }
    return true;
  };

  function tickInspiration(pawn, elapsed) {
    if (pawn.artInspiredTicks > 0) {
      pawn.artInspiredTicks -= elapsed;
      if (pawn.artInspiredTicks <= 0) pawn.artInspiredTicks = 0;
      return;
    }
    var skill = pawn.skillLevel ? pawn.skillLevel('artistic') : 0;
    if (skill < 4) return;
    var mood = typeof pawn.mood === 'number' ? pawn.mood : 0.5;
    if (mood < 0.55) return;
    var s = pawn.skills && pawn.skills.artistic;
    var passion = s ? (s.passion | 0) : 0;
    /* About one idea per artist per eight days at skill 8 with an
       ordinary mood, and rather more often for someone who is good at
       this and enjoying themselves. */
    var per = (0.0008 + skill * 0.00011) * (1 + passion * 0.45) * (0.5 + mood);
    if (U.chance(per)) Beauty.inspire(pawn);
  }

  /* ============================================================
     PERSONAL TASTE

     Two colonists standing on the same tile do not see the same room.
     An artist reads the whole thing; a brawler barely notices; and an
     ideoligion that holds decoration to be vanity turns the sign over.
     ============================================================ */

  /* HOW MUCH this colonist cares is a magnitude; WHETHER they read
     beauty the usual way round is a separate flag, applied once at the
     end. Multiplying two negatives together would quietly hand an
     ascetic in a self-denying faith an ordinary taste for statues,
     which is the opposite of both halves of what was said about them. */
  Beauty.tasteOf = function (pawn) {
    if (!pawn || !pawn.isHuman) return 0;
    var f = 1, inverted = false;

    var skill = pawn.skillLevel ? pawn.skillLevel('artistic') : 0;
    f += skill * 0.045;
    var s = pawn.skills && pawn.skills.artistic;
    if (s && s.passion) f += s.passion === 2 ? 0.3 : 0.14;

    var traits = pawn.traits || [];
    if (traits.indexOf('ascetic') >= 0) { inverted = true; f *= 0.55; }
    if (traits.indexOf('psychopath') >= 0) f *= 0.7;
    if (traits.indexOf('neurotic') >= 0) f *= 1.2;
    if (traits.indexOf('volatile') >= 0) f *= 1.15;
    if (traits.indexOf('ironWilled') >= 0) f *= 0.8;

    var bs = pawn.backstories;
    if (bs) {
      if (bs.adulthood === 'adultArtist' || bs.childhood === 'childNobleBrat') f *= 1.3;
      if (bs.childhood === 'childUrchin' || bs.adulthood === 'adultDrifter') f *= 0.8;
    }

    /* The ideoligion scales what decoration is worth; it does not
       normally turn it over, because "functional" is the degree every
       generated faith starts on and a colony where nobody values a
       floor by default would be the wrong game. The inversion is
       reserved for a faith actually built on self-denial. */
    var Ideo = sys('Ideology');
    if (Ideo) {
      if (Ideo.precept) {
        var p = null;
        try { p = Ideo.precept(pawn, 'building'); } catch (e) { p = null; }
        if (p) {
          if (p.id === 'functional') f *= 0.85;
          else if (p.id === 'decorated') f *= 1.15;
          else if (p.id === 'monumental') f *= 1.7;
        }
      }
      if (Ideo.hasMeme) {
        try {
          /* A faith of guilt or of holy pain reads a beautiful room as
             vanity and a bare one as the point: the sign flips, and
             every statue the colony owns becomes a liability. */
          if (Ideo.hasMeme(pawn, 'guilty') || Ideo.hasMeme(pawn, 'painism')) {
            inverted = true;
            f *= 0.9;
          } else if (Ideo.hasMeme(pawn, 'highLife')) f *= 1.45;
          else if (Ideo.hasMeme(pawn, 'naturePrimacy')) f *= 0.75;
        } catch (e) { /* an ideology mid-generation is not worth a throw */ }
      }
    }

    return U.clamp(inverted ? -f : f, -1.6, 2.8);
  };

  /* ============================================================
     WHAT A PAWN SEES FROM WHERE THEY STAND
     ============================================================ */

  function moodFromBeauty(local, indoor, taste, cell) {
    /* Indoors the pawn is judging the decorating, so what counts is how
       this spot differs from the rest of the room - that difference is
       the statue. Outdoors there is nothing to compare against and the
       absolute reading is the honest one, at half weight, because
       nobody expects a field to be decorated. */
    if (!indoor) return U.clamp(local * 0.42 * taste, -5, 7);

    /* The relative gain always counts: standing by the statue is better
       than standing away from it, full stop. The relative LOSS only
       counts in proportion to how unpleasant the corner is on its own
       terms, because a dull end of a beautiful gallery is still a
       beautiful gallery, and a colonist who walked in smiling should
       not be told they are somewhere grim. */
    var adjusted = local;
    if (local < 0) adjusted = local * U.clamp01((6 - cell) / 12);
    return U.clamp(adjusted * 0.60 * taste, -5, 8);
  }

  function degreeFor(mood, taste) {
    if (taste < 0) {
      if (mood >= 4) return 6;
      if (mood > 0) return 5;
      return 7;
    }
    if (mood <= -4) return 0;
    if (mood <= -1.5) return 1;
    if (mood < 1.5) return 2;
    if (mood < 4) return 3;
    return 4;
  }

  function clearThought(pawn, id) {
    var list = pawn.thoughts;
    if (!list) return;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].defId === id) { list.splice(i, 1); pawn._moodDirty = true; }
    }
  }

  Beauty.observe = function (pawn) {
    if (!pawn || pawn.dead || !pawn.isHuman || !pawn.map || !pawn.thoughts) return null;
    var map = pawn.map;
    var st = states.get(map);
    if (!st || !st.built) return null;

    var i = pawn.y * map.w + pawn.x;
    if (i < 0 || i >= map.size) return null;
    var cell = U.clamp(st.grid[i], CELL_FLOOR * 1.6, CELL_CEIL * 1.6);

    var R = sys('Regions');
    var room = R && R.roomAt ? R.roomAt(map, pawn.x, pawn.y) : null;
    var indoor = !!(room && !room.outdoor && room.id > 0);
    var local = cell;
    if (indoor) {
      if (!room._beautyHooked) Beauty.hookRoom(map, room);
      var mean = (room.beauty || 0) / SCALE;
      local = cell - mean;
    }

    var taste = Beauty.tasteOf(pawn);
    var mood = moodFromBeauty(local, indoor, taste, cell);
    pawn.beautyHere = Math.round(cell * 10) / 10;
    pawn.beautyTaste = Math.round(taste * 100) / 100;

    var N = sys('Needs');
    if (!N || !N.addThought) return { cell: cell, mood: mood, taste: taste };

    if (mood > 0.8 || mood < -0.8) {
      N.addThought(pawn, 'beautySurroundings',
        { degree: degreeFor(mood, taste), mood: mood, noStack: true });
    } else {
      clearThought(pawn, 'beautySurroundings');
    }

    admire(map, pawn, N, taste);
    return { cell: cell, mood: mood, taste: taste, indoor: indoor };
  };

  /* Walking past something good is worth something on its own, and it
     is the reason a colonist ever looks up. */
  function admire(map, pawn, N, taste) {
    if (taste <= 0) return;
    var st = states.get(map);
    if (!st || !st.artIds.length) return;
    var best = null, bestQ = -1;
    for (var k = 0; k < st.artIds.length; k++) {
      var t = map.things.get(st.artIds[k]);
      if (!t || !t.spawned) continue;
      if (U.cheb(t.x, t.y, pawn.x, pawn.y) > 4) continue;
      var q = t.quality | 0;
      if (q > bestQ) { bestQ = q; best = t; }
    }
    if (!best || bestQ < 3) return;
    var degree = bestQ >= 5 ? 2 : (bestQ >= 4 ? 1 : 0);
    var mood = (2 + degree * 2.4) * U.clamp(taste, 0, 2.2);
    N.addThought(pawn, 'admiredArtwork', { degree: degree, mood: mood, noStack: true });
    if (N.gainJoy) N.gainJoy(pawn, 0.004 * (1 + degree), 'art');
    pawn.lastAdmiredArtId = best.id;
  }

  /* ============================================================
     UGLINESS WORTH FIXING

     The list a UI alert panel wants: what is making the colony grim,
     where it is, and how bad it is. Cleaning and burying are already
     jobs; this is what tells a player they are worth doing.
     ============================================================ */

  Beauty.problems = function (map) {
    if (!map) return [];
    var out = [];
    var R = sys('Regions');
    var rooms = R && R.rooms ? R.rooms(map) : null;
    var terrains = Defs.all('terrain');
    var i, t;

    var corpses = map.byDef('corpse');
    var loose = [], worst = null, worstRot = -1;
    for (i = 0; i < corpses.length; i++) {
      t = corpses[i];
      if (!t || !t.spawned || !t.corpse) continue;
      /* A body in a grave has been dealt with; the building on its cell
         is what says so. */
      var b = map.buildingAt(t.x, t.y);
      if (b && b.def && b.def.building && b.def.building.isGrave) continue;
      loose.push(t);
      if ((t.rotProgress || 0) > worstRot) { worstRot = t.rotProgress || 0; worst = t; }
    }
    if (loose.length) {
      out.push({
        id: 'corpses', severity: loose.length >= 4 ? 2 : 1,
        label: loose.length + ' unburied ' + U.plural(loose.length, 'body', 'bodies'),
        detail: 'Every colonist who walks past one takes the mood hit. Bury or butcher them.',
        x: worst ? worst.x : null, y: worst ? worst.y : null, count: loose.length
      });
    }

    var bloody = 0, bloodX = null, bloodY = null, chunks = 0, chunkX = null, chunkY = null;
    var unroofed = 0, unroofedRoom = null, dirtFloor = 0;
    if (rooms) {
      rooms.forEach(function (room) {
        if (room.outdoor || room.id === 0) return;
        var cells = room.cells;
        for (var k = 0; k < cells.length; k++) {
          var c = cells[k];
          if (map.blood[c] > 24) { bloody++; if (bloodX === null) { bloodX = c % map.w; bloodY = (c - (c % map.w)) / map.w; } }
          var list = map.itemGrid[c];
          if (list) {
            for (var j = 0; j < list.length; j++) {
              if (list[j] && list[j].defId === 'stoneChunk') {
                chunks++;
                if (chunkX === null) { chunkX = c % map.w; chunkY = (c - (c % map.w)) / map.w; }
              }
            }
          }
        }
        if ((room.roofedFrac || 0) < 0.85 && room.size >= 4 && room.bedCount > 0) {
          unroofed++;
          if (!unroofedRoom) unroofedRoom = room;
        }
        /* Counting floors here rather than asking roomStats keeps this
           one loop over the indoor cells instead of five. */
        if (room.size >= 6) {
          var floored = 0;
          for (var f = 0; f < cells.length; f++) {
            var ftd = terrains[map.terrain[cells[f]]];
            if (ftd && ftd.buildCategory) floored++;
          }
          if (floored / cells.length < 0.3) dirtFloor++;
        }
      });
    }

    if (bloody >= 8) {
      out.push({
        id: 'filth', severity: bloody >= 30 ? 2 : 1,
        label: bloody + ' filthy tiles indoors',
        detail: 'Blood on the floor drags the beauty of the room it is in. Someone has to clean.',
        x: bloodX, y: bloodY, count: bloody
      });
    }
    if (chunks >= 6) {
      out.push({
        id: 'rubble', severity: 1,
        label: chunks + ' stone chunks lying indoors',
        detail: 'Rubble is ugly where people live. Haul it to a stockpile or cut it into blocks.',
        x: chunkX, y: chunkY, count: chunks
      });
    }
    if (unroofed) {
      out.push({
        id: 'unroofed', severity: 2,
        label: unroofed + ' bedroom' + (unroofed === 1 ? '' : 's') + ' open to the sky',
        detail: 'A room without a roof is weather, not a room.',
        x: unroofedRoom ? unroofedRoom.cells[0] % map.w : null,
        y: unroofedRoom ? Math.floor(unroofedRoom.cells[0] / map.w) : null,
        count: unroofed
      });
    }
    if (dirtFloor >= 2) {
      out.push({
        id: 'dirtFloor', severity: 0,
        label: dirtFloor + ' rooms with bare ground underfoot',
        detail: 'Any built floor is an improvement; carpet is the cheapest beauty in the game.',
        x: null, y: null, count: dirtFloor
      });
    }

    out.sort(function (a, b) { return b.severity - a.severity; });
    return out;
  };

  /* ============================================================
     THE TICK

     game.js resolves ['Beauty','tick'] into its slow list and calls it
     with Game every 500 ticks. The map-first signature the brief names
     is accepted too, so a test can drive one map directly.
     ============================================================ */

  Beauty.tick = function (a, b) {
    var game, map;
    if (a && a.w !== undefined && a.size !== undefined) { map = a; game = b || sys('Game'); }
    else { game = a || sys('Game'); map = game && game.map; }
    if (!map || !map.size) return null;

    var now = game ? (game.tick | 0) : tickNow();
    /* A new colony, or a save loaded over this one, rewinds the clock.
       The chronicle is rebuilt from whatever letters that game carries
       rather than being carried over from the last one. */
    if (now < lastTick) {
      chronicle.length = 0;
      seenLetters = Object.create(null);
      artCount = 0;
    }
    var elapsed = U.clamp(now - lastTick, 0, 6000);
    lastTick = now;

    harvest(game);
    Beauty.refresh(map, true);
    Beauty.hookRooms(map);

    /* Any artwork the build pass found that has never been given a name
       gets one now. A piece the colony built in the last day is credited
       to whoever most plausibly carved it; one that arrived some other
       way - traded in, looted off a raider, already standing when you
       landed - gets a title and a subject but no author, because
       inventing a signature for a thing nobody here made is a lie the
       inspect panel would repeat for ever. */
    var st = stateOf(map);
    for (var k = 0; k < st.artIds.length; k++) {
      var t = map.things.get(st.artIds[k]);
      if (!t || !t.spawned || t.artTitle) continue;
      var homemade = t.faction === 'player' && now - (t.spawnTick || 0) <= 60000;
      Beauty.nameArt(t, homemade ? creditArtist(map, t) : null, map);
    }

    var pawns = map.pawns;
    for (var i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      if (!p || p.dead || !p.isHuman || p.faction !== 'player') continue;
      if (p._beautyTick === now) continue;
      p._beautyTick = now;
      tickInspiration(p, elapsed || 500);
      Beauty.observe(p);
    }

    return st;
  };

  /* Exposed for a host that wires per-pawn tickers; guarded so running
     both costs nothing extra. */
  Beauty.tickPawn = function (pawn) {
    if (!pawn || pawn.dead || !pawn.isHuman || !pawn.map) return;
    var now = tickNow();
    if (pawn._beautyTick === now) return;
    /* Stagger by id so a hundred colonists never all recompute on the
       same tick. */
    if ((now + (pawn.id | 0)) % 250 !== 0) return;
    pawn._beautyTick = now;
    var st = states.get(pawn.map);
    if (!st || !st.built) return;
    Beauty.observe(pawn);
  };

  /* ============================================================
     SAVE

     Per-thing and per-pawn state is plain scalars, so save.js already
     carries the sculptures and the inspirations. What is left is the
     chronicle, which belongs to no object.
     ============================================================ */

  Beauty.save = function () {
    return {
      v: 1,
      artCount: artCount,
      lastTick: lastTick,
      chronicle: chronicle.map(function (e) {
        return { k: e.kind, t: e.title, w: e.who, d: e.day, x: e.tick };
      })
    };
  };

  Beauty.load = function (obj) {
    chronicle.length = 0;
    seenLetters = Object.create(null);
    artCount = 0;
    lastTick = 0;
    if (!obj || typeof obj !== 'object') return false;
    artCount = obj.artCount | 0;
    lastTick = obj.lastTick | 0;
    var list = obj.chronicle || [];
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e) continue;
      chronicle.push({
        kind: e.k || 'event', title: e.t || '', who: e.w || null,
        day: e.d | 0, tick: e.x | 0
      });
    }
    if (chronicle.length > CHRONICLE_LIMIT) chronicle.splice(0, chronicle.length - CHRONICLE_LIMIT);
    return true;
  };

  /* ============================================================
     DIAGNOSTICS
     ============================================================ */

  Beauty.stats = function (map) {
    if (!map) return null;
    var st = stateOf(map);
    if (!st.built) Beauty.refresh(map, true);
    var grid = st.grid, lo = Infinity, hi = -Infinity, sum = 0;
    for (var i = 0; i < grid.length; i++) {
      var v = grid[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      sum += v;
    }
    var rooms = 0, hooked = 0;
    var R = sys('Regions');
    if (R && R.rooms) {
      R.rooms(map).forEach(function (room) { rooms++; if (room._beautyHooked) hooked++; });
    }
    return {
      built: st.built, serial: st.serial, builtTick: st.builtTick,
      sources: st.sources, artworks: st.artIds.length,
      min: Math.round(lo * 100) / 100, max: Math.round(hi * 100) / 100,
      mean: Math.round((sum / grid.length) * 1000) / 1000,
      rooms: rooms, hookedRooms: hooked,
      chronicle: chronicle.length
    };
  };

  root.Beauty = Beauty;
})(this);
