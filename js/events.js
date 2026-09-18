/* ============================================================
   events.js - the storyteller, and every incident it can fire.

   A storyteller is not a dice roll on a timer. It keeps a separate
   clock per kind of event, spends a points budget that grows with the
   colony, refuses to stack two disasters on top of each other, and
   leaves a young colony alone long enough to build something worth
   losing. That pacing is the difference between random events and a
   story, so it is modelled here rather than approximated.

   This file also owns raid groups. A raid is not a pile of hostile
   pawns: it is a group with an objective, a strategy and a breaking
   point, and something has to remember all three between ticks.
   Combat knows how to shoot. Knowing why these particular people
   walked onto the map, and when they decide it was a bad idea, is
   this file's job.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Everything below pawn.js in the load order is reached through this,
     because an incident runs at tick time when the whole game exists,
     not at load time when half of it does not. */
  function sys(name) { return root[name]; }

  var TICKS_PER_DAY = 60000;
  var TICKS_PER_HOUR = 2500;

  var LONG_TICK = 250;        /* how often pacing is reconsidered */
  var GROUP_TICK = 30;        /* how often a raid group is driven */

  var POINTS_FLOOR = 35;
  var POINTS_CEILING = 10000;
  var BIG_THREAT_GAP = 12 * TICKS_PER_HOUR;
  var ANY_INCIDENT_GAP = 3000;
  var FIRST_THREAT_DAY = 3;

  /* Path end modes, copied rather than read off Path, so this file loads
     even in a sandbox where pathfind.js is missing. */
  var PE_ON_CELL = 0, PE_TOUCH = 1;

  /* ============================================================
     SMALL HELPERS
     ============================================================ */

  function gameOf(g) { return g || root.Game; }

  /* Letters carry the coordinates the camera jumps to when the player
     clicks them, so every incident has to say where it happened. */
  function letter(g, title, text, kind, at) {
    if (!g || !g.letter) return null;
    var opts = { kind: kind || 'neutral' };
    if (at) {
      if (at.x !== undefined) { opts.x = at.x; opts.y = at.y; }
    }
    return g.letter(title, text, opts);
  }

  function isPawnLike(x) {
    return !!x && (x.isHuman !== undefined || x.isAnimal !== undefined);
  }

  function ableColonists(map) {
    var out = [], list = map ? map.colonists() : [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i].downed) out.push(list[i]);
    }
    return out;
  }

  function atMapEdge(map, x, y) {
    return x <= 1 || y <= 1 || x >= map.w - 2 || y >= map.h - 2;
  }

  /* A free, standable cell as near to (x, y) as the map allows. Used for
     everything that arrives from off-map: raiders, wanderers, pods. */
  function freeCellNear(map, x, y, radius) {
    x = U.clamp(x | 0, 1, map.w - 2);
    y = U.clamp(y | 0, 1, map.h - 2);
    var ring = U.cellsInRadius(x, y, radius);
    for (var i = 0; i < ring.length; i++) {
      var cx = ring[i][0], cy = ring[i][1];
      if (!map.inBounds(cx, cy)) continue;
      if (!map.passable(cx, cy)) continue;
      if (map.pawnsAt(cx, cy).length) continue;
      return { x: cx, y: cy };
    }
    return null;
  }

  function edgeCells(map, side) {
    var MG = sys('MapGen');
    if (MG && MG.edgeSpawnCells) {
      var got = MG.edgeSpawnCells(map, side);
      if (got && got.length) return got;
    }
    var out = [], horizontal = side === 'n' || side === 's';
    var n = horizontal ? map.w : map.h;
    for (var i = 2; i < n - 2; i++) {
      var x = horizontal ? i : (side === 'w' ? 1 : map.w - 2);
      var y = horizontal ? (side === 'n' ? 1 : map.h - 2) : i;
      if (map.passable(x, y)) out.push({ x: x, y: y });
    }
    return out;
  }

  function nearestEdgeCell(map, pawn) {
    var left = pawn.x, right = map.w - 1 - pawn.x;
    var up = pawn.y, down = map.h - 1 - pawn.y;
    var best = Math.min(left, right, up, down);
    var x = pawn.x, y = pawn.y;
    if (best === left) x = 1;
    else if (best === right) x = map.w - 2;
    else if (best === up) y = 1;
    else y = map.h - 2;
    var c = freeCellNear(map, x, y, 8);
    return c || { x: U.clamp(x, 1, map.w - 2), y: U.clamp(y, 1, map.h - 2) };
  }

  function richestBuilding(map) {
    var best = null, bestV = 0;
    var it = map.things.values(), step = it.next();
    while (!step.done) {
      var t = step.value;
      step = it.next();
      if (!t.spawned || t.faction !== 'player') continue;
      if (t.isBlueprint || t.isFrame) continue;
      if (!t.def || t.def.category !== 'building') continue;
      var v = t.def.marketValue || 1;
      if (v > bestV) { bestV = v; best = t; }
    }
    return best;
  }

  /* Where the colony is, for anything that needs to aim at it. Colonists
     first, then the most valuable thing they own, then the middle of the
     map so that nothing ever ends up without an answer. */
  function colonyPoint(map, fromX, fromY) {
    var best = null, bestD = Infinity, i;
    var list = map.colonists();
    for (i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.downed) continue;
      var d = U.distSq(fromX, fromY, c.x, c.y);
      if (d < bestD) { bestD = d; best = { x: c.x, y: c.y }; }
    }
    if (best) return best;
    var rich = richestBuilding(map);
    if (rich) return { x: rich.x, y: rich.y };
    if (list.length) return { x: list[0].x, y: list[0].y };
    return { x: map.w >> 1, y: map.h >> 1 };
  }

  function colonyCentre(map) {
    var list = map.colonists();
    if (!list.length) {
      var rich = richestBuilding(map);
      return rich ? { x: rich.x, y: rich.y } : { x: map.w >> 1, y: map.h >> 1 };
    }
    var sx = 0, sy = 0;
    for (var i = 0; i < list.length; i++) { sx += list[i].x; sy += list[i].y; }
    return { x: Math.round(sx / list.length), y: Math.round(sy / list.length) };
  }

  function countOfDefs(map, ids) {
    var n = 0;
    for (var i = 0; i < ids.length; i++) {
      if (!Defs.has('thing', ids[i])) continue;
      n += map.byDef(ids[i]).length;
    }
    return n;
  }

  /* The biggest standing field of one crop, which is what a blight takes:
     {def, count}, or null when there is nothing worth ruining. */
  function biggestField(map) {
    var defs = Defs.plants(), best = null, bestN = 0;
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      if (!d.plant || !d.plant.blightable) continue;
      var list = map.byDef(d.id), n = 0;
      for (var j = 0; j < list.length; j++) {
        var pl = list[j];
        if (pl.spawned && pl.sown && !pl.blighted) n++;
      }
      if (n > bestN) { bestN = n; best = d; }
    }
    return best ? { def: best, count: bestN } : null;
  }

  /* ============================================================
     THE INCIDENT REGISTRY
     ============================================================ */

  var Incidents = {};
  var byId = new Map();
  var all = [];

  Incidents.register = function (spec) {
    if (!spec || !spec.id) return null;
    if (byId.has(spec.id)) return byId.get(spec.id);
    var rec = {
      id: spec.id,
      label: spec.label || spec.id,
      category: spec.category || 'misc',
      minDay: spec.minDay || 0,
      weight: typeof spec.weight === 'function' ? spec.weight : function () { return 1; },
      fire: typeof spec.fire === 'function' ? spec.fire : function () { return false; }
    };
    byId.set(rec.id, rec);
    all.push(rec);
    /* The def table is what the UI reads to list what can happen; the
       record above is what the storyteller runs. They are the same
       object so the two can never drift. */
    if (Defs && Defs.add && !Defs.has('incident', rec.id)) {
      var table = {};
      table[rec.id] = rec;
      Defs.add('incident', table);
    }
    return rec;
  };

  Incidents.get = function (id) { return byId.get(id) || null; };
  Incidents.all = function () { return all.slice(); };
  Incidents.ids = function () { return all.map(function (i) { return i.id; }); };
  Incidents.inCategory = function (cat) {
    return all.filter(function (i) { return i.category === cat; });
  };

  /* ============================================================
     THE STORYTELLER
     ============================================================ */

  var Storyteller = {};

  Storyteller.CATEGORIES = ['threatBig', 'threatSmall', 'good', 'weather', 'misc'];

  /* How long, in days, between events of each kind. Threat intervals are
     divided by the difficulty scale, so Rough breathes and Merciless
     does not. */
  var INTERVAL = {
    threatBig: [1.5, 3.0],
    threatSmall: [0.7, 1.6],
    good: [1.1, 2.4],
    weather: [1.6, 3.4],
    misc: [2.0, 4.5]
  };

  /* The first of each kind is pushed out past the opening days: a colony
     with no walls and no rifles has nothing to defend. */
  var FIRST = {
    threatBig: [3.2, 4.6],
    threatSmall: [2.0, 3.2],
    good: [0.6, 1.6],
    weather: [2.0, 4.0],
    misc: [1.4, 3.0]
  };

  function freshState(g) {
    var tick = g ? g.tick : 0;
    var st = {
      version: 1,
      next: {},
      lastBigTick: -BIG_THREAT_GAP,
      lastFireTick: -ANY_INCIDENT_GAP,
      fired: [],
      counts: {},
      pending: [],
      groups: [],
      nextGroupId: 1
    };
    for (var i = 0; i < Storyteller.CATEGORIES.length; i++) {
      var cat = Storyteller.CATEGORIES[i], r = FIRST[cat];
      st.next[cat] = tick + Math.round(U.randRange(r[0], r[1]) * TICKS_PER_DAY);
    }
    return st;
  }

  Storyteller.state = freshState(null);

  Storyteller.reset = function (g) {
    Storyteller.state = freshState(gameOf(g));
    return Storyteller.state;
  };

  Storyteller.saveState = function () { return Storyteller.state; };

  Storyteller.loadState = function (data) {
    var st = freshState(gameOf(null));
    if (data && typeof data === 'object') {
      if (data.next) for (var k in data.next) st.next[k] = data.next[k] | 0;
      if (data.lastBigTick !== undefined) st.lastBigTick = data.lastBigTick;
      if (data.lastFireTick !== undefined) st.lastFireTick = data.lastFireTick;
      st.fired = data.fired || [];
      st.counts = data.counts || {};
      st.pending = data.pending || [];
      st.groups = data.groups || [];
      st.nextGroupId = data.nextGroupId || 1;
    }
    Storyteller.state = st;
    return st;
  };

  /* ---------- threat points ---------- */

  /* What a colony this size could actually walk away from. The contract's
     raw curve is generous once wealth piles up in a colony that has lost
     half its people, and a raid nobody can survive is not a story, it is
     the end of one. */
  Storyteller.survivableCap = function (g) {
    g = gameOf(g);
    var map = g && g.map;
    var n = 0, armed = 0;
    if (map) {
      var list = map.colonists();
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (p.downed) continue;
        n++;
        if (p.equipment && p.equipment.def && p.equipment.def.weapon) armed++;
      }
    }
    if (n < 1) n = 1;
    var day = g ? g.day() : 0;
    var perColonist = 28 + 2.4 * Math.min(day, 60);
    return Math.max(POINTS_FLOOR + 5, Math.round(n * perColonist + armed * 12));
  };

  /* Every term the UI wants to show, computed once so the number on the
     screen and the number a raid spends are the same number. */
  Storyteller.threatBreakdown = function (g) {
    g = gameOf(g);
    var wealth = 0;
    if (g) wealth = g.wealth || (g.map ? g.map.wealth() : 0);
    var day = g ? g.day() : 0;
    var scale = (g && g.difficulty && g.difficulty.threatScale) || 1;
    var wealthPoints = wealth / 2200;
    var dayPoints = day * 2.6;
    var raw = (wealthPoints + dayPoints) * scale;
    var cap = Storyteller.survivableCap(g);
    var ceiling = Math.min(POINTS_CEILING, cap);
    return {
      day: day,
      wealth: wealth,
      wealthPoints: wealthPoints,
      dayPoints: dayPoints,
      difficulty: scale,
      raw: raw,
      floor: POINTS_FLOOR,
      cap: cap,
      ceiling: ceiling,
      capped: raw > ceiling,
      points: U.clamp(raw, POINTS_FLOOR, ceiling)
    };
  };

  Storyteller.threatPoints = function (g) {
    return Storyteller.threatBreakdown(g).points;
  };

  /* The shape of the difficulty curve, for the UI's "threat scale"
     readout: what today costs, and what the next fortnight costs if the
     colony's wealth stands still. */
  Storyteller.threatCurve = function (g, days, step) {
    g = gameOf(g);
    days = days || 20;
    step = step || 2;
    var wealth = g ? (g.wealth || 0) : 0;
    var scale = (g && g.difficulty && g.difficulty.threatScale) || 1;
    var cap = Storyteller.survivableCap(g);
    var today = g ? g.day() : 0;
    var out = [];
    for (var d = today; d <= today + days; d += step) {
      var raw = (wealth / 2200 + d * 2.6) * scale;
      out.push({
        day: d,
        points: U.clamp(raw, POINTS_FLOOR, Math.min(POINTS_CEILING, cap))
      });
    }
    return out;
  };

  /* ---------- firing ---------- */

  function record(st, inc, points, tick) {
    st.fired.push({ id: inc.id, tick: tick, points: Math.round(points) });
    if (st.fired.length > 40) st.fired.splice(0, st.fired.length - 40);
    st.counts[inc.id] = (st.counts[inc.id] || 0) + 1;
    st.lastFireTick = tick;
    if (inc.category === 'threatBig') st.lastBigTick = tick;
  }

  Storyteller.fire = function (id, g, opts) {
    g = gameOf(g);
    opts = opts || {};
    var inc = byId.get(id);
    if (!inc || !g || !g.map) return false;
    var points = opts.points === undefined ? Storyteller.threatPoints(g) : opts.points;
    var ok = false;
    try {
      ok = inc.fire(g, points, opts) !== false;
    } catch (e) {
      if (g.debug) console.log('[storyteller] ' + id + ' threw: ' + (e && e.message));
      ok = false;
    }
    if (ok) record(Storyteller.state, inc, points, g.tick);
    return ok;
  };

  /* The test harness and the debug menu both want "make this happen
     now", with none of the pacing rules in the way. */
  Storyteller.debugFire = function (id, opts) {
    return Storyteller.fire(id, root.Game, opts || {});
  };

  /* An incident that has to happen later - the raid chasing a refugee is
     the reason this exists. Stored as plain data so it survives a save. */
  Storyteller.schedule = function (id, ticksFromNow, opts) {
    var g = gameOf(null);
    var at = (g ? g.tick : 0) + Math.max(1, ticksFromNow | 0);
    /* Pending events are only looked at on a long tick, so land on one:
       a caller that ticks the game to the returned number gets its
       incident, rather than waiting out the rest of the beat. */
    at += (LONG_TICK - (at % LONG_TICK)) % LONG_TICK;
    Storyteller.state.pending.push({ tick: at, id: id, opts: opts || {} });
    return at;
  };

  /* ---------- pacing ---------- */

  function reschedule(st, cat, g, factor) {
    var r = INTERVAL[cat];
    var days = U.randRange(r[0], r[1]) * (factor || 1);
    if (cat === 'threatBig' || cat === 'threatSmall') {
      var scale = (g.difficulty && g.difficulty.threatScale) || 1;
      days /= U.clamp(scale, 0.35, 3);
    }
    st.next[cat] = g.tick + Math.round(days * TICKS_PER_DAY);
  }

  function candidates(cat, g) {
    var day = g.day(), out = [];
    for (var i = 0; i < all.length; i++) {
      var inc = all[i];
      if (inc.category !== cat) continue;
      if (day < inc.minDay) continue;
      var w = 0;
      try { w = inc.weight(g); } catch (e) { w = 0; }
      if (!(w > 0)) continue;
      inc._w = w;
      out.push(inc);
    }
    return out;
  }

  function tickPacing(g) {
    var st = Storyteller.state;
    if (g.tick - st.lastFireTick < ANY_INCIDENT_GAP) return;
    var day = g.day();

    for (var i = 0; i < Storyteller.CATEGORIES.length; i++) {
      var cat = Storyteller.CATEGORIES[i];
      if (g.tick < st.next[cat]) continue;

      /* The two rules that stop a storyteller feeling like a slot
         machine: nothing dangerous before the colony has walls, and
         never two big threats inside half a day. */
      if (cat === 'threatBig') {
        if (day < FIRST_THREAT_DAY || g.tick - st.lastBigTick < BIG_THREAT_GAP) {
          st.next[cat] = g.tick + Math.round(0.25 * TICKS_PER_DAY);
          continue;
        }
      }
      if (cat === 'threatSmall' && day < FIRST_THREAT_DAY) {
        st.next[cat] = g.tick + Math.round(0.3 * TICKS_PER_DAY);
        continue;
      }

      var list = candidates(cat, g);
      if (!list.length) {
        /* Nothing in this category applies yet - a flare with no power,
           a blight with no crops. Look again soon rather than burning
           the whole interval on a category that is asleep. */
        st.next[cat] = g.tick + Math.round(0.4 * TICKS_PER_DAY);
        continue;
      }

      var chosen = U.pickWeighted(list, function (inc) { return inc._w; });
      reschedule(st, cat, g, 1);
      if (chosen && Storyteller.fire(chosen.id, g)) return;
    }
  }

  function tickPending(g) {
    var st = Storyteller.state, p = st.pending;
    for (var i = p.length - 1; i >= 0; i--) {
      if (g.tick < p[i].tick) continue;
      var inc = byId.get(p[i].id);
      /* The twelve-hour rule outranks a timer. A refugee's pursuers can
         wait for the manhunters to be done with you; what they cannot do
         is arrive on top of them. */
      if (inc && inc.category === 'threatBig' && g.tick - st.lastBigTick < BIG_THREAT_GAP) {
        var at = st.lastBigTick + BIG_THREAT_GAP;
        p[i].tick = at + (LONG_TICK - (at % LONG_TICK)) % LONG_TICK;
        continue;
      }
      var job = p.splice(i, 1)[0];
      Storyteller.fire(job.id, g, job.opts || {});
    }
  }

  Storyteller.tick = function (g) {
    g = gameOf(g);
    if (!g || !g.map || g.gameOver) return;
    if ((g.tick % GROUP_TICK) === 0) tickGroups(g);
    if ((g.tick % LONG_TICK) !== 0) return;
    tickPending(g);
    tickPacing(g);
  };

  Storyteller.history = function () { return Storyteller.state.fired.slice(); };
  Storyteller.timesFired = function (id) { return Storyteller.state.counts[id] || 0; };

  /* ============================================================
     RAID GROUPS

     Spawning hostiles is the easy half. The half that makes a raid feel
     like people is here: they arrive with a plan, they take what is in
     front of them, they break through what they cannot walk around,
     and when half of them are on the ground the rest go home.
     ============================================================ */

  /* A raider's price, in threat points. The numbers are calibrated to
     the contract's points curve: 35 points on day 5 buys two people with
     clubs, 200 points late buys a real problem. */
  var RAIDER_KIT = [
    { weapon: 'club', cost: 16, industrial: false },
    { weapon: 'knife', cost: 18, industrial: false },
    { weapon: 'spear', cost: 20, industrial: false },
    { weapon: 'shortBow', cost: 24, industrial: false },
    { weapon: 'pistol', cost: 30, industrial: true },
    { weapon: 'shotgun', cost: 38, industrial: true },
    { weapon: 'boltRifle', cost: 42, industrial: true },
    { weapon: 'autoRifle', cost: 56, industrial: true },
    { weapon: 'sniperRifle', cost: 60, industrial: true }
  ];

  /* Each weapon owns a band of the quality scale. A cheap raid is mostly
     clubs with the odd pistol; an expensive one is mostly rifles with
     the odd club, which is what keeps big raids from looking uniform. */
  function kitWeight(kit, quality, neolithic) {
    if (neolithic && kit.industrial) return 0;
    var centre = (kit.cost - 16) / 44;
    return Math.max(0.03, 1 - Math.abs(quality - centre) * 1.7);
  }

  function rollLoadout(quality, neolithic) {
    var kit = U.pickWeighted(RAIDER_KIT, function (k) {
      return kitWeight(k, quality, neolithic);
    });
    var lo = { weapon: kit.weapon, apparel: ['shirt', 'pants'], cost: kit.cost };
    if (!neolithic && U.chance(0.12 + quality * 0.55)) {
      lo.apparel.push('armorVest');
      lo.cost += 18;
    }
    if (U.chance(0.10 + quality * 0.45)) {
      lo.apparel.push('helmet');
      lo.cost += 10;
    }
    if (U.chance(0.35)) lo.apparel.push('jacket');
    return lo;
  }

  /* What one raider costs on average at this quality. Sizing the roster
     from the expected price rather than from rolled loadouts keeps the
     head count steady from raid to raid, so the same points always mean
     roughly the same fight. */
  function expectedCost(quality, neolithic) {
    var total = 0, weight = 0;
    for (var i = 0; i < RAIDER_KIT.length; i++) {
      var w = kitWeight(RAIDER_KIT[i], quality, neolithic);
      total += w * RAIDER_KIT[i].cost;
      weight += w;
    }
    var per = weight > 0 ? total / weight : 20;
    if (!neolithic) per += 18 * (0.12 + quality * 0.55);
    per += 10 * (0.10 + quality * 0.45);
    return Math.max(14, per);
  }

  function raidRoster(points, neolithic) {
    var quality = U.clamp01((points - 60) / 900);
    var count = U.clamp(Math.round(points / expectedCost(quality, neolithic)), 1, 22);
    return { count: count, quality: quality };
  }

  /* Who is attacking. With civilizations generated, the world decides;
     without them, the built-in raider faction stands in. */
  function raiderFaction(g, points) {
    var F = sys('Factions');
    if (F && F.pickRaider) {
      var plan = null;
      try { plan = F.pickRaider(points); } catch (e) { plan = null; }
      if (plan && plan.id) {
        /* The plan already carries the civilization's own raid-points
           factor, its pawn kinds and the strategies it knows, so take
           those rather than re-deriving them from the kind def. */
        var C = sys('Combat');
        if (C && C.setRelation) C.setRelation(plan.id, 'player', true);
        return {
          id: plan.id,
          name: plan.name || 'raiders',
          kinds: plan.pawnKinds && plan.pawnKinds.length ? plan.pawnKinds : ['raider'],
          strategies: plan.strategies && plan.strategies.length ? plan.strategies : ['assault'],
          preferred: plan.strategy || null,
          points: plan.points || 0,
          neolithic: plan.techLevel === 'neolithic'
        };
      }
    }
    return {
      id: 'raider',
      name: 'a pirate band',
      kinds: ['raider'],
      strategies: ['assault', 'sappers', 'siege'],
      preferred: null,
      points: 0,
      neolithic: false
    };
  }

  function pickStrategy(faction, points, opts) {
    if (opts && opts.strategy) return opts.strategy;
    if (faction.preferred) return faction.preferred;
    var pool = [];
    for (var i = 0; i < faction.strategies.length; i++) {
      var s = faction.strategies[i];
      if (s === 'siege' && points < 120) continue;
      if (s === 'sappers' && points < 70) continue;
      pool.push(s);
    }
    if (!pool.length) return 'assault';
    return U.pickWeighted(pool, function (s) {
      if (s === 'assault') return 6;
      if (s === 'sappers') return 2.2;
      return 1.8;
    });
  }

  function makeRaider(map, kindId, factionId, x, y) {
    var MG = sys('MapGen'), P = sys('Pawn'), p = null;
    if (MG && MG.makePawn) p = MG.makePawn(kindId, factionId, { x: x, y: y, map: map });
    if (!p && P && P.make) p = P.make(kindId, factionId, { x: x, y: y, map: map });
    if (!p) return null;
    p.faction = factionId;
    /* Raiders are not stopped by a shut door, and the pathfinder only
       assumes that for the built-in raider faction id. */
    p.canBashDoors = true;
    if (!map.addPawn(p, x, y)) return null;
    p.fx = p.x; p.fy = p.y;
    return p;
  }

  /* mapgen.js dresses raiders for the world it built - it knows the
     biome, the pawn kind's own arsenal and that a brawler will not use a
     rifle - so it gets first refusal. The ladder above is the fallback,
     and the two agree on what a given points total buys. */
  function gearUp(map, pawn, points, quality, neolithic) {
    var MG = sys('MapGen');
    if (MG && MG.equipRaider && MG.equipRaider(pawn, points)) return;
    var lo = rollLoadout(quality, neolithic);
    if (lo.weapon && Defs.has('thing', lo.weapon)) {
      var w = map.spawnThing(lo.weapon, pawn.x, pawn.y);
      if (w) pawn.equip(w);
    }
    for (var i = 0; i < lo.apparel.length; i++) {
      var id = lo.apparel[i];
      if (!Defs.has('thing', id)) continue;
      var a = map.spawnThing(id, pawn.x, pawn.y);
      if (a) pawn.wear(a);
    }
  }

  /* Pick a map edge the raid can actually walk in from. A colony behind a
     mountain would otherwise get raids that stand in the sea. */
  function pickArrivalCells(map) {
    var Path = sys('Path');
    var sides = U.shuffle(['n', 'e', 's', 'w']);
    var fallback = null;
    for (var s = 0; s < sides.length; s++) {
      var cells = edgeCells(map, sides[s]);
      if (!cells.length) continue;
      var anchor = U.pick(cells);
      var goal = colonyPoint(map, anchor.x, anchor.y);
      if (!fallback) fallback = { anchor: anchor, side: sides[s] };
      if (!Path || !Path.reachable) return { anchor: anchor, side: sides[s] };
      if (Path.reachable(map, anchor.x, anchor.y, goal.x, goal.y, {})) {
        return { anchor: anchor, side: sides[s] };
      }
    }
    return fallback;
  }

  function newGroup(g, strategy, factionId, factionName, points) {
    var st = Storyteller.state;
    return {
      id: st.nextGroupId++,
      factionId: factionId,
      factionName: factionName,
      strategy: strategy,
      points: Math.round(points),
      pawnIds: [],
      count: 0,
      spawnTick: g.tick,
      fleeing: false,
      breaching: false,
      despawned: 0,
      charged: strategy !== 'siege',
      shellsLeft: strategy === 'siege' ? U.randInt(4, 8) : 0,
      nextShell: g.tick + U.randInt(1400, 2400),
      stageX: 0, stageY: 0,
      objX: 0, objY: 0,
      objTick: -99999
    };
  }

  /* ---------- the raid incident itself ---------- */

  Incidents.raid = function (g, points, opts) {
    g = gameOf(g);
    opts = opts || {};
    var map = g && g.map;
    if (!map) return false;
    if (!map.colonists().length) return false;

    points = Math.max(POINTS_FLOOR, points || POINTS_FLOOR);
    var faction = raiderFaction(g, points);
    if (faction.points > 0) points = Math.max(POINTS_FLOOR, faction.points);
    var strategy = pickStrategy(faction, points, opts);
    var roster = raidRoster(points, faction.neolithic);
    var kindId = U.pick(faction.kinds);

    /* Drop pods put a raid inside the walls, which is the one thing a
       turtled colony has no answer for. Rare, and never for the first
       raids a colony sees. */
    var viaPods = opts.drop === true ||
      (opts.drop !== false && points >= 160 && U.chance(0.20));

    var anchors = [];
    if (viaPods) {
      var MG = sys('MapGen');
      var spot = null;
      if (MG && MG.dropPodSpot) spot = MG.dropPodSpot(map);
      if (!spot) {
        var c = colonyCentre(map);
        spot = freeCellNear(map, c.x + U.randInt(-8, 8), c.y + U.randInt(-8, 8), 12);
      }
      if (!spot) viaPods = false;
      else anchors.push(spot);
    }
    if (!viaPods) {
      var arrival = pickArrivalCells(map);
      if (!arrival) return false;
      anchors.push(arrival.anchor);
      /* A big raid comes in along the edge rather than out of one tile. */
      var cells = edgeCells(map, arrival.side);
      for (var e = 1; e < Math.ceil(roster.count / 4) && cells.length; e++) {
        anchors.push(U.pick(cells));
      }
    }

    var group = newGroup(g, viaPods ? 'assault' : strategy, faction.id, faction.name, points);
    var spawned = [];
    for (var i = 0; i < roster.count; i++) {
      var anchor = anchors[i % anchors.length];
      var cell = freeCellNear(map, anchor.x + U.randInt(-2, 2), anchor.y + U.randInt(-2, 2), 8);
      if (!cell) continue;
      var raider = makeRaider(map, kindId, faction.id, cell.x, cell.y);
      if (!raider) continue;
      gearUp(map, raider, points, roster.quality, faction.neolithic);
      spawned.push(raider);
      group.pawnIds.push(raider.id);
    }
    if (!spawned.length) return false;
    group.count = spawned.length;

    var target = colonyPoint(map, spawned[0].x, spawned[0].y);
    group.objX = target.x;
    group.objY = target.y;
    group.objTick = g.tick;
    if (group.strategy === 'siege') {
      var stage = siegeStagingCell(map, spawned[0], target);
      group.stageX = stage.x;
      group.stageY = stage.y;
    }
    Storyteller.state.groups.push(group);

    var n = spawned.length;
    var who = n === 1 ? 'A raider' : n + ' raiders';
    var text;
    if (viaPods) {
      text = 'Drop pods came down inside the colony and ' + n + ' ' +
        U.plural(n, 'raider') + ' from ' + faction.name +
        ' climbed out of the wreckage. They are already past your walls.';
    } else if (group.strategy === 'sappers') {
      text = who + ' from ' + faction.name + ' crossed the edge of the map carrying picks ' +
        'and charges. They have no intention of using your door.';
    } else if (group.strategy === 'siege') {
      text = who + ' from ' + faction.name + ' are digging in at a distance. ' +
        'They mean to shell the colony flat rather than walk into it.';
    } else {
      text = who + ' from ' + faction.name + ' are crossing the fields towards the colony, ' +
        'and they are not slowing down.';
    }
    if (opts.chaseName) {
      text += ' They are the ones who were hunting ' + opts.chaseName + '.';
    }
    letter(g, n === 1 ? 'A raider attacks' : 'Raiders attack', text, 'threat', spawned[0]);
    return true;
  };

  function siegeStagingCell(map, raider, target) {
    var dx = raider.x - target.x, dy = raider.y - target.y;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;
    for (var d = 26; d >= 14; d -= 3) {
      var x = Math.round(target.x + dx * d), y = Math.round(target.y + dy * d);
      var cell = freeCellNear(map, x, y, 6);
      if (cell) return cell;
    }
    return { x: raider.x, y: raider.y };
  }

  /* ---------- driving a raid ---------- */

  function pawnIndex(map) {
    var m = new Map();
    for (var i = 0; i < map.pawns.length; i++) m.set(map.pawns[i].id, map.pawns[i]);
    return m;
  }

  function tickGroups(g) {
    var st = Storyteller.state;
    if (!st.groups.length) return;
    var map = g.map;
    var index = pawnIndex(map);
    for (var i = st.groups.length - 1; i >= 0; i--) {
      if (!tickGroup(g, map, index, st.groups[i])) st.groups.splice(i, 1);
    }
  }

  function tickGroup(g, map, index, grp) {
    var live = [], kept = [], i;
    for (i = 0; i < grp.pawnIds.length; i++) {
      var p = index.get(grp.pawnIds[i]);
      if (!p || p.dead) continue;
      kept.push(grp.pawnIds[i]);
      if (!p.downed) live.push(p);
    }
    grp.pawnIds = kept;

    if (!live.length) { endGroup(g, grp); return false; }

    /* RimWorld's rule, and it is a good one: a raid that has lost half
       its strength stops being an attack and becomes a retreat. */
    if (!grp.fleeing && grp.count >= 2 && (grp.count - live.length) / grp.count >= 0.5) {
      startFlee(g, grp, live);
    } else if (!grp.fleeing && grp.count === 1 && live[0].health &&
               live[0].health.bloodLoss > 0.55) {
      startFlee(g, grp, live);
    }

    if (!grp.fleeing && grp.strategy === 'siege' && !grp.charged) tickSiege(g, map, grp, live);

    /* The objective goes stale when the colonist it was aimed at moves or
       dies, but recomputing it for everybody every tick is a waste. */
    if (g.tick - grp.objTick > 1200) {
      var obj = colonyPoint(map, live[0].x, live[0].y);
      grp.objX = obj.x; grp.objY = obj.y; grp.objTick = g.tick;
    }

    for (i = 0; i < live.length; i++) driveRaider(g, map, grp, live[i]);
    return true;
  }

  function startFlee(g, grp, live) {
    grp.fleeing = true;
    var at = live && live.length ? live[0] : null;
    letter(g, 'The raiders are breaking',
      'What is left of the raiding party has had enough. They are running for the edge of ' +
      'the map, and they are not taking their wounded with them.',
      'good', at);
  }

  function endGroup(g, grp) {
    var map = g.map;
    if (!map || !map.colonists().length) return;
    var beaten = grp.count - grp.despawned;
    if (beaten > 0) {
      letter(g, 'Raid beaten',
        'The last of the attackers is on the ground. The colony holds what it has, ' +
        'for now, and there is gear out there to pick up.',
        'good', { x: grp.objX, y: grp.objY });
    } else {
      letter(g, 'The raiders have gone',
        'The raiding party crossed back over the edge of the map without taking anything. ' +
        'Nobody expects that to be the last of them.',
        'good', { x: grp.objX, y: grp.objY });
    }
    var N = sys('Needs');
    if (N && N.addThought && Defs.has('thought', 'raidBeaten')) {
      var list = map.colonists();
      for (var i = 0; i < list.length; i++) N.addThought(list[i], 'raidBeaten');
    }
  }

  function despawnRaider(g, map, grp, pawn) {
    var Res = root.Res, C = sys('Combat');
    if (pawn.endJob) pawn.endJob('interrupted');
    if (Res && Res.releaseAll) Res.releaseAll(pawn);
    if (C && C.clearStance) C.clearStance(pawn);
    if (pawn.stopPath) pawn.stopPath();
    map.removePawn(pawn);
    pawn.map = null;
    grp.despawned++;
  }

  function fightingAlready(pawn, map) {
    var job = pawn.job, T = root.T;
    if (!job || !T) return false;
    if (job.defId !== 'attackMelee' && job.defId !== 'attackStatic') return false;
    var cur = T.resolve(job.targetA, map);
    if (!cur) return false;
    if (cur.dead || cur.downed) return false;
    if (cur.spawned === false) return false;
    return true;
  }

  function attackJob(pawn, target) {
    var Jobs = sys('Jobs'), T = root.T, C = sys('Combat');
    if (!Jobs || !T || !target) return false;
    var tgt = isPawnLike(target) ? T.pawn(target) : T.thing(target);
    var w = pawn.equipment && pawn.equipment.def && pawn.equipment.def.weapon;
    var ranged = false;
    if (w && w.ranged && C) {
      var d = U.dist(pawn.x, pawn.y, target.x, target.y);
      ranged = d <= w.range && d >= (w.minRange || 0) &&
        C.lineOfSight(pawn.map, pawn.x, pawn.y, target.x, target.y);
    }
    return Jobs.start(pawn, Jobs.make(ranged ? 'attackStatic' : 'attackMelee', tgt));
  }

  /* Re-issuing a goto every group tick would reset the path and the pawn
     would shuffle on the spot, so an existing walk to roughly the same
     place is left alone. */
  function keepWalking(pawn, x, y, pe) {
    var Jobs = sys('Jobs'), T = root.T;
    if (!Jobs || !T) return false;
    var job = pawn.job;
    if (job && job.defId === 'goto' && job.targetA &&
        U.cheb(job.targetA.x, job.targetA.y, x, y) <= 6 &&
        (pawn.path || U.cheb(pawn.x, pawn.y, x, y) <= 2)) {
      return true;
    }
    return Jobs.start(pawn, Jobs.make('goto', T.cell(x, y), null, {
      state: { pe: pe === undefined ? PE_TOUCH : pe }
    }));
  }

  function holdPosition(pawn) {
    var Jobs = sys('Jobs');
    if (!Jobs) return false;
    if (pawn.job && pawn.job.defId === 'waitCombat') return true;
    return Jobs.start(pawn, Jobs.make('waitCombat', null, null, { count: 400 }));
  }

  /* Walk the line to the objective and take the first thing of the
     colony's that is standing in it. That is what sappers do, and what
     any raid does when the colony has walled itself in completely. */
  function breachTarget(map, pawn, objX, objY) {
    var x0 = pawn.x, y0 = pawn.y;
    var dx = Math.abs(objX - x0), sx = x0 < objX ? 1 : -1;
    var dy = -Math.abs(objY - y0), sy = y0 < objY ? 1 : -1;
    var err = dx + dy, x = x0, y = y0, guard = 500;
    while (guard-- > 0) {
      if (map.inBounds(x, y) && !map.passable(x, y)) {
        var b = map.buildingAt(x, y);
        if (b && b.spawned && b.faction === 'player') return b;
      }
      if (x === objX && y === objY) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    return nearestColonyStructure(map, pawn, 30);
  }

  function nearestColonyStructure(map, pawn, maxDist) {
    var ids = ['door', 'wall', 'sandbags'], best = null, bestD = maxDist * maxDist;
    for (var i = 0; i < ids.length; i++) {
      if (!Defs.has('thing', ids[i])) continue;
      var list = map.byDef(ids[i]);
      for (var j = 0; j < list.length; j++) {
        var t = list[j];
        if (!t.spawned || t.faction !== 'player') continue;
        var d = U.distSq(pawn.x, pawn.y, t.x, t.y);
        /* A door is the cheap way in, so it beats a wall at equal range. */
        if (ids[i] === 'door') d *= 0.5;
        if (d < bestD) { bestD = d; best = t; }
      }
    }
    return best;
  }

  function driveRaider(g, map, grp, pawn) {
    if (pawn.dead || pawn.downed) return;
    if (pawn.mentalState) return;

    if (grp.fleeing) {
      if (atMapEdge(map, pawn.x, pawn.y)) { despawnRaider(g, map, grp, pawn); return; }
      var exit = nearestEdgeCell(map, pawn);
      keepWalking(pawn, exit.x, exit.y, PE_ON_CELL);
      return;
    }

    if (fightingAlready(pawn, map)) return;

    var C = sys('Combat');
    if (!C) return;

    var breaching = grp.strategy === 'sappers' || grp.breaching === true;
    var foe = C.findTarget(pawn, {
      preferHumans: true,
      includeBuildings: breaching,
      maxDist: 34
    });
    if (foe) { attackJob(pawn, foe); return; }

    /* A siege holds the line until the shells run out. */
    if (grp.strategy === 'siege' && !grp.charged) {
      if (U.dist(pawn.x, pawn.y, grp.stageX, grp.stageY) > 3.5) {
        keepWalking(pawn, grp.stageX, grp.stageY, PE_ON_CELL);
      } else {
        holdPosition(pawn);
      }
      return;
    }

    var Path = sys('Path');
    var canReach = true;
    if (Path && Path.reachable) {
      canReach = Path.reachable(map, pawn.x, pawn.y, grp.objX, grp.objY, { pawn: pawn });
    }
    if (!canReach) {
      grp.breaching = true;
      var wall = breachTarget(map, pawn, grp.objX, grp.objY);
      if (wall) { attackJob(pawn, wall); return; }
      /* Nothing left to break and nowhere to go: the raid is pointless. */
      startFlee(g, grp, [pawn]);
      return;
    }
    keepWalking(pawn, grp.objX, grp.objY, PE_TOUCH);
  }

  function tickSiege(g, map, grp, live) {
    if (g.tick < grp.nextShell) return;
    grp.nextShell = g.tick + U.randInt(1200, 2200);

    if (grp.shellsLeft <= 0) {
      grp.charged = true;
      letter(g, 'The siege breaks',
        'The besiegers are out of shells. They have left the emplacement and are ' +
        'coming into the colony on foot.',
        'threat', live[0]);
      return;
    }

    /* Somebody has to be at the guns. A siege whose crew is all chasing
       colonists does not get free artillery. */
    var manned = false;
    for (var i = 0; i < live.length; i++) {
      if (U.dist(live[i].x, live[i].y, grp.stageX, grp.stageY) <= 5) { manned = true; break; }
    }
    if (!manned) return;

    var aim = richestBuilding(map);
    var target = aim ? { x: aim.x, y: aim.y } : colonyPoint(map, grp.stageX, grp.stageY);
    var x = U.clamp(target.x + U.randInt(-3, 3), 1, map.w - 2);
    var y = U.clamp(target.y + U.randInt(-3, 3), 1, map.h - 2);

    var C = sys('Combat');
    if (C && C.explosion) C.explosion(map, x, y, 3.4, 42, 'explosion', { instigator: null });
    grp.shellsLeft--;
    g.msg('A shell lands in the colony.', { type: 'threat', x: x, y: y });
  }

  Storyteller.raidGroups = function () { return Storyteller.state.groups; };
  Storyteller.activeRaiders = function () {
    var n = 0, groups = Storyteller.state.groups;
    for (var i = 0; i < groups.length; i++) n += groups[i].pawnIds.length;
    return n;
  };

  /* ============================================================
     THE OTHER ARRIVALS
     ============================================================ */

  Incidents.wanderer = function (g, opts) {
    g = gameOf(g);
    opts = opts || {};
    var map = g && g.map;
    if (!map) return false;
    var arrival = pickArrivalCells(map);
    if (!arrival) return false;
    var cell = freeCellNear(map, arrival.anchor.x, arrival.anchor.y, 10);
    if (!cell) return false;

    var MG = sys('MapGen'), P = sys('Pawn'), pawn = null;
    var kindId = Defs.has('pawnKind', 'colonist') ? 'colonist' : 'colonist';
    if (MG && MG.makePawn) pawn = MG.makePawn(kindId, 'player', { x: cell.x, y: cell.y, map: map });
    if (!pawn && P && P.make) pawn = P.make(kindId, 'player', { x: cell.x, y: cell.y, map: map });
    if (!pawn) return false;
    pawn.faction = 'player';
    if (!map.addPawn(pawn, cell.x, cell.y)) return false;
    pawn.fx = pawn.x; pawn.fy = pawn.y;

    var name = displayName(pawn);
    var N = sys('Needs');
    if (N && N.addThought && Defs.has('thought', 'newColonistJoined')) {
      var list = map.colonists();
      for (var i = 0; i < list.length; i++) {
        if (list[i] !== pawn) N.addThought(list[i], 'newColonistJoined');
      }
    }

    if (opts.refugee) {
      letter(g, 'A refugee begs for shelter',
        name + ' came over the ridge at a run, with nothing but the clothes on their back. ' +
        'Someone is chasing them, and they will be here soon. ' + name + ' has joined the colony.',
        'neutral', pawn);
    } else {
      letter(g, 'A wanderer joins',
        name + ' walked out of the wild and asked to stay. They have nowhere else to be, ' +
        'and they can hold a tool. ' + name + ' has joined the colony.',
        'good', pawn);
    }
    return true;
  };

  function displayName(pawn) {
    if (!pawn || !pawn.name) return 'Someone';
    if (pawn.name.nick) return pawn.name.nick;
    var first = pawn.name.first || '';
    var last = pawn.name.last || '';
    return (first + ' ' + last).trim() || 'Someone';
  }

  Incidents.manhunters = function (g, points) {
    g = gameOf(g);
    var map = g && g.map;
    var A = sys('Animals');
    if (!map || !A || !A.manhunterPack) return false;

    var kinds = A.wildKinds || ['hare', 'deer', 'muffalo', 'boomrat', 'wolf', 'bear'];
    var tier;
    if (points < 90) tier = ['hare', 'boomrat'];
    else if (points < 220) tier = ['deer', 'boomrat', 'wolf'];
    else tier = ['wolf', 'muffalo', 'bear'];
    var pool = tier.filter(function (k) { return kinds.indexOf(k) >= 0; });
    if (!pool.length) pool = kinds;
    var kindId = U.pick(pool);

    var perAnimal = points < 90 ? 14 : (points < 220 ? 24 : 40);
    var count = U.clamp(Math.round(points / perAnimal), 2, 14);

    var before = g.letters.length;
    var pack = A.manhunterPack(map, kindId, count);
    if (!pack || !pack.length) return false;
    /* animals.js announces its own packs. Only speak up if it did not. */
    if (g.letters.length === before) {
      letter(g, 'Manhunter pack',
        pack.length + ' animals have gone mad and are moving on the colony. ' +
        'They will not stop, and they do not care what is in the way.',
        'threat', pack[0]);
    }
    return true;
  };

  /* ============================================================
     THE REGISTRY - one entry per incident id in the contract
     ============================================================ */

  Incidents.register({
    id: 'raidEnemy',
    label: 'raid',
    category: 'threatBig',
    minDay: 5,
    weight: function (g) {
      /* One raid at a time. A second party arriving while the first is
         still in the fields is a pile-on, not a story. */
      return Storyteller.state.groups.length ? 0 : 10;
    },
    fire: function (g, points, opts) { return Incidents.raid(g, points, opts); }
  });

  Incidents.register({
    id: 'manhunterPack',
    label: 'manhunter pack',
    category: 'threatBig',
    minDay: 6,
    weight: function (g) {
      var A = sys('Animals');
      if (!A || !A.manhunterPack) return 0;
      return Storyteller.state.groups.length ? 0 : 3.5;
    },
    fire: function (g, points) { return Incidents.manhunters(g, points); }
  });

  Incidents.register({
    id: 'wandererJoins',
    label: 'wanderer joins',
    category: 'good',
    minDay: 1,
    weight: function (g) {
      var n = g.map ? g.map.colonists().length : 0;
      if (n >= 12) return 0.3;
      /* A colony down to one or two people needs hands more than it
         needs anything else. */
      return 3 + Math.max(0, 6 - n) * 1.4;
    },
    fire: function (g) { return Incidents.wanderer(g); }
  });

  Incidents.register({
    id: 'refugeeChased',
    label: 'refugee chased',
    category: 'good',
    minDay: 7,
    weight: function (g) {
      var n = g.map ? g.map.colonists().length : 0;
      if (n >= 12 || n === 0) return 0;
      return Storyteller.state.groups.length ? 0 : 2.2;
    },
    fire: function (g, points) {
      var before = g.map.colonists().length;
      if (!Incidents.wanderer(g, { refugee: true })) return false;
      var joined = g.map.colonists();
      var who = joined.length > before ? joined[joined.length - 1] : null;
      /* The whole point of the incident is the bill that comes due a few
         hours later, so the raid is scheduled, not fired. */
      Storyteller.schedule('raidEnemy', U.randInt(4000, 11000), {
        points: Math.max(POINTS_FLOOR, points * 0.75),
        strategy: 'assault',
        drop: false,
        chaseName: who ? displayName(who) : 'your new arrival'
      });
      return true;
    }
  });

  Incidents.register({
    id: 'animalSelfTame',
    label: 'animal self-tames',
    category: 'good',
    minDay: 2,
    weight: function (g) {
      var A = sys('Animals');
      return A && A.tameNow ? 3 : 0;
    },
    fire: function (g) {
      var map = g.map, A = sys('Animals');
      if (!A) return false;
      var centre = colonyCentre(map);
      var best = null, bestD = Infinity;
      for (var i = 0; i < map.pawns.length; i++) {
        var p = map.pawns[i];
        if (!p.isAnimal || p.dead || p.downed) continue;
        if (p.faction !== 'wild' || p.tame) continue;
        if (A.isManhunter && A.isManhunter(p)) continue;
        if (A.isPredator && A.isPredator(p) && !U.chance(0.15)) continue;
        var d = U.distSq(centre.x, centre.y, p.x, p.y);
        if (d < bestD) { bestD = d; best = p; }
      }
      /* Nothing wandering nearby: one walks in from the trees instead. */
      if (!best && A.spawnWild) {
        var cell = freeCellNear(map, centre.x + U.randInt(-14, 14), centre.y + U.randInt(-14, 14), 12);
        var kinds = (A.wildKinds || ['hare', 'deer', 'muffalo']).filter(function (k) {
          return !A.isPredator || !A.isPredator({ kindId: k });
        });
        if (cell && kinds.length) {
          var made = A.spawnWild(map, U.pick(kinds), cell.x, cell.y, 1);
          if (made && made.length) best = made[0];
        }
      }
      if (!best) return false;

      if (A.tameNow) A.tameNow(best, null);
      else { best.tame = true; best.faction = 'player'; }

      var label = (best.kind && best.kind.label) || best.kindId;
      letter(g, 'An animal joins the colony',
        'A wild ' + label + ' has been hanging around the edge of the fields for days and ' +
        'has decided it lives here now. It is tame, and it is yours to feed.',
        'good', best);
      return true;
    }
  });

  var POD_DROPS = [
    { defId: 'steel', min: 40, max: 130, weight: 5 },
    { defId: 'silver', min: 90, max: 380, weight: 4 },
    { defId: 'components', min: 3, max: 9, weight: 2 },
    { defId: 'wood', min: 55, max: 160, weight: 4 },
    { defId: 'cloth', min: 30, max: 90, weight: 3 },
    { defId: 'mealSimple', min: 6, max: 20, weight: 3 },
    { defId: 'medicine', min: 3, max: 10, weight: 2 },
    { defId: 'herbalMedicine', min: 5, max: 16, weight: 2 }
  ];

  Incidents.register({
    id: 'cargoPods',
    label: 'cargo pods',
    category: 'good',
    minDay: 2,
    weight: function () { return 3; },
    fire: function (g) {
      var map = g.map;
      var MG = sys('MapGen');
      var spot = MG && MG.dropPodSpot ? MG.dropPodSpot(map) : null;
      if (!spot) {
        var c = colonyCentre(map);
        spot = freeCellNear(map, c.x + U.randInt(-10, 10), c.y + U.randInt(-10, 10), 14);
      }
      if (!spot) return false;

      var kinds = POD_DROPS.filter(function (d) { return Defs.has('thing', d.defId); });
      if (!kinds.length) return false;
      var n = U.randInt(1, 3), dropped = [], names = [];
      for (var i = 0; i < n; i++) {
        var pick = U.pickWeighted(kinds, function (d) { return d.weight; });
        if (names.indexOf(pick.defId) >= 0) continue;
        var count = U.randInt(pick.min, pick.max);
        var cell = freeCellNear(map, spot.x + U.randInt(-2, 2), spot.y + U.randInt(-2, 2), 6) || spot;
        var made = map.addItem(pick.defId, cell.x, cell.y, count);
        if (made && made.length) {
          dropped.push(count + ' ' + (Defs.thing(pick.defId).label || pick.defId));
          names.push(pick.defId);
        }
      }
      if (!dropped.length) return false;

      letter(g, 'Cargo pods',
        'Something broke up in orbit and its cargo came down in your fields: ' +
        dropped.join(', ') + '. It is sitting out there in the open until somebody hauls it in.',
        'good', spot);
      return true;
    }
  });

  Incidents.register({
    id: 'eclipse',
    label: 'eclipse',
    category: 'weather',
    minDay: 4,
    weight: function () { return 4; },
    fire: function (g) {
      var ticks = Math.round(U.randRange(0.8, 1.3) * TICKS_PER_DAY);
      g.weather.eclipseTicksLeft = Math.max(g.weather.eclipseTicksLeft, ticks);
      var c = colonyCentre(g.map);
      letter(g, 'Eclipse',
        'A moon has slid across the sun and the daylight has gone out of the sky. ' +
        'Solar panels are dead and nothing will grow until it passes, about a day from now.',
        'neutral', c);
      return true;
    }
  });

  Incidents.register({
    id: 'solarFlare',
    label: 'solar flare',
    category: 'weather',
    minDay: 8,
    weight: function (g) {
      var powered = countOfDefs(g.map, ['solarPanel', 'windTurbine', 'woodGenerator', 'battery']);
      return powered > 0 ? 3.5 : 0;
    },
    fire: function (g) {
      var ticks = Math.round(U.randRange(0.8, 1.4) * TICKS_PER_DAY);
      g.weather.flareTicksLeft = Math.max(g.weather.flareTicksLeft, ticks);
      var c = colonyCentre(g.map);
      letter(g, 'Solar flare',
        'The star has thrown a flare and every circuit in the colony has stopped. ' +
        'No power at all until it dies down - about a day. Whatever was in the freezer is on a clock now.',
        'threat', c);
      return true;
    }
  });

  Incidents.register({
    id: 'heatWave',
    label: 'heat wave',
    category: 'weather',
    minDay: 3,
    weight: function (g) {
      var s = g.season();
      if (s === 'winter') return 0.2;
      return s === 'summer' ? 5 : 2.5;
    },
    fire: function (g) {
      var ticks = Math.round(U.randRange(1.5, 3.2) * TICKS_PER_DAY);
      var delta = U.randRange(9, 17);
      g.weather.tempOffset = delta;
      g.weather.tempOffsetTicksLeft = ticks;
      var c = colonyCentre(g.map);
      letter(g, 'Heat wave',
        'A wall of hot air has settled over the region. It is ' + Math.round(delta) +
        ' degrees hotter than it should be, and it will stay that way for days. ' +
        'Keep people indoors and watch the food.',
        'threat', c);
      return true;
    }
  });

  Incidents.register({
    id: 'coldSnap',
    label: 'cold snap',
    category: 'weather',
    minDay: 3,
    weight: function (g) {
      var s = g.season();
      if (s === 'summer') return 0.2;
      return s === 'winter' ? 5 : 2.5;
    },
    fire: function (g) {
      var ticks = Math.round(U.randRange(1.5, 3.2) * TICKS_PER_DAY);
      var delta = U.randRange(12, 24);
      g.weather.tempOffset = -delta;
      g.weather.tempOffsetTicksLeft = ticks;
      var c = colonyCentre(g.map);
      letter(g, 'Cold snap',
        'The temperature has fallen off a cliff - ' + Math.round(delta) +
        ' degrees below the season, for days. Crops outside will not survive it, ' +
        'and neither will anyone caught out in it without a coat.',
        'threat', c);
      return true;
    }
  });

  Incidents.register({
    id: 'cropBlight',
    label: 'crop blight',
    category: 'threatSmall',
    minDay: 6,
    weight: function (g) {
      var field = biggestField(g.map);
      return field && field.count >= 8 ? 4 : 0;
    },
    fire: function (g) {
      var map = g.map, P = sys('Plants');
      var field = biggestField(map);
      if (!field || field.count < 4) return false;

      var hit = 0, where = null, before = g.letters.length;
      if (P && typeof P.blight === 'function') {
        hit = P.blight(map, field.def.id, { fraction: U.randRange(0.4, 0.8) }) | 0;
      } else {
        /* Without plants.js the flag still means something: it is on the
           Thing shape and the renderer reads it. */
        var list = U.shuffle(map.byDef(field.def.id).slice());
        var want = Math.max(1, Math.round(field.count * 0.6));
        for (var i = 0; i < list.length && hit < want; i++) {
          var pl = list[i];
          if (!pl.spawned || !pl.sown || pl.blighted) continue;
          pl.blighted = true;
          if (!where) where = pl;
          hit++;
        }
      }
      if (!hit) return false;

      /* plants.js announces a blight itself. Only speak if it did not. */
      if (g.letters.length === before) {
        letter(g, 'Blight',
          'A blight has taken hold in the ' + (field.def.label || field.def.id) +
          '. ' + hit + ' ' + U.plural(hit, 'plant') + ' have gone black at the stem and ' +
          'will not ripen. Cut them out before the rest of the field goes with them.',
          'threat', where || colonyCentre(map));
      }
      return true;
    }
  });

  Incidents.register({
    id: 'diseaseFlu',
    label: 'flu',
    category: 'threatSmall',
    minDay: 5,
    weight: function (g) {
      var H = sys('Health');
      if (!H || !H.addHediff) return 0;
      return g.map.colonists().length >= 2 ? 4 : 1;
    },
    fire: function (g) {
      var H = sys('Health');
      if (!H || !H.addHediff) return false;
      var pool = [];
      var list = g.map.colonists();
      for (var i = 0; i < list.length; i++) {
        if (H.hasHediff && H.hasHediff(list[i], 'flu')) continue;
        pool.push(list[i]);
      }
      if (!pool.length) return false;
      U.shuffle(pool);
      var n = Math.min(pool.length, pool.length > 2 ? U.randInt(1, 2) : 1);
      var names = [];
      for (i = 0; i < n; i++) {
        H.addHediff(pool[i], 'flu', U.randRange(0.04, 0.10));
        names.push(displayName(pool[i]));
      }
      var who = names.join(' and ');
      letter(g, 'Flu',
        who + (n > 1 ? ' have' : ' has') + ' come down with the flu. It will get worse before ' +
        'it gets better - bed rest and a doctor are what beats it, and an untended case can kill.',
        'threat', pool[0]);
      return true;
    }
  });

  Incidents.register({
    id: 'predatorAttack',
    label: 'predator attack',
    category: 'threatSmall',
    minDay: 3,
    weight: function (g) {
      var A = sys('Animals');
      if (!A || !A.makeManhunter) return 0;
      if (!g.map.colonists().length) return 0;
      /* One thing stalking the colony at a time. Two is not twice the
         tension, it is a zoo. */
      for (var i = 0; i < g.map.pawns.length; i++) {
        var p = g.map.pawns[i];
        if (p.isAnimal && !p.dead && A.isManhunter && A.isManhunter(p)) return 0;
      }
      return 2.2;
    },
    fire: function (g, points) {
      var map = g.map, A = sys('Animals');
      if (!A || !A.makeManhunter) return false;
      var victims = ableColonists(map);
      if (!victims.length) return false;
      var victim = U.pick(victims);

      /* Prefer a predator already on the map: one that has been prowling
         the treeline for days finally picking someone is better than a
         wolf teleporting in. */
      var pred = null, bestD = Infinity;
      for (var i = 0; i < map.pawns.length; i++) {
        var p = map.pawns[i];
        if (!p.isAnimal || p.dead || p.downed || p.tame) continue;
        if (p.faction !== 'wild') continue;
        if (!A.isPredator || !A.isPredator(p)) continue;
        if (A.isManhunter && A.isManhunter(p)) continue;
        var d = U.distSq(victim.x, victim.y, p.x, p.y);
        if (d < bestD) { bestD = d; pred = p; }
      }
      if (!pred && A.spawnWild) {
        var kindId = points > 200 && U.chance(0.4) ? 'bear' : 'wolf';
        var arrival = pickArrivalCells(map);
        if (arrival) {
          var made = A.spawnWild(map, kindId, arrival.anchor.x, arrival.anchor.y, 1);
          if (made && made.length) pred = made[0];
        }
      }
      if (!pred) return false;

      A.makeManhunter(pred, { target: victim, ticks: U.randInt(18000, 34000) });
      var label = (pred.kind && pred.kind.label) || pred.kindId;
      letter(g, 'Predator attack',
        'A ' + label + ' has come out of the trees and picked ' + displayName(victim) +
        ' out of the colony. It is hunting, and it will not be talked out of it.',
        'threat', pred);
      return true;
    }
  });

  /* Exposed for the UI and the harness: what can happen, and what the
     next thing to happen is scheduled for. */
  Storyteller.nextFireTicks = function () {
    var out = {}, st = Storyteller.state;
    for (var i = 0; i < Storyteller.CATEGORIES.length; i++) {
      var cat = Storyteller.CATEGORIES[i];
      out[cat] = st.next[cat];
    }
    return out;
  };

  root.Storyteller = Storyteller;
  root.Incidents = Incidents;
})(this);
