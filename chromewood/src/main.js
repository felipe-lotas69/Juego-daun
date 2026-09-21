/* ============================================================
   main.js - the game

   Boots the renderer, owns the loop, and switches between three
   roles that the rest of the code barely notices:

     solo    - a Sim right here, nothing on the wire
     host    - the same Sim, publishing snapshots to a room
     client  - a Mirror fed by someone else's snapshots

   Everything downstream (the view, the HUD, the effects) reads a
   world-shaped object and cannot tell which of the three it got.
   ============================================================ */

import * as THREE from '../vendor/three.module.js';

import { PixelPipeline, LAYER_WORLD } from './render/pipeline.js';
import { IsoCamera } from './render/camera.js';
import { SceneRig } from './render/scene.js';
import { WorldView } from './render/worldview.js';
import { Actor, PLAYER_COLORS } from './render/actors.js';
import { FxSystem } from './render/fx.js';
import { MeshBuilder } from './render/geom.js';
import { makeToonMaterial } from './render/materials.js';

import { Sim, PHASE, emptyInput } from './game/sim.js';
import { ENEMIES } from './game/defs.js';

import { Mirror } from './net/mirror.js';
import { RoomClient } from './net/client.js';
import { encodeSnapshot, encodeInput, decodeInput, filterEvents } from './net/protocol.js';

import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { hashString } from './core/rng.js';
import { NET, DAY } from './core/config.js';
import { clamp, clamp01, damp, lerp, TAU } from './core/util.js';

import { Hud } from './ui/hud.js';
import { Menus } from './ui/menus.js';

/* ------------------------------------------------------------- boot */
const viewCanvas = document.getElementById('view');
const hudCanvas = document.getElementById('hud');
const uiRoot = document.getElementById('ui');

const pipeline = new PixelPipeline(viewCanvas);
const rig = new SceneRig();
const cam = new IsoCamera();
const fx = new FxSystem(rig.scene);
const input = new Input(viewCanvas);
const audio = new Audio();
const hud = new Hud(hudCanvas);

const game = {
  role: 'menu',            /* menu | solo | host | client */
  sim: null,
  view: null,
  net: null,
  localId: null,
  paused: false,
  running: false,
  actors: new Map(),
  decor: null,
  colorByPlayer: new Map(),
  inputSeq: 0,
  inputAccum: 0,
  snapAccum: 0,
  pendingEvents: [],
  lastSnapshotAt: 0,
  difficulty: 1,
  seedText: 'MOSSGATE',
  name: 'RUNNER',
  over: false,
};

const menus = new Menus(uiRoot, {
  startSolo: (f) => startRun('solo', f),
  startHost: (f) => startRun('host', f),
  startJoin: (f) => startRun('client', f),
  resume: () => { menus.close(); game.paused = false; },
  settingsBack: () => menus.open(game.running ? 'pause' : 'main'),
  quit: () => quitToMenu(),
  restart: () => startRun(game.role === 'menu' ? 'solo' : game.role,
    { name: game.name, seed: game.seedText, difficulty: game.difficulty, room: '', server: game.serverInput || '' }),
  getPlayer: () => localPlayer(),
  getSim: () => game.sim,
  learnSkill: (key) => requestLearnSkill(key),
  buyUpgrade: (key) => requestBuyUpgrade(key),
  sendChat: (text) => sendChat(text),
  setPixelScale: (v) => { pipeline.setPixelScale(v); resize(); },
  setZoom: (v) => cam.setZoom(v),
  setVolume: (v) => audio.setVolume(v),
  toggleEffect: (key) => toggleEffect(key),
});

/* ---------------------------------------------------------- sizing */
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  pipeline.setSize(w * dpr, h * dpr);
  viewCanvas.style.width = w + 'px';
  viewCanvas.style.height = h + 'px';
  cam.setViewport(w / h, pipeline.internal.h);
  hud.resize(w, h, dpr);
}
window.addEventListener('resize', resize);
resize();

function toggleEffect(key) {
  if (key === 'shadows') {
    pipeline.renderer.shadowMap.enabled = !pipeline.renderer.shadowMap.enabled;
    rig.sun.castShadow = pipeline.renderer.shadowMap.enabled;
    /* Materials compiled with shadows need rebuilding without them. */
    rig.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    return pipeline.renderer.shadowMap.enabled;
  }
  pipeline.enabled[key] = !pipeline.enabled[key];
  return pipeline.enabled[key];
}

