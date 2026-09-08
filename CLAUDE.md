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

**Stop dev servers before ending the turn.** The owner only tests via the standalone build
(`npm run standalone` / the `.exe`) — never hand back with `npm run dev` (or any server/watcher)
still running. Kill the process tree (`taskkill /T` on win32, as `harness.mjs close()` does) so no
orphan squats the port and serves stale code.

### Smokes (Playwright, `scripts/smoke-*.mjs`)

**Shared harness: `improve/lib/harness.mjs`.** New smokes/shots MUST import it, not re-inline the
server+Chromium boilerplate: `launchGame({port,query,viewport,init})` boots a muted headless page
and returns `{page, errors, close}`; `close()` **process-tree-kills** the Vite server (`taskkill /T`
on win32) so no orphan survives to serve stale code (the recurring Windows bug). `assertLit(page,label)`
is the black-frame guard; `endTurnAndSettle`/`waitForCommand` step the sim. The 3 wired smokes +
`smoke:deep` use it; the legacy `shot-*.mjs` still re-inline theirs (migrate on touch).

Each smoke owns a dedicated `--strictPort` (a sibling project squats 5175): flow `5179`, economy
`5176`, buttons `5191`, deep `5206`, screenshots `5177`/`5178`, perf `5182`, vision `5183`. They
drive headless Chromium via `window.__rht`.

- `npm run smoke:flow` — menu → deploy → multi-turn battle → reset
- `npm run smoke:economy`, `npm run smoke:buttons`
- `npm run smoke:deep` — consolidated regression net for the air/transport features through the
  full sim→render→HUD path: air fleet render, air-to-air, transport load/carry/unload, straight-down
  bomb, serialize round-trip, victory screen. Wired into `test:full`.
- **`smoke:electron` gameplay assertions are stale** (assumes pre-placed units that no
  longer exist); use `smoke:flow` until fixed. `test:play` wraps it, so it inherits this.
- Gameplay smokes must navigate the menu (`[data-menu="play"]` → `[data-map]` →
  `[data-start]`) and usually grant cash via `sim.economy.set("player", N)`.
- **`?lowfx=1`** forces the composer-free render path — functional smokes and perf use it
  (SwiftShader stalls on the bloom chain); `vision`/gallery run full-FX.
