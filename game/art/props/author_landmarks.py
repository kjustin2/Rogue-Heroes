# =============================================================================
#  LANDMARKS — one or two big authored pieces per battlefield (2026-09-20).
# -----------------------------------------------------------------------------
#  A map is a place when it has something to point at. These are the monuments the
#  RAW_MAPS design lines name: the wrecked convoy in the Dust Bowl's dry river,
#  the Ironworks blast furnace, the Verdant chapel ruin and mill, the hull beached
#  on the Frozen Causeway, the fallen colossus of Karak, the Crossfire checkpoint
#  gate and radar dish. Same contract as every props-kit part (unit cube, no
#  materials, UVs + COLOR_0, validated); `buildCover` in worldRenderer.ts scales
#  each one back to the world size it was authored at, and keeps a box-built
#  fallback so the game runs with public/models/ empty.
#
#  Authoring rules that fall out of the validator: every primitive helper applies
#  its transform immediately; shells may intersect but must not share faces; no
#  radius_top of 0 (a degenerate cap is a zero-area face).
# =============================================================================
import math
import os
import sys

import bpy
from mathutils import Euler, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "infantry"))
from author_kit import add_box, join  # noqa: E402


def _rot_apply(obj, rotation, pivot=None):
    """Rotate the MESH in place about its own bounding-box centre (or `pivot`). The primitive
    helpers bake location into the vertices, so the operator route (set rotation_euler, apply)
    swings a part round the WORLD origin: the mill's paddles ended up a wheel-width underground."""
    m = Euler(rotation, "XYZ").to_matrix()
    if pivot is None:
        xs = [v.co.x for v in obj.data.vertices]
        ys = [v.co.y for v in obj.data.vertices]
        zs = [v.co.z for v in obj.data.vertices]
        pivot = Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, (min(zs) + max(zs)) / 2))
    else:
        pivot = Vector(pivot)
    for v in obj.data.vertices:
        v.co = m @ (v.co - pivot) + pivot


def shear(obj, dx, dy, z0=None, z1=None):
    """Lean a Z-standing mesh: the top moves by (dx, dy) relative to the bottom."""
    zs = [v.co.z for v in obj.data.vertices]
    lo = min(zs) if z0 is None else z0
    hi = max(zs) if z1 is None else z1
    span = max(hi - lo, 1e-5)
    for v in obj.data.vertices:
        t = max(0.0, min(1.0, (v.co.z - lo) / span))
        v.co.x += dx * t
        v.co.y += dy * t


def taper_x(obj, top_scale, z0=None):
    """Pinch the top toward the local X centre only (a gable, a pitched roof)."""
    zs = [v.co.z for v in obj.data.vertices]
    lo = min(zs) if z0 is None else z0
    hi = max(zs)
    span = max(hi - lo, 1e-5)
    xs = [v.co.x for v in obj.data.vertices]
    cx = (min(xs) + max(xs)) / 2
    for v in obj.data.vertices:
        t = max(0.0, (v.co.z - lo) / span)
        v.co.x = cx + (v.co.x - cx) * (1.0 + (top_scale - 1.0) * t)


def _cyl(name, radius, depth, location=(0, 0, 0), rotation=(0, 0, 0), vertices=12, radius_top=None):
    # Local import: author_props defines cyl() with the taper + apply contract this file needs.
    import author_props
    return author_props.cyl(name, radius, depth, location=location, rotation=rotation, vertices=vertices, radius_top=radius_top)


def _ico(name, radius=0.5, subdiv=1, location=(0, 0, 0), scale=(1, 1, 1)):
    import author_props
    return author_props.ico(name, radius=radius, subdiv=subdiv, location=location, scale=scale)


def _finish(obj, bevel=0):
    import author_props
    author_props.flat(obj, bevel=bevel)


