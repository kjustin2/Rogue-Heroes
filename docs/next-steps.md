# Next steps — the roadmap (updated 2026-10-01)

The ONE live planning doc: where the game is, what is next, what is deliberately deferred. Read it at the
start of every session; update it at the end. Finished work lives in `git log`, not here.

## Where the game is

**Skirmish is the whole game until it is perfected** (owner's rule; Campaign and Skirmish Run were deleted
on purpose — see `CLAUDE.md`). A Skirmish: six themed maps (each with sections, a landmark, a hazard event and
its own light), three modes (Annihilation, Capture the Flag, Hold the Hill), three factions that look, play
and research differently, three AI brains (Easy / Normal / Hard differ in intelligence), or Local 2 Players.

State of `main`: `npm run verify` green (574 vitest incl. chaos, balance self-play and the movement +
projectile oracle), `npm run smoke:core` green (11 smokes), `npm run probe:terrain` 0 offenders,
`npm run measure:factions` GOAL MET, `npm run soak:gpu` with no mid-resolve shader compiles, perf gate OK.

Built most recently (for context): owner batch 3 (unit value scaling, thrown-body physics, research-gated
defenses and strikes, the tutorial, the step-flow set-up, AP wording, push, rotatable placement, fewest-words
pass); the measured faction look (silhouette kits, HQ architecture, machine dress, livery); painted terrain,
per-map light rigs, N8AO contact shading, map life; Blender HQs, hero props and faction dress; the movement +
projectile oracle and the seven bugs it found; a perf pass (no per-frame material churn, memoised colour
blends, static scenery keeps its paint, warmed debris program); base circles whole and on the board (the
board grows behind the bases, spawn spacing, flat zone rings drawn over props); bullets as burning streaks;
a toon rim on units and a lit lip on mesas; a picked base frames its deploy circle above the command panel.
Then (2026-10-02, owner batch): the air round (bomb run, gunship gun, no strafe), mid-air collisions, big high-ground
accuracy, right-click Back, base systems with real costs, A* bots that spread out and dig in, flat deploy rings on every
map, the no-go tile overlay, four Achievements pages, and a pile of UI fixes (see `docs/game-systems.md`).
Then (2026-10-01): no Deploy-now shortcut in set-up; the PLAY LOG (`game/logs/latest.log`); the locked-turret
placement fix (decks show locks, picks refuse up front, every refusal toasts its reason, every defense has a
placement ghost); Defenses decks of 5-6 and Support decks of 3 per faction (starters, tech pieces, faction-own);
three movement bugs the oracle found; the per-frame GL depth-blit error (postprocessing pinned at 6.39.2).

## Next — in priority order

1. **Owner playtest on the standalone build** (`cd game && npm run standalone`, or `npm run dist:exe`), then
   iterate off what he reports. Every report becomes a measured repro (a `shots:gpu` case, a filmstrip or a
   test) BEFORE a fix.
2. **Open overhaul picks** — `docs/overhaul-options.md` (infantry direction 1-3, landmark pass 6, destruction
   states 8, projectile trails / impact marks / muzzle pass 9-11, faction mechanics 14, faction voice 15).
   Implement only what the owner picks.
3. **Bomber AI.** The bot only bombs a foe already beneath it at the start of a turn, so self-play bombers
   average ~27 damage a game and the row sits at the band floor (it is in `UNGATED` in `balance.test.ts`).
   A bombing run (move over the nearest ground foe, release on arrival) alone took it to 1.8x the median;
   do the run AND a bomber retune (fewer loads or a smaller carpet) in one change, then un-gate it.
4. **The bot and the new decks.** It drops its strongest strike on a crowd, but never builds a defense, lays a
   minefield, paradrops or calls a utility power. Add only after the owner has played the new decks.
5. **The AI never uses Push** (the player's shove / ring-out). Add it to the Hard brain where a foe stands
   within shove reach of water or the arena edge.
6. **Attack arms.** The Blender motion banks' `shoulderPitch` / `shoulderYaw` / `offhandPitch` never reach an
   arm: arms are `"body"`-part meshes and the pose code's `part.role === "core"` branch catches them first.
   Every attack still animates (weapon, torso, recoil) but the arms hold still. Settle the SIGN on a
   filmstrip first (pistol / launcher clips raise with NEGATIVE shoulderPitch; the melee blade is swung
   with `rotation.x -= shoulderPitch`): `npm run shots:filmstrip -- pistol launcher melee`.
7. **Karak's landform.** It is the last map built on stepped pyramid mesas; a canyon, crater ring or dune
   field would give it its own. Constraints: impassable = step > `TERRAIN_STEP` or water; shelves deep enough
   to stop on (`spawnClearance`); `scatter.test.ts`, `props.test.ts`, `movement.test.ts` green; rerun self-play.
8. **Remaining unit-identity ideas** (only if asked): engineer bridge span (sandbags are now in every Defenses deck); a flak tracer wall
   that blocks air movement (needs a new persistent, serialized line object).
9. **Elites / bosses** survive in code (`debugSpawn` options + the boss bar) for a possible set piece — only
   when asked.

## Known and deliberately deferred (do not re-chase without new evidence)

- **Seat split in balance self-play** sits at 38-42% for the player seat (gate 35-65). Maps are point-
  mirrored, so a layout cannot favour a seat by itself; if `balance.test.ts` tips, widen the seed set before
  tuning, and look at resolve order / who queues first.
- **`measure:maps` contrast** is just under 0.10 on Ironworks / Karak / Crossfire (0.089-0.096); judged by eye
  as fine. Not forced.
- **`getParameters` ~2.7% of the frame** (perf:profile, stress scene) persists after the material-churn fixes;
  not vertex alphas, not the light set, not instanced shadows. Find what re-triggers three's program
  lookup before trying again.
- The heavy gunner's Syndicate / Bastion outline pair sits near the 0.80 IoU line (0.78); watch it when
  changing faction dress.
- Command-phase shimmer on grass and trees is the WIND, not a glitch.
- Real-GPU tools (`soak:gpu`, `shots:gpu`, `probe:intro`) only mean something on a machine with a GPU; under
  SwiftShader use them to check a scene renders and to read layouts, not to judge frame times.
