# =============================================================================
#  PROPS KIT — seeded low-poly cover props, N variants per kind, one GLB.
# -----------------------------------------------------------------------------
#  Rocks, stumps, logs, bushes, tree canopies + trunks, cacti, statue rubble: the
#  scatter props every map is dressed with. They used to be three canted boxes
#  or a stack of spheres (and the rock was a 30-credit photoreal Meshy hull that
#  had to be greyscaled and re-tinted to sit next to the toon troopers). Here
#  each kind is a bmesh recipe — primitive, seeded noise displacement along the
#  normal, a flat floor so it never floats, flat shading, a light decimate — so
#  the facets read as "stylized rock" under the four-step toon ramp, and every
#  variant is a different silhouette. Same contract as the infantry kit:
#
#    - every object exports normalised to a 1x1x1 box centred on the origin; the
#      game scales it (proportion lives in worldRenderer.ts, shape lives here)
#    - no materials (parts go through the pooled part-material path and take the
#      map tint and the toon ramp like everything else)
#    - UVs + baked vertex AO (COLOR_0), validated by ../infantry/validate.py
#    - a missing GLB is silent: every branch in buildCover keeps its procedural
#      builder as the fallback, so the game runs with public/models/ empty
#
#  Variants are picked by hash(entity.id) at build time, so no map shows two
#  identical rocks side by side and a save restores the same rock it had.
#
#  Run:  npm run art:props     (from game/)
#  Out:  game/public/models/props-kit.glb
# =============================================================================
import math
import os
import random
import sys

import bmesh
import bpy
from mathutils import Vector, noise

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "infantry"))
import author_kit  # noqa: E402
import validate  # noqa: E402
from author_kit import add_box, finish, join  # noqa: E402

OUT = os.path.join(HERE, "..", "..", "public", "models", "props-kit.glb")
VARIANTS = {"rock": 4, "stump": 3, "log": 3, "bush": 4, "canopy": 3, "trunk": 3, "cactus": 3, "statue": 3, "rubble": 3}
# Landmarks (author_landmarks.py) are kitbashed from a dozen-plus primitives each and skip the bevel
# (a 2-segment bevel is ~8x the tris of a box, and at tactical distance a flat-shaded landmark reads
# the same). Budget lifted for the furnace (hoops + ring main + chute on a 14-sided stack).

TRI_BUDGET = 1600


# ----------------------------------------------------------------------------- helpers
def _rng(kind, i):
    return random.Random(f"{kind}-{i}")


def ico(name, radius=0.5, subdiv=2, location=(0, 0, 0), scale=(1, 1, 1)):
    bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=subdiv, radius=radius, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def cyl(name, radius, depth, location=(0, 0, 0), rotation=(0, 0, 0), vertices=10, radius_top=None):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    if radius_top is not None:
        author_kit.taper(obj, radius_top / max(radius, 1e-6))
    # Bake location + rotation into the mesh NOW (add_box already does): join() keeps the first
    # object's origin, and floor()/displace() measure mesh-local Z — a cylinder whose origin sat
    # at its own centre collapsed its whole lower half onto the "floor".
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return obj


def displace(obj, rng, amount=0.2, scale=2.0, along="normal"):
    """Seeded noise displacement along the vertex normal (or straight radial from the origin).
    The offset makes every variant a different field of the same noise."""
    off = Vector((rng.uniform(-50, 50), rng.uniform(-50, 50), rng.uniform(-50, 50)))
    mesh = obj.data
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bm.normal_update()
    for v in bm.verts:
        n = noise.noise(v.co * scale + off)  # -1..1
        d = v.normal if along == "normal" else (v.co.normalized() if v.co.length > 1e-6 else v.normal)
        v.co += d * n * amount
    bm.to_mesh(mesh)
    bm.free()


def floor(obj, z, keep_below=0.0):
    """Flatten everything under `z` onto the plane: a prop stands on the ground, never floats on a
    rounded belly, and the buried side is not paid for."""
    for v in obj.data.vertices:
        if v.co.z < z:
            v.co.z = z - keep_below * (z - v.co.z)


