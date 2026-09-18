# Blender + AI agents for Rogue Heroes — research digest (2026-09-18)

Scope: what has actually worked when coding agents drive Blender for game assets, and what
in that body of practice fits THIS repo's constraints:

- Infantry stay a **rig of separate part meshes** (per-part damage, pivot choreography, pooled
  repaint) — `game/art/infantry/author_kit.py` + `author_kinds.py` author shapes only.
- Motion is a **scalar control bank** (`author_motion.py` → generated TS), not clips.
- **No Meshy for characters**; Meshy is scoped to hard-surface hulls. **No AI text-to-image.**
- **Every asset has a procedural fallback**; the game runs with `public/models/` empty.
- The toon ramp (`toonGradient()`), posterized albedo and inverted-hull outline already exist in
  `game/src/render/models.ts`; ground/props/terrain are procedural in `worldRenderer.ts`.
- Blender is already driven headless via `game/scripts/blender.mjs` (`npm run art:kit`).

The one-line verdict: **the winning pattern is exactly the one this repo already uses — agent
writes deterministic `bpy` scripts that run headless and export GLB; the live MCP session is a
prototyping/inspection aid, not the pipeline.** Everything below sharpens that.

---

## A. Agent ↔ Blender bridges

1. **blender-mcp (ahujasid) is a thin, powerful, unauthenticated Python socket.** ~29k stars; tools
   are `get_scene_info`, `execute_blender_code` (arbitrary Python), viewport screenshot, Poly Haven /
   Sketchfab / Poly Pizza fetch, Hyper3D/Hunyuan gen, `export_scene`. README warns to save first and
   break work into small steps; the socket has no auth (localhost only; `BLENDER_MCP_SAFE_MODE=1`).
   Source: https://github.com/ahujasid/blender-mcp
   *Applies:* useful as a **live REPL for inspecting a kit part** (screenshot + bbox + face count)
   while iterating on `author_kinds.py`; never as the build path. Keep `art:kit` as the only thing
   that writes `public/models/`.

2. **Real-world verdict: agents excel at hard-surface/primitive kitbash, batch utilities, and
   iterative refinement; they fail at organic sculpt, node graphs, rigging, and precise placement
   (multiple correction rounds).** Source:
   https://www.mindstudio.ai/blog/claude-blender-mcp-real-world-performance
   *Applies:* the trooper parts are exactly the "hard-surface kitbash" sweet spot. Do not point an
   agent at "sculpt a face" — keep heads/helmets as shells + bevel, as the CLAUDE.md subsurf-revert
   already says.

3. **Geometry-Nodes-via-agent is the weakest link** (API version drift, wrong socket names,
   several error loops). Sources: mindstudio (above); https://claudelog.com/claude-code-mcps/blender-mcp/
   *Applies:* prefer **bmesh + modifiers in plain Python** (what `author_kit.py` does) over agent-built
   GN trees. If GN is wanted, write it through a typed wrapper (`geometry-script`, item 7) or
   round-trip a hand-made tree with NodeToPython.

4. **Agent + Blender pays off on measurable, repetitive jobs**: decimation to a target, LOD, UV
   smart-project, non-manifold/flipped-normal scans, naming, export automation. A weapon set went
   16–24 h manual → ~2.7 h. Raw text-to-3D is "never game-ready" (10–80k tris, chaotic UVs).
   Source: https://www.strayspark.studio/blog/text-prompt-game-ready-asset-blender-mcp-ai
   *Applies:* add a **QA pass to `author_kit.py`** (non-manifold, zero-area, flipped normals, tri
   budget per part) so a regenerated kit cannot ship a bad part silently.

5. **Blender-MCP output needed hours of cleanup (merged verts, floating pieces); "3D-Agent"-style
   tools win by adding an automatic post-process (merge-by-distance, non-manifold purge, validate).**
   Source: https://dev.to/glglgl/from-blender-mcp-to-3d-agent-the-evolution-of-ai-powered-blender-modeling-1m7d
   *Applies:* a `validate(obj)` step after every `join()` in `author_kit.py` (remove doubles,
   recalc normals, assert manifold) is cheap insurance.

