/* ============================================================
   shaders.js - the post-processing chain

   The 3D-pixel-art look is four ideas stacked:

     1. render the world small, with an orthographic isometric
        camera, and upscale with nearest sampling;
     2. detect edges from the depth and normal buffers, then
        lighten the near side of an edge and darken the far side,
        which reads as a hand-drawn outline;
     3. bloom only what is genuinely bright, so arcane and neon
        emitters glow without fogging the whole frame;
     4. grade, vignette and ordered-dither in the low-resolution
        grid so the banding lands on pixel boundaries.

   The edge pass is a port of the Godot spatial shader in the
   tutorial project (depth + normal edge detection, with the
   normal edge indicator from the three.js pixel example).
   ============================================================ */

export const FULLSCREEN_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

/* ------------------------------------------------------------ outlines */
export const EDGE_FRAG = /* glsl */`
  #include <packing>

  uniform sampler2D tColor;
  uniform sampler2D tNormal;
  uniform sampler2D tDepth;
  uniform vec2  uTexel;
  uniform float uNear;
  uniform float uFar;
  uniform float uLineAlpha;
  uniform float uHighlight;
  uniform float uShadow;
  uniform float uDepthScale;
  uniform float uDepthBias;
  uniform vec3  uOutlineTint;
  varying vec2 vUv;

  float linearDepth(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    /* Orthographic projection: depth is already linear in view
       space, so this is a rescale rather than a reciprocal. */
    return -orthographicDepthToViewZ(d, uNear, uFar);
  }

  vec3 getNormal(vec2 uv) {
    return texture2D(tNormal, uv).rgb * 2.0 - 1.0;
  }

  /* From the three.js pixel example by Kody King: a normal
     discontinuity only counts as a line when it also sits on the
     near side of a depth step, which kills the noise you get on
     curved surfaces. */
  float normalEdgeIndicator(vec3 bias, vec3 n, vec3 nb, float depthDiff) {
    float normalDifference = dot(n - nb, bias);
    float normalIndicator = clamp(smoothstep(-0.01, 0.01, normalDifference), 0.0, 1.0);
    float depthIndicator = clamp(sign(depthDiff * 0.25 + 0.0025), 0.0, 1.0);
    return (1.0 - dot(n, nb)) * depthIndicator * normalIndicator;
  }

  void main() {
    vec4 src = texture2D(tColor, vUv);
    vec4 normalSample = texture2D(tNormal, vUv);

    /* Alpha of the normal buffer is the geometry mask: the sky and
       anything flagged "no outline" is left alone. */
    float mask = step(0.5, normalSample.a);
    if (mask < 0.5) { gl_FragColor = src; return; }

    vec2 offs[4];
    offs[0] = vUv + vec2(0.0, -1.0) * uTexel;
    offs[1] = vUv + vec2(0.0,  1.0) * uTexel;
    offs[2] = vUv + vec2( 1.0, 0.0) * uTexel;
    offs[3] = vUv + vec2(-1.0, 0.0) * uTexel;

    float depth = linearDepth(vUv);
    float depthDifference = 0.0;
    float invDepthDifference = 0.5;

    for (int i = 0; i < 4; i++) {
      float neighbourMask = step(0.5, texture2D(tNormal, offs[i]).a);
      float d = mix(depth, linearDepth(offs[i]), neighbourMask);
      /* The bias is a few pixels' worth of world depth. Without it
         every sloped surface reads as an edge, because neighbouring
         pixels on a steep cone differ in depth as much as a real
         silhouette does. */
      depthDifference += clamp((d - depth - uDepthBias) * uDepthScale, 0.0, 1.0);
      invDepthDifference += (depth - d - uDepthBias) * uDepthScale;
    }
    invDepthDifference = clamp(invDepthDifference, 0.0, 1.0);
    invDepthDifference = clamp(smoothstep(0.9, 0.9, invDepthDifference) * 10.0, 0.0, 1.0);
    depthDifference = smoothstep(0.25, 0.65, depthDifference);

    vec3 n = getNormal(vUv);
    vec3 bias = vec3(1.0, 1.0, 1.0);
    float normalDifference = 0.0;
    for (int i = 0; i < 4; i++) {
      float neighbourMask = step(0.5, texture2D(tNormal, offs[i]).a);
      vec3 nb = mix(n, getNormal(offs[i]), neighbourMask);
      normalDifference += normalEdgeIndicator(bias, n, nb, depthDifference);
    }
    /* Only genuine creases count. A seven-sided cone bends about
       50 degrees per facet, which lands near 0.37 here; a real box
       corner lands at 1.0. Threshold between the two or every
       faceted tree lights up like a lantern. */
    normalDifference = smoothstep(0.52, 0.66, normalDifference);
    normalDifference = clamp(normalDifference - invDepthDifference, 0.0, 1.0);

    vec3 col = src.rgb;
    float highlight = clamp(normalDifference - depthDifference, 0.0, 1.0) * uHighlight * uLineAlpha;
    float shade     = depthDifference * uShadow * uLineAlpha;

    col += uOutlineTint * highlight * (0.35 + 0.65 * max(max(col.r, col.g), col.b));
    col -= col * shade;

    gl_FragColor = vec4(col, src.a);
  }
`;

