/* Boots the whole game - renderer, UI and input included - against a stub
   DOM, starts a colony and runs frames. It cannot tell you the game looks
   right; it tells you it does not throw, which for a 33-file browser game
   with no build step is the check that actually catches things.

   Usage: node tools/verify-client.js [frames]                           */
'use strict';
const { load } = require('./harness.js');
const domstub = require('./domstub.js');

const FRAMES = Number(process.argv[2] || 240);
const problems = [];
const fail = m => problems.push(m);

let dom;
const sb = load({
  includeClient: true,
  prepare: sandbox => { dom = domstub.install(sandbox, { width: 1600, height: 900 }); return dom; }
});

console.log(`loaded ${sb.__loaded.length} scripts (client included)`);

const { Game, UI, Render, Art, Input, U } = sb;
['Art', 'Render', 'UI', 'Input', 'Game'].forEach(g => { if (!sb[g]) fail(`global ${g} is missing`); });
if (problems.length) { problems.forEach(p => console.error('  - ' + p)); process.exit(1); }

/* main.js boots itself on load because readyState is 'complete'. */
if (typeof Art.sprite !== 'function' && typeof Art.terrain !== 'function') {
  fail('Art exposes neither sprite() nor terrain()');
}

try {
  Game.newGame({ seed: 4242, size: 80, colonists: 3 });
} catch (e) {
  fail('Game.newGame threw: ' + (e.stack || e));
}
if (problems.length) { problems.forEach(p => console.error('  - ' + p)); process.exit(1); }

if (UI.hideMenu) { try { UI.hideMenu(); } catch (e) { fail('UI.hideMenu threw: ' + e.message); } }
if (Render.centerOn && Game.colonists().length) {
  const c = Game.colonists()[0];
  try { Render.centerOn(c.x, c.y); } catch (e) { fail('Render.centerOn threw: ' + e.message); }
}

/* Run frames through main.js's own requestAnimationFrame loop. */
Game.setSpeed(3);
let threw = null;
try {
  dom.runFrames(FRAMES);
} catch (e) {
  threw = e;
}
if (threw) fail('frame loop threw: ' + (threw.stack || threw));

const drew = (dom.counters.drawImage || 0) + (dom.counters.fillRect || 0);
console.log(`after ${FRAMES} frames: tick ${Game.tick}, ${drew} draw calls, ` +
            `${dom.counters.innerHTML || 0} innerHTML writes, ${dom.listeners.length} listeners`);

if (!drew) fail('the renderer never drew anything');
if (Game.tick === 0) fail('the simulation never advanced a tick through the frame loop');

/* Poke the UI the way a player would, and make sure nothing explodes. */
function tryCall(label, fn) {
  try { fn(); } catch (e) { fail(label + ' threw: ' + (e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e)); }
}
['work', 'research', 'colonists', 'schedule'].forEach(t => {
  if (UI.openTab) tryCall('UI.openTab(' + t + ')', () => { UI.openTab(t); UI.update(); });
});
if (UI.closeTab) tryCall('UI.closeTab', () => UI.closeTab());

const pawn = Game.colonists()[0];
if (pawn) {
  tryCall('select a colonist', () => { Game.select(pawn); UI.refreshInspect && UI.refreshInspect(); UI.update(); });
  tryCall('draft a colonist', () => { if (pawn.draft) { pawn.draft(); UI.update(); pawn.undraft(); } });
}
if (UI.setTool) {
  tryCall('pick a build tool', () => { UI.setTool({ kind: 'build', defId: 'wall', rot: 0, stuffId: 'wood' }); });
  tryCall('render with a build ghost', () => dom.runFrames(5));
  tryCall('clear the tool', () => UI.clearTool && UI.clearTool());
}
if (UI.save && UI.load) {
  tryCall('save to localStorage', () => UI.save());
  tryCall('load from localStorage', () => UI.load());
}
['none', 'zones', 'power', 'rooms', 'beauty', 'temperature'].forEach(o => {
  tryCall('overlay ' + o, () => { UI.overlay = o; dom.runFrames(2); });
});
UI.overlay = 'none';

tryCall('run more frames after poking', () => dom.runFrames(60));

if (problems.length) {
  console.error(`\n${problems.length} client failure(s):`);
  problems.forEach(p => console.error('  - ' + p));
  process.exit(1);
}
console.log('\nclient ok');
