/* ============================================================
   items.js - everything you can hold, make and put down

   The progression is carried by tool tiers rather than by numbers
   going up: a stone pick opens copper and iron, an iron pick opens
   gold and essence, and an arcane pick opens riftglass. Each tier
   needs the station before it, so the order you do things in is
   fixed by what you can physically make, not by a quest marker.
   ============================================================ */

export const CAT = {
  RESOURCE: 'resource', FOOD: 'food', TOOL: 'tool', WEAPON: 'weapon',
  BUILD: 'build', SPECIAL: 'special',
};

/* `icon` names a procedural pixel glyph drawn by the UI. */
export const ITEMS = {
  /* ---- gathered ---- */
  wood:      { name: 'Wood', cat: CAT.RESOURCE, stack: 200, icon: 'log', tint: 0x8a6a45 },
  stone:     { name: 'Stone', cat: CAT.RESOURCE, stack: 200, icon: 'rock', tint: 0x9aa3b2 },
  fiber:     { name: 'Fiber', cat: CAT.RESOURCE, stack: 200, icon: 'fiber', tint: 0x7fbf5a },

  /* ---- seed and crop ----
     Seeds come off the plants you were already pulling up, so
     farming starts the first time you clear a patch of ground
     rather than at some later tier. */
  seed_grain: { name: 'Grain Seed', cat: CAT.RESOURCE, stack: 100, icon: 'seed', tint: 0xd8c27a,
    desc: 'Plant it in a garden plot.' },
  seed_berry: { name: 'Berry Seed', cat: CAT.RESOURCE, stack: 100, icon: 'seed', tint: 0xd85a7a,
    desc: 'Plant it in a garden plot.' },
  seed_spore: { name: 'Spores', cat: CAT.RESOURCE, stack: 100, icon: 'seed', tint: 0x9a7ad8,
    desc: 'Plant them in a garden plot. They prefer the dark.' },
  grain:      { name: 'Grain', cat: CAT.RESOURCE, stack: 100, icon: 'grain', tint: 0xe0c464,
    desc: 'Bake it into something worth eating.' },
  bread:      { name: 'Bread', cat: CAT.FOOD, stack: 40, icon: 'bread', tint: 0xc98f4a,
    food: 30, heal: 6, desc: 'Keeps. Which is the point of it.' },
  flint:     { name: 'Flint', cat: CAT.RESOURCE, stack: 100, icon: 'shard', tint: 0x5c5a58 },
  resin:     { name: 'Resin', cat: CAT.RESOURCE, stack: 100, icon: 'drop', tint: 0xe0a24a },
  hide:      { name: 'Hide', cat: CAT.RESOURCE, stack: 100, icon: 'hide', tint: 0xa87a52 },
  bone:      { name: 'Bone', cat: CAT.RESOURCE, stack: 100, icon: 'bone', tint: 0xe4e0d2 },
  copper:    { name: 'Copper', cat: CAT.RESOURCE, stack: 100, icon: 'ingot', tint: 0xd98a4a },
  iron:      { name: 'Iron', cat: CAT.RESOURCE, stack: 100, icon: 'ingot', tint: 0xc9d2de },
  gold:      { name: 'Gold', cat: CAT.RESOURCE, stack: 100, icon: 'ingot', tint: 0xffd24a },
  copper_ore:{ name: 'Copper Ore', cat: CAT.RESOURCE, stack: 100, icon: 'ore', tint: 0xd98a4a },
  iron_ore:  { name: 'Iron Ore', cat: CAT.RESOURCE, stack: 100, icon: 'ore', tint: 0x9aa3b2 },
  gold_ore:  { name: 'Gold Ore', cat: CAT.RESOURCE, stack: 100, icon: 'ore', tint: 0xffd24a },
  scrap:     { name: 'Scrap', cat: CAT.RESOURCE, stack: 200, icon: 'gear', tint: 0xb8593a },
  wire:      { name: 'Wire', cat: CAT.RESOURCE, stack: 100, icon: 'coil', tint: 0x3fe0ff },
  essence:   { name: 'Essence', cat: CAT.RESOURCE, stack: 200, icon: 'spark', tint: 0xb07bff },
  riftglass: { name: 'Riftglass', cat: CAT.RESOURCE, stack: 60, icon: 'shard', tint: 0xff4fd8 },
  ice:       { name: 'Ice', cat: CAT.RESOURCE, stack: 60, icon: 'shard', tint: 0xbfe8f5 },
  charcoal:  { name: 'Charcoal', cat: CAT.RESOURCE, stack: 100, icon: 'rock', tint: 0x3a3a3a },
  cloth:     { name: 'Cloth', cat: CAT.RESOURCE, stack: 100, icon: 'hide', tint: 0xe0d6c0 },
  core:      { name: 'Rift Core', cat: CAT.SPECIAL, stack: 20, icon: 'core', tint: 0xff4fd8,
               desc: 'Torn out of something that did not want to give it up.' },

  /* ---- food ---- */
  berries:   { name: 'Berries', cat: CAT.FOOD, stack: 60, icon: 'berry', tint: 0xd8375a, food: 12, heal: 2 },
  mushroom:  { name: 'Mushroom', cat: CAT.FOOD, stack: 60, icon: 'shroom', tint: 0xd9503f, food: 8 },
  petal:     { name: 'Petal', cat: CAT.RESOURCE, stack: 60, icon: 'flower', tint: 0xffd75e },
  meat:      { name: 'Raw Meat', cat: CAT.FOOD, stack: 40, icon: 'meat', tint: 0xc4585c, food: 10, raw: true },
  cookedmeat:{ name: 'Cooked Meat', cat: CAT.FOOD, stack: 40, icon: 'meat', tint: 0xa8683c, food: 34, heal: 12 },
  stew:      { name: 'Stew', cat: CAT.FOOD, stack: 20, icon: 'bowl', tint: 0xdaa45c, food: 55, heal: 28,
               buff: { id: 'fed', time: 180, mods: { regen: 1.4, maxHp: 20 } } },
  bandage:   { name: 'Bandage', cat: CAT.FOOD, stack: 20, icon: 'bandage', tint: 0xf0ece0, heal: 45 },
  brew:      { name: 'Arc Brew', cat: CAT.FOOD, stack: 20, icon: 'flask', tint: 0xb07bff, energy: 60,
               buff: { id: 'brewed', time: 90, mods: { energyRegen: 6, cdr: 0.12 } } },

  /* ---- tools: kind + tier is what gates the world ---- */
  axe_stone:   { name: 'Stone Axe', cat: CAT.TOOL, stack: 1, icon: 'axe', tint: 0x9aa3b2,
                 tool: { kind: 'axe', tier: 1, power: 26, speed: 1.0, damage: 14 } },
  pick_stone:  { name: 'Stone Pick', cat: CAT.TOOL, stack: 1, icon: 'pick', tint: 0x9aa3b2,
                 tool: { kind: 'pick', tier: 1, power: 24, speed: 1.0, damage: 12 } },
  axe_iron:    { name: 'Iron Axe', cat: CAT.TOOL, stack: 1, icon: 'axe', tint: 0xc9d2de,
                 tool: { kind: 'axe', tier: 2, power: 52, speed: 1.25, damage: 26 } },
  pick_iron:   { name: 'Iron Pick', cat: CAT.TOOL, stack: 1, icon: 'pick', tint: 0xc9d2de,
                 tool: { kind: 'pick', tier: 2, power: 48, speed: 1.25, damage: 22 } },
  axe_arcane:  { name: 'Arcane Axe', cat: CAT.TOOL, stack: 1, icon: 'axe', tint: 0xb07bff,
                 tool: { kind: 'axe', tier: 3, power: 96, speed: 1.6, damage: 44 }, glow: true },
  pick_arcane: { name: 'Arcane Pick', cat: CAT.TOOL, stack: 1, icon: 'pick', tint: 0xb07bff,
                 tool: { kind: 'pick', tier: 3, power: 92, speed: 1.6, damage: 40 }, glow: true },

  /* ---- weapons: melee, always usable, unlike abilities ---- */
  club:        { name: 'Club', cat: CAT.WEAPON, stack: 1, icon: 'club', tint: 0x8a6a45,
                 tool: { kind: 'blunt', tier: 0, power: 10, speed: 0.9, damage: 20, reach: 1.5 } },
  spear:       { name: 'Spear', cat: CAT.WEAPON, stack: 1, icon: 'spear', tint: 0xa8926a,
                 tool: { kind: 'spear', tier: 1, power: 12, speed: 1.0, damage: 28, reach: 2.4 } },
  blade_iron:  { name: 'Iron Blade', cat: CAT.WEAPON, stack: 1, icon: 'blade', tint: 0xc9d2de,
                 tool: { kind: 'blade', tier: 2, power: 18, speed: 1.5, damage: 38, reach: 1.7 } },
  maul_rift:   { name: 'Rift Maul', cat: CAT.WEAPON, stack: 1, icon: 'maul', tint: 0xff4fd8,
                 tool: { kind: 'blunt', tier: 3, power: 40, speed: 0.75, damage: 96, reach: 2.0, knock: 9 },
                 glow: true },

  torch:       { name: 'Torch', cat: CAT.TOOL, stack: 5, icon: 'torch', tint: 0xffb03a,
                 tool: { kind: 'blunt', tier: 0, power: 6, speed: 1.1, damage: 10, reach: 1.4 },
                 light: { color: 0xffb03a, intensity: 2.2, range: 9 } },
};

