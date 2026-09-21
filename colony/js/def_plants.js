/* ============================================================
   def_plants.js - grass, shrubs, trees and the five sown crops.

   Four numbers carry most of the meaning here, so they are worth stating
   once rather than re-explaining at every def:

   growDays is real days from a freshly sown seed (growth 0) to a ripe
   plant (growth 1) at fertility 1.0, full daylight and a comfortable
   temperature. plants.js divides it by 60000 to get growth per tick and
   scales that by the cell the plant is standing on. Nothing else in this
   file is a rate; everything else is a threshold or a yield.

   fertility is the terrain's number (soil 1.0, rich soil 1.4, gravel 0.6,
   sand 0.05). minFertility is a hard gate: below it a crop cannot be sown
   and a wild plant will not seed. fertilitySensitivity is how much the
   plant cares once past that gate - growth multiplies by
   1 + (fertility - 1) * sensitivity, so rice at 1.0 ripens 40% faster in
   rich soil while potatoes at 0.45 barely notice, which is exactly why
   potatoes are the crop for bad ground.

   wildDensity is for mapgen only: the chance an eligible, fertile,
   in-biome cell is seeded with this plant during generation. The wild
   densities deliberately sum to roughly 0.9 in temperate forest, so a
   fresh map is nearly covered and clearing land is real work. wildCluster
   is how many mapgen drops around one seed point - berries and trees
   arrive in patches, grass arrives as a carpet.

   harvestYield is the count at growth 1.0; cut early, a plant yields
   proportionally less. harvestDestroys says whether the plant is gone
   afterwards (every crop is - the whole thing comes up) and regrowsTo is
   where growth restarts for the ones that survive, which is how a wild
   berry patch feeds a colony year after year.

   flammable is a 0..1 flammability rather than a boolean: dry grass at
   1.0 catches from a single spark, a thick oak at 0.7 does not.
   ============================================================ */
