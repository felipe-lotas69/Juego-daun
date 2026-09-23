/* Builds a real prison - a sealed cell block, a door, and a classroom on
   the other side of it - fills it with prisoners, enrols them, and checks
   that the regime can actually take somebody out of their cell.

   This exists because it could not. prison.js and reform.js both publish
   the same gesture for an authorised move (top up `prisoner.confineCool`
   every tick of the job) and prisoners.js never read it, so a prisoner
   walking to a class was indistinguishable from a prisoner walking out of
   the gate: an escape roll every 250 ticks for the whole trip, at a will
   of ~1.0 for a fresh raider. Six-session programmes therefore never
   finished in a live colony.

   Usage: node tools/verify-prison.js [days] [seed]                      */
'use strict';
const { load } = require('./harness.js');

const DAYS = Number(process.argv[2] || 4);
const SEED = Number(process.argv[3] || 77113);

const sb = load({ quiet: true });
const { Game, U, Regions, MapGen, Prisoners, Prison, Reform, Think, Jobs, WorkGivers } = sb;

let bad = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) bad++; };
const hr = s => console.log('\n=== ' + s + ' ===');

/* This file is meant to be runnable against the version of prisoners.js
   that did not have an authorisation window, so that the before and the
   after are the same measurement. Everything it asks for is asked through
   a fallback rather than assumed to exist. */
const HAS_WINDOW = typeof Prisoners.authorisedOut === 'function';
const authorisedOut = p =>
  HAS_WINDOW ? Prisoners.authorisedOut(p) : !!(p.prisoner && p.prisoner.confineCool > 0);

for (const name of ['Prisoners', 'Prison', 'Reform']) {
  if (!sb[name]) { console.log('FAIL: ' + name + ' did not load'); process.exit(1); }
}

/* ---------------------------------------------------------------
   1. A colony, and a prison built into it by hand

   Blueprints would work and would take three in-game days to finish,
   which is three days of the thing under test not being testable. The
   walls go straight down instead.
   --------------------------------------------------------------- */
hr('1. a prison with a classroom outside the cells');

Game.newGame({ seed: SEED, size: 90, colonists: 5, biome: 'temperateForest' });
Game.difficulty = { name: 'prison test', threatScale: 0 };   /* raids are not the subject */
const map = Game.map;
const colonists = map.colonists();

/* Somewhere flat, clear and reachable, near enough that wardens walk. */
const W = 16, H = 6;
function siteScore(ox, oy) {
  let score = 0;
  for (let y = oy; y < oy + H; y++) {
    for (let x = ox; x < ox + W; x++) {
      if (!map.inBounds(x, y)) return -1;
      const t = map.terrainAt(x, y);
      if (!t || t.passable === false || t.def && t.def.mineable) return -1;
      if (map.buildingAt(x, y)) return -1;
      if (!map.passable(x, y)) score -= 1;
    }
  }
  return score;
}
const home = colonists[0] ? { x: colonists[0].x, y: colonists[0].y } : { x: map.w >> 1, y: map.h >> 1 };
let site = null;
for (let r = 6; r <= 26 && !site; r += 2) {
  for (let a = 0; a < 32 && !site; a++) {
    const ang = (a / 32) * Math.PI * 2;
    const ox = Math.round(home.x + Math.cos(ang) * r) - (W >> 1);
    const oy = Math.round(home.y + Math.sin(ang) * r) - (H >> 1);
    if (siteScore(ox, oy) >= 0) site = { x: ox, y: oy };
  }
}
if (!site) { console.log('FAIL: nowhere flat enough to put a prison on seed ' + SEED); process.exit(1); }

/* Clear the footprint of trees, rocks and loose junk. */
for (const t of Array.from(map.things.values())) {
  if (t.x >= site.x && t.x < site.x + W && t.y >= site.y && t.y < site.y + H) map.destroyThing(t);
}

const wall = (x, y) => map.spawnThing('wall', x, y, { faction: 'player', stuff: 'steel' });
const DOOR_X = site.x + 6, DOOR_Y = site.y + 3;

