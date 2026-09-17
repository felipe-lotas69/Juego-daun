/* ============================================================
   input.js - keyboard + mouse state
   ============================================================ */
(function (root) {
  'use strict';

  var down = {};        /* held this frame */
  var pressedSet = {};  /* went down since last consume */

  var Input = {
    mouse: { x: 0, y: 0, down: false, pressed: false },

    /* held? */
    key: function (code) { return !!down[code]; },

    /* went down this frame? (consumed by Game each tick) */
    pressed: function (code) { return !!pressedSet[code]; },

    /* logical actions ------------------------------------- */
    left: function () { return down['KeyA'] || down['ArrowLeft']; },
    right: function () { return down['KeyD'] || down['ArrowRight']; },
    jump: function () { return down['KeyW'] || down['ArrowUp']; },
    jumpPressed: function () { return pressedSet['KeyW'] || pressedSet['ArrowUp']; },
    interactPressed: function () { return pressedSet['KeyR'] || pressedSet['KeyE']; },
    interactHeld: function () { return down['KeyR'] || down['KeyE']; },
    firePressed: function () { return pressedSet['Space'] || this.mouse.pressed; },
    fireHeld: function () { return down['Space'] || this.mouse.down; },
    dropPressed: function () { return pressedSet['KeyQ']; },

    clearFrame: function () { pressedSet = {}; this.mouse.pressed = false; },
    clearAll: function () { down = {}; pressedSet = {}; this.mouse.down = false; this.mouse.pressed = false; },

    init: function (canvas) {
      root.addEventListener('keydown', function (e) {
        /* stop the page scrolling out from under the game */
        if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].indexOf(e.code) >= 0) e.preventDefault();
        if (e.repeat) return;
        down[e.code] = true;
        pressedSet[e.code] = true;
      });
      root.addEventListener('keyup', function (e) { down[e.code] = false; });
      root.addEventListener('blur', function () { Input.clearAll(); });

      canvas.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        Input.mouse.down = true;
        Input.mouse.pressed = true;
      });
      root.addEventListener('mouseup', function () { Input.mouse.down = false; });
      canvas.addEventListener('mousemove', function (e) {
        var r = canvas.getBoundingClientRect();
        Input.mouse.x = (e.clientX - r.left) * (canvas.width / r.width);
        Input.mouse.y = (e.clientY - r.top) * (canvas.height / r.height);
      });
      canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    }
  };

  root.Input = Input;
})(window);
