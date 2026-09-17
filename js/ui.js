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
        pause: $('#pause'),
        complete: $('#complete'),
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

      this.save = U.store.get(STORE_KEY, { best: [] });
      if (!this.save.best) this.save.best = [];

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

      this.buildLevelGrid();
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

    show: function (which) {
      ['menu', 'howto', 'levels', 'pause', 'complete'].forEach(function (k) {
        UI.el[k].classList.add('hidden');
      });
      if (which) this.el[which].classList.remove('hidden');
      this.el.hud.classList.toggle('hidden', which !== null && which !== 'pause');
    },

    showGame: function () {
      ['menu', 'howto', 'levels', 'pause', 'complete'].forEach(function (k) {
        UI.el[k].classList.add('hidden');
      });
      this.el.hud.classList.remove('hidden');
    },

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

    toast: function (msg) {
      this.el.toast.textContent = msg;
      this.el.toast.classList.add('show');
      this.toastTimer = 1.3;
    },

    updateHUD: function (world, dt) {
      this.el.hudLevel.textContent = 'LEVEL ' + (world.levelIndex + 1) + ' · ' + world.level.name;
      this.el.hudTime.textContent = U.formatTime(world.elapsed);
      this.el.hudHealth.style.width = U.clamp(world.player.health / world.player.maxHealth * 100, 0, 100) + '%';

      var w = world.player.weapon;
      this.el.hudWeapon.textContent = w ? WEAPONS[w.key].name + '  ' + w.ammo : 'UNARMED';
      this.el.hudWeapon.style.color = w ? '#ffc23c' : '#8a90a8';

      if (world.prompt) {
        this.el.promptText.textContent = world.prompt.label;
        this.el.prompt.classList.remove('hidden');
      } else {
        this.el.prompt.classList.add('hidden');
      }

      if (this.toastTimer > 0) {
        this.toastTimer -= dt;
        if (this.toastTimer <= 0) this.el.toast.classList.remove('show');
      }
    }
  };

  root.UI = UI;
})(window);
