# improve/ — perf gate, vision inspector, scenario gallery, shared harness

| Command | What it does |
| --- | --- |
| `npm run perf` | Headless perf bench + leak probe. Gates on deterministic draw work (draw calls, triangles, objects, leak growth) against `perf-baseline.json`; FPS is advisory. `-- --update-baseline` after an intentional cost change. Output: `improve/perf/` (gitignored). |
| `npm run vision [-- <scenario>\|all]` | Per scenario: `clean.png`, `annotated.png` (debug overlay labels every unit), `scene.json` (`describeScene()` + `diagnostics()`), `report.md`. Hand the PNG + report to an agent to map pixels to state. Output: `improve/vision/` (gitignored). |
| `npm run improve:gallery` | One full-FX frame per registered scenario (`src/game/scenarios.ts`) with objective image stats. Output: `improve/scenario-gallery/` (gitignored). |

`lib/harness.mjs` is the shared smoke/shot harness (see CLAUDE.md "Smokes"): `launchGame`,
`deployBattle` (deploy through the seam — never race the menu's deferred start), `assertLit`,
`endTurnAndSettle`, `waitForCommand`.

The old screenshot-goal loop (`improve:cycle`, `goals.mjs`, `cycles/`) was retired on 2026-09-23:
its goals targeted a UI that no longer exists. Its job is done by `smoke:core`, `auditUI()` and
`shots:gpu`.
