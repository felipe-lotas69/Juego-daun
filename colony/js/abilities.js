/* ============================================================
   abilities.js - the ability framework, inspirations and skill mastery.

   Three things that share one idea: a colonist is occasionally
   capable of more than their stat block says, and the game should
   let them spend it.

   The framework is deliberately empty of content rules. An ability
   is a spec with a cooldown, a warm-up, a target kind and four
   hooks - requires, cost, pay, effect - and everything else in this
   file is registered through that one door, psycasts included. The
   drafted order menu, the think tree and a headless test all reach
   an ability through Abilities.can/use, so there is exactly one
   place where "may this pawn do this right now" is decided.

   Nothing here edits a file it does not own. Content goes in
   through Defs.add and Health.HEDIFFS, the cast job through
   Jobs.register, the AI levels through the Think.LEVELS array that
   think.js already exports, and the eleven places the engine offers no
   hook at all are reached by keeping and calling the original
   function. Every chain is idempotent and every one of them bails
   in a single property read when the pawn has no ability state,
   which is true of every animal and every raider in the game.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Bound now because they load above this file; anything below it in
     index.html - Game, Save, Trade, Prisoners, Royalty - is fetched by
     name at tick time instead. */
  var T = root.T, Jobs = root.Jobs, Toils = root.Toils, Path = root.Path;

  function sys(name) { return root[name] || null; }
  function now() {
    var G = root.Game;
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  var TICKS_PER_DAY = 60000;
  var TICKS_PER_HOUR = TICKS_PER_DAY / 24;
  var RARE = 250;

  var Abilities = {};

  /* ============================================================
     1. CONTENT

     Two thoughts and two hediffs, added to the tables the files
     that own them already expose. Registration only - nothing here
     touches the world at load.
     ============================================================ */

  Defs.add('thought', {
    inspired: {
      label: 'Inspired', durationDays: 2,
      stages: [{ label: 'Inspired', mood: 8 }]
    },
    rallied: {
      label: 'Rallied', durationDays: 0.5,
      stages: [{ label: 'Rallied', mood: 7 }],
      nullifiedByTrait: ['psychopath']
    },
    masteryEarned: {
      label: 'Mastered a craft', durationDays: 3,
      stages: [{ label: 'Mastered a craft', mood: 6 }]
    },
    pushedTooHard: {
      label: 'Pushed too hard', durationDays: 0.6,
      stages: [{ label: 'Pushed too hard', mood: -5 }]
    },
    wastedInspiration: {
      label: 'Wasted inspiration', durationDays: 1,
      stages: [{ label: 'Wasted inspiration', mood: -4 }],
      nullifiedByTrait: ['ascetic']
    }
  });

  /* Health owns the hediff table and exposes it, so the two halves of
     a second wind are added to it rather than invented as a private
     status. The health tab, the capacity maths and the save file all
     see them without a line of health.js changing. Both have
     severityPerDay 0 because this file drives their clocks itself and
     removes them on the tick they expire - a hediff that decayed on
     its own would linger at severity zero forever. */
  var ABILITY_HEDIFFS = {
    secondWind: {
      id: 'secondWind', label: 'second wind', lethal: false, severityPerDay: 0,
      painOffset: -0.85, capMods: { consciousness: 0.10, moving: 0.10 }
    },
    secondWindCrash: {
      id: 'secondWindCrash', label: 'adrenaline crash', lethal: false, severityPerDay: 0,
      painOffset: 0.12, capMods: { consciousness: -0.20, moving: -0.22, manipulation: -0.18 }
    }
  };

  (function installHediffs() {
    var H = sys('Health');
    if (!H || !H.HEDIFFS) return;
    for (var k in ABILITY_HEDIFFS) if (!H.HEDIFFS[k]) H.HEDIFFS[k] = ABILITY_HEDIFFS[k];
  })();

  /* ============================================================
     2. THE REGISTRY
     ============================================================ */

  var DEFS = {};
  var ORDER = [];

  /* A spec states only what is unusual about it. The defaults below are
     what every consumer reads without a guard, which is why they are all
     filled in here rather than tested for at every call site. */
  Abilities.register = function (spec) {
    if (!spec || !spec.id) return null;
    if (DEFS[spec.id]) return DEFS[spec.id];
    var def = {
      id: spec.id,
      label: spec.label || spec.id,
      description: spec.description || '',
      icon: spec.icon || 'ability',
      source: spec.source || 'colony',
      cooldownTicks: spec.cooldownTicks === undefined ? 0 : spec.cooldownTicks | 0,
      castTicks: spec.castTicks === undefined ? 0 : spec.castTicks | 0,
      range: spec.range === undefined ? 0 : spec.range,
      radius: spec.radius === undefined ? 0 : spec.radius,
      /* A spec that states a range but no target kind means a range: the
         old default of 'self' made resolveTarget answer from the caster's
         own tile and threw the range away without saying so, which is how
         biotech's three gene abilities came to be registered with a range
         of six and no way to point them. */
      targetKind: spec.targetKind || (spec.range > 0 ? 'cell' : 'self'),
      hostileOk: !!spec.hostileOk,
      needsLineOfSight: spec.needsLineOfSight !== false,
      /* An ability with autoGrant learns itself the moment requires()
         first comes back true, which is how a colonist who trains up to
         a doctor's skill discovers the first-aid sprint without anyone
         handing it to them. */
      autoGrant: !!spec.autoGrant,
      requires: typeof spec.requires === 'function' ? spec.requires : null,
      /* requires() answers about the pawn alone; ready() is asked again
         with whatever target can() was handed, which is what a system
         that decides both in one call needs. */
      ready: typeof spec.ready === 'function' ? spec.ready : null,
      cost: typeof spec.cost === 'function' ? spec.cost : null,
      pay: typeof spec.pay === 'function' ? spec.pay : null,
      effect: typeof spec.effect === 'function' ? spec.effect : null,
      aiUse: typeof spec.aiUse === 'function' ? spec.aiUse : null,
      aiPriority: spec.aiPriority === undefined ? 5 : spec.aiPriority,
      /* Which of the two think rungs this one is allowed to interrupt.
         A reflex fires above emergency care and food; everything else
         waits until the pawn would otherwise go to work. See section 9. */
      reflex: !!spec.reflex
    };
    DEFS[def.id] = def;
    ORDER.push(def);
    /* The AI walks the list in priority order, so keep it sorted here
       rather than sorting it on every scan. */
    ORDER.sort(function (a, b) { return a.aiPriority - b.aiPriority; });
    return def;
  };

  Abilities.get = function (id) { return DEFS[id] || null; };
  Abilities.all = function () { return ORDER.slice(); };
  Abilities.ids = function () { return Object.keys(DEFS); };

  /* ============================================================
     3. PER-PAWN STATE

     One plain object, so save.js carries it inside the pawn blob with
     no help from anybody. The field-by-field repair is not paranoia:
     a colony saved before masteries existed loads with an `abilities`
     that has known and cooldowns and nothing else.
     ============================================================ */

  function stateOf(pawn) {
    var st = pawn.abilities;
    if (!st) { st = pawn.abilities = {}; }
    if (!st.known) st.known = [];
    if (!st.cooldowns) st.cooldowns = {};
    if (!st.masteries) st.masteries = {};
    if (!st.timers) st.timers = {};
    if (st.inspiration === undefined) st.inspiration = null;
    return st;
  }

  Abilities.stateOf = function (pawn) { return pawn ? stateOf(pawn) : null; };

  function canHold(pawn) {
    return !!(pawn && pawn.isHuman === true && !pawn.dead);
  }

  Abilities.knows = function (pawn, id) {
    var st = pawn && pawn.abilities;
    return !!(st && st.known && st.known.indexOf(id) >= 0);
  };

  Abilities.grant = function (pawn, id) {
    if (!canHold(pawn) || !DEFS[id]) return false;
    var st = stateOf(pawn);
    if (st.known.indexOf(id) >= 0) return false;
    st.known.push(id);
    return true;
  };

  Abilities.revoke = function (pawn, id) {
    var st = pawn && pawn.abilities;
    if (!st || !st.known) return false;
    var i = st.known.indexOf(id);
    if (i < 0) return false;
    st.known.splice(i, 1);
    /* A colony saved before the cooldown table existed has `known` and
       nothing else, and deleting a key off nothing throws. */
    if (st.cooldowns) delete st.cooldowns[id];
    return true;
  };

  Abilities.cooldownLeft = function (pawn, id) {
    var st = pawn && pawn.abilities;
    if (!st || !st.cooldowns) return 0;
    var ready = st.cooldowns[id] || 0;
    var left = ready - now();
    return left > 0 ? left : 0;
  };

  /* ============================================================
     4. CAN, USE, RESOLVE

     can() answers the target-independent half and, when a target is
     handed to it, the target half as well. The order menu asks it
     without a target to grey out a button; use() asks it with one.
     ============================================================ */

  Abilities.can = function (pawn, id, target) {
    var def = DEFS[id];
    if (!def) return { ok: false, reason: 'no such ability' };
    if (!pawn || pawn.dead) return { ok: false, reason: 'gone' };
    if (pawn.downed) return { ok: false, reason: 'is down' };
    if (!pawn.map) return { ok: false, reason: 'not on a map' };
    if (pawn.mentalState) return { ok: false, reason: 'not in their right mind' };
    if (!Abilities.knows(pawn, id)) return { ok: false, reason: 'has not learned it' };

    var left = Abilities.cooldownLeft(pawn, id);
    if (left > 0) return { ok: false, reason: 'ready in ' + hoursText(left) };

    if (def.requires) {
      var need = def.requires(pawn);
      if (need !== true && need !== undefined) {
        return { ok: false, reason: typeof need === 'string' ? need : 'cannot right now' };
      }
    }
    if (def.cost) {
      var lack = def.cost(pawn);
      if (lack) return { ok: false, reason: typeof lack === 'string' ? lack : 'cannot pay for it' };
    }
    if (target !== undefined) {
      var ctx = resolveTarget(pawn, def, target);
      if (!ctx.ok) return { ok: false, reason: ctx.reason };
    }
    if (def.ready) {
      var verdict = def.ready(pawn, target);
      if (verdict !== true && verdict !== undefined && !(verdict && verdict.ok === true)) {
        var why = typeof verdict === 'string' ? verdict : (verdict && verdict.reason);
        return { ok: false, reason: why || 'cannot right now' };
      }
    }
    return { ok: true, reason: null, def: def };
  };

  Abilities.availableFor = function (pawn) {
    var st = pawn && pawn.abilities;
    if (!st || !st.known || !st.known.length) return [];
    var out = [];
    for (var i = 0; i < st.known.length; i++) {
      var def = DEFS[st.known[i]];
      if (!def) continue;
      var check = Abilities.can(pawn, def.id);
      out.push({ def: def, ok: check.ok, reason: check.reason,
                 cooldownLeft: Abilities.cooldownLeft(pawn, def.id) });
    }
    return out;
  };

  /* Where the ability is pointed, resolved once so neither the range
     test nor the effect has to think about which of the five target
     kinds it was handed. */
  function resolveTarget(pawn, def, target) {
    var map = pawn.map;
    if (!map) return { ok: false, reason: 'not on a map' };
    if (def.targetKind === 'self') {
      return { ok: true, map: map, x: pawn.x, y: pawn.y, pawn: pawn, thing: null };
    }
    if (!target) return { ok: false, reason: 'needs a target' };

    var victim = null, thing = null, pos = null;
    if (target.k === 'p' || target.k === 't') {
      var found = T.resolve(target, map);
      if (!found) return { ok: false, reason: 'the target is gone' };
      pos = { x: found.x, y: found.y };
      if (found.isHuman !== undefined || found.isAnimal !== undefined) victim = found;
      else thing = found;
    } else {
      pos = T.pos(target, map);
    }
    if (!pos || !map.inBounds(pos.x, pos.y)) return { ok: false, reason: 'no such place' };

    if (def.targetKind === 'pawn' && !victim) return { ok: false, reason: 'needs a living target' };
    if (def.targetKind === 'thing' && !thing) return { ok: false, reason: 'needs a thing' };
    if (def.range > 0 && U.dist(pawn.x, pawn.y, pos.x, pos.y) > def.range) {
      return { ok: false, reason: 'out of range' };
    }
    if (def.needsLineOfSight) {
      var C = sys('Combat');
      if (C && C.lineOfSight && !C.lineOfSight(map, pawn.x, pawn.y, pos.x, pos.y)) {
        return { ok: false, reason: 'no line of sight' };
      }
    }
    return { ok: true, map: map, x: pos.x, y: pos.y, pawn: victim, thing: thing };
  }

  Abilities.resolveTarget = function (pawn, id, target) {
    var def = DEFS[id];
    return def ? resolveTarget(pawn, def, target) : { ok: false, reason: 'no such ability' };
  };

  /* The public entry point. With a job system in reach and a warm-up to
     serve, this starts a job so the approach and the cast are visible
     and interruptible; without one - a headless check, an instant
     self-buff - it resolves on the spot. */
  Abilities.use = function (pawn, id, target, opts) {
    opts = opts || {};
    installChains();
    var pre = DEFS[id];
    if (pre && pre.targetKind !== 'self' && !target) {
      return { ok: false, reason: 'needs a target' };
    }
    var check = Abilities.can(pawn, id, target);
    if (!check.ok) return check;
    var def = check.def;

    /* Everything that comes through this door is somebody asking on
       purpose - a player order, a bridge, a test - so it counts as
       forced unless the caller says otherwise, and a forced cast that
       finds nothing is told why rather than locked out. */
    var forced = opts.playerForced !== false;

    var wantsJob = !opts.immediate && Jobs && Jobs.make && pawn.map &&
                   (def.castTicks > 0 || def.range > 0);
    if (!wantsJob) {
      return Abilities.resolve(pawn, id, target,
        { dest: opts.dest || null, playerForced: forced });
    }

    var job = Jobs.make('useAbility', target || null, null, {
      playerForced: forced,
      state: { abilityId: id, dest: opts.dest || null }
    });
    if (!Jobs.start(pawn, job)) return { ok: false, reason: 'could not begin' };
    return { ok: true, reason: null, job: job, def: def, castTicks: def.castTicks };
  };

  /* How long an ability the world refused sits out before the AI is
     allowed to reach for it again. Without this, an aiUse that keeps
     answering "yes" while the effect keeps finding nothing to work on
     re-queues the same cast every AI_RESCAN ticks for as long as the
     condition holds - measured at six useAbility jobs and four failed
     casts in half a day for one colonist, none of which ever set a
     cooldown. A player who clicks the button is told why and is not
     made to wait. */
  var RETRY_TICKS = 2500;

  /* The moment the warm-up ends: check once more, pay, fire, then set
     the cooldown. The effect runs inside a try because a registered
     ability is content and content is allowed to be wrong without
     taking the tick down with it. */
  Abilities.resolve = function (pawn, id, target, opts) {
    opts = opts || {};
    installChains();
    var check = Abilities.can(pawn, id, target === undefined ? undefined : target);
    if (!check.ok) return check;
    var def = check.def;
    var ctx = resolveTarget(pawn, def, target);
    if (!ctx.ok) return { ok: false, reason: ctx.reason };
    ctx.dest = opts.dest || null;
    ctx.def = def;
    ctx.target = target || null;

    var worked = false;
    try {
      worked = def.effect ? !!def.effect(pawn, ctx, ctx.map) : true;
    } catch (e) {
      if (root.Game && root.Game.debug) console.log('[abilities] ' + id + ' threw: ' + e);
      worked = false;
    }
    if (!worked) {
      if (!opts.playerForced) {
        var st = stateOf(pawn);
        var wait = def.cooldownTicks > 0 ? Math.min(def.cooldownTicks, RETRY_TICKS) : RETRY_TICKS;
        st.cooldowns[id] = now() + wait;
      }
      return { ok: false, reason: 'it found nothing to work on' };
    }

    if (def.pay) def.pay(pawn);
    if (def.cooldownTicks > 0) stateOf(pawn).cooldowns[id] = now() + def.cooldownTicks;
    if (pawn.faction === 'player' && def.source === 'colony') {
      message(nameOf(pawn) + ' used ' + def.label + '.', 'info', pawn);
    }
    return { ok: true, reason: null, def: def };
  };

  /* ============================================================
     5. THE CAST JOB

     Walk into range if there is a range to be in, stand still for the
     warm-up, then resolve. Registered additively; jobs.js is untouched.
     ============================================================ */

  Jobs.register('useAbility', {
    label: 'use an ability',
    reportString: function (job) {
      var def = DEFS[job.state.abilityId];
      return 'Using ' + (def ? def.label : 'an ability') + '.';
    },
    allowGoneTarget: true,
    toils: function (job) {
      var def = DEFS[job.state.abilityId];
      if (!def) return null;
      var list = [];
      if (def.range > 0 && def.targetKind !== 'self') list.push(approachToil(def));
      list.push(warmupToil(def));
      return list;
    }
  });

  /* Toils.goto walks onto the target; an ability wants to stop the
     moment it is inside its own range, which is a different arrival
     test and therefore its own toil. */
  function approachToil(def) {
    return Toils.custom({
      name: 'approach',
      init: function (pawn, job, s) { s.ticks = 0; s.cool = 0; s.fails = 0; },
      tick: function (pawn, job, s) {
        var map = pawn.map;
        var target = job.targetA;
        if (!target) return 'next';
        if (!T.valid(target, map)) return 'fail';
        var pos = T.pos(target, map);
        if (!pos) return 'fail';

        var d = U.dist(pawn.x, pawn.y, pos.x, pos.y);
        var los = true;
        if (def.needsLineOfSight) {
          var C = sys('Combat');
          los = !C || !C.lineOfSight || C.lineOfSight(map, pawn.x, pawn.y, pos.x, pos.y);
        }
        if (d <= def.range && los) {
          if (pawn.stopPath) pawn.stopPath();
          return 'next';
        }
        if (++s.ticks > 1200) return 'fail';
        if (s.cool > 0) s.cool--;
        if (!pawn.moving() && s.cool === 0) {
          if (!pawn.startPath(pos.x, pos.y, Path.PE.TOUCH)) {
            return (++s.fails > 1) ? 'fail' : 'stay';
          }
          s.cool = 12; s.fails = 0;
        }
        return 'stay';
      }
    });
  }

  function warmupToil(def) {
    return Toils.custom({
      name: 'warmup',
      init: function (pawn, job, s) {
        s.left = def.castTicks;
        if (pawn.stopPath) pawn.stopPath();
      },
      tick: function (pawn, job, s) {
        var pos = job.targetA ? T.pos(job.targetA, pawn.map) : null;
        if (pos && pawn.faceTo) pawn.faceTo(pos.x, pos.y);
        if (--s.left > 0) return 'stay';
        var out = Abilities.resolve(pawn, def.id, job.targetA,
          { dest: job.state.dest, playerForced: !!job.playerForced });
        if (!out.ok && pawn.faction === 'player') {
          message(nameOf(pawn) + ' could not: ' + out.reason + '.', 'info', pawn);
        }
        /* A cast that resolved into nothing ended in failure, and the job
           driver's own end reason is what think.js reads to decide not to
           hand the same plan straight back. */
        return out.ok ? 'done' : 'fail';
      }
    });
  }

  /* ============================================================
     6. INSPIRATIONS

     The best underused idea in the genre: a colonist in good spirits
     occasionally becomes briefly capable of something they are not
     otherwise capable of, and the colony has a day or two to spend it.

     Five of the eight are one-shot - they are consumed by the action
     they are for, and a colony that never puts the inspired crafter at
     a bench wastes it. Three are windows rather than charges, so they
     are consumed by running out. Either way consumeInspiration() is
     the one exit and it announces itself.
     ============================================================ */

  var INSPIRATIONS = {
    inspiredCreativity: {
      label: 'Inspired creativity', oneShot: true, icon: 'craft',
      text: 'The next thing they make will be a masterwork at worst.',
      weight: function (p) { return 1 + skill(p, 'crafting') * 0.22 + skill(p, 'artistic') * 0.22; }
    },
    workFrenzy: {
      label: 'Work frenzy', oneShot: false, icon: 'work',
      text: 'They are working at half again their usual pace and will not be told to stop.',
      weight: function (p) { return 2 + (hasTrait(p, 'industrious') ? 2 : 0); }
    },
    goGetter: {
      label: 'Go-getter', oneShot: false, icon: 'move',
      text: 'They are moving between jobs like the day is short.',
      weight: function (p) { return 2 + (hasTrait(p, 'jogger') ? 1.5 : 0); }
    },
    inspiredTrade: {
      label: 'Inspired trade', oneShot: true, icon: 'silver',
      text: 'The next deal they negotiate will be one-sided in your favour.',
      weight: function (p) { return skill(p, 'social') >= 6 ? 1 + skill(p, 'social') * 0.18 : 0; }
    },
    inspiredRecruitment: {
      label: 'Inspired recruitment', oneShot: true, icon: 'social',
      text: 'The next prisoner they talk to will very likely come round.',
      weight: function (p) {
        var P = sys('Prisoners');
        if (!P || skill(p, 'social') < 5) return 0;
        return prisonersAround(p) ? 2 + skill(p, 'social') * 0.15 : 0;
      }
    },
    inspiredSurgery: {
      label: 'Inspired surgery', oneShot: true, icon: 'medicine',
      text: 'The next patient they treat will be treated perfectly.',
      weight: function (p) { return skill(p, 'medicine') >= 5 ? 1 + skill(p, 'medicine') * 0.2 : 0; }
    },
    frenzy: {
      label: 'Frenzy', oneShot: false, icon: 'melee',
      text: 'They are fighting without hesitation and without much sense.',
      weight: function (p) {
        return (skill(p, 'melee') >= 6 || hasTrait(p, 'bloodlust') ? 1.5 : 0.3) +
               (hasTrait(p, 'bloodlust') ? 1.5 : 0);
      }
    },
    inspiredTaming: {
      label: 'Inspired taming', oneShot: true, icon: 'animal',
      text: 'The next animal they approach will come to them.',
      weight: function (p) { return skill(p, 'animals') >= 4 ? 1 + skill(p, 'animals') * 0.2 : 0; }
    }
  };

  Abilities.inspirations = function () { return Object.keys(INSPIRATIONS); };
  Abilities.inspirationDef = function (id) { return INSPIRATIONS[id] || null; };

  /* Roughly one inspiration per happy colonist per eight days, which is
     rare enough that the letter is still an event and common enough
     that a colony of six sees one most weeks. */
  var INSPIRE_MOOD_FLOOR = 0.72;
  var INSPIRE_CHANCE_PER_RARE = RARE / (TICKS_PER_DAY * 8);
  var INSPIRE_COOLDOWN = 3 * TICKS_PER_DAY;

  Abilities.inspire = function (pawn, id, opts) {
    opts = opts || {};
    if (!canHold(pawn) || pawn.downed) return null;
    var spec = INSPIRATIONS[id];
    if (!spec) return null;
    var st = stateOf(pawn);
    if (st.inspiration && st.inspiration.endTick > now()) return null;

    var days = opts.days === undefined ? U.randRange(1, 2) : opts.days;
    var t = now();
    st.inspiration = { id: id, startTick: t, endTick: t + Math.round(days * TICKS_PER_DAY) };
    st.lastInspiredTick = t;
    addThought(pawn, 'inspired');
    letter('Inspired: ' + spec.label,
      nameOf(pawn) + ' has been struck by ' + spec.label.toLowerCase() + '. ' + spec.text +
      ' It lasts about ' + (days < 1.5 ? 'a day' : 'two days') + '.',
      'good', pawn);
    return st.inspiration;
  };

  Abilities.inspirationOf = function (pawn) {
    var st = pawn && pawn.abilities;
    var ins = st && st.inspiration;
    if (!ins) return null;
    return ins.endTick > now() ? ins : null;
  };

  /* The hot path. Every chain in section 10 asks this question inside a
     loop that runs per shot, per work tick or per step, so it is three
     property reads and a compare and nothing else. */
  function hasInspiration(pawn, id) {
    var st = pawn.abilities;
    if (!st) return false;
    var ins = st.inspiration;
    return !!(ins && ins.id === id && ins.endTick > now());
  }
  Abilities.hasInspiration = function (pawn, id) {
    return !!pawn && hasInspiration(pawn, id);
  };

  Abilities.consumeInspiration = function (pawn, id, reason) {
    var st = pawn && pawn.abilities;
    var ins = st && st.inspiration;
    if (!ins) return false;
    if (id && ins.id !== id) return false;
    var spec = INSPIRATIONS[ins.id];
    st.inspiration = null;
    st.lastInspiredTick = now();
    if (pawn.faction === 'player' && spec) {
      message(nameOf(pawn) + '\'s ' + spec.label.toLowerCase() + ' ' +
        (reason || 'has been spent') + '.', 'info', pawn);
    }
    return true;
  };

  function tickInspiration(pawn, st) {
    var ins = st.inspiration;
    if (!ins) return;
    if (ins.endTick > now()) return;
    var spec = INSPIRATIONS[ins.id];
    st.inspiration = null;
    st.lastInspiredTick = now();
    /* A window that ran out is nobody's fault; a charge nobody ever
       put in front of a bench is a wasted week. */
    if (spec && spec.oneShot) addThought(pawn, 'wastedInspiration');
    if (pawn.faction === 'player' && spec) {
      message(nameOf(pawn) + '\'s ' + spec.label.toLowerCase() + ' has faded.', 'info', pawn);
    }
  }

  function rollInspiration(pawn, st) {
    if (st.inspiration) return;
    if (pawn.downed || pawn.mentalState || pawn.faction !== 'player') return;
    if (now() - (st.lastInspiredTick || -INSPIRE_COOLDOWN) < INSPIRE_COOLDOWN) return;
    var N = sys('Needs');
    var mood = N && N.mood ? N.mood(pawn) : 0.5;
    if (mood < INSPIRE_MOOD_FLOOR) return;

    /* Happier than the floor pushes the odds up; a saint of a colonist
       at full mood is about twice as likely as one scraping in. */
    var chance = INSPIRE_CHANCE_PER_RARE * (1 + (mood - INSPIRE_MOOD_FLOOR) * 3.5);
    if (!U.chance(chance)) return;

    var ids = Object.keys(INSPIRATIONS);
    var pick = U.pickWeighted(ids, function (id) {
      var w = INSPIRATIONS[id].weight;
      return w ? Math.max(0, w(pawn)) : 1;
    });
    if (pick) Abilities.inspire(pawn, pick);
  }

  function prisonersAround(pawn) {
    var P = sys('Prisoners'), map = pawn.map;
    if (!P || !P.isPrisoner || !map) return false;
    for (var i = 0; i < map.pawns.length; i++) {
      if (map.pawns[i].prisoner && !map.pawns[i].dead) return true;
    }
    return false;
  }

  /* ============================================================
     7. SKILL MASTERY

     The source has nothing between level 15 and level 20 but a bigger
     number, so both are given a name and a permanent edge here, and a
     few of the twenty-level masteries hand over an ability nothing
     else in the game grants.
     ============================================================ */

  var MASTERY_TIER_1 = 15;
  var MASTERY_TIER_2 = 20;

  var MASTERIES = {
    shooting:     ['Steady Hand', 'Deadeye'],
    melee:        ['Close Quarters', 'Blademaster'],
    construction: ['True Line', 'Master Builder'],
    mining:       ['Vein Sense', 'Rockbreaker'],
    cooking:      ['Sure Palate', 'Master Cook'],
    plants:       ['Green Hand', 'Master Grower'],
    animals:      ['Quiet Voice', 'Beast Whisperer'],
    crafting:     ['Fine Touch', 'Master Crafter'],
    artistic:     ['Eye for Form', 'Master Artisan'],
    medicine:     ['Steady Scalpel', 'Master Surgeon'],
    social:       ['Silver Tongue', 'Master Negotiator'],
    intellectual: ['Quick Study', 'Master Scholar']
  };
  var MASTERY_SKILLS = Object.keys(MASTERIES);

  /* Tier two of two skills opens something the pawn could not otherwise
     do at any skill level, which is the point of the whole section. */
  var MASTERY_GRANTS = { intellectual: 'breakthrough', shooting: 'steadyAim' };

  /* The one number every mastery shares: how much better the thing they
     have mastered goes. Deliberately small - this is a late reward on
     top of a work speed that already doubled between level 0 and 20. */
  var MASTERY_BONUS = [0, 0.08, 0.18];

  Abilities.masteryTier = function (pawn, skillId) {
    var st = pawn && pawn.abilities;
    if (!st || !st.masteries) return 0;
    return st.masteries[skillId] | 0;
  };

  Abilities.masteryBonus = function (pawn, skillId) {
    return MASTERY_BONUS[Abilities.masteryTier(pawn, skillId)] || 0;
  };

  Abilities.masteryName = function (skillId, tier) {
    var names = MASTERIES[skillId];
    return (names && tier > 0) ? names[tier - 1] : null;
  };

  Abilities.masteriesOf = function (pawn) {
    var st = pawn && pawn.abilities;
    var out = [];
    if (!st || !st.masteries) return out;
    for (var i = 0; i < MASTERY_SKILLS.length; i++) {
      var s = MASTERY_SKILLS[i], tier = st.masteries[s] | 0;
      if (tier > 0) out.push({ skillId: s, tier: tier, label: Abilities.masteryName(s, tier) });
    }
    return out;
  };

  function checkMasteries(pawn, st) {
    if (!pawn.skills) return;
    for (var i = 0; i < MASTERY_SKILLS.length; i++) {
      var id = MASTERY_SKILLS[i];
      var lvl = skill(pawn, id);
      var want = lvl >= MASTERY_TIER_2 ? 2 : (lvl >= MASTERY_TIER_1 ? 1 : 0);
      var have = st.masteries[id] | 0;
      if (want <= have) continue;
      st.masteries[id] = want;
      var name = Abilities.masteryName(id, want);
      if (want === 2 && MASTERY_GRANTS[id]) Abilities.grant(pawn, MASTERY_GRANTS[id]);
      if (pawn.faction === 'player') {
        addThought(pawn, 'masteryEarned');
        letter(name,
          nameOf(pawn) + ' has reached level ' + lvl + ' in ' + skillLabel(id) + ' and earned ' +
          'the title of ' + name + '. Everything they do with it goes ' +
          Math.round(MASTERY_BONUS[want] * 100) + ' per cent better from here on' +
          (want === 2 && MASTERY_GRANTS[id]
            ? ', and it has taught them ' + labelOf(MASTERY_GRANTS[id]) + '.'
            : '.'),
          'good', pawn);
      }
    }
  }

  /* ============================================================
     8. THE ABILITIES EVERY COLONY HAS

     None of them need an expansion, a psylink or a research project.
     All five are gated on a skill or a trait, and all five learn
     themselves the moment the gate opens.
     ============================================================ */

  Abilities.register({
    id: 'firstAidSprint', label: 'First-aid sprint', icon: 'sprint', autoGrant: true,
    description: 'Drop everything and run. For fifteen seconds the doctor covers ground at ' +
      'twice their usual pace, which is the difference between a tended wound and a grave.',
    cooldownTicks: 20000, castTicks: 0, range: 0, targetKind: 'self', aiPriority: 1, reflex: true,
    requires: function (pawn) {
      if (skill(pawn, 'medicine') < 6) return 'needs medicine 6';
      if (pawn.capable && !pawn.capable('doctor')) return 'is not a doctor';
      return true;
    },
    cost: function (pawn) {
      return need(pawn, 'rest') < 0.15 ? 'is too tired to run' : null;
    },
    pay: function (pawn) {
      if (pawn.needs) pawn.needs.rest = U.clamp01(pawn.needs.rest - 0.02);
    },
    effect: function (pawn) {
      var st = stateOf(pawn);
      st.timers.sprintUntil = now() + 900;
      return true;
    },
    aiUse: function (pawn) {
      /* Only worth the cooldown when the patient is far enough away that
         the run actually buys time. */
      var patient = worstPatient(pawn, 40);
      if (!patient) return null;
      return U.dist(pawn.x, pawn.y, patient.x, patient.y) >= 10 ? true : null;
    }
  });

  Abilities.register({
    id: 'rally', label: 'Rally', icon: 'social', autoGrant: true,
    description: 'Say the right thing to the room. Everyone nearby steadies for half a day, ' +
      'which is often exactly long enough for the reason they were breaking to pass.',
    cooldownTicks: 30000, castTicks: 120, range: 0, targetKind: 'self', aiPriority: 2,
    requires: function (pawn) {
      if (skill(pawn, 'social') < 8) return 'needs social 8';
      if (hasTrait(pawn, 'psychopath')) return 'could not mean a word of it';
      return true;
    },
    effect: function (pawn, ctx, map) {
      var N = sys('Needs');
      if (!N || !N.addThought) return false;
      var list = map.colonists(), n = 0;
      for (var i = 0; i < list.length; i++) {
        var other = list[i];
        if (other === pawn || other.dead) continue;
        if (U.cheb(pawn.x, pawn.y, other.x, other.y) > 10) continue;
        N.addThought(other, 'rallied');
        if (N.gainJoy) N.gainJoy(other, 0.04, 'rally');
        n++;
      }
      if (!n) return false;
      message(nameOf(pawn) + ' found something to say, and ' + n + ' ' +
        U.plural(n, 'colonist') + ' stood a little straighter for it.', 'good', pawn);
      return true;
    },
    aiUse: function (pawn) {
      var N = sys('Needs');
      if (!N || !N.mood || !N.breakThreshold) return null;
      var list = pawn.map.colonists();
      for (var i = 0; i < list.length; i++) {
        var other = list[i];
        if (other === pawn || other.dead) continue;
        if (U.cheb(pawn.x, pawn.y, other.x, other.y) > 10) continue;
        if (N.mood(other) < N.breakThreshold(other, 'minor') + 0.05) return true;
      }
      return null;
    }
  });

  Abilities.register({
    id: 'secondWind', label: 'Second wind', icon: 'heart', autoGrant: true,
    description: 'Shut the pain out for half a minute and pay for it afterwards. The crash ' +
      'is real: slow, clumsy and sore for a minute and a half once the wind runs out.',
    cooldownTicks: TICKS_PER_DAY, castTicks: 60, range: 0, targetKind: 'self', aiPriority: 0,
    reflex: true,
    requires: function (pawn) {
      if (skill(pawn, 'melee') < 8 && !hasTrait(pawn, 'tough') && !hasTrait(pawn, 'ironWilled')) {
        return 'needs melee 8, or to be tough or iron-willed';
      }
      return true;
    },
    cost: function (pawn) {
      var st = pawn.abilities;
      if (st && st.timers && st.timers.crashUntil > now()) return 'is still crashing';
      return null;
    },
    effect: function (pawn) {
      var H = sys('Health');
      if (!H || !H.addHediff) return false;
      H.removeHediff(pawn, 'secondWindCrash');
      H.addHediff(pawn, 'secondWind', 1);
      stateOf(pawn).timers.secondWindUntil = now() + 1800;
      return true;
    },
    aiUse: function (pawn) {
      var H = sys('Health');
      if (!H || !H.painLevel) return null;
      if (H.painLevel(pawn) < 0.45) return null;
      /* Pain only matters if something is still trying to kill them. */
      return nearestHostile(pawn, 18) ? true : null;
    }
  });

  Abilities.register({
    id: 'firebreak', label: 'Firebreak', icon: 'fire', autoGrant: true,
    description: 'Tear out everything that burns inside four tiles, fast. Standing timber is ' +
      'marked for felling instead, because nobody pulls a tree up by hand.',
    cooldownTicks: 15000, castTicks: 240, range: 12, targetKind: 'area', radius: 4,
    needsLineOfSight: false, aiPriority: 1,
    requires: function (pawn) {
      if (skill(pawn, 'plants') < 6 && skill(pawn, 'construction') < 8) {
        return 'needs plants 6 or construction 8';
      }
      return true;
    },
    effect: function (pawn, ctx, map) {
      var cells = U.cellsInRadius(ctx.x, ctx.y, 4), cleared = 0, marked = 0;
      for (var i = 0; i < cells.length; i++) {
        var x = cells[i][0], y = cells[i][1];
        if (!map.inBounds(x, y)) continue;
        var plant = map.plantAt(x, y);
        if (!plant || !plant.def) continue;
        if (plant.def.plant && plant.def.plant.isTree) {
          if (!map.designationAt(x, y)) { map.designate(x, y, 'chop'); marked++; }
          continue;
        }
        map.destroyThing(plant, 'firebreak');
        cleared++;
      }
      if (!cleared && !marked) return false;
      message(nameOf(pawn) + ' cut a firebreak: ' + cleared + ' cleared, ' + marked +
        ' marked for felling.', 'info', pawn);
      return true;
    },
    aiUse: function (pawn) {
      var map = pawn.map;
      if (!map.byDef) return null;
      var fires = map.byDef('fire');
      if (!fires || !fires.length) return null;
      var best = null, bestD = 25;
      for (var i = 0; i < fires.length; i++) {
        var f = fires[i];
        if (!f.spawned) continue;
        var d = U.dist(pawn.x, pawn.y, f.x, f.y);
        if (d < bestD && d > 4) { bestD = d; best = f; }
      }
      if (!best) return null;
      /* Stand the break between the fire and the pawn rather than on top
         of it: cutting inside a fire is how a colonist catches light.
         Measured from the caster so the cell is always inside the range. */
      var step = U.clamp(bestD - 4, 1, 10);
      var x = Math.round(pawn.x + ((best.x - pawn.x) / bestD) * step);
      var y = Math.round(pawn.y + ((best.y - pawn.y) / bestD) * step);
      x = U.clamp(x, 0, map.w - 1); y = U.clamp(y, 0, map.h - 1);
      return T.cell(x, y);
    }
  });

  Abilities.register({
    id: 'animalCall', label: 'Animal call', icon: 'animal', autoGrant: true,
    description: 'Call the colony\'s tame animals in. They break off whatever they were doing ' +
      'and come, and any of them without a master takes this one.',
    cooldownTicks: 20000, castTicks: 90, range: 0, targetKind: 'self', aiPriority: 3, reflex: true,
    requires: function (pawn) {
      return skill(pawn, 'animals') >= 5 ? true : 'needs animals 5';
    },
    effect: function (pawn, ctx, map) {
      var called = tameAnimalsNear(pawn, 20), n = 0;
      for (var i = 0; i < called.length; i++) {
        var beast = called[i];
        if (beast.master === undefined || beast.master === null) beast.master = pawn.id;
        if (beast.job && beast.endJob) beast.endJob('interrupted');
        var job = Jobs.make('goto', T.cell(pawn.x, pawn.y), null, { playerForced: true });
        if (job) { job.state.pe = Path.PE.ADJACENT; if (Jobs.start(beast, job)) n++; }
      }
      if (!n) return false;
      message(nameOf(pawn) + ' called ' + n + ' ' + U.plural(n, 'animal') + ' in.', 'info', pawn);
      return true;
    },
    aiUse: function (pawn) {
      if (!nearestHostile(pawn, 22)) return null;
      return tameAnimalsNear(pawn, 20).length >= 2 ? true : null;
    }
  });

  /* ---------- the two masteries hand these over ---------- */

  Abilities.register({
    id: 'breakthrough', label: 'Breakthrough', icon: 'research',
    description: 'A master scholar sits down with the problem and gets a day\'s study out ' +
      'of one sitting. Granted by the Master Scholar mastery and by nothing else.',
    cooldownTicks: 2 * TICKS_PER_DAY, castTicks: 300, range: 0, targetKind: 'self',
    aiPriority: 6,
    requires: function (pawn) {
      var R = sys('Research');
      if (!R || !R.current || !R.current()) return 'nothing is being researched';
      return skill(pawn, 'intellectual') >= MASTERY_TIER_2 ? true : 'needs intellectual 20';
    },
    effect: function (pawn) {
      var R = sys('Research');
      if (!R || !R.addProgress) return false;
      var project = R.current();
      if (!project) return false;
      /* Work units, the same unit the research toil spends - about a
         fifth of a mid-tier project for a level-twenty scholar. */
      var amount = 2000 * (0.7 + 0.03 * skill(pawn, 'intellectual'));
      var gained = R.addProgress(amount, pawn);
      if (!(gained > 0)) return false;
      letter('A breakthrough',
        nameOf(pawn) + ' saw the shape of it all at once. ' + (project.label || project.id) +
        ' jumped forward.', 'good', pawn);
      return true;
    },
    aiUse: function (pawn) {
      var R = sys('Research');
      return (R && R.current && R.current()) ? true : null;
    }
  });

  Abilities.register({
    id: 'steadyAim', label: 'Steady aim', icon: 'shooting',
    description: 'Ten seconds of breathing and a quarter more hit chance for the next half ' +
      'minute. Granted by the Deadeye mastery and by nothing else.',
    cooldownTicks: TICKS_PER_DAY, castTicks: 120, range: 0, targetKind: 'self', aiPriority: 2,
    reflex: true,
    requires: function (pawn) {
      return skill(pawn, 'shooting') >= MASTERY_TIER_2 ? true : 'needs shooting 20';
    },
    effect: function (pawn) {
      stateOf(pawn).timers.steadyAimUntil = now() + 1800;
      return true;
    },
    aiUse: function (pawn) {
      var foe = nearestHostile(pawn, 30);
      if (!foe) return null;
      return U.dist(pawn.x, pawn.y, foe.x, foe.y) > 6 ? true : null;
    }
  });

  /* ============================================================
     9. THE AI

     aiPick answers "is there an ability worth spending right now",
     using only the cheap tests each aiUse hook makes; aiJob turns the
     answer into a job the think tree can return. The scan is throttled
     per pawn because a colonist with seven abilities and nothing to do
     would otherwise re-ask the same seven questions every think.

     Two answers come out of one scan, because there are two rungs in
     the tree. A reflex - shut the pain out, sprint to the patient,
     steady the aim, call the animals in - belongs above emergency care
     and food, because by the time a colonist has eaten the moment is
     gone. Everything calmer than that does not: a firebreak, a rally
     or a research breakthrough is not worth stepping over a bleeding
     colonist or a hungry one, and at one shared rung above emergency
     it was.
     ============================================================ */

  var AI_RESCAN = 90;

  function scanAbilities(pawn, st) {
    var out = { reflex: null, calm: null, t: 0 };
    for (var i = 0; i < ORDER.length; i++) {
      var def = ORDER[i];
      if (!def.aiUse) continue;
      if (def.reflex ? out.reflex : out.calm) continue;
      if (st.known.indexOf(def.id) < 0) continue;
      if (Abilities.cooldownLeft(pawn, def.id) > 0) continue;
      var check = Abilities.can(pawn, def.id);
      if (!check.ok) continue;

      var want;
      try { want = def.aiUse(pawn); } catch (e) { want = null; }
      if (!want) continue;

      var target = want === true ? null : want;
      var full = Abilities.can(pawn, def.id, target);
      if (!full.ok) continue;

      var pick = { id: def.id, target: target };
      if (def.reflex) out.reflex = pick; else out.calm = pick;
      if (out.reflex && out.calm) break;
    }
    return out;
  }

  /* `kind` is 'reflex', 'calm', or absent for whichever is better. Both
     rungs ask on the same tick, so the scan is kept for that tick and
     the throttle only governs how often it is redone - otherwise the
     first rung to ask would spend the window and the second would be
     told there is nothing, every time. */
  Abilities.aiPick = function (pawn, kind) {
    if (!pawn || pawn.dead || pawn.downed || !pawn.map) return null;
    var st = pawn.abilities;
    if (!st || !st.known || !st.known.length) return null;
    if (pawn.mentalState) return null;

    var t = now();
    var scan = st.aiScan;
    if (!scan || scan.t !== t) {
      if (st.aiNext && t < st.aiNext) return null;
      st.aiNext = t + AI_RESCAN;
      scan = scanAbilities(pawn, st);
      scan.t = t;
      st.aiScan = scan;
    }
    if (kind === 'reflex') return scan.reflex;
    if (kind === 'calm') return scan.calm;
    return scan.reflex || scan.calm;
  };

  /* What think.js calls. Returns a job rather than casting directly so
     the warm-up is interruptible and the tier system can outrank it. */
  Abilities.aiJob = function (pawn, kind) {
    var pick = Abilities.aiPick(pawn, kind);
    if (!pick) return null;
    var job = Jobs.make('useAbility', pick.target || null, null, {
      state: { abilityId: pick.id, dest: null }
    });
    return job;
  };

  /* think.js exports its level list, so the two ability rungs are
     spliced in rather than written into that file. The reflex rung goes
     directly after self-defence and before the fight level - after
     "something is hitting me", before "I go and hit something". The
     calm rung goes directly above work, so an ability the colony would
     merely like still beats hauling and still loses to eating, sleeping
     and a bleeding friend. policies.js splices two rungs the same way,
     for the same reason. */
  var thinkInstalled = false;

  function spliceLevel(Think, level, before, after) {
    var at = -1, i;
    for (i = 0; i < Think.LEVELS.length; i++) {
      if (after && Think.LEVELS[i].name === after) { at = i + 1; break; }
      if (before.indexOf(Think.LEVELS[i].name) >= 0) { at = i; break; }
    }
    if (at < 0) at = Think.LEVELS.length - 1;
    Think.LEVELS.splice(at, 0, level);
  }

  Abilities.installThinkLevel = function () {
    if (thinkInstalled) return true;
    var Think = sys('Think');
    if (!Think || !Think.LEVELS || !Think.TIER) return false;
    for (var i = 0; i < Think.LEVELS.length; i++) {
      if (Think.LEVELS[i].name === 'ability') { thinkInstalled = true; return true; }
    }

    var tier = Think.TIER.ABILITY;
    if (tier === undefined) { tier = 5.45; Think.TIER.ABILITY = tier; }
    spliceLevel(Think,
      { tier: tier, name: 'ability', fn: function (p) { return Abilities.aiJob(p, 'reflex'); } },
      ['fight', 'emergency'], 'defend');

    var calm = Think.TIER.ABILITY_CALM;
    if (calm === undefined) { calm = 9.5; Think.TIER.ABILITY_CALM = calm; }
    spliceLevel(Think,
      { tier: calm, name: 'abilityCalm', fn: function (p) { return Abilities.aiJob(p, 'calm'); } },
      ['work', 'joy', 'idle'], null);

    thinkInstalled = true;
    return true;
  };

  /* ============================================================
     10. THE PER-PAWN TICK

     game.js drives this through its systems registry. Everything in
     it is either a compare against a tick stamp or gated behind the
     contract's rare beat, staggered by pawn id.
     ============================================================ */

  Abilities.tickPawn = function (pawn) {
    if (!pawn || pawn.dead || pawn.isHuman !== true) return;
    installChains();

    var st = pawn.abilities;
    var t = now();

    /* Timed effects come off on the tick they end, so a pawn who is
       neither inspired nor buffed costs one property read. */
    if (st) {
      if (st.inspiration && st.inspiration.endTick <= t) tickInspiration(pawn, st);
      var timers = st.timers;
      if (timers && timers.secondWindUntil && t >= timers.secondWindUntil) {
        timers.secondWindUntil = 0;
        endSecondWind(pawn, st);
      }
      if (timers && timers.crashUntil && t >= timers.crashUntil) {
        timers.crashUntil = 0;
        var H = sys('Health');
        if (H && H.removeHediff) H.removeHediff(pawn, 'secondWindCrash');
      }
    }

    if (((t + pawn.id) % RARE) !== 0) return;
    if (pawn.faction !== 'player') return;

    st = stateOf(pawn);
    checkMasteries(pawn, st);
    autoGrant(pawn, st);
    rollInspiration(pawn, st);
  };

  function endSecondWind(pawn, st) {
    var H = sys('Health');
    if (H) {
      H.removeHediff(pawn, 'secondWind');
      H.addHediff(pawn, 'secondWindCrash', 1);
    }
    st.timers.crashUntil = now() + 4500;
    addThought(pawn, 'pushedTooHard');
    if (pawn.faction === 'player') {
      message(nameOf(pawn) + '\'s second wind ran out.', 'info', pawn);
    }
  }

  function autoGrant(pawn, st) {
    for (var i = 0; i < ORDER.length; i++) {
      var def = ORDER[i];
      if (!def.autoGrant || st.known.indexOf(def.id) >= 0) continue;
      if (def.requires && def.requires(pawn) !== true) continue;
      st.known.push(def.id);
      if (pawn.faction === 'player') {
        message(nameOf(pawn) + ' has learned to use ' + def.label + '.', 'info', pawn);
      }
    }
  }

  /* ============================================================
     11. THE CHAINS

     Eleven functions in seven files have no extension point and none of
     those files may be edited from here, so each original is kept and
     called. Any other expansion that chains the same function
     composes with this one, and every addition bails on a single
     property read when the pawn has no ability state - which is every
     animal, every raider and every colonist who has never been
     inspired or reached a mastery.

     Trade and Prisoners load after this file, so installation is
     deferred to the first tick and retried until it takes.
     ============================================================ */

  var chainsWanted = 9, chainsDone = 0, chainCheck = -1;

  function installChains() {
    if (chainsDone >= chainsWanted) return;
    var t = now();
    /* Retry on the rare beat rather than every tick: the two late
       chains only have to be in before the first trade or the first
       warden shift, both of which are days away. */
    if (chainCheck >= 0 && (t - chainCheck) < RARE) return;
    chainCheck = t;
    chainsDone = 0;
    chainMove();
    chainWork();
    chainQuality();
    chainTend();
    chainRangedHit();
    chainMeleeHit();
    chainTaming();
    chainRecruiting();
    chainTrading();
    Abilities.installThinkLevel();
  }
  Abilities.installChains = function () { chainCheck = -1; installChains(); };

  function done() { chainsDone++; return true; }

  function chainMove() {
    var P = root.Pawn;
    if (!P || !P.prototype) return;
    if (P.prototype.__abilitiesMove) return done();
    var base = P.prototype.moveSpeedFactor;
    if (typeof base !== 'function') return;
    P.prototype.__abilitiesMove = true;
    P.prototype.moveSpeedFactor = function () {
      var f = base.call(this);
      var st = this.abilities;
      if (!st) return f;
      return f * Abilities.moveFactor(this);
    };
    done();
  }

  Abilities.moveFactor = function (pawn) {
    var st = pawn.abilities;
    if (!st) return 1;
    var f = 1, t = now();
    if (st.timers && st.timers.sprintUntil > t) f *= 2;
    if (hasInspiration(pawn, 'goGetter')) f *= 1.4;
    else if (hasInspiration(pawn, 'frenzy')) f *= 1.15;
    return f;
  };

  function chainWork() {
    var P = root.Pawn;
    if (!P || !P.prototype) return;
    if (P.prototype.__abilitiesWork) return done();
    var base = P.prototype.workRate;
    if (typeof base !== 'function') return;
    P.prototype.__abilitiesWork = true;
    P.prototype.workRate = function (skillId) {
      var f = base.call(this, skillId);
      var st = this.abilities;
      if (!st) return f;
      return f * Abilities.workFactor(this, skillId);
    };
    done();
  }

  Abilities.workFactor = function (pawn, skillId) {
    var st = pawn.abilities;
    if (!st) return 1;
    var f = 1 + (skillId ? Abilities.masteryBonus(pawn, skillId) : 0);
    if (hasInspiration(pawn, 'workFrenzy')) f *= 1.5;
    else if (hasInspiration(pawn, 'goGetter')) f *= 1.15;
    return f;
  };

  /* Inspired creativity is spent here, which is the only place in the
     game where a colonist's next crafted thing is decided. */
  function chainQuality() {
    var Pr = sys('Production');
    if (!Pr || !Pr.rollQuality) return;
    if (Pr.__abilitiesQuality) return done();
    var base = Pr.rollQuality;
    Pr.__abilitiesQuality = true;
    Pr.rollQuality = function (pawn, skillId) {
      var st = pawn && pawn.abilities;
      if (!st) return base.call(Pr, pawn, skillId);
      if (hasInspiration(pawn, 'inspiredCreativity')) {
        Abilities.consumeInspiration(pawn, 'inspiredCreativity', 'went into the work');
        return U.chance(0.25) ? 6 : 5;
      }
      var q = base.call(Pr, pawn, skillId);
      /* A master crafter does not roll better dice; they throw away
         fewer bad results. */
      var bonus = Abilities.masteryBonus(pawn, skillId);
      if (bonus > 0 && q < 6 && U.chance(bonus * 1.4)) q++;
      return q;
    };
    done();
  }

  function chainTend() {
    var H = sys('Health');
    if (!H || !H.tendQualityFor) return;
    if (H.__abilitiesTend) return done();
    var base = H.tendQualityFor;
    H.__abilitiesTend = true;
    H.tendQualityFor = function (doctor, medicine) {
      var q = base.call(H, doctor, medicine);
      var st = doctor && doctor.abilities;
      if (!st) return q;
      if (hasInspiration(doctor, 'inspiredSurgery')) {
        Abilities.consumeInspiration(doctor, 'inspiredSurgery', 'went into the treatment');
        return 1;
      }
      return U.clamp01(q + Abilities.masteryBonus(doctor, 'medicine') * 0.6);
    };
    done();
  }

  function chainRangedHit() {
    var C = sys('Combat');
    if (!C || !C.rangedHitChance) return;
    if (C.__abilitiesRanged) return done();
    var base = C.rangedHitChance;
    C.__abilitiesRanged = true;
    C.rangedHitChance = function (shooter, target, weapon, opts) {
      var h = base.call(C, shooter, target, weapon, opts);
      var st = shooter && shooter.abilities;
      if (!st) return h;
      var f = 1 + Abilities.masteryBonus(shooter, 'shooting') * 0.8;
      if (st.timers && st.timers.steadyAimUntil > now()) f *= 1.25;
      return U.clamp01(h * f);
    };
    done();
  }

  function chainMeleeHit() {
    var C = sys('Combat');
    if (!C || !C.meleeHitChance) return;
    if (C.__abilitiesMelee) return done();
    var base = C.meleeHitChance;
    C.__abilitiesMelee = true;
    C.meleeHitChance = function (attacker, target) {
      var h = base.call(C, attacker, target);
      var st = attacker && attacker.abilities;
      if (!st) return h;
      var f = 1 + Abilities.masteryBonus(attacker, 'melee') * 0.8;
      if (hasInspiration(attacker, 'frenzy')) f *= 1.35;
      return U.clamp01(h * f);
    };
    done();
  }

  function chainTaming() {
    var A = sys('Animals');
    if (!A || !A.tameChance) return;
    if (A.__abilitiesTame) return done();
    var base = A.tameChance;
    A.__abilitiesTame = true;
    A.tameChance = function (animal, tamer) {
      var st = tamer && tamer.abilities;
      if (!st) return base.call(A, animal, tamer);
      if (hasInspiration(tamer, 'inspiredTaming')) {
        /* Consumed on the attempt, not on the success: an inspiration
           that survived a failure would never end. */
        Abilities.consumeInspiration(tamer, 'inspiredTaming', 'brought the animal in');
        return 1;
      }
      return U.clamp01(base.call(A, animal, tamer) *
        (1 + Abilities.masteryBonus(tamer, 'animals') * 1.2));
    };
    done();
  }

  function chainRecruiting() {
    var P = sys('Prisoners');
    if (!P || !P.recruitChance) return;
    if (P.__abilitiesRecruit) return done();
    var base = P.recruitChance;
    P.__abilitiesRecruit = true;
    P.recruitChance = function (warden, prisoner) {
      var c = base.call(P, warden, prisoner);
      var st = warden && warden.abilities;
      if (!st) return c;
      if (hasInspiration(warden, 'inspiredRecruitment')) return U.clamp01(Math.max(c * 4, 0.85));
      return U.clamp01(c * (1 + Abilities.masteryBonus(warden, 'social') * 1.2));
    };
    /* The charge is spent when the prisoner actually joins, because
       recruitChance is also what the warden work giver reads to decide
       whether the conversation is worth having. */
    if (P.recruit && !P.__abilitiesRecruited) {
      var baseRecruit = P.recruit;
      P.__abilitiesRecruited = true;
      P.recruit = function (warden, prisoner) {
        var out = baseRecruit.call(P, warden, prisoner);
        if (out && warden && warden.abilities) {
          Abilities.consumeInspiration(warden, 'inspiredRecruitment', 'talked them round');
        }
        return out;
      };
    }
    done();
  }

  /* Trade quotes every row of a deal through Trade.priceOf, but it hands
     that function `socialSkill` and never the pawn, so opts.negotiator -
     the field the price chain below was written against - is undefined at
     both of the only two call sites in the game. Measured: opening a real
     deal with a stocked caravan made one priceOf call and none of them
     carried a negotiator, so inspired trade and the social masteries
     moved nothing. The pawn is known one frame further out, in
     Trade.refresh, so that is where it is picked up and held for the
     length of the rebuild. */
  var dealNegotiator = null;

  function chainTrading() {
    var Tr = sys('Trade');
    if (!Tr || !Tr.priceOf) return;
    if (Tr.__abilitiesTrade) return done();
    var base = Tr.priceOf;
    Tr.__abilitiesTrade = true;

    if (Tr.refresh && !Tr.__abilitiesRefresh) {
      var baseRefresh = Tr.refresh;
      Tr.__abilitiesRefresh = true;
      Tr.refresh = function (deal) {
        var was = dealNegotiator;
        dealNegotiator = (deal && deal.negotiator) || null;
        try { return baseRefresh.call(Tr, deal); }
        finally { dealNegotiator = was; }
      };
    }

    Tr.priceOf = function (defId, opts) {
      var v = base.call(Tr, defId, opts);
      var who = (opts && opts.negotiator) || dealNegotiator;
      var st = who && who.abilities;
      if (!st) return v;
      var edge = Abilities.masteryBonus(who, 'social') * 0.5;
      if (hasInspiration(who, 'inspiredTrade')) edge += 0.22;
      if (edge <= 0) return v;
      /* Better for the colony means cheaper to buy and dearer to sell.
         Rounded back to a whole silver: trade.js quotes integers, the
         basket balance is summed from these and a fractional price puts
         a price of 2.34 in front of the player. */
      var buying = !opts || opts.buying !== false;
      return Math.max(1, Math.round(v * (buying ? Math.max(0.35, 1 - edge) : 1 + edge)));
    };
    if (Tr.confirm && !Tr.__abilitiesConfirm) {
      var baseConfirm = Tr.confirm;
      Tr.__abilitiesConfirm = true;
      Tr.confirm = function (deal) {
        var out = baseConfirm.call(Tr, deal);
        if (out && deal && deal.negotiator && deal.negotiator.abilities) {
          Abilities.consumeInspiration(deal.negotiator, 'inspiredTrade', 'closed the deal');
        }
        return out;
      };
    }
    done();
  }

  /* ============================================================
     12. REGISTERING SOMEBODY ELSE'S ABILITIES

     royalty.js already owns sixteen psycasts, their psyfocus, their
     entropy and their casting rules. It should not hand this file the
     rules - only the list and four functions that answer for it - so
     that psyfocus stays royalty's business and the order menu, the
     think tree and Abilities.can stay one path.

     See the foot of this file for the exact call.
     ============================================================ */

  var TARGET_ALIASES = { any: 'cell', map: 'cell', tile: 'cell', spot: 'cell', none: 'self' };

  Abilities.registerSet = function (opts) {
    opts = opts || {};
    var specs = opts.specs || [];
    var source = opts.source || 'foreign';
    var out = [];
    for (var i = 0; i < specs.length; i++) {
      var spec = specs[i];
      if (!spec || !spec.id) continue;
      out.push(registerOne(spec, source, opts));
    }
    return out;
  };

  function registerOne(spec, source, opts) {
    var extra = typeof opts.translate === 'function' ? (opts.translate(spec) || {}) : {};
    var kind = extra.targetKind || spec.targetKind || spec.target || 'self';
    kind = TARGET_ALIASES[kind] || kind;

    return Abilities.register({
      id: extra.id || spec.id,
      label: extra.label || spec.label || spec.id,
      description: extra.description || spec.description || '',
      icon: extra.icon || spec.icon || source,
      source: source,
      cooldownTicks: extra.cooldownTicks !== undefined ? extra.cooldownTicks : (spec.cooldownTicks || 0),
      castTicks: extra.castTicks !== undefined ? extra.castTicks : (spec.castTicks || 0),
      range: extra.range !== undefined ? extra.range : (spec.range || 0),
      radius: extra.radius !== undefined ? extra.radius : (spec.radius || 0),
      targetKind: kind,
      hostileOk: spec.hostileOk !== undefined ? !!spec.hostileOk : !!extra.hostileOk,
      needsLineOfSight: extra.needsLineOfSight !== false,
      aiPriority: extra.aiPriority === undefined ? 4 : extra.aiPriority,
      /* A foreign set lands on the calm think rung unless its translate
         asks otherwise: the owner knows which of its casts are worth
         stepping over a bleeding colonist for, and this file does not. */
      reflex: !!extra.reflex,

      /* The delegations. Each one is optional: a set that gives no
         `ready` is simply always ready once known, which is the right
         answer for an ability with no resource behind it. */
      requires: function (pawn) {
        if (opts.knows && !opts.knows(pawn, spec)) return 'has not learned it';
        return true;
      },
      ready: opts.ready ? function (pawn, target) {
        return opts.ready(pawn, spec, target === undefined ? null : target);
      } : null,
      effect: function (pawn, ctx, map) {
        if (!opts.invoke) return false;
        var r = opts.invoke(pawn, spec, ctx.target, ctx, map);
        if (r === undefined) return true;
        return r === true || !!(r && r.ok);
      },
      aiUse: opts.aiUse ? function (pawn) { return opts.aiUse(pawn, spec); } : null
    });
  }

  /* The set's own bookkeeping: whoever registered a set owns who knows
     what, so granting is theirs too. This only keeps the known list in
     step so availableFor and the AI see the same abilities the owner
     does. */
  Abilities.syncKnown = function (pawn, source, ids) {
    if (!canHold(pawn)) return 0;
    var st = stateOf(pawn), changed = 0, i;
    var want = {};
    for (i = 0; i < (ids || []).length; i++) want[ids[i]] = 1;
    for (i = st.known.length - 1; i >= 0; i--) {
      var def = DEFS[st.known[i]];
      if (!def || def.source !== source) continue;
      if (!want[def.id]) { st.known.splice(i, 1); changed++; }
      else delete want[def.id];
    }
    for (var id in want) {
      if (DEFS[id]) { st.known.push(id); changed++; }
    }
    return changed;
  };

  /* ============================================================
     13. SAVE

     Per-pawn state rides along inside the pawn blob because it is a
     plain object on the pawn: save.js copies a pawn's own fields with
     plainOwn and hands them back with clone, so known, cooldowns,
     masteries, timers and a live inspiration all survive a round trip
     with no help from this file. Checked field by field.

     save() and load() below are NOT called by save.js - its module list
     is fixed and names research, power, story, world, factions,
     caravans and trade, and adding Abilities to it means editing
     save.js. Nothing is lost by that: the only module-level state here
     is the chain bookkeeping, the chains live on other modules'
     objects and survive a load in the same process, and tickPawn
     re-checks them anyway. They are kept as the hook save.js would
     call if that line is ever added.
     ============================================================ */

  Abilities.save = function () {
    return { v: 1, chainCheck: chainCheck };
  };

  Abilities.load = function (obj) {
    if (!obj) return false;
    /* Force a re-scan: the chains live on other modules' objects and a
       load does not rebuild those, but the think level and the two late
       chains have to be checked again after a restore. */
    chainCheck = -1;
    thinkInstalled = false;
    installChains();
    return true;
  };

  Abilities.reset = function () {
    chainCheck = -1;
    chainsDone = 0;
    installChains();
  };

  /* ============================================================
     14. SMALL HELPERS
     ============================================================ */

  function skill(pawn, id) {
    return pawn && pawn.skillLevel ? pawn.skillLevel(id) : 0;
  }

  function skillLabel(id) {
    var d = Defs.maybe('skill', id);
    return d ? d.label : id;
  }

  function labelOf(abilityId) {
    var d = DEFS[abilityId];
    return d ? d.label : abilityId;
  }

  function hasTrait(pawn, id) {
    return !!(pawn && pawn.traits && pawn.traits.indexOf(id) >= 0);
  }

  function need(pawn, id) {
    return (pawn && pawn.needs && typeof pawn.needs[id] === 'number') ? pawn.needs[id] : 1;
  }

  function nameOf(pawn) {
    if (!pawn) return 'Someone';
    if (pawn.label) return pawn.label();
    var n = pawn.name;
    return (n && (n.nick || n.first)) || 'Someone';
  }

  function hoursText(ticks) {
    var h = ticks / TICKS_PER_HOUR;
    if (h >= 1) return U.fmt(h, 1) + ' hours';
    return Math.max(1, Math.round(ticks / 60)) + ' seconds';
  }

  function addThought(pawn, id) {
    var N = sys('Needs');
    if (N && N.addThought) N.addThought(pawn, id);
  }

  function message(text, type, at) {
    var G = sys('Game');
    if (!G || !G.msg) return;
    G.msg(text, { type: type || 'info', x: at ? at.x : undefined, y: at ? at.y : undefined });
  }

  function letter(title, text, kind, at) {
    var G = sys('Game');
    if (!G || !G.letter) return;
    G.letter(title, text, { kind: kind || 'neutral', x: at ? at.x : undefined, y: at ? at.y : undefined });
  }

  /* The colonist most in need of a doctor, judged off the same two
     numbers think.js uses so the sprint fires for the same patient the
     emergency tier is about to send this pawn to. */
  function worstPatient(pawn, radius) {
    var H = sys('Health'), map = pawn.map;
    if (!H || !map || !map.colonists) return null;
    var list = map.colonists(), best = null, bestScore = 0;
    for (var i = 0; i < list.length; i++) {
      var other = list[i];
      if (other === pawn || other.dead) continue;
      if (U.cheb(pawn.x, pawn.y, other.x, other.y) > radius) continue;
      if (!H.needsTending || !H.needsTending(other)) continue;
      var score = (H.bleedRate ? H.bleedRate(other) : 0) * 4 + (other.downed ? 1 : 0);
      if (score > bestScore) { bestScore = score; best = other; }
    }
    return bestScore > 0.2 ? best : null;
  }

  function nearestHostile(pawn, radius) {
    var map = pawn.map, G = sys('Game');
    if (!map) return null;
    var best = null, bestD = radius;
    for (var i = 0; i < map.pawns.length; i++) {
      var other = map.pawns[i];
      if (other === pawn || other.dead || other.downed) continue;
      if (!G || !G.hostile || !G.hostile(pawn.faction, other.faction)) continue;
      var d = U.dist(pawn.x, pawn.y, other.x, other.y);
      if (d < bestD) { bestD = d; best = other; }
    }
    return best;
  }

  function tameAnimalsNear(pawn, radius) {
    var map = pawn.map, out = [];
    if (!map) return out;
    for (var i = 0; i < map.pawns.length; i++) {
      var a = map.pawns[i];
      if (!a.isAnimal || !a.tame || a.dead || a.downed) continue;
      if (a.faction !== pawn.faction) continue;
      if (U.cheb(pawn.x, pawn.y, a.x, a.y) > radius) continue;
      out.push(a);
    }
    return out;
  }

  /* ============================================================
     WHAT ROYALTY.JS SHOULD CALL

     One call, once, from the foot of royalty.js. Nothing in that file
     changes shape: the psycasts stay where they are, psyfocus and
     entropy stay royalty's to spend, and this file only learns how to
     ask.

       if (root.Abilities) {
         Abilities.registerSet({
           source: 'psycast',
           specs: Royalty.psycasts(),
           translate: function (s) {
             // `reflex: true` would put a cast on the think rung above
             // emergency care and food. Left off, psycasts sit on the calm
             // rung, above work: the player casts them from the order menu
             // and the AI only reaches for one when it has nothing better.
             return { targetKind: s.target, castTicks: s.castTicks, range: s.range,
                      icon: 'psycast', aiPriority: 3 };
           },
           knows: function (pawn, s) { return Royalty.knows(pawn, s.id); },
           ready: function (pawn, s, target) {
             var r = Royalty.canCast(pawn, s.id, target);
             // canCast insists on a target. Asked without one - the order
             // menu greying out a button - only the caster's own readiness
             // is the question.
             if (!r.ok && !target && r.reason === 'needs a target') return true;
             return r;
           },
           invoke: function (pawn, s, target) {
             return Royalty.cast(pawn, s.id, target, { immediate: true });
           }
         });
       }

     and, wherever royalty.js already changes what a pawn knows -
     setPsylink and learnPsycasts - one line to keep the two lists in
     step:

       Abilities.syncKnown(pawn, 'psycast',
         Royalty.psycastsFor(pawn).map(function (d) { return d.id; }));

     The target strings royalty uses ('pawn', 'cell', 'self', 'any')
     are understood as they are; 'any' becomes 'cell'.
     ============================================================ */

  root.Abilities = Abilities;
})(this);
