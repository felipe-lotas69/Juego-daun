/* ============================================================
   materials.js - toon shading

   A banded ramp texture turns three's toon material into the flat,
   two-or-three-tone shading the style needs, and a small patch adds
   a rim term so silhouettes stay readable against dark ground at
   night. Materials are cached by their settings: a forest chunk and
   a rock end up sharing one program.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { RENDER } from '../core/config.js';

const gradientCache = new Map();

/* The ramp is sampled with dot(N,L)*0.5+0.5, so index 0 is fully
   shadowed. A slightly raised floor keeps shadows coloured rather
   than black once the ambient light tints them. */
export function getGradientMap(bands = RENDER.toonBands, floor = 0.40) {
  const key = `${bands}:${floor}`;
  if (gradientCache.has(key)) return gradientCache.get(key);
  const data = new Uint8Array(bands);
  for (let i = 0; i < bands; i++) {
    /* Bias the steps so the lit band is wide and the terminator
       lands about two thirds of the way round a curved surface. */
    const t = bands === 1 ? 1 : i / (bands - 1);
    const shaped = Math.pow(t, 0.78);
    data[i] = Math.round(255 * (floor + (1 - floor) * shaped));
  }
  const tex = new THREE.DataTexture(data, bands, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  gradientCache.set(key, tex);
  return tex;
}

/* Rim light, injected after the toon lighting has resolved. Two
   uniforms are shared across every material so the day/night rig
   can retune the whole scene in one assignment. */
export const rimUniforms = {
  uRimColor: { value: new THREE.Color(0.35, 0.55, 0.9) },
  uRimPower: { value: 2.4 },
  uRimStrength: { value: 0.30 },
};

const RIM_PARS = /* glsl */`
  uniform vec3  uRimColor;
  uniform float uRimPower;
  uniform float uRimStrength;
`;

const RIM_APPLY = /* glsl */`
  {
    vec3 viewDir = normalize(vViewPosition);
    /* abs(), not clamp(): grass tufts and other double-sided cards
       are emitted with both windings, so half of them face away and
       would otherwise sit at full rim intensity - which reads as
       every blade of grass being outlined in neon. */
    float rim = 1.0 - abs(dot(viewDir, normal));
    rim = pow(rim, uRimPower) * uRimStrength * uRimMul;
    outgoingLight += uRimColor * rim * (0.25 + 0.75 * diffuseColor.rgb);
  }
`;

const materialCache = new Map();

export function makeToonMaterial(opts = {}) {
  const {
    color = 0xffffff,
    vertexColors = false,
    emissive = 0x000000,
    emissiveIntensity = 1,
    rim = 1,
    transparent = false,
    opacity = 1,
    side = THREE.FrontSide,
    depthWrite = true,
    bands = RENDER.toonBands,
    fog = true,
    shadowSide = null,
  } = opts;

  const key = [color, vertexColors, emissive, emissiveIntensity, rim, transparent,
    opacity, side, depthWrite, bands, fog].join('|');
  if (materialCache.has(key)) return materialCache.get(key);

  const mat = new THREE.MeshToonMaterial({
    color,
    vertexColors,
    emissive,
    emissiveIntensity,
    transparent,
    opacity,
    side,
    depthWrite,
    fog,
    gradientMap: getGradientMap(bands),
  });
  if (shadowSide) mat.shadowSide = shadowSide;

  mat.userData.rimMul = { value: rim };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = rimUniforms.uRimColor;
    shader.uniforms.uRimPower = rimUniforms.uRimPower;
    shader.uniforms.uRimStrength = rimUniforms.uRimStrength;
    shader.uniforms.uRimMul = mat.userData.rimMul;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${RIM_PARS}\nuniform float uRimMul;`)
      .replace('#include <opaque_fragment>', `${RIM_APPLY}\n#include <opaque_fragment>`);
  };
  /* Materials that differ only in their patch still need distinct
     programs, which this key gives them. */
  mat.customProgramCacheKey = () => `toon-rim-${bands}`;

  materialCache.set(key, mat);
  return mat;
}

/* Unlit, additive: glows, beams, muzzle flashes, ability rings.
   These live on the no-outline layer so the edge pass ignores them. */
export function makeGlowMaterial(color, opts = {}) {
  const {
    opacity = 1, depthWrite = false, blending = THREE.AdditiveBlending,
    side = THREE.DoubleSide, depthTest = true, intensity = 1,
  } = opts;
  const c = new THREE.Color(color).multiplyScalar(intensity);
  return new THREE.MeshBasicMaterial({
    color: c,
    transparent: true,
    opacity,
    blending,
    depthWrite,
    depthTest,
    side,
    fog: false,
    toneMapped: false,
  });
}

/* The soft dark ellipse under every character. Cheaper and more
   readable at this resolution than a real shadow map contact. */
export function makeBlobShadowMaterial() {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5, dy = (y + 0.5) / size - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const a = Math.max(0, 1 - d);
      const i = (y * size + x) * 4;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
      data[i + 3] = Math.round(255 * Math.pow(a, 1.6));
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return new THREE.MeshBasicMaterial({
    map: tex, transparent: true, opacity: 0.45, depthWrite: false,
    fog: false, toneMapped: false,
  });
}

export function setRimLook(color, strength, power) {
  rimUniforms.uRimColor.value.set(color);
  rimUniforms.uRimStrength.value = strength;
  rimUniforms.uRimPower.value = power;
}

export function disposeMaterialCache() {
  for (const m of materialCache.values()) m.dispose();
  materialCache.clear();
}