def _ground(obj, z=0.0):
    """Bake the object's location, then flatten everything below world `z` onto it. join() keeps
    the first part's origin, so floor() on a joined object would otherwise measure from wherever
    that part happened to sit."""
    import author_props
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    obj.select_set(False)
    author_props.floor(obj, z)


# ----------------------------------------------------------------------------- Dust Bowl
def build_convoy(i):
    """A supply truck that died on the road: cab pitched forward on a burst tyre, flatbed with a
    spilled load, one wheel gone. Authored at 3.4 x 1.6 x 1.9."""
    parts = []
    bed = add_box("bed", (2.2, 1.6, 0.22), location=(-0.55, 0, 0.7))
    parts.append(bed)
    for y in (-0.76, 0.76):
        parts.append(add_box(f"rail{y}", (2.2, 0.06, 0.34), location=(-0.55, y, 0.98)))
    cab = add_box("cab", (1.15, 1.45, 1.1), location=(1.1, 0, 1.15))
    _rot_apply(cab, (0, math.radians(9), 0))  # nose down
    parts.append(cab)
    hood = add_box("hood", (0.7, 1.35, 0.5), location=(1.62, 0, 0.72))
    _rot_apply(hood, (0, math.radians(-14), math.radians(6)))  # blown open
    parts.append(hood)
    parts.append(add_box("roofrack", (1.0, 1.3, 0.06), location=(1.0, 0, 1.75)))
    # Spilled load: two crates, one slid off the tail.
    parts.append(add_box("crate0", (0.7, 0.7, 0.6), location=(-0.2, 0.25, 1.11), rotation=(0, 0, 0.3)))
    parts.append(add_box("crate1", (0.6, 0.6, 0.55), location=(-0.95, -0.35, 1.09), rotation=(0, 0, -0.5)))
    parts.append(add_box("crate2", (0.65, 0.65, 0.55), location=(-1.9, 0.5, 0.28), rotation=(0.4, 0.2, 0.7)))
    # Wheels: the rear pair, the front left, and a bare hub where the front right went.
    for (x, y, r) in ((-1.1, -0.8, 0.42), (-1.1, 0.8, 0.42), (0.95, 0.8, 0.42), (0.95, -0.8, 0.2)):
        parts.append(_cyl(f"wheel{x}{y}", r, 0.3, location=(x, y, r), rotation=(math.radians(90), 0, 0), vertices=10))
    parts.append(add_box("axle", (0.2, 1.6, 0.16), location=(-1.1, 0, 0.4)))
    parts.append(add_box("frame", (3.0, 0.9, 0.18), location=(0.1, 0, 0.5)))
    obj = join(parts, f"convoy-{i}")
    _finish(obj, bevel=0)
    return obj


def build_derrick(i):
    """An oil derrick: four legs leaning to a crown, three tiers of cross-bracing, a pump-jack
    walking beam at the foot. Authored at 2.0 x 2.0 x 4.2 (tall and thin — the plateau's mark)."""
    parts = []
    for sx in (-1, 1):
        for sy in (-1, 1):
            leg = add_box(f"leg{sx}{sy}", (0.13, 0.13, 4.0), location=(sx * 0.85, sy * 0.85, 2.0))
            shear(leg, -sx * 0.58, -sy * 0.58)
            parts.append(leg)
    for k, z in enumerate((1.0, 2.2, 3.3)):
        half = 0.85 - 0.58 * (z / 4.0)
        for sx in (-1, 1):
            parts.append(add_box(f"bx{k}{sx}", (0.08, half * 2, 0.08), location=(sx * half, 0, z)))
            parts.append(add_box(f"by{k}{sx}", (half * 2, 0.08, 0.08), location=(0, sx * half, z)))
    parts.append(add_box("crown", (0.9, 0.9, 0.22), location=(0, 0, 4.05)))
    parts.append(add_box("deck", (1.4, 1.4, 0.16), location=(0, 0, 2.2)))
    parts.append(add_box("sheave", (0.3, 0.16, 0.4), location=(0, 0, 4.3)))
    # Pump jack at the foot, walking beam nodding.
    parts.append(add_box("skid", (1.4, 0.6, 0.18), location=(1.35, 0.7, 0.09)))
    parts.append(add_box("post", (0.16, 0.5, 0.9), location=(1.35, 0.7, 0.62)))
    beam = add_box("beam", (1.5, 0.14, 0.14), location=(1.35, 0.7, 1.1))
    _rot_apply(beam, (0, math.radians(-14), 0))
    parts.append(beam)
    parts.append(_cyl("head", 0.24, 0.16, location=(0.68, 0.7, 1.28), rotation=(math.radians(90), 0, 0), vertices=10))
    obj = join(parts, f"derrick-{i}")
    _finish(obj, bevel=0)
    return obj


