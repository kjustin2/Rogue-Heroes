# =============================================================================
#  INFANTRY KIT — authored part meshes, exported as one GLB.
# -----------------------------------------------------------------------------
#  WHY PARTS AND NOT A CHARACTER. The shipped soldier has to stay a rig of separate
#  meshes: per-part damage targets each one individually, the walk cycle and the
#  attack choreography swing them from tagged pivots, and the pooled-material
#  system repaints them per frame. A single skinned character model would take all
#  three away. So Blender authors the SHAPES and the game keeps the rig — every
#  part that has an authored mesh here uses it; every part that does not keeps its
#  procedural rounded box, so the game still runs with this file deleted.
#
#  Each object is exported at a canonical 1x1x1 bounding box centred on the origin,
#  because the game scales it to whatever size the kit code asks for. Author shape
#  here; author proportion in worldRenderer.ts.
#
#  Run:  npm run art:kit        (from game/)
#  Out:  game/public/models/infantry-kit.glb
# =============================================================================
import bpy
import bmesh
import math
import os
import sys
from mathutils import Vector

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "public", "models", "infantry-kit.glb")


def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def normalise(obj):
    """Fit the mesh into a 1x1x1 box centred on the origin, so the game can scale it freely."""
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bb = [Vector(c) for c in obj.bound_box]
    lo = Vector((min(v.x for v in bb), min(v.y for v in bb), min(v.z for v in bb)))
    hi = Vector((max(v.x for v in bb), max(v.y for v in bb), max(v.z for v in bb)))
    size = hi - lo
    centre = (hi + lo) * 0.5
    mesh = obj.data
    for v in mesh.vertices:
        v.co -= centre
        v.co.x /= max(size.x, 1e-5)
        v.co.y /= max(size.y, 1e-5)
        v.co.z /= max(size.z, 1e-5)
    obj.select_set(False)


def sculpt(obj, levels=2):
    """Subdivision-surface smoothing over a kitbashed part. Every primitive shell rounds into an
    organic hard-surface form the way sculpted armour does; this is the single biggest step from
    "block pile" to "figure". Applied BEFORE the bevel so the bevel only touches true creases."""
    bpy.context.view_layer.objects.active = obj
    mod = obj.modifiers.new("Subsurf", "SUBSURF")
    mod.levels = levels
    mod.render_levels = levels
    bpy.ops.object.modifier_apply(modifier=mod.name)
    return obj


AO_ATTR = "AO"
# Set by main() once the render engine has been configured; a part built outside main() (a probe,
# a unit test of one builder) still gets the analytic shading term, just not the Cycles crevice term.
_ao_ready = False
# The pooled part material multiplies COLOR_0 into the albedo, so the bake has to carry the SAME
# analytic terms the runtime `bakeVertexAO` (worldRenderer.ts) gives every procedural part —
# under-surfaces dark, tops lit, a base-to-top lift — or an authored helmet reads brighter and
# flatter than the procedural boot below it. Cycles adds what the heuristic cannot see: the
# darkening under a brim, between pack pouches, inside a muzzle shroud.
AO_MIX = 0.72        # how much of the Cycles term survives (1 = pure AO in the crevices)
AO_FLOOR = 0.42      # nothing goes blacker than this; a crevice is dark, not a hole
AO_SAMPLES = 24      # per-vertex AO converges fast on these convex kitbash shells
AO_DISTANCE = 0.55   # parts are built at ~1 unit; only nearby geometry should occlude


def setup_ao_bake():
    """Point the scene at Cycles with a cheap AO bake configuration. Called once from main()."""
    global _ao_ready
    scene = bpy.context.scene
    try:
        scene.render.engine = "CYCLES"
    except Exception as e:
        print("[author_kit] Cycles unavailable, vertex AO will be analytic only:", e)
        return
    scene.cycles.device = "CPU"
    scene.cycles.samples = AO_SAMPLES
    scene.cycles.use_denoising = False
    scene.cycles.bake_type = "AO"
    scene.render.bake.target = "VERTEX_COLORS"
    scene.render.bake.use_selected_to_active = False
    if scene.world is None:
        scene.world = bpy.data.worlds.new("bake-world")
    scene.world.light_settings.distance = AO_DISTANCE
    _ao_ready = True


