/* ============================================================
   sim.js - the simulation

   Plain state and a fixed step. No three.js, no DOM: the host runs
   this and publishes snapshots, and in a solo run the host is you.

   The shape of a run, and what this file is organised around:

     1. you wake with nothing and a dead beacon;
     2. wood and stone become tools, tools become a camp;
     3. the beacon is repaired, which lights it, unlocks your Core's
        abilities, and makes you something the rift can find;
     4. rift gates are sealed one at a time, each one permanently
        quieter nights and a Core Shard;
     5. with every gate sealed the Rift Heart wakes at the plaza.

   Cutting across all of it: Resonance. Everything you do is heard.
   Where the night goes is decided by where the noise was.
   ============================================================ */

import { World, HARVEST, FLAG, BIOME } from '../world/worldgen.js';
import {
  PLAYER, BEACON, WAVE, DAY, COMBAT, XP_CURVE, WORLD_HALF, SURVIVAL, RESONANCE, GATE,
} from '../core/config.js';
import { ENEMIES, ELITE, SKILLS, BEACON_UPGRADES, STATUS, BOONS, PRIMARY_ID } from './defs.js';
import { ITEMS, BUILDINGS, BEACON_REPAIR } from './items.js';
import { ANIMALS, EXTRA_ENEMIES, FACTION, animalsForBiome } from './creatures.js';
import { NIGHTS, WEATHER, buildNightDeck, rollWeather, CONTRACTS } from './nights.js';
import {
  ResonanceField, swing, tickCraft, tickBody, place, invGive, invTake, invCount, heldItem,
  depositToBeacon, beaconRepairProgress,
} from './survival.js';
import { makeRng } from '../core/rng.js';
import { clamp, clamp01, lerp, dist2, dist, damp, TAU } from '../core/util.js';
import { castAbility, stepProjectiles, damageEnemy, damagePlayer, explode } from './combat.js';
import { stepEnemy } from './enemyai.js';
import { canStand, moveEntity, applyLocomotion } from './movement.js';

export const PHASE = { RUNNING: 'running', LOST: 'lost', WON: 'won' };
/* Where the run is in its arc. Shown to the player as an objective. */
export const ARC = { SURVIVE: 'survive', BEACON: 'beacon', GATES: 'gates', HEART: 'heart', DONE: 'done' };

/* Every enemy the director can field, originals plus the extras. */
const ALL_ENEMIES = { ...ENEMIES, ...EXTRA_ENEMIES };

let uid = 1;
const newId = () => uid++;

export class Sim {
  constructor(seed, opts = {}) {
    this.seed = seed >>> 0;
    this.world = new World(this.seed);
    this.rng = makeRng(this.seed ^ 0xbeac04);
    this.time = 0;
    this.dayTime = 0;                      /* you wake at first light */
    this.cycleLength = DAY.dayLength + DAY.nightLength;
    this.night = 0;
    this.phase = PHASE.RUNNING;
    this.arc = ARC.SURVIVE;
    this.difficulty = opts.difficulty || 1;

    this.players = new Map();
    this.enemies = [];
    this.animals = [];
    this.projectiles = [];
    this.pickups = [];
    this.constructs = [];
    this.traps = [];
    this.buildings = [];
    this.events = [];
    this.hitStop = 0;

    this.resonance = new ResonanceField(this.world);
    this.nightDeck = buildNightDeck(this.rng);
    this.weather = WEATHER.clear;
    this.weatherTimer = 60 + this.rng() * 90;
    this.nightType = NIGHTS[this.nightDeck[0]];

    const lm = this.world.landmarks.find(l => l.kind === 'beacon');
    this.beacon = {
      x: lm.x, z: lm.z, y: lm.y,
      lit: false, hp: 0, maxHp: BEACON.maxHp,
      store: {}, upgrades: { walls: 0, turrets: 0, lamps: 0, forge: 0, clinic: 0, relay: 0 },
      turrets: [],
    };

    this.gates = this.world.landmarks.filter(l => l.kind === 'rift').map(l => ({
      id: newId(), tx: l.tx, ty: l.ty, x: l.x, y: l.y, z: l.z,
      sealed: false, active: false, progress: 0, waveTimer: 0, budget: 0, spawned: 0,
    }));
    this.shrines = this.world.landmarks.filter(l => l.kind === 'shrine').map(l => ({ ...l, cooldown: 0 }));
    this.caches = this.world.landmarks.filter(l => l.kind === 'cache').map(l => ({ ...l, opened: false }));
    this.mines = this.world.landmarks.filter(l => l.kind === 'mine');
    this.camps = this.world.landmarks.filter(l => l.kind === 'camp');

    this.wave = { active: false, budget: 0, queue: [], spawnTimer: 0, alive: 0 };
    this.contracts = [];
    this._rollContracts();
    this.animalTimer = 2;
    this.strikeTimer = 0;
    this.corruption = 0;
    this._spawnIndex = 0;
    this.stats = { built: 0, mined: 0, chopped: 0, killed: 0, gatesSealed: 0 };
  }

  /* ---------------------------------------------------- players */
  addPlayer(id, name) {
    const spawn = this._startingSpot();
    const p = {
      id, name: (name || 'RUNNER').slice(0, 12), isPlayer: true,
      x: spawn.x, z: spawn.z, y: this.world.groundAt(spawn.x, spawn.z),
      vx: 0, vz: 0, facing: 0, aimX: spawn.x + 1, aimZ: spawn.z,
      hp: PLAYER.maxHp, maxHp: PLAYER.maxHp,
      energy: PLAYER.maxEnergy, maxEnergy: PLAYER.maxEnergy,
      shield: 0, shieldMax: 0, shieldTimer: 0,
      stamina: SURVIVAL.maxStamina, maxStamina: SURVIVAL.maxStamina,
      hunger: SURVIVAL.maxHunger * 0.85, maxHunger: SURVIVAL.maxHunger,
      warmth: SURVIVAL.maxWarmth, sprinting: false,
      level: 1, xp: 0, xpNext: XP_CURVE(1), skillPoints: 1,
      skills: {}, abilities: [null, null, null, null],
      cooldowns: {},
      inv: {}, hotbar: [null, null, null, null, null, null], hotbarIndex: 0,
      craft: null, buildKey: null, swingCd: 0,
      dashCharges: 1, dashMax: 1, dashTimer: 0, dashCd: 0, dashDirX: 0, dashDirZ: 0,
      state: 'alive', downTimer: 0, respawnTimer: 0, reviveProgress: 0,
      invuln: PLAYER.invulnOnSpawn,
      buffs: [], statuses: [],
      kills: 0, damageDealt: 0, deaths: 0, revives: 0, tookDamageTonight: false,
      input: emptyInput(), lastSeq: 0,
      channel: null, interactTarget: null, interactProgress: 0,
      stats: null, anim: { move: 0, attack: 0, hurt: 0 },
      killHaste: 0, lightItem: null, homeTx: -1, homeTy: -1,
      progress: { gather: 0, build: 0, craft: 0, kills: 0, killElite: 0 },
    };
    this.recalcStats(p);
    p.hp = p.maxHp;
    /* The sidearm costs nothing and fires forever; it is what makes
       the first night survivable without an errand first. */
    p.abilities[0] = PRIMARY_ID;
    p.cooldowns[PRIMARY_ID] = 0;
    /* You start with nothing but the clothes and a rusted core. */
    this.players.set(id, p);
    this.emit({ t: 'join', id, name: p.name });
    return p;
  }

  _startingSpot() {
    /* On the shore near the plaza, not on it: the beacon should be
       something you walk up to and find dead. */
    const w = this.world;
    const b = this.world.landmarks.find(l => l.kind === 'beacon');
    for (let attempt = 0; attempt < 200; attempt++) {
      const a = this.rng() * TAU;
      const r = 14 + this.rng() * 16;
      const x = b.x + Math.cos(a) * r, z = b.z + Math.sin(a) * r;
      const tx = w.worldToTileX(x), ty = w.worldToTileZ(z);
      if (!w.inBounds(tx, ty)) continue;
      const i = w.idx(tx, ty);
      if (w.flags[i] & (FLAG.WATER | FLAG.SOLID)) continue;
      if (w.reachMask && !w.reachMask[i]) continue;
      const biome = w.biome[i];
      if (biome === BIOME.SNOW || biome === BIOME.ASH) continue;
      return { x, z };
    }
    return { x: b.x + 12, z: b.z + 12 };
  }

