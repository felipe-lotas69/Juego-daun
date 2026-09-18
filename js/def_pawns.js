/* ============================================================
   def_pawns.js - everything a person (or an animal) is made of.

   Skills, the work columns, body part trees, traits, backstories,
   thoughts, mental states, factions and pawn kinds. Nothing here runs:
   it is the data that pawn.js, needs.js, health.js, combat.js,
   animals.js, mapgen.js and the UI read to decide what a pawn can do,
   how much it hurts and how it feels about the day.

   Ids are frozen by the contract's registry. Numbers are RimWorld-ish
   and deliberately readable: mood is stated in mood points (-12 reads
   as "minus twelve mood"), needs.js divides by 100 on its way in.
   ============================================================ */
(function (root) {
  'use strict';

  var Defs = root.Defs;

  /* Shared empty values. Frozen because Defs.add copies the same
     reference onto every def that leaves the field out, and a table
     nobody can write to cannot be corrupted by one careless consumer. */
  var NO_SKILLS = Object.freeze({});      /* skillGains: nothing gained    */
  var NO_SKILL_IDS = Object.freeze([]);   /* skills: no skill applies      */
  var NO_WORK = Object.freeze([]);        /* disabledWork: nothing barred  */
  var NO_TRAITS = Object.freeze([]);      /* nullifiedByTrait: nobody      */
  var NO_CAPS = Object.freeze({});        /* a part that supplies nothing  */
  var NO_THINGS = Object.freeze([]);      /* weapons/apparel: none         */

  /* ============================================================
     1. SKILLS

     Twelve of them, in the order the character tab lists them.
     `workSpeedRelevant` marks the skills that scale a work rate
     (0.4 + 0.08 x level) rather than only a success chance.
     ============================================================ */

  Defs.add('skill', {
    shooting: {
      label: 'Shooting',
      description: 'Accuracy and steadiness with a ranged weapon. A high level hits more ' +
        'often at long range and wastes fewer shots getting there.',
      workSpeedRelevant: false
    },
    melee: {
      label: 'Melee',
      description: 'Fighting hand to hand, with a blade, a club or bare fists. Raises both ' +
        'the chance to land a blow and the chance to slip one.',
      workSpeedRelevant: false
    },
    construction: {
      label: 'Construction',
      description: 'Raising walls, laying floors and repairing what the raiders broke. ' +
        'Speeds building work and lowers the chance of a botched job.',
      workSpeedRelevant: true
    },
    mining: {
      label: 'Mining',
      description: 'Cutting rock and pulling ore out of it. A good miner clears a mountain ' +
        'in a fraction of the time and loses less of the seam.',
      workSpeedRelevant: true
    },
    cooking: {
      label: 'Cooking',
      description: 'Turning raw ingredients into meals worth eating. Poor cooks work slowly ' +
        'and occasionally poison somebody.',
      workSpeedRelevant: true
    },
    plants: {
      label: 'Plants',
      description: 'Sowing, tending and harvesting crops, and cutting down trees. Sets both ' +
        'the speed of farm work and how much of a harvest survives it.',
      workSpeedRelevant: true
    },
    animals: {
      label: 'Animals',
      description: 'Taming, training and handling beasts. A skilled handler talks a wolf ' +
        'round; an unskilled one gets bitten for trying.',
      workSpeedRelevant: true
    },
    crafting: {
      label: 'Crafting',
      description: 'Making weapons, apparel, stone blocks and components at a bench. Drives ' +
        'both the speed and the quality of what comes off it.',
      workSpeedRelevant: true
    },
    artistic: {
      label: 'Artistic',
      description: 'Sculpture and decoration. Beautiful work makes a room worth sitting in, ' +
        'which is worth more mood than most things you can build.',
      workSpeedRelevant: true
    },
    medicine: {
      label: 'Medicine',
      description: 'Treating wounds, fighting infection and keeping the downed alive. The ' +
        'single most valuable skill the first time a raid goes badly.',
      workSpeedRelevant: true
    },
    social: {
      label: 'Social',
      description: 'Talking people round: trade prices, prisoner recruitment and smoothing ' +
        'over the arguments that come of living in one room.',
      workSpeedRelevant: false
    },
    intellectual: {
      label: 'Intellectual',
      description: 'Research. Everything the colony has not invented yet is waiting behind ' +
        'somebody willing to sit at a bench and think.',
      workSpeedRelevant: true
    }
  });

  /* ============================================================
     2. WORK TYPES

     Registration order IS the Work tab's column order - ui.js walks
     Defs.all('workType') left to right - so this table is also the
     priority order a colonist falls down when looking for something
     to do. `alwaysDoable` marks the three kinds of work that no
     backstory or trait may ever take away: a pawn who cannot be a
     patient is a pawn who bleeds out in a corridor.
     ============================================================ */

  Defs.add('workType', {
    firefight: {
      label: 'Firefight', verb: 'firefighting', order: 1,
      description: 'Put out fires, anywhere on the map, before they reach the stockpile.',
      skills: NO_SKILL_IDS, relevantSkillsLabel: 'None'
    },
    patient: {
      label: 'Patient', verb: 'being treated', order: 2,
      description: 'Go to a bed and hold still so a doctor can work.',
      skills: NO_SKILL_IDS, relevantSkillsLabel: 'None',
      alwaysDoable: true, requiresManipulation: false
    },
    doctor: {
      label: 'Doctor', verb: 'doctoring', order: 3,
      description: 'Tend wounds and disease, rescue the downed, feed patients who cannot feed themselves.',
      skills: ['medicine'], relevantSkillsLabel: 'Medicine'
    },
    bedRest: {
      label: 'Bed rest', verb: 'resting', order: 4,
      description: 'Stay in bed while injured or sick instead of limping back to work.',
      skills: NO_SKILL_IDS, relevantSkillsLabel: 'None',
      alwaysDoable: true, requiresManipulation: false
    },
    basic: {
      label: 'Basic', verb: 'doing basic work', order: 5,
      description: 'Refuel campfires and generators, flick switches, and the small errands ' +
        'that keep the place running.',
      skills: NO_SKILL_IDS, relevantSkillsLabel: 'None',
      alwaysDoable: true
    },
    warden: {
      label: 'Warden', verb: 'wardening', order: 6,
      description: 'Feed prisoners, talk them round, and carry the ones who try to walk out ' +
        'back to their bed.',
      skills: ['social'], relevantSkillsLabel: 'Social'
    },
    handle: {
      label: 'Handle', verb: 'handling animals', order: 7,
      description: 'Tame wild animals and train the tame ones.',
      skills: ['animals'], relevantSkillsLabel: 'Animals'
    },
    cook: {
      label: 'Cook', verb: 'cooking', order: 8,
      description: 'Cook meals and butcher carcasses at a stove or campfire.',
      skills: ['cooking'], relevantSkillsLabel: 'Cooking'
    },
    hunt: {
      label: 'Hunt', verb: 'hunting', order: 9,
      description: 'Kill animals marked for hunting and haul the corpses home.',
      skills: ['shooting'], relevantSkillsLabel: 'Shooting'
    },
    construct: {
      label: 'Construct', verb: 'constructing', order: 10,
      description: 'Deliver materials to blueprints, raise frames into buildings, and repair ' +
        'what is damaged.',
      skills: ['construction'], relevantSkillsLabel: 'Construction'
    },
    grow: {
      label: 'Grow', verb: 'growing', order: 11,
      description: 'Sow growing zones and harvest them when they ripen.',
      skills: ['plants'], relevantSkillsLabel: 'Plants'
    },
    mine: {
      label: 'Mine', verb: 'mining', order: 12,
      description: 'Cut through rock and ore wherever mining has been designated.',
      skills: ['mining'], relevantSkillsLabel: 'Mining'
    },
    plantCut: {
      label: 'Cut plants', verb: 'cutting plants', order: 13,
      description: 'Chop trees for wood and clear designated plants out of the way.',
      skills: ['plants'], relevantSkillsLabel: 'Plants'
    },
    craft: {
      label: 'Craft', verb: 'crafting', order: 14,
      description: 'Work the bills at a crafting bench, smithy, tailoring bench or stonecutter, ' +
        'and make art.',
      skills: ['crafting', 'artistic'], relevantSkillsLabel: 'Crafting, Artistic'
    },
    haul: {
      label: 'Haul', verb: 'hauling', order: 15,
      description: 'Carry loose items to a stockpile that will take them.',
      skills: NO_SKILL_IDS, relevantSkillsLabel: 'None'
    },
    clean: {
      label: 'Clean', verb: 'cleaning', order: 16,
      description: 'Scrub blood and filth out of rooms. Dirt is ugly, and ugly is mood.',
      skills: NO_SKILL_IDS, relevantSkillsLabel: 'None'
    },
    research: {
      label: 'Research', verb: 'researching', order: 17,
      description: 'Work the current research project at a research bench.',
      skills: ['intellectual'], relevantSkillsLabel: 'Intellectual'
    }
  }, {
    alwaysDoable: false,
    /* Almost all work needs hands; the two kinds that do not are the two
       a pawn with wrecked arms still has to be able to do. */
    requiresManipulation: true
  });

  /* ============================================================
     3. BODIES

     A flat list of parts with parent links, which is exactly what
     health.js flattens anyway. `coverage` is the chance of taking the
     hit when the parent is hit, `capacities` is how much of each
     capacity the part supplies, and a body's capacities must sum to
     1.0 across the whole body or nobody is ever at full strength.

     Two legs at 0.5 moving, two arms at 0.5 manipulation, one brain at
     1.0 consciousness. Hands and feet supply nothing of their own: a
     destroyed arm takes its hand with it (health.js kills the whole
     branch), so paying the limb out twice would double-count it.
     ============================================================ */

  function part(defName, label, parent, coverage, depth, maxHp, caps, flags) {
    flags = flags || '';
    return {
      defName: defName,
      label: label,
      parent: parent,
      coverage: coverage,
      depth: depth,
      maxHp: maxHp,
      hp: maxHp,
      capacities: caps || NO_CAPS,
      vital: flags.indexOf('v') >= 0,
      limb: flags.indexOf('l') >= 0
    };
  }

  var OUT = 'outside', IN = 'inside';

  Defs.add('body', {
    human: {
      label: 'human body',
      parts: [
        part('torso', 'torso', null, 0.36, OUT, 40, null, 'v'),
        part('neck', 'neck', 'torso', 0.05, OUT, 25, { talking: 0.25, eating: 0.25 }, 'v'),
        part('head', 'head', 'neck', 0.08, OUT, 25, null, 'v'),
        part('skull', 'skull', 'head', 0.80, IN, 25, null, ''),
        part('brain', 'brain', 'skull', 0.65, IN, 12, { consciousness: 1.0 }, 'v'),
        part('eyeLeft', 'left eye', 'head', 0.018, OUT, 8, { sight: 0.5 }, 'l'),
        part('eyeRight', 'right eye', 'head', 0.018, OUT, 8, { sight: 0.5 }, 'l'),
        part('earLeft', 'left ear', 'head', 0.020, OUT, 10, { hearing: 0.5 }, 'l'),
        part('earRight', 'right ear', 'head', 0.020, OUT, 10, { hearing: 0.5 }, 'l'),
        part('nose', 'nose', 'head', 0.020, OUT, 10, null, 'l'),
        part('jaw', 'jaw', 'head', 0.030, OUT, 18, { talking: 0.75, eating: 0.5 }, 'l'),
        part('ribcage', 'ribcage', 'torso', 0.35, IN, 30, null, ''),
        part('spine', 'spine', 'torso', 0.20, IN, 25, null, ''),
        part('heart', 'heart', 'torso', 0.20, IN, 15, { bloodPumping: 1.0 }, 'v'),
        part('lungLeft', 'left lung', 'torso', 0.25, IN, 15, { breathing: 0.5 }, ''),
        part('lungRight', 'right lung', 'torso', 0.25, IN, 15, { breathing: 0.5 }, ''),
        part('liver', 'liver', 'torso', 0.22, IN, 18, null, 'v'),
        part('kidneyLeft', 'left kidney', 'torso', 0.16, IN, 12, null, ''),
        part('kidneyRight', 'right kidney', 'torso', 0.16, IN, 12, null, ''),
        part('stomach', 'stomach', 'torso', 0.20, IN, 18, { eating: 0.25 }, ''),
        part('armLeft', 'left arm', 'torso', 0.07, OUT, 30, { manipulation: 0.5 }, 'l'),
        part('armRight', 'right arm', 'torso', 0.07, OUT, 30, { manipulation: 0.5 }, 'l'),
        part('handLeft', 'left hand', 'armLeft', 0.04, OUT, 20, null, 'l'),
        part('handRight', 'right hand', 'armRight', 0.04, OUT, 20, null, 'l'),
        part('legLeft', 'left leg', 'torso', 0.09, OUT, 30, { moving: 0.5 }, 'l'),
        part('legRight', 'right leg', 'torso', 0.09, OUT, 30, { moving: 0.5 }, 'l'),
        part('footLeft', 'left foot', 'legLeft', 0.04, OUT, 20, null, 'l'),
        part('footRight', 'right foot', 'legRight', 0.04, OUT, 20, null, 'l')
      ]
    },

    /* Four legs at a quarter each, and no hands at all: health.js treats
       a capacity no part supplies as unimpaired, so a muffalo is never
       penalised for being unable to hold a rifle. */
    quadruped: {
      label: 'quadruped body',
      parts: [
        part('torso', 'torso', null, 0.40, OUT, 40, null, 'v'),
        part('neck', 'neck', 'torso', 0.06, OUT, 22, { eating: 0.3 }, 'v'),
        part('head', 'head', 'neck', 0.09, OUT, 22, null, 'v'),
        part('skull', 'skull', 'head', 0.80, IN, 22, null, ''),
        part('brain', 'brain', 'skull', 0.65, IN, 10, { consciousness: 1.0 }, 'v'),
        part('eyeLeft', 'left eye', 'head', 0.02, OUT, 7, { sight: 0.5 }, 'l'),
        part('eyeRight', 'right eye', 'head', 0.02, OUT, 7, { sight: 0.5 }, 'l'),
        part('earLeft', 'left ear', 'head', 0.02, OUT, 8, { hearing: 0.5 }, 'l'),
        part('earRight', 'right ear', 'head', 0.02, OUT, 8, { hearing: 0.5 }, 'l'),
        part('jaw', 'jaw', 'head', 0.04, OUT, 16, { eating: 0.7 }, 'l'),
        part('ribcage', 'ribcage', 'torso', 0.30, IN, 26, null, ''),
        part('spine', 'spine', 'torso', 0.20, IN, 22, null, ''),
        part('heart', 'heart', 'torso', 0.20, IN, 14, { bloodPumping: 1.0 }, 'v'),
        part('lungLeft', 'left lung', 'torso', 0.24, IN, 14, { breathing: 0.5 }, ''),
        part('lungRight', 'right lung', 'torso', 0.24, IN, 14, { breathing: 0.5 }, ''),
        part('liver', 'liver', 'torso', 0.20, IN, 16, null, 'v'),
        part('kidneyLeft', 'left kidney', 'torso', 0.14, IN, 10, null, ''),
        part('kidneyRight', 'right kidney', 'torso', 0.14, IN, 10, null, ''),
        part('stomach', 'stomach', 'torso', 0.20, IN, 16, null, ''),
        part('legFrontLeft', 'front left leg', 'torso', 0.08, OUT, 24, { moving: 0.25 }, 'l'),
        part('legFrontRight', 'front right leg', 'torso', 0.08, OUT, 24, { moving: 0.25 }, 'l'),
        part('legRearLeft', 'rear left leg', 'torso', 0.08, OUT, 24, { moving: 0.25 }, 'l'),
        part('legRearRight', 'rear right leg', 'torso', 0.08, OUT, 24, { moving: 0.25 }, 'l'),
        part('tail', 'tail', 'torso', 0.03, OUT, 12, null, 'l')
      ]
    },

    /* Nothing in the shipped pawnKind table is feathered, but the body
       registry names `bird` and health.js caches by body id, so a
       feathered kind can be added later without touching health.js. */
    bird: {
      label: 'bird body',
      parts: [
        part('torso', 'torso', null, 0.42, OUT, 22, null, 'v'),
        part('neck', 'neck', 'torso', 0.07, OUT, 12, { eating: 0.3 }, 'v'),
        part('head', 'head', 'neck', 0.10, OUT, 12, null, 'v'),
        part('skull', 'skull', 'head', 0.80, IN, 12, null, ''),
        part('brain', 'brain', 'skull', 0.65, IN, 6, { consciousness: 1.0 }, 'v'),
        part('eyeLeft', 'left eye', 'head', 0.03, OUT, 4, { sight: 0.5 }, 'l'),
        part('eyeRight', 'right eye', 'head', 0.03, OUT, 4, { sight: 0.5 }, 'l'),
        part('beak', 'beak', 'head', 0.05, OUT, 8, { eating: 0.7 }, 'l'),
        part('heart', 'heart', 'torso', 0.20, IN, 8, { bloodPumping: 1.0 }, 'v'),
        part('lungLeft', 'left lung', 'torso', 0.22, IN, 8, { breathing: 0.5 }, ''),
        part('lungRight', 'right lung', 'torso', 0.22, IN, 8, { breathing: 0.5 }, ''),
        part('liver', 'liver', 'torso', 0.18, IN, 8, null, 'v'),
        part('stomach', 'stomach', 'torso', 0.16, IN, 8, null, ''),
        part('wingLeft', 'left wing', 'torso', 0.10, OUT, 14, { moving: 0.2 }, 'l'),
        part('wingRight', 'right wing', 'torso', 0.10, OUT, 14, { moving: 0.2 }, 'l'),
        part('legLeft', 'left leg', 'torso', 0.06, OUT, 10, { moving: 0.3 }, 'l'),
        part('legRight', 'right leg', 'torso', 0.06, OUT, 10, { moving: 0.3 }, 'l')
      ]
    }
  });

  /* ============================================================
     4. TRAITS

     Two or three per generated human, never two out of the same
     `exclusionGroup` - a pawn cannot be both industrious and lazy,
     and nobody is a kind psychopath.

     `commonality` is the pick weight. `moodOffset` is a flat mood
     change in mood points and is counted by needs.js for every trait
     except optimist and pessimist, which are paid out through the
     naturalMood thoughts instead so they get their own line in the
     mood breakdown.
     ============================================================ */

  Defs.add('trait', {
    optimist: {
      label: 'Optimist', commonality: 1.0, exclusionGroup: 'nature',
      description: 'Sees the bright side of a crash landing. Carries a permanent lift in mood ' +
        'that no amount of bad news quite flattens.',
      moodOffset: 12
    },
    pessimist: {
      label: 'Pessimist', commonality: 1.0, exclusionGroup: 'nature',
      description: 'Expects the worst, and is usually right, which is no comfort at all. ' +
        'Carries a permanent weight on the mood.',
      moodOffset: -12
    },
    neurotic: {
      label: 'Neurotic', commonality: 1.0, exclusionGroup: 'nerves',
      description: 'Works fast because standing still is unbearable, and breaks down sooner ' +
        'than anyone else when the mood turns.',
      workSpeedFactor: 1.08, mentalBreakThresholdOffset: 0.04
    },
    ironWilled: {
      label: 'Iron-willed', commonality: 0.8, exclusionGroup: 'nerves',
      description: 'Endures. Takes a great deal more misery than most before losing control ' +
        'of it.',
      mentalBreakThresholdOffset: -0.06
    },
    volatile: {
      label: 'Volatile', commonality: 0.7, exclusionGroup: 'nerves',
      description: 'A short fuse in a long crisis. Snaps at a level of stress others would ' +
        'walk off.',
      mentalBreakThresholdOffset: 0.06
    },
    psychopath: {
      label: 'Psychopath', commonality: 0.3, exclusionGroup: 'temperament',
      description: 'Feels nothing at a funeral and nothing at a corpse. Unbothered by death, ' +
        'unbothered by anything, and poor company.',
      skillGains: { social: -2 }, mentalBreakThresholdOffset: -0.03
    },
    bloodlust: {
      label: 'Bloodlust', commonality: 0.4,
      description: 'Enjoys killing, and cheers up for days after doing it. Will not run from ' +
        'a fight worth having.',
      forbidsFlee: true
    },
    kind: {
      label: 'Kind', commonality: 0.7, exclusionGroup: 'temperament',
      description: 'Says the decent thing without having to think about it, and people ' +
        'listen. Good with prisoners and good with traders.',
      skillGains: { social: 3 }
    },
    abrasive: {
      label: 'Abrasive', commonality: 0.7, exclusionGroup: 'temperament',
      description: 'Rubs everyone the wrong way. Every conversation is a small argument ' +
        'waiting to start.',
      skillGains: { social: -3 }
    },
    industrious: {
      label: 'Industrious', commonality: 0.6, exclusionGroup: 'drive',
      description: 'Cannot sit still while there is work on the board, and gets through it ' +
        'faster than anyone.',
      workSpeedFactor: 1.35
    },
    lazy: {
      label: 'Lazy', commonality: 0.8, exclusionGroup: 'drive',
      description: 'Does the job, eventually, at a pace that suggests the job could have ' +
        'waited.',
      workSpeedFactor: 0.80
    },
    slothful: {
      label: 'Slothful', commonality: 0.4, exclusionGroup: 'drive',
      description: 'Moves through a day of work the way most people move through deep water.',
      workSpeedFactor: 0.50
    },
    nightOwl: {
      label: 'Night owl', commonality: 0.6,
      description: 'Wide awake long after dark and useless before noon. Tires slowly at ' +
        'night and quickly in the morning.',
      /* The swing lives in needs.js, which reads the clock: the number
         here is the day-average, so the field stays honest. */
      restFallFactor: 1.0, invertedSchedule: true
    },
    jogger: {
      label: 'Jogger', commonality: 0.6, exclusionGroup: 'speed',
      description: 'Moves at a trot as a matter of habit. Worth about four tenths of a tile ' +
        'a second, every second of the colony.',
      moveSpeedFactor: 1.087, moveSpeedOffset: 0.4
    },
    slowpoke: {
      label: 'Slowpoke', commonality: 0.6, exclusionGroup: 'speed',
      description: 'Ambles. Across a hundred-tile map that adds up to an hour of daylight ' +
        'a day.',
      moveSpeedFactor: 0.90, moveSpeedOffset: -0.45
    },
    tough: {
      label: 'Tough', commonality: 0.5, exclusionGroup: 'body',
      description: 'Built out of something harder than the rest of us. Takes half the damage ' +
        'from a hit that would put anyone else on the floor.',
      damageFactor: 0.5, painFactor: 0.9, meleeFactor: 1.10
    },
    wimp: {
      label: 'Wimp', commonality: 0.6, exclusionGroup: 'body',
      description: 'Feels everything twice as much as it deserves to be felt, and goes down ' +
        'from wounds others would work through.',
      painFactor: 2.0, meleeFactor: 0.85
    },
    carefulShooter: {
      label: 'Careful shooter', commonality: 0.5, exclusionGroup: 'combatStyle',
      description: 'Takes the extra beat to line the shot up, and lands it. Aims slowly, ' +
        'misses rarely.',
      shootingFactor: 1.30
    },
    triggerHappy: {
      label: 'Trigger-happy', commonality: 0.5, exclusionGroup: 'combatStyle',
      description: 'Fires first and squints afterwards. A great deal of noise, a great deal ' +
        'of lead, not much of it on target.',
      shootingFactor: 0.78
    },
    brawler: {
      label: 'Brawler', commonality: 0.4, exclusionGroup: 'combatStyle',
      description: 'Wants to be close enough to hit something. Deadly in a corridor and ' +
        'nearly useless with a rifle.',
      meleeFactor: 1.25, shootingFactor: 0.55, forbidsFlee: true
    },
    pyromaniac: {
      label: 'Pyromaniac', commonality: 0.25,
      description: 'Loves fire, cannot be trusted near it, and will not put one out. When ' +
        'this one breaks down, something burns.',
      disabledWork: ['firefight'], startsFires: true, mentalBreakThresholdOffset: 0.02
    },
    greenThumb: {
      label: 'Green thumb', commonality: 0.5,
      description: 'Plants grow for this one. Sows, tends and harvests markedly faster than ' +
        'anybody who merely knows how.',
      skillGains: { plants: 2 }, plantWorkFactor: 1.30
    },
    gourmand: {
      label: 'Gourmand', commonality: 0.5, exclusionGroup: 'appetite',
      description: 'Eats more, eats often, and raids the larder outright when unhappy.',
      hungerFactor: 1.25, skillGains: { cooking: 2 }, bingeEater: true
    },
    ascetic: {
      label: 'Ascetic', commonality: 0.4, exclusionGroup: 'appetite',
      description: 'Wants a bare room, a hard bed and a plain meal, and is untroubled by ' +
        'ugly surroundings that would depress anyone else.',
      hungerFactor: 0.85
    },
    toosmart: {
      label: 'Too smart', commonality: 0.35,
      description: 'Learns everything at a frightening rate and thinks about it far too much ' +
        'afterwards.',
      learnFactor: 1.40, mentalBreakThresholdOffset: 0.02, skillGains: { intellectual: 2 }
    },
    bodyPurist: {
      label: 'Body purist', commonality: 0.45,
      description: 'Holds that a body should stay the body it was born as. Nothing in this ' +
        'colony is asking otherwise, and there is a quiet satisfaction in that.',
      moodOffset: 2
    },
    nimble: {
      label: 'Nimble', commonality: 0.35,
      description: 'Hard to hit and quick on the feet. Slips blows that land squarely on ' +
        'everybody else.',
      moveSpeedFactor: 1.05, meleeFactor: 1.10
    },
    greatMemory: {
      label: 'Great memory', commonality: 0.4,
      description: 'Forgets nothing. Skills learned here stay learned, and new ones stick ' +
        'faster than usual.',
      learnFactor: 1.15, noSkillDecay: true
    }
  }, {
    moodOffset: 0,
    skillGains: NO_SKILLS,
    disabledWork: NO_WORK,
    moveSpeedFactor: 1,
    workSpeedFactor: 1,
    mentalBreakThresholdOffset: 0,
    meleeFactor: 1,
    shootingFactor: 1,
    painFactor: 1,
    damageFactor: 1,
    hungerFactor: 1,
    restFallFactor: 1,
    learnFactor: 1,
    /* No trait in this set forbids recreation, but think.js reads the
       field rather than a list of ids, so a trait that does only has to
       say so here. */
    canDoJoy: true,
    forbidsFlee: false,
    commonality: 1.0
  });

  /* ============================================================
     5. BACKSTORIES

     Two per adult pawn, one childhood and one adulthood; a pawn under
     eighteen has no adulthood at all. Skill gains are added before the
     random spread, so a backstory is the difference between a colonist
     who can cook and a colonist who sets fire to rice.

     Disabled work is kept sparse and never touches firefighting,
     patient, bed rest or basic work: mapgen has to be able to build a
     playable starting three out of this table.
     ============================================================ */

  Defs.add('backstory', {
    /* ---------- childhood ---------- */
    childFarmer: {
      label: 'Farm kid', title: 'farmer', slot: 'childhood', commonality: 1.2,
      description: 'Grew up between the irrigation ditch and the seed shed, and could tell ' +
        'a ripe field from a doomed one before learning to read.',
      skillGains: { plants: 4, animals: 2, construction: 1 }
    },
    childUrchin: {
      label: 'Urchin', title: 'urchin', slot: 'childhood', commonality: 1.0,
      description: 'Raised by a market street. Learned to carry, to run, and to be somewhere ' +
        'else when the questions started.',
      skillGains: { social: 3, melee: 2, crafting: 1 }
    },
    childNobleBrat: {
      label: 'Noble brat', title: 'noble', slot: 'childhood', commonality: 0.5,
      description: 'Tutors, tailored coats and a household staff to carry things. Has never ' +
        'picked up a crate and does not intend to start.',
      skillGains: { social: 5, artistic: 3, intellectual: 2 },
      disabledWork: ['haul', 'clean']
    },
    childVatGrown: {
      label: 'Vat-grown', title: 'vatling', slot: 'childhood', commonality: 0.4,
      description: 'Decanted fully grown with a head full of downloaded competence and no ' +
        'memory of a single day of it.',
      skillGains: { intellectual: 4, shooting: 2, medicine: 1 },
      disabledWork: ['warden']
    },
    childMedicApprentice: {
      label: "Medic's apprentice", title: 'apprentice', slot: 'childhood', commonality: 0.7,
      description: 'Held the lamp, fetched the water and watched a field surgeon work, year ' +
        'after year, until the sight of blood stopped meaning anything.',
      skillGains: { medicine: 5, intellectual: 2 }
    },
    childScavenger: {
      label: 'Scavenger', title: 'scavenger', slot: 'childhood', commonality: 0.9,
      description: 'Picked wrecks apart for anything that could be sold, repaired or eaten. ' +
        'Knows the value of everything on the ground.',
      skillGains: { crafting: 3, construction: 2, mining: 2 }
    },
    childTribalHunter: {
      label: 'Tribal hunter', title: 'hunter', slot: 'childhood', commonality: 0.8,
      description: 'Learned to move quietly behind the adults of the band, and to put an ' +
        'arrow where it would do the most good.',
      skillGains: { shooting: 4, animals: 3, plants: 2, melee: 2 },
      disabledWork: ['research']
    },
    childBookworm: {
      label: 'Bookworm', title: 'bookworm', slot: 'childhood', commonality: 0.8,
      description: 'Spent a childhood indoors with a stack of texts nobody else in the ' +
        'settlement had read.',
      skillGains: { intellectual: 5, artistic: 2, medicine: 1 }
    },
    childMinerKid: {
      label: 'Mine kid', title: 'mine kid', slot: 'childhood', commonality: 0.9,
      description: 'Ran tools down the shaft for the day crews. Learned rock by sound long ' +
        'before learning it by name.',
      skillGains: { mining: 5, construction: 2 }
    },
    childColonyBorn: {
      label: 'Colony born', title: 'colonist', slot: 'childhood', commonality: 1.0,
      description: 'Born on a rimworld to people who had chosen it. Grew up doing a little ' +
        'of everything, because everything needed doing.',
      skillGains: { construction: 2, plants: 2, cooking: 2, crafting: 1, social: 1 }
    },

    /* ---------- adulthood ---------- */
    adultMedic: {
      label: 'Field medic', title: 'medic', slot: 'adulthood', commonality: 1.0,
      description: 'Kept people alive in places where keeping people alive was not expected. ' +
        'Steady hands, short temper about wasted medicine.',
      skillGains: { medicine: 6, intellectual: 2, social: 1 }
    },
    adultSoldier: {
      label: 'Soldier', title: 'soldier', slot: 'adulthood', commonality: 1.0,
      description: 'Carried a rifle for somebody else\'s flag long enough to stop asking ' +
        'whose it was.',
      skillGains: { shooting: 6, melee: 3, construction: 1 }
    },
    adultMiner: {
      label: 'Miner', title: 'miner', slot: 'adulthood', commonality: 1.0,
      description: 'Years underground, swinging at a face of rock for somebody else\'s ' +
        'quota. Can read a seam at a glance.',
      skillGains: { mining: 6, construction: 3 }
    },
    adultCook: {
      label: 'Cook', title: 'cook', slot: 'adulthood', commonality: 0.9,
      description: 'Fed a crew of forty out of a galley the size of a cupboard, and nobody ' +
        'ever got sick on it.',
      skillGains: { cooking: 6, plants: 2, social: 1 }
    },
    adultEngineer: {
      label: 'Engineer', title: 'engineer', slot: 'adulthood', commonality: 0.9,
      description: 'Kept the power up and the machines running on a station where either ' +
        'failing would have killed everyone aboard.',
      skillGains: { construction: 4, crafting: 4, intellectual: 3 }
    },
    adultFarmer: {
      label: 'Farmer', title: 'farmer', slot: 'adulthood', commonality: 1.1,
      description: 'Worked a smallholding through good seasons and bad, and learned that the ' +
        'bad ones are the ones that teach you anything.',
      skillGains: { plants: 6, animals: 3, cooking: 1 }
    },
    adultArtist: {
      label: 'Artist', title: 'artist', slot: 'adulthood', commonality: 0.6,
      description: 'Made beautiful things for patrons who never looked at them, and will not ' +
        'raise a weapon against a living creature.',
      skillGains: { artistic: 7, crafting: 3, social: 1 },
      disabledWork: ['hunt']
    },
    adultTrader: {
      label: 'Trader', title: 'trader', slot: 'adulthood', commonality: 0.8,
      description: 'Ran goods between settlements that all thought they were getting the ' +
        'better end of it. Some of them were.',
      skillGains: { social: 6, intellectual: 2, animals: 2 },
      disabledWork: ['mine']
    },
    adultScientist: {
      label: 'Scientist', title: 'scientist', slot: 'adulthood', commonality: 0.8,
      description: 'Spent a career on one narrow question, and would still be on it if the ' +
        'funding had held.',
      skillGains: { intellectual: 7, medicine: 3 },
      disabledWork: ['hunt']
    },
    adultDrifter: {
      label: 'Drifter', title: 'drifter', slot: 'adulthood', commonality: 1.1,
      description: 'Went from world to world doing whatever the next place paid for. Good at ' +
        'a great many things and expert in none.',
      skillGains: { melee: 2, construction: 2, plants: 2, crafting: 2, social: 2, cooking: 1 }
    },
    adultHunter: {
      label: 'Hunter', title: 'hunter', slot: 'adulthood', commonality: 0.9,
      description: 'Fed a settlement off what walked past it. Patient, quiet, and entirely ' +
        'unsentimental about animals.',
      skillGains: { shooting: 5, animals: 4, plants: 2, cooking: 1 }
    },
    adultBuilder: {
      label: 'Builder', title: 'builder', slot: 'adulthood', commonality: 1.0,
      description: 'Put up housing on half a dozen frontier worlds, most of which is still ' +
        'standing.',
      skillGains: { construction: 6, mining: 2, crafting: 2 }
    }
  }, {
    skillGains: NO_SKILLS,
    disabledWork: NO_WORK,
    commonality: 1.0
  });

  /* ============================================================
     6. THOUGHTS

     Mood is in mood points: -3 is "minus three mood" on the pawn's
     0..100 bar. Every thought carries `stages`, even when it only has
     one, so needs.js reads them all the same way.

     `durationDays` is how long a memory lasts; situational thoughts
     (hunger, pain, the room) are recomputed every rare tick and their
     duration only matters if the pawn dies holding one.
     ============================================================ */

  Defs.add('thought', {
    hungry: {
      label: 'Hungry', isNeedBased: true, durationDays: 0.3,
      stages: [
        { label: 'Hungry', mood: -6 },
        { label: 'Urgently hungry', mood: -12 }
      ]
    },
    starving: {
      label: 'Starving', isNeedBased: true, durationDays: 0.3,
      stages: [{ label: 'Starving', mood: -20 }]
    },
    ateRawFood: {
      label: 'Ate raw food', durationDays: 1,
      stages: [{ label: 'Ate raw food', mood: -5 }]
    },
    ateFineMeal: {
      label: 'Ate a fine meal', durationDays: 1,
      stages: [{ label: 'Ate a fine meal', mood: 5 }]
    },
    ateWithoutTable: {
      label: 'Ate without a table', durationDays: 0.5,
      stages: [{ label: 'Ate without a table', mood: -3 }],
      nullifiedByTrait: ['ascetic']
    },
    ateInImpressiveRoom: {
      label: 'Ate in an impressive room', durationDays: 1,
      stages: [
        { label: 'Ate in a decent dining room', mood: 2 },
        { label: 'Ate in a fine dining room', mood: 4 },
        { label: 'Ate in an impressive dining room', mood: 6 }
      ],
      nullifiedByTrait: ['ascetic']
    },
    sleptOutside: {
      label: 'Slept outside', durationDays: 0.6,
      stages: [{ label: 'Slept outside', mood: -4 }]
    },
    sleptOnGround: {
      label: 'Slept on the ground', durationDays: 0.6,
      stages: [{ label: 'Slept on the ground', mood: -3 }],
      nullifiedByTrait: ['ascetic']
    },
    sleptInBarracks: {
      label: 'Slept in a barracks', durationDays: 0.6,
      stages: [{ label: 'Slept in a barracks', mood: -3 }],
      nullifiedByTrait: ['ascetic']
    },
    sleptInBedroom: {
      label: 'Slept in own bedroom', durationDays: 0.6,
      stages: [{ label: 'Slept in own bedroom', mood: 3 }],
      nullifiedByTrait: ['ascetic']
    },
    coldRoom: {
      label: 'Cold', durationDays: 0.3,
      stages: [
        { label: 'A bit chilly', mood: -4 },
        { label: 'Cold', mood: -7 },
        { label: 'Freezing', mood: -11 }
      ]
    },
    hotRoom: {
      label: 'Hot', durationDays: 0.3,
      stages: [
        { label: 'A bit warm', mood: -4 },
        { label: 'Hot', mood: -7 },
        { label: 'Sweltering', mood: -11 }
      ]
    },
    darkness: {
      label: 'In the dark', durationDays: 0.3,
      stages: [{ label: 'In the dark', mood: -4 }]
    },
    uglyRoom: {
      label: 'Ugly surroundings', durationDays: 0.3,
      stages: [
        { label: 'Ugly surroundings', mood: -3 },
        { label: 'Very ugly surroundings', mood: -5 },
        { label: 'Hideous surroundings', mood: -8 }
      ],
      nullifiedByTrait: ['ascetic']
    },
    prettyRoom: {
      label: 'Pretty surroundings', durationDays: 0.3,
      stages: [
        { label: 'Pretty surroundings', mood: 5 },
        { label: 'Beautiful surroundings', mood: 8 },
        { label: 'Stunning surroundings', mood: 12 }
      ],
      nullifiedByTrait: ['ascetic']
    },
    colonistDied: {
      label: 'A colonist died', durationDays: 12, stackLimit: 5,
      stages: [{ label: 'A colonist died', mood: -6 }],
      nullifiedByTrait: ['psychopath']
    },
    colonistLost: {
      label: 'A colonist left us', durationDays: 8, stackLimit: 3,
      stages: [{ label: 'A colonist left us', mood: -4 }],
      nullifiedByTrait: ['psychopath']
    },
    observedCorpse: {
      label: 'Saw a corpse', durationDays: 0.6, stackLimit: 3,
      stages: [{ label: 'Observed a corpse', mood: -4 }],
      nullifiedByTrait: ['psychopath', 'bloodlust']
    },
    pain: {
      label: 'Pain', durationDays: 0.3,
      stages: [
        { label: 'Minor pain', mood: -3 },
        { label: 'Pain', mood: -6 },
        { label: 'Severe pain', mood: -9 },
        { label: 'Agony', mood: -12 }
      ]
    },
    sick: {
      label: 'Sick', durationDays: 0.3,
      stages: [
        { label: 'Feeling sick', mood: -5 },
        { label: 'Ill', mood: -10 },
        { label: 'Gravely ill', mood: -18 }
      ]
    },
    tendedWound: {
      label: 'Wounds tended', durationDays: 1, stackLimit: 3,
      stages: [{ label: 'My wounds were tended', mood: 3 }]
    },
    rescued: {
      label: 'Rescued by a colonist', durationDays: 8,
      stages: [{ label: 'Somebody carried me to safety', mood: 10 }]
    },
    recruitedColonist: {
      label: 'We recruited someone', durationDays: 5,
      stages: [{ label: 'We recruited someone', mood: 8 }]
    },
    newColonistJoined: {
      label: 'A new colonist joined', durationDays: 3,
      stages: [{ label: 'A new colonist joined us', mood: 6 }]
    },
    raidBeaten: {
      label: 'We beat off a raid', durationDays: 3,
      stages: [{ label: 'We beat off a raid', mood: 10 }]
    },
    catharsis: {
      label: 'Catharsis', durationDays: 2,
      stages: [{ label: 'Catharsis', mood: 10 }]
    },
    insulted: {
      label: 'Insulted me', durationDays: 2, stackLimit: 3, isSocial: true,
      stages: [{ label: 'Insulted me', mood: -6 }],
      nullifiedByTrait: ['psychopath']
    },
    chatted: {
      label: 'Chatted with a friend', durationDays: 0.6, stackLimit: 3, isSocial: true,
      stages: [{ label: 'Chatted with a friend', mood: 2 }],
      nullifiedByTrait: ['psychopath']
    },
    killedHumanBloodlust: {
      label: 'I killed someone', durationDays: 2, stackLimit: 3,
      stages: [{ label: 'I killed someone', mood: 10 }]
    },
    witnessedDeathAlly: {
      label: 'Witnessed an ally die', durationDays: 5, stackLimit: 3,
      stages: [{ label: 'Witnessed an ally die', mood: -10 }],
      nullifiedByTrait: ['psychopath']
    },
    naturalMoodBuff: {
      label: 'Natural optimism', durationDays: 1,
      stages: [{ label: 'Natural optimism', mood: 12 }]
    },
    naturalMoodDebuff: {
      label: 'Natural pessimism', durationDays: 1,
      stages: [{ label: 'Natural pessimism', mood: -12 }]
    },
    hadNiceMeal: {
      label: 'Had a nice meal', durationDays: 1,
      stages: [{ label: 'Had a nice meal', mood: 3 }],
      nullifiedByTrait: ['ascetic']
    },
    comfortableBed: {
      label: 'Comfortable bed', durationDays: 0.3,
      stages: [
        { label: 'Comfortable bed', mood: 2 },
        { label: 'Very comfortable bed', mood: 4 }
      ],
      nullifiedByTrait: ['ascetic']
    },
    soakingWet: {
      label: 'Soaking wet', durationDays: 0.25,
      stages: [{ label: 'Soaking wet', mood: -6 }]
    },
    ateKibble: {
      label: 'Ate kibble', durationDays: 1,
      stages: [{ label: 'Ate kibble', mood: -5 }]
    }
  }, {
    durationDays: 1,
    stackLimit: 1,
    /* Second and later copies of the same memory count for three
       quarters: the fourth funeral hurts less than the first. Both
       names carry the value because the brief calls it one thing and
       needs.js reads the other. */
    stackedMoodEffect: 0.75,
    stackedMoodFactor: 0.75,
    isNeedBased: false,
    isSocial: false,
    nullifiedByTrait: NO_TRAITS
  });

  /* ============================================================
     7. MENTAL STATES

     What a colonist does when the mood runs out. Durations are in
     ticks (60000 = one day), and every one of them ends with the
     catharsis thought so that a breakdown is followed by a couple of
     days of relief rather than straight back to the edge.

     `jobId` names the job think.js starts to act the state out; the
     behaviour itself lives with the job in jobs.js and combat.js.
     ============================================================ */

  Defs.add('mentalState', {
    sadWander: {
      label: 'Sad wandering', breakLevel: 'minor', jobId: 'mentalWander',
      description: 'Walks away from the work and does not come back for a while. Harmless, ' +
        'and a warning.',
      durationTicks: [6000, 15000]
    },
    tantrum: {
      label: 'Tantrum', breakLevel: 'minor', jobId: 'mentalTantrum', isAggressive: true,
      description: 'Smashes furniture and walls until the anger runs out. Expensive, but ' +
        'nobody gets hurt.',
      durationTicks: [4000, 9000]
    },
    berserk: {
      label: 'Berserk', breakLevel: 'major', jobId: 'mentalBerserk', isAggressive: true,
      description: 'Attacks whoever is nearest, colonist or not, until put down or talked ' +
        'out of it by exhaustion.',
      durationTicks: [3000, 7000]
    },
    foodBinge: {
      label: 'Food binge', breakLevel: 'minor', jobId: 'mentalBinge', canBeVoluntary: true,
      description: 'Eats through the larder without stopping. A gourmand may start one ' +
        'without being especially unhappy.',
      durationTicks: [5000, 12000]
    },
    daze: {
      label: 'Confused daze', breakLevel: 'major', jobId: 'mentalDaze',
      description: 'Stops registering the colony at all and shuffles in small circles, ' +
        'hungry and unreachable.',
      durationTicks: [8000, 20000]
    },
    panicFlee: {
      label: 'Panic flight', breakLevel: 'minor', jobId: 'flee', canBeVoluntary: true,
      description: 'Runs from the fight, away from whatever is frightening, and keeps ' +
        'running well past the point of safety.',
      durationTicks: [2500, 6000]
    },
    runWild: {
      label: 'Running wild', breakLevel: 'major', jobId: 'wander',
      description: 'A tame animal remembers it was never asked. Ignores its handler and ' +
        'heads for the map edge.',
      durationTicks: [10000, 25000]
    }
  }, {
    thought: 'catharsis',
    blocksWork: true,
    isAggressive: false,
    canBeVoluntary: false,
    breakLevel: 'minor'
  });

  /* ============================================================
     8. PAWN KINDS - people

     `combatPower` is the currency the storyteller spends: a hundred
     points buys one colonist-grade fighter, so a 400 point raid is
     four of them or six tribals. Move speed is in tiles per second
     against the balance table's 4.6 for a healthy human.
     ============================================================ */

  Defs.add('pawnKind', {
    colonist: {
      label: 'colonist', description: 'One of yours.',
      combatPower: 100, defaultFaction: 'player',
      /* Colonists are dressed and armed by mapgen out of the starting
         stock, so the kind itself carries only the clothes. */
      weapons: NO_THINGS, apparel: ['shirt', 'pants'],
      color: '#4a7fd4'
    },
    raider: {
      label: 'raider', description: 'An armed stranger with designs on your stockpile.',
      combatPower: 100, defaultFaction: 'raider',
      weapons: ['knife', 'club', 'spear', 'shortBow', 'pistol', 'shotgun',
                'boltRifle', 'autoRifle', 'sniperRifle'],
      apparel: ['shirt', 'pants', 'jacket'],
      color: '#c0392b', meleeSkill: 6
    },
    tribalRaider: {
      label: 'tribal warrior', description: 'Neolithic, numerous, and dangerous in a crowd.',
      combatPower: 75, defaultFaction: 'raider', techLevel: 'neolithic',
      weapons: ['club', 'spear', 'shortBow', 'knife'],
      apparel: ['shirt', 'pants'],
      color: '#9a6b3f', meleeSkill: 7, ageRange: [17, 55]
    },
    wanderer: {
      label: 'wanderer', description: 'A traveller between settlements, armed enough to survive one.',
      combatPower: 60, defaultFaction: 'neutral',
      weapons: ['knife', 'pistol'], apparel: ['shirt', 'pants', 'jacket'],
      color: '#8a7f6a'
    }
  }, {
    race: 'human',
    isAnimal: false,
    body: 'human',
    sprite: 'human',
    baseHealthScale: 1,
    healthScale: 1,
    moveSpeed: 4.6,
    moveSpeedFactor: 1,
    baseBodySize: 1,
    bodySize: 1,
    drawSize: 1,
    baseHungerRate: 1.6,
    hungerRateFactor: 1,
    lifeExpectancyYears: 80,
    ageRange: [19, 58],
    techLevel: 'industrial',
    /* Bare hands, for a pawn who has dropped or never had a weapon.
       combat.js prefers whatever is actually in hand. */
    meleeDamage: 6,
    meleeDamageType: 'blunt',
    meleeCooldownTicks: 120,
    meleeArmorPen: 0,
    meleeSkill: 4,
    comfyTempMin: -12,
    comfyTempMax: 38,
    armorSharp: 0, armorBlunt: 0, armorHeat: 0,
    trainability: null,
    wildness: 0,
    packAnimal: false,
    predator: false,
    grazer: false,
    nocturnal: false,
    breeds: false,
    diet: 'omnivore',
    butcherProducts: null,
    leatherAmount: 0,
    manhunterChance: 0,
    revengeChance: 0,
    manhunterOnTameFail: 0,
    explodeOnDeath: false,
    explodes: false,
    nuzzles: false,
    color2: '#d8cfc0'
  });

  /* ============================================================
     9. PAWN KINDS - animals

     Body size drives health, meat, leather and how easily a predator
     picks a fight; wildness drives how hard the thing is to tame.
     `butcherProducts` is stated outright rather than left to scale off
     body size, because these six numbers are what makes hunting a deer
     worth the walk and a hare not.
     ============================================================ */

  Defs.add('pawnKind', {
    hare: {
      label: 'hare', description: 'A fast, nervous herbivore. Two of them are barely a meal.',
      combatPower: 15,
      baseHealthScale: 0.4, healthScale: 0.4,
      baseBodySize: 0.3, bodySize: 0.3, drawSize: 0.8,
      moveSpeed: 5.6, baseHungerRate: 1.1, hungerRateFactor: 0.7,
      lifeExpectancyYears: 6, ageRange: [0.3, 5],
      wildness: 0.35, trainability: 'none', packSize: [1, 3],
      meleeDamage: 4, meleeCooldownTicks: 130,
      butcherProducts: { meatRaw: 18, leather: 10 }, leatherAmount: 10,
      color: '#b08c5a', color2: '#e6ddc8', sprite: 'hare',
      comfyTempMin: -20, comfyTempMax: 40,
      nuzzles: true, breeds: true
    },
    deer: {
      label: 'deer', description: 'Fast and skittish. Bolts at the first arrow and is worth ' +
        'chasing anyway.',
      combatPower: 40,
      baseHealthScale: 1.0, healthScale: 1.0,
      baseBodySize: 0.75, bodySize: 0.75, drawSize: 1.3,
      moveSpeed: 5.8, baseHungerRate: 1.6, hungerRateFactor: 1.0,
      lifeExpectancyYears: 10, ageRange: [0.5, 9],
      wildness: 0.70, trainability: 'none', packSize: [2, 5],
      meleeDamage: 7, meleeCooldownTicks: 120,
      butcherProducts: { meatRaw: 55, leather: 30 }, leatherAmount: 30,
      color: '#8a6134', color2: '#d8cfc0', sprite: 'deer',
      comfyTempMin: -25, comfyTempMax: 40,
      revengeChance: 0.02, manhunterOnTameFail: 0.01, breeds: true
    },
    muffalo: {
      label: 'muffalo', description: 'A shaggy pack beast the size of a shed. Slow, patient, ' +
        'and fully capable of flattening whoever annoys it.',
      combatPower: 160,
      baseHealthScale: 1.9, healthScale: 1.9,
      baseBodySize: 2.1, bodySize: 2.1, drawSize: 1.9,
      moveSpeed: 3.4, baseHungerRate: 2.2, hungerRateFactor: 1.4,
      lifeExpectancyYears: 20, ageRange: [1, 18],
      wildness: 0.75, trainability: 'intermediate', packAnimal: true, packSize: [3, 6],
      meleeDamage: 12, meleeCooldownTicks: 140, meleeSkill: 4,
      butcherProducts: { meatRaw: 140, leather: 60 }, leatherAmount: 60,
      color: '#4a3b2c', color2: '#6b5638', sprite: 'muffalo',
      comfyTempMin: -40, comfyTempMax: 34,
      revengeChance: 0.04, manhunterOnTameFail: 0.02, manhunterChance: 0.02, breeds: true
    },
    boomrat: {
      label: 'boomrat', description: 'A rodent that detonates when it dies. Perfectly ' +
        'harmless right up until somebody shoots one next to the wood store.',
      combatPower: 25,
      baseHealthScale: 0.5, healthScale: 0.5,
      baseBodySize: 0.4, bodySize: 0.4, drawSize: 0.75,
      moveSpeed: 4.4, baseHungerRate: 1.2, hungerRateFactor: 0.75,
      lifeExpectancyYears: 8, ageRange: [0.3, 6],
      wildness: 0.50, trainability: 'intermediate', packSize: [1, 4], nocturnal: true,
      meleeDamage: 5, meleeCooldownTicks: 110,
      butcherProducts: { meatRaw: 22, leather: 8 }, leatherAmount: 8,
      color: '#a3503a', color2: '#e0803c', sprite: 'boomrat',
      comfyTempMin: -15, comfyTempMax: 45,
      diet: 'omnivore', explodeOnDeath: true, explodes: true,
      explosionRadius: 2.9, explosionDamage: 10, explosionType: 'flame',
      revengeChance: 0.06, manhunterOnTameFail: 0.03, nuzzles: true, breeds: true
    },
    wolf: {
      label: 'wolf', description: 'Hunts in ones and twos, mostly at night, and will take a ' +
        'colonist who is out alone.',
      combatPower: 90,
      baseHealthScale: 0.85, healthScale: 0.85,
      baseBodySize: 0.75, bodySize: 0.75, drawSize: 1.15,
      moveSpeed: 5.4, baseHungerRate: 1.6, hungerRateFactor: 1.0,
      lifeExpectancyYears: 12, ageRange: [0.5, 10],
      wildness: 0.90, trainability: 'advanced', packSize: [1, 3], nocturnal: true,
      predator: true, diet: 'carnivore',
      meleeDamage: 12, meleeDamageType: 'bite', meleeCooldownTicks: 90, meleeSkill: 7,
      butcherProducts: { meatRaw: 55, leather: 35 }, leatherAmount: 35,
      color: '#6e6e78', color2: '#b0b0b8', sprite: 'wolf',
      comfyTempMin: -35, comfyTempMax: 38,
      revengeChance: 0.07, manhunterOnTameFail: 0.08, manhunterChance: 0.08
    },
    bear: {
      label: 'bear', description: 'The largest thing on the map that wants to eat you. ' +
        'Slow to anger and impossible to argue with afterwards.',
      combatPower: 200,
      baseHealthScale: 1.6, healthScale: 1.6,
      baseBodySize: 1.9, bodySize: 1.9, drawSize: 1.4,
      moveSpeed: 4.2, baseHungerRate: 2.1, hungerRateFactor: 1.3,
      lifeExpectancyYears: 22, ageRange: [1, 16],
      wildness: 0.97, trainability: 'advanced', packSize: [1, 2],
      predator: true, diet: 'omnivore',
      meleeDamage: 18, meleeDamageType: 'bite', meleeCooldownTicks: 110, meleeSkill: 8,
      meleeArmorPen: 0.1,
      butcherProducts: { meatRaw: 140, leather: 60 }, leatherAmount: 60,
      color: '#4a3524', color2: '#6b4f33', sprite: 'bear',
      comfyTempMin: -40, comfyTempMax: 36,
      armorSharp: 0.1, armorBlunt: 0.1,
      revengeChance: 0.10, manhunterOnTameFail: 0.12, manhunterChance: 0.12
    }
  }, {
    race: 'animal',
    isAnimal: true,
    body: 'quadruped',
    defaultFaction: 'wild',
    techLevel: 'animal',
    moveSpeedFactor: 1,
    weapons: NO_THINGS,
    apparel: NO_THINGS,
    meleeDamageType: 'bite',
    meleeArmorPen: 0,
    meleeSkill: 4,
    armorSharp: 0, armorBlunt: 0, armorHeat: 0,
    /* Everything that is not a predator eats grass, which is what lets
       animals.js send it to a patch of it when it gets hungry. */
    diet: 'herbivore',
    grazer: true,
    predator: false,
    packAnimal: false,
    nocturnal: false,
    breeds: false,
    packSize: [1, 3],
    revengeChance: 0.05,
    manhunterOnTameFail: 0.02,
    manhunterChance: 0.0,
    explodeOnDeath: false,
    explodes: false,
    nuzzles: false,
    leatherDef: 'leather',
    trainability: 'none'
  });

  /* ============================================================
     10. FACTIONS

     The four built-in sides. Generated civilizations live in
     factions.js and carry their own colours; these are the ids that
     every pawn and building on the colony map is stamped with.
     ============================================================ */

  Defs.add('faction', {
    player: {
      label: 'Your colony', color: '#4a7fd4',
      description: 'The survivors you are responsible for.',
      isPlayer: true, hostileToPlayer: false, techLevel: 'industrial'
    },
    raider: {
      label: 'Pirates', color: '#c0392b',
      description: 'Whoever is coming over the hill this time. Permanently hostile, and ' +
        'interested in what you have built.',
      hostileToPlayer: true, techLevel: 'industrial'
    },
    wild: {
      label: 'Wildlife', color: '#b08c5a',
      description: 'Everything born on this map and beholden to nobody.',
      hostileToPlayer: false, techLevel: 'animal'
    },
    neutral: {
      label: 'Outlanders', color: '#8a7f6a',
      description: 'Travellers, traders and wanderers who have no quarrel with you yet.',
      hostileToPlayer: false, techLevel: 'industrial'
    }
  }, {
    isPlayer: false,
    hostileToPlayer: false,
    techLevel: 'industrial'
  });

  /* ============================================================
     11. NAMES

     Not a def category: pawn.js reads root.PawnNames directly. First
     names are split by gender, surnames and nicknames are not, and a
     third of colonists end up going by the nickname instead.
     ============================================================ */

  root.PawnNames = {
    first: {
      male: [
        'Aldric', 'Ander', 'Bastian', 'Boris', 'Bram', 'Caleb', 'Casimir', 'Cato',
        'Cyrus', 'Dario', 'Declan', 'Dmitri', 'Dorian', 'Eamon', 'Edric', 'Emil',
        'Enzo', 'Ewan', 'Fabian', 'Felix', 'Finn', 'Fyodor', 'Gareth', 'Garrick',
        'Gideon', 'Hakon', 'Hale', 'Hugo', 'Ivan', 'Ivo', 'Jarek', 'Joss',
        'Kai', 'Kellan', 'Klaus', 'Lars', 'Leif', 'Lucian', 'Magnus', 'Marek',
        'Mattias', 'Milo', 'Nikolai', 'Oleg', 'Osric', 'Otto', 'Pavel', 'Piers',
        'Quentin', 'Rafael', 'Roman', 'Rurik', 'Silas', 'Soren', 'Stellan', 'Sten',
        'Tarek', 'Theo', 'Tobias', 'Ulf', 'Vance', 'Viggo', 'Wendel', 'Yusuf', 'Zeno'
      ],
      female: [
        'Ada', 'Adela', 'Alina', 'Anneke', 'Astrid', 'Beatrix', 'Bex', 'Brigid',
        'Camille', 'Carys', 'Cira', 'Dagny', 'Delia', 'Dova', 'Eira', 'Elska',
        'Esme', 'Freya', 'Frida', 'Genevieve', 'Greta', 'Hana', 'Helena', 'Ilse',
        'Imani', 'Ingrid', 'Iona', 'Isolde', 'Juna', 'Juno', 'Kira', 'Lena',
        'Lilja', 'Livia', 'Lyra', 'Maeve', 'Marta', 'Mira', 'Nadia', 'Nell',
        'Nina', 'Noor', 'Odile', 'Orla', 'Petra', 'Quen', 'Rhea', 'Romy',
        'Sable', 'Saga', 'Selin', 'Sigrid', 'Solveig', 'Tamsin', 'Thea', 'Ursa',
        'Vera', 'Vesna', 'Wren', 'Xenia', 'Yara', 'Yuki', 'Zara', 'Zoya'
      ]
    },
    last: [
      'Ashby', 'Baros', 'Beckett', 'Brandt', 'Bright', 'Calder', 'Carrow', 'Castellan',
      'Crane', 'Dane', 'Delacroix', 'Draven', 'Dunn', 'Eastwood', 'Esker', 'Falk',
      'Fenwick', 'Ferris', 'Ferro', 'Grieve', 'Halloran', 'Hart', 'Hollis', 'Holloway',
      'Ivanov', 'Jansen', 'Kessler', 'Kovac', 'Lang', 'Larsen', 'Lindqvist', 'Lowen',
      'Marsh', 'Mercer', 'Moreau', 'Nakamura', 'Nilsen', 'Novak', 'Okonkwo', 'Orme',
      'Pike', 'Quarrow', 'Rask', 'Redmane', 'Reyes', 'Roth', 'Sandoval', 'Sarkis',
      'Shaw', 'Sokolov', 'Stark', 'Stroud', 'Tanaka', 'Thorne', 'Umber', 'Vane',
      'Vasquez', 'Vogel', 'Walsh', 'Weber', 'Wilder', 'Yarrow', 'Zane', 'Zielinski'
    ],
    nick: [
      'Ace', 'Ash', 'Bolt', 'Boomer', 'Buckshot', 'Chief', 'Cricket', 'Dusty',
      'Echo', 'Flint', 'Ghost', 'Gizmo', 'Grit', 'Hatchet', 'Hawk', 'Jinx',
      'Kilo', 'Lucky', 'Mongoose', 'Moss', 'Nails', 'Nomad', 'Patch', 'Pip',
      'Rabbit', 'Rook', 'Rusty', 'Sarge', 'Scrap', 'Shade', 'Shrike', 'Six',
      'Sparrow', 'Spanner', 'Static', 'Stitch', 'Tank', 'Tinker', 'Tumbler', 'Twitch',
      'Vex', 'Whisper', 'Wrench', 'Zip'
    ],
    /* Wild animals are numbered by pawn.js; these are for the tame ones,
       which is the point at which anybody bothers naming them. */
    animal: [
      'Ash', 'Bandit', 'Biscuit', 'Bramble', 'Clover', 'Digger', 'Dusty', 'Ember',
      'Fern', 'Flint', 'Gus', 'Hazel', 'Juniper', 'Kodiak', 'Luna', 'Maple',
      'Marrow', 'Moose', 'Nutmeg', 'Onyx', 'Pebble', 'Pepper', 'Piper', 'Rowan',
      'Sage', 'Scout', 'Shadow', 'Sorrel', 'Thistle', 'Timber', 'Tumble', 'Willow'
    ]
  };

})(this);
