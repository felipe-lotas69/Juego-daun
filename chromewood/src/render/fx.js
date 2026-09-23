/* ============================================================
   fx.js - particles, bolts, beams and blasts

   The simulation says what happened; this decides what it looks
   like. Everything here is pooled and lives on the no-outline
   layer, so sparks and glows never grow a dark rim and never
   confuse the edge detector.

   Particles are one Points object with CPU-updated attributes:
   at this resolution a particle is a couple of screen pixels, so
   a thousand of them cost one draw call and look like a firework.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { LAYER_NO_OUTLINE } from './pipeline.js';
import { clamp01, lerp, TAU } from '../core/util.js';

const MAX_PARTICLES = 1400;

const PARTICLE_VERT = /* glsl */`
  attribute float size;
  attribute float alpha;
  varying vec3 vColor;
  varying float vAlpha;
  uniform float uPixelScale;
  void main() {
    vColor = color;
    vAlpha = alpha;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    /* Fixed screen size: a particle is a pixel-art dot, not a
       perspective sprite. */
    gl_PointSize = max(1.0, size * uPixelScale);
  }
`;

const PARTICLE_FRAG = /* glsl */`
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    /* Square particles, because round ones fight the pixel grid. */
    gl_FragColor = vec4(vColor, vAlpha);
  }
`;

export class FxSystem {
  constructor(scene) {
    this.scene = scene;
    this.time = 0;
    this._initParticles();
    this._initPools();
    this.shakeRequest = 0;
    this.flashRequest = 0;
    this.flashColor = new THREE.Color(1, 0.3, 0.3);
    this.lights = [];       /* drained by the scene rig each frame */
    this.floaters = [];     /* damage numbers, drawn by the HUD     */
  }

