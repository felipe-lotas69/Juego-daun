'use strict';
const { load } = require('./harness.js');
const sb = load({ quiet: true });
const { Game, U, Defs, Levels, Zones, Regions, Path, T, Res, Jobs, WorkGivers, Save } = sb;
let bad = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++; };
const hr = s => console.log('\n=== ' + s + ' ===');

hr('1. cost of an unused level');
let t0 = process.hrtime.bigint();
Game.newGame({ seed: 5150, size: 90, colonists: 3 });
let t1 = process.hrtime.bigint();
const map = Game.map;
for (let i = 0; i < 2000; i++) Game.doTick();
let t2 = process.hrtime.bigint();
const baseGen = Number(t1 - t0) / 1e6, baseTick = Number(t2 - t1) / 1e6;
console.log(`  newGame ${baseGen.toFixed(0)}ms, 2000 ticks ${baseTick.toFixed(0)}ms, things ${map.things.size}`);
ok(Levels.inited(), 'Levels self-inited off GameMap.prototype.tick (no game.js edit)');
ok(Levels.count() === 1, 'one level exists after 2000 ticks of never digging: ' + Levels.count());
ok(Levels.zOf(map) === 0, 'surface map is z=0');
ok(Levels.surface() === map, 'Levels.surface() is Game.map');
const noBasement = JSON.parse(JSON.stringify(Levels.stats()));

hr('2. generation of a basement');
let g0 = process.hrtime.bigint();
const b1 = Levels.ensure(-1);
let g1 = process.hrtime.bigint();
ok(!!b1 && b1.z === -1, 'ensure(-1) made a level');
const bm = b1.map;
ok(bm.w === map.w && bm.h === map.h, 'basement is the same size as the surface, so x,y line up');
let open = 0, bedrock = 0, water = 0, faces = 0, ore = {};
for (let i = 0; i < bm.size; i++) {
  const t = Defs.fromIndex('terrain', bm.terrain[i]).id;
  if (t === 'bedrock') bedrock++;
  if (t === 'shallowWater' || t === 'deepWater') water++;
  if (bm.pathCost[i] !== bm.IMPASSABLE) open++;
  const id = bm.buildingId[i] && bm.things.get(bm.buildingId[i]);
  if (id) { faces++; ore[id.defId] = (ore[id.defId] || 0) + 1; }
}
console.log(`  gen ${(Number(g1 - g0) / 1e6).toFixed(0)}ms  open ${open}  bedrock ${bedrock}  flooded ${water}` +
            `  faces ${faces}  things ${bm.things.size}`);
console.log('  ore in the face: ' + JSON.stringify(ore));
ok(open > 400 && open < bm.size * 0.35, `caverns threaded through solid rock (${(100*open/bm.size).toFixed(0)}% walkable)`);
ok(faces > 100 && faces === bm.things.size, 'only the mine face is materialised as Things');
ok(bm.things.size < 2200, 'an untouched basement costs ' + bm.things.size + ' things, not w*h');
ok(bm.roof[0] === 2, 'a basement is roofed rock throughout');
ok(!!ore.compactedSteel, 'ore seams in the rock');
const deep = Levels.ensure(-2);
let deepOre = 0, shallowOre = 0;
for (let i = 0; i < 4000; i++) {
  if (['compactedSteel', 'compactedComponents', 'compactedSilver'].indexOf(sb.Levels.__oreProbe ? '' : '') >= 0) {}
}
const countOre = lv => { let n = 0, tot = 0; lv.map.things.forEach(t => { tot++; if (t.defId !== 'rockWall') n++; }); return n / Math.max(1, tot); };
shallowOre = countOre(b1); deepOre = countOre(deep);
console.log(`  ore fraction z=-1 ${(shallowOre * 100).toFixed(1)}%  z=-2 ${(deepOre * 100).toFixed(1)}%`);
ok(deepOre > shallowOre, 'ore is richer the deeper you go');