6. **Skill packs (arjun988/blender-skills: 94 skills incl. lowpoly-style, lod-pipeline,
   export-pipeline) exist but publish no reliability data.** Source: https://github.com/arjun988/blender-skills
   *Applies:* treat as a prompt-idea catalogue; this repo's own `CLAUDE.md` rules (1x1x1 normalised
   parts, no materials, bevel-only) are the actual skill.

7. **Scripting GN from Python is viable when typed**: `bpy.data.node_groups.new(..., "GeometryNodeTree")`
   + links, or `geometry-script` (Python decorators → node tree), or NodeToPython to freeze a
   hand-built tree into code. Sources: https://blog.cg-wire.com/blender-scripting-geometry-nodes-2/ ,
   https://github.com/carson-katri/geometry-script , https://github.com/BrendanParmer/NodeToPython
   *Applies:* if a rock/tree generator is adopted (D-items), author it once by hand, freeze with
   NodeToPython into `art/props/`, and drive seeds from the script.

## B. Headless bpy patterns for game assets

8. **`blender --background --python` with a JSON job file is the standard CI shape** (toolkit does
   batch import → rename → LOD → optimise → preview → GLB). Source:
   https://github.com/soyturkardaburak/3d-asset-automation-toolkit
   *Applies:* `scripts/blender.mjs` already does this; extend it to accept `--` args (it does for
   `art:motion:export`) so one script can build `kit`, `props`, `terrain` variants.

9. **Ten focused scripts beat one monolith** (scene clean, rename, material dedupe, mesh analysis,
   modifier order, UV check, export). Source:
   https://dev.to/vesper_finch/how-i-automated-my-blender-game-asset-pipeline-with-custom-python-addons-1a6a
   *Applies:* keep `author_kit.py` (chassis), `author_kinds.py` (identity), `author_motion.py`
   (curves) separate; add `author_props.py` rather than growing `author_kit.py`.

10. **Geometry-node instances are NOT exported by the glTF exporter unless realized** (open
    Khronos issue; "none of the exporters handle this"). Source:
    https://github.com/KhronosGroup/glTF-Blender-IO/issues/1537
    *Applies:* any GN scatter/tree must end in **Realize Instances** and `modifier_apply` before
    `export_scene.gltf`, or the GLB is empty and the silent-fallback hides it.

11. **Variant loop = set seed → apply modifier → export → undo/rebuild**, 50 variants in seconds.
    Source: https://bitsoulhosting.com/marketplace/blog/blender-geometry-nodes-game-asset-automation
    *Applies:* rocks/stumps/logs/bushes as **N seeded variants in one GLB** (`rock-0..7`), chosen by
    `hash(entity.id)` in `buildCover` so a map never shows two identical rocks side by side.

