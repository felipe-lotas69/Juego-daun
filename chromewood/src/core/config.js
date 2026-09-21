/* ============================================================
   config.js - tunables in one place

   Balance numbers, world scale and render settings live here so a
   change is one edit rather than a hunt through the simulation.
   ============================================================ */

export const TILE = 1;                    /* world units per ground tile   */
export const WORLD_TILES = 192;           /* arena is WORLD_TILES square   */
export const WORLD_HALF = (WORLD_TILES * TILE) / 2;
export const CHUNK = 16;                  /* tiles per streamed chunk      */
export const LEVEL_STEP = 0.75;           /* height of one terrain step    */

export const RENDER = {
  pixelScale: 3,          /* screen pixels per rendered pixel              */
  minInternalW: 320,
  maxInternalW: 700,      /* clamp so huge monitors stay chunky            */
  toonBands: 4,
  outline: true,
  outlineAlpha: 0.75,
  bloom: true,
  bloomStrength: 0.85,
  bloomThreshold: 0.62,
  dither: true,
  shadows: true,
  fov: 7.6,               /* orthographic half-height in world units       */
  cameraYaw: Math.PI / 4,
  cameraPitch: Math.atan(1 / Math.SQRT2),  /* true isometric: 35.264 deg   */
};

export const PLAYER = {
  radius: 0.34,
  speed: 6.2,
  accel: 42,
  friction: 26,
  maxHp: 100,
  maxEnergy: 100,
  energyRegen: 9,          /* per second, ramps up when out of combat      */
  shieldMax: 40,
  shieldRegen: 11,
  shieldDelay: 3.2,        /* seconds without damage before shield ticks   */
  chargeMax: 100,
  chargeDrain: 0.82,       /* core charge lost per second                  */
  chargeStarveDps: 3.5,    /* hp lost per second at zero charge            */
  dashSpeed: 19,
  dashTime: 0.17,
  dashCooldown: 1.15,
  downedTime: 22,          /* seconds to bleed out while downed            */
  reviveTime: 3.2,
  respawnTime: 7,
  invulnOnSpawn: 2.5,
  pickupRadius: 1.5,
};

export const XP_CURVE = (level) => Math.floor(38 * Math.pow(level, 1.42) + 22 * level);

export const BEACON = {
  maxHp: 3000,
  radius: 2.2,
  lightRadius: 13,
  repairPerScrap: 26,
  dayRepair: 14,          /* integrity regained per second in daylight */
  structureResist: 0.35,  /* enemies hit structures for a third              */
  healRate: 7,             /* hp per second for players standing inside    */
  chargeRate: 34,          /* core charge per second inside the ring       */
};

export const DAY = {
  dayLength: 108,          /* seconds of daylight                          */
  nightLength: 82,         /* seconds of night                             */
  duskLength: 14,          /* crossfade either side                        */
};

/* Wave pressure ramps with the night number; the director spends a
   budget on enemy types, so later nights mix elites in rather than
   just piling on more of the same. */
export const WAVE = {
  baseBudget: 58,
  budgetGrowth: 1.34,
  spawnInterval: 2.1,
  spawnIntervalMin: 0.55,
  spawnRing: 26,           /* enemies walk in from this far out            */
  eliteFromNight: 3,
  bossEvery: 3,
};

export const COMBAT = {
  critMult: 2.0,
  baseCrit: 0.05,
  hitStop: 0.045,          /* seconds of time dilation on a solid hit      */
  knockbackDecay: 9,
};

export const NET = {
  snapshotHz: 16,
  inputHz: 32,
  interpDelay: 0.11,       /* seconds of buffer for smooth remote motion   */
  timeoutMs: 9000,
};

/* Palette. Kept together so the whole world can be recoloured at
   once, and so the UI can match the 3D scene exactly. */
export const PALETTE = {
  grass: 0x5bbf52,
  grassDark: 0x3f9448,
  grassDry: 0x8fc255,
  dirt: 0x7a4f37,
  dirtDark: 0x5c3928,
  stone: 0x9aa3b2,
  stoneDark: 0x6b7382,
  bloom: 0x9d6ff0,
  bloomLight: 0xc9a6ff,
  cyan: 0x3fe0ff,
  magenta: 0xff4fd8,
  amber: 0xffb03a,
  rust: 0xb8593a,
  chrome: 0xc8d4e2,
  chromeDark: 0x6d7c90,
  void: 0x1a1024,
  sunDay: 0xfff2d0,
  sunDusk: 0xffb178,
  sunNight: 0x8fa8ff,
  skyDay: 0x9fdcff,
  skyNight: 0x141a33,
  fogDay: 0x9fd8c0,
  fogNight: 0x1d2440,
};
