/* ============================================================
   workgivers.js - every work scan in the game.

   think.js decides that a colonist should be working; this file
   decides what. A work giver is a small scanner bound to one work
   type: asked about a pawn, it either hands back a Job aimed at
   something real or says nothing. Behaviour lives with the system
   that owns it - construct.js knows how to raise a frame - so
   nothing here does any work itself. It finds, it claims, it makes
   a Job, and it gets out of the way.

   Two rules shape all of it. The first is that this runs every time
   any colonist finishes anything, which on a busy map is dozens of
   times a second: no giver may walk the whole map, every scan goes
   through a maintained index, and anything a second pawn would ask
   for in the same tick is computed once and shared. The second is
   that a claim is taken before the job is handed over, never after.
   Two colonists walking thirty tiles to the same steel stack is the
   most visible failure a colony sim has, and the fix is to reserve
   at the moment of the decision.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Everything named here is above workgivers.js in the load order, so
     these bindings are safe; a giver that needs something further down
     asks for it by name at tick time instead. */
  var T = root.T;
  var Res = root.Res;
  var Jobs = root.Jobs;
  var Path = root.Path;
  var Regions = root.Regions;
  var Zones = root.Zones;

  function sys(name) { return root[name] || null; }

  function now() {
    var G = root.Game;
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  /* ---------- tuning ----------
     Radii are in tiles, spans in ticks (60 = one second, 60000 = a day). */

  var FIRE_WORK_RADIUS = 48;      /* how far a colonist will walk to a fire on purpose */
  var FIRE_EMERGENCY_RADIUS = 40; /* matches think.js's cheap emergency pre-check       */
  var MAX_FIREFIGHTERS = 3;       /* beyond this, another pair of hands adds nothing    */

  /* think.js uses this same number to decide an emergency is pending.
     If the two ever disagree, a colonist drops a crate for a patient
     this file then refuses to treat, and does it again next tick. */
  var EMERGENCY_BLEED = 0.12;
  var EMERGENCY_HOURS = 6;        /* or already so far gone that a slow leak finishes them */

  var BED_REST_TICKS = 2000;      /* a stint in bed before the pawn re-decides */
  var REFUEL_AT = 0.75;           /* top up below three quarters, not one log at a time */
  var FILTH_WORTH_CLEANING = 12;  /* a faint smear is not worth a walk */
  var CLEAN_RESCAN = 120;
  var REPAIR_RESCAN = 250;
  var HAUL_SCAN_LIMIT = 150;

  var MAX_PRIORITY = 4;

  /* ============================================================
     Shared scan cache

     Several colonists finish a job on the same tick and then walk the
     same givers in the same order. Each scan is therefore computed
     once per tick and shared. The table is thrown away the instant the
     clock moves, so a cached answer can never outlive the world that
     produced it - which matters, because these lists describe things
     other pawns are reserving as we read them.
     ============================================================ */

  function scans(map) {
    var c = map.__wgScans, t = now();
    if (!c || c.tick !== t) { c = { tick: t, data: Object.create(null) }; map.__wgScans = c; }
    return c.data;
  }

  function scan(map, key, compute) {
    var d = scans(map);
    var v = d[key];
    if (v === undefined) {
      v = compute(map);
      d[key] = (v === undefined) ? null : v;
    }
    return v;
  }

  /* For scans that are expensive and describe something that changes
     slowly - blood on a floor, a cracked wall. Held across ticks and
     re-validated by the giver at the moment of use, which is cheap. */
  function slowScan(map, key, ttl, compute) {
    var tbl = map.__wgSlow || (map.__wgSlow = Object.create(null));
    var e = tbl[key], t = now();
    /* t < e.tick catches a loaded save winding the clock backwards. */
    if (!e || t < e.tick || t - e.tick >= ttl) {
      e = { tick: t, value: compute(map) };
      tbl[key] = e;
    }
    return e.value;
  }

  /* ============================================================
     Small shared predicates
     ============================================================ */

  function isHuman(pawn) { return !!pawn && pawn.isHuman === true; }

  function priorityOf(pawn, workTypeId) {
    if (typeof pawn.priorityOf === 'function') return pawn.priorityOf(workTypeId);
    var p = pawn.workPriority && pawn.workPriority[workTypeId];
    return p === undefined ? 0 : p;
  }

  function capable(pawn, workTypeId) {
    if (typeof pawn.capable === 'function') return pawn.capable(workTypeId);
    return priorityOf(pawn, workTypeId) > 0 && !pawn.dead && !pawn.downed;
  }

  function skillLevel(pawn, id) {
    var s = pawn && pawn.skills && pawn.skills[id];
    return (s && typeof s.level === 'number') ? s.level : 0;
  }

  /* Nobody else is holding it. Asked before any path is run, because a
     reservation is one hash lookup and a path is thousands. */
  function freeFor(pawn, target) {
    return !!target && Res.canReserve(pawn, target, 1);
  }

  function areaAt(map, x, y) {
    return map.inBounds(x, y) ? Regions.areaOf(map, x, y) : 0;
  }

  /* The area a pawn works from. Normally the cell under their feet, but
     a colonist can end up inside something impassable - a wall raised on
     their own tile by the frame they were building, a roof that fell in
     - and then the open cells they are about to step into are the honest
     answer. The pathfinder already copes with such a start; without this
     the cheap pre-filter above it would refuse every candidate and the
     pawn would stand there doing nothing until somebody moved them. */
  function pawnArea(map, pawn) {
    var a = areaAt(map, pawn.x, pawn.y);
    if (a) return a;
    for (var k = 0; k < U.ADJ8.length; k++) {
      a = areaAt(map, pawn.x + U.ADJ8[k][0], pawn.y + U.ADJ8[k][1]);
      if (a) return a;
    }
    return 0;
  }

  /* The O(1) half of "can this pawn get there": area labels, no search.
     An impassable target - a rock face, a workbench - is judged by the
     cells a pawn could stand on to touch it, because that is where the
     pathfinder would put them. */
  function inReach(map, pawn, x, y) {
    if (!map.inBounds(x, y)) return false;
    var from = pawnArea(map, pawn);
    if (!from) return false;
    if (areaAt(map, x, y) === from) return true;
    if (map.passable(x, y)) return false;
    for (var k = 0; k < U.ADJ8.length; k++) {
      if (areaAt(map, x + U.ADJ8[k][0], y + U.ADJ8[k][1]) === from) return true;
    }
    return false;
  }

  /* The one place a giver turns a candidate list into a choice. Path
     probes the list in rough-distance order and stops early, so the
     scoring function is only ever asked about the near end of it. */
  function nearest(pawn, list, scoreFn) {
    if (!list || !list.length) return null;
    if (!Path || !Path.closestReachable) return list[0];
    return Path.closestReachable(pawn.map, pawn, list, scoreFn);
  }

  function makeJob(defId, a, b, opts) {
    if (!Jobs || !Jobs.isRegistered || !Jobs.isRegistered(defId)) return null;
    return Jobs.make(defId, a || null, b || null, opts);
  }

  /* Claim it, then hand over the job. If the claim fails the candidate
     was taken between the filter and here, and saying nothing is the
     honest answer - the pawn asks again next tick. */
  function claimed(pawn, defId, target, b, opts) {
    if (!Res.reserve(pawn, target, 1)) return null;
    var job = makeJob(defId, target, b, opts);
    if (!job) Res.release(pawn, target);
    return job;
  }

  function isBed(thing) {
    return !!(thing && thing.def && thing.def.building && thing.def.building.isBed);
  }

  function inBed(pawn) {
    var b = pawn.map.buildingAt(pawn.x, pawn.y);
    return isBed(b);
  }

  /* ---------- cached def lists ----------
     Defs never change after load, so each of these is built once and
     then used to walk map.byDef rather than map.things. */

  var _defLists = Object.create(null);

  function defIdsWhere(key, test) {
    var list = _defLists[key];
    if (list) return list;
    list = [];
    var all = Defs.all('thing');
    for (var i = 0; i < all.length; i++) if (test(all[i])) list.push(all[i].id);
    _defLists[key] = list;
    return list;
  }

  function fuelledDefIds() {
    return defIdsWhere('fuelled', function (d) {
      return !!(d.building && d.building.fuelDefId && d.building.fuelCapacity > 0);
    });
  }

  function benchDefIds() {
    return defIdsWhere('bench', function (d) {
      return !!(d.building && d.building.isWorkbench);
    });
  }

  /* Anything a flick switch would mean something for: it makes power,
     stores it, or draws it. */
  function switchableDefIds() {
    return defIdsWhere('switchable', function (d) {
      var b = d.building;
      return !!(b && (b.isGenerator || b.isBattery || b.powerConsumed > 0));
    });
  }

  function repairableDefIds() {
    return defIdsWhere('repairable', function (d) {
      return d.category === 'building' && !!d.buildCategory && !d.natural && !d.mineable;
    });
  }

  /* Every live Thing of any def in a list, in one array. */
  function thingsOfDefs(map, defIds) {
    var out = [];
    for (var i = 0; i < defIds.length; i++) {
      var list = map.byDef(defIds[i]);
      for (var k = 0; k < list.length; k++) if (list[k].spawned) out.push(list[k]);
    }
    return out;
  }

  /* ============================================================
     The registry
     ============================================================ */

  var WorkGivers = {};

  var EMPTY = [];
  var givers = [];
  var byType = Object.create(null);
  var byId = Object.create(null);
  var _workTypes = null;

  WorkGivers.register = function (spec) {
    if (!spec || !spec.id || !spec.workType) throw new Error('work giver needs an id and a workType');
    if (byId[spec.id]) throw new Error('duplicate work giver ' + spec.id);
    var giver = {
      id: spec.id,
      workType: spec.workType,
      order: spec.order === undefined ? 100 : spec.order,
      tryGiveJob: spec.tryGiveJob,
      scanCells: !!spec.scanCells,
      label: spec.label || spec.id
    };
    givers.push(giver);
    byId[giver.id] = giver;
    var list = byType[giver.workType] || (byType[giver.workType] = []);
    list.push(giver);
    list.sort(function (a, b) { return a.order - b.order || (a.id < b.id ? -1 : 1); });
    return giver;
  };

  WorkGivers.forType = function (workTypeId) { return byType[workTypeId] || EMPTY; };
  WorkGivers.all = function () { return givers; };
  WorkGivers.get = function (id) { return byId[id] || null; };

  /* Work types in their def order, which is the Work tab's column order
     and therefore the order a colonist falls down looking for something
     to do inside one priority band. */
  function workTypes() {
    if (!_workTypes) _workTypes = Defs.all('workType').slice();
    return _workTypes;
  }

  /* A giver that throws would freeze one colonist forever and, through
     the think tree, look like the whole colony had stopped. The scan is
     skipped and the pawn falls through to the next giver; behind
     Game.debug the failure is printed rather than swallowed. */
  function runGiver(giver, pawn) {
    try {
      return giver.tryGiveJob(pawn) || null;
    } catch (e) {
      var G = root.Game;
      if (G && G.debug) console.log('[workgivers] ' + giver.id + ' threw: ' + (e && e.stack || e));
      return null;
    }
  }

  /* A job that failed to start leaves its claim behind, and a pawn
     standing idle with a claim on a steel stack is a stack nobody else
     can have. A pawn asking for work is, by definition, holding
     nothing and going nowhere, so this is the safe moment to let go. */
  function releaseStaleClaims(pawn) {
    if (pawn.job || pawn.carried || pawn.carriedPawn) return;
    if (pawn.jobQueue && pawn.jobQueue.length) return;
    Res.releaseAll(pawn);
  }

  WorkGivers.tryGiveWorkJob = function (pawn) {
    if (!T || !Res || !Jobs || !Regions) return null;
    if (!pawn || !pawn.map || pawn.dead || pawn.downed || !isHuman(pawn)) return null;
    if (pawn.drafted || pawn.mentalState) return null;

    releaseStaleClaims(pawn);

    var types = workTypes();
    for (var prio = 1; prio <= MAX_PRIORITY; prio++) {
      for (var i = 0; i < types.length; i++) {
        var wt = types[i];
        if (priorityOf(pawn, wt.id) !== prio) continue;
        if (!capable(pawn, wt.id)) continue;
        var list = byType[wt.id];
        if (!list) continue;
        for (var g = 0; g < list.length; g++) {
          var job = runGiver(list[g], pawn);
          if (job) return job;
        }
      }
    }
    return null;
  };

  /* Dropped by save.js on load, and by anything that rearranges the map
     wholesale. Cached scans describe a world that no longer exists. */
  WorkGivers.invalidate = function (map) {
    if (!map) return;
    map.__wgScans = null;
    map.__wgSlow = null;
  };

  /* ============================================================
     Emergencies

     Checked before ordinary work, by think.js, and deliberately narrow:
     the only two things worth making every colonist on the map drop
     what they are holding are a fire inside the base and somebody
     bleeding to death.
     ============================================================ */

  function liveFires(map) {
    return scan(map, 'fires', function () {
      var all = map.byDef('fire'), out = [];
      for (var i = 0; i < all.length; i++) if (all[i].spawned) out.push(all[i]);
      return out;
    });
  }

  /* How many colonists are already beating this particular fire. A
     fire carries no reservation on purpose - three people on one blaze
     is the right answer - but the fourth is just standing in the way
     of the next fire along. */
  function fireCrews(map) {
    /* Not cached with the other scans: every colonist in the colony is
       asked this in the same tick, one after another, and each one's
       answer has to include the ones that said yes a moment ago. A walk
       of the pawn list is tens of entries, not thousands of tiles. */
    var counts = Object.create(null), pawns = map.pawns;
    for (var i = 0; i < pawns.length; i++) {
      var j = pawns[i].job;
      if (!j || j.defId !== 'extinguishFire' || !j.targetA || j.targetA.k !== 't') continue;
      counts[j.targetA.id] = (counts[j.targetA.id] || 0) + 1;
    }
    return counts;
  }

  /* Inside the colony rather than out in the woods: a roofed room, or
     a tile touching something the player built. A grass fire forty
     tiles away is weather; a fire against a wall is an emergency. */
  function threatensColony(map, fire) {
    var room = Regions.roomAt(map, fire.x, fire.y);
    if (room && room.id > 0 && !room.outdoor) return true;
    for (var k = 0; k < U.ADJ8.length; k++) {
      var x = fire.x + U.ADJ8[k][0], y = fire.y + U.ADJ8[k][1];
      if (!map.inBounds(x, y)) continue;
      var b = map.buildingAt(x, y);
      if (b && b.faction === 'player' && !b.isBlueprint) return true;
      if (map.zoneId && map.zoneId[map.idx(x, y)]) return true;
    }
    return false;
  }

  function fireJobFor(pawn, radius, requireColony) {
    var map = pawn.map;
    var fires = liveFires(map);
    if (!fires.length) return null;
    var crews = fireCrews(map);
    var cands = [];
    for (var i = 0; i < fires.length; i++) {
      var f = fires[i];
      if (U.dist(pawn.x, pawn.y, f.x, f.y) > radius) continue;
      if ((crews[f.id] || 0) >= MAX_FIREFIGHTERS) continue;
      if (requireColony && !threatensColony(map, f)) continue;
      if (!inReach(map, pawn, f.x, f.y)) continue;
      cands.push(f);
    }
    var fire = nearest(pawn, cands, function (f, d) {
      /* A fire already burning big is the one that spreads. */
      return (f.growth || 0) * 6 - d;
    });
    return fire ? makeJob('extinguishFire', T.thing(fire)) : null;
  }

  /* Days of blood left divided by the rate it is leaving, in hours.
     Infinity when nothing is bleeding, which reads correctly at every
     call site below. */
  function hoursToBleedOut(pawn) {
    var H = sys('Health');
    if (!H || !H.bleedRate) return Infinity;
    var rate = H.bleedRate(pawn);
    if (!(rate > 0)) return Infinity;
    var left = 1 - ((pawn.health && pawn.health.bloodLoss) || 0);
    if (left <= 0) return 0;
    return (left / rate) * 24;
  }

  function dyingOfBloodLoss(pawn) {
    var H = sys('Health');
    if (!H || !H.needsTending || !H.needsTending(pawn)) return false;
    /* Two readings of "about to die", because either alone misses a
       real case: a fresh arterial wound bleeds fast with a full tank,
       and a pawn at nine tenths blood loss dies to a trickle. */
    return H.bleedRate(pawn) >= EMERGENCY_BLEED || hoursToBleedOut(pawn) < EMERGENCY_HOURS;
  }

  function doctorScore(pawn) {
    return skillLevel(pawn, 'medicine') * 10 - (priorityOf(pawn, 'doctor') - 1) * 3;
  }

  function busyDoctoring(pawn) {
    var id = pawn.job && pawn.job.defId;
    return id === 'tendPatient' || id === 'rescue' || id === 'feedPatient';
  }

  /* Who should be treating this patient. Everyone who could is ranked
     the same way, so every colonist asking the question agrees on the
     answer and exactly one of them walks over. */
  function bestDoctorFor(map, patient, includeSelf) {
    var list = map.colonists ? map.colonists() : map.pawns;
    var best = null, bestScore = -Infinity;
    for (var i = 0; i < list.length; i++) {
      var d = list[i];
      if (d.dead || d.downed || d.drafted || d.mentalState) continue;
      if (!isHuman(d) || !capable(d, 'doctor')) continue;
      if (d === patient && !includeSelf) continue;
      if (busyDoctoring(d) && d.job.targetA && d.job.targetA.id !== patient.id) continue;
      if (!inReach(map, d, patient.x, patient.y)) continue;
      var s = doctorScore(d);
      /* A stable tiebreak, so two equally good doctors do not both
         decide the other one has it. */
      if (s > bestScore || (s === bestScore && best && d.id < best.id)) { best = d; bestScore = s; }
    }
    return best;
  }

  function emergencyTendJob(pawn) {
    var map = pawn.map;
    if (!capable(pawn, 'doctor')) return null;
    var H = sys('Health');
    if (!H) return null;

    var list = map.colonists ? map.colonists() : map.pawns;
    var worst = null, worstScore = 0;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.dead || !dyingOfBloodLoss(p)) continue;
      if (p !== pawn && !freeFor(pawn, T.pawn(p))) continue;
      if (!inReach(map, pawn, p.x, p.y)) continue;
      if (bestDoctorFor(map, p, p === pawn) !== pawn) continue;
      var s = H.tendPriority ? H.tendPriority(p) : 1;
      if (s > worstScore) { worst = p; worstScore = s; }
    }
    if (!worst) return null;
    if (worst === pawn) return makeJob('tendPatient', T.pawn(pawn));
    return claimed(pawn, 'tendPatient', T.pawn(worst));
  }

  WorkGivers.emergency = function (pawn) {
    if (!T || !Res || !Jobs || !Regions) return null;
    if (!pawn || !pawn.map || pawn.dead || pawn.downed || !isHuman(pawn)) return null;
    if (pawn.drafted || pawn.mentalState) return null;

    if (capable(pawn, 'firefight')) {
      var fire = fireJobFor(pawn, FIRE_EMERGENCY_RADIUS, true);
      if (fire) return fire;
    }
    return emergencyTendJob(pawn);
  };

  /* ============================================================
     firefight
     ============================================================ */

  WorkGivers.register({
    id: 'firefightNearby', workType: 'firefight', order: 10,
    label: 'extinguish fire',
    tryGiveJob: function (pawn) {
      /* Outside the emergency path a colonist will also put out a fire
         in the open, as long as it is not across the map. */
      return fireJobFor(pawn, FIRE_WORK_RADIUS, false);
    }
  });

  /* ============================================================
     patient / bedRest

     Two work types, one behaviour: get into a bed and stay there. The
     difference is why - patient is "a doctor needs me to hold still",
     bedRest is "I am in no state to be up".
     ============================================================ */

  function bedJobFor(pawn) {
    var J = sys('Jobs');
    if (!J || !J.findBed) return null;
    var bed = J.findBed(pawn.map, pawn, { realBedOnly: false });
    if (!bed) return null;
    return claimed(pawn, 'layDown', T.thing(bed), null,
      { count: BED_REST_TICKS, state: { asleep: false } });
  }

  WorkGivers.register({
    id: 'patientGoToBed', workType: 'patient', order: 10,
    label: 'go to bed for treatment',
    tryGiveJob: function (pawn) {
      var H = sys('Health');
      if (!H || !H.needsTending || !H.needsTending(pawn)) return null;
      if (inBed(pawn)) return null;
      /* Lying down for a doctor who does not exist is just lying down.
         The pawn keeps working, and bedRest still catches them if the
         wound is bad enough to matter. */
      if (!bestDoctorFor(pawn.map, pawn, false)) return null;
      return bedJobFor(pawn);
    }
  });

  WorkGivers.register({
    id: 'patientBedRest', workType: 'bedRest', order: 10,
    label: 'rest in bed',
    tryGiveJob: function (pawn) {
      if (inBed(pawn)) return null;
      if (!shouldBedRest(pawn)) return null;
      return bedJobFor(pawn);
    }
  });

  /* Hurt or sick enough that walking to the mine makes it worse.
     Deliberately not "has any scratch": a colonist who goes to bed over
     a bruise never builds anything. */
  function shouldBedRest(pawn) {
    var h = pawn.health;
    if (!h) return false;
    if (h.bloodLoss > 0.20) return true;
    var H = sys('Health');
    if (H && H.painLevel && H.painLevel(pawn) > 0.30) return true;
    var i;
    for (i = 0; i < h.hediffs.length; i++) {
      var hd = h.hediffs[i];
      var def = hd.def || {};
      if ((def.isDisease || def.immunizable) && hd.severity > 0.1) return true;
    }
    for (i = 0; i < h.injuries.length; i++) {
      var inj = h.injuries[i];
      if (inj.permanent) continue;
      if (inj.bleedRate > 0 && !inj.tended) return true;
      if (inj.infection > 0.1) return true;
    }
    return false;
  }

  /* ============================================================
     doctor
     ============================================================ */

  /* Everyone a colony doctor is responsible for: colonists and the
     colony's own animals. Built from map.colonists and the pawn list
     once a tick, because every doctor giver wants the same set. */
  function patientsNeedingTending(map) {
    return scan(map, 'patients', function () {
      var H = sys('Health');
      if (!H || !H.needsTending) return [];
      var out = [], seen = Object.create(null);
      var list = map.colonists ? map.colonists() : [];
      var i, p;
      for (i = 0; i < list.length; i++) {
        p = list[i];
        if (!p.dead && H.needsTending(p)) { out.push(p); seen[p.id] = 1; }
      }
      for (i = 0; i < map.pawns.length; i++) {
        p = map.pawns[i];
        if (seen[p.id] || p.dead || p.faction !== 'player') continue;
        if (!p.isAnimal || !p.tame) continue;
        if (H.needsTending(p)) out.push(p);
      }
      return out;
    });
  }

  function downedColonyPawns(map) {
    return scan(map, 'downed', function () {
      var out = [], pawns = map.pawns;
      for (var i = 0; i < pawns.length; i++) {
        var p = pawns[i];
        if (p.dead || p.faction !== 'player') continue;
        if (!p.downed) continue;
        if (p.carriedBy) continue;
        out.push(p);
      }
      return out;
    });
  }

  WorkGivers.register({
    id: 'doctorTendOther', workType: 'doctor', order: 10,
    label: 'tend patient',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var H = sys('Health');
      if (!H || !H.tendPriority) return null;
      var all = patientsNeedingTending(map), cands = [];
      for (var i = 0; i < all.length; i++) {
        var p = all[i];
        if (p === pawn) continue;
        if (!freeFor(pawn, T.pawn(p))) continue;
        if (!inReach(map, pawn, p.x, p.y)) continue;
        cands.push(p);
      }
      var patient = nearest(pawn, cands, function (p, d) {
        return H.tendPriority(p) * 4 - d;
      });
      return patient ? claimed(pawn, 'tendPatient', T.pawn(patient)) : null;
    }
  });

  WorkGivers.register({
    id: 'doctorRescue', workType: 'doctor', order: 20,
    label: 'rescue the downed',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var J = sys('Jobs');
      if (!J || !J.findBed) return null;
      var all = downedColonyPawns(map), cands = [];
      for (var i = 0; i < all.length; i++) {
        var p = all[i];
        if (p === pawn) continue;
        if (isBed(map.buildingAt(p.x, p.y))) continue;
        if (!freeFor(pawn, T.pawn(p))) continue;
        if (!inReach(map, pawn, p.x, p.y)) continue;
        /* No bed means the rescue job would walk over and then fail,
           and a colonist who fails the same job forever is worse than
           one who leaves the body where it fell. */
        if (!J.findBed(map, p, { realBedOnly: false })) continue;
        cands.push(p);
      }
      var victim = nearest(pawn, cands, function (p, d) {
        var bleeding = hoursToBleedOut(p);
        return (bleeding < 24 ? (24 - bleeding) * 3 : 0) + (p.isHuman ? 25 : 0) - d;
      });
      return victim ? claimed(pawn, 'rescue', T.pawn(victim)) : null;
    }
  });

  WorkGivers.register({
    id: 'doctorTendSelf', workType: 'doctor', order: 30,
    label: 'tend self',
    tryGiveJob: function (pawn) {
      var H = sys('Health');
      if (!H || !H.needsTending || !H.needsTending(pawn)) return null;
      /* Somebody better is coming. Self-tending in front of them wastes
         medicine and gets a worse result. */
      var best = bestDoctorFor(pawn.map, pawn, true);
      if (best && best !== pawn) return null;
      return makeJob('tendPatient', T.pawn(pawn));
    }
  });

  /* Flat on their back and hungry: they cannot get up, so somebody has
     to bring it to them. */
  function needsFeeding(pawn, patient) {
    if (patient === pawn || patient.dead) return false;
    if (patient.faction !== 'player') return false;
    if (!patient.needs || patient.needs.food >= 0.30) return false;
    if (patient.downed) return true;
    var H = sys('Health');
    if (H && H.capacity && H.capacity(patient, 'moving') < 0.2) return true;
    return false;
  }

  WorkGivers.register({
    id: 'doctorFeedPatient', workType: 'doctor', order: 40,
    label: 'feed patient',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var pawns = map.pawns, cands = [];
      for (var i = 0; i < pawns.length; i++) {
        var p = pawns[i];
        if (!needsFeeding(pawn, p)) continue;
        if (!freeFor(pawn, T.pawn(p))) continue;
        if (!inReach(map, pawn, p.x, p.y)) continue;
        cands.push(p);
      }
      if (!cands.length) return null;
      /* One food search for the whole scan rather than one per patient:
         if the larder is empty, none of them can be fed. */
      var J = sys('Jobs');
      if (!J || !J.findFood || !J.findFood(map, pawn, { forOther: true })) return null;
      var patient = nearest(pawn, cands, function (p, d) {
        return (1 - p.needs.food) * 30 - d;
      });
      return patient ? claimed(pawn, 'feedPatient', T.pawn(patient)) : null;
    }
  });

  WorkGivers.register({
    id: 'doctorBury', workType: 'doctor', order: 50,
    label: 'bury the dead',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var J = sys('Jobs');
      if (!J || !J.graveIsFree) return null;

      var graves = map.byDef('grave'), free = false;
      for (var g = 0; g < graves.length; g++) {
        if (J.graveIsFree(graves[g]) && freeFor(pawn, T.thing(graves[g]))) { free = true; break; }
      }
      if (!free) return null;

      var corpses = map.byDef('corpse'), cands = [];
      for (var i = 0; i < corpses.length; i++) {
        var c = corpses[i];
        if (!c.spawned || c.buried) continue;
        if (!freeFor(pawn, T.thing(c))) continue;
        if (!inReach(map, pawn, c.x, c.y)) continue;
        cands.push(c);
      }
      var corpse = nearest(pawn, cands, function (c, d) {
        /* Our own dead first. A raider can wait in the rain. */
        var ours = c.corpse && c.corpse.faction === 'player';
        return (ours ? 60 : 0) - d;
      });
      return corpse ? claimed(pawn, 'bury', T.thing(corpse)) : null;
    }
  });

  /* ============================================================
     basic
     ============================================================ */

  function fuelShortfall(thing) {
    var b = thing.def.building;
    var cap = b.fuelCapacity;
    var have = typeof thing.fuel === 'number' ? thing.fuel : 0;
    if (have >= cap * REFUEL_AT) return 0;
    return Math.floor(cap - have);
  }

  /* Is there any of this fuel loose on the map at all. Asked once per
     def per tick, because the answer is the same for every hauler. */
  function fuelAvailable(map, pawn, fuelDefId) {
    var stacks = map.byDef(fuelDefId);
    for (var i = 0; i < stacks.length; i++) {
      var s = stacks[i];
      if (s.spawned && s.stack > 0 && freeFor(pawn, T.thing(s))) return true;
    }
    return false;
  }

  WorkGivers.register({
    id: 'basicRefuel', workType: 'basic', order: 10,
    label: 'refuel',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var burners = scan(map, 'fuelled', function () {
        return thingsOfDefs(map, fuelledDefIds());
      });
      if (!burners.length) return null;

      var cands = [], checked = Object.create(null);
      for (var i = 0; i < burners.length; i++) {
        var b = burners[i];
        if (b.switchOff) continue;
        if (fuelShortfall(b) <= 0) continue;
        if (!freeFor(pawn, T.thing(b))) continue;
        if (!inReach(map, pawn, b.x, b.y)) continue;
        var fuelId = b.def.building.fuelDefId;
        if (checked[fuelId] === undefined) checked[fuelId] = fuelAvailable(map, pawn, fuelId);
        if (!checked[fuelId]) continue;
        cands.push(b);
      }
      var target = nearest(pawn, cands, function (b, d) {
        /* An empty campfire is dark and cold; a half-full one is not. */
        var cap = b.def.building.fuelCapacity;
        return (1 - (b.fuel || 0) / cap) * 40 - d;
      });
      return target ? claimed(pawn, 'refuel', T.thing(target)) : null;
    }
  });

  WorkGivers.register({
    id: 'basicFlick', workType: 'basic', order: 20,
    label: 'flick switch',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var switches = scan(map, 'flickWanted', function () {
        var all = thingsOfDefs(map, switchableDefIds()), out = [];
        for (var i = 0; i < all.length; i++) {
          if (all[i].flickWanted && all[i].faction === 'player') out.push(all[i]);
        }
        return out;
      });
      var cands = [];
      for (var i = 0; i < switches.length; i++) {
        var s = switches[i];
        if (!s.flickWanted) continue;
        if (!freeFor(pawn, T.thing(s))) continue;
        if (!inReach(map, pawn, s.x, s.y)) continue;
        cands.push(s);
      }
      var target = nearest(pawn, cands, null);
      return target ? claimed(pawn, 'flick', T.thing(target)) : null;
    }
  });

  /* ============================================================
     handle
     ============================================================ */

  function designatedAnimals(map, type) {
    return scan(map, 'animals:' + type, function () {
      var A = sys('Animals');
      if (A && A.designated) return A.designated(map, type);
      var out = [], pawns = map.pawns;
      for (var i = 0; i < pawns.length; i++) {
        var p = pawns[i];
        if (p.isAnimal && !p.dead && p.designated === type) out.push(p);
      }
      return out;
    });
  }

  function animalJobGiver(id, order, type, jobId, valid) {
    WorkGivers.register({
      id: id, workType: 'handle', order: order, label: jobId,
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        var list = designatedAnimals(map, type), cands = [];
        for (var i = 0; i < list.length; i++) {
          var a = list[i];
          if (valid && !valid(a, pawn)) continue;
          if (!freeFor(pawn, T.pawn(a))) continue;
          if (!inReach(map, pawn, a.x, a.y)) continue;
          cands.push(a);
        }
        var animal = nearest(pawn, cands, null);
        return animal ? claimed(pawn, jobId, T.pawn(animal)) : null;
      }
    });
  }

  animalJobGiver('handleTame', 10, 'tame', 'tame', function (a) {
    var A = sys('Animals');
    return A && A.canTame ? A.canTame(a) : (!a.tame && a.faction !== 'player');
  });

  animalJobGiver('handleSlaughter', 30, 'slaughter', 'slaughter', function (a) {
    var A = sys('Animals');
    return A && A.canSlaughter ? A.canSlaughter(a) : (a.tame && a.faction === 'player');
  });

  /* Training is not designated - every tame animal that still has a
     lesson to learn wants one - so it scans the colony's own beasts
     rather than the designation table. */
  WorkGivers.register({
    id: 'handleTrain', workType: 'handle', order: 20,
    label: 'train animal',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var A = sys('Animals');
      if (!A || !A.trainingNeeded) return null;
      var trainees = scan(map, 'trainable', function () {
        var out = [], pawns = map.pawns;
        for (var i = 0; i < pawns.length; i++) {
          var a = pawns[i];
          if (!a.isAnimal || a.dead || !a.tame || a.faction !== 'player') continue;
          if (!A.trainingNeeded(a)) continue;
          out.push(a);
        }
        return out;
      });
      var cands = [];
      for (var k = 0; k < trainees.length; k++) {
        var a = trainees[k];
        if (!A.trainingNeeded(a)) continue;
        if (!freeFor(pawn, T.pawn(a))) continue;
        if (!inReach(map, pawn, a.x, a.y)) continue;
        cands.push(a);
      }
      var animal = nearest(pawn, cands, null);
      return animal ? claimed(pawn, 'trainAnimal', T.pawn(animal)) : null;
    }
  });

  /* ============================================================
     cook / craft - bills at a bench

     One implementation, two work types, because a bill knows which
     column it belongs to: recipe.workType is 'cook' for the stove and
     the butcher table and 'craft' for everything else.
     ============================================================ */

  function benches(map) {
    return scan(map, 'benches', function () { return thingsOfDefs(map, benchDefIds()); });
  }

  function canDoRecipe(pawn, recipe) {
    if (!recipe) return false;
    var need = recipe.skillRequirement || 0;
    if (need > 0 && recipe.skill && skillLevel(pawn, recipe.skill) < need) return false;
    return true;
  }

  /* Cheap test, run on every bench before any ingredient search: does
     this bench even carry a bill in this column that this pawn could
     do. Only benches that pass are worth the expensive question. */
  function benchHasBillFor(pawn, bench, workTypeId) {
    var bills = bench.bills;
    if (!bills || !bills.length) return false;
    for (var i = 0; i < bills.length; i++) {
      var bill = bills[i];
      if (bill.suspended) continue;
      var recipe = Defs.maybe('recipe', bill.recipeId);
      if (!recipe || (recipe.workType || 'craft') !== workTypeId) continue;
      if (!canDoRecipe(pawn, recipe)) continue;
      return true;
    }
    return false;
  }

  function billJobFor(pawn, workTypeId) {
    var map = pawn.map;
    var P = sys('Production');
    if (!P || !P.billsReady) return null;

    var all = benches(map), cands = [];
    for (var i = 0; i < all.length; i++) {
      var b = all[i];
      if (!P.benchUsable(b)) continue;
      if (b.faction && b.faction !== 'player') continue;
      if (!freeFor(pawn, T.thing(b))) continue;
      if (!benchHasBillFor(pawn, b, workTypeId)) continue;
      if (!inReach(map, pawn, b.x, b.y)) continue;
      cands.push(b);
    }
    if (!cands.length) return null;

    /* billsReady runs the ingredient search, which is the expensive
       part; it is asked only about benches the pathfinder has already
       agreed are close and reachable, and it stops early. */
    var chosen = Object.create(null);
    var bench = nearest(pawn, cands, function (b, d) {
      var ready = P.billsReady(b, pawn);
      for (var k = 0; k < ready.length; k++) {
        var recipe = Defs.maybe('recipe', ready[k].recipeId);
        if (!recipe || (recipe.workType || 'craft') !== workTypeId) continue;
        if (!canDoRecipe(pawn, recipe)) continue;
        chosen[b.id] = ready[k];
        return -d;
      }
      return null;
    });
    if (!bench) return null;
    var bill = chosen[bench.id];
    if (!bill) return null;
    /* The bench is claimed here; doBill's own plan claims the
       ingredients when the job starts. */
    return claimed(pawn, 'doBill', T.thing(bench), null, { bill: bill });
  }

  WorkGivers.register({
    id: 'cookBills', workType: 'cook', order: 10, label: 'cook',
    tryGiveJob: function (pawn) { return billJobFor(pawn, 'cook'); }
  });

  WorkGivers.register({
    id: 'craftBills', workType: 'craft', order: 10, label: 'craft',
    tryGiveJob: function (pawn) { return billJobFor(pawn, 'craft'); }
  });

  /* ============================================================
     hunt
     ============================================================ */

  WorkGivers.register({
    id: 'huntDesignated', workType: 'hunt', order: 10,
    label: 'hunt',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var list = designatedAnimals(map, 'hunt'), cands = [];
      for (var i = 0; i < list.length; i++) {
        var a = list[i];
        if (a.dead) continue;
        if (!freeFor(pawn, T.pawn(a))) continue;
        if (!inReach(map, pawn, a.x, a.y)) continue;
        cands.push(a);
      }
      var A = sys('Animals');
      var range = (A && A.huntRange) ? A.huntRange(pawn) : 0;
      var prey = nearest(pawn, cands, function (a, d) {
        /* Walking up to a bear with a knife is how a hunter dies, so a
           hunter with no reach prefers something small. */
        var risk = (A && A.info) ? (A.info(a.kindId).bodySize || 1) : 1;
        return (range >= 2 ? 0 : -risk * 12) - d;
      });
      return prey ? claimed(pawn, 'hunt', T.pawn(prey)) : null;
    }
  });

  /* ============================================================
     construct
     ============================================================ */

  function ghosts(map) {
    return scan(map, 'ghosts', function () {
      var C = sys('Construct');
      if (!C || !C.buildTargets) return [];
      var all = C.buildTargets(map), out = [];
      for (var i = 0; i < all.length; i++) {
        if (all[i].spawned && all[i].faction !== 'raider') out.push(all[i]);
      }
      return out;
    });
  }

  /* What is already walking towards each ghost. Without this, a wall
     needing five steel gets five steel from three different colonists
     and two of them arrive to find nothing to deliver. */
  function deliveriesEnRoute(map) {
    /* Live, for the same reason as fireCrews: two builders asked in one
       tick must not both be sent with the last five steel. */
    var out = Object.create(null), pawns = map.pawns;
    for (var i = 0; i < pawns.length; i++) {
      var p = pawns[i], j = p.job;
      if (!j || j.defId !== 'construct' || !j.targetA || !j.targetB) continue;
      var src = T.resolve(j.targetB, map) || p.carried;
      if (!src) continue;
      var per = out[j.targetA.id] || (out[j.targetA.id] = Object.create(null));
      var n = j.count > 0 ? j.count : (src.stack || 0);
      per[src.defId] = (per[src.defId] || 0) + n;
    }
    return out;
  }

  /* What this ghost is still short of, once everything already walking
     towards it is subtracted. `enRoute` is built once per scan and
     passed down, so the pawn list is walked once rather than once per
     blueprint on the map. */
  function stillNeeded(ghost, enRoute) {
    var C = sys('Construct');
    if (!C || !C.materialsNeeded) return null;
    var need = C.materialsNeeded(ghost);
    var coming = enRoute[ghost.id];
    var out = null;
    for (var k in need) {
      var short = need[k] - ((coming && coming[k]) || 0);
      if (short > 0) { if (!out) out = {}; out[k] = short; }
    }
    return out;
  }

  WorkGivers.register({
    id: 'constructDeliverMaterials', workType: 'construct', order: 10,
    label: 'deliver materials',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var enRoute = deliveriesEnRoute(map);
      var list = ghosts(map), cands = [];
      for (var i = 0; i < list.length; i++) {
        var g = list[i];
        if (!stillNeeded(g, enRoute)) continue;
        if (!inReach(map, pawn, g.x, g.y)) continue;
        cands.push(g);
      }
      /* A ghost is not claimed: several haulers feeding one frame is
         the point. What gets claimed is the stack each one carries. */
      var ghost = nearest(pawn, cands, function (g, d) {
        return (g.isFrame ? 20 : 0) - d;
      });
      if (!ghost) return null;

      var need = stillNeeded(ghost, enRoute);
      if (!need) return null;

      var stacks = [];
      for (var defId in need) {
        var avail = map.byDef(defId);
        for (var s = 0; s < avail.length; s++) {
          var st = avail[s];
          if (!st.spawned || st.stack <= 0) continue;
          if (!freeFor(pawn, T.thing(st))) continue;
          if (!inReach(map, pawn, st.x, st.y)) continue;
          stacks.push(st);
        }
      }
      var stack = nearest(pawn, stacks, function (st, d) {
        /* One trip that finishes the wall beats two that nearly do. */
        return Math.min(st.stack, need[st.defId] || 0) * 3 - d;
      });
      if (!stack) return null;

      var count = Math.min(stack.stack, need[stack.defId] || 0, stack.def.stackLimit || 1);
      if (count <= 0) return null;
      if (!Res.reserve(pawn, T.thing(stack), 1)) return null;
      var job = makeJob('construct', T.thing(ghost), T.thing(stack), { count: count });
      if (!job) Res.release(pawn, T.thing(stack));
      return job;
    }
  });

  WorkGivers.register({
    id: 'constructFrame', workType: 'construct', order: 20,
    label: 'build frame',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var C = sys('Construct');
      if (!C || !C.isMaterialComplete) return null;
      var list = ghosts(map), cands = [];
      for (var i = 0; i < list.length; i++) {
        var g = list[i];
        if (!g.isFrame || !C.isMaterialComplete(g)) continue;
        if (!freeFor(pawn, T.thing(g))) continue;
        if (!inReach(map, pawn, g.x, g.y)) continue;
        cands.push(g);
      }
      var frame = nearest(pawn, cands, function (g, d) {
        /* Nearly-finished first: a half-built wall is a hole. */
        var total = (g.def && g.def.workToBuild) || 1;
        return ((g.workDone || 0) / total) * 25 - d;
      });
      return frame ? claimed(pawn, 'construct', T.thing(frame)) : null;
    }
  });

  WorkGivers.register({
    id: 'constructRepair', workType: 'construct', order: 30,
    label: 'repair',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var C = sys('Construct');
      if (!C || !C.needsRepair) return null;

      /* Every building the colony owns, filtered to the damaged ones.
         Held for a while: hp does not change between raids, and this is
         the widest scan in the file. */
      var damaged = slowScan(map, 'damaged', REPAIR_RESCAN, function () {
        var all = thingsOfDefs(map, repairableDefIds()), out = [];
        for (var i = 0; i < all.length; i++) if (C.needsRepair(all[i])) out.push(all[i]);
        return out;
      });
      if (!damaged.length) return null;

      var cands = [];
      for (var k = 0; k < damaged.length; k++) {
        var b = damaged[k];
        if (!C.needsRepair(b)) continue;
        if (!freeFor(pawn, T.thing(b))) continue;
        if (!inReach(map, pawn, b.x, b.y)) continue;
        cands.push(b);
      }
      var target = nearest(pawn, cands, function (b, d) {
        var max = C.maxHp ? C.maxHp(b) : (b.def.hp || 1);
        return (1 - (b.hp || 0) / max) * 50 - d;
      });
      return target ? claimed(pawn, 'repair', T.thing(target)) : null;
    }
  });

  WorkGivers.register({
    id: 'constructDeconstruct', workType: 'construct', order: 40,
    label: 'deconstruct',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var C = sys('Construct');
      if (!C || !C.deconstructTargets) return null;
      var list = scan(map, 'deconstruct', function () { return C.deconstructTargets(map); });
      var cands = [];
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (!b.spawned) continue;
        if (!freeFor(pawn, T.thing(b))) continue;
        if (!inReach(map, pawn, b.x, b.y)) continue;
        cands.push(b);
      }
      var target = nearest(pawn, cands, null);
      return target ? claimed(pawn, 'deconstruct', T.thing(target)) : null;
    }
  });

  /* ============================================================
     grow
     ============================================================ */

  function ripePlants(map) {
    return scan(map, 'ripe', function () {
      var P = sys('Plants');
      if (!P || !P.harvestable) return [];
      var out = [], seen = Object.create(null), i, plant;

      /* Crops standing ripe in a field the player laid out. */
      var zones = Zones.growingZones ? Zones.growingZones(map) : [];
      for (i = 0; i < zones.length; i++) {
        Zones.forEachCell(zones[i], function (x, y, idx) {
          var id = map.plantId[idx];
          if (!id || seen[id]) return;
          var p = map.things.get(id);
          if (p && P.harvestable(map, p)) { seen[id] = 1; out.push(p); }
        }, map);
      }

      /* Wild plants the player marked by hand. */
      var marks = map.designationsOf('harvest');
      for (i = 0; i < marks.length; i++) {
        plant = map.plantAt(marks[i].x, marks[i].y);
        if (!plant || seen[plant.id]) continue;
        if (P.harvestable(map, plant)) { seen[plant.id] = 1; out.push(plant); }
      }
      return out;
    });
  }

  WorkGivers.register({
    id: 'growHarvest', workType: 'grow', order: 10,
    label: 'harvest',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var list = ripePlants(map), cands = [];
      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        if (!p.spawned) continue;
        if (!freeFor(pawn, T.thing(p))) continue;
        if (!inReach(map, pawn, p.x, p.y)) continue;
        cands.push(p);
      }
      var plant = nearest(pawn, cands, function (p, d) {
        /* Overripe crops rot in the field, so the ripest goes first. */
        return (p.growth || 0) * 8 - d;
      });
      return plant ? claimed(pawn, 'harvest', T.thing(plant)) : null;
    }
  });

  WorkGivers.register({
    id: 'growSow', workType: 'grow', order: 20,
    label: 'sow',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      if (!Zones.growingCellsNeedingSow) return null;
      var cells = scan(map, 'sowCells', function () { return Zones.growingCellsNeedingSow(map); });
      if (!cells.length) return null;

      var level = skillLevel(pawn, 'plants');
      var cands = [];
      for (var i = 0; i < cells.length; i++) {
        var idx = cells[i];
        var x = map.xOf(idx), y = map.yOf(idx);
        var plantId = Zones.plantOfZoneAt(map, x, y);
        var def = plantId ? Defs.maybe('thing', plantId) : null;
        if (!def) continue;
        /* A novice cannot be told to plant devilstrand; the field waits
           for somebody who can. */
        if (level < ((def.plant && def.plant.sowMinSkill) || 0)) continue;
        if (!freeFor(pawn, T.cell(x, y))) continue;
        if (!inReach(map, pawn, x, y)) continue;
        cands.push(idx);
      }
      var cell = nearest(pawn, cands, null);
      if (cell === null || cell === undefined) return null;
      return claimed(pawn, 'sow', T.cell(map.xOf(cell), map.yOf(cell)));
    }
  });

  /* ============================================================
     mine
     ============================================================ */

  WorkGivers.register({
    id: 'mineDesignated', workType: 'mine', order: 10,
    label: 'mine',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var C = sys('Construct');
      if (!C || !C.mineTargets) return null;
      var list = scan(map, 'mineTargets', function () { return C.mineTargets(map); });
      var cands = [];
      for (var i = 0; i < list.length; i++) {
        var wall = list[i];
        if (!wall.spawned) continue;
        if (!freeFor(pawn, T.thing(wall))) continue;
        if (!inReach(map, pawn, wall.x, wall.y)) continue;
        cands.push(wall);
      }
      var target = nearest(pawn, cands, function (wall, d) {
        /* Half-cut rock is wasted work until somebody finishes it. */
        return (wall.workDone || 0) * 0.02 - d;
      });
      return target ? claimed(pawn, 'mine', T.thing(target)) : null;
    }
  });

  /* ============================================================
     plantCut
     ============================================================ */

  function cuttablePlants(map, designation) {
    return scan(map, 'cut:' + designation, function () {
      var P = sys('Plants');
      if (!P || !P.cuttable) return [];
      var marks = map.designationsOf(designation), out = [];
      for (var i = 0; i < marks.length; i++) {
        var plant = map.plantAt(marks[i].x, marks[i].y);
        if (plant && P.cuttable(map, plant)) out.push(plant);
      }
      return out;
    });
  }

  /* Weeds standing in a field: not designated by anybody, but nothing
     can be sown until they are gone. */
  function fieldWeeds(map) {
    return scan(map, 'weeds', function () {
      if (!Zones.growingCellsNeedingCut) return [];
      var cells = Zones.growingCellsNeedingCut(map), out = [];
      for (var i = 0; i < cells.length; i++) {
        var id = map.plantId[cells[i]];
        var plant = id ? map.things.get(id) : null;
        if (plant && plant.spawned) out.push(plant);
      }
      return out;
    });
  }

  function cutJobFor(pawn, list, jobId, treesOnly) {
    var map = pawn.map;
    var P = sys('Plants');
    var cands = [];
    for (var i = 0; i < list.length; i++) {
      var plant = list[i];
      if (!plant.spawned) continue;
      if (treesOnly && P && P.isTree && !P.isTree(plant)) continue;
      if (!freeFor(pawn, T.thing(plant))) continue;
      if (!inReach(map, pawn, plant.x, plant.y)) continue;
      cands.push(plant);
    }
    var target = nearest(pawn, cands, function (plant, d) {
      /* A grown tree pays in wood; a sapling is just work. */
      return (plant.growth || 0) * 6 - d;
    });
    return target ? claimed(pawn, jobId, T.thing(target)) : null;
  }

  WorkGivers.register({
    id: 'plantCutDesignated', workType: 'plantCut', order: 10,
    label: 'cut plants',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      return cutJobFor(pawn, cuttablePlants(map, 'cut'), 'cutPlant', false) ||
             cutJobFor(pawn, fieldWeeds(map), 'cutPlant', false);
    }
  });

  WorkGivers.register({
    id: 'chopWoodDesignated', workType: 'plantCut', order: 20,
    label: 'chop wood',
    tryGiveJob: function (pawn) {
      return cutJobFor(pawn, cuttablePlants(pawn.map, 'chop'), 'chopWood', true);
    }
  });

  /* ============================================================
     haul

     Most of what a colony does, all day, forever. Two things matter:
     never hand the same stack to two people, and never send somebody
     to a stockpile cell that will be full when they arrive. Both are
     answered by claiming the item AND the destination here, before the
     job leaves this function.
     ============================================================ */

  function haulables(map) {
    return scan(map, 'haulables', function () {
      if (!Zones.haulables) return [];
      return Zones.haulables(map, HAUL_SCAN_LIMIT);
    });
  }

  function urgentCells(map) {
    return scan(map, 'haulUrgent', function () {
      var marks = map.designationsOf('haulUrgent'), set = Object.create(null);
      for (var i = 0; i < marks.length; i++) set[marks[i].i] = 1;
      return set;
    });
  }

  WorkGivers.register({
    id: 'haulGeneral', workType: 'haul', order: 10,
    label: 'haul',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var list = haulables(map);
      if (!list.length) return null;
      var urgent = urgentCells(map);

      /* The cached list was true at the top of the tick; between then
         and now another hauler may have claimed half of it, so the
         claim test is repeated inside the scoring function where it
         is asked about the near end of the list only. */
      var thing = nearest(pawn, list, function (t, d) {
        if (!t.spawned || t.stack <= 0) return null;
        if (!freeFor(pawn, T.thing(t))) return null;
        var score = -d + Math.min(t.stack, 75) * 0.12;
        if (urgent[map.idx(t.x, t.y)]) score += 200;
        /* Food that is going over is worth moving before it is lost. */
        if (t.rotProgress > 0.5) score += 25;
        return score;
      });
      if (!thing) return null;

      var spot = Zones.bestStorageFor(map, thing, pawn);
      if (!spot) return null;

      var item = T.thing(thing), cell = T.cell(spot.x, spot.y);
      if (!Res.reserve(pawn, item, 1)) return null;
      if (!Res.reserve(pawn, cell, 1)) { Res.release(pawn, item); return null; }
      var job = makeJob('haul', item, cell, { count: thing.stack });
      if (!job) { Res.release(pawn, item); Res.release(pawn, cell); }
      return job;
    }
  });

  /* ============================================================
     clean
     ============================================================ */

  /* Filth in rooms, not filth on the map: nobody scrubs a forest. The
     scan walks the cells of enclosed rooms only, which is the built
     base, and is held for a couple of seconds because blood does not
     appear from nowhere. */
  function filthyCells(map) {
    return slowScan(map, 'filth', CLEAN_RESCAN, function () {
      var out = [];
      if (!Regions.rooms) return out;
      var rooms = Regions.rooms(map);
      if (!rooms || !rooms.forEach) return out;
      var blood = map.blood;
      rooms.forEach(function (room) {
        if (!room || room.outdoor || room.id <= 0) return;
        var cells = room.cells;
        for (var k = 0; k < cells.length; k++) {
          if (blood[cells[k]] >= FILTH_WORTH_CLEANING) out.push(cells[k]);
        }
      });
      return out;
    });
  }

  WorkGivers.register({
    id: 'cleanFilth', workType: 'clean', order: 10,
    label: 'clean',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var cells = filthyCells(map);
      if (!cells.length) return null;
      var blood = map.blood, cands = [];
      for (var i = 0; i < cells.length; i++) {
        var idx = cells[i];
        if (blood[idx] < FILTH_WORTH_CLEANING) continue;
        var x = map.xOf(idx), y = map.yOf(idx);
        if (!freeFor(pawn, T.cell(x, y))) continue;
        if (!inReach(map, pawn, x, y)) continue;
        cands.push(idx);
      }
      var cell = nearest(pawn, cands, function (idx, d) {
        return blood[idx] * 0.15 - d;
      });
      if (cell === null || cell === undefined) return null;
      return claimed(pawn, 'clean', T.cell(map.xOf(cell), map.yOf(cell)));
    }
  });

  /* ============================================================
     research
     ============================================================ */

  WorkGivers.register({
    id: 'researchBench', workType: 'research', order: 10,
    label: 'research',
    tryGiveJob: function (pawn) {
      var map = pawn.map;
      var R = sys('Research');
      if (!R || !R.current || !R.current()) return null;

      var list = map.byDef('researchBench'), cands = [];
      for (var i = 0; i < list.length; i++) {
        var b = list[i];
        if (!b.spawned || b.isBlueprint || b.isFrame) continue;
        if (b.faction && b.faction !== 'player') continue;
        if (b.def.building.powerConsumed > 0 && b.powered === false) continue;
        if (!freeFor(pawn, T.thing(b))) continue;
        if (!inReach(map, pawn, b.x, b.y)) continue;
        cands.push(b);
      }
      var bench = nearest(pawn, cands, null);
      return bench ? claimed(pawn, 'research', T.thing(bench)) : null;
    }
  });

  /* ------------------------------------------------------------------
     Notes on what is deliberately absent.

     `warden` has no giver here. Section 10.5 of the contract hands the
     warden column to prisoners.js, which registers its own givers
     against this same registry, so writing them here would mean two
     files fighting over one work type.

     The path-end mode constant is exported because the givers above
     choose targets the jobs then walk to, and a reader comparing the
     two should be able to see they agree.
     ------------------------------------------------------------------ */
  WorkGivers.PE = PE;
  WorkGivers.inReach = inReach;
  WorkGivers.nearest = nearest;
  WorkGivers.bestDoctorFor = bestDoctorFor;
  WorkGivers.hoursToBleedOut = hoursToBleedOut;

  root.WorkGivers = WorkGivers;
})(this);
