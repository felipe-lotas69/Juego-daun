/* A DOM and canvas stub just real enough to boot the game outside a browser.

   It is not a browser: nothing is laid out and nothing is painted. What it
   does give us is every call the client code makes actually running, which
   is where the crashes are. Canvas operations are counted so a test can
   assert that the renderer drew something rather than silently skipping.  */
'use strict';

function makeCtx(canvas, counters) {
  const ctx = {
    canvas: canvas,
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, globalAlpha: 1,
    globalCompositeOperation: 'source-over', font: '10px sans-serif',
    textAlign: 'left', textBaseline: 'alphabetic', imageSmoothingEnabled: true,
    lineCap: 'butt', lineJoin: 'miter', shadowBlur: 0, shadowColor: '#000',
    filter: 'none', lineDashOffset: 0
  };
  const noop = name => function () { counters[name] = (counters[name] || 0) + 1; };
  [
    'save', 'restore', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo',
    'rect', 'roundRect', 'ellipse', 'quadraticCurveTo', 'bezierCurveTo', 'fill', 'stroke',
    'clip', 'translate', 'scale', 'rotate', 'transform', 'setTransform', 'resetTransform',
    'clearRect', 'fillRect', 'strokeRect', 'drawImage', 'fillText', 'strokeText',
    'setLineDash', 'putImageData', 'createPattern'
  ].forEach(n => { ctx[n] = noop(n); });

  ctx.measureText = function (t) { return { width: String(t).length * 6, actualBoundingBoxAscent: 8 }; };
  ctx.createImageData = function (w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; };
  ctx.getImageData = function (x, y, w, h) { return ctx.createImageData(w || 1, h || 1); };
  ctx.createLinearGradient = function () { return { addColorStop: function () {} }; };
  ctx.createRadialGradient = ctx.createLinearGradient;
  ctx.getLineDash = function () { return []; };
  return ctx;
}

