"""
Infantry motion authoring — Blender control bank -> generated TypeScript.

This is NOT a character exporter. It builds an editable ANIMATION CONTROL BANK: a small rig of
numbered Empties whose X-Euler curves each store one game-local scalar. The shipped soldier stays
procedural in src/render/worldRenderer.ts; this only supplies the numbers that pose it.

Why a control bank rather than a skinned GLB:

  * The game already owns the phase. An attack's timing comes from its ORDER's elapsed/duration, so
    a clip with its own clock could only ever drift out of step with the shot it belongs to. The
    governing rule is combat owns durations, animation owns pose -- no second animation timer, no
    root motion, no animation-owned collision.
  * A scalar bank is diffable, tiny, and needs no runtime loader, no skinning, and no asset at all
    at run time. The game still runs with art/ deleted.
  * An animator can open the .blend and drag curves in the Graph Editor without touching code, and
    a programmer can regenerate the .blend from the authored values here. Either side can be the
    source of truth.

Channels (one Empty each, X Euler rotation in radians, or metres where noted):

    00 shoulder pitch      lead arm swing, forward positive
    01 shoulder yaw        lead arm across the body
    02 elbow bend          lead arm fold
    03 offhand pitch       support arm
    04 torso pitch         lean into or away from the action
    05 torso twist         shoulders rotating off the hips
    06 weapon draw         metres, weapon pulled toward the body (negative thrusts forward)
    07 weapon pitch        muzzle lift, positive raises
    08 body lift           metres, whole-body rise and settle
    09 knee bend           both knees, for bracing and recoil absorption

Usage (from the repo root):

    & 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background \
        --python game/art/infantry/author_motion.py

    ... rebuilds infantry-motion.blend from the poses authored below AND exports the bank.

    & 'C:/Program Files/Blender Foundation/Blender 5.2/blender.exe' --background \
        --python game/art/infantry/author_motion.py -- --export-existing

    ... exports whatever is currently in infantry-motion.blend, so hand-tuned Graph Editor edits
    are what ship. Use this after editing curves by hand.

Output: game/src/game/infantryMotionData.ts (generated; do not hand-edit).
"""

import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
BLEND = os.path.join(HERE, "infantry-motion.blend")
OUT_TS = os.path.normpath(os.path.join(HERE, "..", "..", "src", "game", "infantryMotionData.ts"))

CHANNELS = [
    "shoulderPitch", "shoulderYaw", "elbowBend", "offhandPitch",
    "torsoPitch", "torsoTwist", "weaponDraw", "weaponPitch", "bodyLift", "kneeBend",
]

# 101 samples so frame 1 is phase 0 and frame 101 is phase 1 -- the runtime interpolates between
# whole samples, so this is a flat lookup with no easing baked into the sampler.
SAMPLES = 101

# ---------------------------------------------------------------------------------------------
# Authored poses. Each clip is a list of (phase, {channel: value}) keys; everything between is
# interpolated by Blender's own F-curves, which is the point -- an animator edits THOSE.
#
# Contact phases are shared with combat and must not drift: the renderer reads the same numbers.
# ---------------------------------------------------------------------------------------------
CONTACT = {"rifle": 0.42, "burst": 0.34, "marksman": 0.62, "launcher": 0.44, "melee": 0.50, "flamer": 0.30, "shotgun": 0.36, "pistol": 0.40}

