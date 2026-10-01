# CLAUDE.md

Rogue Heroes: a turn-based 3D tactics game (simultaneous-resolve turns, per-part damage, three
factions), written entirely by AI agents. This file is the always-loaded core: what to read, how to
work, the owner's hard rules, and the invariants that break silently. Detail lives in `docs/`.

**Start of every session: read `docs/next-steps.md`** (the live roadmap: done / next / deferred).

## Where things are documented (read the one for the area you touch)

| Doc | Read before touching |
| --- | --- |
| `docs/next-steps.md` | anything: the roadmap and the owner's open asks |
| `docs/architecture.md` | the sim, renderer, terrain, projectiles FX, gait, overlays, Electron, saves |
| `docs/game-systems.md` | factions, doctrines, rosters, the three AI brains, Local 2 Players |
| `docs/testing.md` | the full command table, every smoke / probe / oracle, the ground-hatching ledger |
| `docs/art-pipeline.md` | the Blender kits (infantry, props, vehicles, bases), the validator |
| `docs/ui.md` | the toon HUD / menus, set-up flow, tooltips, the UI audit |
| `docs/blender-ai-pipeline.md`, `docs/visual-fx-learnings.md` | research digests behind the art / FX rules |
| `docs/overhaul-options.md` | the owner's open visual-overhaul pick-list |
| `README.md`, `game/README.md`, `game/improve/README.md` | setup, debug mode, perf / vision tooling |

When a lesson lands, put it in the doc for its area **in the same commit** (and a one-line pointer here
only if it is a hard rule or a silent-breakage invariant). Keep this file short.

## Layout and stack

Everything lives in **`game/`**: run every command from there. (The subdir is legacy; new games are flat.)
Vite + strict TypeScript + Three.js r170, Electron desktop shell. Runtime deps: `three`,
`postprocessing`, `n8ao`, `@fontsource/*`. `noUnusedLocals` / `noUnusedParameters` are on.
Pure seeded sim (`src/game/`, Three-free) -> read-only renderer (`src/render/`) -> DOM HUD (`src/ui/`);
composition root `src/main.ts`; the whole test/debug surface is `window.__rht`.

## How to work (the loop)

1. Read the area's doc. Reproduce or measure before changing anything; **bisect before you tune**.
2. Change the code at the root cause. A new gate is not done until it is **fault-injection proven**
   (put the bug back, watch the gate fail, restore).
3. Gate: `npm run verify` (typecheck -> script syntax -> vitest -> build; CI runs the same on every push,
   `.github/workflows/verify.yml`). Run the smokes for the
   area you touched (`docs/testing.md`); `npm run smoke:core` before a release-sized hand-off.
4. Visual changes need real-GPU evidence (`npm run shots:gpu -- <case>`); read the PNGs yourself.
5. Commit and push to `main` per verified round. Multi-line messages via `git commit -F <file>`.
   End every commit message with the attribution line the session gives you.
6. Update `docs/next-steps.md` and the area doc. Hand the owner the build (`npm run desktop` /
   `npm run standalone`, or `npm run dist:exe` for the shareable .exe) with screenshots.

Never run two test scripts at once (one GPU; parallel real-GPU runs froze the machine). Stop every
dev server / watcher before ending a turn (`taskkill /T` the tree). Smokes never steal OS focus and
always run muted. Scratch diagnostics go in `game/scripts/_*.mjs` and are deleted after use.

### Commands you will use most (full table: `docs/testing.md`)

| Task | Command |
| --- | --- |
| Gate before commit | `npm run verify` |
| One test file | `npx vitest run src/game/movement.test.ts` |
| All smokes | `npm run smoke:core` |
| Real-GPU screenshots | `npm run shots:gpu -- maps factions structures vehicles volley life heroprops` |
| Perf gate / profile / real-GPU hitch probe | `npm run perf`, `npm run perf:profile`, `npm run soak:gpu` |
| Faction / map look measures | `npm run measure:factions`, `npm run measure:maps` |
| Units inside terrain | `npm run probe:terrain [map]` |
| Rebuild a Blender kit | `npm run art:kit` / `art:props` / `art:vehicles` (+ `art:validate:selftest`) |
| Play it | `npm run standalone` (build + Electron), `npm run desktop` (existing dist) |

## The owner's hard rules (each was said once; never re-litigate)

