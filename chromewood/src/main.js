/* ============================================================
   main.js - the game

   Boots the renderer, owns the loop, and switches between three
   roles the rest of the code barely notices:

     solo    - a Sim right here, nothing on the wire
     host    - the same Sim, publishing snapshots to a room
     client  - a Mirror fed by someone else's snapshots

   Everything downstream reads a world-shaped object and cannot
   tell which of the three it got.
   ============================================================ */

import * as THREE from '../vendor/three.module.js';

import { PixelPipeline, LAYER_WORLD, LAYER_NO_OUTLINE } from './render/pipeline.js';
import { IsoCamera } from './render/camera.js';
import { SceneRig } from './render/scene.js';
import { WorldView } from './render/worldview.js';
import { Actor, PLAYER_COLORS, ALL_CREATURES } from './render/actors.js';
import { FxSystem } from './render/fx.js';
import { MeshBuilder } from './render/geom.js';
import { makeToonMaterial } from './render/materials.js';
import { buildStructureMesh, makeGhostMaterial } from './render/buildings.js';
import { TEX } from './render/textures.js';

import { Sim, PHASE, ARC, emptyInput } from './game/sim.js';
import { ITEMS, BUILDINGS } from './game/items.js';
import { allRecipes, stationsNear, startCraft, eat, canPlace, heldItem, invCount } from './game/survival.js';

import { Mirror } from './net/mirror.js';
import { RoomClient } from './net/client.js';
import { encodeSnapshot, encodeInput, decodeInput, filterEvents } from './net/protocol.js';

import { Input } from './core/input.js';
import { Audio } from './core/audio.js';
import { hashString } from './core/rng.js';
import { NET, DAY, RESONANCE, SURVIVAL, TILE } from './core/config.js';
import { clamp, clamp01, damp, lerp, TAU } from './core/util.js';

import { Hud } from './ui/hud.js';
import { Panels } from './ui/panels.js';
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
  role: 'menu', sim: null, view: null, net: null, localId: null,
  paused: false, running: false, over: false,
  actors: new Map(), buildingViews: new Map(), decor: null,
  colorByPlayer: new Map(),
  inputSeq: 0, inputAccum: 0, snapAccum: 0, pendingEvents: [],
  difficulty: 1, seedText: 'MOSSGATE', name: 'RUNNER',
  stations: new Set(['hand']),
  ghost: null,
};

