/* ============================================================
   factions.js - the civilizations, and what they think of you.

   A faction here is a rolled instance of a factionKind def: a name, a
   leader, a colour, a handful of dots on the world map and one number
   between -100 and +100 that decides everything else. Goodwill is the
   spine of the file. Every other system pushes on it - a dead trader, a
   released prisoner, a fat sale, a razed village - and the consequences
   fall out of two thresholds: below -75 they are at war with you, above
   +40 they will come when you call.

   Two rules make the rest of the game able to lean on this file.

   Nothing here knows about the colony map beyond what it can ask for
   through a guarded global, so the file loads and runs standalone. And
   every answer combat asks for - is A hostile to B - is cached per pair
   and thrown away the moment a number moves, because that question is
   asked several hundred times a tick and the answer changes perhaps
   twice a season.

   Generation borrows the shared RNG the way world.js does: seeded from
   the world seed, wound forward, handed back exactly where it was found.
   The same seed always produces the same neighbours.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  var Factions = {};

  /* ---------- tuning ---------- */

  var TICKS_PER_DAY = 60000;
  var HOSTILE_AT = -75;              /* at or below this, they are at war    */
  var PEACE_AT = -40;                /* ...and it takes this much to end one  */
  var ALLY_AT = 40;                  /* allies answer a call for help         */
  var ALLIANCE_OFFER_AT = 25;        /* warm enough to propose one            */
  var WAR_DRIFT_CEILING = -50;       /* drift alone never buys peace          */
  var HISTORY_MAX = 30;
  var OFFER_TICKS = Math.round(1.5 * TICKS_PER_DAY);
  var HELP_COOLDOWN = 3 * TICKS_PER_DAY;
  var RAID_SPACING = 2 * TICKS_PER_DAY;
  var MESSAGE_CHANCE_PER_DAY = 0.25;
  var EMPIRE_CHANCE = 0.4;
  var CORPSE_GRACE = 2 * TICKS_PER_DAY;  /* how fresh a body must be to be blamed on you */
  var MIN_FACTIONS = 4, MAX_FACTIONS = 6;

  /* A raid strategy is only worth using above a certain threat budget:
     three tribals cannot mount a siege. */
  var STRATEGY_MIN = { assault: 0, sappers: 260, siege: 420 };

  /* Leader names. def_pawns.js owns colonist names, but a faction leader
     never stands on the map and never becomes a pawn, so the handful of
     syllables it takes lives here rather than being borrowed from a file
     that is allowed to change its mind about name defs. */
  var LEADER_NAMES = {
    neolithic: {
      male: ['Otok', 'Bram', 'Haku', 'Teshka', 'Varo', 'Nakh', 'Umbe', 'Zamu', 'Roka', 'Eshu'],
      female: ['Anouk', 'Mora', 'Ilka', 'Pehra', 'Vaska', 'Sereth', 'Noka', 'Tuva', 'Aska', 'Yelen'],
      last: ['Stonetooth', 'Ashwalker', 'Riverborn', 'Elkfriend', 'Fenwalker', 'Thornhand',
        'Moonsong', 'Emberfoot', 'Reedcutter', 'Bisonheart']
    },
    industrial: {
      male: ['Aldous', 'Corwin', 'Dmitri', 'Ewan', 'Halden', 'Joris', 'Marek', 'Ren', 'Tobias', 'Viktor'],
      female: ['Adrienne', 'Brann', 'Celia', 'Dagny', 'Elspeth', 'Ingrid', 'Marta', 'Nadia', 'Rosalind', 'Yvette'],
      last: ['Kessler', 'Vance', 'Morrow', 'Ashford', 'Delvin', 'Corvin', 'Brennan', 'Halloway',
        'Nyland', 'Tarsis', 'Redmond', 'Orwin']
    },
    spacer: {
      male: ['Aurelian', 'Cassivan', 'Dorian', 'Emeric', 'Lucien', 'Octavian', 'Sevrin', 'Thaddeus'],
      female: ['Aurelia', 'Cassia', 'Delphine', 'Evanthe', 'Liora', 'Octavia', 'Sabine', 'Theodora'],
      last: ['of Auros', 'Vendrell', 'Solmara', 'Highmark', 'Astravane', 'Thessaly', 'Caelum', 'Ordwin']
    }
  };

  /* Titles that come with a gender attached, so the empire does not end
     up with an Archduchess called Thaddeus. */
  var TITLE_GENDER = {
    Chairman: 'male', Chairwoman: 'female', Archduke: 'male', Archduchess: 'female',
    'His Excellency': 'male', 'Her Excellency': 'female', Matriarch: 'female',
    Headman: 'male', 'Prime Minister': null
  };

  /* ---------- state ---------- */

  var factions = [];
  var byId = new Map();
  var offers = [];
  var countedDeaths = new Set();     /* pawn ids already charged to someone */
  var lastDiploTick = 0;
  var usedNames = new Set();
  var usedSurnames = new Set();
  var _hostileCache = new Map();

  /* The colony is a faction too as far as everyone else is concerned, but
     it has no kind, no goodwill with itself and no settlements on the
     world map, so it is built by hand rather than rolled. */
  var playerFaction = {
    id: 'player', kindId: 'player', kind: null, name: 'Your colony',
    leaderName: '', leaderTitle: '', color: '#4a7fd4', colorSecondary: '#8fb2ec',
    goodwill: 100, hostile: false, allied: false, permanentEnemy: false,
    settlements: [], techLevel: 'industrial', history: [], isPlayer: true
  };

  /* ---------- guarded access to the rest of the game ---------- */

  function world() { return root.World; }
  function game() { return root.Game; }

  function now() {
    var g = root.Game;
    return g && typeof g.tick === 'number' ? g.tick : 0;
  }

  function letter(title, text, kind) {
    var g = root.Game;
    if (g && g.letter) g.letter(title, text, { kind: kind || 'neutral' });
  }

  function message(text, type) {
    var g = root.Game;
    if (g && g.msg) g.msg(text, { type: type || 'info' });
  }

  function kindList() {
    if (!Defs || !Defs.all) return [];
    var list = Defs.all('factionKind');
    return list && list.length ? list : [];
  }

  function kindDef(id) {
    if (!Defs || !Defs.maybe) return null;
    return Defs.maybe('factionKind', id);
  }

  /* A kind a save file names but this build no longer registers still has
     to produce a faction that behaves, so it gets a minimal stand-in. */
  function fallbackKind(id) {
    return {
      id: id || 'unknown', label: 'unknown people', description: '',
      techLevel: 'industrial', permanentEnemy: false, canTrade: true, canAlly: true,
      settlementCount: [1, 2], goodwillStart: [0, 20], goodwillGainFactor: 1,
      goodwillLossFactor: 1, goodwillDriftPerDay: 0.4, raidPointsFactor: 1,
      allyHelpChance: 0.35, weight: 1, raidStrategies: ['assault'],
      settlementKinds: ['village'], pawnKinds: { raider: ['raider'], trader: ['wanderer'], guard: ['raider'] },
      traderKinds: [], tradeCategories: [], namePatterns: ['{A}'], nameWords: { A: ['Unknown'] },
      leaderTitles: ['Leader'], colorPrimary: '#8f97a3', colorSecondary: '#c4ccd8'
    };
  }

  /* ---------- names ---------- */

  function fillPattern(pattern, words) {
    return String(pattern || '').replace(/\{(\w+)\}/g, function (all, key) {
      var list = words && words[key];
      return (list && list.length) ? U.pick(list) : '';
    }).replace(/\s+/g, ' ').trim();
  }

  function rollUniqueName(patterns, words, fallback) {
    for (var attempt = 0; attempt < 24; attempt++) {
      var name = fillPattern(U.pick(patterns || []), words);
      if (name && !usedNames.has(name)) { usedNames.add(name); return name; }
    }
    /* Every combination taken is vanishingly unlikely, but a numbered
       name beats two civilizations the player cannot tell apart. */
    var n = 2;
    var base = fillPattern(U.pick(patterns || []), words) || fallback || 'Nameless';
    while (usedNames.has(base + ' ' + roman(n))) n++;
    var out = base + ' ' + roman(n);
    usedNames.add(out);
    return out;
  }

  function roman(n) {
    var table = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];
    return table[n] || String(n);
  }

  function nameBank(techLevel) {
    return LEADER_NAMES[techLevel] || LEADER_NAMES.industrial;
  }

  function rollLeader(kind) {
    var titles = (kind.leaderTitles && kind.leaderTitles.length) ? kind.leaderTitles : ['Leader'];
    var title = U.pick(titles);
    var gender = TITLE_GENDER[title];
    if (!gender) gender = U.chance(0.5) ? 'male' : 'female';
    var bank = nameBank(kind.techLevel);
    var name = '', last = '';
    /* Two leaders on the same planet do not share a surname: it reads as a
       mistake rather than as a coincidence. */
    for (var attempt = 0; attempt < 16; attempt++) {
      last = U.pick(bank.last);
      name = U.pick(bank[gender] || bank.male) + ' ' + last;
      if (!usedSurnames.has(last) && !usedNames.has(name)) break;
    }
    usedSurnames.add(last);
    usedNames.add(name);
    return { title: title, name: name, gender: gender };
  }

  function rollSettlementName(kindId) {
    var def = Defs && Defs.maybe ? Defs.maybe('settlementKind', kindId) : null;
    if (def && def.namePatterns && def.namePatterns.length) {
      return rollUniqueName(def.namePatterns, def.nameWords, kindId);
    }
    var W = world();
    var fallback = (W && W.generateName) ? W.generateName(kindId) : 'Settlement';
    var name = fallback, n = 2;
    while (usedNames.has(name)) { name = fallback + ' ' + roman(n); n++; }
    usedNames.add(name);
    return name;
  }

  /* Two clans of the same kind should not be the same swatch on the world
     map. The second is lightened and the third darkened rather than hue
     shifted, so they still read as the same people. */
  var COLOR_STEPS = [0, 46, -40, 84, -72];

  function shiftColor(hex, step) {
    if (!step) return hex;
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return hex;
    var v = parseInt(m[1], 16);
    var d = COLOR_STEPS[step] === undefined ? step * 24 : COLOR_STEPS[step];
    var r = U.clamp(((v >> 16) & 255) + d, 20, 240) | 0;
    var g = U.clamp(((v >> 8) & 255) + d, 20, 240) | 0;
    var b = U.clamp((v & 255) + d, 20, 240) | 0;
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  /* ---------- building one civilization ---------- */

  function makeFaction(kind, ordinal) {
    var start = kind.goodwillStart || [0, 20];
    var goodwill = kind.permanentEnemy ? -100 : U.randInt(start[0], start[1]);
    var leader = rollLeader(kind);
    var f = {
      id: kind.id + (ordinal > 1 ? ordinal : ''),
      kindId: kind.id,
      kind: kind,
      name: rollUniqueName(kind.namePatterns, kind.nameWords, kind.label),
      leaderName: leader.name,
      leaderTitle: leader.title,
      leaderGender: leader.gender,
      color: shiftColor(kind.colorPrimary || '#8f97a3', ordinal - 1),
      colorSecondary: kind.colorSecondary || kind.colorPrimary || '#c4ccd8',
      goodwill: goodwill,
      baseGoodwill: kind.permanentEnemy ? -100 : Math.round((start[0] + start[1]) / 2),
      hostile: !!kind.permanentEnemy || goodwill <= HOSTILE_AT,
      allied: !kind.permanentEnemy && goodwill >= ALLY_AT,
      permanentEnemy: !!kind.permanentEnemy,
      settlements: [],
      techLevel: kind.techLevel || 'industrial',
      history: [],
      atWarSinceTick: 0,
      lastRaidTick: -RAID_SPACING,
      lastHelpTick: -HELP_COOLDOWN,
      raidCount: 0,
      tradeCount: 0
    };
    if (f.hostile) f.atWarSinceTick = 0;
    return f;
  }

  function classify(kinds, test) {
    return kinds.filter(test);
  }

  function isPirateKind(k) { return !!k.permanentEnemy; }
  function isTribalKind(k) { return !k.permanentEnemy && k.techLevel === 'neolithic'; }
  function isEmpireKind(k) { return !k.permanentEnemy && k.techLevel === 'spacer'; }
  function isOutlanderKind(k) {
    return !k.permanentEnemy && (k.techLevel === 'industrial' || k.techLevel === 'medieval');
  }

  function pickKind(pool) {
    if (!pool.length) return null;
    return U.pickWeighted(pool, function (k) { return Math.max(0.05, k.weight || 1); });
  }

  /* Which kinds this planet ended up with. The shape of the neighbourhood
     is fixed - one pirate band, tribes, outlanders - because a colony with
     nobody to trade with and nobody to fear is not a game. */
  function chooseKinds(kinds) {
    var count = U.randInt(MIN_FACTIONS, MAX_FACTIONS);
    var pirates = classify(kinds, isPirateKind);
    var tribes = classify(kinds, isTribalKind);
    var outlanders = classify(kinds, isOutlanderKind);
    var empires = classify(kinds, isEmpireKind);
    var chosen = [];

    var tribe = pickKind(tribes);
    if (tribe) chosen.push(tribe);
    var outlander = pickKind(outlanders);
    if (outlander) chosen.push(outlander);
    /* The empire is a guest star: most worlds never see one, and the one
       that does only gets a single seat. */
    var empire = (empires.length && U.chance(EMPIRE_CHANCE)) ? pickKind(empires) : null;
    if (empire) chosen.push(empire);

    var fill = kinds.filter(function (k) { return !isPirateKind(k) && !isEmpireKind(k); });
    while (chosen.length < count - 1 && fill.length) {
      var extra = pickKind(fill);
      if (!extra) break;
      chosen.push(extra);
    }

    /* Exactly one pirate band, added last so it is never crowded out. */
    var pirate = pickKind(pirates);
    if (pirate) chosen.push(pirate);
    return chosen;
  }

  /* ---------- settlements ---------- */

  /* Where a civilization likes to sit relative to you. Raiders want to be
     close enough to walk over but far enough to be a place rather than a
     neighbour; traders want the short road. */
  function preferredDistance(f) {
    if (f.permanentEnemy) return { peak: 12, spread: 7 };
    if (f.techLevel === 'neolithic') return { peak: 6, spread: 4 };
    if (f.techLevel === 'spacer') return { peak: 14, spread: 8 };
    return { peak: 9, spread: 5 };
  }

  function siteWeight(W, f, tile, colony) {
    var d = W.distance(tile, colony);
    if (d < 3) return 0;
    var pref = preferredDistance(f);
    var t = (d - pref.peak) / pref.spread;
    var weight = 1 / (1 + t * t);
    var info = W.siteInfo ? W.siteInfo(tile) : null;
    if (info && typeof info.habitability === 'number') weight *= 0.4 + info.habitability;
    /* Civilizations are contiguous: a second village goes near the first. */
    for (var i = 0; i < f.settlements.length; i++) {
      var s = W.settlementById ? W.settlementById(f.settlements[i]) : null;
      if (s && W.distance(tile, s.tile) <= 6) { weight *= 2.5; break; }
    }
    return Math.max(0.001, weight);
  }

  function claimSettlements(W, f, pool) {
    var range = f.kind.settlementCount || [1, 2];
    var wanted = U.randInt(range[0], range[1]);
    var colony = W.colonyTile || 0;
    for (var n = 0; n < wanted; n++) {
      var tile = -1, at = -1;
      if (pool.length) {
        tile = U.pickWeighted(pool, function (t) { return siteWeight(W, f, t, colony); });
        at = pool.indexOf(tile);
      }
      if (at < 0) tile = randomLandTile(W, colony);
      else pool.splice(at, 1);
      if (tile < 0) break;
      var kindId = U.pick(f.kind.settlementKinds || ['village']);
      var s = W.placeSettlement(tile, f.id, kindId, rollSettlementName(kindId));
      if (s) f.settlements.push(s.id);
    }
  }

  /* World gen only marks so many plausible sites. A crowded planet still
     has to put the last tribal camp somewhere, so it goes on open ground. */
  function randomLandTile(W, colony) {
    var size = W.size || 0;
    for (var attempt = 0; attempt < 120; attempt++) {
      var i = U.randInt(0, size - 1);
      if (W.isOcean(i)) continue;
      if (W.settlementAt && W.settlementAt(i)) continue;
      if (W.isHabitable && !W.isHabitable(i)) continue;
      if (W.distance(i, colony) < 4) continue;
      return i;
    }
    return -1;
  }

  /* ---------- generation ---------- */

  Factions.generate = function (w) {
    var W = w || world();
    Factions.reset();
    var kinds = kindList();
    if (!kinds.length) return factions;

    /* Borrow the shared stream, wind it somewhere of our own and hand it
       back: the colony map rolls the same dice whether or not the planet
       has civilizations on it. */
    var streamState = U.getSeed();
    var seed = (W && W.seed) ? W.seed : U.randInt(1, 2000000000);
    U.seed((seed ^ 0x66616374) >>> 0);

    var chosen = chooseKinds(kinds);
    var perKind = {};
    for (var i = 0; i < chosen.length; i++) {
      var kind = chosen[i];
      perKind[kind.id] = (perKind[kind.id] || 0) + 1;
      var f = makeFaction(kind, perKind[kind.id]);
      factions.push(f);
      byId.set(f.id, f);
    }

    if (W && W.generated && W.placeSettlement) {
      var pool = (W.candidateSites ? W.candidateSites() : []).filter(function (t) {
        return !(W.settlementAt && W.settlementAt(t));
      });
      for (var k = 0; k < factions.length; k++) claimSettlements(W, factions[k], pool);
    }

    U.setSeed(streamState);
    lastDiploTick = now();
    invalidate();
    syncCombat();
    return factions;
  };

  Factions.reset = function () {
    factions.length = 0;
    byId.clear();
    offers.length = 0;
    countedDeaths.clear();
    usedNames.clear();
    usedSurnames.clear();
    lastDiploTick = 0;
    invalidate();
    return Factions;
  };

  /* ---------- lookups ---------- */

  function idOf(x) {
    if (!x) return null;
    if (typeof x === 'string') return x;
    return x.id || x.factionId || null;
  }

  Factions.all = function () { return factions.slice(); };
  Factions.count = function () { return factions.length; };
  Factions.player = function () { return playerFaction; };

  Factions.get = function (id) {
    var key = idOf(id);
    if (!key) return null;
    if (key === 'player') return playerFaction;
    return byId.get(key) || null;
  };

  Factions.exists = function (id) { return !!Factions.get(id); };

  Factions.goodwill = function (id) {
    var f = Factions.get(id);
    return f ? f.goodwill : 0;
  };

  Factions.colorOf = function (id) {
    var f = Factions.get(id);
    if (f) return f.color;
    if (id === 'raider') return '#c0392b';
    if (id === 'wild') return '#b08c5a';
    return '#8f97a3';
  };

  Factions.nameOf = function (id) {
    var f = Factions.get(id);
    if (f) return f.name;
    if (id === 'raider') return 'pirates';
    if (id === 'wild') return 'wildlife';
    return 'strangers';
  };

  Factions.allies = function () {
    return factions.filter(function (f) { return f.allied && !f.hostile; });
  };
  Factions.hostiles = function () {
    return factions.filter(function (f) { return f.hostile; });
  };
  Factions.pirates = function () {
    return factions.filter(function (f) { return f.permanentEnemy; });
  };
  Factions.tradeable = function () {
    return factions.filter(function (f) {
      return !f.hostile && f.kind.canTrade !== false && f.settlements.length > 0;
    });
  };

  Factions.settlementsOf = function (id) {
    var W = world();
    var f = Factions.get(id);
    if (!W || !f || !W.settlementById) return [];
    return f.settlements.map(function (sid) { return W.settlementById(sid); })
      .filter(function (s) { return s && !s.destroyed; });
  };

  Factions.ofSettlement = function (settlement) {
    return settlement ? Factions.get(settlement.factionId) : null;
  };

  /* Which trader a civilization would send: its own list, filtered to the
     ones that deal with people at its tech level. */
  Factions.traderKindFor = function (id) {
    var f = Factions.get(id);
    if (!f || !f.kind.traderKinds || !f.kind.traderKinds.length) return null;
    var usable = f.kind.traderKinds.filter(function (tk) {
      var def = Defs && Defs.maybe ? Defs.maybe('traderKind', tk) : null;
      if (!def) return false;
      return !def.techLevels || def.techLevels.indexOf(f.techLevel) >= 0;
    });
    if (!usable.length) usable = f.kind.traderKinds.slice();
    return usable.length ? U.pick(usable) : null;
  };

  /* ---------- goodwill ---------- */

  /* Goodwill is kept to three decimals rather than one. Diplomacy ticks
     every 2500 ticks, so a day's drift arrives in twenty-four slivers of
     about a hundredth each; rounding harder than this would round every
     one of them away and no faction would ever drift at all. */
  function tidy(v) { return Math.round(v * 1000) / 1000; }

  function record(f, delta, reason) {
    f.history.push({
      tick: now(),
      delta: Math.round(delta * 10) / 10,
      reason: reason || 'unspecified',
      goodwill: Math.round(f.goodwill)
    });
    if (f.history.length > HISTORY_MAX) f.history.splice(0, f.history.length - HISTORY_MAX);
  }

  Factions.adjustGoodwill = function (id, delta, reason) {
    var f = Factions.get(id);
    if (!f || f.isPlayer || !delta) return f ? f.goodwill : 0;
    /* A pirate band has no opinion to change: gifts, mercy and massacres
       all land on the same floor. */
    if (f.permanentEnemy) return f.goodwill;

    var factor = delta >= 0 ? (f.kind.goodwillGainFactor === undefined ? 1 : f.kind.goodwillGainFactor)
      : (f.kind.goodwillLossFactor === undefined ? 1 : f.kind.goodwillLossFactor);
    var before = f.goodwill;
    f.goodwill = U.clamp(tidy(before + delta * factor), -100, 100);
    var moved = f.goodwill - before;
    if (!moved) return f.goodwill;

    record(f, moved, reason);
    invalidate();
    if (Math.abs(moved) >= 10) {
      message(f.name + ': goodwill ' + U.signed(moved, 0) + ' (' + (reason || 'unspecified') + ')',
        moved > 0 ? 'good' : 'threat');
    }
    checkThresholds(f, reason);
    return f.goodwill;
  };

  /* The two lines that matter, checked in one place so no caller can move
     goodwill past a threshold without the consequence firing. */
  function checkThresholds(f, reason) {
    if (f.permanentEnemy) { f.hostile = true; f.allied = false; return; }
    if (!f.hostile && f.goodwill <= HOSTILE_AT) {
      Factions.declareWar(f.id, reason);
    } else if (f.hostile && f.goodwill >= PEACE_AT) {
      Factions.makePeace(f.id, reason);
    }
    var allied = !f.hostile && f.goodwill >= ALLY_AT;
    if (allied !== f.allied) {
      f.allied = allied;
      if (allied) {
        letter('Alliance with ' + f.name,
          f.leaderTitle + ' ' + f.leaderName + ' counts your colony a friend of the ' +
          f.kind.label + '. Call on them when a raid comes and they may answer.', 'good');
      } else {
        message('The ' + f.name + ' no longer count you an ally.', 'threat');
      }
    }
  }

  Factions.declareWar = function (id, reason) {
    var f = Factions.get(id);
    if (!f || f.isPlayer || f.hostile) return false;
    f.hostile = true;
    f.allied = false;
    f.atWarSinceTick = now();
    if (f.goodwill > HOSTILE_AT) {
      f.goodwill = HOSTILE_AT;
      record(f, 0, 'war declared');
    }
    invalidate();
    syncCombat();
    letter('War with ' + f.name,
      f.leaderTitle + ' ' + f.leaderName + ' has declared your colony an enemy of the ' +
      f.kind.label + '.' + (reason ? ' The cause given: ' + reason + '.' : '') +
      ' Expect their people at your walls.', 'threat');
    return true;
  };

  Factions.makePeace = function (id, reason) {
    var f = Factions.get(id);
    if (!f || f.isPlayer || f.permanentEnemy || !f.hostile) return false;
    f.hostile = false;
    f.atWarSinceTick = 0;
    if (f.goodwill < PEACE_AT) {
      f.goodwill = PEACE_AT;
      record(f, 0, 'peace made');
    }
    invalidate();
    syncCombat();
    letter('Peace with ' + f.name,
      'The war with the ' + f.name + ' is over.' + (reason ? ' ' + U.cap(String(reason)) + '.' : '') +
      ' Their caravans will pass this way again, warily.', 'good');
    return true;
  };

  /* ---------- the reasons goodwill moves ----------
     Every one of these is idempotent where it needs to be and safe to call
     from a file that has no idea whether the faction still exists. */

  Factions.notePawnKilled = function (pawn, killer) {
    if (!pawn) return 0;
    var f = Factions.get(pawn.faction || pawn.factionId);
    var pid = pawn.id || 0;
    if (pid) {
      if (countedDeaths.has(pid)) return 0;
      countedDeaths.add(pid);
    }
    if (!f || f.isPlayer || f.permanentEnemy) return 0;
    /* A faction at war with you counts its own casualties as the cost of
       raiding, not as a fresh injury. */
    if (f.hostile) return 0;
    if (killer && killer.faction && killer.faction !== 'player') return 0;
    var who = (pawn.name && (pawn.name.nick || pawn.name.first)) || 'one of their people';
    return Factions.adjustGoodwill(f.id, -U.randInt(15, 25), 'you killed ' + who);
  };

  /* Nobody reported the kill, but the body is lying in your colony. Worth
     less than a witnessed murder, and still worth something. */
  function noteFoundBody(info, corpseTick) {
    if (!info || !info.pawnId) return;
    if (countedDeaths.has(info.pawnId)) return;
    countedDeaths.add(info.pawnId);
    var f = Factions.get(info.faction);
    if (!f || f.isPlayer || f.permanentEnemy || f.hostile) return;
    if (corpseTick !== undefined && now() - corpseTick > CORPSE_GRACE) return;
    Factions.adjustGoodwill(f.id, -U.randInt(8, 14),
      (info.name || 'one of their people') + ' died on your land');
  }

  Factions.noteSettlementDestroyed = function (settlement, by) {
    var f = Factions.ofSettlement(settlement);
    if (!f || f.isPlayer) return 0;
    U.remove(f.settlements, settlement.id);
    if (f.permanentEnemy) return f.goodwill;
    var out = Factions.adjustGoodwill(f.id, -U.randInt(70, 90), 'you destroyed ' + settlement.name);
    letter(settlement.name + ' is gone',
      'The ' + f.name + ' will not forget who burned ' + settlement.name + '.' +
      (by ? ' ' + U.cap(String(by)) + ' did it in your name.' : ''), 'threat');
    return out;
  };

  Factions.noteTrade = function (id, value) {
    var f = Factions.get(id);
    if (!f || f.isPlayer) return 0;
    f.tradeCount++;
    var bonus = value > 1200 ? 1 : 0;
    return Factions.adjustGoodwill(f.id, U.randInt(1, 3) + bonus, 'traded with them');
  };

  /* A gift is worth what it is worth: a crate of steel is a gesture, a
     caravan of silver is diplomacy. */
  Factions.noteGift = function (id, value) {
    var f = Factions.get(id);
    if (!f || f.isPlayer) return 0;
    var gain = U.clamp(Math.round((value || 0) / 55), 1, 35);
    return Factions.adjustGoodwill(f.id, gain, 'gift worth ' + Math.round(value || 0) + ' silver');
  };

  Factions.notePrisonerReleased = function (id, name) {
    return Factions.adjustGoodwill(id, 12, 'released ' + (name || 'a prisoner'));
  };

  Factions.notePrisonerRecruited = function (id, name) {
    return Factions.adjustGoodwill(id, -8, 'recruited ' + (name || 'one of their people'));
  };

  Factions.noteHelpGiven = function (id, what) {
    return Factions.adjustGoodwill(id, U.randInt(6, 12), what || 'your caravan helped them');
  };

  /* ---------- hostility, and the cache combat leans on ---------- */

  function invalidate() { _hostileCache.clear(); }
  Factions.invalidateRelations = invalidate;

  function pairKey(a, b) { return a < b ? a + '|' + b : b + '|' + a; }

  /* The built-in 'raider' id is the map's generic enemy and behaves like a
     pirate band that never got a name. */
  function isPirateId(id, f) {
    if (id === 'raider') return true;
    return !!(f && f.permanentEnemy);
  }

  function computeHostile(a, b) {
    var fa = Factions.get(a), fb = Factions.get(b);
    var pa = isPirateId(a, fa), pb = isPirateId(b, fb);
    /* Pirates fight everyone who is not also a pirate. */
    if (pa || pb) return !(pa && pb);
    if (a === 'player') return !!(fb && fb.hostile);
    if (b === 'player') return !!(fa && fa.hostile);
    /* Two civilizations may loathe each other on the world map; on your
       map they keep it to themselves. */
    return false;
  }

  Factions.hostileTo = function (a, b) {
    var ia = idOf(a), ib = idOf(b);
    if (!ia || !ib || ia === ib) return false;
    /* Wildlife belongs to nobody: animals decide their own fights. */
    if (ia === 'wild' || ib === 'wild') return false;
    var key = pairKey(ia, ib);
    var hit = _hostileCache.get(key);
    if (hit !== undefined) return hit;
    var out = computeHostile(ia, ib);
    _hostileCache.set(key, out);
    return out;
  };

  /* combat.js keeps its own table of who starts fights and offers one door
     in. Every pair that involves a generated civilization is pushed
     through it; the four built-in ids are left exactly as combat wrote
     them, because manhunters and predators depend on that. */
  function syncCombat() {
    var C = root.Combat;
    if (!C || !C.setRelation) return;
    var others = ['player', 'raider', 'neutral'];
    for (var i = 0; i < factions.length; i++) {
      var a = factions[i].id;
      for (var j = 0; j < others.length; j++) {
        C.setRelation(a, others[j], Factions.hostileTo(a, others[j]));
      }
      for (var k = i + 1; k < factions.length; k++) {
        C.setRelation(a, factions[k].id, Factions.hostileTo(a, factions[k].id));
      }
    }
  }
  Factions.syncCombat = syncCombat;

  /* ---------- who attacks ---------- */

  function nearnessFactor(f) {
    var W = world();
    if (!W || !W.generated || !f.settlements.length || !W.settlementById) return 1;
    var best = Infinity;
    for (var i = 0; i < f.settlements.length; i++) {
      var s = W.settlementById(f.settlements[i]);
      if (!s || s.destroyed) continue;
      var d = W.distance(s.tile, W.colonyTile);
      if (d < best) best = d;
    }
    if (best === Infinity) return 0.8;
    if (best <= 8) return 1.4;
    if (best <= 16) return 1;
    return 0.65;
  }

  function raidWeight(f) {
    var w = f.permanentEnemy ? 2.2 : 1;
    /* The angrier they are, the likelier it is them at the door. */
    w += Math.max(0, -f.goodwill) / 28;
    w *= nearnessFactor(f);
    if (now() - f.lastRaidTick < RAID_SPACING) w *= 0.4;
    return Math.max(0.05, w);
  }

  function raidPlan(f, points) {
    var kinds = (f.kind.pawnKinds && f.kind.pawnKinds.raider) || [];
    if (!kinds.length) kinds = [f.techLevel === 'neolithic' ? 'tribalRaider' : 'raider'];
    var strategies = (f.kind.raidStrategies || ['assault']).filter(function (s) {
      return points >= (STRATEGY_MIN[s] === undefined ? 0 : STRATEGY_MIN[s]);
    });
    if (!strategies.length) strategies = ['assault'];
    var factor = f.kind.raidPointsFactor === undefined ? 1 : f.kind.raidPointsFactor;

    /* events.js gets one object that is both the faction and the plan: the
       identity fields are copied so a caller that treats the result as a
       Faction reads the right id, and `faction` still points at the live
       civilization whose goodwill a fight will move. */
    return {
      faction: f, factionId: f.id, id: f.id, name: f.name, kindId: f.kindId, kind: f.kind,
      color: f.color, techLevel: f.techLevel, goodwill: f.goodwill, hostile: true,
      permanentEnemy: f.permanentEnemy, settlements: f.settlements.slice(),
      leaderName: f.leaderName, leaderTitle: f.leaderTitle,
      strategy: U.pick(strategies), strategies: strategies.slice(),
      pawnKinds: kinds.slice(), pointsFactor: factor, points: Math.round((points || 0) * factor)
    };
  }

  Factions.raiderCandidates = function () {
    var pool = factions.filter(function (f) { return f.hostile || f.permanentEnemy; });
    if (!pool.length) pool = factions.filter(function (f) { return f.permanentEnemy; });
    /* A world where everyone likes you still has to be able to produce a
       raid: the least fond of you sends it. */
    if (!pool.length && factions.length) {
      var worst = U.minBy(factions, function (f) { return f.goodwill; });
      if (worst) pool = [worst];
    }
    return pool;
  };

  Factions.pickRaider = function (points) {
    var pool = Factions.raiderCandidates();
    if (!pool.length) return null;
    var f = U.pickWeighted(pool, raidWeight);
    if (!f) return null;
    f.lastRaidTick = now();
    f.raidCount++;
    return raidPlan(f, points || 0);
  };

  /* ---------- allied help ---------- */

  Factions.requestHelp = function (factionId, opts) {
    opts = opts || {};
    var pool = factionId ? [Factions.get(factionId)] : Factions.allies();
    pool = pool.filter(function (f) {
      return f && !f.isPlayer && !f.hostile && f.kind.canAlly !== false &&
        f.goodwill >= ALLY_AT && now() - f.lastHelpTick >= HELP_COOLDOWN;
    });
    if (!pool.length) return null;
    var f = U.pickWeighted(pool, function (x) { return 1 + (x.goodwill - ALLY_AT) / 30; });
    if (!f) return null;
    var base = f.kind.allyHelpChance === undefined ? 0.35 : f.kind.allyHelpChance;
    var chance = U.clamp01(base * (0.6 + (f.goodwill - ALLY_AT) / 60));
    if (!U.chance(chance)) return null;

    f.lastHelpTick = now();
    var points = opts.points || 0;
    var kinds = (f.kind.pawnKinds && (f.kind.pawnKinds.guard || f.kind.pawnKinds.raider)) || ['raider'];
    return {
      faction: f, factionId: f.id, id: f.id, name: f.name, color: f.color,
      techLevel: f.techLevel, pawnKinds: kinds.slice(),
      count: U.clamp(Math.round(points / 130) + 1, 2, 8),
      points: Math.round(points * 0.6)
    };
  };

  /* ---------- diplomacy over time ---------- */

  function driftAll(days) {
    for (var i = 0; i < factions.length; i++) {
      var f = factions[i];
      if (f.permanentEnemy) continue;
      var rate = f.kind.goodwillDriftPerDay === undefined ? 0.4 : f.kind.goodwillDriftPerDay;
      if (!rate) continue;
      var target = f.baseGoodwill;
      /* Time alone does not end a war. Drift stops short of the peace line
         so that peace has to be bought, talked out or fought to. */
      if (f.hostile && target > WAR_DRIFT_CEILING) target = WAR_DRIFT_CEILING;
      var before = f.goodwill;
      f.goodwill = U.approach(f.goodwill, target, rate * days * (f.hostile ? 0.5 : 1));
      f.goodwill = tidy(f.goodwill);
      if (f.goodwill !== before) { invalidate(); checkThresholds(f, 'time passing'); }
    }
  }

  /* Bodies of people from a civilization you are not at war with, lying
     where your colonists left them. Charged once per pawn, whether it was
     reported through notePawnKilled or found here. */
  function sweepBodies(g) {
    var map = g && g.map;
    if (!map || !map.byDef) return;
    var corpses = map.byDef('corpse');
    for (var i = 0; i < corpses.length; i++) {
      var c = corpses[i];
      if (!c || !c.corpse) continue;
      noteFoundBody(c.corpse, c.spawnTick);
    }
  }

  /* ---------- offers the player can answer ---------- */

  function openOffer(f, type, fields) {
    var offer = {
      id: U.nextId(), factionId: f.id, type: type, tick: now(),
      expiresTick: now() + OFFER_TICKS, resolved: false, accepted: false, silver: 0
    };
    if (fields) for (var k in fields) offer[k] = fields[k];
    offers.push(offer);
    return offer;
  }

  Factions.offers = function () {
    return offers.filter(function (o) { return !o.resolved; });
  };
  Factions.offerFor = function (id) {
    var key = idOf(id);
    return offers.filter(function (o) { return !o.resolved && o.factionId === key; })[0] || null;
  };

  function silverStacks(map) {
    if (!map || !map.byDef) return [];
    return map.byDef('silver').filter(function (t) { return t && t.spawned; });
  }

  function countSilver(map) {
    return U.sum(silverStacks(map), function (t) { return t.stack || 0; });
  }

  function takeSilver(map, amount) {
    var stacks = silverStacks(map), left = amount;
    for (var i = 0; i < stacks.length && left > 0; i++) {
      var take = Math.min(left, stacks[i].stack || 0);
      if (take <= 0) continue;
      map.splitStack(stacks[i], take);
      left -= take;
    }
    return amount - left;
  }

  function payTribute(offer, f) {
    var g = game();
    var map = g && g.map;
    if (!map) return false;
    if (countSilver(map) < offer.silver) {
      letter('Nothing to pay with',
        'The ' + f.name + ' asked for ' + offer.silver + ' silver and the colony does not have it. ' +
        'Their messenger leaves empty-handed and unimpressed.', 'threat');
      return false;
    }
    takeSilver(map, offer.silver);
    if (g && g.recalcWealth) g.recalcWealth();
    return true;
  }

  function resolveOffer(offer, accept, expired) {
    if (!offer || offer.resolved) return false;
    offer.resolved = true;
    offer.accepted = !!accept;
    var f = Factions.get(offer.factionId);
    if (!f) return false;

    if (offer.type === 'peace') {
      if (accept) {
        Factions.makePeace(f.id, 'peace talks');
        Factions.adjustGoodwill(f.id, U.randInt(3, 10), 'peace talks');
      } else {
        Factions.adjustGoodwill(f.id, -5, expired ? 'ignored peace talks' : 'refused peace talks');
        letter('Talks with ' + f.name + ' collapse',
          'The envoy waited and went home. The war goes on.', 'threat');
      }
    } else if (offer.type === 'tribute') {
      if (accept && payTribute(offer, f)) {
        Factions.adjustGoodwill(f.id, U.randInt(8, 16), 'paid ' + offer.silver + ' silver in tribute');
        letter('Tribute paid',
          offer.silver + ' silver leaves for ' + f.name + '. ' + f.leaderTitle + ' ' +
          f.leaderName + ' is satisfied, for now.', 'neutral');
      } else {
        Factions.adjustGoodwill(f.id, -U.randInt(20, 30),
          expired ? 'ignored their demand' : 'refused their demand');
        letter('Demand refused',
          'The ' + f.name + ' wanted ' + offer.silver + ' silver and did not get it.', 'threat');
      }
    } else if (offer.type === 'alliance') {
      if (accept) {
        Factions.adjustGoodwill(f.id, 15, 'accepted an alliance');
      } else {
        Factions.adjustGoodwill(f.id, -8, expired ? 'ignored an alliance offer' : 'refused an alliance');
      }
    }
    return true;
  }

  Factions.respond = function (offerId, accept) {
    var id = typeof offerId === 'object' && offerId ? offerId.id : offerId;
    for (var i = 0; i < offers.length; i++) {
      if (offers[i].id === id) return resolveOffer(offers[i], accept, false);
    }
    return false;
  };

  function expireOffers(tickNow) {
    for (var i = 0; i < offers.length; i++) {
      var o = offers[i];
      if (!o.resolved && tickNow >= o.expiresTick) resolveOffer(o, false, true);
    }
    /* Keep the answered ones around briefly for the world screen, then
       let them go so a long game does not accumulate them. */
    if (offers.length > 24) offers.splice(0, offers.length - 24);
  }

  function sendMessage(tickNow) {
    var options = [];
    for (var i = 0; i < factions.length; i++) {
      var f = factions[i];
      if (f.permanentEnemy) continue;
      if (Factions.offerFor(f.id)) continue;
      if (f.hostile) {
        if (tickNow - f.atWarSinceTick > 2 * TICKS_PER_DAY) options.push({ f: f, type: 'peace', w: 2 });
      } else if (f.goodwill >= ALLIANCE_OFFER_AT && !f.allied && f.kind.canAlly !== false) {
        options.push({ f: f, type: 'alliance', w: 1.2 });
      } else if (f.goodwill >= 10) {
        options.push({ f: f, type: 'goodword', w: 0.8 });
      }
      if (!f.hostile && f.goodwill < ALLIANCE_OFFER_AT && f.goodwill > -60) {
        options.push({ f: f, type: 'tribute', w: 1 });
      }
    }
    if (!options.length) return null;
    var choice = U.pickWeighted(options, function (o) { return o.w; });
    if (!choice) return null;
    var f = choice.f;

    if (choice.type === 'peace') {
      openOffer(f, 'peace');
      letter(f.name + ' offer terms',
        f.leaderTitle + ' ' + f.leaderName + ' has sent an envoy under a white flag. The ' +
        f.kind.label + ' will end the war if you will. Answer from the world screen; the ' +
        'envoy will not wait more than a day or two.', 'neutral');
    } else if (choice.type === 'alliance') {
      openOffer(f, 'alliance');
      letter(f.name + ' propose an alliance',
        f.leaderTitle + ' ' + f.leaderName + ' thinks well enough of your colony to put it in ' +
        'writing. Accept and they will answer when raiders come; refuse and they will remember ' +
        'being turned down.', 'good');
    } else if (choice.type === 'tribute') {
      var g = game();
      var wealth = g && g.wealth ? g.wealth : 1500;
      var silver = U.clamp(Math.round(wealth / 22 + U.randInt(60, 240)), 80, 900);
      openOffer(f, 'tribute', { silver: silver });
      letter(f.name + ' demand tribute',
        'A rider from ' + f.leaderTitle + ' ' + f.leaderName + ' wants ' + silver +
        ' silver for the privilege of farming land the ' + f.kind.label + ' consider theirs. ' +
        'Pay, or tell them what you think of it.', 'threat');
    } else {
      var gain = U.randInt(2, 5);
      Factions.adjustGoodwill(f.id, gain, 'a friendly caravan passed through');
      letter('Word from ' + f.name,
        'A caravan of the ' + f.kind.label + ' camped nearby and traded news with your ' +
        'colonists. ' + f.leaderTitle + ' ' + f.leaderName + ' sends greetings.', 'good');
    }
    f.lastMessageTick = tickNow;
    return choice.type;
  }

  Factions.tickDiplomacy = function (g) {
    g = g || game();
    if (!factions.length) return;
    var tickNow = (g && typeof g.tick === 'number') ? g.tick : now();
    var elapsed = tickNow - lastDiploTick;
    if (elapsed <= 0) { lastDiploTick = tickNow; return; }
    lastDiploTick = tickNow;
    var days = elapsed / TICKS_PER_DAY;

    driftAll(days);
    sweepBodies(g);
    expireOffers(tickNow);
    if (U.chance(Math.min(0.9, MESSAGE_CHANCE_PER_DAY * days))) sendMessage(tickNow);
  };

  /* ---------- readouts ---------- */

  Factions.goodwillLabel = function (value) {
    if (value <= HOSTILE_AT) return 'hostile';
    if (value < -20) return 'resentful';
    if (value < 10) return 'wary';
    if (value < ALLY_AT) return 'friendly';
    return 'allied';
  };

  Factions.relationsSummary = function () {
    return factions.map(function (f) {
      return {
        id: f.id,
        name: f.name,
        kindId: f.kindId,
        kindLabel: f.kind.label || f.kindId,
        description: f.kind.description || '',
        leader: (f.leaderTitle ? f.leaderTitle + ' ' : '') + f.leaderName,
        leaderName: f.leaderName,
        leaderTitle: f.leaderTitle,
        techLevel: f.techLevel,
        goodwill: Math.round(f.goodwill),
        standing: Factions.goodwillLabel(f.goodwill),
        hostile: !!f.hostile,
        allied: !!f.allied,
        permanentEnemy: !!f.permanentEnemy,
        canTrade: f.kind.canTrade !== false && !f.hostile,
        color: f.color,
        settlementCount: Factions.settlementsOf(f.id).length,
        history: f.history.slice(-3).reverse(),
        offer: Factions.offerFor(f.id)
      };
    }).sort(function (a, b) { return b.goodwill - a.goodwill; });
  };

  /* ---------- save ---------- */

  Factions.save = function () {
    return {
      version: 1,
      lastDiploTick: lastDiploTick,
      names: Array.from(usedNames),
      deaths: Array.from(countedDeaths).slice(-400),
      offers: offers.map(function (o) {
        return {
          id: o.id, factionId: o.factionId, type: o.type, tick: o.tick,
          expiresTick: o.expiresTick, resolved: o.resolved, accepted: o.accepted, silver: o.silver
        };
      }),
      factions: factions.map(function (f) {
        return {
          id: f.id, kindId: f.kindId, name: f.name,
          leaderName: f.leaderName, leaderTitle: f.leaderTitle, leaderGender: f.leaderGender,
          color: f.color, colorSecondary: f.colorSecondary,
          goodwill: f.goodwill, baseGoodwill: f.baseGoodwill,
          hostile: f.hostile, allied: f.allied, permanentEnemy: f.permanentEnemy,
          settlements: f.settlements.slice(), techLevel: f.techLevel,
          history: f.history.slice(), atWarSinceTick: f.atWarSinceTick,
          lastRaidTick: f.lastRaidTick, lastHelpTick: f.lastHelpTick,
          raidCount: f.raidCount, tradeCount: f.tradeCount
        };
      })
    };
  };

  Factions.load = function (obj) {
    /* A save with nothing in it is not a reason to throw away the
       civilizations the running game already has. */
    if (!obj || !obj.factions || !obj.factions.length) return false;
    Factions.reset();
    lastDiploTick = obj.lastDiploTick || 0;
    (obj.names || []).forEach(function (n) { usedNames.add(n); });
    (obj.deaths || []).forEach(function (d) { countedDeaths.add(d); });

    for (var i = 0; i < obj.factions.length; i++) {
      var raw = obj.factions[i];
      var kind = kindDef(raw.kindId) || fallbackKind(raw.kindId);
      var f = {
        id: raw.id, kindId: raw.kindId, kind: kind, name: raw.name || kind.label,
        leaderName: raw.leaderName || '', leaderTitle: raw.leaderTitle || '',
        leaderGender: raw.leaderGender || 'female',
        color: raw.color || kind.colorPrimary || '#8f97a3',
        colorSecondary: raw.colorSecondary || kind.colorSecondary || '#c4ccd8',
        goodwill: raw.goodwill === undefined ? 0 : raw.goodwill,
        baseGoodwill: raw.baseGoodwill === undefined ? 0 : raw.baseGoodwill,
        hostile: !!raw.hostile, allied: !!raw.allied,
        permanentEnemy: !!raw.permanentEnemy || !!kind.permanentEnemy,
        settlements: (raw.settlements || []).slice(),
        techLevel: raw.techLevel || kind.techLevel || 'industrial',
        history: (raw.history || []).slice(),
        atWarSinceTick: raw.atWarSinceTick || 0,
        lastRaidTick: raw.lastRaidTick === undefined ? -RAID_SPACING : raw.lastRaidTick,
        lastHelpTick: raw.lastHelpTick === undefined ? -HELP_COOLDOWN : raw.lastHelpTick,
        raidCount: raw.raidCount || 0, tradeCount: raw.tradeCount || 0
      };
      if (f.permanentEnemy) { f.hostile = true; f.allied = false; }
      factions.push(f);
      byId.set(f.id, f);
      usedNames.add(f.name);
    }

    (obj.offers || []).forEach(function (o) {
      offers.push({
        id: o.id, factionId: o.factionId, type: o.type, tick: o.tick || 0,
        expiresTick: o.expiresTick || 0, resolved: !!o.resolved,
        accepted: !!o.accepted, silver: o.silver || 0
      });
    });

    invalidate();
    syncCombat();
    return true;
  };

  /* Thresholds are worth reading from outside: the world screen draws the
     bar with the same numbers this file enforces. */
  Factions.HOSTILE_AT = HOSTILE_AT;
  Factions.PEACE_AT = PEACE_AT;
  Factions.ALLY_AT = ALLY_AT;

  root.Factions = Factions;
})(this);
