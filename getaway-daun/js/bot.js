/* ============================================================
   bot.js - opponents.

   A jump here is a held key, not a button press, so a bot has to
   decide how long to hold BEFORE it commits. It measures the gap
   to the next landing, reads the wind-up it needs off a table of
   the real launch maths, holds that long, and lets go.
   ============================================================ */
(function (root) {
  'use strict';

  var GRAVITY = 520;

  /* the same numbers Racer.launch uses, so the table cannot drift */
  function shot(c) {
    var angle = 0.28 + c * 0.85;
    var speed = 150 + c * 105;
    var vx = Math.sin(angle) * speed, vy = Math.cos(angle) * speed;
    return { vx: vx, vy: vy, rise: vy * vy / (2 * GRAVITY), air: 2 * vy / GRAVITY };
  }

  /* How far a wind-up carries you, allowing for landing dy below you. */
  function reach(c, dy) {
    var s = shot(c);
    /* solve for the time the arc is dy below the start (dy>0 = lower) */
    var disc = s.vy * s.vy + 2 * GRAVITY * dy;
    if (disc < 0) return -1;                       /* never gets that high */
    var t = (s.vy + Math.sqrt(disc)) / GRAVITY;
    return s.vx * t;
  }

  var PERSONALITY = [
    { name: 'steady', margin: 8,  react: 0.10, greed: 0.5, itemAt: 0.5 },
    { name: 'reckless', margin: 2, react: 0.05, greed: 0.9, itemAt: 0.2 },
    { name: 'careful', margin: 9, react: 0.14, greed: 0.3, itemAt: 0.8 },
    { name: 'scrapper', margin: 6, react: 0.08, greed: 0.7, itemAt: 0.35 }
  ];

  function Bot(racer, index) {
    this.r = racer;
    this.p = PERSONALITY[index % PERSONALITY.length];
    this.want = 0;          /* the charge it is holding out for */
    this.think = 0;
    this.stuckFor = 0;
    this.lastX = racer.x;
    this.useItem = false;
  }

  /* What we are standing on, and the next thing along. Both matter: a
     bot that aims at the ledge it is already on picks the smallest
     wind-up it has, and the smallest wind-up still travels twenty-odd
     pixels - straight off the end and into the gap. */
  Bot.prototype.ground = function (world) {
    var r = this.r, feet = r.y + r.h, best = null;
    for (var i = 0; i < world.solids.length; i++) {
      var s = world.solids[i];
      if (s.type === 'bounce') continue;
      if (Math.abs(s.y - feet) > 3) continue;
      if (r.x + r.w < s.x || r.x > s.x + s.w) continue;
      if (!best || s.x + s.w > best.x + best.w) best = s;
    }
    return best;
  };

  Bot.prototype.nextSurface = function (world, cur) {
    var r = this.r, feet = r.y + r.h, best = null;
    /* Measure from just ahead of US, not from the end of what we are
       standing on: on a floor that runs the length of the level, the end
       of it is the finish line, and everything worth climbing onto looks
       like it is behind us. `cur` is excluded by identity instead. */
    var from = r.x + r.w;
    for (var i = 0; i < world.solids.length; i++) {
      var s = world.solids[i];
      if (s.type === 'bounce') continue;
      if (s === cur) continue;
      if (s.x + s.w <= from + 1) continue;          /* behind or under us */
      if (s.y > feet + 80) continue;                /* a long way down */
      if (s.y < feet - 30) continue;                /* above what we can climb */
      var edge = Math.max(s.x, from);
      if (!best || edge < best.edge) best = { edge: edge, y: s.y, solid: s };
    }
    return best;
  };

  /* Is anyone roughly down the barrel? Aim follows the body, so a bot
     cannot line a shot up deliberately - it just takes the ones its own
     tumbling happens to offer. */
  Bot.prototype.lineUp = function (world) {
    var r = this.r;
    if (!r.weapon || r.cooldown > 0) return false;
    var a = Guns.aimOf(r), c = r.centre();
    for (var i = 0; i < world.racers.length; i++) {
      var o = world.racers[i];
      if (o === r || o.finished || o.shield > 0) continue;
      var oc = o.centre();
      var d = U.dist(c.x, c.y, oc.x, oc.y);
      if (d > 150) continue;
      var want = Math.atan2(oc.y - c.y, oc.x - c.x);
      var diff = Math.abs(((want - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      if (diff < 0.30) return true;
    }
    return false;
  };

  Bot.prototype.update = function (dt, world) {
    var r = this.r;
    var out = { left: false, right: false, fire: false, firePressed: false };
    if (r.finished || r.stun > 0) return out;

    /* nudge in the air so it lands on its feet rather than its head */
    if (!r.grounded) {
      if (r.spin > 2.2) out.left = true;
      else if (r.spin < -2.2) out.right = true;
      /* a boost mid-flight is how it clears the long ones */
      if (r.util === 'boost' && r.vy > 20 && r.vx > 40) out.firePressed = true;
      /* and it will take a shot on the way past if one lines up */
      if (r.weapon && this.lineUp(world)) { out.fire = true; }
      return out;
    }

    this.think -= dt;
    if (this.think <= 0) {
      this.think = this.p.react;
      var goal = world.level.goal;
      var cur = this.ground(world);
      var next = this.nextSurface(world, cur);
      var need, dy, c;

      if (!next || next.edge >= goal.x) {
        need = Math.max(16, goal.x - (r.x + r.w));
        dy = 0;
      } else {
        need = next.edge - (r.x + r.w) + this.p.margin;
        dy = next.y - (r.y + r.h);
      }

      var pick = -1;
      for (c = 0; c <= 1.0001; c += 0.05) {
        if (reach(c, dy) >= need) { pick = c; break; }
      }

      var room = cur ? (cur.x + cur.w) - (r.x + r.w) - 5 : -1;
      var shuffled = false;
      if (pick < 0 && cur && room > 10) {
        /* Cannot clear it from here, but there is ledge left to walk.
           Shuffle: the biggest wind-up that still lands on this ledge. */
        for (c = 1; c >= 0; c -= 0.05) {
          if (reach(c, 0) <= room) { this.want = Math.max(0.05, c); shuffled = true; break; }
        }
      }
      if (!shuffled) {
        if (pick < 0) {
          /* Nothing covers it - either the gap is too wide or there is no
             room left to shuffle into, and the smallest hop there is would
             step straight off the end. Take the wind-up that gets FURTHEST
             for this climb, which is never the full one: a full wind-up is
             the flattest jump there is and barely rises at all. */
          var bestC = 0.4, bestD = -1;
          for (c = 0; c <= 1.0001; c += 0.05) {
            var d = reach(c, dy);
            if (d > bestD) { bestD = d; bestC = c; }
          }
          this.want = bestC;
        } else {
          /* Bias every jump long. Overshooting a ledge costs nothing -
             you land further along it - while undershooting by a pixel
             means hitting the wall face and dropping the whole way. */
          this.want = U.clamp(pick + 0.12 + this.p.greed * 0.1, 0.05, 1);
        }
      }

      /* guns: it shoots when someone is roughly down the barrel, and
         saves a shield for when the scrum closes in */
      this.useItem = false;
      if (r.util) {
        var near = null, nd = 1e9;
        for (var i = 0; i < world.racers.length; i++) {
          var o = world.racers[i];
          if (o === r || o.finished) continue;
          var d = Math.abs(o.x - r.x);
          if (d < nd) { nd = d; near = o; }
        }
        if (r.util === 'shield' && near && nd < 40) this.useItem = true;
        else if (r.util === 'boost' && this.want > 0.9) this.useItem = true;
      }
    }

    out.firePressed = this.useItem;
    if (this.useItem) this.useItem = false;
    if (r.weapon && this.lineUp(world)) out.fire = true;

    /* hold right until the wind-up is long enough, then let go */
    out.right = r.charge < this.want;

    /* if it has got itself wedged, throw a full jump at the problem */
    if (Math.abs(r.x - this.lastX) < 1.2) this.stuckFor += dt; else this.stuckFor = 0;
    this.lastX = r.x;
    if (this.stuckFor > 2.2) {
      /* A FULL wind-up is the flattest jump there is - useless against
         the thing it is most likely wedged on, which is a wall. Mid
         charge is where the lift is. */
      out.right = r.charge < 0.35;
      if (this.stuckFor > 3.4) { this.stuckFor = 0; }
    }
    return out;
  };

  root.Bot = Bot;
  root.botReach = reach;
})(typeof window !== 'undefined' ? window : globalThis);
