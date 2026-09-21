/* ============================================================
   statuses.js - one honest answer to "what is wrong with them?",
   and the blood on the floor.

   Three jobs, and they are the same job seen from three distances.

   1. THE VIEW. Ten systems each know one true thing about a colonist -
      health.js the wounds, drugs.js the habit, abilities.js the
      inspiration, biotech.js the pregnancy - and none of them owns the
      sentence a player actually needs, which is "she is bleeding out
      and she is also very drunk". Statuses.of gathers every loaded
      source into one sorted list of one shape; Statuses.summaryLine
      boils it down to the words that fit in a colonist box. Every
      source is reached through typeof, so a game built without
      drugs.js shows a list with no drugs in it rather than throwing.

   2. THE BLOOD. A bleeding pawn leaves a trail across the cells they
      cross, not a tidy pool where they finally fall, which is what
      turns "somebody is hurt" into something you can read off the
      floor and follow. Fresh pools creep outward for a few hours and
      dry into a stain that weathers away outdoors and waits for a mop
      indoors - all of it in the existing map.blood byte grid, with no
      entity per splash. And because a colony that can bleed should be
      able to answer it, blood can be drawn into a pack, stored, and
      put back into somebody who is running out.

   3. THE WARNING. Anything that kills on a clock - blood loss, an
      infection winning its race, hypothermia, a luciferium dependency
      running dry - is measured the same way: how fast is it climbing,
      and how long until it reaches one. That number drives an
      escalating alert, and the first time a colony meets one of these
      the game says in a sentence what it is and what stops it. A death
      the player did not see coming is a bad death.

   Section 5 is the ownership table for the behaviour factors and is
   the important comment here: health.js and drugs.js both publish
   multipliers, some already applied at their call sites and some
   applied nowhere. Statuses applies only the second kind.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;
  var Health = root.Health;

  /* Anything below this file in the load order, or optional entirely,
     is looked up when it is wanted rather than bound at load. */
  function sys(name) {
    var v = root[name];
    return v === undefined ? null : v;
  }

  var TICKS_PER_DAY = 60000;
  var RARE = 250;                  /* the colony-wide rare-tick beat */
  var BEAT = 61;                   /* so this file's rare tick misses health.js's */

  function now() {
    var G = sys('Game');
    return (G && typeof G.tick === 'number') ? G.tick : 0;
  }

  function msg(text, type, pawn) {
    var G = sys('Game');
    if (!G || !G.msg) return;
    G.msg(text, { type: type || 'info', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }

  function letter(title, text, kind, pawn) {
    var G = sys('Game');
    if (G && G.letter) {
      G.letter(title, text, { kind: kind || 'neutral', x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
    } else {
      msg(title, kind === 'threat' ? 'threat' : 'info', pawn);
    }
  }

  function nameOf(pawn) {
    if (pawn && typeof pawn.label === 'function') return pawn.label();
    var n = pawn && pawn.name;
    return (n && (n.nick || n.first)) || 'A colonist';
  }

  function isPerson(pawn) {
    return !!pawn && pawn.isHuman !== false && !pawn.isAnimal;
  }

  function colonist(pawn) {
    return isPerson(pawn) && pawn.faction === 'player' && !pawn.dead;
  }

  var Statuses = {};

  /* ==================================================================
     1. CONTENT

     Registered additively at load: one item, one research project,
     three memories, and two hediffs pushed into health.js's own table
     the way fire.js pushes `burning` into it. Nothing here edits a
     file it does not own.
     ================================================================== */

  /* map.js, zones.js, trade.js and the architect all read fields off an
     item def without guarding, so the template is restated in full
     rather than trusted to a partial literal. */
  var ITEM_DEFAULTS = {
    category: 'item', description: '',
    sprite: 'item', color: '#b0b0b8', color2: null,
    stackLimit: 25, mass: 0.2, marketValue: 10,
    nutrition: 0, foodType: null, rotDays: null,
    isMedicine: false, medicinePotency: 0,
    passable: true, pathCost: 0, fillPercent: 0, blocksLight: false, holdsRoof: false,
    size: Object.freeze({ w: 1, h: 1 }), rotatable: false, hp: 40, flammable: true,
    beauty: 0, comfort: 0, natural: false,
    buildCost: null, stuffable: false, workToBuild: 0, buildSkill: null,
    buildCategory: null, researchPrerequisite: null, recipes: null, leavings: null,
    mineable: false, mineYield: null,
    building: null, weapon: null, apparel: null
  };

  Defs.add('thing', {
    bloodPack: {
      label: 'blood pack',
      description: 'A sealed unit of whole blood, drawn from a colonist who could spare it ' +
        'and labelled with the day. Useless for dressing a wound and the only thing in the ' +
        'colony that helps somebody who has already lost too much.',
      /* Deliberately not isMedicine: a doctor choosing a dressing walks
         the medicine category, and a pack of blood is not a bandage.
         That also keeps it out of the medicine stockpile filter, where
         it would quietly starve the surgeons. */
      sprite: 'medkit', color: '#8b1a1a', color2: '#d8cfc4',
      stackLimit: 10, mass: 0.6, marketValue: 34,
      rotDays: 12, hp: 20, flammable: false,
      researchPrerequisite: 'bloodBanking'
    }
  }, ITEM_DEFAULTS);

  Defs.add('research', {
    bloodBanking: {
      label: 'blood banking', cost: 800, techLevel: 'industrial', tab: 'basic',
      description: 'Anticoagulant, a clean needle and a cold shelf. A healthy colonist can ' +
        'give a unit without missing a day of work, and a colonist bleeding out on the ' +
        'floor stops being a funeral.',
      prerequisites: ['medicineProduction'],
      unlocks: ['bloodPack'],
      uiPosition: { x: 2, y: 6 }
    }
  });

  Defs.add('thought', {
    donatedBlood: {
      label: 'Gave blood', durationDays: 1.5,
      stages: [{ label: 'Gave blood', mood: 4 }],
      nullifiedByTrait: ['psychopath']
    },
    receivedBlood: {
      label: 'Somebody gave me their blood', durationDays: 3,
      stages: [{ label: 'Somebody gave me their blood', mood: 8 }],
      nullifiedByTrait: ['psychopath']
    },
    weakFromBloodLoss: {
      label: 'Weak from blood loss', durationDays: 0.4,
      stages: [
        { label: 'A little light-headed', mood: -3 },
        { label: 'Weak from blood loss', mood: -7 },
        { label: 'Barely conscious', mood: -12 }
      ]
    }
  });

  /* Two conditions health.js has no opinion about. `hypovolemia` is the
     dizziness and the grey hands that come before blood loss kills;
     health.js already bends consciousness and blood pumping with
     bloodLoss, so this one deliberately touches only moving and
     manipulation and leaves consciousness alone. `transfused` is the
     opposite sign - a short window where a patient is stable. */
  var OWN_HEDIFFS = {
    hypovolemia: {
      id: 'hypovolemia', label: 'blood loss', lethal: false, driven: true,
      painOffset: 0.05,
      capMods: { moving: -0.30, manipulation: -0.15 }
    },
    transfused: {
      id: 'transfused', label: 'recent transfusion', lethal: false, driven: true,
      benign: true, painOffset: 0,
      capMods: {}
    }
  };

  var _hediffsInstalled = false;
  function installHediffs() {
    if (_hediffsInstalled) return true;
    var H = sys('Health');
    if (!H || !H.HEDIFFS) return false;
    for (var id in OWN_HEDIFFS) {
      if (!H.HEDIFFS[id]) H.HEDIFFS[id] = OWN_HEDIFFS[id];
    }
    _hediffsInstalled = true;
    return true;
  }
  installHediffs();

  /* ==================================================================
     2. PER-PAWN STATE

     One plain field, `pawn.status`, made of plain values so save.js
     carries it with the rest of the pawn blob without knowing it
     exists. It is created the first time a pawn actually needs one and
     dropped again when it goes empty, so a colony of the untroubled
     costs nothing.

     `pawn.med` belongs to medicine.js and `pawn.drugs` to drugs.js;
     neither is touched from here.
     ================================================================== */

  function state(pawn) {
    var st = pawn.status;
    if (st) return st;
    st = pawn.status = {
      cell: -1,             /* last cell a trail drop was considered for */
      bleed: 0,             /* cached bleed rate, refreshed on the rare tick */
      pallor: 0,            /* 0..1, how grey they look - render may tint by it */
      donate: 0,            /* 0 none, 1 player asked, 2 the colony policy asked */
      lastDonateTick: -999999,
      trend: {},            /* hediff id -> severity at the previous rare tick */
      warned: {}            /* alert key -> escalation level already announced */
    };
    return st;
  }
  Statuses.state = state;

  function stateIsEmpty(st) {
    if (!st) return true;
    if (st.donate || st.bleed > 0 || st.pallor > 0.01) return false;
    var k;
    for (k in st.trend) return false;
    for (k in st.warned) return false;
    return true;
  }

  /* ==================================================================
     3. THE UNIFIED STATUS LIST

     Every entry has the same shape, whichever system it came from:

       {id, label, kind, severity, description, goodBad, source, ticksLeft}

     severity is 0..1 and means "how far along is this", goodBad is
     -1 / 0 / +1, source names the file that owns the truth, and
     ticksLeft is a number or null when the thing has no clock.
     ================================================================== */

  function entry(id, label, kind, severity, description, goodBad, source, ticksLeft) {
    return {
      id: id,
      label: label,
      kind: kind,
      severity: U.clamp01(severity || 0),
      description: description || '',
      goodBad: goodBad === undefined ? -1 : goodBad,
      source: source || 'statuses',
      ticksLeft: ticksLeft === undefined ? null : ticksLeft
    };
  }

  var HEDIFF_NOTES = {
    infection: 'Racing the colonist\'s own immune system. Tending is what decides the race.',
    flu: 'It will pass if they rest and eat; it will not if they do neither.',
    hypothermia: 'They are losing heat faster than they can make it. Get them somewhere warm.',
    heatstroke: 'They are cooking. Shade, a cooler, or anywhere out of the sun.',
    malnutrition: 'They have not eaten in days and the body has started on itself.',
    foodPoisoning: 'A bad meal. Unpleasant, not dangerous, and over within the day.',
    burning: 'They are on fire and will keep burning until somebody beats it out.',
    hypovolemia: 'There is not enough blood left in them to run on. Stop the bleeding first.',
    transfused: 'A unit of donated blood is doing the work their own is not.',
    drugOverdose: 'Too much, too close together. This one kills on its own.',
    chemicalCrash: 'The comedown after a stimulant. It wears off; the tolerance does not.',
    luciferiumWithdrawal: 'The mechanites are eating them. Only another dose stops it.'
  };

  function hediffNote(hd) {
    if (HEDIFF_NOTES[hd.id]) return HEDIFF_NOTES[hd.id];
    if (hd.def && hd.def.deathCause) return 'Left alone, this is what kills them.';
    return '';
  }

  function injuryStatuses(pawn, out) {
    var H = sys('Health');
    var h = pawn.health;
    if (!H || !h || !h.injuries) return;

    var shown = 0;
    for (var i = 0; i < h.injuries.length && shown < 8; i++) {
      var inj = h.injuries[i];
      if (inj.permanent && inj.amount < 4) continue;
      var part = H.part ? H.part(pawn, inj.partId) : null;
      var maxHp = (part && part.maxHp) || 20;
      var bleeding = !inj.tended && inj.bleedRate > 0;
      var label = inj.label + (part ? ' (' + part.label + ')' : '');
      var note = inj.permanent
        ? 'Permanent. It has healed as far as it is going to.'
        : (inj.tended
          ? 'Dressed. It closes on its own from here.'
          : (bleeding ? 'Still bleeding. Until somebody tends it, the blood keeps going out.'
                      : 'Untended. Untended wounds are what infections grow in.'));
      out.push(entry('injury:' + inj.id, label,
        inj.permanent ? 'permanent' : (bleeding ? 'bleeding' : 'injury'),
        U.clamp01(inj.amount / Math.max(1, maxHp)), note, -1, 'health.js', null));
      shown++;
    }

    var missing = H.missingParts ? H.missingParts(pawn) : [];
    for (i = 0; i < missing.length && i < 4; i++) {
      out.push(entry('missing:' + missing[i].id, 'missing ' + missing[i].label, 'missing',
        1, 'Gone for good unless a surgeon fits a replacement.', -1, 'health.js', null));
    }

    if (h.bloodLoss > 0.06) {
      out.push(entry('bloodLoss', 'blood loss ' + U.pct(h.bloodLoss), 'bloodLoss', h.bloodLoss,
        h.bloodLoss > 0.55
          ? 'Past halfway. A transfusion buys time; stopping the bleeding is the cure.'
          : 'They can make this back in a day if nothing else opens up.',
        -1, 'health.js', null));
    }

    var pain = H.painLevel ? H.painLevel(pawn) : (h.pain || 0);
    if (pain > 0.20) {
      out.push(entry('pain', 'in pain', 'pain', pain,
        pain > 0.7 ? 'Enough pain to put them on the floor.' : 'Slows everything they do.',
        -1, 'health.js', null));
    }
  }

  /* Half the hediffs in a finished game are not conditions at all: a
     gene, a growth stage, a bionic settling in. They belong on the list
     - a player wants to know their sniper is shortsighted - but they
     are standing facts about a body, not something to act on today, so
     they are marked and never allowed to shout. The test is what the
     hediff does rather than which file registered it: nothing lethal,
     nothing infectious, nothing on a clock, and no real pain. */
  function chronicHediff(def) {
    if (def.lethal || def.isDisease || def.immunizable || def.driven) return false;
    if (def.severityPerDay) return false;
    return !(def.painOffset > 0.15);
  }

  function hediffStatuses(pawn, out) {
    var h = pawn.health;
    if (!h || !h.hediffs) return;
    for (var i = 0; i < h.hediffs.length; i++) {
      var hd = h.hediffs[i];
      if (!hd.def) continue;
      if (hd.severity < 0.02) continue;
      var benign = hd.def.benign || hd.def.painOffset < 0;
      var kind = chronicHediff(hd.def) ? 'chronic'
               : (hd.def.isDisease ? 'disease' : (benign ? 'drug' : 'hediff'));
      var good = benign && !hd.def.lethal ? 1 : -1;
      var label = hd.def.label;
      if (hd.def.immunizable) {
        label += ' ' + Math.round(hd.severity * 100) + '% / ' +
                 Math.round((hd.immunity || 0) * 100) + '% immune';
      } else if (hd.severity > 0.12) {
        label += ' ' + Math.round(hd.severity * 100) + '%';
      }
      out.push(entry('hediff:' + hd.id, label, kind, hd.severity, hediffNote(hd), good,
        hd.def.isDrugHigh ? 'drugs.js' : 'health.js', null));
    }
  }

  function drugStatuses(pawn, out) {
    var D = sys('Drugs');
    if (!D || !D.addictionReadout) return;
    /* Withdrawal and the highs are already hediffs on health.js's list,
       so only the two things drugs.js keeps to itself come through
       here: the habit, and how close a clean colonist is to one. */
    var rows = D.addictionReadout(pawn) || [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (r.kind === 'withdrawal') continue;
      if (r.kind === 'tolerance' && r.severity === 'none') continue;
      var sev = r.kind === 'addiction' ? 1 : U.clamp01(r.value);
      out.push(entry('drug:' + r.kind + ':' + (r.chem || ''), r.label,
        r.kind === 'addiction' ? 'addiction' : r.kind, sev, r.note || '', -1, 'drugs.js', null));
    }
  }

  function inspirationStatus(pawn, out) {
    var A = sys('Abilities');
    if (!A || !A.inspirationOf) return;
    var ins = A.inspirationOf(pawn);
    if (!ins) return;
    var def = A.inspirationDef ? A.inspirationDef(ins.id) : null;
    out.push(entry('inspiration', (def && def.label) || ins.id, 'inspiration', 1,
      (def && def.text) || 'They are having a very good day.', 1, 'abilities.js',
      Math.max(0, (ins.endTick || 0) - now())));
  }

  function mentalStatus(pawn, out) {
    var ms = pawn.mentalState;
    if (!ms) return;
    var label = (ms.def && ms.def.label) || ms.id;
    out.push(entry('mental', label, 'mental', 1,
      'They have stopped taking orders. It passes; what they break in the meantime does not.',
      -1, 'think.js', ms.ticksLeft === undefined ? null : ms.ticksLeft));
  }

  /* The mood column already exists in needs.js; what it does not do is
     say which two or three memories are actually driving the number. */
  function moodStatuses(pawn, out) {
    var N = sys('Needs');
    if (!N || !N.breakdown || !pawn.thoughts) return;
    var rows = N.breakdown(pawn) || [];
    var shown = 0;
    for (var i = 0; i < rows.length && shown < 4; i++) {
      var r = rows[i];
      if (r.base) continue;
      if (Math.abs(r.value) < 0.025) continue;
      out.push(entry('mood:' + (r.defId || i), r.label, 'mood', U.clamp01(Math.abs(r.value) * 4),
        (r.value > 0 ? 'Worth +' : 'Worth ') + Math.round(r.value * 100) + ' mood.',
        r.value > 0 ? 1 : -1, 'needs.js', null));
      shown++;
    }
  }

  function temperatureStatus(pawn, out) {
    var strain = tempStrain(pawn);
    if (!strain || Math.abs(strain.amount) < 0.08) return;
    out.push(entry('temperature', strain.cold ? 'chilled' : 'sweltering', 'temperature',
      Math.abs(strain.amount),
      strain.cold
        ? 'Colder than they are dressed for. Not hypothermia yet, but they are slowing down.'
        : 'Hotter than they can shed. Not heatstroke yet, but they are slowing down.',
      -1, 'statuses.js', null));
  }

  function optionalStatuses(pawn, out) {
    var F = sys('Fire');
    if (F && F.isBurning && F.isBurning(pawn)) {
      out.push(entry('burning', 'on fire', 'fire', U.clamp01(pawn.burning.sev),
        'Burning. Somebody has to put them out; they will not manage it alone.',
        -1, 'fire.js', null));
    }

    if (pawn.pregnancy) {
      var p = pawn.pregnancy;
      var term = p.term || TICKS_PER_DAY;
      out.push(entry('pregnancy', 'pregnant', 'pregnancy', U.clamp01((p.ticks || 0) / term),
        'Due in about ' + Math.max(0, Math.round((term - (p.ticks || 0)) / TICKS_PER_DAY)) +
        ' days. Keep her fed and out of fights.', 0, 'biotech.js',
        Math.max(0, term - (p.ticks || 0))));
    }

    var S = sys('Slavery');
    if (S && S.suppressionOf && pawn.slave) {
      var sup = S.suppressionOf(pawn);
      out.push(entry('suppression', sup < 0.4 ? 'barely suppressed' : 'suppressed', 'suppression',
        1 - sup, sup < 0.4
          ? 'Low enough that they are looking for a way out, and for anyone who will come with them.'
          : 'Held down. It decays; a warden has to keep topping it up.',
        -1, 'slavery.js', null));
    }

    var psy = pawn.psy;
    if (psy && psy.level > 0) {
      if (psy.entropy > 0.05) {
        out.push(entry('psychic', 'psychic entropy ' + U.pct(psy.entropy), 'psychic',
          U.clamp01(psy.entropy),
          'Heat from casting. Past full it stuns them, so let it drain.', -1, 'royalty.js', null));
      }
      if (psy.focus < 0.9) {
        out.push(entry('psyfocus', 'psyfocus ' + U.pct(psy.focus), 'psychic', 1 - psy.focus,
          'Spent. It comes back with meditation, not with sleep.', 0, 'royalty.js', null));
      }
    }

    var M = sys('Medicine');
    if (M && M.hasPendingOperation && M.hasPendingOperation(pawn)) {
      out.push(entry('surgery', 'waiting for surgery', 'surgery', 0.4,
        'Queued for an operation. They have to be in a bed before a surgeon can start.',
        0, 'medicine.js', null));
    }

    var st = pawn.status;
    if (st && st.donate) {
      out.push(entry('donating', 'donating blood', 'donation', 0.2,
        'On their way to give a unit. It costs them a few hours of feeling weak.',
        1, 'statuses.js', null));
    }
  }

  Statuses.of = function (pawn) {
    var out = [];
    if (!pawn) return out;
    if (pawn.dead) {
      out.push(entry('dead', 'dead', 'dead', 1,
        (pawn.health && pawn.health.deathCause) ? 'Died of ' + pawn.health.deathCause + '.' : '',
        -1, 'health.js', null));
      return out;
    }
    if (pawn.downed) {
      out.push(entry('downed', 'downed', 'downed', 1,
        'They cannot stand. Somebody has to carry them to a bed before anything else helps.',
        -1, 'health.js', null));
    }

    injuryStatuses(pawn, out);
    hediffStatuses(pawn, out);
    drugStatuses(pawn, out);
    temperatureStatus(pawn, out);
    mentalStatus(pawn, out);
    inspirationStatus(pawn, out);
    optionalStatuses(pawn, out);
    if (isPerson(pawn)) moodStatuses(pawn, out);

    /* Bad before good, worse before better, so whatever is about to
       kill them is the first row in every panel that draws this. */
    out.sort(function (a, b) {
      if (a.goodBad !== b.goodBad) return a.goodBad - b.goodBad;
      return b.severity - a.severity;
    });
    return out;
  };

  /* ==================================================================
     4. THE ONE LINE, AND THE ONE COLOUR

     summaryLine is the single most-read string in the UI: it goes in
     the colonist box at the top of the screen, so it answers "do I
     need to do something about this person right now" and nothing
     else. It is deliberately not Statuses.of()[0].label - the ordering
     there is by severity, and a 90% tolerance outranks "bleeding
     badly" on that scale while being worth a fraction of the attention.
     ================================================================== */

  Statuses.summaryLine = function (pawn) {
    if (!pawn) return '';
    if (pawn.dead) return 'dead';

    var H = sys('Health');
    var h = pawn.health;
    var F = sys('Fire');
    if (F && F.isBurning && F.isBurning(pawn)) return 'burning';

    if (h) {
      var bleed = H && H.bleedRate ? H.bleedRate(pawn) : 0;
      var loss = h.bloodLoss || 0;
      if (pawn.downed) {
        if (bleed > 0.05) return 'bleeding out';
        return 'downed';
      }
      if (bleed > 0.28 || (bleed > 0.05 && loss > 0.45)) return 'bleeding badly';

      /* A lethal condition that is winning outranks everything below. */
      var losing = worstRace(pawn);
      if (losing && losing.daysLeft < 1.2) {
        if (losing.key === 'bleeding') return 'bleeding out';
        if (losing.key === 'infection') return 'infection winning';
        return losing.label + ' worsening';
      }
      if (loss > 0.35) return 'pale from blood loss';
      if (bleed > 0.02) return 'bleeding';
    }

    if (pawn.mentalState) {
      return (pawn.mentalState.def && pawn.mentalState.def.label) || pawn.mentalState.id;
    }

    var D = sys('Drugs');
    if (D && D.summary) {
      var drug = D.summary(pawn);
      if (drug) return drug;
    }

    if (h) {
      /* Genes and growth stages are skipped here on purpose: this line
         answers "does somebody need to do something", and being
         shortsighted since birth is not that question. */
      var worst = null;
      for (var i = 0; i < h.hediffs.length; i++) {
        var hd = h.hediffs[i];
        if (!hd.def || hd.def.benign || hd.def.painOffset < 0) continue;
        if (chronicHediff(hd.def)) continue;
        if (!worst || hd.severity > worst.severity) worst = hd;
      }
      if (worst && worst.severity >= 0.12) return worst.def.label;
      if (H && H.painLevel && H.painLevel(pawn) > 0.45) return 'in pain';
      var inj = H && H.worstInjury ? H.worstInjury(pawn) : null;
      if (inj) return inj.label;
      if (worst) return worst.def.label;
    }

    var A = sys('Abilities');
    if (A && A.inspirationOf) {
      var ins = A.inspirationOf(pawn);
      if (ins) {
        var def = A.inspirationDef ? A.inspirationDef(ins.id) : null;
        return (def && def.label) ? def.label.toLowerCase() : 'inspired';
      }
    }

    var strain = tempStrain(pawn);
    if (strain && Math.abs(strain.amount) > 0.25) return strain.cold ? 'cold' : 'overheating';

    return 'healthy';
  };

  /* Every panel that shows a condition colours it from here, so a
     bleeding wound is the same red in the health tab, the colonist box
     and the alert stack. Nothing in the world layer is pure black or
     pure white and neither is this. */
  var BAND_COLOUR = {
    good: '#4fae5a',
    none: '#8d94a1',
    minor: '#d8c56a',
    major: '#e08a3c',
    critical: '#c0392b'
  };
  Statuses.COLOURS = BAND_COLOUR;

  Statuses.severityBand = function (status) {
    if (!status) return 'none';
    if (status.goodBad > 0) return 'good';
    if (status.goodBad === 0) return 'none';
    if (status.kind === 'bleeding' || status.kind === 'fire' || status.kind === 'dead') {
      return status.severity >= 0.35 ? 'critical' : 'major';
    }
    /* A gene, a growth stage or an old scar is worth a row and never
       worth a colour that pulls the eye off somebody who is dying. */
    if (status.kind === 'chronic' || status.kind === 'permanent' || status.kind === 'missing') {
      return status.severity >= 0.5 ? 'minor' : 'none';
    }
    if (status.severity >= 0.75) return 'critical';
    if (status.severity >= 0.40) return 'major';
    if (status.severity >= 0.12) return 'minor';
    return 'none';
  };

  Statuses.severityColour = function (status) {
    return BAND_COLOUR[Statuses.severityBand(status)] || BAND_COLOUR.none;
  };

  /* The colonist box wants a colour for the person, not for one row. */
  Statuses.pawnColour = function (pawn) {
    if (!pawn) return BAND_COLOUR.none;
    if (pawn.dead) return BAND_COLOUR.critical;
    var worst = 'none', list = Statuses.of(pawn);
    var rank = { good: 0, none: 1, minor: 2, major: 3, critical: 4 };
    for (var i = 0; i < list.length; i++) {
      var band = Statuses.severityBand(list[i]);
      if (rank[band] > rank[worst]) worst = band;
    }
    return BAND_COLOUR[worst];
  };

  /* ==================================================================
     5. BEHAVIOUR FACTORS - AND WHO OWNS WHAT

     This is the part that is easy to get wrong twice, so it is written
     down. Three files publish multipliers:

       health.js   moveSpeedFactor / workSpeedFactor, derived from the
                   capacities. APPLIED ALREADY, by pawn.js
                   (moveSpeedFactor, workRate), jobs.js and
                   production.js. Every hediff reaches the game through
                   this - including drugs.js's highs and withdrawals and
                   this file's own hypovolemia, because they are all
                   capMods on a hediff. Statuses must NOT multiply it in
                   again.
       medicine.js implant bonuses. APPLIED ALREADY: medicine.js wraps
                   Health.moveSpeedFactor and Combat.rangedHitChance, so
                   they arrive through health.js and combat.js.
       drugs.js    moveFactor / workFactor / accuracyFactor /
                   socialFactor - the part a capacity cannot express: a
                   boost above baseline, a drunk's ruined aim. APPLIED
                   NOWHERE. Statuses applies these.

     What is left over, and belongs to this file alone:
       - temperature strain short of a hediff. health.js only starts
         hypothermia once the pawn is past their comfortable range for
         long enough; the hour before that is real and nothing models
         it. Suppressed the moment health.js's own hediff exists.
       - a slave dragging their feet at low suppression. slavery.js
         reads suppression for escapes and sale value, never for work.
       - social. Nothing in the game applies a social multiplier at
         all, so the whole of Statuses.socialFactor is new.

     Callers: anything that wants the complete picture multiplies its
     own base by these. They are all 1.0 for a pawn with nothing wrong.
     ================================================================== */

  function comfyRange(pawn) {
    var kind = pawn.kind || {};
    return {
      min: kind.comfyTempMin === undefined ? -10 : kind.comfyTempMin,
      max: kind.comfyTempMax === undefined ? 40 : kind.comfyTempMax
    };
  }

  /* Returns null, or {cold:bool, amount:0..1}. Zero while health.js is
     already running a temperature hediff, because from that point the
     capacity penalties are its business. */
  function tempStrain(pawn) {
    var map = pawn.map;
    if (!map || !map.temperatureAt || pawn.dead) return null;
    var H = sys('Health');
    if (H && H.hasHediff && (H.hasHediff(pawn, 'hypothermia') || H.hasHediff(pawn, 'heatstroke'))) {
      return null;
    }
    var t = map.temperatureAt(pawn.x, pawn.y);
    var range = comfyRange(pawn);
    if (t < range.min) return { cold: true, amount: U.clamp01((range.min - t) / 30) };
    if (t > range.max) return { cold: false, amount: U.clamp01((t - range.max) / 25) };
    return null;
  }
  Statuses.tempStrain = tempStrain;

  function suppressionDrag(pawn) {
    var S = sys('Slavery');
    if (!S || !S.suppressionOf || !pawn.slave) return 1;
    /* Crushed slaves work; resentful ones find reasons not to. */
    return U.lerp(0.72, 1, U.clamp01(S.suppressionOf(pawn)));
  }

  function drugFactor(pawn, which) {
    var D = sys('Drugs');
    if (!D || typeof D[which] !== 'function') return 1;
    var v = D[which](pawn);
    return (typeof v === 'number' && v > 0) ? v : 1;
  }

  Statuses.moveFactor = function (pawn) {
    if (!pawn || pawn.dead) return 0;
    var f = drugFactor(pawn, 'moveFactor');
    var strain = tempStrain(pawn);
    if (strain) f *= 1 - 0.18 * strain.amount;
    return f > 0.05 ? f : 0.05;
  };

  Statuses.workFactor = function (pawn) {
    if (!pawn || pawn.dead) return 0;
    var f = drugFactor(pawn, 'workFactor') * suppressionDrag(pawn);
    var strain = tempStrain(pawn);
    if (strain) f *= 1 - 0.22 * strain.amount;
    return f > 0.05 ? f : 0.05;
  };

  Statuses.accuracyFactor = function (pawn) {
    if (!pawn || pawn.dead) return 0;
    var f = drugFactor(pawn, 'accuracyFactor');
    var strain = tempStrain(pawn);
    /* Shivering hands cost aim; sweating ones cost much less. */
    if (strain && strain.cold) f *= 1 - 0.20 * strain.amount;
    else if (strain) f *= 1 - 0.07 * strain.amount;
    return f > 0.05 ? f : 0.05;
  };

  Statuses.socialFactor = function (pawn) {
    if (!pawn || pawn.dead) return 0;
    var f = drugFactor(pawn, 'socialFactor') * suppressionDrag(pawn);
    var H = sys('Health');
    if (H && H.painLevel) f *= 1 - 0.35 * H.painLevel(pawn);
    if (pawn.health && pawn.health.bloodLoss > 0.3) f *= 1 - 0.3 * pawn.health.bloodLoss;
    return f > 0.05 ? f : 0.05;
  };

  /* ==================================================================
     6. BLOOD

     map.blood is one byte per cell and that is all the storage there
     is, so wet and dry cannot both live in it. The wet pools are a
     short sparse list here instead: a pool creeps outward while it is
     on that list and is capped down to a stain when it comes off,
     after which map.js's own rolling fade weathers it - fast outdoors,
     almost never indoors, which is what leaves a mop's worth of work
     inside the base and nothing outside it.
     ================================================================== */

  var TRAIL_MIN_BLEED = 0.04;      /* below this a wound drips, it does not trail */
  var POOL_WET_TICKS = 9000;       /* about two and a half hours before it dries */
  var POOL_SPREAD_MIN = 70;        /* a byte value worth creeping outward from */
  var STAIN_CAP = 130;             /* what a dried pool settles down to */
  var MAX_POOLS = 360;
  var SPREAD_EVERY = 90;

  var pools = [];                  /* [{i, born}] - wet cells, oldest first */
  var poolAt = Object.create(null);
  var _spreadCursor = 0;

  function notePool(map, i) {
    if (poolAt[i] !== undefined) { poolAt[i] = now(); return; }
    if (pools.length >= MAX_POOLS) {
      var old = pools.shift();
      if (old) { dryPool(map, old.i); delete poolAt[old.i]; }
    }
    pools.push({ i: i, born: now() });
    poolAt[i] = now();
  }

  function dryPool(map, i) {
    if (!map || !map.blood) return;
    if (map.blood[i] > STAIN_CAP) map.blood[i] = STAIN_CAP;
  }

  Statuses.addBlood = function (map, x, y, amount) {
    if (!map || !map.blood || !map.inBounds(x, y) || !(amount > 0)) return;
    var i = map.idx(x, y);
    var v = map.blood[i] + Math.round(amount);
    map.blood[i] = v > 255 ? 255 : v;
    notePool(map, i);
  };

  /* The trail. Called from the hot path, so it does the cheapest thing
     that can rule itself out first: a pawn who has not changed cell
     since the last look costs one integer compare. A cell changes at
     most every thirteen ticks at walking pace, which is how often the
     bleed rate is allowed to cost an array walk. */
  function trailStep(pawn) {
    var map = pawn.map;
    if (!map || !map.blood) return;
    var st = state(pawn);
    var i = map.idx(pawn.x, pawn.y);
    if (st.cell === i) return;
    var first = st.cell < 0;
    st.cell = i;
    if (first) return;

    var H = sys('Health');
    var bleed = H && H.bleedRate ? H.bleedRate(pawn) : 0;
    st.bleed = bleed;
    if (bleed < TRAIL_MIN_BLEED) return;

    /* A light bleed marks every third or fourth cell, a serious one
       marks all of them and marks them heavily. That difference is the
       whole readability of a trail: you can tell at a glance whether
       you are following somebody who is hurt or somebody who is dying. */
    var chance = U.clamp01(0.25 + bleed * 1.6);
    if (!U.chance(chance)) return;
    /* Marks vary in weight, because a trail of identical squares reads
       as a stripe painted on the floor rather than as something that
       dripped there. */
    var amount = (10 + bleed * 90) * U.randRange(0.6, 1.4);
    var v = map.blood[i] + Math.round(amount);
    map.blood[i] = v > 255 ? 255 : v;
    notePool(map, i);
  }

  /* Pools creep. A wet pool above the threshold pushes a little of
     itself into a passable neighbour, which is what turns four cells of
     splashes into one readable shape on the floor. */
  function spreadPools(map) {
    if (!map || !map.blood || !pools.length) return;
    var t = now();
    var slice = Math.max(1, Math.ceil(pools.length / 6));
    for (var n = 0; n < slice; n++) {
      if (_spreadCursor >= pools.length) _spreadCursor = 0;
      var pool = pools[_spreadCursor];
      if (!pool) { pools.splice(_spreadCursor, 1); continue; }

      if (t - pool.born > POOL_WET_TICKS) {
        dryPool(map, pool.i);
        delete poolAt[pool.i];
        pools.splice(_spreadCursor, 1);
        continue;
      }
      _spreadCursor++;

      var v = map.blood[pool.i];
      if (v < POOL_SPREAD_MIN) {
        if (!v) { delete poolAt[pool.i]; pools.splice(--_spreadCursor, 1); }
        continue;
      }
      var dir = U.ADJ4[U.randInt(0, 3)];
      var nx = map.xOf(pool.i) + dir[0], ny = map.yOf(pool.i) + dir[1];
      if (!map.inBounds(nx, ny) || !map.passable(nx, ny)) continue;
      var ni = map.idx(nx, ny);
      var give = Math.min(18, v - 40);
      if (give <= 0) continue;
      if (map.blood[ni] >= v) continue;      /* blood does not flow uphill */
      map.blood[pool.i] = v - give;
      var nv = map.blood[ni] + give;
      map.blood[ni] = nv > 255 ? 255 : nv;
      notePool(map, ni);
    }
  }

  Statuses.wetPoolCount = function () { return pools.length; };

  /* How grey a pawn looks. art.js and render.js may tint a portrait by
     this; nothing in the simulation depends on it. */
  Statuses.pallor = function (pawn) {
    var h = pawn && pawn.health;
    if (!h) return 0;
    return U.clamp01((h.bloodLoss - 0.15) / 0.65);
  };

  /* ==================================================================
     7. BLOOD PACKS

     A colonist with blood to spare gives a unit; the unit sits in a
     stockpile; a doctor puts it into somebody who has run out. The
     whole loop is one item, two jobs and a colony target the player
     sets once.
     ================================================================== */

  var DONATE_COST = 0.22;          /* fraction of total blood a unit costs */
  var DONATE_WORK = 900;
  var DONATE_COOLDOWN = 4 * TICKS_PER_DAY;
  var TRANSFUSE_WORK = 600;
  var TRANSFUSE_GIVES = 0.38;
  var TRANSFUSE_AT = 0.42;         /* blood loss that makes a transfusion worth a job */

  Statuses.blood = { target: 2 };  /* how many packs the colony tries to keep */

  Statuses.bloodBankingKnown = function () {
    var R = sys('Research');
    if (!R || !R.isDone) return true;      /* no research system: no gate */
    return R.isDone('bloodBanking');
  };

  Statuses.packsInColony = function (map) {
    if (!map || !map.byDef) return 0;
    var list = map.byDef('bloodPack') || [];
    var n = 0;
    for (var i = 0; i < list.length; i++) if (list[i].spawned) n += list[i].stack || 1;
    return n;
  };

  Statuses.canDonate = function (pawn) {
    if (!colonist(pawn) || pawn.downed || pawn.mentalState) return false;
    if (!Statuses.bloodBankingKnown()) return false;
    var h = pawn.health;
    if (!h || h.dead) return false;
    if (h.bloodLoss > 0.05) return false;
    var H = sys('Health');
    if (H && H.bleedRate && H.bleedRate(pawn) > 0) return false;
    if (H && H.capacity && H.capacity(pawn, 'consciousness') < 0.6) return false;
    var st = pawn.status;
    if (st && now() - st.lastDonateTick < DONATE_COOLDOWN) return false;
    if (pawn.needs && pawn.needs.food !== undefined && pawn.needs.food < 0.35) return false;
    return true;
  };

  /* The player's own order, from a right-click on a colonist. */
  Statuses.orderDonation = function (pawn) {
    if (!Statuses.canDonate(pawn)) return false;
    state(pawn).donate = 1;
    return true;
  };
  Statuses.cancelDonation = function (pawn) {
    if (pawn && pawn.status) pawn.status.donate = 0;
    return true;
  };

  /* What actually happens when the needle comes out. */
  Statuses.drawBlood = function (pawn) {
    var map = pawn && pawn.map;
    if (!map) return null;
    var h = pawn.health;
    if (!h) return null;
    var st = state(pawn);
    h.bloodLoss = U.clamp01(h.bloodLoss + DONATE_COST);
    st.lastDonateTick = now();
    st.donate = 0;
    var H = sys('Health');
    if (H && H.invalidate) H.invalidate(pawn);
    var N = sys('Needs');
    if (N && N.addThought) N.addThought(pawn, 'donatedBlood');
    var made = map.addItem ? map.addItem('bloodPack', pawn.x, pawn.y, 1) : null;
    msg(nameOf(pawn) + ' gave a unit of blood.', 'good', pawn);
    return (made && made[0]) || null;
  };

  Statuses.needsTransfusion = function (pawn) {
    if (!isPerson(pawn) || pawn.dead) return false;
    if (pawn.faction !== 'player' && !pawn.prisoner && !pawn.slave) return false;
    var h = pawn.health;
    if (!h || h.dead) return false;
    if (h.bloodLoss < TRANSFUSE_AT) return false;
    var H = sys('Health');
    if (H && H.hasHediff && H.hasHediff(pawn, 'transfused')) {
      var hd = H.hediff(pawn, 'transfused');
      if (hd && hd.severity > 0.4) return false;   /* one is already working */
    }
    return true;
  };

  Statuses.transfuse = function (patient, pack, doctor) {
    var h = patient && patient.health;
    if (!h) return false;
    var before = h.bloodLoss;
    h.bloodLoss = Math.max(0, h.bloodLoss - TRANSFUSE_GIVES);
    var H = sys('Health');
    if (H) {
      var hd = H.addHediff(patient, 'transfused', 0.6);
      if (hd) hd.severity = 1;
      if (H.invalidate) H.invalidate(patient);
    }
    syncHypovolemia(patient);
    var N = sys('Needs');
    if (N && N.addThought) N.addThought(patient, 'receivedBlood');
    /* The pack may be lying in a stockpile or already in the doctor's
       hands, and an unspawned stack is not the map's to despawn. */
    if (pack) {
      pack.stack = (pack.stack || 1) - 1;
      if (pack.stack <= 0) {
        if (doctor && doctor.carried === pack) doctor.carried = null;
        var map = patient.map;
        if (pack.spawned && map && map.despawnThing) map.despawnThing(pack);
      }
    }
    msg(nameOf(patient) + ' received a transfusion' +
        (doctor ? ' from ' + nameOf(doctor) : '') + '.', 'good', patient);
    if (before > 0.75) {
      letter('A transfusion', nameOf(patient) + ' was down to a quarter of their blood and is ' +
        'now stable. The wound still has to be closed or this happens again.', 'good', patient);
    }
    return true;
  };

  /* The hediff that makes blood loss visible before it is fatal. Driven
     from here every rare tick rather than by health.js's own hediff
     loop, which only knows how to drive the ones it declared. */
  function syncHypovolemia(pawn) {
    var H = sys('Health');
    var h = pawn.health;
    if (!H || !h || !H.HEDIFFS || !H.HEDIFFS.hypovolemia) return;
    var loss = h.bloodLoss || 0;
    var want = loss <= 0.30 ? 0 : U.clamp01((loss - 0.30) / 0.65);
    var hd = H.hediff(pawn, 'hypovolemia');
    if (want <= 0) {
      if (hd) H.removeHediff(pawn, 'hypovolemia');
      return;
    }
    if (!hd) hd = H.addHediff(pawn, 'hypovolemia', want);
    if (!hd) return;
    hd.severity = want;
    if (H.invalidate) H.invalidate(pawn);
  }

  /* ==================================================================
     8. WARNINGS THAT ESCALATE

     Everything lethal in this game is the same shape underneath: a
     number climbing toward one on a clock. Blood loss climbs at the
     bleed rate, an infection climbs at its severity rate minus the
     immunity chasing it, hypothermia climbs while the pawn is cold, a
     luciferium withdrawal climbs and never stops. So the measurement is
     one function - how fast did this move since last time, and at that
     speed, how long until it arrives - and every lethal condition gets
     the same escalating alert out of it without being special-cased.
     ================================================================== */

  var BANDS = [
    { level: 3, days: 0.12, band: 'critical' },   /* under three hours */
    { level: 2, days: 0.40, band: 'major' },
    { level: 1, days: 1.20, band: 'minor' }
  ];

  var EXPLANATIONS = {
    bleeding: 'A bleeding colonist loses blood until somebody tends the wound - at a hundred ' +
      'per cent lost they die, so tending is the cure and a blood pack only buys time.',
    infection: 'An infection and the colonist\'s immune system are in a race: tending with ' +
      'medicine, rest in a bed and a full stomach are the three things that make immunity win.',
    flu: 'The flu races the immune system the same way an infection does, and bed rest is most ' +
      'of the answer.',
    hypothermia: 'A colonist colder than they are dressed for keeps getting colder; a heated ' +
      'room, a parka, or a fire stops it, and nothing else will.',
    heatstroke: 'A colonist hotter than they can shed keeps getting hotter; shade, a cooler or ' +
      'simply going indoors stops it.',
    malnutrition: 'They have run out of food and started on themselves. Anything edible, now.',
    drugOverdose: 'An overdose does not wear off in time on its own - keep them still and ' +
      'hope, and stop handing them the bottle.',
    luciferiumWithdrawal: 'Luciferium withdrawal is not survivable. Only another dose stops ' +
      'it, and the next one after that.',
    bloodStock: 'Blood packs are drawn from healthy colonists and keep a bleeding one alive ' +
      'long enough for a doctor to reach them.'
  };
  Statuses.explain = function (key) { return EXPLANATIONS[key] || ''; };

  function bandFor(daysLeft) {
    for (var i = 0; i < BANDS.length; i++) if (daysLeft <= BANDS[i].days) return BANDS[i];
    return null;
  }

  /* The worst clock running on one pawn, or null. */
  function worstRace(pawn) {
    var out = null;
    var races = racesOn(pawn);
    for (var i = 0; i < races.length; i++) {
      if (!out || races[i].daysLeft < out.daysLeft) out = races[i];
    }
    return out;
  }
  Statuses.worstRace = worstRace;

  function racesOn(pawn) {
    var out = [];
    var h = pawn && pawn.health;
    if (!h || h.dead) return out;
    var H = sys('Health');

    var bleed = H && H.bleedRate ? H.bleedRate(pawn) : 0;
    if (bleed > 0.01) {
      out.push({
        key: 'bleeding', label: 'bleeding', severity: h.bloodLoss,
        daysLeft: (1 - h.bloodLoss) / bleed, pawn: pawn
      });
    }

    var st = pawn.status;
    for (var i = 0; i < h.hediffs.length; i++) {
      var hd = h.hediffs[i];
      if (!hd.def || !hd.def.lethal) continue;
      var prev = st && st.trend ? st.trend[hd.id] : undefined;
      var rate;
      if (prev === undefined) {
        /* No history yet: fall back on what the def promises, minus the
           immunity chasing it, so a fresh infection still reads as a
           race rather than as nothing. */
        rate = (hd.def.severityPerDay || 0.2) -
               (hd.def.immunizable ? (h.immunityGain || 0.3) : 0);
      } else {
        rate = (hd.severity - prev) / (RARE / TICKS_PER_DAY);
      }
      if (!(rate > 0.0005)) continue;
      out.push({
        key: hd.id, label: hd.def.label, severity: hd.severity,
        daysLeft: (1 - hd.severity) / rate, pawn: pawn
      });
    }
    return out;
  }
  Statuses.racesOn = racesOn;

  var _alerts = [];
  var _alertTick = -99999;
  var _explained = Object.create(null);

  /* The first time a colony ever meets one of these, it gets a sentence
     saying what it is and what stops it. Exactly once, ever. */
  function explainOnce(key, label, pawn) {
    if (_explained[key]) return;
    var text = EXPLANATIONS[key];
    if (!text) return;
    _explained[key] = 1;
    letter('What ' + (label || key) + ' means', text,
      key === 'bloodStock' ? 'neutral' : 'threat', pawn);
  }

  function escalate(pawn, race, band) {
    var st = state(pawn);
    var had = st.warned[race.key] || 0;
    if (band.level <= had) return;
    st.warned[race.key] = band.level;
    explainOnce(race.key, race.label, pawn);

    var hours = Math.max(1, Math.round(race.daysLeft * 24));
    var who = nameOf(pawn);
    if (band.level >= 3) {
      letter(who + ' is dying',
        who + ' has about ' + hours + ' hour' + (hours === 1 ? '' : 's') + ' left from ' +
        race.label + '. This is the last warning you get.', 'threat', pawn);
    } else if (band.level === 2) {
      letter(who + ': ' + race.label + ' is winning',
        who + ' will die of ' + race.label + ' within about ' + hours + ' hours unless ' +
        'somebody does something about it.', 'threat', pawn);
    } else {
      msg(who + '\'s ' + race.label + ' is getting worse.', 'threat', pawn);
    }
  }

  function clearWarnings(pawn) {
    var st = pawn.status;
    if (!st || !st.warned) return;
    var races = racesOn(pawn), live = Object.create(null), i;
    for (i = 0; i < races.length; i++) live[races[i].key] = 1;
    for (var k in st.warned) if (!live[k]) delete st.warned[k];
  }

  /* Recomputed on a slow beat and cached: ui.js may ask every frame. */
  Statuses.alerts = function (force) {
    var t = now();
    if (!force && t - _alertTick < 120) return _alerts;
    _alertTick = t;
    var G = sys('Game');
    var out = [];
    if (!G || !G.colonists) { _alerts = out; return out; }

    var list = G.colonists();
    for (var i = 0; i < list.length; i++) {
      var pawn = list[i];
      if (!pawn || pawn.dead) continue;
      var races = racesOn(pawn);
      for (var j = 0; j < races.length; j++) {
        var band = bandFor(races[j].daysLeft);
        if (!band) continue;
        out.push({
          id: races[j].key + ':' + pawn.id,
          key: races[j].key,
          label: nameOf(pawn) + ': ' + races[j].label,
          detail: 'about ' + Math.max(1, Math.round(races[j].daysLeft * 24)) + 'h left',
          severity: band.band,
          colour: BAND_COLOUR[band.band],
          explain: EXPLANATIONS[races[j].key] || '',
          pawn: pawn,
          lookAt: { x: pawn.x, y: pawn.y }
        });
      }
    }

    /* One standing alert that is not about a single pawn: a colony that
       has learned blood banking and has no blood banked. */
    if (Statuses.bloodBankingKnown() && Statuses.blood.target > 0 && G.map) {
      var have = Statuses.packsInColony(G.map);
      if (have < Statuses.blood.target) {
        out.push({
          id: 'bloodStock', key: 'bloodStock',
          label: 'No blood banked',
          detail: have + ' of ' + Statuses.blood.target + ' packs',
          severity: have ? 'minor' : 'major',
          colour: BAND_COLOUR[have ? 'minor' : 'major'],
          explain: EXPLANATIONS.bloodStock,
          pawn: null, lookAt: null
        });
      }
    }

    out.sort(function (a, b) {
      var rank = { critical: 0, major: 1, minor: 2, none: 3, good: 4 };
      return rank[a.severity] - rank[b.severity];
    });
    _alerts = out;
    return out;
  };

  /* ==================================================================
     9. JOBS AND WORK GIVERS

     Registered on first tick rather than at load, because jobs.js and
     workgivers.js sit below this file in the load order. Both
     registrations are idempotent.
     ================================================================== */

  var _registered = false;

  function registerBehaviour() {
    if (_registered) return true;
    var Jobs = sys('Jobs'), Toils = sys('Toils'), T = sys('T'), Res = sys('Res');
    var WG = sys('WorkGivers'), Path = sys('Path');
    if (!Jobs || !Toils || !T || !WG) return false;
    if (Jobs.isRegistered && Jobs.isRegistered('donateBlood')) { _registered = true; return true; }
    var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

    Jobs.register('donateBlood', {
      label: 'donate blood',
      reportString: 'Giving blood.',
      toils: function () {
        return [
          Toils.work({
            name: 'donate',
            amount: function () { return DONATE_WORK; },
            rate: function (pawn) { return pawn.workRate ? pawn.workRate('medicine') : 1; },
            onDone: function (pawn) {
              if (!Statuses.canDonate(pawn)) return 'fail';
              Statuses.drawBlood(pawn);
              return 'done';
            }
          })
        ];
      },
      onEnd: function (pawn, job, reason) {
        if (reason !== 'done' && pawn.status) pawn.status.donate = 0;
      }
    });

    Jobs.register('transfuseBlood', {
      label: 'transfuse',
      reportString: 'Giving {A} a transfusion.',
      toils: function () {
        return [
          Toils.reserve('A', 1),
          Toils.goto('B', { pe: PE.TOUCH, failIfGone: true }),
          Toils.pickUp('B', function () { return 1; }),
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.work({
            name: 'transfuse',
            amount: function () { return TRANSFUSE_WORK; },
            rate: function (pawn) { return pawn.workRate ? pawn.workRate('medicine') : 1; },
            failIfGone: true,
            onDone: function (pawn, job) {
              var patient = T.resolve(job.targetA, pawn.map);
              if (!patient || patient.dead) return 'fail';
              var pack = pawn.carried;
              if (!pack || pack.defId !== 'bloodPack') return 'fail';
              Statuses.transfuse(patient, pack, pawn);
              if (pawn.carried === pack && (pack.stack || 0) <= 0) pawn.carried = null;
              return 'done';
            }
          })
        ];
      }
    });

    function nearestPack(map, pawn) {
      var list = map.byDef ? (map.byDef('bloodPack') || []) : [];
      var best = null, bestD = Infinity;
      for (var i = 0; i < list.length; i++) {
        var pack = list[i];
        if (!pack.spawned || pack.stack <= 0) continue;
        if (Res && !Res.canReserve(pawn, T.thing(pack), 1)) continue;
        var d = U.distSq(pawn.x, pawn.y, pack.x, pack.y);
        if (d < bestD) { bestD = d; best = pack; }
      }
      return best;
    }

    /* Just behind doctorTendOther at order 10: closing the wound is the
       cure and a transfusion is only the stay of execution, so the
       doctor reaches for gauze first and the bag second. */
    WG.register({
      id: 'doctorTransfuse', workType: 'doctor', order: 12,
      label: 'give a transfusion',
      tryGiveJob: function (pawn) {
        var map = pawn.map;
        if (!map || !map.byDef) return null;
        if (!Statuses.bloodBankingKnown()) return null;
        var pawns = map.pawns, best = null, bestScore = -Infinity;
        for (var i = 0; i < pawns.length; i++) {
          var patient = pawns[i];
          if (patient === pawn || !Statuses.needsTransfusion(patient)) continue;
          if (Res && !Res.canReserve(pawn, T.pawn(patient), 1)) continue;
          var score = patient.health.bloodLoss * 100 - U.dist(pawn.x, pawn.y, patient.x, patient.y);
          if (score > bestScore) { bestScore = score; best = patient; }
        }
        if (!best) return null;
        var pack = nearestPack(map, pawn);
        if (!pack) return null;

        var targetA = T.pawn(best);
        if (Res && !Res.reserve(pawn, targetA, 1)) return null;
        var job = Jobs.make('transfuseBlood', targetA, T.thing(pack), {});
        if (Res && !Res.reserve(pawn, job.targetB, 1)) {
          if (Res.release) Res.release(pawn, targetA);
          return null;
        }
        return job;
      }
    });

    /* Donating is the last thing on the doctor column on purpose: it is
       worth a colonist's afternoon only once every real job is done. */
    WG.register({
      id: 'doctorDonateBlood', workType: 'doctor', order: 90,
      label: 'donate blood',
      tryGiveJob: function (pawn) {
        var st = pawn.status;
        var asked = st && st.donate;
        if (!asked) {
          if (!Statuses.blood.target) return null;
          if (!pawn.map || Statuses.packsInColony(pawn.map) >= Statuses.blood.target) return null;
        }
        if (!Statuses.canDonate(pawn)) return null;
        state(pawn).donate = asked || 2;
        return Jobs.make('donateBlood', null, null, {});
      }
    });

    _registered = true;
    return true;
  }
  Statuses.install = registerBehaviour;

  /* ==================================================================
     10. THE TICKS

     game.js drives Statuses.tickPawn for every pawn every tick. It does
     not list this file among its map tickers, so the map-level work -
     the pools, the alert cache - is run from the first pawn tick of
     each new tick instead. Statuses.tick is still a public entry point
     that does the right thing exactly once per tick if game.js is ever
     told about it.
     ================================================================== */

  var _mapTick = -1;
  var _inMapTick = false;
  var _map = null;
  var _seed = null;

  /* A cell index only means anything on the map it was taken from, so a
     new colony or a loaded save has to drop the wet pool list before it
     starts painting blood into a world that has different dimensions.
     A different seed is a different colony and forgets the warnings it
     has already explained; the same seed on a new map object is a save
     being loaded, and that colony remembers. */
  function noteMap(map) {
    if (map === _map) return;
    _map = map;
    pools.length = 0;
    poolAt = Object.create(null);
    _spreadCursor = 0;
    _alertTick = -99999;
    var G = sys('Game');
    var seed = G ? G.seed : null;
    if (seed !== _seed) {
      _seed = seed;
      _explained = Object.create(null);
      _alerts = [];
    }
  }

  Statuses.tick = function (map, game) {
    if (_inMapTick) return;
    var t = (game && game.tick) || now();
    if (t === _mapTick) return;
    _mapTick = t;
    _inMapTick = true;
    try {
      if (!_registered) registerBehaviour();
      if (!_hediffsInstalled) installHediffs();
      if (map) {
        noteMap(map);
        if (t % SPREAD_EVERY === 0) spreadPools(map);
      }
      if (t % 500 === 0) Statuses.alerts(true);
    } finally {
      _inMapTick = false;
    }
  };

  Statuses.tickPawn = function (pawn) {
    if (!pawn || pawn.dead) return;
    if (!_registered) registerBehaviour();

    /* The map beat, taken off the back of the first pawn of the tick. */
    var t = now();
    if (t !== _mapTick) Statuses.tick(pawn.map, sys('Game'));

    /* Per-tick, for everybody: only the trail, and only when there is a
       wound that could be making one. */
    var h = pawn.health;
    if (h && h.injuries && h.injuries.length) trailStep(pawn);

    if (((t + (pawn.id | 0) + BEAT) % RARE) !== 0) return;
    rareTick(pawn, h);
  };

  function rareTick(pawn, h) {
    var st = pawn.status;

    if (h && !h.dead) {
      var H = sys('Health');
      var bleed = H && H.bleedRate ? H.bleedRate(pawn) : 0;
      if (bleed > 0 || h.bloodLoss > 0 || st) {
        st = state(pawn);
        st.bleed = bleed;
        st.pallor = Statuses.pallor(pawn);
      }
      syncHypovolemia(pawn);

      /* A transfusion is a window, not a cure: it fades over half a day
         and takes its stability with it. */
      if (H && H.hediff) {
        var tr = H.hediff(pawn, 'transfused');
        if (tr) {
          tr.severity -= (RARE / TICKS_PER_DAY) * 2;
          if (tr.severity <= 0.02) H.removeHediff(pawn, 'transfused');
        }
      }

      /* The mood cost of being drained. Refreshed every rare tick and
         marked situational so needs.js drops it the moment it is false. */
      if (isPerson(pawn) && h.bloodLoss > 0.25) {
        var N = sys('Needs');
        if (N && N.addThought) {
          var degree = h.bloodLoss > 0.62 ? 2 : (h.bloodLoss > 0.42 ? 1 : 0);
          N.addThought(pawn, 'weakFromBloodLoss', { degree: degree, situational: true });
        }
      }
    }

    /* The clocks. Escalation is only ever announced for colonists: a
       raider bleeding out in the field is not an alert, it is a result. */
    if (h && !h.dead && colonist(pawn)) {
      var races = racesOn(pawn);
      for (var i = 0; i < races.length; i++) {
        var band = bandFor(races[i].daysLeft);
        if (band) escalate(pawn, races[i], band);
      }
      clearWarnings(pawn);
    }

    /* Record where every lethal condition stood, so next time round the
       rate of climb is a measurement rather than a guess. */
    if (h && h.hediffs && h.hediffs.length) {
      st = state(pawn);
      var trend = st.trend, k;
      for (k in trend) trend[k] = undefined;
      for (i = 0; i < h.hediffs.length; i++) {
        var hd = h.hediffs[i];
        if (hd.def && hd.def.lethal) trend[hd.id] = hd.severity;
      }
      for (k in trend) if (trend[k] === undefined) delete trend[k];
    } else if (st && st.trend) {
      st.trend = {};
    }

    /* A pawn with nothing left to remember stops costing a rare tick
       and a line in the save file. */
    if (st && stateIsEmpty(st)) pawn.status = null;
  }

  /* ==================================================================
     11. SAVE

     Per-pawn state rides in save.js's pawn blob because pawn.status is
     a plain field of plain values. What is left here is colony-wide:
     the blood target the player set, and which warnings have already
     explained themselves - a colony should not be told twice what an
     infection is.
     ================================================================== */

  Statuses.save = function () {
    var explained = [];
    for (var k in _explained) explained.push(k);
    var wet = [];
    for (var i = 0; i < pools.length; i++) wet.push(pools[i].i, pools[i].born);
    return { bloodTarget: Statuses.blood.target, explained: explained, wet: wet };
  };

  Statuses.load = function (obj) {
    if (!obj) return false;
    if (typeof obj.bloodTarget === 'number') Statuses.blood.target = obj.bloodTarget;
    _explained = Object.create(null);
    var list = obj.explained || [], i;
    for (i = 0; i < list.length; i++) _explained[list[i]] = 1;
    pools.length = 0;
    poolAt = Object.create(null);
    var wet = obj.wet || [];
    for (i = 0; i + 1 < wet.length; i += 2) {
      pools.push({ i: wet[i], born: wet[i + 1] });
      poolAt[wet[i]] = wet[i + 1];
    }
    _alertTick = -99999;
    /* Adopt the map this save was just restored into, or the next tick
       would decide it had never seen it and throw the pools away. */
    var G = sys('Game');
    _map = G ? G.map : null;
    _seed = G ? G.seed : null;
    return true;
  };

  Statuses.reset = function () {
    pools.length = 0;
    poolAt = Object.create(null);
    _spreadCursor = 0;
    _explained = Object.create(null);
    _alerts = [];
    _alertTick = -99999;
    _mapTick = -1;
    _map = null;
    _seed = null;
    Statuses.blood.target = 2;
  };

  /* If jobs.js and workgivers.js are already there, register now;
     otherwise the first tick does it. */
  registerBehaviour();

  root.Statuses = Statuses;
})(this);
