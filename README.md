# Juego Daun

Three browser games in one repository. All of them are plain static files — no build step, no
bundler, no dependencies — so each one runs from GitHub Pages or straight off your disk.

| | | |
|---|---|---|
| **[RIMDAUN](colony/)** | colony simulation | [`colony/`](colony/) · [readme](colony/README.md) |
| **[Chromewood](chromewood/)** | isometric survival RPG | [`chromewood/`](chromewood/) · [readme](chromewood/README.md) |
| **[Getaway Daun](getaway/)** | action platformer | [`getaway/`](getaway/) · [readme](getaway/README.md) |

**Play:** https://felipe-lotas69.github.io/Juego-daun/

## RIMDAUN

Three survivors come down on an unclaimed world with a crate of steel and a week of meals. You
never control them directly. You decide what matters — what to build, what to mine, who is
allowed to cook — and they decide who does it, in what order, and whether they can face doing
it at all today.

Colonists arrive with backstories that took skills away as well as giving them, traits that
colour everything, needs that fall in real time, and a mood that is the sum of what has happened
to them lately. Bodies are made of parts that take damage individually, and a doctor's operation
can fail. Fire follows fuel, so a firebreak is a real tactic. The planet has generated
civilizations with opinions about you, and a storyteller that scales what it sends by how long
you have survived and how much you own.

It also has a prison built to the depth the rest of the genre reserves for its main systems —
cells graded by the room around them, a regime you author hour by hour, contraband moving under
the floor, and riots that are your own fault — plus ideoligions, royal titles and psycasts,
genes and children, basements and upper floors, and a ship you can build to leave the planet on.

## Chromewood

The forest grew back through the machines, and something in the rift started sending things out
after dark. You arrive with nothing. Chop, mine, cook, build a camp, repair the dead beacon, and
then go and close the rift. Solo, or up to four people in the same world. One vendored copy of
three.js and no asset pipeline.

## Getaway Daun

You cannot walk. You lean, and a lean on the ground becomes a hop — that is the whole movement
system, and your lean angle is also your aim. Six hand-built campaign levels, a versus mode with
bots that route over a navigation graph and plan by replaying candidate moves through the real
physics, ragdoll limbs, and LAN play from a dependency-free Node host.

## Layout

```
index.html        the page that lets you pick one
colony/           RIMDAUN      - index.html, styles.css, js/, tools/, docs/
chromewood/       Chromewood   - index.html, styles.css, src/, vendor/, server/, tools/
getaway/          Getaway Daun - index.html, styles.css, js/, server/, tools/
.github/          CI: each game's checks run as its own job
```

Nothing is shared between the folders on purpose. They were built separately, they have their
own conventions, and a common engine across a colony sim, an isometric RPG and a physics
platformer would be a worse version of all three.

## Hosting

Static files at the repository root, so GitHub Pages serves them straight from the branch:

**Settings → Pages → Build and deployment → Source: `Deploy from a branch`, Branch:
`claude/rimworld-web-clone-eiziry` / `(root)` → Save.**

The root page is a chooser; `/colony/`, `/chromewood/` and `/getaway/` go straight to a game.

## Running locally

```bash
git clone https://github.com/felipe-lotas69/Juego-daun.git
cd Juego-daun
python3 -m http.server 8000     # then open http://localhost:8000
```

Opening any game's `index.html` from the filesystem works too — none of them use ES modules,
specifically so `file://` does not break them. Chromewood and Getaway Daun each bundle a
dependency-free Node server if you want their multiplayer.

## Checks

```bash
cd colony     && bash tools/verify-all.sh
cd getaway    && bash tools/verify-all.sh
cd chromewood && bash tools/verify-all.sh
```

RIMDAUN parses every script, cross-checks every def in both directions, plays a colony
headlessly for several days and asserts it took a spread of jobs and round-tripped through a
save, then boots the renderer, UI and input against a stub DOM and runs frames. Getaway Daun
verifies every level is completable through its door-gated progression and that nothing respawns
inside a hazard. All of it runs in CI on every push.
