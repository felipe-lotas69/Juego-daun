# Juego Daun

Two browser games in one repository. Both are plain static files — no build step, no bundler,
no dependencies — so either one runs from GitHub Pages or straight off your disk.

| | | |
|---|---|---|
| **[RIMDAUN](colony/)** | colony simulation | [`colony/`](colony/) · [readme](colony/README.md) |
| **[Getaway Daun](getaway/)** | action platformer | [`getaway/`](getaway/) · [readme](getaway/README.md) |

**Play:** https://felipe-lotas69.github.io/Juego-daun/

## RIMDAUN

Three survivors come down on an unclaimed world with a crate of steel and a week of meals. You
never control them directly. You decide what matters — what to build, what to mine, who is
allowed to cook — and they decide who does it, in what order, and whether they can face doing
it at all today.

Colonists have backstories that took skills away as well as giving them, traits that colour
everything, needs that fall in real time, and a mood that is the sum of what has happened to
them lately. Bodies are made of parts that take damage individually. Fire follows fuel. The
planet has generated civilizations with opinions about you, and a storyteller that scales what
it sends by how long you have survived and how much you own.

## Getaway Daun

You cannot walk. You lean, and a lean on the ground becomes a hop — that is the whole movement
system, and your lean angle is also your aim. Six hand-built campaign levels, a versus mode with
bots that route over a navigation graph and plan by replaying candidate moves through the real
physics, ragdoll limbs, and LAN play from a dependency-free Node host.

## Layout

```
index.html        the page that lets you pick one
colony/           RIMDAUN  - its own index.html, styles.css, js/ and tools/
getaway/          Getaway Daun - the same, plus server/ for LAN play
.github/          CI: each game's checks run as its own job
```

Nothing is shared between the two folders on purpose. They were built separately, they have
their own conventions, and a shared "engine" between a colony sim and a physics platformer
would be a worse version of both.

## Hosting

Static files at the repository root, so GitHub Pages serves them straight from the branch:

**Settings → Pages → Build and deployment → Source: `Deploy from a branch`,
Branch: `claude/rimworld-web-clone-eiziry` / `(root)` → Save.**

The root page lands you on a chooser; `/colony/` and `/getaway/` go straight to a game.

## Running locally

```bash
git clone https://github.com/felipe-lotas69/Juego-daun.git
cd Juego-daun
python3 -m http.server 8000     # then open http://localhost:8000
```

Opening either `index.html` from the filesystem works too — both games use classic scripts
rather than ES modules specifically so `file://` does not break them.

## Checks

```bash
cd colony  && bash tools/verify-all.sh
cd getaway && bash tools/verify-all.sh
```

RIMDAUN parses every script, cross-checks every def, plays a colony headlessly for several days
and asserts it took a spread of jobs and round-tripped through a save, then boots the renderer
and UI against a stub DOM. Getaway Daun verifies every level is completable through its
door-gated progression and that nothing respawns inside a hazard. Both run in CI on every push.
