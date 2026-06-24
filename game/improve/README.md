# Self-improvement loop

A closed, self-iterating loop that drives the game toward a fixed set of **objective
goals** and stops only when every goal passes **two independent signals**:

- **Visual** — screenshots from a scripted play-through are the source of truth for UX goals.
- **Logical** — in-process vitest assertions + a browser state trace verify values/state.

A goal is **MET** only when its logical assertion passes **and** its screenshot evidence is
confirmed. Goals live in [`goals.mjs`](goals.mjs).

## One iteration

```
node improve/run-cycle.mjs          # vitest -> capture-flow -> check-goals  (new cycle-NNN)
```

This runs, in order, into a fresh `improve/cycles/cycle-NNN/`:

1. **vitest** (`src/game/loop-goals.test.ts` + the whole suite) → `vitest.json` — the logical signal.
2. **capture-flow** (`capture-flow.mjs`) drives the real menu + HUD + `window.__rht` across 13
   meaningful states, writing `shots/NN-*.png` + a machine-readable `state.json` trace.
3. **check-goals** (`check-goals.mjs`) evaluates every goal → `goals.json` + `report.md`.

Then a human/agent reviewer:

4. **observes** the screenshots, records verdicts in `cycles/cycle-NNN/visual-verdicts.json`
   (`{ "G10-...": { "pass": true|false, "note": "..." } }`),
5. re-evaluates with the verdicts:

```
node improve/run-cycle.mjs --check-only --cycle NNN
```

If `report.md` says **ALL GOALS MET**, stop. Otherwise implement fixes from the *Remaining
gaps* section and start the next cycle. Each cycle builds on the last.

## Why a human/agent in the loop

Steps 1–3 are fully automated commands. The *observe* (compare screenshots to intent) and
*implement* (write code) steps need judgment, so they're driven by the agent — but the
verdict is recorded as data (`visual-verdicts.json`) and the stop condition is machine-checked
by `check-goals.mjs`, so the loop is reproducible and auditable, not vibes.

## Traceability & resumability

- Every cycle is an immutable `cycles/cycle-NNN/` dir (screenshots are gitignored; reports are
  tracked). A half-finished cycle never corrupts an earlier one.
- `state/latest.json` points at the newest cycle; `state/ledger.jsonl` appends one line per run.
- Re-running `--check-only` only re-evaluates; it never recaptures, so verdicts are safe to edit.

## Files

| File | Role |
|---|---|
| `goals.mjs` | The objective goals + pass/fail criteria (visual + logical). |
| `capture-flow.mjs` | Scripted play-through → screenshots + `state.json`. |
| `check-goals.mjs` | Evaluate goals → `goals.json` + `report.md`. |
| `run-cycle.mjs` | Orchestrator: vitest → capture → check; writes cycle dir + ledger. |
| `lib/harness.mjs` | Shared Vite-server / Chromium / canvas-sample helpers. |
| `perf-bench.mjs` | Perf benchmark + memory-churn leak probe → `perf/perf-report.md`. |
| `vision.mjs` | AI inspector: clean + annotated screenshots + `scene.json`/`report.md`. |
| `../src/game/loop-goals.test.ts` | In-process logic tests mirroring the goals. |

npm aliases: `npm run improve:cycle`, `improve:capture`, `improve:check`, `perf`, `vision`.

## Cycle history

| Cycle | Met | What changed |
|---|---|---|
| 001 | 9/14 | Baseline capture + observe. Found: destroyed parts hidden when targeting (G13), faint blast ring (G10), no turn counter (G12), and framing/timing gaps (G5/G7). |
| 002 | — | Implemented: destroyed-part chips in targeting lists (G13), bolder blast-radius ring (G10); fixed capture framing (clean battle-start, framed deploy, arcing-grenade resolve). |
| 003 | **14/14** | Added a real Turn/phase HUD chip (G12) + precise probe; resolve capture now grabs the blast frame (G7). All goals met. |
| 004 | **17/17** | Batch of user requests: clean main menu + cooler bg (G15), build-deck ducks to a slim placement bar (G16), action-pace setting (G17), plus non-goal fixes — terrain z-fighting on zoom, economy/unit rebalance, command-CP cost, grenade arc block preview, second move-ring origin, end-of-round flourish, strike damage label, save/Continue latest, command-phase GC optimization, themed floor panels. |
| 005 | **19/19** | Visual polish: per-unit overhead role glyphs colored by role family (G18 — RCN/MRK/HVY/TNK/ART/… readable at a glance) and map-palette tinting of structural cover props while keeping glowing signal props vivid (G19). New `11b-unit-roster` capture step fields a spread of types for review. |
| 006 | **20/20** | Debug scenario system (G20): `window.__rht.scenario(id)` / `.scenarios()` cut straight to staged battle states. 8 scenarios (roster, siege, firefight, grenade-arc, high-ground, base-defense, victory, defeat). New standalone `npm run improve:gallery` screenshots every scenario; capture-flow step 13 + vitest "debug scenarios" guard it. |

## Debug scenario system

`window.__rht.scenario(id)` cuts the running game straight to a named, staged battle state
(and `window.__rht.scenarios()` lists them with titles/descriptions). Scenarios are defined in
`src/game/scenarios.ts` and built on debug primitives on `TacticalSim` (`debugSpawn`,
`debugBuild`, `debugDamage`, `debugDefeatTeam`, `debugGrant`, `debugSelect`, `debugSetPhase`)
that bypass the economy for instant setup. Use them in capture scripts to reach a situation in
one call instead of driving the UI. `npm run improve:gallery` screenshots all of them into
`improve/scenario-gallery/`. The `debug scenarios` vitest suite asserts they each apply cleanly.
There are 9 scenarios; `stress` (two ~40-unit armies + fortifications) is the perf benchmark's load.

## Performance + vision harness

Two standalone tools make the renderer observable — for catching bugs and for letting a
reviewing AI actually *see* the scene. Both reuse `lib/harness.mjs` and drive a new
observability surface on `window.__rht`: `perf()`, `diagnostics()`, `describeScene()`,
`sceneGraph()`, `setDebugOverlay()`.

### `npm run perf` → `improve/perf/perf-report.md`

Cuts to the `stress` scenario and samples the in-page `PerfMonitor` across the command and
resolve phases (FPS, frame-time p50/p95/p99/max, jank%, draw calls, triangles, scene
objects), then runs a **memory-churn leak probe** — 8 scenario swaps, asserting live
geometries/textures/objects don't grow. The **hard regression gate** is the deterministic
draw-work signals vs `improve/perf-baseline.json`; **FPS is advisory** (headless SwiftShader
frame time swings 10–140 fps). Rebase the baseline after an intentional cost change:

```
npm run perf -- --update-baseline
```

> This probe is how the renderer's THREE-geometry leak was found and fixed: every per-frame /
> per-swap group is now torn down with `disposeAndClear()`. Re-introducing a bare `.clear()`
> on a group of inline-geometry meshes will trip the leak check.

### `npm run vision [-- <scenario>|all]` → `improve/vision/<id>/`

Per scenario writes `clean.png`, `annotated.png` (the in-game debug overlay labels each unit
with kind/id/HP at its on-screen position), `scene.json`, and `report.md`. `describeScene()`
gives every entity's world **and** projected screen coords plus HP/selection, and
`diagnostics()` flags anomalies (NaN/out-of-bounds/stacked units, off-screen selection, stuck
projectiles, empty field, draw-call spikes). Hand an agent `annotated.png` next to `report.md`
to map pixels → game state and spot what a raw screenshot hides.
