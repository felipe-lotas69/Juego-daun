/* ============================================================
   protocol.js - what goes over the wire

   The server is a dumb relay; the host runs the simulation and
   publishes snapshots, joiners publish inputs. Snapshots are
   arrays rather than objects because the field names would
   otherwise be most of the bandwidth - fifty enemies of
   {"id":…,"x":…} is several times the size of fifty short arrays.
   ============================================================ */

import { ENEMIES } from '../game/defs.js';
import { q } from '../core/util.js';

export const PROTOCOL_VERSION = 3;

/* Stable index tables, so a type is one number on the wire. Order
   matters: both ends must agree, so it is derived from the defs
   object rather than written out twice. */
export const ENEMY_TYPES = Object.keys(ENEMIES);
export const ENEMY_INDEX = Object.fromEntries(ENEMY_TYPES.map((k, i) => [k, i]));
export const PICKUP_KINDS = ['scrap', 'essence', 'cores', 'health', 'charge'];
export const PICKUP_INDEX = Object.fromEntries(PICKUP_KINDS.map((k, i) => [k, i]));
export const STATES = ['alive', 'downed', 'dead'];
export const UPGRADE_KEYS = ['walls', 'turrets', 'lamps', 'forge', 'clinic', 'relay'];

export function encodeSnapshot(sim) {
  const P = [];
  for (const p of sim.players.values()) {
    P.push([
      p.id, q(p.x), q(p.z), q(p.y), q(p.facing),
      q(p.hp), p.maxHp, q(p.shield), p.shieldMax,
      q(p.energy), p.maxEnergy, q(p.charge), p.chargeMax,
      p.level, Math.round(p.xp), p.xpNext, p.skillPoints,
      STATES.indexOf(p.state), q(p.downTimer), q(p.reviveProgress), q(p.respawnTimer),
      q(p.anim.move), q(p.anim.attack), q(p.anim.hurt),
      p.kills, p.deaths,
      p.res.scrap, p.res.essence, p.res.cores,
      p.dashCharges, p.dashMax, q(p.dashCd),
      p.abilities.map(a => a || '').join(','),
      encodeCooldowns(p.cooldowns),
      p.interactTarget ? p.interactTarget.kind : '',
      q(p.interactProgress),
      p.buffs.map(b => b.id).join(','),
      q(p.vx), q(p.vz),
    ]);
  }

  const E = [];
  for (const e of sim.enemies) {
    if (e.spawnFade > 0) continue;
    E.push([
      e.id, ENEMY_INDEX[e.type], q(e.x), q(e.z), q(e.y), q(e.facing),
      q(e.hp), Math.round(e.maxHp),
      (e.elite ? 1 : 0) | (e.boss ? 2 : 0),
      q(e.anim.move), q(e.anim.attack), q(e.anim.hurt), q(e.fuse || 0),
    ]);
  }

  const R = [];
  for (const pr of sim.projectiles) {
    R.push([pr.id, q(pr.x), q(pr.y), q(pr.z), q(pr.vx), q(pr.vz), pr.color, q(pr.radius), pr.hostile ? 1 : 0]);
  }

  const K = [];
  for (const pk of sim.pickups) {
    K.push([pk.id, PICKUP_INDEX[pk.kind] === undefined ? 0 : PICKUP_INDEX[pk.kind],
      q(pk.x), q(pk.y), q(pk.z)]);
  }

  const C = [];
  for (const c of sim.constructs) C.push([c.id, q(c.x), q(c.y), q(c.z), q(c.angle), c.color, 0]);
  for (const t of sim.beacon.turrets) C.push([t.id, q(t.x), q(t.y), q(t.z), q(t.angle), 0x3fe0ff, 1]);

  const T = [];
  for (const tr of sim.traps) T.push([q(tr.x), q(tr.y), q(tr.z), q(tr.radius), tr.color]);

  return {
    k: 'S',
    v: PROTOCOL_VERSION,
    t: q(sim.time), d: q(sim.dayTime), n: sim.night, ph: sim.phase,
    P, E, R, K, C, T,
    B: [q(sim.beacon.hp), sim.beacon.maxHp,
      ...UPGRADE_KEYS.map(k => sim.beacon.upgrades[k]),
      sim.beacon.res.scrap, sim.beacon.res.essence, sim.beacon.res.cores],
    W: [sim.enemies.length, sim.wave.budget, sim.wave.active ? 1 : 0],
    sh: sim.shrines.map(s => (s.cooldown > 0 ? 0 : 1)),
    ca: sim.caches.map(c => (c.opened ? 1 : 0)),
  };
}

function encodeCooldowns(cd) {
  const parts = [];
  for (const [k, v] of Object.entries(cd)) if (v > 0.01) parts.push(k + ':' + q(v));
  return parts.join(',');
}

export function decodeCooldowns(str) {
  const out = {};
  if (!str) return out;
  for (const part of str.split(',')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = Number(part.slice(i + 1));
  }
  return out;
}

/* Inputs are tiny and go out 32 times a second, so they are packed
   by hand rather than sent as an object. */
export function encodeInput(input) {
  return [
    input.seq, q(input.mx), q(input.mz), q(input.ax), q(input.az),
    (input.fire ? 1 : 0) | (input.dash ? 2 : 0) | (input.interact ? 4 : 0),
    input.abil,
  ];
}

export function decodeInput(a) {
  return {
    seq: a[0], mx: a[1], mz: a[2], ax: a[3], az: a[4],
    fire: !!(a[5] & 1), dash: !!(a[5] & 2), interact: !!(a[5] & 4),
    abil: a[6] | 0,
  };
}

/* Events are already small objects; only the ones the view needs
   are worth relaying, and some are per-player noise. */
const RELAY_EVENTS = new Set([
  'impact', 'boom', 'beam', 'chain', 'siphon', 'cast', 'dash', 'blink', 'dmg',
  'kill', 'spawn', 'levelup', 'pickup', 'prop_break', 'prop_hit', 'trap',
  'windup', 'boon', 'revive', 'down', 'die', 'hurt', 'nightfall', 'dawn',
  'construct_fire', 'fuse', 'beacon_hit', 'beacon_down', 'upgrade', 'skill',
  'respawn', 'join', 'leave', 'cache', 'nocharge', 'lunge', 'swipe',
]);

export function filterEvents(events) {
  return events.filter(e => RELAY_EVENTS.has(e.t));
}
