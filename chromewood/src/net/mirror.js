/* ============================================================
   mirror.js - a client's view of the host's world

   Presents the same shape as Sim - players, enemies, projectiles,
   beacon - so the renderer and the HUD cannot tell whether they
   are drawing a local simulation or a remote one.

   Remote entities are interpolated between the last two snapshots,
   played back slightly in the past. The local player is predicted
   forward from its own input and eased back toward the host's
   answer, so your own movement never waits for a round trip.
   ============================================================ */

import { World } from '../world/worldgen.js';
import { ENEMIES } from '../game/defs.js';
import { ENEMY_TYPES, PICKUP_KINDS, STATES, UPGRADE_KEYS, decodeCooldowns } from './protocol.js';
import { NET, DAY, PLAYER } from '../core/config.js';
import { lerp, angleLerp, clamp01, damp } from '../core/util.js';
import { applyLocomotion, moveEntity } from '../game/movement.js';

export class Mirror {
  constructor(seed, localId) {
    this.world = new World(seed);
    this.localId = localId;
    this.players = new Map();
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.constructs = [];
    this.traps = [];
    this.beacon = {
      x: 0, y: 0, z: 0, hp: 1, maxHp: 1,
      upgrades: Object.fromEntries(UPGRADE_KEYS.map(k => [k, 0])),
      res: { scrap: 0, essence: 0, cores: 0 },
      turrets: [],
    };
    const lm = this.world.landmarks.find(l => l.kind === 'beacon');
    if (lm) { this.beacon.x = lm.x; this.beacon.y = lm.y; this.beacon.z = lm.z; }
    this.shrines = this.world.landmarks.filter(l => l.kind === 'shrine').map(l => ({ ...l, cooldown: 0 }));
    this.caches = this.world.landmarks.filter(l => l.kind === 'cache').map(l => ({ ...l, opened: false }));

    this.time = 0;
    this.dayTime = DAY.dayLength * 0.22;
    this.night = 0;
    this.phase = 'running';
    this.cycleLength = DAY.dayLength + DAY.nightLength;
    this.wave = { alive: 0, budget: 0, active: false };

    this._enemyMap = new Map();
    this._projMap = new Map();
    this._pickMap = new Map();
    this._constructMap = new Map();
    this.snapAge = 0;
    this.lastSnapAt = 0;
    this.connected = true;
  }

  get isNight() { return this.dayTime % this.cycleLength >= DAY.dayLength; }
  get timeToPhaseChange() {
    const t = this.dayTime % this.cycleLength;
    return this.isNight ? (this.cycleLength - t) : (DAY.dayLength - t);
  }

