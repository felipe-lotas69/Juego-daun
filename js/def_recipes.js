/* ============================================================
   def_recipes.js - every bill a workbench can be told to run.

   A recipe is data plus the handful of helpers resolved onto it below.
   Fields, beyond the self-explaining ones: `workAmount` is in work units,
   and a colonist does about one per tick at normal speed times their skill
   factor (0.4 + 0.08 x level), so 300 work is roughly five seconds for a
   hopeless cook. `workType` says which work column scans the bill - cooking and
   butchering are 'cook', everything else 'craft'. `workbenches` is the
   reverse of a building's recipe list: which benches offer this bill.

   Ingredient forms, all three of which appear below:

     {thing: 'steel', count: 12}
         exactly that def, that many units.

     {anyOf: ['riceRaw', ...], count: n}
         any one of those defs; a bill may mix them to reach the count.

     {anyOfCategory: 'rawFood', nutrition: 0.5}
         the cooking form. The requirement is a nutrition total rather than a
         unit count, because a potato and a slab of meat are not
         interchangeable by the piece. The category resolves to a concrete
         `anyOf` list at load time (def_things.js is already registered by
         then), and a `count` is filled in too, so a consumer that only
         understands counts still behaves: it is how many of the least
         nourishing candidate the total would take, which can never
         under-deliver.

   Every ingredient also carries matches(thingDef) -> bool and every recipe
   carries accepts(thingDef) -> bool, so hunting for ingredients never has to
   re-derive the three forms.
   ============================================================ */
