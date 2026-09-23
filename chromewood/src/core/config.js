/* ============================================================
   config.js - tunables in one place

   Balance numbers, world scale and render settings live here so a
   change is one edit rather than a hunt through the simulation.
   ============================================================ */

export const TILE = 1;                    /* world units per ground tile   */
export const WORLD_TILES = 224;           /* arena is WORLD_TILES square   */
export const WORLD_HALF = (WORLD_TILES * TILE) / 2;
export const CHUNK = 16;                  /* tiles per streamed chunk      */
/* One terrain step is most of a tile tall. Shorter than this and a
   nine-level island is a gentle slope seen from above: the cliffs
   stop reading as cliffs and the whole landscape flattens out into
   a map of itself. */
export const LEVEL_STEP = 0.80;

export const RENDER = {
  pixelScale: 3,          /* screen pixels per rendered pixel              */
  detail: 1.45,            /* atlas contrast; above 1 extrapolates the mix  */
  minInternalW: 320,
  maxInternalW: 860,      /* clamp so huge monitors stay chunky            */
  toonBands: 4,
  outline: true,
  outlineAlpha: 0.58,
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
  /* Crisper than it was. At 42 and 26 the character took a beat to
     get going and slid a beat after you let go, which at this camera
     angle reads as lag rather than as weight. */
  accel: 56,
  friction: 36,
  maxHp: 120,
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

/* ------------------------------------------------------- survival */
export const SURVIVAL = {
  /* Swimming. Slow enough that a boat would be nice and fast enough
     that crossing a river is a decision rather than a detour, and
     costly enough that the far side of the bay is a real distance. */
  swimSpeed: 0.62,
  swimStamina: 7.5,        /* per second in deep water */
  swimDepth: 0.55,         /* how far under the surface you ride  */
  baseReach: 1.7,
  swingsPerSecond: 1.6,
  swingStamina: 7,
  fistPower: 7,             /* how much a bare hand takes off a tree */
  fistDamage: 8,
  maxStamina: 100,
  staminaRegen: 26,
  sprintStamina: 14,        /* per second while sprinting            */
  sprintSpeed: 1.42,
  maxHunger: 100,
  hungerRate: 0.17,         /* per second: about ten minutes a meal   */
  starveDamage: 2,
  fedRegen: 0.8,
  maxWarmth: 100,
  coldNight: 1.15,          /* warmth lost per second on a cold night */
  coldSnow: 3.0,
  fireWarmth: 14,
  dayWarmth: 7,             /* recovery out of the cold               */
  freezeDamage: 2.5,
  stationRange: 4.2,
  buildRange: 7.0,
  pickupRange: 1.9,
  depositRange: 5.0,
};

/* Everything you do is heard. This is the knob that decides how
   much, and how long the rift remembers it. */
export const RESONANCE = {
  cellTiles: 4,
  max: 260,
  decay: 0.020,             /* per second, exponential              */
  threshold: 18,            /* below this the rift is not interested */
  perSwing: 1.2,
  perHarvest: 2.6,
  perBreak: 12,
  perBuild: 14,
  perCraft: 5,              /* per second while crafting            */
  perShot: 2.2,
  perBlast: 16,
  perForge: 9,              /* per second while a forge is lit      */
  beacon: 34,               /* a lit beacon is loud by nature       */
  lureRange: 30,
};

/* The rift-gate set pieces: plant a pylon, hold the ground. */
export const GATE = {
  sealTime: 75,             /* seconds of holding the gate          */
  radius: 9,
  waveInterval: 7.5,
  budgetBase: 90,
  budgetPerGate: 55,
  rewardCores: 2,
  pressureCut: 0.15,        /* night budget cut per gate sealed     */
};

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
  concurrentCap: 34,       /* enemies alive at once, before players   */
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
