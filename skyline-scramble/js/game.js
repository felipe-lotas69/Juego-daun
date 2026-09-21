/* ============================================================
   game.js - screens, the HUD, and the loop that ties it together.
   ============================================================ */
(function (root) {
  'use strict';

  var canvas = document.getElementById('screen');
  var CANVAS_W = 1280, CANVAS_H = 720;
  var ctx = Pixel.init(canvas);

  /* W and E lean left and right and let go to jump; R spends the item.
     Two keys side by side, because the wind-up wants a key you can hold
     without thinking about which finger is where. */
  var SCHEMES = [
    { left: 'KeyW', right: 'KeyE', item: 'KeyR', label: 'W  E  R' },
    { left: 'ArrowLeft', right: 'ArrowRight', item: 'ArrowUp', label: '< > ^' }
  ];

  var TARGET_WINS = 3;

  var Game = {
    state: 'menu',
    menuIndex: 0,
    menuItems: ['ONE PLAYER', 'TWO PLAYER', 'CONTROLS'],
    world: null,
    bots: [],
    humans: 1,
    roundIndex: 0,
    time: 0,
    toast: '',
    toastT: 0,
    banner: '',
    bannerT: 0,
    countdown: 0,

    /* ------------------------------------------------------ flow */
    startMatch: function (humans) {
      this.humans = humans;
      this.roundIndex = 0;
      this.scores = [0, 0, 0, 0];
      this.startRound();
    },

    startRound: function () {
      var self = this;
      var level = LEVELS[this.roundIndex % LEVELS.length];
      this.world = new World(level, {
        toast: function (t) { self.toast = t; self.toastT = 1.1; },
        pickup: function () { self.toast = 'ITEM'; self.toastT = 0.8; },
        fell: function (r) { self.toast = r.name + ' DOWN'; self.toastT = 0.9; },
        finished: function (r, place) {
          if (place === 1) {
            self.scores[r.index]++;
            self.banner = r.name + ' GETS AWAY';
            self.bannerT = 2.2;
            self.state = 'roundover';
            if (self.scores[r.index] >= TARGET_WINS) {
              self.banner = r.name + ' WINS THE MATCH';
              self.state = 'matchover';
            }
          }
        }
      });
      this.bots = [];
      for (var i = 0; i < 4; i++) {
        var isBot = i >= this.humans;
        var r = this.world.addRacer({
          index: i, isBot: isBot,
          keys: isBot ? null : SCHEMES[i]
        });
        r.wins = this.scores[i];
        this.bots.push(isBot ? new Bot(r, i) : null);
      }
      this.world.follow(this.world.focus(this.humans), 0, true);
      this.countdown = 2.2;
      this.state = 'playing';
      this.banner = LEVELS[this.roundIndex % LEVELS.length].name;
      this.bannerT = 1.8;
    },

    nextRound: function () {
      this.roundIndex++;
      this.startRound();
    },

    toMenu: function () {
      this.state = 'menu';
      this.world = null;
    },

    /* ----------------------------------------------------- update */
    update: function (dt) {
      this.time += dt;
      if (this.toastT > 0) this.toastT -= dt;
      if (this.bannerT > 0) this.bannerT -= dt;

      if (this.state === 'menu') return this.menuUpdate();
      if (this.state === 'controls') {
        if (anyKey()) this.state = 'menu';
        return;
      }
      if (this.state === 'roundover') {
        if (Input.pressed('Enter') || Input.pressed('Space')) this.nextRound();
        return;
      }
      if (this.state === 'matchover') {
        if (Input.pressed('Enter') || Input.pressed('Space')) this.toMenu();
        return;
      }
      if (this.state === 'paused') {
        if (Input.pressed('KeyP') || Input.pressed('Escape')) this.state = 'playing';
        if (Input.pressed('Backspace')) this.toMenu();
        return;
      }

      /* playing */
      if (Input.pressed('KeyP') || Input.pressed('Escape')) { this.state = 'paused'; return; }
      if (this.countdown > 0) {
        this.countdown -= dt;
        this.world.follow(this.world.focus(this.humans), dt);
        return;
      }

      var inputs = [];
      for (var i = 0; i < this.world.racers.length; i++) {
        var r = this.world.racers[i];
        if (r.isBot) {
          inputs.push(this.bots[i].update(dt, this.world));
        } else {
          var k = r.keys;
          inputs.push({
            left: Input.isDown(k.left),
            right: Input.isDown(k.right),
            item: Input.pressed(k.item)
          });
        }
      }
      this.world.update(dt, inputs);
      this.world.follow(this.world.focus(this.humans), dt);
    },

    menuUpdate: function () {
      var n = this.menuItems.length;
      if (Input.pressed('ArrowDown') || Input.pressed('KeyS')) this.menuIndex = (this.menuIndex + 1) % n;
      if (Input.pressed('ArrowUp') || Input.pressed('KeyW')) this.menuIndex = (this.menuIndex + n - 1) % n;
      if (Input.pressed('Enter') || Input.pressed('Space')) {
        if (this.menuIndex === 0) this.startMatch(1);
        else if (this.menuIndex === 1) this.startMatch(2);
        else this.state = 'controls';
      }
    },

    /* ------------------------------------------------------- draw */
    draw: function () {
      /* The backdrop goes down first, in screen space, where a gradient
         can be a gradient. Everything after it is world space, where a
         unit is a block. */
      var w = this.world || menuWorld();
      var sc = Pixel.screen(true);
      Draw.backdrop(sc, w.level, { x: Math.round(w.cam.x), y: Math.round(w.cam.y) }, this.time);

      var c = Pixel.begin();
      if (this.state === 'menu') this.drawMenu(c);
      else if (this.state === 'controls') this.drawControls(c);
      else {
        Draw.world(c, this.world, this.time);
        this.drawHud(c);
        if (this.countdown > 0) {
          var n = Math.ceil(this.countdown - 0.2);
          if (n > 0) Pixel.outlineText(c, String(n), Pixel.W / 2, 64, 4, '#ffc23c', '#101018', 'center');
          else Pixel.outlineText(c, 'GO', Pixel.W / 2, 64, 4, '#57c96a', '#101018', 'center');
        }
        if (this.state === 'paused') {
          Pixel.rect(c, 0, 0, Pixel.W, Pixel.H, 'rgba(12,14,22,0.66)');
          Pixel.outlineText(c, 'PAUSED', Pixel.W / 2, 70, 3, '#ffffff', '#101018', 'center');
          Pixel.text(c, 'P TO RESUME   BACKSPACE TO QUIT', Pixel.W / 2, 100, 1, '#c8d2e0', 'center');
        }
        if (this.state === 'roundover' || this.state === 'matchover') {
          Pixel.rect(c, 0, 0, Pixel.W, Pixel.H, 'rgba(12,14,22,0.6)');
          Pixel.outlineText(c, this.banner, Pixel.W / 2, 62, 2, '#ffc23c', '#101018', 'center');
          this.drawScoreboard(c, 88);
          Pixel.text(c, this.state === 'matchover' ? 'ENTER FOR THE MENU' : 'ENTER FOR THE NEXT MAP',
                     Pixel.W / 2, 156, 1, '#ffffff', 'center');
        }
      }
    },

    /* Portraits and scores at the edges, the race in the middle - you
       should be able to see who is winning without reading anything. */
    drawHud: function (c) {
      var w = this.world, i;

      Pixel.rect(c, 4, 4, 3, 9, '#ffffff');
      Pixel.rect(c, 9, 4, 3, 9, '#ffffff');

      for (i = 0; i < w.racers.length; i++) {
        var r = w.racers[i];
        var left = i < 2;
        var slot = left ? i : (i - 2);
        var x = left ? 18 + slot * 32 : Pixel.W - 68 + slot * 32;
        this.drawPortrait(c, r, x, 3);
        Pixel.rect(c, x + 13, 3, 9, 13, '#101018');
        Pixel.rect(c, x + 14, 4, 7, 11, r.def.mark);
        Pixel.text(c, String(this.scores[i]), x + 16, 6, 1, '#101018');
      }

      /* the race bar: everyone's furthest point, on one line */
      var bx = 112, bw = 96, by = 8;
      Pixel.rect(c, bx, by, bw, 1, '#ffffff');
      Pixel.rect(c, bx, by - 3, 1, 7, '#ffffff');
      Pixel.rect(c, bx + bw - 1, by - 3, 1, 7, '#ffffff');
      for (i = 0; i < w.racers.length; i++) {
        var rr = w.racers[i];
        var t = U.clamp((rr.best - w.level.spawn.x) / (w.level.goal.x - w.level.spawn.x), 0, 1);
        this.drawPortrait(c, rr, Math.round(bx + t * (bw - 10)) - 4, by - 6, true);
      }

      if (this.toastT > 0) {
        Pixel.outlineText(c, this.toast, Pixel.W / 2, 30, 1, '#ffc23c', '#101018', 'center');
      }
      if (this.bannerT > 0 && this.state === 'playing') {
        Pixel.outlineText(c, this.banner, Pixel.W / 2, 44, 2, '#ffffff', '#101018', 'center');
      }

      /* what the local players are holding */
      for (i = 0; i < this.humans; i++) {
        var hp = w.racers[i];
        var hx = i === 0 ? 5 : Pixel.W - 17;
        Pixel.rect(c, hx, Pixel.H - 15, 12, 12, 'rgba(16,20,30,0.66)');
        Pixel.frame(c, hx, Pixel.H - 15, 12, 12, hp.item ? '#ffc23c' : hp.def.mark);
        if (hp.item) Pixel.stamp(c, ART.ITEMS[hp.item], ART.ITEM_MAP, hx + 6, Pixel.H - 9, 0, false);
        else Pixel.text(c, '-', hx + 4, Pixel.H - 12, 1, '#5a6478');
      }
    },

    drawPortrait: function (c, r, x, y, small) {
      var sprite = ART.HEADS[r.def.head];
      var map = {
        k: r.def.hair, s: r.def.skin, t: Draw.mix(r.def.skin, '#000000', 0.2),
        n: r.def.skin, m: Draw.mix(r.def.skin, '#000000', 0.35),
        e: '#20232f', o: '#20232f'
      };
      if (!small) {
        Pixel.rect(c, x, y, 12, 13, '#101018');
        Pixel.rect(c, x + 1, y + 1, 10, 11, Draw.mix(r.def.mark, '#ffffff', 0.55));
      }
      Pixel.stamp(c, sprite, map, x + (small ? 4 : 6), y + (small ? 5 : 7), 0, false);
    },

    drawScoreboard: function (c, y) {
      for (var i = 0; i < this.world.racers.length; i++) {
        var r = this.world.racers[i];
        var rowY = y + i * 15;
        Pixel.rect(c, 96, rowY, 128, 13, 'rgba(16,20,30,0.7)');
        Pixel.rect(c, 96, rowY, 2, 13, r.def.mark);
        this.drawPortrait(c, r, 101, rowY, true);
        Pixel.text(c, r.name + (r.isBot ? '' : ' (YOU)'), 116, rowY + 3, 1, '#ffffff');
        Pixel.text(c, String(this.scores[i]), 216, rowY + 3, 1, '#ffc23c', 'right');
      }
    },

    /* ------------------------------------------------------ menus */
    drawMenu: function (c) {
      var L = LEVELS[0];
      Draw.world(c, menuWorld(), this.time);
      Pixel.rect(c, 0, 0, Pixel.W, Pixel.H, 'rgba(10,16,30,0.28)');

      Pixel.outlineText(c, 'SKYLINE', Pixel.W / 2, 16, 4, '#ffffff', '#101018', 'center');
      Pixel.outlineText(c, 'SCRAMBLE', Pixel.W / 2, 46, 4, '#ffc23c', '#101018', 'center');
      Pixel.outlineText(c, 'YOU CANNOT WALK. LEAN, LET GO, PRAY.',
                        Pixel.W / 2, 80, 1, '#dbe6f2', '#101018', 'center');

      for (var i = 0; i < this.menuItems.length; i++) {
        var y = 98 + i * 20;
        var on = i === this.menuIndex;
        var w = 92, x = Pixel.W / 2 - w / 2;
        Pixel.rect(c, x, y, w, 15, on ? '#ffc23c' : 'rgba(16,20,30,0.72)');
        Pixel.frame(c, x, y, w, 15, on ? '#ffffff' : '#5a6478');
        Pixel.text(c, this.menuItems[i], Pixel.W / 2, y + 4, 1,
                   on ? '#101018' : '#dbe6f2', 'center');
      }
      Pixel.text(c, 'ARROWS OR W/S  -  ENTER', Pixel.W / 2, Pixel.H - 14, 1, '#9fb0c4', 'center');
      void L;
    },

    drawControls: function (c) {
      Draw.world(c, menuWorld(), this.time);
      Pixel.rect(c, 0, 0, Pixel.W, Pixel.H, 'rgba(10,16,30,0.72)');
      Pixel.outlineText(c, 'CONTROLS', Pixel.W / 2, 14, 3, '#57c96a', '#101018', 'center');

      var rows = [
        ['HOLD', 'LEAN THAT WAY AND WIND UP'],
        ['LET GO', 'JUMP THE WAY YOU LEANED'],
        ['HOLD LONGER', 'FLATTER, FASTER, FURTHER'],
        ['ITEM KEY', 'SPEND WHAT YOU PICKED UP'],
        ['IN THE AIR', 'THE SAME KEYS SPIN YOU']
      ];
      for (var i = 0; i < rows.length; i++) {
        var y = 48 + i * 14;
        Pixel.text(c, rows[i][0], 40, y, 1, '#ffc23c');
        Pixel.text(c, rows[i][1], 116, y, 1, '#ffffff');
      }
      Pixel.text(c, 'PLAYER 1     W    E    R', Pixel.W / 2, 128, 1, '#8fd4f2', 'center');
      Pixel.text(c, 'PLAYER 2     LEFT  RIGHT  UP', Pixel.W / 2, 140, 1, '#c0a0f2', 'center');
      Pixel.text(c, 'PRESS ANY KEY', Pixel.W / 2, Pixel.H - 14, 1, '#9fb0c4', 'center');
    }
  };

  /* The menu sits on a real slice of the first map, so the title screen
     and the game look like the same place. */
  var _menuWorld = null;
  function menuWorld() {
    if (!_menuWorld) {
      _menuWorld = new World(LEVELS[0], {});
      _menuWorld.cam.x = 420;
      _menuWorld.cam.y = 34;
      _menuWorld.racers = [];
    }
    _menuWorld.cam.x = 420 + Math.sin(Game.time * 0.12) * 40;
    return _menuWorld;
  }

  function anyKey() {
    for (var k in Input.hit) if (Input.hit[k]) return true;
    return false;
  }

  /* ---------------------------------------------------------- shell */
  function resize() {
    var shell = document.getElementById('shell');
    var fit = Math.min((root.innerWidth - 16) / CANVAS_W, (root.innerHeight - 16) / CANVAS_H);
    /* The canvas is a whole multiple of the 320x180 buffer, so snapping
       the page scale to quarters keeps every art pixel a whole number of
       screen pixels instead of some rows coming out a pixel fatter. */
    var s = Math.max(0.25, Math.min(Math.floor(fit * 4) / 4, 3));
    shell.style.transform = 'scale(' + s + ')';
  }

  void ctx;

  var last = 0, acc = 0, STEP = 1 / 120;
  function frame(ts) {
    if (!last) last = ts;
    var dt = (ts - last) / 1000;
    last = ts;
    if (dt > 0.25) dt = 0.25;

    acc += dt;
    var guard = 0;
    while (acc >= STEP && guard++ < 8) {
      Input.tick(STEP);
      Game.update(STEP);
      Input.clear();
      acc -= STEP;
    }
    Game.draw();
    requestAnimationFrame(frame);
  }

  Input.attach(root);
  root.addEventListener('resize', resize);
  resize();
  requestAnimationFrame(frame);

  root.Game = Game;
})(typeof window !== 'undefined' ? window : globalThis);