def bake_ao(obj):
    """Cycles ambient occlusion → the active colour attribute (exported as COLOR_0), folded into
    the runtime's analytic facing/height shading. Runs on the un-normalised mesh so the AO
    distance means the same thing on every part."""
    mesh = obj.data
    attr = mesh.color_attributes.get(AO_ATTR) or mesh.color_attributes.new(name=AO_ATTR, type="FLOAT_COLOR", domain="POINT")
    mesh.color_attributes.active_color = attr
    mesh.color_attributes.render_color_index = mesh.color_attributes.find(AO_ATTR)
    n = len(mesh.vertices)
    ao = [1.0] * n
    if _ao_ready:
        # Every part is built at the origin, so the parts already finished would occlude this one.
        # Bake each part alone in the world.
        others = [o for o in bpy.data.objects if o is not obj and o.type == "MESH"]
        hidden = [(o, o.hide_render) for o in others]
        for o in others:
            o.hide_render = True
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        try:
            bpy.ops.object.bake(type="AO", target="VERTEX_COLORS")
            for i in range(n):
                ao[i] = attr.data[i].color[0]
        except Exception as e:
            print("[author_kit] AO bake failed for", obj.name, "- analytic shading only:", e)
            ao = [1.0] * n
        finally:
            for o, was in hidden:
                o.hide_render = was
    zs = [v.co.z for v in mesh.vertices]
    lo, hi = min(zs), max(zs)
    span = max(hi - lo, 1e-4)
    # Vertex normals in Blender local space (Z up here; the exporter swaps to Y up).
    for i, v in enumerate(mesh.vertices):
        up = max(-1.0, min(1.0, v.normal.z))
        facing = 0.88 + up * 0.16 if up >= 0 else 0.88 + up * 0.3
        t = (v.co.z - lo) / span
        analytic = min(1.0, facing * (0.86 + t * 0.16))
        crevice = 1.0 - (1.0 - min(1.0, max(0.0, ao[i]))) * AO_MIX
        shade = max(AO_FLOOR, min(1.0, analytic * crevice))
        attr.data[i].color = (shade, shade, shade, 1.0)


def finish(obj, bevel=0.012, segments=2, shade_smooth=True, angle=40.0):
    """Bevel the hard edges and smooth-shade with an autosmooth angle — the two things that
    separate an authored part from a primitive at any distance. Also lays out UVs (smart project)
    so the game's shared detail normal map has somewhere to land, and bakes vertex AO (COLOR_0)."""
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    try:
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.select_all(action="SELECT")
        bpy.ops.uv.smart_project(angle_limit=math.radians(66), island_margin=0.02)
        bpy.ops.object.mode_set(mode="OBJECT")
    except Exception as e:
        print("[author_kit] uv project failed for", obj.name, e)
    obj.select_set(False)
    bpy.context.view_layer.objects.active = obj
    if bevel > 0:
        mod = obj.modifiers.new("Bevel", "BEVEL")
        mod.width = bevel
        mod.segments = segments
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(30)
        mod.harden_normals = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
    if not shade_smooth:
        obj.select_set(True)
        bpy.ops.object.shade_flat()  # faceted props: one toon band per facet is the stylized read
        obj.select_set(False)
    if shade_smooth:
        bpy.ops.object.shade_smooth()
        # Blender 4.1+ replaced mesh.use_auto_smooth with the Smooth by Angle operator.
        try:
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle))
        except Exception:
            pass
    bake_ao(obj)
    normalise(obj)


def add_box(name, size, location=(0, 0, 0), rotation=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location, rotation=rotation)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = size
    bpy.ops.object.transform_apply(scale=True)
    return obj


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name
    return obj


def taper(obj, top_scale, axis="z"):
    """Pinch the top of a mesh toward its centre — a taper is what makes a helmet read as a helmet
    and a torso read as a chest rather than a crate."""
    mesh = obj.data
    zs = [v.co.z for v in mesh.vertices]
    lo, hi = min(zs), max(zs)
    span = max(hi - lo, 1e-5)
    for v in mesh.vertices:
        t = (v.co.z - lo) / span
        f = 1.0 + (top_scale - 1.0) * t
        v.co.x *= f
        v.co.y *= f
    _ = axis