const panels = new Panels(hud, {
  useItem: (id) => useItem(id),
  craft: (index) => doCraft(index),
  setBuild: (key) => setBuildKey(key),
  learnSkill: (key) => requestLearnSkill(key),
  buyUpgrade: (key) => requestBuyUpgrade(key),
});

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
    game.sim.addPlayer('local', game.name);
    game.colorByPlayer.set('local', 0);
    beginWorld(seed, 'solo');
    menus.setNetStat('<span class="good">SOLO</span>');
    return;
  }

  const net = new RoomClient();
  game.net = net;
  menus.setNetStat('<span class="warn">CONNECTING…</span>');
  let welcome;
  try {
    welcome = await net.connect({
      server: form.server, room: form.room, name: game.name,
      host: role === 'host', seed: game.seedText, difficulty: game.difficulty,
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
    menus.addChat('a runner left', '#ffb03a');
  });
  net.on('hostchange', (msg) => {
    if (msg.id === net.id && game.role === 'client') {
      const seed = seedFrom(game.seedText);
      game.sim = new Sim(seed, { difficulty: game.difficulty });
      game.sim.addPlayer(net.id, game.name);
      for (const peer of net.peers.values()) game.sim.addPlayer(peer.id, peer.name);
      assignColors();
      beginWorld(seed, 'host');
      broadcastRoster();
      hud.showToast('HOST MIGRATED', '#ffb03a');
    }
  });
  net.on('msg', (msg) => handleNetMessage(msg.from, msg.d));
  net.on('close', ({ wasOpen }) => {
    menus.setNetStat('<span class="bad">DISCONNECTED</span>');
    if (wasOpen) hud.showToast('CONNECTION LOST', '#ff5a5a', 5);
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
      case 'act': applyRemoteAction(from, d); break;
      case 'chat': relayChat(from, d.text); break;
      default: break;
    }
  } else {
    switch (d.k) {
      case 'S': game.sim.applySnapshot(d); menus.setNetStat(pingLabel()); break;
      case 'EV': for (const ev of d.e) consumeEvent(ev); break;
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

/* Clients cannot touch the world directly, so everything that is
   not movement travels as a named action the host performs. */
function applyRemoteAction(from, d) {
  const sim = game.sim;
  const p = sim.players.get(from);
  if (!p) return;
  switch (d.a) {
    case 'craft': startCraft(sim, p, d.i); break;
    case 'skill': sim.learnSkill(p, d.key); break;
    case 'upgrade': sim.buyBeaconUpgrade(d.key); break;
    case 'build': p.buildKey = d.key; break;
    case 'slot': p.hotbarIndex = clamp(d.i | 0, 0, p.hotbar.length - 1); break;
    case 'eat': eat(sim, p, d.item); break;
    case 'hold': {
      const idx = p.hotbar.indexOf(d.item);
      if (idx >= 0) p.hotbarIndex = idx;
      else {
        p.hotbar[p.hotbarIndex] = d.item;
      }
      break;
    }
    default: break;
  }
}

function sendAction(obj) {
  if (game.role === 'client') game.net.sendTo(hostId(), { k: 'act', ...obj });
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
  if (game.menuView) { game.menuView.dispose(); game.menuView = null; }
  game.view = new WorldView(game.sim.world, rig.scene);
  buildDecor();

  const me = localPlayer();
  const start = me || game.sim.beacon;
  cam.snapTo(start.x, start.y, start.z);
  game.view.buildAllNear({ x: start.x, z: start.z }, 3);
  rig.setTime(game.sim.dayTime);
  menus.close();
  panels.close();
  hud.showToast('CHROMEWOOD', '#b07bff', 4, 'you have nothing. start with a tree.');
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
  clearBuildingViews();
  if (game.view) { game.view.dispose(); game.view = null; }
  if (game.decor) { rig.scene.remove(game.decor.group); game.decor = null; }
  if (game.ghost) { rig.scene.remove(game.ghost.mesh); game.ghost = null; }
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
function buildDecor() {
  const group = new THREE.Group();
  const glowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
  const solidMat = makeToonMaterial({ vertexColors: true, rim: 1.3 });

  const coreB = new MeshBuilder();
  coreB.at(0, 0, 0).crystal(0.34, 1.1, 0xb07bff, { sides: 6, tipColor: 0xf0e6ff, tex: TEX.CRYSTAL });
  const core = new THREE.Mesh(coreB.build(), solidMat);
  core.layers.set(LAYER_WORLD); core.castShadow = true;

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
  for (const g of game.sim.gates) {
    const rb = new MeshBuilder();
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      rb.at(Math.cos(a) * 1.0, 0, Math.sin(a) * 1.0).rot(a);
      rb.box(0.3, 0.06, 0.06, 0xff4fd8, { centered: true });
    }
    rb.rot(0);
    const m = new THREE.Mesh(rb.build(), glowMat);
    m.layers.set(LAYER_WORLD);
    m.position.set(g.x, g.y + 1.35, g.z);
    group.add(m);
    riftRings.push({ mesh: m, gate: g });
  }

  rig.scene.add(group);
  game.decor = { group, core, halo, ring, riftRings, t: 0 };
}

function updateDecor(dt, sim) {
  const d = game.decor;
  if (!d) return;
  d.t += dt;
  const b = sim.beacon;
  const lit = b.lit;
  const health = lit ? clamp01(b.hp / b.maxHp) : 0;
  const lift = 2.55 + Math.sin(d.t * 0.9) * 0.14;
  d.core.position.set(b.x, b.y + (lit ? lift : 1.9), b.z);
  d.core.rotation.y = lit ? d.t * 0.5 : 0;
  /* Dark and fallen before it is repaired: the state of the beacon
     should be obvious from across the valley. */
  d.core.rotation.z = lit ? 0 : 0.55;
  d.halo.visible = lit;
  d.ring.visible = lit;
  if (lit) {
    d.halo.position.set(b.x, b.y + lift + 0.08, b.z);
    d.halo.rotation.y = -d.t * 0.8;
    const pulse = 0.65 + 0.35 * Math.sin(d.t * (health < 0.35 ? 8 : 2.2));
    d.halo.scale.setScalar(lerp(0.6, 1.05, health) * pulse);
    d.ring.position.set(b.x, b.y + 0.62, b.z);
    d.ring.rotation.y = -d.t * 0.35;
    rig.addDynamicLight(b.x, b.y + lift, b.z, health > 0.35 ? 0xb07bff : 0xff4f6b, 3.0 + pulse, 17);
  }

  for (const r of d.riftRings) {
    r.mesh.visible = !r.gate.sealed;
    if (!r.mesh.visible) continue;
    r.mesh.rotation.y = d.t * (r.gate.active ? 2.4 : 0.5);
    r.mesh.rotation.x = Math.sin(d.t * 0.6) * 0.22;
    r.mesh.scale.setScalar(1 + Math.sin(d.t * 2) * 0.06 + (r.gate.active ? r.gate.progress * 0.4 : 0));
    rig.addDynamicLight(r.gate.x, r.gate.y + 1.6, r.gate.z, 0xff4fd8, r.gate.active ? 4 : 2, 12);
  }
}

/* ---------------------------------------------------------- actors */
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
    /* A carried torch lights the ground around you. */
    if (p.lightItem) {
      rig.addDynamicLight(p.x, p.y + 1.0, p.z, p.lightItem.color, p.lightItem.intensity, p.lightItem.range);
    }
    idx++;
  }

  for (const e of sim.enemies) {
    if (e.spawnFade > 0) continue;
    const key = actorKey('e', e.id);
    live.add(key);
    let a = game.actors.get(key);
    if (!a) { a = new Actor(rig.scene, e.type, 0); game.actors.set(key, a); }
    a.setVisible(true);
    a.update(dt, e, { scale: e.elite ? 1.25 : 1, shadowRadius: e.def.radius * 2.8 });
    if (e.elite || e.boss) {
      rig.addDynamicLight(e.x, e.y + e.def.height * 0.6, e.z,
        e.def.accent, e.boss ? 3.0 : 1.4, e.boss ? 12 : 6);
    }
  }

  for (const w of sim.animals) {
    const key = actorKey('a', w.id);
    live.add(key);
    let a = game.actors.get(key);
    if (!a) { a = new Actor(rig.scene, w.type, 0); game.actors.set(key, a); }
    a.setVisible(true);
    a.update(dt, w, { shadowRadius: w.def.radius * 2.6 });
    if (w.def.glow) rig.addDynamicLight(w.x, w.y + 0.6, w.z, w.def.color, 1.1, 5);
  }

  for (const [key, a] of game.actors) {
    if (!live.has(key)) { a.dispose(); game.actors.delete(key); }
  }
}

function clearActors() {
  for (const a of game.actors.values()) a.dispose();
  game.actors.clear();
}

/* -------------------------------------------------------- buildings */
let buildSolidMat = null, buildGlowMat = null;

function syncBuildings(dt, sim, time) {
  if (!buildSolidMat) {
    buildSolidMat = makeToonMaterial({ vertexColors: true, rim: 1.0 });
    buildGlowMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, fog: false });
  }
  const live = new Set();
  for (const b of sim.buildings) {
    live.add(b.id);
    let view = game.buildingViews.get(b.id);
    /* Rebuild only when something about the look actually changed. */
    const stateKey = `${b.open ? 1 : 0}:${b.def.seal ? Math.floor((b.progress || 0) * 12) : 0}`;
    if (!view || view.stateKey !== stateKey) {
      if (view) {
        rig.scene.remove(view.group);
        view.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
      }
      const sb = new MeshBuilder(), gb = new MeshBuilder();
      const gate = sim.gates && sim.gates.find(g => Math.abs(g.x - b.x) < 2 && Math.abs(g.z - b.z) < 2);
      buildStructureMesh(sb, gb, b.key, 0, 0, 0, {
        open: b.open, t: 0, angle: 0, progress: gate ? gate.progress : 0,
      });
      const group = new THREE.Group();
      if (!sb.isEmpty) {
        const m = new THREE.Mesh(sb.build(), buildSolidMat);
        m.castShadow = true; m.receiveShadow = true;
        m.layers.set(LAYER_WORLD);
        group.add(m);
      }
      if (!gb.isEmpty) {
        const c = gb.col;
        for (let i = 0; i < c.length; i++) c[i] *= 2.6;
        const m = new THREE.Mesh(gb.build(), buildGlowMat);
        m.layers.set(LAYER_WORLD);
        group.add(m);
      }
      group.position.set(b.x, b.y, b.z);
      rig.scene.add(group);
      view = { group, stateKey };
      game.buildingViews.set(b.id, view);
    }
    if (b.def.turret) view.group.rotation.y = -(b.angle || 0) + Math.PI / 2;
    if (b.def.light) {
      rig.addDynamicLight(b.x, b.y + (b.def.height || 1) * 0.8, b.z,
        b.def.light.color, b.def.light.intensity, b.def.light.range);
    }
  }
  for (const [id, view] of game.buildingViews) {
    if (live.has(id)) continue;
    rig.scene.remove(view.group);
    view.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
    game.buildingViews.delete(id);
  }
}