- **Audio is auto-muted under automation** (`navigator.webdriver`/`?mute` gate in `main.ts`, mirrored
  by Chromium `--mute-audio` and the Electron smoke's `setAudioMuted(true)`) so background runs never
  blare. `window.__rht.audioMuted()` asserts it; `smoke:flow` guards it.
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
builders** — dev/CI never depend on assets. Cosmetic skin packs are Meshy *retextures*
(~10 credits, `scripts/retexture-models.mjs`, reuses sidecar task ids) saved as
`<name>-<skin>.glb`; `setModelSkin(skin)` swaps the cache, missing skins fall back to
the standard hull.

## Perf / vision / improve loop

Machinery is documented in **`game/improve/README.md`** — read that. Commands:
`npm run perf`, `npm run vision`, `npm run improve:cycle`, `npm run improve:gallery`.
Repo gotchas:

- **FPS is advisory only** — the hard perf gate is deterministic draw-work signals
  (draw calls, triangles, objects, leak growth) vs `improve/perf-baseline.json`.
  Rebase with `npm run perf -- --update-baseline` after an intentional cost change.
- The debug overlay mounts on `<body>`, **not** `#ui` (HUD rewrites `#ui` each frame).
- **Attribute before you optimise.** `npm run perf:profile` records a V8 CPU profile of the
  stress scenario and prints the heaviest self-time functions; `npm run perf:census` counts
  what is actually in the scene (visible meshes, shadow casters, unique materials/geometries).
  The 2026-09 perf round was won by the profile, not by guessing: the frame was dominated by
  three's per-material uniform machinery, not by triangles or fill.
- **`npm run smoke:ui-audit`** (wired into `smoke:core`, so `test:full` runs it) asserts
  `window.__rht.auditUI()` finds nothing across four viewports x four screens. Every rule is a
  geometric fact — rect intersection, `scrollWidth` vs `clientWidth`, `elementFromPoint` — so a
  failure is never a matter of taste. It exists because three real UI bugs shipped in one session
  and every one was caught by a human squinting at a screenshot. Two rules carry hard-won caveats:
  boxes are CLIPPED to their scroll ancestors before any comparison (a roster card scrolled out of
  its panel otherwise "overlaps" the treasury bar two hundred pixels below), and `clipped` needs an
  absolute tolerance as well as a ratio (a 9px inline `<em>` loses 15% of its area to integer rect
  rounding alone). Deliberate stacks opt out with `data-allow-overlap`; the battle HUD under a menu
  is `inert`, which is both the correct focus behaviour and what lets the audit tell "under a menu"
  apart from "under a sibling panel".
- **`npm run probe:shadow`** turns shadow casting off one scene group at a time and screenshots
  each step. It exists because a striped-hatching artefact across the ground survived three rounds
  of texture tuning, two bias changes and a shadow-frustum rewrite before anyone measured it: the
  cause was **terrain-block CAPS**, which overhang their block by 1cm so the top edge reads, which
  makes neighbouring caps in a stepped mesa overlap, which makes two coplanar surfaces fight in the
  shadow depth pass. `cap.castShadow` is now false and must stay false — the body beneath casts the
  same footprint. Bisect first; a ground artefact is not necessarily in the ground.
- **`npm run shots:silhouette`** renders every unit as a flat black shape on white
  (`window.__rht.silhouette(true)`, which also hides everything that is not a unit). The test is
  "can you NAME each unit from its outline alone" — it is how medic/engineer/sapper were caught
  sharing one silhouette. Shoot the rank **in profile**: head-on foreshortens the long rifles, tool
  rigs and blades that distinguish kits, and the first version of the sheet failed four kits that
  were fine.
- **`npm run audit:unit <kind>`** sorts a trooper's resolved part colours by luminance. Run it
  after any palette work: the recurring failure here is a *large* surface creeping above ~180
  luminance (it was the bare HEAD at 214, brighter than the unit's own glowing ammo), which is
  what makes the roster read as pale plastic. Small emissive lamps at high luminance are fine.

## Architecture (repo-specific facts)

Standard three-layer split (pure sim → read-only renderer → DOM HUD, composition root
`src/main.ts`). What's specific here:

- **`src/game/sim.ts` (~3200 lines) is authoritative** — the most important file.
  Phases `command` → `resolve` → `victory`/`defeat`. Seeded `Rng`; no `Math.random()`
  in sim code.
- **Per-part damage** (`damageModel.ts`): entities are bags of parts; `applyDamage`
  hits a part, `recomputeStatus` derives `canMove`/`canShoot`/`alive`.
- **Terrain is a mutable singleton** (`src/game/terrain.ts`): `setActiveTerrain` swaps
  global blocks + `ARENA_BOUNDS` (+ `water`/`bridges`); `configure()`-ing a map mutates shared
  state. Tests building `TacticalSim` from raw entities rely on `DEFAULT_TERRAIN`'s fixed mesa —
  a test that needs water/bigger bounds must `setActiveTerrain(...)` AFTER constructing the sim
  (the constructor resets terrain) and restore `DEFAULT_TERRAIN` at the end.
- **Impassable terrain** is emergent, not tile-flagged: a stacked terrain step >`TERRAIN_STEP`
  (0.95) reads as a cliff/wall, and `water` rects block ground movement (via `pointInWater` in
  `blockedBySteepTerrain`) unless a `bridge` rect crosses (flyers overfly both). Water sits at
  ground height so it does NOT block flat line-of-fire. "Large hills"/"walls" reuse stacked
  `TerrainBlock`s or the `wall`/`cliff` cover kinds — no new primitive.
- **Every map is enlarged at load** by `scaleMapDef` in `maps.ts` (large ~2×, medium ~1.5×,
  small ~1.3× area; authored `RAW_MAPS` literals stay at base scale). Only positions/extents
  scale — object sizes and terrain heights are fixed; scatter counts grow with area. `MapDef.size`
  is stamped from the authored area so `mapSize()` stays correct. Arena-dependent render constants
  (shadow frustum, max zoom, fill-light range, particle count) are sized for the largest map.
- **Unit move distances carry a global `MOVE_RANGE_SCALE`** (`sim.ts`, on both `moveRange` and
  `moveSpeed`) so the bigger maps don't slog. Changing it shifts move-distance test expectations.
- **Air layer** (`flying`/`agl` on the entity; `isAirKind` lists the flyers): gunship (helicopter,
  air-to-air gun + straight-down bombs), interceptor (jet, air-to-air gun only), bomber (jet, bombs
  only, no gun), transport (helicopter, unarmed airlift). Aircraft GUNS are air-to-air ONLY
  (`isAirKind(actor) && !target.flying` rejects); BOMBS drop straight down beneath the plane
  (`isAirBomber` → `queueBombDrop`/`launchGrenadeAtPoint` re-targets to the actor's XZ). Ground units
  CAN hit flyers (that's the anti-air). The enemy `enemyTroopPreference` scrambles air when the
  player flies, which is what gives a player gunship air-to-air targets. New flyer = the full
  add-air-unit checklist (create*, `isAirKind`/`isVehicleKind`, catalog, per-kind fns, `build*`
  model + dispatch, bomb gating, `carriable`).
- **Air transport carry** (`passengerIds`/`carriedById` on entities → rides `serialize()`): `load`/
  `unload` order kinds; carried units are hidden + inert + untargetable (excluded in render/targeting/
  separation), snapped to the transport each frame, dropped on unload or when the transport dies.
- **Debug/Sandbox mode**: launch with `?debug` (dev URL) or `--debug`/`RHT_DEBUG=1` (Electron appends
  `?debug`); `DEBUG_UNLOCKED` reveals a Debug section in Settings (infinite money, free cooldowns),
  applied each command frame via `applyDebugCheats`. See `game/README.md`.
- **The AI checks line of sight before firing** (`aiShotBlocker` reuses the rng-free player shot
  preview): it breaches a destructible blocker (cover/wall) rather than wasting the shot, or holds
  fire on terrain/friendly blocks. Keep the aim rng draw ahead of the block decision (determinism).
- **`serialize()`/`restore()`** JSON round-trip the battle; always resumes in `command`.
- Data catalogs are the tuning surface: `units.ts` (troops/defenses/support powers),
  `tech.ts`, `modes.ts`, `maps.ts`, `scenario.ts` (bases + cover only — no starting units).
- **Part materials and part geometry are POOLED.** `partMaterial()` in `worldRenderer.ts` hands
  every part mesh a SHARED `MeshStandardMaterial` keyed on a quantized version of its painted
  appearance, and `paintPart` re-resolves each mesh to the right one every frame. So:
  **never write to a part mesh's `material`** — you would repaint every other mesh that currently
  looks the same. Change `mesh.userData.baseColor` (or the spec paintPart builds) instead; that is
  what `tintPropToMap` does. Pooled materials and geometry carry `userData.shared`, which is how
  `disposeSubtree` knows to leave them alone. GLB clone materials are per-instance and are still
  mutated directly by `paintModel` — that path is unaffected.
- **The ground texture is a neutral MULTIPLIER, not an albedo.** `makeGroundTexture` draws around
  white and the material's own `color` supplies the hue, so the arena floor, the mesa caps and the
  outer plain share one texture at three tints. Baking `theme.ground` into the texture *and* setting
  the material colour to `theme.ground` squares the map's own colour — that was why every map read
  muddy and flat. It is also seamless (all marks stamped through `wrapped`), which is what lets it
  tile at ~11 world units; it ships a sobel-derived normal map alongside.
- **A faction accent is a UI colour and must be deepened before it touches a hull.** Blending one
  straight in bleached units — the enemy tint defaulted to white and the enemy role blend repainted
  68% of every surface with a light salmon, so enemy armour, walls and HQs all came out pale pink.
  The team read is carried by the marker ring, the accent trim and the emissive glow; a hull only
  has to sit in the right hue family. See `setFactionTints`/`roleColor`.
- **TWO different striping artefacts have looked identical on the ground.** Both are fixed; both
  will come back if their cause is reintroduced. (1) SHADOW ACNE on the near-flat arena under a low
  sun — `shadow.normalBias` has to be several shadow texels, not a tenth of one; 0.55 is the
  measured floor and anything under ~0.5 brings the bands back. (2) COPLANAR Z-FIGHT between the
  ground plates: four overlapping slabs per patch, all topping out at exactly y=0, hatch against
  each other, so each slab is staggered ~2mm in depth. Neither is a texture problem — three rounds
  of texture tuning were spent on them before anyone measured. `npm run probe:shadow <scenario>`
  bisects the first; the second survives that probe (it is a main-pass depth issue, not a shadow
  one), which is how they can be told apart.
- **The shadow frustum FOLLOWS THE CAMERA FOCUS** (`syncShadowFrustum` in `stage.ts`), snapped to
  whole shadow texels so edges don't crawl when the camera pans. `SHADOW_RADIUS` must cover
  everything on screen: three clamps the shadow map at its edges, so anything outside the window
  gets border texels smeared across it as long parallel streaks.
- **Infantry value hierarchy lives in `paintPart`, not in the twelve kit branches.** `bodyValueAt`
  ramps value with height (dark boots -> mid torso -> lit chest/weapon band) and `accentValueAt`
  confines the saturated identity colour to ONE zone at chest height. Authoring it per kit is how
  twelve independently-tuned kits ended up flat. Same rule: a cue that paints a whole weapon (the
  "has orders left" pulse did) breaks the one-accent zone — cues go on accent meshes only.
- **The right-hand rail stacks two panels.** `.topbar.compact-top` and `.target-panel` share
  `right: 16px`; the target panel starts at `top: 268px` to clear the tallest the command stack can
  get (End Turn + Menu + four chips). If you add a chip to that stack, re-check the number.
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

All localStorage, keyed `rht.*`: `rht.settings.v1` (incl. `keybinds`, `unitSkin`,
`highContrastTeams`, `debugInfiniteMoney`/`debugFreeCooldown`), `rht.progression.v1` (purely cosmetic), `rht.savedBattle.v1`,
`rht.campaign.v1` (mission clears + roster/veterancy + requisition),
`rht.run.v1` (Skirmish Run: seed + sector index + carried roster/banked cash — the
in-battle sim itself still saves to `rht.savedBattle.v1`, so a paused sector resumes
via Continue like a campaign mission), `rht.commander.v1` (battle stats, medals,
doctrine mastery — cosmetic).

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
