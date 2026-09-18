/* ============================================================
   power.js - power nets, generation, batteries, light and heat.

   Three grids of derived state live here, and all three are read far
   more often than they change, so all three are caches with an
   invalidation rule rather than sums computed on demand:

   1. NETS. Conduits and powered buildings that touch each other are
      one electrical net. Rebuilt by flood fill, and only when the set
      of power things changed - map.js calls markDirty, and a cheap
      count signature catches the spawns that never moved a path cost
      (a conduit costs nothing to walk over, so nothing else notices it).
   2. LIGHT. render.js asks lightAt for every visible cell every frame.
      The lamp contribution is baked into a Float32Array and daylight is
      added at query time, so the hot path is one array read and a
      branch.
   3. HEAT. Regions asks tempPushAt once per room on its rare tick; the
      per-room sum is computed once per burst and handed out.

   Units are watts and watt-days throughout. A def's powerProduced is
   watts; batteryCapacity is watt-days, so a 600 Wd battery runs a
   350 W stove for most of two days. Rates quoted per day are divided
   by 60000 to get per tick, like everything else in the game.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  var TICKS_PER_DAY = 60000;

  /* How often the net re-sums its producers and consumers. Energy moves
     every tick regardless, so battery charge is a smooth line; this is
     only how quickly the grid notices that the sun came up. A quarter of
     a second is below the threshold where a player calls it a delay. */
  var RATE_PERIOD = 15;
  var WIND_PERIOD = 600;

  /* A dead net will not try to come back the instant it has a drop of
     charge - that is a strobe, not a brownout. It waits until it holds
     enough to run the deficit for this long. */
  var RESTART_TICKS = 1500;

  var REFUEL_AT = 0.20;          /* below this fraction, ask for a hauler */
  var FIRE_LIGHT_RADIUS = 4;
  var ROOF_LIGHT_LEAK = 0.22;    /* daylight bleeding under a roof */
  var COOLER_EXHAUST = 0.85;     /* heat dumped out the back per unit pulled in */

  var Power = {};

  /* The wind that turbines read. Power owns it so the file runs headless,
     but it eases toward Game.weather.wind whenever a game is running, so
     a storyteller-driven calm is one value and not two. */
  Power.wind = 0.6;

  /* ---------- which defs matter, worked out once from the def table ---------- */

  var _defLists = null;

  function defLists() {
    if (_defLists && _defLists.count === Defs.count('thing')) return _defLists;
    var net = [], fuel = [], light = [], push = [];
    Defs.all('thing').forEach(function (d) {
      var b = d.category === 'building' ? d.building : null;
      if (!b) return;
      if (b.powerProduced > 0 || b.powerConsumed > 0 || b.isConduit || b.batteryCapacity > 0) net.push(d.id);
      if (b.fuelCapacity > 0 && b.fuelBurnPerDay > 0) fuel.push(d.id);
      if (b.lightRadius > 0) light.push(d.id);
      if (b.tempPushRate) push.push(d.id);
    });
    /* Fire is an item, not a building, and carries no lightRadius - but a
       burning wall is the brightest thing on the map. */
    if (Defs.has('thing', 'fire')) light.push('fire');
    _defLists = { count: Defs.count('thing'), net: net, fuel: fuel, light: light, push: push };
    return _defLists;
  }

  /* ---------- per-map state ---------- */

  var states = new Map();

  /* lightAt runs once per visible cell per frame, so the lookup that
     every entry point starts with remembers the map it saw last. */
  var lastMap = null, lastState = null;

  function stateOf(map) {
    if (map === lastMap && lastState && lastState.size === map.size) return lastState;
    var st = states.get(map);
    if (st && st.size === map.size) { lastMap = map; lastState = st; return st; }
    st = {
      size: map.size,
      dirty: true,
      sig: -1,
      ticks: 0,
      lastRateTick: 0,
      nets: [],
      netById: new Map(),
      netOf: new Map(),                     /* thing id -> net */
      mark: new Int32Array(map.size),       /* cell -> id of the power thing on it */
      lamp: new Float32Array(map.size),
      lampDirty: true,
      lightSig: -1,
      ratesDirty: true,
      pushVersion: 1,
      pushComputed: 0,
      push: new Map(),                      /* room id -> degrees per hour */
      dayTick: -1,
      day: 1,
      flare: false
    };
    states.set(map, st);
    lastMap = map;
    lastState = st;
    return st;
  }

  Power.forget = function (map) {
    states.delete(map);
    if (lastMap === map) { lastMap = null; lastState = null; }
  };

  Power.reset = function () {
    states.clear();
    lastMap = null; lastState = null;
    _game = null;
    Power.wind = 0.6;
  };

  /* Game is defined two files below this one, so it cannot be captured at
     load; it is captured on first use instead, because lightAt reaches
     for the clock once per visible cell per frame and a global lookup on
     that path is not free. */
  var _game = null;
  function game() {
    if (_game) return _game;
    _game = root.Game || null;
    return _game;
  }

  /* Daylight is asked for once per cell per frame by the renderer, so it
     is memoised against the game clock rather than recomputed. */
  function daylightNow(st) {
    var G = game();
    var t = G && G.tick !== undefined ? G.tick : st.ticks;
    if (st.dayTick === t) return st.day;
    st.dayTick = t;
    st.day = (G && G.daylight) ? U.clamp01(G.daylight()) : 1;
    return st.day;
  }

  /* A solar flare shorts out everything electrical: no generation, no
     battery movement, every consumer dark until it passes. */
  function flareNow() {
    var G = game();
    return !!(G && G.weather && G.weather.flareTicksLeft > 0);
  }

  /* ============================================================
     NETS
     ============================================================ */

  function makeNet(id) {
    return {
      id: id, things: [], producers: [], consumers: [], batteries: [],
      production: 0, consumption: 0, demand: 0,
      stored: 0, capacity: 0, brownout: false
    };
  }

  /* Cheap enough to run every tick: one index lookup per power def. It
     exists because a conduit changes no path cost, so map.js has nothing
     to notice when one is built and markDirty is never called. */
  function signature(map) {
    var ids = defLists().net, s = 0;
    for (var i = 0; i < ids.length; i++) s += map.byDef(ids[i]).length * (i + 3);
    return s;
  }

  function cellsOf(t) { return t._cells || t.occupiedCells(); }

  Power.markDirty = function (map) {
    if (map) stateOf(map).dirty = true;
  };

  Power.update = function (map) {
    if (!map) return;
    var st = stateOf(map);
    var sig = signature(map);
    if (!st.dirty && st.sig === sig) return;
    st.sig = sig;
    st.dirty = false;
    rebuildNets(map, st);
    /* A rebuild leaves every powered flag stale, and Game.newGame calls
       update once before the first tick ever runs. Settle the nets now so
       nothing reads a lamp that does not yet know it is lit. */
    recomputeRates(map, st);
    checkLightSignature(map, st);
  };

  function rebuildNets(map, st) {
    var ids = defLists().net;
    var mark = st.mark;
    var w = map.w, h = map.h;
    var things = [], byId = new Map();
    var i, j, k, t, cells;

    mark.fill(0);
    for (i = 0; i < ids.length; i++) {
      var list = map.byDef(ids[i]);
      for (j = 0; j < list.length; j++) {
        t = list[j];
        if (!t.spawned) continue;
        t.netId = 0;
        things.push(t);
        byId.set(t.id, t);
        cells = cellsOf(t);
        for (k = 0; k < cells.length; k++) mark[cells[k]] = t.id;
      }
    }

    st.nets.length = 0;
    st.netById.clear();
    st.netOf.clear();

    /* Cardinal adjacency, the same rule the overlay draws: a conduit
       reads as a cross through its tile, and a diagonal that connected
       would be a wire the player cannot see. */
    var seen = new Set(), queue = [], nextId = 0;
    for (i = 0; i < things.length; i++) {
      if (seen.has(things[i].id)) continue;
      var net = makeNet(++nextId);
      seen.add(things[i].id);
      queue.length = 0;
      queue.push(things[i]);

      while (queue.length) {
        t = queue.pop();
        joinNet(st, net, t);
        cells = cellsOf(t);
        for (k = 0; k < cells.length; k++) {
          var c = cells[k], x = c % w, y = (c - x) / w, n, oid;
          if (y > 0)     { n = c - w; oid = mark[n]; if (oid && !seen.has(oid)) { seen.add(oid); queue.push(byId.get(oid)); } }
          if (y < h - 1) { n = c + w; oid = mark[n]; if (oid && !seen.has(oid)) { seen.add(oid); queue.push(byId.get(oid)); } }
          if (x > 0)     { n = c - 1; oid = mark[n]; if (oid && !seen.has(oid)) { seen.add(oid); queue.push(byId.get(oid)); } }
          if (x < w - 1) { n = c + 1; oid = mark[n]; if (oid && !seen.has(oid)) { seen.add(oid); queue.push(byId.get(oid)); } }
        }
      }

      sumStored(net);
      st.nets.push(net);
      st.netById.set(net.id, net);
    }

    st.ratesDirty = true;
    st.lampDirty = true;
    st.pushVersion++;
  }

  function joinNet(st, net, t) {
    var b = t.def.building;
    net.things.push(t);
    t.netId = net.id;
    st.netOf.set(t.id, net);
    if (b.powerProduced > 0) net.producers.push(t);
    if (b.powerConsumed > 0) net.consumers.push(t);
    if (b.batteryCapacity > 0) {
      /* Charge lives on the battery, not on the net, so cutting a wire
         and joining it back does not empty the colony's reserves. */
      if (typeof t.storedEnergy !== 'number' || !(t.storedEnergy >= 0)) t.storedEnergy = 0;
      t.storedEnergy = Math.min(t.storedEnergy, b.batteryCapacity);
      net.batteries.push(t);
      net.capacity += b.batteryCapacity;
    }
  }

  function sumStored(net) {
    var s = 0;
    for (var i = 0; i < net.batteries.length; i++) s += net.batteries[i].storedEnergy;
    net.stored = s;
  }

  Power.netOf = function (map, thing) {
    if (!map || !thing) return null;
    Power.update(map);
    return stateOf(map).netOf.get(thing.id) || null;
  };

  /* Things carry their net's id, so save.js and the overlay can go the
     other way round without holding a reference across a rebuild. */
  Power.netById = function (map, id) {
    if (!map || !id) return null;
    Power.update(map);
    return stateOf(map).netById.get(id) || null;
  };

  Power.nets = function (map) {
    if (!map) return [];
    Power.update(map);
    return stateOf(map).nets;
  };

  /* What every other system asks. Things with no electrical role at all -
     a table, a bed, a wall - are always "powered", so a caller can ask
     without first checking whether the question applies. */
  Power.isPowered = function (thing) {
    if (!thing || !thing.def) return false;
    var b = thing.def.building;
    if (!b) return true;
    if (!b.powerConsumed && !b.powerProduced) return true;
    if (thing.switchOff) return false;
    return thing.powered === true;
  };

  /* ============================================================
     GENERATION AND CONSUMPTION
     ============================================================ */

  /* No field in the def table says where a generator's energy comes from,
     so the two weather-driven ones are named here. A fuelled generator
     needs no special case: it runs at its rating while it has fuel, which
     is the whole reason a colony builds one. */
  function producerOutput(t, st) {
    var b = t.def.building;
    if (t.switchOff) return 0;
    if (b.fuelCapacity > 0) return t.fuel > 0 ? b.powerProduced : 0;
    /* A solar field is worth exactly what the sky gives it, which is what
       makes an eclipse an event rather than a change of colour. */
    if (t.defId === 'solarPanel') return b.powerProduced * daylightNow(st);
    if (t.defId === 'windTurbine') return b.powerProduced * U.clamp01(Power.wind);
    return b.powerProduced;
  }

  function recomputeRates(map, st) {
    var flare = flareNow();
    st.flare = flare;
    for (var i = 0; i < st.nets.length; i++) {
      var net = st.nets[i], j, t;

      var prod = 0;
      for (j = 0; j < net.producers.length; j++) {
        t = net.producers[j];
        var out = flare ? 0 : producerOutput(t, st);
        t.powered = out > 0;
        prod += out;
      }

      var demand = 0;
      for (j = 0; j < net.consumers.length; j++) {
        t = net.consumers[j];
        if (!t.switchOff) demand += t.def.building.powerConsumed;
      }

      net.production = prod;
      net.demand = demand;
      sumStored(net);

      var up;
      if (flare) up = false;
      else if (net.brownout) up = canRestart(net);
      else up = prod >= demand || net.stored > 0;

      net.brownout = !up;
      net.consumption = up ? demand : 0;
      applyPowered(net, up);
    }
    st.ratesDirty = false;
  }

  /* Back on the moment production covers the draw; otherwise only once
     the batteries hold enough to run the shortfall for a while. Without
     that reserve a net one watt short would flicker on and off forever. */
  function canRestart(net) {
    if (net.production >= net.demand) return true;
    if (net.capacity <= 0) return false;
    var reserve = (net.demand - net.production) * (RESTART_TICKS / TICKS_PER_DAY);
    return net.stored >= Math.min(net.capacity, reserve);
  }

  /* Conduits are deliberately left out. They carry no powerConsumed and
     no powerProduced, so isPowered already answers for them, and nothing
     in the game reads their flag - writing a field nobody reads onto
     every wire on the map, four times a second, is exactly the kind of
     cost that turns a big base into a slow one. */
  function applyPowered(net, up) {
    var i;
    for (i = 0; i < net.consumers.length; i++) {
      net.consumers[i].powered = up && !net.consumers[i].switchOff;
    }
    for (i = 0; i < net.batteries.length; i++) net.batteries[i].powered = up;
  }

  /* Energy moves every tick so the charge readout is a line rather than a
     staircase. Producers and consumers were summed at the last rate tick;
     nothing here re-walks the net. */
  function moveEnergy(st, ticks) {
    if (st.flare) return;                   /* nothing charges through a flare */
    var dt = ticks / TICKS_PER_DAY;
    for (var i = 0; i < st.nets.length; i++) {
      var net = st.nets[i];
      var surplus = net.production - net.consumption;
      if (surplus >= 0) {
        if (net.capacity > 0 && surplus > 0) charge(net, surplus * dt);
      } else if (!drain(net, -surplus * dt)) {
        brownOut(st, net);
      }
    }
  }

  /* Both of these move net.stored by what they actually moved rather than
     re-summing the bank, because they run every tick; recomputeRates
     re-sums four times a second, which is often enough to keep the
     running total honest against float drift. */
  function charge(net, amount) {
    for (var i = 0; i < net.batteries.length && amount > 0; i++) {
      var t = net.batteries[i];
      var room = t.def.building.batteryCapacity - t.storedEnergy;
      if (room <= 0) continue;
      var put = room < amount ? room : amount;
      t.storedEnergy += put;
      net.stored += put;
      amount -= put;
    }
  }

  /* Returns false when the bank could not cover the draw, which is the
     moment the lights go out. */
  function drain(net, amount) {
    if (net.stored < amount) {
      for (var k = 0; k < net.batteries.length; k++) net.batteries[k].storedEnergy = 0;
      net.stored = 0;
      return false;
    }
    for (var i = 0; i < net.batteries.length && amount > 0; i++) {
      var t = net.batteries[i];
      var take = t.storedEnergy < amount ? t.storedEnergy : amount;
      t.storedEnergy -= take;
      net.stored -= take;
      amount -= take;
    }
    if (net.stored < 0) net.stored = 0;
    return true;
  }

  function brownOut(st, net) {
    if (net.brownout) return;
    net.brownout = true;
    net.consumption = 0;
    applyPowered(net, false);
    st.ratesDirty = true;
    st.lampDirty = true;
    st.pushVersion++;
  }

  /* ============================================================
     FUEL
     A campfire is on no net and still burns wood, so fuel is handled
     for every fuelled thing rather than only for generators.
     ============================================================ */

  Power.consumeFuel = function (thing, ticks) {
    if (!thing || !thing.def) return 0;
    var b = thing.def.building;
    if (!b || !(b.fuelBurnPerDay > 0) || !(b.fuelCapacity > 0)) return 0;
    if (typeof thing.fuel !== 'number') thing.fuel = 0;

    var used = 0;
    if (!thing.switchOff && thing.fuel > 0 && ticks > 0) {
      used = Math.min(thing.fuel, b.fuelBurnPerDay * ticks / TICKS_PER_DAY);
      thing.fuel -= used;
      if (thing.fuel < 1e-6) thing.fuel = 0;
    }
    thing.needsRefuel = thing.fuel < b.fuelCapacity * REFUEL_AT;
    return used;
  };

  Power.needsRefuel = function (thing) {
    if (!thing || !thing.def || !thing.def.building) return false;
    var b = thing.def.building;
    if (!(b.fuelCapacity > 0)) return false;
    return (thing.fuel || 0) < b.fuelCapacity * REFUEL_AT;
  };

  /* The list the 'basic' work giver walks to find something to top up. */
  Power.refuelables = function (map) {
    var ids = defLists().fuel, out = [];
    for (var i = 0; i < ids.length; i++) {
      var list = map.byDef(ids[i]);
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        if (t.spawned && Power.needsRefuel(t)) out.push(t);
      }
    }
    return out;
  };

  function burnFuel(map, ticks) {
    var ids = defLists().fuel, burnt = false;
    for (var i = 0; i < ids.length; i++) {
      var list = map.byDef(ids[i]);
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        if (!t.spawned) continue;
        var had = t.fuel > 0;
        Power.consumeFuel(t, ticks);
        if (had && !(t.fuel > 0)) burnt = true;   /* it just went out */
      }
    }
    return burnt;
  }

  /* ============================================================
     THE TICK
     ============================================================ */

  Power.tick = function (map) {
    if (!map) return;
    var st = stateOf(map);
    st.ticks++;

    if (st.ticks % WIND_PERIOD === 0) driftWind();

    if (st.ratesDirty || st.ticks % RATE_PERIOD === 0) {
      var elapsed = st.ticks - (st.lastRateTick || 0);
      st.lastRateTick = st.ticks;
      if (burnFuel(map, elapsed)) st.lampDirty = true;
      recomputeRates(map, st);
      checkLightSignature(map, st);
      st.pushVersion++;
    }

    moveEnergy(st, 1);
  };

  function driftWind() {
    var G = game();
    var target;
    if (G && G.weather && typeof G.weather.wind === 'number') target = U.clamp01(G.weather.wind);
    else target = U.clamp(Power.wind + U.randRange(-0.3, 0.3), 0.05, 1);
    Power.wind = U.clamp(Power.wind + (target - Power.wind) * 0.35, 0.02, 1);
  }

  /* ============================================================
     LIGHT
     ============================================================ */

  function lightRadiusOf(t) {
    if (t.defId === 'fire') return FIRE_LIGHT_RADIUS;
    var b = t.def.building;
    return b ? b.lightRadius : 0;
  }

  function emitterLit(t) {
    if (!t.spawned) return false;
    if (t.defId === 'fire') return true;
    var b = t.def.building;
    if (!b || !(b.lightRadius > 0)) return false;
    if (t.switchOff) return false;
    if (b.powerConsumed > 0) return t.powered === true;
    if (b.fuelCapacity > 0) return t.fuel > 0;
    return true;
  }

  /* Order-independent, so the swap-pop that map.js does to its def index
     cannot fake a change. A collision here costs a quarter second of
     stale lamp glow, which is nothing anyone can see. */
  function lightSignature(map) {
    var ids = defLists().light, s = 0, n = 0;
    for (var i = 0; i < ids.length; i++) {
      var list = map.byDef(ids[i]);
      for (var j = 0; j < list.length; j++) {
        if (emitterLit(list[j])) { s += list[j].id; n++; }
      }
    }
    return s * 8 + n;
  }

  function checkLightSignature(map, st) {
    var sig = lightSignature(map);
    if (sig === st.lightSig) return;
    st.lightSig = sig;
    st.lampDirty = true;
  }

  function rebuildLamps(map, st) {
    var lamp = st.lamp, w = map.w, h = map.h;
    lamp.fill(0);
    var ids = defLists().light;
    for (var i = 0; i < ids.length; i++) {
      var list = map.byDef(ids[i]);
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        if (!emitterLit(t)) continue;
        var r = lightRadiusOf(t);
        if (!(r > 0)) continue;
        var f = t.footprint ? t.footprint() : { w: 1, h: 1 };
        var cx = t.x + (f.w - 1) / 2, cy = t.y + (f.h - 1) / 2;
        var x0 = Math.max(0, Math.ceil(cx - r)), x1 = Math.min(w - 1, Math.floor(cx + r));
        var y0 = Math.max(0, Math.ceil(cy - r)), y1 = Math.min(h - 1, Math.floor(cy + r));
        for (var y = y0; y <= y1; y++) {
          var base = y * w, dy = y - cy;
          for (var x = x0; x <= x1; x++) {
            var dx = x - cx;
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d > r) continue;
            var v = 1 - d / r;                  /* linear falloff to nothing at the rim */
            if (v > lamp[base + x]) lamp[base + x] = v;
          }
        }
      }
    }
    st.lampDirty = false;
    st.lightSig = lightSignature(map);
  }

  /* The renderer calls this for every visible cell every frame, so the
     body is a flag test, an array read and an add. */
  Power.lightAt = function (map, x, y) {
    if (!map || x < 0 || y < 0 || x >= map.w || y >= map.h) return 0;
    var st = stateOf(map);
    if (st.lampDirty) rebuildLamps(map, st);
    var i = y * map.w + x;
    var l = st.lamp[i];
    var day = daylightNow(st);
    if (day > 0) l += map.roof[i] ? day * ROOF_LIGHT_LEAK : day;
    return l > 1 ? 1 : l;
  };

  /* ============================================================
     TEMPERATURE
     Regions owns the thermostat and the room's thermal mass; all it
     wants from here is degrees per hour of push into a room, in the
     unit the thing defs quote.
     ============================================================ */

  /* Rot 0 faces south, matching the interaction offsets in def_things. */
  var FRONT = [[0, 1], [-1, 0], [0, -1], [1, 0]];

  function pusherActive(t) {
    if (!t.spawned || t.switchOff) return false;
    var b = t.def.building;
    if (b.powerConsumed > 0) return t.powered === true;
    if (b.fuelCapacity > 0) return t.fuel > 0;
    return true;
  }

  function addPush(pushMap, roomId, amount) {
    if (roomId === undefined || roomId === null) return;
    pushMap.set(roomId, (pushMap.get(roomId) || 0) + amount);
  }

  /* Solid on both flanks, measured across the way the unit faces: the
     shape of a machine let into a wall rather than standing in a room. */
  function wallMounted(map, t, dir) {
    var px = dir[1], py = dir[0];
    return blocked(map, t.x + px, t.y + py) && blocked(map, t.x - px, t.y - py);
  }

  function blocked(map, x, y) {
    return !map.inBounds(x, y) || !map.passable(x, y);
  }

  function computePush(map, st) {
    var pushMap = st.push;
    pushMap.clear();
    var ids = defLists().push;
    for (var i = 0; i < ids.length; i++) {
      var list = map.byDef(ids[i]);
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        if (!pusherActive(t)) continue;
        var rate = t.def.building.tempPushRate;
        if (!rate) continue;

        if (rate > 0) {
          addPush(pushMap, map.roomId[map.idx(t.x, t.y)], rate);
          continue;
        }

        /* A cooler moves heat rather than making cold: the room in front
           of it loses what the room behind it gains, minus what the
           machine wastes. Stand one in the open and both sides are the
           same room, so all it does is warm the place slightly - which
           is exactly what a fridge with its door open does. */
        var dir = FRONT[t.rot & 3];
        var fx = t.x + dir[0], fy = t.y + dir[1];
        var bx = t.x - dir[0], by = t.y - dir[1];
        var front = map.inBounds(fx, fy) ? map.roomId[map.idx(fx, fy)] : null;
        var back = map.inBounds(bx, by) ? map.roomId[map.idx(bx, by)] : null;
        addPush(pushMap, front, rate);

        /* A cooler set into a wall is part of that wall, whatever the room
           labelling says: regions.js calls the tile open because the unit
           does not fill it, so the freezer and the room outside it come
           back as one room. When solid wall flanks the unit on both sides
           it plainly is the boundary, and its exhaust does not belong in
           the room it is emptying. */
        if (back === front && wallMounted(map, t, dir)) continue;
        addPush(pushMap, back, -rate * COOLER_EXHAUST);
      }
    }
    st.pushComputed = st.pushVersion;
  }

  Power.tempPushAt = function (map, roomId) {
    if (!map) return 0;
    var st = stateOf(map);
    if (st.pushComputed !== st.pushVersion) computePush(map, st);
    return st.push.get(roomId) || 0;
  };

  /* ============================================================
     READOUTS
     ============================================================ */

  Power.stats = function (map) {
    if (!map) return [];
    Power.update(map);
    var st = stateOf(map), out = [];
    for (var i = 0; i < st.nets.length; i++) {
      var net = st.nets[i];
      out.push({
        id: net.id,
        production: net.production,
        consumption: net.consumption,
        demand: net.demand,
        stored: net.stored,
        capacity: net.capacity,
        brownout: net.brownout,
        thingCount: net.things.length
      });
    }
    return out;
  };

  /* One line for the inspect panel and the alert list. */
  Power.summary = function (map, net) {
    if (!net) return 'not connected';
    if (net.brownout) return 'no power (' + Math.round(net.production) + ' W made, ' +
      Math.round(net.demand) + ' W needed)';
    var line = Math.round(net.production) + ' W made, ' + Math.round(net.consumption) + ' W used';
    if (net.capacity > 0) {
      line += ', ' + Math.round(net.stored) + ' / ' + Math.round(net.capacity) + ' Wd stored';
    }
    return line;
  };

  /* Any net that is dark and wants not to be - the alert list reads this. */
  Power.brownouts = function (map) {
    if (!map) return [];
    Power.update(map);
    var st = stateOf(map), out = [];
    for (var i = 0; i < st.nets.length; i++) {
      if (st.nets[i].brownout && st.nets[i].demand > 0) out.push(st.nets[i]);
    }
    return out;
  };

  /* ---------- save ----------
     Battery charge and the wind are the only state here that a rebuild
     cannot reconstruct from the map itself. */

  Power.save = function (map) {
    var out = { wind: Power.wind, batteries: {} };
    if (!map) return out;
    var ids = defLists().net;
    for (var i = 0; i < ids.length; i++) {
      var list = map.byDef(ids[i]);
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        if (t.def.building.batteryCapacity > 0) out.batteries[t.id] = t.storedEnergy || 0;
      }
    }
    return out;
  };

  Power.load = function (map, data) {
    if (!data) return false;
    if (typeof data.wind === 'number') Power.wind = U.clamp(data.wind, 0.02, 1);
    if (map && data.batteries) {
      map.things.forEach(function (t) {
        var v = data.batteries[t.id];
        if (v === undefined) return;
        var b = t.def.building;
        if (!b || !(b.batteryCapacity > 0)) return;
        t.storedEnergy = U.clamp(v, 0, b.batteryCapacity);
      });
    }
    if (map) { stateOf(map).dirty = true; Power.update(map); }
    return true;
  };

  root.Power = Power;
})(this);
