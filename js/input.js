/* ============================================================
   input.js - mouse, keyboard, selection, drag painting, orders.

   Two rules run through the whole file.

   One: the pointer is read out of events into `pointer` and
   nothing else ever asks the DOM where the mouse is. The canvas
   rect is cached and refreshed on resize, because a
   getBoundingClientRect() per mousemove is a layout flush per
   mousemove.

   Two: everything that changes the world goes through the system
   that owns it - Construct places blueprints, Zones owns zone
   cells, Jobs starts jobs, Animals owns animal designations - and
   every one of those calls is guarded. A click can land during
   boot, on a map that does not exist yet, or on a colony whose
   simulation files loaded in a different order than expected, and
   none of that may throw inside an event handler.
   ============================================================ */
(function (root) {
  'use strict';

  var U = root.U;
  var doc = root.document;
  var perf = root.performance;

  var Input = {};

  /* ---------- tuning ---------- */

  /* How far the mouse must travel before a press stops being a click
     and becomes a drag. Four pixels is enough to forgive a shaky hand
     without swallowing a deliberate one-tile drag. */
  var DRAG_PX = 4;
  var DOUBLE_MS = 320;
  /* Clicking the same cell again within this window walks down the
     stack of things standing on it, the way RimWorld cycles. */
  var CYCLE_MS = 1400;

  /* Key panning in CSS pixels per second: starts gentle so a tap nudges
     the view, ramps to fast so crossing a 140-tile map is not a chore. */
  var PAN_SLOW = 700, PAN_FAST = 2100, PAN_RAMP = 0.7;

  /* A drag across the whole map must not lock the tab up. */
  var MAX_TOOL_CELLS = 2400;
  var FLOAT_MAX = 14;
  /* How far from the clicked cell a group move order may spread. */
  var ORDER_SPREAD = 4;

  /* ---------- pointer, the single source of truth ---------- */

  var canvas = null, inited = false;
  var rectLeft = 0, rectTop = 0;

  var pointer = {
    sx: 0, sy: 0,              /* CSS pixels inside the canvas */
    clientX: 0, clientY: 0,    /* viewport pixels, for the float menu */
    x: -1, y: -1,              /* tile under the cursor, may be off-map */
    inside: false,
    shift: false, ctrl: false, alt: false
  };

  var drag = {
    active: false, mode: 'none', button: -1, moved: false,
    startSX: 0, startSY: 0,
    panSX: 0, panSY: 0,
    x0: 0, y0: 0, x1: 0, y1: 0,
    additive: false, erase: false
  };
  /* render.js reads Input.drag for the build ghost, so this object is
     reused rather than rebuilt: it is live every frame of a drag. */
  var dragRect = { x0: 0, y0: 0, x1: 0, y1: 0 };

  var held = Object.create(null);
  var panHeld = 0, lastFrame = 0;
  var lastClick = { x: -999, y: -999, t: -1e9, index: 0 };
  var tabCycle = 0;

  var panelCache = Object.create(null);

  Input.pointer = pointer;
  Input.drag = null;

  /* ---------- tiny accessors ---------- */

  function theMap() {
    var G = root.Game;
    return (G && G.map) ? G.map : null;
  }

  function ui() { return root.UI || null; }

  function tool() {
    var UIx = ui();
    return (UIx && UIx.tool) ? UIx.tool : null;
  }

  function toolKind() {
    var t = tool();
    return (t && t.kind) ? t.kind : 'select';
  }

  function clearTool() {
    var UIx = ui();
    if (UIx && UIx.clearTool) { UIx.clearTool(); return; }
    var t = tool();
    if (!t) return;
    t.kind = 'select'; t.defId = null; t.designation = null;
    t.zoneKind = null; t.zone = null;
  }

  function setTool(spec) {
    var UIx = ui();
    if (UIx && UIx.setTool) { UIx.setTool(spec); return true; }
    var t = tool();
    if (!t) return false;
    t.kind = spec.kind || 'select';
    t.defId = spec.defId || null;
    t.rot = spec.rot || 0;
    t.stuffId = spec.stuffId || null;
    t.designation = spec.designation || null;
    t.zoneKind = spec.zoneKind || null;
    t.zone = spec.zone || null;
    return true;
  }

  function notify(text) {
    if (!text) return;
    var UIx = ui();
    if (UIx && UIx.toast) { UIx.toast(text); return; }
    var G = root.Game;
    if (G && G.msg) G.msg(text);
  }

  function refreshInspect() {
    var UIx = ui();
    if (UIx && UIx.refreshInspect) UIx.refreshInspect();
  }

  function closeFloatMenu() {
    var UIx = ui();
    if (UIx && UIx.closeFloatMenu) UIx.closeFloatMenu();
  }

  function now() { return (perf && perf.now) ? perf.now() : Date.now(); }

  function el(id) { return (doc && doc.getElementById) ? doc.getElementById(id) : null; }

  /* Cached, but re-looked-up if ui.js ever replaces the node rather
     than filling it, because a stale reference would report a panel as
     closed forever. */
  function panel(id) {
    var node = panelCache[id];
    if (!node || node.isConnected === false) { node = el(id); panelCache[id] = node; }
    return node;
  }

  /* A panel counts as open when it is neither carrying the `hidden`
     class index.html ships nor hidden by an inline style. Only escape
     and the key guard ask this, so the DOM read is not in a hot path. */
  function panelOpen(id) {
    var node = panel(id);
    if (!node) return false;
    if (node.classList && node.classList.contains('hidden')) return false;
    if (node.style && node.style.display === 'none') return false;
    return true;
  }

  function labelOfThing(t) {
    if (!t) return 'it';
    if (typeof t.label === 'function') return t.label();
    if (t.def && t.def.label) return t.def.label;
    return t.defId || 'it';
  }

  function nameOf(pawn) {
    if (!pawn) return 'someone';
    if (typeof pawn.label === 'function') return pawn.label();
    if (pawn.name) return pawn.name.nick || pawn.name.first || 'someone';
    return 'someone';
  }

  /* ---------- init ---------- */

  Input.init = function (c) {
    if (inited) return Input;
    canvas = c || el('game');
    if (!canvas || !canvas.addEventListener || !root.addEventListener) return Input;
    inited = true;

    refreshRect();

    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseenter', onMouseEnter);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('contextmenu', onContextMenu);
    /* Not passive: the wheel is a zoom here and the page must not
       scroll or pinch-zoom underneath it. */
    canvas.addEventListener('wheel', onWheel, { passive: false });

    /* Move and release live on the window so a drag that wanders over
       the architect panel, or ends outside the window, still finishes. */
    root.addEventListener('mousemove', onMouseMove);
    root.addEventListener('mouseup', onMouseUp);
    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('keyup', onKeyUp);
    root.addEventListener('blur', onBlur);
    root.addEventListener('resize', refreshRect);
    root.addEventListener('scroll', refreshRect, true);

    lastFrame = now();
    return Input;
  };

  function refreshRect() {
    if (!canvas || !canvas.getBoundingClientRect) return;
    var r = canvas.getBoundingClientRect();
    rectLeft = r.left; rectTop = r.top;
  }

  function setPointer(e) {
    /* Moving over the canvas counts as being over the world even if no
       mouseenter was ever seen - the page can load under the cursor. */
    if (e.target === canvas) pointer.inside = true;
    pointer.clientX = e.clientX; pointer.clientY = e.clientY;
    pointer.sx = e.clientX - rectLeft;
    pointer.sy = e.clientY - rectTop;
    pointer.shift = !!e.shiftKey;
    pointer.ctrl = !!(e.ctrlKey || e.metaKey);
    pointer.alt = !!e.altKey;
    syncTile();
  }

  function syncTile() {
    var R = root.Render;
    if (!R || !R.screenToTile) { pointer.x = -1; pointer.y = -1; return; }
    var t = R.screenToTile(pointer.sx, pointer.sy);
    pointer.x = t.x; pointer.y = t.y;
  }

  function clampTile(v, hi) { return v < 0 ? 0 : (v > hi ? hi : v); }

  /* ---------- mouse ---------- */

  function onMouseEnter() { pointer.inside = true; }
  function onMouseLeave() { pointer.inside = false; }
  function onContextMenu(e) { e.preventDefault(); }

  function onMouseDown(e) {
    /* A press that starts on a panel belongs to the panel. The canvas
       sits under every HUD element, so identity is the whole test. */
    if (e.target !== canvas) return;
    refreshRect();
    setPointer(e);
    pointer.inside = true;
    closeFloatMenu();

    var m = theMap();

    if (e.button === 1) {
      /* Middle drag pans, and the browser's autoscroll must not open. */
      e.preventDefault();
      beginPan(e);
      return;
    }

    if (e.button === 2) {
      /* Right is ambiguous until the mouse moves: a pan if it travels,
         an order if it does not. Both start the same way. */
      beginPan(e);
      drag.mode = 'rightpan';
      return;
    }

    if (e.button !== 0 || !m) return;

    drag.active = true;
    drag.button = 0;
    drag.moved = false;
    drag.startSX = pointer.sx;
    drag.startSY = pointer.sy;
    drag.additive = pointer.shift;
    drag.erase = pointer.shift;
    drag.mode = toolKind() === 'select' ? 'select' : 'tool';
    drag.x0 = drag.x1 = clampTile(pointer.x, m.w - 1);
    drag.y0 = drag.y1 = clampTile(pointer.y, m.h - 1);
    publishDragRect();
  }

  function beginPan(e) {
    drag.active = true;
    drag.button = e.button;
    drag.mode = 'pan';
    drag.moved = false;
    drag.startSX = pointer.sx;
    drag.startSY = pointer.sy;
    drag.panSX = e.clientX;
    drag.panSY = e.clientY;
  }

  function onMouseMove(e) {
    setPointer(e);
    if (!drag.active) return;

    if (!drag.moved) {
      var dx = pointer.sx - drag.startSX, dy = pointer.sy - drag.startSY;
      if (dx * dx + dy * dy > DRAG_PX * DRAG_PX) drag.moved = true;
    }

    if (drag.mode === 'pan' || drag.mode === 'rightpan') {
      if (!drag.moved) return;
      var R = root.Render;
      if (R && R.panBy) R.panBy(-(e.clientX - drag.panSX), -(e.clientY - drag.panSY));
      drag.panSX = e.clientX; drag.panSY = e.clientY;
      return;
    }

    updateDragEnd();
  }

  function updateDragEnd() {
    var m = theMap();
    if (!m || (drag.mode !== 'select' && drag.mode !== 'tool')) return;
    drag.x1 = clampTile(pointer.x, m.w - 1);
    drag.y1 = clampTile(pointer.y, m.h - 1);
    publishDragRect();
  }

  function publishDragRect() {
    dragRect.x0 = Math.min(drag.x0, drag.x1);
    dragRect.x1 = Math.max(drag.x0, drag.x1);
    dragRect.y0 = Math.min(drag.y0, drag.y1);
    dragRect.y1 = Math.max(drag.y0, drag.y1);
    Input.drag = dragRect;
    var R = root.Render;
    if (R && R.setSelectionBox) R.setSelectionBox(dragRect);
  }

  function endDragVisuals() {
    Input.drag = null;
    var R = root.Render;
    if (R && R.setSelectionBox) R.setSelectionBox(null);
  }

  function onMouseUp(e) {
    if (!drag.active) return;
    if (e.button !== drag.button) return;
    setPointer(e);

    var mode = drag.mode, moved = drag.moved;
    drag.active = false;
    drag.mode = 'none';
    drag.button = -1;

    if (mode === 'pan') return;

    if (mode === 'rightpan') {
      /* A right-drag that actually panned is not also an order. */
      if (!moved) handleRightClick(e);
      return;
    }

    updateDragEnd();
    var rect = { x0: dragRect.x0, y0: dragRect.y0, x1: dragRect.x1, y1: dragRect.y1 };
    endDragVisuals();

    /* The modifier is read at release: reaching for shift mid-drag is
       a change of mind, and an honest one. */
    var additive = drag.additive || pointer.shift;
    if (mode === 'select') finishSelectDrag(rect, moved, additive);
    else if (mode === 'tool') applyTool(rect, drag.erase || pointer.shift);
  }

  function onWheel(e) {
    var R = root.Render;
    if (!R || !R.zoomBy) return;
    e.preventDefault();
    setPointer(e);
    /* deltaY is negative scrolling up, which is zoom in. */
    R.zoomBy(-e.deltaY, pointer.sx, pointer.sy);
    syncTile();
    if (drag.active) updateDragEnd();
  }

  function onBlur() {
    /* A window that loses focus mid-drag would otherwise come back
       still holding the mouse and half the keyboard down. */
    if (drag.active) { drag.active = false; drag.mode = 'none'; endDragVisuals(); }
    held = Object.create(null);
    panHeld = 0;
  }

  /* ---------- selection ---------- */

  function isColonist(p) {
    return !!(p && p.isHuman && p.faction === 'player' && !p.dead && !p.prisoner);
  }

  function selectedColonists() {
    var G = root.Game, out = [];
    var sel = (G && G.selection) || [];
    for (var i = 0; i < sel.length; i++) {
      var s = sel[i];
      if (isColonist(s) && !s.downed) out.push(s);
    }
    return out;
  }

  function zoneAt(m, x, y) {
    var Z = root.Zones;
    if (!Z || !Z.zoneAt) return null;
    return Z.zoneAt(m, x, y);
  }

  /* Everything standing on one cell, in the order a click walks down:
     pawns (colonists first), buildings, plans, plants, items, the zone. */
  function candidatesAt(m, x, y) {
    var out = [], i;
    var pawns = m.pawnsAt ? m.pawnsAt(x, y) : null;
    if (pawns) {
      for (i = 0; i < pawns.length; i++) if (isColonist(pawns[i])) out.push(pawns[i]);
      for (i = 0; i < pawns.length; i++) {
        if (!pawns[i].dead && !isColonist(pawns[i])) out.push(pawns[i]);
      }
    }
    var b = m.buildingAt(x, y);
    if (b) out.push(b);
    var ghost = m.ghostAt ? m.ghostAt(x, y) : null;
    if (ghost && ghost !== b) out.push(ghost);
    var plant = m.plantAt(x, y);
    if (plant) out.push(plant);
    var items = m.items(x, y);
    for (i = 0; i < items.length; i++) out.push(items[i]);
    var z = zoneAt(m, x, y);
    if (z) out.push(z);
    return out;
  }

  function selectOne(thing, additive) {
    var G = root.Game;
    if (!G || !G.select) return;
    G.select(thing, additive);
    refreshInspect();
  }

  function selectMany(list, additive) {
    var G = root.Game;
    if (!G) return;
    if (!additive && G.deselectAll) G.deselectAll();
    for (var i = 0; i < list.length; i++) G.select(list[i], true);
    refreshInspect();
  }

  function clickSelect(x, y, additive) {
    var m = theMap();
    if (!m || !m.inBounds(x, y)) return;
    var list = candidatesAt(m, x, y);
    if (!list.length) {
      if (!additive) {
        var G = root.Game;
        if (G && G.deselectAll) { G.deselectAll(); refreshInspect(); }
      }
      return;
    }

    var t = now();
    var same = lastClick.x === x && lastClick.y === y && (t - lastClick.t) < CYCLE_MS;
    var index = same ? (lastClick.index + 1) % list.length : 0;
    lastClick.x = x; lastClick.y = y; lastClick.t = t; lastClick.index = index;
    selectOne(list[index], additive);
  }

  /* Double click selects the whole visible family: every colonist, or
     every muffalo, that the camera can currently see. */
  function selectAllOfKind(sample) {
    var m = theMap(), R = root.Render;
    if (!m || !sample || !R || !R.visibleBounds) return false;
    if (sample.kindId === undefined) return false;
    var b = R.visibleBounds();
    var out = [];
    for (var i = 0; i < m.pawns.length; i++) {
      var p = m.pawns[i];
      if (p.dead || p.kindId !== sample.kindId || p.faction !== sample.faction) continue;
      if (p.x < b.x0 || p.x > b.x1 || p.y < b.y0 || p.y > b.y1) continue;
      out.push(p);
    }
    if (!out.length) return false;
    selectMany(out, false);
    return true;
  }

  function finishSelectDrag(rect, moved, additive) {
    var m = theMap();
    if (!m) return;

    if (!moved) {
      var t = now();
      var dbl = (t - lastClick.t) < DOUBLE_MS &&
        Math.abs(lastClick.x - rect.x0) <= 1 && Math.abs(lastClick.y - rect.y0) <= 1;
      if (dbl) {
        var here = candidatesAt(m, rect.x0, rect.y0);
        if (here.length && here[0].kindId !== undefined && selectAllOfKind(here[0])) {
          lastClick.t = t;
          return;
        }
      }
      clickSelect(rect.x0, rect.y0, additive);
      return;
    }

    boxSelect(rect, additive);
  }

  /* A box takes pawns and nothing else, the way RimWorld does: dragging
     over a stockpile is how you pick the hauler standing in it, not the
     forty steel bars underneath. */
  function boxSelect(rect, additive) {
    var m = theMap();
    if (!m) return;
    var mine = [], others = [];
    for (var i = 0; i < m.pawns.length; i++) {
      var p = m.pawns[i];
      if (p.dead) continue;
      if (p.x < rect.x0 || p.x > rect.x1 || p.y < rect.y0 || p.y > rect.y1) continue;
      if (isColonist(p)) mine.push(p);
      else others.push(p);
    }
    var pick = mine.length ? mine : others;
    if (!pick.length) {
      var G = root.Game;
      if (!additive && G && G.deselectAll) { G.deselectAll(); refreshInspect(); }
      return;
    }
    selectMany(pick, additive);
  }

  /* ---------- tools ---------- */

  function buildDefOf(defId) {
    if (!defId || !root.Defs) return null;
    return root.Defs.maybe('thing', defId) || root.Defs.maybe('terrain', defId);
  }

  /* Mirrors render.js: these are the defs whose ghost follows a drag
     rather than sitting under the cursor one at a time. */
  function draggableDef(def) {
    var s = def.size;
    if (s && (s.w !== 1 || s.h !== 1)) return false;
    if (def.defCategory === 'terrain') return true;
    if (def.buildCategory === 'structure') return true;
    var b = def.building;
    return !!(b && (b.isConduit || b.isSandbag || b.isTrap));
  }

  function rectCells(rect, hollow, out) {
    var x, y;
    out.length = 0;
    if (hollow && rect.x1 > rect.x0 && rect.y1 > rect.y0) {
      for (x = rect.x0; x <= rect.x1; x++) { out.push(x, rect.y0); out.push(x, rect.y1); }
      for (y = rect.y0 + 1; y < rect.y1; y++) { out.push(rect.x0, y); out.push(rect.x1, y); }
      return out;
    }
    for (y = rect.y0; y <= rect.y1; y++) {
      for (x = rect.x0; x <= rect.x1; x++) {
        out.push(x, y);
        if (out.length >= MAX_TOOL_CELLS * 2) return out;
      }
    }
    return out;
  }

  var cellScratch = [];

  function applyTool(rect, erase) {
    var m = theMap(), t = tool();
    if (!m || !t) return;
    switch (t.kind) {
      case 'build': applyBuild(m, t, rect); break;
      case 'designate': applyDesignate(m, t, rect); break;
      case 'zone': applyZone(m, t, rect, erase); break;
      case 'cancel': applyCancel(m, rect); break;
      case 'order': applyOrderTool(m, rect); break;
      default: break;
    }
  }

  function applyBuild(m, t, rect) {
    var C = root.Construct;
    var def = buildDefOf(t.defId);
    if (!C || !C.placeBlueprint || !def) return;

    var multi = rect.x1 > rect.x0 || rect.y1 > rect.y0;
    var cells;
    if (multi && draggableDef(def)) {
      /* Floors fill what you dragged over; walls, conduits and sandbags
         trace its edge, which is how you raise a room in one sweep. */
      cells = rectCells(rect, def.defCategory !== 'terrain', cellScratch);
    } else {
      cellScratch.length = 0;
      cellScratch.push(rect.x1, rect.y1);
      cells = cellScratch;
    }

    var rot = t.rot | 0, placed = 0;
    for (var i = 0; i < cells.length; i += 2) {
      if (C.placeBlueprint(m, def.id, cells[i], cells[i + 1], rot, t.stuffId || null)) placed++;
    }

    /* One cell, nothing placed: say why. On a drag it would be noise -
       half a wall line always crosses something. */
    if (!placed && cells.length === 2 && C.canPlace) {
      var x = cells[0], y = cells[1];
      /* Dragging a wall over your own wall means "take that down", and
         placeBlueprint answers that with a designation, not a plan. */
      if (!m.designationAt(x, y, 'deconstruct')) {
        var res = C.canPlace(m, def.id, x, y, rot);
        if (res && res.ok === false) notify(res.reason);
      }
    }
  }

  function plantBlock(thing) {
    return (thing && thing.def && thing.def.plant) ? thing.def.plant : null;
  }

  function canDesignateCell(m, type, x, y) {
    var C = root.Construct;
    var plant, p;
    switch (type) {
      case 'mine':
        return !!(C && C.canMine && C.canMine(m, x, y));
      case 'deconstruct':
        return !!(C && C.canDeconstruct && C.canDeconstruct(m, x, y));
      case 'chop':
        plant = m.plantAt(x, y); p = plantBlock(plant);
        return !!(p && p.isTree);
      case 'harvest':
        plant = m.plantAt(x, y); p = plantBlock(plant);
        return !!(p && p.harvestedThing);
      case 'cut':
        return !!m.plantAt(x, y);
      case 'haulUrgent':
        return m.items(x, y).length > 0;
      default:
        return false;
    }
  }

  /* Hunt, tame and slaughter are marks on a creature that walks away,
     so animals.js keeps them on the pawn and mirrors the cell. */
  var ANIMAL_DESIGNATIONS = { hunt: 1, tame: 1, slaughter: 1 };

  var NOTHING_TO = {
    mine: 'Nothing to mine there.',
    deconstruct: 'Nothing of yours to take apart there.',
    chop: 'No tree there.',
    harvest: 'Nothing to harvest there.',
    cut: 'No plant there.',
    haulUrgent: 'Nothing lying there to haul.'
  };

  /* What the mark points at, so map.js can drop it when that thing
     stops existing rather than leaving orders on bare ground. */
  function designationSubject(m, type, x, y) {
    var C = root.Construct;
    if (type === 'mine') return C && C.canMine ? C.canMine(m, x, y) : null;
    if (type === 'deconstruct') return m.buildingAt(x, y);
    if (type === 'chop' || type === 'harvest' || type === 'cut') return m.plantAt(x, y);
    return null;
  }

  function applyDesignate(m, t, rect) {
    var type = t.designation;
    if (!type) return;

    if (ANIMAL_DESIGNATIONS[type]) { designateAnimals(m, type, rect); return; }

    var cells = rectCells(rect, false, cellScratch), marked = 0;
    for (var i = 0; i < cells.length; i += 2) {
      var x = cells[i], y = cells[i + 1];
      if (!canDesignateCell(m, type, x, y)) continue;
      if (m.designationAt(x, y, type)) continue;
      var subject = designationSubject(m, type, x, y);
      m.designate(x, y, type, subject ? { defId: subject.defId } : null);
      marked++;
    }
    if (!marked && cells.length === 2) notify(NOTHING_TO[type] || 'Nothing to mark there.');
  }

  function designateAnimals(m, type, rect) {
    var A = root.Animals;
    if (!A || !A.designate) return;
    var marked = 0;
    for (var i = 0; i < m.pawns.length; i++) {
      var p = m.pawns[i];
      if (!p.isAnimal || p.dead) continue;
      if (p.x < rect.x0 || p.x > rect.x1 || p.y < rect.y0 || p.y > rect.y1) continue;
      if (type === 'tame' && A.canTame && !A.canTame(p)) continue;
      if (type === 'slaughter' && A.canSlaughter && !A.canSlaughter(p)) continue;
      if (type === 'hunt' && (p.faction === 'player' || p.tame)) continue;
      if (A.designate(p, type)) marked++;
    }
    if (!marked) notify('No animal there to ' + type + '.');
  }

  /* A stockpile cell has to be standable; a growing cell has to be
     something a plant will root in. Anything else is skipped rather
     than refused, so a drag over a wall still zones the floor. */
  function zoneCellOk(m, kind, x, y) {
    if (!m.inBounds(x, y)) return false;
    var terrain = m.terrainAt(x, y);
    if (!terrain || terrain.passable === false) return false;
    var b = m.buildingAt(x, y);
    if (kind === 'growing') {
      if (b) return false;
      return (terrain.fertility || 0) > 0;
    }
    if (b && b.def && b.def.passable === false) return false;
    return m.passable(x, y);
  }

  function applyZone(m, t, rect, erase) {
    var Z = root.Zones;
    if (!Z) return;
    var kind = t.zoneKind || (t.zone && t.zone.kind) || 'stockpile';
    var cells = rectCells(rect, false, cellScratch);
    var picked = [], i, x, y;

    for (i = 0; i < cells.length; i += 2) {
      x = cells[i]; y = cells[i + 1];
      if (!m.inBounds(x, y)) continue;
      var idx = m.idx(x, y);
      if (erase) {
        if (m.zoneId && m.zoneId[idx]) picked.push(idx);
      } else if (zoneCellOk(m, kind, x, y)) {
        picked.push(idx);
      }
    }
    if (!picked.length) return;

    if (erase) {
      if (Z.removeCells) Z.removeCells(m, picked);
      return;
    }

    var into = t.zone || null;
    if (into && Z.expand) {
      /* Extending an existing zone keeps its filter and priority, which
         is the whole reason the architect hands one over. */
      Z.expand(m, into, picked);
      return;
    }
    if (Z.add) Z.add(m, kind, picked, {});
  }

  function applyCancel(m, rect) {
    var C = root.Construct, A = root.Animals;
    var cells = rectCells(rect, false, cellScratch), i, x, y;

    for (i = 0; i < cells.length; i += 2) {
      x = cells[i]; y = cells[i + 1];
      if (!m.inBounds(x, y)) continue;
      if (C && C.cancelAt) C.cancelAt(m, x, y);
      var d = m.designationAt(x, y);
      if (d) m.undesignate(x, y, d.type);
    }

    /* An animal's mark lives on the animal; clearing the cell alone
       would let the next rare tick write it straight back. */
    if (A && A.undesignate) {
      for (i = 0; i < m.pawns.length; i++) {
        var p = m.pawns[i];
        if (!p.isAnimal || !p.designated) continue;
        if (p.x < rect.x0 || p.x > rect.x1 || p.y < rect.y0 || p.y > rect.y1) continue;
        A.undesignate(p);
      }
    }
  }

  function applyOrderTool(m, rect) {
    var pawns = selectedColonists();
    if (!pawns.length) { clearTool(); return; }
    issueDirectOrder(m, pawns, rect.x1, rect.y1);
    clearTool();
  }

  /* ---------- jobs ---------- */

  function targets() { return root.T || null; }

  function makeJob(id, a, b, opts) {
    var J = root.Jobs;
    if (!J || !J.make) return null;
    return J.make(id, a || null, b || null, opts || {});
  }

  /* Every order from the player jumps the queue: the current job ends,
     and the new one carries playerForced so the driver skips the checks
     that exist to stop a pawn choosing this work on its own. */
  function order(pawn, job) {
    var J = root.Jobs, T = targets();
    if (!pawn || !job || !J || !J.start) return false;
    job.playerForced = true;
    if (pawn.endJob) pawn.endJob('interrupted');
    /* Jobs.start refuses a job whose target has already gone, so the
       answer decides whether the player gets the confirming flash. */
    if (J.start(pawn, job) === false) return false;
    var R = root.Render;
    var pos = (R && R.flashCell && T && T.pos && job.targetA) ? T.pos(job.targetA, pawn.map) : null;
    if (pos) R.flashCell(pos.x, pos.y);
    return true;
  }

  function canReach(pawn, x, y) {
    if (pawn.canReach) return pawn.canReach(x, y);
    var P = root.Path;
    if (!P || !P.reachable || !pawn.map) return true;
    return P.reachable(pawn.map, pawn.x, pawn.y, x, y, { pawn: pawn });
  }

  function nearest(pawns, x, y, filter) {
    var best = null, bestD = Infinity;
    for (var i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      if (filter && !filter(p)) continue;
      var d = U.distSq(p.x, p.y, x, y);
      if (d < bestD) { bestD = d; best = p; }
    }
    return best;
  }

  function worker(pawns, workType, x, y) {
    return nearest(pawns, x, y, function (p) {
      if (workType && p.capable && !p.capable(workType)) return false;
      return canReach(p, x, y);
    });
  }

  /* A group told to go somewhere fans out around the cell instead of
     stacking in it, so eight colonists do not fight over one tile. */
  function spreadCells(m, pawns, x, y) {
    var ring = U.cellsInRadius(x, y, ORDER_SPREAD);
    var taken = Object.create(null), out = [], i, k;
    for (i = 0; i < pawns.length; i++) {
      var p = pawns[i], got = null, tries = 0;
      for (k = 0; k < ring.length && tries < 10; k++) {
        var cx = ring[k][0], cy = ring[k][1];
        if (!m.inBounds(cx, cy) || !m.passable(cx, cy)) continue;
        var idx = m.idx(cx, cy);
        if (taken[idx]) continue;
        /* Reachability is the expensive question, so it is asked only
           of cells that are otherwise free, and only a few times. */
        tries++;
        if (!canReach(p, cx, cy)) continue;
        taken[idx] = 1; got = { x: cx, y: cy };
        break;
      }
      out.push(got);
    }
    return out;
  }

  function orderGoto(m, pawns, x, y) {
    var T = targets();
    if (!T) return false;
    var cells = spreadCells(m, pawns, x, y), any = false;
    for (var i = 0; i < pawns.length; i++) {
      var c = cells[i];
      if (!c) continue;
      var job = makeJob('goto', T.cell(c.x, c.y));
      if (job && order(pawns[i], job)) {
        if (pawns[i].drafted) pawns[i].draftTarget = T.cell(c.x, c.y);
        any = true;
      }
    }
    if (any) {
      var R = root.Render;
      if (R && R.flashCell) R.flashCell(x, y);
    }
    return any;
  }

  function hostileAt(m, pawn, x, y) {
    var C = root.Combat;
    var pawns = m.pawnsAt ? m.pawnsAt(x, y) : null;
    var i;
    if (pawns) {
      for (i = 0; i < pawns.length; i++) {
        var q = pawns[i];
        if (q === pawn || q.dead) continue;
        if (pawn.hostileTo ? pawn.hostileTo(q) : (C && C.hostile && C.hostile(pawn, q))) return q;
      }
    }
    var b = m.buildingAt(x, y);
    if (b && b.faction && b.faction !== 'player' && b.faction !== 'wild') return b;
    return null;
  }

  function weaponRange(pawn) {
    var C = root.Combat;
    var w = C && C.weaponOf ? C.weaponOf(pawn) : null;
    return (w && w.ranged) ? (w.range || 0) : 0;
  }

  /* A shooter told to attack something out of range walks into range
     rather than charging it with a rifle butt; the draft target keeps
     the intent alive once they arrive. */
  function orderAttack(pawn, target) {
    var T = targets(), C = root.Combat, m = pawn.map;
    if (!T || !C || !m) return false;
    if (C.canAttack && !C.canAttack(pawn, target)) return false;

    var tgt = target.isHuman !== undefined || target.isAnimal !== undefined
      ? T.pawn(target) : T.thing(target);
    pawn.draftTarget = tgt;

    var range = weaponRange(pawn);
    var d = U.dist(pawn.x, pawn.y, target.x, target.y);
    var los = !C.lineOfSight || C.lineOfSight(m, pawn.x, pawn.y, target.x, target.y);

    if (range > 0) {
      if (d <= range && los) return order(pawn, makeJob('attackStatic', tgt));
      var spot = firingSpot(m, pawn, target, range);
      if (spot) {
        var walk = makeJob('goto', T.cell(spot.x, spot.y));
        if (order(pawn, walk)) {
          /* The shot is queued behind the walk, so arriving in range is
             the same order continuing rather than a second click. */
          var shoot = makeJob('attackStatic', tgt);
          if (shoot && pawn.jobQueue) { shoot.playerForced = true; pawn.jobQueue.push(shoot); }
          return true;
        }
      }
    }
    return order(pawn, makeJob('attackMelee', tgt));
  }

  /* Somewhere to stand that can see the target and is inside the
     weapon's reach. Candidates are gathered around the target, then
     sorted by how far the shooter has to walk, so the first one that
     survives the line-of-sight and reachability checks is the best -
     and only a handful of those checks ever run. */
  function firingSpot(m, pawn, target, range) {
    var C = root.Combat;
    var want = Math.max(2, Math.min(range * 0.8, 10));
    var ring = U.cellsInRadius(target.x, target.y, Math.floor(want));
    var cands = [];
    for (var i = 0; i < ring.length && cands.length < 60; i++) {
      var cx = ring[i][0], cy = ring[i][1];
      if (!m.inBounds(cx, cy) || !m.passable(cx, cy)) continue;
      cands.push({ x: cx, y: cy, d: U.distSq(pawn.x, pawn.y, cx, cy) });
    }
    cands.sort(function (a, b) { return a.d - b.d; });
    for (var k = 0; k < cands.length && k < 14; k++) {
      var c = cands[k];
      if (C.lineOfSight && !C.lineOfSight(m, c.x, c.y, target.x, target.y)) continue;
      if (!canReach(pawn, c.x, c.y)) continue;
      return { x: c.x, y: c.y };
    }
    return null;
  }

  /* The drafted right-click, and the 'order' tool: attack what is
     hostile under the cursor, otherwise move there. */
  function issueDirectOrder(m, pawns, x, y) {
    if (!m.inBounds(x, y)) return;
    var movers = [];
    for (var i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      var foe = hostileAt(m, p, x, y);
      if (foe && orderAttack(p, foe)) continue;
      movers.push(p);
    }
    if (movers.length) orderGoto(m, movers, x, y);
  }

  /* ---------- right click ---------- */

  function handleRightClick(e) {
    var m = theMap();
    if (!m) return;

    /* Right click backs out of a tool before it means anything else. */
    if (toolKind() !== 'select') { clearTool(); return; }

    var x = pointer.x, y = pointer.y;
    if (!m.inBounds(x, y)) return;

    var pawns = selectedColonists();
    if (!pawns.length) return;

    var drafted = [], undrafted = [], i;
    for (i = 0; i < pawns.length; i++) (pawns[i].drafted ? drafted : undrafted).push(pawns[i]);

    if (drafted.length) { issueDirectOrder(m, drafted, x, y); return; }

    var options = floatOptions(m, undrafted, x, y);
    var UIx = ui();
    if (options.length && UIx && UIx.floatMenu) UIx.floatMenu(e.clientX, e.clientY, options);
  }

  /* ui.js owns the menu's markup; this is the shape it is handed.
     `action` is the callback, `onClick` the same function under the
     other name a menu is likely to look for. */
  function opt(list, label, fn, reason) {
    if (list.length >= FLOAT_MAX) return;
    list.push({
      label: label,
      action: fn,
      onClick: fn,
      disabled: !fn,
      reason: reason || null
    });
  }

  function floatOptions(m, pawns, x, y) {
    var out = [];
    var T = targets();
    if (!T) return out;
    var multi = pawns.length > 1;

    /* Whose name goes on an order only one pawn can carry out. */
    function withName(text, pawn) {
      return multi && pawn ? (text + ' (' + nameOf(pawn) + ')') : text;
    }

    var goers = [];
    for (var i = 0; i < pawns.length; i++) if (canReach(pawns[i], x, y)) goers.push(pawns[i]);
    if (goers.length) {
      opt(out, 'Go here', function () { orderGoto(m, goers, x, y); });
    } else {
      opt(out, 'Go here', null, 'No path there.');
    }

    itemOptions(out, m, pawns, x, y, withName);
    buildingOptions(out, m, pawns, x, y, withName);
    plantOptions(out, m, pawns, x, y, withName);
    pawnOptions(out, m, pawns, x, y, withName);
    return out;
  }

  function storageFor(m, pawn, thing) {
    var Z = root.Zones;
    if (!Z || !Z.bestStorageFor) return null;
    return Z.bestStorageFor(m, thing, pawn);
  }

  function itemOptions(out, m, pawns, x, y, withName) {
    var T = targets();
    var items = m.items(x, y);
    for (var i = 0; i < items.length && i < 3; i++) {
      addItemOptions(out, m, pawns, items[i], x, y, withName, T);
    }
  }

  function addItemOptions(out, m, pawns, item, x, y, withName, T) {
    var def = item.def || {};
    var label = labelOfThing(item);

    if (def.weapon) {
      var eq = worker(pawns, null, x, y);
      if (eq) {
        opt(out, withName('Equip ' + label, eq), function () {
          order(eq, makeJob('equipWeapon', T.thing(item)));
        });
      }
    } else if (def.apparel) {
      var wearer = worker(pawns, null, x, y);
      if (wearer) {
        opt(out, withName('Wear ' + label, wearer), function () {
          order(wearer, makeJob('wearApparel', T.thing(item)));
        });
      }
    }

    if (def.nutrition > 0 && (def.foodType === 'meal' || def.foodType === 'raw')) {
      var eater = worker(pawns, null, x, y);
      if (eater) {
        opt(out, withName('Eat ' + label, eater), function () {
          order(eater, makeJob('eat', T.thing(item)));
        });
      }
    }

    var hauler = worker(pawns, 'haul', x, y);
    if (!hauler) return;
    var spot = storageFor(m, hauler, item);
    if (!spot) {
      opt(out, 'Haul ' + label, null, 'No stockpile will take it.');
      return;
    }
    opt(out, withName('Haul ' + label, hauler), function () {
      order(hauler, makeJob('haul', T.thing(item), T.cell(spot.x, spot.y),
        { count: item.stack || 1 }));
    });
  }

  function buildingOptions(out, m, pawns, x, y, withName) {
    var T = targets(), C = root.Construct;
    if (!C) return;

    var ghost = m.ghostAt ? m.ghostAt(x, y) : null;
    if (ghost) {
      var builder = worker(pawns, 'construct', x, y);
      if (builder) {
        var what = labelOfThing(ghost);
        opt(out, withName('Prioritise constructing ' + what, builder), function () {
          var job = ghost.isFrame ? makeJob('construct', T.thing(ghost)) : deliveryJob(m, builder, ghost, T);
          if (job) order(builder, job);
          else notify('No materials available for that.');
        });
      }
    }

    var rock = C.canMine ? C.canMine(m, x, y) : null;
    if (rock) {
      var miner = worker(pawns, 'mine', x, y);
      if (miner) {
        opt(out, withName('Prioritise mining', miner), function () {
          if (C.designateMine) C.designateMine(m, x, y);
          order(miner, makeJob('mine', T.cell(x, y)));
        });
      } else {
        opt(out, 'Prioritise mining', null, 'Nobody selected can mine.');
      }
    }

    var b = m.buildingAt(x, y);
    if (b && C.needsRepair && C.needsRepair(b)) {
      var fixer = worker(pawns, 'construct', x, y);
      if (fixer) {
        opt(out, withName('Prioritise repairing ' + labelOfThing(b), fixer), function () {
          order(fixer, makeJob('repair', T.thing(b)));
        });
      }
    }
  }

  /* A blueprint still waiting on steel needs the steel fetched, which is
     the two-target shape of the construct job. */
  function deliveryJob(m, pawn, ghost, T) {
    var C = root.Construct;
    if (!C || !C.materialsNeeded) return null;
    var need = C.materialsNeeded(ghost);
    for (var defId in need) {
      if (!(need[defId] > 0)) continue;
      var stack = nearestStack(m, pawn, defId);
      if (!stack) continue;
      return makeJob('construct', T.thing(ghost), T.thing(stack),
        { count: Math.min(need[defId], stack.stack || 1) });
    }
    return null;
  }

  function nearestStack(m, pawn, defId) {
    var list = m.byDef ? m.byDef(defId) : null;
    if (!list || !list.length) return null;
    var best = null, bestD = Infinity, checked = 0;
    for (var i = 0; i < list.length && checked < 120; i++) {
      var t = list[i];
      if (!t.spawned) continue;
      var d = U.distSq(pawn.x, pawn.y, t.x, t.y);
      if (d >= bestD) continue;
      checked++;
      if (!canReach(pawn, t.x, t.y)) continue;
      bestD = d; best = t;
    }
    return best;
  }

  function plantOptions(out, m, pawns, x, y, withName) {
    var T = targets();
    var plant = m.plantAt(x, y);
    var p = plantBlock(plant);
    if (!plant || !p) return;
    var label = labelOfThing(plant);

    if (p.isTree) {
      var chopper = worker(pawns, 'plantCut', x, y);
      if (chopper) {
        opt(out, withName('Prioritise chopping ' + label, chopper), function () {
          m.designate(x, y, 'chop', { defId: plant.defId });
          order(chopper, makeJob('chopWood', T.thing(plant)));
        });
      }
      return;
    }

    var ripe = p.harvestedThing &&
      (plant.growth || 0) >= (p.harvestMinGrowth === undefined ? 1 : p.harvestMinGrowth);
    if (ripe) {
      var grower = worker(pawns, 'grow', x, y);
      if (grower) {
        opt(out, withName('Prioritise harvesting ' + label, grower), function () {
          m.designate(x, y, 'harvest', { defId: plant.defId });
          order(grower, makeJob('harvest', T.thing(plant)));
        });
      }
    }

    var cutter = worker(pawns, 'plantCut', x, y);
    if (cutter) {
      opt(out, withName('Cut ' + label, cutter), function () {
        m.designate(x, y, 'cut', { defId: plant.defId });
        order(cutter, makeJob('cutPlant', T.thing(plant)));
      });
    }
  }

  function pawnOptions(out, m, pawns, x, y, withName) {
    var T = targets(), H = root.Health, A = root.Animals;
    var here = m.pawnsAt ? m.pawnsAt(x, y) : [];
    for (var i = 0; i < here.length; i++) {
      var q = here[i];
      if (q.dead) continue;
      if (pawns.indexOf(q) >= 0) continue;

      if (H && H.needsTending && H.needsTending(q)) {
        var doctor = worker(pawns, 'doctor', x, y);
        if (doctor && doctor !== q) {
          (function (doc2, patient) {
            opt(out, withName('Tend ' + nameOf(patient), doc2), function () {
              order(doc2, makeJob('tendPatient', T.pawn(patient)));
            });
          })(doctor, q);
        }
      }

      if (q.downed && (q.faction === 'player' || q.prisoner)) {
        var rescuer = worker(pawns, 'doctor', x, y);
        if (rescuer && rescuer !== q) {
          (function (r, patient) {
            opt(out, withName('Rescue ' + nameOf(patient), r), function () {
              order(r, makeJob('rescue', T.pawn(patient)));
            });
          })(rescuer, q);
        }
      }

      if (q.isAnimal && A) {
        var handler = worker(pawns, 'handle', x, y);
        if (handler && A.canTame && A.canTame(q)) {
          (function (h, animal) {
            opt(out, withName('Prioritise taming ' + nameOf(animal), h), function () {
              A.designate(animal, 'tame');
              order(h, makeJob('tame', T.pawn(animal)));
            });
          })(handler, q);
        }
        if (handler && A.canSlaughter && A.canSlaughter(q)) {
          (function (h, animal) {
            opt(out, withName('Slaughter ' + nameOf(animal), h), function () {
              A.designate(animal, 'slaughter');
              order(h, makeJob('slaughter', T.pawn(animal)));
            });
          })(handler, q);
        }
      }
    }
  }

  /* ---------- camera ---------- */

  function zoom(dir) {
    var R = root.Render;
    if (!R || !R.zoomBy) return;
    if (pointer.inside) R.zoomBy(dir, pointer.sx, pointer.sy);
    else R.zoomBy(dir);
    syncTile();
  }

  function goHome() {
    var m = theMap(), R = root.Render;
    if (!m || !R || !R.centerOn) return;
    var list = m.colonists ? m.colonists() : [];
    if (!list.length) { R.centerOn(m.w >> 1, m.h >> 1); return; }
    var sx = 0, sy = 0;
    for (var i = 0; i < list.length; i++) { sx += list[i].x; sy += list[i].y; }
    R.centerOn(Math.round(sx / list.length), Math.round(sy / list.length));
  }

  function cycleColonists() {
    var m = theMap(), R = root.Render;
    if (!m || !m.colonists) return;
    var list = m.colonists();
    if (!list.length) return;
    var G = root.Game;
    var sel = (G && G.selection && G.selection.length) ? G.selection[0] : null;
    var at = list.indexOf(sel);
    /* Follow on from whoever is selected; with nothing selected, carry
       on from wherever the last tab left off. */
    var next = at >= 0 ? (at + 1) % list.length : (tabCycle % list.length);
    tabCycle = (next + 1) % list.length;
    var pawn = list[next];
    selectOne(pawn, false);
    if (R && R.visibleBounds && R.centerOn) {
      var b = R.visibleBounds();
      /* Only chase the camera when the colonist is not already on
         screen, so tabbing through a crowded base does not lurch. */
      if (pawn.x < b.x0 + 2 || pawn.x > b.x1 - 2 || pawn.y < b.y0 + 2 || pawn.y > b.y1 - 2) {
        R.centerOn(pawn.x, pawn.y);
      }
    }
  }

  /* ---------- keyboard ---------- */

  var PAN_KEYS = {
    KeyW: [0, -1], KeyA: [-1, 0], KeyS: [0, 1], KeyD: [1, 0],
    ArrowUp: [0, -1], ArrowLeft: [-1, 0], ArrowDown: [0, 1], ArrowRight: [1, 0]
  };

  function typingInField(el2) {
    if (!el2 || !el2.tagName) return false;
    var tag = el2.tagName.toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return el2.isContentEditable === true;
  }

  function onKeyUp(e) {
    var code = e.code || e.key;
    if (held[code]) delete held[code];
  }

  function onKeyDown(e) {
    /* Never touch a browser key: reload, devtools, tab switching, and
       anything the user pressed with a modifier held. */
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (typingInField(e.target)) return;
    var key = e.key;
    if (!key) return;
    /* F5, F12 and the rest belong to the browser. */
    if (key.length > 1 && /^F\d+$/.test(key)) return;

    var code = e.code || key;
    if (PAN_KEYS[code]) {
      if (held[code]) { e.preventDefault(); return; }
      if (blockedByScreen()) return;
      held[code] = true;
      e.preventDefault();
      return;
    }

    if (e.repeat) return;

    if (key === 'Escape') { e.preventDefault(); handleEscape(); return; }

    /* Everything below steers a running colony. */
    if (blockedByScreen()) return;

    var lower = key.length === 1 ? key.toLowerCase() : key;
    var G = root.Game;

    switch (lower) {
      case ' ':
      case 'Spacebar':
        e.preventDefault();
        if (G && G.togglePause) G.togglePause();
        return;
      case '1': case '2': case '3': case '4':
        if (G && G.setSpeed) G.setSpeed(parseInt(lower, 10));
        return;
      case 'f': toggleDraft(); return;
      case 'r': rotateGhost(); return;
      case 'h': goHome(); return;
      case 'z': zoom(1); return;
      case 'x': zoom(-1); return;
      case 'Tab': e.preventDefault(); cycleColonists(); return;
      case 'Delete':
      case 'Backspace': e.preventDefault(); cancelKey(); return;
      case 'm': setTool({ kind: 'designate', designation: 'mine' }); return;
      case 'c': setTool({ kind: 'cancel' }); return;
      case 'g': setTool({ kind: 'zone', zoneKind: 'growing' }); return;
      case 'k': setTool({ kind: 'zone', zoneKind: 'stockpile' }); return;
      case 'b': architect('structure'); return;
      case 'e': architect('power'); return;
      case 'p': architect('production'); return;
      case 'u': architect('furniture'); return;
      case 'y': architect('security'); return;
      case 'l': architect('floor'); return;
      default: return;
    }
  }

  /* The main menu and a modal own the keyboard while they are up. */
  function blockedByScreen() {
    if (!theMap()) return true;
    return panelOpen('menu') || panelOpen('modal');
  }

  /* ui.js owns the architect panel, so a category key asks it to open
     that category and does nothing at all if it has no such door. */
  function architect(category) {
    var UIx = ui();
    if (UIx && UIx.openArchitect) UIx.openArchitect(category);
  }

  function toggleDraft() {
    var pawns = selectedColonists();
    if (!pawns.length) return;
    var want = !pawns[0].drafted;
    for (var i = 0; i < pawns.length; i++) {
      var p = pawns[i];
      if (want && p.draft) p.draft();
      else if (!want && p.undraft) p.undraft();
    }
    refreshInspect();
  }

  function rotateGhost() {
    var t = tool();
    if (!t || t.kind !== 'build') return;
    t.rot = ((t.rot | 0) + 1) & 3;
    var UIx = ui();
    if (UIx && UIx.onToolChanged) UIx.onToolChanged(t);
  }

  /* Delete cancels: the selected plans first, since that is what the
     player is looking at, and the cancel tool otherwise. */
  function cancelKey() {
    var G = root.Game, C = root.Construct, m = theMap();
    var sel = (G && G.selection) || [];
    var cancelled = 0;
    for (var i = sel.length - 1; i >= 0; i--) {
      var s = sel[i];
      if (!s || !s.isGhost || !s.isGhost()) continue;
      if (C && C.cancelGhost) { C.cancelGhost(m, s); cancelled++; }
    }
    if (cancelled) {
      if (G.deselectAll) G.deselectAll();
      refreshInspect();
      return;
    }
    setTool({ kind: 'cancel' });
  }

  function handleEscape() {
    var UIx = ui(), G = root.Game;
    if (panelOpen('float-menu')) { closeFloatMenu(); return; }
    if (panelOpen('tab-panel')) { if (UIx && UIx.closeTab) UIx.closeTab(); return; }
    if (toolKind() !== 'select') { clearTool(); return; }
    if (G && G.selection && G.selection.length) {
      if (G.deselectAll) G.deselectAll();
      refreshInspect();
      return;
    }
    if (!panelOpen('menu') && UIx && UIx.showMenu) UIx.showMenu();
  }

  /* ---------- per-frame ---------- */

  Input.update = function () {
    var t = now();
    var dt = (t - lastFrame) / 1000;
    lastFrame = t;
    if (!(dt > 0)) return;
    if (dt > 0.25) dt = 0.25;

    var R = root.Render;
    if (!R || !R.panBy || !theMap()) { panHeld = 0; return; }

    var dx = 0, dy = 0;
    for (var code in held) {
      var v = PAN_KEYS[code];
      if (v) { dx += v[0]; dy += v[1]; }
    }
    if (!dx && !dy) { panHeld = 0; return; }
    if (dx) dx = dx > 0 ? 1 : -1;
    if (dy) dy = dy > 0 ? 1 : -1;
    if (dx && dy) { dx *= 0.7071; dy *= 0.7071; }

    panHeld += dt;
    var speed = U.lerp(PAN_SLOW, PAN_FAST, U.clamp01(panHeld / PAN_RAMP));
    R.panBy(dx * speed * dt, dy * speed * dt);

    /* The cursor stands still while the map slides under it, so the
       tile it points at - and any live drag rectangle - has moved. */
    if (pointer.inside) {
      syncTile();
      if (drag.active) updateDragEnd();
    }
  };

  /* ---------- what ui.js prints in the how-to-play panel ---------- */

  Input.hotkeyHelp = function () {
    return [
      { keys: 'Left click', what: 'select a colonist, building, plant or item' },
      { keys: 'Left drag', what: 'select every colonist in the box, or paint the current tool' },
      { keys: 'Double click', what: 'select every colonist of that kind on screen' },
      { keys: 'Shift + click', what: 'add to the selection' },
      { keys: 'Right click', what: 'orders for the selected colonists; drafted, it moves or attacks' },
      { keys: 'Right / middle drag', what: 'pan the camera' },
      { keys: 'Wheel, Z / X', what: 'zoom' },
      { keys: 'WASD, arrows', what: 'pan the camera' },
      { keys: 'H', what: 'jump home to the colony' },
      { keys: 'Space', what: 'pause and resume' },
      { keys: '1 - 4', what: 'game speed' },
      { keys: 'F', what: 'draft or undraft the selection' },
      { keys: 'R', what: 'rotate the building you are placing' },
      { keys: 'Tab', what: 'cycle through the colonists' },
      { keys: 'Delete', what: 'cancel the selected plan, or pick the cancel tool' },
      { keys: 'Escape', what: 'drop the tool, then the selection, then open the menu' },
      { keys: 'M / C', what: 'mine and cancel tools' },
      { keys: 'G / K', what: 'growing zone and stockpile tools' },
      { keys: 'B E P U Y L', what: 'architect: structure, power, production, furniture, security, floors' }
    ];
  };

  root.Input = Input;
})(this);
