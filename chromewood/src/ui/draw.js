/* ============================================================
   draw.js - the pieces every panel is made of

   One place for the frame, the bar and the slot, so the whole
   interface is plainly the same object: a riveted plate with a
   bevel, a hard shadow and no rounded corners anywhere.
   ============================================================ */

import { drawText, textWidth, lineHeight, clipText } from './font.js';
import { drawIcon } from './icons.js';

export const PAL = {
  ink: '#0a0812',
  plate: 'rgba(22, 19, 34, 0.90)',
  plateLit: 'rgba(34, 29, 52, 0.94)',
  bevel: '#4a4262',
  bevelLit: '#6f6394',
  edge: '#141021',
  text: '#d9e2f0',
  dim: '#8b93a8',
  faint: '#5c6274',
  hp: '#d8453c',
  stam: '#9fd84a',
  food: '#e08a3a',
  warm: '#4fc9e0',
  mana: '#a06fe8',
  xp: '#ffd24a',
  good: '#63ff9d',
  warn: '#ffb03a',
  bad: '#ff5a5a',
  arcane: '#b07bff',
  chrome: '#3fe0ff',
  wild: '#63ff9d',
};

export function px(v) { return Math.round(v); }

/* A machined plate: hard shadow, dark fill, bevelled edge, and a
   notch cut out of two corners so it never reads as a CSS box. */
export function frame(ctx, x, y, w, h, opts = {}) {
  const { lit = false, notch = 4, fill = null, shadow = true } = opts;
  x = px(x); y = px(y); w = px(w); h = px(h);
  if (shadow) {
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fillRect(x + 2, y + 2, w, h);
  }
  ctx.fillStyle = fill || (lit ? PAL.plateLit : PAL.plate);
  ctx.beginPath();
  ctx.moveTo(x + notch, y);
  ctx.lineTo(x + w, y);
  ctx.lineTo(x + w, y + h - notch);
  ctx.lineTo(x + w - notch, y + h);
  ctx.lineTo(x, y + h);
  ctx.lineTo(x, y + notch);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = lit ? PAL.bevelLit : PAL.bevel;
  ctx.lineWidth = 1;
  ctx.stroke();
  /* A lighter top edge is the whole bevel. */
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(x + notch, y + 1, w - notch - 1, 1);
}

/* Segmented bar. The segments are what make it readable at a
   glance: you count blocks, you do not estimate a fraction. */
export function bar(ctx, x, y, w, h, value, max, color, opts = {}) {
  const { seg = 0, ghost = null, label = null, scale = 1, back = 'rgba(0,0,0,0.55)' } = opts;
  x = px(x); y = px(y); w = px(w); h = px(h);
  const t = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
  ctx.fillStyle = back;
  ctx.fillRect(x, y, w, h);
  if (ghost !== null && ghost > t) {
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(x, y, px(w * ghost), h);
  }
  const fill = px(w * t);
  if (fill > 0) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, fill, h);
    ctx.fillStyle = 'rgba(255,255,255,0.30)';
    ctx.fillRect(x, y, fill, 1);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x, y + h - 1, fill, 1);
  }
  if (seg > 1) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    for (let i = 1; i < seg; i++) ctx.fillRect(x + px((w / seg) * i), y, 1, h);
  }
  ctx.strokeStyle = PAL.edge;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  if (label) drawText(ctx, label, x + w / 2, y + h / 2, { scale, align: 'center', baseline: 'middle', color: '#fff' });
}

/* An item slot: frame, icon, stack count, and a key hint. */
export function slot(ctx, x, y, size, opts = {}) {
  const { selected = false, item = null, count = 0, key = null, tint = 0x9a8f7a,
    scale = 1, disabled = false, cooldown = 0, accent } = opts;
  frame(ctx, x, y, size, size, { lit: selected, notch: 3, shadow: false });
  if (selected) {
    ctx.strokeStyle = PAL.text;
    ctx.lineWidth = 1;
    ctx.strokeRect(px(x) - 1.5, px(y) - 1.5, px(size) + 2, px(size) + 2);
  }
  if (item) {
    const iconSize = Math.floor((size - 6) / 9) * 9;
    ctx.globalAlpha = disabled ? 0.38 : 1;
    drawIcon(ctx, item, x + (size - iconSize) / 2, y + (size - iconSize) / 2 - 1, iconSize, tint, accent);
    ctx.globalAlpha = 1;
  }
  if (cooldown > 0) {
    ctx.fillStyle = 'rgba(6,4,14,0.72)';
    ctx.fillRect(px(x), px(y), px(size), px(size * Math.min(1, cooldown)));
  }
  if (count > 1) {
    drawText(ctx, String(count), x + size - 2, y + size - 7 * scale - 1,
      { scale, align: 'right', color: PAL.text });
  }
  if (key) drawText(ctx, key, x + 2, y + 2, { scale, color: PAL.dim });
}

/* A labelled button that reports whether the pointer is over it;
   panels collect these into their hit list. */
export function button(ctx, x, y, w, h, label, opts = {}) {
  const { hover = false, active = false, disabled = false, scale = 1, color = PAL.text } = opts;
  frame(ctx, x, y, w, h, { lit: hover || active, notch: 3, shadow: false });
  drawText(ctx, label, x + w / 2, y + h / 2, {
    scale, align: 'center', baseline: 'middle',
    color: disabled ? PAL.faint : (hover ? '#ffffff' : color),
  });
}

/* Rivets, purely because a plate without them looks printed. */
export function rivets(ctx, x, y, w, h, inset = 4) {
  ctx.fillStyle = 'rgba(255,255,255,0.14)';
  for (const [rx, ry] of [[inset, inset], [w - inset - 1, inset],
    [inset, h - inset - 1], [w - inset - 1, h - inset - 1]]) {
    ctx.fillRect(px(x + rx), px(y + ry), 1, 1);
  }
}

export function divider(ctx, x, y, w) {
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  ctx.fillRect(px(x), px(y), px(w), 1);
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(px(x), px(y) + 1, px(w), 1);
}

export { drawText, textWidth, lineHeight, clipText, drawIcon };