(function (root) {
  'use strict';

  var Defs = root.Defs;
  var TICKS_PER_DAY = 60000;
  var ALL_BIOMES = ['temperateForest', 'aridShrubland', 'borealForest'];

  /* Shared thing-level shape. Defs.add merges these under each def, so the
     table below only states what is unusual about a plant. */
  var THING_DEFAULTS = {
    category: 'plant',
    passable: true,        /* even a tree is walkable - it just costs */
    blocksLight: false,
    pathCost: 0,
    beauty: 0,
    flammable: 0.9,
    hp: 40,
    nutrition: 0,          /* what a grazing animal gets from eating it whole */
    leavings: null,        /* a destroyed plant leaves nothing; harvesting is how value comes out */
    buildCategory: null,
    buildCost: null,
    workToBuild: 0
  };

  /* Defs.add only merges one level deep, so the nested plant block fills
     itself in here. That way every plant answers every question plants.js
     might ask, including the ones it asks rarely. */
  var PLANT_DEFAULTS = {
    harvestedThing: null, harvestYield: 0, harvestWork: 120,
    harvestMinGrowth: 1.0, harvestDestroys: true, regrowsTo: 0,
    sowable: false, sowWork: 0, sowTags: null, sowMinSkill: 0,
    minFertility: 0.05, fertilitySensitivity: 0.5,
    minGrowthTemp: 0, maxGrowthTemp: 58, minLightToGrow: 0.51,
    lifespanDays: 60,
    wildDensity: 0, wildBiomes: null, wildCluster: [1, 1],
    isTree: false, dieIfLeafless: false, blightable: false,
    visualSizeRange: [0.6, 1.0]
  };

  function plant(o) {
    Object.keys(PLANT_DEFAULTS).forEach(function (k) {
      if (o[k] === undefined) o[k] = PLANT_DEFAULTS[k];
    });
    return o;
  }

  var PLANTS = Defs.add('thing', {

    /* ---------- wild cover ---------- */

    grass: {
      label: 'grass',
      description: 'Short wild grass. Grazing animals live on it, it burns in a heartbeat, ' +
        'and it creeps back over any bare soil left alone long enough.',
      color: '#5c7a3e', color2: '#6d8b48', sprite: 'grass',
      flammable: 1.0, hp: 25, nutrition: 0.35,
      plant: plant({
        growDays: 2.0, lifespanDays: 32,
        harvestWork: 22, harvestMinGrowth: 0,
        minFertility: 0.05, fertilitySensitivity: 0.3,
        wildDensity: 0.55, wildBiomes: ALL_BIOMES, wildCluster: [4, 9],
        visualSizeRange: [0.35, 0.8]
      })
    },

    tallGrass: {
      label: 'tall grass',
      description: 'Waist-high grass. Better grazing than the short stuff, and a serious ' +
        'fire hazard anywhere near a wooden wall.',
      color: '#6b8a41', color2: '#7d9a51', sprite: 'grass',
      flammable: 1.0, hp: 35, pathCost: 1, nutrition: 0.55,
      plant: plant({
        growDays: 3.2, lifespanDays: 40,
        harvestWork: 34, harvestMinGrowth: 0, fertilitySensitivity: 0.4,
        wildDensity: 0.12, wildBiomes: ['temperateForest', 'aridShrubland'], wildCluster: [3, 7],
        visualSizeRange: [0.7, 1.05]
      })
    },

    bush: {
      label: 'shrub',
      description: 'A dry woody shrub. Nothing eats it and nothing harvests it; mostly it ' +
        'stands between a turret and a clean line of fire.',
      color: '#46652f', color2: '#55763a', sprite: 'bush',
      flammable: 0.85, hp: 70, pathCost: 3, nutrition: 0.18,
      plant: plant({
        growDays: 6, lifespanDays: 70,
        harvestWork: 90, harvestMinGrowth: 0, fertilitySensitivity: 0.35,
        wildDensity: 0.10, wildBiomes: ALL_BIOMES, wildCluster: [2, 5],
        visualSizeRange: [0.7, 1.05]
      })
    },

    berryBush: {
      label: 'berry bush',
      description: 'A low bush heavy with edible berries. Picking it leaves the plant ' +
        'standing, so a wild patch keeps producing season after season.',
      /* color2 is the berry red the sprite speckles across the foliage. */
      color: '#3f6435', color2: '#a3283c', sprite: 'bush',
      flammable: 0.8, beauty: 1, hp: 80, pathCost: 3, nutrition: 0.6,
      plant: plant({
        growDays: 4.5, lifespanDays: 55,
        harvestedThing: 'berries', harvestYield: 8, harvestWork: 200,
        harvestMinGrowth: 0.65, harvestDestroys: false, regrowsTo: 0.25,
        minFertility: 0.1, fertilitySensitivity: 0.4,
        wildDensity: 0.022, wildBiomes: ALL_BIOMES, wildCluster: [2, 6],
        visualSizeRange: [0.8, 1.1]
      })
    },

    healroot: {
      label: 'wild healroot',
      description: 'The root is the base of herbal medicine, and before a colony can make ' +
        'its own it is worth crossing the map for.',
      color: '#7a9c52', color2: '#cfe08a', sprite: 'bush',
      flammable: 0.8, beauty: 1, hp: 50, pathCost: 1,
      plant: plant({
        growDays: 9, lifespanDays: 60,
        harvestedThing: 'herbalMedicine', harvestYield: 3, harvestWork: 320,
        harvestMinGrowth: 0.65,
        minFertility: 0.3, fertilitySensitivity: 0.5,
        wildDensity: 0.012, wildBiomes: ALL_BIOMES, wildCluster: [1, 3],
        visualSizeRange: [0.5, 0.85]
      })
    },

    /* ---------- trees ----------
       Foliage colour first, trunk second: art.js draws the canopy over the
       stem. A tree is passable but expensive, so pawns path around a wood
       and raiders funnel into the gaps. */

    treeOak: {
      label: 'oak tree',
      description: 'A broad hardwood. Slow to grow, generous with wood, and thick enough ' +
        'to break a raider\'s line of sight.',
      color: '#3f6b33', color2: '#5a4227', sprite: 'tree',
      flammable: 0.7, beauty: 2, hp: 200, pathCost: 14, blocksLight: true,
      plant: plant({
        growDays: 15, lifespanDays: 120,
        harvestedThing: 'wood', harvestYield: 25, harvestWork: 620, harvestMinGrowth: 0.25,
        minFertility: 0.3, fertilitySensitivity: 0.5,
        wildDensity: 0.06, wildBiomes: ['temperateForest', 'aridShrubland'], wildCluster: [3, 8],
        isTree: true, visualSizeRange: [0.85, 1.35]
      })
    },

    treePine: {
      label: 'pine tree',
      description: 'A tall conifer. Keeps its needles through the cold and drops good ' +
        'straight building wood.',
      color: '#2f5a3c', color2: '#463523', sprite: 'tree',
      flammable: 0.75, beauty: 2, hp: 180, pathCost: 12, blocksLight: true,
      plant: plant({
        growDays: 15, lifespanDays: 110,
        harvestedThing: 'wood', harvestYield: 25, harvestWork: 560, harvestMinGrowth: 0.25,
        minFertility: 0.2, fertilitySensitivity: 0.45,
        wildDensity: 0.05, wildBiomes: ['temperateForest', 'borealForest'], wildCluster: [4, 10],
        isTree: true, visualSizeRange: [0.8, 1.3]
      })
    },

    /* ---------- sown crops ----------
       sowTags are matched against what a growing spot offers. Only 'field'
       exists as a surface today, so the hydroponic tag on rice and potatoes
       is the list a basin would accept the day one is built. Crops all set
       dieIfLeafless: a frost that strips them kills them outright, which is
       what makes a winter without stockpiled food so dangerous. */

    plantRice: {
      label: 'rice plant',
      description: 'Fast, thirsty and fragile. Rice ripens in two and a half days on good ' +
        'soil, which makes it the crop that saves a starving colony.',
      color: '#87a94b', color2: '#c9c463', sprite: 'crop',
      flammable: 1.0, hp: 45, pathCost: 1, nutrition: 0.12,
      plant: plant({
        growDays: 2.5, lifespanDays: 20,
        harvestedThing: 'riceRaw', harvestYield: 6, harvestWork: 150,
        sowable: true, sowWork: 160, sowTags: ['field', 'hydroponic'], sowMinSkill: 0,
        minFertility: 0.5, fertilitySensitivity: 1.0,
        dieIfLeafless: true, blightable: true, visualSizeRange: [0.5, 0.9]
      })
    },

    plantPotato: {
      label: 'potato plant',
      description: 'Slower than rice, heavier yielding, and perfectly happy in poor dirt ' +
        'where nothing else will take.',
      color: '#4e7a3c', color2: '#6f9a4a', sprite: 'crop',
      flammable: 0.95, hp: 55, pathCost: 1, nutrition: 0.16,
      plant: plant({
        growDays: 5.8, lifespanDays: 46,
        harvestedThing: 'potatoRaw', harvestYield: 11, harvestWork: 210,
        sowable: true, sowWork: 220, sowTags: ['field', 'hydroponic'],
        minFertility: 0.05, fertilitySensitivity: 0.45,
        dieIfLeafless: true, blightable: true, visualSizeRange: [0.55, 0.95]
      })
    },

    plantCorn: {
      label: 'corn plant',
      description: 'Eleven days to ripen and nothing to show until it does. A mature field ' +
        'of corn feeds a colony twice over.',
      color: '#6d9a3e', color2: '#e0c24a', sprite: 'crop',
      flammable: 0.95, hp: 85, pathCost: 3, nutrition: 0.25,
      plant: plant({
        growDays: 11, lifespanDays: 88,
        harvestedThing: 'cornRaw', harvestYield: 22, harvestWork: 380,
        sowable: true, sowWork: 340, sowTags: ['field'], sowMinSkill: 3,
        minFertility: 0.5, fertilitySensitivity: 0.5,
        dieIfLeafless: true, blightable: true, visualSizeRange: [0.7, 1.15]
      })
    },

    plantCotton: {
      label: 'cotton plant',
      description: 'Grown for fibre rather than food. The only home-grown source of cloth, ' +
        'so every shirt and every bandage starts here.',
      color: '#5f7a46', color2: '#e9e7dd', sprite: 'crop',
      flammable: 1.0, hp: 70, pathCost: 2,
      plant: plant({
        growDays: 7, lifespanDays: 56,
        harvestedThing: 'cloth', harvestYield: 6, harvestWork: 300,
        sowable: true, sowWork: 300, sowTags: ['field'], sowMinSkill: 2,
        minFertility: 0.5, fertilitySensitivity: 0.6,
        dieIfLeafless: true, blightable: true, visualSizeRange: [0.6, 1.0]
      })
    },

    plantHealroot: {
      label: 'healroot plant',
      description: 'Cultivated healroot. Takes a skilled grower to get in the ground, then ' +
        'pays for itself the first time somebody is shot.',
      color: '#7a9c52', color2: '#cfe08a', sprite: 'crop',
      flammable: 0.85, beauty: 1, hp: 55, pathCost: 1,
      plant: plant({
        growDays: 7.5, lifespanDays: 60,
        harvestedThing: 'herbalMedicine', harvestYield: 4, harvestWork: 320,
        sowable: true, sowWork: 420, sowTags: ['field'], sowMinSkill: 8,
        minFertility: 0.5, fertilitySensitivity: 0.7,
        dieIfLeafless: true, blightable: true, visualSizeRange: [0.5, 0.9]
      })
    }

  }, THING_DEFAULTS);

  /* Derived values, then a load-time self-check. The growing-zone UI lists
     Defs.plants() filtered on plant.sowable and mapgen scatters the rest by
     wildDensity, so a plant that is neither sowable nor wild would simply
     never appear in the game - and a typo like that stays invisible until
     somebody wonders where the cotton went. Fail loudly at load instead. */
  Object.keys(PLANTS).forEach(function (id) {
    var d = PLANTS[id], p = d.plant;

    /* Some readers ask a thing for maxHp and some for hp; plants answer both. */
    if (d.maxHp === undefined) d.maxHp = d.hp;

    /* Cached so the growth tick never repeats a multiply it already knows. */
    p.growTicks = Math.round(p.growDays * TICKS_PER_DAY);
    p.lifespanTicks = Math.round(p.lifespanDays * TICKS_PER_DAY);

    function bad(why) { throw new Error('plant def ' + id + ': ' + why); }

    if (typeof p.sowable !== 'boolean') bad('sowable must be an explicit boolean');
    if (p.sowable) {
      if (!(p.sowWork > 0)) bad('sowable crop needs sowWork');
      if (!p.sowTags || !p.sowTags.length) bad('sowable crop needs at least one sowTag');
      if (p.wildDensity) bad('a sowable crop must not also scatter wild');
    } else {
      if (!(p.wildDensity > 0)) bad('wild plant needs a wildDensity for mapgen');
      if (!p.wildBiomes || !p.wildBiomes.length) bad('wild plant needs wildBiomes');
    }
    if (p.harvestedThing && !(p.harvestYield > 0)) bad('harvests into nothing');
    if (!p.harvestedThing && p.harvestYield) bad('yields something it does not harvest into');
    if (!p.harvestDestroys && !(p.regrowsTo >= 0 && p.regrowsTo < 1)) {
      bad('survives harvest but has no growth to regrow from');
    }
    if (!(p.harvestWork > 0)) bad('needs harvestWork, which is also the work to cut it down');
    if (p.minGrowthTemp >= p.maxGrowthTemp) bad('growth temperature band is inverted');
    if (p.lifespanDays <= p.growDays) bad('dies before it can ripen');
    if (!(p.minLightToGrow >= 0 && p.minLightToGrow <= 1)) bad('minLightToGrow is not 0..1');
    if (!d.sprite) bad('has no sprite family for art.js');
  });

})(this);
