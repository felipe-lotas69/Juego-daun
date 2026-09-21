/* ============================================================
   scene.js - lighting, sky and the day/night rig

   One directional light does the sun and the moon; everything else
   is a pool of point lights that gets reassigned every frame to
   whatever is nearest the camera. A forest full of glowing crystals
   would otherwise blow past any sane light limit.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { PALETTE, DAY, RENDER, WORLD_HALF } from '../core/config.js';
import { clamp01, lerp, smoothstep } from '../core/util.js';
import { setRimLook } from './materials.js';
import { LAYER_NO_OUTLINE } from './pipeline.js';

const POINT_LIGHT_POOL = 10;

export class SceneRig {
  constructor() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(PALETTE.skyDay);
    /* With an orthographic camera every pixel sits at roughly the
       camera distance, so fog ranges are measured out from there
       rather than from zero - otherwise the whole frame fogs at
       once. Set properly in update(). */
    this.scene.fog = new THREE.Fog(PALETTE.fogDay, 40, 120);

    this.sun = new THREE.DirectionalLight(PALETTE.sunDay, 2.6);
    this.sun.castShadow = RENDER.shadows;
    if (this.sun.shadow) {
      const s = this.sun.shadow;
      s.mapSize.set(1024, 1024);
      s.camera.near = 1;
      s.camera.far = 90;
      s.camera.left = -26; s.camera.right = 26;
      s.camera.top = 26; s.camera.bottom = -26;
      /* A tight bias: our shadows are hard, so acne shows up as
         single flickering pixels rather than a soft haze. */
      s.bias = -0.0009;
      s.normalBias = 0.045;
      /* LightShadow never calls this itself, so a shadow camera
         resized after construction keeps its default 10x10 frustum
         and the map covers almost nothing. */
      s.camera.updateProjectionMatrix();
    }
    this.sunTarget = new THREE.Object3D();
    this.scene.add(this.sun, this.sunTarget);
    this.sun.target = this.sunTarget;

    this.hemi = new THREE.HemisphereLight(PALETTE.skyDay, PALETTE.grassDark, 1.15);
    this.scene.add(this.hemi);

    this.fill = new THREE.DirectionalLight(0x8fa8ff, 0.35);
    this.fill.position.set(-0.6, 0.5, -0.8);
    this.scene.add(this.fill);

    /* Reassignable point lights. */
    this.pointLights = [];
    for (let i = 0; i < POINT_LIGHT_POOL; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 8, 1.6);
      l.visible = false;
      this.scene.add(l);
      this.pointLights.push(l);
    }
    this.dynamicLights = [];      /* refreshed every frame by the game */

    this.time = DAY.dayLength * 0.35;   /* start mid-morning */
    this.cycleLength = DAY.dayLength + DAY.nightLength;
    this.phase = 'day';
    this.nightAmount = 0;

    this._skyDay = new THREE.Color(PALETTE.skyDay);
    this._skyNight = new THREE.Color(PALETTE.skyNight);
    this._skyDusk = new THREE.Color(0xff9b5e);
    this._fogDay = new THREE.Color(PALETTE.fogDay);
    this._fogNight = new THREE.Color(PALETTE.fogNight);
    this._fogDusk = new THREE.Color(0xd98a6a);
    this._tmp = new THREE.Color();

    this.starField = this._makeStars();
    this.scene.add(this.starField);
  }

  _makeStars() {
    const count = 420;
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      /* On a dome well outside the arena, biased to the upper half
         so they never sit behind the terrain. */
      const a = Math.random() * Math.PI * 2;
      const t = Math.random();
      const y = 0.25 + t * 0.9;
      const r = Math.sqrt(Math.max(0.01, 1 - y * y));
      const R = WORLD_HALF * 1.8;
      pos[i * 3] = Math.cos(a) * r * R;
      pos[i * 3 + 1] = y * R;
      pos[i * 3 + 2] = Math.sin(a) * r * R;
      const warm = Math.random();
      col[i * 3] = 0.75 + warm * 0.25;
      col[i * 3 + 1] = 0.80 + warm * 0.2;
      col[i * 3 + 2] = 1.0;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.PointsMaterial({
      size: 2.4, sizeAttenuation: false, vertexColors: true,
      transparent: true, opacity: 0, depthWrite: false, fog: false, toneMapped: false,
    });
    const points = new THREE.Points(g, m);
    points.layers.set(LAYER_NO_OUTLINE);
    points.frustumCulled = false;
    return points;
  }

  /* 0 at dawn through 1 at the end of night. */
  get cycleT() { return (this.time % this.cycleLength) / this.cycleLength; }
  get isNight() { return this.nightAmount > 0.5; }

  setTime(t) { this.time = t; }

  update(dt, cameraTarget, grade, cameraDistance = 52, weather = null) {
    this.time += dt;
    const t = this.time % this.cycleLength;

    /* nightAmount ramps through dusk, holds at 1 through the night
       and ramps back down at dawn. Everything else is driven by it. */
    const d = DAY.dayLength, n = DAY.nightLength, k = DAY.duskLength;
    let night;
    if (t < d - k) night = 0;
    else if (t < d) night = smoothstep(d - k, d, t);
    else if (t < d + n - k) night = 1;
    else night = 1 - smoothstep(d + n - k, d + n, t);
    this.nightAmount = night;
    this.phase = night > 0.98 ? 'night' : night < 0.02 ? 'day' : (t < d ? 'dusk' : 'dawn');

    /* Dusk is the interesting band: warm and low. Peak at night=0.5. */
    const duskAmt = 1 - Math.abs(night - 0.5) * 2;

    /* Sun arc: high at noon, grazing at dusk, replaced by a cool
       moon once night is fully in. */
    const dayT = clamp01(t / d);
    const elevation = lerp(0.30, 0.78, Math.sin(Math.PI * dayT)) * (1 - night) + 0.60 * night;
    const azimuth = Math.PI * 0.25 + dayT * Math.PI * 0.55 + night * Math.PI * 0.9;
    const dir = new THREE.Vector3(
      Math.cos(azimuth) * Math.cos(elevation),
      Math.sin(elevation) * 1.15,
      Math.sin(azimuth) * Math.cos(elevation),
    ).normalize();

    this.sunTarget.position.copy(cameraTarget);
    this.sun.position.copy(cameraTarget).addScaledVector(dir, 42);

    /* Colour: day -> dusk -> night. */
    this._tmp.set(PALETTE.sunDay).lerp(new THREE.Color(PALETTE.sunDusk), duskAmt);
    this._tmp.lerp(new THREE.Color(PALETTE.sunNight), night * night);
    this.sun.color.copy(this._tmp);
    this.sun.intensity = lerp(2.75, 0.78, night);

    this.hemi.intensity = lerp(1.15, 0.64, night);
    this.hemi.color.set(PALETTE.skyDay).lerp(new THREE.Color(0x3a4a80), night);
    this.hemi.groundColor.set(PALETTE.grassDark).lerp(new THREE.Color(0x19203a), night);
    this.fill.intensity = lerp(0.30, 0.55, night);
    this.fill.color.set(0x9fc4ff).lerp(new THREE.Color(0x6f7fff), night);

    /* Sky and fog. */
    this._tmp.copy(this._skyDay).lerp(this._skyDusk, duskAmt).lerp(this._skyNight, night * night);
    this.scene.background.copy(this._tmp);
    this._tmp.copy(this._fogDay).lerp(this._fogDusk, duskAmt).lerp(this._fogNight, night);
    this.scene.fog.color.copy(this._tmp);
    /* Only the far half of the view fogs: enough for aerial depth,
       never enough to grey out the ground you are standing on.
       Weather pulls the far plane in, which is the whole effect of
       fog and a snowstorm. */
    const vis = weather && weather.fog !== undefined ? weather.fog : 1;
    this.scene.fog.near = cameraDistance + lerp(10, 4, night) * vis;
    this.scene.fog.far = cameraDistance + lerp(54, 34, night) * vis;
    if (weather && weather.id === 'ashfall') this.scene.fog.color.lerp(new THREE.Color(0x5a4658), 0.45);
    if (weather && weather.id === 'snowstorm') this.scene.fog.color.lerp(new THREE.Color(0xc8d6e4), 0.4);

    this.starField.material.opacity = Math.max(0, night * night * 0.9);
    this.starField.position.set(cameraTarget.x, 0, cameraTarget.z);

    /* Rim light flips from a warm sky bounce to a cold arcane edge
       so characters stay readable once the ground goes dark. */
    setRimLook(
      this._tmp.copy(new THREE.Color(0x9fd0ff)).lerp(new THREE.Color(0x9f7bff), night),
      lerp(0.18, 0.30, night),
      lerp(3.2, 2.8, night),
    );

    if (grade) {
      grade.exposure = lerp(1.0, 1.02, night);
      grade.contrast = lerp(1.05, 1.10, night);
      grade.saturation = lerp(1.14, 1.00, night);
      grade.tint.setRGB(lerp(1, 0.88, night), lerp(1, 0.92, night), lerp(1, 1.12, night));
      grade.lift.setRGB(lerp(0, 0.020, night), lerp(0, 0.024, night), lerp(0, 0.042, night));
      grade.vignette = lerp(0.48, 0.80, night);
    }
  }

  /* Reassign the point-light pool. `sites` are static world lights,
     `dynamic` are this frame's spells and projectiles, which always
     win a slot because they are what the eye is following. */
  updatePointLights(sites, cameraTarget) {
    const picks = [];
    for (const d of this.dynamicLights) picks.push({ site: d, d: -1 });
    const budget = POINT_LIGHT_POOL - picks.length;
    if (budget > 0) {
      const scored = [];
      for (let i = 0; i < sites.length; i++) {
        const s = sites[i];
        const dx = s.x - cameraTarget.x, dz = s.z - cameraTarget.z;
        const d2 = dx * dx + dz * dz;
        if (d2 > 46 * 46) continue;
        scored.push({ site: s, d: d2 });
      }
      scored.sort((a, b) => a.d - b.d);
      for (let i = 0; i < Math.min(budget, scored.length); i++) picks.push(scored[i]);
    }

    for (let i = 0; i < this.pointLights.length; i++) {
      const l = this.pointLights[i];
      const p = picks[i];
      if (!p) { l.visible = false; l.intensity = 0; continue; }
      const s = p.site;
      l.visible = true;
      l.position.set(s.x, s.y, s.z);
      l.color.set(s.color);
      /* World lights fade up as night falls; spell lights do not. */
      const nightScale = s.alwaysOn ? 1 : lerp(0.18, 1.25, this.nightAmount);
      l.intensity = (s.intensity || 1) * nightScale * (s.scale === undefined ? 1 : s.scale);
      l.distance = s.range || 8;
      l.decay = 1.7;
    }
    this.dynamicLights.length = 0;
  }

  addDynamicLight(x, y, z, color, intensity, range) {
    if (this.dynamicLights.length >= 5) return;
    this.dynamicLights.push({ x, y, z, color, intensity, range, alwaysOn: true });
  }
}
