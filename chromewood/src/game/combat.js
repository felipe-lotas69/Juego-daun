/* ============================================================
   combat.js - casting, projectiles and damage

   Every ability funnels through castAbility, which spends the
   energy and starts the cooldown, then hands off to a small
   handler per `kind`. Damage always goes through damageEnemy or
   damagePlayer so that crits, armour, leech, thorns and the event
   stream are handled in exactly one place.
   ============================================================ */

import { ABILITIES } from './defs.js';
import { COMBAT, PLAYER, LEVEL_STEP } from '../core/config.js';
import { clamp01, dist2, dist } from '../core/util.js';

/* -------------------------------------------------------- casting */
export function castAbility(sim, p, id, dt, isChannelTick) {
  const def = ABILITIES[id];
  if (!def) return false;

  if (!isChannelTick) {
    if ((p.cooldowns[id] || 0) > 0) return false;
    const cost = def.cost;
    if (cost > 0 && p.energy < cost) {
      sim.emit({ t: 'nocharge', id: p.id });
      return false;
    }
    if (def.kind === 'channel') {
      p.channel = { id, time: def.duration, tick: 0 };
      p.energy -= cost;
      p.cooldowns[id] = def.cd * (1 - p.stats.cdr);
      sim.emit({ t: 'cast', id: p.id, ability: id, x: p.x, y: p.y, z: p.z, facing: p.facing });
      return true;
    }
    p.energy -= cost;
    p.cooldowns[id] = def.cd * (1 - p.stats.cdr);
    p.anim.attack = 1;
    sim.emit({ t: 'cast', id: p.id, ability: id, x: p.x, y: p.y, z: p.z, facing: p.facing, color: def.color });
  }

  const power = p.stats.power;
  switch (def.kind) {
    case 'projectile': return castProjectile(sim, p, def, power);
    case 'nova':       return castNova(sim, p, def, power);
    case 'chain':      return castChain(sim, p, def, power);
    case 'beam':       return castBeam(sim, p, def, power);
    case 'blink':      return castBlink(sim, p, def, power);
    case 'buff':       return castBuff(sim, p, def);
    case 'summon':     return castSummon(sim, p, def);
    case 'trap':       return castTrap(sim, p, def, power);
    case 'channel':    return tickChannel(sim, p, def, power, dt);
    default: return false;
  }
}

function aimDir(p) {
  const dx = p.aimX - p.x, dz = p.aimZ - p.z;
  const m = Math.hypot(dx, dz);
  if (m < 0.001) return { x: Math.cos(p.facing), z: Math.sin(p.facing) };
  return { x: dx / m, z: dz / m };
}

function castProjectile(sim, p, def, power) {
  const d = aimDir(p);
  sim.spawnProjectile({
    owner: p.id, x: p.x + d.x * 0.5, y: p.y + 0.85, z: p.z + d.z * 0.5,
    dirX: d.x, dirZ: d.z, speed: def.speed,
    damage: def.damage * power, life: def.life, radius: def.radius,
    color: def.color, kind: 'bolt',
  });
  return true;
}

function castNova(sim, p, def, power) {
  explode(sim, p.x, p.y + 0.6, p.z, def.radius, def.damage * power, p.id,
    { color: def.color, knock: def.knock, shake: 0.5 });
  return true;
}

function castChain(sim, p, def, power) {
  let from = { x: p.x, y: p.y + 0.9, z: p.z };
  const hit = new Set();
  let damage = def.damage * power;
  const links = [];
  for (let i = 0; i < def.jumps; i++) {
    const target = sim._nearestEnemy(from.x, from.z, def.range, hit);
    if (!target) break;
    hit.add(target.id);
    links.push({ x1: from.x, y1: from.y, z1: from.z, x2: target.x, y2: target.y + 0.6, z2: target.z });
    damageEnemy(sim, target, damage, p, { color: def.color });
    sim.addStatus(target, 'shock', { duration: 0.8 });
    from = { x: target.x, y: target.y + 0.6, z: target.z };
    damage *= def.falloff;
  }
  if (links.length) sim.emit({ t: 'chain', id: p.id, links, color: def.color });
  return links.length > 0;
}

