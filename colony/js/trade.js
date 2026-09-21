/* ============================================================
   trade.js - prices, stock, deals, and the caravan that walks
   onto your map.

   Everything here turns on one number: the spread. You sell at
   sixty per cent of a thing's market value and buy at a hundred
   and forty, so shuffling the same crate back and forth loses
   money and the only profit is in making something somebody
   else wants. A negotiator's social skill and the civilization's
   goodwill move that number by a quarter between them, which is
   what makes sending your talker and staying on good terms pay.

   Three kinds of counter exist and all three go through the same
   Deal: a settlement you walked a caravan to, a trader who came
   to you, and an allied caravan met on the road. What changes
   between them is only where the goods come from - a stockpile
   the colony can reach, or a caravan's packs - and that is one
   small adapter rather than three trade systems.
   ============================================================ */
(function (root) {
  'use strict';

  var Trade = {};

  var TICKS_PER_DAY = 60000;

  /* The spread, and the two things that move it. A perfect negotiator
     dealing with an adoring civilization shaves a quarter off the buy
     price; the reverse pays that much more. */
  var BUY_SPREAD = 1.4;
  var SELL_SPREAD = 0.6;
  var SOCIAL_SWING = 0.15;
  var GOODWILL_SWING = 0.10;
  var NEUTRAL_SKILL = 10;

  /* awful..legendary. Crafted goods are most of what a colony has to
     sell, so quality is the difference between a hobby and an income. */
  var QUALITY_VALUE = [0.5, 0.75, 1, 1.25, 1.75, 2.5, 5];

  var BEACON_RADIUS = 12;          /* how far a trade beacon reaches   */
  var ARRIVE_RADIUS = 6;           /* close enough to count as arrived */
  var FIRST_TRADER_DAY = 3;
  var MAX_VISITS = 2;
  var GOODWILL_MIN_VALUE = 60;     /* silver a deal must move to count as diplomacy */

  Trade.BUY_SPREAD = BUY_SPREAD;
  Trade.SELL_SPREAD = SELL_SPREAD;
  Trade.visitors = [];
  Trade.state = { nextArrivalTick: 0, lastTick: 0, map: null };

  /* ------------------------------------------------------------------
     Plumbing. Every reach outside this file is guarded: trade.js loads
     before caravan.js and events.js, and the tools load a half-built
     game on purpose.
     ------------------------------------------------------------------ */

  function sys(name) { return root[name]; }
  function game() { return root.Game || null; }
  function msg(text, opts) { var g = game(); if (g && g.msg) g.msg(text, opts); }
  function letter(title, text, opts) { var g = game(); if (g && g.letter) g.letter(title, text, opts); }

  function defMaybe(category, id) {
    var D = root.Defs;
    return (D && D.maybe && typeof id === 'string') ? D.maybe(category, id) : null;
  }

  function thingDef(x) {
    if (!x) return null;
    if (typeof x === 'string') return defMaybe('thing', x);
    if (x.defCategory === 'thing') return x;
    return x.def || null;
  }

  function traderKindDef(x) {
    if (!x) return null;
    if (typeof x === 'string') return defMaybe('traderKind', x);
    return x.defCategory === 'traderKind' ? x : null;
  }

  function factionIdOf(x) {
    if (!x) return null;
    if (typeof x === 'string') return x;
    return x.factionId || x.id || null;
  }

  function factionOf(x) {
    var F = sys('Factions');
    var id = factionIdOf(x);
    return (F && F.get && id) ? F.get(id) : null;
  }

  function skillOf(pawn, skillId) {
    if (!pawn) return 0;
    if (typeof pawn.skillLevel === 'function') return pawn.skillLevel(skillId);
    var s = pawn.skills && pawn.skills[skillId];
    if (s) return typeof s === 'number' ? s : (s.level || 0);
    return typeof pawn[skillId] === 'number' ? pawn[skillId] : 0;
  }

  /* ============================================================
     PRICES
     ============================================================ */

  /* What one unit costs, in whole silver. `buying` is from the colony's
     side: true is what you pay them, false is what they pay you. */
  Trade.priceOf = function (defId, opts) {
    opts = opts || {};
    var def = thingDef(defId);
    if (!def) return 1;

    var v = def.marketValue > 0 ? def.marketValue : 1;
    if (typeof opts.quality === 'number') {
      v *= QUALITY_VALUE[U.clamp(opts.quality | 0, 0, 6)];
    }

    var kind = traderKindDef(opts.traderKind);
    if (kind && kind.priceFactor > 0) v *= kind.priceFactor;

    var buying = opts.buying !== false;
    v *= buying ? BUY_SPREAD : SELL_SPREAD;

    /* Both bonuses push the same way: they make the deal better for you.
       An absent negotiator is neutral rather than hopeless, so a price
       quoted with nobody named is the plain list price. */
    var skill = opts.socialSkill;
    if (skill === undefined && opts.negotiator) skill = skillOf(opts.negotiator, 'social');
    if (skill === undefined) skill = NEUTRAL_SKILL;
    var social = (U.clamp(skill, 0, 20) / 20 - 0.5) * 2 * SOCIAL_SWING;

    var gw = opts.goodwill;
    if (gw === undefined) {
      var f = factionOf(opts.faction);
      gw = f ? f.goodwill : 0;
    }
    var favour = social + U.clamp(gw, -100, 100) / 100 * GOODWILL_SWING;

    v *= buying ? (1 - favour) : (1 + favour);
    return Math.max(1, Math.round(v));
  };

  /* ============================================================
     STOCK

     A trader's inventory is rolled from categories, never from a list
     of thing ids, so a civilization that "sells weapons" keeps selling
     weapons when def_things.js gains another rifle.
     ============================================================ */

  function isTradeGood(def) {
    if (!def || def.category !== 'item' || def.id === 'silver') return false;
    if (!(def.marketValue > 0)) return false;
    var Z = sys('Zones');
    if (!Z || !Z.categoryOf) return false;
    var c = Z.categoryOf(def);
    return !!c && c !== 'corpses';
  }
  Trade.isTradeGood = isTradeGood;

  /* Nobody at a neolithic tech level is carrying cartridges, industrial
     medicine or machined components, whatever category they fall in. */
  function techAllows(def, techLevel) {
    if (techLevel !== 'neolithic') return true;
    if (def.weapon && def.weapon.damageType === 'bullet') return false;
    return def.id !== 'components' && def.id !== 'medicine' && def.id !== 'chemfuel';
  }

  function settlementKindOf(partner) {
    if (!partner || typeof partner.kind !== 'string') return null;
    return defMaybe('settlementKind', partner.kind);
  }

  function resolveTraderKind(partner) {
    var direct = traderKindDef(partner);
    if (direct) return direct;
    if (partner) {
      direct = traderKindDef(partner.traderKindId) || traderKindDef(partner.traderKind);
      if (direct) return direct;
    }
    var F = sys('Factions');
    var fid = factionIdOf(partner && (partner.factionId || partner.faction));
    if (F && F.traderKindFor && fid) {
      direct = traderKindDef(F.traderKindFor(fid));
      if (direct) return direct;
    }
    var all = root.Defs && root.Defs.all ? root.Defs.all('traderKind') : [];
    return all.length ? all[0] : null;
  }
  Trade.traderKindOf = resolveTraderKind;

  /* What this counter puts out. A settlement narrows its faction's
     trader down to what the place itself keeps in its warehouse. */
  function sellsList(partner, kind) {
    var sKind = settlementKindOf(partner);
    var allow = sKind && sKind.stockCategories ? sKind.stockCategories : null;
    if (kind && kind.sells && kind.sells.length) {
      if (!allow) return kind.sells;
      var narrowed = kind.sells.filter(function (e) { return allow.indexOf(e.category) >= 0; });
      if (narrowed.length) return narrowed;
      return kind.sells;
    }
    var cats = allow || ['resources', 'rawFood'];
    return cats.map(function (c) { return { category: c, countRange: [1, 3] }; });
  }

  function stockBudget(partner, kind, points) {
    if (points > 0) return points;
    if (partner && partner.wealth > 0) return partner.wealth * 0.55;
    if (kind && kind.silverRange) return (kind.silverRange[0] + kind.silverRange[1]) / 2;
    return 1200;
  }

  function candidateDefs(category, techLevel, ceiling) {
    var Z = sys('Zones');
    var list = (Z && Z.defsInCategory) ? Z.defsInCategory(category) : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (!isTradeGood(d) || !techAllows(d, techLevel)) continue;
      /* A trader cannot be carrying something worth more than its whole
         float; this is what keeps tribal counters in spears. */
      if (d.marketValue > ceiling) continue;
      out.push(d);
    }
    return out;
  }

  /* How many units of one kind to pile up. Cheap bulk arrives by the
     stack, a rifle arrives as a rifle. */
  function pileSize(def, silver) {
    var limit = def.stackLimit || 1;
    var afford = Math.floor(silver / Math.max(1, def.marketValue));
    if (limit <= 1) return U.clamp(afford, 1, U.randInt(1, 3));
    var n = Math.round(afford * U.randRange(0.45, 1));
    return U.clamp(n, 1, limit * (limit >= 75 ? 2 : 1));
  }

  Trade.stockFor = function (partner, points) {
    var kind = resolveTraderKind(partner);
    var faction = factionOf(partner && (partner.factionId || partner.faction));
    var techLevel = (faction && faction.techLevel) ||
      (partner && partner.techLevel) || 'industrial';
    var budget = stockBudget(partner, kind, points);
    var entries = sellsList(partner, kind);
    var ceiling = Math.max(60, budget * 0.5);

    var picked = {}, out = [];
    var share = budget / Math.max(1, entries.length);

    for (var e = 0; e < entries.length; e++) {
      var entry = entries[e];
      var pool = candidateDefs(entry.category, techLevel, ceiling);
      if (!pool.length) continue;
      var range = entry.countRange || [1, 2];
      var want = U.clamp(U.randInt(range[0], range[1]), 1, pool.length);
      var each = share / want;

      for (var n = 0; n < want; n++) {
        /* Weighted toward the cheap end so a counter reads as a market
           and not as a display case: the dear things still turn up. */
        var def = U.pickWeighted(pool, function (d) {
          return picked[d.id] ? 0 : 1 / Math.sqrt(Math.max(1, d.marketValue));
        });
        if (!def || picked[def.id]) continue;
        picked[def.id] = true;
        var count = pileSize(def, each);
        if (count < 1) continue;
        out.push({
          defId: def.id, count: count,
          price: Trade.priceOf(def, { buying: true, traderKind: kind, faction: faction })
        });
      }
    }

    /* The exotic trader's reason to exist: now and then, the one thing
       on the planet worth saving a season of silver for. */
    if (kind && kind.id === 'exotic' && U.chance(0.55)) {
      var lux = candidateDefs('manufactured', techLevel, budget)
        .concat(candidateDefs('medicine', techLevel, budget))
        .concat(candidateDefs('weapons', techLevel, budget))
        .filter(function (d) { return !picked[d.id] && d.marketValue >= 60; });
      if (lux.length) {
        var prize = U.pickWeighted(lux, function (d) { return d.marketValue; });
        out.push({
          defId: prize.id, count: pileSize(prize, budget * 0.5),
          price: Trade.priceOf(prize, { buying: true, traderKind: kind, faction: faction })
        });
      }
    }

    return out;
  };

  /* ============================================================
     WHERE THE COLONY'S GOODS ARE

     Without a trade beacon a deal sees whatever is sitting in a
     stockpile the trader's own cell can walk to. With one, it sees
     everything inside the beacon's radius, stockpiled or not - which
     is the entire reason to build the thing.
     ============================================================ */

  function colonyCentre(map) {
    var list = map.colonists ? map.colonists() : [];
    if (list.length) {
      var sx = 0, sy = 0;
      for (var i = 0; i < list.length; i++) { sx += list[i].x; sy += list[i].y; }
      return { x: Math.round(sx / list.length), y: Math.round(sy / list.length) };
    }
    if (map.landingSpot) return { x: map.landingSpot.x, y: map.landingSpot.y };
    return { x: map.w >> 1, y: map.h >> 1 };
  }
  Trade.colonyCentre = colonyCentre;

  function beaconLive(b) {
    if (!b || !b.spawned) return false;
    var draw = b.def && b.def.building && b.def.building.powerConsumption;
    if (!draw) return true;
    var P = sys('Power');
    return !P || !P.isPowered || P.isPowered(b);
  }

  function beaconCells(map) {
    if (!root.Defs || !root.Defs.has || !root.Defs.has('thing', 'tradeBeacon')) return null;
    var beacons = map.byDef('tradeBeacon');
    var cells = null;
    for (var b = 0; b < beacons.length; b++) {
      if (!beaconLive(beacons[b])) continue;
      if (!cells) cells = [];
      var ring = U.cellsInRadius(beacons[b].x, beacons[b].y, BEACON_RADIUS);
      for (var c = 0; c < ring.length; c++) {
        if (map.inBounds(ring[c][0], ring[c][1])) cells.push(map.idx(ring[c][0], ring[c][1]));
      }
    }
    return cells;
  }

  function stockpileCells(map, anchor) {
    var Z = sys('Zones'), R = sys('Regions');
    var out = [];
    if (!Z || !Z.stockpiles || !Z.cellsOf) return out;
    var piles = Z.stockpiles(map);
    for (var p = 0; p < piles.length; p++) {
      var cells = Z.cellsOf(piles[p]);
      for (var i = 0; i < cells.length; i++) {
        var idx = cells[i], x = idx % map.w, y = (idx - x) / map.w;
        if (R && R.sameArea && !R.sameArea(map, anchor.x, anchor.y, x, y)) continue;
        out.push(idx);
      }
    }
    return out;
  }

  /* Stockpiles the trader can walk to, plus everything inside any beacon's
     radius. The beacon adds to that reach rather than replacing it - one
     built in a far corner should not hide the warehouse.

     Deduplicated, because two beacons whose radii overlap, or a beacon
     standing over a stockpile, would otherwise hand the same stack to the
     deal twice and let you sell it twice. */
  function reachableCells(map, anchor) {
    var raw = stockpileCells(map, anchor);
    var beacons = beaconCells(map);
    if (beacons && beacons.length) raw = raw.concat(beacons);
    var seen = new Set(), out = [];
    for (var i = 0; i < raw.length; i++) {
      if (seen.has(raw[i])) continue;
      seen.add(raw[i]);
      out.push(raw[i]);
    }
    return out;
  }

  /* Everything sellable lying on those cells, one row per def. Quality
     is only quoted when every stack agrees on it; a mixed heap sells at
     the plain market value, which is the honest answer and the cheap one. */
  function colonyGoods(map, cells, accepts) {
    var rows = new Map(), silver = 0, i, j;
    for (i = 0; i < cells.length; i++) {
      var items = map.itemsIdx(cells[i]);
      for (j = 0; j < items.length; j++) {
        var t = items[j];
        if (!t.spawned) continue;
        if (t.defId === 'silver') { silver += t.stack; continue; }
        if (!isTradeGood(t.def)) continue;
        if (accepts && !accepts(t.def)) continue;
        var row = rows.get(t.defId);
        if (!row) {
          row = { defId: t.defId, def: t.def, count: 0, quality: t.quality };
          rows.set(t.defId, row);
        } else if (row.quality !== t.quality) {
          row.quality = null;
        }
        row.count += t.stack;
      }
    }
    return { rows: rows, silver: silver };
  }

  /* Splitting the stack is what hands the units over: map.splitStack
     hollows out the pile and despawns it when it empties, and the part
     that comes back is what the trader walks away with. Each cell's item
     list is copied first, because emptying a stack rewrites it. */
  function takeColonyDef(map, cells, defId, count) {
    var left = count;
    for (var i = 0; i < cells.length && left > 0; i++) {
      var items = map.itemsIdx(cells[i]).slice();
      for (var j = 0; j < items.length && left > 0; j++) {
        var t = items[j];
        if (t.defId !== defId || !t.spawned) continue;
        var n = Math.min(left, t.stack);
        map.splitStack(t, n);
        left -= n;
      }
    }
    return count - left;
  }

  /* ============================================================
     THE DEAL
     ============================================================ */

  function entryFor(list, defId) {
    for (var i = 0; i < list.length; i++) if (list[i].defId === defId) return list[i];
    return null;
  }

  function partnerLabelOf(partner, faction) {
    if (!partner) return 'trader';
    if (partner.name) return partner.name;
    if (partner.traderKind && partner.traderKind.label) return partner.traderKind.label;
    return (faction && faction.name) || 'trader';
  }

  /* Which of the colony's caravans is standing at that world tile. The
     partner is skipped explicitly: an allied caravan met on the road may
     itself be sitting in Caravans.all, and a deal it held both sides of
     would be a machine for printing goods. */
  function caravanAt(tile, exclude) {
    var C = sys('Caravans');
    var list = C && C.all;
    if (!list || tile === undefined || tile === null) return null;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || c === exclude || c.gone || c.tile !== tile) continue;
      if (c.factionId && c.factionId !== 'player') continue;
      return c;
    }
    return null;
  }

  function bestNegotiator(pool) {
    var best = null, bestSkill = -1;
    for (var i = 0; pool && i < pool.length; i++) {
      var p = pool[i];
      if (!p || p.dead || p.isAnimal) continue;
      var s = skillOf(p, 'social');
      if (s > bestSkill) { bestSkill = s; best = p; }
    }
    return best;
  }

  Trade.negotiatorFor = function (source) {
    if (source && source.pawns) return bestNegotiator(source.pawns);
    var map = source || (game() && game().map);
    return map && map.colonists ? bestNegotiator(map.colonists()) : null;
  };

  /* Their side of the counter, whichever of the three it is. A settlement
     and a visiting trader keep a `stock` list; an allied caravan met on
     the road has `items` instead, and that array IS its stock - the deal
     has to write through to it, not to a copy of it. */
  function theirGoods(partner) {
    if (!partner) return [];
    if (partner.stock) return partner.stock;
    if (partner.items) return partner.items;
    partner.stock = [];
    return partner.stock;
  }

  function partnerStock(partner) {
    return theirGoods(partner).filter(function (it) {
      return it.defId !== 'silver' && it.count > 0 && isTradeGood(thingDef(it.defId));
    });
  }

  function partnerSilver(partner) {
    if (!partner) return 0;
    if (typeof partner.silver === 'number') return partner.silver;
    if (partner.items) {
      for (var i = 0; i < partner.items.length; i++) {
        if (partner.items[i].defId === 'silver') return partner.items[i].count;
      }
      return 0;
    }
    /* A settlement's float is a slice of its wealth: a village cannot
       find four thousand silver however good your goods are. */
    if (partner.wealth > 0) return Math.round(partner.wealth * 0.35);
    return 0;
  }

  Trade.canOpen = function (partner, opts) {
    if (!partner) return { ok: false, reason: 'nobody to trade with' };
    var faction = factionOf(partner.factionId || partner.faction);
    if (faction && faction.hostile) return { ok: false, reason: faction.name + ' is at war with you' };
    var sKind = settlementKindOf(partner);
    if (sKind && sKind.canTradeWith === false) return { ok: false, reason: partner.name + ' has no counter' };
    if (partner.destroyed) return { ok: false, reason: 'it is gone' };
    if (partner.phase === 'leaving' || partner.angered) return { ok: false, reason: 'they are leaving' };
    var car = (opts && opts.caravan) || caravanAt(partner.tile, partner);
    if (partner.tile !== undefined && !car && !partner.pawnIds) {
      return { ok: false, reason: 'no caravan of yours is there' };
    }
    return { ok: true, reason: '' };
  };

  Trade.open = function (partner, opts) {
    opts = opts || {};
    if (!partner) return null;
    var g = game();
    var map = opts.map || (g && g.map) || null;
    var caravan = opts.caravan || (partner.tile !== undefined ? caravanAt(partner.tile, partner) : null);
    var faction = factionOf(partner.factionId || partner.faction);
    var kind = resolveTraderKind(partner);
    var negotiator = opts.negotiator || Trade.negotiatorFor(caravan || map);
    var social = negotiator ? skillOf(negotiator, 'social') : NEUTRAL_SKILL;

    var deal = {
      id: U.nextId(),
      partner: partner,
      partnerLabel: partnerLabelOf(partner, faction),
      partnerType: caravan ? 'remote' : (partner.pawnIds ? 'visitor' : 'settlement'),
      factionId: factionIdOf(partner.factionId || partner.faction),
      factionName: faction ? faction.name : 'strangers',
      traderKind: kind,
      traderKindId: kind ? kind.id : null,
      negotiator: negotiator,
      socialSkill: social,
      map: map,
      caravan: caravan || null,
      anchor: null,
      cells: null,
      theirStock: [],
      ourGoods: [],
      theirSilver: partnerSilver(partner),
      ourSilver: 0,
      basket: {},
      balance: 0,
      trades: 0,
      note: null,
      closed: false,
      error: null
    };

    if (!caravan && map) {
      deal.anchor = partner.standX !== undefined
        ? { x: partner.standX, y: partner.standY }
        : colonyCentre(map);
    }

    Trade.refresh(deal);
    return deal;
  };

  /* Rebuild both sides from live state and clear the basket. Called on
     open and again after every confirmed deal, so a second trade at the
     same counter sees what the first one left behind. */
  Trade.refresh = function (deal) {
    if (!deal) return deal;
    var kind = deal.traderKind;
    var faction = factionOf(deal.factionId);
    var buys = (kind && kind.buys) || null;
    var Z = sys('Zones');

    deal.theirStock.length = 0;
    var stock = partnerStock(deal.partner);
    for (var i = 0; i < stock.length; i++) {
      var def = thingDef(stock[i].defId);
      if (!def || !(stock[i].count > 0)) continue;
      deal.theirStock.push({
        defId: def.id, def: def, label: def.label, count: stock[i].count,
        quality: stock[i].quality === undefined ? null : stock[i].quality,
        price: Trade.priceOf(def, {
          buying: true, traderKind: kind, faction: faction,
          socialSkill: deal.socialSkill, quality: stock[i].quality
        })
      });
    }

    deal.ourGoods.length = 0;
    var accepts = function (d) {
      if (!buys || !Z || !Z.categoryOf) return true;
      return buys.indexOf(Z.categoryOf(d)) >= 0;
    };

    if (deal.caravan) {
      var items = deal.caravan.items || [];
      deal.ourSilver = 0;
      for (var c = 0; c < items.length; c++) {
        if (items[c].defId === 'silver') { deal.ourSilver += items[c].count; continue; }
        var cd = thingDef(items[c].defId);
        if (!cd || !isTradeGood(cd) || !accepts(cd) || !(items[c].count > 0)) continue;
        pushOurs(deal, cd, items[c].count, items[c].quality, kind, faction);
      }
    } else if (deal.map) {
      deal.cells = reachableCells(deal.map, deal.anchor || colonyCentre(deal.map));
      var found = colonyGoods(deal.map, deal.cells, accepts);
      deal.ourSilver = found.silver;
      found.rows.forEach(function (row) {
        pushOurs(deal, row.def, row.count, row.quality, kind, faction);
      });
      /* A trader deals with what is stacked where they can get at it.
         An empty counter on your side is almost always a colony with no
         stockpile rather than a colony with nothing, so say which. */
      deal.note = deal.cells.length ? null
        : 'Nothing of yours is in a stockpile they can reach. Build a stockpile near them, or a trade beacon.';
    }

    deal.theirSilver = partnerSilver(deal.partner);
    deal.basket = {};
    deal.balance = 0;
    deal.error = null;
    return deal;
  };

  function pushOurs(deal, def, count, quality, kind, faction) {
    var row = entryFor(deal.ourGoods, def.id);
    if (row) { row.count += count; return; }
    deal.ourGoods.push({
      defId: def.id, def: def, label: def.label, count: count,
      quality: quality === undefined ? null : quality,
      price: Trade.priceOf(def, {
        buying: false, traderKind: kind, faction: faction,
        socialSkill: deal.socialSkill, quality: quality
      })
    });
  }

  /* One signed basket: positive is coming to you, negative is going to
     them. That is why buy and sell are the same two lines. */
  function adjust(deal, defId, delta) {
    if (!deal || deal.closed || !delta) return 0;
    var theirs = entryFor(deal.theirStock, defId);
    var ours = entryFor(deal.ourGoods, defId);
    var lo = ours ? -ours.count : 0;
    var hi = theirs ? theirs.count : 0;
    var was = deal.basket[defId] || 0;
    var now = U.clamp(was + (delta | 0), lo, hi);
    if (now) deal.basket[defId] = now; else delete deal.basket[defId];
    Trade.recalc(deal);
    return now - was;
  }

  Trade.buy = function (deal, defId, count) {
    return adjust(deal, defId, count === undefined ? 1 : (count | 0));
  };
  Trade.sell = function (deal, defId, count) {
    return adjust(deal, defId, -(count === undefined ? 1 : (count | 0)));
  };

  /* Positive balance: you owe silver. Negative: they do. */
  Trade.recalc = function (deal) {
    var total = 0;
    for (var id in deal.basket) {
      var n = deal.basket[id];
      if (n > 0) {
        var t = entryFor(deal.theirStock, id);
        if (t) total += t.price * n;
      } else if (n < 0) {
        var o = entryFor(deal.ourGoods, id);
        if (o) total -= o.price * -n;
      }
    }
    deal.balance = Math.round(total);
    return deal.balance;
  };

  Trade.basketSummary = function (deal) {
    var bought = 0, sold = 0, value = 0;
    for (var id in deal.basket) {
      var n = deal.basket[id];
      if (n > 0) {
        bought += n;
        var t = entryFor(deal.theirStock, id);
        if (t) value += t.price * n;
      } else {
        sold += -n;
        var o = entryFor(deal.ourGoods, id);
        if (o) value += o.price * -n;
      }
    }
    return { bought: bought, sold: sold, value: Math.round(value) };
  };

  /* ---------- moving the goods, for real ---------- */

  function takeTheirs(deal, defId, count) {
    var stock = theirGoods(deal.partner);
    var left = count;
    for (var i = stock.length - 1; i >= 0 && left > 0; i--) {
      if (stock[i].defId !== defId) continue;
      var n = Math.min(left, stock[i].count);
      stock[i].count -= n;
      left -= n;
      if (stock[i].count <= 0) stock.splice(i, 1);
    }
    return count - left;
  }

  function giveTheirs(deal, defId, count) {
    var stock = theirGoods(deal.partner);
    for (var i = 0; i < stock.length; i++) {
      if (stock[i].defId === defId) { stock[i].count += count; return count; }
    }
    stock.push({ defId: defId, count: count });
    return count;
  }

  function dropPoint(deal) {
    var map = deal.map;
    if (deal.anchor && map.passable(deal.anchor.x, deal.anchor.y)) return deal.anchor;
    return colonyCentre(map);
  }

  function takeOurs(deal, defId, count) {
    if (deal.caravan) {
      var items = deal.caravan.items || (deal.caravan.items = []);
      var left = count;
      for (var i = items.length - 1; i >= 0 && left > 0; i--) {
        if (items[i].defId !== defId) continue;
        var n = Math.min(left, items[i].count);
        items[i].count -= n;
        left -= n;
        if (items[i].count <= 0) items.splice(i, 1);
      }
      return count - left;
    }
    return takeColonyDef(deal.map, deal.cells || [], defId, count);
  }

  function giveOurs(deal, defId, count) {
    if (deal.caravan) {
      var items = deal.caravan.items || (deal.caravan.items = []);
      for (var i = 0; i < items.length; i++) {
        if (items[i].defId === defId) { items[i].count += count; return count; }
      }
      items.push({ defId: defId, count: count });
      return count;
    }
    var at = dropPoint(deal);
    var made = deal.map.addItem(defId, at.x, at.y, count, { faction: 'player' });
    var moved = 0;
    for (var m = 0; m < made.length; m++) moved += made[m].stack;
    return Math.min(count, moved);
  }

  Trade.confirm = function (deal) {
    if (!deal || deal.closed) return false;
    deal.error = null;

    var lines = [], id;
    for (id in deal.basket) if (deal.basket[id]) lines.push({ defId: id, n: deal.basket[id] });
    if (!lines.length) { deal.error = 'nothing in the basket'; return false; }

    Trade.recalc(deal);
    var balance = deal.balance;
    if (balance > 0 && deal.ourSilver < balance) {
      deal.error = 'you cannot pay ' + balance + ' silver';
      return false;
    }
    if (balance < 0 && deal.theirSilver < -balance) {
      deal.error = deal.partnerLabel + ' cannot pay ' + (-balance) + ' silver';
      return false;
    }

    /* One last look at both sides: a stack can have burned, rotted or
       been hauled off while the window sat open. */
    for (var v = 0; v < lines.length; v++) {
      var row = lines[v].n > 0
        ? entryFor(deal.theirStock, lines[v].defId)
        : entryFor(deal.ourGoods, lines[v].defId);
      if (!row || row.count < Math.abs(lines[v].n)) {
        deal.error = 'the ' + (row ? row.label : lines[v].defId) + ' is no longer there';
        Trade.refresh(deal);
        return false;
      }
    }

    var summary = Trade.basketSummary(deal);
    for (var i = 0; i < lines.length; i++) {
      var defId = lines[i].defId, n = lines[i].n;
      if (n > 0) {
        var got = takeTheirs(deal, defId, n);
        if (got > 0) giveOurs(deal, defId, got);
      } else {
        var gave = takeOurs(deal, defId, -n);
        if (gave > 0) giveTheirs(deal, defId, gave);
      }
    }

    if (balance > 0) {
      takeOurs(deal, 'silver', balance);
      setPartnerSilver(deal, deal.theirSilver + balance);
    } else if (balance < 0) {
      giveOurs(deal, 'silver', -balance);
      setPartnerSilver(deal, deal.theirSilver + balance);
    }

    deal.trades++;
    /* Goodwill is for doing business, not for clicking. A handful of
       silver over the counter is a purchase; below that threshold a
       player could buy one berry eighty times and befriend a nation. */
    var F = sys('Factions');
    if (F && F.noteTrade && deal.factionId && summary.value >= GOODWILL_MIN_VALUE) {
      F.noteTrade(deal.factionId, summary.value);
    }

    msg(tradeLine(deal, summary, balance), { type: 'good' });
    Trade.refresh(deal);
    return true;
  };

  function setPartnerSilver(deal, amount) {
    var p = deal.partner;
    amount = Math.max(0, Math.round(amount));
    var delta = amount - deal.theirSilver;
    var wrote = false;

    if (typeof p.silver !== 'number' && p.items) {
      for (var i = 0; i < p.items.length && !wrote; i++) {
        if (p.items[i].defId === 'silver') { p.items[i].count = amount; wrote = true; }
      }
      if (!wrote) { p.items.push({ defId: 'silver', count: amount }); wrote = true; }
    }
    if (!wrote) p.silver = amount;

    /* A settlement's float is a slice of its wealth, and world.js saves
       wealth but not the float. Moving both keeps a drained counter
       drained across a save instead of quietly refilling it. */
    if (p.wealth !== undefined && !p.items) p.wealth = Math.max(0, Math.round(p.wealth + delta));
    deal.theirSilver = amount;
  }

  function tradeLine(deal, summary, balance) {
    var parts = [];
    if (summary.bought) parts.push('bought ' + summary.bought + ' ' + U.plural(summary.bought, 'item'));
    if (summary.sold) parts.push('sold ' + summary.sold);
    var money = balance > 0 ? ' for ' + balance + ' silver'
      : (balance < 0 ? ' for ' + (-balance) + ' silver' : ' in a straight swap');
    return 'Traded with ' + deal.partnerLabel + ': ' +
      (parts.length ? parts.join(' and ') : 'nothing') + money + '.';
  }

  /* ============================================================
     A TRADER WHO COMES TO YOU
     ============================================================ */

  function freeCellNear(map, x, y, radius) {
    var ring = U.cellsInRadius(x, y, radius);
    for (var i = 0; i < ring.length; i++) {
      var cx = ring[i][0], cy = ring[i][1];
      if (!map.inBounds(cx, cy) || !map.passable(cx, cy)) continue;
      if (map.buildingAt(cx, cy)) continue;
      if (map.pawnsAt(cx, cy).length) continue;
      return { x: cx, y: cy };
    }
    return null;
  }

  /* An edge the caravan can actually walk in from. A colony behind a
     mountain would otherwise get traders standing in the sea. */
  function arrivalSide(map, target) {
    var Path = sys('Path');
    var sides = U.shuffle(['n', 'e', 's', 'w']);
    var fallback = null;
    for (var s = 0; s < sides.length; s++) {
      var cells = root.MapGen.edgeSpawnCells(map, sides[s]);
      if (!cells.length) continue;
      var at = U.pick(cells);
      if (!fallback) fallback = at;
      if (!Path || !Path.reachable) return at;
      if (Path.reachable(map, at.x, at.y, target.x, target.y, {})) return at;
    }
    return fallback;
  }

  function guardPoints(techLevel) {
    if (techLevel === 'neolithic') return 60;
    if (techLevel === 'spacer') return 450;
    return 220;
  }

  function spawnVisitor(map, kindId, factionId, cell, opts) {
    if (!root.Defs.has('pawnKind', kindId)) return null;
    var built = root.MapGen.makePawn(kindId, factionId, {
      x: cell.x, y: cell.y, map: map,
      gear: opts && opts.points === undefined ? true : undefined,
      points: opts ? opts.points : undefined,
      tame: opts ? opts.tame : undefined
    });
    if (!built) return null;
    built.faction = factionId;
    if (!map.addPawn(built, cell.x, cell.y)) return null;
    built.fx = built.x; built.fy = built.y;
    return built;
  }

  Trade.arrivingTrader = function (g, factionId) {
    g = g || game();
    var map = g && g.map;
    if (!map || !root.MapGen || !root.MapGen.makePawn || !root.MapGen.edgeSpawnCells) return null;
    if (!map.colonists || !map.colonists().length) return null;
    syncGame(g);

    var F = sys('Factions');
    var faction = factionId ? factionOf(factionId) : null;
    if (!faction && F && F.tradeable) {
      var pool = F.tradeable().filter(function (f) { return !f.hostile; });
      if (pool.length) {
        faction = U.pickWeighted(pool, function (f) { return 1 + Math.max(0, f.goodwill) / 25; });
      }
    }
    if (!faction) return null;

    var kind = traderKindDef(F && F.traderKindFor ? F.traderKindFor(faction.id) : null) ||
      resolveTraderKind(faction);
    if (!kind) return null;

    var centre = colonyCentre(map);
    var edge = arrivalSide(map, centre);
    if (!edge) return null;
    var stand = freeCellNear(map, centre.x, centre.y, 12) || centre;

    var kinds = (faction.kind && faction.kind.pawnKinds) || {};
    var traderKindId = kind.pawnKindId ||
      (kinds.trader && kinds.trader.length ? U.pick(kinds.trader) : 'wanderer');
    var guardKindId = (kinds.guard && kinds.guard.length) ? U.pick(kinds.guard) : 'raider';
    var points = guardPoints(faction.techLevel);

    var spot = freeCellNear(map, edge.x, edge.y, 6) || edge;
    var trader = spawnVisitor(map, traderKindId, faction.id, spot, {});
    if (!trader) return null;

    var crew = [trader];
    var guards = U.randInt((kind.guardCount || [1, 2])[0], (kind.guardCount || [1, 2])[1]);
    for (var gi = 0; gi < guards; gi++) {
      var gc = freeCellNear(map, edge.x + U.randInt(-2, 2), edge.y + U.randInt(-2, 2), 6);
      if (!gc) continue;
      var guard = spawnVisitor(map, guardKindId, faction.id, gc, { points: points });
      if (guard) crew.push(guard);
    }

    /* Pack animals are what makes a caravan read as a caravan. They are
       the trader's, so they walk where the trader walks. */
    if (root.Defs.has('pawnKind', 'muffalo')) {
      var beasts = U.randInt(1, 3);
      for (var bi = 0; bi < beasts; bi++) {
        var bc = freeCellNear(map, edge.x + U.randInt(-3, 3), edge.y + U.randInt(-3, 3), 7);
        if (!bc) continue;
        var beast = spawnVisitor(map, 'muffalo', faction.id, bc, { tame: true });
        if (!beast) continue;
        beast.master = trader.id;
        if (beast.trainedLevels) beast.trainedLevels.obedience = 1;
        crew.push(beast);
      }
    }

    var visit = {
      id: U.nextId(),
      factionId: faction.id,
      factionName: faction.name,
      traderKindId: kind.id,
      traderKind: kind,
      traderId: trader.id,
      trader: trader,
      pawns: crew,
      pawnIds: crew.map(function (p) { return p.id; }),
      stock: Trade.stockFor({ factionId: faction.id, traderKindId: kind.id }, null),
      silver: U.randInt((kind.silverRange || [600, 1200])[0], (kind.silverRange || [600, 1200])[1]),
      arrivedTick: g.tick,
      leaveTick: g.tick + Math.round((kind.visitDays || 1.5) * TICKS_PER_DAY),
      walkOutBy: 0,
      phase: 'arriving',
      standX: stand.x, standY: stand.y,
      exitX: edge.x, exitY: edge.y,
      deaths: 0, angered: false
    };
    for (var ci = 0; ci < crew.length; ci++) crew[ci].tradeVisitId = visit.id;
    Trade.visitors.push(visit);
    orderCrew(visit, visit.standX, visit.standY);

    letter('A trade caravan arrives',
      'A ' + kind.label + ' from ' + faction.name + ' has walked onto your land with ' +
      visit.stock.length + ' kinds of goods and ' + visit.silver + ' silver. They will wait about ' +
      U.fmt(kind.visitDays || 1.5, 1) + ' days. They are guests: what happens to them is remembered.',
      { kind: 'good', x: stand.x, y: stand.y });
    return visit;
  };

  /* ---------- keeping the visit moving ---------- */

  /* One goto, re-issued only when it has actually lapsed. `slack` is how
     far the pawn may drift before being called back: a tile while they
     are walking somewhere, a few while they are standing at the counter,
     which is what lets them mill about instead of marching on the spot. */
  function orderTo(pawn, x, y, slack) {
    if (!pawn || pawn.dead || pawn.tradeGone || !pawn.map) return false;
    var J = sys('Jobs'), T = sys('T');
    if (!J || !J.make || !T) return false;
    var mark = pawn.tradeOrder;
    var settled = U.dist(pawn.x, pawn.y, x, y) <= (slack || 1.5);
    if (settled) { pawn.tradeOrder = { x: x, y: y }; return false; }
    if (mark && mark.x === x && mark.y === y) {
      if (pawn.job && pawn.job.defId === 'goto') return false;
      if (pawn.jobQueue && pawn.jobQueue.length) return false;
    }
    var job = J.make('goto', T.cell(x, y));
    if (!job) return false;
    job.state.pe = 0;
    pawn.jobQueue.length = 0;
    pawn.jobQueue.push(job);
    pawn.tradeOrder = { x: x, y: y };
    if (pawn.job) pawn.endJob('interrupted');
    return true;
  }

  /* Everyone heads for the same point, spread out around it so the whole
     caravan does not try to stand on one tile. The spread is rolled once
     per destination and kept: re-rolling it every slow tick would send
     each pawn to a slightly different tile forever and nobody would
     ever arrive anywhere. */
  function crewSpots(visit, x, y) {
    if (visit.spots && visit.spotX === x && visit.spotY === y) return visit.spots;
    var map = null;
    for (var m = 0; m < visit.pawns.length && !map; m++) {
      if (visit.pawns[m] && !visit.pawns[m].tradeGone) map = visit.pawns[m].map;
    }
    visit.spotX = x; visit.spotY = y;
    visit.spots = [];
    for (var i = 0; i < visit.pawns.length; i++) {
      var spot = null;
      if (i > 0 && map) {
        spot = freeCellNear(map, x + U.randInt(-3, 3), y + U.randInt(-3, 3), 4);
      }
      visit.spots.push(spot || { x: x, y: y });
    }
    return visit.spots;
  }

  function orderCrew(visit, x, y, slack) {
    var spots = crewSpots(visit, x, y);
    for (var i = 0; i < visit.pawns.length; i++) {
      var p = visit.pawns[i];
      if (!p || p.dead || p.tradeGone || p.prisoner) continue;
      orderTo(p, spots[i].x, spots[i].y, slack);
    }
  }

  function livePawns(visit) {
    var out = [];
    for (var i = 0; i < visit.pawns.length; i++) {
      var p = visit.pawns[i];
      if (p && !p.dead && !p.tradeGone && !p.prisoner && p.map) out.push(p);
    }
    return out;
  }

  function despawnVisitor(pawn) {
    pawn.tradeGone = true;
    pawn.tradeVisitId = 0;
    pawn.deSpawn();
  }

  /* The trader is the one who has to reach the counter; the guards and
     the pack animals trail in behind. Judging arrival on the whole crew
     would let one muffalo stuck behind a wall close the shop. */
  function leaderOf(visit) {
    if (visit.trader && !visit.trader.dead && !visit.trader.tradeGone && !visit.trader.prisoner) {
      return visit.trader;
    }
    var live = livePawns(visit);
    for (var i = 0; i < live.length; i++) if (live[i].isHuman) return live[i];
    return live[0] || null;
  }

  /* A guest who dies or ends up in your cells costs you the
     civilization. The count is taken here because nothing else in the
     game knows these pawns were guests rather than passers-by. */
  function noteCasualties(visit) {
    var F = sys('Factions'), dead = 0, taken = 0;
    for (var i = 0; i < visit.pawns.length; i++) {
      var p = visit.pawns[i];
      if (!p || p.tradeCounted) continue;
      if (p.dead) {
        p.tradeCounted = true;
        dead++;
        if (F && F.notePawnKilled && p.isHuman) F.notePawnKilled(p, null);
      } else if (p.prisoner) {
        p.tradeCounted = true;
        taken++;
        if (F && F.adjustGoodwill) {
          F.adjustGoodwill(visit.factionId, -U.randInt(10, 18), 'you took a trader prisoner');
        }
      }
    }
    if (!dead && !taken) return false;
    visit.deaths += dead;
    if (!visit.angered) {
      visit.angered = true;
      letter('Blood on the trade road',
        visit.factionName + ' came to sell you goods and are burying their own instead. ' +
        'The survivors are running for the edge of the map, and they will tell the story at home.',
        { kind: 'threat', x: visit.standX, y: visit.standY });
    }
    return true;
  }

  function beginDeparture(visit, g) {
    visit.phase = 'leaving';
    /* However badly the walk out goes, the caravan is off the map inside
       a day. A trader wedged behind a wall is not a permanent feature. */
    visit.walkOutBy = g.tick + TICKS_PER_DAY;
    orderCrew(visit, visit.exitX, visit.exitY, 1.5);
  }

  function endVisit(visit, quiet) {
    var live = livePawns(visit);
    for (var i = 0; i < live.length; i++) despawnVisitor(live[i]);
    U.remove(Trade.visitors, visit);
    if (!quiet) {
      msg('The ' + (visit.traderKind ? visit.traderKind.label : 'traders') +
        ' of ' + visit.factionName + ' have moved on.', { type: 'info' });
    }
  }

  function tickVisit(g, visit) {
    noteCasualties(visit);
    var live = livePawns(visit);
    if (!live.length) { U.remove(Trade.visitors, visit); return; }

    if (visit.angered && visit.phase !== 'leaving') beginDeparture(visit, g);

    if (visit.phase === 'arriving') {
      var leader = leaderOf(visit);
      if (leader && U.dist(leader.x, leader.y, visit.standX, visit.standY) <= ARRIVE_RADIUS) {
        visit.phase = 'trading';
        visit.leaveTick = g.tick + Math.round((visit.traderKind.visitDays || 1.5) * TICKS_PER_DAY);
        msg('The ' + visit.traderKind.label + ' of ' + visit.factionName + ' is open for business.',
          { type: 'good', x: visit.standX, y: visit.standY });
        return;
      }
      orderCrew(visit, visit.standX, visit.standY, 1.5);
      /* Traders who cannot find a way in do not stand at the edge for a
         season waiting for you to knock a wall down. */
      if (g.tick - visit.arrivedTick > TICKS_PER_DAY) {
        msg('The ' + visit.traderKind.label + ' of ' + visit.factionName +
          ' could not find a way in and is turning back.', { type: 'info', x: visit.exitX, y: visit.exitY });
        beginDeparture(visit, g);
      }
      return;
    }

    if (visit.phase === 'trading') {
      if (g.tick >= visit.leaveTick) {
        msg('The ' + visit.traderKind.label + ' of ' + visit.factionName + ' is packing up.',
          { type: 'info', x: visit.standX, y: visit.standY });
        beginDeparture(visit, g);
      } else {
        orderCrew(visit, visit.standX, visit.standY, ARRIVE_RADIUS);
      }
      return;
    }

    orderCrew(visit, visit.exitX, visit.exitY, 1.5);
    for (var i = 0; i < live.length; i++) {
      if (U.dist(live[i].x, live[i].y, visit.exitX, visit.exitY) <= 2.5) despawnVisitor(live[i]);
    }
    if (!livePawns(visit).length || g.tick >= (visit.walkOutBy || 0)) endVisit(visit, visit.angered);
  }

  /* ============================================================
     THE SLOW CLOCK
     ============================================================ */

  /* A new colony in the same page session starts the clock over. Nobody
     calls us to say so, but a different map object and a clock that ran
     backwards both mean the same thing, and either is enough. Both
     entry points into a live game come through here, so a trader that
     arrived before the first slow tick is not swept away by it. */
  function syncGame(g) {
    var st = Trade.state;
    if (g.map !== st.map || g.tick < st.lastTick) Trade.reset();
    st.map = g.map;
    st.lastTick = g.tick;
  }

  function restockSettlements(g) {
    var W = sys('World');
    if (!W || !W.liveSettlements) return;
    var list = W.liveSettlements();
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var kindDef = defMaybe('settlementKind', s.kind);
      if (kindDef && kindDef.canTradeWith === false) continue;
      var days = (kindDef && kindDef.restockDays) || 8;
      if (s.stock && s.stock.length && g.tick - (s.lastRestockTick || 0) < days * TICKS_PER_DAY) continue;
      s.stock = Trade.stockFor(s, null);
      s.lastRestockTick = g.tick;
    }
  }

  function scheduleArrivals(g) {
    var st = Trade.state;
    if (!st.nextArrivalTick) {
      st.nextArrivalTick = g.tick + U.randInt(2 * TICKS_PER_DAY, 5 * TICKS_PER_DAY);
      return;
    }
    if (g.tick < st.nextArrivalTick) return;
    st.nextArrivalTick = g.tick + U.randInt(3 * TICKS_PER_DAY, 7 * TICKS_PER_DAY);
    if (Trade.visitors.length >= MAX_VISITS) return;
    if (g.day && g.day() < FIRST_TRADER_DAY) return;
    Trade.arrivingTrader(g, null);
  }

  Trade.tick = function (g) {
    g = g || game();
    if (!g || !g.map) return;
    syncGame(g);

    restockSettlements(g);
    for (var i = Trade.visitors.length - 1; i >= 0; i--) tickVisit(g, Trade.visitors[i]);
    scheduleArrivals(g);
  };

  Trade.reset = function () {
    Trade.visitors.length = 0;
    Trade.state.nextArrivalTick = 0;
    Trade.state.lastTick = 0;
    Trade.state.map = null;
    return Trade;
  };

  /* ---------- what the world screen asks for ---------- */

  Trade.visiting = function () { return Trade.visitors.slice(); };

  Trade.visitOf = function (pawn) {
    if (!pawn || !pawn.tradeVisitId) return null;
    for (var i = 0; i < Trade.visitors.length; i++) {
      if (Trade.visitors[i].id === pawn.tradeVisitId) return Trade.visitors[i];
    }
    return null;
  };

  Trade.stockValue = function (stock) {
    var total = 0;
    for (var i = 0; stock && i < stock.length; i++) {
      var def = thingDef(stock[i].defId);
      if (def) total += (def.marketValue || 0) * stock[i].count;
    }
    return Math.round(total);
  };

  /* Every counter the colony could deal with right now, for the list the
     world screen draws. */
  Trade.partners = function () {
    var out = [], i;
    for (i = 0; i < Trade.visitors.length; i++) {
      var v = Trade.visitors[i];
      if (v.phase === 'leaving' || v.angered) continue;
      out.push({ kind: 'visitor', partner: v, label: v.traderKind.label + ' of ' + v.factionName });
    }
    var W = sys('World');
    if (W && W.liveSettlements) {
      var list = W.liveSettlements();
      for (i = 0; i < list.length; i++) {
        var s = list[i];
        if (!Trade.canOpen(s).ok) continue;
        out.push({ kind: 'settlement', partner: s, label: s.name });
      }
    }
    return out;
  };

  /* ---------- save ---------- */

  Trade.save = function () {
    return {
      nextArrivalTick: Trade.state.nextArrivalTick,
      lastTick: Trade.state.lastTick,
      visitors: Trade.visitors.map(function (v) {
        return {
          id: v.id, factionId: v.factionId, factionName: v.factionName,
          traderKindId: v.traderKindId, traderId: v.traderId, pawnIds: v.pawnIds.slice(),
          stock: v.stock.map(function (e) { return { defId: e.defId, count: e.count, price: e.price }; }),
          silver: v.silver, arrivedTick: v.arrivedTick, leaveTick: v.leaveTick,
          walkOutBy: v.walkOutBy, phase: v.phase,
          standX: v.standX, standY: v.standY, exitX: v.exitX, exitY: v.exitY,
          deaths: v.deaths, angered: v.angered
        };
      })
    };
  };

  Trade.load = function (data, map) {
    Trade.reset();
    if (!data) return Trade;
    Trade.state.nextArrivalTick = data.nextArrivalTick || 0;
    Trade.state.lastTick = data.lastTick || 0;
    var pawnById = new Map();
    var pawns = (map && map.pawns) || [];
    for (var p = 0; p < pawns.length; p++) pawnById.set(pawns[p].id, pawns[p]);

    /* A visit is only as real as the pawns standing on the map: one whose
       crew is not there any more was already over when the game was saved
       and is dropped rather than restored as a ghost counter. */
    (data.visitors || []).forEach(function (v) {
      var kind = defMaybe('traderKind', v.traderKindId);
      if (!kind) return;
      var crew = (v.pawnIds || []).map(function (id) { return pawnById.get(id); })
        .filter(function (x) { return x && !x.dead; });
      if (!crew.length) return;
      var visit = {
        id: v.id || U.nextId(), factionId: v.factionId, factionName: v.factionName,
        traderKindId: v.traderKindId, traderKind: kind,
        traderId: v.traderId, trader: pawnById.get(v.traderId) || crew[0],
        pawns: crew, pawnIds: crew.map(function (x) { return x.id; }),
        stock: v.stock || [], silver: v.silver || 0,
        arrivedTick: v.arrivedTick || 0, leaveTick: v.leaveTick || 0,
        walkOutBy: v.walkOutBy || 0, phase: v.phase || 'trading',
        standX: v.standX || 0, standY: v.standY || 0,
        exitX: v.exitX || 0, exitY: v.exitY || 0,
        deaths: v.deaths || 0, angered: !!v.angered
      };
      for (var i = 0; i < crew.length; i++) crew[i].tradeVisitId = visit.id;
      Trade.visitors.push(visit);
    });
    return Trade;
  };

  root.Trade = Trade;
})(this);
