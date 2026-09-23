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

Four, rotating:

| | |
|---|---|
| **Downtown** | Street level. A pavement runs the whole length of it and everything in the picture stands on that one line — the taxis, the double-deckers, the far skyline. You climb the traffic, or take the high road over a shop awning and the air-con box above it. |
| **Rooftop Row** | Thin decks over a long drop, with the towers under them going off the bottom of the frame. |
| **Freight Line** | Across a standing train in open scrub. |
| **Night Shift** | Up through an office at night, the city outside the glass. |

Downtown is built to one rule: every climb is a step of sixteen, and **every
solid piece is the same height from both sides**. A racer shoved off the back
of a bus has to be able to get over it again, and a face taller than a jump
lifts is where a race quietly ends.

## The camera

It frames everyone still racing and pulls back as they spread out, down to
about half scale. Four players in a scrum get a tight shot; four strung
across the map get a loose one.

## Checking it still works

```
node tools/verify-levels.js      # can a jump get from here to there?
node tools/race-bots.js 12       # can four bots actually finish?
```

The first walks every course against the real launch maths — the same
function the game and the bots use, read out of the source rather than
copied, so the check cannot drift from what a jump actually does.

The second is the one that finds the real problems. It runs four bots through
every course headlessly with a seeded RNG, twelve times over, and fails if
any of them is still out there at the end. Geometry that passes the first
check and traps a player anyway — a notch at the front of a bus you can stand
in but never climb out of — shows up here as `0/4 home`, and a course an
opponent cannot finish is a course a player will get stuck on too. Both run
in CI.

## How it is put together

One art pixel is six screen pixels, and that holds for **everything** —
characters, decks, props, skyline, clouds. Sprites are rigid low-res bitmaps
that rotate and sit at sub-pixel precision, so a character can tilt 37 degrees
without snapping to a grid, but nothing is drawn at a different density from
anything else. The interface has a fixed space of its own so it does not
shrink when the camera pulls back.

A racer stands about a fifth of the frame. Walkable surfaces are thin decks
with something underneath them — a tower with lit windows, a shop, a wagon —
never a grey block filling the bottom of the screen. The sky is flat and
saturated and owns the top half of the picture; the skyline behind is warm,
low, and never reaches the top edge.

Where a course has one ground line, it says so (`L.groundY`), and the far
skyline, the street, the lamp posts and the office glazing all stand on that
same line instead of on a fraction of the screen height. That is what stops
the lamps hanging in the sky the moment the camera pulls back.

- `js/engine.js` — maths, canvas, font, sprite baking, keys
- `js/art.js` — the sprite sheets, written as pixels
- `js/levels.js` — the four courses
- `js/weapons.js` — guns, bullets, recoil
- `js/world.js` — bodies, the verlet ragdoll, the simulation
- `js/draw.js` — painting the world
- `js/bot.js` — opponents, who must decide how long to hold before committing
- `js/game.js` — screens, HUD, loop

## Not done yet

Moving platforms and hazards (trains that actually move, boats, elevators,
conveyors), water to fall into, getaway vehicles other than the van, and
unlockable cosmetics.

All art, characters and level design here are original.
