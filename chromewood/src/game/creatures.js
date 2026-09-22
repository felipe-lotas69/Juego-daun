/* ============================================================
   creatures.js - the things that live here

   Two populations share one update path. Wildlife is ambient: it
   grazes, it flees, and some of it fights back, and it is where
   food and hide come from. Hostiles come out of the rift and want
   you or your beacon.

   Splitting them by `faction` rather than by class means a wolf
   pack and a husk swarm can use the same steering, the same
   knockback and the same damage pipe.
   ============================================================ */

export const FACTION = { WILD: 'wild', RIFT: 'rift' };

export const ANIMALS = {
  critter: {
    id: 'critter', name: 'Scurry', faction: FACTION.WILD, ai: 'flee',
    hp: 8, speed: 5.6, radius: 0.22, height: 0.4, mass: 0.3,
    color: 0x9a7b56, accent: 0x2a2018, xp: 2, flee: 9,
    drops: [['meat', 1], ['fiber', 1]], biomes: ['MEADOW', 'FOREST', 'BEACH', 'PINE'], density: 0.9,
  },
  deer: {
    id: 'deer', name: 'Glasshart', faction: FACTION.WILD, ai: 'graze',
    hp: 46, speed: 6.4, radius: 0.36, height: 1.25, mass: 1.2,
    color: 0xb08a5e, accent: 0x7ee8ff, xp: 14, flee: 13,
    drops: [['meat', 4], ['hide', 3], ['bone', 1]], biomes: ['MEADOW', 'FOREST', 'PINE'], density: 0.75,
  },
  boar: {
    id: 'boar', name: 'Tusker', faction: FACTION.WILD, ai: 'defend',
    hp: 95, speed: 4.6, radius: 0.42, height: 0.9, mass: 2.0,
    color: 0x6b5340, accent: 0xe8dcc0, xp: 26, damage: 18, attackCd: 1.5, range: 1.3,
    drops: [['meat', 6], ['hide', 4], ['bone', 2]], biomes: ['FOREST', 'MARSH', 'PINE'], density: 0.5,
  },
  ram: {
    id: 'ram', name: 'Crag Ram', faction: FACTION.WILD, ai: 'defend',
    hp: 130, speed: 5.0, radius: 0.44, height: 1.1, mass: 2.4,
    color: 0xc8c2b4, accent: 0x6b5340, xp: 34, damage: 24, attackCd: 1.8, range: 1.4,
    drops: [['meat', 6], ['hide', 5], ['bone', 3]], biomes: ['HIGHLAND', 'SNOW'], density: 0.5,
  },
  wolf: {
    id: 'wolf', name: 'Nightpack', faction: FACTION.WILD, ai: 'pack',
    hp: 70, speed: 6.8, radius: 0.34, height: 0.85, mass: 1.0,
    color: 0x5a6070, accent: 0xffd24a, xp: 30, damage: 15, attackCd: 1.0, range: 1.2,
    drops: [['meat', 3], ['hide', 3], ['bone', 2]], biomes: ['PINE', 'SNOW', 'FOREST'],
    density: 0.35, nightOnly: true, pack: 3,
  },
  lumen: {
    id: 'lumen', name: 'Lumen', faction: FACTION.WILD, ai: 'drift',
    hp: 20, speed: 2.2, radius: 0.25, height: 0.6, mass: 0.4,
    color: 0x7ee8ff, accent: 0xffffff, xp: 12, glow: true,
    drops: [['essence', 3]], biomes: ['BLOOM', 'MARSH'], density: 0.6, nightOnly: false,
  },
};

/* Which biome names in the table map to the world's enum. Kept as
   strings in the table so the content reads without imports. */
export function animalsForBiome(biomeName, isNight) {
  const out = [];
  for (const a of Object.values(ANIMALS)) {
    if (!a.biomes.includes(biomeName)) continue;
    if (a.nightOnly && !isNight) continue;
    out.push(a);
  }
  return out;
}

/* --------------------------------------------------- hostile kit */
/* Extra rift creatures beyond the originals, so a night type has
   something distinct to field. */
export const EXTRA_ENEMIES = {
  crawler: {
    id: 'crawler', name: 'Crawler', cost: 7, tier: 1,
    hp: 40, speed: 6.0, damage: 9, range: 1.0, attackCd: 0.8, radius: 0.28,
    xp: 14, mass: 0.6, color: 0x4b5f72, accent: 0x63ff9d, height: 0.6,
    ai: 'melee', faction: FACTION.RIFT,
  },
  breaker: {
    id: 'breaker', name: 'Breaker', cost: 22, tier: 3,
    hp: 240, speed: 2.4, damage: 34, range: 1.6, attackCd: 1.8, radius: 0.62,
    xp: 60, mass: 3.0, color: 0x6b5a48, accent: 0xffb03a, height: 1.7,
    ai: 'melee', armor: 0.2, structureBonus: 3.5, faction: FACTION.RIFT,
  },
  bloomheart: {
    id: 'bloomheart', name: 'Bloomheart', cost: 90, tier: 4, boss: true,
    hp: 1700, speed: 1.6, damage: 30, range: 3.0, attackCd: 2.0, radius: 1.3,
    xp: 450, mass: 7, color: 0x4a7a5e, accent: 0xff4fd8, height: 2.6,
    ai: 'boss_bloom', summon: 'spark', faction: FACTION.RIFT,
  },
};
