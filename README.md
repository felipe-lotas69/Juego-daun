# GETAWAY DAUN

A physics-based, ragdoll-ish action platformer in the spirit of *Getaway Shootout*.
You can't walk — you **lean** and **hop** your way through collapsing rooftops,
elevator shafts and glass office towers, grabbing guns along the way, trying to
reach the getaway van at the end of each level.

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
| `ENTER` | Restart level |

There is no walking. Your lean angle is also your aim: lean far and jump for a
long, flat leap; stand tall and jump for height. Rockets and shotguns launch you
backwards — that's a movement tool, not a bug.

## Features

- Custom 2D physics: leaning, hopping, momentum, ice, bouncy pads, knockback
- 6 hand-built levels with a run timer and per-level best times (saved locally)
- Elevators and moving platforms you call with `R`, plus pressure plates and doors
- Breakable glass floors and walls — shoot them or land hard enough
- Weapons: pistol, SMG, shotgun, rocket launcher, teleport gun
- Enemy goons that patrol, take cover-ish potshots and ragdoll when dropped
- Hazards: spikes, saw blades, lava, and a long way down
- Checkpoints, screen shake, particles, and fully synthesized sound (no audio files)

## Hosting

`.github/workflows/pages.yml` syntax-checks every script and then publishes the
repository root to GitHub Pages on each push. It needs Pages turned on once, by
hand, because a workflow token is not allowed to create the Pages site itself:

1. The repository has to be **public** — Pages on a private repository requires
   GitHub Pro or higher. Settings → General → Danger Zone → *Change visibility*.
2. Settings → **Pages** → *Build and deployment* → Source: **GitHub Actions**.
3. Re-run the workflow (Actions → *Deploy to GitHub Pages* → *Run workflow*), or
   just push again.

The site then lands at `https://felipe-lotas69.github.io/Juego-daun/`.

Any other static host works just as well — there is nothing to build, so
dropping the repository contents on a web server is enough.

## Running locally

It's a static site with zero dependencies or build step.

```bash
git clone https://github.com/felipe-lotas69/Juego-daun.git
cd Juego-daun
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` directly from disk works too — the scripts are plain
classic scripts, not ES modules, specifically so `file://` doesn't break.

## Project layout

```
index.html        markup + boot
styles.css        shell, menus, HUD
js/utils.js       math, rng, collision helpers
js/input.js       keyboard/mouse state
js/audio.js       WebAudio sound synthesis
js/particles.js   particle + debris system
js/weapons.js     weapon defs, bullets, explosions
js/entities.js    player, enemies, elevators, glass, hazards, pickups
js/levels.js      the 6 levels, as data
js/game.js        world simulation, collision, camera, rendering
js/ui.js          menus, HUD, level select, timers
js/main.js        bootstrap
```
