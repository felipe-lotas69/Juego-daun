/* ============================================================
   def_terrain.js - every tile surface in the game.

   Four numbers on these defs are read by systems far away from here, so
   they are worth stating once, plainly:

   pathCost   Extra ticks added to a step onto the tile, on top of the
              base 13 for an orthogonal move (18 diagonal). So sand at 6
              is roughly half again as slow as soil, and shallow water at
              22 is about 2.7x. map.pathCost is a Uint16Array where 65535
              means impassable, so every value here stays small; deep
              water is blocked by passable:false, not by a huge cost.

   fertility  Straight multiplier on plant growth rate. 0 means nothing
              grows at all, 1.0 is ordinary soil, 1.4 is the rich soil a
              grower actually wants their rice on. Anything below about
              0.5 is not worth sowing, which is what sand is for.

   cleanliness Summed over a room's cells by regions.js and averaged; the
              result drives the dirty/clean room thought and the surgery
              odds. Bare earth is dirty (-1) because it tracks in filth,
              constructed floors are neutral to clean, and carpet is
              slightly negative because it holds dirt.

   beauty     Also summed per room. Natural ground is 0; a floor you paid
              for may be worth a point, and carpet is the cheap way to
              make a bedroom pleasant.

   Registration order is load-bearing in one place only: `soil` must be
   first, because map.terrain is a zero-filled Uint8Array and a freshly
   allocated map should read as plain dirt before mapgen touches it.
   ============================================================ */
