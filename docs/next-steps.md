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

1. **Owner playtest of Skirmish on the standalone build**, then iterate off what he reports.
   Build it with `cd game && npm run standalone` (or `npm run dist:exe` on Windows). Areas that
   changed most and have had the least human play: deaths, projectiles, the research table, the
   Ironworks slag spill, the three AI brains, hotseat, themed map layouts. Every report becomes a
   measured repro (a `shots:gpu` case, a filmstrip, or a test) BEFORE a fix — see "How to work".
2. **Balance pass from play**, not from self-play alone. `balance.test.ts` gates the extremes
   (per-kind damage per $ within 0.5x–2.5x of the median; seats 35–65%) but the striker and tank
   sit near the top of the band. Tune `src/game/units.ts` only with the self-play table in hand.
3. **Map terrain vocabulary.** Verdant Pass is DONE (2026-09-23): its two stepped pyramid
   mountains are now farmed TERRACES, three shelves per valley side climbing to the map edge in
   0.8 risers with jogged lips, hedges and stumps on the lower shelf. Karak is the one map still
   built on stepped pyramid mesas (NW/SE); a canyon, crater ring or dune field would give it its
   own landform. Constraints: impassable = step > `TERRAIN_STEP` or water; shelves must be deep
   enough to stop on (`spawnClearance`: 1.4m infantry, ~2.6m tank); `scatter.test.ts` must stay
   green; rerun balance self-play (the Verdant change moved Verdant from 4 draws to 2 and pushed
   the bomber row under the floor, see the next item).
   **Bomber AI (found on the Verdant pass).** The bot only bombs a foe that is already beneath
   it at the START of a turn; flying toward one spends the turn, so 34 self-play bombers averaged
   ~27 damage a game and the row sits at the band floor on noise alone. Tried in the Verdant
   branch and reverted (too big a balance swing for a map change): a bombing run (move over the
   nearest ground foe in reach, release on arrival — an actor's orders run in sequence) took the
   bomber to 1.8x the median; requiring a group of two took it to 2.3x and sank the APC to 0.38x.
   So the aircraft is fine and the AI is what is weak. The fix is that run plus a bomber retune
   (fewer loads or a smaller carpet) in one change, then take `bomber` back out of `UNGATED`
   in `balance.test.ts`.
4. **Remaining unit-identity ideas** (only if the owner wants more depth):
   - Engineer: deployable bridge span or sandbag line (reuse the Defenses placement flow).
   - Flak: a one-turn tracer wall that reveals and blocks air movement through it (needs a new
     persistent, serialized, rendered line object — that is why it was skipped).
   - Hit reactions per body part: head snaps back, leg buckles, pack spins (today one shove).
   - **Attack arms (found by the 2026-09-23 attack audit, not fixed):** the Blender motion banks'
     `shoulderPitch` / `shoulderYaw` / `offhandPitch` channels never reach an arm, because arms
     are `"body"`-part meshes and the pose code's `part.role === "core"` branch catches them first
     (they get the torso's pitch instead). Every attack still animates (weapon, torso, recoil,
     rounds), but the arms hold still. Before moving the limb branches up, settle the SIGN on a
     filmstrip: the pistol and launcher clips raise the arm with NEGATIVE shoulderPitch, while the
     melee blade (which is live) is swung with `rotation.x -= shoulderPitch` — the two readings
     disagree, and the arm has to follow the blade. Films: `shots:filmstrip -- pistol launcher melee`.
5. **Elites / bosses** survive in code (`debugSpawn` options + the top-of-screen boss bar) for a
   possible Skirmish set piece — only when asked.

## Known and deliberately deferred (do not re-chase without new evidence)

- **Balance self-play seat split moved toward the gate's low edge** with the 2026-09-23 map-props
  pass: player seat 40% of decided games (8 / 12, 16 draws) on top of the Verdant terraces, vs
  58% (11 / 8) before either change (35% with the props alone). Maps are point-mirrored, so a layout
  cannot favour a seat by itself; at ~20 decided games this is inside the noise, but a later
  layout change may tip `balance.test.ts` red. If it does, widen the seed set before tuning.

- `soak:gpu` sees ONE toon program compile on the first resolve (a transparent toon material
  created mid-resolve; key diff field #51). Not a visible hitch — max frame 20.8 ms, same as later
  resolves. Twin-cloning both vertex-colour states did not catch it; find the material created
  mid-resolve before trying again.
- Command-phase shimmer on grass and trees is the WIND (ground detail + tree sway), not a glitch.
- The real-GPU tools (`soak:gpu`, `shots:gpu`, `probe:intro`) only mean something on a machine
  with a GPU. In a cloud container they run under `xvfb-run` on SwiftShader: use them to check that
  a scene renders and to read layouts, not to judge frame times or subtle shading.
  There a resolve takes ~40s of wall time (the clock runs on rendered frames), which is why
  `smoke:flow` now waits up to 120s for a turn; under `?lowfx=1` SwiftShader also drops the big
  ground plane in wide views (sky shows through), on `main` as much as anywhere.

## How to work (the rules that kept this repo sane)

- **Gate every commit with `npm run verify`**; run `npm run test:full` before handing a build over.
- **Never claim a visual change from code.** Screenshot it (`npm run shots:gpu -- <case>`), judge
  motion on filmstrips (`shots:filmstrip`, `shots:step`), and READ the images.
- **Bisect before you tune** any rendering artefact (see the hatching ledger in `CLAUDE.md`).
- One test script at a time (they share the GPU); never leave a dev server running.
- The owner tests on the standalone build, not the dev server. Hand him a build, not a report.
