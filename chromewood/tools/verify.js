#!/usr/bin/env node
/* ============================================================
   verify.js - does the game still work?

   Three things that are easy to break and expensive to notice
   only when someone is playing:

     1. the content tables refer to each other correctly, and
        every ability is actually reachable from the skill tree;
     2. a generated world is connected - you can walk from the
        beacon to essentially all of it - and has the landmarks
        and the biome spread a run needs;
     3. a full run simulates for half an hour without producing
        a NaN, throwing, or grinding to a halt.

     node tools/verify.js [--seeds 6] [--minutes 30]
   ============================================================ */

import { World, FLAG, PROP, SOLID_PROPS, HARVESTABLE } from '../src/world/worldgen.js';
import { Sim, PHASE } from '../src/game/sim.js';
import { SKILLS, ABILITIES, ENEMIES, BEACON_UPGRADES, SKILL_BRANCHES, PRIMARY_ID } from '../src/game/defs.js';
import { encodeSnapshot, decodeInput, encodeInput, PROTOCOL_VERSION } from '../src/net/protocol.js';
import { Mirror } from '../src/net/mirror.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : fallback;
};
const SEEDS = arg('seeds', 6);
const MINUTES = arg('minutes', 30);

let failures = 0;
const ok = (label, extra = '') => console.log(`  ok    ${label}${extra ? '  ' + extra : ''}`);
const bad = (label, why) => { failures++; console.log(`  FAIL  ${label}\n        ${why}`); };
const check = (cond, label, why) => (cond ? ok(label) : bad(label, why));

/* ----------------------------------------------------- 1. content */
console.log('\ncontent tables');
{
  let broken = [];
  for (const [key, s] of Object.entries(SKILLS)) {
    if (s.req && !SKILLS[s.req]) broken.push(`${key} requires missing node ${s.req}`);
    if (s.unlock && !ABILITIES[s.unlock]) broken.push(`${key} unlocks missing ability ${s.unlock}`);
    if (!SKILL_BRANCHES.some(b => b.id === s.branch)) broken.push(`${key} is in unknown branch ${s.branch}`);
    if (!(s.cost > 0)) broken.push(`${key} costs nothing`);
    if (!s.desc) broken.push(`${key} has no description`);
  }
  check(!broken.length, 'skill tree references resolve', broken.join('; '));

  /* Every node must be reachable by walking up its requirements. */
  const reachable = [];
  for (const [key, s] of Object.entries(SKILLS)) {
    let cur = s, hops = 0;
    while (cur && cur.req && hops++ < 20) cur = SKILLS[cur.req];
    if (hops >= 20) reachable.push(key);
  }
  check(!reachable.length, 'no cycles in the skill tree', 'cycle through ' + reachable.join(', '));

  const unlocked = new Set(Object.values(SKILLS).filter(s => s.unlock).map(s => s.unlock));
  const orphan = Object.keys(ABILITIES).filter(a => a !== PRIMARY_ID && !unlocked.has(a));
  check(!orphan.length, 'every ability is unlockable', 'unreachable: ' + orphan.join(', '));

  const badEnemy = Object.entries(ENEMIES)
    .filter(([, e]) => !(e.hp > 0 && e.speed > 0 && e.cost > 0 && e.xp > 0 && e.height > 0))
    .map(([k]) => k);
  check(!badEnemy.length, 'enemy stats are sane', badEnemy.join(', '));

  const badUpgrade = Object.entries(BEACON_UPGRADES).filter(([, u]) => {
    for (let l = 0; l < u.max; l++) {
      const c = u.cost(l);
      if (!c || !Object.values(c).every(v => v > 0)) return true;
      if (typeof u.desc(l) !== 'string') return true;
    }
    return false;
  }).map(([k]) => k);
  check(!badUpgrade.length, 'beacon upgrades price every level', badUpgrade.join(', '));
}

