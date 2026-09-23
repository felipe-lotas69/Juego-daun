## 12. The HUD layout (frozen — this is what the player asked for)

The current HUD does not match what was asked for. This layout is now the target, and it is
taken from the reference screenshots the player supplied. Read them as a spec, not a mood board.

```
 ┌────────────────────────────────────────────────────────────────────────────┐
 │ RESOURCES        [ colonist ][ colonist ][ colonist ]          ALERTS      │
 │ (top left,       (top centre, a small box per colonist)        (right edge,│
 │  vertical list                                                  stacked,   │
 │  icon + count)                                                  clickable) │
 │                                                                            │
 │                              W O R L D                          LETTERS    │
 │                                                                 (right)    │
 │                                                                            │
 │                                                                            │
 │ messages                                                    date · time ·  │
 │ (bottom left, fading)                                       speed (btm rt) │
 │ ┌──────────┬──────────────────────────────────────────┐                    │
 │ │ Orders   │  [icon][icon][icon][icon][icon][icon]    │                    │
 │ │ Zone     │  [icon][icon][icon][icon][icon][icon]    │   the command grid │
 │ │ Structure│                                          │   for the selected │
 │ │ Production│                                         │   category         │
 │ │ Furniture│                                          │                    │
 │ │ Power    │                                          │                    │
 │ │ Security │                                          │                    │
 │ │ Floors   │                                          │                    │
 │ │ Misc     │                                          │                    │
 │ └──────────┴──────────────────────────────────────────┘                    │
 │ [Architect] [Work] [Schedule] [Assign] [Animals] [Research] [World] [Menu]  │
 └────────────────────────────────────────────────────────────────────────────┘
```

Rules that come out of that:
- **Architect categories run DOWN the left in a single vertical column**, not wrapped in rows.
  Selecting one fills the command grid to its right. A search box sits above the column.
- **A full-width tab bar along the very bottom** is the primary navigation: Architect, Work,
  Schedule, Assign, Animals, Research, World, Menu. The active tab is visibly active.
- **Resources are a vertical list at the top left**: a small icon and a count per resource the
  colony actually holds (wood, steel, components, silver, cloth, leather, medicine, meals, raw
  food, stone blocks…). Hidden when the colony has none of it. This does not exist today at all
  and is the single most asked-for missing readout.
- **Colonist boxes across the top centre**: one small box per colonist with their portrait,
  name, and bars for health and mood. Click selects, click again jumps the camera. A drafted,
  downed or breaking colonist is obvious at a glance.
- **Alerts stack down the right edge**, letters below them, both clickable to jump.
- **Date, time and speed controls sit at the bottom right**, not in a top bar.
- The top bar as it exists now goes away; nothing should span the full width at the top except
  the three groups named above.

## 13. Visual direction (the art is too noisy)

The player's words: *"the thing has too many pixels and it looks kind of crisp"*. They are right,
and both halves are fixable:

**Too many pixels** — the terrain is speckled with high-frequency noise: grass tufts on every
cell, per-pixel dither everywhere, a different variant shouting from every tile. The eye cannot
rest anywhere and the map reads as static rather than ground. Calm it down:
- Far fewer, larger, softer marks per tile. Ground is mostly a quiet field of colour with a
  little variation, and detail is the exception that draws the eye to something that matters.
- Variation should work at the scale of several tiles, not one — patches, not per-cell noise.
- Reserve visual busy-ness for things the player must notice: a pawn, an item, a fire, a
  designation. If the ground competes with them, the ground is wrong.

**Too crisp** — hard aliased edges everywhere, terrain meeting terrain in a stair-stepped
rectangle, water hitting land at a right angle. Soften it:
- Blend adjacent terrains at their boundary rather than butting them together: an edge mask, a
  scatter of the neighbour's colour across the seam, or a soft alpha ramp — anything but a
  straight line between two flat fields.
- Shorelines, cliff edges and floor-to-ground transitions all need this most.
- Keep sprites readable: soften the *ground*, not the silhouettes of things standing on it.

The palette should stay flat and muted, closer to a painted board game than a neon tile set.
Contrast belongs to what is interactive. Nothing in the world layer should be pure black or
pure white.
## 16. Matching the original game's look

The player supplied screenshots of the game this one is modelled on and asked that the design
match it. Here is what those screenshots actually show, as a spec.

### The UI chrome
- **Panels are dark, near-black, slightly translucent over the world**, with a thin lighter
  hairline border — not opaque grey slabs. The world should be faintly visible behind a panel
  edge. No drop shadows, no gradients, no rounded corners beyond 2px.
- **Text is small, light grey-white, and dense.** The original packs a lot of information into
  little space and trusts the player to read it. Our current panels are roomier than the
  original and the type is larger; tighten both. A row in a list is about 20px tall, not 30.
- **The accent is a warm yellow-gold**, used for the active tab, a selected category, a
  highlighted value and nothing else. Red is danger and alerts only. Green is positive values
  only. A panel that uses four accent colours has none.
- **Buttons are flat rectangles with a hairline border** that lighten on hover. Not filled
  blocks, not pills.

### The architect, specifically
The original's build menu is a **two-column grid of category buttons**, not a single column:
Orders / Zone, Structure / Production, Storage / Furniture, Power / Security, Misc / Floors,
and so on, with a search field beneath them. Selecting one opens a row of command buttons above
the bottom bar, each an **icon with its label underneath it**, in a grid that wraps. Change our
single column to the two-column grid, because that is what the reference shows.

### The bottom bar
A row of text tabs spanning the width, the active one marked. Beside them at the right, small
icon buttons. This we already have.

### The top strip
Resources at the far left as small icon-and-count rows. Colonist portraits centred, each a small
box with the pawn's face, a name, and thin bars. Alerts as short coloured lines down the right
edge — the original writes them as plain coloured text with a small icon, not as bordered cards.

### The world
- The original's ground is **warm and muted**: browns and olive greens, low saturation, nothing
  neon. Water is a muted blue-green, not a bright blue. Stone is warm grey, not blue-grey.
- Terrain reads as **soft and painterly at a distance** with detail that only resolves close up.
- Things standing on the ground carry a **soft dark contact shadow** and read clearly against it.
- The night tint is a deep desaturated blue, and lamplight is warm and pools softly.

Where our palette is more saturated or cooler than that, pull it toward warm and muted. The
picture should look like weathered ground in afternoon light, not a colour swatch.
