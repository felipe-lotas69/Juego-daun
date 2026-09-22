/* ============================================================
   util.js - small shared helpers

   Nothing here knows about rendering or the DOM, so the same code
   runs in a browser tab and inside the headless host simulation.
   ============================================================ */

export const TAU = Math.PI * 2;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const inverseLerp = (a, b, v) => (b === a ? 0 : clamp01((v - a) / (b - a)));
export const smoothstep = (a, b, v) => { const t = inverseLerp(a, b, v); return t * t * (3 - 2 * t); };

/* Frame-rate independent exponential approach: the fraction of the
   remaining distance covered per second, converted for dt. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

export function angleLerp(a, b, t) {
  let d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * t;
}

export function angleDelta(a, b) {
  return ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
}

export const dist2 = (ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  return dx * dx + dy * dy;
};

export const dist = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

/* Normalise in place-ish: returns a scale factor, or 0 for a zero
   vector, so callers never divide by zero. */
export function normScale(x, y) {
  const m = Math.hypot(x, y);
  return m > 1e-6 ? 1 / m : 0;
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* Rounds a number for the wire: two decimals is well under a pixel
   at our scale and keeps snapshots small. */
export const q = (v) => Math.round(v * 100) / 100;

let idCounter = 1;
export function nextId(prefix = 'e') { return prefix + (idCounter++); }

/* A fixed-size ring buffer, used for input history and ping graphs. */
export class Ring {
  constructor(size) { this.size = size; this.items = []; this.head = 0; }
  push(v) {
    if (this.items.length < this.size) this.items.push(v);
    else { this.items[this.head] = v; this.head = (this.head + 1) % this.size; }
  }
  toArray() {
    if (this.items.length < this.size) return this.items.slice();
    return this.items.slice(this.head).concat(this.items.slice(0, this.head));
  }
  get last() {
    if (!this.items.length) return undefined;
    return this.items[(this.head - 1 + this.items.length) % this.items.length];
  }
  clear() { this.items.length = 0; this.head = 0; }
}

/* Generic object pool. The renderer churns through a lot of short
   lived particles and damage numbers; this keeps the GC quiet. */
export class Pool {
  constructor(factory, reset) {
    this.factory = factory;
    this.reset = reset;
    this.free = [];
    this.live = [];
  }
  get() {
    const obj = this.free.pop() || this.factory();
    this.live.push(obj);
    return obj;
  }
  release(obj) {
    const i = this.live.indexOf(obj);
    if (i >= 0) this.live.splice(i, 1);
    if (this.reset) this.reset(obj);
    this.free.push(obj);
  }
  releaseAt(i) {
    const obj = this.live[i];
    this.live.splice(i, 1);
    if (this.reset) this.reset(obj);
    this.free.push(obj);
    return obj;
  }
  clear() {
    while (this.live.length) this.releaseAt(this.live.length - 1);
  }
}

/* Minimal event emitter. The UI listens to the simulation through
   this rather than reaching into game state every frame. */
export class Emitter {
  constructor() { this.handlers = new Map(); }
  on(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
    return () => this.off(type, fn);
  }
  off(type, fn) {
    const list = this.handlers.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  emit(type, payload) {
    const list = this.handlers.get(type);
    if (list) for (let i = 0; i < list.length; i++) list[i](payload);
    const any = this.handlers.get('*');
    if (any) for (let i = 0; i < any.length; i++) any[i](type, payload);
  }
  clear() { this.handlers.clear(); }
}
