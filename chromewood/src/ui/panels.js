/* ============================================================
   panels.js - the screens you open mid-run

   Drawn on the same canvas and in the same pixel grid as the HUD,
   because a DOM dialog over a pixel-art game always reads as a
   different program. Every panel registers its own hit boxes each
   frame; the game forwards clicks back by name.
   ============================================================ */

import {
  PAL, frame, bar, slot, button, rivets, divider, px, drawText, textWidth, clipText, drawIcon,
} from './draw.js';
import { lineHeight, drawWrapped, wrapLines } from './font.js';
import { ITEMS, BUILDINGS, STATION_NAME, BEACON_REPAIR } from '../game/items.js';
import { SKILLS, SKILL_BRANCHES, BEACON_UPGRADES } from '../game/defs.js';
import { NIGHTS } from '../game/nights.js';
import { allRecipes, invHasAll } from '../game/survival.js';
import { BEACON_COSTS } from '../game/sim.js';

export const PANELS = ['inventory', 'build', 'skills', 'journal', 'beacon'];

/* Depth-first over the prerequisite links: the root first, then each
   path it opens, so a column reads top to bottom as a real sequence.
   Memoised because the layout is the same every frame. */
const _chains = new Map();
function chainOrder(branchId) {
  if (_chains.has(branchId)) return _chains.get(branchId);
  const nodes = Object.entries(SKILLS).filter(([, v]) => v.branch === branchId);
  const out = [];
  const walk = (req, depth) => {
    const kids = nodes.filter(([, v]) => (v.req || null) === req)
      .sort((a, b) => a[1].tier - b[1].tier || a[0].localeCompare(b[0]));
    kids.forEach(([key, def], i) => {
      out.push({ key, def, depth, last: i === kids.length - 1 });
      walk(key, Math.min(depth + 1, 3));
    });
  };
  walk(null, 0);
  _chains.set(branchId, out);
  return out;
}


export class Panels {
  constructor(hud, hooks) {
    this.hud = hud;
    this.hooks = hooks;
    this.current = null;
    this.tooltip = null;
    this.scroll = 0;
    this.selected = null;
  }

  open(name) { this.current = name; this.scroll = 0; }
  close() { this.current = null; this.tooltip = null; }
  toggle(name) { if (this.current === name) this.close(); else this.open(name); }
  get isOpen() { return this.current !== null; }

  draw(state) {
    if (!this.current) return;
    const c = this.hud.ctx, S = this.hud.scale;
    const W = this.hud.w, H = this.hud.h;
    this.tooltip = null;

    /* Dim the world, but not so much you cannot see the fight you
       are about to walk back into. */
    c.fillStyle = 'rgba(6, 5, 12, 0.72)';
    c.fillRect(0, 0, W, H);

    const pw = Math.min(W - 16 * S, 342 * S);
    const ph = Math.min(H - 16 * S, 218 * S);
    const x = Math.round((W - pw) / 2), y = Math.round((H - ph) / 2);
    frame(c, x, y, pw, ph, { lit: true, notch: 8 * S });
    rivets(c, x, y, pw, ph, 5 * S);

    /* Tabs across the top, so every panel is one click from here. */
    const tabs = [['inventory', 'PACK', 'TAB'], ['build', 'BUILD', 'B'],
      ['skills', 'CORE', 'K'], ['journal', 'LOG', 'J']];
    let tx = x + 6 * S;
    for (const [id, label, key] of tabs) {
      const tw = (textWidth(label, S) + 12 * S);
      const hov = this.hud.isHover(tx, y + 5 * S, tw, 12 * S);
      button(c, tx, y + 5 * S, tw, 12 * S, label, { hover: hov, active: this.current === id, scale: S });
      this.hud.hit('panel:tab', tx, y + 5 * S, tw, 12 * S, id);
      drawText(c, key, tx + tw / 2, y + 18 * S, { scale: S, align: 'center', color: PAL.faint });
      tx += tw + 3 * S;
    }
    drawText(c, 'ESC', x + pw - 6 * S, y + 8 * S, { scale: S, align: 'right', color: PAL.faint });
    divider(c, x + 5 * S, y + 25 * S, pw - 10 * S);

    const inner = { x: x + 6 * S, y: y + 29 * S, w: pw - 12 * S, h: ph - 35 * S };
    if (this.current === 'inventory') this._inventory(state, inner);
    else if (this.current === 'build') this._build(state, inner);
    else if (this.current === 'skills') this._skills(state, inner);
    else if (this.current === 'journal') this._journal(state, inner);
    else if (this.current === 'beacon') this._beacon(state, inner);

    if (this.tooltip) this._drawTooltip(state);
  }

