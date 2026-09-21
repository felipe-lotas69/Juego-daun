/* ============================================================
   enemyai.js - how the night behaves

   Every archetype shares one spine: pick a target, steer at it,
   attack when close enough. The differences are in what "close
   enough" means and what happens when it is.

   Targets are the nearest living player, or the beacon when no
   player is worth chasing - so ignoring a wave to go mining has a
   cost, which is the whole point of having a base.
   ============================================================ */

import { damagePlayer, explode } from './combat.js';
import { BEACON, COMBAT, LEVEL_STEP, PLAYER } from '../core/config.js';
import { damp, dist, dist2, TAU } from '../core/util.js';

const AGGRO_RANGE = 22;
/* How far something will cross a map for a person it cannot hear. */
const SEEK_RANGE = 46;

export function pickEnemyTarget(sim, e) {
  const p = sim.nearestPlayer(e.x, e.z, AGGRO_RANGE);
  if (p) return { kind: 'player', ref: p, x: p.x, z: p.z, y: p.y };
  /* An unlit beacon is a ruin, not a target. Before it is repaired
     the night comes for whoever made the noise, wherever they are. */
  if (sim.beacon.lit) {
    const b = sim.beacon;
    return { kind: 'beacon', ref: b, x: b.x, z: b.z, y: b.y };
  }
  /* Noise before people. A whole map's worth of enemies converging
     on you from any distance is not tension, it is a treadmill;
     they walk toward the last loud thing and find you there. */
  const hot = sim.resonance.hotspot();
  if (hot) return { kind: 'noise', ref: hot, x: hot.x, z: hot.z, y: 0 };
  const far = sim.nearestPlayer(e.x, e.z, SEEK_RANGE);
  if (far) return { kind: 'player', ref: far, x: far.x, z: far.z, y: far.y };
  if (e.wanderX === undefined || Math.hypot(e.wanderX - e.x, e.wanderZ - e.z) < 2) {
    const a = sim.rng() * Math.PI * 2;
    e.wanderX = e.x + Math.cos(a) * 14;
    e.wanderZ = e.z + Math.sin(a) * 14;
  }
  return { kind: 'noise', ref: e, x: e.wanderX, z: e.wanderZ, y: e.y };
}

export function stepEnemy(sim, e, dt) {
  /* Knockback decays on its own and overrides steering while big. */
  const knock = Math.hypot(e.knockX, e.knockZ);
  if (knock > 0.05) {
    const decay = Math.exp(-COMBAT.knockbackDecay * dt);
    e.knockX *= decay; e.knockZ *= decay;
  } else { e.knockX = 0; e.knockZ = 0; }

  e.stagger = Math.max(0, e.stagger - dt);
  e.attackCd -= dt;
  e.anim.hurt = Math.max(0, e.anim.hurt - dt * 3);
  e.anim.attack = Math.max(0, e.anim.attack - dt * 3.5);
  e.auraArmor = 0;

  const target = pickEnemyTarget(sim, e);
  e.target = target.kind === 'player' ? target.ref.id : null;
  const d = dist(e.x, e.z, target.x, target.z);

  const slow = statusFactor(e, 'slow') * statusFactor(e, 'shock');
  const speed = e.speed * slow * (e.stagger > 0 ? 0.35 : 1);

  switch (e.def.ai) {
    case 'melee':       meleeAi(sim, e, target, d, speed, dt); break;
    case 'ranged':      rangedAi(sim, e, target, d, speed, dt); break;
    case 'bomber':      bomberAi(sim, e, target, d, speed, dt); break;
    case 'dasher':      dasherAi(sim, e, target, d, speed, dt); break;
    case 'boss_slam':   bossSlamAi(sim, e, target, d, speed, dt); break;
    case 'boss_caster': bossCasterAi(sim, e, target, d, speed, dt); break;
    default:            meleeAi(sim, e, target, d, speed, dt); break;
  }

  /* Wardens harden everything standing near them. */
  if (e.def.auraRadius) {
    for (const other of sim.enemies) {
      if (other === e || other.spawnFade > 0) continue;
      if (dist2(other.x, other.z, e.x, e.z) < e.def.auraRadius * e.def.auraRadius) {
        other.auraArmor = Math.max(other.auraArmor || 0, e.def.auraArmor);
      }
    }
  }

  /* Floodlights push the night back: lit ground is uncomfortable. */
  const lampRange = BEACON.lightRadius + sim.beacon.upgrades.lamps * 5;
  if (sim.beacon.upgrades.lamps > 0 && target.kind !== 'beacon') {
    const db = dist(e.x, e.z, sim.beacon.x, sim.beacon.z);
    if (db < lampRange) {
      const push = (1 - db / lampRange) * 1.8;
      const nx = (e.x - sim.beacon.x) / (db || 1), nz = (e.z - sim.beacon.z) / (db || 1);
      e.vx += nx * push; e.vz += nz * push;
    }
  }

  e.vx += e.knockX; e.vz += e.knockZ;
  sim._moveEntity(e, e.radius, dt);
  e.knockX *= 0.0; e.knockZ *= 0.0;
  e.y = sim.world.groundAt(e.x, e.z);
  e.anim.move = Math.min(1, Math.hypot(e.vx, e.vz) / Math.max(1, e.speed));
}

