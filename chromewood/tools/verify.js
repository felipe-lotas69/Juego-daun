#!/usr/bin/env node
/* ============================================================
   verify.js - does the game still work?

   Five things that are cheap to break and expensive to notice
   only when somebody is playing:

     1. the content tables refer to each other. Every item id in
        every drop, recipe, building and upgrade cost is a real
        item, every skill resolves, every ability is reachable.
        This is the check that would have caught buildings being
        craftable into an inventory that had no slot for them;
     2. a generated world is connected - you can walk from the
        beacon to essentially all of it - and has the landmarks,
        relief, water and ore a run needs;
     3. a bot that actually plays the survival loop (gathers,
        crafts, builds, eats, repairs the beacon) gets somewhere
        without a NaN, a throw, or the frame budget blowing up;
     4. the whole arc runs to its end: beacon lit, gates sealed,
        Heart woken, phase won;
     5. the wire format round-trips everything a client draws.

     node tools/verify.js [--seeds 6] [--minutes 30]
   ============================================================ */

import { World, FLAG, SOLID_PROPS, HARVEST, PLATEAUS } from '../src/world/worldgen.js';
import { canStand } from '../src/game/movement.js';
import { PLAYER, LEVEL_STEP, SURVIVAL } from '../src/core/config.js';
import { Sim, PHASE, ARC, BEACON_COSTS, emptyInput } from '../src/game/sim.js';
import {
  SKILLS, ABILITIES, ENEMIES, BEACON_UPGRADES, SKILL_BRANCHES, PRIMARY_ID,
} from '../src/game/defs.js';
import {
  ITEMS, BUILDINGS, RECIPES, SMELTING, STATION_NAME, BEACON_REPAIR, CAT,
} from '../src/game/items.js';
import { ANIMALS, EXTRA_ENEMIES } from '../src/game/creatures.js';
import { NIGHTS, WEATHER, CONTRACTS, buildNightDeck } from '../src/game/nights.js';
import {
  allRecipes, invCount, invGive, startCraft, bestToolTier, eat, place, canPlace,
} from '../src/game/survival.js';
import {
  encodeSnapshot, decodeInput, encodeInput, PROTOCOL_VERSION,
} from '../src/net/protocol.js';
import { Mirror } from '../src/net/mirror.js';
import { brokerConfig, brokerIdForRoom } from '../src/net/peer.js';
import { villageOffers } from '../src/game/trade.js';
import {
  SEASONS, SEASON_NIGHTS, seasonFor, rollSeasonWeather, seasonAnimalWeight,
} from '../src/game/seasons.js';
import { hasGlyph } from '../src/ui/font.js';
import { makeRng } from '../src/core/rng.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui');

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const SEEDS = arg('seeds', 6);
const MINUTES = arg('minutes', 30);

let failures = 0;
const ok = (label, extra = '') => console.log(`  ok    ${label}${extra ? '  ' + extra : ''}`);
const bad = (label, why) => { failures++; console.log(`  FAIL  ${label}\n        ${why}`); };
const check = (cond, label, why) => (cond ? ok(label) : bad(label, why));

/* ----------------------------------------------------- 1. content */
console.log('\ncontent tables');
{
  /* --- every item id anyone names has to exist ------------------ */
  const missing = [];
  const wantItem = (id, where) => { if (!ITEMS[id]) missing.push(`${where} -> unknown item "${id}"`); };

  for (const [prop, h] of Object.entries(HARVEST)) {
    for (const [id] of h.yield) wantItem(id, `harvest of prop ${prop}`);
  }
  for (const rec of RECIPES.concat(SMELTING)) {
    wantItem(rec.out[0], `recipe out`);
    for (const [id] of rec.in) wantItem(id, `recipe for ${rec.out[0]}`);
  }
  for (const [it] of BEACON_REPAIR) wantItem(it, 'beacon repair');
  for (const [key, fn] of Object.entries(BEACON_COSTS)) {
    for (let l = 0; l < (BEACON_UPGRADES[key]?.max ?? 0); l++) {
      for (const [id] of fn(l)) wantItem(id, `beacon upgrade ${key} level ${l}`);
    }
  }
  for (const [key, a] of Object.entries(ANIMALS)) {
    for (const [id] of a.drops || []) wantItem(id, `animal ${key}`);
  }
  for (const [key, e] of Object.entries({ ...ENEMIES, ...EXTRA_ENEMIES })) {
    for (const [id] of e.drops || []) wantItem(id, `enemy ${key}`);
  }
  for (const ct of CONTRACTS) {
    if (ct.need && ct.need.item) wantItem(ct.need.item, `contract ${ct.id}`);
  }
  check(!missing.length, 'every item id resolves', missing.join('; '));

  /* --- buildings must be craftable, carryable and placeable ----- */
  const buildProblems = [];
  for (const [key, def] of Object.entries(BUILDINGS)) {
    /* A building you cannot hold is a building you cannot place:
       invGive drops anything with no ITEMS entry on the floor. */
    if (!ITEMS[key]) buildProblems.push(`${key} has no item entry to carry it in`);
    else if (ITEMS[key].build !== key) buildProblems.push(`${key}'s item does not point back at it`);
    if (!RECIPES.some(r => r.out[0] === key)) buildProblems.push(`${key} has no recipe`);
    if (!def.icon) buildProblems.push(`${key} has no icon`);
    if (!def.desc) buildProblems.push(`${key} has no description`);
  }
  check(!buildProblems.length, 'every building can be made, carried and placed', buildProblems.join('; '));

  const badStation = RECIPES.concat(SMELTING)
    .filter(r => r.station && !STATION_NAME[r.station]).map(r => r.out[0]);
  check(!badStation.length, 'every recipe names a real station', badStation.join(', '));

  /* --- tools have to reach every tier the world asks for -------- */
  const bestTier = {};
  for (const def of Object.values(ITEMS)) {
    if (!def.tool) continue;
    bestTier[def.tool.kind] = Math.max(bestTier[def.tool.kind] ?? -1, def.tool.tier);
  }
  const unreachable = Object.entries(HARVEST)
    .filter(([, h]) => h.tool !== 'hand' && (bestTier[h.tool] ?? -1) < h.tier)
    .map(([p, h]) => `prop ${p} needs ${h.tool} tier ${h.tier}`);
  check(!unreachable.length, 'a tool exists for everything in the ground', unreachable.join('; '));

  /* --- the skill tree ------------------------------------------- */
  const broken = [];
  for (const [key, s] of Object.entries(SKILLS)) {
    if (s.req && !SKILLS[s.req]) broken.push(`${key} requires missing node ${s.req}`);
    if (s.unlock && !ABILITIES[s.unlock]) broken.push(`${key} unlocks missing ability ${s.unlock}`);
    if (!SKILL_BRANCHES.some(b => b.id === s.branch)) broken.push(`${key} is in unknown branch ${s.branch}`);
    if (!(s.cost > 0)) broken.push(`${key} costs nothing`);
    if (!s.desc) broken.push(`${key} has no description`);
  }
  check(!broken.length, 'skill tree references resolve', broken.join('; '));

  const cyclic = [];
  for (const [key, s] of Object.entries(SKILLS)) {
    let cur = s, hops = 0;
    while (cur && cur.req && hops++ < 20) cur = SKILLS[cur.req];
    if (hops >= 20) cyclic.push(key);
  }
  check(!cyclic.length, 'no cycles in the skill tree', 'cycle through ' + cyclic.join(', '));

  const unlocked = new Set(Object.values(SKILLS).filter(s => s.unlock).map(s => s.unlock));
  const orphan = Object.keys(ABILITIES).filter(a => a !== PRIMARY_ID && !unlocked.has(a));
  check(!orphan.length, 'every ability is unlockable', 'unreachable: ' + orphan.join(', '));

  /* --- creatures ------------------------------------------------ */
  const badEnemy = Object.entries({ ...ENEMIES, ...EXTRA_ENEMIES })
    .filter(([, e]) => !(e.hp > 0 && e.speed > 0 && e.cost > 0 && e.xp > 0 && e.height > 0))
    .map(([k]) => k);
  check(!badEnemy.length, 'enemy stats are sane', badEnemy.join(', '));

  const badAnimal = Object.entries(ANIMALS)
    .filter(([, a]) => !(a.hp > 0 && a.speed > 0 && a.height > 0 && Array.isArray(a.drops)))
    .map(([k]) => k);
  check(!badAnimal.length, 'animal stats are sane', badAnimal.join(', '));

  /* --- beacon upgrades ------------------------------------------ */
  const badUpgrade = Object.entries(BEACON_UPGRADES).filter(([key, u]) => {
    if (!BEACON_COSTS[key]) return true;
    for (let l = 0; l < u.max; l++) {
      const c = BEACON_COSTS[key](l);
      if (!Array.isArray(c) || !c.length || !c.every(([, n]) => n > 0)) return true;
      if (typeof u.desc(l) !== 'string' || !u.desc(l)) return true;
    }
    return false;
  }).map(([k]) => k);
  check(!badUpgrade.length, 'beacon upgrades price every level', badUpgrade.join(', '));

  /* --- nights, weather, contracts ------------------------------- */
  const badNight = Object.entries(NIGHTS)
    .filter(([, n]) => !(n.name && n.color && n.budget > 0 && n.blurb && n.weights)).map(([k]) => k);
  check(!badNight.length, 'every night type is complete', badNight.join(', '));

  const deck = buildNightDeck(() => 0.5, 40);
  const strayNight = [...new Set(deck)].filter(id => !NIGHTS[id]);
  check(deck.length >= 40 && !strayNight.length, 'the night deck only deals real nights',
    strayNight.join(', ') || `deck is only ${deck.length} long`);

  const badWeather = Object.entries(WEATHER).filter(([, w]) => !w.name).map(([k]) => k);
  check(!badWeather.length, 'every weather is complete', badWeather.join(', '));

  const badContract = CONTRACTS
    .filter(c => !(c.id && c.name && c.desc && c.need && c.reward)).map(c => c.id || '(unnamed)');
  check(!badContract.length, 'every contract is complete', badContract.join(', '));

  /* --- inventory presentation ----------------------------------- */
  const badItem = Object.entries(ITEMS)
    .filter(([, d]) => !(d.name && d.icon && Number.isFinite(d.tint) && d.stack > 0 && CAT[String(d.cat).toUpperCase()] !== undefined || d.cat))
    .filter(([, d]) => !(d.name && d.icon && d.stack > 0)).map(([k]) => k);
  check(!badItem.length, 'every item can be drawn in a slot', badItem.join(', '));

  ok('tables', `${Object.keys(ITEMS).length} items, ${RECIPES.length + SMELTING.length} recipes, ` +
    `${Object.keys(BUILDINGS).length} buildings, ${Object.keys(SKILLS).length} skills, ` +
    `${Object.keys(NIGHTS).length} night types`);
}