  /* Sized from its own text. A fixed-width box either clipped the
     long lines or left a lake of empty plate under the short ones. */
  _drawTooltip(state) {
    const c = this.hud.ctx, S = this.hud.scale;
    const t = this.tooltip;
    const pad = 4 * S;
    const w = Math.min(168 * S, Math.max(104 * S,
      textWidth(t.title, S), t.foot ? textWidth(t.foot, S) : 0) + pad * 2);
    const bodyLines = t.body ? wrapLines(t.body, w - pad * 2, S).length : 0;
    const h = pad * 2 + 7 * S
      + (bodyLines ? 2 * S + bodyLines * lineHeight(S) : 0)
      + (t.foot ? 4 * S + 7 * S : 0);
    let x = this.hud.pointer.x + 12 * S, y = this.hud.pointer.y + 12 * S;
    if (x + w > this.hud.w) x = Math.max(2 * S, this.hud.pointer.x - w - 8 * S);
    if (y + h > this.hud.h) y = Math.max(2 * S, this.hud.h - h - 4 * S);
    frame(c, x, y, w, h, { lit: true, notch: 3 * S });
    let ty = y + pad;
    drawText(c, t.title, x + pad, ty, { scale: S, color: t.color || PAL.text });
    ty += 7 * S + 2 * S;
    if (t.body) {
      drawWrapped(c, t.body, x + pad, ty, w - pad * 2, { scale: S, color: PAL.dim });
      ty += bodyLines * lineHeight(S);
    }
    if (t.foot) drawText(c, t.foot, x + pad, ty + 2 * S, { scale: S, color: PAL.xp });
  }