# ----------------------------------------------------------------------------- Ironworks
def build_furnace(i):
    """A blast furnace: the tapered stack on a plinth, hoop bands, a charging hopper on top, two
    hot-blast pipes and a slag chute. Authored at 4.6 x 4.2 x 4.4 — the tallest prop in the game."""
    parts = [add_box("plinth", (3.2, 3.0, 0.7), location=(0, 0, 0.35))]
    parts.append(_cyl("stack", 1.35, 3.0, location=(0, 0, 2.2), vertices=14, radius_top=0.95))
    for z in (1.3, 2.3, 3.2):
        r = 1.35 - (1.35 - 0.95) * ((z - 0.7) / 3.0)
        parts.append(_cyl(f"hoop{z}", r + 0.08, 0.14, location=(0, 0, z), vertices=14))
    parts.append(_cyl("throat", 0.6, 0.7, location=(0, 0, 4.0), vertices=12, radius_top=0.9))
    parts.append(_cyl("hopper", 0.95, 0.3, location=(0, 0, 4.25), vertices=12))
    # Hot-blast ring main and two downcomers.
    parts.append(_cyl("ring", 1.55, 0.22, location=(0, 0, 1.55), vertices=14))
    for a in (0.6, 2.4):
        x, y = math.cos(a) * 1.75, math.sin(a) * 1.75
        parts.append(_cyl(f"down{a}", 0.16, 1.5, location=(x, y, 0.95), vertices=8))
        parts.append(_cyl(f"foot{a}", 0.3, 0.5, location=(x, y, 0.25), vertices=8))
    # Slag chute running off the near side, and a ladle car at its foot.
    chute = add_box("chute", (1.9, 0.6, 0.14), location=(1.9, -0.9, 1.2))
    _rot_apply(chute, (0, math.radians(22), 0))
    parts.append(chute)
    for y in (-1.15, -0.65):
        parts.append(add_box(f"chuterail{y}", (1.9, 0.06, 0.24), location=(1.9, y, 1.32), rotation=(0, math.radians(22), 0)))
    parts.append(_cyl("ladle", 0.42, 0.55, location=(2.85, -0.9, 0.5), vertices=10, radius_top=0.5))
    parts.append(add_box("stair", (0.5, 0.9, 1.4), location=(-1.55, 1.0, 0.7)))
    obj = join(parts, f"furnace-{i}")
    _finish(obj, bevel=0)
    return obj


