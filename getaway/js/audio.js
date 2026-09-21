/* ============================================================
   audio.js - everything is synthesized, no asset files
   ============================================================ */
(function (root) {
  'use strict';

  var ctx = null;
  var master = null;
  var enabled = true;
  var noiseBuf = null;

  function ensure() {
    if (ctx) return ctx;
    var AC = root.AudioContext || root.webkitAudioContext;
    if (!AC) { enabled = false; return null; }
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = 0.32;
      master.connect(ctx.destination);
      /* one second of white noise, reused by every noisy effect */
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      var d = noiseBuf.getChannelData(0);
      for (var i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { enabled = false; }
    return ctx;
  }

  function now() { return ctx.currentTime; }

  function tone(opt) {
    if (!enabled || !ensure()) return;
    var t = now();
    var o = ctx.createOscillator();
    var g = ctx.createGain();
    o.type = opt.type || 'square';
    o.frequency.setValueAtTime(opt.f0, t);
    if (opt.f1 != null) o.frequency.exponentialRampToValueAtTime(Math.max(1, opt.f1), t + opt.dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opt.vol || 0.2, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opt.dur);
    o.connect(g);
    if (opt.filter) {
      var f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opt.filter;
      g.connect(f); f.connect(master);
    } else {
      g.connect(master);
    }
    o.start(t);
    o.stop(t + opt.dur + 0.02);
  }

  function noise(opt) {
    if (!enabled || !ensure()) return;
    var t = now();
    var s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    s.loop = true;
    var f = ctx.createBiquadFilter();
    f.type = opt.type || 'bandpass';
    f.frequency.setValueAtTime(opt.f0, t);
    if (opt.f1 != null) f.frequency.exponentialRampToValueAtTime(Math.max(20, opt.f1), t + opt.dur);
    f.Q.value = opt.q || 1;
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(opt.vol || 0.2, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + opt.dur);
    s.connect(f); f.connect(g); g.connect(master);
    s.start(t);
    s.stop(t + opt.dur + 0.02);
  }

  var Sound = {
    unlock: function () {
      ensure();
      if (ctx && ctx.state === 'suspended') ctx.resume();
    },
    setEnabled: function (v) { enabled = v; },
    isEnabled: function () { return enabled; },

    hop:      function () { tone({ type: 'square', f0: 180, f1: 90, dur: 0.07, vol: 0.06 }); },
    jump:     function () { tone({ type: 'square', f0: 260, f1: 480, dur: 0.12, vol: 0.11 }); },
    land:     function (v) { noise({ f0: 320, f1: 90, dur: 0.1, vol: U.clamp(v / 1400, 0.03, 0.18), type: 'lowpass' }); },
    thud:     function () { noise({ f0: 200, f1: 60, dur: 0.16, vol: 0.16, type: 'lowpass' }); },

    pistol:   function () { tone({ type: 'square', f0: 700, f1: 120, dur: 0.09, vol: 0.14 }); noise({ f0: 2400, f1: 500, dur: 0.09, vol: 0.14 }); },
    smg:      function () { tone({ type: 'square', f0: 560, f1: 160, dur: 0.06, vol: 0.09 }); noise({ f0: 3000, f1: 800, dur: 0.05, vol: 0.09 }); },
    shotgun:  function () { noise({ f0: 1400, f1: 120, dur: 0.24, vol: 0.26, type: 'lowpass' }); tone({ type: 'sawtooth', f0: 220, f1: 50, dur: 0.22, vol: 0.14 }); },
    rocket:   function () { noise({ f0: 600, f1: 2200, dur: 0.3, vol: 0.16 }); tone({ type: 'sawtooth', f0: 120, f1: 320, dur: 0.3, vol: 0.1 }); },
    explode:  function () { noise({ f0: 900, f1: 50, dur: 0.55, vol: 0.34, type: 'lowpass' }); tone({ type: 'sawtooth', f0: 140, f1: 32, dur: 0.5, vol: 0.2 }); },
    teleport: function () { tone({ type: 'sine', f0: 180, f1: 1800, dur: 0.22, vol: 0.14 }); tone({ type: 'sine', f0: 900, f1: 120, dur: 0.24, vol: 0.09 }); },

    glass:    function () { noise({ f0: 5200, f1: 1800, dur: 0.35, vol: 0.2, q: 0.7 }); tone({ type: 'triangle', f0: 2400, f1: 900, dur: 0.18, vol: 0.08 }); },
    crack:    function () { noise({ f0: 4200, f1: 3000, dur: 0.07, vol: 0.12, q: 2 }); },
    ricochet: function () { tone({ type: 'square', f0: 1800, f1: 3400, dur: 0.07, vol: 0.05 }); },

    hit:      function () { tone({ type: 'square', f0: 320, f1: 80, dur: 0.14, vol: 0.16 }); noise({ f0: 900, f1: 200, dur: 0.12, vol: 0.12 }); },
    hurt:     function () { tone({ type: 'sawtooth', f0: 420, f1: 110, dur: 0.22, vol: 0.18 }); },
    die:      function () { tone({ type: 'sawtooth', f0: 320, f1: 40, dur: 0.6, vol: 0.2 }); },

    pickup:   function () { tone({ type: 'square', f0: 620, f1: 1200, dur: 0.1, vol: 0.12 }); },
    click:    function () { tone({ type: 'square', f0: 900, f1: 1400, dur: 0.05, vol: 0.09 }); },
    ding:     function () { tone({ type: 'sine', f0: 880, dur: 0.16, vol: 0.12 }); tone({ type: 'sine', f0: 1320, dur: 0.22, vol: 0.08 }); },
    elevator: function () { tone({ type: 'sine', f0: 120, f1: 180, dur: 0.3, vol: 0.07 }); },
    checkpoint: function () { tone({ type: 'sine', f0: 660, dur: 0.12, vol: 0.12 }); tone({ type: 'sine', f0: 990, dur: 0.2, vol: 0.1 }); },

    win: function () {
      if (!enabled || !ensure()) return;
      [523, 659, 784, 1047].forEach(function (f, i) {
        setTimeout(function () { tone({ type: 'square', f0: f, dur: 0.24, vol: 0.14 }); }, i * 110);
      });
    }
  };

  root.Sound = Sound;
})(typeof window !== 'undefined' ? window : globalThis);