/* ------------------------------------------------------ 2. worlds */
console.log('\nworld generation');
{
  const stats = [];
  for (let i = 0; i < SEEDS; i++) {
    const seed = 1000 + i * 7919;
    const t0 = Date.now();
    const w = new World(seed);
    const genMs = Date.now() - t0;

    /* Flood fill from the beacon over everything a player could
       walk, and compare with the open tiles inside the rim. */
    const size = w.size;
    const seen = new Uint8Array(size * size);
    const start = [Math.floor(size / 2), Math.floor(size / 2)];
    const stack = [start];
    seen[w.idx(start[0], start[1])] = 1;
    let reached = 0;
    while (stack.length) {
      const [x, y] = stack.pop();
      reached++;
      const h = w.height[w.idx(x, y)];
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + ox, ny = y + oy;
        if (!w.inBounds(nx, ny)) continue;
        const j = w.idx(nx, ny);
        if (seen[j] || (w.flags[j] & FLAG.SOLID)) continue;
        if (Math.abs(w.height[j] - h) >= 2) continue;
        seen[j] = 1;
        stack.push([nx, ny]);
      }
    }
    let open = 0;
    for (let k = 0; k < w.flags.length; k++) {
      if (w.flags[k] & (FLAG.SOLID | FLAG.BLOCKED_EDGE)) continue;
      open++;
    }
    const coverage = reached / open;

    const kinds = {};
    for (const lm of w.landmarks) kinds[lm.kind] = (kinds[lm.kind] || 0) + 1;
    const finite = w.landmarks.every(l =>
      Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.z));

    let harvestable = 0;
    for (const p of w.prop) if (HARVESTABLE[p]) harvestable++;

    stats.push({ seed, genMs, coverage, kinds, finite, harvestable, spawns: w.spawnPoints.length });
  }

  const worstCoverage = Math.min(...stats.map(s => s.coverage));
  check(worstCoverage > 0.90, 'the map is walkable from the beacon',
    `worst seed reaches only ${(worstCoverage * 100).toFixed(1)}% of open ground`);

  check(stats.every(s => s.finite), 'landmarks have world coordinates',
    'a landmark is missing x/y/z, which leaves the beacon at NaN');

  check(stats.every(s => s.kinds.beacon === 1 && s.kinds.rift >= 1 && s.kinds.shrine >= 1 && s.kinds.cache >= 1),
    'every world has a beacon, rifts, shrines and caches',
    'seeds missing landmarks: ' + stats.filter(s => !(s.kinds.beacon === 1 && s.kinds.rift >= 1)).map(s => s.seed).join(', '));

  check(stats.every(s => s.harvestable > 300), 'there is enough to salvage',
    'a seed has too few harvestable props: ' + Math.min(...stats.map(s => s.harvestable)));

  check(stats.every(s => s.spawns >= 4), 'spawn points exist', 'a seed has no spawn ring');

  const slowest = Math.max(...stats.map(s => s.genMs));
  check(slowest < 1200, 'generation is fast enough to do at load', `slowest seed took ${slowest}ms`);
  ok('generated', `${SEEDS} seeds, ${slowest}ms worst, ${(worstCoverage * 100).toFixed(1)}% worst coverage`);
}

/* ------------------------------------------------------ 3. a run */
console.log('\nsimulated runs');
{
  for (const players of [1, 4]) {
    const sim = new Sim(20260921, { difficulty: 1 });
    const bots = [];
    for (let i = 0; i < players; i++) bots.push(sim.addPlayer('p' + i, 'BOT' + i));

    const order = Object.keys(SKILLS);
    const steps = MINUTES * 60 * 60;
    let peak = 0, nan = null, thrown = null;
    const t0 = Date.now();

    for (let i = 0; i < steps && !nan && !thrown; i++) {
      for (const p of bots) {
        if (p.skillPoints > 0) {
          for (const k of order) {
            const s = SKILLS[k];
            if (p.skills[k] || (s.req && !p.skills[s.req]) || s.cost > p.skillPoints) continue;
            sim.learnSkill(p, k);
            break;
          }
        }
        const e = sim._nearestEnemy(p.x, p.z, 30);
        const b = sim.beacon;
        let tx, tz, fire = false;
        if (p.charge < 25) { tx = b.x; tz = b.z; }
        else if (e) {
          fire = true;
          const d = Math.hypot(e.x - p.x, e.z - p.z);
          tx = d < 4 ? p.x * 2 - e.x : e.x;
          tz = d < 4 ? p.z * 2 - e.z : e.z;
        } else if (sim.isNight) { tx = b.x; tz = b.z; }
        else { const a = i * 0.004; tx = b.x + Math.cos(a) * 22; tz = b.z + Math.sin(a) * 22; }
        const dx = tx - p.x, dz = tz - p.z, m = Math.hypot(dx, dz) || 1;
        sim.setInput(p.id, {
          seq: i, mx: dx / m, mz: dz / m,
          ax: e ? e.x : p.x + dx / m, az: e ? e.z : p.z + dz / m,
          fire, dash: i % 150 === 0, abil: i % 40 === 0 ? 1 << (i / 40 % 4 | 0) : 0, interact: true,
        });
      }
      if (i % 240 === 0) for (const k of Object.keys(BEACON_UPGRADES)) sim.buyBeaconUpgrade(k);

      try { sim.step(1 / 60); sim.drainEvents(); }
      catch (err) { thrown = `${err.message} at step ${i}`; break; }

      peak = Math.max(peak, sim.enemies.length);
      for (const p of bots) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.z) || !Number.isFinite(p.hp) || !Number.isFinite(p.charge)) {
          nan = `${p.name} went non-finite at step ${i} (x=${p.x} z=${p.z} hp=${p.hp} charge=${p.charge})`;
          break;
        }
      }
      for (const e of sim.enemies) {
        if (!Number.isFinite(e.x) || !Number.isFinite(e.hp)) { nan = `enemy ${e.type} went non-finite at step ${i}`; break; }
      }
      if (!Number.isFinite(sim.beacon.hp)) nan = `beacon hp went non-finite at step ${i}`;
      if (sim.phase !== PHASE.RUNNING) break;
    }

    const ms = Date.now() - t0;
    const usPerStep = (ms / steps) * 1000;
    const label = `${players}-player run`;
    if (thrown) bad(label, thrown);
    else if (nan) bad(label, nan);
    else {
      const totalKills = bots.reduce((a, b) => a + b.kills, 0);
      const progressed = sim.night >= 2 && totalKills > 10 && bots.some(b => b.level > 2);
      if (!progressed) {
        bad(label, `the run did not progress: night ${sim.night}, ${totalKills} kills, level ${bots[0].level}`);
      } else {
        ok(label, `night ${sim.night}, lvl ${bots.map(b => b.level).join('/')}, ${totalKills} kills, ` +
          `peak ${peak} enemies, ${usPerStep.toFixed(1)}us/step`);
      }
      if (usPerStep > 400) bad(label + ' performance', `${usPerStep.toFixed(0)}us per step leaves no room for rendering`);
    }
  }
}

