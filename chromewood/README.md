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

## What there is to do

You start with your hands, in a clearing, next to a beacon that does not
work. Nothing in the list below is required, and nothing expires. It is the
order most people find things in, not a set of objectives.

1. **Stay alive.** Punch a tree. Wood and fiber make a stone axe and a stone
   pick, which get you stone and ore, which get you a campfire and a
   workbench, which get you everything else. Eat before your food runs out
   and stay near a fire at night or the cold takes your health.
2. **Build somewhere.** Walls, a bed, a forge, lamps, plots to grow things
   in. Whatever you put up is yours and stays where you left it.
3. **Find a village** and trade with it. Three per world, each
   dealing in something different.
4. **Go down a cave.** Every world has half a dozen, each with a timbered
   portal over the mouth. Inside is where the metal is, and the crystal, and
   the riftglass, and it is dark enough that a torch is the difference
   between seeing the floor and not.
5. **Light the beacon**, if you want a skill tree. It needs 25 scrap, 20
   essence, 25 wood and 25 stone in its store. Carry them there and hold `G`.
6. **Seal the gates**, if you want a fight. Five rift gates open around the
   map once the beacon is lit. Standing inside one for 75 seconds seals it,
   and it spends that whole time spawning things at you. Each one sealed
   makes every night after it smaller. Seal all five and something wakes up
   at the beacon with a health bar across the top of the screen.

Nothing ends the run. Dying is a setback; losing the beacon puts it out and
you can repair it again.

### The map

One procedurally generated island, terraced into nine hard plateaus so cliffs
are cliffs rather than ramps, with mountains, rivers you can wade, and twelve
biomes above ground: Shallows, Shore, Meadow, Chromewood, Pinehold, Crags,
Whitecap, Sump, Bloomwood, The Ruins, Ashlands and the Plaza in the middle.
Where the terrain would strand you, the generator cuts a staircase rather than
a ramp — every seed is walkable from the beacon to essentially all of it.

A biome is a region you walk into, not a tile you stand on: the patches are
laid out at roughly ninety tiles across and then passed through a majority
filter, because a map that changes character every few paces reads as noise
rather than as places. Snow is what happens at the top of a mountain. The
ground within about thirty tiles of the plaza is kept to meadow and forest,
fading out rather than stopping at a circle, because the first ten minutes
happen there and they need trees and rock.

Everything standing on it is something you can name on sight: trees, bushes,
grass, ferns, mushrooms, fallen logs, rock, boulders, ore. The Ruins are a
town that fell over — broken walls, toppled pillars, crates nobody came back
for — and that is where salvage comes from.

What is worth having is further out, or underneath.

### Villages

Three per world, each with a trade. They are the only place with
people in it who are not trying to kill you, which makes them worth
walking to on their own; the trading is what makes them worth walking
back to. A ring of cottages round a paved square, a well, a fence with
a gate, and a stall under an awning in the colour of the trade — green
for the grange, amber for the smithy, tan for the trapline, violet for
the apothecary — so you can tell from across the valley whether it is
worth the walk.

Hold `G` at the counter. Barter, not coins: four standing offers and
one that turns over every night. The grange takes timber and gives you
bread and seed; the smithy takes ore and gives it back as metal; the
trapline buys what you carry out of the woods; the apothecary deals in
things that grow in the dark. Nothing about the board is stored — it
is a function of the village and the night count — so a host and every
client draw the same one with nothing on the wire about it.

The villagers walking about are scenery with legs: they do not fight,
cannot be hit and own nothing, so their walk is a function of the
clock and their own index and the simulation never hears about them.
The one who keeps the stall stands at it, because a shopkeeper who
wanders off is a shop you cannot find.

### The year

Four seasons, three nights each. A season that only changes the colour
of the grass is a filter; this one decides how fast a crop grows
(winter is a third of spring), what is out in the woods (wolves and
foxes in winter, hares and fawns in spring), what the sky does (it
cannot snow in summer and it usually does in winter), and how cold
the night gets. In winter everything facing up collects snow — only
what faces the sky, and not sheer faces, because snow sits, it does
not stick to walls. Like the trade boards it is a pure function of the
night count, so nothing about it goes on the wire.

### Water

Deep water is somewhere to go, not a wall. You float at the surface,
move at three fifths speed, cannot swing or build, and it costs
stamina the whole time — and you do not get your breath back until you
are out. Hauling yourself out allows a bigger step up than walking
does, because the generator rings deep water with shallows and the
beach behind them is a terrace step up.

### Blocks, gear and the smelter

A wall is a thing with a job; a block has no job at all, which is the
point. Wood, stone and iron, stacking four high at one terrain step
each. Armour comes in three tiers of three — hide, iron, riftglass,
worn on head, body and legs — and it shows on the character, because
the sprite sheet takes the worn colours. Each piece holds some cold
off, which is what makes a hide vest worth making in autumn. Smelting
has its own building between the workbench and the forge, so the ore
you mine on the first day has somewhere to go.

### Caves