function clearBuildingViews() {
  for (const view of game.buildingViews.values()) {
    rig.scene.remove(view.group);
    view.group.traverse(o => { if (o.geometry) o.geometry.dispose(); });
  }
  game.buildingViews.clear();
}

/* The translucent preview of what you are about to place. */
function updateGhost(sim, me) {
  if (!me || !me.buildKey || !BUILDINGS[me.buildKey]) {
    if (game.ghost) { game.ghost.mesh.visible = false; }
    return;
  }
  const w = sim.world;
  const tx = w.worldToTileX(me.aimX), ty = w.worldToTileZ(me.aimZ);
  const key = `${me.buildKey}`;
  if (!game.ghost || game.ghost.key !== key) {
    if (game.ghost) { rig.scene.remove(game.ghost.mesh); game.ghost.mesh.geometry.dispose(); }
    const sb = new MeshBuilder(), gb = new MeshBuilder();
    buildStructureMesh(sb, gb, me.buildKey, 0, 0, 0, { open: false, progress: 0 });
    const mesh = new THREE.Mesh(sb.build(), makeGhostMaterial(true));
    mesh.layers.set(LAYER_NO_OUTLINE);
    mesh.renderOrder = 3;
    rig.scene.add(mesh);
    game.ghost = { key, mesh };
  }
  const g = game.ghost;
  g.mesh.visible = true;
  g.mesh.position.set(w.tileToWorldX(tx), w.heightAtTile(tx, ty) + 0.02, w.tileToWorldZ(ty));
  /* canPlace returns a reason, or null when the spot is fine. */
  const ok = game.role === 'client' || !canPlace(sim, me, me.buildKey, tx, ty);
  g.mesh.material.color.set(ok ? 0x63ff9d : 0xff5a5a);
}

