# Where we are — 2026-09-22 (evening)

Direction change: **Skirmish is the only mode until it is perfected.** Campaign and Skirmish Run
were deleted (see "SKIRMISH ONLY" in `CLAUDE.md` for the ban list).

## Landed this round

| Ask | State | Proof |
|---|---|---|
| Title screen shakes like an earthquake before the slow pan | fixed at the root: the first frame's `dt` was negative and ran the trauma decay backwards | `npm run probe:intro` (real GPU): camera jitter 1.48 → 0.03 |
| Glitch sweep #1 weather motes as white squares | soft round clamped points | `gpu-map-causeway.png` |
| Glitch sweep #2 floating cream brackets on cover | deleted | `gpu-map-verdant.png` |
| Glitch sweep #5 + owner report: pickup circles bury in the ground | every static ground overlay draped (`drapedDisc`), aim splash disc draped | `gpu-map-causeway.png` |
| Glitch sweep #7 props sunk into raised ground | props stand on the drawn ground | — |
| Glitch sweep #6 mid-resolve shader compile | warm-up twins symmetric; the original opaque-variant compile is gone | `soak:gpu`: resolve-1 max 20.8ms, jank 0%, same as resolves 2-3 |
| Glitch sweep #4/4b canopy hatch | detail normal map removed from part materials | — |
| Units look blurry | aircraft/flak/fallback hulls wear the ink rim; pale steel/glass toned; white marker pip removed; headlamps no longer bloom | `gpu-air.png`, `gpu-vehicles-close.png` |
| Cooler death animations | thrown / crumple / spin (infantry), wreck + turret throw (vehicles), spiral + crash (aircraft) | `gpu-deaths*.png` |
| Projectiles look like laser beams | one ballistic language: warm tracers, marksman vapour trail, no energy darts | `gpu-volley-flight.png` |
| Remove Campaign + Skirmish Run | deleted everywhere; menu is Continue / Play Skirmish | `gpu-menu.png` |
| Achievements page on the main menu | 13 medals with progress meters + lifetime stats | `gpu-achievements.png` |
| Tech tree confusing | rebuilt as a research table: doctrine → unlocks, two specializations with OR | `gpu-tech-fresh.png`, `gpu-tech-mid.png` |
| Each map unique | Ironworks gets its own SLAG SPILL event (was a copy of Karak's collapse); forecast shows lightning | `storm.test.ts` |
| Dead code / stale scripts / stale docs | 27 unwired scripts, 8 stale docs, 6 dead exports removed | commits `a034607`, `d64fac2` |
| Cloud setup docs | root README rewritten; the harness finds Chromium on Linux/macOS too | `README.md` |

## Next — pick up here

1. **Owner playtest of Skirmish** on the standalone build: deaths, projectiles, the research
   table, the slag spill. Iterate off what he reports.
2. **Skirmish depth** (only when asked): elites/bosses survive in code (`debugSpawn` options + the
   boss bar) for a possible Skirmish set piece.
3. Known and deferred:
   - `soak:gpu` still sees ONE toon program compile on the first resolve (key diff field #51,
     2049 -> 1: a transparent toon material created during the resolve). Not a visible hitch
     (max frame 20.8ms, same as later resolves). Twin-cloning both vertex-colour states did NOT
     catch it -- find the material created mid-resolve before trying again.
   - `smoke:electron` gameplay assertions are stale (pre-placed units) — `smoke:flow` covers it.
   - A registered worktree `.claude/worktrees/compassionate-mcclintock-ba533c` exists from another
     session; it was left alone.
   - Karak and Verdant both use stepped pyramid mesas — distinct palettes and events, but a future
     map pass could vary the terrain vocabulary.
