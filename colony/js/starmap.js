/* ============================================================
   starmap.js - leaving the planet.

   The endgame the whole colony points at, in five layers that can
   each be reached on their own:

     1. the cluster   - a handful of star systems generated from the
                        game seed, each with planets you could go to
                        and a description of what is known and what is
                        only rumoured about them.
     2. the ship      - eight kinds of part, every one a research
                        project and a buildable, that have to end up
                        bolted into ONE connected structure.
     3. the launch    - fuel measured in thousands of chemfuel, an
                        ignition sequence that takes days and calls
                        every hostile thing on the planet down on you,
                        and caskets that decide who is aboard.
     4. the arrival   - a new world and a new colony map, carrying the
                        colonists who travelled and very little else.
     5. the rungs     - an escape shuttle and an orbital trade platform,
                        so the space tree is not all-or-nothing.

   Nothing here edits a file it does not own. Content goes in through
   Defs.add, behaviour through Jobs.register and WorkGivers.register,
   incidents through Incidents.register on the first tick (events.js
   loads below this file, so it cannot be touched at load time).

   The one genuinely dangerous operation in here is Starmap.arrive:
   it throws away the map, the world and the civilizations on it and
   builds new ones under a running Game. It is written as a single
   ordered function with every step guarded, and it refuses to start
   unless it can finish.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Everything above starmap.js in the load order may be bound now.
     Game, Save, Incidents and Storyteller load below it and are looked
     up by name at tick time. */
  var T = root.T, Res = root.Res, Jobs = root.Jobs, Toils = root.Toils;
  var Path = root.Path, WorkGivers = root.WorkGivers;

  function sys(name) { return root[name] || null; }
  function G() { return root.Game || null; }
  function now() {
    var g = G();
    return (g && typeof g.tick === 'number') ? g.tick : 0;
  }
  function msg(text, type, at) {
    var g = G();
    if (g && g.msg) g.msg(text, { type: type || 'info', x: at ? at.x : undefined, y: at ? at.y : undefined });
  }
  function letter(title, text, kind, at) {
    var g = G();
    if (g && g.letter) g.letter(title, text, { kind: kind || 'neutral', x: at ? at.x : undefined, y: at ? at.y : undefined });
    else msg(title, kind);
  }

  var TICKS_PER_DAY = 60000;
  var SLOW = 500;                 /* the beat game.js calls tickLaunch on */

  var Starmap = {};

  /* ============================================================
     1. CONTENT

     Registered additively into categories defs.js already knows.
     def_things.js keeps its field templates private, so the shapes
     are restated here; every consumer reads these fields without a
     guard, which is why all of them have to be present.
     ============================================================ */

  var BUILDING_BLOCK = {
    isBed: false, isTable: false, isChair: false, isWorkbench: false,
    isDoor: false, isGrave: false, isTurret: false, isBattery: false,
    isConduit: false, isLamp: false, isGenerator: false, isResearchBench: false,
    isStove: false, isCampfire: false, isTrap: false, isSandbag: false,
    powerProduced: 0, powerConsumed: 0, batteryCapacity: 0, lightRadius: 0,
    tempPushTarget: null, tempPushRate: 0,
    bedRestEffectiveness: 0, bedComfort: 0, canBeForPrisoners: false,
    fuelDefId: null, fuelCapacity: 0, fuelBurnPerDay: 0,
    turretRange: 0, turretWeapon: null, interactionOffset: null,
    openTicks: 0
  };

  function bld(o) {
    var out = {}, k;
    for (k in BUILDING_BLOCK) out[k] = BUILDING_BLOCK[k];
    if (o) for (k in o) out[k] = o[k];
    return out;
  }

  var ITEM_DEFAULTS = {
    category: 'item', description: '',
    sprite: 'item', color: '#b0b0b8', color2: null,
    stackLimit: 75, mass: 0.5, marketValue: 1,
    nutrition: 0, foodType: null, rotDays: null,
    isMedicine: false, medicinePotency: 0,
    passable: true, pathCost: 0, fillPercent: 0, blocksLight: false, holdsRoof: false,
    size: { w: 1, h: 1 }, rotatable: false, hp: 60, flammable: false,
    beauty: 0, comfort: 0, natural: false,
    buildCost: null, stuffable: false, workToBuild: 0, buildSkill: null,
    buildCategory: null, researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null,
    building: null, weapon: null, apparel: null
  };

  var BUILDING_DEFAULTS = (function () {
    var out = {}, k;
    for (k in ITEM_DEFAULTS) out[k] = ITEM_DEFAULTS[k];
    out.category = 'building'; out.sprite = 'box'; out.stackLimit = 1;
    out.mass = 60; out.marketValue = 0; out.hp = 260;
    out.passable = false; out.fillPercent = 1; out.blocksLight = true;
    out.holdsRoof = true; out.buildSkill = 'construction';
    out.building = bld({});
    return out;
  })();

  Defs.add('research', {

    biofuelRefining: {
      label: 'biofuel refining', cost: 1600, techLevel: 'industrial', tab: 'advanced',
      description: 'A cracking column that turns cellulose into chemfuel. Nothing leaves ' +
        'this planet without it, and a forest is suddenly a fuel depot.',
      prerequisites: ['machining'],
      unlocks: ['biofuelRefinery', 'refineChemfuel'],
      uiPosition: { x: 2, y: 6 }
    },

    shipStructural: {
      label: 'ship structural', cost: 3200, techLevel: 'spacer', tab: 'ship',
      description: 'Load paths, spars and plate. The frame does nothing by itself, which ' +
        'is exactly why it is the first thing you build and the last thing you finish.',
      prerequisites: ['machining'],
      unlocks: ['shipBeam', 'shipHull'],
      uiPosition: { x: 3, y: 8 }
    },

    cryptosleep: {
      label: 'cryptosleep', cost: 2800, techLevel: 'spacer', tab: 'ship',
      description: 'Cold, glycerol and a heartbeat every four minutes. A voyage measured ' +
        'in decades becomes a bad night\'s sleep, for anyone who fits in a casket.',
      prerequisites: ['machining'],
      unlocks: ['shipCasket'],
      uiPosition: { x: 3, y: 9 }
    },

    shipReactorTech: {
      label: 'ship reactor', cost: 5400, techLevel: 'spacer', tab: 'ship',
      description: 'A fusion pile small enough to bolt to a spar. It will run your colony ' +
        'as a side effect, which is the only consolation for what it costs.',
      prerequisites: ['shipStructural', 'batteries'],
      unlocks: ['shipReactor', 'shipFuelTank'],
      uiPosition: { x: 4, y: 8 }
    },

    shipEngineTech: {
      label: 'ship engine', cost: 5800, techLevel: 'spacer', tab: 'ship',
      description: 'A plasma throat and the plumbing to feed it. One engine will not lift ' +
        'a ship of any size, which is the whole problem with building a big one.',
      prerequisites: ['shipReactorTech'],
      unlocks: ['shipEngine'],
      uiPosition: { x: 5, y: 8 }
    },

    shipComputing: {
      label: 'ship computer core', cost: 5000, techLevel: 'spacer', tab: 'ship',
      description: 'Something has to fly the ship while everyone aboard is frozen solid. ' +
        'It is not a luxury; it is the crew.',
      prerequisites: ['shipStructural'],
      unlocks: ['shipComputerCore'],
      uiPosition: { x: 4, y: 9 }
    },

    shipSensors: {
      label: 'ship sensor cluster', cost: 3800, techLevel: 'spacer', tab: 'ship',
      description: 'Interferometry good enough to turn a rumour about a distant world ' +
        'into a number you can point an engine at.',
      prerequisites: ['shipComputing'],
      unlocks: ['shipSensorCluster'],
      uiPosition: { x: 5, y: 9 }
    },

    escapeShuttleTech: {
      label: 'escape shuttle', cost: 2200, techLevel: 'spacer', tab: 'ship',
      description: 'One suborbital hop, three seats, no second flight. When the colony is ' +
        'lost, it is the difference between three survivors and none.',
      prerequisites: ['machining'],
      unlocks: ['escapeShuttle'],
      uiPosition: { x: 3, y: 10 }
    },

    orbitalTrade: {
      label: 'orbital trade platform', cost: 3000, techLevel: 'spacer', tab: 'ship',
      description: 'A transmitter and a docking clamp on a mast. Ships that would never ' +
        'have landed will deal with you, and they pay to park.',
      prerequisites: ['shipComputing'],
      unlocks: ['orbitalPlatform'],
      uiPosition: { x: 5, y: 10 }
    }

  });

  Defs.add('thing', {

    biofuelRefinery: {
      label: 'biofuel refinery', sprite: 'smithy', color: '#4a5240', color2: '#ffc23c',
      description: 'Wood in one end, chemfuel out the other. Slow, thirsty for power, and ' +
        'the only thing standing between your ship and a very long walk.',
      size: { w: 2, h: 2 }, rotatable: true, hp: 240, mass: 160,
      buildCost: { steel: 120, components: 4 }, workToBuild: 2600,
      buildCategory: 'production', researchPrerequisite: 'biofuelRefining',
      beauty: -2,
      building: bld({ isWorkbench: true, powerConsumed: 250, interactionOffset: { dx: 0, dy: 2 } })
    },

    shipBeam: {
      label: 'ship structural beam', sprite: 'wall', color: '#6e7480', color2: '#9aa3b0',
      description: 'A spar. Every other ship part has to reach the reactor through these, ' +
        'so a beautiful engine bolted to nothing is scrap.',
      hp: 300, mass: 40, marketValue: 40,
      buildCost: { steel: 30 }, workToBuild: 900,
      buildCategory: 'ship', researchPrerequisite: 'shipStructural',
      building: bld({})
    },

    shipHull: {
      label: 'ship hull plate', sprite: 'wall', color: '#7d8492', color2: '#c4ccd8',
      description: 'Plate, foam and a vapour barrier. Vacuum on one side of it, your ' +
        'colonists on the other, for however long the voyage turns out to be.',
      hp: 340, mass: 55, marketValue: 55,
      buildCost: { steel: 40, components: 1 }, workToBuild: 1100,
      buildCategory: 'ship', researchPrerequisite: 'shipStructural',
      building: bld({})
    },

    shipReactor: {
      label: 'ship reactor', sprite: 'battery', color: '#3d4a5c', color2: '#6fd0e0',
      description: 'A fusion pile with a ship bolted around it. It powers the colony from ' +
        'the day it lights, and everything aboard dies the day it does not.',
      size: { w: 3, h: 3 }, rotatable: false, hp: 700, mass: 900, marketValue: 1800,
      buildCost: { steel: 350, components: 30 }, workToBuild: 11000,
      buildCategory: 'ship', researchPrerequisite: 'shipReactorTech',
      beauty: -4,
      building: bld({ isGenerator: true, powerProduced: 4000, lightRadius: 4 })
    },

    shipEngine: {
      label: 'ship engine', sprite: 'generator', color: '#4a4a52', color2: '#ff8c1a',
      description: 'A plasma throat, a magnetic bell and a fuel line. One of these lifts ' +
        'about two and a half tonnes; count your tonnes before you count your engines.',
      size: { w: 2, h: 3 }, rotatable: true, hp: 520, mass: 600, marketValue: 1200,
      buildCost: { steel: 220, components: 16 }, workToBuild: 8000,
      buildCategory: 'ship', researchPrerequisite: 'shipEngineTech',
      beauty: -3,
      building: bld({})
    },

    shipCasket: {
      label: 'cryptosleep casket', sprite: 'bed', color: '#5a6675', color2: '#8fd0c0',
      description: 'One colonist, frozen, for as long as the crossing takes. Anyone not ' +
        'inside one when the engines light is staying here.',
      size: { w: 1, h: 2 }, rotatable: true, hp: 240, mass: 120, marketValue: 400,
      buildCost: { steel: 70, components: 4 }, workToBuild: 2600,
      buildCategory: 'ship', researchPrerequisite: 'cryptosleep',
      beauty: -1,
      building: bld({ interactionOffset: { dx: 0, dy: 2 } })
    },

    shipComputerCore: {
      label: 'ship computer core', sprite: 'research', color: '#3a4a6a', color2: '#6fa8dc',
      description: 'It flies the ship. Nobody aboard will be awake to argue with it, which ' +
        'is either reassuring or not, depending on the colonist.',
      size: { w: 2, h: 2 }, rotatable: false, hp: 420, mass: 400, marketValue: 1400,
      buildCost: { steel: 160, components: 24 }, workToBuild: 9000,
      buildCategory: 'ship', researchPrerequisite: 'shipComputing',
      beauty: -1,
      building: bld({ powerConsumed: 400 })
    },

    shipSensorCluster: {
      label: 'ship sensor cluster', sprite: 'turbine', color: '#4a5a52', color2: '#c9e0d0',
      description: 'Dishes and a long baseline. Every hour it runs, a rumour about some ' +
        'distant world turns into a fact you can plan around.',
      size: { w: 2, h: 2 }, rotatable: false, hp: 320, mass: 250, marketValue: 900,
      buildCost: { steel: 130, components: 18 }, workToBuild: 6500,
      buildCategory: 'ship', researchPrerequisite: 'shipSensors',
      beauty: 1,
      building: bld({ powerConsumed: 250 })
    },

    shipFuelTank: {
      label: 'ship fuel tank', sprite: 'battery', color: '#5c5648', color2: '#ffc23c',
      description: 'Four hundred and fifty units of chemfuel, and a hauler\'s afternoon ' +
        'to fill it. Count how many you need before you build the engines.',
      size: { w: 2, h: 2 }, rotatable: false, hp: 300, mass: 300, marketValue: 500,
      buildCost: { steel: 130, components: 5 }, workToBuild: 4200,
      buildCategory: 'ship', researchPrerequisite: 'shipReactorTech',
      flammable: true, beauty: -2,
      building: bld({ fuelDefId: 'chemfuel', fuelCapacity: 450, interactionOffset: { dx: 0, dy: 2 } })
    },

    escapeShuttle: {
      label: 'escape shuttle', sprite: 'box', color: '#6b7280', color2: '#c0392b',
      description: 'Three seats, one burn, no way back. It is not an escape from the ' +
        'planet; it is an escape from this part of it.',
      size: { w: 3, h: 3 }, rotatable: false, hp: 400, mass: 500, marketValue: 900,
      buildCost: { steel: 200, components: 12 }, workToBuild: 5200,
      buildCategory: 'ship', researchPrerequisite: 'escapeShuttleTech',
      beauty: -2,
      building: bld({ interactionOffset: { dx: 1, dy: 3 } })
    },

    orbitalPlatform: {
      label: 'orbital trade platform', sprite: 'turbine', color: '#4a4a5c', color2: '#ffc23c',
      description: 'A mast, a transmitter and a docking clamp. Ships that would never have ' +
        'come down to your mud will deal with you, and they pay for the berth.',
      size: { w: 2, h: 2 }, rotatable: false, hp: 340, mass: 280, marketValue: 1100,
      buildCost: { steel: 150, components: 14 }, workToBuild: 6000,
      buildCategory: 'ship', researchPrerequisite: 'orbitalTrade',
      beauty: 2,
      building: bld({ powerConsumed: 400, lightRadius: 3 })
    }

  }, BUILDING_DEFAULTS);

  Defs.add('recipe', {
    refineChemfuel: {
      label: 'chemfuel', jobString: 'Refining chemfuel', uiCategory: 'refining',
      workAmount: 700, skill: 'crafting', workType: 'craft',
      workbenches: ['biofuelRefinery'],
      ingredients: [{ thing: 'wood', count: 50 }],
      products: { chemfuel: 35 },
      researchPrerequisite: 'biofuelRefining',
      defaultRepeat: 'untilHave', defaultTargetCount: 300,
      description: 'Fifty wood cracked down to thirty-five chemfuel. A launch wants ' +
        'thousands of it, so start early and plant trees.'
    }
  }, {
    jobString: 'Working', skill: null, skillRequirement: 0,
    workType: 'craft', uiCategory: 'refining', workbenches: [],
    products: {}, dynamicProducts: false, productQuality: false,
    researchPrerequisite: null,
    defaultRepeat: 'forever', defaultTargetCount: 0, defaultIngredientRadius: 999,
    foodPoisonChance: 0, description: ''
  });

  Defs.add('thought', {
    shipCountdownDread: {
      label: 'The reactor is screaming', durationDays: 1, stackLimit: 1,
      stages: [{ label: 'The reactor is screaming and they are coming', mood: -0.06 }]
    },
    shipAboard: {
      label: 'Aboard at last', durationDays: 1, stackLimit: 1,
      stages: [{ label: 'Aboard at last', mood: 0.10 }]
    },
    shipLeftBehind: {
      label: 'They left without me', durationDays: 20, stackLimit: 1,
      stages: [{ label: 'They left without me', mood: -0.22 }]
    },
    shipLeftFriends: {
      label: 'We left people behind', durationDays: 12, stackLimit: 3,
      nullifiedByTrait: ['psychopath'],
      stages: [{ label: 'We left someone on that planet', mood: -0.11 }]
    },
    shipLaunched: {
      label: 'We got off that rock', durationDays: 12, stackLimit: 1,
      stages: [{ label: 'We got off that rock', mood: 0.16 }]
    },
    landfallNewWorld: {
      label: 'A whole new world', durationDays: 8, stackLimit: 1,
      stages: [{ label: 'A whole new world under our boots', mood: 0.09 }]
    },
    landfallGrim: {
      label: 'We crossed the dark for this', durationDays: 8, stackLimit: 1,
      stages: [{ label: 'We crossed the dark for this', mood: -0.09 }]
    }
  });

  /* Two conditions this file owns outright. health.js exposes its table
     for exactly this, the way drugs.js extends it; both decay on their
     own through a negative severityPerDay and are topped up from the
     planet rules below. */
  (function addHediffs() {
    var H = root.Health;
    if (!H || !H.HEDIFFS) return;
    if (!H.HEDIFFS.toxicBuildup) {
      H.HEDIFFS.toxicBuildup = {
        id: 'toxicBuildup', label: 'toxic buildup', lethal: true, driven: true,
        severityPerDay: -0.10, painOffset: 0.10,
        capMods: { consciousness: -0.35, moving: -0.25, manipulation: -0.20 },
        deathCause: 'toxic buildup'
      };
    }
    if (!H.HEDIFFS.cryptosleepSickness) {
      H.HEDIFFS.cryptosleepSickness = {
        id: 'cryptosleepSickness', label: 'cryptosleep sickness', lethal: false, driven: true,
        severityPerDay: -1.1, painOffset: 0.03,
        capMods: { consciousness: -0.20, moving: -0.15, manipulation: -0.15 }
      };
    }
  })();

  /* ============================================================
     2. THE CLUSTER

     Generated from the game seed, and regenerated whenever the seed
     changes - which is what a new colony and an arrival on a new
     planet both look like from in here.

     Generation borrows the shared stream and puts it back exactly as
     it found it, so where the cluster is built has no effect on any
     other roll in the simulation.
     ============================================================ */

  var PLANET_TYPES = {
    rimworld: {
      label: 'rimworld', biome: 'temperateForest', tempOffset: 0, mountainous: true,
      difficulty: 1.0, mapSize: 140,
      blurb: 'Breathable, green, and already spoken for by somebody with guns.',
      known: ['Oxygen-nitrogen atmosphere, near enough to breathe.',
              'A growing season that runs most of the year.',
              'Free water on the surface.'],
      rumours: ['Somebody is already down there and they are not friendly.',
                'The last survey ship that went did not come back.']
    },
    frozen: {
      label: 'ice world', biome: 'borealForest', tempOffset: -26, mountainous: true,
      difficulty: 1.35, mapSize: 140, noGrowing: true,
      blurb: 'White from pole to pole. Nothing grows outside, ever.',
      known: ['Mean surface temperature well below freezing all year.',
              'No growing period at all: food comes from indoors or from a ship.',
              'Deep ice over rock - drilling finds metal.'],
      rumours: ['Something walks across the ice between the old survey markers.',
                'There is a wrecked hauler under the ice with its cargo intact.']
    },
    volcanic: {
      label: 'volcanic world', biome: 'aridShrubland', tempOffset: 22, mountainous: true,
      difficulty: 1.45, mapSize: 130, ashfall: true,
      blurb: 'Young crust, thin air, and ash falling for a year after every vent opens.',
      known: ['Surface heat that will cook an unroofed colonist in summer.',
              'Ash falls often enough to start fires in anything dry.',
              'Metal at the surface, cheap to mine.'],
      rumours: ['The vents move. The maps are all out of date.',
                'Somebody made a fortune here and nobody knows what happened to them.']
    },
    toxic: {
      label: 'toxic world', biome: 'aridShrubland', tempOffset: 6, mountainous: false,
      difficulty: 1.55, mapSize: 130, toxic: true,
      blurb: 'The air is a slow poison. You live in sealed rooms or you do not live.',
      known: ['Atmospheric toxins build up in anyone who stays outdoors.',
              'A roof over your head is the difference between a colony and a graveyard.',
              'Almost no large animals survived whatever happened here.'],
      rumours: ['It was not always like this, and somebody made it this way.',
                'There is a sealed arcology out there with the lights still on.']
    },
    ocean: {
      label: 'ocean world', biome: 'temperateForest', tempOffset: 6, mountainous: false,
      difficulty: 1.15, mapSize: 140, flooded: true,
      blurb: 'Warm, wet and mostly water. The land you get is the land you get.',
      known: ['Shallow seas across nine tenths of the surface.',
              'A mild, wet climate and a long growing season on what land there is.',
              'Buildable ground is scarce and worth fighting over.'],
      rumours: ['The tides are wrong for the moons it has.',
                'Something big moves under the shallows.']
    },
    dead: {
      label: 'dead world', biome: 'aridShrubland', tempOffset: -6, mountainous: true,
      difficulty: 1.25, mapSize: 140, noWildlife: true, ruins: 'stone',
      blurb: 'It had a civilization. It has ruins, and nothing alive bigger than a seed.',
      known: ['No surviving animal life of any size.',
              'Standing ruins everywhere, and everything in them is yours.',
              'Breathable air, thin but sufficient.'],
      rumours: ['Whatever killed everything here may still be in the ruins.',
                'The ruins are laid out wrong, as though built for something taller.']
    },
    glitterworld: {
      label: 'glitterworld', biome: 'temperateForest', tempOffset: 2, mountainous: false,
      difficulty: 0.55, mapSize: 140, ruins: 'steel',
      blurb: 'Clean water, warm law, and a docking fee you almost certainly cannot pay.',
      known: ['A terraformed, managed climate.',
              'Functioning law, medicine and food.',
              'They do not take refugees who arrive uninvited.'],
      rumours: ['A rimworld ship that lands unannounced is a rimworld ship that is shot down.',
                'The ones who make it through the screening never write home.']
    },
    station: {
      label: 'derelict station', biome: 'aridShrubland', tempOffset: -12, mountainous: true,
      difficulty: 1.30, mapSize: 90, noWildlife: true, ruins: 'steel', airless: true,
      blurb: 'A habitat nobody has answered from in two hundred years. It is still turning.',
      known: ['Pressurised volume, if you can seal it again.',
              'Steel and components in the structure itself.',
              'No soil, no weather, and nothing alive aboard.'],
      rumours: ['The reactor is still hot, which means somebody kept it fed.',
                'The last log entry is a list of names with half of them crossed out.']
    }
  };

  var STAR_PREFIX = ['Cass', 'Vel', 'Mor', 'Ilias', 'Tarn', 'Oberon', 'Sel', 'Hask', 'Dray',
                     'Ember', 'Kova', 'Nis', 'Ald', 'Perrin', 'Yaw', 'Cinder', 'Halv', 'Rho'];
  var STAR_SUFFIX = ['ara', 'is', 'on', 'eth', 'ium', 'ara', 'ick', 'orne', 'ay', 'us',
                     'ine', 'ov', 'ara', 'el', 'ash'];
  var PLANET_NAMES = ['Gallow', 'Tiller', 'Quiet', 'Harrow', 'Meadow', 'Bastion', 'Lament',
                      'Providence', 'Salvage', 'Winter', 'Clement', 'Thorn', 'Verity', 'Kettle',
                      'Longshore', 'Candle', 'Marrow', 'Hollow', 'Oath', 'Rime'];
  var ROMAN = ['I', 'II', 'III', 'IV', 'V'];

  /* Every type appears at least once, in this order, before the
     generator is allowed to repeat itself. A cluster with no ice world
     in it would quietly delete a third of this file. */
  var TYPE_ORDER = ['rimworld', 'frozen', 'dead', 'ocean', 'toxic', 'volcanic',
                    'station', 'glitterworld', 'rimworld', 'dead'];

  var cluster = null;             /* {seed, systems:[], planets:[], byId:{}} */

  function withSeed(seed, fn) {
    var saved = U.getSeed();
    U.seed(seed >>> 0);
    try { return fn(); } finally { U.setSeed(saved); }
  }

  function buildCluster(seed) {
    return withSeed((seed >>> 0) ^ 0x5741524d, function () {
      var systems = [], planets = [], byId = {};
      var types = TYPE_ORDER.slice();
      var usedNames = {}, usedStars = {};
      var systemCount = U.randInt(5, 6);

      for (var s = 0; s < systemCount; s++) {
        var starName;
        do {
          starName = U.pick(STAR_PREFIX) + U.pick(STAR_SUFFIX);
        } while (usedStars[starName]);
        usedStars[starName] = 1;

        /* Distance is per system - everything orbiting one star is the
           same crossing - and rises with the index so the cluster reads
           as near, middling and far rather than as a bag of numbers. */
        var distance = Math.round((1.4 + s * 1.45 + U.randRange(-0.35, 0.6)) * 10) / 10;
        var system = {
          id: 'sys' + (s + 1), name: starName, index: s,
          distanceLy: Math.max(1.1, distance),
          star: U.pick(['a yellow main-sequence star', 'an orange dwarf', 'a white star',
                        'a cooling red giant', 'a tight binary pair']),
          planetIds: []
        };
        systems.push(system);

        var count = types.length ? Math.min(types.length, U.randInt(1, 3)) : U.randInt(1, 2);
        for (var p = 0; p < count; p++) {
          var typeId = types.length ? types.shift() : U.pick(Object.keys(PLANET_TYPES));
          var type = PLANET_TYPES[typeId];
          var name;
          do {
            name = U.chance(0.55) ? (starName + ' ' + ROMAN[Math.min(p, ROMAN.length - 1)])
                                  : U.pick(PLANET_NAMES);
          } while (usedNames[name]);
          usedNames[name] = 1;

          var planet = {
            id: 'p' + (planets.length + 1),
            name: name,
            systemId: system.id,
            systemName: starName,
            typeId: typeId,
            typeLabel: type.label,
            distanceLy: Math.round((system.distanceLy + U.randRange(-0.1, 0.1)) * 10) / 10,
            /* What a landing costs you, before the planet's own rules
               get their turn: raid points on the first day, and how
               hard the storyteller leans afterwards. */
            difficulty: Math.round((type.difficulty * U.randRange(0.88, 1.15)) * 100) / 100,
            gravity: Math.round(U.randRange(0.72, 1.28) * 100) / 100,
            dayHours: Math.round(U.randRange(17, 34)),
            moons: U.randInt(0, 3),
            baseKnown: U.randRange(0.12, 0.45),
            blurb: type.blurb
          };
          planet.mapSize = type.mapSize;
          planets.push(planet);
          byId[planet.id] = planet;
          system.planetIds.push(planet.id);
        }
      }

      /* A glitterworld you could stroll to would not be a glitterworld.
         Whichever one the generator produced gets pushed to the back of
         the cluster so the fuel bill is the story it is supposed to be. */
      var far = systems[systems.length - 1];
      for (var i = 0; i < planets.length; i++) {
        if (planets[i].typeId !== 'glitterworld') continue;
        planets[i].distanceLy = Math.round(
          Math.max(planets[i].distanceLy, far.distanceLy + 1.8) * 10) / 10;
      }

      return { seed: seed >>> 0, systems: systems, planets: planets, byId: byId };
    });
  }

  function ensureCluster() {
    var g = G();
    var seed = (g && g.seed) || 1;
    if (!cluster || cluster.seed !== (seed >>> 0)) cluster = buildCluster(seed);
    return cluster;
  }

  Starmap.systems = function () { return ensureCluster().systems.slice(); };
  Starmap.planets = function () { return ensureCluster().planets.slice(); };
  Starmap.planetAt = function (id) { return ensureCluster().byId[id] || null; };
  Starmap.typeOf = function (id) {
    var p = Starmap.planetAt(id);
    return p ? PLANET_TYPES[p.typeId] : null;
  };

  Starmap.distanceTo = function (id) {
    var p = Starmap.planetAt(id);
    return p ? p.distanceLy : 0;
  };

  /* How much of a powered sensor cluster the colony is running, which is
     the whole difference between a fact and a rumour. */
  function sensorStrength(map) {
    if (!map || !map.byDef) return 0;
    var P = sys('Power');
    var list = map.byDef('shipSensorCluster') || [];
    var total = 0;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t.spawned || t.faction !== 'player') continue;
      total += (P && P.isPowered && !P.isPowered(t)) ? 0.08 : 0.30;
    }
    var plat = map.byDef('orbitalPlatform') || [];
    for (var j = 0; j < plat.length; j++) {
      if (plat[j].spawned && plat[j].faction === 'player') total += 0.12;
    }
    return total;
  }

  Starmap.knownOf = function (id) {
    var planet = Starmap.planetAt(id);
    if (!planet) return { level: 0, facts: [], rumours: [], summary: 'No such world is charted.' };
    var g = G();
    var type = PLANET_TYPES[planet.typeId];
    var R = sys('Research');
    var level = planet.baseKnown;
    if (R && R.isDone && R.isDone('shipSensors')) level += 0.18;
    level += sensorStrength(g && g.map);
    level += (state.surveyed[id] || 0);
    /* The farther out, the less anyone knows, however good your dishes. */
    level -= U.clamp(planet.distanceLy * 0.035, 0, 0.30);
    level = U.clamp01(level);

    var facts = type.known.slice(0, Math.max(1, Math.round(level * type.known.length)));
    var rumours = level >= 0.85 ? [] : type.rumours.slice();
    var summary;
    if (level < 0.3) summary = 'Barely charted. Most of what you have is hearsay.';
    else if (level < 0.6) summary = 'Partially surveyed. The broad strokes are solid.';
    else if (level < 0.9) summary = 'Well surveyed. You know what you would be landing on.';
    else summary = 'Fully surveyed. There are no surprises left up there.';

    return {
      id: id, level: Math.round(level * 100) / 100,
      facts: facts, rumours: rumours, summary: summary,
      blurb: planet.blurb,
      detail: planet.name + ' orbits ' + planet.systemName + ', ' + type.label + ', ' +
        planet.distanceLy + ' light years out, ' + planet.gravity + ' g, ' +
        planet.dayHours + '-hour day, ' +
        (planet.moons ? planet.moons + ' moon' + (planet.moons === 1 ? '' : 's') : 'no moons') + '.'
    };
  };

  /* ============================================================
     3. THE SHIP

     A ship is not a list of buildings; it is one connected structure
     made of them. Everything below exists so that a player who has
     spent a hundred hours on this is told exactly what is wrong with
     it, in tiles and part names, rather than "invalid".
     ============================================================ */

  var PART_DEF_IDS = ['shipReactor', 'shipEngine', 'shipCasket', 'shipComputerCore',
                      'shipSensorCluster', 'shipFuelTank', 'shipBeam', 'shipHull'];

  var MASS_PER_ENGINE = 2500;
  var FUEL_PER_TANK = 450;

  function countOf(map, defId) {
    if (!map || !map.byDef) return 0;
    var list = map.byDef(defId) || [], n = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].spawned && !list[i].isBlueprint && !list[i].isFrame &&
          list[i].faction === 'player') n++;
    }
    return n;
  }

  function partThings(map) {
    var out = [];
    if (!map || !map.byDef) return out;
    for (var i = 0; i < PART_DEF_IDS.length; i++) {
      var list = map.byDef(PART_DEF_IDS[i]) || [];
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        if (t.spawned && !t.isBlueprint && !t.isFrame && t.faction === 'player') out.push(t);
      }
    }
    return out;
  }

  /* Mass counts the structure, not what is in the tanks: fuel that made
     the ship heavier would make the ship need more fuel, and the number
     the player is reading would chase its own tail. */
  Starmap.shipMass = function (map) {
    var things = partThings(map || (G() && G().map));
    var mass = 0;
    for (var i = 0; i < things.length; i++) mass += things[i].def.mass || 0;
    return Math.round(mass);
  };

  /* Structure is sized off the mass of the WORKING parts only, for the
     same reason: a requirement that grows as you satisfy it is a bad
     requirement even when it converges. */
  function functionalMass(map) {
    var things = partThings(map);
    var mass = 0;
    for (var i = 0; i < things.length; i++) {
      var id = things[i].defId;
      if (id === 'shipBeam' || id === 'shipHull') continue;
      mass += things[i].def.mass || 0;
    }
    return mass;
  }

  function travellersWanted(map) {
    var g = G();
    var list = (map && map.colonists) ? map.colonists() : (g ? g.colonists() : []);
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].dead) continue;
      if (Starmap.roleOf(list[i]) === 'stay') continue;
      n++;
    }
    return Math.max(1, n);
  }

  Starmap.shipParts = function (map) {
    map = map || (G() && G().map);
    var mass = Starmap.shipMass(map);
    var core = functionalMass(map);
    var destination = Starmap.destination();
    var fuel = Starmap.fuelNeeded(map, destination);
    var rows = [
      { defId: 'shipReactor', label: 'reactor', need: 1,
        why: 'Nothing else aboard turns over without it.' },
      { defId: 'shipEngine', label: 'engine',
        need: Math.max(1, Math.ceil(mass / MASS_PER_ENGINE)),
        why: 'One engine per ' + MASS_PER_ENGINE + ' kg of ship, rounded up.' },
      { defId: 'shipCasket', label: 'cryptosleep casket', need: travellersWanted(map),
        why: 'One per colonist who is coming. Anyone without one is staying.' },
      { defId: 'shipComputerCore', label: 'computer core', need: 1,
        why: 'Somebody has to fly it, and everybody aboard will be frozen.' },
      { defId: 'shipSensorCluster', label: 'sensor cluster', need: 1,
        why: 'Without it you are aiming an engine at a rumour.' },
      { defId: 'shipFuelTank', label: 'fuel tank',
        need: Math.max(1, Math.ceil(fuel / FUEL_PER_TANK)),
        why: FUEL_PER_TANK + ' chemfuel each, and the crossing wants ' + fuel + '.' },
      { defId: 'shipBeam', label: 'structural beam',
        need: Math.max(4, Math.ceil(core / 900)),
        why: 'The frame the working parts bolt to.' },
      { defId: 'shipHull', label: 'hull plate',
        need: Math.max(6, Math.ceil(core / 620)),
        why: 'Vacuum on one side, your colonists on the other.' }
    ];
    for (var i = 0; i < rows.length; i++) {
      rows[i].have = countOf(map, rows[i].defId);
      var def = Defs.maybe('thing', rows[i].defId);
      rows[i].thingLabel = (def && def.label) || rows[i].defId;
      rows[i].short = Math.max(0, rows[i].need - rows[i].have);
    }
    return rows;
  };

  Starmap.fuelNeeded = function (map, destinationId) {
    map = map || (G() && G().map);
    var mass = Starmap.shipMass(map);
    if (!mass) mass = 4000;
    var ly = Starmap.distanceTo(destinationId || Starmap.destination()) || 2;
    /* Two thirds of the bill is getting off this planet at all; the rest
       scales with how far you are going. */
    var factor = 0.70 + 0.30 * ly;
    return Math.ceil(mass * 0.30 * factor);
  };

  Starmap.fuelAboard = function (map) {
    map = map || (G() && G().map);
    if (!map || !map.byDef) return 0;
    var tanks = map.byDef('shipFuelTank') || [], total = 0;
    for (var i = 0; i < tanks.length; i++) {
      var t = tanks[i];
      if (!t.spawned || t.isBlueprint || t.isFrame || t.faction !== 'player') continue;
      total += t.fuel || 0;
    }
    return Math.round(total);
  };

  /* Which cells the ship stands on, and how many separate lumps those
     cells form. Orthogonal adjacency only: a ship joined at a corner is
     a ship joined by nothing. */
  function shipClusters(map) {
    var things = partThings(map);
    if (!things.length) return { clusters: [], owner: {} };
    var owner = {};                 /* cell index -> thing */
    var i, j, cells;
    for (i = 0; i < things.length; i++) {
      cells = things[i].occupiedCells();
      for (j = 0; j < cells.length; j++) owner[cells[j]] = things[i];
    }

    var seen = {}, clusters = [];
    for (i = 0; i < things.length; i++) {
      cells = things[i].occupiedCells();
      if (!cells.length || seen[cells[0]]) continue;
      var stack = [cells[0]], group = { cells: [], things: [], mass: 0 }, inGroup = {};
      seen[cells[0]] = 1;
      while (stack.length) {
        var at = stack.pop();
        group.cells.push(at);
        var holder = owner[at];
        if (holder && !inGroup[holder.id]) {
          inGroup[holder.id] = 1;
          group.things.push(holder);
          group.mass += holder.def.mass || 0;
        }
        var x = map.xOf(at), y = map.yOf(at);
        for (var d = 0; d < U.ADJ4.length; d++) {
          var nx = x + U.ADJ4[d][0], ny = y + U.ADJ4[d][1];
          if (!map.inBounds(nx, ny)) continue;
          var ni = map.idx(nx, ny);
          if (!owner[ni] || seen[ni]) continue;
          seen[ni] = 1;
          stack.push(ni);
        }
      }
      clusters.push(group);
    }
    clusters.sort(function (a, b) { return b.mass - a.mass || b.cells.length - a.cells.length; });
    return { clusters: clusters, owner: owner };
  }

  Starmap.shipClusters = function (map) {
    return shipClusters(map || (G() && G().map)).clusters;
  };

  Starmap.validateShip = function (map) {
    map = map || (G() && G().map);
    var out = { ok: false, missing: [], problems: [], parts: [], mass: 0, fuelNeed: 0,
                fuelHave: 0, fuelCapacity: 0, clusters: 0, destination: Starmap.destination(),
                travellers: 0 };
    if (!map) { out.problems.push('There is no map to look at.'); return out; }

    var rows = Starmap.shipParts(map);
    out.parts = rows;
    out.mass = Starmap.shipMass(map);
    out.destination = Starmap.destination();
    out.fuelNeed = Starmap.fuelNeeded(map, out.destination);
    out.fuelHave = Starmap.fuelAboard(map);
    out.fuelCapacity = countOf(map, 'shipFuelTank') * FUEL_PER_TANK;
    out.travellers = travellersWanted(map);

    var i;
    for (i = 0; i < rows.length; i++) {
      if (rows[i].short <= 0) continue;
      out.missing.push({
        defId: rows[i].defId, label: rows[i].thingLabel,
        have: rows[i].have, need: rows[i].need, short: rows[i].short,
        why: rows[i].why
      });
    }

    var planet = Starmap.planetAt(out.destination);
    if (!planet) out.problems.push('No destination is set. Pick a world before you light it.');

    /* Connectivity, said in tiles. "Your ship is invalid" is the worst
       possible end to a hundred hours, so this names the part and the
       cell and tells the player which way to run a beam. */
    var groups = shipClusters(map).clusters;
    out.clusters = groups.length;
    if (!groups.length) {
      out.problems.push('Nothing of the ship is built yet.');
    } else if (groups.length > 1) {
      var main = groups[0];
      var mainAt = main.things[0];
      var stranded = 0, named = [];
      for (i = 1; i < groups.length; i++) {
        for (var j = 0; j < groups[i].things.length; j++) {
          stranded++;
          if (named.length < 4) {
            var t = groups[i].things[j];
            named.push(t.def.label + ' at (' + t.x + ', ' + t.y + ')');
          }
        }
      }
      out.problems.push(stranded + ' part' + (stranded === 1 ? '' : 's') +
        ' are not joined to the main hull: ' + named.join(', ') +
        (stranded > named.length ? ' and ' + (stranded - named.length) + ' more' : '') +
        '. The hull starts at (' + mainAt.x + ', ' + mainAt.y + ') - run beams from there ' +
        'until every part touches it edge to edge. Corners do not count.');
    }

    if (out.fuelCapacity < out.fuelNeed) {
      out.problems.push('Tank capacity is ' + out.fuelCapacity + ' chemfuel and the crossing ' +
        'to ' + (planet ? planet.name : 'your destination') + ' wants ' + out.fuelNeed +
        '. Build ' + Math.ceil((out.fuelNeed - out.fuelCapacity) / FUEL_PER_TANK) +
        ' more tank(s) - and remember each one is 300 kg more to push.');
    } else if (out.fuelHave < out.fuelNeed) {
      out.problems.push('Fuelled to ' + out.fuelHave + ' of ' + out.fuelNeed + ' chemfuel. ' +
        'Haulers will keep filling the tanks; refine more or buy it.');
    }

    /* The core and the dishes have to be live when the reactor lights:
       a ship that cannot navigate is a very expensive coffin. */
    var P = sys('Power');
    if (P && P.isPowered) {
      var unpowered = [];
      var live = (map.byDef('shipComputerCore') || []).concat(map.byDef('shipSensorCluster') || []);
      for (i = 0; i < live.length; i++) {
        var lt = live[i];
        if (!lt.spawned || lt.isBlueprint || lt.isFrame || lt.faction !== 'player') continue;
        if (!P.isPowered(lt)) unpowered.push(lt.def.label + ' at (' + lt.x + ', ' + lt.y + ')');
      }
      if (unpowered.length) {
        out.problems.push('No power reaching: ' + unpowered.join(', ') +
          '. Run conduit from the reactor, or from anything else that makes power.');
      }
    }

    var colonists = (map.colonists ? map.colonists() : []).filter(function (p) { return !p.dead; });
    var caskets = countOf(map, 'shipCasket');
    if (caskets && caskets < colonists.length) {
      out.problems.push(caskets + ' casket(s) for ' + colonists.length + ' colonist(s). ' +
        (colonists.length - caskets) + ' of them will watch you leave.');
    }

    out.ok = !out.missing.length && !out.problems.length && !!planet;
    return out;
  };

  /* ============================================================
     4. STATE

     Everything that has to survive a save lives in one plain object.
     Per-pawn state lives on plain fields on the pawn, so save.js's
     blob carries it without this file being wired into save.js.
     ============================================================ */

  function freshState() {
    return {
      phase: 'idle',              /* idle | countdown | voyage | landed */
      destinationId: null,
      countdownLeft: 0,
      countdownTotal: 0,
      wave: 0,
      nextWaveTick: 0,
      launchTick: 0,
      hops: 0,
      surveyed: {},               /* planetId -> extra knowledge bought with time */
      history: [],                /* one row per launch, for the epilogue */
      world: null,                /* the rules of the planet we are standing on */
      platformCooldown: 0,
      platformEarned: 0,
      shuttleUsed: 0,
      lastSeenTick: 0,
      abortedFuel: 0
    };
  }

  var state = freshState();
  Starmap.state = state;

  Starmap.policy = {
    countdownDays: 4,       /* how long the reactor screams before it goes */
    siegeScale: 1.0,        /* how hard the final siege leans on you */
    followShip: true,       /* when some colonists stay, whose story do we follow */
    autoBoard: true,        /* push colonists into caskets when the count starts */
    holdKgPerHull: 45       /* cargo the hull can take with you */
  };

  Starmap.reset = function () {
    state = freshState();
    Starmap.state = state;
    cluster = null;
    return Starmap;
  };

  Starmap.destination = function () {
    if (state.destinationId && Starmap.planetAt(state.destinationId)) return state.destinationId;
    /* Default to the nearest world that is not a glitterworld, because
       that is the one a first ship can actually reach. */
    var list = ensureCluster().planets.slice().sort(function (a, b) {
      return a.distanceLy - b.distanceLy;
    });
    for (var i = 0; i < list.length; i++) {
      if (list[i].typeId !== 'glitterworld') return list[i].id;
    }
    return list.length ? list[0].id : null;
  };

  Starmap.setDestination = function (id) {
    if (state.phase === 'countdown') return false;
    if (!Starmap.planetAt(id)) return false;
    state.destinationId = id;
    return true;
  };

  Starmap.roleOf = function (pawn) {
    if (!pawn) return 'board';
    return pawn.shipRole || 'board';
  };

  /* The knob with the real trade-off: somebody has to hold the line
     while the rest climb into caskets, and the ones holding it are the
     ones most likely to be left standing on the pad. */
  Starmap.setRole = function (pawn, role) {
    if (!pawn) return false;
    if (role !== 'board' && role !== 'defend' && role !== 'stay') return false;
    pawn.shipRole = role;
    if (role !== 'board' && pawn.inCasketId) Starmap.leaveCasket(pawn, 'reassigned');
    return true;
  };

  /* ============================================================
     5. CASKETS AND THE BOARDING JOB
     ============================================================ */

  function casketOf(map, pawn) {
    if (!pawn || !pawn.inCasketId || !map) return null;
    var t = map.thing(pawn.inCasketId);
    return (t && t.spawned && t.defId === 'shipCasket') ? t : null;
  }

  function freeCasket(map, pawn) {
    var list = map.byDef('shipCasket') || [], best = null, bestD = Infinity;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c.spawned || c.isBlueprint || c.isFrame || c.faction !== 'player') continue;
      /* An occupant who died, broke down or was reassigned leaves the
         lid open, and the next colonist along should find it. */
      if (c.occupantId && c.occupantId !== pawn.id) {
        var live = false;
        for (var p = 0; p < map.pawns.length; p++) {
          if (map.pawns[p].id === c.occupantId && !map.pawns[p].dead &&
              map.pawns[p].inCasketId === c.id) { live = true; break; }
        }
        if (live) continue;
        c.occupantId = 0;
      }
      /* A casket somebody else is already walking towards is taken, even
         though nobody is lying in it yet. Without this every colonist is
         sent to the same nearest casket, all but one of them fails to
         reserve it, and a crew of six boards one at a time. */
      if (Res && Res.canReserve && !Res.canReserve(pawn, T.thing(c), 1)) continue;
      var d = U.distSq(pawn.x, pawn.y, c.x, c.y);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  Starmap.freeCasket = function (map, pawn) {
    map = map || (G() && G().map);
    return (map && pawn) ? freeCasket(map, pawn) : null;
  };

  Starmap.enterCasket = function (pawn, casket) {
    if (!pawn || !casket) return false;
    if (casket.occupantId && casket.occupantId !== pawn.id) return false;
    casket.occupantId = pawn.id;
    pawn.inCasketId = casket.id;
    pawn.drafted = false;
    pawn.draftTarget = null;
    var N = sys('Needs');
    if (N && N.addThought) N.addThought(pawn, 'shipAboard');
    return true;
  };

  Starmap.leaveCasket = function (pawn, reason) {
    if (!pawn || !pawn.inCasketId) return false;
    var g = G();
    var map = pawn.map || (g && g.map);
    var casket = map ? map.thing(pawn.inCasketId) : null;
    if (casket && casket.occupantId === pawn.id) casket.occupantId = 0;
    pawn.inCasketId = 0;
    if (reason === 'aborted' && pawn.job && pawn.job.defId === 'starmapBoardShip' && pawn.endJob) {
      pawn.endJob('interrupted');
    }
    return true;
  };

  Starmap.aboard = function (map) {
    map = map || (G() && G().map);
    var out = [];
    if (!map) return out;
    var list = map.colonists ? map.colonists() : [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i].dead && list[i].inCasketId && casketOf(map, list[i])) out.push(list[i]);
    }
    return out;
  };

  if (Jobs && Jobs.register) {
    Jobs.register('starmapBoardShip', {
      label: 'enter cryptosleep',
      reportString: 'Climbing into a cryptosleep casket.',
      suspendable: false,
      onEnd: function (pawn, job, reason) {
        /* Leaving the job means leaving the casket: a colonist who was
           dragged out by a mental break must not still be counted as
           aboard when the engines light. */
        if (reason !== 'done' && pawn.inCasketId) Starmap.leaveCasket(pawn, 'job ended');
      },
      toils: function () {
        return [
          Toils.custom({
            name: 'claimCasket',
            tick: function (pawn, job) {
              var map = pawn.map;
              if (!map) return 'fail';
              var casket = job.targetA ? T.resolve(job.targetA, map) : null;
              if (!casket || casket.defId !== 'shipCasket' ||
                  (casket.occupantId && casket.occupantId !== pawn.id)) {
                casket = freeCasket(map, pawn);
                if (!casket) return 'fail';
                job.targetA = T.thing(casket);
              }
              if (!Res.reserve(pawn, job.targetA, 1)) return 'fail';
              return 'next';
            }
          }),
          Toils.goto('A', { pe: Path.PE.INTERACTION, failIfGone: true }),
          Toils.custom({
            name: 'climbIn',
            tick: function (pawn, job) {
              var casket = T.resolve(job.targetA, pawn.map);
              if (!casket) return 'fail';
              return Starmap.enterCasket(pawn, casket) ? 'next' : 'fail';
            }
          }),
          /* Frozen. The pawn stays on the map, standing at the casket,
             because a pawn stored off the map is a pawn save.js cannot
             see - and a colonist who vanishes on reload is a worse bug
             than a colonist who is visibly in a box. */
          Toils.waitWith(function (pawn, job) {
            if (!pawn.inCasketId) return 'done';
            var casket = T.resolve(job.targetA, pawn.map);
            if (!casket || !casket.spawned) { Starmap.leaveCasket(pawn, 'casket gone'); return 'fail'; }
            if (state.phase !== 'countdown' && state.phase !== 'voyage') {
              Starmap.leaveCasket(pawn, 'sequence ended');
              return 'done';
            }
            return 'stay';
          }, { name: 'cryptosleep' })
        ];
      }
    });
  }

  if (WorkGivers && WorkGivers.register) {
    /* Belt and braces. The countdown pushes the job onto the pawn's
       queue, which outranks work entirely; this giver only catches a
       colonist who lost the queued job to a mental break and then came
       looking for something to do. */
    WorkGivers.register({
      id: 'starmapBoardShip', workType: 'basic', order: 1, label: 'board the ship',
      tryGiveJob: function (pawn) {
        if (state.phase !== 'countdown') return null;
        if (!pawn || pawn.inCasketId) return null;
        if (Starmap.roleOf(pawn) !== 'board') return null;
        var casket = freeCasket(pawn.map, pawn);
        if (!casket) return null;
        if (!Res.canReserve(pawn, T.thing(casket), 1)) return null;
        return Jobs.make('starmapBoardShip', T.thing(casket), null, {});
      }
    });
  }

  /* ============================================================
     6. THE LAUNCH SEQUENCE
     ============================================================ */

  Starmap.beginLaunch = function (opts) {
    opts = opts || {};
    var g = G();
    var map = g && g.map;
    if (!map) return { ok: false, reason: 'There is no colony to launch from.' };
    if (state.phase === 'countdown') return { ok: false, reason: 'The sequence is already running.' };
    if (state.phase === 'voyage') return { ok: false, reason: 'The ship has already gone.' };

    if (opts.destinationId) Starmap.setDestination(opts.destinationId);
    var check = Starmap.validateShip(map);
    if (!check.ok && !opts.force) {
      var lines = [];
      for (var i = 0; i < check.missing.length; i++) {
        lines.push('Missing ' + check.missing[i].short + ' ' + check.missing[i].label +
          ' (' + check.missing[i].have + ' of ' + check.missing[i].need + ') - ' +
          check.missing[i].why);
      }
      for (var j = 0; j < check.problems.length; j++) lines.push(check.problems[j]);
      return { ok: false, reason: lines.join('\n'), report: check };
    }

    var planet = Starmap.planetAt(Starmap.destination());
    var days = Math.max(0.5, +opts.days || Starmap.policy.countdownDays);
    state.phase = 'countdown';
    state.destinationId = Starmap.destination();
    state.countdownTotal = Math.round(days * TICKS_PER_DAY);
    state.countdownLeft = state.countdownTotal;
    state.wave = 0;
    state.nextWaveTick = now() + Math.round(state.countdownTotal * 0.12);
    state.launchTick = now() + state.countdownTotal;

    letter('Ignition sequence started',
      'The reactor is spinning up and it can be heard from the far side of the map. ' +
      'In ' + U.fmt(days, 1) + ' days the engines light, and everything hostile on this ' +
      'planet now knows exactly where you are and exactly how little time it has.\n\n' +
      'Destination: ' + (planet ? planet.name + ', ' + planet.typeLabel + ', ' +
        planet.distanceLy + ' light years' : 'unset') + '.\n' +
      'Anyone not in a cryptosleep casket when the countdown ends is staying on this planet.',
      'threat', map.byDef('shipReactor')[0]);
    return { ok: true, reason: '', report: check };
  };

  Starmap.abortLaunch = function (reason) {
    if (state.phase !== 'countdown') return false;
    var g = G();
    var map = g && g.map;
    /* Priming the reactor spends fuel whether or not you go through
       with it. Changing your mind is allowed; it is not free. */
    var burned = 0;
    if (map && map.byDef) {
      var tanks = map.byDef('shipFuelTank') || [];
      for (var i = 0; i < tanks.length; i++) {
        var spent = Math.floor((tanks[i].fuel || 0) * 0.12);
        tanks[i].fuel = Math.max(0, (tanks[i].fuel || 0) - spent);
        burned += spent;
      }
    }
    state.abortedFuel += burned;
    state.phase = 'idle';
    state.countdownLeft = 0;
    state.wave = 0;

    if (map) {
      var aboard = Starmap.aboard(map);
      for (var p = 0; p < aboard.length; p++) Starmap.leaveCasket(aboard[p], 'aborted');
    }
    letter('Ignition aborted',
      'The reactor is throttled back and the caskets are open again. ' +
      burned + ' chemfuel went up the stack priming it, and whatever is already ' +
      'walking towards you does not know the sequence stopped.' +
      (reason ? '\n\n' + reason : ''),
      'neutral');
    return true;
  };

  function siegeWave(game) {
    var S = sys('Storyteller'), I = sys('Incidents');
    if (!I) return;
    /* The one knob that can switch the final siege off entirely, for a
       player who wants the ending without the last stand. */
    if (!(Starmap.policy.siegeScale > 0)) return;
    var base = (S && S.threatPoints) ? S.threatPoints(game) : 300;
    var scale = Starmap.policy.siegeScale * (0.85 + 0.32 * state.wave);
    var points = Math.max(280, Math.round(base * scale));
    state.wave++;

    var fired = false;
    if (I.raid) fired = I.raid(game, points, { drop: state.wave >= 3 && U.chance(0.45) });
    if (!fired && I.manhunters) fired = I.manhunters(game, points);
    if (fired) {
      msg('Wave ' + state.wave + ' is here. They can hear the reactor.', 'threat');
    }
    /* Even the wildlife objects to a fusion pile going critical next to
       its den, and it makes the last day of a colony feel like one. */
    if (state.wave >= 2 && U.chance(0.30) && I.manhunters) {
      I.manhunters(game, Math.round(points * 0.5));
    }
  }

  function pushBoardingOrders(map) {
    if (!Starmap.policy.autoBoard) return;
    var list = map.colonists ? map.colonists() : [];
    for (var i = 0; i < list.length; i++) {
      var pawn = list[i];
      if (pawn.dead || pawn.downed) continue;
      if (Starmap.roleOf(pawn) !== 'board') continue;
      if (pawn.job && pawn.job.defId === 'starmapBoardShip') continue;
      if (pawn.mentalState) continue;

      /* A pawn can be flagged as aboard with no job driving it: the job
         is scratch that save.js does not carry, so a game loaded in the
         middle of a countdown has frozen colonists and no cryptosleep
         toil holding them there. Re-issuing the job against the casket
         they already occupy puts that right without waking anybody. */
      var casket = pawn.inCasketId ? map.thing(pawn.inCasketId) : null;
      if (casket && (!casket.spawned || casket.defId !== 'shipCasket')) {
        Starmap.leaveCasket(pawn, 'casket gone');
        casket = null;
      }
      if (!casket) casket = freeCasket(map, pawn);
      if (!casket) continue;
      if (!Res.canReserve(pawn, T.thing(casket), 1)) continue;

      var job = Jobs.make('starmapBoardShip', T.thing(casket), null, { playerForced: true });
      /* The ordered tier outranks work, food and sleep, which is right:
         on the last day of the colony nothing else matters. */
      if (!pawn.jobQueue) pawn.jobQueue = [];
      pawn.jobQueue.length = 0;
      pawn.jobQueue.push(job);
      if (pawn.job && pawn.endJob) pawn.endJob('interrupted');
    }
  }

  function tickCountdown(game) {
    var map = game.map;
    if (!map) { state.phase = 'idle'; return; }

    state.countdownLeft = Math.max(0, state.countdownLeft - SLOW);
    if (now() >= state.nextWaveTick && state.countdownLeft > SLOW * 4) {
      siegeWave(game);
      state.nextWaveTick = now() + Math.round(U.randRange(0.55, 0.95) * TICKS_PER_DAY);
    }

    pushBoardingOrders(map);

    var list = map.colonists ? map.colonists() : [];
    var N = sys('Needs');
    for (var i = 0; i < list.length; i++) {
      var pawn = list[i];
      if (pawn.dead) continue;
      if (pawn.inCasketId) {
        /* Cryptosleep suspends a body. Without this a four-day
           countdown starves everybody who boarded on day one. */
        if (pawn.needs) {
          if (pawn.needs.food < 0.6) pawn.needs.food = 0.6;
          if (pawn.needs.rest < 0.6) pawn.needs.rest = 0.6;
          if (pawn.needs.joy < 0.5) pawn.needs.joy = 0.5;
          if (pawn.needs.comfort !== undefined && pawn.needs.comfort < 0.5) pawn.needs.comfort = 0.5;
        }
      } else if (N && N.addThought) {
        N.addThought(pawn, 'shipCountdownDread', { situational: true });
      }
    }

    if (state.countdownLeft <= 0) Starmap.launchNow(game);
  }

  Starmap.launchNow = function (game) {
    game = game || G();
    var map = game && game.map;
    if (!map) return false;

    var aboard = Starmap.aboard(map);
    if (!aboard.length) {
      state.phase = 'idle';
      state.countdownLeft = 0;
      letter('The reactor scrams',
        'The countdown ran out with nobody in a casket. The computer core refused to ' +
        'light engines on an empty ship and dumped the sequence. The fuel that had ' +
        'already gone through the pumps is gone; everything else is still here, ' +
        'including whatever came to stop you.',
        'threat');
      return false;
    }

    var stayed = [];
    var all = map.colonists ? map.colonists() : [];
    for (var i = 0; i < all.length; i++) {
      if (all[i].dead) continue;
      if (aboard.indexOf(all[i]) < 0) stayed.push(all[i]);
    }

    /* Spend the fuel. A tank that still has something in it after a
       launch is a tank the player can see was never needed. */
    var need = Starmap.fuelNeeded(map, Starmap.destination());
    var tanks = map.byDef('shipFuelTank') || [];
    for (var t = 0; t < tanks.length && need > 0; t++) {
      var take = Math.min(need, tanks[t].fuel || 0);
      tanks[t].fuel = (tanks[t].fuel || 0) - take;
      need -= take;
    }

    state.history.push({
      tick: now(), from: (game.biome || 'somewhere'),
      to: Starmap.destination(),
      aboard: aboard.length, left: stayed.length,
      names: aboard.map(nameOf), leftNames: stayed.map(nameOf)
    });

    Starmap.travel(Starmap.destination(), { travellers: aboard, stayed: stayed });
    return Starmap.arrive(game);
  };

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    var n = pawn.name;
    if (!n) return 'someone';
    return n.nick || n.first || 'someone';
  }

  /* ============================================================
     7. TRAVEL AND ARRIVAL

     travel() only writes down what is about to happen. arrive() is the
     operation that throws the world away, and it is deliberately the
     only thing in this file that touches Game.map.

     The voyage itself takes decades and they sleep through all of it,
     so mechanically it is instantaneous. Leaving a gap in which the
     colony has no colonists would let game.js declare the run over
     before the new map existed, which is the exact failure this
     structure is here to avoid.
     ============================================================ */

  Starmap.travel = function (destinationId, opts) {
    opts = opts || {};
    var planet = Starmap.planetAt(destinationId || Starmap.destination());
    if (!planet) return false;
    state.phase = 'voyage';
    state.destinationId = planet.id;
    state.voyage = {
      destinationId: planet.id,
      departTick: now(),
      travellerIds: (opts.travellers || []).map(function (p) { return p.id; }),
      stayedNames: (opts.stayed || []).map(nameOf)
    };
    return true;
  };

  /* What comes with you, said out loud, because a player who has lost a
     colony to a bad assumption deserves the list before they commit. */
  Starmap.carryManifest = function () {
    return {
      carries: [
        'The colonists in the caskets, whole: skills, passions, traits, backstories and age.',
        'Their relationships with each other, and their memories of each other.',
        'Their ideoligion, their titles and their honour, which the empire honours anywhere.',
        'Their injuries, scars, missing parts, addictions and implants. Cryptosleep heals nothing.',
        'Everything the colony ever researched. Knowledge has no mass.',
        'What fits in the hold: roughly ' + Starmap.policy.holdKgPerHull +
          ' kg per hull plate, packed by value.'
      ],
      resets: [
        'The map. Every building, floor, wall, stockpile, zone and designation stays behind.',
        'The world and every civilization on it. New star, new neighbours, new grudges.',
        'Caravans in transit and any deal open with a trader. They cannot follow you.',
        'The prison, its blocks and everyone in them. Prisoners are not cargo.',
        'Animals, tame or otherwise. A casket holds one human.',
        'The storyteller\'s memory of this colony: threat scales from the new planet, not the old.'
      ],
      why: 'A casket carries a person and nothing else. Everything that was true about the ' +
        'PEOPLE travels; everything that was true about the PLACE does not.'
    };
  };

  /* The cargo the hold can take: the most valuable useful things in the
     colony, packed by value per kilogram, capped by the hull. */
  function packHold(map) {
    var capacity = countOf(map, 'shipHull') * Starmap.policy.holdKgPerHull;
    if (capacity <= 0) return { items: [], kg: 0, capacity: 0 };
    var PRIORITY = ['medicine', 'components', 'herbalMedicine', 'silver', 'mealSimple',
                    'mealFine', 'steel', 'cloth', 'leather', 'chemfuel'];
    var out = [], kg = 0;
    for (var i = 0; i < PRIORITY.length && kg < capacity; i++) {
      var defId = PRIORITY[i];
      var def = Defs.maybe('thing', defId);
      if (!def) continue;
      var stacks = map.byDef(defId) || [], have = 0;
      for (var s = 0; s < stacks.length; s++) {
        if (stacks[s].spawned) have += stacks[s].stack || 0;
      }
      if (have <= 0) continue;
      var per = Math.max(0.05, def.mass || 0.5);
      var room = Math.floor((capacity - kg) / per);
      var take = Math.min(have, room);
      if (take <= 0) continue;
      out.push({ defId: defId, count: take, label: def.label || defId });
      kg += take * per;
    }
    return { items: out, kg: Math.round(kg), capacity: capacity };
  }

  /* Cut every link between a pawn and the map it is standing on. This is
     the same list caravan.js has to cut, and for the same reason: a
     stale reference here is a crash forty minutes later. */
  function detach(pawn, map) {
    var g = G();
    if (g && g.selection) U.remove(g.selection, pawn);
    pawn.drafted = false;
    pawn.draftTarget = null;
    pawn.aimTarget = null;
    pawn.inCasketId = 0;
    pawn.ownedBedId = null;
    if (pawn.jobQueue) pawn.jobQueue.length = 0;
    if (pawn.endJob) pawn.endJob('interrupted');
    if (Res && Res.releaseAll) Res.releaseAll(pawn);
    var C = sys('Combat');
    if (C && C.clearStance) C.clearStance(pawn);

    for (var i = 0; map && i < map.pawns.length; i++) {
      var other = map.pawns[i];
      if (other === pawn) continue;
      if (other.master === pawn.id) other.master = null;
      if (other.aimTarget && other.aimTarget.k === 'p' && other.aimTarget.id === pawn.id) {
        other.aimTarget = null;
      }
      if (other.draftTarget && other.draftTarget.k === 'p' && other.draftTarget.id === pawn.id) {
        other.draftTarget = null;
      }
    }
    if (pawn.deSpawn) pawn.deSpawn();
    else if (map && map.removePawn) map.removePawn(pawn);
    pawn.map = null;
    pawn.path = null;
    pawn.pathIdx = 0;
  }

  var MAP_SCOPED_RESETS = ['Combat', 'Caravans', 'Trade', 'Power', 'Breakdowns', 'Tactics',
                           'Economy', 'Prison', 'Contraband', 'Gore'];

  Starmap.arrive = function (game) {
    game = game || G();
    if (!game) return false;
    var oldMap = game.map;
    var voyage = state.voyage;
    if (!voyage) return false;
    var planet = Starmap.planetAt(voyage.destinationId);
    if (!planet || !oldMap) { state.phase = 'idle'; state.voyage = null; return false; }
    var MG = sys('MapGen');
    if (!MG || !MG.generate) { state.phase = 'idle'; state.voyage = null; return false; }

    var type = PLANET_TYPES[planet.typeId];

    /* 1. Who is actually going. A traveller who died in the last wave is
          not a traveller, and the launch is refused rather than half
          done if nobody is left. */
    var travellers = [];
    for (var i = 0; i < voyage.travellerIds.length; i++) {
      for (var q = 0; q < oldMap.pawns.length; q++) {
        if (oldMap.pawns[q].id === voyage.travellerIds[i] && !oldMap.pawns[q].dead) {
          travellers.push(oldMap.pawns[q]);
          break;
        }
      }
    }
    if (!travellers.length) {
      state.phase = 'idle';
      state.voyage = null;
      letter('The ship left empty',
        'Whoever was in those caskets did not survive long enough to be frozen. The ship ' +
        'lifted anyway and there is nobody aboard it to wake up.', 'death');
      return false;
    }

    /* 2. The hold, packed before the map that holds it stops existing. */
    var hold = packHold(oldMap);
    var stayedNames = voyage.stayedNames || [];

    /* 3. If the player asked to stay with the people who did not make it,
          the ship simply goes and the colony carries on without them. */
    if (!Starmap.policy.followShip && stayedNames.length) {
      var N0 = sys('Needs');
      for (var s0 = 0; s0 < oldMap.pawns.length; s0++) {
        var watcher = oldMap.pawns[s0];
        if (watcher.faction !== 'player' || watcher.dead || !watcher.isHuman) continue;
        if (travellers.indexOf(watcher) >= 0) continue;
        if (N0 && N0.addThought) N0.addThought(watcher, 'shipLeftBehind');
      }
      for (var d0 = 0; d0 < travellers.length; d0++) detach(travellers[d0], oldMap);
      state.phase = 'idle';
      state.voyage = null;
      state.hops++;
      letter('The ship is gone',
        travellers.length + ' of you left this planet today. ' +
        (stayedNames.length === 1 ? stayedNames[0] + ' watched it go.'
                                  : stayedNames.join(', ') + ' watched it go.') +
        '\n\nThe colony is still here, and so is everything that came to stop the launch.',
        'neutral');
      return true;
    }

    /* 4. Detach the travellers, then tear down everything that is bound
          to a map that is about to stop existing. */
    for (var d = 0; d < travellers.length; d++) detach(travellers[d], oldMap);
    for (var r = 0; r < MAP_SCOPED_RESETS.length; r++) {
      var mod = sys(MAP_SCOPED_RESETS[r]);
      if (mod && typeof mod.reset === 'function') {
        try { mod.reset(); } catch (e) { if (game.debug) msg('reset failed: ' + MAP_SCOPED_RESETS[r]); }
      }
    }
    var B = sys('Beauty');
    if (B && B.reset) { try { B.reset(oldMap); } catch (e2) { /* a stale cache, not a crash */ } }

    /* 5. A new star system means a new planet. Same generator, new seed:
          the save stays one seed plus whatever has happened since. */
    var newSeed = U.randInt(1, 2000000000);
    var W = sys('World');
    if (W && W.generate) {
      W.generate({ seed: newSeed, w: 60, h: 30 });
      var F = sys('Factions');
      if (F && F.generate) F.generate(W);
    }

    var size = planet.mapSize || 140;
    var newMap = MG.generate({
      w: size, h: size, seed: newSeed,
      biome: type.biome, mountainous: !!type.mountainous
    });

    game.map = newMap;
    game.biome = type.biome;
    game.seed = newSeed;
    game.selection.length = 0;

    /* 6. The planet's own rules, written into the terrain before anybody
          is asked to stand on it. */
    applyPlanetRules(game, newMap, planet, type);

    var Rg = sys('Regions');
    if (Rg && Rg.rebuildAll) Rg.rebuildAll(newMap);
    var Pw = sys('Power');
    if (Pw) { if (Pw.markDirty) Pw.markDirty(newMap); if (Pw.update) Pw.update(newMap); }

    /* 7. Put the crew down. */
    var spot = MG.landingSpot ? MG.landingSpot(newMap) : { x: newMap.w >> 1, y: newMap.h >> 1 };
    var cells = freeCellsAround(newMap, spot.x, spot.y, 6, travellers.length + 8);
    var H = sys('Health'), N = sys('Needs');
    for (var t = 0; t < travellers.length; t++) {
      var at = cells[t] || spot;
      var pawn = travellers[t];
      pawn.shipRole = 'board';
      pawn.inCasketId = 0;
      if (pawn.spawn) pawn.spawn(newMap, at.x, at.y);
      else newMap.addPawn(pawn, at.x, at.y);
      if (H && H.addHediff) H.addHediff(pawn, 'cryptosleepSickness', U.randRange(0.55, 0.95));
      if (pawn.needs) {
        pawn.needs.food = 0.45;
        pawn.needs.rest = 0.50;
      }
      if (N && N.addThought) {
        N.addThought(pawn, 'shipLaunched');
        N.addThought(pawn, planet.typeId === 'glitterworld' || planet.typeId === 'rimworld'
          ? 'landfallNewWorld' : 'landfallGrim');
        for (var w = 0; w < stayedNames.length; w++) N.addThought(pawn, 'shipLeftFriends');
      }
    }

    /* 8. The hold, on the ground. */
    var cargoCells = cells.slice(travellers.length);
    for (var h = 0; h < hold.items.length; h++) {
      var into = cargoCells[h % Math.max(1, cargoCells.length)] || spot;
      newMap.addItem(hold.items[h].defId, into.x, into.y, hold.items[h].count);
    }

    /* 9. The storyteller starts again from this planet's difficulty, not
          from a hundred days of somebody else's colony. */
    var S = sys('Storyteller');
    if (S && S.reset) { try { S.reset(game); } catch (e3) { /* it will rebuild on its next tick */ } }
    if (game.recalcWealth) game.recalcWealth();
    game.gameOver = null;

    state.phase = 'landed';
    state.voyage = null;
    state.hops++;
    state.destinationId = null;
    state.world = {
      planetId: planet.id, name: planet.name, typeId: planet.typeId,
      tempOffset: type.tempOffset || 0,
      toxic: !!type.toxic, noWildlife: !!type.noWildlife, ashfall: !!type.ashfall,
      difficulty: planet.difficulty
    };
    state.surveyed = {};
    cluster = null;             /* a new sky over a new world */

    var manifest = Starmap.carryManifest();
    letter('Landfall on ' + planet.name,
      travellers.length + ' colonist' + (travellers.length === 1 ? '' : 's') +
      ' woke up in orbit around ' + planet.name + ' and came down in the pods.\n\n' +
      type.blurb + '\n\n' +
      'CAME WITH YOU\n- ' + manifest.carries.join('\n- ') + '\n\n' +
      'STAYED BEHIND\n- ' + manifest.resets.join('\n- ') + '\n\n' +
      manifest.why +
      (stayedNames.length ? '\n\nLeft on the old planet: ' + stayedNames.join(', ') + '.' : '') +
      (hold.items.length ? '\n\nIn the hold: ' + hold.items.map(function (it) {
        return it.count + ' ' + it.label;
      }).join(', ') + ' (' + hold.kg + ' of ' + hold.capacity + ' kg).' : '\n\nThe hold was empty.'),
      'good', spot);
    return true;
  };

  function freeCellsAround(map, cx, cy, radius, want) {
    var ring = U.cellsInRadius(cx, cy, radius);
    var out = [];
    for (var i = 0; i < ring.length && out.length < want; i++) {
      var x = ring[i][0], y = ring[i][1];
      if (!map.inBounds(x, y) || !map.passable(x, y)) continue;
      var terr = map.terrainAt(x, y);
      if (terr && terr.isWater) continue;
      if (map.buildingAt(x, y)) continue;
      out.push({ x: x, y: y });
    }
    if (!out.length) out.push({ x: cx, y: cy });
    return out;
  }

  /* ============================================================
     8. WHAT A PLANET DOES TO YOU

     Each rule is a real change to the map or to the loop, not a label.
     They are applied once on arrival and kept alive from tickLaunch,
     because an incident that resets the weather must not quietly turn
     an ice world temperate.
     ============================================================ */

  function applyPlanetRules(game, map, planet, type) {
    if (type.tempOffset) {
      game.weather.tempOffset = type.tempOffset;
      game.weather.tempOffsetTicksLeft = 2000000000;
    }
    if (type.noWildlife) sweepWildlife(map);
    if (type.flooded) floodMap(map);
    if (type.ruins) scatterRuins(map, type.ruins === 'steel' ? 'steel' : 'stoneBlocks');
  }

  function sweepWildlife(map) {
    for (var i = map.pawns.length - 1; i >= 0; i--) {
      var p = map.pawns[i];
      if (p.isAnimal && !p.tame && p.faction !== 'player') {
        if (p.deSpawn) p.deSpawn(); else map.removePawn(p);
      }
    }
  }

  /* An ocean world is mostly water, and the buildable ground being
     scarce is the whole character of the place. Marsh and sand near
     existing water go under; the interior stays walkable. */
  function floodMap(map) {
    if (!Defs.has('terrain', 'shallowWater')) return;
    var changed = [];
    for (var y = 0; y < map.h; y++) {
      for (var x = 0; x < map.w; x++) {
        var t = map.terrainAt(x, y);
        if (!t || t.isWater) continue;
        if (t.id !== 'marsh' && t.id !== 'sand' && t.id !== 'mud' && t.id !== 'gravel') continue;
        var nearWater = false;
        for (var d = 0; d < U.ADJ8.length; d++) {
          var nx = x + U.ADJ8[d][0], ny = y + U.ADJ8[d][1];
          if (!map.inBounds(nx, ny)) continue;
          var nt = map.terrainAt(nx, ny);
          if (nt && nt.isWater) { nearWater = true; break; }
        }
        if (!nearWater && !U.chance(0.18)) continue;
        if (!U.chance(nearWater ? 0.72 : 0.35)) continue;
        changed.push([x, y]);
      }
    }
    for (var i = 0; i < changed.length; i++) {
      map.setTerrain(changed[i][0], changed[i][1], 'shallowWater');
      map.markPathDirty(changed[i][0], changed[i][1]);
    }
  }

  /* Ruins are the reason a dead world is worth landing on: walls that
     are already up, and metal lying in them. They go down before the
     landing spot is chosen so the pods never come down inside one. */
  function scatterRuins(map, stuffId) {
    if (!Defs.has('thing', 'wall')) return;
    var clusters = Math.max(4, Math.round(map.size / 2200));
    for (var c = 0; c < clusters; c++) {
      var cx = U.randInt(8, map.w - 9), cy = U.randInt(8, map.h - 9);
      var w = U.randInt(4, 11), h = U.randInt(4, 10);
      for (var y = cy; y < cy + h; y++) {
        for (var x = cx; x < cx + w; x++) {
          if (!map.inBounds(x, y)) continue;
          var edge = (x === cx || y === cy || x === cx + w - 1 || y === cy + h - 1);
          if (!edge) continue;
          if (U.chance(0.30)) continue;            /* collapsed sections */
          if (!map.passable(x, y) || map.buildingAt(x, y)) continue;
          var plant = map.plantAt(x, y);
          if (plant) map.despawnThing(plant);
          var wall = map.spawnThing('wall', x, y, { faction: null, stuff: stuffId });
          if (wall) {
            wall.hp = Math.max(10, Math.round(wall.hp * U.randRange(0.25, 0.7)));
            map.markPathDirty(x, y);
          }
        }
      }
      /* Somebody lived here, and they left in a hurry. */
      var lootX = U.clamp(cx + (w >> 1), 1, map.w - 2);
      var lootY = U.clamp(cy + (h >> 1), 1, map.h - 2);
      if (map.passable(lootX, lootY)) {
        map.addItem('steel', lootX, lootY, U.randInt(20, 70));
        if (U.chance(0.45)) map.addItem('components', lootX, lootY, U.randInt(1, 5));
        if (U.chance(0.25)) map.addItem('silver', lootX, lootY, U.randInt(20, 120));
      }
    }
  }

  function tickPlanetRules(game) {
    var w = state.world;
    if (!w) return;
    var map = game.map;
    if (!map) return;

    /* A heat wave is allowed to override an ice world for its duration;
       what is not allowed is for the ice world to quietly stay warm
       once the heat wave ends. */
    if (w.tempOffset && game.weather.tempOffsetTicksLeft < TICKS_PER_DAY) {
      game.weather.tempOffset = w.tempOffset;
      game.weather.tempOffsetTicksLeft = 2000000000;
    }

    if (w.noWildlife && (game.tick % (SLOW * 8)) === 0) sweepWildlife(map);

    if (w.toxic) {
      var H = sys('Health');
      if (!H || !H.addHediff) return;
      var list = map.pawns;
      for (var i = 0; i < list.length; i++) {
        var pawn = list[i];
        if (pawn.dead || !pawn.isHuman) continue;
        var roofed = map.hasRoofAt(pawn.x, pawn.y);
        if (roofed) continue;
        H.addHediff(pawn, 'toxicBuildup', 0.010);
      }
    }

    if (w.ashfall && (game.tick % (SLOW * 12)) === 0 && U.chance(0.22)) {
      var P = sys('Plants');
      if (P && P.startFire) {
        var fx = U.randInt(1, map.w - 2), fy = U.randInt(1, map.h - 2);
        P.startFire(map, fx, fy);
        msg('Hot ash is falling.', 'threat', { x: fx, y: fy });
      }
    }

    /* Cryptosleep sickness decays through health.js's negative rate but
       nothing removes it at zero, so this file cleans up after itself. */
    if ((game.tick % (SLOW * 4)) === 0) {
      var Hh = sys('Health');
      if (Hh && Hh.hediff && Hh.removeHediff) {
        var col = map.colonists ? map.colonists() : [];
        for (var c = 0; c < col.length; c++) {
          var hd = Hh.hediff(col[c], 'cryptosleepSickness');
          if (hd && hd.severity <= 0.02) Hh.removeHediff(col[c], 'cryptosleepSickness');
        }
      }
    }
  }

  /* ============================================================
     9. THE EARLIER RUNGS

     Two buildings that pay for themselves long before the ship does,
     so the space tree is worth starting even for a colony that will
     never finish it.
     ============================================================ */

  Starmap.canShuttle = function (pawns) {
    var g = G();
    var map = g && g.map;
    if (!map) return { ok: false, reason: 'There is no colony here.' };
    var shuttles = (map.byDef('escapeShuttle') || []).filter(function (t) {
      return t.spawned && !t.isBlueprint && !t.isFrame && t.faction === 'player';
    });
    if (!shuttles.length) return { ok: false, reason: 'No escape shuttle is built.' };
    pawns = (pawns || []).filter(Boolean);
    if (!pawns.length) return { ok: false, reason: 'Nobody is aboard the shuttle.' };
    if (pawns.length > 3) return { ok: false, reason: 'A shuttle seats three. You picked ' + pawns.length + '.' };
    var C = sys('Caravans');
    if (!C || !C.form) return { ok: false, reason: 'There is nowhere on this planet to fly to.' };
    return { ok: true, reason: '', shuttle: shuttles[0] };
  };

  Starmap.launchShuttle = function (opts) {
    opts = opts || {};
    var g = G();
    var pawns = (opts.pawns || []).filter(Boolean);
    var check = Starmap.canShuttle(pawns);
    if (!check.ok) { msg('Shuttle refused: ' + check.reason); return null; }

    var C = sys('Caravans');
    var W = sys('World');
    var dest = opts.destinationTile;
    if (dest === undefined || dest === null) {
      if (!W || !W.generated) { msg('Shuttle refused: no world to fly across.'); return null; }
      var near = W.nearestSettlement ? W.nearestSettlement(W.colonyTile) : null;
      dest = near ? near.tile : null;
    }
    if (dest === null || dest === undefined) {
      msg('Shuttle refused: pick a tile to fly to.');
      return null;
    }

    var caravan = C.form({
      pawns: pawns, items: opts.items || [], destinationTile: dest,
      purpose: opts.purpose || 'visit'
    });
    if (!caravan) return null;

    /* It flies. Whatever the walk would have cost, the burn costs about
       an eighth of it - which is the entire point of owning a shuttle. */
    caravan.ticksToArrive = Math.max(SLOW, Math.round(caravan.ticksToArrive * 0.12));
    caravan.totalTicks = Math.max(caravan.ticksToArrive, 1);
    caravan.label = 'Shuttle flight';

    var shuttle = check.shuttle;
    var at = { x: shuttle.x, y: shuttle.y };
    if (g && g.map) g.map.despawnThing(shuttle);
    state.shuttleUsed++;

    letter('The shuttle is gone',
      pawns.map(nameOf).join(', ') + ' lifted off and the airframe went with them. ' +
      'It was built for one burn and it has had it. They will be on the ground in ' +
      U.fmt(caravan.ticksToArrive / TICKS_PER_DAY, 1) + ' days.',
      'neutral', at);
    return caravan;
  };

  function tickPlatform(game) {
    var map = game.map;
    if (!map || !map.byDef) return;
    var P = sys('Power');
    var pads = map.byDef('orbitalPlatform') || [];
    var live = 0;
    for (var i = 0; i < pads.length; i++) {
      var pad = pads[i];
      if (!pad.spawned || pad.isBlueprint || pad.isFrame || pad.faction !== 'player') continue;
      if (P && P.isPowered && !P.isPowered(pad)) continue;
      live++;
    }
    if (!live) return;

    /* Docking fees: small, steady, and worth about as much as one good
       trade run a season. It scales with what the colony is worth
       because a rich colony is a berth worth having. */
    if ((game.tick % (SLOW * 10)) === 0) {
      var fee = Math.round(U.clamp(6 + (game.wealth || 0) / 2200, 6, 55) * live);
      if (fee > 0) {
        var spot = platformDropSpot(map, pads);
        if (spot) {
          map.addItem('silver', spot.x, spot.y, fee);
          state.platformEarned += fee;
        }
      }
    }

    if (state.platformCooldown > 0) state.platformCooldown = Math.max(0, state.platformCooldown - SLOW);
  }

  function platformDropSpot(map, pads) {
    for (var i = 0; i < pads.length; i++) {
      var cells = freeCellsAround(map, pads[i].x, pads[i].y, 4, 1);
      if (cells.length) return cells[0];
    }
    return null;
  }

  /* Call a ship down instead of waiting for one. The platform is what
     turns trade from something that happens to you into something you
     do, which is the point of building it. */
  Starmap.hailTrader = function (factionId) {
    var g = G();
    var map = g && g.map;
    if (!map) return { ok: false, reason: 'There is no colony here.' };
    var P = sys('Power');
    var pads = (map.byDef('orbitalPlatform') || []).filter(function (t) {
      return t.spawned && !t.isBlueprint && !t.isFrame && t.faction === 'player' &&
        (!P || !P.isPowered || P.isPowered(t));
    });
    if (!pads.length) return { ok: false, reason: 'No powered orbital trade platform.' };
    if (state.platformCooldown > 0) {
      return { ok: false, reason: 'The transmitter is still cooling: ' +
        U.fmt(state.platformCooldown / TICKS_PER_DAY, 1) + ' days.' };
    }
    var Tr = sys('Trade');
    if (!Tr || !Tr.arrivingTrader) return { ok: false, reason: 'Nobody is listening.' };

    var fid = factionId || null;
    if (!fid) {
      var F = sys('Factions');
      var all = (F && F.all) ? F.all().filter(function (f) { return !f.hostile && f.kind && f.kind.canTrade !== false; }) : [];
      fid = all.length ? U.pick(all).id : 'neutral';
    }
    var ok = false;
    try { ok = !!Tr.arrivingTrader(g, fid); } catch (e) { ok = false; }
    if (!ok) return { ok: false, reason: 'Nobody answered the hail this time.' };
    state.platformCooldown = Math.round(2.5 * TICKS_PER_DAY);
    msg('A trade ship answered the platform.', 'good');
    return { ok: true, reason: '' };
  };

  /* ============================================================
     10. INCIDENTS

     events.js loads below this file, so these go in on the first tick
     rather than at load. Both of them exist to make the sky feel
     inhabited long before a colony can reach it.
     ============================================================ */

  var incidentsReady = false;

  function ensureIncidents() {
    if (incidentsReady) return;
    var I = sys('Incidents');
    if (!I || !I.register) return;
    incidentsReady = true;

    I.register({
      id: 'shipChunkCrash', label: 'ship chunk', category: 'good', minDay: 8,
      weight: function () { return 0.7; },
      fire: function (game) {
        var map = game.map;
        if (!map) return false;
        var MG = sys('MapGen');
        var spot = MG && MG.dropPodSpot ? MG.dropPodSpot(map) : null;
        if (!spot) return false;
        var steel = U.randInt(35, 90);
        var comps = U.randInt(1, 5);
        map.addItem('steel', spot.x, spot.y, steel);
        map.addItem('components', spot.x, spot.y, comps);
        if (U.chance(0.4) && Defs.has('thing', 'chemfuel')) {
          map.addItem('chemfuel', spot.x, spot.y, U.randInt(20, 60));
        }
        var P = sys('Plants');
        if (P && P.startFire && U.chance(0.5)) P.startFire(map, spot.x, spot.y);
        letter('Something fell out of the sky',
          'A piece of somebody else\'s ship came down hard and broke up on the way in. ' +
          steel + ' steel and ' + comps + ' component' + (comps === 1 ? '' : 's') +
          ' are scattered across the impact, and the grass around it is on fire.',
          'good', spot);
        return true;
      }
    });

    I.register({
      id: 'derelictSignal', label: 'derelict signal', category: 'misc', minDay: 14,
      weight: function (game) {
        var R = sys('Research');
        return (R && R.isDone && R.isDone('shipSensors')) ? 1.0 : 0.35;
      },
      fire: function () {
        var planets = ensureCluster().planets;
        if (!planets.length) return false;
        var target = U.pick(planets);
        var before = Starmap.knownOf(target.id).level;
        state.surveyed[target.id] = (state.surveyed[target.id] || 0) + U.randRange(0.12, 0.28);
        var after = Starmap.knownOf(target.id);
        letter('A signal from ' + target.name,
          'Something old and automatic is still transmitting from ' + target.name +
          ', out past ' + target.systemName + '. Most of it is corrupted. What survived ' +
          'the decoding is this:\n\n- ' +
          (after.facts.length ? after.facts.join('\n- ') : 'nothing anyone can make sense of.') +
          '\n\nKnowledge of that world went from ' + U.pct(before) + ' to ' + U.pct(after.level) + '.',
          'neutral');
        return true;
      }
    });
  }

  /* ============================================================
     11. THE HEARTBEAT

     game.js resolves this by name and calls it every 500 ticks. It is
     the only entry point this file needs, and it is cheap when nothing
     is happening.
     ============================================================ */

  /* Nothing calls Starmap.load from save.js, so a colony loaded in the
     middle of an ignition comes back with the phase reset and colonists
     still flagged as frozen. Opening every lid is the safe answer: a
     colonist standing in an open casket can walk out of it, and one
     still marked aboard when nothing is counting down cannot. */
  function sweepCaskets(map) {
    if (state.phase === 'countdown' || state.phase === 'voyage') return;
    var caskets = map.byDef ? (map.byDef('shipCasket') || []) : [];
    var i;
    for (i = 0; i < caskets.length; i++) if (caskets[i].occupantId) caskets[i].occupantId = 0;
    var col = map.colonists ? map.colonists() : [];
    for (i = 0; i < col.length; i++) if (col[i].inCasketId) col[i].inCasketId = 0;
  }

  Starmap.tickLaunch = function (game) {
    game = game || G();
    if (!game || !game.map) return;
    ensureIncidents();

    /* A new colony rewinds the clock, and nothing calls Starmap.reset
       for us. A tick that has gone backwards by more than a day is the
       only reliable signal that this is not the same run. */
    if (game.tick + TICKS_PER_DAY < state.lastSeenTick) Starmap.reset();
    state.lastSeenTick = game.tick;

    ensureCluster();

    if (state.phase === 'countdown') tickCountdown(game);
    else if (state.phase === 'voyage') Starmap.arrive(game);
    else sweepCaskets(game.map);

    tickPlanetRules(game);
    tickPlatform(game);

    /* Dishes pointed at nothing else still learn something. Slow enough
       that a sensor cluster is a long-term investment rather than a
       button, fast enough to matter over a season. */
    if (state.phase !== 'voyage' && (game.tick % (SLOW * 20)) === 0) {
      var strength = sensorStrength(game.map);
      if (strength > 0) {
        var planets = ensureCluster().planets;
        var pick = planets[Math.floor(U.rand() * planets.length)];
        if (pick) {
          state.surveyed[pick.id] = U.clamp(
            (state.surveyed[pick.id] || 0) + strength * 0.02, 0, 0.6);
        }
      }
    }
  };

  /* ============================================================
     12. WHAT THE UI ASKS FOR

     A hundred-hour goal needs a progress bar, and a progress bar needs
     somewhere to read its numbers from that is not a guess.
     ============================================================ */

  Starmap.progressSummary = function (map) {
    var g = G();
    map = map || (g && g.map);
    var R = sys('Research');
    var projects = ['biofuelRefining', 'shipStructural', 'cryptosleep', 'shipReactorTech',
                    'shipEngineTech', 'shipComputing', 'shipSensors'];
    var researchDone = 0;
    var researchRows = [];
    for (var i = 0; i < projects.length; i++) {
      var def = Defs.maybe('research', projects[i]);
      var done = !!(R && R.isDone && R.isDone(projects[i]));
      var pct = done ? 1 : (R && R.percentOf ? R.percentOf(projects[i]) : 0);
      if (done) researchDone++;
      researchRows.push({
        id: projects[i], label: (def && def.label) || projects[i],
        done: done, percent: Math.round(pct * 100) / 100
      });
    }

    var parts = map ? Starmap.shipParts(map) : [];
    var built = 0, wanted = 0;
    for (var p = 0; p < parts.length; p++) {
      built += Math.min(parts[p].have, parts[p].need);
      wanted += parts[p].need;
    }
    var fuelHave = Starmap.fuelAboard(map);
    var fuelNeed = Starmap.fuelNeeded(map, Starmap.destination());

    /* Three thirds: know how, build it, fuel it. It is the shape of the
       whole endgame and it is the shape of the bar. */
    var research = researchDone / projects.length;
    var structure = wanted ? U.clamp01(built / wanted) : 0;
    var fuel = fuelNeed ? U.clamp01(fuelHave / fuelNeed) : 0;
    var percent = U.clamp01(research * 0.30 + structure * 0.45 + fuel * 0.25);

    var check = map ? Starmap.validateShip(map) : { ok: false, missing: [], problems: [] };
    var planet = Starmap.planetAt(Starmap.destination());

    var label;
    if (state.phase === 'countdown') {
      label = 'Ignition in ' + U.fmt(state.countdownLeft / TICKS_PER_DAY, 1) + ' days';
    } else if (state.phase === 'voyage') {
      label = 'In transit';
    } else if (check.ok) {
      label = 'Ready to launch';
    } else if (research < 1) {
      label = 'Researching (' + researchDone + ' of ' + projects.length + ')';
    } else if (structure < 1) {
      label = 'Building the ship (' + built + ' of ' + wanted + ' parts)';
    } else {
      label = 'Fuelling (' + fuelHave + ' of ' + fuelNeed + ')';
    }

    return {
      phase: state.phase,
      label: label,
      percent: Math.round(percent * 100) / 100,
      research: { percent: Math.round(research * 100) / 100, projects: researchRows },
      structure: { percent: Math.round(structure * 100) / 100, built: built, needed: wanted,
                   parts: parts, mass: Starmap.shipMass(map) },
      fuel: { have: fuelHave, need: fuelNeed,
              percent: Math.round(fuel * 100) / 100,
              capacity: countOf(map, 'shipFuelTank') * FUEL_PER_TANK },
      destination: planet ? {
        id: planet.id, name: planet.name, type: planet.typeLabel,
        distanceLy: planet.distanceLy, difficulty: planet.difficulty,
        known: Starmap.knownOf(planet.id)
      } : null,
      countdown: state.phase === 'countdown' ? {
        ticksLeft: state.countdownLeft, total: state.countdownTotal,
        days: Math.round((state.countdownLeft / TICKS_PER_DAY) * 10) / 10,
        wave: state.wave,
        aboard: map ? Starmap.aboard(map).length : 0,
        colonists: map && map.colonists ? map.colonists().length : 0
      } : null,
      blockers: check.missing.map(function (m) {
        return 'Missing ' + m.short + ' ' + m.label + ' (' + m.have + '/' + m.need + ')';
      }).concat(check.problems),
      ok: !!check.ok,
      hops: state.hops,
      platformEarned: state.platformEarned,
      shuttlesUsed: state.shuttleUsed
    };
  };

  /* A plain-text version of the same thing, for the message log, a
     tooltip, or a developer staring at a terminal. */
  Starmap.report = function (map) {
    var s = Starmap.progressSummary(map);
    var lines = ['SHIP: ' + s.label + ' (' + U.pct(s.percent) + ')'];
    if (s.destination) {
      lines.push('Destination: ' + s.destination.name + ', ' + s.destination.type +
        ', ' + s.destination.distanceLy + ' ly, knowledge ' + U.pct(s.destination.known.level));
    }
    lines.push('Mass ' + s.structure.mass + ' kg, fuel ' + s.fuel.have + '/' + s.fuel.need);
    for (var i = 0; i < s.structure.parts.length; i++) {
      var p = s.structure.parts[i];
      lines.push('  ' + p.thingLabel + ': ' + p.have + '/' + p.need +
        (p.short ? '  <- ' + p.why : ''));
    }
    for (var b = 0; b < s.blockers.length; b++) lines.push('  ! ' + s.blockers[b]);
    return lines.join('\n');
  };

  /* Every world in the cluster, ready for a list on a screen. */
  Starmap.clusterReport = function () {
    var systems = Starmap.systems();
    var out = [];
    for (var i = 0; i < systems.length; i++) {
      var sysRow = { id: systems[i].id, name: systems[i].name, star: systems[i].star,
                     distanceLy: systems[i].distanceLy, planets: [] };
      for (var j = 0; j < systems[i].planetIds.length; j++) {
        var planet = Starmap.planetAt(systems[i].planetIds[j]);
        if (!planet) continue;
        var known = Starmap.knownOf(planet.id);
        sysRow.planets.push({
          id: planet.id, name: planet.name, type: planet.typeLabel,
          distanceLy: planet.distanceLy, difficulty: planet.difficulty,
          gravity: planet.gravity, moons: planet.moons,
          fuel: Starmap.fuelNeeded(null, planet.id),
          knowledge: known.level, summary: known.summary,
          facts: known.facts, rumours: known.rumours,
          blurb: planet.blurb, detail: known.detail,
          selected: planet.id === Starmap.destination()
        });
      }
      out.push(sysRow);
    }
    return out;
  };

  /* ============================================================
     13. SAVE

     save.js does not know this file exists, so the state is written
     to be reconstructible: the cluster is a pure function of the game
     seed, and everything per-pawn (shipRole, inCasketId) and per-thing
     (occupantId, fuel) already rides along in save.js's own blobs.
     What is left is the sequence itself.
     ============================================================ */

  Starmap.save = function () {
    return {
      v: 1,
      phase: state.phase,
      destinationId: state.destinationId,
      countdownLeft: state.countdownLeft,
      countdownTotal: state.countdownTotal,
      wave: state.wave,
      nextWaveTick: state.nextWaveTick,
      launchTick: state.launchTick,
      hops: state.hops,
      surveyed: JSON.parse(JSON.stringify(state.surveyed || {})),
      history: (state.history || []).slice(-12),
      world: state.world ? JSON.parse(JSON.stringify(state.world)) : null,
      platformCooldown: state.platformCooldown,
      platformEarned: state.platformEarned,
      shuttleUsed: state.shuttleUsed,
      abortedFuel: state.abortedFuel,
      lastSeenTick: state.lastSeenTick,
      policy: {
        countdownDays: Starmap.policy.countdownDays,
        siegeScale: Starmap.policy.siegeScale,
        followShip: Starmap.policy.followShip,
        autoBoard: Starmap.policy.autoBoard,
        holdKgPerHull: Starmap.policy.holdKgPerHull
      }
    };
  };

  Starmap.load = function (obj) {
    Starmap.reset();
    if (!obj) return false;
    /* A voyage caught mid-flight in a save cannot be resumed: the map it
       was leaving is the map that just loaded. Drop it back to idle
       rather than replace a freshly restored colony. */
    var phase = obj.phase === 'voyage' ? 'idle' : (obj.phase || 'idle');
    state.phase = phase;
    state.destinationId = obj.destinationId || null;
    state.countdownLeft = obj.countdownLeft || 0;
    state.countdownTotal = obj.countdownTotal || 0;
    state.wave = obj.wave || 0;
    state.nextWaveTick = obj.nextWaveTick || 0;
    state.launchTick = obj.launchTick || 0;
    state.hops = obj.hops || 0;
    state.surveyed = obj.surveyed || {};
    state.history = obj.history || [];
    state.world = obj.world || null;
    state.platformCooldown = obj.platformCooldown || 0;
    state.platformEarned = obj.platformEarned || 0;
    state.shuttleUsed = obj.shuttleUsed || 0;
    state.abortedFuel = obj.abortedFuel || 0;
    state.lastSeenTick = obj.lastSeenTick || 0;
    if (obj.policy) {
      var k;
      for (k in obj.policy) {
        if (Starmap.policy[k] !== undefined) Starmap.policy[k] = obj.policy[k];
      }
    }
    return true;
  };

  /* Constants other files may want to read rather than restate. */
  Starmap.PLANET_TYPES = PLANET_TYPES;
  Starmap.PART_DEF_IDS = PART_DEF_IDS;
  Starmap.FUEL_PER_TANK = FUEL_PER_TANK;
  Starmap.MASS_PER_ENGINE = MASS_PER_ENGINE;

  root.Starmap = Starmap;
})(this);