  /* ------------------------------------------------- the pack */
  _inventory(state, r) {
    const c = this.hud.ctx, S = this.hud.scale;
    const me = state.me;
    const colW = Math.floor(r.w * 0.44);

    drawText(c, 'CARRIED', r.x, r.y, { scale: S, color: PAL.dim });
    const tally = Object.entries(me.inv).filter(([, n]) => n > 0);
    if (tally.length) {
      drawText(c, `${tally.length} KINDS - ${tally.reduce((a, [, n]) => a + n, 0)}`,
        r.x + colW - 8 * S, r.y, { scale: S, align: 'right', color: PAL.faint });
    }
    const size = 20 * S, gap = 3 * S;
    const perRow = Math.max(1, Math.floor((colW + gap) / (size + gap)));
    const entries = Object.entries(me.inv).filter(([, n]) => n > 0)
      .sort((a, b) => {
        const ca = ITEMS[a[0]], cb = ITEMS[b[0]];
        const order = { tool: 0, weapon: 1, build: 2, food: 3, resource: 4, special: 5 };
        return (order[ca.cat] ?? 9) - (order[cb.cat] ?? 9) || a[0].localeCompare(b[0]);
      });

    entries.forEach(([id, n], i) => {
      const def = ITEMS[id];
      const sx = r.x + (i % perRow) * (size + gap);
      const sy = r.y + 10 * S + Math.floor(i / perRow) * (size + gap);
      const hov = this.hud.isHover(sx, sy, size, size);
      slot(c, sx, sy, size, {
        item: def.icon, count: n, tint: def.tint, scale: S, selected: hov,
        accent: def.glow ? '#ffffff' : undefined,
      });
      this.hud.hit('panel:item', sx, sy, size, size, id);
      if (hov) {
        this.tooltip = {
          title: def.name, color: '#' + def.tint.toString(16).padStart(6, '0'),
          body: def.desc || (def.tool ? `${def.tool.kind} tier ${def.tool.tier} · ${def.tool.damage} damage`
            : def.food ? `restores ${def.food || 0} food` : ''),
          foot: def.build ? 'CLICK TO BUILD' : def.food ? 'CLICK TO EAT' : 'CLICK TO HOLD',
        };
      }
    });
    if (!entries.length) {
      drawText(c, 'NOTHING YET. PUNCH A TREE.', r.x, r.y + 14 * S, { scale: S, color: PAL.faint });
    }

    /* The column is taller than the grid ever needs, so the bottom of
       it carries what you are actually holding and what shape you are
       in - the two things you open the pack to check. */
    const held = me.hotbar[me.hotbarIndex];
    let sy2 = r.y + r.h - 44 * S;
    divider(c, r.x, sy2 - 6 * S, colW);
    drawText(c, 'IN HAND', r.x, sy2, { scale: S, color: PAL.dim });
    if (held && ITEMS[held]) {
      const h = ITEMS[held];
      drawIcon(c, h.icon, r.x, sy2 + 10 * S, 9 * S, h.tint, h.glow ? '#fff' : undefined);
      drawText(c, h.name, r.x + 12 * S, sy2 + 11 * S, { scale: S, color: PAL.text });
      drawText(c, h.tool ? `${h.tool.kind.toUpperCase()} T${h.tool.tier} - ${h.tool.damage} DMG`
        : h.food ? `FOOD - RESTORES ${h.food}` : (h.build ? 'PLACEABLE' : 'MATERIAL'),
        r.x, sy2 + 22 * S, { scale: S, color: PAL.faint });
    } else {
      drawText(c, 'BARE HANDS', r.x, sy2 + 11 * S, { scale: S, color: PAL.faint });
    }


    /* Crafting, filtered by the stations you are standing near. */
    const bx = r.x + colW + 8 * S;
    const bw = r.w - colW - 8 * S;
    const stations = state.stations || new Set(['hand']);
    drawText(c, 'MAKE', bx, r.y, { scale: S, color: PAL.dim });
    drawText(c, [...stations].map(s => STATION_NAME[s] || s).join(' · '),
      bx + bw, r.y, { scale: S, color: PAL.chrome, align: 'right' });

    const recipes = allRecipes();
    const rows = [];
    recipes.forEach((rec, i) => {
      if (rec.hidden) return;
      if (!stations.has(rec.station)) return;
      rows.push({ rec, i });
    });

    const rowH = 21 * S;
    const maxRows = Math.floor((r.h - 12 * S) / rowH);
    this.maxScroll = Math.max(0, rows.length - maxRows);
    this.scroll = Math.max(0, Math.min(this.maxScroll, this.scroll));
    const view = rows.slice(this.scroll, this.scroll + maxRows);

    view.forEach((row, k) => {
      const ry = r.y + 10 * S + k * rowH;
      const def = ITEMS[row.rec.out[0]];
      const can = invHasAll(me, row.rec.in);
      const hov = this.hud.isHover(bx, ry, bw, rowH - 2 * S);
      if (hov) frame(c, bx, ry, bw, rowH - 2 * S, { lit: true, notch: 2 * S, shadow: false });
      drawIcon(c, def.icon, bx + 2 * S, ry + 2 * S, 9 * S, def.tint, def.glow ? '#fff' : undefined);
      const label = def.name + (row.rec.out[1] > 1 ? ` x${row.rec.out[1]}` : '');
      drawText(c, clipText(label, bw - 16 * S, S), bx + 14 * S, ry + 3 * S,
        { scale: S, color: can ? PAL.text : PAL.faint });
      /* Costs read as "3 WOOD", not "40/3": what it takes, coloured
         by whether you have it. */
      let cx = bx + 14 * S;
      const cy = ry + 12 * S;
      const costRight = bx + bw - 2 * S;
      for (let ci = 0; ci < row.rec.in.length; ci++) {
        const [item, n] = row.rec.in[ci];
        const have = me.inv[item] || 0;
        const txt = `${n} ${ITEMS[item].name.toUpperCase()}`;
        const tw = textWidth(txt, S);
        if (cx + tw > costRight) {
          drawText(c, `+${row.rec.in.length - ci}`, cx, cy, { scale: S, color: PAL.faint });
          break;
        }
        drawText(c, txt, cx, cy, { scale: S, color: have >= n ? PAL.dim : PAL.bad });
        cx += tw + 6 * S;
      }
      this.hud.hit('panel:craft', bx, ry, bw, rowH - 2 * S, row.i);
      if (hov) {
        this.tooltip = {
          title: def.name, color: PAL.text,
          body: def.desc || '', foot: can ? 'CLICK TO MAKE' : 'NOT ENOUGH',
        };
      }
    });
    if (this.maxScroll > 0) {
      drawText(c, `${this.scroll + 1}-${this.scroll + view.length} OF ${rows.length}  [WHEEL]`,
        bx + bw, r.y + r.h - 6 * S, { scale: S, align: 'right', color: PAL.faint });
    }
  }