/* ------------------------------------------------------ run control */
function seedFrom(text) {
  const t = (text || '').trim();
  if (!t) return (Math.random() * 0xffffffff) >>> 0;
  if (/^\d+$/.test(t)) return (parseInt(t, 10) >>> 0) || 1;
  return hashString(t.toUpperCase());
}

async function startRun(role, form) {
  audio.resume();
  menus.setError('');
  game.name = form.name || 'RUNNER';
  game.seedText = form.seed || 'MOSSGATE';
  game.difficulty = form.difficulty || 1;
  game.serverInput = form.server || '';
  teardown();

  if (role === 'solo') {
    const seed = seedFrom(game.seedText);
    game.sim = new Sim(seed, { difficulty: game.difficulty });
    game.localId = 'local';
    const p = game.sim.addPlayer('local', game.name);
    game.colorByPlayer.set('local', 0);
    beginWorld(seed, 'solo');
    menus.setNetStat('<span class="good">SOLO</span>');
    return;
  }

  /* Both networked roles need a room first. */
  const net = new RoomClient();
  game.net = net;
  menus.setNetStat('<span class="warn">CONNECTING…</span>');
  let welcome;
  try {
    welcome = await net.connect({
      server: form.server,
      room: form.room,
      name: game.name,
      host: role === 'host',
      seed: game.seedText,
      difficulty: game.difficulty,
    });
  } catch (err) {
    game.net = null;
    menus.setNetStat('<span class="bad">OFFLINE</span>');
    menus.setError(err.message + ' You can still play a solo run.');
    return;
  }

  const seed = seedFrom(welcome.seed || game.seedText);
  game.difficulty = welcome.difficulty || game.difficulty;
  game.localId = welcome.id;

  if (welcome.host) {
    game.sim = new Sim(seed, { difficulty: game.difficulty });
    game.sim.addPlayer(welcome.id, game.name);
    for (const peer of welcome.peers) game.sim.addPlayer(peer.id, peer.name);
    assignColors();
    beginWorld(seed, 'host');
  } else {
    game.sim = new Mirror(seed, welcome.id);
    beginWorld(seed, 'client');
    net.sendTo(welcome.hostId, { k: 'hi', name: game.name });
  }
  wireNet(net);
  menus.addChat(`joined run ${welcome.room}`, '#7ee8ff');
}

function wireNet(net) {
  net.on('peer', (msg) => {
    if (game.role === 'host' && game.sim.addPlayer) {
      game.sim.addPlayer(msg.id, msg.name);
      assignColors();
      broadcastRoster();
    }
    menus.addChat(`${msg.name} joined`, '#63ff9d');
    hud.pushKill(`${msg.name} JOINED`, '#63ff9d');
  });

  net.on('gone', (msg) => {
    if (game.role === 'host' && game.sim.removePlayer) game.sim.removePlayer(msg.id);
    menus.addChat(`a runner left`, '#ffb03a');
  });

  net.on('hostchange', (msg) => {
    /* The old host vanished. Whoever is promoted rebuilds a world
       from the same seed and keeps the run alive; progress inside
       that run is lost, which is the honest trade for a relay that
       stores nothing. */
    if (msg.id === net.id && game.role === 'client') {
      const seed = seedFrom(game.seedText);
      game.sim = new Sim(seed, { difficulty: game.difficulty });
      game.sim.addPlayer(net.id, game.name);
      for (const peer of net.peers.values()) game.sim.addPlayer(peer.id, peer.name);
      assignColors();
      beginWorld(seed, 'host');
      broadcastRoster();
      menus.addChat('you are hosting now', '#ffb03a');
      hud.showToast('HOST MIGRATED', '#ffb03a');
    }
  });

  net.on('msg', (msg) => handleNetMessage(msg.from, msg.d));

  net.on('close', ({ wasOpen }) => {
    menus.setNetStat('<span class="bad">DISCONNECTED</span>');
    if (wasOpen) {
      menus.addChat('lost the connection', '#ff5a5a');
      hud.showToast('CONNECTION LOST', '#ff5a5a', 5);
    }
  });
}

