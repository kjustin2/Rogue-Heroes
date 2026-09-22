# Glitch sweep — real GPU, measured (2026-09-21 / 22)

Scope: whole game EXCEPT `projectileFx.ts` splotching (already reported), infantry locomotion
(`worldRenderer.ts`, in a worktree) and `maps.ts` (in a worktree).

**Rasterizer for every number below:** real GPU, hidden Electron `BrowserWindow` 1600x900, full
post chain, serving the built `dist/` (same shell as `shots:gpu`). Evidence compares only within
this rasterizer — no SwiftShader number appears here.

Harness (new, reports only, changes no game code):

- `game/scripts/glitch-sweep.cjs` — consecutive-frame capture with the camera hard-pinned per
  frame; absdiff > 14 per channel; changed pixels counted per 32px cell; each hot cell classed
  SPECKLE (isolated changed pixels = z-fight / shimmer / outline flicker) vs COHERENT (a blob =
  real animation). Reports the MEDIAN neighbouring pair, not the worst, so a one-frame settle is
  never the finding.  `npx electron scripts/glitch-sweep.cjs [idle|resolve|pan|static|all]`
- `game/scripts/glitch-probe.cjs` — bisection probes: toggle ONE thing at runtime, re-measure,
  connected-component the difference.  `npx electron scripts/glitch-probe.cjs <probe> [map]`
- `game/scripts/glitch-crop.cjs` — zoom-crop helper for reading a region at pixel scale.

All artefacts under `game/shots/glitch/`.

---

## 1. BLOWOUT / POP — the ambient weather bed draws every mote as a hard white SQUARE

**Rank: 1 (worst). Visible on all six maps, at normal play zoom, in every frame, permanently.**

- Scenario: any map, command phase, `zoom 0.62` (the CLOSEST the interactive wheel clamp allows a
  player — `stage.ts` clamps the wheel to 0.62..2.6, so this is not a debug-only framing).
- Measured (bisection: `o.isPoints && o.material.type === 'PointsMaterial'` -> `visible = false`,
  re-capture, connected-component the difference):

  | map | blobs that vanished | biggest blob | square-shaped blobs >=3px | largest square |
  |---|---|---|---|---|
  | causeway | 926 | **35x35 px, fill 1.00** | 27 | **35x35 px** |
  | ironworks | 900 | 95x73 (cluster) | 10 | 13x13 |
  | verdant | 4923 | 17x32 | 12 | 15x16 |
  | dustbowl | 546 | 33x30 | 14 | 11x11 |
  | karak | 465 | 28x24 | 13 | 7x7 |
  | crossfire | 3766 | 63x71 (cluster) | 12 | 11x9 |

  `fill 1.00` means the blob fills its bounding box completely: a perfectly solid, axis-aligned,
  hard-edged square. On Frozen Causeway that is a **35x35 pixel pure-white square** lying over the
  ice at normal zoom.

- Evidence: `game/shots/glitch/particles-causeway-biggest.png` (left = bed on, right = bed off,
  6x nearest-neighbour), `particles-<map>-on.png` / `-off.png` for all six maps,
  `game/shots/glitch/read-causeway-squares.png` (4x read of the untouched frame).
- Owner: `game/src/render/worldRenderer.ts:1007`, in the ambient-bed builder —

  ```ts
  const material = new THREE.PointsMaterial({ color: spec.color, size: m.size, transparent: true, opacity: m.opacity, depthWrite: false, sizeAttenuation: true });
  ```

  A `PointsMaterial` with **no `map` and no `alphaTest`** rasterises each point as the full
  `gl_PointSize` quad — i.e. a square. With `sizeAttenuation: true` the square grows without limit
  as a mote drifts toward the camera, which is why the worst offender is 35px and the same bed
  reads as 2-3px specks in the distance. Sizes per map come from `ambientMotion()` at
  `worldRenderer.ts:4436` (snow is the largest at `size: 0.17`, hence causeway being worst).
  This is NOT the `Particles` class in `particles.ts` — that one is a `ShaderMaterial` with a
  shape-atlas mask and a round corona, and it is innocent here (it was toggled separately and the
  squares survived it).
