/* ============================================================
   zones.js - stockpiles, growing zones, and the one question every
   hauling job in the game is really asking: where does this belong?

   Three ideas carry the file:

   1. A zone owns a Set of cell indices, and map.zoneId holds the zone
      id for every cell. The Set answers "what is in this zone", the
      grid answers "what zone is this cell in", and both are written by
      the same two private helpers so they cannot drift apart.

   2. A stockpile is a filter with a priority. The filter decides what
      may be stored; the priority decides which stockpile wins when two
      of them would take the same item. "Needs hauling" is then not a
      flag on an item at all - it is the answer to "is there a cell of
      strictly higher priority than the one this thing is standing on",
      which is exactly how RimWorld avoids a global dirty list.

   3. The storage search is the hottest query in the colony: every idle
      hauler runs it against every loose item. So it walks priority
      tiers from urgent down, rejects a whole zone by its bounding box
      before touching a cell, keeps only the 24 nearest candidates in a
      fixed buffer, and only then pays for the expensive checks - stack
      room, reservations, reachability - in nearest-first order.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  var Zones = {};

  var MIN_PRIORITY = 0, MAX_PRIORITY = 4, DEFAULT_PRIORITY = 2;

  /* How many near cells the tier search keeps before it starts paying
     for reservation and reachability checks. Small on purpose: past two
     dozen candidates the twenty-fifth is never the answer. */
  var NEAREST = 24;

  /* Growing-zone sow scans are recomputed at most this often. Work
     givers ask several times a second across a colony of ten, and a
     stale entry costs nothing: the sow job reserves the cell, so a
     second pawn aiming at an already-sown cell is turned away there. */
  var SOW_CACHE_TICKS = 24;

  /* ============================================================
     THING CATEGORIES

     The vocabulary a stockpile filter is written in, and the one
     def_factions.js writes its trade categories in. A category is
     derived from a def's own fields wherever a field says it - food,
     medicine, weapons, apparel - and from a small table only for the
     handful of raw materials that no field distinguishes.
     ============================================================ */
  var CATEGORIES = ['rawFood', 'meals', 'resources', 'stone', 'textiles', 'medicine',
    'weapons', 'apparel', 'corpses', 'chunks', 'manufactured'];

  var CATEGORY_LABELS = {
    rawFood: 'raw food', meals: 'meals', resources: 'resources', stone: 'stone',
    textiles: 'textiles', medicine: 'medicine', weapons: 'weapons', apparel: 'apparel',
    corpses: 'corpses', chunks: 'chunks', manufactured: 'manufactured'
  };

  /* Materials whose category is a judgement call rather than a field. */
  var MATERIAL_CATEGORY = {
    stoneChunk: 'chunks', stoneBlocks: 'stone',
    cloth: 'textiles', leather: 'textiles',
    components: 'manufactured', chemfuel: 'manufactured'
  };

  /* Item defs that live on the item grid but are not cargo: fire and
     blood filth are effects, projectiles are in flight. None of them
     has a category, which is also how the rest of the file says "this
     can never be stored" without a second predicate. */
  var NEVER_STORED = { fire: 1, filthBlood: 1, bullet: 1, arrow: 1 };

  function resolveDef(x) {
    if (!x) return null;
    if (typeof x === 'string') return Defs.maybe('thing', x);
    if (x.defCategory === 'thing') return x;
    return x.def || null;                       /* a Thing was passed */
  }

  Zones.CATEGORIES = CATEGORIES;

  Zones.categoryOf = function (thingDef) {
    var def = resolveDef(thingDef);
    if (!def || def.category !== 'item' || NEVER_STORED[def.id]) return null;
    /* A corpse is food by its fields and nobody wants it in the larder,
       so it is asked about before the food types are. */
    if (def.id === 'corpse') return 'corpses';
    if (def.weapon) return 'weapons';
    if (def.apparel) return 'apparel';
    if (def.isMedicine) return 'medicine';
    if (def.foodType === 'meal') return 'meals';
    if (def.foodType) return 'rawFood';
    if (MATERIAL_CATEGORY[def.id]) return MATERIAL_CATEGORY[def.id];
    return 'resources';
  };

  Zones.categoryLabel = function (category) {
    return CATEGORY_LABELS[category] || category;
  };

  /* Can this def be put in a stockpile at all? */
  Zones.storable = function (thingDef) {
    return Zones.categoryOf(thingDef) !== null;
  };

  /* Every storable def in a category, cached - defs never change after
     load. The UI draws its checkbox trees from this, and trade.js turns
     a faction's stock categories into real goods with it. */
  var _byCategory = null;
  Zones.defsInCategory = function (category) {
    if (!_byCategory) {
      _byCategory = {};
      CATEGORIES.forEach(function (c) { _byCategory[c] = []; });
      Defs.all('thing').forEach(function (d) {
        var c = Zones.categoryOf(d);
        if (c) _byCategory[c].push(d);
      });
    }
    return _byCategory[category] || [];
  };

  /* ============================================================
     ZONE
     ============================================================ */
  var PRIORITY_LABELS = ['unimportant', 'low', 'normal', 'important', 'urgent'];

  var STOCKPILE_COLORS = ['#c2b280', '#b08c5a', '#8f97a3', '#a9906b', '#9a8fa8'];
  var GROWING_COLORS = ['#5c7a3e', '#6d8b48', '#46652f', '#7d9a51'];

  function clampPriority(p) {
    p = p | 0;
    return p < MIN_PRIORITY ? MIN_PRIORITY : (p > MAX_PRIORITY ? MAX_PRIORITY : p);
  }

  /* A filter is four sets and a flag, and the sets are read in the
     order defs, deny, categories, allowAll: an explicitly allowed def
     beats a denied one, and deny only carves holes in the broad
     strokes. That ordering is what lets a player say "everything but
     the chunks" with two clicks. */
  function makeFilter(src) {
    var f = {
      allowAll: true,
      categories: new Set(),
      defs: new Set(),
      deny: new Set()
    };
    if (src) {
      if (src.allowAll !== undefined) f.allowAll = !!src.allowAll;
      fillSet(f.categories, src.categories);
      fillSet(f.defs, src.defs);
      fillSet(f.deny, src.deny);
    }
    return f;
  }

  function fillSet(set, src) {
    if (!src || typeof src.forEach !== 'function') return;
    src.forEach(function (v) { if (typeof v === 'string') set.add(v); });
  }

  function defaultCrop() {
    if (Defs.has('thing', 'plantRice')) return 'plantRice';
    var all = Defs.all('thing');
    for (var i = 0; i < all.length; i++) {
      if (all[i].category === 'plant' && all[i].plant && all[i].plant.sowable) return all[i].id;
    }
    return null;
  }

  function Zone(kind, opts) {
    opts = opts || {};
    this.id = opts.id || U.nextId();
    this.kind = kind;
    this.cells = new Set();
    this.label = opts.label || '';
    this.priority = opts.priority === undefined ? DEFAULT_PRIORITY : clampPriority(opts.priority);
    this.filter = makeFilter(opts.filter);
    this.plantDefId = opts.plantDefId || (kind === 'growing' ? defaultCrop() : null);
    this.allowSow = opts.allowSow === undefined ? true : !!opts.allowSow;
    this.allowCut = opts.allowCut === undefined ? true : !!opts.allowCut;
    this.color = opts.color || null;
    this.deleted = false;
    this._map = null;

    /* Derived, rebuilt on demand: the cells as a flat array and their
       bounding box. The storage search walks these thousands of times
       between edits, and a Set is not an array. */
    this._list = null;
    this._minX = 0; this._minY = 0; this._maxX = -1; this._maxY = -1;
  }

  Zone.prototype.size = function () { return this.cells.size; };
  Zone.prototype.isStockpile = function () { return this.kind === 'stockpile'; };
  Zone.prototype.isGrowing = function () { return this.kind === 'growing'; };

  function cellList(zone) {
    if (zone._list) return zone._list;
    var list = [];
    zone.cells.forEach(function (i) { list.push(i); });
    zone._list = list;
    return list;
  }

  function bounds(map, zone) {
    if (zone._maxX >= zone._minX) return zone;
    var list = cellList(zone), w = map.w;
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (var k = 0; k < list.length; k++) {
      var i = list[k], x = i % w, y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    zone._minX = minX; zone._minY = minY; zone._maxX = maxX; zone._maxY = maxY;
    return zone;
  }

  function invalidate(zone) {
    zone._list = null;
    zone._maxX = -1; zone._minX = 0;
  }

  /* ============================================================
     MAP BOOKKEEPING

     Everything derived from the zone list is cached against a version
     counter that only the mutators below bump, so a render pass or a
     hauler can ask for the stockpile list a thousand times a tick and
     pay for the filter once.
     ============================================================ */
  function touch(map) {
    map._zoneVersion = (map._zoneVersion || 0) + 1;
  }

  function version(map) { return map._zoneVersion || 0; }

  function zoneIndex(map) {
    if (map._zoneIndex && map._zoneIndexVersion === version(map)) return map._zoneIndex;
    var m = new Map();
    for (var i = 0; i < map.zones.length; i++) m.set(map.zones[i].id, map.zones[i]);
    map._zoneIndex = m;
    map._zoneIndexVersion = version(map);
    return m;
  }

  function listOfKind(map, kind, cacheKey) {
    var vkey = cacheKey + 'Version';
    if (map[cacheKey] && map[vkey] === version(map)) return map[cacheKey];
    var out = [];
    for (var i = 0; i < map.zones.length; i++) {
      if (map.zones[i].kind === kind) out.push(map.zones[i]);
    }
    map[cacheKey] = out;
    map[vkey] = version(map);
    return out;
  }

  Zones.all = function (map) { return map.zones; };
  Zones.stockpiles = function (map) { return listOfKind(map, 'stockpile', '_zoneStockpiles'); };
  Zones.growingZones = function (map) { return listOfKind(map, 'growing', '_zoneGrowing'); };
  Zones.byId = function (map, id) { return (id && zoneIndex(map).get(id)) || null; };

  /* A cell may be painted over only when nothing else claims it. Taking
     cells from another zone silently would mean dragging a growing zone
     across a stockpile deletes the stockpile, so a drag stops at the
     edge of what is already there instead. */
  function zoneableCell(map, x, y) {
    if (!map.inBounds(x, y)) return false;
    var t = map.terrainAt(x, y);
    return !!t && t.passable !== false;
  }

  function normalizeCells(map, cells, out) {
    out.length = 0;
    if (!cells) return out;
    var arr = cells;
    if (cells instanceof Set) { arr = []; cells.forEach(function (c) { arr.push(c); }); }
    if (typeof arr.length !== 'number') arr = [arr];
    for (var k = 0; k < arr.length; k++) {
      var c = arr[k], i = -1;
      if (typeof c === 'number') i = c | 0;
      else if (c && typeof c.x === 'number') i = map.inBounds(c.x, c.y) ? map.idx(c.x, c.y) : -1;
      else if (c && c.length === 2) i = map.inBounds(c[0], c[1]) ? map.idx(c[0], c[1]) : -1;
      if (i >= 0 && i < map.size) out.push(i);
    }
    return out;
  }

  var _cellScratch = [];

  function claim(map, zone, cells) {
    var list = normalizeCells(map, cells, _cellScratch), claimed = 0;
    zone._map = map;
    for (var k = 0; k < list.length; k++) {
      var i = list[k];
      if (map.zoneId[i]) continue;                       /* someone else's */
      var x = i % map.w;
      if (!zoneableCell(map, x, (i - x) / map.w)) continue;
      map.zoneId[i] = zone.id;
      zone.cells.add(i);
      claimed++;
    }
    if (claimed) { invalidate(zone); touch(map); }
    return claimed;
  }

  function unclaim(map, zone, cells) {
    var list = normalizeCells(map, cells, _cellScratch), removed = 0;
    for (var k = 0; k < list.length; k++) {
      var i = list[k];
      if (map.zoneId[i] !== zone.id) continue;
      map.zoneId[i] = 0;
      zone.cells.delete(i);
      removed++;
    }
    if (removed) { invalidate(zone); touch(map); }
    return removed;
  }

  function nextLabel(map, kind) {
    var base = kind === 'growing' ? 'Growing zone' : 'Stockpile';
    var n = 1;
    for (var i = 0; i < map.zones.length; i++) if (map.zones[i].kind === kind) n++;
    return base + ' ' + n;
  }

  function pickColor(map, kind) {
    var palette = kind === 'growing' ? GROWING_COLORS : STOCKPILE_COLORS;
    var n = 0;
    for (var i = 0; i < map.zones.length; i++) if (map.zones[i].kind === kind) n++;
    return palette[n % palette.length];
  }

  /* ============================================================
     EDITING
     ============================================================ */
  Zones.add = function (map, kind, cells, opts) {
    if (kind !== 'stockpile' && kind !== 'growing') return null;
    opts = opts || {};
    var zone = new Zone(kind, opts);
    if (!claim(map, zone, cells)) return null;    /* every cell was taken */
    if (!zone.label) zone.label = nextLabel(map, kind);
    if (!zone.color) zone.color = pickColor(map, kind);
    map.zones.push(zone);
    touch(map);
    return zone;
  };

  Zones.expand = function (map, zone, cells) {
    if (!zone || zone.deleted) return 0;
    return claim(map, zone, cells);
  };

  /* Shrinking a zone to nothing deletes it: an invisible zone with a
     filter and a priority still in it is a trap for whoever finds it. */
  Zones.shrink = function (map, zone, cells) {
    if (!zone || zone.deleted) return 0;
    var n = unclaim(map, zone, cells);
    if (n && zone.cells.size === 0) Zones.delete(map, zone);
    return n;
  };

  Zones.removeCells = function (map, cells) {
    var list = normalizeCells(map, cells, []), removed = 0, hit = [];
    for (var k = 0; k < list.length; k++) {
      var i = list[k], id = map.zoneId[i];
      if (!id) continue;
      var zone = Zones.byId(map, id);
      map.zoneId[i] = 0;
      removed++;
      if (zone) {
        zone.cells.delete(i);
        invalidate(zone);
        if (hit.indexOf(zone) < 0) hit.push(zone);
      }
    }
    if (removed) touch(map);
    for (var z = 0; z < hit.length; z++) {
      if (hit[z].cells.size === 0) Zones.delete(map, hit[z]);
    }
    return removed;
  };

  Zones.delete = function (map, zone) {
    if (!zone) return false;
    var idx = map.zones.indexOf(zone);
    zone.cells.forEach(function (i) {
      if (map.zoneId[i] === zone.id) map.zoneId[i] = 0;
    });
    zone.cells.clear();
    invalidate(zone);
    zone.deleted = true;
    if (idx >= 0) map.zones.splice(idx, 1);
    touch(map);
    return idx >= 0;
  };

  Zones.zoneAt = function (map, x, y) {
    if (!map.inBounds(x, y)) return null;
    return Zones.byId(map, map.zoneId[map.idx(x, y)]);
  };

  Zones.zoneAtIdx = function (map, i) {
    if (i < 0 || i >= map.size) return null;
    return Zones.byId(map, map.zoneId[i]);
  };

  Zones.contains = function (zone, x, y, map) {
    var m = map || (zone && zone._map);
    if (!zone || !m) return false;
    return m.inBounds(x, y) && zone.cells.has(m.idx(x, y));
  };

  Zones.forEachCell = function (zone, fn, map) {
    if (!zone || !fn) return;
    var m = map || zone._map || (root.Game && root.Game.map);
    if (!m) return;
    var list = cellList(zone), w = m ? m.w : 0;
    for (var k = 0; k < list.length; k++) {
      var i = list[k], x = w ? i % w : 0;
      fn(x, w ? (i - x) / w : 0, i);
    }
  };

  Zones.cellsOf = function (zone) { return zone ? cellList(zone).slice() : []; };

  Zones.bounds = function (map, zone) {
    if (!zone || !zone.cells.size) return null;
    bounds(map, zone);
    return { x0: zone._minX, y0: zone._minY, x1: zone._maxX, y1: zone._maxY };
  };

  Zones.setPriority = function (map, zone, p) {
    if (!zone) return;
    zone.priority = clampPriority(p);
    touch(map);
  };

  Zones.priorityLabel = function (p) { return PRIORITY_LABELS[clampPriority(p)]; };
  Zones.PRIORITY_LABELS = PRIORITY_LABELS;
  Zones.MAX_PRIORITY = MAX_PRIORITY;

  Zones.rename = function (zone, label) {
    if (zone && label) zone.label = String(label);
  };

  Zones.setPlant = function (zone, plantDefId) {
    if (!zone || zone.kind !== 'growing') return false;
    var def = Defs.maybe('thing', plantDefId);
    if (!def || !def.plant || !def.plant.sowable) return false;
    zone.plantDefId = plantDefId;
    return true;
  };

  /* ============================================================
     THE FILTER
     ============================================================ */
  Zones.accepts = function (zone, thingDef) {
    if (!zone || zone.kind !== 'stockpile') return false;
    var def = resolveDef(thingDef);
    if (!def || !Zones.storable(def)) return false;
    var f = zone.filter;
    if (f.defs.size && f.defs.has(def.id)) return true;
    if (f.deny.has(def.id)) return false;
    if (f.categories.size) {
      var cat = Zones.categoryOf(def);
      if (cat && f.categories.has(cat)) return true;
    }
    return !!f.allowAll;
  };

  Zones.setFilterCategory = function (zone, category, on) {
    if (!zone || CATEGORIES.indexOf(category) < 0) return;
    var f = zone.filter;
    if (on) {
      f.categories.add(category);
      /* Turning a category on while "allow all" is set would be a no-op
         the player cannot see, so the first explicit choice narrows the
         filter to exactly what has been chosen. */
      f.allowAll = false;
      Zones.defsInCategory(category).forEach(function (d) { f.deny.delete(d.id); });
    } else {
      f.categories.delete(category);
      if (f.allowAll) Zones.defsInCategory(category).forEach(function (d) { f.deny.add(d.id); });
    }
  };

  Zones.setFilterDef = function (zone, defId, on) {
    if (!zone || !Defs.has('thing', defId)) return;
    var f = zone.filter;
    if (on) { f.deny.delete(defId); f.defs.add(defId); }
    else { f.defs.delete(defId); f.deny.add(defId); }
  };

  Zones.setAllowAll = function (zone, on) {
    if (!zone) return;
    zone.filter.allowAll = !!on;
    zone.filter.categories.clear();
    zone.filter.defs.clear();
    zone.filter.deny.clear();
  };

  Zones.filterSummary = function (zone) {
    if (!zone || zone.kind !== 'stockpile') return '';
    var f = zone.filter;
    if (f.allowAll && !f.deny.size && !f.categories.size) return 'everything';
    var parts = [];
    CATEGORIES.forEach(function (c) { if (f.categories.has(c)) parts.push(CATEGORY_LABELS[c]); });
    if (f.allowAll) parts.push('everything else');
    f.defs.forEach(function (id) {
      var d = Defs.maybe('thing', id);
      if (d) parts.push(d.label || id);
    });
    if (!parts.length) return 'nothing';
    if (parts.length > 4) return parts.slice(0, 4).join(', ') + ' +' + (parts.length - 4);
    return parts.join(', ');
  };

  /* ============================================================
     STORAGE

     cellRoomFor is the physical question (is there space on this tile),
     Zones.isStorageFor is the whole question a hauler asks about one
     cell, and bestStorageFor is the search across every stockpile.
     ============================================================ */
  function isCargo(def) {
    return def.category === 'item' && !NEVER_STORED[def.id];
  }

  /* The whole list is scanned rather than returned from early, because
     a tile can hold a mergeable stack AND a fire, and the fire is the
     answer whichever order they happen to sit in the array. */
  function cellRoomFor(map, i, def) {
    var list = map.itemGrid[i];
    if (!list || !list.length) return true;
    var occupied = false, room = false;
    for (var k = 0; k < list.length; k++) {
      var t = list[k];
      if (t.defId === 'fire') return false;          /* nothing is stored in a fire */
      if (!isCargo(t.def)) continue;                 /* blood does not fill a tile */
      occupied = true;
      if (t.defId === def.id && t.stack < (def.stackLimit || 1)) room = true;
    }
    return room || !occupied;
  }

  /* A stockpile cell under a wall or in a doorway is not a destination,
     however the player painted it. Everything else that is walkable is
     fair game, including sandbags and floors. */
  function cellUsable(map, x, y) {
    if (!map.passable(x, y)) return false;
    var b = map.buildingAt(x, y);
    return !(b && b.def.building && b.def.building.isDoor);
  }

  /* Targets are read-only here, so one scratch cell target is reused
     rather than allocating one per candidate in the inner loop. */
  var _cellTarget = { k: 'c', x: 0, y: 0 };

  function reservedByOther(map, x, y, pawn) {
    var Res = root.Res;
    if (!Res || !Res.reservedBy) return false;
    _cellTarget.x = x; _cellTarget.y = y;
    var by = Res.reservedBy(map, _cellTarget);
    return !!by && by !== pawn;
  }

  var _reachOpts = { pawn: null, peMode: 0 };

  function reachable(map, ox, oy, x, y, pawn) {
    var Path = root.Path;
    if (!Path || !Path.reachable) return true;
    _reachOpts.pawn = pawn || null;
    _reachOpts.peMode = Path.PE ? Path.PE.ON_CELL : 0;
    return Path.reachable(map, ox, oy, x, y, _reachOpts);
  }

  Zones.isStorageFor = function (map, x, y, thing) {
    if (!map.inBounds(x, y)) return false;
    var def = resolveDef(thing);
    if (!def) return false;
    var zone = Zones.zoneAt(map, x, y);
    if (!Zones.accepts(zone, def)) return false;
    if (!cellUsable(map, x, y)) return false;
    return cellRoomFor(map, map.idx(x, y), def);
  };

  /* The nearest-candidate buffer: a bounded insertion sort, so the
     common case (a cell further away than the current worst) costs one
     comparison and the buffer never allocates. */
  var bufI = new Int32Array(NEAREST), bufD = new Float64Array(NEAREST), bufN = 0;

  function consider(i, d) {
    if (bufN === NEAREST && d >= bufD[NEAREST - 1]) return;
    var pos = bufN < NEAREST ? bufN++ : NEAREST - 1;
    while (pos > 0 && bufD[pos - 1] > d) {
      bufD[pos] = bufD[pos - 1]; bufI[pos] = bufI[pos - 1];
      pos--;
    }
    bufD[pos] = d; bufI[pos] = i;
  }

  function boxDistSq(zone, ox, oy) {
    var dx = zone._minX - ox; if (dx < 0) dx = ox - zone._maxX; if (dx < 0) dx = 0;
    var dy = zone._minY - oy; if (dy < 0) dy = oy - zone._maxY; if (dy < 0) dy = 0;
    return dx * dx + dy * dy;
  }

  function searchTier(map, piles, def, tier, ox, oy, pawn) {
    bufN = 0;
    var w = map.w, z, k, list, i, x, y, dx, dy;
    for (z = 0; z < piles.length; z++) {
      var zone = piles[z];
      if (zone.priority !== tier || !zone.cells.size) continue;
      if (!Zones.accepts(zone, def)) continue;
      bounds(map, zone);
      /* A zone whose nearest possible corner is further than the worst
         candidate already held cannot contribute anything. */
      if (bufN === NEAREST && boxDistSq(zone, ox, oy) >= bufD[NEAREST - 1]) continue;
      list = cellList(zone);
      for (k = 0; k < list.length; k++) {
        i = list[k];
        x = i % w; y = (i - x) / w;
        dx = x - ox; dy = y - oy;
        consider(i, dx * dx + dy * dy);
      }
    }

    for (k = 0; k < bufN; k++) {
      i = bufI[k];
      x = i % w; y = (i - x) / w;
      if (!cellUsable(map, x, y)) continue;
      if (!cellRoomFor(map, i, def)) continue;
      if (reservedByOther(map, x, y, pawn)) continue;
      if (!reachable(map, ox, oy, x, y, pawn)) continue;
      return { x: x, y: y, priority: tier };
    }
    return null;
  }

  /* The priority a thing already enjoys where it lies: -1 when it is
     not in a stockpile that would have it. Everything about "needs
     hauling" is a comparison against this number. */
  Zones.currentPriorityOf = function (map, thing) {
    if (!thing || !thing.spawned) return -1;
    var zone = Zones.zoneAt(map, thing.x, thing.y);
    if (!Zones.accepts(zone, thing.def)) return -1;
    return zone.priority;
  };

  /* opts.minPriority floors the search; omit it and a spawned thing
     only looks for somewhere strictly better than where it already is,
     which is what stops a hauler shuffling a stack between two equal
     stockpiles forever. */
  Zones.bestStorageFor = function (map, thing, pawn, opts) {
    var def = resolveDef(thing);
    if (!def || !Zones.storable(def)) return null;

    var floor = opts && opts.minPriority !== undefined
      ? clampPriority(opts.minPriority)
      : Zones.currentPriorityOf(map, thing) + 1;
    if (floor > MAX_PRIORITY) return null;
    if (floor < MIN_PRIORITY) floor = MIN_PRIORITY;

    var piles = Zones.stockpiles(map);
    if (!piles.length) return null;

    var ox, oy;
    if (pawn) { ox = pawn.x; oy = pawn.y; }
    else if (thing && typeof thing.x === 'number') { ox = thing.x; oy = thing.y; }
    else { ox = map.w >> 1; oy = map.h >> 1; }

    for (var tier = MAX_PRIORITY; tier >= floor; tier--) {
      var hit = searchTier(map, piles, def, tier, ox, oy, pawn || null);
      if (hit) return hit;
    }
    return null;
  };

  function burning(map, x, y) {
    var list = map.itemGrid[map.idx(x, y)];
    if (!list) return false;
    for (var k = 0; k < list.length; k++) if (list[k].defId === 'fire') return true;
    return false;
  }

  function reservedThing(map, thing) {
    var Res = root.Res, T = root.T;
    if (!Res || !Res.reservedBy || !T || !T.thing) return false;
    return !!Res.reservedBy(map, T.thing(thing));
  }

  Zones.shouldHaul = function (map, thing) {
    if (!thing || !thing.spawned) return false;
    if (thing.isBlueprint || thing.isFrame) return false;
    if (!Zones.storable(thing.def)) return false;
    if (burning(map, thing.x, thing.y)) return false;
    if (reservedThing(map, thing)) return false;
    return !!Zones.bestStorageFor(map, thing, null);
  };

  /* Everything loose on the map that wants a stockpile. The haul work
     giver narrows this with Path.closestReachable rather than asking
     for a sorted answer here. */
  Zones.haulables = function (map, limit) {
    var out = [];
    map.things.forEach(function (t) {
      if (limit && out.length >= limit) return;
      if (t.spawned && Zones.shouldHaul(map, t)) out.push(t);
    });
    return out;
  };

  /* ============================================================
     GROWING ZONES
     ============================================================ */
  function sowableTerrain(map, x, y, plantDef) {
    var t = map.terrainAt(x, y);
    if (!t || t.passable === false || t.supportsPlants === false) return false;
    var fert = t.fertility || 0;
    if (fert <= 0) return false;
    return fert >= ((plantDef && plantDef.plant && plantDef.plant.minFertility) || 0);
  }

  function canSow(map, x, y, plantDefId, occupied) {
    var Plants = root.Plants;
    var def = Defs.maybe('thing', plantDefId);
    /* Plants.canSowAt also refuses a cell that already holds a plant,
       which is the wrong answer for "this cell wants sowing once the
       weed on it is cut" - so an occupied cell is judged on its terrain
       alone and the cut job is what unblocks it. */
    if (Plants && Plants.canSowAt && !occupied) return !!Plants.canSowAt(map, x, y, plantDefId);
    return sowableTerrain(map, x, y, def);
  }

  Zones.growingCellsNeedingSow = function (map) {
    /* No clock means no cache: a headless map ticked by a test would
       otherwise hold the very first answer forever. */
    var now = root.Game && typeof root.Game.tick === 'number' ? root.Game.tick : -1;
    var cache = map._zoneSowCache;
    if (now >= 0 && cache && cache.version === version(map) && now - cache.tick < SOW_CACHE_TICKS) {
      return cache.list;
    }

    var out = [], zones = Zones.growingZones(map), w = map.w;
    for (var z = 0; z < zones.length; z++) {
      var zone = zones[z];
      if (!zone.allowSow || !zone.plantDefId) continue;
      var list = cellList(zone);
      for (var k = 0; k < list.length; k++) {
        var i = list[k], x = i % w, y = (i - x) / w;
        var plant = map.plantAt(x, y);
        if (plant && plant.defId === zone.plantDefId) continue;
        if (map.buildingAt(x, y)) continue;
        if (!canSow(map, x, y, zone.plantDefId, !!plant)) continue;
        out.push(i);
      }
    }

    if (now >= 0) map._zoneSowCache = { version: version(map), tick: now, list: out };
    return out;
  };

  /* Cells in a growing zone standing on the wrong plant. plants.js
     finds the ripe ones; these are the ones in the way. */
  Zones.growingCellsNeedingCut = function (map) {
    var out = [], zones = Zones.growingZones(map), w = map.w;
    for (var z = 0; z < zones.length; z++) {
      var zone = zones[z];
      if (!zone.allowCut) continue;
      var list = cellList(zone);
      for (var k = 0; k < list.length; k++) {
        var i = list[k], x = i % w;
        var plant = map.plantAt(x, (i - x) / w);
        if (plant && plant.defId !== zone.plantDefId) out.push(i);
      }
    }
    return out;
  };

  Zones.plantOfZoneAt = function (map, x, y) {
    var zone = Zones.zoneAt(map, x, y);
    return zone && zone.kind === 'growing' ? zone.plantDefId : null;
  };

  /* ============================================================
     SAVE / LOAD
     ============================================================ */
  function setToArray(s) {
    var out = [];
    s.forEach(function (v) { out.push(v); });
    return out;
  }

  function zoneToData(zone) {
    return {
      id: zone.id,
      kind: zone.kind,
      label: zone.label,
      priority: zone.priority,
      color: zone.color,
      plantDefId: zone.plantDefId,
      allowSow: zone.allowSow,
      allowCut: zone.allowCut,
      cells: cellList(zone).slice(),
      filter: {
        allowAll: zone.filter.allowAll,
        categories: setToArray(zone.filter.categories),
        defs: setToArray(zone.filter.defs),
        deny: setToArray(zone.filter.deny)
      }
    };
  }

  /* Takes a map (every zone on it) or a single zone, because save.js
     may reasonably ask for either. */
  Zones.serialize = function (mapOrZone) {
    if (!mapOrZone) return [];
    if (mapOrZone instanceof Zone) return zoneToData(mapOrZone);
    return mapOrZone.zones.map(zoneToData);
  };

  Zones.deserialize = function (map, data) {
    if (!map || !data) return [];
    var rows = data.length === undefined ? [data] : data;

    /* A load replaces the board rather than merging into it. */
    map.zoneId.fill(0);
    map.zones.length = 0;
    touch(map);

    var made = [];
    for (var k = 0; k < rows.length; k++) {
      var row = rows[k];
      if (!row || (row.kind !== 'stockpile' && row.kind !== 'growing')) continue;
      var zone = new Zone(row.kind, row);
      claim(map, zone, row.cells);
      if (!zone.label) zone.label = nextLabel(map, zone.kind);
      if (!zone.color) zone.color = pickColor(map, zone.kind);
      map.zones.push(zone);
      made.push(zone);
    }
    touch(map);
    return made;
  };

  /* Aliases, because the world/research modules in this codebase spell
     the same pair save/load. */
  Zones.save = Zones.serialize;
  Zones.load = Zones.deserialize;

  /* ============================================================
     VALIDATION - for tools/, and for anyone who suspects the grid and
     the sets have drifted apart.
     ============================================================ */
  Zones.validate = function (map) {
    var errors = [], seen = {}, counted = 0;

    map.zones.forEach(function (zone) {
      var at = 'zone ' + zone.id + ' (' + zone.label + ')';
      if (seen[zone.id]) errors.push(at + ' has a duplicate id');
      seen[zone.id] = true;
      if (zone.kind !== 'stockpile' && zone.kind !== 'growing') errors.push(at + ' has kind ' + zone.kind);
      if (zone.priority < MIN_PRIORITY || zone.priority > MAX_PRIORITY) {
        errors.push(at + ' has priority ' + zone.priority);
      }
      if (!zone.cells.size) errors.push(at + ' has no cells');
      if (zone.deleted) errors.push(at + ' is deleted but still listed');

      zone.cells.forEach(function (i) {
        counted++;
        if (i < 0 || i >= map.size) { errors.push(at + ' holds out-of-bounds cell ' + i); return; }
        if (map.zoneId[i] !== zone.id) {
          errors.push(at + ' holds cell ' + i + ' but map.zoneId says ' + map.zoneId[i]);
        }
      });

      if (zone.kind === 'stockpile') {
        zone.filter.categories.forEach(function (c) {
          if (CATEGORIES.indexOf(c) < 0) errors.push(at + ' filters unknown category ' + c);
        });
        zone.filter.defs.forEach(function (d) {
          if (!Defs.has('thing', d)) errors.push(at + ' allows unknown thing ' + d);
        });
        zone.filter.deny.forEach(function (d) {
          if (!Defs.has('thing', d)) errors.push(at + ' denies unknown thing ' + d);
        });
      } else {
        var p = zone.plantDefId ? Defs.maybe('thing', zone.plantDefId) : null;
        if (!p) errors.push(at + ' grows unknown plant ' + zone.plantDefId);
        else if (!p.plant || !p.plant.sowable) errors.push(at + ' grows unsowable ' + zone.plantDefId);
      }
    });

    var stray = 0;
    for (var i = 0; i < map.size; i++) {
      var id = map.zoneId[i];
      if (!id) continue;
      stray++;
      var zone = Zones.byId(map, id);
      if (!zone) errors.push('cell ' + i + ' points at missing zone ' + id);
      else if (!zone.cells.has(i)) errors.push('cell ' + i + ' claims zone ' + id + ' which disowns it');
    }
    if (stray !== counted) {
      errors.push('map.zoneId marks ' + stray + ' cells but the zones hold ' + counted);
    }
    return errors;
  };

  root.Zone = Zone;
  root.Zones = Zones;
})(this);
