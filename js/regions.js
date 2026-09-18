/* ============================================================
   regions.js - two labelings of the same grid, and what they mean.

   AREAS answer "can this pawn get there at all". They are the connected
   components of every cell a pawn may stand on, with doors counted as
   open, so `Path.reachable` is an integer compare instead of an A* that
   explores half a mountain before admitting defeat. The area graph uses
   exactly the moves the pathfinder uses - four orthogonals plus the
   diagonals whose corner is not blocked - because an area that claims a
   connection the pathfinder refuses would silently strand a colonist.

   ROOMS answer "what is it like in here". They are the connected
   components of every cell NOT filled by a wall or a door: doors are the
   boundary, which is what makes a room a room. Everything open to the
   sky and joined to the map edge is one single outdoors, room 0, and it
   is never treated as a real room - the weather is not a decorating
   failure and nobody is cold indoors because it is snowing outside.

   Both are rebuilt from scratch, never patched, and only when something
   that actually changes them has changed. map.js marks a cell dirty on
   every path-cost change, which includes a berry falling on the floor,
   so the first thing an update does is ask whether any of those dirty
   cells crossed a passability or wall boundary. Almost always none did,
   and the whole tick costs a flag read. When one did, the rebuild is two
   flood fills over preallocated Int32Array stacks - no recursion, no
   object per cell - which is a couple of milliseconds for a 160x160 map
   and happens when a wall goes up, not when a pawn drops a plank.

   Room STATS (beauty, cleanliness, roof, role, temperature) are the
   expensive half and run on the rare tick, off the back of
   tickTemperature, plus once immediately after any rebuild so a brand
   new room is never blank.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  var IMPASSABLE = 65535;

  /* Cell kinds for the room pass. A workbench is impassable but it is
     not a wall: you can stand beside it and the air flows over it. Only
     something that fills its tile completely divides one room from the
     next. */
  var OPEN = 0, WALL = 1, DOOR = 2;

  var RARE_TICKS = 250;          /* how often game.js calls tickTemperature */
  var TICKS_PER_HOUR = 2500;     /* 60000 ticks a day, 24 hours          */
  var DEFAULT_TEMP = 21;
  var MOUNTAIN_TEMP = 12;        /* bedrock a long way from the surface  */
  var NOMINAL_ROOM = 35;         /* the room size heater rates are quoted for */
  var BASE_LEAK = 0.05;          /* a sealed, roofed room, per rare tick */
  var BEAUTY_SCALE = 3;          /* mean cell beauty -> the numbers needs.js reads */
  var ROOFED_ROOM = 0.7;         /* above this a room counts as roofed   */
  var OUTDOOR_ROOF_LIMIT = 0.5;  /* an edge-touching space this open is outdoors */
  var DIRTY_LIMIT = 256;         /* dirty cells tracked before we give up and rebuild */

  /* One state block per map, off to the side rather than on the map, so
     save.js serialises a map without dragging four scratch grids along. */
  var states = new WeakMap();

  function stateOf(map) {
    var st = states.get(map);
    if (st && st.size === map.size) return st;
    st = {
      size: map.size,
      stack: new Int32Array(map.size),     /* flood fill frontier, reused forever */
      kind: new Uint8Array(map.size),      /* OPEN/WALL/DOOR as of the last rebuild */
      doorSeen: new Int32Array(map.size),  /* dedupes a door shared by two room edges */
      prevRoomId: new Int32Array(map.size),/* last labeling, so temperatures survive */
      dirtyCells: new Int32Array(DIRTY_LIMIT),
      dirtyCount: 0,
      dirtyAll: true,                      /* nothing is labelled yet */
      dirty: true,
      statsDirty: true,
      built: false,
      rooms: new Map(),
      areaCount: 0,
      outdoorTemp: DEFAULT_TEMP,
      rebuilds: 0,
      statsPasses: 0,
      skipped: 0
    };
    states.set(map, st);
    return st;
  }

  /* ============================================================
     DIRT
     ============================================================ */

  var Regions = {};

  Regions.markDirty = function (map, x, y) {
    if (!map || x < 0 || y < 0 || x >= map.w || y >= map.h) return;
    Regions.markDirtyIdx(map, y * map.w + x);
  };

  /* O(1) and allocation free: this runs thousands of times during map
     generation and once for every item that touches the floor. */
  Regions.markDirtyIdx = function (map, i) {
    if (!map || i < 0 || i >= map.size) return;
    var st = stateOf(map);
    st.dirty = true;
    st.statsDirty = true;
    if (st.dirtyAll) return;
    if (st.dirtyCount >= DIRTY_LIMIT) { st.dirtyAll = true; return; }
    st.dirtyCells[st.dirtyCount++] = i;
  };

  Regions.markAllDirty = function (map) {
    var st = stateOf(map);
    st.dirty = true; st.statsDirty = true; st.dirtyAll = true;
  };

  /* Does this cell still agree with the labeling we built from it?
     Passability is checked against the area grid itself, which saves
     carrying a snapshot of it: a labelled cell that is now solid, or a
     solid cell that is now labelled, is a change. Walls and doors are
     checked against st.kind, which the rebuild keeps current. */
  function structuralChange(map, st, i) {
    var pc = map.pathCost, imp = map.IMPASSABLE || IMPASSABLE;
    var labelled = map.areaId[i] !== 0;
    if (labelled !== (pc[i] < imp)) return true;
    return kindAt(map, i) !== st.kind[i];
  }

  function kindAt(map, i) {
    var bid = map.buildingId[i];
    if (!bid) return OPEN;
    var t = map.things.get(bid);
    if (!t || !t.def) return OPEN;
    var d = t.def;
    if (d.building && d.building.isDoor) return DOOR;
    /* fillPercent is the honest test for "a wall": walls and natural
       rock fill their tile, a turret or a smithy does not. */
    if (d.passable === false && (d.fillPercent === undefined || d.fillPercent >= 1)) return WALL;
    return OPEN;
  }

  /* ============================================================
     UPDATE
     ============================================================ */

  Regions.update = function (map) {
    if (!map) return;
    var st = states.get(map);
    if (!st || st.size !== map.size) st = stateOf(map);
    if (!st.dirty) return;

    if (!st.built || st.dirtyAll) { rebuild(map, st); return; }

    var changed = false;
    for (var k = 0; k < st.dirtyCount; k++) {
      if (structuralChange(map, st, st.dirtyCells[k])) { changed = true; break; }
    }
    st.dirtyCount = 0;
    st.dirty = false;
    if (changed) rebuild(map, st);
    else st.skipped++;   /* a dropped plank: stats will notice, the graph will not */
  };

  Regions.rebuildAll = function (map) {
    if (!map) return;
    rebuild(map, stateOf(map));
  };

  function rebuild(map, st) {
    st.outdoorTemp = outdoorTempGuess();
    labelAreas(map, st);
    labelRooms(map, st);
    computeStats(map, st);
    st.dirtyCount = 0;
    st.dirtyAll = false;
    st.dirty = false;
    st.built = true;
    st.rebuilds++;
  }

  /* ============================================================
     AREAS
     ============================================================ */

  function labelAreas(map, st) {
    var w = map.w, h = map.h, size = map.size;
    var pc = map.pathCost, imp = map.IMPASSABLE || IMPASSABLE;
    var area = map.areaId, stack = st.stack;
    var next = 1, s, i, n, x, y, top;

    area.fill(0);

    for (s = 0; s < size; s++) {
      if (area[s] !== 0 || pc[s] >= imp) continue;
      var id = next++;
      area[s] = id;
      top = 0;
      stack[top++] = s;

      while (top > 0) {
        i = stack[--top];
        x = i % w; y = (i - x) / w;
        var up = y > 0, down = y < h - 1, left = x > 0, right = x < w - 1;
        var openUp = false, openDown = false, openLeft = false, openRight = false;

        if (up)    { n = i - w; openUp    = pc[n] < imp; if (openUp    && area[n] === 0) { area[n] = id; stack[top++] = n; } }
        if (down)  { n = i + w; openDown  = pc[n] < imp; if (openDown  && area[n] === 0) { area[n] = id; stack[top++] = n; } }
        if (left)  { n = i - 1; openLeft  = pc[n] < imp; if (openLeft  && area[n] === 0) { area[n] = id; stack[top++] = n; } }
        if (right) { n = i + 1; openRight = pc[n] < imp; if (openRight && area[n] === 0) { area[n] = id; stack[top++] = n; } }

        /* A diagonal only counts when both tiles it squeezes past are
           open, which is the pathfinder's corner rule. Claiming the
           corner would mean promising a route A* will not walk. */
        if (up && left && openUp && openLeft) {
          n = i - w - 1; if (pc[n] < imp && area[n] === 0) { area[n] = id; stack[top++] = n; }
        }
        if (up && right && openUp && openRight) {
          n = i - w + 1; if (pc[n] < imp && area[n] === 0) { area[n] = id; stack[top++] = n; }
        }
        if (down && left && openDown && openLeft) {
          n = i + w - 1; if (pc[n] < imp && area[n] === 0) { area[n] = id; stack[top++] = n; }
        }
        if (down && right && openDown && openRight) {
          n = i + w + 1; if (pc[n] < imp && area[n] === 0) { area[n] = id; stack[top++] = n; }
        }
      }
    }

    st.areaCount = next - 1;
  }

  /* ============================================================
     ROOMS
     ============================================================ */

  function makeRoom(id) {
    return {
      id: id,
      cells: [],
      size: 0,
      outdoor: id === 0,
      temperature: DEFAULT_TEMP,
      beauty: 0,
      cleanliness: 0,
      roofed: false,
      roofedFrac: 0,
      rockFrac: 0,
      doorIds: [],
      role: 'none',
      wealth: 0,
      touchesEdge: id === 0,
      bedCount: 0,
      tableCount: 0,
      chairCount: 0,
      benchCount: 0,
      pusherIds: []
    };
  }

  /* Rooms are cardinal-only: a diagonal gap between two wall corners is
     not a doorway, and nobody can walk through it either. */
  function labelRooms(map, st) {
    var w = map.w, h = map.h, size = map.size;
    var roomId = map.roomId, kind = st.kind, stack = st.stack;
    var doorSeen = st.doorSeen;
    var prev = st.built ? st.rooms : null;
    var rooms = new Map();
    var i, n, x, y, top;

    if (prev) st.prevRoomId.set(roomId);
    for (i = 0; i < size; i++) kind[i] = kindAt(map, i);

    /* -1 means "open cell, not yet visited"; 0 is both a wall and the
       outdoors, which never need telling apart after this pass. */
    for (i = 0; i < size; i++) roomId[i] = kind[i] === OPEN ? -1 : 0;
    doorSeen.fill(0);

    var outdoors = makeRoom(0);
    rooms.set(0, outdoors);

    /* The outdoors is whatever you can reach from a piece of open sky on
       the map edge. Seeding from unroofed edge cells only is what lets a
       mountain base dug out to the edge stay a room rather than becoming
       the weather. */
    top = 0;
    for (x = 0; x < w; x++) {
      top = seedOutdoor(map, roomId, stack, top, x);
      top = seedOutdoor(map, roomId, stack, top, (h - 1) * w + x);
    }
    for (y = 0; y < h; y++) {
      top = seedOutdoor(map, roomId, stack, top, y * w);
      top = seedOutdoor(map, roomId, stack, top, y * w + w - 1);
    }
    var outCells = outdoors.cells;
    while (top > 0) {
      i = stack[--top];
      outCells.push(i);
      x = i % w; y = (i - x) / w;
      if (y > 0)     { n = i - w; if (roomId[n] === -1) { roomId[n] = 0; stack[top++] = n; } }
      if (y < h - 1) { n = i + w; if (roomId[n] === -1) { roomId[n] = 0; stack[top++] = n; } }
      if (x > 0)     { n = i - 1; if (roomId[n] === -1) { roomId[n] = 0; stack[top++] = n; } }
      if (x < w - 1) { n = i + 1; if (roomId[n] === -1) { roomId[n] = 0; stack[top++] = n; } }
    }
    outdoors.size = outCells.length;
    collectDoors(map, st, outdoors);

    /* Everything still unvisited is enclosed by something. */
    var next = 1;
    for (var s = 0; s < size; s++) {
      if (roomId[s] !== -1) continue;
      var room = makeRoom(next);
      var cells = room.cells;
      roomId[s] = next;
      top = 0;
      stack[top++] = s;

      while (top > 0) {
        i = stack[--top];
        cells.push(i);
        x = i % w; y = (i - x) / w;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) room.touchesEdge = true;
        if (y > 0)     { n = i - w; if (roomId[n] === -1) { roomId[n] = next; stack[top++] = n; } }
        if (y < h - 1) { n = i + w; if (roomId[n] === -1) { roomId[n] = next; stack[top++] = n; } }
        if (x > 0)     { n = i - 1; if (roomId[n] === -1) { roomId[n] = next; stack[top++] = n; } }
        if (x < w - 1) { n = i + 1; if (roomId[n] === -1) { roomId[n] = next; stack[top++] = n; } }
      }

      room.size = cells.length;
      collectDoors(map, st, room);
      room.temperature = inheritTemperature(st, prev, cells);
      rooms.set(next, room);
      next++;
    }

    outdoors.temperature = st.outdoorTemp;
    st.rooms = rooms;
    st.statsDirty = true;
  }

  function seedOutdoor(map, roomId, stack, top, i) {
    if (roomId[i] !== -1 || map.roof[i] !== 0) return top;
    roomId[i] = 0;
    stack[top++] = i;
    return top;
  }

  /* A door is a boundary cell, so it belongs to no room; it is listed by
     every room it opens onto, which is how the temperature model knows a
     freezer with three doors leaks more than one with a single door. */
  function collectDoors(map, st, room) {
    var w = map.w, h = map.h, kind = st.kind, seen = st.doorSeen;
    var cells = room.cells, out = room.doorIds;
    var mark = room.id + 1;   /* 0 stays "never seen" after the fill */
    for (var k = 0; k < cells.length; k++) {
      var i = cells[k], x = i % w, y = (i - x) / w, n;
      if (y > 0)     { n = i - w; if (kind[n] === DOOR && seen[n] !== mark) { seen[n] = mark; pushDoor(map, out, n); } }
      if (y < h - 1) { n = i + w; if (kind[n] === DOOR && seen[n] !== mark) { seen[n] = mark; pushDoor(map, out, n); } }
      if (x > 0)     { n = i - 1; if (kind[n] === DOOR && seen[n] !== mark) { seen[n] = mark; pushDoor(map, out, n); } }
      if (x < w - 1) { n = i + 1; if (kind[n] === DOOR && seen[n] !== mark) { seen[n] = mark; pushDoor(map, out, n); } }
    }
  }

  function pushDoor(map, out, i) {
    var id = map.buildingId[i];
    if (id && out.indexOf(id) < 0) out.push(id);
  }

  /* Walling a room in half must not reset both halves to room
     temperature: the new rooms take the mean of whatever used to be
     under their cells. */
  function inheritTemperature(st, prev, cells) {
    if (!prev || !prev.size) return st.outdoorTemp;
    var old = st.prevRoomId, sum = 0, n = 0;
    var lastId = -1, lastTemp = 0;
    for (var k = 0; k < cells.length; k++) {
      var id = old[cells[k]];
      if (id <= 0) continue;
      if (id !== lastId) {
        var r = prev.get(id);
        if (!r) continue;
        lastId = id; lastTemp = r.temperature;
      }
      sum += lastTemp; n++;
    }
    if (!n) return st.outdoorTemp;
    return sum / n;
  }

  /* ============================================================
     ROOM STATS
     ============================================================ */

  function computeStats(map, st) {
    var terrains = Defs.all('terrain');
    st.rooms.forEach(function (room) { statsFor(map, st, room, terrains); });
    st.statsDirty = false;
    st.statsPasses++;
  }

  function statsFor(map, st, room, terrains) {
    var cells = room.cells, n = cells.length, w = map.w;
    var beauty = 0, clean = 0, blood = 0, wealth = 0;
    var roofed = 0, rock = 0;
    var beds = 0, tables = 0, chairs = 0, benches = 0;
    var pushers = room.pusherIds;
    var i, k, j, t, d, list;

    pushers.length = 0;

    for (k = 0; k < n; k++) {
      i = cells[k];
      var cx = i % w, cy = (i - cx) / w;

      var td = terrains[map.terrain[i]];
      if (td) { beauty += td.beauty || 0; clean += td.cleanliness || 0; }

      var r = map.roof[i];
      if (r !== 0) { roofed++; if (r === 2) rock++; }

      var b = map.blood[i];
      if (b) { blood += b / 255; beauty -= 2 * (b / 255); }

      var bid = map.buildingId[i];
      if (bid) {
        t = map.things.get(bid);
        if (t && t.def) {
          d = t.def;
          beauty += d.beauty || 0;
          /* Count the object once, at its own corner, however many tiles
             it covers - a two-tile table is one table. */
          if (t.x === cx && t.y === cy) {
            wealth += d.marketValue || 0;
            var bd = d.building;
            if (bd) {
              if (bd.isBed) beds++;
              if (bd.isTable) tables++;
              if (bd.isChair) chairs++;
              if (bd.isWorkbench) benches++;
              if (bd.tempPushRate) pushers.push(t.id);
            }
          }
        }
      }

      var pid = map.plantId[i];
      if (pid) {
        t = map.things.get(pid);
        if (t && t.def) beauty += t.def.beauty || 0;
      }

      list = map.itemGrid[i];
      if (list) {
        for (j = 0; j < list.length; j++) {
          t = list[j];
          if (!t || !t.def) continue;
          beauty += t.def.beauty || 0;
          wealth += (t.def.marketValue || 0) * (t.stack || 1);
        }
      }
    }

    room.size = n;
    room.roofedFrac = n ? roofed / n : 0;
    room.rockFrac = n ? rock / n : 0;
    room.roofed = room.roofedFrac > ROOFED_ROOM;
    room.outdoor = room.id === 0 ||
      (room.touchesEdge && room.roofedFrac < OUTDOOR_ROOF_LIMIT);
    room.beauty = n ? U.clamp((beauty / n) * BEAUTY_SCALE, -40, 40) : 0;
    room.cleanliness = n ? (clean / n) - 1.5 * (blood / n) : 0;
    room.wealth = wealth;
    room.bedCount = beds;
    room.tableCount = tables;
    room.chairCount = chairs;
    room.benchCount = benches;
    room.role = roleOf(room);
  }

  /* What the room is for, in the order a colonist would say it. A bed
     wins over a table, because the sculpture gallery someone sleeps in
     is still their bedroom, and needs.js asks about sleeping first. */
  function roleOf(room) {
    if (room.outdoor) return 'none';
    if (room.bedCount === 1 && room.size < 40) return 'bedroom';
    if (room.bedCount >= 1) return 'barracks';
    if (room.tableCount >= 1 && room.chairCount >= 1) return 'dining';
    if (room.benchCount >= 1) return 'workshop';
    return 'none';
  }

  /* ============================================================
     QUERIES
     ============================================================ */

  Regions.rooms = function (map) {
    if (!map) return new Map();
    var st = stateOf(map);
    Regions.update(map);
    return st.rooms;
  };

  Regions.roomAt = function (map, x, y) {
    if (!map || !map.inBounds(x, y)) return null;
    var st = stateOf(map);
    Regions.update(map);
    var i = y * map.w + x;
    var id = map.roomId[i];
    if (id > 0) return st.rooms.get(id) || null;

    /* A wall or a door has no room of its own. A pawn standing in a
       doorway is really in one of the rooms it joins, and the warmer
       answer - an actual room over the outdoors - is the useful one. */
    if (st.kind[i] !== OPEN) {
      var best = null, w = map.w, h = map.h, n;
      if (y > 0)     { n = map.roomId[i - w]; if (n > 0) best = st.rooms.get(n) || best; }
      if (y < h - 1) { n = map.roomId[i + w]; if (n > 0 && !best) best = st.rooms.get(n) || best; }
      if (x > 0)     { n = map.roomId[i - 1]; if (n > 0 && !best) best = st.rooms.get(n) || best; }
      if (x < w - 1) { n = map.roomId[i + 1]; if (n > 0 && !best) best = st.rooms.get(n) || best; }
      if (best) return best;
    }
    return st.rooms.get(0) || null;
  };

  Regions.roomIdAt = function (map, x, y) {
    if (!map || !map.inBounds(x, y)) return 0;
    Regions.update(map);
    return map.roomId[y * map.w + x];
  };

  Regions.areaOf = function (map, x, y) {
    if (!map || !map.inBounds(x, y)) return 0;
    Regions.update(map);
    return map.areaId[y * map.w + x];
  };

  Regions.sameArea = function (map, x1, y1, x2, y2) {
    if (!map || !map.inBounds(x1, y1) || !map.inBounds(x2, y2)) return false;
    Regions.update(map);
    var a = map.areaId[y1 * map.w + x1];
    return a !== 0 && a === map.areaId[y2 * map.w + x2];
  };

  /* True when every one of these cells sits in a real, enclosed room -
     the question construct.js asks before it decides a new wall has
     closed a space in and the roof can go on. */
  Regions.enclosedBy = function (map, cells) {
    if (!map || !cells || !cells.length) return false;
    var st = stateOf(map);
    Regions.update(map);
    var roomId = map.roomId;
    for (var k = 0; k < cells.length; k++) {
      var c = cells[k];
      var i = typeof c === 'number' ? c : (c.y * map.w + c.x);
      if (i < 0 || i >= map.size) return false;
      var id = roomId[i];
      if (id <= 0) return false;
      var room = st.rooms.get(id);
      if (!room || room.outdoor) return false;
    }
    return true;
  };

  Regions.enclosed = function (map, x, y) {
    var room = Regions.roomAt(map, x, y);
    return !!room && room.id > 0 && !room.outdoor;
  };

  /* ============================================================
     TEMPERATURE
     ============================================================ */

  function outdoorTempGuess() {
    var G = root.Game;
    if (G && G.weather && typeof G.outdoorTemp === 'function') {
      var v = G.outdoorTemp();
      if (typeof v === 'number' && isFinite(v)) return v;
    }
    return DEFAULT_TEMP;
  }

  /* How fast the room gives up and matches the world outside, per rare
     tick. Holes in the roof dominate; doors are a small constant leak;
     and a big room has the thermal mass to hold its temperature for
     longer, which is why a walk-in freezer works and a cupboard does
     not. */
  function leakOf(room) {
    var open = 1 - room.roofedFrac;
    var mass = Math.sqrt(NOMINAL_ROOM / Math.max(4, room.size));
    var leak = (BASE_LEAK + open * 0.60 + room.doorIds.length * 0.006) * mass;
    return U.clamp(leak, 0.01, 0.9);
  }

  function pusherActive(t) {
    if (!t || !t.def || !t.def.building) return false;
    var b = t.def.building;
    if (!b.tempPushRate) return false;
    if (t.hp !== undefined && t.hp !== null && t.hp <= 0) return false;
    if (b.powerConsumed > 0) {
      var P = root.Power;
      if (P && P.isPowered) return !!P.isPowered(t);
      return t.powered !== false;
    }
    if (b.fuelCapacity > 0) return (t.fuel || 0) > 0;   /* a cold campfire heats nothing */
    return true;
  }

  function targetOf(t) {
    if (typeof t.tempTarget === 'number') return t.tempTarget;
    var v = t.def.building.tempPushTarget;
    return typeof v === 'number' ? v : null;
  }

  /* Degrees per hour into a room of nominal size, which is the unit the
     thing defs quote tempPushRate in. Power owns this question; we only
     answer it ourselves when power.js is absent, or when it has nothing
     to say about a room that plainly has a lit campfire in it. */
  function pushPerHour(map, room) {
    var P = root.Power;
    if (P && P.tempPushAt) {
      var v = P.tempPushAt(map, room.id);
      if (typeof v === 'number' && isFinite(v) && v !== 0) return v;
    }
    var sum = 0;
    for (var k = 0; k < room.pusherIds.length; k++) {
      var t = map.things.get(room.pusherIds[k]);
      if (pusherActive(t)) sum += t.def.building.tempPushRate;
    }
    return sum;
  }

  /* The thermostat. A heater that has reached its target idles instead
     of cooking the colony, and never overshoots in a single step. */
  function applyThermostat(map, room, drifted, push) {
    if (!push) return drifted;
    var hi = null, lo = null;
    for (var k = 0; k < room.pusherIds.length; k++) {
      var t = map.things.get(room.pusherIds[k]);
      if (!pusherActive(t)) continue;
      var target = targetOf(t);
      if (target === null) continue;
      if (t.def.building.tempPushRate > 0) { if (hi === null || target > hi) hi = target; }
      else if (lo === null || target < lo) lo = target;
    }
    var next = drifted + push;
    if (push > 0 && hi !== null) {
      if (drifted >= hi) return drifted;
      if (next > hi) return hi;
    }
    if (push < 0 && lo !== null) {
      if (drifted <= lo) return drifted;
      if (next < lo) return lo;
    }
    return next;
  }

  Regions.tickTemperature = function (map, outdoorTemp) {
    if (!map) return;
    var st = stateOf(map);
    Regions.update(map);
    if (st.statsDirty) computeStats(map, st);

    if (typeof outdoorTemp !== 'number' || !isFinite(outdoorTemp)) outdoorTemp = outdoorTempGuess();
    st.outdoorTemp = outdoorTemp;

    st.rooms.forEach(function (room) {
      if (room.outdoor) { room.temperature = outdoorTemp; return; }

      /* Rock overhead is the mountain's own thermostat: a room dug deep
         enough sits at bedrock temperature whatever the season does. */
      var ambient = outdoorTemp + (MOUNTAIN_TEMP - outdoorTemp) * room.rockFrac;
      var drifted = room.temperature + (ambient - room.temperature) * leakOf(room);

      var perHour = pushPerHour(map, room);
      var push = perHour
        ? perHour * (RARE_TICKS / TICKS_PER_HOUR) * (NOMINAL_ROOM / Math.max(4, room.size))
        : 0;

      room.temperature = U.clamp(applyThermostat(map, room, drifted, push), -120, 300);
    });
  };

  Regions.temperatureAt = function (map, x, y) {
    var room = Regions.roomAt(map, x, y);
    return room ? room.temperature : DEFAULT_TEMP;
  };

  /* ============================================================
     DIAGNOSTICS
     ============================================================ */

  Regions.stats = function (map) {
    if (!map) return null;
    var st = stateOf(map);
    Regions.update(map);
    var indoor = 0, roomCells = 0, doors = 0, outdoorCells = 0, walls = 0;
    st.rooms.forEach(function (room) {
      if (room.id === 0) { outdoorCells = room.size; return; }
      if (!room.outdoor) indoor++;
      roomCells += room.size;
      doors += room.doorIds.length;
    });
    for (var i = 0; i < map.size; i++) if (st.kind[i] !== OPEN) walls++;
    return {
      areas: st.areaCount,
      rooms: st.rooms.size,
      indoorRooms: indoor,
      roomCells: roomCells,
      outdoorCells: outdoorCells,
      doorEdges: doors,
      blockedCells: walls,
      rebuilds: st.rebuilds,
      statsPasses: st.statsPasses,
      skippedUpdates: st.skipped,
      dirty: st.dirty,
      outdoorTemp: st.outdoorTemp
    };
  };

  /* Drops every label and forgets the map, for a save load or a test
     that wants a clean slate. */
  Regions.reset = function (map) {
    if (!map) return;
    states.delete(map);
    map.areaId.fill(0);
    map.roomId.fill(0);
  };

  root.Regions = Regions;
})(this);
