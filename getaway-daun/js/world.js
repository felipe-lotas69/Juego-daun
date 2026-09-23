/* ============================================================
   world.js - bodies, the ragdoll they wear, and the simulation.

   The one rule that makes this game what it is: you cannot walk.
   Holding a direction leans you over and winds a spring; letting go
   fires it. Everything else - the flailing, the overshoot, the
   landing on your face - falls out of that.
   ============================================================ */
(function (root) {
  'use strict';

  var GRAVITY = 520;
  var TERMINAL = 340;
  var CHARGE_TIME = 0.55;      /* seconds from a tap to a full wind-up */
  var COYOTE = 0.08;

  /* ------------------------------------------------------------ ragdoll
     A verlet rig pinned at the chest and hips. The box that collides is
     still a box - that is what keeps the movement predictable - and the
     limbs just lag behind wherever the box was dragged. */
  var CHEST = 0, HIP = 1, HEAD = 2, ELB_A = 3, HAND_A = 4,
      ELB_B = 5, HAND_B = 6, KNEE_A = 7, FOOT_A = 8, KNEE_B = 9, FOOT_B = 10;
  var JOINTS = 11;
  var LINKS = [
    [CHEST, HIP, 7], [CHEST, HEAD, 5],
    [CHEST, ELB_A, 4], [ELB_A, HAND_A, 4],
    [CHEST, ELB_B, 4], [ELB_B, HAND_B, 4],
    [HIP, KNEE_A, 4], [KNEE_A, FOOT_A, 4],
    [HIP, KNEE_B, 4], [KNEE_B, FOOT_B, 4]
  ];
  /* where each joint rests, in body-local pixels (0,0 = between the feet) */
  var REST = [
    [0, -15], [0, -8], [0, -20],
    [1, -13], [3, -11], [-1, -13], [-3, -11],
    [2, -4], [2, 0], [-2, -4], [-2, 0]
  ];

  function Ragdoll() {
    this.p = [];
    for (var i = 0; i < JOINTS; i++) this.p.push({ x: 0, y: 0, px: 0, py: 0 });
    this.ready = false;
  }

  function local(out, cx, feet, sin, cos, lx, ly) {
    out.x = cx + lx * cos - ly * sin;
    out.y = feet + lx * sin + ly * cos;
  }
  var tmp = { x: 0, y: 0 };

  Ragdoll.prototype.place = function (b) {
    var cx = b.x + b.w / 2, feet = b.y + b.h;
    var sin = Math.sin(b.tilt), cos = Math.cos(b.tilt);
    for (var i = 0; i < JOINTS; i++) {
      local(tmp, cx, feet, sin, cos, REST[i][0], REST[i][1]);
      this.p[i].x = this.p[i].px = tmp.x;
      this.p[i].y = this.p[i].py = tmp.y;
    }
    this.ready = true;
  };

  function pull(pt, tx, ty, k) {
    pt.x += (tx - pt.x) * k;
    pt.y += (ty - pt.y) * k;
  }

  Ragdoll.prototype.update = function (dt, b) {
    if (!this.ready) { this.place(b); return; }
    if (dt <= 0) return;
    var P = this.p;
    var cx = b.x + b.w / 2, feet = b.y + b.h;
    var sin = Math.sin(b.tilt), cos = Math.cos(b.tilt);
    var limp = b.stun > 0 ? 1 : 0;

    /* the two pinned joints are carried rigidly by the box */
    local(tmp, cx, feet, sin, cos, REST[CHEST][0], REST[CHEST][1]);
    P[CHEST].x = tmp.x; P[CHEST].y = tmp.y;
    local(tmp, cx, feet, sin, cos, REST[HIP][0], REST[HIP][1]);
    P[HIP].x = tmp.x; P[HIP].y = tmp.y;

    var drag = Math.exp(-(limp ? 3.2 : 6.0) * dt);
    var g = 520 * dt * dt;
    for (var i = 2; i < JOINTS; i++) {
      var pt = P[i];
      var vx = (pt.x - pt.px) * drag, vy = (pt.y - pt.py) * drag;
      pt.px = pt.x; pt.py = pt.y;
      pt.x += vx;
      pt.y += vy + g;
    }

    /* where the limbs would like to be, pulled softly so they lag */
    var firm = limp ? 0.07 : 0.3;
    local(tmp, cx, feet, sin, cos, REST[HEAD][0], REST[HEAD][1]);
    pull(P[HEAD], tmp.x, tmp.y, limp ? 0.1 : 0.3);

    /* the arms windmill: they chase their rest pose only weakly, and a
       hard landing or a shove leaves them swinging for a while */
    for (var a = 0; a < 2; a++) {
      var eb = a ? ELB_B : ELB_A, hb = a ? HAND_B : HAND_A;
      local(tmp, cx, feet, sin, cos, REST[eb][0], REST[eb][1]);
      pull(P[eb], tmp.x, tmp.y, firm * 0.6);
      local(tmp, cx, feet, sin, cos, REST[hb][0], REST[hb][1]);
      pull(P[hb], tmp.x, tmp.y, firm * 0.45);
    }

    /* feet plant when you are standing on something and trail when not */
    var footK = b.grounded ? 0.42 : 0.06;
    for (var l = 0; l < 2; l++) {
      var kn = l ? KNEE_B : KNEE_A, ft = l ? FOOT_B : FOOT_A;
      local(tmp, cx, feet, sin, cos, REST[kn][0], REST[kn][1]);
      pull(P[kn], tmp.x, tmp.y, footK * 0.8);
      local(tmp, cx, feet, sin, cos, REST[ft][0], REST[ft][1]);
      pull(P[ft], tmp.x, tmp.y, footK);
    }

    /* keep the bones the right length */
    for (var pass = 0; pass < 3; pass++) {
      for (var k = 0; k < LINKS.length; k++) {
        var A = P[LINKS[k][0]], B = P[LINKS[k][1]], len = LINKS[k][2];
        var dx = B.x - A.x, dy = B.y - A.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 0.0001;
        var f = (d - len) / d * 0.5;
        var ox = dx * f, oy = dy * f;
        if (LINKS[k][0] > 1) { A.x += ox; A.y += oy; }
        if (LINKS[k][1] > 1) { B.x -= ox; B.y -= oy; }
      }
    }
  };

  /* ------------------------------------------------------------ racer */
  function Racer(opts) {
    this.index = opts.index;
    this.def = ART.RACERS[opts.index % ART.RACERS.length];
    this.isBot = !!opts.isBot;
    this.keys = opts.keys || null;
    this.name = opts.name || this.def.name;

    this.w = 7; this.h = 20;
    this.x = opts.x; this.y = opts.y;
    this.vx = 0; this.vy = 0;
    this.facing = 1;
    this.tilt = 0;               /* lean, radians; +ve leans right */
    this.charge = 0;
    this.winding = false;
    this.windDir = 1;
    this.grounded = false;
    this.coyote = 0;
    this.spin = 0;

    this.weapon = null;      /* { key, ammo } */
    this.util = null;        /* shield / boost */
    this.cooldown = 0;
    this.flash = 0;
    this.shield = 0;
    this.stun = 0;
    this.respawnAt = { x: opts.x, y: opts.y };
    this.wins = 0;
    this.finished = false;
    this.best = opts.x;          /* furthest point reached, for the race bar */
    this.rag = new Ragdoll();
  }

  Racer.prototype.centre = function () {
    return { x: this.x + this.w / 2, y: this.y + this.h / 2 };
  };

  /* A wind-up released: angle away from vertical grows with the charge,
     so a tap is a little hop straight up and a full hold is a long flat
     dive. That spread is the whole skill of moving. */
  Racer.prototype.launch = function () {
    var c = U.clamp(this.charge, 0, 1);
    var angle = 0.28 + c * 0.85;
    var speed = 150 + c * 105;
    this.vx = Math.sin(angle) * speed * this.windDir;
    this.vy = -Math.cos(angle) * speed;
    this.grounded = false;
    this.coyote = 0;
    this.spin = this.windDir * (1.4 + c * 3.4);
    this.charge = 0;
    this.winding = false;
    this.facing = this.windDir;
  };

  Racer.prototype.hurt = function (fx, fy, stun) {
    if (this.shield > 0) return false;
    this.vx += fx; this.vy += fy;
    this.stun = Math.max(this.stun, stun || 0.5);
    this.grounded = false;
    this.spin += (fx > 0 ? 1 : -1) * 5;
    return true;
  };

  Racer.prototype.control = function (dt, left, right, fire, firePressed, world) {
    if (this.stun > 0) { this.stun -= dt; this.winding = false; this.charge = 0; return; }

    /* One key does both jobs: held, it empties whatever gun you picked up
       at that gun's own rate; tapped with no gun, it spends a utility. */
    if (fire && this.weapon) Guns.fire(world, this);
    else if (firePressed && this.util) world.useUtil(this, this.util);

    var dir = 0;
    if (left && !right) dir = -1;
    else if (right && !left) dir = 1;
    else if (left && right) dir = this.windDir;

    if (this.grounded || this.coyote > 0) {
      if (dir) {
        this.winding = true;
        this.windDir = dir;
        this.facing = dir;
        this.charge = U.clamp(this.charge + dt / CHARGE_TIME, 0, 1);
      } else if (this.winding) {
        this.launch();
      }
    } else if (this.winding) {
      /* The ground went out from under a wind-up - teetering off a ledge,
         or the floor broke. You committed, so it fires rather than being
         silently thrown away; losing a charge you cannot see expire is the
         most infuriating thing a game like this can do. */
      this.launch();
    } else {
      /* in the air the same keys only spin you, which is how you land
         on your feet instead of your head */
      if (dir) this.spin += dir * 14 * dt;
      this.charge = 0;
    }
  };

  /* ------------------------------------------------------------ world */
  function World(level, hooks) {
    this.level = level;
    this.hooks = hooks || {};
    this.solids = level.solids.slice();
    this.items = [];
    this.bullets = [];
    this.bombs = [];
    this.puffs = [];
    this.racers = [];
    this.time = 0;
    this.shake = 0;
    this.finishedOrder = [];
    this.cam = { x: 0, y: 0 };
    this.zoom = 1;

    for (var i = 0; i < level.items.length; i++) {
      var it = level.items[i];
      this.items.push({ x: it.x, y: it.y, kind: it.kind || null, cool: 0, bob: Math.random() * 6 });
    }
  }

  World.prototype.addRacer = function (opts) {
    opts.x = this.level.spawn.x + this.racers.length * 11;
    opts.y = this.level.spawn.y;
    var r = new Racer(opts);
    r.rag.place(r);
    this.racers.push(r);
    return r;
  };

  /* --- collision. Swept on each axis so nothing tunnels at speed. --- */
  function sweep(body, dx, dy, solids) {
    var hitX = false, hitY = false, landed = false, onIce = false, bounce = 0;
    var i, s;

    body.x += dx;
    for (i = 0; i < solids.length; i++) {
      s = solids[i];
      if (s.oneWay) continue;
      if (!U.overlap(body, s)) continue;
      if (dx > 0) body.x = s.x - body.w; else if (dx < 0) body.x = s.x + s.w;
      hitX = true;
    }

    body.y += dy;
    for (i = 0; i < solids.length; i++) {
      s = solids[i];
      if (!U.overlap(body, s)) continue;
      if (s.oneWay) {
        /* a ledge you can jump up through but stand on coming down */
        if (dy <= 0) continue;
        if (body.y + body.h - dy > s.y + 2) continue;
      }
      if (dy > 0) { body.y = s.y - body.h; landed = true; if (s.type === 'ice') onIce = true; if (s.bounce) bounce = s.bounce; }
      else if (dy < 0) body.y = s.y + s.h;
      hitY = true;
    }
    return { hitX: hitX, hitY: hitY, landed: landed, ice: onIce, bounce: bounce };
  }

  World.prototype.useUtil = function (r, kind) {
    r.util = null;
    if (kind === 'boost') {
      var a = 0.9 * r.facing;
      r.vx += Math.sin(a) * 190;
      r.vy -= 40;
      r.spin += r.facing * 6;
      this.puff(r.x + r.w / 2, r.y + r.h, 8, '#ffc23c');
    } else if (kind === 'shield') {
      r.shield = 5;
    }
    if (this.hooks.toast) this.hooks.toast(kind.toUpperCase());
  };

  World.prototype.puff = function (x, y, n, col) {
    for (var i = 0; i < n; i++) {
      this.puffs.push({
        x: x, y: y,
        vx: U.rand(-60, 60), vy: U.rand(-70, 10),
        life: U.rand(0.25, 0.6), age: 0, col: col
      });
    }
  };

  World.prototype.blast = function (x, y, power) {
    this.shake = Math.max(this.shake, 4);
    this.puff(x, y, 18, '#ffc23c');
    this.puff(x, y, 10, '#ffffff');
    for (var i = 0; i < this.racers.length; i++) {
      var r = this.racers[i];
      var c = r.centre();
      var d = U.dist(x, y, c.x, c.y);
      if (d > 46) continue;
      var f = (1 - d / 46) * power;
      var nx = (c.x - x) / (d || 1), ny = (c.y - y) / (d || 1);
      r.hurt(nx * f, ny * f - f * 0.5, 0.6);
    }
  };

  World.prototype.update = function (dt, inputs) {
    this.time += dt;
    if (this.shake > 0) this.shake = Math.max(0, this.shake - dt * 14);

    var i, j, r;

    /* --- racers --- */
    for (i = 0; i < this.racers.length; i++) {
      r = this.racers[i];
      if (r.finished) continue;

      var inp = inputs[i] || { left: false, right: false, fire: false, firePressed: false };
      r.control(dt, inp.left, inp.right, inp.fire, inp.firePressed, this);

      if (r.shield > 0) r.shield -= dt;
      if (r.cooldown > 0) r.cooldown -= dt;
      if (r.flash > 0) r.flash -= dt;

      /* gravity, and a hard cap so a long drop stays readable */
      r.vy = Math.min(r.vy + GRAVITY * dt, TERMINAL);

      /* On the ground you scrub speed fast - there is no running, only
         the leftovers of the last jump. */
      if (r.grounded) {
        var fr = Math.exp(-(r.winding ? 11 : 7) * dt);
        r.vx *= fr;
        if (Math.abs(r.vx) < 3) r.vx = 0;
      } else {
        r.vx *= Math.exp(-0.5 * dt);
      }

      var res = sweep(r, r.vx * dt, r.vy * dt, this.solids);
      if (res.hitX) { r.vx *= -0.24; r.spin *= 0.4; }

      var wasAir = !r.grounded;
      if (res.landed) {
        if (res.bounce) {
          r.vy = -res.bounce;
          r.grounded = false;
          this.puff(r.x + r.w / 2, r.y + r.h, 5, '#a8f890');
        } else {
          /* a fast landing knocks you flat for a moment */
          if (wasAir && r.vy > 300) { r.stun = Math.max(r.stun, 0.35); this.puff(r.x + r.w / 2, r.y + r.h, 6, '#d8d2c4'); }
          r.vy = 0;
          r.grounded = true;
          r.coyote = COYOTE;
          if (res.ice) r.vx *= 1.04;
        }
      } else if (res.hitY) {
        r.vy = 0;
        r.grounded = false;
      } else {
        r.grounded = false;
      }
      if (!r.grounded) r.coyote = Math.max(0, r.coyote - dt);

      /* the body's lean: wound up on the ground, tumbling in the air */
      if (r.grounded && r.stun <= 0) {
        /* Never quite upright. A standing racer sways on its own clock, so
           four of them on a roof are never a row of posts - and it reads as
           a body balancing rather than a sprite parked on a surface. */
        var idle = Math.sin(this.time * 2.1 + r.index * 1.9) * 0.07;
        var want = r.winding ? r.windDir * (0.12 + r.charge * 0.72) : idle;
        r.tilt += (want - r.tilt) * Math.min(1, dt * 16);
        r.spin *= Math.exp(-9 * dt);
      } else {
        r.tilt += r.spin * dt;
        r.spin *= Math.exp(-0.7 * dt);
      }

      if (r.stun > 0) r.stun -= dt;
      r.rag.update(dt, r);

      /* fell out of the level */
      if (r.y > this.level.height + 40) {
        r.x = r.respawnAt.x; r.y = r.respawnAt.y;
        r.vx = r.vy = 0; r.tilt = 0; r.spin = 0; r.stun = 0.4;
        r.rag.place(r);
        if (this.hooks.fell) this.hooks.fell(r);
      }

      /* checkpoints are invisible: the furthest one you have gone past */
      var cps = this.level.checkpoints;
      for (j = 0; j < cps.length; j++) {
        if (r.x > cps[j].x && cps[j].x > r.respawnAt.x) {
          r.respawnAt = { x: cps[j].x, y: cps[j].y };
        }
      }
      if (r.x > r.best) r.best = r.x;

      /* pick something up */
      for (j = 0; j < this.items.length; j++) {
        var it = this.items[j];
        if (it.cool > 0) continue;
        if (r.weapon || r.util) break;
        if (Math.abs((r.x + r.w / 2) - it.x) < 9 && Math.abs((r.y + r.h / 2) - it.y) < 11) {
          it.cool = 7;
          if (it.kind === 'shield' || it.kind === 'boost') {
            r.util = it.kind;
          } else if (Math.random() < 0.22) {
            r.util = U.pick(['shield', 'boost']);
          } else {
            var key = it.kind || U.pick(WEAPON_ORDER);
            r.weapon = { key: key, ammo: WEAPONS[key].ammo };
          }
          if (this.hooks.pickup) this.hooks.pickup(r, r.weapon ? WEAPONS[r.weapon.key].name : r.util.toUpperCase());
        }
      }

      /* The van at the end is a FINISH LINE, not a box to land in. A
         jump covers a hundred pixels and the van is twenty-six wide, so
         a box would be cleared outright by anyone going fast. */
      var g = this.level.goal;
      if (!r.finished && r.x + r.w > g.x) {
        r.finished = true;
        this.finishedOrder.push(r);
        if (this.hooks.finished) this.hooks.finished(r, this.finishedOrder.length);
      }
    }

    /* racers shove each other on contact, which is most of the comedy */
    for (i = 0; i < this.racers.length; i++) {
      for (j = i + 1; j < this.racers.length; j++) {
        var a = this.racers[i], b = this.racers[j];
        if (a.finished || b.finished) continue;
        if (!U.overlap(a, b)) continue;
        var ac = a.centre(), bc = b.centre();
        var push = (bc.x > ac.x ? 1 : -1) * 34;
        a.vx -= push; b.vx += push;
        a.spin -= push * 0.05; b.spin += push * 0.05;
      }
    }

    for (i = 0; i < this.items.length; i++) {
      if (this.items[i].cool > 0) this.items[i].cool -= dt;
    }

    Guns.update(this, dt);

    /* --- bombs --- */
    for (i = this.bombs.length - 1; i >= 0; i--) {
      var bm = this.bombs[i];
      bm.vy = Math.min(bm.vy + GRAVITY * dt, TERMINAL);
      var box = { x: bm.x - 2, y: bm.y - 2, w: 4, h: 4 };
      var br = sweep(box, bm.vx * dt, bm.vy * dt, this.solids);
      bm.x = box.x + 2; bm.y = box.y + 2;
      if (br.hitX) bm.vx *= -0.4;
      if (br.landed) { bm.vy = -Math.abs(bm.vy) * 0.34; bm.vx *= 0.7; }
      else if (br.hitY) bm.vy = 0;
      bm.fuse -= dt;
      if (bm.fuse <= 0) { this.blast(bm.x, bm.y, 210); this.bombs.splice(i, 1); }
    }

    /* --- puffs --- */
    for (i = this.puffs.length - 1; i >= 0; i--) {
      var p = this.puffs[i];
      p.age += dt;
      if (p.age >= p.life) { this.puffs.splice(i, 1); continue; }
      p.vy += 180 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
    }
  };

  /* Who the camera belongs to. In one-player that is you, win or lose -
     being shown the race while you cannot see your own feet is worse than
     being behind. With two locals it sits between them. */
  World.prototype.focus = function (humans) {
    if (humans >= 2) {
      var group = this.racers.slice(0, humans);
      return {
        centre: function () {
          var x = 0, y = 0, n = 0;
          for (var i = 0; i < group.length; i++) {
            var c = group[i].centre();
            x += c.x; y += c.y; n++;
          }
          return { x: x / n, y: y / n };
        },
        vx: 0, vy: 0
      };
    }
    return this.racers[0] || this.leader();
  };

  World.prototype.leader = function () {
    var best = this.racers[0];
    for (var i = 1; i < this.racers.length; i++) {
      if (this.racers[i].best > best.best) best = this.racers[i];
    }
    return best;
  };

  World.prototype.follow = function (target, dt, snap) {
    /* Pull back far enough to hold everyone still racing. Four players in
       a scrum want a tight frame; four players strung out across a map
       want a loose one, and the camera is the only thing that can say so. */
    var live = [], i;
    for (i = 0; i < this.racers.length; i++) {
      if (!this.racers[i].finished) live.push(this.racers[i]);
    }
    var wantZoom = 1;
    if (live.length > 1) {
      var minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      for (i = 0; i < live.length; i++) {
        var lc = live[i].centre();
        if (lc.x < minX) minX = lc.x;
        if (lc.x > maxX) maxX = lc.x;
        if (lc.y < minY) minY = lc.y;
        if (lc.y > maxY) maxY = lc.y;
      }
      var needW = (maxX - minX) + 70, needH = (maxY - minY) + 60;
      wantZoom = Math.min(1, Pixel.W / needW, Pixel.H / needH);
      wantZoom = U.clamp(wantZoom, 0.55, 1);
    }
    this.zoom = snap ? wantZoom : this.zoom + (wantZoom - this.zoom) * Math.min(1, dt * 2.2);

    var viewW = Pixel.W / this.zoom, viewH = Pixel.H / this.zoom;
    var c = target.centre();
    var tx = c.x - viewW / 2 + U.clamp(target.vx * 0.22, -30, 30);
    var ty = c.y - viewH * 0.50 + U.clamp(target.vy * 0.07, -14, 20);
    tx = U.clamp(tx, 0, Math.max(0, this.level.width - viewW));
    ty = U.clamp(ty, -20, Math.max(0, this.level.height - viewH));
    if (snap) { this.cam.x = tx; this.cam.y = ty; return; }
    var k = Math.min(1, dt * 5.5);
    this.cam.x += (tx - this.cam.x) * k;
    this.cam.y += (ty - this.cam.y) * k;
  };

  root.Racer = Racer;
  root.World = World;
  root.Ragdoll = Ragdoll;
  root.RAG_JOINTS = {
    CHEST: CHEST, HIP: HIP, HEAD: HEAD,
    ELB_A: ELB_A, HAND_A: HAND_A, ELB_B: ELB_B, HAND_B: HAND_B,
    KNEE_A: KNEE_A, FOOT_A: FOOT_A, KNEE_B: KNEE_B, FOOT_B: FOOT_B
  };
})(typeof window !== 'undefined' ? window : globalThis);
