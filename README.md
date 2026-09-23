# JUEGO DAUN

Three browser games in one repository, all plain HTML, CSS and JavaScript with
no build step.

**Play them here:** https://felipe-lotas69.github.io/Juego-daun/ — once Pages is
switched on, see [Hosting](#hosting) below.

| | |
|---|---|
| [**Chromewood**](chromewood/) | An isometric pixel-art survival RPG. Land with nothing, build a camp, repair the beacon, close the rift. Solo or up to four in co-op. [Its own README](chromewood/README.md). |
| [**Getaway Daun**](getaway-daun/) | The rebuilt one: a 1-4 player ragdoll race with guns, and recoil you travel on. [Its own README](getaway-daun/README.md). |
| [**Getaway Daun (first build)**](getaway.html) | The earlier single-file version, kept as it was. |

The rest of this file is about Getaway Daun.

---

# GETAWAY DAUN

A physics-based, ragdoll-ish action platformer in the spirit of *Getaway Shootout*.
You can't walk — you **lean** and **hop** your way through collapsing rooftops,
elevator shafts and glass office towers, grabbing guns along the way, trying to
reach the getaway van before anyone else does.

Its entry point is `getaway.html`, because the repository root now holds a small
landing page listing all three games. Its scripts and styles did not move.

## Controls

| Key | Action |
|-----|--------|
| `A` | Lean / hop left |
| `D` | Lean / hop right |
| `W` | Jump (you launch in the direction you're leaning) |
| `R` | Interact — pick up guns, call elevators, hit buttons. Also fires your gun when there's nothing to interact with |
| `SPACE` / mouse | Fire the equipped weapon |
| `Q` | Drop weapon |
| `P` / `ESC` | Pause |
| `ENTER` | Restart the level (campaign) / start the next round (versus) |
| `↑ ← → ⏎` | Player two, when two of you share a keyboard |

There is no walking. Your lean angle is also your aim: lean far and jump for a
long, flat leap; stand tall for height. Leaning into the direction you face
drops the muzzle, so shooting the floor is how you rocket-jump. Recoil is a
movement tool, not a bug.

## Modes

**Campaign** — six hand-built levels, a run timer and per-level best times.

**Versus** — three maps in rotation (Rooftop Dash, The Spire, Foundry), first
racer to the van takes the round, first to *N* round wins takes the match.
One or two humans on one keyboard, up to four over LAN, and every empty seat
is filled with a bot.

## The bots

Four personalities, each a different set of weights over the same controller —
they read the same five inputs you do and aim by leaning, with no privileged
access to the world:

| | |
|---|---|
| **DASH** | Runs. Does not stop, does not look back. |
| **TANK** | Grabs every gun and comes looking for you. |
| **QUIET** | Hangs back, takes its time, rarely misses. |
| **CHAOS** | Explosives first. Thinking optional. |

They route over a navigation graph built from the map's geometry, then decide
how to move by replaying candidate plans — run, bound, charge the jump, hold,
back off — through the real physics for two thirds of a second and picking the
one that gets furthest without dying. That is also how they learn to wait out
an elevator piston, follow a saw blade through, and stop short of a ledge.

## Things to break

Crates and gas barrels are physical: they fall, stack, get shoved when you walk
into them, and get flung across the roof by a blast. Shoot a barrel and it
lights a short fuse before going off, which is long enough to read — and long
enough for it to take its neighbours with it, so a row of them goes up in a
chain. Crates just come apart.

Glass is not only underfoot. Every map has panes standing across the running
line, and hitting one with pace puts you straight through it instead of
stopping you. The same goes for a glass floor you land on hard, or a crate
thrown through one.

Because aiming by leaning is deliberately awkward, the shot is nudged onto
whatever is worth hitting: a gas barrel first, otherwise the nearest rival.
It only assists inside a cone you are already pointing down, only with line of
sight, and it shows you the lock — so it helps you commit rather than playing
for you. Bots keep their own accuracy model and do not get it.

## Ways to die that aren't a bullet

Long drops, lava, spikes, saw blades, and the elevator pistons, which do not
push you aside. Each map is strung with **invisible checkpoints** you cross
without noticing; dying puts you back at the last one, so a mistake costs you
position rather than the whole run.

## The bodies

The collision shape is a plain box, because that is what keeps the movement
predictable. Everything you actually see hanging off it — head, arms, legs —
is a small verlet rig pinned at the chest and hips. The pins get dragged
around by the box and the free ends lag, swing and overshoot, so a character
flails through a jump, the gun arm whips round to where you are aiming, and
the legs trail behind you in the air. Take a hard landing and the whole rig
goes slack for a moment.

It is cosmetic — it never touches collision, and it is skipped entirely while
a bot is planning its next move, so the AI is not paying for animation.

## The look

Everything is drawn into a 192x108 buffer and blown up five times with
nearest-neighbour, so one pixel really is one pixel. That is what gives a
leaning character stair-stepped edges rather than smooth anti-aliased ones:
the blending happens at buffer resolution and then gets magnified along with
the rest of the picture. Shapes snap to the grid, the text is a 3x5 bitmap
font, and the palette is flat and bright — no gradients, no vignette, no soft
glows, and round things are built out of squares.

## Blood

Gibs are rigid bodies run through the same swept collision as everything else,
so they tumble down stairs and pile in corners, trailing droplets that paint a
decal wherever they land. Turn it off, down or up under **Options**.

## LAN play

One machine hosts and serves the game to everyone else:

```bash
node server/server.js --port 8080 --target 3
```

It prints the address to share. Everyone on the same network opens that address
in a browser — there's nothing to install on the other machines. Up to four
players; empty seats become bots. The host runs the authoritative simulation and
broadcasts snapshots, so all four screens agree.

The server has no dependencies: it serves the static files and speaks WebSocket
directly, so `node server/server.js` is the whole setup.

## Hosting

The whole site is static files at the repository root, so there is nothing to
build. Two ways to publish it, and only one can be active at a time.

**Branch mode — the one that needs no extra permissions:**

**Settings → Pages → Build and deployment → Source: `Deploy from a branch`,
Branch: `claude/getaway-shootout-game-x4v0bp` / `(root)` → Save.**

Give it a minute and it appears at
`https://felipe-lotas69.github.io/Juego-daun/`, with the landing page at the
root, Getaway Daun at `/getaway-daun/`, Chromewood at `/chromewood/` and the
first build at `/getaway.html`. Every later push republishes automatically.

Note that this switch has to be thrown by hand, once. A workflow cannot
do it: `GITHUB_TOKEN` is refused the Pages-site creation API
(`Resource not accessible by integration`) however its permissions are
declared. Once the site exists, automation can publish to it freely.

**Actions mode — deploys only after the checks pass:**

Set **Source** to `GitHub Actions`, then add a repository variable
`PAGES_VIA_ACTIONS` = `true` under **Settings → Secrets and variables →
Actions → Variables**. `.github/workflows/deploy-pages.yml` then parses every
script, runs both level verifiers and Chromewood's full verifier, checks that
nothing on the landing page is a dead link, and publishes only if all of that
passes. Without that variable the deploy job is skipped and only the checks
run, so the workflow is not a standing failure while the repository is in
branch mode.

Pages serves every game's single-player and same-keyboard modes. Getaway Daun's
LAN play and Chromewood's co-op both need their Node host running, since Pages
only serves static files.

## Running locally

Zero dependencies, no build step.

```bash
git clone https://github.com/felipe-lotas69/Juego-daun.git
cd Juego-daun
node server/server.js          # or: python3 -m http.server 8000
```

Opening `getaway.html` straight off disk works too — the scripts are plain classic
scripts, not ES modules, specifically so `file://` doesn't break.

## Checks

```bash
tools/verify-all.sh
```

Runs the level verifiers: goal reachability through door-gated progression,
geometry intruding into standing space, respawn points sitting inside a
hazard's sweep, and props that float or sink instead of resting on a surface.
The same script runs in CI on every push.

## How the levels were validated

The jump envelope was measured from the running engine rather than guessed, by
sweeping input sequences a player can actually perform: run up, release to
unwind the lean, jump, steer in the air. Unwinding the lean to gain height also
bleeds your speed, so height and distance trade off far harder than the raw
numbers suggest — a 160px gap with a 70px rise is near the limit, and a 190px
one is impossible.

Every map is then checked against that envelope for goal reachability through
door-gated progression, for geometry that intrudes into standing space, for
respawn points sitting inside a hazard's sweep (a death loop), and for entities
that settle where they were placed. The bots run the same maps headless as a
last check that the routes hold up under play.

## Project layout

```
index.html         the landing page listing all three games
getaway.html       markup + boot for Getaway Daun
styles.css         shell, menus, HUD
js/utils.js        math, rng, collision helpers
js/pixel.js        low-res buffer, grid snapping, 3x5 bitmap font
js/ragdoll.js      verlet limb rig for players and goons
js/input.js        keyboard/mouse state, two-player pads
js/audio.js        WebAudio sound synthesis
js/particles.js    particle + debris system
js/gore.js         gibs, arterial spray, blood decals
js/weapons.js      weapon defs, bullets, explosions
js/entities.js     player, enemies, elevators, pistons, glass, props, hazards, pickups
js/levels.js       the six campaign levels, as data
js/versusmaps.js   the three race maps
js/navgraph.js     walkable graph + A* over a map
js/bots.js         AI opponents and their personalities
js/match.js        versus match state: rotation, scores
js/net.js          LAN client
js/game.js         world simulation, collision, camera, rendering
js/ui.js           menus, HUD, level select, scoreboards
js/main.js         bootstrap and mode switching
server/server.js   LAN host: static files + WebSocket + authoritative sim
```
