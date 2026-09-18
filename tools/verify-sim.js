/* Plays a colony headlessly and checks that the colony sim actually
   simulates: colonists take jobs, eat, build what you designate, and the
   world stays internally consistent while they do it.

   Usage: node tools/verify-sim.js [days] [seed]                        */
'use strict';
const { load } = require('./harness.js');

const DAYS = Number(process.argv[2] || 4);
const SEED = Number(process.argv[3] || 20260918);

const sb = load();
const { Game, U, Defs, Regions, Path, Zones, Construct, Production, Jobs, Save } = sb;

const problems = [];
const warnings = [];
const fail = m => problems.push(m);
const warn = m => warnings.push(m);

/* ---------- start a colony ---------- */
Game.newGame({ seed: SEED, size: 90, colonists: 3, biome: 'temperateForest' });
const map = Game.map;
const colonists = map.colonists();
if (colonists.length < 3) fail(`expected 3 colonists, got ${colonists.length}`);
console.log(`map ${map.w}x${map.h}, ${map.things.size} things, ${map.pawns.length} pawns, ` +
            `${colonists.length} colonists, seed ${SEED}`);

/* ---------- give the colony something to do ---------- */
const home = colonists[0] ? { x: colonists[0].x, y: colonists[0].y } : { x: map.w >> 1, y: map.h >> 1 };

function cellsAround(cx, cy, r, filter) {
  const out = [];
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (!map.inBounds(x, y)) continue;
      if (filter && !filter(x, y)) continue;
      out.push(map.idx(x, y));
    }
  }
  return out;
}

const orders = { stockpile: 0, growing: 0, chop: 0, mine: 0, blueprints: 0, bills: 0 };

/* A stockpile next door, so hauling has somewhere to go. */
const stockCells = cellsAround(home.x + 4, home.y, 2, (x, y) => map.passable(x, y) && !map.buildingAt(x, y));
if (stockCells.length) {
  Zones.add(map, 'stockpile', stockCells, { label: 'Main store' });
  orders.stockpile = stockCells.length;
} else fail('nowhere to put a stockpile next to the colonists');

/* A growing zone on whatever soil is nearby. */
const growCells = cellsAround(home.x - 5, home.y, 2, (x, y) => {
  const t = map.terrainAt(x, y);
  return t && t.fertility > 0.5 && map.passable(x, y) && !map.buildingAt(x, y) && !map.plantAt(x, y);
});
if (growCells.length) {
  Zones.add(map, 'growing', growCells, { plantDefId: 'plantRice' });
  orders.growing = growCells.length;
} else warn('no fertile ground near the colonists for a growing zone');

/* Chop some trees and mine some rock. */
for (const t of map.things.values()) {
  if (orders.chop < 6 && t.def && t.def.plant && t.def.plant.isTree && U.cheb(t.x, t.y, home.x, home.y) < 18) {
    map.designate(t.x, t.y, 'chop'); orders.chop++;
  }
  if (orders.mine < 6 && t.def && t.def.mineable && U.cheb(t.x, t.y, home.x, home.y) < 22) {
    map.designate(t.x, t.y, 'mine'); orders.mine++;
  }
}

/* Put up a few walls, which exercises blueprint -> haul -> frame -> build. */
for (let i = 0; i < 6; i++) {
  const x = home.x - 3 + i, y = home.y - 4;
  const can = Construct.canPlace(map, 'wall', x, y, 0);
  if (can && can.ok) {
    if (Construct.placeBlueprint(map, 'wall', x, y, 0, 'wood')) orders.blueprints++;
  }
}

/* And a cooking bill wherever there is something to cook on. */
const benches = ['campfire', 'stove'].flatMap(d => map.byDef(d) || []);
if (benches.length && Production.addBill) {
  const bill = Production.addBill(benches[0], 'cookSimpleMeal', { repeatMode: 'forever' });
  if (bill) orders.bills++;
} else {
  /* No campfire in the starting kit: build one so cooking gets exercised. */
  const spot = cellsAround(home.x, home.y + 3, 2, (x, y) => map.passable(x, y) && !map.buildingAt(x, y))[0];
  if (spot !== undefined) {
    const bp = Construct.placeBlueprint(map, 'campfire', map.xOf(spot), map.yOf(spot), 0, 'wood');
    if (bp) orders.blueprints++;
  }
}
console.log('orders:', JSON.stringify(orders));

/* ---------- run ---------- */
const jobCounts = Object.create(null);
const stats = { idleTicks: 0, workTicks: 0, pathFails: 0, maxReservations: 0, deaths: 0, letters: 0 };
const startThings = map.things.size;

let lastJob = new Map();
const TOTAL = Math.round(DAYS * Game.TICKS_PER_DAY);
const t0 = Date.now();

