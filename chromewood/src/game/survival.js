/* ============================================================
   survival.js - inventory, work, and the noise it makes

   The loop this file implements: you swing at the world, the world
   gives you materials, and the materials become tools that let you
   swing at better things. What makes it more than a chore is
   Resonance - every swing, every forge, every shot is heard by the
   rift, and what it hears decides where the night goes.

   All functions take the simulation first and mutate it. They run
   on the host only; clients see the results in snapshots.
   ============================================================ */

import { ITEMS, BUILDINGS, RECIPES, SMELTING, BEACON_REPAIR } from './items.js';
import { HARVEST, PROP, FLAG, CLIMB } from '../world/worldgen.js';
import { SURVIVAL, RESONANCE, TILE } from '../core/config.js';
import { clamp, dist2 } from '../core/util.js';

/* ------------------------------------------------------ inventory */
export function invCount(p, item) { return p.inv[item] || 0; }

export function invGive(p, item, n) {
  if (!ITEMS[item] || n <= 0) return 0;
  const cap = ITEMS[item].stack * 4;
  const before = p.inv[item] || 0;
  const after = Math.min(cap, before + n);
  p.inv[item] = after;
  /* A new kind of thing goes straight onto the hotbar if there is
     room, so you are never hunting for the axe you just made. */
  if (before === 0 && after > 0) autoHotbar(p, item);
  return after - before;
}

export function invTake(p, item, n) {
  const have = p.inv[item] || 0;
  if (have < n) return false;
  if (have === n) delete p.inv[item]; else p.inv[item] = have - n;
  if (!p.inv[item]) {
    for (let i = 0; i < p.hotbar.length; i++) if (p.hotbar[i] === item) p.hotbar[i] = null;
  }
  return true;
}

export function invHasAll(p, list) {
  for (const [item, n] of list) if ((p.inv[item] || 0) < n) return false;
  return true;
}

export function invTakeAll(p, list) {
  if (!invHasAll(p, list)) return false;
  for (const [item, n] of list) invTake(p, item, n);
  return true;
}

function autoHotbar(p, item) {
  const d = ITEMS[item];
  if (!d) return;
  /* Only things you would actually hold. */
  if (!(d.tool || d.food || BUILDINGS[item])) return;
  if (p.hotbar.includes(item)) return;
  const free = p.hotbar.indexOf(null);
  if (free >= 0) p.hotbar[free] = item;
}

export function heldItem(p) {
  const id = p.hotbar[p.hotbarIndex];
  if (!id || !(p.inv[id] > 0)) return null;
  return id;
}

export function heldTool(p) {
  const id = heldItem(p);
  const d = id && ITEMS[id];
  return d && d.tool ? { id, ...d.tool } : null;
}

/* The best tool of a kind you are carrying, which is what decides
   whether a vein is even minable - not what happens to be in hand. */
export function bestToolTier(p, kind) {
  let best = 0;
  for (const id of Object.keys(p.inv)) {
    const d = ITEMS[id];
    if (d && d.tool && d.tool.kind === kind) best = Math.max(best, d.tool.tier);
  }
  return best;
}

/* ------------------------------------------------------ resonance */
/* A coarse grid of "how much noise has happened here lately". The
   rift reads it; dampeners subtract from it; lures add to it
   somewhere you are not. */
