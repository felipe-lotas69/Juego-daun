/* ============================================================
   sim.js - the simulation

   Plain state and a fixed step. No three.js, no DOM: the host runs
   this and broadcasts snapshots, and in a solo run the host is you.
   The renderer reads the same objects and never writes to them,
   except for the local player's predicted position.

   Everything the view needs to know about that is not state - a hit
   landing, something dying, an ability going off - is pushed onto
   `events`, which the renderer and the network layer both drain.
   ============================================================ */

import { World, HARVESTABLE, FLAG } from '../world/worldgen.js';
import { PLAYER, BEACON, WAVE, DAY, COMBAT, XP_CURVE, WORLD_HALF } from '../core/config.js';
import { ENEMIES, ELITE, SKILLS, BEACON_UPGRADES, STATUS, BOONS, PRIMARY_ID } from './defs.js';
import { makeRng } from '../core/rng.js';
import { clamp, clamp01, lerp, dist2, damp, TAU } from '../core/util.js';
import { castAbility, stepProjectiles, damageEnemy, damagePlayer, explode } from './combat.js';
import { stepEnemy } from './enemyai.js';
import { canStand, moveEntity, applyLocomotion } from './movement.js';

export const PHASE = { LOBBY: 'lobby', RUNNING: 'running', LOST: 'lost', WON: 'won' };

let uid = 1;
const newId = () => uid++;

export class Sim {
  constructor(seed, opts = {}) {
    this.seed = seed >>> 0;
    this.world = new World(this.seed);
    this.rng = makeRng(this.seed ^ 0xbeac04);
    this.time = 0;
    this.dayTime = DAY.dayLength * 0.22;   /* start in the morning */
    this.cycleLength = DAY.dayLength + DAY.nightLength;
    this.night = 0;                        /* nights survived      */
    this.phase = PHASE.RUNNING;
    this.difficulty = opts.difficulty || 1;

    this.players = new Map();
    this.enemies = [];
    this.projectiles = [];
    this.pickups = [];
    this.constructs = [];     /* turrets and drones */
    this.traps = [];
    this.events = [];
    this.hitStop = 0;

    const lm = this.world.landmarks.find(l => l.kind === 'beacon');
    this.beacon = {
      x: lm ? lm.x : 0, z: lm ? lm.z : 0, y: lm ? lm.y : 0,
      hp: BEACON.maxHp, maxHp: BEACON.maxHp,
      upgrades: { walls: 0, turrets: 0, lamps: 0, forge: 0, clinic: 0, relay: 0 },
      res: { scrap: 0, essence: 0, cores: 0 },
      turrets: [],
    };

    this.rifts = this.world.landmarks.filter(l => l.kind === 'rift');
    this.shrines = this.world.landmarks.filter(l => l.kind === 'shrine')
      .map(l => ({ ...l, cooldown: 0 }));
    this.caches = this.world.landmarks.filter(l => l.kind === 'cache')
      .map(l => ({ ...l, opened: false }));

    this.wave = {
      active: false, budget: 0, spent: 0, spawnTimer: 0,
      queue: [], alive: 0, announced: false,
    };

    this._spawnIndex = 0;
  }

  /* ------------------------------------------------------ players */
  addPlayer(id, name) {
    const spawn = this.world.spawnPoints[this._spawnIndex++ % this.world.spawnPoints.length];
    const p = {
      id, name: (name || 'RUNNER').slice(0, 12), isPlayer: true,
      x: spawn.x, z: spawn.z, y: this.world.groundAt(spawn.x, spawn.z),
      vx: 0, vz: 0, facing: 0, aimX: spawn.x + 1, aimZ: spawn.z,
      hp: PLAYER.maxHp, maxHp: PLAYER.maxHp,
      energy: PLAYER.maxEnergy, maxEnergy: PLAYER.maxEnergy,
      shield: PLAYER.shieldMax, shieldMax: PLAYER.shieldMax, shieldTimer: 0,
      charge: PLAYER.chargeMax, chargeMax: PLAYER.chargeMax,
      level: 1, xp: 0, xpNext: XP_CURVE(1), skillPoints: 1,
      skills: {}, abilities: [null, null, null, null],
      cooldowns: { [PRIMARY_ID]: 0 },
      dashCharges: 1, dashMax: 1, dashTimer: 0, dashCd: 0, dashDirX: 0, dashDirZ: 0,
      state: 'alive', downTimer: 0, respawnTimer: 0, reviveProgress: 0,
      invuln: PLAYER.invulnOnSpawn,
      buffs: [], statuses: [],
      res: { scrap: 0, essence: 0, cores: 0 },
      kills: 0, damageDealt: 0, deaths: 0, revives: 0,
      input: emptyInput(), lastSeq: 0,
      channel: null, interactTarget: null, interactProgress: 0,
      stats: null, anim: { move: 0, attack: 0, hurt: 0 },
      killHaste: 0,
    };
    this.recalcStats(p);
    p.hp = p.stats.maxHp; p.maxHp = p.stats.maxHp;
    p.energy = p.stats.maxEnergy; p.maxEnergy = p.stats.maxEnergy;
    p.shield = p.stats.shieldMax; p.shieldMax = p.stats.shieldMax;
    p.charge = p.stats.chargeMax; p.chargeMax = p.stats.chargeMax;
    this.players.set(id, p);
    this.emit({ t: 'join', id, name: p.name });
    return p;
  }

