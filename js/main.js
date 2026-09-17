/* ============================================================
   main.js - boot, scaling, the loop, the state machine
   ============================================================ */
(function (root) {
  'use strict';

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');

  var Game = {
    state: 'menu',        /* menu | playing | paused | complete */
    world: null,
    levelIndex: 0,

    start: function (index) {
      Sound.unlock();
      this.levelIndex = U.clamp(index, 0, LEVELS.length - 1);
      this.world = new World(this.levelIndex, {
        toast: function (m) { UI.toast(m); },
        complete: function (t) { Game.onComplete(t); }
      });
      this.state = 'playing';
      Input.clearAll();
      UI.showGame();
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
      this.world = null;
      UI.show('menu');
    },

    onComplete: function (seconds) {
      this.state = 'complete';
      UI.showComplete(this.levelIndex, seconds);
    },

    update: function (dt) {
      if (this.state === 'playing') {
        if (Input.pressed('KeyP') || Input.pressed('Escape')) { this.pause(); return; }
        if (Input.pressed('Enter')) { this.start(this.levelIndex); return; }
        this.world.update(dt, Input);
        UI.updateHUD(this.world, dt);
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
      if (this.world) {
        this.world.draw(ctx);
        if (this.state === 'paused' || this.state === 'complete') {
          ctx.fillStyle = 'rgba(8,10,18,0.55)';
          ctx.fillRect(0, 0, VIEW_W, VIEW_H);
        }
      } else {
        drawMenuBackdrop();
      }
    }
  };

  /* -------------------------------------------------- menu backdrop */
  var menuT = 0;
  var skyline = [];
  (function () {
    var seed = 7;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (var i = 0; i < 46; i++) {
      skyline.push({ x: rnd() * 1100 - 60, w: 50 + rnd() * 130, h: 110 + rnd() * 330, layer: i % 2, lit: rnd() });
    }
  })();

  function drawMenuBackdrop() {
    var g = ctx.createLinearGradient(0, 0, 0, VIEW_H);
    g.addColorStop(0, '#161d38');
    g.addColorStop(0.55, '#3a2748');
    g.addColorStop(1, '#8a4a4a');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);

    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.arc(760, 110, 52, 0, 6.2832);
    ctx.fill();

    var drift = Math.sin(menuT * 0.12) * 18;
    [{ p: 0.4, c: 'rgba(14,18,34,0.7)', o: 40 }, { p: 1, c: 'rgba(9,12,24,0.95)', o: 0 }].forEach(function (lay, li) {
      ctx.fillStyle = lay.c;
      skyline.forEach(function (b) {
        if (b.layer !== li) return;
        var bx = b.x + drift * lay.p;
        var by = VIEW_H - b.h + lay.o;
        ctx.fillRect(bx, by, b.w, b.h + 200);
        if (li === 1 && b.lit > 0.4) {
          ctx.fillStyle = 'rgba(255,205,110,0.12)';
          for (var wy = by + 14; wy < by + b.h - 10; wy += 24) {
            for (var wx = bx + 9; wx < bx + b.w - 12; wx += 20) {
              if (((wx * 7 + wy * 13 + Math.floor(menuT * 0.6)) % 7) < 2) ctx.fillRect(wx, wy, 8, 11);
            }
          }
          ctx.fillStyle = lay.c;
        }
      });
    });

    var vg = ctx.createRadialGradient(VIEW_W / 2, VIEW_H / 2, 140, VIEW_W / 2, VIEW_H / 2, 520);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  }

  /* -------------------------------------------------- scaling */
  function resize() {
    var shell = document.getElementById('shell');
    var pad = 24;
    var s = Math.min((root.innerWidth - pad) / VIEW_W, (root.innerHeight - pad) / VIEW_H);
    s = Math.max(0.35, Math.min(s, 2.2));
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