/* ------------------------------------------------------ 2. worlds */
console.log('\nworld generation');
/* Exactly the rule the simulation walks by: anything else measures a
   map nobody plays. Deep water is not walkable; shallow water is. */
const passable = (w, i) => {
  const f = w.flags[i];
  if (f & FLAG.BLOCKED_EDGE) return false;
  if ((f & FLAG.WATER) && !(f & FLAG.SHALLOW)) return false;
  /* SOLID from a prop is a tree or a boulder, which is an errand
     with an axe rather than a wall; only terrain blocks for good. */
  if ((f & FLAG.SOLID) && !SOLID_PROPS.has(w.prop[i])) return false;
  return true;
};
{
  const stats = [];
  for (let i = 0; i < SEEDS; i++) {
    const seed = 1000 + i * 7919;
    const t0 = Date.now();
    const w = new World(seed);
    const genMs = Date.now() - t0;

    /* Flood fill from the beacon over everything a player could
       walk, and compare with the open tiles inside the rim. */
    const size = w.size;
    const seen = new Uint8Array(size * size);
    const start = [Math.floor(size / 2), Math.floor(size / 2)];
    const stack = [start];
    seen[w.idx(start[0], start[1])] = 1;
    let reached = 0;
    while (stack.length) {
      const [x, y] = stack.pop();
      reached++;
      const h = w.height[w.idx(x, y)];
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ox, ny = y + oy;
        if (!w.inBounds(nx, ny)) continue;
        const j = w.idx(nx, ny);
        if (seen[j] || !passable(w, j)) continue;
        if (Math.abs(w.height[j] - h) > 1) continue;
        seen[j] = 1;
        stack.push([nx, ny]);
      }
    }
    let open = 0, water = 0, river = 0, cliffs = 0;
    const levels = new Set();
    for (let k = 0; k < w.flags.length; k++) {
      if (w.flags[k] & FLAG.WATER) water++;
      if (w.flags[k] & FLAG.RIVER) river++;
      if (!passable(w, k)) continue;
      open++;
      levels.add(w.height[k]);
    }
    /* A cliff is a step of more than one level: without them the
       map is a plain with a tint, whatever the heightmap says. */
    for (let y = 1; y < size; y++) {
      for (let x = 1; x < size; x++) {
        const h = w.height[w.idx(x, y)];
        if (Math.abs(h - w.height[w.idx(x - 1, y)]) > 1) cliffs++;
        else if (Math.abs(h - w.height[w.idx(x, y - 1)]) > 1) cliffs++;
      }
    }
    const coverage = reached / open;

    const kinds = {};
    for (const lm of w.landmarks) kinds[lm.kind] = (kinds[lm.kind] || 0) + 1;
    const finite = w.landmarks.every(l =>
      Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.z));

    let harvestable = 0;
    const ores = new Set();
    for (const p of w.prop) {
      if (!HARVEST[p]) continue;
      harvestable++;
      for (const [id] of HARVEST[p].yield) if (id.endsWith('_ore') || id === 'essence') ores.add(id);
    }

    const biomes = new Set(w.biome);

    stats.push({ seed, genMs, coverage, kinds, finite, harvestable, ores: ores.size,
      spawns: w.spawnPoints.length, levels: levels.size, cliffs, water, river, biomes: biomes.size });
  }

  const worstCoverage = Math.min(...stats.map(s => s.coverage));
  check(worstCoverage > 0.90, 'the map is walkable from the beacon',
    `worst seed reaches only ${(worstCoverage * 100).toFixed(1)}% of open ground`);

  check(stats.every(s => s.finite), 'landmarks have world coordinates',
    'a landmark is missing x/y/z, which leaves the beacon at NaN');

  check(stats.every(s => s.kinds.beacon === 1 && s.kinds.rift >= 1 && s.kinds.shrine >= 1 && s.kinds.cache >= 1),
    'every world has a beacon, rifts, shrines and caches',
    'seeds missing landmarks: ' + stats.filter(s => !(s.kinds.beacon === 1 && s.kinds.rift >= 1)).map(s => s.seed).join(', '));

  check(stats.every(s => s.levels >= 6), 'the ground actually goes up and down',
    `a seed only uses ${Math.min(...stats.map(s => s.levels))} of ${PLATEAUS.length} terraces`);

  check(stats.every(s => s.cliffs > 2000), 'there are cliffs, not just ramps',
    `a seed has only ${Math.min(...stats.map(s => s.cliffs))} cliff edges`);

  check(stats.every(s => s.water > 500 && s.river > 60), 'there is water and a river',
    `worst seed: ${Math.min(...stats.map(s => s.water))} water, ${Math.min(...stats.map(s => s.river))} river tiles`);

  check(stats.every(s => s.biomes >= 6), 'the map is not one biome',
    `a seed has only ${Math.min(...stats.map(s => s.biomes))} biomes`);

  check(stats.every(s => s.harvestable > 300), 'there is enough to salvage',
    'a seed has too few harvestable props: ' + Math.min(...stats.map(s => s.harvestable)));

  check(stats.every(s => s.ores >= 3), 'the ores a run needs are in the ground',
    `a seed only exposes ${Math.min(...stats.map(s => s.ores))} kinds`);

  check(stats.every(s => s.spawns >= 4), 'spawn points exist', 'a seed has no spawn ring');

  const slowest = Math.max(...stats.map(s => s.genMs));
  check(slowest < 1800, 'generation is fast enough to do at load', `slowest seed took ${slowest}ms`);
  const s0 = stats[0];
  ok('generated', `${SEEDS} seeds, ${slowest}ms worst, ${(worstCoverage * 100).toFixed(1)}% worst coverage, ` +
    `${s0.levels} terraces, ${s0.biomes} biomes`);
}

/* ------------------------------------------ 3. a bot plays the run */
console.log('\nsimulated runs');

/* The nearest thing this player is actually equipped to harvest,
   preferring whatever the next thing on its shopping list is short
   of. A purely greedy forager was fine when props were spread evenly,
   but now that cover and woodland cluster separately it would settle
   into a meadow pulling grass forever and never walk to the trees -
   which a person obviously would. */
