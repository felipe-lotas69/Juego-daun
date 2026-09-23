/* ============================================================
   weapons.js - guns, and the recoil that comes with them.

   Recoil is not flavour here, it is a movement system. A shotgun
   fired downward is the longest jump in the game, and a rocket
   fired at your own feet will put you across a gap you could not
   otherwise clear - at the cost of wherever you end up facing.
   ============================================================ */
(function (root) {
  'use strict';

  var GRAVITY = 520;

  /* rate: seconds between shots. recoil: impulse back along the barrel.
     knock: what it does to whoever it hits. */
  var WEAPONS = {
    pistol:  { name: 'PISTOL',  ammo: 8,  rate: 0.26, speed: 330, spread: 0.02,
               pellets: 1, recoil: 58,  knock: 78,  stun: 0.22, len: 7,  body: '#4c5164' },
    smg:     { name: 'SMG',     ammo: 28, rate: 0.08, speed: 310, spread: 0.10,
               pellets: 1, recoil: 24,  knock: 42,  stun: 0.12, len: 8,  body: '#3f4456' },
    shotgun: { name: 'SHOTGUN', ammo: 5,  rate: 0.72, speed: 275, spread: 0.24,
               pellets: 5, recoil: 205, knock: 120, stun: 0.42, len: 9,  body: '#6b4a2f' },
    sniper:  { name: 'RIFLE',   ammo: 3,  rate: 1.05, speed: 640, spread: 0,
               pellets: 1, recoil: 165, knock: 170, stun: 0.5,  len: 12, body: '#4a5040' },
    rocket:  { name: 'ROCKET',  ammo: 2,  rate: 1.1,  speed: 210, spread: 0,
               pellets: 1, recoil: 200, knock: 0,   stun: 0,    len: 10, body: '#5a4a3a',
               explosive: true, gravity: 190 }
  };

  var ORDER = ['pistol', 'smg', 'shotgun', 'sniper', 'rocket'];

  /* Where a gun points: the way you face, turned by however far the body
     has tipped over. Aiming is not a separate stick - it is your balance,
     which is why firing while you tumble sends shots anywhere. */
  function aimOf(r) {
    return r.facing === 1 ? r.tilt : Math.PI - r.tilt;
  }

  function muzzle(r, def) {
    var a = aimOf(r);
    var c = r.centre();
    return { x: c.x + Math.cos(a) * (def.len + 2), y: c.y + Math.sin(a) * (def.len + 2), a: a };
  }

  /* Returns true if a shot actually left the barrel. */
  function fire(world, r) {
    if (!r.weapon || r.cooldown > 0 || r.stun > 0) return false;
    var def = WEAPONS[r.weapon.key];
    if (!def) return false;

    var m = muzzle(r, def);
    for (var i = 0; i < def.pellets; i++) {
      var a = m.a + (def.spread ? U.rand(-def.spread, def.spread) : 0);
      world.bullets.push({
        x: m.x, y: m.y,
        vx: Math.cos(a) * def.speed * U.rand(0.94, 1.06),
        vy: Math.sin(a) * def.speed * U.rand(0.94, 1.06),
        def: def, owner: r, life: 2.2
      });
    }

    /* the shove, straight back down the barrel */
    r.vx -= Math.cos(m.a) * def.recoil;
    r.vy -= Math.sin(m.a) * def.recoil;
    r.spin += (r.facing === 1 ? -1 : 1) * def.recoil * 0.02;
    if (def.recoil > 100) r.grounded = false;

    r.cooldown = def.rate;
    r.flash = 0.06;
    world.shake = Math.max(world.shake, def.recoil > 150 ? 3.5 : 1.4);
    world.puff(m.x, m.y, def.pellets > 1 ? 7 : 4, '#ffe9a8');

    if (--r.weapon.ammo <= 0) r.weapon = null;
    return true;
  }

  function updateBullets(world, dt) {
    var solids = world.solids;
    for (var i = world.bullets.length - 1; i >= 0; i--) {
      var b = world.bullets[i];
      b.life -= dt;
      if (b.life <= 0) { world.bullets.splice(i, 1); continue; }
      if (b.def.gravity) b.vy += b.def.gravity * dt;

      var px = b.x, py = b.y;
      b.x += b.vx * dt;
      b.y += b.vy * dt;

      /* whoever it runs into first along the way */
      var hit = null, j, k;
      for (j = 0; j < world.racers.length; j++) {
        var o = world.racers[j];
        if (o === b.owner || o.finished || o.shield > 0) continue;
        if (b.x > o.x - 2 && b.x < o.x + o.w + 2 && b.y > o.y - 2 && b.y < o.y + o.h + 2) { hit = o; break; }
      }
      var wall = false;
      if (!hit) {
        for (k = 0; k < solids.length; k++) {
          var s = solids[k];
          if (s.oneWay) continue;
          if (b.x > s.x && b.x < s.x + s.w && b.y > s.y && b.y < s.y + s.h) { wall = true; break; }
        }
      }
      if (b.x < -60 || b.x > world.level.width + 60 || b.y > world.level.height + 80) {
        world.bullets.splice(i, 1);
        continue;
      }
      if (!hit && !wall) continue;

      if (b.def.explosive) {
        world.blast(b.x, b.y, 240);
      } else if (hit) {
        var a = Math.atan2(b.vy, b.vx);
        hit.hurt(Math.cos(a) * b.def.knock, Math.sin(a) * b.def.knock - 30, b.def.stun);
        world.puff(b.x, b.y, 6, '#ff8a3c');
        world.shake = Math.max(world.shake, 2);
      } else {
        world.puff(px, py, 3, '#d8d2c4');
      }
      world.bullets.splice(i, 1);
    }
  }

  root.WEAPONS = WEAPONS;
  root.WEAPON_ORDER = ORDER;
  root.Guns = { fire: fire, update: updateBullets, aimOf: aimOf, muzzle: muzzle };
})(typeof window !== 'undefined' ? window : globalThis);