(function (root) {
  'use strict';

  var Defs = root.Defs, U = root.U;

  /* Ingredient categories are listed by id rather than filtered out of the
     thing table: the id registry is frozen by the contract, while how
     def_things.js classifies a thing is not. Ids that did not register get
     dropped, so a category can never yield a dangling ref. */
  var CATEGORY_IDS = {
    rawPlantFood: ['riceRaw', 'potatoRaw', 'cornRaw', 'berries'],
    meat: ['meatRaw'],
    rawFood: ['riceRaw', 'potatoRaw', 'cornRaw', 'berries', 'meatRaw'],
    /* Wooden weapons burn rather than melt, so the bow and the club are out. */
    smeltableWeapon: ['knife', 'spear', 'pistol', 'boltRifle', 'autoRifle', 'shotgun', 'sniperRifle']
  };

  /* Nutrition per unit. def_things.js states it as a plain field on the def;
     the fallback is the contract's figure for raw food, which is what every
     ingredient category in this file is made of. */
  var RAW_NUTRITION = 0.05;

  function nutritionOf(defId) {
    var d = Defs.maybe('thing', defId);
    return (d && d.nutrition > 0) ? d.nutrition : RAW_NUTRITION;
  }

  function resolveCategory(name) {
    var ids = CATEGORY_IDS[name];
    if (!ids) throw new Error('def_recipes: unknown ingredient category ' + name);
    var live = ids.filter(function (id) { return Defs.has('thing', id); });
    /* Nothing registered means def_things.js moved below us in the load order;
       keep the authored list so the recipe still reads correctly rather than
       silently accepting nothing at all. */
    return live.length ? live : ids.slice();
  }

  function normalizeIngredient(ing, recipeId) {
    if (ing.anyOfCategory) ing.anyOf = resolveCategory(ing.anyOfCategory);
    if (ing.anyOf) {
      var set = {};
      ing.anyOf.forEach(function (id) { set[id] = true; });
      ing.matches = function (thingDef) { return !!(thingDef && set[thingDef.id]); };
      if (ing.count === undefined) {
        /* How many of the least nourishing candidate it would take, so a
           consumer that reads counts and not nutrition over-collects rather
           than arriving at the bench short. */
        var per = Infinity;
        ing.anyOf.forEach(function (id) { per = Math.min(per, nutritionOf(id)); });
        if (!(per > 0) || per === Infinity) per = RAW_NUTRITION;
        ing.count = Math.max(1, Math.ceil((ing.nutrition || 0) / per));
      }
    } else if (ing.thing) {
      var only = ing.thing;
      ing.matches = function (thingDef) { return !!(thingDef && thingDef.id === only); };
      if (ing.count === undefined) ing.count = 1;
    } else {
      throw new Error('def_recipes: ' + recipeId + ' has an ingredient with no source');
    }
    return ing;
  }

  function accepts(thingDef) {
    for (var i = 0; i < this.ingredients.length; i++) {
      if (this.ingredients[i].matches(thingDef)) return true;
    }
    return false;
  }

  function skillLevel(pawn, skillId) {
    var s = pawn && pawn.skills && pawn.skills[skillId];
    return s ? s.level : 0;
  }

  /* A hopeless cook poisons roughly one meal in twelve; a master almost never
     does. Multiplied into the recipe's own base chance. */
  var POISON_BY_COOKING = [[0, 4], [4, 2], [8, 1], [12, 0.6], [16, 0.3], [20, 0.15]];

  function foodPoisonChanceFor(pawn) {
    if (!this.foodPoisonChance) return 0;
    return U.clamp01(this.foodPoisonChance * U.curve(POISON_BY_COOKING, skillLevel(pawn, 'cooking')));
  }

  /* Butchering wastes less as the cook improves: 60% of the carcass at skill 0,
     all of it at 20. */
  function butcherYieldFactor(pawn) {
    return U.clamp(0.6 + 0.02 * skillLevel(pawn, 'cooking'), 0.6, 1);
  }

  function yieldsNothing(table) {
    if (!table) return true;
    for (var id in table) if (table[id] > 0) return false;
    return true;
  }

  /* butcherCorpse is the one recipe whose output is not knowable from the def:
     it depends on what died, who is holding the knife and how long the body
     has been lying there. Production calls this with the ingredients it
     actually consumed, either as bare Things or as {thing, count} rows. */
  function butcherProductsFor(ingredients, pawn) {
    var corpse = null, i, t;
    for (i = 0; i < (ingredients || []).length; i++) {
      t = ingredients[i] && (ingredients[i].thing || ingredients[i]);
      if (t && t.corpse) { corpse = t; break; }
    }
    if (!corpse) return {};
    var kind = Defs.maybe('pawnKind', corpse.corpse.kindId), base = null;
    if (kind && root.Animals && typeof root.Animals.butcherProducts === 'function') {
      base = root.Animals.butcherProducts(kind);
    }
    /* Animals hands back an empty table for any kind it does not treat as an
       animal - every human kind - and an empty table is an absent answer
       rather than an answer of nothing, so the fallbacks still get a turn. */
    if (yieldsNothing(base)) base = kind && kind.butcherProducts;
    if (yieldsNothing(base)) {
      base = { meatRaw: 30 };
      if (kind && kind.leatherAmount > 0) base[kind.leatherDef || 'leather'] = kind.leatherAmount;
    }
    /* A carcass rots down to half its yield. production.js applies the same
       reduction to the table it falls back on, and it prefers this function
       whenever a recipe carries one, so stating rot here is the only thing
       that stops a week-old corpse butchering like a fresh one. */
    var factor = butcherYieldFactor(pawn) * (1 - 0.5 * U.clamp01(corpse.rotProgress || 0));
    var out = {};
    Object.keys(base).forEach(function (id) {
      if (!Defs.has('thing', id)) return;
      var n = Math.floor(base[id] * factor);
      if (n > 0) out[id] = n;
    });
    return out;
  }

  var RECIPES = {

    /* ---- cooking ---- */
    cookSimpleMeal: {
      label: 'simple meal', jobString: 'Cooking meal', uiCategory: 'cooking',
      workAmount: 300, skill: 'cooking', workType: 'cook',
      workbenches: ['stove', 'campfire'],
      ingredients: [{ anyOfCategory: 'rawFood', nutrition: 0.5 }],
      products: { mealSimple: 1 }, foodPoisonChance: 0.02,
      defaultRepeat: 'untilHave', defaultTargetCount: 30,
      description: 'Half a nutrition unit of anything edible, cooked into one meal. ' +
        'Colonists will eat raw food if they must, and resent it.'
    },

    cookFineMeal: {
      label: 'fine meal', jobString: 'Cooking fine meal', uiCategory: 'cooking',
      workAmount: 500, skill: 'cooking', skillRequirement: 6, workType: 'cook',
      /* A campfire cannot do better than simple: fine meals need the stove. */
      workbenches: ['stove'],
      ingredients: [{ anyOfCategory: 'meat', nutrition: 0.4 },
        { anyOfCategory: 'rawPlantFood', nutrition: 0.45 }],
      products: { mealFine: 1 }, foodPoisonChance: 0.015,
      defaultRepeat: 'untilHave', defaultTargetCount: 20,
      description: 'Meat and vegetables together. Costs nearly twice a simple meal ' +
        'and lifts the mood of everyone who eats one.'
    },

    /* ---- butchery ---- */
    butcherCorpse: {
      label: 'butcher creature', jobString: 'Butchering', uiCategory: 'butchery',
      workAmount: 400, skill: 'cooking', workType: 'cook',
      workbenches: ['butcherTable', 'campfire'],
      ingredients: [{ thing: 'corpse', count: 1 }],
      /* Filled in per corpse by productsFor. The static table stays empty so a
         consumer that spawns `products` blindly spawns nothing, rather than
         conjuring a muffalo's worth of meat out of a dead hare. */
      products: {}, dynamicProducts: true, productsLabel: 'meat and leather',
      productsFor: butcherProductsFor, yieldFactorFor: butcherYieldFactor,
      defaultRepeat: 'forever',
      description: 'Break a corpse down into meat and leather. Colonists who watch ' +
        'will not enjoy it, and butchering a human is worse.'
    },

    makeKibble: {
      label: 'kibble', jobString: 'Making kibble', uiCategory: 'butchery',
      workAmount: 600, skill: 'cooking', workType: 'cook',
      workbenches: ['butcherTable'],
      ingredients: [{ anyOfCategory: 'rawPlantFood', nutrition: 0.4 },
        { anyOfCategory: 'meat', nutrition: 0.4 }],
      products: { kibble: 25 },
      defaultRepeat: 'untilHave', defaultTargetCount: 50,
      description: 'Dried animal feed. It never rots and it stretches scraps a long ' +
        'way, which is the only reason anyone makes it.'
    },

    /* ---- stonecutting ---- */
    cutStoneBlocks: {
      label: 'stone blocks', jobString: 'Cutting stone', uiCategory: 'stonecutting',
      workAmount: 500, skill: 'crafting',
      workbenches: ['stonecutterTable'],
      ingredients: [{ thing: 'stoneChunk', count: 1 }],
      products: { stoneBlocks: 20 },
      researchPrerequisite: 'stonecutting', defaultRepeat: 'forever',
      description: 'Twenty blocks from one chunk. Blocks build slower than wood but ' +
        'they do not burn.'
    },

    /* ---- medicine ---- */
    makeHerbalMedicine: {
      label: 'herbal medicine', jobString: 'Preparing herbal medicine', uiCategory: 'medicine',
      workAmount: 600, skill: 'medicine', skillRequirement: 2,
      workbenches: ['craftingSpot'],
      /* Healroot is harvested straight into herbal medicine, so this recipe is
         the fallback for a colony with none planted: plant fibre and gathered
         herbs pressed into poultices, deliberately worse value than growing it. */
      ingredients: [{ thing: 'cloth', count: 15 }],
      products: { herbalMedicine: 3 },
      defaultRepeat: 'untilHave', defaultTargetCount: 15,
      description: 'Poultices bound from plant fibre. Far less efficient than growing ' +
        'healroot, but it needs no research and no soil.'
    },

    makeMedicine: {
      label: 'medicine', jobString: 'Making medicine', uiCategory: 'medicine',
      workAmount: 1000, skill: 'medicine', skillRequirement: 4,
      workbenches: ['smithy'],
      ingredients: [{ thing: 'herbalMedicine', count: 3 }, { thing: 'components', count: 1 }],
      products: { medicine: 1 },
      researchPrerequisite: 'medicineProduction',
      defaultRepeat: 'untilHave', defaultTargetCount: 20,
      description: 'Sterile dressings and drugs. Roughly doubles how well a wound ' +
        'tends compared to herbal, and infections care about that.'
    },

    /* ---- smithing: raw materials ---- */
    makeComponents: {
      label: 'components', jobString: 'Fabricating components', uiCategory: 'smithing',
      workAmount: 1400, skill: 'crafting', skillRequirement: 8,
      workbenches: ['smithy'],
      ingredients: [{ thing: 'steel', count: 12 }],
      products: { components: 1 },
      researchPrerequisite: 'machining',
      defaultRepeat: 'untilHave', defaultTargetCount: 10,
      description: 'Slow and steel-hungry. Mining compacted machinery is far cheaper; ' +
        'this is the answer when the seam runs out.'
    },

    smeltWeapon: {
      label: 'smelt weapon', jobString: 'Smelting', uiCategory: 'smithing',
      workAmount: 600, skill: 'crafting',
      workbenches: ['smithy'],
      ingredients: [{ anyOfCategory: 'smeltableWeapon', count: 1 }],
      products: { steel: 20 },
      researchPrerequisite: 'smithing', defaultRepeat: 'forever',
      description: 'Melt a metal weapon down for its steel. Raiders leave more guns ' +
        'than a colony can carry, and this is what they are worth.'
    },

    /* ---- tailoring ---- */
    sewShirt: {
      label: 'shirt', jobString: 'Tailoring', uiCategory: 'tailoring',
      workAmount: 700, skill: 'crafting',
      workbenches: ['tailoringBench'],
      ingredients: [{ thing: 'cloth', count: 35 }],
      products: { shirt: 1 }, productQuality: true,
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Basic cover. A colonist in nothing but skin is cold and ashamed, ' +
        'in that order.'
    },

    sewPants: {
      label: 'pants', jobString: 'Tailoring', uiCategory: 'tailoring',
      workAmount: 600, skill: 'crafting',
      workbenches: ['tailoringBench'],
      ingredients: [{ thing: 'cloth', count: 30 }],
      products: { pants: 1 }, productQuality: true,
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Cheap, quick, and the first thing worth sewing.'
    },

    sewJacket: {
      label: 'jacket', jobString: 'Tailoring', uiCategory: 'tailoring',
      workAmount: 900, skill: 'crafting', skillRequirement: 3,
      workbenches: ['tailoringBench'],
      ingredients: [{ thing: 'cloth', count: 50 }, { thing: 'leather', count: 20 }],
      products: { jacket: 1 }, productQuality: true,
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Worn over a shirt. Buys a few degrees of cold before anyone starts ' +
        'shivering on the walk to the mine.'
    },

    sewParka: {
      label: 'parka', jobString: 'Tailoring', uiCategory: 'tailoring',
      workAmount: 1300, skill: 'crafting', skillRequirement: 5,
      workbenches: ['tailoringBench'],
      ingredients: [{ thing: 'cloth', count: 40 }, { thing: 'leather', count: 60 }],
      products: { parka: 1 }, productQuality: true,
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Heavy insulation for winter and for the boreal map. Miserable to ' +
        'wear in summer.'
    },

    sewArmorVest: {
      label: 'armor vest', jobString: 'Tailoring', uiCategory: 'tailoring',
      workAmount: 1200, skill: 'crafting', skillRequirement: 6,
      workbenches: ['tailoringBench'],
      /* The only sewing recipe with a metal cost: the plates are what stop a
         bullet, the cloth is only what holds them on. */
      ingredients: [{ thing: 'cloth', count: 45 }, { thing: 'steel', count: 25 }],
      products: { armorVest: 1 }, productQuality: true,
      researchPrerequisite: 'smithing',
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Steel plates over the torso. Turns a killing gunshot into a ' +
        'survivable one, which is most of what armour ever does.'
    },

    sewHelmet: {
      label: 'helmet', jobString: 'Tailoring', uiCategory: 'tailoring',
      workAmount: 600, skill: 'crafting', skillRequirement: 4,
      workbenches: ['tailoringBench'],
      ingredients: [{ thing: 'leather', count: 35 }],
      products: { helmet: 1 }, productQuality: true,
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Hardened leather over the skull. Cheap, and the head is where the ' +
        'unlucky shots land.'
    },

    /* ---- forging ---- */
    forgeKnife: {
      label: 'knife', jobString: 'Smithing', uiCategory: 'smithing',
      workAmount: 350, skill: 'crafting',
      workbenches: ['smithy'],
      ingredients: [{ thing: 'steel', count: 10 }],
      products: { knife: 1 }, productQuality: true,
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Fast and cheap. A knife beats bare hands by a wide margin and costs ' +
        'almost nothing to arm a colony with.'
    },

    forgeClub: {
      label: 'club', jobString: 'Smithing', uiCategory: 'smithing',
      workAmount: 250, skill: 'crafting',
      workbenches: ['smithy'],
      ingredients: [{ thing: 'wood', count: 10 }],
      products: { club: 1 }, productQuality: true,
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'A shaped length of wood. It bruises rather than cuts, so it downs ' +
        'raiders instead of killing them.'
    },

    forgeSpear: {
      label: 'spear', jobString: 'Smithing', uiCategory: 'smithing',
      workAmount: 400, skill: 'crafting', skillRequirement: 2,
      workbenches: ['smithy'],
      ingredients: [{ thing: 'wood', count: 15 }, { thing: 'steel', count: 5 }],
      products: { spear: 1 }, productQuality: true,
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Reach and a steel point. The best melee weapon available before ' +
        'anyone has researched anything.'
    },

    forgeShortBow: {
      label: 'short bow', jobString: 'Smithing', uiCategory: 'smithing',
      workAmount: 500, skill: 'crafting', skillRequirement: 2,
      workbenches: ['smithy'],
      ingredients: [{ thing: 'wood', count: 30 }],
      products: { shortBow: 1 }, productQuality: true,
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Silent, short-ranged, and made of nothing but wood. The whole colony ' +
        'can be shooting before the first raid.'
    },

    forgePistol: {
      label: 'pistol', jobString: 'Smithing', uiCategory: 'smithing',
      workAmount: 900, skill: 'crafting', skillRequirement: 4,
      workbenches: ['smithy'],
      ingredients: [{ thing: 'steel', count: 25 }, { thing: 'components', count: 2 }],
      products: { pistol: 1 }, productQuality: true,
      researchPrerequisite: 'firearms',
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Short range and quick to fire. A hunter will still prefer the bow; ' +
        'a defender will not.'
    },

    forgeBoltRifle: {
      label: 'bolt-action rifle', jobString: 'Smithing', uiCategory: 'smithing',
      workAmount: 1400, skill: 'crafting', skillRequirement: 6,
      workbenches: ['smithy'],
      ingredients: [{ thing: 'steel', count: 40 }, { thing: 'components', count: 3 }],
      products: { boltRifle: 1 }, productQuality: true,
      /* The pistol is the firearms payoff; the rifle is what the follow-up
         project buys, which is why it names advancedFirearms. */
      researchPrerequisite: 'advancedFirearms',
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'Long range, hard hitting, slow between shots. The rifle that lets a ' +
        'colony fight back across open ground.'
    }
  };

  Object.keys(RECIPES).forEach(function (id) {
    var r = RECIPES[id];
    r.ingredients.forEach(function (ing) { normalizeIngredient(ing, id); });
    r.accepts = accepts;
    /* Attached before the defaults pass, so only the recipes that declared a
       real base chance carry the scaler. */
    if (r.foodPoisonChance) r.foodPoisonChanceFor = foodPoisonChanceFor;
  });

  Defs.add('recipe', RECIPES, {
    jobString: 'Working', skill: null, skillRequirement: 0,
    workType: 'craft', uiCategory: 'crafting', workbenches: [],
    products: {}, dynamicProducts: false, productQuality: false,
    researchPrerequisite: null,
    defaultRepeat: 'forever', defaultTargetCount: 0, defaultIngredientRadius: 999,
    foodPoisonChance: 0, description: ''
  });
})(this);
