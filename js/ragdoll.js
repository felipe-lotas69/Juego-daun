/* ============================================================
   ragdoll.js - limbs that have their own opinion

   The collision body stays a plain box, because that is what makes the
   movement predictable. Everything you actually see hanging off it -
   head, arms, legs - is a little verlet rig pinned at the chest and
   hips. The pins are dragged around by the box, and the free ends lag,
   swing and overshoot, which is where the flailing comes from.
   ============================================================ */
(function (root) {
  'use strict';

  var CHEST = 0, HIP = 1, HEAD = 2,
      ELBOW_A = 3, HAND_A = 4,     /* the arm holding the gun */
      ELBOW_B = 5, HAND_B = 6,     /* the free arm */
      KNEE_A = 7, FOOT_A = 8,
      KNEE_B = 9, FOOT_B = 10;
  var COUNT = 11;

  /* joint-to-joint lengths, in world units */
  var L_SPINE = 15, L_NECK = 9, L_ARM = 9, L_LEG = 9;

  var LINKS = [
    [CHEST, HIP, L_SPINE], [CHEST, HEAD, L_NECK],
    [CHEST, ELBOW_A, L_ARM], [ELBOW_A, HAND_A, L_ARM],
    [CHEST, ELBOW_B, L_ARM], [ELBOW_B, HAND_B, L_ARM],
    [HIP, KNEE_A, L_LEG], [KNEE_A, FOOT_A, L_LEG],
    [HIP, KNEE_B, L_LEG], [KNEE_B, FOOT_B, L_LEG]
  ];

  function Ragdoll() {
    this.p = [];
    for (var i = 0; i < COUNT; i++) this.p.push({ x: 0, y: 0, px: 0, py: 0 });
    this.ready = false;
    this.step = 0;
  }

  /* where a body-local point lands in the world, given the lean */
  function local(out, cx, feet, sin, cos, lx, ly) {
    out.x = cx + lx * cos - ly * sin;
    out.y = feet + lx * sin + ly * cos;
    return out;
  }

  var tmp = { x: 0, y: 0 };

  Ragdoll.prototype.place = function (owner) {
    var cx = owner.x + owner.w / 2, feet = owner.y + owner.h;
    var sin = Math.sin(owner.angle), cos = Math.cos(owner.angle);
    var rest = [
      [0, -33], [0, -18], [0, -42],
      [6, -27], [12, -21],
      [-6, -27], [-12, -21],
      [5, -9], [5, 0],
      [-5, -9], [-5, 0]
    ];
    for (var i = 0; i < COUNT; i++) {
      local(tmp, cx, feet, sin, cos, rest[i][0], rest[i][1]);
      this.p[i].x = this.p[i].px = tmp.x;
      this.p[i].y = this.p[i].py = tmp.y;
    }
    this.ready = true;
  };

  /* pull a point toward a target, springily */
  function pull(pt, tx, ty, k) {
    pt.x += (tx - pt.x) * k;
    pt.y += (ty - pt.y) * k;
  }

  Ragdoll.prototype.update = function (dt, owner, aimAngle, world) {
    if (!this.ready) { this.place(owner); return; }
    if (dt <= 0) return;

    var P = this.p;
    var cx = owner.x + owner.w / 2, feet = owner.y + owner.h;
    var sin = Math.sin(owner.angle), cos = Math.cos(owner.angle);
    var grounded = owner.grounded;
    var loose = owner.stumble > 0 ? 1 : 0;

    /* --- the two pinned joints are carried by the box --- */
    local(tmp, cx, feet, sin, cos, 0, -33); P[CHEST].x = tmp.x; P[CHEST].y = tmp.y;
    local(tmp, cx, feet, sin, cos, 0, -18); P[HIP].x = tmp.x; P[HIP].y = tmp.y;

    /* --- everything else integrates --- */
    var drag = Math.exp(-(loose ? 3.4 : 5.6) * dt);
    var g = 1850 * dt * dt;
    for (var i = 2; i < COUNT; i++) {
      var pt = P[i];
      var vx = (pt.x - pt.px) * drag;
      var vy = (pt.y - pt.py) * drag;
      pt.px = pt.x; pt.py = pt.y;
      pt.x += vx;
      pt.y += vy + g;
    }

    /* --- where the limbs would like to be --- */
    var strong = loose ? 0.08 : 0.28;

    /* head sits above the chest but lags behind a turn */
    local(tmp, cx, feet, sin, cos, 0, -42);
    pull(P[HEAD], tmp.x, tmp.y, loose ? 0.09 : 0.24);

    /* the gun arm reaches along the aim line - firm, because you are
       holding something, but still soft enough to whip around */
    var ax = Math.cos(aimAngle), ay = Math.sin(aimAngle);
    pull(P[HAND_A], P[CHEST].x + ax * 18, P[CHEST].y + ay * 18, loose ? 0.16 : 0.46);
    pull(P[ELBOW_A], P[CHEST].x + ax * 9, P[CHEST].y + ay * 9, loose ? 0.06 : 0.2);

    /* the free arm just gets thrown around by whatever the body does */
    local(tmp, cx, feet, sin, cos, -owner.facing * 9, -24);
    pull(P[HAND_B], tmp.x, tmp.y, loose ? 0.02 : 0.06);

    /* legs: planted and striding on the ground, trailing in the air */
    this.step += dt * (grounded ? 10 : 3);
    var stride = grounded ? Math.sin(this.step + owner.stepPhase) * 7 : 0;
    var footK = grounded ? (loose ? 0.14 : 0.40) : 0.045;
    local(tmp, cx, feet, sin, cos, 5 + stride, grounded ? 0 : 4);
    pull(P[FOOT_A], tmp.x, tmp.y, footK);
    local(tmp, cx, feet, sin, cos, -5 - stride, grounded ? 0 : 4);
    pull(P[FOOT_B], tmp.x, tmp.y, footK);

    /* knees bend outward a little so the legs do not read as sticks */
    local(tmp, cx, feet, sin, cos, 5 + stride * 0.5, -9);
    pull(P[KNEE_A], tmp.x, tmp.y, strong * 0.5);
    local(tmp, cx, feet, sin, cos, -5 - stride * 0.5, -9);
    pull(P[KNEE_B], tmp.x, tmp.y, strong * 0.5);

    /* --- hold the skeleton together --- */
    for (var pass = 0; pass < 3; pass++) {
      for (var k = 0; k < LINKS.length; k++) {
        var a = P[LINKS[k][0]], b = P[LINKS[k][1]], len = LINKS[k][2];
        var dx = b.x - a.x, dy = b.y - a.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        var diff = (d - len) / d * 0.5;
        var ox = dx * diff, oy = dy * diff;
        /* the chest and hips are pinned, so they take none of the correction */
        var aFixed = LINKS[k][0] === CHEST || LINKS[k][0] === HIP;
        if (aFixed) { b.x -= ox * 2; b.y -= oy * 2; }
        else { a.x += ox; a.y += oy; b.x -= ox; b.y -= oy; }
      }
    }

    /* feet do not go through the floor they are standing on */
    if (grounded && world) {
      for (var f = 0; f < 2; f++) {
        var ft = P[f ? FOOT_B : FOOT_A];
        if (ft.y > feet) { ft.y = feet; ft.py = feet; }
      }
    }
  };

  /* ---------------------------------------------------------- drawing
     The body parts are sprites rather than rectangles. At this size a flat
     block of colour has nothing in it to read - the reference art carries a
     cap with a brim, an eye, a collar, buttons and a belt in about the same
     number of pixels, and that detail is most of what separates pixel art
     from a coloured box. Tones are derived from the palette, so every
     character - player, enemy, hurt-flashed - gets the same shading.

     Facing right is the authored direction; the stamp mirrors for the other. */

  /* cap crown / cap band and brim / skin / skin in shadow / eye */
  var SPR_HEAD = [
    '.ccccc.',
    'bbbbbbb',
    '.tssss.',
    '.tsses.',
    '.tssss.',
    '..tss..'
  ];

  /* back edge in shadow / suit / lit front edge / tie / button / belt */
  var SPR_TORSO = [
    'dlllll',
    'duuTul',
    'duuTua',
    'duuTul',
    'duuTua',
    'duuuul',
    'duuuul',
    'dkkkkk',
    'duuuul'
  ];

  var SPR_SHOE = ['nnnn', 'mmmm'];
  var SPR_HAND = ['ss', 'ts'];

  /* A gun is the one sprite whose size depends on what it is, so it gets
     built from the weapon's barrel length and kept. */
  var gunCache = {};
  function gunSprite(key, def) {
    var hit = gunCache[key];
    if (hit) return hit;
    var n = Math.max(2, Math.round(def.barrel / Pixel.SIZE));
    var barrel = new Array(n + 1).join('B');
    var tip = def.explosive || def.teleport ? 'T' : 'B';
    var sprite = [
      '.' + new Array(n + 1).join('H'),
      'G' + barrel.slice(0, n - 1) + tip,
      'GG' + new Array(n).join('.')
    ];
    gunCache[key] = sprite;
    return sprite;
  }

  Ragdoll.prototype.draw = function (ctx, owner, palette, skin, weapon, muzzleFlash) {
    var P = this.p, Px = Pixel.SIZE;
    var suit = palette.suit, suit2 = palette.suit2;
    var flip = owner.facing !== 1;

    var hat = palette.hat || Pixel.tint(suit, -0.5);
    var headMap = {
      c: hat,
      b: Pixel.tint(hat, -0.35),
      s: skin,
      t: Pixel.tint(skin, -0.22),
      e: '#20232f'
    };
    var torsoMap = {
      d: suit2,
      u: suit,
      l: Pixel.tint(suit, 0.18),
      T: palette.tie,
      a: palette.mark,
      k: Pixel.tint(suit, -0.45)
    };
    var shoeMap = { n: '#20232f', m: '#4a4f60' };
    var handMap = { s: skin, t: Pixel.tint(skin, -0.22) };

    /* back arm and back leg first, so the body reads in front of them */
    Pixel.line(ctx, P[CHEST].x, P[CHEST].y, P[ELBOW_B].x, P[ELBOW_B].y, Px * 2, suit2);
    Pixel.line(ctx, P[ELBOW_B].x, P[ELBOW_B].y, P[HAND_B].x, P[HAND_B].y, Px * 2, suit2);
    Pixel.stamp(ctx, SPR_HAND, handMap, P[HAND_B].x, P[HAND_B].y, 0, flip);

    Pixel.line(ctx, P[HIP].x, P[HIP].y, P[KNEE_B].x, P[KNEE_B].y, Px * 2, suit2);
    Pixel.line(ctx, P[KNEE_B].x, P[KNEE_B].y, P[FOOT_B].x, P[FOOT_B].y, Px * 2, suit2);
    Pixel.stamp(ctx, SPR_SHOE, shoeMap, P[FOOT_B].x, P[FOOT_B].y, 0, flip);

    /* front leg */
    Pixel.line(ctx, P[HIP].x, P[HIP].y, P[KNEE_A].x, P[KNEE_A].y, Px * 2, suit);
    Pixel.line(ctx, P[KNEE_A].x, P[KNEE_A].y, P[FOOT_A].x, P[FOOT_A].y, Px * 2, suit);
    Pixel.stamp(ctx, SPR_SHOE, shoeMap, P[FOOT_A].x, P[FOOT_A].y, 0, flip);

    /* torso follows the spine rather than the box */
    var mx = (P[CHEST].x + P[HIP].x) / 2, my = (P[CHEST].y + P[HIP].y) / 2;
    var spine = Math.atan2(P[CHEST].y - P[HIP].y, P[CHEST].x - P[HIP].x) + Math.PI / 2;
    Pixel.stamp(ctx, SPR_TORSO, torsoMap, mx, my, spine, flip);

    /* head, tilted along the neck */
    var neck = Math.atan2(P[HEAD].y - P[CHEST].y, P[HEAD].x - P[CHEST].x) + Math.PI / 2;
    Pixel.stamp(ctx, SPR_HEAD, headMap, P[HEAD].x, P[HEAD].y, neck, flip);

    /* front arm, and whatever it is holding */
    /* sleeve to the wrist, then the hand - a forearm in bare skin reads as
       a rolled-up shirt, which is not what anyone here is wearing */
    Pixel.line(ctx, P[CHEST].x, P[CHEST].y, P[ELBOW_A].x, P[ELBOW_A].y, Px * 2, suit);
    Pixel.line(ctx, P[ELBOW_A].x, P[ELBOW_A].y, P[HAND_A].x, P[HAND_A].y, Px * 2, suit);
    Pixel.stamp(ctx, SPR_HAND, handMap, P[HAND_A].x, P[HAND_A].y, 0, flip);

    if (weapon) {
      var def = WEAPONS[weapon.key];
      var sprite = gunSprite(weapon.key, def);
      var hold = Math.atan2(P[HAND_A].y - P[ELBOW_A].y, P[HAND_A].x - P[ELBOW_A].x);
      var cos = Math.cos(hold), sin = Math.sin(hold);
      /* the sprite is centred, but the gun hangs forward off the hand */
      var reach = (sprite[0].length / 2 - 1) * Px;
      var gx = P[HAND_A].x + cos * reach, gy = P[HAND_A].y + sin * reach;
      Pixel.stamp(ctx, sprite, {
        H: '#8d93a6', B: def.body, G: '#20232f',
        T: def.explosive ? '#ff6a4d' : '#49e0e8'
      }, gx, gy, hold, false);

      if (muzzleFlash > 0.25) {
        var mzx = P[HAND_A].x + cos * (reach + sprite[0].length / 2 * Px);
        var mzy = P[HAND_A].y + sin * (reach + sprite[0].length / 2 * Px);
        Pixel.rect(ctx, mzx - Px, mzy - Px * 2, Px * 3, Px * 3, '#fff3c4');
        Pixel.rect(ctx, mzx - Px * 2, mzy - Px, Px * 5, Px, '#ffd15c');
      }
    }
  };

  root.Ragdoll = Ragdoll;
})(typeof window !== 'undefined' ? window : globalThis);
