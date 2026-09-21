/* ============================================================
   input.js - keyboard, mouse, gamepad and touch

   The rest of the game asks this module for an intent ("move",
   "cast slot 2") rather than for a key, so rebinding and the
   on-screen stick for phones are a single change here.
   ============================================================ */

import { clamp, normScale } from './util.js';

export const DEFAULT_BINDS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  dash: ['Space', 'ShiftLeft'],
  ability1: ['KeyQ'],
  ability2: ['KeyE'],
  ability3: ['KeyR'],
  ability4: ['KeyF'],
  interact: ['KeyG', 'KeyH'],
  skills: ['Tab'],
  map: ['KeyM'],
  pause: ['Escape', 'KeyP'],
  chat: ['Enter'],
  zoomIn: ['Equal', 'NumpadAdd'],
  zoomOut: ['Minus', 'NumpadSubtract'],
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.binds = JSON.parse(JSON.stringify(DEFAULT_BINDS));
    this.down = new Set();
    this.pressed = new Set();
    this.released = new Set();
    this.mouse = { x: 0, y: 0, nx: 0, ny: 0, down: false, rdown: false, wheel: 0 };
    this.mousePressed = false;
    this.rmbPressed = false;
    this.stick = { x: 0, y: 0, active: false, id: -1, ox: 0, oy: 0 };
    this.touchAim = { x: 0, y: 0, active: false, id: -1 };
    this.touchButtons = new Map();   /* name -> pressed this frame         */
    this.enabled = true;
    this.textCapture = null;         /* set while the chat box is open     */
    this._bind();
  }

  _bind() {
    const kd = (e) => {
      if (this.textCapture) {
        if (e.code === 'Escape' || e.code === 'Enter') this.textCapture(e.code === 'Enter' ? 'submit' : 'cancel');
        else if (e.code === 'Backspace') this.textCapture('back');
        else if (e.key.length === 1) this.textCapture(e.key);
        e.preventDefault();
        return;
      }
      if (!this.enabled) return;
      /* Tab and Space would scroll or move focus out of the canvas. */
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
    };
    const ku = (e) => {
      this.down.delete(e.code);
      this.released.add(e.code);
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', () => { this.down.clear(); this.mouse.down = false; });

    const c = this.canvas;
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('mousemove', (e) => this._moveMouse(e.clientX, e.clientY));
    c.addEventListener('mousedown', (e) => {
      this._moveMouse(e.clientX, e.clientY);
      if (e.button === 0) { if (!this.mouse.down) this.mousePressed = true; this.mouse.down = true; }
      if (e.button === 2) { if (!this.mouse.rdown) this.rmbPressed = true; this.mouse.rdown = true; }
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.down = false;
      if (e.button === 2) this.mouse.rdown = false;
    });
    c.addEventListener('wheel', (e) => { this.mouse.wheel += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });

    /* Touch: left half of the screen drives a virtual stick, right
       half aims and fires. On-screen buttons register themselves. */
    c.addEventListener('touchstart', (e) => this._touch(e, 'start'), { passive: false });
    c.addEventListener('touchmove', (e) => this._touch(e, 'move'), { passive: false });
    c.addEventListener('touchend', (e) => this._touch(e, 'end'), { passive: false });
    c.addEventListener('touchcancel', (e) => this._touch(e, 'end'), { passive: false });
  }

  _moveMouse(cx, cy) {
    const r = this.canvas.getBoundingClientRect();
    this.mouse.x = cx - r.left;
    this.mouse.y = cy - r.top;
    this.mouse.nx = (this.mouse.x / r.width) * 2 - 1;
    this.mouse.ny = -((this.mouse.y / r.height) * 2 - 1);
  }

  _touch(e, phase) {
    e.preventDefault();
    const r = this.canvas.getBoundingClientRect();
    for (const t of Array.from(e.changedTouches)) {
      const x = t.clientX - r.left, y = t.clientY - r.top;
      const leftHalf = x < r.width * 0.45;
      if (phase === 'start') {
        if (leftHalf && !this.stick.active) {
          this.stick.active = true; this.stick.id = t.identifier;
          this.stick.ox = x; this.stick.oy = y; this.stick.x = 0; this.stick.y = 0;
        } else if (!leftHalf) {
          this.touchAim.active = true; this.touchAim.id = t.identifier;
          this._moveMouse(t.clientX, t.clientY);
          this.mouse.down = true; this.mousePressed = true;
        }
      } else if (phase === 'move') {
        if (t.identifier === this.stick.id) {
          const dx = x - this.stick.ox, dy = y - this.stick.oy;
          const max = 52;
          const m = Math.hypot(dx, dy);
          const s = m > max ? max / m : 1;
          this.stick.x = clamp((dx * s) / max, -1, 1);
          this.stick.y = clamp((dy * s) / max, -1, 1);
        } else if (t.identifier === this.touchAim.id) {
          this._moveMouse(t.clientX, t.clientY);
        }
      } else {
        if (t.identifier === this.stick.id) { this.stick.active = false; this.stick.id = -1; this.stick.x = 0; this.stick.y = 0; }
        if (t.identifier === this.touchAim.id) { this.touchAim.active = false; this.touchAim.id = -1; this.mouse.down = false; }
      }
    }
  }

  /* ----------------------------------------------------------- queries */
  isDown(action) {
    const keys = this.binds[action];
    if (!keys) return false;
    for (const k of keys) if (this.down.has(k)) return true;
    return this.touchButtons.get(action) === 'held';
  }

  wasPressed(action) {
    const keys = this.binds[action];
    if (keys) for (const k of keys) if (this.pressed.has(k)) return true;
    return this.touchButtons.get(action) === 'pressed';
  }

  /* Movement intent in screen space, before the camera rotates it
     into world space. Keyboard, stick and gamepad all feed in. */
  moveVector() {
    let x = 0, y = 0;
    if (this.isDown('right')) x += 1;
    if (this.isDown('left')) x -= 1;
    if (this.isDown('down')) y += 1;
    if (this.isDown('up')) y -= 1;
    if (this.stick.active) { x += this.stick.x; y += this.stick.y; }
    const pad = this.gamepad();
    if (pad) { x += pad.lx; y += pad.ly; }
    const s = normScale(x, y);
    if (s === 0) return { x: 0, y: 0, mag: 0 };
    const mag = Math.min(1, Math.hypot(x, y));
    return { x: x * s * mag, y: y * s * mag, mag };
  }

  gamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
      return {
        lx: dz(p.axes[0] || 0), ly: dz(p.axes[1] || 0),
        rx: dz(p.axes[2] || 0), ry: dz(p.axes[3] || 0),
        fire: (p.buttons[7] && p.buttons[7].value > 0.3) || (p.buttons[0] && p.buttons[0].pressed),
        dash: p.buttons[6] && p.buttons[6].value > 0.3,
        a1: p.buttons[2] && p.buttons[2].pressed,
        a2: p.buttons[1] && p.buttons[1].pressed,
        a3: p.buttons[3] && p.buttons[3].pressed,
        a4: p.buttons[5] && p.buttons[5].pressed,
      };
    }
    return null;
  }

  firing() {
    const pad = this.gamepad();
    return this.mouse.down || (pad && pad.fire);
  }

  setTouchButton(name, state) { this.touchButtons.set(name, state); }

  /* Called once at the end of every frame. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
    this.mousePressed = false;
    this.rmbPressed = false;
    this.mouse.wheel = 0;
    for (const [k, v] of this.touchButtons) if (v === 'pressed') this.touchButtons.set(k, 'held');
  }
}
