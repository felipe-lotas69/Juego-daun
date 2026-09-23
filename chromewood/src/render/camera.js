/* ============================================================
   camera.js - the isometric camera

   Orthographic, yawed 45 degrees and pitched atan(1/sqrt2), which
   is the angle that makes a unit cube project to the classic 2:1
   diamond. The camera is snapped to whole rendered pixels so that
   edges never shimmer; the fraction it was snapped by is handed to
   the upscale shader, so motion still looks smooth.
   ============================================================ */

import * as THREE from '../../vendor/three.module.js';
import { RENDER } from '../core/config.js';
import { damp, clamp } from '../core/util.js';
import { LAYER_NO_OUTLINE } from './pipeline.js';

const UP = new THREE.Vector3(0, 1, 0);

export class IsoCamera {
  constructor() {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 260);
    this.camera.layers.enable(LAYER_NO_OUTLINE);

    this.yaw = RENDER.cameraYaw;
    this.pitch = RENDER.cameraPitch;
    this.distance = 52;
    this.zoom = RENDER.fov;
    this.zoomTarget = RENDER.fov;

    this.target = new THREE.Vector3();
    this.smoothed = new THREE.Vector3();
    this.lookAhead = new THREE.Vector2();

    this.shake = 0;
    this.shakeTime = 0;
    this.offset = new THREE.Vector3();
    this.subpixel = new THREE.Vector2();

    this.dir = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.up = new THREE.Vector3();
    this._raycaster = new THREE.Raycaster();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this._hit = new THREE.Vector3();
    this._updateBasis();
    this.aspect = 16 / 9;
    this.internalH = 270;
  }

  _updateBasis() {
    const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    this.dir.set(cp * Math.sin(this.yaw), sp, cp * Math.cos(this.yaw)).normalize();
    /* forward is -dir; build an orthonormal screen basis from it */
    const fwd = this.dir.clone().negate();
    this.right.copy(fwd).cross(UP).normalize();
    this.up.copy(this.right).clone().cross(fwd).normalize();
    this.up.crossVectors(this.right, fwd).normalize();
  }

  setViewport(aspect, internalH) {
    this.aspect = aspect;
    this.internalH = internalH;
    this._applyFrustum();
  }

  _applyFrustum() {
    const h = this.zoom, w = h * this.aspect;
    const c = this.camera;
    c.left = -w; c.right = w; c.top = h; c.bottom = -h;
    c.near = 0.1; c.far = this.distance * 2.4;
    c.updateProjectionMatrix();
  }

  setZoom(z) { this.zoomTarget = clamp(z, 5, 26); }
  nudgeZoom(delta) { this.setZoom(this.zoomTarget + delta); }

  addShake(amount) { this.shake = Math.min(1.6, this.shake + amount); }

  snapTo(x, y, z) {
    this.target.set(x, y, z);
    this.smoothed.copy(this.target);
  }

  /* `aim` is a world-space point the player is looking at; the view
     leans a little towards it so you can see what you are shooting. */
  update(dt, targetPos, aim) {
    if (targetPos) this.target.copy(targetPos);

    if (aim) {
      const dx = clamp((aim.x - this.target.x) * 0.22, -3.2, 3.2);
      const dz = clamp((aim.z - this.target.z) * 0.22, -3.2, 3.2);
      this.lookAhead.x = damp(this.lookAhead.x, dx, 5, dt);
      this.lookAhead.y = damp(this.lookAhead.y, dz, 5, dt);
    } else {
      this.lookAhead.x = damp(this.lookAhead.x, 0, 5, dt);
      this.lookAhead.y = damp(this.lookAhead.y, 0, 5, dt);
    }

    this.smoothed.x = damp(this.smoothed.x, this.target.x + this.lookAhead.x, 11, dt);
    this.smoothed.y = damp(this.smoothed.y, this.target.y, 8, dt);
    this.smoothed.z = damp(this.smoothed.z, this.target.z + this.lookAhead.y, 11, dt);

    this.zoom = damp(this.zoom, this.zoomTarget, 7, dt);
    this._applyFrustum();

    /* Shake decays fast and shakes along the screen axes, so it
       never looks like the world tilted. */
    this.shakeTime += dt;
    this.shake = Math.max(0, this.shake - dt * 2.6);
    const s = this.shake * this.shake;
    const sx = Math.sin(this.shakeTime * 61.0) * s * 0.55;
    const sy = Math.cos(this.shakeTime * 47.3) * s * 0.55;

    const focus = this.smoothed;
    const pos = this.camera.position;
    pos.copy(this.dir).multiplyScalar(this.distance).add(focus);
    pos.addScaledVector(this.right, sx);
    pos.addScaledVector(this.up, sy);

    /* --- pixel snap --------------------------------------------- */
    const unitsPerPixel = (this.zoom * 2) / this.internalH;
    const pr = pos.dot(this.right), pu = pos.dot(this.up);
    const sr = Math.round(pr / unitsPerPixel) * unitsPerPixel;
    const su = Math.round(pu / unitsPerPixel) * unitsPerPixel;
    pos.addScaledVector(this.right, sr - pr);
    pos.addScaledVector(this.up, su - pu);
    this.subpixel.set((pr - sr) / unitsPerPixel, (pu - su) / unitsPerPixel);

    this.camera.up.copy(UP);
    this.camera.lookAt(pos.x - this.dir.x, pos.y - this.dir.y, pos.z - this.dir.z);
    this.camera.updateMatrixWorld();
  }

  /* Screen point in normalised device coords -> the point on the
     horizontal plane at height `y`. Everything aims with this. */
  screenToGround(ndcX, ndcY, y = 0) {
    this._raycaster.setFromCamera({ x: ndcX, y: ndcY }, this.camera);
    this._plane.constant = -y;
    const hit = this._raycaster.ray.intersectPlane(this._plane, this._hit);
    return hit ? hit.clone() : new THREE.Vector3(this.target.x, y, this.target.z);
  }

  worldToScreen(v, out) {
    const p = (out || new THREE.Vector3()).copy(v).project(this.camera);
    return p;
  }

  /* Move vector from screen space (up on the stick = away from the
     camera) into world space. */
  screenToWorldDir(x, y, out) {
    const o = out || new THREE.Vector3();
    /* Screen up maps to world -dir flattened onto the ground. */
    const fx = -this.dir.x, fz = -this.dir.z;
    const fl = Math.hypot(fx, fz) || 1;
    const fwdX = fx / fl, fwdZ = fz / fl;
    const rightX = this.right.x, rightZ = this.right.z;
    const rl = Math.hypot(rightX, rightZ) || 1;
    o.set(x * (rightX / rl) + (-y) * fwdX, 0, x * (rightZ / rl) + (-y) * fwdZ);
    return o;
  }
}
