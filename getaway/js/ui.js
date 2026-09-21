/* ============================================================
   ui.js - screens, HUD, level select, saved times
   ============================================================ */
(function (root) {
  'use strict';

  var STORE_KEY = 'getaway-daun-v1';

  function $(sel) { return document.querySelector(sel); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  var UI = {
    el: {},
    save: null,
    toastTimer: 0,

    init: function (game) {
      this.game = game;
      this.el = {
        menu: $('#menu'),
        howto: $('#howto'),
        levels: $('#levels'),
        versus: $('#versus'),
        lan: $('#lan'),
        options: $('#options'),
        roundend: $('#roundend'),
        matchend: $('#matchend'),
        pause: $('#pause'),
        complete: $('#complete'),
        score: $('#hud-score'),
        hud: $('#hud'),
        hudLevel: $('#hud-level'),
        hudTime: $('#hud-time'),
        hudHealth: $('#hud-health').firstElementChild,
        hudWeapon: $('#hud-weapon'),
        prompt: $('#hud-prompt'),
        promptText: $('#hud-prompt span'),
        toast: $('#hud-toast'),
        grid: $('#level-grid'),
        completeTitle: $('#complete-title'),
        completeTime: $('#complete-time'),
        completeBest: $('#complete-best'),
        completeNote: $('#complete-note'),
        btnNext: $('#btn-next')
      };

      this.save = U.store.get(STORE_KEY, { best: [], gore: 1, sound: 1, target: 3, humans: 1, lanHost: '' });
      if (!this.save.best) this.save.best = [];
      if (this.save.gore == null) this.save.gore = 1;
      if (this.save.sound == null) this.save.sound = 1;
      if (this.save.target == null) this.save.target = 3;
      if (this.save.humans == null) this.save.humans = 1;
      Sound.setEnabled(this.save.sound !== 0);

      var self = this;
      $('#btn-play').onclick = function () { Sound.click(); self.game.start(self.firstUnfinished()); };
      $('#btn-levels').onclick = function () { Sound.click(); self.buildLevelGrid(); self.show('levels'); };
      $('#btn-howto').onclick = function () { Sound.click(); self.show('howto'); };
      $$('.btn.back').forEach(function (b) { b.onclick = function () { Sound.click(); self.show('menu'); }; });
      $('#btn-resume').onclick = function () { Sound.click(); self.game.resume(); };
      $('#btn-retry').onclick = function () { Sound.click(); self.game.start(self.game.levelIndex); };
      $('#btn-quit').onclick = function () { Sound.click(); self.game.toMenu(); };
      $('#btn-again').onclick = function () { Sound.click(); self.game.start(self.game.levelIndex); };
      $('#btn-menu2').onclick = function () { Sound.click(); self.game.toMenu(); };
      $('#btn-next').onclick = function () {
        Sound.click();
        var n = self.game.levelIndex + 1;
        if (n < LEVELS.length) self.game.start(n); else self.game.toMenu();
      };

      $('#btn-versus').onclick = function () { Sound.click(); self.openVersus(); };
      $('#btn-options').onclick = function () { Sound.click(); self.show('options'); };
      $('#btn-lan').onclick = function () { Sound.click(); self.show('lan'); };
      $('#btn-versus-start').onclick = function () { Sound.click(); self.game.startVersus(self.versusConfig()); };
      $('#btn-lan-join').onclick = function () {
        Sound.click();
        var host = $('#lan-host').value.trim();
        if (!host) { $('#lan-status').textContent = 'Type the address the host printed.'; return; }
        self.save.lanHost = host; U.store.set(STORE_KEY, self.save);
        self.game.joinLan(host);
      };
      $('#lan-host').value = this.save.lanHost || '';
      $('#btn-round-next').onclick = function () { Sound.click(); self.game.nextRound(); };
      $('#btn-rematch').onclick = function () { Sound.click(); self.game.startVersus(self.versusConfig()); };
      $('#btn-match-menu').onclick = function () { Sound.click(); self.game.toMenu(); };

      this.bindSeg('#seg-target', this.save.target, function (v) { self.save.target = v; self.persist(); });
      this.bindSeg('#seg-humans', this.save.humans, function (v) {
        self.save.humans = v; self.persist(); self.buildSlots();
      });
      this.bindSeg('#seg-gore', this.save.gore, function (v) {
        self.save.gore = v; self.persist();
        if (self.game.world && self.game.world.gore) self.game.world.gore.setLevel(v);
      });
      this.bindSeg('#seg-sound', this.save.sound, function (v) {
        self.save.sound = v; self.persist(); Sound.setEnabled(v !== 0);
      });

      this.botPicks = [null, null, null, null];
      this.buildLevelGrid();
      this.buildSlots();
    },

    persist: function () { U.store.set(STORE_KEY, this.save); },

    bindSeg: function (sel, value, onPick) {
      var box = $(sel);
      if (!box) return;
      var btns = Array.prototype.slice.call(box.querySelectorAll('button'));
      function paint(v) {
        btns.forEach(function (b) { b.classList.toggle('on', +b.dataset.v === v); });
      }
      paint(value);
      btns.forEach(function (b) {
        b.onclick = function () {
          Sound.click();
          var v = +b.dataset.v;
          paint(v);
          onPick(v);
        };
      });
    },

    openVersus: function () { this.buildSlots(); this.show('versus'); },

    /* four seats: humans first, bots after, each bot swappable */
    buildSlots: function () {
      var self = this;
      var box = $('#slot-list');
      if (!box) return;
      var humans = this.save.humans;
      box.innerHTML = '';
      for (var i = 0; i < 4; i++) {
        var pal = PLAYER_PALETTES[i];
        var el = document.createElement('div');
        el.className = 'slot';
        if (i < humans) {
          el.innerHTML = '<span class="pip" style="background:' + pal.mark + '"></span>' +
            '<div><div class="who">' + (i === 0 ? 'YOU' : 'PLAYER ' + (i + 1)) + '</div>' +
            '<div class="blurb">' + (i === 0 ? 'W A D R' : '&uarr; &larr; &rarr; and &crarr;') + '</div></div>';
        } else {
          var key = this.botPicks[i] || PERSONALITY_ORDER[i % PERSONALITY_ORDER.length];
          this.botPicks[i] = key;
          var pr = PERSONALITIES[key];
          el.innerHTML = '<span class="pip" style="background:' + pal.mark + '"></span>' +
            '<div><div class="who">' + pr.name + '</div><div class="blurb">' + pr.blurb + '</div></div>' +
            '<button class="swap" data-i="' + i + '">SWAP</button>';
        }
        box.appendChild(el);
      }
      Array.prototype.slice.call(box.querySelectorAll('.swap')).forEach(function (b) {
        b.onclick = function () {
          Sound.click();
          var i = +b.dataset.i;
          var cur = PERSONALITY_ORDER.indexOf(self.botPicks[i]);
          self.botPicks[i] = PERSONALITY_ORDER[(cur + 1) % PERSONALITY_ORDER.length];
          self.buildSlots();
        };
      });
    },

    versusConfig: function () {
      var slots = [], i;
      for (i = 0; i < this.save.humans; i++) {
        slots.push({ name: i === 0 ? 'YOU' : 'P' + (i + 1), isBot: false, wins: 0 });
      }
      for (i = this.save.humans; i < 4; i++) {
        var key = this.botPicks[i] || PERSONALITY_ORDER[i % PERSONALITY_ORDER.length];
        slots.push({ name: PERSONALITIES[key].name, isBot: true, personality: key, wins: 0 });
      }
      return { slots: slots, target: this.save.target, gore: this.save.gore, humans: this.save.humans };
    },

    showRoundEnd: function (match, world) {
      var winner = world.roundWinner;
      $('#round-title').textContent = winner ? winner.label + ' TAKES THE ROUND' : 'ROUND OVER';
      $('#round-sub').textContent = winner
        ? U.formatTime(winner.finishTime) + ' on ' + world.level.name
        : world.level.name;
      $('#round-board').innerHTML = this.boardHTML(match.standings(), match.target);
      /* recordRound has already advanced the rotation, so the map that is
         about to be played is mapName(), not nextMapName() */
      $('#round-next').textContent = 'NEXT: ' + match.mapName();
      this.show('roundend');
    },

    showMatchEnd: function (match) {
      var champ = match.champion();
      var s = match.slots[champ];
      $('#match-title').textContent = s ? s.name + ' GETS AWAY' : 'MATCH OVER';
      $('#match-board').innerHTML = this.boardHTML(match.standings(), match.target);
      this.show('matchend');
    },

    boardHTML: function (rows, target) {
      return rows.map(function (r) {
        var pal = PLAYER_PALETTES[r.index];
        return '<div class="brow' + (r.wins >= target ? ' win' : '') + '">' +
          '<span class="pip" style="background:' + pal.mark + '"></span>' +
          '<span class="nm">' + r.name + '</span>' +
          '<span class="tag">' + (r.isBot ? 'BOT' : 'HUMAN') + '</span>' +
          '<span class="pts">' + r.wins + '</span></div>';
      }).join('');
    },

    updateScoreboard: function (world, match) {
      if (!match || !world) { this.el.score.classList.add('hidden'); return; }
      this.el.score.classList.remove('hidden');
      var local = world.player;
      this.el.score.innerHTML = world.players.map(function (p) {
        return '<div class="srow' + (p === local ? ' me' : '') + '">' +
          '<span class="pip" style="background:' + p.palette.mark + '"></span>' +
          '<span class="nm">' + p.label + '</span>' +
          '<span class="pts">' + p.wins + '</span></div>';
      }).join('');
    },

    firstUnfinished: function () {
      for (var i = 0; i < LEVELS.length; i++) if (this.save.best[i] == null) return i;
      return 0;
    },

    unlocked: function (i) { return i === 0 || this.save.best[i - 1] != null; },

    buildLevelGrid: function () {
      var self = this;
      var g = this.el.grid;
      g.innerHTML = '';
      LEVELS.forEach(function (L, i) {
        var card = document.createElement('div');
        var open = self.unlocked(i);
        card.className = 'card' + (open ? '' : ' locked');
        card.innerHTML =
          '<div class="num">' + String(i + 1).padStart(2, '0') + '</div>' +
          '<div class="nm">' + (open ? L.name : 'LOCKED') + '</div>' +
          '<div class="bt">BEST ' + U.formatTime(self.save.best[i]) + '</div>';
        if (open) card.onclick = function () { Sound.click(); self.game.start(i); };
        g.appendChild(card);
      });
    },

    recordTime: function (levelIndex, seconds) {
      var prev = this.save.best[levelIndex];
      var isBest = prev == null || seconds < prev;
      if (isBest) this.save.best[levelIndex] = seconds;
      U.store.set(STORE_KEY, this.save);
      return { isBest: isBest, best: this.save.best[levelIndex] };
    },

    SCREENS: ['menu', 'howto', 'levels', 'versus', 'lan', 'options',
              'roundend', 'matchend', 'pause', 'complete'],

    show: function (which) {
      var self = this;
      this.SCREENS.forEach(function (k) { if (self.el[k]) self.el[k].classList.add('hidden'); });
      if (which) this.el[which].classList.remove('hidden');
      this.el.hud.classList.toggle('hidden', which !== null && which !== 'pause');
    },

    showGame: function () {
      var self = this;
      this.SCREENS.forEach(function (k) { if (self.el[k]) self.el[k].classList.add('hidden'); });
      this.el.hud.classList.remove('hidden');
    },

    lanStatus: function (text) { var el = $('#lan-status'); if (el) el.textContent = text; },

    showComplete: function (levelIndex, seconds) {
      var r = this.recordTime(levelIndex, seconds);
      this.el.completeTitle.textContent = levelIndex === LEVELS.length - 1 ? 'YOU GOT AWAY' : 'LEVEL CLEAR';
      this.el.completeTime.textContent = U.formatTime(seconds);
      this.el.completeBest.textContent = U.formatTime(r.best);
      this.el.completeNote.textContent = r.isBest ? 'New best time.' :
        (levelIndex === LEVELS.length - 1 ? 'That is the whole job. Nice driving.' : '');
      this.el.btnNext.style.display = levelIndex < LEVELS.length - 1 ? '' : 'none';
      this.buildLevelGrid();
      this.el.complete.classList.remove('hidden');
      this.el.hud.classList.add('hidden');
    },

    toastText: '',

    toast: function (msg) {
      this.toastText = msg;          /* the canvas HUD renders it */
      this.toastTimer = 1.3;
    },

    /* The readouts live on the pixel canvas now, so this only ticks the
       timers the canvas HUD reads back. */
    updateHUD: function (world, dt) {
      if (this.toastTimer > 0) this.toastTimer -= dt;
    },

    updateScoreboard: function () { }
  };

  root.UI = UI;
})(window);