/* ------------------------------------------------------------ bloom */
export const BRIGHT_FRAG = /* glsl */`
  uniform sampler2D tColor;
  uniform float uThreshold;
  uniform float uSoftKnee;
  varying vec2 vUv;

  void main() {
    vec3 c = texture2D(tColor, vUv).rgb;
    float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));
    float knee = uThreshold * uSoftKnee + 1e-5;
    float soft = clamp(lum - uThreshold + knee, 0.0, 2.0 * knee);
    soft = soft * soft / (4.0 * knee);
    float contrib = max(soft, lum - uThreshold) / max(lum, 1e-5);
    gl_FragColor = vec4(c * contrib, 1.0);
  }
`;

export const BLUR_FRAG = /* glsl */`
  uniform sampler2D tColor;
  uniform vec2 uDirection;   /* texel-sized step, one axis at a time */
  varying vec2 vUv;

  void main() {
    /* Nine-tap gaussian folded into five bilinear fetches. */
    vec3 sum = texture2D(tColor, vUv).rgb * 0.2270270270;
    vec2 o1 = uDirection * 1.3846153846;
    vec2 o2 = uDirection * 3.2307692308;
    sum += texture2D(tColor, vUv + o1).rgb * 0.3162162162;
    sum += texture2D(tColor, vUv - o1).rgb * 0.3162162162;
    sum += texture2D(tColor, vUv + o2).rgb * 0.0702702703;
    sum += texture2D(tColor, vUv - o2).rgb * 0.0702702703;
    gl_FragColor = vec4(sum, 1.0);
  }
`;

/* ------------------------------------------- composite, grade, upscale */
export const COMPOSITE_FRAG = /* glsl */`
  uniform sampler2D tColor;
  uniform sampler2D tBloomA;
  uniform sampler2D tBloomB;
  uniform vec2  uInternalSize;
  uniform vec2  uSubpixel;      /* sub-pixel camera drift, in texels    */
  uniform float uBloomStrength;
  uniform float uExposure;
  uniform float uContrast;
  uniform float uSaturation;
  uniform vec3  uTint;
  uniform vec3  uLift;
  uniform float uVignette;
  uniform float uDither;
  uniform float uFlash;         /* full-screen damage / heal flash       */
  uniform vec3  uFlashColor;
  uniform float uDesaturate;    /* rises while downed                    */
  varying vec2 vUv;

  /* 4x4 Bayer matrix, evaluated on the low-resolution grid so the
     dither pattern is locked to the art's pixels. */
  float bayer(vec2 p) {
    vec2 m = mod(floor(p), 4.0);
    int idx = int(m.x) + int(m.y) * 4;
    float t[16];
    t[0]=0.0;   t[1]=8.0;  t[2]=2.0;  t[3]=10.0;
    t[4]=12.0;  t[5]=4.0;  t[6]=14.0; t[7]=6.0;
    t[8]=3.0;   t[9]=11.0; t[10]=1.0; t[11]=9.0;
    t[12]=15.0; t[13]=7.0; t[14]=13.0; t[15]=5.0;
    float v = 0.0;
    for (int i = 0; i < 16; i++) { if (i == idx) v = t[i]; }
    return v / 16.0 - 0.5;
  }

  void main() {
    vec2 uv = vUv + uSubpixel / uInternalSize;
    vec2 pixel = uv * uInternalSize;

    vec3 col = texture2D(tColor, uv).rgb;
    vec3 bloom = texture2D(tBloomA, uv).rgb * 0.62 + texture2D(tBloomB, uv).rgb * 0.38;
    col += bloom * uBloomStrength;

    col *= uExposure;
    col = col / (1.0 + col * 0.42);            /* gentle filmic shoulder */

    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(lum), col, uSaturation * (1.0 - uDesaturate));
    col = (col - 0.5) * uContrast + 0.5;
    col *= uTint;
    col += uLift;

    col = mix(col, uFlashColor, uFlash);

    /* Vignette in low-res space, so its falloff also dithers. */
    vec2 vg = (uv - 0.5) * vec2(1.0, uInternalSize.y / uInternalSize.x);
    float v = 1.0 - dot(vg, vg) * uVignette;
    col *= clamp(v, 0.0, 1.0);

    col += bayer(pixel) * uDither;
    col = max(col, vec3(0.0));

    gl_FragColor = vec4(col, 1.0);
    #include <colorspace_fragment>
  }
`;
