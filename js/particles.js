/* ============================================================
   particles.js - sparks, smoke, blood, glass shards, debris
   ============================================================ */
(function (root) {
  'use strict';

  function Particles() {
    this.list = [];
    this.max = 900;
  }

  Particles.prototype.clear = function () { this.list.length = 0; };

  Particles.prototype.spawn = function (p) {
    if (this.list.length >= this.max) this.list.shift();
    p.life = p.life || 0.6;
    p.age = 0;
    p.vx = p.vx || 0;
    p.vy = p.vy || 0;
    p.g = p.g == null ? 900 : p.g;
    p.size = p.size || 3;
    p.drag = p.drag == null ? 0.6 : p.drag;
    p.spin = p.spin || 0;
    p.rot = p.rot || 0;
    p.shape = p.shape || 'square';
    p.color = p.color || '#fff';
    p.bounce = p.bounce == null ? 0 : p.bounce;
    this.list.push(p);
    return p;
  };

  Particles.prototype.burst = function (x, y, n, opt) {
    opt = opt || {};
    for (var i = 0; i < n; i++) {
      var a = opt.angle == null ? U.rand(0, Math.PI * 2)
                                : opt.angle + U.rand(-(opt.spread || 0.6), opt.spread || 0.6);
      var sp = U.rand(opt.speedMin || 40, opt.speedMax || 220);
      this.spawn({
        x: x + U.rand(-(opt.jitter || 2), opt.jitter || 2),
        y: y + U.rand(-(opt.jitter || 2), opt.jitter || 2),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: U.rand(opt.lifeMin || 0.25, opt.lifeMax || 0.7),
        size: U.rand(opt.sizeMin || 2, opt.sizeMax || 5),
        color: opt.colors ? U.pick(opt.colors) : (opt.color || '#ffd15c'),
        g: opt.g == null ? 900 : opt.g,
        drag: opt.drag == null ? 0.8 : opt.drag,
        shape: opt.shape || 'square',
        spin: U.rand(-12, 12),
        rot: U.rand(0, 6.28),
        bounce: opt.bounce || 0,
        fade: opt.fade !== false
      });
    }
  };

  Particles.prototype.smoke = function (x, y, n, opt) {
    opt = opt || {};
    for (var i = 0; i < n; i++) {
      this.spawn({
        x: x + U.rand(-6, 6), y: y + U.rand(-6, 6),
        vx: U.rand(-40, 40), vy: U.rand(-70, -10),
        life: U.rand(0.5, 1.3), size: U.rand(6, 16),
        color: opt.color || 'rgba(120,124,140,0.7)',
        g: -30, drag: 1.4, shape: 'circle', grow: opt.grow == null ? 22 : opt.grow, fade: true
      });
    }
  };

  Particles.prototype.update = function (dt, world) {
    var L = this.list;
    for (var i = L.length - 1; i >= 0; i--) {
      var p = L[i];
      p.age += dt;
      if (p.age >= p.life) { L.splice(i, 1); continue; }
      p.vy += p.g * dt;
      var d = U.damp(p.drag, dt);
      p.vx *= d; p.vy *= d;
      var nx = p.x + p.vx * dt;
      var ny = p.y + p.vy * dt;
      if (p.bounce > 0 && world) {
        /* cheap ground bounce against solid geometry */
        if (world.solidAt(nx, ny)) {
          if (!world.solidAt(p.x, ny)) { p.vx = -p.vx * p.bounce; nx = p.x; }
          else if (!world.solidAt(nx, p.y)) { p.vy = -p.vy * p.bounce; p.vx *= 0.7; ny = p.y; }
          else { p.vx *= 0.4; p.vy = -p.vy * p.bounce; nx = p.x; ny = p.y; }
        }
      }
      p.x = nx; p.y = ny;
      p.rot += p.spin * dt;
      if (p.grow) p.size += p.grow * dt;
    }
  };

  Particles.prototype.draw = function (ctx) {
    var L = this.list;
    for (var i = 0; i < L.length; i++) {
      var p = L[i];
      var t = p.age / p.life;
      ctx.globalAlpha = p.fade === false ? 1 : U.clamp(1 - t * t, 0, 1);
      ctx.fillStyle = p.color;
      if (p.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, 6.2832);
        ctx.fill();
      } else if (p.shape === 'shard') {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.beginPath();
        ctx.moveTo(-p.size, -p.size * 0.5);
        ctx.lineTo(p.size * 0.9, -p.size * 0.2);
        ctx.lineTo(p.size * 0.2, p.size);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
        ctx.restore();
      }
    }
    ctx.globalAlpha = 1;
  };

  root.Particles = Particles;
})(typeof window !== 'undefined' ? window : globalThis);
