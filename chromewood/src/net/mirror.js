/* ============================================================
   mirror.js - a client's view of the host's world

   Presents the same shape as Sim - players, enemies, animals,
   buildings, beacon, gates - so the renderer and the interface
   cannot tell whether they are drawing a local simulation or a
   remote one.

   Remote entities are interpolated between the last two snapshots,
   played back slightly in the past. The local player is predicted
   forward from its own input and eased back toward the host's
   answer, so your own movement never waits for a round trip.
   ============================================================ */

import { World } from '../world/worldgen.js';
import { ENEMIES } from '../game/defs.js';
import { ANIMALS, EXTRA_ENEMIES } from '../game/creatures.js';
import { BUILDINGS, ITEMS } from '../game/items.js';
import { NIGHTS, WEATHER, CONTRACTS } from '../game/nights.js';
import {
  ENEMY_TYPES, ANIMAL_TYPES, BUILD_KEYS, STATES, UPGRADE_KEYS,
  unpackBag, unpackCooldowns,
} from './protocol.js';
import { NET, DAY, PLAYER, SURVIVAL } from '../core/config.js';
import { lerp, angleLerp, clamp01, damp } from '../core/util.js';
import { applyLocomotion, moveEntity } from '../game/movement.js';

const ALL_ENEMIES = { ...ENEMIES, ...EXTRA_ENEMIES };

export class Mirror {
  constructor(seed, localId) {
    this.world = new World(seed);
    this.localId = localId;
    this.players = new Map();
    this.enemies = [];
    this.animals = [];
    this.buildings = [];
    this.projectiles = [];
    this.pickups = [];
    this.constructs = [];
    this.traps = [];
    this.contracts = [];
    this.stats = { gatesSealed: 0, killed: 0, built: 0 };

    const lm = this.world.landmarks.find(l => l.kind === 'beacon');
    this.beacon = {
      x: lm.x, y: lm.y, z: lm.z, lit: false, hp: 0, maxHp: 1,
      upgrades: Object.fromEntries(UPGRADE_KEYS.map(k => [k, 0])),
      store: {}, turrets: [],
    };
    this.gates = this.world.landmarks.filter(l => l.kind === 'rift').map(l => ({
      id: l.tx * 1000 + l.ty, tx: l.tx, ty: l.ty, x: l.x, y: l.y, z: l.z,
      sealed: false, active: false, progress: 0,
    }));
    this.shrines = this.world.landmarks.filter(l => l.kind === 'shrine').map(l => ({ ...l, cooldown: 0 }));
    this.caches = this.world.landmarks.filter(l => l.kind === 'cache').map(l => ({ ...l, opened: false }));

    this.time = 0;
    this.dayTime = 0;
    this.night = 0;
    this.phase = 'running';
    this.arc = 'survive';
    this.cycleLength = DAY.dayLength + DAY.nightLength;
    this.wave = { alive: 0, budget: 0, active: false };
    this.nightType = NIGHTS.swarm;
    this.weather = WEATHER.clear;
    /* A stand-in so the HUD can read a peak without the field. */
    this.resonance = { peak: 0, at: () => this._resonanceHere, hotspot: () => null };
    this._resonanceHere = 0;

    this._enemyMap = new Map();
    this._animalMap = new Map();
    this._buildMap = new Map();
    this._projMap = new Map();
    this._pickMap = new Map();
    this.snapAge = 0;
  }

  get isNight() { return this.dayTime % this.cycleLength >= DAY.dayLength; }
  get timeToPhaseChange() {
    const t = this.dayTime % this.cycleLength;
    return this.isNight ? (this.cycleLength - t) : (DAY.dayLength - t);
  }
  get nightAmount() {
    const t = this.dayTime % this.cycleLength;
    const d = DAY.dayLength, n = DAY.nightLength, k = DAY.duskLength;
    if (t < d - k) return 0;
    if (t < d) return (t - (d - k)) / k;
    if (t < d + n - k) return 1;
    return 1 - (t - (d + n - k)) / k;
  }

