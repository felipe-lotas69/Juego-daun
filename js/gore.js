/* ============================================================
   gore.js - gibs, arterial spray, and blood that sticks

   Gibs are rigid bodies run through the same swept collision as
   everything else, so they tumble down stairs and pile in corners.
   Droplets paint a decal wherever they land.
   ============================================================ */
(function (root) {
  'use strict';

  var BLOOD = ['#8c0f1c', '#a3121f', '#c11627', '#6d0a15'];
  var BLOOD_BRIGHT = ['#d81f30', '#ff4d5e', '#b01322'];

  /* A gib is a little slab of person. */
  var GIB_PARTS = [
    { kind: 'head',  w: 15, h: 15, mass: 1.0 },
    { kind: 'torso', w: 18, h: 18, mass: 1.5 },
    { kind: 'arm',   w: 7,  h: 15, mass: 0.6 },
    { kind: 'arm',   w: 7,  h: 15, mass: 0.6 },
    { kind: 'leg',   w: 8,  h: 17, mass: 0.8 },
    { kind: 'leg',   w: 8,  h: 17, mass: 0.8 },
    { kind: 'chunk', w: 7,  h: 7,  mass: 0.4 },
    { kind: 'chunk', w: 6,  h: 6,  mass: 0.4 },
    { kind: 'chunk', w: 8,  h: 6,  mass: 0.4 }
  ];

  function Gore() {
    this.gibs = [];
    this.drops = [];
    this.decals = [];
    this.maxGibs = 90;
    this.maxDrops = 260;
    this.maxDecals = 420;
    this.level = 1;                 /* 0 off, 1 normal, 2 extra */
  }

  Gore.prototype.reset = function () {
    this.gibs.length = 0;
    this.drops.length = 0;
    this.decals.length = 0;
  };

  Gore.prototype.setLevel = function (n) {
    this.level = n;
    if (n === 0) this.reset();
  };

  /* ---------------------------------------------------------- droplets */
  Gore.prototype.drop = function (x, y, vx, vy, size) {
    if (this.level === 0) return;
    if (this.drops.length >= this.maxDrops) this.drops.shift();
    this.drops.push({
      x: x, y: y, vx: vx, vy: vy,
      size: size || U.rand(1.6, 3.6),
      life: U.rand(1.4, 3.2), age: 0,
      color: U.pick(BLOOD_BRIGHT),
      trail: 0
    });
  };

  /* A hit: a cone of blood away from the wound. */
  Gore.prototype.splash = function (x, y, n, dirX, dirY, power) {
    if (this.level === 0) return;
    n = Math.round(n * (this.level === 2 ? 1.8 : 1));
    var base = Math.atan2(dirY || -0.4, dirX || 0);
    for (var i = 0; i < n; i++) {
      var a = base + U.rand(-0.85, 0.85);
      var sp = U.rand(60, 260) * (power || 1);
      this.drop(x + U.rand(-3, 3), y + U.rand(-3, 3), Math.cos(a) * sp, Math.sin(a) * sp - 60);
    }
  };

  /* A body coming apart. */
  Gore.prototype.gib = function (x, y, vx, vy, palette, force) {
    if (this.level === 0) return;
    force = force || 1;
    var i, p, a, sp;
    var parts = this.level === 2 ? GIB_PARTS : GIB_PARTS.slice(0, 7);

    for (i = 0; i < parts.length; i++) {
      p = parts[i];
      if (this.gibs.length >= this.maxGibs) this.gibs.shift();
      a = U.rand(-Math.PI, 0);
      sp = U.rand(120, 420) * force / p.mass;
      this.gibs.push({
        x: x - p.w / 2 + U.rand(-6, 6),
        y: y - p.h / 2 + U.rand(-10, 10),
        w: p.w, h: p.h,
        vx: (vx || 0) * 0.45 + Math.cos(a) * sp,
        vy: (vy || 0) * 0.35 + Math.sin(a) * sp - 120,
        rot: U.rand(0, 6.28),
        spin: U.rand(-16, 16),
        kind: p.kind,
        palette: palette,
        bleed: U.rand(0.7, 2.2),
        rest: 0,
        grounded: false,
        life: 0,
        bouncy: true
      });
    }
    this.splash(x, y, 26 * force, 0, -1, 1.35);
  };

  /* ---------------------------------------------------------- decals */
  Gore.prototype.stain = function (x, y, size, onWall) {
    if (this.level === 0) return;
    if (this.decals.length >= this.maxDecals) this.decals.splice(0, 12);
    var blobs = [];
    var n = U.randInt(2, 5);
    for (var i = 0; i < n; i++) {
      blobs.push({
        dx: U.rand(-size, size) * 0.9,
        dy: U.rand(-size, size) * (onWall ? 1.2 : 0.45),
        r: U.rand(size * 0.35, size)
      });
    }
    this.decals.push({
      x: x, y: y, color: U.pick(BLOOD),
      blobs: blobs, alpha: U.rand(0.5, 0.85), run: onWall ? U.rand(6, 26) : 0
    });
  };

  /* A pool that spreads under a body. */
  Gore.prototype.pool = function (x, y, size) {
    if (this.level === 0) return;
    this.stain(x, y, size, false);
    for (var i = 0; i < 3; i++) this.stain(x + U.rand(-size, size), y + U.rand(-2, 2), size * 0.7, false);
  };

  /* ---------------------------------------------------------- update */
  Gore.prototype.update = function (dt, world) {
    var i, d, g;

    /* droplets: fly, then paint where they land */
    for (i = this.drops.length - 1; i >= 0; i--) {
      d = this.drops[i];
      d.age += dt;
      d.vy += 1500 * dt;
      d.vx *= U.damp(0.7, dt);
      var nx = d.x + d.vx * dt, ny = d.y + d.vy * dt;
      if (world.solidAt(nx, ny)) {
        var onWall = !world.solidAt(d.x, ny) && world.solidAt(nx, d.y);
        this.stain(nx, ny, d.size * U.rand(1.6, 3.4), onWall);
        this.drops.splice(i, 1);
        continue;
      }
      d.x = nx; d.y = ny;
      if (d.age > d.life || d.y > world.level.height + 200) this.drops.splice(i, 1);
    }

    /* gibs: proper rigid-ish bodies */
    for (i = this.gibs.length - 1; i >= 0; i--) {
      g = this.gibs[i];
      g.life += dt;
      g.bleed -= dt;

      if (g.rest > 2.5) continue;             /* settled, stop simulating */

      g.vy += GRAV * dt;
      if (g.vy > 1500) g.vy = 1500;
      g.vx *= U.damp(g.grounded ? 5.5 : 0.25, dt);

      var wasGround = g.grounded;
      var preVy = g.vy;
      moveAndCollide(g, g.vx * dt, g.vy * dt, world);

      if (g.grounded) {
        if (!wasGround && preVy > 220) {
          /* a wet slap, and it leaves a mark */
          g.vy = -preVy * 0.32;
          g.vx *= 0.6;
          g.spin *= 0.5;
          g.grounded = false;
          this.stain(g.x + g.w / 2, g.y + g.h, U.rand(4, 9), false);
          if (preVy > 700) this.splash(g.x + g.w / 2, g.y + g.h, 4, 0, -1, 0.5);
        } else {
          g.spin *= U.damp(7, dt);
          g.rest += dt;
          if (Math.abs(g.vx) < 6) g.vx = 0;
        }
      } else {
        g.rest = 0;
      }

      g.rot += g.spin * dt;

      /* airborne gibs trail blood */
      if (g.bleed > 0 && !g.grounded && Math.random() < dt * 22) {
        this.drop(g.x + g.w / 2, g.y + g.h / 2, g.vx * 0.2 + U.rand(-30, 30), g.vy * 0.2, U.rand(1.5, 3));
      }
      /* resting gibs seep */
      if (g.grounded && g.rest > 0.25 && g.rest < 2.5 && Math.random() < dt * 4) {
        this.stain(g.x + g.w / 2 + U.rand(-5, 5), g.y + g.h, U.rand(3, 7), false);
      }

      if (g.y > world.level.height + 300) this.gibs.splice(i, 1);
    }
  };

  /* ---------------------------------------------------------- draw */
  Gore.prototype.drawDecals = function (ctx) {
    var L = this.decals;
    for (var i = 0; i < L.length; i++) {
      var d = L[i];
      ctx.globalAlpha = Pixel.qa(d.alpha);
      ctx.fillStyle = d.color;
      for (var j = 0; j < d.blobs.length; j++) {
        var b = d.blobs[j];
        Pixel.rect(ctx, d.x + b.dx - b.r, d.y + b.dy - b.r * 0.7, b.r * 2, b.r * 1.4);
      }
      if (d.run > 0) {          /* a drip running down the wall */
        Pixel.rect(ctx, d.x - Pixel.SIZE / 2, d.y, Pixel.SIZE, d.run);
        Pixel.rect(ctx, d.x - Pixel.SIZE, d.y + d.run, Pixel.SIZE * 2, Pixel.SIZE * 2);
      }
    }
    ctx.globalAlpha = 1;
  };

  /* A torn-off limb is a sprite too. These used to be rotated fillRects,
     which meant every gib carried a soft blended border - and a death
     throws nine of them across the screen at once. */
  var GIB = {
    head: ['kkkkkkkkkkkkkkkk',
           'kkkkkkkkkkkkkkkk',
           'kkkkkkkkkkkkkkkk',
           'kkkkkkkkkkkkkkkk',
           'ssssssssssssssss',
           'ssssssssssssssss',
           'sssseeeessssssss',
           'sssseeeessssssss',
           'ssssssssssssssss',
           'ssssssssssssssss',
           'ssssssmmmmssssss',
           'ssssssmmmmssssss',
           'ssssssssssssssss',
           'ssssssssssssssss',
           'bbbbbbbbbbbbbbbb',
           'bbbbbbbbbbbbbbbb'],
    torso: ['bbbbbbbbbbbbbbbbbb',
            'bbbbbbbbbbbbbbbbbb',
            'uuuuwwwwTTwwuuuuuu',
            'uuuuwwwwTTwwuuuuuu',
            'uuuuuuuuTTuuuuuuaa',
            'uuuuuuuuTTuuuuuuaa',
            'uuuuuuuuTTuuuuuuuu',
            'uuuuuuuuTTuuuuuuuu',
            'uuuuuuuuuuuuuuuuaa',
            'uuuuuuuuuuuuuuuuaa',
            'uuuuuuuuuuuuuuuuuu',
            'uuuuuuuuuuuuuuuuuu',
            'ddddddddddddddddaa',
            'ddddddddddddddddaa',
            'dddddddddddddddddd',
            'dddddddddddddddddd',
            'bbbbdddddddddddddd',
            'bbbbdddddddddddddd'],
    arm: ['bbbbbbbb',
          'bbbbbbbb',
          'uuuuuuuu',
          'uuuuuuuu',
          'uuuuuuuu',
          'uuuuuuuu',
          'uuuuuuuu',
          'uuuuuuuu',
          'uuuuuuuu',
          'uuuuuuuu',
          'uuuuuuuu',
          'uuuuuuuu',
          'ssssssss',
          'ssssssss',
          'ssssssss',
          'ssssssss'],
    leg: ['bbbbbbbb',
          'bbbbbbbb',
          'dddddddd',
          'dddddddd',
          'dddddddd',
          'dddddddd',
          'dddddddd',
          'dddddddd',
          'dddddddd',
          'dddddddd',
          'dddddddd',
          'dddddddd',
          'nnnnnnnn',
          'nnnnnnnn',
          'nnnnnnnn',
          'nnnnnnnn',
          'mmmmmmmm',
          'mmmmmmmm'],
    chunk: ['ccccccCC',
            'ccccccCC',
            'ccccCCCC',
            'ccccCCCC',
            'ccccccCC',
            'ccccccCC',
            '..cccccc',
            '..cccccc'],
  };

  Gore.prototype.drawGibs = function (ctx) {
    var i, g;
    for (i = 0; i < this.gibs.length; i++) {
      g = this.gibs[i];
      var pal = g.palette || { suit: '#3b4370', suit2: '#2b3157' };
      var sprite = GIB[g.kind] || GIB.chunk;
      Pixel.stamp(ctx, sprite, {
        k: '#20232f',
        s: pal.skin || '#f2cfa2',
        e: '#20232f',
        u: pal.suit,
        d: pal.suit2,
        T: pal.tie || '#ff4d5e',
        w: Pixel.tint(pal.suit, 0.66),
        m: Pixel.tint(pal.skin || '#f2cfa2', -0.42),
        n: '#20232f',
        b: '#8c0f1c',
        c: '#a3121f',
        C: '#6d0a15'
      }, g.x + g.w / 2, g.y + g.h / 2, g.rot, false);
    }

    /* droplets last so they read over everything */
    for (i = 0; i < this.drops.length; i++) {
      var d = this.drops[i];
      Pixel.rect(ctx, d.x - d.size / 2, d.y - d.size, d.size, d.size * 2, d.color);
    }
  };

  root.Gore = Gore;
  root.BLOOD_COLORS = BLOOD;
})(typeof window !== 'undefined' ? window : globalThis);
