# RIMDAUN

A colony sim for the browser, in the spirit of *RimWorld*. Three survivors come down on an
unclaimed world with a crate of steel and a week of meals. You never control them directly —
you decide what matters, and they decide who does it, in what order, and whether they can face
doing it at all today.

**Play it here:** https://felipe-lotas69.github.io/Juego-daun/colony/

No install, no build step, no accounts. It is a folder of plain files and a canvas.

## The loop

You do four things, over and over, and the game happens in between them:

1. **Designate.** Mark rock to mine, trees to chop, plants to harvest, animals to hunt.
2. **Build.** Place blueprints. Somebody hauls the materials, somebody else puts it up.
3. **Prioritise.** The Work tab is the real game: seventeen kinds of work, four priority levels,
   one row per colonist. A colony that starves usually starved because nobody was set to cook.
4. **React.** A raid lands. A wolf takes an interest in your grower. The cook has a breakdown
   over a dead friend and smashes the stove.

## Controls

| | |
|---|---|
| **Left click** | Select a colonist, building, plant or item |
| **Left drag** | Box-select colonists, or paint the current tool |
| **Right click** | Orders for the selected colonist at that spot — go, haul, prioritise, tend, attack |
| **Right / middle drag** | Pan the camera |
| **Wheel**, `Z` / `X` | Zoom |
| `WASD` / arrows | Pan |
| `Space` | Pause and resume |
| `1` `2` `3` `4` | Speed: 1x, 2x, 3x, 6x |
| `F` | Draft or undraft the selection — drafted colonists stop working and take orders |
| `R` | Rotate what you are about to build |
| `H` | Jump the camera home |
| `Tab` | Cycle through colonists |
| `Esc` | Back out: tool, then selection, then the menu |
| `Delete` | Cancel designations in a dragged rectangle |

## The colonists

Everyone arrives with a childhood and an adult career that gave them skills and took others
away — a vat-grown drifter who cannot do intellectual work, a medic who has never held a gun.
On top of that sit two or three traits that colour everything: an **optimist** shrugs off a
bad room, a **volatile** colonist snaps four points of mood earlier than anyone else, a
**pyromaniac** is a fire waiting for a bad day.

Twelve skills, levels 0 to 20, and **passions** that triple how fast a skill grows. A colonist
with a burning passion for cooking will out-cook a colonist with twice their level inside a
season, which is why the Work tab matters more than the roster does.

## Needs and mood

Four needs fall in real time: **food**, **rest**, **recreation** and **comfort**. Mood is not a
need — it is the sum of what has happened to a colonist lately. Eating a fine meal at a table
in a pretty room is worth a lot of points. Eating raw potato standing in the dark next to a
corpse is worth rather fewer.

When mood drops below a threshold, a colonist **breaks**: wandering off in a daze, smashing
furniture in a tantrum, going berserk at whoever is nearest, or eating a week of meals in one
sitting. Breaks are not punishment for bad play so much as the game telling you which part of
the colony you have been ignoring.

## Work, jobs and hauling

There is no order queue. Each colonist repeatedly asks the world "what is the most important
thing I am allowed to do that I can actually reach?" and the answer is a job: walk here, do
this much work, carry that there. Work is scanned by priority, so a colonist set to Mining at 1
and Hauling at 4 will mine all day and only haul when there is no rock left.

Everything that gets carried gets **reserved** first, which is the boring detail that stops
three colonists from all walking across the map for the same steel.

## Food

Sow a growing zone, wait for it to ripen, harvest it, haul it, cook it, eat it — and each of
those steps is a separate job that somebody has to be assigned to. Raw food is edible and
miserable; a cooked meal is worth mood. Meat comes from hunting or butchering, and a botched
cook roll gives somebody food poisoning.

Food rots. A meal left outside in summer is gone in days, so a cold room is a real building.

## Health

Bodies are made of parts, and parts take damage individually: a bullet through a lung, a scratch
on a hand, a leg that is simply gone. Injuries **bleed**, and a bleeding colonist dies on a
clock you can watch. A doctor tends wounds with herbal medicine or the manufactured kind, the
quality of the tend decides whether an untended wound goes septic, and a downed colonist has to
be **rescued** to a bed by someone else before any of that can happen.

Nothing is instant. Somebody has to walk there.

## Combat

Colonists shoot badly on purpose. Hit chance falls off with range, cover behind sandbags or a
wall matters enormously, and a missed shot goes somewhere — often into the wall you just built,
occasionally into the colonist standing in front. Melee is a brawl of hit rolls and cooldowns.
Draft your people, put them behind cover, and accept that a firefight is decided before it
starts by where everyone is standing.

## The storyteller

Threat scales with how long you have survived and how much you own. Build a rich colony quickly
and you have asked for a bigger raid. Between the raids: manhunter packs, a wanderer who walks
in and asks to join, cargo pods, an eclipse that kills your solar power for a day, a solar
flare that kills all of it, crop blight, heat waves and cold snaps.

Every event arrives as a letter you can click to jump the camera to the problem.

## Power, rooms and temperature

Conduits join generators, batteries and everything that draws power into networks. Solar panels
stop at dusk, batteries carry you to dawn, and a brownout turns off the lamps, the stove and the
turrets at once.

Rooms are found automatically by flood fill: anything you enclose with walls and a door is a
room with its own temperature, beauty and cleanliness. Heaters and coolers push it; leaky
walls let it go. A freezer is just a room you kept below zero.

## Research

Research unlocks the second half of the game: stonecutting, smithing, electricity, batteries,
solar power, machining, firearms, tailoring, medicine production, air conditioning and turrets.
A colonist does it at a bench, at a speed set by their intellectual skill.

