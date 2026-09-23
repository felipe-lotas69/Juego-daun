/* Runs four bots through every course headlessly and reports who
   finished. A course the AI cannot complete is a course a player
   will get stuck on too, so this is a design check, not an AI one.

   Run with: node tools/race-bots.js  (from the game folder)
           : node tools/race-bots.js DOWNTOWN   to trace one course */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'js');
/* Seeded, so two runs of the same course are the same race: weapon
   spread and knockback are random, and a course that passes only on a
   lucky roll has not passed. */
let seed = 0x2f6e2b1;
const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const reseed = (s0) => { seed = s0 >>> 0; };
const DetMath = Object.create(Math);
DetMath.random = rng;
const sandbox = { console, Math: DetMath, Date, JSON };
sandbox.window = undefined;
sandbox.globalThis = sandbox;
/* the camera is the only thing in world.js that wants a view size */
sandbox.Pixel = { W: 213, H: 120 };
vm.createContext(sandbox);
for (const f of ['engine.js', 'art.js', 'weapons.js', 'levels.js', 'world.js', 'bot.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
}

const { LEVELS, World, Bot } = sandbox;
const args = process.argv.slice(2);
const runs = Math.max(1, +(args.find(a => /^\d+$/.test(a)) || 1));
const only = args.find(a => !/^\d+$/.test(a));
const TRACE = !!only && runs === 1;
let bad = 0;
const tally = new Map();

for (let run = 0; run < runs; run++) {
for (const L of LEVELS) {
  if (only && L.name !== only) continue;
  /* reseeded per course, so tracing one race reproduces exactly the race
     that failed in the batch */
  reseed(0x2f6e2b1 + (run + (+process.env.RUN0 || 0)) * 0x9e3779b1 + L.name.length * 0x85ebca6b);
  const w = new World(L, {});
  const bots = [];
  for (let i = 0; i < 4; i++) {
    const r = w.addRacer({ index: i, isBot: true, keys: null });
    bots.push(new Bot(r, i));
  }
  const STEP = 1 / 120;
  const times = {};
  const samples = [];
  let t = 0;
  while (t < 150) {
    const inputs = w.racers.map((r, i) => bots[i].update(STEP, w));
    w.update(STEP, inputs);
    t += STEP;
    for (const r of w.racers) if (r.finished && times[r.name] === undefined) times[r.name] = +t.toFixed(1);
    if (TRACE && Math.abs(t % 3) < STEP) {
      samples.push(t.toFixed(0) + 's ' + w.racers.map(r =>
        `${r.name}@${Math.round(r.x)},${Math.round(r.y + r.h)}`).join(' '));
    }
    if (w.racers.every(r => r.finished)) break;
  }
  const done = w.racers.filter(r => r.finished).length;
  const span = L.goal.x - L.spawn.x;
  const prog = w.racers.map(r => Math.round(100 * (r.best - L.spawn.x) / span) + '%');
  const acc = tally.get(L.name) || { home: 0, of: 0, worst: 999, runs: 0 };
  acc.home += done; acc.of += 4; acc.runs++;
  acc.worst = Math.min(acc.worst, Math.min.apply(Math, w.racers.map(r => (r.best - L.spawn.x) / span)));
  tally.set(L.name, acc);
  if (runs === 1 || process.env.VERBOSE) {
    console.log(`${done === 4 ? 'OK  ' : 'FAIL'} ${L.name.padEnd(13)} ${done}/4 home  ` +
                `progress ${prog.join(' ')}  ${JSON.stringify(times)}`);
  }
  if (TRACE) samples.forEach(s => console.log('   ' + s));
}
}
if (runs > 1) {
  for (const [name, t] of tally) {
    console.log(`${t.home === t.of ? 'OK  ' : 'FAIL'} ${name.padEnd(13)} ${t.home}/${t.of} home over ` +
                `${t.runs} races  worst finish ${Math.round(t.worst * 100)}%`);
  }
}
for (const t of tally.values()) if (t.home < t.of) bad++;
console.log(bad === 0 ? '\nevery course completable by bot' : `\n${bad} course(s) trap the bots`);
process.exit(bad === 0 ? 0 : 1);