  _nearestEnemy(x, z, range) {
    let best = null, bestD = range * range;
    for (const e of this.enemies) {
      const d = (e.x - x) ** 2 + (e.z - z) ** 2;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  objective() {
    if (!this.beacon.lit) {
      return { id: 'beacon', text: 'REPAIR THE BEACON', sub: 'deliver parts and hold G', progress: 0.01 };
    }
    if (this.arc === 'heart') {
      return { id: 'heart', text: 'THE RIFT HEART IS AWAKE', sub: 'kill it and the run is yours', progress: 1 };
    }
    const sealed = this.stats.gatesSealed, total = this.gates.length;
    const active = this.gates.find(g => g.active);
    if (active) return { id: 'sealing', text: 'HOLD THE GATE', sub: `${Math.round(active.progress * 100)}%`, progress: active.progress };
    return { id: 'gates', text: 'SEAL THE RIFT GATES', sub: `${sealed} of ${total} sealed`,
      progress: total ? sealed / total : 0 };
  }

  applySnapshot(s) {
    this.time = s.t; this.dayTime = s.d; this.night = s.n;
    this.phase = s.ph; this.arc = s.ar;
    this.nightType = NIGHTS[s.nt] || NIGHTS.swarm;
    this.weather = WEATHER[s.we] || WEATHER.clear;
    this.snapAge = 0;
    this.resonance.peak = s.rs || 0;
    this.stats.gatesSealed = s.gs || 0;

    /* ---- players ---- */
    const seen = new Set();
    for (const a of s.P) {
      const id = a[0];
      seen.add(id);
      let p = this.players.get(id);
      let fresh = false;
      if (!p) { p = makeRemotePlayer(id); this.players.set(id, p); fresh = true; }
      const local = id === this.localId;
      p.px = p.x; p.pz = p.z; p.py = p.y; p.pfacing = p.facing;
      if (local) { p.serverX = a[1]; p.serverZ = a[2]; p.serverY = a[3]; p.facing = a[4]; }
      else { p.tx = a[1]; p.tz = a[2]; p.ty = a[3]; p.tfacing = a[4]; }
      if (fresh) {
        p.x = p.px = a[1]; p.z = p.pz = a[2]; p.y = p.py = a[3];
        p.facing = p.pfacing = a[4];
      }
      p.hp = a[5]; p.maxHp = a[6]; p.shield = a[7]; p.shieldMax = a[8];
      p.energy = a[9]; p.maxEnergy = a[10];
      p.stamina = a[11]; p.maxStamina = a[12]; p.hunger = a[13]; p.maxHunger = a[14]; p.warmth = a[15];
      p.level = a[16]; p.xp = a[17]; p.xpNext = a[18]; p.skillPoints = a[19];
      p.state = STATES[a[20]] || 'alive';
      p.downTimer = a[21]; p.reviveProgress = a[22]; p.respawnTimer = a[23];
      p.anim.move = a[24]; p.anim.attack = a[25]; p.anim.hurt = a[26];
      p.kills = a[27]; p.deaths = a[28];
      p.abilities = a[29].split(',').map(x => x || null);
      p.cooldowns = unpackCooldowns(a[30]);
      p.interactTarget = a[31] ? { kind: a[31] } : null;
      p.interactProgress = a[32];
      p.dashCharges = a[33]; p.dashMax = a[34]; p.dashCd = a[35];
      p.inv = unpackBag(a[36]);
      p.hotbar = a[37].split(',').map(x => x || null);
      while (p.hotbar.length < 6) p.hotbar.push(null);
      p.hotbarIndex = a[38];
      p.buildKey = a[39] || null;
      p.craft = a[40] >= 0 ? { time: 1 - a[40], total: 1 } : null;
      p.skills = Object.fromEntries((a[41] ? a[41].split(',') : []).map(k => [k, true]));
      if (!local) { p.vx = a[42]; p.vz = a[43]; }
      else { p.serverVX = a[42]; p.serverVZ = a[43]; }
      p.name = a[44] || p.name;
      const held = p.hotbar[p.hotbarIndex];
      p.lightItem = held && ITEMS[held] && ITEMS[held].light ? ITEMS[held].light : null;
      if (local) this._resonanceHere = 0;
    }
    for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);

    /* ---- enemies ---- */
    this._syncList(s.E, this.enemies, this._enemyMap, (a) => {
      const type = ENEMY_TYPES[a[1]];
      return {
        id: a[0], type, def: ALL_ENEMIES[type], faction: 'rift',
        radius: ALL_ENEMIES[type].radius, spawnFade: 0,
        anim: { move: 0, attack: 0, hurt: 0 }, statuses: [], fuse: 0,
      };
    }, (e, a) => {
      e.hp = a[6]; e.maxHp = a[7];
      e.elite = !!(a[8] & 1); e.boss = !!(a[8] & 2);
      e.radius = e.def.radius * (e.elite ? 1.25 : 1);
      e.anim.move = a[9]; e.anim.attack = a[10]; e.anim.hurt = a[11];
      e.fuse = a[12];
    });

    /* ---- animals ---- */
    this._syncList(s.A, this.animals, this._animalMap, (a) => {
      const type = ANIMAL_TYPES[a[1]];
      return {
        id: a[0], type, def: ANIMALS[type], faction: 'wild',
        radius: ANIMALS[type].radius, spawnFade: 0,
        anim: { move: 0, attack: 0, hurt: 0 }, statuses: [],
      };
    }, (e, a) => {
      e.hp = a[6]; e.maxHp = a[7];
      e.anim.move = a[8]; e.anim.attack = a[9]; e.anim.hurt = a[10];
    });

    /* ---- buildings: tile-placed, so no interpolation needed ---- */
    const liveB = new Set();
    for (const a of s.B) {
      liveB.add(a[0]);
      let b = this._buildMap.get(a[0]);
      const key = BUILD_KEYS[a[1]];
      if (!b) {
        b = { id: a[0], key, def: BUILDINGS[key], tx: a[2], ty: a[3] };
        b.x = this.world.tileToWorldX(a[2]);
        b.z = this.world.tileToWorldZ(a[3]);
        this._buildMap.set(a[0], b);
        this.buildings.push(b);
      }
      b.y = a[4]; b.hp = a[5]; b.maxHp = a[6]; b.open = !!a[7]; b.angle = a[8];
      b.seed = a[9] || null; b.grow = a[10] || 0;
    }
    for (let i = this.buildings.length - 1; i >= 0; i--) {
      if (!liveB.has(this.buildings[i].id)) {
        this._buildMap.delete(this.buildings[i].id);
        this.buildings.splice(i, 1);
      }
    }

    /* ---- projectiles: dead-reckoned, never interpolated ---- */
    const liveR = new Set();
    for (const a of s.R) {
      liveR.add(a[0]);
      let pr = this._projMap.get(a[0]);
      if (!pr) { pr = { id: a[0], hits: new Set() }; this._projMap.set(a[0], pr); this.projectiles.push(pr); }
      pr.x = a[1]; pr.y = a[2]; pr.z = a[3];
      pr.vx = a[4]; pr.vz = a[5]; pr.color = a[6]; pr.radius = a[7]; pr.hostile = !!a[8];
    }
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (!liveR.has(this.projectiles[i].id)) {
        this._projMap.delete(this.projectiles[i].id);
        this.projectiles.splice(i, 1);
      }
    }

    /* ---- pickups ---- */
    const liveK = new Set();
    for (const a of s.K) {
      liveK.add(a[0]);
      let pk = this._pickMap.get(a[0]);
      if (!pk) { pk = { id: a[0], item: a[1] }; this._pickMap.set(a[0], pk); this.pickups.push(pk); }
      pk.x = a[2]; pk.y = a[3]; pk.z = a[4];
    }
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      if (!liveK.has(this.pickups[i].id)) {
        this._pickMap.delete(this.pickups[i].id);
        this.pickups.splice(i, 1);
      }
    }

