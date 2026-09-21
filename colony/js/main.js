/* ============================================================
   main.js - boot and the frame loop.

   The simulation runs on a fixed 60-ticks-per-second clock and the
   renderer runs as fast as the browser will let it, so the loop
   accumulates real time, spends it in whole ticks, and hands the
   leftover fraction to the renderer for interpolation.
   ============================================================ */
(function (root) {
  'use strict';

  var TICK_SECONDS = 1 / 60;
  var canvas, lastTime = 0, accumulator = 0, booted = false;
  var frameErrors = 0;

  function boot() {
    if (booted) return;
    booted = true;

    canvas = document.getElementById('game');

    Art.init();
    Render.init(canvas);
    UI.init();
    Input.init(canvas);

    window.addEventListener('resize', function () { Render.resize(); });

    UI.showMenu();
    lastTime = performance.now();
    requestAnimationFrame(frame);
  }

  function frame(now) {
    requestAnimationFrame(frame);

    var dt = (now - lastTime) / 1000;
    lastTime = now;
    /* A backgrounded tab hands back a huge dt; spending it would freeze
       the page while the colony lived a week in one frame. */
    if (dt > 0.25) dt = 0.25;

    try {
      if (Game.started && !Game.gameOver) {
        var mult = Game.speeds[Game.speed];
        if (mult > 0) {
          accumulator += dt * mult;
          var budget = 0, maxTicks = 20 * mult;
          while (accumulator >= TICK_SECONDS && budget < maxTicks) {
            Game.doTick();
            accumulator -= TICK_SECONDS;
            budget++;
          }
          /* If we could not keep up, drop the backlog rather than
             sliding further behind every frame. */
          if (accumulator > TICK_SECONDS * 4) accumulator = 0;
        } else {
          accumulator = 0;
        }
      }

      Input.update();
      Render.frame(Math.min(1, accumulator / TICK_SECONDS));
      UI.update();
      frameErrors = 0;
    } catch (err) {
      frameErrors++;
      if (frameErrors < 4) console.error('frame error:', err);
      if (frameErrors === 4) {
        console.error('too many frame errors; pausing the simulation');
        Game.setSpeed(0);
        if (UI && UI.toast) UI.toast('Something went wrong - the colony is paused. Check the console.');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  root.RimdaunBoot = boot;
})(this);
