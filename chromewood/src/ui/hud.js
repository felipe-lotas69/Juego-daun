/* ============================================================
   hud.js - the overlay

   Drawn on a 2D canvas over the WebGL one, in the same pixel grid,
   with the bitmap font and hand-drawn icons. Laid out from a
   logical 1280x720 and scaled to whole pixels, so it keeps its
   proportions on a phone and on a monitor without ever landing a
   glyph on a half pixel.
   ============================================================ */

import { PAL, frame, bar, slot, rivets, px, drawText, textWidth, clipText } from './draw.js';
import { lineHeight } from './font.js';
import { ITEMS } from '../game/items.js';
import { ABILITIES } from '../game/defs.js';
import { ALL_CREATURES, PLAYER_COLORS } from '../render/actors.js';
import { RESONANCE, SURVIVAL, DAY } from '../core/config.js';
import { clamp01, formatTime } from '../core/util.js';

/* One colour per biome for the minimap, keyed by the world's enum. */
const MINIMAP_BIOME = [
  [40, 82, 120],    /* ocean    */
  [196, 178, 128],  /* beach    */
  [126, 168, 84],   /* meadow   */
  [78, 140, 76],    /* forest   */
  [66, 122, 96],    /* pine     */
  [132, 128, 118],  /* highland */
  [212, 224, 236],  /* snow     */
  [96, 106, 66],    /* marsh    */
  [80, 176, 140],   /* bloom    */
  [140, 156, 92],   /* scrap    */
  [92, 78, 108],    /* ash      */
  [172, 160, 184],  /* plaza    */
];