  /* ------------------------------------------------- build menu
     Two columns of rows, not a grid of labelled squares: every
     building name is longer than a 26px slot is wide, so under a
     grid they all ran into each other. A row gives the name the
     whole column. */
  _build(state, r) {
    const c = this.hud.ctx, S = this.hud.scale;
    const me = state.me;
    const keys = Object.keys(BUILDINGS);

    const cols = 2, gap = 6 * S;
    const cardW = Math.floor((r.w - gap * (cols - 1)) / cols);
    const rowsN = Math.ceil(keys.length / cols);
    const cardH = 16 * S;
    const pitch = Math.max(cardH + 2 * S, Math.floor((r.h - 12 * S) / rowsN));

    keys.forEach((key, i) => {
      const def = BUILDINGS[key];
      const item = ITEMS[key];
      const col = i % cols, row = Math.floor(i / cols);
      const cx = r.x + col * (cardW + gap);
      const cy = r.y + row * pitch;
      const have = me.inv[key] || 0;
      const hov = this.hud.isHover(cx, cy, cardW, cardH);
      const picked = me.buildKey === key;

      if (hov || picked) frame(c, cx, cy, cardW, cardH, { lit: true, notch: 3 * S, shadow: false });
      slot(c, cx, cy, cardH, {
        item: def.icon, tint: item.tint, scale: S,
        selected: picked, disabled: have <= 0,
      });
      const nameW = cardW - cardH - 5 * S - 20 * S;
      drawText(c, clipText(def.name, nameW, S), cx + cardH + 5 * S, cy + 5 * S,
        { scale: S, color: have > 0 ? PAL.text : PAL.faint });
      drawText(c, have > 0 ? `x${have}` : '-', cx + cardW - 3 * S, cy + 5 * S,
        { scale: S, align: 'right', color: have > 0 ? PAL.good : PAL.faint });

      this.hud.hit('panel:build', cx, cy, cardW, cardH, key);
      if (hov) {
        /* When you have none, the tooltip says what one costs, so
           you do not have to go hunting through the pack tab. */
        let foot = 'CLICK TO EQUIP';
        if (have <= 0) {
          const rec = allRecipes().find(x => x.out[0] === key);
          foot = rec ? 'NEEDS ' + rec.in.map(([it, n]) => `${n} ${ITEMS[it].name.toUpperCase()}`).join(', ')
            : 'CANNOT BE MADE';
        }
        this.tooltip = { title: def.name, color: PAL.text, body: def.desc, foot };
      }
    });

    drawText(c, me.buildKey ? `HOLDING ${BUILDINGS[me.buildKey].name.toUpperCase()} - LEFT CLICK TO PLACE, RIGHT CLICK TO STOP`
      : 'PICK SOMETHING, THEN LEFT CLICK IN THE WORLD TO PLACE IT',
      r.x, r.y + r.h - 7 * S, { scale: S, color: me.buildKey ? PAL.xp : PAL.faint });
  }