/* ----------------------------------------------- pickups on the floor */
const pickupPool = { free: [], live: [] };
let pickupGeo = null;
const pickupMats = new Map();

function pickupMaterial(tint) {
  let m = pickupMats.get(tint);
  if (!m) {
    m = new THREE.MeshBasicMaterial({ color: new THREE.Color(tint).multiplyScalar(1.8),
      toneMapped: false, fog: false });
    pickupMats.set(tint, m);
  }
  return m;
}

function syncPickups(dt, sim, time) {
  if (!pickupGeo) {
    const b = new MeshBuilder();
    b.at(0, 0, 0).box(0.24, 0.24, 0.24, 0xffffff, { centered: true });
    pickupGeo = b.build();
  }
  while (pickupPool.live.length > sim.pickups.length) {
    const m = pickupPool.live.pop();
    m.visible = false;
    pickupPool.free.push(m);
  }
  while (pickupPool.live.length < sim.pickups.length) {
    let m = pickupPool.free.pop();
    if (!m) {
      m = new THREE.Mesh(pickupGeo, pickupMaterial(0xffffff));
      m.layers.set(LAYER_WORLD);
      rig.scene.add(m);
    }
    m.visible = true;
    pickupPool.live.push(m);
  }
  for (let i = 0; i < sim.pickups.length; i++) {
    const pk = sim.pickups[i];
    const def = ITEMS[pk.item];
    const m = pickupPool.live[i];
    m.material = pickupMaterial(def ? def.tint : 0xcccccc);
    m.position.set(pk.x, pk.y + Math.sin(time * 3 + i) * 0.07, pk.z);
    m.rotation.set(0.5, time * 1.6 + i, 0.4);
  }
}