export class ResonanceField {
  constructor(world) {
    this.world = world;
    this.cell = RESONANCE.cellTiles;
    this.w = Math.ceil(world.size / this.cell);
    this.data = new Float32Array(this.w * this.w);
    this.peak = 0;
  }
  index(x, z) {
    const tx = Math.floor((this.world.worldToTileX(x)) / this.cell);
    const tz = Math.floor((this.world.worldToTileZ(z)) / this.cell);
    if (tx < 0 || tz < 0 || tx >= this.w || tz >= this.w) return -1;
    return tz * this.w + tx;
  }
  add(x, z, amount) {
    const i = this.index(x, z);
    if (i < 0) return;
    this.data[i] = Math.min(RESONANCE.max, this.data[i] + amount);
  }
  at(x, z) {
    const i = this.index(x, z);
    return i < 0 ? 0 : this.data[i];
  }
  /* World position of the loudest cell, which is where the night
     will aim. Ties break toward the cell closest to `near`. */
  hotspot(near) {
    let best = -1, bestV = RESONANCE.threshold;
    for (let i = 0; i < this.data.length; i++) {
      let v = this.data[i];
      if (v <= bestV) continue;
      bestV = v; best = i;
    }
    if (best < 0) return null;
    const cx = (best % this.w) * this.cell + this.cell / 2;
    const cz = Math.floor(best / this.w) * this.cell + this.cell / 2;
    return { x: this.world.tileToWorldX(cx), z: this.world.tileToWorldZ(cz), value: bestV };
  }
  decay(dt, dampers) {
    const k = Math.exp(-RESONANCE.decay * dt);
    let peak = 0;
    for (let i = 0; i < this.data.length; i++) {
      let v = this.data[i] * k;
      if (v < 0.01) v = 0;
      this.data[i] = v;
      if (v > peak) peak = v;
    }
    /* Dampeners eat noise in a radius, which is the whole reason to
       build one next to a forge. */
    for (const d of dampers) {
      const def = BUILDINGS[d.key].damper;
      const r = Math.ceil(def.radius / (this.cell * TILE));
      const ci = this.index(d.x, d.z);
      if (ci < 0) continue;
      const cx = ci % this.w, cz = Math.floor(ci / this.w);
      for (let z = -r; z <= r; z++) {
        for (let x = -r; x <= r; x++) {
          const nx = cx + x, nz = cz + z;
          if (nx < 0 || nz < 0 || nx >= this.w || nz >= this.w) continue;
          const falloff = 1 - Math.min(1, Math.hypot(x, z) / r);
          this.data[nz * this.w + nx] *= 1 - (1 - def.factor) * falloff;
        }
      }
    }
    this.peak = peak;
  }
}

/* ------------------------------------------------------ gathering */
/* One swing. Picks whatever is in front of the player and applies
   the held tool to it: scenery, a creature, or your own building
   if you are holding nothing and want it back. */
export function swing(sim, p) {
  if (p.swingCd > 0 || p.state !== 'alive') return false;
  const tool = heldTool(p);
  const reach = (tool && tool.reach) || SURVIVAL.baseReach;
  const speed = (tool && tool.speed) || 0.85;
  const cost = SURVIVAL.swingStamina;
  if (p.stamina < cost) { sim.emit({ t: 'tired', id: p.id }); return false; }

  p.stamina -= cost;
  p.swingCd = 1 / (SURVIVAL.swingsPerSecond * speed);
  p.anim.attack = 1;

  const dx = Math.cos(p.facing), dz = Math.sin(p.facing);
  const hx = p.x + dx * reach * 0.7, hz = p.z + dz * reach * 0.7;
  sim.emit({ t: 'swing', id: p.id, x: hx, y: p.y + 0.8, z: hz, facing: p.facing,
    tool: tool ? tool.kind : 'hand' });
  sim.resonance.add(p.x, p.z, RESONANCE.perSwing);

  /* Creatures first: if something is in reach, you meant to hit it. */
  const target = sim.creatureInArc(p.x, p.z, p.facing, reach + 0.4, 1.4);
  if (target) {
    const dmg = ((tool && tool.damage) || SURVIVAL.fistDamage) * p.stats.power;
    sim.hurtCreature(target, dmg, p, { knock: (tool && tool.knock) || 2 });
    return true;
  }

  /* Then a building of your own, to take it back down. */
  const b = sim.buildingInFront(p, reach);
  if (b && (!tool || tool.kind !== 'axe')) {
    sim.damageBuilding(b, ((tool && tool.damage) || SURVIVAL.fistDamage) * 2.2, p);
    return true;
  }

  /* Then whatever is growing or outcropping within the swing. */
  const found = findHarvest(sim, p, reach + 0.4);
  if (found) return harvestTile(sim, p, found.tx, found.ty, tool);
  return harvestAt(sim, p, hx, hz, tool);
}

