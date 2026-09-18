# Goal loop — status board (2026-09-18)

The orchestrator (main session) dispatches; workers run in git worktrees and report; the
coordinator agent audits this board against the owner's asks and sends everyone back to work
until every row is DONE with evidence. Nothing is DONE from code alone: each row names its proof.

| # | Ask (owner's words) | Owner | Status | Proof |
|---|---|---|---|---|
| 1 | Blender + AI research → `docs/blender-ai-pipeline.md` with examples/links | research agent | DONE | `docs/blender-ai-pipeline.md` (33 learnings, 15-item list) |
| 2 | Implement the research: vast improvements to environments, units, maps | art agent | DONE (merged) | `gpu-map-*.png` ×6, `gpu-lineup.png`; props-kit.glb (29 variants), Cycles AO, validator, warm/cool ramp |
| 3 | Menu wording audit ("Recruit Commander" is odd) — every menu, remove weird/unnecessary | menu+toon agent | DONE (merged) | `gpu-menu.png` (no Recruit Commander), 40-line before→after list in merge commit |
| 4 | Toon look deeper: in-game feel + menus/GUI in the same language | menu+toon agent | DONE (merged) | toon tokens in style.css; `gpu-mapselect-*.png`, `gpu-firefight.png` |
| 5 | Units clip into the map when walking | main | DONE | `shots/filmstrip-step.png` (feet on the talus tiers) |
| 6 | Objects clip into each other on maps | main | DONE | `scatter.test.ts` green on 6 maps; vehicle radii = hull; `shots/gpu-siege.png` |
| 7 | Projectiles: SUPER polish, every family (look + motion) | projectile agent | DONE (merged) | `filmstrip-<family>.png` ×14, `gpu-volley-{flight,impact,late}.png`; projectileFx.ts |
| 8 | Selection circles glitch on base/map/units | main | DONE | `gpu-rings-move/-build/-aura.png` (move field, build circle, aura ring all draped) |
| 9 | Smoke / stabilise / mark (sim + renderer) | main | DONE | `shots/gpu-abilities.png`, 396 tests |
| 10 | Dash / charge / breach | main | DONE | abilities3.test.ts, chaos green |
| 11 | GUI clarity pass (hints, disclosure, chrome) | gui agent | DONE (merged) | ui-audit clean 4×4 |
| 12 | One art direction (toon infantry + stylized hulls) | main | DONE | `gpu-direction.png` (tank + APC + troopers, one ramp/outline) |
| 13 | Remaining unit-identity picks (5, 8–10, 14–18, 20) | sim agent | RUNNING | tests per pick |
| 14 | Balance check after all abilities (bot-vs-bot win rates) | sim agent | RUNNING | balance.test.ts table |
| 15 | Docs: CLAUDE.md + fun-pass Status updated for everything above | main | TODO | diff |
| 17 | Map-select page: faction pick is hidden behind the Deploy button; sweep every menu so no option is occluded/buried and every choice is clear | menu+toon agent | DONE (merged) | `gpu-mapselect-1280x720-picked.png` etc.; auditUI `occluded` rule fault-injected in smoke:ui-audit |
| 18 | Where units can't walk must read (water/cliffs) — coordinator gap for ask 3 | main | DONE | `gpu-nowalk-water.png` (plates off water, toon waves, inked rim), `gpu-nowalk-cliff.png` |
| 19 | Per-map prop variety (≥6 theme kinds per map) — coordinator gap for asks 2/7 | art agent | DONE (merged) | 8–12 kinds per map, `gpu-map-*.png` |
| 20 | Hit reactions for cannon/mortar/flamer/bomb — coordinator gap for ask 1 | projectile agent | DONE (merged) | `shoveNear` on blast/impact/bolt; `filmstrip-flame.png` shows the target rock |
| 16 | Final: `test:full`, `soak:gpu`, perf rebase, standalone build handed over | main | TODO | logs |

Rules every worker follows: gate with typecheck + vitest + the relevant smoke, commit on the
worktree branch with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`, never leave a dev
server running, never claim a visual change from code — screenshot it (`npm run shots:gpu -- …`
for real GPU, `npm run shots:filmstrip -- …` for motion).