/* Held-item categories the hotbar will accept. */
export const HOTBAR_SLOTS = 6;

/* ---------------------------------------------------- buildings */
/* `cost` is items; `station` is what you must stand near to build
   it at all. Everything placeable is on the tile grid. */
export const BUILDINGS = {
  campfire: {
    name: 'Campfire', icon: 'fire', cost: [['wood', 5], ['stone', 3]], hp: 60,
    light: { color: 0xffb03a, intensity: 2.6, range: 11 }, station: 'fire',
    warmth: 9, solid: false, height: 0.5,
    desc: 'Light, warmth, and the only way to cook. Keeps small things at bay.',
  },
  workbench: {
    name: 'Workbench', icon: 'bench', cost: [['wood', 12], ['stone', 4]], hp: 90,
    station: 'workbench', solid: true, height: 0.8,
    desc: 'Everything past sticks and rocks is made here.',
  },
  forge: {
    name: 'Forge', icon: 'forge', cost: [['stone', 20], ['scrap', 8], ['wood', 6]], hp: 140,
    station: 'forge', solid: true, height: 1.1, light: { color: 0xff8a3a, intensity: 1.8, range: 7 },
    needs: 'workbench',
    desc: 'Smelts ore. The first thing that makes the mountains worth climbing.',
  },
  arcanebench: {
    name: 'Arcane Bench', icon: 'arcane', cost: [['essence', 25], ['iron', 10], ['riftglass', 3]], hp: 120,
    station: 'arcane', solid: true, height: 0.9, light: { color: 0xb07bff, intensity: 2.0, range: 8 },
    needs: 'forge',
    desc: 'Where machine and rift are persuaded to hold still together.',
  },
  wall_wood: {
    name: 'Wood Wall', icon: 'wall', cost: [['wood', 4]], hp: 160, solid: true, height: 1.6,
    wall: true, desc: 'It will not last a siege, but it will last tonight.',
  },
  wall_stone: {
    name: 'Stone Wall', icon: 'wall', cost: [['stone', 8]], hp: 420, solid: true, height: 1.8,
    wall: true, needs: 'workbench', desc: 'Slow to build and worth it.',
  },
  wall_plated: {
    name: 'Plated Wall', icon: 'wall', cost: [['stone', 6], ['iron', 4]], hp: 900, solid: true, height: 1.9,
    wall: true, needs: 'forge', desc: 'Sieges are the point of this one.',
  },
  door: {
    name: 'Door', icon: 'door', cost: [['wood', 6]], hp: 140, solid: true, height: 1.6,
    door: true, needs: 'workbench', desc: 'Opens for you. Does not open for them.',
  },
  floor: {
    name: 'Floor', icon: 'floor', cost: [['wood', 2]], hp: 60, solid: false, height: 0.08,
    desc: 'Marks out what is yours, and keeps the mud off.',
  },
  bed: {
    name: 'Bedroll', icon: 'bed', cost: [['fiber', 12], ['hide', 4]], hp: 50, solid: false, height: 0.3,
    respawn: true, needs: 'workbench', desc: 'You come back here instead of at the beacon.',
  },
  plot: {
    name: 'Garden Plot', icon: 'sprout',
    cost: [['wood', 4], ['fiber', 6]],
    hp: 40, solid: false, height: 0.25,
    /* how long it takes to come up, and what each seed turns into */
    farm: {
      time: 150,
      crops: {
        seed_grain: { yield: [['grain', 4], ['seed_grain', 1]], tint: 0xe0c464 },
        seed_berry: { yield: [['berries', 5], ['seed_berry', 1]], tint: 0xd85a7a },
        seed_spore: { yield: [['mushroom', 4], ['seed_spore', 1]], tint: 0x9a7ad8 },
      },
    },
    desc: 'Turned soil. Plant a seed with G and come back for it.',
  },

  chest: {
    name: 'Chest', icon: 'chest', cost: [['wood', 10]], hp: 90, solid: true, height: 0.6,
    storage: 18, needs: 'workbench', desc: 'Shared storage. Pooled salvage goes in here.',
  },
  torch_post: {
    name: 'Torch Post', icon: 'torch', cost: [['wood', 3], ['resin', 1]], hp: 40, solid: false, height: 1.6,
    light: { color: 0xffb03a, intensity: 2.4, range: 10 }, warmth: 3,
    desc: 'Light on a stick. Enemies dislike lit ground.',
  },
  turret: {
    name: 'Ward Turret', icon: 'turret', cost: [['iron', 12], ['wire', 6], ['essence', 8]], hp: 260,
    solid: true, height: 1.2, needs: 'forge', turret: { damage: 17, rate: 0.6, range: 13 },
    light: { color: 0x3fe0ff, intensity: 1.2, range: 5 },
    desc: 'Shoots what comes near. Does not sleep.',
  },
  dampener: {
    name: 'Resonance Damper', icon: 'damper', cost: [['iron', 8], ['essence', 14], ['wire', 4]], hp: 180,
    solid: true, height: 1.0, needs: 'arcane', damper: { radius: 22, factor: 0.35 },
    light: { color: 0x63ff9d, intensity: 1.4, range: 6 },
    desc: 'Swallows the noise you make. The rift stops hearing your camp.',
  },
  lure: {
    name: 'Echo Lure', icon: 'lure', cost: [['scrap', 10], ['wire', 6], ['riftglass', 2]], hp: 120,
    solid: true, height: 1.3, needs: 'arcane', lure: { strength: 70, radius: 30 },
    light: { color: 0xff4fd8, intensity: 1.8, range: 7 },
    desc: 'Screams in the dark so you do not have to. Put it somewhere you are not.',
  },
  sealpylon: {
    name: 'Seal Pylon', icon: 'seal', cost: [['riftglass', 4], ['gold', 6], ['essence', 30]], hp: 400,
    solid: true, height: 2.0, needs: 'arcane', seal: true,
    light: { color: 0x7ee8ff, intensity: 3.0, range: 12 },
    desc: 'Plant it in a rift gate and hold on. Sealing one quiets every night after.',
  },
};

