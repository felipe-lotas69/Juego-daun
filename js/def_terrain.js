/* ============================================================
   def_terrain.js - every surface a pawn can stand on.

   Two numbers in here are read by systems all over the game, so they
   are worth stating once, plainly:

   pathCost is EXTRA move ticks per tile, added on top of the 13 ticks a
   pawn spends crossing an orthogonal tile (18 diagonal). So soil at 0 is
   the reference surface, mud at 10 is nearly half speed again, and
   shallow water at 22 is roughly a third of walking pace - enough that a
   pathfinder happily detours around a pond instead of wading it. Deep
   water carries an absurd cost as well as passable:false; the flag is
   what actually blocks movement, the number just guarantees that any
   cost arithmetic treats it as a last resort rather than a shortcut.
   The value stays well inside Uint16 so map.pathCost never wraps.

   fertility multiplies plant growth rate. Soil is the 1.0 baseline that
   crop grow-days are quoted against, rich soil 1.4 grows a harvest in
   about five sevenths of the time, and anything at 0 grows nothing at
   all. supportsPlants is the separate, harder question of whether a seed
   can be put in the ground here: you cannot sow on a carpet even though
   a carpet is perfectly walkable.

   cleanliness feeds room stats. Bare ground is dirty (-1) and drags a
   hospital or kitchen down; smooth built floors are the only way to push
   a room positive. beauty works the same way but for mood.

   color/color2 are two shades of the same surface. The renderer picks
   between them per tile from a hash of the coordinates, which breaks up
   large expanses of one flat colour without storing anything per tile.
   ============================================================ */
(function (root) {
  'use strict';

  var Defs = root.Defs;

  /* Natural ground: never built, never removed, always fertile-ish. */
  var NATURAL = {
    isNatural: true,
    isWater: false,
    passable: true,
    supportsPlants: true,
    beauty: 0,
    cleanliness: -1,
    category: 'terrain',
    buildCategory: null,
    buildCost: null,
    workToBuild: 0,
    researchPrerequisite: null,
    removable: false
  };

  Defs.add('terrain', {

    soil: {
      label: 'soil',
      description: 'Ordinary dirt. Grows crops at the standard rate and tracks mud everywhere.',
      color: '#6b533b', color2: '#755c42',
      pathCost: 0,
      fertility: 1.0,
      terrainCategory: 'soil'
    },

    richSoil: {
      label: 'rich soil',
      description: 'Dark, deep loam. Plants here grow noticeably faster than on ordinary soil.',
      color: '#4f3d2b', color2: '#584431',
      pathCost: 0,
      fertility: 1.4,
      terrainCategory: 'soil'
    },

    gravel: {
      label: 'gravel',
      description: 'Loose stone chips over thin dirt. Hardy plants manage; crops sulk.',
      color: '#7a7268', color2: '#6d665d',
      pathCost: 1,
      fertility: 0.6,
      terrainCategory: 'sand'
    },

    sand: {
      label: 'sand',
      description: 'Soft, shifting sand. Slow to walk on and almost nothing will root in it.',
      color: '#c2b280', color2: '#cbbc8c',
      pathCost: 3,
      fertility: 0.05,
      terrainCategory: 'sand'
    },

    marsh: {
      label: 'marsh',
      description: 'Waterlogged ground thick with reeds. Fertile, but every step is a fight.',
      color: '#4a5a3c', color2: '#55653f',
      pathCost: 12,
      fertility: 0.9,
      terrainCategory: 'soil'
    },

    mud: {
      label: 'mud',
      description: 'Churned wet earth. Slows movement badly and makes a room filthy.',
      color: '#55463a', color2: '#5e4e40',
      pathCost: 10,
      fertility: 0.7,
      beauty: -1,
      cleanliness: -1.2,
      terrainCategory: 'soil'
    },

    shallowWater: {
      label: 'shallow water',
      description: 'Knee-deep water. Passable at a wade, and nothing can be built or sown in it.',
      color: '#3b7191', color2: '#34657f',
      pathCost: 22,
      fertility: 0,
      isWater: true,
      supportsPlants: false,
      cleanliness: 0,
      terrainCategory: 'water'
    },

    deepWater: {
      label: 'deep water',
      description: 'Too deep to wade. Colonists will not enter it.',
      color: '#2f5d78', color2: '#27506a',
      /* Impassability lives in `passable`; this number only stops any
         additive cost math from ever preferring the lake. */
      pathCost: 10000,
      fertility: 0,
      passable: false,
      isWater: true,
      supportsPlants: false,
      cleanliness: 0,
      terrainCategory: 'water'
    },

    rockFloor: {
      label: 'rough stone',
      description: 'Bare bedrock, exposed by mining. Clean enough, but nothing grows on stone.',
      color: '#6e6e78', color2: '#77777f',
      pathCost: 0,
      fertility: 0,
      supportsPlants: false,
      cleanliness: 0,
      terrainCategory: 'rock'
    }

  }, NATURAL);

  /* Constructed floors. Everything here is placed as a blueprint, paid
     for in materials, and can be ripped up again, so they all share the
     buildCategory/removable half of the def. */
  var FLOOR = {
    isNatural: false,
    isWater: false,
    passable: true,
    supportsPlants: false,
    fertility: 0,
    pathCost: 0,
    beauty: 0,
    terrainCategory: 'floor',
    category: 'terrain',
    buildCategory: 'floor',
    researchPrerequisite: null,
    removable: true
  };

  Defs.add('terrain', {

    woodFloor: {
      label: 'wooden floor',
      description: 'Planks laid over the ground. Cheap, warm underfoot, and it burns.',
      color: '#8a6134', color2: '#94693a',
      buildCost: { wood: 3 },
      workToBuild: 110,
      beauty: 1,
      cleanliness: 0.3
    },

    stoneFloor: {
      label: 'stone tile floor',
      description: 'Cut blocks fitted together. Slow to lay, but it will outlast the colony.',
      color: '#7d7a74', color2: '#86837c',
      buildCost: { stoneBlocks: 4 },
      workToBuild: 200,
      cleanliness: 0.4,
      /* Blocks only exist once someone has learned to cut them. */
      researchPrerequisite: 'stonecutting'
    },

    concreteFloor: {
      label: 'concrete',
      description: 'Poured stone aggregate. Ugly, hard-wearing, and easy to keep clean.',
      color: '#8b8b86', color2: '#94948f',
      buildCost: { stoneBlocks: 5 },
      workToBuild: 230,
      cleanliness: 0.4,
      researchPrerequisite: 'stonecutting'
    },

    steelFloor: {
      label: 'steel floor',
      description: 'Riveted steel plate. The cleanest surface a colony can walk on.',
      color: '#8f97a3', color2: '#99a1ad',
      buildCost: { steel: 6 },
      workToBuild: 220,
      cleanliness: 0.5
    },

    carpet: {
      label: 'carpet',
      description: 'Woven cloth underfoot. Pleasant to live on, and a nuisance to keep clean.',
      color: '#7a3f4e', color2: '#85485a',
      buildCost: { cloth: 6 },
      workToBuild: 150,
      beauty: 2,
      cleanliness: -0.2
    }

  }, FLOOR);

})(this);
