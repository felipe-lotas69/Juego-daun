/* ============================================================
   production.js - bills at workbenches, and the one job that
   carries every one of them out.

   A bill is a standing order pinned to a building: "cook simple meals
   forever", "cut stone blocks until we have 200". It lives on the
   building (building.bills) because that is where the player edits it
   and where a crafter comes looking for work. Everything here answers
   one of four questions: can this bench run this recipe, does the bill
   still want doing, is there anything to make it out of, and what
   comes out. Cooking, butchering, stonecutting, tailoring and smithing
   are one job with one driver - they differ in their recipe def, not
   in their behaviour, so they differ in data.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  var Production = {};

  /* Quality runs 0..6. 'normal' is where an average crafter lands. */
  var QUALITY = ['awful', 'poor', 'normal', 'good', 'excellent', 'masterwork', 'legendary'];
  Production.QUALITY = QUALITY;

  /* Big enough that an unedited bill searches the whole map; the bill
     dialog shrinks it when a kitchen should stop raiding the stockpile
     on the far side of the mountain. */
  var DEFAULT_RADIUS = 999;

  /* Files above production.js in the load order are captured once.
     Game, Animals and Needs come after it, so those are looked up when
     they are called instead. */
  var Path = root.Path, Regions = root.Regions, Health = root.Health;
  var Research = root.Research, Construct = root.Construct;
  var Jobs = root.Jobs, Toils = root.Toils, Res = root.Res, T = root.T;

  function sys(name) { return root[name] || null; }
  function tickNow() { var G = sys('Game'); return (G && typeof G.tick === 'number') ? G.tick : 0; }
  function defOf(t) { return t ? (t.def || Defs.maybe('thing', t.defId)) : null; }
  /* Pawn owns the skill table; animals answer through the same call
     with numbers that live on their kind. */
  function skillLevel(pawn, id) {
    if (!pawn || !id) return 0;
    if (typeof pawn.skillLevel === 'function') return pawn.skillLevel(id) || 0;
    var s = pawn.skills && pawn.skills[id];
    return s ? (s.level || 0) : 0;
  }
  function hasTrait(pawn, id) { return !!(pawn && pawn.traits && pawn.traits.indexOf(id) >= 0); }

  /* Work units to experience, at the rate the rest of the game uses. */
  var XP_PER_WORK = 0.11;
  var PASSION_LEARN = [0.35, 1.0, 1.5];

  /* pawn.js owns the xp curve; the fallback is what keeps this file
     honest in a harness that has not loaded it. */
  function learn(pawn, skillId, xp) {
    if (!pawn || !skillId || !(xp > 0)) return;
    if (typeof pawn.learn === 'function') { pawn.learn(skillId, xp); return; }
    var s = pawn.skills && pawn.skills[skillId];
    if (!s) return;
    s.xp = (s.xp || 0) + xp * (PASSION_LEARN[s.passion | 0] || 1);
    while (s.level < 20 && s.xp >= 1000 * (s.level + 1)) { s.xp -= 1000 * (s.level + 1); s.level++; }
  }

  function mapFor(building, pawn) {
    if (pawn && pawn.map) return pawn.map;
    if (building && building.map) return building.map;
    var G = sys('Game');
    return (G && G.map) || null;
  }

  Production.qualityLabel = function (q) {
    return (typeof q === 'number' && QUALITY[q]) ? QUALITY[q] : 'normal';
  };

  /* ---------- geometry: where a crafter stands ---------- */

  /* map.js already owns footprints, rotation and the interaction
     offset, so this file asks the Thing rather than working any of it
     out a second time and getting it subtly different. */
  function footprintOf(b) {
    var f = b.footprint ? b.footprint() : { w: 1, h: 1 };
    return { x: b.x, y: b.y, w: f.w, h: f.h };
  }

  function standable(map, x, y) { return map.inBounds(x, y) && map.passable(x, y); }

  /* The tile a crafter has to occupy, and where the product lands. The
     def states one; if the player has walled it off we take any tile
     touching the bench, because a bench nobody can reach is a bug
     report rather than a design. */
  Production.interactionCell = function (map, building, pawn) {
    var cell = building.interactionCell ? building.interactionCell() : null;
    if (!cell && Construct && Construct.interactionCell) {
      cell = Construct.interactionCell(building.def, building.x, building.y, building.rot | 0);
    }
    if (!cell) cell = { x: building.x, y: building.y };
    if (standable(map, cell.x, cell.y)) return cell;

    var f = footprintOf(building), best = null, bestD = Infinity;
    for (var y = f.y - 1; y <= f.y + f.h; y++) {
      for (var x = f.x - 1; x <= f.x + f.w; x++) {
        if (!standable(map, x, y)) continue;
        var d = pawn ? U.distSq(pawn.x, pawn.y, x, y) : U.distSq(cell.x, cell.y, x, y);
        if (d < bestD) { bestD = d; best = { x: x, y: y }; }
      }
    }
    return best || { x: building.x, y: building.y };
  };

  /* Close enough to work: on the bench's own tile, or touching it. */
  Production.atBench = function (pawn, building) {
    if (!pawn || !building) return false;
    var f = footprintOf(building);
    return pawn.x >= f.x - 1 && pawn.x <= f.x + f.w && pawn.y >= f.y - 1 && pawn.y <= f.y + f.h;
  };

  /* ---------- benches ---------- */

  Production.benchAccepts = function (building, recipeId) {
    var recipe = Defs.maybe('recipe', recipeId);
    if (!building || !recipe) return false;
    var list = recipe.workbenches;
    if (list && list.length) return list.indexOf(building.defId) >= 0;
    var own = building.def && building.def.recipes;
    return !!(own && own.indexOf(recipeId) >= 0);
  };

  Production.recipeUnlocked = function (recipe) {
    var req = recipe && recipe.researchPrerequisite;
    if (!req) return true;
    return (Research && Research.isDone) ? !!Research.isDone(req) : true;
  };

  /* What the bill menu on this building should offer right now. */
  Production.availableRecipes = function (building) {
    var out = [], ids = (building && building.def && building.def.recipes) || [];
    for (var i = 0; i < ids.length; i++) {
      var recipe = Defs.maybe('recipe', ids[i]);
      if (recipe && Production.recipeUnlocked(recipe) && Production.benchAccepts(building, ids[i])) out.push(recipe);
    }
    return out;
  };

  /* An unpowered stove or a burnt-out campfire is furniture. */
  Production.benchUsable = function (building) {
    if (!building || !building.spawned || building.isBlueprint || building.isFrame) return false;
    var def = building.def;
    if (!def || !def.building || !def.building.isWorkbench) return false;
    if (def.building.powerConsumed > 0 && building.powered === false) return false;
    if (def.building.fuelCapacity > 0 && typeof building.fuel === 'number' && building.fuel <= 0) return false;
    return true;
  };

  /* No def carries a work-speed field, so what the bench cost to build
     stands in for how good a workspace it is: a marked patch of ground
     is slower than a smithy somebody spent two days on. */
  var BENCH_CURVE = [[0, 0.65], [150, 0.8], [900, 1.0], [1400, 1.08], [2000, 1.2]];

  Production.benchSpeed = function (bench) {
    if (!bench || !bench.def) return 1;
    var f = U.curve(BENCH_CURVE, bench.def.workToBuild || 0);
    if (typeof bench.quality === 'number') f *= 0.85 + 0.05 * bench.quality;
    var maxHp = bench.maxHp || bench.def.hp || 0;
    if (maxHp > 0 && bench.hp < maxHp) f *= U.lerp(0.7, 1, U.clamp01(bench.hp / maxHp));
    return f;
  };

  /* ---------- bills ---------- */

  Production.billRecipe = function (bill) { return bill ? Defs.maybe('recipe', bill.recipeId) : null; };

  Production.addBill = function (building, recipeId, opts) {
    opts = opts || {};
    var recipe = Defs.maybe('recipe', recipeId);
    if (!building || !recipe) return null;
    if (!Production.benchAccepts(building, recipeId)) return null;
    if (!Production.recipeUnlocked(recipe)) return null;

    var mode = opts.repeatMode || 'forever';
    if (mode !== 'count' && mode !== 'untilHave') mode = 'forever';

    var bill = {
      id: U.nextId(),
      recipeId: recipeId,
      buildingId: building.id,
      repeatMode: mode,
      targetCount: Math.max(1, opts.targetCount || (mode === 'untilHave' ? 20 : 10)),
      done: 0,
      suspended: !!opts.suspended,
      ingredientRadius: opts.ingredientRadius > 0 ? opts.ingredientRadius : DEFAULT_RADIUS,
      qualityRange: {
        min: opts.qualityMin === undefined ? 0 : U.clamp(opts.qualityMin | 0, 0, 6),
        max: opts.qualityMax === undefined ? 6 : U.clamp(opts.qualityMax | 0, 0, 6)
      }
    };
    if (!building.bills) building.bills = [];
    building.bills.push(bill);
    return bill;
  };

  Production.removeBill = function (building, bill) {
    return !building || !building.bills || !bill ? false : U.remove(building.bills, bill);
  };

  /* Order is priority: a crafter takes the first bill it can do. */
  Production.reorderBill = function (building, bill, dir) {
    if (!building || !building.bills || !bill || !dir) return false;
    var list = building.bills, i = list.indexOf(bill);
    if (i < 0) return false;
    var j = i + (dir < 0 ? -1 : 1);
    if (j < 0 || j >= list.length) return false;
    list[i] = list[j];
    list[j] = bill;
    return true;
  };

  Production.billLabel = function (bill) {
    var recipe = Production.billRecipe(bill);
    var name = recipe ? (recipe.label || recipe.id) : 'unknown recipe';
    if (bill.repeatMode === 'count') return name + ' x' + Math.max(0, bill.targetCount - bill.done);
    if (bill.repeatMode === 'untilHave') return name + ' until ' + bill.targetCount;
    return name + ' forever';
  };

  function qualityInRange(thing, bill) {
    if (typeof thing.quality !== 'number' || !bill.qualityRange) return true;
    return thing.quality >= bill.qualityRange.min && thing.quality <= bill.qualityRange.max;
  }

  /* 'until have' counts the recipe's main product wherever it is, down
     to what a hauler has in its arms - otherwise a cook restocks the
     kitchen forever while three meals walk around the map. */
  Production.countProducts = function (map, bill) {
    var recipe = Production.billRecipe(bill);
    if (!map || !recipe || !recipe.products) return 0;
    var ids = Object.keys(recipe.products);
    if (!ids.length) return 0;
    var wanted = ids[0], n = 0, i, k;

    var list = map.byDef(wanted) || [];
    for (i = 0; i < list.length; i++) {
      if (list[i].spawned && qualityInRange(list[i], bill)) n += list[i].stack || 1;
    }
    var pawns = map.pawns || [];
    for (i = 0; i < pawns.length; i++) {
      var c = pawns[i].carried;
      if (c && c.defId === wanted && qualityInRange(c, bill)) n += c.stack || 1;
      var inv = pawns[i].inventory || [];
      for (k = 0; k < inv.length; k++) {
        if (inv[k].defId === wanted && qualityInRange(inv[k], bill)) n += inv[k].stack || 1;
      }
    }
    return n;
  };

  Production.billShouldDo = function (map, bill) {
    if (!bill || bill.suspended) return false;
    var recipe = Production.billRecipe(bill);
    if (!recipe || !Production.recipeUnlocked(recipe)) return false;
    if (bill.repeatMode === 'count') return bill.done < bill.targetCount;
    if (bill.repeatMode === 'untilHave') return Production.countProducts(map, bill) < bill.targetCount;
    return true;
  };

  /* Unsuspended, still wanted, and something to make it out of. The
     pawn is optional: with one, reachability is that pawn's; without
     one it is "anywhere connected to the bench", which is what the UI
     wants when it greys a bill out. */
  Production.billsReady = function (building, pawn) {
    var out = [];
    if (!building || !building.bills || !building.bills.length) return out;
    if (!Production.benchUsable(building)) return out;
    var map = mapFor(building, pawn);
    for (var i = 0; i < building.bills.length; i++) {
      var bill = building.bills[i];
      if (!Production.billShouldDo(map, bill)) continue;
      if (map && !Production.findIngredients(map, pawn || null, bill)) continue;
      out.push(bill);
    }
    return out;
  };

  /* ---------- ingredients ---------- */

  /* Ingredient categories, written against fields the thing defs really
     carry. A def that names its own categories overrides all of this. */
  var CATEGORY_IDS = {
    meat: ['meatRaw'], stone: ['stoneChunk'], stoneChunks: ['stoneChunk'],
    blocks: ['stoneBlocks'], fabric: ['cloth', 'leather'], textiles: ['cloth', 'leather'],
    leathery: ['leather'], woody: ['wood'], metallic: ['steel', 'silver', 'components']
  };
  var CATEGORY_TESTS = {
    rawFood: function (d) { return d.foodType === 'raw'; },
    meal: function (d) { return d.foodType === 'meal'; },
    meals: function (d) { return d.foodType === 'meal'; },
    food: function (d) { return d.nutrition > 0 && d.foodType !== 'animal'; },
    plantMatter: function (d) { return d.foodType === 'raw' && d.id !== 'meatRaw'; },
    vegetarian: function (d) { return d.foodType === 'raw' && d.id !== 'meatRaw'; },
    corpse: function (d) { return d.foodType === 'animal'; },
    corpses: function (d) { return d.foodType === 'animal'; },
    medicine: function (d) { return d.isMedicine === true; },
    weapons: function (d) { return !!d.weapon; },
    meleeWeapons: function (d) { return !!d.weapon && !d.weapon.ranged; },
    rangedWeapons: function (d) { return !!d.weapon && !!d.weapon.ranged; },
    apparel: function (d) { return !!d.apparel; }
  };

  function defInCategory(def, category) {
    if (!def || !category) return false;
    var own = def.ingredientCategories || def.thingCategories;
    if (own && own.indexOf && own.indexOf(category) >= 0) return true;
    if (CATEGORY_IDS[category]) return CATEGORY_IDS[category].indexOf(def.id) >= 0;
    var test = CATEGORY_TESTS[category];
    return test ? test(def) : def.foodType === category;
  }

  /* Defs never change at runtime, so membership is worked out once. */
  var categoryCache = {};
  function categoryDefs(category) {
    if (!categoryCache[category]) {
      categoryCache[category] = Defs.all('thing').filter(function (d) {
        return d.category === 'item' && defInCategory(d, category);
      });
    }
    return categoryCache[category];
  }

  function candidateThings(map, spec) {
    if (spec.thing) return map.byDef(spec.thing) || [];
    var cat = spec.anyOfCategory || spec.category;
    if (!cat) return [];
    var defs = categoryDefs(cat), out = [];
    for (var i = 0; i < defs.length; i++) {
      var list = map.byDef(defs[i].id) || [];
      for (var k = 0; k < list.length; k++) out.push(list[k]);
    }
    return out;
  }

  function reachableFrom(map, pawn, from, thing) {
    if (!Path) return true;
    if (pawn && Path.reachable) return !!Path.reachable(map, pawn.x, pawn.y, thing.x, thing.y, { pawn: pawn });
    if (from && Regions && Regions.sameArea) return !!Regions.sameArea(map, from.x, from.y, thing.x, thing.y);
    return true;
  }

  function unreserved(map, pawn, thing) {
    if (!Res || !Res.reservedBy || !T) return true;
    var by = Res.reservedBy(map, T.thing(thing));
    return !by || by === pawn;
  }

  /* What goes in the pot first, lowest score winning. Days of shelf
     life left dominates, so the berries picked yesterday are cooked
     before the rice that keeps for ten days; market value separates
     two equally perishable things so a colony does not turn its
     medicine into stew. */
  function preference(thing) {
    var def = defOf(thing);
    var shelf = (!def || def.rotDays === null || def.rotDays === undefined) ? 60 : def.rotDays;
    var left = shelf * (1 - U.clamp01(thing.rotProgress || 0));
    return left * 4 + ((def && def.marketValue) || 0) * 3;
  }

  function unitNutrition(thing) {
    var def = defOf(thing);
    var n = def ? def.nutrition : 0;
    if (!(n > 0)) return 0;
    /* A half-rotten carcass feeds less than a fresh one. */
    return n * (1 - 0.4 * U.clamp01(thing.rotProgress || 0));
  }

  function addEntry(out, thing, count) {
    for (var i = 0; i < out.length; i++) {
      if (out[i].thing === thing) { out[i].count += count; return; }
    }
    out.push({ thing: thing, count: count });
  }

  /* Give up after this many stacks in a row turn out to be across the
     river. Reachability is the one test here that is not two integer
     lookups, so it is asked last and only of the stacks a cook would
     actually reach for. */
  var MAX_MISSES = 48;

  function resolveSpec(ctx, spec, out) {
    var byNutrition = spec.nutrition > 0;
    var need = byNutrition ? spec.nutrition : Math.max(1, spec.count || 1);
    var pool = candidateThings(ctx.map, spec), usable = [], i, t;

    for (i = 0; i < pool.length; i++) {
      t = pool[i];
      if (!t || !t.spawned || t === ctx.bench) continue;
      if (((t.stack || 1) - (ctx.taken[t.id] || 0)) <= 0) continue;
      if (U.dist(ctx.origin.x, ctx.origin.y, t.x, t.y) > ctx.radius) continue;
      if (byNutrition && unitNutrition(t) <= 0) continue;
      if (!unreserved(ctx.map, ctx.pawn, t)) continue;
      usable.push(t);
    }

    /* A tile of walking is worth a tenth of a preference point: enough
       that a cook takes the nearer of two like stacks, nowhere near
       enough to make it grab the rice because the berries are across
       the courtyard. Scored once rather than inside the comparator. */
    var from = ctx.from, score = {};
    for (i = 0; i < usable.length; i++) {
      t = usable[i];
      score[t.id] = preference(t) + U.dist(from.x, from.y, t.x, t.y) * 0.1;
    }
    usable.sort(function (a, b) { return score[a.id] - score[b.id]; });

    var misses = 0;
    for (i = 0; i < usable.length && need > 1e-6; i++) {
      t = usable[i];
      if (!reachableFrom(ctx.map, ctx.pawn, from, t)) {
        if (++misses >= MAX_MISSES) break;
        continue;
      }
      var avail = (t.stack || 1) - (ctx.taken[t.id] || 0), take;
      if (byNutrition) {
        var per = unitNutrition(t);
        take = Math.min(avail, Math.ceil(need / per - 1e-6));
        need -= take * per;
      } else {
        take = Math.min(avail, need);
        need -= take;
      }
      if (take <= 0) continue;
      ctx.taken[t.id] = (ctx.taken[t.id] || 0) + take;
      addEntry(out, t, take);
    }
    return need <= 1e-6;
  }

  /* Resolve a recipe's ingredient list against what is lying around.
     Returns null - never a partial list - when anything is short,
     because a half-supplied bill is a pawn walking to a bench to stand
     there. */
  Production.findIngredients = function (map, pawn, bill) {
    var recipe = Production.billRecipe(bill);
    if (!map || !recipe) return null;
    var specs = recipe.ingredients || [];
    if (!specs.length) return [];

    var bench = map.thing(bill.buildingId);
    if (!bench && !pawn) return null;

    /* Radius is measured from the bench, but reachability is asked from
       the tile a pawn can stand on: the bench's own tile is impassable
       and belongs to no region. */
    var ctx = {
      map: map, pawn: pawn, bench: bench, taken: {},
      origin: bench ? bench.center() : { x: pawn.x, y: pawn.y },
      from: bench ? Production.interactionCell(map, bench, pawn) : { x: pawn.x, y: pawn.y },
      radius: bill.ingredientRadius > 0 ? bill.ingredientRadius : DEFAULT_RADIUS
    };

    var out = [];
    for (var i = 0; i < specs.length; i++) {
      if (!resolveSpec(ctx, specs[i], out)) return null;
    }
    return out;
  };

  /* ---------- work ---------- */

  Production.workSpeedFactor = function (pawn, bill, bench) {
    var recipe = Production.billRecipe(bill), f = 1;
    if (recipe && recipe.skill) f *= 0.4 + 0.08 * skillLevel(pawn, recipe.skill);
    f *= Production.benchSpeed(bench);
    if (Health && Health.workSpeedFactor) f *= Health.workSpeedFactor(pawn);
    /* Clamped away from zero: Health hands back 0 for a downed pawn and
       workAmount divides by this. */
    return U.clamp(f, 0.08, 8);
  };

  /* What the driver actually has to grind through: the recipe's nominal
     work divided by how fast this pawn at this bench gets through it.
     The work toil then runs at a flat unit per tick, which keeps the
     skill and bench factors in one place and turns the xp Toils.work
     grants per work unit into xp per tick, as it should be. */
  Production.workAmount = function (bill, pawn) {
    var recipe = Production.billRecipe(bill);
    var base = (recipe && recipe.workAmount > 0) ? recipe.workAmount : 200;
    var map = pawn ? pawn.map : null;
    var bench = (map && bill && map.thing) ? map.thing(bill.buildingId) : null;
    return Math.max(1, base / Production.workSpeedFactor(pawn, bill, bench));
  };

  /* ---------- making things ---------- */

  /* Centred so that skill 8 lands on 'normal'. The top two tiers get a
     second gate: without it a level-20 smith turns out a masterwork
     every other morning and the word stops meaning anything. */
  Production.rollQuality = function (pawn, skillId) {
    var lvl = skillLevel(pawn, skillId);
    var q = U.clamp(Math.round(U.gauss(0.85 + lvl * 0.1575, 1.05, -2, 8)), 0, 6);
    if (q >= 6 && !U.chance(0.015 + lvl * 0.002)) q = 5;
    if (q >= 5 && !U.chance(0.06 + lvl * 0.008)) q = 4;
    return q;
  };

  /* Stamped onto the meal at cook time; needs.js rolls against it when
     somebody eats. A clumsy cook in a filthy kitchen is the whole story
     of every food poisoning outbreak a colony ever has. */
  Production.foodPoisonChance = function (pawn, recipe, map, bench) {
    var base = (recipe && recipe.foodPoisonChance > 0) ? recipe.foodPoisonChance : 0;
    if (base <= 0) return 0;
    var lvl = skillLevel(pawn, recipe.skill || 'cooking');
    var chance = base * U.curve([[0, 1], [4, 0.6], [8, 0.35], [12, 0.2], [20, 0.06]], lvl);
    if (Regions && Regions.roomAt && map && bench) {
      var room = Regions.roomAt(map, bench.x, bench.y);
      if (room && room.cleanliness < 0) chance *= 1 + Math.min(2, -room.cleanliness * 0.6);
    }
    return U.clamp01(chance);
  };

  /* A carcass is worth what its species is worth, scaled by how good
     the butcher is and how long the thing has been lying there. */
  Production.butcherYield = function (pawn, corpseThing) {
    var out = {};
    var info = corpseThing && corpseThing.corpse;
    var kind = info ? Defs.maybe('pawnKind', info.kindId) : null;
    if (!kind) return out;

    var base = kind.butcherProducts || null;
    var Animals = sys('Animals');
    if (!base && Animals && Animals.butcherProducts) {
      base = Animals.butcherProducts(kind) || Animals.butcherProducts(kind.id);
    }
    var eff = U.clamp(0.55 + 0.03 * skillLevel(pawn, 'cooking'), 0.3, 1.1);
    /* Rot takes the meat first; a hide is still a hide. */
    var fresh = 1 - 0.5 * U.clamp01(corpseThing.rotProgress || 0);

    Object.keys(base || {}).forEach(function (id) {
      if (!Defs.has('thing', id)) return;
      var n = Math.floor(base[id] * eff * fresh);
      if (n > 0) out[id] = (out[id] || 0) + n;
    });

    var leatherId = kind.leatherDef || 'leather';
    var leather = kind.leatherAmount || 0;
    if (leather > 0 && !out[leatherId] && Defs.has('thing', leatherId)) {
      var l = Math.floor(leather * eff);
      if (l > 0) out[leatherId] = l;
    }
    return out;
  };

  function leaveBlood(map, cells) {
    for (var i = 0; i < cells.length; i++) {
      var c = cells[i];
      if (!map.inBounds || !map.inBounds(c.x, c.y)) continue;
      var amount = U.randInt(45, 105);
      if (map.addBlood) { map.addBlood(c.x, c.y, amount); continue; }
      if (!map.blood) continue;
      var i2 = map.idx(c.x, c.y);
      map.blood[i2] = Math.min(255, map.blood[i2] + amount);
    }
  }

  /* Butchering a person is not butchering a hare. There is no squeamish
     trait in the registry, so the thought that fits is the one for
     having seen a body - and the two traits that would not care are the
     two that never do. */
  function butcherMood(pawn, kind) {
    var Needs = sys('Needs');
    if (!Needs || !Needs.addThought || !kind || kind.body !== 'human') return;
    if (hasTrait(pawn, 'psychopath') || hasTrait(pawn, 'bloodlust')) return;
    if (Defs.has('thought', 'observedCorpse')) Needs.addThought(pawn, 'observedCorpse');
  }

  function pushAll(dst, src) {
    if (!src) return;
    if (src.length === undefined) { dst.push(src); return; }
    for (var i = 0; i < src.length; i++) dst.push(src[i]);
  }

  /* Quality and a bad batch have to stay attached to their own stack,
     so those spawn as their own things instead of merging into whatever
     pile is already on the floor. */
  function spawnProduct(map, cell, defId, count, opts) {
    var def = Defs.maybe('thing', defId);
    if (!def || count <= 0) return [];
    var out = [], n, t;

    if (def.stackLimit <= 1) {
      for (n = 0; n < count; n++) {
        t = map.spawnThing(defId, cell.x, cell.y, {
          stack: 1, faction: 'player', quality: opts.quality ? opts.quality() : null
        });
        if (t) out.push(t);
      }
    } else if (opts.poison > 0) {
      while (count > 0) {
        n = Math.min(def.stackLimit, count);
        t = map.spawnThing(defId, cell.x, cell.y, { stack: n, faction: 'player' });
        if (!t) break;
        t.foodPoisonChance = opts.poison;
        out.push(t);
        count -= n;
      }
    } else {
      pushAll(out, map.addItem(defId, cell.x, cell.y, count));
    }
    return out;
  }

  function stillThere(entry) {
    return !!(entry && entry.count > 0 && entry.thing && (entry.thing.stack || 0) >= entry.count);
  }

  function consumeEntry(map, entry) {
    var t = entry.thing;
    t.stack -= entry.count;
    if (t.stack > 0) return;
    t.stack = 0;
    if (t.spawned) map.despawnThing(t);
    else if (map.things && map.things.delete) map.things.delete(t.id);
  }

  /* Spawns the products and eats the ingredients. Returns what it made,
     or an empty array if anything was missing - and in that case
     nothing at all has been consumed. */
  Production.doRecipe = function (pawn, building, bill, ingredients) {
    var map = mapFor(building, pawn);
    var recipe = Production.billRecipe(bill);
    if (!map || !recipe || !building) return [];
    ingredients = ingredients || [];

    var i;
    for (i = 0; i < ingredients.length; i++) if (!stillThere(ingredients[i])) return [];

    /* Everything that will come out is worked out BEFORE anything is
       eaten, because butchering reads the carcass it destroys. */
    var plan = [], carcasses = [];
    for (i = 0; i < ingredients.length; i++) {
      var src = ingredients[i].thing;
      if (!src.corpse) continue;
      carcasses.push(src);
      var yields = Production.butcherYield(pawn, src);
      Object.keys(yields).forEach(function (id) {
        plan.push({ defId: id, count: yields[id], quality: null, poison: 0 });
      });
    }

    var poison = Production.foodPoisonChance(pawn, recipe, map, building);
    var products = recipe.products || {};
    Object.keys(products).forEach(function (id) {
      var count = products[id] | 0;
      if (count <= 0) return;
      plan.push({
        defId: id, count: count, poison: poison,
        quality: recipe.productQuality ? function () { return Production.rollQuality(pawn, recipe.skill); } : null
      });
    });

    /* A carcass too rotten to yield anything is not worth destroying. */
    if (!plan.length) return [];

    for (i = 0; i < ingredients.length; i++) consumeEntry(map, ingredients[i]);

    var cell = Production.interactionCell(map, building, pawn);
    var made = [];
    for (i = 0; i < plan.length; i++) {
      pushAll(made, spawnProduct(map, cell, plan[i].defId, plan[i].count, plan[i]));
    }

    if (carcasses.length) {
      var f = footprintOf(building);
      leaveBlood(map, [cell, { x: f.x, y: f.y }, { x: f.x + f.w - 1, y: f.y + f.h - 1 }]);
      for (i = 0; i < carcasses.length; i++) {
        butcherMood(pawn, Defs.maybe('pawnKind', carcasses[i].corpse.kindId));
      }
    }

    if (bill.repeatMode === 'count') {
      bill.done++;
      /* A finished "do X times" bill drops off the list rather than
         sitting there greyed out forever. */
      if (bill.done >= bill.targetCount) Production.removeBill(building, bill);
    }
    bill.lastDoneTick = tickNow();
    return made;
  };

  /* ---------- the doBill job ----------
     One driver for every bench in the game: claim the bench, claim the
     ingredients, fetch each one and set it down at the bench, grind
     through the work, then turn the pile into a product. The
     per-ingredient legs are generated when the job starts, because by
     then the list is known and a fixed toil array cannot loop. */

  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  function targetThing(job, which, map) {
    var t = job['target' + which];
    return (t && T) ? T.resolve(t, map) : null;
  }

  function debug(why) {
    var G = sys('Game');
    if (G && G.debug) console.log('doBill: ' + why);
  }

  function failToil(why) {
    return Toils.custom({ name: 'billImpossible', tick: function () { debug(why); return 'fail'; } });
  }

  function releaseEach(pawn, list) {
    for (var i = 0; list && i < list.length; i++) {
      if (list[i].thing && T) Res.release(pawn, T.thing(list[i].thing));
    }
  }

  function releaseClaims(pawn, job) {
    if (!Res || !Res.release) return;
    if (job.targetA) Res.release(pawn, job.targetA);
    releaseEach(pawn, job.state && job.state.plan);
    releaseEach(pawn, job.state && job.state.delivered);
  }

  /* The job is ending before the recipe ran. What was already hauled to
     the bench is lying on the bench's own tile, so there is nothing to
     put back - only the claims to drop and whatever is still in the
     crafter's arms to set down. */
  function abortBill(pawn, job) {
    var st = job.state;
    if (!st || st.aborted) return;
    st.aborted = true;
    if (pawn.carried && pawn.map) {
      var t = pawn.carried;
      pawn.carried = null;
      pawn.map.moveThing(t, pawn.x, pawn.y);
    }
    releaseClaims(pawn, job);
  }

  /* Every toil in this job is wrapped. One that ends without having
     said 'next' or 'done' ended because the job did, and that is when
     the claims have to come off. */
  function guarded(toil, precheck) {
    var out = {}, k;
    for (k in toil) out[k] = toil[k];
    out.init = function (pawn, job, s) { s.advanced = false; if (toil.init) toil.init(pawn, job, s); };
    out.tick = function (pawn, job, s) {
      if (precheck && !precheck(pawn, job)) return 'fail';
      var r = toil.tick ? toil.tick(pawn, job, s) : 'next';
      if (r === 'next' || r === 'done') s.advanced = true;
      return r;
    };
    out.end = function (pawn, job, s) {
      if (toil.end) toil.end(pawn, job, s);
      if (!s.advanced) abortBill(pawn, job);
    };
    return out;
  }

  function billStillValid(pawn, job) {
    var bench = targetThing(job, 'A', pawn.map);
    if (!bench || !Production.benchUsable(bench)) return false;
    return !!(job.bill && !job.bill.suspended);
  }

  /* Claim the bench and every stack the recipe needs, up front: two
     cooks must not walk to the same stove, and two bills must not both
     believe they own the last twenty berries. */
  function planBill(pawn, job) {
    var map = pawn && pawn.map, bill = job.bill;
    if (!job.state) job.state = {};
    var bench = map ? targetThing(job, 'A', map) : null;
    if (!map || !bill || !bench) return null;
    if (!Production.benchUsable(bench)) return null;
    if (!Production.benchAccepts(bench, bill.recipeId)) return null;
    if (!Production.billShouldDo(map, bill)) return null;

    var plan = job.state.plan || job.state.ingredients || Production.findIngredients(map, pawn, bill);
    if (!plan) return null;

    var i;
    if (Res && Res.canReserve) {
      if (!Res.canReserve(pawn, job.targetA, 1)) return null;
      for (i = 0; i < plan.length; i++) {
        if (!Res.canReserve(pawn, T.thing(plan[i].thing), 1)) return null;
      }
    }
    if (Res && Res.reserve) {
      Res.reserve(pawn, job.targetA, 1);
      for (i = 0; i < plan.length; i++) Res.reserve(pawn, T.thing(plan[i].thing), 1);
    }

    job.state.plan = plan;
    job.state.delivered = [];
    job.state.aborted = false;
    job.state.dropCell = Production.interactionCell(map, bench, pawn);
    return plan;
  }

  function chooseIngredientToil(i) {
    return Toils.custom({
      name: 'chooseIngredient',
      tick: function (pawn, job) {
        var entry = job.state.plan[i], t = entry && entry.thing;
        /* Somebody hauled it away, or it burned: the bill is off. */
        if (!t || !t.spawned || (t.stack || 0) < entry.count) return 'fail';
        job.state.ingIdx = i;
        job.targetB = T.thing(t);
        return 'next';
      }
    });
  }

  function ingredientCount(pawn, job) {
    var entry = job.state.plan[job.state.ingIdx];
    return entry ? entry.count : 0;
  }

  /* The ingredient is set down on the bench's own tile and claimed
     there, exactly as it works in RimWorld. Putting it on the floor
     rather than into limbo on the job is what makes an interrupted
     bill harmless: the food is already back in the world, and the
     claim that stops a hauler taking it dies with the job. */
  function deliverToil() {
    return Toils.custom({
      name: 'deliverIngredient',
      tick: function (pawn, job) {
        var map = pawn.map, carried = pawn.carried;
        var entry = job.state.plan[job.state.ingIdx];
        if (!carried || !entry || (carried.stack || 0) < entry.count) return 'fail';

        /* Take exactly what the recipe asked for; anything extra the
           pawn scooped up goes back on the floor where it stands. */
        if (carried.stack > entry.count) {
          map.addItem(carried.defId, pawn.x, pawn.y, carried.stack - entry.count);
          carried.stack = entry.count;
        }
        var cell = job.state.dropCell;
        pawn.carried = null;
        if (!map.moveThing(carried, cell.x, cell.y)) return 'fail';
        job.state.delivered.push({ thing: carried, count: carried.stack });
        if (Res && Res.reserve) Res.reserve(pawn, T.thing(carried), 1);

        /* The source stack is free the moment its share is in hand, so
           a second crafter can start on what is left of it. */
        if (Res && Res.release && entry.thing) Res.release(pawn, T.thing(entry.thing));
        return 'next';
      }
    });
  }

  /* Masterwork and legendary are rare enough that the colony hears. */
  function announce(pawn, made) {
    var G = sys('Game'), t = made[0];
    if (!G || !G.letter || !t || !(t.quality >= 5)) return;
    var who = (pawn.name && (pawn.name.nick || pawn.name.first)) || 'A crafter';
    G.letter('Fine work', who + ' has crafted a ' + Production.qualityLabel(t.quality) +
      ' ' + (t.def ? t.def.label : t.defId) + '.', { kind: 'good', x: t.x, y: t.y });
  }

  /* The grind. Work is applied here rather than through Toils.work so
     that the bench check, the xp and the "is it finished yet" answer
     all live in one place - which is the same call construct.js makes,
     for the same reason. Experience lands every tick the crafter
     actually spends at the bench, not in a lump at the end. */
  function workToil(recipe) {
    return Toils.custom({
      name: 'billWork',
      init: function (pawn, job, s) {
        s.total = Production.workAmount(job.bill, pawn);
        s.done = 0;
      },
      tick: function (pawn, job, s) {
        var bench = targetThing(job, 'A', pawn.map);
        if (!bench || !Production.benchUsable(bench)) return 'fail';
        if (!job.bill || job.bill.suspended) return 'fail';
        if (!Production.atBench(pawn, bench)) return 'fail';
        s.done++;
        job.workLeft = s.total - s.done;
        if (recipe && recipe.skill) learn(pawn, recipe.skill, XP_PER_WORK);
        return s.done < s.total ? 'stay' : 'next';
      },
      end: function (pawn, job) { job.workLeft = 0; }
    });
  }

  function finishToil() {
    return Toils.custom({
      name: 'finishRecipe',
      tick: function (pawn, job) {
        var bench = targetThing(job, 'A', pawn.map), bill = job.bill;
        if (!bench || !bill) return 'fail';
        var made = Production.doRecipe(pawn, bench, bill, job.state.delivered || []);
        if (!made.length) return 'fail';
        job.state.delivered = [];
        releaseClaims(pawn, job);
        announce(pawn, made);
        return 'done';
      }
    });
  }

  if (Jobs && Jobs.register) {
    Jobs.register('doBill', {
      label: 'do bill',
      suspendable: true,
      reportString: function (job, pawn) {
        var recipe = Production.billRecipe(job.bill);
        var bench = targetThing(job, 'A', pawn && pawn.map);
        var what = recipe ? (recipe.jobString || ('making ' + (recipe.label || recipe.id))) : 'working';
        var where = (bench && bench.def) ? (bench.def.label || bench.defId) : 'a bench';
        return U.cap(what) + ' at ' + where;
      },
      toils: function (job, pawn) {
        pawn = pawn || job.pawn;
        var plan = pawn ? planBill(pawn, job) : null;
        if (!plan) return [failToil('nothing to work with')];
        var recipe = Production.billRecipe(job.bill);
        var toils = [];
        for (var i = 0; i < plan.length; i++) {
          toils.push(guarded(chooseIngredientToil(i)));
          toils.push(guarded(Toils.goto('B', { pe: PE.TOUCH, failIfGone: true })));
          toils.push(guarded(Toils.pickUp('B', ingredientCount)));
          toils.push(guarded(Toils.goto('A', { pe: PE.INTERACTION, failIfGone: true })));
          toils.push(guarded(deliverToil()));
        }
        toils.push(guarded(Toils.goto('A', { pe: PE.INTERACTION, failIfGone: true }), billStillValid));
        toils.push(guarded(workToil(recipe)));
        toils.push(guarded(finishToil()));
        return toils;
      }
    });
  }

  root.Production = Production;
})(this);