function castBeam(sim, p, def, power) {
  const d = aimDir(p);
  const x0 = p.x, z0 = p.z;
  let hits = 0;
  for (const e of sim.enemies) {
    if (e.spawnFade > 0) continue;
    /* Distance from the enemy to the ray, clamped to the segment. */
    const ex = e.x - x0, ez = e.z - z0;
    const along = ex * d.x + ez * d.z;
    if (along < 0 || along > def.range) continue;
    const perp = Math.abs(ex * d.z - ez * d.x);
    if (perp > def.width + e.radius) continue;
    damageEnemy(sim, e, def.damage * power, p, { color: def.color });
    hits++;
  }
  sim.emit({
    t: 'beam', id: p.id, color: def.color,
    x1: x0, y1: p.y + 0.9, z1: z0,
    x2: x0 + d.x * def.range, y2: p.y + 0.9, z2: z0 + d.z * def.range,
    width: def.width,
  });
  sim.hitStop = Math.max(sim.hitStop, COMBAT.hitStop);
  return true;
}

function castBlink(sim, p, def, power) {
  const d = aimDir(p);
  const startX = p.x, startZ = p.z, startY = p.y;
  /* Walk the blink out in steps and stop at the last legal spot, so
     you can never end up inside a cliff. */
  let bx = p.x, bz = p.z;
  const steps = 14;
  for (let i = 1; i <= steps; i++) {
    const t = (i / steps) * def.distance;
    const nx = p.x + d.x * t, nz = p.z + d.z * t;
    const level = Math.round(sim.world.groundAt(nx, nz) / LEVEL_STEP);
    if (!sim._canStand(nx, nz, PLAYER.radius, level)) break;
    bx = nx; bz = nz;
  }
  p.x = bx; p.z = bz;
  p.y = sim.world.groundAt(bx, bz);
  p.invuln = Math.max(p.invuln, 0.25);
  explode(sim, p.x, p.y + 0.5, p.z, def.radius, def.damage * power, p.id, { color: def.color, knock: 5 });
  sim.emit({ t: 'blink', id: p.id, x1: startX, y1: startY, z1: startZ, x2: p.x, y2: p.y, z2: p.z, color: def.color });
  return true;
}

function castBuff(sim, p, def) {
  const mods = {};
  if (def.haste) mods.speed = def.haste;
  if (def.power) mods.power = def.power;
  p.buffs.push({ id: def.id, name: def.name, time: def.duration, mods, color: def.color });
  sim.recalcStats(p);
  if (def.shield) p.shield = Math.min(p.shieldMax + def.shield, p.shield + def.shield);
  if (def.slowRadius) {
    for (const e of sim.enemies) {
      if (dist2(e.x, e.z, p.x, p.z) < def.slowRadius * def.slowRadius) {
        sim.addStatus(e, 'slow', { duration: def.duration, factor: def.slow });
      }
    }
  }
  sim.emit({ t: 'buff', id: p.id, ability: def.id, color: def.color, duration: def.duration });
  return true;
}

function castSummon(sim, p, def) {
  const d = aimDir(p);
  const x = def.orbit ? p.x : p.x + d.x * 1.6;
  const z = def.orbit ? p.z : p.z + d.z * 1.6;
  /* One construct of each kind per player; recasting replaces it. */
  for (let i = sim.constructs.length - 1; i >= 0; i--) {
    const c = sim.constructs[i];
    if (c.owner === p.id && c.ability === def.id) sim.constructs.splice(i, 1);
  }
  const c = {
    id: Math.floor(sim.rng() * 1e9), owner: p.id, ability: def.id,
    x, z, y: sim.world.groundAt(x, z) + (def.orbit ? 1.35 : 0),
    hp: def.hp, maxHp: def.hp, life: def.duration, cd: 0.3,
    damage: def.damage, fireRate: def.fireRate, range: def.range,
    color: def.color, orbit: !!def.orbit, orbitAngle: 0, angle: p.facing,
  };
  sim.constructs.push(c);
  sim.emit({ t: 'construct', id: c.id, ability: def.id, owner: p.id, x: c.x, y: c.y, z: c.z, color: def.color });
  return true;
}

function castTrap(sim, p, def, power) {
  const d = aimDir(p);
  const range = Math.min(6.5, dist(p.x, p.z, p.aimX, p.aimZ));
  const x = p.x + d.x * range, z = p.z + d.z * range;
  sim.traps.push({
    id: Math.floor(sim.rng() * 1e9), owner: p.id,
    x, z, y: sim.world.groundAt(x, z),
    radius: def.radius, damage: def.damage * power, arm: def.arm, life: def.life,
    color: def.color, burn: def.burn,
  });
  sim.emit({ t: 'trap', x, y: sim.world.groundAt(x, z), z, radius: def.radius, color: def.color });
  return true;
}

