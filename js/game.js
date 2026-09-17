/* ============================================================
   game.js - the world: build, simulate, collide, draw
   ============================================================ */
(function (root) {
  'use strict';

  var VIEW_W = 960, VIEW_H = 540;

  var PLATFORM_STYLE = {
    solid:  { top: '#8892b5', body: '#4b5575', edge: '#222939' },
    metal:  { top: '#a3adc4', body: '#626d88', edge: '#2e3446' },
    wood:   { top: '#d4a566', body: '#a07a42', edge: '#5d4322' },
    ice:    { top: '#e2f6ff', body: '#93c9dd', edge: '#4d7f93' },
    bounce: { top: '#7df29c', body: '#3cb567', edge: '#1d6b38' },
    grass:  { top: '#86d986', body: '#4d9055', edge: '#2a5230' }
  };

  function World(levelIndex, hooks) {
    this.levelIndex = levelIndex;
    this.level = LEVELS[levelIndex];
    this.hooks = hooks || {};
    this.reset();
  }

  World.prototype.reset = function () {
    var L = this.level, i;

    this.player = new Player(L.spawn.x, L.spawn.y);
    this.checkpoint = { x: L.spawn.x, y: L.spawn.y };

    this.platforms = (L.platforms || []).map(function (p) {
      return { x: p.x, y: p.y, w: p.w, h: p.h, type: p.type, dx: 0, dy: 0,
               ice: p.type === 'ice', bounce: p.type === 'bounce' ? 1.25 : 0 };
    });
    this.glass = (L.glass || []).map(function (g) { return new Glass(g); });
    this.elevators = (L.elevators || []).map(function (e) { return new Elevator(e); });
    this.crates = (L.crates || []).map(function (c) { return new Crate(c); });
    this.hazards = (L.hazards || []).map(function (h) { return new Hazard(h); });
    this.doors = (L.doors || []).map(function (d) { return new Door(d); });
    this.buttons = (L.buttons || []).map(function (b) { return new Button(b); });
    this.checkpoints = (L.checkpoints || []).map(function (c) { return new Checkpoint(c); });
    this.enemies = (L.enemies || []).map(function (e) { return new Enemy(e); });
    this.pickups = (L.pickups || []).map(function (p) {
      return new Pickup(p.x, p.y, p.key, p.ammo != null ? p.ammo : (WEAPONS[p.key] ? WEAPONS[p.key].ammo : 0));
    });
    this.goal = new Goal(L.goal);

    this.bullets = [];
    this.fx = new Particles();
    this.solids = [];

    this.time = 0;
    this.elapsed = 0;
    this.running = true;
    this.finished = false;
    this.respawnTimer = 0;
    this.shakeAmount = 0;
    this.flash = 0;
    this.kills = 0;
    this.glassBroken = 0;
    this.prompt = null;

    this.cam = { x: 0, y: 0 };
    this.camTarget = { x: 0, y: 0 };
    this.centerCameraOnPlayer();
    this.buildSolids();

    /* parallax skyline, seeded per level so it doesn't dance around */
    this.sky = [];
    var seed = 1337 + this.levelIndex * 91;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (i = 0; i < 90; i++) {
      this.sky.push({
        x: rnd() * (L.width + 1600) - 300,
        w: 60 + rnd() * 140,
        h: 120 + rnd() * 420,
        layer: i % 3,
        lit: rnd()
      });
    }
  };

  /* ---------------------------------------------------------- solids */
  World.prototype.buildSolids = function () {
    var s = this.solids;
    s.length = 0;
    var i;
    for (i = 0; i < this.platforms.length; i++) s.push(this.platforms[i]);
    for (i = 0; i < this.elevators.length; i++) {
      var e = this.elevators[i];
      s.push({ x: e.x, y: e.y, w: e.w, h: e.h, dx: e.dx, dy: e.dy, type: 'metal', ref: e });
    }
    for (i = 0; i < this.glass.length; i++) {
      var g = this.glass[i];
      if (!g.broken) s.push({ x: g.x, y: g.y, w: g.w, h: g.h, dx: 0, dy: 0, type: 'glass', ref: g });
    }
    for (i = 0; i < this.crates.length; i++) {
      var c = this.crates[i];
      if (!c.broken) s.push({ x: c.x, y: c.y, w: c.w, h: c.h, dx: 0, dy: 0, type: 'wood', ref: c });
    }
    for (i = 0; i < this.doors.length; i++) {
      var d = this.doors[i];
      s.push({ x: d.x, y: d.y, w: d.w, h: d.h, dx: 0, dy: 0, type: 'metal', ref: d });
    }
  };

  World.prototype.solidAt = function (x, y) {
    for (var i = 0; i < this.solids.length; i++) {
      if (U.pointInRect(x, y, this.solids[i])) return true;
    }
    return false;
  };

  World.prototype.lineOfSight = function (x0, y0, x1, y1) {
    for (var i = 0; i < this.solids.length; i++) {
      var s = this.solids[i];
      if (s.ref && s.ref.kind === 'glass') continue;   /* you can see through windows */
      if (U.segRect(x0, y0, x1, y1, s) >= 0) return false;
    }
    return true;
  };

  /* ---------------------------------------------------------- raycast */
  World.prototype.raycast = function (x0, y0, x1, y1, owner, ownerRef) {
    var best = null, t, i;

    for (i = 0; i < this.solids.length; i++) {
      var s = this.solids[i];
      t = U.segRect(x0, y0, x1, y1, s);
      if (t >= 0 && (!best || t < best.t)) {
        var kind = s.ref ? s.ref.kind : 'solid';
        best = { t: t, type: kind === 'glass' ? 'glass' : (kind === 'crate' ? 'crate' : 'solid'), obj: s.ref || s };
      }
    }

    if (owner !== 'enemy') {
      for (i = 0; i < this.enemies.length; i++) {
        var e = this.enemies[i];
        if (e.dead || e === ownerRef) continue;
        t = U.segRect(x0, y0, x1, y1, e);
        if (t >= 0 && (!best || t < best.t)) best = { t: t, type: 'enemy', obj: e };
      }
    }
    if (owner !== 'player' && !this.player.dead) {
      t = U.segRect(x0, y0, x1, y1, this.player);
      if (t >= 0 && (!best || t < best.t)) best = { t: t, type: 'player', obj: this.player };
    }
    return best;
  };

  /* ---------------------------------------------------------- explosions */
  World.prototype.explode = function (x, y, radius, damage, force, owner) {
    Sound.explode();
    this.shake(12);
    this.flash = 0.5;
    this.fx.burst(x, y, 46, {
      colors: ['#fff3c4', '#ffc23c', '#ff8a3c', '#ff4d5e'],
      speedMax: 520, lifeMax: 0.75, sizeMax: 8, g: 450, bounce: 0.3
    });
    this.fx.smoke(x, y, 16, { grow: 46, color: 'rgba(90,86,82,0.6)' });

    var i, d, f;
    for (i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (e.dead) continue;
      var ec = e.center();
      d = U.dist(x, y, ec.x, ec.y);
      if (d > radius) continue;
      f = 1 - d / radius;
      var a = Math.atan2(ec.y - y, ec.x - x);
      e.damage(damage * f, Math.cos(a) * force * f * 0.6, Math.sin(a) * force * f - 120, this);
    }

    var p = this.player;
    if (!p.dead) {
      var pc = p.center();
      d = U.dist(x, y, pc.x, pc.y);
      if (d < radius) {
        f = 1 - d / radius;
        var pa = Math.atan2(pc.y - y, pc.x - x);
        p.vx = U.clamp(p.vx + Math.cos(pa) * force * f, -1100, 1100);
        p.vy = U.clamp(p.vy + Math.sin(pa) * force * f - 80, -1100, 1100);
        p.grounded = false;
        p.stumble = Math.max(p.stumble, 0.18);
        /* self-damage is heavily reduced so rocket jumping stays viable */
        var selfHit = owner === 'player' ? 0.22 : 0.85;
        if (damage * f * selfHit > 1) {
          var inv = p.invuln; p.invuln = 0;
          p.damage(damage * f * selfHit, 0, 0, this);
          p.invuln = Math.max(p.invuln, inv);
        }
      }
    }

    for (i = 0; i < this.glass.length; i++) {
      var g = this.glass[i];
      if (g.broken) continue;
      var gc = U.rectCenter(g);
      if (U.dist(x, y, gc.x, gc.y) < radius + Math.max(g.w, g.h) * 0.5) g.shatter(this, 0, 0);
    }
    for (i = 0; i < this.crates.length; i++) {
      var c = this.crates[i];
      if (c.broken) continue;
      var cc = U.rectCenter(c);
      if (U.dist(x, y, cc.x, cc.y) < radius + 18) c.destroy(this);
    }
    this.buildSolids();
  };

  /* ---------------------------------------------------------- teleport gun */
  World.prototype.teleportPlayer = function (x, y, hit) {
    var p = this.player;
    Sound.teleport();
    this.fx.burst(p.x + p.w / 2, p.y + p.h / 2, 24, {
      colors: ['#49e0e8', '#a8f4ff', '#ffffff'], speedMax: 260, lifeMax: 0.6, g: 0
    });

    var tx = x - p.w / 2;
    var ty = y - p.h / 2;
    /* nudge out of geometry, preferring straight up */
    var tries = [[0, 0], [0, -14], [0, -28], [0, -44], [0, -60], [18, -30], [-18, -30], [34, -40], [-34, -40], [0, -80]];
    var placed = false;
    for (var i = 0; i < tries.length; i++) {
      var test = { x: tx + tries[i][0], y: ty + tries[i][1], w: p.w, h: p.h };
      var clear = true;
      for (var k = 0; k < this.solids.length; k++) {
        if (U.aabb(test, this.solids[k])) { clear = false; break; }
      }
      if (clear) { p.x = test.x; p.y = test.y; placed = true; break; }
    }
    if (!placed) { p.x = tx; p.y = ty - 60; }

    p.vx *= 0.25; p.vy = Math.min(p.vy, 0) * 0.2;
    p.grounded = false;
    this.fx.burst(p.x + p.w / 2, p.y + p.h / 2, 24, {
      colors: ['#49e0e8', '#a8f4ff', '#ffffff'], speedMax: 260, lifeMax: 0.6, g: 0
    });
    this.shake(3);
  };

  /* ---------------------------------------------------------- misc hooks */
  World.prototype.shake = function (a) { this.shakeAmount = Math.min(28, this.shakeAmount + a); };
  World.prototype.toast = function (m) { if (this.hooks.toast) this.hooks.toast(m); };
  World.prototype.onEnemyKilled = function () { this.kills++; };
  World.prototype.onGlassBroken = function () { this.glassBroken++; this.buildSolids(); };
  World.prototype.setCheckpoint = function (x, y) { this.checkpoint = { x: x, y: y }; };

  World.prototype.fireTarget = function (id) {
    var i;
    for (i = 0; i < this.doors.length; i++) if (this.doors[i].id === id) this.doors[i].fire();
    for (i = 0; i < this.elevators.length; i++) if (this.elevators[i].id === id) this.elevators[i].trigger(this);
    this.toast('SOMETHING OPENED');
  };

  /* ---------------------------------------------------------- interaction */
  World.prototype.findInteractable = function () {
    var p = this.player;
    var pc = p.center();
    var best = null, bd = 1e9, i, d;

    for (i = 0; i < this.pickups.length; i++) {
      var pk = this.pickups[i];
      if (pk.taken || pk.cooldown > 0) continue;
      d = U.dist(pc.x, pc.y, pk.x + pk.w / 2, pk.y + pk.h / 2);
      if (d < 52 && d < bd) {
        bd = d;
        best = { type: 'pickup', obj: pk, label: pk.key === 'medkit' ? 'TAKE MEDKIT' : 'TAKE ' + WEAPONS[pk.key].name };
      }
    }
    for (i = 0; i < this.buttons.length; i++) {
      var b = this.buttons[i];
      if (b.plate) continue;
      d = U.dist(pc.x, pc.y, b.x + b.w / 2, b.y + b.h / 2);
      if (d < 62 && d < bd) { bd = d; best = { type: 'button', obj: b, label: b.on ? 'PRESS AGAIN' : 'PRESS SWITCH' }; }
    }
    for (i = 0; i < this.elevators.length; i++) {
      var e = this.elevators[i];
      if (e.mode !== 'call') continue;
      var ec = { x: e.x + e.w / 2, y: e.y + e.h / 2 };
      d = U.dist(pc.x, pc.y, ec.x, ec.y);
      var standing = p.groundRef && p.groundRef.ref === e;
      if ((d < 110 || standing) && d < bd) {
        bd = standing ? -1 : d;
        best = { type: 'elevator', obj: e, label: e.active ? 'ELEVATOR MOVING' : 'CALL ELEVATOR' };
      }
    }
    return best;
  };

  World.prototype.interact = function () {
    var it = this.prompt;
    if (!it) return false;
    if (it.type === 'pickup') {
      var pk = it.obj;
      if (pk.key === 'medkit') {
        this.player.health = Math.min(this.player.maxHealth, this.player.health + 55);
        Sound.ding();
        this.toast('PATCHED UP');
      } else {
        this.player.takeWeapon(pk.key, pk.ammo, this);
      }
      pk.taken = true;
      return true;
    }
    if (it.type === 'button') { it.obj.activate(this); return true; }
    if (it.type === 'elevator') { it.obj.trigger(this); return true; }
    return false;
  };

  /* ---------------------------------------------------------- update */
  World.prototype.update = function (dt, input) {
    var i, p = this.player;
    this.time += dt;
    if (!this.finished && !p.dead) this.elapsed += dt;

    this.shakeAmount *= U.damp(6, dt);
    this.flash = Math.max(0, this.flash - dt * 2.2);

    /* furniture first so solids are current before anything moves */
    for (i = 0; i < this.elevators.length; i++) this.elevators[i].update(dt, this);
    for (i = 0; i < this.doors.length; i++) this.doors[i].update(dt);
    for (i = 0; i < this.hazards.length; i++) this.hazards[i].update(dt);
    this.buildSolids();

    for (i = 0; i < this.buttons.length; i++) this.buttons[i].update(dt, this);

    /* ---- player ---- */
    this.prompt = p.dead ? null : this.findInteractable();
    if (!p.dead) {
      if (input.interactPressed()) {
        if (!this.interact() && p.weapon) p.shoot(this);
      }
    }
    p.update(dt, this, input);

    /* ---- enemies ---- */
    for (i = 0; i < this.enemies.length; i++) this.enemies[i].update(dt, this);

    /* ---- pickups ---- */
    for (i = this.pickups.length - 1; i >= 0; i--) {
      var pk = this.pickups[i];
      pk.update(dt, this);
      if (pk.taken) this.pickups.splice(i, 1);
    }

    /* ---- bullets ---- */
    for (i = this.bullets.length - 1; i >= 0; i--) {
      this.bullets[i].update(dt, this);
      if (this.bullets[i].dead) this.bullets.splice(i, 1);
    }

    for (i = 0; i < this.checkpoints.length; i++) this.checkpoints[i].update(dt, this);
    this.goal.update(dt);
    this.fx.update(dt, this);

    /* ---- hazards hurt ---- */
    if (!p.dead) {
      for (i = 0; i < this.hazards.length; i++) {
        if (U.aabb(p, this.hazards[i].hitbox())) { p.kill(this); break; }
      }
      for (i = 0; i < this.enemies.length; i++) {
        var en = this.enemies[i];
        if (en.dead) continue;
        for (var j = 0; j < this.hazards.length; j++) {
          if (U.aabb(en, this.hazards[j].hitbox())) { en.die(this, 0); break; }
        }
      }
    }

    /* ---- fell out of the world ---- */
    if (!p.dead && p.y > this.level.height + 60) p.kill(this);

    /* ---- reached the van ---- */
    if (!this.finished && !p.dead && U.aabb(p, this.goal)) {
      this.finished = true;
      Sound.win();
      this.fx.burst(p.x + p.w / 2, p.y + p.h / 2, 40, {
        colors: ['#ffc23c', '#57e07a', '#ffffff'], speedMax: 380, lifeMax: 1.2, sizeMax: 6
      });
      if (this.hooks.complete) this.hooks.complete(this.elapsed);
    }

    /* ---- respawn ---- */
    if (p.dead) {
      this.respawnTimer += dt;
      if (this.respawnTimer > 1.05) this.respawn();
    }

    this.updateCamera(dt);
  };

  World.prototype.respawn = function () {
    var p = this.player;
    this.respawnTimer = 0;
    p.dead = false;
    p.deadTimer = 0;
    p.health = p.maxHealth;
    p.x = this.checkpoint.x - p.w / 2;
    p.y = this.checkpoint.y - p.h;
    p.vx = 0; p.vy = 0;
    p.angle = 0;
    p.invuln = 1.2;
    p.stumble = 0;
    this.bullets.length = 0;
    this.fx.burst(this.checkpoint.x, this.checkpoint.y - 20, 18, {
      colors: ['#57e07a', '#a8f4b8'], speedMax: 220, lifeMax: 0.6
    });
    if (this.hooks.respawn) this.hooks.respawn();
  };

  /* ---------------------------------------------------------- camera */
  World.prototype.clampCam = function (c) {
    var L = this.level;
    c.x = L.width <= VIEW_W ? (L.width - VIEW_W) / 2 : U.clamp(c.x, 0, L.width - VIEW_W);
    c.y = L.height <= VIEW_H ? (L.height - VIEW_H) / 2 : U.clamp(c.y, 0, L.height - VIEW_H);
    return c;
  };

  World.prototype.centerCameraOnPlayer = function () {
    var p = this.player;
    this.cam.x = p.x + p.w / 2 - VIEW_W / 2;
    this.cam.y = p.y + p.h / 2 - VIEW_H / 2;
    this.clampCam(this.cam);
  };

  World.prototype.updateCamera = function (dt) {
    var p = this.player;
    var look = U.clamp(p.vx * 0.22, -110, 110);
    this.camTarget.x = p.x + p.w / 2 - VIEW_W / 2 + look;
    this.camTarget.y = p.y + p.h / 2 - VIEW_H / 2 + U.clamp(p.vy * 0.12, -80, 120);
    this.clampCam(this.camTarget);
    var k = 1 - U.damp(7.5, dt);
    this.cam.x += (this.camTarget.x - this.cam.x) * k;
    this.cam.y += (this.camTarget.y - this.cam.y) * k;
    this.clampCam(this.cam);
  };

  /* ---------------------------------------------------------- drawing */
  World.prototype.drawBackground = function (ctx) {
    var L = this.level;
    var g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    var s = L.sky;
    for (var i = 0; i < s.length; i++) g.addColorStop(i / (s.length - 1), s[i]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    /* moon / sun */
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.arc(VIEW_W * 0.78 - this.cam.x * 0.02, 96 - this.cam.y * 0.02, 46, 0, 6.2832);
    ctx.fill();

    var layers = [
      { p: 0.10, col: 'rgba(16,21,40,0.40)', yo: 60 },
      { p: 0.22, col: 'rgba(14,19,36,0.52)', yo: 30 },
      { p: 0.38, col: 'rgba(10,13,26,0.66)', yo: 0 }
    ];
    for (var l = 0; l < layers.length; l++) {
      var lay = layers[l];
      ctx.fillStyle = lay.col;
      for (var b = 0; b < this.sky.length; b++) {
        var bd = this.sky[b];
        if (bd.layer !== l) continue;
        var bx = bd.x - this.cam.x * lay.p;
        var by = VIEW_H - bd.h + lay.yo - this.cam.y * lay.p * 0.35;
        if (bx > VIEW_W + 60 || bx + bd.w < -60) continue;
        ctx.fillRect(bx, by, bd.w, bd.h + 500);
        if (l === 2 && bd.lit > 0.35) {
          ctx.fillStyle = 'rgba(255,205,110,0.13)';
          for (var wy = by + 16; wy < by + bd.h - 10; wy += 26) {
            for (var wx = bx + 10; wx < bx + bd.w - 14; wx += 22) {
              if (((wx * 7 + wy * 13) % 5) < 2) ctx.fillRect(wx, wy, 9, 12);
            }
          }
          ctx.fillStyle = lay.col;
        }
      }
    }
  };

  World.prototype.drawHaze = function (ctx) {
    var h = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    h.addColorStop(0, 'rgba(18,22,40,0.10)');
    h.addColorStop(1, 'rgba(18,22,40,0.46)');
    ctx.fillStyle = h;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  };

  World.prototype.drawPlatform = function (ctx, p) {
    var st = PLATFORM_STYLE[p.type] || PLATFORM_STYLE.solid;
    ctx.fillStyle = 'rgba(8,10,18,0.55)';
    ctx.fillRect(p.x - 2, p.y - 2, p.w + 4, p.h + 4);
    ctx.fillStyle = st.body;
    ctx.fillRect(p.x, p.y, p.w, p.h);
    ctx.fillStyle = st.top;
    ctx.fillRect(p.x, p.y, p.w, Math.min(6, p.h));
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(p.x, p.y, p.w, 2);
    ctx.fillStyle = st.edge;
    ctx.fillRect(p.x, p.y + p.h - 3, p.w, 3);
    if (p.h > 26) {
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      for (var y = p.y + 16; y < p.y + p.h - 8; y += 26) ctx.fillRect(p.x + 4, y, p.w - 8, 2);
    }
    if (p.type === 'bounce') {
      ctx.fillStyle = 'rgba(255,255,255,0.35)';
      for (var x = p.x + 6; x < p.x + p.w - 6; x += 14) ctx.fillRect(x, p.y + 2, 7, 2);
    }
    if (p.type === 'ice') {
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      ctx.fillRect(p.x, p.y, p.w, 2);
    }
  };

  World.prototype.draw = function (ctx) {
    var i;
    ctx.save();
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    this.drawBackground(ctx);
    this.drawHaze(ctx);

    var sx = 0, sy = 0;
    if (this.shakeAmount > 0.4) {
      sx = U.rand(-this.shakeAmount, this.shakeAmount);
      sy = U.rand(-this.shakeAmount, this.shakeAmount);
    }
    ctx.translate(-Math.round(this.cam.x) + sx, -Math.round(this.cam.y) + sy);

    /* hints sit behind everything */
    var hints = this.level.hints || [];
    ctx.font = 'italic 15px "Segoe UI", sans-serif';
    ctx.textAlign = 'center';
    for (i = 0; i < hints.length; i++) {
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillText(hints[i].text, hints[i].x + 1, hints[i].y + 2);
      ctx.fillStyle = 'rgba(255,224,150,0.55)';
      ctx.fillText(hints[i].text, hints[i].x, hints[i].y);
    }

    for (i = 0; i < this.checkpoints.length; i++) this.checkpoints[i].draw(ctx);
    this.goal.draw(ctx);

    for (i = 0; i < this.platforms.length; i++) this.drawPlatform(ctx, this.platforms[i]);
    for (i = 0; i < this.doors.length; i++) this.doors[i].draw(ctx);
    for (i = 0; i < this.elevators.length; i++) this.elevators[i].draw(ctx);
    for (i = 0; i < this.crates.length; i++) this.crates[i].draw(ctx);
    for (i = 0; i < this.buttons.length; i++) this.buttons[i].draw(ctx);
    for (i = 0; i < this.hazards.length; i++) this.hazards[i].draw(ctx, this.time);
    for (i = 0; i < this.pickups.length; i++) this.pickups[i].draw(ctx);

    /* dead bodies under the living */
    for (i = 0; i < this.enemies.length; i++) if (this.enemies[i].dead) this.enemies[i].draw(ctx);
    for (i = 0; i < this.enemies.length; i++) if (!this.enemies[i].dead) this.enemies[i].draw(ctx);

    if (!this.player.dead) this.player.draw(ctx);

    for (i = 0; i < this.bullets.length; i++) this.bullets[i].draw(ctx);
    this.fx.draw(ctx);

    /* glass on top so you see the player through it */
    for (i = 0; i < this.glass.length; i++) this.glass[i].draw(ctx, this.time);

    /* interaction highlight */
    if (this.prompt) {
      var o = this.prompt.obj;
      var bx = o.x + (o.w || 0) / 2, by = o.y + (o.h || 0) / 2;
      ctx.strokeStyle = 'rgba(255,194,60,' + (0.45 + Math.sin(this.time * 8) * 0.25) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(bx, by, 26 + Math.sin(this.time * 6) * 2, 0, 6.2832);
      ctx.stroke();
    }

    ctx.restore();

    if (this.flash > 0.01) {
      ctx.fillStyle = 'rgba(255,220,160,' + this.flash * 0.35 + ')';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
    if (this.player.dead) {
      ctx.fillStyle = 'rgba(120,10,20,' + U.clamp(this.player.deadTimer * 0.55, 0, 0.45) + ')';
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }

    /* vignette */
    var vg = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.38, VIEW_W / 2, VIEW_H / 2, VIEW_H * 0.86);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.42)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    /* off-screen goal marker */
    this.drawGoalArrow(ctx);
  };

  World.prototype.drawGoalArrow = function (ctx) {
    var gx = this.goal.x + this.goal.w / 2 - this.cam.x;
    var gy = this.goal.y + this.goal.h / 2 - this.cam.y;
    if (gx > 20 && gx < VIEW_W - 20 && gy > 20 && gy < VIEW_H - 20) return;
    var cx = VIEW_W / 2, cy = VIEW_H / 2;
    var a = Math.atan2(gy - cy, gx - cx);
    var r = Math.min(VIEW_W, VIEW_H) * 0.42;
    var px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(a);
    ctx.fillStyle = 'rgba(87,224,122,0.8)';
    ctx.beginPath();
    ctx.moveTo(12, 0); ctx.lineTo(-8, -8); ctx.lineTo(-8, 8);
    ctx.closePath(); ctx.fill();
    ctx.restore();
  };

  root.World = World;
  root.VIEW_W = VIEW_W;
  root.VIEW_H = VIEW_H;
})(window);