  /* ------------------------------------------------- skill tree
     Nodes are listed in chain order, not tier order: walking the
     prerequisites depth-first puts each path down one unbroken run
     so the shape of the choice is visible without drawing wires
     across the panel. Cost is pips, not "2P", because the digits
     ate the width the longer names needed. */
  _skills(state, r) {
    const c = this.hud.ctx, S = this.hud.scale;
    const me = state.me;

    const footH = 20 * S;
    const headH = 15 * S;
    const colW = Math.floor((r.w - 8 * S) / 3);
    const rowH = 12 * S, pitch = 13 * S;
    let detail = null;

    SKILL_BRANCHES.forEach((branch, bi) => {
      const bx = r.x + bi * (colW + 4 * S);
      drawText(c, branch.name, bx + colW / 2, r.y, {
        scale: S + 1, align: 'center', color: branch.color,
      });
      c.fillStyle = branch.color;
      c.globalAlpha = 0.45;
      c.fillRect(px(bx), px(r.y + 11 * S), px(colW), px(S));
      c.globalAlpha = 1;

      const nodes = chainOrder(branch.id);
      nodes.forEach(({ key, def, depth, last }, ni) => {
        const ny = r.y + headH + ni * pitch;
        const owned = !!me.skills[key];
        const reqOk = !def.req || !!me.skills[def.req];
        const can = !owned && reqOk && me.skillPoints >= def.cost;
        const hov = this.hud.isHover(bx, ny, colW, rowH);

        /* A rail down the left edge, brightened as far as you have
           actually paid for, so progress reads at a glance. */
        c.fillStyle = branch.color;
        c.globalAlpha = owned ? 0.85 : 0.16;
        c.fillRect(px(bx + 1 * S), px(ny - (ni ? pitch - rowH : 0)),
          px(S), px(rowH + (ni ? pitch - rowH : 0)));
        if (depth > 0) c.fillRect(px(bx + 1 * S), px(ny + rowH / 2 - S / 2), px(2 * S + depth * 2 * S), px(S));
        c.globalAlpha = 1;

        const ix = bx + 4 * S + depth * 2 * S;
        if (hov || can) frame(c, bx + 3 * S, ny, colW - 3 * S, rowH, { lit: true, notch: 2 * S, shadow: false });
        const pipW = def.cost * 4 * S;
        drawText(c, clipText(def.name, colW - (ix - bx) - pipW - 10 * S, S), ix, ny + 3 * S, {
          scale: S, color: owned ? branch.color : can ? PAL.text : PAL.faint,
        });

        /* Pips: filled once learned, gold while you can afford them. */
        for (let k = 0; k < def.cost; k++) {
          const qx = bx + colW - 4 * S - (def.cost - k) * 4 * S;
          const qy = ny + rowH / 2 - 1.5 * S;
          c.fillStyle = owned ? branch.color : can ? PAL.xp : PAL.faint;
          if (owned || can) {
            c.fillRect(px(qx), px(qy), px(3 * S), px(3 * S));
          } else {
            /* Hollow, not two bars: a 3px box with a hole reads as an
               unpaid pip, where two stacked bars read as "=". */
            c.globalAlpha = 0.6;
            c.fillRect(px(qx), px(qy), px(3 * S), px(3 * S));
            c.fillStyle = PAL.ink;
            c.fillRect(px(qx + S), px(qy + S), px(S), px(S));
            c.globalAlpha = 1;
          }
        }

        if (can) this.hud.hit('panel:skill', bx, ny, colW, rowH, key);
        if (hov) {
          const foot = owned ? 'LEARNED' : can ? 'CLICK TO LEARN'
            : !reqOk ? 'NEEDS ' + SKILLS[def.req].name.toUpperCase()
              : `NEEDS ${def.cost} POINT${def.cost > 1 ? 'S' : ''}`;
          detail = { name: def.name, desc: def.desc, foot, color: branch.color };
        }
      });
    });

    /* One fixed strip at the bottom rather than only a tooltip: you
       can read a node without covering the three next to it. */
    const fy = r.y + r.h - footH;
    divider(c, r.x, fy - 3 * S, r.w);
    if (detail) {
      drawText(c, detail.name, r.x, fy, { scale: S, color: detail.color });
      drawText(c, detail.foot, r.x + r.w, fy, { scale: S, align: 'right', color: PAL.xp });
      drawText(c, detail.desc, r.x, fy + 9 * S, { scale: S, color: PAL.dim });
    } else {
      drawText(c, me.skillPoints > 0
        ? `${me.skillPoints} POINT${me.skillPoints === 1 ? '' : 'S'} UNSPENT - HOVER A NODE TO READ IT`
        : 'NO POINTS. KILL THINGS, FINISH CONTRACTS, SURVIVE NIGHTS.',
        r.x, fy + 4 * S, { scale: S, color: me.skillPoints > 0 ? PAL.xp : PAL.faint });
    }
  }