Half a dozen per world, cut into the side of a hill one terrace below the
mouth, with the hill left standing over them. The floor is flat: a body can
climb or drop one level in a step and the land steps two at a time, so a
tunnel that dived would be a staircase. One ramp tile in the doorway takes
you down, and after that it is level.

The rock that used to be there is remembered — its height and the biome it
wore — and drawn back in as a roof. From outside a hill is a hill, with a
timbered portal and a lantern where the way in is. Walk in and the roof of
that one cave lifts, which is the oldest trick in isometric games and still
the only one that works.

Underground is where the density is: iron, copper, gold and essence seams,
crystal, riftglass, and the mushrooms that grow without light. The generator
checks afterwards that you can walk from the doorway to the back of it, and
takes out anything that grew across a one-tile passage — but only the one
thing that is actually in the way, because clearing the whole frontier empties
the cave of what it is for.

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

Up to four people, and **there is no server to run**. The browsers talk to
each other directly over WebRTC, and one of them - the host - owns the
simulation exactly as before. Everyone else mirrors it.

1. One player picks **HOST CO-OP** and reads out the five-letter room code.
2. The others type it into **JOIN CODE**.

That is the whole setup. It works from the published page with nothing
installed and nothing deployed.

Two browsers still have to be introduced before they can speak, which is the
one thing a peer connection cannot do for itself. A signalling broker forwards
a handful of offer/answer/candidate messages by destination id and then has no
further part in the game - it never sees a snapshot, an input, or a chat line.
We use the public PeerJS broker and speak its protocol directly in
`src/net/peer.js`, rather than bundling a library for two hundred lines of
WebSocket.

Your own movement is predicted locally and reconciled against the host, so it
never waits for a round trip. Everything else is interpolated an eighth of a
second behind. Snapshots carry players and their packs, enemies, animals,
buildings, pickups, the gates, the contracts and tonight's weather, and run
about 35 KB/s with a night in full swing.

Anything that is not movement - crafting, building, eating, spending a skill
point, buying a beacon upgrade - travels as a named action the host performs
and echoes back in the next snapshot, so there is exactly one authority on
what exists.

### When a direct connection cannot be made

A small number of networks - symmetric NAT, some corporate and school
firewalls - will not let two browsers reach each other without a TURN relay,
and there is no free TURN worth depending on. Two escape hatches, both URL
parameters so neither clutters the menu:

- `?broker=host:port` points the introduction at your own
  [PeerServer](https://github.com/peers/peerjs-server) instead of the public
  one. Useful if the public broker is down or blocked.
- `?relay=192.168.1.20:8090` abandons peer-to-peer entirely and uses the
  relay in `server/`, which is still here and still works:

  ```
  node chromewood/server/server.js
  ```

  On a LAN this is also simply faster than a negotiated peer path. Note that
  a page served over `https` cannot open a plain `ws://` socket, so a relay
  reached from the published site needs TLS; from a copy you are serving
  yourself over `http`, it is fine as-is.

If the host closes their tab the run ends for everyone, because the host was
the simulation. The relay's host-migration path does not apply peer-to-peer.

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
    world/    worldgen.js       terrain, terracing, rivers, biomes, caves,
                                ore, props, landmarks, connectivity repair
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
    net/      protocol.js       what goes over the wire
              peer.js           co-op with no server: WebRTC + signalling
              client.js         the relay transport, for ?relay= and LAN
              mirror.js         a client's copy of the host's world
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
- **Villages.** Every world has them, you can walk to them from the
  beacon, the square is open and the stall can be stood at, the
  cottages are walls rather than scenery, they are not all the same
  trade, every offer is in real goods, tonight's deal is different
  from last night's, and a trade at the counter moves the goods while
  one from forty tiles away does not.
- **The year.** Four seasons that turn over, growing worth timing,
  winter the hard one, no snow in summer, and a different population
  in the woods in each.
- **Swimming.** There is water deep enough to swim in, it puts you in
  the water, you ride at the surface, you can get out again, and it
  costs you.
- **Gear and blocks.** A full set of armour to make, every piece with
  a slot and a number and a recipe, swapping hands the old one back, a
  plated player takes less than a bare one, blocks stack exactly as
  high as they say and refuse the one after that, and ore has
  somewhere to be smelted before the forge exists.
- **The wildlife.** Nine species, each with somewhere to live,
  something to give, a drawn shape of its own, and some part of the
  year it is worth looking for.
- **Caves.** Every world has them, you can walk in from the mouth and reach
  the back of one, there is rock over your head and enough of it to stand up
  in, there is ore or crystal down there, and a framed doorway outside.
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
- **Peer to peer.** The signalling broker has to resolve to the right
  address for every form of `?broker=`, because getting that wrong means
  co-op never connects and the failure looks like somebody else's outage.
  The WebRTC handshake itself needs two real browsers and is covered by the
  co-op harness rather than here.

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
- Nothing is uploaded anywhere and there is no account. The only thing stored
  locally is your name. In co-op the game data goes browser to browser; the
  signalling broker sees only a room id and the connection handshake.
- This is a separate game from *Getaway Daun* in the repository root; the two
  share nothing but a repository.
