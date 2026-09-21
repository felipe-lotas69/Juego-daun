/* ============================================================
   save.js - the whole colony as a plain object, and back again.

   The rule this file lives by: never patch state in, always rebuild it.
   Things are respawned through map.spawnThing so byDef, the cell grids
   and the cost grid are built by the code that owns them; regions and
   power nets are marked dirty and recomputed rather than stored; jobs
   and reservations are dropped entirely and re-thought on the first
   tick, the way RimWorld does it. What is left is the state nothing can
   derive: the grids, the things, the pawns, the clock and the dice.

   ------------------------------------------------------------
   SCHEMA (version 1). Short keys where they repeat thousands of
   times - thing records - and readable keys everywhere else.

   {
     v: 1,                          save format version
     rng: int,                      U.getSeed(), the live RNG state
     nid: int,                      U.peekId(), the next id to hand out
     time: { tick, seed, biome, difficulty, weather, wealth, speed,
             gameOver },            exactly Game.timeState()
     messages: [ {text, tick, type, x, y} ],
     letters:  [ {id, title, text, tick, kind, x, y, dismissed} ],

     map: {
       w, h, tickCount,
       terrainIds: [ 'soil', 'gravel', ... ],   terrain def ids by index,
                                                so a save survives a def
                                                being inserted in the list
       terrain: GRID, roof: GRID, blood: GRID,
       things: [ THING ],
       pawns:  [ PAWN ],
       zones:  Zones.serialize(map),
       desig:  [ [cellIdx, type, defId|null] ],
       temps:  [ [cellIdx, celsius] ]          one per indoor room, keyed
                                               by a cell inside it
     },

     research: Research.save(),     { done, currentId, progress, banked }
     power:    Power.save(map),     { wind, batteries: {thingId: charge} }
     story:    Storyteller.saveState(),
     world:    World.save(),
     factions: Factions.save(),
     caravans: Caravans.save(),
     trade:    Trade.save()
   }

   GRID = { r: 0|1, d: [...] }      r:1 is run-length encoded as
            [value, runLength, ...]; r:0 is the raw cell values. Terrain
            and roof are long bands and shrink by orders of magnitude; the
            encoder measures and falls back to raw when they do not.

   THING = one record per thing, with short keys because there are tens of
           thousands of them. Always present: i (id), d (defId), x, y.
           Present only when the field differs from what `new Thing(defId)`
           would have produced:

               s stack     h hp        H maxHp     r rot      f faction
               q quality   u stuff     k spawnTick S spawned
               P powered   N netId     F fuel      o open     E storedEnergy
               B isBlueprint  R isFrame  b buildDefId  w workDone
               g growth    n sown      l blighted  a plantAgeTicks
               p rotProgress  O ownerId
               m materials L bills     c corpse    A apparel[]

           Any other field a system hung on the thing keeps its own name
           (`_growTick`), except that an underscore field worth 0/false/''
           is dropped: every one of those treats absent and zero alike, and
           it is a fifth of the file. A field whose real name is a single
           letter is written with a '+' in front so it can never be read as
           a code. `def`, `map`, `_cells` and `_defIdx` are never written -
           they are references, and spawnThing rebuilds them.

   PAWN  = { id, kindId, x, y, health: HEALTH, blob: {every plain field},
             equipment, carried, apparel[], inventory[] as THING records }
           The blob deliberately carries no map, kind, job, driver,
           jobQueue, path or target: references and work in progress, and a
           loaded pawn re-thinks from scratch.

   HEALTH = { bodyId, d: 0|1, parts, injuries, hediffs, bloodLoss, pain,
              downed, dead, immunityGain, ticks, deathCause }
           With d:1, the normal case, `parts` holds only the parts that are
           hurt or missing, as [partId, hp, missing], and Health.create
           rebuilds the body from its def. d:0 means health.js was not
           loaded when the save was written and `parts` is the whole table.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  var VERSION = 1;

  var Save = {};
  Save.VERSION = VERSION;

  /* Why the last load refused, for the UI and for tests. */
  Save.lastError = null;

  /* Fields on a Thing that are references or bookkeeping the map owns,
     and fields serialised by hand because they are objects. */
  var THING_SKIP = {
    def: 1, map: 1, _cells: 1, _defIdx: 1, tickFn: 1,
    id: 1, defId: 1, x: 1, y: 1,
    materials: 1, bills: 1, corpse: 1, apparel: 1
  };

  /* Thing records repeat once per grass plant, so their keys are worth a
     letter each: seventeen thousand things is a megabyte of punctuation
     otherwise. See the schema at the top of the file. */
  var SHORT = {
    id: 'i', defId: 'd', stack: 's', hp: 'h', maxHp: 'H', rot: 'r',
    faction: 'f', quality: 'q', stuff: 'u', spawned: 'S', spawnTick: 'k',
    powered: 'P', netId: 'N', fuel: 'F', open: 'o', storedEnergy: 'E',
    isBlueprint: 'B', isFrame: 'R', buildDefId: 'b', workDone: 'w',
    growth: 'g', sown: 'n', blighted: 'l', plantAgeTicks: 'a',
    rotProgress: 'p', ownerId: 'O',
    materials: 'm', bills: 'L', corpse: 'c', apparel: 'A'
  };
  var LONG = {};
  Object.keys(SHORT).forEach(function (k) { LONG[SHORT[k]] = k; });

  function shortKey(k) {
    if (SHORT[k]) return SHORT[k];
    return LONG[k] ? '+' + k : k;
  }
  function longKey(k) {
    if (LONG[k]) return LONG[k];
    return k.charAt(0) === '+' ? k.slice(1) : k;
  }

  /* Six decimals is finer than the simulation can perceive and far
     shorter than the eighteen digits a growth value carries by default.
     Idempotent, which is what lets the checksum quantise through it and
     still compare equal either side of a round trip. */
  function round6(v) {
    if (typeof v !== 'number' || !isFinite(v)) return v;
    if (v === (v | 0)) return v;
    return Math.round(v * 1e6) / 1e6;
  }

  /* Everything a pawn carries that is a reference, a def, or a piece of
     work that is thrown away on save. Applied at every depth, which is
     what strips hediff.def and mentalState.def as well. */
  var PAWN_SKIP = {
    map: 1, kind: 1, def: 1,
    job: 1, driver: 1, jobQueue: 1,
    path: 1, aimTarget: 1, draftTarget: 1,
    equipment: 1, apparel: 1, inventory: 1, carried: 1,
    health: 1, _traitFx: 1
  };

  /* Below the top level only two names are ever dropped, and both are
     dropped because they are references rather than because of what they
     mean. The rest of PAWN_SKIP is about the pawn itself: applying it at
     depth would delete a hediff's own `id` and quietly cure the disease.
     That is not hypothetical - it happened. */
  var DEEP_SKIP = { def: 1, map: 1 };

  function sys(name) {
    var m = root[name];
    return (typeof m === 'undefined') ? null : m;
  }

  /* A refusal has to be loud without being destructive: the whole
     promise of deserialize is that a bad file changes nothing, and a
     line pushed into the message log is a change. So the reason is left
     on Save.lastError, where ui.js reads it for the toast, and echoed to
     the console only when the game is in debug mode. */
  function note(reason) {
    Save.lastError = reason;
    var G = sys('Game');
    if (G && G.debug && typeof console !== 'undefined') console.warn('[save] ' + reason);
    return false;
  }

  /* ============================================================
     PLAIN COPIES

     One deep copy that drops references rather than following them. A
     value that is not a plain object or an array is a live object - a
     Pawn, a Thing, a Map - and goes no further: a save that reached one
     would either cycle forever or resurrect a second copy of something
     the registry already owns.
     ============================================================ */
  function plain(value, skip, depth) {
    if (value === null || value === undefined) return null;
    var type = typeof value;
    if (type === 'function') return undefined;
    if (type !== 'object') return (type === 'number' && !isFinite(value)) ? 0 : value;
    if (depth > 8) return null;

    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) {
        var v = plain(value[i], DEEP_SKIP, depth + 1);
        if (v !== undefined) arr.push(v);
      }
      return arr;
    }
    /* Compared by name rather than by identity: a save parsed out of
       localStorage, or out of another realm in the headless harness,
       carries that realm's Object, and `!== Object` would throw the
       whole file away. A class instance - a Pawn, a Thing, a Map - is
       dropped on purpose. */
    if (value.constructor && value.constructor.name !== 'Object') return undefined;

    var out = {}, keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      if (skip && skip[keys[k]]) continue;
      var pv = plain(value[keys[k]], DEEP_SKIP, depth + 1);
      if (pv !== undefined) out[keys[k]] = pv;
    }
    return out;
  }

  function clone(value) { return plain(value, null, 0); }

  /* A Pawn is the one live object whose own fields we do want, so it is
     handed over as a shallow snapshot: plain plumbing on the outside, the
     same reference-dropping rules everywhere below it. */
  function plainOwn(obj, skip) {
    var raw = {}, keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      if (skip && skip[keys[i]]) continue;
      raw[keys[i]] = obj[keys[i]];
    }
    return plain(raw, skip, 0);
  }

  /* ============================================================
     GRIDS
     ============================================================ */

  /* Run-length encoding with an honest fallback: terrain is long bands of
     soil and rock and shrinks to a few per cent, but a genuinely noisy
     grid would double, so the encoder keeps whichever is smaller. */
  function encodeGrid(arr) {
    var runs = [], last = arr[0], n = 0, i;
    for (i = 0; i < arr.length; i++) {
      if (arr[i] === last) { n++; continue; }
      runs.push(last, n);
      last = arr[i]; n = 1;
    }
    if (arr.length) runs.push(last, n);
    if (runs.length >= arr.length) {
      var raw = new Array(arr.length);
      for (i = 0; i < arr.length; i++) raw[i] = arr[i];
      return { r: 0, d: raw };
    }
    return { r: 1, d: runs };
  }

  function decodeGrid(grid, out, remap) {
    if (!grid || !Array.isArray(grid.d)) return false;
    var d = grid.d, at = 0, i, k, v;
    if (grid.r) {
      for (i = 0; i + 1 < d.length; i += 2) {
        v = remap ? remap(d[i]) : d[i];
        for (k = d[i + 1]; k > 0 && at < out.length; k--) out[at++] = v;
      }
    } else {
      for (i = 0; i < d.length && at < out.length; i++) {
        out[at++] = remap ? remap(d[i]) : d[i];
      }
    }
    return true;
  }

  Save.encodeGrid = encodeGrid;
  Save.decodeGrid = decodeGrid;

  /* ============================================================
     THINGS
     ============================================================ */

  /* What `new Thing(defId)` would have produced, so the writer can omit
     every field that is still at its birth value. This is what keeps ten
     thousand grass plants down to five keys each. Cached per def: only
     the hit points vary, and a save walks tens of thousands of things. */
  var _defaults = Object.create(null);

  function thingDefaults(def) {
    var cached = _defaults[def.id];
    if (cached) return cached;
    var hp = def.hp || 1;
    cached = {
      spawned: true, stack: 1, hp: hp, maxHp: hp, rot: 0,
      faction: null, quality: null, stuff: null,
      powered: false, netId: 0, fuel: null, open: false,
      isBlueprint: false, isFrame: false, buildDefId: null, workDone: 0,
      growth: 0, sown: false, blighted: false, plantAgeTicks: 0,
      rotProgress: 0, spawnTick: 0
    };
    _defaults[def.id] = cached;
    return cached;
  }

  function packThing(thing) {
    var def = thing.def || Defs.maybe('thing', thing.defId);
    if (!def) return null;

    var rec = { i: thing.id, d: thing.defId, x: thing.x | 0, y: thing.y | 0 };
    var defaults = thingDefaults(def);
    var keys = Object.keys(thing);

    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (THING_SKIP[k]) continue;
      var v = thing[k];
      var t = typeof v;
      /* Scalars only. An object field on a thing is either one of the
         four handled below or something a system hung there that it can
         rebuild; either way it is not this loop's business. */
      if (t === 'object' || t === 'function' || t === 'undefined') continue;
      if (t === 'number' && !isFinite(v)) continue;
      if (defaults[k] !== undefined && defaults[k] === v) continue;
      /* An underscore field is another system's scratch, and every one of
         them treats "absent" and "zero" the same - plants.js says so out
         loud, because a freshly loaded plant has no grow tick either.
         Dropping those zeroes is worth a fifth of the file. */
      if (k.charAt(0) === '_' && (v === 0 || v === false || v === '')) continue;
      rec[shortKey(k)] = round6(v);
    }

    if (thing.materials) rec.m = clone(thing.materials);
    if (thing.bills && thing.bills.length) rec.L = clone(thing.bills);
    if (thing.corpse) rec.c = clone(thing.corpse);

    /* A corpse keeps what it was wearing, so a raid leaves clothes
       worth taking: unspawned Things hanging off the corpse. */
    if (thing.apparel && thing.apparel.length) {
      rec.A = [];
      for (var a = 0; a < thing.apparel.length; a++) {
        var sub = packThing(thing.apparel[a]);
        if (sub) rec.A.push(sub);
      }
    }
    return rec;
  }

  function validThingRec(rec) {
    return !!rec && typeof rec.d === 'string' &&
      rec.i > 0 && (rec.i | 0) === rec.i &&
      isFinite(rec.x) && isFinite(rec.y);
  }

  /* Rebuilds one Thing at its own id. spawnThing hands the new Thing
     whatever U.nextId() says next, so the counter is parked on the saved
     id first: that is what keeps every id reference in the file -
     bed.ownerId, bill.buildingId, Power's battery table, corpse.pawnId -
     pointing at the same object it pointed at before. */
  function spawnThingRec(map, rec, atX, atY) {
    if (!validThingRec(rec)) return null;
    if (!Defs.has('thing', rec.d)) return null;

    var x = U.clamp(atX === undefined ? rec.x | 0 : atX, 0, map.w - 1);
    var y = U.clamp(atY === undefined ? rec.y | 0 : atY, 0, map.h - 1);

    U.setIdCounter(rec.i);
    var thing = map.spawnThing(rec.d, x, y, {
      stack: rec.s === undefined ? 1 : rec.s,
      rot: rec.r | 0,
      faction: rec.f === undefined ? null : rec.f,
      quality: rec.q === undefined ? null : rec.q,
      stuff: rec.u === undefined ? null : rec.u,
      growth: rec.g,
      sown: rec.n,
      fuel: rec.F,
      corpse: rec.c || undefined,
      blueprintOf: rec.b || undefined
    });
    if (!thing) return null;

    var keys = Object.keys(rec);
    for (var i = 0; i < keys.length; i++) {
      var k = longKey(keys[i]);
      if (THING_SKIP[k]) continue;
      var v = rec[keys[i]];
      if (v === null || typeof v !== 'object') thing[k] = v;
    }
    /* x/y came from the record but may have been clamped into bounds. */
    thing.x = x; thing.y = y;

    if (rec.m) thing.materials = clone(rec.m);
    if (rec.c) thing.corpse = clone(rec.c);
    if (rec.L) thing.bills = restoreBills(rec.L);

    if (rec.A && rec.A.length) {
      thing.apparel = [];
      for (var a = 0; a < rec.A.length; a++) {
        var worn = looseThing(map, rec.A[a], x, y);
        if (worn) thing.apparel.push(worn);
      }
    }
    return thing;
  }

  /* A Thing that belongs to nobody's cell: a weapon in a hand, a shirt on
     a corpse, a stack being carried. `new Thing` is private to map.js, so
     one is made by spawning it and taking it straight back off the map -
     exactly what pawn.js does when a pawn picks something up. */
  function looseThing(map, rec, x, y) {
    var thing = spawnThingRec(map, rec, x, y);
    if (!thing) return null;
    map.despawnThing(thing);
    thing.spawned = false;
    thing.x = U.clamp(rec.x | 0, 0, map.w - 1);
    thing.y = U.clamp(rec.y | 0, 0, map.h - 1);
    return thing;
  }

  function restoreBills(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b || !Defs.has('recipe', b.recipeId)) continue;   /* a recipe that no longer exists */
      var bill = clone(b);
      if (!bill.qualityRange) bill.qualityRange = { min: 0, max: 6 };
      out.push(bill);
    }
    return out;
  }

  /* ---- health: the body is data, only the damage is worth storing ---- */
  function packHealth(pawn) {
    var h = pawn.health;
    if (!h) return null;
    var H = sys('Health');
    var derived = !!(H && H.create);

    var parts = [];
    if (h.parts) {
      for (var i = 0; i < h.parts.length; i++) {
        var p = h.parts[i];
        if (!derived) { parts.push(clone(p)); continue; }
        if (p.missing || p.hp !== p.maxHp) parts.push([p.id, p.hp, p.missing ? 1 : 0]);
      }
    }

    return {
      bodyId: h.bodyId || null,
      d: derived ? 1 : 0,
      parts: parts,
      injuries: clone(h.injuries || []),
      hediffs: clone(h.hediffs || []),
      bloodLoss: h.bloodLoss || 0,
      pain: h.pain || 0,
      downed: !!h.downed,
      dead: !!h.dead,
      immunityGain: h.immunityGain === undefined ? 0.3 : h.immunityGain,
      ticks: h.ticks || 0,
      deathCause: h.deathCause || null
    };
  }

  function restoreHealth(pawn, rec) {
    var H = sys('Health');
    if (!rec) {
      if (H && H.create) H.create(pawn);
      return;
    }

    if (rec.d && H && H.create) {
      H.create(pawn);
      var h = pawn.health;
      var byId = {};
      for (var i = 0; i < h.parts.length; i++) byId[h.parts[i].id] = h.parts[i];
      for (var k = 0; k < rec.parts.length; k++) {
        var row = rec.parts[k];
        var part = byId[Array.isArray(row) ? row[0] : row.id];
        if (!part) continue;
        if (Array.isArray(row)) {
          part.hp = U.clamp(row[1], 0, part.maxHp);
          part.missing = !!row[2];
        } else {
          part.hp = U.clamp(row.hp, 0, part.maxHp);
          part.missing = !!row.missing;
        }
      }
    } else {
      /* Written without health.js, or health.js is gone now: take the
         table verbatim and let whatever is loaded cope. A delta table
         written against a body this build can no longer build is not a
         body, so it is dropped rather than half-applied. */
      var full = (Array.isArray(rec.parts) && rec.parts.length && !Array.isArray(rec.parts[0]))
        ? clone(rec.parts) : [];
      pawn.health = {
        bodyId: rec.bodyId, parts: full, injuries: [],
        hediffs: [], bloodLoss: 0, pain: 0, capacities: {},
        downed: false, dead: false, immunityGain: 0.3, ticks: 0,
        deathCause: null, _capDirty: true
      };
    }

    var st = pawn.health;
    st.injuries = clone(rec.injuries) || [];
    st.hediffs = clone(rec.hediffs) || [];
    st.bloodLoss = rec.bloodLoss || 0;
    st.downed = !!rec.downed;
    st.dead = !!rec.dead;
    st.immunityGain = rec.immunityGain === undefined ? 0.3 : rec.immunityGain;
    st.ticks = rec.ticks || 0;
    st.deathCause = rec.deathCause || null;
    st._capDirty = true;
    st._killing = false;

    /* Hediff defs live in health.js, not in the file. Rebind before
       anything asks for a capacity, because the capacity maths reads
       hediff.def.capMods and a missing def there is a crash. */
    if (H && H.rebind) H.rebind(pawn);
    st.pain = rec.pain || 0;

    pawn.downed = st.downed;
    pawn.dead = st.dead;
  }

  /* ============================================================
     PAWNS
     ============================================================ */
  function packPawn(pawn) {
    var rec = {
      id: pawn.id, kindId: pawn.kindId,
      x: pawn.x | 0, y: pawn.y | 0,
      blob: plainOwn(pawn, PAWN_SKIP),
      health: packHealth(pawn),
      equipment: pawn.equipment ? packThing(pawn.equipment) : null,
      carried: pawn.carried ? packThing(pawn.carried) : null,
      apparel: [],
      inventory: []
    };
    var i;
    for (i = 0; i < (pawn.apparel || []).length; i++) {
      var worn = packThing(pawn.apparel[i]);
      if (worn) rec.apparel.push(worn);
    }
    for (i = 0; i < (pawn.inventory || []).length; i++) {
      var held = packThing(pawn.inventory[i]);
      if (held) rec.inventory.push(held);
    }
    return rec;
  }

  function restorePawn(map, rec) {
    var Pawn = sys('Pawn');
    if (!Pawn || !rec || !rec.blob) return null;
    if (!Defs.has('pawnKind', rec.kindId)) return null;

    var pawn = clone(rec.blob);
    pawn.id = rec.id;
    pawn.kindId = rec.kindId;
    pawn.x = U.clamp(rec.x | 0, 0, map.w - 1);
    pawn.y = U.clamp(rec.y | 0, 0, map.h - 1);
    pawn.fx = typeof pawn.fx === 'number' ? pawn.fx : pawn.x;
    pawn.fy = typeof pawn.fy === 'number' ? pawn.fy : pawn.y;
    pawn.health = null;

    /* A saved pawn has no job and no path. RimWorld drops both too: the
       think tree runs on the first tick after a load and picks work for
       the world as it is now, which is more correct than resuming a haul
       to a stockpile that may not exist any more. */
    pawn.job = null;
    pawn.driver = null;
    pawn.jobQueue = [];
    pawn.path = null;
    pawn.pathIdx = 0;
    pawn.moveProgress = 0;
    pawn.destX = -1;
    pawn.destY = -1;
    pawn.pathDest = -1;
    pawn.pathMode = 0;
    pawn.aimTarget = null;
    pawn.draftTarget = null;
    pawn.stanceTicks = 0;
    pawn.equipment = null;
    pawn.apparel = [];
    pawn.inventory = [];
    pawn.carried = null;
    pawn._moodDirty = true;

    Pawn.rebind(pawn, map);
    if (!pawn.kind) return null;

    restoreHealth(pawn, rec.health);

    /* Mental states carry their def; it is a reference, so it went out
       of the file as an id and comes back as a lookup. */
    if (pawn.mentalState && pawn.mentalState.id) {
      var msDef = Defs.maybe('mentalState', pawn.mentalState.id);
      if (msDef) pawn.mentalState.def = msDef;
      else pawn.mentalState = null;
    } else {
      pawn.mentalState = null;
    }

    var i, thing;
    if (rec.equipment) {
      thing = looseThing(map, rec.equipment, pawn.x, pawn.y);
      if (thing) pawn.equipment = thing;
    }
    if (rec.carried) {
      thing = looseThing(map, rec.carried, pawn.x, pawn.y);
      if (thing) pawn.carried = thing;
    }
    for (i = 0; i < (rec.apparel || []).length; i++) {
      thing = looseThing(map, rec.apparel[i], pawn.x, pawn.y);
      if (thing) pawn.apparel.push(thing);
    }
    for (i = 0; i < (rec.inventory || []).length; i++) {
      thing = looseThing(map, rec.inventory[i], pawn.x, pawn.y);
      if (thing) pawn.inventory.push(thing);
    }

    map.addPawn(pawn, pawn.x, pawn.y);
    return pawn;
  }

  /* ============================================================
     SERIALIZE
     ============================================================ */
  Save.serialize = function (game) {
    game = game || sys('Game');
    if (!game || !game.map) return null;
    var map = game.map;

    var terrainIds = Defs.all('terrain').map(function (d) { return d.id; });

    var things = [];
    map.things.forEach(function (t) {
      if (!t.spawned) return;      /* a stack mid-transfer belongs to whoever holds it */
      var rec = packThing(t);
      if (rec) things.push(rec);
    });
    things.sort(function (a, b) { return a.i - b.i; });

    var pawns = [];
    for (var p = 0; p < map.pawns.length; p++) {
      var prec = packPawn(map.pawns[p]);
      if (prec) pawns.push(prec);
    }

    var desig = [];
    map.designations.forEach(function (d, i) {
      desig.push([i, d.type, d.defId || null]);
    });

    /* Rooms themselves are re-derived from the walls, but what a room is
       currently at is not derivable from anything: a freezer that came
       back at twenty degrees would thaw the winter's meals every time
       the player reloaded. Each one is keyed by a cell inside it, which
       survives the rebuild that its room id does not. */
    var temps = [];
    var Regions = sys('Regions');
    if (Regions && Regions.rooms) {
      Regions.rooms(map).forEach(function (room) {
        if (room.outdoor || !room.cells.length) return;
        temps.push([room.cells[0], round6(room.temperature)]);
      });
    }

    var Zones = sys('Zones');
    var Research = sys('Research');
    var Power = sys('Power');
    var Storyteller = sys('Storyteller');
    var World = sys('World');
    var Factions = sys('Factions');
    var Caravans = sys('Caravans');
    var Trade = sys('Trade');

    return {
      v: VERSION,
      rng: U.getSeed(),
      nid: U.peekId(),
      time: clone(game.timeState ? game.timeState() : {
        tick: game.tick, seed: game.seed, biome: game.biome,
        difficulty: game.difficulty, weather: game.weather,
        wealth: game.wealth, speed: game.speed, gameOver: game.gameOver
      }),
      messages: clone(game.messages || []),
      letters: clone(game.letters || []),
      map: {
        w: map.w, h: map.h,
        tickCount: map.tickCount || 0,
        terrainIds: terrainIds,
        terrain: encodeGrid(map.terrain),
        roof: encodeGrid(map.roof),
        blood: encodeGrid(map.blood),
        things: things,
        pawns: pawns,
        zones: (Zones && Zones.serialize) ? Zones.serialize(map) : [],
        desig: desig,
        temps: temps
      },
      research: (Research && Research.save) ? Research.save() : null,
      power: (Power && Power.save) ? Power.save(map) : null,
      story: (Storyteller && Storyteller.saveState) ? clone(Storyteller.saveState()) : null,
      world: (World && World.save) ? World.save() : null,
      factions: (Factions && Factions.save) ? Factions.save() : null,
      caravans: (Caravans && Caravans.save) ? Caravans.save() : null,
      trade: (Trade && Trade.save) ? Trade.save() : null
    };
  };

  /* ============================================================
     DESERIALIZE
     ============================================================ */

  /* Everything that can be judged without touching the live game. A
     payload that fails here is refused before a single field of the
     running colony has changed, which is the whole point: a half-loaded
     game is worse than no load at all. */
  function checkPayload(data) {
    if (!data || typeof data !== 'object') return 'not a save file';
    if (data.v !== VERSION) {
      return 'save format v' + data.v + ', this build reads v' + VERSION;
    }
    var m = data.map;
    if (!m || typeof m !== 'object') return 'the save has no map';
    if (!(m.w > 0) || !(m.h > 0) || (m.w | 0) !== m.w || (m.h | 0) !== m.h) {
      return 'the map has no size';
    }
    if (m.w * m.h > 4000000) return 'the map is impossibly large';
    if (!Array.isArray(m.things)) return 'the save has no things';
    if (!Array.isArray(m.pawns)) return 'the save has no pawns';
    if (!m.terrain || !Array.isArray(m.terrain.d)) return 'the terrain grid is corrupt';
    if (!m.roof || !Array.isArray(m.roof.d)) return 'the roof grid is corrupt';
    if (!m.blood || !Array.isArray(m.blood.d)) return 'the blood grid is corrupt';
    if (!Array.isArray(m.terrainIds) || !m.terrainIds.length) return 'the terrain table is corrupt';
    if (!data.time || typeof data.time !== 'object') return 'the clock is missing';
    if (typeof root.GameMap !== 'function') return 'map.js is not loaded';
    return null;
  }

  /* Terrain travels as def indices plus the table those indices meant.
     If a terrain has been added since, every index after it has shifted,
     so the ids are matched by name and anything that no longer exists
     falls back to bare soil. */
  function terrainRemapper(savedIds) {
    var fallback = Defs.has('terrain', 'soil') ? Defs.index('terrain', 'soil') : 0;
    var lookup = new Array(savedIds.length);
    for (var i = 0; i < savedIds.length; i++) {
      lookup[i] = Defs.has('terrain', savedIds[i]) ? Defs.index('terrain', savedIds[i]) : fallback;
    }
    return function (v) {
      var at = lookup[v];
      return at === undefined ? fallback : at;
    };
  }

  /* Rooms come back with fresh ids, so a saved temperature finds its room
     through a cell that was inside it. A room that has since been knocked
     through simply is not there any more, and its warmth goes with it. */
  function restoreRoomTemps(map, rows) {
    var Regions = sys('Regions');
    if (!Regions || !Regions.roomAt || !Array.isArray(rows)) return;
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!row || row.length < 2) continue;
      var idx = row[0] | 0;
      if (idx < 0 || idx >= map.size) continue;
      var room = Regions.roomAt(map, map.xOf(idx), map.yOf(idx));
      if (room && !room.outdoor && isFinite(row[1])) room.temperature = row[1];
    }
  }

  Save.deserialize = function (data) {
    var bad = checkPayload(data);
    if (bad) return note(bad);

    var Game = sys('Game');
    if (!Game) return note('game.js is not loaded');

    var m = data.map;
    var map;

    /* Building the new map parks the id counter on each saved id in turn
       and lets systems roll dice; if it then throws, both have to go back
       the way they were or the refusal has quietly changed the game
       after all. */
    var idMark = U.peekId();
    var rngMark = U.getSeed();

    /* The counter the reloaded colony carries on from. It is the saved
       one, unless a file has somehow been edited to hold an id above it:
       handing out an id that something already owns is the one mistake
       here that would not show up until much later. */
    var highId = Math.max(1, data.nid | 0);

    try {
      map = new root.GameMap(m.w, m.h);

      decodeGrid(m.terrain, map.terrain, terrainRemapper(m.terrainIds));
      decodeGrid(m.roof, map.roof, null);
      decodeGrid(m.blood, map.blood, null);
      map.tickCount = m.tickCount || 0;

      /* Terrain was written straight into the grid, so the cost grid it
         was built from is now a lie. Recompute it before a single thing
         lands: spawnThing marks its own cells dirty, but only its own. */
      for (var i = 0; i < map.size; i++) map.markPathDirtyIdx(i);

      for (var t = 0; t < m.things.length; t++) {
        var thing = spawnThingRec(map, m.things[t]);
        if (thing && thing.id >= highId) highId = thing.id + 1;
      }
      for (var p = 0; p < m.pawns.length; p++) {
        var pawn = restorePawn(map, m.pawns[p]);
        if (pawn && pawn.id >= highId) highId = pawn.id + 1;
      }

      var Zones = sys('Zones');
      if (Zones && Zones.deserialize) Zones.deserialize(map, m.zones || []);

      var desig = m.desig || [];
      for (var d = 0; d < desig.length; d++) {
        var row = desig[d];
        if (!row || row.length < 2) continue;
        var idx = row[0] | 0;
        if (idx < 0 || idx >= map.size) continue;
        map.designate(map.xOf(idx), map.yOf(idx), row[1], { defId: row[2] || null });
      }
    } catch (e) {
      /* The new map is a local until this point, so a throw here costs
         nothing but the attempt. */
      U.setIdCounter(idMark);
      U.setSeed(rngMark);
      return note('the save is corrupt: ' + (e && e.message ? e.message : e));
    }

    /* ---- commit: from here the live game becomes the loaded one ---- */

    /* Before any module restores: Caravans and Zones can allocate ids of
       their own while loading, and they must come after everything the
       file already named, not on top of it. */
    U.setIdCounter(highId);

    Game.map = map;
    if (Game.restoreTimeState) Game.restoreTimeState(data.time);
    Game.messages = clone(data.messages) || [];
    Game.letters = clone(data.letters) || [];
    Game.selection = [];
    Game.started = true;

    /* Game caches a slice of the plant list across ticks; it belongs to
       the map that just went away. */
    Game._plantList = [];
    Game._plantListTick = -1;
    Game._plantCursor = 0;
    if (Game._pawnScratch) Game._pawnScratch.length = 0;

    var Research = sys('Research');
    if (Research && Research.load) Research.load(data.research);

    var Storyteller = sys('Storyteller');
    if (Storyteller && Storyteller.loadState) Storyteller.loadState(data.story);

    var World = sys('World');
    if (World && World.load && data.world) World.load(data.world);

    var Factions = sys('Factions');
    if (Factions && Factions.load && data.factions) Factions.load(data.factions);

    var Caravans = sys('Caravans');
    if (Caravans && Caravans.load) Caravans.load(data.caravans);

    var Trade = sys('Trade');
    if (Trade && Trade.load) Trade.load(data.trade, map);

    /* In-flight bullets belonged to the old world and the pawns in it. */
    var Combat = sys('Combat');
    if (Combat && Combat.reset) Combat.reset();

    var Res = sys('Res');
    if (Res && Res.clear) Res.clear(map);

    /* Derived state last, and rebuilt rather than restored: rooms,
       areas, temperatures and power nets all follow from the grids and
       the things that are now standing on them. */
    var Regions = sys('Regions');
    if (Regions) {
      if (Regions.reset) Regions.reset(map);
      if (Regions.rebuildAll) Regions.rebuildAll(map);
      /* The drift pass first, so outdoor rooms and any room the save did
         not name get a sensible number instead of the twenty degrees a
         fresh Room is born with; the saved temperatures then land on top
         of it, undrifted. */
      if (Regions.tickTemperature && Game.outdoorTemp) {
        Regions.tickTemperature(map, Game.outdoorTemp());
      }
      restoreRoomTemps(map, m.temps);
    }

    var Power = sys('Power');
    if (Power) {
      if (Power.markDirty) Power.markDirty(map);
      if (Power.load) Power.load(map, data.power);
      else if (Power.update) Power.update(map);
    }

    if (Game.recalcWealth) Game.recalcWealth();

    /* The dice come last. Restoring anything above may have rolled -
       Storyteller.loadState builds a fresh schedule before overwriting
       it - and the whole point of saving the RNG state is that the
       reloaded colony rolls what the live one would have. */
    U.setSeed(data.rng >>> 0);
    if (U.peekId() < highId) U.setIdCounter(highId);

    Save.lastError = null;
    return true;
  };

  /* ============================================================
     CHECKSUM

     A round trip is only worth anything if something notices when it
     loses a stack of steel or a bleeding wound. Everything below is
     accumulated as an integer, values scaled and rounded before they are
     added, because floating point addition is not associative and the
     restored world is walked in a different order than the live one was.
     ============================================================ */
  function fnv(h, v) {
    v = v | 0;
    h ^= v & 0xff; h = Math.imul(h, 16777619) >>> 0;
    h ^= (v >>> 8) & 0xff; h = Math.imul(h, 16777619) >>> 0;
    h ^= (v >>> 16) & 0xff; h = Math.imul(h, 16777619) >>> 0;
    h ^= (v >>> 24) & 0xff; h = Math.imul(h, 16777619) >>> 0;
    return h >>> 0;
  }

  function hashGrid(arr) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < arr.length; i++) h = fnv(h, arr[i]);
    return h >>> 0;
  }

  /* Quantised through the same rounding the writer uses, so a value that
     was shortened on the way out compares equal on the way back. */
  function q(v, scale) {
    if (typeof v !== 'number' || !isFinite(v)) return 0;
    return Math.round(round6(v) * scale);
  }

  function countString(table) {
    var keys = Object.keys(table).sort();
    var out = [];
    for (var i = 0; i < keys.length; i++) out.push(keys[i] + ':' + table[keys[i]]);
    return out.join(',');
  }

  Save.checksum = function (game) {
    game = game || sys('Game');
    var map = game && game.map;
    var sum = {
      tick: game ? game.tick | 0 : 0,
      seed: game ? game.seed | 0 : 0,
      rng: U.getSeed(),
      nextId: U.peekId(),
      things: 0, stacks: 0, hp: 0, growth: 0, workDone: 0, fuel: 0, rotProgress: 0,
      bills: 0, billsDone: 0, materials: 0, corpses: 0,
      pawns: 0, pawnIds: 0, gear: 0, gearStacks: 0,
      injuries: 0, injuryAmount: 0, injuryParts: 0, injuryBleed: 0,
      hediffs: 0, hediffSeverity: 0, bloodLoss: 0, partDamage: 0, missingParts: 0,
      needs: 0, mood: 0, thoughts: 0, skillXp: 0, skillLevels: 0,
      downed: 0, mentalStates: 0,
      terrain: 0, roof: 0, blood: 0, pathCost: 0,
      zones: 0, zoneCells: 0, designations: 0, rooms: 0, roomTemp: 0,
      research: '', researchProgress: 0,
      messages: 0, letters: 0,
      byDef: '', stackByDef: ''
    };
    if (!map) return sum;

    var byDef = Object.create(null);
    var stackByDef = Object.create(null);

    function countThing(t, held) {
      var d = t.defId;
      byDef[d] = (byDef[d] || 0) + 1;
      stackByDef[d] = (stackByDef[d] || 0) + (t.stack | 0);
      if (held) { sum.gear++; sum.gearStacks += t.stack | 0; return; }
      sum.things++;
      sum.stacks += t.stack | 0;
      sum.hp += q(t.hp, 1);
      sum.growth += q(t.growth, 10000);
      sum.workDone += q(t.workDone, 100);
      sum.fuel += q(t.fuel, 100);
      sum.rotProgress += q(t.rotProgress, 10000);
      if (t.corpse) sum.corpses++;
      if (t.bills) {
        for (var b = 0; b < t.bills.length; b++) {
          sum.bills++;
          sum.billsDone += t.bills[b].done | 0;
        }
      }
      if (t.materials) {
        for (var k in t.materials) sum.materials += t.materials[k] | 0;
      }
      if (t.apparel) {
        for (var a = 0; a < t.apparel.length; a++) countThing(t.apparel[a], true);
      }
    }

    map.things.forEach(function (t) { if (t.spawned) countThing(t, false); });

    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      sum.pawns++;
      sum.pawnIds += p.id | 0;
      if (p.downed) sum.downed++;
      if (p.mentalState) sum.mentalStates++;
      sum.mood += q(p.mood, 10000);

      var n = p.needs || {};
      for (var nk in n) sum.needs += q(n[nk], 10000);

      var sk = p.skills || {};
      for (var s in sk) {
        sum.skillLevels += sk[s].level | 0;
        sum.skillXp += q(sk[s].xp, 100);
      }
      sum.thoughts += (p.thoughts || []).length;

      var h = p.health;
      if (h) {
        sum.bloodLoss += q(h.bloodLoss, 10000);
        var inj = h.injuries || [], j;
        for (j = 0; j < inj.length; j++) {
          sum.injuries++;
          sum.injuryAmount += q(inj[j].amount, 100);
          sum.injuryParts += inj[j].partId | 0;
          sum.injuryBleed += q(inj[j].bleedRate, 10000);
        }
        var hd = h.hediffs || [];
        for (j = 0; j < hd.length; j++) {
          sum.hediffs++;
          sum.hediffSeverity += q(hd[j].severity, 10000);
        }
        var parts = h.parts || [];
        for (j = 0; j < parts.length; j++) {
          if (parts[j].missing) sum.missingParts++;
          sum.partDamage += q((parts[j].maxHp || 0) - (parts[j].hp || 0), 100);
        }
      }

      var gear = [p.equipment, p.carried].concat(p.apparel || [], p.inventory || []);
      for (var g = 0; g < gear.length; g++) if (gear[g]) countThing(gear[g], true);
    }

    sum.terrain = hashGrid(map.terrain);
    sum.roof = hashGrid(map.roof);
    sum.blood = hashGrid(map.blood);
    sum.pathCost = hashGrid(map.pathCost);

    sum.zones = map.zones.length;
    for (var z = 0; z < map.zones.length; z++) sum.zoneCells += map.zones[z].cells.size;
    sum.designations = map.designations.size;

    var Regions = sys('Regions');
    if (Regions && Regions.rooms) {
      var rooms = Regions.rooms(map);
      sum.rooms = rooms.size;
      rooms.forEach(function (room) {
        if (!room.outdoor) sum.roomTemp += q(room.temperature, 100);
      });
    }

    var Research = sys('Research');
    if (Research && Research.done) {
      var done = [];
      Research.done.forEach(function (id) { done.push(id); });
      sum.research = done.sort().join(',');
      sum.researchProgress = q(Research.progress, 100);
    }

    sum.messages = (game.messages || []).length;
    sum.letters = (game.letters || []).length;
    sum.byDef = countString(byDef);
    sum.stackByDef = countString(stackByDef);
    return sum;
  };

  /* Serialise, put it back, and prove the world that came out is the
     world that went in. tools/verify-sim.js calls this at the end of a
     long run, which is the only moment a save is under real pressure:
     thousands of things, wounded colonists, zones, bills, half-built
     walls and a storyteller mid-raid. */
  Save.selfTest = function (game) {
    game = game || sys('Game');
    if (!game || !game.map) return { ok: false, reason: 'no game to test' };

    var before, blob, data;
    try {
      before = Save.checksum(game);
      data = Save.serialize(game);
      if (!data) return { ok: false, reason: 'serialize returned nothing' };
      blob = JSON.stringify(data);
    } catch (e) {
      return { ok: false, reason: 'serialize threw: ' + (e && e.message ? e.message : e) };
    }

    var restored;
    try {
      restored = Save.deserialize(JSON.parse(blob));
    } catch (e) {
      return { ok: false, reason: 'deserialize threw: ' + (e && e.message ? e.message : e) };
    }
    if (!restored) return { ok: false, reason: 'deserialize refused: ' + Save.lastError };

    var after = Save.checksum(game);
    var diff = Save.compare(before, after);
    if (diff) return { ok: false, reason: diff, bytes: blob.length };

    return { ok: true, bytes: blob.length, things: before.things, pawns: before.pawns };
  };

  /* The first field that does not survive the trip, said in a way that
     names what was lost rather than printing two walls of numbers. */
  Save.compare = function (a, b) {
    var keys = Object.keys(a);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (a[k] === b[k]) continue;
      var av = a[k], bv = b[k];
      if (k === 'byDef') return 'thing counts differ: ' + firstDefDifference(av, bv);
      if (k === 'stackByDef') return 'stack totals differ: ' + firstDefDifference(av, bv);
      return k + ' differs: ' + JSON.stringify(av) + ' -> ' + JSON.stringify(bv);
    }
    return null;
  };

  function firstDefDifference(a, b) {
    var before = parseCounts(a), after = parseCounts(b), k;
    for (k in before) {
      if (before[k] !== after[k]) {
        return k + ' ' + before[k] + ' -> ' + (after[k] === undefined ? 0 : after[k]);
      }
    }
    for (k in after) {
      if (before[k] === undefined) return k + ' 0 -> ' + after[k];
    }
    return 'unknown';
  }

  function parseCounts(s) {
    var out = Object.create(null), parts = String(s).split(',');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var at = parts[i].lastIndexOf(':');
      if (at < 0) continue;
      out[parts[i].slice(0, at)] = +parts[i].slice(at + 1);
    }
    return out;
  }

  /* How big the save is right now, for the UI's "saving..." and for the
     headless test that wants to know it still fits in localStorage. */
  Save.size = function (game) {
    try { return JSON.stringify(Save.serialize(game)).length; }
    catch (e) { return -1; }
  };

  root.Save = Save;
})(this);
