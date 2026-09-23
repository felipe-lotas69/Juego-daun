/* ============================================================
   sprite.js - the character, drawn flat and stood up in the world

   Everything else here is built out of blocks. The person you play
   is not: they are a pixel sprite on a quad that turns to face the
   camera, which is the oldest trick in 3D and still the one that
   makes a character read at this size. A head made of cubes is a
   cube; a head made of pixels can have a face.

   The sheet is drawn procedurally rather than loaded, for the same
   reason the icons and the font are: no asset pipeline, and the
   player's colour goes in at generation time.

   Five directions are drawn - facing the camera, three quarters,
   side on, three quarters away, and away - and the other three are
   the mirror of the ones that are not symmetrical. Four frames of
   walk each.
   ============================================================ */

export const DIRS = 5;          /* drawn; 8 are shown, 3 by mirroring */
export const FRAMES = 4;
export const CELL_W = 20;
export const CELL_H = 28;

/* Which drawn column each of the eight compass directions uses, and
   whether it is flipped. Index 0 is "toward the camera", going
   clockwise on screen. */
export const DIR_MAP = [
  { col: 0, flip: false },   /* toward camera      */
  { col: 1, flip: false },   /* three quarters     */
  { col: 2, flip: false },   /* side on            */
  { col: 3, flip: false },   /* three quarters away*/
  { col: 4, flip: false },   /* away               */
  { col: 3, flip: true },
  { col: 2, flip: true },
  { col: 1, flip: true },
];

function hex(n) { return '#' + (n >>> 0).toString(16).padStart(6, '0'); }

function shade(n, t) {
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = (v) => Math.max(0, Math.min(255, Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t)));
  return (f(r) << 16) | (f(g) << 8) | f(b);
}

/* One sheet per player colour, built once. */
const sheets = new Map();

export function characterSheet(colors) {
  const key = [colors.body, colors.trim, colors.core,
    colors.plateHead || 0, colors.plateBody || 0, colors.plateLegs || 0].join(':');
  if (sheets.has(key)) return sheets.get(key);

  const cv = document.createElement('canvas');
  cv.width = CELL_W * DIRS;
  cv.height = CELL_H * FRAMES;
  const c = cv.getContext('2d');
  c.imageSmoothingEnabled = false;

  /* A person, not a machine: hair, a shirt in the player's colour,
     work trousers and boots. The player's colour shows up twice -
     the shirt and the kerchief - which is enough to tell four of
     them apart in co-op without anyone glowing. */
  /* What you are wearing goes straight into the palette: a hide vest
     makes the shirt hide-coloured, iron greaves make the trousers
     iron. Cheaper than drawing a second layer, and at twenty pixels
     across it reads exactly the same. */
  const SHIRT = colors.plateBody || colors.body;
  const SHIRT_D = shade(SHIRT, -0.42);
  const SHIRT_L = shade(SHIRT, 0.24);
  const PANT = colors.plateLegs || 0x4c4455;
  const PANT_D = shade(PANT, -0.34);
  const BOOT = 0x3b2c22;
  const BOOT_D = shade(BOOT, -0.3);
  const HAIR = colors.plateHead || 0x4b3626;
  const HAIR_D = shade(HAIR, -0.38);
  const SKIN = 0xe0ab88;
  const SKIN_D = shade(SKIN, -0.26);
  const BELT = colors.trim;
  const SCARF = colors.core;
  const EYE = 0x241c28;
  const LINE = 0x140f1c;

  for (let d = 0; d < DIRS; d++) {
    for (let f = 0; f < FRAMES; f++) {
      drawFrame(c, d * CELL_W, f * CELL_H, d, f, {
        SHIRT, SHIRT_D, SHIRT_L, PANT, PANT_D, BOOT, BOOT_D,
        HAIR, HAIR_D, SKIN, SKIN_D, BELT, SCARF, EYE, LINE,
        HELM: !!colors.plateHead, PLATE: !!colors.plateBody,
      });
    }
  }

  sheets.set(key, cv);
  return cv;
}