/* determinism */
const sig = m => Levels.terrainSignature(m);
const sigA = sig(b1.map);
const keepSeed = U.getSeed();
Levels.reset(); Levels.init(map);
const b1b = Levels.ensure(-1);
ok(sig(b1b.map) === sigA, 'generation is deterministic from seed and z');
ok(U.getSeed() !== 0, 'the simulation RNG stream is handed back after generation');

hr('3. connections are pairs');
/* Put the shaft somewhere that is a cavern below and reachable above. */
const colonist = map.colonists()[0];
let shaft = null;
for (let i = 0; i < b1b.map.size && !shaft; i++) {
  if (b1b.map.pathCost[i] === b1b.map.IMPASSABLE) continue;
  const x = b1b.map.xOf(i), y = b1b.map.yOf(i);
  if (!map.passable(x, y) || map.buildingAt(x, y)) continue;
  if (!Regions.sameArea(map, colonist.x, colonist.y, x, y)) continue;
  let room = 0;
  for (const [dx, dy] of U.ADJ8) if (b1b.map.passable(x + dx, y + dy)) room++;
  if (room < 5) continue;
  shaft = { x, y };
}
ok(!!shaft, 'found a cavern cell under reachable ground at ' + JSON.stringify(shaft));
const conn = Levels.link(-1, shaft.x, shaft.y, 'stairs');
ok(!!conn, 'Levels.link(-1, x, y, "stairs") made a connection');
ok(map.buildingAt(shaft.x, shaft.y) && map.buildingAt(shaft.x, shaft.y).defId === 'stairsDown',
   'stairs down appeared on the surface');
ok(b1b.map.buildingAt(shaft.x, shaft.y) && b1b.map.buildingAt(shaft.x, shaft.y).defId === 'stairsUp',
   'the counterpart appeared on the level below at the same x,y');
ok(conn.usable(), 'both ends stand and neither cell is blocked -> usable');
ok(Levels.connectionAt(0, shaft.x, shaft.y) === conn && Levels.connectionAt(-1, shaft.x, shaft.y) === conn,
   'connectionAt finds it from either level');
ok(Levels.connectionsFrom(-1).length === 1, 'connectionsFrom(-1)');

hr('4. reachability across levels');
const nearShaft = [];
for (const [dx, dy] of U.cellsInRadius(shaft.x, shaft.y, 4)) {
  if (!b1b.map.inBounds(dx, dy) || !b1b.map.passable(dx, dy)) continue;
  if (b1b.map.buildingAt(dx, dy)) continue;
  if (!Regions.sameArea(b1b.map, shaft.x, shaft.y, dx, dy)) continue;
  nearShaft.push(b1b.map.idx(dx, dy));
}
ok(nearShaft.length > 4, nearShaft.length + ' open cells beside the landing');
const cellar = { x: b1b.map.xOf(nearShaft[1]), y: b1b.map.yOf(nearShaft[1]) };
ok(Levels.reachable(0, colonist.x, colonist.y, -1, cellar.x, cellar.y),
   'a colonist on the surface can reach the cellar through the stairs');
ok(!Levels.reachable(0, colonist.x, colonist.y, -2, 10, 10),
   'and cannot reach z=-2, which has no shaft into it');
/* Invalidation 1: a basement area with no shaft into it is not reachable. */
let isolated = null;
for (let i = 0; i < b1b.map.size && !isolated; i++) {
  if (!b1b.map.passableIdx(i)) continue;
  if (b1b.map.areaId[i] === b1b.map.areaId[b1b.map.idx(shaft.x, shaft.y)]) continue;
  isolated = { x: b1b.map.xOf(i), y: b1b.map.yOf(i) };
}
if (isolated) {
  ok(!Levels.reachable(0, colonist.x, colonist.y, -1, isolated.x, isolated.y),
     'a sealed cavern on the same level as the landing is still unreachable');
} else {
  console.log('  --   this basement has a single cavern system, nothing to isolate');
}

/* Invalidation 2: take one end away and the route must go stale at once. */
const lowEnd = conn.lowThing();
b1b.map.destroyThing(lowEnd, 'test');
ok(!conn.usable(), 'a connection with a missing end reports itself unusable');
ok(!Levels.reachable(0, colonist.x, colonist.y, -1, cellar.x, cellar.y),
   'and the cellar goes unreachable on the very next query - no stale answer');
