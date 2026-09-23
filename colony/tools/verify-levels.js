'use strict';
const { load } = require('./harness.js');
const sb = load({ quiet: true });
const { Game, U, Defs, Levels, Zones, Regions, Path, T, Res, Jobs, WorkGivers, Save, Think } = sb;
let bad = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++; };
const hr = s => console.log('\n=== ' + s + ' ===');

/* This file tests verticality, not survival. Long runs would otherwise
   end with a colony that starved because its only stockpile is a
   steel-only cellar, and every later assertion would be measuring that
   instead of the thing under test. */
function feed() {
  if (typeof Levels === 'undefined' || !Levels.all) return;
  Game.gameOver = null;
  for (const lv of Levels.all()) {
    for (const p of lv.map.pawns) {
      if (p.faction !== 'player' || p.dead) continue;
      p.needs.food = 1; p.needs.rest = 1; p.needs.joy = 0.9;
      /* And end a break in progress. A colonist who goes berserk on the
         stairs abandons the job this file is in the middle of measuring,
         which reads as "the haul does not work" when what actually
         happened is that the colony was miserable. Mood is needs.js's
         subject, not this one's. */
      if (p.mentalState && Think && Think.endMentalState) Think.endMentalState(p, 'test');
    }
  }
}
function runTicks(n) {
  for (let i = 0; i < n; i++) {
    Game.doTick();
    if ((i % 1000) === 0) feed();
  }
  feed();
}

/* One seed is the committed run, so the timings and the printed counts
   below stay comparable between checkouts. A seed passed on the command
   line re-runs the whole file against a different world, which is how
   the cross-level haul gets shown to depend on the stockpile being
   somewhere else and not on where this particular map put its caverns. */
const SEED = Number(process.argv[2]) || 5150;

hr('1. cost of an unused level');
let t0 = process.hrtime.bigint();
Game.newGame({ seed: SEED, size: 90, colonists: 3 });
Game.difficulty = { name: 'levels test', threatScale: 0 };   /* the storyteller is not what is under test */
let t1 = process.hrtime.bigint();
const map = Game.map;
runTicks(2000);
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
/* Everything the generator materialises is either a rock face or a
   stack of loot sealed inside a vault. Counting the loot separately
   rather than demanding faces === things is what makes this hold on a
   seed that happened to put a sealed room on the first level down. */
let vaultLoot = 0;
for (const v of b1.vaults)
  for (let vy = v.y; vy < v.y + v.h; vy++)
    for (let vx = v.x; vx < v.x + v.w; vx++) vaultLoot += bm.items(vx, vy).length;
ok(faces > 100 && faces + vaultLoot === bm.things.size,
   `only the mine face is materialised as Things (${faces} faces + ${vaultLoot} vault loot = ${bm.things.size})`);
ok(bm.things.size < 2200, 'an untouched basement costs ' + bm.things.size + ' things, not w*h');
ok(bm.roof[0] === 2, 'a basement is roofed rock throughout');
ok(!!ore.compactedSteel, 'ore seams in the rock');
const deep = Levels.ensure(-2);
/* Count the ore defs against the rock face only. "Everything that is
   not a rockWall" also catches the loot stacked inside a sealed room,
   and a vault on one level and not the other moved this number by two
   points - enough to invert the comparison and blame the generator. */
const ORE_DEFS = ['compactedSteel', 'compactedComponents', 'compactedSilver'];
const countOre = lv => {
  let n = 0, tot = 0;
  for (const i of lv.faces) {
    const t = lv.map.things.get(lv.map.buildingId[i]);
    if (!t) continue;
    tot++;
    if (ORE_DEFS.indexOf(t.defId) >= 0) n++;
  }
  return n / Math.max(1, tot);
};
/* One level down against three, not against two. The rule is roughly
   9.8% ore at z=-1, 14.0% at z=-2 and 18.2% at z=-3, and a face is only
   a few hundred cells: the one-step gap sits inside the sampling error
   often enough that a fair generator fails this on about one seed in
   twelve. Two steps doubles the gap and puts the comparison clear of
   the noise, and it is the same claim - dig deeper, get richer. */