  /* The renderer calls these on a Sim; give it the same answers. */
  _nearestEnemy(x, z, range) {
    let best = null, bestD = range * range;
    for (const e of this.enemies) {
      const d = (e.x - x) ** 2 + (e.z - z) ** 2;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  applySnapshot(s) {
    this.time = s.t;
    this.dayTime = s.d;
    this.night = s.n;
    this.phase = s.ph;
    this.snapAge = 0;
    this.lastSnapAt = performance.now();

    /* ---- players ---- */
    const seen = new Set();
    for (const a of s.P) {
      const id = a[0];
      seen.add(id);
      let p = this.players.get(id);
      let fresh = false;
      if (!p) {
        p = makeRemotePlayer(id);
        this.players.set(id, p);
        fresh = true;
      }
      const local = id === this.localId;
      /* Remote players interpolate from where they were; the local
         one keeps its predicted position and only stores the
         authoritative one for reconciliation. */
      p.px = p.x; p.pz = p.z; p.py = p.y; p.pfacing = p.facing;
      if (local) { p.serverX = a[1]; p.serverZ = a[2]; p.serverY = a[3]; }
      else { p.tx = a[1]; p.tz = a[2]; p.ty = a[3]; p.tfacing = a[4]; }
      /* The first sighting has nothing to interpolate from, so put
         them where they are rather than sliding them in from the
         middle of the map. */
      if (fresh) {
        p.x = p.px = a[1]; p.z = p.pz = a[2]; p.y = p.py = a[3];
        p.facing = p.pfacing = a[4];
        if (local) { p.serverVX = 0; p.serverVZ = 0; }
      }
      p.hp = a[5]; p.maxHp = a[6]; p.shield = a[7]; p.shieldMax = a[8];
      p.energy = a[9]; p.maxEnergy = a[10]; p.charge = a[11]; p.chargeMax = a[12];
      p.level = a[13]; p.xp = a[14]; p.xpNext = a[15]; p.skillPoints = a[16];
      p.state = STATES[a[17]] || 'alive';
      p.downTimer = a[18]; p.reviveProgress = a[19]; p.respawnTimer = a[20];
      p.anim.move = a[21]; p.anim.attack = a[22]; p.anim.hurt = a[23];
      p.kills = a[24]; p.deaths = a[25];
      p.res.scrap = a[26]; p.res.essence = a[27]; p.res.cores = a[28];
      p.dashCharges = a[29]; p.dashMax = a[30]; p.dashCd = a[31];
      p.abilities = a[32].split(',').map(x => x || null);
      p.cooldowns = decodeCooldowns(a[33]);
      p.interactTarget = a[34] ? { kind: a[34] } : null;
      p.interactProgress = a[35];
      p.buffIds = a[36] ? a[36].split(',') : [];
      if (!local) { p.vx = a[37]; p.vz = a[38]; }
      if (local) {
        p.serverVX = a[37]; p.serverVZ = a[38];
        p.facing = a[4];
      }
    }
    for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);

    /* ---- enemies ---- */
    const liveE = new Set();
    for (const a of s.E) {
      const id = a[0];
      liveE.add(id);
      let e = this._enemyMap.get(id);
      const type = ENEMY_TYPES[a[1]];
      if (!e) {
        e = {
          id, type, def: ENEMIES[type], x: a[2], z: a[3], y: a[4], facing: a[5],
          px: a[2], pz: a[3], py: a[4], pfacing: a[5],
          tx: a[2], tz: a[3], ty: a[4], tfacing: a[5],
          hp: a[6], maxHp: a[7], elite: false, boss: false,
          radius: ENEMIES[type].radius, spawnFade: 0,
          anim: { move: 0, attack: 0, hurt: 0 }, statuses: [], fuse: 0,
        };
        this._enemyMap.set(id, e);
        this.enemies.push(e);
      } else {
        e.px = e.x; e.pz = e.z; e.py = e.y; e.pfacing = e.facing;
        e.tx = a[2]; e.tz = a[3]; e.ty = a[4]; e.tfacing = a[5];
      }
      e.hp = a[6]; e.maxHp = a[7];
      e.elite = !!(a[8] & 1); e.boss = !!(a[8] & 2);
      e.radius = e.def.radius * (e.elite ? 1.25 : 1);
      e.anim.move = a[9]; e.anim.attack = a[10]; e.anim.hurt = a[11];
      e.fuse = a[12];
    }
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      if (!liveE.has(this.enemies[i].id)) {
        this._enemyMap.delete(this.enemies[i].id);
        this.enemies.splice(i, 1);
      }
    }

    /* ---- projectiles: dead-reckoned, never interpolated, because
       a bolt a frame behind reads as a miss ---- */
    const liveR = new Set();
    for (const a of s.R) {
      liveR.add(a[0]);
      let pr = this._projMap.get(a[0]);
      if (!pr) {
        pr = { id: a[0], hits: new Set() };
        this._projMap.set(a[0], pr);
        this.projectiles.push(pr);
      }
      pr.x = a[1]; pr.y = a[2]; pr.z = a[3];
      pr.vx = a[4]; pr.vz = a[5]; pr.color = a[6]; pr.radius = a[7];
      pr.hostile = !!a[8];
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
      if (!pk) {
        pk = { id: a[0], kind: PICKUP_KINDS[a[1]] };
        this._pickMap.set(a[0], pk);
        this.pickups.push(pk);
      }
      pk.x = a[2]; pk.y = a[3]; pk.z = a[4];
    }
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      if (!liveK.has(this.pickups[i].id)) {
        this._pickMap.delete(this.pickups[i].id);
        this.pickups.splice(i, 1);
      }
    }

    /* ---- constructs and turrets ---- */
    this.constructs.length = 0;
    this.beacon.turrets.length = 0;
    for (const a of s.C) {
      const c = { id: a[0], x: a[1], y: a[2], z: a[3], angle: a[4], color: a[5] };
      if (a[6] === 1) this.beacon.turrets.push(c); else this.constructs.push(c);
    }

    this.traps = s.T.map(a => ({ x: a[0], y: a[1], z: a[2], radius: a[3], color: a[4] }));

