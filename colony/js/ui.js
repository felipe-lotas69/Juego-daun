/* ============================================================
   ui.js - every panel, menu, tab, alert and letter, and the only
   place in the project that touches localStorage.

   The layout is the one section 12 of the contract froze:

     resources (top left) | colonist boxes (top centre) | alerts (right)
                                                        | letters (right)
     messages (bottom left)                             | date, time,
     architect: a two-column category block, then the   | speed (btm rt)
     command grid beside it                             |
     [ Architect | Work | Schedule | Assign | Animals | Research | World | Menu ]

   index.html's container ids are frozen, so the bottom tab bar lives
   in #topbar, the resource readout shares #colonist-bar with the
   colonist boxes, and the clock sits at the foot of #letters. Nothing
   here creates a panel of its own; CSS puts each container where the
   diagram says it goes.

   Two rules shape this file.

   First, UI.update() runs on every animation frame. Rebuilding a
   panel's markup sixty times a second costs more than the whole
   simulation does, so every panel keeps a signature of what it
   last drew and rebuilds only when that signature changes. The
   signature is built from exactly the values the panel prints,
   which is why the data for a panel is gathered into a plain
   object first and rendered second.

   Second, the UI never writes simulation state by hand; it calls
   the module APIs. Several of those modules load after this one
   is written, so every call through a global is guarded and
   degrades to a readable dash instead of throwing inside a frame.
   ============================================================ */