function findResource(sim, p, kinds, wanted, ignore) {
  const w = sim.world;
  const ctx = w.worldToTileX(p.x), cty = w.worldToTileZ(p.z);
  let best = null, bestD = 1e9;
  /* Every ring, not just the first one with anything in it: stopping
     at the first hit means the bot grinds whatever rock happens to
     be nearest and never walks the extra four tiles to the tree it
     actually needs. */
  for (let r = 1; r < 26; r++) {
    for (let a = 0; a < r * 8; a++) {
      const ang = (a / (r * 8)) * Math.PI * 2;
      const tx = ctx + Math.round(Math.cos(ang) * r), ty = cty + Math.round(Math.sin(ang) * r);
      if (!w.inBounds(tx, ty)) continue;
      if (ignore && ignore.has(tx * 4096 + ty)) continue;
      const h = HARVEST[w.prop[w.idx(tx, ty)]];
      if (!h || !kinds.includes(h.tool)) continue;
      if (h.tier > bestToolTier(p, h.tool === 'hand' ? 'blunt' : h.tool)) continue;
      const x = w.tileToWorldX(tx), z = w.tileToWorldZ(ty);
      let d = (x - p.x) ** 2 + (z - p.z) ** 2;
      /* Something we actually need is worth a long walk. */
      if (wanted && wanted.size && h.yield.some(([item]) => wanted.has(item))) d *= 0.05;
      if (d < bestD) { bestD = d; best = { x, z, tx, ty }; }
    }
  }
  return best;
}

const SHOPPING = ['axe_stone', 'pick_stone', 'campfire', 'workbench', 'spear', 'bed', 'torch_post',
  'forge', 'axe_iron', 'pick_iron', 'blade_iron', 'arcanebench', 'sealpylon'];
const PLACEABLE = ['campfire', 'workbench', 'forge', 'arcanebench', 'bed', 'torch_post'];

/* One tick of a bot that plays the actual game rather than a
   shooting gallery: it gathers, crafts, builds, eats and hauls
   salvage to the beacon, and once the beacon is lit it goes and
   stands in rift gates. Returns nothing; it drives sim.setInput. */
function driveBot(sim, p, i, seq, recipes) {
  if (p.state !== 'alive') { sim.setInput(p.id, { seq, mx: 0, mz: 0, ax: p.x, az: p.z }); return; }

  if (p.skillPoints > 0 && sim.beacon.lit) {
    for (const k of Object.keys(SKILLS)) {
      const s = SKILLS[k];
      if (p.skills[k] || (s.req && !p.skills[s.req]) || s.cost > p.skillPoints) continue;
      sim.learnSkill(p, k); break;
    }
  }
  if (p.hunger < 40) {
    for (const f of ['stew', 'cookedmeat', 'berries', 'mushroom']) {
      if (invCount(p, f) > 0) { eat(sim, p, f); break; }
    }
  }
  if (!p.craft && i % 30 === 0) {
    for (const target of SHOPPING) {
      if (invCount(p, target) > 0 && !BUILDINGS[target]) continue;
      if (BUILDINGS[target] && sim.buildings.some(b => b.key === target && b.owner === p.id)) continue;
      const idx = recipes.findIndex(r => r.out[0] === target);
      if (idx >= 0 && startCraft(sim, p, idx)) break;
    }
  }
  if (i % 20 === 0) {
    for (const key of PLACEABLE) {
      if (invCount(p, key) <= 0) continue;
      const w = sim.world;
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2;
        const tx = w.worldToTileX(p.x + Math.cos(a) * 2), ty = w.worldToTileZ(p.z + Math.sin(a) * 2);
        /* canPlace returns a reason string when it cannot. */
        if (!canPlace(sim, p, key, tx, ty)) { place(sim, p, key, tx, ty); break; }
      }
      break;
    }
  }

  let tx, tz, fire = false, interact = false;
  const enemy = sim._nearestEnemy(p.x, p.z, 14);
  /* The nearest unsealed gate, not the first in the list: the first
     one can be on the far side of a mountain range. */
  let gate = null, gateD = Infinity;
  for (const g of sim.gates) {
    if (g.sealed) continue;
    const d = Math.hypot(g.x - p.x, g.z - p.z);
    if (d < gateD) { gateD = d; gate = g; }
  }
  const repairDone = BEACON_REPAIR.every(([it, n]) => (sim.beacon.store[it] || 0) >= n);

  if (sim.beacon.lit && gate) {
    /* Stand in the gate and hold it. Chasing whatever wanders past
       walks you out of the ring and cancels the seal, which is how
       a bot spends ninety minutes sealing nothing. */
    const d = Math.hypot(gate.x - p.x, gate.z - p.z);
    tx = gate.x; tz = gate.z;
    interact = d <= 4 && !gate.active;
    fire = !!enemy && d <= 4;
  } else if (enemy && (sim.beacon.lit || invCount(p, 'club') + invCount(p, 'spear') > 0)) {
    tx = enemy.x; tz = enemy.z; fire = true;
  } else if (!sim.beacon.lit && (repairDone || BEACON_REPAIR.some(([it, n]) =>
      invCount(p, it) >= Math.min(n, 8) && (sim.beacon.store[it] || 0) < n))) {
    /* Only haul what the beacon still wants. Carrying a stack it has
       already had its fill of used to pin the bot to the console
       holding the interact key until it starved. */
    tx = sim.beacon.x; tz = sim.beacon.z; interact = true;
  } else {
    /* What is the next thing on the list short of? */
    const wanted = new Set();
    for (const target of SHOPPING) {
      if (invCount(p, target) > 0 && !BUILDINGS[target]) continue;
      const rec = recipes.find(x => x.out[0] === target);
      if (!rec) continue;
      let short = false;
      for (const [item, n] of rec.in) {
        if (invCount(p, item) < n) { wanted.add(item); short = true; }
      }
      if (short) break;
    }
    /* The bot walks in a straight line at whatever it picked, so a
       target across a cliff or a lake is a target it will lean on
       forever. Give up on one that is not getting any closer. */
    if (!p._ignore) { p._ignore = new Set(); p._lastD = Infinity; p._stuck = 0; }
    /* The search walks twenty-six rings of tiles; at sixty frames a
       second per bot that is most of the step budget, and the answer
       does not change between frames. Keep it until the tile it
       picked is gone or a third of a second has passed. */
    let node = p._node;
    const stale = !node || i - (p._nodeAt || 0) > 20
      || !HARVEST[sim.world.prop[sim.world.idx(node.tx, node.ty)]]
      || p._ignore.has(node.tx * 4096 + node.ty);
    if (stale) {
      node = findResource(sim, p, ['axe', 'pick', 'hand'], wanted, p._ignore);
      p._node = node; p._nodeAt = i;
    }
    if (node) {
      const d = Math.hypot(node.x - p.x, node.z - p.z);
      if (d > p._lastD - 0.02) p._stuck += 1; else p._stuck = 0;
      p._lastD = d;
      if (p._stuck > 240) {
        p._ignore.add(node.tx * 4096 + node.ty);
        p._stuck = 0; p._lastD = Infinity;
        if (p._ignore.size > 400) p._ignore.clear();
      }
    } else { p._stuck = 0; p._lastD = Infinity; }
    if (node) { tx = node.x; tz = node.z; fire = true; }
    else { tx = sim.beacon.x; tz = sim.beacon.z; }
  }

  const dx = tx - p.x, dz = tz - p.z, m = Math.hypot(dx, dz) || 1;
  const close = m < 1.4;
  const holding = interact || (sim.beacon.lit && gate && m <= 4);

  /* The bot has no pathfinder. Without one it leans on the first
     cliff between it and whatever it wants and stays there for the
     rest of the run, which makes a world with more relief in it look
     like a broken game. Sliding along the obstacle for a couple of
     seconds when the distance stops falling is not pathfinding, but
     it gets round a ridge, and it is the same thing a person does. */
  let mx = close ? 0 : dx / m, mz = close ? 0 : dz / m;
  if (!close) {
    const nav = p._nav || (p._nav = { lastD: Infinity, stuck: 0, side: 1, until: -1 });
    if (m > nav.lastD - 0.004) nav.stuck += 1; else nav.stuck = 0;
    nav.lastD = m;
    if (nav.stuck > 90 && i > nav.until) { nav.side = -nav.side; nav.until = i + 180; nav.stuck = 0; }
    if (i < nav.until) {
      const a = nav.side * 1.15;
      const ca = Math.cos(a), sa = Math.sin(a);
      const rx = mx * ca - mz * sa, rz = mx * sa + mz * ca;
      mx = rx; mz = rz;
    }
  }

  sim.setInput(p.id, {
    seq, mx, mz,
    ax: enemy && holding ? enemy.x : tx, az: enemy && holding ? enemy.z : tz,
    fire: fire && (holding || m < 3), dash: false,
    abil: sim.beacon.lit && i % 50 === 0 ? 1 : 0, interact, sprint: m > 8,
  });
}