12. **Bake AO to vertex colours offline** (Vertex Oven, VertexColorBaker, Cycles "bake to vertex
    colours" via an active colour attribute) — GPU-free at runtime, no texture. Sources:
    https://github.com/ForestKatsch/VertexOven , https://github.com/Fewes/VertexColorBaker ,
    https://devtalk.blender.org/t/bake-to-vertex-colors-using-cycles/7110
    *Applies:* the game already **runtime-bakes** vertex AO (`bakeVertexAO` in `worldRenderer.ts`,
    triggered when a kit part has no `color` attribute). A Cycles AO bake in `finish()` would give
    crevice-aware AO (helmet brim, pack straps) the runtime heuristic cannot; export with
    `export_vertex_color="ACTIVE"` and the existing branch skips the runtime bake automatically.

13. **Draco + vertex colours is a known corruption case** in the Blender exporter; meshopt via
    gltfpack / gltf-transform is the safe compressor and three.js already has the decoder wired.
    Sources: https://github.com/KhronosGroup/glTF-Blender-IO/issues/1019 ,
    https://meshoptimizer.org/gltf/ , https://threejs.org/docs/pages/GLTFLoader.html
    *Applies:* `build-models.mjs` already runs `gltf-transform optimize --compress meshopt`; run the
    same post-step on `infantry-kit.glb` (currently exported raw) once vertex AO is in it. Never
    enable Draco in `export_scene.gltf`.

14. **gltf-transform CLI**: `palette` (merge materials into a palette texture), `join`, `instance`,
    `weld`, `quantize`, `simplify --ratio/--error`. Source: https://gltf-transform.dev/cli
    *Applies:* for Meshy hulls, `palette` collapses per-material draws; `weld`+`quantize` shrink the
    kit; `simplify` gives a free far-LOD for the lineup's "far" row.

15. **Flat vs smooth normals for low-poly**: mark sharp edges and let the exporter split (Edge Split
    on export), or use custom split normals for foliage. Source:
    https://docs.blender.org/manual/en/2.79/modeling/meshes/editing/normals.html ,
    https://forum.babylonjs.com/t/new-smooth-flat-shading-processing/524
    *Applies:* `finish()` already uses `shade_smooth_by_angle`. For **faceted stylized rocks** use
    `shade_flat` deliberately — flat facets are what reads "stylized rock" under a 4-step toon ramp.

16. **Custom properties export as glTF `extras` → three.js `userData`** (enable "Custom
    Properties"). Source: https://discourse.threejs.org/t/gltf-export-custom-attributes/12443
    *Applies:* stamp `grip`, `muzzle`, `pivot` empties/props on weapon parts so `worldRenderer.ts`
    reads authored pivots instead of hard-coded offsets (`CARRY_PITCH_LONG` etc.).

17. **Quality gate checklist that production pipelines actually run**: non-manifold, flipped
    normals, duplicate verts, zero-area faces, UV overlap/padding, applied transforms, scale, file
    size. Source: strayspark (item 4)
    *Applies:* codify as `art/infantry/validate.py`, run at the end of `art:kit`, fail the build.

## C. Stylized / toon pipelines of comparable games

18. **Into the Breach: clarity beats cool, every time** — unique weapons were cut because
    playtesters could not read them. Sources:
    https://www.gamedeveloper.com/design/-i-into-the-breach-i-dev-on-ui-design-sacrifice-cool-ideas-for-the-sake-of-clarity-every-time- ,
    https://gdcvault.com/play/1026333/-Into-the-Breach-Design
    *Applies:* matches the owner's "remove, never explain" rule. Any authored art must pass the
    existing `shots:silhouette` name-the-unit test before it lands.

19. **Wargroove: ~15,000 animation frames, per-faction re-animation, and an Aseprite-native
    pipeline (no export step) so artists set timing without programmers.** Source:
    https://www.gamedeveloper.com/design/an-inside-look-at-i-wargroove-s-i-wicked-design-choices
    *Applies:* the control-bank idea in `author_motion.py` is the 3D analogue (animator drags
    Graph-Editor curves, TS is generated). Keep it round-trippable — that is the feature.

20. **Advance Wars Re-Boot Camp: the "toy diorama" read comes from board-like framing and
    toy-proportioned vehicles**, not from detail. Source:
    https://www.rpgfan.com/review/advance-wars-12-re-boot-camp-review/
    *Applies:* the title diorama and tactical camera already lean this way; proportion authored in
    `worldRenderer.ts` (not in Blender) is the right lever — chunkier hull scale, bigger heads.

21. **Tiny Glade: two devs, custom engine, GPU procedural generation + advanced GI; the painterly
    look is lighting + adaptive grammar, not asset volume.** Sources:
    https://80.lv/articles/exclusive-tiny-glade-developers-discuss-bevy-proceduralism-publishers-cozy-games ,
    https://news.ycombinator.com/item?id=42191172
    *Applies:* confirms procedural-first as a real-game strategy; spend effort on light/ramp/AO
    quality over more meshes.

22. **KayKit / Quaternius / Synty: one tiny gradient-atlas texture (1024² downsampled to 128²),
    every face's UV parked on a colour strip; no per-asset textures.** Sources:
    https://kaylousberg.itch.io/kaykit-adventurers , https://quaternius.com/tutorials.html ,
    https://itch.io/blog/797457/optimization-of-3d-texturing-for-mobile-games-definition-of-the-gradient-texturing-process-and-analysis-of-its-efficiency-and-performance-in-engine
    *Applies:* the repo's pooled `partMaterial()` already does the equivalent in-memory (quantized
    appearance → shared material). For **static props** a palette atlas would let all cover props
    share ONE material (draw-call win) while keeping `tintPropToMap` via a UV-offset instead of a
    material swap.

23. **Cel toolkit in three.js**: `MeshToonMaterial` + `gradientMap` (NoColorSpace, Nearest),
    inverted hull outline dominates production over post edge-detect for cost/simplicity.
    Sources: https://threejs.org/docs/pages/MeshToonMaterial.html ,
    https://moonjump.com/game-dev-mechanics-toon-shading-cel-shading-how-it-works/ ,
    https://www.maya-ndljk.com/blog/threejs-basic-toon-shader
    *Applies:* already implemented for hulls in `models.ts`. The gap is that **infantry parts use
    `MeshStandardMaterial`** (pooled) while hulls are toon — two lighting models on one board.

24. **Gradient-mapped / ramp lighting with curvature-driven hue shifts** is how "hand-painted"
    reads are faked procedurally. Sources: https://medium.com/@EightyLevel/optimization-of-stylized-game-assets-9e989ee0ee6c ,
    https://www.sichenliu.com/gamedev/game-stylization-techniques-breakdown
    *Applies:* a **warm-lit / cool-shade ramp** (not grey steps) in `toonGradient()` is a one-texture
    change with map-wide effect; `bodyValueAt` in `paintPart` already does the value ramp.

## D. Procedural props, rocks, foliage, terrain

25. **Rock generators are a solved GN problem** (Blender Studio CC-BY example; 3DT; free
    "Ghibli-style" rock addon that bakes to a UV'd low-poly). Sources:
    https://studio.blender.org/training/geometry-nodes-from-scratch/example-rock-generator/ ,
    https://5by4.itch.io/stylized-rock-generator ,
    https://cubebrush.co/3d_tudor/products/4ihffw/3dt-stylized-rock-generator-blender-geometry-node-procedural
    *Applies:* replaces the Meshy `rock.glb` (30 credits, realistic, needs `tintModelToMap`) with a
    zero-credit seeded generator whose facets already suit the toon ramp.

26. **Tree generator pattern: curve trunk → radial-array branches → instanced leaf cards, realized
    for export.** Source: https://studio.blender.org/training/geometry-nodes-from-scratch/example-tree-generator/
    *Applies:* `buildCover` "tree" (cone-stack) could take a 3-variant authored canopy while
    keeping the procedural cone as fallback and the existing `sway` code (group-level, unchanged).

27. **Cliff Maker-style kits: sculpt → decimate → vertex-colour paint, floor stays separate, GLB out.**
    Source: https://dreammixgames.itch.io/cliff-maker
    *Applies:* terrain blocks stay procedural (the hatching ledger forbids touching caps/plates
    casually), but a **cliff-face skirt mesh** authored as a 1x1x1 tile and stretched per block face
    would add silhouette without changing collision or shadow casters.

28. **Vertex-colour workflow is the low-poly standard: colour + AO + wind weights in COLOR_0/1, no
    UVs needed, near-free on GPU.** Sources: https://bitsoulhosting.com/marketplace/blog/vertex-color-painting-blender-game-assets-workflow ,
    https://www.strayspark.studio/blog/blender-geometry-nodes-game-dev-2026 (uses 6 and 9)
    *Applies:* encode **sway weight in COLOR_1** for authored bushes/trees so `windUniforms` (ground
    detail already bends with it) can drive props in-shader instead of group rotation.

29. **Terrain is not a Blender deliverable here.** Every reference for stylized terrain export is
    a static sculpt; this game scales every map at load (`scaleMapDef`) and mutates a terrain
    singleton. The correct import is **tiles/kits into the generator**, not a baked landscape.
    Source: repo `CLAUDE.md` (Architecture) + item 27.
    *Applies:* author reusable 1x1x1 tiles (cliff face, mesa cap edge trim, shore lip) and let
    `makeTerrainBlocks` place them — same contract as kit parts.

## E. Motion: rig-as-parts vs skinned

30. **Modular characters in engines still ride ONE skeleton** (UE Leader Pose, Mixamo-humanoid
    kits) — the industry solves part-swap with skinning, not with rigid parts. Source:
    https://dev.epicgames.com/documentation/en-us/unreal-engine/working-with-modular-characters-in-unreal-engine
    *Applies:* this repo deliberately differs (per-part damage + pooled repaint). Do not import
    skinned kits; the trade is accepted in `CLAUDE.md` and this research does not overturn it.

31. **FCurve → JSON export is trivial and deterministic** (`action.fcurves`, keyframe_points,
    interpolation), with add-ons doing the same for curves. Sources:
    https://docs.blender.org/api/current/bpy.types.FCurve.html ,
    https://blog.cg-wire.com/blender-programmatic-animation/ ,
    https://extensions.blender.org/add-ons/export-curve-to-json/
    *Applies:* `author_motion.py` already does this. Extend the bank with **walk-cycle channels**
    (hip sway, foot lift, contact phase) so the anti-foot-slide rule can be authored in the Graph
    Editor and asserted by `smoke:animation`.

32. **Pose Library = one-frame Actions marked as assets; scriptable, editable after creation.**
    Source: https://docs.blender.org/manual/en/latest/animation/armatures/posing/editing/pose_library.html
    *Applies:* a **pose bank** (idle / crouch / hull-down / downed / suppressed) authored as pose
    assets on the control-bank Empties and exported alongside curves would give `paintPart` named
    static poses without new runtime machinery.

33. **Judge motion on filmstrips, not stills** — already the repo rule (`shots:filmstrip`), and
    reinforced by every animation-quality source (VLMs are ~chance on temporal). Source:
    repo `CLAUDE.md` + `/game-perception`.
    *Applies:* any motion-bank change ships with a filmstrip diff.

---

## Implement next (ranked by visual impact ÷ effort)

1. **Cycles AO → vertex colours inside `finish()`** for every kit part, exported as `COLOR_0`.
   Crevice AO on helmets/packs/boots is the cheapest "authored, not primitive" read there is.
   Touches: `game/art/infantry/author_kit.py` (`finish`, export `export_vertex_color="ACTIVE"`),
   `game/src/render/worldRenderer.ts` (`bakeVertexAO` branch already skips when `color` exists —
   verify pooled material has `vertexColors: true`). Verify: `shots:lineup`, `audit:unit`.
2. **Unify lighting model: give infantry parts the same 4-step toon ramp as hulls.** Two shading
   models on one board is the biggest "not one game" tell. Pooled `partMaterial()` swaps
   `MeshStandardMaterial` → `MeshToonMaterial` (+ keep `partDetailNormal()`), outline via the
   existing `outlineMaterial()` on the unit group. Touches: `worldRenderer.ts` (`partMaterial`,
   `paintPart`), `models.ts` (`toonGradient`, `outlineMaterial` export), `stage.warmUp()`.
   Verify: `shots:look`, `soak:gpu` (program count flat), `smoke:core`.
3. **Kit validator + QA gate** (`art/infantry/validate.py`): manifold, flipped normals, zero-area,
   tri budget per part, bbox == 1x1x1, part-name set == `KitPart` union. Fails `art:kit`.
   Touches: new `validate.py`, `author_kit.py` main, `scripts/blender.mjs` exit code.
4. **Seeded rock/stump/log/bush variant kit** (`art/props/author_props.py`, bmesh noise +
   `shade_flat` + decimate, N variants per kind in one `props-kit.glb`), picked by `hash(entity.id)`
   in `buildCover`; procedural builders stay as fallback. Replaces the realistic Meshy `rock.glb`.
   Touches: new `author_props.py`, `package.json` (`art:props`), `models.ts` (`kitGeometry`-style
   loader for props), `worldRenderer.ts` (`buildCover` rock/stump/log/bush branches).
5. **Warm/cool toon ramp** instead of grey steps in `toonGradient()` (lit = slight warm lift,
   shade = cool hue shift), one DataTexture, map-wide. Touches: `models.ts`. Verify: `shots:maps`,
   contrast pass on HUD text over the board.
6. **Post-process `infantry-kit.glb` with gltf-transform** (`weld`, `quantize`, `meshopt`) in
   `art:kit`, mirroring `build-models.mjs`. Touches: `package.json`, `scripts/blender.mjs` or a new
   `scripts/pack-kit.mjs`. Verify: load time, `smoke:deep`.
7. **Authored pivots as glTF extras**: `grip`/`muzzle`/`pivot` custom props on weapon and pack
   parts, read from `userData` to replace hand-tuned offsets. Touches: `author_kinds.py`,
   `author_kit.py` (`export_extras=True`), `worldRenderer.ts` (weapon carry, muzzle-flash origin).
8. **Walk-cycle channels in the motion bank** (hip sway, foot lift, contact phase) so foot planting
   is authored in the Graph Editor. Touches: `author_motion.py`, `src/game/infantryMotionData.ts`
   (generated), `src/render/infantryMotion.ts`, `smoke:animation` assertion.
9. **Pose bank** (idle/crouch/hull-down/downed/suppressed) as pose assets on the control Empties,
   exported next to the curves. Touches: `author_motion.py`, `infantryMotion.ts`, `paintPart`.
10. **Tree canopy variants** (3 authored canopies, cone fallback kept, existing group-level sway
    unchanged). Touches: `author_props.py`, `buildCover` "tree" branch.
11. **Sway weights in `COLOR_1`** for authored bushes/trees, bent in-shader by `windUniforms`
    (same clock as ground detail). Touches: `author_props.py`, `worldRenderer.ts`
    (`makeGroundDetail` shader chunk reused via `onBeforeCompile`).
12. **Cliff-face skirt tile** (1x1x1 authored, stretched per exposed block face, `castShadow=false`,
    never a cap) for stepped mesas. Touches: `author_props.py`, `makeTerrainBlocks`. Gate:
    `smoke:ground` + `probe:depth` must stay green — this is inside the hatching ledger's blast radius.
13. **Palette atlas for static props** via `gltf-transform palette` on the Meshy hulls + a UV-offset
    tint instead of a material swap in `tintModelToMap`. Touches: `build-models.mjs`, `models.ts`.
14. **blender-mcp as an inspection REPL only**: document the `--background`-first rule and the
    localhost/safe-mode caveat in `CLAUDE.md`; no write path to `public/models/` from a live session.
    Touches: `CLAUDE.md` (Blender section).
15. **Far LOD for the lineup/tactical zoom** via `gltf-transform simplify --ratio 0.5` on the props
    kit, swapped by camera distance. Touches: `scripts/pack-kit.mjs`, `worldRenderer.ts`
    (`buildCover` LOD pick). Lowest priority: perf is not the bottleneck today (`perf-baseline.json`).
