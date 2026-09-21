# CHROMEWOOD

An isometric pixel-art survival RPG for the browser. The forest grew back
through the machines, and something in the rift started sending things out
after dark. You arrive with nothing. Chop, mine, cook, build a camp, repair
the dead beacon, and then go and close the rift.

Solo, or up to four people in the same world.

**Play:** open `index.html` from any static host, or run the bundled server
(below) to get co-op as well.

```
node chromewood/server/server.js      # then open http://localhost:8090/
```

No build step, no `npm install`, no asset pipeline. One vendored copy of
three.js and about fifteen thousand lines of game.

---

## Controls

| | |
|---|---|
| `W` `A` `S` `D` | move — relative to the screen, not to your facing |
| `SHIFT` | sprint (costs stamina) |
| `LMB` | swing what you are holding: chop, mine, hit, or place |
| `RMB` | put down whatever you picked up to build |
| `SPACE` | dash (brief invulnerability) |
| `1`–`6` | hotbar |
| `Q` | eat the best food you are carrying |
| `TAB` | pack — what you have, and what you can make with it |
| `B` | build — everything you are carrying that can be placed |
| `K` | core — the skill tree (needs a lit beacon) |
| `J` | log — objective, gates, contracts, and the forecast |
| `G` | interact — hold to deposit at the beacon, seal a gate, open a cache |
| `E` `R` `F` | ability slots, filled as you unlock them |
| `M` | minimap · `ENTER` chat · `ESC` closes a panel, then pauses |

A gamepad works: left stick moves, right stick aims, triggers swing and dash,
face buttons cast. On a phone the left half of the screen is a stick and the
right half aims and swings.

## The run

You start with your hands, in a clearing, next to a beacon that does not
work. The run has five stages and they hand off to each other.

1. **Survive.** Punch a tree. Wood and fiber make a stone axe and a stone
   pick, which get you stone and ore, which get you a campfire and a
   workbench, which get you everything else. Eat before your food runs out
   and stay near a fire at night or the cold takes your health.
2. **The beacon.** It needs 25 scrap, 20 essence, 25 wood and 25 stone in its
   store. Carry them there and hold `G`. Lighting it wakes your Core, which
   is what abilities run on — until then there is no skill tree, because you
   have nothing to spend points through.
3. **The gates.** Five rift gates open around the map. Standing inside one
   for 75 seconds seals it, and it spends that whole time spawning things at
   you, so you go with walls, turrets and a friend. Each gate sealed makes
   every night after it smaller.
4. **The Heart.** The last gate wakes it at the beacon. It is the only thing
   in the game with a health bar across the top of the screen.
5. **Done.** Kill it and the run is won.

You lose when the beacon's integrity reaches zero. That is the only lose
condition — you dying is a setback, not an ending.

### The map

One procedurally generated island, terraced into nine hard plateaus so cliffs
are cliffs rather than ramps, with mountains, rivers you can wade, and twelve
biomes: Shallows, Shore, Meadow, Chromewood, Pinehold, Crags, Whitecap, Sump,
Bloomwood, Scrapfield, Ashlands and the Plaza in the middle. Where the terrain
would strand you, the generator cuts a staircase rather than a ramp — every
seed is walkable from the beacon to essentially all of it.

What is worth having is further out. Copper and iron are in the crags, gold
and essence deeper, riftglass only near the rift itself.

### Noise

Everything you do is heard. Chopping is quiet; breaking a boulder, running a
forge, and putting up a building are not. The **NOISE** gauge on the clock is
the resonance in the cell you are standing in, and on a hunting night the
things that come out of the rift steer toward the loudest place on the map
rather than the nearest player. A **resonance damper** makes a quiet pocket;
an **echo lure** makes a loud one somewhere you are not.

This is the knob the whole game turns on: you can always work faster, and
working faster is always what gets you found.

### Nights

Eight kinds, dealt from a deck so you get variety without repeats:

**SWARM** (many, small) · **THE HUNT** (few, fast, and they track your noise)
· **SIEGE** (heavy things that come for what you built) · **BLOOM** (the
ground corrupts, and a Bloomheart leads it) · **BLACKOUT** (no light but
yours) · **HARVEST** (fewer enemies, better drops) · **RIFT STORM** ·
**QUIET** (nothing comes — build).

The log tab shows tonight and the two after it, so a siege is something you
prepare for rather than something that happens to you. Weather runs
underneath: rain, fog, ashfall and snowstorm each change what you can see and
how fast you get cold.

### Contracts

Three at a time, rerolled as you finish them — haul timber to the store, get
through a night untouched, bring back eighteen iron. They pay salvage and
experience, and they are the reason to go somewhere other than the safest
place you know.

### Four things want your attention at once

- **Health** comes back slowly, faster when you are well fed.
- **Stamina** pays for swinging and sprinting.
- **Food** falls the whole time. Raw meat is a gamble; cooked is not.
- **Warmth** falls at night, faster in snow, and is restored by fire and by
  daylight. At zero it burns health and slows you down.
- **Energy** pays for abilities, once the beacon is lit.

### Dying