def build_railcar(i):
    """A rail car on a stub of track: variant 0 a ribbed boxcar, variant 1 an open hopper heaped
    with ore. Authored at 3.8 x 1.5 x 1.7, long axis X — laid in lines by the rail-yard grid."""
    parts = [add_box("tie0", (3.9, 0.16, 0.08), location=(0, -0.6, 0.04)), add_box("tie1", (3.9, 0.16, 0.08), location=(0, 0.6, 0.04))]
    for x in (-1.5, -0.5, 0.5, 1.5):
        parts.append(add_box(f"sleeper{x}", (0.22, 1.6, 0.06), location=(x, 0, 0.03)))
    parts.append(add_box("chassis", (3.6, 1.2, 0.2), location=(0, 0, 0.5)))
    for x in (-1.25, 1.25):
        for y in (-0.62, 0.62):
            parts.append(_cyl(f"wheel{x}{y}", 0.22, 0.12, location=(x, y, 0.22), rotation=(math.radians(90), 0, 0), vertices=10))
    if i % 2 == 0:
        parts.append(add_box("body", (3.4, 1.4, 1.1), location=(0, 0, 1.15)))
        for x in (-1.3, -0.65, 0.0, 0.65, 1.3):
            parts.append(add_box(f"rib{x}", (0.08, 1.48, 1.0), location=(x, 0, 1.15)))
        parts.append(add_box("roof", (3.5, 1.5, 0.12), location=(0, 0, 1.72)))
        parts.append(add_box("door", (0.9, 0.06, 0.8), location=(0.3, 0.74, 1.05)))
    else:
        parts.append(add_box("tub", (3.3, 1.4, 0.9), location=(0, 0, 1.05)))
        for y in (-0.72, 0.72):
            parts.append(add_box(f"lip{y}", (3.4, 0.08, 0.2), location=(0, y, 1.55)))
        heap = _ico("ore", radius=0.9, subdiv=1, location=(0.1, 0, 1.35), scale=(1.7, 0.7, 0.45))
        parts.append(heap)
    parts.append(add_box("buffer", (0.2, 0.9, 0.2), location=(1.85, 0, 0.55)))
    obj = join(parts, f"railcar-{i}")
    _finish(obj, bevel=0)
    return obj


# ----------------------------------------------------------------------------- Verdant
def build_chapel(i):
    """A roofless chapel: the gable end still stands with its window a hole in it, the side walls
    broken down to shoulder height, a buttress each side, fallen blocks inside the nave.
    Authored at 4.8 x 3.2 x 3.6, nave along X, gable at -X."""
    parts = []
    # Gable end: two piers, a lintel, the peak above — the window is the gap between the piers.
    for y in (-1.05, 1.05):
        parts.append(add_box(f"pier{y}", (0.45, 0.9, 2.1), location=(-2.1, y, 1.05)))
    parts.append(add_box("lintel", (0.45, 3.0, 0.5), location=(-2.1, 0, 2.35)))
    peak = add_box("peak", (0.45, 3.0, 1.1), location=(-2.1, 0, 3.1))
    # A gable is a triangle in Y, not X: pinch the top along the wall's width.
    lo = min(v.co.z for v in peak.data.vertices)
    for v in peak.data.vertices:
        t = (v.co.z - lo) / 1.1
        v.co.y *= 1.0 - 0.94 * t
    parts.append(peak)
    parts.append(add_box("sill", (0.55, 1.3, 0.16), location=(-2.1, 0, 0.9)))
    # Side walls, broken: three steps down toward the open east end.
    for sy in (-1, 1):
        parts.append(add_box(f"wallA{sy}", (1.5, 0.4, 1.9), location=(-1.2, sy * 1.4, 0.95)))
        parts.append(add_box(f"wallB{sy}", (1.4, 0.4, 1.3), location=(0.25, sy * 1.4, 0.65)))
        parts.append(add_box(f"wallC{sy}", (1.1, 0.4, 0.7), location=(1.5, sy * 1.4, 0.35)))
        parts.append(add_box(f"buttress{sy}", (0.5, 0.5, 1.5), location=(-1.0, sy * 1.8, 0.75)))
    parts.append(add_box("floor", (4.6, 3.0, 0.12), location=(0, 0, 0.06)))
    # Fallen roof timber and a couple of blocks in the nave.
    beam = add_box("beam", (2.6, 0.2, 0.2), location=(0.6, -0.4, 0.5))
    _rot_apply(beam, (0, math.radians(-12), math.radians(20)))
    parts.append(beam)
    parts.append(add_box("block0", (0.5, 0.5, 0.4), location=(1.6, 0.5, 0.32), rotation=(0, 0, 0.6)))
    parts.append(add_box("block1", (0.4, 0.6, 0.35), location=(-0.5, 0.7, 0.3), rotation=(0.2, 0, 1.1)))
    parts.append(add_box("altar", (0.6, 1.0, 0.8), location=(-1.5, 0, 0.5)))
    obj = join(parts, f"chapel-{i}")
    _finish(obj, bevel=0)
    return obj


