# Rogue Heroes Tactics

A turn-based 3D tactics game: plan orders for a squad of toon-style troopers, vehicles and
aircraft, then watch the turn resolve in real time. Every unit is a bag of damageable parts
(shoot the treads off a tank, the rifle out of a soldier's hands), the battlefield breaks, and
each of the six maps has its own weather or hazard.

**Skirmish is the whole game right now** — pick a map, mode, faction and difficulty, and fight.
(Campaign and Skirmish Run were cut on purpose until Skirmish is perfected; see `CLAUDE.md`.)

Stack: Vite + strict TypeScript + Three.js (no engine, no UI framework), packaged with Electron.
Everything lives in [`game/`](game/) — **run every command from there.**

---

## First-time setup (fresh clone, local or cloud)

**You need:** Git, **Node.js 22+** (developed on Node 24) and npm. Nothing else is required to
build, test and run the game in a browser.

```bash
git clone https://github.com/kjustin2/Rogue-Heroes.git
cd Rogue-Heroes/game
npm ci                               # or `npm install`; pulls three, vite, vitest, electron, ...
npm run verify                       # typecheck -> script syntax -> 430+ unit tests (~2 min) -> build
```

If `npm run verify` passes, the checkout is healthy.

### Optional extras (only for the tasks that need them)

| For | Install |
| --- | --- |
| Browser smokes (`smoke:*`, `test:full`, `shots:*`) | `npx playwright install chromium` — the harness finds it in the Playwright cache on Windows, Linux or macOS, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. On a bare Linux box add its system libraries: `npx playwright install-deps chromium`. |
| Electron on headless Linux (`standalone`, `soak:gpu`, `shots:gpu`, `smoke:electron`) | a display: `sudo apt-get install -y xvfb` then prefix the command with `xvfb-run -a`, e.g. `xvfb-run -a npm run soak:gpu`. The real-GPU tools only mean something on a machine with a GPU. |
| Rebuilding the 3D kits (`art:kit`, `art:props`, `art:vehicles`) | Blender 4.x on `PATH` (or in Program Files on Windows). The built GLBs are committed in `public/models/`, so you only need Blender to change a model. |
| The shareable `.exe` (`dist:exe`) | Windows (electron-builder portable target). |

---

## Run it

```bash
cd game
npm run dev          # dev server with hot reload -> http://127.0.0.1:5175
npm run standalone   # build + open the desktop (Electron) app — how the game is actually played
npm run dist:exe     # Windows: one-command portable exe -> game/release/
```

Debug / sandbox mode (infinite money, free cooldowns in Settings): open the dev URL with `?debug`,
or launch the desktop app with `--debug` / `RHT_DEBUG=1`.

Saves are browser `localStorage` under keys prefixed `rht.` (the Electron app serves the game on a
fixed `app://rht` origin so saves survive restarts).

---

## Develop

| Task | Command (from `game/`) |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Unit tests (pure sim, vitest) | `npm test` — one file: `npx vitest run src/game/sim.test.ts` |
| **Gate before every commit** | `npm run verify` |
| Full gate: verify + the browser smoke suite | `npm run test:full` (needs Playwright Chromium) |
| Performance budget (draw calls / triangles vs baseline) | `npm run perf` |
| Real-GPU screenshots of a scene | `npm run build && npm run shots:gpu -- firefight` |

Smokes and screenshots run headless and muted, one at a time (never run two test scripts in
parallel — they share the GPU). Screenshots land in `game/shots/` (git-ignored).

### Where things are

```
game/
  src/game/      the pure, deterministic simulation (sim.ts is the heart; seeded RNG, no three.js)
  src/render/    read-only Three.js renderer (worldRenderer.ts, stage.ts, projectileFx.ts, ...)
  src/ui/        DOM HUD (hud.ts) and the map preview
  src/main.ts    the composition root: game loop, menus, input, the window.__rht test seam
  scripts/       smokes, probes and screenshot tools (all wired into package.json)
  improve/       perf bench + baseline, scenario gallery, the shared test harness
  art/           Blender scripts that author the infantry / props / vehicles kits
  public/models/ the committed GLB kits (the game also runs with this folder empty)
docs/            next-steps.md (the roadmap — start here), research digests
CLAUDE.md        the detailed engineering guide: architecture, rules, hard-won lessons — read it
                 before changing rendering, terrain or the test harness
```

`window.__rht` is the automation seam every smoke drives (start a battle, stage a scenario, read
the sim, force events); keep it in sync when adding features the tests need.