function tickChannel(sim, p, def, power, dt) {
  const target = sim._nearestEnemy(p.x, p.z, def.range);
  if (!target) return false;
  const amount = def.dps * power * dt;
  damageEnemy(sim, target, amount, p, { silent: true, color: def.color });
  const healed = amount * def.leech;
  p.hp = Math.min(p.maxHp, p.hp + healed);
  p.channel.tick = (p.channel.tick || 0) + dt;
  if (p.channel.tick > 0.1) {
    p.channel.tick = 0;
    sim.emit({
      t: 'siphon', id: p.id, color: def.color,
      x1: p.x, y1: p.y + 0.9, z1: p.z,
      x2: target.x, y2: target.y + 0.6, z2: target.z,
    });
  }
  return true;
}

/* ----------------------------------------------------- projectiles */
export function stepProjectiles(sim, dt) {
  const arr = sim.projectiles;
  for (let i = arr.length - 1; i >= 0; i--) {
    const pr = arr[i];
    pr.life -= dt;
    if (pr.life <= 0) { sim.emit({ t: 'expire', id: pr.id, x: pr.x, y: pr.y, z: pr.z, color: pr.color }); arr.splice(i, 1); continue; }

    if (pr.homing) {
      const target = pr.hostile ? sim.nearestPlayer(pr.x, pr.z, 14) : sim._nearestEnemy(pr.x, pr.z, 14, pr.hits);
      if (target) {
        const dx = target.x - pr.x, dz = target.z - pr.z;
        const m = Math.hypot(dx, dz) || 1;
        const speed = Math.hypot(pr.vx, pr.vz);
        pr.vx += ((dx / m) * speed - pr.vx) * pr.homing * dt;
        pr.vz += ((dz / m) * speed - pr.vz) * pr.homing * dt;
      }
    }

    pr.x += pr.vx * dt;
    pr.z += pr.vz * dt;
    if (pr.vy) { pr.vy -= 9 * dt; pr.y += pr.vy * dt; }

    /* Terrain: a shot into a cliff face or a tree stops there. */
    const ground = sim.world.groundAt(pr.x, pr.z);
    if (sim.world.blockedAt(pr.x, pr.z) || pr.y < ground - 0.05) {
      if (!pr.hostile) sim.damageProp(pr.x, pr.z, pr.damage, pr.owner);
      if (pr.splash) explode(sim, pr.x, pr.y, pr.z, pr.splash, pr.damage, pr.owner, { color: pr.color, hostile: pr.hostile });
      sim.emit({ t: 'impact', x: pr.x, y: Math.max(pr.y, ground + 0.1), z: pr.z, color: pr.color, kind: 'wall' });
      arr.splice(i, 1);
      continue;
    }

    let consumed = false;
    if (pr.hostile) {
      for (const p of sim.players.values()) {
        if (p.state !== 'alive' || pr.hits.has(p.id)) continue;
        const rr = pr.radius + PLAYER.radius;
        if (dist2(p.x, p.z, pr.x, pr.z) > rr * rr) continue;
        pr.hits.add(p.id);
        damagePlayer(sim, p, pr.damage, null);
        sim.emit({ t: 'impact', x: pr.x, y: pr.y, z: pr.z, color: pr.color, kind: 'player' });
        if (pr.splash) explode(sim, pr.x, pr.y, pr.z, pr.splash, pr.damage * 0.7, null, { color: pr.color, hostile: true });
        consumed = pr.pierce-- <= 0;
        break;
      }
    } else {
      const owner = sim.players.get(pr.owner);
      for (const e of sim.enemies) {
        if (e.spawnFade > 0 || pr.hits.has(e.id)) continue;
        const rr = pr.radius + e.radius;
        if (dist2(e.x, e.z, pr.x, pr.z) > rr * rr) continue;
        pr.hits.add(e.id);
        damageEnemy(sim, e, pr.damage, owner, { color: pr.color });
        if (pr.status) sim.addStatus(e, pr.status, { source: pr.owner });
        sim.emit({ t: 'impact', x: pr.x, y: pr.y, z: pr.z, color: pr.color, kind: 'enemy' });
        if (pr.splash) explode(sim, pr.x, pr.y, pr.z, pr.splash, pr.damage * 0.7, pr.owner, { color: pr.color });
        consumed = pr.pierce-- <= 0;
        break;
      }
    }
    if (consumed) arr.splice(i, 1);
  }
}