def build_mill(i):
    """A water mill: stone hut with a pitched roof, a big paddle wheel on the +X side on an axle,
    a stovepipe. Authored at 3.8 x 2.6 x 2.9; the wheel side faces the pond."""
    parts = [add_box("hut", (2.0, 2.2, 1.7), location=(-0.55, 0, 0.85))]
    roof = add_box("roof", (2.3, 2.5, 1.0), location=(-0.55, 0, 2.2))
    taper_x(roof, 0.06)
    parts.append(roof)
    parts.append(add_box("door", (0.08, 0.7, 1.1), location=(-1.56, 0.3, 0.55)))
    parts.append(add_box("stone", (2.1, 2.3, 0.4), location=(-0.55, 0, 0.2)))
    parts.append(_cyl("pipe", 0.12, 0.9, location=(-1.0, -0.6, 2.6), vertices=8))
    # The wheel: a hub disc with eight paddles standing off it, on a horizontal axle.
    parts.append(_cyl("axle", 0.1, 1.4, location=(0.75, 0, 1.25), rotation=(0, math.radians(90), 0), vertices=8))
    parts.append(_cyl("hub", 0.95, 0.22, location=(1.15, 0, 1.25), rotation=(0, math.radians(90), 0), vertices=12))
    for k in range(8):
        a = k / 8 * math.tau
        p = add_box(f"paddle{k}", (0.42, 0.55, 0.14), location=(1.15, math.cos(a) * 1.15, 1.25 + math.sin(a) * 1.15))
        _rot_apply(p, (a, 0, 0))
        parts.append(p)
    parts.append(add_box("bearing", (0.22, 0.3, 0.9), location=(1.55, 0, 0.45)))
    parts.append(add_box("sluice", (1.2, 0.5, 0.2), location=(0.9, 0, 2.05)))
    obj = join(parts, f"mill-{i}")
    _finish(obj, bevel=0)
    return obj


# ----------------------------------------------------------------------------- Frozen Causeway
def build_hull(i):
    """A beached hull, listing to port: bow at +X narrows to a stem, deckhouse, leaning mast,
    funnel, the keel dug into the ice. Authored at 6.0 x 2.6 x 3.2."""
    body = add_box("hullbody", (5.6, 2.4, 1.9), location=(0, 0, 1.05))
    # Narrow the bow: y scales down toward +X; the stern stays square.
    for v in body.data.vertices:
        t = max(0.0, (v.co.x + 0.4) / 3.2)
        v.co.y *= 1.0 - 0.9 * min(1.0, t) ** 1.4
        if v.co.z > 0.5:
            v.co.x *= 1.03  # flare at the gunwale
    parts = [body]
    parts.append(add_box("deck", (5.2, 2.2, 0.12), location=(-0.3, 0, 2.02)))
    parts.append(add_box("house", (1.6, 1.5, 1.1), location=(-1.5, 0, 2.6)))
    parts.append(add_box("bridge", (0.9, 1.6, 0.5), location=(-1.5, 0, 3.35)))
    parts.append(_cyl("funnel", 0.32, 1.1, location=(-2.3, 0, 2.9), vertices=10, radius_top=0.28))
    mast = _cyl("mast", 0.09, 2.6, location=(0.6, 0, 3.2), vertices=6, radius_top=0.05)
    shear(mast, 0.5, 0.0)
    parts.append(mast)
    parts.append(add_box("yard", (0.08, 1.6, 0.08), location=(0.9, 0, 3.9)))
    for x in (-2.2, -1.0, 0.2, 1.2):
        parts.append(add_box(f"post{x}", (0.06, 0.06, 0.5), location=(x, -1.0, 2.3)))
    parts.append(add_box("rail", (3.6, 0.05, 0.06), location=(-0.5, -1.0, 2.55)))
    parts.append(add_box("keel", (4.6, 0.5, 0.5), location=(-0.3, 0, 0.2)))
    obj = join(parts, f"hull-{i}")
    _rot_apply(obj, (math.radians(-13), 0, 0))  # listing to port
    _ground(obj, 0.0)  # the low side is dug into the ice
    _finish(obj, bevel=0)
    return obj


