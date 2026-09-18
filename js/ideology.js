/* ============================================================
   ideology.js - what the colony believes, and what that costs.

   A colony has an ideoligion: one to four MEMES, which force a set of
   PRECEPTS, which decide how a colonist feels about the things they do
   all day. The same act is virtue or atrocity depending on the table:
   eating human meat is -25 mood under an abhorrent cannibalism precept
   and +12 under a required one, and nothing else in the game has to know
   that, because everything routes through one forgiving entry point,
   Ideology.noteAction.

   Three deliberate choices hold the file together.

   Defs first. Memes, precepts, rituals and roles are plain tables, read
   through Ideology.memes() and friends rather than through the def
   registry, because defs.js does not know these categories and is not
   ours to edit. The one thing that does go into the registry is thoughts
   - Defs.add('thought', ...) is additive and legal - and every one of
   them is GENERATED from the precept tables at load, so a precept and
   the mood line it fires cannot drift apart.

   Plain state. Everything on a pawn lives in pawn.ideo as numbers,
   strings and small arrays, so save.js carries it for free when it walks
   the pawn's own properties. Everything else lives in one module-level
   `state` that Ideology.save() hands over whole.

   One clock. Ideology.tickRituals(game) advances the whole system in
   coarse 30-tick beats and catches up if it is called late, so a ritual
   behaves the same whether the caller is the game tick or a work giver
   asking whether there is anywhere to be.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* jobs.js, pathfind.js and workgivers.js load above this file, so they
     can be bound now. Game, Needs, Health and Prisoners are reached
     through sys() at tick time, which is what lets this file load into a
     bare sandbox with nothing else in it. */
  var T = root.T;
  var Res = root.Res;
  var Jobs = root.Jobs;
  var Toils = root.Toils;
  var Path = root.Path;
  var WorkGivers = root.WorkGivers;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  function sys(name) { return root[name] || null; }
  function game() { return sys('Game'); }
  function now() {
    var G = root.Game;
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  /* ---------- tuning ---------- */

  var DAY = 60000;
  var BEAT = 30;                 /* how often the ritual clock advances   */
  var RARE = 250;                /* the staggered per-pawn beat           */
  var MAX_CATCHUP = 40;          /* beats one pump will run through       */

  var CERTAINTY_GAIN = 0.55 / DAY;   /* among believers                   */
  var CERTAINTY_LOSS = 0.40 / DAY;   /* alone among unbelievers           */
  var RESENTMENT_DECAY = 0.30 / DAY;
  var CONVERT_POWER = 0.11;          /* certainty removed per attempt     */
  var CONVERT_COOLDOWN = 9000;
  var RITUAL_INTERVAL = 4 * DAY;
  var RITUAL_GATHER_TICKS = 2500;
  var RITUAL_JOY = 0.30;

  var Ideology = {};

  /* ============================================================
     1. MEMES

     A meme is a core idea. `requires` forces precept degrees, `forbids`
     bans them, `conflicts` names memes that cannot sit beside it. The
     direct effects are the last three fields: a standing mood, a work
     speed factor per work type, and an opinion that scales how hard a
     morally loaded act lands.
     ============================================================ */

  var MEMES = {
    supremacist: {
      label: 'Supremacist', category: 'structure',
      desc: 'Some people are born to rule and the rest are born to serve.',
      requires: { slavery: 'honourable', charity: 'forbidden', raiding: 'glorious' },
      conflicts: ['loyalist', 'collectivist'],
      mood: -0.02, work: { warden: 1.15 },
      opinion: { slaveOwned: 1.4, gaveCharity: 1.3 },
      situation: { check: 'subjects', good: ['Our subjects know their place', 0.05],
                   bad: ['Nobody beneath us', -0.04] }
    },
    loyalist: {
      label: 'Loyalist', category: 'structure',
      desc: 'A colony is a chain of command, and the chain must not break.',
      requires: { workDrive: 'fervent', charity: 'encouraged' },
      conflicts: ['supremacist', 'individualist'],
      work: { construct: 1.08, haul: 1.08 },
      opinion: { roleLost: 1.5 },
      situation: { check: 'leader', good: ['Our leader stands over us', 0.06],
                   bad: ['Nobody leads us', -0.07] }
    },
    individualist: {
      label: 'Individualist', category: 'belief',
      desc: 'A person answers to themselves first and to the colony second.',
      requires: { charity: 'indifferent', workDrive: 'casual' },
      conflicts: ['collectivist', 'loyalist'],
      work: { craft: 1.10, artistic: 1.10 },
      opinion: { workedHard: 0.7 },
      situation: { check: 'smallColony', good: ['Room to breathe', 0.05],
                   bad: ['Too many people underfoot', -0.05] }
    },
    collectivist: {
      label: 'Collectivist', category: 'belief',
      desc: 'One person is nothing. The colony is everything.',
      requires: { charity: 'encouraged', workDrive: 'diligent' },
      conflicts: ['individualist', 'supremacist'],
      work: { haul: 1.12, clean: 1.12 },
      opinion: { gaveCharity: 1.4, workedHard: 1.3 },
      situation: { check: 'bigColony', good: ['We are many', 0.06],
                   bad: ['So few of us left', -0.05] }
    },
    naturePrimacy: {
      label: 'Nature primacy', category: 'belief',
      desc: 'The wild was here first. Every machine is an insult to it.',
      requires: { trees: 'sacred', animals: 'revered', mining: 'disliked' },
      forbids: { building: ['monumental'] },
      conflicts: ['tunneler', 'transhumanist', 'rancher'],
      work: { grow: 1.20, mine: 0.80 },
      opinion: { treeCut: 1.6, minedRock: 1.4, treePlanted: 1.5 },
      situation: { check: 'greenery', good: ['Living things all around', 0.06],
                   bad: ['Nothing grows here', -0.06] }
    },
    transhumanist: {
      label: 'Transhumanist', category: 'belief',
      desc: 'Flesh is a first draft. Every implant is a correction.',
      requires: { bodyModification: 'required', skinModification: 'admired' },
      conflicts: ['bodyPurist', 'fleshPurity', 'naturePrimacy'],
      work: { research: 1.15, intellectual: 1.15 },
      opinion: { implantInstalled: 1.5 },
      situation: { check: 'implants', good: ['Improved flesh', 0.07],
                   bad: ['Still only human', -0.05] }
    },
    bodyPurist: {
      label: 'Body purist', category: 'belief',
      desc: 'The body you were born with is the only honest one.',
      requires: { bodyModification: 'abhorrent', skinModification: 'disapproved' },
      conflicts: ['transhumanist'],
      opinion: { implantInstalled: 1.5 },
      situation: { check: 'implants', good: ['Whole and unaltered', 0.04],
                   bad: ['Machinery under my skin', -0.09] }
    },
    cannibal: {
      label: 'Cannibal', category: 'belief',
      desc: 'A body is meat. Wasting meat is the sin.',
      requires: { cannibalism: 'preferred', corpses: 'fine' },
      conflicts: ['fleshPurity'],
      opinion: { eatHumanMeat: 1.3, butcherHuman: 1.3 },
      situation: { check: 'humanMeat', good: ['Good meat in the larder', 0.05], bad: null }
    },
    raider: {
      label: 'Raider', category: 'belief',
      desc: 'What other people build, we take. That is the arrangement.',
      requires: { raiding: 'glorious', charity: 'forbidden' },
      work: { shooting: 1.10, melee: 1.10 },
      opinion: { raidLaunched: 1.5, raidBeaten: 1.4 },
      situation: null
    },
    rancher: {
      label: 'Rancher', category: 'lifestyle',
      desc: 'A herd is wealth, and a herder is worth two farmers.',
      requires: { animals: 'valued' },
      forbids: { animals: ['revered'] },
      conflicts: ['naturePrimacy'],
      work: { handle: 1.25, animals: 1.25 },
      opinion: { animalTamed: 1.5, animalSlaughtered: 0.6 },
      situation: { check: 'herd', good: ['Our herd is strong', 0.06],
                   bad: ['No animals to tend', -0.04] }
    },
    tunneler: {
      label: 'Tunneler', category: 'lifestyle',
      desc: 'The sky is a hole you can fall out of. Stone is safety.',
      requires: { mining: 'exalted', building: 'functional' },
      forbids: { trees: ['sacred'] },
      conflicts: ['naturePrimacy', 'treeConnection'],
      work: { mine: 1.20, construct: 1.05 },
      opinion: { minedRock: 1.6 },
      situation: { check: 'underRoof', good: ['Stone over my head', 0.06],
                   bad: ['Out under the open sky', -0.08] }
    },
    nudism: {
      label: 'Nudism', category: 'lifestyle',
      desc: 'Cloth is a lie told to the body.',
      requires: { nudityAll: 'required' },
      opinion: { wasNude: 1.4, wasClothed: 1.4 },
      situation: { check: 'nude', good: ['Free of clothing', 0.06],
                   bad: ['Wrapped up in cloth', -0.05] }
    },
    blindsight: {
      label: 'Blindsight', category: 'belief',
      desc: 'Sight is a distraction. The blind see what matters.',
      requires: { bodyModification: 'disapproved', drugs: 'prohibited' },
      conflicts: ['highLife'],
      work: { intellectual: 1.12 },
      opinion: { implantInstalled: 1.2 },
      situation: { check: 'blind', good: ['Darkness has taught me', 0.10],
                   bad: ['Still distracted by seeing', -0.03] }
    },
    treeConnection: {
      label: 'Tree connection', category: 'belief',
      desc: 'One tree is the colony made visible. Tend it or wither.',
      requires: { trees: 'sacred', animals: 'valued' },
      conflicts: ['tunneler'],
      work: { grow: 1.15, plants: 1.15 },
      opinion: { treeCut: 1.8, treePlanted: 1.8 },
      situation: { check: 'greenery', good: ['The trees are near', 0.05],
                   bad: ['Cut off from the trees', -0.06] }
    },
    guilty: {
      label: 'Guilty', category: 'belief',
      desc: 'We are born owing. Only the lash pays it down.',
      requires: { workDrive: 'fervent', charity: 'encouraged' },
      mood: -0.03, work: { construct: 1.10, mine: 1.10 },
      opinion: { ritualHeld: 1.5 },
      situation: { check: 'penance', good: ['Penance recently paid', 0.05],
                   bad: ['The debt is unpaid', -0.08] }
    },
    painism: {
      label: 'Painism', category: 'belief',
      desc: 'Pain is the only honest teacher.',
      requires: { execution: 'acceptable', drugs: 'prohibited' },
      conflicts: ['highLife'],
      opinion: { woundTended: 0.5 },
      situation: { check: 'pain', good: ['Pain is instruction', 0.09],
                   bad: ['Nothing hurts, nothing is learned', -0.03] }
    },
    darkness: {
      label: 'Darkness', category: 'lifestyle',
      desc: 'Light is exposure. Anything worth doing is done unseen.',
      requires: { building: 'functional' },
      work: { craft: 1.08 },
      opinion: null,
      situation: { check: 'gloom', good: ['Comfortable gloom', 0.07],
                   bad: ['Glaring light everywhere', -0.06] }
    },
    fleshPurity: {
      label: 'Flesh purity', category: 'belief',
      desc: 'A body is sacred entire. Do not eat it, do not open it.',
      requires: { bodyModification: 'abhorrent', cannibalism: 'abhorrent', corpses: 'venerated' },
      conflicts: ['cannibal', 'transhumanist'],
      opinion: { eatHumanMeat: 1.6, butcherHuman: 1.8, corpseRotting: 1.6 },
      situation: { check: 'corpsesLying', good: null, bad: ['Bodies left where they fell', -0.07] }
    },
    highLife: {
      label: 'High life', category: 'lifestyle',
      desc: 'Sobriety is a waste of a short life.',
      requires: { drugs: 'celebrated', lovin: 'celebrated' },
      conflicts: ['painism', 'blindsight'],
      mood: 0.02,
      opinion: { tookDrug: 1.6 },
      situation: { check: 'sober', good: ['Pleasantly indulged', 0.05],
                   bad: ['Stone cold sober', -0.06] }
    }
  };

  /* ============================================================
     2. PRECEPTS

     Every precept is a ladder of degrees and a table of reactions. A
     reaction's `stages` array is indexed by the degree the ideoligion
     sits at, which is the whole asymmetry: one array, five numbers, and
     the same act reads as sin or sacrament.

     Moods are in need units - -0.25 is RimWorld's -25.
     ============================================================ */

  function P(label, category, degrees, deflt, extra) {
    var def = { label: label, category: category, degrees: degrees, def: deflt, reactions: {} };
    if (extra) Object.keys(extra).forEach(function (k) { def[k] = extra[k]; });
    return def;
  }

  var PRECEPTS = {
    cannibalism: P('Cannibalism', 'food',
      ['abhorrent', 'disapproved', 'acceptable', 'preferred', 'required'], 'disapproved'),
    corpses: P('Corpses', 'death', ['dislike', 'fine', 'venerated'], 'dislike'),
    slavery: P('Slavery', 'social',
      ['abhorrent', 'disapproved', 'acceptable', 'honourable'], 'disapproved'),
    nudityMale: P('Nudity (men)', 'body',
      ['forbidden', 'disapproved', 'acceptable', 'preferred', 'required'], 'disapproved',
      { appliesTo: 'male', group: 'nudity' }),
    nudityFemale: P('Nudity (women)', 'body',
      ['forbidden', 'disapproved', 'acceptable', 'preferred', 'required'], 'disapproved',
      { appliesTo: 'female', group: 'nudity' }),
    nudityAll: P('Nudity (everyone)', 'body',
      ['forbidden', 'disapproved', 'acceptable', 'preferred', 'required'], 'disapproved',
      { group: 'nudity' }),
    skinModification: P('Skin modification', 'body',
      ['abhorrent', 'disapproved', 'acceptable', 'admired'], 'acceptable'),
    bodyModification: P('Body modification', 'body',
      ['abhorrent', 'disapproved', 'acceptable', 'admired', 'required'], 'acceptable'),
    drugs: P('Drugs', 'body',
      ['prohibited', 'disapproved', 'acceptable', 'celebrated'], 'disapproved'),
    execution: P('Execution', 'death',
      ['abhorrent', 'disapproved', 'acceptable', 'honourable'], 'disapproved'),
    raiding: P('Raiding', 'social',
      ['abhorrent', 'disapproved', 'acceptable', 'glorious'], 'disapproved'),
    charity: P('Charity', 'social',
      ['forbidden', 'indifferent', 'encouraged', 'required'], 'indifferent'),
    workDrive: P('Work drive', 'social',
      ['casual', 'normal', 'diligent', 'fervent'], 'normal'),
    lovin: P('Lovin', 'social',
      ['prohibited', 'disapproved', 'free', 'celebrated'], 'free'),
    funerals: P('Funerals', 'death', ['unnecessary', 'expected', 'essential'], 'expected'),
    trees: P('Trees', 'nature', ['resource', 'respected', 'sacred'], 'resource'),
    animals: P('Animals', 'nature', ['livestock', 'valued', 'revered'], 'livestock'),
    mining: P('Mining', 'work', ['disliked', 'acceptable', 'exalted'], 'acceptable'),
    building: P('Building', 'work', ['functional', 'decorated', 'monumental'], 'functional'),
    foodVariety: P('Food variety', 'food', ['indifferent', 'valued', 'demanded'], 'indifferent')
  };

  /* Reactions. `stages` runs degree by degree; a null entry means that
     degree simply does not care and no thought is fired at all. */
  function react(preceptId, action, spec) {
    PRECEPTS[preceptId].reactions[action] = spec;
  }

  react('cannibalism', 'eatHumanMeat', {
    thought: 'ideoAteHuman', label: 'Ate human meat', days: 2, stack: 3,
    stages: [['Ate human meat', -0.25], ['Ate human meat', -0.12], null,
             ['Ate a proper meal', 0.10], ['Ate as the faith demands', 0.13]]
  });
  react('cannibalism', 'butcherHuman', {
    thought: 'ideoButcheredHuman', label: 'Butchered a human', days: 2, stack: 2,
    stages: [['Butchered a person', -0.20], ['Butchered a person', -0.09], null,
             ['Put a body to good use', 0.06], ['Honoured the dead properly', 0.09]]
  });
  react('corpses', 'corpseSeen', {
    thought: 'ideoSawCorpse', label: 'Saw a corpse', days: 0.6, stack: 3,
    stages: [['Saw a rotting body', -0.05], null, ['Stood with the honoured dead', 0.04]]
  });
  react('corpses', 'corpseRotting', {
    thought: 'ideoCorpseNeglected', label: 'A body left to rot', days: 1.5, stack: 3,
    stages: [['A body left lying about', -0.06], null, ['Our dead are disrespected', -0.14]]
  });
  react('corpses', 'corpseBuried', {
    thought: 'ideoCorpseLaidToRest', label: 'Laid a body to rest', days: 2,
    stages: [['The body is out of sight', 0.03], null, ['The dead are honoured', 0.08]]
  });
  react('slavery', 'slaveOwned', {
    thought: 'ideoSlaveHere', label: 'A slave in the colony', days: 1, stack: 3,
    stages: [['We keep slaves', -0.14], ['We keep slaves', -0.06], null,
             ['Our slaves serve us', 0.06]]
  });
  react('slavery', 'slaveFreed', {
    thought: 'ideoSlaveFreed', label: 'A slave was freed', days: 3,
    stages: [['We freed someone', 0.10], ['We freed someone', 0.05], null,
             ['We gave away property', -0.06]]
  });
  react('nudityMale', 'wasNude', {
    thought: 'ideoNudityMale', label: 'Nudity', days: 0.4,
    stages: [['Saw an unclothed man', -0.06], ['Saw an unclothed man', -0.03], null,
             ['Properly unclothed', 0.04], ['As the faith requires', 0.06]]
  });
  react('nudityFemale', 'wasNude', {
    thought: 'ideoNudityFemale', label: 'Nudity', days: 0.4,
    stages: [['Saw an unclothed woman', -0.06], ['Saw an unclothed woman', -0.03], null,
             ['Properly unclothed', 0.04], ['As the faith requires', 0.06]]
  });
  react('nudityAll', 'wasNude', {
    thought: 'ideoNudityAll', label: 'Nudity', days: 0.4,
    stages: [['Someone is unclothed', -0.06], ['Someone is unclothed', -0.03], null,
             ['Properly unclothed', 0.05], ['As the faith requires', 0.08]]
  });
  react('nudityAll', 'wasClothed', {
    thought: 'ideoClothedWrongly', label: 'Wearing clothes', days: 0.4,
    stages: [null, null, null, ['Wrapped in cloth', -0.04], ['Hiding under cloth', -0.08]]
  });
  react('skinModification', 'skinModInstalled', {
    thought: 'ideoSkinMod', label: 'Skin modification', days: 4,
    stages: [['Defaced skin', -0.14], ['Defaced skin', -0.06], null, ['Beautifully marked', 0.07]]
  });
  react('bodyModification', 'implantInstalled', {
    thought: 'ideoImplant', label: 'An implant', days: 6, stack: 2,
    stages: [['Machinery in the flesh', -0.18], ['Machinery in the flesh', -0.08], null,
             ['Improved flesh', 0.08], ['Flesh corrected at last', 0.12]]
  });
  react('drugs', 'tookDrug', {
    thought: 'ideoTookDrug', label: 'Drug use', days: 1, stack: 3,
    stages: [['Someone used drugs', -0.12], ['Someone used drugs', -0.05], null,
             ['A well-earned high', 0.07]]
  });
  react('execution', 'prisonerExecuted', {
    thought: 'ideoExecution', label: 'An execution', days: 4, stack: 3,
    stages: [['We executed a prisoner', -0.16], ['We executed a prisoner', -0.07], null,
             ['Justice was carried out', 0.07]]
  });
  react('raiding', 'raidLaunched', {
    thought: 'ideoRaidLaunched', label: 'We raided somebody', days: 4,
    stages: [['We attacked strangers', -0.14], ['We attacked strangers', -0.06], null,
             ['We took what is ours', 0.11]]
  });
  react('raiding', 'raidBeaten', {
    thought: 'ideoRaidBeaten', label: 'We beat off a raid', days: 3,
    stages: [['The killing is over', 0.03], ['The killing is over', 0.04], ['We held the line', 0.06],
             ['We crushed them', 0.11]]
  });
  react('charity', 'gaveCharity', {
    thought: 'ideoCharityGiven', label: 'We gave something away', days: 3,
    stages: [['We gave our goods away', -0.08], null, ['We helped somebody', 0.06],
             ['We did as we must', 0.09]]
  });
  react('charity', 'refusedCharity', {
    thought: 'ideoCharityRefused', label: 'We turned somebody away', days: 3,
    stages: [['We kept what is ours', 0.04], null, ['We turned somebody away', -0.05],
             ['We failed our duty', -0.10]]
  });
  react('workDrive', 'workedHard', {
    thought: 'ideoWorkedHard', label: 'A long shift', days: 0.8, stack: 2,
    stages: [['Worked too long', -0.04], null, ['A good day of work', 0.04],
             ['A day of holy work', 0.07]]
  });
  react('workDrive', 'idled', {
    thought: 'ideoIdled', label: 'Idle time', days: 0.6, stack: 2,
    stages: [['Rested properly', 0.04], null, ['Wasted the day', -0.04],
             ['Shamefully idle', -0.08]]
  });
  react('lovin', 'lovin', {
    thought: 'ideoLovin', label: 'Lovin', days: 1.5,
    stages: [['We broke the rule', -0.12], ['We should not have', -0.05], null,
             ['A celebrated night', 0.08]]
  });
  react('funerals', 'funeralHeld', {
    thought: 'ideoFuneralHeld', label: 'A funeral was held', days: 4,
    stages: [['A lot of fuss over a body', -0.02], ['We said goodbye', 0.05],
             ['The rites were kept', 0.10]]
  });
  react('funerals', 'funeralSkipped', {
    thought: 'ideoFuneralSkipped', label: 'No funeral was held', days: 4,
    stages: [null, ['Nobody said goodbye', -0.05], ['The rites were broken', -0.13]]
  });
  react('trees', 'treeCut', {
    thought: 'ideoTreeCut', label: 'A tree was cut', days: 1, stack: 4,
    stages: [null, ['A tree was cut down', -0.03], ['A sacred tree was cut down', -0.09]]
  });
  react('trees', 'treePlanted', {
    thought: 'ideoTreePlanted', label: 'A tree was planted', days: 2, stack: 3,
    stages: [null, ['A tree was planted', 0.03], ['A sacred tree was planted', 0.07]]
  });
  react('animals', 'animalSlaughtered', {
    thought: 'ideoAnimalKilled', label: 'An animal was slaughtered', days: 1.5, stack: 3,
    stages: [null, ['An animal was slaughtered', -0.04], ['A revered animal was killed', -0.11]]
  });
  react('animals', 'animalTamed', {
    thought: 'ideoAnimalTamed', label: 'An animal joined us', days: 2,
    stages: [['Another mouth to feed', 0.01], ['An animal joined us', 0.05],
             ['A revered creature joined us', 0.09]]
  });
  react('mining', 'minedRock', {
    thought: 'ideoMined', label: 'Cut into the rock', days: 0.8, stack: 3,
    stages: [['We tore up the ground', -0.05], null, ['We opened the stone', 0.06]]
  });
  react('building', 'builtStructure', {
    thought: 'ideoBuilt', label: 'Raised a building', days: 2, stack: 2,
    stages: [['Another shed', 0.01], ['We built something fine', 0.05],
             ['We raised something worthy', 0.09]]
  });
  react('building', 'grandRoom', {
    thought: 'ideoGrandRoom', label: 'Grand architecture', days: 1,
    stages: [null, ['Fine surroundings', 0.04], ['Architecture worthy of us', 0.08]]
  });
  react('foodVariety', 'ateSameFood', {
    thought: 'ideoSameFood', label: 'The same meal again', days: 1, stack: 3,
    stages: [null, ['The same meal again', -0.04], ['The same meal yet again', -0.09]]
  });
  react('foodVariety', 'ateNewFood', {
    thought: 'ideoNewFood', label: 'Something different to eat', days: 1,
    stages: [null, ['Something different to eat', 0.04], ['A varied table', 0.07]]
  });

  /* Actions a precept degree forbids outright. Ideology.allows reads
     this and nothing else, so an action nobody listed is permitted. */
  var DENIALS = {
    eatHumanMeat: { precept: 'cannibalism', deny: ['abhorrent'] },
    butcherHuman: { precept: 'cannibalism', deny: ['abhorrent', 'disapproved'] },
    humanSacrifice: { precept: 'execution', deny: ['abhorrent', 'disapproved'] },
    prisonerExecuted: { precept: 'execution', deny: ['abhorrent'] },
    slaveOwned: { precept: 'slavery', deny: ['abhorrent'] },
    raidLaunched: { precept: 'raiding', deny: ['abhorrent'] },
    treeCut: { precept: 'trees', deny: ['sacred'] },
    tookDrug: { precept: 'drugs', deny: ['prohibited'] },
    lovin: { precept: 'lovin', deny: ['prohibited'] },
    wasClothed: { precept: 'nudityAll', deny: ['required'] },
    animalSlaughtered: { precept: 'animals', deny: ['revered'] },
    gaveCharity: { precept: 'charity', deny: ['forbidden'] }
  };

  /* ============================================================
     3. THOUGHTS

     Generated from the tables above so a precept and its mood line
     cannot disagree, then registered with the real def registry, which
     is what makes them show up in the Needs tab like any other thought.
     ============================================================ */

  var thoughtTable = {};

  Object.keys(PRECEPTS).forEach(function (pid) {
    var precept = PRECEPTS[pid];
    Object.keys(precept.reactions).forEach(function (action) {
      var r = precept.reactions[action];
      if (thoughtTable[r.thought]) return;     /* shared by two precepts */
      var stages = [];
      for (var i = 0; i < r.stages.length; i++) {
        var s = r.stages[i];
        stages.push(s ? { label: s[0], mood: s[1] } : { label: precept.label, mood: 0 });
      }
      thoughtTable[r.thought] = {
        label: r.label, durationDays: r.days || 1,
        stackLimit: r.stack || 1, stages: stages
      };
    });
  });

  /* One two-stage thought per meme with a standing feeling: stage 0 is
     the unhappy state, stage 1 the happy one. */
  Object.keys(MEMES).forEach(function (mid) {
    var meme = MEMES[mid];
    if (!meme.situation) return;
    var bad = meme.situation.bad, good = meme.situation.good;
    thoughtTable['ideoMeme_' + mid] = {
      label: meme.label, durationDays: 0.4, stackLimit: 1,
      stages: [
        { label: bad ? bad[0] : meme.label, mood: bad ? bad[1] : 0 },
        { label: good ? good[0] : meme.label, mood: good ? good[1] : 0 }
      ]
    };
  });

  /* The rest are fired by the system itself rather than by a precept. */
  thoughtTable.ideoRitual = {
    label: 'Ritual', durationDays: 5, stackLimit: 2,
    stages: [
      { label: 'A dull ritual', mood: 0.01 },
      { label: 'A decent ritual', mood: 0.05 },
      { label: 'A fine ritual', mood: 0.10 },
      { label: 'An inspiring ritual', mood: 0.16 }
    ]
  };
  thoughtTable.ideoRitualMissed = {
    label: 'Missed the ritual', durationDays: 2, stackLimit: 1,
    stages: [{ label: 'I missed the gathering', mood: -0.04 }]
  };
  thoughtTable.ideoRoleGained = {
    label: 'Given a role', durationDays: 6, stackLimit: 1,
    stages: [{ label: 'I have a place in the faith', mood: 0.06 }]
  };
  thoughtTable.ideoRoleLost = {
    label: 'Lost my role', durationDays: 8, stackLimit: 1,
    stages: [{ label: 'My role was taken from me', mood: -0.14 }]
  };
  thoughtTable.ideoNoMoralGuide = {
    label: 'No moral guide', durationDays: 0.4, stackLimit: 1,
    stages: [{ label: 'Nobody speaks for the faith', mood: -0.04 }]
  };
  thoughtTable.ideoConverted = {
    label: 'Found the faith', durationDays: 10, stackLimit: 1,
    stages: [{ label: 'I see it clearly now', mood: 0.08 }]
  };
  thoughtTable.ideoPreachedAt = {
    label: 'Preached at', durationDays: 1, stackLimit: 3,
    stages: [{ label: 'Somebody preached at me', mood: -0.04 }]
  };
  thoughtTable.ideoDoubt = {
    label: 'Doubt', durationDays: 0.4, stackLimit: 1,
    stages: [
      { label: 'Quiet doubts', mood: -0.03 },
      { label: 'Serious doubts', mood: -0.07 },
      { label: 'I no longer believe', mood: -0.12 }
    ]
  };
  thoughtTable.ideoResentment = {
    label: 'Resentment', durationDays: 0.4, stackLimit: 1,
    stages: [
      { label: 'Our ways are being broken', mood: -0.04 },
      { label: 'Our ways are being trampled', mood: -0.09 },
      { label: 'This colony has abandoned the faith', mood: -0.16 }
    ]
  };
  thoughtTable.ideoAmongBelievers = {
    label: 'Among believers', durationDays: 0.4, stackLimit: 1,
    stages: [{ label: 'Surrounded by believers', mood: 0.04 }]
  };
  thoughtTable.ideoAmongUnbelievers = {
    label: 'Among unbelievers', durationDays: 0.4, stackLimit: 1,
    stages: [{ label: 'Nobody here shares my faith', mood: -0.06 }]
  };
  thoughtTable.ideoRelic = {
    label: 'A relic stands here', durationDays: 0.6, stackLimit: 1,
    stages: [{ label: 'Our relic stands among us', mood: 0.05 }]
  };
  thoughtTable.ideoInspired = {
    label: 'Inspired', durationDays: 1, stackLimit: 1,
    stages: [{ label: 'Burning with purpose', mood: 0.10 }]
  };
  /* The mood a meme carries whatever is going on. The number comes from
     the meme rather than the stage, so one def covers all of them. */
  thoughtTable.ideoOutlook = {
    label: 'Outlook of the faith', durationDays: 0.4, stackLimit: 1,
    stages: [{ label: 'Outlook of the faith', mood: 0 }]
  };

  if (Defs && Defs.add) {
    /* Additive registration: def_pawns.js owns the thought table and is
       not ours to edit, but adding to it is exactly what Defs.add is
       for. Every id here is namespaced, so a clash is impossible. */
    Defs.add('thought', thoughtTable);
  }

  /* ============================================================
     4. RITUALS
     ============================================================ */

  var RITUALS = {
    danceParty: {
      label: 'Dance party', desc: 'Everyone gathers and moves until they are tired.',
      ticks: 5000, joy: 0.45, social: 0.7, cooldownDays: 2, spontaneous: true
    },
    funeral: {
      label: 'Funeral', desc: 'The colony stands over the dead and says the words.',
      ticks: 3600, joy: 0.10, social: 1.0, cooldownDays: 0, spontaneous: false,
      requiresPrecept: { funerals: ['expected', 'essential'] }, onDone: 'funeralHeld'
    },
    animalSacrifice: {
      label: 'Animal sacrifice', desc: 'A beast is given up so the colony is not.',
      ticks: 3000, joy: 0.15, social: 0.8, cooldownDays: 3, spontaneous: true,
      requiresPrecept: { animals: ['livestock', 'valued'] }, onDone: 'animalSlaughtered'
    },
    humanSacrifice: {
      label: 'Human sacrifice', desc: 'A prisoner is given up on the altar.',
      ticks: 4200, joy: 0.10, social: 1.2, cooldownDays: 6, spontaneous: false,
      requiresPrecept: { execution: ['acceptable', 'honourable'] }, onDone: 'prisonerExecuted',
      needsPrisoner: true
    },
    speech: {
      label: 'Speech', desc: 'The leader speaks and the colony listens.',
      ticks: 2400, joy: 0.20, social: 1.1, cooldownDays: 2, spontaneous: true, leadRole: 'leader'
    },
    harvestFeast: {
      label: 'Harvest feast', desc: 'A table, everything ripe, and no work until it is gone.',
      ticks: 4800, joy: 0.50, social: 0.9, cooldownDays: 5, spontaneous: true,
      onDone: 'ateNewFood'
    },
    comingOfAge: {
      label: 'Coming of age', desc: 'A young colonist is counted as an adult.',
      ticks: 3000, joy: 0.25, social: 1.0, cooldownDays: 8, spontaneous: false
    },
    trial: {
      label: 'Trial', desc: 'Someone is made to answer for breaking the precepts.',
      ticks: 3600, joy: 0.05, social: 1.2, cooldownDays: 4, spontaneous: false
    },
    bestowingCeremony: {
      label: 'Bestowing ceremony', desc: 'A role is handed over in front of everyone.',
      ticks: 2400, joy: 0.20, social: 1.0, cooldownDays: 3, spontaneous: false
    }
  };

  /* ============================================================
     5. ROLES
     ============================================================ */

  var ROLES = {
    leader: {
      label: 'Leader', always: true, skill: 'social',
      desc: 'Speaks for the colony and holds it together.',
      ability: { id: 'inspireSpeech', label: 'Inspiring speech', cooldownDays: 1.5 },
      mood: 0.04, work: {}
    },
    moralGuide: {
      label: 'Moral guide', always: true, skill: 'social',
      desc: 'Runs the rituals and brings the doubting back.',
      ability: { id: 'convertRite', label: 'Conversion rite', cooldownDays: 0.6 },
      mood: 0.04, work: {}
    },
    production: {
      label: 'Production specialist', skill: 'crafting',
      desc: 'The hands the faith works through.',
      ability: { id: 'workFrenzy', label: 'Work frenzy', cooldownDays: 1 },
      mood: 0.03, work: { craft: 1.15, construct: 1.10 }
    },
    combat: {
      label: 'Combat specialist', skill: 'shooting',
      desc: 'The blade the faith is defended with.',
      ability: { id: 'battleFocus', label: 'Battle focus', cooldownDays: 1 },
      mood: 0.03, work: { hunt: 1.10 }
    },
    research: {
      label: 'Research specialist', skill: 'intellectual',
      desc: 'Reads the world for the faith.',
      ability: { id: 'insight', label: 'Flash of insight', cooldownDays: 1.5 },
      mood: 0.03, work: { research: 1.20 }
    },
    animal: {
      label: 'Animal specialist', skill: 'animals',
      desc: 'Speaks for the beasts the faith keeps.',
      ability: { id: 'beastCall', label: 'Beast call', cooldownDays: 1 },
      mood: 0.03, work: { handle: 1.20 }
    }
  };

  /* ============================================================
     6. Module state
     ============================================================ */

  var state = null;

  function freshState() {
    return {
      ideos: {},              /* id -> ideoligion                        */
      nextIdeoId: 1,
      colonyId: null,
      byFaction: {},          /* faction id -> ideoligion id             */
      ritual: null,
      lastRitualTick: -RITUAL_INTERVAL,
      nextRitualTick: RITUAL_INTERVAL,
      relicThingId: 0,
      lastBeatTick: 0,
      log: []                 /* recent ritual results, for the UI       */
    };
  }

  function ensureState() {
    if (!state) state = freshState();
    return state;
  }

  Ideology.reset = function () { state = freshState(); return Ideology; };

  /* ============================================================
     7. Table accessors - the "registry" for content nobody else owns
     ============================================================ */

  function tableList(table) {
    return Object.keys(table).map(function (id) {
      var d = table[id];
      if (!d.id) d.id = id;
      return d;
    });
  }

  Ideology.memes = function () { return tableList(MEMES); };
  Ideology.precepts = function () { return tableList(PRECEPTS); };
  Ideology.ritualDefs = function () { return tableList(RITUALS); };
  Ideology.roles = function () { return tableList(ROLES); };
  Ideology.meme = function (id) { return MEMES[id] || null; };
  Ideology.preceptDef = function (id) { return PRECEPTS[id] || null; };
  Ideology.ritualDef = function (id) { return RITUALS[id] || null; };
  Ideology.role = function (id) { return ROLES[id] || null; };
  Ideology.thoughts = function () { return thoughtTable; };

  /* A cheap consistency pass over the tables, so a typo in a degree name
     is a line of text rather than a precept that silently never fires. */
  Ideology.selfCheck = function () {
    var bad = [];
    Object.keys(MEMES).forEach(function (mid) {
      var m = MEMES[mid];
      Object.keys(m.requires || {}).forEach(function (pid) {
        var p = PRECEPTS[pid];
        if (!p) return bad.push(mid + ' requires unknown precept ' + pid);
        if (p.degrees.indexOf(m.requires[pid]) < 0) {
          bad.push(mid + ' requires ' + pid + '/' + m.requires[pid] + ' which is not a degree');
        }
      });
      Object.keys(m.forbids || {}).forEach(function (pid) {
        var p = PRECEPTS[pid];
        if (!p) return bad.push(mid + ' forbids unknown precept ' + pid);
        m.forbids[pid].forEach(function (d) {
          if (p.degrees.indexOf(d) < 0) bad.push(mid + ' forbids unknown degree ' + pid + '/' + d);
        });
      });
      (m.conflicts || []).forEach(function (other) {
        if (!MEMES[other]) bad.push(mid + ' conflicts with unknown meme ' + other);
        else if ((MEMES[other].conflicts || []).indexOf(mid) < 0) {
          bad.push(mid + ' conflicts with ' + other + ' but not the other way round');
        }
      });
    });
    Object.keys(PRECEPTS).forEach(function (pid) {
      var p = PRECEPTS[pid];
      if (p.degrees.indexOf(p.def) < 0) bad.push(pid + ' default ' + p.def + ' is not a degree');
      Object.keys(p.reactions).forEach(function (a) {
        var r = p.reactions[a];
        if (r.stages.length !== p.degrees.length) {
          bad.push(pid + '/' + a + ' has ' + r.stages.length + ' stages for ' +
                   p.degrees.length + ' degrees');
        }
        if (!thoughtTable[r.thought]) bad.push(pid + '/' + a + ' fires unregistered ' + r.thought);
      });
    });
    Object.keys(DENIALS).forEach(function (a) {
      var d = DENIALS[a];
      var p = PRECEPTS[d.precept];
      if (!p) return bad.push('denial ' + a + ' names unknown precept ' + d.precept);
      d.deny.forEach(function (deg) {
        if (p.degrees.indexOf(deg) < 0) bad.push('denial ' + a + ' names unknown degree ' + deg);
      });
    });
    return bad;
  };

  /* ============================================================
     8. Generation
     ============================================================ */

  var NAME_A = ['Kelvin', 'Ostren', 'Vaska', 'Mora', 'Tal', 'Dren', 'Sunward', 'Ashen',
                'Quiet', 'Iron', 'Low', 'Far', 'Old', 'First', 'Black', 'Pale'];
  var NAME_B = ['ism', 'ite Way', 'an Creed', 'ic Path', 'ard Faith', 'ene Order',
                'ist Church', 'ine Communion'];
  var NAME_C = ['of the Long Dusk', 'of the Turning Sky', 'of the Deep Stone',
                'of the Second Landing', 'of the Open Hand', 'of the Red Harvest',
                'of the Nine Vows', 'of the Waking Root'];
  var SYMBOLS = ['sun', 'tree', 'skull', 'eye', 'flame', 'spiral', 'mountain', 'hand',
                 'moon', 'blade', 'seed', 'star'];
  var STYLES = ['archaic', 'rustic', 'spikecore', 'techist', 'morbid', 'solemn'];
  var COLOURS = [
    ['#c0392b', '#ffc23c'], ['#4a7fd4', '#e8e2d4'], ['#5c7a3e', '#8a6134'],
    ['#6b4b8a', '#ffc23c'], ['#2f5d78', '#b08c5a'], ['#141821', '#8f97a3'],
    ['#8b1a1a', '#141821'], ['#c2b280', '#5a5a62']
  ];

  function ideoName() {
    var roll = U.rand();
    if (roll < 0.45) return U.pick(NAME_A) + U.pick(NAME_B);
    if (roll < 0.8) return U.pick(NAME_A) + U.pick(NAME_B) + ' ' + U.pick(NAME_C);
    return 'The Church ' + U.pick(NAME_C);
  }

  function memeConflicts(chosen, candidate) {
    var cand = MEMES[candidate];
    for (var i = 0; i < chosen.length; i++) {
      var have = MEMES[chosen[i]];
      if ((cand.conflicts || []).indexOf(chosen[i]) >= 0) return true;
      if ((have.conflicts || []).indexOf(candidate) >= 0) return true;
      /* Two memes that force the same precept to different degrees would
         make an ideoligion that contradicts itself the moment it fires. */
      var mine = cand.requires || {}, theirs = have.requires || {};
      for (var pid in mine) {
        if (theirs[pid] !== undefined && theirs[pid] !== mine[pid]) return true;
      }
      for (var fid in (cand.forbids || {})) {
        if (theirs[fid] !== undefined && cand.forbids[fid].indexOf(theirs[fid]) >= 0) return true;
      }
      for (var gid in (have.forbids || {})) {
        if (mine[gid] !== undefined && have.forbids[gid].indexOf(mine[gid]) >= 0) return true;
      }
    }
    return false;
  }

  function pickMemes(count, seedMemes) {
    var chosen = [];
    var i;
    for (i = 0; i < (seedMemes || []).length; i++) {
      if (MEMES[seedMemes[i]] && !memeConflicts(chosen, seedMemes[i])) chosen.push(seedMemes[i]);
    }
    var pool = Object.keys(MEMES).filter(function (id) { return chosen.indexOf(id) < 0; });
    U.shuffle(pool);

    /* Half of all ideoligions get a structure meme, and never two. */
    var hasStructure = chosen.some(function (id) { return MEMES[id].category === 'structure'; });
    if (!hasStructure && U.chance(0.5)) {
      for (i = 0; i < pool.length; i++) {
        if (MEMES[pool[i]].category !== 'structure') continue;
        if (memeConflicts(chosen, pool[i])) continue;
        chosen.push(pool[i]);
        pool.splice(i, 1);
        break;
      }
    }
    for (i = 0; i < pool.length && chosen.length < count; i++) {
      if (MEMES[pool[i]].category === 'structure') continue;
      if (memeConflicts(chosen, pool[i])) continue;
      chosen.push(pool[i]);
    }
    return chosen;
  }

  /* Precepts follow from the memes, and whatever the memes are silent
     about is rolled: mostly the default, sometimes a step either way. */
  function resolvePrecepts(memes) {
    var out = {};
    var forced = {}, banned = {};
    memes.forEach(function (mid) {
      var m = MEMES[mid];
      Object.keys(m.requires || {}).forEach(function (pid) {
        if (PRECEPTS[pid]) forced[pid] = m.requires[pid];
      });
      Object.keys(m.forbids || {}).forEach(function (pid) {
        if (!PRECEPTS[pid]) return;
        banned[pid] = (banned[pid] || []).concat(m.forbids[pid]);
      });
    });

    Object.keys(PRECEPTS).forEach(function (pid) {
      var p = PRECEPTS[pid];
      var degree;
      if (forced[pid] !== undefined) {
        degree = forced[pid];
      } else {
        var at = p.degrees.indexOf(p.def);
        var roll = U.rand();
        if (roll < 0.62) degree = p.def;
        else if (roll < 0.81) degree = p.degrees[Math.max(0, at - 1)];
        else degree = p.degrees[Math.min(p.degrees.length - 1, at + 1)];
      }
      var bans = banned[pid];
      if (bans && bans.indexOf(degree) >= 0) {
        for (var i = 0; i < p.degrees.length; i++) {
          if (bans.indexOf(p.degrees[i]) < 0) { degree = p.degrees[i]; break; }
        }
      }
      out[pid] = degree;
    });
    return out;
  }

  function pickRoles(memes) {
    var roles = [{ id: 'leader', pawnId: 0 }, { id: 'moralGuide', pawnId: 0 }];
    var extras = ['production', 'combat', 'research', 'animal'];
    U.shuffle(extras);
    var n = U.randInt(1, 3);
    if (memes.indexOf('rancher') >= 0 && extras.indexOf('animal') >= 0) {
      roles.push({ id: 'animal', pawnId: 0 });
      U.remove(extras, 'animal');
      n--;
    }
    for (var i = 0; i < n && i < extras.length; i++) roles.push({ id: extras[i], pawnId: 0 });
    return roles;
  }

  Ideology.generate = function (opts) {
    opts = opts || {};
    ensureState();
    var count = opts.memeCount || U.randInt(1, 4);
    var memes = pickMemes(U.clamp(count, 1, 4), opts.memes);
    if (!memes.length) memes = pickMemes(1, null);
    var colour = U.pick(COLOURS);
    var ideo = {
      id: opts.id || ('ideo' + (state.nextIdeoId++)),
      name: opts.name || ideoName(),
      memes: memes,
      precepts: resolvePrecepts(memes),
      roles: pickRoles(memes),
      colors: { primary: colour[0], secondary: colour[1] },
      symbol: opts.symbol || U.pick(SYMBOLS),
      style: opts.style || U.pick(STYLES),
      foundedTick: now(),
      description: memes.map(function (m) { return MEMES[m].label; }).join(', ')
    };
    state.ideos[ideo.id] = ideo;
    return ideo;
  };

  /* Three to choose from, for the menu the player starts the game in. */
  Ideology.choices = function (n) {
    var out = [];
    for (var i = 0; i < (n || 3); i++) out.push(Ideology.generate({}));
    return out;
  };

  Ideology.adopt = function (ideo) {
    ensureState();
    if (!ideo) return null;
    if (typeof ideo === 'string') ideo = state.ideos[ideo];
    if (!ideo) return null;
    state.ideos[ideo.id] = ideo;
    state.colonyId = ideo.id;
    state.byFaction.player = ideo.id;

    var G = game();
    var map = G && G.map;
    if (map && map.colonists) {
      var list = map.colonists();
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        ensurePawn(p);
        p.ideo.ideoId = ideo.id;
        p.ideo.certainty = U.clamp(U.gauss(0.85, 0.12, 0.4, 1), 0, 1);
      }
    }
    return ideo;
  };

  Ideology.colony = function () {
    ensureState();
    if (state.colonyId && state.ideos[state.colonyId]) return state.ideos[state.colonyId];
    /* Nobody chose one, which is the normal case for a colony that
       landed before the player was offered the menu. Found one now so
       every question below this line has an answer. */
    return Ideology.adopt(Ideology.generate({}));
  };

  Ideology.get = function (id) { ensureState(); return state.ideos[id] || null; };
  Ideology.all = function () {
    ensureState();
    return Object.keys(state.ideos).map(function (k) { return state.ideos[k]; });
  };

  /* Everyone who is not a colonist believes something too, or conversion
     would have nothing to push against. One faith per faction, made once
     and remembered. */
  function factionIdeo(factionId) {
    ensureState();
    if (!factionId || factionId === 'player') return Ideology.colony();
    var id = state.byFaction[factionId];
    if (id && state.ideos[id]) return state.ideos[id];
    var made = Ideology.generate({});
    state.byFaction[factionId] = made.id;
    return made;
  }

  /* ============================================================
     9. Pawns, certainty and conversion
     ============================================================ */

  function isHuman(pawn) {
    return !!(pawn && pawn.isHuman !== false && !pawn.isAnimal);
  }

  function ensurePawn(pawn) {
    if (!pawn || !isHuman(pawn)) return null;
    if (!pawn.ideo || typeof pawn.ideo !== 'object') {
      var faith = factionIdeo(pawn.faction);
      pawn.ideo = {
        ideoId: faith ? faith.id : null,
        certainty: 0.8,
        roleId: null,
        resentment: 0,
        lastConvertTick: -CONVERT_COOLDOWN,
        lastRitualTick: -DAY,
        lastPenanceTick: -DAY,
        lastDrugTick: -10 * DAY,
        implants: 0,
        abilityTicks: {},
        boosts: []
      };
    }
    if (typeof pawn.ideo.certainty !== 'number') pawn.ideo.certainty = 0.8;
    if (!pawn.ideo.abilityTicks) pawn.ideo.abilityTicks = {};
    if (!pawn.ideo.boosts) pawn.ideo.boosts = [];
    return pawn.ideo;
  }
  Ideology.ensure = ensurePawn;

  Ideology.of = function (pawn) {
    if (!pawn || !isHuman(pawn)) return null;
    var st = ensurePawn(pawn);
    if (!st) return null;
    ensureState();
    var found = st.ideoId && state.ideos[st.ideoId];
    if (found) return found;
    /* The id points at nothing: a save restored without the module
       state, or a faith that was dropped. Fall back rather than crash. */
    var faith = factionIdeo(pawn.faction);
    st.ideoId = faith ? faith.id : null;
    return faith;
  };

  Ideology.certainty = function (pawn) {
    var st = ensurePawn(pawn);
    return st ? U.clamp01(st.certainty) : 0;
  };

  Ideology.setIdeo = function (pawn, ideo, certainty) {
    var st = ensurePawn(pawn);
    if (!st || !ideo) return false;
    ensureState();
    var id = typeof ideo === 'string' ? ideo : ideo.id;
    if (!state.ideos[id]) return false;
    st.ideoId = id;
    st.certainty = certainty === undefined ? 0.5 : U.clamp01(certainty);
    st.resentment = 0;
    st.roleId = null;
    return true;
  };

  Ideology.sameFaith = function (a, b) {
    var ia = Ideology.of(a), ib = Ideology.of(b);
    return !!(ia && ib && ia.id === ib.id);
  };

  /* A conversion attempt: the guide's social skill and their own
     certainty against the target's. At zero certainty the target simply
     switches, which is what makes prisoners worth talking to. */
  Ideology.convertAttempt = function (guide, target) {
    var gst = ensurePawn(guide), tst = ensurePawn(target);
    if (!gst || !tst || guide === target) return { ok: false, reason: 'nobody to talk to' };
    var faith = Ideology.of(guide);
    var theirs = Ideology.of(target);
    if (!faith) return { ok: false, reason: 'no faith to preach' };
    if (theirs && theirs.id === faith.id) return { ok: false, reason: 'already a believer' };

    var social = guide.skillLevel ? guide.skillLevel('social') : 4;
    var power = CONVERT_POWER * (0.5 + 0.06 * social) * (0.6 + 0.5 * gst.certainty);
    if (Ideology.roleOf(guide) === 'moralGuide') power *= 1.6;
    var resist = 1;
    if (target.traits && target.traits.indexOf('ironWilled') >= 0) resist = 0.6;
    if (target.prisoner) resist *= 0.85;
    var delta = power * resist * U.randRange(0.7, 1.3);

    tst.certainty = U.clamp01(tst.certainty - delta);
    gst.lastConvertTick = now();
    var N = sys('Needs');
    if (N && N.addThought) N.addThought(target, 'ideoPreachedAt', { otherPawnId: guide.id });

    if (tst.certainty <= 0.001) {
      Ideology.setIdeo(target, faith, 0.42);
      if (N && N.addThought) N.addThought(target, 'ideoConverted');
      var G = game();
      if (G && G.letter) {
        G.letter('A conversion',
          nameOf(target) + ' has come round to ' + faith.name + '. ' +
          nameOf(guide) + ' talked them through it.',
          { kind: 'good', x: target.x, y: target.y });
      }
      return { ok: true, converted: true, delta: delta };
    }
    return { ok: true, converted: false, delta: delta, certainty: tst.certainty };
  };

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    var n = pawn.name;
    if (!n) return 'someone';
    return n.nick || n.first || 'someone';
  }

  /* ============================================================
     10. Precept queries and the action hook
     ============================================================ */

  Ideology.precept = function (ideo, id) {
    var p = PRECEPTS[id];
    if (!p) return null;
    if (typeof ideo === 'object' && ideo && ideo.isHuman !== undefined) ideo = Ideology.of(ideo);
    /* No ideoligion named means the colony's, which is what a UI panel
       and a caller that has not been handed one both mean by it. */
    if (!ideo) ideo = Ideology.colony();
    var degree = (ideo && ideo.precepts && ideo.precepts[id]) || p.def;
    var index = p.degrees.indexOf(degree);
    if (index < 0) { degree = p.def; index = p.degrees.indexOf(degree); }
    return { precept: id, label: p.label, id: degree, index: index, count: p.degrees.length };
  };

  Ideology.preceptIs = function (ideo, id, degreeId) {
    var d = Ideology.precept(ideo, id);
    return !!d && d.id === degreeId;
  };

  Ideology.hasMeme = function (ideo, memeId) {
    if (typeof ideo === 'object' && ideo && ideo.isHuman !== undefined) ideo = Ideology.of(ideo);
    return !!(ideo && ideo.memes && ideo.memes.indexOf(memeId) >= 0);
  };

  Ideology.allows = function (ideo, action) {
    var canon = canonical(action);
    var rule = DENIALS[canon];
    if (!rule) return true;
    var d = Ideology.precept(ideo, rule.precept);
    if (!d) return true;
    return rule.deny.indexOf(d.id) < 0;
  };

  /* Callers will spell things however they spell them, and an action
     nobody thought of must cost nothing but a lookup. */
  var ALIASES = {
    atehumanmeat: 'eatHumanMeat', ate_human_meat: 'eatHumanMeat', humanmeal: 'eatHumanMeat',
    eathuman: 'eatHumanMeat', cannibalism: 'eatHumanMeat',
    butcheredhuman: 'butcherHuman', butcherhuman: 'butcherHuman',
    sawcorpse: 'corpseSeen', observedcorpse: 'corpseSeen', corpse: 'corpseSeen',
    corpseleft: 'corpseRotting', rottingcorpse: 'corpseRotting',
    buried: 'corpseBuried', burial: 'corpseBuried',
    execution: 'prisonerExecuted', executed: 'prisonerExecuted', execute: 'prisonerExecuted',
    prisonerexecuted: 'prisonerExecuted',
    implant: 'implantInstalled', implantinstalled: 'implantInstalled',
    surgeryimplant: 'implantInstalled',
    tattoo: 'skinModInstalled', skinmod: 'skinModInstalled',
    drug: 'tookDrug', tookdrug: 'tookDrug', drugtaken: 'tookDrug',
    choppedtree: 'treeCut', treecut: 'treeCut', chopwood: 'treeCut', treechopped: 'treeCut',
    treeplanted: 'treePlanted', sowedtree: 'treePlanted',
    mined: 'minedRock', minedrock: 'minedRock', mining: 'minedRock',
    built: 'builtStructure', builtstructure: 'builtStructure', construction: 'builtStructure',
    slaughter: 'animalSlaughtered', animalslaughtered: 'animalSlaughtered',
    tamed: 'animalTamed', animaltamed: 'animalTamed',
    raid: 'raidLaunched', raided: 'raidLaunched', raidlaunched: 'raidLaunched',
    raidbeaten: 'raidBeaten', raiddefeated: 'raidBeaten',
    charity: 'gaveCharity', gift: 'gaveCharity', gavecharity: 'gaveCharity',
    refusedcharity: 'refusedCharity',
    nude: 'wasNude', naked: 'wasNude', wasnude: 'wasNude',
    clothed: 'wasClothed', woreclothes: 'wasClothed',
    lovin: 'lovin', slept: 'lovin',
    funeral: 'funeralHeld', funeralheld: 'funeralHeld', funeralskipped: 'funeralSkipped',
    worked: 'workedHard', workedhard: 'workedHard', longshift: 'workedHard',
    idle: 'idled', idled: 'idled',
    samefood: 'ateSameFood', atesamefood: 'ateSameFood',
    newfood: 'ateNewFood', atenewfood: 'ateNewFood',
    slave: 'slaveOwned', slaveowned: 'slaveOwned', slavefreed: 'slaveFreed',
    grandroom: 'grandRoom', woundtended: 'woundTended', tended: 'woundTended',
    ritual: 'ritualHeld', ritualheld: 'ritualHeld'
  };

  /* action -> [{preceptId, reaction}], built once at load. */
  var ACTION_MAP = {};
  Object.keys(PRECEPTS).forEach(function (pid) {
    Object.keys(PRECEPTS[pid].reactions).forEach(function (action) {
      (ACTION_MAP[action] || (ACTION_MAP[action] = []))
        .push({ preceptId: pid, reaction: PRECEPTS[pid].reactions[action] });
    });
  });

  function canonical(action) {
    if (!action) return '';
    if (typeof action === 'object') action = action.id || action.action || '';
    if (ACTION_MAP[action] || DENIALS[action]) return action;
    var key = String(action).toLowerCase().replace(/[^a-z]/g, '');
    return ALIASES[key] || action;
  }
  Ideology.canonicalAction = canonical;

  function memeOpinion(ideo, action) {
    if (!ideo || !ideo.memes) return 1;
    var factor = 1;
    for (var i = 0; i < ideo.memes.length; i++) {
      var m = MEMES[ideo.memes[i]];
      if (m && m.opinion && typeof m.opinion[action] === 'number') factor *= m.opinion[action];
    }
    return factor;
  }

  /* The one hook the rest of the game needs. Forgiving on purpose:
     an unknown action, an animal, a pawn with no faith and a missing
     Needs module all fall out quietly rather than throwing into
     somebody else's tick. */
  Ideology.noteAction = function (pawn, action, opts) {
    opts = opts || {};
    if (!pawn || !isHuman(pawn) || pawn.dead) return null;
    var canon = canonical(action);
    var rows = ACTION_MAP[canon];
    if (!rows) return null;
    var ideo = Ideology.of(pawn);
    if (!ideo) return null;
    var N = sys('Needs');
    if (!N || !N.addThought) return null;

    ensurePawn(pawn);
    var scale = typeof opts.scale === 'number' ? opts.scale : 1;
    var fired = [], best = null, bestGroup = null;
    var i, row, precept, degree, stage, mood;

    for (i = 0; i < rows.length; i++) {
      row = rows[i];
      precept = PRECEPTS[row.preceptId];
      /* A gendered precept only speaks about that gender. The subject is
         whoever the act was about, which is not always the pawn feeling
         it - a man walking past an unclothed woman reads her precept. */
      if (precept.appliesTo) {
        var subject = opts.gender || (opts.subject && opts.subject.gender) || pawn.gender;
        if (subject !== precept.appliesTo) continue;
      }
      degree = Ideology.precept(ideo, row.preceptId);
      stage = row.reaction.stages[degree.index];
      if (!stage) continue;
      mood = stage[1] * scale * memeOpinion(ideo, canon);
      if (!mood) continue;

      /* Precepts in the same exclusive group are two ways of saying the
         same thing; only the loudest one gets to speak. */
      if (precept.group) {
        if (!best || Math.abs(mood) > Math.abs(best.mood)) {
          best = { reaction: row.reaction, mood: mood, degree: degree };
          bestGroup = precept.group;
        }
        continue;
      }
      fired.push(fireThought(pawn, row.reaction, degree.index, mood, opts, N));
    }
    if (best && bestGroup) fired.push(fireThought(pawn, best.reaction, best.degree.index, best.mood, opts, N));

    /* A colonist watching their faith trampled builds resentment, and a
       colonist watching it upheld loses some. Resentment is what turns a
       run of violations into doubt and eventually into a new faith. */
    var swing = 0;
    for (i = 0; i < fired.length; i++) swing += fired[i] ? fired[i].mood : 0;
    var st = pawn.ideo;
    if (swing < 0) st.resentment = U.clamp01(st.resentment + Math.min(0.3, -swing * 0.8));
    else if (swing > 0) {
      st.resentment = U.clamp01(st.resentment - swing * 0.4);
      st.certainty = U.clamp01(st.certainty + swing * 0.15);
    }
    if (canon === 'tookDrug') st.lastDrugTick = now();

    /* Witnesses feel the same act, a little less. Kept off by default so
       a caller that loops the colony itself does not double up. */
    if (opts.witnesses && !opts.isWitness) {
      var map = pawn.map;
      var radius = opts.radius || 12;
      if (map && map.colonists) {
        var crowd = map.colonists();
        for (i = 0; i < crowd.length; i++) {
          var other = crowd[i];
          if (other === pawn || other.dead) continue;
          if (U.cheb(other.x, other.y, pawn.x, pawn.y) > radius) continue;
          Ideology.noteAction(other, canon, {
            scale: scale * 0.6, isWitness: true, gender: opts.gender, subject: opts.subject
          });
        }
      }
    }
    return { action: canon, thoughts: fired, resentment: st.resentment };
  };

  function fireThought(pawn, reaction, degreeIndex, mood, opts, N) {
    var entry = N.addThought(pawn, reaction.thought, {
      degree: degreeIndex,
      mood: mood,
      otherPawnId: opts.otherPawnId === undefined ? null : opts.otherPawnId
    });
    return entry ? { id: reaction.thought, mood: mood, degree: degreeIndex } : null;
  }

  /* ============================================================
     11. Roles and their abilities
     ============================================================ */

  Ideology.roleOf = function (pawn) {
    var st = ensurePawn(pawn);
    return st ? st.roleId : null;
  };

  Ideology.roleHolder = function (roleId, map) {
    var G = game();
    map = map || (G && G.map);
    if (!map || !map.colonists) return null;
    var list = map.colonists();
    for (var i = 0; i < list.length; i++) {
      if (!list[i].dead && Ideology.roleOf(list[i]) === roleId) return list[i];
    }
    return null;
  };

  Ideology.assignRole = function (pawn, roleId) {
    var st = ensurePawn(pawn);
    var role = ROLES[roleId];
    if (!st || !role) return false;
    var ideo = Ideology.of(pawn);
    if (!ideo) return false;
    var slot = null;
    for (var i = 0; i < ideo.roles.length; i++) {
      if (ideo.roles[i].id === roleId) slot = ideo.roles[i];
    }
    if (!slot) { slot = { id: roleId, pawnId: 0 }; ideo.roles.push(slot); }

    var previous = Ideology.roleHolder(roleId, pawn.map);
    if (previous && previous !== pawn) Ideology.unassignRole(previous);
    if (st.roleId && st.roleId !== roleId) Ideology.unassignRole(pawn);

    st.roleId = roleId;
    slot.pawnId = pawn.id;
    var N = sys('Needs');
    if (N && N.addThought) N.addThought(pawn, 'ideoRoleGained');
    return true;
  };

  Ideology.unassignRole = function (pawn) {
    var st = ensurePawn(pawn);
    if (!st || !st.roleId) return false;
    var ideo = Ideology.of(pawn);
    if (ideo) {
      for (var i = 0; i < ideo.roles.length; i++) {
        if (ideo.roles[i].pawnId === pawn.id) ideo.roles[i].pawnId = 0;
      }
    }
    st.roleId = null;
    var N = sys('Needs');
    if (N && N.addThought) N.addThought(pawn, 'ideoRoleLost');
    return true;
  };

  /* Fill every empty slot with whoever is best at the role's skill.
     Called after a ritual and whenever the player asks for it. */
  Ideology.autoAssignRoles = function (map) {
    var G = game();
    map = map || (G && G.map);
    var ideo = Ideology.colony();
    if (!map || !map.colonists || !ideo) return 0;
    var free = map.colonists().filter(function (p) {
      return !p.dead && !Ideology.roleOf(p) && Ideology.sameFaithAsColony(p);
    });
    var filled = 0;
    for (var i = 0; i < ideo.roles.length; i++) {
      var slot = ideo.roles[i];
      if (Ideology.roleHolder(slot.id, map)) continue;
      if (!free.length) break;
      var role = ROLES[slot.id];
      var best = U.maxBy(free, function (p) {
        return (p.skillLevel ? p.skillLevel(role.skill) : 0) + Ideology.certainty(p) * 2;
      });
      if (!best) break;
      U.remove(free, best);
      if (Ideology.assignRole(best, slot.id)) filled++;
    }
    return filled;
  };

  Ideology.sameFaithAsColony = function (pawn) {
    var ideo = Ideology.of(pawn);
    ensureState();
    return !!(ideo && ideo.id === state.colonyId);
  };

  var ABILITIES = {
    inspireSpeech: function (pawn) {
      var map = pawn.map;
      var N = sys('Needs');
      var n = 0;
      if (!map || !N) return 0;
      var list = map.colonists();
      for (var i = 0; i < list.length; i++) {
        if (list[i].dead) continue;
        N.addThought(list[i], 'ideoRitual', { degree: 2, duration: 1.5 * DAY });
        n++;
      }
      return n;
    },
    convertRite: function (pawn) {
      var map = pawn.map;
      if (!map) return 0;
      var targets = map.pawns.filter(function (p) {
        return isHuman(p) && !p.dead && p !== pawn && U.cheb(p.x, p.y, pawn.x, pawn.y) <= 8 &&
               !Ideology.sameFaith(pawn, p);
      });
      if (!targets.length) return 0;
      var r = Ideology.convertAttempt(pawn, targets[0]);
      return r && r.ok ? 1 : 0;
    },
    workFrenzy: function (pawn) { return addBoost(pawn, 'workFrenzy', 0.6 * DAY, { work: 1.4 }); },
    battleFocus: function (pawn) { return addBoost(pawn, 'battleFocus', 0.4 * DAY, { combat: 1.3 }); },
    insight: function (pawn) { return addBoost(pawn, 'insight', 0.5 * DAY, { research: 1.6 }); },
    beastCall: function (pawn) { return addBoost(pawn, 'beastCall', 0.5 * DAY, { animals: 1.5 }); }
  };

  function addBoost(pawn, id, ticks, fx) {
    var st = ensurePawn(pawn);
    if (!st) return 0;
    for (var i = 0; i < st.boosts.length; i++) {
      if (st.boosts[i].id === id) { st.boosts[i].ticksLeft = ticks; return 1; }
    }
    st.boosts.push({ id: id, ticksLeft: ticks, work: fx.work || 1, combat: fx.combat || 1,
                     research: fx.research || 1, animals: fx.animals || 1 });
    var N = sys('Needs');
    if (N && N.addThought) N.addThought(pawn, 'ideoInspired', { duration: ticks });
    return 1;
  }

  Ideology.canCast = function (pawn, abilityId) {
    var st = ensurePawn(pawn);
    if (!st || !st.roleId) return false;
    var role = ROLES[st.roleId];
    if (!role || !role.ability) return false;
    if (abilityId && role.ability.id !== abilityId) return false;
    var last = st.abilityTicks[role.ability.id] || -1e9;
    return now() - last >= role.ability.cooldownDays * DAY;
  };

  Ideology.cast = function (pawn, abilityId) {
    var st = ensurePawn(pawn);
    if (!st || !st.roleId) return { ok: false, reason: 'no role' };
    var role = ROLES[st.roleId];
    if (!role.ability) return { ok: false, reason: 'that role has no ability' };
    var id = abilityId || role.ability.id;
    if (role.ability.id !== id) return { ok: false, reason: 'not this role\'s ability' };
    if (!Ideology.canCast(pawn, id)) return { ok: false, reason: 'still recharging' };
    var fn = ABILITIES[id];
    if (!fn) return { ok: false, reason: 'unknown ability' };
    var affected = fn(pawn) | 0;
    st.abilityTicks[id] = now();
    var G = game();
    if (G && G.msg && affected) {
      G.msg(nameOf(pawn) + ' used ' + role.ability.label + '.', { x: pawn.x, y: pawn.y });
    }
    return { ok: true, ability: id, affected: affected };
  };

  /* What the rest of the game should multiply a work rate by. Nobody is
     obliged to call it; roles and memes simply read better when they do. */
  Ideology.workSpeedFactor = function (pawn, workTypeId) {
    var st = ensurePawn(pawn);
    if (!st) return 1;
    var f = 1, i;
    var ideo = Ideology.of(pawn);
    if (ideo) {
      for (i = 0; i < ideo.memes.length; i++) {
        var m = MEMES[ideo.memes[i]];
        if (m && m.work && m.work[workTypeId]) f *= m.work[workTypeId];
      }
    }
    var role = st.roleId && ROLES[st.roleId];
    if (role && role.work && role.work[workTypeId]) f *= role.work[workTypeId];
    for (i = 0; i < st.boosts.length; i++) {
      var b = st.boosts[i];
      if (b.work && b.work !== 1) f *= b.work;
      if (workTypeId === 'research' && b.research !== 1) f *= b.research;
      if (workTypeId === 'handle' && b.animals !== 1) f *= b.animals;
    }
    return f;
  };

  /* ============================================================
     12. Rituals
     ============================================================ */

  function ritualSpot(map) {
    if (!map) return null;
    var candidates = [];
    ['table', 'campfire', 'sculpture', 'stove'].forEach(function (defId) {
      if (!Defs.has('thing', defId)) return;
      var list = map.byDef(defId) || [];
      for (var i = 0; i < list.length && candidates.length < 8; i++) {
        if (list[i].spawned) candidates.push(list[i]);
      }
    });
    var colonists = map.colonists ? map.colonists() : [];
    if (!colonists.length) return null;
    var cx = 0, cy = 0, i;
    for (i = 0; i < colonists.length; i++) { cx += colonists[i].x; cy += colonists[i].y; }
    cx = Math.round(cx / colonists.length);
    cy = Math.round(cy / colonists.length);

    var best = null, bestD = Infinity;
    for (i = 0; i < candidates.length; i++) {
      var c = candidates[i];
      var free = freeCellNear(map, c.x, c.y, 2);
      if (!free) continue;
      var d = U.distSq(free.x, free.y, cx, cy);
      if (d < bestD) { bestD = d; best = free; }
    }
    return best || freeCellNear(map, cx, cy, 8);
  }

  function freeCellNear(map, x, y, radius) {
    var ring = U.cellsInRadius(x, y, radius);
    for (var i = 0; i < ring.length; i++) {
      var cx = ring[i][0], cy = ring[i][1];
      if (!map.inBounds(cx, cy)) continue;
      if (!map.passable(cx, cy)) continue;
      if (map.buildingAt(cx, cy)) continue;
      return { x: cx, y: cy };
    }
    return null;
  }

  Ideology.ritual = function () { ensureState(); return state.ritual; };

  Ideology.canStartRitual = function (defId, map) {
    var def = RITUALS[defId];
    if (!def) return { ok: false, reason: 'no such ritual' };
    ensureState();
    if (state.ritual) return { ok: false, reason: 'a ritual is already running' };
    var G = game();
    map = map || (G && G.map);
    if (!map || !map.colonists || map.colonists().length < 1) {
      return { ok: false, reason: 'nobody to hold it' };
    }
    var ideo = Ideology.colony();
    if (def.requiresPrecept) {
      for (var pid in def.requiresPrecept) {
        var d = Ideology.precept(ideo, pid);
        if (!d || def.requiresPrecept[pid].indexOf(d.id) < 0) {
          return { ok: false, reason: 'our faith does not hold that rite' };
        }
      }
    }
    if (def.needsPrisoner) {
      var P = sys('Prisoners');
      var any = P && P.all ? P.all(map).length : 0;
      if (!any) return { ok: false, reason: 'no prisoner for the altar' };
    }
    return { ok: true };
  };

  Ideology.startRitual = function (g, defId, opts) {
    opts = opts || {};
    ensureState();
    var G = g || game();
    var map = (opts.map) || (G && G.map);
    var can = Ideology.canStartRitual(defId, map);
    if (!can.ok) return null;
    var spot = opts.spot || ritualSpot(map);
    if (!spot) return null;
    var ideo = Ideology.colony();
    var def = RITUALS[defId];

    state.ritual = {
      defId: defId, ideoId: ideo.id,
      x: spot.x, y: spot.y,
      startTick: now(),
      gatherUntil: now() + RITUAL_GATHER_TICKS,
      endTick: now() + RITUAL_GATHER_TICKS + def.ticks,
      phase: 'gathering',
      leaderId: 0,
      attendees: {},
      interruptions: 0,
      quality: 0
    };
    if (G && G.letter) {
      G.letter(def.label,
        'The colony is gathering for a ' + def.label.toLowerCase() + '. ' + def.desc,
        { kind: 'good', x: spot.x, y: spot.y });
    }
    return state.ritual;
  };

  Ideology.cancelRitual = function (reason) {
    ensureState();
    if (!state.ritual) return false;
    var G = game();
    if (G && G.msg) G.msg('The ' + RITUALS[state.ritual.defId].label.toLowerCase() + ' broke up: ' + (reason || 'nobody came') + '.');
    state.ritual = null;
    state.lastRitualTick = now();
    state.nextRitualTick = now() + RITUAL_INTERVAL;
    return true;
  };

  Ideology.noteRitualInterrupted = function (reason) {
    ensureState();
    if (!state.ritual) return false;
    state.ritual.interruptions++;
    if (state.ritual.interruptions > 6) Ideology.cancelRitual(reason || 'it fell apart');
    return true;
  };

  function ritualQuality(ritual, map) {
    var def = RITUALS[ritual.defId];
    var guide = null;
    if (ritual.leaderId && map && map.pawns) {
      for (var i = 0; i < map.pawns.length; i++) {
        if (map.pawns[i].id === ritual.leaderId) { guide = map.pawns[i]; break; }
      }
    }
    var q = 0.30;
    if (guide) q += 0.02 * (guide.skillLevel ? guide.skillLevel('social') : 0) * (def.social || 1);

    var R = sys('Regions');
    if (R && R.roomAt) {
      var room = R.roomAt(map, ritual.x, ritual.y);
      if (room) q += U.clamp(room.beauty / 40, -0.15, 0.20);
    }

    var colonists = map && map.colonists ? map.colonists().length : 1;
    var came = Object.keys(ritual.attendees).length;
    q += 0.30 * U.clamp01(came / Math.max(1, colonists));

    var faithful = 0, total = 0;
    if (map && map.colonists) {
      var list = map.colonists();
      for (var k = 0; k < list.length; k++) {
        if (!ritual.attendees[list[k].id]) continue;
        total++;
        faithful += Ideology.certainty(list[k]);
      }
    }
    if (total) q += 0.10 * (faithful / total);
    q -= 0.12 * ritual.interruptions;
    return U.clamp01(q);
  }

  function qualityBand(q) {
    if (q >= 0.85) return 3;
    if (q >= 0.62) return 2;
    if (q >= 0.38) return 1;
    return 0;
  }

  function finishRitual(G) {
    var ritual = state.ritual;
    var map = G && G.map;
    if (!ritual || !map) { state.ritual = null; return; }
    var def = RITUALS[ritual.defId];
    var q = ritualQuality(ritual, map);
    var band = qualityBand(q);
    ritual.quality = q;

    var N = sys('Needs');
    var list = map.colonists ? map.colonists() : [];
    var attended = 0, i, p;
    for (i = 0; i < list.length; i++) {
      p = list[i];
      if (p.dead) continue;
      var st = ensurePawn(p);
      if (ritual.attendees[p.id]) {
        attended++;
        if (N && N.addThought) {
          N.addThought(p, 'ideoRitual', { degree: band, duration: (2 + band) * DAY });
        }
        st.certainty = U.clamp01(st.certainty + 0.06 + 0.10 * q);
        st.resentment = U.clamp01(st.resentment - 0.15);
        st.lastRitualTick = now();
        st.lastPenanceTick = now();
      } else if (Ideology.sameFaithAsColony(p) && N && N.addThought) {
        N.addThought(p, 'ideoRitualMissed');
      }
    }

    /* The rite itself is a morally loaded act, and the precepts judge it
       exactly as they judge everything else. */
    if (def.onDone) {
      for (i = 0; i < list.length; i++) {
        if (ritual.attendees[list[i].id]) Ideology.noteAction(list[i], def.onDone, { scale: 1 });
      }
    }

    var reward = null;
    if (band === 3 && U.chance(0.45)) reward = grantReward(G, map, ritual);

    state.log.push({ defId: ritual.defId, tick: now(), quality: Math.round(q * 100) / 100,
                     attended: attended, reward: reward });
    if (state.log.length > 20) state.log.splice(0, state.log.length - 20);

    if (G && G.letter) {
      var word = ['dull', 'decent', 'fine', 'inspiring'][band];
      G.letter(def.label + ' held',
        'The ' + def.label.toLowerCase() + ' was ' + word + '. ' + attended +
        ' of the colony attended.' + (reward ? ' ' + reward.text : ''),
        { kind: 'good', x: ritual.x, y: ritual.y });
    }

    state.ritual = null;
    state.lastRitualTick = now();
    state.nextRitualTick = now() + RITUAL_INTERVAL;
    Ideology.autoAssignRoles(map);
  }

  /* A spectacular rite pays out: somebody walks in off the rim, a relic
     appears, or the faithful are lit up for a day. */
  function grantReward(G, map, ritual) {
    var roll = U.rand();
    var I = sys('Incidents');
    if (roll < 0.34 && I && I.wanderer && I.wanderer(G)) {
      return { kind: 'recruit', text: 'Someone walked in out of the dark and asked to stay.' };
    }
    if (roll < 0.67 && Defs.has('thing', 'sculpture')) {
      var cell = freeCellNear(map, ritual.x, ritual.y, 3);
      if (cell) {
        var relic = map.spawnThing('sculpture', cell.x, cell.y, { faction: 'player', quality: 5 });
        if (relic) {
          state.relicThingId = relic.id;
          return { kind: 'relic', text: 'A relic was made and set down where it stood.' };
        }
      }
    }
    var list = map.colonists ? map.colonists() : [];
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (!ritual.attendees[list[i].id]) continue;
      addBoost(list[i], 'workFrenzy', 0.8 * DAY, { work: 1.3 });
      n++;
    }
    return n ? { kind: 'inspiration', text: 'Everyone who attended came away burning with purpose.' }
             : null;
  }

  /* Which rite the colony would hold if left to itself. */
  function pickSpontaneousRitual(map) {
    var ids = Object.keys(RITUALS).filter(function (id) {
      return RITUALS[id].spontaneous && Ideology.canStartRitual(id, map).ok;
    });
    if (!ids.length) return null;
    var ideo = Ideology.colony();
    return U.pickWeighted(ids, function (id) {
      var w = 1;
      if (id === 'animalSacrifice' && Ideology.hasMeme(ideo, 'rancher')) w += 1;
      if (id === 'harvestFeast' && Ideology.preceptIs(ideo, 'foodVariety', 'demanded')) w += 1;
      if (id === 'speech' && Ideology.roleHolder('leader', map)) w += 1.5;
      return w;
    });
  }

  /* ============================================================
     13. The clock

     One beat advances the ritual and gives a slice of the colony their
     rare-tick upkeep. tickRituals catches up if it has not been called
     for a while, so it behaves the same whether the game tick drives it
     or a work giver asks it a question first.
     ============================================================ */

  /* game.js calls its map tickers as fn(map, game) and everything else
     calls this with the game alone, so the argument is sniffed rather
     than assumed: whichever of the two is the game wins, and a caller
     that passes nothing gets the live one. */
  function gameFrom(a, b) {
    if (a && a.doTick && a.colonists) return a;
    if (b && b.doTick && b.colonists) return b;
    return game();
  }

  Ideology.tickRituals = function (a, b) {
    var G = gameFrom(a, b);
    if (!G || !G.map) return;
    ensureState();
    var t = now();
    if (state.lastBeatTick > t) state.lastBeatTick = t - BEAT;   /* a load rewound the clock */
    var beats = Math.floor((t - state.lastBeatTick) / BEAT);
    if (beats <= 0) return;
    if (beats > MAX_CATCHUP) beats = MAX_CATCHUP;
    for (var i = 0; i < beats; i++) {
      state.lastBeatTick += BEAT;
      beat(G, G.map, state.lastBeatTick);
    }
  };
  Ideology.tick = Ideology.tickRituals;

  function beat(G, map, beatTick) {
    var ritual = state.ritual;
    if (ritual) {
      if (ritual.phase === 'gathering' && beatTick >= ritual.gatherUntil) {
        if (Object.keys(ritual.attendees).length) ritual.phase = 'running';
        else Ideology.cancelRitual('nobody came');
      } else if (ritual.phase === 'running' && beatTick >= ritual.endTick) {
        finishRitual(G);
      }
    } else if (beatTick >= state.nextRitualTick) {
      var pick = pickSpontaneousRitual(map);
      if (pick) Ideology.startRitual(G, pick);
      else state.nextRitualTick = beatTick + DAY;
    }

    /* A faith with nobody to lead it and nobody to speak for it stays
       that way unless something notices, and this is the only thing that
       runs often enough to. The scan is two passes over the colonists
       and only happens when a slot is actually empty. */
    if (beatTick % 1500 < BEAT &&
        (!Ideology.roleHolder('leader', map) || !Ideology.roleHolder('moralGuide', map))) {
      Ideology.autoAssignRoles(map);
    }

    /* The per-pawn slice: one colonist's worth of work every beat, so
       everyone is looked at about once every 250 ticks. */
    var list = map.colonists ? map.colonists() : [];
    var phase = beatTick % RARE;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.dead) continue;
      var mine = p.id % RARE;
      if (((mine - phase) + RARE) % RARE < BEAT) pawnUpkeep(p, map, beatTick);
    }
  }

  function pawnUpkeep(pawn, map, tick) {
    var st = ensurePawn(pawn);
    if (!st) return;
    var ideo = Ideology.of(pawn);
    var N = sys('Needs');
    if (!ideo || !N || !N.addThought) return;

    var i;
    for (i = st.boosts.length - 1; i >= 0; i--) {
      st.boosts[i].ticksLeft -= RARE;
      if (st.boosts[i].ticksLeft <= 0) st.boosts.splice(i, 1);
    }
    if (st.resentment > 0) st.resentment = Math.max(0, st.resentment - RESENTMENT_DECAY * RARE);

    /* Certainty follows the company you keep. Resentment eats into it
       from the other side, which is how a colony that keeps breaking its
       own precepts talks itself out of them. */
    var same = 0, other = 0;
    var list = map.colonists ? map.colonists() : [];
    for (i = 0; i < list.length; i++) {
      var p = list[i];
      if (p === pawn || p.dead) continue;
      if (U.cheb(p.x, p.y, pawn.x, pawn.y) > 16) continue;
      if (Ideology.sameFaith(pawn, p)) same++; else other++;
    }
    var drift = 0;
    if (same > other) drift = CERTAINTY_GAIN * RARE * (1 + 0.1 * same);
    else if (other > same) drift = -CERTAINTY_LOSS * RARE * (1 + 0.1 * other);
    drift -= st.resentment * CERTAINTY_LOSS * RARE;
    st.certainty = U.clamp01(st.certainty + drift);

    if (same > other && same > 0) N.addThought(pawn, 'ideoAmongBelievers', { noStack: true });
    else if (other > 0 && other >= same) N.addThought(pawn, 'ideoAmongUnbelievers', { noStack: true });

    if (st.certainty < 0.45) {
      N.addThought(pawn, 'ideoDoubt', {
        degree: st.certainty < 0.12 ? 2 : (st.certainty < 0.30 ? 1 : 0), noStack: true
      });
    }
    if (st.resentment > 0.20) {
      N.addThought(pawn, 'ideoResentment', {
        degree: st.resentment > 0.65 ? 2 : (st.resentment > 0.40 ? 1 : 0), noStack: true
      });
    }
    if (Ideology.sameFaithAsColony(pawn) && !Ideology.roleHolder('moralGuide', map)) {
      N.addThought(pawn, 'ideoNoMoralGuide', { noStack: true });
    }
    if (state.relicThingId && map.thing && map.thing(state.relicThingId)) {
      var relic = map.thing(state.relicThingId);
      if (relic && relic.spawned && U.cheb(relic.x, relic.y, pawn.x, pawn.y) <= 12) {
        N.addThought(pawn, 'ideoRelic', { noStack: true });
      }
    }

    for (i = 0; i < ideo.memes.length; i++) {
      var meme = MEMES[ideo.memes[i]];
      if (!meme || !meme.situation) continue;
      var side = SITUATIONS[meme.situation.check];
      if (!side) continue;
      var verdict = side(pawn, map, st);
      if (verdict === null || verdict === undefined) continue;
      if (verdict === 1 && !meme.situation.good) continue;
      if (verdict === 0 && !meme.situation.bad) continue;
      N.addThought(pawn, 'ideoMeme_' + meme.id, { degree: verdict, noStack: true });
    }

    /* Some memes are simply heavier or lighter to carry than others, and
       that shows as one line of its own rather than being smuggled into
       the situational thoughts above. */
    var flat = 0;
    for (i = 0; i < ideo.memes.length; i++) {
      if (MEMES[ideo.memes[i]] && MEMES[ideo.memes[i]].mood) flat += MEMES[ideo.memes[i]].mood;
    }
    if (flat) N.addThought(pawn, 'ideoOutlook', { mood: flat, noStack: true });
  }

  /* ---------- the standing feelings a meme gives a pawn ---------- */

  function countNearby(map, pawn, radius, test) {
    var n = 0;
    var cells = U.cellsInRadius(pawn.x, pawn.y, radius);
    for (var i = 0; i < cells.length; i++) {
      var x = cells[i][0], y = cells[i][1];
      if (!map.inBounds(x, y)) continue;
      if (test(x, y)) n++;
    }
    return n;
  }

  var SITUATIONS = {
    subjects: function (pawn, map) {
      var P = sys('Prisoners');
      var n = (P && P.all) ? P.all(map).length : 0;
      return n > 0 ? 1 : 0;
    },
    leader: function (pawn, map) { return Ideology.roleHolder('leader', map) ? 1 : 0; },
    smallColony: function (pawn, map) {
      return (map.colonists ? map.colonists().length : 0) <= 4 ? 1 : 0;
    },
    bigColony: function (pawn, map) {
      return (map.colonists ? map.colonists().length : 0) >= 5 ? 1 : 0;
    },
    greenery: function (pawn, map) {
      var n = countNearby(map, pawn, 6, function (x, y) {
        var pl = map.plantAt(x, y);
        return !!(pl && pl.def && pl.def.plant);
      });
      return n >= 6 ? 1 : 0;
    },
    implants: function (pawn, map, st) { return st.implants > 0 ? 1 : 0; },
    humanMeat: function (pawn, map) {
      var list = map.byDef ? map.byDef('meatRaw') : [];
      return list && list.length ? 1 : 0;
    },
    herd: function (pawn, map) {
      var n = 0;
      for (var i = 0; i < map.pawns.length; i++) {
        var a = map.pawns[i];
        if (a.isAnimal && a.tame && !a.dead) n++;
      }
      return n >= 2 ? 1 : 0;
    },
    underRoof: function (pawn, map) {
      return map.hasRoofAt && map.hasRoofAt(pawn.x, pawn.y) ? 1 : 0;
    },
    nude: function (pawn) {
      return (pawn.apparel && pawn.apparel.length) ? 0 : 1;
    },
    blind: function (pawn) {
      var h = pawn.health;
      if (!h || !h.parts) return 0;
      for (var i = 0; i < h.parts.length; i++) {
        var part = h.parts[i];
        if ((part.defName === 'eyeLeft' || part.defName === 'eyeRight') && part.missing) return 1;
      }
      var H = sys('Health');
      if (H && H.capacity && H.capacity(pawn, 'sight') < 0.4) return 1;
      return 0;
    },
    penance: function (pawn, map, st) {
      return (now() - st.lastPenanceTick) < 2 * DAY ? 1 : 0;
    },
    pain: function (pawn) {
      var H = sys('Health');
      var p = (H && H.painLevel) ? H.painLevel(pawn) : 0;
      return p > 0.15 ? 1 : 0;
    },
    gloom: function (pawn, map) {
      var P = sys('Power');
      var light = (P && P.lightAt) ? P.lightAt(map, pawn.x, pawn.y) : 1;
      return light < 0.35 ? 1 : 0;
    },
    corpsesLying: function (pawn, map) {
      var list = map.byDef ? map.byDef('corpse') : [];
      return (list && list.length) ? 0 : null;
    },
    sober: function (pawn, map, st) {
      return (now() - st.lastDrugTick) < DAY ? 1 : 0;
    }
  };

  /* ============================================================
     14. Jobs and the work giver that fills them
     ============================================================ */

  function activeRitual() {
    ensureState();
    return state.ritual;
  }

  function ritualOver(job) {
    var r = activeRitual();
    if (!r) return true;
    return r.startTick !== (job.state && job.state.ritualStart);
  }

  function noteAttendance(pawn, ticks) {
    var r = activeRitual();
    if (!r) return;
    r.attendees[pawn.id] = (r.attendees[pawn.id] || 0) + ticks;
  }

  if (Jobs && Jobs.register) {
    /* Walk to the gathering and stand there until the rite begins. */
    Jobs.register('ritualGather', {
      label: 'gather for the ritual',
      reportString: 'Gathering for the ritual.',
      alwaysShow: true,
      toils: function () {
        return [
          Toils.reserve('A', 1),
          Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false }),
          Toils.custom({
            name: 'wait for the rite',
            init: function (pawn, job, s) {
              var r = activeRitual();
              job.state.ritualStart = r ? r.startTick : -1;
              s.ticks = 0;
            },
            tick: function (pawn, job, s) {
              var r = activeRitual();
              if (!r || ritualOver(job)) return 'done';
              faceSpot(pawn, r);
              noteAttendance(pawn, 1);
              if (r.phase === 'running') return 'done';
              return (++s.ticks > RITUAL_GATHER_TICKS + 600) ? 'done' : 'stay';
            }
          })
        ];
      }
    });

    /* Stand in the crowd until it is over, and get something out of it. */
    Jobs.register('ritualSpectate', {
      label: 'attend the ritual',
      reportString: 'Attending the ritual.',
      alwaysShow: true, joyKind: 'ritual',
      toils: function () {
        return [
          Toils.reserve('A', 1),
          Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false }),
          Toils.custom({
            name: 'spectate',
            init: function (pawn, job) {
              var r = activeRitual();
              job.state.ritualStart = r ? r.startTick : -1;
            },
            tick: function (pawn, job) {
              var r = activeRitual();
              if (!r || ritualOver(job)) return 'done';
              faceSpot(pawn, r);
              noteAttendance(pawn, 1);
              var N = sys('Needs');
              var def = RITUALS[r.defId];
              if (N && N.gainJoy && now() % 60 === 0) {
                N.gainJoy(pawn, (def.joy || 0.2) * RITUAL_JOY / 60, 'ritual');
              }
              return 'stay';
            }
          })
        ];
      }
    });

    /* The moral guide runs it, and the quality of the whole rite hangs
       off how long they actually stood there doing it. */
    Jobs.register('ritualPerform', {
      label: 'lead the ritual',
      reportString: 'Leading the ritual.',
      alwaysShow: true,
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.ON_CELL, failIfGone: false }),
          Toils.custom({
            name: 'lead',
            init: function (pawn, job) {
              var r = activeRitual();
              job.state.ritualStart = r ? r.startTick : -1;
              if (r) r.leaderId = pawn.id;
            },
            tick: function (pawn, job) {
              var r = activeRitual();
              if (!r || ritualOver(job)) return 'done';
              r.leaderId = pawn.id;
              faceSpot(pawn, r);
              noteAttendance(pawn, 1);
              if (pawn.learn && now() % 120 === 0) pawn.learn('social', 4);
              return 'stay';
            },
            end: function (pawn) {
              var r = activeRitual();
              /* Walking out on your own rite is exactly the sort of
                 interruption the quality roll is meant to punish. */
              if (r && r.leaderId === pawn.id && r.phase === 'running' && now() < r.endTick - 60) {
                Ideology.noteRitualInterrupted('the guide walked off');
              }
            }
          })
        ];
      }
    });

    /* A moral guide talking somebody round, colonist or prisoner. */
    Jobs.register('ideoConvert', {
      label: 'preach',
      reportString: 'Talking {A} round to the faith.',
      toils: function () {
        return [
          Toils.reserve('A', 1),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.work({
            name: 'preach', amount: 520, skill: 'social', failIfGone: true,
            onDone: function (pawn, job) {
              var target = T.resolve(job.targetA, pawn.map);
              if (!target) return 'fail';
              Ideology.convertAttempt(pawn, target);
              return 'done';
            }
          })
        ];
      }
    });
  }

  function faceSpot(pawn, ritual) {
    var dx = ritual.x - pawn.x, dy = ritual.y - pawn.y;
    if (Math.abs(dx) > Math.abs(dy)) pawn.dir = dx > 0 ? 1 : 3;
    else if (dy !== 0) pawn.dir = dy > 0 ? 2 : 0;
  }

  /* A standing spot of one's own, so the crowd does not pile onto one
     cell and so the reservation table can keep them apart. */
  function standingCell(pawn, ritual) {
    var map = pawn.map;
    var ring = U.cellsInRadius(ritual.x, ritual.y, 4);
    for (var i = 0; i < ring.length; i++) {
      var x = ring[i][0], y = ring[i][1];
      if (!map.inBounds(x, y) || !map.passable(x, y)) continue;
      if (map.buildingAt(x, y)) continue;
      var target = T.cell(x, y);
      if (!Res.canReserve(pawn, target, 1)) continue;
      if (!Path.reachable(map, pawn.x, pawn.y, x, y, { pawn: pawn })) continue;
      return target;
    }
    return null;
  }

  if (WorkGivers && WorkGivers.register) {
    /* workgivers.js owns the ordinary work scans; a ritual is not work,
       and putting it in the basic column is what makes a colonist walk
       away from a haul to go and stand in the crowd. */
    WorkGivers.register({
      id: 'ideoAttendRitual', workType: 'basic', order: 5,
      label: 'attend a ritual',
      tryGiveJob: function (pawn) {
        var G = game();
        /* The clock lives here, so asking whether there is a rite on is
           also what advances one that is already running. */
        Ideology.tickRituals(G);
        var r = activeRitual();
        if (!r || !isHuman(pawn) || pawn.drafted) return null;
        if (!Ideology.sameFaithAsColony(pawn)) return null;
        if (pawn.job && pawn.job.defId === 'ritualSpectate') return null;

        var leader = Ideology.roleHolder('moralGuide', pawn.map) ||
                     Ideology.roleHolder('leader', pawn.map);
        if (leader === pawn && !r.leaderId) {
          return Jobs.make('ritualPerform', T.cell(r.x, r.y), null, { playerForced: false });
        }
        var spot = standingCell(pawn, r);
        if (!spot) return null;
        return Jobs.make(r.phase === 'gathering' ? 'ritualGather' : 'ritualSpectate', spot, null, {});
      }
    });

    WorkGivers.register({
      id: 'ideoPreach', workType: 'basic', order: 60,
      label: 'preach to an unbeliever',
      tryGiveJob: function (pawn) {
        if (!isHuman(pawn) || pawn.drafted) return null;
        if (Ideology.roleOf(pawn) !== 'moralGuide') return null;
        var st = ensurePawn(pawn);
        if (!st || now() - st.lastConvertTick < CONVERT_COOLDOWN) return null;
        if (activeRitual()) return null;
        var map = pawn.map;
        var best = null, bestD = Infinity;
        for (var i = 0; i < map.pawns.length; i++) {
          var p = map.pawns[i];
          if (!isHuman(p) || p.dead || p === pawn) continue;
          if (p.faction !== 'player' && !p.prisoner) continue;
          if (Ideology.sameFaith(pawn, p)) continue;
          if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
          var d = U.distSq(pawn.x, pawn.y, p.x, p.y);
          if (d < bestD && Path.reachable(map, pawn.x, pawn.y, p.x, p.y, { pawn: pawn })) {
            bestD = d; best = p;
          }
        }
        if (!best) return null;
        return Jobs.make('ideoConvert', T.pawn(best), null, {});
      }
    });
  }

  /* ============================================================
     15. Save and load
     ============================================================ */

  Ideology.save = function () {
    ensureState();
    var ideos = {};
    Object.keys(state.ideos).forEach(function (id) {
      var i = state.ideos[id];
      ideos[id] = {
        id: i.id, name: i.name, memes: i.memes.slice(),
        precepts: JSON.parse(JSON.stringify(i.precepts)),
        roles: i.roles.map(function (r) { return { id: r.id, pawnId: r.pawnId | 0 }; }),
        colors: { primary: i.colors.primary, secondary: i.colors.secondary },
        symbol: i.symbol, style: i.style, foundedTick: i.foundedTick | 0,
        description: i.description
      };
    });
    var ritual = null;
    if (state.ritual) {
      var r = state.ritual;
      ritual = {
        defId: r.defId, ideoId: r.ideoId, x: r.x, y: r.y,
        startTick: r.startTick, gatherUntil: r.gatherUntil, endTick: r.endTick,
        phase: r.phase, leaderId: r.leaderId | 0,
        attendees: JSON.parse(JSON.stringify(r.attendees)),
        interruptions: r.interruptions | 0, quality: r.quality || 0
      };
    }
    return {
      ideos: ideos,
      nextIdeoId: state.nextIdeoId,
      colonyId: state.colonyId,
      byFaction: JSON.parse(JSON.stringify(state.byFaction)),
      ritual: ritual,
      lastRitualTick: state.lastRitualTick,
      nextRitualTick: state.nextRitualTick,
      relicThingId: state.relicThingId | 0,
      lastBeatTick: state.lastBeatTick,
      log: state.log.slice(-20)
    };
  };

  Ideology.load = function (obj) {
    state = freshState();
    if (!obj || typeof obj !== 'object') return false;
    var ideos = obj.ideos || {};
    Object.keys(ideos).forEach(function (id) {
      var i = ideos[id];
      if (!i || !i.id) return;
      /* Memes and precepts that no longer exist are dropped rather than
         carried, so an old save cannot resurrect content this build has
         forgotten how to read. */
      var memes = (i.memes || []).filter(function (m) { return !!MEMES[m]; });
      var precepts = {};
      Object.keys(PRECEPTS).forEach(function (pid) {
        var want = i.precepts && i.precepts[pid];
        precepts[pid] = (want && PRECEPTS[pid].degrees.indexOf(want) >= 0) ? want : PRECEPTS[pid].def;
      });
      state.ideos[i.id] = {
        id: i.id, name: i.name || 'A faith', memes: memes, precepts: precepts,
        roles: (i.roles || []).filter(function (r) { return r && ROLES[r.id]; })
                 .map(function (r) { return { id: r.id, pawnId: r.pawnId | 0 }; }),
        colors: i.colors || { primary: '#c0392b', secondary: '#ffc23c' },
        symbol: i.symbol || 'sun', style: i.style || 'archaic',
        foundedTick: i.foundedTick | 0,
        description: i.description || memes.join(', ')
      };
    });
    state.nextIdeoId = obj.nextIdeoId || (Object.keys(state.ideos).length + 1);
    state.colonyId = (obj.colonyId && state.ideos[obj.colonyId]) ? obj.colonyId : null;
    state.byFaction = obj.byFaction || {};
    state.ritual = (obj.ritual && RITUALS[obj.ritual.defId]) ? obj.ritual : null;
    if (state.ritual && !state.ritual.attendees) state.ritual.attendees = {};
    state.lastRitualTick = obj.lastRitualTick || 0;
    state.nextRitualTick = obj.nextRitualTick || (now() + RITUAL_INTERVAL);
    state.relicThingId = obj.relicThingId | 0;
    state.lastBeatTick = obj.lastBeatTick || now();
    state.log = Array.isArray(obj.log) ? obj.log.slice(-20) : [];
    return true;
  };

  /* ============================================================
     16. Readouts for the UI
     ============================================================ */

  Ideology.describe = function (ideo) {
    ideo = ideo || Ideology.colony();
    if (!ideo) return '';
    var lines = [ideo.name];
    lines.push(ideo.memes.map(function (m) { return MEMES[m].label; }).join(' / '));
    return lines.join(' - ');
  };

  Ideology.preceptRows = function (ideo) {
    ideo = ideo || Ideology.colony();
    var out = [];
    Object.keys(PRECEPTS).forEach(function (pid) {
      var d = Ideology.precept(ideo, pid);
      if (!d) return;
      out.push({ id: pid, label: PRECEPTS[pid].label, degree: d.id,
                 index: d.index, category: PRECEPTS[pid].category });
    });
    return out;
  };

  Ideology.pawnSummary = function (pawn) {
    var st = ensurePawn(pawn);
    if (!st) return null;
    var ideo = Ideology.of(pawn);
    return {
      faith: ideo ? ideo.name : 'none',
      certainty: Math.round(U.clamp01(st.certainty) * 100),
      role: st.roleId ? ROLES[st.roleId].label : null,
      resentment: Math.round(U.clamp01(st.resentment) * 100),
      boosts: st.boosts.map(function (b) { return b.id; })
    };
  };

  Ideology.ritualLog = function () { ensureState(); return state.log.slice(); };

  root.Ideology = Ideology;
})(this);
