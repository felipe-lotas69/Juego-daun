/* ============================================================
   combat.js - ranged fire, melee, projectiles, cover and damage.

   The shape of a fight here is RimWorld's, because RimWorld's is the
   one that reads well at sixty ticks a second.

   A shooter does not simply "attack": it takes a stance. Warmup is the
   aim, and it is the window in which the pawn is standing still and can
   be killed for it. Then burstCount rounds leave the barrel burstTicks
   apart, and then cooldownTicks of recovery before anything can begin
   again. Every one of those numbers lives on the weapon def, so a bolt
   rifle and an assault rifle feel completely different without a line
   of code here knowing which is which.

   The hit roll happens when the trigger is pulled, not when the bullet
   lands. A shot that misses still spawns a bullet, aimed at a cell near
   the target, and that bullet damages whatever is standing there. That
   is not a quirk to be tidied away later: it is why a colonist firing
   past a friend into a doorway sometimes shoots the friend, and why a
   firing line eventually chews up its own sandbags. It stays.

   Cover is read from the two cells in front of the *target*, never the
   ones in front of the shooter, which is what makes a sandbag line worth
   building across the enemy approach and worthless behind your own guns.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var Defs = root.Defs;

  /* Systems that load after this one, or that a partial test harness may
     leave out entirely. Looked up on use, never captured at load. */
  function Game() { return typeof root.Game !== 'undefined' ? root.Game : null; }
  function Health() { return typeof root.Health !== 'undefined' ? root.Health : null; }
  function Needs() { return typeof root.Needs !== 'undefined' ? root.Needs : null; }
  function Plants() { return typeof root.Plants !== 'undefined' ? root.Plants : null; }
  function PathLib() { return typeof root.Path !== 'undefined' ? root.Path : null; }
  function PawnLib() { return typeof root.Pawn !== 'undefined' ? root.Pawn : null; }

  var Combat = {};

  var TICKS_PER_SECOND = 60;
  var TAU = Math.PI * 2;

  /* The four ranges the weapon accuracy curve is quoted at. */
  var BAND_TOUCH = 3, BAND_SHORT = 12, BAND_MEDIUM = 25, BAND_LONG = 40;

  /* Cover in the cell right in front of the target counts in full; one
     cell further back only catches shots on a flat trajectory. */
  var COVER_NEAR = 1.0, COVER_FAR = 0.55;
  /* Even a wall leaves a sliver: a target that can be seen can be hit. */
  var COVER_MAX = 0.85;
  /* A body in the way is thin cover, but it is cover. */
  var PAWN_FILL = 0.30;

  var MIN_HIT = 0.02, MAX_HIT = 0.97;

  /* A stray round only counts as a hit on whoever happens to be standing
     in the cell it lands in some of the time; the rest goes over a head. */
  var BYSTANDER_HIT = 0.45;
  /* A bullet crossing an occupied cell in flight rarely clips the occupant. */
  var INTERCEPT_PAWN = 0.12;
  /* fillPercent at which a thing stops a round dead rather than being shot over. */
  var BLOCK_FILL = 0.85;
  /* Below this, a round passes over the thing in the impact cell entirely. */
  var HITTABLE_FILL = 0.15;

  /* A turret has no shooting skill; this is the flat number that stands in
     for one, and it is deliberately worse than a competent colonist. */
  var TURRET_ACCURACY = 0.72;

  /* Bare hands. A punch is not nothing, but a knife is much better. */
  var UNARMED = { damage: 6, damageType: 'blunt', cooldownTicks: 90 };

  /* Buildings are not flesh: a rifle round punches a hole in a wall and
     keeps going, while a blast levels it. */
  var THING_DAMAGE = {
    bullet: 0.45, arrow: 0.40, stab: 0.35, cut: 0.40, scratch: 0.20,
    bite: 0.30, blunt: 0.75, crush: 1.0, explosion: 1.6, burn: 1.1
  };

  /* Traits that change how a pawn fights. Mood traits live in needs.js. */
  var TRAIT_COMBAT = {
    carefulShooter: { rangedAccuracy: 1.30, warmup: 1.65 },
    triggerHappy: { rangedAccuracy: 0.78, warmup: 0.60, cooldown: 0.75 },
    brawler: { rangedAccuracy: 0.55, meleeHit: 1.25, meleeDamage: 1.15 },
    nimble: { dodge: 1.40, meleeHit: 1.10 },
    wimp: { meleeDamage: 0.85 },
    tough: { dodge: 0.85, meleeDamage: 1.10 }
  };

  /* What a raid goes for when no one is in the open. Bounded on purpose:
     these are the def ids worth walking up to and hitting, and every one
     of them is cheap to enumerate through map.byDef. */
  var STRUCTURE_TARGETS = [
    'turret', 'door', 'wall', 'sandbags', 'battery',
    'solarPanel', 'windTurbine', 'woodGenerator'
  ];
  var STRUCTURE_VALUE = { turret: 6, battery: 2.2, solarPanel: 1.6, windTurbine: 1.6, woodGenerator: 1.6, door: 1.2 };

  var _tick = 0;

  function now() {
    var G = Game();
    return G && typeof G.tick === 'number' ? G.tick : _tick;
  }

  /* ------------------------------------------------------------------
     Identity and faction relations
     ------------------------------------------------------------------ */

  /* Pawns carry isHuman; things never do. That is the cheapest honest
     test, and combat asks it on every projectile impact. */
  function isPawn(x) { return !!x && x.isHuman !== undefined; }

  function isBerserk(p) {
    var ms = p && p.mentalState;
    return !!(ms && ms.id === 'berserk');
  }

  /* An animal that has settled on something - a predator on its meal, a
     wounded one on whoever shot it - is hostile to that one pawn and to
     nobody else. animals.js keeps the decision in pawn.animalMind and the
     attack itself in the job; either is enough to read the intent. */
  function aggroTargetId(a) {
    var mind = a.animalMind;
    if (mind && (mind.preyId || mind.revengeId)) return mind.preyId || mind.revengeId;
    var job = a.job;
    if (job && job.targetA && job.targetA.k === 'p' &&
        (job.defId === 'attackMelee' || job.defId === 'attackStatic' || job.defId === 'hunt')) {
      return job.targetA.id;
    }
    return 0;
  }

  function isManhunter(a) {
    return !!(a.manhunter || (a.animalMind && a.animalMind.manhunterTicks > 0));
  }

  var FACTION_ENEMIES = {
    player: { raider: true },
    raider: { player: true, wild: true, neutral: true },
    neutral: { raider: true },
    /* Wildlife starts no fights by faction: see the manhunter and
       predator cases below. */
    wild: {}
  };

  function factionsFight(fa, fb) {
    if (!fa || !fb || fa === fb) return false;
    var ea = FACTION_ENEMIES[fa], eb = FACTION_ENEMIES[fb];
    return !!((ea && ea[fb]) || (eb && eb[fa]));
  }

  function startsFightWith(a, b) {
    /* A berserk pawn has no friends. */
    if (isBerserk(a)) return true;
    var fa = a.faction, fb = b.faction;
    if (!fa || !fb || fa === fb) return false;
    if (fa === 'wild') {
      /* A manhunter pack attacks everything that is not also wildlife. */
      if (isManhunter(a)) return !(b.isAnimal && fb === 'wild');
      return b.id !== undefined && aggroTargetId(a) === b.id;
    }
    var enemies = FACTION_ENEMIES[fa];
    return !!(enemies && enemies[fb]);
  }

  /* Two entities, or - the way think.js asks it when Game is not there to
     answer - two faction ids. The table settles both questions, and only
     the entity form can see a berserk colonist or a manhunter hare. */
  Combat.hostile = function (a, b) {
    if (!a || !b || a === b) return false;
    if (typeof a === 'string' || typeof b === 'string') {
      return factionsFight(typeof a === 'string' ? a : a.faction,
                           typeof b === 'string' ? b : b.faction);
    }
    return startsFightWith(a, b) || startsFightWith(b, a);
  };

  /* Four factions stand on the map, and an unknown one is neutral until
     told otherwise. A world-map civilization that arrives with an id of
     its own declares its relations here rather than having this table
     rewritten underneath it. */
  Combat.setRelation = function (a, b, hostile) {
    if (!a || !b || a === b) return;
    if (!FACTION_ENEMIES[a]) FACTION_ENEMIES[a] = {};
    if (!FACTION_ENEMIES[b]) FACTION_ENEMIES[b] = {};
    FACTION_ENEMIES[a][b] = !!hostile;
    FACTION_ENEMIES[b][a] = !!hostile;
  };

  /* ------------------------------------------------------------------
     Line of sight and cover
     ------------------------------------------------------------------ */

  /* map.js has no reason to track whether a door is standing open, so the
     flag may simply be absent; an absent flag means shut, which is the
     safe answer for both sight and cover. */
  function isOpenDoor(thing) {
    var b = thing && thing.def && thing.def.building;
    return !!(b && b.isDoor && thing.open === true);
  }

  function wallBlocksSight(map, x, y) {
    var b = map.buildingAt(x, y);
    if (!b || !b.def || !b.def.blocksLight) return false;
    return !isOpenDoor(b);
  }

  /* A grown tree carries blocksLight and its def promises it breaks a
     raider's line of sight, and this file is the only thing that reads the
     flag. A sapling is knee high and stops nothing, so the canopy has to
     be up before the sightline goes down. */
  var CANOPY_GROWTH = 0.4;

  function blocksSight(map, x, y) {
    if (wallBlocksSight(map, x, y)) return true;
    var p = map.plantAt ? map.plantAt(x, y) : null;
    if (!p || !p.def || !p.def.blocksLight) return false;
    return p.growth === undefined || p.growth >= CANOPY_GROWTH;
  }

  /* Bresenham, start and end cells excluded: a pawn standing in a doorway
     can still shoot out of it, and one standing under a tree can still be
     shot. `plantsToo` is false for a blast, which a hedge does not contain. */
  function traceClear(map, x1, y1, x2, y2, plantsToo) {
    if (!map) return false;
    x1 = x1 | 0; y1 = y1 | 0; x2 = x2 | 0; y2 = y2 | 0;
    if (!map.inBounds(x1, y1) || !map.inBounds(x2, y2)) return false;
    var dx = Math.abs(x2 - x1), sx = x1 < x2 ? 1 : -1;
    var dy = -Math.abs(y2 - y1), sy = y1 < y2 ? 1 : -1;
    var err = dx + dy, x = x1, y = y1;
    while (x !== x2 || y !== y2) {
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
      if (x === x2 && y === y2) return true;
      if (plantsToo ? blocksSight(map, x, y) : wallBlocksSight(map, x, y)) return false;
    }
    return true;
  }

  Combat.lineOfSight = function (map, x1, y1, x2, y2) {
    return traceClear(map, x1, y1, x2, y2, true);
  };

  /* Reused so that asking for a hit chance every frame in the UI does not
     allocate. Holds packed cell indices along the current line. */
  var _line = [];

  function traceLine(map, x1, y1, x2, y2) {
    _line.length = 0;
    var dx = Math.abs(x2 - x1), sx = x1 < x2 ? 1 : -1;
    var dy = -Math.abs(y2 - y1), sy = y1 < y2 ? 1 : -1;
    var err = dx + dy, x = x1, y = y1, guard = dx - dy + 4;
    for (var i = 0; i <= guard; i++) {
      _line.push(x, y);
      if (x === x2 && y === y2) break;
      var e2 = 2 * err;
      if (e2 >= dy) { err += dy; x += sx; }
      if (e2 <= dx) { err += dx; y += sy; }
    }
    return _line;
  }

  function fillAt(map, x, y) {
    if (!map.inBounds(x, y)) return 0;
    var best = 0, i, list;
    var b = map.buildingAt(x, y);
    if (b && b.def && !isOpenDoor(b)) best = b.def.fillPercent || 0;
    if (best < 1 && map.items) {
      list = map.items(x, y);
      for (i = 0; i < list.length; i++) {
        var f = list[i].def ? (list[i].def.fillPercent || 0) : 0;
        if (f > best) best = f;
      }
    }
    if (best < PAWN_FILL && map.pawnsAt) {
      list = map.pawnsAt(x, y);
      for (i = 0; i < list.length; i++) {
        var p = list[i];
        if (p.dead || p.downed) continue;
        best = PAWN_FILL;
        break;
      }
    }
    return best;
  }

  Combat.coverPenalty = function (map, fromX, fromY, toX, toY) {
    if (!map) return 0;
    fromX = fromX | 0; fromY = fromY | 0; toX = toX | 0; toY = toY | 0;
    if (fromX === toX && fromY === toY) return 0;
    var line = traceLine(map, fromX, fromY, toX, toY);
    var cells = line.length / 2;
    var best = 0;
    for (var k = 1; k <= 2; k++) {
      var at = cells - 1 - k;
      /* The shooter's own cell protects the shooter, never the target. */
      if (at <= 0) break;
      var fill = fillAt(map, line[at * 2], line[at * 2 + 1]);
      var v = fill * (k === 1 ? COVER_NEAR : COVER_FAR);
      if (v > best) best = v;
    }
    return U.clamp(best, 0, COVER_MAX);
  };

  /* ------------------------------------------------------------------
     Weapons
     ------------------------------------------------------------------ */

  /* Callers pass whatever they have: a thing def, an equipped weapon, or
     the weapon block itself. All three mean the same gun. */
  function weaponBlock(x) {
    if (!x) return null;
    if (x.weapon) return x.weapon;
    if (x.def && x.def.weapon) return x.def.weapon;
    return x.ranged !== undefined && x.damage !== undefined ? x : null;
  }

  function equippedDef(pawn) {
    var eq = pawn && pawn.equipment;
    if (!eq) return null;
    return eq.def || (eq.defId && Defs.maybe('thing', eq.defId)) || null;
  }

  Combat.weaponOf = function (pawn) {
    return weaponBlock(equippedDef(pawn));
  };

  function rangedWeapon(pawn) {
    var w = weaponBlock(equippedDef(pawn));
    return w && w.ranged ? w : null;
  }

  Combat.turretWeapon = function (def) {
    var b = def && def.building;
    if (!b || !b.turretWeapon) return null;
    if (typeof b.turretWeapon === 'string') {
      var gun = Defs.maybe('thing', b.turretWeapon);
      return gun ? weaponBlock(gun) : null;
    }
    return weaponBlock(b.turretWeapon);
  };

  /* What a swing does, in order of preference: the melee weapon in hand,
     the animal's own teeth, a rifle used as a club, bare hands. */
  function meleeProfile(attacker) {
    var def = equippedDef(attacker);
    var w = weaponBlock(def);
    if (w && !w.ranged) {
      return {
        damage: w.damage, type: w.damageType, cooldown: w.cooldownTicks,
        pen: w.armorPen || 0, source: def
      };
    }
    var kind = attacker.kind;
    if (attacker.isAnimal && kind) {
      return {
        damage: kind.meleeDamage || 5,
        type: kind.meleeDamageType || 'bite',
        cooldown: kind.meleeCooldownTicks || 100,
        pen: kind.meleeArmorPen || 0,
        source: kind
      };
    }
    if (w && w.ranged) {
      /* Swinging a rifle by the barrel: better than nothing, worse than a club. */
      return {
        damage: Math.max(4, Math.round(w.damage * 0.35)), type: 'blunt',
        cooldown: 110, pen: 0, source: def
      };
    }
    return {
      damage: UNARMED.damage, type: UNARMED.damageType,
      cooldown: UNARMED.cooldownTicks, pen: 0, source: null
    };
  }

  /* ------------------------------------------------------------------
     Skills, traits, capacities
     ------------------------------------------------------------------ */

  function skillLevel(pawn, id) {
    if (!pawn) return 0;
    var s = pawn.skills && pawn.skills[id];
    if (s) return s.level || 0;
    /* Animals have no skill table; their kind carries the equivalent. */
    var kind = pawn.kind;
    if (kind) {
      if (id === 'melee' && kind.meleeSkill !== undefined) return kind.meleeSkill;
      if (kind.combatPower !== undefined) return U.clamp(Math.round(kind.combatPower / 20), 1, 12);
    }
    return 4;
  }

  /* pawn.js owns levelling; this only exists so a fight still teaches a
     colonist something when it is exercised on its own. */
  function gainSkill(pawn, id, xp) {
    if (!pawn || !pawn.skills || !(xp > 0)) return;
    var P = PawnLib();
    if (P && typeof P.gainXp === 'function') { P.gainXp(pawn, id, xp); return; }
    if (typeof pawn.gainXp === 'function') { pawn.gainXp(id, xp); return; }
    var s = pawn.skills[id];
    if (!s) return;
    s.xp += xp * (s.passion === 2 ? 1.5 : (s.passion === 1 ? 1.0 : 0.35));
    while (s.level < 20 && s.xp >= 1000 * (s.level + 1)) {
      s.xp -= 1000 * (s.level + 1);
      s.level++;
    }
  }

  function traitFactor(pawn, key) {
    var traits = pawn && pawn.traits;
    if (!traits || !traits.length) return 1;
    var f = 1;
    for (var i = 0; i < traits.length; i++) {
      var id = typeof traits[i] === 'string' ? traits[i] : (traits[i] && traits[i].id);
      var t = id && TRAIT_COMBAT[id];
      if (t && t[key] !== undefined) f *= t[key];
    }
    return f;
  }

  function capacity(pawn, name) {
    var H = Health();
    if (!H || !isPawn(pawn)) return 1;
    return H.capacity(pawn, name);
  }

  /* ------------------------------------------------------------------
     Hit chance
     ------------------------------------------------------------------ */

  function accuracyAt(acc, dist) {
    if (!acc) return 0.6;
    return U.curve([
      [BAND_TOUCH, acc.touch], [BAND_SHORT, acc.short],
      [BAND_MEDIUM, acc.medium], [BAND_LONG, acc.long]
    ], dist);
  }

  function shooterAccuracy(shooter) {
    if (!isPawn(shooter)) return TURRET_ACCURACY;
    var v = (0.4 + 0.03 * skillLevel(shooter, 'shooting')) * traitFactor(shooter, 'rangedAccuracy');
    /* You cannot shoot what you cannot see, or hold steady what you
       cannot grip, or aim at all while half conscious. */
    v *= U.lerp(0.35, 1, capacity(shooter, 'sight'));
    v *= U.lerp(0.50, 1, capacity(shooter, 'manipulation'));
    v *= U.lerp(0.40, 1, capacity(shooter, 'consciousness'));
    return v;
  }

  Combat.rangedHitChance = function (shooter, target, weapon, opts) {
    var w = weaponBlock(weapon) || rangedWeapon(shooter);
    if (!w || !target) return 0;
    var map = (opts && opts.map) || shooter.map || target.map;
    var d = U.dist(shooter.x, shooter.y, target.x, target.y);
    var v = accuracyAt(w.accuracy, d) * shooterAccuracy(shooter);
    if (map) v *= 1 - Combat.coverPenalty(map, shooter.x, shooter.y, target.x, target.y);
    /* A body on the ground is not dodging, and a building never was. */
    if (!isPawn(target)) v *= 1.6;
    else if (target.downed) v *= 1.5;
    return U.clamp(v, MIN_HIT, MAX_HIT);
  };

  Combat.meleeHitChance = function (attacker, target) {
    if (!attacker || !target) return 0;
    var hit = (0.62 + 0.024 * skillLevel(attacker, 'melee')) * traitFactor(attacker, 'meleeHit');
    hit *= U.lerp(0.45, 1, capacity(attacker, 'manipulation'));
    hit *= U.lerp(0.40, 1, capacity(attacker, 'consciousness'));
    if (!isPawn(target)) return U.clamp(hit * 1.45, MIN_HIT, 0.99);
    var dodge = (0.10 + 0.011 * skillLevel(target, 'melee')) * traitFactor(target, 'dodge');
    if (target.downed || target.dead) dodge = 0;
    else dodge *= capacity(target, 'moving');
    return U.clamp(hit * (1 - U.clamp(dodge, 0, 0.6)), MIN_HIT, MAX_HIT);
  };

  /* The one the UI asks: what happens if this pawn attacks that, right now. */
  Combat.hitChance = function (pawn, target) {
    if (!pawn || !target) return 0;
    var w = rangedWeapon(pawn);
    if (w && U.dist(pawn.x, pawn.y, target.x, target.y) <= w.range) {
      return Combat.rangedHitChance(pawn, target, w);
    }
    return Combat.meleeHitChance(pawn, target);
  };

  /* ------------------------------------------------------------------
     Damage
     ------------------------------------------------------------------ */

  function spillBlood(map, x, y, amount) {
    if (!map || !map.blood || !map.inBounds(x, y)) return;
    var i = map.idx(x, y);
    var v = map.blood[i] + Math.min(90, 14 + amount * 4);
    map.blood[i] = v > 255 ? 255 : v;
  }

  function onKilled(map, victim, killer) {
    if (!killer || !isPawn(killer) || !isPawn(victim)) return;
    var N = Needs();
    if (N && N.addThought && killer.isHuman && victim.isHuman && !killer.dead) {
      var traits = killer.traits || [];
      for (var i = 0; i < traits.length; i++) {
        var id = typeof traits[i] === 'string' ? traits[i] : (traits[i] && traits[i].id);
        if (id === 'bloodlust') { N.addThought(killer, 'killedHumanBloodlust', {}); break; }
      }
    }
  }

  function damagePawn(map, pawn, spec) {
    var H = Health();
    if (!H || pawn.dead) return null;
    var res = H.damage(pawn, {
      amount: spec.amount,
      type: spec.type || 'blunt',
      partId: spec.partId === undefined ? null : spec.partId,
      source: spec.source || null,
      armorPen: spec.armorPen || 0,
      instigator: spec.instigator || null
    });
    if (res && res.amount > 0) spillBlood(map, pawn.x, pawn.y, res.amount);
    /* Health.kill runs the corpse and the mood fallout through pawn.js;
       combat only needs to know that it happened. */
    if (res && res.dead) onKilled(map, pawn, spec.instigator);
    return res;
  }

  function tryIgnite(map, x, y, chance) {
    var P = Plants();
    if (!P || !P.startFire || !map.inBounds(x, y)) return;
    if (chance !== undefined && !U.chance(chance)) return;
    P.startFire(map, x, y);
  }

  function damageThing(map, thing, spec) {
    if (!thing || thing.spawned === false || !thing.def) return null;
    var factor = THING_DAMAGE[spec.type];
    if (factor === undefined) factor = 0.6;
    var amount = Math.max(1, Math.round((spec.amount || 0) * factor));
    if (thing.hp === undefined || thing.hp === null) thing.hp = thing.def.hp || 50;
    thing.hp -= amount;
    if (spec.type === 'burn' && thing.def.flammable) tryIgnite(map, thing.x, thing.y, 0.6);
    var out = { amount: amount, destroyed: false, thing: thing };
    if (thing.hp <= 0) {
      thing.hp = 0;
      out.destroyed = true;
      var b = thing.def.building;
      var x = thing.x, y = thing.y;
      if (map.destroyThing) map.destroyThing(thing, 'damage');
      /* The mini-turret cooks off when it dies, exactly as its def warns. */
      if (b && b.isTurret) Combat.explosion(map, x, y, 2.9, 40, 'explosion', { instigator: spec.instigator });
    }
    return out;
  }

  Combat.damage = function (map, victim, spec) {
    if (!victim || !spec || !(spec.amount > 0)) return null;
    if (isPawn(victim)) return damagePawn(map, victim, spec);
    return damageThing(map, victim, spec);
  };

  /* ------------------------------------------------------------------
     Projectiles

     A projectile is a plain record in an array owned by this file, not a
     Thing on the map: a hundred rounds in the air must not touch the
     thing registry, the item grid or the region system.
     ------------------------------------------------------------------ */

  Combat.projectiles = [];
  Combat.explosions = [];

  /* Weapons that do not state a miss radius get one from the range: the
     further the shot, the wider the group of cells it can wander into. */
  function missRadiusFor(dist) { return U.clamp(dist * 0.16, 1.2, 4.5); }

  Combat.spawnProjectile = function (map, shooter, target, weaponDef, opts) {
    opts = opts || {};
    var w = weaponBlock(weaponDef) || rangedWeapon(shooter);
    if (!map || !w || !shooter) return null;

    var aimX = opts.cellX !== undefined ? opts.cellX : (target ? target.x : shooter.x);
    var aimY = opts.cellY !== undefined ? opts.cellY : (target ? target.y : shooter.y);
    var hitChance = opts.hitChance !== undefined
      ? opts.hitChance
      : (target ? Combat.rangedHitChance(shooter, target, w, { map: map }) : 1);
    var willHit = opts.forceHit === true || U.chance(hitChance);

    var tx = aimX, ty = aimY;
    if (!willHit) {
      /* The forced miss is chosen now, so the bullet visibly flies at the
         wrong cell rather than evaporating on arrival. */
      var r = w.forcedMissRadius > 0 ? w.forcedMissRadius : missRadiusFor(U.dist(shooter.x, shooter.y, aimX, aimY));
      var ang = U.rand() * TAU;
      var rad = 0.7 + Math.sqrt(U.rand()) * r;
      tx = Math.round(aimX + Math.cos(ang) * rad);
      ty = Math.round(aimY + Math.sin(ang) * rad);
      if (tx === aimX && ty === aimY) { tx += U.chance(0.5) ? 1 : -1; }
      tx = U.clamp(tx, 0, map.w - 1);
      ty = U.clamp(ty, 0, map.h - 1);
      /* Clamping at the map edge can fold the miss back onto the muzzle.
         Send it one cell towards the target instead of nowhere at all. */
      if (tx === shooter.x && ty === shooter.y) {
        tx = U.clamp(shooter.x + (U.sign(aimX - shooter.x) || 1), 0, map.w - 1);
        ty = U.clamp(shooter.y + U.sign(aimY - shooter.y), 0, map.h - 1);
      }
    }

    var dist = U.dist(shooter.x, shooter.y, tx, ty);
    if (dist < 0.001) return null;
    var speed = (w.projectileSpeed > 0 ? w.projectileSpeed : 60) / TICKS_PER_SECOND;

    var p = {
      id: U.nextId(),
      map: map,
      defId: w.projectileDef || 'bullet',
      x: shooter.x, y: shooter.y,
      sx: shooter.x, sy: shooter.y,
      tx: tx, ty: ty,
      cellX: shooter.x | 0, cellY: shooter.y | 0,
      dist: dist, travelled: 0, speed: speed,
      damage: opts.damage !== undefined ? opts.damage : w.damage,
      damageType: opts.damageType || w.damageType || 'bullet',
      armorPen: opts.armorPen !== undefined ? opts.armorPen : (w.armorPen || 0),
      explosionRadius: opts.explosionRadius || 0,
      sourceDef: opts.source || weaponDef || null,
      instigator: shooter,
      instigatorId: shooter.id,
      faction: shooter.faction || null,
      target: target || null,
      willHit: willHit,
      blocked: null,
      dead: false
    };
    Combat.projectiles.push(p);
    return p;
  };

  function liveTarget(t) {
    if (!t) return null;
    if (isPawn(t)) return t.dead ? null : t;
    return t.spawned === false ? null : t;
  }

  /* Something standing between muzzle and destination sometimes eats the
     round on the way past. Walls always do. */
  function interceptAt(map, p, x, y) {
    if (x === p.tx && y === p.ty) return null;
    var b = map.buildingAt(x, y);
    if (b && b.def && (b.def.fillPercent || 0) >= BLOCK_FILL && !isOpenDoor(b)) return b;
    var list = map.pawnsAt ? map.pawnsAt(x, y) : null;
    if (list) {
      for (var i = 0; i < list.length; i++) {
        var q = list[i];
        if (q.dead || q.downed || q.id === p.instigatorId) continue;
        if (q === p.target && p.willHit) return q;
        if (U.chance(INTERCEPT_PAWN)) return q;
      }
    }
    return null;
  }

  function impact(map, p) {
    var x = U.clamp(Math.round(p.x), 0, map.w - 1);
    var y = U.clamp(Math.round(p.y), 0, map.h - 1);

    if (p.explosionRadius > 0) {
      Combat.explosion(map, x, y, p.explosionRadius, p.damage, p.damageType, { instigator: p.instigator });
      return;
    }

    var victim = p.blocked || null;
    /* The roll made at the muzzle only pays out if the target is still
       standing where the round was sent. */
    if (!victim && p.willHit) {
      var t = liveTarget(p.target);
      if (t && U.cheb(t.x, t.y, x, y) <= 1) victim = t;
    }
    if (!victim && map.pawnsAt) {
      var list = map.pawnsAt(x, y), live = [];
      for (var i = 0; i < list.length; i++) if (!list[i].dead) live.push(list[i]);
      if (live.length && U.chance(BYSTANDER_HIT)) victim = U.pick(live);
    }
    if (!victim) {
      var b = map.buildingAt(x, y);
      if (b && b.def && (b.def.fillPercent || 0) > HITTABLE_FILL && !isOpenDoor(b)) victim = b;
      else {
        var plant = map.plantAt ? map.plantAt(x, y) : null;
        if (plant && U.chance(0.35)) victim = plant;
      }
    }
    if (!victim) return;

    Combat.damage(map, victim, {
      amount: p.damage, type: p.damageType, armorPen: p.armorPen,
      instigator: p.instigator, source: p.sourceDef
    });
  }

  /* Flown in steps of at most one tile even when the round covers more
     than that in a tick. A sniper round moves 1.33 tiles a tick, and a
     single jump of that length rounds straight past every third cell -
     which is a bullet through a one-tile wall. */
  function advanceProjectile(map, p) {
    var left = p.speed;
    while (left > 0) {
      var step = left > 1 ? 1 : left;
      left -= step;
      p.travelled += step;
      if (p.travelled >= p.dist) {
        p.x = p.tx; p.y = p.ty;
        p.dead = true;
        impact(map, p);
        return;
      }
      var t = p.travelled / p.dist;
      p.x = p.sx + (p.tx - p.sx) * t;
      p.y = p.sy + (p.ty - p.sy) * t;
      var cx = Math.round(p.x), cy = Math.round(p.y);
      if (cx === p.cellX && cy === p.cellY) continue;
      p.cellX = cx; p.cellY = cy;
      if (!map.inBounds(cx, cy)) { p.dead = true; return; }
      var hit = interceptAt(map, p, cx, cy);
      if (hit) {
        p.blocked = hit;
        p.dead = true;
        impact(map, p);
        return;
      }
    }
  }

  /* ------------------------------------------------------------------
     Explosions
     ------------------------------------------------------------------ */

  /* A boomrat that kills a boomrat that kills a boomrat is funny exactly
     once; past this depth the chain stops detonating. */
  var MAX_CHAIN = 6;
  var _chain = 0;

  Combat.explosion = function (map, x, y, radius, damage, type, opts) {
    if (!map || !map.inBounds(x, y) || _chain >= MAX_CHAIN) return null;
    /* The depth has to come back down even if something inside the blast
       radius throws on the way, or one bad tick silently disarms every
       explosion for the rest of the game. */
    _chain++;
    try { return detonate(map, x, y, radius, damage, type, opts || {}); }
    finally { _chain--; }
  };

  function detonate(map, x, y, radius, damage, type, opts) {
    var fire = type === 'flame' || type === 'incendiary' || type === 'fire' || type === 'burn';
    type = fire ? 'burn' : (type || 'explosion');
    radius = Math.max(0.5, radius);
    damage = Math.max(1, damage || 1);
    var fireChance = opts.chanceToStartFire !== undefined ? opts.chanceToStartFire : (fire ? 0.55 : 0);

    var cells = U.cellsInRadius(x, y, Math.ceil(radius));
    var struck = {};
    for (var i = 0; i < cells.length; i++) {
      var cx = cells[i][0], cy = cells[i][1];
      if (!map.inBounds(cx, cy)) continue;
      var d = U.dist(x, y, cx, cy);
      if (d > radius) continue;
      /* Walls contain a blast: past the first ring, only cells the centre
         can actually reach are inside it. */
      if (d > 1.5 && !traceClear(map, x, y, cx, cy, false)) continue;
      var amount = Math.max(1, Math.round(damage * (1 - 0.55 * (d / radius))));

      /* Backwards: killing a pawn takes it straight out of the per-cell
         index this list is, and a forward loop would step over its
         neighbour on the way. */
      var pawns = map.pawnsAt ? map.pawnsAt(cx, cy) : null;
      if (pawns) {
        for (var j = pawns.length - 1; j >= 0; j--) {
          var q = pawns[j];
          if (q.dead || struck[q.id]) continue;
          struck[q.id] = true;
          Combat.damage(map, q, {
            amount: amount, type: type, armorPen: 0.2,
            instigator: opts.instigator || null, source: opts.source || null
          });
        }
      }

      var b = map.buildingAt(cx, cy);
      if (b && !struck['t' + b.id]) {
        struck['t' + b.id] = true;
        Combat.damage(map, b, { amount: amount, type: type, instigator: opts.instigator || null });
      }
      var plant = map.plantAt ? map.plantAt(cx, cy) : null;
      if (plant && !struck['t' + plant.id]) {
        struck['t' + plant.id] = true;
        Combat.damage(map, plant, { amount: amount, type: type, instigator: opts.instigator || null });
      }
      if (fireChance > 0) tryIgnite(map, cx, cy, fireChance * (1 - 0.5 * d / radius));
    }

    var rec = {
      id: U.nextId(), map: map, x: x, y: y, radius: radius,
      type: type, ticksLeft: 22, maxTicks: 22
    };
    Combat.explosions.push(rec);
    return rec;
  }

  /* ------------------------------------------------------------------
     Stances

     Warmup, burst and cooldown live in one record per shooter, keyed by
     entity id so a turret and a pawn use the same machinery. It is
     deliberately transient: a stance is at most a couple of seconds long
     and nothing is lost by rebuilding it after a save.
     ------------------------------------------------------------------ */

  /* The stance is advanced by Combat.tick, once per tick, never by whoever
     calls tryAttack. Callers differ - a job driver ticks its pawn every
     tick, animals.js waits out stanceTicks before calling again - and a
     burst that only moves when somebody remembers to ask is not a burst. */
  var _stances = new Map();

  Combat.stanceOf = function (e) { return (e && _stances.get(e.id)) || null; };

  Combat.clearStance = function (e) {
    if (!e) return;
    _stances.delete(e.id);
    if (e.stanceTicks !== undefined) e.stanceTicks = 0;
    if (e.aimTarget !== undefined) e.aimTarget = null;
  };

  function targetRecord(t) {
    var T = root.T;
    if (T) return isPawn(t) ? T.pawn(t) : T.thing(t);
    return { k: isPawn(t) ? 'p' : 't', id: t.id, x: t.x, y: t.y };
  }

  function faceToward(e, x, y) {
    if (e.dir === undefined) return;
    var dx = x - e.x, dy = y - e.y;
    if (!dx && !dy) return;
    e.dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 1 : 3) : (dy > 0 ? 2 : 0);
  }

  function beginRanged(map, shooter, target, w, weaponSource) {
    var warm = Math.max(1, Math.round((w.warmupTicks || 30) * traitFactor(shooter, 'warmup')));
    var cool = Math.max(1, Math.round((w.cooldownTicks || 60) * traitFactor(shooter, 'cooldown')));
    var st = {
      id: shooter.id, owner: shooter, map: map, ranged: true, mode: 'warmup',
      ticksLeft: warm, total: warm,
      shotsLeft: Math.max(1, w.burstCount || 1),
      burstTicks: Math.max(1, w.burstTicks || 1),
      cooldown: cool, w: w, source: weaponSource || null,
      target: target
    };
    _stances.set(shooter.id, st);
    if (shooter.stanceTicks !== undefined) shooter.stanceTicks = warm;
    if (shooter.aimTarget !== undefined) shooter.aimTarget = targetRecord(target);
    faceToward(shooter, target.x, target.y);
    return st;
  }

  function fireShot(map, shooter, st) {
    var t = liveTarget(st.target);
    if (!t) return false;
    faceToward(shooter, t.x, t.y);
    /* If they broke the line while the shooter was aiming, the round is
       spent into whatever is now in the way. */
    var clear = Combat.lineOfSight(map, shooter.x, shooter.y, t.x, t.y);
    Combat.spawnProjectile(map, shooter, t, st.w, {
      hitChance: clear ? Combat.rangedHitChance(shooter, t, st.w, { map: map }) : 0,
      source: st.source
    });
    shooter.lastAttackTick = now();
    if (isPawn(shooter)) gainSkill(shooter, 'shooting', 22);
    return true;
  }

  function meleeSwing(map, attacker, target) {
    var m = meleeProfile(attacker);
    faceToward(attacker, target.x, target.y);
    attacker.lastAttackTick = now();
    if (isPawn(attacker)) gainSkill(attacker, 'melee', 30);

    if (U.chance(Combat.meleeHitChance(attacker, target))) {
      var dmg = Math.max(1, Math.round(
        m.damage * U.randRange(0.85, 1.2) * traitFactor(attacker, 'meleeDamage')));
      Combat.damage(map, target, {
        amount: dmg, type: m.type, armorPen: m.pen,
        instigator: attacker, source: m.source
      });
    }

    /* A practised fighter recovers faster between swings. */
    var level = skillLevel(attacker, 'melee');
    var cd = Math.max(12, Math.round(m.cooldown * U.clamp(1.3 - 0.03 * level, 0.6, 1.3)));
    _stances.set(attacker.id, {
      id: attacker.id, owner: attacker, map: map, ranged: false, mode: 'cooldown',
      ticksLeft: cd, total: cd, cooldown: cd, shotsLeft: 0,
      burstTicks: 1, w: null, source: m.source, target: target
    });
    if (attacker.stanceTicks !== undefined) attacker.stanceTicks = cd;
    return true;
  }

  function advanceStance(st) {
    var e = st.owner, map = st.map;
    if (st.mode !== 'cooldown') {
      var t = liveTarget(st.target);
      if (!t) {
        /* Dropped while being aimed at: the shooter simply lowers the gun.
           Dropped mid-burst: the recovery is already owed and gets paid. */
        if (st.mode === 'warmup') { Combat.clearStance(e); return false; }
        st.mode = 'cooldown';
        st.ticksLeft = st.cooldown;
        st.target = null;
        if (e.aimTarget !== undefined) e.aimTarget = null;
        if (e.stanceTicks !== undefined) e.stanceTicks = st.ticksLeft;
        return true;
      }
      if (e.aimTarget !== undefined) e.aimTarget = targetRecord(t);
      faceToward(e, t.x, t.y);
    }

    st.ticksLeft--;
    if (e.stanceTicks !== undefined) e.stanceTicks = st.ticksLeft;
    if (st.ticksLeft > 0) return true;

    if (st.mode === 'cooldown') { Combat.clearStance(e); return true; }

    fireShot(map, e, st);
    st.shotsLeft--;
    if (st.shotsLeft > 0) {
      st.mode = 'burst';
      st.ticksLeft = st.burstTicks;
    } else {
      st.mode = 'cooldown';
      st.ticksLeft = st.cooldown;
      if (e.aimTarget !== undefined) e.aimTarget = null;
    }
    if (e.stanceTicks !== undefined) e.stanceTicks = st.ticksLeft;
    return true;
  }

  /* Whether this pawn is physically able to attack that at all. Hostility
     is the caller's question: a drafted colonist may be ordered to shoot
     a wall, and usually is. */
  Combat.canAttack = function (pawn, target) {
    if (!pawn || !target || pawn === target) return false;
    if (pawn.dead || pawn.downed) return false;
    if (!pawn.map) return false;
    if (isPawn(target)) {
      if (target.dead) return false;
      if (target.map && target.map !== pawn.map) return false;
    } else if (target.spawned === false || (target.hp !== undefined && target.hp <= 0)) {
      return false;
    }
    if (capacity(pawn, 'consciousness') < 0.1) return false;
    return true;
  };

  /* One tick of attacking. Returns true while the pawn is busy with the
     attack - aiming, firing or recovering - so a job driver can simply
     call it every tick and read the answer as "still working on it". */
  Combat.tryAttack = function (pawn, target) {
    if (!pawn || pawn.dead || !pawn.map) return false;
    var map = pawn.map;
    var st = _stances.get(pawn.id);
    if (st) {
      /* Already aiming, firing or recovering. Re-aim while still winding
         up, so a pawn does not shoot at a corpse when a better target
         walked in front of it; once the burst has started it belongs to
         the target it started on. */
      var better = liveTarget(target);
      if (st.mode === 'warmup' && better && better !== st.target) st.target = better;
      return true;
    }
    if (!Combat.canAttack(pawn, target)) return false;

    var d = U.dist(pawn.x, pawn.y, target.x, target.y);
    var w = rangedWeapon(pawn);
    if (w && d <= w.range && d >= (w.minRange || 0) &&
        Combat.lineOfSight(map, pawn.x, pawn.y, target.x, target.y)) {
      beginRanged(map, pawn, target, w, equippedDef(pawn));
      return true;
    }
    if (d <= 1.45) return meleeSwing(map, pawn, target);
    return false;
  };

  /* ------------------------------------------------------------------
     Target selection
     ------------------------------------------------------------------ */

  function threatOf(p) {
    var v = 10;
    var w = weaponBlock(equippedDef(p));
    if (w && w.ranged) v += w.damage * Math.max(1, w.burstCount || 1) * 1.6;
    else v += meleeProfile(p).damage * 1.2;
    if (p.isAnimal && p.kind && p.kind.combatPower) v += p.kind.combatPower * 0.2;
    v *= U.lerp(0.35, 1, capacity(p, 'consciousness'));
    return v;
  }

  /* Wildlife that is minding its own business is not a target, whatever
     the faction table says: a raid does not stop to fight a hare. */
  function harmlessAnimal(q) {
    return q.isAnimal && q.faction === 'wild' && !isManhunter(q) && !isBerserk(q) && !aggroTargetId(q);
  }

  /* Distance counts more than danger: a fighter takes the threat in front
     of them rather than walking past it to reach a scarier one. The square
     term is what makes that hold at range without ignoring a rifleman for
     an unarmed colonist two tiles nearer. */
  function distanceWeight(d) { return 6 + d + d * d * 0.25; }

  function defaultSearchRange(pawn) {
    var w = rangedWeapon(pawn);
    if (w) return Math.max(w.range, 12);
    return isPawn(pawn) && pawn.isAnimal ? 18 : 28;
  }

  Combat.findTarget = function (pawn, opts) {
    opts = opts || {};
    var map = opts.map || pawn.map;
    if (!map) return null;
    var maxDist = opts.maxDist !== undefined ? opts.maxDist : defaultSearchRange(pawn);
    var needLoS = opts.los !== false;
    var best = null, bestScore = 0, i, d, score;

    var list = map.pawns || [];
    for (i = 0; i < list.length; i++) {
      var q = list[i];
      if (q === pawn || q.dead) continue;
      if (!Combat.hostile(pawn, q)) continue;
      if (!opts.includeAnimals && harmlessAnimal(q)) continue;
      if (q.downed && !opts.includeDowned) continue;
      d = U.dist(pawn.x, pawn.y, q.x, q.y);
      if (d > maxDist) continue;
      if (needLoS && !Combat.lineOfSight(map, pawn.x, pawn.y, q.x, q.y)) continue;
      if (opts.reachable && !reachable(map, pawn, q.x, q.y)) continue;
      score = threatOf(q) / distanceWeight(d);
      if (q.downed) score *= 0.12;
      if (opts.preferHumans && q.isHuman) score *= 1.5;
      if (score > bestScore) { bestScore = score; best = q; }
    }

    if (opts.includeBuildings) {
      /* Held from before the structure scan: the penalty below is meant to
         say "a live pawn beats the wall behind it", and reading `best` as
         the loop fills it would instead penalise every structure after the
         first one found and make the answer depend on scan order. */
      var foundPawn = best !== null;
      for (var s = 0; s < STRUCTURE_TARGETS.length; s++) {
        var defId = STRUCTURE_TARGETS[s];
        var things = map.byDef ? map.byDef(defId) : null;
        if (!things) continue;
        for (i = 0; i < things.length; i++) {
          var b = things[i];
          if (!b.spawned || !Combat.hostile(pawn, b)) continue;
          if (U.manhattan(pawn.x, pawn.y, b.x, b.y) > maxDist * 1.5) continue;
          d = U.dist(pawn.x, pawn.y, b.x, b.y);
          if (d > maxDist) continue;
          if (needLoS && !Combat.lineOfSight(map, pawn.x, pawn.y, b.x, b.y)) continue;
          score = 8 * (STRUCTURE_VALUE[defId] || 1) / distanceWeight(d);
          if (foundPawn) score *= 0.5;
          if (score > bestScore) { bestScore = score; best = b; }
        }
      }
    }
    return best;
  };

  function reachable(map, pawn, x, y) {
    var P = PathLib();
    if (P && P.reachable) return P.reachable(map, pawn.x, pawn.y, x, y, { pawn: pawn });
    var R = typeof root.Regions !== 'undefined' ? root.Regions : null;
    if (R && R.sameArea) return R.sameArea(map, pawn.x, pawn.y, x, y);
    return true;
  }

  /* The cell to run to when running is the only sensible plan: away from
     the threat, and out of the fight entirely if an edge is close. */
  Combat.fleeCell = function (map, pawn, threat) {
    if (!map) return null;
    var tx = threat ? threat.x : pawn.x, ty = threat ? threat.y : pawn.y;
    var dx = pawn.x - tx, dy = pawn.y - ty;
    var len = Math.sqrt(dx * dx + dy * dy);
    /* Panic with nothing to run from - think.js hands the panicFlee break
       a bare flee job - still has to pick a heading, and every such pawn
       bolting due east looks like a bug because it is one. */
    if (len < 0.001) {
      var a0 = U.rand() * TAU;
      dx = Math.cos(a0); dy = Math.sin(a0); len = 1;
    }
    dx /= len; dy /= len;

    var best = null, bestScore = -Infinity;
    for (var step = 14; step >= 5; step -= 3) {
      for (var a = -1; a <= 1; a++) {
        var ang = a * 0.6;
        var ox = Math.round(pawn.x + (dx * Math.cos(ang) - dy * Math.sin(ang)) * step);
        var oy = Math.round(pawn.y + (dx * Math.sin(ang) + dy * Math.cos(ang)) * step);
        ox = U.clamp(ox, 1, map.w - 2);
        oy = U.clamp(oy, 1, map.h - 2);
        if (!map.passable(ox, oy)) continue;
        if (!reachable(map, pawn, ox, oy)) continue;
        var edge = Math.min(ox, oy, map.w - 1 - ox, map.h - 1 - oy);
        var score = U.dist(ox, oy, tx, ty) - edge * 0.35;
        if (score > bestScore) { bestScore = score; best = { x: ox, y: oy }; }
      }
      if (best) return best;
    }
    return best;
  };

  /* ------------------------------------------------------------------
     Turrets
     ------------------------------------------------------------------ */

  /* map.js keeps a list of things that want a call every tick and invites
     combat.js to hand a turret its firing routine. Installing it here means
     the sweep in Combat.tick only ever has to discover a newly built one,
     and the tick guard below makes the two paths safe together. */
  function turretTickFn(thing, map) { Combat.tickTurret(map, thing); }

  Combat.tickTurret = function (map, thing) {
    if (!map || !thing || !thing.spawned || !thing.def) return;
    var b = thing.def.building;
    if (!b || !b.isTurret) return;
    if (thing.tickFn !== turretTickFn && map.setTickFn) map.setTickFn(thing, turretTickFn);
    /* _tick, not Game.tick: this is only here to stop the two paths that
       reach a turret - map's tick list and the sweep in Combat.tick - from
       firing it twice in one tick, and combat has to be able to answer
       that on its own clock. */
    if (thing._turretTick === _tick) return;
    thing._turretTick = _tick;

    var st = _stances.get(thing.id);
    if (b.powerConsumed > 0 && thing.powered === false) {
      if (st) Combat.clearStance(thing);
      return;
    }
    if (st) return;

    /* Re-acquiring every tick would be the most expensive thing in the
       game; twice a second is faster than anything can cross a tile. */
    if ((_tick + thing.id) % 30 !== 0) return;
    var w = Combat.turretWeapon(thing.def);
    if (!w) return;
    var target = Combat.findTarget(thing, {
      map: map, maxDist: b.turretRange || w.range, los: true, preferHumans: true
    });
    if (target) beginRanged(map, thing, target, w, Defs.maybe('thing', b.turretWeapon));
  };

  /* ------------------------------------------------------------------
     Traps

     A trap is a weapon that fires once, at touch range, into whoever
     stepped on it, and accuracy.touch is the spring chance. The roll
     happens once per pawn who walks in, not once per tick they spend
     crossing, or a raider would never survive a doorway.
     ------------------------------------------------------------------ */

  /* The colony knows where it put its own traps and steps around them.
     Almost always. */
  var TRAP_FRIENDLY_SPRING = 0.007;

  function trapTickFn(thing, map) { Combat.tickTrap(map, thing); }

  Combat.tickTrap = function (map, thing) {
    if (!map || !thing || !thing.spawned || !thing.def) return;
    var b = thing.def.building;
    if (!b || !b.isTrap) return;
    if (thing.tickFn !== trapTickFn && map.setTickFn) map.setTickFn(thing, trapTickFn);

    var here = map.pawnsAt(thing.x, thing.y);
    var victim = null;
    for (var i = 0; i < here.length; i++) {
      if (!here[i].dead && !here[i].downed) { victim = here[i]; break; }
    }
    if (!victim) { thing._steppedOn = 0; return; }
    if (thing._steppedOn === victim.id) return;
    thing._steppedOn = victim.id;

    var w = weaponBlock(thing.def);
    if (!w) return;
    var chance = Combat.hostile(thing, victim)
      ? (w.accuracy ? w.accuracy.touch : 0.8)
      : TRAP_FRIENDLY_SPRING;
    /* A heavier body puts more weight on the trigger; a hare crosses it. */
    var size = (victim.kind && victim.kind.bodySize) || 1;
    if (!U.chance(chance * U.clamp(size, 0.25, 1.6))) return;

    Combat.damage(map, victim, {
      amount: Math.max(1, Math.round(w.damage * U.randRange(0.8, 1.25))),
      type: w.damageType, armorPen: w.armorPen, instigator: null, source: thing.def
    });
    var G = Game();
    if (G && G.msg) {
      G.msg(U.cap(nameOf(victim)) + ' sprang a ' + thing.def.label + '.',
        { type: victim.faction === 'player' ? 'threat' : 'good', x: thing.x, y: thing.y });
    }
    map.destroyThing(thing, 'sprung');
  };

  function nameOf(pawn) {
    if (pawn.name && (pawn.name.nick || pawn.name.first)) return pawn.name.nick || pawn.name.first;
    return (pawn.kind && pawn.kind.label) || 'someone';
  }

  /* ------------------------------------------------------------------
     The tick
     ------------------------------------------------------------------ */

  Combat.tick = function (map) {
    if (!map) return;
    var list = Combat.projectiles, i, w = 0, p;
    for (i = 0; i < list.length; i++) {
      p = list[i];
      /* A projectile from a game that has been restarted belongs to a map
         nobody is ticking any more; drop it rather than fly it forever. */
      if (p.map !== map) continue;
      if (!p.dead) advanceProjectile(map, p);
      if (!p.dead) list[w++] = p;
    }
    list.length = w;

    var ex = Combat.explosions;
    w = 0;
    for (i = 0; i < ex.length; i++) {
      var e = ex[i];
      if (e.map !== map) continue;
      if (--e.ticksLeft > 0) ex[w++] = e;
    }
    ex.length = w;

    /* Both sweeps run backwards: a turret cooking off can destroy the next
       one along, and map.byDef is the live list it is removed from. */
    var turrets = map.byDef ? map.byDef('turret') : null;
    if (turrets) for (i = turrets.length - 1; i >= 0; i--) Combat.tickTurret(map, turrets[i]);
    var traps = map.byDef ? map.byDef('spikeTrap') : null;
    if (traps) for (i = traps.length - 1; i >= 0; i--) Combat.tickTrap(map, traps[i]);

    if (_stances.size) _stances.forEach(tickStance, map);

    /* Bumped last, not first. map.js reaches a turret through its own tick
       list before this runs, so the value the two paths compare has to be
       the one that was standing when map.tick went past. */
    _tick++;
  };

  /* One tick of every warmup, burst and cooldown in the world. A stance
     whose owner has died, gone down or left the map is dropped: an aim is
     only worth keeping while there is somebody behind it. A pawn who walks
     off with a caravan leaves the map without dying, and a stance nothing
     drops keeps firing rounds out of an empty tile. */
  function tickStance(st, id, all) {
    /* `this` is the map Combat.tick was handed; Map.forEach passes it. */
    var e = st.owner;
    if (st.map !== this || !e || e.dead ||
        (isPawn(e) ? (e.downed || e.map !== st.map) : e.spawned === false)) {
      all.delete(id);
      if (e && e.stanceTicks !== undefined) { e.stanceTicks = 0; e.aimTarget = null; }
      return;
    }
    advanceStance(st);
  }

  Combat.reset = function () {
    Combat.projectiles.length = 0;
    Combat.explosions.length = 0;
    _stances.clear();
    _chain = 0;
  };

  /* ============================================================
     JOBS

     Behaviour lives next to the system it belongs to; workgivers.js and
     think.js decide who does these and when.
     ============================================================ */

  var Jobs = root.Jobs, Toils = root.Toils, T = root.T, Path = root.Path;
  var PE = (Path && Path.PE) || { ON_CELL: 0, TOUCH: 1, ADJACENT: 2, INTERACTION: 3 };

  function targetOf(job, which, map) {
    var t = job['target' + which];
    return t && T ? T.resolve(t, map) : null;
  }

  /* Chasing is the one thing a linear toil list cannot express: the quarry
     moves, so the path has to be thrown away and rebuilt. pawn.js owns
     movement, so ask it first and otherwise write the path fields the pawn
     model documents and its own mover consumes. */
  function chase(pawn, x, y) {
    var walking = pawn.moving ? pawn.moving() : !!(pawn.path && pawn.pathIdx < pawn.path.length);
    if (walking && pawn.destX === x && pawn.destY === y) return true;
    var P = PathLib();
    /* TOUCH, so the route ends beside the quarry rather than trying to
       finish on the tile it is standing on. */
    var pe = P && P.PE ? P.PE.TOUCH : 1;
    if (typeof pawn.startPath === 'function') return pawn.startPath(x, y, pe) !== false;
    if (!P) return false;
    var path = P.find(pawn.map, pawn.x, pawn.y, x, y,
      { pawn: pawn, pe: pe, maxCells: 1600 });
    if (!path || !path.length) return false;
    pawn.path = path;
    pawn.pathIdx = 0;
    pawn.moveProgress = 0;
    pawn.destX = x;
    pawn.destY = y;
    pawn.pathDest = pawn.map.idx(x, y);
    return true;
  }

  /* pawn.js owns the move state, and its own stopPath clears the four
     fields a half-cleared path leaves lying around - moveProgress, the
     destination index and the interpolated draw position. */
  function stopChasing(pawn) {
    if (!pawn.path) return;
    if (typeof pawn.stopPath === 'function') { pawn.stopPath(); return; }
    pawn.path = null;
    pawn.pathIdx = 0;
    pawn.moveProgress = 0;
    pawn.pathDest = -1;
  }

  /* A downed enemy is out of the fight, and a colonist does not execute
     one unasked. A predator standing over its dinner has no such scruple,
     and neither has anyone in a berserk rage. */
  function finishesTheDowned(pawn, job) {
    return !!(job.playerForced || pawn.isAnimal || isBerserk(pawn));
  }

  function attackReport(verb) {
    return function (job, pawn) {
      var t = targetOf(job, 'A', pawn && pawn.map);
      var name = t && t.name ? (t.name.nick || t.name.first)
        : (t && t.def ? t.def.label : 'something');
      return verb + ' ' + name;
    };
  }

  if (Jobs && Jobs.register) {

    /* --- attackMelee ---
       Walk up to it and keep swinging until one of you stops moving. The
       approach and the swing share one toil because the target does not
       stand still while being approached. */
    Jobs.register('attackMelee', {
      label: 'attack',
      suspendable: false,
      alwaysShow: true,
      reportString: attackReport('Attacking'),
      toils: function () {
        return [
          Toils.goto('A', { pe: PE.TOUCH, failIfGone: true }),
          Toils.custom({
            name: 'swing',
            tick: function (pawn, job) {
              var map = pawn.map;
              var target = targetOf(job, 'A', map);
              if (!target || (isPawn(target) && target.dead) || target.spawned === false) return 'done';
              if (isPawn(target) && target.downed && !finishesTheDowned(pawn, job)) return 'done';
              var d = U.dist(pawn.x, pawn.y, target.x, target.y);
              if (d > 1.45) {
                if (!chase(pawn, target.x, target.y)) return 'fail';
                return 'stay';
              }
              stopChasing(pawn);
              Combat.tryAttack(pawn, target);
              return 'stay';
            },
            end: function (pawn) { Combat.clearStance(pawn); }
          })
        ];
      }
    });

    /* --- attackStatic ---
       Hold this ground and shoot. Drafted colonists get this from the
       player, raiders give it to themselves once they are behind cover. */
    Jobs.register('attackStatic', {
      label: 'attack',
      suspendable: false,
      alwaysShow: true,
      reportString: attackReport('Shooting'),
      toils: function () {
        return [
          Toils.custom({
            name: 'shoot',
            tick: function (pawn, job) {
              var map = pawn.map;
              var target = targetOf(job, 'A', map);
              if (!target || (isPawn(target) && target.dead) || target.spawned === false) return 'done';
              if (isPawn(target) && target.downed && !finishesTheDowned(pawn, job)) return 'done';

              /* Finish the burst that is already in the air before
                 admitting the shot has gone bad. */
              if (Combat.stanceOf(pawn)) { Combat.tryAttack(pawn, target); return 'stay'; }

              var w = rangedWeapon(pawn);
              var d = U.dist(pawn.x, pawn.y, target.x, target.y);
              if (!w && d > 1.45) return 'fail';
              if (w && d > w.range) return 'fail';
              if (!Combat.lineOfSight(map, pawn.x, pawn.y, target.x, target.y)) return 'fail';
              if (!Combat.tryAttack(pawn, target)) return 'fail';
              return 'stay';
            },
            end: function (pawn) { Combat.clearStance(pawn); }
          })
        ];
      }
    });

    /* --- flee ---
       targetA is where to run, targetB is what from. Callers may give
       either; with only a threat, the cell is worked out here. */
    Jobs.register('flee', {
      label: 'flee',
      suspendable: false,
      alwaysShow: true,
      reportString: 'Fleeing',
      toils: function () {
        return [
          Toils.custom({
            name: 'pickFleeCell',
            tick: function (pawn, job) {
              var map = pawn.map;
              var a = job.targetA;
              /* A cell in targetA is somewhere to run to. Anything else in
                 it is the thing being run from: think.js builds its flee
                 job as makeJob('flee', target('pawn', from)), and taking
                 that at face value would send the pawn at the raider. */
              if (a && a.k === 'c') return 'next';
              var threat = a ? (T ? T.resolve(a, map) : null) : targetOf(job, 'B', map);
              var cell = Combat.fleeCell(map, pawn, threat);
              if (!cell) return 'fail';
              job.targetA = T ? T.cell(cell.x, cell.y) : { k: 'c', x: cell.x, y: cell.y };
              if (threat && !job.targetB) job.targetB = a;
              return 'next';
            }
          }),
          Toils.goto('A', { pe: PE.ON_CELL }),
          /* A breather at the far end, so a panicking pawn does not turn
             round the instant it arrives and walk back into the fight. */
          Toils.wait(90)
        ];
      }
    });
  }

  /* The range bands the accuracy curve is quoted at, for the UI. */
  Combat.BANDS = { touch: BAND_TOUCH, short: BAND_SHORT, medium: BAND_MEDIUM, long: BAND_LONG };

  root.Combat = Combat;
})(this);