const constructPool = { free: [], live: [] };
let constructGeo = null, constructMat = null;

function syncConstructs(dt, sim, time) {
  if (!constructGeo) {
    const b = new MeshBuilder();
    b.at(0, 0, 0).taper(0.44, 0.32, 0.44, 0.7, 0x5c6470, { topColor: 0x8a93a1, tex: TEX.METAL });
    b.at(0, 0.32, 0).box(0.20, 0.20, 0.20, 0x7d8694, { topColor: 0xa3acba, tex: TEX.PANEL });
    b.at(0.22, 0.38, 0).box(0.34, 0.09, 0.09, 0x3e4550, { centered: true, tex: TEX.METAL });
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
    case 'swing': audio.swing ? audio.swing() : audio.dash(); break;
    case 'impact': audio.hit(false); break;
    case 'dmg': if (ev.crit) audio.hit(true); break;
    case 'boom': audio.boom(clamp(ev.radius / 4, 0.6, 2)); break;
    case 'cast': audio.cast(); break;
    case 'dash': audio.dash(); break;
    case 'pickup': audio.pickup(ev.item); break;
    case 'prop_break': audio.breakProp(); break;
    case 'crafted': {
      audio.ui();
      if (ev.id === game.localId) {
        const d = ITEMS[ev.item];
        hud.pushKill(`MADE ${d ? d.name.toUpperCase() : ev.item}`, '#ffd24a');
      }
      break;
    }
    case 'built': audio.ui(); break;
    case 'toolneeded':
      if (ev.id === game.localId) {
        audio.ui('deny');
        hud.showToast(`NEEDS A BETTER ${ev.need.toUpperCase()}`, '#ff8a5a', 1.8);
      }
      break;
    case 'buildfail':
      if (ev.id === game.localId) {
        audio.ui('deny');
        hud.showToast(BUILD_FAIL[ev.why] || 'CANNOT BUILD THERE', '#ff8a5a', 1.4);
      }
      break;
    case 'craftfail':
      if (ev.id === game.localId) audio.ui('deny');
      break;
    case 'levelup':
      if (ev.id === game.localId) { audio.levelUp(); hud.showToast(`LEVEL ${ev.level}`, '#ffd24a', 2.4, 'a skill point'); }
      break;
    case 'hurt': if (ev.id === game.localId) audio.hurt(); break;
    case 'down': audio.down(); hud.pushKill(`${nameOf(ev.id)} IS DOWN`, '#ff6b6b'); break;
    case 'die': hud.pushKill(`${nameOf(ev.id)} DIED`, '#ff5a5a'); break;
    case 'revive': hud.pushKill(`${nameOf(ev.id)} IS BACK UP`, '#63ff9d'); break;
    case 'kill':
      if (ev.boss) hud.showToast(`${(ALL_CREATURES[ev.type] || {}).name || 'BOSS'} DOWN`, '#ff8ae0', 4);
      else if (ev.elite) hud.pushKill(`ELITE DOWN`, '#ffb03a');
      break;
    case 'nightfall':
      audio.nightfall();
      hud.showToast(ev.name, ev.color, 4.5, ev.blurb);
      break;
    case 'dawn':
      audio.dawn();
      hud.showToast('DAWN', '#ffd98a', 3, `${ev.night} night${ev.night === 1 ? '' : 's'} held`);
      break;
    case 'weather':
      if (ev.id !== 'clear') hud.showToast(ev.name.toUpperCase(), '#9fd8ff', 3, ev.blurb);
      break;
    case 'beacon_lit':
      audio.levelUp();
      hud.showToast('THE BEACON IS LIT', '#b07bff', 6, 'your core is awake — press K');
      break;
    case 'seal_start': hud.showToast('HOLD THE GATE', '#7ee8ff', 4, 'it will not seal itself'); break;
    case 'seal_done':
      hud.showToast('GATE SEALED', '#63ff9d', 5, `${ev.sealed} down — the nights get quieter`);
      break;
    case 'heart_wakes':
      hud.showToast('THE RIFT HEART WAKES', '#ff4fd8', 7, 'it is at the beacon');
      break;
    case 'contract': hud.pushKill(`CONTRACT: ${ev.name.toUpperCase()}`, '#ffd24a'); break;
    case 'boon': if (ev.id === game.localId) hud.showToast(`BOON: ${ev.name.toUpperCase()}`, '#7ee8ff'); break;
    case 'cache': hud.showToast('CACHE OPENED', '#ffb03a', 2); break;
    case 'deposit': if (ev.id === game.localId) hud.pushKill(`STORED ${ev.moved}`, '#3fe0ff'); break;
    case 'won': game.over = true; break;
    case 'beacon_down': game.over = true; hud.showToast('THE BEACON IS DARK', '#ff4f4f', 6); break;
    default: break;
  }
}

