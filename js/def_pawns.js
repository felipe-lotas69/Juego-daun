/* ============================================================
   def_pawns.js - everything a person (or an animal) is made of:
   the twelve skills, the work columns, body part trees, traits,
   backstories, thoughts, mental states, factions and pawn kinds.

   Five conventions run through the whole file, stated once here
   rather than re-explained at every def:

   1. MOOD IS IN POINTS, 0..100. Every `mood` on a thought stage and
      every trait `moodOffset` below is a mood *point*: optimist is
      +12 points, "ate without a table" is -3 points. needs.js sums
      the points a pawn is carrying, adds them to a 50-point baseline
      and divides by 100 to get `pawn.mood`, which the contract fixes
      at 0..1. Thresholds are the exception: `mentalBreakThresholdOffset`
      is already in 0..1 units, because it is added straight onto the
      0.35 / 0.25 / 0.15 break thresholds. Points for mood, fractions
      for thresholds - the two never mix.

   2. A body is a flat list of parts in parent-before-child order, and
      `coverage` is the chance this part takes the hit *given that its
      parent was hit*. combat.js rolls down the tree from the core part:
      torso (1.0) -> arm (0.12) -> hand (0.40). Outside parts are what a
      bullet meets first; inside parts are only reachable once damage
      has gone through the shell, which is why a ribcage and a spine
      are worth having: they are surface area that is not a heart.

   3. CAPACITY SUPPLY SUMS TO EXACTLY 1.0 PER BODY, for every one of the
      nine capacities. Two legs at 0.5 moving, two lungs at 0.5 breathing,
      one brain at 1.0 consciousness. That means health.js gets the same
      answer whether it sums the surviving supply or divides it by the
      total the body could supply, so the two obvious implementations
      agree. The validation pass at the bottom of this file enforces it.
      Nothing supplies a capacity twice over "for realism" - the moment a
      total drifts past 1.0 the two readings disagree and a pawn's arm
      starts mattering more in one file than another.

   4. Rates written per day are per day. baseHungerRate is nutrition per
      day; whoever consumes it divides by 60000. Durations written in
      ticks are ticks (60 ticks = 1 second, 60000 = 1 day).

   5. Factions are registered LAST and `PawnNames` is a plain global,
      not a def table: names are not content the engine looks up by id,
      they are a bag mapgen dips into.

   Fields beyond the ones the contract names are marked "extra:" in the
   comment above their table. They are optional - a consumer that does
   not know about them reads a sensible default and behaves correctly.
   ============================================================ */