function handleNetMessage(from, d) {
  if (!d || !game.sim) return;
  if (game.role === 'host') {
    switch (d.k) {
      case 'in': game.sim.setInput(from, decodeInput(d.a)); break;
      case 'hi': {
        const p = game.sim.players.get(from);
        if (p && d.name) p.name = String(d.name).slice(0, 12);
        broadcastRoster();
        break;
      }
      case 'skill': game.sim.learnSkill(game.sim.players.get(from), d.key); break;
      case 'buy': game.sim.buyBeaconUpgrade(d.key); break;
      case 'chat': relayChat(from, d.text); break;
      default: break;
    }
  } else {
    switch (d.k) {
      case 'S':
        game.sim.applySnapshot(d);
        game.lastSnapshotAt = performance.now();
        menus.setNetStat(pingLabel());
        break;
      case 'EV':
        for (const ev of d.e) consumeEvent(ev);
        break;
      case 'R':
        for (const [id, name, color] of d.r) {
          const p = game.sim.players.get(id);
          if (p) p.name = name;
          game.colorByPlayer.set(id, color);
        }
        break;
      case 'chat': menus.addChat(d.text, d.color || '#d7e4f5'); break;
      default: break;
    }
  }
}

function broadcastRoster() {
  if (game.role !== 'host' || !game.net) return;
  const r = [...game.sim.players.values()].map(p => [p.id, p.name, game.colorByPlayer.get(p.id) || 0]);
  game.net.sendTo('all', { k: 'R', r });
}

function assignColors() {
  let i = 0;
  for (const p of game.sim.players.values()) {
    if (!game.colorByPlayer.has(p.id)) game.colorByPlayer.set(p.id, i % PLAYER_COLORS.length);
    i++;
  }
}

function beginWorld(seed, role) {
  game.role = role;
  game.running = true;
  game.over = false;
  game.paused = false;
  clearActors();
  if (game.view) game.view.dispose();
  /* The title screen has its own world behind the panel; drop it
     before the real one goes in or both render at once. */
  if (game.menuView) { game.menuView.dispose(); game.menuView = null; }
  game.view = new WorldView(game.sim.world, rig.scene);
  buildDecor();

  const me = localPlayer();
  const start = me || game.sim.beacon;
  cam.snapTo(start.x, start.y, start.z);
  game.view.buildAllNear({ x: start.x, z: start.z }, 3);
  rig.setTime(game.sim.dayTime);
  menus.close();
  hud.showToast(role === 'client' ? 'JOINED THE RUN' : 'HOLD THE BEACON', '#b07bff', 3.4);
  menus.addChat('press G at the beacon to spend salvage', '#8794ab');
}

function quitToMenu() {
  teardown();
  game.role = 'menu';
  game.running = false;
  menus.open('main');
  menus.setNetStat('');
}

function teardown() {
  if (game.net) { game.net.close(); game.net = null; }
  clearActors();
  if (game.view) { game.view.dispose(); game.view = null; }
  if (game.decor) { rig.scene.remove(game.decor.group); game.decor = null; }
  game.sim = null;
  game.localId = null;
  game.colorByPlayer.clear();
  game.running = false;
}

function localPlayer() {
  if (!game.sim || !game.sim.players) return null;
  return game.sim.players.get(game.localId) || null;
}

/* --------------------------------------------------- moving scenery */
/* A few pieces have to animate, which means they cannot live in the
   static chunk meshes: the beacon's floating core and a ring over
   each rift gate. */
function buildDecor() {
  const group = new THREE.Group();
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
  const solidMat = makeToonMaterial({ vertexColors: true, rim: 1.3 });

  const coreB = new MeshBuilder();
  coreB.at(0, 0, 0).crystal(0.34, 1.1, 0xb07bff, { sides: 6, tipColor: 0xf0e6ff });
  const core = new THREE.Mesh(coreB.build(), solidMat);
  core.layers.set(LAYER_WORLD);
  core.castShadow = true;

  const haloB = new MeshBuilder();
  haloB.at(0, 0, 0).crystal(0.16, 0.9, 0xe6d6ff, { sides: 6, tipColor: 0xffffff });
  const halo = new THREE.Mesh(haloB.build(), glowMat);
  halo.layers.set(LAYER_WORLD);

  const ringB = new MeshBuilder();
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * TAU;
    ringB.at(Math.cos(a) * 1.15, 0, Math.sin(a) * 1.15).rot(a);
    ringB.box(0.24, 0.05, 0.05, 0x7ee8ff, { centered: true });
  }
  ringB.rot(0);
  const ring = new THREE.Mesh(ringB.build(), glowMat);
  ring.layers.set(LAYER_WORLD);

  group.add(core, halo, ring);

  const riftRings = [];
  for (const lm of game.sim.world.landmarks) {
    if (lm.kind !== 'rift') continue;
    const rb = new MeshBuilder();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      rb.at(Math.cos(a) * 1.0, 0, Math.sin(a) * 1.0).rot(a);
      rb.box(0.3, 0.06, 0.06, 0xff4fd8, { centered: true });
    }
    rb.rot(0);
    const m = new THREE.Mesh(rb.build(), glowMat);
    m.layers.set(LAYER_WORLD);
    m.position.set(lm.x, lm.y + 1.35, lm.z);
    group.add(m);
    riftRings.push(m);
  }

  rig.scene.add(group);
  game.decor = { group, core, halo, ring, riftRings, t: 0 };
}