  removePlayer(id) {
    this.players.delete(id);
    this.emit({ t: 'leave', id });
  }

  setInput(id, input) {
    const p = this.players.get(id);
    if (!p) return;
    if (input.seq !== undefined && input.seq < p.lastSeq) return;   /* stale */
    p.lastSeq = input.seq || 0;
    p.input = input;
  }

  emit(ev) {
    this.events.push(ev);
    if (this.events.length > 400) this.events.splice(0, this.events.length - 400);
  }

  /* Effective stats: base, plus skill modifiers, plus temporary
     buffs, plus whatever the beacon is providing to everyone. */
  recalcStats(p) {
    const m = {
      maxHp: PLAYER.maxHp, maxEnergy: PLAYER.maxEnergy, energyRegen: PLAYER.energyRegen,
      shieldMax: PLAYER.shieldMax, shieldRegen: PLAYER.shieldRegen,
      chargeMax: PLAYER.chargeMax, chargeDrain: PLAYER.chargeDrain,
      speed: 1, power: 1, armor: 0, crit: COMBAT.baseCrit, critMult: COMBAT.critMult,
      cdr: 0, harvest: 0, magnet: PLAYER.pickupRadius, leech: 0, regen: 0, thorns: 0,
      dashCharges: 1, dashCdr: 0, summonPower: 0, reviveSpeed: 0, reviveHeal: 0, killHaste: 0,
    };
    const add = (mods, scale = 1) => {
      if (!mods) return;
      for (const [k, v] of Object.entries(mods)) {
        /* speed and power are percentages stacking on a base of 1. */
        if (k === 'speed' || k === 'power') m[k] += v * scale;
        else if (k === 'chargeDrain') m.chargeDrain *= (1 + v * scale);
        else m[k] = (m[k] || 0) + v * scale;
      }
    };
    for (const key of Object.keys(p.skills)) add(SKILLS[key] && SKILLS[key].mods);
    for (const b of p.buffs) add(b.mods);
    /* Beacon forge helps everyone; it is why defending it matters. */
    const forge = this.beacon.upgrades.forge;
    if (forge) m.power += forge * 0.08;

    m.speed = PLAYER.speed * Math.max(0.35, m.speed);
    m.maxHp = Math.round(m.maxHp);
    m.armor = clamp(m.armor, 0, 0.75);
    m.cdr = clamp(m.cdr, 0, 0.6);
    p.stats = m;
    p.maxHp = m.maxHp; p.maxEnergy = m.maxEnergy;
    p.shieldMax = m.shieldMax; p.chargeMax = m.chargeMax;
    p.dashMax = Math.max(1, 1 + (m.dashCharges - 1));
    p.hp = Math.min(p.hp, p.maxHp);
    return m;
  }

  learnSkill(p, key) {
    const s = SKILLS[key];
    if (!s || p.skills[key]) return false;
    if (p.skillPoints < s.cost) return false;
    if (s.req && !p.skills[s.req]) return false;
    p.skillPoints -= s.cost;
    p.skills[key] = true;
    if (s.unlock) {
      const slot = p.abilities.indexOf(null);
      if (slot >= 0) p.abilities[slot] = s.unlock;
      p.cooldowns[s.unlock] = 0;
    }
    const before = p.maxHp;
    this.recalcStats(p);
    p.hp += Math.max(0, p.maxHp - before);        /* new plating is not a heal debt */
    this.emit({ t: 'skill', id: p.id, key });
    return true;
  }

  grantXp(p, amount) {
    p.xp += amount;
    while (p.xp >= p.xpNext) {
      p.xp -= p.xpNext;
      p.level++;
      p.xpNext = XP_CURVE(p.level);
      p.skillPoints += 1;
      const before = p.maxHp;
      this.recalcStats(p);
      p.hp = Math.min(p.maxHp, p.hp + (p.maxHp - before) + 22);
      this.emit({ t: 'levelup', id: p.id, level: p.level, x: p.x, y: p.y, z: p.z });
    }
  }

  buyBeaconUpgrade(key) {
    const def = BEACON_UPGRADES[key];
    if (!def) return false;
    const level = this.beacon.upgrades[key];
    if (level >= def.max) return false;
    const cost = def.cost(level);
    for (const [res, amt] of Object.entries(cost)) {
      if ((this.beacon.res[res] || 0) < amt) return false;
    }
    for (const [res, amt] of Object.entries(cost)) this.beacon.res[res] -= amt;
    this.beacon.upgrades[key] = level + 1;
    if (key === 'walls') {
      const extra = 350;
      this.beacon.maxHp += extra;
      this.beacon.hp += extra;
    }
    if (key === 'turrets') this._syncBeaconTurrets();
    if (key === 'forge') for (const p of this.players.values()) this.recalcStats(p);
    this.emit({ t: 'upgrade', key, level: level + 1 });
    return true;
  }

