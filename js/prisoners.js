/* ============================================================
   prisoners.js - capture, the prison, warden work, recruitment.

   A prisoner is an ordinary pawn wearing the player's faction id with
   `pawn.prisoner` hung off the side of it. Nothing else in the game had
   to learn a new pawn type: think.js still thinks, needs.js still feeds
   them a mood, health.js still starves them. What this file adds is the
   three things that make a prison a prison - they cannot work, they will
   not stay put if you leave the door open, and somebody has to bring
   them dinner.

   Everything prisoner-shaped lives in plain fields on `pawn.prisoner`,
   because save.js serialises a pawn by walking its own properties: an
   object of numbers and strings round-trips for free, a reference to a
   bed would drag the map through the serialiser.

   This is the one file outside workgivers.js allowed to register work
   givers, and it registers exactly one column: warden.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* jobs.js, pathfind.js, regions.js and workgivers.js are all above this
     file in the load order, so binding them here is safe. Game, Factions
     and Needs are reached through sys() at tick time instead, which is
     what lets the file load alone in a bare sandbox. */
  var T = root.T;
  var Res = root.Res;
  var Jobs = root.Jobs;
  var Toils = root.Toils;
  var Path = root.Path;
  var Regions = root.Regions;
  var WorkGivers = root.WorkGivers;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  function sys(name) { return root[name] || null; }
  function now() {
    var G = root.Game;
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  /* ---------- tuning ----------
     Spans are in ticks: 60 to the second, 60000 to the day. */

  var DAY = 60000;
  var RARE = 250;              /* the staggered beat every prisoner runs on   */
  var ESCAPE_BEAT = 30;        /* a prisoner already running is checked often */
  var SWEEP_BEAT = 600;        /* how often the roster looks for a body       */

  /* Starting resistance by the tech level of the civilization that raised
     them. A tribal kidnapper gives up on the idea of the colony faster
     than a spacer who has been told what a rimworld is. */
  var RESISTANCE_BY_TECH = {
    neolithic: [5, 13], medieval: [7, 16], industrial: [9, 20], spacer: [15, 30]
  };
  var RESISTANCE_DECAY_PER_DAY = 0.12;   /* time alone wears anyone down */

  var CHAT_WORK = 520;         /* work units in one recruitment attempt   */
  var CHAT_COOLDOWN = 6000;    /* a tenth of a day between attempts       */
  var FEED_AT = 0.55;          /* a warden tops them up below this        */
  var UNWATCHED_TICKS = 90000; /* a day and a half with nobody looking in */
  var EXECUTE_WORK = 240;
  var RELEASE_WORK = 120;
  var CARRY_TIMEOUT = 9000;

  /* Escape chance per rare beat once they have an opening. 250 ticks at
     0.02 is about one attempt every twenty seconds of real time at 1x,
     which is fast enough that an open door matters within a day. */
  var ESCAPE_CHANCE = 0.02;

  var MODES = ['hold', 'recruit', 'release', 'execute'];

  var Prisoners = {};
  Prisoners.MODES = MODES;

  /* ============================================================
     Small shared helpers
     ============================================================ */

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    if (typeof pawn.label === 'function') return pawn.label();
    var n = pawn.name;
    return (n && (n.nick || n.first)) || 'someone';
  }

  function fullName(pawn) {
    if (pawn && typeof pawn.fullName === 'function') return pawn.fullName();
    return nameOf(pawn);
  }

  function msg(text, pawn, type) {
    var G = sys('Game');
    if (!G || !G.msg) return;
    G.msg(text, { type: type || 'info', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }

  function letter(title, text, kind, pawn) {
    var G = sys('Game');
    if (!G || !G.letter) return;
    G.letter(title, text, { kind: kind || 'neutral', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }

  function think(pawn, thoughtId, opts) {
    var N = sys('Needs');
    if (!N || !N.addThought) return;
    if (Defs && Defs.has && !Defs.has('thought', thoughtId)) return;
    N.addThought(pawn, thoughtId, opts);
  }

  function hasTrait(pawn, id) {
    var list = pawn && pawn.traits;
    if (!list) return false;
    for (var i = 0; i < list.length; i++) {
      if (((list[i] && list[i].id) || list[i]) === id) return true;
    }
    return false;
  }

  function skillLevel(pawn, id) {
    var s = pawn && pawn.skills && pawn.skills[id];
    return (s && typeof s.level === 'number') ? s.level : 0;
  }

  function moodOf(pawn) {
    var N = sys('Needs');
    if (N && N.mood) return N.mood(pawn);
    return typeof pawn.mood === 'number' ? pawn.mood : 0.5;
  }

  function pawnById(map, id) {
    if (!map || !id) return null;
    for (var i = 0; i < map.pawns.length; i++) if (map.pawns[i].id === id) return map.pawns[i];
    return null;
  }

  /* Colonists who are not themselves behind the door. map.colonists()
     answers "player faction, human, alive", and a prisoner is all three. */
  function freeColonists(map) {
    var out = [], list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.dead || !p.isHuman || p.faction !== 'player' || p.prisoner) continue;
      out.push(p);
    }
    return out;
  }

  /* ============================================================
     Prisoner beds and the room they stand in
     ============================================================ */

  var _bedDefIds = null;

  function bedDefIds() {
    if (_bedDefIds) return _bedDefIds;
    _bedDefIds = [];
    var all = Defs.all('thing');
    for (var i = 0; i < all.length; i++) {
      var b = all[i].building;
      if (b && b.isBed) _bedDefIds.push(all[i].id);
    }
    return _bedDefIds;
  }

  function allBeds(map) {
    var out = [], ids = bedDefIds();
    for (var i = 0; i < ids.length; i++) {
      var list = map.byDef(ids[i]);
      for (var j = 0; j < list.length; j++) if (list[j].spawned) out.push(list[j]);
    }
    return out;
  }

  Prisoners.beds = function (map) {
    if (!map) return [];
    return allBeds(map).filter(function (b) { return b.forPrisoners === true; });
  };

  Prisoners.setBedForPrisoners = function (bed, on) {
    if (!bed || !bed.def || !bed.def.building || !bed.def.building.canBeForPrisoners) return false;
    on = !!on;
    if (bed.forPrisoners === on) return true;
    bed.forPrisoners = on;

    /* Changing which side of the door a bed is on cancels whoever claimed
       it: a colonist does not keep an assigned bunk in the cells, and a
       prisoner does not keep one in the barracks. */
    var map = bed.map || null;
    var owner = bed.ownerId && map ? pawnById(map, bed.ownerId) : null;
    if (owner && !!owner.prisoner !== on) {
      if (owner.ownedBedId === bed.id) owner.ownedBedId = null;
      bed.ownerId = null;
    }
    if (map && map.__prisonRooms) map.__prisonRooms = null;
    return true;
  };

  /* A room is a prison when every bed in it is a prisoner bed and there is
     at least one. Beds move rarely and rooms are rebuilt by Regions, so the
     answer is cached for a rare tick rather than recomputed per prisoner. */
  function prisonRoomIds(map) {
    var cache = map.__prisonRooms, t = now();
    if (cache && t >= cache.tick && t - cache.tick < RARE) return cache.ids;

    var beds = allBeds(map), cells = Object.create(null), free = Object.create(null);
    for (var i = 0; i < beds.length; i++) {
      var rid = Regions ? Regions.roomIdAt(map, beds[i].x, beds[i].y) : 0;
      if (!rid) continue;                       /* the outdoors is nobody's cell */
      if (beds[i].forPrisoners) cells[rid] = true;
      else free[rid] = true;
    }
    var ids = Object.create(null);
    Object.keys(cells).forEach(function (k) { if (!free[k]) ids[k] = true; });
    map.__prisonRooms = { tick: t, ids: ids };
    return ids;
  }

  Prisoners.prisonRoomIds = prisonRoomIds;

  Prisoners.isInPrison = function (pawn) {
    if (!pawn || !pawn.map || !Regions) return false;
    var rid = Regions.roomIdAt(pawn.map, pawn.x, pawn.y);
    return !!(rid && prisonRoomIds(pawn.map)[rid]);
  };

  /* A prisoner bed nobody else has a claim on, reachable by the carrier. */
  function freePrisonerBed(map, carrier, forWhom) {
    var beds = Prisoners.beds(map).filter(function (b) {
      if (b.ownerId && (!forWhom || b.ownerId !== forWhom.id)) {
        var owner = pawnById(map, b.ownerId);
        if (owner && !owner.dead) return false;
      }
      if (!Res.canReserve(carrier, T.thing(b), 1)) return false;
      var here = map.pawnsAt(b.x, b.y);
      for (var i = 0; i < here.length; i++) {
        if (here[i] !== forWhom && !here[i].dead) return false;
      }
      return true;
    });
    if (!beds.length) return null;
    return Path ? Path.closestReachable(map, carrier, beds, null) : beds[0];
  }

  /* ============================================================
     Capture
     ============================================================ */

  Prisoners.isPrisoner = function (pawn) {
    return !!(pawn && pawn.prisoner && !pawn.dead);
  };

  Prisoners.canCapture = function (pawn) {
    if (!pawn || pawn.dead || !pawn.map) return false;
    if (!pawn.isHuman || pawn.prisoner) return false;
    if (!pawn.downed) return false;
    /* Anyone who is not already ours: a downed raider, and also the trader
       you decided to rob. trade.js prices that second one for you. */
    return pawn.faction !== 'player';
  };

  function rollResistance(pawn) {
    var F = sys('Factions');
    var faction = F && F.get ? F.get(pawn.faction) : null;
    var tech = (faction && faction.techLevel) || (pawn.faction === 'raider' ? 'industrial' : 'industrial');
    var band = RESISTANCE_BY_TECH[tech] || RESISTANCE_BY_TECH.industrial;
    var r = U.randRange(band[0], band[1]);

    if (hasTrait(pawn, 'ironWilled')) r *= 1.45;
    if (hasTrait(pawn, 'volatile')) r *= 0.85;
    if (hasTrait(pawn, 'psychopath')) r *= 1.2;
    if (hasTrait(pawn, 'kind')) r *= 0.8;
    if (hasTrait(pawn, 'abrasive')) r *= 1.15;
    if (hasTrait(pawn, 'wimp')) r *= 0.8;
    if (hasTrait(pawn, 'tough')) r *= 1.15;
    /* Somebody who knows how to talk knows how to be talked at. */
    r *= 1 + skillLevel(pawn, 'social') * 0.02;
    return Math.round(r * 10) / 10;
  }

  Prisoners.resistanceFor = rollResistance;

  Prisoners.capture = function (pawn, by) {
    if (!Prisoners.canCapture(pawn)) return false;
    var map = pawn.map;
    var t = now();

    var oldFaction = pawn.faction;
    var state = {
      factionId: oldFaction,
      factionName: null,
      resistance: rollResistance(pawn),
      initialResistance: 0,
      mode: 'recruit',
      capturedTick: t,
      capturedById: by ? by.id : 0,
      lastWatchedTick: t,
      lastChatTick: t,
      lastFedTick: t,
      chats: 0,
      escapeWill: 0,
      escaping: false,
      escapeTargetIdx: -1,
      cellCount: 0,
      deathNoted: false,
      /* What they were allowed to do before, so recruiting hands the
         colony a pawn with their own priorities rather than a blank sheet. */
      workPriority: pawn.workPriority || null
    };
    var F = sys('Factions');
    var faction = F && F.get ? F.get(oldFaction) : null;
    state.factionName = faction ? faction.name : null;
    state.initialResistance = state.resistance;

    pawn.prisoner = state;
    pawn.faction = 'player';
    pawn.drafted = false;
    pawn.draftTarget = null;
    pawn.manhunter = false;
    pawn.aimTarget = null;
    pawn.mentalState = null;

    /* A prisoner is not staff. Zeroing the column is what keeps
       workgivers.js from handing a captured raider a hauling job. */
    var blank = {};
    var types = Defs.all('workType');
    for (var i = 0; i < types.length; i++) blank[types[i].id] = 0;
    pawn.workPriority = blank;

    if (pawn.equipment && typeof pawn.dropEquipment === 'function') pawn.dropEquipment();
    else if (pawn.equipment && map && map.moveThing) {
      map.moveThing(pawn.equipment, pawn.x, pawn.y);
      pawn.equipment = null;
    }

    var J = sys('Jobs');
    if (pawn.job && J && J.end) J.end(pawn, 'interrupted');
    if (Res) Res.releaseAll(pawn);

    letter('Prisoner taken',
      fullName(pawn) + ' has been carried into your cells' +
      (state.factionName ? ', a captive of the ' + state.factionName : '') +
      '. Their will to resist stands at ' + U.fmt(state.resistance, 1) +
      '. Feed them, talk to them, and they may yet come round.',
      'neutral', pawn);
    return true;
  };

  /* ============================================================
     Mood, resistance and the will to run
     ============================================================ */

  /* The prisoner's own standing misery. `colonistLost` is the frozen
     thought that means "my people are gone", which is exactly what a
     captive is carrying around; the mood number is stated here so a
     prisoner's grief is not the same size as a colonist's. */
  function captivityThought(pawn, st) {
    var mood = -0.06;
    if (hasTrait(pawn, 'ascetic')) mood *= 0.6;
    if (hasTrait(pawn, 'psychopath')) return;
    if (st.mode === 'execute') mood *= 1.8;
    think(pawn, 'colonistLost', { mood: mood, duration: DAY, noStack: true });
  }

  function decayResistance(pawn, st) {
    if (st.resistance <= 0) return;
    var rate = RESISTANCE_DECAY_PER_DAY * (RARE / DAY);
    /* Comfort is an argument. A prisoner who is warm, fed and sleeping in
       a real bed loses the thread of why they were fighting you. */
    rate *= U.curve([[0, 0.25], [0.4, 0.8], [0.7, 1.4], [1, 2.0]], moodOf(pawn));
    if (hasTrait(pawn, 'ironWilled')) rate *= 0.5;
    st.resistance = Math.max(0, st.resistance - rate);
  }

  /* What is standing between them and the horizon, in words, or null when
     the cell is doing its job. */
  Prisoners.escapeOpening = function (pawn) {
    var map = pawn && pawn.map;
    if (!map || !Regions) return null;
    var st = pawn.prisoner;
    if (!st) return null;

    var room = Regions.roomAt(map, pawn.x, pawn.y);
    if (!room || room.id === 0 || room.outdoor || room.touchesEdge) {
      return 'the cell stands open to the outside';
    }
    if (!prisonRoomIds(map)[room.id]) return 'they are out of their cell';

    /* Knocking a wall out merges the cell into whatever was behind it, so
       a prison that suddenly got bigger is a prison with a hole in it. The
       remembered size only ever shrinks, or a breach would be adopted as
       the new normal on the next beat. */
    if (st.cellCount > 0 && room.size > st.cellCount + 2) return 'a hole in the wall';
    if (room.size < st.cellCount || !st.cellCount) st.cellCount = room.size;

    for (var i = 0; i < room.doorIds.length; i++) {
      var door = map.thing(room.doorIds[i]);
      if (door && door.open === true) return 'a door left standing open';
    }
    if (now() - st.lastWatchedTick > UNWATCHED_TICKS) return 'nobody has looked in on them for days';
    return null;
  };

  /* Somewhere off the edge of the map, reachable from where they stand. */
  function escapeCell(pawn) {
    var map = pawn.map;
    var MG = sys('MapGen');
    var cands = [], sides = ['n', 'e', 's', 'w'], i, k;
    if (MG && MG.edgeSpawnCells) {
      for (i = 0; i < sides.length; i++) {
        var cells = MG.edgeSpawnCells(map, sides[i]);
        /* Every third cell is plenty: the pathfinder only has to find one
           way out, and probing four hundred candidates is not free. */
        for (k = 0; k < cells.length; k += 3) cands.push(cells[k]);
      }
    }
    if (!cands.length) {
      for (i = 1; i < map.w - 1; i += 4) {
        if (map.passable(i, 0)) cands.push({ x: i, y: 0 });
        if (map.passable(i, map.h - 1)) cands.push({ x: i, y: map.h - 1 });
      }
    }
    if (!cands.length || !Path) return null;
    return Path.closestReachable(map, pawn, cands, null);
  }

  function beginEscape(pawn, st, reason) {
    var cell = escapeCell(pawn);
    if (!cell) return false;
    st.escaping = true;
    st.escapeWill = 1;
    st.escapeTargetIdx = pawn.map.idx(cell.x, cell.y);
    startEscapeJob(pawn, st);
    letter('A prisoner is escaping',
      fullName(pawn) + ' has walked out of the cells - ' + reason +
      '. Send a warden after them before they reach the edge of the map.',
      'threat', pawn);
    return true;
  }

  function startEscapeJob(pawn, st) {
    var map = pawn.map;
    if (st.escapeTargetIdx < 0) return false;
    var x = map.xOf(st.escapeTargetIdx), y = map.yOf(st.escapeTargetIdx);
    if (!map.passable(x, y) || (Path && !Path.reachable(map, pawn.x, pawn.y, x, y, { pawn: pawn }))) {
      var cell = escapeCell(pawn);
      if (!cell) { st.escaping = false; return false; }
      st.escapeTargetIdx = map.idx(cell.x, cell.y);
      x = cell.x; y = cell.y;
    }
    var J = sys('Jobs');
    if (!J) return false;
    if (pawn.job) J.end(pawn, 'interrupted');
    return J.start(pawn, J.make('prisonerEscape', T.cell(x, y)));
  }

  /* Back to the cell under their own steam, which is what a prisoner does
     between meals when the door is shut and they have no better idea. */
  function sendHome(pawn, st) {
    var map = pawn.map;
    var bed = pawn.ownedBedId ? map.thing(pawn.ownedBedId) : null;
    if (!bed || !bed.spawned || !bed.forPrisoners) {
      bed = freePrisonerBed(map, pawn, pawn);
      if (bed) { pawn.ownedBedId = bed.id; bed.ownerId = pawn.id; }
    }
    if (!bed) return false;
    var J = sys('Jobs');
    if (!J) return false;
    if (pawn.job) J.end(pawn, 'interrupted');
    return J.start(pawn, J.make('layDown', T.thing(bed), null, { state: { asleep: false } }));
  }

  /* ============================================================
     The per-prisoner tick
     ============================================================ */

  Prisoners.tick = function (pawn) {
    var st = pawn && pawn.prisoner;
    if (!st) return;
    if (pawn.dead) { noteDeath(pawn, st); return; }
    if (!pawn.map) return;

    var t = now();
    if ((t + pawn.id) % SWEEP_BEAT === 0) Prisoners.sweep(pawn.map);

    /* In somebody's arms, or flat on the floor: the world is happening to
       them rather than the other way round. */
    if (pawn.carriedBy) { st.lastWatchedTick = t; return; }
    if (pawn.downed) return;

    if (st.escaping) {
      if ((t + pawn.id) % ESCAPE_BEAT === 0 && (!pawn.job || pawn.job.defId !== 'prisonerEscape')) {
        startEscapeJob(pawn, st);
      }
      return;
    }

    if ((t + pawn.id) % RARE !== 0) return;

    if (watchedNow(pawn)) st.lastWatchedTick = t;
    decayResistance(pawn, st);
    captivityThought(pawn, st);

    var opening = Prisoners.escapeOpening(pawn);
    if (!opening) {
      st.escapeWill = Math.max(0, st.escapeWill - 0.05);
      /* Wandered into the corner of their own cell is fine; wandered into
         the kitchen is not, and think.js will keep doing it unless the
         job in hand is replaced. */
      if (!Prisoners.isInPrison(pawn) && !pawn.asleep) sendHome(pawn, st);
      return;
    }

    /* Resistance is also the appetite for a run at the door, so the ones
       you have nearly talked round are the ones who stay put. */
    var will = 0.35 + 0.05 * st.resistance;
    if (hasTrait(pawn, 'ironWilled')) will += 0.25;
    if (hasTrait(pawn, 'wimp')) will -= 0.15;
    var H = sys('Health');
    var legs = (H && H.capacity) ? H.capacity(pawn, 'moving') : 1;
    st.escapeWill = U.clamp01(Math.max(st.escapeWill, will * legs));

    if (legs < 0.4) return;
    if (U.chance(ESCAPE_CHANCE * st.escapeWill)) beginEscape(pawn, st, opening);
  };

  /* Is anybody free standing in the same room right now. */
  function watchedNow(pawn) {
    var map = pawn.map;
    if (!Regions) return false;
    var rid = Regions.roomIdAt(map, pawn.x, pawn.y);
    var list = freeColonists(map);
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (U.cheb(c.x, c.y, pawn.x, pawn.y) <= 1) return true;
      if (rid && Regions.roomIdAt(map, c.x, c.y) === rid) return true;
    }
    return false;
  }

  /* ============================================================
     Death, and who hears about it

     A prisoner killed inside their own tick - starvation, an infection -
     reaches noteDeath through Prisoners.tick, because game.js tests
     pawn.dead before pawn.tick() rather than after. One shot by a raider
     dies inside somebody else's tick and is found by the sweep instead.
     ============================================================ */

  var roster = [];

  function watch(pawn) {
    for (var i = 0; i < roster.length; i++) if (roster[i] === pawn) return;
    roster.push(pawn);
  }

  Prisoners.sweep = function (map) {
    for (var i = roster.length - 1; i >= 0; i--) {
      var p = roster[i];
      if (!p || !p.prisoner) { roster.splice(i, 1); continue; }
      if (p.dead) { noteDeath(p, p.prisoner); roster.splice(i, 1); continue; }
      if (map && p.map !== map && !p.map) roster.splice(i, 1);
    }
  };

  function noteDeath(pawn, st) {
    if (!st || st.deathNoted) return;
    st.deathNoted = true;

    var cause = (pawn.health && pawn.health.deathCause) || 'unknown causes';
    var starved = cause === 'starvation';
    var executed = !!st.executed;
    if (executed) return;                    /* execute() has already paid for it */

    var map = pawn.map;
    var who = fullName(pawn);

    /* The colony notices either way, and notices harder when the cause was
       a food bowl nobody filled. */
    if (map) {
      var list = freeColonists(map);
      for (var i = 0; i < list.length; i++) {
        think(list[i], 'witnessedDeathAlly', {
          otherPawnId: pawn.id,
          mood: starved ? -0.05 : -0.03,
          duration: starved ? DAY * 4 : DAY * 2
        });
      }
    }

    var F = sys('Factions');
    if (F && F.adjustGoodwill && st.factionId && st.factionId !== 'player') {
      F.adjustGoodwill(st.factionId, starved ? -14 : -6,
        starved ? 'you starved ' + who + ' to death' : who + ' died in your cells');
    }

    if (starved) {
      letter('A prisoner has starved',
        who + ' died in your cells with an empty stomach. Nobody in the colony is pretending ' +
        'they did not know, and ' + (st.factionName || 'their people') + ' will hear about it.',
        'death', pawn);
    } else {
      msg(who + ' has died in the cells.', pawn, 'threat');
    }
  }

  /* ============================================================
     Recruitment
     ============================================================ */

  Prisoners.recruitChance = function (warden, prisoner) {
    if (!warden || !prisoner || !prisoner.prisoner) return 0;
    var st = prisoner.prisoner;

    var chance = 0.045 + 0.022 * skillLevel(warden, 'social');
    if (hasTrait(warden, 'kind')) chance *= 1.30;
    if (hasTrait(warden, 'abrasive')) chance *= 0.70;
    if (hasTrait(warden, 'psychopath')) chance *= 0.75;

    /* A prisoner who is comfortable listens; a prisoner in agony does not. */
    chance *= U.curve([[0, 0.35], [0.35, 0.8], [0.6, 1.0], [0.9, 1.35]], moodOf(prisoner));
    chance *= U.curve([[0, 1.70], [5, 1.15], [15, 0.80], [30, 0.45]], st.resistance);

    if (hasTrait(prisoner, 'ironWilled')) chance *= 0.70;
    if (hasTrait(prisoner, 'volatile')) chance *= 1.15;
    if (hasTrait(prisoner, 'kind')) chance *= 1.10;
    if (hasTrait(prisoner, 'psychopath')) chance *= 0.80;

    /* Their own government's opinion of you is an argument either way. */
    var F = sys('Factions');
    if (F && F.goodwill && st.factionId && st.factionId !== 'player') {
      chance *= 1 + U.clamp(F.goodwill(st.factionId), -100, 100) / 400;
    }
    return U.clamp(chance, 0.01, 0.96);
  };

  /* One conversation. Returns 'joined' | 'progress' | 'failed'. */
  Prisoners.chat = function (warden, prisoner) {
    var st = prisoner && prisoner.prisoner;
    if (!st || prisoner.dead) return 'failed';
    st.lastChatTick = now();
    st.lastWatchedTick = now();
    st.chats++;

    var chance = Prisoners.recruitChance(warden, prisoner);
    if (!U.chance(chance)) {
      /* A conversation that goes nowhere still went somewhere: they are a
         little more tired of the room, and a little crosser with the
         person who keeps walking into it. */
      st.resistance = Math.max(0, st.resistance - U.randRange(0.05, 0.25));
      think(prisoner, 'insulted', { otherPawnId: warden.id, mood: -0.02 });
      msg(nameOf(warden) + ' got nowhere with ' + nameOf(prisoner) + '.', warden);
      return 'failed';
    }

    var drop = U.randRange(0.9, 2.1) * (1 + skillLevel(warden, 'social') * 0.055);
    if (hasTrait(warden, 'kind')) drop *= 1.2;
    st.resistance = Math.max(0, st.resistance - drop);
    think(prisoner, 'chatted', { otherPawnId: warden.id });

    if (st.resistance <= 0) {
      Prisoners.recruit(warden, prisoner);
      return 'joined';
    }
    msg(nameOf(warden) + ' talked ' + nameOf(prisoner) + ' down to ' +
        U.fmt(st.resistance, 1) + ' resistance.', warden, 'good');
    return 'progress';
  };

  Prisoners.recruit = function (warden, prisoner) {
    var st = prisoner && prisoner.prisoner;
    if (!st || prisoner.dead) return false;
    var map = prisoner.map;
    var who = fullName(prisoner);

    prisoner.prisoner = false;
    prisoner.faction = 'player';
    prisoner.workPriority = st.workPriority || prisoner.workPriority || {};
    prisoner.drafted = false;
    U.remove(roster, prisoner);

    /* Their bunk was a cell. Let them find a bed like anybody else. */
    var bed = prisoner.ownedBedId && map ? map.thing(prisoner.ownedBedId) : null;
    if (bed && bed.forPrisoners) {
      if (bed.ownerId === prisoner.id) bed.ownerId = null;
      prisoner.ownedBedId = null;
    }
    var J = sys('Jobs');
    if (prisoner.job && J && J.end) J.end(prisoner, 'interrupted');

    think(prisoner, 'newColonistJoined');
    if (map) {
      var list = freeColonists(map);
      for (var i = 0; i < list.length; i++) {
        if (list[i] !== prisoner) think(list[i], 'recruitedColonist');
      }
    }

    var F = sys('Factions');
    if (F && F.notePrisonerRecruited && st.factionId && st.factionId !== 'player') {
      F.notePrisonerRecruited(st.factionId, who);
    }

    letter(who + ' has joined the colony',
      (warden ? nameOf(warden) + ' finally got through to ' + who + '. ' : '') +
      who + ' has stopped counting the days until somebody comes for them and started ' +
      'counting the work that needs doing. They are one of yours now' +
      (st.factionName ? ', and the ' + st.factionName + ' will not thank you for it' : '') + '.',
      'good', prisoner);
    return true;
  };

  /* ============================================================
     Release and execution
     ============================================================ */

  Prisoners.release = function (prisoner, by) {
    var st = prisoner && prisoner.prisoner;
    if (!st || prisoner.dead) return false;
    var map = prisoner.map;
    var who = fullName(prisoner);

    prisoner.prisoner = false;
    prisoner.faction = st.factionId || 'neutral';
    prisoner.released = true;
    U.remove(roster, prisoner);

    var bed = prisoner.ownedBedId && map ? map.thing(prisoner.ownedBedId) : null;
    if (bed && bed.ownerId === prisoner.id) bed.ownerId = null;
    prisoner.ownedBedId = null;

    var J = sys('Jobs');
    if (prisoner.job && J && J.end) J.end(prisoner, 'interrupted');

    var cell = escapeCell(prisoner);
    if (cell && J) J.start(prisoner, J.make('prisonerLeave', T.cell(cell.x, cell.y)));

    var F = sys('Factions');
    if (F && F.notePrisonerReleased && st.factionId && st.factionId !== 'player') {
      F.notePrisonerReleased(st.factionId, who);
    }

    letter('Prisoner released',
      who + ' has been let out of the cells and pointed at the horizon' +
      (by ? ' by ' + nameOf(by) : '') + '. ' +
      (st.factionName ? 'The ' + st.factionName + ' will remember the gesture.'
                      : 'Word of it will get around.'),
      'good', prisoner);
    return true;
  };

  Prisoners.execute = function (prisoner, by) {
    var st = prisoner && prisoner.prisoner;
    if (!st || prisoner.dead) return false;
    var map = prisoner.map;
    var who = fullName(prisoner);
    st.executed = true;
    st.deathNoted = true;
    U.remove(roster, prisoner);

    var H = sys('Health');
    if (H && H.kill) H.kill(prisoner, 'execution');
    else { prisoner.dead = true; prisoner.downed = false; }

    /* Everybody who can feel anything about it, feels it. The thought def
       already refuses to attach to a psychopath, which is the whole of the
       exemption the brief asks for. */
    if (map) {
      var list = freeColonists(map);
      for (var i = 0; i < list.length; i++) {
        if (list[i] === by && hasTrait(list[i], 'bloodlust')) {
          think(list[i], 'killedHumanBloodlust');
          continue;
        }
        think(list[i], 'witnessedDeathAlly', {
          otherPawnId: prisoner.id, mood: -0.11, duration: DAY * 6
        });
      }
    }

    var F = sys('Factions');
    if (F && st.factionId && st.factionId !== 'player') {
      if (F.adjustGoodwill) F.adjustGoodwill(st.factionId, -32, 'you executed ' + who);
      if (F.declareWar) F.declareWar(st.factionId, 'the execution of ' + who);
    }

    letter('Prisoner executed',
      who + ' was executed in the cells' + (by ? ' by ' + nameOf(by) : '') +
      '. The colony watched it happen and will not be shaking it off quickly' +
      (st.factionName ? ', and the ' + st.factionName + ' have heard' : '') + '.',
      'death', prisoner);
    return true;
  };

  Prisoners.setMode = function (prisoner, mode) {
    var st = prisoner && prisoner.prisoner;
    if (!st || MODES.indexOf(mode) < 0) return false;
    st.mode = mode;
    return true;
  };

  Prisoners.all = function (map) {
    var out = [];
    if (!map) return out;
    for (var i = 0; i < map.pawns.length; i++) {
      var p = map.pawns[i];
      if (p.prisoner && !p.dead) out.push(p);
    }
    return out;
  };

  Prisoners.summary = function (prisoner) {
    var st = prisoner && prisoner.prisoner;
    if (!st) return '';
    if (st.escaping) return 'Escaping';
    return 'Prisoner - resistance ' + U.fmt(st.resistance, 1) +
           ' (' + st.mode + ')';
  };

  /* ============================================================
     Carrying people

     jobs.js keeps its lift/drag helpers private, so the three toils a
     capture needs live here. A carried pawn is never taken off the map:
     they are dragged onto the carrier's cell each tick, which is what
     keeps them bleeding, visible and targetable on the way to the bed.
     ============================================================ */

  function dragged(carrier) {
    var p = carrier.carriedPawn;
    if (!p || p.dead) return false;
    if (p.x === carrier.x && p.y === carrier.y) return true;
    var oldX = p.x, oldY = p.y;
    p.x = carrier.x; p.y = carrier.y;
    p.fx = carrier.fx === undefined ? carrier.x : carrier.fx;
    p.fy = carrier.fy === undefined ? carrier.y : carrier.fy;
    if (carrier.map && carrier.map.notePawnMoved) carrier.map.notePawnMoved(p, oldX, oldY);
    return true;
  }

  function findCellToil() {
    return Toils.custom({
      name: 'findPrisonBed',
      tick: function (pawn, job) {
        var map = pawn.map;
        var known = job.targetB ? T.resolve(job.targetB, map) : null;
        if (known && known.spawned && known.forPrisoners && Res.reserve(pawn, job.targetB, 1)) return 'next';
        var captive = T.resolve(job.targetA, map);
        if (!captive) return 'fail';
        var bed = freePrisonerBed(map, pawn, captive);
        if (!bed) return 'fail';
        job.targetB = T.thing(bed);
        Res.reserve(pawn, job.targetB, 1);
        return 'next';
      }
    });
  }

  function liftToil() {
    return Toils.custom({
      name: 'lift',
      tick: function (pawn, job) {
        var captive = T.resolve(job.targetA, pawn.map);
        if (!captive || captive.dead) return 'fail';
        if (U.cheb(pawn.x, pawn.y, captive.x, captive.y) > 1) return 'fail';
        var J = sys('Jobs');
        if (captive.job && J && J.end) J.end(captive, 'interrupted');
        if (captive.stopPath) captive.stopPath(); else captive.path = null;
        pawn.carriedPawn = captive;
        captive.carriedBy = pawn.id;
        if (captive.prisoner) captive.prisoner.escaping = false;
        return 'next';
      }
    });
  }

  function haulToBedToil() {
    return Toils.custom({
      name: 'haulToCell',
      init: function (pawn, job, s) { s.ticks = 0; },
      tick: function (pawn, job, s) {
        var bed = T.resolve(job.targetB, pawn.map);
        var captive = pawn.carriedPawn;
        if (!captive || captive.dead) return 'fail';
        if (!bed || !bed.spawned) return 'fail';
        if (++s.ticks > CARRY_TIMEOUT) return 'fail';

        dragged(pawn);
        if (pawn.x === bed.x && pawn.y === bed.y) {
          s.delivered = true;
          if (Jobs.stopMoving) Jobs.stopMoving(pawn);
          return 'next';
        }
        var moving = pawn.path && pawn.pathIdx < pawn.path.length;
        if (!moving && !Jobs.walkTo(pawn, bed.x, bed.y, PE.ON_CELL)) return 'fail';
        return 'stay';
      },
      end: function (pawn, job, s) {
        if (s.delivered) return;
        var captive = pawn.carriedPawn;
        if (!captive) return;
        dragged(pawn);
        captive.carriedBy = null;
        pawn.carriedPawn = null;
      }
    });
  }

  /* Put them down in the bed. `convert` is what separates a capture from
     carrying an escapee back to the one they already had. */
  function layInCellToil(convert) {
    return Toils.custom({
      name: 'layInCell',
      tick: function (pawn, job) {
        var map = pawn.map;
        var captive = pawn.carriedPawn;
        var bed = T.resolve(job.targetB, map);
        if (!captive) return 'fail';
        dragged(pawn);
        captive.carriedBy = null;
        pawn.carriedPawn = null;

        if (convert && !captive.prisoner) {
          if (!Prisoners.capture(captive, pawn)) return 'fail';
        }
        if (bed) {
          captive.ownedBedId = bed.id;
          if (!bed.ownerId) bed.ownerId = captive.id;
        }
        var st = captive.prisoner;
        if (st) {
          st.lastWatchedTick = now();
          st.escaping = false;
          st.escapeWill = 0;
          st.cellCount = 0;
          watch(captive);
        }
        var J = sys('Jobs');
        if (bed && !captive.dead && J) {
          J.start(captive, J.make('layDown', T.thing(bed), null, { state: { asleep: false } }));
        }
        if (!convert) msg(nameOf(pawn) + ' returned ' + nameOf(captive) + ' to the cells.', pawn);
        return 'done';
      }
    });
  }

  /* ============================================================
     Job defs
     ============================================================ */

  Jobs.register('capture', {
    label: 'capture',
    reportString: 'Capturing {A}.',
    alwaysShow: true,
    toils: function () {
      return [
        Toils.reserve('A', 1),
        findCellToil(),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        liftToil(),
        haulToBedToil(),
        layInCellToil(true)
      ];
    }
  });

  Jobs.register('returnPrisoner', {
    label: 'return prisoner',
    reportString: 'Taking {A} back to the cells.',
    alwaysShow: true,
    toils: function () {
      return [
        Toils.reserve('A', 1),
        findCellToil(),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        liftToil(),
        haulToBedToil(),
        layInCellToil(false)
      ];
    }
  });

  Jobs.register('feedPrisoner', {
    label: 'feed prisoner',
    reportString: 'Feeding {A}.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.custom({
          name: 'findPrisonerFood',
          tick: function (pawn, job) {
            var map = pawn.map;
            var captive = T.resolve(job.targetA, map);
            if (!captive) return 'fail';
            var known = job.targetB ? T.resolve(job.targetB, map) : null;
            if (known && known.spawned && Res.reserve(pawn, job.targetB, 1)) return 'next';
            var food = Jobs.findFood ? Jobs.findFood(map, pawn, { forOther: true }) : null;
            if (!food) return 'fail';
            job.targetB = T.thing(food);
            Res.reserve(pawn, job.targetB, 1);
            return 'next';
          }
        }),
        Toils.goto('B', { pe: PE.TOUCH, failIfGone: true }),
        Toils.pickUp('B', function (pawn, job) {
          var food = T.resolve(job.targetB, pawn.map);
          if (!food) return 0;
          var N = sys('Needs');
          var per = (N && N.nutritionOf) ? N.nutritionOf(food.def) : (food.def.nutrition || 0);
          var captive = T.resolve(job.targetA, pawn.map);
          var missing = 1 - (captive && captive.needs ? captive.needs.food : 0.5);
          var units = per > 0 ? Math.max(1, Math.ceil(missing / per)) : 1;
          return Math.min(units, food.stack);
        }),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'handOverFood',
          amount: 180,
          failIfGone: true,
          onDone: function (pawn, job) {
            var captive = T.resolve(job.targetA, pawn.map);
            var N = sys('Needs');
            if (!captive || !pawn.carried || !N || !N.eat) return 'fail';
            N.eat(captive, pawn.carried);
            if (pawn.carried && pawn.carried.stack <= 0) pawn.carried = null;
            if (captive.prisoner) {
              captive.prisoner.lastFedTick = now();
              captive.prisoner.lastWatchedTick = now();
            }
            return 'done';
          }
        })
      ];
    }
  });

  Jobs.register('recruitPrisoner', {
    label: 'talk to prisoner',
    reportString: 'Trying to talk {A} round.',
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'chat',
          amount: CHAT_WORK,
          skill: 'social',
          failIfGone: true,
          onDone: function (pawn, job) {
            var captive = T.resolve(job.targetA, pawn.map);
            if (!captive || !captive.prisoner) return 'fail';
            Prisoners.chat(pawn, captive);
            return 'done';
          }
        })
      ];
    }
  });

  Jobs.register('releasePrisoner', {
    label: 'release prisoner',
    reportString: 'Releasing {A}.',
    alwaysShow: true,
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'unlock',
          amount: RELEASE_WORK,
          failIfGone: true,
          onDone: function (pawn, job) {
            var captive = T.resolve(job.targetA, pawn.map);
            if (!captive || !captive.prisoner) return 'fail';
            Prisoners.release(captive, pawn);
            return 'done';
          }
        })
      ];
    }
  });

  Jobs.register('executePrisoner', {
    label: 'execute prisoner',
    reportString: 'Executing {A}.',
    alwaysShow: true,
    toils: function () {
      return [
        Toils.reserve('A', 1),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.work({
          name: 'execute',
          amount: EXECUTE_WORK,
          failIfGone: true,
          onDone: function (pawn, job) {
            var captive = T.resolve(job.targetA, pawn.map);
            if (!captive || !captive.prisoner) return 'fail';
            Prisoners.execute(captive, pawn);
            return 'done';
          }
        })
      ];
    }
  });

  /* The prisoner's own two jobs. Both walk off the edge of the map; only
     the letter at the end of them differs. */
  function walkOffToil(escaped) {
    return Toils.custom({
      name: escaped ? 'slipAway' : 'goHome',
      tick: function (pawn, job) {
        var map = pawn.map;
        var pos = T.pos(job.targetA, map);
        if (!pos) return 'fail';
        if (pawn.x !== pos.x || pawn.y !== pos.y) return 'stay';

        var st = pawn.prisoner;
        var who = fullName(pawn);
        if (st) {
          pawn.prisoner = false;
          U.remove(roster, pawn);
          var F = sys('Factions');
          if (escaped && F && F.adjustGoodwill && st.factionId && st.factionId !== 'player') {
            /* They walk home with a story about your cells, which is worth
               a little less than nothing to you. */
            F.adjustGoodwill(st.factionId, -3, who + ' escaped your cells');
          }
          pawn.faction = st.factionId || 'neutral';
        }
        if (escaped) {
          letter('A prisoner got away',
            who + ' reached the edge of the map and kept walking. Whatever they knew about ' +
            'your colony, they know it somewhere else now.', 'threat', pawn);
        } else {
          msg(who + ' has left your land.', pawn);
        }
        if (map.removePawn) map.removePawn(pawn);
        else U.remove(map.pawns, pawn);
        pawn.map = null;
        return 'done';
      }
    });
  }

  Jobs.register('prisonerEscape', {
    label: 'escape',
    reportString: 'Making a run for the edge of the map.',
    suspendable: false,
    alwaysShow: true,
    toils: function () {
      return [Toils.goto('A', { pe: PE.ON_CELL }), walkOffToil(true)];
    }
  });

  Jobs.register('prisonerLeave', {
    label: 'leave',
    reportString: 'Leaving your land.',
    suspendable: false,
    alwaysShow: true,
    toils: function () {
      return [Toils.goto('A', { pe: PE.ON_CELL }), walkOffToil(false)];
    }
  });

  /* ============================================================
     Warden work

     Section 10.5 hands this column to prisoners.js rather than to
     workgivers.js, so these are the only WorkGivers.register calls
     outside that file. Each one claims its target before handing the job
     over, exactly as the givers there do.
     ============================================================ */

  var _registered = false;

  function claimed(pawn, defId, target) {
    if (!Res.reserve(pawn, target, 1)) return null;
    var job = Jobs.make(defId, target, null);
    if (!job) Res.release(pawn, target);
    return job;
  }

  function reachable(map, pawn, x, y) {
    if (!Path) return true;
    return Path.reachable(map, pawn.x, pawn.y, x, y, { pawn: pawn });
  }

  /* Candidate prisoners for a warden, cheapest filters first. */
  function prisonersFor(pawn, test) {
    var map = pawn.map, out = [], list = map.pawns;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p.prisoner || p.dead || p === pawn) continue;
      if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
      if (!test(p, p.prisoner)) continue;
      if (!reachable(map, pawn, p.x, p.y)) continue;
      out.push(p);
    }
    return out;
  }

  function nearest(pawn, list) {
    if (!list.length) return null;
    if (!Path || !Path.closestReachable) return list[0];
    return Path.closestReachable(pawn.map, pawn, list, null);
  }

  Prisoners.registerWork = function () {
    if (_registered || !WorkGivers || !WorkGivers.register) return false;
    _registered = true;

    /* A body on the floor is the most urgent thing a warden can see: the
       captive is bleeding, and a free prisoner bed is the only reason this
       is a capture rather than a corpse. */
    WorkGivers.register({
      id: 'wardenCapture', workType: 'warden', order: 5, label: 'capture downed enemies',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        Prisoners.sweep(map);
        if (!Prisoners.beds(map).length) return null;
        var cands = [], list = map.pawns;
        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          if (!Prisoners.canCapture(p)) continue;
          if (p.carriedBy) continue;
          if (!Res.canReserve(pawn, T.pawn(p), 1)) continue;
          if (!reachable(map, pawn, p.x, p.y)) continue;
          cands.push(p);
        }
        var target = nearest(pawn, cands);
        if (!target) return null;
        if (!freePrisonerBed(map, pawn, target)) return null;
        return claimed(pawn, 'capture', T.pawn(target));
      }
    });

    WorkGivers.register({
      id: 'wardenReturnEscapee', workType: 'warden', order: 10, label: 'return escaping prisoners',
      tryGiveJob: function (pawn) {
        var cands = prisonersFor(pawn, function (p, st) {
          return st.escaping && !p.carriedBy;
        });
        var target = nearest(pawn, cands);
        if (!target) return null;
        if (!freePrisonerBed(pawn.map, pawn, target)) return null;
        return claimed(pawn, 'returnPrisoner', T.pawn(target));
      }
    });

    WorkGivers.register({
      id: 'wardenFeed', workType: 'warden', order: 20, label: 'feed prisoners',
      tryGiveJob: function (pawn) {
        var N = sys('Needs');
        var cands = prisonersFor(pawn, function (p) {
          if (!p.needs) return false;
          return p.needs.food < FEED_AT;
        });
        var target = nearest(pawn, cands);
        if (!target) return null;
        if (!Jobs.findFood || !Jobs.findFood(pawn.map, pawn, { forOther: true })) return null;
        if (N && N.nutritionOf) { /* Needs decides what counts as food; findFood asked it. */ }
        return claimed(pawn, 'feedPrisoner', T.pawn(target));
      }
    });

    WorkGivers.register({
      id: 'wardenExecute', workType: 'warden', order: 30, label: 'execute prisoners',
      tryGiveJob: function (pawn) {
        if (hasTrait(pawn, 'kind')) return null;
        var cands = prisonersFor(pawn, function (p, st) {
          return st.mode === 'execute' && !p.carriedBy;
        });
        var target = nearest(pawn, cands);
        return target ? claimed(pawn, 'executePrisoner', T.pawn(target)) : null;
      }
    });

    WorkGivers.register({
      id: 'wardenRelease', workType: 'warden', order: 40, label: 'release prisoners',
      tryGiveJob: function (pawn) {
        var cands = prisonersFor(pawn, function (p, st) {
          return st.mode === 'release' && !p.carriedBy;
        });
        var target = nearest(pawn, cands);
        return target ? claimed(pawn, 'releasePrisoner', T.pawn(target)) : null;
      }
    });

    /* Chatting is the lowest-priority warden job on purpose: a hungry
       prisoner wants dinner before they want a conversation. */
    WorkGivers.register({
      id: 'wardenRecruit', workType: 'warden', order: 50, label: 'talk prisoners round',
      tryGiveJob: function (pawn) {
        if (pawn.workPriority && pawn.workPriority.warden === 0) return null;
        var t = now();
        var cands = prisonersFor(pawn, function (p, st) {
          if (st.mode !== 'recruit' || p.carriedBy || p.downed) return false;
          if (t - st.lastChatTick < CHAT_COOLDOWN) return false;
          return !(p.needs && p.needs.food < 0.2);
        });
        var target = nearest(pawn, cands);
        return target ? claimed(pawn, 'recruitPrisoner', T.pawn(target)) : null;
      }
    });
    return true;
  };

  Prisoners.registerWork();

  root.Prisoners = Prisoners;
})(this);
