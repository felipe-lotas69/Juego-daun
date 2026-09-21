/* ============================================================
   rng.js - deterministic randomness

   Every machine in a session generates the same world from the
   same seed, so terrain, props and loot tables must never touch
   Math.random. Everything here is a pure function of its inputs.
   ============================================================ */

/* 32-bit hash of an arbitrary string - used to turn a room code
   like "MOSSGATE" into a world seed. */
export function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/* Mulberry32: small, fast, good enough for a game, and identical
   on every engine because it stays inside 32-bit integer maths. */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const rng = function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.int = (n) => Math.floor(rng() * n);
  rng.range = (lo, hi) => lo + rng() * (hi - lo);
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  rng.sign = () => (rng() < 0.5 ? -1 : 1);
  /* Weighted pick over [{w: n, ...}] */
  rng.weighted = (arr) => {
    let total = 0;
    for (const e of arr) total += e.w;
    let r = rng() * total;
    for (const e of arr) { r -= e.w; if (r <= 0) return e; }
    return arr[arr.length - 1];
  };
  return rng;
}

/* Stateless 2D hash in [0,1) - the backbone of the noise below. */
export function hash2(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 1274126177) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t) { return t * t * (3 - 2 * t); }

/* Value noise. Cheap, and its slightly blobby character suits a
   world that gets quantised onto a tile grid anyway. */
export function noise2(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = smooth(xf), v = smooth(yf);
  const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

/* Fractal brownian motion - layered noise for terrain shape. */
export function fbm(x, y, seed, octaves = 4, lacunarity = 2, gain = 0.5) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += noise2(x * freq, y * freq, seed + i * 7919) * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/* Ridged noise - used for the fault lines that become cliffs. */
export function ridge(x, y, seed, octaves = 3) {
  let sum = 0, amp = 1, freq = 1, norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = 1 - Math.abs(noise2(x * freq, y * freq, seed + i * 5387) * 2 - 1);
    sum += n * n * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/* Worley / cellular noise, returning distance to the nearest
   feature point. Biome blobs and clearings are carved with it. */
export function worley(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let best = 8;
  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = xi + ox, cy = yi + oy;
      const px = cx + hash2(cx, cy, seed);
      const py = cy + hash2(cx, cy, seed + 1013);
      const dx = px - x, dy = py - y;
      const d = dx * dx + dy * dy;
      if (d < best) best = d;
    }
  }
  return Math.sqrt(best);
}