export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 1280; this.h = 720;
    this.scale = 2;
    this.dpr = 1;
    this.killFeed = [];
    this.toast = null;
    this.toastTime = 0;
    this.time = 0;
    this.hits = [];
    this.pointer = { x: -1, y: -1, down: false };
    this.touch = /Mobi|Android|iPhone|iPad/i.test(
      typeof navigator !== 'undefined' ? navigator.userAgent : '');
  }

  resize(w, h, dpr) {
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.w = w; this.h = h; this.dpr = dpr;
    /* Whole-number scale only: the font is a bitmap. */
    this.scale = Math.max(1, Math.min(4, Math.round(h / 420)));
  }

  pushKill(text, color) {
    this.killFeed.unshift({ text, color, life: 4.5 });
    if (this.killFeed.length > 6) this.killFeed.pop();
  }

  showToast(text, color, time = 3.0, sub = '') {
    this.toast = { text, color, sub };
    this.toastTime = time;
  }

  update(dt) {
    this.time += dt;
    for (let i = this.killFeed.length - 1; i >= 0; i--) {
      this.killFeed[i].life -= dt;
      if (this.killFeed[i].life <= 0) this.killFeed.splice(i, 1);
    }
    if (this.toastTime > 0) this.toastTime -= dt;
  }

  hit(name, x, y, w, h, data) {
    this.hits.push({ name, x: px(x), y: px(y), w: px(w), h: px(h), data });
  }

  hitTest(x, y) {
    for (let i = this.hits.length - 1; i >= 0; i--) {
      const b = this.hits[i];
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b;
    }
    return null;
  }

  isHover(x, y, w, h) {
    const p = this.pointer;
    return p.x >= px(x) && p.x <= px(x + w) && p.y >= px(y) && p.y <= px(y + h);
  }

  /* ---------------------------------------------------- drawing */
  draw(state) {
    const c = this.ctx;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.imageSmoothingEnabled = false;
    this.hits.length = 0;

    const me = state.me;
    if (!me) return;

    this._floaters(state);
    this._worldMarkers(state);
    this._reticle(state, me);
    this._topLeft(state, me);
    this._minimap(state);
    this._vitals(state, me);
    this._hotbar(state, me);
    this._abilities(state, me);
    this._killFeed(state);
    this._party(state);
    this._bossBar(state);
    this._contracts(state);
    this._prompt(state, me);
    this._toast(state);
    if (me.craft) this._craftBar(state, me);
    if (me.state === 'downed') this._downed(state, me);
    if (me.state === 'dead') this._dead(state, me);
    if (this.touch) this._touch(state);
  }

  /* --- top left: the clock, the night, what you should be doing --- */
  _topLeft(state, me) {
    const c = this.ctx, S = this.scale;
    const x = 6 * S, y = 6 * S;
    const w = 128 * S, h = 46 * S;
    const sim = state.sim;
    frame(c, x, y, w, h);
    rivets(c, x, y, w, h, 3 * S);

    const night = sim.isNight;
    const label = night ? `NIGHT ${sim.night}` : (sim.night === 0 ? 'FIRST LIGHT' : `DAY ${sim.night + 1}`);
    drawText(c, label, x + 5 * S, y + 4 * S, { scale: S, color: night ? '#c79bff' : '#ffd98a' });
    drawText(c, formatTime(sim.timeToPhaseChange), x + w - 5 * S, y + 4 * S,
      { scale: S, color: PAL.dim, align: 'right' });

    /* A day strip with a marker, rather than a percentage: you read
       "an hour of light left" from the position, not the number. */
    const sx = x + 5 * S, sy = y + 14 * S, sw = w - 10 * S, sh = 5 * S;
    const dayFrac = DAY.dayLength / (DAY.dayLength + DAY.nightLength);
    c.fillStyle = '#3a3050';
    c.fillRect(px(sx), px(sy), px(sw), px(sh));
    c.fillStyle = '#5b7f4f';
    c.fillRect(px(sx), px(sy), px(sw * dayFrac), px(sh));
    c.fillStyle = '#2a2440';
    c.fillRect(px(sx + sw * dayFrac), px(sy), px(sw * (1 - dayFrac)), px(sh));
    const t = (sim.dayTime % (DAY.dayLength + DAY.nightLength)) / (DAY.dayLength + DAY.nightLength);
    c.fillStyle = '#ffffff';
    c.fillRect(px(sx + sw * t) - 1, px(sy) - 1 * S, 2, px(sh) + 2 * S);
    c.strokeStyle = PAL.edge;
    c.strokeRect(px(sx) + 0.5, px(sy) + 0.5, px(sw) - 1, px(sh) - 1);

    if (night) {
      drawText(c, sim.nightType.name, x + 5 * S, y + 23 * S, { scale: S, color: sim.nightType.color });
      drawText(c, `${sim.wave.alive} OUT THERE`, x + w - 5 * S, y + 23 * S,
        { scale: S, color: PAL.dim, align: 'right' });
    } else if (sim.weather.id !== 'clear') {
      drawText(c, sim.weather.name, x + 5 * S, y + 23 * S, { scale: S, color: PAL.chrome });
    } else {
      drawText(c, 'CLEAR', x + 5 * S, y + 23 * S, { scale: S, color: PAL.faint });
    }

    /* Resonance: the one gauge that is about the world hearing you. */
    const rx = x + 5 * S, ry = y + 32 * S, rw = w - 10 * S;
    const res = state.resonanceHere || 0;
    const loud = res > RESONANCE.threshold;
    drawText(c, 'NOISE', rx, ry, { scale: S, color: loud ? PAL.warn : PAL.faint });
    bar(c, rx + 26 * S, ry, rw - 26 * S, 5 * S, res, RESONANCE.max,
      loud ? (Math.sin(this.time * 6) > 0 ? '#ff8a5a' : PAL.warn) : '#5b6a86',
      { seg: 6 });

    /* Whatever is going on right now, if anything. Most of the time
       there is nothing and the plate is simply not drawn - a banner
       telling you what to do next is the one thing this game is
       deliberately without. */
    const obj = state.objective;
    let below = y + h + 4 * S;
    if (obj) {
      frame(c, x, below, w, 20 * S);
      drawText(c, obj.text, x + 5 * S, below + 3 * S,
        { scale: S, color: obj.urgent ? PAL.bad : PAL.xp });
      if (obj.sub) drawText(c, obj.sub, x + 5 * S, below + 11 * S, { scale: S, color: PAL.dim });
      if (obj.progress > 0 && obj.progress < 1) {
        bar(c, x + 5 * S, below + 17 * S, w - 10 * S, 2 * S, obj.progress, 1, PAL.xp);
      }
      below += 24 * S;
    }

    if (state.sim.beacon.lit) {
      const by = below;
      frame(c, x, by, w, 16 * S);
      const b = state.sim.beacon;
      const frac = b.hp / b.maxHp;
      drawText(c, 'BEACON', x + 5 * S, by + 3 * S, { scale: S, color: PAL.chrome });
      drawText(c, `${Math.round(frac * 100)}%`, x + w - 5 * S, by + 3 * S,
        { scale: S, align: 'right', color: frac > 0.5 ? PAL.good : frac > 0.25 ? PAL.warn : PAL.bad });
      bar(c, x + 5 * S, by + 10 * S, w - 10 * S, 3 * S, b.hp, b.maxHp,
        frac > 0.5 ? PAL.chrome : frac > 0.25 ? PAL.warn : PAL.bad);
    }
  }

  /* --- bottom left: the body --- */
  _vitals(state, me) {
    const c = this.ctx, S = this.scale;
    /* The energy row only exists once the beacon is lit, so the
       plate grows rather than letting the bar run off its edge. */
    const rows = 5;
    const w = 112 * S, h = (17 + rows * 8) * S;
    const x = 6 * S, y = this.h - h - 6 * S;
    frame(c, x, y, w, h);
    rivets(c, x, y, w, h, 3 * S);

    drawText(c, me.name, x + 5 * S, y + 4 * S, { scale: S, color: PAL.text });
    drawText(c, 'LV' + me.level, x + w - 5 * S, y + 4 * S, { scale: S, color: PAL.xp, align: 'right' });

    const bx = x + 5 * S, bw = w - 10 * S;
    let by = y + 13 * S;
    const row = (value, max, color, tag) => {
      drawText(c, tag, bx, by + 1, { scale: S, color: PAL.faint });
      bar(c, bx + 14 * S, by, bw - 14 * S, 5 * S, value, max, color, { seg: 4 });
      by += 8 * S;
    };
    row(me.hp, me.maxHp, PAL.hp, 'HP');
    row(me.stamina, me.maxStamina, PAL.stam, 'ST');
    row(me.hunger, me.maxHunger, PAL.food, 'FD');
    row(me.warmth, SURVIVAL.maxWarmth, PAL.warm, 'WM');
    row(me.energy, me.maxEnergy, PAL.mana, 'EN');

    /* Experience as a hairline along the bottom edge of the plate. */
    bar(c, x + 1, y + h - 3 * S, w - 2, 2 * S, me.xp, me.xpNext, PAL.xp, { back: 'rgba(0,0,0,0.4)' });
    if (me.skillPoints > 0) {
      const blink = 0.55 + 0.45 * Math.sin(this.time * 5);
      drawText(c, `[K] ${me.skillPoints} POINT${me.skillPoints > 1 ? 'S' : ''} TO SPEND`,
        x, y - 9 * S, { scale: S, color: `rgba(255,210,74,${blink})` });
    }
  }

  /* --- bottom centre: what you are holding --- */
  _hotbar(state, me) {
    const c = this.ctx, S = this.scale;
    const size = 22 * S, gap = 3 * S;
    const n = me.hotbar.length;
    const total = n * size + (n - 1) * gap;
    const x0 = this.w / 2 - total / 2;
    const y = this.h - size - 8 * S;

    for (let i = 0; i < n; i++) {
      const x = x0 + i * (size + gap);
      const id = me.hotbar[i];
      const def = id && ITEMS[id];
      slot(c, x, y, size, {
        selected: i === me.hotbarIndex,
        item: def ? def.icon : null,
        count: id ? (me.inv[id] || 0) : 0,
        key: String(i + 1),
        tint: def ? def.tint : 0x555555,
        scale: S,
        accent: def && def.glow ? '#ffffff' : undefined,
      });
      this.hit('hotbar', x, y, size, size, i);
    }

    const held = me.hotbar[me.hotbarIndex];
    if (held && ITEMS[held]) {
      drawText(c, ITEMS[held].name, this.w / 2, y - 9 * S,
        { scale: S, align: 'center', color: PAL.text });
    }
    if (me.buildKey) {
      drawText(c, 'BUILDING — RIGHT CLICK TO STOP', this.w / 2, y - 18 * S,
        { scale: S, align: 'center', color: PAL.good });
    }
  }

  /* --- bottom right: the Core, once it is awake --- */
  _abilities(state, me) {
    const c = this.ctx, S = this.scale;
    const size = 20 * S, gap = 3 * S;
    const slots = ['dash', ...me.abilities.slice(1)];
    const keys = ['SPC', 'E', 'R', 'F'];
    const total = slots.length * size + (slots.length - 1) * gap;
    const x0 = this.w - total - 8 * S;
    const y = this.h - size - 8 * S;
    for (let i = 0; i < slots.length; i++) {
      const x = x0 + i * (size + gap);
      const id = slots[i];
      const isDash = id === 'dash';
      const def = isDash ? null : ABILITIES[id];
      const cd = isDash ? (me.dashCharges > 0 ? 0 : me.dashCd / 1.15)
        : def ? (me.cooldowns[id] || 0) / Math.max(0.01, def.cd) : 0;
      slot(c, x, y, size, {
        item: null, key: keys[i], scale: S,
        cooldown: cd,
        selected: false,
      });
      const col = isDash ? '#c8f0ff' : def ? '#' + def.color.toString(16).padStart(6, '0') : PAL.faint;
      drawText(c, isDash ? '>>' : (def ? def.name.slice(0, 3) : '--'),
        x + size / 2, y + size / 2, { scale: S, align: 'center', baseline: 'middle', color: col });
      if (def && def.cost) {
        drawText(c, String(def.cost), x + size - 2 * S, y + size - 8 * S,
          { scale: S, align: 'right', color: me.energy >= def.cost ? PAL.mana : PAL.bad });
      }
      if (isDash && me.dashMax > 1) {
        drawText(c, `${me.dashCharges}`, x + size - 2 * S, y + size - 8 * S,
          { scale: S, align: 'right', color: '#c8f0ff' });
      }
    }
  }

  _craftBar(state, me) {
    const c = this.ctx, S = this.scale;
    const w = 90 * S, h = 12 * S;
    const x = this.w / 2 - w / 2, y = this.h - 54 * S;
    frame(c, x, y, w, h, { notch: 3 });
    const frac = 1 - me.craft.time / me.craft.total;
    bar(c, x + 3 * S, y + 4 * S, w - 6 * S, 4 * S, frac, 1, PAL.xp);
    drawText(c, 'MAKING', x + w / 2, y - 8 * S, { scale: S, align: 'center', color: PAL.dim });
  }

  /* --- the aim reticle, in world space --- */
  _reticle(state, me) {
    const c = this.ctx, S = this.scale;
    const p = state.project(me.aimX, state.aimY || me.y, me.aimZ);
    if (!p.visible) return;
    const t = this.time * 3;
    c.strokeStyle = me.buildKey ? PAL.good : 'rgba(220,235,255,0.75)';
    c.lineWidth = 1;
    const r = 4 * S + Math.sin(t) * S * 0.5;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const dx = Math.cos(a), dy = Math.sin(a) * 0.55;
      c.beginPath();
      c.moveTo(px(p.x + dx * r), px(p.y + dy * r));
      c.lineTo(px(p.x + dx * (r + 3 * S)), px(p.y + dy * (r + 3 * S)));
      c.stroke();
    }
  }

  /* --- minimap --- */
  _minimap(state) {
    const c = this.ctx, S = this.scale;
    const size = 74 * S;
    const x = this.w - size - 6 * S, y = 6 * S;
    const sim = state.sim, world = sim.world;
    const half = world.size / 2;

    frame(c, x, y, size, size, { fill: 'rgba(8,7,16,0.92)', notch: 5 * S });
    const map = (wx, wz) => ({
      x: x + ((wx + half) / (half * 2)) * size,
      y: y + ((wz + half) / (half * 2)) * size,
    });

    /* Coast and mountain silhouette, sampled once and cached. */
    if (!this._mapImage || this._mapSeed !== world.seed) this._bakeMinimap(world, size);
    if (this._mapImage) {
      /* Inset by the frame so the map never sits on the bevel. */
      c.drawImage(this._mapImage, px(x) + 2, px(y) + 2, px(size) - 4, px(size) - 4);
    }

    for (const g of sim.gates) {
      const p = map(g.x, g.z);
      c.fillStyle = g.sealed ? '#63ff9d' : g.active ? '#ffffff' : '#ff4fd8';
      c.fillRect(px(p.x) - S, px(p.y) - S, 2 * S, 2 * S);
    }
    for (const lm of world.landmarks) {
      if (lm.kind === 'rift') continue;
      const p = map(lm.x, lm.z);
      const col = lm.kind === 'beacon' ? (sim.beacon.lit ? '#7ee8ff' : '#6b6b6b')
        : lm.kind === 'mine' ? '#ffb03a' : lm.kind === 'shrine' ? '#63ff9d'
        : lm.kind === 'cache' ? '#ffd24a' : 'rgba(180,190,210,0.55)';
      c.fillStyle = col;
      const s = lm.kind === 'beacon' ? 2 * S : S;
      c.fillRect(px(p.x) - s / 2, px(p.y) - s / 2, s, s);
    }
    for (const b of sim.buildings) {
      const p = map(b.x, b.z);
      c.fillStyle = 'rgba(255,220,150,0.8)';
      c.fillRect(px(p.x), px(p.y), S, S);
    }
    c.fillStyle = 'rgba(255,90,90,0.9)';
    for (const e of sim.enemies) {
      const p = map(e.x, e.z);
      const s = e.boss ? 3 * S : e.elite ? 2 * S : S;
      c.fillRect(px(p.x) - s / 2, px(p.y) - s / 2, s, s);
    }
    let i = 0;
    for (const pl of sim.players.values()) {
      const p = map(pl.x, pl.z);
      const col = PLAYER_COLORS[i % 4];
      c.fillStyle = pl.id === state.localId ? '#ffffff' : '#' + col.body.toString(16).padStart(6, '0');
      c.fillRect(px(p.x) - S, px(p.y) - S, 2 * S, 2 * S);
      i++;
    }
    drawText(c, 'M', x + size - 6 * S, y + size - 9 * S, { scale: S, color: PAL.faint });
  }

  /* One pass over the height field, kept until the seed changes. */
  _bakeMinimap(world, size) {
    const N = 96;
    const cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    const g = cv.getContext('2d');
    const img = g.createImageData(N, N);
    const step = world.size / N;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const tx = Math.min(world.size - 1, Math.floor(x * step));
        const ty = Math.min(world.size - 1, Math.floor(y * step));
        const i = world.idx(tx, ty);
        const h = world.height[i] / 16;
        const water = (world.flags[i] & 1) !== 0;
        /* Coloured by biome and shaded by plateau: you navigate by
           "the crags are north-east", not by an elevation ramp. */
        const band = 0.62 + (Math.floor(world.height[i] / 2) / 8) * 0.55;
        let r, gg, b;
        if (water) { r = 16 + h * 22; gg = 44 + h * 40; b = 84 + h * 52; }
        else {
          const base = MINIMAP_BIOME[world.biome[i]] || [90, 110, 80];
          r = base[0] * band; gg = base[1] * band; b = base[2] * band;
        }
        const o = (y * N + x) * 4;
        img.data[o] = r; img.data[o + 1] = gg; img.data[o + 2] = b; img.data[o + 3] = 235;
      }
    }
    g.putImageData(img, 0, 0);
    this._mapImage = cv;
    this._mapSeed = world.seed;
  }

  _killFeed(state) {
    const S = this.scale;
    const x = this.w - 8 * S;
    let y = 86 * S;
    for (const k of this.killFeed) {
      const a = clamp01(k.life / 1.2);
      this.ctx.globalAlpha = a;
      drawText(this.ctx, k.text, x, y, { scale: S, color: k.color, align: 'right' });
      this.ctx.globalAlpha = 1;
      y += lineHeight(S);
    }
  }

  _contracts(state) {
    const sim = state.sim;
    if (!sim.contracts.length) return;
    const c = this.ctx, S = this.scale;
    const w = 96 * S;
    const open = sim.contracts.filter(x => !x.done);
    if (!open.length) return;
    const h = (10 + open.length * 11) * S;
    const x = this.w - w - 6 * S, y = 86 * S + this.killFeed.length * lineHeight(S) + 4 * S;
    frame(c, x, y, w, h);
    drawText(c, 'CONTRACTS', x + 4 * S, y + 3 * S, { scale: S, color: PAL.dim });
    open.forEach((ct, i) => {
      const cy = y + (11 + i * 11) * S;
      const need = ct.need.n || 1;
      const tally = `${Math.min(need, ct.progress)}/${need}`;
      /* Clipped against the tally, not the plate: otherwise a long
         name and its counter met in the middle with no gap. */
      drawText(c, clipText(ct.name, w - 12 * S - textWidth(tally, S), S), x + 4 * S, cy,
        { scale: S, color: PAL.text });
      drawText(c, tally, x + w - 4 * S, cy, { scale: S, color: PAL.xp, align: 'right' });
    });
  }

  _party(state) {
    const sim = state.sim;
    if (sim.players.size <= 1) return;
    const c = this.ctx, S = this.scale;
    let y = this.h * 0.36;
    let i = 0;
    for (const p of sim.players.values()) {
      if (p.id === state.localId) { i++; continue; }
      const col = PLAYER_COLORS[i % 4];
      const w = 72 * S, x = 6 * S;
      frame(c, x, y, w, 20 * S);
      drawText(c, p.name, x + 4 * S, y + 3 * S,
        { scale: S, color: '#' + col.trim.toString(16).padStart(6, '0') });
      drawText(c, p.state === 'downed' ? 'DOWN' : p.state === 'dead' ? 'DEAD' : 'LV' + p.level,
        x + w - 4 * S, y + 3 * S,
        { scale: S, color: p.state === 'alive' ? PAL.dim : PAL.bad, align: 'right' });
      bar(c, x + 4 * S, y + 12 * S, w - 8 * S, 4 * S, p.hp, p.maxHp,
        p.state === 'alive' ? PAL.hp : '#6b3030');
      y += 24 * S;
      i++;
    }
  }

  _bossBar(state) {
    const boss = state.sim.enemies.find(e => e.boss);
    if (!boss) return;
    const c = this.ctx, S = this.scale;
    const w = 200 * S, h = 8 * S;
    const x = this.w / 2 - w / 2, y = 14 * S;
    const def = ALL_CREATURES[boss.type] || { name: 'RIFT' };
    drawText(c, def.name, this.w / 2, y - 10 * S, { scale: S * 1.5, align: 'center', color: '#ff8ae0' });
    bar(c, x, y, w, h, boss.hp, boss.maxHp, '#ff4fd8', { seg: 8 });
  }

  _prompt(state, me) {
    if (!me.interactTarget) return;
    const c = this.ctx, S = this.scale;
    const kind = me.interactTarget.kind;
    const sim = state.sim;
    let label;
    if (kind === 'beacon') {
      label = sim.beacon.lit ? 'HOLD [G] — BEACON CONSOLE' : 'HOLD [G] — DELIVER PARTS';
    } else if (kind === 'shrine') label = 'HOLD [G] — TOUCH THE SHRINE';
    else if (kind === 'cache') label = 'HOLD [G] — PRY IT OPEN';
    else if (kind === 'gate') {
      label = me.inv.sealpylon ? 'HOLD [G] — PLANT THE SEAL PYLON' : 'A SEAL PYLON WOULD CLOSE THIS';
    } else if (kind === 'build') {
      const b = me.interactTarget.obj;
      label = b && b.def.door ? 'HOLD [G] — DOOR'
        : b && b.def.respawn ? 'HOLD [G] — SET AS HOME' : 'HOLD [G] — STORE EVERYTHING';
    } else label = 'HOLD [G]';
    const y = this.h - 62 * S;
    drawText(c, label, this.w / 2, y, { scale: S, align: 'center', color: PAL.xp });
    if (me.interactProgress > 0) {
      const w = 70 * S;
      bar(c, this.w / 2 - w / 2, y + 9 * S, w, 3 * S, me.interactProgress, 1, PAL.xp);
    }
  }

  _floaters(state) {
    const c = this.ctx, S = this.scale;
    for (const f of state.fx.floaters) {
      const p = state.project(f.x, f.y, f.z);
      if (!p.visible) continue;
      const a = clamp01(f.life / f.maxLife);
      c.globalAlpha = a;
      drawText(c, f.text, p.x, p.y, {
        scale: Math.max(1, Math.round(S * (f.crit ? 1.6 : 1) * f.size)),
        align: 'center', color: f.color,
      });
      c.globalAlpha = 1;
    }
  }

  _worldMarkers(state) {
    const c = this.ctx, S = this.scale;
    const sim = state.sim;

    for (const e of sim.enemies) {
      if (e.hp >= e.maxHp && !e.boss) continue;
      if (e.boss) continue;
      const p = state.project(e.x, e.y + e.def.height + 0.35, e.z);
      if (!p.visible) continue;
      const w = (e.elite ? 22 : 16) * S;
      bar(c, p.x - w / 2, p.y, w, 2 * S, e.hp, e.maxHp, e.elite ? PAL.warn : '#ff5a5a');
      if (e.elite) drawText(c, 'ELITE', p.x, p.y - 8 * S, { scale: S, align: 'center', color: PAL.warn });
    }
    for (const a of sim.animals) {
      if (a.hp >= a.maxHp) continue;
      const p = state.project(a.x, a.y + a.def.height + 0.3, a.z);
      if (!p.visible) continue;
      bar(c, p.x - 8 * S, p.y, 16 * S, 2 * S, a.hp, a.maxHp, '#c8d24a');
    }
    for (const b of sim.buildings) {
      if (b.hp >= b.maxHp) continue;
      const p = state.project(b.x, b.y + (b.def.height || 1) + 0.3, b.z);
      if (!p.visible) continue;
      bar(c, p.x - 8 * S, p.y, 16 * S, 2 * S, b.hp, b.maxHp, PAL.warn);
    }

    /* Gates being sealed get a ring timer you can see from away. */
    for (const g of sim.gates) {
      if (!g.active) continue;
      const p = state.project(g.x, g.y + 3.2, g.z);
      if (!p.visible) continue;
      drawText(c, 'SEALING', p.x, p.y - 10 * S, { scale: S, align: 'center', color: PAL.chrome });
      bar(c, p.x - 20 * S, p.y, 40 * S, 3 * S, g.progress, 1, PAL.chrome);
    }

    let i = 0;
    for (const pl of sim.players.values()) {
      if (pl.id === state.localId) { i++; continue; }
      const p = state.project(pl.x, pl.y + 2.0, pl.z);
      const col = PLAYER_COLORS[i % 4];
      if (p.visible) {
        drawText(c, pl.name, p.x, p.y, { scale: S, align: 'center',
          color: '#' + col.trim.toString(16).padStart(6, '0') });
        if (pl.state === 'downed') {
          drawText(c, 'DOWNED — HOLD [G]', p.x, p.y + 9 * S,
            { scale: S, align: 'center', color: PAL.bad });
          bar(c, p.x - 18 * S, p.y + 18 * S, 36 * S, 3 * S, pl.reviveProgress, 1, PAL.good);
        }
      } else {
        this._edgeArrow(state, pl.x, pl.z, '#' + col.trim.toString(16).padStart(6, '0'));
      }
      i++;
    }
  }

  _edgeArrow(state, wx, wz, color) {
    const c = this.ctx, S = this.scale;
    const p = state.project(wx, state.me.y + 1, wz);
    let ang = Math.atan2(p.y - this.h / 2, p.x - this.w / 2);
    if (p.behind) ang += Math.PI;
    const m = Math.min(this.w, this.h) * 0.40;
    const x = this.w / 2 + Math.cos(ang) * m;
    const y = this.h / 2 + Math.sin(ang) * m;
    c.save();
    c.translate(px(x), px(y));
    c.rotate(ang);
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(5 * S, 0); c.lineTo(-4 * S, -3 * S); c.lineTo(-4 * S, 3 * S);
    c.closePath(); c.fill();
    c.restore();
  }

  _downed(state, me) {
    const c = this.ctx, S = this.scale;
    c.fillStyle = 'rgba(90, 8, 8, 0.22)';
    c.fillRect(0, 0, this.w, this.h);
    drawText(c, 'YOU ARE DOWN', this.w / 2, this.h * 0.36,
      { scale: S * 3, align: 'center', color: PAL.bad });
    drawText(c, `BLEEDING OUT — ${me.downTimer.toFixed(0)}S`, this.w / 2, this.h * 0.36 + 26 * S,
      { scale: S, align: 'center', color: '#ffb0b0' });
    if (me.reviveProgress > 0) {
      const w = 110 * S;
      bar(c, this.w / 2 - w / 2, this.h * 0.36 + 38 * S, w, 5 * S, me.reviveProgress, 1, PAL.good);
    }
  }

  _dead(state, me) {
    const c = this.ctx, S = this.scale;
    drawText(c, 'RECONSTITUTING', this.w / 2, this.h * 0.40,
      { scale: S * 2, align: 'center', color: PAL.chrome });
    drawText(c, String(Math.ceil(me.respawnTimer)), this.w / 2, this.h * 0.40 + 24 * S,
      { scale: S * 4, align: 'center', color: '#ffffff' });
  }

  _toast(state) {
    if (this.toastTime <= 0 || !this.toast) return;
    const c = this.ctx, S = this.scale;
    const a = Math.min(1, this.toastTime * 2);
    c.globalAlpha = a;
    drawText(c, this.toast.text, this.w / 2, this.h * 0.22,
      { scale: S * 2, align: 'center', color: this.toast.color });
    if (this.toast.sub) {
      drawText(c, this.toast.sub, this.w / 2, this.h * 0.22 + 20 * S,
        { scale: S, align: 'center', color: PAL.dim });
    }
    c.globalAlpha = 1;
  }

  _touch(state) {
    const c = this.ctx, S = this.scale;
    const r = 26 * S;
    const x = 44 * S, y = this.h - 44 * S;
    c.strokeStyle = 'rgba(200, 225, 255, 0.18)';
    c.lineWidth = 2;
    c.beginPath(); c.arc(px(x), px(y), r, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(px(x), px(y), r * 0.42, 0, Math.PI * 2); c.stroke();
    const btn = (name, label, bx, by, size) => {
      frame(c, bx, by, size, size, { notch: 3 });
      drawText(c, label, bx + size / 2, by + size / 2,
        { scale: S, align: 'center', baseline: 'middle', color: PAL.text });
      this.hit(name, bx, by, size, size);
    };
    const s = 22 * S;
    btn('touch:use', 'USE', this.w - s - 6 * S, this.h - s * 2 - 12 * S, s);
    btn('touch:dash', 'DSH', this.w - s * 2 - 12 * S, this.h - s - 6 * S, s);
    btn('touch:inv', 'BAG', this.w - s - 6 * S, this.h - s * 3 - 18 * S, s);
  }
}
