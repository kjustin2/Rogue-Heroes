# CLAUDE.md

Guidance for Claude Code in this repository.

## Layout

Everything lives in **`game/`** — run all commands from there (`cd game` first). The repo
root holds only README, design notes, and `docs/`. The `game/` subdir is **legacy**; new
games are flat (package.json at root) — don't copy this layout forward.

Vite + strict TypeScript + Three.js, Electron desktop wrapper. Runtime deps: `three`,
`postprocessing`, `@fontsource/*`. `noUnusedLocals`/`noUnusedParameters` are on — unused
symbols fail the build.

## Commands (from `game/`)

| Task | Command |
| --- | --- |
| Dev server (port **5175**) | `npm run dev` |
| Typecheck | `npm run typecheck` |
| Unit tests (vitest) | `npm test` (single file: `npx vitest run src/game/sim.test.ts`) |
| Build | `npm run build` (tsc + vite build) |
| **Gate before commit** | `npm run verify` (typecheck → test → build) |
| Full gate + smokes | `npm run test:full` |
| Perf bench + leak probe | `npm run perf` (`-- --update-baseline` to rebase) |
| AI vision inspector | `npm run vision` (`-- <scenario>` or `-- all`) |
| Scenario screenshot gallery | `npm run improve:gallery` |
| Review contact sheet → `shots/` | `npm run screens` |
| Build + Electron gameplay smoke | `npm run test:play` |
| Desktop app (build + Electron) | `npm run standalone` |
| **One-command shareable .exe** | `npm run dist:exe` (portable, → `release/`) |

### Smokes (Playwright, `scripts/smoke-*.mjs`)

Each smoke launches its own Vite server on a dedicated `--strictPort` (a sibling project
squats 5175): flow `5179`, economy `5176`, buttons `5191`, screenshots `5177`/`5178`,
perf `5182`, vision `5183`. They drive headless Chromium via `window.__rht`.

- `npm run smoke:flow` — menu → deploy → multi-turn battle → reset
- `npm run smoke:economy`, `npm run smoke:buttons`
- **`smoke:electron` gameplay assertions are stale** (assumes pre-placed units that no
  longer exist); use `smoke:flow` until fixed. `test:play` wraps it, so it inherits this.
- Gameplay smokes must navigate the menu (`[data-menu="play"]` → `[data-map]` →
  `[data-start]`) and usually grant cash via `sim.economy.set("player", N)`.
- **`?lowfx=1`** forces the composer-free render path — functional smokes and perf use it
  (SwiftShader stalls on the bloom chain); `vision`/gallery run full-FX.
- Needs the Playwright Chromium cache or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

## Meshy scope (deliberate per-repo exception)

This repo's sanctioned Meshy scope is **hard-surface vehicle/structure/prop hulls**
(tank, apc, artillery, hq, turret, rock, crates, sandbags, barricade — it works here).
**Infantry/characters stay procedural.** This intentionally goes beyond the global
"static set-dressing only" default — do not "fix" it back, and do not expand it to
characters. Generation is offline: `MESHY_API_KEY` in gitignored `game/.env`, then
`node --env-file=.env scripts/build-models.mjs` (`--balance` first; ~30 credits/model;
raw GLBs cache in `assets-raw/`). GLBs live in `game/public/models/` with `.meshy.json`
sidecars; `src/render/models.ts` async-loads them and **falls back to procedural
builders** — dev/CI never depend on assets.

## Perf / vision / improve loop

Machinery is documented in **`game/improve/README.md`** — read that. Commands:
`npm run perf`, `npm run vision`, `npm run improve:cycle`, `npm run improve:gallery`.
Repo gotchas:

- **FPS is advisory only** — the hard perf gate is deterministic draw-work signals
  (draw calls, triangles, objects, leak growth) vs `improve/perf-baseline.json`.
  Rebase with `npm run perf -- --update-baseline` after an intentional cost change.
- The debug overlay mounts on `<body>`, **not** `#ui` (HUD rewrites `#ui` each frame).

## Architecture (repo-specific facts)

Standard three-layer split (pure sim → read-only renderer → DOM HUD, composition root
`src/main.ts`). What's specific here:

- **`src/game/sim.ts` (~3200 lines) is authoritative** — the most important file.
  Phases `command` → `resolve` → `victory`/`defeat`. Seeded `Rng`; no `Math.random()`
  in sim code.
- **Per-part damage** (`damageModel.ts`): entities are bags of parts; `applyDamage`
  hits a part, `recomputeStatus` derives `canMove`/`canShoot`/`alive`.
- **Terrain is a mutable singleton** (`src/game/terrain.ts`): `setActiveTerrain` swaps
  global blocks + `ARENA_BOUNDS`; `configure()`-ing a map mutates shared state. Tests
  building `TacticalSim` from raw entities rely on `DEFAULT_TERRAIN`'s fixed mesa.
- **`serialize()`/`restore()`** JSON round-trip the battle; always resumes in `command`.
- Data catalogs are the tuning surface: `units.ts` (troops/defenses/support powers),
  `tech.ts`, `modes.ts`, `maps.ts`, `scenario.ts` (bases + cover only — no starting units).
- `src/render/stage.ts` owns the composer; call `warmUp()` after staging new material
  kinds or the menu↔battle flip stalls on a shader relink. Tear down per-frame/per-swap
  groups via `disposeAndClear()`; `userData.shared` geometry is skipped.
- **`window.__rht`** is the entire test/debug surface (sim + `endTurn`/`reset`/
  `scenario(id)`/`perf()`/`diagnostics()`/`describeScene()` …). **Keep it in sync with
  the smokes** when adding sim features they need to drive.

## Electron packaging

`electron-main.cjs` serves the built `dist/` over the custom **`app://rht`** scheme
(`protocol.handle`, explicit MIME table, path-traversal guard) in a sandboxed
`BrowserWindow`. **Never regress to a random-port http server: localStorage is
origin-keyed, so a new port every launch silently wipes all saves** (real 06-24 bug).
`npm run desktop` runs against an existing `dist/`; `standalone` builds first.

## Persistence

All localStorage, keyed `rht.*`: `rht.settings.v1`, `rht.progression.v1` (purely
cosmetic), `rht.savedBattle.v1`.

## Owner's quality bars (each has bitten this repo)

- **Distinct unit silhouettes** — differentiate via model shape and motion, never
  floating labels over heads, never a mere recolor.
- **Collision audits** — units have walked through props and each other; projectiles
  must arc over hills they clear. Re-audit whenever movement/terrain changes.
- **Main menu = title + buttons** — no how-to-play walls or control legends.
- **Smokes never steal OS focus** — hidden window / `showInactive()` only.
- **Boss/elite HP bars at the top of the screen.**
- **Cause-and-effect must be visible** — e.g. a just-built barrack that can't produce
  yet must say why.