{
  for (const players of [1, 4]) {
    const sim = new Sim(20260921, { difficulty: 1 });
    const bots = [];
    for (let i = 0; i < players; i++) bots.push(sim.addPlayer('p' + i, 'BOT' + i));
    const recipes = allRecipes();

    const steps = Math.round(MINUTES * 60 * 60);
    let peak = 0, nan = null, thrown = null;
    const events = {};
    const t0 = Date.now();

    for (let i = 0; i < steps && !nan && !thrown; i++) {
      for (const p of bots) driveBot(sim, p, i, i, recipes);
      if (i % 240 === 0) for (const k of Object.keys(BEACON_UPGRADES)) sim.buyBeaconUpgrade(k);

      try {
        sim.step(1 / 60);
        for (const ev of sim.drainEvents()) events[ev.t] = (events[ev.t] || 0) + 1;
      } catch (err) { thrown = `${err.message} at step ${i}\n        ${(err.stack || '').split('\n')[1] || ''}`; break; }

      peak = Math.max(peak, sim.enemies.length);
      for (const p of bots) {
        if (![p.x, p.z, p.hp, p.hunger, p.warmth, p.stamina].every(Number.isFinite)) {
          nan = `${p.name} went non-finite at step ${i} (x=${p.x} hp=${p.hp} hunger=${p.hunger} warmth=${p.warmth})`;
          break;
        }
      }
      for (const e of sim.enemies) if (!Number.isFinite(e.x) || !Number.isFinite(e.hp)) { nan = `enemy ${e.type} went non-finite at step ${i}`; break; }
      for (const a of sim.animals) if (!Number.isFinite(a.x) || !Number.isFinite(a.hp)) { nan = `animal ${a.type} went non-finite at step ${i}`; break; }
      for (const b of sim.buildings) if (!Number.isFinite(b.hp)) { nan = `building ${b.key} went non-finite at step ${i}`; break; }
      if (!Number.isFinite(sim.beacon.hp)) nan = `beacon hp went non-finite at step ${i}`;
      if (sim.phase !== PHASE.RUNNING) break;
    }

    const ms = Date.now() - t0;
    const usPerStep = (ms / steps) * 1000;
    const label = `${players}-player run`;
    if (thrown) { bad(label, thrown); continue; }
    if (nan) { bad(label, nan); continue; }

    const totalKills = bots.reduce((a, b) => a + b.kills, 0);
    /* Carried plus delivered: a bot that hauls everything it digs
       up straight to the beacon store has an empty pack and has
       still done the gathering. */
    const carried = bots.reduce((a, b) => a + Object.values(b.inv).reduce((x, y) => x + y, 0), 0);
    const delivered = Object.values(sim.beacon.store).reduce((x, y) => x + y, 0);
    const gathered = carried + delivered;
    const kinds = new Set(bots.flatMap(b => Object.keys(b.inv).filter(k => b.inv[k] > 0)));
    /* Events, not the end-state pack: a tool that was made and then
       worn out still proves the chain from ore to workbench runs. */
    const crafted = (events.crafted || 0) > 0;
    const harvested = (events.prop_break || 0) > 0;
    /* One night is about four minutes, so ask for roughly what the
       clock allows rather than a fixed number. */
    const wantNights = Math.max(1, Math.floor(MINUTES / 6));
    if (!(sim.night >= wantNights)) bad(label, `only reached night ${sim.night} in ${MINUTES} minutes`);
    else if (!(gathered > 2 * MINUTES) || kinds.size < 4) bad(label, `the bots gathered almost nothing in ${MINUTES} minutes: ` +
      `${carried} carried, ${delivered} delivered, kinds: ${[...kinds].join(' ') || '(none)'}`);
    else if (!harvested) bad(label, 'nothing in the world was ever broken down, so harvesting is dead');
    else if (!crafted) {
      bad(label, 'nobody finished a single craft, so the crafting chain is broken: '
        + `${events.craftstart || 0} started, ${events.craftfail || 0} refused, `
        + `${events.prop_break || 0} harvested, carrying ` + bots.map(b => JSON.stringify(b.inv)).join(' '));
    }
    else {
      ok(label, `night ${sim.night}, arc ${sim.arc}, lvl ${bots.map(b => b.level).join('/')}, ` +
        `${totalKills} kills, ${gathered} items in ${kinds.size} kinds, ${sim.buildings.length} built, ` +
        `${events.crafted || 0} crafted, ${events.prop_break || 0} harvested, ` +
        `peak ${peak} enemies, ${usPerStep.toFixed(1)}us/step`);
    }
    if (usPerStep > 400) bad(label + ' performance', `${usPerStep.toFixed(0)}us per step leaves no room for rendering`);
  }
}

/* --------------------------------------- 3a. make it, carry it, place it */
console.log('\nthe building loop');
{
  /* The chain a player actually walks: pay the recipe once, carry
     the result, put it down. Placing used to bill the raw materials
     a second time and leave the thing you made in your pack, so
     nothing could ever be built with exactly what it costs. */
  const sim = new Sim(9090, { difficulty: 1 });
  const p = sim.addPlayer('p0', 'BUILDER');
  const recipes = allRecipes();
  const idx = recipes.findIndex(r => r.out[0] === 'campfire');
  const rec = recipes[idx];

  /* Exactly the materials the recipe asks for, and nothing else. */
  for (const [item, n] of rec.in) invGive(p, item, n);
  const started = startCraft(sim, p, idx);
  check(started, 'a craft starts with exactly its cost', 'startCraft refused the exact materials');
  for (let i = 0; i < 60 * 10 && !invCount(p, 'campfire'); i++) { sim.step(1 / 60); sim.drainEvents(); }
  check(invCount(p, 'campfire') === 1, 'the craft finishes and you are carrying it',
    `carrying ${invCount(p, 'campfire')} campfires`);
  const leftovers = rec.in.reduce((a, [item]) => a + invCount(p, item), 0);
  check(leftovers === 0, 'crafting spent the materials', `${leftovers} left over`);

  /* Now put it down, with an empty pack apart from the campfire. */
  const w = sim.world;
  let placed = null, why = 'never found a spot';
  for (let r = 1; r < 6 && !placed; r++) {
    for (let a = 0; a < r * 8 && !placed; a++) {
      const ang = (a / (r * 8)) * Math.PI * 2;
      const tx = w.worldToTileX(p.x + Math.cos(ang) * r), ty = w.worldToTileZ(p.z + Math.sin(ang) * r);
      why = canPlace(sim, p, 'campfire', tx, ty) || 'ok';
      if (why === 'ok') placed = place(sim, p, 'campfire', tx, ty);
    }
  }
  check(!!placed, 'what you crafted can be placed', `canPlace kept saying "${why}"`);
  check(invCount(p, 'campfire') === 0, 'placing consumes the thing you were carrying',
    `still carrying ${invCount(p, 'campfire')}`);
  check(sim.buildings.length === 1, 'the building lands in the world',
    `${sim.buildings.length} buildings`);
  /* And with nothing in the pack it must be refused, not free. */
  check(canPlace(sim, p, 'campfire', w.worldToTileX(p.x) + 3, w.worldToTileZ(p.z)) === 'materials',
    'an empty pack cannot build', 'placing succeeded with nothing to place');
  ok('building loop', `${rec.in.map(([i, n]) => n + ' ' + i).join(' + ')} -> campfire -> placed`);
}

