/* ============================================================
   pipeline.js - the render pipeline

   Two geometry passes at low resolution (normals+depth, then the
   lit image), then the post chain from shaders.js, then a single
   nearest-sampled upscale onto the canvas.

   Layer 0 is the world and gets outlines. Layer 2 holds glows,
   particles and billboards: they are lit and composited, but the
   normal pass skips them so they never grow a black rim.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { FULLSCREEN_VERT, EDGE_FRAG, BRIGHT_FRAG, BLUR_FRAG, COMPOSITE_FRAG } from './shaders.js';
import { RENDER } from '../core/config.js';

export const LAYER_WORLD = 0;
export const LAYER_NO_OUTLINE = 2;

export class PixelPipeline {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(1);          /* we do our own scaling */
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = RENDER.shadows;
    /* Hard shadows: a soft edge would blur across our giant pixels. */
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.autoClear = false;

    this.pixelScale = RENDER.pixelScale;
    this.enabled = { outline: RENDER.outline, bloom: RENDER.bloom, dither: RENDER.dither };

    this.normalMaterial = new THREE.MeshNormalMaterial();
    this.normalCamera = null;

    this.quadScene = new THREE.Scene();
    this.quadCamera = new THREE.Camera();
    this.quadGeo = new THREE.PlaneGeometry(2, 2);
    this.quadMesh = new THREE.Mesh(this.quadGeo, null);
    this.quadMesh.frustumCulled = false;
    this.quadScene.add(this.quadMesh);

    this._buildMaterials();
    this.internal = { w: 1, h: 1 };
    this.setSize(canvas.clientWidth || 960, canvas.clientHeight || 540);

    this.grade = {
      exposure: 1.0, contrast: 1.06, saturation: 1.12,
      tint: new THREE.Color(1, 1, 1), lift: new THREE.Color(0, 0, 0),
      vignette: 0.55, flash: 0, flashColor: new THREE.Color(1, 0.3, 0.3),
      desaturate: 0,
    };
  }

  _buildMaterials() {
    this.edgeMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: EDGE_FRAG,
      depthTest: false, depthWrite: false,
      uniforms: {
        tColor: { value: null }, tNormal: { value: null }, tDepth: { value: null },
        uTexel: { value: new THREE.Vector2() },
        uNear: { value: 0.1 }, uFar: { value: 200 },
        uLineAlpha: { value: RENDER.outlineAlpha },
        uHighlight: { value: 0.30 },
        uShadow: { value: 0.46 },
        uDepthScale: { value: 1.0 },
        uDepthBias: { value: 0.3 },
        uOutlineTint: { value: new THREE.Color(1.0, 0.98, 0.92) },
      },
    });

    this.brightMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: BRIGHT_FRAG,
      depthTest: false, depthWrite: false,
      uniforms: {
        tColor: { value: null },
        uThreshold: { value: RENDER.bloomThreshold },
        uSoftKnee: { value: 0.6 },
      },
    });

    this.blurMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: BLUR_FRAG,
      depthTest: false, depthWrite: false,
      uniforms: { tColor: { value: null }, uDirection: { value: new THREE.Vector2() } },
    });

    this.compositeMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VERT, fragmentShader: COMPOSITE_FRAG,
      depthTest: false, depthWrite: false,
      uniforms: {
        tColor: { value: null }, tBloomA: { value: null }, tBloomB: { value: null },
        uInternalSize: { value: new THREE.Vector2() },
        uSubpixel: { value: new THREE.Vector2() },
        uBloomStrength: { value: RENDER.bloomStrength },
        uExposure: { value: 1 }, uContrast: { value: 1.06 }, uSaturation: { value: 1.12 },
        uTint: { value: new THREE.Color(1, 1, 1) },
        uLift: { value: new THREE.Color(0, 0, 0) },
        uVignette: { value: 0.55 },
        uDither: { value: RENDER.dither ? 1 / 110 : 0 },
        uFlash: { value: 0 },
        uFlashColor: { value: new THREE.Color(1, 0.3, 0.3) },
        uDesaturate: { value: 0 },
      },
    });
  }

  setPixelScale(scale) {
    this.pixelScale = Math.max(1, Math.min(8, Math.round(scale)));
    this.setSize(this.width, this.height);
  }

  setSize(w, h) {
    this.width = Math.max(64, Math.floor(w));
    this.height = Math.max(64, Math.floor(h));
    this.renderer.setSize(this.width, this.height, false);

    let iw = Math.round(this.width / this.pixelScale);
    /* Keep the pixel grid a sane size no matter the window. */
    iw = Math.max(RENDER.minInternalW, Math.min(RENDER.maxInternalW, iw));
    const ih = Math.max(64, Math.round(iw * (this.height / this.width)));
    /* Even dimensions keep the half-resolution bloom chain exact. */
    this.internal.w = iw + (iw & 1);
    this.internal.h = ih + (ih & 1);

    this._allocTargets();
  }

  _allocTargets() {
    const { w, h } = this.internal;
    const dispose = (rt) => { if (rt) { if (rt.depthTexture) rt.depthTexture.dispose(); rt.dispose(); } };
    dispose(this.sceneRT); dispose(this.normalRT); dispose(this.edgeRT);
    dispose(this.bloomA1); dispose(this.bloomA2); dispose(this.bloomB1); dispose(this.bloomB2);

    const common = {
      type: THREE.HalfFloatType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
    };

    this.sceneRT = new THREE.WebGLRenderTarget(w, h, common);

    this.normalRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      stencilBuffer: false,
    });
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    depth.format = THREE.DepthFormat;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    this.normalRT.depthTexture = depth;

    this.edgeRT = new THREE.WebGLRenderTarget(w, h, { ...common, depthBuffer: false });

    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    const qw = Math.max(2, w >> 2), qh = Math.max(2, h >> 2);
    const bloomOpts = { ...common, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.bloomA1 = new THREE.WebGLRenderTarget(hw, hh, bloomOpts);
    this.bloomA2 = new THREE.WebGLRenderTarget(hw, hh, bloomOpts);
    this.bloomB1 = new THREE.WebGLRenderTarget(qw, qh, bloomOpts);
    this.bloomB2 = new THREE.WebGLRenderTarget(qw, qh, bloomOpts);

    this.compositeMat.uniforms.uInternalSize.value.set(w, h);
    this.edgeMat.uniforms.uTexel.value.set(1 / w, 1 / h);
  }

  _blit(material, target) {
    this.quadMesh.material = material;
    this.renderer.setRenderTarget(target || null);
    this.renderer.clear(true, false, false);
    this.renderer.render(this.quadScene, this.quadCamera);
  }

  /* One frame. `subpixel` is the camera's leftover sub-pixel drift,
     in low-resolution texels, which we push back into the upscale so
     the world slides smoothly while the pixels stay on their grid. */
  render(scene, camera, subpixel) {
    const r = this.renderer;
    const { w, h } = this.internal;

    /* --- pass 1: view-space normals + depth, world layer only --- */
    if (!this.normalCamera || this.normalCamera.type !== camera.type) {
      this.normalCamera = camera.clone();
    }
    this.normalCamera.copy(camera);
    this.normalCamera.layers.set(LAYER_WORLD);

    const prevOverride = scene.overrideMaterial;
    const prevBg = scene.background;
    const prevFog = scene.fog;
    scene.overrideMaterial = this.normalMaterial;
    scene.background = null;
    scene.fog = null;
    r.setRenderTarget(this.normalRT);
    r.setClearColor(0x000000, 0);
    r.clear(true, true, false);
    r.render(scene, this.normalCamera);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBg;
    scene.fog = prevFog;

    /* --- pass 2: the lit image, everything visible --- */
    r.setRenderTarget(this.sceneRT);
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(scene, camera);

    /* --- pass 3: outlines --- */
    let lit = this.sceneRT.texture;
    if (this.enabled.outline) {
      const u = this.edgeMat.uniforms;
      u.tColor.value = this.sceneRT.texture;
      u.tNormal.value = this.normalRT.texture;
      u.tDepth.value = this.normalRT.depthTexture;
      u.uNear.value = camera.near;
      u.uFar.value = camera.far;
      /* A silhouette is a depth step much larger than the depth a
         steep surface covers across one pixel, so both the bias and
         the ramp are expressed in pixels of world size. */
      const worldPerPixel = camera.isOrthographicCamera
        ? (camera.top - camera.bottom) / h
        : 0.05;
      u.uDepthBias.value = worldPerPixel * 4.0;
      u.uDepthScale.value = 1 / (worldPerPixel * 6.0);
      this._blit(this.edgeMat, this.edgeRT);
      lit = this.edgeRT.texture;
    }

    /* --- pass 4: bloom, two octaves --- */
    if (this.enabled.bloom) {
      this.brightMat.uniforms.tColor.value = lit;
      this._blit(this.brightMat, this.bloomA1);
      this._blurInto(this.bloomA1, this.bloomA2, 1 / (w >> 1), 1 / (h >> 1));
      this.blurMat.uniforms.tColor.value = this.bloomA1.texture;
      this._blit(this.blurMat, this.bloomB1);          /* downsample */
      this._blurInto(this.bloomB1, this.bloomB2, 1 / (w >> 2), 1 / (h >> 2));
      this.compositeMat.uniforms.tBloomA.value = this.bloomA1.texture;
      this.compositeMat.uniforms.tBloomB.value = this.bloomB1.texture;
      this.compositeMat.uniforms.uBloomStrength.value = RENDER.bloomStrength;
    } else {
      this.compositeMat.uniforms.uBloomStrength.value = 0;
      this.compositeMat.uniforms.tBloomA.value = lit;
      this.compositeMat.uniforms.tBloomB.value = lit;
    }

    /* --- pass 5: grade and upscale straight to the canvas --- */
    const g = this.grade;
    const cu = this.compositeMat.uniforms;
    cu.tColor.value = lit;
    cu.uSubpixel.value.set(subpixel ? subpixel.x : 0, subpixel ? subpixel.y : 0);
    cu.uExposure.value = g.exposure;
    cu.uContrast.value = g.contrast;
    cu.uSaturation.value = g.saturation;
    cu.uTint.value.copy(g.tint);
    cu.uLift.value.copy(g.lift);
    cu.uVignette.value = g.vignette;
    cu.uFlash.value = g.flash;
    cu.uFlashColor.value.copy(g.flashColor);
    cu.uDesaturate.value = g.desaturate;
    cu.uDither.value = this.enabled.dither ? 1 / 110 : 0;
    this._blit(this.compositeMat, null);
    r.setRenderTarget(null);
  }

  _blurInto(rt, tmp, texelX, texelY) {
    this.blurMat.uniforms.tColor.value = rt.texture;
    this.blurMat.uniforms.uDirection.value.set(texelX, 0);
    this._blit(this.blurMat, tmp);
    this.blurMat.uniforms.tColor.value = tmp.texture;
    this.blurMat.uniforms.uDirection.value.set(0, texelY);
    this._blit(this.blurMat, rt);
  }

  dispose() {
    this.renderer.dispose();
    this.quadGeo.dispose();
  }
}
