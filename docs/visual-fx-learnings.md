# Visual FX, animation and GUI — learnings

Working notes for this repo's presentation layer. Written down because these are the mistakes that
are expensive to rediscover, and several of them were made here already.

Sources at the bottom.

---

## 1. Particles

**Pool everything; never allocate per effect.** Bullets, sparks, smoke and debris are created and
destroyed constantly, and the standard advice is to pool rather than construct. In practice that
means one long-lived buffer with a ring cursor, not `new THREE.Mesh()` per hit.

**Know the CPU ceiling.** A JavaScript loop over per-particle state is fine below ~1000 particles,
painful above ~2000, and dead above ~5000. Above that the simulation has to move to the GPU
(compute shaders on WebGPU, or vertex-shader-driven attributes on WebGL). This game's combat
rarely needs more than a few hundred live particles, so a single `THREE.Points` over
pre-allocated typed arrays is the right tier — the point is to know where the wall is.

**One draw call per effect, via instancing.** With instanced rendering an effect costs a single
draw call no matter how many particles compose it. This matters more here than raw particle count:
see the outline incident in section 4.

**Never let a particle vanish.** Fade alpha and colour over lifetime. Particles that pop out of
existence are the single most common thing that makes an effect read as cheap.

**Local space for anything attached to a moving thing.** A muzzle flash authored in world space
detaches and floats when the shooter moves. World space is correct only when you *want* a trail
left behind — a tracer, a smoke column, a dust wake.

## 2. Blender → three.js

- **glTF/GLB is the format.** It is what the three.js docs recommend and what the repo already uses
  for its hard-surface hulls.
- **One armature per file.** Multiple armatures in one export is the most common source of broken
  animation.
- **Sample IK on export.** Inverse kinematics works, but the animation has to be baked/sampled or
  the constraint does not survive the export.
- **Shape keys become morph targets.** Bendy bones export to nothing — avoid them.
- **Budget:** 5,000–20,000 triangles per character depending on how many are on screen at once. A
  whole scene should stay in the low hundreds of thousands.
- **Optimize with `gltf-transform`** (already a devDependency here): `dedup`, then `simplify` to cut
  polygons while preserving silhouette. Enable Draco compression in the exporter's geometry section.
- **Verify in a neutral viewer** before blaming your own code — the standard glTF viewer will tell
  you in seconds whether the export or the loader is at fault.

### The pattern this repo should follow

Rogue-Hero-3 proved a variant worth copying: rather than exporting skinned character animation,
export **scalar control banks**. Each Blender curve drives one game-local number (shoulder pitch,
knee bend, body lift), sampled at 101 points per clip into a generated TypeScript file. The runtime
is a ~14-line sampler, and the game — not the clip — owns the phase.

The rule that makes it work: **combat owns durations, animation owns pose.** No second animation
clock, no root motion, no animation-owned collision. An attack pose driven off the order's own
elapsed/duration can never desync from the shot it belongs to, and the action-pace setting slows
the animation with it for free. This repo's attack choreography already follows this rule.

## 3. Animation

**Judge motion by filmstrip, never by stills.** A stopped walk cycle is invisible in a screenshot:
the unit still renders and still slides across the board. It happened here — a render-parent change
orphaned the animation state and the legs went rigid through two commits while every gate stayed
green. `shot-animation.mjs` now measures the pose instead.

**Anticipation is what separates a shot from a twitch.** Recoil alone shows the player the result
after the cause has already resolved. The measurable property is movement *before* the round leaves
the barrel — which is also the only property that distinguishes real choreography from recoil in a
test (see section 5).

**Advance gait phase by distance travelled, never by `dt`.** This is the anti-foot-skate rule and
it is one line.

**Follow-through must start where the wind-up ended.** A curve that jumps at the contact frame is a
visible pop. A decaying cosine leaves the peak continuously, crosses rest, overshoots slightly and
returns — the shape of something absorbing a shot.

