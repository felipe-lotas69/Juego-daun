/* ============================================================
   geom.js - a tiny procedural mesh builder

   There is no art budget here, so every object in the world is
   assembled from boxes, prisms and cones with the colour baked
   into the vertices. Faces get a slight per-direction tint, which
   is what gives flat-shaded blocks that carved, chunky look once
   the toon ramp quantises them.

   Everything accumulates into plain arrays; `build()` hands back
   a BufferGeometry, so a whole terrain chunk with its trees and
   rocks ends up as one draw call.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { TEX } from './textures.js';

/* Per-face multipliers. Top faces catch the sky, the two visible
   side directions differ so cliffs read as solid volumes. */
const FACE_TINT = {
  py: 1.00,   /* up     */
  ny: 0.55,   /* down   */
  px: 0.86,
  nx: 0.72,
  pz: 0.92,
  nz: 0.66,
};

const tmpColor = new THREE.Color();

/* Texture repeats per world unit. Below the screen-pixel density at
   normal zoom, so texels land on whole pixels instead of shimmering. */
export const UV_SCALE = 0.5;

export class MeshBuilder {
  constructor() {
    this.pos = [];
    this.norm = [];
    this.col = [];
    this.uv = [];
    this.cell = [];
    this.index = [];
    this.vertCount = 0;
    /* Which atlas cell the next shape writes. Shapes override it
       per face through their options. */
    this.texture = TEX.FLAT;
    /* A transform stack keeps the shape functions readable: they
       all build around the origin and get placed afterwards. */
    this.tx = 0; this.ty = 0; this.tz = 0;
    this.ry = 0;
    this.scale = 1;
  }

  reset() {
    this.pos.length = 0; this.norm.length = 0; this.col.length = 0;
    this.uv.length = 0; this.cell.length = 0; this.index.length = 0; this.vertCount = 0;
    this.texture = TEX.FLAT;
    this.tx = this.ty = this.tz = 0; this.ry = 0; this.scale = 1;
    return this;
  }

  at(x, y, z) { this.tx = x; this.ty = y; this.tz = z; return this; }
  tex(cell) { this.texture = cell; return this; }
  rot(ry) { this.ry = ry; return this; }
  sc(s) { this.scale = s; return this; }

  _push(x, y, z, nx, ny, nz, r, g, b, u, v) {
    const s = this.scale;
    x *= s; y *= s; z *= s;
    if (this.ry !== 0) {
      const c = Math.cos(this.ry), si = Math.sin(this.ry);
      const rx = x * c - z * si, rz = x * si + z * c;
      x = rx; z = rz;
      const rnx = nx * c - nz * si, rnz = nx * si + nz * c;
      nx = rnx; nz = rnz;
    }
    this.pos.push(x + this.tx, y + this.ty, z + this.tz);
    this.norm.push(nx, ny, nz);
    this.col.push(r, g, b);
    this.uv.push(u, v);
    this.cell.push(this._faceTex === undefined ? this.texture : this._faceTex);
    return this.vertCount++;
  }

  _quad(verts) {
    const [a, b, c, d] = verts;
    this.index.push(a, b, c, a, c, d);
  }

  /* ---------------------------------------------------------- shapes */

  /* Axis-aligned box centred on x/z, sitting with its base at y=0
     unless `centered` is set. `faces` can drop hidden sides. */
  box(w, h, d, color, opts = {}) {
    const { centered = false, tint = 1, faces = null, topColor = null, yOff = 0 } = opts;
    const hw = w / 2, hd = d / 2;
    const y0 = (centered ? -h / 2 : 0) + yOff;
    const y1 = y0 + h;
    tmpColor.set(color);
    const base = [tmpColor.r, tmpColor.g, tmpColor.b];
    let top = base;
    if (topColor !== null) { tmpColor.set(topColor); top = [tmpColor.r, tmpColor.g, tmpColor.b]; }

    const face = (key, normal, corners, cols) => {
      if (faces && faces[key] === false) return;
      this._faceTex = (key === 'py' && opts.topTex !== undefined) ? opts.topTex
        : (opts.tex !== undefined ? opts.tex : undefined);
      const t = FACE_TINT[key] * tint;
      const [r, g, b] = cols;
      const idx = corners.map(([x, y, z, u, v]) =>
        this._push(x, y, z, normal[0], normal[1], normal[2], r * t, g * t, b * t, u, v));
      this._quad(idx);
      this._faceTex = undefined;
    };

    face('py', [0, 1, 0], [[-hw, y1, -hd, 0, 0], [-hw, y1, hd, 0, 1], [hw, y1, hd, 1, 1], [hw, y1, -hd, 1, 0]], top);
    face('ny', [0, -1, 0], [[-hw, y0, -hd, 0, 0], [hw, y0, -hd, 1, 0], [hw, y0, hd, 1, 1], [-hw, y0, hd, 0, 1]], base);
    face('pz', [0, 0, 1], [[-hw, y0, hd, 0, 0], [hw, y0, hd, 1, 0], [hw, y1, hd, 1, 1], [-hw, y1, hd, 0, 1]], base);
    face('nz', [0, 0, -1], [[hw, y0, -hd, 0, 0], [-hw, y0, -hd, 1, 0], [-hw, y1, -hd, 1, 1], [hw, y1, -hd, 0, 1]], base);
    face('px', [1, 0, 0], [[hw, y0, hd, 0, 0], [hw, y0, -hd, 1, 0], [hw, y1, -hd, 1, 1], [hw, y1, hd, 0, 1]], base);
    face('nx', [-1, 0, 0], [[-hw, y0, -hd, 0, 0], [-hw, y0, hd, 1, 0], [-hw, y1, hd, 1, 1], [-hw, y1, -hd, 0, 1]], base);
    return this;
  }

