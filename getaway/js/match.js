/* ============================================================
   match.js - versus match state: three maps in rotation, first
   to N round wins takes it.
   ============================================================ */
(function (root) {
  'use strict';

  function Match(opts) {
    opts = opts || {};
    this.target = opts.target || 3;
    this.slots = opts.slots || [];        /* {name, isBot, personality, wins} */
    this.rotation = opts.rotation || [0, 1, 2];
    this.roundIndex = 0;
    this.localIndex = opts.localIndex == null ? 0 : opts.localIndex;
    this.history = [];                    /* one entry per finished round */
  }

  Match.prototype.mapIndex = function () {
    return this.rotation[this.roundIndex % this.rotation.length];
  };

  Match.prototype.mapName = function () {
    return VERSUS_MAPS[this.mapIndex()].name;
  };

  Match.prototype.nextMapName = function () {
    return VERSUS_MAPS[this.rotation[(this.roundIndex + 1) % this.rotation.length]].name;
  };

  /* Slot defs handed to the World, carrying the running score. */
  Match.prototype.playerDefs = function () {
    return this.slots.map(function (s) {
      return { name: s.name, isBot: s.isBot, personality: s.personality, wins: s.wins || 0 };
    });
  };

  Match.prototype.recordRound = function (winnerIndex, world) {
    if (winnerIndex >= 0 && this.slots[winnerIndex]) {
      this.slots[winnerIndex].wins = (this.slots[winnerIndex].wins || 0) + 1;
    }
    this.history.push({
      map: this.mapIndex(),
      winner: winnerIndex,
      time: world ? world.elapsed : 0
    });
    this.roundIndex++;
  };

  Match.prototype.leader = function () {
    var best = -1, bw = -1;
    for (var i = 0; i < this.slots.length; i++) {
      var w = this.slots[i].wins || 0;
      if (w > bw) { bw = w; best = i; }
    }
    return best;
  };

  /* index of the match winner, or -1 if it is still going */
  Match.prototype.champion = function () {
    for (var i = 0; i < this.slots.length; i++) {
      if ((this.slots[i].wins || 0) >= this.target) return i;
    }
    return -1;
  };

  Match.prototype.standings = function () {
    return this.slots.map(function (s, i) {
      return { index: i, name: s.name, wins: s.wins || 0, isBot: s.isBot, personality: s.personality };
    }).sort(function (a, b) { return b.wins - a.wins; });
  };

  /* A default four-slot line-up: you plus three distinct personalities. */
  Match.defaultSlots = function (humanCount, botCount) {
    var slots = [], i;
    for (i = 0; i < humanCount; i++) {
      slots.push({ name: 'P' + (i + 1), isBot: false, wins: 0 });
    }
    var picks = PERSONALITY_ORDER.slice();
    for (i = 0; i < botCount; i++) {
      var key = picks[i % picks.length];
      slots.push({
        name: PERSONALITIES[key].name,
        isBot: true,
        personality: key,
        wins: 0
      });
    }
    return slots;
  };

  root.Match = Match;
})(typeof window !== 'undefined' ? window : globalThis);