  removePlayer(id) { this.players.delete(id); this.emit({ t: 'leave', id }); }

  setInput(id, input) {
    const p = this.players.get(id);
    if (!p) return;
    if (input.seq !== undefined && input.seq < p.lastSeq) return;
    p.lastSeq = input.seq || 0;
    p.input = input;
  }

  emit(ev) {
    this.events.push(ev);
    if (this.events.length > 500) this.events.splice(0, this.events.length - 500);
  }

  recalcStats(p) {
    const m = {
      maxHp: PLAYER.maxHp, maxEnergy: PLAYER.maxEnergy, energyRegen: PLAYER.energyRegen,
      shieldMax: 0, shieldRegen: PLAYER.shieldRegen,
      speed: 1, power: 1, armor: 0, crit: COMBAT.baseCrit, critMult: COMBAT.critMult,
      cdr: 0, harvest: 0, gather: 0, magnet: SURVIVAL.pickupRange, leech: 0, regen: 0, thorns: 0,
      dashCharges: 1, dashCdr: 0, summonPower: 0, reviveSpeed: 0, reviveHeal: 0, killHaste: 0,
      warmth: 0, carry: 0,
    };
    const add = (mods) => {
      if (!mods) return;
      for (const [k, v] of Object.entries(mods)) m[k] = (m[k] || 0) + v;
    };
    for (const key of Object.keys(p.skills)) add(SKILLS[key] && SKILLS[key].mods);
    for (const b of p.buffs) add(b.mods);
    const forge = this.beacon.upgrades.forge;
    if (forge) m.power += forge * 0.08;

    m.speed = PLAYER.speed * Math.max(0.35, m.speed);
    m.maxHp = Math.round(m.maxHp);
    m.armor = clamp(m.armor, 0, 0.75);
    m.cdr = clamp(m.cdr, 0, 0.6);
    p.stats = m;
    p.maxHp = m.maxHp; p.maxEnergy = m.maxEnergy;
    p.shieldMax = m.shieldMax;
    p.dashMax = Math.max(1, m.dashCharges);
    p.hp = Math.min(p.hp, p.maxHp);
    p.shield = Math.min(p.shield, p.shieldMax);
    return m;
  }