function updateDecor(dt, sim) {
  const d = game.decor;
  if (!d) return;
  d.t += dt;
  const b = sim.beacon;
  const health = clamp01(b.hp / b.maxHp);
  const lift = 2.55 + Math.sin(d.t * 0.9) * 0.14;
  d.core.position.set(b.x, b.y + lift, b.z);
  d.core.rotation.y = d.t * 0.5;
  d.halo.position.set(b.x, b.y + lift + 0.08, b.z);
  d.halo.rotation.y = -d.t * 0.8;
  /* The core dims and reddens as the beacon takes damage, which is
     readable from across the map. */
  const pulse = 0.65 + 0.35 * Math.sin(d.t * (health < 0.35 ? 8 : 2.2));
  d.halo.scale.setScalar(lerp(0.6, 1.05, health) * pulse);
  d.ring.position.set(b.x, b.y + 0.62, b.z);
  d.ring.rotation.y = -d.t * 0.35;
  d.ring.scale.setScalar(1 + Math.sin(d.t * 1.7) * 0.03);

  rig.addDynamicLight(b.x, b.y + lift, b.z,
    health > 0.35 ? 0xb07bff : 0xff4f6b, 3.0 + pulse, 17);

  for (let i = 0; i < d.riftRings.length; i++) {
    const m = d.riftRings[i];
    m.rotation.y = d.t * (0.4 + i * 0.07);
    m.rotation.x = Math.sin(d.t * 0.6 + i) * 0.22;
    m.scale.setScalar(1 + Math.sin(d.t * 2 + i) * 0.06);
  }
}

/* --------------------------------------------------------- actors */
function actorKey(kind, id) { return kind + ':' + id; }

function syncActors(dt, sim) {
  const live = new Set();

  let idx = 0;
  for (const p of sim.players.values()) {
    const key = actorKey('p', p.id);
    live.add(key);
    let a = game.actors.get(key);
    if (!a) {
      const ci = game.colorByPlayer.has(p.id) ? game.colorByPlayer.get(p.id) : idx % PLAYER_COLORS.length;
      a = new Actor(rig.scene, 'player', ci);
      game.actors.set(key, a);
    }
    a.setVisible(p.state !== 'dead');
    a.update(dt, p, { groundY: sim.world.groundAt(p.x, p.z), shadowRadius: 0.95 });
    idx++;
  }

  for (const e of sim.enemies) {
    if (e.spawnFade > 0) continue;
    const key = actorKey('e', e.id);
    live.add(key);
    let a = game.actors.get(key);
    if (!a) {
      a = new Actor(rig.scene, e.type, 0);
      game.actors.set(key, a);
    }
    const scale = e.elite ? 1.25 : 1;
    a.setVisible(true);
    a.update(dt, e, { scale, shadowRadius: e.def.radius * 2.8 });
    if (e.elite || e.boss) {
      rig.addDynamicLight(e.x, e.y + e.def.height * 0.6, e.z,
        e.def.accent, e.boss ? 3.0 : 1.4, e.boss ? 12 : 6);
    }
  }

  for (const [key, a] of game.actors) {
    if (!live.has(key)) { a.dispose(); game.actors.delete(key); }
  }
}

function clearActors() {
  for (const a of game.actors.values()) a.dispose();
  game.actors.clear();
}

/* Pickups, constructs and traps are small and numerous; they get a
   shared pool of glowing boxes rather than an Actor each. */
const pickupPool = { free: [], live: [] };
let pickupGeo = null, pickupMats = null;

function ensurePickupAssets() {
  if (pickupGeo) return;
  const b = new MeshBuilder();
  b.at(0, 0, 0).box(0.26, 0.26, 0.26, 0xffffff, { centered: true });
  pickupGeo = b.build();
  pickupMats = {
    scrap: new THREE.MeshBasicMaterial({ color: 0xffb03a, toneMapped: false, fog: false }),
    essence: new THREE.MeshBasicMaterial({ color: 0xb07bff, toneMapped: false, fog: false }),
    cores: new THREE.MeshBasicMaterial({ color: 0xff4fd8, toneMapped: false, fog: false }),
    health: new THREE.MeshBasicMaterial({ color: 0x63ff9d, toneMapped: false, fog: false }),
    charge: new THREE.MeshBasicMaterial({ color: 0x3fe0ff, toneMapped: false, fog: false }),
  };
  for (const m of Object.values(pickupMats)) m.color.multiplyScalar(2.2);
}