(function (root) {
  'use strict';

  var Defs = root.Defs;

  /* Shared by everything that was already there when the colonists
     landed. Natural ground is never "removable" - you build over it. */
  var NATURAL = {
    description: '',
    beauty: 0,
    cleanliness: -1,
    isWater: false,
    isNatural: true,
    passable: true,
    supportsPlants: true,
    terrainCategory: 'soil',
    buildCost: null,
    workToBuild: 0,
    buildCategory: null,
    researchPrerequisite: null,
    removable: false
  };

  Defs.add('terrain', {

    soil: {
      label: 'soil',
      description: 'Ordinary dirt. Plants grow at their normal rate here.',
      color: '#6b533b',
      color2: '#755b41',
      pathCost: 0,
      fertility: 1.0,
      cleanliness: -1
    },

    richSoil: {
      label: 'rich soil',
      description: 'Dark, heavily nutrified earth. Crops grow much faster on it, ' +
        'so it is worth laying a growing zone over every patch you find.',
      color: '#4f3d2b',
      color2: '#5a462f',
      pathCost: 0,
      fertility: 1.4,
      cleanliness: -1
    },

    gravel: {
      label: 'gravel',
      description: 'Loose stones over thin soil. Walkable, poor for farming.',
      color: '#78706a',
      color2: '#8a8179',
      pathCost: 1,
      fertility: 0.7,
      cleanliness: -1,
      terrainCategory: 'rock'
    },

    sand: {
      label: 'sand',
      description: 'Dry, shifting sand. Slow to cross and almost nothing will root in it.',
      color: '#c2b280',
      color2: '#cdbd8e',
      pathCost: 6,
      fertility: 0.05,
      cleanliness: -1,
      terrainCategory: 'sand'
    },

    mud: {
      label: 'mud',
      description: 'Waterlogged earth churned into slop. It slows movement badly, ' +
        'holds no seed, and colonists walk filth off it into every room they enter.',
      color: '#4a3a2b',
      color2: '#55442f',
      pathCost: 10,
      fertility: 0,
      cleanliness: -2,
      supportsPlants: false
    },

    marsh: {
      label: 'marsh',
      description: 'Standing water over deep soil. Fertile, but wading through it ' +
        'costs more time than the harvest usually pays back.',
      color: '#4a5740',
      color2: '#3f4b38',
      pathCost: 16,
      fertility: 0.9,
      cleanliness: -1.5
    },

    shallowWater: {
      label: 'shallow water',
      description: 'Knee-deep water. Passable, but slowly, and nothing can be built on it.',
      color: '#3a708c',
      color2: '#45809c',
      pathCost: 22,
      fertility: 0,
      cleanliness: 0,
      isWater: true,
      supportsPlants: false,
      terrainCategory: 'water'
    },

    deepWater: {
      /* Impassable by flag rather than by cost: the pathfinder never looks
         at pathCost once passable is false, and keeping the number small
         means nothing overflows if a caller sums terrain and building cost. */
      label: 'deep water',
      description: 'Open water, too deep to wade. Colonists will walk the long way around.',
      color: '#2f5d78',
      color2: '#264e66',
      pathCost: 60,
      fertility: 0,
      cleanliness: 0,
      isWater: true,
      passable: false,
      supportsPlants: false,
      terrainCategory: 'water'
    },

    rockFloor: {
      label: 'rough stone',
      description: 'Bare bedrock, exposed by mining out the mountain above it. ' +
        'Nothing grows, but it is solid ground and costs nothing to have.',
      color: '#6e6e78',
      color2: '#7a7a84',
      pathCost: 0,
      fertility: 0,
      cleanliness: -0.6,
      supportsPlants: false,
      terrainCategory: 'rock'
    }

  }, NATURAL);

  /* Constructed floors. These are the only terrains the architect menu
     offers, and the only ones a colonist can tear up again, so they all
     carry buildCategory 'floor' and removable:true. None of them supports
     plants: once you pave a tile, that tile is done growing things. */
  var FLOOR = {
    description: '',
    beauty: 0,
    fertility: 0,
    pathCost: 0,
    isWater: false,
    isNatural: false,
    passable: true,
    supportsPlants: false,
    terrainCategory: 'floor',
    buildCategory: 'floor',
    researchPrerequisite: null,
    removable: true
  };

  Defs.add('terrain', {

    woodFloor: {
      label: 'wooden floor',
      description: 'Planks laid over the ground. Cheap, quick, and warmer to look at ' +
        'than bare dirt - but it burns.',
      color: '#8a6134',
      color2: '#7b562e',
      cleanliness: 0,
      beauty: 1,
      buildCost: { wood: 3 },
      workToBuild: 110
    },

    stoneFloor: {
      label: 'stone tile',
      description: 'Cut blocks fitted flush. Slow to lay and heavy on blocks, but it ' +
        'will not burn and it makes a room look built rather than camped in.',
      color: '#767078',
      color2: '#6a6570',
      cleanliness: 0.3,
      beauty: 1,
      buildCost: { stoneBlocks: 4 },
      workToBuild: 200,
      researchPrerequisite: 'stonecutting'
    },

    concreteFloor: {
      label: 'concrete',
      description: 'Crushed stone poured flat. Ugly, cheap to work, and easy to keep ' +
        'clean, which is what you want under a kitchen.',
      color: '#8c8c86',
      color2: '#81817b',
      cleanliness: 0.4,
      buildCost: { stoneBlocks: 5 },
      workToBuild: 150
    },

    steelFloor: {
      label: 'steel tile',
      description: 'Sheet metal over a prepared base. The cleanest surface a colony ' +
        'can lay, and the one to put under a hospital bed.',
      color: '#8f97a3',
      color2: '#828a96',
      cleanliness: 0.5,
      buildCost: { steel: 6 },
      workToBuild: 220,
      researchPrerequisite: 'smithing'
    },

    carpet: {
      /* The only floor with real beauty, and the only built one with
         negative cleanliness - fibre traps the dirt boots bring in. */
      label: 'carpet',
      description: 'Woven cloth underfoot. It does nothing practical at all and every ' +
        'colonist who sleeps on it is happier for it.',
      color: '#8e3b3b',
      color2: '#7c3333',
      cleanliness: -0.2,
      beauty: 2,
      buildCost: { cloth: 6 },
      workToBuild: 150,
      researchPrerequisite: 'tailoring'
    }

  }, FLOOR);

})(this);