def decimate(obj, ratio):
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new("Decimate", "DECIMATE")
    mod.ratio = ratio
    bpy.ops.object.modifier_apply(modifier=mod.name)


def scale_xyz(obj, sx, sy, sz):
    for v in obj.data.vertices:
        v.co.x *= sx
        v.co.y *= sy
        v.co.z *= sz


def spin(obj, degrees):
    obj.rotation_euler = (0, 0, math.radians(degrees))
    bpy.ops.object.transform_apply(rotation=True)


def flat(obj, bevel=0.0):
    """Faceted finish: no smoothing, optional micro-bevel, then the shared UV/AO/normalise pass."""
    finish(obj, bevel=bevel, shade_smooth=False)


# ----------------------------------------------------------------------------- kinds
def build_rock(i):
    rng = _rng("rock", i)
    obj = ico(f"rock-{i}", subdiv=3, scale=(rng.uniform(0.9, 1.4), rng.uniform(0.8, 1.2), rng.uniform(0.6, 0.95)))
    displace(obj, rng, amount=rng.uniform(0.12, 0.2), scale=rng.uniform(1.6, 2.6), along="radial")
    displace(obj, rng, amount=0.05, scale=6.0)
    floor(obj, -0.28)
    decimate(obj, 0.35)
    spin(obj, rng.uniform(0, 360))
    flat(obj)
    return obj


def build_rubble(i):
    """A collapsed pile: a big fractured block, a few smaller chunks and a broken drum, half sunk."""
    rng = _rng("rubble", i)
    parts = []
    big = ico("chunk", radius=0.5, subdiv=1, scale=(1.3, 1.0, 0.7))
    displace(big, rng, amount=0.14, scale=2.2, along="radial")
    floor(big, -0.2)
    parts.append(big)
    for k in range(rng.randint(2, 4)):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(0.35, 0.7)
        c = add_box(f"c{k}", (rng.uniform(0.2, 0.42), rng.uniform(0.2, 0.42), rng.uniform(0.16, 0.34)),
                    location=(math.cos(a) * r, math.sin(a) * r, rng.uniform(-0.1, 0.16)))
        c.rotation_euler = (rng.uniform(-0.5, 0.5), rng.uniform(-0.5, 0.5), rng.uniform(0, math.pi))
        bpy.ops.object.transform_apply(rotation=True)
        parts.append(c)
    drum = cyl("drum", 0.16, rng.uniform(0.5, 0.8), location=(rng.uniform(-0.3, 0.3), rng.uniform(-0.3, 0.3), 0.08),
               rotation=(math.radians(90), 0, rng.uniform(0, math.pi)), vertices=8)
    parts.append(drum)
    obj = join(parts, f"rubble-{i}")
    floor(obj, -0.3)
    flat(obj, bevel=0.01)
    return obj


def build_statue(i):
    """Broken monument: stepped plinth, a column drum snapped off at a slant, toppled capital and a
    fallen head-block at the foot — the three variants break at different heights."""
    rng = _rng("statue", i)
    base = add_box("plinth", (1.2, 1.2, 0.36), location=(0, 0, 0.18))
    step = add_box("step", (0.9, 0.9, 0.16), location=(0, 0, 0.44))
    h = [1.5, 0.9, 1.2][i % 3]
    drum = cyl("drum", 0.3, h, location=(0, 0, 0.52 + h / 2), vertices=10, radius_top=0.24)
    # Snap the top at a slant: shear the top ring.
    for v in drum.data.vertices:
        if v.co.z > 0.52 + h - 0.05:
            v.co.z += v.co.x * rng.uniform(0.25, 0.5)
    displace(drum, rng, amount=0.03, scale=5.0)
    parts = [base, step, drum]
    cap = ico("cap", radius=0.28, subdiv=1, scale=(1.2, 1.0, 0.7), location=(rng.uniform(0.6, 0.8), rng.uniform(-0.5, 0.5), 0.2))
    displace(cap, rng, amount=0.08, scale=3.0, along="radial")
    parts.append(cap)
    if i % 3 != 1:
        head = add_box("head", (0.3, 0.26, 0.3), location=(rng.uniform(-0.8, -0.6), rng.uniform(-0.4, 0.4), 0.15))
        head.rotation_euler = (0.4, 0.3, rng.uniform(0, math.pi))
        bpy.ops.object.transform_apply(rotation=True)
        parts.append(head)
    obj = join(parts, f"statue-{i}")
    flat(obj, bevel=0.012)
    return obj