/* What a swing should actually connect with.

   The old rule was "the one tile exactly 1.19m ahead of you". A tree
   fills its tile so you always hit it, but grass, ferns, flowers and
   mushrooms sit on single scattered tiles, so unless that one point
   landed on that one tile the swing did nothing and said nothing.
   From the player's side small things simply were not destructible.

   So sweep the reach instead, the way hitting a creature already
   does, and prefer what the tool in your hand is for - otherwise
   standing in grass would mean never being able to chop the tree in
   front of you. */
export function findHarvest(sim, p, reach, arc = 1.2) {
  const w = sim.world;
  const held = heldTool(p);
  const kind = held ? held.kind : 'hand';
  const ctx = w.worldToTileX(p.x), cty = w.worldToTileZ(p.z);
  const r = Math.ceil(reach + 0.75);
  let best = null, bestScore = Infinity;

  for (let oy = -r; oy <= r; oy++) {
    for (let ox = -r; ox <= r; ox++) {
      const tx = ctx + ox, ty = cty + oy;
      if (!w.inBounds(tx, ty)) continue;
      const h = HARVEST[w.prop[w.idx(tx, ty)]];
      if (!h) continue;

      const wx = w.tileToWorldX(tx), wz = w.tileToWorldZ(ty);
      const dx = wx - p.x, dz = wz - p.z;
      const d = Math.hypot(dx, dz);
      if (d > reach + 0.75) continue;

      /* Underfoot counts as straight ahead: there is no meaningful
         angle to something you are standing on. */
      let off = 0;
      if (d > 0.45) {
        off = Math.abs(angleDelta(Math.atan2(dz, dx), p.facing));
        if (off > arc) continue;
      }

      /* Alignment matters more than distance, and the wrong kind of
         thing for the tool you are holding loses to the right kind. */
      let score = d + off * 1.5;
      if (h.tool !== kind && !(h.tool === 'hand' && kind === 'hand')) score += 2.5;
      /* Something you cannot break yet should not swallow the swing. */
      if (h.tier > bestToolTier(p, h.tool === 'hand' ? 'blunt' : h.tool)) score += 6;
      if (score < bestScore) { bestScore = score; best = { tx, ty }; }
    }
  }
  return best;
}

