# Art pipeline: the Blender kits

How every model is authored (Blender, headless, validated) and wired into the game. Research behind the rules: `blender-ai-pipeline.md`.

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
