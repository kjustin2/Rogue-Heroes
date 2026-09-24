# CLAUDE.md

Guidance for Claude Code in this repository.

**Start of every session: read `docs/next-steps.md`** — it is the live roadmap (what is done,
what is next, what is deliberately deferred). Setup for a fresh clone is in the root `README.md`.
Other docs: `docs/blender-ai-pipeline.md` (research digest behind the Blender kit rules below) and
`docs/visual-fx-learnings.md` (particle / animation / GUI lessons with sources).

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
| **Gate before commit** | `npm run verify` (typecheck → script syntax check → test → build) |
| Full gate + smokes | `npm run test:full` |
| Perf bench + leak probe | `npm run perf` (`-- --update-baseline` to rebase) |
| AI vision inspector | `npm run vision` (`-- <scenario>` or `-- all`) |
| Scenario screenshot gallery | `npm run improve:gallery` |
| Review contact sheet → `shots/` | `npm run screens` |
| Quick gameplay-zoom look per scenario (`-- firefight siege`, `:select`/`:shoot`/`:base` HUD states) | `npm run shots:look` |
| Per-map prop census + HUD-less close frame of every map section (`-- karak verdant`; `SHOT_PREFIX=before-` for a baseline) | `npm run shots:props` |
| 12-frame attack filmstrip at half/quarter speed (`-- melee`, `kill`, `jump`, or a projectile family: `shoot heavy sniper sapper pistol flame grenade launcher mortar tank artillery apc turret gunship`, the audit stages `smoke carpet strafe throw`, `all` for every family; `FILM_SLOW=<n>` stretches the gaps on a software GPU) — judge motion here, not in stills | `npm run shots:filmstrip` |
| Depth-fight repro (hide plates / kill shadows / lift plates / old near plane) | `npm run probe:depth <scenario>` |
| Infantry lineup, near + far, for kit/proportion review | `npm run shots:lineup` |
| Rebuild the Blender kits (validated, AO-baked) | `npm run art:kit`, `npm run art:props`, `npm run art:vehicles`, `npm run art:validate:selftest` |
| A/B two screenshots (hottest region, 3× crop) / inspect a GLB | `npm run shots:diff a.png b.png out.png`, `npm run art:inspect <glb>` |
| Start one map headless and print the in-page error | `npm run probe:map <id>` |
| Boot camera steadiness on the real GPU (the title "earthquake" regression) | `npm run probe:intro` |
| Units inside the terrain (title diorama + 5 AI turns on every map, ~3 min) | `npm run probe:terrain [map]` |
| **Real-GPU frame-time probe** (hidden Electron, diffs compiled programs across resolves) | `npm run soak:gpu [scenario]` |
| **Real-GPU screenshots** (`-- menu firefight lineup rings abilities direction nowalk maps volley vehicles structures …`; `vehicles` / `structures` = the vehicles-kit review frames, both teams; `maps` = one gameplay frame per battlefield (`volley` = a seven-family firing line mid-resolve: rounds, trails, flashes, blasts on the real GPU); UI screens `deploy settings armory achievements tech tutorial pause victory defeat hover hover-deck`; `air` = the four flyers, both teams; `deaths` = every death family filmed (16 frames); `climb` = the Move preview up an Ironworks slab (▲ CLIMB tag, draped path, three consecutive frames of the selected unit); `basedeploy` = the base's deploy ring at the Ironworks rim (`PROBE=1` adds no-overlay / no-shadow bisect frames); `tech` = the research table fresh + mid-game; `mapselect` shoots the Skirmish page at 1280×720 / 1600×900 / 2560×1080; `SHOT_PREFIX=before-` for a baseline build) | `npm run shots:gpu` |
| Locomotion filmstrips (`-- walk` flat-ground stride in profile, `march` scout, `trudge` heavy, `crouch`, `step` = up a terrain step vs talus / plates) | `npm run shots:step` |
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
`5176`, buttons `5191`, deep `5206`, attacks `5212`, screenshots `5177`/`5178`, perf `5182`, vision `5183`. They
drive headless Chromium via `window.__rht`.

- `npm run smoke:flow` — menu → deploy → multi-turn battle → reset
- `npm run smoke:economy`, `npm run smoke:buttons`
- `npm run smoke:deep` — consolidated regression net for the air/transport features through the
  full sim→render→HUD path: air fleet render, air-to-air, transport load/carry/unload, straight-down
  bomb, serialize round-trip, victory screen. Wired into `test:full`.
- `npm run smoke:attacks` (in `smoke:core`; `-- <case>...` for a subset) stages EVERY attack — 21
  guns, grenade throw, mortar smoke, melee, both bomb drops, the gunship gun run, the tank ram — in a
  live battle and watches each frame: the attacker's weapon (the free arm for a throw) must leave
  rest, a round must be drawn where one flies (`__rht.fxCounts()`), the landing must be drawn, no
  frame error. Its sim-side twin is `src/render/attackCoverage.test.ts` (keyed on `TroopKind`, so a
  new troop without an attack case is a compile error). Below 20 fps (a software GPU) it runs the
  resolve clock x2; there it takes ~10 min, on a real GPU ~2.
- `npm run smoke:electron` (wrapped by `test:play`) boots the BUILT app in Electron: menu, GLB MIME,
  menu-driven battle start, a resolve round-trip. It sat "hanging" for weeks because the script
  itself had a regex syntax error — an Electron main-process error raises a MODAL DIALOG instead of
  exiting, so the run just stalls. `npm run check:scripts` (inside `verify`) now `node --check`s
  every harness script so that can never ship again.
- Gameplay smokes that test the MENU navigate it (`[data-menu="play"]` → `[data-map]` →
  `[data-start]`) and usually grant cash via `sim.economy.set("player", N)`.
- **`[data-start]` deploys are DEFERRED** (loading veil + two rAFs), and the sim sits in phase
  `command` with a full default scenario from page load — so waiting on `phase === "command"`
  after the click proves nothing, and `configure()` then splices the entity list. Anything spawned
  in that window vanishes and the next order is rejected (the intermittent "could not queue a move
  order" in `smoke:animation`). A smoke that seeds state right after deploying uses
  `deployBattle(page, {map, mode})` from the harness (calls `__rht.startBattle()` synchronously and
  pins the map), or waits on `sim.mapDef.id === <map>` as well as the phase.
- **`?lowfx=1`** forces the composer-free render path — functional smokes and perf use it
  (SwiftShader stalls on the bloom chain); `vision`/gallery run full-FX.
- **Audio is auto-muted under automation** (`navigator.webdriver`/`?mute` gate in `main.ts`, mirrored
  by Chromium `--mute-audio` and the Electron smoke's `setAudioMuted(true)`) so background runs never
  blare. `window.__rht.audioMuted()` asserts it; `smoke:flow` guards it.
- Needs the Playwright Chromium cache or `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`.

## THE GROUND-HATCHING LEDGER — read this before touching the ground, shadows, or terrain

A fine dashed/striped hatching across the ground has been reported **five separate times** in this
repo. Each report was a DIFFERENT cause that looked identical on screen, and each was chased with
guesses before anyone measured. Every fix below is load-bearing; if hatching is reported again,
work this list first and **do not start by tuning the ground texture** — three rounds were lost
that way and the cause was never once in it.

| # | Cause | Fix (do not undo) | Detector |
|---|---|---|---|
| 1 | **Outer plain tiled a detail texture across 9× the arena** — minified into aliasing hash. This was the big one and the last one found. | The distance gets a FLAT TONE. No tiled map on any ground surface materially larger than the arena. | `npm run smoke:ground` (in `smoke:core`) — asserts it directly, and is **fault-injection proven**: re-add the map and it fails all five maps. |
| 2 | **Terrain-block CAPS overhang their block by 1cm**, so neighbouring caps in a stepped mesa overlap and two coplanar surfaces fight in the shadow depth pass. | `cap.castShadow = false`. The body beneath casts the same footprint. | `npm run probe:shadow <scenario>` — bisects casting off one group at a time. |
| 3 | **Coplanar z-fight between ground plates** — overlapping slabs of one patch all topped out at exactly y=0. | Each slab staggered ~2mm in depth. | Survives `probe:shadow` (it is a main-pass depth issue, not a shadow one) — that is how #3 is told apart from #2. |
| 4 | **Shadow acne** on the near-flat arena under a low sun. | `shadow.normalBias` sized to the shadow TEXEL (~4cm at the current frustum), not a tenth of one. | `npm run probe:ground` — strips albedo, then normal map, then particles, one at a time. |
| 5 | **Ground PLATES coplanar with each other and with water** (2026-09-15). The three plate variants are separate meshes whose blobs sat at identical heights, and all of them sat 3mm above the water surface; with the camera near plane at 0.1 the depth buffer could not separate any of it at tactical distance. Read as dashed "teeth" along patch rims and as hatching over water — and it survived a full shadow-caster bisection because it was never a shadow. | Camera `near` = 1 (it never gets within 4 units of the board); plates on a 5mm ladder per blob AND per variant, lowest 2cm above grade. | `npm run smoke:ground` asserts every plate height is distinct and clear of the floor/water (fault-injection proven: make two variants share heights and all five maps fail). `npm run probe:depth <scenario>` reproduces it on demand (hides plates, kills shadows, lifts plates, restores near=0.1). |

Two rules that fall out of this and apply beyond hatching:

- **A screenshot gate you have not fault-injected is a decoration.** The first version of
  `smoke:ground` passed the exact bug it was written for: it measured a mesh's LOCAL bounding box,
  and a ground plane is a PlaneGeometry rotated flat, so its depth sits on Y and its Z extent is
  zero — every plane in the scene was skipped. It only became a gate after the bug was deliberately
  re-added and the gate was made to fail.
- **A dark shape on the ground is not necessarily a shadow.** #5 was bisected as a shadow for an hour
  because it sat exactly where the mesa's shadow should be. Turn the key light's `castShadow` off FIRST:
  if the artefact is still there, stop touching the shadow pass.
- **Bisect before you tune.** Every one of these five was found by turning things off one at a time
  (`probe:shadow`, `probe:ground`), and none was found by adjusting a number and looking.

## Blender-authored infantry parts (`npm run art:kit`)

`art/infantry/author_kit.py` builds the trooper's SHAPES in Blender and exports
`public/models/infantry-kit.glb`; `kitGeometry()` in `models.ts` loads it async and
`this.box(..., { kit: "torso" })` uses the authored mesh in place of a rounded box.

**Why parts and not a character.** The soldier has to stay a rig of separate meshes: per-part
damage targets each one, the walk cycle and attack choreography swing them from tagged pivots, and
the pooled-material system repaints them every frame. A single skinned character model takes all
three away — that is why infantry were procedural, and it is still true. So Blender authors the
shapes and the game keeps the rig.

**Body parts are authored too** (`body_torso/arm/leg/hips/head` in `author_kinds.py`): the chassis is no longer primitives. Parts export **with UVs** (smart-projected in `finish()`), and pooled part materials carry **no detail normal map** (2026-09-22: the weave normal under the four-band toon ramp speckled every band edge up close — units read blurry — and minified into a dashed hatch on large facets; glitch sweep 4b). Flat bands + ink are the look; do not bring a tiled normal back onto parts. **Subsurf sculpting was tried and reverted** — kitbashed shells under subsurf read as beads; keep bevel-only. Gear (`rifle`/`pack` parts) is un-scaled by the build's girth after the rig is built, and long weapons carry muzzle-high (`CARRY_PITCH_LONG`).

**Per-kind identity parts** live in `art/infantry/author_kinds.py` (imported by `author_kit.py`):
one helmet and one weapon per kind, plus a pack where the pack IS the unit (medic case, flamer
tanks, drone, jump thrusters). Each kit branch in `buildSoldier` swaps its main head/weapon/pack box
for `kit: "helmet-<kind>"` / `"weapon-<name>"` / `"pack-<name>"`; everything else stays procedural.
`npm run shots:lineup` renders all thirteen in a row (near + far, plus two HUD-less close frames
`lineup-close-a/b` at portrait zoom) — review THAT after any kit change, and `shots:silhouette`
for the outline test. Blender is found by `scripts/blender.mjs` (PATH or Program Files), so
`art:kit` works from a fresh shell.

**Per-kind BODIES** (2026-09-20, `art/infantry/author_bodies.py`, imported by `author_kinds.py`):
a helmet and a weapon on one shared chest read as a uniform in thirteen hats, so every kind now
wears its own `torso-<kind>` (barrel chest + shelf pauldrons / cropped jacket + scarf / ghillie
ruff / asymmetric sword guard / satchel straps / tool harness / hazmat barrel / control rig /
bandolier / bipod saddle / drum pouches / flight harness), plus `arm-<kind>` / `leg-<kind>` where
the read needs it, and two or three EXTRAS hung off an existing part id so they ride the rig
(`cape-sniper` on "body", `hose-flamer` / `antenna-droneop` / `ammobox-heavy` / `mines-sapper` /
`bipod-mortar` / `stretcher-medic` on "pack", `sheath-striker` / `drums-grenadier` /
`toolroll-engineer` / `detonator-sapper` on "legs"). `INFANTRY_KIT_PARTS` in `worldRenderer.ts`
is the ONLY place a kind picks its variants and the `size` each is scaled to (a chest with shelf
pauldrons is normalised into the same unit cube as a plain chest, so it needs a wider box to come
out the same scale); it also switches the shared procedural pauldrons / rucksack off when the
kind's own torso / back piece fills that slot. The rig contract is untouched — same part ids,
same pivots, same unit cube — so the walk cycle, `paintPart` pooling and per-part damage never
know a variant is in play. A limb-riding extra (the medic armband) is a `"body"` mesh with
`userData.limb = "arm-l"`. The jumper carries `weapon-smg` (short + FAT) so it no longer shares
the scout's thin carbine. Tri budget stayed at 2400: a bevel on a run of capped cylinders (hose,
stretcher) blows it for nothing — `finish(obj, bevel=0)` on those.

Rules:

- **Every authored part ships vertex AO as `COLOR_0`** (`bake_ao` in `finish()`: Cycles AO baked
  alone-in-the-world, folded into the same facing/height terms the runtime `bakeVertexAO` gives
  procedural parts). `box()` still runtime-bakes any geometry WITHOUT a colour attribute, because a
  pooled part material reads vertex colours and a missing attribute samples as BLACK — that was the
  bowling-ball helmet. The validator fails a part that has no colour attribute.
- Helmets are NOT `accent` meshes and take `helmetColor` (the body hue lifted toward bone): they are
  the largest surface on a trooper now and the old dark per-kit literals read as black domes.
- Every kit mesh is exported **normalised to a 1x1x1 box centred on the origin**, so `size` in
  `this.box()` still means exactly what it means for a box. **Shape comes from art; proportion stays
  in `worldRenderer.ts`.**
- Any part without an authored mesh keeps its procedural box, and a missing/failed GLB is silently
  ignored — the game runs with `public/models/` empty, as the asset policy requires.
- Materials are NOT exported (`export_materials="NONE"`): parts are repainted every frame by
  `paintPart`, so an authored material would be overwritten and would only cost load time.
- `modelsVersion()` bumps when the kit lands, which rebuilds entity groups so troopers pick the
  authored shapes up mid-session.

### Blender rules (2026-09-18, from docs/blender-ai-pipeline.md)

- **Background-first.** The pipeline is deterministic `bpy` scripts run headless through
  `scripts/blender.mjs` (`--background --python-exit-code 1`), and `npm run art:*` is the ONLY thing
  that writes `public/models/`. A live blender-mcp session is an inspection REPL (screenshot a part,
  read a bbox / face count) — never a write path to the repo; the socket is unauthenticated, so
  localhost + `BLENDER_MCP_SAFE_MODE=1` only. GLB out of a live session is not accepted.
- **The validator is the gate** (`art/infantry/validate.py`, run by `art:kit`, `art:props` AND
  `art:vehicles` before export; any failure aborts with exit 1): loose verts / wire edges / 3+-face edges /
  zero-area faces / NaN, inward-facing shells, a per-part tri budget (2400 kit, 900 props), the unit
  cube with transforms applied, UVs + `COLOR_0`, and the NAME SET == the `KitPart` / `PropsPart` /
  `VehiclesPart` union in `models.ts` (a part the game never asks for is dead weight; one it asks for and cannot
  find is a silent box). It caught 104 zero-area faces on the mortar cap and a collapsed stump on
  its first two runs. `npm run art:validate:selftest` fault-injects a rename, a flipped shell and a
  stray primitive — keep it passing when the rules change. `npm run art:inspect <glb>` prints what
  actually exported (tris, attributes, bbox, COLOR_0 range).
- **Bake location into the mesh at creation.** `join()` keeps the FIRST object's origin, and
  `floor()` / `displace()` measure mesh-local Z: a cylinder whose origin sat at its own centre had
  its whole lower half collapsed onto the "floor". Every primitive helper applies its transform
  immediately (`add_box`, `cyl`, `ico`); never leave a location on the object.
- **A cut on one of a primitive's own rings leaves zero-area slivers** — `cut_below` dissolves
  degenerates after the bisect; nudge the plane off the ring anyway.
- **Props kit** (`art/props/author_props.py` → `props-kit.glb`, `npm run art:props`): seeded
  variants per kind (`PROPS_VARIANTS` in models.ts), bmesh noise + flat floor + `shade_flat` + light
  decimate. `propGeometry(kind, hash(entity.id))` in `buildCover`; every branch keeps its
  procedural builder as the fallback. Props are pooled toon parts, so they take `tintPropToMap`
  (0.3 props / 0.5 stone toward `rockTint`) and the ramp. **Rocks are never Meshy again** — the
  photoreal hull needed a greyscale + retint to sit next to the troopers and was one silhouette on
  every map.
- **`tintPropToMap` / `partColors` must accept `MeshToonMaterial`.** Both tested for
  `MeshStandardMaterial` after the parts went toon and were silent no-ops for weeks (no prop took
  the map tint; `audit:unit` saw nothing). Any new "for every part material" walk goes through
  the same `instanceof (Standard || Toon)` check as `warmUpSamplers`.
- **Toon ramp is RGB** (`toonGradient()`): cool shade steps, warm lit steps, top channel ≤ 226.
  Grey steps read as plastic; 255 bleaches crates and pillars.
- **No `Draco` on any export** (vertex colours corrupt in the Blender exporter); meshopt via
  gltf-transform is the sanctioned compressor. GN instances must be realized before export.

## Meshy is gone; vehicles are a Blender kit (2026-09-20)

**Owner's rule: "Get rid of any of the mesh generated units and replace with blender and toon
style ones to ensure game has a consistent look and feel."** The former per-repo Meshy exception
(hard-surface hulls for tank / apc / artillery / hq / turret / crates / sandbags / barricade) is
revoked: the photoreal GLBs, the winter retextures, the `.meshy.json` sidecars, `build-models` /
`gen-model` / `retexture-models`, `setModelSkin` and the `unitSkin` setting are all deleted. There
is **no Meshy scope in this repo any more** — not for set-dressing either — and no per-model
texture path in `models.ts`. Every hull now comes from **`art/vehicles/author_vehicles.py` →
`public/models/vehicles-kit.glb`** (`npm run art:vehicles`), the third Blender kit:

- **One mesh per damage-model part.** `tank-hull` / `tank-front` / `tank-turret` / `tank-cannon` /
  `tank-track` (one mesh placed at ±x for the two treads), `apc-*` (wheeled 6x6 — wheels, not
  tracks, are the one-glance difference from the tank), `arty-*` (howitzer parked at 24°, dozer
  blade, spade), `turret-*`, `hq-*`, and single meshes for `crates` / `sandbags` / `barricade`.
  The name set is the `VehiclesPart` union in `models.ts`; the validator diffs it like the others.
  Per-part damage, cannon recoil, dead-track listing and team paint work because every part is an
  ordinary pooled part mesh — the pick-proxy layouts the Meshy hulls needed are gone.
- **Authored at game scale, in game coordinates**, and the script writes the generated
  `src/render/vehiclesLayout.ts` (each part's authored bbox). `vpart()` in `worldRenderer.ts`
  scales the unit-cube part back to that bbox, so for vehicles SHAPE AND PROPORTION live in
  Blender (a hull's parts must fit each other); the tank / APC / artillery rig is scaled once by
  `VEHICLE_KIT_SCALE` (0.78) to toy proportions. Team colour, accent lamps (headlamps, turret
  stripe, cupola beacon, HQ banner + windows) and animation stay in TS — a pooled part material is
  ONE colour, so anything emissive is a separate small `accent` box.
- **Every kit part wears an inverted-hull ink rim** (`ink` in `box()`: the same geometry drawn
  BackSide, scaled per axis so the line is `VEHICLE_INK` thick in world units). Its material is
  registered in `warmUpSamplers`; ghosted parts hide it (`paintOutline`).
- **The mortar battery shares the kit plinth + berm** (`buildTurretMountKit`) under its
  procedural tubes, so the two emplacements speak one language. Sandbags are a wall of FAT
  overlapping bags over a filler core — separate bags showed each other's ink rim through the
  gaps and read as a honeycomb.
- **Fallback is the older procedural builder**, chosen per entity by `vehiclesKitReady()` at
  build time and re-chosen when `modelsVersion()` bumps; the game runs with `public/models/`
  empty. Structures and cover check `vehicleGeometry(part)` per branch, like the props kit.
- **Gotchas that cost a round each:** `add_box` leaves the mesh in WORLD coordinates, so a
  rotation set on the object spins the box about the world origin — every orientation in this
  script is applied to vertices about the piece's own centre (`_pivot_rotate`); and a bevel wider
  than ~half a greeble's thickness collapses faces (the validator's zero-area check caught ribs,
  slats and rails at 0.05–0.06 thick — keep small pieces ≥0.1 or use `BEVEL_FINE`).
- Evidence: `npm run shots:gpu -- vehicles structures direction` (both teams, close passes),
  `shots:silhouette`. Review those after any kit change.

## Perf / vision / gallery

Documented in **`game/improve/README.md`**. Commands: `npm run perf`, `npm run vision`,
`npm run improve:gallery`. (The old screenshot-goal loop `improve:cycle` was retired 2026-09-23 —
its goals targeted a UI that no longer exists; smokes + `auditUI()` + `shots:gpu` do that job.)
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
  `window.__rht.auditUI()` finds nothing across four viewports x eight screens (title, Skirmish
  set-up, settings, pause, victory, battle, roster, targeting), then FAULT-INJECTS a strip over the
  Skirmish choices and demands the `occluded` rule name it (the gate is decorative otherwise). Every rule is a
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
  scale — object sizes and terrain heights are fixed; prop counts do NOT grow (see MAPS ARE MINIMAL). `MapDef.size`
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
- **Thrown bodies FLY on screen** (`flyThrownBody`, renderer-only): the sim moves a thrown body in one step; a living ground unit whose position jumps >0.8m in a resolve frame is flown from where it was — infantry arc and tumble backwards (full flip past 3m), vehicles hop and rock — with landing dust. Evidence `shots:gpu -- thrown`. The seam's `endTurn()` skips the unused-AP prompt (scripts drive turns).
- **Blasts THROW what they don't kill** (`applyKnockback` in `sim.ts`). Direction is away from the
  blast, distance scales with damage x falloff / `blastMass` — infantry 1, vehicles 5.5, anything
  bolted down is Infinity and does not move. The throw marches in steps and stops at the arena edge
  or a terrain step it cannot clear, but NOT at a shoreline: a body thrown into water drowns
  outright, the one place terrain kills in this game. Flyers are exempt. Tests in
  `knockback.test.ts` — mind the staging: victims are PLAYER units taking friendly-fire splash,
  because an enemy victim is moved by the enemy AI in the same turn and swamps the measurement.
  Also: the grenade order is gated on KIND (soldier/gunship/bomber — a "grenadier" fires a launcher,
  not a thrown grenade) and `debugSpawn` hands out `maxGrenades: 0`.
- **`serialize()`/`restore()`** JSON round-trip the battle; always resumes in `command`.
- Data catalogs are the tuning surface: `units.ts` (troops/defenses/support powers),
  `tech.ts`, `modes.ts`, `maps.ts`, `scenario.ts` (bases + cover only — no starting units).
- **Part materials and part geometry are POOLED.** `partMaterial()` in `worldRenderer.ts` hands
  every part mesh a SHARED `MeshToonMaterial` (same ramp as the hulls) keyed on a quantized version of its painted
  appearance, and `paintPart` re-resolves each mesh to the right one every frame. So:
  **never write to a part mesh's `material`** — you would repaint every other mesh that currently
  looks the same. Change `mesh.userData.baseColor` (or the spec paintPart builds) instead; that is
  what `tintPropToMap` does. Pooled materials and geometry carry `userData.shared`, which is how
  `disposeSubtree` knows to leave them alone. There are no per-instance GLB materials any more
  (the vehicles kit is pooled parts too).
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
- **THE OUTER PLAIN CARRIES NO TILED TEXTURE.** It is nine times the arena's extent; tiling the
  ground detail across it minifies the texture into aliasing hash, which reads as fine dashed
  hatching over half the board. That artefact was in every screenshot of this game and survived
  three rounds of texture tuning, two shadow-bias changes and a shadow-frustum rewrite, because
  none of those were where it lived. `npm run probe:ground <scenario>` is what found it: it strips
  the albedo, then the normal map, then the particle bed, one at a time — the arena went clean and
  the surround did not, which named the culprit in one run. A surface meant to recede into fog
  wants a flat tone anyway.
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
- **The ground detail layer** (`makeGroundDetail`) is one InstancedMesh per element kind (grass fans, pebbles, snow clumps, cinders, weeds), placed only on dry flat ground, bending in `windUniforms` (the same clock the cloud deck and tree sway use). Pebbles are 8-triangle octahedra on purpose — the 36-triangle version was 130k triangles on a large map. Costs are in `perf-baseline.json`; rebase after an intentional change.
- **MAPS ARE MINIMAL, AND THERE IS ALWAYS ROOM FOR TWO TANKS** (owner, 2026-09-23: "way too many items on the board so it
  blocks movement... make each unique impactful and relevant"; "ensure enough space for 2 tanks to get through any space").
  Each map is 6–14 props (was 42–78), authored as `signature` pieces in PRIORITY order — landmark, then the thing that blows,
  then the rest; `scatter` is empty everywhere. `buildMapObjects` places each at the nearest spot to its authored one where
  it and its mirror twin keep **`WALK_GAP` (7.2m = four radii of the widest ground vehicle) of open ground edge-to-edge**
  from every base, prop, landmark and capturable, and do not PINCH a lane against a cliff step or water
  (`pinchesTerrain`: a wall within `FLUSH` 1.2m is hugging it, which is fine; the arena border is not a pinch)
  — `findRoom`, a deterministic ring search out to 8m. Nothing solid sits inside a base's deploy ring
  either: `BASE_CLEAR` (the widest ring, Vanguard's, + 1m) from each base centre, capturables included. A piece with no room is LEFT OUT, never crammed in; so a
  listed kind that never places fails `props.test.ts` and must be cut from the list. Prop counts do NOT grow with
  map area any more. `props.test.ts` pins: biome kinds stay home (the `HOME` table), every listed kind places,
  ≤ 20 props, one landmark and one volatile per map, WALK_GAP between every pair, no terrain pinches.
  The fifteen biome props are box-built in `buildBiomeProp`; tall ones (girder, obelisk, tower, pillar, tree)
  topple; the brazier burns like fuel. Evidence: `npm run shots:gpu -- maps`, `npm run shots:props`.
- **Stone takes the map's hue**: rock / rubble / statue props are tinted 0.5 toward `rockTint` (the ground's own hue at a slightly higher value); wood, foliage and hardware only 0.3 toward `propTint`. A tint into an already-saturated albedo only ever darkens it — which is why the Meshy rock had to be greyscaled first, and why it is gone.
- **INFANTRY LOCOMOTION IS DISTANCE-LOCKED** (`src/render/gait.ts`, 2026-09-22). The gait phase
  advances by `metres moved / stride`, never by wall time, and a planted boot is placed from that
  phase alone — so while it is on the ground it slides back under the body at exactly the body's
  speed and its world velocity is ZERO. Foot skate is impossible by construction, not tuned away;
  `gait.ts` is pure (no three) and `gait.test.ts` proves the contract. Shape of it:
  - `footAt` gives the ankle target (stance = the stride lock, with a heel-strike → flat → toe-off
    ROLL about the heel/toe, so the contact point is pinned inside each phase; swing = an arc that
    starts where toe-off left the ankle and ends where the heel strike puts it).
  - `hipBob` is an AUTHORED four-key curve per half cycle (contact / mid-stance / toe-off / the peak
    between steps) and the KNEE is whatever `solveLeg` (two-bone IK, law of cosines) needs to reach
    the ground under it. The test asserts the curve never rises above `hipCeiling` — a hip authored
    too high hovers the foot, which is the skate bug wearing a different hat.
  - The authored one-piece leg mesh is **split at the knee at load** (`legSplit.ts`, Sutherland-
    Hodgman clip + capped cut, cached per source geometry, `userData.shared`): thigh / shin / boot
    are three part meshes tagged `userData.segment`, all still part id `legs`, so per-part damage,
    pooled paint and the kit contract are untouched. `getComponent` (not the raw array) reads the
    cut vertices — glTF `COLOR_0` is normalised Uint8 and copying raw integers painted the legs as
    a white-hot ball.
  - **Speed tiers** (`GAIT_TIERS`, picked by `gaitTier(kind)`): walk (line troops), march
    (scout/striker: longer stride, more lean, pumping arms), trudge (heavy/mortar/flamer: short
    stride, long contact, wide stance, roll). `CROUCH_GAIT` is the one walk-length gait — the sim
    stands a crouched unit up when it moves, so the renderer keeps it low off `order.startedCrouched`.
  - The free arm counter-swings the opposite thigh; the weapon arm keeps its carry; the torso leans
    and counter-rotates against the pelvis twist; the head counters half the bob and stays level.
  - **Evidence**: `npm run shots:step -- walk | march | trudge | crouch | step` (side profile, HUD
    hidden, one stride per strip) and the skate metric in `smoke:animation` — FAULT-INJECTION
    PROVEN: locked = p90 0.07 cm/frame and 0.02 m slide per metre travelled, phase driven off wall
    time instead = 2.00 cm/frame and 1.33 m/m. Thresholds (1 cm, 0.15) sit between those two
    measured states. The gate reads the renderer's own per-frame boot track (`__rht.trackFeet` /
    `footTrack`) because a headless sample step is a third of a stride — by the next sample the
    planted foot is a different one.
- **Idle liveness is gated** (`smoke:animation`: head scan + body turn over 6s of standing — the
  scan's cycle is ~10s, so a 3s window legitimately measured 0.13 of a 0.42-rad sweep and failed).
  Whole-body idle lives at group level next to the flinch; per-part breathing in `paintPart`. Both
  are phased by `hash(entity.id)`.
- **Attack choreography follows the ORDER** (`attackFamilyForOrder` — the ONE place that says which
  orders animate their actor and how; `computeAttackPhases` and `attackCoverage.test.ts` both read
  it): shoot/smoke = the unit's weapon family, melee = `melee`, an infantry hand grenade = `throw`
  (a procedural overhand windmill of the FREE arm, `throwArmAngle`, released at the sim's 0.58s),
  an aircraft bomb = nothing (a bay, not a gun). A bomber's CARPET lands on the tick it is
  released (sim unchanged — its timing is balance-tested); the renderer draws the fall before
  release off the order's clock (`makeCarpetFall` onto `carpetDropPoints`, ending on `ATTACK_FIRE_AT`). **Arms are meshes of the `"body"` part (role core)**,
  so in the pose code any `limb === "arm-*"` test placed AFTER the `part.role === "core"` branch
  never runs — the throw branch sits before it for that reason (see next-steps for the Blender
  banks' arm channels, which are still behind it).
- **Melee**: the pose family follows the ORDER (`meleeTargetByActor`), the blade is carried by the shoulder about a grip pivot (it is a separate part with no authored motion), the group lunges, and the sim emits a `strike` effect (slash arc + flash + shards), never a blast. `__rht.setResolveScale(0.25)` slows the resolve clock for filmstrips.
- **Jump Trooper** (`jumper`, `UNIT_STATS.jump`): its move is an arc (`canJump` → `jumpLanding` picks a dry, unoccupied landing; the order sets `flying`/`agl` on a sine until it lands). Mid-arc it IS a flyer to targeting. Pack destroyed = walks. Tests find a real cliff by measurement (`jumper.test.ts`).
- **Gas** (`CoverKind "gas"`): rupture pushes a `gasClouds` entry (grows per turn, chokes infantry at turn start); **every `sim.effect("blast")` calls `igniteGasAt`** — that is the one place that knows about gas, and a cloud's detonation is a blast, so canisters chain. Rides `serialize()`.
- **Slams** (`resolveSlam`): a knockback throw that stops early (cliff / solid prop / another body) lands its unspent share as damage; unit-into-unit is shared and shoves the hit unit a step.
- **Piercing** (`UNIT_STATS.pierce`, marksman): the round goes through bodies (cover still stops it), `-pierce` damage per body, carries `PIERCE_CARRY` metres past the first hit and the order completes there.
- **Smoke** (`smokeClouds`, mortar-only `queueSmokeAt`, OrderKind/Intent `"smoke"`): a 3-turn cloud
  (radius 3) that swallows any FLAT round (`arcHeight <= 0.5`) whose line passes within its radius —
  in `previewAttack` (`blockedBySmoke`, `queueShootFor` rejects, `aiShotBlocker` holds fire) and
  in flight (`smokeEntryProgress` in `updateProjectile`). Mortar/artillery/grenade arcs sail over.
- **Stabilise** (`downed` on the entity): the ONE place a kill becomes a body is `afterDamage` →
  `stabilise()` — infantry, friendly medic within 6, critical parts pinned to 1 HP,
  `recomputeStatus` zeroes move/shoot while `downed`. Downed bodies are skipped by every hit /
  splash / tick loop and by the AI target list; `runDownedTick` (first thing in `finishResolve`)
  revives at 30% core or kills through the ordinary death path. Direct `applyDamage` calls that
  bypass `afterDamage` (burn/gas ticks) still kill outright.
- **Mark** (`markedUntilTurn`/`markedById`): stamped in `spawnShotProjectile` when a sniper fires
  (hit or miss); `isMarkedFor(actor, target)` gives every OTHER friendly `MARK_SPREAD_SCALE` and
  `MARK_ACCURATE_BONUS` in `accuracyForShot`; cleared in `finishResolve` the turn after.
- **Lightning** (`MapEventKind "lightning"`): one strike per turn at `lightningZone(turn)` — a pure function of map seed + turn, so command telegraph == resolve strike == restored save; never within 7 of a base.
- **Title diorama** (`stageMenuDiorama` in `main.ts`): the main menu sits over a live Verdant scene with `stage.menuDrift`; `body.in-battle` mirrors `inBattle` so CSS hides the HUD outside a battle; `stage.resetView()` restores the tactical camera only when leaving the diorama.
- **`stage.warmUp()` extras must be visible AND unculled** (parked at y=-5000 in a wrapper): `renderer.compile()` walks `traverseVisible`, and only a composer DRAW compiles the post-chain variant (linear output, tone mapping off) — the lean path's key differs. It was a silent no-op for every GLB until `soak:gpu` diffed programs across a resolve. The warm-up also clones a transparent twin of every opaque standard material (death fades flip the `opaque` program bit). Any mid-resolve hitch report: run `soak:gpu` first; it names the compiling program.
- **Abilities on entities** (all serialized): `suppressedUntilTurn` (heavy hits; one CP + crouch next turn, applied at turn start), `hullDown` (tank with no move/ram order this resolve, decided in `endTurn`, 0.7x shot damage), slam landing in the jump-landing block.
- **Deaths are per family** (`poseDeath`, renderer-only, seeded by entity id; `deathMs()` per family): infantry killed by a big blow (flinch mag >= 0.6) are THROWN (arc + flip + bounce + dust), otherwise CRUMPLE or SPIN; ground vehicles WRECK (hop, roll, turret thrown clear by `blowOffTurret`, charred + smoking, then sink); aircraft SPIRAL nose-down and explode on impact. Group-level transforms (plus the turret throw after `paintPart`), so pooled paint / per-part damage never know. Evidence: `shots:gpu deaths` (`DEATH_VIEW='{...}'` to reframe; `__rht.debugKill(id, blow)` is the capture seam).
- **Every procedural machine wears the ink rim** (`defaultInk` in `box()`/`cylinder()`): aircraft, flak and the fallback hulls. The flyers were the one rimless family and read as blurry. Accent lamps stay rimless; infantry and scenery keep their own rules. Pale steel/glass (>~180 luminance) on machines blooms into smears — keep barrels gunmetal.
- **EVERY ground overlay is DRAPED** on the drawn ground (`drawnGroundAt`). Static rings/discs — pickups, mines, map-event telegraphs, burn/gas/smoke skirts, downed markers, objective rings — come from `drapedDisc()` (cached per map, `userData.shared`, cleared in `applyMap`); the aim splash disc is draped per build. Never add a flat `RingGeometry`/`CircleGeometry` at `terrainHeightAt` again (glitch sweep #5: a pickup ring buried in a plate read as a tan comma). Cover props stand on the drawn ground too.
- **Drape is CONSERVATIVE and CLAMPED** (2026-09-23, the "teeth" beside the Ironworks base): `drapeToTerrain`
  clamps every vertex to `ARENA_BOUNDS`, and a filled `PlaneGeometry` overlay lifts each vertex to the highest
  drawn ground within half a grid cell — a triangle spanning a talus lip otherwise cuts UNDER the slope and is
  hidden in a stripe per cell (sawtooth). Bisected with `PROBE=1 npm run shots:gpu -- basedeploy` (the teeth
  vanished with the overlay hidden and survived shadows off). Move orders and the live Move preview are draped
  too (`addDrapedMovePath`): a straight tube between endpoint heights sliced through slabs.
- **Selection is a ring, never a light.** The old selection point light (+ a translucent cyan cone round the
  body) blew the selected unit into a glowing white blob and changed the scene's light count on every
  select/deselect. The body gets a small lift in `paintPart` only. Evidence: `shots:gpu -- climb`.
- **▲ CLIMB tags** mark every step UP a move path takes (`climbsAlong` in terrain.ts — sim terrain, so the
  cue matches the walk), on queued moves and on the live preview while Move is armed.
- **Ground overlays are DRAPED** (`drapeToTerrain`): the move field / weapon ring are subdivided flat
  meshes whose vertices are pulled to `terrainHeightAt` (re-draped only when selection/position/radius
  change). A flat disc at the actor's elevation sinks into the next mesa and hangs past a ledge — that
  was the "range circle breaks" report. `shots:gpu rings` is the repro.
- **Units stand on the ground as DRAWN, not as simulated.** `visualGroundAt` mirrors the talus tiers
  `makeTerrainBlocks` flares past a block's footprint (same constants — change both together); the
  rendered elevation is the footprint-sampled max of it (capped at one `TERRAIN_STEP` above the sim
  ground) plus `plateLiftAt` (ground plates record their discs). Sim elevation is untouched.
  `npm run shots:step` films a walk up a step — judge feet there.
- **Vehicle radii cover the hull half-length** (`createTank/Apc/Artillery` ↔ the kit hull's authored
  length × `VEHICLE_KIT_SCALE`, ~2.4 for the tank): a circle smaller than the hull let tanks park inside crates. Spawn clearance
  (`freeSpawnNear`) is sized to the unit; `debugSpawn` separates from what is there and a staged wall
  pushes standing units aside. `scatter.test.ts` audits every map: no prop overlap, no prop
  straddling a step (`findRoom` moves an authored piece off a step, mirror-aware).
- **Push** (2026-09-24): `queueShove` is a melee order with `shove: true` (same rush); it resolves in
  `resolveShove` → `applyKnockback(..., { ringOut: true, maxThrow: SHOVE_MAX })`: a body shoved past the arena
  edge falls off the map and dies, into water drowns; vehicles' mass keeps them near. The shove's impact has a
  long duration, which the renderer reads as a heavy flinch, so a shove kill plays the THROWN death.
- **Rotatable placement**: `placementTurn` (45° steps, `rotatePlacement`, T key / Rotate ⟳ button) turns a
  line strike about its target point and a wall's facing; reset when a new placement is armed.
- **Charge / dash / breach**: `meleeRange()` adds `MELEE_RUSH` (3.5m) for all infantry and `STRIKER_CHARGE` (6.5m) for the striker; the melee
  order closes the gap first (a real move: mines + separation apply; the swing clock
  starts in reach); a sapper round vs cover/wall is 9999.
- **Airburst** (grenadier): `airburstBehindCover` — a launcher round that strikes or proximity-fuses
  on a COVER piece lands `AIRBURST_SHARE` (0.5) of its direct damage on the intended target within
  `AIRBURST_REACH` of the burst. Cover is half protection against the launcher, never full.
- **Fear** (flamer): in `queueEnemyOrders`, enemy INFANTRY within `FLAMER_FEAR_RADIUS` (6) of a
  `burnZones` entry flee straight away from it (ahead of the retreat/press goals; a flag carrier
  still runs the flag home).
- **Recon** (drone op, OrderKind/Intent `"recon"`, whole turn): sets `revealedOrders` (serialized)
  when it resolves; next command phase `enemyIntents()` DRY-RUNS `queueEnemyOrders(dryRun)` and
  restores CP/grenades/yaw/orders/log/rng (`Rng.save/load`) so the preview equals the real command;
  `addOrder` is silent while `previewingEnemy`. Cleared in `endTurn` after the real command.
- **APC carry**: `isCarrierKind` (transport | apc) shares the airlift machinery; an APC boards only
  foot troops standing beside it (`APC_LOAD_REACH`) and drops the ramp where it stands
  (`APC_UNLOAD_REACH`, it does not drive to the point).
- **Artillery deploy** (`deployed` on the entity, serialized): `queueShootFor`/`queueShootAt` refuse
  an undeployed artillery; `endTurn` deploys one with no move/ram order (next to hull-down, both
  sides) and undeploys one that moves; a move while deployed needs the whole turn (`"deploy"` order
  = explicit whole-turn version). The AI holds an artillery once it has a target in reach.
- **Strafe** (gunship): `strafeAlongPath` from the move order — one 0.75x autocannon burst as direct
  damage at each hostile within `STRAFE_RADIUS` (4) of the aircraft as it passes, once per unit
  (`order.strafed`). The air-to-air rule is for aimed fire; the gun run is the exception.
- **Carpet** (bomber): the bomb order lays `CARPET_BOMBS` (3) bombs `CARPET_SPACING` apart along the
  yaw, each released where it falls (`launchGrenadeAtPoint(…, airDropAt)` puts the origin at the drop
  point so a bomb never flies through a flyer between the nose and the spot); a straight-down drop
  keeps the aircraft's heading. One bomb load per run.
- **Balance self-play** (`balance.test.ts`, 24 seeds, ~5 min — six seeds made the seat gate a coin flip): `sim.debugCommandAsAi()` hotseats the enemy AI
  onto the player's army (swaps entity teams, economy, mines; runs `queueEnemyOrders`; swaps back).
  6 maps x 24 seeds, same 8-kind seeded roster both seats, prints a per-kind damage-per-$ table and
  gates combat kinds to 0.5x-2.5x of the median (`UNGATED` lists the exceptions and why) and the
  player seat to 40-60% of decided games. The AI's "crippled" retreat reads `status.disarmed`, not
  `!canShoot` — strikers/bombers/transports never can shoot and used to retreat all game.
- **Projectile / muzzle / impact FX live in `src/render/projectileFx.ts`** (2026-09-18), in the toon
  language: opaque flat colour + an INVERTED-HULL ink rim (the same pooled geometry drawn again
  BackSide, slightly larger), layered hulls for a white-hot core inside a warm tracer sleeve, and NO
  additive blending anywhere in a shot (the only additive light is the pooled flash light). Fades
  shrink, never dim toward black. `projectileFamily()` maps the sim's four projectile kinds × the
  firing unit to fifteen visual families; `syncProjectiles` only feeds it a position history.
  Rules: (1) trails are sampled by WORLD DISTANCE (`pushTrailPoint`/`trailStep`), never per render
  frame — a frame-sampled history is a different length at every refresh rate and resolve speed
  (at quarter speed nine flame blobs stacked in 20cm and read as a balloon); (2) blast shapes scale
  by `effect.radius / 0.22` (the blob geometry's width) and the column climbs at most
  `min(radius, 1.3)` — a wide blast is not a tall one (grenade smoke was floating in the sky);
  (3) every shape/material comes from the module's bounded caches and is `userData.shared`; the
  opaque front/back programs are registered in `warmUpSamplers` via `projectileFxWarmUpMaterials()`;
  (4) HIT REACTION is keyed off the visual event, not the damage report: `shoveNear` flinches every
  body within a blast/impact/bolt radius, so a shell bursting beside a trooper, a burn tick or a bomb
  can never land silently (rifle/melee still flinch through the damage report as well).
  (5) **NOTHING IN A SHOT APPEARS OR DISAPPEARS AT FULL SIZE** (2026-09-21, from "every frame they
  appear to splotch out"). A trail element is placed by CONTINUOUS quantities only: `TrailPoint`
  carries `born` (ease-in over `EASE_IN`) and `seq` (a STABLE phase key), and size/colour follow
  DISTANCE BEHIND THE HEAD (`easeOut` to zero by `trailReach`). Never key a size, jitter or stage
  on the array index — the history array rolls on every push, so an index-keyed element changes
  identity between two frames and pops. Smoke puffs are born ≤0.3 scale, rise on their OWN age so
  nothing hangs at head height after the round passes, and never exceed ~0.45 of the flame head.
  A rim-less white ball is banned outright (the flash frame is the POW cut-out star). Per-family shows: comet-tipped DASH tracers, a 3-petal flat muzzle
  flash (a per-round changing fan for the MG, a 7-petal cone for the scattergun), brass casings on
  every small-arms round, a ripple-ring half-beat then a long tracer + vapour trail for the marksman, flat
  ink-rimmed cut-out stars facing the camera for every hit, ground chew where a small-arms round
  stopped, POW + debris + multi-ring + dust crown for shells, a sabot streak and a spark-fan cone
  for tank AP, and a smoke-column afterlife on the renderer's own clock (`blastAfterlife`).
  Evidence is `shots:filmstrip -- all` (SwiftShader) + `shots:gpu volley` (real GPU) + **`shots:gpu
  temporal`** — twelve CONSECUTIVE real-GPU frames at full resolve speed; read neighbours, and a
  shape absent in frame N and full-size in N+1 is a fail. (`shots:filmstrip artillery` only fires
  because the stage plants the outriggers first — an undeployed piece refuses the order.)
  (6) **ONE BALLISTIC LANGUAGE** (2026-09-22, owner: "some projectiles look like laser beams"): every round is a physical bullet, tracer or shell in WARM colours. No team-colour tracers, no energy darts, no muzzle-to-target lance tubes, no electric impact stars. The sim's `bolt` rounds (APC/turret/aircraft/flak) draw as the `mg` family; the base relay's as a `tank` shell. The only electric visual left is the lightning map event (`makeLightning`); the orbital-lance support strike is a deliberate sky strike, not a unit's weapon.
- **Frame loop is guarded** (`frame` → `frameBody` in try/catch, `__rht.frameErrors()`); one bad frame never kills rAF again.
- **`dt` is floored at 0.** rAF's timestamp is the frame's START and can predate the boot-time `last`, so the first frame's delta was negative — and `trauma - dt*1.7` turned it into a full-strength camera shake on the title screen (the "earthquake before the slow pan"). `npm run probe:intro` (real GPU) measures camera jitter from boot: 1.48 before, 0.03 after; it fails above 0.2.
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

All localStorage, keyed `rht.*`: `rht.settings.v1` (incl. `keybinds`,
`highContrastTeams`, `debugInfiniteMoney`/`debugFreeCooldown`), `rht.progression.v1` (purely cosmetic),
`rht.savedBattle.v1`, `rht.commander.v1` (battle stats, medals + the distinct map/mode/faction wins the
Achievements page counts, doctrine mastery — cosmetic).

## SKIRMISH ONLY (owner's rule, 2026-09-22)

**"Just skirmish mode for now — we want it actually perfected before anything else."** Campaign and
Skirmish Run were deleted (`campaign.ts`, `run.ts`, their screens, tests, CSS, `startCampaign` /
`startRun` on the seam, the `campaign` / `run` / `briefing` shot cases). Do NOT reintroduce either,
or add another mode/ladder, until the owner asks. Banned identifiers (grep to zero): `rht.campaign.v1`,
`rht.run.v1`, `startCampaignMission`, `startRunBattle`, `showCampaign`, `showRunIntro`, `RUN_LENGTH`,
`requisition`, `campaign-card`. The main menu is Continue / Play Skirmish, the tutorial link, and
Achievements · Armory · Settings · Exit. Elites/bosses (`debugSpawn` options + the top-of-screen boss
bar) survive only for a future Skirmish set piece. The mission-intro rail now plays at the start of
every Skirmish battle.

## OVERWATCH IS GONE (owner's rule, 2026-09-23)

**"Doesn't seem like we need overwatch ability, doesn't seem to do much."** The order, its HUD
button / keybind (`O`), the watch-cone overlays, reaction fire (`checkOverwatch`), the AI's
cone avoidance, its serialize fields and the scout's DASH perk (which only existed to dodge it)
are deleted. Do not reintroduce a reaction-fire / watch order. Banned identifiers (grep to zero):
`overwatch`, `queueOverwatch`, `checkOverwatch`, `overwatching`, `makeWatchCone`. The flank rule
kept its ±60° wedge as `FRONT_ARC_HALF`.

## FACTIONS play, look and fight differently (2026-09-22)

- **Look**: `FACTION_CAMO` (worldRenderer) blends each faction's camo into every hull (0.5), base
  and uniform (0.42 since 2026-09-23) under the team read — Vanguard slate blue-grey, Syndicate tan/rust, Bastion
  olive concrete — and `factionInfantryDress` / `factionVehicleDress` / `factionBaseDress` add
  silhouette geometry on existing part ids (Vanguard radio whip + helipad + radar dish + stowage;
  Syndicate scarf/bandolier + slat cages, jerrycans, spare wheel + tarp tents and a pennant mast;
  Bastion chest/shoulder plates + track skirts and armour bricks + bunker walls and a roof dome).
  Groups rebuild when `team:faction` changes. Evidence: `npm run shots:gpu -- factions`.
- **THE FACTION READ IS MEASURED** (2026-09-24, owner: "infantry all look the same across factions and bases
  don't look different enough"): `npm run measure:factions` stages the HQ + rifleman / heavy / marksman / medic
  alone per faction on the real GPU (`shots:gpu factionmeasure`), then scores every faction PAIR: silhouette IoU
  (infantry <= 0.80, HQ <= 0.70) and saturation-weighted hue distance (>= 40 degrees). Baseline 0/15 pairs -> 15/15.
  `MEASURE_GATE=1` fails the run below the goal. What got it there, all in `worldRenderer.ts`:
  `factionInfantryDress` is a SILHOUETTE kit per faction on existing part ids (Vanguard crest fin + lit visor
  band + jet pack with swept fins + shoulder sensor pod + whip antenna; Syndicate pointed hood + face scarf +
  ankle-length duster; Bastion bucket helm + huge pauldrons + tassets + tower shield), `factionBaseDress` is
  architecture (Vanguard control tower + radar + helipad; Syndicate scrap palisade + crane; Bastion hex ring
  wall + glacis + dome + pillboxes), and `FACTION_CAMO` is three hue families (steel blue / rust / green) blended
  0.62 into troopers, 0.6 into machines -- this supersedes the older, smaller "Look" dress described below.
  Silhouette mode hides contact shadows (they were a black disc in every shape test, `shots:silhouette` too).
  The heavy's Vanguard/Syndicate pair sits AT 0.80 -- the one to watch. Same-faction mirror matches still read
  by team (ring, trim, glow): `shots:gpu -- sameside`.
- **Infantry wear the ink rim** (`INFANTRY_INK` 1.6cm) on big silhouette parts only (longest side >= 0.3m,
  thinnest >= 0.08m, never the knee-split legs). **Faction stance** (`FACTION_STANCE`: torso lean, head
  counters) and **per-part hit reactions** (`partHitByEntity`: head snaps back, thigh buckles, pack spins,
  weapon knocked aside, chest rocks -- on the hit part even if the hit destroyed it) live in `paintPart`, torso
  and head only, so the distance-locked gait is untouched (`smoke:animation` skate unchanged). Evidence:
  `shots:gpu -- hitreactprobe` prints the swing (0.53 rad after a leg strike vs 0.06 idle). The perf baseline
  was rebased for this (+35% draw calls on the stress scene; real-GPU p95 ~21ms, unchanged).
- **Identity pass (2026-09-23, owner: "still too similar in look and gameplay")**. Rosters share
  only a CORE (rifleman, heavy gunner, marksman, medic, flak; tank on two) and each faction OWNS a
  block (`signatureUnits(id)`, derived): Vanguard = scout, jumper, gunship, interceptor, transport;
  Syndicate = striker, grenadier, flamer, sapper, drone op, APC; Bastion = mortar, engineer,
  artillery, bomber (+ Mortar Turret). The heavy gunner is core because the AI leans on it: any
  faction without it lost AI-vs-AI games outright (`npm run balance:factions`). TWO support powers each, never shared: a strike + a utility — Vanguard Airstrike + Recon Sweep, Syndicate Cluster + Smoke Screen, Bastion Orbital Lance + Resupply Drop. NOTHING is callable on turn 1: every power (and the Gun / Mortar Turret) is unlocked by a doctrine in the faction's own tree (`tech` on the spec; `doctrines.test.ts` pins it). The bot only drops DAMAGING powers on a crowd (`DAMAGING_SUPPORT`). The flat
  stat passives were replaced by a `doctrine` rule, each read by one clause in sim.ts:
  **Rapid Response** (Vanguard: `troopCooldownFor`/`supportCooldownFor` a turn shorter, min 1;
  deploy ring +4m), **Scavengers** (Syndicate: `recordDamage` pays 30% of a destroyed enemy troop's
  cost; it also keeps the old +15% splash `passive`), **Dig In** (Bastion: in `endTurn` a ground
  troop with no `MOVING_ORDERS` order is `digging` for that resolve and `dugIn = 0.8` from the next
  one it holds -- same-turn dig-in won Bastion 33 of 52 AI games; tanks excepted, they have
  hull-down; `applyDamage` scales ALL damage by it and the shot preview shows it; a knockback throw
  or boarding clears both; renderer shows a sandbag arc, HUD says "Digging in" / "Dug in").
  Shared units carry faction NAMES via `labels` / `sim.troopLabel(team, kind)` (Recruit = Trooper /
  Raider / Guardsman) -- use it, not `troopSpec(kind).label`, anywhere a player sees a unit name.
  Normal/Hard bots call their strike (`enemyStrikeAct`: 3+ weight of hostiles within 3m, no own unit
  within 6.5m). Tests: `doctrines.test.ts`. Look: faction HELMET colour (`FACTION_HELMET`, 0.55
  over the kind's), infantry camo 0.42, Syndicate hood, Bastion gorget + hazard chevrons, Vanguard
  tank smoke launchers + deck chevron, Syndicate ram plough, Bastion dozer blade. Evidence:
  `npm run shots:factions` (SwiftShader-safe sheet: shared units + signature units + a vehicle).
- **The bot plays its faction**: `aiTechPath` is its signature research arc (Vanguard armour →
  air wing, Syndicate ordnance → armour for the APC, Bastion armour → siege). With two or more units out it
  SAVES for the next doctrine and for its most-wanted unlocked unit. Before this it never
  researched past the free doctrine — a Vanguard bot fielded ten Recruits — so every faction played
  the same against the AI. Measured by `npm run balance:factions` (AI-vs-AI, 6 maps × 4 seeds
  × both seats per pairing, 2026-09-23): Vanguard 32 / Syndicate 30 / Bastion 25 wins, 57 draws.
  Not a gate; rerun it if you touch a roster, a doctrine or the AI economy. Known: the bots still
  field mostly riflemen and heavy gunners, so signature units show up more in a player's army.
- **Artillery and the mortar battery LOB** (`projectileArcHeight(..., source)`): they inherited the
  tank's 0.28 arc and fired flat. `projectiles.test.ts` asserts every family's flight (flat vs lobbed,
  never stalls, passes near its target, gone after the resolve) and gunship behaviour end to end.
- Set-up page: "Your faction" and "Enemy faction" (with Random, rolled in the app, not the sim) are
  equal card rows; in Local 2 Players the second row is Player 2. Modes offered: `PLAYABLE_MODES` —
  Annihilation, Capture the Flag, Hold the Hill (Domination and Last Stand stay in the sim, unoffered).
- **Tech is cheap and says what it is** (2026-09-24): doctrines $120 / ~$170-190 / ~$240, specializations
  ~$150-180, so every game explores a path. Each research card carries a tag — cyan **NEW UNITS** (a doctrine:
  lists every unit, defense and support power it opens for this faction) or amber **UPGRADE** (a
  specialization, pick one of each pair).
- Locked troops in the Deploy tab are NAMED, grouped by the doctrine that unlocks them ("Scout ·
  Marksman / 🔒 Recon Doctrine") — never a "▮▮▮ ×2" count.

## THREE AI BRAINS (2026-09-22) — difficulty is intelligence first, stats second

`aiProfile()` in sim.ts. Before this, Normal and Hard ran the SAME brain and differed only in stats.
- **Easy**: nearest-target fire, no cover, no retreat, random purchases, and ~30% of its units
  hesitate each turn (`easyBrain` skip) — the bot a new player learns on.
- **Normal**: focus fire, cover-biased advances, crippled units retreat, reactive economy (wishlist
  ranked by cost × position so counters at the head win; saves only for research once it has 4+ units
  and is not out-built, and for a wanted unit only if affordable next turn).
- **Hard** (`tactical`): Normal plus — dodges this turn's telegraphed strikes / burn zones / gas
  (`aiDangerAt`, `aiEscapePoint`, never ends a move in one), finishes what it can kill this turn
  (measured against the CORE, not summed part HP), aims at the part that kills or disarms
  (`aiBestPart`), kites fragile ranged units, pulls defenders onto intruders near its base, throws
  grenades at clusters / dug-in targets, and runs a deterministic income-first economy.
- Stat mods on Hard were cut (HP 1.3→1.15, damage 1.28→1.12, income 1.45→1.25): the brain carries it.
- Measured by one-off self-play at EQUAL stats (`brainOverride` + `debugCommandAsAi(brain)`, 6 maps ×
  2 seeds × both seats): Hard beat Normal 19-2, Normal beat Easy 18-5, Hard beat Easy 20-3.
  `debugAiTraits` toggles single traits — that is how the old "smart economy" was caught LOSING to the
  greedy one 2-10. Rerun that comparison after any AI change; it is not a gate (≈3 min).
- RNG discipline: every roll stays exactly where it was drawn for easy/normal (short-circuit order
  preserved), so their replays and seeded tests do not shift when Hard changes.
- `aiBrains.test.ts`: Hard dodges a barrage and finishes a killable target.

## LOCAL 2 PLAYERS (hotseat, 2026-09-22)

The Skirmish set-up page's **Opponent** row (vs Bot / Local 2 Players — not a main-menu button, owner 2026-09-22) switches to a Player 2 faction row (no difficulty —
forced Normal so the enemy-side difficulty modifiers are all 1).
`sim.hotseat` (serialized) stops `endTurn` from queueing AI orders. Both players start with
`START_MONEY_PLAYER` (the bot's smaller purse is a handicap for the human, not for Player 2).
Each command phase is planned TWICE: a handoff card ("Player N — your orders"), that player plans,
End Turn ("Pass to P2") hands to the other seat, the second End Turn resolves. **Who plans first
alternates by turn parity** (P1 odd, P2 even) because the second planner watched the first on the
same screen — except after a recon pulse: `revealedTeam` records whose drone flew, that seat plans
SECOND and `enemyIntents()` returns the other human's real queued orders (no AI dry-run).
**The second planner must not see the first one's plan** (2026-09-23 audit; `smoke:hotseat`
asserts it through `__rht.overlayCounts()` and is fault-injection proven): `syncOrders` draws only
`"player"`-side orders, and
`swapSides()` drops the outgoing seat's log lines (`logSeq` / `seatLogMark`) and its armed
intent / pending deploy / build / support. What a player builds or deploys is physically on the
board and stays visible; alternation is what keeps that fair. The HUD's turn chip names the seat
("Turn 3 Player 2"), the vs-bot INTEL toast is off (the handoff card lists the other side's tech as
of the turn start instead), each seat keeps its own camera (Player 2's first view is turned half
round), and `reset()` / Play Again flip the seats back before reconfiguring and reopen on Player 1.
Log lines and battle-log sections name "Player 1" / "Player 2", never "You" / "Enemy".
Player 2 plans through the ordinary UI via `sim.swapSides()` (`flipTeams`: entities, mines,
treasury, factions, mode scores / hill holders / flag owners). The sim always RESOLVES and SAVES
unswapped (`serialize` flips back around the write), so victory = Player 1, defeat = Player 2.
No medals or points from hotseat games. Tests: `hotseat.test.ts`; `npm run smoke:hotseat` (in
`smoke:core`); `shots:gpu versus`.

## Units never stand INSIDE the terrain (2026-09-22)

Owner report: a striker's blade stuck into a step on the title screen. `npm run probe:terrain` runs
`__rht.auditTerrainClip()` (every living ground unit's part boxes sampled against `drawnGroundAt`)
on the title diorama and after five AI-vs-AI turns on every map; it found the title units, tanks
parked with hull / cannon in mesas, and zero after the fix. The rules it proved:
- **Clearance** `spawnClearance(radius)` in sim.ts: infantry 1.4m (weapon reach up to ~1.3m + talus),
  vehicles 0.95×radius + 0.3 (hull + barrel + talus). Used by deploy spots, `freeSpawnNear`, the
  move FOOTPRINT, and the settle.
- **Move footprint**: `blockedBySteepTerrain` samples the clearance ahead and to both sides, not just
  the centre line (a unit already touching a face falls back to the centre line so it can leave).
- **Settle**: every ordered move (`blockedMoveDestination`) backs off along its path until no rise
  taller than 0.3m (walkable OR cliff) is inside the clearance — a weapon must not end in a step.
- `debugSpawn(..., { clearTerrain: true })` for staged scenes (the title diorama); tests and scenarios
  keep literal positions.
- Intentionally sunk dressing (Syndicate tents) is `userData.sunk` and skipped by the audit.

## Move orders that go nowhere are REFUSED (2026-09-22)

`queueMoveToDestination` refuses (no CP spent) a move whose blocked stop is within 0.3 of the start,
leaving the block reason as the newest log line; the "move limited to Nm" line now only appears when
RANGE was the limit. It used to accept a zero-length order and charge a CP — a tank "ignored" its
order at the Ironworks ramp. `edgecases.test.ts` walks climbing and order edge cases end to end on the
real maps (mesa steps, the overpass deck, climb-on/off cover, floating/sunk units after 5 AI turns on
every map, cancel refunds, dead-before-order, shared destinations, water).

## UI language: TOON (2026-09-18)

The DOM chrome speaks the same language as the toon render: **inked outlines** (3px panels, 2px
controls — `--ink`), **flat opaque fills** (`--paper` / `--paper-hi` / `--paper-lo`), **hard offset
ink shadows** (`--drop-sm/--drop/--drop-lg`), a **one-step shade band** at a panel's foot
(`--shade`), **segmented meters** (ink ticks over every bar), cream text on slate, and ONE saturated
accent per surface — amber = the action (End Turn, active tab, toasts), cyan = the player /
confirm / "on", red = the threat, green = OK. All of it is the `TOON UI LAYER` at the end of
`style.css`: tokens on `:root` plus per-class overrides; the legacy `--line/--panel/--cyan/--amber`
tokens are remapped there so the older layers inherit it. Rules that fall out of it:

- **No gradients, no `backdrop-filter`, no blurred glows, no sheen/glint/bracket animations** on
  UI. Depth is an offset solid; state is a fill or an outline colour. The "Blizzard chrome" layer
  that did the opposite was deleted, not overridden — do not bring rivets back.
- **The action currency is AP (action points)** in everything a player reads (owner 2026-09-24: "CP can be
  confusing as an acronym for gamers"). Code keeps `commandPoints` / `maxCommandPoints` internally; never put
  "CP" or "command point" in a string, tooltip, log line or doc the player can see.
- **Menus = title + buttons.** The cosmetic callsign line was removed from the title screen; it is
  still equipped in the Armory. Difficulty is Easy / Normal / Hard (Recruit / Veteran / Elite
  collided with the veteran ranks and the Recruit unit). The vocabulary is **turn**, never round.
- **The Skirmish set-up is a STEP FLOW** (owner 2026-09-24: the one-page version "was overwhelming"):
  Battlefield → Sides → Rules, a stepper in the header (jump back any time), a summary on Rules, and a
  footer of Back / Deploy now / Next. `[data-start]` is always on screen (smokes rely on it); a smoke that
  clicks a Sides/Rules control first clicks `[data-step-jump="N"]`. Every STEP fits 1280×720
  (`smoke:ui-audit` one-screen check per step). Settings is three tabs: Display & Sound / Gameplay / Controls.
- **Every choice on a set-up page fits one 1280×720 screen in reading order, and nothing sits under
  a sticky bar.** The old one-page layout was Map + Preview left, Faction → Mode → Difficulty right, Deploy
  last; a card with a CTA footer is a header / scrolling-body / footer grid, never a sticky strip
  laid over its own content (that is how the faction pick got "hidden behind Deploy").
  `shots:gpu mapselect` is the repro at the three widths that have bitten this repo.
- **Tooltips hang OUTSIDE the panel they came from** (above a bottom panel, beside a side rail —
  `positionTooltip` in hud.ts), are ≤2 lines at 420px, and never repeat the card's own name ("Striker
  on cooldown" on the Striker card is "On cooldown"). The listeners live on `<body>` so menu
  `data-tip`s work; any pointerdown dismisses; the tooltip is `data-allow-overlap`.
- **Everything a menu turns on is DERIVED FROM THE DOM** (`syncHudInert`, run by a MutationObserver on
  every top-level screen change): `menus-open` (the dark backdrop) and `stage.setLowCost` while a menu
  screen is up, HUD `inert` while a menu or pause/edit overlay is. Never switch such state on in
  `mountScreen` and off in one close path — Settings' own Back left the backdrop over the battle
  ("everything kept its filter of brightness down", 2026-09-23). Toasts, the turn banner and the
  mission-intro rail hide under menus/overlays (CSS `:has`), the intro is cancelled by `cancelIntro()`
  on every battle start / main menu, and the deploy veil gives way to the hotseat handoff card.
  `smoke:ui-audit` walks battle → Settings/Controls → Back → Resume and asserts `__rht.menuState()`
  is clean (fault-injection proven). `AUDIT_ONLY=a,b AUDIT_VIEWPORT=1280` re-checks one screen fast.
- **Deck cards are two rows** (`.part-options > .btn.confirm`): name (wraps, NEW badge beside it), then
  price/status. One nowrap row pushed prices wholly out of the card; the audit's `clipped` rule now
  reports a WHOLLY clipped element too (it skipped them before) and is fault-injected with a pushed price.

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