function statusFactor(e, kind) {
  let f = 1;
  for (const s of e.statuses) if (s.kind === kind) f = Math.min(f, s.factor);
  return f;
}

/* Steering with a sidestep: when the straight line is blocked, try
   a tangent. It is not pathfinding, but with one-step ledges and
   sparse obstacles it gets enemies around trees reliably. */
function steer(sim, e, tx, tz, speed, dt, stopAt = 0) {
  const dx = tx - e.x, dz = tz - e.z;
  const d = Math.hypot(dx, dz) || 1;
  if (d <= stopAt) {
    e.vx = damp(e.vx, 0, 10, dt);
    e.vz = damp(e.vz, 0, 10, dt);
    return;
  }
  let nx = dx / d, nz = dz / d;

  const probe = e.radius + 0.55;
  const level = Math.round(e.y / LEVEL_STEP);
  if (sim.world.blockedAt(e.x + nx * probe, e.z + nz * probe, level)) {
    /* Pick whichever tangent is clear; keep a consistent handedness
       per enemy so they do not jitter left and right forever. */
    if (e.dodge === undefined) e.dodge = sim.rng() < 0.5 ? 1 : -1;
    for (const sign of [e.dodge, -e.dodge]) {
      const ax = -nz * sign, az = nx * sign;
      if (!sim.world.blockedAt(e.x + ax * probe, e.z + az * probe, level)) {
        nx = ax * 0.85 + nx * 0.15;
        nz = az * 0.85 + nz * 0.15;
        e.dodge = sign;
        break;
      }
    }
  }
  e.vx = damp(e.vx, nx * speed, 9, dt);
  e.vz = damp(e.vz, nz * speed, 9, dt);
  e.facing = Math.atan2(e.vz, e.vx);
}

function tryAttack(sim, e, target, d) {
  const reach = e.def.range + e.radius + (target.kind === 'player' ? PLAYER.radius : BEACON.radius);
  if (d > reach || e.attackCd > 0) return false;
  e.attackCd = e.def.attackCd;
  e.anim.attack = 1;
  e.facing = Math.atan2(target.z - e.z, target.x - e.x);
  if (target.kind === 'player') {
    damagePlayer(sim, target.ref, e.damage, e, { melee: true });
  } else if (target.kind === 'beacon') {
    sim.damageBeacon(e.damage * BEACON.structureResist);
  } else return false;
  sim.emit({ t: 'swipe', id: e.id, x: e.x, y: e.y + e.def.height * 0.6, z: e.z, facing: e.facing });
  return true;
}

function meleeAi(sim, e, target, d, speed, dt) {
  const reach = e.def.range + e.radius;
  steer(sim, e, target.x, target.z, speed, dt, reach * 0.85);
  tryAttack(sim, e, target, d);
}

function rangedAi(sim, e, target, d, speed, dt) {
  const keep = e.def.keepAway;
  if (d < keep * 0.8) {
    /* Back off, still facing you. */
    steer(sim, e, e.x * 2 - target.x, e.z * 2 - target.z, speed, dt);
    e.facing = Math.atan2(target.z - e.z, target.x - e.x);
  } else if (d > e.def.range * 0.85) {
    steer(sim, e, target.x, target.z, speed, dt);
  } else {
    /* Strafe, which makes them awkward to hit with slow projectiles. */
    if (e.strafe === undefined) e.strafe = sim.rng() < 0.5 ? 1 : -1;
    const ang = Math.atan2(target.z - e.z, target.x - e.x) + Math.PI / 2 * e.strafe;
    steer(sim, e, e.x + Math.cos(ang) * 3, e.z + Math.sin(ang) * 3, speed * 0.7, dt);
    e.facing = Math.atan2(target.z - e.z, target.x - e.x);
  }
  if (d <= e.def.range && e.attackCd <= 0) {
    e.attackCd = e.def.attackCd;
    e.anim.attack = 1;
    fireAtTarget(sim, e, target, e.def.projectileSpeed, e.damage);
  }
}

function bomberAi(sim, e, target, d, speed, dt) {
  if (e.fuse > 0) {
    e.fuse -= dt;
    e.vx = damp(e.vx, 0, 14, dt);
    e.vz = damp(e.vz, 0, 14, dt);
    if (e.fuse <= 0) {
      explode(sim, e.x, e.y + 0.5, e.z, e.def.blastRadius, e.damage, null,
        { hostile: true, color: 0xffb03a, shake: 0.6 });
      e.hp = 0;
      e.lastHitBy = null;
      e.suicide = true;
    }
    return;
  }
  steer(sim, e, target.x, target.z, speed, dt);
  if (d < e.def.range + e.radius) {
    e.fuse = e.def.fuse;
    sim.emit({ t: 'fuse', id: e.id, x: e.x, y: e.y, z: e.z, time: e.def.fuse });
  }
}

