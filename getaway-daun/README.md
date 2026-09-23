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

One art pixel is three screen pixels, and that holds for **everything** —
characters, decks, props, skyline, clouds. Sprites are rigid low-res bitmaps
that rotate and sit at sub-pixel precision, so a character can tilt 37 degrees
without snapping to a grid, but nothing is drawn at a different density from
anything else. The interface has a fixed space of its own so it does not
shrink when the camera pulls back.

A racer stands about a tenth of the frame. Walkable surfaces are thin decks
with a long drop under them, never blocks filling the bottom of the screen,
and the background is pushed hard toward the sky colour in three parallax
layers so it can never be mistaken for somewhere to land.

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

The art direction is also only part-way there. Still to build: street-level
courses, the big foreground pieces (brick walls with reachable rooftops,
cutaway shop fronts, a taxi and a bus used as platforms), chain-link fence
drawn as a dither, dumpsters and trash bags, and restyled item pickups.

All art, characters and level design here are original.
