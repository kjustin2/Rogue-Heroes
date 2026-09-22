# Where we stopped — 2026-09-22

Paused at the owner's request mid-loop-2. Everything below is on `main`, gated
(typecheck · 432 vitest · smoke:animation/flow/deep/ground/ui-audit/buttons · perf OK) and pushed.
The loop board is `docs/loop-status.md`; the open glitch list is
`docs/glitch-sweep-2026-09-21.md`.

## Landed this round (owner's list of 10 + the two live reports)

| Ask | State | Proof |
|---|---|---|
| 1a infantry walk unnatural | done | `gait.ts` + `legSplit.ts`: distance-locked stride, two-bone IK knees, heel-toe roll, walk/march/trudge/crouch tiers. Skate 2.00 → 0.08 cm/frame, gate fault-injected in `smoke:animation`. Strips `filmstrip-walk/-march/-trudge/-crouch.png` |
| 1b turret aims where it fires | done | no idle hunt during resolve + 4 rad/s traverse; `filmstrip-turret.png` |
| 1c GUI text hard to read | done | `auditUI` small-text + contrast rules (fault-injected), type floors |
| 2 pick where a unit deploys | done | placement ring + ghost, snap, cancel; `deploy.test.ts`, `gpu-deployflow-*.png` |
| 3 base circle blends into map | done | selection ring is a toon band + ink rim, draped; plates keep clear of base pads; `basering-sheet.png` |
| 4 map preview cooler | done | isometric diorama built from real map data (`src/ui/mapPreview.ts`) |
| 5 infantry more unique | done | per-kind torsos/limbs/extras (34 new parts); `gpu-lineup.png`, silhouette sheet |
| 6 no Meshy, Blender toon hulls | done | `art/vehicles/author_vehicles.py` → `vehicles-kit.glb` (25 parts); Meshy pipeline deleted; tris 483k → 232k |
| 7 projectiles pass 2 | done (needs owner's eye) | per-family show, continuous trail easing, no-pop rule; `filmstrip-*`, `gpu-volley-*`, `gpu-temporal.png` |
| 8 bullets through items | done | wall slab test (oriented box), bystander hulls block over footprint; `shotBlocking.test.ts` |
| 9 GUIs use available space | done | panels grow with width; four-viewport shots; one-screen gate |
| 12 intro cinematic wobble | done | eased rail, opening is a still, HUD hidden; `gpu-boot-mission.png` |
| 13 themed maps | done | 12 landmark kinds, named sections, per-section scatter, per-map skylines; 24 shots; seats 50% |

## Still to do — pick up here

1. **Row 10: mechanics / bug / optimisation audit + dead-code refactor.** Never started.
   Wants: a pass over sim mechanics (climb vs walk-up rules, order edge cases), `test:full`,
   `soak:gpu`, perf, and a dead-code sweep (unused exports, stale scripts, `improve/` leftovers,
   the stale `smoke:electron` assertions noted in CLAUDE.md). Dispatch as its own worker.
2. **Work the glitch list** (`docs/glitch-sweep-2026-09-21.md`, 7 confirmed, measured, with
   proposed fixes and owning functions):
   - #1 ambient weather motes draw as hard white SQUARES (most visible)
   - #2 `interactionGlow()` hangs four unlit cream bars in mid-air on every cover prop
   - #5 overlays in the pickups/mines/zones block are not draped — they bury in stepped ground
   - #7 cover props sit sunk/tilted into raised ground
   - #6 one toon program still compiles mid-resolve (warm-up twin-cloning is one-way)
   - #4/#4b tree-canopy hatch = per-part detail normal minified (fix: drop the normal at distance)
   - #3 recorded as NOT a bug (command-phase shimmer is the wind) — do not re-chase
   The sweep was stopped before the gait leg-seam check and the static per-map pass finished;
   resume it after the fixes to confirm and to finish those two sections.
3. **Owner verification of projectiles** — the splotch report was measured fixed on the
   `temporal` probe, but he should confirm in play.
4. **Final: `npm run test:full`, `soak:gpu`, perf rebase if needed, `npm run dist:exe`**, hand over
   `game/release/Rogue Heroes Tactics 0.1.0.exe`.

## Notes for whoever picks this up

- Five worktrees were used this round; all removed. `git worktree list` should show only the repo.
- `shots:gpu` gained cases: `temporal` (12 consecutive frames — the pop/splotch detector),
  `overview` (whole map + per-section frames), `baserings`, `deployflow`, `recon`, `direction`,
  `nowalk`, `vehicles`, `structures`, `viewports`, `boot`.
- `shots:step` gained `walk|march|trudge|crouch|step` modes (side profile, HUD hidden).
- Balance self-play is part of `vitest` and takes ~1 min; seats currently 50% of decided games.
