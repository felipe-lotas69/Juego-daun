/* ============================================================
   caravan.js - voyages.

   The colony map is one tile of a planet, and this is the only way
   off it.

   Two rules shape everything below. First, a caravan owns its pawns
   outright: they are the same Pawn objects that walked the colony,
   so a wound taken in an ambush is still bleeding when they come
   home and the cook who left at level nine comes back at level
   nine. The price is that the colony must not keep a single
   reference to them while they are gone - see detach(), and
   auditColony() which checks the same list from the other end.

   Second, nothing here loads a second map. An ambush and a raid on
   a settlement are arithmetic over the same combat stats the map
   would have consulted, but the injuries land on real body parts
   through Health.damage, so people really do come home crippled.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;

  var TICKS_PER_DAY = 60000;
  var RARE = 250;                      /* health.js advances one rare tick per call */
  var MAX_CATCHUP = TICKS_PER_DAY * 2;

  /* Per caravan per day on the road. A three-day trade run is meant to be
     worth doing; these are the odds that make it a decision. */
  var AMBUSH_PER_DAY = 0.09;
  var MEETING_PER_DAY = 0.08;
  var CACHE_PER_DAY = 0.06;
  var STORM_PER_DAY = 0.12;

  var BATTLE_ROUNDS = 7;
  var ROUND_DAMAGE = 3.0;              /* hit points one point of power lands per round */
  var ROUT_POWER = 0.4;                /* a side that has lost this much of its strength runs */
  var MAX_WOUND = 17;
  var LOAD_SLOW_FLOOR = 0.55;
  var HUNGRY = 0.30;                   /* needs.js's own threshold, if it is loaded */

  var caravans = [];
  var Caravans = { all: caravans };

  /* events.js, game.js and save.js all load after this file, and trade.js
     may be absent from a cut-down build, so they are looked up when used. */
  function G() { return root.Game || null; }
  function W() { return root.World || null; }
  function Fac() { return root.Factions || null; }
  function Hp() { return root.Health || null; }
  function Nd() { return root.Needs || null; }
  function gameTick() { var g = G(); return g && g.tick !== undefined ? g.tick : 0; }

  function letter(title, text, kind, at) {
    var g = G();
    if (!g || !g.letter) return null;
    return g.letter(title, text, { kind: kind || 'neutral', x: at ? at.x : undefined, y: at ? at.y : undefined });
  }
  function msg(text, type) { var g = G(); if (g && g.msg) g.msg(text, { type: type || 'info' }); }
  function defOf(id) { return root.Defs && root.Defs.maybe ? root.Defs.maybe('thing', id) : null; }
  function labelOf(id) { var d = defOf(id); return d ? d.label : id; }

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    if (pawn.fullName) return pawn.fullName();
    return (pawn.name && (pawn.name.nick || pawn.name.first)) || 'someone';
  }
  function listNames(pawns) {
    var n = pawns.map(nameOf);
    if (n.length <= 1) return n[0] || 'nobody';
    return n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1];
  }

  /* ------------------------------------------------------------------
     Cargo

     A caravan's goods are a ledger of {defId, count}: Things only exist
     on a map and these are off it. Weapons and clothes people actually
     wear stay Things, on the pawn wearing them.
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

  /* Accepts the UI's {defId, count} rows and live Things alike, so a float
     menu can hand over the stack the cursor happens to be on. */
  function normaliseItems(items) {
    var out = [];
    for (var i = 0; items && i < items.length; i++) {
      var it = items[i];
      if (!it) continue;
      var id = it.defId || (it.def && it.def.id) || null;
      var n = Math.floor(it.count !== undefined ? it.count : (it.stack !== undefined ? it.stack : 1));
      if (id && n > 0) addTo(out, id, n);
    }
    return out;
  }

  function stackMass(defId, count) { var d = defOf(defId); return d ? (d.mass || 0) * count : 0; }

  function tally(list, field) {
    var total = 0;
    for (var i = 0; i < list.length; i++) {
      var d = defOf(list[i].defId);
      if (d && d[field] > 0) total += d[field] * list[i].count;
    }
    return total;
  }
  function itemsMass(list) { return tally(list, 'mass'); }
  function itemsNutrition(list) { return tally(list, 'nutrition'); }

  /* Worn clothes ride on the wearer for free; a rifle over a shoulder and
     a sack of steel in a pack both weigh. */
  function gearMass(pawn) {
    var m = 0, i, inv = pawn.inventory || [];
    if (pawn.carried && pawn.carried.def) m += (pawn.carried.def.mass || 0) * (pawn.carried.stack || 1);
    if (pawn.equipment && pawn.equipment.def) m += pawn.equipment.def.mass || 0;
    for (i = 0; i < inv.length; i++) {
      if (inv[i] && inv[i].def) m += (inv[i].def.mass || 0) * (inv[i].stack || 1);
    }
    return m;
  }

  function refreshCargo(c) {
    c.food = itemsNutrition(c.items);
    c.mass = itemsMass(c.items) + U.sum(c.pawns, gearMass);
    return c;
  }

  Caravans.countOf = function (c, defId) {
    for (var i = 0; c && i < c.items.length; i++) if (c.items[i].defId === defId) return c.items[i].count;
    return 0;
  };

  Caravans.addItem = function (c, defId, count) {
    if (!c || !(count > 0)) return 0;
    count = Math.floor(count);
    addTo(c.items, defId, count);
    refreshCargo(c);
    return count;
  };

  Caravans.removeItem = function (c, defId, count) {
    if (!c || !(count > 0)) return 0;
    for (var i = 0; i < c.items.length; i++) {
      if (c.items[i].defId !== defId) continue;
      var took = Math.min(c.items[i].count, Math.floor(count));
      c.items[i].count -= took;
      if (c.items[i].count <= 0) c.items.splice(i, 1);
      refreshCargo(c);
      return took;
    }
    return 0;
  };

  Caravans.goods = function (c) {
    return c ? c.items.map(function (it) { return { defId: it.defId, count: it.count }; }) : [];
  };

  Caravans.freeMass = function (c) { return c ? capacityOf(c.pawns) - c.mass : 0; };

  /* ------------------------------------------------------------------
     Forming
     ------------------------------------------------------------------ */

  function no(reason) { return { ok: false, reason: reason }; }

  function capacityOf(pawns) {
    var cap = 0;
    for (var i = 0; i < pawns.length; i++) {
      if (pawns[i] && !pawns[i].dead) {
        cap += pawns[i].carryCapacity !== undefined ? pawns[i].carryCapacity : 35;
      }
    }
    return cap;
  }

  /* Half loaded is free; past that the weight drags on the whole party,
     which is what makes a pack muffalo worth bringing. */
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
      var p = pawns[i], who = nameOf(p);
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

    /* game.js calls the colony lost the moment no colonist is left standing
       on the map, and a caravan is not a reason to lose the game. */
    var g = G();
    if (g && g.map && g.map.colonists) {
      var staying = g.map.colonists().filter(function (p) { return pawns.indexOf(p) < 0; });
      if (!staying.length) return no('Someone has to stay and mind the colony.');
    }

    var capacity = capacityOf(pawns);
    var load = itemsMass(goods) + U.sum(pawns, gearMass);
    if (load > capacity) {
      return no('Too much to carry: ' + U.fmt(load, 1) + ' kg of ' + U.fmt(capacity, 0) +
        '. Leave ' + U.fmt(load - capacity, 1) + ' kg behind or bring a pack animal.');
    }

    var nutrition = itemsNutrition(goods);
    if (nutrition <= 0) return no('No food packed. They would starve before they got anywhere.');

    return {
      ok: true, reason: '', capacity: capacity, load: load, nutrition: nutrition,
      foodDays: nutrition / (pawns.length * 1.6),
      speed: partySpeed(pawns, load, capacity)
    };
  };

  /* Every number the caravan dialog draws, so the UI never has to repeat
     any of the arithmetic above. */
  Caravans.plan = function (pawns, items, destinationTile) {
    pawns = (Array.isArray(pawns) ? pawns : []).filter(Boolean);
    var goods = normaliseItems(items);
    var capacity = capacityOf(pawns);
    var load = itemsMass(goods) + U.sum(pawns, gearMass);
    var speed = partySpeed(pawns, load, capacity);
    var world = W();
    var ticks = (world && destinationTile !== undefined && destinationTile !== null)
      ? world.travelTicks(world.colonyTile, destinationTile, speed) : 0;
    var days = ticks / TICKS_PER_DAY;
    return {
      capacity: capacity, load: load, speed: speed, ticks: ticks, days: days,
      nutrition: itemsNutrition(goods),
      /* A round trip: they have to eat their way home as well. */
      nutritionNeeded: Math.max(1, pawns.length) * 1.6 * days * 2,
      value: tally(goods, 'marketValue'),
      check: Caravans.canForm(pawns, goods)
    };
  };

  /* Whole stacks first, so the colony floor is left tidy rather than
     dusted with ones and twos. */
  function takeFromMap(map, defId, want) {
    if (!map || !(want > 0)) return 0;
    var list = map.byDef(defId).slice(), got = 0;
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
    return ['targetA', 'targetB', 'targetC'].some(function (k) {
      var t = job[k];
      return !!(t && t.k === 'p' && t.id === id);
    });
  }

  /* The dangerous half of this file. A pawn on a caravan is not in
     map.pawns, so anything on the map still pointing at them points at
     someone who is not there: a doctor walking over to tend them, an
     animal following a master a hundred tiles of planet away, a stance in
     combat.js keyed by their id, a reservation nobody will ever release.
     Every one of those links is cut here, in one place. */
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

    for (var i = 0; map && i < map.pawns.length; i++) {
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

    /* deSpawn unhooks the per-cell index; nulling the map afterwards is
       what stops health.js dropping a corpse into the colony if this pawn
       dies halfway across the planet. The bed they own is deliberately
       left owned - it should still be theirs when they get back. */
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
    var dest = (opts.destinationTile === undefined || opts.destinationTile === null) ? from : opts.destinationTile;
    if (dest === from) { msg('Caravan refused: that is where you already are.', 'info'); return null; }

    var path = world.pathBetween(from, dest);
    if (!path || !path.length) {
      msg('Caravan refused: there is no land route to that tile.', 'info');
      return null;
    }
    var ticks = world.travelTicks(from, dest, check.speed);
    var map = g ? g.map : (pawns[0] && pawns[0].map);

    /* Cargo comes off the floor before anyone leaves, so a caravan that
       could not be fully supplied sails with a short ledger rather than
       with goods conjured out of nothing. */
    var packed = [], i;
    if (map) {
      for (i = 0; i < goods.length; i++) {
        var took = takeFromMap(map, goods[i].defId, goods[i].count);
        if (took > 0) addTo(packed, goods[i].defId, took);
      }
    } else {
      packed = goods;
    }

    /* canForm checked the ledger the dialog offered; this checks what was
       actually on the floor. If the food was eaten or hauled off while the
       player was choosing, put everything back rather than march people
       into the world with an empty larder. */
    if (itemsNutrition(packed) <= 0) {
      for (i = 0; map && i < packed.length; i++) {
        map.addItem(packed[i].defId, pawns[0].x, pawns[0].y, packed[i].count);
      }
      msg('Caravan refused: the food you packed is not in the colony any more.', 'info');
      return null;
    }

    for (var p = 0; p < pawns.length; p++) detach(pawns[p], map);

    var settlement = world.settlementAt(dest);
    var c = {
      id: U.nextId(), seed: g ? g.seed : 0,
      pawns: pawns, items: packed,
      tile: from, originTile: from, homeTile: from,
      path: path, progress: 0, destination: dest,
      purpose: opts.purpose || 'trade',
      ticksToArrive: ticks, totalTicks: ticks,
      food: 0, mass: 0, speed: check.speed,
      state: 'travelling',
      settlementId: settlement ? settlement.id : 0,
      deal: null,
      departTick: gameTick(), lastTick: gameTick(),
      waitTicks: 0, campDay: -1, holedUp: false,
      label: opts.label || null
    };
    c.label = c.label || defaultLabel(c);
    refreshCargo(c);
    caravans.push(c);

    letter(c.label + ' departs',
      listNames(pawns) + ' set out for ' + destinationName(c) + ' with ' + U.fmt(c.mass, 0) +
      ' kg of goods and ' + U.fmt(check.foodDays, 1) + ' days of food. About ' +
      U.fmt(ticks / TICKS_PER_DAY, 1) + ' days each way.', 'neutral');
    return c;
  };

  function defaultLabel(c) {
    if (c.purpose === 'attack') return 'War party';
    if (c.purpose === 'visit') return 'Diplomatic caravan';
    if (c.purpose === 'return') return 'Returning caravan';
    return 'Trade caravan';
  }

  function settlementOf(c) {
    var world = W();
    if (!world || !c.settlementId) return null;
    var s = world.settlementById(c.settlementId);
    return s && !s.destroyed ? s : null;
  }

  function destinationName(c) {
    var world = W();
    var s = settlementOf(c) || (world && world.settlementAt(c.destination));
    if (s) return s.name;
    return c.destination === c.homeTile ? 'home' : 'tile ' + c.destination;
  }

  function standing(c) {
    return c.pawns.filter(function (p) { return !p.dead && !p.downed; });
  }

  Caravans.daysLeft = function (c) { return c ? Math.max(0, c.ticksToArrive) / TICKS_PER_DAY : 0; };
  Caravans.standing = function (c) { return c ? standing(c) : []; };
  Caravans.atTile = function (tile) { return caravans.filter(function (c) { return c.tile === tile; }); };
  Caravans.strength = function (c) { return c ? U.sum(c.pawns, powerOf) : 0; };

  Caravans.describe = function (c) {
    if (!c) return '';
    var head = c.label + ' - ' + destinationName(c);
    if (c.state === 'trading') return head + ' (at the market)';
    return head + ', ' + U.fmt(Caravans.daysLeft(c), 1) + ' days out';
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
      /* A new colony leaves the old one's caravans behind. Game.newGame
         does not know this file exists, so a caravan that belongs to a
         different seed, or that has already been ticked past the clock it
         is being handed, is from a game that is over. (save.js should
         still call Caravans.reset(); this is the belt to that braces.) */
      if (g && (c.seed !== g.seed || c.lastTick > now || c.departTick > now)) {
        caravans.splice(i, 1);
        continue;
      }

      var elapsed = now - c.lastTick;
      c.lastTick = now;
      if (elapsed <= 0) continue;
      if (elapsed > MAX_CATCHUP) elapsed = MAX_CATCHUP;

      feed(c, elapsed);
      tickBodies(c, elapsed);
      if (!c.pawns.length) {
        letter(c.label + ' is gone',
          'Nobody is left with ' + c.label.toLowerCase() + '. Whatever they carried is out there ' +
          'somewhere short of ' + destinationName(c) + '.', 'death');
        caravans.splice(i, 1);
        continue;
      }

      /* A party with nobody left on their feet does not crawl onward and
         does not storm a town. They lie up where they fell and heal, which
         health.js is already doing for them above. */
      if (!standing(c).length) {
        if (!c.holedUp) {
          c.holedUp = true;
          letter(c.label + ' has gone to ground',
            'Not one of them can stand. ' + listNames(c.pawns) + ' are lying up where they fell ' +
            'and will not move until somebody can walk.', 'threat');
        }
        continue;
      }
      if (c.holedUp) {
        c.holedUp = false;
        msg(c.label + ' is back on its feet and moving again.', 'good');
      }

      if (c.state === 'travelling') {
        rollTravelEvents(c, elapsed);
        advance(c, elapsed);
        if (c.ticksToArrive <= 0) Caravans.arrive(c);
      } else if (c.state === 'trading') {
        c.waitTicks += elapsed;
        reopenDeal(c);
        /* Waiting is allowed to be indefinite - closing the trade screen is
           the player's business - but an empty larder ends it for them. */
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
    c.ticksToArrive = Math.max(0, c.ticksToArrive - elapsed);
    c.progress = c.totalTicks > 0 ? U.clamp01(1 - c.ticksToArrive / c.totalTicks) : 1;
    var steps = c.path.length;
    if (!steps) { c.tile = c.destination; return; }
    var at = Math.round(c.progress * steps) - 1;
    c.tile = at < 0 ? c.originTile : c.path[Math.min(at, steps - 1)];
  }

  /* ------------------------------------------------------------------
     Eating out of the sack
     ------------------------------------------------------------------ */

  function bestFoodFor(c, pawn) {
    var best = null, bestScore = -1;
    for (var i = 0; i < c.items.length; i++) {
      var rec = c.items[i];
      if (rec.count <= 0) continue;
      var d = defOf(rec.defId);
      if (!d || !(d.nutrition > 0) || d.id === 'corpse') continue;
      if (pawn.isHuman && d.foodType === 'kibble') continue;
      if (pawn.isAnimal && d.foodType === 'meal') continue;
      /* Eat what will spoil first, and prefer a cooked meal to raw grain. */
      var score = d.nutrition * 4 + (d.rotDays ? 6 / d.rotDays : 0);
      if (score > bestScore) { bestScore = score; best = rec; }
    }
    return best;
  }

  function hungryAt() {
    var needs = Nd();
    return needs && needs.thresholds ? needs.thresholds.hungry : HUNGRY;
  }

  function feed(c, elapsed) {
    var days = elapsed / TICKS_PER_DAY, needs = Nd();
    for (var i = 0; i < c.pawns.length; i++) {
      var pawn = c.pawns[i], n = pawn.needs;
      if (!n || pawn.dead) continue;

      n.food = U.clamp01(n.food - 1.6 * days);
      if (n.food >= 0.999) continue;

      var rec = bestFoodFor(c, pawn);
      if (!rec) continue;                       /* nothing left: they starve, and health.js notices */
      var d = defOf(rec.defId);
      var room = 1 - n.food;
      /* Breaking open a meal to top up a nearly full stomach throws most
         of it away, so a big ration waits until the whole thing fits or
         until they are properly hungry. Berries and grain, being small,
         top up continuously the way grazing does. */
      if (room < d.nutrition && n.food > hungryAt()) continue;
      /* Whole units that fit, never one more - the epsilon is what stops
         0.6/0.05 coming out as eleven berries instead of twelve. */
      var units = U.clamp(Math.floor(room / d.nutrition + 1e-9), 1, 30);
      if (units > rec.count) units = rec.count;

      n.food = U.clamp01(n.food + units * d.nutrition);
      rec.count -= units;
      if (rec.count <= 0) U.remove(c.items, rec);

      if (needs && pawn.isHuman) {
        if (d.foodType === 'raw') needs.addThought(pawn, 'ateRawFood');
        else if (d.id === 'mealFine') needs.addThought(pawn, 'ateFineMeal');
        else if (d.foodType === 'meal') needs.addThought(pawn, 'hadNiceMeal');
        needs.addThought(pawn, 'ateWithoutTable');   /* there is no table in a river valley */
      }
    }
    refreshCargo(c);
  }

  /* ------------------------------------------------------------------
     Bodies and moods on the road

     Nothing here calls Needs.tick or Pawn.tick: those advance the world by
     one tick and expect a map under the pawn's feet. The drift rates are
     the ones needs.js uses, applied in one lump, and the expensive half -
     bleeding, infection, malnutrition, wounds closing - goes straight to
     health.js, which is happy without a map.
     ------------------------------------------------------------------ */

  function tickBodies(c, elapsed) {
    var days = elapsed / TICKS_PER_DAY;
    var health = Hp(), needs = Nd();
    var rareTicks = Math.floor(elapsed / RARE);
    var day = Math.floor((G() ? G().tick : 0) / TICKS_PER_DAY);
    var newCamp = day !== c.campDay;
    c.campDay = day;

    for (var i = c.pawns.length - 1; i >= 0; i--) {
      var pawn = c.pawns[i], n = pawn.needs;
      if (pawn.dead) { loseTraveller(c, pawn, 'the road'); continue; }

      if (n) {
        /* They sleep rough, in shifts, and wake before they are ready, so
           rest hovers under comfortable instead of filling or emptying. */
        n.rest = U.clamp01(U.approach(n.rest, 0.55, 0.9 * days));
        n.joy = U.clamp01(n.joy - 0.45 * days);
        n.comfort = U.clamp01(U.approach(n.comfort, 0.30, 1.2 * days));
        n.outdoors = U.clamp01(n.outdoors + 0.9 * days);
      }

      if (pawn.isHuman && needs) {
        if (newCamp) {
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
      if (pawn.dead) loseTraveller(c, pawn, 'the road');
    }
  }

  /* needs.js ages memories on a rare tick these pawns never get. Same
     arithmetic, applied for however long they have been gone. */
  function ageThoughts(pawn, elapsed) {
    var list = pawn.thoughts;
    for (var i = list ? list.length - 1 : -1; i >= 0; i--) {
      var t = list[i];
      if (t.situational) continue;
      t.ageTicks += elapsed;
      if (t.ageTicks >= t.durationTicks) { list.splice(i, 1); pawn._moodDirty = true; }
    }
  }

  function loseTraveller(c, pawn, cause) {
    if (!U.remove(c.pawns, pawn)) return;
    var needs = Nd(), g = G(), i;
    if (needs && pawn.isHuman) {
      for (i = 0; i < c.pawns.length; i++) {
        if (c.pawns[i].isHuman) needs.addThought(c.pawns[i], 'witnessedDeathAlly', { otherPawnId: pawn.id });
      }
      /* The colony grieves even though no one there saw it: health.js
         cannot spread the news itself with the pawn off the map. */
      var home = g && g.map ? g.map.colonists() : [];
      for (i = 0; i < home.length; i++) needs.addThought(home[i], 'colonistDied', { otherPawnId: pawn.id });
    }
    if (cause) msg(nameOf(pawn) + ' died on the road (' + cause + ').', 'threat');
    refreshCargo(c);
  }

  /* ------------------------------------------------------------------
     Travel events
     ------------------------------------------------------------------ */

  function rollTravelEvents(c, elapsed) {
    var days = elapsed / TICKS_PER_DAY;
    if (days <= 0) return;
    /* A war party is looking for trouble and tends to find it first. */
    var hostility = c.purpose === 'attack' ? 1.6 : 1;
    if (U.chance(AMBUSH_PER_DAY * days * hostility)) { Caravans.ambush(c); return; }
    if (U.chance(MEETING_PER_DAY * days)) { friendlyMeeting(c); return; }
    if (U.chance(CACHE_PER_DAY * days)) { findCache(c); return; }
    if (U.chance(STORM_PER_DAY * days)) badWeather(c);
  }

  function friendlyMeeting(c) {
    var fac = Fac();
    var pool = fac ? fac.all().filter(function (f) { return !f.hostile && !f.isPlayer; }) : [];
    if (!pool.length) return;
    var f = U.pick(pool);
    var gift = U.pick(['mealSimple', 'berries', 'herbalMedicine', 'cloth']);
    var count = U.randInt(4, 12);
    Caravans.addItem(c, gift, count);
    if (fac.noteHelpGiven) fac.noteHelpGiven(f.id, 'your caravan shared a fire with theirs');
    thoughtForAll(c, 'chatted');
    letter('A friendly meeting',
      c.label + ' shared a night fire with a party from ' + f.name + '. They traded news, and pressed ' +
      count + ' ' + labelOf(gift) + ' on your people before parting.', 'good');
  }

  function findCache(c) {
    var table = [
      { defId: 'silver', lo: 30, hi: 160 }, { defId: 'steel', lo: 20, hi: 70 },
      { defId: 'components', lo: 1, hi: 4 }, { defId: 'medicine', lo: 1, hi: 3 },
      { defId: 'cloth', lo: 10, hi: 35 }, { defId: 'mealSimple', lo: 2, hi: 8 }
    ];
    var pick = U.pick(table);
    var count = U.randInt(pick.lo, pick.hi);
    var each = stackMass(pick.defId, 1);
    if (each > 0) count = Math.min(count, Math.max(0, Math.floor(Caravans.freeMass(c) / each)));
    if (count <= 0) {
      msg(c.label + ' passed an abandoned cache with no room to carry any of it.', 'info');
      return;
    }
    Caravans.addItem(c, pick.defId, count);
    letter('An abandoned cache',
      c.label + ' turned up a wrecked cart half buried in the scrub and stripped it of ' +
      count + ' ' + labelOf(pick.defId) + '.', 'good');
  }

  function badWeather(c) {
    var extra = Math.max(600, Math.round(c.ticksToArrive * U.randRange(0.15, 0.35)));
    c.ticksToArrive += extra;
    c.totalTicks += extra;
    thoughtForAll(c, 'soakingWet');
    msg(c.label + ' is slowed by foul weather: ' + U.fmt(extra / TICKS_PER_DAY, 1) +
      ' days added to the journey.', 'info');
  }

  function thoughtForAll(c, thoughtId) {
    var needs = Nd();
    if (!needs) return;
    for (var i = 0; i < c.pawns.length; i++) {
      if (c.pawns[i].isHuman) needs.addThought(c.pawns[i], thoughtId);
    }
  }

  /* ------------------------------------------------------------------
     Abstract combat

     No second map is loaded, so both sides become a power number built
     from the stats the map would have consulted: what is in their hands,
     how good they are with it, and whether they are still upright.
     ------------------------------------------------------------------ */

  function weaponDps(pawn) {
    var w = root.Combat && root.Combat.weaponOf ? root.Combat.weaponOf(pawn) : null;
    if (w && w.ranged) {
      var cycle = (w.warmupTicks || 60) + (w.cooldownTicks || 60);
      return (w.damage || 8) * (w.burstCount || 1) * 60 / Math.max(30, cycle);
    }
    if (w) return (w.damage || 8) * 60 / Math.max(30, w.cooldownTicks || 100);
    if (pawn.isAnimal) {
      var kind = pawn.kind || {};
      return (kind.meleeDamage || 5) * 60 / Math.max(40, kind.meleeCooldownTicks || 110);
    }
    return 5 * 60 / 140;                        /* bare hands, and it shows */
  }

  function powerOf(pawn) {
    if (!pawn || pawn.dead || pawn.downed) return 0;
    var health = Hp();
    var cap = function (name) { return health && health.capacity ? health.capacity(pawn, name) : 1; };
    var cons = cap('consciousness');
    if (cons < 0.3) return 0;
    var w = root.Combat && root.Combat.weaponOf ? root.Combat.weaponOf(pawn) : null;
    var skill = pawn.skillLevel ? pawn.skillLevel(w && w.ranged ? 'shooting' : 'melee') : 0;
    var body = (0.35 + 0.65 * cons) * (0.5 + 0.5 * cap('manipulation')) * (0.7 + 0.3 * cap('moving'));
    var size = pawn.bodySize === undefined ? 1 : pawn.bodySize;
    return weaponDps(pawn) * (0.55 + 0.045 * skill) * body * Math.sqrt(size);
  }
  Caravans.powerOf = powerOf;

  function makeEnemies(kindIds, count, tier) {
    var out = [];
    for (var i = 0; i < count; i++) {
      var kindId = kindIds && kindIds.length ? U.pick(kindIds) : 'raider';
      var kind = root.Defs && root.Defs.maybe ? root.Defs.maybe('pawnKind', kindId) : null;
      var scale = kind && typeof kind.combatPower === 'number' ? kind.combatPower / 60 : 1;
      var hp = Math.round((36 + 30 * tier) * U.randRange(0.82, 1.2));
      out.push({
        name: ((kind && kind.label) || kindId) + ' ' + (i + 1), kindId: kindId,
        power: (2.4 + 5.8 * tier) * U.randRange(0.75, 1.3) * scale, hp: hp, maxHp: hp
      });
    }
    return out;
  }

  var WOUND_TYPES = ['bullet', 'cut', 'blunt', 'stab'];

  function outsideParts(pawn) {
    var parts = pawn.health ? pawn.health.parts : null, out = [];
    for (var i = 0; parts && i < parts.length; i++) {
      if (!parts[i].missing && parts[i].depth === 'outside') out.push(parts[i]);
    }
    return out;
  }

  /* One abstract blow becomes one to four real wounds on real parts, which
     is why a survivor comes home with a shattered arm and not a number. */
  function wound(pawn, amount, source) {
    var health = Hp();
    if (!health || !health.damage || amount <= 0) return;
    var parts = outsideParts(pawn), left = amount, guard = 0;
    while (left > 0.5 && !pawn.dead && guard++ < 4) {
      var chunk = Math.min(left, MAX_WOUND * U.randRange(0.5, 1));
      left -= chunk;
      var part = parts.length
        ? U.pickWeighted(parts, function (p) { return Math.max(0.02, p.coverage || 0.1); })
        : null;
      health.damage(pawn, {
        amount: Math.round(chunk), type: U.pick(WOUND_TYPES),
        partId: part ? part.id : null, source: source || 'an ambush'
      });
      parts = outsideParts(pawn);
    }
  }

  /* A wounded fighter still swings, but not as well, and the drop is what
     lets the rout check below see a single enemy losing. */
  function enemyPower(e) {
    return e.hp > 0 ? e.power * (0.15 + 0.85 * e.hp / e.maxHp) : 0;
  }

  /* Half the party down, or most of its fighting strength gone, and the
     survivors break contact. Nobody fights to the last body. */
  function routed(alive, startCount, power, startPower) {
    if (!alive) return true;
    return alive <= startCount * 0.5 || power < startPower * ROUT_POWER;
  }

  /* Rounds of mutual attrition. The caravan focuses fire, which is what
     lets a strong party win decisively; the other side spreads its fire,
     which is what makes a close fight cost limbs rather than lives. */
  function resolveBattle(c, enemies, source, surprise) {
    var before = c.pawns.slice(), killed = 0, rounds = 0, broke = null;
    var ourCount = c.pawns.filter(function (p) { return !p.dead && !p.downed; }).length;
    var ourStart = U.sum(c.pawns, powerOf);
    var theirStart = U.sum(enemies, enemyPower);
    var theirCount = enemies.length;

    while (rounds++ < BATTLE_ROUNDS) {
      var ours = c.pawns.filter(function (p) { return !p.dead && !p.downed; });
      var theirs = enemies.filter(function (e) { return e.hp > 0; });
      var ourPower = U.sum(ours, powerOf);
      var theirPower = U.sum(theirs, enemyPower);

      if (routed(theirs.length, theirCount, theirPower, theirStart)) { broke = 'them'; break; }
      if (routed(ours.length, ourCount, ourPower, ourStart)) { broke = 'us'; break; }
      if (ourPower <= 0 && theirPower <= 0) break;

      var outgoing = ourPower * ROUND_DAMAGE * U.randRange(0.65, 1.35);
      var incoming = theirPower * ROUND_DAMAGE * U.randRange(0.65, 1.35);
      /* The side that chose the ground gets the opening volley. */
      if (surprise && rounds === 1) incoming *= 1.6;

      for (var t = 0; outgoing > 0 && t < theirs.length; t++) {
        var hit = Math.min(outgoing, theirs[t].hp);
        theirs[t].hp -= hit;
        outgoing -= hit;
        if (theirs[t].hp <= 0) killed++;
      }

      var share = incoming / ours.length;
      for (var i = 0; i < ours.length; i++) wound(ours[i], share * U.randRange(0.55, 1.5), source);
      for (var d = c.pawns.length - 1; d >= 0; d--) {
        if (c.pawns[d].dead) loseTraveller(c, c.pawns[d], source);
      }
    }

    var standing = c.pawns.filter(function (p) { return !p.dead && !p.downed; });
    var left = enemies.filter(function (e) { return e.hp > 0; });
    return {
      won: broke === 'them' && standing.length > 0,
      rounds: rounds, killed: killed, enemiesLeft: left.length, standing: standing.length,
      dead: before.filter(function (p) { return c.pawns.indexOf(p) < 0; }),
      downed: c.pawns.filter(function (p) { return p.downed; }),
      wounded: c.pawns.filter(function (p) { return p.health && p.health.injuries.length; })
    };
  }

  Caravans.ambush = function (c) {
    if (!c || !c.pawns.length) return null;
    var fac = Fac(), g = G();
    var pool = fac ? fac.all().filter(function (f) { return f.hostile && !f.isPlayer; }) : [];
    var attacker = pool.length ? U.pick(pool) : null;
    var kinds = (attacker && attacker.kind && attacker.kind.pawnKinds && attacker.kind.pawnKinds.raider) || ['raider'];

    /* Sized against the party they found, and against how far into the game
       it is, so an early two-person run is not jumped by a warband. */
    var tier = U.clamp((g && g.day ? g.day() : 0) / 60 + U.randRange(-0.1, 0.2), 0, 1);
    var count = U.clamp(Math.round(Caravans.strength(c) / 3.4 * U.randRange(0.7, 1.25)), 1, 8);
    var enemies = makeEnemies(kinds, count, tier);
    var result = resolveBattle(c, enemies, 'an ambush', true);

    var lines = [(attacker ? attacker.name : 'A band of pirates') + ' fell on ' +
      c.label.toLowerCase() + ' out of the scrub.'];
    if (result.won) {
      lines.push('Your people drove them off, killing ' + result.killed + '.');
      var loot = lootFromEnemies(c, enemies, tier);
      if (loot) lines.push('They stripped ' + loot + ' off the bodies.');
      thoughtForAll(c, 'raidBeaten');
    } else if (!c.pawns.length) {
      lines.push('Nobody walked away.');
    } else {
      lines.push('Your people broke contact and ran, leaving the road to them.');
      var setback = Math.round(c.ticksToArrive * 0.2) + 1200;   /* fleeing costs distance too */
      c.ticksToArrive += setback;
      c.totalTicks += setback;
    }
    if (result.dead.length) lines.push('Dead: ' + listNames(result.dead) + '.');
    if (result.downed.length) lines.push('Carried out of it: ' + listNames(result.downed) + '.');
    else if (result.wounded.length) lines.push('Wounded: ' + listNames(result.wounded) + '.');

    letter('Ambush on the road', lines.join(' '), result.dead.length ? 'death' : 'threat');
    refreshCargo(c);
    return result;
  };

  function lootFromEnemies(c, enemies, tier) {
    if (Caravans.freeMass(c) <= 1) return null;
    var taken = [];
    var silver = Math.round(enemies.length * U.randRange(12, 40) * (0.6 + tier));
    if (silver > 0) { Caravans.addItem(c, 'silver', silver); taken.push(silver + ' silver'); }
    if (Caravans.freeMass(c) > 3 && U.chance(0.45)) {
      var gun = U.pick(tier > 0.5 ? ['boltRifle', 'autoRifle', 'shotgun'] : ['knife', 'club', 'shortBow', 'pistol']);
      if (stackMass(gun, 1) <= Caravans.freeMass(c)) {
        Caravans.addItem(c, gun, 1);
        taken.push('a ' + labelOf(gun));
      }
    }
    return taken.length ? taken.join(' and ') : null;
  }

  /* ------------------------------------------------------------------
     Arrival
     ------------------------------------------------------------------ */

  Caravans.arrive = function (c) {
    if (!c) return;
    c.progress = 1;
    c.tile = c.destination;
    c.ticksToArrive = 0;
    if (c.purpose === 'return') return arriveHome(c);

    var settlement = W() ? W().settlementAt(c.tile) : null;
    if (!settlement) {
      letter(c.label + ' found nothing',
        'There is no settlement on that tile - only weather and open ground. The party is turning ' +
        'for home.', 'neutral');
      return Caravans.sendHome(c);
    }
    c.settlementId = settlement.id;
    if (c.purpose === 'attack') return arriveAttack(c, settlement);
    if (c.purpose === 'visit') return arriveVisit(c, settlement);
    return arriveTrade(c, settlement);
  };

  function arriveTrade(c, settlement) {
    var fac = Fac();
    var faction = fac ? fac.ofSettlement(settlement) : null;
    var kindDef = root.Defs && root.Defs.maybe ? root.Defs.maybe('settlementKind', settlement.kind) : null;

    if (faction && faction.hostile) {
      letter('No welcome at ' + settlement.name,
        'The gates stayed shut: ' + faction.name + ' does not trade with you. The party is turning ' +
        'for home.', 'threat');
      return Caravans.sendHome(c);
    }
    if (kindDef && kindDef.canTradeWith === false) {
      letter('Nothing for sale at ' + settlement.name,
        settlement.name + ' has no counter and no interest in yours. The party is turning for home.',
        'neutral');
      return Caravans.sendHome(c);
    }

    c.state = 'trading';
    c.waitTicks = 0;
    reopenDeal(c);
    letter(c.label + ' has arrived',
      listNames(c.pawns) + ' reached ' + settlement.name + ' and set out their goods. ' +
      (c.deal ? 'The market is open - settle the deal, then send them home.'
              : 'They are waiting at the market for your word.'), 'good');
  }

  /* trade.js is optional, and a loaded save has a caravan standing at a
     market with no live Deal, so the deal is opened lazily. */
  function reopenDeal(c) {
    if (c.deal || c.state !== 'trading') return c.deal;
    var settlement = settlementOf(c);
    if (!settlement || !root.Trade || !root.Trade.open) return null;
    c.deal = root.Trade.open(settlement, { caravan: c }) || null;
    return c.deal;
  }

  Caravans.deal = function (c) { return c ? reopenDeal(c) : null; };

  function arriveVisit(c, settlement) {
    var fac = Fac();
    var faction = fac ? fac.ofSettlement(settlement) : null;
    if (faction && faction.hostile) {
      letter('Turned away from ' + settlement.name,
        faction.name + ' met your party at the boundary stones with spears levelled. They are ' +
        'coming home.', 'threat');
      return Caravans.sendHome(c);
    }
    var goodwill = (faction && fac.noteHelpGiven)
      ? fac.noteHelpGiven(faction.id, 'your caravan paid respects at ' + settlement.name) : 0;
    thoughtForAll(c, 'chatted');
    letter('A good visit to ' + settlement.name,
      listNames(c.pawns) + ' spent a day in ' + settlement.name +
      (faction ? ' as guests of ' + faction.name + '. Goodwill with them is now ' +
        Math.round(goodwill) + '.' : '.'), 'good');
    Caravans.sendHome(c);
  }

  function arriveAttack(c, settlement) {
    var fac = Fac();
    var faction = fac ? fac.ofSettlement(settlement) : null;
    var kindDef = root.Defs && root.Defs.maybe ? root.Defs.maybe('settlementKind', settlement.kind) : null;
    var range = (kindDef && kindDef.defenderCount) || [3, 6];
    var count = U.randInt(range[0], range[1]);
    var tier = U.clamp((settlement.wealth || 1000) / 9000, 0.15, 1);
    var enemies = makeEnemies((kindDef && kindDef.defenders) || ['raider'], count, tier);

    var result = resolveBattle(c, enemies, 'the raid on ' + settlement.name);
    var lines = ['Your war party hit ' + settlement.name + ', held by ' + count + ' defenders.'];

    if (result.won) {
      lines.push('The place fell. ' + result.killed + ' defenders died in the streets.');
      lines.push('The party carried off ' + lootSettlement(c, settlement) + '.');
      if (W()) W().destroySettlement(settlement);
      if (faction && fac.noteSettlementDestroyed) fac.noteSettlementDestroyed(settlement, 'your war party');
      else if (faction) fac.adjustGoodwill(faction.id, -75, 'you sacked ' + settlement.name);
      var needs = Nd();
      for (var i = 0; needs && i < c.pawns.length; i++) {
        var p = c.pawns[i];
        if (!p.isHuman) continue;
        needs.addThought(p, (p.traits && p.traits.indexOf('bloodlust') >= 0)
          ? 'killedHumanBloodlust' : 'raidBeaten');
      }
    } else {
      lines.push('The attack broke on their defences; ' + result.enemiesLeft + ' defenders still hold it.');
      if (faction) fac.adjustGoodwill(faction.id, -45, 'you attacked ' + settlement.name);
    }
    if (result.dead.length) lines.push('Dead: ' + listNames(result.dead) + '.');
    if (result.downed.length) lines.push('Carried out of it: ' + listNames(result.downed) + '.');
    else if (result.wounded.length) lines.push('Wounded: ' + listNames(result.wounded) + '.');

    letter(result.won ? settlement.name + ' has fallen' : 'The attack on ' + settlement.name + ' failed',
      lines.join(' '), result.dead.length ? 'death' : (result.won ? 'good' : 'threat'));

    c.settlementId = 0;
    if (c.pawns.length) Caravans.sendHome(c);
    else c.state = 'done';
  }

  function lootSettlement(c, settlement) {
    var taken = [];
    var perSilver = stackMass('silver', 1) || 0.01;
    var silver = Math.min(Math.round((settlement.wealth || 800) * U.randRange(0.25, 0.5)),
      Math.floor(Caravans.freeMass(c) / perSilver));
    if (silver > 0) { Caravans.addItem(c, 'silver', silver); taken.push(silver + ' silver'); }

    var goods = ['steel', 'cloth', 'leather', 'components', 'medicine', 'mealSimple'];
    for (var i = 0; i < 3 && Caravans.freeMass(c) > 1; i++) {
      var id = U.pick(goods), each = stackMass(id, 1);
      if (each <= 0) continue;
      var n = Math.min(U.randInt(8, 40), Math.floor(Caravans.freeMass(c) / each));
      if (n <= 0) continue;
      Caravans.addItem(c, id, n);
      taken.push(n + ' ' + labelOf(id));
    }
    return taken.length ? taken.join(', ') : 'nothing they could carry';
  }

  /* ------------------------------------------------------------------
     Going home, and the orders that send them
     ------------------------------------------------------------------ */

  Caravans.sendHome = function (c) {
    if (!c) return null;
    var world = W();
    var home = world ? world.colonyTile : c.homeTile;
    c.deal = null;
    c.settlementId = 0;
    c.purpose = 'return';
    c.label = 'Returning caravan';
    c.originTile = c.tile;
    c.destination = home;
    c.state = 'travelling';
    c.progress = 0;
    c.speed = partySpeed(c.pawns, c.mass, capacityOf(c.pawns));

    if (c.tile === home) { Caravans.arrive(c); return c; }
    var path = world ? world.pathBetween(c.tile, home) : null;
    if (!path || !path.length) {
      /* Stranded on the wrong side of an ocean. They walk what they can,
         and four days is the honest guess for "the long way round". */
      c.path = [home];
      c.totalTicks = c.ticksToArrive = TICKS_PER_DAY * 4;
      return c;
    }
    c.path = path;
    c.totalTicks = c.ticksToArrive = world.travelTicks(c.tile, home, c.speed);
    return c;
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

  function arriveHome(c) {
    var g = G();
    var map = g ? g.map : null;
    if (!map) { c.state = 'trading'; return; }        /* no colony to walk onto yet: wait */

    /* The edge they come in by is the edge they left from, when it has
       room; the other three are there for a map walled in by mountains. */
    var sides = [sideTowards(c.originTile, c.homeTile), 'n', 'e', 's', 'w'];
    var cells = [];
    for (var s = 0; s < sides.length; s++) {
      var found = root.MapGen ? root.MapGen.edgeSpawnCells(map, sides[s]) : [];
      if (found.length > cells.length) cells = found;
      if (cells.length > c.pawns.length) break;
    }
    if (!cells.length) cells = [{ x: map.w >> 1, y: 0 }];

    /* Everyone lands on the same stretch of edge rather than strung out
       along it, so the player sees a party arrive, not a picket line. */
    var start = U.randInt(0, Math.max(0, cells.length - c.pawns.length - 1));
    var drop = cells[start];
    var i;
    for (i = 0; i < c.pawns.length; i++) {
      var pawn = c.pawns[i];
      var cell = cells[Math.min(cells.length - 1, start + i)];
      pawn.map = map;
      pawn.job = null;
      pawn.driver = null;
      if (pawn.jobQueue) pawn.jobQueue.length = 0;
      pawn.spawn(map, cell.x, cell.y);
      if (root.Needs && root.Needs.refreshSituationalThoughts) root.Needs.refreshSituationalThoughts(pawn);
    }
    for (i = 0; i < c.items.length; i++) {
      map.addItem(c.items[i].defId, drop.x, drop.y, c.items[i].count);
    }

    var kinds = c.items.length;
    c.items = [];
    c.state = 'done';
    letter('The caravan is home',
      listNames(c.pawns) + ' walked back onto the map carrying ' + kinds + ' ' +
      U.plural(kinds, 'kind', 'kinds') + ' of goods. Someone should haul it all inside before it rains.',
      'good', drop);
  }

  Caravans.recall = function (c) {
    if (!c || c.state === 'done') return false;
    if (c.purpose === 'return' && c.state === 'travelling') return false;
    var wasAt = destinationName(c);
    Caravans.sendHome(c);
    letter(c.label + ' turns back',
      'The party has abandoned the road to ' + wasAt + ' and is walking home: ' +
      U.fmt(Caravans.daysLeft(c), 1) + ' days out.', 'neutral');
    return true;
  };

  Caravans.abandon = function (c) {
    if (!c) return false;
    U.remove(caravans, c);
    c.state = 'done';
    var lost = c.pawns.slice();
    var needs = Nd(), g = G();
    var home = g && g.map ? g.map.colonists() : [];
    for (var p = 0; p < lost.length; p++) {
      lost[p].lostToWorld = true;
      lost[p].map = null;
      if (!needs || !lost[p].isHuman) continue;
      for (var h = 0; h < home.length; h++) needs.addThought(home[h], 'colonistLost', { otherPawnId: lost[p].id });
    }
    c.pawns = [];
    c.items = [];
    letter('Caravan abandoned',
      listNames(lost) + ' walked off into the wild with everything they carried. They are not ' +
      'coming back.', 'death');
    return true;
  };

  /* ------------------------------------------------------------------
     The reference audit

     detach() cuts the colony's links to a departing pawn; this checks the
     same list from the other end. An empty array is the passing result,
     and it is what the tests assert on.
     ------------------------------------------------------------------ */

  Caravans.auditColony = function (map) {
    var out = [], g = G(), i, j;
    map = map || (g ? g.map : null);
    if (!map) return out;

    var away = new Map();
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
      if (g && g.selection && g.selection.indexOf(pawn) >= 0) out.push(nameOf(pawn) + ' is still selected');
      if (root.Res && root.Res.reservedBy && root.Res.reservedBy(map, { k: 'p', id: pawn.id })) {
        out.push(nameOf(pawn) + ' is still reserved by a worker');
      }
      if (root.Combat && root.Combat.stanceOf && root.Combat.stanceOf(pawn)) {
        out.push(nameOf(pawn) + ' still holds a combat stance');
      }
      if (pawn.job) out.push(nameOf(pawn) + ' still holds a colony job');
    });

    for (i = 0; i < map.pawns.length; i++) {
      var other = map.pawns[i];
      if (other.master !== null && other.master !== undefined && away.has(other.master)) {
        out.push(nameOf(other) + ' still follows a master who left');
      }
      if (other.aimTarget && other.aimTarget.k === 'p' && away.has(other.aimTarget.id)) {
        out.push(nameOf(other) + ' is still aiming at someone who left');
      }
      if (other.job && ['targetA', 'targetB', 'targetC'].some(function (k) {
        var t = other.job[k];
        return !!(t && t.k === 'p' && away.has(t.id));
      })) {
        out.push(nameOf(other) + ' has a job targeting someone who left');
      }
    }
    return out;
  };

  /* ------------------------------------------------------------------
     Save and load

     The pawns are the hard part: they carry a map reference, a kind def
     and Things with def references, none of which are JSON. Everything on
     the skip list is rebuilt on load rather than stored, which is also
     what guarantees the copy has no cycles in it.
     ------------------------------------------------------------------ */

  var SKIP = {
    map: 1, kind: 1, def: 1, job: 1, driver: 1, jobQueue: 1,
    path: 1, pathDest: 1, aimTarget: 1, draftTarget: 1, _traitFx: 1
  };

  function plain(value, depth) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'function') return undefined;
    if (typeof value !== 'object') return value;
    if (depth > 8) return null;
    var i;
    if (Array.isArray(value)) {
      var arr = [];
      for (i = 0; i < value.length; i++) {
        var v = plain(value[i], depth + 1);
        if (v !== undefined) arr.push(v);
      }
      return arr;
    }
    var out = {}, keys = Object.keys(value);
    for (i = 0; i < keys.length; i++) {
      if (SKIP[keys[i]]) continue;
      var pv = plain(value[keys[i]], depth + 1);
      if (pv !== undefined) out[keys[i]] = pv;
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
          destination: c.destination, path: c.path.slice(), progress: c.progress,
          ticksToArrive: c.ticksToArrive, totalTicks: c.totalTicks, speed: c.speed,
          settlementId: c.settlementId, departTick: c.departTick, lastTick: c.lastTick,
          waitTicks: c.waitTicks, campDay: c.campDay, holedUp: !!c.holedUp,
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
        id: s.id || U.nextId(), seed: s.seed === undefined ? (G() ? G().seed : 0) : s.seed,
        pawns: (s.pawns || []).map(restorePawn).filter(Boolean),
        items: (s.items || []).map(function (it) { return { defId: it.defId, count: it.count }; }),
        tile: s.tile | 0, originTile: s.originTile | 0, homeTile: s.homeTile | 0,
        path: (s.path || []).slice(), progress: s.progress || 0, destination: s.destination | 0,
        purpose: s.purpose || 'return',
        ticksToArrive: s.ticksToArrive || 0, totalTicks: s.totalTicks || 1,
        food: 0, mass: 0, speed: s.speed || 1,
        state: s.state || 'travelling', settlementId: s.settlementId || 0, deal: null,
        departTick: s.departTick || 0,
        lastTick: s.lastTick === undefined ? gameTick() : s.lastTick,
        waitTicks: s.waitTicks || 0, campDay: s.campDay === undefined ? -1 : s.campDay,
        holedUp: !!s.holedUp,
        label: s.label || 'Caravan'
      };
      refreshCargo(c);
      caravans.push(c);
    }
    return true;
  };

  Caravans.reset = function () { caravans.length = 0; return Caravans; };

  root.Caravans = Caravans;
})(this);