/* ------------------------------------------------------ recipes */
/* `station` is where it can be made; `time` is seconds of holding
   the craft. Recipes are listed in the order they should appear. */
export const RECIPES = [
  /* --- by hand, from the first minute --- */
  { out: ['club', 1], in: [['wood', 4], ['fiber', 2]], station: 'hand', time: 1.5 },
  { out: ['axe_stone', 1], in: [['wood', 3], ['stone', 3], ['fiber', 2]], station: 'hand', time: 2.0 },
  { out: ['pick_stone', 1], in: [['wood', 3], ['stone', 4], ['fiber', 2]], station: 'hand', time: 2.0 },
  { out: ['torch', 2], in: [['wood', 2], ['fiber', 2]], station: 'hand', time: 1.0 },
  { out: ['plot', 1], in: [['wood', 4], ['fiber', 6]], station: 'hand', time: 1.2, build: true },
  { out: ['campfire', 1], in: [['wood', 5], ['stone', 3]], station: 'hand', time: 1.5, build: true },
  { out: ['workbench', 1], in: [['wood', 12], ['stone', 4]], station: 'hand', time: 2.5, build: true },
  { out: ['wall_wood', 1], in: [['wood', 4]], station: 'hand', time: 0.7, build: true },

  /* --- fire: cooking --- */
  { out: ['cookedmeat', 1], in: [['meat', 1]], station: 'fire', time: 2.5 },
  { out: ['charcoal', 2], in: [['wood', 3]], station: 'fire', time: 3.0 },
  { out: ['stew', 1], in: [['cookedmeat', 2], ['mushroom', 2], ['berries', 2]], station: 'fire', time: 4.0 },

  /* --- workbench --- */
  { out: ['spear', 1], in: [['wood', 6], ['flint', 2], ['fiber', 4]], station: 'workbench', time: 2.5 },
  { out: ['cloth', 1], in: [['fiber', 6]], station: 'workbench', time: 1.5 },
  { out: ['bandage', 2], in: [['cloth', 1], ['petal', 2]], station: 'workbench', time: 1.5 },
  { out: ['bed', 1], in: [['fiber', 12], ['hide', 4]], station: 'workbench', time: 3.0, build: true },
  { out: ['chest', 1], in: [['wood', 10]], station: 'workbench', time: 2.0, build: true },
  { out: ['door', 1], in: [['wood', 6]], station: 'workbench', time: 1.5, build: true },
  { out: ['floor', 4], in: [['wood', 2]], station: 'workbench', time: 0.8, build: true },
  { out: ['wall_stone', 1], in: [['stone', 8]], station: 'workbench', time: 1.2, build: true },
  { out: ['torch_post', 1], in: [['wood', 3], ['resin', 1]], station: 'workbench', time: 1.0, build: true },
  { out: ['forge', 1], in: [['stone', 20], ['scrap', 8], ['wood', 6]], station: 'workbench', time: 4.0, build: true },

  /* --- forge: metal opens the second half of the map --- */
  { out: ['axe_iron', 1], in: [['iron', 8], ['wood', 4]], station: 'forge', time: 3.5 },
  { out: ['pick_iron', 1], in: [['iron', 9], ['wood', 4]], station: 'forge', time: 3.5 },
  { out: ['blade_iron', 1], in: [['iron', 10], ['wood', 3], ['cloth', 2]], station: 'forge', time: 4.0 },
  { out: ['wire', 3], in: [['copper', 2]], station: 'forge', time: 1.5 },
  { out: ['wall_plated', 1], in: [['stone', 6], ['iron', 4]], station: 'forge', time: 2.0, build: true },
  { out: ['turret', 1], in: [['iron', 12], ['wire', 6], ['essence', 8]], station: 'forge', time: 5.0, build: true },
  { out: ['arcanebench', 1], in: [['essence', 25], ['iron', 10], ['riftglass', 3]], station: 'forge', time: 5.0, build: true },

  /* --- arcane: the endgame tools and the seal --- */
  { out: ['brew', 2], in: [['essence', 8], ['petal', 4], ['mushroom', 2]], station: 'arcane', time: 2.5 },
  { out: ['axe_arcane', 1], in: [['iron', 10], ['essence', 30], ['riftglass', 2]], station: 'arcane', time: 6.0 },
  { out: ['pick_arcane', 1], in: [['iron', 10], ['essence', 34], ['riftglass', 3]], station: 'arcane', time: 6.0 },
  { out: ['maul_rift', 1], in: [['gold', 10], ['riftglass', 6], ['essence', 40]], station: 'arcane', time: 7.0 },
  { out: ['dampener', 1], in: [['iron', 8], ['essence', 14], ['wire', 4]], station: 'arcane', time: 4.0, build: true },
  { out: ['lure', 1], in: [['scrap', 10], ['wire', 6], ['riftglass', 2]], station: 'arcane', time: 4.0, build: true },
  { out: ['sealpylon', 1], in: [['riftglass', 4], ['gold', 6], ['essence', 30]], station: 'arcane', time: 6.0, build: true },
];

