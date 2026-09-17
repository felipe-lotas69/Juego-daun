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
          var soft = !!(s.ref && s.ref.dynamic && !s.ref.broken);
          if (soft) e.vx *= 0.55;                      /* lean into it and keep shoving */
          else if (Math.abs(e.vx) > 260 && e.bouncy) e.vx = -e.vx * 0.36;
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

  /* What happens when a player runs into something that is not just wall.
     Skipped during bot planning: a rollout must not shatter real glass or
     shove real crates around. */
  function playerContact(e, sd, axis, world) {
    if (e.quietSim) return true;
    var ref = sd.ref;
    if (!ref) return true;

    if (ref.kind === 'glass' && !ref.broken) {
      var sp = axis === 'x' ? Math.abs(e.vx) : Math.abs(e.vy);
      if (sp > 300) {
        ref.shatter(world, e.vx, e.vy);
        world.shake(3.5);
        if (axis === 'x') e.vx *= 0.82; else e.vy *= 0.82;
        return false;                       /* straight through it */
      }
    }

    if (ref.dynamic && !ref.broken) {
      if (axis === 'x') {
        ref.vx += U.clamp(e.vx * 0.95, -520, 520);
        ref.vy -= 30;
        ref.settle = 0;
      } else if (axis === 'y' && e.vy > 320) {
        ref.damage(e.vy * 0.05, world, e);
      }
    }
    return true;
  }

  /* ==================================================================
     PLAYER
     ================================================================== */
  var MAX_LEAN_GROUND = 1.2;
  var MAX_LEAN_AIR = 1.45;

  /* one suit per slot, so four of them on screen stay tellable apart */
  var PALETTES = [
    { name: 'BLUE',   suit: '#3b4370', suit2: '#2b3157', tie: '#ff4d5e', mark: '#7c8ad6' },
    { name: 'GREEN',  suit: '#2f6b47', suit2: '#235036', tie: '#ffd15c', mark: '#57e07a' },
    { name: 'PURPLE', suit: '#67356e', suit2: '#4d2752', tie: '#7fe0ff', mark: '#c07ad6' },
    { name: 'AMBER',  suit: '#8a5524', suit2: '#68401b', tie: '#a8f4b8', mark: '#ffa23c' }
  ];

  function Player(x, y, opt) {
    opt = opt || {};
    this.index = opt.index || 0;
    this.palette = PALETTES[this.index % PALETTES.length];
    this.label = opt.name || ('P' + (this.index + 1));
    this.isBot = !!opt.isBot;
    this.personality = opt.personality || null;
    this.showTag = !!opt.showTag;
    this.checkpoint = { x: x, y: y };
    this.cpIndex = -1;
    this.finished = false;
    this.finishTime = 0;
    this.respawnTimer = 0;
    this.deaths = 0;
    this.frags = 0;
    this.wins = 0;
    this.deathCause = null;
    this.prompt = null;
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
    this.emptyTimer = 0;
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

  Player.prototype.muzzle = function (overrideAngle) {
    var c = this.center();
    var a = overrideAngle == null ? this.aim() : overrideAngle;
    var len = this.weapon ? WEAPONS[this.weapon.key].barrel + 8 : 14;
    return { x: c.x + Math.cos(a) * len, y: c.y + Math.sin(a) * len };
  };

  Player.prototype.onLand = function (vy, s, world) {
    if (this.quietSim) return;
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
    if (this.quietSim) return;
    Sound.jump();
    world.fx.burst(this.x + this.w / 2, this.y + this.h, 12, {
      angle: -Math.PI / 2, spread: 1.0, colors: ['#49e0e8', '#a8f4ff'], speedMax: 260, lifeMax: 0.5
    });
  };

  Player.prototype.update = function (dt, world, input, quiet) {
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

    if (this.emptyTimer > 0) {
      this.emptyTimer -= dt;
      if (this.emptyTimer <= 0 && this.weapon && this.weapon.ammo <= 0) this.weapon = null;
    }

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
          if (!quiet) world.fx.burst(this.x + this.w / 2, this.y + this.h / 2, 8, {
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
      if (!quiet) {
        Sound.jump();
        world.fx.burst(this.x + this.w / 2, this.y + this.h, 10, {
          angle: -Math.PI / 2, spread: 1.3, colors: ['#cfd3e2', '#8b90a4'],
          speedMax: 190, lifeMax: 0.45, sizeMax: 4
        });
      }
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
      if (!quiet) {
        Sound.hop();
        world.fx.burst(this.x + this.w / 2 - dir * 6, this.y + this.h, 4, {
          angle: dir > 0 ? Math.PI : 0, spread: 0.8, colors: ['#8b90a4', '#5d6275'],
          speedMax: 110, lifeMax: 0.3, sizeMax: 3
        });
      }
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
    moveAndCollide(this, this.vx * dt, this.vy * dt, world, playerContact);

    if (quiet) return;

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
    /* Humans get the assist; bots have their own accuracy model and would
       become dead-eyed if they got this too. */
    var angle = this.aim();
    if (!this.isBot && this.aimTarget) {
      var mc = this.center();
      angle = Math.atan2(this.aimTarget.y - mc.y, this.aimTarget.x - mc.x);
    }
    var m = this.muzzle(angle);
    var kick = fireWeapon(world, this, this.weapon.key, angle, m.x, m.y, 'player');
    this.weapon.ammo--;
    this.cooldown = def.rate;
    this.muzzleFlash = 1;
    if (kick) {
      this.vx = U.clamp(this.vx + kick.fx, -900, 900);
      this.vy = U.clamp(this.vy + kick.fy, -900, 900);
      if (kick.fy < -20) this.grounded = false;
    }
    if (this.weapon.ammo <= 0) {
      this.emptyTimer = 0.45;
      if (this === world.localPlayer()) world.toast('OUT OF AMMO');
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
    this.emptyTimer = 0;
    if (this === world.localPlayer()) world.toast('DROPPED');
  };

  Player.prototype.takeWeapon = function (key, ammo, world) {
    if (this.weapon) this.dropWeapon(world);
    this.weapon = { key: key, ammo: ammo };
    this.emptyTimer = 0;
    if (this === world.localPlayer()) { Sound.pickup(); world.toast(WEAPONS[key].name); }
  };

  Player.prototype.damage = function (amount, kx, ky, world, attacker) {
    if (this.dead || this.invuln > 0) return;
    this.lastAttacker = attacker || null;
    this.health -= amount;
    this.vx += kx; this.vy += ky;
    this.invuln = 0.5;
    this.hurtFlash = 1;
    this.stumble = Math.max(this.stumble, 0.2);
    world.shake(4);
    if (world.gore) {
      world.gore.splash(this.x + this.w / 2, this.y + this.h * 0.45,
                        4 + Math.min(14, amount * 0.35), U.sign(kx) || 0, -0.5, 1);
    }
    world.fx.burst(this.x + this.w / 2, this.y + this.h / 2, 6, {
      colors: ['#ff4d5e', '#c11627'], speedMax: 200, lifeMax: 0.4
    });
    if (this.health <= 0) this.kill(world, 'shot');
    else Sound.hurt();
  };

  Player.prototype.kill = function (world, cause) {
    if (this.dead) return;
    this.dead = true;
    this.deadTimer = 0;
    this.deaths++;
    this.health = 0;
    this.deathCause = cause || 'killed';
    Sound.die();
    world.shake(cause === 'crushed' ? 13 : 9);
    if (world.gore) {
      var force = cause === 'crushed' ? 0.55 : (cause === 'blast' ? 1.7 : 1);
      world.gore.gib(this.x + this.w / 2, this.y + this.h / 2,
                     cause === 'crushed' ? U.rand(-160, 160) : this.vx,
                     cause === 'crushed' ? -40 : this.vy,
                     this.palette, force);
      if (cause === 'crushed') world.gore.pool(this.x + this.w / 2, this.y + this.h, 13);
    }
    world.fx.burst(this.x + this.w / 2, this.y + this.h / 2, 16, {
      colors: ['#c11627', '#8c0f1c'], speedMax: 300, lifeMax: 0.8, sizeMax: 5, bounce: 0.3
    });
    if (world.onPlayerDied) world.onPlayerDied(this, cause);
  };

  Player.prototype.draw = function (ctx) {
    /* Flicker by skipping frames rather than fading: an alpha ramp reads as
       a smudge once the whole picture is three pixels to the unit. */
    if (this.invuln > 0 && Math.floor(this.invuln * 18) % 2 === 0) return;

    var P = Pixel.SIZE;
    var cx = Pixel.s(this.x + this.w / 2);
    var feet = Pixel.s(this.y + this.h);
    var hurt = this.hurtFlash > 0;
    var skin = hurt ? '#ffd6d6' : '#f2cfa2';
    var suit = hurt ? '#ff8f9a' : this.palette.suit;
    var suit2 = hurt ? '#ff7b88' : this.palette.suit2;
    var dark = '#20232f';

    ctx.save();
    ctx.translate(cx, feet);
    ctx.rotate(this.angle);

    var swing = this.grounded && Math.sin(this.stepPhase * 1.7) > 0 ? P : 0;

    /* legs */
    ctx.fillStyle = suit2;
    ctx.fillRect(-9, -15 + swing, 6, 15 - swing);
    ctx.fillRect(3, -15, 6, 15 - swing);
    ctx.fillStyle = dark;
    ctx.fillRect(-9, -3, 6, 3);
    ctx.fillRect(3, -3 - swing, 6, 3);

    /* torso and tie */
    ctx.fillStyle = suit;
    ctx.fillRect(-9, -30, 18, 15);
    ctx.fillStyle = this.palette.tie;
    ctx.fillRect(-3, -30, 3, 9);

    /* head, hair, one pixel of eye */
    ctx.fillStyle = skin;
    ctx.fillRect(-9, -45, 18, 15);
    ctx.fillStyle = dark;
    ctx.fillRect(-9, -45, 18, 6);
    ctx.fillRect(this.facing === 1 ? 3 : -6, -36, 3, 3);
    ctx.restore();

    /* arm and weapon ride the aim line */
    var c = this.center();
    var aim = this.aim();
    ctx.save();
    ctx.translate(Pixel.s(c.x), Pixel.s(c.y));
    ctx.rotate(aim);
    ctx.fillStyle = skin;
    ctx.fillRect(0, -3, this.weapon ? 12 : 9, 3);

    if (this.weapon) {
      var def = WEAPONS[this.weapon.key];
      ctx.fillStyle = def.body;
      ctx.fillRect(6, -6, def.barrel, 6);
      ctx.fillStyle = dark;
      ctx.fillRect(9, 0, 6, 6);
      if (def.explosive) { ctx.fillStyle = '#ff6a4d'; ctx.fillRect(def.barrel, -6, 6, 6); }
      if (def.teleport) { ctx.fillStyle = '#49e0e8'; ctx.fillRect(def.barrel, -6, 6, 6); }
      if (this.muzzleFlash > 0.25) {
        ctx.fillStyle = '#fff3c4';
        ctx.fillRect(def.barrel + 6, -6, 9, 6);
        ctx.fillRect(def.barrel + 12, -3, 6, 3);
      }
    }
    ctx.restore();

    if (this.showTag) {
      var tw = Pixel.textWidth(this.label, P);
      var ty = Pixel.s(this.y - P * 7);
      Pixel.rect(ctx, cx - tw / 2 - P, ty - P, tw + P * 2, P * 7, 'rgba(12,24,34,0.55)');
      Pixel.rect(ctx, cx - tw / 2 - P, ty - P, P, P * 7, this.palette.mark);
      Pixel.text(ctx, this.label, cx, ty, P, '#ffffff', 'center');
    }
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

    var c = this.center();
    var p = world.nearestPlayer(c.x, c.y, true);
    if (!p) { this.alert = Math.max(0, this.alert - dt); }
    var pc = p ? p.center() : { x: c.x, y: c.y };
    var d = p ? U.dist(c.x, c.y, pc.x, pc.y) : 1e9;
    var canSee = !!p && !p.dead && d < 620 && world.lineOfSight(c.x, c.y, pc.x, pc.y);

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
    if (world.gore) {
      world.gore.splash(this.x + this.w / 2, this.y + this.h * 0.4, 18, U.sign(kx || 1), -0.6, 1.2);
      world.gore.pool(this.x + this.w / 2, this.y + this.h, 10);
    }
    world.fx.burst(this.x + this.w / 2, this.y + this.h / 2, 12, {
      colors: ['#c11627', '#8c0f1c'], speedMax: 280, lifeMax: 0.8, sizeMax: 5, bounce: 0.25
    });
    world.onEnemyKilled(this);
    if (this.drops) {
      var pk = new Pickup(this.x + this.w / 2, this.y + 10, this.weaponKey, Math.ceil(WEAPONS[this.weaponKey].ammo * 0.55));
      pk.vx = U.rand(-120, 120); pk.vy = -220; pk.cooldown = 0.35;
      world.pickups.push(pk);
    }
  };

  Enemy.prototype.draw = function (ctx) {
    var cx = Pixel.s(this.x + this.w / 2), feet = Pixel.s(this.y + this.h);
    var hurt = this.hurtFlash > 0;
    var suit = hurt ? '#ffa0a8' : '#6b3a4a';
    var suit2 = hurt ? '#ff8f9a' : '#542d3a';
    var dark = '#20232f';
    var P = Pixel.SIZE;

    ctx.save();
    if (this.dead) ctx.globalAlpha = U.clamp(1 - (this.deathTimer - 3) / 1.5, 0, 1);
    ctx.translate(cx, feet);
    ctx.rotate(this.angle);

    var swing = this.grounded && Math.sin(this.stepPhase * 1.7) > 0 ? P : 0;
    ctx.fillStyle = suit2;
    ctx.fillRect(-9, -15 + swing, 6, 15 - swing);
    ctx.fillRect(3, -15, 6, 15 - swing);
    ctx.fillStyle = dark;
    ctx.fillRect(-9, -3, 6, 3);
    ctx.fillRect(3, -3 - swing, 6, 3);

    ctx.fillStyle = suit;
    ctx.fillRect(-9, -30, 18, 15);
    ctx.fillStyle = hurt ? '#ffd6d6' : '#d8a87e';
    ctx.fillRect(-9, -45, 18, 15);
    ctx.fillStyle = dark;
    ctx.fillRect(-12, -45, 24, 6);          /* cap with a brim */
    ctx.fillRect(this.facing === 1 ? 3 : -6, -36, 3, 3);
    ctx.restore();

    if (!this.dead) {
      var c = this.center();
      ctx.save();
      ctx.translate(Pixel.s(c.x), Pixel.s(c.y));
      ctx.rotate(this.aimAngle);
      ctx.fillStyle = '#d8a87e';
      ctx.fillRect(0, -3, 12, 3);
      var def = WEAPONS[this.weaponKey];
      ctx.fillStyle = def.body;
      ctx.fillRect(6, -6, def.barrel, 6);
      ctx.restore();

      if (this.alert > 0 && Math.floor(this.alert * 6) % 2) {
        Pixel.text(ctx, '!', cx, this.y - 18, P * 2, '#ff4d5e', 'center');
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
    /* a piston: it does not push you aside, it goes through you */
    this.crusher = !!o.crusher;
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

  /* Seconds until this car is back at its low end - what you need to know
     before stepping under a piston. */
  Elevator.prototype.timeToLow = function () {
    var lowT = (this.by > this.ay) ? 1 : 0;
    var travel = (this.len() || 1) / Math.max(1, this.speed);
    if (Math.abs(this.t - lowT) < 0.002) return 0;
    var towardLow = (lowT === 1) ? (this.dir > 0) : (this.dir < 0);
    if (towardLow && this.active) return this.wait + Math.abs(lowT - this.t) * travel;
    var highT = 1 - lowT;
    return this.wait + Math.abs(highT - this.t) * travel + this.waitTime + travel;
  };

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
      moving = world.anyPlayer(function (p) {
        return p.grounded && p.groundRef && p.groundRef.ref === this;
      }, this);
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
    var x = Pixel.s(this.x), y = Pixel.s(this.y), w = this.w, h = this.h;
    var P = Pixel.SIZE;

    /* the shaft, as a dotted run of blocks */
    var ax = this.ax + w / 2, ay = this.ay + h / 2;
    var bx = this.bx + w / 2, by = this.by + h / 2;
    var steps = Math.max(1, Math.round(U.dist(ax, ay, bx, by) / (P * 5)));
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      Pixel.rect(ctx, U.lerp(ax, bx, t) - P, U.lerp(ay, by, t) - P, P * 2, P * 2,
                 'rgba(255,255,255,0.13)');
    }

    if (this.crusher) {
      Pixel.rect(ctx, x, y, w, h, '#4a3436');
      Pixel.rect(ctx, x, y, w, P * 2, '#7a5457');
      /* hazard stripes and a row of teeth */
      for (var s2 = 0; s2 < w - P * 3; s2 += P * 6) {
        Pixel.rect(ctx, x + s2 + P, y + P * 3, P * 3, P, '#ffc23c');
      }
      for (var t2 = 0; t2 < w - P; t2 += P * 4) {
        Pixel.rect(ctx, x + t2, y + h - P * 2, P * 2, P * 2, '#20232f');
        Pixel.rect(ctx, x + t2 + P * 2, y + h - P, P * 2, P, '#20232f');
      }
      return;
    }

    Pixel.rect(ctx, x, y, w, h, '#8d94a0');
    Pixel.rect(ctx, x, y, w, P, '#c9ced6');
    Pixel.rect(ctx, x, y + h - P, w, P, '#5d636d');
    for (var d = P * 2; d < w - P * 2; d += P * 4) {
      Pixel.rect(ctx, x + d, y + P * 2, P * 2, P, '#5d636d');
    }
    Pixel.rect(ctx, x + w - P * 3, y + h - P * 3, P * 2, P * 2,
               (this.mode === 'auto' || this.active) ? '#57e07a' : '#ffc23c');
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
    var P = Pixel.SIZE;
    if (this.broken) {
      Pixel.rect(ctx, this.x, this.y, this.w, P, 'rgba(180,235,250,0.30)');
      return;
    }
    Pixel.rect(ctx, this.x, this.y, this.w, this.h, 'rgba(190,238,250,0.42)');
    Pixel.rect(ctx, this.x, this.y, this.w, P, 'rgba(255,255,255,0.75)');
    /* a couple of blocks of glare, stepped across the pane */
    var off = Math.floor((time * 8) % Math.max(1, (this.w / P) + 6)) * P;
    for (var i = 0; i < 3; i++) {
      var gx = this.x + off - i * P * 2;
      if (gx > this.x && gx < this.x + this.w - P) {
        Pixel.rect(ctx, gx, this.y + i * P, P, P, 'rgba(255,255,255,0.55)');
      }
    }
    if (this.cracks > 0) {
      var cx = this.x + this.w / 2, cy = this.y + this.h / 2;
      for (var k = 0; k < 6; k++) {
        var a = k * 1.05 + 0.4;
        for (var r = P; r < Math.min(this.w, this.h * 3) * 0.45; r += P) {
          Pixel.rect(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r * 0.5, P, P, 'rgba(255,255,255,0.8)');
        }
      }
    }
  };

  /* ==================================================================
     PROP - crates and gas barrels

     These are solid like scenery but they fall, get shoved around, take
     damage and go off. A barrel lights a short fuse rather than vanishing
     instantly, which is what makes a chain of them readable.
     ================================================================== */
  function Prop(o) {
    this.kind = 'prop';
    this.type = o.type || (o.explosive ? 'barrel' : 'crate');
    this.dynamic = true;
    this.w = o.w || (this.type === 'barrel' ? 24 : 30);
    this.h = o.h || (this.type === 'barrel' ? 33 : 30);
    this.x = o.x; this.y = o.y;
    this.vx = 0; this.vy = 0;
    this.grounded = false;
    this.groundRef = null;
    this.health = o.health || (this.type === 'barrel' ? 26 : 50);
    this.maxHealth = this.health;
    this.broken = false;
    this.fuse = 0;
    this.litBy = null;
    this.hitFlash = 0;
    this.roll = 0;
    this.settle = 0;
  }

  Prop.prototype.center = function () { return { x: this.x + this.w / 2, y: this.y + this.h / 2 }; };

  Prop.prototype.update = function (dt, world) {
    if (this.broken) return;
    this.hitFlash = Math.max(0, this.hitFlash - dt * 4);

    if (this.fuse > 0) {
      this.fuse -= dt;
      if (this.fuse <= 0) { this.blowUp(world); return; }
    }

    /* asleep until something disturbs it */
    if (this.settle > 1.2 && this.grounded && !this.vx && !this.vy) return;

    this.vy += GRAV * dt;
    if (this.vy > MAX_FALL) this.vy = MAX_FALL;
    this.vx *= U.damp(this.grounded ? (this.type === 'barrel' ? 1.3 : 2.0) : 0.3, dt);
    if (Math.abs(this.vx) < 4) this.vx = 0;

    if (this.grounded && this.groundRef && (this.groundRef.dx || this.groundRef.dy)) {
      this.x += this.groundRef.dx;
      this.y += this.groundRef.dy;
    }

    var self = this;
    var preVy = this.vy;
    moveAndCollide(this, this.vx * dt, this.vy * dt, world, function (e, sd, axis) {
      if (sd.ref === self) return false;                 /* never collide with yourself */
      if (sd.ref && sd.ref.kind === 'glass' && !sd.ref.broken && Math.abs(preVy) > 520) {
        sd.ref.shatter(world, e.vx, e.vy);               /* heavy props go through glass */
        return false;
      }
      /* pass the shove down a row of them */
      if (sd.ref && sd.ref.dynamic && !sd.ref.broken && axis === 'x') {
        sd.ref.vx += e.vx * 0.7;
        sd.ref.settle = 0;
      }
      return true;
    });

    if (this.grounded) {
      this.settle += dt;
      if (preVy > 700) this.damage(preVy * 0.02, world, null);
    } else {
      this.settle = 0;
    }

    /* barrels roll, crates just sit there */
    if (this.type === 'barrel') this.roll += this.vx * dt * 0.06;

    /* a prop moving with intent knocks people over */
    if (Math.abs(this.vx) > 180 || Math.abs(this.vy) > 340) {
      for (var i = 0; i < world.players.length; i++) {
        var pl = world.players[i];
        if (pl.dead || pl.finished) continue;
        if (!U.aabb(this, pl)) continue;
        pl.damage(9, U.sign(this.vx) * 260, -140, world, null);
        this.vx *= 0.4;
      }
    }

    if (this.y > world.level.height + 200) this.broken = true;
  };

  Prop.prototype.damage = function (amount, world, by) {
    if (this.broken) return;
    this.health -= amount;
    this.hitFlash = 1;
    this.settle = 0;
    if (this.health > 0) {
      world.fx.burst(this.x + this.w / 2, this.y + this.h / 2, 4, {
        colors: this.type === 'barrel' ? ['#ffc23c', '#ff8a3c'] : ['#b98a4e', '#8a6534'],
        speedMax: 150, lifeMax: 0.35
      });
      return;
    }
    if (this.type === 'barrel') this.light(world, by);
    else this.smash(world);
  };

  /* Light the fuse. A beat of warning turns a chain into a spectacle
     instead of one indistinguishable bang. */
  Prop.prototype.light = function (world, by) {
    if (this.broken || this.fuse > 0) return;
    this.fuse = U.rand(0.16, 0.32);
    this.litBy = by || null;
    this.health = Math.min(this.health, 1);
    Sound.crack();
  };

  Prop.prototype.blowUp = function (world) {
    if (this.broken) return;
    this.broken = true;
    var c = this.center();
    world.fx.burst(c.x, c.y, 16, {
      colors: ['#8a5a2a', '#c4a24a'], speedMax: 260, lifeMax: 0.7, sizeMax: 5, bounce: 0.3
    });
    world.explode(c.x, c.y, 132, 58, 720, 'world', this.litBy);
  };

  Prop.prototype.smash = function (world) {
    if (this.broken) return;
    this.broken = true;
    var c = this.center();
    world.fx.burst(c.x, c.y, 22, {
      colors: ['#b98a4e', '#8a6534', '#d4a566'], speedMax: 280, lifeMax: 0.9, sizeMax: 6, bounce: 0.3
    });
    Sound.thud();
    world.shake(2.5);
  };

  Prop.prototype.draw = function (ctx) {
    if (this.broken) return;
    var P = Pixel.SIZE;
    var x = Pixel.s(this.x), y = Pixel.s(this.y), w = this.w, h = this.h;
    var flash = this.fuse > 0 && Math.floor(this.fuse * 26) % 2 === 0;

    if (this.type === 'barrel') {
      var body = flash ? '#ffffff' : (this.hitFlash > 0.4 ? '#ff9a6a' : '#c4432a');
      var band = flash ? '#ffe9a8' : '#8e2a18';
      Pixel.rect(ctx, x, y, w, h, body);
      Pixel.rect(ctx, x, y, w, P, band);
      Pixel.rect(ctx, x, y + h - P, w, P, band);
      Pixel.rect(ctx, x, y + P * 4, w, P, band);
      Pixel.rect(ctx, x, y + h - P * 5, w, P, band);
      /* hazard mark */
      Pixel.rect(ctx, x + P * 2, y + P * 6, P * 4, P * 3, flash ? '#c4432a' : '#ffc23c');
      /* a rim of light so it pops off the scenery */
      Pixel.rect(ctx, x, y + P, P, h - P * 2, flash ? '#ffffff' : '#e0644a');
      if (this.fuse > 0) {
        Pixel.rect(ctx, x + w / 2 - P, y - P * 2, P * 2, P * 2, '#fff3c4');
      }
    } else {
      var base = this.hitFlash > 0.4 ? '#d8b070' : '#8a6534';
      Pixel.rect(ctx, x, y, w, h, base);
      Pixel.rect(ctx, x + P, y + P, w - P * 2, h - P * 2, this.hitFlash > 0.4 ? '#f0d09a' : '#b98a4e');
      for (var i = 0; i < Math.floor(w / P) - 1; i++) {
        Pixel.rect(ctx, x + P + i * P, y + P + i * P, P, P, '#6d4e22');
        Pixel.rect(ctx, x + w - P * 2 - i * P, y + P + i * P, P, P, '#6d4e22');
      }
      /* damage shows as missing planks */
      if (this.health < this.maxHealth * 0.5) {
        Pixel.rect(ctx, x + P * 2, y + P * 2, P * 2, P * 2, '#5d4018');
        Pixel.rect(ctx, x + w - P * 4, y + h - P * 4, P * 2, P * 2, '#5d4018');
      }
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
    var x = Pixel.s(this.x), y = Pixel.s(this.y), w = this.w, h = this.h;
    var P = Pixel.SIZE;

    if (this.type === 'spike') {
      Pixel.rect(ctx, x, y + h - P * 2, w, P * 2, '#5d6478');
      var n = Math.max(1, Math.floor(w / (P * 4)));
      var sw = w / n;
      for (var i = 0; i < n; i++) {
        var bx = x + i * sw;
        /* stepped triangle: each row is narrower than the one below */
        for (var r = 0; r < 4; r++) {
          Pixel.rect(ctx, bx + r * P, y + h - P * 2 - (4 - r) * P, sw - r * P * 2, P, '#aab1c4');
        }
      }
    } else if (this.type === 'lava') {
      Pixel.rect(ctx, x, y + P * 2, w, h, '#c22f14');
      Pixel.rect(ctx, x, y + P * 2, w, P * 3, '#f0692a');
      for (var k = 0; k < w; k += P * 3) {
        var bob = Math.sin(time * 3 + k * 0.08) > 0 ? P : 0;
        Pixel.rect(ctx, x + k, y + bob, P * 3, P * 2, '#ffc23c');
      }
    } else if (this.type === 'saw') {
      var cx = x + w / 2, cy = y + h / 2, r0 = w / 2;
      Pixel.disc(ctx, cx, cy, r0 * 0.74, '#c3c9db');
      /* teeth snap to eight positions so the blade reads as spinning
         without smearing into a grey circle */
      var step = Math.floor(this.rot / (Math.PI / 8)) % 2 ? Math.PI / 16 : 0;
      for (var t = 0; t < 8; t++) {
        var a = step + (t / 8) * 6.2832;
        Pixel.rect(ctx, cx + Math.cos(a) * r0 * 0.84 - P, cy + Math.sin(a) * r0 * 0.84 - P,
                   P * 2, P * 2, '#e2e7f2');
      }
      Pixel.disc(ctx, cx, cy, r0 * 0.28, '#6e768e');
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
    var P = Pixel.SIZE;
    var bob = this.grounded && Math.sin(this.bob) > 0 ? -P : 0;
    var cx = Pixel.s(this.x + this.w / 2);
    var cy = Pixel.s(this.y + this.h / 2) + bob;

    /* A pool of light under the item and a couple of blinking sparks -
       a translucent square just reads as a smudge over the scenery. */
    var pulse = Math.sin(this.bob) > 0 ? P : 0;
    Pixel.rect(ctx, cx - P * 4, cy + P * 3, P * 8, P, 'rgba(255,226,120,0.85)');
    Pixel.rect(ctx, cx - P * 3, cy + P * 4, P * 6, P, 'rgba(255,205,90,0.45)');
    if (pulse) {
      Pixel.rect(ctx, cx - P * 6, cy - P * 2, P, P, 'rgba(255,255,210,0.9)');
      Pixel.rect(ctx, cx + P * 5, cy, P, P, 'rgba(255,255,210,0.9)');
    } else {
      Pixel.rect(ctx, cx + P * 6, cy - P * 3, P, P, 'rgba(255,255,210,0.9)');
      Pixel.rect(ctx, cx - P * 5, cy + P, P, P, 'rgba(255,255,210,0.9)');
    }

    ctx.save();
    ctx.translate(cx, cy);
    if (this.key === 'medkit') {
      Pixel.rect(ctx, -9, -6, 18, 12, '#f2efe6');
      Pixel.rect(ctx, -2, -4, 3, 9, '#ff4d5e');
      Pixel.rect(ctx, -6, -1, 12, 3, '#ff4d5e');
    } else {
      var def = WEAPONS[this.key];
      var bw = Pixel.s(def.barrel);
      Pixel.rect(ctx, -bw / 2, -3, bw, 6, def.body);
      Pixel.rect(ctx, -bw / 2 + 3, 3, 6, 6, '#20232f');
      if (def.explosive) Pixel.rect(ctx, bw / 2 - 6, -3, 6, 6, '#ff6a4d');
      if (def.teleport) Pixel.rect(ctx, bw / 2 - 6, -3, 6, 6, '#49e0e8');
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
      var box = { x: this.x, y: this.y - 4, w: this.w, h: this.h + 8 };
      var stood = world.anyPlayer(function (p) { return !p.dead && U.aabb(p, box); });
      if (stood) { if (!this.on) this.activate(world); }
      else if (!this.once) this.on = false;
    }
  };
  Button.prototype.draw = function (ctx) {
    var P = Pixel.SIZE;
    if (this.plate) {
      var drop = this.on ? P * 2 : 0;
      Pixel.rect(ctx, this.x, this.y + drop, this.w, this.h - drop, '#4a5064');
      Pixel.rect(ctx, this.x + P, this.y + drop + P, this.w - P * 2, P, this.on ? '#57e07a' : '#ffc23c');
    } else {
      Pixel.rect(ctx, this.x, this.y, this.w, this.h, '#3a4258');
      Pixel.frame(ctx, this.x, this.y, this.w, this.h, '#c9ced6');
      var r = P * 2 + (this.flash > 0.4 ? P : 0);
      Pixel.rect(ctx, this.x + this.w / 2 - r, this.y + this.h / 2 - r, r * 2, r * 2,
                 this.on ? '#57e07a' : '#ff4d5e');
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
    var P = Pixel.SIZE;
    Pixel.rect(ctx, this.x, this.y, this.w, this.h, '#4a5270');
    Pixel.rect(ctx, this.x + P, this.y + P, this.w - P * 2, this.h - P * 2, '#68738f');
    for (var i = P * 3; i < this.h - P * 2; i += P * 5) {
      Pixel.rect(ctx, this.x + P * 2, this.y + i, this.w - P * 4, P * 2, '#3d465e');
    }
    Pixel.frame(ctx, this.x, this.y, this.w, this.h, this.open ? '#57e07a' : '#ffc23c');
  };

  /* ==================================================================
     CHECKPOINT + GOAL
     ================================================================== */
  function Checkpoint(o, order) {
    this.kind = 'checkpoint';
    this.invisible = !!o.invisible;
    /* an invisible one is a wide trigger volume you cross without noticing */
    this.w = this.invisible ? (o.w || 70) : 20;
    this.h = this.invisible ? (o.h || 120) : 46;
    this.x = o.x - this.w / 2;
    this.y = o.y - this.h;
    this.order = order || 0;
    this.on = false;
    this.wave = 0;
  }
  Checkpoint.prototype.update = function (dt, world) {
    this.wave += dt * 4;
    var self = this;
    for (var i = 0; i < world.players.length; i++) {
      var p = world.players[i];
      if (p.dead || p.finished) continue;
      if (p.cpIndex >= this.order) continue;      /* never send anyone backwards */
      if (!U.aabb(p, this)) continue;
      p.cpIndex = this.order;
      p.checkpoint = { x: this.x + this.w / 2, y: this.y + this.h };
      if (!this.invisible) {
        this.on = true;
        world.fx.burst(this.x + this.w / 2, this.y + 10, 18, {
          colors: ['#57e07a', '#a8f4b8'], speedMax: 200, lifeMax: 0.7
        });
      }
      if (p === world.localPlayer()) {
        Sound.checkpoint();
        world.toast('CHECKPOINT');
      }
    }
    void self;
  };
  Checkpoint.prototype.draw = function (ctx) {
    if (this.invisible) return;
    var P = Pixel.SIZE;
    Pixel.rect(ctx, this.x + P * 2, this.y, P, this.h, '#4a5064');
    var flap = this.on && Math.sin(this.wave) > 0 ? P : 0;
    for (var i = 0; i < 6; i++) {
      Pixel.rect(ctx, this.x + P * 3 + i * P * 2, this.y + P + (i % 2 ? flap : 0), P * 2, P * 5,
                 this.on ? '#57e07a' : '#9aa0b4');
    }
  };

  function Goal(o) {
    this.kind = 'goal';
    this.x = o.x; this.y = o.y; this.w = o.w || 96; this.h = o.h || 68;
    this.t = 0;
  }
  Goal.prototype.update = function (dt) { this.t += dt; };
  Goal.prototype.draw = function (ctx) {
    var P = Pixel.SIZE;
    var x = Pixel.s(this.x), y = Pixel.s(this.y), w = this.w, h = this.h;
    var bob = Math.sin(this.t * 3) > 0 ? P : 0;

    /* the van */
    Pixel.rect(ctx, x, y + P * 3 + bob, w, h - P * 7, '#ffc23c');
    Pixel.rect(ctx, x + w * 0.55, y + bob, w * 0.45, h - P * 4, '#e0a52c');
    Pixel.rect(ctx, x + w * 0.62, y + P * 2 + bob, w * 0.30, P * 6, '#2b3145');
    Pixel.rect(ctx, x, y + P * 3 + bob, w, P, '#ffe08a');
    Pixel.rect(ctx, x, y + h - P * 5 + bob, w, P, '#b07f18');

    /* wheels */
    Pixel.disc(ctx, x + w * 0.22, y + h - P * 3 + bob, P * 3, '#1a1d28');
    Pixel.disc(ctx, x + w * 0.80, y + h - P * 3 + bob, P * 3, '#1a1d28');
    Pixel.rect(ctx, x + w * 0.22 - P, y + h - P * 4 + bob, P * 2, P * 2, '#50586f');
    Pixel.rect(ctx, x + w * 0.80 - P, y + h - P * 4 + bob, P * 2, P * 2, '#50586f');

    /* a stepped arrow bobbing above it */
    var a = Math.sin(this.t * 4) > 0 ? P : 0;
    var ax = x + w / 2, ay = y - P * 8 + a;
    for (var i = 0; i < 3; i++) {
      Pixel.rect(ctx, ax - P * (3 - i), ay + i * P, P * (6 - i * 2), P, '#57e07a');
    }
    Pixel.shadowText(ctx, 'ESCAPE', ax, y - P * 14 + a, P, '#ffffff', 'center');
  };

  root.PLAYER_PALETTES = PALETTES;
  root.moveAndCollide = moveAndCollide;
  root.Player = Player;
  root.Enemy = Enemy;
  root.Elevator = Elevator;
  root.Glass = Glass;
  root.Prop = Prop;
  root.Hazard = Hazard;
  root.Pickup = Pickup;
  root.Button = Button;
  root.Door = Door;
  root.Checkpoint = Checkpoint;
  root.Goal = Goal;
  root.GRAV = GRAV;
})(typeof window !== 'undefined' ? window : globalThis);