function syncPickups(dt, sim, time) {
  ensurePickupAssets();
  while (pickupPool.live.length > sim.pickups.length) {
    const m = pickupPool.live.pop();
    m.visible = false;
    pickupPool.free.push(m);
  }
  while (pickupPool.live.length < sim.pickups.length) {
    let m = pickupPool.free.pop();
    if (!m) {
      m = new THREE.Mesh(pickupGeo, pickupMats.scrap);
      m.layers.set(LAYER_WORLD);
      rig.scene.add(m);
    }
    m.visible = true;
    pickupPool.live.push(m);
  }
  for (let i = 0; i < sim.pickups.length; i++) {
    const pk = sim.pickups[i];
    const m = pickupPool.live[i];
    m.material = pickupMats[pk.kind] || pickupMats.scrap;
    m.position.set(pk.x, pk.y + 0.34 + Math.sin(time * 3 + i) * 0.07, pk.z);
    m.rotation.set(0.5, time * 1.6 + i, 0.4);
    m.scale.setScalar(pk.kind === 'cores' ? 1.25 : 1);
  }
}

const constructPool = { free: [], live: [] };
let constructGeo = null, constructMat = null;

function syncConstructs(dt, sim, time) {
  if (!constructGeo) {
    const b = new MeshBuilder();
    b.at(0, 0, 0).taper(0.44, 0.32, 0.44, 0.7, 0x5c6470, { topColor: 0x8a93a1 });
    b.at(0, 0.32, 0).box(0.20, 0.20, 0.20, 0x7d8694, { topColor: 0xa3acba });
    b.at(0.22, 0.38, 0).box(0.34, 0.09, 0.09, 0x3e4550, { centered: true });
    constructGeo = b.build();
    constructMat = makeToonMaterial({ vertexColors: true, rim: 1.3 });
  }
  const all = [...sim.constructs, ...sim.beacon.turrets];
  while (constructPool.live.length > all.length) {
    const m = constructPool.live.pop();
    m.visible = false;
    constructPool.free.push(m);
  }
  while (constructPool.live.length < all.length) {
    let m = constructPool.free.pop();
    if (!m) {
      m = new THREE.Mesh(constructGeo, constructMat);
      m.castShadow = true;
      m.layers.set(LAYER_WORLD);
      rig.scene.add(m);
    }
    m.visible = true;
    constructPool.live.push(m);
  }
  for (let i = 0; i < all.length; i++) {
    const c = all[i];
    const m = constructPool.live[i];
    m.position.set(c.x, c.y + (c.orbit ? Math.sin(time * 2 + i) * 0.08 : 0), c.z);
    m.rotation.y = -(c.angle || 0) + Math.PI / 2;
    rig.addDynamicLight(c.x, c.y + 0.4, c.z, c.color || 0x3fe0ff, 0.9, 4.5);
  }
}