const deeper = Levels.ensure(-3);
const shallowOre = countOre(b1), midOre = countOre(deep), deepOre = countOre(deeper);
console.log(`  ore fraction z=-1 ${(shallowOre * 100).toFixed(1)}%  z=-2 ${(midOre * 100).toFixed(1)}%` +
            `  z=-3 ${(deepOre * 100).toFixed(1)}%  (rule: 9.8 / 14.0 / 18.2)`);
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
runTicks(70);
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
/* Steel only, so the brief's own test case is the thing being measured
   and not whatever else happened to be lying about. */
if (Zones.setFilterDef) {
  cellarZone.filter.allowAll = false;
  cellarZone.filter.categories.clear();
  cellarZone.filter.defs.clear();
  Zones.setFilterDef(cellarZone, 'steel', true);
  ok(Zones.accepts(cellarZone, Defs.thing('steel')) && !Zones.accepts(cellarZone, Defs.thing('wood')),
     'and it accepts steel and nothing else');
}
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
ok(steelBelow > 0, steelBelow + ' steel walked itself down the stairs into the cellar, unprompted');

/* And the same thing again, deterministically, so the result does not
   depend on what else the colony felt like doing this afternoon. */
let hauler = Levels.colonists().filter(p => Levels.zOf(p.map) === 0 && !p.downed)[0];
if (!hauler) {
  hauler = Levels.colonists().filter(p => !p.downed)[0];
  if (hauler) Levels.transfer(hauler, 0, { force: true });
  if (hauler && Levels.zOf(hauler.map) !== 0) hauler = null;
}
let drove = false;
if (hauler) {
  const spot = map.freeNeighbour(hauler.x, hauler.y) || { x: hauler.x, y: hauler.y };
  map.addItem('steel', spot.x, spot.y, 50);
  Game.doTick();                       /* the giver's scan cache is per tick */
  Jobs.end(hauler, 'interrupted');
  const job = Levels.tryGiveHaulJob(hauler);
  ok(!!job && job.defId === 'haulAcrossLevels', 'Levels.tryGiveHaulJob handed out a cross-level haul');
  if (job) {
    const want = T.resolve(job.targetA, map);
    const wantDef = want.defId;
    const inCellar = () => {
      let n = 0;
      cellarZone.cells.forEach(i => { for (const t of b1b.map.itemsIdx(i)) if (t.defId === wantDef) n += t.stack; });
      return n;
    };
    console.log(`  job: pick up ${want.stack} ${wantDef} at ${want.x},${want.y} on z=${job.state.fromZ}, ` +
                `put it at ${job.state.tx},${job.state.ty} on z=${job.state.toZ}`);
    job.playerForced = true;
    const was = inCellar();
    feed();
    Jobs.start(hauler, job);
    let spent = 0;
    while (hauler.job === job && spent++ < 12000) { Game.doTick(); if ((spent % 100) === 0) feed(); }
    console.log(`  drove it to the end in ${spent} ticks; ${wantDef} in the cellar ${was} -> ${inCellar()}`);
    ok(inCellar() > was, 'the load is in the basement stockpile');
    ok(!hauler.levelClaims || !hauler.levelClaims.length, 'and the hauler gave its remote claim back');
    drove = true;
  }
}
ok(drove, 'the cross-level haul also runs end to end when it is handed out directly');
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
runTicks(40);
let stillUp = 0;
for (let d = 0; d <= 3; d++) if (up.map.passable(pad.x + d, pad.y)) stillUp++;
ok(stillUp === 0, 'all of it came down; ' + stillUp + ' cells left standing');
const after = (() => { let n = 0; for (const t of map.byDef('steel')) if (t.spawned && U.cheb(t.x, t.y, pad.x + 3, pad.y) <= 1) n += t.stack; return n; })();
ok(after - before >= 20, 'the 20 steel that was up there landed on the surface below (' + (after - before) + ')');
ok(Game.letters.some(l => l.title === 'Collapse'), 'and the player was told about it');
ok(Levels.stats().pendingCollapses === 0, 'the collapse queue drained and did not recurse');

/* Nobody may be left standing on a cell that has stopped being a cell:
   a pawn on an impassable tile cannot path and would freeze forever. */