/* A single 20x28 frame. Coordinates are whole pixels on purpose:
   this is pixel art, not a small vector drawing.

   The layout is fixed. Feet stay planted at the bottom of the cell
   and the upper body lifts a pixel on the passing frames, which is
   how a walk actually works - bobbing the whole figure makes it
   look like it is skating.

       y 19..25   legs and boots  (never move vertically)
       y  ..18    torso, arms     (lift 1px on frames 1 and 3)
       y  ..9     head            (same lift)
*/
function drawFrame(c, ox, oy, dir, frame, P) {
  const R = (x, y, w, h, col) => {
    if (w <= 0 || h <= 0) return;
    c.fillStyle = hex(col); c.fillRect(ox + x, oy + y, w, h);
  };

  /* Contact, passing, contact, passing. */
  const step = [1, 0, -1, 0][frame];
  const lift = frame % 2 === 1 ? 1 : 0;
  const y0 = 3 - lift;

  const back = dir === 4;
  const side = dir === 2;
  const three = dir === 1 || dir === 3;   /* three-quarter views */

  /* ---- legs, planted -------------------------------------------- */
  const LEG_TOP = 20;
  if (side) {
    /* In profile the legs genuinely swing past each other. */
    const fx = 9 + step, bx = 9 - step;
    R(bx, LEG_TOP, 3, 4, P.PANT_D);
    R(bx, LEG_TOP + 4, 3, 2, P.BOOT_D);
    R(fx, LEG_TOP, 3, 4, P.PANT);
    R(fx, LEG_TOP + 4, 3, 2, P.BOOT);
  } else {
    /* Head on, a swinging leg mostly just comes off the ground. */
    const upL = step > 0 ? 2 : 0;
    const upR = step < 0 ? 2 : 0;
    R(6, LEG_TOP, 3, 4 - upL, P.PANT);
    R(6, LEG_TOP + 4 - upL, 3, 2, P.BOOT);
    R(11, LEG_TOP, 3, 4 - upR, P.PANT);
    R(11, LEG_TOP + 4 - upR, 3, 2, P.BOOT);
    /* the shadow between the legs, so they read as two */
    R(9, LEG_TOP, 2, 2, P.PANT_D);
  }

  /* ---- torso ----------------------------------------------------- */
  const tx = side ? 7 : 6;
  const tw = side ? 6 : 8;
  const TT = y0 + 8;                 /* torso top */
  R(tx, TT, tw, 9, P.SHIRT);
  /* A lit edge on the side the sun comes from and a shaded one
     opposite, so the figure sits in the same light as the world. */
  R(tx + tw - 1, TT + 1, 1, 8, P.SHIRT_L);
  R(tx, TT + 1, 1, 8, P.SHIRT_D);
  /* shoulders */
  R(tx - 1, TT, tw + 2, 2, P.SHIRT_D);
  /* Pauldrons, if there is plate on. */
  if (P.PLATE) {
    R(tx - 1, TT + 2, 2, 2, P.SHIRT_L);
    R(tx + tw - 1, TT + 2, 2, 2, P.SHIRT_L);
  }
  /* belt, then the waistband under it */
  R(tx, TT + 7, tw, 2, P.BELT);

  if (back) {
    /* A pack, so the back is not a blank slab. */
    R(tx + 1, TT + 2, tw - 2, 5, P.BOOT);
    R(tx + 1, TT + 2, tw - 2, 1, P.BOOT_D);
    R(tx + 1, TT + 4, tw - 2, 1, P.BELT);
  }
  /* The kerchief at the throat: small, bright, and the second place
     the player's colour shows. */
  R(tx + 1, TT, tw - 2, 2, P.SCARF);
  if (!back && !side) R(tx + 2, TT + 2, 2, 1, P.SCARF);

  /* ---- arms ------------------------------------------------------ */
  const AT = TT + 2;
  if (side) {
    /* One arm, in front of the body, swinging with the legs. */
    const ax = 9 + step;
    R(ax, AT - step, 3, 4, P.SHIRT_D);
    R(ax, AT - step + 4, 3, 2, P.SKIN);
  } else {
    R(4, AT - step, 2, 4, P.SHIRT_D);
    R(4, AT - step + 4, 2, 2, P.SKIN);
    R(14, AT + step, 2, 4, P.SHIRT);
    R(14, AT + step + 4, 2, 2, P.SKIN);
  }

  /* ---- head ------------------------------------------------------
     How much face shows is the whole difference between the five
     directions; everything else about the head is the same. */
  const HT = y0;
  const hx = side ? 7 : 6;
  const hw = side ? 7 : 8;

  R(hx, HT, hw, 2, P.HAIR);               /* crown */
  R(hx, HT, hw, 1, P.HAIR_D);
  R(hx - 1, HT + 1, hw + 2, 1, P.HAIR);   /* it overhangs the ears */
  if (P.HELM) {
    /* A brow band and a nasal: two rows and one pixel, and a hood
       becomes a helmet. */
    R(hx - 1, HT + 2, hw + 2, 1, P.HAIR_D);
    R(hx + Math.floor(hw / 2), HT + 2, 1, 3, P.HAIR_D);
  }

  if (back) {
    /* Nothing but the back of a head. */
    R(hx, HT + 2, hw, 5, P.HAIR);
    R(hx + 1, HT + 5, hw - 2, 2, P.HAIR_D);
  } else if (dir === 3) {
    /* Three quarters away: hair, and one cheek past it. */
    R(hx, HT + 2, hw, 5, P.HAIR);
    R(hx + hw - 2, HT + 3, 2, 3, P.SKIN);
    R(hx + hw - 2, HT + 5, 2, 1, P.SKIN_D);
  } else if (side) {
    /* Profile: hair at the back, face at the front, nose on the edge. */
    R(hx, HT + 2, hw, 5, P.SKIN);
    R(hx, HT + 2, 3, 5, P.HAIR);
    R(hx + 3, HT + 2, hw - 3, 1, P.HAIR);
    R(hx + 4, HT + 3, 2, 2, P.EYE);
    R(hx + hw - 1, HT + 4, 1, 2, P.SKIN);   /* nose */
    R(hx + 4, HT + 5, 2, 1, P.SKIN_D);      /* mouth */
  } else {
    /* Facing the camera, or three quarters toward it: the whole
       face, with the features shoved a pixel toward the direction
       being looked in. */
    const off = three ? 1 : 0;
    R(hx, HT + 2, hw, 5, P.SKIN);
    R(hx, HT + 2, 1 + (off ? 1 : 0), 3, P.HAIR);     /* side locks */
    R(hx + hw - 1, HT + 2, 1, 3, P.HAIR);
    R(hx + 1 + off, HT + 3, 2, 2, P.EYE);
    R(hx + 5, HT + 3, 2, 2, P.EYE);
    R(hx + 3 + off, HT + 5, 2, 1, P.SKIN_D);         /* mouth */
  }

  /* ---- outline ---------------------------------------------------
     A dark edge all the way round, found from what has been drawn
     rather than hand-placed, so it stays right whatever the frame
     looks like. */
  const img = c.getImageData(ox, oy, CELL_W, CELL_H);
  const px = img.data;
  const at = (x, y) => (y * CELL_W + x) * 4;
  const solid = (x, y) => x >= 0 && y >= 0 && x < CELL_W && y < CELL_H && px[at(x, y) + 3] > 0;
  const edge = [];
  for (let y = 0; y < CELL_H; y++) {
    for (let x = 0; x < CELL_W; x++) {
      if (solid(x, y)) continue;
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)) edge.push([x, y]);
    }
  }
  c.fillStyle = hex(P.LINE);
  for (const [x, y] of edge) c.fillRect(ox + x, oy + y, 1, 1);
}

/* Which of the eight directions a facing angle falls into, given the
   camera's yaw: the sprite turns relative to the screen, not to the
   world, or walking north-east would show you a profile. */
export function dirIndex(facing, cameraYaw) {
  const TAU = Math.PI * 2;
  /* A facing of f points along (sin f, 0, -cos f); the camera looks
     down (-sin yaw, 0, -cos yaw). Resolving one against the other
     gives a screen angle of pi - f - yaw, which is 0 when the
     character walks toward the viewer and grows as they turn to the
     right of the screen - the order DIR_MAP is written in. */
  let a = Math.PI - facing - cameraYaw;
  a = ((a % TAU) + TAU) % TAU;
  return Math.round(a / (TAU / 8)) % 8;
}