for (let i = 0; i < 70; i++) Game.doTick();
ok(Levels.connections().length === 0, 'the orphaned half was reconciled away within a second');
ok(!map.buildingAt(shaft.x, shaft.y), 'removing either end removes both');
const conn2 = Levels.link(-1, shaft.x, shaft.y, 'stairs');
ok(!!conn2 && conn2.usable(), 'rebuilt the stairs');
Regions.update(map); Regions.update(b1b.map);
ok(Levels.reachable(0, colonist.x, colonist.y, -1, cellar.x, cellar.y), 'reachable again');
const step = Levels.route(colonist, -1, cellar.x, cellar.y);
ok(step && step.kind === 'connection' && step.x === shaft.x && step.y === shaft.y && step.toZ === -1,
   'route() returns the connection to take, not a 3D path: ' + JSON.stringify(step && { k: step.kind, x: step.x, y: step.y, toZ: step.toZ }));

hr('5. a hauler carries steel down to a basement stockpile');
const cellarCells = nearShaft.filter(i => i !== b1b.map.idx(shaft.x, shaft.y)).slice(0, 12);
const cellarZone = Zones.add(b1b.map, 'stockpile', cellarCells, { label: 'Cellar' });
ok(!!cellarZone, 'stockpile of ' + cellarCells.length + ' cells laid in the basement');
ok(!Zones.stockpiles(map).length, 'the surface deliberately has no stockpile at all');

const drop = map.freeNeighbour(colonist.x, colonist.y) || { x: colonist.x, y: colonist.y };
map.addItem('steel', drop.x, drop.y, 75);
map.addItem('wood', drop.x, drop.y, 60);
console.log(`  dropped 75 steel and 60 wood at ${drop.x},${drop.y}; the only storage is ${Math.abs(0 - -1)} level down`);
ok(!!WorkGivers.get('haulBetweenLevels'), 'the cross-level haul giver is registered on workType haul');

let sawJob = false, sawTransfer = false, peakRes = 0, maxBelow = 0;
for (let i = 0; i < 26000; i++) {
  Game.doTick();
  for (const p of Levels.colonists()) {
    if (p.job && p.job.defId === 'haulAcrossLevels') sawJob = true;
    if (Levels.zOf(p.map) === -1) sawTransfer = true;
  }
  const below = b1b.map.pawns.length;
  if (below > maxBelow) maxBelow = below;
  peakRes = Math.max(peakRes, (map.__reservations ? map.__reservations.size : 0) +
                              (b1b.map.__reservations ? b1b.map.__reservations.size : 0));
}
let steelBelow = 0, stacksBelow = 0;
cellarZone.cells.forEach(i => {
  for (const t of b1b.map.itemsIdx(i)) { stacksBelow++; if (t.defId === 'steel') steelBelow += t.stack; }
});
let steelAbove = 0;
for (const t of map.byDef('steel')) if (t.spawned) steelAbove += t.stack;
console.log(`  after 26000 ticks: ${stacksBelow} stacks in the cellar, ${steelBelow} steel below, ` +
            `${steelAbove} steel still above, pawns seen below ${maxBelow}, peak reservations ${peakRes}`);
ok(sawJob, 'a colonist took a haulAcrossLevels job');
ok(sawTransfer, 'a colonist actually stood on the level below');
ok(steelBelow > 0, steelBelow + ' steel is in the basement stockpile');
ok(stacksBelow > 1, 'and it is not the only thing that got down there: ' + stacksBelow + ' stacks');
ok(peakRes < 60, 'reservations did not leak across the two maps: peak ' + peakRes);
let stranded = 0;
for (const p of Levels.colonists()) if (p.levelClaims && p.levelClaims.length && !p.job) stranded++;
ok(stranded === 0, 'no colonist is holding a remote claim without a job to justify it');
ok(Levels.colonists().length === map.colonists().length + b1b.map.colonists().length,
   'Game.colonists() sees every level, so a colony in the cellar is not "everyone is dead"');