for (let x = site.x; x < site.x + W; x++) { wall(x, site.y); wall(x, site.y + H - 1); }
for (let y = site.y + 1; y < site.y + H - 1; y++) {
  wall(site.x, y);
  wall(site.x + W - 1, y);
  /* The partition between the block and the classroom, with one door. */
  if (y !== DOOR_Y) wall(DOOR_X, y);
}
const door = map.spawnThing('door', DOOR_X, DOOR_Y, { faction: 'player', stuff: 'steel' });

/* And a way in from the colony, or the wardens can never reach the desk
   and the whole building is a sealed box the test would measure nothing
   inside of. The only route out of the block runs through the classroom. */
const GATE_X = site.x + 10, GATE_Y = site.y + H - 1;
const gateWall = map.buildingAt(GATE_X, GATE_Y);
if (gateWall) map.destroyThing(gateWall);
const gate = map.spawnThing('door', GATE_X, GATE_Y, { faction: 'player', stuff: 'steel' });

/* Roof both halves: an unroofed enclosure is outdoors, and outdoors is an
   escape opening in its own right under every version of this code. */
for (let y = site.y + 1; y < site.y + H - 1; y++) {
  for (let x = site.x + 1; x < site.x + W - 1; x++) map.setRoof(x, y, 1);
}
map.setRoof(DOOR_X, DOOR_Y, 1);
Regions.rebuildAll(map);

const cellRoom = Regions.roomAt(map, site.x + 2, site.y + 2);
const classRoom = Regions.roomAt(map, site.x + 10, site.y + 2);
ok(!!cellRoom && cellRoom.id !== 0 && !cellRoom.outdoor, 'the cell block is an indoor room');
ok(!!classRoom && classRoom.id !== 0 && !classRoom.outdoor, 'the classroom is an indoor room');
ok(cellRoom && classRoom && cellRoom.id !== classRoom.id,
   'they are two rooms, not one: ' + (cellRoom && cellRoom.id) + ' vs ' + (classRoom && classRoom.id));

/* Five bunks in the block, two desks in the classroom. */
const beds = [];
for (let i = 0; i < 5; i++) {
  const bed = map.spawnThing('bed', site.x + 1 + i, site.y + 1, { faction: 'player', stuff: 'wood' });
  if (!bed) continue;
  Prisoners.setBedForPrisoners(bed, true);
  beds.push(bed);
}
const desks = [];
for (let i = 0; i < 2; i++) {
  const d = map.spawnThing('classroomDesk', site.x + 9 + i * 3, site.y + 2, { faction: 'player' });
  if (d) desks.push(d);
}
Regions.rebuildAll(map);
ok(beds.length === 5, 'five prisoner bunks stand in the block: ' + beds.length);
ok(desks.length === 2, 'two classroom desks stand next door: ' + desks.length);

const prisonRooms = Prisoners.prisonRoomIds(map);
ok(!!prisonRooms[cellRoom.id], 'the block reads as a prison room');
ok(!prisonRooms[classRoom.id],
   'the classroom does not - which is the whole difficulty: a prisoner in it ' +
   'is, structurally, "out of their cell"');

/* ---------------------------------------------------------------
   2. Prisoners
   --------------------------------------------------------------- */
hr('2. five prisoners in the block');

const prisoners = [];
for (let i = 0; i < 5 && i < beds.length; i++) {
  const p = MapGen.makePawn('raider', 'raider', { map: map, x: beds[i].x, y: beds[i].y + 1, gear: false });
  if (!p) continue;
  map.addPawn(p, beds[i].x, beds[i].y + 1);
  p.downed = true;
  const took = Prisoners.capture(p, colonists[0]);
  p.downed = false;
  if (!took) continue;
  p.ownedBedId = beds[i].id;
  beds[i].ownerId = p.id;
  if (Prison.intake) Prison.intake(p);
  prisoners.push(p);
}
ok(prisoners.length === 5, 'five prisoners taken: ' + prisoners.length);

/* Somebody has to teach. The instruct column is the one colonists are
   never on by default, because it is the column of last resort. */
