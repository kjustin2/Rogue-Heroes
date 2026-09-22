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