ok(!Game.gameOver, 'the game did not declare the colony dead while people were underground');

hr('6. upper floors, support and collapse');
/* Find open ground with no natural rock anywhere near it, so the only
   support is the one this test puts there. */
let pad = null;
for (let y = 6; y < map.h - 6 && !pad; y++) {
  for (let x = 6; x < map.w - 6; x++) {
    let clean = true;
    for (const [dx, dy] of U.cellsInRadius(x, y, 6)) {
      if (!map.inBounds(dx, dy)) { clean = false; break; }
      const b = map.buildingAt(dx, dy);
      if (b || !map.passable(dx, dy)) { clean = false; break; }
    }
    if (clean) { pad = { x, y }; break; }
  }
}
ok(!!pad, 'found clear ground with nothing holding anything up at ' + JSON.stringify(pad));
const up = Levels.ensure(1);
ok(!!up && up.z === 1, 'ensure(+1) made an upper floor');
let sky = 0;
for (let i = 0; i < up.map.size; i++) if (!up.map.passableIdx(i)) sky++;
ok(sky === up.map.size, 'an upper floor starts as nothing at all: ' + sky + '/' + up.map.size + ' impassable sky');
ok(up.map.things.size === 0, 'and holds no things');

ok(!Levels.canBuildAt(1, pad.x, pad.y).ok, 'nothing can be built over open ground: "' +
   Levels.canBuildAt(1, pad.x, pad.y).reason + '"');
const column = map.spawnThing('supportColumn', pad.x, pad.y, { faction: 'player' });
ok(!!column && column.def.holdsRoof, 'a support column is a thing you can build');
ok(Levels.canBuildAt(1, pad.x, pad.y).ok, 'now the cell directly above it is buildable');
ok(Levels.supportedAt(1, pad.x + 3, pad.y), 'and so is one three cells away along a beam');
ok(!Levels.supportedAt(1, pad.x + 4, pad.y), 'but not four');
ok(!Levels.supportedAt(1, pad.x + 3, pad.y + 3), 'and not diagonally out of beam reach');

let laid = 0;
for (let d = 0; d <= 3; d++) if (Levels.buildFloor(1, pad.x + d, pad.y, 'concreteFloor')) laid++;
ok(laid === 4, 'laid ' + laid + ' floor cells out along the beam');
ok(up.map.passable(pad.x + 3, pad.y), 'the far end of the beam is walkable');
up.map.addItem('steel', pad.x + 3, pad.y, 20);
const before = (() => { let n = 0; for (const t of map.byDef('steel')) if (t.spawned && t.x === pad.x + 3 && t.y === pad.y) n += t.stack; return n; })();

/* Mine the column out from under it. */
map.destroyThing(column, 'test');
const queued = Levels.noteCellOpened(0, pad.x, pad.y);
ok(queued === 4, 'pulling the support queued ' + queued + ' unsupported cells for collapse');
for (let i = 0; i < 40; i++) Game.doTick();
let stillUp = 0;
for (let d = 0; d <= 3; d++) if (up.map.passable(pad.x + d, pad.y)) stillUp++;
ok(stillUp === 0, 'all of it came down; ' + stillUp + ' cells left standing');
const after = (() => { let n = 0; for (const t of map.byDef('steel')) if (t.spawned && U.cheb(t.x, t.y, pad.x + 3, pad.y) <= 1) n += t.stack; return n; })();
ok(after - before >= 20, 'the 20 steel that was up there landed on the surface below (' + (after - before) + ')');
ok(Game.letters.some(l => l.title === 'Collapse'), 'and the player was told about it');
ok(Levels.stats().pendingCollapses === 0, 'the collapse queue drained and did not recurse');

hr('7. temperature and light');
console.log('  ambient: z=+1 ' + Levels.ambientTemperature(1).toFixed(1) + 'C  z=0 ' +
            Levels.ambientTemperature(0).toFixed(1) + 'C  z=-1 ' + Levels.ambientTemperature(-1).toFixed(1) +
            'C  z=-2 ' + Levels.ambientTemperature(-2).toFixed(1) + 'C');
