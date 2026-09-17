/* A respawn point inside a hazard's sweep is a death loop: you come back,
   you die, you come back. Check every checkpoint (and every spawn) against
   every hazard's full travel and every crusher's full travel. */
const fs = require('fs'), vm = require('vm');
const sb = { window: {} }; vm.createContext(sb);
vm.runInContext(fs.readFileSync('js/levels.js', 'utf8'), sb);
vm.runInContext(fs.readFileSync('js/versusmaps.js', 'utf8'), sb);

const PW = 24, PH = 44;
const overlap = (a, b) => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

function hazSweep(h) {
  const x = Math.min(h.x, h.bx == null ? h.x : h.bx);
  const y = Math.min(h.y, h.by == null ? h.y : h.by);
  const w = Math.abs((h.bx == null ? h.x : h.bx) - h.x) + h.w;
  const hh = Math.abs((h.by == null ? h.y : h.by) - h.y) + h.h;
  if (h.type === 'saw')   return { x: x + 8, y: y + 8, w: w - 16, h: hh - 16, tag: 'saw' };
  if (h.type === 'spike') return { x: x + 2, y: y + 8, w: w - 4,  h: hh - 8,  tag: 'spike' };
  return { x, y, w, h: hh, tag: h.type };
}
function crusherSweep(e) {
  const x = Math.min(e.x, e.bx == null ? e.x : e.bx);
  const y = Math.min(e.y, e.by == null ? e.y : e.by);
  return { x, y,
    w: Math.abs((e.bx == null ? e.x : e.bx) - e.x) + e.w,
    h: Math.abs((e.by == null ? e.y : e.by) - e.y) + e.h, tag: 'crusher' };
}

let bad = 0;
for (const [setName, SET] of [['campaign', sb.window.LEVELS], ['versus', sb.window.VERSUS_MAPS]]) {
  SET.forEach((L, li) => {
    const danger = (L.hazards || []).map(hazSweep)
      .concat((L.elevators || []).filter(e => e.crusher).map(crusherSweep));

    const points = [];
    (L.spawns || [L.spawn]).forEach((s, i) => points.push({ tag: 'spawn' + i, x: s.x, y: s.y }));
    (L.checkpoints || []).forEach((c, i) => points.push({ tag: 'checkpoint' + i, x: c.x, y: c.y }));

    points.forEach(pt => {
      const box = { x: pt.x - PW / 2, y: pt.y - PH, w: PW, h: PH };
      danger.forEach(d => {
        if (overlap(box, d)) {
          bad++;
          console.log(`${setName} L${li + 1} ${L.name}: ${pt.tag} @${pt.x},${pt.y} respawns inside a ${d.tag} sweep`);
        }
      });
      // also: is there any floor under it at all?
      const floors = (L.platforms || []).concat((L.glass || []).map(g => ({ ...g })));
      const supported = floors.some(f =>
        pt.x >= f.x - 14 && pt.x <= f.x + f.w + 14 && Math.abs(f.y - pt.y) < 26);
      if (!supported) console.log(`${setName} L${li + 1} ${L.name}: ${pt.tag} @${pt.x},${pt.y} has no floor directly under it`);
    });
  });
}
console.log(bad ? `\n${bad} respawn point(s) sit inside something lethal` : '\nno respawn point sits inside a hazard');
if (bad) process.exit(1);
