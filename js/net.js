/* ============================================================
   net.js - LAN client

   The host runs the real simulation; this just ships key state up
   and eases the world toward the snapshots coming back, so four
   machines agree on where everyone is.
   ============================================================ */
(function (root) {
  'use strict';

  function NetClient(hooks) {
    this.hooks = hooks || {};
    this.sock = null;
    this.slot = -1;
    this.connected = false;
    this.snap = null;
    this.prevSnap = null;
    this.snapAge = 0;
    this.status = 'idle';
    this.error = '';
  }

  NetClient.prototype.connect = function (host) {
    var self = this;
    var url = host;
    if (!/^wss?:\/\//.test(url)) {
      var clean = url.replace(/^https?:\/\//, '').replace(/\/+$/, '');
      if (!/:\d+$/.test(clean)) clean += ':8080';
      url = (root.location && root.location.protocol === 'https:' ? 'wss://' : 'ws://') + clean;
    }
    this.status = 'connecting';
    try {
      this.sock = new WebSocket(url);
    } catch (e) {
      this.status = 'error';
      this.error = 'bad address';
      return;
    }

    this.sock.onopen = function () {
      self.connected = true;
      self.status = 'connected';
      if (self.hooks.open) self.hooks.open();
    };
    this.sock.onclose = function () {
      self.connected = false;
      if (self.status !== 'error') self.status = 'closed';
      if (self.hooks.close) self.hooks.close();
    };
    this.sock.onerror = function () {
      self.status = 'error';
      self.error = 'could not reach host';
      if (self.hooks.error) self.hooks.error();
    };
    this.sock.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.t === 'hello') {
        self.slot = msg.slot;
        if (self.hooks.hello) self.hooks.hello(msg);
      } else if (msg.t === 'full') {
        self.status = 'error';
        self.error = 'game is full';
      } else if (msg.t === 'round') {
        if (self.hooks.round) self.hooks.round(msg);
      } else if (msg.t === 'match') {
        if (self.hooks.match) self.hooks.match(msg);
      } else if (msg.t === 's') {
        self.prevSnap = self.snap;
        self.snap = msg;
        self.snapAge = 0;
      }
    };
  };

  NetClient.prototype.close = function () {
    if (this.sock) { try { this.sock.close(); } catch (e) { /* already closed */ } }
    this.sock = null;
    this.connected = false;
  };

  NetClient.prototype.send = function (obj) {
    if (!this.connected || !this.sock) return;
    try { this.sock.send(JSON.stringify(obj)); } catch (e) { /* dropped */ }
  };

  NetClient.prototype.sendInput = function (input) {
    this.send({
      t: 'i',
      l: input.left(), r: input.right(), j: input.jump(),
      je: input.jumpPressed(), ip: input.interactPressed(), ih: input.interactHeld(),
      f: input.firePressed(), fh: input.fireHeld(), dr: input.dropPressed()
    });
  };

  /* Ease the rendered world toward the authoritative state. Geometry the
     host owns (lifts, doors, blades, broken glass) is set outright; players
     are eased so 30Hz snapshots do not read as a stutter. */
  NetClient.prototype.apply = function (world, dt) {
    var s = this.snap;
    if (!s || !world) return;
    this.snapAge += dt;
    var k = 1 - Math.exp(-18 * dt);
    var i;

    for (i = 0; i < world.players.length && i < s.p.length; i++) {
      var p = world.players[i], q = s.p[i];
      if (p.netInit) {
        p.x += (q.x - p.x) * k;
        p.y += (q.y - p.y) * k;
      } else {
        p.x = q.x; p.y = q.y; p.netInit = true;
      }
      p.angle += (q.a - p.angle) * k;
      p.facing = q.f;
      p.health = q.h;
      p.dead = !!q.d;
      p.finished = !!q.fin;
      p.wins = q.wn;
      if (q.w) {
        if (!p.weapon || p.weapon.key !== q.w) p.weapon = { key: q.w, ammo: q.am };
        else p.weapon.ammo = q.am;
      } else {
        p.weapon = null;
      }
    }

    for (i = 0; i < world.elevators.length && i < s.ev.length; i++) {
      var e = world.elevators[i];
      e.dx = s.ev[i].x - e.x;
      e.dy = s.ev[i].y - e.y;
      e.x = s.ev[i].x; e.y = s.ev[i].y;
    }
    for (i = 0; i < world.doors.length && i < s.dz.length; i++) {
      world.doors[i].x = s.dz[i].x; world.doors[i].y = s.dz[i].y;
    }
    for (i = 0; i < world.hazards.length && i < s.hz.length; i++) {
      world.hazards[i].x = s.hz[i].x; world.hazards[i].y = s.hz[i].y;
    }
    for (i = 0; i < world.glass.length && i < s.gl.length; i++) {
      if (s.gl[i] && !world.glass[i].broken) world.glass[i].shatter(world, 0, 0);
    }
    for (i = 0; i < world.props.length && i < s.pr.length; i++) {
      var pr = world.props[i], q = s.pr[i];
      if (q.b) {
        if (!pr.broken) {
          if (pr.type === 'barrel') pr.blowUp(world); else pr.smash(world);
        }
        continue;
      }
      pr.x = q.x; pr.y = q.y;
      pr.fuse = q.f ? 0.2 : 0;
    }

    /* pickups are rebuilt wholesale: they are few and they come and go */
    if (s.pk) {
      world.pickups.length = 0;
      for (i = 0; i < s.pk.length; i++) {
        var pk = new Pickup(s.pk[i].x + 15, s.pk[i].y + 10, s.pk[i].k,
                            WEAPONS[s.pk[i].k] ? WEAPONS[s.pk[i].k].ammo : 0);
        pk.grounded = true;
        world.pickups.push(pk);
      }
    }

    world.elapsed = s.e;
    world.roundOver = !!s.over;
    world.buildSolids();
  };

  root.NetClient = NetClient;
})(typeof window !== 'undefined' ? window : globalThis);
