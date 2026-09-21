/* ============================================================
   policies.js - the colony management layer.

   A colony of three plays itself. A colony of twelve does not: by
   then the player is not deciding what each colonist does, they are
   deciding what each colonist is ALLOWED to do, and everything in
   this file is a way of saying that once instead of twelve times.

   Seven standing answers live here - where a pawn may walk, what
   they may wear, what they may eat, what they may take, how well
   they get patched up, which hours are theirs, and which filter sets
   the player refuses to click through a second time - plus the two
   things that make those answers survive contact with a growing
   colony: assignment to a whole group at once, and standing rules
   that shout when the colony drifts out of the shape the player
   asked for.

   Nothing here draws. ui.js owns every pixel; this file owns the
   answers and hands them over on request.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  function sys(name) { return root[name] || null; }

  function now() {
    var G = root.Game;
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  function mapOf(x) {
    if (!x) return null;
    if (x.pawns && typeof x.w === 'number') return x;
    if (x.map) return x.map;
    var G = root.Game;
    return G ? G.map : null;
  }

  function debug(text) {
    var G = root.Game;
    if (G && G.debug && typeof console !== 'undefined') console.log('[policies] ' + text);
  }

  var TICKS_PER_DAY = 60000;

  /* How often a single pawn is re-examined. The systems registry drives
     this file on the 500-tick slow beat today and could drive it per
     pawn tomorrow, so the interval is enforced per pawn rather than
     assumed from the caller's cadence. */
  var PAWN_INTERVAL = 200;

  /* Home is rebuilt from what the colony has actually built, which is a
     walk over the building index and is not worth doing often. */
  var HOME_INTERVAL = 5000;

  /* A pawn whose meal was refused is left alone for this long, so a
     policy that turns out to be unsatisfiable costs one interrupted
     walk rather than an endless loop of them. */
  var FOOD_BLOCK_COOLDOWN = 1200;

  var AREA_LIMIT = 8;            /* one bit each, in a Uint8 mask grid */
  var CARE = ['none', 'herbal', 'normal', 'best'];
  var SCHEDULE_KINDS = ['anything', 'work', 'recreation', 'sleep'];
  var CARE_GROUPS = ['colonist', 'prisoner', 'animal', 'slave', 'guest'];

  var Policies = {};
  Policies.AREA_LIMIT = AREA_LIMIT;
  Policies.CARE = CARE;
  Policies.SCHEDULE_KINDS = SCHEDULE_KINDS;
  Policies.CARE_GROUPS = CARE_GROUPS;
  Policies.alerts = [];

  /* ============================================================
     1. STATE

     One object so that save, load and reset are each one assignment
     rather than a list somebody will forget to extend.
     ============================================================ */

  function blankState() {
    return {
      areas: [],
      outfits: [],
      foods: [],
      drugs: [],
      stockpilePresets: [],
      billPresets: [],
      rules: [],
      careDefaults: { colonist: 2, prisoner: 1, animal: 1, slave: 1, guest: 2 },
      nextId: 1,
      grid: null, gridW: 0, gridH: 0, gridDirty: true,
      homeAuto: true, homeTick: -HOME_INTERVAL,
      ruleState: {},
      pawnBeat: {}
    };
  }

  var st = blankState();

  function nextId() { return st.nextId++; }

  /* ============================================================
     2. THE DEFAULT CONTENT

     Everything is data-driven off the def registry rather than off a
     hard-coded list of six apparel ids, because other files add
     apparel and food of their own and a policy that cannot see them
     is a policy that quietly forbids them.
     ============================================================ */

  var _apparelDefs = null;
  Policies.apparelDefs = function () {
    if (_apparelDefs) return _apparelDefs;
    _apparelDefs = Defs.all('thing').filter(function (d) {
      return !!d.apparel && d.category === 'item';
    });
    return _apparelDefs;
  };

  var _foodDefs = null;
  Policies.foodDefs = function () {
    if (_foodDefs) return _foodDefs;
    var N = sys('Needs');
    _foodDefs = Defs.all('thing').filter(function (d) {
      if (d.category !== 'item' || d.id === 'corpse') return false;
      var n = (N && N.nutritionOf) ? N.nutritionOf(d) : d.nutrition;
      return n > 0;
    });
    return _foodDefs;
  };

  function isMeal(def) { return def.foodType === 'meal'; }

  /* Armour is heavy, slow and worth money; a hauler in a flak vest is
     a hauler who walks slower for nothing. That is the whole reason
     outfits exist, so it is the split the defaults are built on. */
  function isArmour(def) {
    var a = def.apparel || {};
    return (a.armorSharp || 0) >= 0.15 || (a.armorBlunt || 0) >= 0.12;
  }

  function defaultOutfits() {
    var apparel = Policies.apparelDefs();
    var worker = [], soldier = [];
    apparel.forEach(function (d) {
      soldier.push(d.id);
      if (!isArmour(d)) worker.push(d.id);
    });
    return [
      { id: 'anything', label: 'Anything', builtIn: true, allowAll: true, allow: [], deny: [] },
      { id: 'worker', label: 'Worker', builtIn: true, allowAll: false, allow: worker, deny: [] },
      { id: 'soldier', label: 'Soldier', builtIn: true, allowAll: false, allow: soldier, deny: [] },
      { id: 'nudist', label: 'Nudist', builtIn: true, allowAll: false, allow: [], deny: [] }
    ];
  }

  function defaultFoodPolicies() {
    var food = Policies.foodDefs();
    var noFine = [], rawOnly = [], rations = [];
    food.forEach(function (d) {
      if (d.id !== 'mealFine') noFine.push(d.id);
      if (!isMeal(d)) rawOnly.push(d.id);
      if (!isMeal(d) || d.id === 'mealSimple') rations.push(d.id);
    });
    return [
      { id: 'anything', label: 'Anything', builtIn: true, allowAll: true, allow: [], deny: [] },
      { id: 'simple', label: 'No fine meals', builtIn: true, allowAll: false, allow: noFine, deny: [] },
      { id: 'raw', label: 'Raw only', builtIn: true, allowAll: false, allow: rawOnly, deny: [] },
      { id: 'rations', label: 'Prisoner rations', builtIn: true, allowAll: false, allow: rations, deny: [] }
    ];
  }

  /* A drug entry is a rule about ONE drug. drugs.js owns what the drug
     does; this owns when a colonist is allowed to reach for it.
       never        - not without a direct order
       addiction    - only to hold off withdrawal
       mood         - when mood drops below moodBelow and joy is spent
       pain         - when pain is above painAbove
       schedule     - one dose every everyDays, as a regimen
       beforeFight  - only when hostiles are on the map                */
  function entry(drugId, mode, over) {
    var e = {
      drugId: drugId, mode: mode,
      moodBelow: 0.34, painAbove: 0.25, joyBelow: 0.45, everyDays: 1
    };
    if (over) { for (var k in over) if (over.hasOwnProperty(k)) e[k] = over[k]; }
    return e;
  }

  function defaultDrugPolicies() {
    return [
      {
        id: 'none', label: 'No drugs', builtIn: true,
        entries: [], dosesPerDay: 0
      },
      {
        id: 'social', label: 'Social relaxant', builtIn: true, dosesPerDay: 2,
        entries: [
          entry('beer', 'mood', { moodBelow: 0.36 }),
          entry('smokeleafJoint', 'mood', { moodBelow: 0.30 }),
          entry('psychiteTea', 'mood', { moodBelow: 0.28 }),
          entry('painkiller', 'pain', { painAbove: 0.22 })
        ]
      },
      {
        id: 'combat', label: 'Combat drugs', builtIn: true, dosesPerDay: 2,
        entries: [
          entry('goJuice', 'beforeFight'),
          entry('painkiller', 'pain', { painAbove: 0.20 })
        ]
      },
      {
        id: 'addictionOnly', label: 'Feed addictions only', builtIn: true, dosesPerDay: 3,
        entries: [
          entry('beer', 'addiction'), entry('smokeleafJoint', 'addiction'),
          entry('psychiteTea', 'addiction'), entry('yayo', 'addiction'),
          entry('flake', 'addiction'), entry('goJuice', 'addiction'),
          entry('wakeUp', 'addiction'), entry('luciferium', 'schedule', { everyDays: 0.9 })
        ]
      },
      {
        id: 'prophylactic', label: 'Prophylactic', builtIn: true, dosesPerDay: 1,
        entries: [entry('penoxycyline', 'schedule', { everyDays: 5 })]
      }
    ];
  }

  function defaultRules() {
    return [
      { id: 'r_meals', kind: 'stockMin', defId: 'mealSimple', count: 12, enabled: true,
        label: 'Keep 12 meals in store' },
      { id: 'r_wood', kind: 'stockMin', defId: 'wood', count: 200, enabled: true,
        label: 'Never let wood fall below 200' },
      { id: 'r_medicine', kind: 'stockMin', defId: 'medicine', count: 6, enabled: true,
        label: 'Keep 6 medicine' },
      { id: 'r_doctors', kind: 'workers', workType: 'doctor', minSkill: 3, count: 2, enabled: true,
        label: 'Two colonists able to doctor' },
      { id: 'r_cooks', kind: 'workers', workType: 'cook', minSkill: 2, count: 1, enabled: true,
        label: 'Somebody who can cook' }
    ];
  }

  /* The day the balance table describes, plus the four shapes a player
     actually paints by hand often enough to deserve a button. */
  var SCHEDULE_PRESETS = [
    { id: 'default', label: 'Default', kindAt: function (h) {
      if (h >= 22 || h < 6) return 'sleep';
      if (h >= 20) return 'recreation';
      return 'work';
    } },
    { id: 'nightOwl', label: 'Night owl', kindAt: function (h) {
      if (h >= 2 && h < 10) return 'sleep';
      if (h >= 10 && h < 12) return 'recreation';
      return 'work';
    } },
    { id: 'hardWorker', label: 'Hard worker', kindAt: function (h) {
      if (h >= 23 || h < 6) return 'sleep';
      if (h === 22) return 'recreation';
      return 'work';
    } },
    { id: 'relaxed', label: 'Relaxed', kindAt: function (h) {
      if (h >= 21 || h < 8) return 'sleep';
      if (h >= 17) return 'recreation';
      return 'work';
    } },
    { id: 'anything', label: 'Anything', kindAt: function () { return 'anything'; } }
  ];
  Policies.SCHEDULE_PRESETS = SCHEDULE_PRESETS;

  Policies.schedulePreset = function (id) {
    for (var i = 0; i < SCHEDULE_PRESETS.length; i++) {
      if (SCHEDULE_PRESETS[i].id === id) return SCHEDULE_PRESETS[i];
    }
    return null;
  };

  /* ============================================================
     3. BOOTSTRAP

     Content is built on first use rather than at load: the def
     tables below this file in the load order are complete by then,
     and a colony that never opens the Assign tab never pays for it.
     ============================================================ */

  var booted = false;

  function boot() {
    if (booted) return;
    booted = true;
    st.areas = [
      { id: 1, bit: 0, label: 'Home area', builtIn: 'home', color: '#ffc23c', cells: [] }
    ];
    st.outfits = defaultOutfits();
    st.foods = defaultFoodPolicies();
    st.drugs = defaultDrugPolicies();
    st.rules = defaultRules();
    st.nextId = 100;
    st.gridDirty = true;
  }

  Policies.reset = function () {
    st = blankState();
    booted = false;
    Policies.alerts = [];
    boot();
    return Policies;
  };

  /* ============================================================
     4. ALLOWED AREAS

     An area is a painted mask. The masks are held as one Uint8 grid
     with a bit per area, so "is this pawn allowed on this cell" is a
     bounds check and a bitwise and - which matters, because the
     pathfinder would ask it once per expanded node.

     The authoritative copy is each area's sorted cell list, because
     that is what saves, what the UI paints into and what a walk-home
     job searches. The grid is a cache rebuilt from those lists.
     ============================================================ */

  function gridFor(map) {
    if (!map) return null;
    if (!st.grid || st.gridW !== map.w || st.gridH !== map.h) {
      st.gridW = map.w; st.gridH = map.h;
      st.grid = new Uint8Array(map.w * map.h);
      st.gridDirty = true;
    }
    if (st.gridDirty) rebuildGrid();
    return st.grid;
  }

  function rebuildGrid() {
    var g = st.grid;
    if (!g) return;
    g.fill(0);
    for (var a = 0; a < st.areas.length; a++) {
      var area = st.areas[a], mask = 1 << area.bit, cells = area.cells;
      for (var i = 0; i < cells.length; i++) {
        var c = cells[i];
        if (c >= 0 && c < g.length) g[c] |= mask;
      }
    }
    st.gridDirty = false;
  }

  Policies.areas = function () { boot(); return st.areas; };

  Policies.area = function (id) {
    boot();
    for (var i = 0; i < st.areas.length; i++) if (st.areas[i].id === id) return st.areas[i];
    return null;
  };

  Policies.homeArea = function () {
    boot();
    for (var i = 0; i < st.areas.length; i++) if (st.areas[i].builtIn === 'home') return st.areas[i];
    return null;
  };

  /* Eight bits, eight areas. The limit is stated rather than grown
     because a ninth area would double the grid and no colony in this
     game has ever needed one. */
  Policies.addArea = function (label, opts) {
    boot();
    opts = opts || {};
    var used = 0, i;
    for (i = 0; i < st.areas.length; i++) used |= 1 << st.areas[i].bit;
    var bit = -1;
    for (i = 0; i < AREA_LIMIT; i++) if (!(used & (1 << i))) { bit = i; break; }
    if (bit < 0) return null;
    var area = {
      id: nextId(), bit: bit, label: label || ('Area ' + (st.areas.length + 1)),
      builtIn: null, color: opts.color || '#4a7fd4', cells: []
    };
    st.areas.push(area);
    st.gridDirty = true;
    return area;
  };

  Policies.removeArea = function (id) {
    var area = Policies.area(id);
    if (!area || area.builtIn) return false;
    U.remove(st.areas, area);
    st.gridDirty = true;
    /* Anybody restricted to it becomes unrestricted rather than
       becoming stuck on a mask that no longer exists. */
    var map = root.Game && root.Game.map;
    if (map) {
      for (var i = 0; i < map.pawns.length; i++) {
        var rec = map.pawns[i].policy;
        if (rec && rec.areaId === id) rec.areaId = 0;
      }
    }
    return true;
  };

  Policies.renameArea = function (id, label) {
    var area = Policies.area(id);
    if (!area || !label) return false;
    area.label = label;
    return true;
  };

  function cellIndex(map, c) {
    if (typeof c === 'number') return c;
    if (Array.isArray(c)) return map.idx(c[0], c[1]);
    if (c && typeof c.x === 'number') return map.idx(c.x, c.y);
    return -1;
  }

  /* The UI paints with a drag, so this takes a batch and sorts once. */
  Policies.paintArea = function (id, map, cells, on) {
    var area = Policies.area(id);
    if (!area || !map || !cells) return false;
    var have = Object.create(null), i, c;
    for (i = 0; i < area.cells.length; i++) have[area.cells[i]] = 1;
    for (i = 0; i < cells.length; i++) {
      c = cellIndex(map, cells[i]);
      if (c < 0 || c >= map.size) continue;
      if (on === false) delete have[c];
      else have[c] = 1;
    }
    var out = [];
    for (var k in have) out.push(+k);
    out.sort(function (a, b) { return a - b; });
    area.cells = out;
    st.gridDirty = true;
    return true;
  };

  Policies.areaCells = function (id) {
    var area = Policies.area(id);
    return area ? area.cells : [];
  };

  Policies.inArea = function (id, map, x, y) {
    var area = Policies.area(id);
    if (!area || !map || !map.inBounds(x, y)) return false;
    var g = gridFor(map);
    return !!(g[y * map.w + x] & (1 << area.bit));
  };

  Policies.isHome = function (map, x, y) {
    var home = Policies.homeArea();
    if (!home) return true;
    /* An unpainted home area means the colony has not drawn its
       boundary yet, and "clean nowhere" is a worse default than
       "clean everywhere". */
    if (!home.cells.length) return true;
    return Policies.inArea(home.id, map, x, y);
  };

  /* The home area is maintained rather than painted: whatever the
     colony has built, plus its zones, plus a one-tile apron, is what
     the player means by "here". A player edit sets homeAuto false and
     this stops touching it. */
  Policies.autoHome = function (map) {
    boot();
    if (!map || !st.homeAuto) return false;
    var home = Policies.homeArea();
    if (!home) return false;

    var seen = Object.create(null), out = [];
    function mark(x, y) {
      if (!map.inBounds(x, y)) return;
      var i = y * map.w + x;
      if (seen[i]) return;
      seen[i] = 1;
      out.push(i);
    }
    function apron(x, y) {
      mark(x, y);
      for (var k = 0; k < U.ADJ8.length; k++) mark(x + U.ADJ8[k][0], y + U.ADJ8[k][1]);
    }

    var buildings = Defs.buildings(), i, j;
    for (i = 0; i < buildings.length; i++) {
      var list = map.byDef(buildings[i].id);
      for (j = 0; j < list.length; j++) {
        var t = list[j];
        if (!t.spawned || t.faction !== 'player') continue;
        apron(t.x, t.y);
      }
    }
    for (i = 0; i < (map.zones || []).length; i++) {
      var zone = map.zones[i];
      if (!zone || !zone.cells) continue;
      zone.cells.forEach(function (c) { apron(map.xOf(c), map.yOf(c)); });
    }

    out.sort(function (a, b) { return a - b; });
    home.cells = out;
    st.gridDirty = true;
    return true;
  };

  Policies.setHomeAuto = function (on) { st.homeAuto = !!on; return st.homeAuto; };

  /* ---------- the per-pawn record ----------
     A plain object hung on the pawn, which is exactly what save.js
     carries: no Maps, no Sets, no references. */
  function record(pawn) {
    if (!pawn) return null;
    var rec = pawn.policy;
    if (rec && typeof rec === 'object') return rec;
    boot();
    rec = {
      areaId: 0,
      outfitId: 'anything',
      foodId: 'anything',
      drugId: 'none',
      care: -1,                 /* -1 means "use the group default"   */
      ops: { surgery: true, prosthetics: true, harvestOrgans: false, euthanasia: false },
      autoAssigned: false,
      lastDose: {},             /* drugId -> tick, for scheduled doses */
      blockedFoodUntil: 0
    };
    pawn.policy = rec;
    return rec;
  }
  Policies.policyOf = record;

  Policies.areaOf = function (pawn) {
    var rec = record(pawn);
    if (!rec || !rec.areaId) return null;
    return Policies.area(rec.areaId);
  };

  /* The question pathfind.js and workgivers.js should be asking. Kept
     to a bounds test and a bitwise and for that reason. */
  Policies.allowedAt = function (pawn, x, y) {
    if (!pawn || !pawn.map) return true;
    var rec = pawn.policy;
    if (!rec || !rec.areaId) return true;
    var area = Policies.area(rec.areaId);
    if (!area || !area.cells.length) return true;
    var map = pawn.map;
    if (!map.inBounds(x, y)) return false;
    var g = gridFor(map);
    return !!(g[y * map.w + x] & (1 << area.bit));
  };

  Policies.allowedIdx = function (pawn, i) {
    if (!pawn || !pawn.map) return true;
    var rec = pawn.policy;
    if (!rec || !rec.areaId) return true;
    var area = Policies.area(rec.areaId);
    if (!area || !area.cells.length) return true;
    var g = gridFor(pawn.map);
    return i >= 0 && i < g.length && !!(g[i] & (1 << area.bit));
  };

  Policies.restricted = function (pawn) {
    var area = Policies.areaOf(pawn);
    return !!(area && area.cells.length);
  };

  Policies.setArea = function (pawn, areaId) {
    var rec = record(pawn);
    if (!rec) return false;
    rec.areaId = areaId | 0;
    /* A restriction the player just imposed has to bite now, not when
       the current haul happens to finish - the whole point of pulling
       an area up mid-raid is that it takes effect mid-raid. */
    if (pawn.job && !Policies.allowedAt(pawn, pawn.x, pawn.y)) {
      var J = sys('Jobs');
      if (J && J.end) J.end(pawn, 'interrupted');
    }
    return true;
  };

  /* Somewhere inside the area this pawn can actually stand. Searched
     outward from the pawn first, because the answer is nearly always
     a few tiles away and walking the whole area list is not free. */
  Policies.nearestAllowedCell = function (pawn) {
    var area = Policies.areaOf(pawn);
    if (!area || !area.cells.length || !pawn.map) return null;
    var map = pawn.map, g = gridFor(map), mask = 1 << area.bit;

    var ring = U.cellsInRadius(pawn.x, pawn.y, 12);
    for (var r = 0; r < ring.length; r++) {
      var x = ring[r][0], y = ring[r][1];
      if (!map.inBounds(x, y)) continue;
      if (!(g[y * map.w + x] & mask)) continue;
      if (!map.passable(x, y)) continue;
      return { x: x, y: y };
    }

    /* Nothing nearby: sample the area rather than walk it, and let the
       pathfinder's own area check throw out what it cannot reach. */
    var Path = sys('Path');
    var cells = area.cells, step = Math.max(1, Math.ceil(cells.length / 60));
    var cands = [];
    for (var i = 0; i < cells.length; i += step) {
      var cx = map.xOf(cells[i]), cy = map.yOf(cells[i]);
      if (map.passable(cx, cy)) cands.push({ x: cx, y: cy });
    }
    if (!cands.length) return null;
    if (!Path || !Path.closestReachable) return cands[0];
    return Path.closestReachable(map, pawn, cands, function (c, d) { return -d; });
  };

  /* The panic button: put everybody inside the named area at once.
     This is how a player answers a toxic fallout or keeps the cooks
     out of a firefight, and it is one call because at twelve
     colonists it has to be. */
  Policies.recallAll = function (map, areaId, filter) {
    map = mapOf(map);
    if (!map) return 0;
    var list = map.colonists(), n = 0;
    for (var i = 0; i < list.length; i++) {
      if (filter && !filter(list[i])) continue;
      Policies.setArea(list[i], areaId);
      n++;
    }
    if (n) {
      var area = Policies.area(areaId);
      var G = root.Game;
      if (G && G.msg) G.msg(n + ' colonists restricted to ' + (area ? area.label : 'unrestricted') + '.');
    }
    return n;
  };

  /* ============================================================
     5. OUTFITS

     A filter over apparel defs, and two questions asked of it: is
     the pawn wearing something they should not be, and is there
     something on the floor they should be wearing.
     ============================================================ */

  function findIn(list, id) {
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function filterAllows(policy, defId) {
    if (!policy) return true;
    if (policy.deny && policy.deny.indexOf(defId) >= 0) return false;
    if (policy.allow && policy.allow.indexOf(defId) >= 0) return true;
    return !!policy.allowAll;
  }

  function setFilterDef(policy, defId, on) {
    if (!policy) return false;
    U.remove(policy.allow, defId);
    U.remove(policy.deny, defId);
    if (on) policy.allow.push(defId);
    else policy.deny.push(defId);
    return true;
  }

  Policies.outfits = function () { boot(); return st.outfits; };
  Policies.outfit = function (id) { boot(); return findIn(st.outfits, id); };

  Policies.addOutfit = function (label, from) {
    boot();
    var base = from ? Policies.outfit(from) : null;
    var o = {
      id: 'outfit' + nextId(), label: label || 'New outfit', builtIn: false,
      allowAll: base ? base.allowAll : false,
      allow: base ? base.allow.slice() : [],
      deny: base ? base.deny.slice() : []
    };
    st.outfits.push(o);
    return o;
  };

  Policies.removeOutfit = function (id) {
    var o = Policies.outfit(id);
    if (!o || o.builtIn) return false;
    U.remove(st.outfits, o);
    return true;
  };

  Policies.setOutfitDef = function (id, defId, on) {
    return setFilterDef(Policies.outfit(id), defId, on);
  };

  Policies.setOutfitAll = function (id, on) {
    var o = Policies.outfit(id);
    if (!o) return false;
    o.allowAll = !!on;
    o.allow.length = 0;
    o.deny.length = 0;
    return true;
  };

  Policies.outfitOf = function (pawn) {
    var rec = record(pawn);
    return rec ? Policies.outfit(rec.outfitId) : null;
  };

  Policies.setOutfit = function (pawn, id) {
    var rec = record(pawn);
    if (!rec || !Policies.outfit(id)) return false;
    rec.outfitId = id;
    return true;
  };

  Policies.outfitAllows = function (pawn, defOrId) {
    var defId = typeof defOrId === 'string' ? defOrId
      : (defOrId && (defOrId.defId || (defOrId.id && defOrId.defCategory === 'thing' && defOrId.id)));
    if (!defId && defOrId && defOrId.def) defId = defOrId.def.id;
    if (!defId) return true;
    var o = Policies.outfitOf(pawn);
    if (!o) return true;
    return filterAllows(o, defId);
  };

  /* Worn, but not allowed. Armour is the exception nobody wants
     enforced mid-fight: a colonist who strips their vest because the
     player switched them back to Worker while raiders are on the map
     is a colonist the player just killed. */
  Policies.wantsToDrop = function (pawn) {
    if (!pawn || !Array.isArray(pawn.apparel) || !pawn.apparel.length) return null;
    var o = Policies.outfitOf(pawn);
    if (!o || o.allowAll) return null;
    for (var i = 0; i < pawn.apparel.length; i++) {
      var worn = pawn.apparel[i];
      if (!worn || !worn.def) continue;
      if (filterAllows(o, worn.def.id)) continue;
      if (isArmour(worn.def) && hostilesNear(pawn.map)) continue;
      return worn;
    }
    return null;
  };

  function slotsTaken(pawn) {
    var taken = Object.create(null);
    var list = pawn.apparel || [];
    for (var i = 0; i < list.length; i++) {
      var slots = (list[i].def && list[i].def.apparel && list[i].def.apparel.slots) || [];
      for (var k = 0; k < slots.length; k++) taken[slots[k]] = list[i];
    }
    return taken;
  }

  /* An allowed piece of apparel on the floor that fills a slot the
     pawn has nothing in. Deliberately not "an upgrade": swapping a
     shirt for a marginally better shirt is a colonist who spends the
     day undressing. */
  Policies.wantsToWear = function (pawn) {
    if (!pawn || !pawn.map || pawn.isHuman !== true) return null;
    var o = Policies.outfitOf(pawn);
    if (!o) return null;
    var map = pawn.map, taken = slotsTaken(pawn);
    var Res = sys('Res'), T = sys('T'), Path = sys('Path');
    var apparel = Policies.apparelDefs(), cands = [];

    for (var d = 0; d < apparel.length; d++) {
      var def = apparel[d];
      if (!filterAllows(o, def.id)) continue;
      var slots = (def.apparel && def.apparel.slots) || [];
      var fills = false;
      for (var s = 0; s < slots.length; s++) if (!taken[slots[s]]) { fills = true; break; }
      if (!fills) continue;

      var list = map.byDef(def.id);
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t.spawned || t.isBlueprint || t.isFrame) continue;
        if (!Policies.allowedAt(pawn, t.x, t.y)) continue;
        if (Res && T && !Res.canReserve(pawn, T.thing(t), 1)) continue;
        cands.push(t);
      }
    }
    if (!cands.length) return null;
    if (!Path || !Path.closestReachable) return cands[0];
    return Path.closestReachable(map, pawn, cands, function (t, dist) { return -dist; });
  };

  function hostilesNear(map) {
    var G = root.Game;
    if (!map || !G || !G.hostile) return false;
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (p.dead || p.downed) continue;
      if (G.hostile('player', p.faction)) return true;
    }
    return false;
  }
  Policies.hostilesOnMap = hostilesNear;

  /* ============================================================
     6. FOOD RESTRICTIONS
     ============================================================ */

  Policies.foodPolicies = function () { boot(); return st.foods; };
  Policies.foodPolicy = function (id) { boot(); return findIn(st.foods, id); };

  Policies.addFoodPolicy = function (label, from) {
    boot();
    var base = from ? Policies.foodPolicy(from) : null;
    var f = {
      id: 'food' + nextId(), label: label || 'New food policy', builtIn: false,
      allowAll: base ? base.allowAll : false,
      allow: base ? base.allow.slice() : [],
      deny: base ? base.deny.slice() : []
    };
    st.foods.push(f);
    return f;
  };

  Policies.removeFoodPolicy = function (id) {
    var f = Policies.foodPolicy(id);
    if (!f || f.builtIn) return false;
    U.remove(st.foods, f);
    return true;
  };

  Policies.setFoodDef = function (id, defId, on) {
    return setFilterDef(Policies.foodPolicy(id), defId, on);
  };

  Policies.foodOf = function (pawn) {
    var rec = record(pawn);
    return rec ? Policies.foodPolicy(rec.foodId) : null;
  };

  Policies.setFood = function (pawn, id) {
    var rec = record(pawn);
    if (!rec || !Policies.foodPolicy(id)) return false;
    rec.foodId = id;
    return true;
  };

  /* A starving colonist eats whatever is in front of them. A policy
     that can kill somebody is a bug report, not a feature. */
  Policies.foodAllowed = function (pawn, defOrThing) {
    if (!pawn) return true;
    if (pawn.needs && pawn.needs.food < 0.10) return true;
    var def = defOrThing;
    if (typeof def === 'string') def = Defs.maybe('thing', def);
    else if (def && def.defCategory !== 'thing') def = def.def || null;
    if (!def) return true;
    var f = Policies.foodOf(pawn);
    if (!f) return true;
    return filterAllows(f, def.id);
  };

  /* Is there anything this pawn IS allowed to eat within reach? Asked
     before a meal is refused, so a policy nobody can satisfy costs
     nothing instead of costing the colonist their dinner. */
  function allowedFoodExists(pawn) {
    var map = pawn.map;
    if (!map) return false;
    var food = Policies.foodDefs(), Res = sys('Res'), T = sys('T');
    for (var d = 0; d < food.length; d++) {
      if (!Policies.foodAllowed(pawn, food[d])) continue;
      var list = map.byDef(food[d].id);
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t.spawned || t.stack <= 0) continue;
        if (!Policies.allowedAt(pawn, t.x, t.y)) continue;
        if (Res && T && !Res.canReserve(pawn, T.thing(t), 1)) continue;
        return true;
      }
    }
    return false;
  }

  /* ============================================================
     7. DRUG POLICIES

     drugs.js owns the drugs: what they do, what they cost, who is
     addicted. This owns the schedule - which colonist may take what,
     when, and how often - and pushes the parts drugs.js already
     understands down into its own per-pawn override.
     ============================================================ */

  Policies.drugPolicies = function () { boot(); return st.drugs; };
  Policies.drugPolicy = function (id) { boot(); return findIn(st.drugs, id); };

  Policies.addDrugPolicy = function (label, from) {
    boot();
    var base = from ? Policies.drugPolicy(from) : null;
    var p = {
      id: 'drug' + nextId(), label: label || 'New drug policy', builtIn: false,
      dosesPerDay: base ? base.dosesPerDay : 2,
      entries: []
    };
    if (base) {
      for (var i = 0; i < base.entries.length; i++) p.entries.push(entry(
        base.entries[i].drugId, base.entries[i].mode, base.entries[i]));
    }
    st.drugs.push(p);
    return p;
  };

  Policies.removeDrugPolicy = function (id) {
    var p = Policies.drugPolicy(id);
    if (!p || p.builtIn) return false;
    U.remove(st.drugs, p);
    return true;
  };

  Policies.setDrugEntry = function (policyId, drugId, mode, over) {
    var p = Policies.drugPolicy(policyId);
    if (!p) return null;
    for (var i = 0; i < p.entries.length; i++) {
      if (p.entries[i].drugId !== drugId) continue;
      if (!mode || mode === 'never') { p.entries.splice(i, 1); return null; }
      var e = entry(drugId, mode, over);
      p.entries[i] = e;
      return e;
    }
    if (!mode || mode === 'never') return null;
    var made = entry(drugId, mode, over);
    p.entries.push(made);
    return made;
  };

  Policies.drugPolicyOf = function (pawn) {
    var rec = record(pawn);
    return rec ? Policies.drugPolicy(rec.drugId) : null;
  };

  Policies.setDrugPolicy = function (pawn, id) {
    var rec = record(pawn);
    if (!rec || !Policies.drugPolicy(id)) return false;
    rec.drugId = id;
    Policies.syncDrugs(pawn);
    return true;
  };

  Policies.drugAllowed = function (pawn, drugId) {
    var p = Policies.drugPolicyOf(pawn);
    if (!p) return false;
    for (var i = 0; i < p.entries.length; i++) if (p.entries[i].drugId === drugId) return true;
    return false;
  };

  Policies.drugEntry = function (pawn, drugId) {
    var p = Policies.drugPolicyOf(pawn);
    if (!p) return null;
    for (var i = 0; i < p.entries.length; i++) if (p.entries[i].drugId === drugId) return p.entries[i];
    return null;
  };

  /* Translate the named policy into the shape drugs.js already reads,
     so its own self-medication giver obeys the player's schedule
     instead of a second, contradictory set of thresholds. This is the
     ONLY thing this file calls on Drugs besides findDrug, ingest's
     job id, and DRUGS for the list of what exists. */
  Policies.syncDrugs = function (pawn) {
    var D = sys('Drugs');
    if (!D || !D.setPolicy) return false;
    var p = Policies.drugPolicyOf(pawn);
    if (!p) return false;

    var over = {
      allowRecreational: false, allowHard: false, allowPainkillers: false,
      feedAddictions: false, dosesPerDay: p.dosesPerDay || 0,
      moodThreshold: 0, painThreshold: 1, minJoyBefore: 0.45
    };
    var table = D.DRUGS || {};
    for (var i = 0; i < p.entries.length; i++) {
      var e = p.entries[i], def = table[e.drugId];
      if (e.mode === 'addiction') over.feedAddictions = true;
      if (e.mode === 'mood') {
        over.allowRecreational = true;
        if (e.moodBelow > over.moodThreshold) over.moodThreshold = e.moodBelow;
        if (e.joyBelow < over.minJoyBefore) over.minJoyBefore = e.joyBelow;
        if (def && def.hard) over.allowHard = true;
      }
      if (e.mode === 'pain') {
        over.allowPainkillers = true;
        if (e.painAbove < over.painThreshold) over.painThreshold = e.painAbove;
      }
    }
    if (over.painThreshold > 0.99) over.painThreshold = 1;
    D.setPolicy(pawn, over);
    return true;
  };

  /* A dose this file is responsible for handing out: a regimen drug
     whose interval has elapsed, or a combat drug with hostiles on the
     map. Mood and pain are drugs.js's to answer, through the override
     above, because it already has the giver for it. */
  Policies.scheduledDrug = function (pawn) {
    var D = sys('Drugs');
    if (!D || !D.DRUGS) return null;
    if (!pawn || pawn.dead || pawn.downed || pawn.drafted || pawn.mentalState) return null;
    if (pawn.faction !== 'player' || pawn.isHuman !== true) return null;
    var p = Policies.drugPolicyOf(pawn);
    if (!p || !p.entries.length) return null;
    var rec = record(pawn), t = now(), fighting = null;

    for (var i = 0; i < p.entries.length; i++) {
      var e = p.entries[i];
      if (!D.DRUGS[e.drugId]) continue;
      var last = rec.lastDose[e.drugId] || 0;

      if (e.mode === 'schedule') {
        var span = Math.max(0.05, e.everyDays) * TICKS_PER_DAY;
        if (last && t - last < span) continue;
        return { drugId: e.drugId, reason: 'regimen' };
      }
      if (e.mode === 'beforeFight') {
        if (fighting === null) fighting = hostilesNear(pawn.map);
        if (!fighting) continue;
        if (last && t - last < 0.3 * TICKS_PER_DAY) continue;
        if (D.highLevel && D.highLevel(pawn, e.drugId) > 0.05) continue;
        return { drugId: e.drugId, reason: 'before a fight' };
      }
    }
    return null;
  };

  /* A job aimed at a real stack of the scheduled drug, using the job
     drugs.js registers so the ingestion, tolerance and addiction all
     run through its own code. */
  function scheduledDrugJob(pawn) {
    var want = Policies.scheduledDrug(pawn);
    if (!want) return null;
    var D = sys('Drugs'), J = sys('Jobs'), T = sys('T');
    if (!D || !D.findDrug || !J || !J.make || !T || !J.isRegistered || !J.isRegistered('takeDrug')) return null;
    var stack = D.findDrug(pawn, [want.drugId], {});
    if (!stack) return null;
    if (!Policies.allowedAt(pawn, stack.x, stack.y)) return null;
    record(pawn).lastDose[want.drugId] = now();
    return J.make('takeDrug', T.thing(stack), null, { state: { drugId: want.drugId } });
  }

  /* ============================================================
     8. MEDICAL CARE
     ============================================================ */

  Policies.groupOf = function (pawn) {
    if (!pawn) return 'colonist';
    if (pawn.isAnimal) return 'animal';
    if (pawn.prisoner) return 'prisoner';
    if (pawn.slave) return 'slave';
    if (pawn.faction !== 'player') return 'guest';
    return 'colonist';
  };

  Policies.careDefault = function (group) {
    boot();
    var v = st.careDefaults[group];
    return v === undefined ? 2 : v;
  };

  Policies.setCareDefault = function (group, level) {
    boot();
    if (CARE_GROUPS.indexOf(group) < 0) return false;
    st.careDefaults[group] = U.clamp(level | 0, 0, 3);
    return true;
  };

  Policies.careLevel = function (pawn) {
    var rec = record(pawn);
    if (rec && rec.care >= 0) return U.clamp(rec.care | 0, 0, 3);
    return Policies.careDefault(Policies.groupOf(pawn));
  };

  Policies.careLabel = function (pawn) { return CARE[Policies.careLevel(pawn)]; };

  Policies.setCare = function (pawn, level) {
    var rec = record(pawn);
    if (!rec) return false;
    rec.care = level < 0 ? -1 : U.clamp(level | 0, 0, 3);
    return true;
  };

  /* none: no medicine at all, bandages and luck. herbal: herbal only.
     normal: herbal first, the manufactured stuff only when there is no
     herbal left. best: the good stuff, and only the good stuff while
     any remains. */
  Policies.medicineAllowed = function (pawn, defId) {
    var level = Policies.careLevel(pawn);
    if (level <= 0) return false;
    if (defId === 'herbalMedicine') return level >= 1 && level <= 2;
    if (defId === 'medicine') return level >= 2;
    return level >= 2;
  };

  Policies.medicineFor = function (map, doctor, patient) {
    map = mapOf(map);
    if (!map) return null;
    var level = Policies.careLevel(patient);
    if (level <= 0) return null;
    var order = level >= 3 ? ['medicine', 'herbalMedicine'] : ['herbalMedicine', 'medicine'];
    if (level === 1) order = ['herbalMedicine'];
    var Res = sys('Res'), T = sys('T'), Path = sys('Path');

    for (var k = 0; k < order.length; k++) {
      var list = map.byDef(order[k]) || [];
      var best = null, bestD = Infinity;
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t.spawned || t.stack <= 0) continue;
        if (doctor) {
          if (!Policies.allowedAt(doctor, t.x, t.y)) continue;
          if (Res && T && !Res.canReserve(doctor, T.thing(t), 1)) continue;
          if (Path && Path.reachable &&
              !Path.reachable(map, doctor.x, doctor.y, t.x, t.y, { pawn: doctor })) continue;
        }
        var d = doctor ? U.distSq(doctor.x, doctor.y, t.x, t.y) : 0;
        if (d < bestD) { bestD = d; best = t; }
      }
      if (best) return best;
    }
    return null;
  };

  Policies.operationSettings = function (pawn) {
    var rec = record(pawn);
    return rec ? rec.ops : null;
  };

  Policies.setOperationSetting = function (pawn, key, on) {
    var rec = record(pawn);
    if (!rec || !rec.ops || !(key in rec.ops)) return false;
    rec.ops[key] = !!on;
    return true;
  };

  /* medicine.js offers operations; this says which of them the player
     has left standing permission for. Anything it says no to still
     happens when the player queues it by hand - a policy gates the
     colony's own initiative, not the player's orders. */
  Policies.operationAllowed = function (pawn, op) {
    var ops = Policies.operationSettings(pawn);
    if (!ops || !op) return true;
    var kind = op.kind || op.category || '';
    if (kind === 'harvest' || op.harvestsOrgan) return !!ops.harvestOrgans;
    if (kind === 'euthanize' || op.lethal) return !!ops.euthanasia;
    if (kind === 'install' || op.implantId) return !!ops.prosthetics;
    return !!ops.surgery;
  };

  /* ============================================================
     9. SCHEDULES

     The 24-hour strip. It lives on the pawn as a plain array of
     strings because think.js and practice.js already read it there,
     and ui.js already paints it there; this file adds the presets,
     the copy, and a single place that knows what an hour means.
     ============================================================ */

  Policies.scheduleOf = function (pawn) {
    if (!pawn) return null;
    if (!Array.isArray(pawn.schedule) || pawn.schedule.length !== 24) {
      var preset = Policies.schedulePreset(hasTrait(pawn, 'nightOwl') ? 'nightOwl' : 'default');
      var out = [];
      for (var h = 0; h < 24; h++) out.push(preset.kindAt(h));
      pawn.schedule = out;
    }
    return pawn.schedule;
  };

  Policies.setScheduleHour = function (pawn, hour, kind) {
    if (SCHEDULE_KINDS.indexOf(kind) < 0) return false;
    var s = Policies.scheduleOf(pawn);
    if (!s) return false;
    hour = hour | 0;
    if (hour < 0 || hour > 23) return false;
    s[hour] = kind;
    return true;
  };

  Policies.applySchedulePreset = function (pawn, presetId) {
    var preset = Policies.schedulePreset(presetId);
    if (!preset) return false;
    var s = Policies.scheduleOf(pawn);
    for (var h = 0; h < 24; h++) s[h] = preset.kindAt(h);
    return true;
  };

  /* Copy-to-all is the reason the tab is bearable at twelve
     colonists. It takes the list rather than finding one, because the
     UI already knows whether it means everybody or a selection. */
  Policies.copySchedule = function (from, list) {
    var src = Policies.scheduleOf(from);
    if (!src || !list) return 0;
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i] === from) continue;
      var dst = Policies.scheduleOf(list[i]);
      if (!dst) continue;
      for (var h = 0; h < 24; h++) dst[h] = src[h];
      n++;
    }
    return n;
  };

  Policies.scheduleKind = function (pawn, hour) {
    var s = Policies.scheduleOf(pawn);
    if (!s) return 'anything';
    var G = root.Game;
    var h = hour === undefined ? Math.floor(G && G.hour ? G.hour() : 8) : (hour | 0);
    return s[((h % 24) + 24) % 24] || 'anything';
  };

  function hasTrait(pawn, id) {
    return !!(pawn && pawn.traits && pawn.traits.indexOf(id) >= 0);
  }

  /* ============================================================
     10. STOCKPILE AND BILL PRESETS

     A saved set of checkboxes. The player configured a freezer once;
     the second freezer should cost one click, not twenty.
     ============================================================ */

  Policies.stockpilePresets = function () { boot(); return st.stockpilePresets; };

  Policies.captureStockpilePreset = function (zone, label) {
    boot();
    if (!zone || zone.kind !== 'stockpile' || !zone.filter) return null;
    var f = zone.filter;
    var preset = {
      id: 'sp' + nextId(), label: label || (zone.label || 'Stockpile') + ' preset',
      allowAll: !!f.allowAll, priority: zone.priority | 0,
      categories: [], defs: [], deny: []
    };
    if (f.categories && f.categories.forEach) f.categories.forEach(function (c) { preset.categories.push(c); });
    if (f.defs && f.defs.forEach) f.defs.forEach(function (d) { preset.defs.push(d); });
    if (f.deny && f.deny.forEach) f.deny.forEach(function (d) { preset.deny.push(d); });
    st.stockpilePresets.push(preset);
    return preset;
  };

  Policies.applyStockpilePreset = function (zone, presetId) {
    var Z = sys('Zones');
    var preset = findIn(st.stockpilePresets, presetId);
    if (!Z || !preset || !zone || zone.kind !== 'stockpile') return false;
    Z.setAllowAll(zone, preset.allowAll);
    var i;
    for (i = 0; i < preset.categories.length; i++) Z.setFilterCategory(zone, preset.categories[i], true);
    for (i = 0; i < preset.defs.length; i++) Z.setFilterDef(zone, preset.defs[i], true);
    for (i = 0; i < preset.deny.length; i++) Z.setFilterDef(zone, preset.deny[i], false);
    if (Z.setPriority) Z.setPriority(zone, preset.priority);
    else zone.priority = preset.priority;
    return true;
  };

  Policies.removeStockpilePreset = function (id) {
    var p = findIn(st.stockpilePresets, id);
    if (!p) return false;
    U.remove(st.stockpilePresets, p);
    return true;
  };

  Policies.billPresets = function () { boot(); return st.billPresets; };

  Policies.captureBillPreset = function (building, label) {
    boot();
    if (!building || !building.bills || !building.bills.length) return null;
    var preset = {
      id: 'bp' + nextId(), label: label || (building.def && building.def.label) + ' bills',
      benchDefId: building.defId, bills: []
    };
    for (var i = 0; i < building.bills.length; i++) {
      var b = building.bills[i];
      preset.bills.push({
        recipeId: b.recipeId, repeatMode: b.repeatMode, targetCount: b.targetCount,
        suspended: !!b.suspended, ingredientRadius: b.ingredientRadius,
        qualityMin: b.qualityRange ? b.qualityRange.min : 0,
        qualityMax: b.qualityRange ? b.qualityRange.max : 6
      });
    }
    st.billPresets.push(preset);
    return preset;
  };

  Policies.applyBillPreset = function (building, presetId, opts) {
    var P = sys('Production');
    var preset = findIn(st.billPresets, presetId);
    if (!P || !P.addBill || !preset || !building) return 0;
    opts = opts || {};
    if (opts.replace && building.bills && P.removeBill) {
      var old = building.bills.slice();
      for (var k = 0; k < old.length; k++) P.removeBill(building, old[k]);
    }
    var n = 0;
    for (var i = 0; i < preset.bills.length; i++) {
      var spec = preset.bills[i];
      if (P.addBill(building, spec.recipeId, spec)) n++;
    }
    return n;
  };

  Policies.removeBillPreset = function (id) {
    var p = findIn(st.billPresets, id);
    if (!p) return false;
    U.remove(st.billPresets, p);
    return true;
  };

  /* ============================================================
     11. GROUPS AND AUTO-ASSIGNMENT

     Assigning twelve colonists one at a time is the tax this file
     exists to abolish, and a colonist who walks in off a wandering
     event should arrive already sensible.
     ============================================================ */

  Policies.assignGroup = function (pawns, spec) {
    if (!pawns || !spec) return 0;
    var n = 0;
    for (var i = 0; i < pawns.length; i++) {
      var pawn = pawns[i];
      if (!pawn || pawn.dead) continue;
      if (spec.areaId !== undefined) Policies.setArea(pawn, spec.areaId);
      if (spec.outfitId !== undefined) Policies.setOutfit(pawn, spec.outfitId);
      if (spec.foodId !== undefined) Policies.setFood(pawn, spec.foodId);
      if (spec.drugId !== undefined) Policies.setDrugPolicy(pawn, spec.drugId);
      if (spec.care !== undefined) Policies.setCare(pawn, spec.care);
      if (spec.schedulePreset !== undefined) Policies.applySchedulePreset(pawn, spec.schedulePreset);
      n++;
    }
    return n;
  };

  function skill(pawn, id) {
    var s = pawn && pawn.skills && pawn.skills[id];
    return (s && typeof s.level === 'number') ? s.level : 0;
  }

  /* What this colonist obviously is, from what they are good at and
     what they cannot help being. A shooter gets the armour; a
     night owl gets the night; an addict gets a policy that keeps
     them upright instead of one that pretends they are not. */
  Policies.autoAssign = function (pawn, opts) {
    opts = opts || {};
    var rec = record(pawn);
    if (!rec) return false;
    if (rec.autoAssigned && !opts.force) return false;
    rec.autoAssigned = true;

    var fighter = Math.max(skill(pawn, 'shooting'), skill(pawn, 'melee'));
    var worker = Math.max(skill(pawn, 'construction'), skill(pawn, 'mining'),
      skill(pawn, 'plants'), skill(pawn, 'crafting'));
    if (hasTrait(pawn, 'brawler') || hasTrait(pawn, 'triggerHappy') ||
        hasTrait(pawn, 'carefulShooter') || fighter >= worker + 3) {
      rec.outfitId = 'soldier';
    } else {
      rec.outfitId = 'worker';
    }

    /* Ascetics do not want the good meal, and saying so up front is
       cheaper than the mood hit later. */
    rec.foodId = hasTrait(pawn, 'ascetic') ? 'simple' : 'anything';

    var D = sys('Drugs');
    var addicted = !!(D && D.isAddicted && D.isAddicted(pawn));
    if (addicted) rec.drugId = 'addictionOnly';
    else if (hasTrait(pawn, 'psychopath') || hasTrait(pawn, 'volatile')) rec.drugId = 'social';
    else rec.drugId = 'none';

    /* A doctor is worth the good medicine: they are the one who runs
       out of hit points last and the one everybody else needs alive. */
    rec.care = skill(pawn, 'medicine') >= 8 ? 3 : -1;

    Policies.applySchedulePreset(pawn, hasTrait(pawn, 'nightOwl') ? 'nightOwl'
      : (hasTrait(pawn, 'industrious') ? 'hardWorker'
        : (hasTrait(pawn, 'lazy') || hasTrait(pawn, 'slothful') ? 'relaxed' : 'default')));

    Policies.syncDrugs(pawn);
    return true;
  };

  Policies.summary = function (pawn) {
    var rec = record(pawn);
    if (!rec) return '';
    var area = Policies.area(rec.areaId);
    var o = Policies.outfit(rec.outfitId), f = Policies.foodPolicy(rec.foodId);
    var d = Policies.drugPolicy(rec.drugId);
    return [
      'area ' + (area ? area.label : 'unrestricted'),
      'outfit ' + (o ? o.label : '?'),
      'food ' + (f ? f.label : '?'),
      'drugs ' + (d ? d.label : '?'),
      'care ' + Policies.careLabel(pawn)
    ].join(', ');
  };

  /* ============================================================
     12. STANDING COLONY RULES

     The things a player otherwise tracks in their head all session.
     A rule is data; checking it is a count; a violation is an alert
     and, the first time it trips, a letter.
     ============================================================ */

  Policies.rules = function () { boot(); return st.rules; };

  Policies.addRule = function (spec) {
    boot();
    if (!spec || !spec.kind) return null;
    var rule = {
      id: spec.id || ('rule' + nextId()),
      kind: spec.kind,
      defId: spec.defId || null,
      workType: spec.workType || null,
      minSkill: spec.minSkill === undefined ? 0 : spec.minSkill,
      count: spec.count === undefined ? 1 : spec.count,
      enabled: spec.enabled !== false,
      label: spec.label || describeRule(spec)
    };
    st.rules.push(rule);
    return rule;
  };

  function describeRule(spec) {
    var def = spec.defId ? Defs.maybe('thing', spec.defId) : null;
    var name = def ? def.label : spec.defId;
    if (spec.kind === 'stockMin') return 'Keep at least ' + spec.count + ' ' + name;
    if (spec.kind === 'stockMax') return 'Keep at most ' + spec.count + ' ' + name;
    if (spec.kind === 'workers') {
      return spec.count + ' colonists able to ' + spec.workType;
    }
    return 'Colony rule';
  }

  Policies.removeRule = function (id) {
    var r = findIn(st.rules, id);
    if (!r) return false;
    U.remove(st.rules, r);
    delete st.ruleState[id];
    return true;
  };

  Policies.setRuleEnabled = function (id, on) {
    var r = findIn(st.rules, id);
    if (!r) return false;
    r.enabled = !!on;
    if (!r.enabled) delete st.ruleState[id];
    return true;
  };

  Policies.stockOf = function (map, defId) {
    map = mapOf(map);
    if (!map || !map.byDef) return 0;
    var list = map.byDef(defId), n = 0;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t.spawned || t.isBlueprint || t.isFrame) continue;
      n += t.stack > 0 ? t.stack : 1;
    }
    return n;
  };

  function ableCount(map, workType, minSkill) {
    var list = map.colonists(), n = 0;
    var wt = Defs.maybe('workType', workType);
    var skills = (wt && wt.skills) || [];
    for (var i = 0; i < list.length; i++) {
      var pawn = list[i];
      if (pawn.downed) continue;
      if (pawn.capable && !pawn.capable(workType)) continue;
      if (!pawn.capable && !(pawn.workPriority && pawn.workPriority[workType] > 0)) continue;
      var best = 0;
      for (var s = 0; s < skills.length; s++) best = Math.max(best, skill(pawn, skills[s]));
      if (skills.length && best < minSkill) continue;
      n++;
    }
    return n;
  }

  Policies.checkRules = function (map) {
    boot();
    map = mapOf(map);
    var out = [];
    if (!map) return out;
    for (var i = 0; i < st.rules.length; i++) {
      var r = st.rules[i];
      if (!r.enabled) continue;
      var have, broken = false, detail = '';
      if (r.kind === 'stockMin') {
        have = Policies.stockOf(map, r.defId);
        broken = have < r.count;
        detail = have + ' of ' + r.count;
      } else if (r.kind === 'stockMax') {
        have = Policies.stockOf(map, r.defId);
        broken = have > r.count;
        detail = have + ', limit ' + r.count;
      } else if (r.kind === 'workers') {
        have = ableCount(map, r.workType, r.minSkill);
        broken = have < r.count;
        detail = have + ' of ' + r.count;
      }
      if (broken) out.push({ id: r.id, label: r.label, detail: detail, severity: 'warning' });
    }
    return out;
  };

  /* Alerts are recomputed on the slow beat and held, because ui.js
     reads them once a frame and a frame is not the place to count
     every stack of wood on the map. */
  function refreshAlerts(map) {
    var violations = Policies.checkRules(map);
    var live = Object.create(null), i;
    Policies.alerts = [];
    for (i = 0; i < violations.length; i++) {
      var v = violations[i];
      live[v.id] = 1;
      Policies.alerts.push({
        label: v.label + ' (' + v.detail + ')',
        severity: v.severity,
        ruleId: v.id,
        lookAt: null
      });
      if (!st.ruleState[v.id]) {
        st.ruleState[v.id] = 1;
        var G = root.Game;
        if (G && G.letter) {
          G.letter('Colony rule broken', v.label + '. Right now: ' + v.detail + '.', { kind: 'neutral' });
        }
      }
    }
    for (var id in st.ruleState) if (!live[id]) delete st.ruleState[id];
  }

  Policies.alertList = function () { return Policies.alerts; };

  /* ============================================================
     13. JOBS, WORK GIVERS AND THE THINK LEVEL

     Registration only. Nothing below runs at load beyond telling the
     other registries that these exist.
     ============================================================ */

  var installed = false;

  Policies.install = function () {
    if (installed) return true;
    var Jobs = sys('Jobs'), Toils = sys('Toils'), T = sys('T'), Path = sys('Path');
    if (!Jobs || !Jobs.register || !Toils || !T) return false;
    installed = true;

    var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

    Jobs.register('returnToArea', {
      label: 'return',
      reportString: 'Returning to the allowed area.',
      allowGoneTarget: true,
      toils: function () {
        return [Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false })];
      }
    });

    var WG = sys('WorkGivers');
    if (WG && WG.register) {
      /* Taking off what the outfit forbids comes before putting on
         what it allows: a pawn with a full torso slot has nothing to
         put on until the forbidden jacket is on the floor. */
      if (!WG.get || !WG.get('policyDropApparel')) {
        WG.register({
          id: 'policyDropApparel', workType: 'basic', order: 4,
          label: 'take off forbidden apparel',
          tryGiveJob: function (pawn) {
            if (pawn.isHuman !== true || pawn.faction !== 'player') return null;
            var worn = Policies.wantsToDrop(pawn);
            if (!worn) return null;
            return Jobs.make('dropThing', T.thing(worn));
          }
        });
      }
      if (!WG.get || !WG.get('policyWearApparel')) {
        WG.register({
          id: 'policyWearApparel', workType: 'basic', order: 5,
          label: 'put on apparel',
          tryGiveJob: function (pawn) {
            if (pawn.isHuman !== true || pawn.faction !== 'player') return null;
            if (Policies.wantsToDrop(pawn)) return null;
            var item = Policies.wantsToWear(pawn);
            if (!item) return null;
            var Res = sys('Res');
            if (Res && !Res.reserve(pawn, T.thing(item), 1)) return null;
            return Jobs.make('wearApparel', T.thing(item));
          }
        });
      }
    }

    installThinkLevel();
    return true;
  };

  /* think.js exports its level list so a system can add a rung
     without that file knowing about this one. The policy rung sits
     between urgent needs and bedtime: a colonist who is starving or
     bleeding deals with that first, and everything calmer than that
     waits until they are back where they are supposed to be. */
  var thinkInstalled = false;

  function installThinkLevel() {
    if (thinkInstalled) return true;
    var Think = sys('Think');
    if (!Think || !Think.LEVELS || !Think.TIER) return false;
    for (var i = 0; i < Think.LEVELS.length; i++) {
      if (Think.LEVELS[i].name === 'policy') { thinkInstalled = true; return true; }
    }
    var tier = Think.TIER.POLICY;
    if (tier === undefined) { tier = 7.5; Think.TIER.POLICY = tier; }
    var level = { tier: tier, name: 'policy', fn: policyJob };

    var at = -1;
    for (i = 0; i < Think.LEVELS.length; i++) {
      if (Think.LEVELS[i].name === 'bedtime') { at = i; break; }
      if (Think.LEVELS[i].name === 'work') { at = i; break; }
    }
    if (at < 0) at = Think.LEVELS.length - 1;
    Think.LEVELS.splice(at, 0, level);
    thinkInstalled = true;
    return true;
  }
  Policies.installThinkLevel = installThinkLevel;

  function policyJob(pawn) {
    if (!pawn || pawn.isHuman !== true || pawn.faction !== 'player') return null;
    if (pawn.drafted || pawn.downed || pawn.mentalState) return null;

    var job = returnToAreaJob(pawn);
    if (job) return job;
    return scheduledDrugJob(pawn);
  }

  function returnToAreaJob(pawn) {
    if (!Policies.restricted(pawn)) return null;
    if (Policies.allowedAt(pawn, pawn.x, pawn.y)) return null;
    var spot = Policies.nearestAllowedCell(pawn);
    if (!spot) return null;
    var J = sys('Jobs'), T = sys('T');
    if (!J || !T) return null;
    return J.make('returnToArea', T.cell(spot.x, spot.y));
  }
  Policies.returnToAreaJob = returnToAreaJob;

  /* ============================================================
     14. THE TICK

     game.js's systems registry drives Policies.tick on the slow
     beat with the game as its argument, and would drive tickPawn
     per pawn if it were listed there. Both are written to work
     either way: the per-pawn work is gated on its own interval, so
     calling it more often costs a compare and calling it less often
     just makes it less prompt.
     ============================================================ */

  Policies.tickPawn = function (pawn) {
    if (!pawn || pawn.dead || pawn.isHuman !== true) return;
    if (pawn.faction !== 'player') return;
    var t = now();
    var last = st.pawnBeat[pawn.id] || 0;
    if (last && t - last < PAWN_INTERVAL) return;
    st.pawnBeat[pawn.id] = t;

    boot();
    var rec = record(pawn);
    if (!rec.autoAssigned) Policies.autoAssign(pawn);
    Policies.scheduleOf(pawn);

    enforceFood(pawn, rec, t);
  };

  /* A colonist walking across the colony to eat the fine meal the
     player was saving is stopped here, once, and only when there is
     something else they are allowed to have. */
  function enforceFood(pawn, rec, t) {
    var job = pawn.job;
    if (!job || job.defId !== 'eat' || job.playerForced) return;
    if (t < (rec.blockedFoodUntil || 0)) return;
    var T = sys('T'), J = sys('Jobs');
    if (!T || !J) return;
    var food = job.targetA ? T.resolve(job.targetA, pawn.map) : null;
    if (!food && pawn.carried) food = pawn.carried;
    if (!food || !food.def) return;
    if (Policies.foodAllowed(pawn, food.def)) return;
    if (!allowedFoodExists(pawn)) {
      rec.blockedFoodUntil = t + FOOD_BLOCK_COOLDOWN;
      return;
    }
    rec.blockedFoodUntil = t + FOOD_BLOCK_COOLDOWN;
    J.end(pawn, 'interrupted');
    debug((pawn.name && pawn.name.first) + ' refused ' + food.def.id + ' on policy');
  }

  Policies.tick = function (a, b) {
    boot();
    Policies.install();
    var map = mapOf(a) || mapOf(b);
    if (!map) return;

    var t = now();
    if (st.homeAuto && t - st.homeTick >= HOME_INTERVAL) {
      st.homeTick = t;
      Policies.autoHome(map);
    }

    var list = map.colonists();
    for (var i = 0; i < list.length; i++) {
      Policies.tickPawn(list[i]);
      Policies.syncDrugs(list[i]);
    }

    /* Prisoners and animals never get a policy record of their own
       until something asks for one, and the care default is what
       answers for them until then - so nothing is done here beyond
       the colonists the player actually manages. */
    refreshAlerts(map);
    forgetDeadPawns(map);
  };

  function forgetDeadPawns(map) {
    /* The beat table is keyed by pawn id and would otherwise grow for
       the length of a campaign. Swept on the same rare beat that
       writes it, against the live pawn list. */
    var keys = Object.keys(st.pawnBeat);
    if (keys.length < 64) return;
    var live = Object.create(null);
    for (var i = 0; i < map.pawns.length; i++) live[map.pawns[i].id] = 1;
    for (var k = 0; k < keys.length; k++) if (!live[keys[k]]) delete st.pawnBeat[keys[k]];
  }

  /* ============================================================
     15. SAVE AND LOAD

     Per-pawn policy is a plain object on the pawn, so save.js
     carries it with the rest of the pawn blob and nothing here has
     to know about it. What lives here is the colony-wide half: the
     areas, the named policies, the presets and the rules.
     ============================================================ */

  /* Area cells are long runs of consecutive indices, so a delta
     encode turns a home area of two thousand tiles into two thousand
     ones, which the JSON compressor then eats for nothing. */
  function packCells(cells) {
    var out = [], prev = 0;
    for (var i = 0; i < cells.length; i++) { out.push(cells[i] - prev); prev = cells[i]; }
    return out;
  }

  function unpackCells(deltas) {
    var out = [], prev = 0;
    if (!Array.isArray(deltas)) return out;
    for (var i = 0; i < deltas.length; i++) { prev += deltas[i] | 0; out.push(prev); }
    return out;
  }

  Policies.save = function () {
    boot();
    var areas = st.areas.map(function (a) {
      return { id: a.id, bit: a.bit, label: a.label, builtIn: a.builtIn, color: a.color,
               cells: packCells(a.cells) };
    });
    return {
      v: 1,
      areas: areas,
      outfits: st.outfits,
      foods: st.foods,
      drugs: st.drugs,
      stockpilePresets: st.stockpilePresets,
      billPresets: st.billPresets,
      rules: st.rules,
      careDefaults: st.careDefaults,
      homeAuto: st.homeAuto,
      nextId: st.nextId
    };
  };

  Policies.load = function (obj) {
    Policies.reset();
    if (!obj || typeof obj !== 'object') return false;

    if (Array.isArray(obj.areas) && obj.areas.length) {
      st.areas = [];
      for (var i = 0; i < obj.areas.length && i < AREA_LIMIT; i++) {
        var a = obj.areas[i];
        st.areas.push({
          id: a.id | 0, bit: U.clamp(a.bit | 0, 0, AREA_LIMIT - 1),
          label: a.label || 'Area', builtIn: a.builtIn || null,
          color: a.color || '#4a7fd4', cells: unpackCells(a.cells)
        });
      }
      if (!Policies.homeArea()) {
        st.areas.unshift({ id: 1, bit: 0, label: 'Home area', builtIn: 'home', color: '#ffc23c', cells: [] });
      }
    }
    if (Array.isArray(obj.outfits) && obj.outfits.length) st.outfits = obj.outfits;
    if (Array.isArray(obj.foods) && obj.foods.length) st.foods = obj.foods;
    if (Array.isArray(obj.drugs) && obj.drugs.length) st.drugs = obj.drugs;
    if (Array.isArray(obj.stockpilePresets)) st.stockpilePresets = obj.stockpilePresets;
    if (Array.isArray(obj.billPresets)) st.billPresets = obj.billPresets;
    if (Array.isArray(obj.rules) && obj.rules.length) st.rules = obj.rules;
    if (obj.careDefaults) {
      for (var g = 0; g < CARE_GROUPS.length; g++) {
        var key = CARE_GROUPS[g];
        if (typeof obj.careDefaults[key] === 'number') {
          st.careDefaults[key] = U.clamp(obj.careDefaults[key] | 0, 0, 3);
        }
      }
    }
    st.homeAuto = obj.homeAuto !== false;
    st.nextId = Math.max(100, obj.nextId | 0);
    st.gridDirty = true;
    return true;
  };

  /* A pawn restored from a save may carry a policy record naming an
     area, outfit or policy that no longer exists - the player deleted
     it before the save, or the save predates it. Rebinding is a
     lookup and a fallback, and it is cheap enough to do on load for
     the whole colony. */
  Policies.rebind = function (pawn) {
    var rec = pawn && pawn.policy;
    if (!rec) return false;
    boot();
    if (rec.areaId && !Policies.area(rec.areaId)) rec.areaId = 0;
    if (!Policies.outfit(rec.outfitId)) rec.outfitId = 'anything';
    if (!Policies.foodPolicy(rec.foodId)) rec.foodId = 'anything';
    if (!Policies.drugPolicy(rec.drugId)) rec.drugId = 'none';
    if (!rec.ops) rec.ops = { surgery: true, prosthetics: true, harvestOrgans: false, euthanasia: false };
    if (!rec.lastDose) rec.lastDose = {};
    return true;
  };

  Policies.install();

  root.Policies = Policies;
})(this);
