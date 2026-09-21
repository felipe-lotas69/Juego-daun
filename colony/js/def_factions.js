/* ============================================================
   def_factions.js - the world outside the map, as data.

   Four new def categories live here and nothing else does:
   factionKind (the template a civilization is generated from),
   settlementKind (one dot on the world map), traderKind (what a
   counter or a caravan carries) and worldBiome (the planet's bands).

   defs.js froze its category list before section 10 existed and is
   not ours to edit, so the first thing below teaches the existing
   registry four more tables. Everything after that is data: no
   behaviour, no runtime state. world.js lays the biomes out,
   factions.js rolls names and goodwill from the faction kinds,
   trade.js resolves the stock categories against real things.

   Two conventions run through the whole file:

   1. Every trade or stock category string comes from the
      Zones.CATEGORIES vocabulary. Nothing here names a thing def, so
      a faction that "sells weapons" stays correct when def_things.js
      gains another rifle.
   2. Names are patterns plus word lists, never finished strings. A
      pattern is filled by substituting {A}, {B} and {suffix} from the
      kind's nameWords, so factions.js and world.js roll a name with
      U.pick and never own a syllable of vocabulary.
   ============================================================ */
(function (root) {
  'use strict';

  var Defs = root.Defs;

  /* ------------------------------------------------------------------
     Teaching defs.js four more categories.

     defs.js keeps its tables in a closure, so there is no way in from
     out here; the smallest honest fix is a thin wrapper that holds the
     new tables itself and forwards everything it does not own to the
     original. It is installed once - a later file asking for another
     category reuses it - and reproduces defs.js's own registration
     semantics exactly (defaults merge, duplicate check, id/defCategory/
     label/defIndex stamping), so a def registered here is
     indistinguishable from one registered there.
     ------------------------------------------------------------------ */
  function extendDefs(categories) {
    var store = Defs._extraTables;

    if (!store) {
      store = Defs._extraTables = {};
      var base = {
        add: Defs.add, get: Defs.get, has: Defs.has, maybe: Defs.maybe, all: Defs.all,
        table: Defs.table, index: Defs.index, fromIndex: Defs.fromIndex,
        count: Defs.count, where: Defs.where
      };

      Defs.add = function (category, table, defaults) {
        var slot = store[category];
        if (!slot) return base.add(category, table, defaults);
        Object.keys(table).forEach(function (id) {
          var def = table[id];
          if (slot.table[id]) throw new Error('duplicate def ' + category + '/' + id);
          if (defaults) {
            Object.keys(defaults).forEach(function (k) {
              if (def[k] === undefined) def[k] = defaults[k];
            });
          }
          def.id = id;
          def.defCategory = category;
          if (def.label === undefined) def.label = id.replace(/([A-Z])/g, ' $1').toLowerCase();
          def.defIndex = slot.list.length;
          slot.table[id] = def;
          slot.list.push(def);
        });
        return table;
      };

      Defs.get = function (c, id) {
        var s = store[c];
        if (!s) return base.get(c, id);
        if (!s.table[id]) throw new Error('missing def ' + c + '/' + id);
        return s.table[id];
      };
      Defs.index = function (c, id) {
        var s = store[c];
        if (!s) return base.index(c, id);
        if (!s.table[id]) throw new Error('missing def ' + c + '/' + id);
        return s.table[id].defIndex;
      };
      Defs.has = function (c, id) { var s = store[c]; return s ? !!s.table[id] : base.has(c, id); };
      Defs.maybe = function (c, id) { var s = store[c]; return s ? (s.table[id] || null) : base.maybe(c, id); };
      Defs.all = function (c) { var s = store[c]; return s ? s.list : base.all(c); };
      Defs.table = function (c) { var s = store[c]; return s ? s.table : base.table(c); };
      Defs.count = function (c) { var s = store[c]; return s ? s.list.length : base.count(c); };
      Defs.fromIndex = function (c, i) { var s = store[c]; return s ? s.list[i] : base.fromIndex(c, i); };
      Defs.where = function (c, key, fn) {
        var s = store[c];
        if (!s) return base.where(c, key, fn);
        if (!s.cache[key]) s.cache[key] = s.list.filter(fn);
        return s.cache[key];
      };
    }

    categories.forEach(function (c) {
      if (store[c]) return;
      store[c] = { table: {}, list: [], cache: {} };
      if (Defs.CATEGORIES.indexOf(c) < 0) Defs.CATEGORIES.push(c);
    });
    return store;
  }

  extendDefs(['factionKind', 'settlementKind', 'traderKind', 'worldBiome']);

  /* The goods vocabulary, repeated here only so validateWorld() can say
     "that is not a category" instead of letting a typo become an empty
     trader three hours into a game. zones.js owns the real list. */
  var CATEGORIES = ['rawFood', 'meals', 'resources', 'stone', 'textiles',
    'medicine', 'weapons', 'apparel', 'chunks', 'manufactured'];

  /* ============================================================
     FACTION KINDS

     A kind is a recipe for a civilization, not a civilization: world
     gen picks kinds by `weight`, rolls a name from the patterns, a
     leader title from the list, a starting goodwill inside
     goodwillStart and settlementCount dots on the map.

     Goodwill is the whole relationship in one number, -100..100.
     Everyone crosses into war below -75 and into alliance above +40 -
     that rule belongs to factions.js - but how fast a kind gets there
     is its own personality: goodwillGainFactor and goodwillLossFactor
     scale every adjustment, so the empire notices a dead citizen far
     harder than it notices a generous gift, and the tribes forgive.

     raidPointsFactor scales the storyteller's threat points when this
     kind attacks: the same budget buys a bigger tribal mob and a
     smaller, nastier imperial strike force.
     ============================================================ */

  var FACTION_DEFAULTS = {
    permanentEnemy: false, canTrade: true, canAlly: true, techLevel: 'industrial',
    settlementCount: [1, 2], goodwillStart: [0, 20],
    goodwillGainFactor: 1, goodwillLossFactor: 1,
    goodwillDriftPerDay: 0.4,     /* pull back toward 0 when nothing happens */
    raidPointsFactor: 1,
    allyHelpChance: 0.35,         /* chance an ally answers a raid on you */
    weight: 1, raidStrategies: ['assault'], traderKinds: [], tradeCategories: [],
    leaderTitles: ['Leader']
  };

  Defs.add('factionKind', {

    outlanderUnion: {
      label: 'outlander union',
      description: 'Loosely federated frontier towns that got rich on shipping. They will sell you ' +
        'anything, take almost anything off your hands, and remember who paid on time.',
      techLevel: 'industrial', settlementCount: [1, 3], weight: 1.4,
      colorPrimary: '#4a7fd4', colorSecondary: '#8fb2ec',
      settlementKinds: ['town', 'village'],
      pawnKinds: { raider: ['raider'], trader: ['wanderer'], guard: ['raider'] },
      raidStrategies: ['assault', 'sappers'],
      goodwillStart: [5, 45], goodwillGainFactor: 1.15, goodwillLossFactor: 0.9,
      raidPointsFactor: 1, allyHelpChance: 0.5,
      traderKinds: ['bulkGoods', 'caravanMaster', 'combatSupplier'],
      tradeCategories: ['resources', 'rawFood', 'meals', 'textiles', 'medicine', 'apparel', 'manufactured'],
      namePatterns: ['The {A} {suffix}', '{A} {B} {suffix}', 'The {B} {suffix}', '{A} {suffix}'],
      nameWords: {
        A: ['Ustan', 'Vardo', 'Kessel', 'Morrow', 'Halden', 'Brennan', 'Corvin', 'Ashford', 'Nyland',
          'Tarsis', 'Delvin', 'Orwin', 'Pallas', 'Redmond', 'Gray', 'Iron', 'Northern', 'Free', 'New', 'Silver'],
        B: ['Hand', 'Star', 'Reach', 'Anvil', 'Gate', 'Shield', 'Crown', 'Harbour', 'Wheel', 'Furnace', 'Basin', 'Ridge'],
        suffix: ['Union', 'Confederacy', 'Alliance', 'Compact', 'League', 'Combine', 'Concord', 'Commonwealth']
      },
      leaderTitles: ['President', 'Chairman', 'Chairwoman', 'First Speaker', 'Director']
    },

    outlanderRepublic: {
      label: 'outlander republic',
      description: 'A proper government with a standing militia, a tax office and firm opinions ' +
        'about its borders. Better armed than the unions and considerably more prickly.',
      techLevel: 'industrial', settlementCount: [2, 4], weight: 1.1,
      colorPrimary: '#3f8f78', colorSecondary: '#8fd4bf',
      settlementKinds: ['town', 'village'],
      pawnKinds: { raider: ['raider'], trader: ['wanderer'], guard: ['raider'] },
      raidStrategies: ['assault', 'siege', 'sappers'],
      goodwillStart: [-15, 30], goodwillGainFactor: 0.9, goodwillLossFactor: 1.1,
      raidPointsFactor: 1.15, allyHelpChance: 0.55,
      traderKinds: ['bulkGoods', 'combatSupplier', 'caravanMaster'],
      tradeCategories: ['weapons', 'apparel', 'manufactured', 'medicine', 'resources', 'meals'],
      namePatterns: ['The {A} {suffix}', 'The {B} {suffix}', '{A} {B} {suffix}', 'Republic of {A}'],
      nameWords: {
        A: ['Verrin', 'Solace', 'Calder', 'Marrow', 'Ostvale', 'Karnish', 'Dunmor', 'Estrel',
          'Highmoor', 'Lorne', 'Crimson', 'Amber', 'Eastern', 'Second'],
        B: ['Provinces', 'Marches', 'Territories', 'Coast', 'Plains', 'Banner', 'Charter'],
        suffix: ['Republic', 'Free States', 'Directorate', 'Commonwealth', 'Council', 'Assembly', 'Federation']
      },
      leaderTitles: ['President', 'Prime Minister', 'Governor', 'Consul', 'Chancellor']
    },

    tribalClan: {
      label: 'tribal clan',
      description: 'Neolithic people who have lived here far longer than anyone with a ship. Many ' +
        'of them, spread thin, generous with food and short of everything else.',
      techLevel: 'neolithic', settlementCount: [2, 5], weight: 1.5,
      colorPrimary: '#b08c5a', colorSecondary: '#e0c08a',
      settlementKinds: ['tribalCamp'],
      pawnKinds: { raider: ['tribalRaider'], trader: ['wanderer'], guard: ['tribalRaider'] },
      raidStrategies: ['assault'],
      goodwillStart: [10, 55], goodwillGainFactor: 1.3, goodwillLossFactor: 0.85,
      goodwillDriftPerDay: 0.6,
      /* A tribal raid is a crowd of cheap spears, so the same threat budget
         has to buy more bodies than an industrial one does. */
      raidPointsFactor: 1.25, allyHelpChance: 0.45,
      traderKinds: ['tribalTrader', 'bulkGoods'],
      tradeCategories: ['rawFood', 'textiles', 'medicine', 'weapons', 'chunks'],
      namePatterns: ['Clan {A}', 'The {B} {suffix}', '{A} {suffix}', 'People of the {B}'],
      nameWords: {
        A: ['Mora', 'Anouk', 'Teshka', 'Karo', 'Vaska', 'Umbe', 'Nakha', 'Roha', 'Sereth', 'Ilka',
          'Otok', 'Pehra', 'Zamu', 'Tovak'],
        B: ['Wolf', 'River', 'Stone', 'Ash', 'Thorn', 'Moon', 'Elk', 'Fen', 'Rain', 'Hollow',
          'Antler', 'Ember', 'Reed', 'Bison'],
        suffix: ['Clan', 'Tribe', 'People', 'Kin', 'Folk', 'Circle']
      },
      leaderTitles: ['Chief', 'Elder', 'Headman', 'Matriarch', 'Shaman']
    },

    savageTribe: {
      label: 'savage tribe',
      description: 'A tribe that took the arrival of outsiders badly and never revised the opinion. ' +
        'They will still trade, once, if you can make it worth putting the spears down.',
      techLevel: 'neolithic', canAlly: false, settlementCount: [1, 3], weight: 0.9,
      colorPrimary: '#8a5a2b', colorSecondary: '#c08a4a',
      settlementKinds: ['tribalCamp'],
      pawnKinds: { raider: ['tribalRaider'], trader: ['wanderer'], guard: ['tribalRaider'] },
      raidStrategies: ['assault', 'siege'],
      goodwillStart: [-70, -15], goodwillGainFactor: 0.7, goodwillLossFactor: 1.2,
      goodwillDriftPerDay: 0.25, raidPointsFactor: 1.3, allyHelpChance: 0,
      traderKinds: ['tribalTrader'],
      tradeCategories: ['rawFood', 'textiles', 'chunks'],
      namePatterns: ['The {B} {suffix}', 'Clan {A}', 'The {A} {suffix}', '{A} {B} {suffix}'],
      nameWords: {
        A: ['Grok', 'Zhul', 'Varr', 'Skath', 'Ulm', 'Drega', 'Korth', 'Nask', 'Yarr', 'Ghaz'],
        B: ['Skull', 'Tooth', 'Bone', 'Scar', 'Carrion', 'Blood', 'Spike', 'Claw', 'Pyre', 'Cinder'],
        suffix: ['Tribe', 'Clan', 'Horde', 'Kin', 'Band', 'Marauders']
      },
      leaderTitles: ['War-Chief', 'Bonecaller', 'Blood-Speaker', 'Elder', 'Chief']
    },

    pirateBand: {
      label: 'pirate band',
      description: 'Industrial-age scavengers who make a living off other people. There is no ' +
        'negotiating and no counter to trade at, only the question of when they come.',
      techLevel: 'industrial', permanentEnemy: true, canTrade: false, canAlly: false,
      settlementCount: [1, 3], weight: 1.3,
      colorPrimary: '#c0392b', colorSecondary: '#7a1f16',
      settlementKinds: ['pirateOutpost'],
      pawnKinds: { raider: ['raider'], trader: [], guard: ['raider'] },
      raidStrategies: ['assault', 'sappers', 'siege'],
      /* Pinned at the floor with both factors at zero: nothing you do to a
         pirate band, kind or cruel, moves the number. */
      goodwillStart: [-100, -100], goodwillGainFactor: 0, goodwillLossFactor: 0,
      goodwillDriftPerDay: 0, raidPointsFactor: 1.1, allyHelpChance: 0,
      traderKinds: [], tradeCategories: [],
      namePatterns: ['{A} {B} {suffix}', 'The {B} {suffix}', "{A}'s {suffix}", 'The {A} {suffix}'],
      nameWords: {
        A: ['Kragg', 'Vex', 'Slate', 'Harrow', 'Dace', 'Mordo', 'Crane', 'Ryke', 'Talon', 'Sable',
          'Grim', 'Black', 'Red', 'Broken'],
        B: ['Fang', 'Hook', 'Chain', 'Vulture', 'Cinder', 'Wolf', 'Nail', 'Rat', 'Widow', 'Gallows',
          'Knife', 'Cutter'],
        suffix: ['Band', 'Gang', 'Pack', 'Crew', 'Syndicate', 'Raiders', 'Company']
      },
      leaderTitles: ['Boss', 'Captain', 'Warlord', 'Kingpin', 'The Butcher']
    },

    empire: {
      label: 'stellar empire',
      description: 'Spacer nobility with orbital manufacture and very long memories. Their goods are ' +
        'unmatched, their patience is not, and an insulted empire arrives with the good guns.',
      techLevel: 'spacer', settlementCount: [1, 2], weight: 0.8,
      colorPrimary: '#ffc23c', colorSecondary: '#6a4fb0',
      settlementKinds: ['empireSeat', 'town'],
      pawnKinds: { raider: ['raider'], trader: ['wanderer'], guard: ['raider'] },
      raidStrategies: ['assault', 'siege'],
      /* Proud and hard to please: praise is cheap to them, offence is not. */
      goodwillStart: [-10, 20], goodwillGainFactor: 0.55, goodwillLossFactor: 1.7,
      goodwillDriftPerDay: 0.2, raidPointsFactor: 1.6, allyHelpChance: 0.7,
      traderKinds: ['exotic', 'combatSupplier', 'caravanMaster'],
      tradeCategories: ['manufactured', 'medicine', 'weapons', 'apparel', 'meals'],
      namePatterns: ['The {A} {suffix}', 'The {B} {suffix}', 'The {A} {B}', '{A} {suffix}'],
      nameWords: {
        A: ['Auros', 'Celestia', 'Varenne', 'Solmara', 'Highmark', 'Astra', 'Vindrel', 'Thessaly',
          'Caelum', 'Ordwin'],
        B: ['Throne', 'Star', 'Crown', 'Sun', 'Spire', 'Diadem', 'Aegis'],
        suffix: ['Empire', 'Imperium', 'Dominion', 'Realm', 'Ascendancy']
      },
      leaderTitles: ['His Excellency', 'Her Excellency', 'Stellarch', 'Archduke', 'Archduchess', 'High Consul']
    }

  }, FACTION_DEFAULTS);

  /* ============================================================
     SETTLEMENT KINDS

     One dot on the world map. wealthRange is rolled once at world gen
     and is both what the place is worth raiding and roughly what it
     can afford to buy from you. stockCategories is what its counter
     restocks with every restockDays; marketRadius is how far its
     traders will walk, which is what makes a neighbour worth more than
     a settlement across an ocean. defenders and defenderCount are the
     garrison caravan.js resolves an attack against.
     ============================================================ */

  var SETTLEMENT_DEFAULTS = {
    canTradeWith: true, restockDays: 8, marketRadius: 8, defenderCount: [3, 6],
    namePatterns: ['{A}{suffix}', '{A} {B}'], nameWords: { A: [], B: [], suffix: [] }
  };

  Defs.add('settlementKind', {

    village: {
      label: 'village',
      description: 'A few dozen people, a well and a grain store. Buys food and cloth, sells what the fields gave up.',
      wealthRange: [800, 2600], color: '#a8b4c4', sprite: 'village',
      stockCategories: ['rawFood', 'meals', 'resources', 'textiles'],
      defenders: ['raider'], defenderCount: [2, 5],
      canTradeWith: true, restockDays: 8, marketRadius: 6,
      namePatterns: ['{A}{suffix}', '{A} {B}', 'New {A}{suffix}'],
      nameWords: {
        A: ['Ash', 'Bram', 'Cald', 'Dun', 'Eas', 'Fen', 'Har', 'Kel', 'Mor', 'Nor', 'Old', 'Pen', 'Red', 'Stor', 'Thorn', 'Wyn'],
        B: ['Crossing', 'Ford', 'Hollow', 'Mill', 'Well', 'Rest', 'Landing', 'Fields'],
        suffix: ['ford', 'ton', 'bury', 'stead', 'holm', 'wick', 'dale', 'gate']
      }
    },

    town: {
      label: 'town',
      description: 'A walled market town with warehouses and a garrison. The best counter most colonies will reach on foot.',
      wealthRange: [2600, 7500], color: '#c4ccd8', sprite: 'town',
      stockCategories: ['resources', 'manufactured', 'apparel', 'medicine', 'weapons', 'meals'],
      defenders: ['raider'], defenderCount: [5, 11],
      canTradeWith: true, restockDays: 6, marketRadius: 11,
      namePatterns: ['{A}{suffix}', '{A} {B}', 'Port {A}{suffix}'],
      nameWords: {
        A: ['Ard', 'Brenn', 'Corv', 'Drel', 'Estr', 'Gart', 'Hald', 'Kess', 'Lorn', 'Marr', 'Ost', 'Rav', 'Sold', 'Tars', 'Wend'],
        B: ['Reach', 'Harbour', 'Junction', 'Works', 'Yard', 'Bastion', 'Exchange'],
        suffix: ['burg', 'port', 'march', 'hold', 'ridge', 'vale', 'spire', 'gate']
      }
    },

    tribalCamp: {
      label: 'tribal camp',
      description: 'Hide tents around a cook fire, moved when the game moves. Poor in silver, rich in food and healroot.',
      wealthRange: [400, 1800], color: '#d2b184', sprite: 'camp',
      stockCategories: ['rawFood', 'textiles', 'medicine', 'weapons', 'chunks'],
      defenders: ['tribalRaider'], defenderCount: [4, 9],
      canTradeWith: true, restockDays: 10, marketRadius: 5,
      namePatterns: ['{A}{suffix}', '{A} {B}', '{B} Camp'],
      nameWords: {
        A: ['Ka', 'Ta', 'Mo', 'Ush', 'Nel', 'Ara', 'Vo', 'Zen', 'Hu', 'Ik'],
        B: ['Springs', 'Bend', 'Rocks', 'Hollow', 'Grove', 'Crossing', 'Reeds'],
        suffix: ['-ka', '-mesh', '-tuk', '-ara', '-nok', '-vash', '-eth']
      }
    },

    pirateOutpost: {
      label: 'pirate outpost',
      description: 'Scrap walls, a fuel dump and whatever they took last month. Nothing here is for sale.',
      wealthRange: [600, 3200], color: '#c0392b', sprite: 'outpost',
      stockCategories: ['weapons', 'apparel', 'resources', 'manufactured'],
      defenders: ['raider'], defenderCount: [4, 10],
      canTradeWith: false, restockDays: 14, marketRadius: 4,
      namePatterns: ['{A} {B}', 'The {B}', '{A}{suffix}'],
      nameWords: {
        A: ['Rust', 'Black', 'Broken', 'Dead', 'Salt', 'Cinder', 'Low', 'Hangman'],
        B: ['Yard', 'Nest', 'Pit', 'Roost', 'Anchorage', 'Den', 'Scrapheap'],
        suffix: ['hole', 'scrap', 'fall', 'wreck', 'cut']
      }
    },

    empireSeat: {
      label: 'imperial seat',
      description: 'A noble house with a landing field and a hundred kilometres of subjects. Nobody else here sells what it does.',
      wealthRange: [6000, 17000], color: '#ffc23c', sprite: 'palace',
      stockCategories: ['manufactured', 'medicine', 'weapons', 'apparel', 'meals', 'resources'],
      defenders: ['raider'], defenderCount: [8, 16],
      canTradeWith: true, restockDays: 5, marketRadius: 13,
      namePatterns: ['{A} {B}', '{A}{suffix}', 'The {B} of {A}'],
      nameWords: {
        A: ['Auros', 'Celest', 'Varen', 'Solmar', 'Astra', 'Vindre', 'Caelum', 'Ordwin'],
        B: ['Court', 'Seat', 'Palatine', 'Bastion', 'Crown', 'Observatory'],
        suffix: ['-on-High', ' Ascendant', ' Prime', '-in-Glory']
      }
    }

  }, SETTLEMENT_DEFAULTS);

  /* ============================================================
     TRADER KINDS

     What a caravan carries when it walks onto your map, and what a
     settlement's counter looks like from the outside.

     silverRange is how much the trader can actually pay before a deal
     stalls - the real ceiling on a big sale. `buys` is the categories
     they will take at all; anything outside it is worthless to them.
     In `sells`, countRange is how many DISTINCT thing kinds to roll
     out of that category, not how many units: trade.js picks the
     kinds, then sizes each pile from the trader's wealth and the
     thing's stack limit. priceFactor multiplies both directions
     before the negotiator's social skill and goodwill move it, and
     techLevels says which civilizations send this trader at all.
     ============================================================ */

  var TRADER_DEFAULTS = {
    priceFactor: 1, visitDays: 1.5, guardCount: [1, 3], pawnKindId: 'wanderer',
    techLevels: ['neolithic', 'medieval', 'industrial', 'spacer']
  };

  Defs.add('traderKind', {

    bulkGoods: {
      label: 'bulk goods trader',
      description: 'Carts of grain, timber and stone. Thin margins, deep pockets for the boring things nobody else will take.',
      silverRange: [900, 2000], priceFactor: 0.95, pawnKindId: 'wanderer',
      guardCount: [1, 3], visitDays: 1.5, techLevels: ['neolithic', 'industrial', 'spacer'],
      buys: ['rawFood', 'meals', 'resources', 'stone', 'textiles', 'chunks'],
      sells: [
        { category: 'rawFood', countRange: [2, 4] }, { category: 'resources', countRange: [2, 3] },
        { category: 'stone', countRange: [1, 2] }, { category: 'textiles', countRange: [1, 2] },
        { category: 'meals', countRange: [1, 2] }
      ]
    },

    combatSupplier: {
      label: 'combat supplier',
      description: 'Guns, armour and the medicine you need afterwards. Expensive, and the only way to out-arm the next raid.',
      silverRange: [1200, 2800], priceFactor: 1.15, pawnKindId: 'colonist',
      guardCount: [2, 4], visitDays: 1.25, techLevels: ['industrial', 'spacer'],
      buys: ['weapons', 'apparel', 'manufactured', 'medicine'],
      sells: [
        { category: 'weapons', countRange: [2, 4] }, { category: 'apparel', countRange: [1, 3] },
        { category: 'medicine', countRange: [1, 2] }, { category: 'manufactured', countRange: [1, 2] }
      ]
    },

    exotic: {
      label: 'exotic goods trader',
      description: 'Glitterworld medicine and components, carried by someone who knows what it is worth to a colony with nothing.',
      silverRange: [1800, 4000], priceFactor: 1.35, pawnKindId: 'wanderer',
      guardCount: [2, 4], visitDays: 1, techLevels: ['industrial', 'spacer'],
      buys: ['manufactured', 'medicine', 'apparel', 'weapons'],
      sells: [
        { category: 'medicine', countRange: [2, 3] }, { category: 'manufactured', countRange: [1, 3] },
        { category: 'apparel', countRange: [1, 2] }, { category: 'weapons', countRange: [1, 2] }
      ]
    },

    caravanMaster: {
      label: 'caravan master',
      description: 'A long train of pack animals carrying a little of everything. Slow, and worth emptying the stockpile for.',
      silverRange: [1400, 3200], priceFactor: 1.1, pawnKindId: 'colonist',
      guardCount: [2, 5], visitDays: 2, techLevels: ['neolithic', 'industrial', 'spacer'],
      buys: ['rawFood', 'meals', 'resources', 'stone', 'textiles', 'medicine', 'weapons',
        'apparel', 'chunks', 'manufactured'],
      sells: [
        { category: 'resources', countRange: [2, 3] }, { category: 'rawFood', countRange: [1, 3] },
        { category: 'textiles', countRange: [1, 2] }, { category: 'apparel', countRange: [1, 2] },
        { category: 'weapons', countRange: [1, 2] }, { category: 'medicine', countRange: [1, 2] }
      ]
    },

    tribalTrader: {
      label: 'tribal trader',
      description: 'Baskets of grain, hides and pounded healroot. Almost no silver, so a place to buy rather than a place to sell.',
      silverRange: [300, 1000], priceFactor: 0.9, pawnKindId: 'wanderer',
      guardCount: [1, 4], visitDays: 2.5, techLevels: ['neolithic'],
      buys: ['rawFood', 'textiles', 'chunks', 'resources', 'apparel'],
      sells: [
        { category: 'rawFood', countRange: [2, 4] }, { category: 'textiles', countRange: [1, 2] },
        { category: 'medicine', countRange: [1, 1] }, { category: 'weapons', countRange: [1, 2] }
      ]
    }

  }, TRADER_DEFAULTS);

  /* ============================================================
     WORLD BIOMES

     The planet is laid out in latitude bands with noise on top, so
     each biome states where it belongs rather than world.js holding a
     table of magic numbers:

       latitudeBand     |latitude|, 0 at the equator to 1 at a pole
       rainfallBand     the 0..1 wetness window it occupies there
       temperatureBand  average annual low/high in celsius, for the
                        tile readout and for World.season at that
                        latitude; `rainfall` is the band's midpoint

     travelCostFactor multiplies a caravan's days per tile - open
     grassland is quicker than rainforest, ice is punishing.
     settlementWeight is how attractive a tile is at world gen, and 0
     means nobody settles there. mapBiome is the handle
     MapGen.generate already understands, so landing on a desert tile
     generates an arid shrubland map; uninhabitable biomes still name
     one, because an ambush can put a map under you anywhere you walk.
     ============================================================ */

  var BIOME_DEFAULTS = {
    habitable: true, impassable: false, travelCostFactor: 1, settlementWeight: 1,
    animalDensity: 1, plantDensity: 1, mapBiome: 'temperateForest',
    latitudeBand: [0, 1], rainfallBand: [0, 1]
  };

  Defs.add('worldBiome', {

    temperateForest: {
      label: 'temperate forest',
      description: 'Mild, wooded and forgiving. Everything grows, everything hunts, and everyone with a choice settled here.',
      color: '#4e7a3a', travelCostFactor: 1, habitable: true, mapBiome: 'temperateForest',
      temperatureBand: [-8, 28], rainfall: 0.62, rainfallBand: [0.42, 0.78],
      latitudeBand: [0.28, 0.62], settlementWeight: 1.6, animalDensity: 1, plantDensity: 1
    },

    tropicalRainforest: {
      label: 'tropical rainforest',
      description: 'Hot, drenched and growing over everything, including the road you came in on. Rich land, miserable travelling.',
      color: '#2f6b32', travelCostFactor: 1.5, habitable: true, mapBiome: 'temperateForest',
      temperatureBand: [17, 36], rainfall: 0.92, rainfallBand: [0.7, 1],
      latitudeBand: [0, 0.22], settlementWeight: 0.7, animalDensity: 1.4, plantDensity: 1.5
    },

    grassland: {
      label: 'grassland',
      description: 'Open plains under a big sky. Easy walking, good grazing, and nothing at all to hide behind.',
      color: '#7d9a4a', travelCostFactor: 0.85, habitable: true, mapBiome: 'temperateForest',
      temperatureBand: [-4, 31], rainfall: 0.45, rainfallBand: [0.3, 0.55],
      latitudeBand: [0.2, 0.5], settlementWeight: 1.5, animalDensity: 1.2, plantDensity: 0.8
    },

    aridShrubland: {
      label: 'arid shrubland',
      description: 'Thin scrub over hard ground. Enough rain to farm if you are stubborn, not enough for a forest.',
      color: '#9d9350', travelCostFactor: 0.95, habitable: true, mapBiome: 'aridShrubland',
      temperatureBand: [2, 38], rainfall: 0.28, rainfallBand: [0.16, 0.34],
      latitudeBand: [0.12, 0.42], settlementWeight: 1.1, animalDensity: 0.8, plantDensity: 0.5
    },

    desert: {
      label: 'desert',
      description: 'Sand, stone and a sun that does not let up. People live here, but only where the water is.',
      color: '#c2b280', travelCostFactor: 1.2, habitable: true, mapBiome: 'aridShrubland',
      temperatureBand: [6, 46], rainfall: 0.08, rainfallBand: [0.03, 0.16],
      latitudeBand: [0.14, 0.38], settlementWeight: 0.45, animalDensity: 0.4, plantDensity: 0.18
    },

    extremeDesert: {
      label: 'extreme desert',
      description: 'Bare dune and salt pan. Nothing grows and nothing drinks; a caravan carries every mouthful it will need.',
      color: '#d8c18a', travelCostFactor: 1.6, habitable: false, mapBiome: 'aridShrubland',
      temperatureBand: [10, 52], rainfall: 0.01, rainfallBand: [0, 0.03],
      latitudeBand: [0.16, 0.34], settlementWeight: 0, animalDensity: 0.1, plantDensity: 0.02
    },

    borealForest: {
      label: 'boreal forest',
      description: 'Pine and long winters. Wood everywhere, a growing season you can count on one hand, hungry predators.',
      color: '#3e5f4a', travelCostFactor: 1.15, habitable: true, mapBiome: 'borealForest',
      temperatureBand: [-28, 22], rainfall: 0.55, rainfallBand: [0.35, 0.75],
      latitudeBand: [0.58, 0.8], settlementWeight: 0.9, animalDensity: 0.8, plantDensity: 0.85
    },

    tundra: {
      label: 'tundra',
      description: 'Frozen ground, moss and wind. A colony here lives indoors or does not live long.',
      color: '#8a927f', travelCostFactor: 1.3, habitable: true, mapBiome: 'borealForest',
      temperatureBand: [-38, 14], rainfall: 0.3, rainfallBand: [0.12, 0.6],
      latitudeBand: [0.76, 0.92], settlementWeight: 0.35, animalDensity: 0.45, plantDensity: 0.25
    },

    iceSheet: {
      label: 'ice sheet',
      description: 'Permanent ice from horizon to horizon. Nobody settles it and nobody crosses it without a very good reason.',
      color: '#dfe7ee', travelCostFactor: 2, habitable: false, mapBiome: 'borealForest',
      temperatureBand: [-55, -4], rainfall: 0.12, rainfallBand: [0, 1],
      latitudeBand: [0.9, 1], settlementWeight: 0, animalDensity: 0.08, plantDensity: 0
    },

    ocean: {
      label: 'ocean',
      description: 'Open water. No caravan on foot crosses it, which is what gives your neighbours their distance.',
      color: '#2f5d78', travelCostFactor: 0, habitable: false, impassable: true,
      mapBiome: 'temperateForest', temperatureBand: [-2, 26], rainfall: 1, rainfallBand: [0, 1],
      latitudeBand: [0, 1], settlementWeight: 0, animalDensity: 0, plantDensity: 0
    }

  }, BIOME_DEFAULTS);

  /* ------------------------------------------------------------------
     Accessors shaped like the ones defs.js gives its own categories,
     plus a cross-reference check. defs.js's REFS table was frozen
     before these categories existed, so Defs.validate() cannot see
     them; this covers the same ground for the four tables above and
     is what the test harness calls after loading.
     ------------------------------------------------------------------ */

  Defs.factionKind = function (id) { return Defs.get('factionKind', id); };
  Defs.settlementKind = function (id) { return Defs.get('settlementKind', id); };
  Defs.traderKind = function (id) { return Defs.get('traderKind', id); };
  Defs.worldBiome = function (id) { return Defs.get('worldBiome', id); };

  Defs.habitableBiomes = function () {
    return Defs.where('worldBiome', 'habitable', function (b) { return b.habitable && !b.impassable; });
  };
  Defs.tradingFactionKinds = function () {
    return Defs.where('factionKind', 'trading', function (k) { return k.canTrade; });
  };

  Defs.validateWorld = function () {
    var errors = [];
    var MAP_BIOMES = ['temperateForest', 'aridShrubland', 'borealForest'];

    function refs(where, ids, category) {
      (ids || []).forEach(function (id) {
        if (!Defs.has(category, id)) errors.push(where + ' -> missing ' + category + '/' + id);
      });
    }
    function cats(where, list) {
      (list || []).forEach(function (c) {
        var name = typeof c === 'string' ? c : c.category;
        if (CATEGORIES.indexOf(name) < 0) errors.push(where + ' -> unknown goods category: ' + name);
      });
    }

    Defs.all('factionKind').forEach(function (k) {
      var at = 'factionKind/' + k.id;
      refs(at + '.settlementKinds', k.settlementKinds, 'settlementKind');
      refs(at + '.traderKinds', k.traderKinds, 'traderKind');
      Object.keys(k.pawnKinds || {}).forEach(function (role) {
        refs(at + '.pawnKinds.' + role, k.pawnKinds[role], 'pawnKind');
      });
      cats(at + '.tradeCategories', k.tradeCategories);
      if (!k.leaderTitles.length) errors.push(at + ' has no leader titles');
      if (k.canTrade && !k.traderKinds.length) errors.push(at + ' can trade but sends no traders');
      if (!k.namePatterns.length) errors.push(at + ' cannot roll a name');
      k.namePatterns.forEach(function (p) {
        (p.match(/\{(\w+)\}/g) || []).forEach(function (slot) {
          var key = slot.slice(1, -1);
          if (!k.nameWords[key] || !k.nameWords[key].length) {
            errors.push(at + ' pattern "' + p + '" has no words for {' + key + '}');
          }
        });
      });
    });

    Defs.all('settlementKind').forEach(function (s) {
      var at = 'settlementKind/' + s.id;
      refs(at + '.defenders', s.defenders, 'pawnKind');
      cats(at + '.stockCategories', s.stockCategories);
      if (s.wealthRange[0] > s.wealthRange[1]) errors.push(at + ' has an inverted wealthRange');
    });

    Defs.all('traderKind').forEach(function (t) {
      var at = 'traderKind/' + t.id;
      refs(at + '.pawnKindId', [t.pawnKindId], 'pawnKind');
      cats(at + '.buys', t.buys);
      cats(at + '.sells', t.sells);
      if (t.silverRange[0] > t.silverRange[1]) errors.push(at + ' has an inverted silverRange');
    });

    Defs.all('worldBiome').forEach(function (b) {
      var at = 'worldBiome/' + b.id;
      if (MAP_BIOMES.indexOf(b.mapBiome) < 0) errors.push(at + ' mapBiome is not a MapGen biome: ' + b.mapBiome);
      if (b.habitable && b.impassable) errors.push(at + ' is habitable and impassable at once');
      if (b.temperatureBand[0] > b.temperatureBand[1]) errors.push(at + ' has an inverted temperatureBand');
    });

    if (!Defs.habitableBiomes().length) errors.push('no habitable biome to put a colony on');
    return errors;
  };

})(this);