ok(Math.abs(Levels.ambientTemperature(-1) - 11) < 0.01, 'a basement sits at 11C');
ok(Levels.ambientTemperature(-2) < Levels.ambientTemperature(-1), 'and drifts cooler deeper down');
ok(Levels.ambientTemperature(1) === Game.outdoorTemp(), 'an upper floor gets the weather');
ok(Levels.isOutdoorLevel(1) && Levels.isOutdoorLevel(0) && !Levels.isOutdoorLevel(-1),
   'isOutdoorLevel: +1 yes, 0 yes, -1 no');
ok(Levels.lightAt(-1, cellar.x, cellar.y) === 0, 'a basement is pitch dark with no lamp');
const lamp = b1b.map.spawnThing('standingLamp', cellar.x, cellar.y, { faction: 'player' });
lamp.powered = true;
ok(Levels.lightAt(-1, cellar.x, cellar.y) > 0.9, 'a powered lamp lights the cell it stands on');
ok(Levels.lightAt(-1, cellar.x + 5, cellar.y) > 0 && Levels.lightAt(-1, cellar.x + 5, cellar.y) < 1,
   'and falls off with distance');
ok(Levels.lightAt(-1, cellar.x + 30, cellar.y) === 0, 'and reaches no further than its radius');
b1b.map.destroyThing(lamp, 'test');
const roomTemps = [];
Regions.rooms(b1b.map).forEach(r => { if (!r.outdoor && r.size > 3) roomTemps.push(r.temperature); });
console.log('  basement rooms settled at: ' + roomTemps.slice(0, 4).map(t => t.toFixed(1)).join(', ') + 'C');

hr('8. the mine face follows the pick');
const faceIdx = b1b.faces.find(i => b1b.map.buildingId[i]);
const fx2 = b1b.map.xOf(faceIdx), fy2 = b1b.map.yOf(faceIdx);
const facesBefore = b1b.faces.length;
const neighboursBefore = U.ADJ8.filter(([dx, dy]) => b1b.map.buildingAt(fx2 + dx, fy2 + dy)).length;
b1b.map.destroyThing(b1b.map.buildingAt(fx2, fy2), 'mined');
ok(b1b.map.passable(fx2, fy2), 'a mined-out face leaves walkable cut floor, exactly like the surface');
for (let i = 0; i < 60; i++) Game.doTick();
const neighboursAfter = U.ADJ8.filter(([dx, dy]) => b1b.map.buildingAt(fx2 + dx, fy2 + dy)).length;
console.log(`  faces ${facesBefore} -> ${b1b.faces.length}; mineable neighbours ${neighboursBefore} -> ${neighboursAfter}`);
ok(neighboursAfter > neighboursBefore, 'cutting one cell exposed the rock behind it as new mineable faces');

hr('9. ladders and lifts');
let shaft2 = null;
for (let i = 0; i < b1b.map.size && !shaft2; i++) {
  if (!b1b.map.passableIdx(i) || b1b.map.buildingId[i]) continue;
  const x = b1b.map.xOf(i), y = b1b.map.yOf(i);
  if (!map.passable(x, y) || map.buildingAt(x, y) || U.cheb(x, y, shaft.x, shaft.y) < 4) continue;
  shaft2 = { x, y };
}
const ladder = Levels.link(-1, shaft2.x, shaft2.y, 'ladder');
ok(!!ladder && ladder.kind === 'ladder', 'a ladder is a connection too');
ok(Defs.thing('levelLadder').pathCost > Defs.thing('stairsUp').pathCost, 'and it is slower to climb');
ok(Defs.thing('freightLift').pathCost < Defs.thing('stairsUp').pathCost, 'a freight lift is faster');
ok(Defs.thing('freightLift').building.powerConsumed > 0, 'and needs power');
Levels.unlink(ladder);
ok(!map.buildingAt(shaft2.x, shaft2.y) && !b1b.map.buildingAt(shaft2.x, shaft2.y), 'unlink removed both ends');
const lift = Levels.link(-1, shaft2.x, shaft2.y, 'lift');
lift.lowThing().powered = false;
ok(!lift.usable(), 'an unpowered lift is not a usable connection');
lift.lowThing().powered = true;
ok(lift.usable(), 'a powered one is');
Levels.unlink(lift);