/* ---------------------------------------------------------- events */
function consumeEvent(ev) {
  fx.handleEvent(ev, { localId: game.localId });
  switch (ev.t) {
    case 'shot': audio.shoot(ev.hostile ? 0.7 : 1); break;
    case 'impact': audio.hit(false); break;
    case 'dmg': if (ev.crit) audio.hit(true); break;
    case 'boom': audio.boom(clamp(ev.radius / 4, 0.6, 2)); break;
    case 'cast': audio.cast(); break;
    case 'dash': audio.dash(); break;
    case 'pickup': audio.pickup(ev.kind); break;
    case 'prop_break': audio.breakProp(); break;
    case 'levelup':
      if (ev.id === game.localId) { audio.levelUp(); hud.showToast(`LEVEL ${ev.level} — A SKILL POINT`, '#ffe45e'); }
      break;
    case 'hurt': if (ev.id === game.localId) audio.hurt(); break;
    case 'down': {
      audio.down();
      const p = game.sim.players.get(ev.id);
      hud.pushKill(`${p ? p.name : 'A RUNNER'} IS DOWN`, '#ff6b6b');
      break;
    }
    case 'die': {
      const p = game.sim.players.get(ev.id);
      hud.pushKill(`${p ? p.name : 'A RUNNER'} DIED`, '#ff5a5a');
      break;
    }
    case 'revive': {
      const p = game.sim.players.get(ev.id);
      hud.pushKill(`${p ? p.name : 'A RUNNER'} IS BACK UP`, '#63ff9d');
      break;
    }
    case 'kill':
      if (ev.boss) hud.showToast(`${(ENEMIES[ev.type] || {}).name || 'BOSS'} DOWN`, '#ff8ae0', 4);
      else if (ev.elite) hud.pushKill(`ELITE ${(ENEMIES[ev.type] || {}).name || ''} DOWN`, '#ffb03a');
      break;
    case 'nightfall':
      audio.nightfall();
      hud.showToast(`NIGHT ${ev.night} — THEY ARE COMING`, '#c79bff', 4);
      break;
    case 'dawn':
      audio.dawn();
      hud.showToast(`DAWN — ${ev.night} NIGHT${ev.night === 1 ? '' : 'S'} HELD`, '#ffd98a', 3.5);
      break;
    case 'boon': if (ev.id === game.localId) hud.showToast(`BOON: ${ev.name.toUpperCase()}`, '#7ee8ff'); break;
    case 'cache': hud.showToast('CACHE OPENED', '#ffb03a', 2); break;
    case 'upgrade': hud.pushKill(`BEACON UPGRADED`, '#3fe0ff'); break;
    case 'nocharge': if (ev.id === game.localId) audio.ui('deny'); break;
    case 'beacon_down':
      game.over = true;
      hud.showToast('THE BEACON IS DARK', '#ff4f4f', 6);
      break;
    default: break;
  }
}

/* --------------------------------------------------------- actions */
function requestLearnSkill(key) {
  const me = localPlayer();
  if (!me) return;
  audio.ui();
  if (game.role === 'client') game.net.sendTo(hostId(), { k: 'skill', key });
  else game.sim.learnSkill(me, key);
}

function requestBuyUpgrade(key) {
  audio.ui();
  if (game.role === 'client') game.net.sendTo(hostId(), { k: 'buy', key });
  else game.sim.buyBeaconUpgrade(key);
}

function hostId() {
  if (!game.net) return null;
  for (const [id] of game.net.peers) if (id !== game.net.id) return id;
  return 'all';
}

function sendChat(text) {
  const t = (text || '').trim().slice(0, 90);
  if (!t) return;
  if (game.role === 'client') game.net.sendTo('all', { k: 'chat', text: `${game.name}: ${t}` });
  else {
    relayChat(game.localId, t);
  }
}

function relayChat(fromId, text) {
  const p = game.sim.players && game.sim.players.get(fromId);
  const line = `${p ? p.name : 'RUNNER'}: ${String(text).slice(0, 90)}`;
  menus.addChat(line);
  if (game.net) game.net.sendTo('all', { k: 'chat', text: line });
}

function pingLabel() {
  if (!game.net) return '';
  const p = Math.round(game.net.averagePing);
  const cls = p < 80 ? 'good' : p < 180 ? 'warn' : 'bad';
  const role = game.role === 'host' ? 'HOSTING' : 'JOINED';
  return `<span class="${cls}">${role} ${game.net.room || ''} · ${p}ms · ${game.net.peers.size + 1}P</span>`;
}

/* ----------------------------------------------------- input frame */
function gatherInput(me) {
  const mv = input.moveVector();
  const dir = cam.screenToWorldDir(mv.x, mv.y, new THREE.Vector3());
  const aim = cam.screenToGround(input.mouse.nx, input.mouse.ny, me.y + 0.6);
  const pad = input.gamepad();
  if (pad && (Math.abs(pad.rx) > 0.2 || Math.abs(pad.ry) > 0.2)) {
    /* Right stick aims in screen space, same mapping as movement. */
    const ad = cam.screenToWorldDir(pad.rx, pad.ry, new THREE.Vector3());
    aim.set(me.x + ad.x * 7, me.y, me.z + ad.z * 7);
  }
  let abil = 0;
  if (input.wasPressed('ability1') || (pad && pad.a1)) abil |= 1;
  if (input.wasPressed('ability2') || (pad && pad.a2)) abil |= 2;
  if (input.wasPressed('ability3') || (pad && pad.a3)) abil |= 4;
  if (input.wasPressed('ability4') || (pad && pad.a4)) abil |= 8;
  return {
    seq: ++game.inputSeq,
    mx: dir.x, mz: dir.z,
    ax: aim.x, az: aim.z,
    fire: input.firing(),
    dash: input.wasPressed('dash') || (pad && pad.dash),
    interact: input.isDown('interact'),
    abil,
  };
}

