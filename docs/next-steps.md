# Next steps — the roadmap (updated 2026-09-23)

This is the ONE live planning doc. Read it at the start of every session; update it at the end.
Setup for a fresh clone: root `README.md`. Engineering rules: `CLAUDE.md`.

## Where the game is

**Skirmish is the whole game until it is perfected** (owner's rule — Campaign and Skirmish Run were
deleted on purpose; see "SKIRMISH ONLY" in `CLAUDE.md` for the ban list). A Skirmish is: six themed
maps, each with its own sections, landmarks and hazard event; three modes (Annihilation, Capture the
Flag, Hold the Hill); three factions that look, play and research differently; three AI brains
(Easy / Normal / Hard differ in intelligence, not just stats); or Local 2 Players hotseat.

State of the checkout: `npm run verify` green (typecheck, script syntax, 430+ vitest incl. chaos +
balance self-play, build); `npm run smoke:core` green; `npm run perf` OK against the baseline;
`npm run smoke:electron` green. Everything is committed on `main`.

What was built in the last stretch (for context, not to redo): one toon art direction end to end
(Blender kits for infantry, props, vehicles — no Meshy anywhere), distance-locked infantry gait with
IK knees, per-family death animations, ballistic projectile FX with a no-pop rule, deploy-anywhere
placement, draped ground overlays, themed maps, the research table, achievements, the toon UI with
measured readability gates, and a whole-game glitch sweep whose findings were all fixed.

## Next — in priority order

0. **Faction identity (2026-09-23)** landed on `claude/faction-identity-7pi5tb`: each faction owns
   its own units, one strike and one doctrine rule (Rapid Response / Scavengers / Dig In), plus
   helmet colours and vehicle add-ons. Playtest all three against the bot; the numbers most likely
   to want tuning are the 30% bounty, the 0.75 dig-in multiplier and `enemyStrikeAct`'s threshold.
   Details in `CLAUDE.md` ("FACTIONS play, look and fight differently").
1. **Owner playtest of Skirmish on the standalone build**, then iterate off what he reports.
   Build it with `cd game && npm run standalone` (or `npm run dist:exe` on Windows). Areas that
   changed most and have had the least human play: deaths, projectiles, the research table, the
   Ironworks slag spill, the three AI brains, hotseat, themed map layouts. Every report becomes a
   measured repro (a `shots:gpu` case, a filmstrip, or a test) BEFORE a fix — see "How to work".
2. **Balance pass from play**, not from self-play alone. `balance.test.ts` gates the extremes
   (per-kind damage per $ within 0.5x–2.5x of the median; seats 35–65%) but the striker and tank
   sit near the top of the band. Tune `src/game/units.ts` only with the self-play table in hand.
3. **Map terrain vocabulary.** Karak and Verdant both use stepped pyramid mesas; distinct palettes
   and events, but a map pass could give each map its own landform (canyons, terraces, craters,
   dunes). Constraints: impassable = step > `TERRAIN_STEP` or water; `scatter.test.ts` must stay
   green; rerun balance self-play (it moved 15 points on one layout change before).
4. **Remaining unit-identity ideas** (only if the owner wants more depth):
   - Engineer: deployable bridge span or sandbag line (reuse the Defenses placement flow).
   - Flak: a one-turn tracer wall that reveals and blocks air movement through it (needs a new
     persistent, serialized, rendered line object — that is why it was skipped).
   - Hit reactions per body part: head snaps back, leg buckles, pack spins (today one shove).
5. **Elites / bosses** survive in code (`debugSpawn` options + the top-of-screen boss bar) for a
   possible Skirmish set piece — only when asked.

## Known and deliberately deferred (do not re-chase without new evidence)

- `soak:gpu` sees ONE toon program compile on the first resolve (a transparent toon material
  created mid-resolve; key diff field #51). Not a visible hitch — max frame 20.8 ms, same as later
  resolves. Twin-cloning both vertex-colour states did not catch it; find the material created
  mid-resolve before trying again.
- Command-phase shimmer on grass and trees is the WIND (ground detail + tree sway), not a glitch.
- The real-GPU tools (`soak:gpu`, `shots:gpu`, `probe:intro`) only mean something on a machine
  with a GPU. In a cloud container they run under `xvfb-run` on SwiftShader: use them to check that
  a scene renders and to read layouts, not to judge frame times or subtle shading.

## How to work (the rules that kept this repo sane)

- **Gate every commit with `npm run verify`**; run `npm run test:full` before handing a build over.
- **Never claim a visual change from code.** Screenshot it (`npm run shots:gpu -- <case>`), judge
  motion on filmstrips (`shots:filmstrip`, `shots:step`), and READ the images.
- **Bisect before you tune** any rendering artefact (see the hatching ledger in `CLAUDE.md`).
- One test script at a time (they share the GPU); never leave a dev server running.
- The owner tests on the standalone build, not the dev server. Hand him a build, not a report.
