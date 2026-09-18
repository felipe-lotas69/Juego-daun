/* ============================================================
   breakdowns.js - everything the colony owns is slowly falling apart.

   A base builder without a maintenance loop is a base builder you
   finish. Five things wear out here, and each of them turns a
   resource you were hoarding into a resource you spend:

     1. machinery fails on a schedule weighted by how hard it is
        worked, and a component puts it back together
     2. things left out in the weather lose hit points until they
        are gone, which is the reason a stockpile gets a roof
     3. clothes and weapons wear with use, so tailoring and smithing
        are jobs forever rather than jobs once
     4. an old wall leaks through its roof in the rain and gives way
        when something hits it
     5. servicing a machine before it fails, which is the part the
        source never had: breakdowns there are purely reactive

   Nothing here duplicates map.js. Food rot is map.js's business and
   is skipped on purpose; this file only touches what rot ignores.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  var TICKS_PER_DAY = 60000;

  /* ---------- machinery ---------- */

  /* Mean time between failures for a machine under ordinary load. Twelve
     days is short enough that a colony of eight machines sees a failure
     most weeks, and long enough that it reads as maintenance rather than
     as harassment. */
  var MTB_DAYS = 12;
  var REPAIR_WORK = 360;
  var REPAIR_COMPONENTS = 1;
  var MAINTAIN_WORK = 220;
  var MAINTENANCE_DAYS = 6;        /* a full service decays to nothing in this */
  var MAINTENANCE_RELIEF = 0.75;   /* how much of the failure chance it removes */
  var MAINTAIN_BELOW = 0.35;       /* a colonist services below this */

  /* ---------- deterioration ---------- */

  var DETERIORATE_HP_PER_DAY = 1.4;
  var ROOFED_FACTOR = 0.25;        /* a roof over open ground still helps */
  var RAIN_FACTOR = 2.0;           /* full rain on top of the base rate */
  var LEAK_FACTOR = 1.5;           /* indoors, under a leak, is worse than outdoors */

  /* ---------- wear ---------- */

  var APPAREL_WEAR_PER_DAY = 0.55;
  var APPAREL_WEAR_PER_FIGHT = 0.9;
  var WEAPON_WEAR_PER_DAY = 0.22;
  var WEAPON_WEAR_PER_ATTACK = 0.12;
  var WORN_AT = 0.70;              /* condition below this reads as "worn" */
  var TATTERED_AT = 0.45;          /* and below this it is a mood problem */
  var THREADBARE_AT = 0.22;
  var JAM_BELOW = 0.50;            /* a weapon this far gone can jam mid-aim */
  var JAM_CHANCE = 0.18;           /* per aim, at zero condition */
  var JAM_CHECK_PERIOD = 15;

  /* ---------- structure ---------- */

  var WEAK_WALL_AT = 0.35;         /* fraction of hit points that reads as unsound */
  var COLLAPSE_SCALE = 1.4;
  var LEAK_CHANCE_PER_DAY = 2.2;   /* per damaged roof-bearing wall, in full rain */
  var LEAK_TICKS = [3000, 9000];
  var LEAK_PERIOD = 60;            /* how often leaks are ticked */

  /* ---------- weather ---------- */

  var RAIN_CHANCE_PER_DAY = 0.55;
  var RAIN_LENGTH = [4000, 16000];

  /* ---------- slice periods ---------- */

  var MACHINE_PERIOD = 500;
  var ITEM_PERIOD = 2500;
  var WALL_PERIOD = 2500;
  var LETTER_GAP = 20000;          /* one letter per this many ticks, then messages */

  /* Things that are items but are not stuff lying in the rain. */
  var NEVER_DETERIORATES = {
    blueprint: 1, frame: 1, corpse: 1, bullet: 1, arrow: 1, fire: 1, filthBlood: 1
  };

  /* ============================================================
     Thoughts

     Additive registration, which is all this file does at load.
     ============================================================ */

  Defs.add('thought', {
    tatteredApparel: {
      label: 'Tattered apparel', durationDays: 0.4,
      stages: [
        { label: 'My clothes are falling apart', mood: -7 },
        { label: 'I am dressed in rags', mood: -13 }
      ],
      nullifiedByTrait: ['ascetic']
    }
  });

  /* ============================================================
     Module state

     Keyed to one map. A load, or a new colony, hands us a different
     GameMap object and everything cached here is rebuilt from it.
     ============================================================ */

  var state = {
    map: null,
    machines: [], machineCursor: 0, machineListTick: -1e9,
    items: [], itemCursor: 0, itemListTick: -1e9,
    walls: [], wallListTick: -1e9,
    gear: [],                      /* pawns carrying a weapon worn enough to jam */
    leaks: new Map(),              /* cellIdx -> ticks of leak left */
    rain: 0, rainTicksLeft: 0,
    lastLetterTick: -1e9,
    breakCount: 0,
    lastSlowTick: -1
  };

  var Breakdowns = {};

  function gameOf(game) { return game || root.Game || null; }

  function tickNow() {
    var G = root.Game;
    return G && G.tick ? G.tick : 0;
  }

  function msg(text, thing, type) {
    var G = root.Game;
    if (!G || !G.msg) return;
    G.msg(text, { type: type || 'info', x: thing ? thing.x : undefined, y: thing ? thing.y : undefined });
  }

  /* One letter per failure wave, then messages. A colony with twelve
     machines would otherwise bury the letter stack in maintenance. */
  function letterOnce(title, text, thing) {
    var G = root.Game;
    var now = tickNow();
    if (G && G.letter && now - state.lastLetterTick > LETTER_GAP) {
      state.lastLetterTick = now;
      G.letter(title, text, { kind: 'neutral', x: thing ? thing.x : undefined, y: thing ? thing.y : undefined });
      return;
    }
    msg(title, thing, 'info');
  }

  function syncMap(map) {
    if (state.map === map) return;
    state.map = map;
    state.machines.length = 0; state.machineCursor = 0; state.machineListTick = -1e9;
    state.items.length = 0; state.itemCursor = 0; state.itemListTick = -1e9;
    state.walls.length = 0; state.wallListTick = -1e9;
    state.gear.length = 0;
    state.leaks.clear();
    state.breakCount = 0;
  }

  /* ============================================================
     What is what

     Def lists never change after load, so each of these is worked out
     once and then used to walk map.byDef rather than map.things.
     ============================================================ */

  var _defLists = Object.create(null);

  function defIdsWhere(key, test) {
    var list = _defLists[key];
    if (list) return list;
    list = [];
    var all = Defs.all('thing');
    for (var i = 0; i < all.length; i++) if (test(all[i])) list.push(all[i].id);
    _defLists[key] = list;
    return list;
  }

  /* A machine is a building with an electrical role of its own. Lamps and
     conduits are left out deliberately: a base where every light bulb is
     a maintenance ticket is a base nobody wants to run, and RimWorld
     draws the same line. */
  function machineDefIds() {
    return defIdsWhere('machines', function (d) {
      var b = d.building;
      if (!b) return false;
      if (b.isLamp || b.isConduit) return false;
      return b.powerConsumed > 0 || b.powerProduced > 0 || b.batteryCapacity > 0;
    });
  }

  function wallDefIds() {
    return defIdsWhere('roofBearing', function (d) {
      return d.category === 'building' && d.holdsRoof && !d.natural;
    });
  }

  function itemDefIds() {
    return defIdsWhere('deteriorates', function (d) {
      if (d.category !== 'item') return false;
      if (NEVER_DETERIORATES[d.id]) return false;
      /* Anything with a rot clock is map.js's job, and two systems eating
         the same meal is how a colony starves twice as fast. */
      return !(d.rotDays > 0);
    });
  }

  Breakdowns.isMachine = function (thing) {
    if (!thing || !thing.spawned || !thing.def) return false;
    if (thing.isBlueprint || thing.isFrame) return false;
    if (thing.faction !== 'player') return false;
    var b = thing.def.building;
    if (!b || b.isLamp || b.isConduit) return false;
    return b.powerConsumed > 0 || b.powerProduced > 0 || b.batteryCapacity > 0;
  };

  function collect(map, defIds, out, test) {
    out.length = 0;
    for (var i = 0; i < defIds.length; i++) {
      var list = map.byDef(defIds[i]);
      for (var k = 0; k < list.length; k++) {
        var t = list[k];
        if (!t.spawned) continue;
        if (test && !test(t)) continue;
        out.push(t);
      }
    }
    return out;
  }

  function machineList(map) {
    var now = tickNow();
    if (now - state.machineListTick < MACHINE_PERIOD && state.machines.length) return state.machines;
    state.machineListTick = now;
    state.machineCursor = 0;
    return collect(map, machineDefIds(), state.machines, function (t) {
      return t.faction === 'player' && !t.isBlueprint && !t.isFrame;
    });
  }

  function itemList(map) {
    var now = tickNow();
    if (now - state.itemListTick < ITEM_PERIOD && state.items.length) return state.items;
    state.itemListTick = now;
    state.itemCursor = 0;
    return collect(map, itemDefIds(), state.items, null);
  }

  /* Only damaged walls. An undamaged wall cannot spring a leak and cannot
     give way, so the widest def list in the file produces the shortest
     working list. */
  function wallList(map) {
    var now = tickNow();
    if (now - state.wallListTick < WALL_PERIOD && state.walls.length) return state.walls;
    state.wallListTick = now;
    return collect(map, wallDefIds(), state.walls, function (t) {
      return t.hp < maxHpOf(t) * 0.9;
    });
  }

  function maxHpOf(thing) {
    if (!thing) return 1;
    if (thing.maxHp > 0) return thing.maxHp;
    var C = root.Construct;
    if (C && C.maxHp) return C.maxHp(thing) || 1;
    return (thing.def && thing.def.hp) || 1;
  }

  /* ============================================================
     Rain

     There is no precipitation anywhere else in the game, so this file
     owns one: a storm that starts on a roll, runs for a few hours and
     drives both deterioration and roof leaks. The planet's rainfall at
     the colony tile biases how often it happens, so a desert colony
     genuinely does keep its steel longer than a rainforest one.
     ============================================================ */

  function localRainfall() {
    var W = root.World;
    if (!W || !W.tileAt || W.colonyTile === undefined || W.colonyTile === null) return 0.5;
    var t = W.tileAt(W.colonyTile);
    return t && typeof t.rainfall === 'number' ? U.clamp01(t.rainfall) : 0.5;
  }

  function seasonRainFactor(game) {
    var G = gameOf(game);
    if (!G || !G.season) return 1;
    var s = G.season();
    if (s === 'spring') return 1.35;
    if (s === 'fall') return 1.2;
    if (s === 'winter') return 0.5;   /* it falls as snow, and snow is not modelled */
    return 0.8;
  }

  function tickWeather(game, elapsed) {
    if (state.rainTicksLeft > 0) {
      state.rainTicksLeft -= elapsed;
      if (state.rainTicksLeft <= 0) {
        state.rainTicksLeft = 0;
        state.rain = 0;
      }
      return;
    }
    var chance = RAIN_CHANCE_PER_DAY * (0.4 + 1.2 * localRainfall()) * seasonRainFactor(game);
    if (!U.chance(chance * elapsed / TICKS_PER_DAY)) return;
    state.rain = U.randRange(0.35, 1);
    state.rainTicksLeft = U.randInt(RAIN_LENGTH[0], RAIN_LENGTH[1]);
  }

  Breakdowns.rain = function () { return state.rainTicksLeft > 0 ? state.rain : 0; };
  Breakdowns.isRaining = function () { return state.rainTicksLeft > 0; };

  /* For a test or a debug key: make it rain now. */
  Breakdowns.startRain = function (intensity, ticks) {
    state.rain = U.clamp01(intensity === undefined ? 0.8 : intensity);
    state.rainTicksLeft = ticks === undefined ? 6000 : (ticks | 0);
  };

  /* ============================================================
     1. MACHINERY
     ============================================================ */

  Breakdowns.isBroken = function (thing) {
    return !!(thing && thing.broken);
  };

  /* Condition is what the inspect panel wants: one number, zero when the
     thing is useless. A broken machine is useless whatever its hit
     points say, which is the whole point of a breakdown. */
  Breakdowns.conditionOf = function (thing) {
    if (!thing) return 0;
    if (thing.broken) return 0;
    var max = maxHpOf(thing);
    return max > 0 ? U.clamp01((thing.hp || 0) / max) : 1;
  };

  Breakdowns.maintenanceOf = function (thing) {
    return thing && thing.maintenance > 0 ? U.clamp01(thing.maintenance) : 0;
  };

  /* How hard the thing is being worked, from signals that already exist
     rather than from a counter this file would have to keep in sync.
     An idle bench, a battery on a net nobody draws from and a turret
     that has not fired all season all wear more slowly than the stove
     with four bills on it. */
  function workloadOf(map, thing) {
    var b = thing.def.building;
    var load = 0.35;

    if (b.powerConsumed > 0) {
      load = thing.powered ? 1 : 0.15;
      if (b.isWorkbench && thing.bills && thing.bills.length) {
        var live = 0;
        for (var i = 0; i < thing.bills.length; i++) if (!thing.bills[i].suspended) live++;
        load += Math.min(0.8, live * 0.25);
      }
      if (b.isTurret && thing.lastAttackTick > 0 && tickNow() - thing.lastAttackTick < TICKS_PER_DAY) {
        load += 0.5;
      }
    } else if (b.powerProduced > 0) {
      /* A generator on a net that is drawing is a generator under load.
         One idling into an empty grid is not. */
      var P = root.Power;
      var net = P && P.netOf ? P.netOf(map, thing) : null;
      load = net && net.consumption > 0 ? 1 : 0.4;
      if (b.fuelCapacity > 0 && thing.fuel > 0) load += 0.25;
    } else if (b.batteryCapacity > 0) {
      load = thing.powered ? 0.8 : 0.3;
    }

    return U.clamp(load, 0.1, 1.8);
  }

  function breakdownChancePerDay(map, thing) {
    var base = 1 / MTB_DAYS;
    var load = workloadOf(map, thing);
    var serviced = 1 - MAINTENANCE_RELIEF * Breakdowns.maintenanceOf(thing);
    /* Damage that was never repaired is damage waiting to become a
       failure, so a machine at half hit points fails half again as often. */
    var hurt = 1 + 0.6 * (1 - Breakdowns.conditionOf(thing));
    return base * load * serviced * hurt;
  }

  Breakdowns.breakdownChancePerDay = function (thing) {
    var map = (thing && thing.map) || state.map || (root.Game && root.Game.map);
    if (!map || !Breakdowns.isMachine(thing) || thing.broken) return 0;
    return breakdownChancePerDay(map, thing);
  };

  Breakdowns.breakNow = function (thing) {
    if (!thing || thing.broken || !Breakdowns.isMachine(thing)) return false;
    thing.broken = true;
    thing.brokenTick = tickNow();
    /* power.js already knows how to leave a switched-off building out of
       the net's production and demand, so a breakdown borrows that rather
       than inventing a second way to be off. The player's own switch
       setting is remembered and handed back on repair. */
    thing._bdSwitch = !!thing.switchOff;
    thing.switchOff = true;
    thing.powered = false;
    var map = thing.map || state.map;
    var P = root.Power;
    if (P && P.markDirty && map) P.markDirty(map);
    state.breakCount++;

    var label = thing.def && thing.def.label ? thing.def.label : thing.defId;
    letterOnce('Breakdown: ' + label,
      'The ' + label + ' has broken down and will not run until somebody repairs it. ' +
      'That takes a component, so keep some in the stockpile.',
      thing);
    return true;
  };

  /* Put it back together. One component, and the machine comes back
     freshly serviced - which is exactly why a colony that only ever
     repairs burns components a colony that maintains does not. */
  Breakdowns.repair = function (pawn, thing) {
    if (!thing || !thing.broken) return false;
    thing.broken = false;
    thing.brokenTick = 0;
    thing.switchOff = !!thing._bdSwitch;
    thing._bdSwitch = false;
    thing.maintenance = 0.6;
    thing._bdTick = tickNow();
    var map = thing.map || (pawn && pawn.map) || state.map;
    var P = root.Power;
    if (P && P.markDirty && map) P.markDirty(map);
    if (pawn && pawn.learn) pawn.learn('construction', 90);
    msg((thing.def && thing.def.label ? U.cap(thing.def.label) : 'Machine') + ' repaired', thing, 'good');
    return true;
  };

  /* A service does not fix anything; it stops the next failure from
     happening. That is the difference between this and repair, and it is
     the whole reason to schedule it. */
  Breakdowns.maintain = function (pawn, thing) {
    if (!thing || !Breakdowns.isMachine(thing) || thing.broken) return false;
    thing.maintenance = 1;
    thing._bdTick = tickNow();
    if (pawn && pawn.learn) pawn.learn('construction', 55);
    return true;
  };

  Breakdowns.needsMaintenance = function (thing) {
    if (!Breakdowns.isMachine(thing) || thing.broken) return false;
    return Breakdowns.maintenanceOf(thing) < MAINTAIN_BELOW;
  };

  function tickMachine(map, thing, elapsed) {
    if (elapsed <= 0) return;
    var days = elapsed / TICKS_PER_DAY;

    if (thing.maintenance > 0) {
      thing.maintenance = Math.max(0, thing.maintenance - days / MAINTENANCE_DAYS);
    }
    if (thing.broken) {
      /* A broken machine that somehow got its power flag back - a net
         rebuild, a load - is put back down. Nothing may run while broken. */
      if (thing.powered) thing.powered = false;
      if (!thing.switchOff) thing.switchOff = true;
      return;
    }
    if (U.chance(breakdownChancePerDay(map, thing) * days)) Breakdowns.breakNow(thing);
  }

  /* ============================================================
     2. DETERIORATION
     ============================================================ */

  /* How exposed a cell is, as a multiplier on the base rate. Indoors is
     zero: a crate in a warehouse keeps forever, which is what makes the
     warehouse worth building. A leak is the exception, and it is the only
     way weather gets inside. */
  function exposureAt(map, x, y) {
    var i = map.idx(x, y);
    if (state.leaks.size && state.leaks.has(i)) {
      return LEAK_FACTOR * (1 + RAIN_FACTOR * Breakdowns.rain());
    }
    var R = root.Regions;
    if (R && R.roomAt) {
      var room = R.roomAt(map, x, y);
      if (room && !room.outdoor) return 0;
    } else if (map.buildingAt(x, y)) {
      return 0;
    }
    if (map.hasRoofAt(x, y)) return ROOFED_FACTOR;
    return 1 + RAIN_FACTOR * Breakdowns.rain();
  }

  Breakdowns.exposureAt = function (map, x, y) {
    if (!map || !map.inBounds(x, y)) return 0;
    return exposureAt(map, x, y);
  };

  function tickItem(map, thing, elapsed) {
    if (elapsed <= 0 || !thing.spawned) return;
    var exposure = exposureAt(map, thing.x, thing.y);
    if (exposure <= 0) return;
    var loss = DETERIORATE_HP_PER_DAY * exposure * elapsed / TICKS_PER_DAY;
    if (!(loss > 0)) return;
    thing.hp -= loss;
    if (thing.hp > 0) return;
    thing.hp = 0;
    map.destroyThing(thing, 'deteriorated');
  }

  /* ============================================================
     3. WEAR ON APPAREL AND WEAPONS
     ============================================================ */

  Breakdowns.isTattered = function (thing) {
    return !!thing && Breakdowns.conditionOf(thing) < TATTERED_AT;
  };

  Breakdowns.wearLabel = function (thing) {
    var c = Breakdowns.conditionOf(thing);
    if (c >= 0.99) return 'fresh';
    if (c >= WORN_AT) return 'good';
    if (c >= TATTERED_AT) return 'worn';
    if (c >= THREADBARE_AT) return 'tattered';
    return 'threadbare';
  };

  /* What a worn weapon is worth compared with a new one. Accuracy falls
     off only once the thing is genuinely past it, so a weapon at 80% is
     still a weapon. */
  Breakdowns.accuracyFactor = function (thing) {
    var c = Breakdowns.conditionOf(thing);
    if (c >= WORN_AT) return 1;
    return U.clamp(0.55 + 0.45 * (c / WORN_AT), 0.55, 1);
  };

  function destroyGear(pawn, thing, why) {
    var map = pawn.map;
    if (!map) return;
    if (pawn.equipment === thing) {
      pawn.dropEquipment();
    } else if (pawn.apparel && pawn.apparel.indexOf(thing) >= 0) {
      pawn.removeApparel(thing);
    }
    if (thing.spawned) map.destroyThing(thing, why);
    msg(U.cap(thing.def && thing.def.label ? thing.def.label : 'equipment') + ' fell apart', pawn, 'info');
  }

  function wearApparel(pawn, elapsed, fought) {
    var list = pawn.apparel;
    if (!list || !list.length) return 0;
    var days = elapsed / TICKS_PER_DAY;
    /* Asleep in a bed is not the same as a day in the mine. */
    var activity = pawn.job && pawn.job.defId === 'sleep' ? 0.3 : 1;
    var worst = 1;
    for (var i = list.length - 1; i >= 0; i--) {
      var a = list[i];
      var max = maxHpOf(a);
      a.hp -= APPAREL_WEAR_PER_DAY * days * activity;
      if (fought) a.hp -= APPAREL_WEAR_PER_FIGHT;
      if (a.hp <= 0) {
        a.hp = 0;
        destroyGear(pawn, a, 'worn out');
        continue;
      }
      var c = max > 0 ? a.hp / max : 1;
      if (c < worst) worst = c;
    }
    return worst;
  }

  function wearWeapon(pawn, elapsed, attacks) {
    var w = pawn.equipment;
    if (!w || !w.def || !w.def.weapon) return;
    w.hp -= WEAPON_WEAR_PER_DAY * elapsed / TICKS_PER_DAY;
    if (attacks > 0) w.hp -= WEAPON_WEAR_PER_ATTACK * attacks;
    if (w.hp > 0) return;
    w.hp = 0;
    destroyGear(pawn, w, 'worn out');
  }

  function applyTatteredThought(pawn, worst) {
    var N = root.Needs;
    if (!N || !N.addThought) return;
    if (worst >= TATTERED_AT) {
      if (N.removeThought) N.removeThought(pawn, 'tatteredApparel');
      return;
    }
    N.addThought(pawn, 'tatteredApparel', {
      degree: worst < THREADBARE_AT ? 1 : 0,
      noStack: true,
      situational: true
    });
  }

  /* Weapons wear per attack, and the only record of an attack that
     survives the tick it happened in is pawn.lastAttackTick. Counting
     the gap since the last visit turns that one number into "roughly
     how much shooting has this pawn done", which is all this needs. */
  function tickPawnGear(pawn, elapsed) {
    if (!pawn || pawn.dead || !pawn.isHuman) return;
    var last = pawn._bdAttackTick || 0;
    var attacks = 0;
    var fought = false;
    if (pawn.lastAttackTick > last) {
      fought = true;
      /* One "attack" per two seconds of the window the pawn was fighting
         in, capped so a long gap cannot bill a hundred swings at once. */
      attacks = U.clamp(Math.round((pawn.lastAttackTick - last) / 120), 1, 12);
      pawn._bdAttackTick = pawn.lastAttackTick;
    }
    var worst = wearApparel(pawn, elapsed, fought);
    wearWeapon(pawn, elapsed, attacks);
    applyTatteredThought(pawn, worst);
  }

  /* ---------- jamming ----------
     A weapon this far gone is unreliable, and unreliability is the part a
     player feels. Aborting the aim through Combat's own stance API costs
     the shot and the warmup, which is exactly what a jam is. */
  function refreshGearWatch(map) {
    var out = state.gear;
    out.length = 0;
    var pawns = map.pawns;
    for (var i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      if (p.dead || !p.equipment || !p.equipment.def || !p.equipment.def.weapon) continue;
      if (Breakdowns.conditionOf(p.equipment) >= JAM_BELOW) continue;
      out.push(p);
    }
  }

  function tickJams() {
    var list = state.gear;
    if (!list.length) return;
    var C = root.Combat;
    if (!C || !C.stanceOf || !C.clearStance) return;
    for (var i = list.length - 1; i >= 0; i--) {
      var p = list[i];
      if (p.dead || !p.equipment) { list.splice(i, 1); continue; }
      var st = C.stanceOf(p);
      if (!st || st.mode !== 'warmup') continue;
      var c = Breakdowns.conditionOf(p.equipment);
      if (c >= JAM_BELOW) { list.splice(i, 1); continue; }
      /* Per check, not per tick: the warmup is a second or two long and
         a per-tick roll would jam every worn weapon every time. */
      var chance = JAM_CHANCE * (1 - c / JAM_BELOW) * (JAM_CHECK_PERIOD / 60);
      if (!U.chance(chance)) continue;
      C.clearStance(p);
      p.stanceTicks = 40;
      p.equipment.hp = Math.max(1, p.equipment.hp - 1);
      msg(U.cap(nameOf(p)) + '\'s ' + (p.equipment.def.label || 'weapon') + ' jammed', p, 'threat');
    }
  }

  function nameOf(pawn) {
    var n = pawn && pawn.name;
    if (!n) return 'somebody';
    return n.nick || n.first || 'somebody';
  }

  /* ============================================================
     4. ROOF LEAKS AND STRUCTURAL WEAR
     ============================================================ */

  Breakdowns.isLeaking = function (map, x, y) {
    if (!map || !state.leaks.size || !map.inBounds(x, y)) return false;
    return state.leaks.has(map.idx(x, y));
  };

  Breakdowns.leakCount = function () { return state.leaks.size; };

  function springLeak(map, wall) {
    /* The leak lands on a roofed cell next to the failing wall, which is
       what makes it read as that wall's fault. */
    var cand = null, best = -1;
    for (var k = 0; k < U.ADJ8.length; k++) {
      var x = wall.x + U.ADJ8[k][0], y = wall.y + U.ADJ8[k][1];
      if (!map.inBounds(x, y) || !map.hasRoofAt(x, y)) continue;
      if (!map.passable(x, y)) continue;
      var i = map.idx(x, y);
      if (state.leaks.has(i)) continue;
      /* Prefer a cell with something worth ruining under it. */
      var score = map.itemsIdx(i).length + U.rand();
      if (score > best) { best = score; cand = i; }
    }
    if (cand === null) return false;
    state.leaks.set(cand, U.randInt(LEAK_TICKS[0], LEAK_TICKS[1]));
    msg('Water is coming through the roof', { x: map.xOf(cand), y: map.yOf(cand) }, 'info');
    return true;
  }

  function tickLeaks(map, elapsed) {
    if (!state.leaks.size) return;
    var gone = null;
    var N = root.Needs;
    state.leaks.forEach(function (left, i) {
      var next = left - elapsed;
      if (next <= 0) {
        (gone || (gone = [])).push(i);
        return;
      }
      state.leaks.set(i, next);
      if (!N || !N.addThought) return;
      var here = map.pawnsAtIdx ? map.pawnsAtIdx(i) : map.pawnsAt(map.xOf(i), map.yOf(i));
      for (var p = 0; p < here.length; p++) {
        if (here[p].isHuman && !here[p].dead) {
          N.addThought(here[p], 'soakingWet', { noStack: true });
        }
      }
    });
    if (gone) for (var g = 0; g < gone.length; g++) state.leaks.delete(gone[g]);
  }

  /* A wall that is already half gone does not absorb the next hit the way
     a fresh one does. The signal that it took a hit is its hit points
     falling between two visits, which costs one saved number and no hook
     into combat.js. */
  function tickWall(map, wall, elapsed) {
    var max = maxHpOf(wall);
    var last = wall._bdHp === undefined || wall._bdHp <= 0 ? wall.hp : wall._bdHp;
    var hit = last - wall.hp;
    wall._bdHp = wall.hp;

    var frac = max > 0 ? wall.hp / max : 1;
    if (frac < WEAK_WALL_AT && hit > 0) {
      var p = (WEAK_WALL_AT - frac) * COLLAPSE_SCALE * Math.min(1, hit / 20);
      if (U.chance(p)) { collapse(map, wall); return; }
    }

    if (frac >= 0.85 || !Breakdowns.isRaining()) return;
    var wetChance = LEAK_CHANCE_PER_DAY * Breakdowns.rain() * (1 - frac) * elapsed / TICKS_PER_DAY;
    if (U.chance(wetChance)) springLeak(map, wall);
  }

  function collapse(map, wall) {
    var x = wall.x, y = wall.y;
    var label = wall.def && wall.def.label ? wall.def.label : 'wall';
    map.destroyThing(wall, 'collapsed');

    /* The roof this wall was holding up comes down with it, but only
       where nothing else is holding it. Eight neighbours is the whole
       check: a roof two cells away has its own supports or it does not. */
    if (map.setRoof) {
      dropRoofIfUnsupported(map, x, y);
      for (var k = 0; k < U.ADJ8.length; k++) {
        dropRoofIfUnsupported(map, x + U.ADJ8[k][0], y + U.ADJ8[k][1]);
      }
    }
    letterOnce('A wall gave way',
      'The ' + label + ' was too far gone to take another hit. It came down, and the roof ' +
      'it was holding came down with it.',
      { x: x, y: y });
  }

  function dropRoofIfUnsupported(map, x, y) {
    if (!map.inBounds(x, y) || !map.hasRoofAt(x, y)) return;
    if (map.roof[map.idx(x, y)] === 2) return;          /* rock roof holds itself up */
    for (var k = 0; k < U.ADJ8.length; k++) {
      var b = map.buildingAt(x + U.ADJ8[k][0], y + U.ADJ8[k][1]);
      if (b && b.def && b.def.holdsRoof) return;
    }
    map.setRoof(x, y, 0);
  }

  /* ============================================================
     The public per-thing entry

     One thing, aged by however long it has been since this file last
     looked at it. Everything in this file goes through here, which is
     what lets a slice visit a thousand items without any of them losing
     time to the gaps between visits.
     ============================================================ */

  Breakdowns.tickThing = function (thing, map) {
    if (!thing || !thing.spawned) return;
    map = map || thing.map || state.map || (root.Game && root.Game.map);
    if (!map) return;

    var now = tickNow();
    var last = thing._bdTick === undefined || !thing._bdTick ? now : thing._bdTick;
    var elapsed = now - last;
    thing._bdTick = now;
    if (elapsed <= 0) return;

    if (Breakdowns.isMachine(thing)) { tickMachine(map, thing, elapsed); return; }
    if (thing.def.category === 'item' && !NEVER_DETERIORATES[thing.defId] && !(thing.def.rotDays > 0)) {
      tickItem(map, thing, elapsed);
      return;
    }
    if (thing.def.category === 'building' && thing.def.holdsRoof && !thing.def.natural) {
      tickWall(map, thing, elapsed);
    }
  };

  /* ============================================================
     The tick

     Everything is a rolling slice over a cached list, in the pattern
     map.js uses for rot: the list is rebuilt on its own beat, and a
     slice of it is aged every tick, so ten thousand items cost the same
     per tick as ten.
     ============================================================ */

  Breakdowns.tick = function (map, game) {
    if (!map) return;
    syncMap(map);
    if (!_workRegistered) Breakdowns.registerWork();

    var now = tickNow();

    var machines = machineList(map);
    if (machines.length) {
      var mPer = Math.max(1, Math.ceil(machines.length / MACHINE_PERIOD));
      for (var m = 0; m < mPer; m++) {
        if (state.machineCursor >= machines.length) state.machineCursor = 0;
        Breakdowns.tickThing(machines[state.machineCursor++], map);
      }
    }

    var items = itemList(map);
    if (items.length) {
      var iPer = Math.max(1, Math.ceil(items.length / ITEM_PERIOD));
      for (var i = 0; i < iPer; i++) {
        if (state.itemCursor >= items.length) state.itemCursor = 0;
        Breakdowns.tickThing(items[state.itemCursor++], map);
      }
    }

    if (now % LEAK_PERIOD === 0) tickLeaks(map, LEAK_PERIOD);
    if (now % JAM_CHECK_PERIOD === 0) tickJams();
  };

  /* The hourly beat: weather, gear wear, and the walls. All three are
     measured in hours or days, and none of them is worth a per-tick
     visit. */
  Breakdowns.tickSlow = function (game) {
    var G = gameOf(game);
    var map = G && G.map;
    if (!map) return;
    syncMap(map);

    var now = tickNow();
    var elapsed = state.lastSlowTick < 0 ? 500 : now - state.lastSlowTick;
    state.lastSlowTick = now;
    if (elapsed <= 0) return;

    tickWeather(G, elapsed);

    var colonists = map.colonists();
    for (var c = 0; c < colonists.length; c++) tickPawnGear(colonists[c], elapsed);

    var walls = wallList(map);
    for (var w = walls.length - 1; w >= 0; w--) {
      var wall = walls[w];
      if (!wall.spawned) { walls.splice(w, 1); continue; }
      Breakdowns.tickThing(wall, map);
    }

    refreshGearWatch(map);
  };

  /* ============================================================
     Alerts

     ui.js builds its own alert list and has no registry to add to, so
     this is offered rather than pushed: any UI file that wants the
     standing maintenance problems asks for them here.
     ============================================================ */

  Breakdowns.brokenThings = function (map) {
    map = map || state.map || (root.Game && root.Game.map);
    var out = [];
    if (!map) return out;
    var list = machineList(map);
    for (var i = 0; i < list.length; i++) if (list[i].broken) out.push(list[i]);
    return out;
  };

  Breakdowns.alerts = function (map) {
    map = map || state.map || (root.Game && root.Game.map);
    var out = [];
    if (!map) return out;

    var broken = Breakdowns.brokenThings(map);
    if (broken.length) {
      out.push({
        label: broken.length + ' ' + U.plural(broken.length, 'machine') + ' broken down',
        severity: broken.length > 2 ? 'high' : 'medium',
        lookAt: broken[0]
      });
      if (!componentStacks(map).length) {
        out.push({ label: 'No components for repairs', severity: 'high', lookAt: broken[0] });
      }
    }

    var tattered = null;
    var colonists = map.colonists();
    for (var c = 0; c < colonists.length && !tattered; c++) {
      var ap = colonists[c].apparel || [];
      for (var a = 0; a < ap.length; a++) {
        if (Breakdowns.isTattered(ap[a])) { tattered = colonists[c]; break; }
      }
    }
    if (tattered) {
      out.push({ label: nameOf(tattered) + ' is in tattered clothes', severity: 'low', lookAt: tattered });
    }

    if (state.leaks.size) {
      var first = null;
      state.leaks.forEach(function (v, i) { if (first === null) first = i; });
      out.push({
        label: state.leaks.size + ' roof ' + U.plural(state.leaks.size, 'leak'),
        severity: 'low',
        lookAt: first === null ? null : { x: map.xOf(first), y: map.yOf(first) }
      });
    }
    return out;
  };

  /* ============================================================
     JOBS

     Behaviour lives next to the system it belongs to. construct.js
     already owns the id "repair" for patching hit points; a breakdown is
     a different problem with a different cost, so it gets its own.
     ============================================================ */

  var Jobs = root.Jobs, Toils = root.Toils, T = root.T;
  var PE = root.Path ? root.Path.PE : { TOUCH: 1 };

  function targetThing(job, which, map) {
    var t = job['target' + which];
    return t ? T.resolve(t, map) : null;
  }

  function workRate(pawn) {
    var C = root.Construct;
    if (C && C.workRate) return C.workRate(pawn, 'construction');
    return pawn.workRate ? Math.max(0.05, pawn.workRate('construction')) : 1;
  }

  Jobs.register('fixBreakdown', {
    label: 'repair breakdown',
    reportString: function (job, pawn) {
      var b = targetThing(job, 'A', pawn && pawn.map);
      return 'Repairing ' + ((b && b.def && b.def.label) || 'machinery');
    },
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.reserve('B', 1),
        Toils.goto('B', { pe: PE.TOUCH, failIfGone: true }),
        Toils.pickUp('B', function () { return REPAIR_COMPONENTS; }),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'fixBreakdown',
          amount: REPAIR_WORK,
          skill: 'construction',
          rate: function (pawn) { return workRate(pawn); },
          onTick: function (pawn, job) {
            var b = targetThing(job, 'A', pawn.map);
            if (!b || !b.spawned) return 'fail';
            if (!b.broken) return 'done';
            return null;
          },
          onDone: function (pawn, job) {
            var b = targetThing(job, 'A', pawn.map);
            if (!b || !b.spawned) return 'fail';
            /* The component is consumed at the moment the work lands, not
               when it was picked up: a colonist interrupted halfway still
               has it in hand and puts it back. */
            var carried = pawn.carried;
            if (!carried || carried.defId !== 'components') return 'fail';
            carried.stack -= REPAIR_COMPONENTS;
            if (carried.stack <= 0) {
              pawn.carried = null;
              if (pawn.map) pawn.map.destroyThing(carried, 'used');
            }
            Breakdowns.repair(pawn, b);
            return 'done';
          }
        })
      ];
    }
  });

  Jobs.register('maintainMachine', {
    label: 'service machinery',
    reportString: function (job, pawn) {
      var b = targetThing(job, 'A', pawn && pawn.map);
      return 'Servicing ' + ((b && b.def && b.def.label) || 'machinery');
    },
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'maintain',
          amount: MAINTAIN_WORK,
          skill: 'construction',
          rate: function (pawn) { return workRate(pawn); },
          onTick: function (pawn, job) {
            var b = targetThing(job, 'A', pawn.map);
            if (!b || !b.spawned || b.broken) return 'fail';
            return null;
          },
          onDone: function (pawn, job) {
            var b = targetThing(job, 'A', pawn.map);
            if (!b) return 'fail';
            Breakdowns.maintain(pawn, b);
            return 'done';
          }
        })
      ];
    }
  });

  /* ============================================================
     WORK GIVERS

     workgivers.js loads after this file, so its registry does not exist
     yet at load time. Registration is deferred to the first tick, which
     is the same answer prisoners.js reaches by a different route: the
     system that owns the work registers the scan for it.
     ============================================================ */

  var _workRegistered = false;

  function componentStacks(map) {
    var out = [];
    var list = map.byDef('components');
    for (var i = 0; i < list.length; i++) {
      if (list[i].spawned && list[i].stack >= REPAIR_COMPONENTS) out.push(list[i]);
    }
    return out;
  }

  function canReach(pawn, thing) {
    var P = root.Path;
    if (!P || !P.reachable) return true;
    return P.reachable(pawn.map, pawn.x, pawn.y, thing.x, thing.y, { pawn: pawn, peMode: P.PE.TOUCH });
  }

  function nearestReachable(pawn, list, extraScore) {
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t.spawned) continue;
      if (!root.Res.canReserve(pawn, T.thing(t), 1)) continue;
      if (!canReach(pawn, t)) continue;
      var score = -U.dist(pawn.x, pawn.y, t.x, t.y) + (extraScore ? extraScore(t) : 0);
      if (score > bestScore) { bestScore = score; best = t; }
    }
    return best;
  }

  Breakdowns.registerWork = function () {
    if (_workRegistered) return false;
    var WG = root.WorkGivers;
    if (!WG || !WG.register) return false;
    _workRegistered = true;

    WG.register({
      id: 'breakdownRepair', workType: 'construct', order: 25,
      label: 'repair broken machinery',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        var broken = Breakdowns.brokenThings(map);
        if (!broken.length) return null;
        var parts = componentStacks(map);
        if (!parts.length) return null;

        var machine = nearestReachable(pawn, broken, null);
        if (!machine) return null;
        var part = nearestReachable(pawn, parts, null);
        if (!part) return null;

        if (!root.Res.reserve(pawn, T.thing(machine), 1)) return null;
        var job = Jobs.make('fixBreakdown', T.thing(machine), T.thing(part), { count: REPAIR_COMPONENTS });
        if (!job) root.Res.release(pawn, T.thing(machine));
        return job;
      }
    });

    /* Deliberately after repair and after deconstruction: servicing a
       machine is the thing you do when the urgent work is done, and a
       colony that services instead of building is a colony that never
       finishes its walls. */
    WG.register({
      id: 'breakdownMaintain', workType: 'construct', order: 95,
      label: 'service machinery',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        var machines = machineList(map);
        var due = [];
        for (var i = 0; i < machines.length; i++) {
          if (Breakdowns.needsMaintenance(machines[i])) due.push(machines[i]);
        }
        if (!due.length) return null;

        /* The machine closest to failing is the one worth an hour. */
        var target = nearestReachable(pawn, due, function (t) {
          return (1 - Breakdowns.maintenanceOf(t)) * 12;
        });
        if (!target) return null;
        if (!root.Res.reserve(pawn, T.thing(target), 1)) return null;
        var job = Jobs.make('maintainMachine', T.thing(target), null, {});
        if (!job) root.Res.release(pawn, T.thing(target));
        return job;
      }
    });
    return true;
  };

  /* ============================================================
     SAVE

     Per-thing state lives in plain fields on the thing - broken,
     maintenance, hp - so save.js carries all of it without being told.
     What is left is this file's own weather and its leaks, which belong
     to no thing.
     ============================================================ */

  Breakdowns.save = function () {
    var leaks = [];
    state.leaks.forEach(function (left, i) { leaks.push(i, Math.round(left)); });
    return {
      rain: Math.round(state.rain * 1000) / 1000,
      rainTicksLeft: Math.round(state.rainTicksLeft),
      leaks: leaks,
      breakCount: state.breakCount,
      lastLetterTick: state.lastLetterTick,
      lastSlowTick: state.lastSlowTick
    };
  };

  Breakdowns.load = function (obj) {
    state.leaks.clear();
    state.rain = 0;
    state.rainTicksLeft = 0;
    state.breakCount = 0;
    state.lastLetterTick = -1e9;
    state.lastSlowTick = -1;
    /* The caches belong to whatever map was loaded, not to the one that
       was running a moment ago. */
    state.map = null;
    if (!obj) return false;

    state.rain = U.clamp01(obj.rain || 0);
    state.rainTicksLeft = Math.max(0, obj.rainTicksLeft | 0);
    state.breakCount = obj.breakCount | 0;
    if (typeof obj.lastLetterTick === 'number') state.lastLetterTick = obj.lastLetterTick;
    if (typeof obj.lastSlowTick === 'number') state.lastSlowTick = obj.lastSlowTick;
    var leaks = obj.leaks;
    if (leaks && leaks.length) {
      for (var i = 0; i + 1 < leaks.length; i += 2) {
        if (leaks[i + 1] > 0) state.leaks.set(leaks[i] | 0, leaks[i + 1]);
      }
    }
    return true;
  };

  /* Only for tests and a fresh colony: forget everything. */
  Breakdowns.reset = function () {
    Breakdowns.load(null);
    state.machines.length = 0;
    state.items.length = 0;
    state.walls.length = 0;
    state.gear.length = 0;
  };

  Breakdowns.debugState = function () {
    return {
      machines: state.machines.length,
      items: state.items.length,
      walls: state.walls.length,
      leaks: state.leaks.size,
      rain: Breakdowns.rain(),
      breaks: state.breakCount,
      workRegistered: _workRegistered
    };
  };

  root.Breakdowns = Breakdowns;
})(this);