def build_hut(i):
    """Ice-fishing shacks: variant 0 a plank shed with a stovepipe and a lean, variant 1 a round
    skin tent on poles. Authored at 1.8 x 1.8 x 1.7."""
    parts = []
    if i % 2 == 0:
        body = add_box("shed", (1.5, 1.6, 1.15), location=(0, 0, 0.58))
        shear(body, 0.06, -0.04)
        parts.append(body)
        roof = add_box("roof", (1.7, 1.8, 0.55), location=(0, 0, 1.42))
        taper_x(roof, 0.1)
        parts.append(roof)
        parts.append(add_box("door", (0.06, 0.55, 0.9), location=(0.78, 0.2, 0.45)))
        parts.append(_cyl("stovepipe", 0.08, 0.7, location=(-0.4, -0.45, 1.6), vertices=8))
        parts.append(add_box("sled", (1.1, 0.5, 0.12), location=(0.2, 1.05, 0.06)))
    else:
        parts.append(_cyl("tent", 0.85, 1.5, location=(0, 0, 0.75), vertices=9, radius_top=0.08))
        for k in range(3):
            a = k / 3 * math.tau + 0.4
            pole = _cyl(f"pole{k}", 0.04, 1.9, location=(math.cos(a) * 0.55, math.sin(a) * 0.55, 0.95), vertices=5)
            shear(pole, -math.cos(a) * 0.5, -math.sin(a) * 0.5)
            parts.append(pole)
        parts.append(add_box("flap", (0.5, 0.08, 0.7), location=(0.55, 0.45, 0.35), rotation=(0, 0, 0.5)))
        parts.append(_cyl("hole", 0.3, 0.06, location=(1.0, -0.6, 0.03), vertices=8))
    obj = join(parts, f"hut-{i}")
    _finish(obj, bevel=0)
    return obj


# ----------------------------------------------------------------------------- Karak
def build_colossus(i):
    """A colossal statue toppled on its back: the torso half sunk, one arm across the chest, the
    crowned head broken off and lying a stride from the neck, a stub of plinth at the feet.
    Authored at 5.2 x 2.4 x 2.0, lying along X (head at -X)."""
    parts = []
    torso = _ico("torso", radius=0.5, subdiv=2, location=(0.3, 0, 0.7), scale=(2.4, 1.7, 1.4))
    parts.append(torso)
    parts.append(add_box("chest", (1.6, 1.5, 0.5), location=(0.1, 0, 1.15)))
    arm = _cyl("arm", 0.28, 1.6, location=(0.2, 0.35, 1.45), rotation=(0, math.radians(90), 0), vertices=8, radius_top=0.24)
    _rot_apply(arm, (0, 0, math.radians(-25)))
    parts.append(arm)
    parts.append(add_box("hand", (0.5, 0.45, 0.3), location=(-0.6, 0.0, 1.5), rotation=(0, 0, 0.3)))
    parts.append(_cyl("neck", 0.38, 0.5, location=(-1.1, 0, 0.6), rotation=(0, math.radians(90), 0), vertices=8))
    head = _ico("head", radius=0.62, subdiv=2, location=(-2.05, -0.15, 0.62), scale=(1.15, 1.0, 1.05))
    parts.append(head)
    parts.append(add_box("crown", (0.3, 0.9, 0.9), location=(-2.55, -0.15, 0.7), rotation=(0, 0.3, 0)))
    for k in range(5):
        a = -0.9 + k * 0.45
        parts.append(add_box(f"spike{k}", (0.32, 0.16, 0.16), location=(-2.85, -0.15 + math.sin(a) * 0.5, 0.7 + math.cos(a) * 0.5), rotation=(-a, 0, 0)))
    parts.append(add_box("thigh", (1.3, 0.55, 0.55), location=(1.9, 0.4, 0.5), rotation=(0, 0, -0.12)))
    parts.append(add_box("thigh2", (1.1, 0.55, 0.5), location=(1.8, -0.45, 0.45), rotation=(0, 0, 0.15)))
    parts.append(add_box("plinth", (0.7, 2.2, 0.9), location=(2.6, 0, 0.35)))
    obj = join(parts, f"colossus-{i}")
    _ground(obj, 0.0)
    _finish(obj, bevel=0)
    return obj