    this.constructs.length = 0;
    this.beacon.turrets.length = 0;
    for (const a of s.C) {
      const c = { id: a[0], x: a[1], y: a[2], z: a[3], angle: a[4], color: a[5] };
      if (a[6] === 1) this.beacon.turrets.push(c); else this.constructs.push(c);
    }
    this.traps = s.T.map(a => ({ x: a[0], y: a[1], z: a[2], radius: a[3], color: a[4] }));

    this.beacon.lit = !!s.BC[0];
    this.beacon.hp = s.BC[1];
    this.beacon.maxHp = s.BC[2];
    UPGRADE_KEYS.forEach((k, i) => { this.beacon.upgrades[k] = s.BC[3 + i]; });
    this.beacon.store = unpackBag(s.BC[3 + UPGRADE_KEYS.length]);

    s.G.forEach((g, i) => {
      if (!this.gates[i]) return;
      this.gates[i].sealed = !!g[0];
      this.gates[i].active = !!g[1];
      this.gates[i].progress = g[2];
    });
    this.contracts = (s.CT || []).map(([id, progress, done]) => {
      const base = CONTRACTS.find(c => c.id === id) || { id, name: id, desc: '', need: { n: 1 } };
      return { ...base, progress, done: !!done };
    });

    this.wave.alive = s.W[0];
    this.wave.budget = s.W[1];
    this.wave.active = !!s.W[2];
    if (s.sh) s.sh.forEach((v, i) => { if (this.shrines[i]) this.shrines[i].cooldown = v ? 0 : 1; });
    if (s.ca) s.ca.forEach((v, i) => { if (this.caches[i]) this.caches[i].opened = !!v; });
  }

  _syncList(rows, arr, map, make, apply) {
    const live = new Set();
    for (const a of rows) {
      live.add(a[0]);
      let e = map.get(a[0]);
      if (!e) {
        e = make(a);
        e.x = a[2]; e.z = a[3]; e.y = a[4]; e.facing = a[5];
        e.px = e.x; e.pz = e.z; e.py = e.y; e.pfacing = e.facing;
        e.tx = e.x; e.tz = e.z; e.ty = e.y; e.tfacing = e.facing;
        map.set(a[0], e);
        arr.push(e);
      } else {
        e.px = e.x; e.pz = e.z; e.py = e.y; e.pfacing = e.facing;
        e.tx = a[2]; e.tz = a[3]; e.ty = a[4]; e.tfacing = a[5];
      }
      apply(e, a);
    }
    for (let i = arr.length - 1; i >= 0; i--) {
      if (!live.has(arr[i].id)) { map.delete(arr[i].id); arr.splice(i, 1); }
    }
  }

  update(dt, localInput) {
    this.time += dt;
    this.dayTime += dt;
    this.snapAge += dt;
    const a = clamp01(this.snapAge / (1 / NET.snapshotHz));

    for (const p of this.players.values()) {
      if (p.id === this.localId) { this._predictLocal(p, localInput, dt); continue; }
      if (p.tx === undefined) continue;
      p.x = lerp(p.px, p.tx, a);
      p.z = lerp(p.pz, p.tz, a);
      p.y = lerp(p.py, p.ty, a);
      p.facing = angleLerp(p.pfacing, p.tfacing, a);
    }
    for (const list of [this.enemies, this.animals]) {
      for (const e of list) {
        e.x = lerp(e.px, e.tx, a);
        e.z = lerp(e.pz, e.tz, a);
        e.y = lerp(e.py, e.ty, a);
        e.facing = angleLerp(e.pfacing, e.tfacing, a);
      }
    }
    for (const pr of this.projectiles) { pr.x += pr.vx * dt; pr.z += pr.vz * dt; }
  }

  _predictLocal(p, input, dt) {
    if (p.state !== 'alive') {
      if (p.serverX !== undefined) { p.x = p.serverX; p.z = p.serverZ; p.y = p.serverY; }
      return;
    }
    if (input) {
      const speed = PLAYER.speed * (input.sprint ? SURVIVAL.sprintSpeed : 1);
      applyLocomotion(p, input, speed, dt);
      moveEntity(this.world, p, PLAYER.radius, dt);
      p.y = this.world.groundAt(p.x, p.z);
      if (input.ax !== undefined) {
        p.aimX = input.ax; p.aimZ = input.az;
        const dx = input.ax - p.x, dz = input.az - p.z;
        if (Math.hypot(dx, dz) > 0.15) p.facing = Math.atan2(dz, dx);
      }
      p.anim.move = Math.min(1, Math.hypot(p.vx, p.vz) / PLAYER.speed);
    }
    if (p.serverX === undefined) return;
    const err = Math.hypot(p.serverX - p.x, p.serverZ - p.z);
    if (err > 3.2) {
      p.x = p.serverX; p.z = p.serverZ; p.y = p.serverY;
      p.vx = p.serverVX; p.vz = p.serverVZ;
    } else if (err > 0.03) {
      p.x = damp(p.x, p.serverX, 9, dt);
      p.z = damp(p.z, p.serverZ, 9, dt);
      p.y = damp(p.y, p.serverY, 9, dt);
    }
  }

  drainEvents() { return []; }
}