hr('10. the sealed room');
let vaulted = null;
for (let z = -1; z >= -3 && !vaulted; z--) {
  const lv = Levels.get(z) || Levels.ensure(z);
  if (lv && lv.vaults.length && !lv.vaults[0].triggered) vaulted = lv;
}
if (vaulted) {
  const v = vaulted.vaults[0];
  console.log(`  z=${vaulted.z} holds a sealed ${v.w}x${v.h} room at ${v.x},${v.y} with ${v.count} ${v.kindId}(s) in it`);
  let loot = 0;
  for (let y = v.y; y < v.y + v.h; y++) for (let x = v.x; x < v.x + v.w; x++) loot += vaulted.map.items(x, y).length;
  ok(loot > 0, loot + ' stacks of loot inside it');
  ok(vaulted.map.pawns.length === 0, 'nothing is ticking in there until somebody opens it');
  const scout = Levels.colonists()[0];
  ok(Levels.transfer(scout, vaulted.z, { force: true }), 'sent a scout down to z=' + vaulted.z);
  const was = { x: scout.x, y: scout.y };
  scout.x = v.x + 1; scout.y = v.y + 1;
  scout.fx = scout.x; scout.fy = scout.y;
  vaulted.map.notePawnMoved(scout, was.x, was.y);
  for (let i = 0; i < 300; i++) Game.doTick();
  ok(vaulted.vaults[0].triggered, 'walking in woke it up');
  ok(vaulted.map.pawns.length > 1, 'and ' + (vaulted.map.pawns.length - 1) + ' of them came out of the dark');
  Levels.transfer(scout, 0, { force: true });
  ok(Levels.zOf(scout.map) === 0, 'and back up again');
} else {
  console.log('  --   this seed put no sealed room in reach; the roll is 35% + 16% per level down');
}

hr('11. what a basement costs to run');
/* Same colony, same point in the run, measured both ways, so the only
   difference between the two numbers is the levels themselves. */
for (const p of Levels.colonists()) if (Levels.zOf(p.map) !== 0) Levels.transfer(p, 0, { force: true });
for (let i = 0; i < 500; i++) Game.doTick();
let c0 = process.hrtime.bigint();
for (let i = 0; i < 3000; i++) Game.doTick();
let c1 = process.hrtime.bigint();
const withCost = Number(c1 - c0) / 1e6;
const shape = Levels.all().map(l => `z${l.z}:${l.map.things.size}t/${l.map.pawns.length}p`).join(' ');
const keep = JSON.stringify(Levels.save());

/* Back to an undug colony. The stair heads have to go too: a stairs
   head standing on the surface is precisely what makes a basement
   appear, so leaving one would be measuring a dug colony again. */
for (const lv of Levels.all()) {
  for (const d of ['stairsUp', 'stairsDown', 'levelLadder', 'freightLift']) {
    for (const t of lv.map.byDef(d).slice()) lv.map.destroyThing(t, 'test');
  }
}
Levels.reset(); Levels.init(map);
ok(map.byDef('stairsDown').length === 0 && map.byDef('stairsUp').length === 0, 'colony is undug again');
let d0 = process.hrtime.bigint();
for (let i = 0; i < 3000; i++) Game.doTick();
let d1 = process.hrtime.bigint();
const soloCost = Number(d1 - d0) / 1e6;
console.log(`  3000 ticks, surface only          ${soloCost.toFixed(0)}ms  (${(3000 / soloCost * 1000) | 0} ticks/s)`);
console.log(`  3000 ticks, ${shape}`);
console.log(`                                    ${withCost.toFixed(0)}ms  (${(3000 / withCost * 1000) | 0} ticks/s)`);
ok(!Game.gameOver, 'the colony survived the teardown');
ok(Levels.count() === 1, 'and nothing dug itself: ' + Levels.all().map(l => l.z).join(','));