def build_cistern(i):
    """A ring cistern: a round stone wall, four column stubs, a broken lintel across two of them,
    the water surface sunk a step below the rim. Authored at 3.6 x 3.6 x 1.3."""
    # The ring is HOLLOW — sixteen wall segments and their coping — so the water reads inside it.
    parts = []
    for k in range(16):
        a = k / 16 * math.tau
        seg = add_box(f"seg{k}", (0.72, 0.36, 0.95), location=(math.cos(a) * 1.62, math.sin(a) * 1.62, 0.48))
        _rot_apply(seg, (0, 0, a + math.pi / 2))
        parts.append(seg)
        cop = add_box(f"cop{k}", (0.78, 0.48, 0.14), location=(math.cos(a) * 1.62, math.sin(a) * 1.62, 1.02))
        _rot_apply(cop, (0, 0, a + math.pi / 2))
        parts.append(cop)
    parts.append(_cyl("water", 1.5, 0.06, location=(0, 0, 0.5), vertices=16))
    parts.append(_cyl("step", 2.05, 0.2, location=(0, 0, 0.1), vertices=16))
    for k in range(4):
        a = k / 4 * math.tau + 0.4
        h = (1.3, 0.9, 1.3, 0.6)[k]
        parts.append(_cyl(f"stub{k}", 0.2, h, location=(math.cos(a) * 1.55, math.sin(a) * 1.55, 0.2 + h / 2), vertices=8))
    a0, a1 = 0.4, 0.4 + math.pi / 2
    mx, my = (math.cos(a0) + math.cos(a1)) * 0.775, (math.sin(a0) + math.sin(a1)) * 0.775
    lintel = add_box("lintel", (2.3, 0.3, 0.26), location=(mx, my, 1.63))
    _rot_apply(lintel, (0, 0, (a0 + a1) / 2 + math.pi / 2))
    parts.append(lintel)
    parts.append(add_box("fallen", (0.9, 0.3, 0.26), location=(-1.5, -1.9, 0.13), rotation=(0, 0, 0.9)))
    obj = join(parts, f"cistern-{i}")
    _finish(obj, bevel=0)
    return obj


