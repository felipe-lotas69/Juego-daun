/* ============================================================
   movement.js - how anything walks

   Shared deliberately: the host runs this inside the simulation
   and a joining client runs the very same functions to predict its
   own player between snapshots. Two copies of "how fast do I
   accelerate" is how prediction quietly desyncs, so there is one.
   ============================================================ */

import { PLAYER, WORLD_HALF, LEVEL_STEP } from '../core/config.js';
import { clamp, damp } from '../core/util.js';

/* Four probes around the circle: enough at one-metre tiles, and
   cheap enough to call for every enemy every frame. */
export function canStand(world, x, z, radius, level) {
  for (let i = 0; i < 4; i++) {
    const a = i * Math.PI / 2 + Math.PI / 4;
    if (world.blockedAt(x + Math.cos(a) * radius, z + Math.sin(a) * radius, level)) return false;
  }
  return !world.blockedAt(x, z, level);
}

/* Axis-separated so a body slides along a wall instead of sticking
   to it. The level argument makes a two-step cliff a wall. */
export function moveEntity(world, ent, radius, dt) {
  const level = Math.round(ent.y / LEVEL_STEP);
  let nx = ent.x + ent.vx * dt;
  let nz = ent.z + ent.vz * dt;
  if (!canStand(world, nx, ent.z, radius, level)) { nx = ent.x; ent.vx *= 0.2; }
  if (!canStand(world, nx, nz, radius, level)) { nz = ent.z; ent.vz *= 0.2; }
  ent.x = clamp(nx, -WORLD_HALF + 1, WORLD_HALF - 1);
  ent.z = clamp(nz, -WORLD_HALF + 1, WORLD_HALF - 1);
}

/* Turns a movement intent into velocity, and starts a dash when one
   is asked for and available. Returns true if a dash began, so the
   caller can emit the event (or, on a client, just play the sound).
   `p` needs vx, vz, facing, dashTimer, dashCharges, dashCd. */
export function applyLocomotion(p, input, speed, dt) {
  if (p.dashTimer > 0) {
    p.dashTimer -= dt;
    p.vx = p.dashDirX * PLAYER.dashSpeed;
    p.vz = p.dashDirZ * PLAYER.dashSpeed;
    return false;
  }
  const mx = input.mx || 0, mz = input.mz || 0;
  const mag = Math.hypot(mx, mz);
  if (mag > 0.02) {
    const scale = Math.min(1, mag) * speed;
    p.vx = damp(p.vx, (mx / mag) * scale, PLAYER.accel / Math.max(1, speed), dt);
    p.vz = damp(p.vz, (mz / mag) * scale, PLAYER.accel / Math.max(1, speed), dt);
  } else {
    p.vx = damp(p.vx, 0, PLAYER.friction, dt);
    p.vz = damp(p.vz, 0, PLAYER.friction, dt);
  }

  if (input.dash && p.dashCharges > 0 && (Math.hypot(p.vx, p.vz) > 0.4 || mag > 0.02)) {
    p.dashDirX = mag > 0.02 ? mx / mag : Math.cos(p.facing);
    p.dashDirZ = mag > 0.02 ? mz / mag : Math.sin(p.facing);
    p.dashTimer = PLAYER.dashTime;
    p.dashCharges--;
    if (p.dashCd === 0) p.dashCd = PLAYER.dashCooldown;
    return true;
  }
  return false;
}