  /* Your Core works from the moment you wake up - weakly, but it
     works. Locking the whole skill tree behind repairing the beacon
     made the beacon an errand you had to run before the game would
     let you play, which is exactly the kind of directed objective
     this is not supposed to have. Repairing it is now worth doing
     for what it gives everyone, not for permission. */
  learnSkill(p, key) {
    const s = SKILLS[key];
    if (!s || p.skills[key] || p.skillPoints < s.cost) return false;
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
    p.hp += Math.max(0, p.maxHp - before);
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
      p.hp = Math.min(p.maxHp, p.hp + (p.maxHp - before) + 20);
      this.emit({ t: 'levelup', id: p.id, level: p.level, x: p.x, y: p.y, z: p.z });
    }
  }

  /* ------------------------------------------------- the beacon */
  tryLightBeacon(p) {
    if (this.beacon.lit) return false;
    if (beaconRepairProgress(this) < 1) return false;
    this.beacon.lit = true;
    this.beacon.hp = this.beacon.maxHp;
    this.arc = ARC.GATES;
    for (const q of this.players.values()) {
      q.skillPoints = Math.max(q.skillPoints, 1);
      q.abilities[0] = PRIMARY_ID;
      q.cooldowns[PRIMARY_ID] = 0;
      this.recalcStats(q);
    }
    this.emit({ t: 'beacon_lit', x: this.beacon.x, y: this.beacon.y, z: this.beacon.z });
    return true;
  }

  buyBeaconUpgrade(key) {
    const def = BEACON_UPGRADES[key];
    if (!def || !this.beacon.lit) return false;
    const level = this.beacon.upgrades[key];
    if (level >= def.max) return false;
    const cost = BEACON_COSTS[key](level);
    for (const [item, n] of cost) if ((this.beacon.store[item] || 0) < n) return false;
    for (const [item, n] of cost) this.beacon.store[item] -= n;
    this.beacon.upgrades[key] = level + 1;
    if (key === 'walls') { this.beacon.maxHp += 400; this.beacon.hp += 400; }
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
        id: newId(), x: this.beacon.x + Math.cos(a) * 4.6, z: this.beacon.z + Math.sin(a) * 4.6,
        y: this.beacon.y, cd: 0, angle: a,
      });
    }
  }

  /* ---------------------------------------------------- the step */
  step(dt) {
    if (this.phase !== PHASE.RUNNING) { this.time += dt; return; }
    if (this.hitStop > 0) { this.hitStop -= dt; dt *= 0.35; }
    this.time += dt;
    this.dayTime += dt;

    this._stepCycle(dt);
    this._stepWeather(dt);
    for (const p of this.players.values()) this._stepPlayer(p, dt);
    this._stepEnemies(dt);
    this._stepAnimals(dt);
    stepProjectiles(this, dt);
    this._stepConstructs(dt);
    this._stepBuildings(dt);
    this._stepTraps(dt);
    this._stepPickups(dt);
    this._stepBeacon(dt);
    this._stepGates(dt);
    this._stepWave(dt);
    this._stepShrines(dt);
    this.resonance.decay(dt, this.buildings.filter(b => b.def.damper && b.hp > 0));
    this._stepLures(dt);
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

  _stepCycle(dt) {
    const isNight = this.isNight;
    if (isNight && !this.wave.active) this._beginNight();
    else if (!isNight && this.wave.active) this._endNight();
  }

  _stepWeather(dt) {
    this.weatherTimer -= dt;
    if (this.weatherTimer > 0) return;
    this.weatherTimer = 110 + this.rng() * 170;
    const next = rollWeather(this.rng, this.night);
    if (next !== this.weather) {
      this.weather = next;
      this.emit({ t: 'weather', id: next.id, name: next.name, blurb: next.blurb || '' });
    }
  }

  _beginNight() {
    this.night++;
    this.nightType = NIGHTS[this.nightDeck[(this.night - 1) % this.nightDeck.length]];
    this.wave.active = true;
    const sealedCut = 1 - this.stats.gatesSealed * GATE.pressureCut;
    const damper = 1 - this.beacon.upgrades.relay * 0.12;
    const players = 0.72 + 0.28 * Math.max(1, this.players.size);
    /* The first nights are deliberately thin. You have bare hands
       and no walls; a full wave then is not a challenge, it is a
       coin flip, and the run ends before it has started. */
    const rampUp = this.night <= 5 ? [0.20, 0.35, 0.55, 0.75, 0.9][this.night - 1] : 1;
    this.wave.budget = Math.max(10, Math.round(
      WAVE.baseBudget * Math.pow(WAVE.budgetGrowth, this.night - 1)
      * this.nightType.budget * sealedCut * damper * players * rampUp * this.difficulty));
    this.wave.queue = this._planWave(this.wave.budget, this.nightType);
    this.wave.spawnTimer = 3;
    for (const p of this.players.values()) p.tookDamageTonight = false;
    this.emit({
      t: 'nightfall', night: this.night, type: this.nightType.id,
      name: this.nightType.name, blurb: this.nightType.blurb, color: this.nightType.color,
    });
  }

  _endNight() {
    this.wave.active = false;
    for (const e of this.enemies) if (!e.boss) e.despawn = true;
    for (const p of this.players.values()) {
      if (p.state === 'dead') this._respawn(p);
      if (!p.tookDamageTonight) this.noteProgress(p, 'noDamageNight', 1);
    }
    this._rollContracts();
    this.emit({ t: 'dawn', night: this.night });
  }

  _planWave(budget, type) {
    const queue = [];
    const pool = [];
    for (const [id, w] of Object.entries(type.weights)) {
      const def = ALL_ENEMIES[id];
      if (def) pool.push({ id, w, cost: def.cost });
    }
    let left = budget, guard = 0;
    while (left > 4 && guard++ < 900) {
      let total = 0;
      for (const e of pool) total += e.w;
      let r = this.rng() * total, pick = pool[0];
      for (const e of pool) { r -= e.w; if (r <= 0) { pick = e; break; } }
      const elite = this.night >= WAVE.eliteFromNight && this.rng() < (type.elite || 0.05) + this.night * 0.008;
      const cost = pick.cost * (elite ? 2.4 : 1);
      if (cost > left) { left -= 3; continue; }
      left -= cost;
      queue.push({ type: pick.id, elite });
    }
    if (type.boss && this.night >= 3) queue.push({ type: type.boss, boss: true });
    for (let i = queue.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    return queue;
  }

  _stepWave(dt) {
    this.wave.alive = this.enemies.length;
    if (!this.wave.active || !this.wave.queue.length) return;
    this.wave.spawnTimer -= dt;
    if (this.wave.spawnTimer > 0) return;
    const progress = 1 - this.wave.queue.length / Math.max(1, this.wave.budget / 8);
    this.wave.spawnTimer = lerp(WAVE.spawnInterval, WAVE.spawnIntervalMin, clamp01(progress))
      * (this.nightType.interval || 1);
    /* A hard ceiling on how many can be out at once. Without it a
       late wave dumps its whole budget on the map and the frame
       rate, not the fight, decides the outcome. */
    const cap = WAVE.concurrentCap + this.players.size * 8;
    if (this.enemies.length >= cap) return;
    const batch = 1 + Math.floor(this.night / 4);
    for (let i = 0; i < batch && this.wave.queue.length; i++) {
      const spec = this.wave.queue.shift();
      this.spawnEnemy(spec.type, spec.elite, this._spawnPosition(), spec.boss);
    }
  }

  /* Where the night goes. Resonance first - if you spent the day
     mining a hillside, that is where they come looking. */
  _spawnPosition() {
    const type = this.nightType;
    let anchor = null;
    if (type.trackResonance || this.rng() < 0.55) {
      const hot = this.resonance.hotspot();
      if (hot) anchor = hot;
    }
    const lure = this._activeLure();
    if (lure && this.rng() < 0.7) anchor = lure;
    if (!anchor && this.beacon.lit && this.rng() < (type.seekBeacon || 0.4)) {
      anchor = { x: this.beacon.x, z: this.beacon.z };
    }
    if (!anchor) anchor = this._averagePlayerPos();

    const gate = this.gates.filter(g => !g.sealed)
      .sort((a, b) => dist2(a.x, a.z, anchor.x, anchor.z) - dist2(b.x, b.z, anchor.x, anchor.z))[0];
    if (gate && this.rng() < 0.55) {
      const a = this.rng() * TAU;
      return { x: gate.x + Math.cos(a) * 1.8, z: gate.z + Math.sin(a) * 1.8, fromRift: true };
    }
    for (let attempt = 0; attempt < 30; attempt++) {
      const a = this.rng() * TAU;
      const rad = WAVE.spawnRing + this.rng() * 10;
      const x = anchor.x + Math.cos(a) * rad, z = anchor.z + Math.sin(a) * rad;
      if (Math.abs(x) > WORLD_HALF - 6 || Math.abs(z) > WORLD_HALF - 6) continue;
      if (this.world.blockedAt(x, z)) continue;
      return { x, z };
    }
    return { x: anchor.x + 18, z: anchor.z };
  }

  _activeLure() {
    for (const b of this.buildings) {
      if (b.def.lure && b.hp > 0) return { x: b.x, z: b.z, lure: true };
    }
    return null;
  }

  _stepLures(dt) {
    for (const b of this.buildings) {
      if (!b.def.lure || b.hp <= 0) continue;
      this.resonance.add(b.x, b.z, b.def.lure.strength * dt);
    }
    for (const b of this.buildings) {
      if (b.key === 'forge' && b.hp > 0) this.resonance.add(b.x, b.z, RESONANCE.perForge * dt);
    }
    if (this.beacon.lit) this.resonance.add(this.beacon.x, this.beacon.z, RESONANCE.beacon * dt);
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

  spawnEnemy(type, elite, pos, boss) {
    const def = ALL_ENEMIES[type];
    if (!def) return null;
    const scale = 1 + (this.night - 1) * 0.10;
    const hp = def.hp * scale * (elite ? ELITE.hp : 1);
    const e = {
      id: newId(), type, def, faction: FACTION.RIFT, elite: !!elite, boss: !!(boss || def.boss),
      x: pos.x, z: pos.z, y: this.world.groundAt(pos.x, pos.z),
      vx: 0, vz: 0, facing: this.rng() * TAU,
      hp, maxHp: hp,
      speed: def.speed * (elite ? ELITE.speed : 1),
      damage: def.damage * scale * (elite ? ELITE.damage : 1),
      radius: def.radius * (elite ? ELITE.scale : 1),
      attackCd: this.rng() * 0.6, aiState: 'seek', target: null,
      statuses: [], stagger: 0, armor: def.armor || 0,
      dashCd: def.dashCd ? this.rng() * def.dashCd : 0,
      slamCd: def.slamCd ? def.slamCd * 0.6 : 0,
      fuse: 0, anim: { move: 0, attack: 0, hurt: 0 }, despawn: false,
      spawnFade: pos.fromRift ? 0.45 : 0.25, knockX: 0, knockZ: 0,
      carriesCore: this.nightType.coreDrop ? this.rng() < this.nightType.coreDrop : false,
    };
    this.enemies.push(e);
    this.emit({ t: 'spawn', id: e.id, type, elite: !!elite, x: e.x, y: e.y, z: e.z, fromRift: !!pos.fromRift });
    return e;
  }

  /* ------------------------------------------------- the player */
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
          p.invuln = 1.8; p.reviveProgress = 0;
          helper.revives++;
          this.emit({ t: 'revive', id: p.id, by: helper.id, x: p.x, y: p.y, z: p.z });
        }
      } else p.reviveProgress = Math.max(0, p.reviveProgress - dt * 0.35);
      if (p.downTimer <= 0) this._killPlayer(p);
      this._applyStatuses(p, dt);
      return;
    }

    p.invuln = Math.max(0, p.invuln - dt);
    p.shieldTimer = Math.max(0, p.shieldTimer - dt);
    p.killHaste = Math.max(0, p.killHaste - dt);
    p.swingCd = Math.max(0, p.swingCd - dt);
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

    if (p.shieldMax > 0 && p.shieldTimer <= 0 && p.shield < p.shieldMax) {
      p.shield = Math.min(p.shieldMax, p.shield + s.shieldRegen * dt);
    }
    /* A cold core still turns over, just slowly. Lighting the beacon
       is the difference between scraping by and casting freely. */
    p.energy = Math.min(p.maxEnergy,
      p.energy + s.energyRegen * dt * (this.beacon.lit ? 1 : 0.45));
    if (s.regen) p.hp = Math.min(p.maxHp, p.hp + s.regen * dt);

    tickBody(this, p, dt);
    tickCraft(this, p, dt);

    /* ---- movement ---- */
    const statusSlow = this._statusFactor(p, 'slow') * this._statusFactor(p, 'shock');
    p.sprinting = !!input.sprint && p.stamina > 1 && !p.craft;
    if (p.sprinting) p.stamina = Math.max(0, p.stamina - SURVIVAL.sprintStamina * dt);
    let speed = s.speed * statusSlow * (p.sprinting ? SURVIVAL.sprintSpeed : 1)
      * (p.killHaste > 0 ? 1 + s.killHaste : 1);
    if (p.warmth <= 0) speed *= 0.72;
    const f = this.world.flagAt(p.x, p.z);
    if (f & FLAG.WATER) speed *= 0.55;
    if (p.craft) speed *= 0.35;

    if (p.dashTimer > 0) p.invuln = Math.max(p.invuln, 0.05);
    if (applyLocomotion(p, input, speed, dt)) {
      this.emit({ t: 'dash', id: p.id, x: p.x, y: p.y, z: p.z, dx: p.dashDirX, dz: p.dashDirZ });
    }
    moveEntity(this.world, p, PLAYER.radius, dt);
    p.y = this.world.groundAt(p.x, p.z);

    if (input.ax !== undefined) { p.aimX = input.ax; p.aimZ = input.az; }
    const adx = p.aimX - p.x, adz = p.aimZ - p.z;
    if (Math.hypot(adx, adz) > 0.15) p.facing = Math.atan2(adz, adx);

    p.anim.move = Math.hypot(p.vx, p.vz) / Math.max(1, s.speed);
    p.anim.attack = Math.max(0, p.anim.attack - dt * 4);
    p.anim.hurt = Math.max(0, p.anim.hurt - dt * 3);

    /* ---- what the mouse does depends on what you are holding ---- */
    if (input.fire && !p.craft) {
      const held = heldItem(p);
      const def = held && ITEMS[held];
      if (p.buildKey) this._tryBuildAtAim(p);
      else if (def && BUILDINGS[held]) this._tryBuildAtAim(p, held);
      else swing(this, p);
    }

    if (p.channel) {
      p.channel.time -= dt;
      castAbility(this, p, p.channel.id, dt, true);
      if (p.channel.time <= 0) p.channel = null;
    }
    if (this.beacon.lit) {
      for (let i = 0; i < 4; i++) {
        if (!(input.abil & (1 << i))) continue;
        const id = p.abilities[i];
        if (id) {
          if (castAbility(this, p, id, dt, false)) this.resonance.add(p.x, p.z, RESONANCE.perShot);
        }
      }
    }

    this._stepInteract(p, dt);
  }

  _tryBuildAtAim(p, key) {
    const k = key || p.buildKey;
    if (!k || p.swingCd > 0) return;
    p.swingCd = 0.25;
    const w = this.world;
    const tx = w.worldToTileX(p.aimX), ty = w.worldToTileZ(p.aimZ);
    place(this, p, k, tx, ty);
  }

  _applyStatuses(ent, dt) {
    for (let i = ent.statuses.length - 1; i >= 0; i--) {
      const st = ent.statuses[i];
      st.time -= dt;
      if (st.kind === 'burn') {
        if (ent.isPlayer) this.hurtPlayer(ent, st.dps * dt, null, { silent: true, trueDamage: true });
        else this.hurtCreature(ent, st.dps * dt, null, { silent: true, dot: true });
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

  /* ---- interaction: the beacon console, shrines, caches, doors ---- */
  _stepInteract(p, dt) {
    let best = null, bestD = 3.4 * 3.4;
    const consider = (kind, obj, x, z, r) => {
      const d = dist2(p.x, p.z, x, z);
      if (d < Math.min(bestD, r * r)) { bestD = d; best = { kind, obj, x, z }; }
    };
    consider('beacon', this.beacon, this.beacon.x, this.beacon.z, SURVIVAL.depositRange);
    for (const s of this.shrines) if (s.cooldown <= 0) consider('shrine', s, s.x, s.z, 2.6);
    for (const c of this.caches) if (!c.opened) consider('cache', c, c.x, c.z, 2.4);
    for (const g of this.gates) if (!g.sealed) consider('gate', g, g.x, g.z, GATE.radius * 0.5);
    for (const b of this.buildings) {
      if (b.hp <= 0) continue;
      if (b.def.door || b.def.storage || b.def.respawn || b.def.farm) consider('build', b, b.x, b.z, 2.2);
    }
    p.interactTarget = best;

    if (!best || !p.input.interact) { p.interactProgress = 0; return; }

    if (best.kind === 'beacon') {
      if (!this.beacon.lit) {
        depositToBeacon(this, p);
        this._checkItemContracts(p);
        if (beaconRepairProgress(this) >= 1) {
          p.interactProgress += dt / 2.5;
          if (p.interactProgress >= 1) { p.interactProgress = 0; this.tryLightBeacon(p); }
        }
      }
    } else if (best.kind === 'shrine') {
      p.interactProgress += dt / 1.1;
      if (p.interactProgress >= 1) {
        p.interactProgress = 0;
        best.obj.cooldown = 180;
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
        const loot = [['scrap', 8 + Math.floor(this.rng() * 10)], ['wood', 10], ['fiber', 8]];
        if (this.rng() < 0.5) loot.push(['iron_ore', 4 + Math.floor(this.rng() * 5)]);
        if (this.rng() < 0.3) loot.push(['core', 1]);
        if (this.rng() < 0.4) loot.push(['essence', 10]);
        this.spawnDrops(best.obj.x, best.obj.z, loot, p.id);
        this.emit({ t: 'cache', x: best.obj.x, y: best.obj.y, z: best.obj.z });
      }
    } else if (best.kind === 'gate') {
      const g = best.obj;
      if (!g.active && invCount(p, 'sealpylon') > 0) {
        p.interactProgress += dt / 1.2;
        if (p.interactProgress >= 1) {
          p.interactProgress = 0;
          invTake(p, 'sealpylon', 1);
          this._beginSeal(g, p);
        }
      }
    } else if (best.kind === 'build' && best.obj.def.farm) {
      const b = best.obj;
      if (b.grow >= 1 && b.seed) {
        /* Ripe: pull it. */
        p.interactProgress += dt / 0.8;
        if (p.interactProgress >= 1) {
          p.interactProgress = 0;
          const crop = b.def.farm.crops[b.seed];
          const bonus = 1 + (p.stats.harvest || 0);
          const got = crop.yield.map(([item, n]) => [item, Math.max(1, Math.round(n * bonus))]);
          this.spawnDrops(b.x, b.z, got, p.id);
          this.emit({ t: 'harvested', id: b.id, x: b.x, y: b.y, z: b.z, seed: b.seed });
          this.noteProgress(p, 'gather', 'crop');
          b.seed = null;
          b.grow = 0;
        }
      } else if (!b.seed) {
        /* Empty: plant whatever seed is in hand, else any seed at all. */
        /* What you are holding, if it is a seed. Otherwise whichever
           seed you have most of, rather than whichever happens to be
           first in the table - with a pack full of grain and one
           lonely spore, you meant the grain. */
        const held = heldItem(p);
        let use = held && b.def.farm.crops[held] ? held : null;
        if (!use) {
          let bestN = 0;
          for (const k of Object.keys(b.def.farm.crops)) {
            const n = invCount(p, k);
            if (n > bestN) { bestN = n; use = k; }
          }
        }
        if (use) {
          p.interactProgress += dt / 0.6;
          if (p.interactProgress >= 1) {
            p.interactProgress = 0;
            if (invTake(p, use, 1)) {
              b.seed = use;
              b.grow = 0;
              this.emit({ t: 'planted', id: b.id, x: b.x, y: b.y, z: b.z, seed: use });
            }
          }
        }
      }
    } else if (best.kind === 'build') {
      const b = best.obj;
      if (b.def.door) {
        p.interactProgress += dt / 0.35;
        if (p.interactProgress >= 1) {
          p.interactProgress = 0;
          b.open = !b.open;
          this._applyBuildingSolidity(b);
          this.emit({ t: 'door', id: b.id, open: b.open });
        }
      } else if (b.def.respawn) {
        p.homeTx = b.tx; p.homeTy = b.ty;
        this.emit({ t: 'home', id: p.id, x: b.x, y: b.y, z: b.z });
      } else if (b.def.storage) {
        /* Dumping into a chest is how salvage becomes shared. */
        let moved = 0;
        for (const [item, n] of Object.entries(p.inv)) {
          if (ITEMS[item] && ITEMS[item].tool) continue;
          this.beacon.store[item] = (this.beacon.store[item] || 0) + n;
          moved += n;
          delete p.inv[item];
        }
        p.hotbar = p.hotbar.map(h => (h && p.inv[h] ? h : null));
        if (moved) {
          this.emit({ t: 'deposit', id: p.id, moved });
          this._checkItemContracts(p);
        }
      }
    }
  }

  /* ------------------------------------------------- rift gates */
  _beginSeal(g, p) {
    g.active = true;
    g.progress = 0;
    g.waveTimer = 2;
    g.budget = GATE.budgetBase + this.stats.gatesSealed * GATE.budgetPerGate;
    g.spawned = 0;
    this.emit({ t: 'seal_start', id: g.id, x: g.x, y: g.y, z: g.z, by: p.id });
  }

  _stepGates(dt) {
    for (const g of this.gates) {
      if (g.sealed || !g.active) continue;
      /* Someone must be standing in the ring for it to advance. */
      let held = 0;
      for (const p of this.players.values()) {
        if (p.state !== 'alive') continue;
        if (dist2(p.x, p.z, g.x, g.z) < GATE.radius * GATE.radius) held++;
      }
      if (held > 0) {
        g.progress += dt * (0.7 + 0.3 * held) / GATE.sealTime;
        this.resonance.add(g.x, g.z, 40 * dt);
      } else {
        g.progress = Math.max(0, g.progress - dt * 0.6 / GATE.sealTime);
      }

      g.waveTimer -= dt;
      if (g.waveTimer <= 0 && g.spawned < g.budget) {
        g.waveTimer = GATE.waveInterval * (0.7 + this.rng() * 0.5);
        const pool = ['husk', 'spark', 'crawler', 'stalker', 'caster'];
        const n = 2 + Math.floor(this.stats.gatesSealed * 0.8) + Math.floor(this.rng() * 3);
        for (let i = 0; i < n; i++) {
          const type = pool[Math.floor(this.rng() * pool.length)];
          const a = this.rng() * TAU;
          const e = this.spawnEnemy(type, this.rng() < 0.12,
            { x: g.x + Math.cos(a) * 3, z: g.z + Math.sin(a) * 3, fromRift: true });
          if (e) g.spawned += e.def.cost;
        }
      }

      if (g.progress >= 1) {
        g.sealed = true;
        g.active = false;
        this.stats.gatesSealed++;
        const w = this.world;
        const i = w.idx(g.tx, g.ty);
        for (const p of this.players.values()) {
          if (dist2(p.x, p.z, g.x, g.z) < (GATE.radius * 1.6) ** 2) {
            invGive(p, 'core', GATE.rewardCores);
            this.grantXp(p, 240);
          }
        }
        this.emit({ t: 'seal_done', id: g.id, x: g.x, y: g.y, z: g.z, sealed: this.stats.gatesSealed });
        if (this.gates.every(x => x.sealed)) this._awakenHeart();
      }
    }
  }

  _awakenHeart() {
    if (this.arc === ARC.HEART || this.arc === ARC.DONE) return;
    this.arc = ARC.HEART;
    const a = this.rng() * TAU;
    const boss = this.spawnEnemy('riftheart', false,
      { x: this.beacon.x + Math.cos(a) * 8, z: this.beacon.z + Math.sin(a) * 8, fromRift: true }, true);
    if (boss) {
      boss.hp *= 2.2; boss.maxHp = boss.hp;
      boss.isHeart = true;
    }
    this.emit({ t: 'heart_wakes', x: this.beacon.x, y: this.beacon.y, z: this.beacon.z });
  }

  /* --------------------------------------------------- contracts */
  _rollContracts() {
    const pool = CONTRACTS.slice();
    this.contracts = [];
    for (let i = 0; i < 3 && pool.length; i++) {
      const pick = pool.splice(Math.floor(this.rng() * pool.length), 1)[0];
      this.contracts.push({ ...pick, progress: 0, done: false });
    }
  }

  noteProgress(p, kind, detail) {
    if (kind === 'gather') p.progress.gather++;
    if (kind === 'build') p.progress.build++;
    if (kind === 'craft') p.progress.craft++;
    for (const c of this.contracts) {
      if (c.done) continue;
      const need = c.need;
      if (need.kind === 'kill' && kind === 'kill') c.progress++;
      else if (need.kind === 'killElite' && kind === 'killElite') c.progress++;
      else if (need.kind === 'build' && kind === 'build') c.progress++;
      else if (need.kind === 'noDamageNight' && kind === 'noDamageNight') c.progress++;
      else continue;
      if (c.progress >= (need.n || 1)) this._completeContract(c, p);
    }
  }

  /* Item contracts are checked when salvage lands in the store. */
  _checkItemContracts(p) {
    for (const c of this.contracts) {
      if (c.done || c.need.kind !== 'item') continue;
      const have = this.beacon.store[c.need.item] || 0;
      c.progress = have;
      if (have >= c.need.n) {
        this.beacon.store[c.need.item] = have - c.need.n;
        this._completeContract(c, p);
      }
    }
  }

  _completeContract(c, p) {
    c.done = true;
    for (const [item, n] of c.reward) {
      if (p) invGive(p, item, n);
      else this.beacon.store[item] = (this.beacon.store[item] || 0) + n;
    }
    if (p) this.grantXp(p, 90);
    this.emit({ t: 'contract', id: c.id, name: c.name, reward: c.reward });
  }

  /* ------------------------------------------------- creatures */
  _stepEnemies(dt) {
    const arr = this.enemies;
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i];
      if (e.despawn || e.hp <= 0) {
        if (e.hp <= 0) this._onEnemyDeath(e); else this.emit({ t: 'despawn', id: e.id });
        arr.splice(i, 1);
        continue;
      }
      if (e.spawnFade > 0) { e.spawnFade -= dt; continue; }
      this._applyStatuses(e, dt);
      stepEnemy(this, e, dt);
      this._enemyVsBuildings(e, dt);
    }
    this._separate(arr);
  }

  /* Anything in the way gets hit; siege nights make that the point. */
  _enemyVsBuildings(e, dt) {
    if (e.attackCd > 0) return;
    const focus = (this.nightType.structureFocus || 1) * (e.def.structureBonus || 1);
    if (focus <= 1 && this.rng() > 0.15) return;
    let best = null, bestD = (e.def.range + e.radius + 0.9) ** 2;
    for (const b of this.buildings) {
      if (b.hp <= 0 || !b.def.solid) continue;
      const d = dist2(b.x, b.z, e.x, e.z);
      if (d < bestD) { bestD = d; best = b; }
    }
    if (!best) return;
    e.attackCd = e.def.attackCd;
    e.anim.attack = 1;
    this.damageBuilding(best, e.damage * focus, null);
  }

  _stepAnimals(dt) {
    this.animalTimer -= dt;
    if (this.animalTimer <= 0) { this.animalTimer = 3.5; this._populateAnimals(); }
    const arr = this.animals;
    for (let i = arr.length - 1; i >= 0; i--) {
      const a = arr[i];
      if (a.hp <= 0 || a.despawn) {
        if (a.hp <= 0) this._onAnimalDeath(a);
        arr.splice(i, 1);
        continue;
      }
      this._applyStatuses(a, dt);
      this._stepAnimal(a, dt);
    }
    this._separate(arr);
  }

  /* Wildlife keeps a loose population near the players: spawned in
     out of sight, culled when far away, so the world feels lived in
     without simulating a whole continent of deer. */
  _populateAnimals() {
    const anchor = this._averagePlayerPos();
    for (let i = this.animals.length - 1; i >= 0; i--) {
      if (dist2(this.animals[i].x, this.animals[i].z, anchor.x, anchor.z) > 95 * 95) {
        this.animals.splice(i, 1);
      }
    }
    const want = 16 + Math.floor(this.players.size * 4);
    let guard = 0;
    while (this.animals.length < want && guard++ < 40) {
      const a = this.rng() * TAU;
      const r = 26 + this.rng() * 44;
      const x = anchor.x + Math.cos(a) * r, z = anchor.z + Math.sin(a) * r;
      if (this.world.blockedAt(x, z)) continue;
      const biome = this.world.biomeAt(x, z);
      const name = Object.keys(BIOME).find(k => BIOME[k] === biome);
      const options = animalsForBiome(name, this.isNight);
      if (!options.length) continue;
      const def = options[Math.floor(this.rng() * options.length)];
      if (this.rng() > def.density) continue;
      const count = def.pack ? def.pack : 1;
      for (let k = 0; k < count; k++) {
        this.spawnAnimal(def.id, x + (this.rng() - 0.5) * 3, z + (this.rng() - 0.5) * 3);
      }
    }
  }

  spawnAnimal(type, x, z) {
    const def = ANIMALS[type];
    if (!def) return null;
    const a = {
      id: newId(), type, def, faction: FACTION.WILD,
      x, z, y: this.world.groundAt(x, z), vx: 0, vz: 0, facing: this.rng() * TAU,
      hp: def.hp, maxHp: def.hp, radius: def.radius, speed: def.speed,
      damage: def.damage || 0, attackCd: 0, anim: { move: 0, attack: 0, hurt: 0 },
      statuses: [], stagger: 0, knockX: 0, knockZ: 0, spawnFade: 0,
      aiState: 'idle', stateTimer: this.rng() * 3, fleeFrom: null, despawn: false,
      homeX: x, homeZ: z, angry: 0,
    };
    this.animals.push(a);
    return a;
  }

  _stepAnimal(a, dt) {
    const def = a.def;
    a.stateTimer -= dt;
    a.attackCd = Math.max(0, a.attackCd - dt);
    a.anim.hurt = Math.max(0, a.anim.hurt - dt * 3);
    a.anim.attack = Math.max(0, a.anim.attack - dt * 3);
    a.angry = Math.max(0, a.angry - dt);

    const threat = this.nearestPlayer(a.x, a.z, def.flee || 8);
    const hostile = def.ai === 'pack' || (def.ai === 'defend' && a.angry > 0);
    let tx = a.homeX, tz = a.homeZ, speed = def.speed * 0.35;

    if (hostile && threat) {
      tx = threat.x; tz = threat.z; speed = def.speed;
      const d = dist(a.x, a.z, threat.x, threat.z);
      if (d < (def.range || 1.2) + a.radius + PLAYER.radius && a.attackCd <= 0) {
        a.attackCd = def.attackCd || 1.4;
        a.anim.attack = 1;
        this.hurtPlayer(threat, a.damage, a, { melee: true });
      }
    } else if (threat && (def.ai === 'flee' || def.ai === 'graze' || (def.ai === 'defend' && a.angry <= 0))) {
      /* Bolt directly away, which is readable and lets a spear
         thrown ahead of a deer actually pay off. */
      const dx = a.x - threat.x, dz = a.z - threat.z;
      const m = Math.hypot(dx, dz) || 1;
      tx = a.x + (dx / m) * 12; tz = a.z + (dz / m) * 12;
      speed = def.speed;
      a.aiState = 'flee';
    } else {
      if (a.stateTimer <= 0) {
        a.stateTimer = 2 + this.rng() * 4;
        a.aiState = this.rng() < 0.45 ? 'idle' : 'wander';
        if (a.aiState === 'wander') {
          const ang = this.rng() * TAU;
          a.homeX = clamp(a.x + Math.cos(ang) * 8, -WORLD_HALF + 4, WORLD_HALF - 4);
          a.homeZ = clamp(a.z + Math.sin(ang) * 8, -WORLD_HALF + 4, WORLD_HALF - 4);
        }
      }
      if (a.aiState === 'idle') speed = 0;
    }
    if (def.ai === 'drift') {
      a.y = this.world.groundAt(a.x, a.z) + 0.8 + Math.sin(this.time * 1.4 + a.id) * 0.2;
    }

    const dx = tx - a.x, dz = tz - a.z;
    const m = Math.hypot(dx, dz) || 1;
    if (speed > 0.05 && m > 0.6) {
      a.vx = damp(a.vx, (dx / m) * speed, 8, dt);
      a.vz = damp(a.vz, (dz / m) * speed, 8, dt);
      a.facing = Math.atan2(a.vz, a.vx);
    } else {
      a.vx = damp(a.vx, 0, 10, dt);
      a.vz = damp(a.vz, 0, 10, dt);
    }
    a.vx += a.knockX; a.vz += a.knockZ;
    a.knockX *= Math.exp(-COMBAT.knockbackDecay * dt);
    a.knockZ *= Math.exp(-COMBAT.knockbackDecay * dt);
    moveEntity(this.world, a, a.radius, dt);
    if (def.ai !== 'drift') a.y = this.world.groundAt(a.x, a.z);
    a.anim.move = Math.min(1, Math.hypot(a.vx, a.vz) / Math.max(1, def.speed));
  }

  _onAnimalDeath(a) {
    const killer = a.lastHitBy != null ? this.players.get(a.lastHitBy) : null;
    if (killer) {
      this.grantXp(killer, a.def.xp);
      killer.kills++;
    }
    this.spawnDrops(a.x, a.z, a.def.drops, a.lastHitBy);
    this.emit({ t: 'animal_die', id: a.id, type: a.type, x: a.x, y: a.y, z: a.z });
  }

  /* Anything the player swings at goes through here, animal or not. */
  hurtCreature(c, amount, by, opts = {}) {
    if (c.faction === FACTION.RIFT) return damageEnemy(this, c, amount, by, opts);
    if (c.hp <= 0) return 0;
    let dmg = amount;
    if (by && this.rng() < by.stats.crit) dmg *= by.stats.critMult;
    c.hp -= dmg;
    c.anim.hurt = 1;
    c.angry = 8;
    if (by) {
      c.lastHitBy = by.id;
      by.damageDealt += dmg;
      if (opts.knock) {
        const dx = c.x - by.x, dz = c.z - by.z;
        const m = Math.hypot(dx, dz) || 1;
        c.knockX += (dx / m) * opts.knock;
        c.knockZ += (dz / m) * opts.knock;
      }
    }
    if (!opts.silent) {
      this.emit({ t: 'dmg', x: c.x, y: c.y + c.def.height * 0.9, z: c.z,
        amount: Math.round(dmg), target: 'enemy' });
    }
    return dmg;
  }

  hurtPlayer(p, amount, source, opts = {}) {
    if (opts && !opts.silent) p.tookDamageTonight = true;
    return damagePlayer(this, p, amount, source, opts);
  }

  creatureInArc(x, z, facing, reach, arc) {
    let best = null, bestD = reach * reach;
    const test = (c) => {
      if (c.hp <= 0 || c.spawnFade > 0) return;
      const dx = c.x - x, dz = c.z - z;
      const d = dx * dx + dz * dz;
      if (d > bestD + c.radius) return;
      const ang = Math.atan2(dz, dx);
      let diff = Math.abs(((ang - facing + Math.PI) % TAU + TAU) % TAU - Math.PI);
      if (diff > arc) return;
      bestD = d; best = c;
    };
    for (const e of this.enemies) test(e);
    for (const a of this.animals) test(a);
    return best;
  }

  _separate(arr) {
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
        a.x -= (dx / d) * push; a.z -= (dz / d) * push;
        b.x += (dx / d) * push; b.z += (dz / d) * push;
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
      this.noteProgress(killer, 'kill');
      if (e.elite) this.noteProgress(killer, 'killElite');
    }
    for (const p of this.players.values()) if (p !== killer) this.grantXp(p, xp * 0.35);
    this.stats.killed++;

    const drops = [['essence', 1 + Math.floor(e.def.xp / 14) + (e.elite ? 4 : 0)]];
    if (this.rng() < 0.45) drops.push(['scrap', 1 + Math.floor(e.def.xp / 16)]);
    if (e.carriesCore || (e.elite && this.rng() < 0.4)) drops.push(['core', 1]);
    if (e.boss) { drops.push(['core', 3]); drops.push(['riftglass', 3]); drops.push(['essence', 40]); }
    if (this.rng() < 0.16) drops.push(['bone', 1]);
    this.spawnDrops(e.x, e.z, drops, e.lastHitBy);

    if (e.isHeart) {
      /* A landmark, not a curtain: the rift is quiet now and you
         keep whatever you built. Stopping the game here would make
         the Heart an objective again. */
      this.arc = ARC.DONE;
      this.stats.heartsKilled = (this.stats.heartsKilled || 0) + 1;
      this.emit({ t: 'won', night: this.night });
    }
    this.emit({ t: 'kill', id: e.id, type: e.type, elite: e.elite, boss: e.boss,
      x: e.x, y: e.y, z: e.z, by: e.lastHitBy });
  }

  /* ---------------------------------------------------- pickups */
  spawnDrops(x, z, drops, ownerId) {
    for (const [item, amount] of drops) {
      if (!ITEMS[item]) continue;
      const a = this.rng() * TAU;
      const r = 0.2 + this.rng() * 0.7;
      this.pickups.push({
        id: newId(), item, amount,
        x: x + Math.cos(a) * r, z: z + Math.sin(a) * r,
        y: this.world.groundAt(x, z) + 0.3, life: 150, vy: 2.4 + this.rng(), bounce: 0,
        owner: ownerId,
      });
    }
  }

  _stepPickups(dt) {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const pk = this.pickups[i];
      pk.life -= dt;
      const ground = this.world.groundAt(pk.x, pk.z);
      if (pk.vy !== 0 || pk.y > ground + 0.32) {
        pk.vy -= 13 * dt;
        pk.y += pk.vy * dt;
        if (pk.y <= ground + 0.3) { pk.y = ground + 0.3; pk.vy = pk.bounce++ < 1 ? 1.0 : 0; }
      }
      let taken = false;
      for (const p of this.players.values()) {
        if (p.state !== 'alive') continue;
        const magnet = p.stats.magnet;
        const d2 = dist2(p.x, p.z, pk.x, pk.z);
        if (d2 < magnet * magnet * 5) {
          const d = Math.sqrt(d2) || 1;
          const pull = clamp01(1 - d / (magnet * 2.2)) * 15;
          pk.x += ((p.x - pk.x) / d) * pull * dt;
          pk.z += ((p.z - pk.z) / d) * pull * dt;
        }
        if (d2 < 0.62 * 0.62) {
          const got = invGive(p, pk.item, pk.amount);
          if (got > 0) {
            this.emit({ t: 'pickup', id: p.id, item: pk.item, amount: got, x: pk.x, y: pk.y, z: pk.z });
            taken = true;
          }
          break;
        }
      }
      if (taken || pk.life <= 0) this.pickups.splice(i, 1);
    }
  }

  /* --------------------------------------------------- buildings */
  addBuilding(key, tx, ty, owner) {
    const def = BUILDINGS[key];
    const w = this.world;
    const b = {
      id: newId(), key, def, tx, ty,
      x: w.tileToWorldX(tx), z: w.tileToWorldZ(ty), y: w.heightAtTile(tx, ty),
      hp: def.hp, maxHp: def.hp, owner, open: false, cd: 0, angle: 0, store: {},
      seed: null, grow: 0,
    };
    this.buildings.push(b);
    w.flags[w.idx(tx, ty)] |= FLAG.BUILT;
    this._applyBuildingSolidity(b);
    this.stats.built++;
    this.emit({ t: 'built', id: b.id, key, tx, ty, x: b.x, y: b.y, z: b.z, by: owner });
    return b;
  }

  _applyBuildingSolidity(b) {
    const w = this.world;
    const i = w.idx(b.tx, b.ty);
    const solid = b.def.solid && !(b.def.door && b.open);
    if (solid) w.flags[i] |= FLAG.SOLID;
    else w.flags[i] &= ~FLAG.SOLID;
  }

  damageBuilding(b, amount, by) {
    b.hp -= amount;
    this.emit({ t: 'build_hit', id: b.id, x: b.x, y: b.y, z: b.z, hp: b.hp, max: b.maxHp });
    if (b.hp <= 0) this.removeBuilding(b, by);
  }

  removeBuilding(b, by) {
    const i = this.buildings.indexOf(b);
    if (i < 0) return;
    this.buildings.splice(i, 1);
    const w = this.world;
    const ti = w.idx(b.tx, b.ty);
    w.flags[ti] &= ~(FLAG.BUILT | FLAG.SOLID);
    /* Taking your own wall down gives most of it back. */
    if (by && by.id === b.owner) {
      for (const [item, n] of b.def.cost) invGive(by, item, Math.max(1, Math.floor(n * 0.7)));
    }
    this.emit({ t: 'build_gone', id: b.id, x: b.x, y: b.y, z: b.z });
  }

  buildingInFront(p, reach) {
    const w = this.world;
    const tx = w.worldToTileX(p.x + Math.cos(p.facing) * reach * 0.8);
    const ty = w.worldToTileZ(p.z + Math.sin(p.facing) * reach * 0.8);
    return this.buildings.find(b => b.tx === tx && b.ty === ty) || null;
  }

  _stepBuildings(dt) {
    for (const b of this.buildings) {
      /* Anything planted comes on whether you watch it or not, and
         faster in the rain, which is the one time weather is good
         news rather than something to shelter from. */
      if (b.def.farm && b.seed && b.grow < 1) {
        const wet = this.weather && (this.weather.id === 'rain' || this.weather.id === 'storm');
        b.grow = Math.min(1, b.grow + (dt / b.def.farm.time) * (wet ? 1.6 : 1));
        if (b.grow >= 1) this.emit({ t: 'ripe', id: b.id, x: b.x, y: b.y, z: b.z, seed: b.seed });
      }
      if (!b.def.turret) continue;
      b.cd -= dt;
      const target = this._nearestEnemy(b.x, b.z, b.def.turret.range);
      if (!target) continue;
      b.angle = Math.atan2(target.z - b.z, target.x - b.x);
      if (b.cd > 0) continue;
      b.cd = b.def.turret.rate;
      this.spawnProjectile({
        owner: b.owner, x: b.x, y: b.y + 1.0, z: b.z,
        dirX: Math.cos(b.angle), dirZ: Math.sin(b.angle),
        speed: 24, damage: b.def.turret.damage, life: 0.9, radius: 0.24,
        color: 0x3fe0ff, kind: 'construct',
      });
      this.emit({ t: 'construct_fire', id: b.id, x: b.x, y: b.y + 1.0, z: b.z, angle: b.angle });
    }
  }

  /* Warmth and cold, which the body tick reads. */
  warmthAt(x, z) {
    let w = 0;
    for (const b of this.buildings) {
      if (!b.def.warmth || b.hp <= 0) continue;
      const r = (b.def.light ? b.def.light.range : 6);
      const d = dist(b.x, b.z, x, z);
      if (d < r) w += b.def.warmth * (1 - d / r);
    }
    if (this.beacon.lit && dist(this.beacon.x, this.beacon.z, x, z) < BEACON.lightRadius) w += 12;
    return w;
  }

  coldAt(x, z) {
    const biome = this.world.biomeAt(x, z);
    let c = 0;
    if (this.isNight) c += SURVIVAL.coldNight * this.nightAmount;
    if (biome === BIOME.SNOW) c += SURVIVAL.coldSnow;
    if (this.weather.cold) c += this.weather.cold;
    if (this.world.flagAt(x, z) & FLAG.WATER) c += 3;
    return c;
  }

  /* ------------------------------------------- turrets and traps */
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
        c.x = damp(c.x, owner.x + Math.cos(c.orbitAngle) * 1.5, 6, dt);
        c.z = damp(c.z, owner.z + Math.sin(c.orbitAngle) * 1.5, 6, dt);
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

  _stepShrines(dt) { for (const s of this.shrines) if (s.cooldown > 0) s.cooldown -= dt; }

  _stepBeacon(dt) {
    const b = this.beacon;
    if (!b.lit) return;
    const clinic = b.upgrades.clinic;
    const radius = BEACON.radius + 3.2;
    for (const p of this.players.values()) {
      if (p.state === 'dead') continue;
      if (dist2(p.x, p.z, b.x, b.z) >= radius * radius) continue;
      if (p.state === 'alive') {
        p.hp = Math.min(p.maxHp, p.hp + (BEACON.healRate + clinic * 6) * dt);
        p.energy = Math.min(p.maxEnergy, p.energy + 14 * dt);
        p.stamina = Math.min(p.maxStamina, p.stamina + 20 * dt);
      } else if (p.state === 'downed') {
        p.reviveProgress += dt / (PLAYER.reviveTime * 1.6);
        if (p.reviveProgress >= 1) {
          p.state = 'alive'; p.hp = p.maxHp * 0.4; p.reviveProgress = 0; p.invuln = 1.6;
          this.emit({ t: 'revive', id: p.id, by: null, x: p.x, y: p.y, z: p.z });
        }
      }
    }
    if (!this.isNight && b.hp < b.maxHp && b.hp > 0) {
      b.hp = Math.min(b.maxHp, b.hp + BEACON.dayRepair * dt);
    }
    /* Only something you lit can go dark on you. Losing the run to
       a structure you never opted into is a fail state attached to
       an objective you were never given. */
    if (b.hp <= 0 && b.lit) {
      b.lit = false;
      b.hp = 0;
      /* Lighting only reads the store, so unless the parts are spent
         here a wrecked beacon would come straight back for free.
         Rebuilding costs what building it cost. */
      for (const [item, n] of BEACON_REPAIR) {
        b.store[item] = Math.max(0, (b.store[item] || 0) - n);
      }
      this.emit({ t: 'beacon_down' });
    }
  }

  damageBeacon(amount) {
    if (!this.beacon.lit) return;
    this.beacon.hp = Math.max(0, this.beacon.hp - amount);
    this.emit({ t: 'beacon_hit', amount, hp: this.beacon.hp, max: this.beacon.maxHp });
  }

  _respawn(p) {
    const w = this.world;
    let x, z;
    if (p.homeTx >= 0 && this.buildings.some(b => b.tx === p.homeTx && b.ty === p.homeTy && b.def.respawn)) {
      x = w.tileToWorldX(p.homeTx) + 0.8; z = w.tileToWorldZ(p.homeTy) + 0.8;
    } else if (this.beacon.lit) {
      const a = this.rng() * TAU;
      x = this.beacon.x + Math.cos(a) * 3.4; z = this.beacon.z + Math.sin(a) * 3.4;
    } else {
      const s = this._startingSpot();
      x = s.x; z = s.z;
    }
    p.x = x; p.z = z; p.y = w.groundAt(x, z);
    p.state = 'alive';
    p.hp = p.maxHp * 0.55;
    p.stamina = p.maxStamina * 0.5;
    p.hunger = Math.max(p.hunger, p.maxHunger * 0.3);
    p.warmth = SURVIVAL.maxWarmth * 0.6;
    p.energy = p.maxEnergy * 0.5;
    p.invuln = PLAYER.invulnOnSpawn;
    p.vx = p.vz = 0;
    p.reviveProgress = 0;
    this.emit({ t: 'respawn', id: p.id, x: p.x, y: p.y, z: p.z });
  }

  downPlayer(p) {
    if (p.state !== 'alive') return;
    const othersUp = [...this.players.values()].some(q => q !== p && q.state === 'alive');
    p.hp = 0; p.shield = 0; p.vx = p.vz = 0; p.channel = null; p.craft = null;
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
    /* You drop what you were carrying, minus tools: losing the pick
       you spent an hour on is not a lesson, it is a reason to stop
       playing. */
    const drops = [];
    for (const [item, n] of Object.entries(p.inv)) {
      if (ITEMS[item] && (ITEMS[item].tool || item === 'core')) continue;
      const lose = Math.floor(n * 0.35);
      if (lose > 0) { drops.push([item, lose]); invTake(p, item, lose); }
    }
    if (drops.length) this.spawnDrops(p.x, p.z, drops, null);
    this.emit({ t: 'die', id: p.id, x: p.x, y: p.y, z: p.z, dropped: drops.length });
  }

  /* ------------------------------------------------ shared utils */
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

  _moveEntity(ent, radius, dt) { moveEntity(this.world, ent, radius, dt); }
  _canStand(x, z, radius, level) { return canStand(this.world, x, z, radius, level); }

  /* Splash and stray shots still break scenery, which is how a
     grenade clears a thicket. */
  damageProp(x, z, amount) {
    const w = this.world;
    const tx = w.worldToTileX(x), ty = w.worldToTileZ(z);
    if (!w.inBounds(tx, ty)) return false;
    const i = w.idx(tx, ty);
    const prop = w.prop[i];
    const h = HARVEST[prop];
    if (!h || h.tier > 1) return false;
    const hp = (w.propHp.get(i) || h.hp) - amount;
    if (hp > 0) { w.propHp.set(i, hp); return true; }
    w.clearProp(tx, ty);
    const px = w.tileToWorldX(tx), pz = w.tileToWorldZ(ty);
    this.spawnDrops(px, pz, h.yield, null);
    this.emit({ t: 'prop_break', tx, ty, x: px, y: w.heightAtTile(tx, ty), z: pz, prop });
    return true;
  }

  /* Convenience for the UI: what should the player be doing? */
  /* What is happening, not what to do. A sandbox has no next step
     to put in a banner, so this returns null almost all the time and
     speaks up only when something is actually going on that you
     might not be looking at. */
  status() {
    if (this.arc === ARC.HEART) {
      return { id: 'heart', text: 'THE RIFT HEART IS AWAKE', sub: 'it knows where the beacon is', urgent: true };
    }
    const active = this.gates.find(g => g.active);
    if (active) {
      return { id: 'sealing', text: 'HOLDING THE GATE', sub: `${Math.round(active.progress * 100)}%`,
        progress: active.progress };
    }
    if (this.beacon.lit && this.beacon.hp < this.beacon.maxHp * 0.5) {
      return { id: 'beacon_hurt', text: 'THE BEACON IS BURNING',
        sub: `${Math.round((this.beacon.hp / this.beacon.maxHp) * 100)}% left`,
        progress: this.beacon.hp / this.beacon.maxHp, urgent: true };
    }
    for (const p of this.players.values()) {
      if (p.state === 'downed') return { id: 'down', text: 'SOMEONE IS DOWN', sub: 'hold G over them', urgent: true };
    }
    return null;
  }

  /* Kept so anything still asking gets the same answer. */
  objective() { return this.status(); }



  drainEvents() { const e = this.events; this.events = []; return e; }
}

/* Beacon upgrade prices, in items rather than abstract resources. */
const BEACON_COSTS = {
  walls: (l) => [['stone', 30 + l * 25], ['wood', 20 + l * 15]],
  turrets: (l) => [['iron', 10 + l * 8], ['wire', 6 + l * 4], ['essence', 12 + l * 8]],
  lamps: (l) => [['scrap', 14 + l * 10], ['wire', 4 + l * 3]],
  forge: (l) => [['essence', 26 + l * 18], ['gold', 4 + l * 3]],
  clinic: (l) => [['cloth', 8 + l * 6], ['essence', 14 + l * 10]],
  relay: (l) => [['riftglass', 2 + l], ['core', 1 + l], ['essence', 40 + l * 25]],
};

export { BEACON_COSTS };

/* The shape the wire actually carries. Hotbar selection is not in
   here: it travels on the action channel, because it is a discrete
   command rather than something sampled every frame. */
export function emptyInput() {
  return { seq: 0, mx: 0, mz: 0, ax: 0, az: 0, fire: false, dash: false,
    abil: 0, interact: false, sprint: false };
}