function makeRemotePlayer(id) {
  return {
    id, name: 'RUNNER', isPlayer: true,
    x: 0, z: 0, y: 0, vx: 0, vz: 0, facing: 0, aimX: 0, aimZ: 0,
    px: 0, pz: 0, py: 0, pfacing: 0, tx: undefined, tz: 0, ty: 0, tfacing: 0,
    hp: 100, maxHp: 100, shield: 0, shieldMax: 0,
    energy: 0, maxEnergy: 100,
    stamina: 100, maxStamina: 100, hunger: 100, maxHunger: 100, warmth: 100,
    level: 1, xp: 0, xpNext: 100, skillPoints: 0,
    state: 'alive', downTimer: 0, reviveProgress: 0, respawnTimer: 0,
    anim: { move: 0, attack: 0, hurt: 0 },
    kills: 0, deaths: 0,
    inv: {}, hotbar: [null, null, null, null, null, null], hotbarIndex: 0,
    buildKey: null, craft: null, skills: {},
    dashCharges: 1, dashMax: 1, dashCd: 0, dashTimer: 0, dashDirX: 0, dashDirZ: 0,
    abilities: [null, null, null, null], cooldowns: {},
    interactTarget: null, interactProgress: 0, buffs: [], statuses: [],
    lightItem: null, stats: { magnet: 1.9, speed: 6.2 },
  };
}