  /* --------------------------------------------------- the log */
  _journal(state, r) {
    const c = this.hud.ctx, S = this.hud.scale;
    const sim = state.sim;
    const colW = Math.floor((r.w - 6 * S) / 2);

    /* A log of what is out there, not a list of what to do next.
       When something is actually happening it gets a line; otherwise
       the space goes to the world instead of to an instruction. */
    drawText(c, 'OUT THERE', r.x, r.y, { scale: S, color: PAL.dim });
    const obj = state.objective;
    let y;
    if (obj) {
      const bigS = textWidth(obj.text, S + 1) <= colW ? S + 1 : S;
      drawText(c, obj.text, r.x, r.y + 10 * S,
        { scale: bigS, color: obj.urgent ? PAL.bad : PAL.xp });
      const subY = r.y + 12 * S + lineHeight(bigS);
      const subN = obj.sub ? drawWrapped(c, obj.sub, r.x, subY, colW, { scale: S, color: PAL.dim }) : 0;
      y = subY + subN * lineHeight(S) + 6 * S;
    } else {
      const n = drawWrapped(c, 'Nothing is demanding anything of you. There is a beacon, '
        + 'there are rifts, and there is a lot of ground you have not walked.',
        r.x, r.y + 10 * S, colW, { scale: S, color: PAL.faint });
      y = r.y + 10 * S + n * lineHeight(S) + 8 * S;
    }
    if (!sim.beacon.lit) {
      drawText(c, 'BEACON PARTS', r.x, y, { scale: S, color: PAL.chrome });
      y += 10 * S;
      for (const [item, n] of BEACON_REPAIR) {
        const have = Math.min(n, sim.beacon.store[item] || 0);
        const def = ITEMS[item];
        drawIcon(c, def.icon, r.x, y, 9 * S, def.tint);
        drawText(c, def.name, r.x + 12 * S, y + 1 * S, { scale: S, color: PAL.text });
        drawText(c, `${have}/${n}`, r.x + colW, y + 1 * S,
          { scale: S, align: 'right', color: have >= n ? PAL.good : PAL.warn });
        y += 11 * S;
      }
      drawWrapped(c, 'Optional. Bring these to the beacon and hold G, and it '
        + 'lights: a warm place, a shared store, turrets and floodlights, and '
        + 'your core recharges twice as fast.',
        r.x, y + 4 * S, colW, { scale: S, color: PAL.faint });
    } else {
      drawText(c, 'RIFT GATES', r.x, y, { scale: S, color: PAL.chrome });
      y += 10 * S;
      sim.gates.forEach((g, i) => {
        drawText(c, `GATE ${i + 1}`, r.x, y, { scale: S, color: g.sealed ? PAL.good : PAL.text });
        drawText(c, g.sealed ? 'SEALED' : g.active ? `${Math.round(g.progress * 100)}%` : 'OPEN',
          r.x + colW, y, { scale: S, align: 'right', color: g.sealed ? PAL.good : PAL.warn });
        y += 10 * S;
      });
      drawWrapped(c, 'Take them or leave them. Each one sealed makes every night '
        + 'after it smaller; seal them all and something old wakes up under the beacon.',
        r.x, y + 4 * S, colW, { scale: S, color: PAL.faint });
    }

    /* Right column: contracts and the forecast. */
    const bx = r.x + colW + 6 * S;
    drawText(c, 'CONTRACTS', bx, r.y, { scale: S, color: PAL.dim });
    let cy = r.y + 10 * S;
    for (const ct of sim.contracts) {
      const need = ct.need.n || 1;
      const tally = ct.done ? 'DONE' : `${Math.min(need, ct.progress)}/${need}`;
      drawText(c, clipText(ct.name, colW - textWidth(tally, S) - 6 * S, S), bx, cy,
        { scale: S, color: ct.done ? PAL.good : PAL.text });
      drawText(c, tally, bx + colW, cy, { scale: S, align: 'right', color: ct.done ? PAL.good : PAL.xp });
      const n = drawWrapped(c, ct.desc, bx, cy + 8 * S, colW, { scale: S, color: PAL.faint });
      cy += 10 * S + n * lineHeight(S);
    }

    drawText(c, 'FORECAST', bx, cy + 4 * S, { scale: S, color: PAL.dim });
    cy += 14 * S;
    for (let i = 0; i < 3; i++) {
      const id = sim.nightDeck[(sim.night + i) % sim.nightDeck.length];
      const def = NIGHTS[id];
      drawText(c, i === 0 ? 'TONIGHT' : `NIGHT +${i}`, bx, cy, { scale: S, color: PAL.faint });
      drawText(c, def.name, bx + colW, cy, { scale: S, align: 'right', color: def.color });
      cy += 10 * S;
    }

    const st = sim.stats;
    drawText(c, `BUILT ${sim.buildings.length}   KILLS ${st.killed}   SEALED ${st.gatesSealed}`,
      r.x, r.y + r.h - 8 * S, { scale: S, color: PAL.faint });
  }

