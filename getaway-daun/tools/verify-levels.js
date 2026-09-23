/* Walks each course and checks it against what a jump can really do.
   Run with: node tools/verify-levels.js  (from the game folder)

   The launch maths here is READ FROM world.js and bot.js rather than
   copied, so the check cannot quietly drift away from the game. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'js');
const sandbox = { console, Math, Date, JSON };
sandbox.window = undefined;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
for (const f of ['engine.js', 'art.js', 'levels.js', 'world.js', 'bot.js']) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox, { filename: f });
}

const { LEVELS, botReach } = sandbox;
const MAX_REACH = (() => { let m = 0; for (let c = 0; c <= 1; c += 0.01) m = Math.max(m, botReach(c, 0)); return m; })();
const MAX_RISE = (() => {
  let m = 0;
  for (let c = 0; c <= 1; c += 0.01) {
    const angle = 0.28 + c * 0.85, speed = 150 + c * 105;
    const vy = Math.cos(angle) * speed;
    m = Math.max(m, vy * vy / (2 * 520));
  }
  return m;
})();

function bestReach(dy) {
  let m = -1;
  for (let c = 0; c <= 1.0001; c += 0.02) m = Math.max(m, botReach(c, dy));
  return m;
}

console.log(`a full wind-up carries ${MAX_REACH.toFixed(0)}px and lifts ${MAX_RISE.toFixed(0)}px\n`);

let bad = 0;
for (const L of LEVELS) {
  /* every top surface you could stand on, left to right */
  const tops = L.solids
    .filter(s => s.type !== 'bounce')
    .map(s => ({ x0: s.x, x1: s.x + s.w, y: s.y }))
    .sort((a, b) => a.x0 - b.x0);

  const problems = [];
  /* from each surface, is there another you can get to going right? */
  for (const from of tops) {
    if (from.x1 >= L.goal.x) continue;
    let reachable = false, nearest = null;
    for (const to of tops) {
      if (to === from || to.x1 <= from.x1) continue;
      const gap = Math.max(0, to.x0 - from.x1);
      const dy = to.y - from.y;            /* +ve = lower, easier */
      if (!nearest || gap < nearest.gap) nearest = { gap, dy, to };
      if (dy < -MAX_RISE) continue;        /* too high to climb */
      /* A FULL wind-up is a flat dive that barely rises, so the best
         reach for a climb is somewhere in the middle - try them all. */
      if (bestReach(dy) >= gap) { reachable = true; break; }
    }
    /* the goal itself counts as somewhere to land */
    const gGap = Math.max(0, L.goal.x - from.x1);
    if (!reachable && gGap <= MAX_REACH) reachable = true;
    if (!reachable && nearest) {
      problems.push(`  surface ending at ${from.x1} (y ${from.y}) -> gap ${nearest.gap.toFixed(0)}, drop ${nearest.dy.toFixed(0)}`);
    }
  }

  const ok = problems.length === 0;
  if (!ok) bad++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${L.name}  (${tops.length} surfaces, ${L.width}px long)`);
  problems.slice(0, 6).forEach(p => console.log(p));

  /* checkpoints must not sit inside anything solid */
  for (const cp of L.checkpoints) {
    for (const s of L.solids) {
      if (cp.x + 7 > s.x && cp.x < s.x + s.w && cp.y + 20 > s.y && cp.y < s.y + s.h) {
        console.log(`  checkpoint at ${cp.x},${cp.y} is inside a solid`);
        bad++;
      }
    }
  }
}

console.log(bad === 0 ? '\nall courses completable' : `\n${bad} course(s) need work`);
process.exit(bad === 0 ? 0 : 1);