  _initParticles() {
    const g = new THREE.BufferGeometry();
    this.pPos = new Float32Array(MAX_PARTICLES * 3);
    this.pCol = new Float32Array(MAX_PARTICLES * 3);
    this.pSize = new Float32Array(MAX_PARTICLES);
    this.pAlpha = new Float32Array(MAX_PARTICLES);
    g.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(this.pCol, 3));
    g.setAttribute('size', new THREE.BufferAttribute(this.pSize, 1));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.pAlpha, 1));
    g.setDrawRange(0, 0);
    this.particleGeo = g;

    this.particleMat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      uniforms: { uPixelScale: { value: 1 } },
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.points = new THREE.Points(g, this.particleMat);
    this.points.frustumCulled = false;
    this.points.layers.set(LAYER_NO_OUTLINE);
    this.points.renderOrder = 6;
    this.scene.add(this.points);

    /* Live particle records, compacted every frame. */
    this.particles = [];
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.particles.push({
        active: false, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
        life: 0, maxLife: 1, size: 2, drag: 1, gravity: 0,
        r: 1, g: 1, b: 1, fade: 1,
      });
    }
    this.pCursor = 0;
  }

  _initPools() {
    /* Bolts: a small bright box that stretches along its velocity. */
    this.boltGeo = new THREE.BoxGeometry(1, 1, 1);
    this.boltMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, fog: false, toneMapped: false,
    });
    this.bolts = new Map();          /* sim projectile id -> mesh */
    this.boltFree = [];

    /* Beams and chains share one stretched-box pool. */
    this.beams = [];
    this.beamFree = [];

    /* Ground rings for blasts, traps and telegraphs. */
    this.ringGeo = new THREE.RingGeometry(0.62, 1.0, 20);
    this.ringGeo.rotateX(-Math.PI / 2);
    this.rings = [];
    this.ringFree = [];

    /* Flat billboards for shockwave discs. */
    this.discGeo = new THREE.CircleGeometry(1, 18);
    this.discGeo.rotateX(-Math.PI / 2);
  }

  /* ------------------------------------------------------ particles */
  spawnParticle(opts) {
    /* Round-robin over the pool: at a thousand particles, stealing
       the oldest is indistinguishable from running out. */
    let tries = 0;
    let p = null;
    while (tries++ < MAX_PARTICLES) {
      const c = this.particles[this.pCursor];
      this.pCursor = (this.pCursor + 1) % MAX_PARTICLES;
      if (!c.active) { p = c; break; }
      if (tries === MAX_PARTICLES) p = c;
    }
    if (!p) p = this.particles[this.pCursor];
    p.active = true;
    p.x = opts.x; p.y = opts.y; p.z = opts.z;
    p.vx = opts.vx || 0; p.vy = opts.vy || 0; p.vz = opts.vz || 0;
    p.life = p.maxLife = opts.life || 0.5;
    p.size = opts.size || 2;
    p.drag = opts.drag === undefined ? 2.4 : opts.drag;
    p.gravity = opts.gravity === undefined ? 5 : opts.gravity;
    const c = new THREE.Color(opts.color === undefined ? 0xffffff : opts.color);
    const gain = opts.gain === undefined ? 1.8 : opts.gain;
    p.r = c.r * gain; p.g = c.g * gain; p.b = c.b * gain;
    p.fade = opts.fade === undefined ? 1 : opts.fade;
    return p;
  }

  burst(x, y, z, count, opts = {}) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const up = opts.up === undefined ? Math.random() * 3.4 : opts.up * (0.4 + Math.random());
      const sp = (opts.speed || 3) * (0.35 + Math.random() * 0.9);
      this.spawnParticle({
        x, y, z,
        vx: Math.cos(a) * sp, vy: up, vz: Math.sin(a) * sp,
        life: (opts.life || 0.5) * (0.6 + Math.random() * 0.8),
        size: opts.size || 2,
        color: opts.color,
        gain: opts.gain,
        gravity: opts.gravity,
        drag: opts.drag,
      });
    }
  }

  /* ---------------------------------------------------------- bolts */
  addBolt(id, x, y, z, vx, vz, color, radius) {
    let mesh = this.boltFree.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(this.boltGeo, this.boltMat.clone());
      mesh.layers.set(LAYER_NO_OUTLINE);
      mesh.renderOrder = 5;
      this.scene.add(mesh);
    }
    mesh.visible = true;
    mesh.material.color.set(color).multiplyScalar(2.2);
    mesh.userData.color = color;
    mesh.userData.trail = 0;
    const speed = Math.hypot(vx, vz) || 1;
    mesh.scale.set(Math.max(0.35, speed * 0.032), radius * 1.5, radius * 1.5);
    mesh.position.set(x, y, z);
    mesh.rotation.y = -Math.atan2(vz, vx);
    this.bolts.set(id, mesh);
    return mesh;
  }

  removeBolt(id) {
    const mesh = this.bolts.get(id);
    if (!mesh) return;
    mesh.visible = false;
    this.bolts.delete(id);
    this.boltFree.push(mesh);
  }

  syncBolts(projectiles) {
    /* The sim owns the list; the view mirrors it. */
    for (const pr of projectiles) {
      let mesh = this.bolts.get(pr.id);
      if (!mesh) mesh = this.addBolt(pr.id, pr.x, pr.y, pr.z, pr.vx, pr.vz, pr.color, pr.radius);
      mesh.position.set(pr.x, pr.y, pr.z);
      mesh.rotation.y = -Math.atan2(pr.vz, pr.vx);
      mesh.userData.trail += 1;
      if (mesh.userData.trail % 2 === 0) {
        this.spawnParticle({
          x: pr.x, y: pr.y, z: pr.z,
          vx: -pr.vx * 0.06, vy: 0.2, vz: -pr.vz * 0.06,
          life: 0.22, size: 2, color: pr.color, gravity: 0, drag: 5, gain: 1.4,
        });
      }
    }
    for (const id of [...this.bolts.keys()]) {
      if (!projectiles.some(p => p.id === id)) this.removeBolt(id);
    }
  }

  /* ---------------------------------------------------------- beams */
  addBeam(x1, y1, z1, x2, y2, z2, color, width, life) {
    let mesh = this.beamFree.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(this.boltGeo, this.boltMat.clone());
      mesh.layers.set(LAYER_NO_OUTLINE);
      mesh.renderOrder = 5;
      this.scene.add(mesh);
    }
    mesh.visible = true;
    mesh.material.color.set(color).multiplyScalar(2.6);
    mesh.material.opacity = 1;
    const dx = x2 - x1, dy = y2 - y1, dz = z2 - z1;
    const len = Math.hypot(dx, dy, dz) || 0.001;
    mesh.position.set((x1 + x2) / 2, (y1 + y2) / 2, (z1 + z2) / 2);
    mesh.scale.set(len, width, width);
    mesh.rotation.set(0, -Math.atan2(dz, dx), Math.asin(clamp01(dy / len) * Math.sign(dy)));
    this.beams.push({ mesh, life, maxLife: life, width });
    return mesh;
  }

  /* ---------------------------------------------------------- rings */
  addRing(x, y, z, radius, color, life, opts = {}) {
    let mesh = this.ringFree.pop();
    if (!mesh) {
      mesh = new THREE.Mesh(opts.disc ? this.discGeo : this.ringGeo, this.boltMat.clone());
      mesh.layers.set(LAYER_NO_OUTLINE);
      mesh.renderOrder = 4;
      this.scene.add(mesh);
    } else if (opts.disc && mesh.geometry !== this.discGeo) {
      mesh.geometry = this.discGeo;
    } else if (!opts.disc && mesh.geometry !== this.ringGeo) {
      mesh.geometry = this.ringGeo;
    }
    mesh.visible = true;
    mesh.material.color.set(color).multiplyScalar(opts.gain === undefined ? 2.0 : opts.gain);
    mesh.material.opacity = 1;
    mesh.position.set(x, y + 0.06, z);
    mesh.scale.set(opts.from === undefined ? radius * 0.25 : opts.from, 1, opts.from === undefined ? radius * 0.25 : opts.from);
    this.rings.push({
      mesh, life, maxLife: life, radius,
      from: opts.from === undefined ? radius * 0.25 : opts.from,
      grow: opts.grow !== false, spin: opts.spin || 0,
    });
    return mesh;
  }

  addFloater(x, y, z, text, color, opts = {}) {
    this.floaters.push({
      x, y, z, text, color,
      life: opts.life || 0.95, maxLife: opts.life || 0.95,
      vy: opts.vy === undefined ? 1.5 : opts.vy,
      vx: (Math.random() - 0.5) * 0.9,
      size: opts.size || 1, crit: !!opts.crit,
    });
    if (this.floaters.length > 60) this.floaters.shift();
  }

  addLight(x, y, z, color, intensity, range) {
    this.lights.push({ x, y, z, color, intensity, range, alwaysOn: true });
  }

  /* -------------------------------------------- simulation events */
  handleEvent(ev, ctx) {
    switch (ev.t) {
      case 'impact': {
        this.burst(ev.x, ev.y, ev.z, ev.kind === 'wall' ? 5 : 9, {
          color: ev.color, speed: 3.6, life: 0.32, size: 2, up: 2,
        });
        this.addLight(ev.x, ev.y, ev.z, ev.color, 1.3, 3.5);
        break;
      }
      case 'boom': {
        this.addRing(ev.x, ev.y, ev.z, ev.radius, ev.color, 0.42, { gain: 2.6 });
        this.addRing(ev.x, ev.y, ev.z, ev.radius * 0.8, 0xffffff, 0.22, { gain: 3.0 });
        this.burst(ev.x, ev.y + 0.3, ev.z, 34, {
          color: ev.color, speed: ev.radius * 1.9, life: 0.7, size: 3, up: 4.5,
        });
        this.burst(ev.x, ev.y + 0.3, ev.z, 12, { color: 0xffffff, speed: ev.radius * 1.2, life: 0.35, size: 2, up: 3 });
        this.addLight(ev.x, ev.y + 0.6, ev.z, ev.color, 5, ev.radius * 3);
        this.shakeRequest = Math.max(this.shakeRequest, ev.shake || 0.35);
        break;
      }
      case 'beam': {
        this.addBeam(ev.x1, ev.y1, ev.z1, ev.x2, ev.y2, ev.z2, ev.color, ev.width * 1.4, 0.22);
        this.addBeam(ev.x1, ev.y1, ev.z1, ev.x2, ev.y2, ev.z2, 0xffffff, ev.width * 0.5, 0.16);
        this.addLight(ev.x1, ev.y1, ev.z1, ev.color, 4, 9);
        this.shakeRequest = Math.max(this.shakeRequest, 0.55);
        break;
      }
      case 'chain': {
        for (const l of ev.links) {
          this.addBeam(l.x1, l.y1, l.z1, l.x2, l.y2, l.z2, ev.color, 0.16, 0.18);
          this.burst(l.x2, l.y2, l.z2, 6, { color: ev.color, speed: 2.4, life: 0.3, size: 2, up: 1.6 });
        }
        break;
      }
      case 'siphon': {
        this.addBeam(ev.x1, ev.y1, ev.z1, ev.x2, ev.y2, ev.z2, ev.color, 0.12, 0.12);
        this.spawnParticle({
          x: ev.x2, y: ev.y2, z: ev.z2,
          vx: (ev.x1 - ev.x2) * 1.6, vy: (ev.y1 - ev.y2) * 1.6, vz: (ev.z1 - ev.z2) * 1.6,
          life: 0.5, size: 2, color: ev.color, gravity: 0, drag: 0.4,
        });
        break;
      }
      case 'cast': {
        if (ev.color) {
          this.addRing(ev.x, ev.y, ev.z, 1.6, ev.color, 0.3, { gain: 2.2 });
          this.addLight(ev.x, ev.y + 0.8, ev.z, ev.color, 2.4, 6);
        }
        break;
      }
      case 'dash': {
        this.burst(ev.x, ev.y + 0.3, ev.z, 12, { color: 0xc8f0ff, speed: 2.2, life: 0.35, size: 2, up: 1.2 });
        break;
      }
      case 'blink': {
        this.addRing(ev.x1, ev.y1, ev.z1, 2.2, ev.color, 0.35);
        this.addRing(ev.x2, ev.y2, ev.z2, 2.6, ev.color, 0.35);
        this.burst(ev.x2, ev.y2 + 0.5, ev.z2, 20, { color: ev.color, speed: 5, life: 0.5, size: 3, up: 3 });
        break;
      }
      case 'dmg': {
        const col = ev.target === 'player' ? '#ff6b6b' : (ev.crit ? '#ffe45e' : '#ffffff');
        this.addFloater(ev.x, ev.y, ev.z, String(ev.amount), col, { crit: ev.crit, size: ev.crit ? 1.5 : 1 });
        break;
      }
      case 'kill': {
        const c = ev.boss ? 0xff4fd8 : ev.elite ? 0xffb03a : 0xb07bff;
        this.burst(ev.x, ev.y + 0.5, ev.z, ev.boss ? 80 : 20, {
          color: c, speed: ev.boss ? 9 : 4.5, life: 0.8, size: ev.boss ? 4 : 2, up: 4,
        });
        this.addRing(ev.x, ev.y, ev.z, ev.boss ? 7 : 1.8, c, 0.45);
        if (ev.boss) this.shakeRequest = Math.max(this.shakeRequest, 1.2);
        break;
      }
      case 'spawn': {
        if (ev.fromRift) {
          this.addRing(ev.x, ev.y, ev.z, 1.5, 0xff4fd8, 0.5);
          this.burst(ev.x, ev.y + 0.3, ev.z, 12, { color: 0xff4fd8, speed: 2, life: 0.5, size: 2, up: 2.5 });
        }
        break;
      }
      case 'levelup': {
        this.addRing(ev.x, ev.y, ev.z, 3.4, 0xffe45e, 0.8, { gain: 3 });
        this.burst(ev.x, ev.y + 0.5, ev.z, 40, { color: 0xffe45e, speed: 3, life: 1.1, size: 3, up: 6, gravity: 2 });
        this.addFloater(ev.x, ev.y + 2.0, ev.z, 'LEVEL ' + ev.level, '#ffe45e', { life: 2.0, size: 1.6, vy: 0.8 });
        break;
      }
      case 'pickup': {
        const c = ev.kind === 'scrap' ? 0xffb03a : ev.kind === 'essence' ? 0xb07bff
          : ev.kind === 'cores' ? 0xff4fd8 : ev.kind === 'health' ? 0x63ff9d : 0x3fe0ff;
        this.burst(ev.x, ev.y + 0.3, ev.z, 5, { color: c, speed: 1.4, life: 0.3, size: 2, up: 2 });
        break;
      }
      case 'prop_break': {
        this.burst(ev.x, ev.y + 0.4, ev.z, 16, { color: 0xc9c2b0, speed: 3, life: 0.6, size: 2, up: 3 });
        break;
      }
      case 'prop_hit': {
        this.burst(ev.x, ev.y + 0.5, ev.z, 4, { color: 0xe8e0cc, speed: 2, life: 0.25, size: 2, up: 1.5 });
        break;
      }
      case 'trap': {
        this.addRing(ev.x, ev.y, ev.z, ev.radius, ev.color, 99, { grow: false, from: ev.radius * 0.9, spin: 1.2 });
        break;
      }
      case 'windup': {
        this.addRing(ev.x, ev.y, ev.z, ev.radius, 0xff4fd8, ev.time, { from: ev.radius * 0.2, gain: 2.4 });
        break;
      }
      case 'boon': {
        this.addRing(ev.x, ev.y, ev.z, 3, 0x7ee8ff, 0.7, { gain: 3 });
        this.addFloater(ev.x, ev.y + 2.2, ev.z, ev.name.toUpperCase(), '#7ee8ff', { life: 1.8, size: 1.4 });
        break;
      }
      case 'revive': {
        this.addRing(ev.x, ev.y, ev.z, 2.6, 0x63ff9d, 0.7, { gain: 3 });
        this.burst(ev.x, ev.y + 0.6, ev.z, 26, { color: 0x63ff9d, speed: 3, life: 0.9, size: 3, up: 4 });
        break;
      }
      case 'down': case 'die': {
        this.burst(ev.x, ev.y + 0.7, ev.z, 26, { color: 0xff4f4f, speed: 4, life: 0.8, size: 3, up: 3 });
        this.shakeRequest = Math.max(this.shakeRequest, 0.7);
        break;
      }
      case 'hurt': {
        if (ctx && ev.id === ctx.localId) {
          this.flashRequest = Math.max(this.flashRequest, clamp01(ev.amount / 45) * 0.5);
          this.flashColor.setRGB(1, 0.18, 0.2);
          this.shakeRequest = Math.max(this.shakeRequest, clamp01(ev.amount / 40) * 0.5);
        }
        break;
      }
      case 'nightfall': {
        this.flashRequest = Math.max(this.flashRequest, 0.28);
        this.flashColor.setRGB(0.35, 0.1, 0.5);
        break;
      }
      case 'beacon_hit': {
        this.shakeRequest = Math.max(this.shakeRequest, 0.12);
        break;
      }
      case 'construct_fire': {
        this.burst(ev.x, ev.y, ev.z, 3, { color: 0x3fe0ff, speed: 1.6, life: 0.2, size: 2, up: 0.4 });
        break;
      }
      case 'fuse': {
        this.addRing(ev.x, ev.y, ev.z, 3.2, 0xffb03a, ev.time, { from: 0.6, gain: 2.4 });
        break;
      }
      default: break;
    }
  }

  /* --------------------------------------------------------- update */
  update(dt, pixelScale) {
    this.time += dt;
    this.particleMat.uniforms.uPixelScale.value = pixelScale;

    let n = 0;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      p.life -= dt;
      if (p.life <= 0) { p.active = false; continue; }
      const drag = Math.exp(-p.drag * dt);
      p.vx *= drag; p.vz *= drag;
      p.vy = p.vy * drag - p.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;

      const t = p.life / p.maxLife;
      const j = n * 3;
      this.pPos[j] = p.x; this.pPos[j + 1] = p.y; this.pPos[j + 2] = p.z;
      this.pCol[j] = p.r; this.pCol[j + 1] = p.g; this.pCol[j + 2] = p.b;
      this.pSize[n] = p.size;
      this.pAlpha[n] = Math.pow(t, p.fade);
      n++;
    }
    this.particleGeo.setDrawRange(0, n);
    if (n > 0) {
      this.particleGeo.attributes.position.needsUpdate = true;
      this.particleGeo.attributes.color.needsUpdate = true;
      this.particleGeo.attributes.size.needsUpdate = true;
      this.particleGeo.attributes.alpha.needsUpdate = true;
    }

    for (let i = this.beams.length - 1; i >= 0; i--) {
      const b = this.beams[i];
      b.life -= dt;
      const t = clamp01(b.life / b.maxLife);
      b.mesh.material.opacity = t;
      b.mesh.scale.y = b.width * (0.3 + t * 0.7);
      b.mesh.scale.z = b.mesh.scale.y;
      if (b.life <= 0) {
        b.mesh.visible = false;
        this.beamFree.push(b.mesh);
        this.beams.splice(i, 1);
      }
    }

    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.life -= dt;
      const t = clamp01(1 - r.life / r.maxLife);
      if (r.grow) {
        const s = lerp(r.from, r.radius, Math.sqrt(t));
        r.mesh.scale.set(s, 1, s);
        r.mesh.material.opacity = 1 - t;
      } else {
        r.mesh.material.opacity = 0.55 + Math.sin(this.time * 5) * 0.2;
      }
      if (r.spin) r.mesh.rotation.y += r.spin * dt;
      if (r.life <= 0) {
        r.mesh.visible = false;
        this.ringFree.push(r.mesh);
        this.rings.splice(i, 1);
      }
    }

    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.life -= dt;
      f.y += f.vy * dt;
      f.x += f.vx * dt;
      f.vy -= 1.6 * dt;
      if (f.life <= 0) this.floaters.splice(i, 1);
    }
  }

  clearRingsByTag() { /* traps clear on detonation via life expiry */ }

  drainShake() { const s = this.shakeRequest; this.shakeRequest = 0; return s; }
  drainFlash() { const f = this.flashRequest; this.flashRequest = 0; return f; }
  drainLights() { const l = this.lights; this.lights = []; return l; }
}
