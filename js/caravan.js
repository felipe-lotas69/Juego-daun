/* ============================================================
   caravan.js - voyages.

   The colony map is one tile of a planet, and this is the only
   way off it. A caravan takes real people off the map, carries
   them across the world for real days, feeds them out of a sack
   you packed yourself, and hands back whoever is still walking.

   Two rules shape everything below.

   First, a caravan owns its pawns outright. They are the same
   Pawn objects that walked the colony, not copies, so a wound
   taken in an ambush is still bleeding when they come home and
   the cook who left at level nine comes back at level nine. The
   price is that the colony must not keep a single reference to
   them while they are gone - see detach() and auditColony().

   Second, nothing here loads a second map. An ambush and a raid
   on a settlement are both resolved as arithmetic over the same
   combat stats the map would have used, and the injuries land on
   real body parts through Health.damage.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;

  var TICKS_PER_DAY = 60000;
  var RARE = 250;                      /* health.js advances one rare tick at a time */
  var MAX_CATCHUP = TICKS_PER_DAY * 2; /* a save reloaded from a very old tick */

  /* Per caravan per day on the road. A three-day trade run is meant to
     be worth doing; these are the odds that make it a decision. */
  var AMBUSH_PER_DAY = 0.09;
  var MEETING_PER_DAY = 0.08;
  var CACHE_PER_DAY = 0.06;
  var STORM_PER_DAY = 0.12;

  var BATTLE_ROUNDS = 9;
  var ROUND_DAMAGE = 3.4;              /* hit points one point of power lands per round */
  var MAX_WOUND = 17;                  /* a single abstract blow never exceeds this */
  var LOAD_SLOW_FLOOR = 0.55;
  var HUNGRY_AT = 0.85;                /* they top up whenever there is food to spare */

  var caravans = [];

  var Caravans = { all: caravans };

  /* ------------------------------------------------------------------
     Reaching the rest of the game

     events.js, game.js and save.js all load after this file, and
     trade.js may not be present at all in a cut-down build, so every
     one of them is looked up when it is needed rather than captured.
     ------------------------------------------------------------------ */

  function G() { return root.Game || null; }
  function W() { return root.World || null; }
  function Fac() { return root.Factions || null; }
  function Hp() { return root.Health || null; }
  function Nd() { return root.Needs || null; }

  function gameTick() { var g = G(); return g && g.tick !== undefined ? g.tick : 0; }

  function letter(title, text, kind) {
    var g = G();
    if (g && g.letter) g.letter(title, text, { kind: kind || 'neutral' });
  }

  function msg(text, type) {
    var g = G();
    if (g && g.msg) g.msg(text, { type: type || 'info' });
  }

  function defOf(defId) {
    return root.Defs && root.Defs.maybe ? root.Defs.maybe('thing', defId) : null;
  }

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    if (pawn.fullName) return pawn.fullName();
    if (pawn.name) return pawn.name.nick || pawn.name.first || 'someone';
    return 'someone';
  }

  function listNames(pawns) {
    var names = pawns.map(nameOf);
    if (names.length <= 1) return names[0] || 'nobody';
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
  }

  /* ------------------------------------------------------------------
     Goods

     A caravan's cargo is a plain ledger of {defId, count}: Things only
     exist on a map, and these are off it. Weapons and clothes people
     are actually wearing stay Things on the pawn who wears them.
     ------------------------------------------------------------------ */

  function addTo(list, defId, count) {
    if (!defId || !(count > 0)) return null;
    for (var i = 0; i < list.length; i++) {
      if (list[i].defId === defId) { list[i].count += count; return list[i]; }
    }
    var rec = { defId: defId, count: count };
    list.push(rec);
    return rec;
  }

  function normaliseItems(items) {
    var out = [];
    if (!items || !items.length) return out;
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      /* Accepts both the UI's {defId, count} rows and live Things, so a
         float menu can hand over the stack the cursor is on. */
      var id = it.defId || (it.def && it.def.id) || null;
      var n = it.count !== undefined ? it.count : (it.stack !== undefined ? it.stack : 1);
      n = Math.floor(n);
      if (!id || !(n > 0)) continue;
      addTo(out, id, n);
    }
    return out;
  }

  function stackMass(defId, count) {
    var d = defOf(defId);
    return d ? (d.mass || 0) * count : 0;
  }

  function itemsMass(list) {
    var m = 0;
    for (var i = 0; i < list.length; i++) m += stackMass(list[i].defId, list[i].count);
    return m;
  }

  function itemsNutrition(list) {
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var d = defOf(list[i].defId);
      if (d && d.nutrition > 0) n += d.nutrition * list[i].count;
    }
    return n;
  }

  function itemsValue(list) {
    var v = 0;
    for (var i = 0; i < list.length; i++) {
      var d = defOf(list[i].defId);
      if (d) v += (d.marketValue || 0) * list[i].count;
    }
    return v;
  }

  /* Worn clothes ride on the wearer and cost nobody anything; a rifle
     slung over a shoulder and a sack of steel in a pack both weigh. */
  function gearMass(pawn) {
    var m = 0, i;
    if (pawn.carried) m += (pawn.carried.def ? pawn.carried.def.mass || 0 : 0) * (pawn.carried.stack || 1);
    if (pawn.equipment && pawn.equipment.def) m += pawn.equipment.def.mass || 0;
    var inv = pawn.inventory || [];
    for (i = 0; i < inv.length; i++) {
      if (inv[i] && inv[i].def) m += (inv[i].def.mass || 0) * (inv[i].stack || 1);
    }
    return m;
  }

  Caravans.countOf = function (caravan, defId) {
    var list = caravan ? caravan.items : null;
    if (!list) return 0;
    for (var i = 0; i < list.length; i++) if (list[i].defId === defId) return list[i].count;
    return 0;
  };

  Caravans.addItem = function (caravan, defId, count) {
    if (!caravan || !(count > 0)) return 0;
    addTo(caravan.items, defId, Math.floor(count));
    refreshCargo(caravan);
    return Math.floor(count);
  };

  Caravans.removeItem = function (caravan, defId, count) {
    if (!caravan || !(count > 0)) return 0;
    var list = caravan.items;
    for (var i = 0; i < list.length; i++) {
      if (list[i].defId !== defId) continue;
      var took = Math.min(list[i].count, Math.floor(count));
      list[i].count -= took;
      if (list[i].count <= 0) list.splice(i, 1);
      refreshCargo(caravan);
      return took;
    }
    return 0;
  };

  Caravans.goods = function (caravan) {
    if (!caravan) return [];
    return caravan.items.map(function (it) { return { defId: it.defId, count: it.count }; });
  };

  function refreshCargo(caravan) {
    caravan.food = itemsNutrition(caravan.items);
    caravan.mass = itemsMass(caravan.items) + U.sum(caravan.pawns, gearMass);
    return caravan;
  }

  /* ------------------------------------------------------------------
     Forming
     ------------------------------------------------------------------ */

  function no(reason) { return { ok: false, reason: reason }; }

  function capacityOf(pawns) {
    var cap = 0;
    for (var i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      if (!p || p.dead) continue;
      cap += p.carryCapacity !== undefined ? p.carryCapacity : 35;
    }
    return cap;
  }

  function partySpeed(pawns, load, capacity) {
    var slowest = 0, seen = false;
    for (var i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      if (!p || p.dead) continue;
      var s = p.moveSpeedFactor ? p.moveSpeedFactor() : 1;
      if (!(s > 0)) s = 0.2;
      if (!seen || s < slowest) { slowest = s; seen = true; }
    }
    if (!seen) slowest = 1;
    /* Half loaded is free; anything past that drags on the whole party,
       which is what makes a muffalo worth bringing. */
    var ratio = capacity > 0 ? load / capacity : 0;
    var loadFactor = ratio <= 0.5 ? 1 : U.clamp(1 - (ratio - 0.5) * 0.9, LOAD_SLOW_FLOOR, 1);
    return Math.max(0.15, slowest * loadFactor);
  }

  Caravans.canForm = function (pawns, items) {
    pawns = (Array.isArray(pawns) ? pawns : []).filter(Boolean);
    var goods = normaliseItems(items);

    if (!pawns.length) return no('A caravan needs at least one person.');

    var humans = 0, health = Hp();
    for (var i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      var who = nameOf(p);
      if (p.dead) return no(who + ' is dead.');
      if (p.downed || (health && health.isDowned && health.isDowned(p))) {
        return no(who + ' is downed and cannot walk out of here.');
      }
      if (p.drafted) return no(who + ' is drafted. Undraft them before they pack.');
      if (p.prisoner) return no(who + ' is a prisoner, not a traveller.');
      if (p.mentalState) return no(who + ' is in no state to travel.');
      if (p.isAnimal && !p.tame) return no(who + ' is a wild animal.');
      if (p.isHuman) humans++;
    }
    if (!humans) return no('Pack animals will not cross the world on their own.');

    var capacity = capacityOf(pawns);
    var load = itemsMass(goods) + U.sum(pawns, gearMass);
    if (load > capacity) {
      return no('Too much to carry: ' + U.fmt(load, 1) + ' kg of ' + U.fmt(capacity, 0) +
        '. Leave ' + U.fmt(load - capacity, 1) + ' kg behind or bring a pack animal.');
    }

    var nutrition = itemsNutrition(goods);
    if (nutrition <= 0) {
      return no('No food packed. They will starve before they get anywhere.');
    }

    return {
      ok: true, reason: '',
      capacity: capacity, load: load, nutrition: nutrition,
      foodDays: nutrition / Math.max(1, humans + U.countBy(pawns, function (p) { return !!p.isAnimal; })) / 1.6,
      speed: partySpeed(pawns, load, capacity)
    };
  };

  /* What the caravan dialog needs to draw its readouts, without having to
     know any of the arithmetic above. */
  Caravans.plan = function (pawns, items, destinationTile) {
    pawns = (Array.isArray(pawns) ? pawns : []).filter(Boolean);
    var goods = normaliseItems(items);
    var capacity = capacityOf(pawns);
    var load = itemsMass(goods) + U.sum(pawns, gearMass);
    var speed = partySpeed(pawns, load, capacity);
    var world = W();
    var from = world ? world.colonyTile : 0;
    var ticks = (world && destinationTile !== undefined && destinationTile !== null)
      ? world.travelTicks(from, destinationTile, speed) : 0;
    var days = ticks / TICKS_PER_DAY;
    var mouths = Math.max(1, pawns.length);
    return {
      capacity: capacity, load: load, speed: speed,
      ticks: ticks, days: days,
      nutrition: itemsNutrition(goods),
      /* A round trip, because they have to eat their way home too. */
      nutritionNeeded: mouths * 1.6 * days * 2,
      value: itemsValue(goods),
      check: Caravans.canForm(pawns, goods)
    };
  };

  /* Takes `count` of defId off the colony floor. Stacks are consumed
     whole where possible so the map is left tidy rather than dusted with
     ones and twos. */
  function takeFromMap(map, defId, want) {
    if (!map || !(want > 0)) return 0;
    var list = map.byDef(defId).slice();
    var got = 0;
    for (var i = 0; i < list.length && got < want; i++) {
      var t = list[i];
      if (!t || !t.spawned || t.isBlueprint || t.isFrame) continue;
      if (!t.def || t.def.category !== 'item') continue;
      var have = t.stack === undefined ? 1 : t.stack;
      if (have <= 0) continue;
      var take = Math.min(have, want - got);
      got += take;
      t.stack = have - take;
      if (t.stack <= 0) map.despawnThing(t);
    }
    return got;
  }

  function jobTargetsPawn(job, id) {
    if (!job) return false;
    var keys = ['targetA', 'targetB', 'targetC'];
    for (var i = 0; i < keys.length; i++) {
      var t = job[keys[i]];
      if (t && t.k === 'p' && t.id === id) return true;
    }
    return false;
  }

  /* The dangerous half of this file. A pawn on a caravan is not in
     map.pawns, so anything on the map still pointing at them is a
     reference to a person who is no longer there: a hauler walking to
     rescue them, an animal following a master who is three tiles of
     planet away, a stance in combat.js keyed by their id.

     Everything that can hold such a reference is cut here, in one place,
     and auditColony() below re-checks the same list from the outside. */
  function detach(pawn, map) {
    var g = G();

    if (g && g.selection) U.remove(g.selection, pawn);

    pawn.drafted = false;
    pawn.draftTarget = null;
    pawn.aimTarget = null;
    if (pawn.jobQueue) pawn.jobQueue.length = 0;
    if (pawn.endJob) pawn.endJob('interrupted');
    if (root.Res && root.Res.releaseAll) root.Res.releaseAll(pawn);
    if (root.Combat && root.Combat.clearStance) root.Combat.clearStance(pawn);

    if (map) {
      for (var i = 0; i < map.pawns.length; i++) {
        var other = map.pawns[i];
        if (other === pawn) continue;
        if (other.master === pawn.id) other.master = null;
        if (other.aimTarget && other.aimTarget.k === 'p' && other.aimTarget.id === pawn.id) {
          if (root.Combat && root.Combat.clearStance) root.Combat.clearStance(other);
          other.aimTarget = null;
        }
        if (other.draftTarget && other.draftTarget.k === 'p' && other.draftTarget.id === pawn.id) {
          other.draftTarget = null;
        }
        if (jobTargetsPawn(other.job, pawn.id) && other.endJob) other.endJob('interrupted');
      }
    }

    /* deSpawn ends the job and unhooks the per-cell index; nulling the
       map afterwards is what stops health.js dropping a corpse into the
       colony if this pawn dies halfway across the planet. */
    if (pawn.deSpawn) pawn.deSpawn();
    else if (map && map.removePawn) map.removePawn(pawn);
    pawn.map = null;
    pawn.path = null;
    pawn.pathIdx = 0;
  }

  Caravans.form = function (opts) {
    opts = opts || {};
    var world = W(), g = G();
    if (!world || !world.generated) { msg('There is no world to travel.', 'info'); return null; }

    var pawns = (opts.pawns || []).filter(Boolean);
    var goods = normaliseItems(opts.items);
    var check = Caravans.canForm(pawns, goods);
    if (!check.ok) { msg('Caravan refused: ' + check.reason, 'info'); return null; }

    var from = world.colonyTile;
    var dest = opts.destinationTile;
    if (dest === undefined || dest === null) dest = from;
    if (dest === from) { msg('Caravan refused: that is where you already are.', 'info'); return null; }

    var speed = check.speed;
    var path = world.pathBetween(from, dest);
    if (!path || !path.length) {
      msg('Caravan refused: there is no land route to that tile.', 'info');
      return null;
    }
    var ticks = world.travelTicks(from, dest, speed);

    var map = g ? g.map : (pawns[0] && pawns[0].map);
    /* Cargo comes off the floor before anyone leaves, so a caravan that
       could not be fully supplied is visible as a short ledger rather
       than as goods conjured out of nothing. */
    var packed = [];
    for (var i = 0; i < goods.length; i++) {
      var took = takeFromMap(map, goods[i].defId, goods[i].count);
      if (took > 0) addTo(packed, goods[i].defId, took);
    }

    for (var p = 0; p < pawns.length; p++) detach(pawns[p], map);

    var settlement = world.settlementAt(dest);
    var caravan = {
      id: U.nextId(),
      seed: g ? g.seed : 0,
      pawns: pawns,
      items: packed,
      tile: from,
      originTile: from,
      homeTile: from,
      path: path,
      progress: 0,
      destination: dest,
      purpose: opts.purpose || 'trade',
      ticksToArrive: ticks,
      totalTicks: ticks,
      food: 0,
      mass: 0,
      speed: speed,
      state: 'travelling',
      settlementId: settlement ? settlement.id : 0,
      deal: null,
      departTick: gameTick(),
      lastTick: gameTick(),
      waitTicks: 0,
      label: opts.label || null
    };
    caravan.label = caravan.label || defaultLabel(caravan);
    refreshCargo(caravan);
    caravans.push(caravan);

    letter(caravan.label + ' departs',
      listNames(pawns) + ' set out for ' + destinationName(caravan) + ' with ' +
      U.fmt(caravan.mass, 0) + ' kg of goods and ' + U.fmt(caravan.food, 1) +
      ' days of food. They should arrive in about ' + U.fmt(ticks / TICKS_PER_DAY, 1) + ' days.',
      'neutral');
    return caravan;
  };

  function defaultLabel(caravan) {
    if (caravan.purpose === 'attack') return 'War party';
    if (caravan.purpose === 'visit') return 'Diplomatic caravan';
    if (caravan.purpose === 'return') return 'Returning caravan';
    return 'Trade caravan';
  }

  function settlementOf(caravan) {
    var world = W();
    if (!world || !caravan.settlementId) return null;
    var s = world.settlementById(caravan.settlementId);
    return s && !s.destroyed ? s : null;
  }

  function destinationName(caravan) {
    var s = settlementOf(caravan) || (W() && W().settlementAt(caravan.destination));
    if (s) return s.name;
    if (caravan.destination === caravan.homeTile) return 'home';
    return 'tile ' + caravan.destination;
  }

  Caravans.describe = function (caravan) {
    if (!caravan) return '';
    var head = caravan.label + ' - ' + destinationName(caravan);
    if (caravan.state === 'trading') return head + ' (at the market)';
    return head + ', ' + U.fmt(Caravans.daysLeft(caravan), 1) + ' days out';
  };

  Caravans.daysLeft = function (caravan) {
    return caravan ? Math.max(0, caravan.ticksToArrive) / TICKS_PER_DAY : 0;
  };

  Caravans.atTile = function (tile) {
    return caravans.filter(function (c) { return c.tile === tile; });
  };

  Caravans.forSettlement = function (settlement) {
    if (!settlement) return null;
    for (var i = 0; i < caravans.length; i++) {
      if (caravans[i].settlementId === settlement.id && caravans[i].state === 'trading') return caravans[i];
    }
    return null;
  };

  Caravans.pawnsAbroad = function () {
    var out = [];
    for (var i = 0; i < caravans.length; i++) out = out.concat(caravans[i].pawns);
    return out;
  };

  /* ------------------------------------------------------------------
     The long tick
     ------------------------------------------------------------------ */

  Caravans.tick = function (game) {
    var g = game || G();
    var now = g ? g.tick : 0;

    for (var i = caravans.length - 1; i >= 0; i--) {
      var c = caravans[i];

      /* A new colony leaves the old one's caravans behind. The seed is
         the cheapest honest way to tell one game from another. */
      if (g && c.seed !== g.seed) { caravans.splice(i, 1); continue; }

      var elapsed = now - c.lastTick;
      c.lastTick = now;
      if (elapsed <= 0) continue;
      if (elapsed > MAX_CATCHUP) elapsed = MAX_CATCHUP;

      feed(c, elapsed);
      tickBodies(c, elapsed);
      if (!c.pawns.length) { dissolveEmpty(c); caravans.splice(i, 1); continue; }

      if (c.state === 'travelling') {
        rollTravelEvents(c, elapsed);
        if (c.state !== 'travelling') continue;
        advance(c, elapsed);
        if (c.ticksToArrive <= 0) Caravans.arrive(c);
      } else if (c.state === 'trading') {
        c.waitTicks += elapsed;
        reopenDeal(c);
        /* Waiting is allowed to be indefinite - the trade screen is the
           player's to close - but an empty larder ends it for them. */
        if (c.food <= 0) {
          letter(c.label + ' is out of food',
            'The party at ' + destinationName(c) + ' has eaten the last of what they packed and is ' +
            'starting for home.', 'threat');
          Caravans.sendHome(c);
        }
      }

      if (c.state === 'done') caravans.splice(i, 1);
    }
  };

  function advance(c, elapsed) {
    c.ticksToArrive -= elapsed;
    if (c.ticksToArrive < 0) c.ticksToArrive = 0;
    c.progress = c.totalTicks > 0 ? U.clamp01(1 - c.ticksToArrive / c.totalTicks) : 1;

    var steps = c.path.length;
    if (!steps) { c.tile = c.destination; return; }
    var at = Math.round(c.progress * steps) - 1;
    c.tile = at < 0 ? c.originTile : c.path[Math.min(at, steps - 1)];
  }

  /* ------------------------------------------------------------------
     Eating out of the sack
     ------------------------------------------------------------------ */

  function bestFoodFor(caravan, pawn) {
    var best = null, bestScore = -1;
    for (var i = 0; i < caravan.items.length; i++) {
      var rec = caravan.items[i];
      if (rec.count <= 0) continue;
      var d = defOf(rec.defId);
      if (!d || !(d.nutrition > 0)) continue;
      /* Corpses are cargo, not rations; people do not eat them and the
         colony would rather they did not start. */
      if (d.id === 'corpse') continue;
      var kibble = d.foodType === 'kibble';
      if (pawn.isHuman && kibble) continue;
      if (pawn.isAnimal && d.foodType === 'meal') continue;
      /* Eat the thing that will spoil first, and prefer real food to raw. */
      var score = d.nutrition * 4 + (d.rotDays ? 6 / d.rotDays : 0);
      if (score > bestScore) { bestScore = score; best = rec; }
    }
    return best;
  }

  function feed(caravan, elapsed) {
    var days = elapsed / TICKS_PER_DAY;
    var needs = Nd();
    for (var i = 0; i < caravan.pawns.length; i++) {
      var pawn = caravan.pawns[i];
      var n = pawn.needs;
      if (!n || pawn.dead) continue;

      n.food = U.clamp01(n.food - 1.6 * days);
      if (n.food >= HUNGRY_AT) continue;

      var rec = bestFoodFor(caravan, pawn);
      if (!rec) continue;
      var d = defOf(rec.defId);
      var per = d.nutrition;
      var units = Math.floor((1 - n.food) / per + 1e-9);
      if (units < 1) units = 1;
      if (units > 30) units = 30;
      if (units > rec.count) units = rec.count;

      n.food = U.clamp01(n.food + units * per);
      rec.count -= units;
      if (rec.count <= 0) U.remove(caravan.items, rec);

      if (needs && pawn.isHuman) {
        if (d.foodType === 'raw') needs.addThought(pawn, 'ateRawFood');
        else if (d.id === 'mealFine') needs.addThought(pawn, 'ateFineMeal');
        else if (d.foodType === 'meal') needs.addThought(pawn, 'hadNiceMeal');
        /* There is no table in a river valley. */
        needs.addThought(pawn, 'ateWithoutTable');
      }
    }
    refreshCargo(caravan);
  }

  /* ------------------------------------------------------------------
     Bodies and moods on the road

     Nothing here calls Needs.tick or Pawn.tick: those advance the world
     by one tick and expect a map under the pawn's feet. The drift rates
     are the same ones needs.js uses, applied in one lump, and the
     expensive half - infection, bleeding, malnutrition, wounds closing -
     is handed straight to health.js, which is happy without a map.
     ------------------------------------------------------------------ */

  function tickBodies(caravan, elapsed) {
    var days = elapsed / TICKS_PER_DAY;
    var health = Hp(), needs = Nd();
    var rareTicks = Math.floor(elapsed / RARE);
    var dead = [];

    for (var i = 0; i < caravan.pawns.length; i++) {
      var pawn = caravan.pawns[i];
      if (pawn.dead) { dead.push(pawn); continue; }
      var n = pawn.needs;

      if (n) {
        /* They sleep rough, in shifts, and wake before they are ready:
           rest hovers below comfortable rather than filling or emptying. */
        n.rest = U.clamp01(U.approach(n.rest, 0.55, 0.9 * days));
        n.joy = U.clamp01(n.joy - 0.45 * days);
        n.comfort = U.clamp01(U.approach(n.comfort, 0.30, 1.2 * days));
        n.outdoors = U.clamp01(n.outdoors + 0.9 * days);
      }

      if (pawn.isHuman && needs) {
        caravan.sleepDebt = (caravan.sleepDebt || 0) + 0;
        if (days > 0) {
          needs.addThought(pawn, 'sleptOutside');
          needs.addThought(pawn, 'sleptOnGround');
        }
        ageThoughts(pawn, elapsed);
        if (needs.refreshSituationalThoughts) needs.refreshSituationalThoughts(pawn);
        if (needs.recomputeMood) needs.recomputeMood(pawn);
      }

      if (health && health.tickRare) {
        for (var r = 0; r < rareTicks && !pawn.dead; r++) health.tickRare(pawn);
      }
      if (pawn.dead) dead.push(pawn);
    }

    for (var d = 0; d < dead.length; d++) loseTraveller(caravan, dead[d], 'the road');
  }

  /* needs.js ages memories on its own rare tick, which these pawns never
     get. Same arithmetic, applied for however long they have been gone. */
  function ageThoughts(pawn, elapsed) {
    var list = pawn.thoughts;
    if (!list || !list.length) return;
    for (var i = list.length - 1; i >= 0; i--) {
      var t = list[i];
      if (t.situational) continue;
      t.ageTicks += elapsed;
      if (t.ageTicks >= t.durationTicks) {
        list.splice(i, 1);
        pawn._moodDirty = true;
      }
    }
  }

  function loseTraveller(caravan, pawn, cause) {
    if (!U.remove(caravan.pawns, pawn)) return;
    var needs = Nd();
    var survivors = caravan.pawns;
    var i;
    if (needs && pawn.isHuman) {
      for (i = 0; i < survivors.length; i++) {
        if (survivors[i].isHuman) needs.addThought(survivors[i], 'witnessedDeathAlly', { otherPawnId: pawn.id });
      }
      var g = G();
      var home = g && g.map ? g.map.colonists() : [];
      for (i = 0; i < home.length; i++) needs.addThought(home[i], 'colonistDied', { otherPawnId: pawn.id });
    }
    if (cause) {
      msg(nameOf(pawn) + ' died on the road (' + cause + ').', 'threat');
    }
    refreshCargo(caravan);
  }

  function dissolveEmpty(caravan) {
    caravan.state = 'done';
    letter(caravan.label + ' is gone',
      'Nobody is left with ' + caravan.label.toLowerCase() + '. Whatever they carried is out there ' +
      'somewhere on the way to ' + destinationName(caravan) + '.', 'death');
  }

  /* ------------------------------------------------------------------
     Travel events
     ------------------------------------------------------------------ */

  function rollTravelEvents(caravan, elapsed) {
    var days = elapsed / TICKS_PER_DAY;
    if (days <= 0) return;

    /* A war party is looking for trouble and tends to find it first. */
    var hostility = caravan.purpose === 'attack' ? 1.6 : 1;
    if (U.chance(AMBUSH_PER_DAY * days * hostility)) { Caravans.ambush(caravan); return; }
    if (U.chance(MEETING_PER_DAY * days)) { friendlyMeeting(caravan); return; }
    if (U.chance(CACHE_PER_DAY * days)) { findCache(caravan); return; }
    if (U.chance(STORM_PER_DAY * days)) { badWeather(caravan); }
  }

  function friendlyMeeting(caravan) {
    var fac = Fac();
    var pool = fac ? fac.all().filter(function (f) { return !f.hostile && !f.isPlayer; }) : [];
    if (!pool.length) return;
    var f = U.pick(pool);
    var gift = U.pick(['mealSimple', 'berries', 'herbalMedicine', 'cloth']);
    var count = U.randInt(4, 12);
    Caravans.addItem(caravan, gift, count);
    if (fac.noteHelpGiven) fac.noteHelpGiven(f.id, 'your caravan shared a fire with theirs');
    var needs = Nd();
    if (needs) {
      for (var i = 0; i < caravan.pawns.length; i++) {
        if (caravan.pawns[i].isHuman) needs.addThought(caravan.pawns[i], 'chatted');
      }
    }
    letter('A friendly meeting',
      caravan.label + ' shared a night fire with a party from ' + f.name + '. They traded news and ' +
      'pressed ' + count + ' ' + (defOf(gift) ? defOf(gift).label : gift) + ' on your people before parting.',
      'good');
  }

  function findCache(caravan) {
    var table = [
      { defId: 'silver', lo: 30, hi: 160 },
      { defId: 'steel', lo: 20, hi: 70 },
      { defId: 'components', lo: 1, hi: 4 },
      { defId: 'medicine', lo: 1, hi: 3 },
      { defId: 'cloth', lo: 10, hi: 35 },
      { defId: 'mealSimple', lo: 2, hi: 8 }
    ];
    var pick = U.pick(table);
    var count = U.randInt(pick.lo, pick.hi);
    var room = capacityOf(caravan.pawns) - caravan.mass;
    var each = stackMass(pick.defId, 1);
    if (each > 0) count = Math.min(count, Math.max(0, Math.floor(room / each)));
    if (count <= 0) {
      msg(caravan.label + ' passed an abandoned cache with no room to carry any of it.', 'info');
      return;
    }
    Caravans.addItem(caravan, pick.defId, count);
    letter('An abandoned cache',
      caravan.label + ' turned up a wrecked cart half buried in the scrub and stripped it of ' +
      count + ' ' + (defOf(pick.defId) ? defOf(pick.defId).label : pick.defId) + '.',
      'good');
  }

  function badWeather(caravan) {
    var extra = Math.round(caravan.ticksToArrive * U.randRange(0.15, 0.35));
    if (extra < 600) extra = 600;
    caravan.ticksToArrive += extra;
    caravan.totalTicks += extra;
    var needs = Nd();
    if (needs) {
      for (var i = 0; i < caravan.pawns.length; i++) {
        if (caravan.pawns[i].isHuman) needs.addThought(caravan.pawns[i], 'soakingWet');
      }
    }
    msg(caravan.label + ' is slowed by foul weather: ' + U.fmt(extra / TICKS_PER_DAY, 1) +
      ' days added to the journey.', 'info');
  }

  /* ------------------------------------------------------------------
     Abstract combat

     The whole point is that no second map is loaded, so both sides are
     reduced to a power number built out of the same stats the map would
     have consulted: what is in their hands, how good they are with it,
     and whether they are still standing up. Damage lands for real.
     ------------------------------------------------------------------ */

  function weaponDps(pawn) {
    var combat = root.Combat;
    var w = combat && combat.weaponOf ? combat.weaponOf(pawn) : null;
    if (w && w.ranged) {
      var cycle = (w.warmupTicks || 60) + (w.cooldownTicks || 60);
      var shots = w.burstCount || 1;
      return (w.damage || 8) * shots * 60 / Math.max(30, cycle);
    }
    if (w) return (w.damage || 8) * 60 / Math.max(30, w.cooldownTicks || 100);
    if (pawn.isAnimal) {
      var kind = pawn.kind || {};
      return (kind.meleeDamage || 5) * 60 / Math.max(40, kind.meleeCooldownTicks || 110);
    }
    /* Bare hands: slow, and it shows. */
    return 5 * 60 / 140;
  }

  function powerOf(pawn) {
    if (!pawn || pawn.dead || pawn.downed) return 0;
    var health = Hp();
    var cons = health && health.capacity ? health.capacity(pawn, 'consciousness') : 1;
    var manip = health && health.capacity ? health.capacity(pawn, 'manipulation') : 1;
    var move = health && health.capacity ? health.capacity(pawn, 'moving') : 1;
    if (cons < 0.3) return 0;

    var combat = root.Combat;
    var w = combat && combat.weaponOf ? combat.weaponOf(pawn) : null;
    var skill = pawn.skillLevel ? pawn.skillLevel(w && w.ranged ? 'shooting' : 'melee') : 0;
    var body = (0.35 + 0.65 * cons) * (0.5 + 0.5 * manip) * (0.7 + 0.3 * move);
    var size = pawn.bodySize !== undefined ? pawn.bodySize : 1;
    return weaponDps(pawn) * (0.55 + 0.045 * skill) * body * Math.sqrt(size);
  }

  Caravans.powerOf = powerOf;

  Caravans.strength = function (caravan) {
    return caravan ? U.sum(caravan.pawns, powerOf) : 0;
  };

  function makeEnemy(kindId, tier, index) {
    var kind = root.Defs && root.Defs.maybe ? root.Defs.maybe('pawnKind', kindId) : null;
    var scale = kind && typeof kind.combatPower === 'number' ? kind.combatPower / 60 : 1;
    var label = (kind && kind.label) || kindId || 'fighter';
    var hp = Math.round((36 + 30 * tier) * U.randRange(0.82, 1.2));
    return {
      name: label + ' ' + (index + 1),
      kindId: kindId,
      power: (2.4 + 5.8 * tier) * U.randRange(0.75, 1.3) * scale,
      hp: hp, maxHp: hp
    };
  }

  function makeEnemies(kindIds, count, tier) {
    var out = [];
    for (var i = 0; i < count; i++) {
      out.push(makeEnemy(kindIds.length ? U.pick(kindIds) : 'raider', tier, i));
    }
    return out;
  }

  function outsideParts(pawn) {
    var parts = pawn.health ? pawn.health.parts : null;
    if (!parts) return [];
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (!p.missing && p.depth === 'outside') out.push(p);
    }
    return out;
  }

  var WOUND_TYPES = ['bullet', 'cut', 'blunt', 'stab'];

  /* One abstract blow becomes one to three real wounds on real parts, so
     a survivor comes home with a shattered arm rather than with a number. */
  function wound(pawn, amount, source) {
    var health = Hp();
    if (!health || !health.damage || amount <= 0) return;
    var parts = outsideParts(pawn);
    var left = amount;
    var guard = 0;
    while (left > 0.5 && !pawn.dead && guard++ < 4) {
      var chunk = Math.min(left, MAX_WOUND * U.randRange(0.5, 1));
      left -= chunk;
      var part = parts.length
        ? U.pickWeighted(parts, function (p) { return Math.max(0.02, p.coverage || 0.1); })
        : null;
      health.damage(pawn, {
        amount: Math.round(chunk),
        type: U.pick(WOUND_TYPES),
        partId: part ? part.id : null,
        source: source || 'an ambush'
      });
      parts = outsideParts(pawn);
    }
  }

  /* Rounds of mutual attrition. The caravan focuses fire, which is what
     makes a strong party win decisively; the enemy spreads its fire,
     which is what makes a close fight cost limbs rather than lives. */
  function resolveBattle(caravan, enemies, opts) {
    opts = opts || {};
    var source = opts.source || 'an ambush';
    var startDead = 0, rounds = 0;
    var ourStart = caravan.pawns.slice();

    while (rounds++ < BATTLE_ROUNDS) {
      var ours = caravan.pawns.filter(function (p) { return !p.dead && !p.downed; });
      var theirs = enemies.filter(function (e) { return e.hp > 0; });
      if (!ours.length || !theirs.length) break;

      var ourPower = U.sum(ours, powerOf);
      var theirPower = U.sum(theirs, function (e) { return e.power; });
      if (ourPower <= 0 && theirPower <= 0) break;

      var incoming = theirPower * ROUND_DAMAGE * U.randRange(0.65, 1.35);
      var outgoing = ourPower * ROUND_DAMAGE * U.randRange(0.65, 1.35);

      var t = 0;
      while (outgoing > 0 && t < theirs.length) {
        var hit = Math.min(outgoing, theirs[t].hp);
        theirs[t].hp -= hit;
        outgoing -= hit;
        if (theirs[t].hp <= 0) startDead++;
        t++;
      }

      var share = incoming / ours.length;
      for (var i = 0; i < ours.length; i++) {
        /* The fighters at the front draw more of it. */
        var bias = U.randRange(0.55, 1.5);
        wound(ours[i], share * bias, source);
      }
      for (var d = caravan.pawns.length - 1; d >= 0; d--) {
        if (caravan.pawns[d].dead) loseTraveller(caravan, caravan.pawns[d], source);
      }
    }

    var standing = caravan.pawns.filter(function (p) { return !p.dead && !p.downed; });
    var enemiesLeft = enemies.filter(function (e) { return e.hp > 0; });
    var lost = ourStart.filter(function (p) { return caravan.pawns.indexOf(p) < 0; });
    var hurtList = caravan.pawns.filter(function (p) {
      return p.health && p.health.injuries && p.health.injuries.length;
    });

    return {
      won: !enemiesLeft.length && standing.length > 0,
      rounds: rounds,
      killed: startDead,
      enemiesLeft: enemiesLeft.length,
      dead: lost,
      wounded: hurtList,
      standing: standing.length
    };
  }

  Caravans.ambush = function (caravan) {
    if (!caravan || !caravan.pawns.length) return null;
    var fac = Fac();
    var g = G();

    var pool = fac ? fac.all().filter(function (f) { return f.hostile && !f.isPlayer; }) : [];
    var attacker = pool.length ? U.pick(pool) : null;
    var attackerName = attacker ? attacker.name : 'a band of pirates';
    var kinds = attacker && attacker.kind && attacker.kind.pawnKinds && attacker.kind.pawnKinds.raider
      ? attacker.kind.pawnKinds.raider : ['raider'];

    /* Sized against the party they found, plus how far into the game it
       is, so an early two-person run is not jumped by a warband. */
    var day = g && g.day ? g.day() : 0;
    var tier = U.clamp(day / 60 + U.randRange(-0.1, 0.2), 0, 1);
    var strength = Caravans.strength(caravan);
    var count = U.clamp(Math.round(strength / 4.5 * U.randRange(0.6, 1.15)), 1, 8);
    var enemies = makeEnemies(kinds, count, tier);

    caravan.state = 'travelling';
    var result = resolveBattle(caravan, enemies, { source: 'an ambush' });

    var lines = [attackerName + ' fell on ' + caravan.label.toLowerCase() + ' out of the scrub.'];
    if (result.won) {
      lines.push('Your people drove them off, killing ' + result.killed + ' of them.');
      var loot = lootFromEnemies(caravan, enemies, tier);
      if (loot) lines.push('They stripped ' + loot + ' off the bodies.');
      var needs = Nd();
      if (needs) {
        for (var i = 0; i < caravan.pawns.length; i++) {
          if (caravan.pawns[i].isHuman) needs.addThought(caravan.pawns[i], 'raidBeaten');
        }
      }
    } else if (!caravan.pawns.length) {
      lines.push('Nobody walked away.');
    } else {
      lines.push('Your people broke off and ran, leaving the road to them.');
      /* Fleeing costs distance as well as blood. */
      var setback = Math.round(caravan.ticksToArrive * 0.2) + 1200;
      caravan.ticksToArrive += setback;
      caravan.totalTicks += setback;
    }
    if (result.dead.length) lines.push('Dead: ' + listNames(result.dead) + '.');
    if (result.wounded.length) lines.push('Wounded: ' + listNames(result.wounded) + '.');

    letter('Ambush on the road', lines.join(' '), result.dead.length ? 'death' : 'threat');
    refreshCargo(caravan);
    return result;
  };

  function lootFromEnemies(caravan, enemies, tier) {
    var room = capacityOf(caravan.pawns) - caravan.mass;
    if (room <= 1) return null;
    var silver = Math.round(enemies.length * U.randRange(12, 40) * (0.6 + tier));
    var taken = [];
    if (silver > 0 && Caravans.addItem(caravan, 'silver', silver)) taken.push(silver + ' silver');
    room = capacityOf(caravan.pawns) - caravan.mass;
    if (room > 3 && U.chance(0.45)) {
      var gun = U.pick(tier > 0.5 ? ['boltRifle', 'autoRifle', 'shotgun'] : ['knife', 'club', 'shortBow', 'pistol']);
      if (stackMass(gun, 1) <= room) {
        Caravans.addItem(caravan, gun, 1);
        taken.push('a ' + (defOf(gun) ? defOf(gun).label : gun));
      }
    }
    return taken.length ? taken.join(' and ') : null;
  }

  /* ------------------------------------------------------------------
     Arrival
     ------------------------------------------------------------------ */

  Caravans.arrive = function (caravan) {
    if (!caravan) return;
    caravan.progress = 1;
    caravan.tile = caravan.destination;
    caravan.ticksToArrive = 0;

    if (caravan.purpose === 'return') return arriveHome(caravan);
    var settlement = W() ? W().settlementAt(caravan.tile) : null;
    if (settlement) caravan.settlementId = settlement.id;

    if (!settlement) {
      letter(caravan.label + ' found nothing',
        'There is no settlement on that tile - only weather and open ground. ' +
        'The party is turning for home.', 'neutral');
      return Caravans.sendHome(caravan);
    }
    if (caravan.purpose === 'attack') return arriveAttack(caravan, settlement);
    if (caravan.purpose === 'visit') return arriveVisit(caravan, settlement);
    return arriveTrade(caravan, settlement);
  };

  function arriveTrade(caravan, settlement) {
    var fac = Fac();
    var faction = fac ? fac.ofSettlement(settlement) : null;
    var kindDef = root.Defs && root.Defs.maybe ? root.Defs.maybe('settlementKind', settlement.kind) : null;

    if (faction && faction.hostile) {
      letter('No welcome at ' + settlement.name,
        'The gates of ' + settlement.name + ' stayed shut: ' + faction.name + ' does not trade with you. ' +
        'The party is turning for home.', 'threat');
      return Caravans.sendHome(caravan);
    }
    if (kindDef && kindDef.canTradeWith === false) {
      letter('Nothing for sale at ' + settlement.name,
        settlement.name + ' has no counter and no interest in yours. The party is turning for home.',
        'neutral');
      return Caravans.sendHome(caravan);
    }

    caravan.state = 'trading';
    caravan.waitTicks = 0;
    reopenDeal(caravan);
    letter(caravan.label + ' has arrived',
      listNames(caravan.pawns) + ' reached ' + settlement.name + ' and set out their goods. ' +
      (caravan.deal
        ? 'The market is open - settle the deal, then send them home.'
        : 'They are waiting at the market for your word.'),
      'good');
  }

  /* trade.js is optional, and a loaded save has a caravan at a market
     with no live Deal object, so the deal is opened lazily and re-opened
     whenever it is missing. */
  function reopenDeal(caravan) {
    if (caravan.deal || caravan.state !== 'trading') return caravan.deal;
    var settlement = settlementOf(caravan);
    if (!settlement || !root.Trade || !root.Trade.open) return null;
    caravan.deal = root.Trade.open(settlement, { caravan: caravan }) || null;
    return caravan.deal;
  }

  Caravans.deal = function (caravan) {
    return caravan ? reopenDeal(caravan) : null;
  };

  function arriveVisit(caravan, settlement) {
    var fac = Fac();
    var faction = fac ? fac.ofSettlement(settlement) : null;
    if (faction && faction.hostile) {
      letter('Turned away from ' + settlement.name,
        faction.name + ' met your party at the boundary stones with spears levelled. ' +
        'They are coming home.', 'threat');
      return Caravans.sendHome(caravan);
    }

    var gained = 0;
    if (faction && fac.noteHelpGiven) {
      gained = fac.noteHelpGiven(faction.id, 'your caravan paid respects at ' + settlement.name);
    }
    var needs = Nd();
    if (needs) {
      for (var i = 0; i < caravan.pawns.length; i++) {
        if (caravan.pawns[i].isHuman) needs.addThought(caravan.pawns[i], 'chatted');
      }
    }
    letter('A good visit to ' + settlement.name,
      listNames(caravan.pawns) + ' spent a day in ' + settlement.name +
      (faction ? ' as guests of ' + faction.name + '. Goodwill is now ' + Math.round(gained) + '.' : '.'),
      'good');
    Caravans.sendHome(caravan);
  }

  function arriveAttack(caravan, settlement) {
    var fac = Fac();
    var faction = fac ? fac.ofSettlement(settlement) : null;
    var kindDef = root.Defs && root.Defs.maybe ? root.Defs.maybe('settlementKind', settlement.kind) : null;
    var kinds = (kindDef && kindDef.defenders) || ['raider'];
    var range = (kindDef && kindDef.defenderCount) || [3, 6];
    var count = U.randInt(range[0], range[1]);
    var tier = U.clamp((settlement.wealth || 1000) / 9000, 0.15, 1);
    var enemies = makeEnemies(kinds, count, tier);

    var result = resolveBattle(caravan, enemies, { source: 'the raid on ' + settlement.name });
    var lines = ['Your war party hit ' + settlement.name + ', held by ' + count + ' defenders.'];

    if (result.won) {
      lines.push('The place fell. ' + result.killed + ' defenders died in the streets.');
      var haul = lootSettlement(caravan, settlement, tier);
      if (haul) lines.push('The party carried off ' + haul + '.');
      if (W()) W().destroySettlement(settlement);
      if (faction && fac.noteSettlementDestroyed) fac.noteSettlementDestroyed(settlement, 'your war party');
      else if (faction) fac.adjustGoodwill(faction.id, -75, 'you sacked ' + settlement.name);
      var needs = Nd();
      if (needs) {
        for (var i = 0; i < caravan.pawns.length; i++) {
          var p = caravan.pawns[i];
          if (!p.isHuman) continue;
          needs.addThought(p, (p.traits && p.traits.indexOf('bloodlust') >= 0) ? 'killedHumanBloodlust' : 'raidBeaten');
        }
      }
    } else {
      lines.push('The attack broke on their defences. ' + result.enemiesLeft + ' defenders still hold it.');
      if (faction) fac.adjustGoodwill(faction.id, -45, 'you attacked ' + settlement.name);
    }
    if (result.dead.length) lines.push('Dead: ' + listNames(result.dead) + '.');
    if (result.wounded.length) lines.push('Wounded: ' + listNames(result.wounded) + '.');

    letter(result.won ? settlement.name + ' has fallen' : 'The attack on ' + settlement.name + ' failed',
      lines.join(' '), result.dead.length ? 'death' : (result.won ? 'good' : 'threat'));

    caravan.settlementId = 0;
    if (caravan.pawns.length) Caravans.sendHome(caravan);
    else caravan.state = 'done';
  }

  function lootSettlement(caravan, settlement, tier) {
    var room = capacityOf(caravan.pawns) - caravan.mass;
    if (room <= 1) return 'nothing they could carry';
    var taken = [];
    var silver = Math.round((settlement.wealth || 800) * U.randRange(0.25, 0.5));
    var perSilver = stackMass('silver', 1) || 0.01;
    silver = Math.min(silver, Math.floor(room / perSilver));
    if (silver > 0) { Caravans.addItem(caravan, 'silver', silver); taken.push(silver + ' silver'); }

    var goods = ['steel', 'cloth', 'leather', 'components', 'medicine', 'mealSimple'];
    for (var i = 0; i < 3; i++) {
      room = capacityOf(caravan.pawns) - caravan.mass;
      if (room <= 1) break;
      var id = U.pick(goods);
      var each = stackMass(id, 1);
      if (each <= 0) continue;
      var n = Math.min(U.randInt(8, 40), Math.floor(room / each));
      if (n <= 0) continue;
      Caravans.addItem(caravan, id, n);
      taken.push(n + ' ' + (defOf(id) ? defOf(id).label : id));
    }
    return taken.length ? taken.join(', ') : 'nothing they could carry';
  }

  Caravans.sendHome = function (caravan) {
    if (!caravan) return null;
    var world = W();
    var home = caravan.homeTile;
    if (world) home = world.colonyTile;
    caravan.deal = null;
    caravan.settlementId = 0;
    caravan.purpose = 'return';
    caravan.label = 'Returning caravan';
    caravan.originTile = caravan.tile;
    caravan.destination = home;
    caravan.state = 'travelling';
    caravan.progress = 0;
    caravan.speed = partySpeed(caravan.pawns, caravan.mass, capacityOf(caravan.pawns));

    if (caravan.tile === home) { Caravans.arrive(caravan); return caravan; }
    var path = world ? world.pathBetween(caravan.tile, home) : null;
    if (!path || !path.length) {
      /* Stranded on the wrong side of an ocean. They walk what they can. */
      caravan.path = [home];
      caravan.totalTicks = caravan.ticksToArrive = TICKS_PER_DAY * 4;
      return caravan;
    }
    caravan.path = path;
    caravan.totalTicks = caravan.ticksToArrive = world.travelTicks(caravan.tile, home, caravan.speed);
    return caravan;
  };

  function sideTowards(fromTile, homeTile) {
    var world = W();
    if (!world) return 'n';
    var wide = world.w || 60;
    var dx = world.xOf(fromTile) - world.xOf(homeTile);
    if (dx > wide / 2) dx -= wide;
    if (dx < -wide / 2) dx += wide;
    var dy = world.yOf(fromTile) - world.yOf(homeTile);
    if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'e' : 'w';
    return dy >= 0 ? 's' : 'n';
  }

  function arriveHome(caravan) {
    var g = G();
    var map = g ? g.map : null;
    if (!map) { caravan.state = 'trading'; return; }

    var sides = [sideTowards(caravan.originTile, caravan.homeTile), 'n', 'e', 's', 'w'];
    var cells = [];
    for (var s = 0; s < sides.length && cells.length < caravan.pawns.length + 1; s++) {
      cells = root.MapGen ? root.MapGen.edgeSpawnCells(map, sides[s]) : [];
    }
    if (!cells.length) cells = [{ x: map.w >> 1, y: 0 }];

    /* Everyone lands near the same stretch of edge rather than strung out
       along it, so the player sees a party arrive, not a picket line. */
    var start = U.randInt(0, Math.max(0, cells.length - caravan.pawns.length - 1));
    var drop = cells[start];
    var i;
    for (i = 0; i < caravan.pawns.length; i++) {
      var pawn = caravan.pawns[i];
      var cell = cells[Math.min(cells.length - 1, start + i)];
      pawn.dead = false;
      pawn.map = map;
      pawn.job = null;
      pawn.driver = null;
      if (pawn.jobQueue) pawn.jobQueue.length = 0;
      pawn.spawn(map, cell.x, cell.y);
      if (pawn.needs && root.Needs && root.Needs.refreshSituationalThoughts) {
        root.Needs.refreshSituationalThoughts(pawn);
      }
    }
    for (i = 0; i < caravan.items.length; i++) {
      map.addItem(caravan.items[i].defId, drop.x, drop.y, caravan.items[i].count);
    }

    var carried = caravan.items.length;
    caravan.items = [];
    caravan.state = 'done';
    letter('The caravan is home',
      listNames(caravan.pawns) + ' walked back onto the map carrying ' + carried +
      (carried === 1 ? ' kind of goods' : ' kinds of goods') +
      '. Someone should haul it all inside before it rains.',
      'good', { x: drop.x, y: drop.y });
    var g2 = G();
    if (g2 && g2.msg) g2.msg('Caravan returned.', { type: 'good', x: drop.x, y: drop.y });
  }

  /* ------------------------------------------------------------------
     Player orders
     ------------------------------------------------------------------ */

  Caravans.recall = function (caravan) {
    if (!caravan || caravan.state === 'done') return false;
    if (caravan.purpose === 'return' && caravan.state === 'travelling') return false;
    var wasAt = destinationName(caravan);
    Caravans.sendHome(caravan);
    letter(caravan.label + ' turns back',
      'The party has abandoned the road to ' + wasAt + ' and is walking home. ' +
      U.fmt(Caravans.daysLeft(caravan), 1) + ' days out.', 'neutral');
    return true;
  };

  Caravans.abandon = function (caravan) {
    if (!caravan) return false;
    var i = caravans.indexOf(caravan);
    if (i >= 0) caravans.splice(i, 1);
    caravan.state = 'done';

    var lost = caravan.pawns.slice();
    var needs = Nd();
    var g = G();
    var home = g && g.map ? g.map.colonists() : [];
    for (var p = 0; p < lost.length; p++) {
      lost[p].lostToWorld = true;
      lost[p].map = null;
      if (!needs || !lost[p].isHuman) continue;
      for (var h = 0; h < home.length; h++) needs.addThought(home[h], 'colonistLost', { otherPawnId: lost[p].id });
    }
    caravan.pawns = [];
    caravan.items = [];
    letter('Caravan abandoned',
      listNames(lost) + ' walked off into the wild with everything they carried. ' +
      'They are not coming back.', 'death');
    return true;
  };

  /* ------------------------------------------------------------------
     The reference audit

     detach() cuts the colony's links to a departing pawn. This checks the
     same list from the other end, and is what the tests and Game.debug
     use to prove the cut held. An empty array is the passing result.
     ------------------------------------------------------------------ */

  Caravans.auditColony = function (map) {
    var out = [];
    var g = G();
    map = map || (g ? g.map : null);
    if (!map) return out;

    var away = new Map();
    var i, j;
    for (i = 0; i < caravans.length; i++) {
      for (j = 0; j < caravans[i].pawns.length; j++) away.set(caravans[i].pawns[j].id, caravans[i].pawns[j]);
    }
    if (!away.size) return out;

    away.forEach(function (pawn) {
      if (map.pawns.indexOf(pawn) >= 0) out.push(nameOf(pawn) + ' is still in map.pawns');
      if (pawn.map === map) out.push(nameOf(pawn) + ' still points at the colony map');
      if (map.pawnsAt(pawn.x, pawn.y).indexOf(pawn) >= 0) {
        out.push(nameOf(pawn) + ' is still in the cell index at ' + pawn.x + ',' + pawn.y);
      }
      if (g && g.selection && g.selection.indexOf(pawn) >= 0) {
        out.push(nameOf(pawn) + ' is still selected');
      }
      if (root.Res && root.Res.reservedBy) {
        /* A reservation table entry survives as an id, so ask the table
           who holds the pawn's own cell and thing claims. */
        var holder = root.Res.reservedBy(map, { k: 'p', id: pawn.id });
        if (holder) out.push(nameOf(pawn) + ' is still reserved by ' + nameOf(holder));
      }
      if (root.Combat && root.Combat.stanceOf && root.Combat.stanceOf(pawn)) {
        out.push(nameOf(pawn) + ' still holds a combat stance');
      }
    });

    for (i = 0; i < map.pawns.length; i++) {
      var other = map.pawns[i];
      if (other.master !== null && other.master !== undefined && away.has(other.master)) {
        out.push(nameOf(other) + ' still follows a master who left');
      }
      if (other.aimTarget && other.aimTarget.k === 'p' && away.has(other.aimTarget.id)) {
        out.push(nameOf(other) + ' is still aiming at someone who left');
      }
      if (other.job) {
        var keys = ['targetA', 'targetB', 'targetC'];
        for (j = 0; j < keys.length; j++) {
          var t = other.job[keys[j]];
          if (t && t.k === 'p' && away.has(t.id)) {
            out.push(nameOf(other) + ' has a job targeting someone who left');
          }
        }
      }
    }
    return out;
  };

  /* ------------------------------------------------------------------
     Save and load

     The pawns are the real difficulty: they carry a map reference, a
     kind def and Thing objects with def references, none of which are
     JSON. Everything on the skip list is rebuilt on load rather than
     stored, which is also what guarantees the copy has no cycles.
     ------------------------------------------------------------------ */

  var SKIP = {
    map: 1, kind: 1, def: 1, job: 1, driver: 1, jobQueue: 1,
    path: 1, pathDest: 1, aimTarget: 1, draftTarget: 1, _traitFx: 1, _pathCache: 1
  };

  function plain(value, depth) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') return typeof value === 'function' ? undefined : value;
    if (depth > 8) return null;
    if (Array.isArray(value)) {
      var arr = [];
      for (var i = 0; i < value.length; i++) {
        var v = plain(value[i], depth + 1);
        if (v !== undefined) arr.push(v);
      }
      return arr;
    }
    var out = {};
    var keys = Object.keys(value);
    for (var k = 0; k < keys.length; k++) {
      if (SKIP[keys[k]]) continue;
      var pv = plain(value[keys[k]], depth + 1);
      if (pv !== undefined) out[keys[k]] = pv;
    }
    return out;
  }

  function rebindThing(thing) {
    if (thing && !thing.def) thing.def = defOf(thing.defId);
    return thing;
  }

  function restorePawn(data) {
    if (!data) return null;
    if (root.Pawn && root.Pawn.rebind) root.Pawn.rebind(data, null);
    data.map = null;
    rebindThing(data.equipment);
    rebindThing(data.carried);
    var i;
    for (i = 0; i < (data.apparel || []).length; i++) rebindThing(data.apparel[i]);
    for (i = 0; i < (data.inventory || []).length; i++) rebindThing(data.inventory[i]);
    return data;
  }

  Caravans.save = function () {
    return {
      v: 1,
      caravans: caravans.map(function (c) {
        return {
          id: c.id, seed: c.seed, purpose: c.purpose, state: c.state, label: c.label,
          tile: c.tile, originTile: c.originTile, homeTile: c.homeTile,
          destination: c.destination, path: c.path.slice(),
          progress: c.progress, ticksToArrive: c.ticksToArrive, totalTicks: c.totalTicks,
          speed: c.speed, settlementId: c.settlementId,
          departTick: c.departTick, lastTick: c.lastTick, waitTicks: c.waitTicks,
          items: c.items.map(function (it) { return { defId: it.defId, count: it.count }; }),
          pawns: c.pawns.map(function (p) { return plain(p, 0); })
        };
      })
    };
  };

  Caravans.load = function (obj) {
    caravans.length = 0;
    if (!obj || !obj.caravans) return false;
    for (var i = 0; i < obj.caravans.length; i++) {
      var s = obj.caravans[i];
      var c = {
        id: s.id || U.nextId(),
        seed: s.seed || (G() ? G().seed : 0),
        pawns: (s.pawns || []).map(restorePawn).filter(Boolean),
        items: (s.items || []).map(function (it) { return { defId: it.defId, count: it.count }; }),
        tile: s.tile | 0, originTile: s.originTile | 0, homeTile: s.homeTile | 0,
        path: (s.path || []).slice(),
        progress: s.progress || 0,
        destination: s.destination | 0,
        purpose: s.purpose || 'return',
        ticksToArrive: s.ticksToArrive || 0,
        totalTicks: s.totalTicks || 1,
        food: 0, mass: 0,
        speed: s.speed || 1,
        state: s.state || 'travelling',
        settlementId: s.settlementId || 0,
        deal: null,
        departTick: s.departTick || 0,
        lastTick: s.lastTick === undefined ? gameTick() : s.lastTick,
        waitTicks: s.waitTicks || 0,
        label: s.label || 'Caravan'
      };
      refreshCargo(c);
      caravans.push(c);
    }
    return true;
  };

  Caravans.reset = function () {
    caravans.length = 0;
    return Caravans;
  };

  root.Caravans = Caravans;
})(this);