function install(root, opts) {
  opts = opts || {};
  const counters = {};
  const listeners = [];

  function makeEl(tag) {
    const el = {
      tagName: String(tag || 'div').toUpperCase(),
      nodeType: 1,
      id: '', className: '', title: '', value: '', textContent: '', checked: false,
      disabled: false, width: 0, height: 0, children: [], childNodes: [],
      parentNode: null, dataset: {}, style: new Proxy({}, { get: (t, k) => t[k] || '', set: (t, k, v) => { t[k] = v; return true; } }),
      scrollTop: 0, scrollHeight: 0, clientWidth: opts.width || 1280, clientHeight: opts.height || 720,
      offsetWidth: opts.width || 1280, offsetHeight: opts.height || 720
    };
    el.classList = {
      _s: new Set(),
      add() { for (const a of arguments) this._s.add(a); },
      remove() { for (const a of arguments) this._s.delete(a); },
      toggle(c, on) { if (on === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else if (on) this._s.add(c); else this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    };
    el.appendChild = function (c) { el.children.push(c); el.childNodes.push(c); c.parentNode = el; return c; };
    el.append = function () { for (const c of arguments) if (typeof c === 'object') el.appendChild(c); };
    el.insertBefore = function (c) { return el.appendChild(c); };
    el.removeChild = function (c) {
      const i = el.children.indexOf(c);
      if (i >= 0) { el.children.splice(i, 1); el.childNodes.splice(i, 1); }
      return c;
    };
    el.remove = function () { if (el.parentNode) el.parentNode.removeChild(el); };
    el.replaceChildren = function () { el.children.length = 0; el.childNodes.length = 0; el.append.apply(null, arguments); };
    el.addEventListener = function (type, fn) { listeners.push({ el, type, fn }); };
    el.removeEventListener = function () {};
    el.dispatchEvent = function (ev) {
      listeners.filter(l => l.el === el && l.type === ev.type).forEach(l => l.fn(ev));
      return true;
    };
    el.setAttribute = function (k, v) { el[k] = v; if (k.startsWith('data-')) el.dataset[k.slice(5)] = v; };
    el.getAttribute = function (k) { return el[k] === undefined ? null : el[k]; };
    el.removeAttribute = function (k) { delete el[k]; };
    el.hasAttribute = function (k) { return el[k] !== undefined; };
    el.focus = el.blur = el.scrollIntoView = function () {};
    el.getBoundingClientRect = function () {
      return { left: 0, top: 0, right: el.clientWidth, bottom: el.clientHeight, width: el.clientWidth, height: el.clientHeight, x: 0, y: 0 };
    };
    el.querySelector = function (sel) { return findIn(el, sel); };
    el.querySelectorAll = function (sel) { return findAllIn(el, sel); };
    el.closest = function () { return null; };
    el.cloneNode = function () { return makeEl(tag); };
    Object.defineProperty(el, 'innerHTML', {
      get() { return el._html || ''; },
      set(v) { el._html = v; el.children.length = 0; el.childNodes.length = 0; counters.innerHTML = (counters.innerHTML || 0) + 1; }
    });
    Object.defineProperty(el, 'firstChild', { get() { return el.children[0] || null; } });
    Object.defineProperty(el, 'lastChild', { get() { return el.children[el.children.length - 1] || null; } });
    if (el.tagName === 'CANVAS') {
      const ctx = makeCtx(el, counters);
      el.getContext = function () { return ctx; };
      el.toDataURL = function () { return 'data:,'; };
      el.width = 16; el.height = 16;
    }
    return el;
  }

  function matches(el, sel) {
    if (!sel) return false;
    if (sel[0] === '#') return el.id === sel.slice(1);
    if (sel[0] === '.') return el.classList.contains(sel.slice(1));
    return el.tagName === sel.toUpperCase();
  }
  function findIn(el, sel) {
    for (const c of el.children) {
      if (matches(c, sel)) return c;
      const deep = findIn(c, sel);
      if (deep) return deep;
    }
    return null;
  }
  function findAllIn(el, sel, out) {
    out = out || [];
    for (const c of el.children) {
      if (matches(c, sel)) out.push(c);
      findAllIn(c, sel, out);
    }
    return out;
  }

  const byId = Object.create(null);
  const body = makeEl('body');
  const doc = {
    body: body,
    documentElement: makeEl('html'),
    readyState: 'complete',
    createElement: makeEl,
    createDocumentFragment: () => makeEl('fragment'),
    createTextNode: t => ({ nodeType: 3, textContent: t }),
    getElementById: function (id) {
      if (!byId[id]) { const el = makeEl('div'); el.id = id; body.appendChild(el); byId[id] = el; }
      return byId[id];
    },
    querySelector: sel => (sel[0] === '#' ? doc.getElementById(sel.slice(1)) : findIn(body, sel)),
    querySelectorAll: sel => findAllIn(body, sel),
    addEventListener: function (type, fn) { listeners.push({ el: doc, type, fn }); },
    removeEventListener: function () {},
    dispatchEvent: function (ev) { listeners.filter(l => l.el === doc && l.type === ev.type).forEach(l => l.fn(ev)); return true; },
    getElementsByTagName: tag => findAllIn(body, tag),
    hasFocus: () => true,
    activeElement: body
  };

  /* The panels index.html declares, so getElementById finds real ids. */
  ['game', 'app', 'topbar', 'colonist-bar', 'alerts', 'messages', 'letters', 'inspect',
   'architect', 'tab-panel', 'float-menu', 'tooltip', 'menu', 'modal'].forEach(id => {
    const el = makeEl(id === 'game' ? 'canvas' : 'div');
    el.id = id;
    if (id === 'game') { el.width = opts.width || 1280; el.height = opts.height || 720; }
    body.appendChild(el);
    byId[id] = el;
  });

  const storage = {
    _d: Object.create(null),
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
    removeItem(k) { delete this._d[k]; },
    clear() { this._d = Object.create(null); },
    key(i) { return Object.keys(this._d)[i] || null; },
    get length() { return Object.keys(this._d).length; }
  };

  let rafCallbacks = [];
  root.document = doc;
  root.navigator = { userAgent: 'node', language: 'en' };
  root.localStorage = storage;
  root.sessionStorage = storage;
  root.devicePixelRatio = 1;
  root.innerWidth = opts.width || 1280;
  root.innerHeight = opts.height || 720;
  root.performance = { now: () => counters.__now = (counters.__now || 0) + 16.7 };
  root.requestAnimationFrame = function (fn) { rafCallbacks.push(fn); return rafCallbacks.length; };
  root.cancelAnimationFrame = function () {};
  root.addEventListener = function (type, fn) { listeners.push({ el: root, type, fn }); };
  root.removeEventListener = function () {};
  root.dispatchEvent = function (ev) { listeners.filter(l => l.el === root && l.type === ev.type).forEach(l => l.fn(ev)); return true; };
  root.getComputedStyle = function () { return { getPropertyValue: () => '' }; };
  root.matchMedia = function () { return { matches: false, addListener() {}, addEventListener() {} }; };
  root.alert = root.confirm = function () { return true; };
  root.setTimeout = function (fn) { return 0; };
  root.clearTimeout = root.clearInterval = function () {};
  root.setInterval = function () { return 0; };
  root.Image = function () { return makeEl('img'); };
  root.OffscreenCanvas = function (w, h) { const c = makeEl('canvas'); c.width = w; c.height = h; return c; };

  return {
    document: doc,
    counters: counters,
    listeners: listeners,
    runFrames: function (n) {
      for (let i = 0; i < n; i++) {
        const queued = rafCallbacks;
        rafCallbacks = [];
        queued.forEach(fn => fn(root.performance.now()));
      }
    },
    pendingFrames: () => rafCallbacks.length,
    fire: function (target, type, props) {
      const ev = Object.assign({ type, preventDefault() {}, stopPropagation() {}, target }, props || {});
      (target.dispatchEvent ? target : doc).dispatchEvent(ev);
      return ev;
    }
  };
}

module.exports = { install };