let teachers = 0;
for (const c of colonists) {
  if (!c.workPriority) c.workPriority = {};
  c.workPriority.instruct = 1;
  c.workPriority.warden = 1;
  if (c.skills && c.skills.intellectual) c.skills.intellectual.level = Math.max(c.skills.intellectual.level, 6);
  if (c.skills && c.skills.social) c.skills.social.level = Math.max(c.skills.social.level, 6);
  teachers++;
}
ok(teachers >= 2, teachers + ' colonists are cleared to instruct');

let enrolled = 0;
for (const p of prisoners) if (Reform.enrol(p, 'literacy', true)) enrolled++;
ok(enrolled === prisoners.length, enrolled + ' of ' + prisoners.length + ' enrolled in basic education');

/* ---------------------------------------------------------------
   3. The unit question, asked directly

   Put a prisoner in the classroom, authorise them the way prison.js and
   reform.js do, and ask prisoners.js what it sees.
   --------------------------------------------------------------- */
hr('3. what prisoners.js sees during an authorised move');

const subject = prisoners[0];
const classX = desks.length ? desks[0].x : site.x + 10;
const classY = (desks.length ? desks[0].y : site.y + 2) + 1;

/* Positions are set straight here rather than walked to: what is under
   test is the judgement prisoners.js makes about a tile, not the walk. */
function put(pawn, x, y) {
  if (pawn.stopPath) pawn.stopPath();
  pawn.x = x; pawn.y = y;
  map.reindexPawns();
}
const parked = colonists.map(c => ({ pawn: c, x: c.x, y: c.y }));
function sendEveryoneAway() {
  /* Further than a guard can see (11) and than supervision reaches (9). */
  for (const p of parked) put(p.pawn, 2 + (p.pawn.id % 3), 2 + (p.pawn.id % 5));
}
function bringEveryoneBack() { for (const p of parked) put(p.pawn, p.x, p.y); }

const subjectHome = { x: subject.x, y: subject.y };
const guard = colonists[0];

function authorise(on) {
  subject.prisoner.confineCool = on ? 120 : 0;
  if (subject.prisonState) subject.prisonState.escortTicks = on ? 120 : 0;
}

/* (a) in the classroom, unauthorised: still an escape opening, as it must
   be - that is a prisoner who simply walked out. */
sendEveryoneAway();
put(subject, classX, classY);
put(guard, classX + 1, classY);
authorise(false);
const unauth = Prisoners.escapeOpening(subject);
ok(unauth === 'they are out of their cell',
   'unauthorised, out of the block: "' + unauth + '"');

/* (b) the same tile, authorised, with a colonist in the room. This is the
   line the whole regime hangs on: before the fix it also read
   "they are out of their cell", so a prisoner walking to a class rolled
   for the horizon every 250 ticks and a six-session course never ran. */
authorise(true);
const authWatched = Prisoners.escapeOpening(subject);
ok(authWatched === null,
   'authorised and supervised: no opening (was "they are out of their cell")');
ok(HAS_WINDOW && Prisoners.authorisedOut(subject) === true,
   'Prisoners.authorisedOut reads the window back');

/* (c) authorised, but the escort has wandered off. An authorised move is
   not a blank cheque. */
sendEveryoneAway();
const authAlone = Prisoners.escapeOpening(subject);
ok(authAlone === 'nobody is watching them where they were sent',
   'authorised but unsupervised: still an opening - "' + authAlone + '"');

/* (d) back in the cell, a sealed block holds. */
put(subject, subjectHome.x, subjectHome.y);
authorise(false);
subject.prisoner.lastWatchedTick = Game.tick;
if (door) door.open = false;
const inCell = Prisoners.escapeOpening(subject);
ok(inCell === null, 'in a sealed cell with the door shut: no opening ("' + inCell + '")');

/* (e) the door left open is still a hole, authorisation or none. */
if (door) door.open = true;
const openDoor = Prisoners.escapeOpening(subject);
authorise(true);
const openDoorAuth = Prisoners.escapeOpening(subject);
if (door) door.open = false;
authorise(false);
ok(openDoor === 'a door left standing open', 'an open cell door is still an opening');
ok(openDoorAuth !== null,
   'and an authorised prisoner standing in a cell with the door open is not excused: "' +
   (openDoorAuth && openDoorAuth) + '"');

/* (f) a second, larger prison room is not "a hole in the wall". The size
   memory is a record of their OWN cell; judging them by whatever prison
   room they happen to be standing in reported every shared block, mess
   hall and infirmary bunk as a breach. */