/* ------------------------------------------------------------- loop */
let last = performance.now();
let frames = 0;
let fpsAccum = 0, fpsCount = 0, fps = 60;

function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frames++;
  window.__frames = frames;

  fpsAccum += rawDt; fpsCount++;
  if (fpsAccum > 0.5) { fps = fpsCount / fpsAccum; fpsAccum = 0; fpsCount = 0; }

  handleHotkeys();

  if (!game.running || !game.sim) {
    /* The menu still gets a living background: the world keeps
       turning behind the panel. */
    rig.update(rawDt, cam.smoothed, pipeline.grade, cam.distance);
    cam.update(rawDt, null, null);
    pipeline.render(rig.scene, cam.camera, cam.subpixel);
    hud.update(rawDt);
    hud.ctx.setTransform(hud.dpr, 0, 0, hud.dpr, 0, 0);
    hud.ctx.clearRect(0, 0, hud.w, hud.h);
    input.endFrame();
    return;
  }

  const sim = game.sim;
  const me = localPlayer();
  const dt = game.paused ? 0 : rawDt;

  /* ---- input ---- */
  let myInput = null;
  if (me && !game.paused && !menus.isOpen && !menus.chatOpen) {
    myInput = gatherInput(me);
    if (game.role === 'client') {
      game.inputAccum += rawDt;
      if (game.inputAccum >= 1 / NET.inputHz) {
        game.inputAccum = 0;
        game.net.sendTo(hostId(), { k: 'in', a: encodeInput(myInput) });
      }
    } else {
      sim.setInput(game.localId, myInput);
    }
  } else if (me && game.role !== 'client') {
    sim.setInput(game.localId, emptyInput());
  }

  /* ---- step ---- */
  if (game.role === 'client') {
    sim.update(dt, myInput);
  } else if (dt > 0) {
    /* Fixed steps keep physics and cooldowns identical whatever the
       frame rate; leftovers carry to the next frame. */
    stepAccum += dt;
    let guard = 0;
    while (stepAccum >= FIXED && guard++ < 6) {
      sim.step(FIXED);
      stepAccum -= FIXED;
    }
    for (const ev of sim.drainEvents()) {
      consumeEvent(ev);
      if (game.role === 'host') game.pendingEvents.push(ev);
    }
    if (game.role === 'host') publish(rawDt);
  }

  if (sim.phase === PHASE.LOST && !game.over) game.over = true;
  if (game.over && !menus.isOpen) {
    menus.showOver(sim, game.localId);
    game.paused = true;
  }

  /* ---- camera and world ---- */
  const focus = me || sim.beacon;
  const aimPoint = me ? { x: me.aimX !== undefined ? me.aimX : me.x, z: me.aimZ !== undefined ? me.aimZ : me.z } : null;
  cam.update(rawDt, new THREE.Vector3(focus.x, focus.y, focus.z),
    aimPoint ? new THREE.Vector3(aimPoint.x, focus.y, aimPoint.z) : null);
  cam.addShake(fx.drainShake());
  if (input.mouse.wheel) cam.nudgeZoom(input.mouse.wheel * 1.2);
  if (input.isDown('zoomIn')) cam.nudgeZoom(-rawDt * 8);
  if (input.isDown('zoomOut')) cam.nudgeZoom(rawDt * 8);

  rig.setTime(sim.dayTime);
  rig.update(rawDt, cam.smoothed, pipeline.grade, cam.distance);
  audio.setAmbient(rig.nightAmount);

  game.view.update(cam.smoothed, cam.zoom);
  updateDecor(rawDt, sim);
  syncActors(rawDt, sim);
  syncPickups(rawDt, sim, now / 1000);
  syncConstructs(rawDt, sim, now / 1000);
  fx.syncBolts(sim.projectiles);
  fx.update(rawDt, pipeline.pixelScale);

  for (const l of fx.drainLights()) rig.addDynamicLight(l.x, l.y, l.z, l.color, l.intensity, l.range);
  rig.updatePointLights(game.view.lightSites, cam.smoothed);

  /* Damage flash and the grey-out while downed. */
  const flash = fx.drainFlash();
  pipeline.grade.flash = Math.max(pipeline.grade.flash * Math.pow(0.001, rawDt), flash);
  pipeline.grade.flashColor.copy(fx.flashColor);
  const downed = me && me.state !== 'alive';
  pipeline.grade.desaturate = damp(pipeline.grade.desaturate, downed ? 0.75 : 0, 4, rawDt);

  pipeline.render(rig.scene, cam.camera, cam.subpixel);

  /* ---- hud ---- */
  hud.update(rawDt);
  if (me) {
    hud.draw({
      sim, me, fx, localId: game.localId,
      project: (x, y, z) => {
        const v = new THREE.Vector3(x, y, z).project(cam.camera);
        return {
          x: (v.x * 0.5 + 0.5) * hud.w,
          y: (-v.y * 0.5 + 0.5) * hud.h,
          visible: v.z < 1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15,
          behind: v.z >= 1,
        };
      },
    });
  }
  menus.renderChat();
  if (game.net && frames % 30 === 0) menus.setNetStat(pingLabel());

  input.endFrame();
}