CLIPS = {
    # Line rifle: settle, a short push into the shot, absorb, return.
    "rifle": [
        (0.00, {}),
        (0.22, {"shoulderPitch": -0.10, "elbowBend": 0.16, "weaponDraw": 0.03, "weaponPitch": 0.05, "torsoPitch": 0.04}),
        (0.42, {"shoulderPitch": -0.16, "elbowBend": 0.22, "weaponDraw": 0.05, "weaponPitch": 0.10, "torsoPitch": 0.06, "kneeBend": 0.05}),
        (0.52, {"shoulderPitch": 0.06, "elbowBend": 0.05, "weaponDraw": -0.04, "weaponPitch": -0.12, "torsoPitch": -0.05, "bodyLift": -0.02}),
        (0.74, {"shoulderPitch": -0.02, "weaponDraw": 0.01, "weaponPitch": 0.02}),
        (1.00, {}),
    ],
    # Heavy gunner: braces wide and low, absorbs a sustained burst rather than a single shot.
    "burst": [
        (0.00, {}),
        (0.18, {"torsoPitch": 0.10, "kneeBend": 0.14, "shoulderPitch": -0.12, "weaponDraw": 0.04, "bodyLift": -0.03}),
        (0.34, {"torsoPitch": 0.13, "kneeBend": 0.18, "shoulderPitch": -0.15, "weaponDraw": 0.07, "weaponPitch": 0.06, "bodyLift": -0.04}),
        (0.46, {"torsoPitch": 0.06, "kneeBend": 0.15, "weaponDraw": -0.03, "weaponPitch": -0.05}),
        (0.58, {"torsoPitch": 0.11, "kneeBend": 0.17, "weaponDraw": 0.05, "weaponPitch": 0.04}),
        (0.72, {"torsoPitch": 0.05, "kneeBend": 0.09, "weaponDraw": -0.02}),
        (1.00, {}),
    ],
    # Marksman: a long, almost motionless settle, then one hard crack and a slow recovery.
    "marksman": [
        (0.00, {}),
        (0.30, {"torsoPitch": 0.03, "shoulderPitch": -0.04, "weaponDraw": 0.01, "kneeBend": 0.03}),
        (0.62, {"torsoPitch": 0.04, "shoulderPitch": -0.05, "weaponDraw": 0.02, "weaponPitch": 0.03, "kneeBend": 0.04}),
        (0.68, {"torsoPitch": -0.04, "weaponDraw": -0.05, "weaponPitch": -0.14, "bodyLift": -0.015}),
        (0.86, {"weaponDraw": 0.01, "weaponPitch": 0.02}),
        (1.00, {}),
    ],
    # Grenadier / mortar: hoists the tube, thumps, and rocks back.
    "launcher": [
        (0.00, {}),
        (0.26, {"shoulderPitch": -0.26, "elbowBend": 0.3, "weaponPitch": 0.26, "torsoPitch": -0.06, "bodyLift": 0.02}),
        (0.44, {"shoulderPitch": -0.34, "elbowBend": 0.36, "weaponPitch": 0.4, "torsoPitch": -0.09, "bodyLift": 0.03}),
        (0.56, {"shoulderPitch": -0.1, "elbowBend": 0.12, "weaponPitch": 0.1, "torsoPitch": 0.08, "kneeBend": 0.12, "bodyLift": -0.03}),
        (0.78, {"weaponPitch": 0.03, "kneeBend": 0.04}),
        (1.00, {}),
    ],
    # Flamer: braces low and SWEEPS the projector across the arc while the stream runs.
    "flamer": [
        (0.00, {}),
        (0.18, {"torsoPitch": 0.08, "kneeBend": 0.12, "torsoTwist": -0.22, "shoulderYaw": -0.18, "weaponDraw": 0.03, "bodyLift": -0.02}),
        (0.30, {"torsoPitch": 0.10, "kneeBend": 0.14, "torsoTwist": -0.14, "shoulderYaw": -0.12, "weaponDraw": 0.04, "bodyLift": -0.03}),
        (0.55, {"torsoPitch": 0.10, "kneeBend": 0.14, "torsoTwist": 0.18, "shoulderYaw": 0.16, "weaponDraw": 0.04, "bodyLift": -0.03}),
        (0.72, {"torsoPitch": 0.06, "kneeBend": 0.08, "torsoTwist": 0.08, "shoulderYaw": 0.06}),
        (1.00, {}),
    ],
    # Scattergun: a hard kick straight back into the shoulder, then the pump -- the off hand
    # racks the fore-end (a second draw pulse) before the gun settles.
    "shotgun": [
        (0.00, {}),
        (0.24, {"shoulderPitch": -0.08, "elbowBend": 0.14, "weaponDraw": 0.03, "torsoPitch": 0.05, "kneeBend": 0.06}),
        (0.36, {"shoulderPitch": -0.12, "elbowBend": 0.18, "weaponDraw": 0.05, "weaponPitch": 0.06, "torsoPitch": 0.07, "kneeBend": 0.08}),
        (0.42, {"shoulderPitch": 0.14, "elbowBend": 0.02, "weaponDraw": -0.12, "weaponPitch": -0.24, "torsoPitch": -0.10, "bodyLift": -0.03, "kneeBend": 0.12}),
        (0.56, {"weaponDraw": -0.02, "weaponPitch": -0.04, "offhandPitch": 0.32, "torsoPitch": 0.0}),
        (0.66, {"weaponDraw": 0.06, "offhandPitch": -0.18, "weaponPitch": 0.03}),
        (0.78, {"weaponDraw": 0.0, "offhandPitch": 0.0}),
        (1.00, {}),
    ],
    # Sidearm: one-handed. The arm comes up level, a short snap, and it drops back.
    "pistol": [
        (0.00, {}),
        (0.26, {"shoulderPitch": -0.42, "elbowBend": 0.08, "torsoTwist": -0.08, "weaponPitch": 0.04}),
        (0.40, {"shoulderPitch": -0.48, "elbowBend": 0.06, "torsoTwist": -0.10, "weaponPitch": 0.06}),
        (0.46, {"shoulderPitch": -0.36, "elbowBend": 0.16, "weaponDraw": -0.05, "weaponPitch": -0.18, "torsoPitch": -0.03}),
        (0.62, {"shoulderPitch": -0.44, "elbowBend": 0.08, "weaponPitch": 0.02}),
        (0.84, {"shoulderPitch": -0.12}),
        (1.00, {}),
    ],
    # Striker: winds all the way back and commits through the target.
    "melee": [
        (0.00, {}),
        (0.30, {"shoulderPitch": -0.6, "shoulderYaw": -0.34, "elbowBend": 0.5, "torsoTwist": -0.3, "torsoPitch": -0.1, "kneeBend": 0.12}),
        (0.50, {"shoulderPitch": 0.7, "shoulderYaw": 0.4, "elbowBend": -0.1, "torsoTwist": 0.34, "torsoPitch": 0.22, "bodyLift": -0.04, "kneeBend": 0.18}),
        (0.66, {"shoulderPitch": 0.42, "shoulderYaw": 0.24, "torsoTwist": 0.18, "torsoPitch": 0.12, "kneeBend": 0.1}),
        (1.00, {}),
    ],
}