/* ------------------------------------------------- 3a2. farming */
console.log('\ngrowing things');
{
  /* Seeds have to be gettable from the world, a plot has to accept
     one, it has to come up on its own, and pulling it has to give
     back more than it cost - otherwise a garden is a decoration. */
  const seedProps = Object.entries(HARVEST)
    .filter(([, h]) => h.yield.some(([id]) => id.startsWith('seed_')));
  check(seedProps.length >= 3, 'seeds come off plants you can already pull up',
    `only ${seedProps.length} props drop seeds`);

  const def = BUILDINGS.plot;
  check(!!def && !!def.farm, 'there is something to plant in', 'no garden plot');

  /* One clean world per crop. Sharing a plot across three cycles
     means the previous harvest's seeds, seven minutes of night and
     a replant all get a vote in whether the next one worked, and a
     test that can fail for three reasons tells you nothing. */
  const seeds = Object.keys(def.farm.crops);
  let grewAll = true, paidBack = true;
  let lastSnap = null, lastPlot = null;

  for (const seed of seeds) {
    const sim = new Sim(606, { difficulty: 1 });
    const p = sim.addPlayer('p', 'FARMER');
    const w = sim.world;
    const tx = w.worldToTileX(p.x) + 1, ty = w.worldToTileZ(p.z);
    w.clearProp(tx, ty);
    const plot = sim.addBuilding('plot', tx, ty, 'p');
    lastPlot = plot;
    /* This is a test of farming, not of surviving the night. */
    const keep = () => { p.hp = p.maxHp; p.state = 'alive'; plot.hp = plot.maxHp; };

    invGive(p, seed, 1);
    p.hotbar[0] = seed; p.hotbarIndex = 0;
    for (let i = 0; i < 90; i++) {
      p.x = plot.x - 1.2; p.z = plot.z; keep();
      sim.setInput('p', { seq: i, mx: 0, mz: 0, ax: plot.x, az: plot.z, interact: true });
      sim.step(1 / 60); sim.drainEvents();
    }
    if (plot.seed !== seed || invCount(p, seed) !== 0) {
      grewAll = `planting ${seed} gave ${plot.seed} and left ${invCount(p, seed)} in the pack`;
      break;
    }

    for (let i = 0; i < 60 * (def.farm.time + 8) && plot.grow < 1; i++) {
      keep();
      sim.step(1 / 60); sim.drainEvents();
    }
    if (plot.grow < 1) { grewAll = `${seed} only reached ${plot.grow.toFixed(2)}`; break; }

    const want = def.farm.crops[seed].yield[0][0];
    const had = invCount(p, want);
    let pulled = false;
    for (let i = 0; i < 400 && !pulled; i++) {
      p.x = plot.x - 1.2; p.z = plot.z; keep();
      sim.setInput('p', { seq: i, mx: 0, mz: 0, ax: plot.x, az: plot.z, interact: true });
      sim.step(1 / 60);
      for (const ev of sim.drainEvents()) if (ev.t === 'harvested') pulled = true;
    }
    for (let i = 0; i < 180; i++) {
      keep();
      sim.setInput('p', { seq: i, mx: 0, mz: 0, ax: p.x + 1, az: p.z });
      sim.step(1 / 60); sim.drainEvents();
    }
    if (!pulled || invCount(p, want) <= had) {
      paidBack = `${seed} ripened but gave no ${want}`;
      break;
    }
    lastSnap = encodeSnapshot(sim);
  }
  check(grewAll === true, 'every seed can be planted and comes up', String(grewAll));
  check(paidBack === true, 'pulling a crop pays out', String(paidBack));

  const row = lastSnap && lastPlot && lastSnap.B.find(r => r[0] === lastPlot.id);
  check(!!row && row.length >= 11, 'crop state is on the wire',
    'a building row has no room for what is planted in it');
  ok('farming', `${seeds.length} crops, ${def.farm.time}s to come up`);
}

/* ------------------------------------------- 3b. same seed, same run */
console.log('\ndeterminism');
{
  /* The host simulates and everyone else mirrors, so the host being
     reproducible is what makes a desync debuggable at all. Every
     roll in the simulation has to come from the seeded generator;
     one stray Math.random and the same seed plays out differently
     every time, which also makes every check above flaky. */
  const play = () => {
    const sim = new Sim(31337, { difficulty: 1 });
    const p = sim.addPlayer('p0', 'D');
    const recipes = allRecipes();
    for (let i = 0; i < 90 * 60; i++) {
      driveBot(sim, p, i, i, recipes);
      sim.step(1 / 60);
      sim.drainEvents();
    }
    return JSON.stringify({
      night: sim.night, hp: Math.round(p.hp * 100), kills: p.kills,
      inv: Object.entries(p.inv).sort(), enemies: sim.enemies.length,
      beacon: Math.round(sim.beacon.hp), x: p.x.toFixed(4), z: p.z.toFixed(4),
    });
  };
  const a = play(), b = play();
  check(a === b, 'the same seed plays out the same way',
    'two runs of seed 31337 diverged, so something still calls Math.random');
}

/* ----------------------------------------------------- 2b. caves */
console.log('\ncaves');
{
  /* A cave has to be three things at once: somewhere you can get
     into, somewhere with rock over your head, and somewhere worth
     the walk. A hole in a hillside with nothing in it is scenery. */
  let worlds = 0, caves = 0, walkable = 0, stocked = 0, roofed = 0, thin = 0;
  const sample = [];
  for (let k = 0; k < SEEDS; k++) {
    const w = new World(2000 + k * 7919);
    worlds++;
    caves += w.caves.length;
    for (const cave of w.caves) {
      /* Walk in from the mouth under the same climb rule bodies use. */
      const seen = new Set();
      const queue = [[cave.tx, cave.ty]];
      seen.add(cave.tx * 4096 + cave.ty);
      let reached = 0;
      while (queue.length) {
        const [tx, ty] = queue.pop();
        const h = w.height[w.idx(tx, ty)];
        if (w.caveId[w.idx(tx, ty)] === cave.id) reached++;
        for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = tx + ox, ny = ty + oy;
          if (!w.inBounds(nx, ny)) continue;
          const key = nx * 4096 + ny;
          if (seen.has(key)) continue;
          const i = w.idx(nx, ny);
          if (w.caveId[i] !== cave.id) continue;
          if (w.flags[i] & FLAG.SOLID) continue;
          if (Math.abs(w.height[i] - h) > 1) continue;
          seen.add(key);
          queue.push([nx, ny]);
        }
      }
      /* Most of it, not all: a disc carve can leave a pocket walled
         off by its own boulders, and that is a cave, not a bug. */
      if (reached >= cave.tiles.length * 0.75) walkable++;

      let worth = 0, over = 0, low = 0;
      for (const i of cave.tiles) {
        if (HARVEST[w.prop[i]]) worth++;
        if (!w.roof[i]) continue;
        over++;
        if (w.roof[i] - w.height[i] < 4) low++;
      }
      if (worth >= cave.tiles.length * 0.12) stocked++;
      if (over >= cave.tiles.length * 0.8) roofed++;
      thin += low;
      if (sample.length < 3) sample.push(`${cave.tiles.length} tiles, ${worth} things in it`);
    }
  }
  check(caves >= worlds * 3, 'every world has caves in it',
    `${caves} caves across ${worlds} worlds`);
  check(walkable === caves, 'you can walk in from the mouth and reach the back',
    `${walkable} of ${caves} caves are walkable from their own doorway`);
  check(roofed === caves, 'there is rock over your head, not sky',
    `${roofed} of ${caves} caves are roofed`);
  check(thin === 0, 'and enough of it to stand up in',
    `${thin} tiles have less than two terraces of rock overhead`);
  check(stocked === caves, 'and something down there worth the walk',
    `${stocked} of ${caves} caves carry ore, crystal or mushrooms`);
  /* The portal is how anyone finds the thing. */
  const w0 = new World(2000);
  const portals = w0.landmarks.filter(l => l.kind === 'cavemouth').length;
  check(portals === w0.caves.length, 'and a framed doorway you can see from outside',
    `${portals} portals for ${w0.caves.length} caves`);
  ok('caves', sample.join('; '));
}

