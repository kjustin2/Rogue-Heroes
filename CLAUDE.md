# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project layout

The entire app lives in **`game/`** — run every command from there (`cd game` first). The
repo root holds only the README, design notes (`improve*.md`, `docs/`), and scratch images.

It is a **Vite + TypeScript + Three.js** single-page game with an **Electron** desktop
wrapper. Runtime dependency is just `three`; everything else is dev tooling.

## Commands (run from `game/`)

| Task | Command |
| --- | --- |
| Dev server (port **5175**) | `npm run dev` |
| Typecheck only | `npm run typecheck` (`tsc --noEmit`) |
| Unit tests (vitest) | `npm test` |
| Single test file | `npx vitest run src/game/sim.test.ts` |
| Single test by name | `npx vitest run -t "name substring"` |
| Watch a test | `npx vitest src/game/sim.test.ts` |
| Build (typecheck + bundle) | `npm run build` |
| **Gate before commit** | `npm run verify` (typecheck → test → build) |
| Full gate + smokes | `npm run test:full` |
| **Perf bench + leak probe** | `npm run perf` (`-- --update-baseline` to rebase) |
| **AI vision inspector** | `npm run vision` (`-- <scenario>` or `-- all`) |
| Scenario screenshot gallery | `npm run improve:gallery` |
| Desktop app (build + Electron) | `npm run standalone` |

TypeScript is **strict** with `noUnusedLocals`/`noUnusedParameters` — unused symbols fail
the build, so `npm run verify` catches more than tests alone.

### Smoke tests (Playwright)

Each smoke script (`scripts/smoke-*.mjs`) launches its **own** Vite server on a dedicated
`--strictPort` and drives a headless Chromium (`playwright-core`) via the `window.__rht`
debug API. Ports are deliberately distinct because a sibling project squats **5175**:
flow `5179`, economy `5176`, buttons `5191`, screenshot tools `5177`/`5178`.

- `npm run smoke:flow` — menu → deploy → multi-turn battle → reset
- `npm run smoke:economy`, `npm run smoke:buttons`
- `npm run smoke:electron` — builds, then boots the packaged Electron app
- Smokes that test gameplay must navigate the menu (click `[data-menu="play"]`, pick a
  `[data-map]`, then `[data-start]`) and usually grant cash with
  `sim.economy.set("player", N)` so they exercise mechanics, not the price curve.

Smokes need the Playwright Chromium cache (`%LOCALAPPDATA%\ms-playwright\chromium-*`) or
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

### Debug / perf / vision harness

Three capabilities make the renderer observable to both automated checks and a reviewing
AI. They share the same headless-Chromium plumbing (`improve/lib/harness.mjs`) and own
ports `perf 5182`, `vision 5183`.

- **`npm run perf`** (`improve/perf-bench.mjs`) — cuts to the heavy `stress` scenario and
  samples `window.__rht.perf()` across the command + resolve phases, then runs a
  memory-churn probe (repeated scenario swaps) to catch geometry/texture leaks. Writes
  `improve/perf/perf-report.md`. The **hard gate** is the deterministic draw-work signals
  (draw calls, triangles, scene objects, leak growth) compared to
  `improve/perf-baseline.json`; **FPS is advisory only** because headless SwiftShader frame
  time is noisy (10–140 fps seen). Rebase with `npm run perf -- --update-baseline` after an
  intentional cost change.
- **`npm run vision`** (`improve/vision.mjs`) — for each scenario, captures `clean.png`, an
  `annotated.png` (the in-game debug overlay labels every unit with kind/id/HP at its
  on-screen position), plus `scene.json` + `report.md` (`describeScene()` with world AND
  screen coords, and the `diagnostics()` anomaly scan). Hand the agent `annotated.png`
  beside `report.md` to map pixels → game state. `-- all` does every scenario.