const up2 = Levels.get(1);
const prop = map.spawnThing('supportColumn', pad.x, pad.y, { faction: 'player' });
Levels.buildFloor(1, pad.x, pad.y, 'concreteFloor');
Levels.buildFloor(1, pad.x + 1, pad.y, 'concreteFloor');
const faller = Levels.colonists()[0] || map.pawns.filter(p => !p.dead)[0];
ok(Levels.transfer(faller, 1, { force: true, landingRadius: 0 }) || true, 'sent a colonist upstairs');
if (Levels.zOf(faller.map) !== 1) {
  const wasA = { x: faller.x, y: faller.y };
  faller.x = pad.x; faller.y = pad.y; faller.map.notePawnMoved(faller, wasA.x, wasA.y);
  Levels.transfer(faller, 1, { force: true });
}
ok(Levels.zOf(faller.map) === 1, 'the colonist is on the upper floor');
const hpBefore = faller.health.bloodLoss + faller.health.pain;
map.destroyThing(prop, 'test');
Levels.noteCellOpened(0, pad.x, pad.y);
runTicks(40);
ok(Levels.zOf(faller.map) === 0, 'the floor went and the colonist came down with it');
ok(faller.map.passable(faller.x, faller.y), 'and landed somewhere it can stand, not on a deleted tile');
console.log(`  the fall cost it ${(faller.health.pain + faller.health.bloodLoss - hpBefore).toFixed(3)} of pain and blood`);
ok(faller.health.injuries.length > 0 || faller.health.pain + faller.health.bloodLoss > hpBefore, 'and it hurt');
let stuck = 0;
for (const lv of Levels.all()) for (const p of lv.map.pawns) if (!lv.map.passable(p.x, p.y)) stuck++;
ok(stuck === 0, 'nobody anywhere is standing on an impassable cell');

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

/* A stairway built upward has to survive its own support rule. */
/* The shaft has to be the ONLY thing holding its landing up, or the
   teardown below proves nothing: a beam reaches BEAM_SPAN cells in
   each cardinal direction, and natural rock holds a roof up just as
   a wall does, so a riser picked next to a mountain keeps its landing
   after the stairs are gone - correctly, and uselessly for this test. */
const beamClear = (x, y) => {
  for (const [dx, dy] of U.ADJ4) {
    for (let s2 = 1; s2 <= Levels.BEAM_SPAN; s2++) {
      const b = map.buildingAt(x + dx * s2, y + dy * s2);
      if (b && b.def && b.def.holdsRoof) return false;
    }
  }
  return true;
};
let riser = null;
for (let y = 10; y < map.h - 10 && !riser; y++) {
  for (let x = 10; x < map.w - 10; x++) {
    if (map.passable(x, y) && !map.buildingAt(x, y) && !map.plantAt(x, y) && beamClear(x, y)) {
      riser = { x, y }; break;
    }
  }
}
const upPair = Levels.link(0, riser.x, riser.y, 'stairs');
ok(!!upPair, 'built a stairway up from the surface at ' + JSON.stringify(riser));
ok(Levels.get(1).map.passable(riser.x, riser.y), 'the head of the stairs is a floor on the upper level');
runTicks(2600);
ok(!!upPair.intact() && Levels.get(1).map.passable(riser.x, riser.y),
   'and it is still standing 2600 ticks later - a shaft holds up its own head');
map.destroyThing(upPair.lowThing(), 'test');
runTicks(400);
ok(!Levels.get(1).map.passable(riser.x, riser.y),
   'take the stairs away and the landing they held up falls in');