function angleDelta(a, b) {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export function harvestAt(sim, p, x, z, tool) {
  const w = sim.world;
  const tx = w.worldToTileX(x), ty = w.worldToTileZ(z);
  if (!w.inBounds(tx, ty)) return false;
  return harvestTile(sim, p, tx, ty, tool);
}

export function harvestTile(sim, p, tx, ty, tool) {
  const w = sim.world;
  const i = w.idx(tx, ty);
  const prop = w.prop[i];
  const h = HARVEST[prop];
  if (!h) return false;

  const tier = bestToolTier(p, h.tool === 'hand' ? 'blunt' : h.tool);
  if (h.tier > 0 && tier < h.tier) {
    sim.emit({ t: 'toolneeded', id: p.id, need: h.tool, tier: h.tier,
      x: w.tileToWorldX(tx), y: w.heightAtTile(tx, ty), z: w.tileToWorldZ(ty) });
    return false;
  }

  /* The right tool does its power; the wrong one does a fraction,
     so you can always make progress and never want to. */
  let power = SURVIVAL.fistPower;
  if (tool) power = tool.kind === h.tool ? tool.power : tool.power * 0.35;
  power *= 1 + (p.stats.gather || 0);

  const hp = (w.propHp.get(i) || h.hp) - power;
  const px = w.tileToWorldX(tx), py = w.heightAtTile(tx, ty), pz = w.tileToWorldZ(ty);
  sim.resonance.add(px, pz, RESONANCE.perHarvest);

  if (hp > 0) {
    w.propHp.set(i, hp);
    sim.emit({ t: 'prop_hit', tx, ty, x: px, y: py, z: pz, prop, frac: hp / h.hp });
    return true;
  }

  w.clearProp(tx, ty);
  const bonus = 1 + (p.stats.harvest || 0);
  const got = [];
  for (const [item, n] of h.yield) {
    const amount = Math.max(1, Math.round(n * bonus));
    got.push([item, amount]);
  }
  sim.spawnDrops(px, pz, got, p.id);
  sim.emit({ t: 'prop_break', tx, ty, x: px, y: py, z: pz, prop });
  sim.resonance.add(px, pz, RESONANCE.perBreak);
  if (p.onGather) p.onGather(prop);
  sim.noteProgress(p, 'gather', prop);
  return true;
}

/* -------------------------------------------------------- crafting */
export function stationsNear(sim, p) {
  const set = new Set(['hand']);
  for (const b of sim.buildings) {
    if (!b.station || b.hp <= 0) continue;
    if (dist2(b.x, b.z, p.x, p.z) < SURVIVAL.stationRange * SURVIVAL.stationRange) set.add(b.station);
  }
  return set;
}

export function canCraft(sim, p, recipe, stations) {
  if (!stations.has(recipe.station)) return 'station';
  if (!invHasAll(p, recipe.in)) return 'materials';
  return null;
}

export function startCraft(sim, p, recipeIndex) {
  const all = allRecipes();
  const recipe = all[recipeIndex];
  if (!recipe) return false;
  const stations = stationsNear(sim, p);
  const why = canCraft(sim, p, recipe, stations);
  if (why) { sim.emit({ t: 'craftfail', id: p.id, why }); return false; }
  if (!invTakeAll(p, recipe.in)) return false;
  p.craft = { index: recipeIndex, time: recipe.time, total: recipe.time };
  sim.emit({ t: 'craftstart', id: p.id, out: recipe.out[0] });
  return true;
}

export function tickCraft(sim, p, dt) {
  if (!p.craft) return;
  p.craft.time -= dt;
  sim.resonance.add(p.x, p.z, RESONANCE.perCraft * dt);
  if (p.craft.time > 0) return;
  const recipe = allRecipes()[p.craft.index];
  p.craft = null;
  if (!recipe) return;
  const [item, n] = recipe.out;
  invGive(p, item, n);
  sim.emit({ t: 'crafted', id: p.id, item, n, x: p.x, y: p.y, z: p.z });
  sim.noteProgress(p, 'craft', item);
}

let _allRecipes = null;
export function allRecipes() {
  if (!_allRecipes) _allRecipes = RECIPES.concat(SMELTING.map(r => ({ ...r, station: 'forge', smelt: true })));
  return _allRecipes;
}

/* -------------------------------------------------------- building */
export function canPlace(sim, p, key, tx, ty) {
  const def = BUILDINGS[key];
  const w = sim.world;
  if (!def) return 'unknown';
  if (!w.inBounds(tx, ty)) return 'bounds';
  const i = w.idx(tx, ty);
  const f = w.flags[i];
  if (f & FLAG.BUILT) return 'occupied';
  if ((f & FLAG.WATER) && !(f & FLAG.SHALLOW)) return 'water';
  if (w.prop[i] !== PROP.NONE) return 'blocked';
  const wx = w.tileToWorldX(tx), wz = w.tileToWorldZ(ty);
  if (dist2(wx, wz, p.x, p.z) > SURVIVAL.buildRange * SURVIVAL.buildRange) return 'far';
  /* Flat enough to stand on. */
  const h = w.height[i];
  for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (Math.abs(w.levelAt(tx + ox, ty + oy) - h) > CLIMB + 1) return 'uneven';
  }
  if (def.needs) {
    const stations = stationsNear(sim, p);
    const needStation = BUILDINGS[def.needs] ? BUILDINGS[def.needs].station : def.needs;
    if (!stations.has(needStation)) return 'needs';
  }
  /* You pay for a building when you make it, not when you put it
     down. Everything else - the hotbar, the build panel, the
     pickup you drop on death - treats a building as a carried
     item, and billing def.cost here charged the wood a second
     time and left the thing you crafted sitting in your pack. */
  if (invCount(p, key) < 1) return 'materials';
  return null;
}

export function place(sim, p, key, tx, ty) {
  const why = canPlace(sim, p, key, tx, ty);
  if (why) { sim.emit({ t: 'buildfail', id: p.id, why }); return false; }
  if (!invTake(p, key, 1)) { sim.emit({ t: 'buildfail', id: p.id, why: 'materials' }); return false; }
  const b = sim.addBuilding(key, tx, ty, p.id);
  sim.resonance.add(b.x, b.z, RESONANCE.perBuild);
  sim.noteProgress(p, 'build', key);
  return b;
}

