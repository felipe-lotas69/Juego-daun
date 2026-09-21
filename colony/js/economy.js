/* ============================================================
   economy.js - the market underneath the prices.

   trade.js owns the act of trading: stock on a counter, a deal, the
   moment goods change hands. This file owns the world that makes
   those numbers mean something.

   Four ideas, and they compose:

   1. A price is not a def field. It starts at one - the baseline the
      def declares - and then moves. Every market keeps a multiplier
      per good; selling into a market pushes its multiplier down and
      buying out of it pushes it up, and both crawl back toward one
      over days. A town that just bought five hundred steel really
      does pay less for the next five hundred.

   2. A place is not a shop with a random shelf. Each settlement
      produces some things and wants others, read off its biome, its
      settlement kind and its civilization's tech level. That is a
      standing price gradient across the planet, which is the only
      thing that turns the world map into a route worth walking a
      caravan down.

   3. Labour is worth something. A recipe's value is the value of what
      went in plus the work that went in, capped, and never less than
      the def's own number - so the recipes that were already good
      keep exactly the value def_things.js gave them, and the ones
      that were quietly loss-making stop being a trap. Nothing here
      rewrites a def.

   4. Money is visible. Everything that enters or leaves the colony's
      stores is sampled on the slow tick and booked by category, so
      the player can read income, expenditure and a net figure per day
      instead of watching one wealth number wobble.

   On top of that sit contracts - a faction's standing offer with a
   deadline, a payment and a goodwill consequence - and standing
   orders, so an established trade route stops needing the same dialog
   every time a caravan walks in.

   Nothing in here reaches into trade.js. It reads what trade.js and
   world.js have already written down (a settlement's stock list, a
   visitor's stock list, the silver on the floor) and works out what
   must have happened. Trade.install() below is the one place that
   wires the two together, and it is opt-in.
   ============================================================ */
