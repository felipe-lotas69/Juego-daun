/* Every def in the game, checked against the contract's ID registry and
   against itself. A missing cross-reference here is a crash later. */
'use strict';
const { load } = require('./harness.js');

const REGISTRY = {
  terrain: `soil richSoil gravel sand marsh shallowWater deepWater rockFloor mud
            woodFloor stoneFloor concreteFloor steelFloor carpet`,
  thing: `wood steel components silver stoneChunk stoneBlocks cloth leather herbalMedicine
          medicine chemfuel riceRaw potatoRaw cornRaw berries meatRaw mealSimple mealFine
          kibble knife club spear shortBow pistol boltRifle autoRifle shotgun sniperRifle
          shirt pants jacket parka armorVest helmet wall door rockWall compactedSteel
          compactedComponents compactedSilver bed sleepingSpot table stool dresser grave
          sculpture standingLamp campfire stove butcherTable craftingSpot stonecutterTable
          tailoringBench smithy researchBench solarPanel windTurbine woodGenerator battery
          conduit heater cooler sandbags turret spikeTrap blueprint frame corpse bullet arrow
          fire filthBlood grass tallGrass bush healroot berryBush treeOak treePine plantRice
          plantPotato plantCorn plantCotton plantHealroot`,
  skill: `shooting melee construction mining cooking plants animals crafting artistic medicine
          social intellectual`,
  workType: `firefight patient doctor bedRest basic warden handle cook hunt construct grow mine
             plantCut craft haul clean research`,
  body: 'human quadruped bird',
  faction: 'player raider wild neutral',
  pawnKind: 'colonist raider tribalRaider wanderer hare deer muffalo boomrat wolf bear',
  mentalState: 'sadWander tantrum berserk foodBinge daze panicFlee runWild'
};

/* Work types a design decision may legitimately drop, and defs that only
   exist if a system shipped. Anything else missing is a failure. */
const OPTIONAL = new Set(['warden', 'chemfuel', 'spikeTrap', 'kibble', 'dresser', 'sculpture']);

let failures = [];
function fail(msg) { failures.push(msg); }

const sb = load();
const { Defs, U } = sb;
Defs.finalize();

/* 1. The registry: everything the contract promised exists. */
Object.keys(REGISTRY).forEach(category => {
  REGISTRY[category].split(/\s+/).filter(Boolean).forEach(id => {
    if (!Defs.has(category, id) && !OPTIONAL.has(id)) {
      fail(`missing ${category}/${id}`);
    }
  });
});

/* 2. Reference integrity, as defs.js sees it. */
Defs.validate().forEach(fail);

/* 3. Recipes and workbenches have to agree in both directions, or a bill
      appears on a bench that cannot do it (or never appears at all). */
Defs.all('recipe').forEach(r => {
  (r.workbenches || []).forEach(b => {
    if (!Defs.has('thing', b)) return fail(`recipe/${r.id} workbench -> missing thing/${b}`);
    const bench = Defs.thing(b);
    if (bench.recipes && bench.recipes.indexOf(r.id) < 0) {
      fail(`thing/${b}.recipes does not list recipe/${r.id} although the recipe names the bench`);
    }
  });
  if (!r.workbenches || !r.workbenches.length) fail(`recipe/${r.id} has no workbench`);
  /* A butchering recipe's products come from the corpse it consumes, so an
     empty product table is correct there and only there. */
  const dynamic = r.butcher || r.productsFromIngredient || r.dynamicProducts;
  if (!dynamic && (!r.products || !Object.keys(r.products).length)) {
    fail(`recipe/${r.id} produces nothing`);
  }
  if (!r.workAmount) fail(`recipe/${r.id} has no workAmount`);
});

/* 4. Research unlocks point at something real, and everything gated by
      research is unlockable by some project. */
const unlocked = new Set();
Defs.all('research').forEach(p => {
  if (!p.cost) fail(`research/${p.id} has no cost`);
  (p.unlocks || []).forEach(u => {
    if (!Defs.has('thing', u) && !Defs.has('recipe', u)) {
      fail(`research/${p.id} unlocks -> missing thing or recipe "${u}"`);
    }
    unlocked.add(u);
  });
  (p.prerequisites || []).forEach(q => {
    if (!Defs.has('research', q)) fail(`research/${p.id} prerequisite -> missing research/${q}`);
  });
});
Defs.all('thing').concat(Defs.all('recipe')).forEach(d => {
  if (d.researchPrerequisite && !unlocked.has(d.id)) {
    fail(`${d.defCategory}/${d.id} needs research ${d.researchPrerequisite} but no project unlocks it`);
  }
});

/* 5. Buildables are actually buildable: a cost, work, a category, and
      materials that exist as items. */
Defs.all('thing').forEach(d => {
  if (!d.buildCategory) return;
  if (!d.workToBuild) fail(`thing/${d.id} is buildable with no workToBuild`);
  /* An explicitly empty cost table means free on purpose (a sleeping spot,
     a crafting spot, a grave); a missing one means somebody forgot. */
  const cost = d.buildCost || d.costList;
  if (!d.stuffable && !cost) fail(`thing/${d.id} is buildable with no cost table`);
});

/* 6. Bodies: capacities add up and every part has a parent that exists. */
Defs.all('body').forEach(body => {
  const parts = body.parts || [];
  const names = new Set(parts.map(p => p.defName));
  let totals = {};
  parts.forEach(p => {
    if (p.parent && !names.has(p.parent)) fail(`body/${body.id} part ${p.defName} -> missing parent ${p.parent}`);
    Object.keys(p.capacities || {}).forEach(c => { totals[c] = (totals[c] || 0) + p.capacities[c]; });
  });
  ['consciousness', 'moving', 'manipulation'].forEach(c => {
    if (body.id === 'human' && Math.abs((totals[c] || 0) - 1) > 0.001) {
      fail(`body/human capacity ${c} sums to ${totals[c]}, expected 1.0`);
    }
  });
});

/* 7. Pawn kinds can be built: a body, a diet, a move speed. */
Defs.all('pawnKind').forEach(k => {
  if (!Defs.has('body', k.body)) fail(`pawnKind/${k.id} -> missing body/${k.body}`);
  if (!k.moveSpeed) fail(`pawnKind/${k.id} has no moveSpeed`);
  if (k.isAnimal && !k.diet) fail(`pawnKind/${k.id} is an animal with no diet`);
});

/* 8. Plants grow and yield something harvestable that exists. */
Defs.plants().forEach(d => {
  const p = d.plant;
  if (!p) return fail(`thing/${d.id} is category plant with no plant block`);
  if (!p.growDays) fail(`plant ${d.id} has no growDays`);
  if (p.harvestedThing && !Defs.has('thing', p.harvestedThing)) {
    fail(`plant ${d.id} harvests missing thing/${p.harvestedThing}`);
  }
  if (p.sowable && !p.harvestedThing) fail(`plant ${d.id} is sowable but yields nothing`);
});

console.log(`loaded ${sb.__loaded.length} scripts`);
['terrain', 'thing', 'recipe', 'research', 'trait', 'backstory', 'thought', 'pawnKind'].forEach(c => {
  console.log(`  ${c}: ${Defs.count(c)}`);
});

if (failures.length) {
  console.error(`\n${failures.length} def problem(s):`);
  failures.slice(0, 60).forEach(f => console.error('  - ' + f));
  if (failures.length > 60) console.error(`  ... and ${failures.length - 60} more`);
  process.exit(1);
}
console.log('\ndefs ok');