/* ------------------------------------------------- body upkeep */
export function tickBody(sim, p, dt) {
  const s = p.stats;

  /* Stamina: spent on swings and sprinting, back quickly when you
     stop. It is a pacing tool, not a resource to manage. */
  const resting = !p.input.fire && !p.sprinting;
  p.stamina = Math.min(p.maxStamina,
    p.stamina + SURVIVAL.staminaRegen * (resting ? 1.6 : 0.5) * dt);

  /* Hunger: slow, and only punishing when fully empty. */
  p.hunger = Math.max(0, p.hunger - SURVIVAL.hungerRate * (p.sprinting ? 1.6 : 1) * dt);
  if (p.hunger <= 0) {
    p.starveTimer = (p.starveTimer || 0) + dt;
    if (p.starveTimer > 1) {
      p.starveTimer = 0;
      sim.hurtPlayer(p, SURVIVAL.starveDamage, null, { silent: true, trueDamage: true });
    }
  } else if (p.hunger > p.maxHunger * 0.55) {
    p.hp = Math.min(p.maxHp, p.hp + SURVIVAL.fedRegen * dt);
  }

  /* Warmth: nights and snow take it, fire and shelter give it back.
     At zero you take damage and move slower, which is what makes a
     campfire the first thing you build. */
  const cold = sim.coldAt(p.x, p.z);
  const warm = sim.warmthAt(p.x, p.z);
  /* Daylight on your back counts for something: out of the cold you
     recover on your own, so warmth is a night problem rather than a
     bar to babysit all run. */
  const net = warm - cold + (cold <= 0.01 ? SURVIVAL.dayWarmth : 0);
  p.warmth = clamp(p.warmth + net * dt, 0, SURVIVAL.maxWarmth);
  if (p.warmth <= 0) {
    p.freezeTimer = (p.freezeTimer || 0) + dt;
    if (p.freezeTimer > 1) {
      p.freezeTimer = 0;
      sim.hurtPlayer(p, SURVIVAL.freezeDamage, null, { silent: true, trueDamage: true });
    }
  }

  /* A held torch is a light source and a small heater. */
  const held = heldItem(p);
  p.lightItem = held && ITEMS[held] && ITEMS[held].light ? ITEMS[held].light : null;
}

export function eat(sim, p, item) {
  const d = ITEMS[item];
  if (!d || !(d.food || d.heal || d.energy)) return false;
  if (!invTake(p, item, 1)) return false;
  if (d.food) p.hunger = Math.min(p.maxHunger, p.hunger + d.food);
  if (d.heal) p.hp = Math.min(p.maxHp, p.hp + d.heal);
  if (d.energy) p.energy = Math.min(p.maxEnergy, p.energy + d.energy);
  if (d.raw && sim.rng() < 0.45) {
    sim.hurtPlayer(p, 8, null, { trueDamage: true });
    sim.emit({ t: 'sick', id: p.id });
  }
  if (d.buff) {
    p.buffs = p.buffs.filter(b => b.id !== d.buff.id);
    p.buffs.push({ id: d.buff.id, name: d.name, time: d.buff.time, mods: d.buff.mods, color: d.tint });
    sim.recalcStats(p);
  }
  sim.emit({ t: 'eat', id: p.id, item, x: p.x, y: p.y, z: p.z });
  return true;
}

export function beaconRepairProgress(sim) {
  const need = BEACON_REPAIR;
  let have = 0, total = 0;
  for (const [item, n] of need) {
    total += n;
    have += Math.min(n, sim.beacon.store[item] || 0);
  }
  return total > 0 ? have / total : 1;
}

export function depositToBeacon(sim, p) {
  let moved = 0;
  for (const [item, n] of BEACON_REPAIR) {
    const want = n - (sim.beacon.store[item] || 0);
    if (want <= 0) continue;
    const give = Math.min(want, p.inv[item] || 0);
    if (give <= 0) continue;
    invTake(p, item, give);
    sim.beacon.store[item] = (sim.beacon.store[item] || 0) + give;
    moved += give;
  }
  if (moved) sim.emit({ t: 'deposit', id: p.id, moved });
  return moved;
}