function dasherAi(sim, e, target, d, speed, dt) {
  if (e.dashTime > 0) {
    e.dashTime -= dt;
    e.vx = e.dashVX; e.vz = e.dashVZ;
    if (d < e.def.range + e.radius + 0.4) tryAttack(sim, e, target, d);
    return;
  }
  e.dashCd -= dt;
  if (e.dashCd <= 0 && d > 3 && d < 12) {
    const ang = Math.atan2(target.z - e.z, target.x - e.x);
    e.dashVX = Math.cos(ang) * e.def.dashSpeed;
    e.dashVZ = Math.sin(ang) * e.def.dashSpeed;
    e.dashTime = e.def.dashTime;
    e.dashCd = e.def.dashCd;
    e.facing = ang;
    sim.emit({ t: 'lunge', id: e.id, x: e.x, y: e.y, z: e.z, facing: ang });
    return;
  }
  meleeAi(sim, e, target, d, speed, dt);
}

function bossSlamAi(sim, e, target, d, speed, dt) {
  e.slamCd -= dt;
  if (e.slamWindup > 0) {
    e.slamWindup -= dt;
    e.vx = damp(e.vx, 0, 12, dt);
    e.vz = damp(e.vz, 0, 12, dt);
    if (e.slamWindup <= 0) {
      explode(sim, e.x, e.y + 0.4, e.z, e.def.slamRadius, e.def.slamDamage, null,
        { hostile: true, color: 0xff4fd8, shake: 1.1 });
      /* And the ground coughs up more of them. */
      for (let i = 0; i < 3; i++) {
        const a = sim.rng() * TAU;
        sim.spawnEnemy(e.def.summon, false,
          { x: e.x + Math.cos(a) * 3, z: e.z + Math.sin(a) * 3, fromRift: true });
      }
    }
    return;
  }
  if (e.slamCd <= 0 && d < e.def.slamRadius * 0.9) {
    e.slamCd = e.def.slamCd;
    e.slamWindup = 0.85;
    sim.emit({ t: 'windup', id: e.id, x: e.x, y: e.y, z: e.z, radius: e.def.slamRadius, time: 0.85 });
    return;
  }
  meleeAi(sim, e, target, d, speed, dt);
}

function bossCasterAi(sim, e, target, d, speed, dt) {
  if (d > e.def.range * 0.8) steer(sim, e, target.x, target.z, speed, dt);
  else {
    if (e.strafe === undefined) e.strafe = sim.rng() < 0.5 ? 1 : -1;
    const ang = Math.atan2(target.z - e.z, target.x - e.x) + Math.PI / 2 * e.strafe;
    steer(sim, e, e.x + Math.cos(ang) * 4, e.z + Math.sin(ang) * 4, speed * 0.8, dt);
    e.facing = Math.atan2(target.z - e.z, target.x - e.x);
  }
  if (e.attackCd <= 0 && d <= e.def.range) {
    e.attackCd = e.def.attackCd;
    e.anim.attack = 1;
    /* A fan of shots, so standing still is never the answer. */
    const base = Math.atan2(target.z - e.z, target.x - e.x);
    const spread = 0.42;
    for (let i = 0; i < e.def.volley; i++) {
      const a = base + (i - (e.def.volley - 1) / 2) * spread;
      sim.spawnProjectile({
        owner: null, hostile: true,
        x: e.x + Math.cos(a) * 0.8, y: e.y + e.def.height * 0.6, z: e.z + Math.sin(a) * 0.8,
        dirX: Math.cos(a), dirZ: Math.sin(a),
        speed: e.def.projectileSpeed, damage: e.damage, life: 2.2, radius: 0.3,
        color: 0xff4fd8, kind: 'hostile',
      });
    }
    if (sim.rng() < 0.35) {
      for (let i = 0; i < 2; i++) {
        const a = sim.rng() * TAU;
        sim.spawnEnemy(e.def.summon, false,
          { x: e.x + Math.cos(a) * 2.5, z: e.z + Math.sin(a) * 2.5, fromRift: true });
      }
    }
  }
}

function fireAtTarget(sim, e, target, speed, damage) {
  /* Lead the shot a little so a moving player still has to dodge. */
  const ref = target.ref;
  const lead = target.kind === 'player' ? dist(e.x, e.z, target.x, target.z) / speed : 0;
  const tx = target.x + (ref.vx || 0) * lead * 0.7;
  const tz = target.z + (ref.vz || 0) * lead * 0.7;
  const a = Math.atan2(tz - e.z, tx - e.x);
  e.facing = a;
  sim.spawnProjectile({
    owner: null, hostile: true,
    x: e.x + Math.cos(a) * 0.6, y: e.y + e.def.height * 0.6, z: e.z + Math.sin(a) * 0.6,
    dirX: Math.cos(a), dirZ: Math.sin(a),
    speed, damage, life: 2.4, radius: 0.28,
    color: e.def.accent, kind: 'hostile',
  });
}
