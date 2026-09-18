/* ============================================================
   game.js - the world container and the tick.

   Everything else is a system; this is the thing that owns the
   clock and decides what runs in which order. Tick order is not
   arbitrary: derived state (regions, power) is rebuilt before
   anything reads it, pawns act on a world that is already
   consistent, and the storyteller gets the last word.
   ============================================================ */
(function (root) {
  'use strict';

  var TICKS_PER_DAY = 60000;
  var TICKS_PER_HOUR = TICKS_PER_DAY / 24;
  var DAYS_PER_SEASON = 15;
  var SEASONS = ['spring', 'summer', 'fall', 'winter'];

  var Game = {
    TICKS_PER_DAY: TICKS_PER_DAY,
    TICKS_PER_HOUR: TICKS_PER_HOUR,
    DAYS_PER_SEASON: DAYS_PER_SEASON,

    map: null,
    tick: 0,
    speed: 1,
    speeds: [0, 1, 2, 3, 6],
    playerFaction: 'player',
    started: false,
    gameOver: null,          /* {won, reason} once it is over */
    debug: false,

    messages: [],
    letters: [],
    selection: [],

    difficulty: { name: 'Rough', threatScale: 1.0 },
    biome: 'temperateForest',
    seed: 1,
    wealth: 0,

    /* Set by incidents: a temporary shift on top of the seasonal curve. */
    weather: { tempOffset: 0, tempOffsetTicksLeft: 0, eclipseTicksLeft: 0, flareTicksLeft: 0, wind: 0.6 },

    _plantCursor: 0,
    _pawnScratch: []
  };

  /* ---------- starting a colony ---------- */

  Game.newGame = function (opts) {
    opts = opts || {};
    var seed = opts.seed === undefined ? U.randInt(1, 2000000000) : opts.seed;
    U.seed(seed);
    U.setIdCounter(1);

    Game.seed = seed;
    /* Start the clock at eight in the morning. Landing at 00:18 in the
       pitch dark, which is where tick 0 falls, gives a new player a black
       screen and colonists who go straight to bed. */
    Game.tick = Math.round(8 * TICKS_PER_HOUR);
    Game.speed = 1;
    Game.gameOver = null;
    Game.messages = [];
    Game.letters = [];
    Game.selection = [];
    Game.biome = opts.biome || 'temperateForest';
    Game.difficulty = opts.difficulty || { name: 'Rough', threatScale: 1.0 };
    Game.weather = { tempOffset: 0, tempOffsetTicksLeft: 0, eclipseTicksLeft: 0, flareTicksLeft: 0, wind: 0.6 };

    if (typeof Research !== 'undefined') Research.reset();
    Game.resolveSystems();

    /* The planet comes first: the colony map is one tile of it, and which
       tile you landed on decides the biome you have to survive. */
    if (typeof World !== 'undefined') {
      World.generate({ seed: seed, w: opts.worldW || 60, h: opts.worldH || 30 });
      if (typeof Factions !== 'undefined') Factions.generate(World);
      if (!opts.biome && World.colonyBiome) Game.biome = World.colonyBiome();
    }

    var size = opts.size || 140;
    Game.map = MapGen.generate({
      w: size, h: size, seed: seed, biome: Game.biome,
      mountainous: opts.mountainous === undefined ? true : opts.mountainous
    });

    if (typeof Regions !== 'undefined') Regions.rebuildAll(Game.map);
    if (typeof Power !== 'undefined') { Power.markDirty(Game.map); Power.update(Game.map); }

    MapGen.spawnStartingColony(Game.map, opts.colonists || 3, opts);

    if (typeof Storyteller !== 'undefined' && Storyteller.reset) Storyteller.reset();
    Game.recalcWealth();
    Game.started = true;

    Game.letter('Crash landing',
      'Your escape pods came down hard on an unclaimed rimworld. Three of you walked away from ' +
      'the wreck. Build something before winter, or before something finds you.',
      { kind: 'neutral' });
    return Game;
  };

  /* ---------- the systems registry ----------
     Systems are optional: the game runs with any subset of them present,
     which is how it stayed playable while twenty files were being written
     at once. Resolve them once rather than asking typeof on every tick. */

  var MAP_TICKERS = [
    ['Fire', 'tick'],                 /* flames spread before anything reads the map */
    ['Social', 'tick'],               /* who talked to whom */
    ['Husbandry', 'tick'],            /* training decay, breeding, produce */
    ['Ideology', 'tickRituals']
  ];
  var PAWN_TICKERS = [
    ['Abilities', 'tickPawn'],
    ['Royalty', 'tickPawn'],
    ['Biotech', 'tickPawn'],
    ['Social', 'tickPawn'],
    ['Husbandry', 'tickPawn']
  ];
  var SLOW_TICKERS = [                /* every 500 ticks - things measured in hours */
    ['Caravans', 'tick'],
    ['Trade', 'tick'],
    ['Policies', 'tick'],
    ['Research', 'tickSlow']
  ];

  var mapTick = [], pawnTick = [], slowTick = [], systemsResolved = false;

  function resolve(list, out) {
    out.length = 0;
    for (var i = 0; i < list.length; i++) {
      var g = root[list[i][0]];
      var fn = g && g[list[i][1]];
      if (typeof fn === 'function') out.push([g, fn]);
    }
  }

  Game.resolveSystems = function () {
    resolve(MAP_TICKERS, mapTick);
    resolve(PAWN_TICKERS, pawnTick);
    resolve(SLOW_TICKERS, slowTick);
    systemsResolved = true;
    return { map: mapTick.length, pawn: pawnTick.length, slow: slowTick.length };
  };

  Game.systemPresent = function (name) { return !!root[name]; };

  /* ---------- the tick ---------- */

  Game.doTick = function () {
    var map = Game.map;
    if (!map || Game.gameOver) return;
    Game.tick++;

    /* Derived state first, so nothing this tick reads a stale room or a
       power net that a wall built last tick already invalidated. */
    if (typeof Regions !== 'undefined') Regions.update(map);
    if (typeof Power !== 'undefined') { Power.update(map); Power.tick(map); }

    map.tick();

    if (!systemsResolved) Game.resolveSystems();

    /* fire.js supersedes the fire loop plants.js shipped with; fall back to
       the old one when it is not loaded. */
    if (typeof Fire === 'undefined' && typeof Plants !== 'undefined' && Plants.tickFires) {
      Plants.tickFires(map);
    }
    if (typeof Plants !== 'undefined') Game.tickPlantSlice(map);

    for (var mt = 0; mt < mapTick.length; mt++) mapTick[mt][1].call(mapTick[mt][0], map, Game);

    /* Pawns act on a copy of the list: a pawn can die, spawn a corpse and
       leave the array mid-loop, and raiders can arrive from an incident. */
    var pawns = Game._pawnScratch;
    pawns.length = 0;
    for (var i = 0; i < map.pawns.length; i++) pawns.push(map.pawns[i]);
    var hasPrisoners = typeof Prisoners !== 'undefined';
    for (var p = 0; p < pawns.length; p++) {
      var pawn = pawns[p];
      if (pawn.dead) continue;
      pawn.tick();
      if (hasPrisoners && pawn.prisoner) Prisoners.tick(pawn);
      for (var pt = 0; pt < pawnTick.length; pt++) pawnTick[pt][1].call(pawnTick[pt][0], pawn);
    }

    if (typeof Combat !== 'undefined') Combat.tick(map);
    if (typeof Storyteller !== 'undefined') Storyteller.tick(Game);

    /* The world outside the map moves on a slower clock: caravans cross
       tiles in days, traders come and go, civilizations change their minds. */
    if (Game.tick % 500 === 0) {
      for (var st = 0; st < slowTick.length; st++) slowTick[st][1].call(slowTick[st][0], Game);
    }
    if (Game.tick % 2500 === 0 && typeof Factions !== 'undefined' && Factions.tickDiplomacy) {
      Factions.tickDiplomacy(Game);
    }

    Game.tickWeather();

    /* Rare housekeeping. Room temperature is the expensive one, so it runs
       on its own beat rather than with the pawns. */
    if (Game.tick % 250 === 0 && typeof Regions !== 'undefined') {
      Regions.tickTemperature(map, Game.outdoorTemp());
    }
    if (Game.tick % 2000 === 0) {
      Game.recalcWealth();
      Game.checkGameOver();
    }
  };

  /* Plants are numerous and slow-moving, so each one gets looked at about
     every 250 ticks rather than every tick. */
  Game._plantList = [];
  Game._plantListTick = -1;

  Game.plantList = function (map) {
    if (Game._plantListTick === Game.tick) return Game._plantList;
    Game._plantListTick = Game.tick;
    var out = Game._plantList;
    out.length = 0;
    var defs = Defs.plants();
    for (var i = 0; i < defs.length; i++) {
      var list = map.byDef(defs[i].id);
      for (var j = 0; j < list.length; j++) out.push(list[j]);
    }
    return out;
  };

  Game.tickPlantSlice = function (map) {
    /* Rebuilding the list costs a few array walks, so do it on the same
       beat the slice wraps rather than every tick. */
    if (Game._plantCursor === 0 || !Game._plantList.length) Game.plantList(map);
    var plants = Game._plantList;
    var n = plants.length;
    if (!n) return;
    var slice = Math.max(1, Math.ceil(n / 250));
    for (var k = 0; k < slice; k++) {
      if (Game._plantCursor >= plants.length) Game._plantCursor = 0;
      var plant = plants[Game._plantCursor++];
      if (plant && plant.spawned) Plants.tickRare(map, plant);
    }
  };

  Game.tickWeather = function () {
    var w = Game.weather;
    if (w.tempOffsetTicksLeft > 0 && --w.tempOffsetTicksLeft === 0) w.tempOffset = 0;
    if (w.eclipseTicksLeft > 0) w.eclipseTicksLeft--;
    if (w.flareTicksLeft > 0) w.flareTicksLeft--;
    /* Wind drifts slowly; wind turbines read it. */
    if (Game.tick % 600 === 0) {
      w.wind = U.clamp(w.wind + U.randRange(-0.25, 0.25), 0.05, 1);
    }
  };

  /* ---------- time ---------- */

  Game.day = function () { return Math.floor(Game.tick / TICKS_PER_DAY); };
  Game.dayOfYear = function () { return Game.day() % (DAYS_PER_SEASON * 4); };
  Game.hour = function () { return (Game.tick % TICKS_PER_DAY) / TICKS_PER_HOUR; };
  Game.timeOfDay = function () { return (Game.tick % TICKS_PER_DAY) / TICKS_PER_DAY; };
  Game.season = function () {
    return SEASONS[Math.floor(Game.dayOfYear() / DAYS_PER_SEASON) % 4];
  };
  Game.seasonProgress = function () {
    return (Game.dayOfYear() % DAYS_PER_SEASON) / DAYS_PER_SEASON;
  };
  Game.timeString = function () {
    var h = Math.floor(Game.hour());
    var m = Math.floor((Game.hour() - h) * 60);
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  };

  /* Daylight: dark until 05:00, full by 08:00, dark again after 20:00.
     An eclipse flattens it to nothing, which is what makes solar panels
     and the plants that depend on light suddenly matter. */
  Game.daylight = function () {
    if (Game.weather.eclipseTicksLeft > 0) return 0;
    var h = Game.hour();
    if (h < 5 || h > 20) return 0;
    if (h < 8) return (h - 5) / 3;
    if (h > 17) return 1 - (h - 17) / 3;
    return 1;
  };

  /* Seasonal temperature with a daily swing, plus whatever a heat wave or
     cold snap is currently doing. */
  Game.outdoorTemp = function () {
    /* Day 0 is the start of spring at a workable 12C, summer peaks near 28
       and winter bottoms out around -4. The phase matters: shifted the
       other way, a fresh colony lands in the coldest hour of the year with
       no clothes and no roof, freezes, and breaks down on the first day. */
    var yearT = Game.dayOfYear() / (DAYS_PER_SEASON * 4);
    var seasonal = 12 + 16 * Math.sin(yearT * 6.283185307179586);
    var daily = 6 * Math.sin((Game.timeOfDay() - 0.30) * 6.283185307179586);
    var biomeOffset = Game.biome === 'aridShrubland' ? 8 : (Game.biome === 'borealForest' ? -12 : 0);
    return seasonal + daily + biomeOffset + Game.weather.tempOffset;
  };

  /* ---------- speed ---------- */

  Game.setSpeed = function (i) {
    Game.speed = U.clamp(i | 0, 0, Game.speeds.length - 1);
    return Game.speed;
  };
  Game.ticksThisFrame = function (dtSeconds) {
    var mult = Game.speeds[Game.speed];
    if (!mult) return 0;
    /* Cap the catch-up so a slow frame cannot spiral into a freeze. */
    return Math.min(Math.round(dtSeconds * 60 * mult), 20 * mult);
  };
  Game.togglePause = function () {
    Game.speed = Game.speed === 0 ? 1 : 0;
  };

  /* ---------- colony ---------- */

  Game.colonists = function () {
    return Game.map ? Game.map.colonists() : [];
  };

  Game.recalcWealth = function () {
    Game.wealth = Game.map ? Game.map.wealth() : 0;
    return Game.wealth;
  };

  Game.checkGameOver = function () {
    if (Game.gameOver || !Game.map) return;
    var alive = Game.colonists().filter(function (p) { return !p.dead; });
    if (!alive.length) {
      Game.gameOver = { won: false, reason: 'Every colonist is dead.' };
      Game.letter('The colony is gone',
        'There is no one left to give orders to. The rimworld keeps turning without you.',
        { kind: 'death' });
    }
  };

  /* ---------- selection ---------- */

  Game.select = function (x, additive) {
    if (!additive) Game.selection.length = 0;
    if (x && Game.selection.indexOf(x) < 0) Game.selection.push(x);
    return Game.selection;
  };
  Game.deselectAll = function () { Game.selection.length = 0; };
  Game.selectedPawns = function () {
    return Game.selection.filter(function (s) { return s && s.isHuman !== undefined && s.needs; });
  };

  /* ---------- messages and letters ----------
     A message is a line that scrolls away; a letter is something you are
     expected to look at, and it waits on the side of the screen. */

  Game.msg = function (text, opts) {
    opts = opts || {};
    Game.messages.push({
      text: text, tick: Game.tick, type: opts.type || 'info',
      x: opts.x === undefined ? null : opts.x,
      y: opts.y === undefined ? null : opts.y
    });
    if (Game.messages.length > 120) Game.messages.splice(0, Game.messages.length - 120);
    if (Game.debug) console.log('[msg] ' + text);
  };

  Game.letter = function (title, text, opts) {
    opts = opts || {};
    var letter = {
      id: U.nextId(), title: title, text: text, tick: Game.tick,
      kind: opts.kind || 'neutral',
      x: opts.x === undefined ? null : opts.x,
      y: opts.y === undefined ? null : opts.y,
      dismissed: false
    };
    Game.letters.push(letter);
    if (Game.letters.length > 40) Game.letters.splice(0, Game.letters.length - 40);
    Game.msg(title, { type: opts.kind === 'threat' ? 'threat' : 'info', x: letter.x, y: letter.y });
    if (opts.pause !== false && opts.kind === 'threat' && Game.speed > 1) Game.setSpeed(1);
    return letter;
  };

  Game.dismissLetter = function (letter) {
    letter.dismissed = true;
    U.remove(Game.letters, letter);
  };

  /* ---------- state for save.js ---------- */

  /* Who is hostile to whom. Factions owns the answer once civilizations
     exist; before that, the four built-in faction ids decide it. */
  Game.hostile = function (a, b) {
    if (!a || !b || a === b) return false;
    if (typeof Factions !== 'undefined' && Factions.hostileTo) {
      var known = Factions.get && (Factions.get(a) || Factions.get(b));
      if (known) return Factions.hostileTo(a, b);
    }
    if (a === 'wild' || b === 'wild') return false;
    if (a === 'neutral' || b === 'neutral') return false;
    return (a === 'player' && b === 'raider') || (a === 'raider' && b === 'player');
  };

  Game.timeState = function () {
    return {
      tick: Game.tick, seed: Game.seed, biome: Game.biome,
      difficulty: Game.difficulty, weather: Game.weather, wealth: Game.wealth,
      speed: Game.speed, gameOver: Game.gameOver
    };
  };
  Game.restoreTimeState = function (s) {
    Game.tick = s.tick || 0;
    Game.seed = s.seed || 1;
    Game.biome = s.biome || 'temperateForest';
    Game.difficulty = s.difficulty || { name: 'Rough', threatScale: 1 };
    Game.weather = s.weather || { tempOffset: 0, tempOffsetTicksLeft: 0, eclipseTicksLeft: 0, flareTicksLeft: 0, wind: 0.6 };
    Game.wealth = s.wealth || 0;
    Game.speed = s.speed === undefined ? 1 : s.speed;
    Game.gameOver = s.gameOver || null;
    Game.started = true;
  };

  root.Game = Game;
})(this);
