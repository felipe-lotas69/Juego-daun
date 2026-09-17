# GETAWAY DAUN

A physics-based, ragdoll-ish action platformer in the spirit of *Getaway Shootout*.
You can't walk — you **lean** and **hop** your way through collapsing rooftops,
elevator shafts and glass office towers, grabbing guns along the way, trying to
reach the getaway van before anyone else does.

**Play it here:** https://felipe-lotas69.github.io/Juego-daun/ — once Pages is
switched on, see [Hosting](#hosting) below.

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

## Ways to die that aren't a bullet

Long drops, lava, spikes, saw blades, and the elevator pistons, which do not
push you aside. Each map is strung with **invisible checkpoints** you cross
without noticing; dying puts you back at the last one, so a mistake costs you
position rather than the whole run.

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

`.github/workflows/pages.yml` syntax-checks every script and then publishes the
repository root to GitHub Pages on each push. It needs Pages turned on once, by
hand, because a workflow token is not allowed to create the Pages site itself:

1. The repository has to be **public** — Pages on a private repository requires
   GitHub Pro or higher. Settings → General → Danger Zone → *Change visibility*.
2. Settings → **Pages** → *Build and deployment* → Source: **GitHub Actions**.
3. Re-run the workflow (Actions → *Deploy to GitHub Pages* → *Run workflow*), or
   just push again.

Pages serves the campaign and local versus. LAN play needs the Node host above,
since GitHub Pages only serves static files.

## Running locally

Zero dependencies, no build step.

```bash
git clone https://github.com/felipe-lotas69/Juego-daun.git
cd Juego-daun
node server/server.js          # or: python3 -m http.server 8000
```

Opening `index.html` straight off disk works too — the scripts are plain classic
scripts, not ES modules, specifically so `file://` doesn't break.

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
index.html         markup + boot
styles.css         shell, menus, HUD
js/utils.js        math, rng, collision helpers
js/input.js        keyboard/mouse state, two-player pads
js/audio.js        WebAudio sound synthesis
js/particles.js    particle + debris system
js/gore.js         gibs, arterial spray, blood decals
js/weapons.js      weapon defs, bullets, explosions
js/entities.js     player, enemies, elevators, pistons, glass, hazards, pickups
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
