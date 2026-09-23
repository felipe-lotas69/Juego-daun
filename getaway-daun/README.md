# Getaway Daun

A chaotic local-multiplayer physics race for 1–4 players, plus bots. **You
cannot walk.** You lean, you let go, and you hope. First to the getaway van
takes the round; first to three rounds takes the match.

Open `index.html` in a browser. Nothing to install, nothing to build.

## Controls

Three keys each, and that is the whole control surface.

|          | Lean left | Lean right | Shoot / use |
|----------|-----------|------------|-------------|
| Player 1 | `A`       | `D`        | `W`         |
| Player 2 | `←`       | `→`        | `↑`         |
| Player 3 | `F`       | `H`        | `T`         |
| Player 4 | `J`       | `L`        | `I`         |

`P` pauses. Menus take the arrows and `Enter`.

**Hold** a lean key to wind up — longer means flatter, faster, further.
**Let go** to jump. A tap is a hop straight up; a full hold is a long flat
dive that barely leaves the ground. In the air the same keys spin you, which
is how you land on your feet instead of your face. If the ground goes out
from under a wind-up it fires anyway, rather than being silently thrown away.

## Guns, and recoil as transport

Weapons spawn in crates along the course. Each has its own rate, spread and
kick, and **the kick is a movement system**: a shotgun fired downward is the
longest jump in the game.

| | shots | recoil | notes |
|---|---|---|---|
| Pistol  | 8  | small  | tidy, forgettable |
| SMG     | 28 | tiny   | hold it down |
| Shotgun | 5  | huge   | five pellets, and it will launch you |
| Rifle   | 3  | big    | fast and flat |
| Rocket  | 2  | big    | explodes, and does not care who is nearby |

Aim is not a separate control — it is **your balance**. A gun points wherever
your body has tipped, so firing mid-tumble sends shots anywhere. Utilities
(shield, boost) turn up in the same crates.

## Courses

Three, rotating: **Rooftop Row** over a long drop, **Freight Line** across a
train in open scrub, **Night Shift** up through an office to the exit.

## The camera

It frames everyone still racing and pulls back as they spread out, down to
about half scale. Four players in a scrum get a tight shot; four strung
across the map get a loose one.

## Checking it still works

```
node tools/verify-levels.js
```

Walks every course against the real launch maths — the same function the game
and the bots use, read out of the source rather than copied, so the check
cannot drift from what a jump actually does.

## How it is put together

The canvas runs at its own resolution. Sprites are low-res pixel art drawn
onto it as rigid bitmaps that rotate and sit at **sub-pixel precision** — a
character can tilt 37 degrees without snapping to a grid — while the backdrop
behind them is a real gradient with soft cloud banks. Pixel assets on a
smooth world, rather than the whole picture squashed onto one coarse grid.

- `js/engine.js` — maths, canvas, font, sprite baking, keys
- `js/art.js` — the sprite sheets, written as pixels
- `js/levels.js` — the three courses
- `js/weapons.js` — guns, bullets, recoil
- `js/world.js` — bodies, the verlet ragdoll, the simulation
- `js/draw.js` — painting the world
- `js/bot.js` — opponents, who must decide how long to hold before committing
- `js/game.js` — screens, HUD, loop

## Not done yet

Moving platforms and hazards (trains on tracks, boats, elevators), water to
fall into, getaway vehicles other than the van, and unlockable cosmetics.

All art, characters and level design here are original.
