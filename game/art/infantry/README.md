# Infantry motion authoring

`infantry-motion.blend` is an editable **animation control bank**, not a character or a model. The
shipped soldier is procedural (`src/render/worldRenderer.ts`); this file only supplies the numbers
that pose it.

Each numbered Empty's **X Euler curve stores one game-local scalar**:

| # | Channel | Meaning |
|---|---|---|
| 00 | `shoulderPitch` | lead arm swing, forward positive |
| 01 | `shoulderYaw` | lead arm across the body |
| 02 | `elbowBend` | lead arm fold |
| 03 | `offhandPitch` | support arm |
| 04 | `torsoPitch` | lean into or away from the action |
| 05 | `torsoTwist` | shoulders rotating off the hips |
| 06 | `weaponDraw` | **metres**; positive pulls the weapon toward the body |
| 07 | `weaponPitch` | muzzle lift, positive raises |
| 08 | `bodyLift` | **metres**; whole-body rise and settle |
| 09 | `kneeBend` | both knees, for bracing and recoil absorption |

These are **game coordinates, not Blender world axes**. Frame 1 is phase 0; frame 101 is phase 1.

There is one collection per weapon family: `rifle`, `burst`, `marksman`, `launcher`, `melee`.

## Editing

Open the `.blend`, drag curves in the Graph Editor, save, then export your edits:

```bash
blender --background --python game/art/infantry/author_motion.py -- --export-existing
```

Run from the repository root. Without `--export-existing` the script **rebuilds the `.blend`** from
the poses authored in Python at the top of `author_motion.py`, replacing whatever is in the file —
so either the code or the artist can be the source of truth, but be deliberate about which.

Either way the output is `src/game/infantryMotionData.ts`, which is generated and must not be
hand-edited.

## The rule

**Combat owns durations; animation owns pose.**

The runtime never advances a clock of its own. The phase handed to `sampleMotion()` comes from the
order's own `elapsed / duration`, so an attack animation cannot drift out of step with the shot it
belongs to, and the action-pace setting slows the animation with it for free.

Do not add a second animation timer, root motion, or animation-owned collision.

The `contact` phase in each clip is **shared with combat** — the renderer and the sim read the same
number. Changing it changes when the shot lands, not just when the arm moves.

## Fallback

If `infantryMotionData.ts` is absent or a family has no bank, `hasMotionBank()` returns false and
the renderer falls back to its procedural `attackPose()` curve. The game runs with `art/` deleted,
the same rule the GLB models follow.

## Blender version note

`author_motion.py` reads F-curves through a small compatibility helper. Blender 4.4 replaced the
flat `action.fcurves` list with slotted actions (layers → strips → channelbags); both shapes are
handled so the repo is not pinned to one Blender version. Authored and verified on **Blender
5.2.1 LTS**.