/* Smelting is its own list because it consumes ore, not items with
   the same name, and because the forge should show it separately. */
/* Ore comes out of the ground as the metal's raw form; the forge
   turns it into something you can build with. */
/* Bread is the first food you can make that does not need hunting,
   which is what makes a garden worth the ground it sits on. */
export const FARM_RECIPES = [
  { out: ['bread', 2], in: [['grain', 4]], station: 'fire', time: 3.0 },
];

export const SMELTING = [
  { out: ['copper', 2], in: [['copper_ore', 3], ['charcoal', 1]], station: 'forge', time: 2.0 },
  { out: ['iron', 2], in: [['iron_ore', 3], ['charcoal', 1]], station: 'forge', time: 2.5 },
  { out: ['gold', 2], in: [['gold_ore', 3], ['charcoal', 2]], station: 'forge', time: 3.0 },
];

export const STATION_NAME = {
  hand: 'By Hand', fire: 'Campfire', workbench: 'Workbench',
  forge: 'Forge', arcane: 'Arcane Bench',
};

/* What the beacon needs before it will light. This is the gate
   between "surviving" and "having somewhere to defend". */
/* Deliberately made of things a first day can produce: scrap from
   the ruins, essence from the bloomwood, and the wood and stone you
   were gathering anyway. Gating abilities behind smelted iron turns
   the opening into four nights of being unarmed. */
export const BEACON_REPAIR = [['scrap', 25], ['essence', 20], ['wood', 25], ['stone', 25]];

/* Every building is also a carryable item, so the same inventory,
   hotbar and crafting code handles a wall and a pickaxe. Generated
   from BUILDINGS rather than written twice, because two lists that
   have to agree eventually will not. */
for (const [key, def] of Object.entries(BUILDINGS)) {
  ITEMS[key] = {
    name: def.name, cat: CAT.BUILD, stack: 50, icon: def.icon,
    tint: def.light ? def.light.color : 0x9a8f7a,
    build: key, desc: def.desc,
  };
}

export function itemDef(id) { return ITEMS[id]; }
export function isTool(id) { const d = ITEMS[id]; return !!(d && d.tool); }
export function toolTier(id, kind) {
  const d = ITEMS[id];
  if (!d || !d.tool) return 0;
  return d.tool.kind === kind ? d.tool.tier : 0;
}