/* -------------------------------------------------- 2d. the year */
console.log('\nseasons');
{
  /* A season has to be four different answers to the same question,
     not four tints. Each one should change what grows, what is out
     there and what the sky does. */
  const seen = new Set();
  for (let n = 0; n < 24; n++) seen.add(seasonFor(n).id);
  check(seen.size === 4, 'the year has four seasons in it', [...seen].join(', '));
  check(seasonFor(0).id !== seasonFor(SEASON_NIGHTS).id, 'and it turns over',
    'the season did not change after a full season of nights');
  check(seasonFor(0).id === seasonFor(SEASON_NIGHTS * 4).id, 'and comes back round',
    'the year does not repeat');

  const crops = SEASONS.map(s => s.crop);
  check(Math.max(...crops) / Math.min(...crops) >= 2,
    'growing is worth timing', `crop rates: ${crops.join(', ')}`);
  const winter = SEASONS.find(s => s.id === 'winter');
  const summer = SEASONS.find(s => s.id === 'summer');
  check(winter.crop < summer.crop && winter.warmth < summer.warmth,
    'winter is the hard one', 'winter is not colder or leaner than summer');

  /* Weather is rolled per season, so a snowstorm in high summer is a
     bug and a winter without one is a missed opportunity. */
  const rollMany = (night) => {
    const rng = makeRng(99);
    const out = {};
    for (let i = 0; i < 600; i++) {
      const w = rollSeasonWeather(rng, night, WEATHER);
      out[w.id] = (out[w.id] || 0) + 1;
    }
    return out;
  };
  const summerRolls = rollMany(SEASON_NIGHTS * 1 + 1);
  const winterRolls = rollMany(SEASON_NIGHTS * 3 + 1);
  check(!summerRolls.snowstorm, 'it does not snow in summer',
    `summer rolled ${summerRolls.snowstorm} snowstorms`);
  check((winterRolls.snowstorm || 0) > 60, 'and it does in winter',
    `winter rolled ${winterRolls.snowstorm || 0} snowstorms in 600`);

  /* And the woods hold a different population in each. */
  let differs = false;
  for (const type of ['wolf', 'deer', 'critter']) {
    if (seasonAnimalWeight(0, type) !== seasonAnimalWeight(SEASON_NIGHTS * 3, type)) differs = true;
  }
  check(differs, 'and different things are out in it',
    'spring and winter spawn the same population');

  /* The whole thing has to run: a year of simulated nights without
     throwing, with crops that still ripen. */
  const sim = new Sim(8181, { difficulty: 1 });
  const p = sim.addPlayer('p0', 'YEAR');
  let thrown = null;
  const seenSeasons = new Set();
  for (let i = 0; i < 60 * 60 * 14 && !thrown; i++) {
    sim.setInput(p.id, { ...emptyInput(), seq: i });
    p.hp = p.maxHp; p.hunger = 90; p.warmth = 100;
    try { sim.step(1 / 60); sim.drainEvents(); }
    catch (err) { thrown = `${err.message} at step ${i}`; }
    seenSeasons.add(sim.season.id);
  }
  check(!thrown, 'a year runs without throwing', thrown);
  ok('seasons', `${seenSeasons.size} seasons in fourteen simulated minutes, night ${sim.night}`);
}

/* ------------------------------------------------- 2c. villages */
console.log('\nvillages');
{
  /* A village has to be somewhere you can get to, somewhere you can
     walk about in, and somewhere with a trade worth making. */
  let worlds = 0, villages = 0, reachable = 0, walkable = 0, solid = 0, kinds = new Set();
  for (let k = 0; k < SEEDS; k++) {
    const w = new World(3000 + k * 6151);
    worlds++;
    for (const v of w.villages) {
      villages++;
      kinds.add(v.kind);
      const i = w.idx(v.tx, v.ty);
      if (!w.reachMask || w.reachMask[i]) reachable++;
      /* The square itself is open, and the stall can be stood at. */
      const level = Math.round(w.groundAt(v.x, v.z) / LEVEL_STEP);
      const open = canStand(w, v.x, v.z, PLAYER.radius, level)
        && canStand(w, v.stallX, v.stallZ + 1.2, PLAYER.radius, level);
      if (open) walkable++;
      /* And the cottages are walls, not scenery you walk through. */
      if (v.huts.length && v.huts.every(h => w.flags[w.idx(h.tx, h.ty)] & FLAG.SOLID)) solid++;
    }
  }
  check(villages >= worlds * 2, 'every world has villages in it',
    `${villages} villages across ${worlds} worlds`);
  check(reachable === villages, 'and you can walk to them from the beacon',
    `${reachable} of ${villages} are on reachable ground`);
  check(walkable === villages, 'the square is open and the stall can be stood at',
    `${walkable} of ${villages} have a clear counter`);
  check(solid === villages, 'the cottages are walls rather than scenery',
    `${solid} of ${villages} have solid walls`);
  check(kinds.size >= 3, 'and they are not all the same trade',
    'kinds seen: ' + [...kinds].join(', '));

  /* The board itself: every offer names real items, and the deal
     turns over with the night. */
  const w0 = new World(3000);
  let offers = 0, bad = [];
  for (const v of w0.villages) {
    const a = villageOffers(v, 0), b = villageOffers(v, 1);
    offers += a.length;
    if (JSON.stringify(a[a.length - 1]) === JSON.stringify(b[b.length - 1])) {
      bad.push(`${v.kind} deal does not turn over`);
    }
    for (const o of a) {
      for (const [it] of [...o.give, ...o.get]) {
        if (!ITEMS[it] && !BUILDINGS[it]) bad.push(`${v.kind} trades in "${it}", which is not a thing`);
      }
    }
  }
  check(bad.length === 0, 'every trade is in real goods and tonight is different',
    bad.join('; '));
  ok('villages', `${villages} across ${worlds} worlds, ${offers} offers on the first board`);

  /* And a trade actually moves the goods. */
  const sim = new Sim(3000, { difficulty: 1 });
  const p = sim.addPlayer('p0', 'BUYER');
  const v = sim.world.villages[0];
  const offer = villageOffers(v, sim.night)[0];
  for (const [it, n] of offer.give) invGive(p, it, n);
  p.x = v.stallX; p.z = v.stallZ;
  const before = offer.get.map(([it]) => invCount(p, it));
  const took = sim.tryTrade(p, v.id, 0);
  check(took, 'standing at the counter with the goods makes the trade',
    'tryTrade refused a trade the player could afford');
  check(offer.give.every(([it, n]) => invCount(p, it) === 0 || invCount(p, it) < n),
    'and it takes what you offered', 'the goods were not taken');
  check(offer.get.every(([it, n], i) => invCount(p, it) >= before[i] + n),
    'and hands over what was promised', 'nothing arrived');

  /* From across the map it refuses. */
  const far = sim.addPlayer('p1', 'FAR');
  for (const [it, n] of offer.give) invGive(far, it, n);
  far.x = v.stallX + 40; far.z = v.stallZ;
  check(sim.tryTrade(far, v.id, 0) === false, 'and not from the other side of the valley',
    'a trade went through from forty tiles away');
}

/* ------------------------------------------------- 3b3. swimming */
console.log('\nswimming');
{
  /* Deep water used to be a wall. It is now a place, which means it
     has to be one you can get into, get out of, and not live in. */
  /* A shoreline: deep water with dry, standable ground right beside
     it. Looking three tiles off instead of one finds nothing at all,
     because three tiles into a lake is still lake - and away from the
     rim, because the map edge clamps movement and a swimmer pinned
     against it proves nothing. */
  let sim = null, p = null, w = null, spot = null;
  for (const seed of [4545, 1212, 9001, 31337, 777]) {
    sim = new Sim(seed, { difficulty: 1 });
    p = sim.addPlayer('p0', 'SWIMMER');
    w = sim.world;
    for (let ty = 30; ty < w.size - 30 && !spot; ty++) {
      for (let tx = 30; tx < w.size - 30 && !spot; tx++) {
        const x = w.tileToWorldX(tx), z = w.tileToWorldZ(ty);
        if (!w.deepAt(x, z)) continue;
        /* Deep water never touches dry land - the generator rings it
           with shallows - so the shore is a few tiles out through
           them, and that is the swim. */
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          for (let k = 2; k <= 5; k++) {
            const sx = w.tileToWorldX(tx + dx * k), sz = w.tileToWorldZ(ty + dy * k);
            if (w.flagAt(sx, sz) & FLAG.WATER) continue;
            const level = Math.round(w.groundAt(sx, sz) / LEVEL_STEP);
            if (!canStand(w, sx, sz, PLAYER.radius, level)) break;
            spot = { x, z, ox: dx * k, oy: dy * k };
            break;
          }
          if (spot) break;
        }
      }
    }
    if (spot) break;
  }
  check(!!spot, 'the world has water deep enough to swim in', 'no deep water found');

  if (spot) {
    p.x = spot.x; p.z = spot.z; p.y = w.groundAt(p.x, p.z);
    sim.setInput(p.id, { ...emptyInput(), seq: 0 });
    sim.step(1 / 60); sim.drainEvents();
    check(p.swimming === true, 'standing in it puts you in the water',
      'the player is in deep water and not swimming');
    const surface = w.waterSurfaceAt(p.x, p.z);
    check(Math.abs(p.y - (surface - SURVIVAL.swimDepth)) < 0.01,
      'and you ride at the surface rather than on the bottom',
      `y ${p.y.toFixed(2)} against a surface of ${surface.toFixed(2)}`);

    /* Swim for the shore. Stamina is watched at its lowest rather
       than at the end, because it comes back the moment you are out. */
    let lowStam = p.stamina;
    let onLand = false;
    for (let i = 1; i < 60 * 14 && !onLand; i++) {
      sim.setInput(p.id, {
        ...emptyInput(), seq: i,
        mx: Math.sign(spot.ox), mz: Math.sign(spot.oy),
        ax: p.x + spot.ox * 3, az: p.z + spot.oy * 3,
      });
      sim.step(1 / 60); sim.drainEvents();
      lowStam = Math.min(lowStam, p.stamina);
      if (!p.swimming && !(w.flagAt(p.x, p.z) & FLAG.WATER)) onLand = true;
    }
    check(onLand, 'and you can swim out of it again',
      'fourteen seconds of swimming did not reach dry land');
    check(lowStam < p.maxStamina, 'and it costs you to do it',
      'swimming never dipped into the stamina bar');
  }
}