hr('8. the mine face follows the pick');
const faceIdx = b1b.faces.find(i => b1b.map.buildingId[i]);
const fx2 = b1b.map.xOf(faceIdx), fy2 = b1b.map.yOf(faceIdx);
const facesBefore = b1b.faces.length;
const neighboursBefore = U.ADJ8.filter(([dx, dy]) => b1b.map.buildingAt(fx2 + dx, fy2 + dy)).length;
b1b.map.destroyThing(b1b.map.buildingAt(fx2, fy2), 'mined');
ok(b1b.map.passable(fx2, fy2), 'a mined-out face leaves walkable cut floor, exactly like the surface');
const sawFace = Game.tick;
runTicks(80);
const neighboursAfter = U.ADJ8.filter(([dx, dy]) => b1b.map.buildingAt(fx2 + dx, fy2 + dy)).length;
console.log(`  faces ${facesBefore} -> ${b1b.faces.length}; mineable neighbours ${neighboursBefore} -> ${neighboursAfter}`);
ok(neighboursAfter > neighboursBefore,
   `cutting one cell exposed the rock behind it as new mineable faces, within ${Game.tick - sawFace} ticks`);

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
  /* The claim is that what is SEALED IN is dormant, not that the level
     is empty: by now the colony may already be hauling on this one. */
  const sleepers = () => vaulted.map.pawns.filter(p => p.faction !== 'player').length;
  ok(sleepers() === 0, 'nothing is ticking in there until somebody opens it');
  const scout = Levels.colonists()[0] || Levels.all().flatMap(l => l.map.pawns.filter(p => !p.dead))[0];
  /* Stand over the chamber first: force does not mean teleport across
     the map, and everything around a sealed room is solid rock. */
  const was = { x: scout.x, y: scout.y };
  scout.x = v.x + 1; scout.y = v.y + 1;
  scout.fx = scout.x; scout.fy = scout.y;
  scout.map.notePawnMoved(scout, was.x, was.y);
  /* A scout already standing on this level walked here under its own
     steam; transfer says no to a move that is not a move. */
  if (Levels.zOf(scout.map) !== vaulted.z) Levels.transfer(scout, vaulted.z, { force: true });
  ok(Levels.zOf(scout.map) === vaulted.z, 'sent a scout down to z=' + vaulted.z);
  /* Sampled as it runs, not read off the end: the claim is that opening
     the room let its occupants out, and a scout who then killed both
     boomrats has confirmed that, not refuted it. */
  let woke = 0;
  for (let i = 0; i < 300; i++) { Game.doTick(); woke = Math.max(woke, sleepers()); }
  feed();
  ok(vaulted.vaults[0].triggered, 'walking in woke it up');
  ok(woke > 0, 'and ' + woke + ' of them came out of the dark');
  /* Coming back up is only possible where there is surface to stand on.
     A vault under a mountain has none, and transfer refuses rather than
     teleporting the scout across the map - so the check is the contract
     (landed, or stayed put and intact), not "it always works". */
  const surfaceLanding = map.passable(scout.x, scout.y) ||
    U.cellsInRadius(scout.x, scout.y, 8).some(([cx, cy]) => map.inBounds(cx, cy) && map.passable(cx, cy));
  const cameUp = Levels.transfer(scout, 0, { force: true });
  ok(surfaceLanding ? (cameUp && Levels.zOf(scout.map) === 0)
                    : (!cameUp && Levels.zOf(scout.map) === vaulted.z && !scout.dead),
     surfaceLanding ? 'and back up again'
                    : 'and refused to surface inside a mountain, leaving the scout whole');
} else {
  console.log('  --   this seed put no sealed room in reach; the roll is 35% + 16% per level down');
}

hr('11. what a basement costs to run');
/* Same colony, same point in the run, measured both ways, so the only
   difference between the two numbers is the levels themselves. */
for (const p of Levels.colonists()) if (Levels.zOf(p.map) !== 0) Levels.transfer(p, 0, { force: true });
runTicks(500);
let c0 = process.hrtime.bigint();
runTicks(3000);
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
runTicks(3000);
let d1 = process.hrtime.bigint();
const soloCost = Number(d1 - d0) / 1e6;
console.log(`  3000 ticks, surface only          ${soloCost.toFixed(0)}ms  (${(3000 / soloCost * 1000) | 0} ticks/s)`);
console.log(`  3000 ticks, ${shape}`);
console.log(`                                    ${withCost.toFixed(0)}ms  (${(3000 / withCost * 1000) | 0} ticks/s)`);
ok(!Game.gameOver, 'the colony survived the teardown (' + Levels.colonists().length + ' colonists)');
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
/* A loose bar on purpose: this is a wall-clock benchmark on a shared
   machine, and the claim being checked is "negligible", not a number. */
ok(perTick * 60 / 1e6 < 0.2, 'an undug colony pays under 0.2ms of levels.js per simulated second');
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
runTicks(300);
const tickWas = Game.tick;
runTicks(300);
ok(Game.tick > tickWas && !Game.gameOver, 'and the game keeps ticking after a load');