/* ---------------------------------------------------------- damage */
export function damageEnemy(sim, e, amount, byPlayer, opts = {}) {
  if (e.hp <= 0) return 0;
  let dmg = amount;
  let crit = false;
  if (byPlayer && !opts.dot) {
    if (sim.rng() < byPlayer.stats.crit) {
      crit = true;
      dmg *= byPlayer.stats.critMult;
    }
  }
  /* Armour, and the warden aura that lends armour to its friends. */
  const armor = clamp01((e.armor || 0) + (e.auraArmor || 0));
  dmg *= (1 - armor);
  e.hp -= dmg;
  e.anim.hurt = 1;
  e.stagger = Math.max(e.stagger, opts.stagger || 0.08);
  if (byPlayer) {
    e.lastHitBy = byPlayer.id;
    byPlayer.damageDealt += dmg;
    if (byPlayer.stats.leech) {
      byPlayer.hp = Math.min(byPlayer.maxHp, byPlayer.hp + dmg * byPlayer.stats.leech);
    }
  }
  if (!opts.silent) {
    sim.emit({ t: 'dmg', x: e.x, y: e.y + e.def.height * 0.9, z: e.z,
      amount: Math.round(dmg), crit, target: 'enemy', color: opts.color });
    if (crit) sim.hitStop = Math.max(sim.hitStop, COMBAT.hitStop);
  }
  if (opts.knock) {
    const dx = e.x - (opts.fromX !== undefined ? opts.fromX : e.x);
    const dz = e.z - (opts.fromZ !== undefined ? opts.fromZ : e.z);
    const m = Math.hypot(dx, dz) || 1;
    const k = opts.knock / Math.max(0.4, e.def.mass || 1);
    e.knockX += (dx / m) * k;
    e.knockZ += (dz / m) * k;
  }
  return dmg;
}

export function damagePlayer(sim, p, amount, source, opts = {}) {
  if (p.state !== 'alive') return 0;
  if (p.invuln > 0 && !opts.trueDamage) return 0;
  let dmg = amount;
  if (!opts.trueDamage) dmg *= (1 - p.stats.armor);

  /* Shield eats damage first and stops recharging for a while. */
  if (p.shield > 0 && !opts.trueDamage) {
    const absorbed = Math.min(p.shield, dmg);
    p.shield -= absorbed;
    dmg -= absorbed;
  }
  p.shieldTimer = PLAYER.shieldDelay;
  p.hp -= dmg;
  p.anim.hurt = 1;
  if (!opts.silent) p.tookDamageTonight = true;

  if (source && p.stats.thorns && opts.melee) {
    damageEnemy(sim, source, p.stats.thorns, null, { silent: false, color: 0xc8d4e2 });
  }
  if (!opts.silent) {
    sim.emit({ t: 'dmg', x: p.x, y: p.y + 1.5, z: p.z, amount: Math.round(amount), target: 'player', id: p.id });
    sim.emit({ t: 'hurt', id: p.id, amount });
  }
  if (p.hp <= 0) sim.downPlayer(p);
  return dmg;
}

export function explode(sim, x, y, z, radius, damage, ownerId, opts = {}) {
  const owner = ownerId != null ? sim.players.get(ownerId) : null;
  if (opts.hostile) {
    for (const p of sim.players.values()) {
      if (p.state !== 'alive') continue;
      const d = dist(p.x, p.z, x, z);
      if (d > radius) continue;
      /* Falloff so the edge of a blast is survivable. */
      damagePlayer(sim, p, damage * (1 - 0.55 * (d / radius)), null);
    }
  } else {
    for (const e of sim.enemies) {
      if (e.spawnFade > 0) continue;
      const d = dist(e.x, e.z, x, z);
      if (d > radius + e.radius) continue;
      damageEnemy(sim, e, damage * (1 - 0.5 * clamp01(d / radius)), owner, {
        color: opts.color, knock: opts.knock || 0, fromX: x, fromZ: z, stagger: 0.25,
      });
      if (opts.burn) sim.addStatus(e, 'burn', { duration: opts.burn, source: ownerId });
    }
    sim.damageProp(x, z, damage * 0.6, ownerId);
  }
  sim.emit({ t: 'boom', x, y, z, radius, color: opts.color || 0xffb03a, shake: opts.shake || 0.35 });
  sim.hitStop = Math.max(sim.hitStop, COMBAT.hitStop);
}
