# Goal loop — status board (2026-09-18)

The orchestrator (main session) dispatches; workers run in git worktrees and report; the
coordinator agent audits this board against the owner's asks and sends everyone back to work
until every row is DONE with evidence. Nothing is DONE from code alone: each row names its proof.

| # | Ask (owner's words) | Owner | Status | Proof |
|---|---|---|---|---|
| 1 | Blender + AI research → `docs/blender-ai-pipeline.md` with examples/links | research agent | DONE | `docs/blender-ai-pipeline.md` (33 learnings, 15-item list) |
| 2 | Implement the research: vast improvements to environments, units, maps | art agent | RUNNING (items 1,3,4,5,10,14) | real-GPU shots per map + lineup |
| 3 | Menu wording audit ("Recruit Commander" is odd) — every menu, remove weird/unnecessary | menu+toon agent | RUNNING | shots:gpu menu + settings/pause shots |
| 4 | Toon look deeper: in-game feel + menus/GUI in the same language | menu+toon agent | RUNNING | shots:gpu menu/firefight |
| 5 | Units clip into the map when walking | main | DONE | `shots/filmstrip-step.png` (feet on the talus tiers) |
| 6 | Objects clip into each other on maps | main | DONE | `scatter.test.ts` green on 6 maps; vehicle radii = hull; `shots/gpu-siege.png` |
| 7 | Projectiles: SUPER polish, every family (look + motion) | projectile agent | RUNNING | filmstrips shoot/mortar/flame/laser/bolt + GPU shots |
| 8 | Selection circles glitch on base/map/units | main | DONE | `shots/gpu-rings-move.png` (draped field) |
| 9 | Smoke / stabilise / mark (sim + renderer) | main | DONE | `shots/gpu-abilities.png`, 396 tests |
| 10 | Dash / charge / breach | main | DONE | abilities3.test.ts, chaos green |
| 11 | GUI clarity pass (hints, disclosure, chrome) | gui agent | DONE (merged) | ui-audit clean 4×4 |
| 12 | One art direction (toon infantry + stylized hulls) | main | DONE | `shots/gpu-portrait-crop.png` |
| 13 | Remaining unit-identity picks (5, 8–10, 14–18, 20) | sim agent | RUNNING | tests per pick |
| 14 | Balance check after all abilities (bot-vs-bot win rates) | sim agent | RUNNING | balance.test.ts table |
| 15 | Docs: CLAUDE.md + fun-pass Status updated for everything above | main | TODO | diff |
| 17 | Map-select page: faction pick is hidden behind the Deploy button; sweep every menu so no option is occluded/buried and every choice is clear | menu+toon agent | RUNNING (sent) | gpu shots of map-select at 1280×720 / 1600×900 / 2560×1080 + ui-audit occlusion rule |
| 16 | Final: `test:full`, `soak:gpu`, perf rebase, standalone build handed over | main | TODO | logs |

Rules every worker follows: gate with typecheck + vitest + the relevant smoke, commit on the
worktree branch with `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`, never leave a dev
server running, never claim a visual change from code — screenshot it (`npm run shots:gpu -- …`
for real GPU, `npm run shots:filmstrip -- …` for motion).
