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

    /* A pad is one player's key mapping. Pad 0 is WASD (plus the arrows,
       which is what a single player expects); pad 1 is the arrows only, so
       two people can share a keyboard. */
    makePad: function (keys) {
      var I = this;
      function held(list) { for (var i = 0; i < list.length; i++) if (down[list[i]]) return true; return false; }
      function hit(list) { for (var i = 0; i < list.length; i++) if (pressedSet[list[i]]) return true; return false; }
      return {
        left: function () { return held(keys.left); },
        right: function () { return held(keys.right); },
        jump: function () { return held(keys.jump); },
        jumpPressed: function () { return hit(keys.jump); },
        interactPressed: function () { return hit(keys.use); },
        interactHeld: function () { return held(keys.use); },
        firePressed: function () { return hit(keys.fire) || (keys.mouse && I.mouse.pressed); },
        fireHeld: function () { return held(keys.fire) || (keys.mouse && I.mouse.down); },
        dropPressed: function () { return hit(keys.drop); },
        pressed: function (code) { return !!pressedSet[code]; },
        mouse: I.mouse
      };
    },

    pads: function () {
      if (!this._pads) {
        this._pads = [
          this.makePad({ left: ['KeyA'], right: ['KeyD'], jump: ['KeyW'],
                         use: ['KeyR', 'KeyE'], fire: ['Space'], drop: ['KeyQ'], mouse: true }),
          this.makePad({ left: ['ArrowLeft'], right: ['ArrowRight'], jump: ['ArrowUp'],
                         use: ['Enter', 'NumpadEnter'], fire: ['ShiftRight', 'Numpad0'],
                         drop: ['ArrowDown'], mouse: false })
        ];
      }
      return this._pads;
    },

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
