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
import { getDetailAtlas, GRID, RANGE } from './textures.js';

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

/* The detail atlas is indexed per vertex, so a whole terrain chunk
   with its grass, dirt, stone and bark is still one draw call. */
const DETAIL_VERT_PARS = /* glsl */`
  attribute float texCell;
  varying float vTexCell;
  varying vec2 vDetailUv;
`;

const DETAIL_VERT = /* glsl */`
  vTexCell = texCell;
  vDetailUv = uv;
`;

/* ---------------------------------------------------- cloud shadows

   There is no sky to put clouds in - the camera looks down and the
   background is a flat colour - so the clouds are only ever their
   shadows, drifting across the ground. It costs two sines per pixel
   and it is the single cheapest thing that makes a landscape look
   like it has weather over it. */
const CLOUD_VERT_PARS = /* glsl */`
  varying vec2 vCloudXZ;
`;

const CLOUD_VERT = /* glsl */`
  vCloudXZ = (modelMatrix * vec4(transformed, 1.0)).xz;
`;

const CLOUD_FRAG_PARS = /* glsl */`
  uniform vec2  uCloudDrift;
  uniform float uCloudStrength;
  varying vec2 vCloudXZ;
`;

const CLOUD_FRAG = /* glsl */`
  {
    vec2 p = vCloudXZ * 0.030 + uCloudDrift;
    /* Three layers, one of them turned forty degrees off the others.
       Two axis-aligned layers on their own make a corrugated roof;
       the rotated one is what stops it reading as stripes. */
    vec2 q = vec2(p.x * 0.77 + p.y * 0.64, p.y * 0.77 - p.x * 0.64);
    float a = sin(p.x) * sin(p.y * 0.83 + 1.3);
    float b = sin(q.x * 1.9 + 2.1) * sin(q.y * 1.7 - 0.7);
    float c = sin((p.x + p.y) * 0.44 + 4.0);
    float v = a * 0.48 + b * 0.30 + c * 0.22;
    float shade = smoothstep(0.02, 0.58, v) * uCloudStrength;
    diffuseColor.rgb *= 1.0 - shade * 0.24;
  }
`;

export const cloudUniforms = {
  uCloudDrift: { value: new THREE.Vector2(0, 0) },
  uCloudStrength: { value: 1.0 },
};

const DETAIL_FRAG_PARS = /* glsl */`
  uniform sampler2D tDetail;
  uniform float uDetailStrength;
  uniform float uAtlasGrid;
  uniform float uDetailRange;
  varying float vTexCell;
  varying vec2 vDetailUv;
`;

const DETAIL_FRAG = /* glsl */`
  {
    vec2 acell = vec2(mod(vTexCell, uAtlasGrid), floor(vTexCell / uAtlasGrid));
    vec2 auv = (acell + fract(vDetailUv)) / uAtlasGrid;
    vec3 detail = texture2D(tDetail, auv).rgb * uDetailRange;
    diffuseColor.rgb *= mix(vec3(1.0), detail, uDetailStrength);
  }
`;

export const detailUniforms = {
  tDetail: { value: null },
  uDetailStrength: { value: RENDER.detail === undefined ? 1.0 : RENDER.detail },
  uAtlasGrid: { value: GRID },
  uDetailRange: { value: RANGE },
};

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
    detail = true,
    clouds = true,
  } = opts;

  const key = [color, vertexColors, emissive, emissiveIntensity, rim, transparent,
    opacity, side, depthWrite, bands, fog, detail, clouds].join('|');
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
  if (detail) detailUniforms.tDetail.value = getDetailAtlas();
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uRimColor = rimUniforms.uRimColor;
    shader.uniforms.uRimPower = rimUniforms.uRimPower;
    shader.uniforms.uRimStrength = rimUniforms.uRimStrength;
    shader.uniforms.uRimMul = mat.userData.rimMul;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${RIM_PARS}\nuniform float uRimMul;`)
      .replace('#include <opaque_fragment>', `${RIM_APPLY}\n#include <opaque_fragment>`);
    if (detail) {
      shader.uniforms.tDetail = detailUniforms.tDetail;
      shader.uniforms.uDetailStrength = detailUniforms.uDetailStrength;
      shader.uniforms.uAtlasGrid = detailUniforms.uAtlasGrid;
      shader.uniforms.uDetailRange = detailUniforms.uDetailRange;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${DETAIL_VERT_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${DETAIL_VERT}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${DETAIL_FRAG_PARS}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${DETAIL_FRAG}`);
    }
    if (clouds) {
      shader.uniforms.uCloudDrift = cloudUniforms.uCloudDrift;
      shader.uniforms.uCloudStrength = cloudUniforms.uCloudStrength;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>\n${CLOUD_VERT_PARS}`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n${CLOUD_VERT}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${CLOUD_FRAG_PARS}`)
        .replace('#include <color_fragment>', `#include <color_fragment>\n${CLOUD_FRAG}`);
    }
  };
  /* Materials that differ only in their patch still need distinct
     programs, which this key gives them. */
  mat.customProgramCacheKey = () => `toon-rim-${bands}-${detail ? 'd' : 'p'}-${clouds ? 'c' : 'x'}`;

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
