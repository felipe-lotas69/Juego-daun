/* ============================================================
   protocol.js - what goes over the wire

   The server is a dumb relay; the host runs the simulation and
   publishes snapshots, joiners publish inputs. Snapshots are
   arrays rather than objects because the field names would
   otherwise be most of the bandwidth.

   Inventories are the one exception: they are a short "item:n"
   string, because which items a player has changes rarely and a
   fixed slot array would cost more than it saves.
   ============================================================ */

import { ENEMIES } from '../game/defs.js';
import { EXTRA_ENEMIES, ANIMALS } from '../game/creatures.js';
import { BUILDINGS } from '../game/items.js';
import { q } from '../core/util.js';

export const PROTOCOL_VERSION = 6;

export const ENEMY_TYPES = Object.keys({ ...ENEMIES, ...EXTRA_ENEMIES });
export const ENEMY_INDEX = Object.fromEntries(ENEMY_TYPES.map((k, i) => [k, i]));
export const ANIMAL_TYPES = Object.keys(ANIMALS);
export const ANIMAL_INDEX = Object.fromEntries(ANIMAL_TYPES.map((k, i) => [k, i]));
export const BUILD_KEYS = Object.keys(BUILDINGS);
export const BUILD_INDEX = Object.fromEntries(BUILD_KEYS.map((k, i) => [k, i]));
export const STATES = ['alive', 'downed', 'dead'];
export const UPGRADE_KEYS = ['walls', 'turrets', 'lamps', 'forge', 'clinic', 'relay'];

function packBag(obj) {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) if (v > 0) parts.push(k + ':' + Math.round(v));
  return parts.join(',');
}

export function unpackBag(str) {
  const out = {};
  if (!str) return out;
  for (const part of str.split(',')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = Number(part.slice(i + 1));
  }
  return out;
}

function packCooldowns(cd) {
  const parts = [];
  for (const [k, v] of Object.entries(cd)) if (v > 0.01) parts.push(k + ':' + q(v));
  return parts.join(',');
}

export function unpackCooldowns(str) {
  const out = {};
  if (!str) return out;
  for (const part of str.split(',')) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i)] = Number(part.slice(i + 1));
  }
  return out;
}