  /* Tapered box: a box whose top face is scaled. Trunks, rocks and
     cliff blocks all use this to avoid looking like crates. */
  taper(w, h, d, topScale, color, opts = {}) {
    const { tint = 1, topColor = null, yOff = 0, twist = 0 } = opts;
    if (opts.tex !== undefined) this._faceTex = opts.tex;
    const hw = w / 2, hd = d / 2;
    const tw = hw * topScale, td = hd * topScale;
    const y0 = yOff, y1 = yOff + h;
    tmpColor.set(color);
    const base = [tmpColor.r, tmpColor.g, tmpColor.b];
    let top = base;
    if (topColor !== null) { tmpColor.set(topColor); top = [tmpColor.r, tmpColor.g, tmpColor.b]; }

    const c = Math.cos(twist), s = Math.sin(twist);
    const rt = (x, z) => [x * c - z * s, z * c + x * s];

    const bottom = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
    const topPts = [[-tw, -td], [tw, -td], [tw, td], [-tw, td]].map(([x, z]) => rt(x, z));

    /* top cap */
    {
      const t = FACE_TINT.py * tint;
      const idx = topPts.map(([x, z], i) => this._push(x, y1, z, 0, 1, 0, top[0] * t, top[1] * t, top[2] * t, i & 1, i >> 1));
      this._quad([idx[0], idx[3], idx[2], idx[1]]);
    }
    /* sides */
    const sideKeys = ['nz', 'px', 'pz', 'nx'];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      const [bx0, bz0] = bottom[i], [bx1, bz1] = bottom[j];
      const [tx0, tz0] = topPts[i], [tx1, tz1] = topPts[j];
      const nx = (bz1 - bz0), nz = -(bx1 - bx0);
      const nl = Math.hypot(nx, nz) || 1;
      const t = FACE_TINT[sideKeys[i]] * tint;
      const r = base[0] * t, g = base[1] * t, b = base[2] * t;
      const a = this._push(bx0, y0, bz0, nx / nl, 0.2, nz / nl, r, g, b, 0, 0);
      const bb = this._push(bx1, y0, bz1, nx / nl, 0.2, nz / nl, r, g, b, 1, 0);
      const cc = this._push(tx1, y1, tz1, nx / nl, 0.2, nz / nl, r * 1.06, g * 1.06, b * 1.06, 1, 1);
      const dd = this._push(tx0, y1, tz0, nx / nl, 0.2, nz / nl, r * 1.06, g * 1.06, b * 1.06, 0, 1);
      /* Wound so the outward-facing side is the front face: the
         ring of corners runs counter-clockwise in XZ, which puts
         the naive triangle order on the inside of the shape. */
      this._quad([dd, cc, bb, a]);
    }
    this._faceTex = undefined;
    return this;
  }

  /* Low-poly cone: tree canopies, spikes, hats. */
  cone(radius, h, segments, color, opts = {}) {
    const { yOff = 0, tint = 1, topColor = null, flatten = 1 } = opts;
    if (opts.tex !== undefined) this._faceTex = opts.tex;
    tmpColor.set(color);
    const r0 = tmpColor.r, g0 = tmpColor.g, b0 = tmpColor.b;
    let tr = r0, tg = g0, tb = b0;
    if (topColor !== null) { tmpColor.set(topColor); tr = tmpColor.r; tg = tmpColor.g; tb = tmpColor.b; }
    for (let i = 0; i < segments; i++) {
      const a0 = (i / segments) * Math.PI * 2;
      const a1 = ((i + 1) / segments) * Math.PI * 2;
      const x0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius * flatten;
      const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius * flatten;
      const mx = (x0 + x1) * 0.5, mz = (z0 + z1) * 0.5;
      const nl = Math.hypot(mx, mz) || 1;
      /* Facing tint from the side normal keeps flat shading lively. */
      const face = 0.74 + 0.26 * (0.5 + 0.5 * (-mz / nl));
      const t = tint * face;
      const a = this._push(x0, yOff, z0, mx / nl, 0.45, mz / nl, r0 * t, g0 * t, b0 * t, 0, 0);
      const b = this._push(x1, yOff, z1, mx / nl, 0.45, mz / nl, r0 * t, g0 * t, b0 * t, 1, 0);
      const c = this._push(0, yOff + h, 0, mx / nl, 0.8, mz / nl, tr * t * 1.12, tg * t * 1.12, tb * t * 1.12, 0.5, 1);
      this.index.push(b, a, c);
      /* bottom fan */
      const d = this._push(x1, yOff, z1, 0, -1, 0, r0 * 0.45, g0 * 0.45, b0 * 0.45, 0, 0);
      const e = this._push(x0, yOff, z0, 0, -1, 0, r0 * 0.45, g0 * 0.45, b0 * 0.45, 1, 0);
      const f = this._push(0, yOff, 0, 0, -1, 0, r0 * 0.45, g0 * 0.45, b0 * 0.45, 0.5, 1);
      this.index.push(e, d, f);
    }
    this._faceTex = undefined;
    return this;
  }

  /* Prismatic crystal: a tapered shaft with a pointed cap. */
  crystal(radius, h, color, opts = {}) {
    const { yOff = 0, tilt = 0, sides = 5, tipColor = null } = opts;
    if (opts.tex !== undefined) this._faceTex = opts.tex;
    tmpColor.set(color);
    const r0 = tmpColor.r, g0 = tmpColor.g, b0 = tmpColor.b;
    let tr = r0 * 1.5, tg = g0 * 1.5, tb = b0 * 1.5;
    if (tipColor !== null) { tmpColor.set(tipColor); tr = tmpColor.r; tg = tmpColor.g; tb = tmpColor.b; }
    const shoulder = h * 0.62;
    const lean = Math.tan(tilt);
    for (let i = 0; i < sides; i++) {
      const a0 = (i / sides) * Math.PI * 2, a1 = ((i + 1) / sides) * Math.PI * 2;
      const x0 = Math.cos(a0) * radius, z0 = Math.sin(a0) * radius;
      const x1 = Math.cos(a1) * radius, z1 = Math.sin(a1) * radius;
      const mx = (x0 + x1) * 0.5, mz = (z0 + z1) * 0.5;
      const nl = Math.hypot(mx, mz) || 1;
      const face = 0.55 + 0.45 * (0.5 + 0.5 * (mx / nl - mz / nl) * 0.7071);
      const r = r0 * face, g = g0 * face, b = b0 * face;
      const sx = shoulder * lean;
      const a = this._push(x0, yOff, z0, mx / nl, 0, mz / nl, r * 0.8, g * 0.8, b * 0.8, 0, 0);
      const bq = this._push(x1, yOff, z1, mx / nl, 0, mz / nl, r * 0.8, g * 0.8, b * 0.8, 1, 0);
      const c = this._push(x1 * 0.82 + sx, yOff + shoulder, z1 * 0.82, mx / nl, 0.1, mz / nl, r, g, b, 1, 1);
      const d = this._push(x0 * 0.82 + sx, yOff + shoulder, z0 * 0.82, mx / nl, 0.1, mz / nl, r, g, b, 0, 1);
      this._quad([d, c, bq, a]);
      const e = this._push(x0 * 0.82 + sx, yOff + shoulder, z0 * 0.82, mx / nl, 0.4, mz / nl, r, g, b, 0, 0);
      const f = this._push(x1 * 0.82 + sx, yOff + shoulder, z1 * 0.82, mx / nl, 0.4, mz / nl, r, g, b, 1, 0);
      const gI = this._push(h * lean, yOff + h, 0, mx / nl, 0.8, mz / nl, tr, tg, tb, 0.5, 1);
      this.index.push(f, e, gI);
    }
    this._faceTex = undefined;
    return this;
  }

  /* A flat quad lying on the ground: decals, water, glyph circles. */
  ground(w, d, color, opts = {}) {
    const { yOff = 0.02, tint = 1 } = opts;
    if (opts.tex !== undefined) this._faceTex = opts.tex;
    tmpColor.set(color);
    const r = tmpColor.r * tint, g = tmpColor.g * tint, b = tmpColor.b * tint;
    const hw = w / 2, hd = d / 2;
    const a = this._push(-hw, yOff, -hd, 0, 1, 0, r, g, b, 0, 0);
    const bq = this._push(-hw, yOff, hd, 0, 1, 0, r, g, b, 0, 1);
    const c = this._push(hw, yOff, hd, 0, 1, 0, r, g, b, 1, 1);
    const d2 = this._push(hw, yOff, -hd, 0, 1, 0, r, g, b, 1, 0);
    this._quad([a, bq, c, d2]);
    this._faceTex = undefined;
    return this;
  }

  /* Two crossed upright quads: grass tufts and small foliage, cheap
     and surprisingly convincing once the outline pass hits them. */
  cross(w, h, color, opts = {}) {
    const { yOff = 0, tipColor = null } = opts;
    if (opts.tex !== undefined) this._faceTex = opts.tex;
    tmpColor.set(color);
    const r = tmpColor.r, g = tmpColor.g, b = tmpColor.b;
    let tr = r * 1.25, tg = g * 1.25, tb = b * 1.25;
    if (tipColor !== null) { tmpColor.set(tipColor); tr = tmpColor.r; tg = tmpColor.g; tb = tmpColor.b; }
    const hw = w / 2;
    for (let i = 0; i < 2; i++) {
      const ang = i * Math.PI / 2;
      const dx = Math.cos(ang) * hw, dz = Math.sin(ang) * hw;
      const nx = -Math.sin(ang), nz = Math.cos(ang);
      const a = this._push(-dx, yOff, -dz, nx, 0.3, nz, r * 0.8, g * 0.8, b * 0.8, 0, 0);
      const bq = this._push(dx, yOff, dz, nx, 0.3, nz, r * 0.8, g * 0.8, b * 0.8, 1, 0);
      const c = this._push(dx, yOff + h, dz, nx, 0.3, nz, tr, tg, tb, 1, 1);
      const d = this._push(-dx, yOff + h, -dz, nx, 0.3, nz, tr, tg, tb, 0, 1);
      this._quad([a, bq, c, d]);
      this._quad([d, c, bq, a]);
    }
    this._faceTex = undefined;
    return this;
  }

  /* Append another builder's contents, already transformed. */
  append(other) {
    const base = this.vertCount;
    for (let i = 0; i < other.pos.length; i++) this.pos.push(other.pos[i]);
    for (let i = 0; i < other.norm.length; i++) this.norm.push(other.norm[i]);
    for (let i = 0; i < other.col.length; i++) this.col.push(other.col[i]);
    for (let i = 0; i < other.uv.length; i++) this.uv.push(other.uv[i]);
    for (let i = 0; i < other.cell.length; i++) this.cell.push(other.cell[i]);
    for (let i = 0; i < other.index.length; i++) this.index.push(other.index[i] + base);
    this.vertCount += other.vertCount;
    return this;
  }

  get isEmpty() { return this.index.length === 0; }

  /* Box projection from world position and normal, so the detail
     texture tiles continuously across a whole terrain chunk instead
     of restarting at every face. Done once, on the CPU, at build
     time - it costs nothing at runtime and means no shape has to
     think about its own UVs. */
  projectUVs(scale = UV_SCALE) {
    const p = this.pos, uv = this.uv, idx = this.index;
    /* Per triangle, not per vertex. Which of the three planes a
       vertex projects onto has to be decided by the face it belongs
       to: a cone's apex leans upward while its skirt leans sideways,
       and letting them disagree tears the UVs apart inside the
       triangle, which is why textured cones came out smooth. */
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
      const bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2];
      const cx = p[c * 3], cy = p[c * 3 + 1], cz = p[c * 3 + 2];
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      const nx = Math.abs(uy * vz - uz * vy);
      const ny = Math.abs(uz * vx - ux * vz);
      const nz = Math.abs(ux * vy - uy * vx);
      let mode;
      if (ny >= nx && ny >= nz) mode = 0;        /* looking down  */
      else if (nx >= nz) mode = 1;               /* facing x      */
      else mode = 2;                             /* facing z      */
      for (const i of [a, b, c]) {
        const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
        let s1, s2;
        if (mode === 0) { s1 = x; s2 = z; }
        else if (mode === 1) { s1 = z; s2 = -y; }
        else { s1 = x; s2 = -y; }
        uv[i * 2] = s1 * scale;
        uv[i * 2 + 1] = s2 * scale;
      }
    }
    return this;
  }

  build(opts = {}) {
    if (opts.projectUVs !== false) this.projectUVs(opts.uvScale);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.norm, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('texCell', new THREE.Float32BufferAttribute(this.cell, 1));
    g.setIndex(this.vertCount > 65535
      ? new THREE.Uint32BufferAttribute(this.index, 1)
      : new THREE.Uint16BufferAttribute(this.index, 1));
    g.computeBoundingSphere();
    return g;
  }
}
