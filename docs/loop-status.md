# Goal loop 2 — status board (2026-09-20)

Previous board (all 20 rows DONE) is in git history at b42e9fb. Same rules: workers in worktrees,
every row names its proof, nothing is DONE from code alone.

| # | Ask (owner's words) | Owner | Status | Proof |
|---|---|---|---|---|
| 1a | Infantry walk looks weird/unnatural | motion agent | TODO (wave 2) | `shots:step` + `shots:filmstrip -- walk` read by eye; smoke:animation gate |
| 1b | Gun turret does not aim where it fires | main | RUNNING | filmstrip of turret firing: barrel yaw == shot direction |
| 1c | GUI text hard to read — larger/easier where applicable | gui agent | RUNNING | contrast + min font-size audit in auditUI; gpu shots of HUD/menus |
| 2 | Deploy from base: pick WHERE in the circle the unit lands | deploy agent | DONE (merged) | `gpu-deployflow-ring/-placed.png`, deploy.test.ts (6), smokes deploy via a point |
| 4 | Skirmish map preview could look way cooler | gui agent | RUNNING | `gpu-mapselect-*.png` |
| 5 | Infantry still basic — more exciting and unique per unit | infantry agent | DONE (merged) | `gpu-lineup.png`, `shots/silhouette/*`, 34 new kit parts, per-kind body/limb/extras |
| 6 | Replace every Meshy hull with Blender toon models (consistent look) | vehicles agent | RUNNING | `gpu-direction.png`, `gpu-siege.png`, `gpu-maps`; no `.meshy.json` left in public/models |
| 7 | Projectiles pass 2 — more fun to watch, on-theme | projectile agent | TODO (wave 2) | filmstrips per family + `gpu-volley` |
| 8 | Bullets going through items | main | DONE | shotBlocking.test.ts (wall slab), `filmstrip-through-*.png` ×6; bystander hulls block over footprint |
| 9 | GUIs use available space — more room to read | gui agent | RUNNING | gpu shots at 1280×720 / 1600×900 / 2560×1080 |
| 10 | Mechanics/bug/optimisation audit + dead-code refactor | audit agent | TODO (wave 2) | test:full green, perf OK, soak:gpu clean, dead-code list in the commit |
| 3 | (done) selection ring is a toon band; plates keep clear of base pads | main | DONE | `shots/basering-sheet.png` (all 6 maps) |
| 12 | Intro cinematic flashes / shakes and wobbles at start — should be the main image then slow movement | main | DONE | `gpu-boot-mission.png` strip: still → glide → home; camera log smooth at 30ms |
| 13 | Maps: an actual theme per map with main sections, unique flares/monuments, layouts that make sense — not random trees and towers | maps agent | RUNNING | one GPU overview + one close shot per map; per-map landmark list |
| 11 | Final: gates + portable exe | main | TODO | logs, `release/*.exe` |