/* -------------------------------------------- 4. the wire format */
console.log('\nnetwork protocol');
{
  const sim = new Sim(4242);
  sim.addPlayer('h', 'HOST');
  sim.addPlayer('c', 'CLIENT');
  for (let i = 0; i < 8; i++) sim.spawnEnemy(i % 2 ? 'husk' : 'spark', i === 0, { x: 4 + i, z: 2 });
  for (let i = 0; i < 400; i++) { sim.step(1 / 60); sim.drainEvents(); }

  let snap, json;
  try {
    snap = encodeSnapshot(sim);
    json = JSON.stringify(snap);
  } catch (e) { bad('snapshot encodes', e.message); }

  if (json) {
    const mirror = new Mirror(4242, 'c');
    let applyErr = null;
    try {
      /* Two snapshots with a full interval between them, so the
         interpolator is measured in its steady state rather than
         mid-way through its very first blend. */
      mirror.applySnapshot(JSON.parse(json));
      mirror.update(1 / 16, null);
      mirror.applySnapshot(JSON.parse(json));
      mirror.update(1 / 16, null);
    } catch (e) { applyErr = e.message; }
    check(!applyErr, 'a client can apply a snapshot', applyErr);

    const hostPlayer = sim.players.get('h');
    const seen = mirror.players.get('h');
    check(seen && Math.abs(seen.x - hostPlayer.x) < 0.02 && Math.abs(seen.hp - hostPlayer.hp) < 0.5,
      'the mirrored player matches the host',
      seen ? `host at ${hostPlayer.x.toFixed(2)} seen at ${seen.x.toFixed(2)}` : 'player missing from the mirror');
    check(mirror.enemies.length === snap.E.length, 'every enemy arrives',
      `${snap.E.length} sent, ${mirror.enemies.length} rebuilt`);
    check(Math.abs(mirror.beacon.hp - sim.beacon.hp) < 0.5, 'beacon state arrives', '');

    const bytes = json.length;
    const perSecond = bytes * 16;
    check(perSecond < 400 * 1024, 'snapshots fit in a sensible amount of bandwidth',
      `${(perSecond / 1024).toFixed(0)} KB/s at 16Hz`);
    ok('snapshot size', `${bytes} bytes with ${snap.E.length} enemies, ~${(perSecond / 1024).toFixed(0)} KB/s`);
  }

  const input = { seq: 7, mx: 0.5, mz: -0.25, ax: 3.5, az: -1.25, fire: true, dash: false, interact: true, abil: 5 };
  const round = decodeInput(encodeInput(input));
  check(round.seq === 7 && round.fire && !round.dash && round.interact && round.abil === 5
    && Math.abs(round.mx - 0.5) < 0.01,
    'input survives the round trip', JSON.stringify(round));
  ok('protocol version', String(PROTOCOL_VERSION));
}

console.log('');
if (failures) {
  console.log(`${failures} check${failures === 1 ? '' : 's'} failed\n`);
  process.exit(1);
}
console.log('all checks passed\n');
