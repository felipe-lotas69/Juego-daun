/* ============================================================
   weapons.js - weapon table, bullets, explosions
   ============================================================ */
(function (root) {
  'use strict';

  /* Every weapon fires along the holder's lean angle.
     `recoil` shoves the shooter backwards - that is a movement mechanic. */
  var WEAPONS = {
    pistol: {
      name: 'PISTOL', short: 'PSTL', ammo: 14, rate: 0.26, auto: false,
      pellets: 1, spread: 0.02, speed: 1500, damage: 34, recoil: 110,
      size: 3, color: '#ffe27a', trail: 9, sound: 'pistol', shake: 2.5,
      body: '#4c5164', barrel: 16
    },
    smg: {
      name: 'SMG', short: 'SMG', ammo: 38, rate: 0.075, auto: true,
      pellets: 1, spread: 0.075, speed: 1650, damage: 15, recoil: 52,
      size: 2.6, color: '#ffd05a', trail: 12, sound: 'smg', shake: 1.6,
      body: '#3f4456', barrel: 20
    },
    shotgun: {
      name: 'SHOTGUN', short: 'SHTG', ammo: 7, rate: 0.72, auto: false,
      pellets: 7, spread: 0.2, speed: 1250, damage: 17, recoil: 430,
      size: 3, color: '#ffbb55', trail: 7, sound: 'shotgun', shake: 7,
      body: '#6b4a2f', barrel: 22
    },
    rocket: {
      name: 'ROCKET', short: 'RKT', ammo: 4, rate: 1.0, auto: false,
      pellets: 1, spread: 0, speed: 720, damage: 70, recoil: 300,
      size: 5, color: '#ff6a4d', trail: 0, sound: 'rocket', shake: 5,
      explosive: true, blast: 118, blastDamage: 85, blastForce: 780,
      body: '#4a5040', barrel: 26, gravity: 260
    },
    teleport: {
      name: 'TELEPORTER', short: 'TELE', ammo: 5, rate: 0.9, auto: false,
      pellets: 1, spread: 0, speed: 880, damage: 0, recoil: 0,
      size: 5, color: '#49e0e8', trail: 16, sound: 'teleport', shake: 1,
      teleport: true, body: '#2f5a63', barrel: 18, gravity: 120
    }
  };

  /* ---------------------------------------------------------- Bullet */
  function Bullet(x, y, vx, vy, def, owner, ownerRef) {
    this.x = x; this.y = y;
    this.px = x; this.py = y;
    this.vx = vx; this.vy = vy;
    this.def = def;
    this.owner = owner;           /* 'player' | 'enemy' */
    this.ownerRef = ownerRef;
    this.life = def.explosive || def.teleport ? 4 : 1.6;
    this.age = 0;
    this.dead = false;
    this.trail = [];
  }

  Bullet.prototype.update = function (dt, world) {
    this.age += dt;
    if (this.age > this.life) { this.dead = true; return; }

    if (this.def.gravity) this.vy += this.def.gravity * dt;

    this.px = this.x; this.py = this.y;
    var nx = this.x + this.vx * dt;
    var ny = this.y + this.vy * dt;

    var hit = world.raycast(this.px, this.py, nx, ny, this.owner, this.ownerRef);
    if (hit) {
      this.x = this.px + (nx - this.px) * hit.t;
      this.y = this.py + (ny - this.py) * hit.t;
      this.impact(world, hit);
      this.dead = true;
      return;
    }

    this.x = nx; this.y = ny;

    if (this.def.trail) {
      this.trail.push(this.x, this.y);
      if (this.trail.length > 12) this.trail.splice(0, 2);
    }
    if (this.def.explosive) {
      world.fx.smoke(this.x, this.y, 1, { grow: 14, color: 'rgba(160,150,140,0.5)' });
    }
    if (this.def.teleport) {
      world.fx.burst(this.x, this.y, 1, { colors: ['#49e0e8', '#a8f4ff'], speedMax: 30, g: 0, lifeMax: 0.3, sizeMax: 3 });
    }

    if (this.x < -400 || this.x > world.level.width + 400 || this.y > world.level.height + 600 || this.y < -1200) {
      this.dead = true;
    }
  };

  Bullet.prototype.impact = function (world, hit) {
    var d = this.def;

    if (d.explosive) {
      world.explode(this.x, this.y, d.blast, d.blastDamage, d.blastForce, this.owner, this.ownerRef);
      return;
    }

    if (d.teleport) {
      world.teleportPlayer(this.x, this.y, hit, this.ownerRef);
      return;
    }

    if (hit.type === 'enemy') {
      hit.obj.damage(d.damage, U.sign(this.vx) * 210, -90, world);
      world.fx.burst(this.x, this.y, 8, { colors: ['#ff4d5e', '#c1232f'], speedMax: 200, lifeMax: 0.5, sizeMax: 4 });
      Sound.hit();
    } else if (hit.type === 'player') {
      hit.obj.damage(d.damage, U.sign(this.vx) * 190, -120, world, this.ownerRef);
      if (world.gore) {
        world.gore.splash(this.x, this.y, 7, U.sign(this.vx), -0.3, 1.1);
      }
      Sound.hit();
    } else if (hit.type === 'glass') {
      hit.obj.shatter(world, this.vx, this.vy);
    } else if (hit.type === 'crate') {
      hit.obj.damage(d.damage, world);
    } else {
      var a = Math.atan2(-this.vy, -this.vx);
      world.fx.burst(this.x, this.y, 5, {
        angle: a, spread: 0.9, colors: ['#ffe9a8', '#ffb347', '#fff'],
        speedMax: 190, lifeMax: 0.3, sizeMax: 3
      });
      if (Math.random() < 0.35) Sound.ricochet();
    }
  };

  Bullet.prototype.draw = function (ctx) {
    var d = this.def;
    if (d.explosive) {
      ctx.save();
      ctx.translate(this.x, this.y);
      ctx.rotate(Math.atan2(this.vy, this.vx));
      ctx.fillStyle = '#d8d3c6';
      ctx.fillRect(-9, -3, 14, 6);
      ctx.fillStyle = '#ff6a4d';
      ctx.beginPath();
      ctx.moveTo(5, -3); ctx.lineTo(11, 0); ctx.lineTo(5, 3);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,190,80,' + (0.5 + Math.random() * 0.4) + ')';
      ctx.fillRect(-9 - Math.random() * 10, -2, 10, 4);
      ctx.restore();
      return;
    }

    if (d.trail && this.trail.length >= 4) {
      ctx.strokeStyle = d.color;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = d.size * 0.9;
      ctx.beginPath();
      ctx.moveTo(this.trail[0], this.trail[1]);
      for (var i = 2; i < this.trail.length; i += 2) ctx.lineTo(this.trail[i], this.trail[i + 1]);
      ctx.lineTo(this.x, this.y);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = d.color;
    ctx.beginPath();
    ctx.arc(this.x, this.y, d.size, 0, 6.2832);
    ctx.fill();
  };

  /* ---------------------------------------------------------- firing */
  /* Spawns bullets for `holder` (player or enemy) and returns recoil impulse. */
  function fire(world, holder, key, angle, muzzleX, muzzleY, owner) {
    var d = WEAPONS[key];
    if (!d) return null;
    for (var i = 0; i < d.pellets; i++) {
      var a = angle + U.rand(-d.spread, d.spread);
      var sp = d.speed * U.rand(0.94, 1.06);
      world.bullets.push(new Bullet(muzzleX, muzzleY, Math.cos(a) * sp, Math.sin(a) * sp, d, owner, holder));
    }
    world.fx.burst(muzzleX, muzzleY, d.pellets > 1 ? 12 : 6, {
      angle: angle, spread: 0.45, colors: ['#fff3c4', '#ffc23c', '#ff8a3c'],
      speedMax: 300, lifeMax: 0.22, sizeMax: 4, g: 200
    });
    world.fx.smoke(muzzleX, muzzleY, 2, { grow: 26, color: 'rgba(200,198,190,0.42)' });
    if (Sound[d.sound]) Sound[d.sound]();
    world.shake(d.shake);
    return { fx: -Math.cos(angle) * d.recoil, fy: -Math.sin(angle) * d.recoil };
  }

  root.WEAPONS = WEAPONS;
  root.Bullet = Bullet;
  root.fireWeapon = fire;
})(typeof window !== 'undefined' ? window : globalThis);