hr('12. a colonist underground, and where the save file puts them');
const lift2 = Levels.get(-1);
const traveller = Levels.colonists()[0] || Levels.all().flatMap(l => l.map.pawns.filter(p => !p.dead))[0];
ok(!!traveller, 'someone is still alive to send down (' + Levels.colonists().length + ' colonists)');
if (traveller) {
/* Stand above a cavern first; force does not mean teleport across the map. */
for (let i = 0; i < lift2.map.size; i++) {
  if (!lift2.map.passableIdx(i) || lift2.map.buildingId[i]) continue;
  const was = { x: traveller.x, y: traveller.y };
  traveller.x = lift2.map.xOf(i); traveller.y = lift2.map.yOf(i);
  map.notePawnMoved(traveller, was.x, was.y);
  break;
}
/* As in the vault check: a colonist who already walked down there is
   underground, and transfer says no to a move that is not a move. */
if (Levels.zOf(traveller.map) !== -1) Levels.transfer(traveller, -1, { force: true });
ok(Levels.zOf(traveller.map) === -1, 'put one colonist underground');
let payload = null;
try { payload = Save.serialize(Game); } catch (e) { ok(false, 'Save.serialize threw with a colonist underground: ' + e.message); }
ok(!!payload, 'Save.serialize still works with a colonist on another level');
if (payload) {
  const inSurface = payload.map.pawns.length;
  const everywhere = map.pawns.length + lift2.map.pawns.length;
  const underground = (payload.levels && payload.levels.levels || [])
    .reduce((n, rec) => n + ((rec.map && rec.map.pawns) ? rec.map.pawns.length : 0), 0);
  console.log(`  save.js wrote ${inSurface} pawns on the surface and ${underground} below; ` +
              `the colony has ${everywhere} across its levels`);
  ok(inSurface < everywhere,
     'the surface record alone does not hold everybody - it never could, it is one map');
  ok(!!payload.levels && !payload.levels.lossy,
     'the save carries a levels record, and it is the lossless one (packMap was supplied)');
  ok(inSurface + underground === everywhere,
     'and every pawn in the colony is in the file exactly once: ' +
     inSurface + ' + ' + underground + ' = ' + everywhere);
  let packed = 0;
  const injected = Levels.save(function (m) { packed++; return { w: m.w, h: m.h }; });
  ok(packed === injected.levels.length && packed > 0,
     'Levels.save(packMap) routes every level through the packer save.js supplies (' + packed + ')');
}
}

hr('13. the container API');
['init','get','ensure','all','zOf','surface','count','setActive','activeMap','forEach','tickAll',
 'supportedAt','checkCollapse','canBuildAt','buildFloor','link','unlink','connectionAt','connectionsFrom',
 'reachable','route','transfer','reserveOn','releaseRemoteClaims','ambientTemperature','isOutdoorLevel',
 'lightAt','save','load','tick','stats','wealth','colonists'].forEach(fn => {
  if (typeof Levels[fn] !== 'function') ok(false, 'Levels.' + fn + ' is missing');
});
ok(true, 'every function the brief names is present');
ok(Levels.active === 0, 'active starts on the surface');
ok(Levels.setActive(-1) && Levels.active === -1 && Levels.activeMap() === Levels.get(-1).map,
   'setActive(-1) moves what the renderer should draw, and nothing else');
ok(Game.map === map, 'Game.map is untouched: the simulation does not care which level is on screen');
Levels.setActive(0);
let seen = 0, mapsSeen = 0;
Levels.forEach(() => seen++);
Levels.tickAll(m => { if (m && m.w) mapsSeen++; });
ok(seen === Levels.count() && mapsSeen === Levels.count(), 'forEach and tickAll cover every level');
console.log('  ' + JSON.stringify(Levels.stats().rows));

/* This runs last because it replaces Game.map, which would pull the
   ground out from under every section above it. */