(function (root) {
  'use strict';

  var doc = root.document;
  var UI = {};

  var SAVE_KEY = 'rimdaun.save.v1';
  var MESSAGE_MS = 15000;        /* how long a log line stays up, real time */
  var ALERT_FRAMES = 90;         /* alerts are a scan of the map: keep it rare */
  var RESOURCE_FRAMES = 30;      /* so is counting every stack in the colony */
  var INSPECT_FRAMES = 8;
  var BOX_FRAMES = 6;
  var TAB_FRAMES = 20;

  var WORK_COLORS = ['', 'p1', 'p2', 'p3', 'p4'];
  var SCHEDULE_KINDS = ['anything', 'work', 'recreation', 'sleep'];

  /* The architect's categories. They are laid out two to a row, which
     with this order gives Orders / Zones, Structure / Production,
     Furniture / Power, Security / Floors and Misc on its own - the
     grouping the reference shows. Reordering this list re-pairs them,
     so the pairs are the order, not an accident of it. */
  var ARCH_CATEGORIES = [
    { id: 'orders', label: 'Orders', icon: 'cat-orders' },
    { id: 'zones', label: 'Zones', icon: 'cat-zone' },
    { id: 'structure', label: 'Structure', icon: 'cat-structure' },
    { id: 'production', label: 'Production', icon: 'cat-production' },
    { id: 'furniture', label: 'Furniture', icon: 'cat-furniture' },
    { id: 'power', label: 'Power', icon: 'cat-power' },
    { id: 'security', label: 'Security', icon: 'cat-security' },
    { id: 'floor', label: 'Floors', icon: 'cat-floor' },
    { id: 'misc', label: 'Misc', icon: 'cat-misc' }
  ];

  /* The bottom bar: the game's primary navigation. */
  var BOTTOM_TABS = [
    ['architect', 'Architect'], ['work', 'Work'], ['schedule', 'Schedule'],
    ['assign', 'Assign'], ['animals', 'Animals'], ['research', 'Research'],
    ['world', 'World'], ['menu', 'Menu']
  ];

  var DESIGNATIONS = [
    ['mine', 'Mine', 'Mark rock and ore for a miner to dig out.'],
    ['chop', 'Chop wood', 'Mark trees to be felled for wood.'],
    ['harvest', 'Harvest', 'Mark ripe crops to be gathered.'],
    ['cut', 'Cut plants', 'Clear grass and bushes out of the way.'],
    ['deconstruct', 'Deconstruct', 'Take a building apart and recover some of it.'],
    ['haulUrgent', 'Haul urgently', 'Push these items to the top of the hauling list.'],
    ['hunt', 'Hunt', 'Send a hunter after an animal.'],
    ['tame', 'Tame', 'Send an animal handler to befriend an animal.'],
    ['slaughter', 'Slaughter', 'Butcher one of your own tame animals.']
  ];
  var OVERLAYS = ['none', 'zones', 'power', 'rooms', 'beauty', 'temperature'];

  /* The resource readout, in the order it reads down the top left. A
     group is one line: nobody wants rice, corn, potatoes, berries and
     meat as five separate counters when what they need to know is
     whether there is food. Anything storable that no group claims is
     appended after these, so a new def still shows up. */
  var RESOURCE_GROUPS = [
    { key: 'silver', label: 'Silver', ids: ['silver'] },
    { key: 'wood', label: 'Wood', ids: ['wood'] },
    { key: 'steel', label: 'Steel', ids: ['steel'] },
    { key: 'blocks', label: 'Stone blocks', ids: ['stoneBlocks'] },
    { key: 'chunks', label: 'Stone chunks', ids: ['stoneChunk'] },
    { key: 'components', label: 'Components', ids: ['components'] },
    { key: 'chemfuel', label: 'Chemfuel', ids: ['chemfuel'] },
    { key: 'cloth', label: 'Cloth', ids: ['cloth'] },
    { key: 'leather', label: 'Leather', ids: ['leather'] },
    { key: 'wool', label: 'Wool', ids: ['wool'] },
    { key: 'medicine', label: 'Medicine', ids: ['herbalMedicine', 'medicine'] },
    { key: 'meals', label: 'Meals', ids: ['mealSimple', 'mealFine', 'mealEgg'] },
    { key: 'rawFood', label: 'Raw food',
      ids: ['riceRaw', 'potatoRaw', 'cornRaw', 'berries', 'meatRaw', 'milk', 'eggs', 'cheese'] },
    { key: 'feed', label: 'Animal feed', ids: ['kibble', 'hay'] }
  ];

  /* Panel elements, filled in by init. */
  var P = {};

  /* Per-panel caches. Each holds the signature of the last render. */
  var sig = {
    clock: '', bar: '', boxRoster: '', res: '', resRoster: '', inspect: '',
    arch: '', alerts: '', letters: '', tab: ''
  };

  var frame = 0;
  /* True while a tab sheet or the world screen is up. A sheet is sized
     to what is in it, so it lands somewhere between covering the whole
     screen and covering a corner, and whatever it fails to cover shows
     through beside it as a stripe of a second panel: the inspect pane
     to its right, the architect above a short one, the newest line of
     the message log cut through the middle. The three of them stand
     down together while a sheet is up. */
  var sheetUp = false;
  var inspectTab = 'needs';
  var archCategory = 'orders';
  var archOpen = true;
  var archSearch = '';
  var openTabName = null;
  var billsBuilding = null;
  var boxMap = new Map();
  var liveMessages = [];
  var messageScratch = [];
  var seenMessages = new WeakSet();
  var alertCache = [];
  var resourceCache = [];
  var lastAutosaveDay = -1;
  var floatCloser = null;
  var paintingSchedule = null;
  var lastSelected = null;
  var speedBeforeMenu = 1;

  /* ------------------------------------------------------------------
     DOM helpers
     ------------------------------------------------------------------ */

  function el(tag, cls, text) {
    var e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function btn(label, cls, fn) {
    var b = el('button', 'btn' + (cls ? ' ' + cls : ''), label);
    b.type = 'button';
    if (fn) b.addEventListener('click', fn);
    return b;
  }

  function tip(node, text) {
    if (text) node.setAttribute('data-tip', text);
    return node;
  }

  /* Art hands back one cached canvas per key, and a DOM node can only be
     in one place at a time, so every use gets its own copy. Sprites are
     authored far larger than the size they are shown at here, so the
     copy is drawn smoothly rather than with nearest-neighbour: a 32px
     icon crushed to 14 by point sampling is the hard, speckled look the
     player asked us to stop doing. */
  function drawInto(c, src, px) {
    var w = src ? src.width : 16, h = src ? src.height : 16;
    var big = Math.max(w, h) || 16;
    c.width = w;
    c.height = h;
    if (px) {
      c.style.width = Math.round(px * w / big) + 'px';
      c.style.height = Math.round(px * h / big) + 'px';
    }
    if (!src) return c;
    var g = c.getContext('2d');
    if (!g) return c;
    g.clearRect(0, 0, w, h);
    g.imageSmoothingEnabled = true;
    if ('imageSmoothingQuality' in g) g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0);
    return c;
  }

  function iconEl(key, px) {
    var c = el('canvas', 'ico');
    return drawInto(c, root.Art && Art.icon ? Art.icon(key) : null, px || 16);
  }

  function spriteEl(defId, stuffId, px) {
    var c = el('canvas', 'ico');
    var src = null;
    if (root.Art && Art.ghost) {
      try { src = Art.ghost(defId, 0, stuffId || null); } catch (e) { src = null; }
    }
    return drawInto(c, src, px || 20);
  }

  /* A colonist's own sprite, scaled down into a portrait box. It is the
     same body the map draws, which is the point: the face in the box and
     the person on the ground have to be recognisably one colonist. */
  function portraitEl(pawn, px) {
    var c = el('canvas', 'ico pbox-face');
    paintPortrait(c, pawn, px);
    return c;
  }

  function paintPortrait(c, pawn, px) {
    var src = null;
    if (root.Art && Art.pawn) {
      try { src = Art.pawn(pawn, 0, 0); } catch (e) { src = null; }
    }
    return drawInto(c, src, px || 34);
  }

  /* The fill is handed back on the wrapper as well as inside it, so a
     bar that is written to between rebuilds - the research one - can
     reach it without a selector that would break if this changed. */
  function barEl(cls, value, label) {
    var wrap = el('div', 'nbar' + (cls ? ' ' + cls : ''));
    if (label !== undefined) wrap.appendChild(el('span', 'nbar-label', label));
    var track = el('div', 'nbar-track');
    var fill = el('i', 'nbar-fill');
    fill.style.width = Math.round(U.clamp01(value) * 100) + '%';
    track.appendChild(fill);
    wrap.appendChild(track);
    wrap.fillEl = fill;
    return wrap;
  }

  /* ------------------------------------------------------------------
     Reading the simulation safely
     ------------------------------------------------------------------ */

  function isPawn(x) { return !!x && x.needs !== undefined && x.health !== undefined; }
  function isThing(x) { return !!x && x.defId !== undefined && x.def !== undefined; }
  function isZone(x) { return !!x && x.cells instanceof Set && x.kind !== undefined; }

  function nameOf(p) {
    if (!p || !p.name) return 'someone';
    return p.name.nick || p.name.first || 'someone';
  }
  function fullName(p) {
    if (!p || !p.name) return 'someone';
    var first = p.name.first || '', nick = p.name.nick || '', last = p.name.last || '';
    if (nick && first && nick !== first) return first + ' "' + nick + '" ' + last;
    return ((nick || first) + ' ' + last).trim() || 'someone';
  }

  function pawnById(id) {
    var list = Game.map ? Game.map.pawns : null;
    if (!list || !id) return null;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function colonists() { return Game.colonists ? Game.colonists() : []; }

  function tameAnimals() {
    var m = Game.map, out = [];
    if (!m || !m.pawns) return out;
    for (var i = 0; i < m.pawns.length; i++) {
      var p = m.pawns[i];
      if (!p.isAnimal || !p.tame || p.dead) continue;
      if (p.faction && p.faction !== 'player') continue;
      out.push(p);
    }
    return out;
  }

  function moodOf(p) {
    if (root.Needs && Needs.mood) return U.clamp01(Needs.mood(p));
    return typeof p.mood === 'number' ? U.clamp01(p.mood) : 0.5;
  }
  function moodLevel(p) {
    return U.clamp(Math.floor(moodOf(p) * 5), 0, 4);
  }
  function healthFraction(p) {
    if (!p.health || !p.health.parts || !p.health.parts.length) return 1;
    var hp = 0, max = 0;
    for (var i = 0; i < p.health.parts.length; i++) {
      var part = p.health.parts[i];
      max += part.maxHp;
      hp += part.missing ? 0 : part.hp;
    }
    return max > 0 ? U.clamp01(hp / max) : 1;
  }
  function healthText(p) {
    return root.Health && Health.summary ? Health.summary(p) : 'unknown';
  }
  function jobReport(p) {
    if (p.dead) return 'Dead';
    if (p.mentalState) {
      var d = p.mentalState.def;
      return U.cap((d && d.label) || p.mentalState.id || 'having a breakdown');
    }
    if (root.Jobs && Jobs.report) {
      var r = Jobs.report(p);
      if (r) return r;
    }
    return p.drafted ? 'Standing by' : 'Idle';
  }

  /* One word for the state that has to be obvious from across the room. */
  function pawnState(p) {
    if (p.dead) return 'dead';
    if (p.downed || (p.health && p.health.downed)) return 'downed';
    if (p.mentalState) return 'breaking';
    if (p.drafted) return 'drafted';
    return '';
  }
  var STATE_LABEL = {
    dead: 'Dead', downed: 'Down', breaking: 'Breaking', drafted: 'Drafted'
  };

  function backstoryLine(p) {
    if (p.isAnimal) {
      var k = p.kind;
      return (k && k.label ? U.cap(k.label) : 'Animal') + (p.tame ? ', tame' : ', wild');
    }
    var bs = p.backstories || {};
    var parts = [];
    ['childhood', 'adulthood'].forEach(function (slot) {
      var id = bs[slot];
      if (!id) return;
      var d = Defs.maybe('backstory', typeof id === 'string' ? id : id.id);
      if (d) parts.push(d.label || d.id);
    });
    if (!parts.length) return (p.gender || '') + (p.ageYears ? ', ' + Math.floor(p.ageYears) : '');
    return parts.join(' / ') + (p.ageYears ? ', age ' + Math.floor(p.ageYears) : '');
  }
  function traitDefs(p) {
    var out = [];
    (p.traits || []).forEach(function (t) {
      var d = Defs.maybe('trait', (t && t.id) || t);
      if (d) out.push(d);
    });
    return out;
  }
  function disabledWork(p) {
    var out = {};
    var bs = p.backstories || {};
    ['childhood', 'adulthood'].forEach(function (slot) {
      var id = bs[slot];
      var d = id ? Defs.maybe('backstory', typeof id === 'string' ? id : id.id) : null;
      if (d && d.disabledWork) d.disabledWork.forEach(function (w) { out[w] = true; });
    });
    traitDefs(p).forEach(function (d) {
      if (d.disabledWork) d.disabledWork.forEach(function (w) { out[w] = true; });
    });
    return out;
  }
  function workTypes() { return Defs.all('workType') || []; }
  function skillDefs() { return Defs.all('skill') || []; }

  function defLabel(category, id) {
    var d = id ? Defs.maybe(category, id) : null;
    return (d && d.label) || id || '';
  }

  function researchProgress() {
    var R = root.Research;
    var cur = R && R.current ? R.current() : null;
    return (cur && R.progressOf) ? (R.progressOf(cur.id) || 0) : 0;
  }
  function researchDone(id) {
    var R = root.Research;
    return !id || (R && R.isDone ? !!R.isDone(id) : true);
  }
  /* researchPrerequisite may be a string or a list of them, so the gate
     is asked of Research rather than compared here. */
  function researchUnlocked(def) {
    var R = root.Research;
    return (R && R.isUnlocked) ? !!R.isUnlocked(def) : true;
  }
  function researchNeededFor(def) {
    var R = root.Research;
    var r = (R && R.requiredFor) ? R.requiredFor(def.id) : null;
    return (r && (r.label || r.id)) || null;
  }

  /* Jobs.make always hands back a Job; Jobs.start is the one that can
     refuse it, so its answer is what the caller has to be told. */
  function forceJob(pawn, defId, targetA, targetB) {
    if (!pawn || !root.Jobs || !root.T) return false;
    var job = Jobs.make(defId, targetA || null, targetB || null, { playerForced: true });
    if (!job) return false;
    return !!Jobs.start(pawn, job);
  }

  function lookAt(x, y) {
    if (typeof x !== 'number') return;
    if (root.Render) { Render.centerOn(x, y); Render.flashCell(x, y); }
  }

  /* ------------------------------------------------------------------
     Shared tool state
     ------------------------------------------------------------------ */

  UI.tool = {
    kind: 'select', defId: null, rot: 0, stuffId: null,
    designation: null, zoneKind: null, zone: null
  };
  UI.overlay = 'none';

  UI.setTool = function (t) {
    t = t || {};
    UI.tool = {
      kind: t.kind || 'select',
      defId: t.defId || null,
      rot: t.rot | 0,
      stuffId: t.stuffId || null,
      designation: t.designation || null,
      zoneKind: t.zoneKind || null,
      zone: t.zone || null
    };
    sig.arch = '';
    return UI.tool;
  };

  UI.clearTool = function () {
    return UI.setTool({ kind: 'select' });
  };

  UI.rotateTool = function (delta) {
    if (UI.tool.kind !== 'build') return;
    UI.tool.rot = ((UI.tool.rot + (delta < 0 ? 3 : 1)) & 3);
    sig.arch = '';
  };

  /* input.js rotates the build ghost by writing UI.tool.rot in place,
     which no setter sees, so it says so afterwards and the architect
     redraws instead of showing the row it drew before the turn. */
  UI.onToolChanged = function () {
    sig.arch = '';
    return UI.tool;
  };

  UI.setOverlay = function (name) {
    UI.overlay = OVERLAYS.indexOf(name) >= 0 ? name : 'none';
    sig.clock = '';
  };

  /* ------------------------------------------------------------------
     The bottom tab bar - the primary navigation
     ------------------------------------------------------------------ */

  var tabButtons = {};

  function worldOpen() {
    return !!(root.WorldView && WorldView.isOpen && WorldView.isOpen());
  }

  function closeWorld() {
    if (root.WorldView && WorldView.close) WorldView.close();
  }

  /* Exactly one entry in the bar reads as active, and which one is a
     question about what is actually on screen rather than a flag kept
     in step by hand. */
  function activeBottom() {
    if (worldOpen()) return 'world';
    if (openTabName) return openTabName;
    if (archOpen) return 'architect';
    return '';
  }

  function pressBottom(name) {
    if (name === 'menu') { UI.showMenu(); return; }
    if (name === 'architect') {
      /* With a sheet up the architect is hidden because the sheet is
         over it, not because the player put it away, so the press means
         "back to the architect". Toggling here instead closed the sheet
         and left the architect down with nothing marked active in the
         bar, and the player had to press it twice. */
      var covered = !!openTabName || worldOpen();
      if (openTabName) UI.closeTab();
      closeWorld();
      archOpen = covered ? true : !archOpen;
      sig.arch = '';
      syncArchitectVisibility();
      return;
    }
    if (name === 'world') {
      if (worldOpen()) { closeWorld(); return; }
      if (!root.WorldView || !WorldView.open) { UI.toast('The world map is not loaded.'); return; }
      WorldView.open();
      return;
    }
    closeWorld();
    UI.openTab(name);
  }

  function buildTabBar() {
    var bar = P.topbar;
    clear(bar);
    tabButtons = {};
    BOTTOM_TABS.forEach(function (t) {
      var b = btn(t[1], 'nav-btn', function () { pressBottom(t[0]); });
      tabButtons[t[0]] = b;
      bar.appendChild(b);
    });
  }

  function updateTabBar() {
    var active = activeBottom();
    var s = active + '|' + (Game.started ? '1' : '0');
    if (s === sig.bar) return;
    sig.bar = s;
    for (var k in tabButtons) tabButtons[k].classList.toggle('on', k === active);
  }

  /* ------------------------------------------------------------------
     Date, time, temperature, wealth and the speed controls
     ------------------------------------------------------------------ */

  var clockEls = {};

  function buildClock() {
    var box = el('div', 'clock');
    clockEls.date = el('div', 'clock-date', '');
    var timeRow = el('div', 'clock-time');
    clockEls.time = el('span', 'clock-hm', '');
    clockEls.temp = el('span', 'clock-temp', '');
    timeRow.appendChild(clockEls.time);
    timeRow.appendChild(clockEls.temp);
    clockEls.wealth = el('div', 'clock-wealth', '');
    box.appendChild(tip(clockEls.date, 'Day, season and year. A season is 15 days.'));
    box.appendChild(tip(timeRow,
      'Colony time and the outdoor temperature. Crops stop growing below 0 C.'));
    box.appendChild(tip(clockEls.wealth,
      'Colony wealth in silver. The storyteller sizes raids from it.'));

    var speeds = el('div', 'speed-row');
    clockEls.speed = [];
    ['Pause', '1x', '2x', '3x', '6x'].forEach(function (label, i) {
      var b = btn('', 'speed-btn', function () { Game.setSpeed(i); sig.clock = ''; });
      b.appendChild(iconEl('speed' + i, 13));
      tip(b, label + (i === 0 ? ' (space)' : ' (key ' + i + ')'));
      speeds.appendChild(b);
      clockEls.speed.push(b);
    });
    box.appendChild(speeds);

    clockEls.overlay = btn('Overlay', 'ovl-btn', function () {
      var i = OVERLAYS.indexOf(UI.overlay);
      UI.setOverlay(OVERLAYS[(i + 1) % OVERLAYS.length]);
    });
    tip(clockEls.overlay, 'Cycle the map overlay: zones, power, rooms, beauty, temperature.');
    box.appendChild(clockEls.overlay);
    return box;
  }

  function timeName(h) {
    if (h < 4) return 'night';
    if (h < 7) return 'dawn';
    if (h < 12) return 'morning';
    if (h < 17) return 'afternoon';
    if (h < 21) return 'evening';
    return 'night';
  }

  function updateClock() {
    var day = Game.day(), season = Game.season();
    var clock = Game.timeString ? Game.timeString() : '';
    var temp = Math.round(Game.outdoorTemp());
    var wealth = Math.round(Game.wealth || 0);
    var s = day + '|' + season + '|' + clock + '|' + temp + '|' + wealth + '|' +
      Game.speed + '|' + UI.overlay;
    if (s === sig.clock) return;
    sig.clock = s;

    var year = Math.floor(day / 60) + 1;
    clockEls.date.textContent = 'Day ' + (day + 1) + ' · ' + U.cap(season) + ' · Y' + year;
    clockEls.time.textContent = clock + ' ' + timeName(Game.hour());
    clockEls.temp.textContent = temp + '°C';
    clockEls.temp.className = 'clock-temp' + (temp <= 0 ? ' cold' : (temp >= 32 ? ' hot' : ''));
    clockEls.wealth.textContent = 'Wealth ' +
      (wealth.toLocaleString ? wealth.toLocaleString('en') : wealth) + ' silver';
    for (var i = 0; i < clockEls.speed.length; i++) {
      clockEls.speed[i].classList.toggle('on', Game.speed === i);
    }
    clockEls.overlay.classList.toggle('on', UI.overlay !== 'none');
    clockEls.overlay.textContent = UI.overlay === 'none' ? 'Overlay' : U.cap(UI.overlay);
  }

  /* ------------------------------------------------------------------
     Resource readout - top left
     ------------------------------------------------------------------ */

  var resourceRows = new Map();
  var extraGroups = null;

  /* Every storable def no curated group already covers, so a def added
     later still reaches the readout instead of silently vanishing. */
  function resourceGroups() {
    if (extraGroups) return extraGroups;
    var claimed = {};
    RESOURCE_GROUPS.forEach(function (g) {
      g.ids.forEach(function (id) { claimed[id] = true; });
    });
    extraGroups = RESOURCE_GROUPS.slice();
    var Z = root.Zones;
    var items = (root.Defs && Defs.items) ? Defs.items() : [];
    for (var i = 0; i < items.length; i++) {
      var d = items[i];
      if (claimed[d.id]) continue;
      var cat = Z && Z.categoryOf ? Z.categoryOf(d) : null;
      /* Weapons, apparel, corpses and chunks of a raid are inventory,
         not stock: counting them here would bury the numbers that the
         readout exists for. */
      if (cat !== 'resources' && cat !== 'manufactured' && cat !== 'textiles') continue;
      extraGroups.push({ key: d.id, label: d.label || d.id, ids: [d.id] });
    }
    return extraGroups;
  }

  function stockpiled(map, t) {
    var Z = root.Zones;
    if (!Z || !Z.zoneAt) return false;
    var z = Z.zoneAt(map, t.x, t.y);
    return !!(z && z.kind === 'stockpile');
  }

  function computeResources() {
    var map = Game.map, out = [];
    if (!map || !map.byDef) return out;
    var groups = resourceGroups();
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i], total = 0, stored = 0, iconId = null;
      for (var j = 0; j < g.ids.length; j++) {
        var list = map.byDef(g.ids[j]);
        if (!list || !list.length) continue;
        if (!iconId) iconId = g.ids[j];
        for (var k = 0; k < list.length; k++) {
          var t = list[k];
          var n = t.stack || 1;
          total += n;
          if (stockpiled(map, t)) stored += n;
        }
      }
      if (total <= 0) continue;
      out.push({ key: g.key, label: g.label, count: total, stored: stored, iconId: iconId });
    }
    return out;
  }

  function renderResources() {
    var list = resourceCache;
    var s = '';
    for (var i = 0; i < list.length; i++) s += list[i].key + ':' + list[i].count + ';';
    if (s === sig.res) return;

    /* The set of lines changes rarely; the numbers on them change all
       the time. Rebuild only when a line appears or disappears. */
    var roster = '';
    for (i = 0; i < list.length; i++) roster += list[i].key + ',';
    if (roster !== sig.resRoster) {
      sig.resRoster = roster;
      clear(P.resources);
      resourceRows.clear();
      for (i = 0; i < list.length; i++) {
        var r = list[i];
        var row = el('div', 'res-row');
        row.appendChild(spriteEl(r.iconId, null, 14));
        var n = el('span', 'res-n', '');
        row.appendChild(n);
        P.resources.appendChild(row);
        resourceRows.set(r.key, { row: row, n: n, tipText: '' });
      }
    }
    sig.res = s;
    for (i = 0; i < list.length; i++) {
      var d = list[i], cell = resourceRows.get(d.key);
      if (!cell) continue;
      cell.n.textContent = String(d.count);
      var text = d.label + ': ' + d.count +
        (d.stored < d.count ? ' (' + d.stored + ' in stockpiles)' : '');
      if (text !== cell.tipText) {
        cell.tipText = text;
        cell.row.setAttribute('data-tip', text);
      }
    }
  }

  /* ------------------------------------------------------------------
     Colonist boxes - top centre
     ------------------------------------------------------------------ */

  function boxClick(pawn) {
    var already = Game.selection.length === 1 && Game.selection[0] === pawn;
    if (already) lookAt(pawn.x, pawn.y);
    else UI.selectThing(pawn);
  }

  function buildBox(pawn) {
    var rootEl = el('div', 'pbox');
    var face = portraitEl(pawn, 26);
    var body = el('div', 'pbox-body');
    var name = el('div', 'pbox-name', nameOf(pawn));
    var flag = el('div', 'pbox-flag', '');
    var head = el('div', 'pbox-head');
    head.appendChild(name);
    head.appendChild(flag);

    var hp = el('div', 'pbox-bar hp'), mood = el('div', 'pbox-bar mood');
    var hpFill = el('i', ''), moodFill = el('i', '');
    hp.appendChild(hpFill); mood.appendChild(moodFill);
    body.appendChild(head);
    body.appendChild(hp);
    body.appendChild(mood);
    rootEl.appendChild(face);
    rootEl.appendChild(body);
    rootEl.addEventListener('click', function () { boxClick(pawn); });
    P.pawnRow.appendChild(rootEl);
    return {
      root: rootEl, face: face, flag: flag,
      hpFill: hpFill, moodFill: moodFill, last: '', pose: ''
    };
  }

  function syncColonistBoxes() {
    var list = colonists();
    var roster = list.length + '|';
    for (var i = 0; i < list.length; i++) roster += list[i].id + ',';
    if (roster !== sig.boxRoster) {
      sig.boxRoster = roster;
      clear(P.pawnRow);
      boxMap.clear();
      for (i = 0; i < list.length; i++) boxMap.set(list[i].id, buildBox(list[i]));
    }

    for (i = 0; i < list.length; i++) {
      var pawn = list[i], box = boxMap.get(pawn.id);
      if (!box) continue;
      var hp = healthFraction(pawn);
      var mood = moodOf(pawn);
      var state = pawnState(pawn);
      var selected = Game.selection.indexOf(pawn) >= 0;
      var s = Math.round(hp * 20) + '|' + Math.round(mood * 20) + '|' + state + '|' +
        (selected ? 's' : '') + '|' + nameOf(pawn);
      if (s === box.last) continue;
      box.last = s;

      /* The portrait only changes when the body does - drafted, downed,
         dead - and repainting it otherwise is a canvas blit per box per
         frame for a picture that did not move. */
      var pose = state + (pawn.carried ? 'c' : '');
      if (pose !== box.pose) {
        box.pose = pose;
        paintPortrait(box.face, pawn, 26);
      }
      box.flag.textContent = STATE_LABEL[state] || '';
      box.hpFill.style.width = Math.round(hp * 100) + '%';
      box.hpFill.className = hp < 0.4 ? 'low' : (hp < 0.75 ? 'mid' : '');
      box.moodFill.style.width = Math.round(mood * 100) + '%';
      box.moodFill.className = mood < 0.25 ? 'low' : (mood < 0.4 ? 'mid' : '');
      box.root.className = 'pbox' + (state ? ' ' + state : '') + (selected ? ' sel' : '');
      box.root.setAttribute('data-tip', fullName(pawn) + ' — ' + jobReport(pawn) +
        '. Health ' + Math.round(hp * 100) + '%, mood ' + Math.round(mood * 100) +
        '%. Click to select, click again to jump there.');
    }
  }

  /* ------------------------------------------------------------------
     Inspect pane
     ------------------------------------------------------------------ */

  function row(t, l, s, v, cls, thing) {
    return { t: t, l: l, s: s, v: v, cls: cls, thing: thing || null };
  }

  function needRows(p) {
    var rows = [], n = p.needs || {}, mood = moodOf(p);
    rows.push(row('bar', 'Mood', Math.round(mood * 100) + '%', mood,
      mood < 0.25 ? 'bad' : (mood < 0.4 ? 'warn' : 'good')));
    ['food', 'rest', 'joy', 'comfort', 'outdoors'].forEach(function (k) {
      if (typeof n[k] !== 'number') return;
      rows.push(row('bar', U.cap(k), Math.round(n[k] * 100) + '%', n[k],
        n[k] < 0.2 ? 'bad' : (n[k] < 0.35 ? 'warn' : '')));
    });
    var th = p.breakThresholds;
    if (th) {
      rows.push(row('line', null, 'Breaks at ' + Math.round(th.minor * 100) + '% / ' +
        Math.round(th.major * 100) + '% / ' + Math.round(th.extreme * 100) + '%', 0, 'dim'));
    }
    rows.push(row('head', null, 'Thoughts'));
    var bd = root.Needs && Needs.breakdown ? Needs.breakdown(p) : [];
    if (!bd.length) rows.push(row('line', null, 'Nothing on their mind.', 0, 'dim'));
    /* Needs.breakdown hands back the baseline as an absolute mood and
       every other entry as a signed offset, so they print differently. */
    for (var i = 0; i < bd.length && i < 14; i++) {
      var v = bd[i].value;
      rows.push(row('kv', bd[i].label,
        bd[i].base ? String(Math.round(v * 100)) : U.signed(v * 100, 0), 0,
        bd[i].base ? 'dim' : (v < 0 ? 'bad' : 'good')));
    }
    return rows;
  }

  function healthRows(p) {
    var rows = [];
    rows.push(row('kv', 'Condition', healthText(p), 0,
      p.health && p.health.downed ? 'bad' : ''));
    if (p.health) {
      var bleed = root.Health && Health.bleedRate ? Health.bleedRate(p) : 0;
      rows.push(row('kv', 'Blood loss', Math.round((p.health.bloodLoss || 0) * 100) + '%', 0,
        p.health.bloodLoss > 0.3 ? 'bad' : ''));
      rows.push(row('kv', 'Pain', Math.round((p.health.pain || 0) * 100) + '%', 0,
        p.health.pain > 0.5 ? 'warn' : ''));
      if (bleed > 0.001) {
        rows.push(row('kv', 'Bleeding', U.fmt(bleed, 2) + ' /day', 0, 'bad'));
      }
      var caps = p.health.capacities || {};
      var capKeys = Object.keys(caps);
      if (capKeys.length) {
        rows.push(row('head', null, 'Capacities'));
        for (var c = 0; c < capKeys.length; c++) {
          var cv = caps[capKeys[c]];
          if (cv >= 0.999) continue;
          rows.push(row('kv', U.cap(capKeys[c]), Math.round(cv * 100) + '%', 0,
            cv < 0.5 ? 'bad' : 'warn'));
        }
      }
    }
    rows.push(row('head', null, 'Body'));
    var report = root.Health && Health.partReport ? Health.partReport(p) : [];
    if (!report.length) rows.push(row('line', null, 'No injuries.', 0, 'dim'));
    for (var i = 0; i < report.length; i++) {
      var r = report[i];
      if (r.missing) { rows.push(row('kv', U.cap(r.part), 'missing', 0, 'bad')); continue; }
      var txt = r.injuries.map(function (inj) {
        return inj.label + ' ' + inj.amount + (inj.bleeding ? ' (bleeding)'
          : (inj.tended ? ' (tended)' : '')) + (inj.permanent ? ' (permanent)' : '');
      }).join(', ');
      var bleeding = r.injuries.some(function (inj) { return inj.bleeding; });
      rows.push(row('kv', U.cap(r.part), txt, 0, bleeding ? 'bad' : 'warn'));
    }
    return rows;
  }

  function gearRows(p) {
    var rows = [];
    rows.push(row('head', null, 'Equipment'));
    if (p.equipment) {
      rows.push(row('act', p.equipment.label(), 'Drop', 0, '', p.equipment));
    } else {
      rows.push(row('line', null, 'Unarmed.', 0, 'dim'));
    }
    rows.push(row('head', null, 'Apparel'));
    var ap = p.apparel || [];
    if (!ap.length) rows.push(row('line', null, 'Wearing nothing.', 0, 'dim'));
    for (var i = 0; i < ap.length; i++) rows.push(row('act', ap[i].label(), 'Drop', 0, '', ap[i]));
    rows.push(row('head', null, 'Inventory'));
    var inv = p.inventory || [];
    if (p.carried) rows.push(row('act', 'carrying ' + p.carried.label(), 'Drop', 0, '', p.carried));
    if (!inv.length && !p.carried) rows.push(row('line', null, 'Empty.', 0, 'dim'));
    for (i = 0; i < inv.length; i++) rows.push(row('act', inv[i].label(), 'Drop', 0, '', inv[i]));
    return rows;
  }

  function socialRows(p) {
    var rows = [];
    rows.push(row('head', null, 'Traits'));
    var traits = traitDefs(p);
    if (!traits.length) rows.push(row('line', null, 'Nothing remarkable.', 0, 'dim'));
    traits.forEach(function (t) {
      rows.push(row('kv', U.cap(t.label || t.id), t.description || '', 0, 'dim'));
    });
    rows.push(row('head', null, 'Relations'));
    var rel = p.relations || [];
    if (!rel.length) {
      rows.push(row('line', null, 'No close ties yet. Colonists build them by talking.', 0, 'dim'));
    }
    for (var i = 0; i < rel.length && i < 12; i++) {
      var r = rel[i];
      var other = pawnById(r.otherId);
      rows.push(row('kv', other ? nameOf(other) : 'someone',
        (r.kind || 'known') + ' ' + (r.opinion !== undefined ? U.signed(r.opinion, 0) : ''), 0,
        r.opinion < 0 ? 'bad' : 'good'));
    }
    return rows;
  }

  function characterRows(p) {
    var rows = [];
    rows.push(row('line', null, backstoryLine(p), 0, 'dim'));
    rows.push(row('head', null, 'Skills'));
    var defs = skillDefs();
    for (var i = 0; i < defs.length; i++) {
      var sk = p.skills && p.skills[defs[i].id];
      if (!sk) continue;
      rows.push(row('skill', defs[i].label || defs[i].id, String(sk.level), sk.passion | 0,
        sk.level >= 10 ? 'good' : (sk.level <= 2 ? 'dim' : '')));
    }
    var dis = disabledWork(p), disList = Object.keys(dis);
    if (disList.length) {
      rows.push(row('head', null, 'Incapable of'));
      rows.push(row('line', null, disList.map(function (w) {
        var d = Defs.maybe('workType', w);
        return (d && d.label) || w;
      }).join(', '), 0, 'bad'));
    }
    return rows;
  }

  var PAWN_TABS = [
    ['needs', 'Needs', needRows], ['health', 'Health', healthRows],
    ['gear', 'Gear', gearRows], ['social', 'Social', socialRows],
    ['character', 'Character', characterRows]
  ];

  /* An animal has needs and a body but no gear, no ties and no career,
     so it gets the first two tabs and the pane never lands on one of
     the three that would print a muffalo's artistic skill. */
  function tabsFor(p) {
    return p.isAnimal ? PAWN_TABS.slice(0, 2) : PAWN_TABS;
  }

  function pawnData(p) {
    var tabs = tabsFor(p), tab = tabs[0][0], tabFn = tabs[0][2];
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i][0] !== inspectTab) continue;
      tab = tabs[i][0];
      tabFn = tabs[i][2];
    }
    var d = {
      kind: 'pawn', pawn: p, title: fullName(p), sub: backstoryLine(p),
      job: jobReport(p), rows: tabFn(p), tab: tab
    };
    d.sig = 'p' + p.id + '|' + d.tab + '|' + d.title + '|' + d.sub + '|' + d.job + '|' +
      (p.drafted ? 'D' : '') + rowsSig(d.rows);
    return d;
  }

  function rowsSig(rows) {
    var out = '';
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      out += '#' + r.t + '~' + (r.l || '') + '~' + (r.s || '') + '~' +
        (r.v === undefined ? '' : Math.round(r.v * 100)) + '~' + (r.cls || '');
    }
    return out;
  }

  function thingData(t) {
    var rows = [], def = t.def, map = Game.map;
    var maxHp = root.Construct && Construct.maxHp ? Construct.maxHp(t) : (def.hp || 100);
    rows.push(row('bar', 'Hit points', t.hp + ' / ' + maxHp, maxHp ? t.hp / maxHp : 1,
      t.hp < maxHp * 0.4 ? 'bad' : ''));
    if (def.description) rows.push(row('line', null, def.description, 0, 'dim'));

    if (t.isItem && t.isItem()) {
      rows.push(row('kv', 'Stack', String(t.stack), 0));
      rows.push(row('kv', 'Value', Math.round((def.marketValue || 0) * t.stack) + ' silver', 0));
      rows.push(row('kv', 'Mass', U.fmt((def.mass || 0) * t.stack, 1) + ' kg', 0));
      if (def.nutrition) rows.push(row('kv', 'Nutrition', U.fmt(def.nutrition * t.stack, 2), 0));
      if (def.rotDays && t.rotProgress > 0) {
        rows.push(row('bar', 'Freshness', Math.round((1 - t.rotProgress) * 100) + '%',
          1 - t.rotProgress, t.rotProgress > 0.7 ? 'bad' : ''));
      }
    } else {
      if (t.stuff) rows.push(row('kv', 'Made of', defLabel('thing', t.stuff), 0));
      if (def.building && (def.building.powerConsumed || def.building.powerProduced)) {
        var powered = root.Power && Power.isPowered ? Power.isPowered(t) : !!t.powered;
        rows.push(row('kv', 'Power', (def.building.powerProduced
          ? '+' + def.building.powerProduced : '-' + def.building.powerConsumed) + ' W ' +
          (powered ? '(connected)' : '(no power)'), 0, powered ? 'good' : 'bad'));
        var net = root.Power && Power.netOf ? Power.netOf(map, t) : null;
        if (net) {
          rows.push(row('kv', 'Net', Math.round(net.production) + ' W made, ' +
            Math.round(net.consumption) + ' W used, ' + Math.round(net.stored) + ' Wd stored', 0, 'dim'));
        }
      }
      var room = root.Regions && Regions.roomAt ? Regions.roomAt(map, t.x, t.y) : null;
      if (room) {
        rows.push(row('kv', 'Room', (room.outdoor ? 'outdoors' : room.role || 'room') + ', ' +
          Math.round(room.temperature) + '°C, ' + room.size + ' tiles', 0));
      }
      if (t.isPlant && t.isPlant()) {
        rows.push(row('bar', 'Growth', Math.round((t.growth || 0) * 100) + '%', t.growth || 0,
          t.growth >= 1 ? 'good' : ''));
        if (t.blighted) rows.push(row('kv', 'Blight', 'this crop is dying', 0, 'bad'));
      }
      if (t.isFrame) {
        var need = root.Construct && Construct.materialsNeeded ? Construct.materialsNeeded(t) : null;
        var still = [];
        if (need) for (var k in need) if (need[k] > 0) still.push(need[k] + ' ' + k);
        rows.push(row('kv', 'Still needs', still.length ? still.join(', ') : 'nothing - just work', 0,
          still.length ? 'warn' : 'good'));
      }
      if (t.bills && t.bills.length) {
        rows.push(row('kv', 'Bills', t.bills.length + ' queued', 0));
      }
      if (t.ownerId) {
        var owner = pawnById(t.ownerId);
        if (owner) rows.push(row('kv', 'Assigned to', nameOf(owner), 0));
      }
    }
    /* The subtitle is the def behind a label the stuff renamed - "wall"
       under "wooden wall". When the label already is the def's, which is
       every unstuffed thing, printing it again in grey underneath is
       noise, so it is left out. */
    var title = U.cap(t.label());
    var sub = def.label || def.id || '';
    if (sub.toLowerCase() === title.toLowerCase()) sub = '';
    var d = { kind: 'thing', thing: t, title: title, sub: sub, rows: rows };
    d.sig = 't' + t.id + '|' + d.title + rowsSig(rows);
    return d;
  }

  function zoneData(z) {
    var rows = [];
    rows.push(row('kv', 'Kind', z.kind === 'growing' ? 'growing zone' : 'stockpile', 0));
    rows.push(row('kv', 'Size', z.cells.size + ' tiles', 0));
    if (z.kind === 'stockpile') {
      rows.push(row('kv', 'Priority', String(z.priority), 0));
      rows.push(row('line', null, 'Haulers fill the highest priority stockpile that accepts a thing.', 0, 'dim'));
    } else {
      var pd = z.plantDefId ? Defs.maybe('thing', z.plantDefId) : null;
      rows.push(row('kv', 'Growing', pd ? pd.label : 'nothing', 0));
      rows.push(row('kv', 'Sow', z.allowSow ? 'yes' : 'no', 0));
      rows.push(row('kv', 'Harvest', z.allowCut === false ? 'no' : 'yes', 0));
    }
    var d = { kind: 'zone', zone: z, title: z.label || U.cap(z.kind) + ' ' + z.id, sub: '', rows: rows };
    d.sig = 'z' + z.id + rowsSig(rows);
    return d;
  }

  function renderRows(body, rows, data) {
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], node;
      if (r.t === 'head') {
        node = el('div', 'head', r.s);
      } else if (r.t === 'line') {
        node = el('div', 'line' + (r.cls ? ' ' + r.cls : ''), r.s);
      } else if (r.t === 'bar') {
        node = barEl(r.cls, r.v, r.l);
        node.appendChild(el('span', 'nbar-val', r.s));
      } else if (r.t === 'skill') {
        node = el('div', 'kv');
        node.appendChild(el('span', 'kv-l', r.l));
        var val = el('span', 'kv-v' + (r.cls ? ' ' + r.cls : ''), r.s);
        if (r.v > 0) val.appendChild(el('i', 'passion p' + r.v));
        node.appendChild(val);
      } else if (r.t === 'act') {
        node = el('div', 'kv');
        node.appendChild(el('span', 'kv-l', r.l));
        node.appendChild(dropButton(data, r));
      } else {
        node = el('div', 'kv');
        node.appendChild(el('span', 'kv-l', r.l));
        node.appendChild(el('span', 'kv-v' + (r.cls ? ' ' + r.cls : ''), r.s));
      }
      body.appendChild(node);
    }
  }

  function dropButton(data, r) {
    return btn(r.s, 'mini', function () {
      if (!forceJob(data.pawn, 'dropThing', root.T && r.thing ? T.thing(r.thing) : null)) {
        UI.toast('That cannot be dropped right now.');
      }
      sig.inspect = '';
    });
  }

  function buildInspect() {
    var pane = P.inspect;
    clear(pane);
    var head = el('div', 'ins-head');
    head.appendChild(el('div', 'ins-title', ''));
    head.appendChild(el('div', 'ins-sub', ''));
    head.appendChild(el('div', 'ins-job', ''));
    pane.appendChild(head);
    pane.appendChild(el('div', 'ins-tabs'));
    var insBody = el('div', 'ins-body');
    insBody.addEventListener('scroll', function () { markOverflow(insBody); });
    pane.appendChild(insBody);
    pane.appendChild(el('div', 'ins-foot'));
  }

  function renderInspect(data) {
    var pane = P.inspect;
    if (!data) { pane.classList.add('hidden'); return; }
    pane.classList.remove('hidden');
    var head = pane.firstChild;
    head.childNodes[0].textContent = data.title;
    head.childNodes[1].textContent = data.sub || '';
    head.childNodes[2].textContent = data.job || '';

    var tabs = pane.childNodes[1];
    clear(tabs);
    if (data.kind === 'pawn') {
      tabsFor(data.pawn).forEach(function (t) {
        tabs.appendChild(btn(t[1], 'ins-tab' + (data.tab === t[0] ? ' on' : ''), function () {
          inspectTab = t[0];
          sig.inspect = '';
        }));
      });
    }

    var body = pane.childNodes[2];
    clear(body);
    renderRows(body, data.rows, data);
    overflowDirty = true;

    var foot = pane.childNodes[3];
    clear(foot);
    if (data.kind === 'pawn') buildPawnButtons(foot, data.pawn);
    else if (data.kind === 'thing') buildThingButtons(foot, data.thing);
    else if (data.kind === 'zone') buildZoneButtons(foot, data.zone);
  }

  function buildPawnButtons(foot, p) {
    if (p.faction === 'player' && !p.isAnimal) {
      /* Drafting is the pawn's own business: it drops the current job,
         stops the path and clears the combat stance. Writing the flag
         by hand would leave a drafted colonist walking to a stockpile. */
      foot.appendChild(btn(p.drafted ? 'Undraft' : 'Draft', p.drafted ? 'on' : '', function () {
        if (p.toggleDraft) p.toggleDraft();
        else {
          p.drafted = !p.drafted;
          p.draftTarget = null;
          if (root.Jobs && Jobs.end) Jobs.end(p, 'interrupted');
        }
        sig.inspect = '';
      }));
      foot.appendChild(tip(btn('Prioritise', '', function () {
        UI.setTool({ kind: 'order' });
        UI.toast('Click something for ' + nameOf(p) + ' to do right now.');
      }), 'Pick a job for this colonist to do before anything else.'));
      foot.appendChild(btn('Rename', '', function () { renameDialog(p); }));
    }
    foot.appendChild(btn('Go to', '', function () { lookAt(p.x, p.y); }));
  }

  function buildThingButtons(foot, t) {
    var map = Game.map;
    var recipes = t.def.recipes && t.def.recipes.length;
    if (recipes && !t.isGhost()) {
      foot.appendChild(btn('Bills', '', function () { UI.openBills(t); }));
    }
    if (t.isBuilding && t.isBuilding() && !t.def.natural) {
      foot.appendChild(btn('Deconstruct', 'bad', function () {
        if (root.Construct && Construct.designateDeconstruct) Construct.designateDeconstruct(map, t.x, t.y);
        else map.designate(t.x, t.y, 'deconstruct');
        UI.toast('Marked for deconstruction.');
      }));
    }
    if (t.isGhost()) {
      foot.appendChild(btn('Cancel plan', 'bad', function () {
        if (root.Construct && Construct.cancelAt) Construct.cancelAt(map, t.x, t.y);
        Game.deselectAll();
        sig.inspect = '';
      }));
    }
    /* Only a blueprint can still change material: once a frame has taken
       delivery of wood, swapping it to steel would strand the wood. */
    if (t.isBlueprint && root.Construct && Construct.stuffOptions) {
      Construct.stuffOptions(t.buildDefId).forEach(function (s) {
        foot.appendChild(btn(defLabel('thing', s), t.stuff === s ? 'on mini' : 'mini', function () {
          t.stuff = s;
          sig.inspect = '';
        }));
      });
    }
    foot.appendChild(btn('Go to', '', function () { lookAt(t.x, t.y); }));
  }

  function buildZoneButtons(foot, z) {
    var Z = root.Zones;
    if (z.kind === 'stockpile') {
      for (var i = 0; i <= 4; i++) {
        (function (pr) {
          var label = (Z && Z.priorityLabel) ? Z.priorityLabel(pr) : String(pr);
          foot.appendChild(tip(btn(String(pr), (z.priority === pr ? 'on ' : '') + 'mini', function () {
            if (Z && Z.setPriority) Z.setPriority(Game.map, z, pr);
            else z.priority = pr;
            sig.inspect = '';
          }), 'Priority ' + pr + ' - ' + label));
        })(i);
      }
    } else {
      var plants = Defs.plants().filter(function (d) { return d.plant && d.plant.sowable; });
      var sel = el('select', 'mini-select');
      plants.forEach(function (d) {
        var o = el('option', null, d.label || d.id);
        o.value = d.id;
        if (z.plantDefId === d.id) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        if (!Z || !Z.setPlant || !Z.setPlant(z, sel.value)) UI.toast('That crop cannot be sown.');
        sig.inspect = '';
      });
      foot.appendChild(sel);
      foot.appendChild(btn(z.allowSow ? 'Sowing on' : 'Sowing off', z.allowSow ? 'on mini' : 'mini',
        function () { z.allowSow = !z.allowSow; sig.inspect = ''; }));
    }
    foot.appendChild(btn('Delete zone', 'bad', function () {
      if (Z && Z['delete']) Z['delete'](Game.map, z);
      Game.deselectAll();
      sig.inspect = '';
    }));
  }

  function updateInspect() {
    if (sheetUp) {
      if (sig.inspect !== 'sheet') { sig.inspect = 'sheet'; renderInspect(null); }
      return;
    }
    var sel = Game.selection[0];
    var data = null;
    if (isPawn(sel)) data = pawnData(sel);
    else if (isThing(sel)) data = thingData(sel);
    else if (isZone(sel)) data = zoneData(sel);
    if (data && Game.selection.length > 1) {
      data.sub = (data.sub ? data.sub + '  ' : '') +
        '(' + Game.selection.length + ' selected, showing the first)';
      data.sig += '+' + Game.selection.length;
    }
    var s = data ? data.sig : 'none';
    if (s === sig.inspect) return;
    sig.inspect = s;
    renderInspect(data);
  }

  UI.refreshInspect = function () { sig.inspect = ''; };

  UI.selectThing = function (x) {
    Game.select(x);
    sig.inspect = '';
  };

  /* ------------------------------------------------------------------
     Architect - a category column down the left, the command grid right
     ------------------------------------------------------------------ */

  function buildablesIn(category) {
    if (category === 'floor') {
      return Defs.all('terrain').filter(function (d) { return d.buildCategory === 'floor'; });
    }
    var known = ['structure', 'furniture', 'production', 'power', 'security', 'floor'];
    return Defs.all('thing').filter(function (d) {
      if (!d.buildCategory) return false;
      if (category === 'misc') return known.indexOf(d.buildCategory) < 0;
      return d.buildCategory === category;
    });
  }

  function everyBuildable() {
    var out = Defs.all('thing').filter(function (d) { return !!d.buildCategory; });
    return out.concat(Defs.all('terrain').filter(function (d) {
      return d.buildCategory === 'floor';
    }));
  }

  function costText(defId, stuffId) {
    if (!root.Construct || !Construct.totalCost) return '';
    var cost = Construct.totalCost(defId, stuffId), parts = [];
    for (var k in cost) {
      var d = Defs.maybe('thing', k);
      parts.push(cost[k] + ' ' + ((d && d.label) || k));
    }
    return parts.join(', ') || 'free';
  }

  var archEls = {};

  function buildArchitect() {
    clear(P.architect);

    var side = el('div', 'arch-side');

    var search = el('input', 'arch-search');
    search.type = 'text';
    search.placeholder = 'Search';
    search.addEventListener('input', function () {
      archSearch = String(search.value || '').trim().toLowerCase();
      sig.arch = '';
    });
    /* The map's hotkeys are not wanted while a word is being typed. */
    search.addEventListener('keydown', function (e) {
      if (e.stopPropagation) e.stopPropagation();
      if (e.key === 'Escape') { search.value = ''; archSearch = ''; sig.arch = ''; search.blur(); }
    });

    var cats = el('div', 'arch-cats');
    ARCH_CATEGORIES.forEach(function (c) {
      /* input.js finds these by their class and their text, so the
         label stays the button's only text node and the icon goes in
         ahead of it as an element. */
      var b = btn(c.label, 'arch-cat' + (archCategory === c.id ? ' on' : ''), function () {
        archCategory = c.id;
        if (archSearch) { archSearch = ''; search.value = ''; }
        sig.arch = '';
      });
      b.insertBefore(iconEl(c.icon, 14), b.firstChild);
      cats.appendChild(b);
    });

    /* Categories first, the search under them: that is the order the
       reference puts them in, and it is why the block is two columns
       wide rather than one tall. */
    side.appendChild(cats);
    side.appendChild(search);
    P.architect.appendChild(side);

    var main = el('div', 'arch-main');
    var grid = el('div', 'arch-grid');
    var hint = el('div', 'arch-hint');
    main.appendChild(grid);
    main.appendChild(hint);
    P.architect.appendChild(main);

    grid.addEventListener('scroll', function () { markOverflow(grid); });

    archEls = { search: search, cats: cats, grid: grid, hint: hint };
    syncArchitectVisibility();
  }

  /* Chromium's overlay scrollbar is not painted at rest, so a list that
     scrolls looks exactly like a list whose last row was cut off by a
     bug. `.more` fades the bottom edge while there is more under it.

     scrollHeight is a layout read, and reading it in the same turn that
     just rebuilt the panel forces a synchronous layout - a millisecond,
     measured, on the inspect pane. So a rebuild only raises a flag and
     the read happens at the top of the next frame, where the layout is
     the one the browser has already done for the last paint and the
     read is free. A scroll event reads at once: nothing wrote. */
  var overflowDirty = false;

  function markOverflow(node) {
    if (!node || !node.classList) return;
    var over = node.scrollHeight - node.clientHeight;
    node.classList.toggle('more', over > 2 && node.scrollTop < over - 2);
  }

  function flushOverflow() {
    if (!overflowDirty) return;
    overflowDirty = false;
    if (archOpen) markOverflow(archEls.grid);
    if (P.inspect && !P.inspect.classList.contains('hidden')) {
      markOverflow(P.inspect.childNodes[2]);
    }
  }

  function syncArchitectVisibility() {
    if (!P.architect) return;
    P.architect.classList.toggle('hidden', !archOpen || sheetUp);
  }

  function renderArchitect() {
    if (!archOpen) return;
    var doneCount = root.Research && Research.done ? Research.done.size : 0;
    var t = UI.tool;
    var s = archCategory + '|' + archSearch + '|' + doneCount + '|' + t.kind + '|' +
      (t.defId || '') + '|' + (t.designation || '') + '|' + (t.zoneKind || '') + '|' +
      (t.stuffId || '');
    if (s === sig.arch) return;
    sig.arch = s;

    var cats = archEls.cats;
    for (var i = 0; i < cats.childNodes.length; i++) {
      cats.childNodes[i].classList.toggle('on',
        !archSearch && ARCH_CATEGORIES[i].id === archCategory);
    }

    var grid = archEls.grid;
    clear(grid);
    if (archSearch) renderSearch(grid);
    else if (archCategory === 'orders') renderOrders(grid);
    else if (archCategory === 'zones') renderZoneTools(grid);
    else renderBuildables(grid, buildablesIn(archCategory));

    var hint = archEls.hint;
    clear(hint);
    if (t.kind === 'build' && t.defId) {
      var def = Defs.maybe('thing', t.defId) || Defs.maybe('terrain', t.defId);
      hint.appendChild(el('span', 'arch-hint-text',
        U.cap((def && def.label) || t.defId) + ' — ' + costText(t.defId, t.stuffId) +
        ' · drag to line, R rotates'));
      if (def && def.stuffable && root.Construct) {
        Construct.stuffOptions(t.defId).forEach(function (sid) {
          var sd = Defs.maybe('thing', sid);
          hint.appendChild(btn((sd && sd.label) || sid, 'mini' + (t.stuffId === sid ? ' on' : ''),
            function () { UI.tool.stuffId = sid; sig.arch = ''; }));
        });
      }
    } else if (t.kind !== 'select') {
      hint.appendChild(el('span', 'arch-hint-text',
        'Drag over the map. Escape cancels the tool.'));
    } else {
      hint.appendChild(el('span', 'arch-hint-text dim',
        'Pick a category, then a thing to place.'));
    }
    overflowDirty = true;
  }

  /* A locked item is greyed and refuses the click, but it is not a
     disabled control: browsers suppress mouse events on those, and the
     reason it is locked is the one thing the player came to hover for. */
  function archButton(iconNode, label, sub, active, onClick, disabledReason) {
    var b = el('button', 'arch-item' + (active ? ' on' : '') + (disabledReason ? ' off' : ''));
    b.type = 'button';
    b.appendChild(iconNode);
    b.appendChild(el('span', 'arch-label', label));
    if (sub) b.appendChild(el('span', 'arch-cost', sub));
    if (disabledReason) {
      b.setAttribute('aria-disabled', 'true');
      tip(b, disabledReason);
      b.addEventListener('click', function () { UI.toast(disabledReason); });
    } else {
      b.addEventListener('click', onClick);
    }
    return b;
  }

  function renderOrders(items) {
    DESIGNATIONS.forEach(function (d) {
      var active = UI.tool.kind === 'designate' && UI.tool.designation === d[0];
      items.appendChild(tip(archButton(iconEl('des-' + d[0], 20), d[1], null, active, function () {
        UI.setTool({ kind: 'designate', designation: d[0] });
      }), d[2]));
    });
    items.appendChild(tip(archButton(iconEl('des-cancel', 20), 'Cancel', null,
      UI.tool.kind === 'cancel', function () { UI.setTool({ kind: 'cancel' }); }),
      'Remove designations and unbuilt plans you drag over. ' +
      'Select a zone and use Delete zone to get rid of one of those.'));
  }

  function renderZoneTools(items) {
    items.appendChild(tip(archButton(iconEl('cat-zone', 20), 'Stockpile', 'storage',
      UI.tool.kind === 'zone' && UI.tool.zoneKind === 'stockpile', function () {
        UI.setTool({ kind: 'zone', zoneKind: 'stockpile' });
      }), 'Paint a stockpile. Haulers carry loose items into it.'));
    items.appendChild(tip(archButton(iconEl('work-grow', 20), 'Growing zone', 'crops',
      UI.tool.kind === 'zone' && UI.tool.zoneKind === 'growing', function () {
        UI.setTool({ kind: 'zone', zoneKind: 'growing' });
      }), 'Paint a field. Growers sow it and harvest it when it is ripe.'));
  }

  function renderBuildables(items, list) {
    if (!list.length) {
      items.appendChild(el('div', 'line dim', 'Nothing here yet.'));
      return;
    }
    list.forEach(function (def) {
      var reason = null;
      if (!researchUnlocked(def)) {
        reason = 'Needs research: ' + (researchNeededFor(def) || 'something earlier');
      }
      var stuff = root.Construct && Construct.defaultStuff ? Construct.defaultStuff(def.id) : null;
      var active = UI.tool.kind === 'build' && UI.tool.defId === def.id;
      var b = archButton(spriteEl(def.id, stuff, 20), def.label || def.id,
        costText(def.id, stuff), active, function () {
          UI.setTool({ kind: 'build', defId: def.id, rot: 0, stuffId: stuff });
        }, reason);
      if (!reason) {
        tip(b, U.cap(def.label || def.id) + ' — ' + costText(def.id, stuff) +
          (def.description ? '. ' + def.description : '.'));
      }
      items.appendChild(b);
    });
  }

  /* The search box looks across every category at once, orders and zone
     tools included, because "where did they put the vent" is exactly the
     question a nine-item column cannot answer. */
  function renderSearch(items) {
    var q = archSearch, found = 0;
    DESIGNATIONS.forEach(function (d) {
      if (d[1].toLowerCase().indexOf(q) < 0) return;
      found++;
      var active = UI.tool.kind === 'designate' && UI.tool.designation === d[0];
      items.appendChild(tip(archButton(iconEl('des-' + d[0], 20), d[1], null, active, function () {
        UI.setTool({ kind: 'designate', designation: d[0] });
      }), d[2]));
    });
    if ('stockpile'.indexOf(q) === 0 || 'storage'.indexOf(q) === 0) {
      found++;
      items.appendChild(archButton(iconEl('cat-zone', 20), 'Stockpile', 'storage',
        UI.tool.kind === 'zone' && UI.tool.zoneKind === 'stockpile', function () {
          UI.setTool({ kind: 'zone', zoneKind: 'stockpile' });
        }));
    }
    if ('growing zone'.indexOf(q) === 0 || 'crops'.indexOf(q) === 0) {
      found++;
      items.appendChild(archButton(iconEl('work-grow', 20), 'Growing zone', 'crops',
        UI.tool.kind === 'zone' && UI.tool.zoneKind === 'growing', function () {
          UI.setTool({ kind: 'zone', zoneKind: 'growing' });
        }));
    }
    var hits = everyBuildable().filter(function (d) {
      return String(d.label || d.id).toLowerCase().indexOf(q) >= 0;
    });
    found += hits.length;
    renderBuildables(items, hits);
    if (!found) {
      clear(items);
      items.appendChild(el('div', 'line dim', 'Nothing matches “' + archSearch + '”.'));
    }
  }

  /* The architect category hotkeys in input.js (B, E, P, U, Y, L) come
     through here, because the panel and which page of it is open are
     ui.js's state and nothing outside should be reaching into them. */
  UI.openArchitect = function (category) {
    for (var i = 0; i < ARCH_CATEGORIES.length; i++) {
      if (ARCH_CATEGORIES[i].id !== category) continue;
      archCategory = category;
      archSearch = '';
      if (archEls.search) archEls.search.value = '';
      if (!archOpen) { archOpen = true; syncArchitectVisibility(); }
      if (openTabName) UI.closeTab();
      closeWorld();
      sig.arch = '';
      sig.bar = '';
      return true;
    }
    return false;
  };

  /* ------------------------------------------------------------------
     Overlay tabs: work, research, colonists, schedule, assign, animals,
     bills
     ------------------------------------------------------------------ */

  var TAB_TITLES = {
    work: 'Work priorities', research: 'Research', colonists: 'Colonists',
    schedule: 'Schedule', assign: 'Assign', animals: 'Animals'
  };

  /* Which tabs are a window and which are a sheet. The research tree is
     six columns of cards wide and the world screen is a map, so those
     two take the window; everything else is a table that knows its own
     size and should not be floated in the middle of black acreage. */
  var FITTED_TABS = {
    work: true, colonists: true, schedule: true, assign: true, animals: true
  };

  UI.openTab = function (name) {
    if (openTabName === name && name !== 'bills') return UI.closeTab();
    /* Nothing to tabulate before a colony exists, and every renderer
       below this point reads Game.map. */
    if (!Game.started || !Game.map) return;
    closeWorld();
    openTabName = name;
    sig.tab = '';
    sig.bar = '';
    P.tabPanel.classList.remove('hidden');
    P.tabPanel.classList.remove('compact');
    P.tabPanel.classList.toggle('fit', !!FITTED_TABS[name]);
    renderTab();
  };

  UI.closeTab = function () {
    /* Escape reaches here through input.js whenever #tab-panel is up,
       and the world screen is renting that panel. Closing it properly
       is WorldView's job; tearing its DOM out from under it is not. */
    if (worldOpen()) { closeWorld(); sig.bar = ''; return true; }
    openTabName = null;
    billsBuilding = null;
    resProgress = null;
    sig.bar = '';
    P.tabPanel.classList.add('hidden');
    P.tabPanel.classList.remove('compact');
    P.tabPanel.classList.remove('fit');
    clear(P.tabPanel);
  };

  UI.openBills = function (building) {
    if (!root.Production || !building) { UI.toast('Nothing can be produced here.'); return; }
    closeWorld();
    billsBuilding = building;
    openTabName = 'bills';
    sig.tab = '';
    sig.bar = '';
    P.tabPanel.classList.remove('hidden');
    P.tabPanel.classList.remove('fit');
    P.tabPanel.classList.add('compact');
    renderTab();
  };

  /* A rebuild throws away the scroll position, and the Work tab is
     rebuilt on every click in it, so the offsets are carried over. */
  function tabFrame(title) {
    var old = P.tabPanel.querySelector('.tp-body');
    var keepTop = old ? old.scrollTop : 0, keepLeft = old ? old.scrollLeft : 0;
    clear(P.tabPanel);
    var head = el('div', 'tp-head');
    head.appendChild(el('div', 'tp-title', title));
    head.appendChild(btn('Close', 'tp-close', function () { UI.closeTab(); }));
    P.tabPanel.appendChild(head);
    var body = el('div', 'tp-body');
    P.tabPanel.appendChild(body);
    body.scrollTop = keepTop;
    body.scrollLeft = keepLeft;
    pendingScroll = { body: body, top: keepTop, left: keepLeft };
    return body;
  }

  var pendingScroll = null;

  function renderTab() {
    if (!openTabName) return;
    var list = colonists();
    var s = openTabName + '|' + list.length + '|';
    var i;
    if (openTabName === 'work') {
      for (i = 0; i < list.length; i++) {
        s += list[i].id + ':' + JSON.stringify(list[i].workPriority || {}) + ';';
      }
    } else if (openTabName === 'research') {
      /* The banked points climb every tick, and they drive one line of
         text and one bar, so syncResearchProgress writes those two in
         place and they stay out of the signature. Rebuilding the whole
         tree for them would re-measure every card three times a second
         and take the mouse off whatever it was over. */
      var cur = root.Research && Research.current ? Research.current() : null;
      s += (cur ? cur.id : '-') + ':' +
        (root.Research && Research.done ? Research.done.size : 0);
      syncResearchProgress();
    } else if (openTabName === 'colonists') {
      for (i = 0; i < list.length; i++) {
        s += list[i].id + ':' + Math.round(moodOf(list[i]) * 20) + ':' +
          jobReport(list[i]) + ';';
      }
    } else if (openTabName === 'schedule') {
      for (i = 0; i < list.length; i++) s += scheduleOf(list[i]).join('') + ';';
      s += Math.floor(Game.hour());
    } else if (openTabName === 'assign') {
      s += assignSig(list);
    } else if (openTabName === 'animals') {
      s += animalsSig();
    } else if (openTabName === 'bills') {
      s += billsBuilding ? billsBuilding.id + ':' + JSON.stringify(billsBuilding.bills || []) : '-';
    }
    if (s === sig.tab) return;
    sig.tab = s;

    if (openTabName === 'work') renderWork(list);
    else if (openTabName === 'research') renderResearch();
    else if (openTabName === 'colonists') renderColonists(list);
    else if (openTabName === 'schedule') renderSchedule(list);
    else if (openTabName === 'assign') renderAssign(list);
    else if (openTabName === 'animals') renderAnimals();
    else if (openTabName === 'bills') renderBills();

    if (pendingScroll) {
      pendingScroll.body.scrollTop = pendingScroll.top;
      pendingScroll.body.scrollLeft = pendingScroll.left;
      pendingScroll = null;
    }
  }

  function renderWork(list) {
    var body = tabFrame(TAB_TITLES.work);
    body.appendChild(el('div', 'tp-note',
      '1 is done first, 4 last, blank means never. Click a cell to lower its priority; ' +
      'right-click clears it. A colonist works down their list and then finds something to do.'));
    var types = workTypes();
    if (!types.length || !list.length) {
      body.appendChild(el('div', 'line dim', 'No colonists to assign work to.'));
      return;
    }
    var grid = el('div', 'work-grid');
    grid.style.gridTemplateColumns = '150px repeat(' + types.length + ', minmax(34px, 1fr))';

    grid.appendChild(el('div', 'wg-corner', 'Colonist'));
    types.forEach(function (t) {
      var h = el('div', 'wg-head');
      h.appendChild(iconEl('work-' + t.id, 14));
      h.appendChild(el('span', null, t.label || t.id));
      var skills = (t.skills || []).map(function (sk) {
        var d = Defs.maybe('skill', sk);
        return (d && d.label) || sk;
      }).join(', ');
      tip(h, (t.label || t.id) + ' - ' + (t.description || 'Work of this kind.') +
        (skills ? ' Uses ' + skills + '.' : ' Uses no skill.'));
      grid.appendChild(h);
    });

    list.forEach(function (p) {
      if (!p.workPriority) p.workPriority = {};
      var dis = disabledWork(p);
      var nameCell = el('div', 'wg-name', nameOf(p));
      nameCell.addEventListener('click', function () { UI.selectThing(p); });
      grid.appendChild(nameCell);
      types.forEach(function (t) {
        var incapable = !!dis[t.id];
        var cell = el('div', 'wg-cell');
        if (incapable) {
          cell.className = 'wg-cell off';
          cell.textContent = '-';
          tip(cell, nameOf(p) + ' is incapable of ' + (t.label || t.id) + '.');
          grid.appendChild(cell);
          return;
        }
        var v = p.workPriority[t.id] | 0;
        cell.className = 'wg-cell ' + (v ? WORK_COLORS[v] : '');
        cell.textContent = v ? String(v) : '';
        cell.addEventListener('click', function () {
          p.workPriority[t.id] = (p.workPriority[t.id] | 0) >= 4 ? 0 : (p.workPriority[t.id] | 0) + 1;
          sig.tab = '';
        });
        cell.addEventListener('contextmenu', function (e) {
          e.preventDefault();
          p.workPriority[t.id] = 0;
          sig.tab = '';
        });
        grid.appendChild(cell);
      });
    });
    body.appendChild(grid);
  }

  /* Every project carries a uiPosition whose x is the depth of its
     prerequisite chain and whose y is the row the author wanted it on.
     The depth is recomputed only for a project that has no such field. */
  function researchTiers() {
    var all = root.Research && Research.projects ? Research.projects() : [];
    var memo = {}, tiers = [];
    function tierOf(def) {
      if (memo[def.id] !== undefined) return memo[def.id];
      memo[def.id] = 0;
      var t = 0;
      (def.prerequisites || []).forEach(function (pid) {
        var pd = Defs.maybe('research', pid);
        if (pd) t = Math.max(t, tierOf(pd) + 1);
      });
      memo[def.id] = t;
      return t;
    }
    all.forEach(function (d) {
      var t = (d.uiPosition && d.uiPosition.x >= 0) ? (d.uiPosition.x | 0) : tierOf(d);
      if (!tiers[t]) tiers[t] = [];
      tiers[t].push(d);
    });
    for (var i = 0; i < tiers.length; i++) {
      if (!tiers[i]) { tiers[i] = []; continue; }
      tiers[i].sort(function (a, b) {
        var ay = a.uiPosition ? a.uiPosition.y : 0, by = b.uiPosition ? b.uiPosition.y : 0;
        return ay - by;
      });
    }
    return tiers;
  }

  /* The two nodes the banked points are written into between rebuilds.
     Both belong to the tab panel, so they die with it and are replaced
     the next time the tree is drawn. */
  var resProgress = null;

  function syncResearchProgress() {
    if (!resProgress) return;
    var cur = root.Research && Research.current ? Research.current() : null;
    if (!cur || cur.id !== resProgress.id) { sig.tab = ''; return; }
    var prog = researchProgress(), cost = cur.cost || 1;
    resProgress.head.textContent = 'Researching ' + (cur.label || cur.id) + ' — ' +
      Math.round(prog) + ' / ' + Math.round(cost) + ' work';
    if (resProgress.fill) {
      resProgress.fill.style.width = Math.round(U.clamp01(prog / cost) * 100) + '%';
    }
  }

  function renderResearch() {
    var body = tabFrame(TAB_TITLES.research);
    var cur = root.Research && Research.current ? Research.current() : null;
    var head = el('div', 'tp-note');
    resProgress = null;
    if (cur) {
      var prog = researchProgress(), cost = cur.cost || 1;
      head.textContent = 'Researching ' + (cur.label || cur.id) + ' — ' +
        Math.round(prog) + ' / ' + Math.round(cost) + ' work';
      body.appendChild(head);
      var bar = barEl('wide', prog / cost);
      body.appendChild(bar);
      resProgress = { id: cur.id, head: head, fill: bar.fillEl };
    } else {
      head.textContent = 'Nothing is being researched. Pick a project and put someone on the research bench.';
      body.appendChild(head);
    }

    var wrap = el('div', 'res-wrap');
    var tiers = researchTiers();
    var cardById = {};
    tiers.forEach(function (tier) {
      var col = el('div', 'res-col');
      tier.forEach(function (def) {
        var done = researchDone(def.id);
        var isCur = cur && cur.id === def.id;
        var locked = (def.prerequisites || []).some(function (p) { return !researchDone(p); });
        var card = el('div', 'res-card' + (done ? ' done' : (isCur ? ' cur' : (locked ? ' locked' : ''))));
        card.appendChild(el('div', 'res-name', def.label || def.id));
        card.appendChild(el('div', 'res-cost', Math.round(def.cost || 0) + ' work'));
        if (def.description) card.appendChild(el('div', 'res-desc', def.description));
        var unlocks = (def.unlocks || []).map(function (u) {
          var d = Defs.maybe('thing', u) || Defs.maybe('recipe', u) || Defs.maybe('terrain', u);
          return (d && d.label) || u;
        });
        if (unlocks.length) card.appendChild(el('div', 'res-unlock', 'Unlocks: ' + unlocks.join(', ')));
        if (done) card.appendChild(el('div', 'res-state good', 'Finished'));
        else if (isCur) card.appendChild(el('div', 'res-state gold', 'In progress'));
        else if (locked) card.appendChild(el('div', 'res-state dim', 'Needs earlier work'));
        else {
          card.appendChild(btn('Start', 'mini', function () {
            if (root.Research && Research.start) Research.start(def.id);
            sig.tab = '';
          }));
        }
        cardById[def.id] = card;
        col.appendChild(card);
      });
      wrap.appendChild(col);
    });
    body.appendChild(wrap);
    drawResearchLinks(wrap, cardById);
  }

  /* The tree is only a tree if you can see the prerequisites, so the
     links are drawn once, after layout, from the cards' own positions.
     Three absolutely positioned rules per link rather than an SVG: the
     elbows suit the flat look, and it needs nothing but a div. */
  function linkSeg(parent, cls, x, y, w, h) {
    var d = el('i', cls);
    d.style.left = x + 'px';
    d.style.top = y + 'px';
    d.style.width = Math.max(2, w) + 'px';
    d.style.height = Math.max(2, h) + 'px';
    parent.appendChild(d);
  }

  function drawResearchLinks(wrap, cardById) {
    var drawn = 0;
    Object.keys(cardById).forEach(function (id) {
      var def = Defs.maybe('research', id);
      if (!def || !def.prerequisites || !def.prerequisites.length) return;
      var to = cardById[id];
      def.prerequisites.forEach(function (pid) {
        var from = cardById[pid];
        if (!from || drawn > 120) return;
        drawn++;
        var cls = 'res-link' + (researchDone(pid) ? ' done' : '');
        var x1 = from.offsetLeft + from.offsetWidth;
        var y1 = from.offsetTop + Math.round(from.offsetHeight / 2);
        var x2 = to.offsetLeft;
        var y2 = to.offsetTop + Math.round(to.offsetHeight / 2);
        var mx = Math.round((x1 + x2) / 2);
        linkSeg(wrap, cls, x1, y1, mx - x1, 2);
        linkSeg(wrap, cls, mx, Math.min(y1, y2), 2, Math.abs(y2 - y1) + 2);
        linkSeg(wrap, cls, mx, y2, x2 - mx, 2);
      });
    });
  }

  function renderColonists(list) {
    var body = tabFrame(TAB_TITLES.colonists);
    if (!list.length) {
      body.appendChild(el('div', 'line dim', 'Nobody left.'));
      return;
    }
    var skills = skillDefs();
    var table = el('table', 'ctable');
    var thead = el('thead'), hr = el('tr');
    ['Name', 'Mood', 'Health', 'Doing'].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    skills.forEach(function (sk) {
      var th = el('th', 'skcol', (sk.label || sk.id).slice(0, 4));
      tip(th, sk.label || sk.id);
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    list.forEach(function (p) {
      var tr = el('tr');
      var nameTd = el('td', 'cname', nameOf(p));
      nameTd.addEventListener('click', function () { UI.selectThing(p); lookAt(p.x, p.y); });
      tr.appendChild(nameTd);
      var mood = moodOf(p);
      tr.appendChild(el('td', mood < 0.25 ? 'bad' : (mood < 0.4 ? 'warn' : 'good'),
        Math.round(mood * 100) + '%'));
      var hp = healthFraction(p);
      tr.appendChild(el('td', hp < 0.6 ? 'bad' : '', healthText(p)));
      tr.appendChild(el('td', 'cjob', jobReport(p)));
      skills.forEach(function (sk) {
        var s = p.skills && p.skills[sk.id];
        var td = el('td', 'sk' + (s && s.level >= 10 ? ' good' : (s && s.level <= 2 ? ' dim' : '')),
          s ? String(s.level) : '-');
        if (s && s.passion) td.appendChild(el('i', 'passion p' + s.passion));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
  }

  /* The schedule lives on the pawn so the think tree can read it; the
     default is the one the balance table states, awake at 06:00 and
     asleep at 22:00, with the last two hours of the day for recreation. */
  function scheduleOf(p) {
    if (!p.schedule || p.schedule.length !== 24) {
      p.schedule = [];
      for (var h = 0; h < 24; h++) {
        if (h >= 22 || h < 6) p.schedule.push('sleep');
        else if (h >= 20) p.schedule.push('recreation');
        else p.schedule.push('work');
      }
    }
    return p.schedule;
  }

  var schedulePaint = 'work';

  function renderSchedule(list) {
    var body = tabFrame(TAB_TITLES.schedule);
    body.appendChild(el('div', 'tp-note',
      'Pick a kind of hour, then drag across a colonist’s day to paint it. ' +
      'Anything lets them choose; Work keeps them at their jobs; Sleep sends them to bed.'));
    var pal = el('div', 'sc-pal');
    SCHEDULE_KINDS.forEach(function (k) {
      var b = btn(U.cap(k), 'sc-swatch ' + k + (schedulePaint === k ? ' on' : ''), function () {
        schedulePaint = k;
        sig.tab = '';
      });
      pal.appendChild(b);
    });
    body.appendChild(pal);

    var grid = el('div', 'sched');
    grid.appendChild(el('div', 'sc-name', ''));
    for (var h = 0; h < 24; h++) {
      grid.appendChild(el('div', 'sc-hour' + (Math.floor(Game.hour()) === h ? ' now' : ''),
        h % 2 === 0 ? String(h) : ''));
    }
    list.forEach(function (p) {
      var sched = scheduleOf(p);
      var nameCell = el('div', 'sc-name', nameOf(p));
      nameCell.addEventListener('click', function () { UI.selectThing(p); });
      grid.appendChild(nameCell);
      for (var hh = 0; hh < 24; hh++) {
        (function (hour) {
          var cell = el('div', 'sc-cell ' + sched[hour]);
          cell.addEventListener('mousedown', function (e) {
            e.preventDefault();
            paintingSchedule = true;
            sched[hour] = schedulePaint;
            cell.className = 'sc-cell ' + schedulePaint;
          });
          cell.addEventListener('mouseenter', function () {
            if (!paintingSchedule) return;
            sched[hour] = schedulePaint;
            cell.className = 'sc-cell ' + schedulePaint;
          });
          grid.appendChild(cell);
        })(hh);
      }
    });
    body.appendChild(grid);
  }

  /* ------------------------------------------------------------------
     Assign - who sleeps where, and which role they hold
     ------------------------------------------------------------------ */

  function bedsOnMap() {
    var map = Game.map, out = [];
    if (!map || !map.byDef) return out;
    ['bed', 'sleepingSpot'].forEach(function (id) {
      var list = map.byDef(id);
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (b.isGhost && b.isGhost()) continue;
        if (b.forPrisoners) continue;
        out.push(b);
      }
    });
    return out;
  }

  function bedOf(p) {
    var map = Game.map;
    if (!map || !p.ownedBedId) return null;
    var b = map.thing ? map.thing(p.ownedBedId) : null;
    return (b && b.ownerId === p.id) ? b : null;
  }

  /* No module owns this pairing - jobs.js sets both fields when a
     patient claims a bed - so the UI sets the same two fields, and
     clears whatever either side was pointing at first. */
  function assignBed(p, bed) {
    var old = bedOf(p);
    if (old && old !== bed) old.ownerId = null;
    p.ownedBedId = null;
    if (!bed) return true;
    if (bed.ownerId && bed.ownerId !== p.id) {
      var other = pawnById(bed.ownerId);
      if (other && !other.dead) other.ownedBedId = null;
    }
    bed.ownerId = p.id;
    p.ownedBedId = bed.id;
    return true;
  }

  function ideologyRoles() {
    var I = root.Ideology;
    if (!I || !I.all || !I.colony) return [];
    var existing = [];
    try { existing = I.all() || []; } catch (e) { return []; }
    if (!existing.length) return [];
    var ideo = null;
    try { ideo = I.colony(); } catch (e) { return []; }
    return (ideo && ideo.roles) ? ideo.roles : [];
  }

  function assignSig(list) {
    var s = '';
    for (var i = 0; i < list.length; i++) {
      var b = bedOf(list[i]);
      s += list[i].id + ':' + (b ? b.id : '-') + ';';
    }
    s += '|beds' + bedsOnMap().length;
    var roles = ideologyRoles();
    for (i = 0; i < roles.length; i++) {
      var holder = root.Ideology.roleHolder ? Ideology.roleHolder(roles[i].id, Game.map) : null;
      s += '|' + roles[i].id + ':' + (holder ? holder.id : '-');
    }
    return s;
  }

  function renderAssign(list) {
    var body = tabFrame(TAB_TITLES.assign);
    body.appendChild(el('div', 'tp-note',
      'Who sleeps where, and who holds which role. A colonist with no bed of their own ' +
      'takes whatever is free, which is how two of them end up fighting over one mattress.'));

    if (!list.length) {
      body.appendChild(el('div', 'line dim', 'Nobody left to assign.'));
      return;
    }

    var beds = bedsOnMap();
    body.appendChild(el('div', 'head', 'Beds'));
    if (!beds.length) {
      body.appendChild(el('div', 'line dim',
        'There is not one bed on this map. Build them under Architect / Furniture.'));
    }

    var table = el('table', 'ctable');
    var thead = el('thead'), hr = el('tr');
    ['Colonist', 'Bed', 'Room', ''].forEach(function (h) { hr.appendChild(el('th', null, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');

    list.forEach(function (p) {
      var tr = el('tr');
      var nameTd = el('td', 'cname', nameOf(p));
      nameTd.addEventListener('click', function () { UI.selectThing(p); lookAt(p.x, p.y); });
      tr.appendChild(nameTd);

      var mine = bedOf(p);
      var pick = el('select', 'mini-select');
      var none = el('option', null, 'no bed of their own');
      none.value = '';
      pick.appendChild(none);
      beds.forEach(function (b) {
        var owner = b.ownerId ? pawnById(b.ownerId) : null;
        if (owner && owner !== p && !owner.dead) return;    /* somebody else's */
        var o = el('option', null, U.cap(b.label()) + ' (' + b.x + ', ' + b.y + ')');
        o.value = String(b.id);
        if (mine && mine.id === b.id) o.selected = true;
        pick.appendChild(o);
      });
      pick.addEventListener('change', function () {
        var id = parseInt(pick.value, 10);
        var bed = null;
        for (var i = 0; i < beds.length; i++) if (beds[i].id === id) bed = beds[i];
        assignBed(p, bed);
        sig.tab = '';
      });
      var bedTd = el('td');
      bedTd.appendChild(pick);
      tr.appendChild(bedTd);

      var roomText = '—';
      if (mine && root.Regions && Regions.roomAt) {
        var rm = Regions.roomAt(Game.map, mine.x, mine.y);
        if (rm) {
          roomText = (rm.outdoor ? 'outdoors' : (rm.role || 'room')) + ', ' +
            Math.round(rm.temperature) + '°C';
        }
      }
      tr.appendChild(el('td', mine && roomText.indexOf('outdoors') === 0 ? 'bad' : 'dim', roomText));

      var actTd = el('td');
      if (mine) {
        actTd.appendChild(btn('Unassign', 'mini', function () {
          assignBed(p, null);
          sig.tab = '';
        }));
      }
      tr.appendChild(actTd);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);

    var roles = ideologyRoles();
    if (roles.length) {
      body.appendChild(el('div', 'head', 'Roles'));
      body.appendChild(el('div', 'tp-note',
        'A role is held by one colonist and carries its own duties and moods.'));
      roles.forEach(function (slot) {
        var def = root.Ideology.role ? Ideology.role(slot.id) : null;
        var holder = root.Ideology.roleHolder ? Ideology.roleHolder(slot.id, Game.map) : null;
        var line = el('div', 'kv role-row');
        line.appendChild(el('span', 'kv-l', (def && def.label) || slot.id));
        var pick = el('select', 'mini-select');
        var none = el('option', null, 'nobody');
        none.value = '';
        pick.appendChild(none);
        list.forEach(function (p) {
          var o = el('option', null, nameOf(p));
          o.value = String(p.id);
          if (holder && holder.id === p.id) o.selected = true;
          pick.appendChild(o);
        });
        pick.addEventListener('change', function () {
          var id = parseInt(pick.value, 10);
          if (holder && root.Ideology.unassignRole) Ideology.unassignRole(holder);
          if (id) {
            var p = pawnById(id);
            if (p && root.Ideology.assignRole && !Ideology.assignRole(p, slot.id)) {
              UI.toast('They cannot hold that role.');
            }
          }
          sig.tab = '';
        });
        var val = el('span', 'kv-v');
        val.appendChild(pick);
        line.appendChild(val);
        body.appendChild(line);
      });
    }

    body.appendChild(el('div', 'tp-foot'));
    body.lastChild.appendChild(btn('Colonist overview', 'mini', function () {
      UI.openTab('colonists');
    }));
  }

  /* ------------------------------------------------------------------
     Animals - the herd, what it knows and who it loves
     ------------------------------------------------------------------ */

  function husbandry() { return root.Husbandry || null; }

  function animalsSig() {
    var H = husbandry(), list = tameAnimals(), s = list.length + '|';
    for (var i = 0; i < list.length; i++) {
      var a = list[i];
      s += a.id + ':' + (H && H.trainingSummary ? H.trainingSummary(a) : '') + ':' +
        (a.master || '-') + ':' + ((a.husbandry && a.husbandry.bondId) || '-') + ';';
    }
    if (H && H.policies) {
      try { s += '|' + JSON.stringify(H.policies()); } catch (e) { s += '|p'; }
    }
    return s;
  }

  function renderAnimals() {
    var body = tabFrame(TAB_TITLES.animals);
    var H = husbandry();
    var list = tameAnimals();
    body.appendChild(el('div', 'tp-note',
      'Tame animals, what they have been taught and who they have taken to. ' +
      'Training rots if nobody keeps it up, so a handler is a standing job.'));

    if (!list.length) {
      body.appendChild(el('div', 'line dim',
        'No tame animals. Mark one with the Tame order and put somebody on Handle.'));
      return;
    }

    var people = colonists();
    var table = el('table', 'ctable');
    var thead = el('thead'), hr = el('tr');
    ['Name', 'Kind', 'Stage', 'Training', 'Bonded to', 'Master', 'Doing']
      .forEach(function (h) { hr.appendChild(el('th', null, h)); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tbody = el('tbody');

    list.forEach(function (a) {
      var tr = el('tr');
      var nameTd = el('td', 'cname', nameOf(a));
      nameTd.addEventListener('click', function () { UI.selectThing(a); lookAt(a.x, a.y); });
      tr.appendChild(nameTd);
      tr.appendChild(el('td', 'dim', (a.kind && a.kind.label) || a.kindId || 'animal'));
      tr.appendChild(el('td', 'dim',
        H && H.lifeStage ? H.lifeStage(a) : (a.ageYears ? Math.floor(a.ageYears) + 'y' : '—')));

      var training = H && H.trainingSummary ? H.trainingSummary(a) : 'unknown';
      tr.appendChild(el('td', training === 'untrainable' ? 'faint' : '', training));

      var bond = null;
      if (H && H.bond) { try { bond = H.bond(a); } catch (e) { bond = null; } }
      tr.appendChild(el('td', bond ? 'good' : 'faint', bond ? nameOf(bond) : '—'));

      var masterTd = el('td');
      var pick = el('select', 'mini-select');
      var none = el('option', null, 'nobody');
      none.value = '';
      pick.appendChild(none);
      var master = H && H.masterOf ? H.masterOf(a) : null;
      people.forEach(function (p) {
        var o = el('option', null, nameOf(p));
        o.value = String(p.id);
        if (master && master.id === p.id) o.selected = true;
        pick.appendChild(o);
      });
      pick.addEventListener('change', function () {
        var id = parseInt(pick.value, 10);
        var human = id ? pawnById(id) : null;
        if (H && H.setMaster && !H.setMaster(a, human)) {
          UI.toast(nameOf(a) + ' has to learn obedience first.');
        }
        sig.tab = '';
      });
      masterTd.appendChild(pick);
      tr.appendChild(masterTd);

      tr.appendChild(el('td', 'cjob', jobReport(a)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);

    if (!H || !H.policy) return;

    /* One herd rule per kind you actually keep: how many breeders to
       hold on to before the surplus is marked for slaughter. */
    var kinds = {};
    list.forEach(function (a) { if (a.kindId) kinds[a.kindId] = a; });
    var kindIds = Object.keys(kinds);
    if (!kindIds.length) return;

    body.appendChild(el('div', 'head', 'Herd policies'));
    body.appendChild(el('div', 'tp-note',
      'With a policy on, the surplus above these numbers is marked for slaughter. ' +
      'A bonded or pregnant animal is never picked.'));
    kindIds.forEach(function (kid) {
      var pol = H.policy(kid);
      var sample = kinds[kid];
      var rowEl = el('div', 'pol-row');
      rowEl.appendChild(el('span', 'pol-name',
        U.cap((sample.kind && sample.kind.label) || kid)));
      rowEl.appendChild(btn(pol.enabled ? 'On' : 'Off', 'mini' + (pol.enabled ? ' on' : ''),
        function () { H.setPolicy(kid, { enabled: !pol.enabled }); sig.tab = ''; }));
      [['females', 'females'], ['males', 'males']].forEach(function (f) {
        rowEl.appendChild(el('span', 'pol-label', f[1]));
        rowEl.appendChild(btn('-', 'mini', function () {
          var o = {}; o[f[0]] = pol[f[0]] - 1;
          H.setPolicy(kid, o); sig.tab = '';
        }));
        rowEl.appendChild(el('span', 'pol-n', String(pol[f[0]])));
        rowEl.appendChild(btn('+', 'mini', function () {
          var o = {}; o[f[0]] = pol[f[0]] + 1;
          H.setPolicy(kid, o); sig.tab = '';
        }));
      });
      rowEl.appendChild(btn(pol.keepYoung ? 'Keep young' : 'Cull young',
        'mini' + (pol.keepYoung ? ' on' : ''), function () {
          H.setPolicy(kid, { keepYoung: !pol.keepYoung });
          sig.tab = '';
        }));
      body.appendChild(rowEl);
    });
  }

  function renderBills() {
    var b = billsBuilding;
    if (!b) { UI.closeTab(); return; }
    var body = tabFrame('Bills — ' + U.cap(b.label()));
    if (!b.bills) b.bills = [];

    var add = el('div', 'bill-add');
    var recipes = root.Production && Production.availableRecipes ? Production.availableRecipes(b) : [];
    if (!recipes.length) {
      add.appendChild(el('span', 'dim', 'Nothing can be made here yet - check your research.'));
    } else {
      var sel = el('select', 'mini-select');
      recipes.forEach(function (r) {
        var o = el('option', null, r.label || r.id);
        o.value = r.id;
        sel.appendChild(o);
      });
      add.appendChild(sel);
      add.appendChild(btn('Add bill', '', function () {
        if (Production.addBill(b, sel.value, {})) sig.tab = '';
        else UI.toast('That bill cannot be added here.');
      }));
    }
    body.appendChild(add);

    if (!b.bills.length) {
      body.appendChild(el('div', 'line dim', 'No bills. Nothing will be made here until you add one.'));
      return;
    }
    b.bills.forEach(function (bill) {
      var recipe = Defs.maybe('recipe', bill.recipeId);
      var wrap = el('div', 'bill' + (bill.suspended ? ' suspended' : ''));
      var head = el('div', 'bill-head');
      head.appendChild(el('span', 'bill-name', (recipe && recipe.label) || bill.recipeId));
      head.appendChild(el('span', 'bill-done', 'done ' + (bill.done || 0)));
      wrap.appendChild(head);

      var ctl = el('div', 'bill-ctl');
      ctl.appendChild(btn(bill.repeatMode === 'forever' ? 'Repeat forever'
        : (bill.repeatMode === 'count' ? 'Do ' + bill.targetCount : 'Until you have ' + bill.targetCount),
        'grow', function () {
          bill.repeatMode = bill.repeatMode === 'forever' ? 'count'
            : (bill.repeatMode === 'count' ? 'untilHave' : 'forever');
          if (bill.repeatMode === 'count') bill.done = 0;
          sig.tab = '';
        }));
      if (bill.repeatMode !== 'forever') {
        [-10, -1, 1, 10].forEach(function (d) {
          ctl.appendChild(btn(U.signed(d, 0), 'mini', function () {
            bill.targetCount = Math.max(1, (bill.targetCount | 0) + d);
            sig.tab = '';
          }));
        });
      }
      ctl.appendChild(btn(bill.suspended ? 'Resume' : 'Suspend', 'mini', function () {
        bill.suspended = !bill.suspended;
        sig.tab = '';
      }));
      ctl.appendChild(btn('Up', 'mini', function () {
        if (Production.reorderBill(b, bill, -1)) sig.tab = '';
      }));
      ctl.appendChild(btn('Down', 'mini', function () {
        if (Production.reorderBill(b, bill, 1)) sig.tab = '';
      }));
      ctl.appendChild(btn('Remove', 'mini bad', function () {
        Production.removeBill(b, bill);
        sig.tab = '';
      }));
      wrap.appendChild(ctl);
      if (recipe && recipe.description) wrap.appendChild(el('div', 'bill-desc dim', recipe.description));
      body.appendChild(wrap);
    });
  }

  /* ------------------------------------------------------------------
     Alerts
     ------------------------------------------------------------------ */

  /* Only what a colonist will eat before they are desperate. Kibble is
     for the animals and a corpse is what you resort to, so counting
     either as food in store would hide the alert that matters. */
  var foodDefCache = null;
  function foodDefs() {
    if (!foodDefCache) {
      foodDefCache = Defs.items().filter(function (d) {
        return (d.nutrition || 0) > 0 && (d.foodType === 'meal' || d.foodType === 'raw');
      });
    }
    return foodDefCache;
  }

  function computeAlerts() {
    var out = [], map = Game.map;
    if (!map) return out;
    var list = map.colonists();

    var hungry = null, tend = null, low = null;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!hungry && p.needs && p.needs.food <= 0.15) hungry = p;
      if (!tend && root.Health && Health.needsTending && Health.needsTending(p)) tend = p;
      if (!low && moodOf(p) <= (p.breakThresholds ? p.breakThresholds.major : 0.25)) low = p;
    }
    if (hungry) out.push({ label: nameOf(hungry) + ' is starving', severity: 'high', lookAt: hungry });
    if (tend) out.push({ label: nameOf(tend) + ' needs tending', severity: 'high', lookAt: tend });
    if (low) out.push({ label: nameOf(low) + ' is close to breaking', severity: 'medium', lookAt: low });

    var nutrition = 0, foods = foodDefs();
    for (i = 0; i < foods.length; i++) {
      var stacks = map.byDef(foods[i].id);
      for (var j = 0; j < stacks.length; j++) nutrition += foods[i].nutrition * stacks[j].stack;
    }
    if (list.length && nutrition < list.length * 1.6) {
      out.push({ label: nutrition <= 0 ? 'No food stored' : 'Low food stores',
        severity: nutrition <= 0 ? 'high' : 'medium' });
    }

    var beds = map.byDef('bed').concat(map.byDef('sleepingSpot'));
    if (list.length && beds.length < list.length) {
      out.push({ label: 'Not enough beds', severity: 'medium', lookAt: beds[0] || null });
    }
    for (i = 0; i < beds.length; i++) {
      if (!map.hasRoofAt(beds[i].x, beds[i].y)) {
        out.push({ label: 'A bed is unroofed', severity: 'low', lookAt: beds[i] });
        break;
      }
    }

    var fires = map.byDef('fire');
    if (fires.length) {
      out.push({ label: fires.length + ' ' + U.plural(fires.length, 'fire') + ' burning',
        severity: 'high', lookAt: fires[0] });
    }

    var hostiles = 0, firstHostile = null;
    for (i = 0; i < map.pawns.length; i++) {
      var q = map.pawns[i];
      if (q.dead || q.downed) continue;
      if (Game.hostile && Game.hostile('player', q.faction)) {
        hostiles++;
        if (!firstHostile) firstHostile = q;
      }
    }
    if (hostiles) {
      out.push({ label: hostiles + ' ' + U.plural(hostiles, 'hostile') + ' on the map',
        severity: 'high', lookAt: firstHostile });
    }

    if (root.Research && Research.current && !Research.current()) {
      var avail = Research.available ? Research.available() : [];
      if (avail.length) out.push({ label: 'No research project', severity: 'low', tab: 'research' });
    }
    return out;
  }

  function renderAlerts() {
    var list = alertCache;
    var s = list.length + '|' + list.map(function (a) { return a.severity + a.label; }).join('|');
    if (s === sig.alerts) return;
    sig.alerts = s;
    clear(P.alerts);
    list.forEach(function (a) {
      var node = el('div', 'alert ' + a.severity);
      node.appendChild(iconEl('alert-' + a.severity, 11));
      node.appendChild(el('span', null, a.label));
      node.addEventListener('click', function () {
        if (a.tab) { UI.openTab(a.tab); return; }
        var t = a.lookAt;
        if (!t) return;
        if (t.x !== undefined) lookAt(t.x, t.y);
        if (isPawn(t) || isThing(t)) UI.selectThing(t);
      });
      P.alerts.appendChild(node);
    });
  }

  UI.alerts = function () {
    return alertCache.map(function (a) {
      return { label: a.label, severity: a.severity, lookAt: a.lookAt || null };
    });
  };

  /* ------------------------------------------------------------------
     Letters and messages
     ------------------------------------------------------------------ */

  function openLetter(letter) {
    var actions = [];
    if (letter.x !== null && letter.x !== undefined) {
      actions.push(['Jump there', function () { lookAt(letter.x, letter.y); closeModal(); }]);
    }
    actions.push(['Dismiss', function () {
      Game.dismissLetter(letter);
      sig.letters = '';
      closeModal();
    }]);
    actions.push(['Close', closeModal]);
    showModal(letter.title, letter.text, actions, 'letter-' + letter.kind);
  }

  function renderLetters() {
    var list = Game.letters || [];
    /* This runs every frame, so the signature is built by concatenation
       rather than map/join, which would leave an array and a closure
       behind sixty times a second for a stack that rarely changes. */
    var s = list.length + '|';
    for (var k = 0; k < list.length; k++) s += list[k].id + ',';
    if (s === sig.letters) return;
    sig.letters = s;
    clear(P.letterStack);
    for (var i = list.length - 1; i >= 0 && i >= list.length - 8; i--) {
      (function (letter) {
        var node = el('div', 'letter ' + letter.kind);
        node.appendChild(iconEl('letter-' + letter.kind, 13));
        node.appendChild(el('span', null, letter.title));
        node.addEventListener('click', function () { openLetter(letter); });
        P.letterStack.appendChild(node);
      })(list[i]);
    }
  }

  function pumpMessages() {
    var list = Game.messages || [];
    var now = root.performance ? performance.now() : 0;
    /* Walk back to the first line already on screen, then replay forward,
       because the log reads top-down and the newest line belongs last.
       The walk stops after a screenful: a freshly loaded save arrives
       with a hundred-odd messages nobody has seen, and every one of them
       would be a DOM node built only to be trimmed on the same frame. */
    var fresh = messageScratch;
    fresh.length = 0;
    for (var i = list.length - 1; i >= 0 && fresh.length < 12; i--) {
      if (seenMessages.has(list[i])) break;
      seenMessages.add(list[i]);
      fresh.push(list[i]);
    }
    for (i = fresh.length - 1; i >= 0; i--) {
      var m = fresh[i];
      var node = el('div', 'msg ' + (m.type || 'info'));
      node.textContent = m.text;
      if (m.x !== null && m.x !== undefined) {
        node.classList.add('clickable');
        (function (mx, my) {
          node.addEventListener('click', function () { lookAt(mx, my); });
        })(m.x, m.y);
      }
      P.messages.appendChild(node);
      liveMessages.push({ node: node, born: now, fading: false });
    }
    while (liveMessages.length && now - liveMessages[0].born > MESSAGE_MS) {
      var old = liveMessages.shift();
      if (old.node.parentNode) old.node.parentNode.removeChild(old.node);
    }
    for (i = 0; i < liveMessages.length; i++) {
      var live = liveMessages[i];
      if (live.fading || now - live.born <= MESSAGE_MS - 2000) continue;
      live.fading = true;
      live.node.classList.add('fade');
    }
    while (liveMessages.length > 8) {
      var extra = liveMessages.shift();
      if (extra.node.parentNode) extra.node.parentNode.removeChild(extra.node);
    }
  }

  UI.toast = function (text) {
    var node = el('div', 'msg toast', text);
    P.messages.appendChild(node);
    liveMessages.push({
      node: node, born: root.performance ? performance.now() : 0, fading: false
    });
  };

  /* ------------------------------------------------------------------
     Float menu and tooltip
     ------------------------------------------------------------------ */

  UI.floatMenu = function (x, y, options) {
    UI.closeFloatMenu();
    if (!options || !options.length) return;
    var menu = P.floatMenu;
    clear(menu);
    options.forEach(function (o) {
      var item = el('div', 'fm-item' + (o.disabled ? ' off' : ''), o.label);
      if (!o.disabled && o.action) {
        item.addEventListener('click', function () {
          UI.closeFloatMenu();
          o.action();
        });
      }
      menu.appendChild(item);
    });
    menu.classList.remove('hidden');
    menu.style.left = '0px';
    menu.style.top = '0px';
    var w = menu.offsetWidth, h = menu.offsetHeight;
    var maxX = P.app.clientWidth - w - 4, maxY = P.app.clientHeight - h - 4;
    menu.style.left = Math.max(2, Math.min(x, maxX)) + 'px';
    menu.style.top = Math.max(2, Math.min(y, maxY)) + 'px';

    floatCloser = function (e) {
      if (menu.contains && menu.contains(e.target)) return;
      UI.closeFloatMenu();
    };
    /* Deferred so the click that opened the menu does not close it. */
    setTimeout(function () {
      if (floatCloser) doc.addEventListener('mousedown', floatCloser, true);
    }, 0);
  };

  UI.closeFloatMenu = function () {
    P.floatMenu.classList.add('hidden');
    if (floatCloser) {
      doc.removeEventListener('mousedown', floatCloser, true);
      floatCloser = null;
    }
  };

  UI.tooltip = function (text, sx, sy) {
    var t = P.tooltip;
    if (!text) { t.classList.add('hidden'); return; }
    t.textContent = text;
    t.classList.remove('hidden');
    var w = t.offsetWidth, h = t.offsetHeight;
    var x = Math.min(sx === undefined ? 0 : sx, P.app.clientWidth - w - 6);
    var y = Math.min(sy === undefined ? 0 : sy, P.app.clientHeight - h - 6);
    t.style.left = Math.max(4, x) + 'px';
    t.style.top = Math.max(4, y) + 'px';
  };

  function hookTooltips() {
    P.app.addEventListener('mouseover', function (e) {
      var node = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
      if (!node) { UI.tooltip(null); return; }
      var r = node.getBoundingClientRect();
      /* Below the control normally, above it for anything sitting on the
         bottom edge, so the tab bar's own tips are not drawn off-screen. */
      var below = r.bottom + 6;
      var y = below + 90 > P.app.clientHeight ? Math.max(4, r.top - 34) : below;
      UI.tooltip(node.getAttribute('data-tip'), r.left, y);
    });
    P.app.addEventListener('mouseout', function (e) {
      if (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest('[data-tip]')) {
        UI.tooltip(null);
      }
    });
  }

  /* ------------------------------------------------------------------
     Modal
     ------------------------------------------------------------------ */

  function showModal(title, text, actions, cls) {
    clear(P.modal);
    var box = el('div', 'modal-box' + (cls ? ' ' + cls : ''));
    box.appendChild(el('div', 'modal-title', title));
    if (typeof text === 'string') box.appendChild(el('div', 'modal-text', text));
    else if (text) box.appendChild(text);
    var row = el('div', 'modal-actions');
    (actions || [['Close', closeModal]]).forEach(function (a) {
      row.appendChild(btn(a[0], a[2] || '', a[1]));
    });
    box.appendChild(row);
    P.modal.appendChild(box);
    P.modal.classList.remove('hidden');
  }

  function closeModal() {
    P.modal.classList.add('hidden');
    clear(P.modal);
  }
  UI.closeModal = closeModal;

  function renameDialog(p) {
    var wrap = el('div', 'modal-form');
    var input = el('input', 'field');
    input.type = 'text';
    input.value = p.name ? (p.name.nick || p.name.first || '') : '';
    input.maxLength = 24;
    wrap.appendChild(input);
    showModal('Rename ' + nameOf(p), wrap, [
      ['Rename', function () {
        var v = input.value.trim();
        if (v) {
          if (!p.name) p.name = { first: v, nick: v, last: '' };
          else p.name.nick = v;
          sig.boxRoster = '';
          sig.inspect = '';
        }
        closeModal();
      }],
      ['Cancel', closeModal]
    ]);
    input.focus();
  }

  function deathScreen() {
    showModal('The colony is over', Game.gameOver.reason + ' You lasted ' +
      (Game.day() + 1) + ' days and built ' + Math.round(Game.wealth) + ' silver of colony.', [
      ['Main menu', function () { closeModal(); UI.showMenu(); }]
    ], 'death');
  }

  /* ------------------------------------------------------------------
     Main menu, how to play, credits
     ------------------------------------------------------------------ */

  var menuFields = {};

  function selectField(label, options, value) {
    var wrap = el('label', 'menu-field');
    wrap.appendChild(el('span', null, label));
    var sel = el('select', 'field');
    options.forEach(function (o) {
      var opt = el('option', null, o[1]);
      opt.value = o[0];
      if (o[0] === value) opt.selected = true;
      sel.appendChild(opt);
    });
    wrap.appendChild(sel);
    return { wrap: wrap, input: sel };
  }

  function buildMenu() {
    clear(P.menu);
    var box = el('div', 'menu-box');
    box.appendChild(el('h1', 'menu-title', 'RIMDAUN'));
    box.appendChild(el('div', 'menu-pitch',
      'Three survivors, one unnamed world, and a storyteller who has read your plans.'));

    var form = el('div', 'menu-form');
    var biome = selectField('Biome', [
      ['temperateForest', 'Temperate forest - forgiving'],
      ['aridShrubland', 'Arid shrubland - hot and thin'],
      ['borealForest', 'Boreal forest - cold and hungry']
    ], 'temperateForest');
    var size = selectField('Map size', [
      ['100', 'Small (100 x 100)'], ['140', 'Medium (140 x 140)'], ['180', 'Large (180 x 180)']
    ], '140');
    var diff = selectField('Difficulty', [
      ['0.5|Gentle', 'Gentle'], ['0.8|Easy', 'Easy'], ['1|Rough', 'Rough'],
      ['1.4|Hard', 'Hard'], ['2|Merciless', 'Merciless']
    ], '1|Rough');
    var seedWrap = el('label', 'menu-field');
    seedWrap.appendChild(el('span', null, 'Seed'));
    var seed = el('input', 'field');
    seed.type = 'text';
    seed.placeholder = 'blank for a random world';
    seedWrap.appendChild(seed);

    form.appendChild(biome.wrap);
    form.appendChild(size.wrap);
    form.appendChild(diff.wrap);
    form.appendChild(seedWrap);
    box.appendChild(form);
    menuFields = { biome: biome.input, size: size.input, diff: diff.input, seed: seed };

    var actions = el('div', 'menu-actions');
    /* Escape with nothing selected opens this screen, so a colony that
       is still running needs the door back out before anything else on
       it; without it the only way home is to reload the page. */
    var running = Game.started && !Game.gameOver;
    if (running) {
      actions.appendChild(btn('Back to the colony', 'big-btn primary', function () {
        UI.hideMenu();
      }));
      actions.appendChild(btn('Save colony', 'big-btn', function () {
        UI.toast(UI.save() ? 'Colony saved.' : 'Could not save - storage is unavailable.');
        UI.hideMenu();
      }));
    }
    actions.appendChild(btn('New colony', 'big-btn' + (running ? '' : ' primary'), function () {
      var start = function () {
        var parts = menuFields.diff.value.split('|');
        UI.startGame({
          biome: menuFields.biome.value,
          size: parseInt(menuFields.size.value, 10),
          difficulty: { threatScale: parseFloat(parts[0]), name: parts[1] },
          seed: seedValue(menuFields.seed.value)
        });
      };
      if (!running) { start(); return; }
      showModal('Leave this colony?',
        'Starting a new one abandons the colonists you have now. Anything you have not ' +
        'saved goes with them.',
        [['Start a new colony', function () { closeModal(); start(); }, 'bad'],
         ['Cancel', closeModal]]);
    }));
    /* Continue only exists when there is something to continue: an
       always-present grey button reads as a broken feature. */
    if (UI.hasSave()) {
      actions.appendChild(btn('Continue', 'big-btn', function () {
        if (UI.load()) UI.hideMenu();
        else showModal('That save would not open',
          'The stored colony could not be read - it may be from an older version of the game.',
          [['Close', closeModal]]);
      }));
    }
    actions.appendChild(btn('How to play', 'big-btn', howToPlay));
    actions.appendChild(btn('Credits', 'big-btn', credits));
    box.appendChild(actions);
    box.appendChild(el('div', 'menu-foot',
      'Runs entirely in this page. Nothing is uploaded; saves live in this browser.'));
    P.menu.appendChild(box);
  }

  /* A typed seed should mean the same world every time, and a word is a
     friendlier thing to share than nine digits. */
  function seedValue(text) {
    text = (text || '').trim();
    if (!text) return undefined;
    if (/^\d+$/.test(text)) return parseInt(text, 10) % 2000000000;
    return U.hash(text) % 2000000000;
  }

  function howToPlay() {
    var wrap = el('div', 'doc');
    var cols = el('div', 'doc-cols');

    var a = el('div', 'doc-col');
    a.appendChild(el('h3', null, 'The loop'));
    a.appendChild(el('p', null,
      'You never order a colonist to do a task directly. You mark what needs doing - a wall to ' +
      'build, rock to mine, a field to sow - and each colonist picks the highest-priority work ' +
      'they are allowed to do and can reach. The Work tab is where you decide who does what.'));
    a.appendChild(el('p', null,
      'Everything else follows from that: they get hungry, so someone has to cook; they get ' +
      'tired, so someone has to build beds; wealth attracts raiders, so someone has to shoot.'));
    a.appendChild(el('h3', null, 'The screen'));
    a.appendChild(el('p', null,
      'What you are holding reads down the top left. Your colonists are the boxes across the ' +
      'top: click one to select them, click again to jump the camera to them. Alerts and event ' +
      'letters stack down the right, and the date, the clock and the speed controls sit above ' +
      'them at the bottom right. The row of tabs along the bottom is the rest of the game.'));
    a.appendChild(el('h3', null, 'Your first five minutes'));
    var ol = el('ol');
    [
      'Open Architect / Orders and mark a dozen trees to chop and some rock to mine.',
      'Under Zones, paint a stockpile near the drop pods so hauled goods land somewhere sane.',
      'Under Structure, wall in a small room - four walls and a door is enough.',
      'Under Furniture, put down one bed per colonist inside it.',
      'Under Zones, paint a growing zone on soil and let it default to rice.',
      'Open the Work tab and make sure someone has Cook, Construct, Grow and Doctor at 1 or 2.',
      'Build a campfire under Production, add a "cook simple meal" bill, and unpause.'
    ].forEach(function (t) { ol.appendChild(el('li', null, t)); });
    a.appendChild(ol);
    cols.appendChild(a);

    var b = el('div', 'doc-col');
    b.appendChild(el('h3', null, 'Controls'));
    var keys = [
      ['Left click', 'select a pawn, building, item or zone'],
      ['Left drag', 'box select, or paint the current tool'],
      ['Right click', 'order the selected colonist; when drafted, move or attack'],
      ['Right / middle drag', 'pan the map'],
      ['Wheel, Z / X', 'zoom toward the cursor'],
      ['W A S D, arrows', 'pan'],
      ['Space', 'pause and resume'],
      ['1 2 3 4', 'game speed'],
      ['R', 'rotate the build ghost'],
      ['F', 'draft or undraft the selection'],
      ['H', 'jump home to the colony'],
      ['Tab', 'cycle through colonists'],
      ['Delete', 'cancel the selected plans, or pick up the cancel tool'],
      ['M', 'mine tool'],
      ['C', 'cancel tool'],
      ['K', 'paint a stockpile'],
      ['G', 'paint a growing zone'],
      ['B', 'architect: structure'],
      ['U', 'architect: furniture'],
      ['P', 'architect: production'],
      ['E', 'architect: power'],
      ['Y', 'architect: security'],
      ['L', 'architect: floors'],
      ['Escape', 'close what is open, then drop the tool, then the selection, then the menu']
    ];
    var dl = el('div', 'keys');
    keys.forEach(function (k) {
      var r = el('div', 'key-row');
      r.appendChild(el('kbd', null, k[0]));
      r.appendChild(el('span', null, k[1]));
      dl.appendChild(r);
    });
    b.appendChild(dl);
    b.appendChild(el('h3', null, 'Things that will kill you'));
    b.appendChild(el('p', null,
      'Sleeping outdoors in winter. No doctor when someone is bleeding. A single wooden room ' +
      'with a campfire in it. Wealth you cannot defend. Letting a colonist stay miserable ' +
      'until they break.'));
    cols.appendChild(b);

    wrap.appendChild(cols);
    showModal('How to play', wrap, [['Got it', closeModal]], 'wide');
  }

  function credits() {
    var wrap = el('div', 'doc');
    wrap.appendChild(el('p', null,
      'RIMDAUN is an original colony simulation written in plain JavaScript, inspired by ' +
      'Ludeon Studios’ RimWorld. It is not affiliated with or endorsed by Ludeon.'));
    wrap.appendChild(el('p', null,
      'Every sprite in the game is drawn in code at load time - there are no image files, no ' +
      'fonts to download and no network requests. The page works from a file:// URL.'));
    wrap.appendChild(el('p', null, 'Seed of this world: ' + (Game.seed || 'not started')));
    showModal('Credits', wrap, [['Close', closeModal]]);
  }

  UI.showMenu = function () {
    /* The colony holds still while the menu is up, and picks up at the
       speed it was running at rather than being shoved back to 1x. */
    if (Game.speed > 0) speedBeforeMenu = Game.speed;
    Game.setSpeed(0);
    buildMenu();
    P.menu.classList.remove('hidden');
    closeWorld();
    UI.closeTab();
    UI.closeFloatMenu();
  };

  UI.hideMenu = function () {
    P.menu.classList.add('hidden');
    closeModal();
    if (Game.speed === 0) Game.setSpeed(speedBeforeMenu || 1);
    resetPanels();
  };

  UI.startGame = function (opts) {
    try {
      Game.newGame(opts || {});
    } catch (e) {
      console.error('could not start a colony:', e);
      showModal('The world would not generate',
        'Something went wrong building the map: ' + (e && e.message ? e.message : e) +
        '. Try a different seed or map size.', [['Back', closeModal]]);
      return;
    }
    lastAutosaveDay = Game.day();
    UI.hideMenu();
    centerOnColony();
  };

  function centerOnColony() {
    var list = colonists();
    if (list.length) lookAt(list[0].x, list[0].y);
    else if (Game.map) lookAt(Game.map.w >> 1, Game.map.h >> 1);
  }
  UI.home = centerOnColony;

  function resetPanels() {
    sig.clock = ''; sig.bar = ''; sig.boxRoster = ''; sig.inspect = '';
    sig.arch = ''; sig.alerts = ''; sig.letters = ''; sig.tab = '';
    sig.res = ''; sig.resRoster = '';
    boxMap.clear();
    resourceRows.clear();
    clear(P.pawnRow);
    clear(P.resources);
    clear(P.messages);
    clear(P.alerts);
    clear(P.letterStack);
    alertCache = [];
    resourceCache = [];
    liveMessages.length = 0;
    syncArchitectVisibility();
  }

  /* ------------------------------------------------------------------
     Save and load - the only localStorage in the project
     ------------------------------------------------------------------ */

  function storage() {
    try {
      var s = root.localStorage;
      /* Safari in private mode hands back a store that throws on write,
         so the only honest test is a write. */
      s.setItem('rimdaun.probe', '1');
      s.removeItem('rimdaun.probe');
      return s;
    } catch (e) {
      return null;
    }
  }

  UI.hasSave = function () {
    var s = storage();
    if (!s) return false;
    try { return !!s.getItem(SAVE_KEY); } catch (e) { return false; }
  };

  UI.save = function () {
    var s = storage();
    if (!s || !root.Save || !Save.serialize || !Game.started) return false;
    try {
      s.setItem(SAVE_KEY, JSON.stringify(Save.serialize(Game)));
      return true;
    } catch (e) {
      /* Quota is the common one: a big map plus a long history can push
         past 5 MB, and there is nothing useful to do but say so. */
      return false;
    }
  };

  UI.load = function () {
    var s = storage();
    if (!s || !root.Save || !Save.deserialize) return false;
    try {
      var raw = s.getItem(SAVE_KEY);
      if (!raw) return false;
      if (!Save.deserialize(JSON.parse(raw))) return false;
      lastAutosaveDay = Game.day();
      resetPanels();
      centerOnColony();
      return true;
    } catch (e) {
      return false;
    }
  };

  UI.deleteSave = function () {
    var s = storage();
    if (!s) return false;
    try { s.removeItem(SAVE_KEY); return true; } catch (e) { return false; }
  };

  /* One save per in-game day. The very first frame only records which
     day it is: a colony that has just booted has nothing worth writing,
     and writing it would clobber the save the player came back for. */
  function autosave() {
    var day = Game.day();
    if (day === lastAutosaveDay) return;
    var first = lastAutosaveDay < 0;
    lastAutosaveDay = day;
    if (first) return;
    if (UI.save()) Game.msg('Autosaved.', { type: 'info' });
  }

  /* ------------------------------------------------------------------
     Boot and the per-frame update
     ------------------------------------------------------------------ */

  UI.init = function () {
    P.app = doc.getElementById('app');
    P.topbar = doc.getElementById('topbar');
    P.colonistBar = doc.getElementById('colonist-bar');
    P.alerts = doc.getElementById('alerts');
    P.messages = doc.getElementById('messages');
    P.letters = doc.getElementById('letters');
    P.inspect = doc.getElementById('inspect');
    P.architect = doc.getElementById('architect');
    P.tabPanel = doc.getElementById('tab-panel');
    P.floatMenu = doc.getElementById('float-menu');
    P.tooltip = doc.getElementById('tooltip');
    P.menu = doc.getElementById('menu');
    P.modal = doc.getElementById('modal');

    /* index.html's container ids are frozen, so the two groups that have
       no container of their own are built as sections of one that does:
       the resource readout leads the top band, and the clock closes the
       right-hand rail. */
    clear(P.colonistBar);
    P.resources = el('div', 'res-list');
    P.pawnRow = el('div', 'pawn-row');
    P.colonistBar.appendChild(P.resources);
    P.colonistBar.appendChild(P.pawnRow);

    clear(P.letters);
    P.letterStack = el('div', 'letter-stack');
    P.letters.appendChild(P.letterStack);
    P.letters.appendChild(buildClock());

    buildTabBar();
    buildInspect();
    buildArchitect();
    buildMenu();
    hookTooltips();

    /* Painting the schedule is a drag, and the mouse can leave the grid
       mid-stroke, so the release is caught on the document. */
    doc.addEventListener('mouseup', function () { paintingSchedule = null; });
    P.architect.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    P.tabPanel.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    return UI;
  };

  UI.update = function () {
    frame++;
    /* Before anything writes to the DOM this frame, while the layout is
       still the one that was painted. */
    flushOverflow();
    var onMenu = !P.menu.classList.contains('hidden');
    if (onMenu || !Game.started || !Game.map) {
      P.inspect.classList.add('hidden');
      return;
    }
    if (Game.gameOver && P.modal.classList.contains('hidden')) deathScreen();

    updateClock();
    updateTabBar();
    if (frame % RESOURCE_FRAMES === 0) {
      resourceCache = computeResources();
      renderResources();
    }
    if (frame % BOX_FRAMES === 0) syncColonistBoxes();
    var sel = Game.selection[0] || null;
    if (sel !== lastSelected) { lastSelected = sel; sig.inspect = ''; }
    var sheeted = !!openTabName || worldOpen();
    if (sheeted !== sheetUp) {
      /* The log is parked above the architect, so a sheet taller than
         the architect reaches up into it and cuts its newest line
         through the middle. The two boxes are measured on the one frame
         the sheet opens, while both are still laid out, and never per
         frame. */
      var tall = sheeted &&
        P.messages.getBoundingClientRect().bottom >
        P.tabPanel.getBoundingClientRect().top;
      sheetUp = sheeted;
      sig.inspect = '';
      P.messages.classList.toggle('hidden', tall);
      syncArchitectVisibility();
    }
    if (frame % INSPECT_FRAMES === 0 || sig.inspect === '') updateInspect();
    renderArchitect();
    if (frame % ALERT_FRAMES === 0) {
      alertCache = computeAlerts();
      renderAlerts();
    }
    renderLetters();
    pumpMessages();
    /* A click inside a tab invalidates its signature, and waiting up to
       a third of a second to see the cell change reads as a dropped
       click, so an invalidated tab redraws on the very next frame. */
    if (openTabName && (frame % TAB_FRAMES === 0 || sig.tab === '')) renderTab();
    autosave();
  };

  root.UI = UI;
})(this);