const BUILD_FAIL = {
  occupied: 'SOMETHING IS ALREADY THERE', water: 'NOT IN THE WATER',
  blocked: 'CLEAR THE GROUND FIRST', far: 'TOO FAR AWAY',
  uneven: 'THE GROUND IS TOO STEEP', materials: 'NOT ENOUGH MATERIALS',
  needs: 'YOU NEED A STATION NEARBY',
};

function nameOf(id) {
  const p = game.sim && game.sim.players.get(id);
  return p ? p.name : 'A RUNNER';
}

/* --------------------------------------------------------- actions */
function doCraft(index) {
  const me = localPlayer();
  if (!me) return;
  audio.ui();
  if (game.role === 'client') sendAction({ a: 'craft', i: index });
  else startCraft(game.sim, me, index);
}

function setBuildKey(key) {
  const me = localPlayer();
  if (!me) return;
  audio.ui();
  const next = me.buildKey === key ? null : key;
  if (game.role === 'client') sendAction({ a: 'build', key: next });
  else me.buildKey = next;
  if (next) panels.close();
}

function useItem(id) {
  const me = localPlayer();
  if (!me) return;
  const def = ITEMS[id];
  if (!def) return;
  audio.ui();
  if (def.build) { setBuildKey(id); return; }
  if (def.food || def.heal || def.energy) {
    if (game.role === 'client') sendAction({ a: 'eat', item: id });
    else eat(game.sim, me, id);
    return;
  }
  if (game.role === 'client') sendAction({ a: 'hold', item: id });
  else {
    const idx = me.hotbar.indexOf(id);
    if (idx >= 0) me.hotbarIndex = idx;
    else me.hotbar[me.hotbarIndex] = id;
  }
}

function requestLearnSkill(key) {
  const me = localPlayer();
  if (!me) return;
  audio.ui();
  if (game.role === 'client') sendAction({ a: 'skill', key });
  else game.sim.learnSkill(me, key);
}

function requestBuyUpgrade(key) {
  audio.ui();
  if (game.role === 'client') sendAction({ a: 'upgrade', key });
  else game.sim.buyBeaconUpgrade(key);
}

function setSlot(i) {
  const me = localPlayer();
  if (!me) return;
  if (game.role === 'client') sendAction({ a: 'slot', i });
  else me.hotbarIndex = clamp(i, 0, me.hotbar.length - 1);
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
  else relayChat(game.localId, t);
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
  const aim = cam.screenToGround(input.mouse.nx, input.mouse.ny, me.y + 0.35);
  const pad = input.gamepad();
  if (pad && (Math.abs(pad.rx) > 0.2 || Math.abs(pad.ry) > 0.2)) {
    const ad = cam.screenToWorldDir(pad.rx, pad.ry, new THREE.Vector3());
    aim.set(me.x + ad.x * 5, me.y, me.z + ad.z * 5);
  }
  let abil = 0;
  if (input.wasPressed('ability2') || (pad && pad.a2)) abil |= 2;
  if (input.wasPressed('ability3') || (pad && pad.a3)) abil |= 4;
  if (input.wasPressed('ability4') || (pad && pad.a4)) abil |= 8;
  return {
    seq: ++game.inputSeq,
    mx: dir.x, mz: dir.z,
    ax: aim.x, az: aim.z,
    fire: input.firing() && !panels.isOpen,
    dash: input.wasPressed('dash') || (pad && pad.dash),
    interact: input.isDown('interact'),
    sprint: input.isDown('sprint') || (pad && pad.sprint),
    abil,
  };
}