    this.beacon.hp = s.B[0];
    this.beacon.maxHp = s.B[1];
    UPGRADE_KEYS.forEach((k, i) => { this.beacon.upgrades[k] = s.B[2 + i]; });
    this.beacon.res.scrap = s.B[2 + UPGRADE_KEYS.length];
    this.beacon.res.essence = s.B[3 + UPGRADE_KEYS.length];
    this.beacon.res.cores = s.B[4 + UPGRADE_KEYS.length];

    this.wave.alive = s.W[0];
    this.wave.budget = s.W[1];
    this.wave.active = !!s.W[2];
    if (s.sh) s.sh.forEach((v, i) => { if (this.shrines[i]) this.shrines[i].cooldown = v ? 0 : 1; });
    if (s.ca) s.ca.forEach((v, i) => { if (this.caches[i]) this.caches[i].opened = !!v; });
  }

  /* Called every frame between snapshots. */
  update(dt, localInput) {
    this.time += dt;
    this.dayTime += dt;
    this.snapAge += dt;

    /* Interpolation factor: play remote motion back one snapshot
       interval in the past so there is always a pair to blend. */
    const step = 1 / NET.snapshotHz;
    const a = clamp01(this.snapAge / step);

    for (const p of this.players.values()) {
      if (p.id === this.localId) { this._predictLocal(p, localInput, dt); continue; }
      if (p.tx === undefined) continue;
      p.x = lerp(p.px, p.tx, a);
      p.z = lerp(p.pz, p.tz, a);
      p.y = lerp(p.py, p.ty, a);
      p.facing = angleLerp(p.pfacing, p.tfacing, a);
    }

    for (const e of this.enemies) {
      e.x = lerp(e.px, e.tx, a);
      e.z = lerp(e.pz, e.tz, a);
      e.y = lerp(e.py, e.ty, a);
      e.facing = angleLerp(e.pfacing, e.tfacing, a);
    }

    /* Bolts keep flying on their last known velocity. */
    for (const pr of this.projectiles) {
      pr.x += pr.vx * dt;
      pr.z += pr.vz * dt;
    }
  }

  /* The local player is simulated here and nudged toward the host's
     answer. Big errors (a blink, a knockback, a respawn) snap. */
  _predictLocal(p, input, dt) {
    if (p.state !== 'alive') {
      if (p.serverX !== undefined) { p.x = p.serverX; p.z = p.serverZ; p.y = p.serverY; }
      return;
    }
    if (input) {
      const speed = PLAYER.speed * (p.speedScale || 1);
      applyLocomotion(p, input, speed, dt);
      moveEntity(this.world, p, PLAYER.radius, dt);
      p.y = this.world.groundAt(p.x, p.z);
      if (input.ax !== undefined) {
        const dx = input.ax - p.x, dz = input.az - p.z;
        if (Math.hypot(dx, dz) > 0.15) p.facing = Math.atan2(dz, dx);
      }
      p.anim.move = Math.min(1, Math.hypot(p.vx, p.vz) / PLAYER.speed);
    }
    if (p.serverX === undefined) return;
    const err = Math.hypot(p.serverX - p.x, p.serverZ - p.z);
    if (err > 3.2) {
      /* Something happened that input cannot explain. Accept it. */
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
    x: 0, z: 0, y: 0, vx: 0, vz: 0, facing: 0,
    px: 0, pz: 0, py: 0, pfacing: 0,
    tx: undefined, tz: 0, ty: 0, tfacing: 0,
    hp: 100, maxHp: 100, shield: 0, shieldMax: 0,
    energy: 0, maxEnergy: 100, charge: 100, chargeMax: 100,
    level: 1, xp: 0, xpNext: 100, skillPoints: 0,
    state: 'alive', downTimer: 0, reviveProgress: 0, respawnTimer: 0,
    anim: { move: 0, attack: 0, hurt: 0 },
    kills: 0, deaths: 0, res: { scrap: 0, essence: 0, cores: 0 },
    dashCharges: 1, dashMax: 1, dashCd: 0, dashTimer: 0, dashDirX: 0, dashDirZ: 0,
    abilities: [null, null, null, null], cooldowns: {}, skills: {},
    interactTarget: null, interactProgress: 0, buffIds: [], statuses: [], buffs: [],
    stats: { magnet: 1.5, speed: 6.2 },
  };
}