const FIXED = 1 / 60;
let stepAccum = 0;

/* The host publishes state at a fixed rate and events as they
   happen, batched into the same tick to keep message count down. */
function publish(dt) {
  if (!game.net) return;
  game.snapAccum += dt;
  if (game.pendingEvents.length) {
    const relay = filterEvents(game.pendingEvents);
    if (relay.length) game.net.sendTo('all', { k: 'EV', e: relay });
    game.pendingEvents.length = 0;
  }
  if (game.snapAccum >= 1 / NET.snapshotHz) {
    game.snapAccum = 0;
    game.net.sendTo('all', encodeSnapshot(game.sim));
  }
}

/* ---------------------------------------------------------- hotkeys */
function handleHotkeys() {
  if (menus.chatOpen) return;

  if (input.wasPressed('chat') && game.running && !menus.isOpen) {
    menus.openChat();
    return;
  }
  if (input.wasPressed('pause') && game.running) {
    audio.ui();
    if (menus.isOpen) { menus.close(); game.paused = false; }
    else {
      menus.setPauseInfo(game.role === 'solo'
        ? 'A solo run pauses with you.'
        : 'Co-op keeps running while this is open.');
      menus.open('pause');
      game.paused = game.role === 'solo';
    }
  }
  if (input.wasPressed('skills') && game.running) {
    audio.ui();
    if (menus.current === 'skills') { menus.close(); game.paused = false; }
    else { menus.open('skills'); game.paused = game.role === 'solo'; }
  }
  /* Holding interact at the beacon opens the console. */
  const me = localPlayer();
  if (me && me.interactTarget && me.interactTarget.kind === 'beacon'
      && input.wasPressed('interact') && !menus.isOpen && game.running) {
    audio.ui();
    menus.open('beacon');
    game.paused = game.role === 'solo';
  }
}

/* The HUD registers touch hit areas; feed presses back to Input. */
hudCanvas.addEventListener('pointerdown', () => { /* handled by the view canvas */ });
viewCanvas.addEventListener('pointerdown', (e) => {
  audio.resume();
  if (!hud.touch) return;
  const r = viewCanvas.getBoundingClientRect();
  const name = hud.hitTest(e.clientX - r.left, e.clientY - r.top);
  if (name) input.setTouchButton(name === 'dash' ? 'dash' : name, 'pressed');
});
viewCanvas.addEventListener('pointerup', () => {
  for (const k of ['dash', 'ability1', 'ability2', 'ability3', 'ability4']) input.setTouchButton(k, 'up');
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.role === 'solo' && game.running) {
    game.paused = true;
    if (!menus.isOpen) menus.open('pause');
  }
});

/* A menu background world, so the first thing you see is the game. */
(function menuBackdrop() {
  const seed = hashString('CHROMEWOOD-TITLE');
  const backdropSim = { world: null };
  import('./world/worldgen.js').then(({ World }) => {
    const world = new World(seed);
    game.menuView = new WorldView(world, rig.scene);
    const lm = world.landmarks.find(l => l.kind === 'beacon');
    cam.snapTo(lm.x + 6, lm.y, lm.z + 6);
    cam.setZoom(11);
    game.menuView.buildAllNear({ x: lm.x, z: lm.z }, 2);
    rig.setTime(DAY.dayLength * 0.80);   /* a long golden dusk */
  });
})();

menus.open('main');
requestAnimationFrame(frame);

window.__ready = true;
window.__game = game;
/* Handles for the headless harness that screenshots the game. */
game.__setZoom = (z) => cam.setZoom(z);
game.__camera = cam;
game.__pipeline = pipeline;