hr('14. a worked basement, through a save file and back');
/* Section 12 shows that a colonist underground is missing from the
   file. That reads as a rounding error, and it is not: save.js
   serialises one map, so EVERYTHING on every other level goes with it.
   This digs a basement, works in it, and round-trips the colony
   through save.js to put a number on what a player loses. */
{
  Game.newGame({ seed: SEED, size: 70, colonists: 3 });
  Game.difficulty = { name: 'save gap', threatScale: 0 };
  runTicks(1000);
  const sm = Game.map;
  const cellar = Levels.ensure(-1);
  let dug = 0;
  for (let i = 0; i < cellar.map.size && dug < 40; i++) {
    const id = cellar.map.buildingId[i];
    if (!id) continue;
    const t = cellar.map.things.get(id);
    if (!t || !t.def || !t.def.mineable) continue;
    cellar.map.destroyThing(t, 'test'); dug++;
  }
  let head = null;
  for (let i = 0; i < cellar.map.size && !head; i++) {
    if (cellar.map.pathCost[i] === cellar.map.IMPASSABLE) continue;
    const x = cellar.map.xOf(i), y = cellar.map.yOf(i);
    if (sm.passable(x, y) && !sm.buildingAt(x, y)) head = { x, y };
  }
  if (head) Levels.link(-1, head.x, head.y, 'stairs');
  if (head) cellar.map.addItem('steel', head.x, head.y, 120);
  const zc = [];
  if (head) for (const [dx, dy] of U.cellsInRadius(head.x, head.y, 3))
    if (cellar.map.inBounds(dx, dy) && cellar.map.passable(dx, dy)) zc.push(cellar.map.idx(dx, dy));
  if (zc.length) Zones.add(cellar.map, 'stockpile', zc.slice(0, 8), { label: 'Cellar' });
  runTicks(400);

  const openOf = m => { let n = 0; for (let i = 0; i < m.size; i++) if (m.pathCost[i] !== m.IMPASSABLE) n++; return n; };
  const steelOf = m => { let n = 0; for (const t of m.byDef('steel')) if (t.spawned) n += t.stack; return n; };
  const was = { open: openOf(cellar.map), steel: steelOf(cellar.map),
                piles: Zones.stockpiles(cellar.map).length, conns: Levels.connections().length };
  console.log(`  a worked basement: ${was.open} open cells, ${was.steel} steel stored, ` +
              `${was.piles} stockpile, ${was.conns} staircase`);

  const file = JSON.parse(JSON.stringify(Save.serialize(Game)));
  const wired = Object.prototype.hasOwnProperty.call(file, 'levels');
  Save.deserialize(file);
  runTicks(10);
  const back = Levels.ensure(-1);          /* the player walks back down */
  const now = { open: openOf(back.map), steel: steelOf(back.map),
                piles: Zones.stockpiles(back.map).length, conns: Levels.connections().length };
  console.log(`  after save.js round-tripped it: ${now.open} open cells, ${now.steel} steel, ` +
              `${now.piles} stockpile, ${now.conns} staircase`);

  if (wired) {
    /* save.js grew the three lines. Then nothing may be lost. */
    ok(now.open === was.open, 'save.js now carries levels: the excavation came back');
    ok(now.steel >= was.steel, 'and the steel stored underground came back');
    ok(now.piles === was.piles && now.conns === was.conns, 'and the stockpile and the staircase came back');
  } else {
    /* It has not. Say the size of the hole out loud rather than let
       "three lines to go" read as cosmetic: this is the whole basement,
       not one missing colonist. */
    console.log(`  LOST: ${was.open - now.open} cells of excavation, ${was.steel - now.steel} steel, ` +
                `${was.piles - now.piles} stockpile, ${was.conns - now.conns} staircase, ` +
                `and anyone who was standing down there`);
    /* Not `steel === 0`: the level that regenerates has its own sealed
       vault, and vault loot includes steel. What is gone is the steel
       the colony put down there. */
    ok(now.open < was.open && now.steel < was.steel && now.piles === 0 && now.conns === 0,
       'save.js does not call Levels.load, so the basement is regenerated from scratch and every ' +
       'hour spent in it is lost - the gap is the whole level, not one pawn');
    ok(Levels.save() && Levels.save().levels.length > 0,
       'Levels.save() is ready and produces the record save.js is not yet asking for');
  }
}

console.log('\n' + (bad ? bad + ' FAILURE(S)' : 'every levels.js check passed'));
process.exit(bad ? 1 : 0);