# ----------------------------------------------------------------------------- Crossfire
def build_gate(i):
    """A border checkpoint: guard booth with an overhanging roof, a raised boom barrier on a pivot
    post with its counterweight, a jersey block, a sign on a post. Authored at 4.2 x 1.8 x 2.6,
    the boom reaching along +X."""
    parts = [add_box("booth", (1.2, 1.3, 2.0), location=(-1.4, 0, 1.0))]
    parts.append(add_box("roof", (1.7, 1.8, 0.14), location=(-1.3, 0, 2.08)))
    parts.append(add_box("window", (0.06, 0.8, 0.5), location=(-0.78, 0, 1.4)))
    parts.append(add_box("post", (0.3, 0.3, 1.1), location=(-0.5, -0.2, 0.55)))
    # The boom is built reaching from the origin along +X, raised about the origin, then carried to
    # the pivot on the post — so it swings from the post, not from the map origin.
    boom = _cyl("boom", 0.07, 3.2, location=(1.6, 0, 0), rotation=(0, math.radians(90), 0), vertices=8)
    _rot_apply(boom, (0, math.radians(-22), 0), pivot=(0, 0, 0))  # raised about its butt end
    boom.location = (-0.5, -0.2, 1.05)
    bpy.ops.object.transform_apply(location=True)
    parts.append(boom)
    parts.append(add_box("weight", (0.4, 0.34, 0.34), location=(-0.85, -0.2, 0.9)))
    parts.append(add_box("jersey", (0.9, 0.5, 0.6), location=(1.5, 0.55, 0.3)))
    parts.append(_cyl("signpost", 0.05, 2.4, location=(0.4, 0.75, 1.2), vertices=6))
    parts.append(add_box("sign", (0.9, 0.08, 0.5), location=(0.4, 0.75, 2.3)))
    parts.append(add_box("kerb", (4.0, 0.2, 0.12), location=(0.2, -0.85, 0.06)))
    obj = join(parts, f"gate-{i}")
    _finish(obj, bevel=0)
    return obj


def build_radar(i):
    """A radar station: a trailer base on outriggers, a pedestal, a big tilted dish with its feed
    horn, an antenna mast beside. Authored at 3.0 x 3.0 x 3.4."""
    parts = [add_box("trailer", (2.2, 1.6, 0.7), location=(0, 0, 0.55))]
    for x in (-0.8, 0.8):
        parts.append(_cyl(f"wheel{x}", 0.3, 0.3, location=(x, 0.8, 0.3), rotation=(math.radians(90), 0, 0), vertices=10))
        parts.append(add_box(f"outrig{x}", (0.16, 2.4, 0.16), location=(x, 0, 0.16)))
    parts.append(_cyl("pedestal", 0.32, 1.0, location=(0, 0, 1.4), vertices=10))
    parts.append(add_box("yoke", (0.8, 0.5, 0.4), location=(0, 0, 1.95)))
    dish = _cyl("dish", 1.45, 0.3, location=(0, 0, 0), vertices=14, radius_top=0.5)
    _rot_apply(dish, (math.radians(-50), 0, 0))
    dish.location = (0, -0.25, 2.5)
    bpy.ops.object.transform_apply(location=True)
    parts.append(dish)
    horn = _cyl("horn", 0.06, 1.2, location=(0, 0, 0), vertices=6, radius_top=0.14)
    _rot_apply(horn, (math.radians(-50), 0, 0))
    horn.location = (0, -0.75, 2.95)
    bpy.ops.object.transform_apply(location=True)
    parts.append(horn)
    parts.append(_cyl("mast", 0.05, 2.6, location=(1.25, -0.5, 1.9), vertices=6))
    for z in (2.6, 3.0):
        parts.append(add_box(f"rung{z}", (0.6, 0.04, 0.04), location=(1.25, -0.5, z)))
    parts.append(add_box("cabinet", (0.5, 0.5, 0.9), location=(-0.9, -0.55, 1.35)))
    obj = join(parts, f"radar-{i}")
    _finish(obj, bevel=0)
    return obj


LANDMARK_BUILDERS = {
    "convoy": build_convoy, "derrick": build_derrick, "furnace": build_furnace, "railcar": build_railcar,
    "chapel": build_chapel, "mill": build_mill, "hull": build_hull, "hut": build_hut,
    "colossus": build_colossus, "cistern": build_cistern, "gate": build_gate, "radar": build_radar,
}
LANDMARK_VARIANTS = {"convoy": 1, "derrick": 1, "furnace": 1, "railcar": 2, "chapel": 1, "mill": 1, "hull": 1, "hut": 2,
                     "colossus": 1, "cistern": 1, "gate": 1, "radar": 1}