def action_fcurves(obj):
    """
    Every F-curve on an object's action, across Blender versions.

    Blender 4.4 replaced the flat `action.fcurves` list with SLOTTED actions, where curves live
    under layers -> strips -> channelbags. Both shapes are handled so this script keeps working on
    either side of that change rather than pinning the repo to one Blender version.
    """
    anim = getattr(obj, "animation_data", None)
    action = getattr(anim, "action", None)
    if action is None:
        return []
    legacy = getattr(action, "fcurves", None)
    if legacy is not None:
        return list(legacy)
    curves = []
    for layer in getattr(action, "layers", []):
        for strip in getattr(layer, "strips", []):
            for bag in getattr(strip, "channelbags", []):
                curves.extend(bag.fcurves)
    return curves


def build_bank():
    """Rebuild the .blend from the authored poses above."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = SAMPLES

    for clip_name, keys in CLIPS.items():
        collection = bpy.data.collections.new(clip_name)
        scene.collection.children.link(collection)
        for index, channel in enumerate(CHANNELS):
            empty = bpy.data.objects.new(f"{clip_name}_{index:02d}_{channel}", None)
            empty.empty_display_size = 0.1
            empty.location = (index * 0.25, 0.0, 0.0)
            collection.objects.link(empty)
            for phase, values in keys:
                empty.rotation_euler[0] = values.get(channel, 0.0)
                empty.keyframe_insert("rotation_euler", index=0, frame=1 + round(phase * (SAMPLES - 1)))
            # Smooth interpolation between authored keys is exactly what makes this editable: the
            # curve, not the key list, is the artefact an animator works on.
            for fcurve in action_fcurves(empty):
                for kp in fcurve.keyframe_points:
                    kp.interpolation = "BEZIER"
                    kp.handle_left_type = "AUTO_CLAMPED"
                    kp.handle_right_type = "AUTO_CLAMPED"

    bpy.ops.wm.save_as_mainfile(filepath=BLEND)
    print(f"[author_motion] wrote {BLEND}")


def sample_bank():
    """Evaluate every clip's curves at SAMPLES points and return {clip: [[ch...] * SAMPLES]}."""
    scene = bpy.context.scene
    depsgraph = bpy.context.evaluated_depsgraph_get()
    out = {}
    for clip_name in CLIPS:
        collection = bpy.data.collections.get(clip_name)
        if collection is None:
            raise SystemExit(f"[author_motion] clip collection '{clip_name}' missing from {BLEND}")
        objects = []
        for index, channel in enumerate(CHANNELS):
            name = f"{clip_name}_{index:02d}_{channel}"
            obj = collection.objects.get(name)
            if obj is None:
                raise SystemExit(f"[author_motion] channel object '{name}' missing")
            objects.append(obj)
        frames = []
        for frame in range(1, SAMPLES + 1):
            scene.frame_set(frame)
            depsgraph.update()
            frames.append([round(obj.evaluated_get(depsgraph).rotation_euler[0], 5) for obj in objects])
        out[clip_name] = frames
    return out


