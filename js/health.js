/* ============================================================
   health.js - bodies, wounds, and the several ways a colonist dies.

   A pawn's body is a flat list of parts with parent links. Every part
   supplies some fraction of one or more capacities; a capacity is the
   normalised sum of what its parts still supply, so "moving" is 1.0 on
   an intact body and falls as legs are shot off. Injuries live in their
   own list and own the arithmetic: a part's hp is always
   maxHp - (sum of injuries on it), never written directly. That single
   invariant is what lets wounds heal, scar and be removed without any
   part-hp bookkeeping drifting out of sync.

   Everything expensive - bleeding, infection, healing, temperature -
   happens on the rare tick (every 250 ticks, staggered per pawn), so a
   hundred colonists cost about as much as one.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;

  var TICKS_PER_DAY = 60000;
  var RARE = 250;
  var RARE_DAYS = RARE / TICKS_PER_DAY;          /* one rare tick, in days */

  var CAPS = ['consciousness', 'moving', 'manipulation', 'sight', 'hearing',
              'talking', 'breathing', 'bloodPumping', 'eating'];

  /* How much pain a wound that has eaten a whole part is worth. Two
     destroyed arms should hurt enough to put someone on the floor. */
  var PAIN_SCALE = 0.35;

  var DOWN_CONSCIOUSNESS = 0.30;
  var DOWN_PAIN = 0.80;
  var DOWN_MOVING = 0.16;

  /* Lazy accessors: these files load after this one, and in the test
     sandbox some of them never load at all. */
  function Game() { return typeof root.Game !== 'undefined' ? root.Game : null; }
  function Needs() { return typeof root.Needs !== 'undefined' ? root.Needs : null; }
  function Regions() { return typeof root.Regions !== 'undefined' ? root.Regions : null; }
  function PawnLib() { return typeof root.Pawn !== 'undefined' ? root.Pawn : null; }
  function Defs() { return typeof root.Defs !== 'undefined' ? root.Defs : null; }

  function thought(pawn, id, opts) {
    var n = Needs();
    if (n && n.addThought && pawn && pawn.isHuman !== false) n.addThought(pawn, id, opts || {});
  }

  /* ------------------------------------------------------------------
     Damage types. `bleed` and `pain` scale the wound; `inside` is the
     chance per step that the blow carries past an outer part into what
     it protects, which is why bullets hit hearts and clubs do not.
     ------------------------------------------------------------------ */
  var DAMAGE_TYPES = {
    bullet:    { label: 'gunshot',      armor: 'sharp', bleed: 1.00, pain: 1.00, inside: 0.35 },
    arrow:     { label: 'arrow wound',  armor: 'sharp', bleed: 0.90, pain: 0.95, inside: 0.30 },
    stab:      { label: 'stab wound',   armor: 'sharp', bleed: 1.05, pain: 1.00, inside: 0.38 },
    cut:       { label: 'cut',          armor: 'sharp', bleed: 1.00, pain: 0.90, inside: 0.18 },
    scratch:   { label: 'scratch',      armor: 'sharp', bleed: 0.55, pain: 0.70, inside: 0.04 },
    bite:      { label: 'bite',         armor: 'sharp', bleed: 0.85, pain: 1.00, inside: 0.12 },
    blunt:     { label: 'bruise',       armor: 'blunt', bleed: 0.05, pain: 0.70, inside: 0.10 },
    crush:     { label: 'crushed',      armor: 'blunt', bleed: 0.10, pain: 0.90, inside: 0.20 },
    explosion: { label: 'shredded',     armor: 'blunt', bleed: 0.60, pain: 1.20, inside: 0.25 },
    burn:      { label: 'burn',         armor: 'heat',  bleed: 0.15, pain: 1.30, inside: 0.04 },
    frostbite: { label: 'frostbite',    armor: 'heat',  bleed: 0.00, pain: 0.80, inside: 0.00 },
    toxic:     { label: 'toxic burn',   armor: 'heat',  bleed: 0.10, pain: 1.00, inside: 0.08 }
  };
  function dtype(t) { return DAMAGE_TYPES[t] || DAMAGE_TYPES.blunt; }

  /* Scale from raw damage to blood lost per day. A rifle round to the
     torso (18 damage) opens a 0.45/day bleed, which kills an untended
     pawn in a bit over two days and is survivable if a doctor is awake. */
  var BLEED_PER_DAMAGE = 0.025;

  /* ------------------------------------------------------------------
     Fallback bodies.

     def_pawns.js owns the real body defs. These exist so health.js loads
     and can be exercised on its own, and so a pawn kind that names a body
     this file has never heard of still gets a working skeleton instead of
     an exception. A real def always wins.
     ------------------------------------------------------------------ */
  function P(defName, parent, coverage, depth, hp, caps, flags) {
    flags = flags || '';
    return {
      defName: defName, parent: parent, coverage: coverage, depth: depth,
      hp: hp, capacities: caps || null,
      vital: flags.indexOf('v') >= 0, limb: flags.indexOf('l') >= 0
    };
  }

  var FALLBACK_BODIES = {
    human: [
      P('torso', null, 0.36, 'o', 40, null, 'v'),
      P('neck', 'torso', 0.05, 'o', 25, { talking: 0.25, eating: 0.25 }, 'v'),
      P('head', 'neck', 0.08, 'o', 25, null, 'v'),
      P('skull', 'head', 0.80, 'i', 25, null, ''),
      P('brain', 'skull', 0.65, 'i', 12, { consciousness: 1 }, 'v'),
      P('eyeLeft', 'head', 0.018, 'o', 8, { sight: 0.5 }, 'l'),
      P('eyeRight', 'head', 0.018, 'o', 8, { sight: 0.5 }, 'l'),
      P('earLeft', 'head', 0.020, 'o', 10, { hearing: 0.5 }, 'l'),
      P('earRight', 'head', 0.020, 'o', 10, { hearing: 0.5 }, 'l'),
      P('nose', 'head', 0.020, 'o', 10, null, 'l'),
      P('jaw', 'head', 0.030, 'o', 18, { talking: 0.75, eating: 0.5 }, 'l'),
      P('ribcage', 'torso', 0.35, 'i', 30, null, ''),
      P('spine', 'torso', 0.20, 'i', 25, { moving: 0.24 }, ''),
      P('heart', 'torso', 0.20, 'i', 15, { bloodPumping: 1 }, 'v'),
      P('lungLeft', 'torso', 0.25, 'i', 15, { breathing: 0.5 }, ''),
      P('lungRight', 'torso', 0.25, 'i', 15, { breathing: 0.5 }, ''),
      P('liver', 'torso', 0.22, 'i', 18, null, 'v'),
      P('stomach', 'torso', 0.20, 'i', 18, { eating: 0.25 }, ''),
      P('kidneyLeft', 'torso', 0.16, 'i', 12, null, ''),
      P('kidneyRight', 'torso', 0.16, 'i', 12, null, ''),
      P('armLeft', 'torso', 0.07, 'o', 30, { manipulation: 0.35 }, 'l'),
      P('armRight', 'torso', 0.07, 'o', 30, { manipulation: 0.35 }, 'l'),
      P('handLeft', 'armLeft', 0.04, 'o', 20, { manipulation: 0.15 }, 'l'),
      P('handRight', 'armRight', 0.04, 'o', 20, { manipulation: 0.15 }, 'l'),
      P('legLeft', 'torso', 0.09, 'o', 30, { moving: 0.30 }, 'l'),
      P('legRight', 'torso', 0.09, 'o', 30, { moving: 0.30 }, 'l'),
      P('footLeft', 'legLeft', 0.04, 'o', 20, { moving: 0.08 }, 'l'),
      P('footRight', 'legRight', 0.04, 'o', 20, { moving: 0.08 }, 'l')
    ],
    quadruped: [
      P('torso', null, 0.40, 'o', 40, null, 'v'),
      P('neck', 'torso', 0.06, 'o', 22, { eating: 0.3 }, 'v'),
      P('head', 'neck', 0.09, 'o', 22, null, 'v'),
      P('skull', 'head', 0.80, 'i', 22, null, ''),
      P('brain', 'skull', 0.65, 'i', 10, { consciousness: 1 }, 'v'),
      P('eyeLeft', 'head', 0.02, 'o', 7, { sight: 0.5 }, 'l'),
      P('eyeRight', 'head', 0.02, 'o', 7, { sight: 0.5 }, 'l'),
      P('earLeft', 'head', 0.02, 'o', 8, { hearing: 0.5 }, 'l'),
      P('earRight', 'head', 0.02, 'o', 8, { hearing: 0.5 }, 'l'),
      P('jaw', 'head', 0.04, 'o', 16, { eating: 0.7 }, 'l'),
      P('spine', 'torso', 0.20, 'i', 22, { moving: 0.20 }, ''),
      P('heart', 'torso', 0.20, 'i', 14, { bloodPumping: 1 }, 'v'),
      P('lungLeft', 'torso', 0.24, 'i', 14, { breathing: 0.5 }, ''),
      P('lungRight', 'torso', 0.24, 'i', 14, { breathing: 0.5 }, ''),
      P('liver', 'torso', 0.20, 'i', 16, null, 'v'),
      P('stomach', 'torso', 0.20, 'i', 16, null, ''),
      P('legFrontLeft', 'torso', 0.08, 'o', 24, { moving: 0.20 }, 'l'),
      P('legFrontRight', 'torso', 0.08, 'o', 24, { moving: 0.20 }, 'l'),
      P('legRearLeft', 'torso', 0.08, 'o', 24, { moving: 0.20 }, 'l'),
      P('legRearRight', 'torso', 0.08, 'o', 24, { moving: 0.20 }, 'l'),
      P('tail', 'torso', 0.03, 'o', 12, null, 'l')
    ],
    bird: [
      P('torso', null, 0.42, 'o', 22, null, 'v'),
      P('neck', 'torso', 0.07, 'o', 12, { eating: 0.3 }, 'v'),
      P('head', 'neck', 0.10, 'o', 12, null, 'v'),
      P('skull', 'head', 0.80, 'i', 12, null, ''),
      P('brain', 'skull', 0.65, 'i', 6, { consciousness: 1 }, 'v'),
      P('eyeLeft', 'head', 0.03, 'o', 4, { sight: 0.5 }, 'l'),
      P('eyeRight', 'head', 0.03, 'o', 4, { sight: 0.5 }, 'l'),
      P('beak', 'head', 0.05, 'o', 8, { eating: 0.7 }, 'l'),
      P('heart', 'torso', 0.20, 'i', 8, { bloodPumping: 1 }, 'v'),
      P('lungLeft', 'torso', 0.22, 'i', 8, { breathing: 0.5 }, ''),
      P('lungRight', 'torso', 0.22, 'i', 8, { breathing: 0.5 }, ''),
      P('liver', 'torso', 0.18, 'i', 8, null, 'v'),
      P('wingLeft', 'torso', 0.10, 'o', 14, { moving: 0.20 }, 'l'),
      P('wingRight', 'torso', 0.10, 'o', 14, { moving: 0.20 }, 'l'),
      P('legLeft', 'torso', 0.06, 'o', 10, { moving: 0.30 }, 'l'),
      P('legRight', 'torso', 0.06, 'o', 10, { moving: 0.30 }, 'l')
    ]
  };

  /* Capacities, vitality and pain weight by part name, used when a real
     body def describes its tree but leaves the game rules off it. */
  var CAP_TABLE = {};
  var VITAL_TABLE = {};
  var LIMB_TABLE = {};
  Object.keys(FALLBACK_BODIES).forEach(function (bodyId) {
    FALLBACK_BODIES[bodyId].forEach(function (p) {
      if (p.capacities && CAP_TABLE[p.defName] === undefined) CAP_TABLE[p.defName] = p.capacities;
      if (p.vital) VITAL_TABLE[p.defName] = true;
      if (p.limb) LIMB_TABLE[p.defName] = true;
    });
  });

  /* ------------------------------------------------------------------
     Reading a body def.

     def_pawns.js is written by another hand, so accept the shapes it is
     likely to use - a flat array, a keyed table, or a nested tree - and
     normalise all of them into one ordered list with integer parents.
     The result is cached per body id; bodies never change at runtime.
     ------------------------------------------------------------------ */
  var bodyCache = {};

  function firstOf(o, keys, dflt) {
    for (var i = 0; i < keys.length; i++) {
      if (o[keys[i]] !== undefined && o[keys[i]] !== null) return o[keys[i]];
    }
    return dflt;
  }

  function nodeName(node, fallbackKey) {
    return String(firstOf(node, ['defName', 'name', 'id', 'part'], fallbackKey || 'part'));
  }

  function nodeDepth(node) {
    var d = firstOf(node, ['depth'], null);
    if (typeof d === 'string') return d.charAt(0) === 'i' ? 'inside' : 'outside';
    if (node.inside === true || node.internal === true) return 'inside';
    return 'outside';
  }

  function nodeChildren(node) {
    var c = firstOf(node, ['children', 'parts', 'sub'], null);
    return Array.isArray(c) ? c : null;
  }

  /* Flatten whatever the def gave us. Parents are resolved by name in a
     second pass so declaration order does not matter. */
  function flattenBody(bodyDef) {
    var rows = [];

    function visit(node, parentName, key) {
      var name = nodeName(node, key);
      rows.push({
        defName: name,
        parentName: parentName,
        coverage: Number(firstOf(node, ['coverage', 'cov'], 0.05)),
        depth: nodeDepth(node),
        hp: Number(firstOf(node, ['hp', 'maxHp', 'hpFactor', 'health'], 20)),
        capacities: firstOf(node, ['capacities', 'caps', 'capacity'], null),
        vital: !!firstOf(node, ['vital', 'isVital', 'core'], false),
        limb: !!firstOf(node, ['limb', 'isLimb', 'isLimbOrExtremity'], false),
        label: firstOf(node, ['label'], null)
      });
      var kids = nodeChildren(node);
      if (kids) {
        for (var i = 0; i < kids.length; i++) visit(kids[i], name, null);
      } else if (node.children && !Array.isArray(node.children)) {
        Object.keys(node.children).forEach(function (k) { visit(node.children[k], name, k); });
      }
    }

    var list = bodyDef.parts || bodyDef.core || bodyDef.root || bodyDef.tree;
    if (Array.isArray(list)) {
      for (var i = 0; i < list.length; i++) {
        var n = list[i];
        visit(n, firstOf(n, ['parent', 'parentName', 'of'], null), null);
      }
    } else if (list && typeof list === 'object') {
      /* Keyed table, or a single nested root node. */
      if (nodeChildren(list) || list.defName || list.name) {
        visit(list, null, null);
      } else {
        Object.keys(list).forEach(function (k) {
          visit(list[k], firstOf(list[k], ['parent', 'parentName', 'of'], null), k);
        });
      }
    } else {
      return null;
    }
    return rows.length ? rows : null;
  }

  function buildTemplate(bodyId) {
    if (bodyCache[bodyId]) return bodyCache[bodyId];

    var rows = null;
    var D = Defs();
    var def = D && D.maybe ? D.maybe('body', bodyId) : null;
    if (def) rows = flattenBody(def);
    if (!rows) {
      var fb = FALLBACK_BODIES[bodyId] || FALLBACK_BODIES.human;
      rows = fb.map(function (p) {
        return {
          defName: p.defName, parentName: p.parent, coverage: p.coverage,
          depth: p.depth === 'i' ? 'inside' : 'outside', hp: p.hp,
          capacities: p.capacities, vital: p.vital, limb: p.limb, label: null
        };
      });
    }

    var byName = {};
    rows.forEach(function (r, i) { byName[r.defName] = i; });

    var parts = rows.map(function (r, i) {
      var caps = r.capacities || CAP_TABLE[r.defName] || null;
      var parent = (r.parentName !== null && r.parentName !== undefined && byName[r.parentName] !== undefined)
        ? byName[r.parentName] : null;
      if (parent === i) parent = null;
      return {
        index: i,
        defName: r.defName,
        label: r.label || labelize(r.defName),
        parent: parent,
        coverage: isFinite(r.coverage) && r.coverage > 0 ? r.coverage : 0.04,
        depth: r.depth,
        hp: Math.max(1, Math.round(r.hp)),
        capacities: caps,
        vital: r.vital || !!VITAL_TABLE[r.defName],
        limb: r.limb || !!LIMB_TABLE[r.defName]
      };
    });

    bodyCache[bodyId] = parts;
    return parts;
  }

  /* 'eyeLeft' reads as 'left eye' in the health tab. */
  function labelize(defName) {
    var m = /^(.*?)(Left|Right|FrontLeft|FrontRight|RearLeft|RearRight)$/.exec(defName);
    var base = m ? m[1] : defName;
    base = base.replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    if (!m) return base;
    var side = m[2].replace(/([A-Z])/g, ' $1').toLowerCase().trim();
    return side + ' ' + base;
  }

  /* ------------------------------------------------------------------
     Creation
     ------------------------------------------------------------------ */
  var Health = {};

  Health.create = function (pawn) {
    var kind = pawn.kind || {};
    var bodyId = kind.body || (pawn.isAnimal ? 'quadruped' : 'human');
    var scale = kind.baseHealthScale || kind.healthScale || 1;
    var template = buildTemplate(bodyId);

    var parts = template.map(function (t) {
      var maxHp = Math.max(1, Math.round(t.hp * scale));
      return {
        id: t.index, defName: t.defName, label: t.label, parent: t.parent,
        coverage: t.coverage, depth: t.depth,
        hp: maxHp, maxHp: maxHp, missing: false,
        capacities: t.capacities ? shallow(t.capacities) : null,
        vital: t.vital, limb: t.limb
      };
    });

    var h = {
      bodyId: bodyId,
      parts: parts,
      injuries: [],
      bloodLoss: 0,
      pain: 0,
      capacities: {},
      downed: false,
      dead: false,
      immunityGain: 0.30,
      hediffs: [],
      ticks: 0,
      deathCause: null,
      _capDirty: true,
      _killing: false
    };
    pawn.health = h;
    pawn.downed = false;
    pawn.dead = false;
    recompute(pawn);
    return h;
  };

  function shallow(o) {
    var out = {};
    Object.keys(o).forEach(function (k) { out[k] = o[k]; });
    return out;
  }

  function ensure(pawn) {
    if (!pawn.health || !pawn.health.parts) Health.create(pawn);
    return pawn.health;
  }

  function partById(h, id) {
    var p = h.parts[id];
    if (p && p.id === id) return p;
    for (var i = 0; i < h.parts.length; i++) if (h.parts[i].id === id) return h.parts[i];
    return null;
  }

  Health.part = function (pawn, id) { return partById(ensure(pawn), id); };

  Health.partNamed = function (pawn, defName) {
    var h = ensure(pawn);
    for (var i = 0; i < h.parts.length; i++) if (h.parts[i].defName === defName) return h.parts[i];
    return null;
  };

  Health.injuriesOn = function (pawn, partId) {
    return ensure(pawn).injuries.filter(function (inj) { return inj.partId === partId; });
  };

  /* ------------------------------------------------------------------
     Capacities
     ------------------------------------------------------------------ */
  function partEfficiency(part) {
    if (part.missing) return 0;
    return U.clamp01(part.hp / Math.max(1, part.maxHp));
  }

  function computePain(h) {
    var p = 0, i, inj, part;
    for (i = 0; i < h.injuries.length; i++) {
      inj = h.injuries[i];
      part = partById(h, inj.partId);
      var maxHp = part ? part.maxHp : 20;
      p += (inj.amount / Math.max(1, maxHp)) * (inj.painFactor || 1) * PAIN_SCALE;
    }
    for (i = 0; i < h.hediffs.length; i++) {
      p += (h.hediffs[i].def.painOffset || 0) * h.hediffs[i].severity;
    }
    return U.clamp01(p);
  }

  /* Losing one of a pair hurts more than the arithmetic suggests, so
     breathing and blood pumping bend consciousness rather than scaling
     it flat: one lung is a serious handicap, not exactly half a pawn. */
  function organFactor(v) { return v >= 1 ? 1 : 0.3 + 0.7 * v; }

  function recompute(pawn) {
    var h = pawn.health;
    var sums = {}, totals = {}, i, k;
    for (i = 0; i < CAPS.length; i++) { sums[CAPS[i]] = 0; totals[CAPS[i]] = 0; }

    for (i = 0; i < h.parts.length; i++) {
      var part = h.parts[i];
      if (!part.capacities) continue;
      var eff = partEfficiency(part);
      for (k in part.capacities) {
        if (totals[k] === undefined) continue;
        totals[k] += part.capacities[k];
        sums[k] += part.capacities[k] * eff;
      }
    }

    var c = {};
    for (i = 0; i < CAPS.length; i++) {
      k = CAPS[i];
      /* A body that models no organ for a capacity is not impaired in it:
         a muffalo is not "incapable of manipulation", it simply has none. */
      c[k] = totals[k] > 0 ? U.clamp01(sums[k] / totals[k]) : 1;
    }

    /* Hediff offsets are stated at severity 1 and scale down from there. */
    for (i = 0; i < h.hediffs.length; i++) {
      var mods = h.hediffs[i].def.capMods;
      if (!mods) continue;
      for (k in mods) {
        if (c[k] === undefined) continue;
        c[k] = U.clamp01(c[k] + mods[k] * h.hediffs[i].severity);
      }
    }

    h.pain = computePain(h);

    var blood = h.bloodLoss;
    c.bloodPumping = U.clamp01(c.bloodPumping * (1 - blood * 0.9));
    c.breathing = U.clamp01(c.breathing * (1 - blood * 0.35));
    c.consciousness = U.clamp01(
      c.consciousness * (1 - h.pain * 0.5) * (1 - blood * 0.5) *
      organFactor(c.breathing) * organFactor(c.bloodPumping)
    );
    /* Limbs still need a mind driving them. */
    var drive = U.clamp01(0.2 + 0.8 * c.consciousness);
    c.moving = U.clamp01(c.moving * drive);
    c.manipulation = U.clamp01(c.manipulation * drive);

    h.capacities = c;
    h._capDirty = false;
    return c;
  }

  function invalidate(pawn) { if (pawn.health) pawn.health._capDirty = true; }
  Health.invalidate = invalidate;

  Health.capacity = function (pawn, name) {
    var h = ensure(pawn);
    if (h._capDirty) recompute(pawn);
    var v = h.capacities[name];
    return v === undefined ? 1 : v;
  };

  Health.painLevel = function (pawn) {
    var h = ensure(pawn);
    if (h._capDirty) recompute(pawn);
    return h.pain;
  };

  Health.moveSpeedFactor = function (pawn) {
    var h = ensure(pawn);
    if (h.dead || h.downed) return 0;
    return U.clamp(Health.capacity(pawn, 'moving'), 0.06, 1.2);
  };

  Health.workSpeedFactor = function (pawn) {
    var h = ensure(pawn);
    if (h.dead || h.downed) return 0;
    var manip = Health.capacity(pawn, 'manipulation');
    var consc = Health.capacity(pawn, 'consciousness');
    return U.clamp(manip * (0.5 + 0.5 * consc), 0.05, 1.2);
  };

  Health.isDowned = function (pawn) { return !!(pawn.health && pawn.health.downed); };

  /* ------------------------------------------------------------------
     Apparel and armour
     ------------------------------------------------------------------ */
  var APPAREL_COVER = {
    shirt:     ['torso', 'neck', 'armLeft', 'armRight'],
    pants:     ['legLeft', 'legRight'],
    jacket:    ['torso', 'neck', 'armLeft', 'armRight'],
    parka:     ['torso', 'neck', 'armLeft', 'armRight', 'legLeft', 'legRight'],
    armorVest: ['torso'],
    helmet:    ['head', 'neck']
  };

  var coverCache = {};

  function coverageSet(thing) {
    var def = thing && thing.def;
    if (!def) return null;
    var key = def.id || thing.defId;
    if (coverCache[key]) return coverCache[key];
    var list = def.coversParts || def.bodyParts || def.coverage || def.covers ||
               APPAREL_COVER[key] || null;
    var set = {};
    if (Array.isArray(list)) {
      list.forEach(function (n) { set[n] = true; });
    } else if (list && typeof list === 'object') {
      Object.keys(list).forEach(function (n) { set[n] = true; });
    } else {
      /* Unknown apparel covers the trunk: better than covering nothing. */
      set.torso = true;
    }
    coverCache[key] = set;
    return set;
  }

  /* A jacket over the torso also stands between a bullet and the heart,
     so a part counts as covered when any ancestor of it is covered. */
  function apparelCovers(h, thing, part) {
    var set = coverageSet(thing);
    if (!set) return false;
    var p = part, guard = 0;
    while (p && guard++ < 16) {
      if (set[p.defName]) return true;
      p = p.parent === null || p.parent === undefined ? null : partById(h, p.parent);
    }
    return false;
  }

  function ratingOf(thing, kind) {
    var def = thing.def || {};
    var base = 0;
    if (kind === 'sharp') base = def.armorSharp || 0;
    else if (kind === 'blunt') base = def.armorBlunt || 0;
    else base = def.armorHeat !== undefined ? def.armorHeat : (def.armorBlunt || 0) * 0.5;
    if (!base) return 0;
    /* A tattered vest protects worse than a new one. */
    if (thing.hp && def.maxHp) base *= U.clamp(thing.hp / def.maxHp, 0.35, 1);
    return base;
  }

  /* RimWorld's armour roll, kept because it produces the right feel: most
     of the time armour does nothing, occasionally it saves a life. */
  function applyArmor(pawn, h, part, amount, type, armorPen) {
    var t = dtype(type);
    var rating = 0, i;
    var apparel = pawn.apparel;
    if (Array.isArray(apparel)) {
      for (i = 0; i < apparel.length; i++) {
        if (apparelCovers(h, apparel[i], part)) rating += ratingOf(apparel[i], t.armor);
      }
    }
    var kind = pawn.kind || {};
    rating += (t.armor === 'sharp' ? (kind.armorSharp || 0)
             : t.armor === 'blunt' ? (kind.armorBlunt || 0)
             : (kind.armorHeat || 0));

    rating = U.clamp(rating - (armorPen || 0), 0, 2);
    if (rating <= 0) return { amount: amount, type: type, deflected: false };

    var r = U.rand();
    if (r < rating / 2) return { amount: 0, type: type, deflected: true };
    if (r < rating) return { amount: amount * 0.5, type: 'blunt', deflected: false };
    return { amount: amount, type: type, deflected: false };
  }

  /* ------------------------------------------------------------------
     Choosing where a blow lands
     ------------------------------------------------------------------ */
  function childrenOf(h, part, depth) {
    var out = [];
    for (var i = 0; i < h.parts.length; i++) {
      var p = h.parts[i];
      if (p.parent === part.id && !p.missing && (!depth || p.depth === depth)) out.push(p);
    }
    return out;
  }

  function pickHitPart(h, type) {
    var outside = [];
    for (var i = 0; i < h.parts.length; i++) {
      var p = h.parts[i];
      if (p.depth === 'outside' && !p.missing) outside.push(p);
    }
    if (!outside.length) {
      /* Everything on the surface is gone; hit whatever is left. */
      for (i = 0; i < h.parts.length; i++) if (!h.parts[i].missing) return h.parts[i];
      return h.parts[0];
    }

    var part = U.pickWeighted(outside, function (p) { return p.coverage; });
    var insideChance = dtype(type).inside;
    var guard = 0;
    while (part && guard++ < 6) {
      var inner = childrenOf(h, part, 'inside');
      if (!inner.length || !U.chance(insideChance)) break;
      part = U.pickWeighted(inner, function (p) { return p.coverage; });
      insideChance *= 0.8;
    }
    return part;
  }

  /* ------------------------------------------------------------------
     Damage
     ------------------------------------------------------------------ */
  function syncPartHp(h, part) {
    if (part.missing) { part.hp = 0; return; }
    var total = 0;
    for (var i = 0; i < h.injuries.length; i++) {
      if (h.injuries[i].partId === part.id) total += h.injuries[i].amount;
    }
    part.hp = U.clamp(part.maxHp - total, 0, part.maxHp);
  }

  function descendants(h, part, out) {
    out = out || [];
    for (var i = 0; i < h.parts.length; i++) {
      if (h.parts[i].parent === part.id) { out.push(h.parts[i]); descendants(h, h.parts[i], out); }
    }
    return out;
  }

  /* A destroyed limb takes everything hanging off it and leaves one
     permanent "missing" record that carries the pain and the stump bleed. */
  function destroyPart(pawn, h, part, bleeding) {
    var gone = [part].concat(descendants(h, part));
    for (var i = 0; i < gone.length; i++) {
      var g = gone[i];
      if (g.missing) continue;
      g.missing = true;
      g.hp = 0;
      h.injuries = h.injuries.filter(function (inj) { return inj.partId !== g.id; });
      h.injuries.push({
        id: U.nextId(), partId: g.id, label: 'missing ' + g.label,
        amount: g.maxHp, bleedRate: bleeding && g.depth === 'outside' ? 0.30 : 0,
        tended: false, tendQuality: 0, infection: 0, permanent: true,
        ageTicks: 0, painFactor: 0.30
      });
    }
    invalidate(pawn);
  }

  Health.damage = function (pawn, opts) {
    opts = opts || {};
    var h = ensure(pawn);
    var result = { dead: h.dead, downed: h.downed, part: null, injury: null, amount: 0, deflected: false };
    if (h.dead) return result;

    var amount = Math.max(0, opts.amount || 0);
    var type = opts.type || 'blunt';
    if (amount <= 0) return result;

    var part = null;
    if (opts.partId !== undefined && opts.partId !== null) part = partById(h, opts.partId);
    else if (opts.partName) part = Health.partNamed(pawn, opts.partName);
    if (!part || part.missing) part = pickHitPart(h, type);
    if (!part) return result;
    result.part = part;

    var armored = applyArmor(pawn, h, part, amount, type, opts.armorPen);
    if (armored.deflected || armored.amount <= 0) {
      result.deflected = true;
      return result;
    }
    amount = armored.amount;
    type = armored.type;
    var t = dtype(type);

    /* Small bodies take proportionally more from the same blow, which is
       why a pistol round is an inconvenience to a bear and fatal to a hare. */
    var dealt = Math.max(1, Math.round(amount));
    result.amount = dealt;

    var overkill = dealt - part.hp;
    var applied = Math.min(dealt, part.hp);

    var injury = {
      id: U.nextId(),
      partId: part.id,
      label: t.label,
      amount: applied,
      bleedRate: applied * BLEED_PER_DAMAGE * t.bleed * (part.depth === 'inside' ? 1.35 : 1),
      tended: false,
      tendQuality: 0,
      infection: 0,
      permanent: false,
      ageTicks: 0,
      painFactor: t.pain,
      severeAt: applied,
      source: opts.source || null,
      instigatorId: opts.instigator ? opts.instigator.id : null
    };

    if (applied > 0) {
      h.injuries.push(injury);
      result.injury = injury;
      syncPartHp(h, part);
    }

    if (part.hp <= 0) {
      if (part.vital) {
        invalidate(pawn);
        Health.kill(pawn, 'a destroyed ' + part.label);
        result.dead = true;
        result.downed = false;
        return result;
      }
      destroyPart(pawn, h, part, t.bleed > 0);
      /* What the blow did not spend on the limb carries into the parent. */
      if (overkill > part.maxHp * 0.5 && part.parent !== null && part.parent !== undefined) {
        var parent = partById(h, part.parent);
        if (parent && !parent.missing) {
          Health.damage(pawn, {
            amount: Math.round(overkill * 0.4), type: type, partId: parent.id,
            source: opts.source, instigator: opts.instigator, armorPen: 99
          });
        }
      }
    }

    invalidate(pawn);
    recompute(pawn);

    if (pawn.isHuman !== false && h.pain > 0.25) thought(pawn, 'pain', { degree: painDegree(h.pain) });

    checkDown(pawn);
    result.dead = h.dead;
    result.downed = h.downed;
    return result;
  };

  function painDegree(p) { return p > 0.7 ? 3 : p > 0.4 ? 2 : p > 0.2 ? 1 : 0; }

  Health.heal = function (pawn, injury, amount) {
    var h = ensure(pawn);
    if (!injury || injury.permanent) return 0;
    var healed = Math.min(injury.amount, Math.max(0, amount));
    injury.amount -= healed;
    var part = partById(h, injury.partId);
    if (injury.amount <= 0.05) finishInjury(pawn, h, injury, part);
    if (part) syncPartHp(h, part);
    invalidate(pawn);
    return healed;
  };

  /* A wound that closes either vanishes or leaves a scar, which is a
     permanent injury of its own and keeps the part slightly below max. */
  function finishInjury(pawn, h, injury, part) {
    U.remove(h.injuries, injury);
    var severe = part && injury.severeAt >= part.maxHp * 0.35;
    if (severe && U.chance(0.45 + (injury.infection > 0 ? 0.2 : 0))) {
      h.injuries.push({
        id: U.nextId(), partId: injury.partId, label: 'scar',
        amount: Math.max(1, Math.round(injury.severeAt * 0.12)),
        bleedRate: 0, tended: true, tendQuality: 1, infection: 0,
        permanent: true, ageTicks: 0, painFactor: 0.2, severeAt: injury.severeAt
      });
    }
  }

  /* ------------------------------------------------------------------
     Bleeding
     ------------------------------------------------------------------ */
  Health.bleedRate = function (pawn) {
    var h = ensure(pawn);
    var total = 0;
    for (var i = 0; i < h.injuries.length; i++) {
      var inj = h.injuries[i];
      if (inj.tended || inj.bleedRate <= 0) continue;
      total += inj.bleedRate;
    }
    var size = (pawn.kind && (pawn.kind.bodySize || pawn.kind.baseHealthScale)) || 1;
    return total / Math.max(0.2, size);
  };

  /* ------------------------------------------------------------------
     Hediffs
     ------------------------------------------------------------------ */
  var HEDIFFS = {
    infection: {
      id: 'infection', label: 'infection', lethal: true, immunizable: true, tendable: true,
      severityPerDay: 0.24, immunityPerDay: 0.34, painOffset: 0.12, thought: 'sick',
      capMods: { consciousness: -0.30, moving: -0.10 }, deathCause: 'an infection'
    },
    flu: {
      id: 'flu', label: 'flu', lethal: true, immunizable: true, tendable: true,
      severityPerDay: 0.20, immunityPerDay: 0.31, painOffset: 0.05, thought: 'sick',
      capMods: { consciousness: -0.25, moving: -0.15, manipulation: -0.10 },
      deathCause: 'the flu'
    },
    hypothermia: {
      id: 'hypothermia', label: 'hypothermia', lethal: true, driven: true, painOffset: 0.10,
      thought: 'sick', capMods: { consciousness: -0.45, moving: -0.40, manipulation: -0.35 },
      deathCause: 'hypothermia'
    },
    heatstroke: {
      id: 'heatstroke', label: 'heatstroke', lethal: true, driven: true, painOffset: 0.08,
      thought: 'sick', capMods: { consciousness: -0.45, moving: -0.35, manipulation: -0.30 },
      deathCause: 'heatstroke'
    },
    malnutrition: {
      id: 'malnutrition', label: 'malnutrition', lethal: true, driven: true, painOffset: 0.05,
      capMods: { consciousness: -0.25, moving: -0.30, manipulation: -0.25 },
      deathCause: 'starvation'
    },
    foodPoisoning: {
      id: 'foodPoisoning', label: 'food poisoning', lethal: false, painOffset: 0.15,
      thought: 'sick', capMods: { consciousness: -0.20, moving: -0.15, manipulation: -0.20 }
    }
  };
  Health.HEDIFFS = HEDIFFS;

  Health.hediff = function (pawn, id) {
    var h = ensure(pawn);
    for (var i = 0; i < h.hediffs.length; i++) if (h.hediffs[i].id === id) return h.hediffs[i];
    return null;
  };
  Health.hasHediff = function (pawn, id) { return !!Health.hediff(pawn, id); };

  Health.addHediff = function (pawn, id, severity) {
    var h = ensure(pawn);
    var def = HEDIFFS[id];
    if (!def) return null;
    var hd = Health.hediff(pawn, id);
    if (hd) {
      hd.severity = U.clamp01(hd.severity + (severity === undefined ? 0.05 : severity));
    } else {
      hd = {
        id: id, def: def, severity: U.clamp01(severity === undefined ? 0.05 : severity),
        ticks: 0, immunity: 0, tended: false, tendQuality: 0
      };
      h.hediffs.push(hd);
      if (def.thought) thought(pawn, def.thought, {});
    }
    invalidate(pawn);
    return hd;
  };

  Health.removeHediff = function (pawn, id) {
    var h = ensure(pawn);
    var hd = Health.hediff(pawn, id);
    if (!hd) return false;
    U.remove(h.hediffs, hd);
    invalidate(pawn);
    return true;
  };

  /* How fast this pawn fights off disease: rest and food matter, and a
     tended wound or bed rest matters most. */
  function immunityGainPerDay(pawn, h) {
    var rest = pawn.needs && pawn.needs.rest !== undefined ? pawn.needs.rest : 0.8;
    var food = pawn.needs && pawn.needs.food !== undefined ? pawn.needs.food : 0.8;
    var best = 0;
    for (var i = 0; i < h.hediffs.length; i++) {
      if (h.hediffs[i].tended) best = Math.max(best, h.hediffs[i].tendQuality);
    }
    for (i = 0; i < h.injuries.length; i++) {
      if (h.injuries[i].tended) best = Math.max(best, h.injuries[i].tendQuality);
    }
    return 0.30 * (0.55 + 0.45 * rest) * (0.60 + 0.40 * food) * (1 + best * 0.8);
  }

  function tickHediffs(pawn, h, days) {
    for (var i = h.hediffs.length - 1; i >= 0; i--) {
      var hd = h.hediffs[i];
      var def = hd.def;
      hd.ticks += RARE;

      if (def.id === 'foodPoisoning') {
        /* Rises for the first quarter day, then wears off. */
        hd.severity = U.clamp01(hd.severity + (hd.ticks < 15000 ? 3.0 : -2.2) * days);
        if (hd.severity <= 0.01) { h.hediffs.splice(i, 1); invalidate(pawn); }
        continue;
      }

      if (def.immunizable) {
        hd.severity = U.clamp01(hd.severity + def.severityPerDay * days);
        hd.immunity = U.clamp01(hd.immunity + h.immunityGain * days *
          (def.immunityPerDay / 0.34) * (hd.tended ? 1 + hd.tendQuality * 0.5 : 1));
        if (hd.immunity >= 1) {
          h.hediffs.splice(i, 1);
          invalidate(pawn);
          if (pawn.faction === 'player' && pawn.isHuman !== false) {
            msg(displayName(pawn) + ' has recovered from ' + def.label + '.', 'good', pawn);
          }
          continue;
        }
      } else if (def.severityPerDay) {
        hd.severity = U.clamp01(hd.severity + def.severityPerDay * days);
      }

      if (def.lethal && hd.severity >= 1) {
        Health.kill(pawn, def.deathCause || def.label);
        return true;
      }
    }
    invalidate(pawn);
    return false;
  }

  /* Untended wounds fester. Infection is one hediff for the whole pawn -
     one dose of medicine treats the patient, not each cut. */
  function rollInfection(pawn, h, days) {
    if (Health.hasHediff(pawn, 'infection')) return;
    for (var i = 0; i < h.injuries.length; i++) {
      var inj = h.injuries[i];
      if (inj.permanent || inj.tended || inj.amount < 4 || inj.ageTicks < 2500) continue;
      var chance = 0.20 * days * (inj.amount / 15);
      if (U.chance(chance)) {
        inj.infection = 0.1;
        Health.addHediff(pawn, 'infection', 0.08);
        if (pawn.faction === 'player' && pawn.isHuman !== false) {
          msg(displayName(pawn) + ' has developed an infection.', 'threat', pawn);
        }
        return;
      }
    }
  }

  /* ------------------------------------------------------------------
     Temperature and food conditions
     ------------------------------------------------------------------ */
  function comfyRange(pawn) {
    var kind = pawn.kind || {};
    var min = kind.comfyTempMin !== undefined ? kind.comfyTempMin : -10;
    var max = kind.comfyTempMax !== undefined ? kind.comfyTempMax : 40;
    var cold = 0, heat = 0;
    if (Array.isArray(pawn.apparel)) {
      for (var i = 0; i < pawn.apparel.length; i++) {
        var d = pawn.apparel[i].def || {};
        var ins = d.insulation || {};
        cold += d.insulationCold !== undefined ? d.insulationCold : (ins.cold || 0);
        heat += d.insulationHeat !== undefined ? d.insulationHeat : (ins.heat || 0);
      }
    }
    return { min: min - cold, max: max + heat };
  }

  function ambientTemp(pawn) {
    var R = Regions();
    if (R && R.roomAt && pawn.map) {
      var room = R.roomAt(pawn.map, pawn.x, pawn.y);
      if (room && room.temperature !== undefined && !room.outdoor) return room.temperature;
    }
    var G = Game();
    if (G && G.outdoorTemp) return G.outdoorTemp();
    return 20;
  }

  function tickTemperature(pawn, h, days) {
    var range = comfyRange(pawn);
    var temp = ambientTemp(pawn);
    var cold = Health.hediff(pawn, 'hypothermia');
    var heat = Health.hediff(pawn, 'heatstroke');

    if (temp < range.min) {
      /* Ten degrees under the comfortable floor kills in about two days. */
      var deficit = range.min - temp;
      Health.addHediff(pawn, 'hypothermia', 0);
      cold = Health.hediff(pawn, 'hypothermia');
      cold.severity = U.clamp01(cold.severity + (deficit / 10) * 0.5 * days);
    } else if (cold) {
      cold.severity -= 1.2 * days;
      if (cold.severity <= 0.01) Health.removeHediff(pawn, 'hypothermia');
    }

    if (temp > range.max) {
      var excess = temp - range.max;
      Health.addHediff(pawn, 'heatstroke', 0);
      heat = Health.hediff(pawn, 'heatstroke');
      heat.severity = U.clamp01(heat.severity + (excess / 10) * 0.6 * days);
    } else if (heat) {
      heat.severity -= 1.4 * days;
      if (heat.severity <= 0.01) Health.removeHediff(pawn, 'heatstroke');
    }
  }

  function tickNutrition(pawn, h, days) {
    var food = pawn.needs && pawn.needs.food !== undefined ? pawn.needs.food : 1;
    var mal = Health.hediff(pawn, 'malnutrition');
    if (food <= 0.001) {
      Health.addHediff(pawn, 'malnutrition', 0);
      mal = Health.hediff(pawn, 'malnutrition');
      mal.severity = U.clamp01(mal.severity + 0.18 * days);
    } else if (mal) {
      mal.severity -= 0.40 * days;
      if (mal.severity <= 0.01) Health.removeHediff(pawn, 'malnutrition');
    }
  }

  /* ------------------------------------------------------------------
     Tending
     ------------------------------------------------------------------ */
  var MEDICINE_POTENCY = { herbalMedicine: 0.80, medicine: 1.00 };

  function potencyOf(medicine) {
    if (!medicine) return 0.50;
    var def = medicine.def || {};
    if (def.medicinePotency !== undefined) return def.medicinePotency;
    var id = def.id || medicine.defId;
    return MEDICINE_POTENCY[id] !== undefined ? MEDICINE_POTENCY[id] : 0.65;
  }

  function skillLevel(pawn, id) {
    if (!pawn || !pawn.skills || !pawn.skills[id]) return 0;
    return pawn.skills[id].level || 0;
  }

  Health.tendQualityFor = function (doctor, medicine) {
    var base = 0.30 + 0.07 * skillLevel(doctor, 'medicine');
    return U.clamp(base * potencyOf(medicine), 0.05, 1);
  };

  Health.tend = function (pawn, doctor, medicine) {
    var h = ensure(pawn);
    if (h.dead) return false;
    if (!Health.needsTending(pawn)) return false;

    var q = Health.tendQualityFor(doctor, medicine);
    /* A shaky hand is worth a little luck either way. */
    q = U.clamp(q + U.gauss(0, 0.07, -0.15, 0.15), 0.05, 1);

    var any = false, i;
    for (i = 0; i < h.injuries.length; i++) {
      var inj = h.injuries[i];
      if (inj.tended || inj.permanent) continue;
      inj.tended = true;
      inj.tendQuality = q;
      /* Good tending all but stops the bleed; bad tending merely slows it. */
      inj.bleedRate *= (1 - q * 0.95);
      if (inj.bleedRate < 0.01) inj.bleedRate = 0;
      any = true;
    }
    for (i = 0; i < h.hediffs.length; i++) {
      if (!h.hediffs[i].def.tendable) continue;
      h.hediffs[i].tended = true;
      h.hediffs[i].tendQuality = q;
      any = true;
    }
    if (!any) return false;

    h.immunityGain = immunityGainPerDay(pawn, h);
    invalidate(pawn);
    thought(pawn, 'tendedWound', { degree: q >= 0.7 ? 1 : 0 });

    var P = PawnLib();
    if (doctor && P && P.gainXp) P.gainXp(doctor, 'medicine', 60);
    return true;
  };

  Health.needsTending = function (pawn) {
    var h = pawn && pawn.health;
    if (!h || h.dead) return false;
    var i;
    for (i = 0; i < h.injuries.length; i++) {
      if (!h.injuries[i].tended && !h.injuries[i].permanent) return true;
    }
    for (i = 0; i < h.hediffs.length; i++) {
      if (h.hediffs[i].def.tendable && !h.hediffs[i].tended) return true;
    }
    return false;
  };

  /* Doctors treat the most urgent patient first: bleeding out beats an
     infection, an infection beats a bruise. */
  Health.tendPriority = function (pawn) {
    var h = pawn && pawn.health;
    if (!h || h.dead || !Health.needsTending(pawn)) return 0;
    var score = 1;
    score += Health.bleedRate(pawn) * 40;
    score += h.bloodLoss * 12;
    if (h.downed) score += 6;
    for (var i = 0; i < h.hediffs.length; i++) {
      var hd = h.hediffs[i];
      if (hd.def.tendable) score += hd.severity * 10 + (1 - hd.immunity) * 2;
    }
    score += Health.painLevel(pawn) * 3;
    return score;
  };

  /* ------------------------------------------------------------------
     The tick
     ------------------------------------------------------------------ */
  Health.tick = function (pawn) {
    var h = pawn && pawn.health;
    if (!h || h.dead) return;
    h.ticks++;
    /* Staggered rare tick: every pawn does its expensive work on a
       different tick of the 250, so no frame carries the whole colony. */
    if (((h.ticks + (pawn.id || 0)) % RARE) !== 0) return;
    Health.tickRare(pawn);
  };

  Health.tickRare = function (pawn) {
    var h = ensure(pawn);
    if (h.dead) return;
    var days = RARE_DAYS;
    var i;

    for (i = 0; i < h.injuries.length; i++) h.injuries[i].ageTicks += RARE;

    var bleed = Health.bleedRate(pawn);
    if (bleed > 0) {
      h.bloodLoss = U.clamp01(h.bloodLoss + bleed * days);
      if (h.bloodLoss >= 1) { Health.kill(pawn, 'blood loss'); return; }
    } else if (h.bloodLoss > 0) {
      h.bloodLoss = Math.max(0, h.bloodLoss - 0.45 * days);
    }

    h.immunityGain = immunityGainPerDay(pawn, h);
    rollInfection(pawn, h, days);
    if (tickHediffs(pawn, h, days)) return;

    tickTemperature(pawn, h, days);
    tickNutrition(pawn, h, days);
    if (h.dead) return;

    healInjuries(pawn, h, days);

    recompute(pawn);
    if (h.pain > 0.15 && pawn.isHuman !== false) {
      thought(pawn, 'pain', { degree: painDegree(h.pain) });
    }
    for (i = 0; i < h.hediffs.length; i++) {
      if (h.hediffs[i].def.thought && h.hediffs[i].severity > 0.2) {
        thought(pawn, h.hediffs[i].def.thought, {});
        break;
      }
    }
    checkDown(pawn);
  };

  /* Wounds close over days. Tending roughly doubles the rate, which is the
     difference between a gunshot healing in four days and in nine. */
  function healInjuries(pawn, h, days) {
    var rest = pawn.needs && pawn.needs.rest !== undefined ? pawn.needs.rest : 0.8;
    var restFactor = 0.7 + 0.5 * rest;
    var infected = Health.hasHediff(pawn, 'infection');
    var touched = {};
    for (var i = h.injuries.length - 1; i >= 0; i--) {
      var inj = h.injuries[i];
      if (inj.permanent) continue;
      if (inj.bleedRate > 0 && !inj.tended) continue;     /* open wounds do not knit */
      var rate = 3.0 * (inj.tended ? 0.6 + inj.tendQuality : 0.55) * restFactor;
      if (infected) rate *= 0.5;
      inj.amount -= rate * days;
      touched[inj.partId] = true;
      if (inj.amount <= 0.05) {
        finishInjury(pawn, h, inj, partById(h, inj.partId));
      }
    }
    Object.keys(touched).forEach(function (pid) {
      var part = partById(h, Number(pid));
      if (part) syncPartHp(h, part);
    });
    invalidate(pawn);
  }

  /* ------------------------------------------------------------------
     Downing and death
     ------------------------------------------------------------------ */
  function checkDown(pawn) {
    var h = pawn.health;
    if (h.dead) return;
    if (h._capDirty) recompute(pawn);
    var c = h.capacities;
    var down = c.consciousness < DOWN_CONSCIOUSNESS || h.pain > DOWN_PAIN || c.moving < DOWN_MOVING;
    if (down === h.downed) return;
    h.downed = down;
    pawn.downed = down;
    if (down) {
      /* A pawn who falls over drops what they were doing and what they held. */
      pawn.path = null;
      pawn.pathIdx = 0;
      var J = typeof root.Jobs !== 'undefined' ? root.Jobs : null;
      if (J && J.end && pawn.job) J.end(pawn, 'interrupted');
      var R = typeof root.Res !== 'undefined' ? root.Res : null;
      if (R && R.releaseAll) R.releaseAll(pawn);
      if (pawn.faction === 'player' && pawn.isHuman !== false) {
        letter('Colonist downed', displayName(pawn) + ' has been downed and needs rescue.', 'threat', pawn);
      }
    }
  }

  function displayName(pawn) {
    if (!pawn.name) return 'someone';
    return pawn.name.nick || pawn.name.first || 'someone';
  }

  function msg(text, type, pawn) {
    var G = Game();
    if (G && G.msg) G.msg(text, { type: type, x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
  }

  function letter(title, text, kind, pawn) {
    var G = Game();
    if (G && G.letter) G.letter(title, text, { kind: kind, x: pawn ? pawn.x : undefined, y: pawn ? pawn.y : undefined });
    else msg(text, kind === 'death' ? 'threat' : kind, pawn);
  }

  Health.kill = function (pawn, cause) {
    var h = ensure(pawn);
    if (h.dead || h._killing) return;
    h._killing = true;
    h.dead = true;
    h.downed = false;
    h.deathCause = cause || 'unknown causes';
    pawn.dead = true;
    pawn.downed = false;
    pawn.path = null;
    pawn.aimTarget = null;
    pawn.mentalState = null;
    var G = Game();
    pawn.deadTick = G && G.tick !== undefined ? G.tick : 0;

    /* Whatever they were holding hits the ground before the corpse does. */
    dropCarriedAndEquipment(pawn);

    var J = typeof root.Jobs !== 'undefined' ? root.Jobs : null;
    if (J && J.end && pawn.job) J.end(pawn, 'failed');
    var R = typeof root.Res !== 'undefined' ? root.Res : null;
    if (R && R.releaseAll) R.releaseAll(pawn);

    /* The corpse, the map bookkeeping and the mood fallout belong to
       pawn.js; find whichever hook it exposes and let it do that work. */
    var P = PawnLib();
    if (P) {
      var hooks = ['onDeath', 'die', 'kill', 'makeCorpse', 'spawnCorpse', 'corpse'];
      for (var i = 0; i < hooks.length; i++) {
        if (typeof P[hooks[i]] === 'function') { P[hooks[i]](pawn, h.deathCause); break; }
      }
    }
    h._killing = false;
  };

  function dropCarriedAndEquipment(pawn) {
    var map = pawn.map;
    if (!map || !map.moveThing) return;
    var drop = [];
    if (pawn.carried) { drop.push(pawn.carried); pawn.carried = null; }
    if (pawn.equipment) { drop.push(pawn.equipment); pawn.equipment = null; }
    if (Array.isArray(pawn.inventory) && pawn.inventory.length) {
      drop = drop.concat(pawn.inventory);
      pawn.inventory = [];
    }
    for (var i = 0; i < drop.length; i++) {
      var t = drop[i];
      if (!t) continue;
      t.spawned = true;
      map.moveThing(t, pawn.x, pawn.y);
    }
    /* Apparel stays on the corpse: stripping it is a job, not a death event. */
  }

  Health.resurrectNothing = function () { return false; };

  /* The hediff table lives here, not in the save file. save.js may drop
     hediff.def to keep saves small and call this once per pawn on load. */
  Health.rebind = function (pawn) {
    var h = pawn && pawn.health;
    if (!h || !h.hediffs) return;
    for (var i = h.hediffs.length - 1; i >= 0; i--) {
      var hd = h.hediffs[i];
      hd.def = HEDIFFS[hd.id];
      if (!hd.def) h.hediffs.splice(i, 1);
    }
    h._capDirty = true;
  };

  /* ------------------------------------------------------------------
     Display
     ------------------------------------------------------------------ */
  Health.missingParts = function (pawn) {
    return ensure(pawn).parts.filter(function (p) { return p.missing; });
  };

  Health.worstInjury = function (pawn) {
    var h = ensure(pawn);
    var best = null, bestScore = 0;
    for (var i = 0; i < h.injuries.length; i++) {
      var inj = h.injuries[i];
      if (inj.permanent) continue;
      var score = inj.amount + (inj.tended ? 0 : inj.bleedRate * 60);
      if (score > bestScore) { bestScore = score; best = inj; }
    }
    return best;
  };

  Health.summary = function (pawn) {
    var h = pawn && pawn.health;
    if (!h) return 'healthy';
    if (h.dead) return 'dead';

    var bleeding = Health.bleedRate(pawn) > 0.01;
    if (h.downed) return bleeding ? 'downed (bleeding)' : 'downed';

    var worstHd = null;
    for (var i = 0; i < h.hediffs.length; i++) {
      if (!worstHd || h.hediffs[i].severity > worstHd.severity) worstHd = h.hediffs[i];
    }
    if (worstHd && worstHd.severity >= 0.15) {
      return worstHd.def.label + ' ' + Math.round(worstHd.severity * 100) + '%';
    }

    var inj = Health.worstInjury(pawn);
    if (inj) return inj.label + (bleeding ? ' (bleeding)' : '');
    if (worstHd) return worstHd.def.label + ' ' + Math.round(worstHd.severity * 100) + '%';

    var missing = Health.missingParts(pawn);
    if (missing.length) return 'missing ' + missing[0].label;
    if (h.bloodLoss > 0.1) return 'blood loss ' + Math.round(h.bloodLoss * 100) + '%';
    return 'healthy';
  };

  /* Rows for the Health tab: one line per damaged or lost part. */
  Health.partReport = function (pawn) {
    var h = ensure(pawn);
    var rows = [];
    for (var i = 0; i < h.parts.length; i++) {
      var part = h.parts[i];
      var mine = h.injuries.filter(function (inj) { return inj.partId === part.id; });
      if (!mine.length && !part.missing) continue;
      rows.push({
        part: part.label,
        missing: part.missing,
        hp: part.hp,
        maxHp: part.maxHp,
        injuries: mine.map(function (inj) {
          return {
            label: inj.label,
            amount: Math.round(inj.amount),
            tended: inj.tended,
            permanent: inj.permanent,
            bleeding: !inj.tended && inj.bleedRate > 0
          };
        })
      });
    }
    return rows;
  };

  Health.CAPS = CAPS;
  Health.DAMAGE_TYPES = DAMAGE_TYPES;

  root.Health = Health;
})(this);