const spareBunk = map.spawnThing('bed', classX + 2, classY - 1, { faction: 'player', stuff: 'wood' });
if (spareBunk) Prisoners.setBedForPrisoners(spareBunk, true);
Regions.rebuildAll(map);
const twoPrisons = Prisoners.prisonRoomIds(map);
put(subject, classX, classY);
subject.prisoner.cellCount = cellRoom.size;
subject.prisoner.lastWatchedTick = Game.tick;
const bigRoom = Prisoners.escapeOpening(subject);
ok(!!twoPrisons[classRoom.id], 'the classroom now counts as a second prison room');
ok(bigRoom === null,
   'a ' + classRoom.size + '-tile second block is not read as a hole in their ' +
   cellRoom.size + '-tile cell ("' + bigRoom + '")');
if (spareBunk) map.destroyThing(spareBunk);
Regions.rebuildAll(map);

/* Put the world back the way the sim expects to find it. */
put(subject, subjectHome.x, subjectHome.y);
bringEveryoneBack();
subject.prisoner.cellCount = 0;
authorise(false);

/* ---------------------------------------------------------------
   4. The live colony
   --------------------------------------------------------------- */
hr('4. ' + DAYS + ' days of it actually running');

/* A regime that actually schedules classes. The default day gives one
   'programme' hour out of twenty-four, which is a fine default and a
   terrible test: six sessions would need six clean days and any one riot
   would push it past the end of the run. This is the regime editor doing
   what a player would do with a block full of enrolled prisoners. */
for (const p of prisoners) {
  Prison.setRegime(p, [0, 24], 'sleep');
  Prison.setRegime(p, [7, 21], 'programme');
}
ok(Prison.scheduledActivity(prisoners[0], 12) === 'programme',
   'the block is on a teaching regime from 07:00 to 21:00');

/* Prisoners starve unless a warden brings dinner, and a colony that
   starved is not what is being measured. Needs are needs.js's subject and
   mood is think.js's; this file's subject is the door. */
function feed() {
  Game.gameOver = null;
  for (const p of map.pawns) {
    if (p.dead || !p.isHuman) continue;
    if (p.faction !== 'player' && !p.prisoner) continue;
    p.needs.food = Math.max(p.needs.food, 0.8);
    p.needs.rest = Math.max(p.needs.rest, 0.7);
    p.needs.joy = Math.max(p.needs.joy, 0.6);
    if (p.mentalState && Think && Think.endMentalState) Think.endMentalState(p, 'test');
  }
}

/* And somebody has to be standing at the front of the room. A five-pawn
   colony on landing day spends its afternoons fishing, so the instruct
   column is polled directly rather than waiting for a colonist to decide
   that teaching beats recreation. This is the work giver the game itself
   calls - it is only being asked more insistently. */
const teachGiver = WorkGivers.all().filter(g => g.id === 'reformRunSession')[0];
ok(!!teachGiver, 'the instruct column has a work giver for running sessions');
function staffTheClassroom() {
  if (!teachGiver) return;
  for (const c of colonists) {
    if (c.dead || c.downed || c.mentalState) continue;
    if (c.job && (c.job.defId === 'reformTeach' || c.job.defId === 'reformAttend')) continue;
    let job = null;
    try { job = teachGiver.tryGiveJob(c); } catch (e) { job = null; }
    if (!job) continue;
    if (c.job) Jobs.end(c, 'interrupted');
    Jobs.start(c, job);
    return;                       /* one teacher is a class; five is a crowd */
  }
}

const before = JSON.parse(JSON.stringify(Reform.state.stats));
let escapeBeats = 0, outOfCellBeats = 0, authorisedBeats = 0, attendBeats = 0;
/* The number the whole fix is about: beats on which a prisoner was out of
   their block WITH the colony's authorisation and prisoners.js still
   called it an escape opening. */
let openingsWhileAuthorised = 0;

