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
/* Baked per-face shading. In a world made of blocks this does more
   for readability than any light in the scene: the top, the two lit
   sides and the two shaded sides have to separate at a glance, or a
   stack of cubes reads as one flat silhouette. Widened from a 0.55
   to 1.00 spread to 0.40 to 1.00, with the two side pairs pushed
   apart, so every corner of every block is legible. */
const FACE_TINT = {
  py: 1.00,   /* up     */
  ny: 0.40,   /* down   */
  px: 0.88,   /* the sunward pair */
  pz: 0.78,
  nx: 0.62,   /* the shaded pair  */
  nz: 0.50,
};

const tmpColor = new THREE.Color();

/* Texture repeats per world unit. Below the screen-pixel density at
   normal zoom, so texels land on whole pixels instead of shimmering. */
export const UV_SCALE = 0.5;

/* One voxel unit, shared by everything the world is built out of.
   Snapping to it is most of what separates "made of blocks" from
   "made of arbitrary boxes that happen to be boxy". */
export const VOX = 1 / 8;

export function snapVox(v) { return Math.max(VOX, Math.round(v / VOX) * VOX); }

/* Blend two packed hex colours. The stepped stacks need a colour per
   step and the callers hand us plain integers. */
export function mixHex(a, b, t) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

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
  /* --------------------------------------------------- blocks */
  /* The world is built out of one voxel unit. Snapping every block
     to it is most of what separates "made of blocks" from "made of
     arbitrary boxes that happen to be boxy". */

  box(w, h, d, color, opts = {}) {
    const { centered = false, tint = 1, faces = null, topColor = null, yOff = 0,
      xOff = 0, zOff = 0 } = opts;
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

    /* A per-block nudge, used by the leaning stacks above. */
    const X = xOff, Z = zOff;
    face('py', [0, 1, 0], [[-hw + X, y1, -hd + Z, 0, 0], [-hw + X, y1, hd + Z, 0, 1], [hw + X, y1, hd + Z, 1, 1], [hw + X, y1, -hd + Z, 1, 0]], top);
    face('ny', [0, -1, 0], [[-hw + X, y0, -hd + Z, 0, 0], [hw + X, y0, -hd + Z, 1, 0], [hw + X, y0, hd + Z, 1, 1], [-hw + X, y0, hd + Z, 0, 1]], base);
    face('pz', [0, 0, 1], [[-hw + X, y0, hd + Z, 0, 0], [hw + X, y0, hd + Z, 1, 0], [hw + X, y1, hd + Z, 1, 1], [-hw + X, y1, hd + Z, 0, 1]], base);
    face('nz', [0, 0, -1], [[hw + X, y0, -hd + Z, 0, 0], [-hw + X, y0, -hd + Z, 1, 0], [-hw + X, y1, -hd + Z, 1, 1], [hw + X, y1, -hd + Z, 0, 1]], base);
    face('px', [1, 0, 0], [[hw + X, y0, hd + Z, 0, 0], [hw + X, y0, -hd + Z, 1, 0], [hw + X, y1, -hd + Z, 1, 1], [hw + X, y1, hd + Z, 0, 1]], base);
    face('nx', [-1, 0, 0], [[-hw + X, y0, -hd + Z, 0, 0], [-hw + X, y0, hd + Z, 1, 0], [-hw + X, y1, hd + Z, 1, 1], [-hw + X, y1, -hd + Z, 0, 1]], base);
    return this;
  }

  /* Tapered box: a box whose top face is scaled. Trunks, rocks and
     cliff blocks all use this to avoid looking like crates. */
  /* Was a box with a scaled top face, which is a shape blocks do
     not make. Now it steps in, one block at a time. */
  taper(w, h, d, topScale, color, opts = {}) {
    const { tint = 1, topColor = null, yOff = 0 } = opts;
    const steps = Math.abs(topScale - 1) < 0.08 ? 1
      : Math.max(2, Math.min(4, Math.round(h / (VOX * 3))));
    for (let i = 0; i < steps; i++) {
      const t = steps === 1 ? 0 : i / (steps - 1);
      const sc = 1 + (topScale - 1) * t;
      const sh = h / steps;
      const col = topColor === null ? color : mixHex(color, topColor, t);
      this.box(snapVox(w * sc), sh, snapVox(d * sc), col, {
        yOff: yOff + i * sh, tint, tex: opts.tex, centered: true, topColor: col,
      });
    }
    return this;
  }


  /* Low-poly cone: tree canopies, spikes, hats. */
  /* A stepped stack of blocks rather than an n-gon. Every tree,
     rock and spike in the game goes through here, so making this
     blocky makes the whole world blocky at once - and `segments`
     now decides how many steps it climbs in, not how round it is. */
  cone(radius, h, segments, color, opts = {}) {
    const { yOff = 0, tint = 1, topColor = null, flatten = 1 } = opts;
    const steps = Math.max(2, Math.min(6, segments >= 6 ? Math.round(h / (VOX * 2.6)) || 3 : segments));
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const r = radius * (1 - t * 0.86);
      const w = snapVox(r * 2);
      const d = snapVox(r * 2 * flatten);
      const sh = h / steps;
      const col = topColor === null ? color : mixHex(color, topColor, t);
      this.box(w, sh, d, col, {
        yOff: yOff + i * sh, tint, tex: opts.tex, centered: true, topColor: col,
      });
    }
    return this;
  }


  /* Prismatic crystal: a tapered shaft with a pointed cap. */
  /* Crystals were the one thing still built out of points while
     everything else had become blocks, which made every outcrop
     read as a stray spike in a world of cubes. Now it is a leaning
     stack, narrowing as it climbs. */
  crystal(radius, h, color, opts = {}) {
    const { yOff = 0, tilt = 0, tipColor = null, tint = 1 } = opts;
    const steps = Math.max(3, Math.min(6, Math.round(h / (VOX * 2))));
    const lean = Math.tan(tilt);
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const r = radius * (1 - t * 0.78);
      const sh = h / steps;
      const yb = yOff + i * sh;
      const col = tipColor === null ? color : mixHex(color, tipColor, t * t);
      /* Each block steps sideways as it rises, so a tilted crystal
         still looks tilted without a single sloped face. */
      const off = lean * (yb + sh * 0.5);
      this.box(snapVox(r * 2), sh, snapVox(r * 2), col, {
        yOff: yb, tint, tex: opts.tex, centered: true, topColor: col,
        xOff: off,
      });
    }
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