def build_stump(i):
    rng = _rng("stump", i)
    trunk = cyl("trunk", 0.42, 0.62, location=(0, 0, 0.31), vertices=11, radius_top=0.36)
    displace(trunk, rng, amount=0.04, scale=4.0)
    # Bark ridges: pull alternate side verts out a touch.
    for k, v in enumerate(trunk.data.vertices):
        if abs(v.co.z - 0.31) < 0.32 and k % 2 == 0:
            v.co.x *= 1.08
            v.co.y *= 1.08
    parts = [trunk]
    for k in range(rng.randint(2, 4)):
        a = rng.uniform(0, math.tau)
        root = add_box(f"root{k}", (0.2, rng.uniform(0.45, 0.65), 0.18), location=(math.cos(a) * 0.5, math.sin(a) * 0.5, 0.06))
        root.rotation_euler = (0, rng.uniform(-0.15, 0.1), a + math.pi / 2)
        bpy.ops.object.transform_apply(rotation=True)
        parts.append(root)
    obj = join(parts, f"stump-{i}")
    floor(obj, 0.0)
    flat(obj, bevel=0.012)
    return obj


def build_log(i):
    rng = _rng("log", i)
    L = rng.uniform(2.2, 2.7)
    body = cyl("body", 0.3, L, rotation=(0, math.radians(90), 0), vertices=9, radius_top=0.34)
    displace(body, rng, amount=0.035, scale=3.0)
    # A gentle bow along its length so it does not read as a pipe.
    bow = rng.uniform(-0.12, 0.12)
    for v in body.data.vertices:
        v.co.y += bow * (v.co.x / (L / 2)) ** 2
    parts = [body]
    bough = cyl("bough", 0.09, rng.uniform(0.4, 0.6), location=(rng.uniform(-0.6, 0.6), 0.1, 0.35),
                rotation=(math.radians(rng.uniform(-30, 30)), math.radians(rng.uniform(-40, 40)), 0), vertices=6, radius_top=0.05)
    parts.append(bough)
    if i % 2 == 0:
        knot = ico("knot", radius=0.16, subdiv=1, location=(rng.uniform(-0.8, 0.8), -0.2, 0.2))
        parts.append(knot)
    obj = join(parts, f"log-{i}")
    floor(obj, -0.24)
    flat(obj, bevel=0.01)
    return obj


def build_bush(i):
    rng = _rng("bush", i)
    parts = []
    for k in range(rng.randint(3, 5)):
        a = rng.uniform(0, math.tau)
        r = rng.uniform(0.0, 0.3)
        s = ico(f"lobe{k}", radius=rng.uniform(0.32, 0.46), subdiv=1, location=(math.cos(a) * r, math.sin(a) * r, rng.uniform(0.2, 0.42)),
                scale=(1, 1, rng.uniform(0.7, 0.9)))
        displace(s, rng, amount=0.06, scale=4.0, along="radial")
        parts.append(s)
    obj = join(parts, f"bush-{i}")
    floor(obj, 0.02)
    flat(obj)
    return obj


def build_canopy(i):
    rng = _rng("canopy", i)
    parts = []
    lobes = [(0, 0, 0.0, 0.62), (0.3, 0.2, 0.25, 0.46), (-0.34, -0.1, 0.32, 0.42), (0.05, -0.32, 0.5, 0.4), (-0.1, 0.3, 0.6, 0.34)]
    for k, (x, y, z, r) in enumerate(lobes[: 3 + (i % 3)]):
        s = ico(f"lobe{k}", radius=r * rng.uniform(0.9, 1.15), subdiv=1, location=(x * rng.uniform(0.8, 1.2), y * rng.uniform(0.8, 1.2), z),
                scale=(1, 1, rng.uniform(0.7, 0.85)))
        displace(s, rng, amount=0.08, scale=3.5, along="radial")
        parts.append(s)
    obj = join(parts, f"canopy-{i}")
    floor(obj, -0.45)
    flat(obj)
    return obj