const TICKS = DAYS * 60000;
for (let i = 0; i < TICKS; i++) {
  Game.doTick();
  if ((i % 500) === 0) feed();
  if ((i % 120) === 0) staffTheClassroom();
  if ((i % 60) === 0) {
    for (const p of prisoners) {
      if (p.dead || !p.prisoner) continue;
      if (p.prisoner.escaping) escapeBeats++;
      if (p.job && p.job.defId === 'reformAttend') attendBeats++;
      if (Regions.roomIdAt(map, p.x, p.y) !== cellRoom.id) {
        outOfCellBeats++;
        if (authorisedOut(p)) {
          authorisedBeats++;
          if (Prisoners.escapeOpening(p)) openingsWhileAuthorised++;
        }
      }
    }
  }
}
feed();

const st = Reform.state.stats;
const lit = st.byProgramme.literacy;
const held = prisoners.filter(p => !p.dead && p.prisoner).length;
const graduated = prisoners.filter(p => p.reform && p.reform.progress.literacy &&
                                        p.reform.progress.literacy.completed).length;

console.log('  sessions run          ' + (st.sessionsRun - before.sessionsRun));
console.log('  sessions abandoned    ' + (st.sessionsAbandoned - before.sessionsAbandoned));
console.log('  attendances           ' + (st.attendances - before.attendances));
console.log('  sessions passed       ' + (lit.successes - before.byProgramme.literacy.successes));
console.log('  graduations           ' + (st.graduations - before.graduations) +
            ' (' + graduated + ' of ' + prisoners.length + ' prisoners hold the certificate)');
console.log('  beats sat in a class  ' + attendBeats);
console.log('  beats mid-escape      ' + escapeBeats);
const dispo = {};
for (const k in st.dispositions) {
  const d = st.dispositions[k] - (before.dispositions[k] || 0);
  if (d) dispo[k] = d;
}
console.log('  prisoners still held  ' + held + ' of ' + prisoners.length);
console.log('  where the rest went   ' + (Object.keys(dispo).length ? JSON.stringify(dispo) : 'nowhere'));
console.log('  beats out of the block ' + outOfCellBeats + ', ' + authorisedBeats +
            ' of them authorised (' +
            (outOfCellBeats ? Math.round(100 * authorisedBeats / outOfCellBeats) : 0) + '%)');
console.log('  of those authorised beats, ' + openingsWhileAuthorised + ' were still read as ' +
            'an escape opening (' +
            (authorisedBeats ? Math.round(100 * openingsWhileAuthorised / authorisedBeats) : 0) + '%)');

ok(st.sessionsRun - before.sessionsRun > 0,
   'classes were held: ' + (st.sessionsRun - before.sessionsRun));
ok(st.attendances - before.attendances > 0,
   'prisoners sat in them: ' + (st.attendances - before.attendances));
ok(attendBeats > 0, 'and were in the classroom, out of their cells, while they did');
ok(outOfCellBeats > 0, 'prisoners left the block at all');
ok(authorisedBeats === 0 || openingsWhileAuthorised / authorisedBeats < 0.35,
   'an authorised move is mostly not an escape opening any more: ' +
   openingsWhileAuthorised + '/' + authorisedBeats);
ok(outOfCellBeats === 0 || authorisedBeats / outOfCellBeats > 0.75,
   'nearly every beat spent out of the block was an authorised one: ' +
   authorisedBeats + '/' + outOfCellBeats);
ok(graduated > 0,
   'somebody finished the six-session programme: ' + graduated + ' graduate(s), ' +
   (lit.successes - before.byProgramme.literacy.successes) + ' sessions passed');
/* They are allowed to leave through the gate - parole after a programme
   is the point of running programmes - but not over the wall. */
const escaped = st.dispositions.escaped - before.dispositions.escaped;
ok(escaped <= 1,
   'at most one got over the wall across ' + DAYS + ' days of open classes: ' + escaped);
ok(held + (dispo.paroled || 0) + (dispo.released || 0) + (dispo.recruited || 0) >= 3,
   'most of the five left through the gate or not at all: ' + held + ' held, ' +
   (dispo.paroled || 0) + ' paroled, ' + (dispo.released || 0) + ' released, ' +
   (dispo.recruited || 0) + ' recruited');

console.log(bad ? '\n' + bad + ' failure(s)' : '\nprison ok');
process.exit(bad ? 1 : 0);