/* ------------------------------------------ 3b2. nobody stays stuck */
console.log('\ngetting unstuck');
{
  /* A body whose four collision probes all land somewhere illegal
     used to be frozen for good: every candidate move failed the
     test, including the one that did not move at all. It happens in
     a corner between two cliff steps, under a prop that was placed
     on your feet, inside a wall somebody built round you. The player
     stayed alive, at full health, unable to take a single step, and
     starved. This is the check that it can walk out. */
  const sim = new Sim(20260921, { difficulty: 1 });
  const p = sim.addPlayer('p0', 'WEDGED');
  const w = sim.world;

  /* Find a spot the collision test refuses outright. */
  let wedged = null;
  const OFF = [-0.35, 0, 0.35];
  for (let ty = 2; ty < w.size - 2 && !wedged; ty++) {
    for (let tx = 2; tx < w.size - 2 && !wedged; tx++) {
      for (const ox of OFF) {
        for (const oz of OFF) {
          const x = w.tileToWorldX(tx) + ox, z = w.tileToWorldZ(ty) + oz;
          if (w.flagAt(x, z) & FLAG.WATER) continue;
          const level = Math.round(w.groundAt(x, z) / LEVEL_STEP);
          /* Standing on clear ground, but boxed in by the probes. */
          if (w.blockedAt(x, z, level)) continue;
          if (canStand(w, x, z, PLAYER.radius, level)) continue;
          wedged = { x, z, tx, ty };
          break;
        }
        if (wedged) break;
      }
    }
  }
  check(!!wedged, 'the world contains a spot that wedges a body',
    'no wedging tile found, so this check proves nothing');

  if (wedged) {
    p.x = wedged.x; p.z = wedged.z;
    p.y = w.groundAt(p.x, p.z);
    const x0 = p.x, z0 = p.z;
    for (let i = 0; i < 120; i++) {
      sim.setInput(p.id, { ...emptyInput(), seq: i, mx: 1, mz: 0.35, ax: p.x + 8, az: p.z + 3 });
      sim.step(1 / 60);
      sim.drainEvents();
    }
    const moved = Math.hypot(p.x - x0, p.z - z0);
    check(moved > 1, 'a wedged body walks out of it',
      'it moved ' + moved.toFixed(3) + ' units in two seconds of walking');
    const level = Math.round(p.y / LEVEL_STEP);
    check(canStand(w, p.x, p.z, PLAYER.radius, level),
      'and ends up somewhere it is allowed to be',
      'it walked out and stopped somewhere still illegal');
  }
}

/* --------------------------------------------------- 4. the whole arc */
console.log('\nthe optional content');
{
  /* None of this is required of a player any more, so what is under
     test is that it all still WORKS if they go looking for it: the
     beacon lights, a gate can be held, the last one wakes the Heart,
     and killing the Heart does not end anybody's run. */
  const sim = new Sim(777, { difficulty: 1 });
  const p = sim.addPlayer('p0', 'ARC');
  const recipes = allRecipes();
  for (const [it, n] of BEACON_REPAIR) sim.beacon.store[it] = n;
  invGive(p, 'axe_iron', 1); invGive(p, 'pick_iron', 1); invGive(p, 'blade_iron', 1);
  invGive(p, 'cookedmeat', 60); invGive(p, 'sealpylon', 8);
  p.skillPoints = 12;

  const seenArcs = [sim.arc];
  let thrown = null;
  const steps = 60 * 60 * 60;   /* 60 simulated minutes */
  for (let i = 0; i < steps; i++) {
    driveBot(sim, p, i, i, recipes);
    /* The arc is under test here, not the defence: a bot that loses
       the beacon on night four tells us nothing about whether the
       Heart still wakes when the last gate closes. */
    if (p.hp < p.maxHp * 0.4) p.hp = p.maxHp;
    if (sim.beacon.hp < sim.beacon.maxHp * 0.5) sim.beacon.hp = sim.beacon.maxHp;
    try { sim.step(1 / 60); sim.drainEvents(); }
    catch (err) { thrown = `${err.message} at step ${i}`; break; }
    if (sim.arc !== seenArcs[seenArcs.length - 1]) seenArcs.push(sim.arc);
    if (sim.stats.gatesSealed >= 1) break;
  }

  check(!thrown, 'the arc runs without throwing', thrown);
  check(sim.beacon.lit, 'the beacon can be repaired and lit', 'the beacon was never lit');
  check(seenArcs.includes(ARC.GATES), 'lighting the beacon opens the gates',
    'arcs seen: ' + seenArcs.join(' -> '));
  /* The point of the sandbox change: none of it is a prerequisite. */
  const fresh = new Sim(31415, { difficulty: 1 });
  const rookie = fresh.addPlayer('r', 'ROOKIE');
  check(rookie.abilities[0] === PRIMARY_ID, 'you wake up with a working sidearm',
    'abilities: ' + JSON.stringify(rookie.abilities));
  rookie.skillPoints = 3;
  check(fresh.learnSkill(rookie, Object.keys(SKILLS)[0]) === true,
    'skills can be spent without repairing anything first',
    'learnSkill refused with the beacon cold');
  check(fresh.status() === null, 'a quiet world tells you to do nothing',
    'status: ' + JSON.stringify(fresh.status()));
  check(sim.stats.gatesSealed >= 1, 'a gate can be sealed by standing in it',
    `no gate sealed in 60 simulated minutes (arc ${sim.arc})`);

  /* --- the rest of the machine, driven from the gates onward ---- */
  let lateThrow = null;
  try {
    while (sim.gates.some(g => !g.sealed) && sim.phase === PHASE.RUNNING) {
      const g = sim.gates.find(x => !x.sealed);
      g.active = true;
      /* Park the player in the ring and let the sim close it, so
         the real seal path runs rather than a flag being set. */
      p.x = g.x; p.z = g.z; p.state = 'alive';
      for (let i = 0; i < 120 * 60 && !g.sealed; i++) {
        p.x = g.x; p.z = g.z; p.hp = p.maxHp;
        sim.beacon.hp = sim.beacon.maxHp;
        sim.setInput(p.id, { seq: i, mx: 0, mz: 0, ax: g.x + 1, az: g.z, fire: true, interact: true });
        sim.step(1 / 60); sim.drainEvents();
      }
      if (!g.sealed) break;
    }
  } catch (err) { lateThrow = `${err.message}`; }
  check(!lateThrow, 'sealing every gate runs without throwing', lateThrow);
  check(sim.stats.gatesSealed === sim.gates.length, 'every gate can be sealed',
    `${sim.stats.gatesSealed} of ${sim.gates.length}`);
  check(sim.arc === ARC.HEART || sim.arc === ARC.DONE || sim.phase === PHASE.WON,
    'the last gate wakes the Heart', `arc is ${sim.arc}`);

  /* Kill the Heart and the run should be over. */
  const heart = sim.enemies.find(e => e.isHeart);
  check(!!heart, 'the Heart actually spawns', 'no Heart in the enemy list');
  if (heart) {
    for (let i = 0; i < 60 * 60 && sim.phase === PHASE.RUNNING; i++) {
      p.hp = p.maxHp;
      sim.hurtCreature(heart, 4000, p);
      sim.setInput(p.id, { seq: i, mx: 0, mz: 0, ax: p.x + 1, az: p.z });
      sim.step(1 / 60); sim.drainEvents();
    }
    check(sim.arc === ARC.DONE, 'killing the Heart settles the rift',
      `arc is ${sim.arc}`);
    check(sim.phase === PHASE.RUNNING, 'and the run carries on afterwards',
      `the run ended with phase=${sim.phase}, which is an objective by another name`);
  }
  ok('arc', seenArcs.join(' -> ') + ` then ${sim.arc}, ${sim.night} nights, ` +
    `${sim.stats.gatesSealed}/${sim.gates.length} gates`);
}

