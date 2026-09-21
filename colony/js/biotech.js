/* ============================================================
   biotech.js - genes, xenotypes, children and mechanitors.

   Four systems that share one idea: a pawn is not a fixed thing.
   Genes rewrite what a body can do, a xenotype is a gene set with a
   name and a people behind it, a child is a pawn who is still
   becoming one, and a mech is a body with no one home until a
   mechanitor lends it a mind.

   Nothing here edits a file it does not own. Content goes in through
   Defs.add, behaviour through Jobs.register and WorkGivers.register,
   hediffs are added to the open table health.js exposes, and the four
   places the engine offers no hook are reached by chaining the
   existing function and calling it. Every chain is idempotent.

   Two design notes worth stating once:

   - A gene with a stat or need effect is expressed as a hidden trait
     def with commonality 0. That is not a dodge: traits are already
     the path pawn.js and needs.js read for move speed, work speed,
     learning, hunger and rest, and reusing it means a gene is felt by
     every system in the game rather than by the ones that remembered
     to ask Biotech. pawn.invalidateTraitCache() is called on every
     change, which is exactly what it is there for.
   - A mech is a pawn with isHuman true, because Think.workJob asks
     that question before it hands out work and a second AI is the one
     thing the brief forbids. GameMap.colonists is chained to drop
     them again, so game-over, the alert list and the raid maths still
     count people rather than machines.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;
  var T = root.T, Res = root.Res, Jobs = root.Jobs, Toils = root.Toils, Path = root.Path;

  function sys(name) { return root[name] || null; }
  function now() {
    var G = root.Game;
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }
  function msg(text, kind, pawn) {
    var G = root.Game;
    if (!G || !G.msg) return;
    G.msg(text, { type: kind || 'info', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }
  function letter(title, text, kind, pawn) {
    var G = root.Game;
    if (!G || !G.letter) { msg(title, kind, pawn); return; }
    G.letter(title, text, { kind: kind || 'neutral', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }
  function thought(pawn, id, opts) {
    var N = sys('Needs');
    if (N && N.addThought && pawn && pawn.thoughts) N.addThought(pawn, id, opts);
  }
  function nameOf(pawn) {
    if (!pawn || !pawn.name) return 'someone';
    return pawn.name.nick || pawn.name.first || 'someone';
  }

  var TICKS_PER_DAY = 60000;
  var TICKS_PER_YEAR = TICKS_PER_DAY * 60;
  var RARE = 250;

  var Biotech = {};

  /* ============================================================
     1. CONTENT

     Field templates are restated rather than imported: def_things.js
     keeps its own private, and every consumer reads these fields
     without a guard, so all of them have to be present.
     ============================================================ */

  var BUILDING_BLOCK = {
    isBed: false, isTable: false, isChair: false, isWorkbench: false,
    isDoor: false, isGrave: false, isTurret: false, isBattery: false,
    isConduit: false, isLamp: false, isGenerator: false, isResearchBench: false,
    isStove: false, isCampfire: false, isTrap: false, isSandbag: false,
    powerProduced: 0, powerConsumed: 0, batteryCapacity: 0, lightRadius: 0,
    tempPushTarget: null, tempPushRate: 0,
    bedRestEffectiveness: 0, bedComfort: 0, canBeForPrisoners: false,
    fuelDefId: null, fuelCapacity: 0, fuelBurnPerDay: 0,
    turretRange: 0, turretWeapon: null, interactionOffset: null,
    openTicks: 0
  };
  function bld(o) {
    var out = {}, k;
    for (k in BUILDING_BLOCK) out[k] = BUILDING_BLOCK[k];
    if (o) for (k in o) out[k] = o[k];
    return out;
  }

  var ITEM = {
    category: 'item', description: '',
    sprite: 'item', color: '#b0b0b8', color2: null,
    stackLimit: 25, mass: 1, marketValue: 1,
    nutrition: 0, foodType: null, rotDays: null,
    isMedicine: false, medicinePotency: 0,
    passable: true, pathCost: 0, fillPercent: 0, blocksLight: false, holdsRoof: false,
    size: { w: 1, h: 1 }, rotatable: false, hp: 60, flammable: false,
    beauty: 0, comfort: 0, natural: false,
    buildCost: null, stuffable: false, workToBuild: 0, buildSkill: null,
    buildCategory: null, researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null,
    building: null, weapon: null, apparel: null
  };
  var BUILDING = (function () {
    var out = {}, k;
    for (k in ITEM) out[k] = ITEM[k];
    out.category = 'building'; out.sprite = 'box'; out.stackLimit = 1;
    out.mass = 40; out.marketValue = 0; out.hp = 180;
    out.passable = false; out.fillPercent = 1; out.buildSkill = 'construction';
    out.building = bld({});
    return out;
  })();

  Defs.add('research', {
    xenogenetics: {
      label: 'xenogenetics', cost: 2200, techLevel: 'spacer', tab: 'advanced',
      description: 'Read a genome off a living body and write it down. The extractor is ' +
        'the first half of every gene the colony will ever own.',
      prerequisites: ['electricity'],
      unlocks: ['geneExtractor', 'genepack'],
      uiPosition: { x: 4, y: 0 }
    },
    xenogermination: {
      label: 'xenogermination', cost: 3200, techLevel: 'spacer', tab: 'advanced',
      description: 'Splice packed genes into one germline and push it into somebody who ' +
        'was born without it. They will be ill for days and different afterwards.',
      prerequisites: ['xenogenetics'],
      unlocks: ['geneAssembler', 'xenogerm'],
      uiPosition: { x: 5, y: 0 }
    },
    growthVats: {
      label: 'growth vats', cost: 2600, techLevel: 'spacer', tab: 'advanced',
      description: 'A pressure tank, a nutrient loop and eighteen days of patience. ' +
        'Children without a pregnancy, if you can spare the power.',
      prerequisites: ['xenogenetics'],
      unlocks: ['growthVat'],
      uiPosition: { x: 4, y: 1 }
    },
    basicMechtech: {
      label: 'basic mechtech', cost: 2800, techLevel: 'spacer', tab: 'advanced',
      description: 'A mechlink in a colonist\'s skull and a gestator to grow bodies for it ' +
        'to drive. Labour mechs never sleep and never complain.',
      prerequisites: ['machining'],
      unlocks: ['mechlink', 'mechGestator', 'mechRecharger', 'mechShell', 'gestateMechShell'],
      uiPosition: { x: 4, y: 2 }
    },
    standardMechtech: {
      label: 'standard mechtech', cost: 4000, techLevel: 'spacer', tab: 'advanced',
      description: 'Heavier frames and a weapon mount. A militor will not win a war for ' +
        'you, but it will stand in front of somebody who would otherwise be shot.',
      prerequisites: ['basicMechtech'],
      unlocks: [],
      uiPosition: { x: 5, y: 2 }
    }
  });

  Defs.add('thing', {
    genepack: {
      label: 'genepack', sprite: 'medkit', color: '#6fa8dc', color2: '#c9a24a',
      description: 'A sealed cassette holding a handful of genes read off somebody else. ' +
        'Useless alone; an assembler turns a shelf of these into a xenogerm.',
      stackLimit: 1, mass: 1, marketValue: 220, hp: 50,
      researchPrerequisite: 'xenogenetics'
    },
    xenogerm: {
      label: 'xenogerm', sprite: 'medkit', color: '#9a6bd0', color2: '#ffc23c',
      description: 'A finished germline, keyed to one recipient. Implanting it rewrites ' +
        'them, and rewriting a body takes days it spends in bed.',
      stackLimit: 1, mass: 1, marketValue: 900, hp: 50,
      researchPrerequisite: 'xenogermination'
    },
    mechlink: {
      label: 'mechlink', sprite: 'component', color: '#8f97a3', color2: '#c0392b',
      description: 'A band of archotech lace that grows into the wearer\'s skull and gives ' +
        'them a second set of hands, then six more.',
      stackLimit: 1, mass: 1, marketValue: 1400, hp: 40,
      researchPrerequisite: 'basicMechtech'
    },
    mechShell: {
      label: 'mech shell', sprite: 'box', color: '#5a5a62', color2: '#6fa8dc',
      description: 'An inert mechanoid body with nothing driving it. A mechanitor can wake ' +
        'one into whichever frame the colony has bandwidth for.',
      stackLimit: 1, mass: 25, marketValue: 350, hp: 120,
      researchPrerequisite: 'basicMechtech'
    }
  }, ITEM);

  Defs.add('thing', {
    geneExtractor: {
      label: 'gene extractor', sprite: 'research', color: '#4f6b8a', color2: '#6fa8dc',
      description: 'Sequencing gear and a very cold drawer. Somewhere on the map and powered ' +
        'is enough: the surgery happens wherever the subject is lying.',
      size: { w: 2, h: 1 }, rotatable: true, hp: 200, mass: 120,
      buildCost: { steel: 80, components: 6 }, workToBuild: 2200,
      buildCategory: 'production', researchPrerequisite: 'xenogenetics',
      beauty: -1,
      building: bld({ isWorkbench: true, powerConsumed: 120, interactionOffset: { dx: 0, dy: 1 } })
    },
    geneAssembler: {
      label: 'gene assembler', sprite: 'research', color: '#5a4a7a', color2: '#9a6bd0',
      description: 'Where a shelf of genepacks becomes one xenogerm. Slow, hungry for power, ' +
        'and the only thing standing between your colonists and somebody else\'s biology.',
      size: { w: 2, h: 1 }, rotatable: true, hp: 200, mass: 130,
      buildCost: { steel: 100, components: 8 }, workToBuild: 2600,
      buildCategory: 'production', researchPrerequisite: 'xenogermination',
      beauty: -1,
      building: bld({ isWorkbench: true, powerConsumed: 200, interactionOffset: { dx: 0, dy: 1 } })
    },
    growthVat: {
      label: 'growth vat', sprite: 'box', color: '#2f5d78', color2: '#8fd0c0',
      description: 'A tank of warm liquid and a nutrient line. Eighteen days of power buys ' +
        'a child nobody had to carry.',
      size: { w: 1, h: 2 }, rotatable: true, hp: 220, mass: 140,
      buildCost: { steel: 120, components: 6 }, workToBuild: 2400,
      buildCategory: 'production', researchPrerequisite: 'growthVats',
      beauty: -1,
      building: bld({ powerConsumed: 250, interactionOffset: { dx: 1, dy: 0 } })
    },
    mechGestator: {
      label: 'mech gestator', sprite: 'smithy', color: '#4a4a52', color2: '#c0392b',
      description: 'Steel goes in, a body comes out with nothing in it. Waking one is a ' +
        'mechanitor\'s job.',
      size: { w: 2, h: 2 }, rotatable: false, hp: 240, mass: 200,
      buildCost: { steel: 150, components: 8 }, workToBuild: 2800,
      buildCategory: 'production', researchPrerequisite: 'basicMechtech',
      beauty: -2,
      building: bld({ isWorkbench: true, powerConsumed: 180, interactionOffset: { dx: 0, dy: 2 } })
    },
    mechRecharger: {
      label: 'mech recharger', sprite: 'battery', color: '#3a4a3a', color2: '#ffc23c',
      description: 'A pad a mech stands on until its cells are full. One mech at a time, ' +
        'and nothing charges without power.',
      size: { w: 1, h: 1 }, rotatable: false, hp: 160, mass: 70,
      buildCost: { steel: 60, components: 3 }, workToBuild: 1400,
      buildCategory: 'power', researchPrerequisite: 'basicMechtech',
      passable: true, fillPercent: 0.2,
      building: bld({ powerConsumed: 350 })
    }
  }, BUILDING);

  Defs.add('recipe', {
    gestateMechShell: {
      label: 'mech shell', jobString: 'Gestating a mech shell', uiCategory: 'mechtech',
      workAmount: 3000, skill: 'crafting', skillRequirement: 4,
      workbenches: ['mechGestator'],
      ingredients: [{ thing: 'steel', count: 60 }, { thing: 'components', count: 3 }],
      products: { mechShell: 1 },
      researchPrerequisite: 'basicMechtech',
      defaultRepeat: 'count', defaultTargetCount: 1,
      description: 'An empty mechanoid body. A mechanitor decides what it becomes.'
    }
  }, {
    jobString: 'Working', skill: null, skillRequirement: 0,
    workType: 'craft', uiCategory: 'mechtech', workbenches: [],
    products: {}, dynamicProducts: false, productQuality: false,
    researchPrerequisite: null,
    defaultRepeat: 'forever', defaultTargetCount: 0, defaultIngredientRadius: 999,
    foodPoisonChance: 0, description: ''
  });

  /* Defs.finalize is what normally links a recipe to its bench in both
     directions, and nothing calls it in a live game - only the checker
     does. Production.benchAccepts reads either side, so the recipe's own
     workbenches list is enough for bills; this second half is for
     anything that walks the bench instead. */
  (function linkGestatorRecipe() {
    var bench = Defs.maybe('thing', 'mechGestator');
    if (!bench) return;
    if (!bench.recipes) bench.recipes = [];
    if (bench.recipes.indexOf('gestateMechShell') < 0) bench.recipes.push('gestateMechShell');
  })();

  /* ------------------------------------------------------------------
     Thoughts. Children are the reason this file exists, so they get the
     mood weight: a birth lifts the whole colony and a first birthday is
     worth more to a parent than a fine meal.
     ------------------------------------------------------------------ */
  Defs.add('thought', {
    btNewBaby: { label: 'A child was born', durationDays: 8, stackLimit: 2,
      stages: [{ label: 'A child was born here', mood: 10 }] },
    btMyBaby: { label: 'My child was born', durationDays: 12, stackLimit: 3,
      stages: [{ label: 'My child was born', mood: 22 }] },
    btPregnant: { label: 'Pregnant', durationDays: 1, stackLimit: 1,
      stages: [{ label: 'I am carrying a child', mood: 4 }] },
    btChildGrew: { label: 'My child had a birthday', durationDays: 4, stackLimit: 2,
      stages: [{ label: 'My child had a birthday', mood: 9 }] },
    btChildrenHere: { label: 'Children in the colony', durationDays: 1, stackLimit: 1,
      stages: [{ label: 'There are children here', mood: 3 }] },
    btXenogermSick: { label: 'Xenogerm sickness', durationDays: 6, stackLimit: 1,
      stages: [{ label: 'My body is being rewritten', mood: -9 }] },
    btGenesTaken: { label: 'Genes taken from me', durationDays: 10, stackLimit: 2,
      stages: [{ label: 'They cut my genes out of me', mood: -14 }] },
    btMechlinked: { label: 'Mechlinked', durationDays: 1, stackLimit: 1,
      stages: [{ label: 'I can feel the mechs', mood: 5 }] },
    btGeneAggression: { label: 'Aggression gene', durationDays: 1, stackLimit: 1,
      stages: [{ label: 'Everything is irritating', mood: -6 }] },
    btGeneContentment: { label: 'Contentment gene', durationDays: 1, stackLimit: 1,
      stages: [{ label: 'Nothing much bothers me', mood: 8 }] },
    btGeneCraving: { label: 'Chemical craving', durationDays: 1, stackLimit: 1,
      stages: [{ label: 'My body is asking for something', mood: -8 }] }
  });

  /* ------------------------------------------------------------------
     Hediffs. health.js exposes its table on purpose; these are added to
     it rather than declared in it, and never overwrite an id somebody
     else already put there.
     ------------------------------------------------------------------ */
  var HEDIFFS = {
    geneSightPoor: { id: 'geneSightPoor', label: 'shortsighted', lethal: false,
      capMods: { sight: -0.35 } },
    geneSightSharp: { id: 'geneSightSharp', label: 'sharp sight', lethal: false,
      capMods: { sight: 0.25 } },
    geneFrailBones: { id: 'geneFrailBones', label: 'frail bones', lethal: false,
      capMods: { moving: -0.12, manipulation: -0.08 } },
    xenogermSickness: { id: 'xenogermSickness', label: 'xenogerm sickness', lethal: false,
      painOffset: 0.12, capMods: { consciousness: -0.30, moving: -0.25, manipulation: -0.25 } },
    geneExtraction: { id: 'geneExtraction', label: 'gene extraction wound', lethal: false,
      painOffset: 0.20, capMods: { consciousness: -0.25, moving: -0.30, manipulation: -0.20 } },
    deathlessComa: { id: 'deathlessComa', label: 'deathless coma', lethal: false,
      capMods: { consciousness: -0.95, moving: -0.95, manipulation: -0.95 } },
    growthBaby: { id: 'growthBaby', label: 'infant', lethal: false,
      capMods: { consciousness: -0.55, moving: -0.75, manipulation: -0.85, talking: -0.85 } },
    growthChild: { id: 'growthChild', label: 'child', lethal: false,
      capMods: { consciousness: -0.15, moving: -0.20, manipulation: -0.25 } },
    growthTeen: { id: 'growthTeen', label: 'adolescent', lethal: false,
      capMods: { manipulation: -0.08 } }
  };
  (function installHediffs() {
    var H = sys('Health');
    if (!H || !H.HEDIFFS) return;
    for (var k in HEDIFFS) if (!H.HEDIFFS[k]) H.HEDIFFS[k] = HEDIFFS[k];
  })();

  /* ------------------------------------------------------------------
     The mechanoid body, and the six frames built on it. A mech kind
     declares isAnimal false so pawn.js treats it as a working pawn:
     that is what puts it on the ordinary work-giver path.
     ------------------------------------------------------------------ */
  function part(defName, label, parent, coverage, depth, hp, caps, flags) {
    flags = flags || '';
    return {
      defName: defName, label: label, parent: parent, coverage: coverage, depth: depth,
      maxHp: hp, hp: hp, capacities: caps || null,
      vital: flags.indexOf('v') >= 0, limb: flags.indexOf('l') >= 0
    };
  }

  Defs.add('body', {
    mechanoid: {
      label: 'mechanoid chassis',
      parts: [
        part('torso', 'chassis', null, 0.40, 'outside', 60, null, 'v'),
        part('head', 'sensor head', 'torso', 0.10, 'outside', 30, null, 'v'),
        part('brain', 'core processor', 'head', 0.60, 'inside', 20, { consciousness: 1.0 }, 'v'),
        part('eyeLeft', 'left optic', 'head', 0.03, 'outside', 12, { sight: 0.5 }, 'l'),
        part('eyeRight', 'right optic', 'head', 0.03, 'outside', 12, { sight: 0.5 }, 'l'),
        part('earLeft', 'left sensor', 'head', 0.02, 'outside', 10, { hearing: 0.5 }, 'l'),
        part('earRight', 'right sensor', 'head', 0.02, 'outside', 10, { hearing: 0.5 }, 'l'),
        part('heart', 'power cell', 'torso', 0.22, 'inside', 24, { bloodPumping: 1.0 }, 'v'),
        part('lungLeft', 'left coolant loop', 'torso', 0.20, 'inside', 20, { breathing: 0.5 }, ''),
        part('lungRight', 'right coolant loop', 'torso', 0.20, 'inside', 20, { breathing: 0.5 }, ''),
        part('armLeft', 'left manipulator', 'torso', 0.11, 'outside', 34, { manipulation: 0.5 }, 'l'),
        part('armRight', 'right manipulator', 'torso', 0.11, 'outside', 34, { manipulation: 0.5 }, 'l'),
        part('legLeft', 'left tread', 'torso', 0.11, 'outside', 34, { moving: 0.5 }, 'l'),
        part('legRight', 'right tread', 'torso', 0.11, 'outside', 34, { moving: 0.5 }, 'l')
      ]
    }
  });

  /* Bandwidth is the whole cost model: a mechanitor has a budget and
     each frame spends some of it. workTypes is what the frame can be
     told to do, and nothing else is ever enabled on it. */
  var MECH_KINDS = {
    mechHauler: { bandwidth: 1, work: ['haul'], label: 'hauler' },
    mechCleaner: { bandwidth: 1, work: ['clean'], label: 'cleansweeper' },
    mechLifter: { bandwidth: 1, work: ['haul', 'basic'], label: 'lifter' },
    mechConstructoid: { bandwidth: 2, work: ['construct', 'mine'], label: 'constructoid' },
    mechFabricor: { bandwidth: 2, work: ['craft', 'cook'], label: 'fabricor' },
    mechMilitor: { bandwidth: 1, work: [], label: 'militor', combat: true }
  };

  Defs.add('pawnKind', {
    mechHauler: {
      label: 'hauler mech', description: 'Two arms, a flat back and no opinion about where ' +
        'the steel goes. It goes where you put the stockpile.',
      combatPower: 30, baseHealthScale: 1.1, healthScale: 1.1, moveSpeed: 3.6,
      color: '#7c8490', color2: '#6fa8dc'
    },
    mechCleaner: {
      label: 'cleansweeper mech', description: 'A low disc that eats filth and is never ' +
        'anywhere you want to walk.',
      combatPower: 15, baseHealthScale: 0.7, healthScale: 0.7, moveSpeed: 4.2,
      baseBodySize: 0.6, bodySize: 0.6, color: '#7c8490', color2: '#8fd0c0'
    },
    mechLifter: {
      label: 'lifter mech', description: 'Built to carry more than it should be able to, ' +
        'and to keep the campfires fed while it is at it.',
      combatPower: 25, baseHealthScale: 1.0, healthScale: 1.0, moveSpeed: 3.2,
      baseBodySize: 1.3, bodySize: 1.3, color: '#7c8490', color2: '#c9a24a'
    },
    mechConstructoid: {
      label: 'constructoid mech', description: 'Welds, digs and never asks for a bed. ' +
        'Two bandwidth, and worth it the first time a wall goes up overnight.',
      combatPower: 60, baseHealthScale: 1.3, healthScale: 1.3, moveSpeed: 3.4,
      baseBodySize: 1.4, bodySize: 1.4, armorSharp: 0.15, armorBlunt: 0.10,
      color: '#6e7682', color2: '#ffc23c'
    },
    mechFabricor: {
      label: 'fabricor mech', description: 'A bench-worker with four hands. It cooks without ' +
        'tasting and crafts without pride, which shows in the quality.',
      combatPower: 45, baseHealthScale: 1.1, healthScale: 1.1, moveSpeed: 3.4,
      color: '#6e7682', color2: '#9a6bd0'
    },
    mechMilitor: {
      label: 'militor mech', description: 'A gun on legs. It will not win the fight, but it ' +
        'will stand in the part of it where the bullets are.',
      combatPower: 90, baseHealthScale: 1.2, healthScale: 1.2, moveSpeed: 4.0,
      armorSharp: 0.25, armorBlunt: 0.20,
      weapons: ['pistol'], meleeDamage: 10, meleeSkill: 6,
      color: '#5a626e', color2: '#c0392b'
    }
  }, {
    race: 'mechanoid', isAnimal: false, body: 'mechanoid', sprite: 'human',
    defaultFaction: 'player', techLevel: 'spacer',
    baseHealthScale: 1, healthScale: 1, moveSpeed: 3.6, moveSpeedFactor: 1,
    baseBodySize: 1, bodySize: 1, drawSize: 1,
    baseHungerRate: 0, hungerRateFactor: 0,
    lifeExpectancyYears: 400, ageRange: [0, 1],
    meleeDamage: 8, meleeDamageType: 'blunt', meleeCooldownTicks: 120, meleeArmorPen: 0,
    meleeSkill: 4, comfyTempMin: -100, comfyTempMax: 200,
    armorSharp: 0.10, armorBlunt: 0.10, armorHeat: 0.4,
    trainability: null, wildness: 0, packAnimal: false, predator: false,
    grazer: false, nocturnal: false, breeds: false, diet: null,
    butcherProducts: null, weapons: null, apparel: null,
    isMech: true
  });

  /* ============================================================
     2. GENES

     Forty-six of them. Every gene states a metabolic figure - a cost
     is positive, a gain is negative - and every gene does something.
     `trait` names a trait id the gene grants (some are the ordinary
     traits already in the game, some are the hidden defs registered
     below); `fx` names a flag this file acts on; `hediff` names a
     permanent condition; `ability` is offered to abilities.js.
     ============================================================ */

  /* Hidden trait defs. commonality 0 keeps them out of ordinary pawn
     generation: U.pickWeighted floors a weight at zero and never draws
     one, so these only ever arrive on a pawn through a gene. */
  var GENE_TRAITS = {
    geneFastWalk: { label: 'fast walker', moveSpeedFactor: 1.30 },
    geneSlowWalk: { label: 'slow walker', moveSpeedFactor: 0.80 },
    geneStrongMelee: { label: 'strong melee', skillGains: { melee: 5 } },
    geneIndustrious: { label: 'industrious frame', workSpeedFactor: 1.25 },
    geneSluggish: { label: 'sluggish', workSpeedFactor: 0.82 },
    geneQuickLearner: { label: 'quick learner', learnFactor: 1.5 },
    geneSlowLearner: { label: 'slow learner', learnFactor: 0.65 },
    genePerfectMemory: { label: 'perfect memory', noSkillDecay: true },
    geneLowHunger: { label: 'efficient digestion', hungerFactor: 0.50 },
    geneHighHunger: { label: 'ravenous', hungerFactor: 1.60 },
    geneLowSleep: { label: 'low sleep', restFallFactor: 0.55 },
    geneHighSleep: { label: 'heavy sleeper', restFallFactor: 1.45 },
    geneMining: { label: 'rock eater', skillGains: { mining: 4 } },
    geneGreenFingers: { label: 'verdant', skillGains: { plants: 4 } },
    geneArtless: { label: 'artless', skillGains: { artistic: -6 } },
    geneDullMind: { label: 'dull mind', disabledWork: ['research'], learnFactor: 0.8 }
  };
  (function registerGeneTraits() {
    var table = {}, k;
    for (k in GENE_TRAITS) {
      var t = GENE_TRAITS[k];
      table[k] = {
        label: t.label, commonality: 0, geneTrait: true,
        description: 'A genetic trait. It came with a xenotype, not with a childhood.',
        moveSpeedFactor: t.moveSpeedFactor, workSpeedFactor: t.workSpeedFactor,
        learnFactor: t.learnFactor, noSkillDecay: !!t.noSkillDecay,
        hungerFactor: t.hungerFactor, restFallFactor: t.restFallFactor,
        skillGains: t.skillGains || null, disabledWork: t.disabledWork || null
      };
    }
    Defs.add('trait', table);
  })();

  function gene(id, o) { o.id = id; return o; }

  var GENE_LIST = [
    /* ---- cosmetic: free, and the reason a xenotype is recognisable ---- */
    gene('skinPale', { label: 'pale skin', cat: 'cosmetic', met: 0, skin: '#e8cdb0' }),
    gene('skinDark', { label: 'dark skin', cat: 'cosmetic', met: 0, skin: '#6b4a32' }),
    gene('skinGreen', { label: 'green skin', cat: 'cosmetic', met: 0, skin: '#6f8f5a' }),
    gene('skinRed', { label: 'red skin', cat: 'cosmetic', met: 0, skin: '#b4563c' }),
    gene('skinGrey', { label: 'grey skin', cat: 'cosmetic', met: 0, skin: '#8a8a92' }),
    gene('hairWhite', { label: 'white hair', cat: 'cosmetic', met: 0, hair: '#e6e2da' }),
    gene('hairBlack', { label: 'black hair', cat: 'cosmetic', met: 0, hair: '#1f1b18' }),
    gene('hairRed', { label: 'red hair', cat: 'cosmetic', met: 0, hair: '#a6472a' }),
    gene('furryBody', { label: 'furskin', cat: 'cosmetic', met: -1, body: 'furry', fx: { cold: 14 } }),
    gene('bodyHulk', { label: 'hulk body', cat: 'cosmetic', met: 2, body: 'hulk',
      trait: 'geneStrongMelee', fx: { bodySize: 1.25 } }),
    gene('bodyThin', { label: 'thin body', cat: 'cosmetic', met: -1, body: 'thin',
      fx: { bodySize: 0.85 } }),
    gene('eyesInsectoid', { label: 'insectoid eyes', cat: 'cosmetic', met: 0, eyes: '#3c6b3c' }),

    /* ---- stat ---- */
    gene('fastWalker', { label: 'fast walker', cat: 'stat', met: 2, trait: 'geneFastWalk' }),
    gene('slowWalker', { label: 'slow walker', cat: 'stat', met: -1, trait: 'geneSlowWalk' }),
    gene('strongMelee', { label: 'strong melee damage', cat: 'stat', met: 2,
      trait: 'geneStrongMelee', fx: { meleeDamage: 1.35 } }),
    gene('toughSkin', { label: 'tough skin', cat: 'stat', met: 3,
      fx: { armorSharp: 0.20, armorBlunt: 0.15 } }),
    gene('poorSight', { label: 'poor sight', cat: 'stat', met: -2, hediff: 'geneSightPoor' }),
    gene('sharpSight', { label: 'sharp sight', cat: 'stat', met: 2, hediff: 'geneSightSharp' }),
    gene('deathless', { label: 'deathless', cat: 'stat', met: 6, fx: { deathless: 1 } }),
    gene('fireResistant', { label: 'fire resistance', cat: 'stat', met: 3, fx: { armorHeat: 0.65 } }),
    gene('toxResistant', { label: 'toxic resistance', cat: 'stat', met: 2, fx: { toxic: 0.8 } }),
    gene('coldTolerant', { label: 'cold tolerance', cat: 'stat', met: 2, fx: { cold: 22 } }),
    gene('heatTolerant', { label: 'heat tolerance', cat: 'stat', met: 2, fx: { heat: 18 } }),
    gene('noPain', { label: 'pain insensitivity', cat: 'stat', met: 3, fx: { noPain: 1 } }),
    gene('fastHealing', { label: 'rapid healing', cat: 'stat', met: 4, fx: { heal: 2.5 } }),
    gene('slowAging', { label: 'slow aging', cat: 'stat', met: 3, fx: { age: 0.35 } }),
    gene('superClotting', { label: 'super-clotting', cat: 'stat', met: 2, fx: { clot: 0.35 } }),
    gene('psychicSensitive', { label: 'psychic sensitivity', cat: 'stat', met: 3,
      fx: { psychic: 1.6 } }),
    gene('psychicDull', { label: 'psychic dullness', cat: 'stat', met: -2, fx: { psychic: 0.5 } }),
    gene('industriousFrame', { label: 'industrious frame', cat: 'stat', met: 3,
      trait: 'geneIndustrious' }),
    gene('quickLearner', { label: 'quick learner', cat: 'stat', met: 3, trait: 'geneQuickLearner' }),
    gene('perfectMemory', { label: 'perfect memory', cat: 'stat', met: 2, trait: 'genePerfectMemory' }),
    gene('rockEater', { label: 'rock eater', cat: 'stat', met: 1, trait: 'geneMining' }),
    gene('verdant', { label: 'verdant', cat: 'stat', met: 1, trait: 'geneGreenFingers' }),
    gene('nimbleGene', { label: 'nimble', cat: 'stat', met: 2, trait: 'nimble' }),
    gene('toughGene', { label: 'tough', cat: 'stat', met: 3, trait: 'tough' }),

    /* ---- need ---- */
    gene('lowHunger', { label: 'minimal hunger', cat: 'need', met: 4, trait: 'geneLowHunger' }),
    gene('highHunger', { label: 'high hunger', cat: 'need', met: -3, trait: 'geneHighHunger' }),
    gene('lowSleep', { label: 'low sleep', cat: 'need', met: 4, trait: 'geneLowSleep' }),
    gene('highSleep', { label: 'heavy sleeper', cat: 'need', met: -3, trait: 'geneHighSleep' }),
    gene('noRecreation', { label: 'no recreation need', cat: 'need', met: 4, fx: { noJoy: 1 } }),
    gene('contentment', { label: 'contentment', cat: 'need', met: 3, fx: { content: 1 } }),

    /* ---- ability ---- */
    gene('fireSpew', { label: 'fire spew', cat: 'ability', met: 3, ability: 'geneFireSpew' }),
    gene('acidSpray', { label: 'acid spray', cat: 'ability', met: 3, ability: 'geneAcidSpray' }),
    gene('longjump', { label: 'longjump', cat: 'ability', met: 2, ability: 'geneLongjump' }),
    gene('bloodfeeder', { label: 'bloodfeeder', cat: 'ability', met: 1, fx: { bloodfeeder: 1 } }),

    /* ---- drawbacks: the metabolic gain that pays for everything above ---- */
    gene('frail', { label: 'frail', cat: 'drawback', met: -4, hediff: 'geneFrailBones',
      fx: { fragile: 1.3 } }),
    gene('delicate', { label: 'delicate', cat: 'drawback', met: -3, fx: { fragile: 1.5 } }),
    gene('sickly', { label: 'sickly', cat: 'drawback', met: -3, fx: { sickly: 1 } }),
    gene('aggression', { label: 'aggression', cat: 'drawback', met: -3, fx: { aggression: 1 },
      trait: 'geneStrongMelee' }),
    gene('pyromaniaGene', { label: 'pyromania', cat: 'drawback', met: -4, trait: 'pyromaniac' }),
    gene('drugNeed', { label: 'chemical dependency', cat: 'drawback', met: -4, fx: { drugNeed: 1 } }),
    gene('sluggishGene', { label: 'sluggish', cat: 'drawback', met: -2, trait: 'geneSluggish' }),
    gene('slowLearnerGene', { label: 'slow learner', cat: 'drawback', met: -2, trait: 'geneSlowLearner' }),
    gene('artlessGene', { label: 'artless', cat: 'drawback', met: -2, trait: 'geneArtless' }),
    gene('dullMind', { label: 'dull mind', cat: 'drawback', met: -3, trait: 'geneDullMind' }),
    gene('wimpGene', { label: 'wimp', cat: 'drawback', met: -3, trait: 'wimp' })
  ];

  var GENE_BY_ID = Object.create(null);
  for (var gi = 0; gi < GENE_LIST.length; gi++) GENE_BY_ID[GENE_LIST[gi].id] = GENE_LIST[gi];

  Biotech.genes = function () { return GENE_LIST.slice(); };
  Biotech.gene = function (id) { return GENE_BY_ID[id] || null; };

  /* Abilities are optional scope: abilities.js may not be on disk, and
     when it is, these three are offered to it once. */
  (function offerAbilities() {
    var A = sys('Abilities');
    if (!A || typeof A.register !== 'function' || A.__biotechOffered) return;
    A.__biotechOffered = true;
    var specs = [
      { id: 'geneFireSpew', label: 'fire spew', cooldownTicks: 1800, range: 6,
        description: 'Vomit a cone of burning chemicals.', damage: 10, damageType: 'flame' },
      { id: 'geneAcidSpray', label: 'acid spray', cooldownTicks: 1500, range: 7,
        description: 'A spray that eats armour and then what is under it.', damage: 12,
        damageType: 'acid', armorPen: 0.6 },
      { id: 'geneLongjump', label: 'longjump', cooldownTicks: 900, range: 12,
        description: 'Leap over a wall, a fire, or a line of raiders.', jump: true }
    ];
    for (var i = 0; i < specs.length; i++) {
      try { A.register(specs[i]); } catch (e) { /* another file owns the id; fine */ }
    }
  })();

  /* ============================================================
     3. XENOTYPES
     ============================================================ */

  var XENOTYPES = [
    { id: 'baseliner', label: 'baseliner', weight: 100, genes: [],
      description: 'Humanity as it left Earth. No genes worth naming, and no metabolism to pay.' },
    { id: 'hussar', label: 'hussar', weight: 6, tech: ['industrial', 'spacer'],
      genes: ['fastWalker', 'strongMelee', 'toughSkin', 'noPain', 'aggression', 'highHunger',
              'skinPale', 'hairWhite', 'drugNeed'],
      description: 'Bred as soldiers by somebody who did not have to live with them afterwards.' },
    { id: 'genie', label: 'genie', weight: 5, tech: ['spacer'],
      genes: ['quickLearner', 'perfectMemory', 'industriousFrame', 'lowHunger', 'frail',
              'slowWalker', 'skinPale', 'hairBlack'],
      description: 'Built for laboratories. Brilliant, and a broken wrist away from useless.' },
    { id: 'dirtmole', label: 'dirtmole', weight: 7,
      genes: ['rockEater', 'poorSight', 'lowSleep', 'skinPale', 'hairWhite', 'bodyThin',
              'coldTolerant'],
      description: 'Generations underground. They mine in the dark and squint at daylight.' },
    { id: 'impid', label: 'impid', weight: 7,
      genes: ['fireSpew', 'fireResistant', 'heatTolerant', 'fastWalker', 'skinRed', 'hairRed',
              'lowHunger', 'wimpGene'],
      description: 'Desert-born, fire-breathing and famously bad in a brawl they did not start.' },
    { id: 'neanderthal', label: 'neanderthal', weight: 8, tech: ['neolithic', 'medieval'],
      genes: ['toughGene', 'strongMelee', 'coldTolerant', 'bodyHulk', 'furryBody',
              'slowLearnerGene', 'highHunger', 'skinDark'],
      description: 'A cousin line that never left the cold. Strong, patient, slow to be taught.' },
    { id: 'pigskin', label: 'pigskin', weight: 8,
      genes: ['toughSkin', 'lowHunger', 'fastHealing', 'skinPale', 'artlessGene', 'dullMind',
              'bodyHulk'],
      description: 'Made for hard labour on hard worlds. Tough, hungry for nothing, and slighted.' },
    { id: 'waster', label: 'waster', weight: 6,
      genes: ['toxResistant', 'lowHunger', 'drugNeed', 'skinGrey', 'hairWhite', 'sluggishGene',
              'sickly', 'noRecreation'],
      description: 'Grown up in the polluted places. Poison does nothing to them; nothing else does much either.' },
    { id: 'yttakin', label: 'yttakin', weight: 6,
      genes: ['furryBody', 'coldTolerant', 'strongMelee', 'sharpSight', 'highHunger',
              'slowLearnerGene', 'hairBlack'],
      description: 'Hair everywhere, cold nowhere. A yttakin sleeps outside in a blizzard on purpose.' },
    { id: 'sanguophage', label: 'sanguophage', weight: 2, tech: ['spacer'],
      genes: ['deathless', 'slowAging', 'fastHealing', 'superClotting', 'bloodfeeder',
              'noPain', 'skinPale', 'hairBlack', 'toughSkin', 'highSleep'],
      description: 'An archite-bearing parasite in the shape of a person. It does not really die.' },
    { id: 'highmate', label: 'highmate', weight: 3, tech: ['industrial', 'spacer'],
      genes: ['contentment', 'skinPale', 'hairWhite', 'delicate', 'psychicSensitive',
              'lowSleep', 'artlessGene'],
      description: 'Bred to be loved and to be no trouble. Both of those were done to them.' },
    { id: 'ratkin', label: 'ratkin', weight: 5,
      genes: ['fastWalker', 'lowHunger', 'sharpSight', 'bodyThin', 'skinGrey', 'wimpGene',
              'quickLearner'],
      description: 'Small, quick, everywhere at once, and never where the fighting is.' }
  ];
  var XENO_BY_ID = Object.create(null);
  for (var xi = 0; xi < XENOTYPES.length; xi++) XENO_BY_ID[XENOTYPES[xi].id] = XENOTYPES[xi];

  Biotech.xenotypes = function () { return XENOTYPES.slice(); };
  Biotech.xenotype = function (id) { return XENO_BY_ID[id] || null; };

  /* Who a generated pawn turns out to be. A faction's tech level is the
     filter: a neolithic clan does not field genies, and baseliners are
     the overwhelming majority everywhere. */
  Biotech.rollXenotype = function (faction, kindId) {
    var kind = kindId ? Defs.maybe('pawnKind', kindId) : null;
    if (kind && (kind.isAnimal || kind.isMech)) return 'baseliner';
    var tech = null;
    var F = sys('Factions');
    if (F && F.get && faction) {
      var f = F.get(faction);
      if (f && f.techLevel) tech = f.techLevel;
    }
    if (!tech && kind && kind.techLevel) tech = kind.techLevel;
    var pool = [];
    for (var i = 0; i < XENOTYPES.length; i++) {
      var x = XENOTYPES[i];
      if (x.tech && tech && x.tech.indexOf(tech) < 0) continue;
      pool.push(x);
    }
    if (!pool.length) return 'baseliner';
    var picked = U.pickWeighted(pool, function (x) { return x.weight; });
    return picked ? picked.id : 'baseliner';
  };

  Biotech.applyXenotype = function (pawn, xenotypeId) {
    var x = XENO_BY_ID[xenotypeId];
    if (!pawn || !x) return false;
    clearGenes(pawn);
    var st = ensureGenes(pawn);
    st.xenotype = x.id;
    st.xenotypeLabel = x.label;
    for (var i = 0; i < x.genes.length; i++) addGene(pawn, x.genes[i], true);
    refreshGenes(pawn);
    return true;
  };

  /* ============================================================
     4. GENE STATE ON A PAWN

     pawn.genes is a plain object, so save.js carries it without being
     told anything. Everything derived from it lives on pawn._geneFx,
     which is rebuilt whenever the list changes and after a load.
     ============================================================ */

  function ensureGenes(pawn) {
    if (!pawn.genes) {
      pawn.genes = { list: [], xenotype: 'baseliner', xenotypeLabel: 'baseliner', metabolism: 0 };
    }
    if (!pawn.genes.list) pawn.genes.list = [];
    return pawn.genes;
  }

  function clearGenes(pawn) {
    var st = pawn.genes;
    if (!st || !st.list || !st.list.length) { ensureGenes(pawn); return; }
    var list = st.list.slice();
    for (var i = 0; i < list.length; i++) removeGene(pawn, list[i], true);
    st.list.length = 0;
    st.xenotype = 'baseliner';
    st.xenotypeLabel = 'baseliner';
  }

  function addGene(pawn, geneId, quiet) {
    var g = GENE_BY_ID[geneId];
    if (!g) return false;
    var st = ensureGenes(pawn);
    if (st.list.indexOf(geneId) >= 0) return false;
    st.list.push(geneId);

    if (g.trait && pawn.traits && pawn.traits.indexOf(g.trait) < 0 && Defs.has('trait', g.trait)) {
      pawn.traits.push(g.trait);
    }
    if (g.hediff) {
      var H = sys('Health');
      if (H && H.addHediff && pawn.health) H.addHediff(pawn, g.hediff, 1);
    }
    if (g.skin) pawn.skinColor = g.skin;
    if (g.hair) pawn.hairColor = g.hair;
    if (g.eyes) pawn.eyeColor = g.eyes;
    if (g.body) pawn.bodyType = g.body;
    if (!quiet) refreshGenes(pawn);
    return true;
  }

  function removeGene(pawn, geneId, quiet) {
    var g = GENE_BY_ID[geneId];
    var st = ensureGenes(pawn);
    if (!g || !U.remove(st.list, geneId)) return false;
    if (g.trait && pawn.traits) U.remove(pawn.traits, g.trait);
    if (g.hediff) {
      var H = sys('Health');
      if (H && H.removeHediff) H.removeHediff(pawn, g.hediff);
    }
    if (!quiet) refreshGenes(pawn);
    return true;
  }

  /* Everything the tick and the chains need, folded into one object so
     a pawn with no genes at all costs one property read. */
  function refreshGenes(pawn) {
    var st = ensureGenes(pawn);
    var fx = {
      armorSharp: 0, armorBlunt: 0, armorHeat: 0, toxic: 0,
      cold: 0, heat: 0, meleeDamage: 1, bodySize: 1, fragile: 1,
      heal: 0, age: 1, clot: 1, psychic: 1,
      noPain: 0, noJoy: 0, content: 0, deathless: 0, sickly: 0,
      aggression: 0, drugNeed: 0, bloodfeeder: 0, any: 0
    };
    var met = 0;
    for (var i = 0; i < st.list.length; i++) {
      var g = GENE_BY_ID[st.list[i]];
      if (!g) continue;
      met += g.met || 0;
      fx.any = 1;
      var e = g.fx;
      if (!e) continue;
      if (e.armorSharp) fx.armorSharp += e.armorSharp;
      if (e.armorBlunt) fx.armorBlunt += e.armorBlunt;
      if (e.armorHeat) fx.armorHeat += e.armorHeat;
      if (e.toxic) fx.toxic = Math.max(fx.toxic, e.toxic);
      if (e.cold) fx.cold += e.cold;
      if (e.heat) fx.heat += e.heat;
      if (e.meleeDamage) fx.meleeDamage *= e.meleeDamage;
      if (e.bodySize) fx.bodySize *= e.bodySize;
      if (e.fragile) fx.fragile *= e.fragile;
      if (e.heal) fx.heal = Math.max(fx.heal, e.heal);
      if (e.age) fx.age = Math.min(fx.age, e.age);
      if (e.clot) fx.clot = Math.min(fx.clot, e.clot);
      if (e.psychic) fx.psychic *= e.psychic;
      if (e.noPain) fx.noPain = 1;
      if (e.noJoy) fx.noJoy = 1;
      if (e.content) fx.content = 1;
      if (e.deathless) fx.deathless = 1;
      if (e.sickly) fx.sickly = 1;
      if (e.aggression) fx.aggression = 1;
      if (e.drugNeed) fx.drugNeed = 1;
      if (e.bloodfeeder) fx.bloodfeeder = 1;
    }
    /* Metabolism is the budget: a pawn who spent more than their body
       can pay for is permanently hungrier for it. */
    st.metabolism = met;
    fx.hungerFromMetabolism = met > 0 ? U.clamp(1 + met * 0.055, 1, 1.6) : 1;
    pawn._geneFx = fx;
    if (pawn.invalidateTraitCache) pawn.invalidateTraitCache();
    else pawn._fx = null;
    pawn._traitFx = null;
    var H = sys('Health');
    if (H && H.invalidate) H.invalidate(pawn);
    return fx;
  }

  function geneFx(pawn) {
    if (!pawn) return null;
    if (pawn._geneFx) return pawn._geneFx;
    if (!pawn.genes || !pawn.genes.list || !pawn.genes.list.length) return null;
    return refreshGenes(pawn);
  }

  Biotech.genesOf = function (pawn) {
    var st = pawn && pawn.genes;
    return st && st.list ? st.list.slice() : [];
  };
  Biotech.hasGene = function (pawn, geneId) {
    var st = pawn && pawn.genes;
    return !!(st && st.list && st.list.indexOf(geneId) >= 0);
  };
  Biotech.addGene = function (pawn, geneId) { return addGene(pawn, geneId, false); };
  Biotech.removeGene = function (pawn, geneId) { return removeGene(pawn, geneId, false); };
  Biotech.xenotypeOf = function (pawn) {
    var st = pawn && pawn.genes;
    return st ? (st.xenotype || 'baseliner') : 'baseliner';
  };
  Biotech.metabolismOf = function (pawn) {
    var st = pawn && pawn.genes;
    return st ? (st.metabolism || 0) : 0;
  };

  /* The one number other systems ask for. Stat ids are the ones this
     file can answer for; anything else is 1, which is the honest answer
     for a pawn whose genes have nothing to say about it. */
  Biotech.statFactor = function (pawn, statId) {
    var fx = geneFx(pawn);
    if (!fx) return 1;
    switch (statId) {
      case 'meleeDamage': return fx.meleeDamage;
      case 'bodySize': return fx.bodySize;
      case 'incomingDamage': return fx.fragile;
      case 'armorSharp': return fx.armorSharp;
      case 'armorBlunt': return fx.armorBlunt;
      case 'armorHeat': return fx.armorHeat;
      case 'toxicResistance': return fx.toxic;
      case 'psychicSensitivity': return fx.psychic;
      case 'healRate': return fx.heal || 1;
      case 'ageRate': return fx.age;
      case 'bleedRate': return fx.clot;
      case 'hunger': return fx.hungerFromMetabolism;
      case 'comfyTempMin': return -fx.cold;
      case 'comfyTempMax': return fx.heat;
      default: return 1;
    }
  };

  /* ============================================================
     5. GROWTH STAGES

     A child is a pawn who is not finished. The stage decides three
     things - what the body can do, how fast it learns, and what work
     it may be given - and each of the three goes through a path that
     already exists rather than a special case in the job code.
     ============================================================ */

  var STAGES = [
    { id: 'baby', from: 0, hediff: 'growthBaby', learnTrait: null, work: [] },
    { id: 'child', from: 3, hediff: 'growthChild', learnTrait: 'geneQuickLearner',
      work: ['basic', 'haul', 'clean', 'patient', 'bedRest', 'grow', 'handle'] },
    { id: 'teenager', from: 13, hediff: 'growthTeen', learnTrait: 'geneQuickLearner', work: null },
    { id: 'adult', from: 18, hediff: null, learnTrait: null, work: null }
  ];

  Biotech.growthStage = function (pawn) {
    if (!pawn || !pawn.isHuman || pawn.mech) return 'adult';
    var age = pawn.ageYears || 0;
    for (var i = STAGES.length - 1; i >= 0; i--) if (age >= STAGES[i].from) return STAGES[i].id;
    return 'baby';
  };

  function stageDef(id) {
    for (var i = 0; i < STAGES.length; i++) if (STAGES[i].id === id) return STAGES[i];
    return STAGES[STAGES.length - 1];
  }

  /* Applied whenever the stage changes, and once on a loaded pawn. */
  function applyStage(pawn, stageId) {
    var H = sys('Health');
    var def = stageDef(stageId);
    for (var i = 0; i < STAGES.length; i++) {
      var s = STAGES[i];
      if (!s.hediff) continue;
      if (s.id === stageId) {
        if (H && H.addHediff && !H.hasHediff(pawn, s.hediff)) H.addHediff(pawn, s.hediff, 1);
      } else if (H && H.removeHediff) {
        H.removeHediff(pawn, s.hediff);
      }
    }

    /* Children learn faster, and the learn rate lives on the trait path,
       so the stage grants and revokes the hidden trait that carries it. */
    if (pawn.traits) {
      var wantLearn = def.learnTrait;
      if (wantLearn && pawn.traits.indexOf(wantLearn) < 0 && !Biotech.hasGene(pawn, 'quickLearner')) {
        pawn.traits.push(wantLearn);
        pawn._stageLearnTrait = wantLearn;
      } else if (!wantLearn && pawn._stageLearnTrait) {
        if (!Biotech.hasGene(pawn, 'quickLearner')) U.remove(pawn.traits, pawn._stageLearnTrait);
        pawn._stageLearnTrait = null;
      }
      if (pawn.invalidateTraitCache) pawn.invalidateTraitCache();
    }

    applyStageWork(pawn, def);
    pawn.growthStage = stageId;
  }

  function applyStageWork(pawn, def) {
    if (!pawn.workPriority) return;
    var allowed = def.work;
    var types = Defs.all('workType');
    for (var i = 0; i < types.length; i++) {
      var id = types[i].id;
      if (allowed === null) {
        /* Adults and teenagers: put back anything childhood switched off,
           but never overrule a priority the player set by hand. */
        if (pawn.workPriority[id] === 0 && pawn._childDisabled && pawn._childDisabled.indexOf(id) >= 0) {
          pawn.workPriority[id] = 3;
        }
        continue;
      }
      if (allowed.indexOf(id) < 0 && pawn.workPriority[id] !== 0) {
        if (!pawn._childDisabled) pawn._childDisabled = [];
        if (pawn._childDisabled.indexOf(id) < 0) pawn._childDisabled.push(id);
        pawn.workPriority[id] = 0;
      }
    }
    if (allowed === null) pawn._childDisabled = null;
  }

  /* A birthday during childhood is worth something concrete: growth
     points buy a passion, and every third birthday buys a trait. */
  function childBirthday(pawn) {
    var g = pawn.growthPoints === undefined ? 0 : pawn.growthPoints;
    pawn.growthPoints = g + 1;
    var skills = Defs.all('skill');
    if (skills.length && pawn.skills) {
      /* A passion lands on something the child has already been doing:
         the skill with the most experience banked. */
      var best = null, bestXp = -1;
      for (var i = 0; i < skills.length; i++) {
        var s = pawn.skills[skills[i].id];
        if (!s || s.passion >= 2) continue;
        var score = s.level * 1000 + (s.xp || 0) + U.randInt(0, 400);
        if (score > bestXp) { bestXp = score; best = s; }
      }
      if (best) best.passion = Math.min(2, (best.passion | 0) + 1);
    }
    if ((pawn.growthPoints % 3) === 0) grantChildTrait(pawn);

    var stage = Biotech.growthStage(pawn);
    if (stage !== pawn.growthStage) applyStage(pawn, stage);

    if (pawn.faction === 'player') {
      tellParents(pawn, 'btChildGrew');
      msg(nameOf(pawn) + ' is now ' + pawn.ageYears + '.', 'good', pawn);
    }
  }

  function grantChildTrait(pawn) {
    var pool = Defs.all('trait').filter(function (t) {
      if (t.geneTrait) return false;
      if (t.commonality === 0) return false;
      return pawn.traits.indexOf(t.id) < 0;
    });
    if (!pool.length || pawn.traits.length >= 5) return;
    var pick = U.pickWeighted(pool, function (t) {
      return t.commonality === undefined ? 1 : Math.max(0.01, t.commonality);
    });
    if (!pick) return;
    pawn.traits.push(pick.id);
    if (pawn.invalidateTraitCache) pawn.invalidateTraitCache();
  }

  function tellParents(child, thoughtId) {
    var S = sys('Social');
    var map = child.map;
    if (!map) return;
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (p === child || p.dead || !p.isHuman || p.faction !== 'player') continue;
      var isParent = false;
      if (S && S.relationKinds) isParent = S.relationKinds(p, child).indexOf('child') >= 0;
      else isParent = (child.motherId === p.id || child.fatherId === p.id);
      if (isParent) thought(p, thoughtId, { otherPawnId: child.id });
    }
  }

  /* ============================================================
     6. PREGNANCY AND BIRTH

     social.js owns romance and has no lovin' job, so conception hangs
     off the thing that is already true when a couple is together: both
     asleep, in reach of each other, and partners. The roll is per rare
     tick, which works out to a handful of chances a night.
     ============================================================ */

  var TERM_DAYS = 18;

  function fertile(pawn) {
    if (!pawn || !pawn.isHuman || pawn.dead || pawn.mech) return false;
    var age = pawn.ageYears || 0;
    if (age < 16) return false;
    if (pawn.gender === 'female') return age <= 45;
    return age <= 65;
  }

  Biotech.tryConceive = function (a, b) {
    if (!fertile(a) || !fertile(b) || a === b) return false;
    if (a.gender === b.gender) return false;
    var mother = a.gender === 'female' ? a : b;
    var father = mother === a ? b : a;
    if (mother.pregnancy) return false;
    var S = sys('Social');
    if (S && S.closeFamily && S.closeFamily(mother, father)) return false;

    /* Fertility falls off a cliff in the late thirties, which is what
       makes a colony that wants children plan for it. */
    var age = mother.ageYears || 25;
    var chance = U.curve([[16, 0.05], [20, 0.10], [28, 0.09], [35, 0.05], [40, 0.015], [45, 0]], age);
    if (mother.needs && mother.needs.food < 0.2) chance *= 0.3;
    if (!U.chance(chance)) return false;

    Biotech.beginPregnancy(mother, father, false);
    return true;
  };

  Biotech.beginPregnancy = function (mother, father, fromVat) {
    if (!mother || mother.pregnancy) return null;
    mother.pregnancy = {
      fatherId: father ? father.id : 0,
      fatherName: father ? nameOf(father) : '',
      ticks: 0,
      term: Math.round(TERM_DAYS * TICKS_PER_DAY),
      vat: !!fromVat,
      genes: inheritGeneString(mother, father),
      announced: 0
    };
    if (mother.faction === 'player') {
      letter('A pregnancy', nameOf(mother) + ' is pregnant' +
        (father ? ', by ' + nameOf(father) : '') + '. The child is due in ' + TERM_DAYS +
        ' days. Feed her, keep her out of fights, and think about where it is going to sleep.',
        'good', mother);
    }
    return mother.pregnancy;
  };

  /* Genes are carried as a comma-joined string: save.js only keeps
     scalar fields on a Thing, and a genepack has to survive a reload. */
  function inheritGeneString(mother, father) {
    var out = [];
    var pool = [];
    var i, id;
    var ml = (mother && mother.genes && mother.genes.list) || [];
    var fl = (father && father.genes && father.genes.list) || [];
    for (i = 0; i < ml.length; i++) pool.push(ml[i]);
    for (i = 0; i < fl.length; i++) if (pool.indexOf(fl[i]) < 0) pool.push(fl[i]);
    for (i = 0; i < pool.length; i++) {
      id = pool[i];
      var bothSides = ml.indexOf(id) >= 0 && fl.indexOf(id) >= 0;
      if (bothSides || U.chance(0.55)) out.push(id);
    }
    return out.join(',');
  }

  function geneStringToList(s) {
    if (!s) return [];
    var parts = String(s).split(',');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var id = parts[i];
      if (id && GENE_BY_ID[id] && out.indexOf(id) < 0) out.push(id);
    }
    return out;
  }

  function tickPregnancy(pawn) {
    var p = pawn.pregnancy;
    if (!p) return;
    if (pawn.dead) { pawn.pregnancy = null; return; }
    p.ticks += RARE;

    /* A starving mother loses the pregnancy; that is grim, and it is
       also the thing that makes food matter in a colony with children. */
    if (pawn.needs && pawn.needs.food <= 0.01 && U.chance(0.02)) {
      pawn.pregnancy = null;
      if (pawn.faction === 'player') {
        letter('A pregnancy lost', nameOf(pawn) + ' has lost the pregnancy. She has not eaten in days.',
          'death', pawn);
      }
      return;
    }

    var third = p.ticks / p.term;
    if (third > 0.33 && p.announced < 1) { p.announced = 1; }
    if (pawn.faction === 'player' && (now() % 4000) < RARE) thought(pawn, 'btPregnant');

    if (p.ticks >= p.term) Biotech.birth(pawn);
  }

  Biotech.birth = function (mother) {
    if (!mother || !mother.map) return null;
    var p = mother.pregnancy;
    mother.pregnancy = null;
    var map = mother.map;

    /* Labour is dangerous in a shack with no doctor and no medicine. */
    var H = sys('Health');
    var risk = 0.14;
    if (H && H.capacity) risk *= (1.4 - 0.6 * H.capacity(mother, 'consciousness'));
    if (mother.ageYears > 38) risk += 0.06;
    if (mother.needs && mother.needs.food < 0.3) risk += 0.05;
    if (H && H.damage && U.chance(U.clamp(risk, 0, 0.4))) {
      H.damage(mother, { amount: U.randInt(8, 22), type: 'cut', source: 'childbirth' });
    }

    var baby = makeChild(map, mother, p);
    if (!baby) return null;

    if (mother.faction === 'player') {
      letter('A birth', nameOf(mother) + ' has given birth to ' + nameOf(baby) + '. ' +
        'The colony has a child in it now, which changes what it is for.',
        'good', baby);
      thought(mother, 'btMyBaby', { otherPawnId: baby.id });
      var colonists = map.colonists();
      for (var i = 0; i < colonists.length; i++) {
        if (colonists[i] === mother) continue;
        thought(colonists[i], 'btNewBaby', { otherPawnId: baby.id });
      }
      var father = p && p.fatherId ? pawnById(map, p.fatherId) : null;
      if (father) thought(father, 'btMyBaby', { otherPawnId: baby.id });
    }
    return baby;
  };

  function pawnById(map, id) {
    if (!map || !id) return null;
    for (var i = 0; i < map.pawns.length; i++) if (map.pawns[i].id === id) return map.pawns[i];
    return null;
  }

  function makeChild(map, mother, pregnancy) {
    var MG = sys('MapGen');
    if (!MG || !MG.makePawn) return null;
    var x = mother.x, y = mother.y;
    var baby = MG.makePawn('colonist', mother.faction || 'player', {
      x: x, y: y, map: map, gear: false, ageYears: 0,
      traits: [], skills: {}, backstories: { childhood: null, adulthood: null }
    });
    if (!baby) return null;

    /* Born here, so the surname follows the mother and the pawn carries
       the one backstory that is true of it. */
    if (baby.name && mother.name) baby.name.last = mother.name.last;
    if (Defs.has('backstory', 'childColonyBorn')) baby.backstories.childhood = 'childColonyBorn';
    baby.ageYears = 0;
    baby.ageTicks = 0;
    baby.motherId = mother.id;
    baby.fatherId = pregnancy ? (pregnancy.fatherId || 0) : 0;
    baby.growthPoints = 0;

    var genes = pregnancy ? geneStringToList(pregnancy.genes) : [];
    var st = ensureGenes(baby);
    st.xenotype = (mother.genes && mother.genes.xenotype) || 'baseliner';
    st.xenotypeLabel = (mother.genes && mother.genes.xenotypeLabel) || 'baseliner';
    for (var i = 0; i < genes.length; i++) addGene(baby, genes[i], true);
    refreshGenes(baby);

    applyStage(baby, 'baby');
    baby.spawn(map, x, y);

    /* social.js stores a relation from the subject's side and mirrors the
       reverse, so the child is the one who has a parent. Stated the other
       way round the colony ends up full of people whose mother is a baby. */
    var S = sys('Social');
    if (S && S.addRelation) {
      S.addRelation(baby, mother, 'parent');
      var father = pregnancy && pregnancy.fatherId ? pawnById(map, pregnancy.fatherId) : null;
      if (father) S.addRelation(baby, father, 'parent');
    }
    return baby;
  }

  /* ============================================================
     7. GROWTH VATS
     ============================================================ */

  Biotech.startVatPregnancy = function (vat, mother, father) {
    if (!vat || !vat.def || vat.defId !== 'growthVat') return false;
    if (vat.vatActive) return false;
    vat.vatActive = true;
    vat.vatTicks = 0;
    vat.vatTerm = Math.round(TERM_DAYS * TICKS_PER_DAY);
    vat.vatMotherId = mother ? mother.id : 0;
    vat.vatFatherId = father ? father.id : 0;
    vat.vatGenes = inheritGeneString(mother, father);
    vat.vatSurname = (mother && mother.name && mother.name.last) || '';
    msg('The growth vat has been started.', 'good', vat);
    return true;
  };

  Biotech.cancelVat = function (vat) {
    if (!vat || !vat.vatActive) return false;
    vat.vatActive = false;
    vat.vatTicks = 0;
    return true;
  };

  function tickVats(map) {
    var vats = map.byDef('growthVat');
    if (!vats || !vats.length) return;
    var P = sys('Power');
    for (var i = 0; i < vats.length; i++) {
      var vat = vats[i];
      if (!vat.spawned || !vat.vatActive) continue;
      if (P && P.isPowered && !P.isPowered(vat)) continue;
      /* Tended vats run a little faster; that is what the doctor work is
         buying, and it is why the job exists at all. */
      var speed = (vat.vatTendUntil && vat.vatTendUntil > now()) ? 1.25 : 1;
      vat.vatTicks = (vat.vatTicks || 0) + 500 * speed;
      if (vat.vatTicks < (vat.vatTerm || TERM_DAYS * TICKS_PER_DAY)) continue;

      vat.vatActive = false;
      vat.vatTicks = 0;
      var mother = pawnById(map, vat.vatMotherId) || null;
      var fake = { fatherId: vat.vatFatherId || 0, genes: vat.vatGenes || '' };
      var anchor = mother || { x: vat.x, y: vat.y, faction: 'player', name: { last: vat.vatSurname || '' }, id: 0, genes: null };
      var baby = makeChildAt(map, anchor, fake, vat.x, vat.y);
      if (baby) {
        letter('A vat birth', nameOf(baby) + ' has been decanted from the growth vat. ' +
          'Whatever else they are, they are yours now.', 'good', baby);
      }
    }
  }

  function makeChildAt(map, mother, pregnancy, x, y) {
    var saveX = mother.x, saveY = mother.y;
    mother.x = x; mother.y = y;
    var baby = makeChild(map, mother, pregnancy);
    mother.x = saveX; mother.y = saveY;
    return baby;
  }

  /* ============================================================
     8. GENE ENGINEERING - jobs and the work that carries them

     The extractor is lab equipment rather than an operating table: it
     has to exist on the map and be powered, but the surgery happens
     where the subject is lying, because hauling a prisoner into a
     machine is a second hauling system nobody asked for.
     ============================================================ */

  function poweredBuilding(map, defId) {
    var list = map.byDef(defId);
    if (!list || !list.length) return null;
    var P = sys('Power');
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      if (!b.spawned) continue;
      if (P && P.isPowered && !P.isPowered(b)) continue;
      return b;
    }
    return null;
  }

  Biotech.orderExtraction = function (pawn) {
    if (!pawn || !pawn.isHuman) return false;
    pawn.geneExtractOrdered = true;
    return true;
  };
  Biotech.cancelExtraction = function (pawn) {
    if (!pawn) return false;
    pawn.geneExtractOrdered = false;
    return true;
  };
  Biotech.orderImplant = function (pawn, xenogerm) {
    if (!pawn || !xenogerm || xenogerm.defId !== 'xenogerm') return false;
    pawn.xenogermWantedId = xenogerm.id;
    return true;
  };
  Biotech.orderMechlink = function (pawn) {
    if (!pawn || !pawn.isHuman || pawn.mechanitor) return false;
    pawn.mechlinkWanted = true;
    return true;
  };

  function spawnGenepack(map, x, y, geneIds, sourceLabel) {
    var made = map.addItem('genepack', x, y, 1);
    var pack = made && made.length ? made[0] : null;
    if (!pack) return null;
    pack.packGenes = geneIds.join(',');
    pack.packSource = sourceLabel || '';
    return pack;
  }

  Biotech.packGenes = function (thing) {
    return thing ? geneStringToList(thing.packGenes) : [];
  };

  /* Which genes come out of a body: a sample, not the whole genome. */
  function sampleGenes(pawn) {
    var list = (pawn && pawn.genes && pawn.genes.list) ? pawn.genes.list.slice() : [];
    if (!list.length) return [];
    U.shuffle(list);
    var take = Math.max(1, Math.min(list.length, U.randInt(2, 4)));
    return list.slice(0, take);
  }

  Jobs.register('extractGenes', {
    label: 'extract genes',
    reportString: 'Extracting genes.',
    toils: function () {
      return [
        Toils.goto('A', { pe: Path.PE.ADJACENT, failIfGone: true }),
        Toils.work({
          amount: function () { return 1400; },
          skill: 'medicine',
          failIfGone: true,
          onDone: function (pawn, job) {
            var map = pawn.map;
            var subject = T.resolve(job.targetA, map);
            if (!subject) return 'fail';
            var lab = poweredBuilding(map, 'geneExtractor');
            if (!lab) return 'fail';

            var genes, label;
            if (subject.corpse) {
              genes = geneStringToList(subject.corpseGenes);
              label = subject.corpse.name || 'a corpse';
              map.destroyThing(subject, 'gene extraction');
            } else {
              genes = sampleGenes(subject);
              label = nameOf(subject);
              subject.geneExtractOrdered = false;
              var H = sys('Health');
              if (H && H.addHediff) H.addHediff(subject, 'geneExtraction', 1);
              thought(subject, 'btGenesTaken');
            }
            if (!genes.length) {
              msg('There was nothing worth keeping in ' + label + '\'s genome.', 'info', pawn);
              return 'next';
            }
            spawnGenepack(map, lab.x, lab.y, genes, label);
            msg('A genepack was extracted from ' + label + '.', 'good', pawn);
            pawn.learn('medicine', 220);
            return 'next';
          }
        })
      ];
    }
  });

  Jobs.register('assembleXenogerm', {
    label: 'assemble xenogerm',
    reportString: 'Assembling a xenogerm.',
    toils: function () {
      return [
        Toils.goto('A', { pe: Path.PE.INTERACTION, failIfGone: true }),
        Toils.work({
          amount: function () { return 2400; },
          skill: 'intellectual',
          failIfGone: true,
          onDone: function (pawn, job) {
            var map = pawn.map;
            var bench = T.resolve(job.targetA, map);
            if (!bench) return 'fail';
            var packs = packsNear(map, bench, 8);
            if (!packs.length) return 'fail';
            var genes = [], i, j;
            for (i = 0; i < packs.length && genes.length < 12; i++) {
              var list = geneStringToList(packs[i].packGenes);
              for (j = 0; j < list.length; j++) if (genes.indexOf(list[j]) < 0) genes.push(list[j]);
            }
            for (i = 0; i < packs.length; i++) map.destroyThing(packs[i], 'assembled');
            if (!genes.length) return 'fail';
            var made = map.addItem('xenogerm', bench.x, bench.y, 1);
            var germ = made && made.length ? made[0] : null;
            if (germ) {
              germ.germGenes = genes.join(',');
              germ.germXenotype = 'custom';
            }
            pawn.learn('intellectual', 360);
            msg('A xenogerm is ready: ' + genes.length + ' genes.', 'good', pawn);
            return 'next';
          }
        })
      ];
    }
  });

  function packsNear(map, bench, radius) {
    var out = [];
    var cells = U.cellsInRadius(bench.x, bench.y, radius);
    for (var i = 0; i < cells.length && out.length < 6; i++) {
      var x = cells[i][0], y = cells[i][1];
      if (!map.inBounds(x, y)) continue;
      var items = map.items(x, y);
      for (var j = 0; j < items.length; j++) {
        if (items[j].defId === 'genepack' && items[j].packGenes) out.push(items[j]);
      }
    }
    return out;
  }

  Jobs.register('implantXenogerm', {
    label: 'implant xenogerm',
    reportString: 'Implanting a xenogerm.',
    toils: function () {
      return [
        Toils.goto('B', { pe: Path.PE.TOUCH, failIfGone: true }),
        Toils.pickUp('B', function () { return 1; }),
        Toils.goto('A', { pe: Path.PE.ADJACENT, failIfGone: true }),
        Toils.work({
          amount: function () { return 1800; },
          skill: 'medicine',
          failIfGone: true,
          onDone: function (pawn, job) {
            var subject = T.resolve(job.targetA, pawn.map);
            var germ = pawn.carried;
            if (!subject || !germ || germ.defId !== 'xenogerm') return 'fail';
            Biotech.implantXenogerm(subject, geneStringToList(germ.germGenes));
            pawn.carried = null;
            subject.xenogermWantedId = 0;
            pawn.learn('medicine', 300);
            return 'next';
          }
        })
      ];
    }
  });

  Biotech.implantXenogerm = function (pawn, geneIds) {
    if (!pawn || !geneIds || !geneIds.length) return false;
    clearGenes(pawn);
    var st = ensureGenes(pawn);
    st.xenotype = 'custom';
    st.xenotypeLabel = 'custom xenotype';
    for (var i = 0; i < geneIds.length; i++) addGene(pawn, geneIds[i], true);
    refreshGenes(pawn);
    var H = sys('Health');
    if (H && H.addHediff) H.addHediff(pawn, 'xenogermSickness', 1);
    pawn.xenogermSickTicks = Math.round(5 * TICKS_PER_DAY);
    thought(pawn, 'btXenogermSick');
    letter('A xenogerm implanted', nameOf(pawn) + ' has been rewritten. They will be ill for ' +
      'about five days, and different when they get up.', 'neutral', pawn);
    return true;
  };

  Jobs.register('installMechlink', {
    label: 'install mechlink',
    reportString: 'Installing a mechlink.',
    toils: function () {
      return [
        Toils.goto('B', { pe: Path.PE.TOUCH, failIfGone: true }),
        Toils.pickUp('B', function () { return 1; }),
        Toils.goto('A', { pe: Path.PE.ADJACENT, failIfGone: true }),
        Toils.work({
          amount: function () { return 1600; },
          skill: 'medicine',
          failIfGone: true,
          onDone: function (pawn, job) {
            var subject = T.resolve(job.targetA, pawn.map);
            var link = pawn.carried;
            if (!subject || !link || link.defId !== 'mechlink') return 'fail';
            pawn.carried = null;
            Biotech.installMechlink(subject);
            pawn.learn('medicine', 280);
            return 'next';
          }
        })
      ];
    }
  });

  Biotech.installMechlink = function (pawn) {
    if (!pawn || pawn.mechanitor) return false;
    pawn.mechlinkWanted = false;
    pawn.mechanitor = { bandwidth: 6, controlled: [] };
    thought(pawn, 'btMechlinked');
    letter('A mechanitor', nameOf(pawn) + ' now carries a mechlink. They can hold six bandwidth ' +
      'of mechanoids, and every mech you wake spends some of it.', 'good', pawn);
    return true;
  };

  Jobs.register('tendGrowthVat', {
    label: 'tend growth vat',
    reportString: 'Servicing a growth vat.',
    toils: function () {
      return [
        Toils.goto('A', { pe: Path.PE.INTERACTION, failIfGone: true }),
        Toils.work({
          amount: function () { return 600; },
          skill: 'medicine',
          failIfGone: true,
          onDone: function (pawn, job) {
            var vat = T.resolve(job.targetA, pawn.map);
            if (vat) vat.vatTendUntil = now() + TICKS_PER_DAY;
            pawn.learn('medicine', 90);
            return 'next';
          }
        })
      ];
    }
  });

  Jobs.register('activateMechShell', {
    label: 'activate mech shell',
    reportString: 'Waking a mech.',
    toils: function () {
      return [
        Toils.goto('A', { pe: Path.PE.TOUCH, failIfGone: true }),
        Toils.work({
          amount: function () { return 900; },
          skill: 'intellectual',
          failIfGone: true,
          onDone: function (pawn, job) {
            var shell = T.resolve(job.targetA, pawn.map);
            if (!shell) return 'fail';
            var kindId = shell.mechKindId || Biotech.defaultMechKind(pawn);
            if (!kindId) return 'fail';
            var x = shell.x, y = shell.y;
            pawn.map.destroyThing(shell, 'activated');
            var mech = Biotech.spawnMech(pawn.map, kindId, x, y, pawn);
            if (mech) {
              msg(nameOf(pawn) + ' woke a ' + (MECH_KINDS[kindId].label) + '.', 'good', mech);
              pawn.learn('intellectual', 160);
            }
            return 'next';
          }
        })
      ];
    }
  });

  /* ------------------------------------------------------------------
     Work givers. prisoners.js already set the precedent that a system
     which arrives late registers its own scans; these are all narrow
     and bail in a property read when the colony has no biotech at all.
     ------------------------------------------------------------------ */

  function colonyHasAny(map, defId) {
    var list = map.byDef(defId);
    return !!(list && list.length);
  }

  WorkGivers.register({
    id: 'btExtractGenes', workType: 'doctor', order: 62, label: 'extract genes',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      if (!poweredBuilding(map, 'geneExtractor')) return null;
      var i, target = null;
      for (i = 0; i < map.pawns.length; i++) {
        var p = map.pawns[i];
        if (p === pawn || p.dead || !p.isHuman || !p.geneExtractOrdered) continue;
        if (!p.downed && !p.prisoner) continue;
        if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
        if (!Path.reachable(map, pawn.x, pawn.y, p.x, p.y, { pawn: pawn })) continue;
        target = T.pawn(p); break;
      }
      if (!target) {
        var corpses = map.byDef('corpse');
        for (i = 0; corpses && i < corpses.length; i++) {
          var c = corpses[i];
          if (!c.spawned || !c.geneExtractOrdered || !c.corpseGenes) continue;
          if (!Res.canReserve(pawn, T.thing(c), 1)) continue;
          if (!Path.reachable(map, pawn.x, pawn.y, c.x, c.y, { pawn: pawn })) continue;
          target = T.thing(c); break;
        }
      }
      if (!target) return null;
      if (!Res.reserve(pawn, target, 1)) return null;
      return Jobs.make('extractGenes', target);
    }
  });

  WorkGivers.register({
    id: 'btAssembleXenogerm', workType: 'craft', order: 74, label: 'assemble xenogerm',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var bench = poweredBuilding(map, 'geneAssembler');
      if (!bench || !bench.assembleOrdered) return null;
      if (packsNear(map, bench, 8).length < 1) return null;
      var target = T.thing(bench);
      if (!Res.canReserve(pawn, target, 1) || !Res.reserve(pawn, target, 1)) return null;
      bench.assembleOrdered = false;
      return Jobs.make('assembleXenogerm', target);
    }
  });

  WorkGivers.register({
    id: 'btImplantXenogerm', workType: 'doctor', order: 64, label: 'implant xenogerm',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      if (!colonyHasAny(map, 'xenogerm')) return null;
      for (var i = 0; i < map.pawns.length; i++) {
        var p = map.pawns[i];
        if (p.dead || !p.isHuman || !p.xenogermWantedId) continue;
        var germ = map.thing(p.xenogermWantedId);
        if (!germ || !germ.spawned) { p.xenogermWantedId = 0; continue; }
        var a = T.pawn(p), b = T.thing(germ);
        if (!Res.canReserve(pawn, a, 1) || !Res.canReserve(pawn, b, 1)) continue;
        if (!Path.reachable(map, pawn.x, pawn.y, germ.x, germ.y, { pawn: pawn })) continue;
        if (!Res.reserve(pawn, a, 1)) continue;
        if (!Res.reserve(pawn, b, 1)) { Res.release(pawn, a); continue; }
        return Jobs.make('implantXenogerm', a, b);
      }
      return null;
    }
  });

  WorkGivers.register({
    id: 'btInstallMechlink', workType: 'doctor', order: 66, label: 'install mechlink',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var links = map.byDef('mechlink');
      if (!links || !links.length) return null;
      for (var i = 0; i < map.pawns.length; i++) {
        var p = map.pawns[i];
        if (p.dead || !p.isHuman || !p.mechlinkWanted || p.mechanitor) continue;
        for (var j = 0; j < links.length; j++) {
          var link = links[j];
          if (!link.spawned) continue;
          var a = T.pawn(p), b = T.thing(link);
          if (!Res.canReserve(pawn, a, 1) || !Res.canReserve(pawn, b, 1)) continue;
          if (!Path.reachable(map, pawn.x, pawn.y, link.x, link.y, { pawn: pawn })) continue;
          if (!Res.reserve(pawn, a, 1)) continue;
          if (!Res.reserve(pawn, b, 1)) { Res.release(pawn, a); continue; }
          return Jobs.make('installMechlink', a, b);
        }
      }
      return null;
    }
  });

  WorkGivers.register({
    id: 'btTendVat', workType: 'doctor', order: 82, label: 'tend growth vat',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var vats = map.byDef('growthVat');
      if (!vats || !vats.length) return null;
      for (var i = 0; i < vats.length; i++) {
        var vat = vats[i];
        if (!vat.spawned || !vat.vatActive) continue;
        if (vat.vatTendUntil && vat.vatTendUntil > now()) continue;
        var target = T.thing(vat);
        if (!Res.canReserve(pawn, target, 1) || !Res.reserve(pawn, target, 1)) continue;
        return Jobs.make('tendGrowthVat', target);
      }
      return null;
    }
  });

  WorkGivers.register({
    id: 'btActivateMech', workType: 'craft', order: 76, label: 'activate mech shell',
    tryGiveJob: function (pawn) {
      if (!pawn.mechanitor) return null;
      var map = pawn.map;
      var shells = map.byDef('mechShell');
      if (!shells || !shells.length) return null;
      if (!Biotech.defaultMechKind(pawn)) return null;
      for (var i = 0; i < shells.length; i++) {
        var shell = shells[i];
        if (!shell.spawned) continue;
        var target = T.thing(shell);
        if (!Res.canReserve(pawn, target, 1)) continue;
        if (!Path.reachable(map, pawn.x, pawn.y, shell.x, shell.y, { pawn: pawn })) continue;
        if (!Res.reserve(pawn, target, 1)) continue;
        return Jobs.make('activateMechShell', target);
      }
      return null;
    }
  });

  /* ============================================================
     9. MECHANITORS AND MECHS
     ============================================================ */

  Biotech.mechKinds = function () {
    var out = [];
    for (var k in MECH_KINDS) out.push({ id: k, label: MECH_KINDS[k].label, bandwidth: MECH_KINDS[k].bandwidth });
    return out;
  };
  Biotech.isMech = function (pawn) { return !!(pawn && pawn.mech); };
  Biotech.isMechanitor = function (pawn) { return !!(pawn && pawn.mechanitor); };

  Biotech.bandwidthUsed = function (mechanitor) {
    if (!mechanitor || !mechanitor.mechanitor) return 0;
    var used = 0, map = mechanitor.map;
    var ids = mechanitor.mechanitor.controlled || [];
    for (var i = 0; i < ids.length; i++) {
      var m = pawnById(map, ids[i]);
      if (m && !m.dead && m.mech) used += MECH_KINDS[m.kindId] ? MECH_KINDS[m.kindId].bandwidth : 1;
    }
    return used;
  };

  Biotech.defaultMechKind = function (mechanitor) {
    if (!mechanitor || !mechanitor.mechanitor) return null;
    var free = mechanitor.mechanitor.bandwidth - Biotech.bandwidthUsed(mechanitor);
    var R = sys('Research');
    var order = ['mechHauler', 'mechCleaner', 'mechLifter', 'mechConstructoid', 'mechFabricor', 'mechMilitor'];
    for (var i = 0; i < order.length; i++) {
      var k = MECH_KINDS[order[i]];
      if (k.bandwidth > free) continue;
      if (k.combat && R && R.isDone && !R.isDone('standardMechtech')) continue;
      return order[i];
    }
    return null;
  };

  var mechCounter = 0;

  Biotech.spawnMech = function (map, kindId, x, y, mechanitor) {
    var spec = MECH_KINDS[kindId];
    if (!map || !spec || !root.Pawn) return null;
    mechCounter++;
    var skills = {};
    var all = Defs.all('skill');
    for (var i = 0; i < all.length; i++) skills[all[i].id] = 6;

    var mech = new root.Pawn(kindId, 'player', {
      x: x, y: y, map: map, ageYears: 0,
      traits: [], skills: skills,
      backstories: { childhood: null, adulthood: null },
      name: { first: '', nick: U.cap(spec.label) + ' ' + mechCounter, last: '' }
    });
    if (!mech) return null;

    mech.mech = {
      charge: 1, ownerId: mechanitor ? mechanitor.id : 0,
      dormant: false, bandwidth: spec.bandwidth
    };
    mech.tame = true;
    applyMechWork(mech, spec);

    /* A mech is not a person: needs are pinned so the think tree never
       sends it to bed or to dinner, and social.js is told to leave it
       out of the romance half of its own scan. */
    if (mech.needs) { mech.needs.food = 1; mech.needs.rest = 1; mech.needs.joy = 1; }
    var S = sys('Social');
    if (S && S.ensure) {
      var s = S.ensure(mech);
      if (s) s.orient = 'ace';
    }

    mech.spawn(map, x, y);
    if (spec.combat && mech.equipKindGear) mech.equipKindGear();
    if (mechanitor && mechanitor.mechanitor) mechanitor.mechanitor.controlled.push(mech.id);
    return mech;
  };

  function applyMechWork(mech, spec) {
    var types = Defs.all('workType');
    var wp = {};
    for (var i = 0; i < types.length; i++) {
      wp[types[i].id] = spec.work.indexOf(types[i].id) >= 0 ? 3 : 0;
    }
    mech.workPriority = wp;
  }

  Jobs.register('rechargeMech', {
    label: 'recharge',
    reportString: 'Recharging.',
    toils: function () {
      return [
        Toils.goto('A', { pe: Path.PE.ON_CELL, failIfGone: true }),
        Toils.custom({
          name: 'charge',
          init: function (pawn, job, s) { s.ticks = 0; },
          tick: function (pawn, job, s) {
            var pad = T.resolve(job.targetA, pawn.map);
            if (!pad) return 'fail';
            var P = sys('Power');
            if (P && P.isPowered && !P.isPowered(pad)) return 'fail';
            if (!pawn.mech) return 'done';
            pawn.mech.charge = U.clamp01(pawn.mech.charge + 1 / 3000);
            if (++s.ticks > 6000) return 'done';
            return pawn.mech.charge >= 1 ? 'done' : 'stay';
          }
        })
      ];
    }
  });

  function freeRecharger(map, mech) {
    var pads = map.byDef('mechRecharger');
    if (!pads || !pads.length) return null;
    var P = sys('Power');
    var best = null, bestD = Infinity;
    for (var i = 0; i < pads.length; i++) {
      var pad = pads[i];
      if (!pad.spawned) continue;
      if (P && P.isPowered && !P.isPowered(pad)) continue;
      if (!Res.canReserve(mech, T.thing(pad), 1)) continue;
      var d = U.distSq(mech.x, mech.y, pad.x, pad.y);
      if (d < bestD) { bestD = d; best = pad; }
    }
    return best;
  }

  function tickMech(mech) {
    var st = mech.mech;
    if (!st) return;

    /* Pinned every tick rather than every rare tick: needs.js has
       already decremented them by the time this runs, and a mech that
       drifts hungry would be sent to the larder by the think tree. */
    if (mech.needs) { mech.needs.food = 1; mech.needs.rest = 1; mech.needs.joy = 1; }

    /* A rogue mechanoid has no mechanitor and wants none: bandwidth,
       charge and work priorities are the colony's problem, and a hostile
       walking onto the map is combat.js's. Everything below this line
       would switch a raid off. */
    if (mech.faction !== 'player') return;

    if (((now() + mech.id) % RARE) !== 0) return;

    /* Charge falls faster while working than while standing about. */
    var drain = mech.job ? 1 / (2.2 * TICKS_PER_DAY) : 1 / (5 * TICKS_PER_DAY);
    st.charge = U.clamp01(st.charge - drain * RARE);

    var owner = st.ownerId ? pawnById(mech.map, st.ownerId) : null;
    if (!owner || owner.dead || !owner.mechanitor) owner = reassignMech(mech);

    var over = false;
    if (owner && owner.mechanitor) {
      var used = Biotech.bandwidthUsed(owner);
      over = used > owner.mechanitor.bandwidth;
    }
    st.dormant = !owner || over;

    /* A mech nobody is driving stops entirely: no work, no walk to a
       recharger, nothing. That is what bandwidth is for. */
    if (st.dormant) {
      if (mech.job) mech.endJob('interrupted');
      mech.jobQueue.length = 0;
      setAllWork(mech, 0);
      return;
    }

    /* Flat is not the same as dormant. A mech with nothing left in its
       cells does no work, but getting to a recharger is the one thing it
       must still be able to do, or a single missed night kills it. */
    if (st.charge <= 0.02) {
      setAllWork(mech, 0);
      if (mech.job && mech.job.defId !== 'rechargeMech') mech.endJob('interrupted');
    } else {
      applyMechWork(mech, MECH_KINDS[mech.kindId] || { work: [] });
    }

    if (st.charge >= 0.25) return;
    if (mech.job && mech.job.defId === 'rechargeMech') return;
    if (mech.jobQueue.length) return;

    var pad = freeRecharger(mech.map, mech);
    if (pad && Res.reserve(mech, T.thing(pad), 1)) {
      mech.jobQueue.push(Jobs.make('rechargeMech', T.thing(pad)));
    } else if (st.charge <= 0.02 && now() - (st.flatWarned || -99999) > TICKS_PER_DAY) {
      st.flatWarned = now();
      msg(nameOf(mech) + ' has run flat. It needs a powered recharger.', 'threat', mech);
    }
  }

  function setAllWork(mech, value) {
    var types = Defs.all('workType');
    for (var i = 0; i < types.length; i++) mech.workPriority[types[i].id] = value;
  }

  function reassignMech(mech) {
    var map = mech.map;
    if (!map) return null;
    var best = null, bestFree = -1;
    var list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p.mechanitor || p.dead || p.faction !== 'player') continue;
      var free = p.mechanitor.bandwidth - Biotech.bandwidthUsed(p);
      var need = MECH_KINDS[mech.kindId] ? MECH_KINDS[mech.kindId].bandwidth : 1;
      if (free >= need && free > bestFree) { bestFree = free; best = p; }
    }
    if (!best) { mech.mech.ownerId = 0; return null; }
    mech.mech.ownerId = best.id;
    if (best.mechanitor.controlled.indexOf(mech.id) < 0) best.mechanitor.controlled.push(mech.id);
    return best;
  }

  /* ============================================================
     10. THE TICK

     game.js resolves Biotech.tickPawn for every pawn every tick, so
     the cheap path here is one property read on a pawn with no genes,
     no pregnancy and no mechlink. The map-level work is hung off the
     same call behind a stamp, because the systems registry offers no
     map ticker for this file.
     ============================================================ */

  var mapTickStamp = -1;

  Biotech.tickPawn = function (pawn) {
    if (!pawn || pawn.dead || !pawn.map) return;

    if (pawn.mech) { tickMech(pawn); }

    var t = now();
    if (mapTickStamp !== t) { mapTickStamp = t; tickMap(pawn.map, t); }

    var fx = pawn._geneFx;
    if (fx && fx.noJoy && pawn.needs) pawn.needs.joy = 1;

    if (((t + pawn.id) % RARE) !== 0) return;
    if (pawn.mech) return;

    if (!fx && pawn.genes && pawn.genes.list && pawn.genes.list.length) fx = refreshGenes(pawn);

    if (pawn.isHuman) tickGrowth(pawn, t);
    if (pawn.pregnancy) tickPregnancy(pawn);
    if (fx) tickGeneEffects(pawn, fx, t);
    if (pawn.xenogermSickTicks > 0) {
      pawn.xenogermSickTicks -= RARE;
      if (pawn.xenogermSickTicks <= 0) {
        pawn.xenogermSickTicks = 0;
        var H = sys('Health');
        if (H && H.removeHediff) H.removeHediff(pawn, 'xenogermSickness');
      }
    }
    if (pawn.deathlessUntil && pawn.deathlessUntil <= t) wakeDeathless(pawn);
    if (pawn.faction === 'player' && !pawn.pregnancy) tryLovin(pawn, t);
  };

  function tickMap(map, t) {
    if ((t % 500) === 0) tickVats(map);
    if ((t % 2000) === 0) {
      ensureIncidents();
      noteChildrenMood(map);
    }
  }

  function noteChildrenMood(map) {
    var list = map.colonists();
    var kids = 0, i;
    for (i = 0; i < list.length; i++) {
      if (!list[i].mech && (list[i].ageYears || 0) < 13) kids++;
    }
    if (!kids) return;
    for (i = 0; i < list.length; i++) {
      if ((list[i].ageYears || 0) >= 13) thought(list[i], 'btChildrenHere');
    }
  }

  function tickGrowth(pawn, t) {
    var stage = Biotech.growthStage(pawn);
    if (stage !== pawn.growthStage) {
      applyStage(pawn, stage);
      if (pawn.faction === 'player' && stage !== 'adult') {
        msg(nameOf(pawn) + ' is now a ' + stage + '.', 'good', pawn);
      }
    }
    if (stage === 'adult') return;

    /* pawn.tickRare advances ageYears; the birthday is noticed here so
       childhood can pay out for it. */
    if (pawn.lastBirthdayAge === undefined) pawn.lastBirthdayAge = pawn.ageYears;
    if (pawn.ageYears > pawn.lastBirthdayAge) {
      pawn.lastBirthdayAge = pawn.ageYears;
      childBirthday(pawn);
    }
  }

  function tickGeneEffects(pawn, fx, t) {
    var H = sys('Health');

    if (fx.age !== 1) {
      /* Slow aging gives back most of what pawn.tickRare just charged. */
      pawn.ageTicks -= RARE * (1 - fx.age);
      if (pawn.ageTicks < 0) pawn.ageTicks = 0;
    }

    if (fx.heal && H && H.heal && pawn.health && pawn.health.injuries.length) {
      var injuries = pawn.health.injuries;
      for (var i = injuries.length - 1; i >= 0; i--) {
        if (injuries[i].permanent) continue;
        H.heal(pawn, injuries[i], 0.05 * fx.heal);
      }
    }

    if (fx.noPain && pawn.health && pawn.health.injuries.length) {
      var inj = pawn.health.injuries;
      for (var j = 0; j < inj.length; j++) {
        if (inj[j].painFactor !== 0) { inj[j].painFactor = 0; H.invalidate(pawn); }
      }
    }

    if (fx.clot < 1 && pawn.health) {
      var list = pawn.health.injuries;
      for (var k = 0; k < list.length; k++) {
        if (list[k].bleedRate > 0) list[k].bleedRate *= (1 - (1 - fx.clot) * 0.25);
      }
    }

    /* Temperature tolerance is spent shrugging off what the cold already
       did rather than redefining a comfort range health.js owns. */
    if (H && H.hediff) {
      if (fx.cold > 0) shrugOff(pawn, H, 'hypothermia', fx.cold / 40);
      if (fx.heat > 0) shrugOff(pawn, H, 'heatstroke', fx.heat / 40);
      if (fx.toxic > 0) shrugOff(pawn, H, 'foodPoisoning', fx.toxic * 0.4);
    }

    /* Roughly one bout every ten days: enough that a sickly colonist is
       a doctor's problem, not enough that they live in bed. */
    if (fx.sickly && H && H.addHediff && U.chance(0.0004)) {
      if (!H.hasHediff(pawn, 'flu')) {
        H.addHediff(pawn, 'flu', 0.05);
        msg(nameOf(pawn) + ' has fallen ill again.', 'threat', pawn);
      }
    }

    if (fx.aggression && (t % 4000) < RARE) thought(pawn, 'btGeneAggression');
    if (fx.content && (t % 4000) < RARE) thought(pawn, 'btGeneContentment');

    if (fx.drugNeed && (t % 6000) < RARE) {
      var D = sys('Drugs');
      var satisfied = !!(D && D.isSatisfied && D.isSatisfied(pawn));
      if (!satisfied) thought(pawn, 'btGeneCraving');
    }

    if (fx.hungerFromMetabolism > 1 && pawn.needs) {
      /* A pawn who spent more metabolism than their body can pay for
         burns the difference. The figure is a fraction of the contract's
         1.6-per-day food fall, charged over the same rare tick, so a
         metabolism of +4 costs about a third of a meal a day rather than
         a meal and a half. */
      var extra = (fx.hungerFromMetabolism - 1) * (1.6 / TICKS_PER_DAY) * RARE;
      pawn.needs.food = U.clamp01(pawn.needs.food - extra);
    }
  }

  function shrugOff(pawn, H, id, strength) {
    var hd = H.hediff(pawn, id);
    if (!hd) return;
    hd.severity -= strength * 0.06;
    if (hd.severity <= 0.01) H.removeHediff(pawn, id);
    else H.invalidate(pawn);
  }

  /* Conception. social.js decides who is together; this only asks
     whether they are together right now, asleep, and within reach. */
  function tryLovin(pawn, t) {
    if (pawn.gender !== 'female' || !fertile(pawn) || !pawn.asleep) return;
    var S = sys('Social');
    if (!S || !S.partnerOf) return;
    var partner = S.partnerOf(pawn);
    if (!partner || !partner.asleep || partner.dead) return;
    if (U.cheb(pawn.x, pawn.y, partner.x, partner.y) > 1) return;
    if (pawn.lovinTick && t - pawn.lovinTick < TICKS_PER_DAY) return;
    pawn.lovinTick = t;
    Biotech.tryConceive(pawn, partner);
  }

  function wakeDeathless(pawn) {
    pawn.deathlessUntil = 0;
    var H = sys('Health');
    if (H && H.removeHediff) H.removeHediff(pawn, 'deathlessComa');
    if (pawn.health) pawn.health.bloodLoss = Math.min(pawn.health.bloodLoss, 0.3);
    msg(nameOf(pawn) + ' has got back up. They do not stay dead.', 'good', pawn);
  }

  /* ============================================================
     11. INCIDENTS

     events.js loads after this file, so the registration is lazy and
     runs once from the map tick.
     ============================================================ */

  var incidentsDone = false;

  function ensureIncidents() {
    if (incidentsDone) return;
    var I = sys('Incidents');
    if (!I || !I.register) return;
    incidentsDone = true;

    I.register({
      id: 'geneBankShipment', label: 'genepack shipment', category: 'good', minDay: 12,
      weight: function (game) {
        var R = sys('Research');
        return (R && R.isDone && R.isDone('xenogenetics')) ? 0.8 : 0;
      },
      fire: function (game) {
        var map = game.map;
        if (!map) return false;
        var MGen = sys('MapGen');
        var spot = MGen && MGen.dropPodSpot ? MGen.dropPodSpot(map) : null;
        if (!spot) return false;
        var n = U.randInt(1, 3);
        for (var i = 0; i < n; i++) {
          var genes = [];
          for (var j = 0; j < U.randInt(2, 4); j++) {
            var g = U.pick(GENE_LIST);
            if (genes.indexOf(g.id) < 0) genes.push(g.id);
          }
          spawnGenepack(map, spot.x, spot.y, genes, 'a drop pod');
        }
        letter('Genepacks in a pod', 'A sealed pod came down with ' + n + ' genepack' +
          (n === 1 ? '' : 's') + ' in it. Somebody\'s genome, going cheap.',
          'good', { x: spot.x, y: spot.y });
        return true;
      }
    });

    I.register({
      id: 'mechCluster', label: 'wandering mechanoid', category: 'threatSmall', minDay: 20,
      weight: function () { return 0.5; },
      fire: function (game, points) {
        var map = game.map;
        if (!map) return false;
        var MGen = sys('MapGen');
        var cells = MGen && MGen.edgeSpawnCells ? MGen.edgeSpawnCells(map, null) : null;
        if (!cells || !cells.length) return false;
        var count = U.clamp(Math.round((points || 100) / 120), 1, 4);
        var made = 0;
        for (var i = 0; i < count; i++) {
          var c = cells[U.randInt(0, cells.length - 1)];
          var mech = new root.Pawn('mechMilitor', 'raider', {
            x: c.x, y: c.y, map: map, ageYears: 0, traits: [], skills: {},
            backstories: { childhood: null, adulthood: null },
            name: { first: '', nick: 'Rogue militor', last: '' }
          });
          if (!mech) continue;
          mech.mech = { charge: 1, ownerId: 0, dormant: false, bandwidth: 1 };
          mech.spawn(map, c.x, c.y);
          if (mech.equipKindGear) mech.equipKindGear();
          made++;
        }
        if (!made) return false;
        letter('Mechanoids', made + ' rogue mechanoid' + (made === 1 ? '' : 's') +
          ' walked onto the map. Nothing is driving them and they do not care.',
          'threat', { x: cells[0].x, y: cells[0].y });
        return true;
      }
    });

    I.register({
      id: 'xenotypeRefugee', label: 'xenotype refugee', category: 'good', minDay: 8,
      weight: function () { return 0.7; },
      fire: function (game) {
        var map = game.map;
        var MGen = sys('MapGen');
        if (!map || !MGen || !MGen.makePawn || !MGen.edgeSpawnCells) return false;
        var cells = MGen.edgeSpawnCells(map, null);
        if (!cells || !cells.length) return false;
        var c = cells[U.randInt(0, cells.length - 1)];
        var pawn = MGen.makePawn('colonist', 'player', { x: c.x, y: c.y, map: map });
        if (!pawn) return false;
        var pool = [];
        for (var i = 0; i < XENOTYPES.length; i++) {
          if (XENOTYPES[i].id !== 'baseliner') pool.push(XENOTYPES[i]);
        }
        var x = U.pickWeighted(pool, function (v) { return v.weight; }) || pool[0];
        Biotech.applyXenotype(pawn, x.id);
        pawn.spawn(map, c.x, c.y);
        letter('A refugee', 'A ' + x.label + ' has walked out of the treeline asking to stay. ' +
          x.description, 'good', pawn);
        return true;
      }
    });
  }

  /* ============================================================
     12. SAVE

     Per-pawn state is in plain fields, so save.js carries it without
     being told. What is left is this file's own counters and the
     rebuild of everything derived from the gene lists.
     ============================================================ */

  Biotech.save = function () {
    return { mechCounter: mechCounter, incidents: incidentsDone };
  };

  Biotech.load = function (obj) {
    mechCounter = (obj && obj.mechCounter) | 0;
    incidentsDone = incidentsDone || !!(obj && obj.incidents);
    return true;
  };

  /* Called after a load, and safe to call at any time: every derived
     value here follows from the pawn's own saved fields. */
  Biotech.rebuild = function (map) {
    if (!map) return 0;
    var n = 0;
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (p.genes && p.genes.list && p.genes.list.length) { refreshGenes(p); n++; }
      if (p.mech && MECH_KINDS[p.kindId]) applyMechWork(p, MECH_KINDS[p.kindId]);
      if (p.isHuman && !p.mech) {
        var stage = Biotech.growthStage(p);
        if (stage !== p.growthStage) applyStage(p, stage);
      }
    }
    return n;
  };

  Biotech.reset = function () {
    mechCounter = 0;
    mapTickStamp = -1;
  };

  /* ============================================================
     13. THE CHAINS

     Four functions the engine owns and this file may not edit. Each
     original is kept and called, so another expansion chaining the
     same function composes with this one, and each addition bails in
     a property read when no gene, mech or child is involved.
     ============================================================ */

  /* Genes that change how much a blow does, and the frailty that pays
     for them. The options object is copied rather than edited: combat.js
     is entitled to reuse the one it passed. */
  (function chainDamage() {
    var H = sys('Health');
    if (!H || !H.damage || H.__biotechDamage) return;
    var base = H.damage;
    H.__biotechDamage = true;
    H.damage = function (pawn, opts) {
      var fx = pawn && pawn._geneFx;
      if (!fx || !opts || !(opts.amount > 0)) return base.call(H, pawn, opts);

      var factor = fx.fragile;
      var type = opts.type;
      if (type === 'flame' || type === 'burn' || type === 'heat') factor *= (1 - fx.armorHeat);
      else if (type === 'cut' || type === 'stab' || type === 'bite' || type === 'gunshot') {
        factor *= (1 - fx.armorSharp);
      } else if (type === 'blunt') factor *= (1 - fx.armorBlunt);
      if (factor === 1) return base.call(H, pawn, opts);

      var copy = {}, k;
      for (k in opts) copy[k] = opts[k];
      copy.amount = Math.max(0, opts.amount * Math.max(0, factor));
      var result = base.call(H, pawn, copy);
      if (fx.noPain && pawn.health) {
        var inj = pawn.health.injuries;
        for (var i = 0; i < inj.length; i++) inj[i].painFactor = 0;
        H.invalidate(pawn);
      }
      return result;
    };
  })();

  /* Deathless. A mortal wound puts the pawn into a coma the body walks
     out of a day later, and the coma clears whatever was killing them
     so the next rare tick does not simply kill them again. */
  (function chainKill() {
    var H = sys('Health');
    if (!H || !H.kill || H.__biotechKill) return;
    var base = H.kill;
    H.__biotechKill = true;
    H.kill = function (pawn, cause) {
      var fx = pawn && pawn._geneFx;
      if (!fx || !fx.deathless || pawn.deathlessUntil > 0) return base.call(H, pawn, cause);
      var h = pawn.health;
      if (!h || h.dead) return base.call(H, pawn, cause);

      h.hediffs.length = 0;
      h.bloodLoss = 0.5;
      for (var i = h.injuries.length - 1; i >= 0; i--) {
        h.injuries[i].bleedRate = 0;
        h.injuries[i].tended = true;
        h.injuries[i].tendQuality = 0.6;
      }
      for (var p = 0; p < h.parts.length; p++) {
        if (h.parts[p].vital && (h.parts[p].missing || h.parts[p].hp <= 0)) {
          h.parts[p].missing = false;
          h.parts[p].hp = Math.max(1, Math.round(h.parts[p].maxHp * 0.25));
        }
      }
      H.addHediff(pawn, 'deathlessComa', 1);
      pawn.deathlessUntil = now() + TICKS_PER_DAY;
      pawn.downed = true;
      h.downed = true;
      H.invalidate(pawn);
      letter('It got back up', nameOf(pawn) + ' took a wound that would have killed anybody ' +
        'else. They are not dead. They are going to be up by this time tomorrow.',
        'neutral', pawn);
      return;
    };
  })();

  /* A mech is a pawn with isHuman true so the work givers will talk to
     it. Everything that counts colonists - game over, the alert list,
     raid points, the colonist bar - goes through this one function, so
     this is the one place mechs have to be taken back out. */
  (function chainColonists() {
    var M = root.GameMap;
    if (!M || !M.prototype || M.prototype.__biotechColonists) return;
    var base = M.prototype.colonists;
    if (typeof base !== 'function') return;
    M.prototype.__biotechColonists = true;
    M.prototype.colonists = function () {
      var list = base.call(this);
      for (var i = list.length - 1; i >= 0; i--) if (list[i].mech) list.splice(i, 1);
      return list;
    };
  })();

  /* Generated pawns get a xenotype. mapgen.js has no hook for it and is
     not ours to edit, so the factory is wrapped: a caller who states a
     xenotype gets that one, everybody else gets a roll weighted by the
     tech level of whoever they belong to. */
  (function chainMakePawn() {
    var MG = root.MapGen;
    if (!MG || !MG.makePawn || MG.__biotechMakePawn) return;
    var base = MG.makePawn;
    MG.__biotechMakePawn = true;
    MG.makePawn = function (kindId, faction, opts) {
      var pawn = base.call(MG, kindId, faction, opts);
      if (!pawn || !pawn.isHuman || pawn.mech) return pawn;
      opts = opts || {};
      if (opts.xenotype === false) return pawn;
      var id = opts.xenotype || Biotech.rollXenotype(faction, kindId);
      if (id && id !== 'baseliner') Biotech.applyXenotype(pawn, id);
      else ensureGenes(pawn);
      /* A pawn generated as a child - a refugee family, a colony-born
         baby restored from a save - needs the stage applied before it
         is asked for work. */
      var stage = Biotech.growthStage(pawn);
      if (stage !== 'adult') applyStage(pawn, stage);
      return pawn;
    };
  })();

  /* A corpse remembers whose genes it is carrying, because the genepack
     that comes out of it is the whole point of extracting from the dead
     and a corpse Thing keeps no reference to the pawn it was. */
  (function chainDeath() {
    var P = root.Pawn;
    if (!P || !P.onDeath || P.__biotechDeath) return;
    var base = P.onDeath;
    P.__biotechDeath = true;
    P.onDeath = function (pawn, cause) {
      var genes = (pawn && pawn.genes && pawn.genes.list) ? pawn.genes.list.join(',') : '';
      var map = pawn && pawn.map;
      var before = map && map.byDef ? map.byDef('corpse').length : 0;
      base.call(P, pawn, cause);
      if (!genes || !map || !map.byDef) return;
      var corpses = map.byDef('corpse');
      for (var i = corpses.length - 1; i >= 0 && corpses.length > before; i--) {
        if (corpses[i].corpse && corpses[i].corpse.pawnId === pawn.id) {
          corpses[i].corpseGenes = genes;
          break;
        }
      }
    };
  })();

  root.Biotech = Biotech;
})(this);