  _syncBeaconTurrets() {
    const want = this.beacon.upgrades.turrets;
    while (this.beacon.turrets.length < want) {
      const i = this.beacon.turrets.length;
      const a = (i / 3) * TAU + 0.6;
      this.beacon.turrets.push({
        id: newId(), x: this.beacon.x + Math.cos(a) * 4.2, z: this.beacon.z + Math.sin(a) * 4.2,
        y: this.beacon.y, cd: 0, angle: a, kind: 'beacon',
      });
    }
  }

  /* ---------------------------------------------------------- step */
  step(dt) {
    if (this.phase !== PHASE.RUNNING) { this.time += dt; return; }
    /* A landed hit briefly slows the world; it is the cheapest way
       to make a bolt feel like it connected. */
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      dt *= 0.35;
    }
    this.time += dt;
    this.dayTime += dt;

    this._stepDayCycle(dt);
    for (const p of this.players.values()) this._stepPlayer(p, dt);
    this._stepEnemies(dt);
    stepProjectiles(this, dt);
    this._stepConstructs(dt);
    this._stepTraps(dt);
    this._stepPickups(dt);
    this._stepBeacon(dt);
    this._stepWave(dt);
    this._stepShrines(dt);
  }

  _stepDayCycle(dt) {
    const t = this.dayTime % this.cycleLength;
    const wasNight = this.wave.active;
    const isNight = t >= DAY.dayLength;
    if (isNight && !wasNight) this._beginNight();
    else if (!isNight && wasNight) this._endNight();
  }

  get isNight() { return this.dayTime % this.cycleLength >= DAY.dayLength; }
  get timeToPhaseChange() {
    const t = this.dayTime % this.cycleLength;
    return this.isNight ? (this.cycleLength - t) : (DAY.dayLength - t);
  }

  _beginNight() {
    this.night++;
    const damper = 1 - this.beacon.upgrades.relay * 0.12;
    const playerScale = 0.72 + 0.28 * this.players.size;
    this.wave.active = true;
    this.wave.budget = Math.round(
      WAVE.baseBudget * Math.pow(WAVE.budgetGrowth, this.night - 1) * damper * playerScale * this.difficulty);
    this.wave.spent = 0;
    this.wave.spawnTimer = 1.4;
    this.wave.queue = this._planWave(this.wave.budget);
    this.emit({ t: 'nightfall', night: this.night, budget: this.wave.budget });
  }

  _endNight() {
    this.wave.active = false;
    /* Anything still standing at dawn burns off; the day is a rest. */
    for (const e of this.enemies) {
      if (!e.boss) e.despawn = true;
    }
    for (const p of this.players.values()) {
      if (p.state === 'dead') this._respawn(p);
    }
    this.emit({ t: 'dawn', night: this.night });
  }

  /* Spend the night's budget on a mix rather than one enemy type.
     Later nights unlock heavier tiers and start rolling elites. */
  _planWave(budget) {
    const queue = [];
    const n = this.night;
    const pool = Object.values(ENEMIES).filter(e => !e.boss && e.tier <= 1 + Math.floor(n / 1.7));
    let left = budget;
    let guard = 0;
    while (left > 4 && guard++ < 600) {
      const pick = pool[Math.floor(this.rng() * pool.length)];
      if (pick.cost > left) { left -= 2; continue; }
      const elite = n >= WAVE.eliteFromNight && this.rng() < 0.06 + n * 0.012;
      const cost = pick.cost * (elite ? 2.4 : 1);
      if (cost > left) continue;
      left -= cost;
      queue.push({ type: pick.id, elite });
    }
    if (n % WAVE.bossEvery === 0) {
      queue.push({ type: this.rng() < 0.5 ? 'colossus' : 'riftheart', elite: false, boss: true });
    }
    /* Shuffle so the boss is not always last through the gate. */
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    return queue;
  }

  _stepWave(dt) {
    const w = this.wave;
    w.alive = this.enemies.length;
    if (!w.active) return;
    if (!w.queue.length) return;
    w.spawnTimer -= dt;
    if (w.spawnTimer > 0) return;
    /* Spawns accelerate through the night so it builds to a crush. */
    const progress = 1 - w.queue.length / Math.max(1, w.budget / 8);
    w.spawnTimer = lerp(WAVE.spawnInterval, WAVE.spawnIntervalMin, clamp01(progress));

    const batch = 1 + Math.floor(this.night / 4);
    for (let i = 0; i < batch && w.queue.length; i++) {
      const spec = w.queue.shift();
      this.spawnEnemy(spec.type, spec.elite, this._spawnPosition());
    }
  }

  /* Enemies come out of rift gates when there is one nearby, and
     walk in from the dark when there is not. */
  _spawnPosition() {
    const anchor = this._averagePlayerPos();
    const near = this.rifts.filter(r => dist2(r.x, r.z, anchor.x, anchor.z) < 70 * 70);
    if (near.length && this.rng() < 0.65) {
      const r = near[Math.floor(this.rng() * near.length)];
      const a = this.rng() * TAU;
      return { x: r.x + Math.cos(a) * 1.6, z: r.z + Math.sin(a) * 1.6, fromRift: true };
    }
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = this.rng() * TAU;
      const rad = WAVE.spawnRing + this.rng() * 8;
      const x = anchor.x + Math.cos(a) * rad;
      const z = anchor.z + Math.sin(a) * rad;
      if (Math.abs(x) > WORLD_HALF - 6 || Math.abs(z) > WORLD_HALF - 6) continue;
      if (this.world.blockedAt(x, z)) continue;
      return { x, z };
    }
    return { x: anchor.x + 20, z: anchor.z };
  }

  _averagePlayerPos() {
    let x = 0, z = 0, n = 0;
    for (const p of this.players.values()) {
      if (p.state === 'dead') continue;
      x += p.x; z += p.z; n++;
    }
    if (!n) return { x: this.beacon.x, z: this.beacon.z };
    return { x: x / n, z: z / n };
  }

  spawnEnemy(type, elite, pos) {
    const def = ENEMIES[type];
    if (!def) return null;
    const scale = 1 + (this.night - 1) * 0.11;
    const e = {
      id: newId(), type, def, elite: !!elite, boss: !!def.boss,
      x: pos.x, z: pos.z, y: this.world.groundAt(pos.x, pos.z),
      vx: 0, vz: 0, facing: this.rng() * TAU,
      hp: def.hp * scale * (elite ? ELITE.hp : 1),
      maxHp: def.hp * scale * (elite ? ELITE.hp : 1),
      speed: def.speed * (elite ? ELITE.speed : 1),
      damage: def.damage * scale * (elite ? ELITE.damage : 1),
      radius: def.radius * (elite ? ELITE.scale : 1) * (def.boss ? 1 : 1),
      attackCd: this.rng() * 0.6, stateTimer: 0, aiState: 'seek',
      target: null, statuses: [], stagger: 0, armor: def.armor || 0,
      dashCd: def.dashCd ? this.rng() * def.dashCd : 0,
      slamCd: def.slamCd ? def.slamCd * 0.6 : 0,
      fuse: 0, anim: { move: 0, attack: 0, hurt: 0 }, despawn: false,
      spawnFade: pos.fromRift ? 0.45 : 0.25,
      knockX: 0, knockZ: 0,
    };
    this.enemies.push(e);
    this.emit({ t: 'spawn', id: e.id, type, elite: !!elite, x: e.x, y: e.y, z: e.z, fromRift: !!pos.fromRift });
    return e;
  }

  /* ------------------------------------------------------- players */
  _stepPlayer(p, dt) {
    const s = p.stats;
    const input = p.input || emptyInput();

    if (p.state === 'dead') {
      p.respawnTimer -= dt;
      if (p.respawnTimer <= 0) this._respawn(p);
      return;
    }

    if (p.state === 'downed') {
      p.downTimer -= dt;
      /* Allies standing over you revive; the bar is shared. */
      let helper = null;
      for (const q of this.players.values()) {
        if (q === p || q.state !== 'alive') continue;
        if (dist2(q.x, q.z, p.x, p.z) < 2.6 * 2.6 && q.input.interact) { helper = q; break; }
      }
      if (helper) {
        p.reviveProgress += dt * (1 + helper.stats.reviveSpeed) / PLAYER.reviveTime;
        if (p.reviveProgress >= 1) {
          p.state = 'alive';
          p.hp = p.maxHp * (0.35 + helper.stats.reviveHeal);
          p.shield = 0; p.invuln = 1.8; p.reviveProgress = 0;
          helper.revives++;
          this.emit({ t: 'revive', id: p.id, by: helper.id, x: p.x, y: p.y, z: p.z });
        }
      } else {
        p.reviveProgress = Math.max(0, p.reviveProgress - dt * 0.35);
      }
      if (p.downTimer <= 0) this._killPlayer(p);
      this._applyStatuses(p, dt);
      return;
    }

    /* ---- timers ---- */
    p.invuln = Math.max(0, p.invuln - dt);
    p.shieldTimer = Math.max(0, p.shieldTimer - dt);
    p.killHaste = Math.max(0, p.killHaste - dt);
    for (const k of Object.keys(p.cooldowns)) p.cooldowns[k] = Math.max(0, p.cooldowns[k] - dt);
    p.dashCd = Math.max(0, p.dashCd - dt * (1 + s.dashCdr));
    if (p.dashCd === 0 && p.dashCharges < p.dashMax) {
      p.dashCharges++;
      if (p.dashCharges < p.dashMax) p.dashCd = PLAYER.dashCooldown;
    }
    for (let i = p.buffs.length - 1; i >= 0; i--) {
      p.buffs[i].time -= dt;
      if (p.buffs[i].time <= 0) { p.buffs.splice(i, 1); this.recalcStats(p); }
    }
    this._applyStatuses(p, dt);

    /* ---- resources ---- */
    if (p.shieldTimer <= 0 && p.shield < p.shieldMax) {
      p.shield = Math.min(p.shieldMax, p.shield + s.shieldRegen * dt);
    }
    p.energy = Math.min(p.maxEnergy, p.energy + s.energyRegen * dt);
    if (s.regen) p.hp = Math.min(p.maxHp, p.hp + s.regen * dt);

    /* The core drains constantly. Running it dry does not kill you
       quickly, but it does mean you cannot stay out all night. */
    p.charge = Math.max(0, p.charge - s.chargeDrain * dt);
    if (p.charge <= 0) {
      damagePlayer(this, p, PLAYER.chargeStarveDps * dt, null, { silent: true, trueDamage: true });
    }

    /* ---- movement ---- */
    const statusSlow = this._statusFactor(p, 'slow') * this._statusFactor(p, 'shock');
    let speed = s.speed * statusSlow * (p.killHaste > 0 ? 1 + s.killHaste : 1);
    if (this.world.flagAt(p.x, p.z) & FLAG.WATER) speed *= 0.62;

    if (p.dashTimer > 0) p.invuln = Math.max(p.invuln, 0.05);
    if (applyLocomotion(p, input, speed, dt)) {
      this.emit({ t: 'dash', id: p.id, x: p.x, y: p.y, z: p.z, dx: p.dashDirX, dz: p.dashDirZ });
    }

    this._moveEntity(p, PLAYER.radius, dt);
    p.y = this.world.groundAt(p.x, p.z);

    /* ---- aiming ---- */
    if (input.ax !== undefined) { p.aimX = input.ax; p.aimZ = input.az; }
    const adx = p.aimX - p.x, adz = p.aimZ - p.z;
    if (Math.hypot(adx, adz) > 0.15) p.facing = Math.atan2(adz, adx);

    p.anim.move = Math.hypot(p.vx, p.vz) / Math.max(1, s.speed);
    p.anim.attack = Math.max(0, p.anim.attack - dt * 4);
    p.anim.hurt = Math.max(0, p.anim.hurt - dt * 3);

    /* ---- channelled abilities ---- */
    if (p.channel) {
      p.channel.time -= dt;
      castAbility(this, p, p.channel.id, dt, true);
      if (p.channel.time <= 0) p.channel = null;
    }

    /* ---- firing and abilities ---- */
    if (input.fire && !p.channel) castAbility(this, p, PRIMARY_ID, dt, false);
    for (let i = 0; i < 4; i++) {
      if (!(input.abil & (1 << i))) continue;
      const id = p.abilities[i];
      if (id) castAbility(this, p, id, dt, false);
    }

    this._stepInteract(p, dt);
  }

  _applyStatuses(ent, dt) {
    for (let i = ent.statuses.length - 1; i >= 0; i--) {
      const st = ent.statuses[i];
      st.time -= dt;
      if (st.kind === 'burn') {
        const tick = st.dps * dt;
        if (ent.isPlayer) {
          damagePlayer(this, ent, tick, null, { silent: true, trueDamage: true });
        } else {
          damageEnemy(this, ent, tick, st.source || null, { silent: true, dot: true });
        }
      }
      if (st.time <= 0) ent.statuses.splice(i, 1);
    }
  }

  _statusFactor(ent, kind) {
    let f = 1;
    for (const st of ent.statuses) if (st.kind === kind) f = Math.min(f, st.factor);
    return f;
  }

  addStatus(ent, kind, opts = {}) {
    const def = STATUS[kind];
    if (!def) return;
    const existing = ent.statuses.find(s => s.kind === kind);
    const st = existing || { kind };
    st.time = opts.duration || def.duration;
    st.factor = opts.factor !== undefined ? opts.factor : def.factor;
    st.dps = opts.dps !== undefined ? opts.dps : def.dps;
    st.source = opts.source || null;
    if (!existing) ent.statuses.push(st);
  }

  /* Interacting: shrines, caches and the beacon panel. */
  _stepInteract(p, dt) {
    let best = null, bestD = 3.2 * 3.2;
    const consider = (kind, obj, x, z, r) => {
      const d = dist2(p.x, p.z, x, z);
      if (d < Math.min(bestD, r * r)) { bestD = d; best = { kind, obj, x, z }; }
    };
    consider('beacon', this.beacon, this.beacon.x, this.beacon.z, 4.6);
    for (const s of this.shrines) if (s.cooldown <= 0) consider('shrine', s, s.x, s.z, 2.6);
    for (const c of this.caches) if (!c.opened) consider('cache', c, c.x, c.z, 2.4);
    p.interactTarget = best;

    if (!best || !p.input.interact) { p.interactProgress = 0; return; }
    if (best.kind === 'shrine') {
      p.interactProgress += dt / 1.1;
      if (p.interactProgress >= 1) {
        p.interactProgress = 0;
        best.obj.cooldown = 150;
        const boon = BOONS[Math.floor(this.rng() * BOONS.length)];
        p.buffs.push({ id: boon.id, name: boon.name, time: boon.duration, mods: boon.mods, color: boon.color });
        this.recalcStats(p);
        this.emit({ t: 'boon', id: p.id, boon: boon.id, name: boon.name, x: p.x, y: p.y, z: p.z });
      }
    } else if (best.kind === 'cache') {
      p.interactProgress += dt / 1.6;
      if (p.interactProgress >= 1) {
        p.interactProgress = 0;
        best.obj.opened = true;
        const scrap = 18 + Math.floor(this.rng() * 18);
        const essence = 8 + Math.floor(this.rng() * 12);
        this._dropPickups(best.obj.x, best.obj.z, [['scrap', scrap], ['essence', essence]]);
        if (this.rng() < 0.4) this._dropPickups(best.obj.x, best.obj.z, [['cores', 1]]);
        this.emit({ t: 'cache', x: best.obj.x, y: best.obj.y, z: best.obj.z });
      }
    }
  }

  _respawn(p) {
    const b = this.beacon;
    const a = this.rng() * TAU;
    p.x = b.x + Math.cos(a) * 3.4;
    p.z = b.z + Math.sin(a) * 3.4;
    p.y = this.world.groundAt(p.x, p.z);
    p.state = 'alive';
    p.hp = p.maxHp * 0.6;
    p.shield = 0;
    p.charge = Math.max(p.charge, p.chargeMax * 0.5);
    p.energy = p.maxEnergy * 0.5;
    p.invuln = PLAYER.invulnOnSpawn;
    p.vx = p.vz = 0;
    p.reviveProgress = 0;
    this.emit({ t: 'respawn', id: p.id, x: p.x, y: p.y, z: p.z });
  }

  downPlayer(p) {
    if (p.state !== 'alive') return;
    /* Alone, there is nobody to pick you up, so a down is a death. */
    const othersUp = [...this.players.values()].some(q => q !== p && q.state === 'alive');
    p.hp = 0; p.shield = 0; p.vx = p.vz = 0; p.channel = null;
    if (!othersUp) { this._killPlayer(p); return; }
    p.state = 'downed';
    p.downTimer = PLAYER.downedTime;
    p.reviveProgress = 0;
    this.emit({ t: 'down', id: p.id, x: p.x, y: p.y, z: p.z });
  }

  _killPlayer(p) {
    p.state = 'dead';
    p.deaths++;
    p.respawnTimer = PLAYER.respawnTime;
    /* Death costs carried salvage, not progress. */
    const lost = { scrap: Math.floor(p.res.scrap * 0.4), essence: Math.floor(p.res.essence * 0.4) };
    p.res.scrap -= lost.scrap; p.res.essence -= lost.essence;
    this.emit({ t: 'die', id: p.id, x: p.x, y: p.y, z: p.z, lost });
  }

  /* ------------------------------------------------------- enemies */
  _stepEnemies(dt) {
    const arr = this.enemies;
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i];
      if (e.despawn || e.hp <= 0) {
        if (e.hp <= 0) this._onEnemyDeath(e);
        else this.emit({ t: 'despawn', id: e.id });
        arr.splice(i, 1);
        continue;
      }
      if (e.spawnFade > 0) { e.spawnFade -= dt; continue; }
      this._applyStatuses(e, dt);
      stepEnemy(this, e, dt);
    }
    this._separate(arr, dt);
  }

  /* Cheap mutual push-apart. Without it a wave collapses into one
     overlapping blob and you cannot read how many there are. */
  _separate(arr, dt) {
    const n = arr.length;
    for (let i = 0; i < n; i++) {
      const a = arr[i];
      if (a.spawnFade > 0) continue;
      for (let j = i + 1; j < n; j++) {
        const b = arr[j];
        if (b.spawnFade > 0) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        const rr = a.radius + b.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 > rr * rr || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = (rr - d) * 0.5;
        const nx = dx / d, nz = dz / d;
        const wa = b.mass !== undefined ? 1 : 1;
        a.x -= nx * push * wa; a.z -= nz * push * wa;
        b.x += nx * push; b.z += nz * push;
      }
    }
  }

  _onEnemyDeath(e) {
    const killer = e.lastHitBy != null ? this.players.get(e.lastHitBy) : null;
    const xp = e.def.xp * (e.elite ? ELITE.xp : 1);
    if (killer) {
      killer.kills++;
      killer.killHaste = 2.2;
      this.grantXp(killer, xp);
    } else {
      for (const p of this.players.values()) this.grantXp(p, xp * 0.5);
    }
    /* Share a little experience so nobody falls behind the group. */
    for (const p of this.players.values()) if (p !== killer) this.grantXp(p, xp * 0.35);

    const drops = [];
    const r = this.rng();
    drops.push(['essence', 1 + Math.floor(e.def.xp / 12) + (e.elite ? 4 : 0)]);
    if (r < 0.45) drops.push(['scrap', 1 + Math.floor(e.def.xp / 14)]);
    if (e.elite && this.rng() < 0.5) drops.push(['cores', 1]);
    if (e.boss) { drops.push(['cores', 3]); drops.push(['scrap', 40]); drops.push(['essence', 40]); }
    if (this.rng() < 0.18) drops.push(['health', 12]);
    if (this.rng() < 0.14) drops.push(['charge', 30]);
    this._dropPickups(e.x, e.z, drops);

    this.emit({ t: 'kill', id: e.id, type: e.type, elite: e.elite, boss: e.boss,
      x: e.x, y: e.y, z: e.z, by: e.lastHitBy });
  }

  _dropPickups(x, z, drops) {
    for (const [kind, amount] of drops) {
      const a = this.rng() * TAU;
      const r = 0.2 + this.rng() * 0.7;
      this.pickups.push({
        id: newId(), kind, amount,
        x: x + Math.cos(a) * r, z: z + Math.sin(a) * r,
        y: this.world.groundAt(x, z), life: 95, vy: 2.6 + this.rng(), bounce: 0,
      });
    }
  }

  _stepPickups(dt) {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      pk.life -= dt;
      const ground = this.world.groundAt(pk.x, pk.z);
      if (pk.vy !== 0 || pk.y > ground + 0.01) {
        pk.vy -= 13 * dt;
        pk.y += pk.vy * dt;
        if (pk.y <= ground) { pk.y = ground; pk.vy = pk.bounce++ < 1 ? 1.1 : 0; }
      }
      let taken = false;
      for (const p of this.players.values()) {
        if (p.state !== 'alive') continue;
        const magnet = p.stats.magnet;
        const d2 = dist2(p.x, p.z, pk.x, pk.z);
        if (d2 < magnet * magnet * 4) {
          /* Drift toward whoever is closest once they are in range. */
          const d = Math.sqrt(d2) || 1;
          const pull = clamp01(1 - d / (magnet * 2)) * 16;
          pk.x += ((p.x - pk.x) / d) * pull * dt;
          pk.z += ((p.z - pk.z) / d) * pull * dt;
        }
        if (d2 < 0.55 * 0.55) { this._collect(p, pk); taken = true; break; }
      }
      if (taken || pk.life <= 0) this.pickups.splice(i, 1);
    }
  }

  _collect(p, pk) {
    const bonus = 1 + p.stats.harvest;
    if (pk.kind === 'health') {
      p.hp = Math.min(p.maxHp, p.hp + pk.amount);
    } else if (pk.kind === 'charge') {
      p.charge = Math.min(p.chargeMax, p.charge + pk.amount);
    } else {
      const amount = Math.max(1, Math.round(pk.amount * bonus));
      p.res[pk.kind] = (p.res[pk.kind] || 0) + amount;
      this.beacon.res[pk.kind] = (this.beacon.res[pk.kind] || 0) + amount;
      if (pk.kind === 'essence') p.charge = Math.min(p.chargeMax, p.charge + amount * 1.5);
    }
    this.emit({ t: 'pickup', id: p.id, kind: pk.kind, amount: pk.amount, x: pk.x, y: pk.y, z: pk.z });
  }

  /* --------------------------------------------- turrets and drones */
  _stepConstructs(dt) {
    for (let i = this.constructs.length - 1; i >= 0; i--) {
      const c = this.constructs[i];
      c.life -= dt;
      if (c.life <= 0 || c.hp <= 0) {
        this.emit({ t: 'construct_end', id: c.id, x: c.x, y: c.y, z: c.z });
        this.constructs.splice(i, 1);
        continue;
      }
      const owner = this.players.get(c.owner);
      if (c.orbit && owner) {
        c.orbitAngle += dt * 1.6;
        const tx = owner.x + Math.cos(c.orbitAngle) * 1.5;
        const tz = owner.z + Math.sin(c.orbitAngle) * 1.5;
        c.x = damp(c.x, tx, 6, dt);
        c.z = damp(c.z, tz, 6, dt);
        c.y = this.world.groundAt(c.x, c.z) + 1.35;
      }
      c.cd -= dt;
      const target = this._nearestEnemy(c.x, c.z, c.range);
      if (target) {
        c.angle = Math.atan2(target.z - c.z, target.x - c.x);
        if (c.cd <= 0) {
          c.cd = c.fireRate;
          const power = owner ? 1 + owner.stats.summonPower + (owner.stats.power - 1) * 0.5 : 1;
          this.spawnProjectile({
            owner: c.owner, x: c.x, y: c.y + 0.35, z: c.z,
            dirX: Math.cos(c.angle), dirZ: Math.sin(c.angle),
            speed: 22, damage: c.damage * power, life: 0.9, radius: 0.22,
            color: c.color, kind: 'construct',
          });
          this.emit({ t: 'construct_fire', id: c.id, x: c.x, y: c.y + 0.35, z: c.z, angle: c.angle });
        }
      }
    }

    /* Beacon turrets are the same idea, owned by nobody. */
    for (const t of this.beacon.turrets) {
      t.cd -= dt;
      const target = this._nearestEnemy(t.x, t.z, 13);
      if (!target) continue;
      t.angle = Math.atan2(target.z - t.z, target.x - t.x);
      if (t.cd <= 0) {
        t.cd = 0.55;
        this.spawnProjectile({
          owner: null, x: t.x, y: t.y + 1.1, z: t.z,
          dirX: Math.cos(t.angle), dirZ: Math.sin(t.angle),
          speed: 24, damage: 16 + this.night * 2, life: 0.8, radius: 0.24,
          color: 0x3fe0ff, kind: 'construct',
        });
        this.emit({ t: 'construct_fire', id: t.id, x: t.x, y: t.y + 1.1, z: t.z, angle: t.angle });
      }
    }
  }

  _stepTraps(dt) {
    for (let i = this.traps.length - 1; i >= 0; i--) {
      const tr = this.traps[i];
      tr.life -= dt;
      tr.arm -= dt;
      if (tr.arm <= 0) {
        const hit = this._nearestEnemy(tr.x, tr.z, tr.radius * 0.5);
        if (hit || tr.life <= 0) {
          explode(this, tr.x, tr.y, tr.z, tr.radius, tr.damage, tr.owner, { color: tr.color, burn: tr.burn });
          this.traps.splice(i, 1);
          continue;
        }
      }
      if (tr.life <= 0) this.traps.splice(i, 1);
    }
  }

  _stepShrines(dt) {
    for (const s of this.shrines) if (s.cooldown > 0) s.cooldown -= dt;
  }

  _stepBeacon(dt) {
    const b = this.beacon;
    const clinic = b.upgrades.clinic;
    const radius = BEACON.radius + 2.6;
    for (const p of this.players.values()) {
      if (p.state === 'dead') continue;
      if (dist2(p.x, p.z, b.x, b.z) < radius * radius) {
        if (p.state === 'alive') {
          p.hp = Math.min(p.maxHp, p.hp + (BEACON.healRate + clinic * 6) * dt);
          p.charge = Math.min(p.chargeMax, p.charge + (BEACON.chargeRate + clinic * 10) * dt);
          p.energy = Math.min(p.maxEnergy, p.energy + 14 * dt);
        } else if (p.state === 'downed') {
          /* The beacon will pick you up if you crawled home. */
          p.reviveProgress += dt / (PLAYER.reviveTime * 1.6);
          if (p.reviveProgress >= 1) {
            p.state = 'alive'; p.hp = p.maxHp * 0.4; p.reviveProgress = 0; p.invuln = 1.6;
            this.emit({ t: 'revive', id: p.id, by: null, x: p.x, y: p.y, z: p.z });
          }
        }
      }
    }
    if (!this.isNight && b.hp < b.maxHp && b.hp > 0) {
      b.hp = Math.min(b.maxHp, b.hp + BEACON.dayRepair * dt);
    }
    if (b.hp <= 0 && this.phase === PHASE.RUNNING) {
      this.phase = PHASE.LOST;
      this.emit({ t: 'beacon_down' });
    }
  }

  damageBeacon(amount, source) {
    this.beacon.hp = Math.max(0, this.beacon.hp - amount);
    this.emit({ t: 'beacon_hit', amount, hp: this.beacon.hp, max: this.beacon.maxHp });
  }

  /* --------------------------------------------------- shared utils */
  spawnProjectile(spec) {
    const p = {
      id: newId(), owner: spec.owner, kind: spec.kind || 'bolt',
      x: spec.x, y: spec.y, z: spec.z,
      vx: spec.dirX * spec.speed, vz: spec.dirZ * spec.speed, vy: spec.vy || 0,
      damage: spec.damage, life: spec.life, radius: spec.radius || 0.28,
      pierce: spec.pierce || 0, hits: new Set(), color: spec.color,
      hostile: !!spec.hostile, splash: spec.splash || 0, homing: spec.homing || 0,
      status: spec.status || null,
    };
    this.projectiles.push(p);
    this.emit({ t: 'shot', id: p.id, x: p.x, y: p.y, z: p.z, vx: p.vx, vz: p.vz,
      color: p.color, kind: p.kind, hostile: p.hostile, radius: p.radius });
    return p;
  }

  _nearestEnemy(x, z, range, exclude) {
    let best = null, bestD = range * range;
    for (const e of this.enemies) {
      if (e.spawnFade > 0 || e.hp <= 0) continue;
      if (exclude && exclude.has(e.id)) continue;
      const d = dist2(x, z, e.x, e.z);
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  nearestPlayer(x, z, range = 1e9) {
    let best = null, bestD = range * range;
    for (const p of this.players.values()) {
      if (p.state === 'dead') continue;
      const d = dist2(x, z, p.x, p.z);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  /* Circle-vs-grid movement, one axis at a time so sliding along a
     wall feels right instead of sticking. */
  _moveEntity(ent, radius, dt) { moveEntity(this.world, ent, radius, dt); }

  _canStand(x, z, radius, level) { return canStand(this.world, x, z, radius, level); }

  /* Attacks can break scenery; this is how salvage nodes are mined. */
  damageProp(x, z, amount, by) {
    const w = this.world;
    const tx = w.worldToTileX(x), ty = w.worldToTileZ(z);
    if (!w.inBounds(tx, ty)) return false;
    const i = w.idx(tx, ty);
    const prop = w.prop[i];
    const h = HARVESTABLE[prop];
    if (!h) return false;
    const hp = (w.propHp.get(i) || h.hp) - amount;
    if (hp > 0) {
      w.propHp.set(i, hp);
      this.emit({ t: 'prop_hit', tx, ty, x: w.tileToWorldX(tx), y: w.heightAtTile(tx, ty), z: w.tileToWorldZ(ty), prop });
      return true;
    }
    w.clearProp(tx, ty);
    const px = w.tileToWorldX(tx), pz = w.tileToWorldZ(ty);
    this._dropPickups(px, pz, [[h.res, h.amount]]);
    this.emit({ t: 'prop_break', tx, ty, x: px, y: w.heightAtTile(tx, ty), z: pz, prop });
    return true;
  }

  drainEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }
}

export function emptyInput() {
  return { seq: 0, mx: 0, mz: 0, ax: 0, az: 0, fire: false, dash: false, abil: 0, interact: false };
}