(function (root) {
  'use strict';

  var Economy = {};

  var TICKS_PER_DAY = 60000;

  /* The spread and the two things that move it. These match trade.js on
     purpose: a price quoted here and a price quoted there have to be the
     same price, or the player is reading two economies. */
  var BUY_SPREAD = 1.4;
  var SELL_SPREAD = 0.6;
  var SOCIAL_SWING = 0.15;
  var GOODWILL_SWING = 0.10;
  var NEUTRAL_SKILL = 10;
  var QUALITY_VALUE = [0.5, 0.75, 1, 1.25, 1.75, 2.5, 5];

  /* Labour. A work unit embeds this much silver in whatever it makes,
     and the premium is capped as a fraction of the ingredients so a
     thousand-work recipe on two silver of input cannot mint money. */
  var LABOUR_RATE = 0.012;
  var WORKMANSHIP_CAP = 0.30;
  /* ...and however dear the ingredients were, a market never carries a
     thing more than this far above the number its def states. The def
     values are the game's balance and this file does not get to rewrite
     them; it gets to say that labour is worth something on top. */
  var UPLIFT_CAP = 1.35;

  /* How far a market price may wander, how hard one deal pushes it, and
     how fast it crawls home. VOLUME_SILVER is what counts as a normal
     trade: four hundred silver of anything. */
  var PRICE_FLOOR = 0.55;
  var PRICE_CEIL = 1.90;
  var ELASTICITY = 0.55;
  /* No single transaction may move a price more than this much, however
     enormous it was. A caravan big enough to halve a nation's steel
     price in one afternoon is a caravan that has broken the game. */
  var PUSH_CAP = 0.25;
  var RECOVER_PER_DAY = 0.30;
  var VOLUME_SILVER = 400;

  /* What specialisation is worth. A place that makes a thing sells it
     cheap; a place that needs it pays over the odds. */
  var SPECIALISE_SELL = 0.78;
  var SPECIALISE_WANT = 1.32;

  var HISTORY_DAYS = 120;
  var LEDGER_DAYS = 60;
  var OFFER_MAX = 4;
  var OFFER_LIFE_DAYS = 6;
  var CONTRACT_INTERVAL_DAYS = 2.5;

  Economy.BUY_SPREAD = BUY_SPREAD;
  Economy.SELL_SPREAD = SELL_SPREAD;
  Economy.LABOUR_RATE = LABOUR_RATE;

  /* Reasons a silver figure lands in the books. The sampler infers the
     first five from what appeared and disappeared; trade and contracts
     are booked explicitly because we know exactly what they were. */
  var CATEGORIES = ['harvest', 'gathering', 'crafting', 'construction',
    'eating', 'decay', 'trade', 'contracts', 'other'];
  Economy.CATEGORIES = CATEGORIES;

  /* ------------------------------------------------------------------
     Plumbing. economy.js loads after trade.js and caravan.js but before
     events.js, and the tools load a half-built game on purpose, so every
     reach outside this file is guarded and every one of them happens at
     tick time rather than at load.
     ------------------------------------------------------------------ */

  function sys(name) { return root[name]; }
  function game() { return root.Game || null; }

  /* game.js's slow tickers are called with the Game; its map tickers are
     called with (map, game). Taking either means it does not matter
     which list this file is wired into, now or later. */
  function gameArg(a, b) {
    if (a && a.doTick) return a;
    if (b && b.doTick) return b;
    return game();
  }
  function tickNow() { var g = game(); return g && g.tick !== undefined ? g.tick : 0; }
  function dayNow() { return Math.floor(tickNow() / TICKS_PER_DAY); }
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
    return 0;
  }

  function categoryOf(def) {
    var Z = sys('Zones');
    return (Z && Z.categoryOf && def) ? Z.categoryOf(def) : null;
  }

  function isGood(def) {
    if (!def || def.category !== 'item') return false;
    if (!(def.marketValue > 0)) return false;
    var c = categoryOf(def);
    return !!c && c !== 'corpses';
  }

  /* ============================================================
     STATE

     One object, because save() and reset() then have exactly one thing
     to write and one thing to clear.
     ============================================================ */

  function freshState() {
    return {
      map: null,
      lastTick: 0,
      lastDay: -1,
      nextOfferTick: 0,
      markets: {},          /* id -> {id, label, factionId, mult:{}, moved:{}} */
      history: {},          /* defId -> [price per day] */
      historyDay0: 0,
      stock: null,          /* last colony sample: {defId: units}             */
      stockValue: 0,
      partners: {},         /* partner key -> last seen {defId: units}        */
      days: [],             /* rolling per-day books                          */
      today: null,
      offers: [],
      contracts: [],
      orders: [],
      nextOrderId: 1,
      countedCorpses: [],
      silverSeen: undefined,
      silverBooked: 0,
      totals: { earned: 0, spent: 0, produced: 0, consumed: 0 }
    };
  }

  Economy.state = freshState();

  Economy.reset = function () {
    Economy.state = freshState();
    _valueCache = {};
    _chainCache = null;
    _profileCache = {};
    _primary = null;
    return Economy;
  };

  /* ============================================================
     BASELINE VALUE AND THE PRODUCTION CHAIN

     What a thing is worth before any market has an opinion. For a raw
     good that is the def's own number. For something a recipe makes it
     is the greater of the def's number and what the recipe cost: the
     ingredients at their own baseline, plus the work, capped.

     Recipes form cycles - a knife is forged from steel and smelted back
     into steel - so the walk marks what it is resolving and falls back
     to the plain def value if it comes round again.
     ============================================================ */

  var _valueCache = {};
  var _resolving = {};
  var _primary = null;

  /* Goods nature produces: a plant's harvest, a seam's yield, what comes
     off a carcass. Their price is the def's number and no recipe may
     move it. Without this rule one bad recipe reprices a raw material
     for the whole game - weaving wool into cloth would decide what
     cotton is worth, and mining steel would answer to weapon smelting.
     Built once, from the defs, because none of it changes at runtime. */
  function primaryGoods() {
    if (_primary) return _primary;
    _primary = {};
    var D = root.Defs;
    if (!D || !D.all) return _primary;
    var i, id;

    var things = D.all('thing');
    for (i = 0; i < things.length; i++) {
      var t = things[i];
      if (t.plant && t.plant.harvestedThing) _primary[t.plant.harvestedThing] = true;
      if (t.mineable && t.mineYield) for (id in t.mineYield) _primary[id] = true;
      if (t.natural && t.leavings) for (id in t.leavings) _primary[id] = true;
    }
    var kinds = D.all('pawnKind');
    for (i = 0; i < kinds.length; i++) {
      var k = kinds[i];
      if (k.butcherProducts) for (id in k.butcherProducts) _primary[id] = true;
    }
    /* Currency is not a commodity anybody makes. */
    _primary.silver = true;
    return _primary;
  }

  Economy.isPrimary = function (defId) {
    var def = thingDef(defId);
    return !!(def && primaryGoods()[def.id]);
  };

  function nutritionOf(def) {
    return (def && def.nutrition > 0) ? def.nutrition : 0.05;
  }

  /* An ingredient's cost. Three forms exist in def_recipes.js and all
     three land here; the nutrition form is priced off whichever
     candidate feeds a colonist most cheaply, because that is the one a
     cook actually reaches for. */
  function ingredientCost(ing) {
    if (!ing) return 0;
    if (ing.thing) return baseValue(ing.thing) * (ing.count || 1);
    var list = ing.anyOf || [];
    if (!list.length) return 0;

    if (ing.nutrition > 0) {
      var best = Infinity;
      for (var i = 0; i < list.length; i++) {
        var d = thingDef(list[i]);
        if (!d) continue;
        var per = baseValue(d) / nutritionOf(d);
        if (per < best) best = per;
      }
      if (best === Infinity) return 0;
      return best * ing.nutrition;
    }

    var cheap = Infinity;
    for (var j = 0; j < list.length; j++) {
      var v = baseValue(list[j]);
      if (v < cheap) cheap = v;
    }
    return (cheap === Infinity ? 0 : cheap) * (ing.count || 1);
  }

  /* What one unit of a recipe's product costs to make, sharing the bill
     across everything the recipe produces by def value. */
  function recipeCost(recipe, defId) {
    var products = recipe.products || {};
    var made = products[defId] || 0;
    if (made <= 0) return null;

    var inputs = 0, i;
    var ings = recipe.ingredients || [];
    for (i = 0; i < ings.length; i++) inputs += ingredientCost(ings[i]);

    /* Several products from one bill: the cost splits the way the def
       values split, so butchered leather does not carry the whole cost
       of the meat standing next to it. */
    var weightAll = 0, weightMine = 0;
    for (var id in products) {
      var d = thingDef(id);
      var w = (d ? (d.marketValue || 0) : 0) * products[id];
      weightAll += w;
      if (id === defId) weightMine = w;
    }
    var share = weightAll > 0 ? weightMine / weightAll : 1 / Math.max(1, Object.keys(products).length);

    var mine = inputs * share;
    var labour = (recipe.workAmount || 0) * LABOUR_RATE * share;
    var capped = Math.min(labour, mine * WORKMANSHIP_CAP);
    return (mine + capped) / made;
  }

  /* The baseline value of one unit, before quality, market or spread. */
  function baseValue(defId) {
    var def = thingDef(defId);
    if (!def) return 1;
    var key = def.id;
    if (_valueCache[key] !== undefined) return _valueCache[key];

    var plain = def.marketValue > 0 ? def.marketValue : 1;
    if (primaryGoods()[key]) { _valueCache[key] = plain; return plain; }
    if (_resolving[key]) return plain;

    _resolving[key] = true;
    var best = Infinity;
    var D = root.Defs;
    var recipes = (D && D.all) ? D.all('recipe') : [];
    for (var i = 0; i < recipes.length; i++) {
      var r = recipes[i];
      if (!r.products || !r.products[key]) continue;
      if (r.dynamicProducts) continue;
      var c = recipeCost(r, key);
      /* The cheapest way to make a thing is what a market will pay for
         it; a dearer recipe is the maker's problem, not the price. */
      if (c !== null && c < best) best = c;
    }
    _resolving[key] = false;

    var v = best === Infinity ? plain : U.clamp(best, plain, plain * UPLIFT_CAP);
    _valueCache[key] = v;
    return v;
  }

  Economy.baseValue = function (defId, quality) {
    var v = baseValue(defId);
    if (typeof quality === 'number') v *= QUALITY_VALUE[U.clamp(quality | 0, 0, 6)];
    return v;
  };

  /* Every recipe as a line of business: what it costs, what it makes,
     how much work it takes and what that is worth per day of one
     colonist's labour. This is the readout that lets a player pick an
     industry instead of guessing at one. */
  var _chainCache = null;

  Economy.chains = function () {
    if (_chainCache) return _chainCache;
    var D = root.Defs;
    var recipes = (D && D.all) ? D.all('recipe') : [];
    var out = [];

    for (var i = 0; i < recipes.length; i++) {
      var r = recipes[i];
      if (r.dynamicProducts) continue;
      var products = r.products || {};
      var ids = Object.keys(products);
      if (!ids.length) continue;

      var inputs = 0, j;
      var ings = r.ingredients || [];
      for (j = 0; j < ings.length; j++) inputs += ingredientCost(ings[j]);

      var outputs = 0, label = [];
      for (j = 0; j < ids.length; j++) {
        var d = thingDef(ids[j]);
        if (!d) continue;
        outputs += baseValue(d) * products[ids[j]];
        label.push(products[ids[j]] + ' ' + d.label);
      }

      var work = r.workAmount || 1;
      var margin = outputs - inputs;

      /* A tailor's shirt loses money at awful and makes money at
         excellent, and that is the whole shape of the trade. Say from
         which grade it starts paying instead of calling it a loss. */
      var breakEven = null;
      if (r.productQuality && margin < 0) {
        for (var q = 0; q < QUALITY_VALUE.length; q++) {
          if (outputs * QUALITY_VALUE[q] - inputs > 0) { breakEven = q; break; }
        }
      }
      /* A colonist at skill 10 works at 1.2 units a tick and puts in
         about eight hours, so a day of labour is this many work units. */
      var workPerDay = 1.2 * TICKS_PER_DAY * (8 / 24);
      out.push({
        recipeId: r.id, label: r.label || r.id,
        products: label.join(', '),
        skill: r.skill || null, workAmount: work,
        inputValue: Math.round(inputs * 10) / 10,
        outputValue: Math.round(outputs * 10) / 10,
        margin: Math.round(margin * 10) / 10,
        marginPerWork: margin / work,
        silverPerDay: Math.round(margin / work * workPerDay),
        breakEvenQuality: breakEven,
        researchId: r.researchPrerequisite || null,
        benches: (r.workbenches || []).slice()
      });
    }

    out.sort(function (a, b) { return b.silverPerDay - a.silverPerDay; });
    _chainCache = out;
    return out;
  };

  /* The chain that ends in one thing, raw material first. */
  Economy.chainFor = function (defId, depth) {
    var def = thingDef(defId);
    if (!def) return [];
    depth = depth === undefined ? 0 : depth;
    if (depth > 4) return [];

    /* A raw material is where the chain ends. Without this the walk
       follows weapon smelting back out of steel and into the knife it
       just came from, and prints a loop instead of a chain. */
    if (primaryGoods()[def.id]) {
      return [{ defId: def.id, label: def.label, value: baseValue(def), madeBy: null }];
    }

    var chains = Economy.chains();
    var best = null;
    for (var i = 0; i < chains.length; i++) {
      var r = defMaybe('recipe', chains[i].recipeId);
      if (!r || !r.products || !r.products[def.id]) continue;
      if (!best || chains[i].inputValue < best.inputValue) best = chains[i];
    }
    if (!best) return [{ defId: def.id, label: def.label, value: baseValue(def), madeBy: null }];

    var recipe = defMaybe('recipe', best.recipeId);
    var rows = [];
    var ings = (recipe && recipe.ingredients) || [];
    for (var j = 0; j < ings.length; j++) {
      var srcId = ings[j].thing || (ings[j].anyOf && ings[j].anyOf[0]);
      if (!srcId) continue;
      rows = rows.concat(Economy.chainFor(srcId, depth + 1));
    }
    rows.push({
      defId: def.id, label: def.label, value: baseValue(def),
      madeBy: best.recipeId, work: best.workAmount, margin: best.margin
    });
    return rows;
  };

  /* Which of those lines this colony could actually run today: it has
     the bench, the research is done, and something to feed it. */
  Economy.industries = function (map, opts) {
    opts = opts || {};
    map = map || (game() && game().map);
    var R = sys('Research');
    var chains = Economy.chains();
    var out = [];

    for (var i = 0; i < chains.length; i++) {
      var c = chains[i];
      if (c.margin <= 0) continue;
      if (c.researchId && R && R.isDone && !R.isDone(c.researchId)) continue;

      var hasBench = !c.benches.length;
      for (var b = 0; b < c.benches.length && !hasBench; b++) {
        if (map && map.byDef && map.byDef(c.benches[b]).length) hasBench = true;
      }
      if (!hasBench && !opts.includeUnbuilt) continue;

      out.push({
        recipeId: c.recipeId, label: c.label, products: c.products,
        skill: c.skill, silverPerDay: c.silverPerDay,
        margin: c.margin, inputValue: c.inputValue, outputValue: c.outputValue,
        ready: hasBench
      });
    }
    return out.slice(0, opts.limit || 12);
  };

  /* ============================================================
     MARKETS

     One market per civilization, plus 'world' as the fallback for a
     counter with no civilization behind it. A settlement borrows its
     faction's market and adds its own specialisation on top, which is
     why two towns of the same nation can still be worth the walk
     between them.
     ============================================================ */

  function marketIdFor(faction, settlement) {
    if (settlement && settlement.factionId) return 'f:' + settlement.factionId;
    var id = factionIdOf(faction);
    return id ? 'f:' + id : 'world';
  }

  function market(id) {
    var m = Economy.state.markets[id];
    if (!m) {
      m = Economy.state.markets[id] = {
        id: id,
        factionId: id.indexOf('f:') === 0 ? id.slice(2) : null,
        mult: {}, moved: {}
      };
    }
    return m;
  }

  Economy.markets = function () {
    var out = [], m = Economy.state.markets;
    for (var id in m) out.push(m[id]);
    return out;
  };

  /* How many units of a thing count as one normal trade. Cheap bulk
     moves by the hundred, a rifle moves one at a time, and the price
     should react to both the same way. */
  function volumeOf(def) {
    return Math.max(1, Math.round(VOLUME_SILVER / Math.max(0.5, baseValue(def))));
  }

  Economy.multiplier = function (defId, opts) {
    opts = opts || {};
    var def = thingDef(defId);
    if (!def) return 1;
    var m = market(marketIdFor(opts.faction, opts.settlement));
    var v = m.mult[def.id];
    return v === undefined ? 1 : v;
  };

  /* Goods moved. Positive units means the market took them in - the
     colony sold - so its price falls. Negative means it gave them up
     and the next lot costs more. */
  Economy.noteFlow = function (defId, units, opts) {
    opts = opts || {};
    var def = thingDef(defId);
    if (!def || !units) return 0;
    var m = market(marketIdFor(opts.faction, opts.settlement));
    var cur = m.mult[def.id] === undefined ? 1 : m.mult[def.id];

    var push = U.clamp(ELASTICITY * units / volumeOf(def), -PUSH_CAP, PUSH_CAP);
    var next = push >= 0 ? cur / (1 + push) : cur * (1 - push);
    m.mult[def.id] = U.clamp(next, PRICE_FLOOR, PRICE_CEIL);
    m.moved[def.id] = (m.moved[def.id] || 0) + units;
    return m.mult[def.id];
  };

  /* Every market crawls back toward its baseline. Called once per
     economy tick with how much of a day has passed, and exposed so the
     world screen can answer "what will this be worth in a week?"
     without waiting a week. */
  Economy.drift = function (days) { driftMarkets(days || 0); return Economy; };

  function driftMarkets(dayFraction) {
    var pull = U.clamp(RECOVER_PER_DAY * dayFraction, 0, 1);
    if (pull <= 0) return;
    var all = Economy.state.markets;
    for (var id in all) {
      var mult = all[id].mult;
      for (var defId in mult) {
        var v = mult[defId] + (1 - mult[defId]) * pull;
        if (Math.abs(v - 1) < 0.005) delete mult[defId];
        else mult[defId] = v;
      }
    }
  }

  /* ============================================================
     THE PRICE

     One entry point, and the only one anybody outside this file needs.
     `buying` is from the colony's side: true is what you pay them,
     false is what they pay you. Pass `spread: false` for the bare
     market price, which is what a graph wants.
     ============================================================ */

  Economy.priceOf = function (defId, opts) {
    opts = opts || {};
    var def = thingDef(defId);
    if (!def) return 1;

    var v = baseValue(def);
    if (typeof opts.quality === 'number') v *= QUALITY_VALUE[U.clamp(opts.quality | 0, 0, 6)];

    var settlement = opts.settlement || null;
    var faction = opts.faction || (settlement && settlement.factionId) || null;

    v *= Economy.multiplier(def, { faction: faction, settlement: settlement });
    v *= specialisationFactor(def, settlement, faction);

    var kind = opts.traderKind && opts.traderKind.priceFactor > 0 ? opts.traderKind : null;
    if (!kind && typeof opts.traderKind === 'string') kind = defMaybe('traderKind', opts.traderKind);
    if (kind && kind.priceFactor > 0) v *= kind.priceFactor;

    if (opts.spread === false) return Math.max(1, Math.round(v * 100) / 100);

    var buying = opts.buying !== false;
    v *= buying ? BUY_SPREAD : SELL_SPREAD;

    var skill = opts.socialSkill;
    if (skill === undefined && opts.negotiator) skill = skillOf(opts.negotiator, 'social');
    if (skill === undefined) skill = NEUTRAL_SKILL;
    var social = (U.clamp(skill, 0, 20) / 20 - 0.5) * 2 * SOCIAL_SWING;
    if (opts.negotiator && opts.negotiator.tradeReputation > 0) {
      social += U.clamp(opts.negotiator.tradeReputation, 0, 1) * 0.05;
    }

    var gw = opts.goodwill;
    if (gw === undefined) {
      var f = factionOf(faction);
      gw = f ? f.goodwill : 0;
    }
    var favour = social + U.clamp(gw, -100, 100) / 100 * GOODWILL_SWING;
    v *= buying ? (1 - favour) : (1 + favour);

    return Math.max(1, Math.round(v));
  };

  /* The bare market price, for a graph or a comparison. */
  Economy.marketPrice = function (defId, opts) {
    opts = opts || {};
    opts.spread = false;
    return Economy.priceOf(defId, opts);
  };

  /* What the same good fetches here versus there, which is the whole
     argument for loading a caravan. */
  Economy.spreadBetween = function (defId, fromSettlement, toSettlement) {
    var buy = Economy.priceOf(defId, { settlement: fromSettlement, buying: true });
    var sell = Economy.priceOf(defId, { settlement: toSettlement, buying: false });
    return { buy: buy, sell: sell, margin: sell - buy, ratio: sell / Math.max(1, buy) };
  };

  /* ============================================================
     REGIONAL SPECIALISATION

     What a place makes and what it needs. Three inputs, all of them
     already written down somewhere else: the biome under the dot, the
     settlement kind's warehouse, and the civilization's tech level.
     ============================================================ */

  /* Biomes make raw materials. Nothing here names a settlement or a
     faction - it is what the ground gives up. */
  var BIOME_PRODUCE = {
    temperateForest: { wood: 1, riceRaw: 0.8, potatoRaw: 0.7, berries: 0.6, leather: 0.5 },
    tropicalRainforest: { wood: 1, berries: 0.9, cornRaw: 0.8, herbalMedicine: 0.7, cloth: 0.5 },
    grassland: { riceRaw: 1, cornRaw: 0.9, hay: 0.8, leather: 0.7, cloth: 0.6 },
    aridShrubland: { leather: 0.9, cloth: 0.7, stoneChunk: 0.6, cornRaw: 0.5 },
    desert: { stoneBlocks: 0.9, stoneChunk: 0.8, steel: 0.6, leather: 0.4 },
    extremeDesert: { stoneBlocks: 1, steel: 0.7, stoneChunk: 0.6 },
    borealForest: { wood: 1, leather: 0.9, meatRaw: 0.7, herbalMedicine: 0.4 },
    tundra: { leather: 1, meatRaw: 0.8, steel: 0.4 },
    iceSheet: { leather: 0.8, meatRaw: 0.6 }
  };

  var BIOME_WANT = {
    temperateForest: { steel: 0.7, components: 0.8, medicine: 0.6 },
    tropicalRainforest: { steel: 0.9, medicine: 0.9, cloth: 0.4 },
    grassland: { wood: 0.8, steel: 0.7, stoneBlocks: 0.5 },
    aridShrubland: { riceRaw: 0.9, wood: 0.9, mealSimple: 0.6 },
    desert: { riceRaw: 1, wood: 1, mealSimple: 0.8, medicine: 0.6 },
    extremeDesert: { riceRaw: 1, wood: 1, mealSimple: 0.9, cloth: 0.7 },
    borealForest: { riceRaw: 0.8, cloth: 0.7, medicine: 0.6 },
    tundra: { riceRaw: 1, wood: 0.9, mealSimple: 0.8, cloth: 0.8 },
    iceSheet: { riceRaw: 1, wood: 1, mealSimple: 1, cloth: 0.9, medicine: 0.8 }
  };

  /* Tech level decides what a civilization can make for itself and what
     it has to buy. A tribal camp sells leather and wants steel; an
     industrial town sells components and wants food. */
  var TECH_PRODUCE = {
    neolithic: { leather: 1, cloth: 0.8, herbalMedicine: 0.9, spear: 0.6, shortBow: 0.6, berries: 0.6 },
    medieval: { cloth: 0.8, leather: 0.7, stoneBlocks: 0.8, knife: 0.6, club: 0.5, wood: 0.6 },
    industrial: { components: 1, steel: 0.9, medicine: 0.8, pistol: 0.7, boltRifle: 0.6, chemfuel: 0.6 },
    spacer: { components: 1, medicine: 1, autoRifle: 0.8, sniperRifle: 0.7, armorVest: 0.7, helmet: 0.6 }
  };

  var TECH_WANT = {
    neolithic: { steel: 1, components: 1, medicine: 0.9, mealSimple: 0.5, pistol: 0.8 },
    medieval: { steel: 0.9, components: 1, medicine: 0.8, boltRifle: 0.7 },
    industrial: { riceRaw: 0.8, potatoRaw: 0.7, mealSimple: 0.8, leather: 0.7, cloth: 0.6, wood: 0.6 },
    spacer: { mealFine: 0.9, leather: 0.8, cloth: 0.7, riceRaw: 0.6, wood: 0.5 }
  };

  var _profileCache = {};

  function addWeights(into, table, scale) {
    if (!table) return;
    for (var id in table) {
      if (!defMaybe('thing', id)) continue;
      into[id] = Math.max(into[id] || 0, table[id] * scale);
    }
  }

  /* A settlement's standing position: what it has too much of, what it
     is short of. Cached per settlement, because none of the three
     inputs change once the planet is generated. */
  Economy.profileFor = function (settlement) {
    if (!settlement) return { produces: {}, wants: {}, techLevel: 'industrial', biome: null };
    var key = 's' + (settlement.id || 0);
    if (_profileCache[key]) return _profileCache[key];

    var W = sys('World');
    var biome = (W && W.biomeOf && settlement.tile !== undefined) ? W.biomeOf(settlement.tile) : null;
    var faction = factionOf(settlement.factionId);
    var tech = (faction && faction.techLevel) || settlement.techLevel || 'industrial';

    var produces = {}, wants = {};
    addWeights(produces, BIOME_PRODUCE[biome], 1);
    addWeights(produces, TECH_PRODUCE[tech], 1);
    addWeights(wants, BIOME_WANT[biome], 1);
    addWeights(wants, TECH_WANT[tech], 1);

    /* The settlement kind's own warehouse narrows it: a village with a
       grain store is not selling rifles whatever its nation makes. */
    var sKind = defMaybe('settlementKind', settlement.kind);
    if (sKind && sKind.stockCategories && sKind.stockCategories.length) {
      for (var id in produces) {
        var d = thingDef(id);
        var c = d ? categoryOf(d) : null;
        if (c && sKind.stockCategories.indexOf(c) < 0) produces[id] *= 0.35;
      }
    }

    /* Nothing can be both. Where the biome and the tech level disagree,
       whichever pull is stronger wins and the other is dropped. */
    for (var w in wants) {
      if (produces[w] === undefined) continue;
      if (produces[w] >= wants[w]) delete wants[w];
      else delete produces[w];
    }

    var profile = { produces: produces, wants: wants, techLevel: tech, biome: biome };
    _profileCache[key] = profile;
    return profile;
  };

  function specialisationFactor(def, settlement, faction) {
    if (!settlement) {
      /* A visiting trader with no dot on the map still carries its
         civilization's bias, which is most of the flavour. */
      var f = factionOf(faction);
      if (!f) return 1;
      var makes = TECH_PRODUCE[f.techLevel];
      var needs = TECH_WANT[f.techLevel];
      if (makes && makes[def.id]) return U.lerp(1, SPECIALISE_SELL, makes[def.id]);
      if (needs && needs[def.id]) return U.lerp(1, SPECIALISE_WANT, needs[def.id]);
      return 1;
    }
    var p = Economy.profileFor(settlement);
    if (p.produces[def.id]) return U.lerp(1, SPECIALISE_SELL, U.clamp01(p.produces[def.id]));
    if (p.wants[def.id]) return U.lerp(1, SPECIALISE_WANT, U.clamp01(p.wants[def.id]));
    return 1;
  }

  Economy.produces = function (settlement) {
    return rankWeights(Economy.profileFor(settlement).produces);
  };
  Economy.wants = function (settlement) {
    return rankWeights(Economy.profileFor(settlement).wants);
  };

  function rankWeights(table) {
    var out = [];
    for (var id in table) {
      var d = thingDef(id);
      if (!d) continue;
      out.push({ defId: id, label: d.label, strength: Math.round(table[id] * 100) / 100 });
    }
    out.sort(function (a, b) { return b.strength - a.strength; });
    return out;
  }

  /* What trade.js should put on a settlement's counter: a bias, not a
     stock list. It stays a list of thing ids and weights so stockFor
     can roll from it without this file knowing how stock is built. */
  Economy.stockPlanFor = function (settlement) {
    var p = Economy.profileFor(settlement);
    var plan = [];
    for (var id in p.produces) {
      var d = thingDef(id);
      if (!d || !isGood(d)) continue;
      plan.push({ defId: id, weight: p.produces[id], category: categoryOf(d) });
    }
    plan.sort(function (a, b) { return b.weight - a.weight; });
    return plan;
  };

  /* The pitch for a caravan: carry these, bring back those. */
  Economy.tradeRoute = function (settlement, opts) {
    opts = opts || {};
    if (!settlement) return null;
    var W = sys('World');
    var carry = [], bring = [], i;

    /* The comparison that matters is this counter against any other
       counter, because a colony can always sell at the door. Against the
       raw def value nothing ever looks worth walking for: every counter
       buys at a discount, and that discount is not the journey. */
    var wants = Economy.wants(settlement);
    for (i = 0; i < wants.length && carry.length < 5; i++) {
      var here = Economy.priceOf(wants[i].defId, { buying: false });
      var there = Economy.priceOf(wants[i].defId, { settlement: settlement, buying: false });
      if (there <= here) continue;
      carry.push({
        defId: wants[i].defId, label: wants[i].label,
        price: there, elsewhere: here, over: Math.round(there - here)
      });
    }

    var makes = Economy.produces(settlement);
    for (i = 0; i < makes.length && bring.length < 5; i++) {
      var costHere = Economy.priceOf(makes[i].defId, { buying: true });
      var costThere = Economy.priceOf(makes[i].defId, { settlement: settlement, buying: true });
      bring.push({
        defId: makes[i].defId, label: makes[i].label,
        price: costThere, elsewhere: costHere, under: Math.round(costHere - costThere)
      });
    }

    var days = 0;
    if (W && W.travelDays && W.colonyTile !== undefined) {
      days = Math.round(W.travelDays(W.colonyTile, settlement.tile, opts.speed) * 10) / 10;
    }
    return {
      settlementId: settlement.id, name: settlement.name,
      factionId: settlement.factionId, travelDays: days,
      carry: carry, bring: bring
    };
  };

  /* Every counter on the planet, ranked by what the round trip is
     worth. This is the readout the world screen wants. */
  Economy.routes = function (limit) {
    var W = sys('World');
    if (!W || !W.liveSettlements) return [];
    var list = W.liveSettlements(), out = [];
    for (var i = 0; i < list.length; i++) {
      var sKind = defMaybe('settlementKind', list[i].kind);
      if (sKind && sKind.canTradeWith === false) continue;
      var r = Economy.tradeRoute(list[i]);
      if (!r) continue;
      r.score = U.sum(r.carry, function (c) { return c.over; }) / Math.max(1, r.travelDays || 1);
      out.push(r);
    }
    out.sort(function (a, b) { return b.score - a.score; });
    return out.slice(0, limit || 8);
  };

  /* ============================================================
     THE COLONY'S BOOKS

     Everything spawned on the map that is an item, counted by def, once
     an economy tick. The diff against the last count is what the colony
     made and what it used up, and that - not a single wealth number -
     is the flow the player has never been able to see.
     ============================================================ */

  function sampleColony(map) {
    var out = {};
    if (!map || !map.byDef) return out;
    var D = root.Defs;
    var items = (D && D.items) ? D.items() : [];
    for (var i = 0; i < items.length; i++) {
      var def = items[i];
      if (!isGood(def)) continue;
      var list = map.byDef(def.id), n = 0;
      for (var j = 0; j < list.length; j++) {
        if (list[j] && list[j].spawned) n += list[j].stack || 1;
      }
      if (n) out[def.id] = n;
    }
    return out;
  }

  Economy.stocks = function (map) {
    return sampleColony(map || (game() && game().map));
  };

  Economy.countOf = function (map, defId) {
    map = map || (game() && game().map);
    if (!map || !map.byDef) return 0;
    var list = map.byDef(defId), n = 0;
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].spawned) n += list[i].stack || 1;
    return n;
  };

  Economy.silver = function (map) { return Economy.countOf(map, 'silver'); };

  /* Which line of the books a gain or a loss belongs on. We do not know
     which colonist did it, but the good itself says most of it: rice
     that appeared was grown, steel that disappeared was built with. */
  function categoryForGain(def) {
    var c = categoryOf(def);
    if (c === 'rawFood') return 'harvest';
    if (c === 'resources' || c === 'stone' || c === 'chunks') return 'gathering';
    if (c === 'textiles') return def.id === 'leather' ? 'harvest' : 'gathering';
    return 'crafting';
  }

  function categoryForLoss(def) {
    var c = categoryOf(def);
    if (c === 'meals' || c === 'rawFood') return 'eating';
    if (c === 'medicine') return 'other';
    if (c === 'resources' || c === 'stone' || c === 'manufactured') return 'construction';
    return 'other';
  }

  function todayBook() {
    var st = Economy.state;
    var day = dayNow();
    if (!st.today || st.today.day !== day) {
      if (st.today) {
        st.days.push(st.today);
        if (st.days.length > LEDGER_DAYS) st.days.splice(0, st.days.length - LEDGER_DAYS);
      }
      st.today = newBook(day);
    }
    return st.today;
  }

  function newBook(day) {
    var b = { day: day, income: {}, expense: {}, produced: 0, consumed: 0, wealth: 0, silver: 0, goods: {} };
    for (var i = 0; i < CATEGORIES.length; i++) { b.income[CATEGORIES[i]] = 0; b.expense[CATEGORIES[i]] = 0; }
    return b;
  }

  /* The one entry point for anything that knows what it did. Amount is
     signed silver: positive came in, negative went out. */
  Economy.book = function (category, amount, note) {
    if (!amount) return 0;
    if (CATEGORIES.indexOf(category) < 0) category = 'other';
    var b = todayBook();
    var st = Economy.state;
    if (amount > 0) { b.income[category] += amount; st.totals.earned += amount; }
    else { b.expense[category] += -amount; st.totals.spent += -amount; }
    if (note && game() && game().debug) console.log('[economy] ' + category + ' ' + U.signed(amount, 0) + ' ' + note);
    return amount;
  };

  function bookGoods(defId, units, value, category) {
    var b = todayBook();
    var row = b.goods[defId];
    if (!row) row = b.goods[defId] = { units: 0, value: 0 };
    row.units += units;
    row.value += value;
    Economy.book(category, value);
    var st = Economy.state;
    if (value > 0) { b.produced += value; st.totals.produced += value; }
    else { b.consumed += -value; st.totals.consumed += -value; }
  }

  /* Compare the colony's stores with the last look and write down the
     difference. Silver is skipped here: money moving is a trade or a
     contract, and both of those book themselves. */
  function reconcileStocks(map) {
    var st = Economy.state;
    var now = sampleColony(map);
    var prev = st.stock;
    st.stock = now;
    if (!prev) return;

    var seen = {}, id;
    for (id in now) {
      seen[id] = true;
      if (id === 'silver') continue;
      var delta = now[id] - (prev[id] || 0);
      if (!delta) continue;
      var def = thingDef(id);
      if (!def) continue;
      var value = baseValue(def) * delta;
      bookGoods(id, delta, value, delta > 0 ? categoryForGain(def) : categoryForLoss(def));
    }
    for (id in prev) {
      if (seen[id] || id === 'silver') continue;
      var d2 = thingDef(id);
      if (!d2) continue;
      bookGoods(id, -prev[id], -baseValue(d2) * prev[id], categoryForLoss(d2));
    }
  }

  /* The readout. Everything the bookkeeping panel needs in one object,
     so the UI never has to add anything up itself. */
  Economy.report = function (days) {
    var st = Economy.state;
    days = days || 7;
    var books = st.days.slice(-days);
    if (st.today) books = books.concat([st.today]);

    var byCategory = {}, i, c;
    for (i = 0; i < CATEGORIES.length; i++) byCategory[CATEGORIES[i]] = { income: 0, expense: 0 };

    var produced = 0, consumed = 0;
    for (i = 0; i < books.length; i++) {
      for (c = 0; c < CATEGORIES.length; c++) {
        var k = CATEGORIES[c];
        byCategory[k].income += books[i].income[k] || 0;
        byCategory[k].expense += books[i].expense[k] || 0;
      }
      produced += books[i].produced;
      consumed += books[i].consumed;
    }

    var span = Math.max(1, books.length);
    var rows = [];
    for (c = 0; c < CATEGORIES.length; c++) {
      var key = CATEGORIES[c], row = byCategory[key];
      if (!row.income && !row.expense) continue;
      rows.push({
        category: key,
        income: Math.round(row.income),
        expense: Math.round(row.expense),
        net: Math.round(row.income - row.expense),
        perDay: Math.round((row.income - row.expense) / span)
      });
    }
    rows.sort(function (a, b) { return Math.abs(b.net) - Math.abs(a.net); });

    var g = game();
    return {
      days: span,
      rows: rows,
      producedPerDay: Math.round(produced / span),
      consumedPerDay: Math.round(consumed / span),
      netPerDay: Math.round((produced - consumed) / span),
      wealth: g ? g.wealth : 0,
      silver: Economy.silver(g && g.map),
      totals: {
        earned: Math.round(st.totals.earned), spent: Math.round(st.totals.spent),
        produced: Math.round(st.totals.produced), consumed: Math.round(st.totals.consumed)
      },
      series: books.map(function (b) {
        return { day: b.day, produced: Math.round(b.produced), consumed: Math.round(b.consumed),
          net: Math.round(b.produced - b.consumed), wealth: Math.round(b.wealth), silver: b.silver };
      })
    };
  };

  /* What the colony made and used up, good by good, over the window. */
  Economy.goodsFlow = function (days) {
    var st = Economy.state;
    var books = st.days.slice(-(days || 7));
    if (st.today) books = books.concat([st.today]);
    var totals = {};
    for (var i = 0; i < books.length; i++) {
      for (var id in books[i].goods) {
        if (!totals[id]) totals[id] = { defId: id, units: 0, value: 0 };
        totals[id].units += books[i].goods[id].units;
        totals[id].value += books[i].goods[id].value;
      }
    }
    var out = [];
    for (var k in totals) {
      var d = thingDef(k);
      out.push({
        defId: k, label: d ? d.label : k,
        units: Math.round(totals[k].units),
        value: Math.round(totals[k].value),
        perDay: Math.round(totals[k].units / Math.max(1, books.length) * 10) / 10
      });
    }
    out.sort(function (a, b) { return Math.abs(b.value) - Math.abs(a.value); });
    return out;
  };

  /* ============================================================
     SILVER

     A stockpile of silver is wealth, and wealth calls raids. This is
     the number that says how much of the next raid you are paying for
     by keeping cash rather than spending it.
     ============================================================ */

  Economy.wealthFromSilver = function (map) {
    var def = thingDef('silver');
    return Economy.silver(map) * ((def && def.marketValue) || 1);
  };

  /* raid points = (wealth / 2200 + day x 2.6) x difficulty, so the cash
     pile's share of the threat is its share of wealth over that divisor. */
  Economy.raidPointsFromSilver = function (g) {
    g = g || game();
    if (!g) return 0;
    var scale = (g.difficulty && g.difficulty.threatScale) || 1;
    return Math.round(Economy.wealthFromSilver(g.map) / 2200 * scale * 10) / 10;
  };

  Economy.cashSummary = function (g) {
    g = g || game();
    var map = g && g.map;
    var silver = Economy.silver(map);
    var wealth = g ? (g.wealth || 0) : 0;
    return {
      silver: silver,
      share: wealth > 0 ? Math.round(Economy.wealthFromSilver(map) / wealth * 100) : 0,
      raidPoints: Economy.raidPointsFromSilver(g),
      advice: silver > 2500
        ? 'A pile this size is buying raids. Spend it or spread it into goods you need.'
        : 'Cash on hand is not what is calling the next raid.'
    };
  };

  /* ============================================================
     PRICE HISTORY

     One sample a day per traded good in the world market, kept as a
     flat array so the UI can graph it without reshaping anything.
     ============================================================ */

  function sampleHistory(day) {
    var st = Economy.state;
    if (!st.history || !Object.keys(st.history).length) st.historyDay0 = day;
    var D = root.Defs;
    var items = (D && D.items) ? D.items() : [];
    for (var i = 0; i < items.length; i++) {
      var def = items[i];
      if (!isGood(def)) continue;
      var arr = st.history[def.id];
      if (!arr) arr = st.history[def.id] = [];
      arr.push(Math.round(Economy.marketPrice(def, {}) * 100) / 100);
      if (arr.length > HISTORY_DAYS) arr.splice(0, arr.length - HISTORY_DAYS);
    }
  }

  Economy.history = function (defId) {
    var def = thingDef(defId);
    var st = Economy.state;
    var arr = def ? st.history[def.id] : null;
    if (!arr || !arr.length) return [];
    /* The last sample was taken on lastDay and there is one a day, so
       the first retained one is that many days back. Nothing has to be
       written down for a window that slides. */
    var day0 = st.lastDay - (arr.length - 1);
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push({ day: day0 + i, price: arr[i] });
    return out;
  };

  /* Which way a price has been going, for an arrow next to a number. */
  Economy.trend = function (defId, days) {
    var h = Economy.history(defId);
    if (h.length < 2) return 0;
    var back = Math.max(0, h.length - 1 - (days || 5));
    var then = h[back].price, now = h[h.length - 1].price;
    return then > 0 ? Math.round((now / then - 1) * 1000) / 1000 : 0;
  };

  /* ============================================================
     WATCHING THE COUNTERS

     Nobody tells us a deal happened. We do not need telling: a
     settlement's stock list and a visitor's stock list are plain
     arrays that trade.js writes through, so the difference between one
     economy tick and the next is exactly what changed hands.
     ============================================================ */

  function stockMap(list) {
    var out = {};
    for (var i = 0; list && i < list.length; i++) {
      var e = list[i];
      if (!e || !e.defId) continue;
      out[e.defId] = (out[e.defId] || 0) + (e.count || 0);
    }
    return out;
  }

  /* A settlement and a visitor can carry the same numeric id, so the
     key says which kind of counter it is as well as which one. */
  function partnerKey(partner) {
    if (!partner || partner.id === undefined) return null;
    if (partner.pawnIds) return 'v' + partner.id;
    if (partner.tile !== undefined) return 's' + partner.id;
    return null;
  }

  function watchPartner(key, list, opts) {
    if (!key) return 0;
    var st = Economy.state;
    var now = stockMap(list);
    var prev = st.partners[key];
    st.partners[key] = now;
    if (!prev) return;

    var id, moved = 0;
    for (id in now) {
      var delta = now[id] - (prev[id] || 0);
      if (delta) { Economy.noteFlow(id, delta, opts); moved += Math.abs(delta) * baseValue(id); }
    }
    for (id in prev) {
      if (now[id] !== undefined) continue;
      Economy.noteFlow(id, -prev[id], opts);
      moved += prev[id] * baseValue(id);
    }
    return moved;
  }

  function watchCounters(g) {
    var W = sys('World');
    var T = sys('Trade');
    var i;

    if (W && W.liveSettlements) {
      var list = W.liveSettlements();
      for (i = 0; i < list.length; i++) {
        watchPartner(partnerKey(list[i]), list[i].stock, { settlement: list[i] });
      }
    }
    if (T && T.visitors) {
      for (i = 0; i < T.visitors.length; i++) {
        var v = T.visitors[i];
        watchPartner(partnerKey(v), v.stock, { faction: v.factionId });
      }
    }
  }

  /* Silver moving in or out of the colony is money, and money always has
     a reason. Contracts declare theirs; everything else is inferred from
     whether there was anybody to trade with. Silver that appears with no
     counter in sight was dug out of a seam or taken off a raider. */
  function counterPresent(g) {
    var T = sys('Trade');
    if (T && T.visitors) {
      for (var i = 0; i < T.visitors.length; i++) {
        if (!T.visitors[i].angered) return true;
      }
    }
    var C = sys('Caravans');
    var W = sys('World');
    if (C && C.all && W && W.settlementAt) {
      for (var c = 0; c < C.all.length; c++) {
        var car = C.all[c];
        if (car && !car.gone && W.settlementAt(car.tile)) return true;
      }
    }
    return false;
  }

  function reconcileSilver(g) {
    var st = Economy.state;
    var now = Economy.silver(g.map);
    var prev = st.silverSeen;
    st.silverSeen = now;
    if (prev === undefined) return;
    var delta = now - prev - (st.silverBooked || 0);
    st.silverBooked = 0;
    if (!delta) return;
    if (counterPresent(g)) Economy.book('trade', delta);
    else Economy.book(delta > 0 ? 'gathering' : 'other', delta);
  }

  /* Anything inside this file that moves silver on purpose says so, so
     the sampler above does not book it a second time. */
  function noteOwnSilver(delta) {
    var st = Economy.state;
    st.silverBooked = (st.silverBooked || 0) + delta;
  }

  /* ============================================================
     CONTRACTS

     A faction's standing offer with a deadline. Accepting puts it on a
     list with a countdown; finishing it pays and raises goodwill;
     missing it costs both.
     ============================================================ */

  var KINDS = ['deliver', 'shelter', 'hunt', 'defend'];

  function tradeableFactions() {
    var F = sys('Factions');
    if (!F || !F.tradeable) return [];
    return F.tradeable();
  }

  function settlementOf(contract) {
    var W = sys('World');
    if (!W || !W.settlementById || !contract.settlementId) return null;
    return W.settlementById(contract.settlementId);
  }

  /* What a faction would actually ask for: something it wants and the
     colony could plausibly supply. */
  function deliveryAsk(faction, settlement, map) {
    var wants = settlement ? Economy.wants(settlement) : [];
    if (!wants.length) {
      var table = TECH_WANT[faction ? faction.techLevel : 'industrial'] || {};
      wants = rankWeights(table);
    }
    var pool = [];
    for (var i = 0; i < wants.length; i++) {
      var def = thingDef(wants[i].defId);
      if (!def || !isGood(def)) continue;
      pool.push({ def: def, strength: wants[i].strength });
    }
    if (!pool.length) return null;

    var pick = U.pickWeighted(pool, function (p) {
      /* Weighted toward what the colony already has some of: an offer
         you cannot possibly fill is not an offer, it is noise. */
      var held = Economy.countOf(map, p.def.id);
      return p.strength * (1 + Math.min(2, held / 50));
    });
    if (!pick) return null;

    var unit = baseValue(pick.def);
    /* Roughly four hundred to twelve hundred silver of goods, rounded
       to something a player can read off a stockpile. */
    var target = U.randRange(400, 1200) / Math.max(1, unit);
    var count = Math.max(1, Math.round(target / 10) * 10);
    if (unit >= 40) count = U.clamp(Math.round(target), 1, 8);
    return { defId: pick.def.id, label: pick.def.label, count: count };
  }

  function contractLabel(c) {
    if (c.kind === 'deliver') return 'Deliver ' + c.count + ' ' + c.label;
    if (c.kind === 'shelter') return 'Shelter a refugee';
    if (c.kind === 'hunt') return 'Cull ' + c.count + ' ' + (c.killLabel || 'beasts');
    return 'Hold off a raid';
  }

  function makeContract(g, kind, faction, settlement) {
    var map = g && g.map;
    var days, c = {
      id: U.nextId(), kind: kind,
      factionId: faction.id, factionName: faction.name,
      settlementId: settlement ? settlement.id : null,
      settlementName: settlement ? settlement.name : null,
      defId: null, label: '', count: 0, delivered: 0,
      killKindId: null, killLabel: null, kills: 0,
      guestPawnId: 0, guestName: null,
      offeredTick: g.tick, expiresTick: g.tick + Math.round(OFFER_LIFE_DAYS * TICKS_PER_DAY),
      acceptedTick: 0, deadlineTick: 0, days: 0,
      rewardSilver: 0, rewardGoodwill: 0, penaltyGoodwill: 0,
      state: 'offered', resultTick: 0, note: ''
    };

    if (kind === 'deliver') {
      var ask = deliveryAsk(faction, settlement, map);
      if (!ask) return null;
      c.defId = ask.defId; c.label = ask.label; c.count = ask.count;
      days = U.randInt(8, 16);
      var worth = baseValue(ask.defId) * ask.count;
      c.rewardSilver = Math.round(worth * U.randRange(1.35, 1.75));
      c.rewardGoodwill = U.randInt(6, 14);
      c.penaltyGoodwill = -U.randInt(5, 12);
      c.note = faction.name + ' will pay over the odds, and remember it.';
    } else if (kind === 'shelter') {
      days = U.randInt(12, 20);
      c.rewardSilver = U.randInt(500, 1100);
      c.rewardGoodwill = U.randInt(10, 18);
      c.penaltyGoodwill = -U.randInt(10, 20);
      c.note = 'They have nowhere else to send them.';
    } else if (kind === 'hunt') {
      var kinds = ['wolf', 'bear', 'boomrat'].filter(function (k) { return !!defMaybe('pawnKind', k); });
      if (!kinds.length) return null;
      var kid = U.pick(kinds);
      c.killKindId = kid;
      c.killLabel = defMaybe('pawnKind', kid).label || kid;
      c.count = U.randInt(3, 6);
      days = U.randInt(6, 12);
      c.rewardSilver = c.count * U.randInt(90, 160);
      c.rewardGoodwill = U.randInt(5, 11);
      c.penaltyGoodwill = -U.randInt(3, 8);
      c.note = 'The pack has been taking people off the road.';
    } else {
      days = U.randInt(4, 9);
      c.rewardSilver = U.randInt(700, 1600);
      c.rewardGoodwill = U.randInt(12, 20);
      c.penaltyGoodwill = -U.randInt(8, 16);
      c.note = 'Their militia cannot be in two places at once.';
    }

    c.days = days;
    c.label = c.label || '';
    c.title = contractLabel(c);
    return c;
  }

  /* The generator the storyteller can call. Returns the offer, or null
     if the world is not in a state to make one. */
  Economy.generateContract = function (g, opts) {
    g = gameArg(g, null);
    opts = opts || {};
    if (!g || !g.map) return null;

    var pool = tradeableFactions();
    if (!pool.length) return null;
    var faction = opts.factionId ? factionOf(opts.factionId)
      : U.pickWeighted(pool, function (f) { return 1 + U.clamp(f.goodwill, -100, 100) / 50; });
    if (!faction || faction.hostile) return null;

    var F = sys('Factions');
    var settlements = (F && F.settlementsOf) ? F.settlementsOf(faction.id) : [];
    var settlement = settlements.length ? U.pick(settlements) : null;

    var allowed = KINDS.slice();
    if (!opts.allowRaid && g.day && g.day() < 8) U.remove(allowed, 'defend');
    if (g.map.colonists().length >= 12) U.remove(allowed, 'shelter');
    var kind = opts.kind && allowed.indexOf(opts.kind) >= 0 ? opts.kind : U.pick(allowed);

    var c = makeContract(g, kind, faction, settlement);
    if (!c) return null;

    var st = Economy.state;
    st.offers.push(c);
    while (st.offers.length > OFFER_MAX) st.offers.shift();
    if (opts.quiet !== true) {
      letter('Offer from ' + faction.name, contractDescription(c), { kind: 'neutral' });
    }
    return c;
  };
  Economy.generate = Economy.generateContract;

  function contractDescription(c) {
    var pay = c.rewardSilver + ' silver and ' + U.signed(c.rewardGoodwill, 0) + ' goodwill';
    var where = c.settlementName ? ' at ' + c.settlementName : '';
    if (c.kind === 'deliver') {
      return c.factionName + ' needs ' + c.count + ' ' + c.label + where + ' within ' + c.days +
        ' days. Walk a caravan there, or hand it to one of their traders when they call. ' +
        'They will pay ' + pay + '. Missing the date costs ' + U.signed(c.penaltyGoodwill, 0) + '.';
    }
    if (c.kind === 'shelter') {
      return c.factionName + ' asks you to shelter someone for ' + c.days + ' days. They will be ' +
        'one more mouth and one more pair of hands. Keep them alive and they leave paid for: ' +
        pay + '. Lose them and it costs ' + U.signed(c.penaltyGoodwill, 0) + '.';
    }
    if (c.kind === 'hunt') {
      return c.factionName + ' wants ' + c.count + ' ' + c.killLabel + ' dead within ' + c.days +
        ' days. ' + c.note + ' Worth ' + pay + '.';
    }
    return c.factionName + ' expects a raid on ' + (c.settlementName || 'one of their towns') +
      ' and wants it drawn onto you instead, for ' + c.days + ' days. ' + c.note +
      ' Survive it and they pay ' + pay + '.';
  }
  Economy.describe = contractDescription;

  Economy.offers = function () {
    var now = tickNow();
    return Economy.state.offers.filter(function (o) {
      return o.state === 'offered' && o.expiresTick > now;
    });
  };

  Economy.contracts = function () {
    return Economy.state.contracts.filter(function (c) { return c.state === 'active'; });
  };

  Economy.allContracts = function () { return Economy.state.contracts.slice(); };

  Economy.contract = function (id) {
    var st = Economy.state, i;
    for (i = 0; i < st.contracts.length; i++) if (st.contracts[i].id === id) return st.contracts[i];
    for (i = 0; i < st.offers.length; i++) if (st.offers[i].id === id) return st.offers[i];
    return null;
  };

  Economy.accept = function (id) {
    var st = Economy.state;
    var c = null;
    for (var i = 0; i < st.offers.length; i++) {
      if (st.offers[i].id === id) { c = st.offers.splice(i, 1)[0]; break; }
    }
    if (!c || c.state !== 'offered') return null;

    var g = game();
    c.state = 'active';
    c.acceptedTick = g ? g.tick : 0;
    c.deadlineTick = c.acceptedTick + Math.round(c.days * TICKS_PER_DAY);
    st.contracts.push(c);

    if (c.kind === 'shelter') spawnGuest(g, c);
    if (c.kind === 'hunt') releasePack(g, c);
    if (c.kind === 'defend') callRaid(g, c);

    msg('Accepted: ' + c.title + ' for ' + c.factionName + '.', { type: 'info' });
    return c;
  };

  Economy.abandon = function (id) {
    var c = Economy.contract(id);
    if (!c || c.state !== 'active') return false;
    finish(c, false, 'abandoned');
    return true;
  };

  /* ---------- what accepting sets in motion ---------- */

  function edgeCell(map) {
    var MG = sys('MapGen');
    if (MG && MG.edgeSpawnCells) {
      var side = U.pick(['n', 'e', 's', 'w']);
      var cells = MG.edgeSpawnCells(map, side) || [];
      for (var i = 0; i < cells.length; i++) {
        var c = cells[U.randInt(0, cells.length - 1)];
        if (c && map.passable(c.x, c.y)) return c;
      }
    }
    for (var t = 0; t < 200; t++) {
      var x = U.randInt(1, map.w - 2), y = U.randInt(1, map.h - 2);
      if (map.passable(x, y)) return { x: x, y: y };
    }
    return null;
  }

  function spawnGuest(g, c) {
    var map = g && g.map;
    var MG = sys('MapGen');
    if (!map || !MG || !MG.makePawn) return;
    var cell = edgeCell(map);
    if (!cell) return;

    var pawn = MG.makePawn('colonist', 'player', { x: cell.x, y: cell.y, map: map });
    if (!pawn) return;
    pawn.faction = 'player';
    if (!map.addPawn(pawn, cell.x, cell.y)) return;
    pawn.fx = pawn.x; pawn.fy = pawn.y;
    pawn.economyGuestOf = c.factionId;

    c.guestPawnId = pawn.id;
    c.guestName = pawn.fullName ? pawn.fullName() : (pawn.name && pawn.name.first) || 'the refugee';
    letter('A refugee arrives', c.guestName + ' walked in under ' + c.factionName +
      "'s word. They stay for " + c.days + ' days.', { kind: 'neutral', x: pawn.x, y: pawn.y });
  }

  function releasePack(g, c) {
    var A = sys('Animals');
    if (!A || !A.manhunterPack || !g || !g.map) return;
    A.manhunterPack(g.map, c.killKindId, Math.max(2, c.count - 1));
  }

  function callRaid(g, c) {
    var S = sys('Storyteller');
    if (!S) return;
    var points = S.threatPoints ? S.threatPoints(g) : 120;
    if (S.schedule) S.schedule('raidEnemy', U.randInt(6000, 30000), { points: points, drop: false });
  }

  /* ---------- delivering ---------- */

  /* Take goods out of the colony's stores. Stockpiled stacks first,
     because that is where a caravan would load from. */
  function takeFromColony(map, defId, count) {
    if (!map || !map.byDef) return 0;
    var Z = sys('Zones');
    var list = map.byDef(defId).filter(function (t) { return t && t.spawned; });
    list.sort(function (a, b) {
      var az = (Z && Z.zoneAt && Z.zoneAt(map, a.x, a.y)) ? 0 : 1;
      var bz = (Z && Z.zoneAt && Z.zoneAt(map, b.x, b.y)) ? 0 : 1;
      return az - bz;
    });

    var left = count;
    for (var i = 0; i < list.length && left > 0; i++) {
      var t = list[i];
      var have = t.stack || 1;
      var n = Math.min(left, have);
      left -= n;
      if (n >= have) map.despawnThing(t);
      else t.stack = have - n;
    }
    return count - left;
  }

  function dropCell(map) {
    if (!map) return null;
    var zones = map.zones || [];
    for (var i = 0; i < zones.length; i++) {
      if (zones[i].kind !== 'stockpile') continue;
      var iter = zones[i].cells.values();
      var step = iter.next();
      while (!step.done) {
        var idx = step.value;
        var x = map.xOf(idx), y = map.yOf(idx);
        if (map.passable(x, y)) return { x: x, y: y };
        step = iter.next();
      }
    }
    var list = map.colonists ? map.colonists() : [];
    if (list.length) return { x: list[0].x, y: list[0].y };
    return { x: map.w >> 1, y: map.h >> 1 };
  }

  /* Hand goods over by hand, from the UI or from another system. */
  Economy.deliver = function (id, count) {
    var c = Economy.contract(id);
    var g = game();
    if (!c || c.state !== 'active' || c.kind !== 'deliver' || !g) return 0;
    var want = Math.min(count === undefined ? c.count - c.delivered : count, c.count - c.delivered);
    if (want <= 0) return 0;
    var took = takeFromColony(g.map, c.defId, want);
    c.delivered += took;
    if (took) {
      Economy.book('contracts', -baseValue(c.defId) * took);
      Economy.noteFlow(c.defId, took, { faction: c.factionId, settlement: settlementOf(c) });
    }
    return took;
  };

  /* The two ways a delivery happens without the player clicking: a
     caravan of yours standing on their tile, or one of their traders
     standing in your colony. */
  function autoDeliver(g, c) {
    if (c.kind !== 'deliver' || c.delivered >= c.count) return;
    var want = c.count - c.delivered;
    var C = sys('Caravans');
    var settlement = settlementOf(c);

    if (C && C.all && settlement) {
      for (var i = 0; i < C.all.length; i++) {
        var car = C.all[i];
        if (!car || car.gone || car.tile !== settlement.tile) continue;
        if (car.factionId && car.factionId !== 'player') continue;
        var have = C.countOf ? C.countOf(car, c.defId) : 0;
        if (have <= 0) continue;
        var n = Math.min(want, have);
        if (C.removeItem) C.removeItem(car, c.defId, n);
        c.delivered += n;
        want -= n;
        Economy.noteFlow(c.defId, n, { faction: c.factionId, settlement: settlement });
        Economy.book('contracts', -baseValue(c.defId) * n);
        if (want <= 0) return;
      }
    }

    var T = sys('Trade');
    if (T && T.visitors) {
      for (var v = 0; v < T.visitors.length; v++) {
        var visit = T.visitors[v];
        if (visit.factionId !== c.factionId || visit.angered || visit.phase === 'leaving') continue;
        var took = takeFromColony(g.map, c.defId, want);
        if (!took) return;
        c.delivered += took;
        want -= took;
        Economy.noteFlow(c.defId, took, { faction: c.factionId });
        Economy.book('contracts', -baseValue(c.defId) * took);
        msg('Handed ' + took + ' ' + c.label + ' to ' + visit.factionName + "'s trader.", { type: 'good' });
        if (want <= 0) return;
      }
    }
  }

  /* ---------- counting kills ---------- */

  /* A corpse is the only durable record of a kill anyone leaves behind,
     and it carries the kind and the faction that died. Counted once,
     by id, and the id list is pruned to the corpses still lying there. */
  function countKills(g) {
    var map = g && g.map;
    if (!map || !map.byDef) return;
    var active = Economy.contracts().filter(function (c) { return c.kind === 'hunt'; });
    var corpses = map.byDef('corpse');
    var st = Economy.state;
    var counted = st.countedCorpses;
    var keep = [];

    for (var i = 0; i < corpses.length; i++) {
      var t = corpses[i];
      if (!t || !t.spawned || !t.corpse) continue;
      keep.push(t.id);
      if (counted.indexOf(t.id) >= 0) continue;
      counted.push(t.id);
      for (var c = 0; c < active.length; c++) {
        var contract = active[c];
        if (t.corpse.kindId !== contract.killKindId) continue;
        if (t.spawnTick !== undefined && t.spawnTick < contract.acceptedTick) continue;
        contract.kills++;
      }
    }
    /* Corpses rot, get butchered and get buried. Dropping the ids of the
       ones that are gone keeps this list the size of the graveyard
       rather than the size of the war. */
    st.countedCorpses = counted.filter(function (id) { return keep.indexOf(id) >= 0; });
  }

  /* ---------- finishing ---------- */

  function payOut(c) {
    var g = game();
    if (!g || !g.map || !c.rewardSilver) return;
    var at = dropCell(g.map);
    if (!at) return;
    var made = g.map.addItem('silver', at.x, at.y, c.rewardSilver, { faction: 'player' });
    var paid = 0;
    for (var i = 0; i < made.length; i++) paid += made[i].stack;
    noteOwnSilver(paid);
    Economy.book('contracts', paid);
  }

  function finish(c, ok, how) {
    var F = sys('Factions');
    c.state = ok ? 'done' : (how || 'failed');
    c.resultTick = tickNow();

    if (ok) {
      payOut(c);
      if (F && F.adjustGoodwill) F.adjustGoodwill(c.factionId, c.rewardGoodwill, 'contract honoured');
      letter('Contract honoured', c.factionName + ' paid ' + c.rewardSilver + ' silver for ' +
        c.title.toLowerCase() + '. ' + (c.rewardGoodwill ? 'They will remember it.' : ''),
        { kind: 'good' });
    } else {
      if (F && F.adjustGoodwill) F.adjustGoodwill(c.factionId, c.penaltyGoodwill, 'contract broken');
      letter(how === 'abandoned' ? 'Contract dropped' : 'Contract failed',
        c.factionName + ' was expecting ' + c.title.toLowerCase() + '. Nothing came.',
        { kind: 'threat' });
    }

    /* A sheltered refugee who was kept alive to the end goes home, so
       the weeks of feeding them were a cost and not a free colonist.
       One whose contract fell through has nowhere to be sent and stays
       where they are, which is its own kind of answer. */
    if (c.kind === 'shelter' && c.guestPawnId) releaseGuest(c, ok);
  }

  function findPawn(map, id) {
    if (!map || !id) return null;
    for (var i = 0; i < map.pawns.length; i++) if (map.pawns[i].id === id) return map.pawns[i];
    return null;
  }

  function releaseGuest(c, ok) {
    var g = game();
    var pawn = findPawn(g && g.map, c.guestPawnId);
    if (!ok || !pawn || pawn.dead) return;
    /* A refugee who is now the only person standing does not walk out
       into the snow to end the colony on a technicality. */
    var alive = g.map.colonists().filter(function (p) { return !p.dead; });
    if (alive.length <= 1) {
      msg(c.guestName + ' stayed: there is nobody else left here.', { type: 'info' });
      return;
    }
    if (g.map.removePawn) g.map.removePawn(pawn);
    msg(c.guestName + ' left with ' + c.factionName + "'s people.", { type: 'info' });
  }

  function contractDone(g, c) {
    if (c.kind === 'deliver') return c.delivered >= c.count;
    if (c.kind === 'hunt') return c.kills >= c.count;
    if (c.kind === 'shelter') {
      var pawn = findPawn(g.map, c.guestPawnId);
      return g.tick >= c.deadlineTick && !!pawn && !pawn.dead;
    }
    return g.tick >= c.deadlineTick && g.map.colonists().some(function (p) { return !p.dead; });
  }

  function contractLost(g, c) {
    if (c.kind === 'shelter') {
      var pawn = findPawn(g.map, c.guestPawnId);
      if (c.guestPawnId && (!pawn || pawn.dead)) return true;
    }
    return g.tick >= c.deadlineTick;
  }

  Economy.tickContracts = function (a, b) {
    var g = gameArg(a, b);
    if (!g || !g.map) return;
    syncGame(g);

    var st = Economy.state;
    var now = g.tick, i;

    for (i = st.offers.length - 1; i >= 0; i--) {
      if (st.offers[i].state === 'offered' && st.offers[i].expiresTick <= now) st.offers.splice(i, 1);
    }

    countKills(g);

    for (i = 0; i < st.contracts.length; i++) {
      var c = st.contracts[i];
      if (c.state !== 'active') continue;
      autoDeliver(g, c);
      if (contractDone(g, c)) finish(c, true);
      else if (contractLost(g, c)) finish(c, false);
    }

    /* Finished business is worth keeping for the record, but not
       forever: the last two dozen is a history, the rest is a leak. */
    if (st.contracts.length > 24) {
      var live = st.contracts.filter(function (x) { return x.state === 'active'; });
      var old = st.contracts.filter(function (x) { return x.state !== 'active' ; });
      st.contracts = live.concat(old.slice(-16));
    }

    if (!st.nextOfferTick) {
      st.nextOfferTick = now + Math.round(CONTRACT_INTERVAL_DAYS * TICKS_PER_DAY);
    } else if (now >= st.nextOfferTick) {
      st.nextOfferTick = now + Math.round(U.randRange(CONTRACT_INTERVAL_DAYS, CONTRACT_INTERVAL_DAYS * 2.5) * TICKS_PER_DAY);
      if (Economy.offers().length < OFFER_MAX && (!g.day || g.day() >= 3)) Economy.generateContract(g, {});
    }
  };

  /* ============================================================
     STANDING ORDERS

     A route you have already decided on should not need the same dialog
     every time. An order says what to buy or sell, how much, and the
     worst price you will take; a visiting trader fulfils it while they
     stand there.
     ============================================================ */

  Economy.addOrder = function (opts) {
    opts = opts || {};
    var def = thingDef(opts.defId);
    if (!def) return null;
    var st = Economy.state;
    var order = {
      id: st.nextOrderId++,
      kind: opts.kind === 'buy' ? 'buy' : 'sell',
      defId: def.id, label: def.label,
      count: Math.max(1, opts.count | 0 || 1),
      filled: 0,
      limitPrice: opts.limitPrice > 0 ? opts.limitPrice : 0,
      keepAtLeast: Math.max(0, opts.keepAtLeast | 0),
      factionId: opts.factionId || null,
      repeat: opts.repeat !== false,
      active: true
    };
    st.orders.push(order);
    return order;
  };

  Economy.orders = function () { return Economy.state.orders.slice(); };

  Economy.removeOrder = function (id) {
    var st = Economy.state;
    for (var i = 0; i < st.orders.length; i++) {
      if (st.orders[i].id === id) { st.orders.splice(i, 1); return true; }
    }
    return false;
  };

  Economy.setOrderActive = function (id, on) {
    var st = Economy.state;
    for (var i = 0; i < st.orders.length; i++) {
      if (st.orders[i].id === id) { st.orders[i].active = !!on; return st.orders[i]; }
    }
    return null;
  };

  function orderWants(order, deal, map) {
    if (!order.active) return 0;
    var left = order.count - order.filled;
    if (left <= 0) return 0;

    var row = null, list = order.kind === 'buy' ? deal.theirStock : deal.ourGoods;
    for (var i = 0; i < list.length; i++) if (list[i].defId === order.defId) { row = list[i]; break; }
    if (!row) return 0;

    if (order.limitPrice > 0) {
      if (order.kind === 'buy' && row.price > order.limitPrice) return 0;
      if (order.kind === 'sell' && row.price < order.limitPrice) return 0;
    }

    var n = Math.min(left, row.count);
    if (order.kind === 'sell' && order.keepAtLeast > 0) {
      n = Math.min(n, Math.max(0, Economy.countOf(map, order.defId) - order.keepAtLeast));
    }
    return Math.max(0, n);
  }

  /* Fill what we can at whichever counter is standing in the colony.
     Everything here goes through trade.js's own deal: it owns moving
     goods, and an order is only a decision made in advance. */
  Economy.fillOrders = function (g) {
    g = gameArg(g, null);
    var T = sys('Trade');
    var st = Economy.state;
    if (!g || !g.map || !T || !T.open || !st.orders.length) return 0;
    if (!T.visitors || !T.visitors.length) return 0;
    /* Opening a deal floods the map for reachable storage, so it is not
       something to do on the off-chance every slow tick. */
    var pending = false;
    for (var q = 0; q < st.orders.length && !pending; q++) {
      pending = st.orders[q].active && st.orders[q].filled < st.orders[q].count;
    }
    if (!pending) return 0;

    var filled = 0;
    for (var v = 0; v < T.visitors.length; v++) {
      var visit = T.visitors[v];
      if (visit.angered || visit.phase === 'leaving') continue;
      if (T.canOpen && !T.canOpen(visit).ok) continue;

      var deal = T.open(visit, { map: g.map });
      if (!deal) continue;
      var moved = false;

      for (var i = 0; i < st.orders.length; i++) {
        var order = st.orders[i];
        if (order.factionId && order.factionId !== visit.factionId) continue;
        var n = orderWants(order, deal, g.map);
        if (n <= 0) continue;
        var got = order.kind === 'buy' ? T.buy(deal, order.defId, n) : T.sell(deal, order.defId, n);
        if (got) { order.filled += Math.abs(got); moved = true; }
      }

      var basket = Economy.basketCopy(deal);
      if (moved && T.confirm && T.confirm(deal)) {
        filled++;
        /* install() may or may not have wrapped confirm; noteDeal is
           idempotent against the sampler either way, but calling it
           twice for one basket is not, so only do it ourselves when
           nobody wrapped it. */
        if (!Economy.installed) Economy.noteDeal(deal, basket);
        noteReputation(deal.negotiator);
        for (var j = st.orders.length - 1; j >= 0; j--) {
          var o = st.orders[j];
          if (o.filled < o.count) continue;
          if (o.repeat) o.filled = 0;
          else st.orders.splice(j, 1);
        }
        msg('Standing orders filled with ' + visit.factionName + "'s trader.", { type: 'good' });
      }
    }
    return filled;
  };

  /* A negotiator gets better at it. Small, capped, and saved on the pawn
     as a plain number so it survives a reload with everything else. */
  function noteReputation(pawn) {
    if (!pawn || pawn.dead) return;
    pawn.tradeReputation = U.clamp((pawn.tradeReputation || 0) + 0.04, 0, 1);
  }
  Economy.noteReputation = noteReputation;

  /* ============================================================
     THE SLOW CLOCK
     ============================================================ */

  /* A new colony in the same page session starts everything over, and
     nobody calls to say so. A different map object or a clock that ran
     backwards both mean the same thing. */
  function syncGame(g) {
    var st = Economy.state;
    /* Only a map we were already watching can be replaced. Attaching for
       the first time - a new game, or the tick after a load - adopts the
       map without touching anything, because a restored ledger arrives
       with no map on it and wiping it here would undo the load. */
    if (st.map && (g.map !== st.map || g.tick + 1000 < st.lastTick)) {
      Economy.reset();
      st = Economy.state;
    }
    st.map = g.map;
    st.lastTick = g.tick;
    return st;
  }

  Economy.tick = function (a, b) {
    var g = gameArg(a, b);
    if (!g || !g.map) return;

    var before = Economy.state.lastTick;
    var st = syncGame(g);
    var elapsed = Math.max(0, g.tick - before);
    if (!elapsed) elapsed = 500;

    var book = todayBook();
    book.wealth = g.wealth || 0;
    book.silver = Economy.silver(g.map);

    watchCounters(g);
    reconcileStocks(g.map);
    reconcileSilver(g);
    driftMarkets(elapsed / TICKS_PER_DAY);
    Economy.fillOrders(g);

    var day = dayNow();
    if (day !== st.lastDay) {
      st.lastDay = day;
      sampleHistory(day);
    }
  };

  /* ============================================================
     WIRING TRADE.JS TO THIS

     Opt-in, idempotent, and the only thing in this file that touches
     another module. trade.js keeps every one of its own behaviours -
     the spread, the stock roll, moving the goods - and simply asks this
     file what a thing is worth instead of reading the def.
     ============================================================ */

  Economy.installed = false;

  Economy.install = function () {
    var T = sys('Trade');
    if (!T || Economy.installed) return Economy.installed;

    var basePrice = T.priceOf;
    T.priceOf = function (defId, opts) {
      opts = opts || {};
      return Economy.priceOf(defId, {
        buying: opts.buying, quality: opts.quality, traderKind: opts.traderKind,
        faction: opts.faction, settlement: opts.settlement,
        socialSkill: opts.socialSkill, negotiator: opts.negotiator, goodwill: opts.goodwill
      });
    };
    T.priceOf.economyBase = basePrice;

    var baseConfirm = T.confirm;
    T.confirm = function (deal) {
      var basket = Economy.basketCopy(deal);
      var ok = baseConfirm.call(T, deal);
      if (ok) {
        Economy.noteDeal(deal, basket);
        noteReputation(deal.negotiator);
      }
      return ok;
    };
    T.confirm.economyBase = baseConfirm;

    Economy.installed = true;
    return true;
  };

  /* What a confirmed deal did to the market.

     `basket` is passed in rather than read off the deal because
     Trade.confirm empties it on the way out; a caller who has it should
     hand over a copy taken before confirming.

     Prices move either from here or from the sampler on the slow tick,
     never from both: the last thing this does is tell the sampler that
     the counter's new stock is the state it should compare against, so
     the same crate cannot push the same price twice.

     The silver is deliberately not booked here. reconcileSilver sees the
     colony's pile move on the next tick and books it once. */
  Economy.noteDeal = function (deal, basket) {
    if (!deal) return;
    basket = basket || deal.basket || {};
    var partner = deal.partner;
    var settlement = (partner && partner.tile !== undefined && !partner.pawnIds) ? partner : null;
    var opts = { faction: deal.factionId, settlement: settlement };

    for (var id in basket) {
      var n = basket[id];
      if (!n) continue;
      /* Positive in the basket is coming to you, so the market gave it
         up; negative is going to them, so the market took it in. */
      Economy.noteFlow(id, -n, opts);
    }

    var key = partnerKey(partner);
    if (key) {
      Economy.state.partners[key] = stockMap(partner.stock || partner.items);
    }
  };

  /* A copy of a deal's basket, for handing to noteDeal after confirming. */
  Economy.basketCopy = function (deal) {
    var out = {};
    for (var id in (deal && deal.basket) || {}) out[id] = deal.basket[id];
    return out;
  };

  /* ============================================================
     SAVE
     ============================================================ */

  Economy.save = function () {
    var st = Economy.state;
    var markets = {};
    for (var id in st.markets) {
      var m = st.markets[id], mult = {};
      for (var d in m.mult) mult[d] = Math.round(m.mult[d] * 1000) / 1000;
      if (Object.keys(mult).length) markets[id] = { id: m.id, factionId: m.factionId, mult: mult };
    }

    return {
      lastTick: st.lastTick,
      lastDay: st.lastDay,
      nextOfferTick: st.nextOfferTick,
      markets: markets,
      history: st.history,
      historyDay0: st.historyDay0,
      stock: st.stock,
      partners: st.partners,
      silverSeen: st.silverSeen === undefined ? null : st.silverSeen,
      days: st.days,
      today: st.today,
      offers: st.offers,
      contracts: st.contracts,
      orders: st.orders,
      nextOrderId: st.nextOrderId,
      countedCorpses: st.countedCorpses.slice(),
      totals: st.totals
    };
  };

  Economy.load = function (obj) {
    Economy.reset();
    if (!obj) return Economy;
    var st = Economy.state;

    st.lastTick = obj.lastTick || 0;
    st.lastDay = obj.lastDay === undefined ? -1 : obj.lastDay;
    st.nextOfferTick = obj.nextOfferTick || 0;
    st.historyDay0 = obj.historyDay0 || 0;
    st.history = obj.history || {};
    st.stock = obj.stock || null;
    st.partners = obj.partners || {};
    st.silverSeen = obj.silverSeen === null ? undefined : obj.silverSeen;
    st.days = obj.days || [];
    st.today = obj.today || null;
    st.nextOrderId = obj.nextOrderId || 1;
    st.countedCorpses = obj.countedCorpses || [];
    st.totals = obj.totals || { earned: 0, spent: 0, produced: 0, consumed: 0 };

    var markets = obj.markets || {};
    for (var id in markets) {
      var m = market(id);
      m.mult = markets[id].mult || {};
      m.factionId = markets[id].factionId || null;
    }

    /* A saved offer or contract is data, not a live object: rebuild it
       through the same shape the generator makes so a field added since
       the save still has a value. */
    (obj.offers || []).forEach(function (o) { st.offers.push(reviveContract(o)); });
    (obj.contracts || []).forEach(function (c) { st.contracts.push(reviveContract(c)); });
    (obj.orders || []).forEach(function (o) {
      if (!o || !thingDef(o.defId)) return;
      st.orders.push({
        id: o.id || st.nextOrderId++, kind: o.kind === 'buy' ? 'buy' : 'sell',
        defId: o.defId, label: o.label || thingDef(o.defId).label,
        count: o.count || 1, filled: o.filled || 0,
        limitPrice: o.limitPrice || 0, keepAtLeast: o.keepAtLeast || 0,
        factionId: o.factionId || null, repeat: o.repeat !== false,
        active: o.active !== false
      });
    });
    return Economy;
  };

  function reviveContract(o) {
    var c = {
      id: o.id || U.nextId(), kind: KINDS.indexOf(o.kind) >= 0 ? o.kind : 'deliver',
      factionId: o.factionId || null, factionName: o.factionName || 'strangers',
      settlementId: o.settlementId || null, settlementName: o.settlementName || null,
      defId: o.defId || null, label: o.label || '', count: o.count || 0,
      delivered: o.delivered || 0,
      killKindId: o.killKindId || null, killLabel: o.killLabel || null, kills: o.kills || 0,
      guestPawnId: o.guestPawnId || 0, guestName: o.guestName || null,
      offeredTick: o.offeredTick || 0, expiresTick: o.expiresTick || 0,
      acceptedTick: o.acceptedTick || 0, deadlineTick: o.deadlineTick || 0,
      days: o.days || 0,
      rewardSilver: o.rewardSilver || 0, rewardGoodwill: o.rewardGoodwill || 0,
      penaltyGoodwill: o.penaltyGoodwill || 0,
      state: o.state || 'offered', resultTick: o.resultTick || 0, note: o.note || ''
    };
    c.title = o.title || contractLabel(c);
    return c;
  }

  /* ============================================================
     READOUTS FOR THE UI

     Everything a panel needs, already rounded and already sorted, so no
     client file has to understand any of the above.
     ============================================================ */

  Economy.priceTable = function (opts) {
    opts = opts || {};
    var D = root.Defs;
    var items = (D && D.items) ? D.items() : [];
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var def = items[i];
      if (!isGood(def)) continue;
      var mult = Economy.multiplier(def, opts);
      out.push({
        defId: def.id, label: def.label,
        base: Math.round(baseValue(def) * 100) / 100,
        price: Economy.marketPrice(def, opts),
        buy: Economy.priceOf(def, { buying: true, faction: opts.faction, settlement: opts.settlement }),
        sell: Economy.priceOf(def, { buying: false, faction: opts.faction, settlement: opts.settlement }),
        multiplier: Math.round(mult * 100) / 100,
        trend: Economy.trend(def.id, opts.trendDays || 5),
        held: Economy.countOf(opts.map, def.id)
      });
    }
    out.sort(function (a, b) { return b.price - a.price; });
    return out;
  };

  Economy.contractRows = function () {
    var now = tickNow();
    return Economy.contracts().map(function (c) {
      var left = Math.max(0, c.deadlineTick - now);
      var progress = c.kind === 'deliver' ? c.delivered / Math.max(1, c.count)
        : (c.kind === 'hunt' ? c.kills / Math.max(1, c.count)
          : 1 - left / Math.max(1, c.days * TICKS_PER_DAY));
      return {
        id: c.id, title: c.title, factionName: c.factionName,
        daysLeft: Math.round(left / TICKS_PER_DAY * 10) / 10,
        progress: U.clamp01(progress),
        reward: c.rewardSilver, goodwill: c.rewardGoodwill,
        detail: contractDescription(c)
      };
    });
  };

  Economy.summary = function (g) {
    g = g || game();
    var report = Economy.report(7);
    return {
      netPerDay: report.netPerDay,
      producedPerDay: report.producedPerDay,
      consumedPerDay: report.consumedPerDay,
      silver: report.silver,
      wealth: report.wealth,
      contracts: Economy.contracts().length,
      offers: Economy.offers().length,
      orders: Economy.state.orders.length,
      bestIndustry: (Economy.industries(g && g.map)[0] || null)
    };
  };

  root.Economy = Economy;
})(this);
