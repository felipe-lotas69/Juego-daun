/* ============================================================
   hud.js - the overlay

   Drawn on a plain 2D canvas over the WebGL one. Keeping it out of
   the 3D pass means the readouts stay sharp at any pixel scale,
   which matters: a health bar quantised to 4x4 blocks is pretty
   but unreadable in a fight.

   Everything is laid out from a logical 1280x720 and scaled, so
   the HUD holds its proportions on a phone and on a monitor.
   ============================================================ */

import { ABILITIES, ENEMIES } from '../game/defs.js';
import { clamp01, formatTime } from '../core/util.js';
import { PLAYER_COLORS } from '../render/actors.js';

const FONT = '"Courier New", ui-monospace, Menlo, monospace';

export class Hud {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.w = 1280; this.h = 720;
    this.scale = 1;
    this.killFeed = [];
    this.toast = null;
    this.toastTime = 0;
    this.time = 0;
    this.touch = /Mobi|Android|iPhone|iPad/i.test(
      typeof navigator !== 'undefined' ? navigator.userAgent : '');
    this.buttons = [];       /* hit areas for touch */
  }

  resize(w, h, dpr) {
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.w = w; this.h = h; this.dpr = dpr;
    /* One logical unit per CSS pixel at 720p; scale up from there. */
    this.scale = Math.max(0.62, Math.min(1.6, h / 720));
  }

  pushKill(text, color) {
    this.killFeed.unshift({ text, color, life: 4.2 });
    if (this.killFeed.length > 6) this.killFeed.pop();
  }

  showToast(text, color, time = 3.0) {
    this.toast = { text, color };
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

  /* ------------------------------------------------------- drawing */
  draw(state) {
    const c = this.ctx;
    const S = this.scale;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.textBaseline = 'middle';
    this.buttons.length = 0;

    const me = state.me;
    if (!me) return;

    this._drawFloaters(state, S);
    this._drawWorldMarkers(state, S);
    this._drawVitals(state, me, S);
    this._drawAbilities(state, me, S);
    this._drawTopBar(state, S);
    this._drawMinimap(state, S);
    this._drawKillFeed(S);
    this._drawParty(state, S);
    this._drawBossBar(state, S);
    this._drawPrompts(state, me, S);
    this._drawToast(S);
    if (this.touch) this._drawTouchControls(S);
    if (me.state === 'downed') this._drawDowned(state, me, S);
    if (me.state === 'dead') this._drawDead(state, me, S);
  }

  _panel(x, y, w, h, alpha = 0.55) {
    const c = this.ctx;
    c.fillStyle = `rgba(10, 8, 18, ${alpha})`;
    c.fillRect(x, y, w, h);
    c.strokeStyle = 'rgba(160, 200, 255, 0.22)';
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  /* Hard-edged, segmented bar: reads instantly at a glance and
     never looks like a smooth progress bar from an app. */
  _bar(x, y, w, h, value, max, color, opts = {}) {
    const c = this.ctx;
    const t = clamp01(max > 0 ? value / max : 0);
    c.fillStyle = 'rgba(0,0,0,0.55)';
    c.fillRect(x, y, w, h);
    const fill = Math.round(w * t);
    if (fill > 0) {
      c.fillStyle = color;
      c.fillRect(x, y, fill, h);
      c.fillStyle = 'rgba(255,255,255,0.28)';
      c.fillRect(x, y, fill, Math.max(1, h * 0.3));
    }
    if (opts.ghost !== undefined && opts.ghost > t) {
      c.fillStyle = 'rgba(255,255,255,0.20)';
      c.fillRect(x + fill, y, Math.round(w * (opts.ghost - t)), h);
    }
    /* Tick marks every `seg` units of max. */
    if (opts.seg) {
      c.fillStyle = 'rgba(0,0,0,0.45)';
      for (let v = opts.seg; v < max; v += opts.seg) {
        c.fillRect(x + Math.round(w * (v / max)), y, 1, h);
      }
    }
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  }

  _text(str, x, y, size, color, align = 'left', weight = 'bold') {
    const c = this.ctx;
    c.font = `${weight} ${Math.round(size)}px ${FONT}`;
    c.textAlign = align;
    c.fillStyle = 'rgba(0,0,0,0.75)';
    c.fillText(str, x + 1, y + 1);
    c.fillStyle = color;
    c.fillText(str, x, y);
  }

  _drawVitals(state, me, S) {
    const c = this.ctx;
    const pad = 14 * S;
    const w = 232 * S, h = 12 * S;
    const x = pad, y = this.h - pad - (h * 4 + 22 * S);

    this._panel(x - 6 * S, y - 20 * S, w + 12 * S, h * 4 + 44 * S, 0.45);

    this._text(me.name, x, y - 10 * S, 12 * S, '#cfe4ff');
    this._text('LV ' + me.level, x + w, y - 10 * S, 12 * S, '#ffe45e', 'right');

    this._bar(x, y, w, h, me.hp, me.maxHp, '#e0463c');
    this._text(`${Math.ceil(me.hp)}/${me.maxHp}`, x + w / 2, y + h / 2, 9 * S, '#ffffff', 'center');

    this._bar(x, y + h + 3 * S, w, h * 0.6, me.shield, me.shieldMax, '#3fe0ff');
    this._bar(x, y + h * 1.6 + 6 * S, w, h * 0.7, me.energy, me.maxEnergy, '#b07bff');

    /* Core charge: the one that kills you slowly if you ignore it. */
    const chargeLow = me.charge / me.chargeMax < 0.25;
    const chargeCol = chargeLow ? (Math.sin(this.time * 9) > 0 ? '#ff4f4f' : '#ffb03a') : '#ffb03a';
    this._bar(x, y + h * 2.3 + 9 * S, w, h * 0.7, me.charge, me.chargeMax, chargeCol);
    this._text('CORE', x - 2 * S, y + h * 2.3 + 9 * S + h * 0.35, 8 * S, '#ffd9a0', 'right');

    /* Experience, thin, right under everything. */
    const xy = y + h * 3.1 + 12 * S;
    this._bar(x, xy, w, 4 * S, me.xp, me.xpNext, '#ffe45e');

    if (me.skillPoints > 0) {
      const t = 0.5 + 0.5 * Math.sin(this.time * 5);
      this._text(`[TAB] ${me.skillPoints} SKILL POINT${me.skillPoints > 1 ? 'S' : ''}`,
        x, xy + 16 * S, 11 * S, `rgba(255, 228, 94, ${0.55 + t * 0.45})`);
    }
  }

  _drawAbilities(state, me, S) {
    const c = this.ctx;
    const size = 44 * S;
    const gap = 8 * S;
    const slots = ['dash', ...me.abilities];
    const keys = ['SPC', 'Q', 'E', 'R', 'F'];
    const total = slots.length * size + (slots.length - 1) * gap;
    const x0 = this.w / 2 - total / 2;
    const y = this.h - 14 * S - size;

    for (let i = 0; i < slots.length; i++) {
      const x = x0 + i * (size + gap);
      const id = slots[i];
      const isDash = id === 'dash';
      const def = isDash ? null : ABILITIES[id];
      const ready = isDash ? me.dashCharges > 0
        : def ? (me.cooldowns[id] || 0) <= 0 && me.energy >= def.cost : false;

      c.fillStyle = 'rgba(8, 6, 16, 0.78)';
      c.fillRect(x, y, size, size);

      if (def || isDash) {
        const col = isDash ? '#c8f0ff' : '#' + def.color.toString(16).padStart(6, '0');
        c.strokeStyle = ready ? col : 'rgba(120,130,150,0.5)';
        c.lineWidth = 2 * S;
        c.strokeRect(x + 1, y + 1, size - 2, size - 2);
        this._text(isDash ? '»' : def.icon, x + size / 2, y + size / 2 - 2 * S,
          22 * S, ready ? col : 'rgba(150,160,180,0.55)', 'center');

        /* Cooldown sweep. */
        const cd = isDash ? (me.dashCharges > 0 ? 0 : me.dashCd / 1.15)
          : (def ? (me.cooldowns[id] || 0) / Math.max(0.01, def.cd) : 0);
        if (cd > 0) {
          c.fillStyle = 'rgba(4, 2, 10, 0.72)';
          c.fillRect(x, y, size, size * clamp01(cd));
        }
        if (!isDash && def.cost > 0) {
          this._text(String(def.cost), x + size - 3 * S, y + size - 7 * S, 9 * S,
            me.energy >= def.cost ? '#b07bff' : '#ff6b6b', 'right');
        }
        if (isDash && me.dashMax > 1) {
          this._text(`${me.dashCharges}/${me.dashMax}`, x + size - 3 * S, y + size - 7 * S, 9 * S, '#c8f0ff', 'right');
        }
      } else {
        c.strokeStyle = 'rgba(90,100,120,0.35)';
        c.lineWidth = 1;
        c.strokeRect(x + 1, y + 1, size - 2, size - 2);
        this._text('—', x + size / 2, y + size / 2, 16 * S, 'rgba(120,130,150,0.4)', 'center');
      }
      this._text(keys[i], x + 3 * S, y + 8 * S, 9 * S, 'rgba(200,215,240,0.75)');
      if (this.touch && i > 0) this.buttons.push({ name: 'ability' + i, x, y, w: size, h: size });
    }
    if (this.touch) {
      this.buttons.push({ name: 'dash', x: x0, y, w: size, h: size });
    }
  }

  _drawTopBar(state, S) {
    const c = this.ctx;
    const sim = state.sim;
    const pad = 14 * S;

    /* Night counter and the clock to the next change. */
    const w = 216 * S, h = 46 * S;
    this._panel(pad, pad, w, h, 0.5);
    const night = sim.isNight;
    const label = night ? `NIGHT ${sim.night}` : (sim.night === 0 ? 'DAY ONE' : `DAY ${sim.night + 1}`);
    this._text(label, pad + 10 * S, pad + 15 * S, 14 * S, night ? '#c79bff' : '#ffd98a');
    this._text(formatTime(sim.timeToPhaseChange), pad + w - 10 * S, pad + 15 * S, 14 * S,
      night ? '#ff8ae0' : '#ffe45e', 'right');
    this._bar(pad + 10 * S, pad + 26 * S, w - 20 * S, 6 * S,
      1 - sim.timeToPhaseChange / (night ? 82 : 108), 1, night ? '#8b5cf0' : '#ffb03a');
    if (night) {
      this._text(`${sim.wave.alive} HOSTILE${sim.wave.alive === 1 ? '' : 'S'}`,
        pad + 10 * S, pad + 38 * S, 10 * S, '#ff9f9f');
    }

    /* Beacon integrity. */
    const by = pad + h + 6 * S;
    const bw = 216 * S;
    this._panel(pad, by, bw, 30 * S, 0.5);
    this._text('BEACON', pad + 10 * S, by + 10 * S, 11 * S, '#9fd8ff');
    const bhp = sim.beacon.hp / sim.beacon.maxHp;
    this._text(`${Math.round(bhp * 100)}%`, pad + bw - 10 * S, by + 10 * S, 11 * S,
      bhp > 0.5 ? '#63ff9d' : bhp > 0.25 ? '#ffb03a' : '#ff4f4f', 'right');
    this._bar(pad + 10 * S, by + 18 * S, bw - 20 * S, 6 * S, sim.beacon.hp, sim.beacon.maxHp,
      bhp > 0.5 ? '#3fe0ff' : bhp > 0.25 ? '#ffb03a' : '#ff4f4f');

    /* Resources. */
    const ry = by + 36 * S;
    const res = state.me.res;
    const items = [['⛭', res.scrap, '#ffb03a', 'SCRAP'], ['✧', res.essence, '#b07bff', 'ESSENCE'], ['◆', res.cores, '#ff4fd8', 'CORES']];
    let rx = pad;
    for (const [icon, val, col] of items) {
      const iw = 68 * S;
      this._panel(rx, ry, iw, 22 * S, 0.5);
      this._text(icon, rx + 7 * S, ry + 11 * S, 12 * S, col);
      this._text(String(val), rx + iw - 7 * S, ry + 11 * S, 12 * S, '#ffffff', 'right');
      rx += iw + 4 * S;
    }
  }

  _drawMinimap(state, S) {
    const c = this.ctx;
    const size = 132 * S;
    const pad = 14 * S;
    const x = this.w - pad - size, y = pad;
    const sim = state.sim, world = sim.world;
    const half = (world.size * 1) / 2;

    c.fillStyle = 'rgba(6, 5, 12, 0.72)';
    c.fillRect(x, y, size, size);

    const map = (wx, wz) => ({
      x: x + ((wx + half) / (half * 2)) * size,
      y: y + ((wz + half) / (half * 2)) * size,
    });

    /* Landmarks first, so live things draw over them. */
    for (const lm of world.landmarks) {
      const p = map(lm.x, lm.z);
      if (lm.kind === 'beacon') { c.fillStyle = '#7ee8ff'; c.fillRect(p.x - 3 * S, p.y - 3 * S, 6 * S, 6 * S); }
      else if (lm.kind === 'rift') { c.fillStyle = '#ff4fd8'; c.fillRect(p.x - 2 * S, p.y - 2 * S, 4 * S, 4 * S); }
      else if (lm.kind === 'shrine') { c.fillStyle = '#63ff9d'; c.fillRect(p.x - 1.5 * S, p.y - 1.5 * S, 3 * S, 3 * S); }
      else if (lm.kind === 'cache') { c.fillStyle = '#ffb03a'; c.fillRect(p.x - 1.5 * S, p.y - 1.5 * S, 3 * S, 3 * S); }
      else { c.fillStyle = 'rgba(180,190,210,0.5)'; c.fillRect(p.x - 1 * S, p.y - 1 * S, 2 * S, 2 * S); }
    }

    c.fillStyle = 'rgba(255, 90, 90, 0.9)';
    for (const e of sim.enemies) {
      const p = map(e.x, e.z);
      const s = e.boss ? 4 * S : e.elite ? 3 * S : 1.6 * S;
      c.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }

    let i = 0;
    for (const pl of sim.players.values()) {
      const p = map(pl.x, pl.z);
      const col = PLAYER_COLORS[pl.colorIndex !== undefined ? pl.colorIndex : i % 4];
      c.fillStyle = pl.id === state.localId ? '#ffffff' : '#' + col.body.toString(16).padStart(6, '0');
      c.fillRect(p.x - 2 * S, p.y - 2 * S, 4 * S, 4 * S);
      i++;
    }

    c.strokeStyle = 'rgba(160, 200, 255, 0.28)';
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    this._text('[M]', x + size - 4 * S, y + size + 9 * S, 9 * S, 'rgba(180,200,230,0.6)', 'right');
  }

  _drawKillFeed(S) {
    const x = this.w - 14 * S;
    let y = 176 * S;
    for (const k of this.killFeed) {
      const a = clamp01(k.life / 1.2);
      this.ctx.globalAlpha = a;
      this._text(k.text, x, y, 11 * S, k.color, 'right');
      this.ctx.globalAlpha = 1;
      y += 15 * S;
    }
  }

  _drawParty(state, S) {
    const sim = state.sim;
    if (sim.players.size <= 1) return;
    let y = this.h * 0.5 - (sim.players.size - 1) * 18 * S;
    let i = 0;
    for (const p of sim.players.values()) {
      if (p.id === state.localId) { i++; continue; }
      const col = PLAYER_COLORS[i % 4];
      const w = 118 * S;
      const x = 14 * S;
      this._panel(x, y, w, 30 * S, 0.45);
      this._text(p.name, x + 6 * S, y + 9 * S, 10 * S, '#' + col.trim.toString(16).padStart(6, '0'));
      const status = p.state === 'downed' ? 'DOWN' : p.state === 'dead' ? 'DEAD' : 'LV' + p.level;
      this._text(status, x + w - 6 * S, y + 9 * S, 10 * S,
        p.state === 'alive' ? '#cfe4ff' : '#ff6b6b', 'right');
      this._bar(x + 6 * S, y + 18 * S, w - 12 * S, 5 * S, p.hp, p.maxHp,
        p.state === 'alive' ? '#e0463c' : '#7a3a3a');
      y += 36 * S;
      i++;
    }
  }

  _drawBossBar(state, S) {
    const boss = state.sim.enemies.find(e => e.boss);
    if (!boss) return;
    const w = 420 * S, h = 16 * S;
    const x = this.w / 2 - w / 2, y = 20 * S;
    this._text(ENEMIES[boss.type].name.toUpperCase(), this.w / 2, y - 8 * S, 14 * S, '#ff8ae0', 'center');
    this._bar(x, y, w, h, boss.hp, boss.maxHp, '#ff4fd8', { seg: boss.maxHp / 6 });
  }

  _drawPrompts(state, me, S) {
    if (!me.interactTarget) return;
    const kind = me.interactTarget.kind;
    const label = kind === 'beacon' ? 'HOLD [G] — BEACON CONSOLE'
      : kind === 'shrine' ? 'HOLD [G] — TOUCH THE SHRINE'
      : 'HOLD [G] — PRY OPEN THE CACHE';
    const y = this.h - 96 * S;
    this._text(label, this.w / 2, y, 13 * S, '#ffe45e', 'center');
    if (me.interactProgress > 0) {
      const w = 160 * S;
      this._bar(this.w / 2 - w / 2, y + 12 * S, w, 5 * S, me.interactProgress, 1, '#ffe45e');
    }
  }

  _drawFloaters(state, S) {
    const c = this.ctx;
    for (const f of state.fx.floaters) {
      const p = state.project(f.x, f.y, f.z);
      if (!p.visible) continue;
      const a = clamp01(f.life / f.maxLife);
      c.globalAlpha = a;
      const size = (f.crit ? 20 : 14) * f.size * S * (0.8 + a * 0.35);
      this._text(f.text, p.x, p.y, size, f.color, 'center');
      c.globalAlpha = 1;
    }
  }

  /* Nameplates, enemy health and the world-space markers that keep
     you oriented: ally arrows, objective pings. */
  _drawWorldMarkers(state, S) {
    const c = this.ctx;
    const sim = state.sim;

    for (const e of sim.enemies) {
      if (e.hp >= e.maxHp && !e.boss) continue;
      if (e.boss) continue;
      const p = state.project(e.x, e.y + e.def.height + 0.35, e.z);
      if (!p.visible) continue;
      const w = (e.elite ? 34 : 24) * S;
      this._bar(p.x - w / 2, p.y, w, 3.5 * S, e.hp, e.maxHp, e.elite ? '#ffb03a' : '#ff5a5a');
      if (e.elite) this._text('ELITE', p.x, p.y - 7 * S, 8 * S, '#ffb03a', 'center');
    }

    let i = 0;
    for (const pl of sim.players.values()) {
      if (pl.id === state.localId) { i++; continue; }
      const p = state.project(pl.x, pl.y + 2.0, pl.z);
      const col = PLAYER_COLORS[i % 4];
      if (p.visible) {
        this._text(pl.name, p.x, p.y, 10 * S, '#' + col.trim.toString(16).padStart(6, '0'), 'center');
        if (pl.state === 'downed') {
          this._text('DOWNED — HOLD [G]', p.x, p.y + 12 * S, 10 * S, '#ff6b6b', 'center');
          const w = 44 * S;
          this._bar(p.x - w / 2, p.y + 20 * S, w, 4 * S, pl.reviveProgress, 1, '#63ff9d');
        }
      } else {
        /* Off-screen: put an arrow on the edge so you can find them. */
        this._edgeArrow(pl.x, pl.z, state, '#' + col.trim.toString(16).padStart(6, '0'), S);
      }
      i++;
    }
  }

  _edgeArrow(wx, wz, state, color, S) {
    const c = this.ctx;
    const me = state.me;
    const dx = wx - me.x, dz = wz - me.z;
    /* Screen direction, approximated from the camera basis. */
    const p = state.project(wx, me.y + 1, wz);
    let ang = Math.atan2(p.y - this.h / 2, p.x - this.w / 2);
    if (!p.behind && p.visible) return;
    if (p.behind) ang += Math.PI;
    const m = Math.min(this.w, this.h) * 0.40;
    const x = this.w / 2 + Math.cos(ang) * m;
    const y = this.h / 2 + Math.sin(ang) * m;
    c.save();
    c.translate(x, y);
    c.rotate(ang);
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(8 * S, 0); c.lineTo(-6 * S, -5 * S); c.lineTo(-6 * S, 5 * S);
    c.closePath(); c.fill();
    c.restore();
  }

  _drawDowned(state, me, S) {
    const c = this.ctx;
    c.fillStyle = 'rgba(80, 0, 0, 0.22)';
    c.fillRect(0, 0, this.w, this.h);
    this._text('YOU ARE DOWN', this.w / 2, this.h * 0.38, 30 * S, '#ff6b6b', 'center');
    this._text(`BLEEDING OUT — ${me.downTimer.toFixed(0)}s`, this.w / 2, this.h * 0.38 + 26 * S, 14 * S, '#ffb0b0', 'center');
    if (me.reviveProgress > 0) {
      const w = 220 * S;
      this._bar(this.w / 2 - w / 2, this.h * 0.38 + 44 * S, w, 8 * S, me.reviveProgress, 1, '#63ff9d');
    }
  }

  _drawDead(state, me, S) {
    const c = this.ctx;
    this._text('RECONSTITUTING', this.w / 2, this.h * 0.42, 26 * S, '#9fd8ff', 'center');
    this._text(`${Math.ceil(me.respawnTimer)}`, this.w / 2, this.h * 0.42 + 34 * S, 40 * S, '#ffffff', 'center');
  }

  _drawToast(S) {
    if (this.toastTime <= 0 || !this.toast) return;
    const a = clamp01(this.toastTime);
    this.ctx.globalAlpha = Math.min(1, a * 2);
    this._text(this.toast.text, this.w / 2, this.h * 0.26, 24 * S, this.toast.color, 'center');
    this.ctx.globalAlpha = 1;
  }

  /* On-screen stick ring and buttons; the Input module reads the
     hit areas we register here. */
  _drawTouchControls(S) {
    const c = this.ctx;
    const r = 52 * S;
    const x = 90 * S, y = this.h - 90 * S;
    c.strokeStyle = 'rgba(200, 225, 255, 0.20)';
    c.lineWidth = 2 * S;
    c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.stroke();
    c.beginPath(); c.arc(x, y, r * 0.42, 0, Math.PI * 2); c.stroke();
  }

  hitTest(x, y) {
    for (const b of this.buttons) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.name;
    }
    return null;
  }
}