## Saving

The whole colony serialises to your browser's local storage — every pawn, every injury, every
item stack, every zone, plus the random seed, so a reloaded colony rolls exactly the dice the
live one would have. It autosaves once per in-game day.

## Hosting

This game lives in `colony/` of a repository that holds two of them, and it is plain static
files, so GitHub Pages serves it straight from the branch with no build and no deploy workflow.
The repository root has a page that lets you pick a game; this one is at
`https://felipe-lotas69.github.io/Juego-daun/colony/`.

See the [repository readme](../README.md) for the one Pages setting that has to be switched on.

## Running locally

Zero dependencies, no build step.

```bash
git clone https://github.com/felipe-lotas69/Juego-daun.git
cd Juego-daun/colony
python3 -m http.server 8000     # then open http://localhost:8000
```

Opening `index.html` straight off disk works too — the scripts are plain classic scripts, not
ES modules, specifically so `file://` does not break.

## Checks

```bash
tools/verify-all.sh
```

Four of them, and they run on every push:

- **syntax** — every script parses.
- **defs** — every piece of content cross-references something that exists: no recipe pointing
  at a missing ingredient, no research unlocking a building nobody defined, no body part whose
  capacities do not add up to a working body.
- **simulation** — a colony is generated, given a stockpile, a growing zone, some designations
  and a build order, and then played headlessly for four days. It asserts that colonists
  actually took a spread of jobs, that the orders got carried out, that nobody starved in a
  field of food, that no item stack exceeded its limit, that reservations did not leak, and
  that the save round-trips.
- **client** — the renderer, UI and input are booted against a stub DOM, a colony is started,
  frames are run, every tab and overlay is opened and the build tool is used. It cannot tell
  you the game looks right; it tells you it does not throw, which for a browser game with no
  build step is the check that catches things.

## How it is put together

The simulation is DOM-free, on purpose. Every file below the renderer is loaded into a bare
`vm` sandbox by the test harness, which means a stray `document` reference fails in CI rather
than in somebody's browser.

**Time.** 60 ticks per second at 1x, 60000 ticks per day. Speed multipliers spend more ticks
per frame rather than making each tick bigger, so the simulation is identical at 6x. Anything
expensive runs on a *rare tick* — every 250 ticks, staggered by pawn id — so a colony of thirty
costs about what a colony of three does.

**Determinism.** One seeded random stream drives the whole simulation, and it is saved with the
game. Cosmetic randomness runs on a second stream so a sprite wobble can never change history.

**Space.** The map is a set of typed-array grids. Two separate flood-fill labelings run over
them: *areas*, which make "can this colonist reach that?" an O(1) array comparison instead of a
failed pathfind, and *rooms*, which are what temperature, beauty and "did you sleep indoors"
are computed from. Both rebuild only when something actually changed.

**Pathfinding.** A* with an octile heuristic over the cost grid, no corner-cutting through
diagonal walls, preallocated arrays reused between queries, and an area check first so an
impossible path costs nothing.

**Art.** Every sprite is drawn in code into a 16x16 offscreen canvas at load — no image files,
nothing to fetch, which is also why it runs from `file://`. Walls pick one of sixteen join
variants from their neighbours, terrain has deterministic per-cell variants so a field is
textured rather than flat, and the whole thing is blitted at integer zoom with smoothing off.

## Project layout

```
index.html            markup shell and the frozen script load order
styles.css            panels, tabs, the architect menu
js/utils.js           seeded RNG, maths, grid helpers, binary heap
js/defs.js            the def registry and its reference checking
js/def_terrain.js     terrains and buildable floors
js/def_things.js      items, resources, weapons, apparel, buildings
js/def_plants.js      wild plants and crops
js/def_pawns.js       skills, work types, bodies, traits, backstories, thoughts, pawn kinds
js/def_recipes.js     what the workbenches can be told to make
js/research.js        research projects and the research runtime
js/map.js             the grids, the thing registry, items and designations
js/regions.js         reachability areas, rooms, room stats, temperature
js/pathfind.js        A* and reachability queries
js/zones.js           stockpiles, growing zones, storage selection
js/health.js          body parts, injuries, bleeding, tending, death
js/needs.js           needs, thoughts, mood, break thresholds
js/pawn.js            the pawn model, skills, movement, equipment
js/jobs.js            jobs, the toil vocabulary, reservations, the driver
js/construct.js       blueprints, frames, building, deconstruction, mining
js/production.js      bills at workbenches and recipe execution
js/plants.js          growth, sowing, harvest, wild spread, fire
js/power.js           power networks, batteries, light, heaters and coolers
js/combat.js          ranged and melee, projectiles, cover, damage
js/animals.js         animal AI, hunting, taming, predators, manhunters
js/workgivers.js      every scan that turns available work into a job
js/think.js           the think tree and mental states
js/mapgen.js          terrain, ore, flora, wildlife and the landing party
js/events.js          the storyteller, its incidents and raid groups
js/game.js            the world container, the tick order, time and speed
js/save.js            serialising the whole colony
js/art.js             every sprite, drawn procedurally at load
js/render.js          camera, world drawing, overlays
js/ui.js              menus, panels, tabs, alerts, letters
js/input.js           mouse, keyboard, selection, designation painting
js/main.js            boot and the frame loop
tools/harness.js      loads the simulation into a vm sandbox for tests
tools/domstub.js      a DOM and canvas stub, enough to boot the client headlessly
tools/verify-*.js     the four checks
```