/* ------------------------------------------------------------- loop */
const FIXED = 1 / 60;
let stepAccum = 0;
let last = performance.now();
let frames = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frames++;
  window.__frames = frames;

  handleHotkeys();

  if (!game.running || !game.sim) {
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

  let myInput = null;
  const blocked = game.paused || menus.isOpen || menus.chatOpen || panels.isOpen;
  if (me && !blocked) {
    myInput = gatherInput(me);
    if (game.role === 'client') {
      game.inputAccum += rawDt;
      if (game.inputAccum >= 1 / NET.inputHz) {
        game.inputAccum = 0;
        game.net.sendTo(hostId(), { k: 'in', a: encodeInput(myInput) });
      }
    } else sim.setInput(game.localId, myInput);
  } else if (me && game.role !== 'client') {
    sim.setInput(game.localId, emptyInput());
  }

  if (game.role === 'client') {
    sim.update(dt, myInput);
  } else if (dt > 0) {
    stepAccum += dt;
    let guard = 0;
    while (stepAccum >= FIXED && guard++ < 6) { sim.step(FIXED); stepAccum -= FIXED; }
    for (const ev of sim.drainEvents()) {
      consumeEvent(ev);
      if (game.role === 'host') game.pendingEvents.push(ev);
    }
    if (game.role === 'host') publish(rawDt);
  }

  if (sim.phase !== PHASE.RUNNING && !game.over) game.over = true;
  if (game.over && !menus.isOpen) {
    menus.showOver(sim, game.localId, sim.phase === PHASE.WON);
    game.paused = true;
  }

  const focus = me || sim.beacon;
  const aimPoint = me ? { x: me.aimX, z: me.aimZ } : null;
  cam.update(rawDt, new THREE.Vector3(focus.x, focus.y, focus.z),
    aimPoint ? new THREE.Vector3(aimPoint.x, focus.y, aimPoint.z) : null);
  cam.addShake(fx.drainShake());
  if (input.mouse.wheel && !panels.isOpen) cam.nudgeZoom(input.mouse.wheel * 1.2);
  if (input.isDown('zoomIn')) cam.nudgeZoom(-rawDt * 8);
  if (input.isDown('zoomOut')) cam.nudgeZoom(rawDt * 8);

  rig.setTime(sim.dayTime);
  rig.update(rawDt, cam.smoothed, pipeline.grade, cam.distance, sim.weather);
  audio.setAmbient(rig.nightAmount);

  game.view.update(cam.smoothed, cam.zoom);
  updateDecor(rawDt, sim);
  syncActors(rawDt, sim);
  syncBuildings(rawDt, sim, now / 1000);
  syncPickups(rawDt, sim, now / 1000);
  syncConstructs(rawDt, sim, now / 1000);
  if (me) updateGhost(sim, me);
  fx.syncBolts(sim.projectiles);
  fx.update(rawDt, pipeline.pixelScale);

  for (const l of fx.drainLights()) rig.addDynamicLight(l.x, l.y, l.z, l.color, l.intensity, l.range);
  rig.updatePointLights(game.view.lightSites, cam.smoothed);

  const flash = fx.drainFlash();
  pipeline.grade.flash = Math.max(pipeline.grade.flash * Math.pow(0.001, rawDt), flash);
  pipeline.grade.flashColor.copy(fx.flashColor);
  const downed = me && me.state !== 'alive';
  pipeline.grade.desaturate = damp(pipeline.grade.desaturate, downed ? 0.75 : 0, 4, rawDt);

  pipeline.render(rig.scene, cam.camera, cam.subpixel);

  /* ---- interface ---- */
  hud.update(rawDt);
  if (me) {
    if (game.role !== 'client') game.stations = stationsNear(sim, me);
    const state = {
      sim, me, fx, localId: game.localId,
      stations: game.stations,
      objective: sim.objective ? sim.objective() : null,
      resonanceHere: sim.resonance ? sim.resonance.at(me.x, me.z) : 0,
      aimY: sim.world.groundAt(me.aimX, me.aimZ),
      project: (x, y, z) => {
        const v = new THREE.Vector3(x, y, z).project(cam.camera);
        return {
          x: (v.x * 0.5 + 0.5) * hud.w,
          y: (-v.y * 0.5 + 0.5) * hud.h,
          visible: v.z < 1 && Math.abs(v.x) < 1.15 && Math.abs(v.y) < 1.15,
          behind: v.z >= 1,
        };
      },
    };
    hud.draw(state);
    panels.draw(state);
  }
  menus.renderChat();
  if (game.net && frames % 30 === 0) menus.setNetStat(pingLabel());

  input.endFrame();
}

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
  const me = localPlayer();

  if (input.wasPressed('chat') && game.running && !menus.isOpen && !panels.isOpen) {
    menus.openChat();
    return;
  }
  if (input.wasPressed('pause') && game.running) {
    audio.ui();
    if (panels.isOpen) panels.close();
    else if (menus.isOpen) { menus.close(); game.paused = false; }
    else {
      menus.setPauseInfo(game.role === 'solo'
        ? 'A solo run pauses with you.' : 'Co-op keeps running while this is open.');
      menus.open('pause');
      game.paused = game.role === 'solo';
    }
    return;
  }
  if (!game.running || menus.isOpen) return;

  const toggle = (key, panel) => {
    if (!input.wasPressed(key)) return false;
    audio.ui();
    panels.toggle(panel);
    return true;
  };
  if (toggle('inventory', 'inventory')) return;
  if (toggle('build', 'build')) return;
  if (toggle('skills', 'skills')) return;
  if (toggle('journal', 'journal')) return;

  for (let i = 0; i < 6; i++) {
    if (input.wasPressed('slot' + (i + 1))) { setSlot(i); audio.ui(); }
  }

  /* Q eats the best food you have, which is what the key is for in
     every survival game and saves a trip to the pack. */
  if (input.wasPressed('eat') && me) {
    for (const food of ['stew', 'cookedmeat', 'berries', 'mushroom', 'brew', 'bandage']) {
      if ((me.inv[food] || 0) > 0) { useItem(food); break; }
    }
  }

  if (input.rmbPressed && me && me.buildKey) setBuildKey(me.buildKey);

  if (me && me.interactTarget && me.interactTarget.kind === 'beacon'
      && game.sim.beacon.lit && input.wasPressed('interact') && !panels.isOpen) {
    audio.ui();
    panels.open('beacon');
  }
}

