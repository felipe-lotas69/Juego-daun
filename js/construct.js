/* ============================================================
   construct.js - blueprints, frames, building, deconstruction,
   mining, and the roofs that mining brings down.

   The build flow is RimWorld's, and worth stating plainly because
   three files touch it:

     blueprint --(haulers carry materials in)--> frame
               --(a constructor spends workToBuild)--> the building

   A blueprint is a ghost: it owns nothing, blocks nothing and costs
   nothing to cancel. A frame owns the materials carried into it and
   the work done so far, which is why cancelling a frame refunds and
   cancelling a blueprint does not. Only finishFrame spawns the real
   building.

   Mining runs the other way: a designation on a natural wall, 800
   work, and the wall becomes rock floor plus whatever the seam held.
   Then the roof that wall was holding has to be asked whether
   anything else is still holding it, and sometimes the answer is no.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  var Construct = {};

  /* ---------- numbers ----------
     xp per work unit matches the rate Toils.work grants, so a job that
     applies its own work (ours all do, because the failure roll lives
     in workOn) teaches at exactly the same speed as one that does not. */
  var XP_PER_WORK = 0.11;

  /* A roofed cell needs something solid within this many tiles or the
     roof comes down. Six is what makes mining a corridor safe and
     hollowing out a hall not. */
  var ROOF_SUPPORT_RADIUS = 6;
  var ROOF_CRUSH_DAMAGE = 25;
  var ROOF_BUILDING_DAMAGE = 45;

  /* Taking a building apart returns half of what went into it, and
     costs half the work it took to put up. */
  var DECONSTRUCT_REFUND = 0.5;
  var DECONSTRUCT_WORK_FACTOR = 0.5;

  /* Repair is deliberately quick: it exists so a colony can patch a
     wall between raids, not so it becomes a career. */
  var REPAIR_HP_PER_WORK = 12;

  /* Materials a stuffable thing can be made of. hp and work multiply
     the def's own numbers, so one wall def covers a wooden shack and a
     stone bunker: 180 hp in wood, 324 in stone blocks, and the stone
     one takes the better part of twice as long to raise. */
  var STUFF = {
    wood: { hp: 1.0, work: 1.0 },
    steel: { hp: 1.5, work: 1.3 },
    stoneBlocks: { hp: 1.8, work: 1.7 },
    cloth: { hp: 0.5, work: 0.9 },
    leather: { hp: 0.6, work: 1.0 }
  };
  Construct.STUFF = STUFF;
  Construct.ROOF_SUPPORT_RADIUS = ROOF_SUPPORT_RADIUS;

  /* ---------- small shared helpers ---------- */

  /* A build target is either a thing def (a wall) or a terrain def (a
     floor). Everything downstream branches on defCategory. */
  function buildDefOf(defId) {
    if (!defId) return null;
    return Defs.maybe('thing', defId) || Defs.maybe('terrain', defId);
  }
  Construct.defOf = buildDefOf;

  function isTerrainDef(def) { return !!def && def.defCategory === 'terrain'; }

  function labelOf(def) { return (def && def.label) || (def && def.id) || 'thing'; }

  /* There is one map in the game, but a Thing does not have to carry a
     back-reference to it, so deliver()/workOn() - which are handed a
     thing and nothing else - resolve it here. */
  function mapOf(thing) {
    if (thing && thing.map) return thing.map;
    return (root.Game && root.Game.map) || null;
  }

  function msg(text, opts) {
    var G = root.Game;
    if (G && G.msg) G.msg(text, opts);
  }

  function researchDone(id) {
    if (!id) return true;
    var R = root.Research;
    return R && R.isDone ? !!R.isDone(id) : true;
  }

  /* East/west rotations swap the footprint; the origin stays top-left. */
  function footprint(def, rot) {
    var s = (def && def.size) || null;
    var w = s ? s.w : 1, h = s ? s.h : 1;
    return (rot === 1 || rot === 3) ? { w: h, h: w } : { w: w, h: h };
  }
  Construct.footprint = footprint;

  function forEachCell(def, x, y, rot, fn) {
    var f = footprint(def, rot);
    for (var dy = 0; dy < f.h; dy++) {
      for (var dx = 0; dx < f.w; dx++) {
        var r = fn(x + dx, y + dy);
        if (r === false) return false;
      }
    }
    return true;
  }

  /* Quarter-turn clockwise, so a workbench keeps its interaction spot
     in front of it whichever way it is facing. */
  function rotateOffset(off, rot) {
    var dx = off.dx || 0, dy = off.dy || 0;
    if (rot === 1) return { dx: -dy, dy: dx };
    if (rot === 2) return { dx: -dx, dy: -dy };
    if (rot === 3) return { dx: dy, dy: -dx };
    return { dx: dx, dy: dy };
  }

  Construct.interactionCell = function (def, x, y, rot) {
    var off = def && def.building && def.building.interactionOffset;
    if (!off) return null;
    var r = rotateOffset(off, rot | 0);
    return { x: x + r.dx, y: y + r.dy };
  };

  function skillLevel(pawn, id) {
    var s = pawn && pawn.skills && pawn.skills[id];
    return s ? (s.level || 0) : 0;
  }

  /* Pawn owns the xp curve if it exposes one; otherwise apply the
     contract's curve here rather than silently dropping the xp. */
  function gainSkill(pawn, id, xp) {
    if (!pawn || !xp || xp <= 0) return;
    if (typeof pawn.learn === 'function') { pawn.learn(id, xp); return; }
    if (typeof pawn.gainXp === 'function') { pawn.gainXp(id, xp); return; }
    var s = pawn.skills && pawn.skills[id];
    if (!s) return;
    var mult = [0.35, 1.0, 1.5][s.passion || 0];
    s.xp = (s.xp || 0) + xp * (mult === undefined ? 1 : mult);
    while (s.level < 20 && s.xp >= 1000 * (s.level + 1)) {
      s.xp -= 1000 * (s.level + 1);
      s.level++;
    }
  }

  /* Work units per tick. Level 20 is exactly twice level 0 plus the
     0.4 floor, and a hurt pawn works slower at whatever skill. */
  Construct.workRate = function (pawn, skillId) {
    var rate = 0.4 + 0.08 * skillLevel(pawn, skillId);
    var H = root.Health;
    if (H && H.workSpeedFactor) rate *= H.workSpeedFactor(pawn);
    return Math.max(0.05, rate);
  };

  /* ---------- materials ---------- */

  /* A stuffable def quotes its cost against one material (wood, by
     convention in def_things.js). That key is the "stuff" slot; any
     other entry - a turret's components - is a fixed extra. */
  function stuffKeyOf(def) {
    if (!def || !def.stuffable || !def.buildCost) return null;
    for (var k in def.buildCost) if (STUFF[k]) return k;
    return null;
  }

  Construct.stuffOptions = function (defId) {
    var def = buildDefOf(defId);
    if (!def || !def.stuffable) return [];
    var base = stuffKeyOf(def);
    var out = [];
    ['wood', 'steel', 'stoneBlocks'].forEach(function (s) {
      if (s === 'stoneBlocks' && !researchDone('stonecutting')) return;
      out.push(s);
    });
    if (base && out.indexOf(base) < 0) out.unshift(base);
    return out;
  };

  Construct.defaultStuff = function (defId) {
    var def = buildDefOf(defId);
    if (!def || !def.stuffable) return null;
    return stuffKeyOf(def) || 'wood';
  };

  Construct.totalCost = function (defId, stuffId) {
    var def = buildDefOf(defId);
    var out = {};
    if (!def || !def.buildCost) return out;
    var swap = stuffKeyOf(def);
    for (var k in def.buildCost) {
      var key = (swap && k === swap && stuffId) ? stuffId : k;
      out[key] = (out[key] || 0) + def.buildCost[k];
    }
    return out;
  };

  function stuffFactor(stuffId, key) {
    var s = stuffId && STUFF[stuffId];
    return s ? s[key] : 1;
  }

  Construct.workToBuild = function (defId, stuffId) {
    var def = buildDefOf(defId);
    if (!def) return 0;
    return Math.max(1, Math.round((def.workToBuild || 0) * stuffFactor(stuffId, 'work')));
  };

  Construct.maxHpFor = function (defId, stuffId) {
    var def = buildDefOf(defId);
    if (!def) return 1;
    /* Thing defs state hp; the plant defs also alias it as maxHp. */
    return Math.max(1, Math.round((def.maxHp || def.hp || 100) * stuffFactor(stuffId, 'hp')));
  };

  /* The live maximum for a thing that already exists, which is what
     repair and the health bar in the inspect pane want. */
  Construct.maxHp = function (thing) {
    if (!thing) return 1;
    if (thing.maxHp) return thing.maxHp;
    return Construct.maxHpFor(thing.defId, thing.stuff);
  };

  /* ---------- finding ghosts ----------
     Blueprints and frames are ordinary things, so map.byDef is the
     index. There are tens of them, not thousands, and scanning avoids
     keeping a second cell index in sync with every despawn. */

  function ghostList(map, defId) {
    var l = map.byDef ? map.byDef(defId) : null;
    return l || [];
  }

  function ghostCovers(g, x, y) {
    var def = buildDefOf(g.buildDefId);
    var f = footprint(def, g.rot | 0);
    return x >= g.x && x < g.x + f.w && y >= g.y && y < g.y + f.h;
  }

  /* map.js keeps ghosts on their own cell grid, which answers this in
     O(1); the scan is the fallback for a map that does not. */
  Construct.ghostAt = function (map, x, y) {
    if (map.ghostAt) return map.ghostAt(x, y);
    var lists = [ghostList(map, 'blueprint'), ghostList(map, 'frame')];
    for (var l = 0; l < lists.length; l++) {
      var arr = lists[l];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].spawned && ghostCovers(arr[i], x, y)) return arr[i];
      }
    }
    return null;
  };

  Construct.blueprints = function (map) { return ghostList(map, 'blueprint'); };
  Construct.frames = function (map) { return ghostList(map, 'frame'); };

  /* Everything a constructor could usefully walk to: both kinds of
     ghost, in one array, for workgivers.js to sort through. */
  Construct.buildTargets = function (map) {
    return ghostList(map, 'blueprint').concat(ghostList(map, 'frame'));
  };

  /* A designation is a marked cell; what a work giver wants is the
     thing standing on it, and whether that thing is still a legal
     target. Knowing that is this file's business, not scanning's. */
  function designatedThings(map, type, test) {
    var marks = map.designationsOf(type), out = [];
    for (var i = 0; i < marks.length; i++) {
      var t = test(map, marks[i].x, marks[i].y);
      if (t) out.push(t);
    }
    return out;
  }

  Construct.mineTargets = function (map) {
    return designatedThings(map, 'mine', Construct.canMine);
  };
  Construct.deconstructTargets = function (map) {
    return designatedThings(map, 'deconstruct', Construct.canDeconstruct);
  };

  /* ---------- placement ---------- */

  function no(reason) { return { ok: false, reason: reason }; }
  var YES = { ok: true, reason: '' };

  /* A floor slips under a conduit or a bed; everything else that is
     already standing on the cell is genuinely in the way. */
  function conflicts(newDef, standingDef) {
    if (!isTerrainDef(newDef)) return true;
    return standingDef.passable === false || standingDef.fillPercent >= 1;
  }

  /* A jamb: something a door can hang in. The map edge counts, and so
     does a planned wall, so a whole room can be laid out at once. */
  function wallLike(map, x, y) {
    if (!map.inBounds(x, y)) return true;
    var b = map.buildingAt(x, y);
    if (b && b.def && b.def.passable === false && b.def.fillPercent >= 1) return true;
    var g = Construct.ghostAt(map, x, y);
    if (g) {
      var d = buildDefOf(g.buildDefId);
      if (d && d.passable === false && d.fillPercent >= 1) return true;
    }
    return false;
  }

  Construct.canPlace = function (map, defId, x, y, rot) {
    rot = rot | 0;
    var def = buildDefOf(defId);
    if (!def) return no('There is no such thing.');
    if (!def.buildCategory) return no(U.cap(labelOf(def)) + ' cannot be built.');
    if (def.researchPrerequisite && !researchDone(def.researchPrerequisite)) {
      var r = Defs.maybe('research', def.researchPrerequisite);
      return no('Needs research: ' + ((r && r.label) || def.researchPrerequisite) + '.');
    }
    if (!def.rotatable) rot = 0;

    var terrainBuild = isTerrainDef(def);
    var fail = null;

    forEachCell(def, x, y, rot, function (cx, cy) {
      if (fail) return false;
      if (!map.inBounds(cx, cy)) { fail = no('Outside the map.'); return false; }

      var t = map.terrainAt(cx, cy);
      if (t && t.isWater) {
        fail = no('Cannot build on ' + t.label + '.');
        return false;
      }
      if (terrainBuild && t && t.id === defId) {
        fail = no('That floor is already here.');
        return false;
      }

      var b = map.buildingAt(cx, cy);
      /* Ghosts are checked separately below, because a plan you can
         overwrite is not the same obstacle as a building you cannot. */
      if (b && b.def && !b.isBlueprint && !b.isFrame) {
        if (b.def.mineable) { fail = no('Mine the rock out first.'); return false; }
        if (conflicts(def, b.def)) {
          fail = no('There is already a ' + labelOf(b.def) + ' here.');
          return false;
        }
      }

      var g = Construct.ghostAt(map, cx, cy);
      if (g && g.buildDefId === defId) {
        fail = no('That is already planned here.');
        return false;
      }
      return true;
    });
    if (fail) return fail;

    /* A door has to sit in a wall line, on either axis. Facing is not
       part of the question: a door turned the wrong way is a rotation
       mistake the player fixes with R, not a bad cell. */
    if (def.building && def.building.isDoor) {
      var acrossX = wallLike(map, x - 1, y) && wallLike(map, x + 1, y);
      var acrossY = wallLike(map, x, y - 1) && wallLike(map, x, y + 1);
      if (!acrossX && !acrossY) return no('A door needs a wall on both sides.');
    }

    /* Anything with an interaction spot is useless if a pawn cannot
       stand on that spot, so refuse it at placement rather than let the
       player discover it when the bills never get done. */
    var spot = Construct.interactionCell(def, x, y, rot);
    if (spot) {
      var inside = false;
      forEachCell(def, x, y, rot, function (cx, cy) {
        if (cx === spot.x && cy === spot.y) inside = true;
        return true;
      });
      if (!inside) {
        if (!map.inBounds(spot.x, spot.y)) return no('Its interaction spot is off the map.');
        var st = map.terrainAt(spot.x, spot.y);
        if (st && st.passable === false) return no('Its interaction spot is blocked.');
        var sb = map.buildingAt(spot.x, spot.y);
        if (sb && sb.def && sb.def.passable === false) return no('Its interaction spot is blocked.');
      }
    }

    return YES;
  };

  Construct.placeBlueprint = function (map, defId, x, y, rot, stuffId) {
    rot = rot | 0;
    var def = buildDefOf(defId);
    if (!def) return null;
    if (!def.rotatable) rot = 0;

    /* Dragging the wall tool across your own wall reads as "take that
       down" - it is how a player erases a mistake with the tool that
       made it, and it is why placing never silently fails on a cell
       that already holds one of your buildings. */
    var standing = map.buildingAt(x, y);
    if (standing && standing.def && standing.faction === 'player' &&
        !standing.isBlueprint && !standing.isFrame && !standing.def.mineable &&
        conflicts(def, standing.def)) {
      Construct.designateDeconstruct(map, x, y);
      return null;
    }

    if (!Construct.canPlace(map, defId, x, y, rot).ok) return null;

    /* One ghost per cell keeps the whole thing predictable: planning a
       wall over a planned floor replaces the floor, and a plan that
       covers several cells clears every plan it lands on. */
    forEachCell(def, x, y, rot, function (cx, cy) {
      var old = Construct.ghostAt(map, cx, cy);
      if (old) Construct.cancelGhost(map, old);
      return true;
    });

    var stuff = null;
    if (def.stuffable) {
      stuff = (stuffId && STUFF[stuffId]) ? stuffId : Construct.defaultStuff(defId);
    }

    var bp = map.spawnThing('blueprint', x, y, {
      rot: rot, faction: 'player', blueprintOf: defId, stuff: stuff
    });
    if (!bp) return null;

    bp.isBlueprint = true;
    bp.isFrame = false;
    bp.buildDefId = defId;
    bp.stuff = stuff;
    bp.rot = rot;
    bp.materials = {};
    bp.workDone = 0;
    bp.faction = 'player';
    bp.map = map;
    /* Deliberately no markPathDirty: a blueprint is a ghost and the
       cell walks exactly as it did a moment ago. */

    /* A sleeping spot or a crafting spot costs nothing, so there is
       nothing for a hauler to bring and it is a frame the moment it is
       placed. Otherwise a zero-cost plan would sit there forever. */
    if (Construct.isMaterialComplete(bp)) return Construct.toFrame(map, bp);
    return bp;
  };

  /* A blueprint costs nothing, so it just goes. A frame is holding
     real materials, and they come straight back out onto the floor. */
  Construct.cancelGhost = function (map, ghost) {
    if (!ghost || !ghost.spawned) return false;
    var def = buildDefOf(ghost.buildDefId);
    var rot = ghost.rot | 0;
    var x = ghost.x, y = ghost.y;
    var mats = ghost.materials || {};
    var wasFrame = !!ghost.isFrame;
    map.despawnThing(ghost);
    for (var k in mats) {
      if (mats[k] > 0) map.addItem(k, x, y, mats[k]);
    }
    if (wasFrame) markBuildDirty(map, def, x, y, rot, false);
    return true;
  };

  Construct.cancelAt = function (map, x, y) {
    var ghost = Construct.ghostAt(map, x, y);
    if (ghost) return Construct.cancelGhost(map, ghost);
    var d = map.designationAt(x, y);
    if (d && (d.type === 'deconstruct' || d.type === 'mine')) {
      map.undesignate(x, y, d.type);
      return true;
    }
    return false;
  };

  /* ---------- delivery ---------- */

  Construct.materialsNeeded = function (thing) {
    var out = {};
    if (!thing || !thing.buildDefId) return out;
    var cost = Construct.totalCost(thing.buildDefId, thing.stuff);
    var have = thing.materials || {};
    for (var k in cost) {
      var short = cost[k] - (have[k] || 0);
      if (short > 0) out[k] = short;
    }
    return out;
  };

  Construct.isMaterialComplete = function (thing) {
    var need = Construct.materialsNeeded(thing);
    for (var k in need) return false;
    return true;
  };

  /* Returns how many units were actually taken, which is what a hauler
     needs to know so the rest of the stack goes back to the stockpile. */
  Construct.deliver = function (thing, defId, count) {
    if (!thing || !thing.spawned || !(count > 0)) return 0;
    if (!thing.isBlueprint && !thing.isFrame) return 0;
    var need = Construct.materialsNeeded(thing);
    var take = Math.min(count, need[defId] || 0);
    if (take <= 0) return 0;
    if (!thing.materials) thing.materials = {};
    thing.materials[defId] = (thing.materials[defId] || 0) + take;
    if (thing.isBlueprint && Construct.isMaterialComplete(thing)) {
      Construct.toFrame(mapOf(thing), thing);
    }
    return take;
  };

  /* A ghost is replaced rather than relabelled: map.byDef indexes by
     defId, so a thing cannot change what it is in place. Everything the
     ghost was carrying moves across. */
  function respawnGhost(map, ghost, asDefId, keepWork) {
    if (!map || !ghost || !ghost.spawned) return null;
    var defId = ghost.buildDefId, rot = ghost.rot | 0;
    var x = ghost.x, y = ghost.y, stuff = ghost.stuff;
    var mats = ghost.materials || {};
    var work = keepWork ? (ghost.workDone || 0) : 0;
    map.despawnThing(ghost);
    var next = map.spawnThing(asDefId, x, y, {
      rot: rot, faction: 'player', blueprintOf: defId, stuff: stuff
    });
    if (!next) return null;
    next.isFrame = asDefId === 'frame';
    next.isBlueprint = !next.isFrame;
    next.buildDefId = defId;
    next.stuff = stuff;
    next.rot = rot;
    next.materials = mats;
    next.workDone = work;
    next.faction = 'player';
    next.map = map;
    /* The frame def stays passable on purpose (see def_things.js) but it
       does add move cost either way, so the grid has to be told. */
    markBuildDirty(map, buildDefOf(defId), x, y, rot, false);
    return next;
  }

  Construct.toFrame = function (map, bp) { return respawnGhost(map, bp, 'frame', true); };

  /* A botched frame that no longer has its materials is a blueprint
     again, which puts it straight back in the haulers' queue. */
  Construct.toBlueprint = function (map, frame) {
    return respawnGhost(map, frame, 'blueprint', false);
  };

  /* ---------- building ---------- */

  /* Low skill is not "slower", it is "sometimes ruins it". The curve is
     gentle enough that a level 3 colonist can be trusted with a wall
     and harsh enough that nobody hands a novice the solar panel. */
  Construct.successChance = function (pawn, def) {
    var skillId = (def && def.buildSkill) || 'construction';
    var lvl = skillLevel(pawn, skillId);
    return U.clamp(U.curve([[0, 0.55], [2, 0.70], [4, 0.82], [8, 0.95], [12, 1]], lvl), 0.2, 1);
  };

  Construct.workOn = function (pawn, thing, amount) {
    if (!thing || !thing.spawned || !thing.isFrame || !(amount > 0)) return false;
    var map = mapOf(thing);
    var def = buildDefOf(thing.buildDefId);
    if (!map || !def) return false;

    thing.workDone = (thing.workDone || 0) + amount;
    gainSkill(pawn, def.buildSkill || 'construction', amount * XP_PER_WORK);

    var total = Construct.workToBuild(thing.buildDefId, thing.stuff);
    if (thing.workDone < total) return false;

    if (!U.chance(Construct.successChance(pawn, def))) {
      Construct.botch(map, thing, pawn);
      return false;
    }
    Construct.finishFrame(map, thing, pawn);
    return true;
  };

  Construct.botch = function (map, frame, pawn) {
    var def = buildDefOf(frame.buildDefId);
    var mats = frame.materials || {};
    var lost = 0;
    for (var k in mats) {
      var drop = Math.ceil(mats[k] * 0.5);
      mats[k] -= drop;
      if (mats[k] <= 0) delete mats[k];
      lost += drop;
    }
    frame.workDone = 0;
    var who = (pawn && pawn.name && (pawn.name.nick || pawn.name.first)) || 'Someone';
    msg(who + ' botched the ' + labelOf(def) +
      (lost ? ', wasting ' + lost + ' materials.' : ' and has to start again.'),
      { type: 'threat', x: frame.x, y: frame.y });
    /* Short of materials it is not a frame any more; dropping back to a
       blueprint is what gets a hauler to top it up again. */
    if (!Construct.isMaterialComplete(frame)) Construct.toBlueprint(map, frame);
    return lost;
  };

  /* Artists produce a spread of quality; everyone else produces a
     building, which has none. */
  function rollQuality(pawn, def) {
    if (!def || def.buildSkill !== 'artistic') return null;
    var lvl = skillLevel(pawn, 'artistic');
    return Math.round(U.gauss(1 + lvl * 0.16, 1.1, 0, 6));
  }

  Construct.finishFrame = function (map, frame, pawn) {
    if (!map || !frame || !frame.spawned) return null;
    var defId = frame.buildDefId;
    var def = buildDefOf(defId);
    if (!def) return null;
    var x = frame.x, y = frame.y, rot = frame.rot | 0, stuff = frame.stuff;

    map.despawnThing(frame);
    clearForBuilding(map, def, x, y, rot);

    var built = null;
    if (isTerrainDef(def)) {
      map.setTerrain(x, y, defId);
    } else {
      var hp = Construct.maxHpFor(defId, stuff);
      built = map.spawnThing(defId, x, y, {
        rot: rot, faction: 'player', hp: hp, stuff: stuff,
        quality: rollQuality(pawn, def)
      });
      if (built) {
        built.stuff = stuff;
        built.maxHp = hp;
        built.hp = hp;
        built.faction = 'player';
      }
    }

    markBuildDirty(map, def, x, y, rot, true);
    msg(U.cap(labelOf(def)) + ' built.', { type: 'good', x: x, y: y });
    return built;
  };

  /* Plants under a new building are simply gone; loose items are pushed
     aside so a wall cannot swallow a stack of steel. */
  function clearForBuilding(map, def, x, y, rot) {
    var solid = def.passable === false;
    var f = footprint(def, rot);
    forEachCell(def, x, y, rot, function (cx, cy) {
      var plant = map.plantAt(cx, cy);
      if (plant) map.destroyThing(plant, 'built over');
      if (!solid) return true;
      /* A copy, because moving an item mutates the cell's own list. */
      var items = map.items(cx, cy).slice();
      for (var i = items.length - 1; i >= 0; i--) {
        var spot = spotOutside(map, cx, cy, x, y, f);
        if (spot) map.moveThing(items[i], spot.x, spot.y);
      }
      return true;
    });
  }

  /* Somewhere to put what was lying on the cell: the nearest walkable
     tile that the new building will not itself be standing on, which
     matters the moment the building is more than one tile wide. */
  function spotOutside(map, cx, cy, x, y, f) {
    var ring = U.cellsInRadius(cx, cy, 4);
    for (var i = 0; i < ring.length; i++) {
      var nx = ring[i][0], ny = ring[i][1];
      if (nx >= x && ny >= y && nx < x + f.w && ny < y + f.h) continue;
      if (map.passable(nx, ny)) return { x: nx, y: ny };
    }
    return null;
  }

  /* One place that tells every derived grid a cell changed. Power is
     only rebuilt for things that are actually on a net, because a
     rebuild walks every conduit on the map. */
  function markBuildDirty(map, def, x, y, rot, includePower) {
    forEachCell(def, x, y, rot, function (cx, cy) {
      if (!map.inBounds(cx, cy)) return true;
      map.markPathDirty(cx, cy);
      var R = root.Regions;
      if (R && R.markDirty) R.markDirty(map, cx, cy);
      return true;
    });
    if (!includePower || !def || !def.building) return;
    var b = def.building;
    if (b.powerProduced || b.powerConsumed || b.isConduit || b.isBattery) {
      var P = root.Power;
      if (P && P.markDirty) P.markDirty(map);
    }
  }

  /* ---------- deconstruction ---------- */

  /* Half of five is two and a half, and a colony cannot carry half a
     steel bar. Rounding the fraction into a chance is how RimWorld
     keeps the refund honestly 50% across a whole wall of walls. */
  function roundRandom(v) {
    var floor = Math.floor(v);
    return floor + (U.chance(v - floor) ? 1 : 0);
  }

  Construct.deconstructWork = function (defId) {
    var def = buildDefOf(defId);
    if (!def) return 0;
    return Math.max(20, Math.round((def.workToBuild || 0) * DECONSTRUCT_WORK_FACTOR));
  };

  Construct.canDeconstruct = function (map, x, y) {
    var b = map.buildingAt(x, y);
    if (!b || !b.def) return null;
    if (b.def.mineable || b.def.natural) return null;
    if (b.isBlueprint || b.isFrame) return null;
    if (b.faction !== 'player') return null;
    return b;
  };

  Construct.designateDeconstruct = function (map, x, y) {
    var b = Construct.canDeconstruct(map, x, y);
    if (!b) return false;
    map.designate(b.x, b.y, 'deconstruct', { defId: b.defId });
    return true;
  };

  Construct.completeDeconstruct = function (map, thing, pawn) {
    if (!thing || !thing.spawned) return null;
    var def = thing.def || buildDefOf(thing.defId);
    var x = thing.x, y = thing.y, rot = thing.rot | 0;
    var cost = Construct.totalCost(thing.defId, thing.stuff);

    map.undesignate(x, y, 'deconstruct');
    map.despawnThing(thing);

    var dropped = {};
    for (var k in cost) {
      var n = roundRandom(cost[k] * DECONSTRUCT_REFUND);
      if (n > 0) { map.addItem(k, x, y, n); dropped[k] = n; }
    }
    markBuildDirty(map, def, x, y, rot, true);
    /* Taking out a wall is exactly as bad for the roof as mining one. */
    if (def && def.holdsRoof) Construct.checkRoofCollapse(map, x, y);
    msg(U.cap(labelOf(def)) + ' deconstructed.', { type: 'info', x: x, y: y });
    return dropped;
  };

  /* ---------- mining ---------- */

  Construct.canMine = function (map, x, y) {
    var b = map.buildingAt(x, y);
    return (b && b.def && b.def.mineable) ? b : null;
  };

  Construct.designateMine = function (map, x, y) {
    var wall = Construct.canMine(map, x, y);
    if (!wall) return false;
    map.designate(x, y, 'mine', { defId: wall.defId });
    return true;
  };

  /* Natural walls are not buildable, so their workToBuild is free to
     mean the pick work - which is the 800 the balance table quotes. */
  Construct.mineWork = function (defId) {
    var def = buildDefOf(defId);
    if (def && def.mineable && def.workToBuild) return def.workToBuild;
    return 800;
  };

  Construct.completeMine = function (map, x, y, pawn) {
    var wall = Construct.canMine(map, x, y);
    map.undesignate(x, y, 'mine');
    if (!wall) return null;
    var def = wall.def || buildDefOf(wall.defId);

    map.despawnThing(wall);
    map.setTerrain(x, y, 'rockFloor');

    var dropped = {};
    var yield_ = def.mineYield;
    for (var k in yield_) {
      if (yield_[k] > 0) { map.addItem(k, x, y, yield_[k]); dropped[k] = yield_[k]; }
    }

    map.markPathDirty(x, y);
    var R = root.Regions;
    if (R && R.markDirty) R.markDirty(map, x, y);

    /* That wall was holding a roof up. Ask the neighbourhood whether
       anything still is. */
    Construct.checkRoofCollapse(map, x, y);
    return dropped;
  };

  /* ---------- roofs ---------- */

  /* A finished solid building or a natural wall holds a roof. A frame
     does not: half a wall holds up nothing. */
  Construct.holdsRoof = function (map, x, y) {
    if (!map.inBounds(x, y)) return false;
    var b = map.buildingAt(x, y);
    if (!b || !b.def || b.isBlueprint || b.isFrame) return false;
    return !!(b.def.holdsRoof || b.def.mineable || b.def.natural);
  };

  Construct.roofSupportedAt = function (map, x, y) {
    var r = ROOF_SUPPORT_RADIUS, r2 = r * r;
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        if (Construct.holdsRoof(map, x + dx, y + dy)) return true;
      }
    }
    return false;
  };

  /* Only cells within the support radius of the change can have lost
     their support, so that is the whole area worth re-testing. */
  function collapsePass(map, cx, cy) {
    var r = ROOF_SUPPORT_RADIUS, r2 = r * r;
    var fallen = [];
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        var x = cx + dx, y = cy + dy;
        if (!map.inBounds(x, y)) continue;
        var i = map.idx(x, y);
        if (!map.roof[i]) continue;
        if (Construct.roofSupportedAt(map, x, y)) continue;
        fallen.push(i);
      }
    }
    /* Buildings are collected and hit afterwards: one wider than a tile
       stands under several of the cells that just fell, and it should be
       hit once rather than once per tile. Doing it after the scan also
       means destroying one cannot change what buildingAt reports
       half way through. */
    var hit = [];
    for (var f = 0; f < fallen.length; f++) Construct.collapseRoofAt(map, fallen[f], hit);
    for (var h = 0; h < hit.length; h++) {
      if (hit[h].spawned) hit[h].damage(ROOF_BUILDING_DAMAGE);
    }
    return fallen.length;
  }

  /* map.destroyThing calls back in here whenever something that was
     holding a roof dies, so a collapse that crushes a wall re-enters
     this function. Queueing the follow-up cells and draining them in
     the outermost call keeps a spreading cave-in iterative - and it
     terminates, because every pass strictly removes roof. */
  var collapseQueue = null;

  Construct.checkRoofCollapse = function (map, cx, cy) {
    if (collapseQueue) { collapseQueue.push(cx, cy); return 0; }
    collapseQueue = [];
    var total = 0;
    try {
      total = collapsePass(map, cx, cy);
      while (collapseQueue.length) {
        var qy = collapseQueue.pop(), qx = collapseQueue.pop();
        total += collapsePass(map, qx, qy);
      }
    } finally {
      collapseQueue = null;
    }
    if (total) msg('A section of roof collapsed.', { type: 'threat', x: cx, y: cy });
    return total;
  };

  /* hitList, when given, collects the buildings to damage instead of
     damaging them here; collapsePass passes one so a multi-tile
     building is only crushed once. */
  Construct.collapseRoofAt = function (map, i, hitList) {
    var x = map.xOf(i), y = map.yOf(i);
    if (map.setRoof) map.setRoof(x, y, 0); else map.roof[i] = 0;

    var H = root.Health;
    var pawns = map.pawnsAt(x, y);
    for (var p = pawns.length - 1; p >= 0; p--) {
      if (H && H.damage) {
        H.damage(pawns[p], { amount: ROOF_CRUSH_DAMAGE, type: 'crush', source: 'roof collapse' });
      }
    }

    /* Thing.damage owns what a hit does to a building, including the
       rubble it leaves, so a falling roof goes through the same door as
       a bullet rather than keeping its own arithmetic. */
    var b = map.buildingAt(x, y);
    if (b && b.def && !b.def.mineable) {
      if (hitList) { if (hitList.indexOf(b) < 0) hitList.push(b); }
      else b.damage(ROOF_BUILDING_DAMAGE);
    }
    var plant = map.plantAt(x, y);
    if (plant) map.destroyThing(plant, 'roof collapse');
  };

  /* ---------- repair ---------- */

  Construct.needsRepair = function (thing) {
    if (!thing || !thing.spawned || thing.isBlueprint || thing.isFrame) return false;
    if (thing.faction !== 'player') return false;
    if (!thing.def || thing.def.category !== 'building') return false;
    return (thing.hp || 0) < Construct.maxHp(thing);
  };

  Construct.repair = function (pawn, thing, amount) {
    if (!Construct.needsRepair(thing) || !(amount > 0)) return true;
    var max = Construct.maxHp(thing);
    /* Only the work that went into hp is taught, so handing this a big
       amount to finish a nearly-whole wall is not a free lesson. */
    var healed = Math.min(max - (thing.hp || 0), amount * REPAIR_HP_PER_WORK);
    thing.hp = (thing.hp || 0) + healed;
    gainSkill(pawn, 'construction', (healed / REPAIR_HP_PER_WORK) * XP_PER_WORK);
    return thing.hp >= max;
  };

  /* ============================================================
     JOBS
     Behaviour lives next to the system it belongs to; workgivers.js
     decides who does these and when. Every one of them applies its
     work through the Construct functions above rather than through
     Toils.work, because the failure roll, the xp and the "did it
     finish" answer all live in one place and a toil that only
     accumulates a number cannot ask for them.
     ============================================================ */

  var Jobs = root.Jobs, Toils = root.Toils, T = root.T, Res = root.Res, Path = root.Path;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  function targetThing(job, which, map) {
    var t = job['target' + which];
    return t && T ? T.resolve(t, map) : null;
  }

  function targetPos(job, which, map) {
    var t = job['target' + which];
    return t && T ? T.pos(t, map) : null;
  }

  /* Claim the thing before walking to it, so two constructors do not
     spend a minute each walking to the same frame. */
  function reserveToil(which) {
    return Toils.custom({
      name: 'reserve',
      tick: function (pawn, job) {
        var t = job['target' + which];
        if (!t) return 'fail';
        if (Res && Res.canReserve && !Res.canReserve(pawn, t, 1)) return 'fail';
        if (Res && Res.reserve) Res.reserve(pawn, t, 1);
        return 'next';
      }
    });
  }

  /* --- construct ---
     Two shapes share one job def, exactly as RimWorld does. With a
     targetB it is a delivery run: fetch that stack and put it in the
     blueprint. Without one it is build work on a frame. */
  Jobs.register('construct', {
    label: 'construct',
    reportString: function (job, pawn) {
      var map = pawn && pawn.map;
      var g = targetThing(job, 'A', map);
      var def = g && buildDefOf(g.buildDefId);
      var what = def ? labelOf(def) : 'something';
      return job.targetB ? ('Delivering materials to ' + what) : ('Constructing ' + what);
    },
    toils: function (job) {
      if (job.targetB) {
        return [
          reserveToil('B'),
          Toils.goto('B', { pe: PE.TOUCH, failIfGone: true }),
          Toils.pickUp('B', function (pawn, j) {
            var map = pawn.map;
            var ghost = targetThing(j, 'A', map);
            var item = targetThing(j, 'B', map);
            if (!ghost || !item) return 0;
            var need = Construct.materialsNeeded(ghost)[item.defId] || 0;
            return Math.min(need, item.stack || 1, j.count || Infinity);
          }),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.custom({
            name: 'deliverMaterials',
            tick: function (pawn, j) {
              var map = pawn.map;
              var ghost = targetThing(j, 'A', map);
              var carried = pawn.carried;
              if (!ghost || !carried) return 'fail';
              var took = Construct.deliver(ghost, carried.defId, carried.stack || 1);
              if (took <= 0) return 'fail';
              carried.stack -= took;
              if (carried.stack > 0) {
                /* Someone else topped the blueprint up while we walked.
                   The surplus goes on the floor rather than into a
                   pawn who is about to start something else. */
                map.addItem(carried.defId, pawn.x, pawn.y, carried.stack);
              }
              pawn.carried = null;
              return 'done';
            }
          })
        ];
      }
      return [
        reserveToil('A'),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.custom({
          name: 'build',
          tick: function (pawn, j) {
            var map = pawn.map;
            var frame = targetThing(j, 'A', map);
            if (!frame || !frame.spawned) return 'fail';
            /* A blueprint that lost its materials to a botch is still a
               legal target; it just is not work yet. */
            if (!frame.isFrame) return 'fail';
            var def = buildDefOf(frame.buildDefId);
            var rate = Construct.workRate(pawn, (def && def.buildSkill) || 'construction');
            if (Construct.workOn(pawn, frame, rate)) return 'done';
            return frame.spawned ? 'stay' : 'done';
          }
        })
      ];
    }
  });

  /* --- deconstruct and mine ---
     The same job with different verbs: claim it, walk to it, then pour
     work into it a tick at a time. The running total is written onto
     the thing rather than kept in the toil, so the renderer can draw a
     half-mined tile and a colonist who breaks off to eat does not hand
     the next one a fresh wall. */
  function grindJob(id, spec) {
    Jobs.register(id, {
      label: spec.label,
      reportString: function (job, pawn) {
        var t = targetThing(job, 'A', pawn && pawn.map);
        return spec.verb + ' ' + (t && t.def ? labelOf(t.def) : spec.noun);
      },
      toils: function () {
        return [
          reserveToil('A'),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.custom({
            name: id + 'Work',
            init: function (pawn, job, s) {
              var t = spec.find(job, pawn.map);
              s.total = spec.work(t);
              s.done = (t && t.workDone) || 0;
            },
            tick: function (pawn, job, s) {
              var map = pawn.map;
              var t = spec.find(job, map);
              if (!t) return 'fail';
              var rate = Construct.workRate(pawn, spec.skill);
              s.done += rate;
              t.workDone = s.done;
              gainSkill(pawn, spec.skill, rate * XP_PER_WORK);
              if (s.done < s.total) return 'stay';
              spec.finish(map, t, pawn);
              return 'done';
            }
          })
        ];
      }
    });
  }

  grindJob('deconstruct', {
    label: 'deconstruct', verb: 'Deconstructing', noun: 'building',
    skill: 'construction',
    find: function (job, map) {
      var t = targetThing(job, 'A', map);
      return t && t.spawned ? t : null;
    },
    work: function (t) { return t ? Construct.deconstructWork(t.defId) : 0; },
    finish: function (map, t, pawn) { Construct.completeDeconstruct(map, t, pawn); }
  });

  grindJob('mine', {
    label: 'mine', verb: 'Mining', noun: 'rock',
    skill: 'mining',
    /* Mining resolves through the cell, so a job aimed at a cell works
       exactly like one aimed at the wall standing in it. */
    find: function (job, map) {
      var pos = targetPos(job, 'A', map);
      return pos ? Construct.canMine(map, pos.x, pos.y) : null;
    },
    work: function (t) { return Construct.mineWork(t ? t.defId : null); },
    finish: function (map, t, pawn) { Construct.completeMine(map, t.x, t.y, pawn); }
  });

  /* --- repair --- */
  Jobs.register('repair', {
    label: 'repair',
    reportString: function (job, pawn) {
      var b = targetThing(job, 'A', pawn && pawn.map);
      return 'Repairing ' + (b && b.def ? labelOf(b.def) : 'building');
    },
    toils: function () {
      return [
        reserveToil('A'),
        Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
        Toils.custom({
          name: 'repairWork',
          tick: function (pawn, job) {
            var b = targetThing(job, 'A', pawn.map);
            if (!b || !b.spawned) return 'fail';
            if (!Construct.needsRepair(b)) return 'done';
            var rate = Construct.workRate(pawn, 'construction');
            return Construct.repair(pawn, b, rate) ? 'done' : 'stay';
          }
        })
      ];
    }
  });

  root.Construct = Construct;
})(this);