(function (root) {
  'use strict';

  var Defs = root.Defs;

  /* Shared empty values. Defs.add hands the SAME object to every def that
     omits the key, so they are frozen: a def is read-only data, and an
     accidental push would otherwise give a trait to half the game. */
  var NO_ARRAY = Object.freeze([]);
  var NO_MAP = Object.freeze({});

  /* ============================================================
     1. SKILLS

     `workSpeedRelevant` says whether the level feeds the work speed
     curve (0.4 + 0.08 x level). Shooting, melee and social move
     accuracy and social chances instead, so they stay out of it and
     the UI can label the difference honestly.
     ============================================================ */
  Defs.add('skill', {

    shooting: {
      label: 'Shooting',
      description: 'Accuracy and aim speed with ranged weapons. A level 0 shooter misses a wall; a level 20 shooter picks the eye.',
      workSpeedRelevant: false
    },
    melee: {
      label: 'Melee',
      description: 'Hit chance, damage and parry with fists, knives and clubs. Also how well a hunter finishes a wounded animal.',
      workSpeedRelevant: false
    },
    construction: {
      label: 'Construction',
      description: 'Speed of building and repairing, and the chance a wall goes up without the materials being wasted.',
      workSpeedRelevant: true
    },
    mining: {
      label: 'Mining',
      description: 'Speed of cutting rock and the chance a mined seam gives up its ore instead of rubble.',
      workSpeedRelevant: true
    },
    cooking: {
      label: 'Cooking',
      description: 'Speed of cooking and butchering, and how rarely a meal leaves the colony vomiting.',
      workSpeedRelevant: true
    },
    plants: {
      label: 'Plants',
      description: 'Sowing, harvesting and cutting speed, and how much of a crop survives being pulled out of the ground.',
      workSpeedRelevant: true
    },
    animals: {
      label: 'Animals',
      description: 'Taming and training chances, and how calmly an animal takes being handled.',
      workSpeedRelevant: true
    },
    crafting: {
      label: 'Crafting',
      description: 'Speed and quality at every bench: smithing, tailoring, stonecutting, component work.',
      workSpeedRelevant: true
    },
    artistic: {
      label: 'Artistic',
      description: 'Quality of sculptures and of anything made to be looked at. Beauty is a mood stat, and this is where it comes from.',
      workSpeedRelevant: true
    },
    medicine: {
      label: 'Medicine',
      description: 'Tend quality and speed. The difference between a bandaged colonist and an infected one.',
      workSpeedRelevant: true
    },
    social: {
      label: 'Social',
      description: 'Recruitment, trade prices and how often a chat lands well instead of turning into an insult.',
      workSpeedRelevant: false
    },
    intellectual: {
      label: 'Intellectual',
      description: 'Research speed. The only route out of hauling rocks by hand.',
      workSpeedRelevant: true
    }

  });

  /* ============================================================
     2. WORK TYPES

     `order` is the Work-tab column order, left to right, and it is the
     order WorkGivers walks within a priority band. It is written out
     rather than inferred from position so that reordering a column is
     one number, not a shuffle of the table.

     `alwaysDoable` marks the three columns no backstory or trait may
     ever switch off: a pawn who cannot be a patient, cannot rest in bed
     and cannot pick things up is a pawn who quietly starves in a corner.
     The validation pass refuses any disabledWork list that names one.

     extra: `defaultPriority` is what pawn.js writes into workPriority
     for a fresh colonist, and `emergency` marks the two columns
     WorkGivers.emergency is allowed to jump the queue for.
     ============================================================ */
  Defs.add('workType', {

    firefight: {
      label: 'Firefight', verb: 'firefighting', order: 0,
      description: 'Put out fires, in a room or on a colonist. Nobody finishes their current job while the kitchen burns.',
      skills: NO_ARRAY, relevantSkillsLabel: 'None',
      alwaysDoable: false, defaultPriority: 3, emergency: true
    },
    patient: {
      label: 'Patient', verb: 'being a patient', order: 1,
      description: 'Go to a bed and hold still to be treated. Refusing this is refusing to survive.',
      skills: NO_ARRAY, relevantSkillsLabel: 'None',
      alwaysDoable: true, defaultPriority: 3, emergency: true
    },
    doctor: {
      label: 'Doctor', verb: 'doctoring', order: 2,
      description: 'Tend wounds and disease, and carry the downed to a bed before they bleed out where they fell.',
      skills: ['medicine'], relevantSkillsLabel: 'Medicine',
      alwaysDoable: false, defaultPriority: 3, emergency: true
    },
    bedRest: {
      label: 'Bed rest', verb: 'resting in bed', order: 3,
      description: 'Stay in bed while injured or sick instead of limping back to work. Rest is how wounds close.',
      skills: NO_ARRAY, relevantSkillsLabel: 'None',
      alwaysDoable: true, defaultPriority: 3, emergency: false
    },
    basic: {
      label: 'Basic', verb: 'doing basic chores', order: 4,
      description: 'Refuel campfires and generators, flick switches, and the other small errands that keep the lights on.',
      skills: NO_ARRAY, relevantSkillsLabel: 'None',
      alwaysDoable: true, defaultPriority: 3, emergency: false
    },
    warden: {
      label: 'Warden', verb: 'wardening', order: 5,
      description: 'Talk to captives and try to talk them into staying. Needs a level head and a good tongue.',
      skills: ['social'], relevantSkillsLabel: 'Social',
      alwaysDoable: false, defaultPriority: 3, emergency: false
    },
    handle: {
      label: 'Handle', verb: 'handling animals', order: 6,
      description: 'Tame wild animals and train the tame ones to obey and to fight.',
      skills: ['animals'], relevantSkillsLabel: 'Animals',
      alwaysDoable: false, defaultPriority: 3, emergency: false
    },
    cook: {
      label: 'Cook', verb: 'cooking', order: 7,
      description: 'Turn raw food into meals at a campfire or stove, and turn corpses into raw food at a butcher table.',
      skills: ['cooking'], relevantSkillsLabel: 'Cooking',
      alwaysDoable: false, defaultPriority: 3, emergency: false
    },
    hunt: {
      label: 'Hunt', verb: 'hunting', order: 8,
      description: 'Kill the animals marked for hunting and drag the carcasses home. Wounded prey sometimes objects.',
      skills: ['shooting', 'melee'], relevantSkillsLabel: 'Shooting, Melee',
      alwaysDoable: false, defaultPriority: 3, emergency: false
    },
    construct: {
      label: 'Construct', verb: 'constructing', order: 9,
      description: 'Carry materials into blueprints, raise the frames, and repair what the last raid knocked down.',
      skills: ['construction'], relevantSkillsLabel: 'Construction',
      alwaysDoable: false, defaultPriority: 3, emergency: false
    },
    grow: {
      label: 'Grow', verb: 'growing', order: 10,
      description: 'Sow growing zones and bring in the harvest before frost or blight does it first.',
      skills: ['plants'], relevantSkillsLabel: 'Plants',
      alwaysDoable: false, defaultPriority: 3, emergency: false
    },
    mine: {
      label: 'Mine', verb: 'mining', order: 11,
      description: 'Cut the rock marked for mining, for the ore in it or simply for the room.',
      skills: ['mining'], relevantSkillsLabel: 'Mining',
      alwaysDoable: false, defaultPriority: 3, emergency: false
    },
    plantCut: {
      label: 'Plant cut', verb: 'cutting plants', order: 12,
      description: 'Chop trees for wood and clear the scrub marked for cutting.',
      skills: ['plants'], relevantSkillsLabel: 'Plants',
      alwaysDoable: false, defaultPriority: 3, emergency: false
    },
    craft: {
      label: 'Craft', verb: 'crafting', order: 13,
      description: 'Work the benches: smithing, tailoring, stonecutting, sculpture, components.',
      skills: ['crafting', 'artistic'], relevantSkillsLabel: 'Crafting, Artistic',
      alwaysDoable: false, defaultPriority: 3, emergency: false
    },
    haul: {
      label: 'Haul', verb: 'hauling', order: 14,
      description: 'Carry loose things to a stockpile. Unglamorous, endless, and the colony seizes up without it.',
      skills: NO_ARRAY, relevantSkillsLabel: 'None',
      alwaysDoable: true, defaultPriority: 3, emergency: false
    },
    clean: {
      label: 'Clean', verb: 'cleaning', order: 15,
      description: 'Scrub blood and filth out of the rooms. Dirty floors are why a tended wound goes septic.',
      skills: NO_ARRAY, relevantSkillsLabel: 'None',
      alwaysDoable: false, defaultPriority: 4, emergency: false
    },
    research: {
      label: 'Research', verb: 'researching', order: 16,
      description: 'Advance the current project at a research bench.',
      skills: ['intellectual'], relevantSkillsLabel: 'Intellectual',
      alwaysDoable: false, defaultPriority: 3, emergency: false
    }

  });