def write_ts(banks):
    lines = [
        "// GENERATED by game/art/infantry/author_motion.py — do not hand-edit.",
        "//",
        "// Scalar animation control banks exported from game/art/infantry/infantry-motion.blend.",
        "// Each clip is 101 samples; frame 0 is phase 0 and frame 100 is phase 1. The RUNTIME owns",
        "// the phase (it comes from the order's own elapsed/duration), so these curves can never",
        "// drift out of step with the action they belong to.",
        "//",
        "// Re-export after editing the .blend:",
        "//   blender --background --python game/art/infantry/author_motion.py -- --export-existing",
        "",
        f"export const MOTION_CHANNELS = {list(CHANNELS)!r} as const;".replace("'", '"'),
        "",
        "export interface MotionClip {",
        "  /** Phase at which the shot/strike actually connects. Shared with combat.  */",
        "  contact: number;",
        "  /** 101 frames of MOTION_CHANNELS.length scalars. */",
        "  frames: number[][];",
        "}",
        "",
        "export const INFANTRY_MOTION: Record<string, MotionClip> = {",
    ]
    for clip_name, frames in banks.items():
        lines.append(f"  {clip_name}: {{")
        lines.append(f"    contact: {CONTACT[clip_name]},")
        lines.append("    frames: [")
        for frame in frames:
            lines.append("      [" + ",".join(f"{v:g}" for v in frame) + "],")
        lines.append("    ],")
        lines.append("  },")
    lines.append("};")
    lines.append("")
    with open(OUT_TS, "w", encoding="utf-8", newline="\n") as handle:
        handle.write("\n".join(lines))
    print(f"[author_motion] wrote {OUT_TS} ({len(banks)} clips)")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if "--export-existing" in argv:
        if not os.path.exists(BLEND):
            raise SystemExit(f"[author_motion] {BLEND} does not exist — run without --export-existing first")
        bpy.ops.wm.open_mainfile(filepath=BLEND)
        print(f"[author_motion] exporting hand-authored curves from {BLEND}")
    else:
        build_bank()
    write_ts(sample_bank())


main()