for (let i = 0; i < TOTAL; i++) {
  try {
    Game.doTick();
  } catch (e) {
    fail(`tick ${Game.tick} threw: ${e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : e}`);
    break;
  }

  if (i % 60 === 0) {
    for (const p of map.colonists()) {
      const id = p.job && p.job.defId;
      if (id) {
        stats.workTicks++;
        if (lastJob.get(p.id) !== id) { jobCounts[id] = (jobCounts[id] || 0) + 1; lastJob.set(p.id, id); }
      } else {
        stats.idleTicks++;
        lastJob.delete(p.id);
      }
    }
    const res = map.__reservations ? map.__reservations.size : 0;
    if (res > stats.maxReservations) stats.maxReservations = res;
  }

  if (i % 10000 === 0 && i) {
    const alive = map.colonists().filter(p => !p.dead).length;
    console.log(`  day ${(Game.tick / Game.TICKS_PER_DAY).toFixed(2)}  colonists ${alive}  ` +
                `things ${map.things.size}  jobs ${Object.keys(jobCounts).length} kinds`);
  }
}
const elapsed = (Date.now() - t0) / 1000;
const ticksPerSec = Math.round(TOTAL / elapsed);

/* ---------- what happened ---------- */
const alive = map.colonists().filter(p => !p.dead);
const jobKinds = Object.keys(jobCounts).sort((a, b) => jobCounts[b] - jobCounts[a]);
console.log(`\nran ${TOTAL} ticks (${DAYS} days) in ${elapsed.toFixed(1)}s — ${ticksPerSec} ticks/s`);
console.log(`colonists alive: ${alive.length}/${colonists.length}`);
console.log(`jobs taken: ${jobKinds.map(k => `${k} x${jobCounts[k]}`).join(', ') || 'NONE'}`);
console.log(`idle sampling: ${(100 * stats.idleTicks / Math.max(1, stats.idleTicks + stats.workTicks)).toFixed(0)}% idle`);
console.log(`things ${startThings} -> ${map.things.size}, letters ${Game.letters.length}, ` +
            `messages ${Game.messages.length}, peak reservations ${stats.maxReservations}`);
if (Path.debugStats) console.log('path:', JSON.stringify(Path.debugStats()));

/* ---------- assertions ---------- */
if (!alive.length) fail('every colonist died within ' + DAYS + ' days of doing nothing dangerous');
if (jobKinds.length < 4) fail(`colonists only ever did ${jobKinds.length} kinds of job: ${jobKinds.join(', ')}`);
if (stats.idleTicks > stats.workTicks) warn('colonists were idle more often than they were working');

const needsWatch = ['haul', 'sow', 'construct', 'mine', 'chopWood', 'doBill', 'eat', 'sleep'];
needsWatch.forEach(j => { if (!jobCounts[j]) warn(`nobody ever did a "${j}" job`); });

/* Did the orders actually get carried out? */
const stock = map.zones.find(z => z.kind === 'stockpile');
if (stock) {
  let stored = 0;
  stock.cells.forEach(i => { stored += map.itemsIdx(i).length; });
  if (!stored) warn('nothing was ever hauled into the stockpile');
  else console.log(`stockpile holds ${stored} stacks`);
}
const builtWalls = (map.byDef('wall') || []).length;
if (orders.blueprints && !builtWalls) warn('no blueprint was ever finished into a building');

/* Needs must be being met: nobody should be sitting at zero food for days. */
alive.forEach(p => {
  if (p.needs.food <= 0.01) warn(`${p.name && p.name.first} is starving at the end of the run`);
  if (p.needs.rest <= 0.01) warn(`${p.name && p.name.first} is collapsing from exhaustion`);
});

/* World integrity: grids and the thing registry must still agree. */
let ghosts = 0, overfull = 0, orphans = 0;
for (const t of map.things.values()) {
  if (!t.spawned) continue;
  if (!map.inBounds(t.x, t.y)) { orphans++; continue; }
  if (t.isItem && t.isItem() && t.stack > t.def.stackLimit) overfull++;
  if (t.category === 'building' && map.buildingId[map.idx(t.x, t.y)] !== t.id && !t.isBlueprint) ghosts++;
}
if (ghosts) fail(`${ghosts} building(s) are in the registry but not in the building grid`);
if (overfull) fail(`${overfull} item stack(s) exceed their stackLimit`);
if (orphans) fail(`${orphans} thing(s) are spawned outside the map`);
if (stats.maxReservations > map.pawns.length * 6 + 40) {
  fail(`reservations leaked: peaked at ${stats.maxReservations} for ${map.pawns.length} pawns`);
}

/* Save round trip. */
if (Save && Save.selfTest) {
  const r = Save.selfTest(Game);
  if (r && r.ok) console.log('save round-trip ok');
  else fail('save round-trip failed: ' + (r && r.reason ? r.reason : 'unknown'));
} else if (Save && Save.serialize) {
  try {
    const blob = JSON.stringify(Save.serialize(Game));
    console.log(`save is ${(blob.length / 1024).toFixed(0)} kB`);
    if (blob.length > 6 * 1024 * 1024) warn('save is too big for localStorage');
  } catch (e) { fail('Save.serialize threw: ' + e.message); }
} else fail('no Save module');

if (ticksPerSec < 400) warn(`only ${ticksPerSec} ticks/s headless; 6x speed needs 360/s in a browser too`);

if (warnings.length) {
  console.log(`\n${warnings.length} warning(s):`);
  warnings.forEach(w => console.log('  ~ ' + w));
}
if (problems.length) {
  console.error(`\n${problems.length} failure(s):`);
  problems.forEach(p => console.error('  - ' + p));
  process.exit(1);
}
console.log('\nsimulation ok');