  /* -------------------------------------------- beacon console
     Two columns of tall cards. One column of short rows put the
     cost list on the same line as the description and the two ran
     straight through each other. */
  _beacon(state, r) {
    const c = this.hud.ctx, S = this.hud.scale;
    const sim = state.sim;
    drawText(c, 'BEACON CONSOLE', r.x, r.y, { scale: S + 1, color: PAL.chrome });
    drawText(c, `INTEGRITY ${Math.round(sim.beacon.hp)}/${sim.beacon.maxHp}`,
      r.x + r.w, r.y, { scale: S, align: 'right',
        color: sim.beacon.hp < sim.beacon.maxHp * 0.5 ? PAL.bad : PAL.text });
    bar(c, r.x, r.y + lineHeight(S + 1), r.w, 3 * S, sim.beacon.hp, sim.beacon.maxHp, PAL.chrome, { seg: 12 });
    drawText(c, clipText('THE STORE IS SHARED - ANYTHING DROPPED IN PAYS FOR THESE', r.w, S),
      r.x, r.y + lineHeight(S + 1) + 5 * S, { scale: S, color: PAL.faint });

    const top = r.y + lineHeight(S + 1) + 16 * S;
    const colW = Math.floor((r.w - 6 * S) / 2);
    const keys = Object.entries(BEACON_UPGRADES);
    const rows = Math.ceil(keys.length / 2);
    /* Height comes from the longest description, so the cost line
       along the bottom can never be written over by the text above. */
    const descLines = Math.max(...keys.map(([key, def]) =>
      wrapLines(def.desc(sim.beacon.upgrades[key]), colW - 8 * S, S).length));
    const gap = 3 * S;
    const rowH = Math.max(13 * S + descLines * lineHeight(S) + 12 * S,
      Math.floor((r.h - (top - r.y) - (rows - 1) * gap) / rows));

    keys.forEach(([key, def], i) => {
      const cx0 = r.x + (i % 2) * (colW + 6 * S);
      const y = top + Math.floor(i / 2) * (rowH + gap);
      const level = sim.beacon.upgrades[key];
      const maxed = level >= def.max;
      const cost = maxed ? [] : BEACON_COSTS[key](level);
      const can = !maxed && cost.every(([it, n]) => (sim.beacon.store[it] || 0) >= n);
      const hov = this.hud.isHover(cx0, y, colW, rowH);
      frame(c, cx0, y, colW, rowH, { lit: can || hov, notch: 2 * S, shadow: false });

      /* Pips first: the name is clipped against whatever they leave. */
      const pipsW = def.max * 6 * S;
      for (let k = 0; k < def.max; k++) {
        c.fillStyle = k < level ? PAL.chrome : 'rgba(255,255,255,0.14)';
        c.fillRect(px(cx0 + colW - 4 * S - (def.max - k) * 6 * S), px(y + 4 * S), 4 * S, 4 * S);
      }
      drawText(c, clipText(def.name, colW - pipsW - 12 * S, S), cx0 + 4 * S, y + 4 * S,
        { scale: S, color: maxed ? PAL.good : can ? PAL.text : PAL.dim });
      drawWrapped(c, maxed ? 'At its limit.' : def.desc(level),
        cx0 + 4 * S, y + 13 * S, colW - 8 * S, { scale: S, color: PAL.faint });

      /* Costs get their own line along the bottom of the card. */
      if (!maxed) {
        let cx = cx0 + 4 * S;
        const cy = y + rowH - 10 * S;
        for (let k = 0; k < cost.length; k++) {
          const [it, n] = cost[k];
          const have = sim.beacon.store[it] || 0;
          const txt = `${n} ${ITEMS[it].name.toUpperCase()}`;
          const tw = textWidth(txt, S);
          if (cx + tw > cx0 + colW - 4 * S) { drawText(c, `+${cost.length - k}`, cx, cy, { scale: S, color: PAL.faint }); break; }
          drawText(c, txt, cx, cy, { scale: S, color: have >= n ? PAL.dim : PAL.bad });
          cx += tw + 6 * S;
        }
      } else {
        drawText(c, 'MAXED', cx0 + 4 * S, y + rowH - 10 * S, { scale: S, color: PAL.good });
      }

      if (can) this.hud.hit('panel:upgrade', cx0, y, colW, rowH, key);
      if (hov && !maxed && !can) {
        this.tooltip = {
          title: def.name, color: PAL.chrome, body: def.desc(level),
          foot: 'THE STORE IS SHORT',
        };
      }
    });
  }

  /* --------------------------------------------------- clicking */
  handle(hit, state) {
    if (!hit) return false;
    switch (hit.name) {
      case 'panel:tab': this.open(hit.data); return true;
      case 'panel:item': this.hooks.useItem(hit.data); return true;
      case 'panel:craft': this.hooks.craft(hit.data); return true;
      case 'panel:build': this.hooks.setBuild(hit.data); return true;
      case 'panel:skill': this.hooks.learnSkill(hit.data); return true;
      case 'panel:upgrade': this.hooks.buyUpgrade(hit.data); return true;
      default: return false;
    }
  }

  wheel(delta) {
    if (this.current === 'inventory') {
      this.scroll = Math.max(0, Math.min(this.maxScroll || 0, this.scroll + Math.sign(delta)));
      return true;
    }
    return false;
  }
}