/* --------------------------------------------- pointer into the HUD */
function hudPoint(e) {
  const r = hudCanvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

window.addEventListener('pointermove', (e) => {
  const p = hudPoint(e);
  hud.pointer.x = p.x; hud.pointer.y = p.y;
});

viewCanvas.addEventListener('pointerdown', (e) => {
  audio.resume();
  const p = hudPoint(e);
  hud.pointer.x = p.x; hud.pointer.y = p.y;
  const hit = hud.hitTest(p.x, p.y);
  if (!hit) return;
  if (hit.name === 'hotbar') { setSlot(hit.data); e.preventDefault(); return; }
  if (hit.name.startsWith('touch:')) {
    const which = hit.name.slice(6);
    if (which === 'inv') panels.toggle('inventory');
    else input.setTouchButton(which === 'dash' ? 'dash' : 'interact', 'pressed');
    e.preventDefault();
    return;
  }
  if (panels.handle(hit, null)) { e.preventDefault(); }
});

viewCanvas.addEventListener('wheel', (e) => {
  if (panels.isOpen && panels.wheel(e.deltaY)) e.preventDefault();
}, { passive: false });

document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.role === 'solo' && game.running) {
    game.paused = true;
    if (!menus.isOpen) menus.open('pause');
  }
});

/* A living world behind the title, rather than a flat colour. */
(function menuBackdrop() {
  const seed = hashString('CHROMEWOOD-TITLE');
  import('./world/worldgen.js').then(({ World }) => {
    const world = new World(seed);
    game.menuView = new WorldView(world, rig.scene);
    const lm = world.landmarks.find(l => l.kind === 'beacon');
    cam.snapTo(lm.x + 6, lm.y, lm.z + 6);
    cam.setZoom(11);
    game.menuView.buildAllNear({ x: lm.x, z: lm.z }, 2);
    rig.setTime(DAY.dayLength * 0.80);
  });
})();

menus.open('main');
requestAnimationFrame(frame);

window.__ready = true;
window.__game = game;
game.__setZoom = (z) => cam.setZoom(z);
game.__camera = cam;
game.__pipeline = pipeline;
game.__panels = panels;
game.__hud = hud;
