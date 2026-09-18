/* ============================================================
   defs.js - the def registry.

   Every piece of content in the game is a "def": a plain object in a
   table, registered here under a category. Nothing in the engine ever
   hard-codes a wall or a potato; it looks up a def and reads its fields.
   Adding content is a data edit, which is also why the whole thing can
   be validated in one pass (Defs.validate) before a colony ever ticks.
   ============================================================ */
(function (root) {
  'use strict';

  var CATEGORIES = [
    'terrain',    /* soil, sand, rock floor, constructed floors      */
    'thing',      /* items, buildings, plants, corpses, projectiles  */
    'recipe',     /* what a workbench can be told to make            */
    'research',   /* research projects                               */
    'trait',      /* pawn traits                                     */
    'backstory',  /* childhood/adulthood backstories                 */
    'skill',      /* the twelve skills                               */
    'workType',   /* the work columns in the Work tab                */
    'thought',    /* mood modifiers                                  */
    'body',       /* body part trees                                 */
    'pawnKind',   /* humans and animals                              */
    'mentalState',/* tantrum, daze, berserk...                       */
    'incident',   /* storyteller events                              */
    'faction'     /* player, raiders, wild animals...                */
  ];

  var tables = {};       /* category -> { id: def }   */
  var lists = {};        /* category -> [def] in registration order */
  var indexOf = {};      /* category -> { id: int }   stable, for typed arrays */

  CATEGORIES.forEach(function (c) { tables[c] = {}; lists[c] = []; indexOf[c] = {}; });

  var Defs = {};
  Defs.CATEGORIES = CATEGORIES;

  /* Register a table of defs. `defaults` is shallow-merged under each def,
     so a data file only states what is unusual about a thing. */
  Defs.add = function (category, table, defaults) {
    if (!tables[category]) throw new Error('unknown def category: ' + category);
    Object.keys(table).forEach(function (id) {
      var def = table[id];
      if (tables[category][id]) throw new Error('duplicate def ' + category + '/' + id);
      if (defaults) {
        Object.keys(defaults).forEach(function (k) {
          if (def[k] === undefined) def[k] = defaults[k];
        });
      }
      def.id = id;
      def.defCategory = category;
      if (def.label === undefined) def.label = id.replace(/([A-Z])/g, ' $1').toLowerCase();
      indexOf[category][id] = lists[category].length;
      def.defIndex = lists[category].length;
      tables[category][id] = def;
      lists[category].push(def);
    });
    return table;
  };

  Defs.get = function (category, id) {
    var d = tables[category] && tables[category][id];
    if (!d) throw new Error('missing def ' + category + '/' + id);
    return d;
  };
  Defs.has = function (category, id) { return !!(tables[category] && tables[category][id]); };
  Defs.maybe = function (category, id) { return (tables[category] && tables[category][id]) || null; };
  Defs.all = function (category) { return lists[category]; };
  Defs.table = function (category) { return tables[category]; };
  Defs.index = function (category, id) {
    var i = indexOf[category][id];
    if (i === undefined) throw new Error('missing def ' + category + '/' + id);
    return i;
  };
  Defs.fromIndex = function (category, i) { return lists[category][i]; };
  Defs.count = function (category) { return lists[category].length; };

  /* Convenience accessors - these are what the rest of the game calls. */
  Defs.thing = function (id) { return Defs.get('thing', id); };
  Defs.terrain = function (id) { return Defs.get('terrain', id); };
  Defs.recipe = function (id) { return Defs.get('recipe', id); };
  Defs.research = function (id) { return Defs.get('research', id); };
  Defs.trait = function (id) { return Defs.get('trait', id); };
  Defs.backstory = function (id) { return Defs.get('backstory', id); };
  Defs.skill = function (id) { return Defs.get('skill', id); };
  Defs.workType = function (id) { return Defs.get('workType', id); };
  Defs.thought = function (id) { return Defs.get('thought', id); };
  Defs.body = function (id) { return Defs.get('body', id); };
  Defs.pawnKind = function (id) { return Defs.get('pawnKind', id); };
  Defs.mentalState = function (id) { return Defs.get('mentalState', id); };
  Defs.incident = function (id) { return Defs.get('incident', id); };
  Defs.faction = function (id) { return Defs.get('faction', id); };

  /* Filtered views, cached after first use since defs never change at runtime. */
  var _cache = {};
  Defs.where = function (category, key, fn) {
    var ck = category + '/' + key;
    if (!_cache[ck]) _cache[ck] = lists[category].filter(fn);
    return _cache[ck];
  };
  Defs.items = function () {
    return Defs.where('thing', 'items', function (d) { return d.category === 'item'; });
  };
  Defs.buildings = function () {
    return Defs.where('thing', 'buildings', function (d) { return d.category === 'building'; });
  };
  Defs.plants = function () {
    return Defs.where('thing', 'plants', function (d) { return d.category === 'plant'; });
  };
  Defs.buildables = function () {
    return Defs.where('thing', 'buildables', function (d) {
      return (d.category === 'building' || d.category === 'terrain') && !!d.buildCategory;
    });
  };
  Defs.clearCache = function () { _cache = {}; };

  /* ------------------------------------------------------------------
     Reference integrity. Each entry says: for defs in <category>, the
     value(s) at <path> must name an existing def in <target>.
     Paths: 'a.b' walks objects, 'a[]' walks arrays, 'a{}' walks the KEYS
     of an object (that is how buildCost = {steel: 25} is checked).
     ------------------------------------------------------------------ */
  var REFS = [
    ['thing', 'buildCost{}', 'thing'],
    ['thing', 'costList{}', 'thing'],
    ['thing', 'recipes[]', 'recipe'],
    ['thing', 'researchPrerequisite', 'research'],
    ['thing', 'plant.harvestedThing', 'thing'],
    ['thing', 'butcherProducts{}', 'thing'],
    ['thing', 'leavings{}', 'thing'],
    ['recipe', 'ingredients[].thing', 'thing'],
    ['recipe', 'products{}', 'thing'],
    ['recipe', 'skill', 'skill'],
    ['recipe', 'researchPrerequisite', 'research'],
    ['research', 'prerequisites[]', 'research'],
    ['pawnKind', 'body', 'body'],
    ['pawnKind', 'butcherProducts{}', 'thing'],
    ['pawnKind', 'weapons[]', 'thing'],
    ['pawnKind', 'apparel[]', 'thing'],
    ['workType', 'skills[]', 'skill'],
    ['backstory', 'disabledWork[]', 'workType'],
    ['backstory', 'skillGains{}', 'skill'],
    ['trait', 'disabledWork[]', 'workType'],
    ['trait', 'skillGains{}', 'skill'],
    ['mentalState', 'thought', 'thought']
  ];

  function walk(value, path, out) {
    if (value === null || value === undefined) return;
    if (!path.length) { out.push(value); return; }
    var step = path[0], rest = path.slice(1);
    if (step.slice(-2) === '[]') {
      var arr = step === '[]' ? value : value[step.slice(0, -2)];
      if (!arr) return;
      for (var i = 0; i < arr.length; i++) walk(arr[i], rest, out);
    } else if (step.slice(-2) === '{}') {
      var obj = step === '{}' ? value : value[step.slice(0, -2)];
      if (!obj) return;
      Object.keys(obj).forEach(function (k) { out.push(k); });
    } else {
      walk(value[step], rest, out);
    }
  }

  Defs.validate = function () {
    var errors = [];
    REFS.forEach(function (ref) {
      var category = ref[0], path = ref[1].split('.'), target = ref[2];
      lists[category].forEach(function (def) {
        var found = [];
        walk(def, path, found);
        found.forEach(function (v) {
          if (typeof v !== 'string') {
            errors.push(category + '/' + def.id + ' ' + ref[1] + ' is not a def id: ' + JSON.stringify(v));
          } else if (!Defs.has(target, v)) {
            errors.push(category + '/' + def.id + ' ' + ref[1] + ' -> missing ' + target + '/' + v);
          }
        });
      });
    });

    /* Category-level sanity that a reference check cannot see. */
    lists.thing.forEach(function (d) {
      if (!d.category) errors.push('thing/' + d.id + ' has no category');
      if (d.category === 'item' && !d.stackLimit) errors.push('thing/' + d.id + ' item with no stackLimit');
      if (d.buildCategory && !d.workToBuild) errors.push('thing/' + d.id + ' is buildable but has no workToBuild');
      if (d.plant && !d.plant.growDays) errors.push('thing/' + d.id + ' plant with no growDays');
    });
    lists.terrain.forEach(function (d) {
      if (d.pathCost === undefined) errors.push('terrain/' + d.id + ' has no pathCost');
    });
    if (lists.terrain.length > 255) errors.push('more than 255 terrains will not fit the Uint8 grid');
    return errors;
  };

  root.Defs = Defs;
})(this);
