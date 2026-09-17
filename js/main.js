/* ============================================================
   main.js - boot, scaling, the loop, the state machine
   ============================================================ */
(function (root) {
  'use strict';

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  /* Everything is drawn small and blown up, so a pixel is a pixel. The
     buffer is the camera's view; the canvas it lands on is 960x540. */
  var CANVAS_W = 960, CANVAS_H = 540;
  var pctx = Pixel.init(VIEW_W, VIEW_H);
  void pctx;

  var Game = {
    state: 'menu',        /* menu | playing | paused | complete | roundend | matchend | lan */
    mode: 'campaign',     /* campaign | versus | lan */
    world: null,
    match: null,
    net: null,
    levelIndex: 0,
    humans: 1,

    start: function (index) {
      Sound.unlock();
      this.mode = 'campaign';
      this.match = null;
      this.closeNet();
      this.levelIndex = U.clamp(index, 0, LEVELS.length - 1);
      this.world = new World(this.levelIndex, {
        toast: function (m) { UI.toast(m); },
        complete: function (t) { Game.onComplete(t); }
      }, { goreLevel: UI.save.gore });
      this.state = 'playing';
      Input.clearAll();
      UI.showGame();
    },

    /* ------------------------------------------------------ versus */
    startVersus: function (cfg) {
      Sound.unlock();
      this.mode = 'versus';
      this.closeNet();
      this.humans = cfg.humans;
      this.match = new Match({ target: cfg.target, slots: cfg.slots, rotation: [0, 1, 2] });
      this.startRound();
    },

    startRound: function () {
      var m = this.match;
      this.world = new World(m.mapIndex(), {
        toast: function (t) { UI.toast(t); },
        roundWin: function (p, w) { Game.onRoundWin(p, w); }
      }, {
        mode: 'versus',
        levels: VERSUS_MAPS,
        players: m.playerDefs(),
        localIndex: 0,
        goreLevel: UI.save.gore
      });
      this.state = 'playing';
      this.roundHold = 0;
      Input.clearAll();
      UI.showGame();
      UI.toast(m.mapName());
    },

    onRoundWin: function (p) {
      this.roundHold = 2.2;      /* let the celebration land before the board */
    },

    finishRound: function () {
      var winner = this.world.roundWinner;
      this.match.recordRound(winner ? winner.index : -1, this.world);
      if (this.match.champion() >= 0) {
        this.state = 'matchend';
        UI.showMatchEnd(this.match);
      } else {
        this.state = 'roundend';
        UI.showRoundEnd(this.match, this.world);
      }
    },

    nextRound: function () {
      if (!this.match) { this.toMenu(); return; }
      this.startRound();
    },

    /* ------------------------------------------------------ LAN */
    joinLan: function (host) {
      var self = this;
      this.closeNet();
      this.mode = 'lan';
      UI.lanStatus('Connecting to ' + host + '…');
      this.net = new NetClient({
        open: function () { UI.lanStatus('Connected. Waiting for the first round…'); },
        error: function () { UI.lanStatus('Could not reach ' + host + '. Is the host running?'); },
        close: function () {
          UI.lanStatus('Disconnected.');
          if (self.mode === 'lan') { self.mode = 'campaign'; self.world = null; self.state = 'menu'; UI.show('lan'); }
        },
        round: function (msg) { self.onNetRound(msg); },
        match: function (msg) { self.onNetMatch(msg); }
      });
      this.net.connect(host);
    },

    onNetRound: function (msg) {
      var defs = msg.slots.map(function (s) {
        return { name: s.name, isBot: false, wins: s.wins };   /* the host drives everyone */
      });
      this.world = new World(msg.map, { toast: function (t) { UI.toast(t); } }, {
        mode: 'versus', levels: VERSUS_MAPS, players: defs,
        localIndex: this.net.slot < 0 ? 0 : this.net.slot,
        goreLevel: UI.save.gore
      });
      this.world.players.forEach(function (p) { p.brain = null; p.netInit = false; });
      this.state = 'playing';
      Input.clearAll();
      UI.showGame();
      UI.toast(msg.name);
    },

    onNetMatch: function (msg) {
      this.state = 'matchend';
      var fake = { slots: msg.slots, target: 99, champion: function () { return msg.champion; },
                   standings: function () {
                     return msg.slots.map(function (s, i) { return { index: i, name: s.name, wins: s.wins, isBot: false }; })
                       .sort(function (a, b) { return b.wins - a.wins; });
                   } };
      fake.target = Math.max.apply(null, msg.slots.map(function (s) { return s.wins; }));
      UI.showMatchEnd(fake);
    },

    closeNet: function () {
      if (this.net) { this.net.close(); this.net = null; }
    },

    resume: function () {
      if (!this.world) return;
      this.state = 'playing';
      Input.clearAll();
      UI.showGame();
    },

    pause: function () {
      if (this.state !== 'playing') return;
      this.state = 'paused';
      UI.show('pause');
    },

    toMenu: function () {
      this.state = 'menu';
      this.mode = 'campaign';
      this.world = null;
      this.match = null;
      this.closeNet();
      UI.show('menu');
    },

    onComplete: function (seconds) {
      this.state = 'complete';
      UI.showComplete(this.levelIndex, seconds);
    },

    update: function (dt) {
      if (this.state === 'playing') {
        if (Input.pressed('KeyP') || Input.pressed('Escape')) { this.pause(); return; }

        if (this.mode === 'lan') {
          this.net.sendInput(Input.pads()[0]);
          this.net.apply(this.world, dt);
          this.world.fx.update(dt, this.world);
          this.world.gore.update(dt, this.world);
          this.world.goal.update(dt);
          this.world.time += dt;
          this.world.updateCamera(dt);
          UI.updateHUD(this.world, dt);
          UI.updateScoreboard(this.world, this.match);
          return;
        }

        if (this.mode === 'versus') {
          var pads = Input.pads();
          var inputs = [];
          for (var i = 0; i < this.humans; i++) inputs[i] = pads[i] || pads[0];
          this.world.update(dt, inputs);
          UI.updateHUD(this.world, dt);
          UI.updateScoreboard(this.world, this.match);
          if (this.roundHold > 0) {
            this.roundHold -= dt;
            if (this.roundHold <= 0) this.finishRound();
          }
          return;
        }

        if (Input.pressed('Enter')) { this.start(this.levelIndex); return; }
        this.world.update(dt, Input);
        UI.updateHUD(this.world, dt);
        UI.updateScoreboard(this.world, null);
      } else if (this.state === 'roundend') {
        if (Input.pressed('Enter') || Input.pressed('Space')) this.nextRound();
      } else if (this.state === 'paused') {
        if (Input.pressed('KeyP') || Input.pressed('Escape')) this.resume();
      } else if (this.state === 'complete') {
        if (Input.pressed('Enter')) {
          var n = this.levelIndex + 1;
          if (n < LEVELS.length) this.start(n); else this.toMenu();
        }
      } else if (this.state === 'menu') {
        if (Input.pressed('Enter')) this.start(UI.firstUnfinished());
      }
    },

    draw: function () {
      var b = Pixel.begin();
      if (this.world) {
        this.world.draw(b);
        this.drawHud(b);
      } else {
        drawMenuBackdrop(b);
      }
      Pixel.blit(ctx, CANVAS_W, CANVAS_H);
      if (this.world && (this.state === 'paused' || this.state === 'complete' ||
                         this.state === 'roundend' || this.state === 'matchend')) {
        ctx.fillStyle = 'rgba(10,14,22,0.5)';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      }
    },

    /* The HUD belongs on the pixel grid too, or it fights the art. */
    drawHud: function (b) {
      if (this.state === 'menu') return;
      var w = this.world, P = Pixel.SIZE;
      var pad = P * 3;

      /* left: clock and where you are */
      Pixel.shadowText(b, U.formatTime(w.elapsed), pad, pad, P * 3, '#ffffff');
      /* Just the number here - the map announces itself on the toast when
         the round starts, and the full name does not fit beside the scores. */
      var label = w.mode === 'versus'
        ? 'ROUND ' + ((this.match ? this.match.roundIndex : 0) + 1)
        : 'LEVEL ' + (w.levelIndex + 1);
      Pixel.shadowText(b, label, pad, pad + P * 18, P * 2, '#eaf6ff');

      /* centre: one colour block and a score per racer, in a row */
      if (w.mode === 'versus') {
        var n = w.players.length;
        var cell = P * 16;
        var x0 = VIEW_W / 2 - (n * cell) / 2;
        for (var i = 0; i < n; i++) {
          var p = w.players[i];
          var bx = x0 + i * cell;
          Pixel.rect(b, bx, pad, P * 6, P * 6, p.palette.mark);
          Pixel.frame(b, bx, pad, P * 6, P * 6, p === w.player ? '#ffffff' : 'rgba(0,0,0,0.35)');
          Pixel.shadowText(b, String(p.wins), bx + P * 8, pad + P, P * 2, '#ffffff');
        }
      }

      /* right: condition and what you are holding */
      var hp = U.clamp(w.player.health / w.player.maxHealth, 0, 1);
      var barW = P * 24;
      Pixel.rect(b, VIEW_W - pad - barW, pad, barW, P * 4, 'rgba(0,0,0,0.45)');
      if (hp > 0) {
        Pixel.rect(b, VIEW_W - pad - barW, pad, barW * hp, P * 4, hp > 0.35 ? '#ff4d5e' : '#ff8a3c');
      }
      Pixel.frame(b, VIEW_W - pad - barW, pad, barW, P * 4, '#ffffff');

      var wep = w.player.weapon;
      Pixel.shadowText(b, wep ? WEAPONS[wep.key].short + ' ' + wep.ammo : 'UNARMED',
                       VIEW_W - pad, pad + P * 7, P, wep ? '#ffd15c' : '#eaf6ff', 'right');

      /* context prompt, just above the floor of the frame */
      if (w.player.prompt) {
        var t = w.player.prompt.label;
        var tw = Pixel.textWidth(t, P);
        var pw = tw + P * 12;
        var px = VIEW_W / 2 - pw / 2;
        var py = VIEW_H - P * 16;
        Pixel.rect(b, px, py, pw, P * 8, 'rgba(10,20,30,0.7)');
        Pixel.frame(b, px, py, pw, P * 8, '#ffd15c');
        Pixel.text(b, 'R', px + P * 3, py + P * 2, P * 2, '#ffd15c');
        Pixel.text(b, t, px + P * 9, py + P * 3, P, '#ffffff');
      }

      if (UI.toastTimer > 0) {
        Pixel.shadowText(b, UI.toastText || '', VIEW_W / 2, VIEW_H * 0.30, P * 2, '#ffd15c', 'center');
      }
    }
  };

  /* -------------------------------------------------- menu backdrop */
  var menuT = 0;
  var skyline = [];
  (function () {
    var seed = 7;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (var i = 0; i < 40; i++) {
      var layer = i % 2;
      skyline.push({
        x: rnd() * 820 - 60,
        w: 42 + rnd() * 96,
        /* low horizon, same as in the maps, so the sky carries the frame */
        h: layer === 0 ? 45 + rnd() * 90 : 66 + rnd() * 132,
        layer: layer,
        lit: rnd()
      });
    }
  })();

  function drawMenuBackdrop(b) {
    var P = Pixel.SIZE;
    b.fillStyle = '#2fb6ea';
    b.fillRect(0, 0, VIEW_W, VIEW_H);
    Pixel.disc(b, 770, 104, 36, 'rgba(255,255,255,0.22)');

    var drift = Math.sin(menuT * 0.12) * 18;
    [{ p: 0.4, c: '#86d4f0', o: 0, win: null },
     { p: 1.0, c: '#d5c9a2', o: 0, win: 'rgba(92,80,58,0.30)' }].forEach(function (lay, li) {
      skyline.forEach(function (bd) {
        if (bd.layer !== li) return;
        var bx = Pixel.s(bd.x + drift * lay.p);
        var by = Pixel.s(VIEW_H - bd.h + lay.o);
        Pixel.rect(b, bx, by, bd.w, bd.h + 300, lay.c);
        if (lay.win && bd.lit > 0.35) {
          b.fillStyle = lay.win;
          var cols = Math.max(1, Math.floor((bd.w - P * 4) / (P * 5)));
          for (var wy = by + P * 4; wy < by + bd.h - P * 4; wy += P * 6) {
            for (var c3 = 0; c3 < cols; c3++) {
              var wx = bx + P * 3 + c3 * P * 5;
              if (((c3 * 3 + Math.round(wy / P)) % 7) < 5) b.fillRect(Pixel.s(wx), Pixel.s(wy), P * 2, P * 3);
            }
          }
        }
      });
    });

    b.fillStyle = 'rgba(255,255,255,0.8)';
    for (var c = 0; c < 6; c++) {
      var cx = Pixel.s(((c * 190 + menuT * 7) % (VIEW_W + 300)) - 150);
      var cy = Pixel.s(50 + (c % 3) * 52);
      Pixel.rect(b, cx, cy, P * 14, P * 3);
      Pixel.rect(b, cx + P * 3, cy - P * 3, P * 8, P * 3);
    }
  }

  /* -------------------------------------------------- scaling */
  function resize() {
    var shell = document.getElementById('shell');
    var pad = 8;
    var s = Math.min((root.innerWidth - pad) / CANVAS_W, (root.innerHeight - pad) / CANVAS_H);
    s = Math.max(0.35, Math.min(s, 4));
    shell.style.transform = 'scale(' + s + ')';
  }

  /* -------------------------------------------------- loop */
  var last = 0, acc = 0;
  var STEP = 1 / 120;

  function frame(ts) {
    if (!last) last = ts;
    var dt = (ts - last) / 1000;
    last = ts;
    if (dt > 0.25) dt = 0.25;      /* tab was in the background */
    menuT += dt;

    acc += dt;
    var guard = 0;
    while (acc >= STEP && guard++ < 8) {
      Game.update(STEP);
      Input.clearFrame();
      acc -= STEP;
    }
    if (guard === 0) Input.clearFrame();

    Game.draw();
    requestAnimationFrame(frame);
  }

  /* -------------------------------------------------- boot */
  Input.init(canvas);
  UI.init(Game);
  UI.show('menu');
  resize();
  root.addEventListener('resize', resize);
  root.addEventListener('pointerdown', function unlock() {
    Sound.unlock();
    root.removeEventListener('pointerdown', unlock);
  });
  root.addEventListener('keydown', function unlockK() {
    Sound.unlock();
    root.removeEventListener('keydown', unlockK);
  });
  requestAnimationFrame(frame);

  root.Game = Game;
})(window);