Solo, you drop and respawn at the beacon after seven seconds, minus 40% of the
salvage you were carrying. In co-op you go **down** instead: bleeding out for
22 seconds, revivable by an ally holding `G` over you, or by crawling back to
the beacon. The last player standing gets no down state — if you fall alone,
you are dead.

## Making things

56 items, 37 recipes, 16 buildings. Recipes are gated by the station you are
standing next to — your hands, then a **workbench**, a **forge** for smelting
ore into bars, and an **arcane bench** for anything with essence in it. Tools
come in tiers, and a tier-2 pick is the only way into gold and essence ore.

Buildings are items: you pay for one when you make it, carry it, and put it
down where you want it. Walls, doors and floors, a bedroll to set your
respawn, a chest, torch posts, ward turrets, the damper and lure above, and
the seal pylons that make a gate survivable.

## Getting stronger

**Levels** come from kills, harvesting, building and contracts, shared
generously with the party so nobody falls behind. Each level is one skill
point, spendable only once the beacon is lit.

**The skill tree** has three branches of nine nodes each:

- **ARCANE** — damage, energy, crit, and the loud abilities: Nova, Chain
  Lightning, Rail Lance, Phase Blink, Glyph Trap.
- **CHROME** — plating, shields, cooldowns, and things that fight for you:
  Chrome Sentry, Scrap Drone, Aegis Field, Overclock, Reactive Skin.
- **WILD** — speed, dashes, salvage yield, lifesteal, faster revives, and
  Lifesiphon.

Each branch forks after its first node, so nine points buys you one full path
and the start of the other, not the whole branch.

Abilities drop into the next free slot as you unlock them, up to four.

**The beacon** is upgraded with pooled salvage — whatever anyone drops into
the store goes into the same pot, and everything bought helps everyone: more
integrity, automated turrets, floodlights that enemies will not walk into, a
forge that raises everyone's damage, a repair bay, and a damper that shrinks
night waves.

## Co-op

One player hosts and runs the simulation; everyone else mirrors it. The server
in `server/` only moves messages between people in a room — it simulates
nothing, which keeps it to one file with no dependencies and means solo play
needs no server at all.

1. One player picks **HOST CO-OP** and reads out the five-letter room code.
2. The others type it into **JOIN CODE**, plus the host's address in
   **SERVER** if the game is not being served from the same machine
   (`192.168.1.20:8090`, or a `wss://` URL).

Your own movement is predicted locally and reconciled against the host, so it
never waits for a round trip. Everything else is interpolated an eighth of a
second behind. Snapshots carry players and their packs, enemies, animals,
buildings, pickups, the gates, the contracts and tonight's weather, and run
about 35 KB/s with a night in full swing.

Anything that is not movement — crafting, building, eating, spending a skill
point, buying a beacon upgrade — travels as a named action the host performs
and echoes back in the next snapshot, so there is exactly one authority on
what exists.

If the host disappears, the server promotes someone else and their client
rebuilds the world from the same seed. The run restarts — the relay stores
nothing — but the session survives.

## How it looks like that

The style is 3D rendered small and shown big, not 2D sprites. Four things do
the work:

1. **An orthographic camera** yawed 45° and pitched `atan(1/√2)` — the angle
   that projects a unit cube to the classic 2:1 diamond — rendering to a
   buffer a third of the window's size, upscaled with nearest sampling. The
   camera is snapped to whole rendered pixels so edges never shimmer, and the
   sub-pixel remainder is handed to the upscale shader so motion still looks
   smooth.
2. **Toon shading** through a banded ramp texture, with a rim term that flips
   from a warm sky bounce by day to a cold arcane edge at night so silhouettes
   stay readable once the ground goes dark.
3. **Depth and normal edge detection** in a post pass, lightening the near
   side of an edge and darkening the far side. The depth test is biased by a
   few pixels' worth of world depth, and the normal test only fires on real
   creases — without both, every sloped surface and every facet of a low-poly
   tree reads as an outline and the whole forest glows.
4. **Bloom on what is genuinely bright.** Self-lit geometry is a separate mesh
   per chunk whose vertex colours run past 1.0, so crystals and neon actually
   bloom while the grass does not.
5. **A procedural detail atlas.** Sixty-four 16x16 cells of grain, bark, ore
   speckle, moss and rust, generated at load and multiplied over the vertex
   colour. UVs are box-projected per triangle at build time — per vertex and
   the projection tears inside the triangle and the texture smears. The cells
   store multipliers with headroom above 1.0, so a cell can brighten as well
   as darken.

Outlines are **not white.** The lit side of an edge is the surface's own
colour pushed up with a luminance-weighted bias, and the shadowed side is
tinted toward a cold blue-violet, with only a tenth of a mix toward white.
Chalk-white outlines on everything are the single thing that makes this style
look like a filter rather than a drawing.

Everything is built from boxes, tapers, cones and prisms by
`src/render/geom.js`, with colour baked into the vertices, so a terrain chunk
and all its trees and rocks are a single draw call.