export function encodeSnapshot(sim) {
  const P = [];
  for (const p of sim.players.values()) {
    P.push([
      p.id, q(p.x), q(p.z), q(p.y), q(p.facing),
      q(p.hp), p.maxHp, q(p.shield), p.shieldMax,
      q(p.energy), p.maxEnergy,
      q(p.stamina), p.maxStamina, q(p.hunger), p.maxHunger, q(p.warmth),
      p.level, Math.round(p.xp), p.xpNext, p.skillPoints,
      STATES.indexOf(p.state), q(p.downTimer), q(p.reviveProgress), q(p.respawnTimer),
      q(p.anim.move), q(p.anim.attack), q(p.anim.hurt),
      p.kills, p.deaths,
      p.abilities.map(a => a || '').join(','),
      packCooldowns(p.cooldowns),
      p.interactTarget ? p.interactTarget.kind : '',
      q(p.interactProgress),
      p.dashCharges, p.dashMax, q(p.dashCd),
      packBag(p.inv),
      p.hotbar.map(h => h || '').join(','),
      p.hotbarIndex,
      p.buildKey || '',
      p.craft ? q(1 - p.craft.time / p.craft.total) : -1,
      Object.keys(p.skills).join(','),
      q(p.vx), q(p.vz),
      p.name,
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

  const A = [];
  for (const a of sim.animals) {
    A.push([
      a.id, ANIMAL_INDEX[a.type], q(a.x), q(a.z), q(a.y), q(a.facing),
      q(a.hp), Math.round(a.maxHp),
      q(a.anim.move), q(a.anim.attack), q(a.anim.hurt),
    ]);
  }

  const B = [];
  for (const b of sim.buildings) {
    B.push([b.id, BUILD_INDEX[b.key], b.tx, b.ty, q(b.y), q(b.hp), b.maxHp,
      b.open ? 1 : 0, q(b.angle || 0), b.seed || '', q(b.grow || 0)]);
  }

  const R = [];
  for (const pr of sim.projectiles) {
    R.push([pr.id, q(pr.x), q(pr.y), q(pr.z), q(pr.vx), q(pr.vz), pr.color, q(pr.radius), pr.hostile ? 1 : 0]);
  }

  const K = [];
  for (const pk of sim.pickups) K.push([pk.id, pk.item, q(pk.x), q(pk.y), q(pk.z)]);

  const C = [];
  for (const c of sim.constructs) C.push([c.id, q(c.x), q(c.y), q(c.z), q(c.angle), c.color, 0]);
  for (const t of sim.beacon.turrets) C.push([t.id, q(t.x), q(t.y), q(t.z), q(t.angle), 0x3fe0ff, 1]);

  const T = [];
  for (const tr of sim.traps) T.push([q(tr.x), q(tr.y), q(tr.z), q(tr.radius), tr.color]);

  const G = sim.gates.map(g => [g.sealed ? 1 : 0, g.active ? 1 : 0, q(g.progress)]);
  const CT = sim.contracts.map(c => [c.id, c.progress, c.done ? 1 : 0]);

  return {
    k: 'S', v: PROTOCOL_VERSION,
    t: q(sim.time), d: q(sim.dayTime), n: sim.night, ph: sim.phase, ar: sim.arc,
    nt: sim.nightType.id, we: sim.weather.id,
    P, E, A, B, R, K, C, T, G, CT,
    BC: [sim.beacon.lit ? 1 : 0, q(sim.beacon.hp), sim.beacon.maxHp,
      ...UPGRADE_KEYS.map(k => sim.beacon.upgrades[k]), packBag(sim.beacon.store)],
    W: [sim.enemies.length, sim.wave.budget, sim.wave.active ? 1 : 0],
    sh: sim.shrines.map(s => (s.cooldown > 0 ? 0 : 1)),
    ca: sim.caches.map(c => (c.opened ? 1 : 0)),
    rs: q(sim.resonance ? sim.resonance.peak : 0),
    gs: sim.stats.gatesSealed,
  };
}

/* Inputs are tiny and go out thirty times a second, so they are
   packed by hand rather than sent as an object. */
export function encodeInput(input) {
  return [
    input.seq, q(input.mx), q(input.mz), q(input.ax), q(input.az),
    (input.fire ? 1 : 0) | (input.dash ? 2 : 0) | (input.interact ? 4 : 0) | (input.sprint ? 8 : 0),
    input.abil,
  ];
}

export function decodeInput(a) {
  return {
    seq: a[0], mx: a[1], mz: a[2], ax: a[3], az: a[4],
    fire: !!(a[5] & 1), dash: !!(a[5] & 2), interact: !!(a[5] & 4), sprint: !!(a[5] & 8),
    abil: a[6] | 0,
  };
}

const RELAY_EVENTS = new Set([
  'impact', 'boom', 'beam', 'chain', 'siphon', 'cast', 'dash', 'blink', 'dmg',
  'kill', 'spawn', 'levelup', 'pickup', 'prop_break', 'prop_hit', 'trap',
  'windup', 'boon', 'revive', 'down', 'die', 'hurt', 'nightfall', 'dawn',
  'construct_fire', 'fuse', 'beacon_hit', 'beacon_down', 'beacon_lit', 'upgrade',
  'skill', 'respawn', 'join', 'leave', 'cache', 'lunge', 'swipe', 'swing',
  'built', 'build_hit', 'build_gone', 'crafted', 'craftstart', 'deposit', 'eat',
  'weather', 'seal_start', 'seal_done', 'heart_wakes', 'contract', 'animal_die',
  'toolneeded', 'buildfail', 'craftfail', 'door', 'home', 'won', 'sick', 'tired',
]);

export function filterEvents(events) {
  return events.filter(e => RELAY_EVENTS.has(e.t));
}