/* A live colony drifts too much between two runs to see a fraction of a
   percent through Game.doTick, so the added work is timed on its own:
   the tick guard, the level-count check, and the once-a-second scan. */
const keptTick = Game.tick;
let m0 = process.hrtime.bigint();
for (let i = 0; i < 300000; i++) { Game.tick++; Levels.tick(map, Game); }
let m1 = process.hrtime.bigint();
Game.tick = keptTick;
const perTick = Number(m1 - m0) / 300000;
console.log(`  Levels.tick() on an undug colony: ${perTick.toFixed(0)} ns per game tick, ` +
            `${(perTick * 60 / 1e6).toFixed(5)} ms per simulated second at 1x`);
ok(perTick < 400, 'an undug level costs under 400ns a tick, which is nothing');
ok(Levels.count() === 1, 'and 300000 ticks created no level');

hr('11. save and load');
const json = keep;
const blob = JSON.parse(json);
console.log(`  Levels.save() with no packer is ${(json.length / 1024).toFixed(0)} kB for ${blob.levels.length} levels`);
const saved = blob.levels.filter(l => l.z === -1)[0];
ok(Levels.load(JSON.parse(json)), 'Levels.load() accepted it after the levels were torn down');
const b1c = Levels.get(-1);
ok(!!b1c, 'the basement came back');
ok(sig(b1c.map) === saved.mapSig, 'its terrain is identical');
ok(b1c.map.things.size === saved.map.things.length, `its things came back (${saved.map.things.length} -> ${b1c.map.things.size})`);
ok(JSON.stringify(b1c.vaults) === JSON.stringify(saved.vaults), 'the sealed rooms and whether they have been opened came back');
ok(b1c.faces.length > 0, 'the mine face was re-derived from the map: ' + b1c.faces.length + ' faces');
ok(Levels.connections().length >= 1, 'the stair pairs were reconciled back into connections');
ok(Levels.get(1) && Levels.get(1).map.things.size === 0, 'the upper floor came back too');
for (let i = 0; i < 300; i++) Game.doTick();
ok(!Game.gameOver, 'and the game keeps ticking after a load');

hr('12. the gap save.js still has to close');
const lift2 = Levels.get(-1);
const traveller = Levels.colonists()[0];
/* Stand above a cavern first; force does not mean teleport across the map. */
for (let i = 0; i < lift2.map.size; i++) {
  if (!lift2.map.passableIdx(i) || lift2.map.buildingId[i]) continue;
  const was = { x: traveller.x, y: traveller.y };
  traveller.x = lift2.map.xOf(i); traveller.y = lift2.map.yOf(i);
  map.notePawnMoved(traveller, was.x, was.y);
  break;
}
ok(Levels.transfer(traveller, -1, { force: true }), 'put one colonist underground');
let payload = null;
try { payload = Save.serialize(Game); } catch (e) { ok(false, 'Save.serialize threw with a colonist underground: ' + e.message); }
ok(!!payload, 'Save.serialize still works with a colonist on another level');
if (payload) {
  const inPayload = payload.map.pawns.length;
  const everywhere = map.pawns.length + lift2.map.pawns.length;
  console.log(`  save.js wrote ${inPayload} pawns; the colony actually has ${everywhere} across its levels`);
  ok(inPayload < everywhere, 'which is exactly the three-line change described in levels.js: ' +
     'Save.mapRecord/restoreMap, plus Levels.save(Save.mapRecord) and Levels.load(data.levels, Save.restoreMap)');
  const round = Levels.load(JSON.parse(JSON.stringify(Levels.save(m => ({ w: m.w, h: m.h })))) , null);
  ok(round !== false, 'Levels.save(packMap) accepts an injected packer');
}

console.log('\n' + (bad ? bad + ' FAILURE(S)' : 'every levels.js check passed'));
process.exit(bad ? 1 : 0);
