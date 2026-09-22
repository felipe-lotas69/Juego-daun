# Skyline Scramble

A two-player ragdoll race across the rooftops, the freight yard and a very
badly run office. **You cannot walk.** You lean, you let go, and you hope.

Open `index.html` in a browser. Nothing to install, nothing to build.

## Controls

|            | Lean left | Lean right | Item |
|------------|-----------|------------|------|
| Player 1   | `W`       | `E`        | `R`  |
| Player 2   | `←`       | `→`        | `↑`  |

`P` pauses. Menus take the arrows and `Enter`.

**Hold** a lean key to wind up — the longer you hold, the flatter and further
you go. **Let go** to jump. A tap is a little hop straight up; a full hold is a
long flat dive that barely leaves the ground. Learning the spread between those
two is the whole game. In the air, the same keys spin you, which is how you
land on your feet instead of your face.

If the ground goes out from under a wind-up, it fires rather than being thrown
away. Losing a charge you cannot see expire is miserable.

## Items

Crates along the course hand out one of four things: **boost** (a rocket kick
along your facing), **spring** (straight up, hard), **shield** (five seconds of
ignoring shoves), **bomb** (lobbed, and it does not care who it catches).

## Courses

Three, rotating. First racer to the van takes the round; first to three rounds
takes the match.

- **Rooftop Row** — parapets, aerials and air conditioning, over a long drop.
- **Freight Line** — a moving-day train, jumping the couplings.
- **Night Shift** — cubicles and shelving, up through the building to the exit.

## Checking it still works

```
node tools/verify-levels.js
```

Walks every course against the real launch maths — the same function the game
and the bots use, read out of the source rather than copied, so the check
cannot drift away from what a jump actually does. It reports the gap and climb
on anything unreachable, and catches checkpoints placed inside solid geometry.

## How it is put together

Everything is drawn into a 320x180 buffer and blown up whole, which is what the
art is designed against: a character is 22 pixels tall and the frame is dense
around it. Sprites are rows of characters looked up in a palette at draw time,
so one torso shape dresses four different racers, and rotation maps each
destination pixel back through the angle so nothing is ever anti-aliased.

- `js/engine.js` — maths, the pixel buffer, the font, sprite stamping, keys
- `js/art.js` — the sprite sheets, written as pixels
- `js/levels.js` — the three courses
- `js/world.js` — bodies, the verlet ragdoll they wear, the simulation
- `js/draw.js` — painting the world
- `js/bot.js` — opponents, who must decide how long to hold before committing
- `js/game.js` — screens, HUD, and the loop

All the art, characters and level design here are original.
