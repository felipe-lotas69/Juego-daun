/* ============================================================
   research.js - the tech tree and the runtime that spends work on it.

   Two halves. The top half is data: every research project, what it
   costs, what it needs first and what it opens up. The bottom half is
   the small amount of state a colony carries - which projects are
   finished, which one is being worked on, how far along it is - plus
   the lookup the rest of the game uses to ask "am I allowed to build
   this yet?".

   No DOM, no Game at load time: this file is evaluated before game.js
   exists, so every reference to Game is guarded.
   ============================================================ */
(function (root) {
  'use strict';

  var Defs = root.Defs;
  var U = root.U;

  /* ------------------------------------------------------------------
     The projects.

     Costs are research points. A point is not a tick of work: a pawn
     pours work units into the bench and POINTS_PER_WORK (below) turns
     them into points, which is what keeps a 500-point project a couple
     of in-game hours of study rather than eight seconds of it.

     `unlocks` is display-and-lookup only. The authority on whether a
     thing is buildable is that thing's own `researchPrerequisite` field
     in def_things/def_recipes/def_terrain; these lists name the same
     pairings from the other end so the tree can show them and so
     Research.requiredFor can answer in one hop.

     `uiPosition` is in card cells, not pixels: x is the tier column
     (which equals the depth of the prerequisite chain) and y is the row
     within that column.
     ------------------------------------------------------------------ */
  Defs.add('research', {

    stonecutting: {
      label: 'stonecutting', cost: 500, techLevel: 'neolithic', tab: 'basic',
      description: 'Square off the chunks a mountain gives you for free: blocks for ' +
        'walls that will not burn, and floors that are not mud.',
      prerequisites: [],
      unlocks: ['stonecutterTable', 'cutStoneBlocks', 'stoneFloor', 'concreteFloor'],
      uiPosition: { x: 0, y: 0 }
    },

    tailoring: {
      label: 'tailoring', cost: 600, techLevel: 'neolithic', tab: 'basic',
      description: 'Patterns, needles and a bench to work at. Cloth and leather become ' +
        'clothing that keeps the cold out and the mood up.',
      prerequisites: [],
      unlocks: ['tailoringBench', 'sewShirt', 'sewPants', 'sewJacket', 'sewParka', 'sewHelmet'],
      uiPosition: { x: 0, y: 1 }
    },

    smithing: {
      label: 'smithing', cost: 900, techLevel: 'medieval', tab: 'basic',
      description: 'A hearth, an anvil and the knack of working steel. The smithy is the ' +
        'gateway to every metal thing the colony can make for itself.',
      prerequisites: [],
      unlocks: ['smithy', 'smeltWeapon', 'sewArmorVest'],
      uiPosition: { x: 0, y: 2 }
    },

    electricity: {
      label: 'electricity', cost: 1200, techLevel: 'industrial', tab: 'advanced',
      description: 'Generators, conduit and the lamp at the end of it. Everything ' +
        'industrial the colony will ever own hangs off this one project.',
      prerequisites: [],
      unlocks: ['conduit', 'standingLamp', 'woodGenerator', 'windTurbine'],
      uiPosition: { x: 0, y: 3 }
    },

    firearms: {
      label: 'firearms', cost: 1000, techLevel: 'medieval', tab: 'basic',
      description: 'Rifling, primers, and a pistol you made yourself instead of one you ' +
        'had to pull off a dead raider.',
      prerequisites: ['smithing'],
      unlocks: ['forgePistol'],
      uiPosition: { x: 1, y: 0 }
    },

    medicineProduction: {
      label: 'medicine production', cost: 1100, techLevel: 'medieval', tab: 'basic',
      description: 'Sterile packs worked up from herbal stock and steel. Wounds tended ' +
        'with real medicine close faster and turn septic far less often.',
      prerequisites: ['smithing'],
      unlocks: ['makeMedicine'],
      uiPosition: { x: 1, y: 1 }
    },

    machining: {
      label: 'machining', cost: 1800, techLevel: 'industrial', tab: 'advanced',
      description: 'Lathes and fine tolerances. Components are the fiddly part of every ' +
        'powered building, and this is how you stop buying them from caravans.',
      prerequisites: ['smithing', 'electricity'],
      unlocks: ['makeComponents'],
      uiPosition: { x: 1, y: 2 }
    },

    electricStove: {
      label: 'electric stove', cost: 900, techLevel: 'industrial', tab: 'advanced',
      description: 'A cooking surface that holds its heat: faster meals than a campfire, ' +
        'and the only way to put a fine meal on the table.',
      prerequisites: ['electricity'],
      unlocks: ['stove'],
      uiPosition: { x: 1, y: 3 }
    },

    batteries: {
      label: 'batteries', cost: 800, techLevel: 'industrial', tab: 'advanced',
      description: 'Bank the surplus so the lights stay on at night, and through the calm ' +
        'windless days when nothing at all is turning.',
      prerequisites: ['electricity'],
      unlocks: ['battery'],
      uiPosition: { x: 1, y: 4 }
    },

    solarPower: {
      label: 'solar power', cost: 1000, techLevel: 'industrial', tab: 'advanced',
      description: 'Panels that burn no wood and make no noise, and that produce nothing ' +
        'whatsoever at night or under an eclipse.',
      prerequisites: ['electricity'],
      unlocks: ['solarPanel'],
      uiPosition: { x: 1, y: 5 }
    },

    airConditioning: {
      label: 'air conditioning', cost: 1400, techLevel: 'industrial', tab: 'advanced',
      description: 'Heaters and coolers: a room held at the temperature you chose, through ' +
        'a heat wave, through a cold snap, or over a freezer full of meat.',
      prerequisites: ['electricity'],
      unlocks: ['heater', 'cooler'],
      uiPosition: { x: 1, y: 6 }
    },

    advancedFirearms: {
      label: 'advanced firearms', cost: 3000, techLevel: 'industrial', tab: 'advanced',
      description: 'Machined receivers and bolt actions. A rifle that reaches across the ' +
        'map and hits roughly what it was pointed at.',
      prerequisites: ['firearms', 'machining'],
      unlocks: ['forgeBoltRifle'],
      uiPosition: { x: 2, y: 0 }
    },

    defensiveTurrets: {
      label: 'defensive turrets', cost: 2400, techLevel: 'industrial', tab: 'advanced',
      description: 'An autoloader on a post that shoots back while your colonists are ' +
        'busy, asleep, or bleeding out in the infirmary.',
      prerequisites: ['machining'],
      unlocks: ['turret'],
      uiPosition: { x: 2, y: 1 }
    }

  });

  /* ------------------------------------------------------------------
     Runtime
     ------------------------------------------------------------------ */

  /* Work units to research points. The research toil hands over roughly
     one work unit a tick, so this constant alone sets the pace of the
     whole tree: at 0.08 a skill-8 researcher earns ~0.078 points a tick,
     which is 500 points in about 6400 ticks - two and a half hours of
     game time - and all 16,600 points of the tree in three and a half
     days of somebody doing nothing else. */
  var POINTS_PER_WORK = 0.08;

  /* The research toil pays no xp of its own; it hands the whole
     intellectual payout to addProgress, so the rate here is the
     contract's rate for a work toil, 0.11 xp per work unit. It is paid
     on the work that went into the bench rather than on the points that
     came out: sitting there blind earns fewer points, not less study. */
  var XP_PER_WORK = 0.11;

  var PASSION = [0.35, 1.0, 1.5];

  var Research = {};

  Research.POINTS_PER_WORK = POINTS_PER_WORK;

  Research.done = new Set();
  Research.currentId = null;
  Research.progress = 0;

  /* Points banked per project. Switching away from a half-done project
     and coming back to it later must not lose the work, so progress
     lives per project and Research.progress mirrors the current one. */
  var banked = {};

  /* Rebuilt on the next read after a project finishes. */
  var unlockedCache = null;

  /* Unlock id to the project that lists it. Built once on demand: it is
     derived from def data, which stops changing when the def files have
     all loaded. */
  var reverseIndex = null;

  function defOf(id) { return Defs.maybe('research', id); }

  /* An unlock id may name a thing, a recipe or a terrain - the build
     menu draws all three - so resolve across the three tables. */
  function anyDef(id) {
    return Defs.maybe('thing', id) || Defs.maybe('recipe', id) || Defs.maybe('terrain', id);
  }

  function theGame() {
    return (typeof Game !== 'undefined' && Game) ? Game : (root.Game || null);
  }

  function skillLevel(pawn, id) {
    var s = pawn && pawn.skills && pawn.skills[id];
    return s ? (s.level || 0) : 0;
  }

  /* pawn.js owns levelling; these are the spellings the other systems
     probe for, with the contract's own curve as the last resort. */
  function grantXp(pawn, xp) {
    if (!pawn || !(xp > 0)) return;
    if (typeof pawn.learn === 'function') { pawn.learn('intellectual', xp); return; }
    var P = root.Pawn;
    if (P && typeof P.learn === 'function') { P.learn(pawn, 'intellectual', xp); return; }
    if (P && typeof P.gainXp === 'function') { P.gainXp(pawn, 'intellectual', xp); return; }
    var s = pawn.skills && pawn.skills.intellectual;
    if (!s) return;
    var passion = PASSION[s.passion || 0] || 1;
    s.xp = (s.xp || 0) + xp * passion;
    while (s.level < 20 && s.xp >= 1000 * (s.level + 1)) {
      s.xp -= 1000 * (s.level + 1);
      s.level++;
    }
  }

  Research.projects = function () { return Defs.all('research'); };

  Research.isDone = function (id) { return Research.done.has(id); };

  Research.current = function () {
    return Research.currentId ? defOf(Research.currentId) : null;
  };

  Research.prereqsMet = function (def) {
    if (!def) return false;
    var pre = def.prerequisites || [];
    for (var i = 0; i < pre.length; i++) if (!Research.done.has(pre[i])) return false;
    return true;
  };

  Research.available = function () {
    return Research.projects().filter(function (d) {
      return !Research.done.has(d.id) && Research.prereqsMet(d);
    });
  };

  /* Points banked on a project, whether or not it is the current one.
     The research tab reads this to draw the progress bar. */
  Research.progressOf = function (id) {
    if (id === Research.currentId) return Research.progress;
    if (Research.done.has(id)) { var d = defOf(id); return d ? d.cost : 0; }
    return banked[id] || 0;
  };

  Research.percentOf = function (id) {
    var d = defOf(id);
    if (!d || !d.cost) return 0;
    return U.clamp01(Research.progressOf(id) / d.cost);
  };

  Research.remaining = function (id) {
    var d = defOf(id || Research.currentId);
    if (!d) return 0;
    return Math.max(0, d.cost - Research.progressOf(d.id));
  };

  Research.start = function (id) {
    var def = defOf(id);
    if (!def || Research.done.has(id) || !Research.prereqsMet(def)) return false;
    if (Research.currentId === id) return true;
    if (Research.currentId) banked[Research.currentId] = Research.progress;
    Research.currentId = id;
    Research.progress = banked[id] || 0;
    var g = theGame();
    if (g && g.msg) g.msg('Researching ' + (def.label || id) + '.');
    return true;
  };

  /* Put the bench down without losing the work already done on it. */
  Research.stop = function () {
    if (Research.currentId) banked[Research.currentId] = Research.progress;
    Research.currentId = null;
    Research.progress = 0;
  };

  /* How fast this pawn turns work into points. The caller already scales
     its per-tick amount by the pawn's general work rate, which carries
     the same skill curve, so the full curve applied here as well would
     square it and make a level 20 scientist twenty-five times an
     amateur. What is left is the shallow half of the curve - still a
     real reason to put your smart colonist on the bench - plus sight,
     which no general work rate accounts for and which reading needs.
     Traits stay out of it: their work speed belongs to the pawn's work
     rate, which pawn.js owns. */
  Research.speedFactor = function (pawn) {
    if (!pawn) return 1;
    var f = 0.7 + 0.03 * skillLevel(pawn, 'intellectual');
    var H = root.Health;
    if (H && H.capacity && pawn.health) {
      var sight = H.capacity(pawn, 'sight');
      if (sight < 1) f *= U.clamp(0.4 + 0.6 * sight, 0.4, 1);
    }
    return Math.max(0.05, f);
  };

  /* `amount` is work units, the same unit every other toil spends.
     Returns the points actually banked. */
  Research.addProgress = function (amount, pawn) {
    var id = Research.currentId;
    if (!id || !(amount > 0)) return 0;
    var def = defOf(id);
    if (!def) { Research.currentId = null; Research.progress = 0; return 0; }

    var gain = amount * POINTS_PER_WORK * Research.speedFactor(pawn);
    if (!(gain > 0)) return 0;

    Research.progress += gain;
    banked[id] = Research.progress;
    if (pawn) grantXp(pawn, amount * XP_PER_WORK);
    if (Research.progress >= def.cost) Research.finish(id);
    return gain;
  };

  Research.finish = function (id) {
    var def = defOf(id);
    if (!def || Research.done.has(id)) return false;

    Research.done.add(id);
    delete banked[id];
    if (Research.currentId === id) { Research.currentId = null; Research.progress = 0; }
    unlockedCache = null;

    var g = theGame();
    if (g && g.letter) {
      var names = (def.unlocks || []).map(function (u) {
        var d = anyDef(u);
        return (d && d.label) || u;
      });
      var text = (def.description || '') +
        (names.length ? '\n\nNow available: ' + names.join(', ') + '.' : '') +
        '\n\nPick the next project in the Research tab.';
      g.letter('Research complete: ' + (def.label || id), text, { kind: 'good' });
    }
    return true;
  };

  /* Every unlock named by every finished project. Ids may name a thing,
     a recipe or a terrain; use Research.unlockedIn to narrow. */
  Research.unlockedThings = function () {
    if (unlockedCache) return unlockedCache;
    var seen = {}, out = [];
    Research.projects().forEach(function (d) {
      if (!Research.done.has(d.id)) return;
      (d.unlocks || []).forEach(function (u) {
        if (seen[u]) return;
        seen[u] = 1;
        out.push(u);
      });
    });
    unlockedCache = out;
    return out;
  };

  Research.unlockedIn = function (category) {
    return Research.unlockedThings().filter(function (id) { return Defs.has(category, id); });
  };

  /* The gate the build menu and the bill list ask. A def with no
     prerequisite is always available; an id that names no def at all is
     not, because a build button for a thing that does not exist is worse
     than a missing one. The field may also be an array, in which case
     every project in it has to be finished. */
  Research.isUnlocked = function (thingDef) {
    var def = (typeof thingDef === 'string') ? anyDef(thingDef) : thingDef;
    if (!def) return false;
    var req = def.researchPrerequisite;
    if (!req) return true;
    if (Array.isArray(req)) {
      for (var i = 0; i < req.length; i++) if (!Research.done.has(req[i])) return false;
      return true;
    }
    return Research.done.has(req);
  };

  /* Which project opens this thing, for the "needs Electricity" line on
     a locked build button. Prefers the thing's own field and falls back
     to whichever project lists it as an unlock. */
  Research.requiredFor = function (thingDefId) {
    var def = anyDef(thingDefId);
    var req = def && def.researchPrerequisite;
    if (typeof req === 'string') return defOf(req);
    if (Array.isArray(req) && req.length) {
      for (var i = 0; i < req.length; i++) {
        if (!Research.done.has(req[i])) return defOf(req[i]);
      }
      return defOf(req[req.length - 1]);
    }
    if (!reverseIndex) {
      reverseIndex = {};
      Research.projects().forEach(function (d) {
        (d.unlocks || []).forEach(function (u) {
          if (!reverseIndex[u]) reverseIndex[u] = d.id;
        });
      });
    }
    return reverseIndex[thingDefId] ? defOf(reverseIndex[thingDefId]) : null;
  };

  Research.reset = function () {
    Research.done = new Set();
    Research.currentId = null;
    Research.progress = 0;
    banked = {};
    unlockedCache = null;
  };

  Research.save = function () {
    var out = { done: [], currentId: Research.currentId, progress: Research.progress, banked: {} };
    Research.done.forEach(function (id) { out.done.push(id); });
    Object.keys(banked).forEach(function (id) {
      if (banked[id] > 0 && id !== Research.currentId) out.banked[id] = banked[id];
    });
    return out;
  };

  Research.load = function (obj) {
    Research.reset();
    if (!obj) return;

    /* Ids that no longer exist are dropped rather than trusted: a save
       from an older tree must still load. */
    (obj.done || []).forEach(function (id) {
      if (Defs.has('research', id)) Research.done.add(id);
    });
    var saved = obj.banked || {};
    Object.keys(saved).forEach(function (id) {
      if (Defs.has('research', id) && !Research.done.has(id)) banked[id] = +saved[id] || 0;
    });
    var cur = obj.currentId || null;
    if (cur && Defs.has('research', cur) && !Research.done.has(cur)) {
      Research.currentId = cur;
      Research.progress = (typeof obj.progress === 'number') ? obj.progress : (banked[cur] || 0);
      banked[cur] = Research.progress;
    }
  };

  /* Defs.validate checks prerequisites but not unlocks, so the def
     verifier has this to call instead: every unlock has to name a real
     def, or the tree promises something the colony can never build. */
  Research.validateUnlocks = function () {
    var errors = [];
    Research.projects().forEach(function (d) {
      if (!(d.cost > 0)) errors.push('research/' + d.id + ' has no cost');
      if (!(d.unlocks || []).length) errors.push('research/' + d.id + ' unlocks nothing');
      (d.unlocks || []).forEach(function (u) {
        if (!anyDef(u)) errors.push('research/' + d.id + ' unlocks -> missing thing/recipe/terrain ' + u);
      });
    });
    return errors;
  };

  root.Research = Research;
})(this);
