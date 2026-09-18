/* ============================================================
   map.js - the world as grids, plus the registry of everything
   standing on them.

   Three ideas carry the whole file:

   1. Grids are typed arrays indexed by i = y * w + x. Anything the
      simulation asks thousands of times a tick - is this cell walkable,
      what does it cost, what is standing here - is one array read, not
      a search. The cost grid is the important one: map.pathCost holds
      the EXTRA move cost of a cell (terrain + building + plant + the
      junk lying on it) and 65535 means impassable. A* reads it and
      nothing else.

   2. Things live in exactly one registry, map.things, and every index
      beside it - byDef, the cell grids, the tick list - is maintained by
      spawnThing/despawnThing/moveThing. No other file may write a grid
      cell or push to an index; if they did, the first raid would be
      fighting ghosts. That is also why `new Thing` is private to this
      file.

   3. Derived state is invalidated, never recomputed on the spot.
      markPathDirty recomputes one cell and only tells Regions and
      Power when the number actually changed, because a colonist
      dropping a stack of steel on a stockpile must not cost a rebuild
      of every power net on the map.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* 65535 is the top of the Uint16 the cost grid is made of, so it
     doubles as "no path through here" - nothing else can reach it. */
  var IMPASSABLE = 65535;
  var MAX_COST = 65534;

  var TICKS_PER_DAY = 60000;

  /* A door is passable but never free: even open, a pawn slows through
     the frame, and Path adds its own penalty on top when it is shut. */
  var DOOR_COST = 8;

  /* Rot, blood and the pawn-index repair all run as rolling slices over
     their list: every entry is visited once per period, a handful of
     entries per tick, so nothing ever spikes. */
  var ROT_PERIOD = 250;
  var BLOOD_PERIOD = 600;
  var PAWN_REINDEX_PERIOD = 512;

  /* How far addItem will walk looking for somewhere to put the rest of
     a stack before it gives up and piles everything on the origin. */
  var SPILL_RADIUS = 8;

  /* Room temperature when nobody has computed one yet - a fresh map,
     or a build without regions.js loaded. */
  var DEFAULT_TEMP = 20;

  /* Handed out for "no items here" / "no pawns here". Frozen because a
     caller that pushes into it has a bug, and a bug that throws on the
     spot is worth ten that quietly write to a shared array. */
  var EMPTY = Object.freeze([]);

  var QUALITY = ['awful', 'poor', 'normal', 'good', 'excellent', 'masterwork', 'legendary'];

  /* Fire and blood filth are item defs that live on the item grid (see
     def_things.js: putting them on the building grid would delete the
     wall they are burning). They are not cargo, so they must not make a
     cell look occupied to a hauler. */
  function isHaulable(def) {
    return def.category === 'item' && def.id !== 'fire' && def.id !== 'filthBlood';
  }

  /* Adjectives for stuffed buildings: "wooden wall", "stone wall". */
  var STUFF_ADJECTIVE = {
    wood: 'wooden', steel: 'steel', stoneBlocks: 'stone',
    cloth: 'cloth', leather: 'leather'
  };

  /* Defs never change after load, so these lookups are cached once. */
  var _terrainList = null;
  var _rottableIds = null;

  function terrainList() {
    if (!_terrainList) _terrainList = Defs.all('terrain');
    return _terrainList;
  }

  function rottableIds() {
    if (!_rottableIds) {
      _rottableIds = [];
      var all = Defs.all('thing');
      for (var i = 0; i < all.length; i++) {
        if (all[i].rotDays > 0) _rottableIds.push(all[i].id);
      }
    }
    return _rottableIds;
  }

  function buildDefOf(defId) {
    if (!defId) return null;
    return Defs.maybe('thing', defId) || Defs.maybe('terrain', defId);
  }

  /* East/west rotations swap a footprint; the origin stays top-left.
     construct.js does the same arithmetic, and they have to agree or a
     rotated bed would occupy cells nobody else believes in. */
  function footprintOf(def, rot) {
    var s = (def && def.size) || null;
    var w = s ? s.w : 1, h = s ? s.h : 1;
    return (rot === 1 || rot === 3) ? { w: h, h: w } : { w: w, h: h };
  }

  /* Quarter-turn clockwise, so a workbench keeps its interaction spot
     in front of it whichever way it faces. */
  function rotateOffset(off, rot) {
    var dx = off.dx || 0, dy = off.dy || 0;
    if (rot === 1) return { dx: -dy, dy: dx };
    if (rot === 2) return { dx: -dx, dy: -dy };
    if (rot === 3) return { dx: dy, dy: -dx };
    return { dx: dx, dy: dy };
  }

  /* ============================================================
     Thing - everything on the map that is not a pawn.

     One shape for items, buildings, plants, corpses and build ghosts.
     Every field exists on every thing, even when it is null: save.js
     round-trips a fixed shape, and a hidden class that never changes is
     also the difference between ten thousand grass plants being cheap
     and being a garbage-collector problem.
     ============================================================ */
  function Thing(defId, x, y) {
    var def = Defs.thing(defId);

    this.id = U.nextId();
    this.defId = defId;
    this.def = def;                 /* not saved; save.js rebinds from defId */
    this.x = x | 0;
    this.y = y | 0;
    this.spawned = false;
    this.map = null;

    this.stack = 1;
    this.hp = def.hp || 1;
    this.maxHp = def.hp || 1;
    this.rot = 0;
    this.faction = null;
    this.quality = null;
    this.stuff = null;

    /* buildings */
    this.powered = false;
    this.netId = 0;
    this.fuel = null;
    this.bills = null;
    this.open = false;

    /* blueprint / frame */
    this.isBlueprint = false;
    this.isFrame = false;
    this.buildDefId = null;
    this.workDone = 0;
    this.materials = null;

    /* plants */
    this.growth = 0;
    this.sown = false;
    this.blighted = false;
    this.plantAgeTicks = 0;

    /* items */
    this.rotProgress = 0;

    /* corpse */
    this.corpse = null;

    /* bookkeeping */
    this.spawnTick = 0;
    this.tickFn = null;

    /* Position in this.map's byDef index, so removal is a swap-pop
       rather than a scan of ten thousand grass plants. */
    this._defIdx = -1;

    /* The cells this thing was written into, remembered at placement.
       A building whose rotation or position is edited after it spawned
       must still be erased from the cells it really occupies, not the
       ones it would occupy now. */
    this._cells = null;
    this._rotTick = undefined;
    this._doorTicks = 0;
  }

  /* The def a ghost is standing in for; for anything else, its own. */
  Thing.prototype.buildDef = function () {
    if (this.isBlueprint || this.isFrame) return buildDefOf(this.buildDefId);
    return this.def;
  };

  Thing.prototype.footprint = function () {
    return footprintOf(this.buildDef(), this.rot | 0);
  };

  Thing.prototype.isItem = function () {
    return this.def.category === 'item';
  };

  Thing.prototype.isPlant = function () {
    return this.def.category === 'plant';
  };

  /* A ghost is not a building: it blocks nothing, holds no roof and
     cannot be deconstructed, so every caller asking "is this a
     building" means the finished article. */
  Thing.prototype.isBuilding = function () {
    return this.def.category === 'building' && !this.isBlueprint && !this.isFrame;
  };

  Thing.prototype.isGhost = function () {
    return this.isBlueprint || this.isFrame;
  };

  /* The middle of the footprint, in tile coordinates: (5,5) for a
     one-tile thing at 5,5 and (5.5,5.5) for a 2x2 whose origin is
     there. Cameras and projectiles aim at this. */
  Thing.prototype.center = function () {
    var f = this.footprint();
    return { x: this.x + (f.w - 1) / 2, y: this.y + (f.h - 1) / 2 };
  };

  /* Every cell index the thing stands on. Cells are indices here, the
     way Zone.cells and Path results are indices. Clipped to the map,
     so a footprint hanging off the edge simply yields fewer cells. */
  Thing.prototype.occupiedCells = function () {
    var map = this.map || (root.Game && root.Game.map) || null;
    if (!map) return [];
    var f = this.footprint();
    var out = [];
    for (var dy = 0; dy < f.h; dy++) {
      for (var dx = 0; dx < f.w; dx++) {
        var x = this.x + dx, y = this.y + dy;
        if (!map.inBounds(x, y)) continue;
        out.push(map.idx(x, y));
      }
    }
    return out;
  };

  Thing.prototype.covers = function (x, y) {
    var f = this.footprint();
    return x >= this.x && x < this.x + f.w && y >= this.y && y < this.y + f.h;
  };

  /* Where a pawn stands to use this thing, or null when any adjacent
     cell will do. Rotated with the building, which is the whole point
     of storing an offset rather than a cell. */
  Thing.prototype.interactionCell = function () {
    var b = this.def.building;
    var off = b && b.interactionOffset;
    if (!off) return null;
    var r = rotateOffset(off, this.rot | 0);
    return { x: this.x + r.dx, y: this.y + r.dy };
  };

  Thing.prototype.label = function () {
    var def = this.def;
    var base;

    if (this.corpse) {
      base = 'corpse of ' + (this.corpse.name || 'someone');
    } else if (this.isBlueprint || this.isFrame) {
      var bd = this.buildDef();
      base = ((bd && bd.label) || 'building') + (this.isFrame ? ' (unfinished)' : ' (planned)');
    } else {
      base = def.label || def.id;
      var adj = this.stuff ? STUFF_ADJECTIVE[this.stuff] : null;
      if (adj) base = adj + ' ' + base;
    }

    if (this.quality !== null && this.quality !== undefined && QUALITY[this.quality]) {
      base += ' (' + QUALITY[this.quality] + ')';
    }
    if (this.stack > 1) base += ' x' + this.stack;
    return base;
  };

  /* Returns true when the hit destroyed it, because every caller -
     combat, fire, a collapsing roof - wants to know whether to stop
     aiming at it. */
  Thing.prototype.damage = function (amount) {
    if (!(amount > 0)) return false;
    this.hp -= amount;
    if (this.hp > 0) return false;
    this.hp = 0;
    var map = this.map || (root.Game && root.Game.map) || null;
    if (map && this.spawned) map.destroyThing(this, 'damage');
    return true;
  };

  /* ============================================================
     GameMap
     ============================================================ */
  function GameMap(w, h) {
    this.w = w | 0;
    this.h = h | 0;
    this.size = this.w * this.h;
    this.IMPASSABLE = IMPASSABLE;

    var size = this.size;

    this.terrain = new Uint8Array(size);
    this.buildingId = new Int32Array(size);
    this.plantId = new Int32Array(size);
    this.ghostId = new Int32Array(size);      /* blueprints and frames */
    this.itemGrid = new Array(size);
    this.roof = new Uint8Array(size);
    this.pathCost = new Uint16Array(size);
    this.blood = new Uint8Array(size);
    this.areaId = new Int32Array(size);       /* written by regions.js */
    this.roomId = new Int32Array(size);       /* written by regions.js */
    this.zoneId = new Int32Array(size);       /* written by zones.js   */

    for (var i = 0; i < size; i++) this.itemGrid[i] = null;

    /* Bare soil everywhere until mapgen says otherwise. */
    var soil = Defs.has('terrain', 'soil') ? Defs.index('terrain', 'soil') : 0;
    if (soil) this.terrain.fill(soil);

    this.things = new Map();
    this.pawns = [];
    this.designations = new Map();
    this.zones = [];
    this.tickList = [];

    this._byDef = Object.create(null);
    this._pawnCells = new Array(size);
    for (var p = 0; p < size; p++) this._pawnCells[p] = null;
    this._pawnIndexed = 0;
    this._designationsByType = Object.create(null);

    this._rotScan = [];
    this._rotCursor = 0;
    this._bloodCursor = 0;
    this._tickBatch = [];

    /* The map's own clock. Game.tick is the game's; this one exists so
       rot and blood keep their cadence in a headless test that ticks
       the map without a Game around it. */
    this.tickCount = 0;

    /* Terrain is the only cost contributor that exists at birth. */
    for (var c = 0; c < size; c++) this.pathCost[c] = this._computeCost(c);
  }

  GameMap.IMPASSABLE = IMPASSABLE;

  /* ---------- coordinates ---------- */

  GameMap.prototype.idx = function (x, y) { return y * this.w + x; };
  GameMap.prototype.xOf = function (i) { return i % this.w; };
  GameMap.prototype.yOf = function (i) { return (i / this.w) | 0; };
  GameMap.prototype.inBounds = function (x, y) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  };
  GameMap.prototype.inBoundsIdx = function (i) { return i >= 0 && i < this.size; };

  /* ---------- terrain ---------- */

  GameMap.prototype.terrainAt = function (x, y) {
    if (!this.inBounds(x, y)) return null;
    return terrainList()[this.terrain[this.idx(x, y)]] || null;
  };

  GameMap.prototype.terrainAtIdx = function (i) {
    return terrainList()[this.terrain[i]] || null;
  };

  GameMap.prototype.setTerrain = function (x, y, defId) {
    if (!this.inBounds(x, y)) return false;
    if (!Defs.has('terrain', defId)) return false;
    var i = this.idx(x, y);
    var next = Defs.index('terrain', defId);
    if (this.terrain[i] === next) return true;
    this.terrain[i] = next;
    this.markPathDirtyIdx(i);
    return true;
  };

  /* ---------- what is standing here ---------- */

  GameMap.prototype.buildingAt = function (x, y) {
    if (!this.inBounds(x, y)) return null;
    var id = this.buildingId[this.idx(x, y)];
    return id ? (this.things.get(id) || null) : null;
  };

  GameMap.prototype.buildingAtIdx = function (i) {
    var id = this.buildingId[i];
    return id ? (this.things.get(id) || null) : null;
  };

  GameMap.prototype.plantAt = function (x, y) {
    if (!this.inBounds(x, y)) return null;
    var id = this.plantId[this.idx(x, y)];
    return id ? (this.things.get(id) || null) : null;
  };

  /* Blueprints and frames sit on their own grid rather than the
     building grid: a planned floor under a bed must not evict the bed,
     and canPlace has to be able to see the bed through the plan. */
  GameMap.prototype.ghostAt = function (x, y) {
    if (!this.inBounds(x, y)) return null;
    var id = this.ghostId[this.idx(x, y)];
    return id ? (this.things.get(id) || null) : null;
  };

  GameMap.prototype.items = function (x, y) {
    if (!this.inBounds(x, y)) return EMPTY;
    return this.itemGrid[this.idx(x, y)] || EMPTY;
  };

  GameMap.prototype.itemsIdx = function (i) {
    if (i < 0 || i >= this.size) return EMPTY;
    return this.itemGrid[i] || EMPTY;
  };

  /* The first stack of a given def on a cell, which is what hauling and
     bill ingredients actually want from a cell. */
  GameMap.prototype.itemOfDefAt = function (x, y, defId) {
    var list = this.items(x, y);
    for (var i = 0; i < list.length; i++) if (list[i].defId === defId) return list[i];
    return null;
  };

  GameMap.prototype.thing = function (id) {
    return this.things.get(id) || null;
  };

  /* A live index, kept by spawn/despawn. Never null: callers iterate it
     without a guard, and an empty array is the honest answer for a def
     nothing has spawned yet. */
  GameMap.prototype.byDef = function (defId) {
    var list = this._byDef[defId];
    if (!list) { list = []; this._byDef[defId] = list; }
    return list;
  };

  /* ---------- pawns ---------- */

  GameMap.prototype.addPawn = function (pawn, x, y) {
    if (!pawn) return false;
    if (x !== undefined && x !== null) pawn.x = x | 0;
    if (y !== undefined && y !== null) pawn.y = y | 0;
    pawn.map = this;
    if (this.pawns.indexOf(pawn) < 0) this.pawns.push(pawn);
    this._indexPawn(pawn);
    this._pawnIndexed = this.pawns.length;
    return true;
  };

  GameMap.prototype.removePawn = function (pawn) {
    if (!pawn) return false;
    if (!U.remove(this.pawns, pawn)) return false;
    this._unindexPawn(pawn, pawn.x, pawn.y);
    this._pawnIndexed = this.pawns.length;
    return true;
  };

  /* pawn.js calls this on every tile change; it is the only thing
     keeping the per-cell pawn index honest. */
  GameMap.prototype.notePawnMoved = function (pawn, oldX, oldY) {
    if (!pawn) return;
    if (oldX !== undefined && oldX !== null) this._unindexPawn(pawn, oldX, oldY);
    this._indexPawn(pawn);
  };

  GameMap.prototype.pawnsAt = function (x, y) {
    /* A file that pushed straight into map.pawns (animals.js will, if a
       map ever turns up without addPawn) would otherwise be invisible
       here forever. One integer compare per lookup buys that safety. */
    if (this._pawnIndexed !== this.pawns.length) this.reindexPawns();
    if (!this.inBounds(x, y)) return EMPTY;
    return this._pawnCells[this.idx(x, y)] || EMPTY;
  };

  GameMap.prototype.pawnsAtIdx = function (i) {
    if (this._pawnIndexed !== this.pawns.length) this.reindexPawns();
    if (i < 0 || i >= this.size) return EMPTY;
    return this._pawnCells[i] || EMPTY;
  };

  GameMap.prototype.reindexPawns = function () {
    var cells = this._pawnCells;
    for (var i = 0; i < this.size; i++) if (cells[i]) cells[i] = null;
    for (var p = 0; p < this.pawns.length; p++) this._indexPawn(this.pawns[p]);
    this._pawnIndexed = this.pawns.length;
  };

  GameMap.prototype._indexPawn = function (pawn) {
    if (!this.inBounds(pawn.x, pawn.y)) return;
    var i = this.idx(pawn.x, pawn.y);
    var list = this._pawnCells[i];
    if (!list) { this._pawnCells[i] = [pawn]; return; }
    if (list.indexOf(pawn) < 0) list.push(pawn);
  };

  GameMap.prototype._unindexPawn = function (pawn, x, y) {
    if (x === undefined || y === undefined || !this.inBounds(x, y)) return;
    var i = this.idx(x, y);
    var list = this._pawnCells[i];
    if (!list) return;
    U.remove(list, pawn);
    if (!list.length) this._pawnCells[i] = null;
  };

  GameMap.prototype.colonists = function () {
    var out = [];
    for (var i = 0; i < this.pawns.length; i++) {
      var p = this.pawns[i];
      if (p.faction === 'player' && p.isHuman && !p.dead) out.push(p);
    }
    return out;
  };

  /* ---------- spawning ---------- */

  /* opts: {stack, rot, faction, quality, hp, growth, sown, stuff,
            blueprintOf, corpse, fuel}                               */
  GameMap.prototype.spawnThing = function (defId, x, y, opts) {
    if (!Defs.has('thing', defId)) return null;
    if (!this.inBounds(x, y)) return null;
    opts = opts || {};

    var t = new Thing(defId, x, y);
    var def = t.def;

    t.map = this;
    /* A ghost carries the rotation of the thing it is standing in for,
       which is why it takes opts.rot even though the blueprint def
       itself is not rotatable: its footprint is the real building's. */
    var isGhostDef = defId === 'blueprint' || defId === 'frame';
    t.rot = (def.rotatable || isGhostDef) ? ((opts.rot | 0) & 3) : 0;
    t.faction = opts.faction !== undefined ? opts.faction : null;
    t.quality = opts.quality !== undefined ? opts.quality : null;
    t.stuff = opts.stuff !== undefined ? opts.stuff : null;
    t.spawnTick = root.Game && root.Game.tick !== undefined ? root.Game.tick : this.tickCount;

    var limit = def.stackLimit || 1;
    t.stack = U.clamp(opts.stack === undefined ? 1 : opts.stack | 0, 1, limit);

    if (opts.hp !== undefined && opts.hp > 0) { t.hp = opts.hp; t.maxHp = opts.hp; }

    /* Growth is stated or it is zero: a plant that turns up ripe
       because nobody said otherwise would hand mapgen a free harvest
       and plants.js a crop that never grew. */
    if (def.plant) {
      t.growth = opts.growth === undefined ? 0 : U.clamp01(opts.growth);
      t.sown = !!opts.sown;
    }

    if (isGhostDef) {
      t.isFrame = defId === 'frame';
      t.isBlueprint = !t.isFrame;
      t.buildDefId = opts.blueprintOf || null;
      t.materials = {};
      t.workDone = 0;
    }

    if (def.category === 'building' && def.building) {
      if (def.building.isWorkbench || (def.recipes && def.recipes.length)) t.bills = [];
      if (def.building.fuelCapacity > 0) t.fuel = opts.fuel === undefined ? 0 : opts.fuel;
    }

    if (opts.corpse) t.corpse = opts.corpse;

    this._register(t);
    this._place(t);
    return t;
  };

  /* Registry + indices, without touching the grids. moveThing uses it
     to adopt a thing that was being carried a moment ago. */
  GameMap.prototype._register = function (t) {
    if (this.things.has(t.id)) return;
    t.map = this;
    this.things.set(t.id, t);
    var list = this.byDef(t.defId);
    t._defIdx = list.length;
    list.push(t);
    if (wantsTick(t)) this.tickList.push(t);
  };

  GameMap.prototype._forget = function (t) {
    if (!this.things.has(t.id)) return;
    this.things.delete(t.id);

    /* Swap-pop: byDef holds every grass plant on the map and a linear
       removal would turn a wildfire into a quadratic one. */
    var list = this.byDef(t.defId);
    var i = t._defIdx;
    if (i < 0 || list[i] !== t) i = list.indexOf(t);
    if (i >= 0) {
      var last = list.pop();
      if (last !== t) { list[i] = last; last._defIdx = i; }
    }
    t._defIdx = -1;

    if (this.tickList.length) U.remove(this.tickList, t);
  };

  /* Write the thing into whichever grid it belongs to. */
  GameMap.prototype._place = function (t) {
    t.spawned = true;
    var cells = t.occupiedCells();
    t._cells = cells;
    var i, k;

    if (t.isGhost()) {
      for (k = 0; k < cells.length; k++) this.ghostId[cells[k]] = t.id;
    } else if (t.def.category === 'building') {
      for (k = 0; k < cells.length; k++) this.buildingId[cells[k]] = t.id;
    } else if (t.def.category === 'plant') {
      this.plantId[this.idx(t.x, t.y)] = t.id;
    } else {
      i = this.idx(t.x, t.y);
      var list = this.itemGrid[i];
      if (!list) { this.itemGrid[i] = [t]; } else if (list.indexOf(t) < 0) { list.push(t); }
    }

    for (k = 0; k < cells.length; k++) this.markPathDirtyIdx(cells[k]);
  };

  /* The mirror of _place. Every grid write is guarded by an id match so
     that despawning a thing that was already overwritten - a wall mined
     out from under a blueprint, say - cannot erase its replacement. */
  GameMap.prototype._unplace = function (t) {
    var cells = t._cells || t.occupiedCells();
    var k, i, list;

    if (t.isGhost()) {
      for (k = 0; k < cells.length; k++) {
        if (this.ghostId[cells[k]] === t.id) this.ghostId[cells[k]] = 0;
      }
    } else if (t.def.category === 'building') {
      for (k = 0; k < cells.length; k++) {
        if (this.buildingId[cells[k]] === t.id) this.buildingId[cells[k]] = 0;
      }
    } else if (t.def.category === 'plant') {
      for (k = 0; k < cells.length; k++) {
        if (this.plantId[cells[k]] === t.id) this.plantId[cells[k]] = 0;
      }
    } else {
      for (k = 0; k < cells.length; k++) {
        i = cells[k];
        list = this.itemGrid[i];
        if (!list) continue;
        U.remove(list, t);
        if (!list.length) this.itemGrid[i] = null;
      }
    }

    t.spawned = false;
    t._cells = null;
    for (k = 0; k < cells.length; k++) this.markPathDirtyIdx(cells[k]);
  };

  GameMap.prototype.despawnThing = function (thing) {
    if (!thing) return false;
    if (thing.spawned && thing.map === this) this._unplace(thing);
    thing.spawned = false;
    this._forget(thing);
    this.undesignateThing(thing);
    return true;
  };

  /* Destroyed, not taken apart: leavings are the rubble a wall makes
     when something knocks it down, which is how a burnt stone wall
     still leaves chunks on the floor. */
  GameMap.prototype.destroyThing = function (thing, cause) {
    if (!thing) return false;
    var x = thing.x, y = thing.y;
    var def = thing.def;
    var wasSpawned = thing.spawned;
    var holdsRoof = wasSpawned && !thing.isGhost() && def.holdsRoof;

    /* A frame is holding real materials; they come back out. Taken off
       the thing before it dies and dropped after, so they land on the
       cell it has just freed rather than spilling around a frame that
       is still standing there. */
    var mats = (thing.isFrame && thing.materials) ? thing.materials : null;
    if (mats) thing.materials = {};

    this.despawnThing(thing);

    if (mats) {
      for (var m in mats) {
        if (mats[m] > 0) this.addItem(m, x, y, mats[m]);
      }
    }

    if (wasSpawned && def.leavings) {
      for (var k in def.leavings) {
        var n = def.leavings[k] | 0;
        if (n > 0) this.addItem(k, x, y, n);
      }
    }

    /* Whatever was holding this roof up is gone; nothing else in the
       game asks that question after a building dies to damage. */
    if (holdsRoof && typeof root.Construct !== 'undefined' && root.Construct.checkRoofCollapse) {
      root.Construct.checkRoofCollapse(this, x, y);
    }
    return true;
  };

  GameMap.prototype.moveThing = function (thing, x, y) {
    if (!thing || !this.inBounds(x, y)) return false;
    /* Whichever map it is standing on has to let go of it first, or the
       grid it left keeps pointing at a thing that is somewhere else. */
    if (thing.spawned) {
      if (thing.map === this) this._unplace(thing);
      else if (thing.map) thing.map.despawnThing(thing);
      else thing.spawned = false;
    }
    thing.x = x | 0;
    thing.y = y | 0;
    this._register(thing);
    this._place(thing);
    return true;
  };

  /* ---------- item stacks ---------- */

  /* Drops `count` of an item at (x,y): merge into what is already
     there, then spill outward one new stack per cell. Nothing is ever
     lost - if the neighbourhood is full the remainder piles up on the
     origin cell, ugly but present. */
  GameMap.prototype.addItem = function (defId, x, y, count, opts) {
    var def = Defs.maybe('thing', defId);
    if (!def || !(count > 0)) return [];
    if (!this.inBounds(x, y)) return [];

    /* Non-items have no stacks to merge into, so the count is beside the
       point: one spawn, and the caller's opts reach it untouched. */
    if (def.category !== 'item') {
      var single = this.spawnThing(defId, x, y, opts);
      return single ? [single] : [];
    }

    var limit = def.stackLimit || 1;
    var remaining = count | 0;
    var touched = [];
    var radius = 0;

    /* Whatever the caller asked for - trade.js hands over silver that
       belongs to the player, production.js hands over what a bill made -
       has to reach every stack the drop creates, not just the first.
       spawnThing reads `stack` off this same object, so it is rewritten
       per stack rather than rebuilt. */
    var stackOpts = {};
    if (opts) for (var o in opts) stackOpts[o] = opts[o];

    /* Rings of growing radius, each pass looking only at the cells the
       previous pass could not reach: U.cellsInRadius returns a filled
       disc, so the band is what lies outside the last radius. Starting
       small means the common case - a stack that fits where it fell -
       never builds a list of two hundred cells. */
    while (remaining > 0 && radius <= SPILL_RADIUS) {
      var inner = radius > 0 ? (radius - 1) * (radius - 1) : -1;
      var ring = U.cellsInRadius(x, y, radius);
      for (var c = 0; c < ring.length && remaining > 0; c++) {
        var cx = ring[c][0], cy = ring[c][1];
        if (U.distSq(x, y, cx, cy) <= inner) continue;
        if (!this.inBounds(cx, cy)) continue;
        if (!this.passable(cx, cy)) continue;
        /* Spilling through a wall would be a small miracle. When
           regions.js is up it can answer that in O(1); before it is,
           everything is one area and this costs nothing. */
        if (radius > 0 && !this.sameArea(x, y, cx, cy)) continue;

        var i = this.idx(cx, cy);
        var list = this.itemGrid[i];

        if (list) {
          for (var s = 0; s < list.length && remaining > 0; s++) {
            var st = list[s];
            if (st.defId !== defId) continue;
            var room = limit - st.stack;
            if (room <= 0) continue;
            var take = room < remaining ? room : remaining;
            /* Fresh food folded into an old pile ages with the pile. */
            if (def.rotDays > 0) {
              st.rotProgress = (st.rotProgress * st.stack) / (st.stack + take);
            }
            st.stack += take;
            remaining -= take;
            if (touched.indexOf(st) < 0) touched.push(st);
          }
        }

        /* One stack of cargo per cell. A cell that already holds a full
           stack is not a free cell, so the rest walks outward instead
           of towering on the tile the miner happened to stand on. */
        if (remaining > 0 && this.cellTakesNewStack(i)) {
          var n = remaining < limit ? remaining : limit;
          stackOpts.stack = n;
          var made = this.spawnThing(defId, cx, cy, stackOpts);
          if (made) {
            remaining -= n;
            touched.push(made);
          }
        }
      }
      radius++;
    }

    /* Last resort: the map is full of walls and water in every
       direction. Pile the rest where it was dropped. */
    while (remaining > 0) {
      stackOpts.stack = remaining < limit ? remaining : limit;
      var pile = this.spawnThing(defId, x, y, stackOpts);
      if (!pile) break;
      remaining -= stackOpts.stack;
      touched.push(pile);
    }

    return touched;
  };

  /* Whether a loose stack may be created on this cell. Cargo is one
     stack to a tile, the way a stockpile reads it. */
  GameMap.prototype.cellTakesNewStack = function (i) {
    var list = this.itemGrid[i];
    if (!list) return true;
    for (var k = 0; k < list.length; k++) {
      if (isHaulable(list[k].def)) return false;
    }
    return true;
  };

  /* Reachability, when regions.js is loaded to answer it. Before that -
     mapgen, a headless map test - every cell is assumed connected,
     which is the only answer that lets items be placed at all. */
  GameMap.prototype.sameArea = function (x1, y1, x2, y2) {
    var R = root.Regions;
    if (typeof R === 'undefined' || !R || !R.sameArea) return true;
    return !!R.sameArea(this, x1, y1, x2, y2);
  };

  /* Takes `count` off a stack and hands back something a pawn can
     carry. Taking the whole stack returns the original thing, now
     despawned, so that reservations and job targets pointing at it
     stay pointing at it. */
  GameMap.prototype.splitStack = function (thing, count) {
    if (!thing) return null;
    count = count | 0;
    if (count <= 0) return null;
    if (count >= thing.stack) {
      if (thing.spawned) this.despawnThing(thing);
      return thing;
    }

    var part = new Thing(thing.defId, thing.x, thing.y);
    part.map = this;
    part.stack = count;
    part.hp = thing.hp;
    part.maxHp = thing.maxHp;
    part.quality = thing.quality;
    part.stuff = thing.stuff;
    part.faction = thing.faction;
    part.rotProgress = thing.rotProgress;
    part.spawnTick = thing.spawnTick;
    part.spawned = false;

    thing.stack -= count;
    return part;
  };

  /* Pours one stack into another and returns how many units moved. The
     source is despawned when it empties, which is what makes
     "put the carried stack in the stockpile" a one-liner. */
  GameMap.prototype.mergeInto = function (thing, targetStack) {
    if (!thing || !targetStack || thing === targetStack) return 0;
    if (thing.defId !== targetStack.defId) return 0;

    var limit = targetStack.def.stackLimit || 1;
    var room = limit - targetStack.stack;
    if (room <= 0) return 0;

    var moved = room < thing.stack ? room : thing.stack;
    if (moved <= 0) return 0;

    if (targetStack.def.rotDays > 0) {
      var total = targetStack.stack + moved;
      targetStack.rotProgress =
        (targetStack.rotProgress * targetStack.stack + thing.rotProgress * moved) / total;
    }
    targetStack.stack += moved;
    thing.stack -= moved;

    if (thing.stack <= 0) {
      if (thing.spawned) this.despawnThing(thing);
      else this._forget(thing);
    }
    return moved;
  };

  /* ---------- movement cost ---------- */

  GameMap.prototype.passable = function (x, y) {
    if (!this.inBounds(x, y)) return false;
    return this.pathCost[this.idx(x, y)] !== IMPASSABLE;
  };

  GameMap.prototype.passableIdx = function (i) {
    return i >= 0 && i < this.size && this.pathCost[i] !== IMPASSABLE;
  };

  GameMap.prototype.walkCost = function (x, y) {
    if (!this.inBounds(x, y)) return IMPASSABLE;
    return this.pathCost[this.idx(x, y)];
  };

  /* The one place that decides what a cell costs. Terrain, then
     whatever is standing on it, then whatever is lying on it. */
  GameMap.prototype._computeCost = function (i) {
    var terr = terrainList()[this.terrain[i]];
    if (!terr || terr.passable === false) return IMPASSABLE;
    var cost = terr.pathCost || 0;

    var b = this.buildingId[i] ? this.things.get(this.buildingId[i]) : null;
    if (b) {
      var bd = b.def;
      if (bd.passable === false) return IMPASSABLE;
      cost += bd.pathCost || 0;
      if (bd.building && bd.building.isDoor) cost += DOOR_COST;
    }

    var g = this.ghostId[i] ? this.things.get(this.ghostId[i]) : null;
    if (g) cost += g.def.pathCost || 0;

    var p = this.plantId[i] ? this.things.get(this.plantId[i]) : null;
    if (p) cost += p.def.pathCost || 0;

    /* Only the worst of a pile counts: three stacks of steel are no
       harder to step over than one. */
    var list = this.itemGrid[i];
    if (list) {
      var worst = 0;
      for (var k = 0; k < list.length; k++) {
        var ic = list[k].def.pathCost || 0;
        if (ic > worst) worst = ic;
      }
      cost += worst;
    }

    return cost > MAX_COST ? MAX_COST : cost;
  };

  GameMap.prototype.markPathDirty = function (x, y) {
    if (!this.inBounds(x, y)) return;
    this.markPathDirtyIdx(this.idx(x, y));
  };

  GameMap.prototype.markPathDirtyIdx = function (i) {
    if (i < 0 || i >= this.size) return;
    var next = this._computeCost(i);
    if (next === this.pathCost[i]) return;   /* nothing derived can have changed */
    this.pathCost[i] = next;

    /* Guarded by typeof so map.js still loads, and still works, on its
       own in a test harness that has no regions or power. */
    if (typeof root.Regions !== 'undefined' && root.Regions.markDirty) {
      root.Regions.markDirty(this, this.xOf(i), this.yOf(i));
    }
    if (typeof root.Power !== 'undefined' && root.Power.markDirty) {
      root.Power.markDirty(this);
    }
  };

  /* ---------- roofs ---------- */

  GameMap.prototype.hasRoofAt = function (x, y) {
    if (!this.inBounds(x, y)) return false;
    return this.roof[this.idx(x, y)] !== 0;
  };

  GameMap.prototype.setRoof = function (x, y, kind) {
    if (!this.inBounds(x, y)) return false;
    var i = this.idx(x, y);
    var v = kind | 0;
    if (this.roof[i] === v) return true;
    this.roof[i] = v;
    /* A roof does not change move cost, but it does change whether the
       room under it is indoors, which is regions.js's business. */
    if (typeof root.Regions !== 'undefined' && root.Regions.markDirty) {
      root.Regions.markDirty(this, x, y);
    }
    return true;
  };

  /* ---------- designations ---------- */

  /* One designation per cell. A player who marks a tree for chopping
     and then for cutting means the second one; keeping both would just
     be two work givers fighting over the same tree. */
  GameMap.prototype.designate = function (x, y, type, opts) {
    if (!this.inBounds(x, y) || !type) return null;
    var i = this.idx(x, y);
    var existing = this.designations.get(i);
    if (existing && existing.type !== type) this._untrackDesignation(existing);

    var d = {
      type: type,
      defId: (opts && opts.defId) || null,
      i: i, x: x, y: y
    };
    this.designations.set(i, d);
    var set = this._designationsByType[type];
    if (!set) { set = new Set(); this._designationsByType[type] = set; }
    set.add(i);
    return d;
  };

  GameMap.prototype.undesignate = function (x, y, type) {
    if (!this.inBounds(x, y)) return false;
    var i = this.idx(x, y);
    var d = this.designations.get(i);
    if (!d) return false;
    if (type && d.type !== type) return false;
    this.designations.delete(i);
    this._untrackDesignation(d);
    return true;
  };

  GameMap.prototype.designationAt = function (x, y, type) {
    if (!this.inBounds(x, y)) return null;
    var d = this.designations.get(this.idx(x, y));
    if (!d) return null;
    if (type && d.type !== type) return null;
    return d;
  };

  /* Every cell marked with one type, as designation records. Work
     givers scan this instead of the whole map. */
  GameMap.prototype.designationsOf = function (type) {
    var set = this._designationsByType[type];
    if (!set || !set.size) return EMPTY;
    var out = [];
    var self = this;
    set.forEach(function (i) {
      var d = self.designations.get(i);
      if (d && d.type === type) out.push(d);
    });
    return out;
  };

  GameMap.prototype._untrackDesignation = function (d) {
    var set = this._designationsByType[d.type];
    if (set) set.delete(d.i);
  };

  /* A designated thing that stops existing takes its mark with it -
     otherwise a chopped tree leaves a chop order on bare soil and the
     work giver hands out a job for nothing, forever. The type has to
     match what died, though: a plan drawn over a marked tree is not the
     tree, and cancelling it must not cancel the chop. */
  var PLANT_DESIGNATIONS = { chop: 1, harvest: 1, cut: 1 };
  var BUILDING_DESIGNATIONS = { deconstruct: 1, mine: 1 };

  GameMap.prototype.undesignateThing = function (thing) {
    if (!thing || !this.designations.size) return;
    var cat = thing.def.category;
    if (cat === 'item') return;
    var isPlant = cat === 'plant';
    var cells = thing.occupiedCells();

    for (var k = 0; k < cells.length; k++) {
      var d = this.designations.get(cells[k]);
      if (!d) continue;
      var mine;
      if (d.defId) {
        mine = d.defId === thing.defId;
      } else {
        mine = isPlant ? !!PLANT_DESIGNATIONS[d.type]
                       : (!thing.isGhost() && !!BUILDING_DESIGNATIONS[d.type]);
      }
      if (!mine) continue;
      this.designations.delete(d.i);
      this._untrackDesignation(d);
    }
  };

  /* ---------- wealth ---------- */

  /* What the storyteller reads before it decides how many raiders you
     have earned. Items count their stack, buildings their build cost,
     and a half-built frame counts the materials sitting in it. Plants
     are worth nothing standing up. */
  GameMap.prototype.wealth = function () {
    var total = 0;
    var iter = this.things.values();
    var step = iter.next();
    while (!step.done) {
      var t = step.value;
      step = iter.next();
      if (!t.spawned) continue;
      var def = t.def;

      if (def.category === 'item') {
        total += (def.marketValue || 0) * t.stack;
      } else if (t.isFrame && t.materials) {
        for (var k in t.materials) {
          var md = Defs.maybe('thing', k);
          if (md) total += (md.marketValue || 0) * t.materials[k];
        }
      } else if (t.isBuilding() && !def.natural) {
        total += def.marketValue || 0;
      }
    }
    return Math.round(total);
  };

  /* ---------- the tick ---------- */

  /* Which things map.js itself has to visit every tick. Doors are the
     only ones it owns outright - they react to whoever is standing in
     them. Everything else on the list is there because another system
     asked for it by name through setTickFn, which is how combat.js
     drives turrets and traps. Fire, fuel and heaters are ticked by the
     systems that own them (plants.js, power.js) off their own byDef
     index, so putting them here would only cost an empty call. */
  function wantsTick(t) {
    if (typeof t.tickFn === 'function') return true;
    var b = t.def.building;
    return !!(b && b.isDoor);
  }

  /* Attach behaviour to a thing after it has spawned - combat.js gives a
     turret its firing routine this way - and put it on the tick list.
     Passing null takes the behaviour back off, and the thing with it
     unless map.js has its own reason to keep ticking it. */
  GameMap.prototype.setTickFn = function (thing, fn) {
    if (!thing) return;
    thing.tickFn = fn;
    if (fn && this.tickList.indexOf(thing) < 0) this.tickList.push(thing);
    else if (!fn && !wantsTick(thing)) U.remove(this.tickList, thing);
  };

  GameMap.prototype.tick = function () {
    this.tickCount++;
    this._tickThings();
    this._tickRot();
    this._fadeBlood();
    /* Cheap insurance against a pawn added and another removed between
       two lookups, which the length check alone cannot see. */
    if (this.tickCount % PAWN_REINDEX_PERIOD === 0) this.reindexPawns();
  };

  GameMap.prototype._tickThings = function () {
    var list = this.tickList;
    var n = list.length;
    if (!n) return;

    /* Ticked off a copy of the list. A tick that destroys something else
       on it - a turret shooting a trap apart - reaches _forget, which
       splices the list out from under a live cursor and makes its
       neighbour tick twice. Working from a copy also means anything
       spawned during the pass waits for the next one, which is the
       answer a half-built tick list wants anyway. */
    var batch = this._tickBatch;
    batch.length = 0;
    for (var i = 0; i < n; i++) batch.push(list[i]);

    var stale = false;
    for (var k = 0; k < n; k++) {
      var t = batch[k];
      if (!t.spawned) { stale = true; continue; }
      if (t.tickFn) t.tickFn(t, this);
      if (!t.spawned) continue;
      var b = t.def.building;
      if (b && b.isDoor) this._tickDoor(t, b);
    }
    batch.length = 0;

    /* Anything that left the map without going through _forget - a file
       that set spawned = false by hand - is dropped here rather than
       tested again every tick for the rest of the game. */
    if (stale) {
      for (var j = list.length - 1; j >= 0; j--) if (!list[j].spawned) list.splice(j, 1);
    }
  };

  /* Doors open for whoever is standing in them and swing shut a moment
     after they leave. Pathing charges for the delay; this is what makes
     the door visibly open, and what combat.js reads for line of sight
     through a doorway. */
  GameMap.prototype._tickDoor = function (t, b) {
    var here = this.pawnsAt(t.x, t.y);
    if (here.length) {
      t.open = true;
      t._doorTicks = b.openTicks || 45;
      return;
    }
    if (!t.open) return;
    t._doorTicks = (t._doorTicks || 0) - 1;
    if (t._doorTicks <= 0) t.open = false;
  };

  /* Rot runs as a rolling slice: the list of everything perishable is
     rebuilt once per period and a slice of it is aged each tick, so a
     thousand meals cost the same per tick as ten. */
  GameMap.prototype._tickRot = function () {
    var list = this._rotScan;
    if (this.tickCount % ROT_PERIOD === 0) {
      list.length = 0;
      var ids = rottableIds();
      for (var d = 0; d < ids.length; d++) {
        var arr = this.byDef(ids[d]);
        for (var a = 0; a < arr.length; a++) list.push(arr[a]);
      }
      this._rotCursor = 0;
    }
    if (!list.length) return;

    var per = Math.ceil(list.length / ROT_PERIOD);
    for (var n = 0; n < per && this._rotCursor < list.length; n++) {
      this._rotThing(list[this._rotCursor++]);
    }
  };

  GameMap.prototype._rotThing = function (t) {
    if (!t || !t.spawned || !(t.def.rotDays > 0)) return;

    var last = t._rotTick === undefined ? this.tickCount : t._rotTick;
    var elapsed = this.tickCount - last;
    t._rotTick = this.tickCount;
    if (elapsed <= 0) return;

    var rate = rotRate(this.temperatureAtIdx(this.idx(t.x, t.y)));
    if (rate <= 0) return;

    t.rotProgress += (elapsed * rate) / (t.def.rotDays * TICKS_PER_DAY);
    if (t.rotProgress >= 1) this.destroyThing(t, 'rotted');
  };

  /* Frozen food keeps, a cold room slows it down, and a summer
     afternoon takes a meal apart in a couple of days. */
  function rotRate(tempC) {
    if (tempC <= 0) return 0;
    if (tempC < 10) return 0.1 + (tempC / 10) * 0.9;
    var r = 1 + (tempC - 10) * 0.035;
    return r > 3 ? 3 : r;
  }

  /* Room temperature if regions.js has worked one out, otherwise a
     comfortable default so a map ticking on its own still behaves. */
  GameMap.prototype.temperatureAtIdx = function (i) {
    var R = root.Regions;
    if (typeof R === 'undefined' || !R) return DEFAULT_TEMP;
    var rid = this.roomId[i];
    if (rid && R.rooms) {
      var rooms = R.rooms(this);
      var room = rooms && rooms.get ? rooms.get(rid) : null;
      if (room && typeof room.temperature === 'number') return room.temperature;
    }
    if (R.roomAt) {
      var r2 = R.roomAt(this, this.xOf(i), this.yOf(i));
      if (r2 && typeof r2.temperature === 'number') return r2.temperature;
    }
    return DEFAULT_TEMP;
  };

  GameMap.prototype.temperatureAt = function (x, y) {
    if (!this.inBounds(x, y)) return DEFAULT_TEMP;
    return this.temperatureAtIdx(this.idx(x, y));
  };

  /* Blood dries out on a rolling sweep of the whole grid, three times
     slower under a roof than out in the weather. Indoors that is slow
     enough that somebody has to get a mop; the cleaner is what the
     stain is really waiting for. */
  GameMap.prototype._fadeBlood = function () {
    var per = Math.ceil(this.size / BLOOD_PERIOD);
    for (var n = 0; n < per; n++) {
      var i = this._bloodCursor;
      this._bloodCursor = (i + 1) % this.size;
      var v = this.blood[i];
      if (!v) continue;
      var fade = this.roof[i] ? 1 : 3;
      this.blood[i] = v > fade ? v - fade : 0;
    }
  };

  /* ---------- small conveniences used across the game ---------- */

  GameMap.prototype.addBlood = function (x, y, amount) {
    if (!this.inBounds(x, y) || !(amount > 0)) return;
    var i = this.idx(x, y);
    var v = this.blood[i] + Math.round(amount);
    this.blood[i] = v > 255 ? 255 : v;
  };

  /* Everything of one kind lying loose within a radius, nearest first.
     Bill ingredients and hauling both want exactly this. */
  GameMap.prototype.itemsInRadius = function (x, y, radius, defId) {
    var out = [];
    var ring = U.cellsInRadius(x, y, radius);
    for (var c = 0; c < ring.length; c++) {
      var cx = ring[c][0], cy = ring[c][1];
      if (!this.inBounds(cx, cy)) continue;
      var list = this.itemGrid[this.idx(cx, cy)];
      if (!list) continue;
      for (var k = 0; k < list.length; k++) {
        if (!defId || list[k].defId === defId) out.push(list[k]);
      }
    }
    return out;
  };

  /* A free, walkable neighbour of a cell - where a pawn drops what they
     are holding when the cell they are standing on will not take it. */
  GameMap.prototype.freeNeighbour = function (x, y) {
    for (var i = 0; i < U.ADJ8.length; i++) {
      var nx = x + U.ADJ8[i][0], ny = y + U.ADJ8[i][1];
      if (this.passable(nx, ny)) return { x: nx, y: ny };
    }
    return null;
  };

  GameMap.prototype.thingCount = function () { return this.things.size; };

  root.Thing = Thing;
  root.GameMap = GameMap;
})(this);
