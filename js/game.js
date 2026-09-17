/* ============================================================
   game.js - the world: build, simulate, collide, draw
   ============================================================ */
(function (root) {
  'use strict';

  /* The logical view the camera frames, in world units. Smaller than the
     canvas: it renders into a 240x135 buffer and is blown up 4x, which is
     what makes a character read as ~15 pixels tall instead of 45. */
  var VIEW_W = 576, VIEW_H = 324;

  var NO = function () { return false; };
  var NULL_INPUT = {
    left: NO, right: NO, jump: NO, jumpPressed: NO, interactPressed: NO,
    interactHeld: NO, firePressed: NO, fireHeld: NO, dropPressed: NO, pressed: NO,
    mouse: { down: false, pressed: false }
  };

  /* Flat, bright and few colours per surface: the look is carried by the
     pixel grid, not by shading. */
  var PLATFORM_STYLE = {
    solid:  { top: '#c9ced3', body: '#969ca4', edge: '#6a7078' },
    metal:  { top: '#d8dce0', body: '#a6acb4', edge: '#767c86' },
    wood:   { top: '#d9a960', body: '#a87c3c', edge: '#6d4e22' },
    ice:    { top: '#eafaff', body: '#a6dcee', edge: '#6ea8c2' },
    bounce: { top: '#a8f890', body: '#54c84e', edge: '#2c8a32' },
    grass:  { top: '#96e07e', body: '#54a049', edge: '#2e6a2e' }
  };

  function World(levelIndex, hooks, opts) {
    opts = opts || {};
    this.mode = opts.mode || 'campaign';          /* campaign | versus */
    this.levelSet = opts.levels || LEVELS;
    this.levelIndex = levelIndex;
    this.level = this.levelSet[levelIndex];
    this.hooks = hooks || {};
    this.playerDefs = opts.players || [{ name: 'PLAYER' }];
    this.localIndex = opts.localIndex == null ? 0 : opts.localIndex;
    this.headless = !!opts.headless;
    this.goreLevel = opts.goreLevel == null ? 1 : opts.goreLevel;
    this.reset();
  }

  World.prototype.reset = function () {
    var L = this.level, i;
    var spawns = L.spawns || [L.spawn];

    this.players = [];
    for (i = 0; i < this.playerDefs.length; i++) {
      var def = this.playerDefs[i];
      var sp = spawns[i % spawns.length];
      var pl = new Player(sp.x, sp.y, {
        index: i,
        name: def.name,
        isBot: def.isBot,
        personality: def.personality,
        showTag: this.mode === 'versus'
      });
      pl.wins = def.wins || 0;
      if (def.isBot && typeof Bot !== 'undefined') {
        pl.brain = new Bot(def.personality, i);
      }
      this.players.push(pl);
    }
    this.player = this.players[U.clamp(this.localIndex, 0, this.players.length - 1)];

    this.gore = new Gore();
    this.gore.setLevel(this.goreLevel);
    this.roundOver = false;
    this.roundWinner = null;
    this.standings = [];

    this.platforms = (L.platforms || []).map(function (p) {
      return { x: p.x, y: p.y, w: p.w, h: p.h, type: p.type, dx: 0, dy: 0,
               ice: p.type === 'ice', bounce: p.type === 'bounce' ? 1.25 : 0 };
    });
    this.glass = (L.glass || []).map(function (g) { return new Glass(g); });
    this.elevators = (L.elevators || []).map(function (e) { return new Elevator(e); });
    /* `crates` is the old key; `props` is the new one. Both build Props. */
    this.props = (L.crates || []).concat(L.props || []).map(function (c) { return new Prop(c); });
    this.hazards = (L.hazards || []).map(function (h) { return new Hazard(h); });
    this.doors = (L.doors || []).map(function (d) { return new Door(d); });
    this.buttons = (L.buttons || []).map(function (b) { return new Button(b); });
    this.checkpoints = (L.checkpoints || []).map(function (c, ci) { return new Checkpoint(c, ci); });
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

    /* the route graph bots path over - static geometry only, so it stays
       valid even after the glass they were standing on gives way */
    this.nav = (typeof NavGraph !== 'undefined') ? new NavGraph(this) : null;

    /* parallax skyline, seeded per level so it doesn't dance around */
    this.sky = [];
    var seed = 1337 + this.levelIndex * 91;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (i = 0; i < 90; i++) {
      var layer = i % 2;
      this.sky.push({
        x: Pixel.s(rnd() * (L.width + 1600) - 300),
        w: Pixel.s(45 + rnd() * 105),
        /* low: the city is a horizon line, not a backdrop that swallows
           the play area */
        h: Pixel.s(layer === 0 ? 45 + rnd() * 105 : 75 + rnd() * 165),
        layer: layer,
        lit: rnd()
      });
    }
    this.clouds = [];
    for (i = 0; i < 9; i++) {
      this.clouds.push({
        x: rnd() * (VIEW_W + 400),
        y: Pixel.s(40 + rnd() * 190),
        w: Pixel.s(30 + rnd() * 46),
        sp: 5 + rnd() * 10
      });
    }
  };

  /* ---------------------------------------------------------- players */
  World.prototype.localPlayer = function () { return this.player; };

  World.prototype.eachPlayer = function (fn) {
    for (var i = 0; i < this.players.length; i++) fn(this.players[i], i);
  };

  /* first player for which fn is true; `self` becomes fn's `this` */
  World.prototype.anyPlayer = function (fn, self) {
    for (var i = 0; i < this.players.length; i++) {
      if (fn.call(self, this.players[i], i)) return this.players[i];
    }
    return null;
  };

  World.prototype.nearestPlayer = function (x, y, aliveOnly, exclude) {
    var best = null, bd = 1e18;
    for (var i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      if (p === exclude) continue;
      if (aliveOnly && (p.dead || p.finished)) continue;
      var c = p.center();
      var d = U.dist2(x, y, c.x, c.y);
      if (d < bd) { bd = d; best = p; }
    }
    return best;
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
    for (i = 0; i < this.props.length; i++) {
      var c = this.props[i];
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

  /* `ignore` is the thing you are looking AT: a barrel is solid, so without
     this it would always block the sightline to itself. */
  World.prototype.lineOfSight = function (x0, y0, x1, y1, ignore) {
    for (var i = 0; i < this.solids.length; i++) {
      var s = this.solids[i];
      if (s.ref && s.ref.kind === 'glass') continue;   /* you can see through windows */
      if (ignore && s.ref === ignore) continue;
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
        best = { t: t, type: kind === 'glass' ? 'glass' : (kind === 'prop' ? 'prop' : 'solid'), obj: s.ref || s };
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
    for (i = 0; i < this.players.length; i++) {
      var pl = this.players[i];
      if (pl === ownerRef || pl.dead || pl.finished) continue;
      t = U.segRect(x0, y0, x1, y1, pl);
      if (t >= 0 && (!best || t < best.t)) best = { t: t, type: 'player', obj: pl };
    }
    return best;
  };

  /* ------------------------------------------------- aim assist
     Aiming is deliberately awkward here, so the shot is nudged onto
     whatever is worth hitting: a gas barrel first, otherwise the nearest
     rival. Only inside a cone you are already pointing down, and only
     with line of sight, so it assists rather than plays for you. */
  var ASSIST_CONE = 0.62;         /* about 35 degrees either side */
  var ASSIST_RANGE = 560;

  World.prototype.aimAssist = function (p) {
    if (!p || p.dead || p.finished) return null;
    var c = p.center();
    var base = p.aim();
    var best = null, bestScore = 0;
    var self = this;

    function consider(tx, ty, obj, bonus) {
      var dx = tx - c.x, dy = ty - c.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < 30 || d > ASSIST_RANGE) return;
      var ang = Math.atan2(dy, dx);
      var off = Math.abs(U.angleDiff(ang, base));
      if (off > ASSIST_CONE) return;
      if (!self.lineOfSight(c.x, c.y, tx, ty, obj)) return;
      var score = (1 - off / ASSIST_CONE) * 0.62 + (1 - d / ASSIST_RANGE) * 0.38 + bonus;
      if (score > bestScore) { bestScore = score; best = { x: tx, y: ty, obj: obj, angle: ang }; }
    }

    var i, cc;
    for (i = 0; i < this.props.length; i++) {
      var pr = this.props[i];
      if (pr.broken || pr.type !== 'barrel' || pr.fuse > 0) continue;
      cc = pr.center();
      consider(cc.x, cc.y, pr, 0.34);
    }
    for (i = 0; i < this.players.length; i++) {
      var o = this.players[i];
      if (o === p || o.dead || o.finished) continue;
      cc = o.center();
      consider(cc.x, cc.y, o, 0);
    }
    for (i = 0; i < this.enemies.length; i++) {
      if (this.enemies[i].dead) continue;
      cc = this.enemies[i].center();
      consider(cc.x, cc.y, this.enemies[i], 0);
    }
    return best;
  };

  /* ---------------------------------------------------------- explosions */
  World.prototype.explode = function (x, y, radius, damage, force, owner, ownerRef) {
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

    for (i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      if (p.dead || p.finished) continue;
      var pc = p.center();
      d = U.dist(x, y, pc.x, pc.y);
      if (d >= radius) continue;
      f = 1 - d / radius;
      var pa = Math.atan2(pc.y - y, pc.x - x);
      p.vx = U.clamp(p.vx + Math.cos(pa) * force * f, -1100, 1100);
      p.vy = U.clamp(p.vy + Math.sin(pa) * force * f - 80, -1100, 1100);
      p.grounded = false;
      p.stumble = Math.max(p.stumble, 0.18);
      /* your own blast barely scratches you, so rocket jumping stays viable */
      var selfHit = (ownerRef && ownerRef === p) ? 0.22 : 0.85;
      if (damage * f * selfHit > 1) {
        var inv = p.invuln; p.invuln = 0;
        p.damage(damage * f * selfHit, 0, 0, this, ownerRef);
        p.invuln = Math.max(p.invuln, inv);
      }
    }

    for (i = 0; i < this.glass.length; i++) {
      var g = this.glass[i];
      if (g.broken) continue;
      var gc = U.rectCenter(g);
      if (U.dist(x, y, gc.x, gc.y) < radius + Math.max(g.w, g.h) * 0.5) g.shatter(this, 0, 0);
    }
    /* Props get thrown as well as hurt, and barrels take a fuse rather than
       going off inside this loop - that is what makes a chain read. */
    for (i = 0; i < this.props.length; i++) {
      var pr = this.props[i];
      if (pr.broken) continue;
      var pcc = pr.center();
      d = U.dist(x, y, pcc.x, pcc.y);
      if (d > radius + 24) continue;
      f = 1 - U.clamp(d / (radius + 24), 0, 1);
      var pa2 = Math.atan2(pcc.y - y, pcc.x - x);
      pr.vx += Math.cos(pa2) * force * f * 0.75;
      pr.vy += Math.sin(pa2) * force * f * 0.75 - 130;
      pr.settle = 0;
      if (pr.type === 'barrel') pr.light(this, ownerRef);
      else pr.damage(damage * f * 1.5, this, ownerRef);
    }
    this.buildSolids();
  };

  /* ---------------------------------------------------------- teleport gun */
  World.prototype.teleportPlayer = function (x, y, hit, who) {
    var p = who || this.player;
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

  World.prototype.onPlayerDied = function (p, cause) {
    if (p.lastAttacker && p.lastAttacker !== p && p.lastAttacker.frags != null) p.lastAttacker.frags++;
    if (this.hooks.died) this.hooks.died(p, cause);
  };

  World.prototype.fireTarget = function (id) {
    var i;
    for (i = 0; i < this.doors.length; i++) if (this.doors[i].id === id) this.doors[i].fire();
    for (i = 0; i < this.elevators.length; i++) if (this.elevators[i].id === id) this.elevators[i].trigger(this);
    this.toast('SOMETHING OPENED');
  };

  /* ---------------------------------------------------------- interaction */
  World.prototype.findInteractable = function (p) {
    p = p || this.player;
    var pc = p.center();
    var best = null, bd = 1e9, i, d;

    for (i = 0; i < this.pickups.length; i++) {
      var pk = this.pickups[i];
      if (pk.taken || pk.cooldown > 0) continue;
      d = U.dist(pc.x, pc.y, pk.x + pk.w / 2, pk.y + pk.h / 2);
      if (d < 74 && d < bd) {
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

  World.prototype.interact = function (p) {
    p = p || this.player;
    var it = p.prompt;
    if (!it) return false;
    if (it.type === 'pickup') {
      var pk = it.obj;
      if (pk.taken) return false;
      if (pk.key === 'medkit') {
        p.health = Math.min(p.maxHealth, p.health + 55);
        if (p === this.player) { Sound.ding(); this.toast('PATCHED UP'); }
      } else {
        p.takeWeapon(pk.key, pk.ammo, this);
      }
      pk.taken = true;
      return true;
    }
    if (it.type === 'button') { it.obj.activate(this); return true; }
    if (it.type === 'elevator') { it.obj.trigger(this); return true; }
    return false;
  };

  /* ---------------------------------------------------------- update */
  World.prototype.update = function (dt, inputs) {
    var i, j, p;
    this.time += dt;

    /* One input source per player. A plain object means "the local player
       reads this", which keeps the single-player call signature untouched. */
    if (!Array.isArray(inputs)) { var one = inputs; inputs = []; inputs[this.localIndex] = one; }

    if (!this.finished && !this.roundOver) this.elapsed += dt;

    this.shakeAmount *= U.damp(6, dt);
    this.flash = Math.max(0, this.flash - dt * 2.2);

    /* furniture first so solids are current before anything moves */
    for (i = 0; i < this.elevators.length; i++) this.elevators[i].update(dt, this);
    for (i = 0; i < this.doors.length; i++) this.doors[i].update(dt);
    for (i = 0; i < this.hazards.length; i++) this.hazards[i].update(dt);
    this.buildSolids();

    for (i = 0; i < this.buttons.length; i++) this.buttons[i].update(dt, this);

    /* ---- players ---- */
    for (i = 0; i < this.players.length; i++) {
      p = this.players[i];
      if (p.finished) continue;

      var input = p.brain ? p.brain.think(dt, this, p) : (inputs[i] || NULL_INPUT);

      p.prompt = p.dead ? null : this.findInteractable(p);
      p.aimTarget = (p.isBot || p.dead || !p.weapon) ? null : this.aimAssist(p);
      if (!p.dead && input.interactPressed()) {
        if (!this.interact(p) && p.weapon) p.shoot(this);
      }
      p.update(dt, this, input);
    }

    /* ---- squashed between a mover and the world ---- */
    this.resolveCrush();

    /* ---- enemies ---- */
    for (i = 0; i < this.enemies.length; i++) this.enemies[i].update(dt, this);

    /* ---- pickups ---- */
    for (i = 0; i < this.props.length; i++) this.props[i].update(dt, this);

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
    this.gore.update(dt, this);

    /* ---- hazards, falls, the finish line, respawns ---- */
    for (i = 0; i < this.players.length; i++) {
      p = this.players[i];
      if (p.finished) continue;

      if (!p.dead) {
        for (j = 0; j < this.hazards.length; j++) {
          if (U.aabb(p, this.hazards[j].hitbox())) {
            p.kill(this, this.hazards[j].type === 'lava' ? 'burned' : 'shredded');
            break;
          }
        }
      }
      if (!p.dead && p.y > this.level.height + 60) p.kill(this, 'fell');
      if (!p.dead && U.aabb(p, this.goal)) this.reachGoal(p);

      if (p.dead) {
        p.respawnTimer += dt;
        if (p.respawnTimer > 1.05) this.respawn(p);
      }
    }

    for (i = 0; i < this.enemies.length; i++) {
      var en = this.enemies[i];
      if (en.dead) continue;
      for (j = 0; j < this.hazards.length; j++) {
        if (U.aabb(en, this.hazards[j].hitbox())) { en.die(this, 0); break; }
      }
    }

    this.updateCamera(dt);
  };

  /* Somebody made it to the van. */
  World.prototype.reachGoal = function (p) {
    if (p.finished) return;
    p.finished = true;
    p.finishTime = this.elapsed;
    this.standings.push(p);
    this.fx.burst(p.x + p.w / 2, p.y + p.h / 2, 40, {
      colors: ['#ffc23c', '#57e07a', '#ffffff'], speedMax: 380, lifeMax: 1.2, sizeMax: 6
    });

    if (this.mode === 'versus') {
      if (!this.roundOver) {
        this.roundOver = true;
        this.roundWinner = p;
        p.wins++;
        Sound.win();
        if (this.hooks.roundWin) this.hooks.roundWin(p, this);
      }
    } else if (!this.finished) {
      this.finished = true;
      Sound.win();
      if (this.hooks.complete) this.hooks.complete(this.elapsed);
    }
  };

  /* ------------------------------------------------- crushing
     A mover that closes on you shoves you along its travel. If the far
     side is solid too, there is nowhere left to be. */
  World.prototype.overlapsSolid = function (box, ignore) {
    for (var i = 0; i < this.solids.length; i++) {
      var sd = this.solids[i];
      if (sd === ignore || (ignore && sd.ref && sd.ref === ignore.ref)) continue;
      if (U.aabb(box, sd)) return true;
    }
    return false;
  };

  World.prototype.resolveCrush = function () {
    var movers = [], i, k;
    for (i = 0; i < this.solids.length; i++) {
      if (this.solids[i].dx || this.solids[i].dy) movers.push(this.solids[i]);
    }
    if (!movers.length) return;

    for (k = 0; k < this.players.length; k++) {
      var p = this.players[k];
      if (p.dead || p.finished) continue;
      for (i = 0; i < movers.length; i++) {
        var m = movers[i];
        if (!U.aabb(p, m)) continue;

        /* a piston does not negotiate */
        if (m.ref && m.ref.crusher) {
          p.kill(this, 'crushed');
          this.shake(12);
          break;
        }

        /* shove the way the mover is going, then try the other side */
        var first = m.dy > 0 ? m.y + m.h : m.y - p.h;
        var other = m.dy > 0 ? m.y - p.h : m.y + m.h;
        var box = { x: p.x, y: first, w: p.w, h: p.h };
        if (!this.overlapsSolid(box, m)) { p.y = first; p.vy = m.dy > 0 ? Math.max(p.vy, 0) : 0; continue; }
        box.y = other;
        if (!this.overlapsSolid(box, m)) { p.y = other; p.vy = 0; continue; }

        /* sideways is the last way out */
        box.y = p.y;
        box.x = m.x - p.w - 1;
        if (!this.overlapsSolid(box, m)) { p.x = box.x; continue; }
        box.x = m.x + m.w + 1;
        if (!this.overlapsSolid(box, m)) { p.x = box.x; continue; }

        p.kill(this, 'crushed');
        this.shake(10);
        break;
      }
    }
  };

  World.prototype.respawn = function (p) {
    p = p || this.player;
    p.respawnTimer = 0;
    p.dead = false;
    p.deadTimer = 0;
    p.health = p.maxHealth;
    p.x = p.checkpoint.x - p.w / 2;
    p.y = p.checkpoint.y - p.h;
    p.vx = 0; p.vy = 0;
    p.angle = 0;
    p.invuln = 1.4;
    p.stumble = 0;
    p.deathCause = null;
    if (p.resetLimbs) p.resetLimbs();
    if (p.brain) p.brain.reset();
    if (p === this.player) this.bullets.length = 0;
    this.fx.burst(p.checkpoint.x, p.checkpoint.y - 20, 18, {
      colors: ['#57e07a', '#a8f4b8'], speedMax: 220, lifeMax: 0.6
    });
    if (this.hooks.respawn) this.hooks.respawn(p);
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
    var sky = (L.sky && L.sky.length) ? L.sky : ['#2fb6ea', '#8fd8f2', '#d8cba4'];
    var P = Pixel.SIZE;

    /* flat sky, no gradient */
    ctx.fillStyle = sky[0];
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    /* the sun is a block, like everything else */
    Pixel.disc(ctx, VIEW_W * 0.80 - this.cam.x * 0.02, 88 - this.cam.y * 0.02, 33, 'rgba(255,255,255,0.22)');

    /* Vertical parallax is clamped: on a tall map the skyline should drift,
       not launch off the top of the screen. */
    var camY = U.clamp(this.cam.y * 0.06, -90, 90);
    var layers = [
      { p: 0.12, col: sky[1], win: null, yo: 0 },
      { p: 0.26, col: sky[2], win: sky[3] || 'rgba(0,0,0,0.13)', yo: 0 }
    ];
    for (var l = 0; l < layers.length; l++) {
      var lay = layers[l];
      for (var b = 0; b < this.sky.length; b++) {
        var bd = this.sky[b];
        if (bd.layer !== l) continue;
        var bx = Pixel.s(bd.x - this.cam.x * lay.p);
        var by = Pixel.s(VIEW_H - bd.h - camY * lay.p);
        if (bx > VIEW_W + 60 || bx + bd.w < -60) continue;
        Pixel.rect(ctx, bx, by, bd.w, bd.h + 400, lay.col);
        if (lay.win && bd.lit > 0.28) {
          /* a neat grid of windows, inset from the edges */
          ctx.fillStyle = lay.win;
          var cols = Math.max(1, Math.floor((bd.w - P * 4) / (P * 5)));
          for (var wy = by + P * 4; wy < by + bd.h - P * 4; wy += P * 6) {
            for (var c2 = 0; c2 < cols; c2++) {
              var wx = bx + P * 3 + c2 * P * 5;
              if (((c2 * 3 + Math.round(wy / P)) % 7) < 5) {
                ctx.fillRect(Pixel.s(wx), Pixel.s(wy), P * 2, P * 3);
              }
            }
          }
        }
        /* a water tank on some of the near ones */
        if (l === 1 && bd.lit > 0.76) {
          Pixel.rect(ctx, bx + bd.w * 0.3, by - P * 3, P * 4, P * 3, lay.col);
          Pixel.rect(ctx, bx + bd.w * 0.3 + P, by - P * 5, P * 2, P * 2, lay.col);
        }
      }
    }

    /* clouds drift slowly and are made of two or three blocks */
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (var c = 0; c < this.clouds.length; c++) {
      var cl = this.clouds[c];
      var cxp = Pixel.s(((cl.x + this.time * cl.sp) % (VIEW_W + 400)) - 200 - this.cam.x * 0.05);
      var cyp = Pixel.s(cl.y - this.cam.y * 0.04);
      if (cxp > VIEW_W + 120 || cxp < -140) continue;
      Pixel.rect(ctx, cxp, cyp, cl.w, P * 3);
      Pixel.rect(ctx, cxp + P * 3, cyp - P * 3, cl.w - P * 6, P * 3);
      Pixel.rect(ctx, cxp + P * 2, cyp + P * 3, cl.w - P * 3, P * 2);
    }
  };

  World.prototype.drawPlatform = function (ctx, p) {
    var st = PLATFORM_STYLE[p.type] || PLATFORM_STYLE.solid;
    var P = Pixel.SIZE;
    Pixel.rect(ctx, p.x, p.y, p.w, p.h, st.body);
    Pixel.rect(ctx, p.x, p.y, p.w, Math.min(P * 2, p.h), st.top);
    Pixel.rect(ctx, p.x, p.y + p.h - P, p.w, P, st.edge);

    if (p.h > P * 8) {
      ctx.fillStyle = st.edge;
      for (var y = p.y + P * 5; y < p.y + p.h - P * 2; y += P * 7) {
        ctx.fillRect(Pixel.s(p.x + P), Pixel.s(y), Pixel.s(p.w - P * 2), P);
      }
    }
    if (p.type === 'bounce') {
      ctx.fillStyle = '#ffffff';
      for (var x = p.x + P; x < p.x + p.w - P * 2; x += P * 4) {
        ctx.fillRect(Pixel.s(x), Pixel.s(p.y + P), P * 2, P);
      }
    }
  };

  World.prototype.draw = function (ctx) {
    var i;
    ctx.save();
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    this.drawBackground(ctx);

    var sx = 0, sy = 0;
    if (this.shakeAmount > 0.4) {
      sx = U.rand(-this.shakeAmount, this.shakeAmount);
      sy = U.rand(-this.shakeAmount, this.shakeAmount);
    }
    /* scroll in whole pixels, or the whole grid shimmers */
    ctx.translate(-Pixel.s(this.cam.x) + Pixel.s(sx), -Pixel.s(this.cam.y) + Pixel.s(sy));

    /* hints sit behind everything */
    var hints = this.level.hints || [];
    for (i = 0; i < hints.length; i++) {
      Pixel.shadowText(ctx, hints[i].text, hints[i].x, hints[i].y, Pixel.SIZE,
                       'rgba(255,255,255,0.48)', 'center');
    }

    for (i = 0; i < this.checkpoints.length; i++) this.checkpoints[i].draw(ctx);
    this.goal.draw(ctx);

    for (i = 0; i < this.platforms.length; i++) this.drawPlatform(ctx, this.platforms[i]);
    this.gore.drawDecals(ctx);
    for (i = 0; i < this.doors.length; i++) this.doors[i].draw(ctx);
    for (i = 0; i < this.elevators.length; i++) this.elevators[i].draw(ctx);
    for (i = 0; i < this.props.length; i++) this.props[i].draw(ctx);
    for (i = 0; i < this.buttons.length; i++) this.buttons[i].draw(ctx);
    for (i = 0; i < this.hazards.length; i++) this.hazards[i].draw(ctx, this.time);
    for (i = 0; i < this.pickups.length; i++) this.pickups[i].draw(ctx);

    /* dead bodies under the living */
    for (i = 0; i < this.enemies.length; i++) if (this.enemies[i].dead) this.enemies[i].draw(ctx);
    for (i = 0; i < this.enemies.length; i++) if (!this.enemies[i].dead) this.enemies[i].draw(ctx);

    for (i = 0; i < this.players.length; i++) {
      var pl = this.players[i];
      if (pl === this.player || pl.dead || pl.finished) continue;
      pl.draw(ctx);
    }
    if (!this.player.dead && !this.player.finished) this.player.draw(ctx);

    this.gore.drawGibs(ctx);
    for (i = 0; i < this.bullets.length; i++) this.bullets[i].draw(ctx);
    this.fx.draw(ctx);

    /* glass on top so you see the player through it */
    for (i = 0; i < this.glass.length; i++) this.glass[i].draw(ctx, this.time);

    /* what the next shot will actually hit */
    var lock = this.player.aimTarget;
    if (lock && !this.player.dead) {
      var P2 = Pixel.SIZE;
      var lx = Pixel.s(lock.x), ly = Pixel.s(lock.y);
      var r2 = P2 * 6;
      var col = (lock.obj && lock.obj.type === 'barrel') ? '#ff6a4d' : '#ffd15c';
      Pixel.rect(ctx, lx - r2, ly - r2, P2 * 3, P2, col);
      Pixel.rect(ctx, lx - r2, ly - r2, P2, P2 * 3, col);
      Pixel.rect(ctx, lx + r2 - P2 * 3, ly - r2, P2 * 3, P2, col);
      Pixel.rect(ctx, lx + r2 - P2, ly - r2, P2, P2 * 3, col);
      Pixel.rect(ctx, lx - r2, ly + r2 - P2, P2 * 3, P2, col);
      Pixel.rect(ctx, lx - r2, ly + r2 - P2 * 3, P2, P2 * 3, col);
      Pixel.rect(ctx, lx + r2 - P2 * 3, ly + r2 - P2, P2 * 3, P2, col);
      Pixel.rect(ctx, lx + r2 - P2, ly + r2 - P2 * 3, P2, P2 * 3, col);
    }

    /* interaction highlight */
    if (this.player.prompt) {
      var o = this.player.prompt.obj;
      var bx = o.x + (o.w || 0) / 2, by = o.y + (o.h || 0) / 2;
      var r = Pixel.s(24 + (Math.sin(this.time * 6) > 0 ? Pixel.SIZE : 0));
      Pixel.frame(ctx, bx - r, by - r, r * 2, r * 2,
                  Math.floor(this.time * 8) % 2 ? '#ffd15c' : '#ffffff');
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

    /* off-screen markers */
    this.drawGoalArrow(ctx);
    if (this.mode === 'versus') this.drawRivalArrows(ctx);
  };

  World.prototype.drawRivalArrows = function (ctx) {
    for (var i = 0; i < this.players.length; i++) {
      var p = this.players[i];
      if (p === this.player || p.dead || p.finished) continue;
      var sx = p.x + p.w / 2 - this.cam.x;
      var sy = p.y + p.h / 2 - this.cam.y;
      if (sx > 16 && sx < VIEW_W - 16 && sy > 16 && sy < VIEW_H - 16) continue;
      var cx = VIEW_W / 2, cy = VIEW_H / 2;
      var a = Math.atan2(sy - cy, sx - cx);
      var r = Math.min(VIEW_W, VIEW_H) * 0.46;
      this.drawPixelArrow(ctx, cx + Math.cos(a) * r, cy + Math.sin(a) * r, a, p.palette.mark);
    }
  };

  /* A stepped triangle, built from rows of blocks so it stays on grid. */
  World.prototype.drawPixelArrow = function (ctx, x, y, angle, color) {
    var P = Pixel.SIZE;
    ctx.save();
    ctx.translate(Pixel.s(x), Pixel.s(y));
    ctx.rotate(Math.round(angle / (Math.PI / 4)) * (Math.PI / 4));
    ctx.fillStyle = color;
    for (var i = 0; i < 4; i++) {
      ctx.fillRect(-P * 3 + i * P, -P * (4 - i), P, P * (8 - i * 2));
    }
    ctx.restore();
  };

  World.prototype.drawGoalArrow = function (ctx) {
    var gx = this.goal.x + this.goal.w / 2 - this.cam.x;
    var gy = this.goal.y + this.goal.h / 2 - this.cam.y;
    if (gx > 20 && gx < VIEW_W - 20 && gy > 20 && gy < VIEW_H - 20) return;
    var cx = VIEW_W / 2, cy = VIEW_H / 2;
    var a = Math.atan2(gy - cy, gx - cx);
    var r = Math.min(VIEW_W, VIEW_H) * 0.42;
    var px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
    this.drawPixelArrow(ctx, px, py, a, '#57e07a');
  };

  root.World = World;
  root.VIEW_W = VIEW_W;
  root.VIEW_H = VIEW_H;
})(typeof window !== 'undefined' ? window : globalThis);