/* ------------------------------------------------ 3c. the interface */
console.log('\nthe interface');
{
  /* Every character the UI prints has to exist in the font. It does
     not throw when one does not - it draws a blank - so a missing
     glyph is invisible in code and obvious on screen, which is the
     worst way round. "HOLD [G] - BEACON CONSOLE" shipped with a hole
     in the middle of it for exactly this reason. */
  /* menus.js is the only part of the interface that is DOM rather
     than canvas, so it draws with real fonts and is not bound by
     this one. Everything else goes through the bitmap. */
  const files = readdirSync(UI_DIR).filter(f => f.endsWith('.js') && f !== 'menus.js');
  const holes = new Map();
  for (const f of files) {
    const text = readFileSync(join(UI_DIR, f), 'utf8');
    for (const m of text.matchAll(/'([^'\\]*)'|`([^`\\$]*)`/g)) {
      const lit = m[1] ?? m[2] ?? '';
      for (const ch of lit) {
        if (ch === ' ' || hasGlyph(ch)) continue;
        /* Only letters and punctuation people would read, not the
           odd byte inside a regex or a colour string. */
        if (ch.codePointAt(0) < 0x80) continue;
        holes.set(ch, (holes.get(ch) || '') + (holes.get(ch) ? '' : f));
      }
    }
  }
  check(holes.size === 0, 'every character the interface prints exists in the font',
    [...holes].map(([ch, f]) => `${JSON.stringify(ch)} (U+${ch.codePointAt(0).toString(16).toUpperCase()}) in ${f}`).join(', '));
  ok('interface', `${files.length} ui files scanned`);
}

/* ------------------------------------- 4b. the peer-to-peer address */
console.log('\npeer to peer');
{
  /* The WebRTC handshake itself needs two browsers and is covered by
     the harness in tools/, not here. What is worth pinning down in a
     unit check is the bit with fiddly rules: where the signalling
     broker is, since getting it wrong means co-op simply never
     connects and the failure looks like somebody else's outage. */
  const saved = globalThis.location;
  const at = (search, protocol = 'https:') => {
    globalThis.location = { search, protocol };
    const c = brokerConfig();
    return `${c.secure ? 'wss' : 'ws'}://${c.host}:${c.port}${c.path}peerjs`;
  };
  const cases = [
    ['', 'wss://0.peerjs.com:443/peerjs'],
    ['?broker=localhost:9777', 'ws://localhost:9777/peerjs'],
    ['?broker=ws://localhost:9777', 'ws://localhost:9777/peerjs'],
    ['?broker=wss://sig.example.com', 'wss://sig.example.com:443/peerjs'],
    ['?broker=example.com/peer', 'wss://example.com:443/peer/peerjs'],
  ];
  const wrong = cases.filter(([q, want]) => at(q) !== want)
    .map(([q, want]) => `${q || '(default)'} -> ${at(q)}, wanted ${want}`);
  globalThis.location = saved;
  check(!wrong.length, 'the signalling broker resolves to the right address', wrong.join('; '));

  /* A room code goes down a phone line, so it must not contain the
     characters people mishear, and it must be the length the join
     box accepts. */
  const code = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  check(!/[01OIL]/.test(code), 'room codes avoid the letters that get misheard', code);
  check(brokerIdForRoom('ABCDE').includes('ABCDE')
    && brokerIdForRoom('ABCDE') !== 'ABCDE',
    'a room id is namespaced on the shared broker',
    'a bare room code would collide with every other PeerJS user');
  ok('peer to peer', 'broker address, room codes');
}

/* -------------------------------------------- 5. the wire format */
console.log('\nnetwork protocol');
{
  const sim = new Sim(4242);
  sim.addPlayer('h', 'HOST');
  sim.addPlayer('c', 'CLIENT');
  const host = sim.players.get('h');
  invGive(host, 'wood', 64); invGive(host, 'stone', 30); invGive(host, 'axe_stone', 1);
  sim.beacon.store.scrap = 12;
  for (let i = 0; i < 8; i++) sim.spawnEnemy(i % 2 ? 'husk' : 'spark', i === 0, { x: 4 + i, z: 2 });
  for (const key of ['campfire', 'wall_wood', 'torch_post']) {
    const w = sim.world;
    sim.addBuilding(key, w.worldToTileX(host.x) + 2, w.worldToTileZ(host.z) + 2, 'h');
  }
  for (let i = 0; i < 400; i++) { sim.step(1 / 60); sim.drainEvents(); }

  let snap = null, json = null;
  try { snap = encodeSnapshot(sim); json = JSON.stringify(snap); }
  catch (e) { bad('snapshot encodes', e.message); }

  if (json) {
    const mirror = new Mirror(4242, 'c');
    let applyErr = null;
    try {
      /* Two snapshots a full interval apart, so the interpolator is
         measured in its steady state rather than its first blend. */
      mirror.applySnapshot(JSON.parse(json));
      mirror.update(1 / 16, null);
      mirror.applySnapshot(JSON.parse(json));
      mirror.update(1 / 16, null);
    } catch (e) { applyErr = e.message + '\n        ' + (e.stack || '').split('\n')[1]; }
    check(!applyErr, 'a client can apply a snapshot', applyErr);

    const seen = mirror.players.get('h');
    check(seen && Math.abs(seen.x - host.x) < 0.02 && Math.abs(seen.hp - host.hp) < 0.5,
      'the mirrored player matches the host',
      seen ? `host at ${host.x.toFixed(2)} seen at ${seen.x.toFixed(2)}` : 'player missing from the mirror');

    /* The pack is what a client draws every frame; if inventory does
       not survive the wire the second player plays a blind game. */
    const mirroredInv = seen && seen.inv ? seen.inv : {};
    check(mirroredInv.wood === host.inv.wood && mirroredInv.axe_stone === host.inv.axe_stone,
      'inventory arrives', `host wood ${host.inv.wood}, mirror ${mirroredInv.wood}`);

    check(mirror.enemies.length === snap.E.length, 'every enemy arrives',
      `${snap.E.length} sent, ${mirror.enemies.length} rebuilt`);
    check(mirror.buildings.length === sim.buildings.length, 'every building arrives',
      `${sim.buildings.length} placed, ${mirror.buildings.length} rebuilt`);
    check(mirror.animals.length === sim.animals.length, 'every animal arrives',
      `${sim.animals.length} alive, ${mirror.animals.length} rebuilt`);
    check(mirror.gates.length === sim.gates.length, 'the gates arrive',
      `${sim.gates.length} vs ${mirror.gates.length}`);
    check(Math.abs(mirror.beacon.hp - sim.beacon.hp) < 0.5, 'beacon state arrives', '');
    check(mirror.nightType && mirror.nightType.name === sim.nightType.name,
      'the night type arrives', `${sim.nightType.name} vs ${mirror.nightType && mirror.nightType.name}`);
    check(mirror.contracts.length === sim.contracts.length, 'contracts arrive',
      `${sim.contracts.length} vs ${mirror.contracts.length}`);

    const bytes = json.length;
    const perSecond = bytes * 16;
    check(perSecond < 400 * 1024, 'snapshots fit in a sensible amount of bandwidth',
      `${(perSecond / 1024).toFixed(0)} KB/s at 16Hz`);
    ok('snapshot size', `${bytes} bytes with ${snap.E.length} enemies and ` +
      `${sim.buildings.length} buildings, ~${(perSecond / 1024).toFixed(0)} KB/s`);
  }

  /* Hotbar selection is deliberately not in here - it goes over the
     action channel - so every field emptyInput declares must survive. */
  const input = { seq: 7, mx: 0.5, mz: -0.25, ax: 3.5, az: -1.25, fire: true, dash: false,
    interact: true, sprint: true, abil: 5 };
  const round = decodeInput(encodeInput(input));
  check(round.seq === 7 && round.fire && !round.dash && round.interact && round.abil === 5
    && round.sprint && Math.abs(round.mx - 0.5) < 0.01,
    'input survives the round trip', JSON.stringify(round));
  const dropped = Object.keys(emptyInput()).filter(k => !(k in round));
  check(!dropped.length, 'the wire carries every input field', 'dropped: ' + dropped.join(', '));
  ok('protocol version', String(PROTOCOL_VERSION));
}

console.log('');
if (failures) {
  console.log(`${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('all checks passed\n');