def build_trunk(i):
    rng = _rng("trunk", i)
    lean = rng.uniform(-0.08, 0.08)
    trunk = cyl("trunk", 0.26, 1.7, location=(0, 0, 0.85), vertices=8, radius_top=0.12)
    for v in trunk.data.vertices:
        v.co.x += lean * v.co.z
    displace(trunk, rng, amount=0.025, scale=3.0)
    parts = [trunk]
    for k in range(2 + (i % 2)):
        a = rng.uniform(0, math.tau)
        z = rng.uniform(0.9, 1.5)
        b = cyl(f"branch{k}", 0.07, rng.uniform(0.4, 0.7), location=(math.cos(a) * 0.3, math.sin(a) * 0.3, z),
                rotation=(math.radians(-55) * math.sin(a), math.radians(55) * math.cos(a), 0), vertices=6, radius_top=0.03)
        parts.append(b)
    # Root flare so the trunk does not stand on a point.
    for k in range(3):
        a = k / 3 * math.tau + rng.uniform(0, 1)
        root = add_box(f"root{k}", (0.16, 0.36, 0.14), location=(math.cos(a) * 0.3, math.sin(a) * 0.3, 0.06))
        root.rotation_euler = (0, 0, a + math.pi / 2)
        bpy.ops.object.transform_apply(rotation=True)
        parts.append(root)
    obj = join(parts, f"trunk-{i}")
    floor(obj, 0.0)
    flat(obj)
    return obj


def build_cactus(i):
    rng = _rng("cactus", i)
    col = cyl("column", 0.24, 1.9, location=(0, 0, 0.95), vertices=10, radius_top=0.18)
    # Ribs: every other vertex column pulled in.
    for k, v in enumerate(col.data.vertices):
        if k % 2 == 1:
            v.co.x *= 0.86
            v.co.y *= 0.86
    parts = [col]
    for side in ([-1, 1], [1], [-1, 1])[i % 3]:
        z = rng.uniform(0.8, 1.2)
        arm = cyl(f"arm{side}", 0.13, 0.5, location=(side * 0.4, 0, z), rotation=(0, math.radians(90), 0), vertices=8)
        up = cyl(f"up{side}", 0.13, rng.uniform(0.6, 0.9), location=(side * 0.58, 0, z + 0.4), vertices=8, radius_top=0.1)
        parts += [arm, up]
    obj = join(parts, f"cactus-{i}")
    floor(obj, 0.0)
    flat(obj)
    return obj


BUILDERS = {"rock": build_rock, "stump": build_stump, "log": build_log, "bush": build_bush, "canopy": build_canopy,
            "trunk": build_trunk, "cactus": build_cactus, "statue": build_statue, "rubble": build_rubble}

# The per-map landmarks live in their own module (imported after the helpers above exist, since
# it calls back into cyl/ico/flat/floor).
import author_landmarks  # noqa: E402

BUILDERS.update(author_landmarks.LANDMARK_BUILDERS)
VARIANTS.update(author_landmarks.LANDMARK_VARIANTS)


def main():
    author_kit.clear_scene()
    author_kit.setup_ao_bake()
    for kind, n in VARIANTS.items():
        for i in range(n):
            BUILDERS[kind](i)
    expected = validate.kit_part_names("PropsPart")
    try:
        validate.validate_scene(expected, tri_budget=TRI_BUDGET, label="props kit")
    except validate.ValidationError as e:
        print("[author_props] ABORTED, not exporting:", e)
        sys.exit(1)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="NONE",
        export_vertex_color="ACTIVE",
        export_active_vertex_color_when_no_material=True,
        export_normals=True,
        export_texcoords=True,
        export_yup=True,
    )
    print(f"[author_props] wrote {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
