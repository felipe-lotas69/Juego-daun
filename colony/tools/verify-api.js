/* The contract, as an executable check: every global the game promises,
   and every function on it that another file is allowed to call. A
   missing entry here is a crash waiting for the right save file.      */
'use strict';
const { load } = require('./harness.js');

const API = {
  U: ['rand', 'randInt', 'randRange', 'chance', 'pick', 'pickWeighted', 'shuffle', 'gauss',
      'seed', 'getSeed', 'setSeed', 'hash', 'clamp', 'clamp01', 'lerp', 'curve', 'dist',
      'distSq', 'manhattan', 'cheb', 'adjacent', 'cellsInRadius', 'MinHeap', 'nextId',
      'peekId', 'setIdCounter', 'remove', 'sum', 'minBy', 'maxBy', 'countBy', 'cap', 'fmt', 'pct'],
  Defs: ['add', 'get', 'has', 'maybe', 'all', 'index', 'fromIndex', 'count', 'thing', 'terrain',
         'recipe', 'research', 'trait', 'backstory', 'skill', 'workType', 'thought', 'body',
         'pawnKind', 'mentalState', 'incident', 'faction', 'items', 'buildings', 'plants',
         'buildables', 'validate'],
  Research: ['projects', 'available', 'start', 'current', 'addProgress', 'isDone',
             'unlockedThings', 'isUnlocked', 'reset', 'save', 'load'],
  GameMap: [],
  Thing: [],
  Regions: ['update', 'markDirty', 'rebuildAll', 'roomAt', 'rooms', 'sameArea', 'areaOf',
            'tickTemperature'],
  Path: ['find', 'findTo', 'reachable', 'closestReachable', 'stepCost', 'PE'],
  Zones: ['add', 'removeCells', 'delete', 'zoneAt', 'accepts', 'bestStorageFor', 'isStorageFor',
          'shouldHaul', 'growingCellsNeedingSow', 'categoryOf', 'CATEGORIES'],
  Health: ['create', 'tick', 'damage', 'capacity', 'moveSpeedFactor', 'workSpeedFactor', 'tend',
           'needsTending', 'isDowned', 'kill', 'summary', 'bleedRate', 'addHediff', 'heal'],
  Needs: ['create', 'tick', 'addThought', 'mood', 'breakdown', 'eat', 'wantsFood', 'wantsSleep',
          'wantsJoy', 'gainJoy', 'breakThreshold'],
  Pawn: [],
  T: ['thing', 'cell', 'pawn', 'resolve', 'pos', 'valid'],
  Res: ['canReserve', 'reserve', 'release', 'releaseAll', 'reservedBy'],
  Jobs: ['register', 'make', 'start', 'end', 'tick', 'report'],
  Toils: ['goto', 'wait', 'work', 'pickUp', 'dropCarried', 'putInStorage', 'custom'],
  Construct: ['canPlace', 'placeBlueprint', 'cancelAt', 'materialsNeeded', 'deliver', 'workOn',
              'finishFrame', 'deconstructWork', 'mineWork', 'completeMine'],
  Production: ['addBill', 'removeBill', 'billsReady', 'findIngredients', 'doRecipe', 'workAmount'],
  Plants: ['tick', 'tickRare', 'canSowAt', 'sow', 'harvest', 'growthRateAt', 'spawnWild',
           'startFire', 'tickFires'],
  Power: ['markDirty', 'update', 'tick', 'netOf', 'isPowered', 'lightAt', 'tempPushAt'],
  Combat: ['tick', 'tryAttack', 'hitChance', 'coverPenalty', 'lineOfSight', 'spawnProjectile',
           'explosion', 'canAttack', 'findTarget', 'hostile'],
  Animals: ['think', 'spawnWild', 'manhunterPack', 'tryTame', 'butcherProducts', 'tickRare'],
  WorkGivers: ['register', 'forType', 'tryGiveWorkJob', 'emergency'],
  Think: ['think', 'tickMental', 'startMentalState', 'endMentalState', 'draftedJob'],
  MapGen: ['generate', 'spawnStartingColony', 'makePawn', 'edgeSpawnCells'],
  Storyteller: ['tick', 'threatPoints', 'fire'],
  Incidents: ['register'],
  Game: ['newGame', 'doTick', 'setSpeed', 'colonists', 'msg', 'letter', 'day', 'hour',
         'timeOfDay', 'season', 'outdoorTemp', 'daylight', 'select', 'deselectAll'],
  Save: ['serialize', 'deserialize']
};

/* Methods that must exist on an instance rather than the constructor. */
const INSTANCE = {
  GameMap: ['idx', 'xOf', 'yOf', 'inBounds', 'terrainAt', 'setTerrain', 'buildingAt', 'plantAt',
            'items', 'itemsIdx', 'thing', 'byDef', 'pawnsAt', 'colonists', 'spawnThing',
            'despawnThing', 'destroyThing', 'addItem', 'moveThing', 'splitStack', 'passable',
            'walkCost', 'markPathDirty', 'designate', 'undesignate', 'designationAt',
            'hasRoofAt', 'wealth', 'tick', 'notePawnMoved']
};

const sb = load();
const missing = [];

Object.keys(API).forEach(g => {
  const obj = sb[g];
  if (!obj) { missing.push(`global ${g} does not exist`); return; }
  API[g].forEach(fn => {
    if (obj[fn] === undefined) missing.push(`${g}.${fn} is missing`);
  });
});

if (sb.GameMap) {
  let map = null;
  try { map = new sb.GameMap(24, 24); } catch (e) { missing.push('new GameMap(24,24) threw: ' + e.message); }
  if (map) {
    INSTANCE.GameMap.forEach(fn => {
      if (typeof map[fn] !== 'function') missing.push(`map.${fn}() is missing`);
    });
    ['terrain', 'buildingId', 'plantId', 'itemGrid', 'roof', 'pathCost', 'blood', 'areaId',
     'roomId', 'zoneId', 'things', 'pawns', 'designations', 'zones'].forEach(f => {
      if (map[f] === undefined) missing.push(`map.${f} grid/collection is missing`);
    });
  }
}

/* Every job id the contract's registry names must actually be registered,
   because a work giver that makes one would otherwise fail silently. */
const JOB_IDS = `goto wait waitCombat eat sleep layDown joyIdle wander haul haulToContainer
  construct deconstruct mine repair sow harvest cutPlant chopWood doBill research tendPatient
  rescue carryToBed feedPatient hunt slaughter tame trainAnimal attackMelee attackStatic flee
  equipWeapon wearApparel dropThing refuel flick clean extinguishFire bury releaseAnimal
  mentalWander mentalTantrum mentalBerserk mentalBinge mentalDaze`.split(/\s+/).filter(Boolean);

if (sb.Jobs && sb.Jobs.defs) {
  JOB_IDS.forEach(id => {
    const has = sb.Jobs.defs instanceof Map ? sb.Jobs.defs.has(id) : !!sb.Jobs.defs[id];
    if (!has) missing.push(`job def "${id}" was never registered`);
  });
} else if (sb.Jobs) {
  console.log('(Jobs.defs is not exposed, skipping the job registry check)');
}

console.log(`checked ${Object.keys(API).length} globals across ${sb.__loaded.length} scripts`);
if (missing.length) {
  console.error(`\n${missing.length} contract gap(s):`);
  missing.forEach(m => console.error('  - ' + m));
  process.exit(1);
}
console.log('api ok');
