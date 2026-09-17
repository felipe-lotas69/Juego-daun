/* ============================================================
   entities.js - player, enemies, level furniture
   ============================================================ */
(function (root) {
  'use strict';

  var GRAV = 1900;
  var MAX_FALL = 1600;

  /* ------------------------------------------------------------------
     Shared swept-AABB movement. Entities keep an axis-aligned box;
     the visual rotation is cosmetic (and aim), never collision.
     ------------------------------------------------------------------ */
  function moveAndCollide(e, dx, dy, world, cb) {
    var steps = Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 7) || 1;
    if (steps > 40) steps = 40;
    var sx = dx / steps, sy = dy / steps;
    var solids = world.solids;
    var i, s, k;

    e.grounded = false;

    for (k = 0; k < steps; k++) {
      /* ---- horizontal ---- */
      if (sx !== 0) {
        e.x += sx;
        for (i = 0; i < solids.length; i++) {
          s = solids[i];
          if (!U.aabb(e, s)) continue;
          if (cb && cb(e, s, 'x', world) === false) continue;
          if (sx > 0) e.x = s.x - e.w; else e.x = s.x + s.w;
          e.hitWallDir = sx > 0 ? 1 : -1;
          e.hitWall = s;
          if (Math.abs(e.vx) > 260 && e.bouncy) e.vx = -e.vx * 0.36;
          else e.vx = 0;
          sx = 0;
          break;
        }
      }
      /* ---- vertical ---- */
      if (sy !== 0) {
        e.y += sy;
        for (i = 0; i < solids.length; i++) {
          s = solids[i];
          if (!U.aabb(e, s)) continue;
          if (cb && cb(e, s, 'y', world) === false) continue;
          if (sy > 0) {
            e.y = s.y - e.h;
            e.grounded = true;
            e.groundRef = s;
            if (s.bounce) {
              e.vy = -Math.max(Math.abs(e.vy) * s.bounce, 620);
              e.grounded = false;
              if (e.onBouncePad) e.onBouncePad(world);
            } else {
              if (e.onLand) e.onLand(e.vy, s, world);
              e.vy = 0;
            }
          } else {
            e.y = s.y + s.h;
            e.vy = Math.max(0, e.vy);
            if (e.onCeiling) e.onCeiling(s, world);
          }
          sy = 0;
          break;
        }
      }
      if (sx === 0 && sy === 0) break;
    }
  }

  /* ==================================================================
     PLAYER
     ================================================================== */
  var MAX_LEAN_GROUND = 1.2;
  var MAX_LEAN_AIR = 1.45;

  function Player(x, y) {
    this.w = 24; this.h = 44;
    this.x = x - this.w / 2; this.y = y - this.h;
    this.vx = 0; this.vy = 0;
    this.angle = 0;
    this.facing = 1;
    this.grounded = false;
    this.groundRef = null;
    this.hopTimer = 0;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.stumble = 0;
    this.flipTimer = 0;
    this.health = 100;
    this.maxHealth = 100;
    this.weapon = null;        /* { key, ammo } */
    this.cooldown = 0;
    this.invuln = 0;
    this.dead = false;
    this.deadTimer = 0;
    this.bouncy = true;
    this.hurtFlash = 0;
    this.stepPhase = 0;
    this.spawnX = x; this.spawnY = y;
    this.muzzleFlash = 0;
  }

  /* Aim follows the lean: leaning the way you face drops the muzzle, leaning
     back raises it. Mirrored so left and right behave identically. */
  Player.prototype.aim = function () {
    return this.facing === 1 ? this.angle * 0.9 : Math.PI + this.angle * 0.9;
  };

  Player.prototype.center = function () {
    return { x: this.x + this.w / 2, y: this.y + this.h * 0.42 };
  };

  Player.prototype.muzzle = function () {
    var c = this.center();
    var a = this.aim();
    var len = this.weapon ? WEAPONS[this.weapon.key].barrel + 8 : 14;
    return { x: c.x + Math.cos(a) * len, y: c.y + Math.sin(a) * len };
  };

  Player.prototype.onLand = function (vy, s, world) {
    if (vy > 380) {
      Sound.land(vy);
      world.fx.burst(this.x + this.w / 2, this.y + this.h, Math.min(14, 3 + vy / 110), {
        angle: -Math.PI / 2, spread: 1.5, colors: ['#9aa0b4', '#6f7488'],
        speedMax: 130, lifeMax: 0.4, sizeMax: 4
      });
    }
    if (vy > 1000) {
      this.stumble = 0.36;
      world.shake(3.5);
      Sound.thud();
    }
    /* glass gives way: one heavy landing smashes it, two firm ones crack it
       through. A hop lands at ~300, a jump at ~500-700. */
    if (s.ref && s.ref.kind === 'glass') {
      if (vy > 700) s.ref.shatter(world, 0, vy);
      else if (vy > 450) s.ref.hit(world, 0, vy);
    }
  };

  Player.prototype.onBouncePad = function (world) {
    Sound.jump();
    world.fx.burst(this.x + this.w / 2, this.y + this.h, 12, {
      angle: -Math.PI / 2, spread: 1.0, colors: ['#49e0e8', '#a8f4ff'], speedMax: 260, lifeMax: 0.5
    });
  };

  Player.prototype.update = function (dt, world, input) {
    if (this.dead) {
      this.deadTimer += dt;
      return;
    }

    this.invuln = Math.max(0, this.invuln - dt);
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3);
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.hopTimer = Math.max(0, this.hopTimer - dt);
    this.stumble = Math.max(0, this.stumble - dt);
    this.muzzleFlash = Math.max(0, this.muzzleFlash - dt * 6);

    var onGround = this.grounded;

    var dir = 0;
    if (input.left()) dir -= 1;
    if (input.right()) dir += 1;
    if (this.stumble > 0) dir = 0;

    /* ---------- lean ---------- */
    var maxLean = onGround ? MAX_LEAN_GROUND : MAX_LEAN_AIR;
    var leanRate = onGround ? 8.5 : 6.5;

    if (dir !== 0) {
      if (onGround) this.facing = dir;
      this.angle = U.approach(this.angle, dir * maxLean, leanRate * dt);

      /* airborne 180: hold the key opposite your facing at full tilt */
      if (!onGround && dir !== this.facing && Math.abs(this.angle) > maxLean - 0.06) {
        this.flipTimer += dt;
        if (this.flipTimer > 0.3) {
          this.facing = dir;
          this.angle = 0;
          this.flipTimer = 0;
          world.fx.burst(this.x + this.w / 2, this.y + this.h / 2, 8, {
            colors: ['#ffffff', '#cfd3e2'], speedMax: 110, lifeMax: 0.3, g: 0
          });
        }
      } else {
        this.flipTimer = 0;
      }
    } else {
      this.flipTimer = 0;
      this.angle = U.approach(this.angle, 0, (onGround ? 6.0 : 3.2) * dt);
    }

    /* ---------- jump and hop ----------
       Jump wins over the hop on any frame where both could fire, and the
       coyote timer is read from the ground state at the TOP of the frame -
       otherwise the hop clears `grounded` first and W never fires while
       you are moving. */
    if (onGround) this.coyote = 0.1; else this.coyote = Math.max(0, this.coyote - dt);
    if (input.jumpPressed()) this.jumpBuffer = 0.12; else this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);

    var jumped = false;
    if (this.jumpBuffer > 0 && this.coyote > 0 && this.stumble <= 0) {
      var s = Math.sin(this.angle);
      this.vy = -(700 - 215 * Math.abs(s));
      this.vx = U.clamp(this.vx + s * 520, -680, 680);
      this.grounded = false;
      this.coyote = 0;
      this.jumpBuffer = 0;
      this.hopTimer = 0.18;
      jumped = true;
      Sound.jump();
      world.fx.burst(this.x + this.w / 2, this.y + this.h, 10, {
        angle: -Math.PI / 2, spread: 1.3, colors: ['#cfd3e2', '#8b90a4'],
        speedMax: 190, lifeMax: 0.45, sizeMax: 4
      });
    }

    /* ---------- hopping (this is how you walk) ---------- */
    if (!jumped && onGround && dir !== 0 && this.hopTimer <= 0 && this.stumble <= 0) {
      var lean = Math.abs(Math.sin(this.angle));
      var push = 120 + 190 * lean;
      var lift = 210 + 130 * Math.cos(this.angle);
      this.vx = U.clamp(this.vx + dir * push, -360, 360);
      this.vy = -lift;
      this.hopTimer = 0.2;
      this.grounded = false;
      this.stepPhase += 1;
      Sound.hop();
      world.fx.burst(this.x + this.w / 2 - dir * 6, this.y + this.h, 4, {
        angle: dir > 0 ? Math.PI : 0, spread: 0.8, colors: ['#8b90a4', '#5d6275'],
        speedMax: 110, lifeMax: 0.3, sizeMax: 3
      });
    }

    /* ---------- integrate ---------- */
    this.vy += GRAV * dt;
    if (this.vy > MAX_FALL) this.vy = MAX_FALL;

    if (this.grounded) {
      this.vx *= U.damp(dir !== 0 ? 1.4 : 7.5, dt);
      if (this.groundRef && this.groundRef.ice) this.vx *= U.damp(dir !== 0 ? 0.1 : 0.35, dt);
    } else {
      if (dir !== 0) this.vx = U.clamp(this.vx + dir * 210 * dt, -520, 520);
      this.vx *= U.damp(0.45, dt);
    }

    /* ride moving platforms */
    if (this.grounded && this.groundRef && (this.groundRef.dx || this.groundRef.dy)) {
      this.x += this.groundRef.dx;
      this.y += this.groundRef.dy;
    }

    this.hitWall = null;
    moveAndCollide(this, this.vx * dt, this.vy * dt, world);

    /* ---------- shooting ---------- */
    if (this.weapon) {
      var def = WEAPONS[this.weapon.key];
      /* holding R sprays an automatic weapon, but only when R is not
         already spoken for by something you could interact with */
      var holdR = input.interactHeld && input.interactHeld() && !world.prompt;
      var wantsFire = def.auto ? (input.fireHeld() || holdR) : input.firePressed();
      if (wantsFire && this.cooldown <= 0) this.shoot(world);
    }
    if (input.dropPressed() && this.weapon) this.dropWeapon(world);
  };

  Player.prototype.shoot = function (world) {
    if (!this.weapon) return;
    var def = WEAPONS[this.weapon.key];
    if (this.weapon.ammo <= 0) { Sound.click(); return; }
    var m = this.muzzle();
    var kick = fireWeapon(world, this, this.weapon.key, this.aim(), m.x, m.y, 'player');
    this.weapon.ammo--;
    this.cooldown = def.rate;
    this.muzzleFlash = 1;
    if (kick) {
      this.vx = U.clamp(this.vx + kick.fx, -900, 900);
      this.vy = U.clamp(this.vy + kick.fy, -900, 900);
      if (kick.fy < -20) this.grounded = false;
    }
    if (this.weapon.ammo <= 0) {
      world.toast('OUT OF AMMO');
      var self = this;
      setTimeout(function () { if (self.weapon && self.weapon.ammo <= 0) self.weapon = null; }, 450);
    }
  };

  Player.prototype.dropWeapon = function (world) {
    if (!this.weapon) return;
    var p = new Pickup(this.x + this.w / 2, this.y + this.h / 2, this.weapon.key, this.weapon.ammo);
    p.vx = this.facing * 160 + this.vx * 0.4;
    p.vy = -180;
    p.cooldown = 0.6;
    world.pickups.push(p);
    this.weapon = null;
    world.toast('DROPPED');
  };

  Player.prototype.takeWeapon = function (key, ammo, world) {
    if (this.weapon) this.dropWeapon(world);
    this.weapon = { key: key, ammo: ammo };
    Sound.pickup();
    world.toast(WEAPONS[key].name);
  };

  Player.prototype.damage = function (amount, kx, ky, world) {
    if (this.dead || this.invuln > 0) return;
    this.health -= amount;
    this.vx += kx; this.vy += ky;
    this.invuln = 0.5;
    this.hurtFlash = 1;
    this.stumble = Math.max(this.stumble, 0.2);
    world.shake(4);
    world.fx.burst(this.x + this.w / 2, this.y + this.h / 2, 10, {
      colors: ['#ff4d5e', '#ffb0b8'], speedMax: 230, lifeMax: 0.5
    });
    if (this.health <= 0) this.kill(world);
    else Sound.hurt();
  };

  Player.prototype.kill = function (world) {
    if (this.dead) return;
    this.dead = true;
    this.deadTimer = 0;
    this.health = 0;
    Sound.die();
    world.shake(9);
    world.fx.burst(this.x + this.w / 2, this.y + this.h / 2, 34, {
      colors: ['#ff4d5e', '#c1232f', '#ffb0b8'], speedMax: 380, lifeMax: 1.0, sizeMax: 6, bounce: 0.3
    });
  };

  Player.prototype.draw = function (ctx) {
    var cx = this.x + this.w / 2;
    var feet = this.y + this.h;
    var a = this.angle;
    var hurt = this.hurtFlash > 0;
    var blink = this.invuln > 0 && Math.floor(this.invuln * 20) % 2 === 0;

    /* contact shadow - grounds the character and helps you find yourself */
    ctx.save();
    ctx.globalAlpha = blink ? 0.2 : 0.34;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(cx, feet - 1, 15, 4.5, 0, 0, 6.2832);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.globalAlpha = blink ? 0.45 : 1;
    ctx.translate(cx, feet);
    ctx.rotate(a);

    /* dark rim so the silhouette survives any backdrop */
    ctx.strokeStyle = 'rgba(8,10,18,0.85)';
    ctx.lineWidth = 3;
    ctx.lineJoin = 'round';
    U.roundRect(ctx, -10.5, -49.5, 21, 37, 5);
    ctx.stroke();
    ctx.strokeRect(-9.5, -15.5, 8, 16);
    ctx.strokeRect(1.5, -15.5, 8, 16);

    var skin = hurt ? '#ffd0d4' : '#f0c9a0';
    var suit = hurt ? '#ff8f9a' : '#3b4370';
    var suit2 = hurt ? '#ff7b88' : '#2b3157';

    /* legs - alternate with the hop phase */
    var swing = this.grounded ? Math.sin(this.stepPhase * 1.7) * 3 : U.clamp(this.vy / 260, -5, 5);
    ctx.fillStyle = suit2;
    ctx.fillRect(-9, -15, 7, 15 + swing);
    ctx.fillRect(2, -15, 7, 15 - swing);
    ctx.fillStyle = '#12141d';
    ctx.fillRect(-10, -2 + swing, 9, 4);
    ctx.fillRect(1, -2 - swing, 9, 4);

    /* torso */
    ctx.fillStyle = suit;
    U.roundRect(ctx, -10, -34, 20, 21, 4);
    ctx.fill();
    /* tie */
    ctx.fillStyle = '#ff4d5e';
    ctx.fillRect(-2, -33, 4, 12);

    /* head */
    ctx.fillStyle = skin;
    U.roundRect(ctx, -8, -49, 16, 16, 6);
    ctx.fill();
    /* hair */
    ctx.fillStyle = '#20232f';
    U.roundRect(ctx, -8, -49, 16, 6, 3);
    ctx.fill();
    /* eye */
    ctx.fillStyle = '#20232f';
    ctx.fillRect(this.facing === 1 ? 2 : -5, -43, 3, 3);

    ctx.restore();

    /* ---- arm + weapon, drawn in world space along the aim line ---- */
    var c = this.center();
    var aim = this.aim();
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate(aim);
    ctx.strokeStyle = skin;
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(this.weapon ? 15 : 11, 0);
    ctx.stroke();

    if (this.weapon) {
      var def = WEAPONS[this.weapon.key];
      ctx.fillStyle = def.body;
      ctx.fillRect(8, -4, def.barrel, 7);
      ctx.fillStyle = '#20232f';
      ctx.fillRect(10, 2, 6, 7);
      if (def.explosive) { ctx.fillStyle = '#ff6a4d'; ctx.fillRect(8 + def.barrel - 6, -5, 5, 9); }
      if (def.teleport) { ctx.fillStyle = '#49e0e8'; ctx.fillRect(8 + def.barrel - 6, -5, 5, 9); }
      if (this.muzzleFlash > 0.05) {
        ctx.globalAlpha = this.muzzleFlash;
        ctx.fillStyle = '#fff3c4';
        ctx.beginPath();
        ctx.moveTo(8 + def.barrel, -6);
        ctx.lineTo(8 + def.barrel + 16 * this.muzzleFlash, 0);
        ctx.lineTo(8 + def.barrel, 6);
        ctx.closePath();
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  };

  /* ==================================================================
     ENEMY
     ================================================================== */
  function Enemy(opt) {
    this.w = 24; this.h = 42;
    this.x = opt.x - this.w / 2; this.y = opt.y - this.h;
    this.vx = 0; this.vy = 0;
    this.health = opt.health || 60;
    this.weaponKey = opt.weapon || 'pistol';
    this.cooldown = U.rand(0.4, 1.4);
    this.facing = opt.facing || -1;
    this.patrol = opt.patrol || 0;      /* half-width of patrol, 0 = static */
    this.homeX = opt.x;
    this.alert = 0;
    this.grounded = false;
    this.dead = false;
    this.deathTimer = 0;
    this.angle = 0;
    this.stepPhase = 0;
    this.hopTimer = 0;
    this.hurtFlash = 0;
    this.drops = opt.drops !== false;
    this.aimAngle = Math.PI;
  }

  Enemy.prototype.center = function () { return { x: this.x + this.w / 2, y: this.y + this.h * 0.42 }; };

  Enemy.prototype.update = function (dt, world) {
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3);

    if (this.dead) {
      this.deathTimer += dt;
      this.vy += GRAV * dt;
      this.angle += this.spin * dt;
      this.vx *= U.damp(1.2, dt);
      moveAndCollide(this, this.vx * dt, this.vy * dt, world);
      if (this.grounded) { this.vx *= U.damp(9, dt); this.spin *= U.damp(9, dt); }
      return;
    }

    var p = world.player;
    var c = this.center(), pc = p.center();
    var d = U.dist(c.x, c.y, pc.x, pc.y);
    var canSee = !p.dead && d < 620 && world.lineOfSight(c.x, c.y, pc.x, pc.y);

    if (canSee) {
      this.alert = 2.2;
      this.facing = pc.x < c.x ? -1 : 1;
    } else {
      this.alert = Math.max(0, this.alert - dt);
    }

    /* patrol hop when idle */
    this.cooldown -= dt;
    this.hopTimer -= dt;
    if (this.alert <= 0 && this.patrol > 0) {
      var mid = this.x + this.w / 2;
      if (mid > this.homeX + this.patrol) this.facing = -1;
      if (mid < this.homeX - this.patrol) this.facing = 1;
      if (this.grounded && this.hopTimer <= 0) {
        /* look before you leap - a hop covers ~25px, so probe past that */
        var aheadX = mid + this.facing * (this.w / 2 + 34);
        if (!world.solidAt(aheadX, this.y + this.h + 8)) this.facing = -this.facing;
        this.vx = this.facing * 105;
        this.vy = -230;
        this.hopTimer = 0.55;
        this.stepPhase++;
      }
    }

    /* shoot */
    if (canSee && this.cooldown <= 0) {
      var def = WEAPONS[this.weaponKey];
      var lead = 0.12;
      var tx = pc.x + p.vx * lead, ty = pc.y + p.vy * lead;
      var a = Math.atan2(ty - c.y, tx - c.x) + U.rand(-0.1, 0.1);
      this.aimAngle = a;
      var mx = c.x + Math.cos(a) * 20, my = c.y + Math.sin(a) * 20;
      fireWeapon(world, this, this.weaponKey, a, mx, my, 'enemy');
      this.cooldown = def.rate * (def.auto ? 1 : 1) + U.rand(0.35, 0.9);
      this.vx -= Math.cos(a) * def.recoil * 0.25;
    } else if (!canSee) {
      this.aimAngle = this.facing === 1 ? 0 : Math.PI;
    }

    this.vy += GRAV * dt;
    if (this.vy > MAX_FALL) this.vy = MAX_FALL;
    if (this.grounded) this.vx *= U.damp(this.alert > 0 ? 5 : 2.2, dt);
    else this.vx *= U.damp(0.4, dt);

    if (this.grounded && this.groundRef && (this.groundRef.dx || this.groundRef.dy)) {
      this.x += this.groundRef.dx;
      this.y += this.groundRef.dy;
    }

    this.angle = U.approach(this.angle, U.clamp(this.vx / 500, -0.35, 0.35), 4 * dt);
    moveAndCollide(this, this.vx * dt, this.vy * dt, world);

    if (this.y > world.level.height + 400) this.dead = true;
  };

  Enemy.prototype.damage = function (amount, kx, ky, world) {
    if (this.dead) return;
    this.health -= amount;
    this.vx += kx * 0.7; this.vy += ky;
    this.hurtFlash = 1;
    if (this.health <= 0) this.die(world, kx);
  };

  Enemy.prototype.die = function (world, kx) {
    this.dead = true;
    this.deathTimer = 0;
    this.spin = U.rand(-9, 9) + U.sign(kx || 1) * 5;
    this.vy = -260;
    this.vx += (kx || 0) * 0.6;
    Sound.hit();
    world.fx.burst(this.x + this.w / 2, this.y + this.h / 2, 22, {
      colors: ['#ff4d5e', '#c1232f'], speedMax: 300, lifeMax: 0.8, sizeMax: 5, bounce: 0.25
    });
    world.onEnemyKilled(this);
    if (this.drops) {
      var pk = new Pickup(this.x + this.w / 2, this.y + 10, this.weaponKey, Math.ceil(WEAPONS[this.weaponKey].ammo * 0.55));
      pk.vx = U.rand(-120, 120); pk.vy = -220; pk.cooldown = 0.35;
      world.pickups.push(pk);
    }
  };

  Enemy.prototype.draw = function (ctx) {
    var cx = this.x + this.w / 2, feet = this.y + this.h;
    ctx.save();
    ctx.globalAlpha = this.dead ? U.clamp(1 - (this.deathTimer - 3) / 1.5, 0, 1) : 1;
    ctx.translate(cx, feet);
    ctx.rotate(this.dead ? this.angle : this.angle);

    var hurt = this.hurtFlash > 0;
    var suit = hurt ? '#ffa0a8' : '#6b3a4a';
    var suit2 = hurt ? '#ff8f9a' : '#542d3a';
    var swing = this.grounded ? Math.sin(this.stepPhase * 1.7) * 3 : 0;

    ctx.fillStyle = suit2;
    ctx.fillRect(-9, -14, 7, 14 + swing);
    ctx.fillRect(2, -14, 7, 14 - swing);
    ctx.fillStyle = '#12141d';
    ctx.fillRect(-10, -2 + swing, 9, 4);
    ctx.fillRect(1, -2 - swing, 9, 4);

    ctx.fillStyle = suit;
    U.roundRect(ctx, -10, -33, 20, 20, 4);
    ctx.fill();

    ctx.fillStyle = hurt ? '#ffd0d4' : '#d8a87e';
    U.roundRect(ctx, -8, -47, 16, 15, 6);
    ctx.fill();
    ctx.fillStyle = '#20232f';
    U.roundRect(ctx, -9, -48, 18, 7, 3);
    ctx.fill();   /* cap */
    ctx.fillRect(this.facing === 1 ? 2 : -5, -41, 3, 3);
    ctx.restore();

    if (!this.dead) {
      var c = this.center();
      ctx.save();
      ctx.translate(c.x, c.y);
      ctx.rotate(this.aimAngle);
      ctx.strokeStyle = '#d8a87e';
      ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(14, 0); ctx.stroke();
      var def = WEAPONS[this.weaponKey];
      ctx.fillStyle = def.body;
      ctx.fillRect(8, -4, def.barrel, 7);
      ctx.restore();

      /* alert marker */
      if (this.alert > 0) {
        ctx.fillStyle = 'rgba(255,77,94,' + U.clamp(this.alert, 0, 1) + ')';
        ctx.font = 'bold 16px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('!', cx, this.y - 8);
      }
    }
    ctx.globalAlpha = 1;
  };

  /* ==================================================================
     ELEVATOR / MOVING PLATFORM
     mode: 'auto'   - ping-pongs forever
           'call'   - idle until the player interacts (R) or a button fires
           'plate'  - moves while the player is standing on it
     ================================================================== */
  function Elevator(o) {
    this.kind = 'elevator';
    this.x = o.x; this.y = o.y; this.w = o.w; this.h = o.h || 16;
    this.ax = o.x; this.ay = o.y;
    this.bx = o.bx != null ? o.bx : o.x;
    this.by = o.by != null ? o.by : o.y;
    this.speed = o.speed || 90;
    this.mode = o.mode || 'auto';
    this.id = o.id || null;
    this.style = o.style || 'platform';   /* 'platform' | 'cage' */
    this.t = 0;              /* 0..1 along the path */
    this.dir = o.startDir || 1;
    this.wait = 0;
    this.waitTime = o.wait == null ? 0.8 : o.wait;
    this.active = this.mode === 'auto';
    this.dx = 0; this.dy = 0;
    this.label = o.label || null;
  }

  Elevator.prototype.len = function () { return U.dist(this.ax, this.ay, this.bx, this.by); };

  Elevator.prototype.trigger = function (world) {
    if (this.mode === 'plate') return;
    this.active = true;
    if (this.wait <= 0 && (this.t <= 0 || this.t >= 1)) this.dir = this.t >= 1 ? -1 : 1;
    Sound.elevator();
    world.toast('ELEVATOR');
  };

  Elevator.prototype.update = function (dt, world) {
    var px = this.x, py = this.y;
    var len = this.len() || 1;

    var moving = this.active;
    if (this.mode === 'plate') {
      var p = world.player;
      moving = p.grounded && p.groundRef && p.groundRef.ref === this;
      this.dir = moving ? 1 : -1;
      if (!moving && this.t <= 0) moving = false; else moving = true;
    }

    if (moving) {
      if (this.wait > 0) {
        this.wait -= dt;
      } else {
        this.t += (this.speed / len) * this.dir * dt;
        if (this.t >= 1) {
          this.t = 1;
          if (this.mode === 'auto') { this.dir = -1; this.wait = this.waitTime; }
          else if (this.mode === 'call') { this.active = false; this.wait = 0; }
          else this.dir = -1;
        } else if (this.t <= 0) {
          this.t = 0;
          if (this.mode === 'auto') { this.dir = 1; this.wait = this.waitTime; }
          else if (this.mode === 'call') { this.active = false; }
        }
      }
    }

    this.x = U.lerp(this.ax, this.bx, this.t);
    this.y = U.lerp(this.ay, this.by, this.t);
    this.dx = this.x - px;
    this.dy = this.y - py;
  };

  Elevator.prototype.draw = function (ctx) {
    var x = this.x, y = this.y, w = this.w, h = this.h;
    /* shaft guide */
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 8]);
    ctx.beginPath();
    ctx.moveTo(this.ax + w / 2, this.ay + h / 2);
    ctx.lineTo(this.bx + w / 2, this.by + h / 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = '#39405a';
    U.roundRect(ctx, x, y, w, h, 3); ctx.fill();
    ctx.fillStyle = '#525b7d';
    ctx.fillRect(x, y, w, 4);
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    for (var i = 6; i < w - 4; i += 12) ctx.fillRect(x + i, y + 6, 6, 3);

    /* status lamp */
    var on = this.mode === 'auto' ? true : this.active;
    ctx.fillStyle = on ? '#57e07a' : '#ffc23c';
    ctx.beginPath();
    ctx.arc(x + w - 7, y + h - 5, 3, 0, 6.2832);
    ctx.fill();
  };

  /* ==================================================================
     BREAKABLE GLASS
     ================================================================== */
  function Glass(o) {
    this.kind = 'glass';
    this.x = o.x; this.y = o.y; this.w = o.w; this.h = o.h;
    this.broken = false;
    this.cracks = 0;
    this.tint = o.tint || '#7fd8e8';
  }

  Glass.prototype.hit = function (world, vx, vy) {
    this.cracks++;
    Sound.crack();
    if (this.cracks >= 2) this.shatter(world, vx, vy);
  };

  Glass.prototype.shatter = function (world, vx, vy) {
    if (this.broken) return;
    this.broken = true;
    Sound.glass();
    world.shake(4);
    var n = Math.min(70, Math.floor((this.w * this.h) / 120) + 12);
    for (var i = 0; i < n; i++) {
      world.fx.spawn({
        x: this.x + Math.random() * this.w,
        y: this.y + Math.random() * this.h,
        vx: U.rand(-140, 140) + (vx || 0) * 0.06,
        vy: U.rand(-220, 60) + (vy || 0) * 0.05,
        life: U.rand(0.7, 1.6), size: U.rand(2, 6),
        color: Math.random() < 0.3 ? '#ffffff' : this.tint,
        shape: 'shard', spin: U.rand(-14, 14), g: 1300, drag: 0.25, bounce: 0.25
      });
    }
    world.onGlassBroken(this);
  };

  Glass.prototype.draw = function (ctx, time) {
    if (this.broken) {
      ctx.strokeStyle = 'rgba(127,216,232,0.22)';
      ctx.lineWidth = 2;
      ctx.strokeRect(this.x + 1, this.y + 1, this.w - 2, this.h - 2);
      return;
    }
    var g = ctx.createLinearGradient(this.x, this.y, this.x + this.w, this.y + this.h);
    g.addColorStop(0, 'rgba(160,230,245,0.30)');
    g.addColorStop(0.5, 'rgba(120,200,220,0.16)');
    g.addColorStop(1, 'rgba(200,245,255,0.30)');
    ctx.fillStyle = g;
    ctx.fillRect(this.x, this.y, this.w, this.h);
    ctx.strokeStyle = 'rgba(190,240,255,0.55)';
    ctx.lineWidth = 2;
    ctx.strokeRect(this.x + 1, this.y + 1, this.w - 2, this.h - 2);

    /* sheen */
    ctx.save();
    ctx.beginPath(); ctx.rect(this.x, this.y, this.w, this.h); ctx.clip();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 6;
    var off = ((time * 20) % (this.w + this.h + 120)) - 60;
    ctx.beginPath();
    ctx.moveTo(this.x + off, this.y + this.h);
    ctx.lineTo(this.x + off + 40, this.y);
    ctx.stroke();
    ctx.restore();

    if (this.cracks > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1;
      var cx = this.x + this.w / 2, cy = this.y + this.h / 2;
      for (var i = 0; i < 7; i++) {
        var a = i * 0.9 + 0.3;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * this.w * 0.45, cy + Math.sin(a) * this.h * 0.45);
        ctx.stroke();
      }
    }
  };

  /* ==================================================================
     CRATE  (destructible, solid)
     ================================================================== */
  function Crate(o) {
    this.kind = 'crate';
    this.x = o.x; this.y = o.y; this.w = o.w || 34; this.h = o.h || 34;
    this.health = o.health || 45;
    this.broken = false;
    this.explosive = !!o.explosive;
  }
  Crate.prototype.damage = function (amount, world) {
    if (this.broken) return;
    this.health -= amount;
    if (this.health <= 0) this.destroy(world);
    else {
      world.fx.burst(this.x + this.w / 2, this.y + this.h / 2, 5, {
        colors: ['#b98a4e', '#8a6534'], speedMax: 150, lifeMax: 0.4
      });
    }
  };
  Crate.prototype.destroy = function (world) {
    if (this.broken) return;
    this.broken = true;
    world.fx.burst(this.x + this.w / 2, this.y + this.h / 2, 20, {
      colors: ['#b98a4e', '#8a6534', '#d4a566'], speedMax: 260, lifeMax: 0.9, sizeMax: 6, bounce: 0.3
    });
    Sound.thud();
    if (this.explosive) world.explode(this.x + this.w / 2, this.y + this.h / 2, 130, 70, 700, 'world');
  };
  Crate.prototype.draw = function (ctx) {
    if (this.broken) return;
    ctx.fillStyle = this.explosive ? '#8a4030' : '#8a6534';
    ctx.fillRect(this.x, this.y, this.w, this.h);
    ctx.fillStyle = this.explosive ? '#b9553e' : '#b98a4e';
    ctx.fillRect(this.x + 3, this.y + 3, this.w - 6, this.h - 6);
    ctx.strokeStyle = 'rgba(0,0,0,.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(this.x + 3, this.y + 3); ctx.lineTo(this.x + this.w - 3, this.y + this.h - 3);
    ctx.moveTo(this.x + this.w - 3, this.y + 3); ctx.lineTo(this.x + 3, this.y + this.h - 3);
    ctx.stroke();
    if (this.explosive) {
      ctx.fillStyle = '#ffc23c';
      ctx.font = 'bold 13px monospace';
      ctx.textAlign = 'center';
      ctx.fillText('!', this.x + this.w / 2, this.y + this.h / 2 + 5);
    }
  };

  /* ==================================================================
     HAZARDS
     ================================================================== */
  function Hazard(o) {
    this.kind = 'hazard';
    this.type = o.type || 'spike';
    this.x = o.x; this.y = o.y; this.w = o.w; this.h = o.h;
    this.ax = o.x; this.ay = o.y;
    this.bx = o.bx != null ? o.bx : o.x;
    this.by = o.by != null ? o.by : o.y;
    this.speed = o.speed || 110;
    this.t = 0; this.dir = 1;
    this.rot = 0;
    this.moves = (this.bx !== this.ax || this.by !== this.ay);
  }
  /* Slightly inset so you die to the blade, not to the air beside it. */
  Hazard.prototype.hitbox = function () {
    if (this.type === 'saw') return { x: this.x + 8, y: this.y + 8, w: this.w - 16, h: this.h - 16 };
    if (this.type === 'spike') return { x: this.x + 2, y: this.y + 8, w: this.w - 4, h: this.h - 8 };
    return { x: this.x, y: this.y, w: this.w, h: this.h };
  };

  Hazard.prototype.update = function (dt) {
    this.rot += dt * 9;
    if (!this.moves) return;
    var len = U.dist(this.ax, this.ay, this.bx, this.by) || 1;
    this.t += (this.speed / len) * this.dir * dt;
    if (this.t > 1) { this.t = 1; this.dir = -1; }
    if (this.t < 0) { this.t = 0; this.dir = 1; }
    this.x = U.lerp(this.ax, this.bx, this.t);
    this.y = U.lerp(this.ay, this.by, this.t);
  };
  Hazard.prototype.draw = function (ctx, time) {
    var x = this.x, y = this.y, w = this.w, h = this.h;
    if (this.type === 'spike') {
      ctx.fillStyle = '#9aa1b8';
      var n = Math.max(1, Math.floor(w / 12));
      var sw = w / n;
      for (var i = 0; i < n; i++) {
        ctx.beginPath();
        ctx.moveTo(x + i * sw, y + h);
        ctx.lineTo(x + i * sw + sw / 2, y);
        ctx.lineTo(x + (i + 1) * sw, y + h);
        ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = '#5d6478';
      ctx.fillRect(x, y + h - 4, w, 4);
    } else if (this.type === 'lava') {
      var g = ctx.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, '#ff8a3c'); g.addColorStop(1, '#a21b12');
      ctx.fillStyle = g;
      ctx.fillRect(x, y + 4, w, h - 4);
      ctx.fillStyle = '#ffd15c';
      for (var k = 0; k < w; k += 8) {
        ctx.fillRect(x + k, y + 3 + Math.sin(time * 3 + k * 0.25) * 3, 8, 4);
      }
    } else if (this.type === 'saw') {
      var cx = x + w / 2, cy = y + h / 2, r = w / 2;
      ctx.save();
      ctx.translate(cx, cy); ctx.rotate(this.rot);
      ctx.fillStyle = '#c3c9db';
      ctx.beginPath();
      for (var t = 0; t < 12; t++) {
        var a0 = (t / 12) * 6.2832, a1 = ((t + 0.5) / 12) * 6.2832;
        ctx.lineTo(Math.cos(a0) * r, Math.sin(a0) * r);
        ctx.lineTo(Math.cos(a1) * r * 0.74, Math.sin(a1) * r * 0.74);
      }
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#6e768e';
      ctx.beginPath(); ctx.arc(0, 0, r * 0.3, 0, 6.2832); ctx.fill();
      ctx.restore();
    }
  };

  /* ==================================================================
     PICKUPS (weapons + medkits)
     ================================================================== */
  function Pickup(x, y, key, ammo) {
    this.kind = 'pickup';
    this.w = 30; this.h = 20;
    this.x = x - 15; this.y = y - 10;
    this.key = key;                 /* weapon key or 'medkit' */
    this.ammo = ammo;
    this.vx = 0; this.vy = 0;
    this.taken = false;
    this.bob = Math.random() * 6.28;
    this.cooldown = 0;
    this.grounded = false;
  }
  Pickup.prototype.update = function (dt, world) {
    this.bob += dt * 3;
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.grounded && Math.abs(this.vx) < 4 && Math.abs(this.vy) < 4) return;
    this.vy += GRAV * 0.75 * dt;
    if (this.grounded) this.vx *= U.damp(7, dt);
    moveAndCollide(this, this.vx * dt, this.vy * dt, world);
    if (this.y > world.level.height + 300) this.taken = true;
  };
  Pickup.prototype.draw = function (ctx) {
    var yy = this.y + (this.grounded ? Math.sin(this.bob) * 2 : 0);
    ctx.save();
    ctx.translate(this.x + this.w / 2, yy + this.h / 2);
    /* glow - pickups have to read at a glance across a busy screen */
    var pulse = 0.5 + Math.sin(this.bob) * 0.5;
    var gl = ctx.createRadialGradient(0, 0, 2, 0, 0, 26);
    gl.addColorStop(0, 'rgba(255,205,90,' + (0.34 + pulse * 0.16) + ')');
    gl.addColorStop(1, 'rgba(255,194,60,0)');
    ctx.fillStyle = gl;
    ctx.beginPath(); ctx.arc(0, 0, 26, 0, 6.2832); ctx.fill();

    if (this.key === 'medkit') {
      ctx.fillStyle = '#f2efe6';
      U.roundRect(ctx, -11, -8, 22, 16, 3); ctx.fill();
      ctx.fillStyle = '#ff4d5e';
      ctx.fillRect(-2, -5, 4, 10);
      ctx.fillRect(-6, -2, 12, 4);
    } else {
      var def = WEAPONS[this.key];
      ctx.fillStyle = def.body;
      ctx.fillRect(-def.barrel / 2, -3, def.barrel, 6);
      ctx.fillStyle = '#20232f';
      ctx.fillRect(-def.barrel / 2 + 3, 2, 6, 6);
      if (def.explosive) { ctx.fillStyle = '#ff6a4d'; ctx.fillRect(def.barrel / 2 - 5, -4, 5, 8); }
      if (def.teleport) { ctx.fillStyle = '#49e0e8'; ctx.fillRect(def.barrel / 2 - 5, -4, 5, 8); }
    }
    ctx.restore();
  };

  /* ==================================================================
     BUTTON  (wall switch or floor plate) -> opens doors / calls lifts
     ================================================================== */
  function Button(o) {
    this.kind = 'button';
    this.x = o.x; this.y = o.y; this.w = o.w || 22; this.h = o.h || 22;
    this.target = o.target;
    this.plate = !!o.plate;       /* stepped on instead of pressed */
    this.once = o.once !== false;
    this.on = false;
    this.flash = 0;
  }
  Button.prototype.activate = function (world) {
    if (this.on && this.once) return;
    this.on = true;
    this.flash = 1;
    Sound.click();
    world.fireTarget(this.target);
  };
  Button.prototype.update = function (dt, world) {
    this.flash = Math.max(0, this.flash - dt * 2);
    if (this.plate) {
      var p = world.player;
      var box = { x: this.x, y: this.y - 4, w: this.w, h: this.h + 8 };
      if (U.aabb(p, box)) { if (!this.on) this.activate(world); }
      else if (!this.once) this.on = false;
    }
  };
  Button.prototype.draw = function (ctx) {
    if (this.plate) {
      ctx.fillStyle = '#2a3048';
      ctx.fillRect(this.x, this.y + (this.on ? 5 : 0), this.w, this.h - (this.on ? 5 : 0));
      ctx.fillStyle = this.on ? '#57e07a' : '#ffc23c';
      ctx.fillRect(this.x + 3, this.y + (this.on ? 5 : 0) + 2, this.w - 6, 4);
    } else {
      ctx.fillStyle = '#2a3048';
      U.roundRect(ctx, this.x, this.y, this.w, this.h, 4); ctx.fill();
      ctx.fillStyle = this.on ? '#57e07a' : '#ff4d5e';
      ctx.beginPath();
      ctx.arc(this.x + this.w / 2, this.y + this.h / 2, 6 + this.flash * 3, 0, 6.2832);
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.25)';
      ctx.lineWidth = 2;
      U.roundRect(ctx, this.x, this.y, this.w, this.h, 4); ctx.stroke();
    }
  };

  /* ==================================================================
     DOOR  (solid until opened)
     ================================================================== */
  function Door(o) {
    this.kind = 'door';
    this.x = o.x; this.y = o.y; this.w = o.w; this.h = o.h;
    this.ox = o.x; this.oy = o.y;
    this.id = o.id;
    this.open = false;
    this.t = 0;
    this.slide = o.slide || 'up';   /* up | down | left | right */
  }
  Door.prototype.fire = function () { this.open = true; Sound.ding(); };
  Door.prototype.update = function (dt) {
    this.t = U.approach(this.t, this.open ? 1 : 0, dt * 1.4);
    var d = this.t * (this.slide === 'left' || this.slide === 'right' ? this.w : this.h) * 0.98;
    this.x = this.ox + (this.slide === 'left' ? -d : this.slide === 'right' ? d : 0);
    this.y = this.oy + (this.slide === 'up' ? -d : this.slide === 'down' ? d : 0);
  };
  Door.prototype.draw = function (ctx) {
    ctx.save();
    ctx.fillStyle = '#4a5270';
    ctx.fillRect(this.x, this.y, this.w, this.h);
    ctx.fillStyle = '#5d6889';
    ctx.fillRect(this.x + 3, this.y + 3, this.w - 6, this.h - 6);
    ctx.fillStyle = 'rgba(0,0,0,.3)';
    for (var i = 8; i < this.h - 6; i += 14) ctx.fillRect(this.x + 4, this.y + i, this.w - 8, 5);
    ctx.strokeStyle = this.open ? '#57e07a' : '#ffc23c';
    ctx.lineWidth = 2;
    ctx.strokeRect(this.x + 1, this.y + 1, this.w - 2, this.h - 2);
    ctx.restore();
  };

  /* ==================================================================
     CHECKPOINT + GOAL
     ================================================================== */
  function Checkpoint(o) {
    this.kind = 'checkpoint';
    this.x = o.x - 10; this.y = o.y - 46; this.w = 20; this.h = 46;
    this.on = false;
    this.wave = 0;
  }
  Checkpoint.prototype.update = function (dt, world) {
    this.wave += dt * 4;
    if (!this.on && U.aabb(world.player, this)) {
      this.on = true;
      world.setCheckpoint(this.x + this.w / 2, this.y + this.h);
      Sound.checkpoint();
      world.toast('CHECKPOINT');
      world.fx.burst(this.x + 10, this.y + 10, 18, {
        colors: ['#57e07a', '#a8f4b8'], speedMax: 200, lifeMax: 0.7
      });
    }
  };
  Checkpoint.prototype.draw = function (ctx) {
    ctx.fillStyle = '#3a4159';
    ctx.fillRect(this.x + 8, this.y, 4, this.h);
    ctx.fillStyle = this.on ? '#57e07a' : '#8a90a8';
    ctx.beginPath();
    ctx.moveTo(this.x + 12, this.y + 2);
    for (var i = 0; i <= 6; i++) {
      var f = i / 6;
      ctx.lineTo(this.x + 12 + f * 24, this.y + 2 + Math.sin(this.wave + f * 3) * 3 * (this.on ? 1 : 0.2) + f * 0);
    }
    for (var j = 6; j >= 0; j--) {
      var f2 = j / 6;
      ctx.lineTo(this.x + 12 + f2 * 24, this.y + 20 + Math.sin(this.wave + f2 * 3) * 3 * (this.on ? 1 : 0.2));
    }
    ctx.closePath();
    ctx.fill();
  };

  function Goal(o) {
    this.kind = 'goal';
    this.x = o.x; this.y = o.y; this.w = o.w || 96; this.h = o.h || 68;
    this.t = 0;
  }
  Goal.prototype.update = function (dt) { this.t += dt; };
  Goal.prototype.draw = function (ctx) {
    var x = this.x, y = this.y, w = this.w, h = this.h;
    var bob = Math.sin(this.t * 3) * 1.5;

    /* getaway van */
    ctx.fillStyle = '#ffc23c';
    U.roundRect(ctx, x, y + 10 + bob, w, h - 22, 6); ctx.fill();
    ctx.fillStyle = '#e0a52c';
    U.roundRect(ctx, x + w * 0.55, y + bob, w * 0.45, h - 12, 6); ctx.fill();
    ctx.fillStyle = '#2b3145';
    U.roundRect(ctx, x + w * 0.62, y + 6 + bob, w * 0.3, 18, 3); ctx.fill();
    ctx.fillStyle = '#1a1d28';
    ctx.beginPath(); ctx.arc(x + w * 0.22, y + h - 10 + bob, 10, 0, 6.2832); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w * 0.8, y + h - 10 + bob, 10, 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#50586f';
    ctx.beginPath(); ctx.arc(x + w * 0.22, y + h - 10 + bob, 4, 0, 6.2832); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w * 0.8, y + h - 10 + bob, 4, 0, 6.2832); ctx.fill();

    /* arrow + label */
    var a = Math.sin(this.t * 4) * 4;
    ctx.fillStyle = '#57e07a';
    ctx.beginPath();
    ctx.moveTo(x + w / 2 - 10, y - 26 + a);
    ctx.lineTo(x + w / 2 + 10, y - 26 + a);
    ctx.lineTo(x + w / 2, y - 12 + a);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f2efe6';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('ESCAPE', x + w / 2, y - 32 + a);
  };

  root.moveAndCollide = moveAndCollide;
  root.Player = Player;
  root.Enemy = Enemy;
  root.Elevator = Elevator;
  root.Glass = Glass;
  root.Crate = Crate;
  root.Hazard = Hazard;
  root.Pickup = Pickup;
  root.Button = Button;
  root.Door = Door;
  root.Checkpoint = Checkpoint;
  root.Goal = Goal;
  root.GRAV = GRAV;
})(window);