- **`diagnostics()`** is the bug scanner: NaN positions, out-of-bounds/stacked units,
  selected-unit-off-screen, stuck projectiles, empty field, draw-call spikes, frozen render.
  Pure logic lives in `src/debug/diagnostics.ts` (unit-tested); perf math in
  `src/render/perfMonitor.ts`. The overlay (`src/debug/debugOverlay.ts`) mounts on
  `<body>`, **not** `#ui` (the HUD rewrites `#ui`'s innerHTML each frame).

> Renderer disposal rule: every per-frame / per-swap THREE group is torn down via
> `disposeAndClear()` (→ `disposeSubtree`), which frees Mesh/Line **geometry** only —
> Sprites and pooled geometries tagged `userData.shared` are skipped (materials/textures are
> shared and left alone). Skipping this is how the geometry-leak the perf probe guards
> against creeps back in.

### Self-improvement loop (`game/improve/`)

A closed capture→observe→implement→verify→decide loop that drives the game toward the
objective goals in `improve/goals.mjs`. Each goal is gated on **two signals**: a logical
assertion (vitest + a browser state trace) and a screenshot (the visual source of truth).
`npm run improve:cycle` runs vitest → `capture-flow.mjs` (a 13-step play-through saving
`shots/NN-*.png` + `state.json`) → `check-goals.mjs`, producing an immutable
`improve/cycles/cycle-NNN/report.md`. After reviewing the shots, record verdicts in that
cycle's `visual-verdicts.json` and re-evaluate with
`node improve/run-cycle.mjs --check-only --cycle NNN`. See `improve/README.md`. The logic
half lives in `src/game/loop-goals.test.ts` (suite "loop goals").

## Architecture

A turn-based 3D tactics skirmish. The cardinal rule is a **one-way data flow**: the
simulation is the single source of truth, and the renderer + HUD only ever *read* from it.

### Three decoupled layers

- **Simulation** — `src/game/` (no Three.js, no DOM). Pure, deterministic, testable.
- **Renderer** — `src/render/` (Three.js). Reads sim state each frame; never mutates it.
- **HUD** — `src/ui/hud.ts` (DOM). Renders battle UI by diffing an `innerHTML` string
  (`lastHtml`); issues player actions back through callbacks.

`src/main.ts` is the **composition root** that owns everything the three layers don't:
the `requestAnimationFrame` frame loop, all keyboard/pointer input, the full-screen menu
system (main menu, deploy screen, settings, armory, pause/controls overlays), tutorial,
localStorage save/load, and the camera-assist that auto-frames the action.

The frame loop is: `stage.update(dt)` (camera) → `sim.update(dt)` (advances the resolve
animation) → audio/end-state checks → `world.update(sim, ...)` (rebuild visuals from sim)
→ throttled `hud.update()` → `stage.render()`.

### `TacticalSim` (`src/game/sim.ts`) — the state machine

The authoritative game object. ~3200 lines; the most important file in the repo.

- **Phases**: `command` → `resolve` → `victory`/`defeat`. Players queue orders during
  `command`; `endTurn()` appends the enemy AI's orders and flips to `resolve`, which plays
  out over real seconds inside `update(dt)` (projectiles fly, damage lands) before returning
  to `command`.
- **Determinism**: seeded `Rng` (seed `0x726f6775`), reseeded by `configure()`. Resolves
  and tests are reproducible. Do not introduce `Math.random()` into sim code.
- **Entities are per-part**: every `CombatEntity` (`damageModel.ts`) is a bag of `parts`
  with roles (`core`/`head`/`weapon`/`mobility`/…). `applyDamage` hits a part;
  `recomputeStatus` derives the entity's capabilities (`canMove`, `canShoot`, `alive`, …)
  from part HP. Aiming targets a part; cover/terrain can intercept a shot first.
- **Economy**: per-team money + per-entity **command points** (CP). Deploying, building,
  researching, moving, and shooting each spend CP and/or money. The Home `base` carries the
  economy state (`incomeLevel`, `unlockedTech`, `spawnCooldowns`).
- `serialize()`/`restore()` JSON round-trip the whole battle for in-game Save (entities are
  plain data). Always resumes in `command` phase.
- Public `queue*` / `preview*` / `*FailureReason` methods are the player API; the HUD and
  `window.__rht` call them. `preview*` returns the data the HUD shows before committing.

### Data-only modules (`src/game/`)

These are catalogs/specs with no engine dependencies — the tuning surface of the game:

- `units.ts` — `TROOP_CATALOG` (12 troop kinds) + `DEFENSE_CATALOG` (turret/wall/exturret).
- `tech.ts` — `TECH_TREE`, a branching research tree gating which troops can be deployed.
- `modes.ts` — the three win conditions (`destroy`/`ctf`/`hill`); win logic itself is in sim.
- `maps.ts` — `MapDef`s: terrain, base positions, themes, and procedural cover scatter
  (mirrored west↔east for fairness). `scenario.ts` builds the opening entity list (just the
  two bases + neutral cover — **no units start on the field**).
- `damageModel.ts` — entity/part factories (`createSoldier`, `createTank`, `createBase`…),
  cover profiles, and the damage/status functions.

### Terrain is a mutable singleton (`src/game/terrain.ts`)

Terrain is a block heightfield (raised flat-topped rectangles; height ≥ 0, no basins).
`setActiveTerrain(spec)` swaps the global active blocks + `ARENA_BOUNDS`, so `configure()`-ing
a map mutates shared state. `terrainHeightAt(point)` and `clampToArena` read that singleton.
Tests that construct `TacticalSim` from a raw entity list keep `DEFAULT_TERRAIN` (which has a
fixed mesa the line-of-sight/cover tests rely on).

### `window.__rht` — the test/debug bridge

`main.ts` exposes a global `window.__rht` with `sim` plus thin wrappers (`endTurn`, `reset`,
`queueSpawnTroop`, `researchTech`, `money`, `camera`, `renderDebug`, …). This is the entire
surface the Playwright smokes script the game through — keep it in sync when adding sim
features that smokes need to drive.

**Observability surface** (drives perf/vision): `perf()` → FPS + frame-time percentiles +
draw calls/triangles + scene-object count; `perfReset()` starts a fresh window;
`diagnostics()` → the anomaly scan (`{ ok, errors, warnings, issues[] }`); `describeScene()`
→ every entity with world + projected screen coords, HP, and selection (AI-readable);
`sceneGraph()` → `{ total, topLevel }` object counts; `setDebugOverlay(on)` toggles the
on-screen entity-label overlay.

**Debug scenarios:** `window.__rht.scenario(id)` cuts straight to a staged battle state and
`window.__rht.scenarios()` lists them. Scenarios live in `src/game/scenarios.ts`, built on
`TacticalSim` debug primitives (`debugSpawn`/`debugBuild`/`debugDamage`/`debugDefeatTeam`/
`debugGrant`/`debugSelect`/`debugSetPhase`) that bypass the economy for instant setup. Use
these in tests/captures to reach a situation in one call. `npm run improve:gallery`
screenshots every scenario.

### Electron packaging

`electron-main.cjs` serves the built `dist/` over a local `http` server on a random port and
loads it in a sandboxed `BrowserWindow` (no `file://`, contextIsolation on). `npm run desktop`
runs Electron against an existing `dist/`; `npm run standalone` builds first.

## Persistence

All client state is localStorage, keyed `rht.*`: `rht.settings.v1` (`settings.ts`),
`rht.progression.v1` (points + cosmetic accents, `progression.ts`), `rht.savedBattle.v1`
(the in-combat Save). Progression/cosmetics are **purely cosmetic** — no gameplay effect.
