/* ============================================================
   medicine.js - what a doctor does on purpose.

   health.js owns wounds: where a bullet lands, how fast it bleeds,
   when a pawn falls over and when they stop. Nothing here repeats any
   of that. This file owns the deliberate half of medicine - the things
   a player decides and a surgeon carries out - and it reaches that
   half through health.js's own vocabulary rather than around it.

   Four ideas hold it together:

   1. An operation is a bill on a PATIENT, not on a workbench. The
      player queues it against a body part, a doctor with the skill
      walks to the bed and spends real work time on it, and it can go
      wrong. Surgery that cannot fail is a menu, not a decision.

   2. An implant is a body part that was replaced. A peg leg is a part
      restored to 55% of what it was, which health.js already knows how
      to express - a permanent injury the part never heals off - so a
      peg leg slows a colonist down through exactly the arithmetic a
      shot-up leg does. Anything BETTER than flesh cannot be said that
      way, because every capacity health.js computes is clamped to 1,
      so the handful of above-baseline bonuses are applied where they
      are read instead. See INSTALL at the foot of the file.

   3. Disease is a race. Severity climbs on its own; immunity climbs
      only if the patient is in bed, tended, fed and rested. health.js
      runs that race for every hediff in its table, so the diseases
      here are registered INTO that table rather than simulated again,
      and this file adds only the part health.js cannot see: whether
      the bed is in a hospital worth the name.

   4. Organs are items. Cutting one out of a corpse is butchery with a
      scalpel; cutting one out of a living prisoner is the heaviest
      thing a colony can do to itself, and it is priced that way.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  var TICKS_PER_DAY = 60000;

  /* Beats. Disease and ageing move over days, so they are looked at on
     their own slow clocks, staggered by pawn id the way health.js
     staggers its rare tick. */
  var IMMUNITY_BEAT = 250;
  var DISEASE_BEAT = 2500;
  var AGE_BEAT = 15000;

  /* jobs.js, workgivers.js, needs.js and the rest load after this file,
     so everything below reaches for them by name at tick time. */
  function sys(name) { return root[name] || null; }
  function now() {
    var G = root.Game;
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }
  function day() { return Math.floor(now() / TICKS_PER_DAY); }

  function msg(text, type, pawn) {
    var G = root.Game;
    if (!G || !G.msg) return;
    G.msg(text, { type: type || 'info', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }

  function letter(title, text, kind, pawn) {
    var G = root.Game;
    if (!G || !G.letter) return;
    G.letter(title, text, { kind: kind || 'neutral', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    if (typeof pawn.fullName === 'function') return pawn.fullName();
    var n = pawn.name;
    return (n && (n.nick || n.first)) || 'someone';
  }

  function skillLevel(pawn, id) {
    var s = pawn && pawn.skills && pawn.skills[id];
    return (s && typeof s.level === 'number') ? s.level : 0;
  }

  function hasTrait(pawn, id) {
    var list = pawn && pawn.traits;
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (t === id || (t && t.id === id)) return true;
    }
    return false;
  }

  function isHuman(pawn) { return !!pawn && pawn.isHuman === true; }

  /* pawn.js sets isHuman to "not an animal", which is true of a
     mechanoid as well, and the rest of the game is happy with that.
     Surgery is not: a mech has no kidney to take and no back to go
     bad, so anything that cuts into a body asks for flesh. */
  function isFlesh(pawn) {
    if (!isHuman(pawn)) return false;
    var kind = pawn.kind || Defs.maybe('pawnKind', pawn.kindId);
    return !!kind && kind.body === 'human';
  }

  function think(pawn, thoughtId, opts) {
    var N = sys('Needs');
    if (N && N.addThought && isHuman(pawn) && !pawn.dead) N.addThought(pawn, thoughtId, opts || {});
  }

  var Medicine = {};

  /* ============================================================
     1. CONTENT

     Everything below is registered at load and never again. The id
     registry in the contract is extended, not edited: no id here
     belongs to another file.
     ============================================================ */

  var S11 = Object.freeze({ w: 1, h: 1 });

  /* Every field a consumer may read, present on every def, exactly as
     def_things.js promises for its own tables. */
  var PART_ITEM = {
    category: 'item',
    description: '',
    sprite: 'item', color: '#8f97a3', color2: null,
    stackLimit: 1, mass: 2, marketValue: 100,
    nutrition: 0, foodType: null, rotDays: null,
    isMedicine: false, medicinePotency: 0,
    passable: true, pathCost: 0, fillPercent: 0, blocksLight: false, holdsRoof: false,
    size: S11, rotatable: false, hp: 60, flammable: false,
    beauty: 0, comfort: 0, natural: false,
    buildCost: null, stuffable: false, workToBuild: 0, buildSkill: null,
    buildCategory: null, researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null,
    building: null, weapon: null, apparel: null,
    isBodyPart: true, isOrgan: false
  };

  Defs.add('thing', {

    /* ---- crude: worse than what it replaced, and cheap enough to be
       the answer on day nine when somebody loses a leg to a wolf. ---- */
    pegLeg: {
      label: 'peg leg',
      description: 'A shaped length of wood and a leather cup. It takes weight, it does not ' +
        'take orders, and the colonist who wears one is slower for the rest of their life.',
      color: '#a9783f', color2: '#7b5427', marketValue: 40, mass: 2.5, flammable: true,
      researchPrerequisite: 'prosthetics'
    },
    hookHand: {
      label: 'hook hand',
      description: 'A steel hook on a socket. Better than a stump for carrying a crate, ' +
        'worse than a hand for everything else.',
      color: '#8f97a3', color2: '#5a5a62', marketValue: 50, mass: 1.5,
      researchPrerequisite: 'prosthetics'
    },

    /* ---- simple: as good as the original, and that is the point. ---- */
    prostheticArm: {
      label: 'prosthetic arm',
      description: 'A jointed arm of steel and plastic, fitted and calibrated. As good as ' +
        'the one it replaces, which for an amputee is everything.',
      color: '#c6ccd6', color2: '#7b8290', marketValue: 320, mass: 4,
      researchPrerequisite: 'prosthetics'
    },
    prostheticLeg: {
      label: 'prosthetic leg',
      description: 'A sprung leg with a powered ankle. Walks at a normal pace and asks ' +
        'nothing back.',
      color: '#c6ccd6', color2: '#7b8290', marketValue: 320, mass: 5,
      researchPrerequisite: 'prosthetics'
    },

    /* ---- bionic: better than flesh, and priced like it. ---- */
    bionicArm: {
      label: 'bionic arm',
      description: 'Myoelectric muscle over a memory-alloy frame. Steadier than a real arm ' +
        'and it never tires, which shows up in everything the colonist makes.',
      color: '#6fd0c8', color2: '#2f6f70', marketValue: 1400, mass: 4,
      researchPrerequisite: 'bionics'
    },
    bionicLeg: {
      label: 'bionic leg',
      description: 'A powered leg that pushes off harder than the one it replaced. A pair ' +
        'of them is the difference between arriving and arriving in time.',
      color: '#6fd0c8', color2: '#2f6f70', marketValue: 1400, mass: 5,
      researchPrerequisite: 'bionics'
    },
    bionicEye: {
      label: 'bionic eye',
      description: 'A sensor cluster wired straight into the optic nerve. It ranges, it ' +
        'compensates for wind, and it does not blink at the wrong moment.',
      color: '#6fd0c8', color2: '#c0392b', marketValue: 1600, mass: 0.5,
      researchPrerequisite: 'bionics'
    },
    bionicHeart: {
      label: 'bionic heart',
      description: 'A sealed pump that will outlive its owner. Steady blood under load, ' +
        'which is most of what stamina ever was.',
      color: '#6fd0c8', color2: '#8b1a1a', marketValue: 1800, mass: 1,
      researchPrerequisite: 'bionics'
    },
    bionicSpine: {
      label: 'bionic spine',
      description: 'A reinforced column with its own nerve bridge. Fixes a bad back, and ' +
        'fixes the ones nobody knew they had.',
      color: '#6fd0c8', color2: '#2f6f70', marketValue: 2000, mass: 3,
      researchPrerequisite: 'bionics'
    },
    cochlearImplant: {
      label: 'cochlear implant',
      description: 'A receiver seated behind the ear. Gives back hearing a mortar took, ' +
        'and nothing more than that.',
      color: '#c6ccd6', color2: '#2f6f70', marketValue: 800, mass: 0.3,
      researchPrerequisite: 'neuralImplants'
    },

    /* ---- weapons that live inside the arm ---- */
    drillArm: {
      label: 'drill arm',
      description: 'A mining drill on a shoulder mount. Chews rock, and chews anything ' +
        'that walks into the colony while it is running.',
      color: '#c4622a', color2: '#5a5a62', marketValue: 1200, mass: 6,
      researchPrerequisite: 'neuralImplants'
    },
    powerClaw: {
      label: 'power claw',
      description: 'Three hydraulic fingers that close with about a tonne behind them. ' +
        'Terrible for fine work. Not meant for fine work.',
      color: '#8f97a3', color2: '#c0392b', marketValue: 1300, mass: 5,
      researchPrerequisite: 'neuralImplants'
    },
    painstopper: {
      label: 'painstopper',
      description: 'A neural cutout seated at the base of the skull. The pain simply stops. ' +
        'So does the part of a person that notices they are dying.',
      color: '#b58fd6', color2: '#3a2b4f', marketValue: 1100, mass: 0.3,
      researchPrerequisite: 'neuralImplants'
    },

    /* ---- organs: items that spoil, sell, and go back into somebody ---- */
    organKidney: {
      label: 'kidney',
      description: 'A harvested kidney, packed cold. Worth a great deal to the right buyer ' +
        'and worth everything to whoever needs one.',
      color: '#8b3a3a', color2: '#5c2222', marketValue: 300, mass: 0.6,
      rotDays: 4, isOrgan: true, flammable: true
    },
    organLung: {
      label: 'lung',
      description: 'A harvested lung. Keeps for a few days in the cold and no time at all ' +
        'in the sun.',
      color: '#a34a4a', color2: '#6b2828', marketValue: 350, mass: 0.8,
      rotDays: 4, isOrgan: true, flammable: true
    },
    organLiver: {
      label: 'liver',
      description: 'A harvested liver. The hardest organ to live without and the easiest ' +
        'to sell.',
      color: '#7a3020', color2: '#4e1d12', marketValue: 450, mass: 1.2,
      rotDays: 4, isOrgan: true, flammable: true
    },
    organHeart: {
      label: 'heart',
      description: 'A harvested heart. Nobody gives one up and survives it.',
      color: '#8b1a1a', color2: '#5a0f0f', marketValue: 600, mass: 0.8,
      rotDays: 4, isOrgan: true, flammable: true
    },
    organEye: {
      label: 'eye',
      description: 'A harvested eye in a sealed jar. Packs small. Sells well. Reads badly ' +
        'on a manifest.',
      color: '#c9c3b4', color2: '#3a5f7a', marketValue: 250, mass: 0.2,
      rotDays: 4, isOrgan: true, flammable: true
    }

  }, PART_ITEM);

  /* ---- research ---- */

  Defs.add('research', {
    prosthetics: {
      label: 'prosthetics', cost: 900, techLevel: 'medieval', tab: 'basic',
      description: 'Sockets, straps and jointed limbs. A colonist who loses an arm stops ' +
        'being a bystander and goes back to work.',
      prerequisites: ['smithing'],
      unlocks: ['pegLeg', 'hookHand', 'prostheticArm', 'prostheticLeg',
                'makePegLeg', 'makeHookHand', 'makeProstheticArm', 'makeProstheticLeg'],
      uiPosition: { x: 1, y: 4 }
    },
    bionics: {
      label: 'bionics', cost: 2600, techLevel: 'spacer', tab: 'advanced',
      description: 'Powered limbs and sensors that beat the flesh they replace. Expensive, ' +
        'slow to build, and the reason a veteran colonist is worth three new ones.',
      prerequisites: ['prosthetics', 'machining', 'medicineProduction'],
      unlocks: ['bionicArm', 'bionicLeg', 'bionicEye', 'bionicHeart', 'bionicSpine',
                'makeBionicArm', 'makeBionicLeg', 'makeBionicEye', 'makeBionicHeart',
                'makeBionicSpine'],
      uiPosition: { x: 2, y: 4 }
    },
    neuralImplants: {
      label: 'neural implants', cost: 3200, techLevel: 'spacer', tab: 'advanced',
      description: 'Wiring the machine to the nerve rather than the muscle. A hearing ' +
        'implant, a pain cutout, and two things nobody should have to shake hands with.',
      prerequisites: ['bionics'],
      unlocks: ['cochlearImplant', 'painstopper', 'drillArm', 'powerClaw',
                'makeCochlearImplant', 'makePainstopper', 'makeDrillArm', 'makePowerClaw'],
      uiPosition: { x: 3, y: 4 }
    }
  });

  /* ---- recipes ----
     Everything is built at the smithy: it is the metal bench the colony
     already has, and inventing a second one would put an unreachable
     build order between a lost leg and a peg. */

  var RECIPE_DEFAULTS = {
    jobString: 'Fabricating', skill: 'crafting', skillRequirement: 0,
    workType: 'craft', uiCategory: 'prosthetics', workbenches: ['smithy'],
    products: {}, dynamicProducts: false, productQuality: false,
    researchPrerequisite: null,
    defaultRepeat: 'count', defaultTargetCount: 1, defaultIngredientRadius: 999,
    foodPoisonChance: 0, description: ''
  };

  Defs.add('recipe', {
    makePegLeg: {
      label: 'peg leg', workAmount: 700, skillRequirement: 2,
      ingredients: [{ thing: 'wood', count: 30 }],
      products: { pegLeg: 1 }, researchPrerequisite: 'prosthetics',
      description: 'Cheap, quick, and better than a stump.'
    },
    makeHookHand: {
      label: 'hook hand', workAmount: 700, skillRequirement: 2,
      ingredients: [{ thing: 'steel', count: 15 }],
      products: { hookHand: 1 }, researchPrerequisite: 'prosthetics',
      description: 'A hook and a socket. Carries a crate, drops a needle.'
    },
    makeProstheticArm: {
      label: 'prosthetic arm', workAmount: 2400, skillRequirement: 5,
      ingredients: [{ thing: 'steel', count: 50 }, { thing: 'components', count: 4 }],
      products: { prostheticArm: 1 }, researchPrerequisite: 'prosthetics',
      description: 'A jointed arm that works as well as the one it replaces.'
    },
    makeProstheticLeg: {
      label: 'prosthetic leg', workAmount: 2400, skillRequirement: 5,
      ingredients: [{ thing: 'steel', count: 50 }, { thing: 'components', count: 4 }],
      products: { prostheticLeg: 1 }, researchPrerequisite: 'prosthetics',
      description: 'A sprung leg that walks at a normal pace.'
    },
    makeBionicArm: {
      label: 'bionic arm', workAmount: 5200, skillRequirement: 9,
      ingredients: [{ thing: 'steel', count: 70 }, { thing: 'components', count: 12 }],
      products: { bionicArm: 1 }, researchPrerequisite: 'bionics',
      description: 'Steadier than flesh. Everything the colonist makes gets better.'
    },
    makeBionicLeg: {
      label: 'bionic leg', workAmount: 5200, skillRequirement: 9,
      ingredients: [{ thing: 'steel', count: 70 }, { thing: 'components', count: 12 }],
      products: { bionicLeg: 1 }, researchPrerequisite: 'bionics',
      description: 'Pushes off harder than the leg it replaced.'
    },
    makeBionicEye: {
      label: 'bionic eye', workAmount: 5600, skillRequirement: 10,
      ingredients: [{ thing: 'steel', count: 40 }, { thing: 'components', count: 14 }],
      products: { bionicEye: 1 }, researchPrerequisite: 'bionics',
      description: 'Ranges the shot and compensates for the wind.'
    },
    makeBionicHeart: {
      label: 'bionic heart', workAmount: 6000, skillRequirement: 11,
      ingredients: [{ thing: 'steel', count: 50 }, { thing: 'components', count: 16 }],
      products: { bionicHeart: 1 }, researchPrerequisite: 'bionics',
      description: 'A pump that will outlive its owner.'
    },
    makeBionicSpine: {
      label: 'bionic spine', workAmount: 6400, skillRequirement: 12,
      ingredients: [{ thing: 'steel', count: 60 }, { thing: 'components', count: 18 }],
      products: { bionicSpine: 1 }, researchPrerequisite: 'bionics',
      description: 'Fixes a bad back, and the ones nobody knew they had.'
    },
    makeCochlearImplant: {
      label: 'cochlear implant', workAmount: 3600, skillRequirement: 8,
      ingredients: [{ thing: 'steel', count: 20 }, { thing: 'components', count: 8 }],
      products: { cochlearImplant: 1 }, researchPrerequisite: 'neuralImplants',
      description: 'Gives back the hearing a mortar took.'
    },
    makePainstopper: {
      label: 'painstopper', workAmount: 4200, skillRequirement: 10,
      ingredients: [{ thing: 'steel', count: 25 }, { thing: 'components', count: 10 }],
      products: { painstopper: 1 }, researchPrerequisite: 'neuralImplants',
      description: 'The pain stops. So does the sense of how bad things are.'
    },
    makeDrillArm: {
      label: 'drill arm', workAmount: 5000, skillRequirement: 10,
      ingredients: [{ thing: 'steel', count: 80 }, { thing: 'components', count: 10 }],
      products: { drillArm: 1 }, researchPrerequisite: 'neuralImplants',
      description: 'A mining drill on a shoulder mount, and a weapon by accident.'
    },
    makePowerClaw: {
      label: 'power claw', workAmount: 5000, skillRequirement: 10,
      ingredients: [{ thing: 'steel', count: 70 }, { thing: 'components', count: 12 }],
      products: { powerClaw: 1 }, researchPrerequisite: 'neuralImplants',
      description: 'A tonne of grip. Terrible at anything that is not violence.'
    },

    /* Butchery with a scalpel. The output is not knowable from the def -
       it depends on who died and how long ago - so it carries its own
       table the way butcherCorpse does.

       The work type is 'cook', not 'doctor', because workgivers.js scans
       bench bills in exactly two columns - cookBills for 'cook' and
       craftBills for 'craft' - and the butcher table is the cook one.
       A bill in any third column is a bill nobody is ever given. The
       skill stays 'medicine': who is allowed to take it and how fast
       they get through it are different questions. */
    harvestOrgansFromCorpse: {
      label: 'harvest organs', jobString: 'Harvesting organs', uiCategory: 'butchery',
      workAmount: 1600, skill: 'medicine', skillRequirement: 5, workType: 'cook',
      workbenches: ['butcherTable'],
      ingredients: [{ thing: 'corpse', count: 1 }],
      dynamicProducts: true,
      defaultRepeat: 'forever',
      description: 'Take what is still worth taking out of a body. A fresh corpse gives up ' +
        'organs worth real silver; one left in the sun gives up nothing.'
    }
  }, RECIPE_DEFAULTS);

  /* ---- thoughts ----
     The mood cost of the things this file lets a player do. Numbers are
     in RimWorld mood points, which needs.js normalises. */

  Defs.add('thought', {
    organHarvestedMe: {
      label: 'My organ was harvested', durationDays: 25, stackLimit: 3,
      stages: [{ label: 'They cut something out of me', mood: -35 }]
    },
    knowOrganHarvested: {
      label: 'Organ harvested', durationDays: 8, stackLimit: 4,
      stages: [{ label: 'We harvested a prisoner', mood: -14 }],
      nullifiedByTrait: ['psychopath', 'bloodlust']
    },
    prisonerKilledForOrgans: {
      label: 'Prisoner cut apart', durationDays: 14, stackLimit: 3,
      stages: [{ label: 'We killed a prisoner for parts', mood: -22 }],
      nullifiedByTrait: ['psychopath']
    },
    euthanised: {
      label: 'Mercy killing', durationDays: 10, stackLimit: 2,
      stages: [{ label: 'We put a colonist down', mood: -9 }],
      nullifiedByTrait: ['psychopath']
    },
    surgeryFailed: {
      label: 'Botched surgery', durationDays: 12, stackLimit: 2,
      stages: [{ label: 'A surgeon ruined someone', mood: -10 }],
      nullifiedByTrait: ['psychopath']
    },
    bodyPurityViolated: {
      label: 'Flesh replaced', durationDays: 30, stackLimit: 4,
      stages: [{ label: 'There is machinery in me', mood: -16 }]
    },
    newLimb: {
      label: 'Whole again', durationDays: 12, stackLimit: 1,
      stages: [{ label: 'I can use it again', mood: 8 }]
    }
  });

  /* ---- hediffs ----
     Registered into health.js's own table, because health.js already
     runs the severity-versus-immunity race and running a second copy of
     it here would give a pawn two diseases with one name. Anything with
     `immunizable` is a race; anything without is a condition that sits
     where it is or grinds slowly upward. */

  var DISEASES = {
    plague: {
      id: 'plague', label: 'plague', lethal: true, immunizable: true, tendable: true,
      severityPerDay: 0.33, immunityPerDay: 0.36, painOffset: 0.15, isDisease: true,
      capMods: { consciousness: -0.35, moving: -0.30, manipulation: -0.20 },
      deathCause: 'the plague'
    },
    malaria: {
      id: 'malaria', label: 'malaria', lethal: true, immunizable: true, tendable: true,
      severityPerDay: 0.24, immunityPerDay: 0.30, painOffset: 0.08, isDisease: true,
      capMods: { consciousness: -0.30, moving: -0.25, manipulation: -0.15 },
      deathCause: 'malaria'
    },
    sleepingSickness: {
      id: 'sleepingSickness', label: 'sleeping sickness', lethal: true, immunizable: true,
      tendable: true, severityPerDay: 0.16, immunityPerDay: 0.24, painOffset: 0.04,
      isDisease: true, capMods: { consciousness: -0.45, moving: -0.15 },
      deathCause: 'sleeping sickness'
    },
    gutWorms: {
      id: 'gutWorms', label: 'gut worms', lethal: false, immunizable: true, tendable: true,
      severityPerDay: 0.10, immunityPerDay: 0.13, painOffset: 0.18, isDisease: true,
      capMods: { consciousness: -0.10, eating: -0.25 }
    },
    muscleParasites: {
      id: 'muscleParasites', label: 'muscle parasites', lethal: false, immunizable: true,
      tendable: true, severityPerDay: 0.08, immunityPerDay: 0.11, painOffset: 0.12,
      isDisease: true, capMods: { moving: -0.35, manipulation: -0.30 }
    }
  };

  /* Chronic conditions. No immunity, no cure short of a scalpel: they
     are what makes a colonist's age mean something and what makes a
     late bionic worth two thousand silver. */
  var CHRONIC = {
    badBack: {
      id: 'badBack', label: 'bad back', lethal: false, painOffset: 0.18,
      capMods: { moving: -0.25, manipulation: -0.12 },
      chronic: true, minAge: 34, fixedBy: ['bionicSpine'], part: 'spine'
    },
    frailty: {
      id: 'frailty', label: 'frailty', lethal: false, painOffset: 0.05,
      capMods: { moving: -0.30, manipulation: -0.30 },
      chronic: true, minAge: 58
    },
    cataracts: {
      id: 'cataracts', label: 'cataracts', lethal: false, painOffset: 0,
      capMods: { sight: -0.45 },
      chronic: true, minAge: 46, fixedBy: ['bionicEye'], part: 'eyeLeft'
    },
    dementia: {
      id: 'dementia', label: 'dementia', lethal: false, painOffset: 0,
      capMods: { consciousness: -0.30, talking: -0.25 },
      chronic: true, minAge: 62
    },
    carcinoma: {
      id: 'carcinoma', label: 'carcinoma', lethal: true, painOffset: 0.20,
      severityPerDay: 0.014, capMods: { consciousness: -0.20, breathing: -0.20 },
      chronic: true, minAge: 40, deathCause: 'carcinoma', treatable: true
    },
    asthma: {
      id: 'asthma', label: 'asthma', lethal: false, painOffset: 0.02,
      capMods: { breathing: -0.30 },
      chronic: true, minAge: 26
    }
  };

  /* The painstopper's hediff. health.js multiplies every offset by
     severity, and Health.summary hijacks the whole health readout for
     any hediff at or above 0.15 - which is right for a disease and
     wrong for a permanent implant nobody needs told about twice. So it
     sits below that line and states its offsets pre-divided: 0.10 x
     -10.0 is a full point of pain removed, 0.10 x -1.0 is the tenth of
     consciousness it costs to stop feeling anything. */
  var PAINSTOPPER_SEVERITY = 0.10;
  var IMPLANT_HEDIFFS = {
    painstopper: {
      id: 'painstopper', label: 'painstopper', lethal: false, implant: true,
      painOffset: -10.0, capMods: { consciousness: -1.0 }
    }
  };

  (function registerHediffs() {
    var H = root.Health;
    if (!H || !H.HEDIFFS) return;
    var tables = [DISEASES, CHRONIC, IMPLANT_HEDIFFS];
    for (var t = 0; t < tables.length; t++) {
      var table = tables[t];
      Object.keys(table).forEach(function (id) {
        if (!H.HEDIFFS[id]) H.HEDIFFS[id] = table[id];
      });
    }
  })();

  /* ============================================================
     2. THE IMPLANT CATALOGUE

     `efficiency` is what the part is worth once the implant is in,
     against the flesh it replaced. Below 1 it is expressed as a
     permanent injury, which is health.js's own way of saying "this
     part is at 55%". At 1 the part is simply whole again.

     `bonus` is the part that cannot be said in capacities at all,
     because health.js clamps every one of them to 1. Those numbers are
     multiplicative deltas applied where the capacity is finally read -
     see INSTALL - so two bionic legs are a 25% faster colonist.
     ============================================================ */

  var IMPLANTS = {
    pegLeg: { parts: ['legLeft', 'legRight'], efficiency: 0.55, tier: 'crude' },
    hookHand: { parts: ['handLeft', 'handRight'], efficiency: 0.50, tier: 'crude' },

    prostheticArm: { parts: ['armLeft', 'armRight'], efficiency: 1.00, tier: 'simple' },
    prostheticLeg: { parts: ['legLeft', 'legRight'], efficiency: 1.00, tier: 'simple' },

    bionicArm: {
      parts: ['armLeft', 'armRight'], efficiency: 1.00, tier: 'bionic',
      bonus: { work: 0.10 }
    },
    bionicLeg: {
      parts: ['legLeft', 'legRight'], efficiency: 1.00, tier: 'bionic',
      bonus: { move: 0.125 }
    },
    bionicEye: {
      parts: ['eyeLeft', 'eyeRight'], efficiency: 1.00, tier: 'bionic',
      bonus: { aim: 0.10 }
    },
    bionicHeart: {
      parts: ['heart'], efficiency: 1.00, tier: 'bionic',
      bonus: { move: 0.06, work: 0.06 }
    },
    bionicSpine: {
      parts: ['spine'], efficiency: 1.00, tier: 'bionic',
      bonus: { move: 0.08, work: 0.08 }
    },
    cochlearImplant: { parts: ['earLeft', 'earRight'], efficiency: 1.00, tier: 'bionic' },

    /* A drill is a tool that happens to be a weapon; a claw is a weapon
       that happens to be attached to a hand, and it is hopeless at the
       hand's day job. */
    drillArm: {
      parts: ['armLeft', 'armRight'], efficiency: 1.00, tier: 'weapon',
      bonus: { work: 0.04 }, melee: { damage: 20, type: 'stab', label: 'drill arm' }
    },
    powerClaw: {
      parts: ['handLeft', 'handRight'], efficiency: 1.00, tier: 'weapon',
      bonus: { work: -0.12 }, melee: { damage: 22, type: 'cut', label: 'power claw' }
    },

    /* Seated on the brain, replacing nothing. */
    painstopper: {
      parts: ['brain'], efficiency: 1.00, tier: 'neural',
      additive: true, hediff: 'painstopper'
    },

    organKidney: { parts: ['kidneyLeft', 'kidneyRight'], efficiency: 1.00, tier: 'organ', organ: true },
    organLung: { parts: ['lungLeft', 'lungRight'], efficiency: 1.00, tier: 'organ', organ: true },
    organLiver: { parts: ['liver'], efficiency: 1.00, tier: 'organ', organ: true },
    organHeart: { parts: ['heart'], efficiency: 1.00, tier: 'organ', organ: true },
    organEye: { parts: ['eyeLeft', 'eyeRight'], efficiency: 1.00, tier: 'organ', organ: true }
  };

  /* Which part yields which item when it comes out. */
  var ORGAN_OF_PART = {
    kidneyLeft: 'organKidney', kidneyRight: 'organKidney',
    lungLeft: 'organLung', lungRight: 'organLung',
    liver: 'organLiver', heart: 'organHeart',
    eyeLeft: 'organEye', eyeRight: 'organEye'
  };

  /* How hard each tier is to seat, on top of the operation's own
     difficulty. A peg leg is carpentry; a bionic spine is not. */
  var TIER_DIFFICULTY = {
    crude: 0.00, simple: 0.08, organ: 0.14, bionic: 0.20, weapon: 0.20, neural: 0.28
  };

  Medicine.IMPLANTS = IMPLANTS;
  Medicine.DISEASES = DISEASES;
  Medicine.CHRONIC = CHRONIC;

  Medicine.implantDef = function (defId) { return IMPLANTS[defId] || null; };
  Medicine.isImplantItem = function (defId) { return !!IMPLANTS[defId]; };
  Medicine.organForPart = function (partName) { return ORGAN_OF_PART[partName] || null; };

  /* ============================================================
     3. THE OPERATION CATALOGUE
     ============================================================ */

  var OPS = {
    install: {
      label: 'install', work: 2400, difficulty: 0.05, medicine: 2,
      verb: 'installing', needsItem: true
    },
    removeImplant: {
      label: 'remove implant', work: 2000, difficulty: 0.18, medicine: 1,
      verb: 'removing an implant'
    },
    amputate: {
      label: 'amputate', work: 1700, difficulty: 0.06, medicine: 1,
      verb: 'amputating'
    },
    removePart: {
      label: 'remove body part', work: 2000, difficulty: 0.16, medicine: 1,
      verb: 'removing a body part'
    },
    harvest: {
      label: 'harvest organ', work: 2300, difficulty: 0.16, medicine: 2,
      verb: 'harvesting an organ'
    },
    euthanize: {
      label: 'euthanise', work: 800, difficulty: -1, medicine: 0,
      verb: 'euthanising'
    },
    treatDisease: {
      label: 'treat disease', work: 1500, difficulty: 0.04, medicine: 2,
      verb: 'treating'
    }
  };

  Medicine.OPS = OPS;

  /* ============================================================
     4. PER-PAWN STATE

     A plain field of plain data, so save.js carries it without knowing
     this file exists. Nothing in here is ever a live reference: parts
     are named, things are ids.
     ============================================================ */

  function med(pawn) {
    if (!pawn) return null;
    var m = pawn.med;
    if (!m) {
      m = pawn.med = {
        ops: [],
        implants: [],
        nextDiseaseDay: 0,
        lastChronicTick: 0,
        surgeries: 0,
        botched: 0
      };
    }
    if (!m.ops) m.ops = [];
    if (!m.implants) m.implants = [];
    /* A save written before the bonus cache moved off the pawn carries
       two derived fields that mean nothing now. Drop them on sight so
       they are not copied into the next save as well. */
    if (m._fx !== undefined) { delete m._fx; delete m._fxStamp; delete m._stamp; }
    return m;
  }
  Medicine.state = med;

  /* Bonuses are asked for on every step a pawn takes, so the sum is
     cached - but off the pawn, because save.js copies every own field
     of pawn.med into the file and a derived total has no business
     being in a save. A WeakMap holds it for as long as the pawn is
     alive and not one tick longer, and a pawn rebuilt by a load simply
     has no entry yet. */
  var _fxCache = new WeakMap();

  function bonuses(pawn) {
    var m = pawn && pawn.med;
    if (!m) return null;
    var hit = _fxCache.get(pawn);
    if (hit && hit.n === m.implants.length) return hit.fx;
    var fx = { move: 1, work: 1, aim: 1, melee: null };
    for (var i = 0; i < m.implants.length; i++) {
      var rec = m.implants[i];
      var def = IMPLANTS[rec.defId];
      if (!def) continue;
      if (def.bonus) {
        if (def.bonus.move) fx.move += def.bonus.move;
        if (def.bonus.work) fx.work += def.bonus.work;
        if (def.bonus.aim) fx.aim += def.bonus.aim;
      }
      if (def.melee && (!fx.melee || def.melee.damage > fx.melee.damage)) fx.melee = def.melee;
    }
    if (fx.move < 0.2) fx.move = 0.2;
    if (fx.work < 0.2) fx.work = 0.2;
    _fxCache.set(pawn, { n: m.implants.length, fx: fx });
    return fx;
  }

  function invalidateBonuses(pawn) {
    if (pawn) _fxCache.delete(pawn);
  }

  Medicine.moveFactor = function (pawn) {
    var fx = bonuses(pawn);
    return fx ? fx.move : 1;
  };
  Medicine.workFactor = function (pawn) {
    var fx = bonuses(pawn);
    return fx ? fx.work : 1;
  };
  Medicine.aimFactor = function (pawn) {
    var fx = bonuses(pawn);
    return fx ? fx.aim : 1;
  };
  Medicine.unarmedProfile = function (pawn) {
    var fx = bonuses(pawn);
    return (fx && fx.melee) ? fx.melee : null;
  };

  Medicine.implantsOf = function (pawn) {
    var m = pawn && pawn.med;
    if (!m) return [];
    var out = [];
    for (var i = 0; i < m.implants.length; i++) {
      var rec = m.implants[i];
      var def = Defs.maybe('thing', rec.defId);
      out.push({
        part: rec.part,
        partLabel: partLabel(pawn, rec.part),
        defId: rec.defId,
        label: def ? def.label : rec.defId,
        tier: (IMPLANTS[rec.defId] || {}).tier || 'simple',
        efficiency: (IMPLANTS[rec.defId] || {}).efficiency || 1,
        tick: rec.tick
      });
    }
    return out;
  };

  Medicine.implantAt = function (pawn, partName) {
    var m = pawn && pawn.med;
    if (!m) return null;
    for (var i = 0; i < m.implants.length; i++) {
      if (m.implants[i].part === partName) return m.implants[i];
    }
    return null;
  };

  function partLabel(pawn, partName) {
    var H = sys('Health');
    var part = (H && H.partNamed) ? H.partNamed(pawn, partName) : null;
    return part ? part.label : partName;
  }

  /* ============================================================
     5. BEDS AND THE HOSPITAL

     regions.js already works out how clean a room is and power.js
     already knows how well lit it is. A medical bed is a flag on a bed
     the player sets; a hospital is a medical bed standing in a room
     those two systems approve of. The number this returns is what
     makes the difference between a surgeon who saves a colonist and a
     surgeon who kills one in a muddy shed.
     ============================================================ */

  Medicine.setBedMedical = function (bed, on) {
    if (!isBed(bed)) return false;
    bed.medical = !!on;
    return true;
  };
  Medicine.isMedicalBed = function (bed) { return !!(isBed(bed) && bed.medical); };

  function isBed(thing) {
    return !!(thing && thing.def && thing.def.building && thing.def.building.isBed);
  }

  function bedUnder(pawn) {
    var map = pawn && pawn.map;
    if (!map || !map.buildingAt) return null;
    var b = map.buildingAt(pawn.x, pawn.y);
    return isBed(b) ? b : null;
  }
  Medicine.bedOf = bedUnder;

  /* 0 for a floor in the rain, 1 for a clean, lit, roofed room with a
     medical bed in it. Everything in this file that can be made better
     by a hospital reads this one number. */
  Medicine.hospitalQuality = function (pawn) {
    var map = pawn && pawn.map;
    if (!map) return 0;
    var q = 0;
    var bed = bedUnder(pawn);
    if (bed) q += Medicine.isMedicalBed(bed) ? 0.42 : 0.20;

    var R = sys('Regions');
    var room = (R && R.roomAt) ? R.roomAt(map, pawn.x, pawn.y) : null;
    if (room) {
      if (!room.outdoor) q += 0.12;
      if (room.roofed) q += 0.06;
      /* Room cleanliness runs roughly -2 (a floor of blood) to +2 (a
         sterile floor); only the clean half buys anything. */
      q += U.clamp(room.cleanliness, -1.5, 1.5) * 0.16;
    }

    var P = sys('Power');
    if (P && P.lightAt) q += U.clamp01(P.lightAt(map, pawn.x, pawn.y)) * 0.12;
    else q += 0.06;

    return U.clamp01(q);
  };

  /* ============================================================
     6. QUEUEING OPERATIONS
     ============================================================ */

  function researchDone(id) {
    if (!id) return true;
    var R = sys('Research');
    return (R && R.isDone) ? !!R.isDone(id) : true;
  }

  function implantUnlocked(defId) {
    var def = Defs.maybe('thing', defId);
    return researchDone(def && def.researchPrerequisite);
  }

  /* One free implant item of this kind lying anywhere the colony can
     reach. Reserved at the moment a surgeon takes the job, not here. */
  function findImplantItem(map, defId, pawn) {
    if (!map || !map.byDef) return null;
    var Res = sys('Res');
    var Path = sys('Path');
    var T = sys('T');
    var list = map.byDef(defId) || [];
    var best = null, bestD = Infinity;
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      if (!t.spawned) continue;
      if (pawn && Res && T && !Res.canReserve(pawn, T.thing(t), 1)) continue;
      if (pawn && Path && Path.reachable &&
          !Path.reachable(map, pawn.x, pawn.y, t.x, t.y, { pawn: pawn })) continue;
      var d = pawn ? U.distSq(pawn.x, pawn.y, t.x, t.y) : 0;
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  }
  Medicine.findImplantItem = findImplantItem;

  function opLabel(op, pawn) {
    var spec = OPS[op.kind];
    var verb = spec ? spec.label : op.kind;
    if (op.kind === 'install') {
      var d = Defs.maybe('thing', op.defId);
      return 'install ' + (d ? d.label : op.defId) + ' (' + partLabel(pawn, op.part) + ')';
    }
    if (op.kind === 'treatDisease') {
      var hd = (sys('Health') && sys('Health').HEDIFFS[op.hediffId]) || null;
      return 'treat ' + (hd ? hd.label : op.hediffId);
    }
    if (op.kind === 'euthanize') return 'euthanise';
    return verb + ' ' + partLabel(pawn, op.part);
  }

  /* What the player may put on this pawn's list right now. The health
     tab renders these straight. */
  Medicine.availableOperations = function (pawn) {
    var out = [];
    var H = sys('Health');
    if (!pawn || !H || !isFlesh(pawn) || pawn.dead) return out;
    var h = pawn.health;
    if (!h || !h.parts) return out;
    var map = pawn.map;
    var i, part;

    /* Installs: one row per implant kind the colony has researched, for
       every part it fits. */
    Object.keys(IMPLANTS).forEach(function (defId) {
      var spec = IMPLANTS[defId];
      if (!implantUnlocked(defId)) return;
      /* Whether the colony owns one of these is a question about the
         map, not about the part, so it is asked once per implant
         rather than once per socket: byDef is a scan, and the health
         tab asks this for every implant in the catalogue. */
      var have = map ? findImplantItem(map, defId, null) : null;
      for (var p = 0; p < spec.parts.length; p++) {
        var target = H.partNamed(pawn, spec.parts[p]);
        if (!target) continue;
        if (Medicine.implantAt(pawn, target.defName)) continue;
        /* A second kidney is not a treatment. An organ only goes in
           where one came out. */
        if (spec.organ && !target.missing) continue;
        if (spec.additive && Medicine.implantAt(pawn, target.defName)) continue;
        out.push({
          kind: 'install', part: target.defName, defId: defId,
          label: 'install ' + Defs.thing(defId).label + ' (' + target.label + ')',
          available: !!have,
          reason: have ? null : 'no ' + Defs.thing(defId).label + ' in the colony'
        });
      }
    });

    /* Removals, amputations, harvests. */
    for (i = 0; i < h.parts.length; i++) {
      part = h.parts[i];
      if (part.missing) continue;
      if (Medicine.implantAt(pawn, part.defName)) {
        out.push({
          kind: 'removeImplant', part: part.defName,
          label: 'remove implant (' + part.label + ')', available: true, reason: null
        });
        continue;
      }
      if (part.limb && part.depth === 'outside' && part.defName !== 'nose' && part.defName !== 'jaw') {
        out.push({
          kind: 'amputate', part: part.defName,
          label: 'amputate ' + part.label, available: true, reason: null
        });
      }
      if (ORGAN_OF_PART[part.defName]) {
        out.push({
          kind: 'harvest', part: part.defName,
          label: 'harvest ' + part.label, available: true,
          fatal: !!part.vital,
          reason: null
        });
      } else if (part.depth === 'inside' && !part.vital && part.defName !== 'skull' &&
                 part.defName !== 'ribcage') {
        out.push({
          kind: 'removePart', part: part.defName,
          label: 'remove ' + part.label, available: true, reason: null
        });
      }
    }

    /* Diseases a scalpel and two doses can actually push back. */
    for (i = 0; i < h.hediffs.length; i++) {
      var hd = h.hediffs[i];
      var hdef = hd.def || {};
      if (!hdef.immunizable && !hdef.treatable) continue;
      out.push({
        kind: 'treatDisease', hediffId: hd.id,
        label: 'treat ' + (hdef.label || hd.id), available: true, reason: null
      });
    }

    out.push({ kind: 'euthanize', label: 'euthanise', available: true, reason: null });
    return out;
  };

  Medicine.operations = function (pawn) {
    var m = pawn && pawn.med;
    if (!m) return [];
    var out = [];
    for (var i = 0; i < m.ops.length; i++) {
      var op = m.ops[i];
      out.push({
        id: op.id, kind: op.kind, part: op.part, defId: op.defId, hediffId: op.hediffId,
        label: opLabel(op, pawn), queuedTick: op.queuedTick,
        odds: Medicine.oddsPreview(pawn, op)
      });
    }
    return out;
  };

  Medicine.queueOperation = function (pawn, spec) {
    install();
    if (!pawn || !spec || !spec.kind || !OPS[spec.kind]) return null;
    if (pawn.dead || !pawn.health) return null;
    var m = med(pawn);
    var H = sys('Health');

    /* A named part has to be a part this body actually has, or the
       surgeon walks over and finds nothing to cut. */
    if (spec.kind !== 'euthanize' && spec.kind !== 'treatDisease') {
      if (!spec.part || !H || !H.partNamed(pawn, spec.part)) return null;
    }
    if (spec.kind === 'install') {
      var impl = IMPLANTS[spec.defId];
      if (!impl || impl.parts.indexOf(spec.part) < 0) return null;
      if (!implantUnlocked(spec.defId)) return null;
    }
    if (spec.kind === 'treatDisease') {
      if (!spec.hediffId || !H || !H.hediff(pawn, spec.hediffId)) return null;
    }

    /* The same operation twice is a player misclick, not a plan. */
    for (var i = 0; i < m.ops.length; i++) {
      var o = m.ops[i];
      if (o.kind === spec.kind && o.part === spec.part &&
          o.defId === spec.defId && o.hediffId === spec.hediffId) return o;
    }

    var op = {
      id: U.nextId(),
      kind: spec.kind,
      part: spec.part || null,
      defId: spec.defId || null,
      hediffId: spec.hediffId || null,
      queuedTick: now()
    };
    m.ops.push(op);
    return op;
  };

  Medicine.cancelOperation = function (pawn, opId) {
    var m = pawn && pawn.med;
    if (!m) return false;
    for (var i = 0; i < m.ops.length; i++) {
      if (m.ops[i].id === opId || m.ops[i] === opId) {
        m.ops.splice(i, 1);
        return true;
      }
    }
    return false;
  };

  Medicine.pendingOperation = function (pawn) {
    var m = pawn && pawn.med;
    return (m && m.ops.length) ? m.ops[0] : null;
  };

  Medicine.hasPendingOperation = function (pawn) {
    var m = pawn && pawn.med;
    return !!(m && m.ops.length);
  };

  /* ============================================================
     7. CAN THIS SURGEON DO THIS

     Every reason a surgery is refused is a sentence, because a refusal
     the player cannot read is a colonist standing still for no reason.
     ============================================================ */

  var SKILL_FOR_TIER = { crude: 3, simple: 5, organ: 6, bionic: 8, weapon: 8, neural: 10 };

  function requiredSkill(op) {
    if (op.kind === 'euthanize') return 0;
    if (op.kind === 'install') {
      var spec = IMPLANTS[op.defId];
      return spec ? (SKILL_FOR_TIER[spec.tier] || 5) : 5;
    }
    if (op.kind === 'harvest') return 5;
    if (op.kind === 'removeImplant') return 4;
    if (op.kind === 'treatDisease') return 4;
    return 3;
  }
  Medicine.requiredSkill = requiredSkill;

  function medicineNeeded(op) {
    var spec = OPS[op.kind];
    return spec ? spec.medicine : 1;
  }

  Medicine.canPerform = function (surgeon, patient, op) {
    if (!surgeon || !patient || !op) return { ok: false, reason: 'nothing to do' };
    if (surgeon.dead || surgeon.downed) return { ok: false, reason: 'the surgeon is in no state' };
    if (patient.dead) return { ok: false, reason: 'the patient is dead' };
    if (surgeon === patient) return { ok: false, reason: 'nobody operates on themselves' };
    if (!isHuman(surgeon)) return { ok: false, reason: 'animals do not perform surgery' };
    if (!isFlesh(patient)) return { ok: false, reason: 'there is nothing in there a scalpel understands' };

    var need = requiredSkill(op);
    if (skillLevel(surgeon, 'medicine') < need) {
      return { ok: false, reason: 'needs medicine skill ' + need };
    }
    var H = sys('Health');
    if (H && H.capacity) {
      if (H.capacity(surgeon, 'manipulation') < 0.35) return { ok: false, reason: 'the surgeon cannot hold a scalpel' };
      if (H.capacity(surgeon, 'sight') < 0.35) return { ok: false, reason: 'the surgeon cannot see well enough' };
    }

    /* The patient has to be lying still. A colonist can be told to go to
       bed; a prisoner cannot be told anything, and one who is downed is
       already as still as they are going to get. */
    if (!bedUnder(patient) && !patient.downed && !patient.prisoner) {
      return { ok: false, reason: 'the patient is not in a bed' };
    }

    if (op.kind === 'install') {
      var spec = IMPLANTS[op.defId];
      if (!spec) return { ok: false, reason: 'no such implant' };
      if (!implantUnlocked(op.defId)) return { ok: false, reason: 'not researched' };
      var item = findImplantItem(patient.map, op.defId, surgeon);
      if (!item) return { ok: false, reason: 'no ' + Defs.thing(op.defId).label + ' available' };
    }
    if (op.kind === 'harvest' && !ORGAN_OF_PART[op.part]) {
      return { ok: false, reason: 'that is not an organ' };
    }
    if (op.kind === 'removeImplant' && !Medicine.implantAt(patient, op.part)) {
      return { ok: false, reason: 'nothing there to remove' };
    }
    if (op.kind === 'treatDisease' && (!H || !H.hediff(patient, op.hediffId))) {
      return { ok: false, reason: 'already over' };
    }

    var doses = medicineNeeded(op);
    if (doses > 0 && !bestMedicine(patient.map, surgeon)) {
      return { ok: false, reason: 'no medicine in the colony' };
    }
    return { ok: true, reason: null };
  };

  /* ============================================================
     8. THE ODDS

     Skill, medicine, the room, the bed and the patient's own state. A
     surgeon at skill 20 with real medicine in a clean infirmary hardly
     ever slips; the same surgeon on a mud floor with herbal in the
     dark kills people, and both of those are the player's doing.
     ============================================================ */

  var MEDICINE_POTENCY = { medicine: 1.0, herbalMedicine: 0.72 };

  function potencyOf(thing) {
    if (!thing) return 0.45;
    var def = thing.def || Defs.maybe('thing', thing.defId) || {};
    if (typeof def.medicinePotency === 'number' && def.medicinePotency > 0) return def.medicinePotency;
    return MEDICINE_POTENCY[def.id] !== undefined ? MEDICINE_POTENCY[def.id] : 0.6;
  }

  function opDifficulty(op) {
    var base = (OPS[op.kind] || {}).difficulty || 0;
    if (op.kind === 'install') {
      var spec = IMPLANTS[op.defId];
      base += spec ? (TIER_DIFFICULTY[spec.tier] || 0.1) : 0.1;
    }
    return base;
  }

  Medicine.successChance = function (surgeon, patient, op, medicine) {
    if (!op) return 0;
    if (op.kind === 'euthanize') return 1;

    var skill = skillLevel(surgeon, 'medicine');
    var base = 0.42 + 0.052 * skill;                  /* 0.42 at 0, 1.46 at 20 */
    base *= 0.55 + 0.45 * potencyOf(medicine);        /* herbal is a real handicap */
    base *= 0.72 + 0.38 * Medicine.hospitalQuality(patient);

    var H = sys('Health');
    if (H && H.capacity) {
      /* Operating on somebody who is already half gone is worse odds,
         which is exactly when a player is most tempted to try. */
      var consc = H.capacity(patient, 'consciousness');
      base *= 0.80 + 0.20 * U.clamp01(consc);
      base *= 1 - U.clamp01((patient.health && patient.health.bloodLoss) || 0) * 0.25;
      base *= 0.85 + 0.15 * U.clamp01(H.capacity(surgeon, 'manipulation'));
    }

    base -= opDifficulty(op);
    return U.clamp(base, 0.02, 0.98);
  };

  /* What the health tab shows next to a queued operation, using the
     best doctor and the best medicine the colony currently has. */
  Medicine.oddsPreview = function (patient, op) {
    var map = patient && patient.map;
    if (!map || !map.colonists) return null;
    var best = bestSurgeonFor(patient, op);
    if (!best) return null;
    return Medicine.successChance(best, patient, op, bestMedicine(map, best));
  };

  function bestSurgeonFor(patient, op) {
    var map = patient && patient.map;
    if (!map || !map.colonists) return null;
    var list = map.colonists(), best = null, bestLv = -1;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p === patient || p.dead || p.downed) continue;
      if (typeof p.priorityOf === 'function' && p.priorityOf('doctor') <= 0) continue;
      var lv = skillLevel(p, 'medicine');
      if (lv > bestLv) { bestLv = lv; best = p; }
    }
    return best;
  }
  Medicine.bestSurgeonFor = bestSurgeonFor;

  function bestMedicine(map, pawn) {
    if (!map || !map.byDef) return null;
    var Res = sys('Res'), T = sys('T'), Path = sys('Path');
    var ids = ['medicine', 'herbalMedicine'];
    for (var k = 0; k < ids.length; k++) {
      var list = map.byDef(ids[k]) || [];
      var best = null, bestD = Infinity;
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!t.spawned || t.stack <= 0) continue;
        if (pawn && Res && T && !Res.canReserve(pawn, T.thing(t), 1)) continue;
        if (pawn && Path && Path.reachable &&
            !Path.reachable(map, pawn.x, pawn.y, t.x, t.y, { pawn: pawn })) continue;
        var d = pawn ? U.distSq(pawn.x, pawn.y, t.x, t.y) : 0;
        if (d < bestD) { bestD = d; best = t; }
      }
      if (best) return best;
    }
    return null;
  }
  Medicine.bestMedicine = bestMedicine;

  /* ============================================================
     9. PERFORMING IT

     Every body change below goes through health.js: Health.damage to
     take a part off, and health.js's own missing-part bookkeeping to
     put one back. This file never writes part.hp by hand.
     ============================================================ */

  function removePartSurgically(patient, part, cleanliness) {
    var H = sys('Health');
    if (!H || !part || part.missing) return false;
    var before = patient.health.injuries.length;
    /* A scalpel is a cut. health.js takes it from there: the part goes,
       everything hanging off it goes, and a stump bleeds. */
    H.damage(patient, {
      amount: part.hp + Math.max(4, Math.round(part.maxHp * 0.25)),
      type: 'cut', partId: part.id, source: 'surgery', armorPen: 99
    });
    /* A surgical cut is a controlled one: the stump bleed a wound would
       leave is mostly tied off before the patient comes round. */
    var list = patient.health.injuries;
    for (var i = before; i < list.length; i++) {
      if (list[i].bleedRate > 0) list[i].bleedRate *= U.clamp(0.35 - cleanliness * 0.25, 0.05, 0.35);
    }
    return true;
  }

  /* Put a part and everything it carries back into service. This is the
     one place that writes `missing` directly, and it writes it the way
     health.js's own destroyPart wrote it: by clearing the records that
     said the part was gone. */
  function restorePart(patient, part) {
    var h = patient.health;
    var chain = [part].concat(descendantsOf(h, part));
    var ids = {};
    for (var i = 0; i < chain.length; i++) ids[chain[i].id] = true;
    h.injuries = h.injuries.filter(function (inj) { return !ids[inj.partId]; });
    for (i = 0; i < chain.length; i++) {
      chain[i].missing = false;
      chain[i].hp = chain[i].maxHp;
    }
    var H = sys('Health');
    if (H && H.invalidate) H.invalidate(patient);
    return chain;
  }

  function descendantsOf(h, part) {
    var out = [], stack = [part.id], seen = {};
    while (stack.length) {
      var id = stack.pop();
      for (var i = 0; i < h.parts.length; i++) {
        var p = h.parts[i];
        if (p.parent !== id || seen[p.id]) continue;
        seen[p.id] = true;
        out.push(p);
        stack.push(p.id);
      }
    }
    return out;
  }

  /* An implant worse than flesh is a part that never fully heals, which
     is a permanent injury - health.js's own word for it - so a peg leg
     slows a colonist down through the same arithmetic a mauled leg
     does, and nothing had to be added to health.js to say it. */
  function applyEfficiency(patient, part, defId, efficiency) {
    if (efficiency >= 1) return;
    var shortfall = Math.max(1, Math.round(part.maxHp * (1 - efficiency)));
    var thing = Defs.maybe('thing', defId);
    patient.health.injuries.push({
      id: U.nextId(), partId: part.id,
      label: thing ? thing.label : 'prosthetic',
      amount: shortfall, bleedRate: 0, tended: true, tendQuality: 1, infection: 0,
      permanent: true, ageTicks: 0, painFactor: 0.05, severeAt: shortfall,
      implantDefId: defId
    });
    part.hp = U.clamp(part.maxHp - shortfall, 0, part.maxHp);
  }

  function installImplant(patient, part, defId) {
    var spec = IMPLANTS[defId];
    if (!spec) return false;
    var H = sys('Health');
    var m = med(patient);

    if (!spec.additive) {
      restorePart(patient, part);
      applyEfficiency(patient, part, defId, spec.efficiency);
    }
    if (spec.hediff && H && H.addHediff) {
      var hd = H.addHediff(patient, spec.hediff, PAINSTOPPER_SEVERITY);
      if (hd) hd.severity = PAINSTOPPER_SEVERITY;
    }

    m.implants.push({ part: part.defName, defId: defId, tick: now() });
    invalidateBonuses(patient);
    if (H && H.invalidate) H.invalidate(patient);

    /* A bionic spine is the answer to a bad back, and a bionic eye is
       the answer to cataracts. Letting the condition sit on a part that
       is no longer flesh would be a bug the player could see. */
    Object.keys(CHRONIC).forEach(function (id) {
      var c = CHRONIC[id];
      if (!c.fixedBy || c.fixedBy.indexOf(defId) < 0) return;
      if (H && H.removeHediff) H.removeHediff(patient, id);
    });
    return true;
  }

  function uninstallImplant(patient, partName, intact) {
    var m = med(patient);
    var rec = null, idx = -1;
    for (var i = 0; i < m.implants.length; i++) {
      if (m.implants[i].part === partName) { rec = m.implants[i]; idx = i; break; }
    }
    if (!rec) return null;
    m.implants.splice(idx, 1);
    invalidateBonuses(patient);

    var H = sys('Health');
    var spec = IMPLANTS[rec.defId] || {};
    if (spec.hediff && H && H.removeHediff) H.removeHediff(patient, rec.hediff || spec.hediff);

    var part = H && H.partNamed ? H.partNamed(patient, partName) : null;
    if (part && !spec.additive) {
      /* Taking a limb out leaves what taking a limb out leaves. */
      patient.health.injuries = patient.health.injuries.filter(function (inj) {
        return inj.implantDefId !== rec.defId || inj.partId !== part.id;
      });
      removePartSurgically(patient, part, 0.5);
    }
    if (H && H.invalidate) H.invalidate(patient);

    if (intact && patient.map && patient.map.addItem) {
      patient.map.addItem(rec.defId, patient.x, patient.y, 1);
    }
    return rec;
  }

  /* ---- the outcome roll ---- */

  function failureOutcome(margin) {
    /* How badly the roll missed decides what went wrong. A near miss
       wastes the medicine; a disaster opens the patient up. */
    if (margin < 0.18) return 'wasted';
    if (margin < 0.55) return 'ruined';
    return 'catastrophe';
  }

  Medicine.perform = function (surgeon, patient, op, medicine) {
    install();
    if (!surgeon || !patient || !op) return { ok: false, outcome: 'invalid' };
    var H = sys('Health');
    if (!H) return { ok: false, outcome: 'invalid' };
    var m = med(patient);

    /* The queue entry goes whatever happens: a botched operation is a
       finished operation, and a player who wants it tried again says
       so themselves. */
    Medicine.cancelOperation(patient, op.id);

    if (op.kind === 'euthanize') return euthanise(surgeon, patient);

    var chance = Medicine.successChance(surgeon, patient, op, medicine);
    var roll = U.rand();
    var ok = roll < chance;
    m.surgeries++;
    _stats.surgeries++;

    /* pawn.js hangs learn off the prototype, so a pawn rebuilt as plain
       data by a loader that skipped the prototype still gets its xp. */
    if (typeof surgeon.learn === 'function') surgeon.learn('medicine', 240);
    else {
      var P = sys('Pawn');
      var learn = P && P.prototype && P.prototype.learn;
      if (typeof learn === 'function') learn.call(surgeon, 'medicine', 240);
    }

    if (ok) return succeed(surgeon, patient, op);

    m.botched++;
    _stats.botched++;
    return botch(surgeon, patient, op, failureOutcome((roll - chance) / Math.max(0.05, 1 - chance)));
  };

  function succeed(surgeon, patient, op) {
    var H = sys('Health');
    var part = op.part ? H.partNamed(patient, op.part) : null;
    var text = null;

    switch (op.kind) {
      case 'install':
        if (!part) return { ok: false, outcome: 'invalid' };
        installImplant(patient, part, op.defId);
        noteImplantFitted(surgeon, patient, op.defId);
        text = nameOf(surgeon) + ' fitted a ' + Defs.thing(op.defId).label + ' to ' +
               nameOf(patient) + '.';
        msg(text, 'good', patient);
        break;

      case 'removeImplant':
        uninstallImplant(patient, op.part, true);
        text = nameOf(surgeon) + ' removed an implant from ' + nameOf(patient) + '.';
        msg(text, 'info', patient);
        break;

      case 'amputate':
      case 'removePart':
        if (!part) return { ok: false, outcome: 'invalid' };
        removePartSurgically(patient, part, Medicine.hospitalQuality(patient));
        text = nameOf(surgeon) + ' removed ' + nameOf(patient) + "'s " + part.label + '.';
        msg(text, 'info', patient);
        break;

      case 'harvest':
        if (!part) return { ok: false, outcome: 'invalid' };
        return harvestOrgan(surgeon, patient, part);

      case 'treatDisease':
        return treatDisease(surgeon, patient, op);
    }

    if (patient.faction === 'player' && !patient.prisoner && op.kind === 'install') {
      think(patient, 'newLimb');
      if (hasTrait(patient, 'bodyPurist')) think(patient, 'bodyPurityViolated');
    }
    return { ok: true, outcome: 'success', text: text };
  }

  function botch(surgeon, patient, op, outcome) {
    var H = sys('Health');
    var part = op.part ? H.partNamed(patient, op.part) : null;
    var who = nameOf(patient), doc = nameOf(surgeon);

    if (outcome === 'wasted') {
      msg(doc + ' botched the operation on ' + who + '. The medicine is gone.', 'threat', patient);
      return { ok: false, outcome: 'wasted', text: 'wasted' };
    }

    /* An implant the surgeon dropped on the floor is an implant the
       colony has to build again, which is the real cost of a bad
       doctor on an expensive part. */
    if (op.kind === 'install') {
      var ruined = Defs.maybe('thing', op.defId);
      msg(doc + ' ruined the ' + (ruined ? ruined.label : 'implant') + ' fitting it to ' + who + '.',
          'threat', patient);
    }

    if (outcome === 'ruined') {
      if (part) {
        H.damage(patient, {
          amount: Math.max(5, Math.round(part.maxHp * U.randRange(0.45, 0.9))),
          type: 'cut', partId: part.id, source: 'botched surgery', instigator: surgeon, armorPen: 99
        });
      } else {
        H.damage(patient, {
          amount: U.randInt(8, 18), type: 'cut', source: 'botched surgery',
          instigator: surgeon, armorPen: 99
        });
      }
      surgeryFallout(surgeon, patient);
      return { ok: false, outcome: 'ruined', text: doc + ' ruined the operation on ' + who + '.' };
    }

    /* Catastrophe: the surgeon went somewhere they should not have.
       health.js decides whether that kills, which is how a nicked
       kidney and a severed aorta come out different. */
    var torso = H.partNamed(patient, 'torso');
    H.damage(patient, {
      amount: U.randInt(22, 46), type: 'stab',
      partId: part ? part.id : (torso ? torso.id : null),
      source: 'botched surgery', instigator: surgeon, armorPen: 99
    });
    if (!patient.dead) {
      H.damage(patient, {
        amount: U.randInt(10, 26), type: 'cut', source: 'botched surgery',
        instigator: surgeon, armorPen: 99
      });
    }
    surgeryFallout(surgeon, patient);
    if (patient.dead) {
      letter('Surgery killed them',
        doc + ' opened ' + who + ' up and could not close them again. ' + who + ' died on the bed.',
        'death', patient);
      return { ok: false, outcome: 'fatal', text: 'the patient died' };
    }
    letter('Surgery went badly',
      doc + ' made a mess of ' + who + '. They are alive, and that is the whole of the good news.',
      'threat', patient);
    return { ok: false, outcome: 'catastrophe', text: 'catastrophe' };
  }

  function surgeryFallout(surgeon, patient) {
    var map = patient.map;
    if (!map || !map.colonists || patient.faction !== 'player' || patient.prisoner) return;
    var list = map.colonists();
    for (var i = 0; i < list.length; i++) {
      if (list[i] === patient) continue;
      think(list[i], 'surgeryFailed');
    }
  }

  function noteImplantFitted(surgeon, patient, defId) {
    var I = sys('Ideology');
    if (!I) return;
    /* Ideology already has an opinion about machinery under the skin -
       a transhumanist colony loves it and a body purist ideoligion is
       revolted - and it keeps its own count for the standing mood it
       derives from having any at all. */
    if (I.noteAction) {
      I.noteAction(patient, 'implantInstalled', { witnesses: true, radius: 14 });
    }
    if (patient.ideo && typeof patient.ideo.implants === 'number') patient.ideo.implants++;
  }

  /* ---- euthanasia ---- */

  function euthanise(surgeon, patient) {
    var H = sys('Health');
    var who = nameOf(patient);
    var wasColonist = patient.faction === 'player' && !patient.prisoner;
    if (H && H.kill) H.kill(patient, 'euthanasia');
    else { patient.dead = true; patient.downed = false; }

    var map = patient.map;
    if (wasColonist && map && map.colonists) {
      var list = map.colonists();
      for (var i = 0; i < list.length; i++) think(list[i], 'euthanised');
    }
    letter('Mercy killing',
      who + ' was put down by ' + nameOf(surgeon) + '. Nobody in the room thinks it was the ' +
      'wrong call, and nobody is going to say so out loud either.',
      'death', patient);
    return { ok: true, outcome: 'euthanised', text: who + ' was euthanised.' };
  }

  /* ---- organ harvesting ---- */

  function harvestOrgan(surgeon, patient, part) {
    var H = sys('Health');
    var organId = ORGAN_OF_PART[part.defName];
    if (!organId) return { ok: false, outcome: 'invalid' };
    var map = patient.map;
    var wasAlive = !patient.dead;
    var prisoner = !!patient.prisoner;
    var who = nameOf(patient);

    /* The organ comes out first: taking a heart kills, and the item has
       to exist before the body stops being a body. */
    if (map && map.addItem) map.addItem(organId, patient.x, patient.y, 1);
    removePartSurgically(patient, part, Medicine.hospitalQuality(patient));

    var m = med(patient);
    m.harvested = (m.harvested || 0) + 1;
    _stats.organs++;

    if (wasAlive && !patient.dead && patient.isHuman) {
      think(patient, 'organHarvestedMe');
    }

    if (wasAlive && patient.isHuman) {
      harvestFallout(surgeon, patient, prisoner, patient.dead);
    }
    return {
      ok: true, outcome: 'harvested', organ: organId,
      text: nameOf(surgeon) + ' took ' + who + "'s " + part.label + '.'
    };
  }

  /* The heaviest mood event in the game, and the faction that grew the
     prisoner hears about it. A psychopath is exempt because the thought
     def says so; everyone else carries it for most of a season. */
  function harvestFallout(surgeon, patient, prisoner, died) {
    var map = patient.map;
    if (map && map.colonists) {
      var list = map.colonists();
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c === patient || c.prisoner) continue;
        think(c, died ? 'prisonerKilledForOrgans' : 'knowOrganHarvested', { otherPawnId: patient.id });
      }
    }

    var F = sys('Factions');
    var homeId = patient.prisoner ? patient.prisoner.factionId : patient.faction;
    if (F && homeId && homeId !== 'player' && F.adjustGoodwill) {
      F.adjustGoodwill(homeId, died ? -45 : -28,
        'you harvested organs from ' + nameOf(patient));
      if (died && F.declareWar) F.declareWar(homeId, 'butchering their people for parts');
    }

    letter(died ? 'Prisoner cut apart' : 'Organ harvested',
      nameOf(surgeon) + ' took an organ out of ' + nameOf(patient) +
      (prisoner ? ', who was a prisoner and is now ' + (died ? 'a corpse' : 'short one') : '') +
      '. The colony knows. So does everyone the prisoner came from.',
      'threat', patient);
  }

  /* Organs out of a body nobody can hurt any more. This is what the
     butcher-table recipe calls, and it is the only harvest with no mood
     cost attached: the patient is already dead. */
  Medicine.corpseOrganYield = function (corpse, pawn) {
    var out = {};
    if (!corpse || !corpse.corpse) return out;
    /* Human bodies only. `isAnimal` alone lets a mechanoid through -
       every mech kind is flagged false - and a kidney out of a war
       machine is not a thing a butcher table should produce.
       production.js tests the body the same way. */
    var kind = Defs.maybe('pawnKind', corpse.corpse.kindId);
    if (!kind || kind.body !== 'human') return out;

    /* A body left in the sun gives up nothing: that is the whole
       pressure behind building a freezer before a raid, not after. */
    var freshness = U.clamp01(1 - (corpse.rotProgress || 0) * 1.6);
    if (freshness <= 0.05) return out;

    /* One roll for the whole body, not one per organ. At the rate this
       shipped with - a chance per organ against a budget of one plus a
       third of the surgeon's skill - a skill-15 doctor pulled three
       organs out of every raider, so a six-body raid paid for a bionic
       leg and had change, and cutting up the dead was the best-paid
       work in the colony. One organ a body, and skill decides whether
       there is one at all: that leaves a corpse as the thing that
       makes a freezer worth building, not as an income. */
    var skill = skillLevel(pawn, 'medicine');
    if (!U.chance(freshness * (0.25 + 0.025 * skill))) return out;

    /* Shuffled, because walking a fixed list means the first name on it
       comes out of every body in the colony's history and the heart
       never does. */
    var taken = corpse.corpse.harvested || [];
    var pool = U.shuffle(['kidneyLeft', 'kidneyRight', 'lungLeft', 'lungRight', 'liver',
                          'heart', 'eyeLeft', 'eyeRight']);
    for (var i = 0; i < pool.length; i++) {
      if (taken.indexOf(pool[i]) >= 0) continue;
      var organ = ORGAN_OF_PART[pool[i]];
      if (!organ) continue;
      out[organ] = 1;
      taken.push(pool[i]);
      break;
    }
    corpse.corpse.harvested = taken;
    return out;
  };

  /* ---- treating a disease with a scalpel ---- */

  function treatDisease(surgeon, patient, op) {
    var H = sys('Health');
    var hd = H.hediff(patient, op.hediffId);
    if (!hd) return { ok: false, outcome: 'invalid' };
    var label = (hd.def && hd.def.label) || op.hediffId;

    /* Surgery does not cure a fever; it buys the immune system the two
       days it was going to lose by. */
    hd.severity = U.clamp01(hd.severity - U.randRange(0.20, 0.34));
    hd.immunity = U.clamp01(hd.immunity + U.randRange(0.14, 0.26));
    hd.tended = true;
    hd.tendQuality = Math.max(hd.tendQuality || 0, 0.85);
    if (H.invalidate) H.invalidate(patient);

    if (hd.severity <= 0.02 && !hd.def.immunizable) {
      H.removeHediff(patient, op.hediffId);
      msg(nameOf(surgeon) + ' cut the ' + label + ' out of ' + nameOf(patient) + '.', 'good', patient);
      return { ok: true, outcome: 'cured', text: 'cured' };
    }
    msg(nameOf(surgeon) + ' treated ' + nameOf(patient) + "'s " + label + '.', 'good', patient);
    return { ok: true, outcome: 'treated', text: 'treated' };
  }

  /* ============================================================
     10. DISEASE, IMMUNITY AND AGE

     health.js runs the race. What this file adds is who catches what,
     what a hospital is worth to the immune system, and the conditions
     that arrive with nothing but time.
     ============================================================ */

  Medicine.immunityRace = function (pawn, hediffId) {
    var H = sys('Health');
    if (!H || !pawn || !pawn.health) return null;
    var hd = H.hediff(pawn, hediffId);
    if (!hd) return null;
    var def = hd.def || {};

    var sevPerDay = def.severityPerDay || 0;
    var immPerDay = def.immunizable
      ? (pawn.health.immunityGain || 0.3) * ((def.immunityPerDay || 0.34) / 0.34) *
        (hd.tended ? 1 + hd.tendQuality : 1) + hospitalImmunityBonus(pawn)
      : 0;

    var sevLeft = 1 - hd.severity;
    var immLeft = 1 - hd.immunity;
    var daysToDeath = sevPerDay > 0 ? sevLeft / sevPerDay : Infinity;
    var daysToWin = immPerDay > 0 ? immLeft / immPerDay : Infinity;

    return {
      id: hediffId,
      label: def.label || hediffId,
      severity: hd.severity,
      immunity: hd.immunity,
      severityPerDay: sevPerDay,
      immunityPerDay: immPerDay,
      lethal: !!def.lethal,
      winning: daysToWin < daysToDeath,
      daysToWin: daysToWin,
      daysToDeath: daysToDeath,
      tended: !!hd.tended
    };
  };

  /* Immunity per day bought purely by the room the patient is lying in.
     health.js already counts rest, food and tend quality; this is the
     part it cannot see, and it is why a hospital is worth building. */
  function hospitalImmunityBonus(pawn) {
    if (!bedUnder(pawn)) return 0;
    var resting = pawn.asleep || pawn.downed ||
                  (pawn.job && (pawn.job.defId === 'layDown' || pawn.job.defId === 'sleep'));
    if (!resting) return 0;
    return Medicine.hospitalQuality(pawn) * 0.22;
  }
  Medicine.hospitalImmunityBonus = hospitalImmunityBonus;

  Medicine.diseasesOf = function (pawn) {
    var h = pawn && pawn.health;
    if (!h || !h.hediffs) return [];
    var out = [];
    for (var i = 0; i < h.hediffs.length; i++) {
      var hd = h.hediffs[i];
      if (!hd.def || (!hd.def.isDisease && !hd.def.immunizable)) continue;
      var race = Medicine.immunityRace(pawn, hd.id);
      if (race) out.push(race);
    }
    return out;
  };

  /* Which diseases the world is currently handing out, and how often. */
  function diseaseWeights(pawn) {
    var G = root.Game;
    var season = G && G.season ? G.season() : 'spring';
    var biome = (G && G.biome) || 'temperateForest';
    var temp = G && G.outdoorTemp ? G.outdoorTemp() : 15;

    var w = {
      flu: season === 'fall' || season === 'winter' ? 3.0 : 1.4,
      plague: 0.7,
      gutWorms: 1.1,
      muscleParasites: 0.9,
      malaria: biome === 'aridShrubland' || temp > 24 ? 1.8 : 0.35,
      sleepingSickness: biome === 'temperateForest' && temp > 18 ? 1.2 : 0.3
    };
    /* Malnutrition and filth are what a real outbreak follows. */
    var hungry = pawn.needs && pawn.needs.food < 0.25;
    if (hungry) { w.flu *= 1.6; w.plague *= 1.6; }
    return w;
  }

  var DISEASE_FREE_DAYS = 3;          /* nothing catches anything in the first days */
  var BASE_SICKNESS_PER_DAY = 0.016;  /* per colonist; about one case a fortnight in a three-pawn colony */

  function rollDisease(pawn) {
    var H = sys('Health');
    if (!H || !isHuman(pawn) || pawn.dead) return;
    if (pawn.faction !== 'player') return;
    if (day() < DISEASE_FREE_DAYS) return;

    var h = pawn.health;
    for (var i = 0; i < h.hediffs.length; i++) {
      /* One illness at a time. Two races at once is not a decision, it
         is a death sentence with extra arithmetic. */
      if (h.hediffs[i].def && h.hediffs[i].def.isDisease) return;
    }

    var chance = BASE_SICKNESS_PER_DAY * (DISEASE_BEAT / TICKS_PER_DAY);
    /* Sleeping on a filthy floor, wounded, in the cold. */
    var R = sys('Regions');
    var room = (R && R.roomAt && pawn.map) ? R.roomAt(pawn.map, pawn.x, pawn.y) : null;
    if (room && room.cleanliness < 0) chance *= 1 + Math.min(1.5, -room.cleanliness);
    if (h.injuries.length > 2) chance *= 1.3;
    if (pawn.needs && pawn.needs.rest < 0.25) chance *= 1.4;

    if (!U.chance(chance)) return;

    var w = diseaseWeights(pawn);
    var ids = Object.keys(w).filter(function (id) { return H.HEDIFFS[id]; });
    if (!ids.length) return;
    var pick = U.pickWeighted(ids, function (id) { return w[id]; });
    if (!pick) return;

    H.addHediff(pawn, pick, 0.06);
    var def = H.HEDIFFS[pick];
    letter('Disease: ' + (def.label || pick),
      nameOf(pawn) + ' has come down with ' + (def.label || pick) + '. Get them into a clean ' +
      'bed and keep a doctor on them: immunity only outruns the illness if somebody is ' +
      'tending it.',
      'threat', pawn);
    _stats.illnesses++;
  }

  /* ---- age ---- */

  function ageOf(pawn) {
    if (typeof pawn.ageYears === 'number') return pawn.ageYears;
    if (typeof pawn.ageTicks === 'number') return pawn.ageTicks / (TICKS_PER_DAY * 60);
    return 25;
  }

  function rollChronic(pawn) {
    var H = sys('Health');
    if (!H || !isHuman(pawn) || pawn.dead) return;
    var age = ageOf(pawn);
    if (age < 26) return;

    /* Roughly: nothing before thirty, one condition by fifty, a
       collection by seventy. Slow enough that a colony notices it as a
       story rather than a tax. */
    var perDay = U.curve([[26, 0.0006], [40, 0.0022], [55, 0.0060], [70, 0.0130], [90, 0.024]], age);
    if (!U.chance(perDay * (AGE_BEAT / TICKS_PER_DAY))) return;

    var options = [];
    Object.keys(CHRONIC).forEach(function (id) {
      var c = CHRONIC[id];
      if (age < c.minAge) return;
      if (H.hasHediff(pawn, id)) return;
      /* A condition of a part that is already machinery never arrives. */
      if (c.part && Medicine.implantAt(pawn, c.part)) return;
      options.push(id);
    });
    if (!options.length) return;

    var pick = U.pick(options);
    H.addHediff(pawn, pick, U.randRange(0.25, 0.6));
    var def = CHRONIC[pick];
    if (pawn.faction === 'player' && !pawn.prisoner) {
      letter('Age catches up',
        nameOf(pawn) + ' has developed ' + (def.label || pick) + '. It will not go away on its ' +
        'own, and some of these have an expensive answer on the research tree.',
        'neutral', pawn);
    }
  }

  /* ============================================================
     11. THE TICK
     ============================================================ */

  Medicine.tickPawn = function (pawn) {
    if (!_installed) install();
    if (!pawn || pawn.dead || !pawn.health) return;

    var t = now() + (pawn.id || 0);

    if (t % IMMUNITY_BEAT === 0) tickImmunity(pawn);
    if (t % DISEASE_BEAT === 0) rollDisease(pawn);
    if (t % AGE_BEAT === 0) rollChronic(pawn);
  };

  /* The hospital's share of the immunity race. health.js has already
     moved severity and its own immunity this beat; this adds what the
     room bought on top, so a patient in a clean infirmary genuinely
     pulls ahead of one lying on the kitchen floor. */
  function tickImmunity(pawn) {
    var h = pawn.health;
    if (!h.hediffs || !h.hediffs.length) return;
    var bonus = hospitalImmunityBonus(pawn);
    if (bonus <= 0) return;
    var days = IMMUNITY_BEAT / TICKS_PER_DAY;
    for (var i = 0; i < h.hediffs.length; i++) {
      var hd = h.hediffs[i];
      if (!hd.def || !hd.def.immunizable) continue;
      hd.immunity = U.clamp01(hd.immunity + bonus * days);
    }
  }

  /* game.js drives the pawn beat; this is here for the map beat it also
     offers, and it does nothing a missed call would break. */
  Medicine.tick = function (map, game) {
    if (!_installed) install();
  };

  /* ============================================================
     12. THE JOB AND THE WORK GIVERS
     ============================================================ */

  function registerJob() {
    var Jobs = sys('Jobs'), Toils = sys('Toils'), T = sys('T'), Res = sys('Res'), Path = sys('Path');
    if (!Jobs || !Toils || !T) return false;
    if (Jobs.isRegistered && Jobs.isRegistered('operate')) return true;
    var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

    /* Pick up the doses the operation needs. Never fails outright: a
       surgeon who could only find one dose still operates, at odds the
       player can read before they queue it. */
    function fetchMedicineToil() {
      return Toils.custom({
        name: 'fetchSurgicalMedicine',
        init: function (pawn, job, s) {
          s.ticks = 0;
          s.need = job.state.doses | 0;
          s.phase = 'pick';
          if (s.need <= 0) s.phase = 'done';
          else if (pawn.carried && pawn.carried.def.isMedicine) s.phase = 'done';
        },
        tick: function (pawn, job, s) {
          if (s.phase === 'done') return 'next';
          var map = pawn.map;
          if (++s.ticks > 3000) return 'next';

          if (s.phase === 'pick') {
            var stack = bestMedicine(map, pawn);
            if (!stack) return 'next';
            job.targetB = T.thing(stack);
            if (Res) Res.reserve(pawn, job.targetB, 1);
            s.phase = 'walk';
          }

          var med2 = T.resolve(job.targetB, map);
          if (!med2 || !med2.spawned) { job.targetB = null; s.phase = 'pick'; return 'stay'; }
          if (U.cheb(pawn.x, pawn.y, med2.x, med2.y) <= 1) {
            pawn.stopPath();
            var take = Math.min(s.need, med2.stack);
            var part = map.splitStack(med2, take);
            if (!part) return 'next';
            part.x = pawn.x; part.y = pawn.y;
            part.spawned = false; part.map = map;
            if (pawn.carried) Toils.placeCarried(pawn, pawn.x, pawn.y);
            pawn.carried = part;
            return 'next';
          }
          if (!pawn.moving() && !pawn.startPath(med2.x, med2.y, PE.TOUCH)) return 'next';
          return 'stay';
        }
      });
    }

    Jobs.register('operate', {
      label: 'operate',
      reportString: 'Operating on {A}.',
      toils: function (job, pawn) {
        return [
          Toils.custom({
            name: 'confirmOperation',
            tick: function (p, j) {
              var patient = T.resolve(j.targetA, p.map);
              if (!patient) return 'fail';
              var op = findOp(patient, j.state.opId);
              if (!op) return 'fail';
              var can = Medicine.canPerform(p, patient, op);
              if (!can.ok) return 'fail';
              j.state.doses = medicineNeeded(op);
              return 'next';
            }
          }),
          fetchMedicineToil(),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.work({
            name: 'operate',
            /* No skill here: Medicine.perform pays the medical xp itself,
               and paying it twice would train a surgeon at double speed
               for no reason a player could see.

               The amount is the nominal work and nothing else. A
               shaky-handed surgeon is slow because `rate` below is
               pawn.workRate, and pawn.workRate is Health.workSpeedFactor,
               and that is manipulation times consciousness already.
               Dividing the amount by manipulation as well charged a
               one-handed doctor for the same disability twice. */
            amount: function (p, j) {
              var patient = T.resolve(j.targetA, p.map);
              var op = patient ? findOp(patient, j.state.opId) : null;
              return op ? (OPS[op.kind] || {}).work || 2000 : 2000;
            },
            rate: function (p) {
              return (typeof p.workRate === 'function') ? p.workRate('medicine') : 0.6;
            },
            failIfGone: true,
            onDone: function (p, j) {
              var map = p.map;
              var patient = T.resolve(j.targetA, map);
              if (!patient) return 'fail';
              var op = findOp(patient, j.state.opId);
              if (!op) return 'fail';

              var medicine = (p.carried && p.carried.def.isMedicine) ? p.carried : null;
              var implantItem = j.targetC ? T.resolve(j.targetC, map) : null;

              var res = Medicine.perform(p, patient, op, medicine);

              /* Everything the operation consumed goes now, success or
                 not: a botched fitting destroys the part it botched. */
              if (medicine) {
                medicine.stack -= Math.max(1, j.state.doses | 0);
                if (medicine.stack <= 0) { p.carried = null; map.despawnThing(medicine); }
              }
              if (op.kind === 'install' && implantItem && implantItem.spawned) {
                if (implantItem.stack > 1) implantItem.stack--;
                else map.despawnThing(implantItem);
              }
              return 'done';
            }
          })
        ];
      }
    });
    return true;
  }

  function findOp(patient, opId) {
    var m = patient && patient.med;
    if (!m) return null;
    for (var i = 0; i < m.ops.length; i++) if (m.ops[i].id === opId) return m.ops[i];
    return null;
  }

  function registerGivers() {
    var WG = sys('WorkGivers'), Jobs = sys('Jobs'), T = sys('T'), Res = sys('Res'), Path = sys('Path');
    if (!WG || !Jobs || !T || !Res) return false;
    if (WG.get && WG.get('medicalOperation')) return true;

    function reachable(map, pawn, x, y) {
      return !Path || !Path.reachable || Path.reachable(map, pawn.x, pawn.y, x, y, { pawn: pawn });
    }

    /* A surgeon takes the patient, the implant and the first dose of
       medicine before walking anywhere, because two doctors crossing
       the colony for the same knee is the failure a player sees. */
    WG.register({
      id: 'medicalOperation', workType: 'doctor', order: 15,
      label: 'perform an operation',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        if (!map) return null;
        var pawns = map.pawns;
        var best = null, bestOp = null, bestScore = -Infinity;

        for (var i = 0; i < pawns.length; i++) {
          var patient = pawns[i];
          if (patient === pawn || patient.dead || !patient.med || !patient.med.ops.length) continue;
          if (patient.faction !== 'player') continue;
          if (!Res.canReserve(pawn, T.pawn(patient), 1)) continue;
          if (!reachable(map, pawn, patient.x, patient.y)) continue;

          var op = patient.med.ops[0];
          if (!Medicine.canPerform(pawn, patient, op).ok) continue;

          /* Sooner for somebody who is bleeding into the mattress, and
             sooner for the shorter walk. */
          var score = 60 - U.dist(pawn.x, pawn.y, patient.x, patient.y);
          if (patient.downed) score += 25;
          if (op.kind === 'euthanize') score += 40;
          if (score > bestScore) { bestScore = score; best = patient; bestOp = op; }
        }
        if (!best) return null;

        var targetA = T.pawn(best);
        if (!Res.reserve(pawn, targetA, 1)) return null;

        var job = Jobs.make('operate', targetA, null, { state: { opId: bestOp.id, doses: medicineNeeded(bestOp) } });
        if (bestOp.kind === 'install') {
          var item = findImplantItem(map, bestOp.defId, pawn);
          if (!item) { Res.release(pawn, targetA); return null; }
          job.targetC = T.thing(item);
          Res.reserve(pawn, job.targetC, 1);
        }
        return job;
      }
    });

    /* A colonist who has been signed up for a bionic leg has to be
       lying down before anybody can fit it, and nothing else in the
       game would ever send them to bed. */
    WG.register({
      id: 'patientAwaitSurgery', workType: 'patient', order: 5,
      label: 'go to bed for surgery',
      tryGiveJob: function (pawn) {
        if (!Medicine.hasPendingOperation(pawn)) return null;
        if (bedUnder(pawn)) return null;
        var J = sys('Jobs');
        if (!J || !J.findBed) return null;
        /* Lying down for a surgeon who does not exist is just lying
           down, so check somebody can actually do it first. */
        var op = Medicine.pendingOperation(pawn);
        var surgeon = bestSurgeonFor(pawn, op);
        if (!surgeon || skillLevel(surgeon, 'medicine') < requiredSkill(op)) return null;

        var bed = J.findBed(pawn.map, pawn, { realBedOnly: false });
        if (!bed) return null;
        var target = T.thing(bed);
        if (!Res.reserve(pawn, target, 1)) return null;
        return Jobs.make('layDown', target, null, { count: 4000, state: { asleep: false } });
      }
    });

    return true;
  }

  /* ============================================================
     13. INSTALL

     Four things cannot be done by registration alone. Each one is a
     capacity health.js computes and clamps to 1, or a number combat.js
     works out from a private table - and a bionic leg that cannot make
     a colonist faster than a flesh leg is a very expensive ornament.
     So this file wraps the four functions that read them, at the one
     place each is read, the way training.js hangs its answer off the
     end of the animal brain. Nothing is edited: these are functions
     looked up by name at tick time, each wrap is idempotent, and each
     falls straight through for a pawn with no implants.
     ============================================================ */

  var _installed = false;
  var _stats = { surgeries: 0, botched: 0, organs: 0, illnesses: 0 };

  function wrapHealth() {
    var H = root.Health;
    if (!H || H.__medicineWrapped) return;
    H.__medicineWrapped = true;

    var baseMove = H.moveSpeedFactor;
    H.moveSpeedFactor = function (pawn) {
      var v = baseMove.call(H, pawn);
      var m = pawn && pawn.med;
      if (!m || !m.implants.length) return v;
      return v * bonuses(pawn).move;
    };

    var baseWork = H.workSpeedFactor;
    H.workSpeedFactor = function (pawn) {
      var v = baseWork.call(H, pawn);
      var m = pawn && pawn.med;
      if (!m || !m.implants.length) return v;
      return v * bonuses(pawn).work;
    };

    /* A medical bed in a clean, lit room is worth a better dressing
       than the same doctor could manage in a corridor. health.js sets
       the tend quality from the doctor and the medicine; the room is
       the part it cannot see. */
    var baseTend = H.tend;
    H.tend = function (pawn, doctor, medicine) {
      var did = baseTend.call(H, pawn, doctor, medicine);
      if (!did) return did;
      var q = Medicine.hospitalQuality(pawn);
      if (q <= 0.15) return did;
      var lift = 1 + q * 0.30;
      var h = pawn.health, i;
      for (i = 0; i < h.injuries.length; i++) {
        var inj = h.injuries[i];
        if (!inj.tended) continue;
        var before = inj.tendQuality;
        inj.tendQuality = U.clamp(before * lift, 0, 1);
        if (inj.bleedRate > 0) inj.bleedRate *= 1 - (inj.tendQuality - before) * 0.9;
        if (inj.bleedRate < 0.01) inj.bleedRate = 0;
      }
      for (i = 0; i < h.hediffs.length; i++) {
        if (h.hediffs[i].tended) h.hediffs[i].tendQuality = U.clamp(h.hediffs[i].tendQuality * lift, 0, 1);
      }
      return did;
    };

    /* A power claw is a weapon that happens to be a hand. combat.js
       builds an unarmed swing with no weapon behind it and says so by
       passing a null source; that is the exact blow an implanted
       weapon replaces, and nothing else. */
    var baseDamage = H.damage;
    H.damage = function (pawn, opts) {
      if (opts && opts.instigator && opts.source == null) {
        var profile = Medicine.unarmedProfile(opts.instigator);
        if (profile && profile.damage > (opts.amount || 0)) {
          var boosted = {};
          for (var k in opts) boosted[k] = opts[k];
          boosted.amount = profile.damage;
          boosted.type = profile.type;
          boosted.source = profile.label;
          return baseDamage.call(H, pawn, boosted);
        }
      }
      return baseDamage.call(H, pawn, opts);
    };
  }

  function wrapCombat() {
    var C = root.Combat;
    if (!C || C.__medicineWrapped || typeof C.rangedHitChance !== 'function') return;
    C.__medicineWrapped = true;
    var base = C.rangedHitChance;
    C.rangedHitChance = function (shooter, target, weapon, opts) {
      var v = base.call(C, shooter, target, weapon, opts);
      var m = shooter && shooter.med;
      if (!m || !m.implants.length) return v;
      return U.clamp(v * bonuses(shooter).aim, 0, 0.99);
    };
  }

  function install() {
    if (_installed) return true;
    var ok = registerJob() && registerGivers();
    wrapHealth();
    wrapCombat();
    /* The wraps are permanent; the registry work only counts as done
       once jobs.js and workgivers.js have actually loaded. */
    if (ok) _installed = true;
    return _installed;
  }
  Medicine.install = install;

  /* The recipe's dynamic product table, bound after the recipe is
     registered so the def carries a real function rather than a name. */
  (function bindCorpseRecipe() {
    var r = Defs.maybe('recipe', 'harvestOrgansFromCorpse');
    if (!r) return;
    r.productsFor = function (ingredients, pawn) {
      var corpse = null;
      for (var i = 0; i < (ingredients || []).length; i++) {
        var t = ingredients[i] && (ingredients[i].thing || ingredients[i]);
        if (t && t.corpse) { corpse = t; break; }
      }
      return corpse ? Medicine.corpseOrganYield(corpse, pawn) : {};
    };
    r.accepts = function (thingDef) { return !!thingDef && thingDef.id === 'corpse'; };
  })();

  /* Try once at load in case this file ever sits below jobs.js in the
     load order; otherwise the first tick does it. */
  install();

  /* ============================================================
     14. READOUTS

     What the health tab draws. Every one of these is cheap and none of
     them touch the DOM.
     ============================================================ */

  Medicine.bodyPartReport = function (pawn) {
    var H = sys('Health');
    var rows = [];
    if (!pawn || !H || !pawn.health || !pawn.health.parts) return rows;
    var h = pawn.health;

    for (var i = 0; i < h.parts.length; i++) {
      var part = h.parts[i];
      var implant = Medicine.implantAt(pawn, part.defName);
      var mine = [];
      for (var j = 0; j < h.injuries.length; j++) {
        if (h.injuries[j].partId !== part.id) continue;
        var inj = h.injuries[j];
        mine.push({
          label: inj.label,
          amount: Math.round(inj.amount),
          tended: !!inj.tended,
          permanent: !!inj.permanent,
          bleeding: !inj.tended && inj.bleedRate > 0,
          isImplant: !!inj.implantDefId
        });
      }
      if (!mine.length && !part.missing && !implant) continue;

      var implantDef = implant ? IMPLANTS[implant.defId] : null;
      var thingDef = implant ? Defs.maybe('thing', implant.defId) : null;
      rows.push({
        part: part.label,
        partName: part.defName,
        missing: !!part.missing,
        hp: Math.round(part.hp),
        maxHp: part.maxHp,
        efficiency: part.missing ? 0 : U.clamp01(part.hp / Math.max(1, part.maxHp)),
        implant: implant ? {
          defId: implant.defId,
          label: thingDef ? thingDef.label : implant.defId,
          tier: implantDef ? implantDef.tier : 'simple',
          efficiency: implantDef ? implantDef.efficiency : 1
        } : null,
        injuries: mine
      });
    }

    for (i = 0; i < h.hediffs.length; i++) {
      var hd = h.hediffs[i];
      var hdef = hd.def || {};
      if (hdef.implant) continue;
      rows.push({
        part: hdef.label || hd.id,
        partName: null,
        hediff: hd.id,
        severity: hd.severity,
        immunity: hd.immunity,
        chronic: !!hdef.chronic,
        race: hdef.immunizable ? Medicine.immunityRace(pawn, hd.id) : null,
        missing: false, injuries: []
      });
    }
    return rows;
  };

  Medicine.summary = function (pawn) {
    var m = pawn && pawn.med;
    var bits = [];
    if (m && m.implants.length) bits.push(m.implants.length + ' implant' + (m.implants.length === 1 ? '' : 's'));
    if (m && m.ops.length) bits.push(m.ops.length + ' operation' + (m.ops.length === 1 ? '' : 's') + ' queued');
    var races = Medicine.diseasesOf(pawn);
    for (var i = 0; i < races.length; i++) {
      bits.push(races[i].label + ' ' + U.pct(races[i].severity) +
                (races[i].winning ? ' (winning)' : ' (losing)'));
    }
    return bits.length ? bits.join(', ') : 'nothing on the chart';
  };

  Medicine.stats = function () {
    return { surgeries: _stats.surgeries, botched: _stats.botched,
             organs: _stats.organs, illnesses: _stats.illnesses };
  };

  /* ============================================================
     15. SAVE

     Almost everything this file owns already rides along: operations
     and implants live on pawn.med, which save.js deep-copies with the
     rest of the pawn, and a medical bed is a flag on a Thing, which
     save.js carries as a scalar. What is left is the running tally.
     ============================================================ */

  Medicine.save = function () {
    return {
      v: 1,
      surgeries: _stats.surgeries,
      botched: _stats.botched,
      organs: _stats.organs,
      illnesses: _stats.illnesses
    };
  };

  Medicine.load = function (obj) {
    _stats = { surgeries: 0, botched: 0, organs: 0, illnesses: 0 };
    if (!obj || typeof obj !== 'object') return false;
    _stats.surgeries = obj.surgeries | 0;
    _stats.botched = obj.botched | 0;
    _stats.organs = obj.organs | 0;
    _stats.illnesses = obj.illnesses | 0;
    return true;
  };

  Medicine.reset = function () {
    _stats = { surgeries: 0, botched: 0, organs: 0, illnesses: 0 };
  };

  /* A loaded pawn's implant list came back as plain data, and the
     bonus total derived from it belongs to the session that built it.
     Nothing in save.js calls this - the WeakMap already has no entry
     for a pawn a load has just rebuilt - but it is the honest answer
     if a loader ever does. */
  Medicine.rebind = function (pawn) {
    if (!pawn) return;
    med(pawn);
    invalidateBonuses(pawn);
  };

  root.Medicine = Medicine;
})(this);
