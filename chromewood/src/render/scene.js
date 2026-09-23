/* ============================================================
   scene.js - lighting, sky and the day/night rig

   One directional light does the sun and the moon; everything else
   is a pool of point lights that gets reassigned every frame to
   whatever is nearest the camera. A forest full of glowing crystals
   would otherwise blow past any sane light limit.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { PALETTE, DAY, RENDER, WORLD_HALF } from '../core/config.js';
import { clamp01, lerp, smoothstep, damp } from '../core/util.js';
import { setRimLook, cloudUniforms, windUniforms, seasonUniforms } from './materials.js';
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
    this._rock = new THREE.Color(0x120f18);
    this._seasonA = new THREE.Color();
    this._seasonB = new THREE.Color();
    this.under = 0;
    this._tmp = new THREE.Color();

    this.starField = this._makeStars();
    this.scene.add(this.starField);

    /* Motes: dust in a sunbeam. They live in a box that travels with
       the camera, so there are never more than a few hundred of them
       and they are always where you are looking. */
    this.motes = this._makeMotes();
    this.scene.add(this.motes);
    this.cloudDrift = new THREE.Vector2(0, 0);
  }

  _makeMotes() {
    const count = 260;
    const g = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const seed = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 34;
      pos[i * 3 + 1] = Math.random() * 7 + 0.4;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 34;
      seed[i] = Math.random() * 100;
    }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.userData.seed = seed;
    g.userData.home = pos.slice();
    const m = new THREE.PointsMaterial({
      size: 1.6, sizeAttenuation: false, color: 0xfff0c8,
      transparent: true, opacity: 0.0, depthWrite: false, fog: false, toneMapped: false,
    });
    const points = new THREE.Points(g, m);
    points.layers.set(LAYER_NO_OUTLINE);
    points.frustumCulled = false;
    return points;
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

  update(dt, cameraTarget, grade, cameraDistance = 52, weather = null, zoom = RENDER.fov,
    underground = 0, season = null, nextSeason = null, progress = 0) {
    /* Eased rather than snapped: walking through a doorway should
       feel like the light going, not like a switch. */
    this.under = damp(this.under === undefined ? 0 : this.under, clamp01(underground), 3.4, dt);
    const under = this.under;
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
    /* A lower arc than before. Blocks need a raking light to show
       their form; a sun near the top of the sky lights every upward
       face the same and the world goes flat. */
    const elevation = lerp(0.26, 0.58, Math.sin(Math.PI * dayT)) * (1 - night) + 0.52 * night;
    const azimuth = Math.PI * 0.25 + dayT * Math.PI * 0.55 + night * Math.PI * 0.9;
    const dir = new THREE.Vector3(
      Math.cos(azimuth) * Math.cos(elevation),
      Math.sin(elevation) * 1.15,
      Math.sin(azimuth) * Math.cos(elevation),
    ).normalize();

    this.sunTarget.position.copy(cameraTarget);
    this.sun.position.copy(cameraTarget).addScaledVector(dir, 42);
    /* The shadow map has to cover what the camera can see, or a
       zoomed-out view is lit but unshadowed past a hard circle. */
    if (this.sun.shadow) {
      const half = Math.min(58, Math.max(20, zoom * 2.6));
      const sc = this.sun.shadow.camera;
      if (sc.right !== half) {
        sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half;
        sc.far = Math.max(90, half * 2.6);
        sc.updateProjectionMatrix();
      }
    }

    /* Colour: day -> dusk -> night. */
    this._tmp.set(PALETTE.sunDay).lerp(new THREE.Color(PALETTE.sunDusk), duskAmt);
    this._tmp.lerp(new THREE.Color(PALETTE.sunNight), night * night);
    this.sun.color.copy(this._tmp);
    /* More sun, less sky. The hemisphere light fills every face
       evenly, which is exactly what flattens a stack of cubes, so
       the balance moves toward the direction that has a direction. */
    this.sun.intensity = lerp(2.80, 0.78, night) * lerp(1, 0.10, under);

    this.hemi.intensity = lerp(0.94, 0.56, night) * lerp(1, 0.34, under);
    this.hemi.color.set(PALETTE.skyDay).lerp(new THREE.Color(0x3a4a80), night);
    this.hemi.groundColor.set(PALETTE.grassDark).lerp(new THREE.Color(0x19203a), night);
    this.fill.intensity = lerp(0.42, 0.58, night) * lerp(1, 0.30, under);
    this.fill.color.set(0x9fc4ff).lerp(new THREE.Color(0x6f7fff), night);

    /* Sky and fog. */
    this._tmp.copy(this._skyDay).lerp(this._skyDusk, duskAmt).lerp(this._skyNight, night * night);
    this._tmp.lerp(this._rock, under);
    this.scene.background.copy(this._tmp);
    this._tmp.copy(this._fogDay).lerp(this._fogDusk, duskAmt).lerp(this._fogNight, night);
    /* Pull the fog most of the way toward the sky. Distance haze
       that is a different colour from the sky reads as smoke; haze
       that matches it reads as air, and the far hills dissolve into
       the horizon the way they do outdoors. */
    this._tmp.lerp(this.scene.background, 0.55);
    this.scene.fog.color.copy(this._tmp);
    /* Aerial perspective starts close - a few tiles past the player -
       and is gentle, rather than starting far away and being abrupt.
       Weather pulls the far plane in, which is the whole effect of
       fog and a snowstorm. */
    /* Ranges scale with the zoom. A fixed distance is right at one
       zoom level and wrong at every other: zoomed out, a fog that
       ends sixty units away swallows two thirds of what is on
       screen, and the world becomes a grey smear. */
    const vis = weather && weather.fog !== undefined ? weather.fog : 1;
    const reach = Math.max(zoom, 4);
    /* Underground the far distance closes right in: you should not
       be able to see the whole tunnel system from inside one of it. */
    this.scene.fog.near = cameraDistance + reach * lerp(lerp(0.5, 0.0, night), -0.2, under) * vis;
    this.scene.fog.far = cameraDistance + reach * lerp(lerp(8.2, 5.2, night), 1.9, under) * vis;
    if (weather && weather.id === 'ashfall') this.scene.fog.color.lerp(new THREE.Color(0x5a4658), 0.45);
    if (weather && weather.id === 'snowstorm') this.scene.fog.color.lerp(new THREE.Color(0xc8d6e4), 0.4);

    this.starField.material.opacity = Math.max(0, night * night * 0.9) * (1 - under);
    this.starField.position.set(cameraTarget.x, 0, cameraTarget.z);

    /* The year. Cross-faded over the last fifth of a season so the
       world turns rather than snapping between two pictures. */
    if (season) {
      const t = Math.max(0, (progress - 0.8) / 0.2);
      this._seasonA.set(season.tint);
      this._seasonB.set((nextSeason || season).tint);
      seasonUniforms.uSeasonTint.value.copy(this._seasonA).lerp(this._seasonB, t);
      seasonUniforms.uSeasonAmount.value =
        lerp(season.tintAmount, (nextSeason || season).tintAmount, t);
      seasonUniforms.uSeasonSnow.value =
        lerp(season.snow, (nextSeason || season).snow, t) * (1 - under);
    }

    /* Wind. The direction turns slowly over the day so a fixed lean
       never sets in, and the strength is where weather is felt most:
       a storm is a loud wind before it is anything else. */
    windUniforms.uWindTime.value += dt;
    const turn = this.time * 0.006;
    windUniforms.uWindDir.value.set(Math.cos(turn), Math.sin(turn));
    const gustiness = weather && weather.wind !== undefined ? weather.wind : 1;
    windUniforms.uWindStrength.value = gustiness * (0.85 + Math.sin(this.time * 0.11) * 0.25);

    /* Cloud shadows drift on a slow diagonal. Overcast weather makes
       them heavier; at night there is no sun to cast them. */
    const cover = weather && weather.cloud !== undefined ? weather.cloud : 1;
    this.cloudDrift.x += dt * 0.021;
    this.cloudDrift.y += dt * 0.013;
    cloudUniforms.uCloudDrift.value.copy(this.cloudDrift);
    cloudUniforms.uCloudStrength.value = lerp(0.85, 0.12, night) * cover * (1 - under);

    /* Motes only where there is light to catch them, and most of all
       at dusk when the light is raking. */
    this.motes.position.set(
      Math.floor(cameraTarget.x / 34) * 34,
      0,
      Math.floor(cameraTarget.z / 34) * 34,
    );
    this.motes.material.opacity = (lerp(0.26, 0.05, night) + duskAmt * 0.22) * (1 - under * 0.7);
    {
      const g = this.motes.geometry;
      const pos = g.attributes.position.array;
      const home = g.userData.home, seed = g.userData.seed;
      for (let i = 0; i < seed.length; i++) {
        const t = this.time * 0.35 + seed[i];
        pos[i * 3] = home[i * 3] + Math.sin(t) * 1.6 + this.time * 0.22 % 34;
        pos[i * 3 + 1] = home[i * 3 + 1] + Math.sin(t * 0.7) * 0.5;
        pos[i * 3 + 2] = home[i * 3 + 2] + Math.cos(t * 0.8) * 1.4;
      }
      g.attributes.position.needsUpdate = true;
    }

    /* Rim light flips from a warm sky bounce to a cold arcane edge
       so characters stay readable once the ground goes dark. */
    setRimLook(
      this._tmp.copy(new THREE.Color(0x9fd0ff)).lerp(new THREE.Color(0x9f7bff), night),
      lerp(0.18, 0.30, night),
      lerp(3.2, 2.8, night),
    );

    if (grade) {
      /* Deliberately flat. The world is made of hard-edged blocks in
         saturated colours; pushing contrast and saturation on top of
         that is what made it shout. Lifting the blacks a little and
         leaving the midtones alone is what lets the shapes carry it. */
      /* A midpoint. Flattening the grade fixed a picture that was
         shouting and left one that was mumbling: the world is made
         of saturated blocks and wants some snap, just not the 1.05
         contrast and 1.14 saturation it had before. Half way back,
         with the blacks still lifted so nothing crushes. */
      grade.exposure = lerp(1.02, 1.03, night);
      grade.contrast = lerp(1.00, 1.06, night);
      grade.saturation = lerp(1.07, 0.97, night);
      grade.tint.setRGB(lerp(1, 0.88, night), lerp(1, 0.92, night), lerp(1.01, 1.12, night));
      grade.lift.setRGB(lerp(0.010, 0.026, night), lerp(0.011, 0.029, night), lerp(0.018, 0.046, night));
      grade.vignette = lerp(lerp(0.40, 0.74, night), 0.92, under);
      grade.exposure *= lerp(1, 0.86, under);
      grade.saturation *= lerp(1, 0.80, under);
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
