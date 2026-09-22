# Goal loop 2 — status board (2026-09-20, PAUSED 2026-09-22)

**Paused at the owner's request. Resume from `docs/next-steps.md`.**

Previous board (all 20 rows DONE) is in git history at b42e9fb. Same rules: workers in worktrees,
every row names its proof, nothing is DONE from code alone.

| # | Ask (owner's words) | Owner | Status | Proof |
|---|---|---|---|---|
| 1a | Infantry walk looks weird/unnatural | motion agent | DONE (merged) | `filmstrip-walk/-march/-trudge/-crouch.png`; gait.ts + legSplit.ts, skate 2.00→0.08 cm/frame (gate fault-injected) |
| 1b | Gun turret does not aim where it fires | main | DONE | `filmstrip-turret.png` (no idle hunt in resolve, 4 rad/s traverse) |
| 1c | GUI text hard to read — larger/easier where applicable | gui agent | DONE (merged) | auditUI small-text + contrast rules (fault-injected), type floors; `gpu-firefight.png` |
| 2 | Deploy from base: pick WHERE in the circle the unit lands | deploy agent | DONE (merged) | `gpu-deployflow-ring/-placed.png`, deploy.test.ts (6), smokes deploy via a point |
| 4 | Skirmish map preview could look way cooler | gui agent | DONE (merged) | `gpu-mapselect-1600x900-picked.png` — isometric diorama (mapPreview.ts) |
| 5 | Infantry still basic — more exciting and unique per unit | infantry agent | DONE (merged) | `gpu-lineup.png`, `shots/silhouette/*`, 34 new kit parts, per-kind body/limb/extras |
| 6 | Replace every Meshy hull with Blender toon models (consistent look) | vehicles agent | DONE (merged) | `gpu-siege.png`, `gpu-direction.png`; vehicles-kit.glb 25 parts, Meshy pipeline deleted, perf 483k→232k tris |
| 7 | Projectiles pass 2 — more fun to watch, on-theme | projectile agent | DONE (merged) | per-family show + no-pop easing; `gpu-temporal.png` (splotch gone), `gpu-volley-*`, filmstrips |
| 8 | Bullets going through items | main | DONE | shotBlocking.test.ts (wall slab), `filmstrip-through-*.png` ×6; bystander hulls block over footprint |
| 9 | GUIs use available space — more room to read | gui agent | DONE (merged) | panels grow with width; `gpu-viewports-*.png` at 4 widths; one-screen gate |
| 10 | Mechanics/bug/optimisation audit + dead-code refactor | audit agent | TODO — see docs/next-steps.md | test:full green, perf OK, soak:gpu clean, dead-code list in the commit |
| 3 | (done) selection ring is a toon band; plates keep clear of base pads | main | DONE | `shots/basering-sheet.png` (all 6 maps) |
| 12 | Intro cinematic flashes / shakes and wobbles at start — should be the main image then slow movement | main | DONE | `gpu-boot-mission.png` strip: still → glide → home; camera log smooth at 30ms |
| 13 | Maps: an actual theme per map with main sections, unique flares/monuments, layouts that make sense — not random trees and towers | maps agent | DONE (merged) | `gpu-map-*-wide/-<section>.png` ×24; 12 landmark kinds, per-section scatter, skylines; seats 50% |
| 11 | Final: gates + portable exe | main | TODO — see docs/next-steps.md | logs, `release/*.exe` |
| 14 | Visual glitch sweep (owner: "check whole game for visual glitches") | glitch-hunter | PARTIAL — 7 confirmed findings, fixes pending | `docs/glitch-sweep-2026-09-21.md` |
