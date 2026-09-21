# CHROMEWOOD

An isometric pixel-art survival RPG for the browser. The forest grew back
through the machines, and something in the rift started sending things out
after dark. Hold the beacon, salvage what you can while it is light, and come
back stronger.

Solo, or up to four people in the same world.

**Play:** open `index.html` from any static host, or run the bundled server
(below) to get co-op as well.

```
node chromewood/server/server.js      # then open http://localhost:8090/
```

No build step, no `npm install`, no asset pipeline. One vendored copy of
three.js and about six thousand lines of game.

---

## Controls

| | |
|---|---|
| `W` `A` `S` `D` | move — relative to the screen, not to your facing |
| mouse / `LMB` | aim and fire |
| `SPACE` | dash (brief invulnerability) |
| `Q` `E` `R` `F` | ability slots, filled as you unlock them |
| `G` | interact — beacon console, shrines, caches, **and reviving a downed ally** |
| `TAB` | skill tree |
| `M` | look at the minimap |
| `ENTER` | chat · `ESC` pause · mouse wheel zooms |

A gamepad works: left stick moves, right stick aims, triggers fire and dash,
face buttons cast. On a phone the left half of the screen is a stick and the
right half aims and fires.

## The run

A run is a sequence of days and nights on one procedurally generated map.

**Day (108s)** is yours. Break crystals and scrap piles for salvage, open
caches, touch a shrine for a minute-long boon, and spend what you find at the
beacon. You can go as far out as you dare — the map gets more corrupted, and
more valuable, the further you get from the middle.

**Night (82s)** comes out of the rift gates. Enemies walk in and head for
whoever is closest, or for the beacon if nobody is. Every third night brings
a boss. Wave size grows about 34% per night and mixes in heavier types and
elites as it goes.

You lose when the beacon's integrity reaches zero. That is the only lose
condition — you dying is a setback, not an ending.

### Four things want your attention at once

- **Health** comes back slowly; the beacon heals you if you stand in it.
- **Shield** absorbs damage first and recharges a few seconds after you stop
  being hit, which rewards disengaging.
- **Energy** pays for abilities and regenerates constantly.
- **Core charge** drains the whole time you are alive, everywhere. At zero it
  burns your health. Essence tops it up, and so does standing at the beacon —
  so a long trip out has a hard clock on it that is nothing to do with combat.

### Dying

Solo, you drop and respawn at the beacon after seven seconds, minus 40% of the
salvage you were carrying. In co-op you go **down** instead: bleeding out for
22 seconds, revivable by an ally holding `G` over you, or by crawling back to
the beacon. The last player standing gets no down state — if you fall alone,
you are dead.

## Getting stronger

**Levels** come from kills (shared generously with the party, so nobody falls
behind). Each level is one skill point.

**The skill tree** has three branches of nine nodes each:

- **ARCANE** — damage, energy, crit, and the loud abilities: Nova, Chain
  Lightning, Rail Lance, Phase Blink, Glyph Trap.
- **CHROME** — plating, shields, cooldowns, and things that fight for you:
  Chrome Sentry, Scrap Drone, Aegis Field, Overclock, Reactive Skin.
- **WILD** — speed, dashes, salvage yield, lifesteal, faster revives, and
  Lifesiphon.

Abilities drop into the next free slot as you unlock them, up to four.

**The beacon** is upgraded with pooled salvage — whatever anyone picks up goes
into the same pot, and everything bought helps everyone: more integrity,
automated turrets, floodlights that enemies will not walk into, a forge that
raises everyone's damage, a repair bay, and a damper that shrinks night waves.

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
second behind. Snapshots run about 12 KB/s with a night in full swing.

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
    world/    worldgen.js       seeded terrain, biomes, props, landmarks
    game/     defs.js           every ability, enemy, skill and upgrade
              sim.js            the simulation
              combat.js         casting, projectiles, damage
              enemyai.js        how the night behaves
              movement.js       shared by the host and the predicting client
    render/   pipeline.js       the two geometry passes and the post chain
              shaders.js        outline, bloom, grade
              camera.js         the isometric camera and its pixel snapping
              geom.js           the procedural mesh builder
              props.js          what grows and rusts
              structures.js     beacon, rift gates, shrines, caches, wrecks
              worldview.js      chunk streaming
              actors.js         characters and their animation
              materials.js      toon ramp, rim light
              scene.js          lighting and the day/night rig
              fx.js             particles, bolts, beams, blasts
    net/      protocol.js  client.js  mirror.js
    ui/       hud.js  menus.js
  server/server.js              rooms, and static files. No dependencies.
  tools/verify.js               the checks below
```

## Checks

```
node chromewood/tools/verify.js
```

Validates that the content tables refer to each other and every ability is
reachable from the skill tree; that generated maps are walkable from the
beacon and carry their landmarks; that a half-hour run for one and for four
players simulates without throwing, without producing a NaN, and fast enough
to leave room for rendering; and that a snapshot survives the round trip into
a client's mirror.

Both bugs it has caught so far were real: landmark coordinates that only
existed once something had been drawn (which left a headless host with its
beacon at `NaN`), and allies sliding in from the middle of the map on the
first snapshot after joining.

## Tuning

Almost everything is in `src/core/config.js`: pixel size, camera angle and
zoom, outline and bloom strength, player and beacon numbers, wave growth, day
and night length, and the palette. Balance is in `src/game/defs.js`.

In-game, **SETTINGS** exposes pixel size, zoom, volume, and switches for
outlines, bloom, dithering and shadows — turning shadows off is the biggest
win on a weak machine, then pixel size up.

## Notes

- Needs WebGL2. Works in Firefox, Chrome and Safari.
- Nothing is uploaded anywhere. The only thing stored locally is your name.
- This is a separate game from *Getaway Daun* in the repository root; the two
  share nothing but a repository.
