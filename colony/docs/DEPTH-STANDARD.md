## 14. The depth standard (what "a whole mechanic" means here)

The player's instruction, in their words: *"imagine the prison system has the same depth as
Prison Architect, each mechanic has to have this level of depth and customization."*

That is a bar, and it is checkable. A system in this game is not finished when it works. It is
finished when it has all six of these:

1. **Its own entities and state.** Not a boolean on a pawn. Rooms, zones, objects, schedules,
   records, relationships between them — things the player can point at and things the
   simulation can reason about.
2. **Player-facing customisation.** Policies, schedules, quotas, assignments, filters, priorities
   — knobs with real trade-offs, not settings. If two competent players would configure it
   differently and both be right, it has this.
3. **Failure modes that are the player's fault.** A system that can only be done correctly is
   decoration. There must be ways to run it badly that produce a specific, legible disaster the
   player can trace back to their own decision.
4. **Feedback loops into other systems.** It must both read from and write to mood, health,
   economy, security, factions or the world. A subsystem that only talks to itself is a minigame.
5. **A UI surface that makes it legible.** A tab or panel showing its state, its history and its
   knobs. If the player cannot see why it went wrong, it did not go wrong — it just broke.
6. **Emergent stories.** Some combination of its parts should produce a sentence the player
   wants to repeat. That is the actual test.

Where an existing system falls short of this, it is unfinished, not done.

## 15. The prison and confinement layer (built to section 14)

Three files, with hard ownership boundaries because two of their neighbours already exist.

**Who owns what, frozen:**
- `js/prisoners.js` (ON DISK, do not rewrite): capture, prisoner beds, basic warden work,
  recruitment by wearing down resistance, release, execution.
- `js/slavery.js` (being written now): enslavement, suppression, rebellion, the slave trade,
  cannibalism and corpse display.
- `js/prison.js` (new): the FACILITY and the REGIME — cells, blocks, grading, intake,
  classification, the daily schedule, security, patrols, searches, lockdown, riots, escape.
- `js/contraband.js` (new): the underground — smuggling, stashes, dealers, shakedowns,
  informants, prisoner gangs and their territory.
- `js/reform.js` (new): programmes and outcomes — education, therapy, addiction treatment,
  ideological conversion, work programmes, parole, recidivism, ransom.

None of these may edit the others. Each guards its neighbours with typeof and works alone.