- Proposed fix: give the bed a soft round mask like the spark system already has — either a small
  generated radial-alpha `CanvasTexture` as `material.map` (+ `alphaTest`/`depthWrite: false`), or
  reuse `getShapeAtlas()`'s mote cell, or drop the bed to a `ShaderMaterial` with the same
  `smoothstep` corona `particles.ts` uses. Additionally CLAMP the attenuated size: a mote inside
  ~3 world units of the camera should shrink out rather than fill 35px. Do not "fix" it by
  shrinking `size` globally — the distant bed is correctly subtle already; the bug is the shape
  and the unbounded near-camera growth.

---

## 2. POP / floating geometry — `interactionGlow()` hangs four unlit cream bars in mid-air on every cover prop

**Rank: 2. All six maps, normal play zoom, permanently on screen.**

- Scenario: any map, command phase, `zoom 0.8, pitch 0.6, yaw 0.2` (the sweep's gameplay framing).
- Measured (bisection: hide every `userData.decor` `BoxGeometry`, re-capture, connected-component
  the difference):

  | map | bracket bars in scene | brackets | bars ON SCREEN at once | bars floating >0.9m off the ground | frame pixels they own |
  |---|---|---|---|---|---|
  | dustbowl | 320 | 80 | 116 | 60 | 0.30% |
  | ironworks | 256 | 64 | 147 | 60 | 0.81% |
  | verdant | 288 | 72 | 124 | 96 | 1.80% |
  | causeway | 240 | 60 | 90 | 84 | 0.84% |
  | karak | 256 | 64 | 111 | 128 | 0.45% |
  | crossfire | 192 | 48 | 96 | 40 | 1.99% |

- Evidence: `game/shots/glitch/decor-<map>.png` (top = shipped, bottom = brackets hidden) for all
  six maps; read them at pixel scale in `game/shots/glitch/read-verdant-canopyhatch.png` and
  `read-verdant-whiterect.png` — four cream bars hang in the air around a tree trunk, one passing
  straight THROUGH the trunk, and four more form a skewed rectangle floating above a fallen log.
  Also on the causeway bridge decks (`read-causeway-dock.png`).
- Owner: `game/src/render/worldRenderer.ts:2820` — `WorldRenderer.interactionGlow()`. Three faults
  compound:
  1. The bracket is a flat rectangle placed at a FIXED fraction of the entity height
     (`y = Math.max(0.34, entity.height * 0.58)`). On a tree (height ~2.7) that is ~1.55m —
     mid-air, halfway up the trunk, touching nothing. 40-128 bars per map sit above 0.9m.
  2. Its extents come from `entity.radius`, not the prop's silhouette, so on a long low prop
     (log) it is a rectangle bigger than the prop, hovering over it.
  3. `MeshBasicMaterial` is UNLIT at `0xffe9c4`, so these bars are the brightest surface in the
     frame on every map whatever the palette — which is why the eye lands on them first. They
     are also `depthWrite: false`, so they never occlude cleanly.
  They are inert (nothing clickable), which trips the project bars "no inert interactive-looking
  objects" and "no floating/unsupported props".
- Proposed fix: anchor the cue to the prop instead of to a bounding number — drape it onto the
  GROUND at the prop footprint (`drapeToTerrain` already does exactly this for the move field), or
  replace the four bars with the inverted-hull ink rim the vehicles kit already uses (`ink` in
  `box()`) so the cue follows the silhouette. If it stays geometry it must be lit / palette-tinted
  and placed on a surface, never at `height * 0.58`.

---

## 3. Command-phase idle shimmer is the WIND, not a glitch — recorded so it is not re-chased

**Not a bug. Measured and cleared.**

- Command-phase idle, camera pinned, 8 consecutive frames, median neighbouring pair:

  | map | median changed | hot 32px cells | of which SPECKLY (>=0.35 isolated) |
  |---|---|---|---|
  | verdant | 1.406% | 291 | 6 |
  | crossfire | 1.366% | 221 | 5 |
  | causeway | 0.539% | 51 | 1 |
  | ironworks | 0.470% | 43 | 8 |
  | dustbowl | 0.224% | 23 | 0 |
  | karak | 0.215% | 27 | 1 |

  Speckle is near zero everywhere: the change is COHERENT blobs (motion), not the isolated-pixel
  signature of a z-fight or an outline flicker. **There is no shimmer or z-speckle in a static
  command phase on any map at gameplay zoom.**
- Layer bisection of that metric (`glitch-probe.cjs shimmerbisect`), median pair over 8 frames:

  | layer turned off | verdant | crossfire | dustbowl |
  |---|---|---|---|
  | baseline | 1.389% | 1.334% | 0.169% |
  | ambient PointsMaterial bed | 1.307% | 1.321% | 0.111% |
  | cover interactionGlow brackets | 1.403% | 1.348% | 0.160% |
  | ground-detail InstancedMesh | 0.162% | 0.391% | 0.127% |
  | key-light shadows | 1.378% | 1.228% | 0.184% |

  The wind-bent grass (`makeGroundDetail` + `windUniforms`) owns 8.6x of verdant's idle delta and
  is intended animation. Shadows are exonerated — turning the key light's `castShadow` off moves
  the number by noise, and no shadow crawl reproduced on a 12-frame slow pan either
  (`game/shots/glitch/pan-dustbowl-crop.png`). **The ground-hatching ledger's fixes are holding.**

---

## 4. BANDING — a regular dashed hatch band sits on tree-canopy facets (verdant)

**Rank: 6. Static (it does not flicker), small, but it is the ledger's hatch pattern on a PROP.**

- Scenario: verdant, a tree at `zoom 0.62, pitch 0.45` — the upper canopy facet carries a regular
  diagonal dashed band.
- Bisected in the ledger's order:
  - Key light `castShadow = false`: the band SURVIVES (`game/shots/glitch/canopy-bisect.png`,
    left = shadows on, right = off). Per the ledger rule it is NOT a shadow — stop there.
  - Camera near plane 1 -> 4 -> 12 (`canopyz-nearplane.png`): identical at all three. NOT a
    depth-precision / coplanar z-fight either.
  So it is a main-pass SHADING artefact on the canopy surface — not geometry, not the shadow map.
- Remaining suspect (untested when this was written): the per-part detail normal map
  (`partDetailNormal()` — weave / grooves / rivets) minified on a facet seen at a grazing angle,
  i.e. the same minification-aliasing family as ledger entry #1 but on a prop material instead of
  the ground. Next probe: null the `normalMap` on prop materials only and re-capture.
- Evidence: `canopy-bisect.png`, `canopyz-nearplane.png`, `read-verdant-canopyhatch.png`.

---

## Measured and NOT a bug (do not re-chase)

- **The flat grey region and the razor-straight line at max zoom-out**
  (`static-dustbowl-zoomout.png`, `read-dust-arenaedge.png`) are the deliberate outer plain and
  the arena slab's lip: `worldRenderer.ts:5497`, `plainColor = ground.lerp(fog, 0.3) * 0.34` —
  "the plain drops to a third of the arena's value ... so the play space has an edge". It is
  pixel-identical with the key light's `castShadow` off, so it is not shadow-map border smear.
- **SHADOW_RADIUS (42, `stage.ts:56`) does NOT break at max zoom-out.** Bisecting the key light at
  the true interactive max (`zoom 2.6`, reached via the wheel) produced 1168 small shadow blobs
  and ZERO regions over 20k px — no clamped-border smear, no long parallel streaks. The comment's
  own warning is currently satisfied.
- **Capture note (a bad capture is not a bug report):** `stage.debugSetView()` clamps zoom to 1.55
  while the interactive wheel clamp goes to 2.6. A "max zoom-out" frame driven by
  `__rht.setView` silently renders at 1.55 — the first run of the shadow probe did exactly that
  and reported three different zooms as identical. Every zoom-out frame here is driven by
  synthetic `WheelEvent`s instead.
- **Mid-resolve `worst`-pair spikes of 12-13%** (against a ~1.7% median) in the `resolve-*` scenes
  are the resolve camera assist (`syncCameraAssist` -> `stage.guideTo`) fighting the harness's
  per-frame camera pin. Harness, not game.
- **Cash-cache coin bob** (`worldRenderer.ts:524`) does not sink below grade: the octahedron's
  bottom measures 0.42-0.97 world units above the sim ground across maps. Where it looks cut off
  (`pickup-causeway-bob.png`) it is intersecting a raised plate curb it was placed beside, not the
  floor. Low severity.

---

## 4b. RESOLVED — the canopy hatch is the per-part DETAIL NORMAL MAP, minified

Finding 4's remaining suspect is now confirmed by bisection.

- Probe: null `material.normalMap` on every material that has one (46 materials), re-capture the
  same frame. **The hatch band on the canopy facet disappears completely.**
- Evidence: `game/shots/glitch/canopy-normalmap.png` (left = shipped, right = `normalMap` nulled).
  Compare with `canopy-bisect.png` (shadows off: band survives) and `canopyz-nearplane.png`
  (near 1/4/12: band identical) — the other two suspects are excluded by measurement.
- Owner: the detail normal map handed to every pooled part material —
  `partDetailNormal()` (weave + grooves + rivets), applied in `partMaterial()` /
  `game/src/render/worldRenderer.ts`. On a large low-poly facet seen at a grazing angle the
  normal map minifies into a regular diagonal hash — **this is ground-hatching ledger class #1
  (a minified tiled map aliasing into a dashed hatch) reappearing on PROP materials instead of on
  the ground.**
- Proposed fix: same shape as the ledger's own fix. Either give the detail normal a sane
  `repeat` per part SIZE (a tree canopy is metres across and is taking a texture scaled for a
  trooper's webbing), or turn the detail normal off for large flat-shaded prop facets (foliage /
  canopy / rock), or give the texture proper mipmaps + anisotropy so minification stops ringing.
  Do NOT chase this in the shadow pass or the depth buffer — both are measured clean here.

---

## 5. POP / clipping — flat ground overlays in the pickups/mines/zones block are NOT draped, so they bury themselves in stepped ground

**Rank: 3. Every map except dustbowl; worst on ironworks (3 of 3 pickups).**

- Scenario: crossfire, command phase, gameplay zoom — a cash-cache ring beside a terrace.
- Measured: pickups whose ring radius (0.74) crosses a real sim terrain-block edge:

  | map | pickups | rings straddling a step |
  |---|---|---|
  | ironworks | 3 | **3** |
  | verdant | 5 | 2 |
  | causeway | 8 | 2 |
  | karak | 3 | 2 |
  | crossfire | 4 | 1 |
  | dustbowl | 4 | 0 |
  | **total** | **27** | **10 (37%)** |

  That count only sees SIM terrain steps. The crossfire case in the screenshot is a render-only
  PLATE edge (`plateLiftAt`), which this metric cannot see — so the true rate is higher than 37%.
- Evidence: `game/shots/glitch/read-crossfire-ringsmear.png` — most of the ring is buried inside
  the raised terrace and only a crescent pokes out, reading as a tan comma/squiggle with the coin
  floating over it. Nothing about it says "ring".
- Owner: `game/src/render/worldRenderer.ts:505-570`, the environment-overlay block. Every overlay
  there is a flat disc placed at the SIM height with `rotation.x = -Math.PI / 2`:
  - the mine disc (`CircleGeometry(0.26, 16)`),
  - the cash-cache ring (`RingGeometry(0.5, 0.74, 32)`) and its click disc,
  - **the map-event zone rings and discs** (`RingGeometry(zone.radius - 0.4, zone.radius, 72)`) —
    i.e. the barrage / lightning / collapse TELEGRAPH.
- Why this is already-solved work: the repo fixed exactly this class for the move field and the
  weapon ring — "Ground overlays are DRAPED (`drapeToTerrain`) ... A flat disc at the actor's
  elevation sinks into the next mesa and hangs past a ledge — that was the 'range circle breaks'
  report." These four overlays never got the same treatment.
- Proposed fix: route them through `drapeToTerrain` like the move field, and use the DRAWN ground
  (`visualGroundAt` + `plateLiftAt`) rather than `terrainHeightAt`, so a plate lip buries them no
  more than a mesa does. The zone telegraph is the priority — a buried strike telegraph is a
  gameplay-legibility bug, not just a visual one.

---

## 6. FROZEN/HITCH — one toon shader program still compiles mid-resolve; the warm-up's twin-cloning is ONE-WAY

**Rank: 6. First resolve of every battle.**

- `npm run soak:gpu`, scenario `stress`.
  **GL_RENDERER: `ANGLE (NVIDIA, NVIDIA GeForce RTX 5070 Ti (0x00002C05) Direct3D11 vs_5_0 ps_5_0, D3D11)`**
- Measured: `programs 199` before the first resolve, `200` after; stable at 200 for resolves 2 and
  3, so it is a one-off first-resolve relink.

  ```
  compiled mid-resolve (55 fields): differs from nearest by #52: 1027->132099
    full: toon,TOON,,highp,srgb-linear,... ,1,132099,srgb,onBeforeCompile(){}
    programs already at non-opaque mask before resolve: 34
    nearest NON-OPAQUE existing differs by: #52: 1027->132099
  ```

  Field #52 is three's second `_programLayers` mask. `132099 - 1027 = 131072 = bit 17`, and in
  three 0.170.0 (`three.module.js`, second layer block) **bit 17 is `parameters.opaque`**. So a
  `MeshToonMaterial` that was TRANSPARENT at warm-up time is drawn OPAQUE during the resolve, and
  that opaque variant was never pre-compiled.
- Owner: `game/src/render/worldRenderer.ts:706` `warmUpSamplers()`:

  ```ts
  if (!(m instanceof THREE.MeshStandardMaterial || m instanceof THREE.MeshToonMaterial) || m.transparent) continue;
  ...
  const twin = m.clone();
  twin.transparent = true;
  ```

  The walk clones an opaque material into a TRANSPARENT twin (for death fades) but `continue`s on
  anything already transparent — so **no OPAQUE twin is ever compiled for a material that is
  transparent when the warm-up runs.** The direction that just fired is the one not covered.
- Proposed fix: make the twin-cloning symmetric — for every Standard/Toon material in the scene
  emit BOTH an `transparent: true` and a `transparent: false` sampler, rather than branching on
  the material's current state. Re-run `soak:gpu` and require `programs` to be unchanged across
  resolve 1 (that is already the gate this tool exists for).
- Perf context from the same run (advisory, not a gate): command p50 7.1ms / p95 20.8ms;
  resolve 1 p50 13.9ms / max 27.8ms / jank 0%; resolve 2 max 34.8ms / jank 1%; frame errors 0.

---

## 7. CLIPPING — cover props sit sunk and tilted into raised ground

**Rank: 4. Seen on crossfire and karak at gameplay zoom.**

- Evidence: `game/shots/glitch/read-crossfire-sunkcrate.png` (7x) — a stack of crates leaning
  ~20 degrees with its lower crates cut off flat by the hillside, i.e. buried in the drawn ground
  rather than standing on it. Its ink rim is ragged where the ground cuts it, and one
  `interactionGlow` bar (finding 2) pokes out through the crate's side.
- Likely owner (hypothesis, NOT yet bisected): props are placed on the SIM ground while the
  ground is DRAWN higher. `game/src/render/worldRenderer.ts` computes a unit's rendered elevation
  from `visualGroundAt()` + `plateLiftAt()` (lines 1429-1437) — "Units stand on the ground as
  DRAWN, not as simulated" — but the cover/prop build path does not appear to use the same
  footprint-sampled elevation. A prop standing where a render-only ground PLATE lifts the surface
  would then sink by exactly the plate lift.
- Suggested next probe (cheap): log, per cover entity, `terrainHeightAt(p)` vs
  `visualGroundAt(p) + plateLiftAt(p, ...)` and list the props with a non-zero delta; then hide
  the ground plates and re-capture the same frame — if the crate stops being cut, the plate lift
  is the owner.
- Note: `scatter.test.ts` already audits "no prop straddling a step" against SIM terrain, which is
  why this survives the existing gate — the lift that buries it is render-only.