- **SKIRMISH ONLY** (2026-09-22). No Campaign, Skirmish Run, or other mode/ladder until asked. Banned
  identifiers (grep to zero): `rht.campaign.v1`, `rht.run.v1`, `startCampaignMission`, `startRunBattle`,
  `showCampaign`, `showRunIntro`, `RUN_LENGTH`, `requisition`, `campaign-card`. Main menu: Continue /
  Play Skirmish, tutorial link, Achievements / Armory / Settings / Exit.
- **OVERWATCH IS GONE** (2026-09-23). No reaction-fire / watch order. Banned: `overwatch`,
  `queueOverwatch`, `checkOverwatch`, `overwatching`, `makeWatchCone`.
- **NO MESHY, no AI-generated models** (2026-09-20). Every model is a validated Blender kit or
  procedural; every GLB has a procedural fallback and the game runs with `public/models/` empty.
- **AP, never CP**, in anything a player reads (code keeps `commandPoints` internally).
- **FEWEST WORDS** on screen: labels, numbers, 2-5 word states; explanations go in hover tooltips or the
  tutorial; never repeat what a header or the board already shows. Menus = title + buttons.
- **Maps are minimal** (6-14 deliberate props) **with a two-tank gap everywhere** (`WALK_GAP`), nothing in
  a base's deploy ring, every prop belongs to its map's biome (`props.test.ts`).
- **Toon UI**: inked outlines, flat fills, hard offset shadows; no gradients, `backdrop-filter`, blurred
  glows or sheen animations.
- **One ballistic language**: every round is a warm physical bullet/tracer/shell; no lasers or
  team-colour tracers. No FX may fill the screen or stack additive white.
- **Quality bars**: distinct silhouettes (shape and motion, never a recolor or a floating label);
  collision audits whenever movement/terrain changes; boss/elite bars at the top of the screen;
  cause-and-effect visible (anything that cannot act says why); the factions must look AND play apart
  (`measure:factions` must stay GOAL MET).

## Invariants that break silently (read the linked doc section before changing)

- **Sim purity**: seeded `Rng` only, never `Math.random()` in `src/game/`; keep RNG draw order stable
  (seeded tests and replays depend on it). `serialize()` / `restore()` round-trip every field you add.
- **Terrain is a mutable singleton** (`setActiveTerrain`); a test that needs a map's terrain sets it after
  constructing the sim and restores `DEFAULT_TERRAIN`.
- **Pooled part materials**: never write a part mesh's `material` (it repaints every mesh that shares
  it); change `userData.baseColor`. Pooled / cached resources carry `userData.shared` so disposal skips
  them. New material programs must be warmed (`stage.warmUp()` / `warmUpSamplers`) or they hitch.
- **A map's look is one call**: `applyMapLook()` in `main.ts` pairs `world.applyMap` with
  `stage.setLightRig`; never call one alone.
- **Everything on the ground is DRAPED** on the drawn ground (`drapedDisc`, `drapeToTerrain`), and units
  stand on the ground as drawn (`visualGroundAt`). No flat ring at `terrainHeightAt`.
- **The ground-hatching ledger** (`docs/testing.md`): five different causes, each fix load-bearing
  (flat-tone outer plain, caps never cast shadows, plate height ladder, texel-sized normal bias,
  camera near = 1). Read it before touching ground, shadows or terrain.
- **Movement + projectiles** are guarded by `src/game/movement.test.ts` (AI vs AI on every map): any
  ground stops a round; misses expire at the rim; only INFANTRY climb onto cover; rams stop at contact;
  wrecks rest on clear ground; clearance checks sample a disc (`discSamples`). Keep it green.
- **Infantry gait is distance-locked** (`src/render/gait.ts`): foot skate is impossible by construction;
  never drive the gait phase off wall time.
- **Projectile FX**: trails sampled by world distance, nothing appears or vanishes at full size, no
  additive blending in a shot (`docs/architecture.md`, projectile FX).
- **Blender kits**: `npm run art:*` is the only writer of `public/models/`; the validator's part-name set
  must equal the TS union in `models.ts` (`KitPart` / `PropsPart` / `VehiclesPart`).
- **Saves**: localStorage keys `rht.*` (`docs/architecture.md`, persistence). Electron serves `dist/` over
  `app://rht`: never a random-port server (origin-keyed saves would vanish).
- **`window.__rht` is the test surface**: keep it in sync when a smoke needs a new sim feature.