## 4. Performance, specific to this codebase

**Outlines are draw calls.** They are child `LineSegments`, so every outlined mesh costs two draw
calls. Auto-applying them per part was fine when a torso was one box and cost 58% of the frame's
draw calls once the chassis gained two dozen detail plates. Outlining is opt-in here, on the five
shapes that carry a silhouette.

**`renderer.toneMappingExposure` is NOT a live lever in this pipeline.** Driving it from 1.06 to 2.6
moved measured frame luminance by 0.0001, because the composer chain determines the final image.
Brightness belongs in the post stack.

**Gate on draw work, not fps.** Headless fps is noisy; draw calls, triangles and object counts are
deterministic. `npm run perf` gates the former and reports the latter as advisory.

**Dispose textures explicitly.** `material.dispose()` never frees a texture. A procedurally baked
canvas texture per map swap leaked one texture per battle until the leak probe caught it.

## 5. Testing presentation

The recurring failure here, hit four separate times: **asserting that something moved, when
something else already moved it.**

- A camera probe passed with the director torn out, because the selection assist, then the victory
  kill-cam, then the projectile-centroid fallback each moved the camera anyway.
- A weapon probe passed with the choreography torn out, because recoil already moved the weapon.

The fix is always the same: find the property that **only** the new feature can produce, and set the
threshold *between the two measured states* rather than just above zero. Idle sway moves a weapon
~0.03 from rest; real anticipation moves it ~0.17; the gate sits at 0.07.

**Every visual gate must be fault-injection proven.** Break the feature, watch the test fail, put it
back. A gate that has never failed is a gate you cannot trust.

**Objective image gates beat eyeballing.** Mean luminance, luminance sigma, used dynamic range and
hue concentration catch washed-out, flat and monochrome frames that the eye adapts to. But
thresholds are calibrated against a look — when the art direction moves deliberately, recalibrate
with the reasoning written down, rather than fighting the gate with post-processing.

---

## Sources

- [100 Three.js Tips That Actually Improve Performance (2026)](https://www.utsubo.com/blog/threejs-best-practices-100-tips)
- [Particle systems in games with three.js and tricks to make them look good](https://tigerabrodi.blog/particle-systems-in-games-with-threejs-and-tricks-to-make-them-look-good)
- [Three-VFX — high-performance particle system for Three.js WebGPU](https://github.com/mustache-dev/Three-VFX)
- [Quarks VFX — three.js integration](https://quarks.art/runtime/tutorials/threejs)
- [blender-to-threejs-export-guide](https://github.com/funwithtriangles/blender-to-threejs-export-guide/blob/master/readme.md)
- [Making 3D web apps with Blender and Three.js (Verge3D wiki)](https://www.soft8soft.com/wiki/index.php/Making_3D_web_apps_with_Blender_and_Three.js)

---

## 6. This repo's Blender pipeline (built, working)

`game/art/infantry/` holds the control bank; `npm run art:motion` rebuilds it from Python-authored
poses, `npm run art:motion:export` exports hand-tuned Graph Editor curves. Output is the generated
`src/game/infantryMotionData.ts`, sampled at runtime by `src/render/infantryMotion.ts`.

Two things worth knowing before touching it:

**Blender 4.4 broke `action.fcurves`.** Slotted actions moved curves under
layers → strips → channelbags. `author_motion.py` reads them through a compatibility helper that
handles both shapes, so the repo is not pinned to one Blender version. Verified on 5.2.1 LTS.

**Generated data needs its own tests, and they are not about the numbers.** A silent export failure
produces a bank of zeroes that typechecks, loads, and renders as a unit that simply never animates.
`infantryMotion.test.ts` therefore asserts the shape of the export (uniform length and width, all
finite), that every clip returns to rest at both ends, that it is *not* flat, that it interpolates
rather than snaps, that out-of-range phases clamp, and that it stays continuous — plus that the
families genuinely differ, so five banks are not one animation wearing five names.