# --- HELMET: a domed shell with a brim and a rear flare. -----------------------
def build_helmet():
    bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=10, radius=0.5)
    dome = bpy.context.active_object
    dome.name = "helmet"
    # Cut the lower hemisphere: a helmet is a shell, not a ball.
    bm = bmesh.new()
    bm.from_mesh(dome.data)
    bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:],
                           plane_co=(0, 0, -0.06), plane_no=(0, 0, 1), clear_inner=True)
    bm.to_mesh(dome.data)
    bm.free()
    dome.scale = (1.0, 1.12, 0.86)
    bpy.ops.object.transform_apply(scale=True)
    brim = add_box("brim", (0.86, 0.30, 0.10), location=(0, 0.44, -0.04))
    brim.rotation_euler = (math.radians(-9), 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    flare = add_box("flare", (0.80, 0.22, 0.16), location=(0, -0.42, -0.08))
    flare.rotation_euler = (math.radians(13), 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    obj = join([dome, brim, flare], "helmet")
    finish(obj, bevel=0.01, angle=52)
    return obj


# --- TORSO: a chest that is wider at the shoulders than at the waist. ----------
def build_torso():
    body = add_box("torso", (0.92, 0.62, 1.0))
    taper(body, 1.18)
    chest = add_box("chest", (0.86, 0.22, 0.44), location=(0, 0.30, 0.20))
    chest.rotation_euler = (math.radians(-8), 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    collar = add_box("collar", (0.52, 0.46, 0.14), location=(0, 0, 0.50))
    obj = join([body, chest, collar], "torso")
    finish(obj, bevel=0.02, angle=38)
    return obj


# --- BOOT: a sole, an upper, and a raised toe. A planted foot needs a toe. -----
def build_boot():
    sole = add_box("sole", (0.86, 1.0, 0.22), location=(0, 0, -0.36))
    upper = add_box("upper", (0.74, 0.72, 0.6), location=(0, -0.10, 0.06))
    taper(upper, 0.86)
    toe = add_box("toe", (0.7, 0.3, 0.24), location=(0, 0.40, -0.20))
    toe.rotation_euler = (math.radians(-16), 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    obj = join([sole, upper, toe], "boot")
    finish(obj, bevel=0.018, angle=40)
    return obj


# --- RIFLE: receiver, barrel, magazine, stock, optic. -------------------------
def build_rifle():
    receiver = add_box("receiver", (0.22, 0.52, 0.26))
    bpy.ops.mesh.primitive_cylinder_add(vertices=14, radius=0.055, depth=0.62,
                                        location=(0, 0.52, 0.04), rotation=(math.radians(90), 0, 0))
    barrel = bpy.context.active_object
    muzzle = add_box("muzzle", (0.14, 0.12, 0.14), location=(0, 0.84, 0.04))
    mag = add_box("mag", (0.14, 0.20, 0.30), location=(0, 0.06, -0.24))
    mag.rotation_euler = (math.radians(10), 0, 0)
    bpy.ops.object.transform_apply(rotation=True)
    stock = add_box("stock", (0.18, 0.44, 0.22), location=(0, -0.44, -0.04))
    taper(stock, 0.9)
    optic = add_box("optic", (0.10, 0.24, 0.10), location=(0, 0.10, 0.20))
    obj = join([receiver, barrel, muzzle, mag, stock, optic], "rifle")
    finish(obj, bevel=0.008, angle=46)
    return obj


# --- PACK: a rucksack with a rolled top and side pouches. ---------------------
def build_pack():
    body = add_box("packbody", (0.9, 0.5, 0.94))
    taper(body, 0.9)
    roll = add_box("roll", (0.94, 0.44, 0.22), location=(0, 0, 0.52))
    for side in (-1, 1):
        pouch = add_box(f"pouch{side}", (0.22, 0.34, 0.36), location=(side * 0.48, 0, -0.12))
        body = join([body, pouch], "packbody")
    obj = join([body, roll], "pack")
    finish(obj, bevel=0.016, angle=40)
    return obj


def main():
    clear_scene()
    setup_ao_bake()
    for build in (build_helmet, build_boot, build_rifle, build_pack):
        build()
    # Per-kind identity parts (helmets, weapons, packs) live in author_kinds.py.
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import author_kinds
    author_kinds.build_all()
    # QA gate: a regenerated kit must not ship a bad part silently (see validate.py).
    import validate
    try:
        validate.validate_scene(validate.kit_part_names("KitPart"), label="infantry kit")
    except validate.ValidationError as e:
        print("[author_kit] ABORTED, not exporting:", e)
        sys.exit(1)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(OUT),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="NONE",   # the game paints these parts every frame
        export_vertex_color="ACTIVE",  # baked AO rides COLOR_0 (see bake_ao)
        export_active_vertex_color_when_no_material=True,
        export_normals=True,
        export_texcoords=True,
        export_yup=True,
    )
    print(f"[author_kit] wrote {os.path.abspath(OUT)}")


if __name__ == "__main__":
    main()
    if "--background" in sys.argv:
        pass