Adapted from the Godot techniques in
[leopeltola/Godot-3d-pixelart-demo](https://github.com/leopeltola/Godot-3d-pixelart-demo),
the [3D pixel art outline shader](https://godotshaders.com/shader/3d-pixel-art-outline-highlight-post-processing-shader/),
[CaptainProton42's flexible toon shader](https://github.com/CaptainProton42/FlexibleToonShaderGD),
and Godot's [advanced post-processing](https://docs.godotengine.org/en/4.4/tutorials/shaders/advanced_postprocessing.html)
notes. The normal edge indicator comes from Kody King's three.js pixel example.

## Layout

```
chromewood/
  index.html  styles.css        the page and the console around the game
  vendor/three.module.js        the only dependency, vendored
  src/
    core/     rng, config, input, audio, small helpers
    world/    worldgen.js       terrain, terracing, rivers, biomes, ore,
                                props, landmarks, connectivity repair
    game/     defs.js           abilities, enemies, skills, beacon upgrades
              items.js          items, tools, buildings, recipes
              creatures.js      animals and the rest of the bestiary
              nights.js         night types, weather, contracts
              survival.js       inventory, harvesting, crafting, placing,
                                hunger and warmth, resonance
              sim.js            the simulation and the five-stage arc
              combat.js         casting, projectiles, damage
              enemyai.js        how the night behaves
              movement.js       shared by the host and the predicting client
    render/   pipeline.js       the two geometry passes and the post chain
              shaders.js        outline, bloom, grade
              textures.js       the procedural detail atlas
              camera.js         the isometric camera and its pixel snapping
              geom.js           the procedural mesh builder
              props.js          what grows and rusts
              structures.js     beacon, rift gates, shrines, caches, wrecks
              buildings.js      everything a player can put down
              worldview.js      chunk streaming
              actors.js         characters, animals, enemies and animation
              materials.js      toon ramp, rim light, detail sampling
              scene.js          lighting and the day/night rig
              fx.js             particles, bolts, beams, blasts
    net/      protocol.js  client.js  mirror.js
    ui/       font.js           a 5x7 bitmap font, drawn from ASCII art
              icons.js          9x9 item icons
              draw.js           plates, bars, slots, buttons
              hud.js  panels.js  menus.js
  server/server.js              rooms, and static files. No dependencies.
  tools/verify.js               the checks below
```

The UI is drawn on the same canvas and the same pixel grid as the world, by
`ui/`, from a hand-written bitmap font and hand-placed icons. Nothing in the
game is HTML except the menus you see before a run starts: a DOM dialog over
pixel art always reads as a different program.


## Checks

```
node chromewood/tools/verify.js
```

Six groups, all of which have caught something real:

- **Content tables.** Every item id named by a drop, recipe, building or
  upgrade cost is a real item; every building is craftable, carryable and
  placeable; a tool exists for every tier the ground asks for; the skill tree
  resolves with no cycles and every ability is reachable.
- **Worlds.** Six seeds: walkable from the beacon, landmarks placed with real
  coordinates, enough terraces and cliff edges to be a landscape, water and a
  river, at least six biomes, enough to harvest, every ore present.
- **The building loop.** Pay a recipe with exactly its cost, carry the
  result, put it down, and confirm an empty pack cannot build.
- **Runs.** Half an hour for one player and for four, driven by a bot that
  actually plays — gathers, crafts, builds, eats, hauls to the beacon —
  checked for throws, NaNs, and step cost.
- **Determinism.** The same seed twice must play out identically. The host
  simulates and everyone else mirrors, so a reproducible host is what makes a
  desync debuggable.
- **The arc and the wire.** A bot has to light the beacon and seal a gate for
  real; then the handoff is driven directly through sealing every gate,
  waking the Heart and winning. Snapshots must round-trip inventory,
  buildings, animals, gates, contracts and the night type into a client's
  mirror.

Things it has caught: landmark coordinates that only existed once something
had been drawn (a headless host with its beacon at `NaN`); allies sliding in
from the middle of the map on the first snapshot after joining; buildings
that were craftable into an inventory with no slot for them; rivers that
stopped after one tile because the channel was cut before the descent was
chosen, so every source read as its own basin; and placement billing the raw
materials a second time instead of consuming the building you were carrying,
which made it impossible to build anything with exactly what it costs.

## Tuning

Almost everything is in `src/core/config.js`: pixel size, camera angle and
zoom, outline and bloom strength, player and beacon numbers, wave growth, day
and night length, hunger and warmth rates, build and station ranges, how loud
each action is, and the palette. Ability and enemy balance is in
`src/game/defs.js`; items, recipes and buildings in `src/game/items.js`;
night types, weather and contracts in `src/game/nights.js`; and what comes
out of the ground in the `HARVEST` table in `src/world/worldgen.js`.

In-game, **SETTINGS** exposes pixel size, zoom, volume, and switches for
outlines, bloom, dithering and shadows — turning shadows off is the biggest
win on a weak machine, then pixel size up.

## Notes

- Needs WebGL2. Works in Firefox, Chrome and Safari.
- Nothing is uploaded anywhere. The only thing stored locally is your name.
- This is a separate game from *Getaway Daun* in the repository root; the two
  share nothing but a repository.
